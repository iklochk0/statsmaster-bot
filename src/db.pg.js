// src/db.pg.js
//
// Центральна логіка БД під нову модель.
//
// Головні концепти:
//
// players
//   - baseline на старт KvK (power_current / kp_current / dead_current / t4/t5_current)
//   - ми це чіпаємо тільки через OCR або ручний фікс адміна
//
// kvk_sessions
//   - активна KvK сесія
//
// kvk_goals
//   - цілі на цей KvK для кожного акаунта
//   - main -> таблиця по power
//   - farm -> dead=600k, kills=0
//
// imports
//   - дельти з Excel за певний інтервал бою
//   - is_scoring=true означає бойовий внесок (рахується у прогрес)
//
// account_links
//   - звʼязок main ↔ farm
//   - статус pending / approved / rejected
//   - одна ферма не може бути в двох мейнів (UNIQUE на farm_player_id)
//   - якщо запис approved => цей farm вважається фермою
//
// Як ми рахуємо показник для картки:
//   "теперішні значення" = baseline + Σ(usіх imports)
//   "твій внесок у KvK"  = Σ(imports де is_scoring=true)
//
//
// ВАЖЛИВО: у всіх запитах player_id в PG ми шлемо як string,
// бо це BIGINT у Postgres.
//

import "dotenv/config";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ───────────────── helpers ───────────────── */

