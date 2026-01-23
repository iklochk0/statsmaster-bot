import "dotenv/config";
import path from "path";
import xlsx from "xlsx";

import { initSchema, pool } from "../src/db.pg.js";

const DEFAULT_FILE =
  "admin/backups/statsmaster-backup-2026-01-18T16-24-48-123Z.xlsx";

function arg(name, def) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split("=", 2)[1] : def;
}

function normalizeStatus(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "pending" || v === "approved" || v === "rejected") return v;
  return "approved";
}

async function playerExists(playerId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM players WHERE player_id=$1",
    [String(playerId)]
  );
  return rows.length > 0;
}

async function importDiscordLinks(rows) {
  let ok = 0;
  let skipped = 0;
  for (const row of rows) {
    const discordId = row.discord_id ?? row.discordId ?? row.discord;
    const playerId = row.player_id ?? row.playerId ?? row.player;
    if (!discordId || !playerId) {
      skipped++;
      continue;
    }
    if (!(await playerExists(playerId))) {
      skipped++;
      continue;
    }
    await pool.query(
      `
      INSERT INTO discord_links(discord_id, player_id)
      VALUES ($1, $2)
      ON CONFLICT (discord_id)
      DO UPDATE SET player_id = EXCLUDED.player_id
      `,
      [String(discordId), String(playerId)]
    );
    ok++;
  }
  return { ok, skipped };
}

async function importAccountLinks(rows) {
  let ok = 0;
  let skipped = 0;
  for (const row of rows) {
    const ownerId = row.owner_player_id ?? row.ownerPlayerId ?? row.owner_id;
    const farmId = row.farm_player_id ?? row.farmPlayerId ?? row.farm_id;
    if (!ownerId || !farmId) {
      skipped++;
      continue;
    }
    if (!(await playerExists(ownerId)) || !(await playerExists(farmId))) {
      skipped++;
      continue;
    }

    const status = normalizeStatus(row.status);
    const requestedBy = row.requested_by_discord_id ?? row.requestedBy;
    const requestedAt = row.requested_at ?? row.requestedAt ?? null;
    const resolvedAt = row.resolved_at ?? row.resolvedAt ?? null;

    await pool.query(
      `
      INSERT INTO account_links(
        owner_player_id,
        farm_player_id,
        status,
        requested_by_discord_id,
        requested_at,
        resolved_at
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (farm_player_id)
      DO UPDATE SET
        owner_player_id = EXCLUDED.owner_player_id,
        status = EXCLUDED.status,
        requested_by_discord_id = EXCLUDED.requested_by_discord_id,
        requested_at = EXCLUDED.requested_at,
        resolved_at = EXCLUDED.resolved_at
      `,
      [
        String(ownerId),
        String(farmId),
        status,
        String(requestedBy || ""),
        requestedAt ? new Date(requestedAt) : null,
        resolvedAt ? new Date(resolvedAt) : null,
      ]
    );
    ok++;
  }
  return { ok, skipped };
}

async function main() {
  const file = arg("file", DEFAULT_FILE);
  const sheet = arg("sheet", "");

  await initSchema();
  const wb = xlsx.readFile(path.resolve(file));

  const sheets = sheet ? [sheet] : ["discord_links", "account_links"];
  for (const name of sheets) {
    const ws = wb.Sheets[name];
    if (!ws) {
      console.log(`Sheet "${name}" not found in ${file}`);
      continue;
    }
    const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
    if (name === "discord_links") {
      const res = await importDiscordLinks(rows);
      console.log(`discord_links: imported=${res.ok} skipped=${res.skipped}`);
    } else if (name === "account_links") {
      const res = await importAccountLinks(rows);
      console.log(`account_links: imported=${res.ok} skipped=${res.skipped}`);
    } else {
      console.log(`Sheet "${name}" ignored (only discord_links/account_links).`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
