// src/index.js
// CityHall25 scanner бот
// - відкриття профілів по списку
// - OCR полів (id, name, power, kills tiers, dead, etc.)
// - вставка в Postgres через db.pg.js
// - KvK автогоал
// - random fake swipe у "смертях"
// - подвійні тапи (copyName + закриття смертей) з рандомним інтервалом
// - зона start/finish (zoneName як текст)
// - додатковий settle ~0.5s перед OCR щоб екран встиг прогрузитись

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
  upsertPlayer,
  insertStats,
  kvkEnsureGoal,
  kvkActiveId,
  closeDb,
  zoneStart,
  zoneFinish,
  getZone
} from "./db.pg.js";

/* ===================== Paths & Config ===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, "..");
const OUT_DIR    = path.join(ROOT_DIR, "out");
await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});

const UI   = JSON.parse(await fs.readFile(new URL("./ui.json",     import.meta.url), "utf-8"));
const CFG  = JSON.parse(await fs.readFile(new URL("./regions.json", import.meta.url), "utf-8"));
const FLOW = UI.flow;
const LIST = UI.cityHallList;

const SCREEN_PATH = process.env.SCREEN_PATH || path.join(ROOT_DIR, "screenshots", "screen.png");
const ADB         = process.env.ADB_BIN || "adb";
const SERIAL      = process.env.ADB_SERIAL || "";  // e.g. "127.0.0.1:5555"
const USE_HOST_CLIPBOARD = process.env.USE_HOST_CLIPBOARD !== "false"; // default true

const SAFE = UI.screen?.safe ?? { left: 0, top: 0, width: 1280, height: 720 };
const ANCHOR_CITYHALL = UI.anchors?.cityHall ?? { left: 520, top: 110, width: 260, height: 60 };

/* ===================== Timings ===================== */
const T_SETTLE = Number(FLOW.settleMs ?? 700);
const T_JITTER = () => 150 + Math.floor(Math.random() * 250);
const T_OCR_NAME_GUESS = 220;
const T_CLIP_STEP  = 180;
const T_CLIP_ADB   = 2500;
const T_CLIP_HOST  = 3000;
const T_LONGPRESS  = 360;

const PRE_SCAN_SETTLE_MS = 500; // додаткова пауза перед OCR профілю

const SCAN_PAUSE_MIN_MS = Number(process.env.SCAN_PAUSE_MIN_MS || 900);
const SCAN_PAUSE_MAX_MS = Number(process.env.SCAN_PAUSE_MAX_MS || 1800);

// якщо хочеш супер-стабільно тиснути один піксель — лиш RAND_PX=0
const RAND_PX = Number(process.env.RAND_PX || 0);

// 0-based: 4 => це 5-та позиція ("база")
const BASE_ROW_IDX = Number(process.env.BASE_ROW_IDX ?? 4);

/* ====== Настройки IDLE-пауз ====== */
const IDLE_EVERY_MIN = Number(process.env.IDLE_EVERY_MIN || 3);     // кожні N хвилин
const IDLE_MIN_MS    = Number(process.env.IDLE_MIN_MS || 5000);     // мінімум "стояти"
const IDLE_MAX_MS    = Number(process.env.IDLE_MAX_MS || 20000);    // максимум "стояти"

/* ====== Настройки фейкових свайпів на "смертях" ====== */
const FAKE_SWIPE_DY    = Number(process.env.FAKE_SWIPE_DY || 140);
const FAKE_SWIPE_COUNT = Number(process.env.FAKE_SWIPE_COUNT || 1);
const FAKE_SWIPE_DUR   = Number(process.env.FAKE_SWIPE_DUR || 380);

// шанс зробити фейковий свайп на екрані де "dead"
const FAKE_SWIPE_PROB  = Number(process.env.FAKE_SWIPE_PROB || 0.3);

// рандомні хелпери
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randMs  = (min, max) => randInt(min, max);

const humanPause = async () => { await sleep(randInt(SCAN_PAUSE_MIN_MS, SCAN_PAUSE_MAX_MS)); };
const jitterPx  = (v) => v + randInt(-RAND_PX, RAND_PX);
const jitterDur = (ms=120) => Math.max(60, ms + randInt(-30, 30));

/* ===================== Логування (консоль + файл) ===================== */
const ACTION_LOG = [];
function logAction(type, detail) {
  const entry = { at: new Date().toISOString(), type, ...detail };
  ACTION_LOG.push(entry);
  const brief = JSON.stringify(detail);
  console.log(`[ACTION] ${type} ${brief.length > 200 ? brief.slice(0,200)+"…" : brief}`);
}
async function sleepLog(ms, reason = "") {
  logAction("sleep", { ms, reason });
  await sleep(ms);
}

