import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Railway звичайно вимагає SSL
});

export async function initSchema() {
  await pool.query(`
    create table if not exists players (
      id       bigint primary key,
      name     text
    );

    create table if not exists runs (
      run_id      bigserial primary key,
      started_at  timestamptz not null default now()
    );

    create table if not exists stats (
      run_id   bigint not null references runs(run_id) on delete cascade,
      player_id bigint not null references players(id) on delete cascade,
      power    bigint, kp bigint, dead bigint,
      t1 bigint, t2 bigint, t3 bigint, t4 bigint, t5 bigint,
      primary key (run_id, player_id)
    );

    create table if not exists latest (
      player_id bigint primary key references players(id) on delete cascade,
      name      text,
      updated_at timestamptz not null,
      power    bigint, kp bigint, dead bigint,
      t1 bigint, t2 bigint, t3 bigint, t4 bigint, t5 bigint
    );

    create table if not exists cursor (
      run_id  bigint primary key references runs(run_id) on delete cascade,
      stage   text,
      idx     integer,
      updated_at timestamptz not null
    );
  `);
}

export async function beginRun() {
  const { rows } = await pool.query(`insert into runs default values returning run_id`);
  return rows[0].run_id;
}

export async function upsertPlayer({ id, name }) {
  await pool.query(
    `insert into players (id, name) values ($1,$2)
     on conflict (id) do update set name = excluded.name`,
    [id, name ?? null]
  );
}

export async function insertStats(run_id, player_id, s) {
  await pool.query(
    `insert into stats (run_id, player_id, power, kp, dead, t1, t2, t3, t4, t5)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (run_id, player_id) do update set
       power=excluded.power, kp=excluded.kp, dead=excluded.dead,
       t1=excluded.t1, t2=excluded.t2, t3=excluded.t3, t4=excluded.t4, t5=excluded.t5`,
    [run_id, player_id, s.power, s.kp, s.dead, s.kills.t1, s.kills.t2, s.kills.t3, s.kills.t4, s.kills.t5]
  );

  await pool.query(
    `insert into latest (player_id, name, updated_at, power, kp, dead, t1, t2, t3, t4, t5)
     values ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (player_id) do update set
       name = excluded.name,
       updated_at = excluded.updated_at,
       power=excluded.power, kp=excluded.kp, dead=excluded.dead,
       t1=excluded.t1, t2=excluded.t2, t3=excluded.t3, t4=excluded.t4, t5=excluded.t5`,
    [player_id, s.name ?? null, s.power, s.kp, s.dead, s.kills.t1, s.kills.t2, s.kills.t3, s.kills.t4, s.kills.t5]
  );
}

export async function saveCursor(run_id, stage, idx) {
  await pool.query(
    `insert into cursor (run_id, stage, idx, updated_at)
     values ($1,$2,$3, now())
     on conflict (run_id) do update set stage=excluded.stage, idx=excluded.idx, updated_at=excluded.updated_at`,
    [run_id, stage, idx]
  );
}

export async function loadCursor(run_id) {
  const { rows } = await pool.query(`select stage, idx from cursor where run_id=$1`, [run_id]);
  return rows[0] ?? null;
}

export async function closeDb() {
  await pool.end();
}