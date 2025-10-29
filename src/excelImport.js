// src/excelImport.js
//
// Використання:
//   node src/excelImport.js <file.xlsx> <zone_tag> <is_scoring:true|false>
//
// Приклад:
//   node src/excelImport.js ./zone4_day1.xlsx zone4 true
//
// Що робить зараз (оновлено):
//   - читає Excel (кожен рядок = внесок гравця за інтервал бою)
//   - ДЛЯ КОЖНОГО РЯДКА:
//        * бере player_id
//        * перевіряє чи такий player_id вже існує в players
//          (тобто baseline вже був завантажений через OCR або руками)
//        * якщо НЕ існує -> скіпаємо цей рядок повністю
//          (НЕ створюємо пустого гравця, НЕ вставляємо imports)
//        * якщо існує:
//              - оновлюємо name,last_update в players
//              - вставляємо дельту в imports
//   - збирає короткий звіт і шле його у адмін вебхук (ADMIN_IMPORT_WEBHOOK_URL)
//
// ВАЖЛИВО:
//   Тепер імпорт не "засирає" базу новими айдішками з Excel.
//   Тільки ті, кого ми вже бачили (і маємо baseline в players), отримують апдейт.
//
// Колонки Excel які ми їмо:
//   "Character ID" / "Governor ID" / "ID" / "Id" / "id"           -> player_id
//   "Username" / "Name" / "Governor Name" / "name"                -> name
//   "Power"                                                       -> ΔPower  (може бути від'ємне)
//   "Total Kill Points"                                          -> ΔKP
//   "Deaths" / "Dead" / "Deaths Count"                            -> ΔDead
//   "T4 Kills" / "T4"                                            -> ΔT4
//   "T5 Kills" / "T5"                                            -> ΔT5
//
// is_scoring=true означає, що це бойові очки (впливають на прогрес / % / DKP).
//

import "dotenv/config";
import XLSX from "xlsx";
import fetch from "node-fetch";
import {
  pool,
  initSchema,
  getActiveKvK,
} from "./db.pg.js";

/* ───────── helpers ───────── */

function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const s = String(v)
    .trim()
    .replace(/[, ]+/g, "")      // прибираємо пробіли й коми "1 234 567" -> "1234567"
    .replace(/[^\d.-]/g, "");   // залишаємо тільки цифри, мінус, крапку
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readExcelRows(path) {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    defval: null,
    raw: true,
  });
  return rows;
}

/**
 * Відправляє короткий звіт в адмін-канал через вебхук.
 * Ми показуємо ТІЛЬКИ тих, кого реально імпортили (тобто тих, хто існував у players).
 */
async function sendWebhookSummary({ zoneTag, isScoring, kvk_id, importedRows }) {
  const hook = process.env.ADMIN_IMPORT_WEBHOOK_URL;
  if (!hook) return; // немає вебхука - просто промовчали

  const totalPlayers = importedRows.length;

  // топ-10 по (killsT45 + dead) чисто для швидкого перегляду кого треба відмітити
  const preview = [...importedRows]
    .sort((a, b) => (b.dead + b.t4 + b.t5) - (a.dead + a.t4 + a.t5))
    .slice(0, 10)
    .map((r, i) => {
      const killsT45 = r.t4 + r.t5;
      return (
        `${i + 1}. ${r.name || r.player_id} ` +
        `(ID ${r.player_id}) | K=${killsT45.toLocaleString("en-US")} | ` +
        `Dead=${r.dead.toLocaleString("en-US")}`
      );
    })
    .join("\n");

  const bodyText = [
    `✅ Excel import done`,
    `KvK: ${kvk_id}`,
    `Zone: ${zoneTag}`,
    `Scoring: ${isScoring ? "yes" : "no"}`,
    `Imported players: ${totalPlayers}`,
    ``,
    `Top contributors (killsT4+T5 + dead):`,
    preview || "(no rows)",
  ].join("\n");

  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: bodyText }),
    });
  } catch (err) {
    console.error("⚠️ Failed to send webhook summary:", err);
  }
}

/* ───────── main ───────── */

