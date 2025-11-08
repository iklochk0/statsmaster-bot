// src/bot.js
//
// Discord-бот для KvK.
//
// ЦЯ ВЕРСІЯ:
//  - працює з новою моделлю БД (kvk_sessions / kvk_goals / imports / account_links).
//  - показує картку гравця (!stats / !me)
//  - ранжує (!top  — це колишній !kvk top, DKP%)
//  - !link / !unlink привʼязує Discord користувача до player_id
//  - !farm <mainId> <farmId> -> створює заявку "це моя ферма"
//      -> бот кидає embed + кнопки в ADMIN_CHANNEL_ID
//      -> адмін тисне Approve / Reject
//      -> бот апдейтить account_links, перераховує цілі ферми як farm (dead=600k),
//         і шле DM юзеру
//  - !kvk start [name] можна тільки в адмін-каналі
//
// Канали (з .env):
//   PUBLIC_CHANNEL_ID = #individual-stats (юзери)
//   ADMIN_CHANNEL_ID  = #individual-stats-admin (тільки адміни)
//
// Правила:
//   - звичайні команди можна писати в PUBLIC_CHANNEL_ID
//   - адмінські штуки типу approve farm / !kvk start / !top робимо в ADMIN_CHANNEL_ID
//   - адміни можуть користуватись публічними командами в паблік-каналі
//
// Відсоток на картці = DKP % (50% kills + 50% dead проти їхніх цілей).
//
// DKP_VISUAL_SCALE:
//   внутрішньо DKP це "до 100", але ми хочемо щоб на картинці було щось типу
//   "690,815 / 10,000" повсюди де показується DKP.
//   Тому ми множимо dkpDone і goal_dkp на великий коефіцієнт,
//   чисто для виводу (UI), не для математики.
//
// Кеш: ми кешимо PNG, бо sharp не безкоштовний.
//
// p.s. Усі player_id в PG шлемо як string,
// бо там BIGINT.
//

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import sharp from "sharp";
import { createHash } from "node:crypto";
import http from "http";

import {
  pool,
  initSchema,
  buildStatsCardData,
  buildTopListData,
  fetchPlayerSnapshot,
  fetchMaxUpdateFor,
  fetchPlayerBasic,
  recalcGoalsForRoleChange,
  startKvK,
  createFarmLinkRequest,
  approveFarmLink,
  rejectFarmLink,
} from "./db.pg.js";

import { exportFullBackup } from "./excelExport.js";

/* ───────────────── healthcheck ───────────────── */

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
  })
  .listen(PORT, () => {
    console.log("healthcheck server on :" + PORT);
  });

/* ───────────────── конфіг ───────────────── */

const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOG_CHANNEL_ID    = process.env.LOG_CHANNEL_ID    || "";
const PUBLIC_CHANNEL_ID = process.env.PUBLIC_CHANNEL_ID || "";
const ADMIN_CHANNEL_ID  = process.env.ADMIN_CHANNEL_ID  || "";

const IMG_CACHE_TTL_S = Number(process.env.IMG_CACHE_TTL_S || 60);
const IMG_CACHE_MAX   = Number(process.env.IMG_CACHE_MAX || 120);

const HEAVY_CMD_COOLDOWN_S = Number(process.env.HEAVY_CMD_COOLDOWN_S || 4);

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Наскільки пафосно показувати DKP на картці / в топі.
// 290_000 дає цифри типу "690,815 / 29,000,000" при goal=100 внутрішніх DKP.
const DKP_VISUAL_SCALE = 290_000;

/* ───────────────── логер ───────────────── */

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
  info:  (o) => logAt("info", o),
  warn:  (o) => logAt("warn", o),
  error: (o) => logAt("error", o),
};

/* ───────────────── утиліти форматування ───────────────── */