/* ===================== CLI args ===================== */
function arg(name, def) {
  const a = process.argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split("=", 2)[1] : def;
}
const COUNT = Number(arg("count", "40"));

// позиційні аргументи для зон:
//   node src/index.js zone "Kingsland push" start
//   node src/index.js zone "Kingsland push" finish
const POSITIONAL = process.argv.slice(2);
let ZONE_MODE = null; // { name: <string>, mode: "start"|"finish" }
if (POSITIONAL[0] === "zone" && POSITIONAL.length >= 3) {
  const zName = POSITIONAL[1];
  const m = String(POSITIONAL[2] || "").toLowerCase();
  if (zName && (m === "start" || m === "finish")) {
    ZONE_MODE = { name: zName, mode: m };
    console.log(`Zone mode: "${zName}" → ${m}`);
  } else {
    console.warn(`Zone args ignored (expected: zone "<name>" start|finish)`);
  }
}

/* ===================== ADB & geometry ===================== */
function adbArgs(args) {
  const a = [];
  if (SERIAL) a.push("-s", SERIAL);
  a.push(...args);
  return a;
}

// Точний тап (ми юзаємо swipe x,y -> той самий x,y)
async function adbTapExact(x, y, durMs = 120, meta = {}) {
  const xx = Math.round(x);
  const yy = Math.round(y);
  const dd = Math.max(60, Math.round(durMs));
  logAction("tap", { x: xx, y: yy, durMs: dd, ...meta });
  await execa(
    ADB,
    adbArgs([
      "shell","input","swipe",
      String(xx), String(yy),
      String(xx), String(yy),
      String(dd)
    ]),
    { encoding: "buffer" }
  );
}

