"use client";
// Guided sheet — R2 task A1 (chassis piece R1 left unbuilt). Spec §2.4's
// "one sanctioned interruption": a guided sheet for events whose payload
// cannot be built side-only (cricket wicket: kind -> who -> fielder). R1
// shipped GuidedSheetSpec/SheetChoiceStep/SheetPersonStep and
// TileSpec.action = {sheet: string} in ./types.ts with ZERO consumers —
// tile-grid.tsx forwarded {sheet} tiles raw to onAction and nothing
// anywhere rendered a step wizard (_INDEX.md, R1 "owed by later waves").
// Cricket's own wicket flow (the actual SkinDefV3.sheets entry + tile
// wiring) is a LATER task's job; this file is the chassis renderer it will
// consume — sport-agnostic, same posture as every other v3 primitive
// (scorebug/tile-grid/context-strip/swap-sheet): pure data in, thin render
// out, nothing here decides what an event MEANS.
//
// SPLIT (matches tile-grid.tsx/tilesForPhase, detail-dock.tsx/
// dockController, scorebug.tsx/assertScorebugSpec): the step machine below
// (initialSheetState/currentStep/answerStep/backStep) is a pure, EXPORTED
// builder — data in, data out, no React — because apps/web vitest is
// environment:"node" with no jsdom. `GuidedSheet` itself is a thin renderer
// over it, proved with the shared _hook-harness (renderIsland/walk/
// textOf), same as context-swap.test.ts proves ContextStrip/SwapSheet — a
// useState component called directly throws "Invalid hook call" under this
// workspace's jsdom-less config.
//
// Person steps resolve candidates through context-strip.tsx's resolvePool
// (R1 Ruling F) — "onfield" is onFieldPersons(), "bench" is playingSquad()
// minus on-field — never attribution-picker.tsx's candidatesForPerson
// (bench-INCLUSIVE, cannot make the split; A1 dispatch, explicit
// constraint). Candidates render via context-strip.tsx's own
// renderCandidateRow, so a person step looks and behaves exactly like every
// other picker in this chassis rather than a parallel one. G6 (controller
// ruling, R2/task C review, types.ts's own doc on `SheetPersonStep.
// candidates`): a step's own explicit `candidates` list, when present,
// SUPERSEDES `pool` entirely (`candidatesForStep` below) — for a case
// `resolvePool` cannot express at all, e.g. cricket's "who's out" needing
// exactly the two batters at the crease rather than the whole on-field
// roster (`SquadMember.onField` is never cleared by a dismissal).
//
// SCOPE NOTE, UPDATED (R2/task A5 — the wave that hits this first, exactly
// as flagged below used to predict): unlike ContextStripProps/
// SwapSheetProps, this component does NOT take one `view: PoolView` for its
// whole lifetime. Cricket's real wicket flow needs the BATTING side for
// "who out" and the FIELDING side for "fielder" in ONE sheet — two
// different squads a single PoolView cannot express, and the person steps
// here are the one place in this chassis where that actually bites (a
// context-strip chip or a swap sub is always scoped to ONE side already).
// `GuidedSheetProps.views` below is a `{home, away}` pair instead: each
// `SheetPersonStep` now carries its own REQUIRED `side` (types.ts), and
// `resolvePool` is called against `views[step.side]` — the chassis still
// makes no decision about which side means what (it does not know "home"
// is batting or fielding right now); it only picks the matching PoolView a
// skin's own step already named. The former text of this note ("deliberately
// left unsolved here... the wave that wires cricket's actual wicket sheet
// must either widen this contract") is exactly what this change does.
//
// RENDERER DESIGN (frontend-design pass, task A1): reuses swap-sheet.tsx's
// card idiom verbatim (plain white/slate-200 card, .mk-eyebrow step title,
// no borrowed cream/lime depletion bar — a guided sheet has no timer, so
// DetailDock's "closing in Ns" signal would be the wrong one here too, for
// the same reason swap-sheet.tsx's own header gives). Back reuses TileGrid's
// "standard" tile treatment (solid slate-200 border) — an ordinary
// navigation control. Cancel reuses TileGrid's "minor" treatment (dashed
// slate-300 border, quieter weight) — deliberately the QUIETEST control on
// the sheet, since it is the one action that discards everything entered so
// far and must never compete visually with forward progress. No new hue:
// only the existing slate neutral + the app's one focus-ring colour
// (lime-400), matching every sibling primitive's "one hue per signal" rule
// (tile-grid.tsx's own header) — nothing on this surface is `primary` or
// `destructive` in the TileGrid sense, so violet/red have no place here.
import { useState } from "react";
import { renderCandidateRow, resolvePool, type PoolView, type TFn } from "./context-strip";
import type { GuidedSheetSpec, GuidedSheetStep, SheetPersonStep, TapEvent } from "./types";

