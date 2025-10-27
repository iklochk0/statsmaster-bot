// src/bot.js
// Discord bot (оновлено під правильну логіку):
//  - KP показуємо просто як "Kill Points" в шапці
//  - УВАГА: Прогрес KvK, цілі, відсотки, DKP = базуються на Kills(T4+T5) та Dead
//  - goal_kills = ціль по (T4+T5), goal_dead = ціль по Dead
//  - DKP = kills_weight * (дельта(T4+T5)) + dead_to_kills * (дельта Dead)
//
// Карта показує:
//  - Power / Kill Points / Dead / T5 / T4 (і +дельти зверху по боям)
//  - Progress bars: Kills(T4+T5), Dead, DKP
//  - LEFT: скільки залишилось до цілі
//  - RIGHT: остання завершена зона (Kills/Dead в тій зоні)
//  - WARM UP / OVERDRIVE і % = від DKP %
//
// Команди:
//   !stats <player_id>
//   !me
//   !link / !unlink
//   !kvk stats / !kvk me
//   !kvk ensure / !kvk ensure_all
//   !kvk top
//   !top kp|power
//
// ВАЖЛИВО: очікується, що в БД вже:
//   kvk_goals.goal_kills / goal_dead / goal_dkp
// і kvkEnsureGoal() повертає { goal_kills, goal_dead, goal_dkp }.

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionsBitField,
} from "discord.js";
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
  fetchStatsByRun, // Map(player_id -> {power,kp,dead,t1..t5})
} from "./db.pg.js";

/* ───────────────────────── config / env ───────────────────────── */

const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

const IMG_CACHE_TTL_S = Number(process.env.IMG_CACHE_TTL_S || 60);
const IMG_CACHE_MAX = Number(process.env.IMG_CACHE_MAX || 120);

const HEAVY_CMD_COOLDOWN_S = Number(process.env.HEAVY_CMD_COOLDOWN_S || 4);

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/* ───────────────────────── logger ───────────────────────── */

function nowIso() {
  return new Date().toISOString();
}
function baseCtx(msg) {
  return {
    t: nowIso(),
    g: msg.guild?.id ?? "-",
    c: msg.channel?.id ?? "-",
    u: msg.author?.id ?? "-",
    un: msg.author?.tag ?? "-",
  };
}
function logAt(level, obj) {
  if (LEVELS[level] < (LEVELS[LOG_LEVEL] ?? 20)) return;
  try {
    console.log(JSON.stringify({ level, ...obj }));
  } catch {}
}
const log = {
  debug: (o) => logAt("debug", o),
  info: (o) => logAt("info", o),
  warn: (o) => logAt("warn", o),
  error: (o) => logAt("error", o),
};

/* ───────────────────────── utils ───────────────────────── */

const nf = (x) =>
  new Intl.NumberFormat("en-US").format(
    Number.isFinite(Number(x)) ? Number(x) : 0
  );

const pct1 = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
};

function isAdmin(msg) {
  const m = msg.member;
  if (!m) return false;
  if (ADMIN_ROLE_IDS.length) {
    return m.roles?.cache?.some((r) => ADMIN_ROLE_IDS.includes(r.id)) || false;
  }
  return m.permissions?.has(PermissionsBitField.Flags.Administrator) || false;
}

const lastHeavyUse = new Map(); // userId -> timestamp(ms)
function checkCooldown(userId) {
  const now = Date.now();
  const prev = lastHeavyUse.get(userId) || 0;
  const restMs = HEAVY_CMD_COOLDOWN_S * 1000 - (now - prev);
  if (restMs > 0) return Math.ceil(restMs / 1000);
  lastHeavyUse.set(userId, now);
  return 0;
}

// скоротити ім'я
function trimName(s = "", max = 22) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// бейдж зверху справа по % DKP
function autoTag(pct) {
  const v = Number(pct) || 0;
  if (v >= 170) return "WHALE KILLER";
  if (v >= 140) return "OVERDRIVE";
  if (v >= 110) return "OVERCAP";
  if (v >= 90) return "ON TRACK";
  return "WARM UP";
}

/* ───────────────────────── DB pool ───────────────────────── */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// make sure schema exists
await initSchema();

