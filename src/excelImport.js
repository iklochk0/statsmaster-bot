// src/excelImport.js
//
// Використання:
//   node src/excelImport.js <file.xlsx> <zone_tag> <is_scoring:true|false>
//
// Приклад:
//   node src/excelImport.js ./zone4_day1.xlsx zone4 true
//
// Що робить:
//   - читає Excel (кожен рядок = внесок гравця за інтервал бою)
//   - пушить ці дельти в таблицю imports
//   - гарантує що гравець існує в players (створює "пустого" якщо не бачили через OCR)
//   - оновлює name + last_update в players
//
// Після імпорту шле звіт у #individual-stats-admin через webhook.
//

import "dotenv/config";
import XLSX from "xlsx";
import fetch from "node-fetch";
import {
  pool,
  initSchema,
  getActiveKvK,
} from "./db.pg.js";

function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const s = String(v)
    .trim()
    .replace(/[, ]+/g, "")
    .replace(/[^\d.-]/g, "");
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

async function sendWebhookSummary({ zoneTag, isScoring, kvk_id, importedRows }) {
  // якщо в env нема вебхука — просто скіпаємо
  const hook = process.env.ADMIN_IMPORT_WEBHOOK_URL;
  if (!hook) return;

  // трохи статистики для повідомлення
  const totalPlayers = importedRows.length;

  // топ-10 по dead і t4+t5 просто щоб одразу бачити хто топився / різав
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
    `Rows imported: ${totalPlayers}`,
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

  // зберемо підсумок по кожному рядку, щоб відправити в вебхук
  const importedPreview = [];

  try {
    await client.query("BEGIN");

    for (const row of excelRows) {
      // спробувати дістати player_id
      const pidRaw =
        row["Character ID"] ??
        row["Governor ID"] ??
        row["ID"] ??
        row["Id"] ??
        row["id"];

      if (!pidRaw) continue;

      const pidStr = String(pidRaw).replace(/\D/g, "");
      if (!pidStr) continue;

      const nameRaw =
        row["Username"] ??
        row["Name"] ??
        row["Governor Name"] ??
        row["name"] ??
        "";

      // ДЕЛЬТИ з Excel за період:
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

      // гарантуємо існування гравця в players
      // baseline ми НЕ змінюємо (0,0,0...), просто апсертимо рядок і апдейтимо only name,last_update
      await client.query(
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
        VALUES ($1,$2,0,0,0,0,0, now())
        ON CONFLICT (player_id) DO UPDATE SET
          name        = EXCLUDED.name,
          last_update = now()
        `,
        [
          pidStr,
          String(nameRaw || "").trim(),
        ]
      );

      // кинули дельту в imports
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

      importedPreview.push({
        player_id: pidStr,
        name: String(nameRaw || "").trim(),
        t4: Math.trunc(dT4) || 0,
        t5: Math.trunc(dT5) || 0,
        dead: Math.trunc(dDead) || 0,
      });
    }

    await client.query("COMMIT");
    console.log(
      `✅ Import OK. zone_tag="${zoneTag}", is_scoring=${isScoring}, kvk_id=${kvk_id}`
    );

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