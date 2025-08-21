// src/mark.js
import sharp from "sharp";

/**
 * Малює червоні точки + підпис на скріншоті.
 * pts: [{x,y,label}] у пікселях екрану 1280x720
 */
export async function markPoints(inputPngPath, pts, outPngPath){
  const { width, height } = await sharp(inputPngPath).metadata();
  const circles = pts.map(p => `
    <circle cx="${p.x}" cy="${p.y}" r="12" fill="none" stroke="red" stroke-width="4"/>
    <text x="${p.x+16}" y="${p.y-12}" fill="red" font-size="28" font-family="Arial">${p.label ?? ""}</text>
  `).join("\n");

  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${circles}
    </svg>
  `);

  const base = sharp(inputPngPath);
  await base
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(outPngPath);
}