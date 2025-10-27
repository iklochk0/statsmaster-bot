// src/index.js
// CityHall25 scanner bot
//
// Що робить:
// 1. Заходить у рейтинг → City Hall list
// 2. Відкриває профілі по рядках, читає OCR полів (id/name/power/kp/t1..t5/dead)
// 3. Зберігає все в Postgres через db.pg.js (saveScan)
// 4. Якщо це baseline (звичайний запуск без zone), то:
//    - kvkEnsureGoal() автосоздає KvK goals для гравця
// 5. Підтримка "zone start/finish": npm run scan zone "Kingsland push" start|finish
//    - просто фіксує run_id зони
//
// Тех:
// - робимо паузи, подвійні тапи, фейкові свайпи по "dead"
// - дуже акуратно тиснемо всередині safe-зони екрана
// - бекопимо всі скани в out/run-<run_id>.json і out/players.json
//
// Важливі поля, які ми з OCR зобовʼязані дістати:
//   kp  = Kill Points (очки за кілли в грі) -> latest.kp / stats.kp
//   t1..t5 = kills по тірах -> latest.t*, stats.t*
//   dead = втрати солдат
//
// goal у KvK сьогодні рахується по t4+t5 (це "kills" для DKP), а kp зберігається просто як довідкова метрика

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execa } from "execa";
import clipboardy from "clipboardy";

import { captureScreen } from "./capture.js";
import { cropRegions } from "./crop.js";
import { initOCR, ocrBuffer, closeOCR } from "./ocr.js";
import { parseStats } from "./parse.js";
import { navigate, sleep } from "./emu.js";
import {
  initSchema,
  beginRun,
  saveScan,
  kvkEnsureGoal,
  kvkActiveId,
  closeDb,
  zoneStart,
  zoneFinish,
  getZone,
} from "./db.pg.js";

/* ──────────────────────── Paths / config ──────────────────────── */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "out");
await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});

const UI = JSON.parse(
  await fs.readFile(new URL("./ui.json", import.meta.url), "utf-8")
);
const CFG = JSON.parse(
  await fs.readFile(new URL("./regions.json", import.meta.url), "utf-8")
);

const FLOW = UI.flow;
const LIST = UI.cityHallList;

// adb / emulator setup
const SCREEN_PATH =
  process.env.SCREEN_PATH ||
  path.join(ROOT_DIR, "screenshots", "screen.png");
const ADB = process.env.ADB_BIN || "adb";
const SERIAL = process.env.ADB_SERIAL || ""; // "127.0.0.1:5555"
const USE_HOST_CLIPBOARD = process.env.USE_HOST_CLIPBOARD !== "false"; // default true

// safe tap area on screen
const SAFE = UI.screen?.safe ?? {
  left: 0,
  top: 0,
  width: 1280,
  height: 720,
};

// OCR anchor щоб переконатись що ми реально в списку City Hall
const ANCHOR_CITYHALL =
  UI.anchors?.cityHall ?? { left: 520, top: 110, width: 260, height: 60 };

/* ──────────────────────── Timings / humanization ──────────────────────── */

// розтягнуті паузи щоб виглядати "людсько"
const T_SETTLE = Number(FLOW.settleMs ?? 1000);
const T_JITTER = () => 150 + Math.floor(Math.random() * 250);

const T_OCR_NAME_GUESS = 220;
const T_CLIP_STEP = 180;
const T_CLIP_ADB = 2500;
const T_CLIP_HOST = 3000;
const T_LONGPRESS = 360;

// щоб екран профілю точно встиг намалюватися перед OCR
const PRE_SCAN_SETTLE_MS = 800;

// пауза між профілями
const SCAN_PAUSE_MIN_MS = Number(process.env.SCAN_PAUSE_MIN_MS || 1000);
const SCAN_PAUSE_MAX_MS = Number(process.env.SCAN_PAUSE_MAX_MS || 2000);

// якщо RAND_PX > 0, ми додаємо +-кілька пікселів до кожного тапа
const RAND_PX = Number(process.env.RAND_PX || 0);

// базовий (5-й у списку) індекс для фарму в лупі
const BASE_ROW_IDX = Number(process.env.BASE_ROW_IDX ?? 4);

