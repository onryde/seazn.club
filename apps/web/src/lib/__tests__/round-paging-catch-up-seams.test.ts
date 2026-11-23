// W5 follow-ups C, review C2: a late entrant's catch-up rounds (`rr-cu-…` ext keys, appended after the draw's last round) never
// move the frontier - on EVERY surface that pages. Each surface's own grouping is driven here with real ext keys, so the flag is
// proved to reach `planRounds` through the public Schedule (`pageSchedule`) and the organiser's run sheet (`windowRunSheet`); the
// hub's own seam is in `components/public-site/__tests__/hub-round-paging.test.tsx`. The sequence is the review's: a late entry,
// then one catch-up result, then every catch-up played - the real current and next rounds stay open throughout.
import { describe, expect, it } from "vitest";
import { pageSchedule } from "../schedule-paging";
import { windowRunSheet } from "../run-sheet-paging";
import { rrCatchUpExtKey } from "../roundrobin-late-entry";

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const DAY = 86_400_000;
let n = 0;
/** A 24-team single league (23 rounds of 12, 276 lines - over the paging line): rounds 1-9 played, round 10 part-played (the
 *  current round), 11-23 to come; plus `catchUps` appended rounds 24.. of one line each, `played` of them played. */
function scene(catchUps: number, played: number) {
  n = 0;
  const rows = [];
  const line = (round: number, status: string, at: number, ext: string | null) => ({
    id: `f${++n}`, stage_id: "lg", pool_id: null, round_no: round, seq_in_round: n, status, scheduled_at: new Date(at).toISOString(),
    outcome: status === "decided" ? { winner: "a" } : null, home_entrant_id: `h${n}`, away_entrant_id: `a${n}`, home_slot_label: null,
    away_slot_label: null, ext_key: ext,
  });
  for (let r = 1; r <= 23; r++) {
    for (let s = 1; s <= 12; s++) {
      const done = r < 10 || (r === 10 && s <= 6);
      rows.push(line(r, done ? "decided" : "scheduled", done ? NOW - (12 - r) * DAY : NOW + (r - 8) * DAY, null));
    }
  }
  for (let c = 0; c < catchUps; c++) {
    const done = c < played;
    rows.push(line(24 + c, done ? "decided" : "scheduled", done ? NOW - 2 * DAY : NOW + (20 + c) * DAY, rrCatchUpExtKey("", "catch_up_round", 24 + c, c + 1, 1)));
  }
  return rows;
}
const STEPS: [string, number][] = [["late entry, nothing played", 0], ["one catch-up result", 1], ["every catch-up played", 5]];

describe("C2: catch-up rounds never move the frontier, on every paging surface", () => {
  it("premise: the scene's catch-up lines carry the catch-up ext key, and the scene pages", () => {
    const rows = scene(5, 0);
    expect(rows.length).toBe(281);
    expect(rows.filter((f) => f.ext_key !== null).length).toBe(5);
  });

  it("the public Schedule (pageSchedule): rounds 10 and 11 stay open through the sequence", () => {
    let checked = 0;
    for (const [name, played] of STEPS) {
      const { groups } = pageSchedule(scene(5, played), { roundLabels: {}, stageOrder: { lg: 1 }, stageNames: { lg: "League" } });
      expect(groups.filter((g) => g.open).map((g) => g.roundNo), name).toEqual([10, 11]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("the organiser's run sheet (windowRunSheet): rounds 10 and 11 ship through the sequence", () => {
    let checked = 0;
    for (const [name, played] of STEPS) {
      const { shipped } = windowRunSheet(scene(5, played), [{ id: "lg", kind: "league" }], { held: new Set(), nowMs: NOW, matchMinutes: 60, tz: "UTC" });
      expect([...new Set(shipped.map((f) => f.round_no))].sort((a, b) => a - b), name).toEqual([10, 11]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
