// src/server.js — міні-API + дашборд для перегляду latest та KvK прогресу
import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

import {
  initSchema, closeDb,
  kvkStart, kvkSetWeight, kvkActiveId,
  kvkEnsureGoal, kvkTop, kvkProgress
} from "./db.pg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT || 3000);

// окремий pool тільки для простих SELECT’ів у цьому файлі
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());

// статичні файли (дашборд)
app.use("/", express.static(path.join(ROOT_DIR, "public")));

// --- utils
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// --- API: latest (останні знімки)
app.get("/api/latest", async (req, res) => {
  const limit = clamp(Number(req.query.limit || 200), 1, 1000);
  const search = (req.query.search || "").toString().trim();

  try {
    let rows;
    if (search) {
      const q = `
        SELECT player_id, name, updated_at, power, kp, dead, t1, t2, t3, t4, t5
        FROM latest
        WHERE name ILIKE $1 OR player_id::text ILIKE $1
        ORDER BY updated_at DESC
        LIMIT $2
      `;
      const { rows: r } = await pgPool.query(q, [`%${search}%`, limit]);
      rows = r;
    } else {
      const q = `
        SELECT player_id, name, updated_at, power, kp, dead, t1, t2, t3, t4, t5
        FROM latest
        ORDER BY updated_at DESC
        LIMIT $1
      `;
      const { rows: r } = await pgPool.query(q, [limit]);
      rows = r;
    }
    res.json({ ok: true, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- API: KvK активний і ваги
app.get("/api/kvk/active", async (req, res) => {
  try {
    const id = await kvkActiveId();
    res.json({ ok: true, kvk_id: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/kvk/start", async (req, res) => {
  try {
    const name = (req.body?.name || "").toString().trim() || null;
    const kvk_id = await kvkStart(name);
    res.json({ ok: true, kvk_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/kvk/weight", async (req, res) => {
  try {
    const kp = req.body?.kp_weight;
    const dead = req.body?.dead_to_kp;
    if (kp !== undefined)   await kvkSetWeight("kp", kp);
    if (dead !== undefined) await kvkSetWeight("dead", dead);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- API: KvK прогрес
app.get("/api/progress", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 50), 1, 200);
    const rows = await kvkTop(limit);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/progress/:player_id", async (req, res) => {
  try {
    const pid = BigInt(req.params.player_id);
    const row = await kvkProgress(pid);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- API: створити ціль для гравця (ensure)
app.post("/api/kvk/ensure", async (req, res) => {
  try {
    const pid = BigInt(req.body?.player_id);
    const out = await kvkEnsureGoal(pid);
    res.json({ ok: true, ensured: !!out, details: out || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// старт
(async () => {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})().catch(async (e) => {
  console.error(e);
  await closeDb().catch(()=>{});
  await pgPool.end().catch(()=>{});
  process.exit(1);
});

// graceful shutdown
process.on("SIGINT", async () => {
  try {
    await pgPool.end();
    await closeDb();
  } finally {
    process.exit(0);
  }
});