export interface GuidedSheetState {
  readonly stepIndex: number;
  readonly answers: Readonly<Record<string, string>>;
}

/** The wizard's start state: first step, nothing answered yet. Relies on
 *  the convention `GuidedSheetStep`'s own doc states (types.ts): a spec's
 *  FIRST step never declares `when`, so index 0 is always visible against
 *  the empty answer set — no spec/scan needed here to establish that. */
export function initialSheetState(): GuidedSheetState {
  return { stepIndex: 0, answers: {} };
}

/** G2 (controller ruling, types.ts's own doc on `StepPredicate`): whether
 *  `step` is shown given `answers` accumulated so far. Absent `when` is
 *  "always shown" — every pre-G2 spec (none declare `when` at all) reads
 *  identically to before this change. */
function stepVisible(step: GuidedSheetStep, answers: Readonly<Record<string, string>>): boolean {
  return step.when === undefined || step.when(answers);
}

/** G6 (controller ruling, types.ts's own doc on `SheetPersonStep.candidates`):
 *  an explicit `candidates` list SUPERSEDES `pool` entirely when present —
 *  `resolvePool` (context-strip.tsx) is not consulted at all in that case,
 *  never merged/intersected with it. Absent `candidates` is "resolve the
 *  pool exactly as before this change" — every pre-G6 spec (none declare
 *  `candidates`) reads identically. */
function candidatesForStep(step: SheetPersonStep, view: PoolView): readonly string[] {
  return step.candidates ?? resolvePool({ pool: step.pool }, view);
}

/** The first index at or after `fromIndex` whose step is visible against
 *  `answers`, or `null` once scanning runs off the end (the wizard is
 *  complete — every remaining step, if any, is gated off). A single-step
 *  spec with no `when` anywhere degenerates to `fromIndex` itself,
 *  unchanged from pre-G2 behaviour. */
function firstVisibleFrom(
  spec: GuidedSheetSpec,
  answers: Readonly<Record<string, string>>,
  fromIndex: number,
): number | null {
  for (let i = fromIndex; i < spec.steps.length; i++) {
    if (stepVisible(spec.steps[i]!, answers)) return i;
  }
  return null;
}

/** The nearest visible index BEFORE `beforeIndex`, scanning backward —
 *  `backStep`'s own skip-logic, mirroring `firstVisibleFrom`'s forward
 *  scan. Clamps to 0 if nothing earlier is visible (defensive: unreachable
 *  through the real UI given the "first step never declares `when`"
 *  convention, kept total rather than assumed). */
function lastVisibleBefore(
  spec: GuidedSheetSpec,
  answers: Readonly<Record<string, string>>,
  beforeIndex: number,
): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (stepVisible(spec.steps[i]!, answers)) return i;
  }
  return 0;
}

/** The step `state` currently points at, or `null` once the index has run
 *  past the end (or every remaining step is gated off by `when` — G2).
 *  Defensive only in the "stepIndex already past `spec.steps.length`" case
 *  — `answerStep`/`backStep` below never themselves produce such an index
 *  (see their own docs), so a live `GuidedSheet` never actually renders
 *  the `null` case that way; kept total anyway so this function never
 *  throws on a malformed/out-of-range state. The `when`-gated-off case
 *  (state.stepIndex itself invisible) IS reachable in principle if a
 *  caller constructs a `GuidedSheetState` by hand rather than through
 *  `answerStep`/`backStep` — resolved the same forward-scanning way either
 *  way, so this function stays correct regardless of how `state` arrived. */
