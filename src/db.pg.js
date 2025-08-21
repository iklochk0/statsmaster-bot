import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- Base schema (як було) ----------------
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id       BIGINT PRIMARY KEY,
      name     TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id      BIGSERIAL PRIMARY KEY,
      started_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stats (
      run_id   BIGINT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      power    BIGINT, kp BIGINT, dead BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT,
      PRIMARY KEY (run_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS latest (
      player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      name      TEXT,
      updated_at timestamptz NOT NULL,
      power    BIGINT, kp BIGINT, dead BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT
    );

    CREATE TABLE IF NOT EXISTS cursor (
      run_id  BIGINT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      stage   TEXT,
      idx     INTEGER,
      updated_at timestamptz NOT NULL
    );
  `);

  // -------- KvK + DKP layer --------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kvk_periods (
      kvk_id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz
    );

    CREATE TABLE IF NOT EXISTS kvk_config (
      kvk_id BIGINT PRIMARY KEY REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      kp_weight   NUMERIC NOT NULL DEFAULT 1.0,
      dead_to_kp  NUMERIC NOT NULL DEFAULT 5.0
    );

    CREATE TABLE IF NOT EXISTS kvk_goals (
      kvk_id    BIGINT NOT NULL REFERENCES kvk_periods(kvk_id) ON DELETE CASCADE,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      goal_kp   BIGINT NOT NULL,
      goal_dead BIGINT NOT NULL,
      goal_dkp  BIGINT NOT NULL,
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

  // View для швидкого прогресу
  await pool.query(`
    CREATE OR REPLACE VIEW kvk_progress AS
    SELECT
      g.kvk_id,
      g.player_id,
      p.name,
      l.updated_at,
      GREATEST(l.kp - g.start_kp, 0)   AS d_kp,
      GREATEST(l.dead - g.start_dead, 0) AS d_dead,
      c.kp_weight,
      c.dead_to_kp,
      (GREATEST(l.kp - g.start_kp,0) * c.kp_weight +
       GREATEST(l.dead - g.start_dead,0) * c.dead_to_kp)::bigint AS dkp,
      g.goal_kp, g.goal_dead, g.goal_dkp,
      CASE WHEN g.goal_dkp > 0 THEN ROUND(100.0 *
        ((GREATEST(l.kp - g.start_kp,0) * c.kp_weight +
          GREATEST(l.dead - g.start_dead,0) * c.dead_to_kp) / g.goal_dkp), 1)
      ELSE 0 END AS pct
    FROM kvk_goals g
    JOIN latest l ON l.player_id = g.player_id
    JOIN players p ON p.id = g.player_id
    JOIN kvk_config c ON c.kvk_id = g.kvk_id;
  `);
}

// ---- базові функції (як було) ----
export async function beginRun() {
  const { rows } = await pool.query(`INSERT INTO runs DEFAULT VALUES RETURNING run_id`);
  return rows[0].run_id;
}

export async function upsertPlayer({ id, name }) {
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET name=excluded.name`,
    [id, name ?? null]
  );
}

export async function insertStats(run_id, player_id, s) {
  await pool.query(
    `INSERT INTO stats (run_id, player_id, power, kp, dead, t1, t2, t3, t4, t5)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (run_id, player_id) DO UPDATE SET
       power=excluded.power, kp=excluded.kp, dead=excluded.dead,
       t1=excluded.t1, t2=excluded.t2, t3=excluded.t3, t4=excluded.t4, t5=excluded.t5`,
    [run_id, player_id, s.power, s.kp, s.dead, s.kills.t1, s.kills.t2, s.kills.t3, s.kills.t4, s.kills.t5]
  );

  await pool.query(
    `INSERT INTO latest (player_id, name, updated_at, power, kp, dead, t1, t2, t3, t4, t5)
     VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (player_id) DO UPDATE SET
       name=excluded.name,
       updated_at=excluded.updated_at,
       power=excluded.power, kp=excluded.kp, dead=excluded.dead,
       t1=excluded.t1, t2=excluded.t2, t3=excluded.t3, t4=excluded.t4, t5=excluded.t5`,
    [player_id, s.name ?? null, s.power, s.kp, s.dead, s.kills.t1, s.kills.t2, s.kills.t3, s.kills.t4, s.kills.t5]
  );
}

