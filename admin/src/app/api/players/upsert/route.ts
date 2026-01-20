import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const payload = {
    player_id: body?.player_id,
    name: body?.name,
    power_current: body?.power_current,
    kp_current: body?.kp_current,
    dead_current: body?.dead_current,
    t4_kills_current: body?.t4_kills_current,
    t5_kills_current: body?.t5_kills_current,
    last_update: body?.last_update,
  };

  const { upsertPlayerManual } = await import("../../../../../../src/db.pg.js");
  try {
    const row = await upsertPlayerManual(payload);
    return Response.json({ ok: true, result: row });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}
