// src/index.js — CH25 scanner: robust back + clipboard name (tap/longtap/menu or KEYCODE_COPY) + JSON backups
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execa } from "execa";

import { captureScreen } from "./capture.js";
import { cropRegions } from "./crop.js";
import { initOCR, ocrBuffer, closeOCR } from "./ocr.js";
import { parseStats } from "./parse.js";
import { navigate, sleep } from "./emu.js";
import { initSchema, beginRun, upsertPlayer, insertStats, closeDb } from "./db.pg.js";

// ----- paths
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, "..");
const OUT_DIR    = path.join(ROOT_DIR, "out");
await fs.mkdir(OUT_DIR, { recursive: true }).catch(()=>{});

// ----- ui.json
const UI   = JSON.parse(await fs.readFile(new URL("./ui.json", import.meta.url), "utf-8"));
const FLOW = UI.flow;
const LIST = UI.cityHallList;

// ----- regions/profile pages
const pagesCfg = JSON.parse(await fs.readFile(new URL("./regions.json", import.meta.url), "utf-8"));

// ----- consts
const SCREEN = process.env.SCREEN_PATH || path.join(ROOT_DIR, "screenshots", "screen.png");
const DIGITS = "0123456789";
const ADB    = process.env.ADB_BIN || "adb";
const SERIAL = process.env.ADB_SERIAL || "";  // наприклад 127.0.0.1:5555 для LDPlayer

// Anchor (можеш винести в ui.json→anchors.cityHall)
const ANCHOR_CITYHALL = UI.anchors?.cityHall ?? { left: 520, top: 110, width: 260, height: 60 };

// ----- CLI
function arg(name, def){
  const a = process.argv.find(s=>s.startsWith(`--${name}=`));
  return a ? a.split("=",2)[1] : def;
}
const COUNT = Number(arg("count","40"));
const START = Number(arg("start","0")) % LIST.rows.length;

// ----- helpers
function adbArgs(args){
  const a = [];
  if (SERIAL) a.push("-s", SERIAL);
  a.push(...args);
  return a;
}

async function sendKeyevent(code){
  try { await execa(ADB, adbArgs(["shell","input","keyevent", String(code)]), { encoding:"buffer" }); } catch {}
}

async function clipboardSetEmpty(){
  try { await execa(ADB, adbArgs(["shell","cmd","clipboard","set",""]), { encoding:"utf8" }); } catch {}
}
async function clipboardGet(){
  try {
    const { stdout } = await execa(ADB, adbArgs(["shell","cmd","clipboard","get"]), { encoding:"utf8" });
    return (stdout||"").trim();
  } catch { return ""; }
}

function nameTapPointFromRegions(){
  const r = pagesCfg?.pages?.[0]?.rois?.name;
  if (!r) return null;
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
}

async function ocrField(key, buf){
  const wl = key === "name" ? null : DIGITS;
  const txt = (await ocrBuffer(buf, wl)).trim();
  console.log(`   OCR ${key}: "${txt}"${wl ? " [digits]" : ""}`);
  return txt;
}

// rect для рівня по рядку (використовує top0 або topOffset)
function levelRectForRow(i){
  const col = LIST.levelCol;
  const rows = LIST.rows;
  if (!col?.left || !col?.width || !col?.height) throw new Error("ui.json cityHallList.levelCol requires left,width,height");
  if (!rows?.[i]) throw new Error(`ui.json cityHallList.rows[${i}] missing`);

  const { left, width, height } = col;
  if (Number.isFinite(col.top0)){
    const dy = rows[i].y - rows[0].y;
    const top = Math.max(0, Math.min(720 - height, Math.round(col.top0 + dy)));
    return { left, top, width, height };
  }
  const off = Array.isArray(col.topOffset) ? (col.topOffset[i] ?? 0) : (col.topOffset ?? 0);
  const top = Math.max(0, Math.min(720 - height, Math.round(rows[i].y + off - height/2)));
  return { left, top, width, height };
}

async function readLevelAtRow(i){
  const rect = levelRectForRow(i);
  await captureScreen(SCREEN);
  const key = `lv_r${i}`;
  const outDir = path.join(ROOT_DIR, "screenshots", "ch_levels");
  const piece = await cropRegions(SCREEN, { [key]: rect }, outDir);
  const buf = piece[key];
  if (buf) await fs.writeFile(path.join(outDir, `${key}.png`), buf);
  const raw = buf ? (await ocrBuffer(buf, DIGITS)).trim() : "";
  const n = Number((raw||"").replace(/\D/g,""));
  console.log(` - Row ${i}: rect=${JSON.stringify(rect)} OCR="${raw}" -> ${n}`);
  return Number.isFinite(n) ? n : NaN;
}

// копіюємо ім'я: tap → clipboard; якщо пусто: longtap → (copyName tap | KEYCODE_COPY)
async function copyNameIntoTexts(texts){
  const p = nameTapPointFromRegions();
  if (!p) return;

  await clipboardSetEmpty();
  await navigate({ type:"tap", x:p.x, y:p.y, durMs:120 });
  await sleep(300);

  let clip = await clipboardGet();
  if (!clip){
    // long-press to open context menu
    try { await execa(ADB, adbArgs(["shell","input","swipe", String(p.x),String(p.y), String(p.x),String(p.y), "350"]), { encoding:"buffer" }); } catch {}
    await sleep(250);

    if (FLOW.copyName){
      await navigate(FLOW.copyName);
      await sleep(250);
    } else {
      await sendKeyevent(279); // KEYCODE_COPY
      await sleep(200);
    }
    clip = await clipboardGet();
  }

  if (clip){
    console.log(`   Clipboard name: "${clip}"`);
    texts.name = clip;
  }
}