// idle-перерви (бот "нічого не робить" кілька секунд час від часу)
const IDLE_EVERY_MIN = Number(process.env.IDLE_EVERY_MIN || 3);
const IDLE_MIN_MS = Number(process.env.IDLE_MIN_MS || 5000);
const IDLE_MAX_MS = Number(process.env.IDLE_MAX_MS || 20000);

// тролимо гру "скролом смертей"
const FAKE_SWIPE_DY = Number(process.env.FAKE_SWIPE_DY || 140);
const FAKE_SWIPE_COUNT = Number(process.env.FAKE_SWIPE_COUNT || 1);
const FAKE_SWIPE_DUR = Number(process.env.FAKE_SWIPE_DUR || 380);
const FAKE_SWIPE_PROB = Number(process.env.FAKE_SWIPE_PROB || 0.3);

/* ──────────────────────── CLI режим ──────────────────────── */

function arg(name, def) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split("=", 2)[1] : def;
}

// скількох гравців намагатись пройти
const COUNT = Number(arg("count", "40"));

// positional args для зон:
//   npm run scan
//   npm run scan zone "Kingsland push" start
//   npm run scan zone "Kingsland push" finish
const POSITIONAL = process.argv.slice(2);

let ZONE_MODE = null; // { name: string, mode: "start"|"finish" } або null
if (POSITIONAL[0] === "zone" && POSITIONAL.length >= 3) {
  const zoneName = POSITIONAL[1];
  const zMode = String(POSITIONAL[2] || "").toLowerCase();
  if (zoneName && (zMode === "start" || zMode === "finish")) {
    ZONE_MODE = { name: zoneName, mode: zMode };
    console.log(`Zone mode: "${zoneName}" → ${zMode}`);
  } else {
    console.warn(
      `Zone args ignored (expected: zone "<name>" start|finish)`
    );
  }
}
// baseline режим = немає ZONE_MODE
const BASELINE_MODE = !ZONE_MODE;

/* ──────────────────────── Helpers: randoms / sleep / logging ──────────────────────── */

const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const randMs = (min, max) => randInt(min, max);

const humanPause = async () => {
  await sleep(randInt(SCAN_PAUSE_MIN_MS, SCAN_PAUSE_MAX_MS));
};
const jitterPx = (v) => v + randInt(-RAND_PX, RAND_PX);
const jitterDur = (ms = 120) => Math.max(60, ms + randInt(-30, 30));

const ACTION_LOG = [];
function logAction(type, detail = {}) {
  const entry = { at: new Date().toISOString(), type, ...detail };
  ACTION_LOG.push(entry);
  const brief = JSON.stringify(detail);
  console.log(
    `[ACTION] ${type} ${
      brief.length > 200 ? brief.slice(0, 200) + "…" : brief
    }`
  );
}

async function sleepLog(ms, reason = "") {
  logAction("sleep", { ms, reason });
  await sleep(ms);
}

/* ──────────────────────── ADB helpers ──────────────────────── */

function adbArgs(args) {
  const a = [];
  if (SERIAL) a.push("-s", SERIAL);
  a.push(...args);
  return a;
}

// клік через swipe x,y -> x,y
async function adbTapExact(x, y, durMs = 120, meta = {}) {
  const xx = Math.round(x);
  const yy = Math.round(y);
  const dd = Math.max(60, Math.round(durMs));

  logAction("tap", { x: xx, y: yy, durMs: dd, ...meta });

  await execa(
    ADB,
    adbArgs([
      "shell",
      "input",
      "swipe",
      String(xx),
      String(yy),
      String(xx),
      String(yy),
      String(dd),
    ]),
    { encoding: "buffer" }
  );
}

async function adbSwipe(x1, y1, x2, y2, durMs = 300, meta = {}) {
  const xx1 = Math.round(x1),
    yy1 = Math.round(y1);
  const xx2 = Math.round(x2),
    yy2 = Math.round(y2);
  const dd = Math.max(80, Math.round(durMs));

  logAction("swipe", {
    from: { x: xx1, y: yy1 },
    to: { x: xx2, y: yy2 },
    durMs: dd,
    ...meta,
  });

  await execa(
    ADB,
    adbArgs([
      "shell",
      "input",
      "swipe",
      String(xx1),
      String(yy1),
      String(xx2),
      String(yy2),
      String(dd),
    ]),
    { encoding: "buffer" }
  );
}

async function sendKeyevent(code) {
  logAction("keyevent", { code });
  try {
    await execa(
      ADB,
      adbArgs(["shell", "input", "keyevent", String(code)]),
      { encoding: "buffer" }
    );
  } catch {}
}

