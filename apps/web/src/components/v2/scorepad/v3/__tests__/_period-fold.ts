// v3/__tests__/_period-fold.ts — THE REAL PERIOD KERNEL, for R6's two skins.
//
// WHY THIS EXISTS AT ALL. `apps/web` vitest is `environment: "node"` with no
// jsdom, so every skin test in this tree is a pure-data test: build a spec,
// assert its shape. That proves the BUILDER and nothing else. This programme
// has now shipped a declared-but-inert seam six times, each one unit-green,
// and the only thing that has ever caught one is folding the builder's own
// output through the module that will actually receive it. So: no hand-written
// fixtures. Every `state` a hockey/ice-hockey skin test reads comes out of
// `foldMatch(hockey | icehockey, ...)`, and every payload a test asserts on is
// pushed back through `apply` to see whether the kernel keeps it.
//
// Modelled on `_football-fold.ts` beside it, which does the same job for R3.
// The two sports here are ONE kernel (`sports/period/kernel.ts`) under two
// presets, so the helper is parameterised by the module rather than duplicated.

import { EngineError, foldMatch, type CoreEv, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { lineupFromCatalog, makeEnvelope } from "@seazn/engine/testkit";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";

export { hockey, icehockey };

/** Both presets, for the sweeps that must hold for the PAIR rather than for
 *  one sport that happened to be tried. */
export const PERIOD_MODULES: readonly { key: "hockey" | "icehockey"; module: AnySportModule }[] = [
  { key: "hockey", module: hockey as AnySportModule },
  { key: "icehockey", module: icehockey as AnySportModule },
];

export type PeriodStateLike = Record<string, unknown>;
export type Spec = [type: string, payload?: unknown];

/** A full lineup from the sport's own catalog, plus two named bench players —
 *  the pad's swap sheet and every `person` chip need somebody to offer, and a
 *  catalog lineup alone fills only the on-field slots. */
function sideWithBench(module: AnySportModule, cfg: unknown, entrantId: string): LineupPair["home"] {
  const base = lineupFromCatalog(resolvePositions(module, cfg), entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      { personId: `${entrantId}-b1`, slot: "bench", orderNo: base.slots.length + 1 },
      { personId: `${entrantId}-b2`, slot: "bench", orderNo: base.slots.length + 2 },
    ],
  };
}

export function lineupsFor(module: AnySportModule, cfg: unknown): LineupPair {
  return { home: sideWithBench(module, cfg, "H"), away: sideWithBench(module, cfg, "A") };
}

/** `configSchema.parse` rather than an object literal: every default this pad
 *  reads (`goalKinds`, `assists`, `setPieceKinds`, `suspensions.classes`,
 *  `strength`, `overtime`, `shootout`) is applied BY the schema, and a
 *  hand-written cfg would silently omit whichever one a test forgot. */
export function periodCfg(module: AnySportModule, overrides: Record<string, unknown> = {}): unknown {
  return module.configSchema.parse(overrides);
}

/** Every variant the sport actually ships, parsed through its own schema —
 *  hockey's `fih-outdoor`/`fih-shootout`/`youth`, ice hockey's `iihf`/
 *  `recreational`. A pad rule that only holds for the default cfg is a pad rule
 *  that breaks in half the divisions running it. */
