// Normalizes OCR number strings such as "88,900,106", "8 765 432",
// and "1.234.567" into plain numbers. Returns 0 when no digits exist.
function toNum(str) {
  if (str == null) return 0;
  const m = String(str).match(/\d[\d\s,.\u00A0]*/);
  if (!m) return 0;
  const cleaned = m[0].replace(/[^\d]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses raw OCR fields from scanProfileOnce().
 * Some layouts label Kill Points as either KP or Kills.
 */
export function parseStats(texts) {
  const labelLA = String(texts.label_left_a ?? "").toLowerCase();
  const labelRA = String(texts.label_right_a ?? "").toLowerCase();
  const labelLB = String(texts.label_left_b ?? "").toLowerCase();
  const labelRB = String(texts.label_right_b ?? "").toLowerCase();

  const hasPowerLA = labelLA.includes("power");
  const hasKillLA = labelLA.includes("kill") || labelLA.includes("kp");
  const hasPowerLB = labelLB.includes("power");
  const hasKillLB = labelLB.includes("kill") || labelLB.includes("kp");

  const leftValA = toNum(texts.value_left_a);
  const rightValA = toNum(texts.value_right_a);
  const leftValB = toNum(texts.value_left_b);
  const rightValB = toNum(texts.value_right_b);

  let powerVal = toNum(texts.power);
  let kpVal = 0;

  if ((hasPowerLA || hasKillLA) && (leftValA || rightValA)) {
    if (hasPowerLA) {
      powerVal = leftValA;
      kpVal = rightValA;
      texts._layout = "A_power_left";
    } else {
      powerVal = rightValA;
      kpVal = leftValA;
      texts._layout = "A_kp_left";
    }
  } else if ((hasPowerLB || hasKillLB) && (leftValB || rightValB)) {
    if (hasPowerLB) {
      powerVal = leftValB;
      kpVal = rightValB;
      texts._layout = "B_power_left";
    } else {
      powerVal = rightValB;
      kpVal = leftValB;
      texts._layout = "B_kp_left";
    }
  } else {
    const a = toNum(texts.kp);
    if (a) kpVal = a;
    else {
      const b = toNum(texts.kills);
      if (b) kpVal = b;
      else {
        const c = toNum(texts.killpoints);
        if (c) kpVal = c;
      }
    }
  }

  const t1Left = toNum(texts.t1_left ?? texts.t1);
  const t2Left = toNum(texts.t2_left ?? texts.t2);
  const t3Left = toNum(texts.t3_left ?? texts.t3);
  const t4Left = toNum(texts.t4_left ?? texts.t4);
  const t5Left = toNum(texts.t5_left ?? texts.t5);

  const t1Right = toNum(texts.t1_right);
  const t2Right = toNum(texts.t2_right);
  const t3Right = toNum(texts.t3_right);
  const t4Right = toNum(texts.t4_right);
  const t5Right = toNum(texts.t5_right);

  const layout = String(texts._layout || "");
  const killsOnLeft = layout.endsWith("kp_left");

  const t1Val = killsOnLeft ? t1Left : (t1Right || t1Left);
  const t2Val = killsOnLeft ? t2Left : (t2Right || t2Left);
  const t3Val = killsOnLeft ? t3Left : (t3Right || t3Left);
  const t4Val = killsOnLeft ? t4Left : (t4Right || t4Left);
  const t5Val = killsOnLeft ? t5Left : (t5Right || t5Left);

  return {
    id: toNum(
      texts.id ?? texts.player_id ?? texts.playerId ?? texts.pid
    ),
    name: String(texts.name ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    power: powerVal,
    dead: toNum(texts.dead ?? texts.deads ?? texts.deaths),
    kp: kpVal,
    t1: t1Val,
    t2: t2Val,
    t3: t3Val,
    t4: t4Val,
    t5: t5Val,
  };
}
