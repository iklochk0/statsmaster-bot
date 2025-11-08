// src/exportBackup.js
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import archiver from "archiver";
import { pool } from "./db.pg.js";

/**
 * Які таблиці зберігаємо. Порядок вкладок у Excel відповідає цьому списку.
 * Додай/зміни під свою схему за потреби.
 */
const TABLES = [
  "players",
  "kvk_sessions",
  "kvk_goals",
  "account_links",     // main ↔ farms
  "discord_links",     // discord ↔ player_id (у боті)
  "imports",           // історія імпортів (excel/ocr)
  "zones",             // якщо є (теги/зони)
  "farm_link_requests" // якщо є (pending/approved/rejected)
];

/** Безпечно форматує значення у вигляді для Excel/JSON */
function normalizeValue(v) {
  if (v === null || v === undefined) return null;

  // node-postgres повертає BIGINT як string — залишаємо як string
  // Дати/час → ISO
  if (v instanceof Date) return v.toISOString();

  // Об'єкти/масиви → JSON string (щоб у Excel було видно)
  if (typeof v === "object") return JSON.stringify(v);

  return v;
}

/** Дістає колонки (в порядку) для таблиці */
async function getColumns(client, table) {
  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return rows.map(r => r.column_name);
}

/** Пробує відсортувати розумно (id / updated_at / created_at), інакше без ORDER */
function buildOrderSql(columns) {
  const lc = columns.map(c => c.toLowerCase());
  if (lc.includes("id")) return ` ORDER BY id`;
  if (lc.includes("player_id")) return ` ORDER BY player_id`;
  if (lc.includes("updated_at")) return ` ORDER BY updated_at DESC`;
  if (lc.includes("created_at")) return ` ORDER BY created_at DESC`;
  return ``;
}

/** Основний експорт */
export async function exportFullBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("backups");
  const xlsxPath = path.join(outDir, `statsmaster-backup-${ts}.xlsx`);
  const zipPath  = path.join(outDir, `statsmaster-backup-${ts}.zip`);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StatsMaster Bot";
  workbook.created = new Date();

  const client = await pool.connect();
  try {
    const jsonPayload = {};

    for (const table of TABLES) {
      // Перевіряємо що таблиця існує
      const exist = await client.query(
        `SELECT to_regclass($1) AS t`, [table]
      );
      if (!exist.rows[0]?.t) {
        // Пропускаємо відсутні — нічого страшного
        continue;
      }

      const columns = await getColumns(client, table);
      const orderSql = buildOrderSql(columns);

      const { rows } = await client.query(
        `SELECT * FROM ${table}${orderSql}`
      );

      // JSON дамп (нормалізуємо значення)
      jsonPayload[table] = rows.map(r => {
        const obj = {};
        for (const col of columns) {
          obj[col] = normalizeValue(r[col]);
        }
        return obj;
      });

      // Excel аркуш
      const sheet = workbook.addWorksheet(table);
      sheet.columns = columns.map(col => ({
        header: col,
        key: col,
        width: Math.min(Math.max(col.length + 4, 12), 40)
      }));

      for (const r of rows) {
        const line = {};
        for (const col of columns) line[col] = normalizeValue(r[col]);
        sheet.addRow(line);
      }
      // Хедер жирним
      sheet.getRow(1).font = { bold: true };

      // Трохи вирівнювання
      sheet.eachRow((row) => {
        row.alignment = { vertical: "middle" };
      });
    }

    // Пишемо Excel
    await workbook.xlsx.writeFile(xlsxPath);

    // Пишемо JSON → zip
    // Тимчасово кладемо JSON файли у пам’яті без диска
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