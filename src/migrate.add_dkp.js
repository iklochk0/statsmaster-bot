// src/migrate.add_dkp.js — одноразова міграція: додаємо колонку dkp в stats
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log("-> Ensuring stats.dkp column exists...");

  // Надійний спосіб через information_schema (працює на широкому діапазоні версій PG)
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

  // (Опційно) індекси — ідемпотентно
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_player ON public.stats(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_run    ON public.stats(run_id);`);
  console.log("OK: indexes ensured.");

  await pool.end();
  console.log("Done.");
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});