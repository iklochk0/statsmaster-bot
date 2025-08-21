// src/bot.js
import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { Pool } from "pg";
import { kvkStart, kvkSetGoalAuto, kvkSetWeight, kvkProgress, kvkTop } from "./db.pg.js";

const nf = (x)=> new Intl.NumberFormat("en-US").format(Number(x||0));
const bar = (p)=> {
  const cap = Math.min(Number(p)||0, 200);
  const filled = Math.round((cap/200)*25);
  return "█".repeat(filled) + "─".repeat(25-filled);
};


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function nf(x){ return new Intl.NumberFormat("en-US").format(Number(x||0)); }

async function fetchLatestById(id){
  const { rows } = await pool.query(`
    SELECT l.player_id, l.name, l.power, l.kp, l.dead, l.t1, l.t2, l.t3, l.t4, l.t5, l.updated_at
    FROM latest l
    WHERE l.player_id = $1
  `, [id]);
  return rows[0] || null;
}

async function fetchLink(discordId){
  const { rows } = await pool.query(`SELECT player_id FROM discord_links WHERE discord_id=$1`, [discordId]);
  return rows[0]?.player_id || null;
}

async function setLink(discordId, playerId){
  await pool.query(`
    INSERT INTO discord_links(discord_id, player_id)
    VALUES ($1,$2)
    ON CONFLICT (discord_id) DO UPDATE SET player_id=excluded.player_id
  `, [discordId, playerId]);
}

async function fetchTop(by="kp", limit=10){
  const col = by === "power" ? "power" : "kp";
  const { rows } = await pool.query(`
    SELECT player_id, name, ${col} AS metric
    FROM latest
    WHERE ${col} IS NOT NULL
    ORDER BY ${col} DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

function buildEmbed(row){
  const e = new EmbedBuilder()
    .setTitle(row.name ? `${row.name} (${row.player_id})` : String(row.player_id))
    .setDescription(`Last update: <t:${Math.floor(new Date(row.updated_at).getTime()/1000)}:R>`)
    .addFields(
      { name: "Power", value: nf(row.power), inline: true },
      { name: "KP",    value: nf(row.kp),    inline: true },
      { name: "Dead",  value: nf(row.dead),  inline: true },
      { name: "Kills t5", value: nf(row.t5), inline: true },
      { name: "t4",       value: nf(row.t4), inline: true },
      { name: "t3",       value: nf(row.t3), inline: true },
      { name: "t2",       value: nf(row.t2), inline: true },
      { name: "t1",       value: nf(row.t1), inline: true },
    )
    .setColor(0x5865F2);
  return e;
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!")) return;

  const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);

  try{
    if (cmd === "kvk" && args[0] === "start") {
      const name = args.slice(1).join(" ");
      const id = await kvkStart(name);
      return msg.reply(`KvK period **${id}** started${name ? `: ${name}` : ""}.`);
    }

    if (cmd === "kvk" && args[0] === "weight") {
      const which = (args[1]||"").toLowerCase(); // "dead" або "kp"
      const val = args[2];
      await kvkSetWeight(which, val);
      return msg.reply(`Weight **${which}** set to **${val}**.`);
    }

    if (cmd === "kvk" && args[0] === "setgoal") {
      const playerId = args[1];
      if (!/^\d+$/.test(playerId)) return msg.reply("Вкажи player_id: `!kvk setgoal 187596275`");
      const g = await kvkSetGoalAuto(playerId);
      return msg.reply(
        `Goal for **${playerId}**:\n` +
        `• goal_kp: **${nf(g.goal_kp)}**\n` +
        `• goal_dead: **${nf(g.goal_dead)}**\n` +
        `• goal_dkp: **${nf(g.goal_dkp)}**`
      );
    }

    if (cmd === "kvk" && args[0] === "stats") {
      const playerId = args[1];
      if (!/^\d+$/.test(playerId)) return msg.reply("Вкажи player_id: `!kvk stats 187596275`");
      const r = await kvkProgress(playerId);
      if (!r) return msg.reply("Немає goal/start або latest для цього гравця.");
      return msg.reply({
        embeds: [{
          title: `${r.name ?? r.player_id} — KvK ${r.kvk_id}`,
          description:
            `**DKP:** ${nf(r.dkp)} / ${nf(r.goal_dkp)}  (${r.pct}%)\n` +
            `\`\`\`${bar(r.pct)}\`\`\`\n` +
            `**ΔKP:** ${nf(r.d_kp)} • **ΔDead:** ${nf(r.d_dead)}\n` +
            `goal_kp: ${nf(r.goal_kp)} • goal_dead: ${nf(r.goal_dead)}`,
          color: Number(r.pct) >= 100 ? 0x00C853 : 0xFFC107
        }]
      });
    }

    if (cmd === "kvk" && args[0] === "top") {
      const limit = Math.min(Math.max(parseInt(args[1]||"10",10)||10, 1), 50);
      const rows = await kvkTop(limit);
      if (!rows.length) return msg.reply("Порожньо.");
      const lines = rows.map((r,i)=>`**${i+1}.** ${r.name ?? r.player_id} — ${r.pct}% (DKP ${nf(r.dkp)}/${nf(r.goal_dkp)})`);
      return msg.reply(lines.join("\n"));
    }

    if (cmd === "stats") {
      const id = args[0];
      if (!id || !/^\d+$/.test(id)) return msg.reply("Вкажи **player_id**: `!stats 187596275`");
      const row = await fetchLatestById(id);
      if (!row) return msg.reply("Немає даних. Спочатку запусти скан.");
      return msg.reply({ embeds: [buildEmbed(row)] });
    }

    if (cmd === "me") {
      const linked = await fetchLink(msg.author.id);
      if (!linked) return msg.reply("Спочатку привʼяжи себе: `!link @you <player_id>`");
      const row = await fetchLatestById(linked);
      if (!row) return msg.reply("Для твого player_id ще немає даних.");
      return msg.reply({ embeds: [buildEmbed(row)] });
    }

    if (cmd === "link") {
      if (args.length < 2) return msg.reply("Використання: `!link @user <player_id>`");
      const mention = msg.mentions.users.first();
      if (!mention) return msg.reply("Треба вказати @згадку користувача.");
      const id = args[1];
      if (!/^\d+$/.test(id)) return msg.reply("player_id має бути числом.");
      await setLink(mention.id, id);
      return msg.reply(`Звʼязав ${mention} ⇄ player_id **${id}**.`);
    }

    if (cmd === "top") {
      const by = (args[0]||"kp").toLowerCase();
      const limit = Math.min(Math.max(parseInt(args[1]||"10",10)||10, 1), 50);
      const rows = await fetchTop(by, limit);
      if (!rows.length) return msg.reply("Порожньо. Спочатку запусти скан.");
      const lines = rows.map((r,i)=>`**${i+1}.** ${r.name ?? r.player_id} — ${by.toUpperCase()}: **${nf(r.metric)}**`);
      return msg.reply(lines.join("\n"));
    }

    if (cmd === "help") {
      return msg.reply([
        "**Команди:**",
        "`!stats <player_id>` — показати статистику гравця",
        "`!me` — показати мою статистику (після `!link`)",
        "`!link @user <player_id>` — привʼязати Discord ↔ player_id",
        "`!top [kp|power] [N]` — топ N за KP або Power",
      ].join("\n"));
    }

  } catch (e) {
    console.error(e);
    return msg.reply("Сталася помилка. Перевір лог.");
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);