function formatTs(tsLike) {
  if (!tsLike) return "-";
  const d = new Date(tsLike);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-US", {
    hour12: true,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const nf = (x) =>
  new Intl.NumberFormat("en-US").format(
    Number.isFinite(Number(x)) ? Number(x) : 0
  );

function pct1(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function isAdminMember(member) {
  if (!member) return false;

  // якщо є список ролей з .env
  if (ADMIN_ROLE_IDS.length) {
    // GuildMember (messageCreate)
    if (member.roles?.cache) {
      if (member.roles.cache.some((r) => ADMIN_ROLE_IDS.includes(r.id))) {
        return true;
      }
    }
    // InteractionMember (button interaction) може мати roles як масив айдішок
    if (Array.isArray(member.roles)) {
      if (member.roles.some((id) => ADMIN_ROLE_IDS.includes(id))) {
        return true;
      }
    }
  }

  // fallback: адміністратор перм
  if (member.permissions) {
    try {
      if (
        member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}
function isAdmin(msg) {
  return isAdminMember(msg.member);
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

function channelAllowed(msg) {
  const cid = msg.channel?.id;
  if (!cid) return false;
  if (cid === PUBLIC_CHANNEL_ID) return true;
  if (cid === ADMIN_CHANNEL_ID)  return true;
  return false;
}

/* ───────────────── кеш PNG ───────────────── */

const imgCache = new Map(); // key -> { buf, t }

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

/* ───────────────── discord_links (привʼязка discord ↔ player_id) ───────────────── */

await initSchema();

await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE
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
    [discordId, String(playerId)]
  );
}

async function removeLink(discordId) {
  await pool.query(
    `DELETE FROM discord_links WHERE discord_id=$1`,
    [discordId]
  );
}

/* ───────────────── SVG картка гравця ─────────────────
   playerCardSVG(bundle)
   де bundle = buildStatsCardData(player_id)
*/
function playerCardSVG(bundle) {
  const {
    player,
    zone,
    deltas,
    goals,
    progress,
    lastFight,
    farms,
  } = bundle;

  const safe = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const nfNum = (n) =>
    (n === null || n === undefined)
      ? "0"
      : Number(n).toLocaleString("en-US");

  // Кольори
  const bg          = "#0d121d";
  const panelBg     = "#2a3142";
  const fillPrimary = "#6b7bff"; // 0..100%
  const fillOver    = "#4deeea"; // 100..200%
  const textCol     = "#ffffff";
  const subCol      = "#9da5bd";
  const goodCol     = "#6ee7a8";
  const badCol      = "#ef5350";
  const zeroCol     = "#7b8193";

  // Геометрія
  const w = 1100;
  let h = 760;
  const padX   = 24;
  const padTop = 40;

  const metricsY        = padTop + 70;
  const metricBlockGapX = 200;

  const barW       = w - padX * 2;
  const barH       = 24;
  const barGapY    = 80;
  const barsStartY = metricsY + 100;

  // Скільки барів: main = 3 (Kills, Dead, DKP), farm = 1 (Dead)
  const numBars = (player.role === "farm") ? 1 : 3;

  // Позиція блоку ферм (якщо будуть)
  const farmsStartY = barsStartY + (barGapY * numBars) + 40;

  // Базова Y-позиція для нижніх блоків (LEFT TO GO / LAST FIGHTS)
  let bottomYBase = barsStartY + (barGapY * numBars) + 40;

  const leftBoxW   = 500;
  const leftBoxH   = 70;
  const leftBoxR   = 8;

  // Updated
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

  // дельта-колір
  function renderDelta(valRaw) {
    const v = Number(valRaw) || 0;
    if (v === 0) {
      return { text: "±0", fill: zeroCol };
    }
    if (v > 0) {
      return { text: "+" + nfNum(v), fill: goodCol };
    }
    return { text: "-" + nfNum(Math.abs(v)), fill: badCol };
  }

  const dPower = renderDelta(deltas.power);
  const dKP    = renderDelta(deltas.kp);
  const dDead  = renderDelta(deltas.dead);
  const dT5    = renderDelta(deltas.t5);
  const dT4    = renderDelta(deltas.t4);

  // побудова барів прогресу
  function progressPieces(done, goal, totalW) {
    if (!goal || goal <= 0) {
      return { wBase: 0, wOver: 0, pctRaw: 0 };
    }
    const pctRaw = (done / goal) * 100;
    const pctBase = Math.min(Math.max(pctRaw, 0), 100);
    const pctOver = Math.min(Math.max(pctRaw - 100, 0), 100);

    return {
      wBase: totalW * (pctBase / 100),
      wOver: totalW * (pctOver / 100),
      pctRaw,
    };
  }

  // універсальний рендер одного бара
  function makeBar(labelText, doneVal, goalVal, offsetY) {
    const { wBase, wOver, pctRaw } = progressPieces(doneVal, goalVal, barW);
    return `
      <g transform="translate(0,${offsetY})">
        <text class="barLabel" x="0" y="-8">${safe(labelText)}</text>

        <rect x="0" y="0"
              width="${barW}" height="${barH}" rx="4"
              fill="${panelBg}"/>

        ${
          wBase > 0
            ? `<rect x="0" y="0"
                      width="${wBase.toFixed(1)}"
                      height="${barH}" rx="4"
                      fill="${fillPrimary}"/>`
            : ""
        }

        ${
          wOver > 0
            ? `<rect x="0" y="0"
                      width="${wOver.toFixed(1)}"
                      height="${barH}" rx="4"
                      fill="${fillOver}" opacity="0.9"/>`
            : ""
        }

        <text class="barText"
              x="${barW / 2}"
              y="${barH / 2 + 4}">
          ${Math.round(pctRaw)}%
        </text>

        <text class="barLabel"
              x="0"
              y="${barH + 20}">
          ${nfNum(doneVal)} / ${nfNum(goalVal)}
        </text>
      </g>
    `;
  }

  // Бар для ферми (Dead only)
  function makeFarmBar(farm, offsetY) {
    const { wBase, wOver, pctRaw } = progressPieces(
      farm.deadDone,
      farm.deadGoal,
      barW
    );
    return `
      <g transform="translate(0,${offsetY})">
        <text class="barLabel" x="0" y="-8">
          ${safe(farm.name)} (${safe(farm.player_id)})
        </text>

        <rect x="0" y="0"
              width="${barW}" height="${barH}" rx="4"
              fill="${panelBg}"/>

        ${
          wBase > 0
            ? `<rect x="0" y="0"
                      width="${wBase.toFixed(1)}"
                      height="${barH}" rx="4"
                      fill="${fillPrimary}"/>`
            : ""
        }

        ${
          wOver > 0
            ? `<rect x="0" y="0"
                      width="${wOver.toFixed(1)}"
                      height="${barH}" rx="4"
                      fill="${fillOver}" opacity="0.9"/>`
            : ""
        }

        <text class="barText"
              x="${barW / 2}"
              y="${barH / 2 + 4}">
          ${Math.round(pctRaw)}%
        </text>

        <text class="barLabel"
              x="0"
              y="${barH + 20}">
          Dead ${nfNum(farm.deadDone)} / ${nfNum(farm.deadGoal)}
        </text>
      </g>
    `;
  }

  // бейдж справа зверху (інлайн «автотег» без окремого файлу)
  const badgePct = Number(progress.pct || 0);
  const badgeTag =
    badgePct >= 200 ? "WHALE KILLER" :
    badgePct >= 120 ? "AHEAD" :
    badgePct >= 100 ? "ON TRACK" :
    badgePct >=  70 ? "KEEP PUSHING" :
                      "WARM UP";

  // ==== DKP (10k score view)
  const visDkpGoal = 10000;
  const visDkpDone = Math.round(
    (Number(progress.pct || 0) / 100) * visDkpGoal
  );

  // основні бари
  let barsSvg = "";
  if (player.role === "farm") {
    barsSvg += makeBar(
      "Dead",
      progress.deadDone,
      goals.dead,
      0
    );
  } else {
    barsSvg += makeBar(
      "Kills (T4+T5)",
      progress.killsDone,
      goals.kills,
      0
    );
    barsSvg += makeBar(
      "Dead",
      progress.deadDone,
      goals.dead,
      barGapY
    );
    barsSvg += makeBar(
      "DKP",
      visDkpDone,
      visDkpGoal,
      barGapY * 2
    );
  }

  // LEFT TO GO
  const leftToGoText = (player.role === "farm")
    ? `Dead ${nfNum(progress.deadLeft)}`
    : `Kills ${nfNum(progress.killsLeft)} • Dead ${nfNum(progress.deadLeft)}`;

  // "My Farms"
  let farmsSvg = "";
  const farmCount = (player.role === "main" && farms && Array.isArray(farms.farms))
    ? farms.farms.length
    : 0;

  if (farmCount > 0) {
    let farmBars = "";
    let yOff = 0;
    for (const fm of farms.farms) {
      farmBars += makeFarmBar(fm, yOff);
      yOff += barGapY;
    }

    farmsSvg = `
      <g transform="translate(${padX},${farmsStartY})">
        <text x="0" y="0"
              font-family="Inter, system-ui"
              font-size="14"
              fill="${subCol}"
              font-weight="500">
          My Farms
        </text>

        <g transform="translate(0,24)">
          ${farmBars}
        </g>
      </g>
    `;

    // Якщо є ≥1 ферми — зсуваємо нижні блоки під ферми
    bottomYBase = farmsStartY + farmCount * barGapY + 40;
  }

  // Загальна висота полотна — під нижні блоки (LEFT TO GO / LAST FIGHTS)
  h = Math.max(h, bottomYBase + leftBoxH + 60);

  // LAST FIGHTS BOX (праворуч від LEFT TO GO)
  const hasLastFightData =
    lastFight &&
    lastFight.zoneName &&
    ((lastFight.killsT45 || 0) > 0 || (lastFight.dead || 0) > 0);

  const lastFightBox = hasLastFightData
    ? `
      <g transform="translate(${padX + leftBoxW + 24}, ${bottomYBase})">
        <text x="0" y="0"
              font-family="Inter, system-ui"
              font-size="14"
              fill="${subCol}"
              font-weight="500">
          YOUR LAST FIGHTS AT "${safe(lastFight.zoneName)}" ZONE
        </text>

        <rect x="0" y="16"
              width="${leftBoxW}" height="${leftBoxH}"
              rx="${leftBoxR}"
              fill="${panelBg}"/>

        <text x="16" y="52"
              font-family="Inter, system-ui"
              font-size="18"
              fill="${textCol}"
              font-weight="500">
          Kills ${nfNum(lastFight.killsT45)} • Dead ${nfNum(lastFight.dead)}
        </text>
      </g>
    `
    : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${w}" height="${h}"
     viewBox="0 0 ${w} ${h}"
     style="font-family:Inter,system-ui">

  <rect x="0" y="0" width="${w}" height="${h}" rx="16" fill="${bg}" />

  <style>
    .title {
      fill:${textCol};
      font-size:24px;
      font-weight:600;
      font-family:Inter, system-ui;
    }
    .sub {
      fill:${subCol};
      font-size:14px;
      font-weight:500;
      font-family:Inter, system-ui;
    }
    .metricH {
      fill:${textCol};
      font-size:18px;
      font-weight:600;
      font-family:Inter, system-ui;
    }
    .metricV {
      fill:${textCol};
      font-size:22px;
      font-weight:600;
      font-family:Inter, system-ui;
    }
    .metricD {
      font-size:14px;
      font-weight:500;
      font-family:Inter, system-ui;
    }
    .barLabel {
      fill:${textCol};
      font-size:14px;
      font-weight:500;
      font-family:Inter, system-ui;
    }
    .barText {
      fill:${textCol};
      font-size:14px;
      font-weight:500;
      font-family:Inter, system-ui;
      text-anchor:middle;
    }
  </style>

  <!-- Header -->
  <g transform="translate(${padX},${padTop})">
    <text class="title">
      ${safe(player.name)} (${safe(player.player_id)})
    </text>

    <text y="28" class="sub">
      Updated: ${safe(updatedAtStr)}
    </text>

    <text y="48" class="sub">
      Zone Tag: ${safe(zone?.tag || "-")}
    </text>
  </g>

  <!-- Badge -->
  <g transform="translate(${w - padX - 10},0)" text-anchor="end">
    <text
      fill="${textCol}"
      font-size="40"
      font-weight="600"
      font-family="Inter, system-ui"
      y="${padTop}">
      ${Math.round(badgePct)}%
    </text>
    <text
      y="${padTop + 32}"
      fill="${subCol}"
      font-size="14"
      font-weight="600"
      font-family="Inter, system-ui"
      letter-spacing="0.08em">
      ${safe(badgeTag)}
    </text>
  </g>

  <!-- Верхні метрики -->
  <g transform="translate(${padX},${metricsY})">

    <!-- Power -->
    <g>
      <text class="metricH" x="0" y="0">Power</text>
      <text class="metricV" x="0" y="26">${nfNum(player.power)}</text>
      <text class="metricD" x="0" y="44" fill="${dPower.fill}">
        ${dPower.text}
      </text>
    </g>

    <!-- Kill Points -->
    <g transform="translate(${metricBlockGapX},0)">
      <text class="metricH" x="0" y="0">Kill Points</text>
      <text class="metricV" x="0" y="26">${nfNum(player.kp)}</text>
      <text class="metricD" x="0" y="44" fill="${dKP.fill}">
        ${dKP.text}
      </text>
    </g>

    <!-- Dead -->
    <g transform="translate(${metricBlockGapX*2},0)">
      <text class="metricH" x="0" y="0">Dead</text>
      <text class="metricV" x="0" y="26">${nfNum(player.dead)}</text>
      <text class="metricD" x="0" y="44" fill="${dDead.fill}">
        ${dDead.text}
      </text>
    </g>

    <!-- T5 -->
    <g transform="translate(${metricBlockGapX*3},0)">
      <text class="metricH" x="0" y="0">T5</text>
      <text class="metricV" x="0" y="26">${nfNum(player.t5)}</text>
      <text class="metricD" x="0" y="44" fill="${dT5.fill}">
        ${dT5.text}
      </text>
    </g>

    <!-- T4 -->
    <g transform="translate(${metricBlockGapX*4},0)">
      <text class="metricH" x="0" y="0">T4</text>
      <text class="metricV" x="0" y="26">${nfNum(player.t4)}</text>
      <text class="metricD" x="0" y="44" fill="${dT4.fill}">
        ${dT4.text}
      </text>
    </g>
  </g>

  <!-- Прогрес-блоки -->
  <g transform="translate(${padX},${barsStartY})">
    ${barsSvg}
  </g>

  <!-- LEFT TO GO -->
  <g transform="translate(${padX},${bottomYBase})">
    <text x="0" y="0"
          font-family="Inter, system-ui"
          font-size="14"
          fill="${subCol}"
          font-weight="500">
      LEFT TO GO
    </text>

    <rect x="0" y="16"
          width="${leftBoxW}" height="${leftBoxH}"
          rx="${leftBoxR}"
          fill="${panelBg}"/>

    <text x="16" y="52"
          font-family="Inter, system-ui"
          font-size="18"
          fill="${textCol}"
          font-weight="500">
      ${safe(leftToGoText)}
    </text>
  </g>

  ${lastFightBox}
  ${farmsSvg}

</svg>
`;
}

// SVG -> PNG
async function renderPlayerCardPNG(bundle) {
  const svg = playerCardSVG(bundle);
  const buf = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  return buf;
}

/* ───────────────── KvK TOP SVG (DKP) ─────────────────
   rows = buildTopListData(limit)
*/
function hashTopRows(rows) {
  const s = rows
    .map(
      (r) =>
        `${r.player_id}:${r.dkpDone}:${r.goal_dkp}:${r.pct}`
    )
    .join("|");
  return createHash("md5").update(s).digest("hex").slice(0, 12);
}

function kvkTopSVG(rows, meta = {}) {
  const panelBg     = "#0d121d";
  const cardBg      = "#121722";
  const borderCol   = "#1e2633";
  const textCol     = "#ffffff";
  const subCol      = "#9da5bd";
  const trackCol    = "#2a3142";
  const fillPrimary = "#6b7bff";
  const fillOver    = "#4deeea";

  const W = 1100;
  const outerMargin = 24;

  const cardX = outerMargin;
  const cardY = outerMargin;
  const cardW = W - outerMargin * 2;

  const headerH    = 60;
  const gapAfterH  = 20;
  const rowGap     = 90;
  const bottomPad  = 40;

  const innerPadX  = 32;
  const barW       = cardW - innerPadX * 2 - 40;
  const barH       = 16;

  const listTopY   = cardY + headerH + gapAfterH;
  const cardInnerHeight =
    headerH + gapAfterH + rows.length * rowGap + bottomPad;
  const H = outerMargin * 2 + cardInnerHeight;

  const nfNum = (n) => Number(n ?? 0).toLocaleString("en-US");

  // Updated:
  let updatedAtStr = meta.updated || "";
  if (!updatedAtStr) {
    let latestTs = 0;
    for (const r of rows) {
      if (r.updated_at) {
        const ts = new Date(r.updated_at).getTime();
        if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;
      }
    }
    updatedAtStr = latestTs
      ? new Date(latestTs).toLocaleString("en-US", {
          hour12: true,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "-";
  }

  const title = meta.title ?? `KvK Top ${rows.length}`;

  function barPieces(pctRawNum) {
    const raw = Number(pctRawNum) || 0;
    const capped = Math.max(0, Math.min(raw, 200)); // візуальний ліміт
    const basePct = Math.min(capped, 100);
    const overPct = Math.max(Math.min(capped - 100, 100), 0);
    return {
      pctRaw: raw,
      wBase: (barW * basePct) / 100,
      wOver: (barW * overPct) / 100,
    };
  }

  let lines = "";
  rows.forEach((r, idx) => {
    const yTop = listTopY + idx * rowGap;
    const { pctRaw, wBase, wOver } = barPieces(r.pct);

    const playerName = (r.name && r.name.trim())
      ? r.name.trim()
      : String(r.player_id);

    const safeName = playerName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // ✅ DKP у шкалі 10 000 (узгоджено з playerCardSVG)
    const visDkpGoal = 10000;
    const visDkpDone = Math.round(((Number(r.pct) || 0) / 100) * visDkpGoal);

    const bottomLeftText  = `${nfNum(visDkpDone)} / ${nfNum(visDkpGoal)}`;
    const bottomRightText = `${Math.round(pctRaw)}%`;
    const rankText = `${idx + 1}.`;

    lines += `
      <g>
        <!-- ранг -->
        <text
          x="${cardX + innerPadX}"
          y="${yTop}"
          fill="${textCol}"
          font-family="Inter, system-ui"
          font-size="20"
          font-weight="600"
        >
          ${rankText}
        </text>

        <!-- ім'я -->
        <text
          x="${cardX + innerPadX + 40}"
          y="${yTop}"
          fill="${textCol}"
          font-family="Inter, system-ui"
          font-size="20"
          font-weight="600"
        >
          ${safeName}
        </text>

        <!-- фон прогрес-бару -->
        <rect
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16}"
          width="${barW}"
          height="${barH}"
          rx="4"
          fill="${trackCol}"
        />

        <!-- базовий прогрес 0..100% -->
        ${
          wBase > 0
            ? `<rect
                 x="${cardX + innerPadX + 40}"
                 y="${yTop + 16}"
                 width="${wBase.toFixed(1)}"
                 height="${barH}"
                 rx="4"
                 fill="${fillPrimary}"
               />`
            : ""
        }

        <!-- оверкап 100..200% -->
        ${
          wOver > 0
            ? `<rect
                 x="${cardX + innerPadX + 40}"
                 y="${yTop + 16}"
                 width="${wOver.toFixed(1)}"
                 height="${barH}"
                 rx="4"
                 fill="${fillOver}"
                 opacity="0.9"
               />`
            : ""
        }

        <!-- DKP підпис зліва -->
        <text
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16 + barH + 20}"
          fill="${subCol}"
          font-family="Inter, system-ui"
          font-size="14"
          font-weight="500"
        >
          ${bottomLeftText}
        </text>

        <!-- % справа -->
        <text
          x="${cardX + innerPadX + 40 + barW}"
          y="${yTop + 16 + barH + 20}"
          fill="${subCol}"
          font-family="Inter, system-ui"
          font-size="14"
          font-weight="500"
          text-anchor="end"
        >
          ${bottomRightText}
        </text>
      </g>
    `;
  });

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${W}"
  height="${H}"
  viewBox="0 0 ${W} ${H}"
  style="font-family:Inter,system-ui"
>
  <rect width="${W}" height="${H}" fill="${panelBg}"/>

  <g>
    <rect
      x="${cardX}"
      y="${cardY}"
      width="${cardW}"
      height="${cardInnerHeight}"
      rx="16"
      fill="${cardBg}"
      stroke="${borderCol}"
      stroke-width="1"
    />

    <!-- заголовок -->
    <text
      x="${cardX + innerPadX}"
      y="${cardY + 36}"
      fill="${textCol}"
      font-family="Inter, system-ui"
      font-size="32"
      font-weight="700"
    >
      ${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}
    </text>

    <!-- Updated -->
    <text
      x="${cardX + cardW - innerPadX}"
      y="${cardY + 36}"
      fill="${subCol}"
      font-family="Inter, system-ui"
      font-size="16"
      font-weight="500"
      text-anchor="end"
    >
      Updated: ${updatedAtStr}
    </text>

    ${lines}
  </g>
</svg>`;
}

async function renderKvkTopPNG(rows, meta) {
  const svg = kvkTopSVG(rows, meta);
  return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/* ───────────────── Discord client ───────────────── */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

/* ───────────────── хелпери команд ───────────────── */

async function getLinkedPlayerIdOrReply(msg) {
  const linked = await fetchLink(msg.author.id);
  if (!linked) {
    await msg.reply('Link your account first: `!link <player_id>`');
    return null;
  }
  return linked;
}

function parsePlayerId(arg) {
  if (!arg || !/^\d+$/.test(arg)) return null;
  try {
    return BigInt(arg); // просто валідація що це нормальне число
  } catch {
    return null;
  }
}

async function sendFarmRequestEmbedToAdmins(reqId, mainSnap, farmSnap, requesterDiscordId) {
  const adminCh = await client.channels
    .fetch(ADMIN_CHANNEL_ID)
    .catch(() => null);

  const embed = new EmbedBuilder()
    .setColor(0x6b7bff)
    .setTitle("Farm link request")
    .addFields(
      {
        name: "Main",
        value: `${mainSnap.name} (${mainSnap.player_id})`,
        inline: false,
      },
      {
        name: "Farm",
        value: `${farmSnap.name} (${farmSnap.player_id})`,
        inline: false,
      },
      {
        name: "Requested by",
        value: `<@${requesterDiscordId}>`,
        inline: false,
      }
    )
    .setFooter({ text: `request #${reqId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`farmapprove:${reqId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel("Approve ✅"),
    new ButtonBuilder()
      .setCustomId(`farmreject:${reqId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel("Reject ❌")
  );

  if (
    adminCh &&
    typeof adminCh.isTextBased === "function" &&
    adminCh.isTextBased()
  ) {
    await adminCh.send({
      embeds: [embed],
      components: [row],
    });
    return true;
  }

  return false;
}

// коли адмін натискає Approve -> ми робимо ферму (recalcGoalsForRoleChange(...,'farm'))
async function markAsFarmAndRecalcGoals(farmPlayerId) {
  try {
    await recalcGoalsForRoleChange(String(farmPlayerId), "farm");
  } catch (err) {
    console.warn(
      "recalcGoalsForRoleChange failed:",
      err?.message || err
    );
  }
}

/* ───────────────── messageCreate ───────────────── */

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    // канальний контроль
    if (!channelAllowed(msg)) {
      const publicMention = PUBLIC_CHANNEL_ID
        ? `<#${PUBLIC_CHANNEL_ID}>`
        : "the allowed channel";
      return void msg.reply(
        `⚠️ Please use bot commands in ${publicMention}.`
      );
    }

    const began = Date.now();
    const [cmdRaw, ...args] = msg.content.slice(1).trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase();

    log.info({ ...baseCtx(msg), cmd, args });

    /* ===== публічні команди (user) ===== */

    // !help
    if (cmd === "help") {
      const HELP_PUBLIC = [
        "**Public commands:**",
        "`!stats <player_id>` — Player card (kills T4+T5 / dead / DKP, farms, zone).",
        "`!me` — Your card (after `!link`).",
        "`!link <player_id>` — Link your Discord to your player_id.",
        "`!unlink` — Unlink yourself.",
        "`!farm <farm_id>` — Attach a farm (after `!link`).",
        "`!help` — This help.",
      ].join("\n");
      return void msg.reply(HELP_PUBLIC);
    }

    // !stats <player_id>
    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply("Usage: `!stats <player_id>`");
      }

      const cd = checkCooldown(msg.author.id);
      if (cd) {
        return void msg.reply(`Slow down. Try again in ${cd}s.`);
      }

      const bundle = await buildStatsCardData(idArg);
      if (!bundle) {
        return void msg.reply(
          "No data yet. Ask an admin to import this player."
        );
      }

      const cacheKey = [
        "p",
        idArg,
        bundle.progress.dkpDone,
        bundle.progress.killsDone,
        bundle.progress.deadDone,
        bundle.progress.killsLeft,
        bundle.player.updated_at || "",
      ].join("|");

      let png = getCached(cacheKey);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(cacheKey, png);
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
      if (cd) {
        return void msg.reply(`Slow down. Try again in ${cd}s.`);
      }

      const bundle = await buildStatsCardData(linked);
      if (!bundle) {
        return void msg.reply(
          "No data yet for your player_id."
        );
      }

      const cacheKey = [
        "p",
        linked,
        bundle.progress.dkpDone,
        bundle.progress.killsDone,
        bundle.progress.deadDone,
        bundle.progress.killsLeft,
        bundle.player.updated_at || "",
      ].join("|");

      let png = getCached(cacheKey);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(cacheKey, png);
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

    // !link <player_id> або !link @user <player_id> (адмін може лінкати інших)
    if (cmd === "link") {
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = mention === msg.author ? args[0] : args[1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply(
          "Usage: `!link <player_id>` or `!link @user <player_id>` (admin only for others)"
        );
      }

      // перевіряємо що такий player існує
      const snap = await fetchPlayerSnapshot(idArg);
      if (!snap) {
        return void msg.reply(
          `player_id **${idArg}** is not in the DB yet. Ask an admin to import first.`
        );
      }

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply(
          "You can only link yourself. Linking others requires admin."
        );
      }

      await setLink(mention.id, idArg);
      return void msg.reply(
        `Linked ${mention} ↔ player_id **${idArg}**.`
      );
    }

    // !unlink [@user]
    if (cmd === "unlink") {
      const mention = msg.mentions.users.first() ?? msg.author;

      if (!isAdmin(msg) && mention.id !== msg.author.id) {
        return void msg.reply(
          "You can only unlink yourself. Unlinking others requires admin."
        );
      }

      const playerId = await fetchLink(mention.id);
      if (!playerId) {
        return void msg.reply(`${mention} is not linked.`);
      }

      await removeLink(mention.id);
      return void msg.reply(
        `Unlinked ${mention} ↔ player_id **${playerId}**.`
      );
    }

    // УВАГА: старий публічний !top (KP/Power snapshot) — ВИДАЛЕНО

    // !farm <farm_player_id>
    // юзер просить: "ось це моя ферма"
    if (cmd === "farm") {
      // якщо один аргумент -> юзерський режим
      if (args.length === 1) {
        const farmIdArg = args[0];

        // перевірка формату farm_id
        if (!farmIdArg || !/^\d+$/.test(farmIdArg)) {
          return void msg.reply("Usage: `!farm <farm_id>` after you `!link` your main.");
        }

        // шукаємо його main через fetchLink()
        const mainId = await fetchLink(msg.author.id);
        if (!mainId) {
          return void msg.reply("You must `!link <your_main_id>` first before adding a farm.");
        }

        // фіксуємо що обидва існують у players
        const mainSnap = await fetchPlayerSnapshot(mainId);
        if (!mainSnap) {
          return void msg.reply("Your linked main is not in DB yet. Ask admin to import you first.");
        }

        const farmSnap = await fetchPlayerSnapshot(farmIdArg);
        if (!farmSnap) {
          return void msg.reply(`Farm player_id **${farmIdArg}** not found in DB.`);
        }

        // створити pending-заявку
        let reqRow;
        try {
          reqRow = await createFarmLinkRequest(
            mainId,           // owner_player_id
            farmIdArg,        // farm_player_id
            msg.author.id     // requested_by_discord_id
          );
        } catch (e) {
          return void msg.reply(
            "This farm is already linked or pending another request."
          );
        }

        // надіслати embed з кнопками в адмін-канал
        const posted = await sendFarmRequestEmbedToAdmins(
          reqRow.request_id,
          mainSnap,
          farmSnap,
          msg.author.id
        );

        if (posted) {
          return void msg.reply(
            "Your farm link request was sent to admins for approval."
          );
        } else {
          return void msg.reply(
            "Request saved, but I couldn't post to admin channel. Admins will have to check manually."
          );
        }
      }

      // якщо два аргументи -> адмінський режим
      if (args.length === 2) {
        // тільки адміни можуть тут
        if (!isAdmin(msg)) {
          return void msg.reply("Only admins can do `!farm <main_id> <farm_id>`.");
        }

        const mainIdArg = args[0];
        const farmIdArg = args[1];

        if (!/^\d+$/.test(mainIdArg) || !/^\d+$/.test(farmIdArg)) {
          return void msg.reply("Usage: `!farm <main_id> <farm_id>`");
        }

        const mainSnap = await fetchPlayerSnapshot(mainIdArg);
        if (!mainSnap) {
          return void msg.reply(
            `Main player_id **${mainIdArg}** not found in DB.`
          );
        }

        const farmSnap = await fetchPlayerSnapshot(farmIdArg);
        if (!farmSnap) {
          return void msg.reply(
            `Farm player_id **${farmIdArg}** not found in DB.`
          );
        }

        let reqRow;
        try {
          reqRow = await createFarmLinkRequest(
            mainIdArg,
            farmIdArg,
            msg.author.id // адмін хто подав
          );
        } catch (e) {
          return void msg.reply(
            "This farm is already linked or pending another request."
          );
        }

        const posted = await sendFarmRequestEmbedToAdmins(
          reqRow.request_id,
          mainSnap,
          farmSnap,
          msg.author.id
        );

        if (posted) {
          return void msg.reply(
            "Farm link request created and sent to admins (you)."
          );
        } else {
          return void msg.reply(
            "Request saved, but I couldn't post to admin channel."
          );
        }
      }

      // інакше (0 аргументів або >2)
      return void msg.reply(
        "Usage:\n- Player: `!farm <farm_id>` (your main must be linked with `!link`)\n- Admin: `!farm <main_id> <farm_id>`"
      );
    }


    // !helpadmin (показує тільки адмінам)
    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Admins only.");
      const HELP_ADMIN = [
        "**Admin commands:**",
        "`!helpadmin` — this list.",
        "`!kvk start [name]` — start new KvK session (admin channel only).",
        "`!top [N] [text]` — KvK leaderboard (DKP%).",
        "`!link @user <player_id>` — Link mentioned user to player.",
        "`!unlink [@user]` — Unlink mentioned user.",
        "`!backup` — Make backup.",
        "Farm approvals happen via buttons in admin channel.",
      ].join("\n");
      return void msg.reply(HELP_ADMIN);
    }

    /* ===== далі команди, які вимагають адміна ===== */

    if (!isAdmin(msg)) {
      return void msg.reply(
        "Admins only. Public commands are: `!stats`, `!me`, `!link`, `!unlink`, `!farm`, `!help`."
      );
    }

    // НОВЕ: !top  (DKP leaderboard; це колишній !kvk top)
    if (cmd === "top") {
      const limit = Math.min(
        Math.max(parseInt(args[0] || "10", 10) || 10, 1),
        50
      );
      const asText = (args[1] || "").toLowerCase() === "text";

      const rows = await buildTopListData(limit);
      if (!rows.length) {
        return void msg.reply(
          "Empty. (Maybe no goals / no active KvK?)"
        );
      }

      if (asText) {
        const lines = rows.map((r, i) => {
        const visDkpGoal = 10000;
        const visDkpDone = Math.round(((Number(r.pct) || 0) / 100) * visDkpGoal);
          return `**${i + 1}.** ${r.name ?? r.player_id} — ${pct1(
            r.pct
          )}% (DKP ${nf(visDkpDone)}/${nf(visDkpGoal)})`;
        });
        return void msg.reply(lines.join("\n"));
      }

      // timestamp для header "Updated:"
      const ts = await fetchMaxUpdateFor(
        rows.map((r) => r.player_id).filter(Boolean)
      );
      const meta = {
        title: `KvK Top ${rows.length}`,
        updated: formatTs(ts),
      };

      const cacheKey = `top:${limit}:${hashTopRows(rows)}`;
      let png = getCached(cacheKey);
      if (!png) {
        png = await renderKvkTopPNG(rows, meta);
        setCached(cacheKey, png);
      }

      const file = new AttachmentBuilder(png, {
        name: "kvk_top.png",
      });
      await msg.reply({ files: [file] });
      return;
    }

    // !backup
    if (cmd === "backup") {
      // тільки в адмін-каналі, щоб великі файли не сипались у публічний
      if (msg.channel.id !== ADMIN_CHANNEL_ID) {
        return void msg.reply("Run `!backup` in the admin channel.");
      }

      await msg.channel.send("⏳ Creating full backup (Excel + JSON zip)...");
      try {
        const { xlsxPath, zipPath } = await exportFullBackup();

        const files = [];
        try { files.push(new AttachmentBuilder(xlsxPath)); } catch {}
        try { files.push(new AttachmentBuilder(zipPath)); } catch {}

        if (files.length === 0) {
          return void msg.reply("❌ Backup created, but files could not be attached (too large?). Check the server `/backups` folder.");
        }

        await msg.channel.send({
          content: "✅ Backup ready:",
          files
        });
      } catch (e) {
        console.error("backup error:", e);
        await msg.channel.send("❌ Backup failed: " + (e?.message || e));
      }
      return;
    }

    // !kvk ...
    if (cmd === "kvk") {
      const sub = (args[0] || "").toLowerCase();

      // !kvk start [name...]
      if (sub === "start") {
        // тільки в адмін-каналі
        if (msg.channel.id !== ADMIN_CHANNEL_ID) {
          return void msg.reply(
            "Run `!kvk start` in the admin channel."
          );
        }

        const name = args.slice(1).join(" ").trim() || null;
        const kvk_id = await startKvK(name);

        return void msg.reply(
          `Started KvK #${kvk_id}${name ? ` (${name})` : ""}.`
        );
      }

      // (колишній `!kvk top` — видалено)
      return void msg.reply(
        "Usage: `!kvk start [name]`"
      );
    }

    // якщо команда не впізнана
    return void msg.reply(
      "Unknown command. See `!help` or `!helpadmin`."
    );
  } catch (e) {
    log.error({ err: String(e?.stack || e), where: "messageCreate" });
    try {
      await msg.reply("⚠️ Internal error. Admins were notified.");
    } catch {}

    // залогати в LOG_CHANNEL_ID
    const targetId = LOG_CHANNEL_ID || ADMIN_CHANNEL_ID || PUBLIC_CHANNEL_ID;
    const ch = client.channels.cache.get(targetId);
    if (ch && typeof ch.isTextBased === "function" && ch.isTextBased()) {
      ch
        .send(
          `⚠️ Error for message "${msg.content}": \`${String(
            e?.message || e
          )}\``
        )
        .catch(() => {});
    }
  }
});

/* ───────────────── interactionCreate (кнопки Approve / Reject ферми) ───────────────── */

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    // безпека: тільки в адмін-каналі і тільки адміни можуть жати
    if (interaction.channelId !== ADMIN_CHANNEL_ID) {
      return void interaction.reply({
        content: "❌ Use this in admin channel.",
        ephemeral: true,
      });
    }
    if (!isAdminMember(interaction.member)) {
      return void interaction.reply({
        content: "❌ Admins only.",
        ephemeral: true,
      });
    }

    const cid = interaction.customId || "";
    const approveMatch = cid.match(/^farmapprove:(\d+)$/);
    const rejectMatch  = cid.match(/^farmreject:(\d+)$/);

    if (!approveMatch && !rejectMatch) {
      return void interaction.reply({
        content: "❔ Unknown button.",
        ephemeral: true,
      });
    }

    if (approveMatch) {
      const reqId = approveMatch[1];

      // оновлюємо статус у БД → approved
      const row = await approveFarmLink(reqId);
      if (!row) {
        return void interaction.reply({
          content: "Already handled.",
          ephemeral: true,
        });
      }

      // зробити ферму фермою (цілі = farm)
      await markAsFarmAndRecalcGoals(row.farm_player_id);

      // зібрати дані для DM
      const mainBasic = await fetchPlayerBasic(row.owner_player_id);
      const farmBasic = await fetchPlayerBasic(row.farm_player_id);

      // DM тому хто запросив
      const requester = await client.users
        .fetch(row.requested_by_discord_id)
        .catch(() => null);

      if (requester) {
        requester
          .send(
            `✅ Your farm request was APPROVED.\nMain: ${mainBasic?.name} (${mainBasic?.player_id})\nFarm: ${farmBasic?.name} (${farmBasic?.player_id})`
          )
          .catch(() => {});
      }

      return void interaction.reply({
        content: `Approved ✅ request #${reqId}`,
        ephemeral: true,
      });
    }

    if (rejectMatch) {
      const reqId = rejectMatch[1];

      // оновлюємо статус у БД → rejected
      const row = await rejectFarmLink(reqId);
      if (!row) {
        return void interaction.reply({
          content: "Already handled.",
          ephemeral: true,
        });
      }

      // DM тому хто запросив
      const mainBasic = await fetchPlayerBasic(row.owner_player_id);
      const farmBasic = await fetchPlayerBasic(row.farm_player_id);

      const requester = await client.users
        .fetch(row.requested_by_discord_id)
        .catch(() => null);

      if (requester) {
        requester
          .send(
            `❌ Your farm request was REJECTED.\nMain: ${mainBasic?.name} (${mainBasic?.player_id})\nFarm: ${farmBasic?.name} (${farmBasic?.player_id})`
          )
          .catch(() => {});
      }

      return void interaction.reply({
        content: `Rejected ❌ request #${reqId}`,
        ephemeral: true,
      });
    }
  } catch (e) {
    console.warn("interactionCreate error:", e?.message || e);
    try {
      await interaction.reply({
        content: "⚠️ Internal error.",
        ephemeral: true,
      });
    } catch {}
  }
});

/* ───────────────── lifecycle ───────────────── */

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// акуратно закриваємо PG pool при виході
for (const sig of ["SIGINT", "SIGTERM", "SIGQUIT"]) {
  process.on(sig, async () => {
    console.log(`\n${sig} → closing DB pool...`);
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  });
}

/* ───────────────── запуск ───────────────── */

if (!process.env.DISCORD_TOKEN || !process.env.DATABASE_URL) {
  console.error("❌ DISCORD_TOKEN or DATABASE_URL missing in .env");
}

client.login(process.env.DISCORD_TOKEN); 