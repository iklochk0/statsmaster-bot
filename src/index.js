// src/index.js
//
// OCR-сканер CityHall25 для БАЗОВОГО СНІМКУ KvK.
//
// Як це юзати:
//   1. Перед стартом KvK ти запускаєш цей сканер на топ гравців.
//   2. Він витягує з профілю (через OCR) такі абсолютні значення:
//        • player_id
//        • name
//        • power
//        • kp (Kill Points total в грі)
//        • dead (total dead troops в грі)
//        • t4, t5 kills total
//   3. Ми пишемо це як baseline у players.*_current
//   4. Якщо для цього гравця в цьому KvK ще нема goals → ставимо goal_kills / goal_dead
//      по таблиці за power (main).
//   5. Потім під час війни дані не апдейтяться OCR'ом — йдуть тільки excelImport.js
//      (дельти в imports).
//
// Важливо:
//   - Цей сканер НЕ рахує дельти, НЕ пише imports.
//   - Цей сканер НЕ менеджить "zones start/finish". Це все викинуто.
//
// Зовнішні модулі (emu.js / ocr.js / capture.js / crop.js / ui.json / regions.json)
// лишаються як у тебе: вони крутять емулятор, роблять screenshot, OCR і т.д.
//

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
  getActiveKvK,
  startKvK,
  upsertBaselineFromOCR,
  closeDb,
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

const SCREEN_PATH =
  process.env.SCREEN_PATH ||
  path.join(ROOT_DIR, "screenshots", "screen.png");
const ADB = process.env.ADB_BIN || "adb";
const SERIAL = process.env.ADB_SERIAL || ""; // наприклад "127.0.0.1:5555"
const USE_HOST_CLIPBOARD = process.env.USE_HOST_CLIPBOARD !== "false"; // default true

// "безпечна зона" екрану де можна тапати
const SAFE = UI.screen?.safe ?? {
  left: 0,
  top: 0,
  width: 1280,
  height: 720,
};

// як ми перевіряємо що ми реально в списку City Hall
const ANCHOR_CITYHALL =
  UI.anchors?.cityHall ?? { left: 520, top: 110, width: 260, height: 60 };

/* ──────────────────────── Timings / humanization ──────────────────────── */

const T_SETTLE = Number(FLOW.settleMs ?? 1000);
const T_JITTER = () => 150 + Math.floor(Math.random() * 250);

const T_OCR_NAME_GUESS = 220;
const T_CLIP_STEP = 180;
const T_CLIP_ADB = 2500;
const T_CLIP_HOST = 3000;
const T_LONGPRESS = 360;

const PRE_SCAN_SETTLE_MS = 800;

const SCAN_PAUSE_MIN_MS = Number(process.env.SCAN_PAUSE_MIN_MS || 1000);
const SCAN_PAUSE_MAX_MS = Number(process.env.SCAN_PAUSE_MAX_MS || 2000);

const RAND_PX = Number(process.env.RAND_PX || 0);

// базовий індекс рядка, який ми регулярно тицяємо (5-й по дефолту)
const BASE_ROW_IDX = Number(process.env.BASE_ROW_IDX ?? 4);

// "людські відпочинки"
const IDLE_EVERY_MIN = Number(process.env.IDLE_EVERY_MIN || 3);
const IDLE_MIN_MS = Number(process.env.IDLE_MIN_MS || 5000);
const IDLE_MAX_MS = Number(process.env.IDLE_MAX_MS || 20000);

// фейковий свайп по блоку "dead", щоб змусити гру перемалюватись
const FAKE_SWIPE_DY = Number(process.env.FAKE_SWIPE_DY || 140);
const FAKE_SWIPE_COUNT = Number(process.env.FAKE_SWIPE_COUNT || 1);
const FAKE_SWIPE_DUR = Number(process.env.FAKE_SWIPE_DUR || 380);
const FAKE_SWIPE_PROB = Number(process.env.FAKE_SWIPE_PROB || 0.3);

