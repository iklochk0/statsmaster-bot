// src/bot.js
//
// Бот для KvK трекінгу.
//
// Головна логіка:
//  - "Kill Points" (kp) просто показуємо зверху як красиве число з профілю.
//  - Реальний KvK-прогрес — це приріст T4+T5 kills ("killsDone") і Dead ("deadDone")
//    з усіх ЗАВЕРШЕНИХ зон.
//  - Цілі в БД: goal_kills / goal_dead / goal_dkp
//    (наразі goal_kills ще зберігається в колонці goal_kp, ми читаємо її як kills).
//  - DKP = kills_weight * killsDone(T4+T5) + dead_to_kills * deadDone.
//  - Відсоток, бейдж WARM UP / ON TRACK / OVERCAP і т.д. — відсоток DKP до goal_dkp.
//
// Картка гравця показує:
//   • Power / Kill Points / Dead / T5 / T4 (останній зліпок із latest)
//   • Під кожним з цих чисел — Δ з початку боїв (сумарно по всіх завершених зонах):
//       зеленим, якщо + (або 0), червоним, якщо мінус
//     Δ для Kill Points = наскільки виросли kill points
//     Δ для T4/T5/Dead = скільки реально зробив / втратив
//   • Прогрес-бари проти goal: Kills(T4+T5), Dead, DKP
//   • LEFT TO GO = скільки залишилось добити до goal
//   • YOUR LAST FIGHTS AT "<ZONE>" ZONE = скільки він зробив в останній завершеній зоні
//   • Updated: показує час останнього СКАНУ (latest.updated_at), а не час виклику команди
//
// KvK Top PNG:
//   • Топ по % виконання goal_dkp
//   • Updated: беремо MAX(updated_at) серед гравців у топі
//
// УВАГА ПРО ТИПИ:
// node-postgres (`pg`) не любить JS BigInt у параметрах запиту.
// Тому ВСІ айдішки, які ми кидаємо в pool.query, ми перетворюємо на String(...).
//
// Тексти для користувача / картинок — англ.
// Коментарі в коді — укр.
//
// Публічні команди: !stats <id>, !me, !link, !unlink, !help
// Адмінські команди: !kvk ..., !top ...
//

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
import http from "http";

import {
  initSchema,
  kvkStart,
  kvkSetWeight,
  kvkEnsureGoal,
  kvkTop,
  kvkActiveId,
  listZones,
  getZone,
  fetchStatsByRun, // Map(player_id -> row) для вказаного run_id
} from "./db.pg.js";

/* ───────────────── healthcheck — корисно для хостингу ───────────────── */

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

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

const IMG_CACHE_TTL_S = Number(process.env.IMG_CACHE_TTL_S || 60);
const IMG_CACHE_MAX = Number(process.env.IMG_CACHE_MAX || 120);

const HEAVY_CMD_COOLDOWN_S = Number(process.env.HEAVY_CMD_COOLDOWN_S || 4);

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

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
  info: (o) => logAt("info", o),
  warn: (o) => logAt("warn", o),
  error: (o) => logAt("error", o),
};

/* ───────────────── хелпери форматування ───────────────── */

function formatTs(tsLike) {
  // повертаємо час останнього скану з БД, не "зараз"
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

// підрізання імен у топі
function trimName(s = "", max = 22) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// бейдж зверху справа по DKP %
function autoTag(pct) {
  const v = Number(pct) || 0;
  if (v >= 170) return "WHALE KILLER";
  if (v >= 140) return "OVERDRIVE";
  if (v >= 110) return "OVERCAP";
  if (v >= 90) return "ON TRACK";
  return "WARM UP";
}

// красивий текст для +123,456 і колір (зелений/червоний)
function deltaPieces(v, nfFn) {
  const n = Number(v || 0);
  const sign = n >= 0 ? "+" : "-";
  const absVal = Math.abs(n);
  const color = n >= 0 ? "#5CFF5C" : "#FF5C5C";
  return {
    text: `${sign}${nfFn(absVal)}`,
    color,
  };
}

/* ───────────────── Пул до Postgres ───────────────── */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// гарантуємо що схема є
await initSchema();

// таблиця зв'язку discord_id -> player_id
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
  await pool.query(`DELETE FROM discord_links WHERE discord_id=$1`, [
    discordId,
  ]);
}

// останній зліпок гравця з таблиці latest
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
// by = "kp" (kill points total) або "power"
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

// час останнього скану серед конкретних гравців
async function fetchMaxUpdatedAtForPlayers(playerIds) {
  if (!playerIds.length) return null;
  const cleanIds = playerIds.map((x) => String(x));
  const { rows } = await pool.query(
    `SELECT MAX(updated_at) AS ts
       FROM latest
      WHERE player_id = ANY($1::bigint[])`,
    [cleanIds]
  );
  return rows[0]?.ts || null;
}

