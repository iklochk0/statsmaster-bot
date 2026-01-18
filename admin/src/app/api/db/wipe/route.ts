import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

const OBJECTS = [
  "cursor",
  "discord_links",
  "kvk_config",
  "kvk_goals",
  "kvk_periods",
  "kvk_progress",
  "latest",
  "players",
  "runs",
  "stats",
  "zone_scans",
  "zone_snapshots",
  "account_links",
  "imports",
  "kvk_sessions",
];

const SQL = `
DO $$
DECLARE
  obj TEXT;
  rk  CHAR(1);
BEGIN
  FOREACH obj IN ARRAY ARRAY[${OBJECTS.map((s) => `'${s}'`).join(", ")}]
  LOOP
    SELECT c.relkind
      INTO rk
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = obj
     LIMIT 1;

    IF rk IS NULL THEN
      CONTINUE;
    END IF;

    IF rk = 'r' THEN
      EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE;', obj);
    ELSIF rk = 'v' THEN
      EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE;', obj);
    ELSIF rk = 'm' THEN
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE;', obj);
    ELSE
      EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE;', obj);
    END IF;
  END LOOP;
END $$;
`;

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const confirm = String(body?.confirm || "");
  if (confirm !== "WIPE") {
    return Response.json(
      { ok: false, error: "Confirm by sending confirm=WIPE" },
      { status: 400 }
    );
  }

  try {
    const { pool } = await import("../../../../../../src/db.pg.js");
    await pool.query("BEGIN");
    await pool.query(SQL);
    await pool.query("COMMIT");
    return Response.json({ ok: true });
  } catch (e: any) {
    try {
      const { pool } = await import("../../../../../../src/db.pg.js");
      await pool.query("ROLLBACK");
    } catch {}
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
