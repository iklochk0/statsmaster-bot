// src/db.pg.js
//
// Семантика:
//  - kp = Kill Points (очків за вбивства). Просто метрика профілю. НЕ є goal.
//  - t1..t5 = kills по тірах. Для прогресу беремо тільки t4+t5.
//  - dead = втрати.
//
// KvK логіка:
//  - goal_kills  = скільки треба набити (t4+t5) за період
//  - goal_dead   = скільки треба злити dead
//  - goal_dkp    = goal_kills * kills_weight + goal_dead * dead_to_kills
//
//  - start_kills = t4+t5 на момент старту KvK
//  - start_dead
//  - start_t1..t5, start_power, start_kp = просто зберігаємо як baseline
//
//  - d_kills = (current (t4+t5) - start_kills)
//  - d_dead  = (current dead  - start_dead)
//  - dkp     = d_kills * kills_weight + d_dead * dead_to_kills
//  - pct     = dkp / goal_dkp
//
// Важливо: KP не впливає на DKP/goal, просто зберігається для довідки.
//
// Експортовані функції:
//   initSchema, closeDb
//   beginRun, saveScan, insertStats
//   kvkStart, kvkActiveId, kvkEnsureGoal, kvkSetWeight, kvkProgress, kvkTop
//   zoneStart, zoneFinish, getZone, listZones
//   fetchStatsByRun
//

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ========== helpers ========== */

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// normalizeParsedStats приймає сирі дані з parseStats()
// і приводить до стабільних полів
function normalizeParsedStats(p) {
  // kp може називатись по-різному в старих версіях
  const kpRaw =
    p.kp ??
    p.kpTotal ??
    p.killsKP ??
    p.kills ?? // старий випадок, де "kills" = KP
    null;

  return {
    pid:   Number(String(p.id || "").replace(/\D/g, "")) || null,
    name:  p.name ?? "",
    power: numOrNull(p.power),
    kp:    numOrNull(kpRaw),
    dead:  numOrNull(p.dead),
    t1:    numOrNull(p.t1),
    t2:    numOrNull(p.t2),
    t3:    numOrNull(p.t3),
    t4:    numOrNull(p.t4),
    t5:    numOrNull(p.t5),
  };
}