/* ──────────────────────── geometry ──────────────────────── */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function clampToSafe(pt) {
  const x = clamp(pt.x, SAFE.left, SAFE.left + SAFE.width - 1);
  const y = clamp(pt.y, SAFE.top, SAFE.top + SAFE.height - 1);
  return { ...pt, x, y };
}

function hasRect(a) {
  return (
    a &&
    typeof a === "object" &&
    Number.isFinite(a.left) &&
    Number.isFinite(a.top) &&
    Number.isFinite(a.width) &&
    Number.isFinite(a.height)
  );
}

function pickPointInRect(rect) {
  // випадкова точка всередині rect, затиснута в SAFE
  const x = rect.left + randInt(0, Math.max(0, rect.width - 1));
  const y = rect.top + randInt(0, Math.max(0, rect.height - 1));
  return clampToSafe({ x, y });
}

/* ──────────────────────── fake swipe у "dead" ──────────────────────── */

async function fakeSwipeInDead() {
  for (let i = 0; i < FAKE_SWIPE_COUNT; i++) {
    const x0 = SAFE.left + SAFE.width / 2 + randInt(-20, 20);
    const y0 = SAFE.top + SAFE.height / 2 + randInt(40, 80);

    await adbSwipe(
      x0,
      y0,
      x0,
      y0 - FAKE_SWIPE_DY,
      FAKE_SWIPE_DUR + randInt(-60, 60),
      { i }
    );

    await sleepLog(300 + randInt(0, 250), "after fake swipe");
  }
}

/* ──────────────────────── navigationHuman() ──────────────────────── */
/**
 * Підтримує дії:
 *  - {type:"tap", x, y, durMs}
 *  - {type:"tap", rect:{left,top,width,height}, durMs}
 *  - {type:"tapRect", left, top, width, height, durMs}
 *  - масив таких дій
 * Якщо нічого не підійшло — викликає navigate(...) зі старого ui.json.
 */
async function navigateHuman(actionOrArray) {
  const tapFromRect = async (rect, durMs) => {
    const p = pickPointInRect(rect);
    logAction("tapRect", { rect, picked: p });
    await adbTapExact(p.x, p.y, durMs ?? 120);
  };

  const doOne = async (a) => {
    if (!a || typeof a !== "object") return;

    // варіант: {type:"tap", rect:{...}}
    if (a.type === "tap" && a.rect && hasRect(a.rect)) {
      return tapFromRect(a.rect, a.durMs);
    }

    // варіант: {type:"tapRect", left, top, width, height}
    if (a.type === "tapRect" && hasRect(a)) {
      return tapFromRect(a, a.durMs);
    }

    // варіант: {type:"tap", x, y}
    if (a.type === "tap" && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      const base = clampToSafe({ x: a.x, y: a.y });
      const j = RAND_PX
        ? clampToSafe({ x: jitterPx(base.x), y: jitterPx(base.y) })
        : base;
      return adbTapExact(j.x, j.y, jitterDur(a.durMs ?? 120));
    }

    // fallback: raw navigate() з ui.json (послідовність свайпів і т.д.)
    logAction("navigate-pass", { raw: a });
    await navigate(a);
  };

  if (Array.isArray(actionOrArray)) {
    for (const a of actionOrArray) {
      await doOne(a);
    }
  } else {
    await doOne(actionOrArray);
  }
}

/* ──────────────────────── OCR utils ──────────────────────── */

const DIGITS = "0123456789";

async function ocrField(key, buf) {
  const wl = key === "name" ? null : DIGITS;
  const txt = (await ocrBuffer(buf, wl)).trim();
  logAction("ocr", { key, text: txt });
  return txt;
}

/* ──────────────────────── CH row geometry → level OCR ──────────────────────── */

function rowRefY(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`ui.cityHallList.rows[${i}] missing`);

  if (r.rect && hasRect(r.rect)) {
    return r.rect.top + r.rect.height / 2;
  }
  if (Number.isFinite(r.y)) return r.y;

  throw new Error(`rows[${i}] must have either rect or y`);
}