export async function saveCursor(run_id, stage, idx) {
  await pool.query(
    `INSERT INTO cursor (run_id, stage, idx, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (run_id) DO UPDATE SET stage=excluded.stage, idx=excluded.idx, updated_at=excluded.updated_at`,
    [run_id, stage, idx]
  );
}

export async function loadCursor(run_id) {
  const { rows } = await pool.query(`SELECT stage, idx FROM cursor WHERE run_id=$1`, [run_id]);
  return rows[0] ?? null;
}

export async function closeDb() { await pool.end(); }

// -------- KvK + DKP helpers --------
export async function kvkStart(name = null) {
  const { rows } = await pool.query(
    `INSERT INTO kvk_periods(name) VALUES ($1) RETURNING kvk_id`,
    [name || `KvK ${new Date().toISOString().slice(0,10)}`]
  );
  const kvk_id = rows[0].kvk_id;
  await pool.query(`INSERT INTO kvk_config(kvk_id) VALUES ($1)`, [kvk_id]); // дефолтні ваги
  return kvk_id;
}

export async function kvkActiveId() {
  const { rows } = await pool.query(
    `SELECT kvk_id FROM kvk_periods WHERE ended_at IS NULL ORDER BY kvk_id DESC LIMIT 1`
  );
  return rows[0]?.kvk_id || null;
}

export async function kvkSetWeight(which, value, kvk_id = null) {
  const col = which === "dead" ? "dead_to_kp" : which === "kp" ? "kp_weight" : null;
  if (!col) throw new Error(`Unknown weight "${which}" (use "dead" or "kp")`);
  if (!kvk_id) kvk_id = await kvkActiveId();
  if (!kvk_id) throw new Error("No active KvK. Run kvkStart first.");
  await pool.query(`UPDATE kvk_config SET ${col}=$1 WHERE kvk_id=$2`, [Number(value), kvk_id]);
}

export async function kvkSetGoalAuto(player_id, kvk_id = null) {
  if (!kvk_id) kvk_id = await kvkActiveId();
  if (!kvk_id) throw new Error("No active KvK. Run kvkStart first.");

  const { rows: lrows } = await pool.query(`SELECT * FROM latest WHERE player_id=$1`, [player_id]);
  if (!lrows.length) throw new Error("No latest row for player (scan first).");
  const l = lrows[0];

  const { rows: cr } = await pool.query(`SELECT kp_weight, dead_to_kp FROM kvk_config WHERE kvk_id=$1`, [kvk_id]);
  const cfg = cr[0];

  const goal_kp   = Math.round(2.2 * Number(l.power || 0));
  const goal_dead = Math.round(Number(l.power || 0) / 87);
  const goal_dkp  = Math.round(cfg.kp_weight * goal_kp + cfg.dead_to_kp * goal_dead);

  await pool.query(`
    INSERT INTO kvk_goals
      (kvk_id, player_id, goal_kp, goal_dead, goal_dkp,
       start_power, start_kp, start_dead, start_t1, start_t2, start_t3, start_t4, start_t5)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (kvk_id, player_id) DO UPDATE SET
      goal_kp=excluded.goal_kp, goal_dead=excluded.goal_dead, goal_dkp=excluded.goal_dkp
  `, [
    kvk_id, player_id, goal_kp, goal_dead, goal_dkp,
    l.power||0, l.kp||0, l.dead||0, l.t1||0, l.t2||0, l.t3||0, l.t4||0, l.t5||0
  ]);

  return { kvk_id, goal_kp, goal_dead, goal_dkp };
}

export async function kvkProgress(player_id) {
  const { rows } = await pool.query(
    `SELECT * FROM kvk_progress WHERE player_id=$1 ORDER BY kvk_id DESC LIMIT 1`,
    [player_id]
  );
  return rows[0] || null;
}

export async function kvkTop(limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM kvk_progress ORDER BY pct DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit)||10,1),50)]
  );
  return rows;
}

export async function kvkEnsureGoal(player_id) {
  const kvk_id = await kvkActiveId();
  if (!kvk_id) return null; // KvK ще не стартував
  const { rows } = await pool.query(
    `SELECT 1 FROM kvk_goals WHERE kvk_id=$1 AND player_id=$2`,
    [kvk_id, player_id]
  );
  if (rows.length) return null;
  // створюємо стартовий знімок і goal_* від power
  return await kvkSetGoalAuto(player_id, kvk_id);
}
