// src/metrics.js
export function computeGoals(power) {
  const kp_goal = Math.round(2.2 * power);
  const dead_goal = Math.round(power / 87);
  return { kp_goal, dead_goal };
}

// простий варіант dkp: об’єднаємо виконання двох цілей, ваги можеш підкрутити
export function computeDkp({ kp, dead }, { kp_goal, dead_goal }, weights = { kp: 0.7, dead: 0.3 }) {
  const kpPct = kp_goal > 0 ? Math.min(1, kp / kp_goal) : 0;
  const deadPct = dead_goal > 0 ? Math.min(1, dead / dead_goal) : 0;
  const dkp = kpPct * weights.kp + deadPct * weights.dead; // 0..1
  return { kpPct, deadPct, dkp };
}