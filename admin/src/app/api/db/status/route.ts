import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  try {
    const { pool, getActiveKvK } = await import("../../../../../../src/db.pg.js");
    const kvk_id = await getActiveKvK();
    const tables = [
      "players",
      "kvk_sessions",
      "kvk_goals",
      "account_links",
      "imports",
      "discord_links",
    ];

    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
        counts[t] = rows[0]?.c ?? 0;
      } catch {
        counts[t] = -1;
      }
    }

    let lastImportTs: string | null = null;
    let lastPlayerUpdateTs: string | null = null;
    try {
      const { rows } = await pool.query(
        "SELECT MAX(import_ts) AS ts FROM imports"
      );
      lastImportTs = rows[0]?.ts || null;
    } catch {}
    try {
      const { rows } = await pool.query(
        "SELECT MAX(last_update) AS ts FROM players"
      );
      lastPlayerUpdateTs = rows[0]?.ts || null;
    } catch {}

    return Response.json({
      ok: true,
      kvk_id,
      counts,
      lastImportTs,
      lastPlayerUpdateTs,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
