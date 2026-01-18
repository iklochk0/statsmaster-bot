import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const confirm = String(body?.confirm || "");
  if (confirm !== "RESET") {
    return Response.json(
      { ok: false, error: "Confirm by sending confirm=RESET" },
      { status: 400 }
    );
  }
  const clearGoals = body?.clearGoals !== false;
  const clearImports = body?.clearImports !== false;

  const { pool, getActiveKvK } = await import(
    "../../../../../../src/db.pg.js"
  );

  const kvk_id = await getActiveKvK();
  if (!kvk_id) {
    return Response.json({ ok: false, error: "No active KvK." }, { status: 400 });
  }

  const kvkStr = String(kvk_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE kvk_sessions SET ended_at = now() WHERE kvk_id = $1",
      [kvkStr]
    );

    let goalsDeleted = 0;
    let importsDeleted = 0;
    if (clearGoals) {
      const res = await client.query(
        "DELETE FROM kvk_goals WHERE kvk_id=$1",
        [kvkStr]
      );
      goalsDeleted = res.rowCount || 0;
    }
    if (clearImports) {
      const res = await client.query(
        "DELETE FROM imports WHERE kvk_id=$1",
        [kvkStr]
      );
      importsDeleted = res.rowCount || 0;
    }

    await client.query("COMMIT");
    return Response.json({
      ok: true,
      kvk_id,
      goalsDeleted,
      importsDeleted,
    });
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
