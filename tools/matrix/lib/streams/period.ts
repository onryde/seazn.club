// hockey / icehockey — period kernel. `to` must be the exact next label under a
// strict fold (period/kernel.ts:1140-1160 applyAdvance; expectedAdvance :997;
// labels periodLabels :650-655): 4 → Q, 2 → H, otherwise P; then FT.
import { START, idOf, type SportStreamGenerator, type StreamEvent } from "./types.ts";

export function periodLabels(count: number): string[] {
  const prefix = count === 4 ? "Q" : count === 2 ? "H" : "P";
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

interface PeriodCfg { periods: { count: number } }

export const periodGenerator: SportStreamGenerator = {
  sportKeys: ["hockey", "icehockey"],
  decided(req) {
    const labels = periodLabels((req.cfg as PeriodCfg).periods.count);
    const advances: StreamEvent[] = [...labels.slice(1), "FT"].map((to) => ({ type: `${req.sportKey}.period.advance`, payload: { to } }));
    // A draw is only requested where supportsDraws is true (overtime and
    // shootout null, period/kernel.ts:2644), so a level FT is terminal there.
    const goals: StreamEvent[] = req.outcome.kind === "draw" ? [] : [{ type: `${req.sportKey}.goal`, payload: { by: idOf(req, req.outcome.winner) } }];
    return [START, ...goals, ...advances];
  },
};
