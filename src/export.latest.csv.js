// src/export.latest.csv.js — вивантаження таблиці latest у CSV
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { initSchema, closeDb } from "./db.pg.js";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, "..");
const OUT_DIR    = path.join(ROOT_DIR, "out");

async function main(){
  await initSchema();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const { rows } = await pool.query(`
    SELECT player_id, name, updated_at, power, kp, dead, t1, t2, t3, t4, t5
    FROM latest
    ORDER BY updated_at DESC
  `);
  await pool.end();

  const header = ["player_id","name","updated_at","power","kp","dead","t1","t2","t3","t4","t5"];
  const csv = [
    header.join(","),
    ...rows.map(r => header.map(h => {
      const v = r[h];
      // примітивний CSV-ескейп
      const s = (v===null||v===undefined) ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    }).join(","))
  ].join("\n");

  await fs.mkdir(OUT_DIR, { recursive:true });
  const outPath = path.join(OUT_DIR, `latest-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`);
  await fs.writeFile(outPath, csv, "utf8");
  console.log("CSV saved:", path.relative(ROOT_DIR, outPath));
  await closeDb();
}

main().catch(async e=>{ console.error(e); await closeDb().catch(()=>{}); process.exit(1); });