function levelRectForRow(i) {
  const col = LIST.levelCol;
  if (!col?.left || !col?.width || !col?.height) {
    throw new Error(
      "ui.json cityHallList.levelCol requires left,width,height"
    );
  }

  const { left, width, height } = col;
  const safeTop = SAFE.top;
  const safeBottom = SAFE.top + SAFE.height;

  // режим top0 + dy
  if (Number.isFinite(col.top0)) {
    const dy = rowRefY(i) - rowRefY(0);
    const top = clamp(Math.round(col.top0 + dy), safeTop, safeBottom - height);
    return { left, top, width, height };
  }

  // режим offset
  const off = Array.isArray(col.topOffset)
    ? col.topOffset[i] ?? 0
    : col.topOffset ?? 0;

  const centerY = rowRefY(i);
  const top = clamp(
    Math.round(centerY + off - height / 2),
    safeTop,
    safeBottom - height
  );
  return { left, top, width, height };
}

// читаємо рівень сітіхолу у рядку (щоб скіпати не-25)
async function readLevelAtRow(i) {
  await sleepLog(50 + randInt(0, 90), "before OCR row");

  const rect = levelRectForRow(i);

  await captureScreen(SCREEN_PATH);
  const key = `lv_r${i}`;
  const outDir = path.join(ROOT_DIR, "screenshots", "ch_levels");
  const piece = await cropRegions(SCREEN_PATH, { [key]: rect }, outDir);
  const buf = piece[key];

  const raw = buf ? (await ocrBuffer(buf, DIGITS)).trim() : "";
  const n = Number((raw || "").replace(/\D/g, ""));

  logAction("ocrRow", { row: i, rect, raw, parsed: n });
  return Number.isFinite(n) ? n : NaN;
}

/* ──────────────────────── screen detection helpers ──────────────────────── */

function regionNameCenter() {
  const r = CFG?.pages?.[0]?.rois?.name;
  if (!r) return null;
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
}
function actionCopyFromRegions() {
  return CFG?.pages?.[0]?.actions?.copyName || null;
}

// приблизна евристика: чи ми в профілі гравця
async function isProfileScreen() {
  await captureScreen(SCREEN_PATH);
  const top = CFG.pages[0];

  const rois = await cropRegions(
    SCREEN_PATH,
    top.rois,
    path.join(ROOT_DIR, "screenshots", "probe_profile")
  );

  const idRaw = rois.id ? (await ocrBuffer(rois.id, DIGITS)).trim() : "";
  const idDigits = (idRaw || "").replace(/\D/g, "");
  if (idDigits.length >= 5) return true;

  const powRaw = rois.power
    ? (await ocrBuffer(rois.power, DIGITS)).trim()
    : "";

  // назва в regions.json може бути kills або kp — пробуємо обидва
  const killsRaw = rois.kills
    ? (await ocrBuffer(rois.kills, DIGITS)).trim()
    : rois.kp
    ? (await ocrBuffer(rois.kp, DIGITS)).trim()
    : "";

  const pow = Number((powRaw || "").replace(/\D/g, ""));
  const kills = Number((killsRaw || "").replace(/\D/g, ""));

  return (
    (Number.isFinite(pow) && pow > 1000) ||
    (Number.isFinite(kills) && kills > 1000)
  );
}

// чекаємо поки профіль справді відкрився (або здались)
async function waitProfileOrGiveUp(timeoutMs = 3200, pollMs = 250) {
  const end = Date.now() + timeoutMs;
  await sleepLog(120, "before profile poll");

  while (Date.now() < end) {
    if (await isProfileScreen()) return true;

    if (await isCityHallList()) {
      await sleepLog(pollMs, "still in list");
      continue;
    }

    await sleepLog(pollMs, "poll profile");
  }
  return false;
}

/* ──────────────────────── open row tap logic ──────────────────────── */

function rowPoint(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`cityHallList.rows[${i}] missing`);

  if (r.rect && hasRect(r.rect)) {
    return pickPointInRect(r.rect);
  }
  return clampToSafe({ x: r.x, y: r.y });
}

// відкриваємо профіль певного рядка
async function openProfileFromRow(idx, retries = 2) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= LIST.rows.length) {
    console.warn(`! openProfileFromRow: idx ${idx} out of range`);
    logAction("rowTap-invalid", { idx });
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const p = rowPoint(idx);
    logAction("rowTap", { idx, attempt, picked: p });

    await adbTapExact(p.x, p.y, 120, { idx, attempt });
    await sleepLog(T_SETTLE + T_JITTER(), "after row tap");

    if (await waitProfileOrGiveUp(3200, 250)) return true;

    await sleepLog(200 + randInt(0, 200), "retry row tap");
  }
  return false;
}

