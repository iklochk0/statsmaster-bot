import { execa } from "execa";
import fs from "fs/promises";
const ADB = process.env.ADB_BIN || "adb";
export async function captureScreen(outPath) {
  const { stdout } = await execa(ADB, ["exec-out", "screencap", "-p"], { encoding: "buffer" });
  await fs.mkdir("./screenshots", { recursive: true });
  await fs.writeFile(outPath, stdout);
  return outPath;
}