async function adbSwipe(x1, y1, x2, y2, durMs = 300, meta = {}) {
  const xx1 = Math.round(x1), yy1 = Math.round(y1);
  const xx2 = Math.round(x2), yy2 = Math.round(y2);
  const dd  = Math.max(80, Math.round(durMs));
  logAction("swipe", { from: { x: xx1, y: yy1 }, to: { x: xx2, y: yy2 }, durMs: dd, ...meta });
  await execa(
    ADB,
    adbArgs([
      "shell","input","swipe",
      String(xx1), String(yy1),
      String(xx2), String(yy2),
      String(dd)
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

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function clampToSafe(pt) {
  const x = clamp(pt.x, SAFE.left, SAFE.left + SAFE.width - 1);
  const y = clamp(pt.y, SAFE.top,  SAFE.top  + SAFE.height - 1);
  return { ...pt, x, y };
}

function hasRect(a) {
  return a
    && typeof a === "object"
    && Number.isFinite(a.left)
    && Number.isFinite(a.top)
    && Number.isFinite(a.width)
    && Number.isFinite(a.height);
}

function pickPointInRect(rect) {
  // випадкова точка всередині rect у рамках SAFE
  const x = rect.left + randInt(0, Math.max(0, rect.width  - 1));
  const y = rect.top  + randInt(0, Math.max(0, rect.height - 1));
  return clampToSafe({ x, y });
}

/* ===================== Fake swipe в блоці dead ===================== */
async function fakeSwipeInDead() {
  for (let i = 0; i < FAKE_SWIPE_COUNT; i++) {
    const x0 = SAFE.left + SAFE.width / 2 + randInt(-20, 20);
    const y0 = SAFE.top + SAFE.height / 2 + randInt(40, 80);
    await adbSwipe(
      x0, y0,
      x0, y0 - FAKE_SWIPE_DY,
      FAKE_SWIPE_DUR + randInt(-60, 60),
      { i }
    );
    await sleepLog(300 + randInt(0, 250), "after fake swipe");
  }
}

/* ===================== navigateHuman ===================== */
/**
 * Підтримує:
 *  - {type:"tap", x, y, durMs}
 *  - {type:"tap", rect:{left,top,width,height}, durMs}
 *  - {type:"tapRect", left, top, width, height, durMs}
 *  - масив таких дій
 */
async function navigateHuman(actionOrArray) {
  const doOne = async (a) => {
    if (!a || typeof a !== "object") return;

    // tap з вкладеним rect
    if (a.type === "tap" && a.rect && hasRect(a.rect)) {
      const p = pickPointInRect(a.rect);
      logAction("tapRect", { rect: a.rect, picked: p });
      await adbTapExact(p.x, p.y, a.durMs ?? 120);
      return;
    }

    // tapRect сам по собі
    if (a.type === "tapRect" && hasRect(a)) {
      const p = pickPointInRect(a);
      logAction("tapRect", { rect: a, picked: p });
      await adbTapExact(p.x, p.y, a.durMs ?? 120);
      return;
    }

    // звичайний tap x/y
    if (a.type === "tap" && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      const base = clampToSafe({ x: a.x, y: a.y });
      const j = RAND_PX
        ? clampToSafe({ x: jitterPx(base.x), y: jitterPx(base.y) })
        : base;
      await adbTapExact(j.x, j.y, jitterDur(a.durMs ?? 120));
      return;
    }

    // fallback — віддати в navigate(..) як було
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

/* ===================== OCR utils ===================== */
const DIGITS = "0123456789";
async function ocrField(key, buf) {
  const wl = key === "name" ? null : DIGITS;
  const txt = (await ocrBuffer(buf, wl)).trim();
  logAction("ocr", { key, text: txt });
  return txt;
}

/* ===================== Geometry (CH level col) ===================== */
// для визначення рівня City Hall (25 чи ні)
function rowRefY(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`ui.cityHallList.rows[${i}] missing`);
  if (r.rect && hasRect(r.rect)) return r.rect.top + r.rect.height / 2;
  if (Number.isFinite(r.y)) return r.y;
  throw new Error(`rows[${i}] must have either rect or y`);
}

function levelRectForRow(i) {
  const col = LIST.levelCol;
  if (!col?.left || !col?.width || !col?.height) {
    throw new Error("ui.json cityHallList.levelCol requires left,width,height");
  }

  const { left, width, height } = col;
  const safeTop = SAFE.top;
  const safeBottom = SAFE.top + SAFE.height;

  if (Number.isFinite(col.top0)) {
    const dy  = rowRefY(i) - rowRefY(0);
    const top = clamp(Math.round(col.top0 + dy), safeTop, safeBottom - height);
    return { left, top, width, height };
  }

  const off = Array.isArray(col.topOffset)
    ? (col.topOffset[i] ?? 0)
    : (col.topOffset ?? 0);

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

/* ===================== Profile screen detection ===================== */
function regionNameCenter() {
  const r = CFG?.pages?.[0]?.rois?.name;
  if (!r) return null;
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2)
  };
}
function actionCopyFromRegions() {
  return CFG?.pages?.[0]?.actions?.copyName || null;
}

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

  const powRaw    = rois.power ? (await ocrBuffer(rois.power, DIGITS)).trim() : "";
  const killsRaw  = rois.kills
    ? (await ocrBuffer(rois.kills, DIGITS)).trim()
    : (rois.kp
        ? (await ocrBuffer(rois.kp, DIGITS)).trim()
        : "");

  const pow   = Number((powRaw   || "").replace(/\D/g, ""));
  const kills = Number((killsRaw || "").replace(/\D/g, ""));
  return (Number.isFinite(pow) && pow > 1000) || (Number.isFinite(kills) && kills > 1000);
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

/* ===================== Row taps (supports rect) ===================== */
function rowPoint(i) {
  const r = LIST.rows[i];
  if (!r) throw new Error(`cityHallList.rows[${i}] missing`);
  if (r.rect && hasRect(r.rect)) {
    return pickPointInRect(r.rect); // випадкова точка всередині
  }
  return clampToSafe({ x: r.x, y: r.y });
}

async function openProfileFromRow(idx, retries = 2) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= LIST.rows.length) {
    console.warn(`   ! openProfileFromRow: idx ${idx} out of range`);
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

async function openProfileWithFallbacks(baseIdx = BASE_ROW_IDX) {
  const candidates = [baseIdx, baseIdx + 1, baseIdx + 2].filter(
    i => i < LIST.rows.length
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

/* ===================== Clipboard name capture ===================== */
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
  try { await clipboardy.write(""); } catch {}
}
async function clipboardGetHost() {
  try { return (await clipboardy.read()) ?? ""; } catch { return ""; }
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

// подвійний тап по імені з рандомною паузою, потім читаємо буфер
async function copyNameIntoTexts(texts) {
  await clipboardSetEmptyADB();
  let hostPrev = "";
  if (USE_HOST_CLIPBOARD) {
    await clipboardSetEmptyHost();
    hostPrev = await clipboardGetHost();
  }

  const action = actionCopyFromRegions() || FLOW.copyName;
  const p = regionNameCenter();

  // Тап #1
  if (action) {
    logAction("copyName-tap1", { action });
    await navigateHuman(action);
  } else if (p) {
    logAction("copyName-tap1", { point: p });
    await adbTapExact(p.x, p.y, 120);
  }

  // невеликий рандом до 1с
  await sleepLog(randMs(100, 1000), "between name taps");

  // Тап #2
  if (action) {
    logAction("copyName-tap2", { action });
    await navigateHuman(action);
  } else if (p) {
    logAction("copyName-tap2", { point: p });
    await adbTapExact(p.x, p.y, 120);
  }

  // дати грі час оновити буфер
  await sleepLog(T_OCR_NAME_GUESS + randInt(0, 120), "wait copyName");

  // пробуємо зчитати буфер
  let clip = await waitClipboardNonEmptyADB(T_CLIP_ADB, T_CLIP_STEP);
  if (!clip && USE_HOST_CLIPBOARD) {
    clip = await waitClipboardNonEmptyHost(hostPrev, T_CLIP_HOST, T_CLIP_STEP);
  }

  // fallback: longpress + COPY keyevent
  if (!clip && p) {
    try {
      const x = Math.round(p.x), y = Math.round(p.y);
      logAction("longpress", { x, y, dur: T_LONGPRESS });
      await execa(
        ADB,
        adbArgs([
          "shell","input","swipe",
          String(x), String(y),
          String(x), String(y),
          String(T_LONGPRESS + randInt(-60, 60))
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

/* ===================== Profile scan ===================== */
async function scanProfileOnce() {
  // додаткова пауза щоб екран профілю точно повністю відмалювався
  await sleepLog(PRE_SCAN_SETTLE_MS, "pre-scan settle");

  const texts = {};
  await copyNameIntoTexts(texts);
  await sleepLog(120 + randInt(0, 150), "after copyName");

  for (const page of CFG.pages) {
    // На "bottom" іноді робимо фейкові свайпи (імітуємо скрол смертей),
    // але не КОЖЕН раз, а тільки якщо пройшло FAKE_SWIPE_PROB
    if (page.name === "bottom") {
      if (Math.random() < FAKE_SWIPE_PROB) {
        await fakeSwipeInDead();
      }
    }

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
          // читаємо просто для логів
          await ocrField(k, buf);
        }
      } else {
        texts[k] = await ocrField(k, buf);
      }
      await sleepLog(randInt(20, 60), "between ocr fields");
    }

    if (page.nav) {
      logAction("page-nav", { page: page.name, nav: page.nav });
      await navigateHuman(page.nav);
      await sleepLog(T_SETTLE + randInt(0, 150), "after page nav");
    }
  }

  // safety: якщо id підглючив, перепробуємо верхню сторінку ще раз
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

  const parsed = parseStats(texts);
  logAction("scanProfileOnce-result", { parsed });
  return parsed;
}

/* ===================== Navigation (open/back/list checks) ===================== */
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

// повернення назад у список (закрити "мертві"/деталі → закрити повністю)
// тепер: подвійний тап по closeDeath
async function backToCityHallList() {
  // перший тап по кнопці, яка закриває блок зі смертями
  logAction("back", { step: "closeDeath#1" });
  await navigateHuman(FLOW.closeDeath);

  // рандомна пауза до 1с
  await sleepLog(randMs(100, 1000), "between closeDeath taps");

  // другий тап — якщо перший не спрацював / гра лагнула
  logAction("back", { step: "closeDeath#2" });
  await navigateHuman(FLOW.closeDeath);

  await sleepLog(T_SETTLE, "after closeDeath double tap");

  // потім звичайне закриття профілю
  logAction("back", { step: "closeProfile" });
  await navigateHuman(FLOW.closeProfile);
  await sleepLog(T_SETTLE, "after closeProfile");

  return true;
}

/* ===================== JSON backups ===================== */
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

/* ===================== IDLE-пауза раз на N хвилин ===================== */
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

/* ===================== Main ===================== */
async function main() {
  await initSchema();
  await initOCR();

  const active = await kvkActiveId();
  console.log(`Active KvK: ${active ?? "<none>"}`);

  const run_id = await beginRun();
  console.log(`Run: ${run_id} | CityHall25`);

  const backupAllPath = path.join(OUT_DIR, "players.json");
  const backupRunPath = path.join(OUT_DIR, `run-${run_id}.json`);
  await fs.writeFile(backupRunPath, "[]").catch(() => {});

  await openCityHallList();
  await humanPause();

  let visited = 0;

  // ---- ФАЗА 1: індекси 0..BASE_ROW_IDX-1 (типу "розігрів") ----
  for (
    let i = 0;
    i < Math.min(BASE_ROW_IDX, LIST.rows.length) && visited < COUNT;
    i++
  ) {
    await maybeIdlePause();

    // якщо це не останній рядок - перевіримо що там CH=25
    if (i < LIST.rows.length - 1) {
      const lvl = await readLevelAtRow(i);
      if (lvl !== 25) {
        console.log(`   Skip row ${i}: CH=${Number.isNaN(lvl) ? "?" : lvl}`);
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

    // профіль відкрито — скануємо
    const stats = await scanProfileOnce();
    const stamp = { run_id, at: new Date().toISOString(), stats };

    const pid = Number(String(stats?.id || "").replace(/\D/g, ""));
    if (Number.isFinite(pid) && String(pid).length >= 5) {
      console.log(`   Save ${pid} "${stats.name || ""}"`);
      logAction("save-player", { pid, name: stats.name || "" });
      await upsertPlayer({ id: pid, name: stats.name || "" });
      await insertStats(run_id, pid, stats);

      try {
        const res = await kvkEnsureGoal(pid);
        if (res) logAction("kvkEnsureGoal", { pid, res });
      } catch (e) {
        logAction("kvkEnsureGoal-error", { pid, error: e?.message || String(e) });
      }

      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    } else {
      console.warn("   ! No reliable player id recognized, skipped");
      logAction("save-skip-noid", { stats });
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

  // ---- ФАЗА 2: крутимось навколо BASE_ROW_IDX із fallback 6→7 ----
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

    const stats = await scanProfileOnce();
    const stamp = { run_id, at: new Date().toISOString(), stats };

    const pid = Number(String(stats?.id || "").replace(/\D/g, ""));
    if (Number.isFinite(pid) && String(pid).length >= 5) {
      console.log(`   Save ${pid} "${stats.name || ""}"`);
      logAction("save-player", { pid, name: stats.name || "" });
      await upsertPlayer({ id: pid, name: stats.name || "" });
      await insertStats(run_id, pid, stats);

      try {
        const res = await kvkEnsureGoal(pid);
        if (res) logAction("kvkEnsureGoal", { pid, res });
      } catch (e) {
        logAction("kvkEnsureGoal-error", { pid, error: e?.message || String(e) });
      }

      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    } else {
      console.warn("   ! No reliable player id recognized, skipped");
      logAction("save-skip-noid", { stats });
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
      console.log(`   Used fallback row ${usedIndex} → next loop presses base 5 again`);
      logAction("fallback-keep-base", { usedIndex });
    }
  }

  console.log(`\n✓ Done: visited ${visited} rows`);
  const actionsPath = path.join(OUT_DIR, `actions-run-${run_id}.json`);
  await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
  console.log(`Action log saved: ${path.relative(ROOT_DIR, actionsPath)}`);

  console.log(`Backups:\n  - ${path.relative(ROOT_DIR, backupAllPath)}\n  - ${path.relative(ROOT_DIR, backupRunPath)}`);

  // зона логіка (якщо запустили в режимі zone "..." start/finish)
  if (ZONE_MODE) {
    try {
      if (ZONE_MODE.mode === "start") {
        await zoneStart(ZONE_MODE.name, {
          run_id,
          visited,
          finished_at: new Date().toISOString()
        });
        console.log(`Zone "${ZONE_MODE.name}": START stored`);
      } else if (ZONE_MODE.mode === "finish") {
        await zoneFinish(ZONE_MODE.name, {
          run_id,
          visited,
          finished_at: new Date().toISOString()
        });
        console.log(`Zone "${ZONE_MODE.name}": FINISH stored`);
      }
      const zr = await getZone(ZONE_MODE.name);
      console.log("Zone record:", zr);
    } catch (e) {
      console.warn("Zone save error:", e?.message || String(e));
    }
  }

  await closeOCR();
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  try {
    const actionsPath = path.join(
      OUT_DIR,
      `actions-run-error-${Date.now()}.json`
    );
    await fs.writeFile(actionsPath, JSON.stringify(ACTION_LOG, null, 2));
    console.log(`Action log (error) saved: ${actionsPath}`);
  } catch {}
  await closeOCR().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});