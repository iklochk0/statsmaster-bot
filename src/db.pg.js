// src/db.pg.js
// DB layer: players/runs/stats/latest/KvK/zone_scans
// + нормалізація kills (t4+t5) перед записом

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
      kills     BIGINT,   -- ми тепер пишемо сюди t4+t5
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
      kills BIGINT,  -- теж t4+t5 останнього збору
      dead BIGINT,
      t1 BIGINT, t2 BIGINT, t3 BIGINT, t4 BIGINT, t5 BIGINT
    );

    CREATE TABLE IF NOT EXISTS cursor (
      run_id  BIGINT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      stage   TEXT,
      idx     INTEGER,
      updated_at timestamptz NOT NULL
    );

    -- Zone scans: одна зона = один запис
    -- zone_name як TEXT (наприклад "Zone1 start war" / "Kingsland" / "Pass fight" і т.д.)
    CREATE TABLE IF NOT EXISTS zone_scans (
      zone_name        TEXT PRIMARY KEY,
      start_scan_time  timestamptz,
      end_scan_time    timestamptz,
      start_scan_data  JSONB,
      end_scan_data    JSONB
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

  // View прогресу по KvK:
  // d_kills = (latest.kills - start_kills) але latest.kills вже це t4+t5
  // d_dead  = (latest.dead  - start_dead)
  // dkp     = d_kills * kills_weight + d_dead * dead_to_kills
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
      (
        GREATEST(l.kills - g.start_kills,0) * c.kills_weight
        + GREATEST(l.dead  - g.start_dead,0) * c.dead_to_kills
      )::bigint AS dkp,
      g.goal_kills,
      g.goal_dead,
      g.goal_dkp,
      CASE
        WHEN g.goal_dkp > 0 THEN
          ROUND(
            100.0 * (
              (
                GREATEST(l.kills - g.start_kills,0) * c.kills_weight
                + GREATEST(l.dead  - g.start_dead,0) * c.dead_to_kills
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

// ---------------- Base ops ----------------
export async function closeDb() {
  await pool.end();
}

export async function beginRun() {
  const { rows } = await pool.query(
    `INSERT INTO runs DEFAULT VALUES RETURNING run_id`
  );
  return rows[0].run_id;
}

export async function upsertPlayer({ id, name }) {
  await pool.query(
    `INSERT INTO players (id, name)
     VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name`,
    [id, name ?? null]
  );
}

// -------- helper: нормалізація raw stats від OCR -> готово до БД --------
function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatsForDb(s) {
  // Очікуємо:
  // s.kills  --> це ВЖЕ kill points (KP), повне число
  // s.t1..t5 (або s.kills_by_tier) --> деталізація
  //
  // Якщо с.kills немає або воно не число, тоді як fallback беремо t4+t5.

  const tierObj = s.kills_by_tier || s.kills || {};

  const t1 = toNumOrNull(tierObj.t1);
  const t2 = toNumOrNull(tierObj.t2);
  const t3 = toNumOrNull(tierObj.t3);
  const t4 = toNumOrNull(tierObj.t4);
  const t5 = toNumOrNull(tierObj.t5);

  // killsNum = kill points (як прийшло з OCR в s.kills)
  let killsNum = toNumOrNull(s.kills);

  // fallback: якщо kill points не прочиталось, тоді хоча б t4+t5
  if (killsNum === null) {
    if (t4 !== null || t5 !== null) {
      killsNum = (t4 ?? 0) + (t5 ?? 0);
    }
  }

  return {
    name: s.name ?? null,
    power: toNumOrNull(s.power),
    dead:  toNumOrNull(s.dead),
    t1,
    t2,
    t3,
    t4,
    t5,
    killsNum,   // <-- це тепер KP
    dkp: toNumOrNull(s.dkp)
  };
}

// -------- insertStats --------
export async function insertStats(run_id, player_id, sRaw) {
  const s = normalizeStatsForDb(sRaw);

  // stats table insert / upsert
  await pool.query(
    `INSERT INTO stats (
        run_id,
        player_id,
        power,
        kills,
        dead,
        t1, t2, t3, t4, t5,
        dkp
      )
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
       dkp   = COALESCE(EXCLUDED.dkp, stats.dkp)
    `,
    [
      run_id,
      player_id,
      s.power ?? null,
      s.killsNum ?? null,
      s.dead ?? null,
      s.t1 ?? null,
      s.t2 ?? null,
      s.t3 ?? null,
      s.t4 ?? null,
      s.t5 ?? null,
      s.dkp ?? null
    ]
  );

  // latest table upsert
  await pool.query(
    `INSERT INTO latest (
        player_id,
        name,
        updated_at,
        power,
        kills,
        dead,
        t1, t2, t3, t4, t5
      )
     VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (player_id) DO UPDATE SET
       name       = EXCLUDED.name,
       updated_at = EXCLUDED.updated_at,
       power      = EXCLUDED.power,
       kills      = EXCLUDED.kills,
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
      s.killsNum ?? null,
      s.dead ?? null,
      s.t1 ?? null,
      s.t2 ?? null,
      s.t3 ?? null,
      s.t4 ?? null,
      s.t5 ?? null
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
function pickGoalsByPower(rawPower) {
  const p = Number(rawPower || 0); // абсолютне число, типу 77_970_457
  const mil = p / 1_000_000;       // у мільйонах для діапазонів

  // Йдемо зверху вниз
  if (mil >= 130) return { goal_kills: 35_000_000, goal_dead: 2_500_000 };
  if (mil >= 120) return { goal_kills: 34_000_000, goal_dead: 2_000_000 };
  if (mil >= 110) return { goal_kills: 33_000_000, goal_dead: 1_800_000 };
  if (mil >= 100) return { goal_kills: 32_000_000, goal_dead: 1_650_000 };
  if (mil >= 95)  return { goal_kills: 30_000_000, goal_dead: 1_500_000 };
  if (mil >= 90)  return { goal_kills: 29_000_000, goal_dead: 1_400_000 };
  if (mil >= 85)  return { goal_kills: 28_000_000, goal_dead: 1_000_000 };
  if (mil >= 80)  return { goal_kills: 28_000_000, goal_dead:   850_000 };
  if (mil >= 75)  return { goal_kills: 27_000_000, goal_dead:   800_000 };
  if (mil >= 70)  return { goal_kills: 24_000_000, goal_dead:   750_000 };
  if (mil >= 65)  return { goal_kills: 20_000_000, goal_dead:   700_000 };
  if (mil >= 60)  return { goal_kills: 16_000_000, goal_dead:   650_000 };
  if (mil >= 55)  return { goal_kills: 13_000_000, goal_dead:   600_000 };
  if (mil >= 50)  return { goal_kills:  8_000_000, goal_dead:   550_000 };
  if (mil >= 45)  return { goal_kills:  5_000_000, goal_dead:   500_000 };
  // <45
  return               { goal_kills:  4_000_000, goal_dead:   450_000 };
}
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
  // which === "kills" або "dead"
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

export async function kvkEnsureGoal(player_id) {
  const kvk_id = await kvkActiveId();
  if (!kvk_id) return null;

  // вже існує?
  const { rows } = await pool.query(
    `SELECT 1 FROM kvk_goals
      WHERE kvk_id=$1 AND player_id=$2`,
    [kvk_id, player_id]
  );
  if (rows.length) return null;

  // беремо latest по цьому гравцю
  const { rows: lrows } = await pool.query(
    `SELECT * FROM latest WHERE player_id=$1`,
    [player_id]
  );
  if (!lrows.length) return null;
  const l = lrows[0];

  // конфіг з вагами
  const { rows: cr } = await pool.query(
    `SELECT kills_weight, dead_to_kills
       FROM kvk_config
      WHERE kvk_id=$1`,
    [kvk_id]
  );
  const cfg = cr[0];

  // цілі з твоєї таблиці
  const { goal_kills, goal_dead } = pickGoalsByPower(l.power);

  // розрахунок DKP цілі
  const goal_dkp = Math.round(
    Number(cfg.kills_weight)   * goal_kills +
    Number(cfg.dead_to_kills)  * goal_dead
  );

  // стартові значення = поточні latest
  await pool.query(`
    INSERT INTO kvk_goals
      (kvk_id, player_id,
       goal_kills, goal_dead, goal_dkp,
       start_power, start_kills, start_dead,
       start_t1, start_t2, start_t3, start_t4, start_t5)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (kvk_id, player_id) DO UPDATE SET
      goal_kills=EXCLUDED.goal_kills,
      goal_dead =EXCLUDED.goal_dead,
      goal_dkp  =EXCLUDED.goal_dkp
  `, [
    kvk_id,
    player_id,
    goal_kills,
    goal_dead,
    goal_dkp,
    l.power||0,
    l.kills||0, // kills тепер KP
    l.dead||0,
    l.t1||0, l.t2||0, l.t3||0, l.t4||0, l.t5||0
  ]);

  return { kvk_id, goal_kills, goal_dead, goal_dkp };
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

// ---------------- Deltas helpers ----------------
export async function getLastStats(player_id, limit = 2) {
  const { rows } = await pool.query(
    `SELECT run_id, player_id,
            power, kills, dead,
            t1, t2, t3, t4, t5,
            dkp
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

export async function insertStatsWithKvKAndDeltas(run_id, player_id, sRaw) {
  await insertStats(run_id, player_id, sRaw);
  await kvkEnsureGoal(player_id);

  const progress = await kvkProgress(player_id);
  const last2    = await getLastStats(player_id, 2);
  const latest   = last2[0] || null;
  const previous = last2[1] || null;
  const deltas   = computeDeltas(latest, previous);

  return { progress, deltas };
}

// ---------------- Zone helpers ----------------
// start = фіксуємо "перед зоною"
// finish = фіксуємо "після зони"
export async function zoneStart(zone_name, scan_data = null) {
  await pool.query(
    `INSERT INTO zone_scans (zone_name, start_scan_time, start_scan_data)
     VALUES ($1, now(), $2)
     ON CONFLICT (zone_name) DO NOTHING`,
    [zone_name, scan_data ? JSON.stringify(scan_data) : null]
  );
}

export async function zoneFinish(zone_name, scan_data = null) {
  await pool.query(
    `UPDATE zone_scans
        SET end_scan_time = now(),
            end_scan_data = $2
      WHERE zone_name = $1`,
    [zone_name, scan_data ? JSON.stringify(scan_data) : null]
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
    `SELECT zone_name, start_scan_time, end_scan_time
       FROM zone_scans
      ORDER BY start_scan_time ASC NULLS LAST, zone_name ASC`
  );
  return rows;
}