// src/kvk.cli.js — простий CLI для KvK
import "dotenv/config";
import { initSchema, closeDb,
  kvkStart, kvkSetWeight, kvkActiveId,
  kvkEnsureGoal, kvkTop, kvkProgress } from "./db.pg.js";

function usage() {
  console.log(`
Usage:
  node src/kvk.cli.js start [name]           # старт нового KvK періоду
  node src/kvk.cli.js weight kp <value>      # виставити вагу KP (напр. 1.0)
  node src/kvk.cli.js weight dead <value>    # виставити вагу dead→DKP (напр. 5)
  node src/kvk.cli.js ensure <player_id>     # створити ціль для гравця (якщо нема)
  node src/kvk.cli.js progress <player_id>   # показати прогрес гравця
  node src/kvk.cli.js top [N]                # топ N за % до цілі
`);}

async function main(){
  await initSchema();
  const [cmd, a1, a2] = process.argv.slice(2);

  switch (cmd) {
    case "start": {
      const kvk = await kvkStart(a1 || null);
      console.log("Started KvK:", kvk);
      break;
    }
    case "weight": {
      if (!["kp","dead"].includes(a1)) { usage(); break; }
      const val = Number(a2);
      if (!Number.isFinite(val)) { usage(); break; }
      await kvkSetWeight(a1, val);
      console.log(`Set weight ${a1}=${val} for KvK ${await kvkActiveId()}`);
      break;
    }
    case "ensure": {
      const pid = BigInt(a1);
      const res = await kvkEnsureGoal(pid);
      console.log(res ? "Goal ensured/updated:" : "Already had goal or no active KvK.", res);
      break;
    }
    case "progress": {
      const pid = BigInt(a1);
      const p = await kvkProgress(pid);
      console.log(p || "No progress / no goal yet.");
      break;
    }
    case "top": {
      const n = Number(a1 || 20);
      const rows = await kvkTop(n);
      console.table(rows);
      break;
    }
    default: usage();
  }
  await closeDb();
}

main().catch(async e => { console.error(e); await closeDb().catch(()=>{}); process.exit(1); });
