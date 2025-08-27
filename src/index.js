// src/index.js — CH25 scanner: ordered warmup (1→4) then ghost-skip base (5→6→7→back→5)
// + humanized timing + robust back + clipboard name + JSON backups

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
  closeDb
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
const SERIAL      = process.env.ADB_SERIAL || "";  // e.g. 127.0.0.1:5555
const USE_HOST_CLIPBOARD = process.env.USE_HOST_CLIPBOARD !== "false"; // default true

const ANCHOR_CITYHALL = UI.anchors?.cityHall ?? { left: 520, top: 110, width: 260, height: 60 };

/* ===================== Tunables (timings & humanization) ===================== */
const T_SETTLE = Number(FLOW.settleMs ?? 700);
const T_JITTER   = () => 150 + Math.floor(Math.random() * 250);
const T_OCR_NAME_GUESS = 220;
const T_CLIP_STEP = 180;
const T_CLIP_ADB  = 2500;
const T_CLIP_HOST = 3000;
const T_LONGPRESS = 360;

const SCAN_PAUSE_MIN_MS = Number(process.env.SCAN_PAUSE_MIN_MS || 900);
const SCAN_PAUSE_MAX_MS = Number(process.env.SCAN_PAUSE_MAX_MS || 1800);

const RAND_PX = Number(process.env.RAND_PX || 3);

// 0-based: 4 означає 5-та позиція
const BASE_ROW_IDX = Number(process.env.BASE_ROW_IDX ?? 4);

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanPause = async () => { await sleep(randInt(SCAN_PAUSE_MIN_MS, SCAN_PAUSE_MAX_MS)); };
const jitterPx = (v) => v + randInt(-RAND_PX, RAND_PX);
const jitterDur = (ms=120) => Math.max(60, ms + randInt(-30, 30));

/* ===================== CLI args ===================== */
function arg(name, def) {
  const a = process.argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split("=", 2)[1] : def;
}
const COUNT = Number(arg("count", "40"));

/* ===================== Humanized navigate wrapper ===================== */
async function navigateHuman(actionOrArray) {
  const massage = (a) => {
    if (!a || typeof a !== "object") return a;
    if (a.type === "tap" && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      return { ...a, x: jitterPx(a.x), y: jitterPx(a.y), durMs: jitterDur(a.durMs ?? 120) };
    }
    return a;
  };

  if (Array.isArray(actionOrArray)) {
    const seq = actionOrArray.map(massage);
    await navigate(seq);
  } else {
    await navigate(massage(actionOrArray));
  }
}

/* ===================== Helpers: ADB & Clipboard ===================== */
function adbArgs(args) {
  const a = [];
  if (SERIAL) a.push("-s", SERIAL);
  a.push(...args);
  return a;
}
async function sendKeyevent(code) {
  try { await execa(ADB, adbArgs(["shell", "input", "keyevent", String(code)]), { encoding: "buffer" }); } catch {}
}
async function clipboardSetEmptyADB() {
  try { await execa(ADB, adbArgs(["shell", "cmd", "clipboard", "set", ""]), { encoding: "utf8" }); } catch {}
}
async function clipboardGetADB() {
  try {
    const { stdout } = await execa(ADB, adbArgs(["shell", "cmd", "clipboard", "get"]), { encoding: "utf8" });
    return (stdout || "").trim();
  } catch { return ""; }
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
async function clipboardSetEmptyHost() { try { await clipboardy.write(""); } catch {} }
async function clipboardGetHost() { try { return (await clipboardy.read()) ?? ""; } catch { return ""; } }
async function waitClipboardNonEmptyHost(prev = "", maxMs = T_CLIP_HOST, stepMs = T_CLIP_STEP) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const t = await clipboardGetHost();
    if (t && t !== prev) return t;
    await sleep(stepMs);
  }
  return "";
}

/* ===================== OCR utils ===================== */
const DIGITS = "0123456789";
async function ocrField(key, buf) {
  const wl = key === "name" ? null : DIGITS;
  const txt = (await ocrBuffer(buf, wl)).trim();
  console.log(`   OCR ${key}: "${txt}"${wl ? " [digits]" : ""}`);
  return txt;
}

