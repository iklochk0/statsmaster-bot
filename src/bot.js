// src/bot.js
// Discord bot that renders PNG stat cards with:
//  - Kills scaled display
//  - Progress bars (Kills / Dead / DKP) vs goals
//  - LEFT: how much left to do
//  - LAST ZONE: what you did in the latest finished zone
//  - DKP % with tag (WARM UP / OVERDRIVE ...)
// DB side is based on your db.pg.js:
//   - zone_scans(zone_name, start_scan_data{run_id}, end_scan_data{run_id})
//   - listZones(), getZone(zone_name)
//   - latest, stats, kvk_goals, kvk_config, kvk_periods...

import "dotenv/config";
import { Client, GatewayIntentBits, AttachmentBuilder, PermissionsBitField } from "discord.js";
import { Pool } from "pg";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  initSchema,
  kvkStart,
  kvkSetWeight,
  kvkEnsureGoal,
  kvkTop,
  kvkActiveId,
  listZones,
  getZone,
} from "./db.pg.js";

/* ───────────────────────── env / constants ───────────────────────── */
const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

const IMG_CACHE_TTL_S = Number(process.env.IMG_CACHE_TTL_S || 60);
const IMG_CACHE_MAX   = Number(process.env.IMG_CACHE_MAX || 120);

const HEAVY_CMD_COOLDOWN_S = Number(process.env.HEAVY_CMD_COOLDOWN_S || 4);

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/* ───────────────────────── tiny logger ───────────────────────── */
function nowIso(){ return new Date().toISOString(); }
function baseCtx(msg){
  return {
    t: nowIso(),
    g: msg.guild?.id ?? "-",
    c: msg.channel?.id ?? "-",
    u: msg.author?.id ?? "-",
    un: msg.author?.tag ?? "-",
  };
}
function logAt(level, obj){
  if (LEVELS[level] < (LEVELS[LOG_LEVEL] ?? 20)) return;
  try { console.log(JSON.stringify({ level, ...obj })); } catch {}
}
const log = {
  debug: (o)=>logAt("debug", o),
  info : (o)=>logAt("info" , o),
  warn : (o)=>logAt("warn" , o),
  error: (o)=>logAt("error", o),
};

/* ───────────────────────── utils ───────────────────────── */
const nf   = (x) => new Intl.NumberFormat("en-US").format(Number(x || 0));
const pct1 = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 10) / 10 : 0);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const GREEN = "#6ee7a8";
const RED   = "#ef5350";
const NEUTR = "#a9b4c6";
const colorDelta = (n) => (n > 0 ? GREEN : n < 0 ? RED : NEUTR);
const fmtDelta   = (n) => (n > 0 ? `+${nf(n)}` : n < 0 ? `-${nf(Math.abs(n))}` : `±0`);

function isAdmin(msg) {
  const m = msg.member;
  if (!m) return false;
  if (ADMIN_ROLE_IDS.length) {
    return m.roles?.cache?.some(r => ADMIN_ROLE_IDS.includes(r.id)) || false;
  }
  return m.permissions?.has(PermissionsBitField.Flags.Administrator) || false;
}

const lastHeavyUse = new Map(); // userId -> timestamp(ms)
function checkCooldown(userId){
  const now = Date.now();
  const prev = lastHeavyUse.get(userId) || 0;
  const restMs = HEAVY_CMD_COOLDOWN_S * 1000 - (now - prev);
  if (restMs > 0) return Math.ceil(restMs/1000);
  lastHeavyUse.set(userId, now);
  return 0;
}

// обрізати ім'я
function trimName(s = "", max = 22) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// kills (для хедера зверху): kills / 10, округлено до 100k
function scaleKillsDisplay(rawKills) {
  const base = Number(rawKills || 0) / 10;
  const rounded = Math.round(base / 100000) * 100000;
  return rounded;
}

// тег зверху справа по % DKP
function autoTag(pct) {
  const v = Number(pct) || 0;
  if (v >= 170) return "WHALE KILLER";
  if (v >= 140) return "OVERDRIVE";
  if (v >= 110) return "OVERCAP";
  if (v >= 90)  return "ON TRACK";
  return "WARM UP";
}

