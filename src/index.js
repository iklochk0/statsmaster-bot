import "dotenv/config";
import fs from "fs/promises";
import { captureScreen } from "./capture.js";
import { cropRegions } from "./crop.js";
import { initOCR, ocrBuffer, closeOCR } from "./ocr.js";
import { parseStats } from "./parse.js";
import { navigate } from "./emu.js";

const regions = JSON.parse(
  await fs.readFile(new URL("./regions.json", import.meta.url), "utf-8")
);

const SCREEN = process.env.SCREEN_PATH || "./screenshots/screen.png";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  await initOCR();
  console.log("• Capturing...");

  const allTexts = {};

  for (const page of regions.pages) {
    console.log(`→ Page: ${page.name}`);

    // 1. Скрин
    await captureScreen(SCREEN);

    // 2. Кроп
    const rois = await cropRegions(SCREEN, page.rois);
    console.log("   Cropped:", Object.keys(rois));

    // 3. OCR
    for (const [k, buf] of Object.entries(rois)) {
      allTexts[k] = (await ocrBuffer(buf)).trim();
    }

    // 4. Навігація (якщо задана)
    if (page.nav) {
      console.log("   Navigating:", page.nav);
      await navigate(page.nav);
      await sleep(1200); // невелика пауза щоб оновився екран
    }
  }

  // 5. Парсинг
  const stats = parseStats(allTexts);

  await fs.mkdir("./out", { recursive: true });
  await fs.writeFile(
    "./out/out.json",
    JSON.stringify({ at: new Date().toISOString(), stats, raw: allTexts }, null, 2)
  );

  console.log("✓ out/out.json ready");
  await closeOCR();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});