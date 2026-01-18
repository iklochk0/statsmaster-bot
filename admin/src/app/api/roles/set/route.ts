import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const role = String(body?.role || "");
  const playerId = String(body?.playerId || "").trim();
  const ownerId = String(body?.ownerId || "").trim();

  if (!/^\d+$/.test(playerId)) {
    return Response.json({ ok: false, error: "playerId is required" }, { status: 400 });
  }

  const {
    setFarmLinkApproved,
    removeFarmLink,
    recalcGoalsForRoleChange,
  } = await import("../../../../../../src/db.pg.js");

  try {
    if (role === "farm") {
      if (!/^\d+$/.test(ownerId)) {
        return Response.json({ ok: false, error: "ownerId is required for farm" }, { status: 400 });
      }
      await setFarmLinkApproved(ownerId, playerId);
      await recalcGoalsForRoleChange(playerId, "farm");
      return Response.json({ ok: true, role: "farm" });
    }
    if (role === "main") {
      await removeFarmLink(playerId);
      await recalcGoalsForRoleChange(playerId, "main");
      return Response.json({ ok: true, role: "main" });
    }
    return Response.json({ ok: false, error: "role must be farm or main" }, { status: 400 });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