/* ========== SCHEMA ========== */

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id   BIGINT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id     BIGSERIAL PRIMARY KEY,
      started_at timestamptz NOT NULL DEFAULT now()
    );

    -- Зріз по одному прогону (run_id)
    CREATE TABLE IF NOT EXISTS stats (
      run_id    BIGINT  NOT NULL REFERENCES runs(run_id)    ON DELETE CASCADE,
      player_id BIGINT  NOT NULL REFERENCES players(id)     ON DELETE CASCADE,

      power BIGINT,
      kp    BIGINT,  -- Kill Points (просто інфо)
      dead  BIGINT,

      t1 BIGINT,
      t2 BIGINT,
      t3 BIGINT,
      t4 BIGINT,
      t5 BIGINT,

      dkp REAL,
      PRIMARY KEY (run_id, player_id)
    );

    -- Останній відомий стан гравця
    CREATE TABLE IF NOT EXISTS latest (
      player_id  BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      name       TEXT,
      updated_at timestamptz NOT NULL,

      power BIGINT,
      kp    BIGINT,
      dead  BIGINT,

      t1 BIGINT,
      t2 BIGINT,
      t3 BIGINT,
      t4 BIGINT,
      t5 BIGINT
    );

    -- прогрес сканера (курсор)
    CREATE TABLE IF NOT EXISTS cursor (
      run_id  BIGINT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      stage   TEXT,
      idx     INTEGER,
      updated_at timestamptz NOT NULL
    );

    -- зони бою (ми просто пам'ятаємо які run_id були на старті/фініші зони)
    CREATE TABLE IF NOT EXISTS zone_scans (
      zone_name    TEXT PRIMARY KEY,
      start_run_id BIGINT,
      end_run_id   BIGINT,
      start_time   timestamptz,
      end_time     timestamptz
    );

    -- періоди KvK
    CREATE TABLE IF NOT EXISTS kvk_periods (
      kvk_id     BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz
    );

    -- ваги формули DKP
    CREATE TABLE IF NOT EXISTS kvk_config (
      kvk_id BIGINT PRIMARY KEY REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      kills_weight   NUMERIC NOT NULL DEFAULT 1.0,
      dead_to_kills  NUMERIC NOT NULL DEFAULT 5.0
    );

    -- Цілі на KvK для кожного гравця
    CREATE TABLE IF NOT EXISTS kvk_goals (
      kvk_id     BIGINT NOT NULL REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,

      goal_kills BIGINT NOT NULL, -- Скільки Т4+Т5 треба набити
      goal_dead  BIGINT NOT NULL, -- Скільки треба злити
      goal_dkp   BIGINT NOT NULL, -- goal_kills*w1 + goal_dead*w2

      start_power BIGINT NOT NULL,

      start_kills BIGINT NOT NULL, -- (t4+t5) на старті KvK
      start_dead  BIGINT NOT NULL,

      start_t1 BIGINT NOT NULL,
      start_t2 BIGINT NOT NULL,
      start_t3 BIGINT NOT NULL,
      start_t4 BIGINT NOT NULL,
      start_t5 BIGINT NOT NULL,

      start_kp  BIGINT NOT NULL,   -- KP на старті (довідка)

      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kvk_id, player_id)
    );
  `);

  // kvk_progress: live прогрес + % виконання цілі
  // d_kills = delta(T4+T5), d_dead = delta(dead)
  // dkp     = d_kills*w1 + d_dead*w2
  await pool.query(`
    CREATE OR REPLACE VIEW kvk_progress AS
    SELECT
      g.kvk_id,
      g.player_id,
      p.name,
      l.updated_at,

      -- приріст kills (t4+t5)
      GREATEST(
        (COALESCE(l.t4,0) + COALESCE(l.t5,0)) - g.start_kills,
        0
      ) AS d_kills,

      -- приріст dead
      GREATEST(
        COALESCE(l.dead,0) - g.start_dead,
        0
      ) AS d_dead,

      -- приріст KP (інфо, не у формулі DKP)
      GREATEST(
        COALESCE(l.kp,0) - g.start_kp,
        0
      ) AS d_kp,

      c.kills_weight,
      c.dead_to_kills,

      (
        GREATEST(
          (COALESCE(l.t4,0) + COALESCE(l.t5,0)) - g.start_kills,
          0
        ) * c.kills_weight

        +
        GREATEST(
          COALESCE(l.dead,0) - g.start_dead,
          0
        ) * c.dead_to_kills
      )::bigint AS dkp,

      g.goal_kills,
      g.goal_dead,
      g.goal_dkp,

      CASE
        WHEN g.goal_dkp > 0 THEN
          ROUND(
            100.0 * (
              (
                GREATEST(
                  (COALESCE(l.t4,0) + COALESCE(l.t5,0)) - g.start_kills,
                  0
                ) * c.kills_weight
                +
                GREATEST(
                  COALESCE(l.dead,0) - g.start_dead,
                  0
                ) * c.dead_to_kills
              ) / g.goal_dkp
            ),
            1
          )
        ELSE 0
      END AS pct,

      l.kp     AS current_kp,  -- KP зараз
      g.start_kp               -- KP на старті (baseline)

    FROM kvk_goals g
    JOIN latest      l ON l.player_id = g.player_id
    JOIN players     p ON p.id        = g.player_id
    JOIN kvk_config  c ON c.kvk_id    = g.kvk_id;
  `);

  // Індекси
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_player ON stats(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_run    ON stats(run_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latest_upd   ON latest(updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kvk_goals_player ON kvk_goals(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kvk_goals_kvk    ON kvk_goals(kvk_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_zone_name ON zone_scans(zone_name);`);
}

/* ========== BASIC OPS ========== */

export async function closeDb() {
  await pool.end();
}

export async function beginRun() {
  const { rows } = await pool.query(
    `INSERT INTO runs DEFAULT VALUES RETURNING run_id`
  );
  return rows[0].run_id;
}

/* ========== SAVE SCAN FROM BOT ========== */
/**
 * Викликається ботом на кожного гравця після OCR.
 * p з parseStats():
 * {
 *   id, name,
 *   power,
 *   kp,         // Kill Points
 *   dead,
 *   t1,t2,t3,t4,t5
 * }
 */
