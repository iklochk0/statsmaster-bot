import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- Schema ----------------
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

    CREATE TABLE IF NOT EXISTS stats (
      run_id    BIGINT  NOT NULL REFERENCES runs(run_id)    ON DELETE CASCADE,
      player_id BIGINT  NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
      power     BIGINT,
      kills     BIGINT,
      dead      BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT,
      dkp REAL,
      PRIMARY KEY (run_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS latest (
      player_id  BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      name       TEXT,
      updated_at timestamptz NOT NULL,
      power BIGINT, kills BIGINT, dead BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT
    );

    CREATE TABLE IF NOT EXISTS cursor (
      run_id  BIGINT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      stage   TEXT,
      idx     INTEGER,
      updated_at timestamptz NOT NULL
    );

    -- Зони (міграція: було zone_number INT; додаємо zone_code TEXT + унік. індекс)
    CREATE TABLE IF NOT EXISTS zone_scans (
      id SERIAL PRIMARY KEY,
      zone_code TEXT,
      start_scan_time timestamptz,
      end_scan_time timestamptz,
      start_scan_data JSONB,
      end_scan_data JSONB
    );
  `);

  // Міграції для zone_scans
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='zone_scans' AND column_name='zone_code'
      ) THEN
        ALTER TABLE zone_scans ADD COLUMN zone_code TEXT;
      END IF;
      -- Якщо колись був zone_number — спробуємо перенести значення
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='zone_scans' AND column_name='zone_number'
      ) THEN
        UPDATE zone_scans SET zone_code = COALESCE(zone_code, zone_number::text);
      END IF;
    END$$;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_zone_scans_zone_code ON zone_scans(zone_code);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kvk_periods (
      kvk_id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz
    );

    CREATE TABLE IF NOT EXISTS kvk_config (
      kvk_id BIGINT PRIMARY KEY REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      kills_weight   NUMERIC NOT NULL DEFAULT 1.0,
      dead_to_kills  NUMERIC NOT NULL DEFAULT 5.0
    );

    CREATE TABLE IF NOT EXISTS kvk_goals (
      kvk_id    BIGINT NOT NULL REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      goal_kills BIGINT NOT NULL,
      goal_dead  BIGINT NOT NULL,
      goal_dkp   BIGINT NOT NULL,
      start_power BIGINT NOT NULL,
      start_kills BIGINT NOT NULL,
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

  // View прогресу
  await pool.query(`
    CREATE OR REPLACE VIEW kvk_progress AS
    SELECT
      g.kvk_id,
      g.player_id,
      p.name,
      l.updated_at,
      GREATEST(l.kills - g.start_kills, 0) AS d_kills,
      GREATEST(l.dead  - g.start_dead,  0) AS d_dead,
      c.kills_weight,
      c.dead_to_kills,
      (GREATEST(l.kills - g.start_kills,0) * c.kills_weight
      +GREATEST(l.dead  - g.start_dead,0)  * c.dead_to_kills)::bigint AS dkp,
      g.goal_kills, g.goal_dead, g.goal_dkp,
      CASE WHEN g.goal_dkp > 0 THEN ROUND(100.0 *
        ((GREATEST(l.kills - g.start_kills,0) * c.kills_weight
        + GREATEST(l.dead - g.start_dead,0) * c.dead_to_kills) / g.goal_dkp), 1)
      ELSE 0 END AS pct
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
}

// ---------------- Base ops ----------------
export async function closeDb() { await pool.end(); }

export async function beginRun() {
  const { rows } = await pool.query(
    `INSERT INTO runs DEFAULT VALUES RETURNING run_id`
  );
  return rows[0].run_id;
}

export async function upsertPlayer({ id, name }) {
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [id, name ?? null]
  );
}