/* ───────────────────────── DB ───────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await initSchema();

// зв'язка дискорд <-> player_id
await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );
`);

async function fetchLatestById(id) {
  const { rows } = await pool.query(
    `SELECT l.player_id, l.name, l.power, l.kills, l.dead, l.t1, l.t2, l.t3, l.t4, l.t5, l.updated_at
       FROM latest l
      WHERE l.player_id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function fetchLink(discordId) {
  const { rows } = await pool.query(
    `SELECT player_id FROM discord_links WHERE discord_id=$1`,
    [discordId]
  );
  return rows[0]?.player_id || null;
}

async function setLink(discordId, playerId) {
  await pool.query(
    `INSERT INTO discord_links(discord_id, player_id)
     VALUES ($1,$2)
     ON CONFLICT (discord_id) DO UPDATE SET player_id=excluded.player_id`,
    [discordId, playerId]
  );
}

async function removeLink(discordId) {
  await pool.query(
    `DELETE FROM discord_links WHERE discord_id=$1`,
    [discordId]
  );
}

// топи за останнім зрізом
async function fetchTop(by = "kills", limit = 10) {
  const col = by === "power" ? "power" : "kills";
  const { rows } = await pool.query(
    `SELECT player_id, name, ${col} AS metric
       FROM latest
      WHERE ${col} IS NOT NULL
      ORDER BY ${col} DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// статику гравців на конкретному run_id
async function fetchStatsByRun(runId) {
  const { rows } = await pool.query(
    `SELECT s.player_id, p.name,
            s.power, s.kills, s.dead, s.t1, s.t2, s.t3, s.t4, s.t5
       FROM stats s
       JOIN players p ON p.id = s.player_id
      WHERE s.run_id = $1`,
    [runId]
  );
  const m = new Map();
  for (const r of rows) m.set(String(r.player_id), r);
  return m;
}

/* ─────────────────────── ZONE CALCS ─────────────────────── */

/**
 * computeZoneSumForPlayer:
 *   сума всіх ЗАКІНЧЕНИХ зон.
 *   для кожної зони беремо start_scan_data.run_id і end_scan_data.run_id
 *   і рахуємо дельту гравця по kills/dead/power/tiers.
 */
async function computeZoneSumForPlayer(playerId) {
  const zones = await listZones();
  // тільки ті, що мають end_scan_time
  const finishedZones = zones.filter(z => z.end_scan_time);

  let dPower = 0, dKills = 0, dDead = 0, dT1=0,dT2=0,dT3=0,dT4=0,dT5=0;

  for (const z of finishedZones) {
    const full = await getZone(z.zone_name);

    const startRunId = Number(full?.start_scan_data?.run_id ?? full?.start_scan_data?.["run_id"]);
    const endRunId   = Number(full?.end_scan_data?.run_id   ?? full?.end_scan_data?.["run_id"]);
    if (!Number.isFinite(startRunId) || !Number.isFinite(endRunId)) continue;

    const startMap = await fetchStatsByRun(startRunId);
    const endMap   = await fetchStatsByRun(endRunId);

    const s = startMap.get(String(playerId));
    const e = endMap.get(String(playerId));
    if (!s || !e) continue;

    dPower += Math.max(0, Number(e.power||0) - Number(s.power||0));
    dKills += Math.max(0, Number(e.kills||0) - Number(s.kills||0));
    dDead  += Math.max(0, Number(e.dead ||0) - Number(s.dead ||0));
    dT1    += Math.max(0, Number(e.t1   ||0) - Number(s.t1   ||0));
    dT2    += Math.max(0, Number(e.t2   ||0) - Number(s.t2   ||0));
    dT3    += Math.max(0, Number(e.t3   ||0) - Number(s.t3   ||0));
    dT4    += Math.max(0, Number(e.t4   ||0) - Number(s.t4   ||0));
    dT5    += Math.max(0, Number(e.t5   ||0) - Number(s.t5   ||0));
  }

  return { dPower, dKills, dDead, dT1, dT2, dT3, dT4, dT5 };
}

/**
 * computeLastZoneDeltaForPlayer:
 *   беремо останню завершену зону (найпізніший end_scan_time)
 *   і повертаємо тільки її дельту kills/dead + її ім'я.
 */
