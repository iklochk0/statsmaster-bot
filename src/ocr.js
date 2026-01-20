// src/ocr.js
import { createWorker } from "tesseract.js";
let worker;
let lastWhitelist = null;

export async function initOCR() {
  worker = await createWorker("eng");
}

export async function ocrBuffer(buf, whitelist = null) {
  const nextWhitelist = whitelist ?? "";
  if (nextWhitelist !== lastWhitelist) {
    await worker.setParameters({
      tessedit_char_whitelist: nextWhitelist,
      classify_bln_numeric_mode: nextWhitelist === "0123456789" ? "1" : "0",
    });
    lastWhitelist = nextWhitelist;
  }
  const { data: { text } } = await worker.recognize(buf);
  return text;
}

export async function closeOCR() {
  await worker?.terminate();
}
