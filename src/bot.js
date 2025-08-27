// src/bot.js — Discord bot with modern PNG stats (3 stripes), deltas, caching, logging, PNG leaderboard, and admin gating by role IDs.
// UI texts: EN; code comments: UKR

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
  kvkProgress,
  kvkTop,
  kvkActiveId,
} from "./db.pg.js";

/* ───────────────────────── env / constants ───────────────────────── */
// адмiн-ролi через .env (comma-separated)
const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// опцiйний канал для репортингу помилок (ID)
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

// кеш картинок: TTL (сек) i максимум ел.
const IMG_CACHE_TTL_S = Number(process.env.IMG_CACHE_TTL_S || 60);
const IMG_CACHE_MAX   = Number(process.env.IMG_CACHE_MAX || 120);

// тротлiнг для важких команд (сек/користувач)
const HEAVY_CMD_COOLDOWN_S = Number(process.env.HEAVY_CMD_COOLDOWN_S || 4);

// лог-рiвень: debug|info|warn|error
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
  try { console.log(JSON.stringify({ level, ...obj })); } catch { /* noop */ }
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
const sum = (arr)=>arr.reduce((a,b)=>a+b,0);

// формат/колір дельт
const GREEN = "#6ee7a8";
const RED   = "#ef5350";
const NEUTR = "#a9b4c6";
const colorDelta = (n) => (n > 0 ? GREEN : n < 0 ? RED : NEUTR);
const fmtDelta   = (n) => (n > 0 ? `+${nf(n)}` : n < 0 ? `-${nf(Math.abs(n))}` : `±0`);

// перевірка адмін-доступу: спочатку ролі з .env, потім Admin perm fallback
function isAdmin(msg) {
  const m = msg.member;
  if (!m) return false;
  if (ADMIN_ROLE_IDS.length) {
    return m.roles?.cache?.some(r => ADMIN_ROLE_IDS.includes(r.id)) || false;
  }
  return m.permissions?.has(PermissionsBitField.Flags.Administrator) || false;
}

// простий пер-юзер тротлінг
const lastHeavyUse = new Map(); // userId -> timestamp(ms)
function checkCooldown(userId){
  const now = Date.now();
  const prev = lastHeavyUse.get(userId) || 0;
  const restMs = HEAVY_CMD_COOLDOWN_S * 1000 - (now - prev);
  if (restMs > 0) return Math.ceil(restMs/1000);
  lastHeavyUse.set(userId, now);
  return 0;
}

// Help (EN)
const HELP_PUBLIC = [
  "**Public commands:**",
  "`!stats <player_id>` — PNG stats card",
  "`!me` — my PNG stats card (after `!link`)",
  "`!link <player_id>` — link yourself",
  "`!unlink` — unbind",
  "`!help` — show this help",
].join("\n");

const HELP_ADMIN = [
  "**Admin commands:**",
  "`!link @user <player_id>` — link mentioned user",
  "`!unlink [@user]` — unlink mentioned user",
  "`!kvk start [name]` — start a new period",
  "`!kvk active` — show active period",
  "`!kvk weight show` — show current DKP weights",
  "`!kvk weight <dead|kp> <value>` — set DKP weights",
  "`!kvk ensure <player_id>` / `!kvk ensure_all` — create/update goals",
  "`!kvk stats <player_id>` / `!kvk me` — text progress (diagnostics)",
  "`!kvk top [N] [text]` — top by progress % (PNG by default; add `text` for text)",
  "`!top [kp|power] [N]` — top by latest",
].join("\n");

