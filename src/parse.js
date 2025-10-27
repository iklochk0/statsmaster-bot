// src/parse.js

// нормалізуємо OCR-текст в число
// приклади що це ковтає:
//   "88,900,106" -> 88900106
//   "8 765 432"  -> 8765432
//   "1.234.567"  -> 1234567
// якщо не знаходить цифр -> 0
function toNum(str) {
  if (str == null) return 0;
  // знайти перший блок типу "123 456 789"
  const m = String(str).match(/\d[\d\s,.\u00A0]*/);
  if (!m) return 0;
  // викинути все що не цифра
  const cleaned = m[0].replace(/[^\d]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * texts — це сирі OCR-поля з scanProfileOnce():
 *   texts.id
 *   texts.name
 *   texts.power
 *   texts.kp  (інколи гра пише "Kill Points")
 *   texts.kills (деякі профілі можуть підписувати просто "Kills", але це теж KP)
 *   texts.dead
 *   texts.t1 ... texts.t5  (кіли по тірах)
 */
export function parseStats(texts) {
  // Kill Points (kp): беремо те, що є
  // пріоритет: texts.kp -> texts.kills -> texts.killpoints
  const kpVal = (() => {
    const a = toNum(texts.kp);
    if (a) return a;
    const b = toNum(texts.kills);
    if (b) return b;
    const c = toNum(texts.killpoints);
    if (c) return c;
    return 0;
  })();

  return {
    // player id
    id: toNum(
      texts.id ??
      texts.player_id ??
      texts.playerId ??
      texts.pid
    ),

    // ім'я (чистимо пробіли)
    name: String(texts.name ?? "")
      .replace(/\s+/g, " ")
      .trim(),

    // power / dead
    power: toNum(texts.power),
    dead:  toNum(texts.dead ?? texts.deads ?? texts.deaths),

    // kill points total (просто показуємо зверху в картці, НЕ для goal)
    kp: kpVal,

    // kills per tier (сирі т1..т5 лічильники)
    // ЦІ значення підуть у таблицю stats.t1..t5 і latest.t1..t5
    t1: toNum(texts.t1),
    t2: toNum(texts.t2),
    t3: toNum(texts.t3),
    t4: toNum(texts.t4),
    t5: toNum(texts.t5),
  };
}