/* ===================== Geometry (CH level col) ===================== */
function levelRectForRow(i) {
  const col = LIST.levelCol;
  const rows = LIST.rows;
  if (!col?.left || !col?.width || !col?.height) throw new Error("ui.json cityHallList.levelCol requires left,width,height");
  if (!rows?.[i]) throw new Error(`ui.json cityHallList.rows[${i}] missing`);

  const { left, width, height } = col;

  if (Number.isFinite(col.top0)) {
    const dy  = rows[i].y - rows[0].y;
    const top = Math.max(0, Math.min(720 - height, Math.round(col.top0 + dy)));
    return { left, top, width, height };
  }

  const off = Array.isArray(col.topOffset) ? (col.topOffset[i] ?? 0) : (col.topOffset ?? 0);
  const top = Math.max(0, Math.min(720 - height, Math.round(rows[i].y + off - height / 2)));
  return { left, top, width, height };
}

async function readLevelAtRow(i) {
  await sleep(50 + randInt(0, 90));
  const rect = levelRectForRow(i);
  await captureScreen(SCREEN_PATH);
  const key = `lv_r${i}`;
  const outDir = path.join(ROOT_DIR, "screenshots", "ch_levels");
  const piece = await cropRegions(SCREEN_PATH, { [key]: rect }, outDir);
  const buf = piece[key];
  if (buf) await fs.writeFile(path.join(outDir, `${key}.png`), buf);
  const raw = buf ? (await ocrBuffer(buf, DIGITS)).trim() : "";
  const n = Number((raw || "").replace(/\D/g, ""));
  console.log(` - Row ${i}: rect=${JSON.stringify(rect)} OCR="${raw}" -> ${n}`);
  return Number.isFinite(n) ? n : NaN;
}

/* ===================== Profile detection ===================== */
function regionNameCenter() {
  const r = CFG?.pages?.[0]?.rois?.name;
  if (!r) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}
function actionCopyFromRegions() { return CFG?.pages?.[0]?.actions?.copyName || null; }

async function isProfileScreen() {
  await captureScreen(SCREEN_PATH);
  const top = CFG.pages[0];
  const rois = await cropRegions(SCREEN_PATH, top.rois, path.join(ROOT_DIR, "screenshots", "probe_profile"));

  const idRaw = rois.id ? (await ocrBuffer(rois.id, DIGITS)).trim() : "";
  const idDigits = (idRaw || "").replace(/\D/g, "");
  if (idDigits.length >= 5) return true;

  const powRaw = rois.power ? (await ocrBuffer(rois.power, DIGITS)).trim() : "";
  const kpRaw  = rois.kp    ? (await ocrBuffer(rois.kp,    DIGITS)).trim() : "";
  const pow = Number((powRaw || "").replace(/\D/g, ""));
  const kp  = Number((kpRaw  || "").replace(/\D/g, ""));
  return (Number.isFinite(pow) && pow > 1000) || (Number.isFinite(kp) && kp > 1000);
}

async function waitProfileOrGiveUp(timeoutMs = 3200, pollMs = 250) {
  const end = Date.now() + timeoutMs;
  await sleep(120);
  while (Date.now() < end) {
    if (await isProfileScreen()) return true;
    if (await isCityHallList()) { await sleep(pollMs); continue; }
    await sleep(pollMs);
  }
  return false;
}

/* Тап по конкретному рядку з кількома спробами */
async function openProfileFromRow(idx, retries = 2) {
  const row = LIST.rows[idx];
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(` → Tap row ${idx} (attempt ${attempt}/${retries})`);
    await navigateHuman({ type: "tap", x: row.x, y: row.y, durMs: 120 });
    await sleep(T_SETTLE + T_JITTER());
    if (await waitProfileOrGiveUp(3200, 250)) return true;
    await sleep(200 + randInt(0, 200));
  }
  return false;
}

/* Спробувати 5 → 6 → 7; повертає {opened, usedIndex} */
async function openProfileWithFallbacks(baseIdx = BASE_ROW_IDX) {
  const candidates = [baseIdx, baseIdx + 1, baseIdx + 2].filter(i => i < LIST.rows.length);
  for (const i of candidates) {
    const ok = await openProfileFromRow(i, i === baseIdx ? 3 : 2);
    if (ok) return { opened: true, usedIndex: i };
  }
  return { opened: false, usedIndex: -1 };
}