export function shippedVariantCfgs(module: AnySportModule): { variant: string; cfg: unknown }[] {
  const presets = (module.variants ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(presets).map(([variant, preset]) => ({
    variant,
    cfg: module.configSchema.parse(preset),
  }));
}

function envelopes(specs: readonly Spec[]): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

export function foldPeriod(module: AnySportModule, cfg: unknown, specs: readonly Spec[]): PeriodStateLike {
  return foldMatch(module as never, cfg as never, lineupsFor(module, cfg), envelopes(specs)) as PeriodStateLike;
}

/** The module's own `summary(state)` — the pad reads `strength`, `nextAdvance`,
 *  `shootoutNext`, `shootout` and (hockey only) `escalate` out of here rather
 *  than re-deriving any of them, so the tests must read the same object the pad
 *  will be handed. */
export function summaryOf(module: AnySportModule, state: PeriodStateLike): unknown {
  return (module as { summary(s: unknown): unknown }).summary(state);
}

export interface FoldedPhase {
  label: string;
  phase: string;
  cfg: unknown;
  state: PeriodStateLike;
  summary: unknown;
}

/**
 * Every phase the two kernels can actually reach, from their own shipped
 * variants — pre, each regulation period, overtime, the shootout, and a
 * decided match. `phase` is READ BACK off the folded state, never asserted
 * from the recipe, so a kernel that renames a label moves this table with it.
 */
export function foldedPhases(module: AnySportModule): FoldedPhase[] {
  const at = (label: string, cfg: unknown, specs: Spec[]): FoldedPhase => {
    const state = foldPeriod(module, cfg, specs);
    return {
      label: `${label} (${String(state.phase)})`,
      phase: String(state.phase),
      cfg,
      state,
      summary: summaryOf(module, state),
    };
  };
  const key = module.key;
  const advance = `${key}.period.advance`;
  const goal = `${key}.goal`;

  const rows: FoldedPhase[] = [];
  for (const { variant, cfg } of shippedVariantCfgs(module)) {
    rows.push(at(variant, cfg, []));
    rows.push(at(variant, cfg, [["core.start"]]));
    // Walk the whole period ladder for this variant, one advance at a time,
    // asking the kernel itself where to go next. Nothing here hard-codes a
    // label, so a four-quarter hockey cfg and a three-period ice-hockey cfg
    // both enumerate correctly with the same loop.
    const specs: Spec[] = [["core.start"]];
    for (let step = 0; step < 8; step += 1) {
      const state = foldPeriod(module, cfg, specs);
      const next = nextAdvanceOf(module, state);
      if (next === null) break;
      specs.push([advance, { to: next }]);
      rows.push(at(`${variant}+${step + 1}`, cfg, [...specs]));
    }
    // A DECIDED match: one goal, then run out the ladder, so `outcome` is set
    // and the phase is "done" without touching a shootout.
    const decided: Spec[] = [["core.start"], [goal, { by: "H" }]];
    for (let step = 0; step < 8; step += 1) {
      const state = foldPeriod(module, cfg, decided);
      const next = nextAdvanceOf(module, state);
      if (next === null) break;
      decided.push([advance, { to: next }]);
    }
    rows.push(at(`${variant}/decided`, cfg, decided));

    // THE TWO PHASES THIS TABLE USED TO MISS (R6 fix pass 2, gap 5).
    //
    // `done` was the only terminal phase produced here, so the two others the
    // kernel can reach — `final` (kernel.ts:2408, a decided fixture whose
    // ledger has been locked) and `abandoned` (kernel.ts:1416, a `replay`
    // abandonment) — were named in the skin's `POST_PHASES` and asserted
    // NOWHERE. Deleting either from that set survived the whole suite, and the
    // failure it hid is not cosmetic: `resolvePhase` would return "live" on an
    // abandoned fixture, `buildClock` would declare a clock counting within a
    // period called "abandoned", and every stamp it produced would then be
    // refused by `isPlayPhase` — a running clock recording nothing.
    rows.push(at(`${variant}/final`, cfg, [...decided, ["core.finalize"]]));
    rows.push(at(`${variant}/abandoned`, cfg, [["core.start"], ["core.abandon", { reason: "floodlight failure" }]]));
  }
  return rows;
}

/** `summary.detail.nextAdvance` — the kernel's own `expectedAdvance`, surfaced
 *  through the same field the pad's period tile reads. */
export function nextAdvanceOf(module: AnySportModule, state: PeriodStateLike): string | null {
  const detail = (summaryOf(module, state) as { detail?: { nextAdvance?: string | null } }).detail;
  return detail?.nextAdvance ?? null;
}

/** `summary.detail.shootoutNext` — the kernel's own `expectedKicker`. NULL at a
 *  shoot-out's opening, where either side may take the first attempt. */
export function shootoutNextOf(module: AnySportModule, state: PeriodStateLike): "home" | "away" | null {
  const detail = (summaryOf(module, state) as { detail?: { shootoutNext?: string | null } }).detail;
  const next = detail?.shootoutNext;
  return next === "home" || next === "away" ? next : null;
}

/** The first shipped variant whose cfg actually HAS a shoot-out — ice hockey's
 *  default `iihf` does, field hockey's default `fih-outdoor` does not and its
 *  `fih-shootout` variant is where the FIH one lives. Throws rather than
 *  returning a variant with no shoot-out, which would make every caller below
 *  pass vacuously against a match that never left regulation. */
export function shootoutCfgOf(module: AnySportModule): { variant: string; cfg: unknown } {
  const found = shippedVariantCfgs(module).find(({ cfg }) => (cfg as { shootout: unknown }).shootout !== null);
  if (found === undefined) throw new Error(`${module.key} ships no variant with a shoot-out`);
  return found;
}

/**
 * A shoot-out folded THROUGH to a decided result, which is the state
 * `period-pair.test.ts` had never reached: its shoot-out fixtures all stopped
 * mid-attempt, where `officialScore` credits nothing and the pad's own
 * `state.goals` still agrees with the engine's headline by accident.
 *
 * `regulation` is the level score the shoot-out is breaking — the goals both
 * sides scored in play, which the shoot-out must NOT move. Attempts alternate
 * by asking the kernel whose turn it is (`expectedKicker`, via the summary),
 * home scoring and away missing, until the kernel itself leaves the SHOOTOUT
 * phase. Nothing here decides how many attempts that takes: `attempts` and
 * `suddenDeath` are the cfg's, and best-of-five with an early clinch ends at
 * three apiece.
 */
export function decidedShootout(
  module: AnySportModule,
  cfg: unknown,
  regulation: readonly Spec[] = [],
): { specs: Spec[]; state: PeriodStateLike } {
  const key = module.key;
  const specs: Spec[] = [["core.start"], ...regulation];
  for (let step = 0; step < 12; step += 1) {
    const s = foldPeriod(module, cfg, specs);
    if (s.phase === "SHOOTOUT") break;
    const next = nextAdvanceOf(module, s);
    if (next === null) break;
    specs.push([`${key}.period.advance`, { to: next }]);
  }
  let state = foldPeriod(module, cfg, specs);
  if (state.phase !== "SHOOTOUT") {
    throw new Error(`${key}: the ladder never reached a shoot-out (stopped in "${String(state.phase)}")`);
  }
  for (let attempt = 0; attempt < 30 && state.phase === "SHOOTOUT"; attempt += 1) {
    const side = shootoutNextOf(module, state) ?? "home";
    const by = (state.entrants as Record<string, string>)[side]!;
    specs.push([`${key}.shootout.attempt`, { by, scored: side === "home" }]);
    state = foldPeriod(module, cfg, specs);
  }
  if (state.phase === "SHOOTOUT") throw new Error(`${key}: the shoot-out never decided`);
  return { specs, state };
}

export type PhaseVerdict = "accepted" | "wrong-phase" | "other";

/** Push a payload at the REAL reducer and report which of the three answers it
 *  gave. `strict: true` because that is the mode a live dispatch runs in. */
export function phaseVerdict(
  module: AnySportModule,
  state: PeriodStateLike,
  type: string,
  payload: Record<string, unknown>,
): PhaseVerdict {
  const envelope = makeEnvelope(999, { type, payload }) as EventEnvelope<never | CoreEv>;
  try {
    (module as { apply(s: unknown, e: unknown, ctx: unknown): unknown }).apply(state, envelope, { strict: true });
    return "accepted";
  } catch (error) {
    return EngineError.is(error, "WRONG_PHASE") ? "wrong-phase" : "other";
  }
}

/** A minimally-valid payload per event type, built from the folded state so the
 *  entrant ids and person ids are the real ones. Anything the switch does not
 *  know THROWS rather than returning `{}` — a silent `{}` would be refused for
 *  the wrong reason and read as a phase refusal. */
export function probePayload(module: AnySportModule, type: string, state: PeriodStateLike): Record<string, unknown> {
  const key = module.key;
  const entrants = state.entrants as { home: string; away: string };
  const by = entrants.home;
  const squads = state.squads as { home?: { onPitch?: string[]; bench?: string[] } } | undefined;
  const person = squads?.home?.onPitch?.[0] ?? `${by}-p1`;
  const cfg = state.cfg as { suspensions?: { classes?: Record<string, unknown> } | null; setPieceKinds?: string[] };
  const firstClass = Object.keys(cfg.suspensions?.classes ?? {})[0] ?? "minor";
  const firstSetPiece = cfg.setPieceKinds?.[0] ?? "pc";
  switch (type) {
    case `${key}.goal`:
      return { by };
    case `${key}.period.advance`:
      return { to: nextAdvanceOf(module, state) ?? "FT" };
    case `${key}.suspension.start`:
      return { by, person, class: firstClass };
    case `${key}.suspension.end`:
      return { by };
    case `${key}.shootout.attempt`:
      return { by, scored: true };
    case `${key}.set_piece`:
      return { by, kind: firstSetPiece };
    case `${key}.shot`:
      return { by, outcome: "saved" };
    default:
      throw new Error(`no probe payload for "${type}" — the period kernel's vocabulary grew, extend this switch`);
  }
}