export async function saveScan(run_id, pRaw) {
  const s = normalizeParsedStats(pRaw);

  if (!s.pid || String(s.pid).length < 5) {
    throw new Error("saveScan: invalid player id " + pRaw.id);
  }

  // players
  await pool.query(`
    INSERT INTO players (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name
  `, [s.pid, s.name]);

  // історичний зріз цього run_id
  await pool.query(`
    INSERT INTO stats (
      run_id,
      player_id,
      power,
      kp,
      dead,
      t1, t2, t3, t4, t5
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (run_id, player_id) DO NOTHING
  `, [
    run_id,
    s.pid,
    s.power,
    s.kp,
    s.dead,
    s.t1, s.t2, s.t3, s.t4, s.t5,
  ]);

  // актуальний стан (latest)
  await pool.query(`
    INSERT INTO latest (
      player_id,
      name,
      power,
      kp,
      dead,
      t1, t2, t3, t4, t5,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
    ON CONFLICT (player_id) DO UPDATE SET
      name       = EXCLUDED.name,
      power      = EXCLUDED.power,
      kp         = EXCLUDED.kp,
      dead       = EXCLUDED.dead,
      t1         = EXCLUDED.t1,
      t2         = EXCLUDED.t2,
      t3         = EXCLUDED.t3,
      t4         = EXCLUDED.t4,
      t5         = EXCLUDED.t5,
      updated_at = NOW()
  `, [
    s.pid,
    s.name,
    s.power,
    s.kp,
    s.dead,
    s.t1, s.t2, s.t3, s.t4, s.t5,
  ]);

  return s.pid;
}

/* ========== insertStats (нижче-рівнева версія, якщо колись треба вручну) ========== */

function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatsForDb(s) {
  return {
    name:  s.name ?? null,
    power: toNumOrNull(s.power),
    kp:    toNumOrNull(s.kp),
    dead:  toNumOrNull(s.dead),
    t1:    toNumOrNull(s.t1),
    t2:    toNumOrNull(s.t2),
    t3:    toNumOrNull(s.t3),
    t4:    toNumOrNull(s.t4),
    t5:    toNumOrNull(s.t5),
    dkp:   toNumOrNull(s.dkp),
  };
}

export async function insertStats(run_id, player_id, sRaw) {
  const s = normalizeStatsForDb(sRaw);

  await pool.query(`
    INSERT INTO stats (
      run_id,
      player_id,
      power,
      kp,
      dead,
      t1, t2, t3, t4, t5,
      dkp
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (run_id, player_id) DO UPDATE SET
      power = EXCLUDED.power,
      kp    = EXCLUDED.kp,
      dead  = EXCLUDED.dead,
      t1    = EXCLUDED.t1,
      t2    = EXCLUDED.t2,
      t3    = EXCLUDED.t3,
      t4    = EXCLUDED.t4,
      t5    = EXCLUDED.t5,
      dkp   = COALESCE(EXCLUDED.dkp, stats.dkp)
  `, [
    run_id,
    player_id,
    s.power ?? null,
    s.kp ?? null,
    s.dead ?? null,
    s.t1 ?? null,
    s.t2 ?? null,
    s.t3 ?? null,
    s.t4 ?? null,
    s.t5 ?? null,
    s.dkp ?? null,
  ]);

  await pool.query(`
    INSERT INTO latest (
      player_id,
      name,
      updated_at,
      power,
      kp,
      dead,
      t1, t2, t3, t4, t5
    )
    VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (player_id) DO UPDATE SET
      name       = EXCLUDED.name,
      updated_at = EXCLUDED.updated_at,
      power      = EXCLUDED.power,
      kp         = EXCLUDED.kp,
      dead       = EXCLUDED.dead,
      t1         = EXCLUDED.t1,
      t2         = EXCLUDED.t2,
      t3         = EXCLUDED.t3,
      t4         = EXCLUDED.t4,
      t5         = EXCLUDED.t5
  `, [
    player_id,
    s.name ?? null,
    s.power ?? null,
    s.kp ?? null,
    s.dead ?? null,
    s.t1 ?? null,
    s.t2 ?? null,
    s.t3 ?? null,
    s.t4 ?? null,
    s.t5 ?? null,
  ]);
}

