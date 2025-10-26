// src/db.pg.js
// DB layer: players/runs/stats/latest/KvK/zone_scans
//
// терміни:
//   kp     = Kill Points (очки за вбивства, офіційна метрика гри)
//   t1..t5 = кількість убивств по тірах (звичайні "kills", розкладені по рівнях)
//   dead   = втрати
//
// важливо:
// - у таблицях stats/latest тепер є колонка kp, НЕ kills.
// - kvk_goals зберігає goal_kp / start_kp.
// - kvk_progress рахує d_kp = (latest.kp - start_kp).
//
// експорт:
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

/* ================= Schema ================= */
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

    -- kp = Kill Points
    -- t1..t5 = kills by tier
    CREATE TABLE IF NOT EXISTS stats (
      run_id    BIGINT  NOT NULL REFERENCES runs(run_id)    ON DELETE CASCADE,
      player_id BIGINT  NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
      power     BIGINT,
      kp        BIGINT,
      dead      BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT,
      dkp REAL,
      PRIMARY KEY (run_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS latest (
      player_id  BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      name       TEXT,
      updated_at timestamptz NOT NULL,
      power BIGINT,
      kp    BIGINT,
      dead  BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT
    );

    CREATE TABLE IF NOT EXISTS cursor (
      run_id  BIGINT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      stage   TEXT,
      idx     INTEGER,
      updated_at timestamptz NOT NULL
    );

    -- zone_scans: просто зберігаємо які run_id відповідають старту/фінішу бою
    CREATE TABLE IF NOT EXISTS zone_scans (
      zone_name    TEXT PRIMARY KEY,
      start_run_id BIGINT,
      end_run_id   BIGINT,
      start_time   timestamptz,
      end_time     timestamptz
    );

    CREATE TABLE IF NOT EXISTS kvk_periods (
      kvk_id     BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz
    );

    CREATE TABLE IF NOT EXISTS kvk_config (
      kvk_id BIGINT PRIMARY KEY REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      kills_weight   NUMERIC NOT NULL DEFAULT 1.0,
      dead_to_kills  NUMERIC NOT NULL DEFAULT 5.0
    );

    CREATE TABLE IF NOT EXISTS kvk_goals (
      kvk_id     BIGINT NOT NULL REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,

      goal_kp    BIGINT NOT NULL, -- скільки KP ти маєш зробити за період
      goal_dead  BIGINT NOT NULL, -- скільки втрат
      goal_dkp   BIGINT NOT NULL, -- вага KP+dead після формули

      start_power BIGINT NOT NULL,
      start_kp    BIGINT NOT NULL,
      start_dead  BIGINT NOT NULL,
      start_t1 BIGINT NOT NULL,
      start_t2 BIGINT NOT NULL,
      start_t3 BIGINT NOT NULL,
      start_t4 BIGINT NOT NULL,
      start_t5 BIGINT NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kvk_id, player_id)
    );
  `);

  // kvk_progress:
  // d_kp   = latest.kp - start_kp
  // d_dead = latest.dead - start_dead
  // dkp    = d_kp * kills_weight + d_dead * dead_to_kills
  await pool.query(`
    CREATE OR REPLACE VIEW kvk_progress AS
    SELECT
      g.kvk_id,
      g.player_id,
      p.name,
      l.updated_at,
      GREATEST(l.kp   - g.start_kp,   0) AS d_kp,
      GREATEST(l.dead - g.start_dead, 0) AS d_dead,
      c.kills_weight,
      c.dead_to_kills,
      (
        GREATEST(l.kp   - g.start_kp,   0) * c.kills_weight +
        GREATEST(l.dead - g.start_dead, 0) * c.dead_to_kills
      )::bigint AS dkp,
      g.goal_kp,
      g.goal_dead,
      g.goal_dkp,
      CASE
        WHEN g.goal_dkp > 0 THEN
          ROUND(
            100.0 * (
              (
                GREATEST(l.kp   - g.start_kp,   0) * c.kills_weight +
                GREATEST(l.dead - g.start_dead, 0) * c.dead_to_kills
              ) / g.goal_dkp
            ),
            1
          )
        ELSE 0
      END AS pct
    FROM kvk_goals g
    JOIN latest l ON l.player_id = g.player_id
    JOIN players p ON p.id = g.player_id
    JOIN kvk_config c ON c.kvk_id = g.kvk_id;
  `);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_player ON stats(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stats_run    ON stats(run_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latest_upd   ON latest(updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kvk_goals_player ON kvk_goals(player_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kvk_goals_kvk    ON kvk_goals(kvk_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_zone_name ON zone_scans(zone_name);`);
}

/* ================ Save one scan (головна точка входу з бота) ================ */
/**
 * p очікується з parseStats():
 * {
 *   id, name,
 *   power,
 *   kp,          // Kill Points TOTAL
 *   dead,
 *   t1,t2,t3,t4,t5
 * }
 */
