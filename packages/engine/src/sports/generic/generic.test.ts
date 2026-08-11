// Generic module goldens + conformance — spec 04 §8, PROMPT-03 §3/§5.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { evalPadGate } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { conformanceSuite, makeEnvelope } from "../../testkit/index.ts";
import { checkActionCoverage, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import { generic, GENERIC_EVENT_SCHEMAS, padSpec, type GenericCfg } from "./generic.ts";

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
};

const winLossCfg: GenericCfg = generic.configSchema.parse({
  resultMode: "win_loss",
  allowDraws: false,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
});
const scoreCfg: GenericCfg = { ...winLossCfg, resultMode: "score", allowDraws: true };
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

const fold = (cfg: GenericCfg, events: EventEnvelope[]) => foldMatch(generic, cfg, lineups, events);

describe("generic — win_loss mode (v1 parity)", () => {
  it("records a winner without requiring core.start", () => {
    const state = fold(winLossCfg, stream(["generic.result", { winnerId: "H" }]));
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
    expect(generic.summary(state).headline).toBe("W — L");
  });

  it("rejects a draw when allowDraws is false, accepts it when true", () => {
    expect(() => fold(winLossCfg, stream(["generic.result", { isDraw: true }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    const drawCfg = { ...winLossCfg, allowDraws: true };
    expect(fold(drawCfg, stream(["generic.result", { isDraw: true }])).outcome).toEqual({
      kind: "draw",
    });
  });

  it("rejects contradictory payloads", () => {
    const bad = [
      { winnerId: "H", isDraw: true },
      { winnerId: "X" },
      {},
      { winnerId: "H", p1Score: 1, p2Score: 2 }, // winner contradicts scores
      { winnerId: "H", p1Score: 2 }, // partial scores
    ];
    for (const payload of bad) {
      expect(() => fold(winLossCfg, stream(["generic.result", payload]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    }
  });

  it("accepts consistent optional scores and feeds them into metrics", () => {
    const state = fold(winLossCfg, stream(["generic.result", { winnerId: "H", p1Score: 5, p2Score: 2 }]));
    const [home, away] = generic.standingsDelta(state.outcome!, winLossCfg, league, state);
    expect(home).toMatchObject({ entrantId: "H", won: 1, points: 3, metrics: { for: 5, against: 2, diff: 3 } });
    expect(away).toMatchObject({ entrantId: "A", lost: 1, points: 0, metrics: { for: 2, against: 5, diff: -3 } });
  });
});

describe("generic — score mode (v1 parity)", () => {
  it("derives the winner from the scores", () => {
    const state = fold(scoreCfg, stream(["core.start"], ["generic.result", { p1Score: 1, p2Score: 3 }]));
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(generic.summary(state)).toEqual({
      headline: "1 — 3",
      perSide: [
        { entrantId: "H", line: "1" },
        { entrantId: "A", line: "3" },
      ],
    });
  });

  it("derives a draw from level scores, rejecting it when draws are off", () => {
    expect(fold(scoreCfg, stream(["generic.result", { p1Score: 2, p2Score: 2 }])).outcome).toEqual({
      kind: "draw",
    });
    const noDraws = { ...scoreCfg, allowDraws: false };
    expect(() => fold(noDraws, stream(["generic.result", { p1Score: 2, p2Score: 2 }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("requires both scores and consistency with redundant fields", () => {
    for (const payload of [{}, { p1Score: 1 }, { p1Score: 1, p2Score: 2, winnerId: "H" }, { p1Score: 1, p2Score: 2, isDraw: true }]) {
      expect(() => fold(scoreCfg, stream(["generic.result", payload]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    }
  });

  it("rejects a second result and post-finalize events", () => {
    const decided = stream(["generic.result", { p1Score: 1, p2Score: 0 }]);
    expect(() =>
      fold(scoreCfg, [...decided, makeEnvelope(1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } })]),
    ).toThrowError(expect.objectContaining({ code: "ALREADY_DECIDED" }));
    const final = fold(scoreCfg, [...decided, makeEnvelope(1, { type: "core.finalize", payload: {} })]);
    expect(final.phase).toBe("final");
  });
});

describe("generic — core event mapping (spec 03 §2 table)", () => {
  it("maps core.forfeit to an award for the other side", () => {
    const state = fold(winLossCfg, stream(["core.start"], ["core.forfeit", { by: "H", reason: "no-show" }]));
    expect(state.outcome).toEqual({ kind: "award", winner: "A" });
    const [home, away] = generic.standingsDelta(state.outcome!, winLossCfg, league, state);
    expect(home).toMatchObject({ lost: 1, points: 0 });
    expect(away).toMatchObject({ won: 1, points: 3 });
    expect(generic.summary(state).headline).toBe("L — W/O");
  });

  it("maps core.abandon to no_result with shared points and no draw counted", () => {
    const state = fold(scoreCfg, stream(["core.start"], ["core.abandon", { reason: "rain" }]));
    expect(state.outcome).toEqual({ kind: "no_result" });
    const [home, away] = generic.standingsDelta(state.outcome!, scoreCfg, league, state);
    expect(home).toMatchObject({ played: 1, won: 0, drawn: 0, lost: 0, points: 1 });
    expect(away).toMatchObject({ played: 1, won: 0, drawn: 0, lost: 0, points: 1 });
  });
});

describe("generic — contract declarations", () => {
  it("declares per-fixture point totals {w+l, 2d}", () => {
    expect([...generic.declaredPointsSets(winLossCfg)].sort()).toEqual([2, 3]);
    expect(generic.declaredPointsSets({ ...winLossCfg, points: { w: 2, d: 1, l: 0 } })).toEqual([2]);
  });

  it("supports draws only in non-elimination stages", () => {
    expect(generic.supportsDraws(scoreCfg, "league")).toBe(true);
    expect(generic.supportsDraws(scoreCfg, "group")).toBe(true);
    expect(generic.supportsDraws(scoreCfg, "knockout")).toBe(false);
    expect(generic.supportsDraws(scoreCfg, "stepladder")).toBe(false);
    expect(generic.supportsDraws(winLossCfg, "league")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W4 domain audit — the escape hatch could record only a FINAL card, so a
// scorer of an unmodelled sport had nothing to press until the match ended.
// generic.score adds a running tally with optional person credit; the terminal
// result still decides. Nothing else about an arbitrary sport is modelled.
// ---------------------------------------------------------------------------
describe("generic — running tally (W4)", () => {
  it("tallies while the match is live and shows it in the summary", () => {
    const state = fold(
      scoreCfg,
      stream(
        ["core.start"],
        ["generic.score", { by: "H", points: 2 }],
        ["generic.score", { by: "A", points: 1 }],
        ["generic.score", { by: "H", points: 1 }],
      ),
    );
    expect(state.running).toEqual({ home: 3, away: 1 });
    expect(state.outcome).toBeNull();
    expect(generic.summary(state).headline).toBe("3 — 1");
  });

  it("settles from the running tally when the result card carries no scores", () => {
    const state = fold(
      scoreCfg,
      stream(
        ["generic.score", { by: "H", points: 2 }],
        ["generic.score", { by: "A", points: 5 }],
        ["generic.result", {}],
      ),
    );
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    const [home, away] = generic.standingsDelta(state.outcome!, scoreCfg, league, state);
    expect(home.metrics).toEqual({ for: 2, against: 5, diff: -3 });
    expect(away.metrics).toEqual({ for: 5, against: 2, diff: 3 });
  });

  it("still requires explicit scores in score mode when nothing was tallied", () => {
    expect(() => fold(scoreCfg, stream(["generic.result", {}]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("rejects a zero-point action and a correction below zero", () => {
    expect(() => fold(scoreCfg, stream(["generic.score", { by: "H", points: 0 }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() =>
      fold(
        scoreCfg,
        stream(["generic.score", { by: "H", points: 1 }], ["generic.score", { by: "H", points: -2 }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    // A correction the tally can absorb is legal.
    const corrected = fold(
      scoreCfg,
      stream(["generic.score", { by: "H", points: 3 }], ["generic.score", { by: "H", points: -1 }]),
    );
    expect(corrected.running).toEqual({ home: 2, away: 0 });
  });

  it("never lets the tally override a recorded result", () => {
    const state = fold(
      scoreCfg,
      stream(["generic.score", { by: "H", points: 4 }], ["core.forfeit", { by: "H", reason: "no-show" }]),
    );
    expect(state.outcome).toEqual({ kind: "award", winner: "A" });
    expect(generic.summary(state).headline).toBe("L — W/O");
  });

  it("credits the person who scored", () => {
    const events = stream(
      ["generic.score", { by: "H", points: 2, person: "h1" }],
      ["generic.score", { by: "H", points: 3, person: "h1" }],
      ["generic.score", { by: "A", points: 1, person: "a1" }],
    );
    expect(aggregatePlayerStats(events, generic.playerStats!)).toEqual([
      { personId: "a1", stats: { points: 1, scores: 1 } },
      { personId: "h1", stats: { points: 5, scores: 2 } },
    ]);
  });
});

describe("generic — event union stays unambiguous (W4)", () => {
  it("parses a result card as a result and a scoring action as an action", () => {
    expect(generic.eventSchema.parse({ winnerId: "H" })).toEqual({ winnerId: "H" });
    expect(generic.eventSchema.parse({ by: "H", points: 1 })).toEqual({ by: "H", points: 1 });
    expect(generic.eventSchema.safeParse({ by: "H" }).success).toBe(false);
  });

  it("folds each branch to its own effect", () => {
    const tallied = fold(scoreCfg, stream(["generic.score", { by: "H", points: 1 }]));
    expect(tallied.outcome).toBeNull();
    expect(tallied.score).toBeNull();
    const decided = fold(scoreCfg, stream(["generic.result", { p1Score: 1, p2Score: 0 }]));
    expect(decided.outcome).toMatchObject({ kind: "win", winner: "H" });
    expect(decided.running).toBeUndefined();
  });
});

// S6/#416 (W5) — the padSpec field/attribution DSL has no "constant" PadField
// kind (a toggle is genuinely bivalent — `fc.boolean()` — so it cannot be
// pinned to always fire `isDraw: true`). Widened win_loss mode's draw
// detection so "no winnerId" alone (isDraw true, false, or absent) reads as
// a draw — a padSpec "Draw" action's toggle field can then never build a
// payload the fold rejects, whichever way the toggle lands.
describe("generic — win_loss mode: an absent winnerId reads as a draw regardless of isDraw's exact value (S6 padSpec representability)", () => {
  it("isDraw: false with no winnerId settles exactly like isDraw: true", () => {
    const drawCfg = { ...winLossCfg, allowDraws: true };
    const viaFalse = fold(drawCfg, stream(["generic.result", { isDraw: false }]));
    const viaTrue = fold(drawCfg, stream(["generic.result", { isDraw: true }]));
    expect(viaFalse.outcome).toEqual({ kind: "draw" });
    expect(viaFalse).toEqual(viaTrue);
  });

  it("an empty payload with no winnerId also settles as a draw", () => {
    const drawCfg = { ...winLossCfg, allowDraws: true };
    expect(fold(drawCfg, stream(["generic.result", {}])).outcome).toEqual({ kind: "draw" });
  });

  it("still rejects the implicit draw when allowDraws is off (same as explicit isDraw: true)", () => {
    expect(() => fold(winLossCfg, stream(["generic.result", { isDraw: false }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("a real winnerId still decides — presence of winnerId, not isDraw, is what makes it decisive", () => {
    const state = fold({ ...winLossCfg, allowDraws: true }, stream(["generic.result", { winnerId: "H", isDraw: false }]));
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
  });
});

// PROMPT-03 §5 — the generic module must pass the conformance kit in both
// result modes.
conformanceSuite(generic, { cfg: winLossCfg, lineups, label: "win_loss" });
conformanceSuite(generic, { cfg: scoreCfg, lineups, label: "score" });

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec conformance.
// ---------------------------------------------------------------------------

const winLossDrawsCfg: GenericCfg = { ...winLossCfg, allowDraws: true };

padSpecConformanceSuite(generic, { cfg: winLossCfg, lineups, label: "win_loss, draws off" });
padSpecConformanceSuite(generic, { cfg: winLossDrawsCfg, lineups, label: "win_loss, draws on" });
padSpecConformanceSuite(generic, { cfg: scoreCfg, lineups, label: "score" });

describe("generic padSpec — action coverage across the format space", () => {
  it("every registered event type is reachable from some action, across win_loss/score and draws on/off", () => {
    const specs = [padSpec(winLossCfg), padSpec(winLossDrawsCfg), padSpec(scoreCfg)];
    expect(checkActionCoverage(specs, GENERIC_EVENT_SCHEMAS)).toEqual([]);
  });

  it("generic.result is reachable from a SINGLE cfg alone too — no cfg-mutual-exclusivity hides it", () => {
    for (const cfg of [winLossCfg, winLossDrawsCfg, scoreCfg]) {
      expect(checkActionCoverage(padSpec(cfg), GENERIC_EVENT_SCHEMAS)).toEqual([]);
    }
  });
});

describe("generic padSpec — no core.* actions (match lifecycle is universal renderer chrome)", () => {
  it("declares zero actions outside its own eventSchemas registry", () => {
    for (const cfg of [winLossCfg, winLossDrawsCfg, scoreCfg]) {
      const spec = padSpec(cfg);
      for (const panel of spec.panels) {
        for (const action of panel.actions) {
          expect(action.type in GENERIC_EVENT_SCHEMAS, action.type).toBe(true);
        }
      }
    }
  });
});

describe("generic padSpec — variant reshaping: win_loss vs score produce different panels from the same module", () => {
  const winLossSpec = padSpec(winLossCfg);
  const scoreSpec = padSpec(scoreCfg);
  const actionKeysOf = (spec: ReturnType<typeof padSpec>) =>
    new Set(spec.panels.flatMap((p) => p.actions.map((a) => a.labelKey.key)));

  it("score mode offers score entry + settle-from-tally, never the win_loss decisive/draw actions", () => {
    const keys = actionKeysOf(scoreSpec);
    expect(keys.has("pad.generic.action.scoreEntry")).toBe(true);
    expect(keys.has("pad.generic.action.settleFromTally")).toBe(true);
    expect(keys.has("pad.generic.action.decisive")).toBe(false);
    expect(keys.has("pad.generic.action.draw")).toBe(false);
  });

  it("win_loss mode offers the decisive action, never score entry", () => {
    const keys = actionKeysOf(winLossSpec);
    expect(keys.has("pad.generic.action.decisive")).toBe(true);
    expect(keys.has("pad.generic.action.scoreEntry")).toBe(false);
  });

  it("win_loss mode drops the draw action entirely when allowDraws is off, adds it when on", () => {
    expect(actionKeysOf(winLossSpec).has("pad.generic.action.draw")).toBe(false);
    expect(actionKeysOf(padSpec(winLossDrawsCfg)).has("pad.generic.action.draw")).toBe(true);
  });

  it("both modes offer the running tally (add + correct)", () => {
    for (const spec of [winLossSpec, scoreSpec]) {
      const keys = actionKeysOf(spec);
      expect(keys.has("pad.generic.action.addPoints")).toBe(true);
      expect(keys.has("pad.generic.action.correctPoints")).toBe(true);
    }
  });
});

describe("generic padSpec — settle-from-tally is gated on state.running, not always visible", () => {
  it("declares a state-dependent gate on the settle panel", () => {
    const spec = padSpec(scoreCfg);
    const settle = spec.panels.find((p) => p.labelKey.key === "pad.generic.panel.settle")!;
    expect(settle.gate).toEqual({ op: "path-truthy", path: "state.running" });
  });

  // Review finding (S6/#416 gap list): the test above only proves the gate is
  // CONFIGURED with the right shape, not that it is actually REACHABLE against
  // a real fold — every other gated panel this session (cricket's super-over,
  // table tennis's expedite, tennis's tie-break) additionally proves this
  // against `evalPadGate` over real folded state. Mirrors
  // `setbased/padspec.test.ts`'s table tennis expedite integration test.
  it("is false before any tally is pressed, true once one is — against REAL folded state", () => {
    const spec = padSpec(scoreCfg);
    const settle = spec.panels.find((p) => p.labelKey.key === "pad.generic.panel.settle")!;
    expect(settle.gate).toBeDefined();
    const gate = settle.gate!;

    const preState = fold(scoreCfg, []);
    expect(evalPadGate(gate, { state: preState, summary: generic.summary(preState) })).toBe(false);

    const liveState = fold(scoreCfg, stream(["generic.score", { by: "H", points: 5 }]));
    expect(evalPadGate(gate, { state: liveState, summary: generic.summary(liveState) })).toBe(true);
  });
});