/* ========== CURSOR (не критично, але хай буде) ========== */

export async function saveCursor(run_id, stage, idx) {
  await pool.query(`
    INSERT INTO cursor (run_id, stage, idx, updated_at)
    VALUES ($1,$2,$3, now())
    ON CONFLICT (run_id) DO UPDATE SET
      stage = EXCLUDED.stage,
      idx   = EXCLUDED.idx,
      updated_at = EXCLUDED.updated_at
  `, [run_id, stage, idx]);
}

export async function loadCursor(run_id) {
  const { rows } = await pool.query(
    `SELECT stage, idx FROM cursor WHERE run_id=$1`,
    [run_id]
  );
  return rows[0] ?? null;
}

/* ========== KvK stuff ========== */

export async function kvkStart(name = null) {
  const { rows } = await pool.query(
    `INSERT INTO kvk_periods(name) VALUES ($1) RETURNING kvk_id`,
    [name || `KvK ${new Date().toISOString().slice(0,10)}`]
  );
  const kvk_id = rows[0].kvk_id;
  await pool.query(`INSERT INTO kvk_config(kvk_id) VALUES ($1)`, [kvk_id]);
  return kvk_id;
}

export async function kvkActiveId() {
  const { rows } = await pool.query(`
    SELECT kvk_id
    FROM kvk_periods
    WHERE ended_at IS NULL
    ORDER BY kvk_id DESC
    LIMIT 1
  `);
  return rows[0]?.kvk_id || null;
}

export async function kvkSetWeight(which, value, kvk_id = null) {
  const col =
    which === "dead"
      ? "dead_to_kills"
      : which === "kills"
      ? "kills_weight"
      : null;

  if (!col) throw new Error(`Unknown weight "${which}" (use "dead" or "kills")`);

  if (!kvk_id) kvk_id = await kvkActiveId();
  if (!kvk_id) throw new Error("No active KvK. Run kvkStart first.");

  await pool.query(
    `UPDATE kvk_config
     SET ${col} = $1
     WHERE kvk_id = $2`,
    [Number(value), kvk_id]
  );
}

// Таблиця норм по power. Повертає:
// { goalKills, goalDead }
function computeGoalsFromPower(powerRaw) {
  const pm = Number(powerRaw || 0) / 1_000_000; // млн

  let goalKills = 0;
  let goalDead  = 0;

  if (pm > 130)       { goalKills = 35000000; goalDead = 2500000; }
  else if (pm >= 120) { goalKills = 34000000; goalDead = 2000000; }
  else if (pm >= 110) { goalKills = 33000000; goalDead = 1800000; }
  else if (pm >= 100) { goalKills = 32000000; goalDead = 1650000; }
  else if (pm >= 95)  { goalKills = 30000000; goalDead = 1500000; }
  else if (pm >= 90)  { goalKills = 29000000; goalDead = 1400000; }
  else if (pm >= 85)  { goalKills = 28000000; goalDead = 1000000; }
  else if (pm >= 80)  { goalKills = 28000000; goalDead =  850000; }
  else if (pm >= 75)  { goalKills = 27000000; goalDead =  800000; }
  else if (pm >= 70)  { goalKills = 24000000; goalDead =  750000; }
  else if (pm >= 65)  { goalKills = 20000000; goalDead =  700000; }
  else if (pm >= 60)  { goalKills = 16000000; goalDead =  650000; }
  else if (pm >= 55)  { goalKills = 13000000; goalDead =  600000; }
  else if (pm >= 50)  { goalKills =  8000000; goalDead =  550000; }
  else if (pm >= 45)  { goalKills =  5000000; goalDead =  500000; }
  else                { goalKills =  4000000; goalDead =  450000; }

  return { goalKills, goalDead };
}

/**
 * kvkEnsureGoal(player_id)
 * Створює запис у kvk_goals для гравця на активний KvK, якщо ще нема.
 */
