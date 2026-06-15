import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import archiver from "archiver";
import { pool } from "./db.pg.js";

// Export order also controls worksheet order in the generated workbook.
const TABLES = [
  "players",
  "kvk_sessions",
  "kvk_goals",
  "account_links",
  "discord_links",
  "imports",
  "zones",
  "farm_link_requests",
];

function normalizeValue(v) {
  if (v === null || v === undefined) return null;

  if (v instanceof Date) return v.toISOString();

  if (typeof v === "object") return JSON.stringify(v);

  return v;
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY ordinal_position
  `,
    [table]
  );
  return rows.map((r) => r.column_name);
}

function buildOrderSql(columns) {
  const lc = columns.map((c) => c.toLowerCase());
  if (lc.includes("id")) return ` ORDER BY id`;
  if (lc.includes("player_id")) return ` ORDER BY player_id`;
  if (lc.includes("updated_at")) return ` ORDER BY updated_at DESC`;
  if (lc.includes("created_at")) return ` ORDER BY created_at DESC`;
  return ``;
}

export async function exportFullBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("backups");
  const xlsxPath = path.join(outDir, `statsmaster-backup-${ts}.xlsx`);
  const zipPath = path.join(outDir, `statsmaster-backup-${ts}.zip`);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StatsMaster Bot";
  workbook.created = new Date();

  const client = await pool.connect();
  try {
    const jsonPayload = {};

    for (const table of TABLES) {
      const exist = await client.query(
        `SELECT to_regclass($1) AS t`,
        [table]
      );
      if (!exist.rows[0]?.t) {
        continue;
      }

      const columns = await getColumns(client, table);
      const orderSql = buildOrderSql(columns);

      const { rows } = await client.query(`SELECT * FROM ${table}${orderSql}`);

      jsonPayload[table] = rows.map((r) => {
        const obj = {};
        for (const col of columns) {
          obj[col] = normalizeValue(r[col]);
        }
        return obj;
      });

      const sheet = workbook.addWorksheet(table);
      sheet.columns = columns.map((col) => ({
        header: col,
        key: col,
        width: Math.min(Math.max(col.length + 4, 12), 40),
      }));

      for (const r of rows) {
        const line = {};
        for (const col of columns) line[col] = normalizeValue(r[col]);
        sheet.addRow(line);
      }

      sheet.getRow(1).font = { bold: true };
      sheet.eachRow((row) => {
        row.alignment = { vertical: "middle" };
      });
    }

    await workbook.xlsx.writeFile(xlsxPath);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);

      archive.pipe(output);

      for (const [table, data] of Object.entries(jsonPayload)) {
        const jsonStr = JSON.stringify(data, null, 2);
        archive.append(jsonStr, { name: `${table}.json` });
      }

      archive.finalize();
    });

    return { xlsxPath, zipPath };
  } finally {
    client.release();
  }
}
