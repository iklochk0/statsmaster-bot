import "dotenv/config";
import fs from "fs/promises";
import { captureScreen } from "../src/capture.js";
import { navigate, sleep } from "../src/emu.js";
import { markPoints } from "./mark.js";

const SCREEN = process.env.SCREEN_PATH || "../screenshots/screen.png";

const UI = {
  settleMs: 700,
  openMyProfile: { type: "tap", x: 50, y: 50, durMs: 120 },
  openRankings: { type: "tap", x: 300, y: 600, durMs: 120 },
  openCityHall: { type: "tap", x: 1000, y: 400, durMs: 120 },
  closeOverlay: { type: "tap", x: 1155, y: 75, durMs: 120 },
  rows: [
    { tap: { x: 640, y: 220 } },
    { tap: { x: 640, y: 310 } },
    { tap: { x: 640, y: 390 } },
    { tap: { x: 640, y: 470 } },
    { tap: { x: 640, y: 550 } },
    { tap: { x: 640, y: 630 } },
  ],
};

async function main() {
  await fs.mkdir("./out", { recursive: true });

  await captureScreen(SCREEN);
  await markPoints(
    SCREEN,
    [{ x: UI.openMyProfile.x, y: UI.openMyProfile.y, label: "profile" }],
    "./out/00_city_marks.png"
  );

  await navigate(UI.openMyProfile);
  await sleep(UI.settleMs);
  await captureScreen("./out/01_after_profile.png");

  await markPoints(
    "./out/01_after_profile.png",
    [
      { x: UI.openRankings.x, y: UI.openRankings.y, label: "rankings" },
      { x: UI.closeOverlay.x, y: UI.closeOverlay.y, label: "close" },
    ],
    "./out/01_profile_marks.png"
  );

  await navigate(UI.openRankings);
  await sleep(UI.settleMs);
  await captureScreen("./out/02_after_rankings.png");

  await markPoints(
    "./out/02_after_rankings.png",
    [
      { x: UI.openCityHall.x, y: UI.openCityHall.y, label: "cityhall" },
      { x: UI.closeOverlay.x, y: UI.closeOverlay.y, label: "close" },
    ],
    "./out/02_rankings_marks.png"
  );

  await navigate(UI.openCityHall);
  await sleep(UI.settleMs);
  await captureScreen("./out/03_after_cityhall.png");

  const pts = UI.rows.map((r, i) => ({
    x: r.tap.x,
    y: r.tap.y,
    label: `row${i}`,
  }));
  pts.push({ x: UI.closeOverlay.x, y: UI.closeOverlay.y, label: "close" });
  await markPoints("./out/03_after_cityhall.png", pts, "./out/03_cityhall_marks.png");

  console.log("Calibration screenshots written to out/:");
  console.log("- 00_city_marks.png");
  console.log("- 01_after_profile.png");
  console.log("- 01_profile_marks.png");
  console.log("- 02_after_rankings.png");
  console.log("- 02_rankings_marks.png");
  console.log("- 03_after_cityhall.png");
  console.log("- 03_cityhall_marks.png");
  console.log("\nAdjust UI coordinates and rerun if markers are off target.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