export async function kvkEnsureGoal(player_id) {
  const kvk_id = await kvkActiveId();
  if (!kvk_id) return null;

  // вже є?
  {
    const { rows } = await pool.query(
      `SELECT 1 FROM kvk_goals
       WHERE kvk_id=$1 AND player_id=$2`,
      [kvk_id, player_id]
    );
    if (rows.length) return null;
  }

  // останній стан гравця
  const { rows: lrows } = await pool.query(
    `SELECT * FROM latest WHERE player_id=$1`,
    [player_id]
  );
  if (!lrows.length) return null;
  const l = lrows[0];

  // конфіг ваг
  const { rows: cr } = await pool.query(
    `SELECT kills_weight, dead_to_kills
     FROM kvk_config
     WHERE kvk_id=$1`,
    [kvk_id]
  );
  const cfg = cr[0] || { kills_weight: 1.0, dead_to_kills: 5.0 };

  // Норми по power -> скільки треба зробити Т4+Т5 і dead
  const { goalKills, goalDead } = computeGoalsFromPower(l.power || 0);

  // Беремо стартові значення гравця:
  const startKills = (Number(l.t4 || 0) + Number(l.t5 || 0));
  const startDead  = Number(l.dead || 0);

  // Яку суму DKP ми від нього очікуємо
  const goal_dkp = Math.round(
    Number(cfg.kills_weight || 0) * goalKills +
    Number(cfg.dead_to_kills || 0) * goalDead
  );

  await pool.query(`
    INSERT INTO kvk_goals (
      kvk_id, player_id,
      goal_kills, goal_dead, goal_dkp,
      start_power,
      start_kills, start_dead,
      start_t1, start_t2, start_t3, start_t4, start_t5,
      start_kp
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (kvk_id, player_id) DO UPDATE SET
      goal_kills = EXCLUDED.goal_kills,
      goal_dead  = EXCLUDED.goal_dead,
      goal_dkp   = EXCLUDED.goal_dkp
  `, [
    kvk_id,
    player_id,

    goalKills,
    goalDead,
    goal_dkp,

    l.power || 0,

    startKills,
    startDead,

    l.t1 || 0,
    l.t2 || 0,
    l.t3 || 0,
    l.t4 || 0,
    l.t5 || 0,

    l.kp || 0
  ]);

  return {
    kvk_id,
    goal_kills: goalKills,
    goal_dead: goalDead,
    goal_dkp,
  };
}

export async function kvkProgress(player_id) {
  const { rows } = await pool.query(
    `SELECT *
     FROM kvk_progress
     WHERE player_id=$1
     ORDER BY kvk_id DESC
     LIMIT 1`,
    [player_id]
  );
  return rows[0] || null;
}

export async function kvkTop(limit = 10) {
  const { rows } = await pool.query(
    `SELECT *
     FROM kvk_progress
     ORDER BY pct DESC, dkp DESC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 10, 1), 50)]
  );
  return rows;
}

/* ========== Zones ========== */

export async function zoneStart(zone_name, run_id) {
  await pool.query(`
    INSERT INTO zone_scans (zone_name, start_run_id, start_time)
    VALUES ($1,$2, now())
    ON CONFLICT (zone_name) DO UPDATE SET
      start_run_id = EXCLUDED.start_run_id,
      start_time   = EXCLUDED.start_time
  `, [zone_name, run_id]);
}

export async function zoneFinish(zone_name, run_id) {
  await pool.query(`
    UPDATE zone_scans
    SET end_run_id = $2,
        end_time   = now()
    WHERE zone_name = $1
  `, [zone_name, run_id]);
}

export async function getZone(zone_name) {
  const { rows } = await pool.query(
    `SELECT * FROM zone_scans WHERE zone_name=$1`,
    [zone_name]
  );
  return rows[0] || null;
}

export async function listZones() {
  const { rows } = await pool.query(`
    SELECT zone_name, start_run_id, end_run_id, start_time, end_time
    FROM zone_scans
    ORDER BY start_time ASC NULLS LAST, zone_name ASC
  `);
  return rows;
}

/* ========== Diff helper for zones/battles ========== */

export async function fetchStatsByRun(runId) {
  const { rows } = await pool.query(`
    SELECT s.player_id, p.name,
           s.power, s.kp, s.dead,
           s.t1, s.t2, s.t3, s.t4, s.t5
    FROM stats s
    JOIN players p ON p.id = s.player_id
    WHERE s.run_id = $1
  `, [runId]);

  const m = new Map();
  for (const r of rows) {
    m.set(String(r.player_id), r);
  }
  return m;
}