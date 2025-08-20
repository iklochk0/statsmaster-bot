import fs from "fs/promises";
import sharp from "sharp";

function validateRect(key, r, width, height) {
  const req = ["left","top","width","height"];
  for (const k of req) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) {
      throw new Error(`Region "${key}": ${k} is invalid: ${r[k]}`);
    }
  }
  if (r.left < 0 || r.top < 0 || r.width <= 0 || r.height <= 0) {
    throw new Error(`Region "${key}": negative or zero size: ${JSON.stringify(r)}`);
  }
  if (r.left + r.width > width || r.top + r.height > height) {
    throw new Error(
      `Region "${key}" out of bounds: ${JSON.stringify(r)} for image ${width}x${height}`
    );
  }
}

export async function cropRegions(screenPath, regions, outDir = "./screenshots/regions") {
  await fs.mkdir(outDir, { recursive: true });

  // Дізнаємось розмір зображення ОДИН раз
  const meta = await sharp(screenPath).metadata();
  console.log("Image size:", meta.width, "x", meta.height);

  const out = {};
  for (const [key, r] of Object.entries(regions)) {
    // Логи для дебага
    console.log("Cropping:", key, r);

    // Перевірка координат проти фактичного розміру екрану
    validateRect(key, r, meta.width, meta.height);

    // ВАЖЛИВО: новий sharp() КОЖНОГО разу
    const buf = await sharp(screenPath).extract({
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }).png().toBuffer();

    // Зберігаємо сирий кроп для візуальної перевірки
    await fs.writeFile(`${outDir}/${key}.png`, buf);

    // Підготовка для OCR: ч/б + нормалізація + масштаб ×2
    out[key] = await sharp(buf)
      .grayscale()
      .normalise()
      .resize({
        width: Math.round(r.width * 2),
        height: Math.round(r.height * 2),
        kernel: "nearest",
      })
      .toBuffer();
  }
  return out;
}
