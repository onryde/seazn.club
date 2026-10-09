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
import type { Blocked, GuidedSheetSpec, GuidedSheetStep, SheetChoiceOption, SheetNumberStep, SheetPersonStep, TapEvent } from "./types";
import { SPORT_TONE_CLASSES } from "./tokens";
import type { SportTone } from "./sport-theme";

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
/**
 * A person step, plus the decline control an `optional` one needs.
 *
 * The empty answer is `""`, which every skin's `buildPayload` already treats
 * as absent (`answers.servedBy ? {...} : {}`) — so declining omits the field
 * rather than writing a blank one. It renders BELOW the candidates rather
 * than among them: it is not a person, and a chip sitting in the row reads
 * like one.
 */
function renderPersonStep(
  step: SheetPersonStep,
  view: PoolView,
  personNames: Readonly<Record<string, string>>,
  t: TFn,
  onAnswer: (value: string) => void,
  emptyText: string,
) {
  const ids = candidatesForStep(step, view);
  if (step.optional !== true) return renderCandidateRow(ids, personNames, t, onAnswer, emptyText);
  return (
    <div className="space-y-2">
      {renderCandidateRow(ids, personNames, t, onAnswer, emptyText)}
      <button
        type="button"
        data-role="v3-person-none"
        onClick={() => onAnswer("")}
        style={{ minHeight: 44 }}
        className="rounded-full border border-dashed border-slate-300 px-4 text-sm text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
      >
        {t("pad.sheet.person.none")}
      </button>
    </div>
  );
}

function candidatesForStep(step: SheetPersonStep, view: PoolView): readonly string[] {
  return step.candidates ?? resolvePool({ pool: step.pool }, view);
}

/** Enforces `SheetNumberStep.min`/`.max` on any candidate new value — the
 *  ONE place both the stepper buttons and the typed field funnel through
 *  (types.ts's own doc on `SheetNumberStep`: a clamp only the skin enforces
 *  in its `buildPayload` is one this renderer could still be made to
 *  bypass, e.g. typing an out-of-range number directly into the field).
 *  Review fix (follow-up to c70c0e90): a non-finite `value` (NaN/±Infinity)
 *  would otherwise sail through both bound checks unclamped — every NaN
 *  comparison is false, and `Infinity` with no `max` set has nothing to
 *  clamp it. Unreachable through TODAY's one call path (`step.initial` is
 *  typed `number` and cricket always supplies a real one), but `initial`
 *  is skin-supplied data, and a later R3-R7 skin is not guaranteed to hand
 *  this a value that finite arithmetic already validated. Non-finite input
 *  normalises to 0 — a safe, in-range-by-default baseline — BEFORE the
 *  min/max clamps below apply on top of it. */
/**
 * R6 fix, W-1. `SheetNumberStep.initial` admits a literal or a function of the
 * answers gathered SO FAR in this sheet. The literal form is fixed when the
 * sheet is built; the function form is resolved here, at the moment a step is
 * freshly seeded, which is the first instant the earlier steps' answers exist.
 *
 * Pure and total: a function that throws or returns a non-finite number would
 * otherwise put `NaN` into the stepper and out through the payload, so both
 * fall back to the same `0` that `clampNumberStep` then lifts to `min`. The
 * caller clamps whichever form resolves, so neither can escape the step's
 * declared bounds.
 */
export function resolveInitial(step: SheetNumberStep, answers: Record<string, string>): number {
  if (typeof step.initial !== "function") return step.initial;
  let value: number;
  try {
    value = step.initial(answers);
  } catch {
    return 0;
  }
  return Number.isFinite(value) ? value : 0;
}

function clampNumberStep(value: number, step: SheetNumberStep): number {
  let v = Number.isFinite(value) ? value : 0;
  if (step.min !== undefined && v < step.min) v = step.min;
  if (step.max !== undefined && v > step.max) v = step.max;
  return v;
}

