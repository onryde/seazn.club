// W2b Task 4 (spec §5.2 "Abandon change"; plan D8, D16; Appendix A FB/HK/IH-AB-1, CK-AB-1/2, CA-AB-1, GN-AB-1). What an
// abandoned match folds to, per sport. Expectations are the rule rows, written out.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const mod = (k: string) => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const H = "H";
const A = "A";
type Spec = Array<[string, unknown?, string?]>;
const evs = (spec: Spec): EventEnvelope[] => spec.map(([t, p, voids], i) => makeEnvelope(i + 1, { type: t, payload: p ?? {} }, voids));
function fold(key: string, raw: Record<string, unknown>, spec: Spec) {
  const m = mod(key);
  const base = m.configSchema.safeParse({}).success ? {} : (Object.values(m.variants)[0] as Record<string, unknown>);
  const cfg = m.configSchema.parse({ ...base, ...raw });
  const f = foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), evs(spec));
  return { m, cfg, f, outcome: outcomeOf(m as never, f as never), state: f.state as Record<string, unknown> };
}

const GOAL_SPORTS = [["football", "football.goal"], ["hockey", "hockey.goal"], ["icehockey", "icehockey.goal"]] as const;
/** FB-AB-1 / HK-AB-1 / IH-AB-1, the award policy: the leader wins with the real score; level is a draw with it (D8). */
function expectAwardPolicyAbandon(key: string, goalType: string) {
  const award = { abandonPolicy: "award" };
  const led = fold(key, award, [["core.start"], [goalType, { by: H }], [goalType, { by: H }], [goalType, { by: A }], ["core.abandon", { reason: "floodlights" }]]);
  expect(led.outcome, `${key} 2-1`).toEqual({ kind: "win", winner: H, loser: A, method: "abandoned" });
  const level = fold(key, award, [["core.start"], [goalType, { by: H }], [goalType, { by: A }], ["core.abandon", { reason: "floodlights" }]]);
  expect(level.outcome, `${key} 1-1`).toEqual({ kind: "draw" });
  // The real score stands in the table, in a draw kind.
  const [home, away] = level.m.standingsDelta(level.outcome!, level.cfg as never, { kind: "league" } as never, level.f.state);
  expect([home.metrics.gf, home.metrics.ga, away.metrics.gf, away.metrics.ga, home.drawn, away.drawn], `${key} level table`).toEqual([1, 1, 1, 1, 1, 1]);
  const [winner] = led.m.standingsDelta(led.outcome!, led.cfg as never, { kind: "league" } as never, led.f.state);
  expect([winner.won, winner.metrics.gf, winner.metrics.ga], `${key} leader table`).toEqual([1, 2, 1]);
}

describe("abandon results per sport (spec §5.2; D8, D16)", () => {
  it("empty case first: the replay policy (the default) still leaves every goal sport undecided", () => {
    let checked = 0;
    for (const [key, goalType] of GOAL_SPORTS) {
      const r = fold(key, {}, [["core.start"], [goalType, { by: H }], ["core.abandon", { reason: "rain" }]]);
      expect(r.outcome, key).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("FB-AB-1: football award-policy abandon — the leader wins (method abandoned), level is a draw with the real score", () =>
    expectAwardPolicyAbandon("football", "football.goal"));
  it("HK-AB-1: hockey award-policy abandon — the same as FB-AB-1", () => expectAwardPolicyAbandon("hockey", "hockey.goal"));
  it("IH-AB-1: ice hockey award-policy abandon — the same as FB-AB-1", () => expectAwardPolicyAbandon("icehockey", "icehockey.goal"));

  // A six-a-side chase (cricket.test.ts "decided the RIGHT way round"): 60 balls a side ⇒ R1 = R2 = res(10, 0) = 32.1.
  // H makes 80; A is 45/4 after 30 balls (5 overs, the minimum) when rain ends play. 4 of 5 wickets down = column 8 ⇒
  // remaining res(5, 8) = 9.4, used = 32.1 − 9.4 = 22.7, par = ⌊80 × 22.7/32.1⌋ = 56 ⇒ H by 11.
  const SIXES = { playersPerSide: 6, ballsPerInnings: 60, maxOversPerBowler: 2, dls: { enabled: true, edition: "standard" } };
  it("CK-AB-1: cricket abandon after the minimum overs with a DLS result counts as that win", () => {
    const r = fold("cricket", SIXES, [
      ["core.start"],
      ["cricket.innings.summary", { runs: 80, wickets: 5, legalBalls: 60 }],
      ["cricket.innings.summary", { runs: 45, wickets: 4, legalBalls: 30, partial: true }],
      ["core.abandon", { reason: "rain" }],
    ]);
    expect(r.outcome).toMatchObject({ kind: "win", winner: H, method: "dls" });
    const [home, away] = r.m.standingsDelta(r.outcome!, r.cfg as never, { kind: "league" } as never, r.f.state);
    const pts = (r.cfg as { points: { win: number; loss: number } }).points;
    expect([home.won, home.points, away.lost, away.points]).toEqual([1, pts.win, 1, pts.loss]);
  });
  it("CK-AB-2: cricket abandon before the minimum overs is no result — 1 point each and an NR entry (ICC 16.10.3)", () => {
    const r = fold("cricket", SIXES, [
      ["core.start"],
      ["cricket.innings.summary", { runs: 80, wickets: 5, legalBalls: 60 }],
      ["cricket.innings.summary", { runs: 10, wickets: 0, legalBalls: 12, partial: true }],
      ["core.abandon", { reason: "rain" }],
    ]);
    expect(r.outcome).toEqual({ kind: "no_result" });
    const [home, away] = r.m.standingsDelta(r.outcome!, r.cfg as never, { kind: "league" } as never, r.f.state);
    for (const d of [home, away]) {
      expect([d.played, d.won, d.drawn, d.lost, d.points, d.metrics.no_results]).toEqual([1, 0, 0, 0, 1, 1]);
    }
  });
  it("CA-AB-1: carrom abandon is a replay — outcome null, phase abandoned, no shared points", () => {
    const r = fold("carrom", {}, [["core.start"], ["carrom.board.summary", { winner: H, opponentCoinsLeft: 5, queenTo: null }], ["core.abandon", { reason: "power cut" }]]);
    expect(r.outcome).toBeNull();
    expect(r.state.phase).toBe("abandoned");
  });
  it("GN-AB-1: generic abandon is a replay — outcome null, phase abandoned; voiding the abandon resumes play", () => {
    const r = fold("generic", {}, [["core.start"], ["generic.score", { by: H, points: 2 }], ["core.abandon", { reason: "rain" }]]);
    expect(r.outcome).toBeNull();
    expect(r.state.phase).toBe("abandoned");
    const resumed = fold("generic", {}, [["core.start"], ["generic.score", { by: H, points: 2 }], ["core.abandon", { reason: "rain" }], ["core.void", {}, "e-3"]]);
    expect(resumed.outcome).toBeNull();
    expect(resumed.state.phase).toBe("live");
    expect(resumed.state.running).toEqual({ home: 2, away: 0 });
  });
});