async function main() {
  const [, , filePath, zoneTagArg, scoringArg] = process.argv;

  if (!filePath || !zoneTagArg || scoringArg === undefined) {
    console.error(
      "Usage: node src/excelImport.js <file.xlsx> <zone_tag> <is_scoring:true|false>"
    );
    process.exit(1);
  }

  const zoneTag   = String(zoneTagArg).trim();
  const isScoring = /^(1|true|yes|y)$/i.test(String(scoringArg).trim());

  await initSchema();

  const kvk_id = await getActiveKvK();
  if (!kvk_id) {
    console.error("❌ No active KvK. Start/mark a KvK session first.");
    process.exit(1);
  }
  const kvkStr = String(kvk_id);

  const excelRows = readExcelRows(filePath);
  const client = await pool.connect();
  const importTs = new Date();

  // зберемо тільки тих, кого реально імпортили (для webhook)
  const importedPreview = [];

  try {
    await client.query("BEGIN");

    for (const row of excelRows) {
      // 1. Витягуємо player_id з різних назв колонок
      const pidRaw =
        row["Character ID"] ??
        row["Governor ID"] ??
        row["ID"] ??
        row["Id"] ??
        row["id"];

      if (!pidRaw) continue;
      const pidStr = String(pidRaw).replace(/\D/g, ""); // тільки цифри
      if (!pidStr) continue;

      // 2. Перевіряємо що цей player_id вже існує в players
      //    (інакше скіпаємо, бо ти не хочеш автододавати нових)
      const { rows: chkRows } = await client.query(
        `SELECT 1 FROM players WHERE player_id=$1`,
        [pidStr]
      );
      const existsAlready = chkRows.length > 0;
      if (!existsAlready) {
        // цей челик не має baseline → пропускаємо взагалі
        continue;
      }

      // 3. Читаємо ім'я
      const nameRaw =
        row["Username"] ??
        row["Name"] ??
        row["Governor Name"] ??
        row["name"] ??
        "";

      // 4. Дельти з Excel (за останній інтервал)
      //    Power може бути від'ємним (мінус техніка і т.д.)
      const dPower = parseNum(row["Power"]) ?? 0;

      const dKP    = parseNum(row["Total Kill Points"]) ?? 0;

      const dDead  =
        parseNum(row["Deaths"]) ??
        parseNum(row["Dead"]) ??
        parseNum(row["Deaths Count"]) ??
        0;

      const dT4 =
        parseNum(row["T4 Kills"]) ??
        parseNum(row["T4"]) ??
        0;

      const dT5 =
        parseNum(row["T5 Kills"]) ??
        parseNum(row["T5"]) ??
        0;

      // 5. Оновлюємо players: просто ім'я + last_update (НЕ baseline цифри!)
      await client.query(
        `
        UPDATE players
           SET name = $2,
               last_update = now()
         WHERE player_id = $1
        `,
        [
          pidStr,
          String(nameRaw || "").trim(),
        ]
      );

      // 6. Вставляємо дельту в imports
      await client.query(
        `
        INSERT INTO imports (
          kvk_id,
          player_id,
          import_ts,
          zone_tag,
          is_scoring,
          power,
          kp,
          dead,
          t4_kills,
          t5_kills
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          kvkStr,
          pidStr,
          importTs,
          zoneTag,
          isScoring,
          Math.trunc(dPower) || 0,
          Math.trunc(dKP)    || 0,
          Math.trunc(dDead)  || 0,
          Math.trunc(dT4)    || 0,
          Math.trunc(dT5)    || 0,
        ]
      );

      // 7. Для webhook статистики
      importedPreview.push({
        player_id: pidStr,
        name: String(nameRaw || "").trim(),
        t4:   Math.trunc(dT4)   || 0,
        t5:   Math.trunc(dT5)   || 0,
        dead: Math.trunc(dDead) || 0,
      });
    }

    await client.query("COMMIT");

    console.log(
      `✅ Import OK. zone_tag="${zoneTag}", is_scoring=${isScoring}, kvk_id=${kvk_id}`
    );

    // надсилаємо summary в адмінський вебхук (якщо налаштовано)
    await sendWebhookSummary({
      zoneTag,
      isScoring,
      kvk_id,
      importedRows: importedPreview,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Import failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});