// fallback: базовий рядок, потім base+1, base+2
async function openProfileWithFallbacks(baseIdx = BASE_ROW_IDX) {
  const candidates = [baseIdx, baseIdx + 1, baseIdx + 2].filter(
    (i) => i < LIST.rows.length
  );
  logAction("fallback-start", { baseIdx, candidates });

  for (const i of candidates) {
    const ok = await openProfileFromRow(i, i === baseIdx ? 3 : 2);
    if (ok) {
      logAction("fallback-success", { usedIndex: i });
      return { opened: true, usedIndex: i };
    }
  }

  logAction("fallback-failed", { baseIdx });
  return { opened: false, usedIndex: -1 };
}

/* ──────────────────────── clipboard name capture ──────────────────────── */

async function clipboardSetEmptyADB() {
  try {
    await execa(
      ADB,
      adbArgs(["shell", "cmd", "clipboard", "set", ""]),
      { encoding: "utf8" }
    );
  } catch {}
}
async function clipboardGetADB() {
  try {
    const { stdout } = await execa(
      ADB,
      adbArgs(["shell", "cmd", "clipboard", "get"]),
      { encoding: "utf8" }
    );
    return (stdout || "").trim();
  } catch {
    return "";
  }
}
async function waitClipboardNonEmptyADB(
  maxMs = T_CLIP_ADB,
  stepMs = T_CLIP_STEP
) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const t = await clipboardGetADB();
    if (t) return t;
    await sleep(stepMs);
  }
  return "";
}

async function clipboardSetEmptyHost() {
  try {
    await clipboardy.write("");
  } catch {}
}
async function clipboardGetHost() {
  try {
    return (await clipboardy.read()) ?? "";
  } catch {
    return "";
  }
}
async function waitClipboardNonEmptyHost(
  prev = "",
  maxMs = T_CLIP_HOST,
  stepMs = T_CLIP_STEP
) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const t = await clipboardGetHost();
    if (t && t !== prev) return t;
    await sleep(stepMs);
  }
  return "";
}

// Копіюємо імʼя: подвійний тап у ту ж точку з паузою 0.5–1.1с.
// Якщо не вдалось — лонгпрес + KEYCODE_COPY.
async function copyNameIntoTexts(texts) {
  await clipboardSetEmptyADB();

  let hostPrev = "";
  if (USE_HOST_CLIPBOARD) {
    await clipboardSetEmptyHost();
    hostPrev = await clipboardGetHost();
  }

  const clickAction = actionCopyFromRegions() || FLOW.copyName;
  const tapPoint = regionNameCenter();

  // тап #1
  if (clickAction) {
    logAction("copyName-tap1", { action: clickAction });
    await navigateHuman(clickAction);
  } else if (tapPoint) {
    logAction("copyName-tap1", { point: tapPoint });
    await adbTapExact(tapPoint.x, tapPoint.y, 120);
  }

  // довга пауза між тапами
  await sleepLog(randMs(500, 1100), "between name taps");

  // тап #2
  if (clickAction) {
    logAction("copyName-tap2", { action: clickAction });
    await navigateHuman(clickAction);
  } else if (tapPoint) {
    logAction("copyName-tap2", { point: tapPoint });
    await adbTapExact(tapPoint.x, tapPoint.y, 120);
  }

  await sleepLog(
    T_OCR_NAME_GUESS + randInt(0, 120),
    "wait copyName clipboard"
  );

  // читаємо буфер
  let clip = await waitClipboardNonEmptyADB(T_CLIP_ADB, T_CLIP_STEP);

  if (!clip && USE_HOST_CLIPBOARD) {
    clip = await waitClipboardNonEmptyHost(
      hostPrev,
      T_CLIP_HOST,
      T_CLIP_STEP
    );
  }

  // fallback: longpress + KEYCODE_COPY
  if (!clip && tapPoint) {
    try {
      const x = Math.round(tapPoint.x),
        y = Math.round(tapPoint.y);
      logAction("longpress", { x, y, dur: T_LONGPRESS });

      await execa(
        ADB,
        adbArgs([
          "shell",
          "input",
          "swipe",
          String(x),
          String(y),
          String(x),
          String(y),
          String(T_LONGPRESS + randInt(-60, 60)),
        ]),
        { encoding: "buffer" }
      );
    } catch {}

    await sleepLog(200 + randInt(0, 120), "after longpress");
    await sendKeyevent(278); // KEYCODE_COPY
    clip = await waitClipboardNonEmptyADB(2000, 180);

    if (!clip && USE_HOST_CLIPBOARD) {
      clip = await waitClipboardNonEmptyHost(hostPrev, 2500, 200);
    }
  }

  if (clip) {
    logAction("clipboard-name", { text: clip });
    texts.name = clip;
  } else {
    logAction("clipboard-name", { text: "<empty>" });
  }
}