/* ───────────────────────── DB ───────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await initSchema();

await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );
`);

async function fetchLatestById(id) {
  const { rows } = await pool.query(
    `SELECT l.player_id, l.name, l.power, l.kp, l.dead, l.t4, l.t5, l.updated_at
     FROM latest l
     WHERE l.player_id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function fetchLink(discordId) {
  const { rows } = await pool.query(`SELECT player_id FROM discord_links WHERE discord_id=$1`, [discordId]);
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

// KvK старт (active kvk) для гравця — для дельт (Power/T4/T5 теж є)
async function fetchKvKStart(playerId) {
  const active = await kvkActiveId();
  if (!active) return null;
  const { rows } = await pool.query(
    `SELECT start_power, start_kp, start_dead, start_t5, start_t4
     FROM kvk_goals
     WHERE kvk_id = $1 AND player_id = $2`,
    [active, playerId]
  );
  return rows[0] || null;
}

/* ─────────────────────── PNG card renderer (player) ─────────────────────── */
// авто-тег за DKP
function autoTag(pct) {
  const v = Number(pct) || 0;
  if (v >= 170) return "WHALE KILLER";
  if (v >= 140) return "OVERDRIVE";
  if (v >= 110) return "OVERCAP";
  if (v >= 90)  return "ON TRACK";
  return "WARM UP";
}

