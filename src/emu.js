import { execa } from "execa";

const ADB = process.env.ADB_BIN || "adb";
const SERIAL = process.env.ADB_SERIAL || "";

function adbArgs(args) {
  const a = [];
  if (SERIAL) a.push("-s", SERIAL);
  a.push(...args);
  return a;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function tap(x, y) {
  await execa(ADB, adbArgs(["shell", "input", "tap", String(x), String(y)]), { encoding: "buffer" });
}

export async function swipe(x1, y1, x2, y2, durMs = 300) {
  await execa(
    ADB,
    adbArgs(["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durMs)]),
    { encoding: "buffer" }
  );
}

export async function back() {
  await execa(ADB, adbArgs(["shell", "input", "keyevent", "4"]), { encoding: "buffer" }); // KEYCODE_BACK
}

export async function home() {
  await execa(ADB, adbArgs(["shell", "input", "keyevent", "3"]), { encoding: "buffer" }); // KEYCODE_HOME
}

/** Виконує дію навігації з regions.pages[i].nav */
export async function navigate(nav) {
  if (!nav) return;
  if (nav.type === "tap")  { return tap(nav.x, nav.y); }
  if (nav.type === "swipe"){ return swipe(nav.x1, nav.y1, nav.x2, nav.y2, nav.durMs || 300); }
  throw new Error(`Unknown nav type: ${JSON.stringify(nav)}`);
}