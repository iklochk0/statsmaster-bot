// src/parse.js

// Нормальне перетворення рядка з цифрами на число
// Підтримає пробіли/коми/крапки/nbsp
const num = (s) => {
  if (s == null) return 0;
  const m = String(s).match(/\d[\d\s,.\u00A0]*/);
  if (!m) return 0;
  return Number(m[0].replace(/[^\d]/g, ""));
};

export function parseStats(texts) {
  return {
    // ID беремо з різних можливих ключів, на всякий випадок
    id: num(texts.id ?? texts.player_id ?? texts.playerId),

    name: (texts.name ?? "").replace(/\s+/g, " ").trim(),

    power: num(texts.power),
    kp:    num(texts.kp ?? texts.killpoints ?? texts.kill_points),
    dead:  num(texts.dead ?? texts.deads ?? texts.deaths),

    kills: {
      t1: num(texts.t1),
      t2: num(texts.t2),
      t3: num(texts.t3),
      t4: num(texts.t4),
      t5: num(texts.t5),
    },
  };
}