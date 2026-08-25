// REAL folded football states, and the ENGINE'S OWN verdict on whether an
// event type is legal in one — the oracle the v3 football tests use instead of
// a hand-written phase table.
//
// WHY THIS FILE EXISTS (R3 review round, `_INDEX.md` "the review pass that
// should have happened five tasks earlier"). Football's v3 surface shipped
// FOUR dead-end paths — a sheet offering period markers `applyPeriod` refuses,
// and a More sheet offering goal/sub/sin-bin during the shoot-out, all of them
// `WRONG_PHASE` on tap, two reachable at band 0. Every one of them was written
// by an agent that also wrote its tests, and every one of those tests was
// green, because the tests asserted the SKIN against a mirror of the engine
// rather than against the engine. A mirror agrees with itself.
//
// So the assertions built on this file never say "the skin offers X". They say
// "everything the skin offers, the fold accepts" — with `phaseVerdict` below
// deciding acceptance by actually calling `football.apply`.
//
// NOT a fixture factory for the whole wave: it answers exactly two questions
// (what does a real state at phase P look like, and does the fold refuse this
// type there), and nothing else belongs here. Leading underscore = helper, not
// a suite; vitest's `*.test.ts` include never picks it up, the same convention
// `../../__tests__/_cfg-space.ts` already uses.
import { EngineError, foldMatch, type CoreEv, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { lineupFromCatalog, makeEnvelope } from "@seazn/engine/testkit";
import { football, type FootballCfg, type FootballState } from "@seazn/engine/sports/football";

/** A catalog-valid starting lineup for THIS cfg, plus a two-player bench per
 *  side.
 *
 *  Two details that are not decoration. The catalog comes from
 *  `resolvePositions(football, cfg)`, not the module's static `positions`:
 *  small-sided and mini-soccer shrink the XI through `positionsFor(cfg)`, so a
 *  fixed eleven-slot pair is LINEUP_INVALID for half the shipped variants. And
 *  the bench matters because a substitution probe against a benchless lineup
 *  is refused for a reason that has nothing to do with the phase, which would
 *  make `phaseVerdict` measure the wrong refusal. Same shape football's own
 *  engine test builds (`football.test.ts`'s `lineupWithBench`). */
function sideWithBench(cfg: FootballCfg, entrantId: string): LineupPair["home"] {
  const base = lineupFromCatalog(resolvePositions(football, cfg), entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      { personId: `${entrantId}-b1`, slot: "bench", orderNo: base.slots.length + 1 },
      { personId: `${entrantId}-b2`, slot: "bench", orderNo: base.slots.length + 2 },
    ],
  };
}

export function lineupsFor(cfg: FootballCfg): LineupPair {
  return { home: sideWithBench(cfg, "H"), away: sideWithBench(cfg, "A") };
}

export function footballCfg(overrides: Record<string, unknown> = {}): FootballCfg {
  return football.configSchema.parse(overrides);
}

/** Every shipped variant preset, parsed. The cfg space the pad actually meets:
 *  11-a-side, youth, small-sided, mini-soccer — each of which moves `halves`,
 *  `maxSubs`, `rollingSubs` and the lineup size independently. */
