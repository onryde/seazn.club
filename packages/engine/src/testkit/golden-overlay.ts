// GF-2 T1 — what a phone computes from the KERNEL, recorded beside what it computes from the module.
// Design: docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md (§1 what a phone computes, §2 corpus format 2).
//
// The harness used to record `module.outcome(finalState)`, `module.summary(finalState)` and `module.standingsDelta` — the
// MODULE's answers. A phone also runs the kernel on top of the module (`core/events.ts`): `outcomeOf` lays a settlement, an
// expunge and a withdrawal over a held level result on the module's outcome, `summaryOf` lays that withdrawal on the headline,
// `foldMatchWithStoppage` keeps a stoppage, the squads and the settlement beside module state, and `deciderPending` gates the
// tie-break panel. Format 2 of a corpus stream records them:
//
//   summaries  one digest per step of `summaryOf` (the pad recomputes the headline after EVERY event, not only the last).
//   overlay    one JSON string: per column, the [step, value] change points of the kernel's per-step facts. A column that
//              never leaves its kernel default is omitted. The dense per-step form is `expandOverlay`'s.
//
// This file is PURE: hashing stays in golden.ts (the one testkit file the engine boundary lets import node:crypto), so every
// function that needs a digest takes it as a parameter. It imports nothing from golden.ts — golden.ts imports it.
import {
  deciderPending,
  foldMatchWithStoppage,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
  type FoldOptions,
} from "../core/events.ts";
import { initSquads } from "../core/lineup.ts";
import type { LineupPair, MatchOutcome, ScoreSummary } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";

/** `#` + hex of a hash of the text — golden.ts's `textDigest`. */
export type Digest = (text: string) => string;

/** One fold of a ledger prefix, with every fact the kernel keeps beside module state. */
export type KernelFold = ReturnType<typeof foldMatchWithStoppage<unknown, unknown>>;

/** The facts of a fold result the recorder reads, i.e. every key `foldMatchWithStoppage` returns except `state` (the module's,
 *  recorded as `states`). A test pins this list against the fold's own keys, so a kernel fact added later is recorded or named
 *  rather than silently left out of the overlay. */
export const FOLD_OVERLAY_KEYS = ["stoppage", "squads", "settlement", "expunged", "levelWithdrawal"] as const;

/** The overlay's columns, in the order they are written: the fold's facts, plus the two the kernel derives from them. */
export const OVERLAY_COLUMNS = ["outcome", "stoppage", "settlement", "expunged", "levelWithdrawal", "decider", "squads"] as const;
export type OverlayColumn = (typeof OVERLAY_COLUMNS)[number];

/** The overlay in full: the kernel default each column holds BEFORE the first event (step -1), and the value after every
 *  event. Values are JSON text; `squads` is the JSON string of the squads' digest (the squads themselves are large). */
export interface DenseOverlay {
  readonly initial: Readonly<Record<OverlayColumn, string>>;
  readonly steps: Readonly<Record<OverlayColumn, readonly string[]>>;
}

/** `JSON.stringify`, with `undefined` read as `null` so a missing fact never records the text `undefined`. */
const json = (value: unknown): string => JSON.stringify(value ?? null);

/** The fold of every prefix of `envelopes`: `folds[i]` is the fold of `envelopes[0..i]`. */
export function foldPrefixes(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  envelopes: readonly EventEnvelope[],
  opts: FoldOptions,
): KernelFold[] {
  return envelopes.map((_, i) => foldMatchWithStoppage(module, cfg, lineups, envelopes.slice(0, i + 1), opts));
}

/** The EFFECTIVE outcome and summary of a fold — what the server stores and the pad shows (`outcomeOf`, `summaryOf`). */
export function effectiveFacts(module: AnySportModule, folded: KernelFold): { outcome: MatchOutcome | null; summary: ScoreSummary } {
  return { outcome: outcomeOf(module, folded), summary: summaryOf(module, folded) };
}