/* ──────────────────────── scanProfileOnce() ──────────────────────── */

async function scanProfileOnce() {
  // дати профілю прогрузитись
  await sleepLog(PRE_SCAN_SETTLE_MS, "pre-scan settle");

  const texts = {};
  await copyNameIntoTexts(texts);
  await sleepLog(120 + randInt(0, 150), "after copyName");

  for (const page of CFG.pages) {
    // іноді фейково скролимо смерть/втрати
    if (page.name === "bottom" && Math.random() < FAKE_SWIPE_PROB) {
      await fakeSwipeInDead();
    }

    // робимо скрін, кропаємо всі ROI на сторінці, ганяємо OCR
    await captureScreen(SCREEN_PATH);

    const rois = await cropRegions(
      SCREEN_PATH,
      page.rois,
      path.join(ROOT_DIR, "screenshots", `regions_${page.name}`)
    );

    for (const [k, buf] of Object.entries(rois)) {
      if (k === "name") {
        if (!texts.name) {
          const guess = await ocrField(k, buf);
          if (guess) texts.name = guess;
        } else {
          // чисто для логів щоб бачити як OCRить імʼя екраном
          await ocrField(k, buf);
        }
      } else {
        texts[k] = await ocrField(k, buf);
      }
      await sleepLog(randInt(20, 60), "between ocr fields");
    }

    // перегортаємо сторінку, якщо треба
    if (page.nav) {
      logAction("page-nav", { page: page.name, nav: page.nav });
      await navigateHuman(page.nav);
      await sleepLog(T_SETTLE + randInt(0, 150), "after page nav");
    }
  }

  // якщо id не розпізналося стабільно, ще раз на верхній сторінці
  const idDigits = (texts.id || "").replace(/\D/g, "");
  if (!idDigits || idDigits.length < 5) {
    const first = CFG.pages[0];
    await captureScreen(SCREEN_PATH);
    const roisTop = await cropRegions(
      SCREEN_PATH,
      first.rois,
      path.join(ROOT_DIR, "screenshots", "retry_top")
    );
    if (roisTop.id) {
      texts.id = (await ocrBuffer(roisTop.id, DIGITS)).trim();
    }
  }

  // parseStats робить нормальний обʼєкт:
  // {
  //   id, name,
  //   power,
  //   kp,         // Kill Points TOTAL
  //   dead,
  //   t1,t2,t3,t4,t5
  // }
  const parsed = parseStats(texts);
  logAction("scanProfileOnce-result", { parsed });
  return parsed;
}

/* ──────────────────────── city hall detection ──────────────────────── */

async function isCityHallByHeader() {
  await captureScreen(SCREEN_PATH);

  const piece = await cropRegions(
    SCREEN_PATH,
    { hdr: ANCHOR_CITYHALL },
    path.join(ROOT_DIR, "screenshots", "anchors")
  );

  const buf = piece.hdr;
  const txt = buf ? (await ocrBuffer(buf, null)).toLowerCase() : "";
  const ok = txt.includes("city") && txt.includes("hall");
  logAction("probe-cityhall-header", { text: txt, ok });
  return ok;
}

async function isCityHallByLevel() {
  const n = await readLevelAtRow(0);
  const ok = Number.isFinite(n) && n >= 1 && n <= 25;
  logAction("probe-cityhall-level", { n, ok });
  return ok;
}

async function isCityHallList() {
  const ok = (await isCityHallByHeader()) || (await isCityHallByLevel());
  logAction("probe-cityhall", { ok });
  return ok;
}

/* ──────────────────────── backToCityHallList() ──────────────────────── */
/**
 * Повернення назад до списку:
 * 1) подвійний тап по FLOW.closeDeath (з паузою 0.5-1.1s)
 * 2) закрити профіль через FLOW.closeProfile
 */
