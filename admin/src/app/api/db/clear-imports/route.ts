import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  try {
    const { pool } = await import("../../../../../../src/db.pg.js");
    await pool.query("TRUNCATE TABLE imports RESTART IDENTITY;");
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