/** The kernel default of every column whose default does NOT depend on the team sheets, as the recorded JSON text: no outcome,
 *  no stoppage, no settlement, not expunged, no level withdrawal, no decider owed. The one authority: `overlayDefaults` spreads
 *  it, and a reader that holds only a stream's `overlay` (the golden floor) judges a change point against it. `squads` is the
 *  one column left out, because its default is the digest of the team sheets (`initSquads(lineups)`). */
export const STATIC_COLUMN_DEFAULTS = {
  outcome: "null",
  stoppage: "null",
  settlement: "null",
  expunged: "false",
  levelWithdrawal: "null",
  decider: "false",
} as const satisfies Partial<Record<OverlayColumn, string>>;

/** The kernel default of every column at step -1: `STATIC_COLUMN_DEFAULTS`, and the squads as the team sheets declared them. */
export function overlayDefaults(lineups: LineupPair, digest: Digest): Record<OverlayColumn, string> {
  return { ...STATIC_COLUMN_DEFAULTS, squads: json(digest(json(initSquads(lineups)))) };
}

/** The dense overlay of a ledger's prefix folds. */
export function denseOverlay(module: AnySportModule, lineups: LineupPair, folds: readonly KernelFold[], digest: Digest): DenseOverlay {
  const steps: Record<OverlayColumn, string[]> = { outcome: [], stoppage: [], settlement: [], expunged: [], levelWithdrawal: [], decider: [], squads: [] };
  for (const folded of folds) {
    steps.outcome.push(json(outcomeOf(module, folded)));
    steps.stoppage.push(json(folded.stoppage));
    steps.settlement.push(json(folded.settlement));
    steps.expunged.push(json(folded.expunged));
    steps.levelWithdrawal.push(json(folded.levelWithdrawal));
    steps.decider.push(json(deciderPending(module, folded)));
    steps.squads.push(json(digest(json(folded.squads))));
  }
  return { initial: overlayDefaults(lineups, digest), steps };
}

/** One digest per step of the EFFECTIVE summary (`summaryOf`): the headline the pad shows after each event. */
export function summaryDigests(module: AnySportModule, folds: readonly KernelFold[], digest: Digest): string[] {
  return folds.map((folded) => digest(json(summaryOf(module, folded))));
}

/** The dense overlay as change points, written as the JSON string a stream stores in `overlay`.
 *
 *  Per column, in `OVERLAY_COLUMNS` order, an array of `[step, value]` pairs holding only the steps where the value differs
 *  from the step before (step -1 is the column's default). A column with no change is omitted, so a stream the kernel never
 *  touched stores `{}`. Arrays of pairs, not `{ "17": … }` objects: GOLDEN-POLICY's integer-like-key trap. Values are the
 *  recorded JSON texts verbatim, and each is checked to survive a JSON round trip, which is what makes `expandOverlay` lossless
 *  (`JSON.parse` reorders integer-like keys; no overlay value has one today, and one that did would be refused here rather
 *  than recorded in an order its replay could not reproduce). */
export function compactOverlay(dense: DenseOverlay): string {
  const lengths = new Set(OVERLAY_COLUMNS.map((column) => dense.steps[column].length));
  if (lengths.size > 1) {
    throw new Error(`overlay is ragged: the columns hold ${OVERLAY_COLUMNS.map((c) => `${c}=${dense.steps[c].length}`).join(", ")} steps`);
  }
  const parts: string[] = [];
  for (const column of OVERLAY_COLUMNS) {
    const pairs: string[] = [];
    let previous = dense.initial[column];
    dense.steps[column].forEach((value, step) => {
      if (value !== previous) {
        if (JSON.stringify(JSON.parse(value)) !== value) {
          throw new Error(`overlay column "${column}" at step ${step} would not survive a JSON round-trip (an integer-like key?): ${value}`);
        }
        pairs.push(`[${step},${value}]`);
      }
      previous = value;
    });
    if (pairs.length > 0) parts.push(`${JSON.stringify(column)}:[${pairs.join(",")}]`);
  }
  return `{${parts.join(",")}}`;
}