// map discord -> player_id
await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );
`);

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
  await pool.query(`DELETE FROM discord_links WHERE discord_id=$1`, [discordId]);
}

// поточний snapshot по гравцю
async function fetchLatestById(id) {
  const { rows } = await pool.query(
    `SELECT l.player_id,
            l.name,
            l.power,
            l.kp,
            l.dead,
            l.t1, l.t2, l.t3, l.t4, l.t5,
            l.updated_at
       FROM latest l
      WHERE l.player_id = $1`,
    [id]
  );
  return rows[0] || null;
}

// топ по snapshot'у (latest)
// by = "kp" або "power"
async function fetchTop(by = "kp", limit = 10) {
  const col = by === "power" ? "power" : "kp";
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

/* ─────────────────────── KvK DELTAS VIA ZONES ───────────────────────
   Збираємо БОЙОВУ роботу:
   - сумуємо по всіх завершених зонах,
     дельти T4, T5, Dead, KP, Power...
   - kills(T4+T5) = дельтаT4 + дельтаT5
*/

async function computeZoneSumForPlayer(playerId) {
  const zones = await listZones();
  const finishedZones = zones.filter((z) => z.end_run_id != null);

  let dPower = 0,
    dKp = 0, // це Kill Points рост, чисто для інфо в шапці
    dDead = 0,
    dT1 = 0,
    dT2 = 0,
    dT3 = 0,
    dT4 = 0,
    dT5 = 0;

  const runCache = new Map();

  async function getRunMap(runId) {
    const key = String(runId);
    if (runCache.has(key)) return runCache.get(key);
    const m = await fetchStatsByRun(runId);
    runCache.set(key, m);
    return m;
  }

  for (const z of finishedZones) {
    const startRunId = Number(z.start_run_id);
    const endRunId = Number(z.end_run_id);
    if (!Number.isFinite(startRunId) || !Number.isFinite(endRunId)) continue;

    const startMap = await getRunMap(startRunId);
    const endMap = await getRunMap(endRunId);

    const s = startMap.get(String(playerId));
    const e = endMap.get(String(playerId));
    if (!s || !e) continue;

    dPower += Math.max(0, Number(e.power || 0) - Number(s.power || 0));
    dKp += Math.max(0, Number(e.kp || 0) - Number(s.kp || 0)); // KP приріст
    dDead += Math.max(0, Number(e.dead || 0) - Number(s.dead || 0));
    dT1 += Math.max(0, Number(e.t1 || 0) - Number(s.t1 || 0));
    dT2 += Math.max(0, Number(e.t2 || 0) - Number(s.t2 || 0));
    dT3 += Math.max(0, Number(e.t3 || 0) - Number(s.t3 || 0));
    dT4 += Math.max(0, Number(e.t4 || 0) - Number(s.t4 || 0));
    dT5 += Math.max(0, Number(e.t5 || 0) - Number(s.t5 || 0));
  }

  return { dPower, dKp, dDead, dT1, dT2, dT3, dT4, dT5 };
}

async function computeLastZoneDeltaForPlayer(playerId) {
  const zones = await listZones();
  const done = zones
    .filter((z) => z.end_run_id != null)
    .sort(
      (a, b) =>
        new Date(b.end_time || 0).getTime() -
        new Date(a.end_time || 0).getTime()
    );

  if (!done.length) {
    return {
      zoneName: "–",
      dKillsZone: 0,
      dDeadZone: 0,
    };
  }

  const last = done[0];
  const full = await getZone(last.zone_name);

  const startRunId = Number(full?.start_run_id ?? last.start_run_id);
  const endRunId = Number(full?.end_run_id ?? last.end_run_id);

  if (!Number.isFinite(startRunId) || !Number.isFinite(endRunId)) {
    return {
      zoneName: String(last.zone_name ?? "–"),
      dKillsZone: 0,
      dDeadZone: 0,
    };
  }

  const [startMap, endMap] = await Promise.all([
    fetchStatsByRun(startRunId),
    fetchStatsByRun(endRunId),
  ]);

  const s = startMap.get(String(playerId));
  const e = endMap.get(String(playerId));
  if (!s || !e) {
    return {
      zoneName: String(last.zone_name ?? "–"),
      dKillsZone: 0,
      dDeadZone: 0,
    };
  }

  const dT4Zone = Math.max(0, Number(e.t4 || 0) - Number(s.t4 || 0));
  const dT5Zone = Math.max(0, Number(e.t5 || 0) - Number(s.t5 || 0));
  const dKillsZone = dT4Zone + dT5Zone;

  const dDeadZone = Math.max(
    0,
    Number(e.dead || 0) - Number(s.dead || 0)
  );

  return {
    zoneName: String(last.zone_name ?? "Zone"),
    dKillsZone,
    dDeadZone,
  };
}

/**
 * buildZoneBasedKvkBundle(playerIdBigInt, latestRow)
 *
 * - тягне активний KvK
 * - тягне goal_kills / goal_dead / goal_dkp + ваги
 * - сумує бойові дельти по всіх завершених зонах
 * - готує дані для картки
 *
 * ВАЖЛИВО:
 *   d_kills = dT4 + dT5
 *   d_dead  = dDead
 *   dkp     = kills_weight*d_kills + dead_to_kills*d_dead
 */
async function buildZoneBasedKvkBundle(playerIdBigInt, latestRow) {
  const active = await kvkActiveId();
  let goalRow = null;
  let cfg = { kills_weight: 1.0, dead_to_kills: 5.0 };

  if (active) {
    const { rows: gRows } = await pool.query(
      `SELECT goal_kills, goal_dead, goal_dkp
         FROM kvk_goals
        WHERE kvk_id=$1 AND player_id=$2`,
      [active, playerIdBigInt]
    );
    goalRow = gRows[0] || null;

    const { rows: cRows } = await pool.query(
      `SELECT kills_weight, dead_to_kills
         FROM kvk_config
        WHERE kvk_id=$1`,
      [active]
    );
    if (cRows[0]) cfg = cRows[0];
  }

  // сума за всі завершені зони
  const zoneSum = await computeZoneSumForPlayer(playerIdBigInt);

  // остання завершена зона
  const lastZone = await computeLastZoneDeltaForPlayer(playerIdBigInt);

  // kills = T4+T5 дельтою
  const totalKills = Number(zoneSum.dT4 || 0) + Number(zoneSum.dT5 || 0);
  const totalDead = Number(zoneSum.dDead || 0);

  // DKP = w1*kills + w2*dead
  const dkpScore = Math.round(
    Number(cfg.kills_weight || 0) * totalKills +
      Number(cfg.dead_to_kills || 0) * totalDead
  );

  const goal_kills = Number(goalRow?.goal_kills || 0);
  const goal_dead = Number(goalRow?.goal_dead || 0);
  const goal_dkp = Number(goalRow?.goal_dkp || 0);

  const killsLeft = Math.max(0, goal_kills - totalKills);
  const deadLeft = Math.max(0, goal_dead - totalDead);
  const dkpLeft = Math.max(0, goal_dkp - dkpScore);

  const pctRaw = goal_dkp > 0 ? (100 * dkpScore) / goal_dkp : 0;

  return {
    latest: {
      player_id: latestRow.player_id,
      name: latestRow.name,
      power: Number(latestRow.power || 0),
      kp: Number(latestRow.kp || 0), // Kill Points snapshot
      dead: Number(latestRow.dead || 0),
      t4: Number(latestRow.t4 || 0),
      t5: Number(latestRow.t5 || 0),
      updated_at: latestRow.updated_at,
    },
    prog: {
      d_kills: totalKills, // T4+T5 зроблено
      d_dead: totalDead,
      dkp: dkpScore,
      goal_kills,
      goal_dead,
      goal_dkp,
      pct: pctRaw, // DKP %
      killsLeft,
      deadLeft,
      dkpLeft,
    },
    deltas: {
      dPower: Number(zoneSum.dPower || 0),
      dKp: Number(zoneSum.dKp || 0), // це просто info ("+KP") у верхній лінійці
      dDead: Number(zoneSum.dDead || 0),
      dT4: Number(zoneSum.dT4 || 0),
      dT5: Number(zoneSum.dT5 || 0),
    },
    lastZone, // {zoneName,dKillsZone,dDeadZone}
  };
}

/* ─────────────────────── CARD RENDERING ─────────────────────── */

function playerCardSVG(data) {
  const {
    player,
    goal,
    progress,
    warmUpPct,
    lastZone,
  } = data;

  const nf = (n) =>
    (n === null || n === undefined)
      ? "0"
      : Number(n).toLocaleString("en-US");

  const safeNum = (n) => Number(n ?? 0);

  const pctKills = goal.goal_kills
    ? Math.min(100, (safeNum(progress.d_kills) / goal.goal_kills) * 100)
    : 0;

  const pctDead = goal.goal_dead
    ? Math.min(100, (safeNum(progress.d_dead) / goal.goal_dead) * 100)
    : 0;

  const pctDKP = goal.goal_dkp
    ? Math.min(100, (safeNum(progress.d_dkp) / goal.goal_dkp) * 100)
    : 0;

  const killsLeft = Math.max(0, safeNum(goal.goal_kills) - safeNum(progress.d_kills));
  const deadLeft  = Math.max(0, safeNum(goal.goal_dead)  - safeNum(progress.d_dead));
  const dkpLeft   = Math.max(0, safeNum(goal.goal_dkp)   - safeNum(progress.d_dkp));

  const hasLastZoneData =
    lastZone &&
    lastZone.zoneName &&
    lastZone.zoneName !== "–" &&
    (safeNum(lastZone.dKillsZone) > 0 || safeNum(lastZone.dDeadZone) > 0);

  // ----- кольори / геометрія -----
  const bg      = "#000000";   // ← чорний фон
  const panelBg = "#0d121d";   // панелі/блоки
  const textCol = "#fff";
  const subCol  = "#9da5bd";
  const barBg   = "#2a3142";
  const barFill = "#6b7bff";

  const w = 1100;
  const h = 620;

  const barX = 50;
  const barW = w - 100;
  const barH = 24;
  const barGapY = 60;

  const bottomY = 400;
  const boxW = (w - 150) / 2;
  const boxH = 70;
  const boxR = 8;

  const leftBoxX = 50;
  const rightBoxX = 50 + boxW + 50;

  const updatedAtStr = player.updated_at
    ? new Date(player.updated_at).toLocaleString("en-US", {
        hour12: true,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

  const lastZoneBox = hasLastZoneData ? `
    <g transform="translate(${rightBoxX}, ${bottomY})">
      <text x="0" y="0"
            font-family="Inter, system-ui"
            font-size="14"
            fill="${subCol}"
            font-weight="500"
            >YOUR LAST FIGHTS AT "${lastZone.zoneName}" ZONE</text>

      <rect x="0" y="16"
            width="${boxW}" height="${boxH}"
            rx="${boxR}"
            fill="${barBg}"/>

      <text x="16" y="52"
            font-family="Inter, system-ui"
            font-size="18"
            fill="${textCol}"
            font-weight="500"
            >KP ${nf(lastZone.dKillsZone)} • Dead ${nf(lastZone.dDeadZone)}</text>
    </g>
  ` : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${w}" height="${h}"
     viewBox="0 0 ${w} ${h}"
     style="background:${bg}; font-family:Inter,system-ui">

  <!-- full card background -->
  <rect x="0" y="0" width="${w}" height="${h}" rx="16" fill="${panelBg}"/>

  <style>
    .title   { fill:${textCol}; font-size:24px; font-weight:600; font-family:Inter, system-ui; }
    .sub     { fill:${subCol};  font-size:14px; font-weight:500; font-family:Inter, system-ui; }
    .metricH { fill:${textCol}; font-size:20px; font-weight:600; font-family:Inter, system-ui; }
    .metricV { fill:${textCol}; font-size:24px; font-weight:600; font-family:Inter, system-ui; }
    .metricS { fill:${subCol};  font-size:14px; font-weight:500; font-family:Inter, system-ui; }

    .barLabel { fill:${textCol}; font-size:14px; font-weight:500; font-family:Inter, system-ui; }
    .barText  { fill:${textCol}; font-size:14px; font-weight:500; font-family:Inter, system-ui; text-anchor:middle; }

    .dkpLeftLabel { fill:${textCol}; font-size:16px; font-weight:500; font-family:Inter, system-ui; }
  </style>

  <!-- Header row -->
  <g transform="translate(24,36)">
    <text class="title">
      ${player.name} (${player.id})
    </text>

    <text y="28" class="sub">
      Updated: ${updatedAtStr}
    </text>
  </g>

  <!-- Warm up % -->
  <g transform="translate(${w-140},36)" text-anchor="end">
    <text fill="${textCol}" font-size="40" font-weight="600"
          font-family="Inter, system-ui">
      ${Math.round(warmUpPct)}%
    </text>
    <text y="32" fill="${subCol}" font-size="14" font-weight="600"
          font-family="Inter, system-ui" letter-spacing="0.08em">
      WARM UP
    </text>
  </g>

  <!-- top metrics row -->
  <g transform="translate(24,100)">
    <!-- Power -->
    <g>
      <text class="metricH" x="0"  y="0">Power</text>
      <text class="metricV" x="0"  y="30">${nf(player.power)}</text>
      <text class="metricS" x="0"  y="48">±0</text>
    </g>

    <!-- Kill Points (просто інфо, не goal) -->
    <g transform="translate(200,0)">
      <text class="metricH" x="0"  y="0">Kill points</text>
      <text class="metricV" x="0"  y="30">${nf(player.kp)}</text>
      <text class="metricS" x="0"  y="48">±0</text>
    </g>

    <!-- Dead -->
    <g transform="translate(400,0)">
      <text class="metricH" x="0"  y="0">Dead</text>
      <text class="metricV" x="0"  y="30">${nf(player.dead)}</text>
      <text class="metricS" x="0"  y="48">±0</text>
    </g>

    <!-- T5 -->
    <g transform="translate(600,0)">
      <text class="metricH" x="0"  y="0">T5</text>
      <text class="metricV" x="0"  y="30">${nf(player.t5)}</text>
      <text class="metricS" x="0"  y="48">±0</text>
    </g>

    <!-- T4 -->
    <g transform="translate(760,0)">
      <text class="metricH" x="0"  y="0">T4</text>
      <text class="metricV" x="0"  y="30">${nf(player.t4)}</text>
      <text class="metricS" x="0"  y="48">±0</text>
    </g>
  </g>

  <!-- Progress bars block -->
  <g transform="translate(0,190)">
    <!-- Kills bar (це наші t4+t5 у прогресі) -->
    <g transform="translate(0,0)">
      <text class="barLabel" x="${barX}" y="-8">Kills (T4+T5)</text>

      <rect x="${barX}" y="0" width="${barW}" height="${barH}" rx="4"
            fill="${barBg}"/>
      <rect x="${barX}" y="0" width="${(barW * pctKills/100).toFixed(1)}"
            height="${barH}" rx="4"
            fill="${barFill}"/>

      <text class="barText"
            x="${barX + barW/2}"
            y="${barH/2 + 4}">
        ${Math.floor(pctKills)}%
      </text>

      <text class="barLabel"
            x="${barX}" y="${barH+20}">
        ${nf(progress.d_kills)} / ${nf(goal.goal_kills)}
      </text>
    </g>

    <!-- Dead bar -->
    <g transform="translate(0,${barGapY})">
      <text class="barLabel" x="${barX}" y="-8">Dead</text>

      <rect x="${barX}" y="0" width="${barW}" height="${barH}" rx="4"
            fill="${barBg}"/>
      <rect x="${barX}" y="0" width="${(barW * pctDead/100).toFixed(1)}"
            height="${barH}" rx="4"
            fill="${barFill}"/>
      <text class="barText"
            x="${barX + barW/2}"
            y="${barH/2 + 4}">
        ${Math.floor(pctDead)}%
      </text>

      <text class="barLabel"
            x="${barX}" y="${barH+20}">
        ${nf(progress.d_dead)} / ${nf(goal.goal_dead)}
      </text>
    </g>

    <!-- DKP bar -->
    <g transform="translate(0,${barGapY*2})">
      <text class="barLabel" x="${barX}" y="-8">DKP</text>

      <rect x="${barX}" y="0" width="${barW}" height="${barH}" rx="4"
            fill="${barBg}"/>
      <rect x="${barX}" y="0" width="${(barW * pctDKP/100).toFixed(1)}"
            height="${barH}" rx="4"
            fill="${barFill}"/>
      <text class="barText"
            x="${barX + barW/2}"
            y="${barH/2 + 4}">
        ${Math.floor(pctDKP)}%
      </text>

      <text class="barLabel"
            x="${barX}" y="${barH+20}">
        ${nf(progress.d_dkp)} / ${nf(goal.goal_dkp)}
      </text>
    </g>
  </g>

  <!-- Bottom LEFT box -->
  <g transform="translate(${leftBoxX}, ${bottomY})">
    <text x="0" y="0"
          font-family="Inter, system-ui"
          font-size="14"
          fill="${subCol}"
          font-weight="500"
          >LEFT</text>

    <rect x="0" y="16"
          width="${boxW}" height="${boxH}"
          rx="${boxR}"
          fill="${barBg}"/>

    <text x="16" y="52"
          font-family="Inter, system-ui"
          font-size="18"
          fill="${textCol}"
          font-weight="500">
      Kills ${nf(killsLeft)} • Dead ${nf(deadLeft)}
    </text>
  </g>

  ${lastZoneBox}

  <!-- DKP left -->
  <g transform="translate(${leftBoxX}, ${bottomY + boxH + 60})">
    <text class="dkpLeftLabel">
      DKP left: ${nf(dkpLeft)}
    </text>
  </g>

</svg>
`;
}