// головний SVG (3 смуги KP/Dead/DKP)
function stripeCardSVG(r, latest, deltas) {
  const W = 1100, H = 640;
  const panel = "#0f1218", card = "#121722", grid = "#1e2633", text = "#e6edf7", sub = "#a9b4c6";
  const track = "#2b3342", color1 = "#00c853", color2 = "#7c4dff";

  // реальний % для цифри/тега; обрізаний — тільки для барів
  const pctDKP_raw = Number(r?.pct) || 0;
  const pctDKP     = clamp(pctDKP_raw, 0, 220);
  const pctKP   = clamp(((Number(r?.d_kp)   || 0) / (Number(r?.goal_kp)   || 0)) * 100 || 0, 0, 220);
  const pctDead = clamp(((Number(r?.d_dead) || 0) / (Number(r?.goal_dead) || 0)) * 100 || 0, 0, 220);

  const dkpLeft  = Math.max(0, Number(r?.goal_dkp || 0) - Number(r?.dkp || 0));
  const kpLeft   = Math.max(0, Number(r?.goal_kp  || 0) - Number(r?.d_kp || 0));
  const deadLeft = Math.max(0, Number(r?.goal_dead|| 0) - Number(r?.d_dead || 0));

  const title = latest?.name ? `${latest.name} (${latest.player_id})` : String(latest?.player_id ?? "");
  const updated = latest?.updated_at ? new Date(latest.updated_at) : new Date();

  const x0 = 50, width = W - 100, hBar = 28, rxy = 14;
  const yBase = 230, gap = 70;
  const yKP = yBase, yDead = yBase + gap, yDKP = yBase + gap*2;

  const len = (pct) => ({
    base: (width * Math.min(pct, 100)) / 100,
    over: (width * Math.min(Math.max(0, pct - 100), 100)) / 100
  });
  const L_kp = len(pctKP), L_dead = len(pctDead), L_dkp = len(pctDKP);

  const { dPower=0, dKP=0, dDead=0, dT5=0, dT4=0 } = deltas || {};
  const cPow  = colorDelta(dPower), cKPcol = colorDelta(dKP), cDeadCol = colorDelta(dDead);
  const cT5   = colorDelta(dT5),    cT4    = colorDelta(dT4);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      .t  { font: 700 22px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .s  { font: 500 14px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${sub}; }
      .b  { font: 800 40px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; }
      .tg { font: 800 16px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif; fill: ${text}; letter-spacing: 2px; }
      .m  { font: 600 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: ${text}; }
    </style>
  </defs>

  <rect width="${W}" height="${H}" fill="${panel}"/>
  <g>
    <rect x="20" y="20" width="${W-40}" height="${H-40}" rx="22" fill="${card}" stroke="${grid}" stroke-width="1"/>

    <!-- header -->
    <text x="50" y="64" class="t">${title}</text>
    <text x="50" y="88" class="s">Updated: ${updated.toLocaleString()}</text>

    <!-- top-right percentage + tag (DKP) -->
    <text x="${W-50}" y="62" text-anchor="end" class="b">${pct1(pctDKP_raw)}%</text>
    <text x="${W-50}" y="88" text-anchor="end" class="tg">${autoTag(pctDKP_raw)}</text>

    <!-- key metrics + deltas -->
    <g transform="translate(50,120)">
      <text class="s">Power</text>
      <text y="24" class="t">${nf(latest?.power)}</text>
      <text y="46" class="m" style="fill:${cPow}">${fmtDelta(dPower)}</text>
    </g>
    <g transform="translate(260,120)">
      <text class="s">KP</text>
      <text y="24" class="t">${nf(latest?.kp)}</text>
      <text y="46" class="m" style="fill:${cKPcol}">${fmtDelta(dKP)}</text>
    </g>
    <g transform="translate(470,120)">
      <text class="s">Dead</text>
      <text y="24" class="t">${nf(latest?.dead)}</text>
      <text y="46" class="m" style="fill:${cDeadCol}">${fmtDelta(dDead)}</text>
    </g>
    <g transform="translate(680,120)">
      <text class="s">T5</text>
      <text y="24" class="t">${nf(latest?.t5)}</text>
      <text y="46" class="m" style="fill:${cT5}">${fmtDelta(dT5)}</text>
    </g>
    <g transform="translate(880,120)">
      <text class="s">T4</text>
      <text y="24" class="t">${nf(latest?.t4)}</text>
      <text y="46" class="m" style="fill:${cT4}">${fmtDelta(dT4)}</text>
    </g>

    <!-- KP bar -->
    <text x="${x0}" y="${yKP-8}" class="s">KP</text>
    <rect x="${x0}" y="${yKP}" width="${width}" height="${hBar}" rx="${rxy}" fill="${track}"/>
    ${pctKP <= 100 ? `
      <rect x="${x0}" y="${yKP}" width="${L_kp.base}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
    ` : `
      <rect x="${x0}" y="${yKP}" width="${width}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
      <rect x="${x0}" y="${yKP}" width="${L_kp.over}" height="${hBar}" rx="${rxy}" fill="${color2}"/>
    `}
    <text x="${x0 + width/2}" y="${yKP + hBar/2 + 6}" text-anchor="middle" class="m">${pct1(pctKP)}%</text>

    <!-- Dead bar -->
    <text x="${x0}" y="${yDead-8}" class="s">Dead</text>
    <rect x="${x0}" y="${yDead}" width="${width}" height="${hBar}" rx="${rxy}" fill="${track}"/>
    ${pctDead <= 100 ? `
      <rect x="${x0}" y="${yDead}" width="${L_dead.base}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
    ` : `
      <rect x="${x0}" y="${yDead}" width="${width}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
      <rect x="${x0}" y="${yDead}" width="${L_dead.over}" height="${hBar}" rx="${rxy}" fill="${color2}"/>
    `}
    <text x="${x0 + width/2}" y="${yDead + hBar/2 + 6}" text-anchor="middle" class="m">${pct1(pctDead)}%</text>

    <!-- DKP bar -->
    <text x="${x0}" y="${yDKP-8}" class="s">DKP</text>
    <rect x="${x0}" y="${yDKP}" width="${width}" height="${hBar}" rx="${rxy}" fill="${track}"/>
    ${pctDKP <= 100 ? `
      <rect x="${x0}" y="${yDKP}" width="${L_dkp.base}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
    ` : `
      <rect x="${x0}" y="${yDKP}" width="${width}" height="${hBar}" rx="${rxy}" fill="${color1}"/>
      <rect x="${x0}" y="${yDKP}" width="${L_dkp.over}" height="${hBar}" rx="${rxy}" fill="${color2}"/>
    `}
    <text x="${x0 + width/2}" y="${yDKP + hBar/2 + 6}" text-anchor="middle" class="m">${pct1(pctDKP)}%</text>

    <!-- DKP numbers & panels -->
    <text x="${x0}" y="${yDKP + 48}" class="m">DKP ${nf(r?.dkp)} / ${nf(r?.goal_dkp)}</text>

    <g transform="translate(${x0}, ${yDKP + 72})">
      <rect x="-12" y="18" width="460" height="50" rx="10" fill="${track}"/>
      <text x="0" y="10" class="s">LEFT</text>
      <text x="0" y="48" class="m">KP ${nf(kpLeft)} • Dead ${nf(deadLeft)}</text>
    </g>
    <g transform="translate(${x0+500}, ${yDKP + 72})">
      <rect x="-12" y="18" width="360" height="50" rx="10" fill="${track}"/>
      <text x="0" y="10" class="s">Δ FROM START</text>
      <text x="0" y="48" class="m">KP ${nf(r?.d_kp)} • Dead ${nf(r?.d_dead)}</text>
    </g>
  </g>
</svg>`;
}

async function renderStripeCard(r, latest, deltas) {
  const svg = stripeCardSVG(r, latest, deltas);
  return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/* ─────────────────────── PNG leaderboard (KvK top) ─────────────────────── */
// рендеримо PNG-лідборд з 1 смугою DKP на рядок
function hashTopRows(rows){
  const s = rows.map(r => `${r.player_id}:${r.dkp}:${r.goal_dkp}:${r.pct}`).join("|");
  return createHash("md5").update(s).digest("hex").slice(0,12);
}

// ── KvK Top: SVG генератор
function kvkTopSVG(rows, meta = {}) {
  // базові кольори та розміри (узгоджені з карткою)
  const W = 1100, H = 120 + rows.length * 56 + 40;    // висота від кількості рядків
  const panel = "#0f1218", card = "#121722", grid = "#1e2633", text = "#e6edf7", sub = "#a9b4c6";
  const track = "#2b3342", color1 = "#7c4dff";         // фіолет для прогрес-бару

  const marginX = 40;
  const listLeft = marginX + 12;                       // номер + ім’я
  const barLeft  = 200;                                // старт X смужок
  const barWidth = W - barLeft - 80;                   // ширина смужок
  const padRight = 46;                                 // відступ справа, щоб % не накладався
  const hBar = 14;                                     // тонша смужка
  const rxy  = 7;
  const rowGap = 56;                                   // вертикальний крок між рядками
  const yStart = 120;

  const title = meta.title ?? `KvK Top ${rows.length}`;
  const sublineL = `Active: ${meta.active ?? "?"}`;
  const sublineR = `Updated: ${meta.updated ?? "-"}`;

  let lines = "";

  rows.forEach((r, i) => {
    const y = yStart + i * rowGap;
    const pct = Math.max(0, Number(r.pct) || 0);                 // фактичний %
    const pctClamped = Math.min(100, pct);                       // малюємо до 100, решту не показуємо (це ТОП-таблиця)
    const barLen = (barWidth - padRight) * (pctClamped / 100);
    const name = trimName(r.name ?? r.player_id, 26);
    const rank = `${i + 1}.`;
    const dkpText = `${nf(r.dkp || 0)} / ${nf(r.goal_dkp || 0)}`;

    lines += `
      <g>
        <text x="${listLeft - 8}" y="${y - 2}" class="s">${rank}</text>
        <text x="${listLeft + 30}" y="${y - 2}" class="t">${name}</text>

        <rect x="${barLeft}" y="${y - hBar}" width="${barWidth}" height="${hBar}" rx="${rxy}" fill="${track}"/>
        <rect x="${barLeft}" y="${y - hBar}" width="${barLen}" height="${hBar}" rx="${rxy}" fill="${color1}"/>

        <!-- DKP лічильник під смужкою -->
        <text x="${barLeft}" y="${y + 16}" class="m">${dkpText}</text>
        <!-- % справа від смужки, з відступом -->
        <text x="${barLeft + barWidth - padRight/2}" y="${y + 16}" text-anchor="end" class="m">${pct1(pct)}%</text>
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
    <rect x="20" y="20" width="${W-40}" height="${H-40}" rx="22" fill="${card}" stroke="${grid}" stroke-width="1"/>

    <text x="${marginX}" y="70" class="b">${title}</text>
    <text x="${marginX}" y="98" class="s">${sublineL}</text>
    <text x="${W - marginX}" y="98" class="s" text-anchor="end">${sublineR}</text>

    ${lines}
  </g>
</svg>`;
}

// PNG-обгортка
async function renderKvkTopPNG(rows, meta) {
  const svg = kvkTopSVG(rows, meta);
  return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/* ─────────────────────── simple PNG cache ─────────────────────── */
/* Кеш PNG для player і для лідборду */
const imgCache = new Map(); // key -> { buf, t }
function cacheKeyPlayer(pid, r, latest){
  return `p:${pid}:${r?.dkp}|${r?.goal_dkp}|${r?.d_kp}|${r?.d_dead}|${latest?.updated_at ?? ""}`;
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
    // просте LRU-ish: видаляємо найстаріший
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

async function getKvkBundle(playerIdBigInt, latest){
  // KvK progress (DKP + goals)
  let r = await kvkProgress(playerIdBigInt).catch(()=>null);
  if (!r) r = { pct: 0, dkp: 0, goal_dkp: 0, d_kp: 0, d_dead: 0, goal_kp: 0, goal_dead: 0 };

  // KvK start snapshot → дельти під метриками
  let start = await fetchKvKStart(playerIdBigInt).catch(()=>null);
  const deltas = {
    dPower: start?.start_power != null ? Number(latest.power || 0) - Number(start.start_power || 0) : 0,
    dKP:    start?.start_kp    != null ? Number(latest.kp    || 0) - Number(start.start_kp    || 0) : 0,
    dDead:  start?.start_dead  != null ? Number(latest.dead  || 0) - Number(start.start_dead  || 0) : 0,
    dT5:    start?.start_t5    != null ? Number(latest.t5    || 0) - Number(start.start_t5    || 0) : 0,
    dT4:    start?.start_t4    != null ? Number(latest.t4    || 0) - Number(start.start_t4    || 0) : 0,
  };
  return { r, deltas };
}
// ── KvK Top helpers (UKR коменти)
// обрізати довгі ніки, щоб не з’їдали розмітку
function trimName(s = "", max = 22) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/* ─────────────────────── commands ─────────────────────── */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    const began = Date.now();
    const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
    log.info({ ...baseCtx(msg), cmd, args });

    /* ===== PUBLIC: stats/me/link/unlink/help ===== */

    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) return void msg.reply("Usage: `!stats <player_id>`");

      // тротлінг
      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(idArg);
      if (!latest) return void msg.reply("No data yet. Run the scanner first.");

      const { r, deltas } = await getKvkBundle(BigInt(idArg), latest);

      // кеш PNG
      const key = cacheKeyPlayer(idArg, r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(r, latest, deltas);
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

      const { r, deltas } = await getKvkBundle(BigInt(linked), latest);

      const key = cacheKeyPlayer(linked, r, latest);
      let png = getCached(key);
      if (!png) {
        png = await renderStripeCard(r, latest, deltas);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, { name: "stats.png" });
      await msg.reply({ files: [file] });
      return log.info({ ...baseCtx(msg), cmd, ms: Date.now()-began, ok: true });
    }

    if (cmd === "link") {
      // якщо не вказали @user → беремо автора
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = args[mention === msg.author ? 0 : 1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply("Usage: `!link [@user] <player_id>`");
      }

      // перевіряємо чи існує такий player_id у players
      const { rows } = await pool.query(`SELECT 1 FROM players WHERE id=$1 LIMIT 1`, [idArg]);
      if (!rows.length) {
        return void msg.reply(`Player_id **${idArg}** does not exist. Ask an admin to check scanner.`);
      }

      // не-адмін може лінкувати тільки себе
      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply("You can only link yourself. Ask an admin to link others.");
      }

      await setLink(mention.id, idArg);
      return void msg.reply(`Linked ${mention} ⇄ player_id **${idArg}**.`);
    }

    if (cmd === "unlink") {
      const mention = msg.mentions.users.first() ?? msg.author;

      // звичайний юзер може тільки сам себе
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
      return void msg.reply(HELP_PUBLIC);
    }

    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Admins only.");
      return void msg.reply(HELP_ADMIN);
    }

    /* ===== ADMIN-ONLY (everything else) ===== */
    if (!isAdmin(msg)) {
      return void msg.reply("Admins only. Public commands: `!stats`, `!me`, `!link`, `!unlink`, `!help`.");
    }

    // KvK admin / control
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
        const { rows } = await pool.query(`SELECT kp_weight, dead_to_kp FROM kvk_config WHERE kvk_id=$1`, [id]);
        if (!rows[0]) return void msg.reply("No weights found for the active period.");
        const { kp_weight, dead_to_kp } = rows[0];
        return void msg.reply(`Current weights → KP: **${kp_weight}**, Dead: **${dead_to_kp}**`);
      }
      const which = (args[1] || "").toLowerCase();
      const val = Number(args[2]);
      if (!["dead", "kp"].includes(which) || !Number.isFinite(val)) {
        return void msg.reply("Usage: `!kvk weight <dead|kp> <value>` or `!kvk weight show`");
      }
      await kvkSetWeight(which, val);
      return void msg.reply(`Weight **${which}** set to **${val}**.`);
    }

    if (cmd === "kvk" && (args[0] === "ensure" || args[0] === "setgoal")) {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Usage: `!kvk ensure <player_id>`");
      const g = await kvkEnsureGoal(pid);
      if (!g) return void msg.reply("Goal already exists, or no active period/latest.");
      return void msg.reply(`Goal for **${pid}** → KP ${nf(g.goal_kp)} • Dead ${nf(g.goal_dead)} • DKP ${nf(g.goal_dkp)}`);
    }

    if (cmd === "kvk" && args[0] === "ensure_all") {
      const { rows } = await pool.query(`SELECT player_id FROM latest WHERE player_id IS NOT NULL`);
      let made = 0, skipped = 0;
      for (const r of rows) {
        try {
          const out = await kvkEnsureGoal(BigInt(r.player_id));
          if (out) made++; else skipped++;
          await new Promise(res => setTimeout(res, 8)); // легкий backoff
        } catch { skipped++; }
      }
      return void msg.reply(`Goals ensured: **${made}** (skipped: ${skipped}).`);
    }

    if (cmd === "kvk" && args[0] === "stats") {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Usage: `!kvk stats <player_id>`");
      const r = await kvkProgress(pid);
      if (!r) return void msg.reply("No goal/start or no latest for this player.");
      return void msg.reply(
        `DKP ${nf(r.dkp)}/${nf(r.goal_dkp)} (${pct1(r.pct)}%) • ΔKP ${nf(r.d_kp)} • ΔDead ${nf(r.d_dead)} • goals: KP ${nf(r.goal_kp)} Dead ${nf(r.goal_dead)}`
      );
    }

    if (cmd === "kvk" && args[0] === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;
      const r = await kvkProgress(BigInt(linked));
      if (!r) return void msg.reply("No goal/start or no latest for your player_id.");
      return void msg.reply(
        `DKP ${nf(r.dkp)}/${nf(r.goal_dkp)} (${pct1(r.pct)}%) • ΔKP ${nf(r.d_kp)} • ΔDead ${nf(r.d_dead)} • goals: KP ${nf(r.goal_kp)} Dead ${nf(r.goal_dead)}`
      );
    }

    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const asText = (args[2] || "").toLowerCase() === "text";
      const rows = await kvkTop(limit);
      if (!rows.length) return void msg.reply("Empty.");

      if (asText) {
        const lines = rows.map((r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${pct1(r.pct)}% (DKP ${nf(r.dkp)}/${nf(r.goal_dkp)})`
        );
        return void msg.reply(lines.join("\n"));
      }

      // графічний рендер
      const meta = {
        title: `KvK Top ${rows.length}`,
        active: (await kvkActiveId()) ?? "–",
        updated: new Date().toLocaleString(),
      };

      const key = `kvktop:${limit}:${meta.active}:${rows.map(r => r.player_id+":"+r.dkp+":"+r.goal_dkp).join("|")}`;
      let png = getCached(key);
      if (!png) {
        png = await renderKvkTopPNG(rows, meta); // ⬅️ тут нова функція з тоншими полосками
        setCached(key, png);
      }
      const file = new AttachmentBuilder(png, { name: "kvk_top.png" });
      return void msg.reply({ files: [file] });
    }

    if (cmd === "top") {
      const by = (args[0] || "kp").toLowerCase();
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const rows = await fetchTop(by, limit);
      if (!rows.length) return void msg.reply("Empty. Run the scanner first.");
      const lines = rows.map((r, i) => `**${i + 1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(r.metric)}**`);
      return void msg.reply(lines.join("\n"));
    }

    return void msg.reply("Admins only. Public commands: `!stats`, `!me`, `!link`, `!unlink`, `!help`.");
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