/* ───────────────── Логіка зон: бойові дельти ─────────────────
   Ідея:
   - беремо всі зони, які ЗАВЕРШЕНІ (тобто zone_scans.end_run_id не NULL)
   - для кожної зони порівнюємо статику гравця на start_run_id і end_run_id
   - рахуємо дельту:
       dPower, dKp (kill points), dKills (T4+T5 приріст), dDead, dT4, dT5
   - складаємо суму
*/

// <--- заміни свою версію computeZoneSumForPlayer на цю
async function computeZoneSumForPlayer(playerId) {
  const zones = await listZones();
  const finishedZones = zones.filter(z => z.end_run_id != null);

  // сума по всіх завершених зонах:
  // dPower  = зміна сили (МОЖЕ бути і мінус, і плюс, ми не клампимо)
  // dKP     = приріст Kill Points (тільки якщо +)
  // dKills  = приріст T4+T5 (тільки якщо +)
  // dDead   = приріст Dead (тільки якщо +)
  // dT4/dT5 = приріст сирих лічильників (тільки якщо +)
  let dPower = 0;
  let dKP    = 0;
  let dKills = 0;
  let dDead  = 0;
  let dT4    = 0;
  let dT5    = 0;

  // кеш run_id -> Map(player_id -> row)
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
    const endRunId   = Number(z.end_run_id);
    if (!Number.isFinite(startRunId) || !Number.isFinite(endRunId)) continue;

    const startMap = await getRunMap(startRunId);
    const endMap   = await getRunMap(endRunId);

    const s = startMap.get(String(playerId));
    const e = endMap.get(String(playerId));
    if (!s || !e) continue;

    // 1. Power: дозволяємо від'ємне
    {
      const diffPow = Number(e.power || 0) - Number(s.power || 0);
      // тут БЕЗ Math.max, ми хочемо бачити -33,560 червоним
      dPower += diffPow;
    }

    // 2. KP (Kill Points total): тільки позитив (не лякаємо користувача "мінусом" через OCR)
    {
      const diffKP = Number(e.kp || 0) - Number(s.kp || 0);
      if (diffKP > 0) dKP += diffKP;
    }

    // 3. Dead: тільки позитив (dead в грі не падає, якщо "впало" то це шум)
    {
      const diffDead = Number(e.dead || 0) - Number(s.dead || 0);
      if (diffDead > 0) dDead += diffDead;
    }

    // 4. Tier kills
    {
      const diffT4 = Number(e.t4 || 0) - Number(s.t4 || 0);
      if (diffT4 > 0) dT4 += diffT4;

      const diffT5 = Number(e.t5 || 0) - Number(s.t5 || 0);
      if (diffT5 > 0) dT5 += diffT5;

      // приріст T4+T5 = наш бойовий внесок у "Kills"
      const startT45 = Number(s.t4 || 0) + Number(s.t5 || 0);
      const endT45   = Number(e.t4 || 0) + Number(e.t5 || 0);
      const diffT45  = endT45 - startT45;
      if (diffT45 > 0) {
        dKills += diffT45;
      }
    }
  }

  return {
    dPower, // може бути від'ємним
    dKP,    // завжди >=0
    dKills, // >=0
    dDead,  // >=0
    dT4,    // >=0
    dT5,    // >=0
  };
}

// дельта тільки по останній завершеній зоні
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

  const startT45 = Number(s.t4 || 0) + Number(s.t5 || 0);
  const endT45 = Number(e.t4 || 0) + Number(e.t5 || 0);
  const diffT45 = Math.max(0, endT45 - startT45);

  const diffDead = Math.max(
    0,
    Number(e.dead || 0) - Number(s.dead || 0)
  );

  return {
    zoneName: String(last.zone_name ?? "Zone"),
    dKillsZone: diffT45,
    dDeadZone: diffDead,
  };
}