function toNum(v, def = 0) {
  if (v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// таблиця вимог (з твого екселю на скріні) для МЕЙН акаунта
function computeGoalsForMainByPower(powerAbs) {
  const pm = Number(powerAbs || 0) / 1_000_000;

  if (pm > 130) return { goal_kills: 35_000_000, goal_dead: 2_500_000 };
  if (pm >= 120) return { goal_kills: 34_000_000, goal_dead: 2_000_000 };
  if (pm >= 110) return { goal_kills: 33_000_000, goal_dead: 1_800_000 };
  if (pm >= 100) return { goal_kills: 32_000_000, goal_dead: 1_650_000 };
  if (pm >= 95)  return { goal_kills: 30_000_000, goal_dead: 1_500_000 };
  if (pm >= 90)  return { goal_kills: 29_000_000, goal_dead: 1_400_000 };
  if (pm >= 85)  return { goal_kills: 28_000_000, goal_dead: 1_000_000 };
  if (pm >= 80)  return { goal_kills: 28_000_000, goal_dead:   850_000 };
  if (pm >= 75)  return { goal_kills: 27_000_000, goal_dead:   800_000 };
  if (pm >= 70)  return { goal_kills: 24_000_000, goal_dead:   750_000 };
  if (pm >= 65)  return { goal_kills: 20_000_000, goal_dead:   700_000 };
  if (pm >= 60)  return { goal_kills: 16_000_000, goal_dead:   650_000 };
  if (pm >= 55)  return { goal_kills: 13_000_000, goal_dead:   600_000 };
  if (pm >= 50)  return { goal_kills:  8_000_000, goal_dead:   550_000 };
  if (pm >= 45)  return { goal_kills:  5_000_000, goal_dead:   500_000 };
  return           { goal_kills:  4_000_000, goal_dead:   450_000 };
}

// фермерська ціль
function computeGoalsForFarm() {
  return {
    goal_kills: 0,
    goal_dead: 600_000,
  };
}

// DKP шкала: повністю виконав свої цілі = 10_000 DKP
// kills і dead дають по 50% кожен
function computeDkpProgress(killsDone, deadDone, goalKills, goalDead) {
  const gKills = toNum(goalKills, 0);
  const gDead  = toNum(goalDead, 0);

  // частка виконання по кожній метриці (може бути >1 при оверкапі)
  const killsFrac = gKills > 0 ? killsDone / gKills : 0;
  const deadFrac  = gDead  > 0 ? deadDone  / gDead  : 0;

  // середнє 50/50
  const avgFrac = (killsFrac + deadFrac) / 2; // 1.0 = виконав план на 100%

  // DKP ми показуємо на красивій шкалі 0..10_000 (і вище, якщо оверкап)
  const dkpGoal = 10_000;
  const dkpNow  = Math.round(avgFrac * dkpGoal);

  // pct для бейджа зверху (відсоток)
  const pctRaw = avgFrac * 100;

  return {
    goal_dkp: dkpGoal,  // 10,000
    dkpDone:  dkpNow,   // типу 237, 8750, 13200...
    pct:      pctRaw,   // 0..∞%, використовується для бейджа і барів % текстом
  };
}

/* ───────────────── schema init ───────────────── */

export async function initSchema() {
  // KvK сесії
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kvk_sessions (
      kvk_id      BIGSERIAL PRIMARY KEY,
      name        TEXT,
      started_at  timestamptz NOT NULL DEFAULT now(),
      ended_at    timestamptz
    );
  `);

  // Гравці (baseline на старті KvK, з OCR)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      player_id           BIGINT PRIMARY KEY,
      name                TEXT NOT NULL DEFAULT '',

      power_current       BIGINT NOT NULL DEFAULT 0,
      kp_current          BIGINT NOT NULL DEFAULT 0,
      dead_current        BIGINT NOT NULL DEFAULT 0,
      t4_kills_current    BIGINT NOT NULL DEFAULT 0,
      t5_kills_current    BIGINT NOT NULL DEFAULT 0,

      last_update         timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Discord ↔ player_id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_links (
      discord_id TEXT PRIMARY KEY,
      player_id  BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE
    );
  `);

  // Прив'язки main ↔ farm (заявки)
  // status:
  //   pending   -> чекає на адміна
  //   approved  -> це ферма цього мейна
  //   rejected  -> адмін відхилив
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_links (
      request_id BIGSERIAL PRIMARY KEY,

      owner_player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
      farm_player_id  BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,

      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),

      requested_by_discord_id TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at  TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS account_links_farm_unique
    ON account_links(farm_player_id);
  `);

  // Цілі гравців на KvK
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kvk_goals (
      kvk_id        BIGINT NOT NULL REFERENCES kvk_sessions(kvk_id) ON DELETE CASCADE,
      player_id     BIGINT NOT NULL REFERENCES players(player_id)  ON DELETE CASCADE,

      start_power   BIGINT NOT NULL,
      start_dead    BIGINT NOT NULL,
      start_t4      BIGINT NOT NULL,
      start_t5      BIGINT NOT NULL,

      goal_kills    BIGINT NOT NULL,
      goal_dead     BIGINT NOT NULL,

      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kvk_id, player_id)
    );
  `);

  // Дельти з Excel (кожен імпорт — внесок за один період)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS imports (
      import_id    BIGSERIAL PRIMARY KEY,

      kvk_id       BIGINT NOT NULL REFERENCES kvk_sessions(kvk_id) ON DELETE CASCADE,
      player_id    BIGINT NOT NULL REFERENCES players(player_id)  ON DELETE CASCADE,

      import_ts    timestamptz NOT NULL,
      zone_tag     TEXT NOT NULL,
      is_scoring   BOOLEAN NOT NULL DEFAULT true,

      power        BIGINT NOT NULL DEFAULT 0,
      kp           BIGINT NOT NULL DEFAULT 0,
      dead         BIGINT NOT NULL DEFAULT 0,
      t4_kills     BIGINT NOT NULL DEFAULT 0,
      t5_kills     BIGINT NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_imports_player
      ON imports(player_id);
    CREATE INDEX IF NOT EXISTS idx_imports_kvk
      ON imports(kvk_id);
    CREATE INDEX IF NOT EXISTS idx_imports_scoring
      ON imports(is_scoring);
  `);
}

/* ───────────────── KvK session helpers ───────────────── */

export async function startKvK(name = null) {
  const { rows } = await pool.query(
    `INSERT INTO kvk_sessions(name)
     VALUES ($1)
     RETURNING kvk_id`,
    [name || `KvK ${new Date().toISOString().slice(0,10)}`]
  );
  return rows[0].kvk_id;
}

export async function getActiveKvK() {
  const { rows } = await pool.query(`
    SELECT kvk_id
    FROM kvk_sessions
    WHERE ended_at IS NULL
    ORDER BY kvk_id DESC
    LIMIT 1
  `);
  return rows[0]?.kvk_id || null;
}

function kpPctForPower(powerAbs) {
  const pm = powerAbs / 1_000_000;
  if (pm >= 100) return 350;
  if (pm >= 80) return 310;
  if (pm >= 70) return 290;
  if (pm >= 60) return 250;
  if (pm >= 50) return 200;
  if (pm >= 40) return 140;
  if (pm >= 30) return 100;
  return 100;
}

function computeKpGoal(powerAbs) {
  const pct = kpPctForPower(powerAbs);
  return Math.round(powerAbs * (pct / 100));
}

export async function endActiveKvK() {
  const { rows } = await pool.query(`
    UPDATE kvk_sessions
       SET ended_at = now()
     WHERE kvk_id = (
       SELECT kvk_id
       FROM kvk_sessions
       WHERE ended_at IS NULL
       ORDER BY kvk_id DESC
       LIMIT 1
     )
     RETURNING kvk_id
  `);
  return rows[0]?.kvk_id || null;
}

/* ───────────────── baseline з OCR ─────────────────
   upsertBaselineFromOCR(kvk_id, scanRow)
   scanRow = {
     player_id,
     name,
     power,
     kp,
     dead,
     t4,
     t5
   }

   - апсерт у players (baseline)
   - якщо goals ще нема → створюємо як main (по таблиці power)
   - якщо goals вже є → не трогаємо goals (бо могли вже вручну міняти)
*/
export async function upsertBaselineFromOCR(kvk_id, scanRow, client = null) {
  const db = client || pool;
  const kvkStr = String(kvk_id);
  const pidStr = String(scanRow.player_id);

  const powerAbs = toNum(scanRow.power, 0);
  const kpAbs    = toNum(scanRow.kp, 0);
  const deadAbs  = toNum(scanRow.dead, 0);
  const t4Abs    = toNum(scanRow.t4, 0);
  const t5Abs    = toNum(scanRow.t5, 0);

  // baseline у players
  await db.query(
    `
    INSERT INTO players (
      player_id,
      name,
      power_current,
      kp_current,
      dead_current,
      t4_kills_current,
      t5_kills_current,
      last_update
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (player_id) DO UPDATE SET
      name             = EXCLUDED.name,
      power_current    = EXCLUDED.power_current,
      kp_current       = EXCLUDED.kp_current,
      dead_current     = EXCLUDED.dead_current,
      t4_kills_current = EXCLUDED.t4_kills_current,
      t5_kills_current = EXCLUDED.t5_kills_current,
      last_update      = now()
    `,
    [
      pidStr,
      String(scanRow.name || "").trim(),
      powerAbs,
      kpAbs,
      deadAbs,
      t4Abs,
      t5Abs,
    ]
  );

  // створюємо goals тільки якщо їх ще нема
  const { rows: chk } = await db.query(
    `SELECT 1 FROM kvk_goals
     WHERE kvk_id=$1 AND player_id=$2`,
    [kvkStr, pidStr]
  );
  if (!chk.length) {
    const g = computeGoalsForMainByPower(powerAbs);

    await db.query(
      `
      INSERT INTO kvk_goals (
        kvk_id, player_id,
        start_power, start_dead, start_t4, start_t5,
        goal_kills, goal_dead
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (kvk_id, player_id) DO NOTHING
      `,
      [
        kvkStr,
        pidStr,
        powerAbs,
        deadAbs,
        t4Abs,
        t5Abs,
        g.goal_kills,
        g.goal_dead,
      ]
    );
  }
}

/* ───────────────── цілі при зміні ролі ─────────────────
   recalcGoalsForRoleChange(player_id,'farm'|'main')
   - бере active KvK
   - читає baseline з players
   - якщо 'farm' => goal_dead=600k, goal_kills=0
   - якщо 'main' => таблиця по power
   - апдейтить kvk_goals для цього KvK
*/
export async function recalcGoalsForRoleChange(player_id, newRole) {
  const kvk_id = await getActiveKvK();
  if (!kvk_id) return null;

  const pidStr = String(player_id);
  const kvkStr = String(kvk_id);

  const { rows: prow } = await pool.query(
    `SELECT power_current,
            dead_current,
            t4_kills_current,
            t5_kills_current
     FROM players
     WHERE player_id=$1`,
    [pidStr]
  );
  if (!prow.length) return null;
  const snap = prow[0];

  let goals;
  if (newRole === "farm") {
    goals = computeGoalsForFarm();
  } else {
    goals = computeGoalsForMainByPower(snap.power_current || 0);
  }

  await pool.query(
    `
    INSERT INTO kvk_goals (
      kvk_id, player_id,
      start_power, start_dead, start_t4, start_t5,
      goal_kills, goal_dead
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (kvk_id, player_id)
    DO UPDATE SET
      goal_kills = EXCLUDED.goal_kills,
      goal_dead  = EXCLUDED.goal_dead
    `,
    [
      kvkStr,
      pidStr,
      toNum(snap.power_current, 0),
      toNum(snap.dead_current, 0),
      toNum(snap.t4_kills_current, 0),
      toNum(snap.t5_kills_current, 0),
      goals.goal_kills,
      goals.goal_dead,
    ]
  );

  return {
    kvk_id,
    player_id,
    role: newRole,
    goal_kills: goals.goal_kills,
    goal_dead: goals.goal_dead,
  };
}

/* ───────────────── ручний фікс baseline адміном ───────────────── */
export async function adminUpdatePlayerSnapshot(player_id, patch = {}) {
  const pidStr = String(player_id);

  const sets = [];
  const vals = [];
  let idx = 1;

  function add(field, val) {
    sets.push(`${field} = $${idx++}`);
    vals.push(val);
  }

  if (patch.name !== undefined) add("name", String(patch.name));
  if (patch.power_current !== undefined)
    add("power_current", toNum(patch.power_current, 0));
  if (patch.kp_current !== undefined)
    add("kp_current", toNum(patch.kp_current, 0));
  if (patch.dead_current !== undefined)
    add("dead_current", toNum(patch.dead_current, 0));
  if (patch.t4_kills_current !== undefined)
    add("t4_kills_current", toNum(patch.t4_kills_current, 0));
  if (patch.t5_kills_current !== undefined)
    add("t5_kills_current", toNum(patch.t5_kills_current, 0));
  if (patch.last_update !== undefined)
    add("last_update", patch.last_update);

  if (!sets.length) return;

  vals.push(pidStr);

  const sql = `
    UPDATE players
       SET ${sets.join(", ")}
     WHERE player_id = $${idx}
  `;

  await pool.query(sql, vals);
}

/* ───────────────── farm/main helpers ───────────────── */

// чи є player_id фермою (approved-заявка існує як farm_player_id)
async function isApprovedFarm(pidStr) {
  const { rows } = await pool.query(
    `SELECT 1 FROM account_links
     WHERE farm_player_id = $1
       AND status = 'approved'
     LIMIT 1`,
    [pidStr]
  );
  return !!rows.length;
}

// всі ферми мейна (approved), з їх прогресом по dead
async function fetchFarmsForOwner(kvk_id, main_pid_str) {
  const kvkStr = String(kvk_id);

  const { rows } = await pool.query(
    `
    SELECT
      al.farm_player_id         AS farm_id,
      p.name                    AS farm_name,
      g.goal_dead               AS farm_goal_dead,
      COALESCE(SUM(i.dead), 0)  AS farm_dead_done
    FROM account_links al
    JOIN players p
      ON p.player_id = al.farm_player_id
    LEFT JOIN kvk_goals g
      ON g.kvk_id = $1
     AND g.player_id = al.farm_player_id
    LEFT JOIN imports i
      ON i.kvk_id = $1
     AND i.player_id = al.farm_player_id
     AND i.is_scoring = true
    WHERE al.owner_player_id = $2
      AND al.status = 'approved'
    GROUP BY al.farm_player_id, p.name, g.goal_dead
    ORDER BY p.name ASC
    `,
    [kvkStr, main_pid_str]
  );

  const farms = rows.map((r) => {
    const goalDead = toNum(r.farm_goal_dead, 0);
    const deadDone = toNum(r.farm_dead_done, 0);
    const pctDead  = goalDead > 0 ? (deadDone / goalDead) * 100 : 0;
    return {
      player_id: r.farm_id,
      name: r.farm_name,
      deadGoal: goalDead,
      deadDone,
      pctDead,
      deadLeft: Math.max(0, goalDead - deadDone),
    };
  });

  return { farms };
}

/* ───────────────── buildStatsCardData ─────────────────
   Все для картки (!stats / !me)
   Включно з:
   - baseline
   - сума внеску
   - DKP
   - остання зона бою
   - ферми (якщо це main)
*/
export async function buildStatsCardData(player_id_input) {
  const kvk_id = await getActiveKvK();
  if (!kvk_id) return null;

  const pidStr = String(player_id_input);
  const kvkStr = String(kvk_id);

  // baseline
  const { rows: snapRows } = await pool.query(
    `SELECT player_id,
            name,
            power_current,
            kp_current,
            dead_current,
            t4_kills_current,
            t5_kills_current,
            last_update
     FROM players
     WHERE player_id=$1`,
    [pidStr]
  );
  if (!snapRows.length) return null;
  const snap = snapRows[0];

  // роль акаунта: ферма = є approved запис як farm_player_id
  const role = (await isApprovedFarm(pidStr)) ? "farm" : "main";

  // Σ всіх дельт = "поточні значення"
  const { rows: allDelts } = await pool.query(
    `SELECT
        COALESCE(SUM(power),0)    AS tot_power,
        COALESCE(SUM(kp),0)       AS tot_kp,
        COALESCE(SUM(dead),0)     AS tot_dead,
        COALESCE(SUM(t4_kills),0) AS tot_t4,
        COALESCE(SUM(t5_kills),0) AS tot_t5,
        MAX(import_ts)            AS max_ts
     FROM imports
     WHERE kvk_id=$1
       AND player_id=$2`,
    [kvkStr, pidStr]
  );
  const all = allDelts[0] || {};

  const curPower = toNum(snap.power_current, 0) + toNum(all.tot_power, 0);
  const curKP    = toNum(snap.kp_current, 0)    + toNum(all.tot_kp, 0);
  const curDead  = toNum(snap.dead_current, 0)  + toNum(all.tot_dead, 0);
  const curT4    = toNum(snap.t4_kills_current, 0) + toNum(all.tot_t4, 0);
  const curT5    = toNum(snap.t5_kills_current, 0) + toNum(all.tot_t5, 0);

  const updated_at = all.max_ts || snap.last_update;

  // Σ бойових дельт (is_scoring=true) = "твій вклад"
  const { rows: scoreDelts } = await pool.query(
    `SELECT
        COALESCE(SUM(power),0)    AS d_power,
        COALESCE(SUM(kp),0)       AS d_kp,
        COALESCE(SUM(dead),0)     AS d_dead,
        COALESCE(SUM(t4_kills),0) AS d_t4,
        COALESCE(SUM(t5_kills),0) AS d_t5
     FROM imports
     WHERE kvk_id=$1
       AND player_id=$2
       AND is_scoring=true`,
    [kvkStr, pidStr]
  );
  const sc = scoreDelts[0] || {};

  const dPower = toNum(sc.d_power, 0); // може бути мінус (power падає)
  const dKP    = toNum(sc.d_kp, 0);
  const dDead  = toNum(sc.d_dead, 0);
  const dT4    = toNum(sc.d_t4, 0);
  const dT5    = toNum(sc.d_t5, 0);

  const killsDone = dT4 + dT5;
  const deadDone  = dDead;

  // goals
  const { rows: gRows } = await pool.query(
    `SELECT goal_kills, goal_dead
     FROM kvk_goals
     WHERE kvk_id=$1 AND player_id=$2`,
    [kvkStr, pidStr]
  );
  const goalsRec  = gRows[0] || { goal_kills: 0, goal_dead: 0 };
  const goalKillsRaw = toNum(goalsRec.goal_kills, 0);
  const goalDeadRaw  = toNum(goalsRec.goal_dead, 0);

  // DKP (legacy)
  const dkpData = computeDkpProgress(
    killsDone,
    deadDone,
    goalKillsRaw,
    goalDeadRaw
  );

  const kpGoal = computeKpGoal(curPower);
  const kpPct = kpGoal > 0 ? (dKP / kpGoal) * 100 : 0;

  const goalKills = 0;
  const goalDead  = 0;
  const killsPct = 0;
  const deadPct  = 0;

  // left to go
  const killsLeft = 0;
  const deadLeft  = 0;
  const kpLeft    = Math.max(0, kpGoal - dKP);

  // остання бойова зона
  const { rows: lastZoneRows } = await pool.query(
    `SELECT zone_tag
     FROM imports
     WHERE kvk_id=$1
       AND player_id=$2
       AND is_scoring=true
     ORDER BY import_ts DESC
     LIMIT 1`,
    [kvkStr, pidStr]
  );
  const lastTag = lastZoneRows[0]?.zone_tag || null;

  let lastFight = {
    zoneName: null,
    killsT45: 0,
    dead: 0,
  };
  if (lastTag) {
    const { rows: zoneAgg } = await pool.query(
      `SELECT
          COALESCE(SUM(t4_kills + t5_kills),0) AS kills_t45,
          COALESCE(SUM(dead),0)               AS dead_zone
       FROM imports
       WHERE kvk_id=$1
         AND player_id=$2
         AND is_scoring=true
         AND zone_tag=$3`,
      [kvkStr, pidStr, lastTag]
    );
    lastFight = {
      zoneName: lastTag,
      killsT45: toNum(zoneAgg[0]?.kills_t45, 0),
      dead:     toNum(zoneAgg[0]?.dead_zone, 0),
    };
  }

  // ферми (тільки якщо це main)
  let farmsBundle = { farms: [] };
  if (role === "main") {
    farmsBundle = await fetchFarmsForOwner(kvk_id, pidStr);
  }

  return {
    player: {
      player_id: pidStr,
      name: snap.name,
      power: curPower,
      kp: curKP,
      dead: curDead,
      t4: curT4,
      t5: curT5,
      updated_at,
      role,
    },
    deltas: {
      power: dPower,
      kp: dKP,
      dead: dDead,
      t4: dT4,
      t5: dT5,
    },
    goals: {
      kills: goalKills,
      dead: goalDead,
      dkp: dkpData.goal_dkp,
      kp: kpGoal,
    },
    progress: {
      killsDone,
      deadDone,
      dkpDone: dkpData.dkpDone,
      kpDone: dKP,
      killsLeft,
      deadLeft,
      kpLeft,
      pct: kpPct,
      kpPct,
      killsPct,
      deadPct,
    },
    lastFight,
    zone: {
      tag: lastTag || "-",
    },
    farms: farmsBundle,
  };
}

/* ───────────────── buildTopListData ─────────────────
   Для !kvk top:
   - беремо тільки мейнів
     (= тих, хто НЕ є farm_player_id у approved звʼязку)
   - ранжуємо по DKP%
*/
export async function buildTopListData(limit = 10) {
  const kvk_id = await getActiveKvK();
  if (!kvk_id) return [];
  const kvkStr = String(kvk_id);

  const { rows: baseRows } = await pool.query(
    `
    SELECT
      g.player_id,
      p.name,
      p.last_update,
      g.goal_kills,
      g.goal_dead,
      p.power_current,
      COALESCE(SUM(i.t4_kills + i.t5_kills), 0) AS killsdone,
      COALESCE(SUM(i.dead), 0)                 AS deaddone,
      COALESCE(SUM(i.kp), 0)                   AS kpdone
    FROM kvk_goals g
    JOIN players p
      ON p.player_id = g.player_id
    LEFT JOIN imports i
      ON i.kvk_id = $1
     AND i.player_id = g.player_id
     AND i.is_scoring = true
    WHERE g.kvk_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM account_links al
        WHERE al.farm_player_id = g.player_id
          AND al.status = 'approved'
      )
    GROUP BY g.player_id, p.name, p.last_update, g.goal_kills, g.goal_dead, p.power_current
    `,
    [kvkStr]
  );

  const out = baseRows.map((r) => {
    // бойовий вклад (тільки scoring)

    const killsDone = toNum(r.killsdone, 0);
    const deadDone  = toNum(r.deaddone, 0);

    const goalKills = toNum(r.goal_kills, 0);
    const goalDead  = toNum(r.goal_dead, 0);

    const kpDone = toNum(r.kpdone, 0);
    const powerAbs = toNum(r.power_current, 0);
    const kpGoal = computeKpGoal(powerAbs);
    const kpPct = kpGoal > 0 ? (kpDone / kpGoal) * 100 : 0;

    return {
      player_id: r.player_id,
      name: r.name,
      updated_at: r.last_update,
      kpDone,
      goal_kp: kpGoal,
      pct: kpPct,
      killsDone,
      deadDone,
      goal_kills: 0,
      goal_dead: 0,
    };
  });

  out.sort((a, b) => b.pct - a.pct);

  const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return out.slice(0, lim);
}

/* ───────────────── простий snapshot-топ по power/kp ─────────────────
   для !top [kp|power]
*/
export async function fetchTopSnapshot(by = "kp", limit = 10) {
  const col = by === "power" ? "power_current" : "kp_current";
  const { rows } = await pool.query(
    `
    SELECT player_id,
           name,
           ${col} AS metric
    FROM players
    WHERE ${col} IS NOT NULL
    ORDER BY ${col} DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows;
}

/* ───────────────── дрібні хелпери для бота ───────────────── */

// юзається в !link щоб перевірити що player існує
export async function fetchPlayerSnapshot(playerId) {
  const { rows } = await pool.query(
    `
    SELECT
      player_id,
      name,
      power_current,
      kp_current,
      dead_current,
      t4_kills_current,
      t5_kills_current,
      last_update
    FROM players
    WHERE player_id=$1
    `,
    [String(playerId)]
  );
  return rows[0] || null;
}

// Discord ↔ player_id links
export async function fetchLink(discordId) {
  const { rows } = await pool.query(
    `SELECT player_id FROM discord_links WHERE discord_id=$1`,
    [String(discordId)]
  );
  return rows[0]?.player_id ?? null;
}

export async function upsertDiscordLink(discordId, playerId) {
  await pool.query(
    `
    INSERT INTO discord_links(discord_id, player_id)
    VALUES ($1, $2)
    ON CONFLICT (discord_id)
    DO UPDATE SET player_id = EXCLUDED.player_id
    `,
    [String(discordId), String(playerId)]
  );
}

export async function deleteDiscordLink(discordId) {
  await pool.query(`DELETE FROM discord_links WHERE discord_id=$1`, [
    String(discordId),
  ]);
}

export async function setLink(discordId, playerId) {
  await upsertDiscordLink(discordId, playerId);
}

export async function removeLink(discordId) {
  await deleteDiscordLink(discordId);
}

// коротке імʼя (для DM після approve/reject)
export async function fetchPlayerBasic(playerId) {
  const { rows } = await pool.query(
    `SELECT player_id, name
     FROM players
     WHERE player_id=$1`,
    [String(playerId)]
  );
  return rows[0] || null;
}

// max timestamp для кількох player_id (для Updated: у топі)
export async function fetchMaxUpdateFor(playerIds) {
  if (!playerIds.length) return null;
  const clean = playerIds.map((x) => String(x));
  const { rows } = await pool.query(
    `
    SELECT MAX(last_update) AS ts
    FROM players
    WHERE player_id = ANY($1::bigint[])
    `,
    [clean]
  );
  return rows[0]?.ts || null;
}

/* ───────────────── заявки на ферми ───────────────── */

// створити pending-запит на лінк ферми
export async function createFarmLinkRequest(mainId, farmId, discordId) {
  const { rows } = await pool.query(
    `
    INSERT INTO account_links(
      owner_player_id,
      farm_player_id,
      status,
      requested_by_discord_id
    )
    VALUES ($1,$2,'pending',$3)
    RETURNING request_id
    `,
    [String(mainId), String(farmId), String(discordId)]
  );
  return rows[0]; // {request_id: ...}
}

// апрув (тільки якщо ще pending)
export async function approveFarmLink(requestId) {
  const { rows } = await pool.query(
    `
    UPDATE account_links
       SET status='approved',
           resolved_at = now()
     WHERE request_id=$1
       AND status='pending'
     RETURNING request_id,
               owner_player_id,
               farm_player_id,
               requested_by_discord_id
    `,
    [String(requestId)]
  );
  return rows[0] || null;
}

// реджект (тільки якщо ще pending)
export async function rejectFarmLink(requestId) {
  const { rows } = await pool.query(
    `
    UPDATE account_links
       SET status='rejected',
           resolved_at = now()
     WHERE request_id=$1
       AND status='pending'
     RETURNING request_id,
               owner_player_id,
               farm_player_id,
               requested_by_discord_id
    `,
    [String(requestId)]
  );
  return rows[0] || null;
}

export async function upsertPlayerManual(input) {
  const pid = String(input?.player_id || "").trim();
  if (!/^\d+$/.test(pid)) {
    throw new Error("player_id must be numeric");
  }
  const name = String(input?.name || "").trim();
  const power_current = toNum(input?.power_current, 0);
  const kp_current = toNum(input?.kp_current, 0);
  const dead_current = toNum(input?.dead_current, 0);
  const t4_kills_current = toNum(input?.t4_kills_current, 0);
  const t5_kills_current = toNum(input?.t5_kills_current, 0);
  const last_update = input?.last_update
    ? new Date(input.last_update)
    : new Date();

  await pool.query(
    `
    INSERT INTO players (
      player_id,
      name,
      power_current,
      kp_current,
      dead_current,
      t4_kills_current,
      t5_kills_current,
      last_update
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (player_id) DO UPDATE SET
      name=EXCLUDED.name,
      power_current=EXCLUDED.power_current,
      kp_current=EXCLUDED.kp_current,
      dead_current=EXCLUDED.dead_current,
      t4_kills_current=EXCLUDED.t4_kills_current,
      t5_kills_current=EXCLUDED.t5_kills_current,
      last_update=EXCLUDED.last_update
    `,
    [
      pid,
      name,
      power_current,
      kp_current,
      dead_current,
      t4_kills_current,
      t5_kills_current,
      last_update.toISOString(),
    ]
  );

  return {
    player_id: pid,
    name,
    power_current,
    kp_current,
    dead_current,
    t4_kills_current,
    t5_kills_current,
    last_update: last_update.toISOString(),
  };
}

export async function setFarmLinkApproved(ownerId, farmId) {
  const { rows } = await pool.query(
    `
    INSERT INTO account_links(
      owner_player_id,
      farm_player_id,
      status,
      requested_by_discord_id,
      requested_at,
      resolved_at
    )
    VALUES ($1,$2,'approved','adminpanel',now(),now())
    ON CONFLICT (farm_player_id)
    DO UPDATE SET
      owner_player_id = EXCLUDED.owner_player_id,
      status = 'approved',
      requested_by_discord_id = EXCLUDED.requested_by_discord_id,
      requested_at = now(),
      resolved_at = now()
    RETURNING request_id, owner_player_id, farm_player_id
    `,
    [String(ownerId), String(farmId)]
  );
  return rows[0] || null;
}

export async function removeFarmLink(farmId) {
  await pool.query(
    `DELETE FROM account_links WHERE farm_player_id=$1`,
    [String(farmId)]
  );
}

/* ───────────────── закрити пул ───────────────── */
export async function closeDb() {
  await pool.end().catch(() => {});
}