async function computeLastZoneDeltaForPlayer(playerId) {
  const zones = await listZones();
  const done = zones
    .filter(z => z.end_scan_time)
    .sort((a,b)=> new Date(b.end_scan_time).getTime() - new Date(a.end_scan_time).getTime());

  if (!done.length) {
    return {
      zoneName: "–",
      dKillsZone: 0,
      dDeadZone : 0,
    };
  }

  const last = done[0];
  const full = await getZone(last.zone_name);

  const startRunId = Number(full?.start_scan_data?.run_id ?? full?.start_scan_data?.["run_id"]);
  const endRunId   = Number(full?.end_scan_data?.run_id   ?? full?.end_scan_data?.["run_id"]);
  if (!Number.isFinite(startRunId) || !Number.isFinite(endRunId)) {
    return {
      zoneName: String(last.zone_name ?? "–"),
      dKillsZone: 0,
      dDeadZone : 0,
    };
  }

  const startMap = await fetchStatsByRun(startRunId);
  const endMap   = await fetchStatsByRun(endRunId);

  const s = startMap.get(String(playerId));
  const e = endMap.get(String(playerId));
  if (!s || !e) {
    return {
      zoneName: String(last.zone_name ?? "–"),
      dKillsZone: 0,
      dDeadZone : 0,
    };
  }

  const dKillsZone = Math.max(0, Number(e.kills||0) - Number(s.kills||0));
  const dDeadZone  = Math.max(0, Number(e.dead ||0) - Number(s.dead ||0));

  return {
    zoneName: String(last.zone_name ?? "Zone"),
    dKillsZone,
    dDeadZone,
  };
}

/**
 * buildZoneBasedKvkBundle(playerIdBigInt, latestRowFromLatest):
 *   - тягне активний KvK
 *   - бере goals (kills/dead/dkp)
 *   - рахує суму по ВСІХ завершених зонах (zoneSum)
 *   - рахує останню зону (lastZone)
 *   - рахує DKP і відсоток
 */
async function buildZoneBasedKvkBundle(playerIdBigInt, latest) {
  const active = await kvkActiveId();
  let goal = null;
  let cfg = { kills_weight: 1.0, dead_to_kills: 5.0 };

  if (active) {
    const { rows: gRows } = await pool.query(
      `SELECT goal_kills, goal_dead, goal_dkp
         FROM kvk_goals
        WHERE kvk_id=$1 AND player_id=$2`,
      [active, playerIdBigInt]
    );
    goal = gRows[0] || null;

    const { rows: cRows } = await pool.query(
      `SELECT kills_weight, dead_to_kills
         FROM kvk_config
        WHERE kvk_id=$1`,
      [active]
    );
    if (cRows[0]) cfg = cRows[0];
  }

  // сума по всіх закінчених зонах
  const zoneSum  = await computeZoneSumForPlayer(playerIdBigInt);
  // тільки остання зона
  const lastZone = await computeLastZoneDeltaForPlayer(playerIdBigInt);

  const dKills = Number(zoneSum.dKills||0);
  const dDead  = Number(zoneSum.dDead ||0);

  // DKP = kills_weight*kills + dead_to_kills*dead
  const dkp = Math.round(
    (Number(cfg.kills_weight||0)  * dKills) +
    (Number(cfg.dead_to_kills||0) * dDead )
  );

  const goalKills = Number(goal?.goal_kills || 0);
  const goalDead  = Number(goal?.goal_dead  || 0);
  const goalDKP   = Number(goal?.goal_dkp   || 0);

  const killsLeft = Math.max(0, goalKills - dKills);
  const deadLeft  = Math.max(0, goalDead  - dDead );
  const dkpLeft   = Math.max(0, goalDKP   - dkp   );

  const pctRaw = goalDKP > 0 ? (100 * dkp / goalDKP) : 0;

  const r = {
    d_kills    : dKills,
    d_dead     : dDead,
    dkp        : dkp,
    goal_kills : goalKills,
    goal_dead  : goalDead,
    goal_dkp   : goalDKP,
    pct        : pctRaw,
    killsLeft,
    deadLeft,
    dkpLeft,
    lastZone,
  };

  const deltas = {
    dPower: Number(zoneSum.dPower||0),
    dKills: dKills,
    dDead : dDead,
    dT5   : Number(zoneSum.dT5||0),
    dT4   : Number(zoneSum.dT4||0),
  };

  return { r, deltas };
}

/* ─────────────────────── CARD RENDERER ─────────────────────── */