/* ───────────────── Формування "bundle" для картки ─────────────────
   buildZoneBasedKvkBundle():
   - тягне активний KvK і цілі з kvk_goals
   - тягне ваги DKP
   - рахує сумарні бойові дельти по завершених зонах
   - рахує DKP, прогрес, відсоток і бейдж
   - вертає все потрібне для SVG картки

   ВАЖЛИВО: тут ми більше НЕ передаємо BigInt прямо в pool.query.
   Ми конвертим айдішки в String(...) перед тим як сунути їх у SQL.
*/
// Формує дані для картки гравця.
// playerIdInput може бути string або BigInt, ми все одно кастимо в String()
// щоб не ламати pg (pg не любить сирий BigInt у параметрах).
async function buildZoneBasedKvkBundle(playerIdInput, latest) {
  // гарантовано рядки перед SQL
  const pidStr = String(playerIdInput);

  // ID активного KvK (або null)
  const activeIdRaw = await kvkActiveId();
  const activeId = activeIdRaw == null ? null : String(activeIdRaw);

  // дефолти якщо для гравця ще нема goals
  let goalKills = 0;
  let goalDead  = 0;
  let goalDKP   = 0;

  // дефолтні ваги (про всяк)
  let cfg = { kills_weight: 1.0, dead_to_kills: 5.0 };

  if (activeId) {
    // 1) тягнемо goals для цього гравця
    //    ТУТ МИ ВЖЕ ВИКОРИСТОВУЄМО goal_kills (ПРАВИЛЬНА КОЛОНКА),
    //    а не goal_kp (якого нема)
    const { rows: gRows } = await pool.query(
      `SELECT goal_kills, goal_dead, goal_dkp
         FROM kvk_goals
        WHERE kvk_id=$1 AND player_id=$2`,
      [activeId, pidStr]
    );

    if (gRows[0]) {
      goalKills = Number(gRows[0].goal_kills || 0); // скільки Т4+Т5 треба набити
      goalDead  = Number(gRows[0].goal_dead  || 0); // скільки треба злити
      goalDKP   = Number(gRows[0].goal_dkp   || 0); // скільки DKP очікуємо
    }

    // 2) тягнемо ваги DKP формули
    const { rows: cRows } = await pool.query(
      `SELECT kills_weight, dead_to_kills
         FROM kvk_config
        WHERE kvk_id=$1`,
      [activeId]
    );
    if (cRows[0]) {
      cfg = cRows[0];
    }
  }

  // 3) підрахунок боїв:
  //    computeZoneSumForPlayer сумує по ВСІХ завершених зонах
  //    і повертає скільки гравець реально зробив.
  //
  //    zoneSum.dKills = сумарний приріст (t4+t5)
  //    zoneSum.dDead  = сумарні втрати
  //    zoneSum.dKp    = скільки Kill Points він набив
  //    zoneSum.dPower / dT4 / dT5 і т.д. — для дельт у верхньому рядку картки
  const zoneSum  = await computeZoneSumForPlayer(pidStr);

  // 4) остання завершена зона (для блоку "YOUR LAST FIGHTS AT ...")
  const lastZone = await computeLastZoneDeltaForPlayer(pidStr);

  // 5) скільки вже зроблено
  const killsDone = Number(zoneSum.dKills || 0); // приріст T4+T5
  const deadDone  = Number(zoneSum.dDead  || 0); // приріст dead

  // 6) DKP формула
  const dkpDone = Math.round(
    (Number(cfg.kills_weight   || 0) * killsDone) +
    (Number(cfg.dead_to_kills  || 0) * deadDone)
  );

  // 7) скільки залишилось до цілей
  const killsLeft = Math.max(0, goalKills - killsDone);
  const deadLeft  = Math.max(0, goalDead  - deadDone);
  const dkpLeft   = Math.max(0, goalDKP   - dkpDone);

  // 8) прогрес у відсотках
  const pctRaw = goalDKP > 0 ? (100 * dkpDone / goalDKP) : 0;

  // 9) назва "бейджа" (WARM UP / ON TRACK / OVERDRIVE ...)
  const tagText = autoTag(pctRaw);

  // 10) готуємо пакет даних для рендера картки
  return {
    latest, // snapshot з latest (power/kp/... + updated_at)
    goal: {
      kills: goalKills,
      dead : goalDead,
      dkp  : goalDKP,
    },
    progress: {
      killsDone,
      deadDone,
      dkpDone,
      killsLeft,
      deadLeft,
      dkpLeft,
      pct: pctRaw,
      tag: tagText,
    },
    lastZone, // { zoneName, dKillsZone, dDeadZone }
    zoneSum,  // { dPower, dKp, dKills, dDead, dT4, dT5 }
  };
}


/* ───────────────── Рендер картки гравця (SVG -> PNG) ───────────────── */

