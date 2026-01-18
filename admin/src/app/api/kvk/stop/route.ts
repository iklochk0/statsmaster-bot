import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const { endActiveKvK } = await import("../../../../../../src/db.pg.js");
  const kvk_id = await endActiveKvK();
  if (!kvk_id) {
    return Response.json({ ok: false, error: "No active KvK." }, { status: 400 });
  }
  return Response.json({ ok: true, kvk_id });
}
