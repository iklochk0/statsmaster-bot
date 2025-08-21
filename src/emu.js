// src/emu.js
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
  await execa(
    ADB,
    adbArgs(["shell", "input", "tap", String(x), String(y)]),
    { encoding: "buffer" }
  );
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

/** Виконує дію навігації з regions/pages/ui.json */
export async function navigate(nav) {
  if (!nav) return;
  if (nav.type === "tap")   return tap(nav.x, nav.y);
  if (nav.type === "swipe") return swipe(nav.x1, nav.y1, nav.x2, nav.y2, nav.durMs || 300);
  throw new Error(`Unknown nav type: ${JSON.stringify(nav)}`);
}

/** Прочитати текст із буфера обміну Android (LDPlayer). Повертає "" якщо не вийшло. */
export async function getClipboardText() {
  // Сучасний шлях (Android 9+/LDPlayer9 зазвичай підтримує):
  try {
    const { stdout } = await execa(ADB, adbArgs(["shell", "cmd", "clipboard", "get"]), { encoding: "utf8" });
    return (stdout || "").trim();
  } catch {}
  // Давній шлях через service call (може повертати сирий binder-вивід — тоді ігноруємо):
  try {
    const { stdout } = await execa(ADB, adbArgs(["shell", "service", "call", "clipboard", "1"]), { encoding: "utf8" });
    const s = (stdout || "").trim();
    // Якщо там не зрозумілий binder-дамп — повернемо порожньо
    if (/Parcel|Result|data/gi.test(s) && !/^\w[\s\S]{0,200}$/.test(s)) return "";
    return s;
  } catch {}
  return "";
}