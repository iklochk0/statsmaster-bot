import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = (body?.name || "").toString().trim() || null;

  const { startKvK } = await import("../../../../../../src/db.pg.js");
  const kvk_id = await startKvK(name);
  return Response.json({ ok: true, kvk_id });
}
