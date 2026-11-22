// SAMPLE DATA ONLY. Makes realistic-looking daily ad results so the team's
// learning loop can be shown. No ads are posted and these are not real numbers.

export type DayResult = { day: number; spend: number; impressions: number; clicks: number; signups: number };
export type CellResult = { cell_id: string; label: string; days: DayResult[] };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function simulateRound(
  round: number,
  cells: { cell_id: string; label: string; daily_budget_inr: number }[],
  seedText: string
): CellResult[] {
  const rand = rng(hash(seedText + ":" + round));
  // Give each cell a different "true" strength so a pattern can emerge.
  const strengths = [1.45, 1.0, 0.72].sort(() => rand() - 0.5);
  const roundBoost = 1 + 0.12 * (round - 1); // later rounds apply learnings
  return cells.map((c, i) => {
    const strength = strengths[i % 3] * roundBoost;
    const baseCtr = 0.011 * strength;
    const baseConv = 0.06 * Math.sqrt(strength);
    const cpm = 140 + rand() * 60; // ₹ per 1000 impressions
    const days: DayResult[] = [];
    for (let d = 1; d <= 7; d++) {
      const spend = Math.round(c.daily_budget_inr * (0.88 + rand() * 0.24));
      const impressions = Math.round((spend / cpm) * 1000);
      const ctr = baseCtr * (0.75 + rand() * 0.5) * (d === 1 ? 0.8 : 1); // day 1 = learning phase
      const clicks = Math.max(0, Math.round(impressions * ctr));
      const signups = Math.max(0, Math.round(clicks * baseConv * (0.6 + rand() * 0.8)));
      days.push({ day: d, spend, impressions, clicks, signups });
    }
    return { cell_id: c.cell_id, label: c.label, days };
  });
}

export function totals(days: DayResult[]) {
  const t = days.reduce(
    (a, d) => ({ spend: a.spend + d.spend, impressions: a.impressions + d.impressions, clicks: a.clicks + d.clicks, signups: a.signups + d.signups }),
    { spend: 0, impressions: 0, clicks: 0, signups: 0 }
  );
  return {
    ...t,
    ctr: t.impressions ? t.clicks / t.impressions : 0,
    cps: t.signups ? t.spend / t.signups : null, // cost per signup
  };
}
