// src/bot.js
import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { Pool } from "pg";
import {
  initSchema,
  kvkStart,
  kvkSetWeight,
  kvkEnsureGoal,
  kvkProgress,
  kvkTop,
  kvkActiveId,
} from "./db.pg.js";

// ---------- utils
const nf = (x) => new Intl.NumberFormat("en-US").format(Number(x || 0));
const bar = (p) => {
  const cap = Math.min(Number(p) || 0, 200); // малюємо бар до 200%
  const filled = Math.round((cap / 200) * 25);
  return "█".repeat(filled) + "─".repeat(25 - filled);
};
const HELP_TEXT = [
  "**Команди:**",
  "`!stats <player_id>` — останні стати гравця (latest)",
  "`!me` — мої останні стати (після `!link`)",
  "`!link @user <player_id>` — привʼязати Discord ↔ player_id",
  "`!top [kp|power] [N]` — топ N за KP або Power (із latest)",
  "",
  "`!kvk start [назва]` — почати новий KvK-період",
  "`!kvk active` — показати активний KvK",
  "`!kvk weight <dead|kp> <value>` — виставити ваги DKP",
  "`!kvk ensure <player_id>` — створити/оновити ціль для гравця",
  "`!kvk ensure_all` — створити/оновити цілі для всіх із latest",
  "`!kvk stats <player_id>` — прогрес KvK по гравцю",
  "`!kvk me` — мій прогрес KvK (після `!link`)",
  "`!kvk top [N]` — топ KvK за % до цілі",
].join("\n");

// ---------- DB pool (легкі селекти/привʼязки)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// забезпечуємо схему до створення discord_links (через FK на players)
await initSchema();

// таблиця для звʼязку Discord ↔ player_id
await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );
`);

// ---------- Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- helpers
async function fetchLatestById(id) {
  const { rows } = await pool.query(
    `
    SELECT l.player_id, l.name, l.power, l.kp, l.dead, l.t1, l.t2, l.t3, l.t4, l.t5, l.updated_at
    FROM latest l
    WHERE l.player_id = $1
  `,
    [id]
  );
  return rows[0] || null;
}
async function fetchLink(discordId) {
  const { rows } = await pool.query(
    `SELECT player_id FROM discord_links WHERE discord_id=$1`,
    [discordId]
  );
  return rows[0]?.player_id || null;
}
async function setLink(discordId, playerId) {
  await pool.query(
    `
    INSERT INTO discord_links(discord_id, player_id)
    VALUES ($1,$2)
    ON CONFLICT (discord_id) DO UPDATE SET player_id=excluded.player_id
  `,
    [discordId, playerId]
  );
}
async function fetchTop(by = "kp", limit = 10) {
  const col = by === "power" ? "power" : "kp";
  const { rows } = await pool.query(
    `
    SELECT player_id, name, ${col} AS metric
    FROM latest
    WHERE ${col} IS NOT NULL
    ORDER BY ${col} DESC
    LIMIT $1
  `,
    [limit]
  );
  return rows;
}

function buildLatestEmbed(row) {
  return new EmbedBuilder()
    .setTitle(row.name ? `${row.name} (${row.player_id})` : String(row.player_id))
    .setDescription(
      `Last update: <t:${Math.floor(new Date(row.updated_at).getTime() / 1000)}:R>`
    )
    .addFields(
      { name: "Power", value: nf(row.power), inline: true },
      { name: "KP", value: nf(row.kp), inline: true },
      { name: "Dead", value: nf(row.dead), inline: true },
      { name: "Kills t5", value: nf(row.t5), inline: true },
      { name: "t4", value: nf(row.t4), inline: true },
      { name: "t3", value: nf(row.t3), inline: true },
      { name: "t2", value: nf(row.t2), inline: true },
      { name: "t1", value: nf(row.t1), inline: true }
    )
    .setColor(0x5865f2);
}

function buildKvkEmbed(r) {
  const pct = Number(r.pct) || 0;
  const left = Math.max(0, Number(r.goal_dkp || 0) - Number(r.dkp || 0));
  const desc =
    `**DKP:** ${nf(r.dkp)} / ${nf(r.goal_dkp)}  (${pct}%)\n` +
    `**Залишилось DKP:** ${nf(left)} (${Math.max(0, 100 - pct)}%)\n` +
    `\`\`\`${bar(pct)}\`\`\`\n` +
    `**ΔKP:** ${nf(r.d_kp)} • **ΔDead:** ${nf(r.d_dead)}\n` +
    `goal_kp: ${nf(r.goal_kp)} • goal_dead: ${nf(r.goal_dead)}`;

  return new EmbedBuilder()
    .setTitle(`${r.name ?? r.player_id} — KvK ${r.kvk_id}`)
    .setDescription(desc)
    .setColor(pct >= 100 ? 0x00c853 : 0xffc107);
}

// зручні геттери player_id
async function getLinkedPlayerIdOrReply(msg) {
  const linked = await fetchLink(msg.author.id);
  if (!linked) {
    await msg.reply("Спочатку привʼяжи себе: `!link @you <player_id>`");
    return null;
  }
  return linked;
}
function parsePlayerId(arg) {
  if (!arg || !/^\d+$/.test(arg)) return null;
  try {
    return BigInt(arg); // узгоджено з db шаром
  } catch {
    return null;
  }
}