export async function saveScan(run_id, p) {
  const pid = Number(String(p.id || "").replace(/\D/g, ""));
  if (!Number.isFinite(pid) || String(pid).length < 5) {
    throw new Error("saveScan: invalid player id " + p.id);
  }

  // players
  await pool.query(
    `
    INSERT INTO players (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name
    `,
    [pid, p.name ?? ""]
  );

  // stats (історика на цей run_id)
  await pool.query(
    `
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
    `,
    [
      run_id,
      pid,
      p.power ?? null,
      p.kp    ?? null,
      p.dead  ?? null,
      p.t1 ?? null,
      p.t2 ?? null,
      p.t3 ?? null,
      p.t4 ?? null,
      p.t5 ?? null,
    ]
  );

  // latest (поточний стан)
  await pool.query(
    `
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
    `,
    [
      pid,
      p.name ?? "",
      p.power ?? null,
      p.kp    ?? null,
      p.dead  ?? null,
      p.t1 ?? null,
      p.t2 ?? null,
      p.t3 ?? null,
      p.t4 ?? null,
      p.t5 ?? null,
    ]
  );

  return pid;
}

/* ================ Low-level helpers (можуть не знадобитись напряму) ================ */
export async function closeDb() {
  await pool.end();
}

export async function beginRun() {
  const { rows } = await pool.query(
    `INSERT INTO runs DEFAULT VALUES RETURNING run_id`
  );
  return rows[0].run_id;
}

/* нормалізація чисел з OCR */
function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatsForDb(s) {
  const t1 = toNumOrNull(s.t1);
  const t2 = toNumOrNull(s.t2);
  const t3 = toNumOrNull(s.t3);
  const t4 = toNumOrNull(s.t4);
  const t5 = toNumOrNull(s.t5);

  const kpVal = toNumOrNull(s.kp);

  return {
    name: s.name ?? null,
    power: toNumOrNull(s.power),
    dead:  toNumOrNull(s.dead),
    kpVal,
    t1, t2, t3, t4, t5,
    dkp: toNumOrNull(s.dkp),
  };
}

export async function insertStats(run_id, player_id, sRaw) {
  const s = normalizeStatsForDb(sRaw);

  await pool.query(
    `INSERT INTO stats (
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
    `,
    [
      run_id,
      player_id,
      s.power ?? null,
      s.kpVal ?? null,
      s.dead ?? null,
      s.t1 ?? null,
      s.t2 ?? null,
      s.t3 ?? null,
      s.t4 ?? null,
      s.t5 ?? null,
      s.dkp ?? null,
    ]
  );

  await pool.query(
    `INSERT INTO latest (
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
    `,
    [
      player_id,
      s.name ?? null,
      s.power ?? null,
      s.kpVal ?? null,
      s.dead ?? null,
      s.t1 ?? null,
      s.t2 ?? null,
      s.t3 ?? null,
      s.t4 ?? null,
      s.t5 ?? null,
    ]
  );
}

/* -------- Cursor -------- */
export async function saveCursor(run_id, stage, idx) {
  await pool.query(
    `INSERT INTO cursor (run_id, stage, idx, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (run_id) DO UPDATE SET
       stage = EXCLUDED.stage,
       idx   = EXCLUDED.idx,
       updated_at = EXCLUDED.updated_at`,
    [run_id, stage, idx]
  );
}
export async function loadCursor(run_id) {
  const { rows } = await pool.query(
    `SELECT stage, idx FROM cursor WHERE run_id=$1`,
    [run_id]
  );
  return rows[0] ?? null;
}

/* ================ KvK helpers ================ */
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
  const { rows } = await pool.query(
    `SELECT kvk_id
       FROM kvk_periods
      WHERE ended_at IS NULL
      ORDER BY kvk_id DESC
      LIMIT 1`
  );
  return rows[0]?.kvk_id || null;
}

