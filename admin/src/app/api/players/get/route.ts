import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const playerId = String(body?.playerId || "").trim();
  if (!/^\d+$/.test(playerId)) {
    return Response.json({ ok: false, error: "playerId must be numeric" }, { status: 400 });
  }

  const { fetchPlayerSnapshot } = await import("../../../../../../src/db.pg.js");
  const row = await fetchPlayerSnapshot(playerId);
  if (!row) {
    return Response.json({ ok: false, error: "Player not found" }, { status: 404 });
  }
  return Response.json({ ok: true, result: row });
}