// ---------- commands
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;

    const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);

    // --- KvK admin / control
    if (cmd === "kvk" && args[0] === "start") {
      const name = args.slice(1).join(" ") || null;
      const id = await kvkStart(name);
      return void msg.reply(`KvK period **${id}** started${name ? `: ${name}` : ""}.`);
    }

    if (cmd === "kvk" && args[0] === "active") {
      const id = await kvkActiveId();
      return void msg.reply(id ? `Active KvK: **${id}**` : "Немає активного KvK.");
    }

    if (cmd === "kvk" && args[0] === "weight") {
      const which = (args[1] || "").toLowerCase(); // "dead" або "kp"
      const val = Number(args[2]);
      if (!["dead", "kp"].includes(which) || !Number.isFinite(val)) {
        return void msg.reply("Використання: `!kvk weight <dead|kp> <value>`");
      }
      await kvkSetWeight(which, val);
      return void msg.reply(`Weight **${which}** set to **${val}**.`);
    }

    if (cmd === "kvk" && (args[0] === "ensure" || args[0] === "setgoal")) {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Вкажи player_id: `!kvk ensure 187596275`");
      const g = await kvkEnsureGoal(pid);
      if (!g) return void msg.reply("Уже є goal, або немає активного KvK/даних latest.");
      return void msg.reply(
        `Goal for **${pid}**:\n` +
          `• goal_kp: **${nf(g.goal_kp)}**\n` +
          `• goal_dead: **${nf(g.goal_dead)}**\n` +
          `• goal_dkp: **${nf(g.goal_dkp)}**`
      );
    }

    if (cmd === "kvk" && args[0] === "ensure_all") {
      // створити/оновити goal для всіх, хто є у latest
      const { rows } = await pool.query(`SELECT player_id FROM latest`);
      let made = 0,
        skipped = 0;
      for (const r of rows) {
        const out = await kvkEnsureGoal(BigInt(r.player_id));
        if (out) made++;
        else skipped++;
      }
      return void msg.reply(
        `KvK goals ensured: **${made}** (skipped/exists/no-data: ${skipped}).`
      );
    }

    if (cmd === "kvk" && args[0] === "stats") {
      const pid = parsePlayerId(args[1]);
      if (pid == null) return void msg.reply("Вкажи player_id: `!kvk stats 187596275`");
      const r = await kvkProgress(pid);
      if (!r) return void msg.reply("Немає goal/start або latest для цього гравця.");
      return void msg.reply({ embeds: [buildKvkEmbed(r)] });
    }

    if (cmd === "kvk" && args[0] === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;
      const r = await kvkProgress(BigInt(linked));
      if (!r) return void msg.reply("Немає goal/start або latest для твого player_id.");
      return void msg.reply({ embeds: [buildKvkEmbed(r)] });
    }

    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const rows = await kvkTop(limit);
      if (!rows.length) return void msg.reply("Порожньо.");
      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${r.pct}% (DKP ${nf(r.dkp)}/${nf(
            r.goal_dkp
          )})`
      );
      return void msg.reply(lines.join("\n"));
    }

    // --- latest / linkage / general
    if (cmd === "stats") {
      const idArg = args[0];
      if (!idArg || !/^\d+$/.test(idArg)) {
        return void msg.reply("Вкажи **player_id**: `!stats 187596275`");
      }
      const row = await fetchLatestById(idArg);
      if (!row) return void msg.reply("Немає даних. Спочатку запусти скан.");
      return void msg.reply({ embeds: [buildLatestEmbed(row)] });
    }

    if (cmd === "me") {
      const linked = await getLinkedPlayerIdOrReply(msg);
      if (!linked) return;
      const row = await fetchLatestById(linked);
      if (!row) return void msg.reply("Для твого player_id ще немає даних.");
      return void msg.reply({ embeds: [buildLatestEmbed(row)] });
    }

    if (cmd === "link") {
      if (args.length < 2) {
        return void msg.reply("Використання: `!link @user <player_id>`");
      }
      const mention = msg.mentions.users.first();
      if (!mention) return void msg.reply("Треба вказати @згадку користувача.");
      const idArg = args[1];
      if (!/^\d+$/.test(idArg)) return void msg.reply("player_id має бути числом.");
      await setLink(mention.id, idArg);
      return void msg.reply(`Звʼязав ${mention} ⇄ player_id **${idArg}**.`);
    }

    if (cmd === "top") {
      const by = (args[0] || "kp").toLowerCase();
      const limit = Math.min(Math.max(parseInt(args[1] || "10", 10) || 10, 1), 50);
      const rows = await fetchTop(by, limit);
      if (!rows.length) return void msg.reply("Порожньо. Спочатку запусти скан.");
      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(r.metric)}**`
      );
      return void msg.reply(lines.join("\n"));
    }

    if (cmd === "help") {
      return void msg.reply(HELP_TEXT);
    }
  } catch (e) {
    console.error(e);
    try {
      await msg.reply("Сталася помилка. Перевір лог.");
    } catch {}
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// sanity check токена
if (!process.env.DISCORD_TOKEN || !process.env.DATABASE_URL) {
  console.error("❌ DISCORD_TOKEN або DATABASE_URL не задано у .env");
}

client.login(process.env.DISCORD_TOKEN);