/** The change points of every column a recorded overlay holds, shape-checked: an object of known columns, each an array of
 *  `[step, value]` pairs. A malformed overlay is refused by name, never read as "no change". A column with no entry holds none. */
function overlayPairs(overlay: string): Map<OverlayColumn, (readonly [unknown, unknown])[]> {
  const parsed: unknown = JSON.parse(overlay);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`overlay must be a JSON object of columns, got ${overlay.slice(0, 40)}`);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(OVERLAY_COLUMNS as readonly string[]).includes(key)) throw new Error(`overlay names unknown column "${key}"`);
  }
  const out = new Map<OverlayColumn, (readonly [unknown, unknown])[]>();
  for (const column of OVERLAY_COLUMNS) {
    const pairs = record[column];
    if (pairs === undefined) continue;
    if (!Array.isArray(pairs)) throw new Error(`overlay column "${column}" must be an array of [step, value] pairs`);
    out.set(
      column,
      (pairs as unknown[]).map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`overlay column "${column}" holds a malformed pair: ${JSON.stringify(pair)}`);
        return pair as [unknown, unknown];
      }),
    );
  }
  return out;
}

/** The inverse of `compactOverlay`: carries each change point forward to the dense per-step form, `steps` entries per column.
 *  A malformed overlay is refused by name (an unknown column, a step out of range, steps not ascending, a non-array column)
 *  rather than read as "no change". */
export function expandOverlay(overlay: string, steps: number, initial: Readonly<Record<OverlayColumn, string>>): Record<OverlayColumn, string[]> {
  const held = overlayPairs(overlay);
  const out = {} as Record<OverlayColumn, string[]>;
  for (const column of OVERLAY_COLUMNS) {
    const values: string[] = [];
    let current = initial[column];
    let next = 0;
    let last = -1;
    for (const [step, value] of held.get(column) ?? []) {
      if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step >= steps) {
        throw new Error(`overlay column "${column}" has a change point at step ${String(step)}, outside the ${steps} recorded step(s)`);
      }
      if (step <= last) throw new Error(`overlay column "${column}" is not strictly ascending at step ${step}`);
      for (; next < step; next++) values.push(current);
      current = json(value);
      last = step;
    }
    for (; next < steps; next++) values.push(current);
    out[column] = values;
  }
  return out;
}

/** What a recorded overlay says one column DID: it left its kernel default at some point (`set`) and was back at it at a later
 *  point (`cleared`). */
export interface ColumnTransitions {
  readonly set: boolean;
  readonly cleared: boolean;
}

/** The transitions of every column a recorded overlay holds (a column with no change point has no entry), read from the change
 *  points alone, with no fold and no digest function: the golden floor reads a corpus it cannot fold.
 *
 *  `set`: some change point is not the column's default. `cleared`: a change point is the default AFTER the column left it, so a
 *  point at the default before the column ever left it (which the recorder never writes) is not a clear. `squads` is the one
 *  column whose default is not static (the digest of the team sheets): any change point is a `set`, and a `cleared` is never
 *  claimed, because it cannot be read from the stream alone. A malformed overlay is refused by name, never read as "no change". */
export function overlayTransitions(overlay: string): Map<OverlayColumn, ColumnTransitions> {
  const out = new Map<OverlayColumn, ColumnTransitions>();
  for (const [column, pairs] of overlayPairs(overlay)) {
    const dflt: string | undefined = column === "squads" ? undefined : STATIC_COLUMN_DEFAULTS[column];
    let set = false;
    let cleared = false;
    let away = false;
    for (const [, value] of pairs) {
      const atDefault = dflt !== undefined && json(value) === dflt;
      if (!atDefault) {
        set = true;
        away = true;
      } else if (away) {
        cleared = true;
        away = false;
      }
    }
    out.set(column, { set, cleared });
  }
  return out;
}
