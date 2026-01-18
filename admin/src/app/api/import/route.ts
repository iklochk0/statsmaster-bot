import { requirePin } from "@/lib/auth";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const zoneTag = String(form.get("zoneTag") || "").trim();
  const isScoringRaw = String(form.get("isScoring") || "true").trim();

  if (!file || typeof file === "string") {
    return Response.json({ ok: false, error: "file is required" }, { status: 400 });
  }
  if (!zoneTag) {
    return Response.json({ ok: false, error: "zoneTag is required" }, { status: 400 });
  }

  const isScoring = /^(1|true|yes|y)$/i.test(isScoringRaw);

  const tmpName = `import-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tmpPath, buf);

    const { importExcelFile } = await import("../../../../../src/excelImport.js");
    const result = await importExcelFile(tmpPath, zoneTag, isScoring);
    return Response.json({ ok: true, result });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}
