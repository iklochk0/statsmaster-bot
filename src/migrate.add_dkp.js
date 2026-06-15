import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log("-> Ensuring stats.dkp column exists...");

  const sql = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'stats'
        AND column_name  = 'dkp'
    ) THEN
      ALTER TABLE public.stats ADD COLUMN dkp REAL;
    END IF;
  END $$;
  `;
  await pool.query(sql);
  console.log("OK: stats.dkp ensured.");

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_player ON public.stats(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_run    ON public.stats(run_id);`);
  console.log("OK: indexes ensured.");

  await pool.end();
  console.log("Done.");
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
