// src/calibrate.js
import "dotenv/config";
import fs from "fs/promises";
import { captureScreen } from "../src/capture.js";
import { navigate, sleep } from "../src/emu.js";
import { markPoints } from "./mark.js";

const SCREEN = process.env.SCREEN_PATH || "../screenshots/screen.png";

// === СКОПІЙ сюди з index.js або поправ тут і потім перенеси назад ===
const UI = {
  settleMs: 700,
  openMyProfile: { type: "tap", x: 50, y: 50,  durMs: 120 }, // аватар
  openRankings:  { type: "tap", x: 300, y: 600, durMs: 120 }, // кнопка Rankings
  openCityHall:  { type: "tap", x: 1000, y: 400, durMs: 120 }, // плитка City Hall Level
  closeOverlay:  { type: "tap", x: 1155, y: 75, durMs: 120 }, // хрестик
  rows: [
    { tap: { x: 640, y: 220 } },
    { tap: { x: 640, y: 310 } },
    { tap: { x: 640, y: 390 } },
    { tap: { x: 640, y: 470 } },
    { tap: { x: 640, y: 550 } },
    { tap: { x: 640, y: 630 } }
  ]
};

async function main(){
  await fs.mkdir("./out", { recursive: true });

  // 1) Маркуємо місто (куди будемо тиснути "Профіль")
  await captureScreen(SCREEN);
  await markPoints(SCREEN, [
    { x:UI.openMyProfile.x, y:UI.openMyProfile.y, label:"profile" }
  ], "./out/00_city_marks.png");

  // 2) Пробний тап у місту -> Профіль
  await navigate(UI.openMyProfile); await sleep(UI.settleMs);
  await captureScreen("./out/01_after_profile.png");

  // 3) Маркуємо Профіль (кнопка Rankings)
  await markPoints("./out/01_after_profile.png", [
    { x:UI.openRankings.x, y:UI.openRankings.y, label:"rankings" },
    { x:UI.closeOverlay.x, y:UI.closeOverlay.y, label:"close" }
  ], "./out/01_profile_marks.png");

  // 4) Тап -> Rankings
  await navigate(UI.openRankings); await sleep(UI.settleMs);
  await captureScreen("./out/02_after_rankings.png");

  // 5) Маркуємо у Rankings плитку City Hall
  await markPoints("./out/02_after_rankings.png", [
    { x:UI.openCityHall.x, y:UI.openCityHall.y, label:"cityhall" },
    { x:UI.closeOverlay.x, y:UI.closeOverlay.y, label:"close" }
  ], "./out/02_rankings_marks.png");

  // 6) Тап -> City Hall Level
  await navigate(UI.openCityHall); await sleep(UI.settleMs);
  await captureScreen("./out/03_after_cityhall.png");

  // 7) Маркуємо 6 рядків списку
  const pts = UI.rows.map((r, i) => ({ x:r.tap.x, y:r.tap.y, label:`row${i}` }));
  pts.push({ x:UI.closeOverlay.x, y:UI.closeOverlay.y, label:"close" });
  await markPoints("./out/03_after_cityhall.png", pts, "./out/03_cityhall_marks.png");

  console.log("✓ Подивись файли у папці out/:");
  console.log("- 00_city_marks.png       (місто: куди тиснемо профіль)");
  console.log("- 01_after_profile.png    (екран профілю після тапа)");
  console.log("- 01_profile_marks.png    (марки на профілі)");
  console.log("- 02_after_rankings.png   (меню Rankings після тапа)");
  console.log("- 02_rankings_marks.png   (марки на Rankings)");
  console.log("- 03_after_cityhall.png   (список City Hall)");
  console.log("- 03_cityhall_marks.png   (марки рядків у списку)");
  console.log("\nЯкщо мітки не на кнопках — зсунь X/Y у UI і запусти ще раз.");
}

main().catch(e=>{ console.error(e); process.exit(1); });