/* ===================== Clipboard name capture ===================== */
async function copyNameIntoTexts(texts) {
  await clipboardSetEmptyADB();
  let hostPrev = "";
  if (USE_HOST_CLIPBOARD) {
    await clipboardSetEmptyHost();
    hostPrev = await clipboardGetHost();
  }

  const action = actionCopyFromRegions() || FLOW.copyName;
  const p = regionNameCenter();
  if (action) {
    await navigateHuman(action);
  } else if (p) {
    await navigateHuman({ type: "tap", x: p.x, y: p.y, durMs: 120 });
  }
  await sleep(T_OCR_NAME_GUESS + randInt(0, 120));

  let clip = await waitClipboardNonEmptyADB(T_CLIP_ADB, T_CLIP_STEP);
  if (!clip && USE_HOST_CLIPBOARD) {
    clip = await waitClipboardNonEmptyHost(hostPrev, T_CLIP_HOST, T_CLIP_STEP);
  }

  if (!clip && p) {
    try {
      await execa(ADB, adbArgs([
        "shell","input","swipe",
        String(jitterPx(p.x)), String(jitterPx(p.y)),
        String(jitterPx(p.x)), String(jitterPx(p.y)),
        String(T_LONGPRESS + randInt(-60, 60))
      ]), { encoding: "buffer" });
    } catch {}
    await sleep(200 + randInt(0, 120));
    await sendKeyevent(278); // KEYCODE_COPY
    clip = await waitClipboardNonEmptyADB(2000, 180);
    if (!clip && USE_HOST_CLIPBOARD) {
      clip = await waitClipboardNonEmptyHost(hostPrev, 2500, 200);
    }
  }

  if (clip) {
    console.log(`   Clipboard name: "${clip}"`);
    texts.name = clip;
  } else {
    console.log("   Clipboard name: <empty>");
  }
}

/* ===================== Profile scan ===================== */
async function scanProfileOnce() {
  const texts = {};
  await copyNameIntoTexts(texts);
  await sleep(120 + randInt(0, 150));

  for (const page of CFG.pages) {
    await captureScreen(SCREEN_PATH);
    const rois = await cropRegions(SCREEN_PATH, page.rois, path.join(ROOT_DIR, "screenshots", `regions_${page.name}`));
    for (const [k, buf] of Object.entries(rois)) {
      if (k === "name") {
        if (!texts.name) {
          const guess = await ocrField(k, buf);
          if (guess) texts.name = guess;
        } else {
          await ocrField(k, buf);
        }
      } else {
        texts[k] = await ocrField(k, buf);
      }
      await sleep(randInt(20, 60));
    }
    if (page.nav) {
      await navigateHuman(page.nav);
      await sleep(T_SETTLE + randInt(0, 150));
    }
  }

  const idDigits = (texts.id || "").replace(/\D/g, "");
  if (!idDigits || idDigits.length < 5) {
    const first = CFG.pages[0];
    await captureScreen(SCREEN_PATH);
    const roisTop = await cropRegions(SCREEN_PATH, first.rois, path.join(ROOT_DIR, "screenshots", "retry_top"));
    if (roisTop.id) texts.id = (await ocrBuffer(roisTop.id, DIGITS)).trim();
  }

  return parseStats(texts);
}

/* ===================== Navigation (open/back/list checks) ===================== */
async function openCityHallList() {
  await navigateHuman(FLOW.openMyProfile); await sleep(T_SETTLE + randInt(0, 120));
  await navigateHuman(FLOW.openRankings);  await sleep(T_SETTLE + randInt(0, 120));
  await navigateHuman(FLOW.openCityHall);  await sleep(T_SETTLE + randInt(0, 120));
}

async function isCityHallByHeader() {
  await captureScreen(SCREEN_PATH);
  const piece = await cropRegions(SCREEN_PATH, { hdr: ANCHOR_CITYHALL }, path.join(ROOT_DIR, "screenshots", "anchors"));
  const buf = piece.hdr;
  const txt = buf ? (await ocrBuffer(buf, null)).toLowerCase() : "";
  return txt.includes("city") && txt.includes("hall");
}
async function isCityHallByLevel() {
  const n = await readLevelAtRow(0);
  return Number.isFinite(n) && n >= 1 && n <= 25;
}
async function isCityHallList() {
  return (await isCityHallByHeader()) || (await isCityHallByLevel());
}

