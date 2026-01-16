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
//   - НЕ створює нових гравців: оновлює тільки тих, хто вже є в players (baseline з OCR/ручний)
//   - перетворює ABS "Current Power"/"Power" → ΔPower (відносно baseline + Σ попередніх імпортів у цьому KvK)
//   - вставляє дельти в imports (з ідемпотентністю через row_sig)
//   - оновлює тільки name + last_update у players
//   - надсилає короткий звіт у ADMIN_IMPORT_WEBHOOK_URL
//
// Колонки Excel, які підтримуються:
//   "Character ID" / "Governor ID" / "ID" / "Id" / "id"           -> player_id
//   "Username" / "Name" / "Governor Name" / "name"                -> name
//   "Current Power" / "Power"                                     -> ABS Power (ми переводимо у Δ перед вставкою)
//   "Total Kill Points"                                           -> ΔKP
//   "Deaths" / "Dead" / "Deaths Count"                            -> ΔDead
//   "T4 Kills" / "T4"                                             -> ΔT4
//   "T5 Kills" / "T5"                                             -> ΔT5
//
// is_scoring=true → цей внесок зараховується у прогрес / DKP.
//
// Ідемпотентність:
//   - при старті додасть колонку imports.row_sig (якщо її нема)
//   - створить індекс-унікальність на (kvk_id, player_id, zone_tag, is_scoring, row_sig)
//   - row_sig = md5(player_id|zone|is_scoring|dPower|dKP|dDead|dT4|dT5)
//   - повторний імпорт того самого файлу стає no-op.
//
// Примітка:
//   - Якщо у твоєму джерелі "Total Kill Points" раптом прийде як ABS, треба буде аналогічно
//     конвертувати у Δ (аналог блокові з power). Наразі вважаємо, що KP/T4/T5/Dead — дельти.
//

import "dotenv/config";
import XLSX from "xlsx";
import { createHash } from "crypto";
import {
  pool,
  initSchema,
  getActiveKvK,
} from "./db.pg.js";

/* ───────── helpers ───────── */

