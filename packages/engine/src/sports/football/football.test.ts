// Football goldens + conformance — spec 04 §1, PROMPT-04 §10.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { evalPadGate, type PadField, type PadSpec } from "../../sport/module.ts";
import { conformanceSuite, lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
// S6/#416 (W5) — deliberately NOT from the testkit barrel: conformance-pad.ts
// touches node:fs (DOMAIN.md presence), mirroring golden.ts's own exclusion
// (see cricket.test.ts, the reference wiring for this harness).
import { checkActionCoverage, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import {
  football,
  FOOTBALL_EVENT_SCHEMAS,
  FOOTBALL_TIEBREAKERS,
  padSpec,
  type FootballCfg,
  type FootballEv,
  type FootballState,
} from "./football.ts";
// R3.5/Task H — the shared shoot-out primitive `summary()` must agree with
// (see the new describe block below). Imported directly from the sibling
// module, the same relative path football.ts's own import uses, rather than
// through the barrel: this file already tests football.ts's internals
// directly (the `./football.ts` import above bypasses `./index.ts` too).
import { shootoutTally, type ShootoutKick } from "../period/shootout.ts";

// Direct module.apply calls need the module's payload union on the envelope.
const asFootball = (event: EventEnvelope) => event as EventEnvelope<FootballEv | CoreEv>;

// Catalog-valid 11 + a two-man bench for substitution tests.
function lineupWithBench(entrantId: string): LineupPair["home"] {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      { personId: `${entrantId}-b1`, slot: "bench", orderNo: 12 },
      { personId: `${entrantId}-b2`, slot: "bench", orderNo: 13 },
    ],
  };
}
const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };

const leagueCfg: FootballCfg = football.configSchema.parse({});
const knockoutCfg: FootballCfg = football.configSchema.parse({
  extraTime: { enabled: true, halfMinutes: 15 },
  shootout: true,
});
const league: StageCtx = { kind: "league" };
const group: StageCtx = { kind: "group" };
const knockout: StageCtx = { kind: "knockout" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

const fold = (cfg: FootballCfg, events: EventEnvelope[]) =>
  foldMatch(football, cfg, lineups, events);

// PROMPT-04 §10 (a) — league draw 1-1 ⇒ 1 pt each + metrics.
describe("football golden (a): league draw 1-1", () => {
  const events = stream(
    ["core.start"],
    ["football.goal", { by: "H", scorer: "H-p9", minute: 12 }],
    ["football.period", { phase: "HT" }],
    ["football.goal", { by: "A", minute: 71 }],
    ["football.period", { phase: "FT" }],
  );

  it("folds to a draw with the right summary", () => {
    const state = fold(leagueCfg, events);
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(football.summary(state).headline).toBe("1 — 1");
    expect(football.summary(state).detail).toMatchObject({
      periods: [
        { phase: "H1", home: 1, away: 0 },
        { phase: "H2", home: 0, away: 1 },
      ],
    });
  });

  it("pays 1 point and symmetric metrics to each side", () => {
    const state = fold(leagueCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home).toMatchObject({
      entrantId: "H",
      drawn: 1,
      points: 1,
      metrics: { gf: 1, ga: 1, gd: 0, yellow: 0, red: 0, fair_play: 0 },
    });
    expect(away).toMatchObject({ entrantId: "A", drawn: 1, points: 1, metrics: { gd: 0 } });
  });
});

// PROMPT-04 §10 (b) — knockout 0-0 → ET 1-1 → shootout 4-3, method 'shootout'.
describe("football golden (b): knockout decided on penalties", () => {
  const kick = (by: string, scored: boolean): [string, unknown] => [
    "football.shootout.kick",
    { by, scored },
  ];
  const events = stream(
    ["core.start"],
    ["football.period", { phase: "HT" }],
    ["football.period", { phase: "FT" }], // 0-0 ⇒ ET (extraTime.enabled)
    ["football.goal", { by: "H", minute: 97 }],
    ["football.period", { phase: "ET_HT" }],
    ["football.goal", { by: "A", minute: 113 }],
    ["football.period", { phase: "ET_FT" }], // 1-1 ⇒ SHOOTOUT
    kick("H", true),
    kick("A", true),
    kick("H", true),
    kick("A", true),
    kick("H", true),
    kick("A", true),
    kick("H", false),
    kick("A", false),
    kick("H", true),
    kick("A", false), // 4-3 after 5 kicks each
  );

  it("walks the full FT → ET → shootout machine", () => {
    const state = fold(knockoutCfg, events);
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "shootout" });
    expect(state.goals).toEqual({ home: 1, away: 1 }); // shootout kicks are not goals
    expect(football.summary(state).headline).toBe("1 — 1 (4–3 pens)");
  });

  it("keeps regulation points in knockout but honours the group SO split", () => {
    const state = fold(knockoutCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, knockoutCfg, knockout, state);
    expect([home.points, away.points]).toEqual([3, 0]);

    // spec 04 §1.4 — youth-cup convention SO win 2 / SO loss 1.
    const splitCfg = football.configSchema.parse({
      extraTime: { enabled: true, halfMinutes: 15 },
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
    });
    const splitState = foldMatch(football, splitCfg, lineups, events);
    const [h2, a2] = football.standingsDelta(splitState.outcome!, splitCfg, group, splitState);
    expect([h2.points, a2.points]).toEqual([2, 1]);
    expect(football.declaredPointsSets(splitCfg)).toContain(3);
  });

  it("F21 (R3.5/Task I): only one of shootoutWin/shootoutLoss set — the split does not fire, flat win/loss applies", () => {
    // The engine's own gate (standingsDelta, football.ts) requires BOTH
    // fields defined before it splits. The golden above already covers
    // "both set" (F19) and "neither set" (F20) but never the asymmetric
    // case — exactly the shape apps/web's new match-rules.tsx fields can
    // produce if an organiser fills in only one of the pair.
    const onlyWinCfg = football.configSchema.parse({
      extraTime: { enabled: true, halfMinutes: 15 },
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2 },
    });
    const onlyWinState = foldMatch(football, onlyWinCfg, lineups, events);
    const [hw, aw] = football.standingsDelta(onlyWinState.outcome!, onlyWinCfg, group, onlyWinState);
    expect([hw.points, aw.points]).toEqual([3, 0]);

    const onlyLossCfg = football.configSchema.parse({
      extraTime: { enabled: true, halfMinutes: 15 },
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutLoss: 1 },
    });
    const onlyLossState = foldMatch(football, onlyLossCfg, lineups, events);
    const [hl, al] = football.standingsDelta(onlyLossState.outcome!, onlyLossCfg, group, onlyLossState);
    expect([hl.points, al.points]).toEqual([3, 0]);
  });

  it("enforces kick alternation and early decision arithmetic", () => {
    const early = stream(
      ["core.start"],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.goal", { by: "H" }],
      ["football.goal", { by: "A" }],
      ["football.period", { phase: "ET_HT" }],
      ["football.period", { phase: "ET_FT" }],
      kick("H", true),
      kick("A", false),
      kick("H", true),
      kick("A", false),
      kick("H", true), // 3-0 after 3v2: away max = 0+3 ⇒ not yet decided
    );
    const undecided = fold(knockoutCfg, early);
    expect(football.outcome(undecided)).toBeNull();

    const decided = fold(knockoutCfg, [
      ...early,
      makeEnvelope(early.length, { type: "football.shootout.kick", payload: { by: "A", scored: false } }),
    ]); // 3-0 after 3v3: away max = 0+2 < 3 ⇒ decided
    expect(football.outcome(decided)).toMatchObject({ kind: "win", winner: "H" });

    expect(() =>
      fold(knockoutCfg, [
        ...early,
        makeEnvelope(early.length, { type: "football.shootout.kick", payload: { by: "H", scored: true } }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" })); // H kicked out of turn
  });
});

// R3.5/Task H (case F22) — `summary()` must not fork the shoot-out tally.
// `shootout.ts`'s own doc explains why this must be the ONE tally:
// `period/kernel.ts` already reads `shootoutTally` for its own summary, and
// this was the THIRD hand-rolled copy — the inline `reduce` this wave found
// counted a `void: true` kick's `scored` value, which `shootoutTally` does
// not (a void kick is a retake pending; it happened, but it counts toward
// neither `taken` nor `scored`).
//
// A PARITY guard, not a reachable-state test: `FootballShootoutKick`'s own
// schema (this file, above) carries no `void` field, and `applyShootoutKick`
// never writes one — no v3 football surface can record one today. `void` is
// this shared primitive's OWN doc admits belongs to the OTHER sports that
// reuse it (IIHF GWS / FIH App 12 foul outcomes, hockey/DOMAIN.md). The state
// literal below is therefore built directly rather than folded through
// `football.apply`, on purpose: proving `summary()`'s CODE does not fork the
// tally does not require a state the fold can currently produce.
describe("football golden (h): summary()'s pens tally IS shootoutTally, never a second copy (F22)", () => {
  // A real SHOOTOUT-phase fold for everything BUT the kicks — goals, periods,
  // squads all come from a genuine `foldMatch` walk; only `shootout.kicks`
  // is substituted per case below.
  const base: FootballState = fold(
    knockoutCfg,
    stream(
      ["core.start"],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }],
      ["football.period", { phase: "ET_FT" }],
    ),
  );

  // Object rows, deliberately — `it.each` SPREADS an array-shaped row as
  // POSITIONAL arguments rather than binding it to one parameter (a real
  // vitest/jest gotcha this test tripped over first: `it.each([[], [k1]])`
  // called its callback with `kicks` bound to the row's first ELEMENT, or to
  // `undefined` for an empty row, never to the row itself). A `{label,
  // kicks}` table sidesteps it entirely, and names each case besides.
  const KICK_CASES: readonly { label: string; kicks: ShootoutKick[] }[] = [
    { label: "zero kicks", kicks: [] },
    { label: "one kick", kicks: [{ side: "home", scored: true }] },
    {
      label: "a full alternating sequence",
      kicks: [
        { side: "home", scored: true },
        { side: "away", scored: false },
        { side: "home", scored: true },
        { side: "away", scored: true },
      ],
    },
    {
      // The case that fails on the inline `reduce`: a void kick's `scored`
      // must reach neither the tally nor the headline suffix.
      label: "a sequence carrying a void kick",
      kicks: [
        { side: "home", scored: true },
        { side: "home", scored: true, void: true },
        { side: "away", scored: false },
      ],
    },
  ];

  it.each(KICK_CASES)("summary().detail.shootout equals shootoutTally(kicks) — $label", ({ kicks }) => {
    const state: FootballState = { ...base, shootout: { kicks } };
    const detail = football.summary(state).detail as { shootout?: { home: number; away: number } } | undefined;
    expect(detail?.shootout).toEqual(shootoutTally(kicks));
  });

  it("the void kick's `scored` must not inflate the headline suffix either", () => {
    const kicks: ShootoutKick[] = [
      { side: "home", scored: true },
      { side: "home", scored: true, void: true }, // would double-count home to 2 if summary forked
      { side: "away", scored: false },
    ];
    const state: FootballState = { ...base, shootout: { kicks } };
    expect(football.summary(state).headline).toBe("0 — 0 (1–0 pens)");
  });
});