async function backToCityHallList() {
  const tryOnce = async () => {
    await navigateHuman(FLOW.closeDeath);
    await sleep(T_SETTLE + 200 + randInt(0, 120));
    await navigateHuman(FLOW.closeProfile);
    await sleep(T_SETTLE + 300 + randInt(0, 120));
    return await isCityHallList();
  };

  if (await tryOnce()) return true;

  await navigateHuman(FLOW.openRankings);  await sleep(T_SETTLE + randInt(0, 120));
  await navigateHuman(FLOW.openCityHall);  await sleep(T_SETTLE + randInt(0, 120));

  if (await isCityHallList()) return true;

  await sleep(300 + randInt(0, 180));
  return await tryOnce();
}

/* ===================== JSON backups ===================== */
async function readBackupArray(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function appendBackup(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const arr = await readBackupArray(filePath);
  arr.push(record);
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
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

  /* ---- ФАЗА 1: Прохід 1→4 (індекси 0..BASE_ROW_IDX-1) у строгому порядку ---- */
  for (let i = 0; i < Math.min(BASE_ROW_IDX, LIST.rows.length) && visited < COUNT; i++) {
    // якщо це не останній видимий рядок — перевіримо CH рівень і, якщо не 25, скіпнемо
    if (i < LIST.rows.length - 1) {
      const lvl = await readLevelAtRow(i);
      if (lvl !== 25) {
        console.log(`   Skip row ${i}: CH=${Number.isNaN(lvl) ? "?" : lvl}`);
        await sleep(200 + T_JITTER());
        visited++;
        await humanPause();
        continue;
      }
    }

    const opened = await openProfileFromRow(i, 3);
    if (!opened) {
      console.warn(`   ! Row ${i} did not open — skip`);
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
      await upsertPlayer({ id: pid, name: stats.name || "" });
      await insertStats(run_id, pid, stats);
      try { const res = await kvkEnsureGoal(pid); if (res) console.log(`   KvK goal ensured for ${pid}`); } catch {}
      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    } else {
      console.warn("   ! No reliable player id recognized, skipped");
    }

    const ok = await backToCityHallList();
    if (!ok) { console.warn("   ! Can't return to list — stop"); break; }

    visited++;
    await humanPause();
  }

  /* ---- ФАЗА 2: Базовий цикл із 5-ю позицією та резервами 6→7 ---- */
  while (visited < COUNT) {
    const { opened, usedIndex } = await openProfileWithFallbacks(BASE_ROW_IDX);
    if (!opened) {
      console.warn("   ! Ghost chain (5/6/7) — skip this slot");
      visited++;
      await humanPause();
      continue;
    }

    const stats = await scanProfileOnce();
    const stamp = { run_id, at: new Date().toISOString(), stats };

    const pid = Number(String(stats?.id || "").replace(/\D/g, ""));
    if (Number.isFinite(pid) && String(pid).length >= 5) {
      console.log(`   Save ${pid} "${stats.name || ""}"`);
      await upsertPlayer({ id: pid, name: stats.name || "" });
      await insertStats(run_id, pid, stats);
      try { const res = await kvkEnsureGoal(pid); if (res) console.log(`   KvK goal ensured for ${pid}`); } catch {}
      await appendBackup(backupAllPath, stamp);
      await appendBackup(backupRunPath, stamp);
    } else {
      console.warn("   ! No reliable player id recognized, skipped");
    }

    const ok = await backToCityHallList();
    if (!ok) { console.warn("   ! Can't return to list — stop"); break; }

    visited++;
    await humanPause();

    if (usedIndex !== BASE_ROW_IDX) {
      console.log(`   Used fallback row ${usedIndex} → next loop presses base 5 again`);
    }
  }

  console.log(`\n✓ Done: visited ${visited} rows\nBackups:\n  - ${path.relative(ROOT_DIR, backupAllPath)}\n  - ${path.relative(ROOT_DIR, backupRunPath)}`);
  await closeOCR();
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeOCR().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});