export async function kvkSetWeight(which, value, kvk_id = null) {
  const col = which === "dead"
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

/**
 * Обчислюємо цільові значення з power:
 * повертаємо { goalKP, goalDead }.
 */
function computeGoalsFromPower(powerRaw) {
  const pm = Number(powerRaw || 0) / 1_000_000; // млн
  let goalKP = 0;
  let goalDead = 0;

  if (pm > 130)       { goalKP = 35_000_000; goalDead = 2_500_000; }
  else if (pm >= 120) { goalKP = 34_000_000; goalDead = 2_000_000; }
  else if (pm >= 110) { goalKP = 33_000_000; goalDead = 1_800_000; }
  else if (pm >= 100) { goalKP = 32_000_000; goalDead = 1_650_000; }
  else if (pm >= 95)  { goalKP = 30_000_000; goalDead = 1_500_000; }
  else if (pm >= 90)  { goalKP = 29_000_000; goalDead = 1_400_000; }
  else if (pm >= 85)  { goalKP = 28_000_000; goalDead = 1_000_000; }
  else if (pm >= 80)  { goalKP = 28_000_000; goalDead =   850_000; }
  else if (pm >= 75)  { goalKP = 27_000_000; goalDead =   800_000; }
  else if (pm >= 70)  { goalKP = 24_000_000; goalDead =   750_000; }
  else if (pm >= 65)  { goalKP = 20_000_000; goalDead =   700_000; }
  else if (pm >= 60)  { goalKP = 16_000_000; goalDead =   650_000; }
  else if (pm >= 55)  { goalKP = 13_000_000; goalDead =   600_000; }
  else if (pm >= 50)  { goalKP =  8_000_000; goalDead =   550_000; }
  else if (pm >= 45)  { goalKP =  5_000_000; goalDead =   500_000; }
  else                { goalKP =  4_000_000; goalDead =   450_000; }

  return { goalKP, goalDead };
}

/**
 * kvkEnsureGoal(player_id)
 * - працює тільки якщо є активний KvK
 * - якщо для гравця вже є goal → повертає null
 * - якщо нема → створює на основі latest і power-таблиці
 */
export async function kvkEnsureGoal(player_id) {
  const kvk_id = await kvkActiveId();
  if (!kvk_id) return null;

  // є вже?
  {
    const { rows } = await pool.query(
      `SELECT 1 FROM kvk_goals
        WHERE kvk_id=$1 AND player_id=$2`,
      [kvk_id, player_id]
    );
    if (rows.length) return null;
  }

  // беремо latest по цьому гравцю
  const { rows: lrows } = await pool.query(
    `SELECT * FROM latest WHERE player_id=$1`,
    [player_id]
  );
  if (!lrows.length) return null;
  const l = lrows[0];

  // ваги формули
  const { rows: cr } = await pool.query(
    `SELECT kills_weight, dead_to_kills
       FROM kvk_config
      WHERE kvk_id=$1`,
    [kvk_id]
  );
  const cfg = cr[0] || { kills_weight: 1.0, dead_to_kills: 5.0 };

  // норми по power
  const { goalKP, goalDead } = computeGoalsFromPower(l.power || 0);

  // скільки DKP треба зробити
  const goal_dkp = Math.round(
    Number(cfg.kills_weight || 0) * goalKP +
    Number(cfg.dead_to_kills || 0) * goalDead
  );

  await pool.query(`
    INSERT INTO kvk_goals
      (kvk_id, player_id,
       goal_kp, goal_dead, goal_dkp,
       start_power, start_kp, start_dead,
       start_t1, start_t2, start_t3, start_t4, start_t5)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (kvk_id, player_id) DO UPDATE SET
      goal_kp   = EXCLUDED.goal_kp,
      goal_dead = EXCLUDED.goal_dead,
      goal_dkp  = EXCLUDED.goal_dkp
  `, [
    kvk_id,
    player_id,
    goalKP,
    goalDead,
    goal_dkp,
    l.power||0,
    l.kp||0,
    l.dead||0,
    l.t1||0, l.t2||0, l.t3||0, l.t4||0, l.t5||0
  ]);

  return {
    kvk_id,
    goal_kp: goalKP,
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
      ORDER BY pct DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit)||10,1),50)]
  );
  return rows;
}

/* ================ Zone helpers ================ */
export async function zoneStart(zone_name, run_id) {
  await pool.query(
    `INSERT INTO zone_scans (zone_name, start_run_id, start_time)
     VALUES ($1,$2, now())
     ON CONFLICT (zone_name) DO UPDATE SET
       start_run_id = EXCLUDED.start_run_id,
       start_time   = EXCLUDED.start_time`,
    [zone_name, run_id]
  );
}

export async function zoneFinish(zone_name, run_id) {
  await pool.query(
    `UPDATE zone_scans
        SET end_run_id = $2,
            end_time   = now()
      WHERE zone_name = $1`,
    [zone_name, run_id]
  );
}

export async function getZone(zone_name) {
  const { rows } = await pool.query(
    `SELECT * FROM zone_scans WHERE zone_name=$1`,
    [zone_name]
  );
  return rows[0] || null;
}

export async function listZones() {
  const { rows } = await pool.query(
    `SELECT zone_name, start_run_id, end_run_id, start_time, end_time
       FROM zone_scans
      ORDER BY start_time ASC NULLS LAST, zone_name ASC`
  );
  return rows;
}

/* ================ Helper for bot to diff runs ================ */
export async function fetchStatsByRun(runId) {
  const { rows } = await pool.query(
    `SELECT s.player_id, p.name,
            s.power, s.kp, s.dead,
            s.t1, s.t2, s.t3, s.t4, s.t5
       FROM stats s
       JOIN players p ON p.id = s.player_id
      WHERE s.run_id = $1`,
    [runId]
  );
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.player_id), r);
  }
  return m;
}