// src/bot.js
//
// Discord bot for KvK stats:
// - imports KvK sessions/goals
// - player stats commands (!stats / !me)
// - leaderboards (!top / !topkills)
// - link/unlink and farm approvals
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



// healthcheck server
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
  })
  .listen(PORT, () => {
    console.log("healthcheck server on :" + PORT);
  });



// config
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

// logging
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };




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

// helpers
function channelAllowed(msg) {
  if (!PUBLIC_CHANNEL_ID) return true;
  if (!msg.guild) return true;
  const channelId = msg.channel?.id;
  return channelId === PUBLIC_CHANNEL_ID || channelId === ADMIN_CHANNEL_ID;
}

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
  const bg          = "#0d121d";
  const panelBg     = "#2a3142";
  const fillPrimary = "#6b7bff"; // 0..100%
  const fillOver    = "#4deeea"; // 100..200%
  const textCol     = "#ffffff";
  const subCol      = "#9da5bd";
  const goodCol     = "#6ee7a8";
  const badCol      = "#ef5350";
  const zeroCol     = "#7b8193";
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
  const numBars = 1;
  const farmsStartY = barsStartY + (barGapY * numBars) + 40;
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
  function renderDelta(valRaw) {
    const v = Number(valRaw) || 0;
    if (v === 0) {
      return { text: "T-0", fill: zeroCol };
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
  const showDeadMetric = player.role === "farm";
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
  const badgePct = Number(progress.pct || 0);
  const badgeTag =
    badgePct >= 200 ? "WHALE KILLER" :
    badgePct >= 120 ? "AHEAD" :
    badgePct >= 100 ? "ON TRACK" :
    badgePct >=  70 ? "KEEP PUSHING" :
                      "WARM UP";
  let barsSvg = "";
  if (player.role === "farm") {
    barsSvg = makeBar("Dead", progress.deadDone, goals.dead, 0);
  } else {
    barsSvg = makeBar("Kills (T4+T5)", progress.killsDone, goals.kills, 0);
  }

  // LEFT TO GO
  const leftToGoText = (player.role === "farm")
    ? `Dead ${nfNum(progress.deadLeft)}`
    : `Kills ${nfNum(progress.killsLeft)}`;

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
    bottomYBase = farmsStartY + farmCount * barGapY + 40;
  }
  h = Math.max(h, bottomYBase + leftBoxH + 60);
  const hasLastFightData =
    lastFight &&
    lastFight.zoneName &&
    ((lastFight.killsT45 || 0) > 0 || (lastFight.dead || 0) > 0);
  const lastFightText = player.role === "farm"
    ? `Dead ${nfNum(lastFight.dead)}`
    : `Kills ${nfNum(lastFight.killsT45)}`;

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
          ${safe(lastFightText)}
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

  <!-- TT-T -TT -->
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
    <g transform="translate(${metricBlockGapX*2},0)" opacity="${showDeadMetric ? 1 : 0}">
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

  <!-- T-TT--- -->
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


function hashTopRows(rows) {
  const s = rows
    .map((r) => `${r.player_id}:${r.killsDone}:${r.goal_kills}:${r.pct}`)
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
  const isKillsView = meta.sortBy === "kills";
  const pctNoRound = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "0";
    const t = Math.trunc(n * 10) / 10;
    return t.toLocaleString("en-US", { maximumFractionDigits: 1 });
  };

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
    const capped = Math.max(0, Math.min(raw, 200)); //  
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
    const killsDone = Number(r.killsDone) || 0;
    const goalKills = Number(r.goal_kills) || 0;
    const pctRaw = isKillsView
      ? (goalKills > 0 ? (killsDone / goalKills) * 100 : 0)
      : (Number(r.pct) || 0);
    const { wBase, wOver } = barPieces(pctRaw);

    const playerName = (r.name && r.name.trim())
      ? r.name.trim()
      : String(r.player_id);

    const safeName = playerName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const visDkpGoal = 10000;
    const visDkpDone = Math.round(((Number(r.pct) || 0) / 100) * visDkpGoal);

    const bottomLeftText = isKillsView
      ? `Kills ${nfNum(killsDone)} / ${nfNum(goalKills)}`
      : `${nfNum(visDkpDone)} / ${nfNum(visDkpGoal)}`;
    const bottomRightText = isKillsView
      ? `${pctNoRound(pctRaw)}%`
      : `${Math.round(pctRaw)}%`;
    const rankText = `${idx + 1}.`;

    lines += `
      <g>
        <!--  -->
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

        <!-- ' -->
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

        <!--  - -->
        <rect
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16}"
          width="${barW}"
          height="${barH}"
          rx="4"
          fill="${trackCol}"
        />

        <!--   0..100% -->
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

        <!--  100..200% -->
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

        <!-- DKP   -->
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

        <!-- %  -->
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

    <!--  -->
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



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});



async function getLinkedPlayerIdOrReply(msg) {
  const linked = await fetchLink(msg.author.id);
  if (!linked) {
    await msg.reply('Link your account first: `!link <player_id>` - Link your Discord to your player_id.');
    return null;
  }
  return linked;
}

function parsePlayerId(arg) {
  if (!arg || !/^\d+$/.test(arg)) return null;
  try {
    return BigInt(arg); //      
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
      .setLabel("Approve"),
    new ButtonBuilder()
      .setCustomId(`farmreject:${reqId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel("Reject")
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



client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;
    if (!channelAllowed(msg)) {
      const publicMention = PUBLIC_CHANNEL_ID
        ? `<#${PUBLIC_CHANNEL_ID}>`
        : "the allowed channel";
      return void msg.reply(`Please use bot commands in ${publicMention}.`);
    }

    const began = Date.now();
    const [cmdRaw, ...args] = msg.content.slice(1).trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase();

    log.info({ ...baseCtx(msg), cmd, args });

    

    // !help
    if (cmd === "help") {
      const HELP_PUBLIC = [
        "**Public commands:**",
        "`!stats <player_id>` - Player card (kills for main, dead for farm, farms, zone).",
        "`!me` - Your card (after `!link`).",
        "`!link <player_id>` - Link your Discord to your player_id.",
        "`!unlink` - Unlink yourself.",
        "`!farm <farm_id>` - Attach a farm (after `!link`).",
        "`!help` - This help.",
      ].join("\n");
      return void msg.reply(HELP_PUBLIC);
    }

    // !stats <player_id>
    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply(
          "Usage: `!stats <player_id>`"
        );
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
    if (cmd === "link") {
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = mention === msg.author ? args[0] : args[1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply(
          "Usage: `!link <player_id>` - Link your Discord to your player_id."
        );
      }
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
        `Linked ${mention} -> player_id **${idArg}**.`
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
        `Unlinked ${mention} -> player_id **${playerId}**.`
      );
    }

    // !farm <farm_player_id>
    if (cmd === "farm") {
      if (args.length === 1) {
        const farmIdArg = args[0];
        if (!farmIdArg || !/^\d+$/.test(farmIdArg)) {
          return void msg.reply(
            "Usage: `!farm <farm_id>` - Attach a farm (after `!link`)."
          );
        }
        const mainId = await fetchLink(msg.author.id);
        if (!mainId) {
          return void msg.reply("You must `!link <your_main_id>` first before adding a farm.");
        }
        const mainSnap = await fetchPlayerSnapshot(mainId);
        if (!mainSnap) {
          return void msg.reply("Your linked main is not in DB yet. Ask admin to import you first.");
        }

        const farmSnap = await fetchPlayerSnapshot(farmIdArg);
        if (!farmSnap) {
          return void msg.reply(`Farm player_id **${farmIdArg}** not found in DB.`);
        }
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
      if (args.length === 2) {
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
            msg.author.id //   
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
      return void msg.reply(
        "Usage:\n- Player: `!farm <farm_id>` - Attach a farm (after `!link`)."
      );
    }
    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Admins only.");
      const HELP_ADMIN = [
        "**Admin commands:**",
        "`!helpadmin`  this list.",
        "`!kvk start [name]`  start new KvK session (admin channel only).",
        "`!top [N] [text]`  KvK leaderboard (Kills%).",
        "`!topkills [N] [text]`  KvK leaderboard (kills%).",
        "`!link @user <player_id>`  Link mentioned user to player.",
        "`!unlink [@user]`  Unlink mentioned user.",
        "`!backup`  Make backup.",
        "Farm approvals happen via buttons in admin channel.",
      ].join("\n");
      return void msg.reply(HELP_ADMIN);
    }

    

    if (!isAdmin(msg)) {
      return void msg.reply(
        "Admins only. Public commands are: `!stats`, `!me`, `!link`, `!unlink`, `!farm`, `!help`."
      );
    }
    if (cmd === "top") {
      const argOffset = 0;
      const limit = Math.min(
        Math.max(parseInt(args[argOffset] || "10", 10) || 10, 1),
        50
      );
      const asText = (args[argOffset + 1] || "").toLowerCase() === "text";

      const rows = await buildTopListData(limit);
      if (!rows.length) {
        return void msg.reply(
          "Empty. (Maybe no goals / no active KvK?)"
        );
      }

      if (asText) {
        const lines = rows.map((r, i) => {
          const killsPct = pct1NoRound(r.pct);
          return `**${i + 1}.** ${r.name ?? r.player_id} - ${killsPct}% (Kills ${nf(r.killsDone)}/${nf(r.goal_kills)})`;
        });
        return void msg.reply(lines.join("\n"));
      }
      const ts = await fetchMaxUpdateFor(
        rows.map((r) => r.player_id).filter(Boolean)
      );
      const meta = {
        title: `KvK Top ${rows.length} by Kills`,
        updated: formatTs(ts),
        sortBy: "kills",
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

    // ===== NEW: !topKills ${nf(r.killsDone)}/${nf(r.goal_kills)} !top Kills ${nf(r.killsDone)}/${nf(r.goal_kills)} !top k =====
    const isTopKills =
      cmd === "topkills" ||
      (cmd === "top" && (args[0] || "").toLowerCase() === "kills") ||
      (cmd === "top" && (args[0] || "").toLowerCase() === "k");

    if (isTopKills) {
      const argOffset = cmd === "top" ? 1 : 0;

      // ---- limit ----
      const rawLimitArg = args[argOffset];
      const rawLimit = parseInt(rawLimitArg, 10);
      const hasLimit = Number.isFinite(rawLimit);
      const limit = Math.min(Math.max(hasLimit ? rawLimit : 10, 1), 50);
      const rows = await buildTopListData(limit);
      rows.sort((a, b) => b.killsDone - a.killsDone);

      // ---- text mode ----
      const textArgIndex = argOffset + (hasLimit ? 1 : 0);
      const asText = (args[textArgIndex] || "").toLowerCase() === "text";
      if (asText) {
        const lines = rows.map(
          (r, i) =>
            `**${i + 1}.** ${r.name ?? r.player_id}  ${r.killsDone.toLocaleString(
              "en-US"
            )} kills`
        );
        return void msg.reply(lines.join("\n"));
      }

      // ---- meta ----
      const ts = await fetchMaxUpdateFor(
        rows.map((r) => r.player_id).filter(Boolean)
      );

      const meta = {
        title: `Top ${rows.length} by Kills`,
        updated: formatTs(ts),
        sortBy: "kills",
      };

      // ---- cache ----
      const cacheKey =
        `topkills:${limit}:` +
        rows.map((r) => `${r.player_id}:${r.killsDone}`).join("|");

      let png = getCached(cacheKey);
      if (!png) {
        png = await renderKvkTopPNG(rows, meta);
        setCached(cacheKey, png);
      }

      const file = new AttachmentBuilder(png, { name: "topkills.png" });
      await msg.reply({ files: [file] });
      return;
    }

    // !backup
    if (cmd === "backup") {
      if (msg.channel.id !== ADMIN_CHANNEL_ID) {
        return void msg.reply("Run `!backup` in the admin channel.");
      }

      await msg.channel.send(" Creating full backup (Excel + JSON zip)...");
      try {
        const { xlsxPath, zipPath } = await exportFullBackup();

        const files = [];
        try { files.push(new AttachmentBuilder(xlsxPath)); } catch {}
        try { files.push(new AttachmentBuilder(zipPath)); } catch {}

        if (files.length === 0) {
          return void msg.reply(" Backup created, but files could not be attached (too large?). Check the server `/backups` folder.");
        }

        await msg.channel.send({
          content: " Backup ready:",
          files
        });
      } catch (e) {
        console.error("backup error:", e);
        await msg.channel.send(" Backup failed: " + (e?.message || e));
      }
      return;
    }

    // !kvk ...
    if (cmd === "kvk") {
      const sub = (args[0] || "").toLowerCase();

      // !kvk start [name...]
      if (sub === "start") {
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
      return void msg.reply(
        "Usage: `!kvk start [name]`"
      );
    }
    return void msg.reply(
      "Unknown command. See `!help` - This help.
    );
  } catch (e) {
    log.error({ err: String(e?.stack || e), where: "messageCreate" });
    try {
      await msg.reply(" Internal error. Admins were notified.");
    } catch {}
    const targetId = LOG_CHANNEL_ID || ADMIN_CHANNEL_ID || PUBLIC_CHANNEL_ID;
    const ch = client.channels.cache.get(targetId);
    if (ch && typeof ch.isTextBased === "function" && ch.isTextBased()) {
      ch
        .send(
          ` Error for message "${msg.content}": \`${String(
            e?.message || e
          )}\``
        )
        .catch(() => {});
    }
  }
});



client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (interaction.channelId !== ADMIN_CHANNEL_ID) {
      return void interaction.reply({
        content: " Use this in admin channel.",
        ephemeral: true,
      });
    }
    if (!isAdminMember(interaction.member)) {
      return void interaction.reply({
        content: " Admins only.",
        ephemeral: true,
      });
    }

    const cid = interaction.customId || "";
    const approveMatch = cid.match(/^farmapprove:(\d+)$/);
    const rejectMatch  = cid.match(/^farmreject:(\d+)$/);

    if (!approveMatch && !rejectMatch) {
      return void interaction.reply({
        content: " Unknown button.",
        ephemeral: true,
      });
    }

    if (approveMatch) {
      const reqId = approveMatch[1];
      const row = await approveFarmLink(reqId);
      if (!row) {
        return void interaction.reply({
          content: "Already handled.",
          ephemeral: true,
        });
      }
      await markAsFarmAndRecalcGoals(row.farm_player_id);
      const mainBasic = await fetchPlayerBasic(row.owner_player_id);
      const farmBasic = await fetchPlayerBasic(row.farm_player_id);
      const requester = await client.users
        .fetch(row.requested_by_discord_id)
        .catch(() => null);

      if (requester) {
        requester
          .send(
            ` Your farm request was APPROVED.\nMain: ${mainBasic?.name} (${mainBasic?.player_id})\nFarm: ${farmBasic?.name} (${farmBasic?.player_id})`
          )
          .catch(() => {});
      }

      return void interaction.reply({
        content: `Approved  request #${reqId}`,
        ephemeral: true,
      });
    }

    if (rejectMatch) {
      const reqId = rejectMatch[1];
      const row = await rejectFarmLink(reqId);
      if (!row) {
        return void interaction.reply({
          content: "Already handled.",
          ephemeral: true,
        });
      }
      const mainBasic = await fetchPlayerBasic(row.owner_player_id);
      const farmBasic = await fetchPlayerBasic(row.farm_player_id);

      const requester = await client.users
        .fetch(row.requested_by_discord_id)
        .catch(() => null);

      if (requester) {
        requester
          .send(
            ` Your farm request was REJECTED.\nMain: ${mainBasic?.name} (${mainBasic?.player_id})\nFarm: ${farmBasic?.name} (${farmBasic?.player_id})`
          )
          .catch(() => {});
      }

      return void interaction.reply({
        content: `Rejected  request #${reqId}`,
        ephemeral: true,
      });
    }
  } catch (e) {
    console.warn("interactionCreate error:", e?.message || e);
    try {
      await interaction.reply({
        content: " Internal error.",
        ephemeral: true,
      });
    } catch {}
  }
});



client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGQUIT"]) {
  process.on(sig, async () => {
    console.log(`\n${sig}  closing DB pool...`);
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  });
}



if (!process.env.DISCORD_TOKEN || !process.env.DATABASE_URL) {
  console.error(" DISCORD_TOKEN or DATABASE_URL missing in .env");
}

client.login(process.env.DISCORD_TOKEN); 
