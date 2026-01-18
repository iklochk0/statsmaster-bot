import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const { getActiveKvK } = await import("../../../../../../src/db.pg.js");
  const kvk_id = await getActiveKvK();
  return Response.json({ ok: true, kvk_id });
}
