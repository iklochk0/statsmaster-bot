// src/ocr.js
import { createWorker } from "tesseract.js";
let worker;

export async function initOCR() {
  worker = await createWorker("eng");
}

export async function ocrBuffer(buf, whitelist = null) {
  // виставляємо параметри перед кожним розпізнаванням
  await worker.setParameters({
    tessedit_char_whitelist: whitelist ?? "",           // порожньо = без обмежень
    classify_bln_numeric_mode: whitelist === "0123456789" ? "1" : "0"
  });
  const { data: { text } } = await worker.recognize(buf);
  return text;
}

export async function closeOCR() {
  await worker?.terminate();
}