export async function insertStats(run_id, player_id, s) {
  await pool.query(
    `INSERT INTO stats (run_id, player_id, power, kills, dead, t1, t2, t3, t4, t5, dkp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (run_id, player_id) DO UPDATE SET
       power = EXCLUDED.power,
       kills = EXCLUDED.kills,
       dead  = EXCLUDED.dead,
       t1    = EXCLUDED.t1,
       t2    = EXCLUDED.t2,
       t3    = EXCLUDED.t3,
       t4    = EXCLUDED.t4,
       t5    = EXCLUDED.t5,
       dkp   = COALESCE(EXCLUDED.dkp, stats.dkp)`,
    [
      run_id, player_id,
      s.power ?? null,
      s.kills ?? null,     // ВАЖЛИВО: тут вже число (t4+t5)
      s.dead ?? null,
      s.kills?.t1 ?? s.t1 ?? null,
      s.kills?.t2 ?? s.t2 ?? null,
      s.kills?.t3 ?? s.t3 ?? null,
      s.kills?.t4 ?? s.t4 ?? null,
      s.kills?.t5 ?? s.t5 ?? null,
      s.dkp ?? null
    ]
  );

  await pool.query(
    `INSERT INTO latest (player_id, name, updated_at, power, kills, dead, t1, t2, t3, t4, t5)
     VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (player_id) DO UPDATE SET
       name       = EXCLUDED.name,
       updated_at = EXCLUDED.updated_at,
       power = EXCLUDED.power, kills = EXCLUDED.kills, dead = EXCLUDED.dead,
       t1 = EXCLUDED.t1, t2 = EXCLUDED.t2, t3 = EXCLUDED.t3, t4 = EXCLUDED.t4, t5 = EXCLUDED.t5`,
    [
      player_id, (s.name ?? null),
      s.power ?? null,
      s.kills ?? null,
      s.dead ?? null,
      s.kills?.t1 ?? s.t1 ?? null,
      s.kills?.t2 ?? s.t2 ?? null,
      s.kills?.t3 ?? s.t3 ?? null,
      s.kills?.t4 ?? s.t4 ?? null,
      s.kills?.t5 ?? s.t5 ?? null
    ]
  );
}

// Cursor (optional)
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

// ---------------- KvK helpers ----------------
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
    `SELECT kvk_id FROM kvk_periods
      WHERE ended_at IS NULL
      ORDER BY kvk_id DESC LIMIT 1`
  );
  return rows[0]?.kvk_id || null;
}

export async function ensureActiveKvK(name = null) {
  let id = await kvkActiveId();
  if (id) return id;
  id = await kvkStart(name);
  return id;
}

export async function kvkSetWeight(which, value, kvk_id = null) {
  const col = which === "dead" ? "dead_to_kills"
            : which === "kills" ? "kills_weight"
            : null;
  if (!col) throw new Error(`Unknown weight "${which}" (use "dead" or "kills")`);
  if (!kvk_id) kvk_id = await kvkActiveId();
  if (!kvk_id) throw new Error("No active KvK. Run kvkStart first.");
  await pool.query(`UPDATE kvk_config SET ${col}=$1 WHERE kvk_id=$2`, [Number(value), kvk_id]);
}

export async function kvkEnsureGoal(player_id) {
  const kvk_id = await kvkActiveId();
  if (!kvk_id) return null;

  const { rows } = await pool.query(
    `SELECT 1 FROM kvk_goals WHERE kvk_id=$1 AND player_id=$2`,
    [kvk_id, player_id]
  );
  if (rows.length) return null;

  const { rows: lrows } = await pool.query(
    `SELECT * FROM latest WHERE player_id=$1`, [player_id]
  );
  if (!lrows.length) return null;
  const l = lrows[0];

  const { rows: cr } = await pool.query(
    `SELECT kills_weight, dead_to_kills FROM kvk_config WHERE kvk_id=$1`, [kvk_id]
  );
  const cfg = cr[0];

  // Цілі за power (можеш підкрутити формулу)
  const goal_kills = Math.round(2.2 * Number(l.power || 0));
  const goal_dead  = Math.round(Number(l.power || 0) / 87);
  const goal_dkp   = Math.round(cfg.kills_weight * goal_kills + cfg.dead_to_kills * goal_dead);

  await pool.query(`
    INSERT INTO kvk_goals
      (kvk_id, player_id, goal_kills, goal_dead, goal_dkp,
       start_power, start_kills, start_dead, start_t1, start_t2, start_t3, start_t4, start_t5)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (kvk_id, player_id) DO UPDATE SET
      goal_kills=EXCLUDED.goal_kills, goal_dead=EXCLUDED.goal_dead, goal_dkp=EXCLUDED.goal_dkp
  `, [
    kvk_id, player_id, goal_kills, goal_dead, goal_dkp,
    l.power||0, l.kills||0, l.dead||0, l.t1||0, l.t2||0, l.t3||0, l.t4||0, l.t5||0
  ]);

  return { kvk_id, goal_kills, goal_dead, goal_dkp };
}

