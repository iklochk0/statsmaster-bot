const num = s => Number((s||"").match(/\d[\d\s,.\u00A0]*/)?.[0].replace(/[^\d]/g,"") || 0);
export function parseStats(t){
  return {
    name: (t.name||"").trim(),
    power: num(t.power),
    dead:  num(t.dead),
    kills: { t5:num(t.t5), t4:num(t.t4), t3:num(t.t3), t2:num(t.t2), t1:num(t.t1) }
  };
}