function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[, ]+/g, "").replace(/[^\d.-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function readExcelRows(path) {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  return rows;
}

function md5(s) {
  return createHash("md5").update(String(s)).digest("hex");
}

/**
 * Відправляє короткий звіт в адмін-канал через вебхук.
 * Ми показуємо ТІЛЬКИ тих, кого реально імпортили (тобто тих, хто існував у players).
 */
async function sendWebhookSummary({ zoneTag, isScoring, kvk_id, importedRows }) {
  const hook = process.env.ADMIN_IMPORT_WEBHOOK_URL;
  if (!hook) return;

  const totalPlayers = importedRows.length;

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

  const zoneTag = String(zoneTagArg).trim().toLowerCase();
  const isScoring = /^(1|true|yes|y)$/i.test(String(scoringArg).trim());

  await initSchema();

  // Міграція під ідемпотентність (безпечна, IF NOT EXISTS)
  await pool.query(`
    ALTER TABLE imports
      ADD COLUMN IF NOT EXISTS row_sig TEXT
  `).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_import_row
      ON imports(kvk_id, player_id, zone_tag, is_scoring, row_sig)
  `).catch(() => {});

  const kvk_id = await getActiveKvK();
  if (!kvk_id) {
    console.error("❌ No active KvK. Start/mark a KvK session first.");
    process.exit(1);
  }
  const kvkStr = String(kvk_id);

  const excelRows = readExcelRows(filePath);
  const importTs = new Date();

  // 0) Попередньо зберемо всі player_id з файлу
  const allIdsRaw = new Set();
  for (const row of excelRows) {
    const pidRaw =
      row["Character ID"] ??
      row["Governor ID"] ??
      row["ID"] ??
      row["Id"] ??
      row["id"];
    if (!pidRaw) continue;
    const pidStr = String(pidRaw).replace(/\D/g, "");
    if (pidStr) allIdsRaw.add(pidStr);
  }
  const allIds = Array.from(allIdsRaw);
  if (!allIds.length) {
    console.error("❌ No player IDs found in the file.");
    process.exit(1);
  }

  // 1) Дістанемо baseline power для ВСІХ згаданих id (які існують у players)
  const { rows: playersRows } = await pool.query(
    `
    SELECT player_id::text AS player_id, power_current
    FROM players
    WHERE player_id = ANY($1::bigint[])
    `,
    [allIds]
  );
  const existingIdsSet = new Set(playersRows.map(r => String(r.player_id)));

  // 2) Сума попередніх дельт power у цьому KvK для цих id (одним запитом)
  const { rows: prevAggRows } = await pool.query(
    `
    SELECT player_id::text AS player_id, COALESCE(SUM(power),0) AS tot_power
    FROM imports
    WHERE kvk_id=$1 AND player_id = ANY($2::bigint[])
    GROUP BY player_id
    `,
    [kvkStr, allIds]
  );
  const prevSumMap = new Map(prevAggRows.map(r => [String(r.player_id), toNum(r.tot_power, 0)]));

  // 3) Стартовий кеш «попередній абсолют» для кожного існуючого гравця
  const prevAbsCache = new Map(); // pid -> prevAbs (baseline + Σ попередніх імпортів)
  for (const r of playersRows) {
    const pid = String(r.player_id);
    const basePower = toNum(r.power_current, 0);
    const sumPow = prevSumMap.get(pid) || 0;
    prevAbsCache.set(pid, basePower + sumPow);
  }

  // 4) Пройдемо файл і сформуємо вхідні записи на вставку
  //    а також оновлення імені (players.name + last_update)
  const importedPreview = [];

  // Щоб не робити COMMIT на кожен рядок — одна транзакція
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const row of excelRows) {
      // 4.1 player_id
      const pidRaw =
        row["Character ID"] ??
        row["Governor ID"] ??
        row["ID"] ??
        row["Id"] ??
        row["id"];
      if (!pidRaw) continue;
      const pidStr = String(pidRaw).replace(/\D/g, "");
      if (!pidStr) continue;

      // тільки якщо baseline існує
      if (!existingIdsSet.has(pidStr)) continue;

      // 4.2 name
      const nameRaw =
        row["Username"] ??
        row["Name"] ??
        row["Governor Name"] ??
        row["name"] ??
        "";

      // 4.3 дані
      let curPowerAbs =
        parseNum(row["Current Power"]) ??
        parseNum(row["Power"]) ??
        null; // якщо null — power не чіпаємо

      // саніті-чек на power ABS (захист від «сміття»)
      if (curPowerAbs !== null) {
        if (curPowerAbs < 0) curPowerAbs = 0;
        if (curPowerAbs > 10_000_000_000) curPowerAbs = null; // підозріле — ігноруємо як відсутнє
      }

      const dKP = parseNum(row["Total Kill Points"]) ?? 0;

      const dDead =
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

      // 4.4 обчислюємо ΔPower з ABS (якщо ABS був)
      let dPower = 0;
      if (curPowerAbs !== null) {
        const prevAbs = prevAbsCache.get(pidStr) ?? 0;
        dPower = Math.trunc(curPowerAbs - prevAbs);
        // оновлюємо кеш, щоб наступний рядок у цьому ж запуску бачив новий «поточний абсолют»
        prevAbsCache.set(pidStr, prevAbs + dPower);
      } else {
        dPower = 0;
      }

      // 4.5 no-op фільтр: якщо все по нулях — пропускаємо
      const dKPz = Math.trunc(dKP) || 0;
      const dDeadz = Math.trunc(dDead) || 0;
      const dT4z = Math.trunc(dT4) || 0;
      const dT5z = Math.trunc(dT5) || 0;
      const dPowerz = Math.trunc(dPower) || 0;

      if (dKPz === 0 && dDeadz === 0 && dT4z === 0 && dT5z === 0 && dPowerz === 0) {
        // все нулі — нічого не вставляємо
        continue;
      }

      // 4.6 оновлюємо players.name + last_update (НЕ baseline цифри!)
      await client.query(
        `
        UPDATE players
           SET name = $2,
               last_update = now()
         WHERE player_id = $1
        `,
        [pidStr, String(nameRaw || "").trim()]
      );

      // 4.7 row_sig для ідемпотентності
      const rowSig = md5(
        `${pidStr}|${zoneTag}|${isScoring ? 1 : 0}|${dPowerz}|${dKPz}|${dDeadz}|${dT4z}|${dT5z}`
      );

      // 4.8 вставляємо дельту в imports (ON CONFLICT DO NOTHING)
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
          t5_kills,
          row_sig
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (kvk_id, player_id, zone_tag, is_scoring, row_sig) DO NOTHING
        `,
        [
          kvkStr,
          pidStr,
          importTs,
          zoneTag,
          isScoring,
          dPowerz,
          dKPz,
          dDeadz,
          dT4z,
          dT5z,
          rowSig,
        ]
      );

      // 4.9 для webhook-тіла
      importedPreview.push({
        player_id: pidStr,
        name: String(nameRaw || "").trim(),
        t4: dT4z,
        t5: dT5z,
        dead: dDeadz,
      });
    }

    await client.query("COMMIT");

    console.log(
      `✅ Import OK. zone_tag="${zoneTag}", is_scoring=${isScoring}, kvk_id=${kvk_id}`
    );

    // webhook summary (опційно)
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

  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error("FATAL:", e);
  pool.end().catch(() => {});
  process.exit(1);
});