// повний скан профілю (3 сторінки) + копіювання імені
async function scanProfileOnce(){
  const texts = {};

  // копіюємо ім'я ДО OCR (щоб не втратився контекст)
  await copyNameIntoTexts(texts);

  for (const page of pagesCfg.pages){
    await captureScreen(SCREEN);
    const rois = await cropRegions(SCREEN, page.rois, path.join(ROOT_DIR, `screenshots`, `regions_${page.name}`));
    for (const [k, buf] of Object.entries(rois)) texts[k] = await ocrField(k, buf);
    if (page.nav){ await navigate(page.nav); await sleep(FLOW.settleMs || 700); }
  }

  // якщо id слабкий — повторна спроба з топ сторінки
  const idDigits = (texts.id || "").replace(/\D/g,"");
  if (!idDigits || idDigits.length < 5){
    const first = pagesCfg.pages[0];
    await captureScreen(SCREEN);
    const roisTop = await cropRegions(SCREEN, first.rois, path.join(ROOT_DIR, "screenshots", "retry_top"));
    if (roisTop.id) texts.id = (await ocrBuffer(roisTop.id, DIGITS)).trim();
  }

  return parseStats(texts);
}

// профіль → Rankings → City Hall
async function openCityHallList(){
  await navigate(FLOW.openMyProfile); await sleep(FLOW.settleMs);
  await navigate(FLOW.openRankings);  await sleep(FLOW.settleMs);
  await navigate(FLOW.openCityHall);  await sleep(FLOW.settleMs);
}

// перевірка що ми в списку
async function isCityHallList(){
  await captureScreen(SCREEN);
  const piece = await cropRegions(SCREEN, { hdr: ANCHOR_CITYHALL }, path.join(ROOT_DIR, "screenshots", "anchors"));
  const buf = piece.hdr;
  const txt = buf ? (await ocrBuffer(buf, null)).toLowerCase() : "";
  return txt.includes("city") && txt.includes("hall");
}

// повернення: два різні X, якщо не спрацювало — форс-пере-відкриття списку
async function backToCityHallList(){
  await navigate(FLOW.closeDeath);
  await sleep((FLOW.settleMs||700) + 150);
  await navigate(FLOW.closeProfile);
  await sleep((FLOW.settleMs||700) + 250);

  if (await isCityHallList()) return true;

  // fallback
  await navigate(FLOW.openRankings);  await sleep(FLOW.settleMs);
  await navigate(FLOW.openCityHall);  await sleep(FLOW.settleMs);
  return await isCityHallList();
}

// JSON backup utils
async function readBackupArray(filePath){
  try { const txt = await fs.readFile(filePath, "utf-8"); const arr = JSON.parse(txt); return Array.isArray(arr)?arr:[]; }
  catch { return []; }
}
async function appendBackup(filePath, record){
  await fs.mkdir(path.dirname(filePath), { recursive:true });
  const arr = await readBackupArray(filePath);
  arr.push(record);
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
}

// main
async function main(){
  await initSchema();
  await initOCR();

  const run_id = await beginRun();
  console.log(`Run: ${run_id} | CityHall25`);

  const backupAllPath = path.join(OUT_DIR, "players.json");
  const backupRunPath = path.join(OUT_DIR, `run-${run_id}.json`);
  await fs.writeFile(backupRunPath, "[]").catch(()=>{});

  await openCityHallList();

  let seen = 0;
  let idx = START;
  const jitter = ()=> 150 + Math.floor(Math.random()*250);

  while (seen < COUNT){
    const row = LIST.rows[idx];

    const lvl = await readLevelAtRow(idx);
    const is25 = (lvl === 25);

    if (is25){
      console.log(` → Tap row ${idx} (CH25)`);
      await navigate({ type:"tap", x:row.x, y:row.y, durMs:120 });
      await sleep((FLOW.settleMs||700) + jitter());

      const stats = await scanProfileOnce();
      const stamp = { run_id, at:new Date().toISOString(), stats };

      if (stats?.id){
        console.log(`   Save ${stats.id} "${stats.name}"`);
        await upsertPlayer({ id: stats.id, name: stats.name });
        await insertStats(run_id, stats.id, stats);
        await appendBackup(backupAllPath, stamp);
        await appendBackup(backupRunPath, stamp);
      } else {
        console.warn("   ! No player id recognized, skipped");
      }

      const ok = await backToCityHallList();
      if (!ok){
        console.warn("   ! Не вдалося повернутися до City Hall списку — стоп");
        break;
      }
      seen++;
    } else {
      console.log(`   Skip row ${idx}: CH=${Number.isNaN(lvl) ? "?" : lvl}`);
      await sleep(200 + jitter());
      seen++;
    }

    // крутимо тільки в межах того, що у тебе в ui.json (0..rows.length-1)
    idx = (idx + 1) % LIST.rows.length;
  }

  console.log(`\n✓ Done: visited ${seen} rows\nBackups:\n  - ${path.relative(ROOT_DIR, backupAllPath)}\n  - ${path.relative(ROOT_DIR, backupRunPath)}`);
  await closeOCR();
  await closeDb();
}

main().catch(async (e)=>{
  console.error(e);
  await closeOCR().catch(()=>{});
  await closeDb().catch(()=>{});
  process.exit(1);
});