/** R2 review finding (defect 2): drops any answer whose OWN step is no
 *  longer reachable given the answers kept so far — the guard for "back up,
 *  change a branch-determining answer, and a stale key from the abandoned
 *  branch survives into what `buildPayload` sees." Pre-fix, `answerStep`
 *  only ever SPREAD `{...state.answers, [step.id]: value}`, so a step that
 *  goes from visible to gated-off never lost its old answer — the object
 *  handed to `buildPayload` kept growing, never shrinking. Cricket's own
 *  `buildPayload` happens to re-derive every read from the final `kind`
 *  (safe BY DISCIPLINE), but that is a per-skin accident the chassis itself
 *  must not rely on for R3-R7.
 *
 *  Walks `spec.steps` in declaration order, keeping an answer only when its
 *  step is visible against the answers ALREADY kept — a strict left-to-right
 *  fixed point, never against the raw, not-yet-pruned map, so a stale answer
 *  can never itself keep a LATER stale answer alive by being read out of
 *  order (`when` predicates only ever look at earlier steps by convention —
 *  StepPredicate's own doc, types.ts). A spec with no `when` anywhere (every
 *  pre-G2 spec) keeps every answer unchanged: every step is always visible,
 *  so nothing is ever dropped. */
function pruneAnswers(
  spec: GuidedSheetSpec,
  answers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const pruned: Record<string, string> = {};
  for (const step of spec.steps) {
    if (!stepVisible(step, pruned)) continue;
    const value = answers[step.id];
    if (value !== undefined) pruned[step.id] = value;
  }
  return pruned;
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
  const raw = { ...state.answers, [step.id]: value };
  // R6 W-1 (Back path). A step whose `initial` READS this answer must not
  // keep a number derived from the PREVIOUS one. Only fires on a real change,
  // so Back-and-forward that re-picks the same class stays lossless.
  if (state.answers[step.id] !== undefined && state.answers[step.id] !== value) {
    for (const dependent of spec.steps) {
      if (dependent.kind !== "number" || dependent.resetOn === undefined) continue;
      if (dependent.resetOn.includes(step.id)) delete raw[dependent.id];
    }
  }
  // Defect 2 (R2 review): prune before scanning forward AND before handing
  // answers to buildPayload — this step's own answer always survives (it was
  // just visible, or the wizard couldn't have been on it), but an earlier
  // branch's now-unreachable answer must not ride along either place.
  const answers = pruneAnswers(spec, raw);
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
 *  make every button inside it invisible to `walk()`/`textOf()`.
 *
 *  `hintKey` (R2b-over, `SheetChoiceStep.hintKey`'s own doc, types.ts):
 *  rendered VERBATIM-through-`t()` above the button row, same visual
 *  treatment (`text-sm text-slate-600`, same wrapping flex-col) as
 *  `renderNumberStep`'s own hint paragraph below — the two hints differ only
 *  in whether the chassis or the skin resolves the string (that function's
 *  own doc explains why), never in how they render. Undefined/omitted
 *  renders nothing extra, so every pre-existing choice step is unchanged.
 *  Renamed from `hint` (R2b-cricket-over follow-up, hint-field naming pass,
 *  2026-08-17) — see `SheetChoiceStep.hintKey`'s doc (types.ts). */
/** R3/task B4 (owner ruling R3-6): the card-code swatches for an option that
 *  declares `tone` (types.ts's `SheetChoiceStep`). ONE per tone, overlapped —
 *  a second yellow renders a yellow card and a red one, which is what that
 *  card IS. `aria-hidden`, always: the option's own label already SAYS which
 *  card it is (`cardColor.*`, four locales), so the swatch is the sighted
 *  channel for a fact a screen reader already has — never the only carrier.
 *  Class names come from ../tokens, never spelled out here, for the same
 *  single-source reason NIGHT_TILE_CLASSES exists. */
function renderToneSwatches(tones: readonly SportTone[]) {
  if (tones.length === 0) return null;
  return (
    <span aria-hidden="true" className={SPORT_TONE_CLASSES.stack}>
      {tones.map((tone) => (
        <span key={tone} className={`${SPORT_TONE_CLASSES.swatch} ${SPORT_TONE_CLASSES[tone]}`} />
      ))}
    </span>
  );
}

function renderChoiceRow(
  options: readonly SheetChoiceOption[],
  hintKey: string | undefined,
  t: TFn,
  onPick: (id: string) => void,
  blocked?: Blocked,
) {
  return (
    <div className="flex flex-col gap-2">
      {hintKey && <p className="text-sm text-slate-600">{t(hintKey)}</p>}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          // R2c: same treatment renderCandidateRow gives a blocked person —
          // visible, natively disabled, reason as real text, stable data-*.
          // See types.ts's `Blocked` for why blocking beats removing here.
          const reason = blocked?.[opt.id];
          // B4: `tone` washes the button in its LAST entry — the OUTCOME, so a
          // second yellow reads as the sending-off it is — and stamps a stable
          // `data-*` hook a Playwright spec can target without matching a
          // translated label. Untoned options (every option shipped before
          // B4) take neither, so their markup is unchanged.
          const tones = opt.tone ?? [];
          const outcome = tones.length > 0 ? tones[tones.length - 1]! : null;
          const toneClass =
            outcome === null ? "" : ` ${SPORT_TONE_CLASSES.wash} ${SPORT_TONE_CLASSES[outcome]}`;
          return (
            <button
              key={opt.id}
              type="button"
              data-choice-option-id={opt.id}
              {...(outcome ? { "data-choice-option-tone": tones.join(" ") } : {})}
              {...(reason ? { "data-blocked": "true" } : {})}
              disabled={reason !== undefined}
              onClick={reason !== undefined ? undefined : () => onPick(opt.id)}
              style={{ minHeight: 44 }}
              className={
                reason !== undefined
                  ? `${choiceButtonClass}${toneClass} cursor-not-allowed opacity-60`
                  : `${choiceButtonClass}${toneClass}`
              }
            >
              {renderToneSwatches(tones)}
              <span className="break-words">{opt.labelText ?? t(opt.label)}</span>
              {reason !== undefined && (
                <span className="ml-2 break-words text-xs font-normal text-red-600">{reason}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const stepperButtonClass =
  "flex shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-lg font-semibold leading-none text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

const numberFieldClass =
  "min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-center text-base font-semibold tabular-nums text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

/**
 * A `−`/value/`+` stepper plus an editable numeric field for a
 * `SheetNumberStep` — the numeric counterpart to `renderChoiceRow`/
 * `renderCandidateRow` above: a PLAIN FUNCTION, not its own JSX component,
 * for the identical reason those two are (this repo's node-only
 * `_hook-harness` walks a rendered tree through `.props.children` only,
 * never invoking a nested custom component's own function). `min`/`max` are
 * enforced HERE via `clampNumberStep`, on every path that can change
 * `value` — both stepper buttons and the typed field — never left for the
 * skin's own `buildPayload` to catch after the fact (types.ts's own doc on
 * `SheetNumberStep`). `hintText`, when present, is rendered VERBATIM above
 * the control (never through `t()` — it is pre-localised, skin-supplied
 * prose, same rule as `WhoLine.servingLabel`). Renamed from `hint`
 * (R2b-cricket-over follow-up, hint-field naming pass, 2026-08-17) — see
 * `SheetChoiceStep.hintKey`'s doc (types.ts).
 *
 * Unlike the other two row renderers, a tap here does NOT itself advance
 * the wizard: `onConfirm` is a separate, explicit action (reusing the
 * existing `scorepad.action.confirm` key action-form.tsx already uses for
 * the same "I am done editing this value" gesture, rather than minting a
 * new chassis-level key), because a scorer edits a count across several
 * interactions — a few taps, or a typed correction — before it is ready to
 * submit, unlike picking a single option or person.
 *
 * Review fix (follow-up to c70c0e90) — accessible naming for all three
 * controls:
 *  - The field gets `aria-label={t(step.title)}` — choice/person steps
 *    self-label via their button text, but a numeric field's visible
 *    content is just a number, so a screen reader needs the step's own
 *    title (already resolved here) attached directly rather than relying
 *    on the sighted-only title paragraph the PARENT renders outside this
 *    function.
 *  - Fix round (review finding 2, deferred from the chassis review): the
 *    −/+ buttons originally derived their name from that SAME title plus
 *    the bare glyph (`${title} −`) — a stopgap, because the dictionaries
 *    were a parallel agent's files at the time. They are free now.
 *    `pad.sheet.decrease`/`pad.sheet.increase` (dictionaries/{locale}/
 *    ui.json) are dedicated, GENERIC chassis keys — same `pad.sheet.*`
 *    namespace as `pad.sheet.back`/`.cancel` — interpolated with the
 *    step's own already-resolved `{title}`, real per-locale wording rather
 *    than a bare symbol suffix. Checked first, per the earlier report:
 *    `addOns.extraOrg.increase`/`.decrease` is billing-specific (hardcoded
 *    to "extra organisations"), `board.ai.stepperAria`/`.trace.
 *    stepperAria` name a WORKFLOW step indicator, not a numeric +/-
 *    control — neither reusable, confirming the earlier finding rather
 *    than assuming it. Deliberately NOT added to `PAD_LABEL_KEYS`
 *    (scoring-vocab.ts): that registry mirrors the ENGINE's own
 *    `padSpec(cfg)` output, and this chassis-level control is not
 *    something any sport module emits — same reason `pad.sheet.back`/
 *    `.cancel` were never in it either.
 */
function renderNumberStep(
  step: SheetNumberStep,
  value: number,
  t: TFn,
  onChange: (value: number) => void,
  onConfirm: () => void,
) {
  const title = t(step.title);
  return (
    <div className="flex flex-col gap-3">
      {step.hintText && <p className="text-sm text-slate-600">{step.hintText}</p>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={t("pad.sheet.decrease", { title })}
          onClick={() => onChange(clampNumberStep(value - 1, step))}
          style={{ minHeight: 44, minWidth: 44 }}
          className={stepperButtonClass}
        >
          −
        </button>
        <input
          type="number"
          data-testid="pad-sheet-number"
          inputMode="numeric"
          aria-label={title}
          min={step.min}
          max={step.max}
          value={value}
          style={{ minHeight: 44 }}
          className={numberFieldClass}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = Number(raw);
            if (Number.isNaN(n)) return;
            onChange(clampNumberStep(n, step));
          }}
        />
        <button
          type="button"
          aria-label={t("pad.sheet.increase", { title })}
          onClick={() => onChange(clampNumberStep(value + 1, step))}
          style={{ minHeight: 44, minWidth: 44 }}
          className={stepperButtonClass}
        >
          +
        </button>
      </div>
      <button type="button" data-testid="pad-sheet-confirm" onClick={onConfirm} style={{ minHeight: 44 }} className={choiceButtonClass}>
        {t("scorepad.action.confirm")}
      </button>
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

  // Task 2 (R2b): a "number" step's in-progress edit value. Unlike a choice
  // option or a person candidate — where a single tap both PICKS and
  // ADVANCES — a scorer adjusts a count across several stepper taps or a
  // typed correction before it is ready to submit, so that value has to
  // live somewhere BETWEEN renders. Render-phase reset (the same "two
  // useStates" pattern detail-dock.tsx uses for "reset when the thing being
  // edited changes" — `react-hooks/refs` bans reading/writing a ref during
  // render, so a single ref-based "last id" guard is not an option here):
  // whenever the CURRENT step's id no longer matches the id this value was
  // last seeded for, reseed it — from whatever answer this step already
  // carries (Back must not blank out a value the scorer already entered),
  // falling back to the step's own `initial`. `numberEditStepId` is
  // explicitly cleared back to `null` at both `setState(initialSheetState())`
  // call sites below (completion, cancel) — without that, this check alone
  // cannot tell "freshly mounted" apart from "the wizard just completed and
  // reopened on a first step whose id happens to repeat" (both look like
  // stepIndex 0 with an empty answers map to this check alone).
  const [numberEditStepId, setNumberEditStepId] = useState<string | null>(null);
  const [numberEditValue, setNumberEditValue] = useState(0);
  if (step && step.kind === "number" && step.id !== numberEditStepId) {
    const prior = state.answers[step.id];
    const seeded = prior !== undefined ? Number(prior) : resolveInitial(step, state.answers);
    setNumberEditStepId(step.id);
    setNumberEditValue(clampNumberStep(seeded, step));
  }

  const handleAnswer = (value: string) => {
    const outcome = answerStep(spec, state, value);
    if (outcome.done) {
      setState(initialSheetState());
      setNumberEditStepId(null);
      onComplete(outcome.event);
    } else {
      setState(outcome.state);
    }
  };
  const handleBack = () => setState((s) => backStep(spec, s));
  const handleCancel = () => {
    setState(initialSheetState());
    setNumberEditStepId(null);
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
          ? renderChoiceRow(step.options, step.hintKey, t, handleAnswer, step.blocked?.(state.answers))
          : step.kind === "number"
            ? renderNumberStep(step, numberEditValue, t, setNumberEditValue, () => handleAnswer(String(numberEditValue)))
            : renderPersonStep(step, views[step.side], personNames, t, handleAnswer, emptyText)}
      </div>
      <div className="flex justify-end px-4 pb-3">
        <button type="button" onClick={handleCancel} style={{ minHeight: 44 }} className={cancelButtonClass}>
          {t("pad.sheet.cancel")}
        </button>
      </div>
    </div>
  );
}
