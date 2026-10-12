// W2b Task 4 (spec §5.2 "Abandon change"; plan D8, D16; Appendix A FB/HK/IH-AB-1, CK-AB-1/2, CA-AB-1, GN-AB-1). What an
// abandoned match folds to, per sport. Expectations are the rule rows, written out.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { DRAW_KINDS } from "../core/types.ts";
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
/** The award policy on a cfg where a draw STANDS: the default, or else the first declared variant that takes one (the
 *  sport's `supportsDraws` in a league). Ice hockey's default (iihf) configures overtime and a shootout, so its level
 *  abandon has no result there (R16-3, below); FB-AB-1's draw is judged where the sport takes a draw at all. */
function awardWhereDrawStands(key: string): Record<string, unknown> {
  const m = mod(key);
  const candidates = [{}, ...Object.values(m.variants)] as Record<string, unknown>[];
  const raw = candidates.find((c) => {
    const p = m.configSchema.safeParse({ ...c, abandonPolicy: "award" });
    return p.success && m.supportsDraws(p.data as never, "league");
  });
  if (raw === undefined) throw new Error(`${key}: no cfg takes a draw - FB-AB-1's level half has nothing to judge`);
  return { ...raw, abandonPolicy: "award" };
}

/** FB-AB-1 / HK-AB-1 / IH-AB-1, the award policy: the leader wins with the real score; level is a draw with it (D8). */
function expectAwardPolicyAbandon(key: string, goalType: string) {
  const award = awardWhereDrawStands(key);
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

// W2b Task 16, controller ruling R16-3. FB-AB-1 (which HK-AB-1 and IH-AB-1 inherit) gives a level award-policy abandon a
// draw in draw kinds only, and X-AB-1 keeps a match with no result out of the table, flagged for replay or settle. So
// where the cfg refuses a draw (`supportsDraws` false: an overtime or a shootout is configured), a level award-policy
// abandon folds to NO result, flagged for replay, as the replay policy's does. It folded to a draw, which the server
// then refused 422 DRAW_NOT_ALLOWED: the organiser could not record the abandon at all (the truth run's IIHF cell).
// Swept over every declared variant of every module that keeps the award policy, against every draw kind - the
// engine's own declarations (`variants`, `configSchema`, `supportsDraws`, `DRAW_KINDS`), never a typed list.
describe("R16-3, ruling 117 (HK-AB-1, IH-AB-1): a level award-policy abandon where the cfg refuses a draw has no result", () => {
  const CASES = builtinModules.flatMap((m) =>
    Object.entries(m.variants).flatMap(([variant, declared]) => {
      const raw = { ...(declared as Record<string, unknown>), abandonPolicy: "award" };
      const parsed = m.configSchema.safeParse(raw);
      return parsed.success && (parsed.data as { abandonPolicy?: unknown }).abandonPolicy === "award" ? [{ m, variant, raw, cfg: parsed.data }] : [];
    }),
  );
  /** Whether the cfg takes a draw in a draw kind. The fold cannot see the stage kind, so the sport's answer must be the
   *  same in every draw kind - asserted, not assumed. */
  const drawStands = (c: (typeof CASES)[number]): boolean => {
    const answers = [...DRAW_KINDS].map((k) => c.m.supportsDraws(c.cfg as never, k));
    expect(new Set(answers).size, `${c.m.key}/${c.variant}: supportsDraws differs between draw kinds`).toBe(1);
    return answers[0]!;
  };
  const level = (key: string): Spec => [["core.start"], [`${key}.goal`, { by: H }], [`${key}.goal`, { by: A }], ["core.abandon", { reason: "floodlights" }]];

  it("the sweep is not vacuous: both halves are reached, and the truth run's cell (ice hockey's iihf) is a refusing one", () => {
    const refusing = CASES.filter((c) => !drawStands(c)).map((c) => `${c.m.key}/${c.variant}`);
    const standing = CASES.filter((c) => drawStands(c)).map((c) => `${c.m.key}/${c.variant}`);
    const counted = `${CASES.length} award-policy cfgs: ${refusing.length} refuse a draw (${refusing.join(", ")}), ${standing.length} take one (${standing.join(", ")})`;
    expect(refusing.length, counted).toBeGreaterThan(0);
    expect(standing.length, counted).toBeGreaterThan(0);
    expect(refusing.length + standing.length, counted).toBe(CASES.length);
    expect(refusing).toContain("icehockey/iihf");
  });

  it("level, where the cfg refuses a draw: no outcome, phase abandoned, flagged for replay - in every draw kind; where it takes one, a draw with the real score", () => {
    let refused = 0;
    let drawn = 0;
    for (const c of CASES) {
      const r = fold(c.m.key, c.raw, level(c.m.key));
      const stands = drawStands(c);
      for (const kind of DRAW_KINDS) {
        const name = `${c.m.key}/${c.variant} ${kind}`;
        if (stands) {
          expect(r.outcome, name).toEqual({ kind: "draw" });
          if (r.outcome === null) throw new Error(`${name}: no outcome to credit`);
          const [home, away] = r.m.standingsDelta(r.outcome, r.cfg as never, { kind }, r.f.state);
          expect([home.drawn, away.drawn, home.metrics.gf, away.metrics.gf], name).toEqual([1, 1, 1, 1]);
          drawn++;
        } else {
          expect([r.outcome, r.state.phase, r.state.replayFlagged], name).toEqual([null, "abandoned", true]);
          refused++;
        }
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(drawn).toBeGreaterThan(0);
    expect(refused + drawn).toBe(CASES.length * DRAW_KINDS.size);
  });

  it("the negative pair, and the sequence: a LEADER's abandon still wins on the real score where draws are refused; voiding the level abandon resumes play", () => {
    let checked = 0;
    for (const c of CASES.filter((x) => !drawStands(x))) {
      const name = `${c.m.key}/${c.variant}`;
      const led = fold(c.m.key, c.raw, [["core.start"], [`${c.m.key}.goal`, { by: H }], [`${c.m.key}.goal`, { by: H }], [`${c.m.key}.goal`, { by: A }], ["core.abandon", { reason: "floodlights" }]]);
      expect(led.outcome, name).toEqual({ kind: "win", winner: H, loser: A, method: "abandoned" });
      const spec = level(c.m.key);
      const resumed = fold(c.m.key, c.raw, [...spec, ["core.void", {}, `e-${spec.length}`]]);
      expect([resumed.outcome, resumed.state.phase === "abandoned", resumed.state.replayFlagged], name).toEqual([null, false, false]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // T16 review m2: every declared variant with an overtime also has a shoot-out, so the sweep above cannot tell
  // `drawStands`' overtime conjunct from its shoot-out one. These are organiser cfgs no variant declares - the ones
  // supports-draws.test.ts's X-DR-1 house sweep uses - and the expectation is the rule row's, never `supportsDraws`
  // (which reads the same `drawStands`, so a mutant would move both): FIH and IIHF draws stand only where NO decider is
  // configured (hockey/DOMAIN.md:59, icehockey/DOMAIN.md:74). One-line reason for two sports: only the period sports
  // have the overtime conjunct.
  it("the overtime half: an overtime with no shoot-out refuses a draw, so the level abandon has no result; no decider at all is a draw", () => {
    const OT = { kind: "sudden_death", minutes: 5 };
    const HOUSE = [
      { name: "overtime, no shoot-out", raw: { overtime: OT, shootout: null }, ruleTakesDraw: false },
      { name: "no decider", raw: { overtime: null, shootout: null }, ruleTakesDraw: true },
    ];
    let refused = 0;
    let drawn = 0;
    for (const key of ["hockey", "icehockey"]) {
      for (const h of HOUSE) {
        const name = `${key} ${h.name}`;
        const r = fold(key, { abandonPolicy: "award", ...h.raw }, level(key));
        expect((r.cfg as { abandonPolicy?: unknown }).abandonPolicy, `${name}: the award policy parsed`).toBe("award");
        if (h.ruleTakesDraw) {
          expect(r.outcome, name).toEqual({ kind: "draw" });
          drawn++;
        } else {
          expect([r.outcome, r.state.phase, r.state.replayFlagged], name).toEqual([null, "abandoned", true]);
          refused++;
        }
      }
    }
    expect([refused, drawn]).toEqual([2, 2]);
  });
});
