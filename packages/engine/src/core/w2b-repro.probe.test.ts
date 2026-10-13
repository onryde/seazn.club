// W2b Task 1 — reproduction probes (spec §8.2). Each `it` asserts the Appendix A answer, so on main each is RED; the red
// is recorded with its gap id in TR/w2b-repro/ before any fix. It was gated (W2B_REPRO=1) so the build's intermediate
// pushes stayed green while every fixing task ran its probes green; Task 16 removed the gate, and this file now runs as a
// regression suite.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "./events.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import type { AnySportModule } from "../sport/module.ts";

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
/** Folds `build(H, A)` for `key` at `cfgIn` (parsed by the module's own schema) and returns the outcome and the [home, away] deltas. */
function play(key: string, cfgIn: unknown, build: (H: string, A: string) => EventEnvelope[], stage = "league") {
  const m = mod(key);
  const cfg = m.configSchema.parse(cfgIn ?? {});
  const l = defaultLineupPair(m.positions);
  const H = l.home.entrantId;
  const A = l.away.entrantId;
  const folded = foldMatchWithStoppage(m as never, cfg as never, l, build(H, A));
  const outcome = outcomeOf(m as never, folded as never);
  const deltas = outcome === null ? null : m.standingsDelta(outcome, cfg as never, { kind: stage } as never, folded.state);
  return { H, A, cfg: cfg as Record<string, unknown>, outcome, deltas };
}
const walkover = (by: (H: string, A: string) => string) => (H: string, A: string) => [ev(1, "core.forfeit", { by: by(H, A), reason: "walkover" })];

describe("W2b reproduction probes (engine)", () => {
  it("H-13: a hockey walkover credits 5-0 (FIH GTR Reg 13.1), not 3-0", () => {
    const r = play("hockey", {}, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ gf: 5, ga: 0 }); // HK-WO-1
  });
  it("F-16 / H-14 / I-16 / SC-S4: a side further down than the awarded score that retires keeps the real score (FDC 28.1; FB-RT-1, HK-RT-1, IH-RT-1)", () => {
    // Appendix A: awarded football 3, hockey 5, ice hockey 5; the real margin is the awarded one + 2, so it is worse for the offender.
    const AWARDED: Record<string, number> = { football: 3, hockey: 5, icehockey: 5 };
    let checked = 0;
    for (const [key, awarded] of Object.entries(AWARDED)) {
      const goals = awarded + 2;
      const r = play(key, {}, (H, A) => [
        ev(1, "core.start"),
        ...Array.from({ length: goals }, (_, i) => ev(2 + i, `${key}.goal`, { by: A })), // FootballGoal / PeriodGoal {by}
        ev(2 + goals, "core.forfeit", { by: H, reason: "retired" }),
      ]);
      expect(r.deltas?.[1].metrics, key).toMatchObject({ gf: goals, ga: 0 });
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("SC-S3: a 3-set volleyball walkover credits the winner 2-0 sets, each 25-0 (FIVB 6.4.1, VB-WO-1)", () => {
    const r = play("volleyball", { bestOf: 3 }, walkover((_H, A) => A));
    const setsToWin = Math.ceil(3 / 2);
    expect(r.deltas?.[0].metrics).toMatchObject({ sets_won: setsToWin, sets_lost: 0, points_won: setsToWin * 25, points_lost: 0 });
  });
  it("SC-S6: a double walkover is its own outcome in every sport (X-DW-1)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const r = play(m.key, Object.values(m.variants)[0] ?? {}, () => [ev(1, "core.forfeit", { by: "both", reason: "walkover" })]); // first declared variant (generic's {} does not parse)
      expect(r.outcome, m.key).toEqual({ kind: "double_walkover" });
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("B-7: a chess walkover is recordable before the game starts (FIDE 6.7.1, BG-WO-2)", () => {
    const r = play("boardgame", {}, walkover((_H, A) => A));
    expect(r.outcome).toMatchObject({ kind: "award", winner: r.H });
  });
  it("B-9: a chess double forfeit is a double walkover in a league (BG-DW-1)", () => {
    const r = play("boardgame", {}, () => [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]);
    expect(r.outcome).toEqual({ kind: "double_walkover" });
  });
  it("B-10: a chess double forfeit is a double walkover in a knockout, never held (BG-DW-1)", () => {
    const r = play("boardgame", { tiebreak: true }, () => [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })], "knockout");
    expect(r.outcome).toEqual({ kind: "double_walkover" });
  });
  it("C-6: a carrom abandon is a replay — no outcome, no shared points (CA-AB-1)", () => {
    const r = play("carrom", {}, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]);
    expect(r.outcome).toBeNull();
  });
  it("CR-10: a cricket walkover charges the defaulter its full quota at 0 runs and leaves the winner's NRR alone (CK-WO-1)", () => {
    const r = play("cricket", { ballsPerInnings: 120 }, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 }); // the winner's NRR is unaffected
    expect(r.deltas?.[1].metrics).toMatchObject({ runs_for: 0, balls_faced_eff: 120 }); // the defaulter is charged its full quota
  });
  it("SC-S3-TN: a tennis walkover credits straight sets for set % and excludes the match's games (ATP 4.01 C.4, TN-WO-1)", () => {
    const r = play("tennis", {}, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ games_won: 0, games_lost: 0 });
    expect((r.deltas?.[0].metrics.sets_won ?? 0) > 0).toBe(true);
  });
});