export function shippedVariantCfgs(): { variant: string; cfg: FootballCfg }[] {
  const presets = (football.variants ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(presets).map(([variant, preset]) => ({
    variant,
    cfg: football.configSchema.parse(preset),
  }));
}

function envelopes(specs: readonly [type: string, payload?: unknown][]): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

export function foldFootball(
  cfg: FootballCfg,
  specs: readonly [type: string, payload?: unknown][],
): FootballState {
  return foldMatch(football, cfg, lineupsFor(cfg), envelopes(specs));
}

/**
 * Every phase this pad can be mounted in, as a REAL fold — never a hand-built
 * object literal.
 *
 * The distinction is not pedantry: the skin reads `state.squads[side].onPitch`
 * and `state.entrants`, `moreActions` runs `padSpec`'s own `path-equals`
 * gate against `state.phase`, and `phaseVerdict` needs a state the engine will
 * accept events into. A literal that satisfies the first two can still be a
 * state the fold would never produce, which is exactly how a sweep ends up
 * proving something about a shape rather than about the product.
 *
 * `ET_*` and `SHOOTOUT` need the cfg leaves no shipped variant preset turns on
 * (`extraTime.enabled` / `shootout`), so each case carries its own cfg.
 */
export interface FoldedPhase {
  /** What this case is, for an assertion message. */
  label: string;
  /** The engine's own `Phase` token — `"H1"`, `"SHOOTOUT"`, … */
  phase: string;
  cfg: FootballCfg;
  state: FootballState;
}

const LEVEL: [type: string, payload?: unknown][] = [
  ["football.goal", { by: "H" }],
  ["football.goal", { by: "A" }],
];

export function foldedPhases(): FoldedPhase[] {
  const quarters = footballCfg({ halves: 4 });
  const knockout = footballCfg({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true });
  const shootoutOnly = footballCfg({ shootout: true });

  const at = (label: string, cfg: FootballCfg, specs: [type: string, payload?: unknown][]): FoldedPhase => {
    const state = foldFootball(cfg, specs);
    return { label: `${label} (${state.phase})`, phase: state.phase, cfg, state };
  };

  return [
    // Every shipped variant, at kickoff and one whistle later — so the sweep
    // meets each preset's own `halves`/`maxSubs`/`rollingSubs`/lineup size,
    // not just the default eleven.
    ...shippedVariantCfgs().flatMap(({ variant, cfg }) => [
      at(variant, cfg, []),
      at(variant, cfg, [["core.start"]]),
      at(variant, cfg, [["core.start"], ["football.period", { phase: cfg.halves === 4 ? "QT" : "HT" }]]),
    ]),
    at("quarters", quarters, [["core.start"], ["football.period", { phase: "QT" }], ["football.period", { phase: "HT" }]]),
    at("quarters", quarters, [
      ["core.start"],
      ["football.period", { phase: "QT" }],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "3QT" }],
    ]),
    // Level at 90' with extra time enabled -> ET_H1, then ET_HT -> ET_H2.
    at("knockout", knockout, [["core.start"], ...LEVEL, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]]),
    at("knockout", knockout, [
      ["core.start"],
      ...LEVEL,
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }],
    ]),
    // Level at 90' with kicks but no extra time -> straight to SHOOTOUT.
    at("kicks", shootoutOnly, [
      ["core.start"],
      ...LEVEL,
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
    ]),
    // A decided match: the one phase where even a card is refused.
    at("decided", footballCfg(), [
      ["core.start"],
      ["football.goal", { by: "H" }],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
    ]),
  ];
}

/**
 * What the FOLD says about sending `type` into `state`.
 *
 * `"wrong-phase"` is the only verdict this file treats as a refusal, and that
 * is deliberate: an `INVALID_EVENT` means the phase let the event through and
 * something about the PAYLOAD was wrong (an unknown person, a marker that
 * needs a different mode), which a probe built from a synthetic payload can
 * provoke without any product defect existing. Collapsing the two would make
 * every assertion here fail for reasons the pad is not responsible for.
 */
export type PhaseVerdict = "accepted" | "wrong-phase" | "other";

export function phaseVerdict(
  cfg: FootballCfg,
  state: FootballState,
  type: string,
  payload: Record<string, unknown>,
): PhaseVerdict {
  const envelope = makeEnvelope(999, { type, payload }) as EventEnvelope<never | CoreEv>;
  try {
    // `strict: true` is the SCORER's path — the same one `foldMatch` uses for a
    // newly entered event (`isStrictFold`). The permissive replay policy would
    // let a substitution through that a scorer would be refused, which is the
    // opposite of what a "will the pad's offer be accepted" probe must measure.
    football.apply(state, envelope as never, { strict: true });
    return "accepted";
  } catch (error) {
    return EngineError.is(error, "WRONG_PHASE") ? "wrong-phase" : "other";
  }
}

/**
 * A schema-valid, minimally-populated payload per `football.*` type, built
 * from the state's OWN entrants and squads so the probe is refused (when it is
 * refused) for the phase and not for a fabricated person id.
 *
 * `football.period` is the one type whose legality depends on the payload as
 * well as the phase — its marker is the whole question E1 asks — so callers
 * pass their own marker rather than taking a default from here.
 */
export function probePayload(type: string, state: FootballState): Record<string, unknown> {
  const by = state.entrants.home;
  const home = state.squads.home;
  const person = home.onPitch[0] ?? `${by}-p1`;
  switch (type) {
    case "football.goal":
      return { by };
    case "football.card":
      return { by, color: "yellow" };
    case "football.sub":
      return { by, off: person, on: home.bench[0] ?? `${by}-b1` };
    case "football.penalty":
      return { by, outcome: "saved" };
    case "football.shot":
      return { by, outcome: "saved" };
    case "football.sinbin.start":
      return { by, person };
    case "football.sinbin.end":
      return { by, person };
    case "football.shootout.kick":
      return { by, scored: true };
    case "football.period":
      return { phase: "FT" };
    default:
      throw new Error(`no probe payload for "${type}" — football's vocabulary grew, extend this switch`);
  }
}