export function currentStep(spec: GuidedSheetSpec, state: GuidedSheetState): GuidedSheetStep | null {
  const idx = firstVisibleFrom(spec, state.answers, state.stepIndex);
  return idx === null ? null : spec.steps[idx]!;
}

export type GuidedSheetAdvance = { done: false; state: GuidedSheetState } | { done: true; event: TapEvent };

/**
 * Answers the CURRENT step with `value` and moves forward — the whole
 * "forward on answer" mechanism (no separate Next control anywhere in this
 * chassis: SwapSheet's off/on pickers and ContextStrip's own candidate row
 * already establish "picking a candidate IS the forward action"). Answers
 * accumulate keyed by each step's own `id`, so a later step's `buildPayload`
 * can read any earlier answer by name, not just the immediately-previous
 * one.
 *
 * G2 (controller ruling): the NEXT step is the first one, scanning forward
 * from `stepIndex + 1`, whose `when(answers)` — evaluated against the
 * answers accumulated so far, INCLUDING this one — is true or absent
 * (`firstVisibleFrom`). A step whose predicate is false is skipped WITHOUT
 * a tap, never merely disabled/skippable-by-the-user; this is the whole
 * mechanism that lets cricket ask "who's out" only for a run-out and
 * "fielder" only for the three kinds where naming one is meaningful.
 *
 * On the step immediately before the wizard's end (nothing further is
 * visible), hands back the fully built `TapEvent` (`spec.buildPayload` run
 * over every accumulated answer, INCLUDING this one) instead of a further
 * `state` — the component calls `onComplete` with `event` and resets,
 * never renders a `stepIndex` sitting past the last real step. Called with
 * no current step at all (`state` already past the end — see `currentStep`)
 * is a no-op that returns the SAME `state` unchanged, never throws:
 * defensive parity with `currentStep` above, unreachable through the real
 * UI (see `backStep`'s doc for why the index can only ever sit in-range
 * there too).
 */
export function answerStep(spec: GuidedSheetSpec, state: GuidedSheetState, value: string): GuidedSheetAdvance {
  const step = spec.steps[state.stepIndex];
  if (!step) return { done: false, state };
  const answers = { ...state.answers, [step.id]: value };
  const nextIndex = firstVisibleFrom(spec, answers, state.stepIndex + 1);
  if (nextIndex === null) {
    return { done: true, event: { type: spec.event, payload: spec.buildPayload(answers) } };
  }
  return { done: false, state: { stepIndex: nextIndex, answers } };
}

/**
 * One step back, keeping every answer already given (including the one for
 * the step being left — re-answering it overwrites, never appends, so
 * nothing needs to be explicitly cleared). A no-op on the first step
 * (`stepIndex` 0), returning the SAME `state` reference unchanged:
 * `GuidedSheet` below only ever renders a Back control once `stepIndex > 0`,
 * so this branch is defensive, not something a real tap can reach.
 *
 * G2 (controller ruling): lands on the nearest EARLIER visible step
 * (`lastVisibleBefore`), not merely `stepIndex - 1` — a plain decrement
 * would land back on a step `answerStep` just SKIPPED on the way forward
 * (e.g. "who's out" after a `kind: "bowled"` answer), and `currentStep`'s
 * own forward-scan would immediately re-skip it, making Back silently
 * inert on exactly the runs where skipping did anything. `spec` is
 * therefore a required parameter here, unlike R1's version of this
 * function — its one call site (`GuidedSheet` below) already has `spec`
 * in scope.
 */
export function backStep(spec: GuidedSheetSpec, state: GuidedSheetState): GuidedSheetState {
  if (state.stepIndex === 0) return state;
  return { stepIndex: lastVisibleBefore(spec, state.answers, state.stepIndex), answers: state.answers };
}

const backButtonClass =
  "min-w-0 shrink-0 break-words rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

const cancelButtonClass =
  "min-w-0 shrink-0 break-words rounded-full border border-dashed border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

const choiceButtonClass =
  "min-w-0 shrink-0 break-words rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