/* ──────────────────────── CLI args ──────────────────────── */

function arg(name, def) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split("=", 2)[1] : def;
}

// скільки профілів пробувати обійти
const COUNT = Number(arg("count", "40"));

/* ──────────────────────── helpers ──────────────────────── */

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
  const preview = JSON.stringify(detail);
  console.log(
    `[ACTION] ${type} ${
      preview.length > 200 ? preview.slice(0, 200) + "…" : preview
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

async function adbTapExact(x, y, durMs = 120, meta = {}) {
  const xx = Math.round(x);
  const yy = Math.round(y);
  const dd = Math.max(60, Math.round(durMs));

  logAction("tap", { x: xx, y: yy, durMs: dd, ...meta });

  await execa(
    ADB,
    adbArgs(["shell", "input", "swipe", `${xx}`, `${yy}`, `${xx}`, `${yy}`, `${dd}`]),
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
      `${xx1}`,
      `${yy1}`,
      `${xx2}`,
      `${yy2}`,
      `${dd}`,
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

/* ──────────────────────── geometry utils ──────────────────────── */

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
  const x = rect.left + randInt(0, Math.max(0, rect.width - 1));
  const y = rect.top + randInt(0, Math.max(0, rect.height - 1));
  return clampToSafe({ x, y });
}

/* ──────────────────────── swipe "dead" для перерисовки ──────────────────────── */

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

/* ──────────────────────── navigateHuman() ──────────────────────── */

async function navigateHuman(actionOrArray) {
  const tapFromRect = async (rect, durMs) => {
    const p = pickPointInRect(rect);
    logAction("tapRect", { rect, picked: p });
    await adbTapExact(p.x, p.y, durMs ?? 120);
  };

  const doOne = async (a) => {
    if (!a || typeof a !== "object") return;

    if (a.type === "tap" && a.rect && hasRect(a.rect)) {
      return tapFromRect(a.rect, a.durMs);
    }

    if (a.type === "tapRect" && hasRect(a)) {
      return tapFromRect(a, a.durMs);
    }

    if (a.type === "tap" && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      const base = clampToSafe({ x: a.x, y: a.y });
      const j = RAND_PX
        ? clampToSafe({ x: jitterPx(base.x), y: jitterPx(base.y) })
        : base;
      return adbTapExact(j.x, j.y, jitterDur(a.durMs ?? 120));
    }

    // fallback на navigate() зі старого ui.json
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

/* ──────────────────────── CH row geometry / level ──────────────────────── */

function rowRefY(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`ui.cityHallList.rows[${i}] missing`);

  if (r.rect && hasRect(r.rect)) {
    return r.rect.top + r.rect.height / 2;
  }
  if (Number.isFinite(r.y)) return r.y;

  throw new Error(`rows[${i}] must have rect or y`);
}

function levelRectForRow(i) {
  const col = LIST.levelCol;
  if (!col?.left || !col?.width || !col?.height) {
    throw new Error("ui.cityHallList.levelCol missing left/width/height");
  }

  const { left, width, height } = col;
  const safeTop = SAFE.top;
  const safeBottom = SAFE.top + SAFE.height;

  if (Number.isFinite(col.top0)) {
    const dy = rowRefY(i) - rowRefY(0);
    const top = clamp(Math.round(col.top0 + dy), safeTop, safeBottom - height);
    return { left, top, width, height };
  }

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

// евристика "чи ми зараз у профілі"
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

/* ──────────────────────── open row → профіль ──────────────────────── */

function rowPoint(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`cityHallList.rows[${i}] missing`);

  if (r.rect && hasRect(r.rect)) {
    return pickPointInRect(r.rect);
  }
  return clampToSafe({ x: r.x, y: r.y });
}

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

// fallback: пробуємо базовий рядок і 2 наступних
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
    await execa(ADB, adbArgs(["shell", "cmd", "clipboard", "set", ""]), {
      encoding: "utf8",
    });
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
async function waitClipboardNonEmptyADB(maxMs = T_CLIP_ADB, stepMs = T_CLIP_STEP) {
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
async function waitClipboardNonEmptyHost(prev = "", maxMs = T_CLIP_HOST, stepMs = T_CLIP_STEP) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const t = await clipboardGetHost();
    if (t && t !== prev) return t;
    await sleep(stepMs);
  }
  return "";
}

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

  // пауза між двома тапами
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

  // пробуємо прочитати буфери
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
          `${x}`,
          `${y}`,
          `${x}`,
          `${y}`,
          `${T_LONGPRESS + randInt(-60, 60)}`,
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

/* ──────────────────────── скан одного профілю ──────────────────────── */

async function scanProfileOnce() {
  // дати екрану стабілізуватись
  await sleepLog(PRE_SCAN_SETTLE_MS, "pre-scan settle");

  const texts = {};
  await copyNameIntoTexts(texts);
  await sleepLog(120 + randInt(0, 150), "after copyName");

  for (const page of CFG.pages) {
    // фейкові свайпи по dead, щоб оживити поле
    if (page.name === "bottom" && Math.random() < FAKE_SWIPE_PROB) {
      await fakeSwipeInDead();
    }

    // робимо скрін і кропаємо всі потрібні ROI з цієї сторінки
    await captureScreen(SCREEN_PATH);

    const rois = await cropRegions(
      SCREEN_PATH,
      page.rois,
      path.join(ROOT_DIR, "screenshots", `regions_${page.name}`)
    );

    for (const [k, buf] of Object.entries(rois)) {
      if (k === "name") {
        // імʼя ми вже намагались вичитати через буфер обміну,
        // але для логів все одно OCRимо
        if (!texts.name) {
          const guess = await ocrField(k, buf);
          if (guess) texts.name = guess;
        } else {
          await ocrField(k, buf);
        }
      } else {
        texts[k] = await ocrField(k, buf);
      }

      await sleepLog(randInt(20, 60), "between ocr fields");
    }

    // гортай далі якщо сторінка каже page.nav
    if (page.nav) {
      logAction("page-nav", { page: page.name, nav: page.nav });
      await navigateHuman(page.nav);
      await sleepLog(T_SETTLE + randInt(0, 150), "after page nav");
    }
  }

  // if id слабенько зчитався — ще раз верхній блок
  const idDigits0 = (texts.id || "").replace(/\D/g, "");
  if (!idDigits0 || idDigits0.length < 5) {
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

  // переводимо сирі тексти OCR в нормальні числа
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

/* ──────────────────────── назад у список ──────────────────────── */

async function backToCityHallList() {
  // подвійний тап по "закрити death"
  logAction("back", { step: "closeDeath#1" });
  await navigateHuman(FLOW.closeDeath);

  await sleepLog(randMs(500, 1100), "between closeDeath taps");

  logAction("back", { step: "closeDeath#2" });
  await navigateHuman(FLOW.closeDeath);

  await sleepLog(T_SETTLE, "after closeDeath double tap");

  // тепер сам профіль закрити
  logAction("back", { step: "closeProfile" });
  await navigateHuman(FLOW.closeProfile);

  await sleepLog(T_SETTLE, "after closeProfile");
  return true;
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

/* ──────────────────────── nav в список City Hall ──────────────────────── */

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

/* ──────────────────────── обробка одного профілю ──────────────────────── */

async function handleOneProfile(openedOk, kvk_id) {
  if (!openedOk) return { saved: false };

  // OCR
  const stats = await scanProfileOnce();

  // валідуємо player_id
  const pidNum = Number(String(stats?.id || "").replace(/\D/g, ""));
  if (!Number.isFinite(pidNum) || String(pidNum).length < 5) {
    console.warn("   ! No reliable player id recognized, skipped");
    logAction("save-skip-noid", { stats });
    return { saved: false };
  }

  console.log(`   Save ${pidNum} "${stats.name || ""}"`);
  logAction("save-player", { pid: pidNum, name: stats.name || "" });

  // в базу: це наш baseline для цього KvK
  await upsertBaselineFromOCR(kvk_id, {
    player_id: pidNum,
    name: stats.name || "",
    power: stats.power || 0,
    kp: stats.kp || 0,
    dead: stats.dead || 0,
    t4: stats.t4 || 0,
    t5: stats.t5 || 0,
  });

  // повертаємо для локального бекапу
  const stamp = {
    at: new Date().toISOString(),
    kvk_id,
    stats,
  };

  return { saved: true, stamp };
}

/* ──────────────────────── main() ──────────────────────── */

async function main() {
  await initSchema();
  await initOCR();

  // гарантуємо що є активний KvK
  let kvk_id = await getActiveKvK();
  if (!kvk_id) {
    kvk_id = await startKvK(); // назва дефолтна типу "KvK YYYY-MM-DD"
    console.log(`Started new KvK session: ${kvk_id}`);
  } else {
    console.log(`Active KvK: ${kvk_id}`);
  }

  // куди пишемо бекап OCR
  const backupPath = path.join(OUT_DIR, "players_baseline.json");
  let visited = 0;

  // заходимо в City Hall рейтинг
  await openCityHallList();
  await humanPause();

  // Етап 1: пройти верх списку до BASE_ROW_IDX-1
  for (
    let i = 0;
    i < Math.min(BASE_ROW_IDX, LIST.rows.length) && visited < COUNT;
    i++
  ) {
    await maybeIdlePause();

    // якщо це не останній рядок пачки — перевіримо що там City Hall == 25
    if (i < LIST.rows.length - 1) {
      const lvl = await readLevelAtRow(i);
      if (lvl !== 25) {
        console.log(`   Skip row ${i}: CH=${Number.isNaN(lvl) ? "?" : lvl}`);
        logAction("row-skip", { idx: i, lvl });

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

    const { saved, stamp } = await handleOneProfile(opened, kvk_id);
    if (saved && stamp) {
      await appendBackup(backupPath, stamp);
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

  // Етап 2: "ферма" базового рядка (BASE_ROW_IDX) з fallback
  while (visited < COUNT) {
    await maybeIdlePause();

    const { opened, usedIndex } = await openProfileWithFallbacks(BASE_ROW_IDX);
    if (!opened) {
      console.warn("   ! Ghost chain (5/6/7) — skip this slot");
      logAction("ghost-chain-skip", {});

      visited++;
      await humanPause();
      continue;
    }

    const { saved, stamp } = await handleOneProfile(opened, kvk_id);
    if (saved && stamp) {
      await appendBackup(backupPath, stamp);
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
        `   Used fallback row ${usedIndex} → next loop presses base index again`
      );
      logAction("fallback-keep-base", { usedIndex });
    }
  }

  console.log(`\n✓ Done: visited ${visited} rows`);

  // Зберігаємо action log для дебагу
  const actionsPath = path.join(
    OUT_DIR,
    `actions-baseline-${Date.now()}.json`
  );
  await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
  console.log(`Action log saved: ${path.relative(ROOT_DIR, actionsPath)}`);

  console.log(
    `Baseline backups:\n  - ${path.relative(ROOT_DIR, backupPath)}`
  );
}

/* ──────────────────────── backup helpers ──────────────────────── */

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

/* ──────────────────────── runner ──────────────────────── */

(async () => {
  let fatal = null;

  try {
    await main();
  } catch (e) {
    fatal = e;
    console.error(e);

    // навіть при фаталі намагаємось зберегти ACTION_LOG
    try {
      const actionsPath = path.join(
        OUT_DIR,
        `actions-error-${Date.now()}.json`
      );
      await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
      console.log(`Action log (error) saved: ${actionsPath}`);
    } catch {}
  } finally {
    await closeOCR().catch(() => {});
    await closeDb().catch(() => {});
  }

  if (fatal) {
    process.exitCode = 1;
  } else {
    console.log("Baseline scan complete.");
  }
})();