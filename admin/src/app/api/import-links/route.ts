import { requirePin } from "@/lib/auth";
import * as xlsx from "xlsx";

export const runtime = "nodejs";

type ImportStats = { ok: number; skipped: number };

async function playerExists(pool: any, playerId: string) {
  const { rows } = await pool.query(
    "SELECT 1 FROM players WHERE player_id=$1",
    [String(playerId)]
  );
  return rows.length > 0;
}

function normalizeStatus(value: unknown) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "pending" || v === "approved" || v === "rejected") return v;
  return "approved";
}

async function importDiscordLinks(pool: any, rows: any[]): Promise<ImportStats> {
  let ok = 0;
  let skipped = 0;
  for (const row of rows) {
    const discordId = row.discord_id ?? row.discordId ?? row.discord;
    const playerId = row.player_id ?? row.playerId ?? row.player;
    if (!discordId || !playerId) {
      skipped++;
      continue;
    }
    if (!(await playerExists(pool, playerId))) {
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

async function importAccountLinks(pool: any, rows: any[]): Promise<ImportStats> {
  let ok = 0;
  let skipped = 0;
  for (const row of rows) {
    const ownerId = row.owner_player_id ?? row.ownerPlayerId ?? row.owner_id;
    const farmId = row.farm_player_id ?? row.farmPlayerId ?? row.farm_id;
    if (!ownerId || !farmId) {
      skipped++;
      continue;
    }
    if (!(await playerExists(pool, ownerId)) || !(await playerExists(pool, farmId))) {
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

export async function POST(req: Request) {
  const err = requirePin(req);
  if (err) {
    return Response.json({ ok: false, error: err }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ ok: false, error: "file is required" }, { status: 400 });
  }

  try {
    const { pool, initSchema } = await import("../../../../../src/db.pg.js");
    await initSchema();

    const buf = Buffer.from(await file.arrayBuffer());
    const wb = xlsx.read(buf, { type: "buffer" });
    const sheets = ["discord_links", "account_links"];
    const result: Record<string, ImportStats> = {};

    for (const name of sheets) {
      const ws = wb.Sheets[name];
      if (!ws) {
        result[name] = { ok: 0, skipped: 0 };
        continue;
      }
      const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
      if (name === "discord_links") {
        result[name] = await importDiscordLinks(pool, rows);
      } else if (name === "account_links") {
        result[name] = await importAccountLinks(pool, rows);
      }
    }

    return Response.json({ ok: true, result });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