function stripeCardSVG(bundle, latest) {
  const r = bundle.r;
  const deltas = bundle.deltas;

  const W = 1100, H = 640;
  const panel = "#0f1218", card = "#121722", grid = "#1e2633", text = "#e6edf7", sub = "#a9b4c6";
  const track = "#2b3342", color1 = "#00c853", color2 = "#7c4dff";

  // DKP%
  const pctDKP_raw = Number(r?.pct) || 0;
  const pctDKP     = clamp(pctDKP_raw, 0, 220);

  // бари
  const pctKills = clamp(
    ((Number(r?.d_kills)||0) / (Number(r?.goal_kills)||0) * 100) || 0,
    0, 220
  );
  const pctDead  = clamp(
    ((Number(r?.d_dead)||0) / (Number(r?.goal_dead)||0) * 100) || 0,
    0, 220
  );

  // залишки
  const killsLeft = Number(r?.killsLeft || 0);
  const deadLeft  = Number(r?.deadLeft  || 0);
  const dkpLeft   = Number(r?.dkpLeft   || 0);

  // остання зона
  const zoneName      = r?.lastZone?.zoneName ?? "–";
  const lastKillsZone = Number(r?.lastZone?.dKillsZone || 0);
  const lastDeadZone  = Number(r?.lastZone?.dDeadZone  || 0);

  // верхній заголовок
  const title   = latest?.name ? `${latest.name} (${latest.player_id})` : String(latest?.player_id ?? "");
  const updated = latest?.updated_at ? new Date(latest.updated_at) : new Date();

  // kills в хедері: scaled (kills/10 округлено до 100к)
  const scaledKillsNow = scaleKillsDisplay(latest?.kills);

  const x0 = 50;
  const innerWidth = W - 100;
  const hBar = 28;
  const rxy = 14;
  const yBase = 230;
  const GAP = 90;
  const BAR_LABEL_OFF = -12;
  const BAR_PCT_OFF   = Math.floor(hBar/2) + 7;

  // нижні картки
  const bottomBoxW = 490;
  const bottomBoxH = 60;
  const bottomBoxR = 10;
  const bottomGapX = 40;
  const bottomY    = yBase + GAP*2 + 90;

  function segLengths(pct) {
    return {
      base: (innerWidth * Math.min(pct, 100)) / 100,
      over: (innerWidth * Math.min(Math.max(0, pct - 100), 100)) / 100
    };
  }

  function barRow({ label, pct, cur, goal, y }) {
    const L = segLengths(pct);
    return `
      <text x="${x0}" y="${y + BAR_LABEL_OFF}" class="s">${label}</text>
      <rect x="${x0}" y="${y}" width="${innerWidth}" height="${hBar}" rx="${rxy}" fill="${track}"/>
      ${pct <= 100 ? `
        <rect x="${x0}" y="${y}" width="${L.base}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
      ` : `
        <rect x="${x0}" y="${y}" width="${innerWidth}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
        <rect x="${x0}" y="${y}" width="${L.over}"  height="${hBar}" rx="${rxy}" fill="${color2}"/>
      `}
      <text x="${x0 + innerWidth/2}" y="${y + BAR_PCT_OFF}" text-anchor="middle" class="m">${pct1(pct)}%</text>
      <text x="${x0}" y="${y + 50}" class="m">${nf(cur)} / ${nf(goal)}</text>
    `;
  }

  const { dPower=0, dKills=0, dDead=0, dT5=0, dT4=0 } = deltas || {};
  const cPow   = colorDelta(dPower);
  const cKills = colorDelta(dKills);
  const cDead  = colorDelta(dDead);
  const cT5    = colorDelta(dT5);
  const cT4    = colorDelta(dT4);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      .t  { font: 700 22px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .s  { font: 500 14px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${sub}; }
      .b  { font: 800 40px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .tg { font: 800 16px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; letter-spacing: 2px; }
      .m  { font: 600 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: ${text}; }
      .mm { font: 600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: ${sub}; }
      .lbl{ font: 500 13px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${sub}; letter-spacing:0.03em; }
    </style>
  </defs>

  <rect width="${W}" height="${H}" fill="${panel}"/>
  <g>
    <rect x="20" y="20" width="${W-40}" height="${H-40}" rx="22" fill="${card}" stroke="${grid}" stroke-width="1"/>

    <!-- header left -->
    <text x="${x0}" y="64" class="t">${title}</text>
    <text x="${x0}" y="88" class="s">Updated: ${updated.toLocaleString()}</text>

    <!-- header metrics row -->
    <g transform="translate(${x0},120)">
      <text class="s">Power</text>
      <text y="24" class="t">${nf(latest?.power)}</text>
      <text y="46" class="m" style="fill:${cPow}">${fmtDelta(dPower)}</text>
    </g>

    <g transform="translate(${x0+210},120)">
      <text class="s">Kills (scaled)</text>
      <text y="24" class="t">${nf(scaledKillsNow)}</text>
      <text y="46" class="m" style="fill:${cKills}">${fmtDelta(dKills)}</text>
    </g>

    <g transform="translate(${x0+420},120)">
      <text class="s">Dead</text>
      <text y="24" class="t">${nf(latest?.dead)}</text>
      <text y="46" class="m" style="fill:${cDead}">${fmtDelta(dDead)}</text>
    </g>

    <g transform="translate(${x0+630},120)">
      <text class="s">T5</text>
      <text y="24" class="t">${nf(latest?.t5)}</text>
      <text y="46" class="m" style="fill:${cT5}">${fmtDelta(dT5)}</text>
    </g>

    <g transform="translate(${x0+820},120)">
      <text class="s">T4</text>
      <text y="24" class="t">${nf(latest?.t4)}</text>
      <text y="46" class="m" style="fill:${cT4}">${fmtDelta(dT4)}</text>
    </g>

    <!-- DKP% top-right -->
    <text x="${W-50}" y="62" text-anchor="end" class="b">${pct1(pctDKP_raw)}%</text>
    <text x="${W-50}" y="88" text-anchor="end" class="tg">${autoTag(pctDKP_raw)}</text>

    <!-- Progress bars -->
    ${barRow({
      label: "Kills",
      pct: pctKills,
      cur: r?.d_kills    || 0,
      goal: r?.goal_kills|| 0,
      y: yBase
    })}

    ${barRow({
      label: "Dead",
      pct: pctDead,
      cur: r?.d_dead     || 0,
      goal: r?.goal_dead || 0,
      y: yBase + GAP
    })}

    ${barRow({
      label: "DKP",
      pct: pctDKP,
      cur: r?.dkp        || 0,
      goal: r?.goal_dkp  || 0,
      y: yBase + GAP*2
    })}

    <!-- bottom two cards: LEFT / LAST FIGHTS -->
    <g transform="translate(${x0}, ${bottomY})">
      <text x="0" y="0" class="lbl">LEFT</text>
      <rect x="0" y="16" width="${bottomBoxW}" height="${bottomBoxH}" rx="${bottomBoxR}" fill="${track}"/>
      <text x="16" y="52" class="m">Kills ${nf(killsLeft)} • Dead ${nf(deadLeft)}</text>
    </g>

    <g transform="translate(${x0+bottomBoxW+${bottomGapX}}, ${bottomY})">
      <text x="0" y="0" class="lbl">YOUR LAST FIGHTS AT "${zoneName}" ZONE</text>
      <rect x="0" y="16" width="${bottomBoxW}" height="${bottomBoxH}" rx="${bottomBoxR}" fill="${track}"/>
      <text x="16" y="52" class="m">Kills ${nf(lastKillsZone)} • Dead ${nf(lastDeadZone)}</text>
    </g>

    <!-- DKP left -->
    <g transform="translate(${x0}, ${bottomY + bottomBoxH + 60})">
      <text class="mm">DKP left: ${nf(dkpLeft)}</text>
    </g>
  </g>
</svg>`;
}

async function renderStripeCard(bundle, latest) {
  const svg = stripeCardSVG(bundle, latest);
  return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/* ─────────────────────── PNG leaderboard (KvK top) ─────────────────────── */
function hashTopRows(rows){
  const s = rows.map(r => `${r.player_id}:${r.dkp}:${r.goal_dkp}:${r.pct}`).join("|");
  return createHash("md5").update(s).digest("hex").slice(0,12);
}

function kvkTopSVG(rows, meta = {}) {
  const W = 1100, H = 120 + rows.length * 56 + 40;
  const panel = "#0f1218", card = "#121722", grid = "#1e2633", text = "#e6edf7", sub = "#a9b4c6";
  const track = "#2b3342", color1 = "#7c4dff";

  const marginX = 40;
  const listLeft = marginX + 12;
  const barLeft  = 250;
  const barWidth = W - barLeft - 85;
  const padRight = 46;
  const hBar = 20;
  const rxy  = 7;
  const rowGap = 56;
  const yStart = 120;

  const title = meta.title ?? `KvK Top ${rows.length}`;
  const sublineR = `Updated: ${meta.updated ?? "-"}`;

  let lines = "";
  rows.forEach((r, i) => {
    const y = yStart + i * rowGap;
    const pct = Math.max(0, Number(r.pct) || 0);
    const pctClamped = Math.min(100, pct);
    const barLen = (barWidth - padRight) * (pctClamped / 100);
    const name = trimName(r.name ?? r.player_id, 26);
    const rank = `${i + 1}.`;
    const dkpText = `${nf(r.dkp || 0)} / ${nf(r.goal_dkp || 0)}`;

    lines += `
      <g>
        <text x="${listLeft - 8}" y="${y + 15}" class="s">${rank}</text>
        <text x="${listLeft + 30}" y="${y + 15}" class="t">${name}</text>

        <rect x="${barLeft}" y="${y}" width="${barWidth}" height="${hBar}" rx="${rxy}" fill="${track}"/>
        <rect x="${barLeft}" y="${y}" width="${barLen}" height="${hBar}" rx="${rxy}" fill="${color1}"/>

        <text x="${barLeft}" y="${y + 35}" class="m">${dkpText}</text>
        <text x="${barLeft + barWidth - padRight/2}" y="${y + 35}" text-anchor="end" class="m">${pct1(pct)}%</text>
      </g>`;
  });

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      .t  { font: 700 20px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .s  { font: 600 16px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${sub}; }
      .b  { font: 800 40px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .m  { font: 600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: ${sub}; }
    </style>
  </defs>

  <rect width="${W}" height="${H}" fill="#0f1218"/>
  <g>
    <rect x="20" y="20" width="${W-40}" height="${H-40}" rx="22" fill="${card}" stroke="${grid}" stroke-width="1"/>

    <text x="${marginX}" y="70" class="b">${title}</text>
    <text x="${W - marginX}" y="98" class="s" text-anchor="end">${sublineR}</text>

    ${lines}
  </g>
</svg>`;
}

async function renderKvkTopPNG(rows, meta) {
  const svg = kvkTopSVG(rows, meta);
  return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/* ─────────────────────── simple PNG cache ─────────────────────── */
const imgCache = new Map(); // key -> { buf, t }
function cacheKeyPlayer(pid, r, latest){
  return `p:${pid}:${r?.dkp}|${r?.goal_dkp}|${r?.d_kills}|${r?.d_dead}|${latest?.updated_at ?? ""}`;
}
function cacheKeyTop(limit, activeId, rows){
  const h = hashTopRows(rows);
  return `top:${limit}:${activeId ?? "none"}:${h}`;
}
function getCached(key){
  const v = imgCache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > IMG_CACHE_TTL_S*1000) { imgCache.delete(key); return null; }
  return v.buf;
}
function setCached(key, buf){
  if (imgCache.size >= IMG_CACHE_MAX) {
    const firstKey = imgCache.keys().next().value;
    if (firstKey) imgCache.delete(firstKey);
  }
  imgCache.set(key, { buf, t: Date.now() });
}

/* ─────────────────────── Discord client ─────────────────────── */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/* ─────────────────────── helpers ─────────────────────── */
async function getLinkedPlayerIdOrReply(msg) {
  const linked = await fetchLink(msg.author.id);
  if (!linked) {
    await msg.reply("Link yourself first: `!link @you <player_id>`");
    return null;
  }
  return linked;
}
function parsePlayerId(arg) {
  if (!arg || !/^\d+$/.test(arg)) return null;
  try { return BigInt(arg); } catch { return null; }
}

/* ─────────────────────── commands ─────────────────────── */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
    if (ALLOWED_CHANNEL_ID && msg.channel.id !== ALLOWED_CHANNEL_ID) {
      const allowedChannel = await client.channels.fetch(ALLOWED_CHANNEL_ID).catch(() => null);
      if (allowedChannel) {
        return void msg.reply(`⚠️ Цей бот доступний тільки в ${allowedChannel}.`);
      } else {
        return void msg.reply("⚠️ Цей бот доступний тільки в визначеному каналі.");
      }
    }

    const began = Date.now();
    const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
    log.info({ ...baseCtx(msg), cmd, args });

    /* ===== PUBLIC: stats/me/link/unlink/help ===== */

    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) return void msg.reply("Usage: `!stats <player_id>`");

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(idArg);
      if (!latest) return void msg.reply("No data yet. Run the scanner first.");

      const bundle = await buildZoneBasedKvkBundle(BigInt(idArg), latest);

      const key = cacheKeyPlayer(idArg, bundle.r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(bundle, latest);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "stats.png" });
      await msg.reply({ files: [file] });
      return log.info({ ...baseCtx(msg), cmd, ms: Date.now()-began, ok: true });
    }

    if (cmd === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest) return void msg.reply("No data for your player_id yet.");

      const bundle = await buildZoneBasedKvkBundle(BigInt(linked), latest);

      const key = cacheKeyPlayer(linked, bundle.r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(bundle, latest);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "stats.png" });
      await msg.reply({ files: [file] });
      return log.info({ ...baseCtx(msg), cmd, ms: Date.now()-began, ok: true });
    }

    if (cmd === "link") {
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = args[mention === msg.author ? 0 : 1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply("Usage: `!link [@user] <player_id>`");
      }

      const { rows } = await pool.query(
        `SELECT 1 FROM players WHERE id=$1 LIMIT 1`,
        [idArg]
      );
      if (!rows.length) {
        return void msg.reply(`Player_id **${idArg}** does not exist. Ask an admin to check scanner.`);
      }

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply("You can only link yourself. Ask an admin to link others.");
      }

      await setLink(mention.id, idArg);
      return void msg.reply(`Linked ${mention} ⇄ player_id **${idArg}**.`);
    }

    if (cmd === "unlink") {
      const mention = msg.mentions.users.first() ?? msg.author;

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply("You can only unlink yourself. Ask an admin to unlink others.");
      }

      const playerId = await fetchLink(mention.id);
      if (!playerId) {
        return void msg.reply(`${mention} is not linked yet.`);
      }

      await removeLink(mention.id);
      return void msg.reply(`Unlinked ${mention} ⇄ player_id **${playerId}**.`);
    }

    if (cmd === "help") {
      const HELP_PUBLIC = [
        "**Public commands:**",
        "`!stats <player_id>` — show a stats card for any player by ID",
        "`!me` — show **your** stats card (works only after `!link`)",
        "`!link <player_id>` — connect your Discord account with your in-game player ID",
        "`!unlink` — remove the link between your Discord and player ID",
        "`!help` — show this list of public commands",
      ].join("\n");
      return void msg.reply(HELP_PUBLIC);
    }

    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Admins only.");
      const HELP_ADMIN = [
        "**Admin commands:**",
        "`!link @user <player_id>` — link mentioned user",
        "`!unlink [@user]` — unlink mentioned user",
        "`!kvk start [name]` — start a new period",
        "`!kvk active` — show active period",
        "`!kvk weight show` — show current DKP weights",
        "`!kvk weight <dead|kills> <value>` — set DKP weights",
        "`!kvk ensure <player_id>` / `!kvk ensure_all` — create/update goals",
        "`!kvk stats <player_id>` / `!kvk me` — zone-based PNG progress",
        "`!kvk top [N] [text]` — top by progress % (PNG by default; add \`text\` for text)",
        "`!top [kills|power] [N]` — top by latest",
      ].join("\n");
      return void msg.reply(HELP_ADMIN);
    }

    /* ===== ADMIN-ONLY (далі) ===== */
    if (!isAdmin(msg)) {
      return void msg.reply("Admins only. Public: `!stats`, `!me`, `!link`, `!unlink`, `!help`.");
    }

    if (cmd === "kvk" && args[0] === "start") {
      const name = args.slice(1).join(" ") || null;
      const id = await kvkStart(name);
      return void msg.reply(`Period **${id}** started${name ? `: ${name}` : ""}.`);
    }

    if (cmd === "kvk" && args[0] === "active") {
      const id = await kvkActiveId();
      return void msg.reply(id ? `Active period: **${id}**` : "No active period.");
    }

    if (cmd === "kvk" && args[0] === "weight") {
      if (args[1] && args[1].toLowerCase() === "show") {
        const id = await kvkActiveId();
        if (!id) return void msg.reply("No active period.");
        const { rows } = await pool.query(
          `SELECT kills_weight, dead_to_kills
             FROM kvk_config
            WHERE kvk_id=$1`,
          [id]
        );
        if (!rows[0]) return void msg.reply("No weights found for the active period.");
        const { kills_weight, dead_to_kills } = rows[0];
        return void msg.reply(
          `Current weights → Kills: **${kills_weight}**, Dead: **${dead_to_kills}**`
        );
      }
      const which = (args[1] || "").toLowerCase();
      const val = Number(args[2]);
      if (!["dead", "kills"].includes(which) || !Number.isFinite(val)) {
        return void msg.reply("Usage: `!kvk weight <dead|kills> <value>` or `!kvk weight show`");
      }
      await kvkSetWeight(which, val);
      return void msg.reply(`Weight **${which}** set to **${val}**.`);
    }

    if (cmd === "kvk" && (args[0] === "ensure" || args[0] === "setgoal")) {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Usage: `!kvk ensure <player_id>`");
      const g = await kvkEnsureGoal(pid);
      if (!g) return void msg.reply("Goal already exists, or no active period/latest.");
      return void msg.reply(
        `Goal for **${pid}** → Kills ${nf(g.goal_kills)} • Dead ${nf(g.goal_dead)} • DKP ${nf(g.goal_dkp)}`
      );
    }

    if (cmd === "kvk" && args[0] === "ensure_all") {
      const { rows } = await pool.query(
        `SELECT player_id FROM latest WHERE player_id IS NOT NULL`
      );
      let made = 0, skipped = 0;
      for (const r of rows) {
        try {
          const out = await kvkEnsureGoal(BigInt(r.player_id));
          if (out) made++; else skipped++;
          await new Promise(res => setTimeout(res, 8));
        } catch {
          skipped++;
        }
      }
      return void msg.reply(`Goals ensured: **${made}** (skipped: ${skipped}).`);
    }

    // kvk stats (PNG для будь-якого player_id)
    if (cmd === "kvk" && args[0] === "stats") {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Usage: `!kvk stats <player_id>`");

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(pid);
      if (!latest) return void msg.reply("No latest data for this player.");

      const bundle = await buildZoneBasedKvkBundle(pid, latest);

      const key = cacheKeyPlayer(pid, bundle.r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(bundle, latest);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "kvk_stats.png" });
      await msg.reply({ files: [file] });
      return log.info({ ...baseCtx(msg), cmd: "kvk stats", ms: Date.now()-began, ok: true });
    }

    // kvk me (PNG для себе)
    if (cmd === "kvk" && args[0] === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest) return void msg.reply("No latest data for your player_id.");

      const bundle = await buildZoneBasedKvkBundle(BigInt(linked), latest);

      const key = cacheKeyPlayer(linked, bundle.r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(bundle, latest);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "kvk_stats.png" });
      return void msg.reply({ files: [file] });
    }

    // kvk top
    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const asText = (args[2] || "").toLowerCase() === "text";

      const rows = await kvkTop(limit);
      if (!rows.length) return void msg.reply("Empty. (Maybe no goals yet?)");

      if (asText) {
        const lines = rows.map((r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${pct1(r.pct)}% (DKP ${nf(r.dkp)}/${nf(r.goal_dkp)})`
        );
        return void msg.reply(lines.join("\n"));
      }

      const meta = {
        title: `KvK Top ${rows.length}`,
        active: (await kvkActiveId()) ?? "–",
        updated: new Date().toLocaleString(),
      };

      const key = cacheKeyTop(limit, meta.active, rows);
      let png = getCached(key);
      if (!png) {
        png = await renderKvkTopPNG(rows, meta);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "kvk_top.png" });
      return void msg.reply({ files: [file] });
    }

    // simple top by power/kills
    if (cmd === "top") {
      const by = (args[0] || "kills").toLowerCase();
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const rows = await fetchTop(by, limit);
      if (!rows.length) return void msg.reply("Empty. Run the scanner first.");
      const lines = rows.map((r, i) =>
        `**${i + 1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(r.metric)}**`
      );
      return void msg.reply(lines.join("\n"));
    }

    return void msg.reply("Admins only. Public: `!stats`, `!me`, `!link`, `!unlink`, `!help`.");
  } catch (e) {
    log.error({ err: String(e?.stack || e), where: "messageCreate" });
    try { await msg.reply("⚠️ An error occurred. Please contact an administrator."); } catch {}
    if (LOG_CHANNEL_ID) {
      const ch = client.channels.cache.get(LOG_CHANNEL_ID);
      if (ch?.isTextBased?.()) {
        ch.send(`⚠️ Error: \`${String(e?.message || e)}\``).catch(()=>{});
      }
    }
  }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const active = await kvkActiveId();
    console.log(`Active period: ${active ?? "<none>"}`);
  } catch {}
});

// graceful shutdown
for (const sig of ["SIGINT","SIGTERM","SIGQUIT"]) {
  process.on(sig, async () => {
    console.log(`\n${sig} → closing DB pool...`);
    try { await pool.end(); } catch {}
    process.exit(0);
  });
}

if (!process.env.DISCORD_TOKEN || !process.env.DATABASE_URL) {
  console.error("❌ DISCORD_TOKEN or DATABASE_URL is missing in .env");
}
client.login(process.env.DISCORD_TOKEN);