/** A row of real 44px choice buttons for a `SheetChoiceStep` — the
 *  `renderCandidateRow` (context-strip.tsx) equivalent for options that
 *  aren't people. A PLAIN FUNCTION, not its own JSX component, for the same
 *  reason renderCandidateRow is one: this repo's node-only `_hook-harness`
 *  walks a rendered tree through `.props.children` only, never invoking a
 *  nested custom component's own function — a real `<ChoiceRow/>` would
 *  make every button inside it invisible to `walk()`/`textOf()`. */
function renderChoiceRow(options: readonly { id: string; label: string }[], t: TFn, onPick: (id: string) => void) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onPick(opt.id)}
          style={{ minHeight: 44 }}
          className={choiceButtonClass}
        >
          {t(opt.label)}
        </button>
      ))}
    </div>
  );
}

export interface GuidedSheetProps {
  spec: GuidedSheetSpec;
  /** Both squads a `kind:"person"` step might resolve against — see the
   *  file header's SCOPE NOTE. Each step picks its own via its REQUIRED
   *  `side` (types.ts's `SheetPersonStep`); this component never guesses
   *  which one a step meant. Built once by the host per render
   *  (pad-host.tsx's `sidePool` builder) from whichever `SquadState` the
   *  current fold carries. */
  views: Readonly<Record<"home" | "away", PoolView>>;
  personNames: Readonly<Record<string, string>>;
  t: TFn;
  /** Fires once the LAST step is answered: `{type: spec.event, payload:
   *  spec.buildPayload(answers)}` for every answer accumulated across the
   *  whole flow. Nothing here decides what the event means or dispatches
   *  it — same thin-renderer posture as every other v3 primitive
   *  (scorebug's onTap, tile-grid's onAction, swap-sheet's onSwap). */
  onComplete: (event: TapEvent) => void;
  /** Fires when Cancel is tapped. `onComplete` is never called in this
   *  case — Cancel emits nothing, by design (task brief, explicit
   *  constraint). Optional: a caller not yet wired to remove this sheet
   *  from the tree can omit it with no crash. */
  onCancel?: () => void;
}

/**
 * Renders a `GuidedSheetSpec` as a sequential step wizard: one step's
 * controls at a time, forward on answer, a Back control once there is a
 * step to go back to, and an always-present Cancel. Internal state
 * (`GuidedSheetState`) resets to `initialSheetState()` both on completion
 * and on cancel, so a host that keeps this component mounted across
 * multiple sheet-openings (rather than remounting a fresh instance per
 * `spec`) still gets a clean run each time rather than resuming a stale
 * wizard — the same "reset, don't carry stale state forward" posture
 * DetailDock takes on a new `heldId` (render-phase reset, its own header).
 */
export function GuidedSheet({ spec, views, personNames, t, onComplete, onCancel }: GuidedSheetProps) {
  const [state, setState] = useState<GuidedSheetState>(() => initialSheetState());
  const step = currentStep(spec, state);

  const handleAnswer = (value: string) => {
    const outcome = answerStep(spec, state, value);
    if (outcome.done) {
      setState(initialSheetState());
      onComplete(outcome.event);
    } else {
      setState(outcome.state);
    }
  };
  const handleBack = () => setState((s) => backStep(spec, s));
  const handleCancel = () => {
    setState(initialSheetState());
    onCancel?.();
  };

  if (step === null) return null;
  const emptyText = t("scorepad.attribution.noRoster");

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <p className="mk-eyebrow min-w-0 break-words text-slate-600">{t(step.title)}</p>
        {state.stepIndex > 0 && (
          <button type="button" onClick={handleBack} style={{ minHeight: 44 }} className={backButtonClass}>
            {t("pad.sheet.back")}
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        {step.kind === "choice"
          ? renderChoiceRow(step.options, t, handleAnswer)
          : renderCandidateRow(candidatesForStep(step, views[step.side]), personNames, t, handleAnswer, emptyText)}
      </div>
      <div className="flex justify-end px-4 pb-3">
        <button type="button" onClick={handleCancel} style={{ minHeight: 44 }} className={cancelButtonClass}>
          {t("pad.sheet.cancel")}
        </button>
      </div>
    </div>
  );
}