// Рендер картки гравця в SVG
// Всі підписи на картці англійською
function playerCardSVG(card) {
  const { latest, goal, progress, lastZone, zoneSum } = card;

  // формат числа з комами
  const nfNum = (n) =>
    (n === null || n === undefined)
      ? "0"
      : Number(n).toLocaleString("en-US");

  // кольори / стиль
  const bg         = "#0d121d";   // фон картки
  const panelBg    = "#2a3142";   // фон барів / панелей
  const fillPrimary= "#6b7bff";   // базовий прогрес (0..100%)
  const fillOver   = "#4deeea";   // оверкап (100..200%)
  const textCol    = "#ffffff";   // основний текст
  const subCol     = "#9da5bd";   // вторинний текст
  const goodCol    = "#6ee7a8";   // зелений для +дельт
  const badCol     = "#ef5350";   // червоний для -дельт
  const zeroCol    = "#7b8193";   // сірий для ±0

  // геометрія
  const w = 1100;
  const h = 620;

  const padX   = 24;   // горизонтальні падінги
  const padTop = 40;   // верхній падінг (щоб бейдж % не обрізало)

  // секція з Power / Kill Points / Dead / T5 / T4
  const metricsY = padTop + 70; // відступ вниз від заголовка

  const metricBlockGapX = 200;  // відстань між стовпчиками метрик

  // прогрес-бари
  const barW       = w - padX * 2;
  const barH       = 24;
  const barGapY    = 80;
  const barsStartY = metricsY + 100; // нижче від метрик

  // нижні бокси ("LEFT TO GO" + "YOUR LAST FIGHTS ...")
  const leftBoxY   = barsStartY + barGapY * 3 + 40;
  const leftBoxW   = 500;
  const leftBoxH   = 70;
  const leftBoxR   = 8;

  // Updated time з latest.updated_at
  const updatedAtStr = latest.updated_at
    ? new Date(latest.updated_at).toLocaleString("en-US", {
        hour12: true,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

  // дельта-рядок під кожною метрикою
  // 0 → "±0" сірим
  // >0 → "+123" зеленим
  // <0 → "-123" червоним
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

  // сумарні дельти по всіх завершених зонах (бойовий прогрес з початку KvK)
  const dPower = renderDelta(zoneSum?.dPower || 0);
  const dKP    = renderDelta(zoneSum?.dKP    || 0);
  const dDead  = renderDelta(zoneSum?.dDead  || 0);
  const dT5    = renderDelta(zoneSum?.dT5    || 0);
  const dT4    = renderDelta(zoneSum?.dT4    || 0);

  // прогрес бар: розбивка на базовий шар (0..100%) і overcap (100..200%)
  // але текст показує реальний %, хоч 400
  function progressPieces(done, goal, totalW) {
    if (!goal || goal <= 0) {
      return {
        wBase: 0,
        wOver: 0,
        pctRaw: 0,
      };
    }

    const pctRaw = (done / goal) * 100; // може бути >200

    const pctBase = Math.min(Math.max(pctRaw, 0), 100);      // 0..100
    const pctOver = Math.min(Math.max(pctRaw - 100, 0), 100); // 0..100

    return {
      wBase: totalW * (pctBase / 100), // ширина фіолетового шару
      wOver: totalW * (pctOver / 100), // ширина бірюзового шару
      pctRaw,
    };
  }

  // будуємо один бар як SVG-групу
  function makeBar(labelText, doneVal, goalVal, offsetY) {
    const { wBase, wOver, pctRaw } = progressPieces(doneVal, goalVal, barW);

    return `
      <g transform="translate(0,${offsetY})">
        <text class="barLabel" x="0" y="-8">${labelText}</text>

        <!-- track -->
        <rect x="0" y="0"
              width="${barW}" height="${barH}" rx="4"
              fill="${panelBg}"/>

        <!-- базовий прогрес (0..100%) -->
        <rect x="0" y="0"
              width="${wBase.toFixed(1)}"
              height="${barH}" rx="4"
              fill="${fillPrimary}"/>

        <!-- оверкап (100..200%) -->
        ${wOver > 0
          ? `<rect x="0" y="0"
                   width="${wOver.toFixed(1)}"
                   height="${barH}" rx="4"
                   fill="${fillOver}" opacity="0.9"/>`
          : ""}

        <!-- текст відсотка: показує реальний %, хоч 412% -->
        <text class="barText"
              x="${barW/2}"
              y="${barH/2 + 4}">
          ${Math.round(pctRaw)}%
        </text>

        <!-- підпис типу "14,445 / 29,000,000" -->
        <text class="barLabel"
              x="0"
              y="${barH + 20}">
          ${nfNum(doneVal)} / ${nfNum(goalVal)}
        </text>
      </g>
    `;
  }

  // чи є дані по останній зоні
  const hasLastZoneData =
    lastZone &&
    lastZone.zoneName &&
    lastZone.zoneName !== "–" &&
    ((lastZone.dKillsZone || 0) > 0 ||
     (lastZone.dDeadZone  || 0) > 0);

  const lastZoneBox = hasLastZoneData
    ? `
      <g transform="translate(${padX + leftBoxW + 24}, ${leftBoxY})">
        <text x="0" y="0"
              font-family="Inter, system-ui"
              font-size="14"
              fill="${subCol}"
              font-weight="500">
          YOUR LAST FIGHTS AT "${lastZone.zoneName}" ZONE
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
          Kills ${nfNum(lastZone.dKillsZone)} • Dead ${nfNum(lastZone.dDeadZone)}
        </text>
      </g>
    `
    : "";

  // бари
  const killsBar = makeBar(
    "Kills (T4+T5)",
    progress.killsDone,
    goal.kills,
    0
  );

  const deadBar = makeBar(
    "Dead",
    progress.deadDone,
    goal.dead,
    barGapY
  );

  const dkpBar = makeBar(
    "DKP",
    progress.dkpDone,
    goal.dkp,
    barGapY * 2
  );

  // позиції бейджа зверху справа
  const badgeBaselineY = padTop;      // велике число %
  const badgeTagY      = padTop + 32; // підпис "WARM UP", "OVERDRIVE", ...

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${w}" height="${h}"
     viewBox="0 0 ${w} ${h}"
     style="font-family:Inter,system-ui">

  <!-- фон картки -->
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

  <!-- Header: ім'я + player_id + Updated -->
  <g transform="translate(${padX},${padTop})">
    <text class="title">
      ${latest.name} (${latest.player_id})
    </text>

    <text y="28" class="sub">
      Updated: ${updatedAtStr}
    </text>
  </g>

  <!-- DKP badge справа вгорі -->
  <g transform="translate(${w - padX - 10},0)" text-anchor="end">
    <text
      fill="${textCol}"
      font-size="40"
      font-weight="600"
      font-family="Inter, system-ui"
      y="${badgeBaselineY}">
      ${Math.round(progress.pct)}%
    </text>
    <text
      y="${badgeTagY}"
      fill="${subCol}"
      font-size="14"
      font-weight="600"
      font-family="Inter, system-ui"
      letter-spacing="0.08em">
      ${progress.tag}
    </text>
  </g>

  <!-- Верхні метрики (Power / Kill Points / Dead / T5 / T4) -->
  <g transform="translate(${padX},${metricsY})">

    <!-- Power -->
    <g>
      <text class="metricH" x="0" y="0">Power</text>
      <text class="metricV" x="0" y="26">${nfNum(latest.power)}</text>
      <text class="metricD" x="0" y="44" fill="${dPower.fill}">
        ${dPower.text}
      </text>
    </g>

    <!-- Kill Points -->
    <g transform="translate(${metricBlockGapX},0)">
      <text class="metricH" x="0" y="0">Kill Points</text>
      <text class="metricV" x="0" y="26">${nfNum(latest.kp)}</text>
      <text class="metricD" x="0" y="44" fill="${dKP.fill}">
        ${dKP.text}
      </text>
    </g>

    <!-- Dead -->
    <g transform="translate(${metricBlockGapX*2},0)">
      <text class="metricH" x="0" y="0">Dead</text>
      <text class="metricV" x="0" y="26">${nfNum(latest.dead)}</text>
      <text class="metricD" x="0" y="44" fill="${dDead.fill}">
        ${dDead.text}
      </text>
    </g>

    <!-- T5 -->
    <g transform="translate(${metricBlockGapX*3},0)">
      <text class="metricH" x="0" y="0">T5</text>
      <text class="metricV" x="0" y="26">${nfNum(latest.t5)}</text>
      <text class="metricD" x="0" y="44" fill="${dT5.fill}">
        ${dT5.text}
      </text>
    </g>

    <!-- T4 -->
    <g transform="translate(${metricBlockGapX*4},0)">
      <text class="metricH" x="0" y="0">T4</text>
      <text class="metricV" x="0" y="26">${nfNum(latest.t4)}</text>
      <text class="metricD" x="0" y="44" fill="${dT4.fill}">
        ${dT4.text}
      </text>
    </g>
  </g>

  <!-- Прогрес-блоки -->
  <g transform="translate(${padX},${barsStartY})">
    ${killsBar}
    ${deadBar}
    ${dkpBar}
  </g>

  <!-- LEFT TO GO -->
  <g transform="translate(${padX},${leftBoxY})">
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
      Kills ${nfNum(progress.killsLeft)} • Dead ${nfNum(progress.deadLeft)}
    </text>
  </g>

  ${lastZoneBox}

</svg>
`;
}

// перетворюємо SVG в PNG Buffer
async function renderPlayerCardPNG(bundle) {
  const svg = playerCardSVG(bundle);
  const buf = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  return buf;
}

/* ───────────────── KvK TOP PNG ───────────────── */

function hashTopRows(rows) {
  const s = rows
    .map(
      (r) => `${r.player_id}:${r.dkp}:${r.goal_dkp}:${r.pct}`
    )
    .join("|");
  return createHash("md5").update(s).digest("hex").slice(0, 12);
}

function kvkTopSVG(rows, meta = {}) {
  // ---- стилі (як на картці гравця) ----
  const panelBg     = "#0d121d";   // outer bg
  const cardBg      = "#121722";   // card bg
  const borderCol   = "#1e2633";   // card border
  const textCol     = "#ffffff";   // main text
  const subCol      = "#9da5bd";   // secondary text
  const trackCol    = "#2a3142";   // bar track
  const fillPrimary = "#6b7bff";   // 0..100%
  const fillOver    = "#4deeea";   // 100..200%

  // ---- геометрія ----
  const W = 1100;
  const outerMargin = 24;      // від краю всього зображення до карти

  const cardX = outerMargin;
  const cardY = outerMargin;
  const cardW = W - outerMargin * 2;

  const headerH    = 60;       // висота хедера всередині карти
  const gapAfterH  = 20;       // відступ після хедера перед списком
  const rowGap     = 90;       // висота одного рядка топа
  const bottomPad  = 40;       // падінг знизу карти всередині

  // бар усередині рядка
  const innerPadX  = 32;       // падінг контенту всередині карти зліва/справа
  const barW       = cardW - innerPadX * 2 - 40; // ширина прогрес-бару
  const barH       = 16;

  // topY списку рядків
  const listTopY = cardY + headerH + gapAfterH;

  // рахуємо висоту всієї карти і всього SVG
  const cardInnerHeight = headerH + gapAfterH + rows.length * rowGap + bottomPad;
  const H = outerMargin * 2 + cardInnerHeight;

  // ---- форматери ----
  const nf = (x) =>
    new Intl.NumberFormat("en-US").format(
      Number.isFinite(Number(x)) ? Number(x) : 0
    );

  // Updated time:
  // meta.updated > якщо передана зовні
  // інакше беремо максимум updated_at з рядків
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

  // будуємо частини бара:
  // raw % може бути 4319%
  // малюємо тільки до 200% ширини:
  //  - фіолетовий 0..100
  //  - бірюзовий 100..200
  // але сам текст показує реальний raw %
  function barPieces(pctRawNum) {
    const raw = Number(pctRawNum) || 0;

    const capped = Math.max(0, Math.min(raw, 200)); // 0..200 макс для показу ширини

    const basePct = Math.min(capped, 100);                // 0..100
    const overPct = Math.max(Math.min(capped - 100, 100), 0); // 0..100

    return {
      pctRaw: raw,                             // реальний %
      wBase: (barW * basePct) / 100,           // ширина фіолетової частини
      wOver: (barW * overPct) / 100,           // ширина бірюзової частини
    };
  }

  // генеруємо рядки топу
  let lines = "";
  rows.forEach((r, idx) => {
    const yTop = listTopY + idx * rowGap;

    const { pctRaw, wBase, wOver } = barPieces(r.pct);

    const playerName =
      (r.name && r.name.trim()) ? r.name.trim() : String(r.player_id);

    // текст під баром
    const bottomLeftText  = `${nf(r.dkp || 0)} / ${nf(r.goal_dkp || 0)}`;
    const bottomRightText = `${Math.round(pctRaw)}%`;

    const rankText = `${idx + 1}.`;

    const safeName = playerName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;");

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

        <!-- фон треку -->
        <rect
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16}"
          width="${barW}"
          height="${barH}"
          rx="4"
          fill="${trackCol}"
        />

        <!-- базова частина прогресу 0..100% -->
        ${wBase > 0 ? `
        <rect
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16}"
          width="${wBase.toFixed(1)}"
          height="${barH}"
          rx="4"
          fill="${fillPrimary}"
        />` : ""}

        <!-- оверкап частина 100..200% -->
        ${wOver > 0 ? `
        <rect
          x="${cardX + innerPadX + 40}"
          y="${yTop + 16}"
          width="${wOver.toFixed(1)}"
          height="${barH}"
          rx="4"
          fill="${fillOver}"
          opacity="0.9"
        />` : ""}

        <!-- підпис зліва під баром -->
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

        <!-- відсоток справа під баром -->
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

  // збираємо весь SVG
  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${W}"
  height="${H}"
  viewBox="0 0 ${W} ${H}"
  style="font-family:Inter,system-ui"
>
  <!-- фон всього зображення -->
  <rect width="${W}" height="${H}" fill="${panelBg}"/>

  <!-- карта топу -->
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

    <!-- title зліва -->
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

    <!-- Updated справа -->
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

/* ───────────────── Кеш PNG ───────────────── */

const imgCache = new Map(); // key -> { buf, t }

function cacheKeyPlayer(pid, bundle) {
  return (
    `p:${pid}:` +
    `${bundle.progress.dkpDone}|` +
    `${bundle.progress.killsDone}|` +
    `${bundle.progress.deadDone}|` +
    `${bundle.progress.killsLeft}|` +
    `${bundle.latest.updated_at ?? ""}`
  );
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

/* ───────────────── Discord client ───────────────── */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ───────────────── Хелпери під команди ───────────────── */

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
  // не повертаємо BigInt напряму в pool.query, але BigInt нам ще ок для інших штук
  try {
    return BigInt(arg);
  } catch {
    return null;
  }
}

/* ───────────────── Основний обробник повідомлень ───────────────── */

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    // Якщо бот має працювати тільки в одному каналі
    const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
    if (ALLOWED_CHANNEL_ID && msg.channel.id !== ALLOWED_CHANNEL_ID) {
      const allowedChannel = await client.channels
        .fetch(ALLOWED_CHANNEL_ID)
        .catch(() => null);
      if (allowedChannel) {
        return void msg.reply(
          `⚠️ Please use this bot in ${allowedChannel} only.`
        );
      } else {
        return void msg.reply(
          "⚠️ This bot is restricted to a specific channel."
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
        return void msg.reply("Usage: `!stats <player_id>`");
      }

      const cd = checkCooldown(msg.author.id);
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(idArg);
      if (!latest) {
        return void msg.reply(
          "No data yet. Ask an admin to scan this player."
        );
      }

      // будуємо bundle (id конвертнемо всередині функції, вона вже виправлена)
      const bundle = await buildZoneBasedKvkBundle(idArg, latest);

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
      if (cd) return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest) {
        return void msg.reply("No data yet for your player_id.");
      }

      const bundle = await buildZoneBasedKvkBundle(linked, latest);

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

    // !link <player_id> або !link @user <player_id> (адмін може лінкати інших)
    if (cmd === "link") {
      const mention = msg.mentions.users.first() ?? msg.author;
      const idArg = mention === msg.author ? args[0] : args[1];

      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply(
          "Usage: `!link <player_id>` or `!link @user <player_id>` (admin only for others)"
        );
      }

      const { rows } = await pool.query(
        `SELECT 1 FROM players WHERE id=$1 LIMIT 1`,
        [idArg]
      );
      if (!rows.length) {
        return void msg.reply(
          `player_id **${idArg}** is not in the DB yet. Ask an admin to scan first.`
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

    if (cmd === "help") {
      const HELP_PUBLIC = [
        "**Public commands:**",
        "`!stats <player_id>` — Player card (KvK progress: T4+T5 Kills / Dead / DKP).",
        "`!me` — Your card (after `!link`).",
        "`!link <player_id>` — Link your Discord to your player_id.",
        "`!unlink` — Unlink yourself.",
        "`!help` — This help.",
      ].join("\n");
      return void msg.reply(HELP_PUBLIC);
    }

    if (cmd === "helpadmin") {
      if (!isAdmin(msg)) return void msg.reply("Admins only.");
      const HELP_ADMIN = [
        "**Admin commands:**",
        "`!link @user <player_id>` — Link mentioned user.",
        "`!unlink [@user]` — Unlink mentioned user.",
        "`!kvk start [name]` — Start a new KvK period.",
        "`!kvk active` — Show active KvK period ID.",
        "`!kvk weight show` — Show DKP weights (kills_weight for Kills(T4+T5), dead_to_kills for Dead).",
        "`!kvk weight <dead|kills> <value>` — Update DKP weight.",
        "`!kvk ensure <player_id>` / `!kvk ensure_all` — Create goals (goal_kills, goal_dead, goal_dkp).",
        "`!kvk stats <player_id>` / `!kvk me` — Player KvK progress card.",
        "`!kvk top [N] [text]` — KvK leaderboard by % of DKP goal.",
        "`!top [kp|power] [N]` — Simple snapshot leaderboard.",
      ].join("\n");
      return void msg.reply(HELP_ADMIN);
    }

    /* ===== ДАЛІ ТІЛЬКИ АДМІНИ ===== */
    if (!isAdmin(msg)) {
      return void msg.reply(
        "Admins only. Public commands are: `!stats`, `!me`, `!link`, `!unlink`, `!help`."
      );
    }

    // !kvk start [name]
    if (cmd === "kvk" && args[0] === "start") {
      await initSchema();
      const name = args.slice(1).join(" ") || null;
      const id = await kvkStart(name);
      return void msg.reply(
        `KvK period **${id}** started${name ? `: ${name}` : ""}.`
      );
    }

    // !kvk active
    if (cmd === "kvk" && args[0] === "active") {
      const id = await kvkActiveId();
      return void msg.reply(
        id ? `Active KvK period: **${id}**` : "No active KvK period."
      );
    }

    // !kvk weight show / !kvk weight <dead|kills> <value>
    if (cmd === "kvk" && args[0] === "weight") {
      if ((args[1] || "").toLowerCase() === "show") {
        const id = await kvkActiveId();
        if (!id) return void msg.reply("No active KvK period.");
        const { rows } = await pool.query(
          `SELECT kills_weight, dead_to_kills
             FROM kvk_config
            WHERE kvk_id=$1`,
          [String(id)]
        );
        if (!rows[0]) {
          return void msg.reply(
            "No weight config found for the active period."
          );
        }
        const { kills_weight, dead_to_kills } = rows[0];
        return void msg.reply(
          `DKP Weights → Kills(T4+T5): **${kills_weight}**, Dead: **${dead_to_kills}**`
        );
      }

      const which = (args[1] || "").toLowerCase();
      const val = Number(args[2]);
      if (!["dead", "kills"].includes(which) || !Number.isFinite(val)) {
        return void msg.reply(
          "Usage: `!kvk weight <dead|kills> <value>` or `!kvk weight show`"
        );
      }
      await kvkSetWeight(which, val);
      return void msg.reply(`Weight **${which}** updated to **${val}**.`);
    }

    // !kvk ensure <player_id>
    if (cmd === "kvk" && (args[0] === "ensure" || args[0] === "setgoal")) {
      const pidBig = parsePlayerId(args[1]);
      if (pidBig == null)
        return void msg.reply("Usage: `!kvk ensure <player_id>`");

      // kvkEnsureGoal всередині сам працює з БД і може очікувати BigInt,
      // це ок, бо він не йде напряму в pool.query з ним як параметром масиву,
      // а збирає SQL сам. Якщо там теж є BigInt -> треба буде аналогічно String(),
      // але припустимо що воно вже виправлене в db.pg.js.
      const g = await kvkEnsureGoal(pidBig);
      if (!g)
        return void msg.reply(
          "Goal already exists, OR no active KvK, OR no latest snapshot for that player."
        );

      return void msg.reply(
        `Goal for **${args[1]}** → Kills(T4+T5) ${nf(
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
          // невеличка пауза щоб не зафлудити БД
          await new Promise((res) => setTimeout(res, 8));
        } catch {
          skipped++;
        }
      }
      return void msg.reply(
        `Goals created: **${made}** (skipped: ${skipped}).`
      );
    }

    // !kvk stats <player_id>
    if (cmd === "kvk" && args[0] === "stats") {
      const pidArg = args[1];
      if (!pidArg || !/^\d+$/.test(pidArg))
        return void msg.reply("Usage: `!kvk stats <player_id>`");

      const cd = checkCooldown(msg.author.id);
      if (cd)
        return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(pidArg);
      if (!latest)
        return void msg.reply("No latest snapshot for that player.");

      const bundle = await buildZoneBasedKvkBundle(pidArg, latest);

      const key = cacheKeyPlayer(pidArg, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, {
        name: "kvk_stats.png",
      });
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
      if (cd)
        return void msg.reply(`Slow down. Try again in ${cd}s.`);

      const latest = await fetchLatestById(linked);
      if (!latest)
        return void msg.reply("No latest snapshot for your player_id.");

      const bundle = await buildZoneBasedKvkBundle(linked, latest);

      const key = cacheKeyPlayer(linked, bundle);
      let png = getCached(key);
      if (!png) {
        png = await renderPlayerCardPNG(bundle);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, {
        name: "kvk_stats.png",
      });
      await msg.reply({ files: [file] });
      return;
    }

    // !kvk top [N] [text]
    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(
        Math.max(parseInt(args[1] || "10", 10) || 10, 1),
        50
      );
      const asText = (args[2] || "").toLowerCase() === "text";

      const rows = await kvkTop(limit);
      if (!rows.length)
        return void msg.reply("Empty. (Maybe no goals yet?)");

      if (asText) {
        const lines = rows.map(
          (r, i) =>
            `**${i + 1}.** ${r.name ?? r.player_id} — ${pct1(
              r.pct
            )}% (DKP ${nf(r.dkp)}/${nf(r.goal_dkp)})`
        );
        return void msg.reply(lines.join("\n"));
      }

      // таймстамп беремо по цих самих гравцях
      const ts = await fetchMaxUpdatedAtForPlayers(
        rows.map((r) => r.player_id).filter(Boolean)
      );
      const meta = {
        title: `KvK Top ${rows.length}`,
        active: (await kvkActiveId()) ?? "–",
        updated: formatTs(ts),
      };

      const key = cacheKeyTop(limit, meta.active, rows);
      let png = getCached(key);
      if (!png) {
        png = await renderKvkTopPNG(rows, meta);
        setCached(key, png);
      }

      const file = new AttachmentBuilder(png, {
        name: "kvk_top.png",
      });
      await msg.reply({ files: [file] });
      return;
    }

    // !top [kp|power] [N]
    if (cmd === "top") {
      const by = (args[0] || "kp").toLowerCase(); // "kp" або "power"
      const limit = Math.min(
        Math.max(parseInt(args[1] || "10", 10) || 10, 1),
        50
      );

      const rows = await fetchTop(by, limit);
      if (!rows.length)
        return void msg.reply(
          "Empty. You need to run the scanner first."
        );

      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(
            r.metric
          )}**`
      );
      return void msg.reply(lines.join("\n"));
    }

    // щось невідоме
    return void msg.reply(
      "Unknown command. See `!help` or `!helpadmin`."
    );
  } catch (e) {
    // Тепер ми все ж кажемо юзеру що щось зламалось,
    // замість повної тиші.
    log.error({ err: String(e?.stack || e), where: "messageCreate" });
    try {
      await msg.reply(
        "⚠️ Internal error. Admins were notified."
      );
    } catch {}

    if (LOG_CHANNEL_ID) {
      const ch = client.channels.cache.get(LOG_CHANNEL_ID);
      if (ch?.isTextBased?.()) {
        ch
          .send(
            `⚠️ Error for message "${msg.content}": \`${String(
              e?.message || e
            )}\``
          )
          .catch(() => {});
      }
    }
  }
});

/* ───────────────── Події життєвого циклу ───────────────── */

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const active = await kvkActiveId();
    console.log(`Active period: ${active ?? "<none>"}`);
  } catch {}
});

// акуратне завершення (Heroku/Render і т.д.)
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
  console.error("❌ DISCORD_TOKEN or DATABASE_URL missing in .env");
}

// запускаємо клієнт
client.login(process.env.DISCORD_TOKEN);
