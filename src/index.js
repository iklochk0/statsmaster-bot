// src/index.js
import "dotenv/config";
import fs from "fs/promises";
import { captureScreen } from "./capture.js";
import { cropRegions } from "./crop.js";
import { initOCR, ocrBuffer, closeOCR } from "./ocr.js";
import { parseStats } from "./parse.js";
import { navigate, sleep } from "./emu.js";
import { initSchema, beginRun, upsertPlayer, insertStats, closeDb } from "./db.pg.js";

const config = JSON.parse(
  await fs.readFile(new URL("./regions.json", import.meta.url), "utf-8")
);
const SCREEN = process.env.SCREEN_PATH || "./screenshots/screen.png";

const DIGITS = "0123456789";
const FIELD_WHITELIST = {
  id: DIGITS, power: DIGITS, kp: DIGITS, dead: DIGITS,
  t1: DIGITS, t2: DIGITS, t3: DIGITS, t4: DIGITS, t5: DIGITS
};

async function ocrField(key, buf) {
  // name — без whitelist; решта — тільки цифри
  const wl = key === "name" ? null : FIELD_WHITELIST[key] || null;
  const txt = (await ocrBuffer(buf, wl)).trim();
  console.log(`   OCR ${key}: "${txt}"${wl ? " [digits]" : ""}`);
  return txt;
}

async function scanAllPagesOnce() {
  const texts = {};
  for (const page of config.pages) {
    console.log(`\n→ Page: ${page.name}`);
    await captureScreen(SCREEN);

    const rois = await cropRegions(SCREEN, page.rois, `./screenshots/regions_${page.name}`);
    console.log("   Cropped:", Object.keys(rois));

    for (const [k, buf] of Object.entries(rois)) {
      texts[k] = await ocrField(k, buf);
    }

    if (page.nav) {
      await navigate(page.nav);
      await sleep(1200); // дай грі перемалюватись
    }
  }

  // Якщо id слабенько розпізнаний — одна спроба повтору з першої сторінки
  const idDigits = (texts.id || "").replace(/\D/g, "");
  if (!idDigits || idDigits.length < 5) {
    console.warn(" ! id OCR weak, retrying from top page...");
    // повторно знімаємо тільки першу сторінку
    const first = config.pages[0];
    await captureScreen(SCREEN);
    const roisTop = await cropRegions(SCREEN, first.rois, `./screenshots/retry_top`);
    if (roisTop.id) {
      const retry = (await ocrBuffer(roisTop.id, DIGITS)).trim();
      console.log(`   Retry id: "${retry}" [digits]`);
      texts.id = retry;
    }
  }

  return { texts, stats: parseStats(texts) }; // stats: {id,name,power,kp,dead,kills{t1..t5}}
}

async function main() {
  await initSchema();
  await initOCR();

  const run_id = await beginRun();
  console.log(`Run: ${run_id}`);

  const { texts, stats } = await scanAllPagesOnce();

  if (!stats.id) {
    // збережемо сире для дебага й впадемо
    await fs.mkdir("./out", { recursive: true });
    await fs.writeFile("./out/out.json", JSON.stringify({ run_id, at: new Date().toISOString(), raw: texts }, null, 2));
    throw new Error("No player id recognized");
  }

  await upsertPlayer({ id: stats.id, name: stats.name });
  await insertStats(run_id, stats.id, stats);

  await fs.mkdir("./out", { recursive: true });
  await fs.writeFile(
    "./out/out.json",
    JSON.stringify({ run_id, at: new Date().toISOString(), stats, raw: texts }, null, 2)
  );

  console.log("✓ Saved to Railway and out/out.json");

  await closeOCR();
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});