async function renderPlayerCardPNG(bundle) {
  const svg = playerCardSVG(bundle);
  const buf = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  return buf;
}

/* ─────────────────────── KvK TOP PNG ─────────────────────── */

function hashTopRows(rows) {
  const s = rows
    .map((r) => `${r.player_id}:${r.dkp}:${r.goal_dkp}:${r.pct}`)
    .join("|");
  return createHash("md5").update(s).digest("hex").slice(0, 12);
}

function kvkTopSVG(rows, meta = {}) {
  const W = 1100;
  const H = 120 + rows.length * 56 + 40;

  const panel = "#0f1218";
  const card = "#121722";
  const grid = "#1e2633";
  const text = "#e6edf7";
  const sub = "#a9b4c6";
  const track = "#2b3342";
  const color1 = "#7c4dff";

  const marginX = 40;
  const listLeft = marginX + 12;
  const barLeft = 250;
  const barWidth = W - barLeft - 85;
  const padRight = 46;
  const hBar = 20;
  const rxy = 7;
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
        <text x="${barLeft + barWidth - padRight/2}" y="${y + 35}" text-anchor="end" class="m">${pct1(
      pct
    )}%</text>
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

  <rect width="${W}" height="${H}" fill="${panel}"/>
  <g>
    <rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="22" fill="${card}" stroke="${grid}" stroke-width="1"/>

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

/* ─────────────────────── PNG cache ─────────────────────── */

const imgCache = new Map(); // key -> { buf, t }

function cacheKeyPlayer(pid, bundle) {
  return `p:${pid}:${bundle.prog.dkp}|${bundle.prog.goal_dkp}|${bundle.prog.d_kills}|${bundle.prog.d_dead}|${
    bundle.latest.updated_at ?? ""
  }`;
}

function cacheKeyTop(limit, activeId, rows) {
  const h = hashTopRows(rows);
  return `top:${limit}:${activeId ?? "none"}:${h}`;
}

function getCached(key) {
  const v = imgCache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > IMG_CACHE_TTL_S * 1000) {
    imgCache.delete(key);
    return null;
  }
  return v.buf;
}
function setCached(key, buf) {
  if (imgCache.size >= IMG_CACHE_MAX) {
    const firstKey = imgCache.keys().next().value;
    if (firstKey) imgCache.delete(firstKey);
  }
  imgCache.set(key, { buf, t: Date.now() });
}