// PROMPT-04 §10 (c) — forfeit ⇒ award with cfg.awardScore goals.
describe("football golden (c): forfeit award 3-0", () => {
  it("awards the tie to the opponent with the configured score", () => {
    const state = fold(leagueCfg, stream(["core.start"], ["core.forfeit", { by: "A", reason: "no-show" }]));
    expect(state.outcome).toEqual({
      kind: "award",
      winner: "H",
      score: { home: 3, away: 0 },
    });
    expect(football.summary(state).headline).toBe("3 — 0");
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 3, metrics: { gf: 3, ga: 0, gd: 3 } });
    expect(away).toMatchObject({ lost: 1, points: 0, metrics: { gf: 0, ga: 3, gd: -3 } });
  });
});

// PROMPT-04 §10 (d) — own goal + red card fold to the right summary and
// FIFA fair-play points (Y −1, 2nd-Y −3, direct R −4, Y+R −5).
describe("football golden (d): own goal + cards", () => {
  const events = stream(
    ["core.start"],
    ["football.goal", { by: "H", scorer: "H-p3", ownGoal: true, minute: 23 }], // credits A
    ["football.card", { by: "H", person: "H-p5", color: "yellow", minute: 30 }],
    ["football.card", { by: "H", person: "H-p5", color: "second_yellow", minute: 44 }],
    ["football.period", { phase: "HT" }],
    ["football.card", { by: "A", person: "A-p4", color: "red", minute: 60 }],
    ["football.period", { phase: "FT" }],
  );

  it("credits the own goal to the opponent and decides the match", () => {
    const state = fold(leagueCfg, events);
    expect(state.goals).toEqual({ home: 0, away: 1 });
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(state.squads.home.sentOff).toEqual(["H-p5"]);
  });

  it("computes card metrics on the FIFA fair-play scale", () => {
    const state = fold(leagueCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home.metrics).toMatchObject({ gf: 0, ga: 1, gd: -1, yellow: 2, red: 1, fair_play: -3 });
    expect(away.metrics).toMatchObject({ gf: 1, ga: 0, gd: 1, yellow: 0, red: 1, fair_play: -4 });
  });

  it("scores yellow + direct red to one player as −5", () => {
    const state = fold(
      leagueCfg,
      stream(
        ["core.start"],
        ["football.card", { by: "H", person: "H-p5", color: "yellow" }],
        ["football.card", { by: "H", person: "H-p5", color: "red" }],
        ["football.goal", { by: "A" }],
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }],
      ),
    );
    const [home] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home.metrics.fair_play).toBe(-5);
  });
});