export async function kvkProgress(player_id) {
  const { rows } = await pool.query(
    `SELECT * FROM kvk_progress
      WHERE player_id=$1
      ORDER BY kvk_id DESC LIMIT 1`,
    [player_id]
  );
  return rows[0] || null;
}

export async function kvkTop(limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM kvk_progress
      ORDER BY pct DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit)||10,1),50)]
  );
  return rows;
}

// ---------------- Deltas helpers ----------------
export async function getLastStats(player_id, limit = 2) {
  const { rows } = await pool.query(
    `SELECT run_id, player_id, power, kills, dead, t1, t2, t3, t4, t5, dkp
       FROM stats
      WHERE player_id=$1
      ORDER BY run_id DESC
      LIMIT $2`,
    [player_id, Math.max(1, Number(limit) || 2)]
  );
  return rows;
}

export function computeDeltas(latest, previous) {
  if (!latest || !previous) return null;
  const d = (a, b) => (Number(a || 0) - Number(b || 0));
  return {
    d_power: d(latest.power, previous.power),
    d_kills: d(latest.kills, previous.kills),
    d_dead:  d(latest.dead,  previous.dead),
    d_t1:    d(latest.t1,    previous.t1),
    d_t2:    d(latest.t2,    previous.t2),
    d_t3:    d(latest.t3,    previous.t3),
    d_t4:    d(latest.t4,    previous.t4),
    d_t5:    d(latest.t5,    previous.t5),
    d_dkp:  (latest.dkp != null && previous.dkp != null)
            ? (Number(latest.dkp) - Number(previous.dkp))
            : null
  };
}

export async function insertStatsWithKvKAndDeltas(run_id, player_id, s) {
  await insertStats(run_id, player_id, s);
  await kvkEnsureGoal(player_id);
  const progress = await kvkProgress(player_id);
  const last2 = await getLastStats(player_id, 2);
  const latest   = last2[0] || null;
  const previous = last2[1] || null;
  const deltas = computeDeltas(latest, previous);
  return { progress, deltas };
}

// ---------------- Zone helpers (тепер zone_code TEXT) ----------------
export async function zoneStart(zone, scan_data = null) {
  const code = String(zone);
  await pool.query(
    `INSERT INTO zone_scans (zone_code, start_scan_time, start_scan_data)
     VALUES ($1, now(), $2)
     ON CONFLICT (zone_code) DO UPDATE SET
       start_scan_time = COALESCE(zone_scans.start_scan_time, EXCLUDED.start_scan_time),
       start_scan_data = COALESCE(zone_scans.start_scan_data, EXCLUDED.start_scan_data)`,
    [code, scan_data ? JSON.stringify(scan_data) : null]
  );
}

export async function zoneFinish(zone, scan_data = null) {
  const code = String(zone);
  await pool.query(
    `INSERT INTO zone_scans (zone_code, end_scan_time, end_scan_data)
     VALUES ($1, now(), $2)
     ON CONFLICT (zone_code) DO UPDATE SET
       end_scan_time = EXCLUDED.end_scan_time,
       end_scan_data = EXCLUDED.end_scan_data`,
    [code, scan_data ? JSON.stringify(scan_data) : null]
  );
}

export async function getZone(zone) {
  const code = String(zone);
  const { rows } = await pool.query(
    `SELECT * FROM zone_scans WHERE zone_code=$1`,
    [code]
  );
  return rows[0] || null;
}

export async function listZones() {
  const { rows } = await pool.query(
    `SELECT zone_code, start_scan_time, end_scan_time
     FROM zone_scans ORDER BY start_scan_time NULLS LAST, zone_code ASC`
  );
  return rows;
}