/* ─────────────────────── Discord client ─────────────────────── */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ─────────────────────── helpers ─────────────────────── */

async function getLinkedPlayerIdOrReply(msg) {
  const linked = await fetchLink(msg.author.id);
  if (!linked) {
    await msg.reply('Спочатку зв’яжи себе: `!link <player_id>`');
    return null;
  }
  return linked;
}

function parsePlayerId(arg) {
  if (!arg || !/^\d+$/.test(arg)) return null;
  try {
    return BigInt(arg);
  } catch {
    return null;
  }
}

/* ─────────────────────── commands ─────────────────────── */

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
    if (ALLOWED_CHANNEL_ID && msg.channel.id !== ALLOWED_CHANNEL_ID) {
      const allowedChannel = await client.channels
        .fetch(ALLOWED_CHANNEL_ID)
        .catch(() => null);
      if (allowedChannel) {
        return void msg.reply(
          `⚠️ Цей бот доступний тільки в ${allowedChannel}.`
        );
      } else {
        return void msg.reply(
          "⚠️ Цей бот доступний тільки в визначеному каналі."
        );
      }
    }

    const began = Date.now();
    const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
    log.info({ ...baseCtx(msg), cmd, args });

    /* ===== ПУБЛІЧНІ КОМАНДИ ===== */

    // !stats <player_id>
    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply("Використання: `!stats <player_id>`");
      }

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Повільніше. Повтори через ${cd}s.`);

      const latest = await fetchLatestById(idArg);
      if (!latest) {
        return void msg.reply("Ще нема даних. Треба прогнати сканер по цьому гравцю.");
      }

      const bundle = await buildZoneBasedKvkBundle(BigInt(idArg), latest);

      const key = cacheKeyPlayer(idArg, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "stats.png" });
      await msg.reply({ files: [file] });

      log.info({
        ...baseCtx(msg),
        cmd,
        ms: Date.now() - began,
        ok: true,
      });
      return;
    }

    // !me
    if (cmd === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Повільніше. Повтори через ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest) {
        return void msg.reply("Поки що немає даних по твоєму player_id.");
      }

      const bundle = await buildZoneBasedKvkBundle(BigInt(linked), latest);

      const key = cacheKeyPlayer(linked, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "stats.png" });
      await msg.reply({ files: [file] });

      log.info({
        ...baseCtx(msg),
        cmd,
        ms: Date.now() - began,
        ok: true,
      });
      return;
    }

    // !link <player_id>  або  !link @user <player_id> (адмін)
    if (cmd === "link") {
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = mention === msg.author ? args[0] : args[1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply(
          "Використання: `!link <player_id>` або `!link @user <player_id>` (тільки адмін)"
        );
      }

      const { rows } = await pool.query(
        `SELECT 1 FROM players WHERE id=$1 LIMIT 1`,
        [idArg]
      );
      if (!rows.length) {
        return void msg.reply(
          `player_id **${idArg}** поки не в базі. Нехай адмін прогоне сканер.`
        );
      }

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply(
          "Ти можеш лінкати тільки себе. Щоб лінкати інших — потрібен адмін."
        );
      }

      await setLink(mention.id, idArg);
      return void msg.reply(
        `Зв’язано ${mention} ⇄ player_id **${idArg}**.`
      );
    }

    // !unlink [@user]
    if (cmd === "unlink") {
      const mention = msg.mentions.users.first() ?? msg.author;

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply(
          "Ти можеш розлінкувати тільки себе. Інших — тільки адмін."
        );
      }

      const playerId = await fetchLink(mention.id);
      if (!playerId) {
        return void msg.reply(`${mention} ще не прив'язаний.`);
      }

      await removeLink(mention.id);
      return void msg.reply(
        `Відв’язано ${mention} ⇄ player_id **${playerId}**.`
      );
    }

    if (cmd === "help") {
      const HELP_PUBLIC = [
        "**Публічні команди:**",
        "`!stats <player_id>` — картка гравця (Kills T4+T5 / Dead прогрес у KvK)",
        "`!me` — твоя картка (після `!link`)",
        "`!link <player_id>` — прив’язати свій Discord до свого player_id",
        "`!unlink` — відв’язати",
        "`!help` — ця допомога",
      ].join("\n");
      return void msg.reply(HELP_PUBLIC);
    }

    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Тільки адміни.");
      const HELP_ADMIN = [
        "**Команди адміна:**",
        "`!link @user <player_id>` — прив’язати згаданого юзера",
        "`!unlink [@user]` — відв’язати",
        "`!kvk start [name]` — створити новий KvK період",
        "`!kvk active` — показати активний KvK`",
        "`!kvk weight show` — показати ваги DKP (kills_weight для Kills(T4+T5), dead_to_kills для Dead)`",
        "`!kvk weight <dead|kills> <value>` — оновити вагу DKP`",
        "`!kvk ensure <player_id>` / \`!kvk ensure_all\` — згенерити goal_kills / goal_dead / goal_dkp для гравців`",
        "`!kvk stats <player_id>` / \`!kvk me\` — картка прогресу KvK (Kills T4+T5 / Dead / DKP)`",
        "`!kvk top [N] [text]` — топ по % DKP до цілі (PNG або text)`",
        "`!top [kp|power] [N]` — топ по snapshot (KP = Kill Points total)`",
      ].join("\n");
      return void msg.reply(HELP_ADMIN);
    }

    /* ===== ДАЛІ ТІЛЬКИ АДМІНИ ===== */
    if (!isAdmin(msg)) {
      return void msg.reply(
        "Тільки адміни. Публічно є: `!stats`, `!me`, `!link`, `!unlink`, `!help`."
      );
    }

    /* KvK admin блок */

    // !kvk start [name]
    if (cmd === "kvk" && args[0] === "start") {
      await initSchema();
      const name = args.slice(1).join(" ") || null;
      const id = await kvkStart(name);
      return void msg.reply(
        `Період **${id}** стартував${name ? `: ${name}` : ""}.`
      );
    }

    // !kvk active
    if (cmd === "kvk" && args[0] === "active") {
      const id = await kvkActiveId();
      return void msg.reply(
        id ? `Активний період: **${id}**` : "Активного періоду нема."
      );
    }

    // !kvk weight show / !kvk weight <dead|kills> <value>
    if (cmd === "kvk" && args[0] === "weight") {
      if ((args[1] || "").toLowerCase() === "show") {
        const id = await kvkActiveId();
        if (!id) return void msg.reply("Активного періоду нема.");
        const { rows } = await pool.query(
          `SELECT kills_weight, dead_to_kills
             FROM kvk_config
            WHERE kvk_id=$1`,
          [id]
        );
        if (!rows[0]) {
          return void msg.reply("Нема запису ваг для активного періоду.");
        }
        const { kills_weight, dead_to_kills } = rows[0];
        return void msg.reply(
          `Ваги DKP → Kills(T4+T5): **${kills_weight}**, Dead: **${dead_to_kills}**`
        );
      }

      const which = (args[1] || "").toLowerCase();
      const val = Number(args[2]);
      if (!["dead", "kills"].includes(which) || !Number.isFinite(val)) {
        return void msg.reply(
          "Використання: `!kvk weight <dead|kills> <value>` або `!kvk weight show`"
        );
      }
      await kvkSetWeight(which, val);
      return void msg.reply(`Вага **${which}** оновлена на **${val}**.`);
    }

    // !kvk ensure <player_id>
    // створює goal_kills / goal_dead / goal_dkp для цього гравця, якщо ще нема
    if (cmd === "kvk" && (args[0] === "ensure" || args[0] === "setgoal")) {
      const pid = parsePlayerId(args[1]);
      if (pid == null) {
        return void msg.reply("Використання: `!kvk ensure <player_id>`");
      }

      const g = await kvkEnsureGoal(pid);
      if (!g) {
        return void msg.reply(
          "Гол вже існує, або нема активного KvK / нема latest у гравця."
        );
      }

      return void msg.reply(
        `Goal для **${pid}** → Kills(T4+T5) ${nf(
          g.goal_kills
        )} • Dead ${nf(g.goal_dead)} • DKP ${nf(g.goal_dkp)}`
      );
    }

    // !kvk ensure_all
    if (cmd === "kvk" && args[0] === "ensure_all") {
      const { rows } = await pool.query(
        `SELECT player_id FROM latest WHERE player_id IS NOT NULL`
      );
      let made = 0,
        skipped = 0;
      for (const r of rows) {
        try {
          const out = await kvkEnsureGoal(BigInt(r.player_id));
          if (out) made++;
          else skipped++;
          await new Promise((res) => setTimeout(res, 8));
        } catch {
          skipped++;
        }
      }
      return void msg.reply(
        `Голи виставлені: **${made}** (пропущено: ${skipped}).`
      );
    }

    // !kvk stats <player_id>
    // картка прогресу KvK (Kills T4+T5 / Dead / DKP)
    if (cmd === "kvk" && args[0] === "stats") {
      const pid = parsePlayerId(args[1]);
      if (pid == null) {
        return void msg.reply("Використання: `!kvk stats <player_id>`");
      }

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Повільніше. Повтори через ${cd}s.`);

      const latest = await fetchLatestById(pid);
      if (!latest) {
        return void msg.reply("Нема latest по цьому гравцю.");
      }

      const bundle = await buildZoneBasedKvkBundle(pid, latest);

      const key = cacheKeyPlayer(pid, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "kvk_stats.png" });
      await msg.reply({ files: [file] });

      log.info({
        ...baseCtx(msg),
        cmd: "kvk stats",
        ms: Date.now() - began,
        ok: true,
      });
      return;
    }

    // !kvk me
    if (cmd === "kvk" && args[0] === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Повільніше. Повтори через ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest) {
        return void msg.reply("Нема latest по твоєму player_id.");
      }

      const bundle = await buildZoneBasedKvkBundle(BigInt(linked), latest);

      const key = cacheKeyPlayer(linked, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "kvk_stats.png" });
      await msg.reply({ files: [file] });
      return;
    }

    // !kvk top [N] [text]
    // показує топ по % DKP до goal_dkp (kvk_progress view)
    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(
        Math.max(parseInt(args[1] || "10", 10) || 10, 1),
        50
      );
      const asText = (args[2] || "").toLowerCase() === "text";

      const rows = await kvkTop(limit);
      if (!rows.length) {
        return void msg.reply("Пусто. Можливо, ще немає goals.");
      }

      if (asText) {
        const lines = rows.map(
          (r, i) =>
            `**${i + 1}.** ${r.name ?? r.player_id} — ${pct1(
              r.pct
            )}% (DKP ${nf(r.dkp)}/${nf(r.goal_dkp)})`
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
      await msg.reply({ files: [file] });
      return;
    }

    // !top [kp|power] [N]
    // це просто snapshot рейтинг
    if (cmd === "top") {
      const by = (args[0] || "kp").toLowerCase(); // kp або power
      const limit = Math.min(
        Math.max(parseInt(args[1] || "10", 10) || 10, 1),
        50
      );

      const rows = await fetchTop(by, limit);
      if (!rows.length) {
        return void msg.reply("Пусто. Спочатку треба прогнати сканер.");
      }

      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(
            r.metric
          )}**`
      );
      return void msg.reply(lines.join("\n"));
    }

    return void msg.reply(
      "Невідома команда. Подивись `!help` або `!helpadmin`."
    );
  } catch (e) {
    log.error({ err: String(e?.stack || e), where: "messageCreate" });
    try {
      await msg.reply("⚠️ Сталася помилка. Поклич адміна.");
    } catch {}
    if (LOG_CHANNEL_ID) {
      const ch = client.channels.cache.get(LOG_CHANNEL_ID);
      if (ch?.isTextBased?.()) {
        ch.send(`⚠️ Error: \`${String(e?.message || e)}\``).catch(() => {});
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
for (const sig of ["SIGINT", "SIGTERM", "SIGQUIT"]) {
  process.on(sig, async () => {
    console.log(`\n${sig} → closing DB pool...`);
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  });
}

if (!process.env.DISCORD_TOKEN || !process.env.DATABASE_URL) {
  console.error("❌ DISCORD_TOKEN або DATABASE_URL відсутній в .env");
}
client.login(process.env.DISCORD_TOKEN);