describe("football state machine guards (spec 04 §1.3)", () => {
  it("rejects a goal after FT when no extra time is configured", () => {
    const done = fold(leagueCfg, stream(["core.start"], ["football.goal", { by: "H" }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(() =>
      football.apply(done, asFootball(makeEnvelope(9, { type: "football.goal", payload: { by: "H" } }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("keeps a level knockout fixture undecided at FT (ET path pending)", () => {
    const state = fold(knockoutCfg, stream(["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(football.outcome(state)).toBeNull();
    expect(state.phase).toBe("ET_H1");
    // …and finalize is refused while undecided.
    expect(() =>
      football.apply(state, asFootball(makeEnvelope(9, { type: "core.finalize", payload: {} }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("goes straight to a shootout when shootout is on but ET is off", () => {
    const cfg = football.configSchema.parse({ shootout: true });
    const state = fold(cfg, stream(["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(state.phase).toBe("SHOOTOUT");
  });

  it("rejects out-of-order period markers", () => {
    expect(() => fold(leagueCfg, stream(["core.start"], ["football.period", { phase: "FT" }]))).toThrowError(
      expect.objectContaining({ code: "WRONG_PHASE" }),
    );
  });

  it("validates substitutions against the pitch and the bench", () => {
    const base = stream(["core.start"]);
    const sub = (payload: unknown) =>
      fold(leagueCfg, [...base, makeEnvelope(1, { type: "football.sub", payload })]);
    // S3/W4b (#426) — the refusals below are the variant's rules, so they are
    // asserted through the WRITE path (`strictFromSeq`), which is where a
    // scorer can still fix the entry. The one structural refusal — a player
    // who was never on the field — holds on both paths.
    const subStrict = (payload: unknown) =>
      foldMatch(football, leagueCfg, lineups, [...base, makeEnvelope(1, { type: "football.sub", payload })], {
        strictFromSeq: 0,
      });
    expect(sub({ by: "H", off: "H-p1", on: "H-b1" }).squads.home.onPitch).toContain("H-b1");
    expect(() => sub({ by: "H", off: "H-b2", on: "H-b1" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() => subStrict({ by: "H", off: "H-p1", on: "A-b1" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // A substituted-off player may not return.
    const twice = [
      ...base,
      makeEnvelope(1, { type: "football.sub", payload: { by: "H", off: "H-p1", on: "H-b1" } }),
      makeEnvelope(2, { type: "football.sub", payload: { by: "H", off: "H-b1", on: "H-p1" } }),
    ];
    expect(() =>
      foldMatch(football, leagueCfg, lineups, twice, { strictFromSeq: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("flags an abandoned fixture for replay without an outcome", () => {
    const state = fold(leagueCfg, stream(["core.start"], ["football.goal", { by: "H" }], ["core.abandon", { reason: "floodlights" }]));
    expect(football.outcome(state)).toBeNull();
    expect(state.replayFlagged).toBe(true);
    expect(football.summary(state).detail).toMatchObject({ abandoned: true });
  });

  it("awards an abandoned fixture to the leader under the award policy", () => {
    const cfg = football.configSchema.parse({ abandonPolicy: "award" });
    const leader = fold(cfg, stream(["core.start"], ["football.goal", { by: "A" }], ["core.abandon", { reason: "crowd" }]));
    expect(football.outcome(leader)).toMatchObject({ kind: "award", winner: "A" });
    const level = fold(cfg, stream(["core.start"], ["core.abandon", { reason: "crowd" }]));
    expect(football.outcome(level)).toEqual({ kind: "no_result" });
  });
});

describe("football contract declarations", () => {
  it("exports both official tiebreaker presets, defaulting to fifa2026", () => {
    expect(FOOTBALL_TIEBREAKERS.fifa2026.slice(0, 4)).toEqual([
      "points",
      "h2h_points",
      "h2h_diff",
      "h2h_for",
    ]);
    expect(FOOTBALL_TIEBREAKERS.classic.slice(0, 3)).toEqual(["points", "diff", "for"]);
    expect(football.defaultTiebreakers).toEqual(FOOTBALL_TIEBREAKERS.fifa2026);
  });

  it("supports draws in league/group but never in eliminations", () => {
    expect(football.supportsDraws(leagueCfg, "league")).toBe(true);
    expect(football.supportsDraws(leagueCfg, "group")).toBe(true);
    expect(football.supportsDraws(knockoutCfg, "knockout")).toBe(false);
    expect(football.supportsDraws(knockoutCfg, "double_elim")).toBe(false);
  });

  it("declares point totals {3, 2} (+ SO split total when configured)", () => {
    expect([...football.declaredPointsSets(leagueCfg)].sort()).toEqual([2, 3]);
  });
});

// PROMPT-04 acceptance — conformance green under both configurations.
conformanceSuite(football, { cfg: {}, label: "league" });
conformanceSuite(football, {
  cfg: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
  label: "knockout",
  stageCtxs: [{ kind: "knockout" }, { kind: "group" }],
});
// S5/#431 — quarters instead of halves (mini-soccer). No explicit `lineups`:
// `teamSize: 7` on the preset means the default must resolve against ITS OWN
// catalog (`resolvePositions`), which an 11-a-side-sized lineup would fail
// "accepts the conformance lineups against its own catalog" against.
conformanceSuite(football, { cfg: football.variants["mini-soccer"], label: "mini-soccer" });

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec conformance. Football owns goals/cards/subs/period
// flow (incl. mini-soccer quarters, S5/#431); cricket is the reference/pilot
// module this harness was proven against first.
// ---------------------------------------------------------------------------

// Randomises the cfg knobs padSpec's own bounds/inclusion logic actually
// reads, so the never-throws/determinism property gets more than the named
// presets: the halves/quarters split, extra time (both keys — the inner
// object is required whole, no per-field default), the shoot-out panel's
// cfg-only inclusion, and the half length the sin-bin `minutes` bound reads.
// `FootballCfg` has no `.refine()`, so this practically never gets skipped as
// "not a cfg this module accepts".
const footballCfgPerturbations = fc.record(
  {
    halves: fc.constantFrom(2 as const, 4 as const),
    extraTime: fc.record({ enabled: fc.boolean(), halfMinutes: fc.integer({ min: 5, max: 30 }) }),
    shootout: fc.boolean(),
    halfMinutes: fc.integer({ min: 5, max: 60 }),
  },
  { requiredKeys: [] },
);

// No explicit `lineups` on ANY of these — see the mini-soccer `conformanceSuite`
// call above for why: `padSpecConformanceSuite` must resolve its own lineup
// pair against each cfg's OWN catalog (`resolvePositions`), and a fixed
// 11-a-side lineup would silently mismatch `teamSize: 7`.
padSpecConformanceSuite(football, {
  cfg: {},
  label: "11-a-side",
  numRuns: 150,
  cfgPerturbations: footballCfgPerturbations,
});
padSpecConformanceSuite(football, {
  cfg: football.variants["mini-soccer"],
  label: "mini-soccer",
  numRuns: 100,
});
padSpecConformanceSuite(football, {
  cfg: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
  label: "knockout (shoot-out)",
  numRuns: 100,
});

// (a), the module-level half: `football.shootout.kick` can only ever be
// reached from a cfg with `shootout: true` — `applyShootoutKick` refuses it
// in every other phase, and no fixture reaches phase "SHOOTOUT" unless
// `cfg.shootout` is set (`resolveFullTime`). None of football's own named
// `variants` (11-a-side/youth/small-sided/mini-soccer) sets it, so "every
// branch reachable from some action" is checked once, across the union of
// cfgs this file actually exercises — same shape as cricket's superOver case,
// verified for football per the S6 brief's instruction to check.
describe("football padSpec — action coverage across the format space", () => {
  it("every registered event type is reachable from some action, across variants", () => {
    const specs = [
      padSpec(football.configSchema.parse({})),
      padSpec(football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true })),
    ];
    expect(checkActionCoverage(specs, FOOTBALL_EVENT_SCHEMAS)).toEqual([]);
  });

  it("MUTATION SHAPE — coverage fails if the shoot-out cfg is dropped from the union (uniquely covering football.shootout.kick)", () => {
    const specsWithoutShootout = [padSpec(football.configSchema.parse({}))];
    const problems = checkActionCoverage(specsWithoutShootout, FOOTBALL_EVENT_SCHEMAS);
    expect(problems.join(" ")).toMatch(/football\.shootout\.kick/);
  });
});

function findField(spec: PadSpec, type: string, path: string): PadField | undefined {
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== type) continue;
      const field = action.fields.find((f) => f.path === path);
      if (field) return field;
    }
  }
  return undefined;
}

function actionTypesOf(spec: PadSpec): Set<string> {
  return new Set(spec.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
}

describe("football padSpec — variant reshaping: mini-soccer vs 11-a-side are demonstrably different", () => {
  const baseSpec = padSpec(football.configSchema.parse({}));
  const miniSpec = padSpec(football.configSchema.parse(football.variants["mini-soccer"]));

  it("period markers differ: 11-a-side offers HT/FT, mini-soccer's quarters add QT/3QT", () => {
    const baseMarker = findField(baseSpec, "football.period", "phase");
    const miniMarker = findField(miniSpec, "football.period", "phase");
    expect(baseMarker?.kind).toBe("enum");
    expect(miniMarker?.kind).toBe("enum");
    if (baseMarker?.kind === "enum" && miniMarker?.kind === "enum") {
      expect(baseMarker.values).toEqual(["HT", "FT"]);
      expect(miniMarker.values).toEqual(["QT", "HT", "3QT", "FT"]);
    }
  });

  it("the stamp's at.period bound tracks the same split: mini-soccer's includes Q2/Q3/Q4", () => {
    const baseAt = findField(baseSpec, "football.goal", "at.period");
    const miniAt = findField(miniSpec, "football.goal", "at.period");
    if (baseAt?.kind === "enum" && miniAt?.kind === "enum") {
      expect(baseAt.values).toEqual(["pre", "H1", "H2"]);
      expect(miniAt.values).toEqual(["pre", "H1", "Q2", "Q3", "Q4"]);
    }
  });

  it("sin-bin minutes bound is cfg-derived, not a hardcoded preset number: mini-soccer's 10-minute quarters cap it far below 11-a-side's 45", () => {
    const baseMinutes = findField(baseSpec, "football.sinbin.start", "minutes");
    const miniMinutes = findField(miniSpec, "football.sinbin.start", "minutes");
    expect(baseMinutes?.kind).toBe("number");
    expect(miniMinutes?.kind).toBe("number");
    if (baseMinutes?.kind === "number" && miniMinutes?.kind === "number") {
      expect(baseMinutes.max).toBe(45); // cfg.halfMinutes default
      expect(miniMinutes.max).toBe(10); // mini-soccer preset's halfMinutes
      expect(miniMinutes.max).toBeLessThan(baseMinutes.max);
    }
  });

  it("both variants declare the same action-type set — this pair's reshaping is bounds-only, not panel presence", () => {
    expect(actionTypesOf(miniSpec)).toEqual(actionTypesOf(baseSpec));
  });
});

describe("football padSpec — shoot-out panel: cfg gates existence, a runtime gate governs reachability", () => {
  it("is absent from the spec entirely when cfg.shootout is false (the default)", () => {
    const spec = padSpec(football.configSchema.parse({}));
    expect(spec.panels.some((panel) => panel.labelKey.key === "pad.football.panel.shootout")).toBe(false);
  });

  it("is present but its gate is a path-equals against the real football phase value, not a typo", () => {
    const spec = padSpec(football.configSchema.parse({ shootout: true }));
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.football.panel.shootout");
    expect(panel?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "SHOOTOUT" });
  });

  it("integration: the gate is false pre-match and false while merely live, against REAL football state", () => {
    const cfg = football.configSchema.parse({ shootout: true });
    const spec = padSpec(cfg);
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.football.panel.shootout");
    const gate = panel?.gate;
    expect(gate).toBeDefined();
    const preState = football.init(cfg, lineups);
    expect(
      evalPadGate(gate as NonNullable<typeof gate>, { state: preState, summary: football.summary(preState) }),
    ).toBe(false);
    const liveState = fold(cfg, stream(["core.start"]));
    expect(
      evalPadGate(gate as NonNullable<typeof gate>, { state: liveState, summary: football.summary(liveState) }),
    ).toBe(false);
  });

  it("integration: the gate is true once the match actually reaches the shoot-out — reachable, not merely configured", () => {
    const cfg = football.configSchema.parse({ shootout: true });
    const spec = padSpec(cfg);
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.football.panel.shootout");
    const gate = panel?.gate;
    expect(gate).toBeDefined();
    // Mirrors the existing "goes straight to a shootout when shootout is on
    // but ET is off" state-machine test above: 0-0 at FT with no extra time
    // configured goes straight to phase "SHOOTOUT".
    const tiedState = fold(cfg, stream(["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(tiedState.phase).toBe("SHOOTOUT"); // sanity: this really is reachable, not a fixture bug
    expect(
      evalPadGate(gate as NonNullable<typeof gate>, { state: tiedState, summary: football.summary(tiedState) }),
    ).toBe(true);
  });
});
