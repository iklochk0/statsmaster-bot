// Drops all bot-managed database objects from the public schema.
// Usage: ALLOW_WIPE=YES node src/wipe.all.js

import "dotenv/config";
import { Pool } from "pg";

if (process.env.ALLOW_WIPE !== "YES") {
  console.error("Set ALLOW_WIPE=YES to allow wiping the database.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  FOREACH obj IN ARRAY ARRAY[${OBJECTS.map(s => `'${s}'`).join(", ")}]
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

    -- 'r' table, 'v' view, 'm' materialized view
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

(async () => {
  console.log("Wiping database objects...");

  try {
    await pool.query("BEGIN");
    await pool.query(SQL);
    await pool.query("COMMIT");
    console.log("Done. All listed objects were dropped.");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Wipe failed:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
