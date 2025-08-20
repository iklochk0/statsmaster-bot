import { createWorker } from "tesseract.js";
let worker;
export async function initOCR(){ worker = await createWorker("eng"); }
export async function ocrBuffer(buf){ const { data:{ text } } = await worker.recognize(buf); return text; }
export async function closeOCR(){ await worker?.terminate(); }