async function backToCityHallList() {
  // тап #1 по "закрити death"
  logAction("back", { step: "closeDeath#1" });
  await navigateHuman(FLOW.closeDeath);

  // пауза як людина
  await sleepLog(randMs(500, 1100), "between closeDeath taps");

  // тап #2 на всякий випадок
  logAction("back", { step: "closeDeath#2" });
  await navigateHuman(FLOW.closeDeath);

  await sleepLog(T_SETTLE, "after closeDeath double tap");

  // власне закриття профілю
  logAction("back", { step: "closeProfile" });
  await navigateHuman(FLOW.closeProfile);
  await sleepLog(T_SETTLE, "after closeProfile");

  return true;
}

/* ──────────────────────── backups to JSON ──────────────────────── */

async function readBackupArray(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function appendBackup(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const arr = await readBackupArray(filePath);
  arr.push(record);
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
}

/* ──────────────────────── idle pause ──────────────────────── */

let _lastIdleTs = Date.now();
async function maybeIdlePause() {
  const period = Math.max(0, IDLE_EVERY_MIN) * 60_000;
  if (!period) return;

  const now = Date.now();
  if (now - _lastIdleTs >= period) {
    const ms = randInt(IDLE_MIN_MS, IDLE_MAX_MS);
    await sleepLog(ms, "idle pause");
    _lastIdleTs = Date.now();
  }
}

/* ──────────────────────── high-level steps ──────────────────────── */

// крок 1: відкрити City Hall рейтинг з профілю
async function openCityHallList() {
  logAction("nav-seq", { step: "openMyProfile" });
  await navigateHuman(FLOW.openMyProfile);
  await sleepLog(T_SETTLE + T_JITTER(), "after openMyProfile");

  logAction("nav-seq", { step: "openRankings" });
  await navigateHuman(FLOW.openRankings);
  await sleepLog(T_SETTLE + T_JITTER(), "after openRankings");

  logAction("nav-seq", { step: "openCityHall" });
  await navigateHuman(FLOW.openCityHall);
  await sleepLog(T_SETTLE + T_JITTER(), "after openCityHall");
}

// крок 2: відкрити один профіль, просканити, записати в БД, зробити goal за потреби, повернутися в список
async function handleOneProfile(openedOk, run_id) {
  if (!openedOk) return { saved: false };

  // OCR
  const stats = await scanProfileOnce();
  const stamp = { run_id, at: new Date().toISOString(), stats };

  // player_id
  const pid = Number(String(stats?.id || "").replace(/\D/g, ""));

  if (Number.isFinite(pid) && String(pid).length >= 5) {
    console.log(`   Save ${pid} "${stats.name || ""}"`);
    logAction("save-player", { pid, name: stats.name || "" });

    // в базу
    await saveScan(run_id, stats);

    // KvK goals тільки в baseline режимі
    if (BASELINE_MODE) {
      try {
        const res = await kvkEnsureGoal(pid);
        if (res) logAction("kvkEnsureGoal", { pid, res });
      } catch (e) {
        logAction("kvkEnsureGoal-error", {
          pid,
          error: e?.message || String(e),
        });
      }
    }

    // backup JSON
    return { saved: true, stamp };
  } else {
    console.warn("   ! No reliable player id recognized, skipped");
    logAction("save-skip-noid", { stats });
    return { saved: false };
  }
}

/* ──────────────────────── main() ──────────────────────── */

async function main() {
  await initSchema(); // <- важливо при пустій БД
  await initOCR();

  const activeKvK = await kvkActiveId();
  console.log(`Active KvK: ${activeKvK ?? "<none>"}`);

  const run_id = await beginRun();
  console.log(`Run: ${run_id} | CityHall25`);

  // файли бекопів (зручно дебажити без БД)
  const backupAllPath = path.join(OUT_DIR, "players.json");
  const backupRunPath = path.join(OUT_DIR, `run-${run_id}.json`);
  await fs.writeFile(backupRunPath, "[]").catch(() => {});

  // заходимо в рейтинг
  await openCityHallList();
  await humanPause();

  let visited = 0;

  // ── ФАЗА 1: пройти верх списку до BASE_ROW_IDX-1 (гріємо емуль, пропускаємо не-СН25)
  for (
    let i = 0;
    i < Math.min(BASE_ROW_IDX, LIST.rows.length) && visited < COUNT;
    i++
  ) {
    await maybeIdlePause();

    // якщо це не останній рядок у видимій пачці — перевіримо що там City Hall == 25
    if (i < LIST.rows.length - 1) {
      const lvl = await readLevelAtRow(i);
      if (lvl !== 25) {
        console.log(
          `   Skip row ${i}: CH=${Number.isNaN(lvl) ? "?" : lvl}`
        );
        logAction("row-skip", { idx: i, lvl });
        await sleepLog(200 + T_JITTER(), "after skip non-25");

        visited++;
        await humanPause();
        continue;
      }
    }

    const opened = await openProfileFromRow(i, 3);
    if (!opened) {
      console.warn(`   ! Row ${i} did not open — skip`);
      logAction("row-open-failed", { idx: i });

      visited++;
      await humanPause();
      continue;
    }

    const { saved, stamp } = await handleOneProfile(opened, run_id);
    if (saved && stamp) {
      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    }

    const ok = await backToCityHallList();
    if (!ok) {
      console.warn("   ! Can't return to list — stop");
      logAction("back-failed", {});
      break;
    }

    visited++;
    await humanPause();
    await maybeIdlePause();
  }

  // ── ФАЗА 2: фарм базового рядка BASE_ROW_IDX з fallback (base → base+1 → base+2)
  while (visited < COUNT) {
    await maybeIdlePause();

    const { opened, usedIndex } = await openProfileWithFallbacks(
      BASE_ROW_IDX
    );
    if (!opened) {
      console.warn("   ! Ghost chain (5/6/7) — skip this slot");
      logAction("ghost-chain-skip", {});

      visited++;
      await humanPause();
      continue;
    }

    const { saved, stamp } = await handleOneProfile(opened, run_id);
    if (saved && stamp) {
      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    }

    const ok = await backToCityHallList();
    if (!ok) {
      console.warn("   ! Can't return to list — stop");
      logAction("back-failed", {});
      break;
    }

    visited++;
    await humanPause();
    await maybeIdlePause();

    if (usedIndex !== BASE_ROW_IDX) {
      console.log(
        `   Used fallback row ${usedIndex} → next loop presses base 5 again`
      );
      logAction("fallback-keep-base", { usedIndex });
    }
  }

  // лог фіналу
  console.log(`\n✓ Done: visited ${visited} rows`);

  const actionsPath = path.join(OUT_DIR, `actions-run-${run_id}.json`);
  await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
  console.log(
    `Action log saved: ${path.relative(ROOT_DIR, actionsPath)}`
  );

  console.log(
    `Backups:\n  - ${path.relative(
      ROOT_DIR,
      backupAllPath
    )}\n  - ${path.relative(ROOT_DIR, backupRunPath)}`
  );

  // зона-логіка
  if (ZONE_MODE) {
    try {
      if (ZONE_MODE.mode === "start") {
        await zoneStart(ZONE_MODE.name, run_id);
        console.log(
          `Zone "${ZONE_MODE.name}": START stored (run_id ${run_id})`
        );
      } else if (ZONE_MODE.mode === "finish") {
        await zoneFinish(ZONE_MODE.name, run_id);
        console.log(
          `Zone "${ZONE_MODE.name}": FINISH stored (run_id ${run_id})`
        );
      }

      const zr = await getZone(ZONE_MODE.name);
      console.log("Zone record:", zr);
    } catch (e) {
      console.warn("Zone save error:", e?.message || String(e));
    }
  }

  return run_id;
}

/* ──────────────────────── runner with cleanup ──────────────────────── */

(async () => {
  let fatal = null;
  let run_id_for_logs = null;

  try {
    run_id_for_logs = await main();
  } catch (e) {
    fatal = e;
    console.error(e);

    // у випадку падіння теж пробуємо зберегти ACTION_LOG щоб можна було дебажити
    try {
      const actionsPath = path.join(
        OUT_DIR,
        `actions-run-error-${Date.now()}.json`
      );
      await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
      console.log(`Action log (error) saved: ${actionsPath}`);
    } catch {}
  } finally {
    // завжди закриваємо OCR і БД
    await closeOCR().catch(() => {});
    await closeDb().catch(() => {});
  }

  if (fatal) {
    process.exitCode = 1;
  } else {
    console.log(`Scan complete. Run ${run_id_for_logs}`);
  }
})();