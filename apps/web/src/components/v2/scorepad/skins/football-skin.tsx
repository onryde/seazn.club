"use client";
// Football skin (S11/#420 W9) -- hand-crafted clock-and-goals layout,
// football only. Contract: ./types.ts.
//
// WHY ITS OWN SKIN (measured this session, see registry.ts's own header and
// the dispatch brief -- not re-litigated here): football is a hand-written
// module with `subs`/`penalties` panels the period pair (hockey/icehockey,
// period-skin.tsx) does not have at all; the pair has a `setPiece` and a
// gated `shootout` football lacks; discipline diverges structurally
// (football: `card` color/reason plus separate `sinbin.start`/`.end`; the
// pair: one suspension panel with a `servedBy` attribution football has no
// equivalent of).
//
// PURE/IMPURE SPLIT (types.ts's own rule): `footballLayout` below is pure --
// no React, no DOM, no i18n lookup -- and is called directly by
// skin-coverage.test.ts (every skin, every sport, whole cfg space) and by
// football-skin.test.ts (this sport alone, more scrutiny on the goal/card/
// sub flows). `FootballSkin` (the Component) is the only export that touches
// `useMsg()`/JSX, and draws nothing `footballLayout` did not already decide
// -- it never re-derives which action goes where or at what prominence.
//
// A GAP FOUND WHILE BUILDING THIS SKIN, partly closed since (S12/#421 pass
// B): `SkinProps` (types.ts) hands a skin `ctx.state` and, as of S11,
// `ctx.personNames` (id -> display name) -- but STILL no `lineups` (the
// kickoff team sheet), which the chassis's shared `AttributionPicker`
// (../attribution-picker.tsx) also requires. `lineups` does not reach a skin
// today, and types.ts/pad-renderer.tsx are not this skin's files to widen, so
// this Component still reads football's own live `state.squads` (private
// `FootballSquad`, person ids only) directly rather than routing through the
// shared picker -- because football's own `onPitch`/`bench` already move on
// every `football.sub`/`.card`/`.sinbin.*`, it is in fact MORE live than the
// shared picker's own kickoff-sheet fallback would be for this sport. Each
// candidate now renders through `personOptions`, which resolves
// `ctx.personNames[id]` and falls back to the id itself only when no name is
// known -- the raw-id fallback that used to be unconditional.
//
// THE S10 FINDING THE BRIEF NAMED: football's `State.squads` is a PRIVATE
// `FootballSquad`, not the kernel's shared `SquadState` (S3/#426's ONE squad
// model) -- so the shared picker's live-squad tier never recognises it and
// would fall back to a static kickoff sheet, stale after every substitution.
// This file sidesteps that entirely by reading football's OWN squad shape
// directly (see `footballRoster` below) rather than routing through the
// shared, kernel-shaped picker at all.
import { useState, type ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { enumLabel, padLabel, type MsgFn } from "@/lib/scoring-vocab";
import type { PadFieldEnum, PadFieldValue } from "@seazn/engine/sport";
import { ActionForm, type ActionValues } from "../action-form";
import { attributionItemCaption } from "../attribution-picker";
import { deriveFieldPathLabel, type PadActionView, type PadView } from "../view-model";
import {
  actionByType,
  type SkinDef,
  type SkinDispatch,
  type SkinGroup,
  type SkinHeader,
  type SkinLayout,
  type SkinLayoutCtx,
  type SkinProminence,
  type SkinProps,
} from "./types";
import { renderLockedTile, chipClass } from "./shared";

/** `useMsg()`'s own return type (dict-provider.tsx), which supports `vars`
 *  interpolation -- WIDER than `@/lib/scoring-vocab`'s `MsgFn` (single
 *  argument only, all this file needs everywhere else: `padLabel`,
 *  `enumLabel`, `attributionItemCaption` all take that narrower shape). Only
 *  the queue status line below needs `{count}` interpolation
 *  (`scorepad.queue.pending`), hence this second, wider alias just for it --
 *  a `MsgFn`-typed value narrows away the optional second parameter, so
 *  calling it with `vars` through that narrower type is a real tsc error,
 *  not a style choice. */
type FullMsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// Pure state readers. `ctx.state`/`SkinProps.ctx.state` is `unknown` by
// contract -- these never trust its shape, matching this repo's established
// convention for reading a folded engine state defensively
// (attribution-picker.tsx's own `isSquadState`/`resolveSquads`). Both the
// shared coverage gate and this skin's own test file call `layout()` with
// `state: {}` for EVERY cfg in the sweep, so every reader below must degrade
// cleanly from an empty object, never throw.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readGoals(state: unknown): { home: number; away: number } {
  const goals = asRecord(asRecord(state)?.goals);
  const home = goals?.home;
  const away = goals?.away;
  return { home: typeof home === "number" ? home : 0, away: typeof away === "number" ? away : 0 };
}

/** football.ts's own `Phase` union, read as a bare string -- this file has
 *  no reason to import the engine's private type. "pre" is football's own
 *  documented starting value (`init` always sets it first). */
function readPhase(state: unknown): string {
  const phase = asRecord(state)?.phase;
  return typeof phase === "string" && phase.length > 0 ? phase : "pre";
}

const CLOCK_PLACEHOLDER = "—"; // em dash -- same placeholder convention as summary()'s own headline (view-model.ts's `summaryHeadline`)

/** MM:SS, only when the state's own `asOf` stamp names the CURRENT phase --
 *  the same guard football.ts's own (unexported) `footballPosition` applies
 *  (`asOf.period === phase`) before trusting a stamp's elapsed reading, so a
 *  stamp left over from a phase the match has since left never reads as
 *  "now" (§6 obligation 3's own point, applied here). Stated fresh as one
 *  `===` check rather than importing a private function -- see this file's
 *  header on why that is the right call, not a fork risk: it is one
 *  comparison, not `footballPosition`'s multi-source evidence merge. */
function readClock(state: unknown, phase: string): string {
  const asOf = asRecord(asRecord(state)?.asOf);
  const period = asOf?.period;
  const elapsed = asOf?.elapsed;
  if (period !== phase || typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) {
    return CLOCK_PLACEHOLDER;
  }
  const minutes = Math.floor(elapsed / 60);
  const seconds = Math.floor(elapsed % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The real entrant id for a side, straight off `state.entrants` (present
 *  from football's very first fold -- `init` sets it before any event).
 *  Falls back to the literal side name only for a Component mounted before
 *  any real state exists, which the server correctly refuses rather than
 *  this file trying to fabricate a plausible id. */
function readEntrantId(state: unknown, side: "home" | "away"): string {
  const entrants = asRecord(asRecord(state)?.entrants);
  const id = entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function buildHeader(ctx: SkinLayoutCtx): SkinHeader {
  const { home, away } = readGoals(ctx.state);
  const phase = readPhase(ctx.state);
  return {
    fields: [
      { id: "score", value: `${home} - ${away}`, captionKey: "scorepad.skin.football.header.score", emphasis: true },
      { id: "clock", value: readClock(ctx.state, phase), captionKey: "scorepad.skin.football.header.clock", emphasis: true },
      { id: "period", value: phase, captionKey: "scorepad.skin.football.header.period", emphasis: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// Grouping. Every action football's padSpec declares (football.ts:2191-2355)
// bucketed into this skin's hand-crafted groups. `goals`/`period` are the
// primary surface (acceptance criterion 2 -- two big goal buttons and the
// clock); `cards`/`subs`/`shots` are one tap away (SECONDARY, never behind a
// disclosure); `penalties` keeps its own drawer (it has a dedicated i18n
// group key, below); `sinbin.start`/`.end` and the conditional
// `shootout.kick` share ONE drawer -- football's padSpec has 7 named panels
// but the brief supplied only 6 `scorepad.skin.football.group.*` keys (no
// `sinbin` key exists in any of the 4 locale dictionaries -- verified before
// writing this), so this skin folds both keyless groups into the
// `scorepad.skin.more` key the brief supplied for exactly this purpose,
// rather than hardcoding English or editing a dictionary.
// ---------------------------------------------------------------------------

interface GroupSpec {
  id: string;
  prominence: SkinProminence;
  types: readonly string[];
}

const KNOWN_GROUPS: readonly GroupSpec[] = [
  { id: "goals", prominence: "primary", types: ["football.goal"] },
  { id: "period", prominence: "primary", types: ["football.period"] },
  { id: "cards", prominence: "secondary", types: ["football.card"] },
  { id: "subs", prominence: "secondary", types: ["football.sub"] },
  { id: "shots", prominence: "secondary", types: ["football.shot"] },
  { id: "penalties", prominence: "drawer", types: ["football.penalty"] },
  { id: "more", prominence: "drawer", types: ["football.sinbin.start", "football.sinbin.end", "football.shootout.kick"] },
];

function footballLayout(view: PadView, ctx: SkinLayoutCtx): SkinLayout {
  const present = new Set(view.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
  const placed = new Set<string>();
  const groups: SkinGroup[] = [];

  for (const spec of KNOWN_GROUPS) {
    const actions = spec.types.filter((type) => present.has(type));
    for (const type of actions) placed.add(type);
    if (actions.length > 0) groups.push({ id: spec.id, prominence: spec.prominence, actions });
  }

  // Forward-compat net (never exercised against today's real spec -- see
  // football-skin.test.ts's own "never falls back to the unlisted
  // safety-net group" test): a type this table does not know about still
  // gets PLACED, in its own separate drawer group, rather than silently
  // failing the coverage gate outright.
  const leftover = [...present].filter((type) => !placed.has(type)).sort();
  if (leftover.length > 0) groups.push({ id: "more-unlisted", prominence: "drawer", actions: leftover });

  return { header: buildHeader(ctx), groups };
}

// ---------------------------------------------------------------------------
// Component. Everything below touches React/i18n and draws exactly what
// `footballLayout` decided above -- nothing here re-derives placement or
// prominence.
// ---------------------------------------------------------------------------

const GROUP_LABEL_KEY: Readonly<Record<string, MessageKey>> = {
  goals: "scorepad.skin.football.group.goals",
  period: "scorepad.skin.football.group.period",
  cards: "scorepad.skin.football.group.cards",
  subs: "scorepad.skin.football.group.subs",
  shots: "scorepad.skin.football.group.shots",
  penalties: "scorepad.skin.football.group.penalties",
  more: "scorepad.skin.more",
};

/** `scorepad.skin.more` for any group this file did not name explicitly --
 *  covers `more` itself plus the forward-compat `more-unlisted` net. */
function groupLabelKey(id: string): MessageKey {
  return GROUP_LABEL_KEY[id] ?? "scorepad.skin.more";
}

interface FootballRosterSide {
  onPitch: readonly string[];
  bench: readonly string[];
}

function toStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Reads football's OWN private `state.squads[side]` directly -- see this
 *  file's header on why that is the right call for football specifically,
 *  not a routing through the kernel-shaped shared picker. Person ids only,
 *  structurally checked; degrades to an empty roster for any shape that
 *  isn't this, rather than throwing. */
function footballRoster(state: unknown, side: "home" | "away"): FootballRosterSide {
  const squads = asRecord(asRecord(state)?.squads);
  const squad = asRecord(squads?.[side]);
  return { onPitch: toStringArray(squad?.onPitch), bench: toStringArray(squad?.bench) };
}

/** Chip label for a person candidate. Resolves through `ctx.personNames`
 *  (this file's header); the raw id is the last-resort fallback, never a
 *  crash or a blank label, so this skin stays total without a roster. */
function personOptions(
  ids: readonly string[],
  personNames: Readonly<Record<string, string>> | undefined,
): { value: string; label: string }[] {
  return ids.map((id) => ({ value: id, label: personNames?.[id] ?? id }));
}

interface ChipOption {
  value: string;
  label: string;
}

/** One labelled row of tap-to-select chips -- single select, re-tap clears.
 *  A plain function, not a component: this repo's node-only `_hook-harness`
 *  walks a rendered tree by descending into `.props.children` only
 *  (attribution-picker.tsx's own `renderAttributionItem` states the same
 *  reason), so a genuinely separate `<ChipRow/>` would hide every chip from
 *  it once this skin is reachable from a real page. */
function renderChipRow(
  caption: string,
  options: readonly ChipOption[],
  value: string | undefined,
  onSelect: (v: string | undefined) => void,
  msg: MsgFn,
  emptyKey: MessageKey,
): ReactNode {
  return (
    <div className="space-y-1">
      <span className="label !mb-0">{caption}</span>
      {options.length === 0 ? (
        <p className="text-xs text-slate-400">{msg(emptyKey)}</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {options.map((opt) => {
            const pressed = value === opt.value;
            return (
              <button key={opt.value} type="button" aria-pressed={pressed} onClick={() => onSelect(pressed ? undefined : opt.value)} className={chipClass(pressed)}>
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface QuickSlot {
  /** Payload path this slot writes -- "scorer" | "assist" | "person" | "off" | "on" | "color". */
  path: string;
  required: boolean;
  caption: string;
  options: readonly ChipOption[];
}

interface QuickActionCardProps {
  title: string;
  slots: readonly QuickSlot[];
  submitting: boolean;
  msg: MsgFn;
  onFire: (values: Record<string, string>) => void;
}

/**
 * The fast, tap-optimised tile for football.goal/.card/.sub -- session
 * report has the audited tap counts this produces.
 *
 * RULE: tapping a chip in the LAST slot fires immediately once every
 * REQUIRED slot (this one included, if it is required) is satisfied.
 * Tapping a chip in any OTHER slot only records the value; an explicit
 * Confirm is always available once every required slot is satisfied, for
 * "stop here without touching the last slot". Deselecting a chip (tapping
 * it again) never fires, whichever slot it is in.
 *
 * A REAL component (owns per-instance `useState`), unlike every plain
 * `render*` function in this file -- same reason `ActionForm` is one
 * (panel.tsx's own header).
 */
function QuickActionCard({ title, slots, submitting, msg, onFire }: QuickActionCardProps) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string | undefined>>({});

  function reset() {
    setValues({});
    setOpen(false);
  }

  function satisfied(candidate: Record<string, string | undefined>): boolean {
    return slots.every((slot) => !slot.required || candidate[slot.path] !== undefined);
  }

  function fire(candidate: Record<string, string | undefined>) {
    const payload: Record<string, string> = {};
    for (const [path, value] of Object.entries(candidate)) if (value !== undefined) payload[path] = value;
    onFire(payload);
    reset();
  }

  function pick(slotIndex: number, path: string, value: string | undefined) {
    const next = { ...values, [path]: value };
    setValues(next);
    if (value !== undefined && slotIndex === slots.length - 1 && satisfied(next)) fire(next);
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary h-14 w-full text-base" onClick={() => setOpen(true)} disabled={submitting}>
        {title}
      </button>
    );
  }

  const canConfirm = satisfied(values) && !submitting;

  return (
    <div className="card space-y-3 border-2 border-accent-line p-3">
      <p className="label !mb-0">{title}</p>
      {slots.map((slot, index) => (
        <div key={slot.path}>{renderChipRow(slot.caption, slot.options, values[slot.path], (v) => pick(index, slot.path, v), msg, "scorepad.attribution.noRoster")}</div>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost flex-1" onClick={reset} disabled={submitting}>
          {msg("scorepad.action.cancel")}
        </button>
        <button type="button" className="btn btn-primary flex-1" disabled={!canConfirm} onClick={() => fire(values)}>
          {msg("scorepad.action.confirm")}
        </button>
      </div>
    </div>
  );
}

interface QuickSectionArgs {
  view: PadView;
  state: unknown;
  type: string;
  submittingType: string | null;
  dispatch: SkinDispatch;
  msg: MsgFn;
  buildSlots: (action: PadActionView, roster: FootballRosterSide, actionLabel: string) => readonly QuickSlot[];
}

/** One side-by-side pair of `QuickActionCard`s (home, away) for one action
 *  type -- side is folded into WHICH card a scorer taps, at zero extra taps,
 *  exactly like `by` folds into which side's card in the v1 pad. */
function renderQuickSection(args: QuickSectionArgs): ReactNode {
  const { view, state, type, submittingType, dispatch, msg, buildSlots } = args;
  const action = actionByType(view, type);
  if (!action) return null;
  if (action.availability.kind === "locked") return renderLockedTile(action, msg);
  const actionLabel = padLabel(action.labelKey.key, msg, action.labelKey.label);
  const submitting = submittingType === type;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {(["home", "away"] as const).map((side) => {
        const sideLabel = msg(side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away");
        const roster = footballRoster(state, side);
        const slots = buildSlots(action, roster, actionLabel);
        return (
          <QuickActionCard
            key={side}
            title={`${sideLabel} · ${actionLabel}`}
            slots={slots}
            submitting={submitting}
            msg={msg}
            onFire={(values) => void dispatch(type, { by: readEntrantId(state, side), ...values })}
          />
        );
      })}
    </div>
  );
}

/** One tap per marker -- `phase` is the action's only field this skin treats
 *  as required (addedMinutes/the `at` stamp stay reachable only through the
 *  generic path, see the deviations note in the session report), and
 *  `football.period` carries no attribution at all (a whistle belongs to
 *  neither side -- football.ts's own comment on `periodAction`). */
function renderPeriodStrip(view: PadView, dispatch: SkinDispatch, submittingType: string | null, msg: MsgFn): ReactNode {
  const action = actionByType(view, "football.period");
  if (!action) return null;
  if (action.availability.kind === "locked") return renderLockedTile(action, msg);
  const phaseField = action.fields.find((f): f is PadFieldEnum => f.kind === "enum" && f.path === "phase");
  const markers = phaseField?.values ?? [];
  const submitting = submittingType === "football.period";
  return (
    <div className="flex flex-wrap gap-2">
      {markers.map((marker) => (
        <button
          key={marker}
          type="button"
          disabled={submitting}
          onClick={() => void dispatch("football.period", { phase: marker })}
          className="btn btn-primary h-11 min-w-[4.5rem] flex-1 text-sm"
        >
          {enumLabel("phase", marker, msg)}
        </button>
      ))}
    </div>
  );
}

/** Generic attribution renderer for the actions NOT on a fast tile (shots,
 *  penalties, sin bin start/end, the shoot-out kick) -- plugged into
 *  `ActionForm`'s own `renderAttribution` seam, same shape the chassis's
 *  default (`AttributionPicker`) fills, but sourced from football's own
 *  roster (this file's header) instead of a `lineups` this skin is never
 *  handed. A "side" item offers the two real entrant ids (home/away,
 *  generic-labelled -- `AttributionPicker` does the same, never a team
 *  NAME); a "person" item offers the pooled on-pitch + bench roster from
 *  BOTH sides, matching `candidatesForPerson`'s own "either side" scope for
 *  an item that does not itself name one (cricket's fielder is the
 *  precedent cited there). */
function renderFootballAttribution(
  action: PadActionView,
  values: ActionValues,
  setValue: (path: string, value: PadFieldValue | undefined) => void,
  state: unknown,
  personNames: Readonly<Record<string, string>> | undefined,
  msg: MsgFn,
): ReactNode {
  if (action.attribution.length === 0) return null;
  const actionLabel = padLabel(action.labelKey.key, msg, action.labelKey.label);
  const home = footballRoster(state, "home");
  const away = footballRoster(state, "away");
  const bothSides = personOptions([...home.onPitch, ...home.bench, ...away.onPitch, ...away.bench], personNames);
  return (
    <div className="space-y-3" data-role="football-attribution">
      {action.attribution.map((item, index) => {
        const caption = attributionItemCaption(item, index, msg, actionLabel);
        const options: ChipOption[] =
          item.kind === "side"
            ? (["home", "away"] as const).map((side) => ({
                value: readEntrantId(state, side),
                label: msg(side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away"),
              }))
            : bothSides;
        const current = values[item.path];
        return (
          <div key={item.path}>{renderChipRow(caption, options, typeof current === "string" ? current : undefined, (v) => setValue(item.path, v), msg, "scorepad.attribution.noRoster")}</div>
        );
      })}
    </div>
  );
}

/** One action, rendered via the shared `ActionForm` -- the un-optimised
 *  path for the drawer/shots groups: full fields, full attribution,
 *  expand/confirm/cancel exactly like the universal renderer draws it. */
function renderGenericAction(
  view: PadView,
  type: string,
  dispatch: SkinDispatch,
  submittingType: string | null,
  msg: MsgFn,
  renderAttribution: (action: PadActionView, values: ActionValues, setValue: (path: string, value: PadFieldValue | undefined) => void) => ReactNode,
): ReactNode {
  const action = actionByType(view, type);
  if (!action) return null;
  if (action.availability.kind === "locked") return renderLockedTile(action, msg);
  return <ActionForm key={action.type + action.labelKey.key} action={action} submitting={submittingType === type} onSubmit={(payload) => void dispatch(type, payload)} renderAttribution={renderAttribution} />;
}

interface FootballGroupArgs {
  view: PadView;
  state: unknown;
  dispatch: SkinDispatch;
  submittingType: string | null;
  msg: MsgFn;
  renderAttribution: (action: PadActionView, values: ActionValues, setValue: (path: string, value: PadFieldValue | undefined) => void) => ReactNode;
  personNames: Readonly<Record<string, string>> | undefined;
}

function renderGoalsGroup(args: FootballGroupArgs): ReactNode {
  return renderQuickSection({
    view: args.view,
    state: args.state,
    type: "football.goal",
    submittingType: args.submittingType,
    dispatch: args.dispatch,
    msg: args.msg,
    buildSlots: (action, roster, actionLabel) => {
      const options = personOptions(roster.onPitch, args.personNames);
      const slots: QuickSlot[] = [];
      const scorerItem = action.attribution.find((a) => a.path === "scorer");
      const assistItem = action.attribution.find((a) => a.path === "assist");
      if (scorerItem) slots.push({ path: "scorer", required: false, caption: attributionItemCaption(scorerItem, action.attribution.indexOf(scorerItem), args.msg, actionLabel), options });
      if (assistItem) slots.push({ path: "assist", required: false, caption: attributionItemCaption(assistItem, action.attribution.indexOf(assistItem), args.msg, actionLabel), options });
      return slots;
    },
  });
}

function renderPeriodGroup(args: FootballGroupArgs): ReactNode {
  return renderPeriodStrip(args.view, args.dispatch, args.submittingType, args.msg);
}

function renderCardsGroup(args: FootballGroupArgs): ReactNode {
  return renderQuickSection({
    view: args.view,
    state: args.state,
    type: "football.card",
    submittingType: args.submittingType,
    dispatch: args.dispatch,
    msg: args.msg,
    buildSlots: (action, roster, actionLabel) => {
      const slots: QuickSlot[] = [];
      const colorField = action.fields.find((f): f is PadFieldEnum => f.kind === "enum" && f.path === "color");
      if (colorField) {
        const caption = colorField.labelKey ? padLabel(colorField.labelKey.key, args.msg, colorField.labelKey.label) : deriveFieldPathLabel("color");
        slots.push({ path: "color", required: true, caption, options: colorField.values.map((v) => ({ value: v, label: enumLabel("color", v, args.msg) })) });
      }
      const personItem = action.attribution.find((a) => a.path === "person");
      if (personItem) slots.push({ path: "person", required: false, caption: attributionItemCaption(personItem, action.attribution.indexOf(personItem), args.msg, actionLabel), options: personOptions(roster.onPitch, args.personNames) });
      return slots;
    },
  });
}

function renderSubsGroup(args: FootballGroupArgs): ReactNode {
  return renderQuickSection({
    view: args.view,
    state: args.state,
    type: "football.sub",
    submittingType: args.submittingType,
    dispatch: args.dispatch,
    msg: args.msg,
    buildSlots: (action, roster, actionLabel) => {
      const slots: QuickSlot[] = [];
      const offItem = action.attribution.find((a) => a.path === "off");
      const onItem = action.attribution.find((a) => a.path === "on");
      if (offItem) slots.push({ path: "off", required: true, caption: attributionItemCaption(offItem, action.attribution.indexOf(offItem), args.msg, actionLabel), options: personOptions(roster.onPitch, args.personNames) });
      if (onItem) slots.push({ path: "on", required: true, caption: attributionItemCaption(onItem, action.attribution.indexOf(onItem), args.msg, actionLabel), options: personOptions(roster.bench, args.personNames) });
      return slots;
    },
  });
}

/** Any group that is not one of the four hand-tuned tiles above -- "shots"
 *  (already generic pre-fix) and any FUTURE `KNOWN_GROUPS` entry this table
 *  has not been taught a bespoke tile for. Same per-action `ActionForm`
 *  render the drawer below has always used, so a new primary/secondary
 *  group still reaches the screen instead of silently vanishing -- the S11
 *  review gap this fix closes (see `renderFootballGroupContent`'s own
 *  comment). */
function renderGenericGroup(group: SkinGroup, args: FootballGroupArgs): ReactNode {
  return <div className="space-y-2">{group.actions.map((type) => renderGenericAction(args.view, type, args.dispatch, args.submittingType, args.msg, args.renderAttribution))}</div>;
}

const GROUP_RENDERERS: Readonly<Record<string, (args: FootballGroupArgs) => ReactNode>> = {
  goals: renderGoalsGroup,
  period: renderPeriodGroup,
  cards: renderCardsGroup,
  subs: renderSubsGroup,
};

/**
 * Primary/secondary group content, driven by `layout.groups` -- the fix for
 * the S11 review gap. Before: the Component gated on five hardcoded literal
 * `.has("football.X")` checks, so a `KNOWN_GROUPS` entry placed at primary
 * or secondary prominence under any OTHER id satisfied the coverage gate
 * (`layoutActionTypes` flattens every group) while rendering nothing at all
 * -- the drawer below was the only section already walking `layout.groups`
 * generically. Now every group this skin's `layout()` produces reaches a
 * tile: a recognised id gets its tuned tap-optimised treatment (unchanged by
 * this fix -- same `renderQuickSection`/`renderPeriodStrip` calls as
 * before, same tap counts), anything else falls back to the same generic
 * per-action render the drawer already used.
 */
function renderFootballGroupContent(group: SkinGroup, args: FootballGroupArgs): ReactNode {
  const renderer = GROUP_RENDERERS[group.id];
  return renderer ? renderer(args) : renderGenericGroup(group, args);
}

function renderSection(id: string, msg: MsgFn, content: ReactNode): ReactNode {
  return (
    <section key={id} className="card p-3">
      <h3 className="label !mb-2">{msg(groupLabelKey(id))}</h3>
      {content}
    </section>
  );
}

function renderHeader(layout: SkinLayout, queueDepth: number, offline: boolean, msg: FullMsgFn): ReactNode {
  if (!layout.header) return null;
  const queueLabel = offline ? msg("scorepad.queue.offline") : queueDepth > 0 ? msg("scorepad.queue.pending", { count: queueDepth }) : msg("scorepad.queue.synced");
  const attention = offline || queueDepth > 0;
  return (
    <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
      <div className="flex flex-wrap items-center justify-around gap-3 px-3 pb-2 pt-3 text-center">
        {layout.header.fields.map((field) => (
          <div key={field.id}>
            {field.captionKey && (
              // `SkinHeaderField.captionKey` is deliberately `string | null`,
              // not `MessageKey` -- types.ts keeps the pure layout contract
              // decoupled from apps/web's generated dictionary union (see
              // this file's own header). Safe here: `buildHeader` above is
              // this value's only producer, and it never writes anything but
              // a literal, hand-verified key.
              // S13/#422 W11 cutover — text-slate-500 on bg-slate-900 ~3.74:1,
              // below AA's 4.5:1 (same pattern as period-skin.tsx's header
              // caption, dac2b6bb). text-slate-400 clears it at ~6.79:1.
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{msg(field.captionKey as MessageKey)}</p>
            )}
            <p className={field.emphasis ? "text-xl font-bold tabular-nums tracking-tight text-white sm:text-2xl" : "text-sm font-semibold tabular-nums text-slate-300"}>{field.value}</p>
          </div>
        ))}
      </div>
      <div className={`flex items-center justify-center gap-1.5 border-t border-slate-800/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest ${attention ? "text-amber-400" : "text-emerald-400"}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${attention ? "animate-live-pulse bg-amber-400" : "bg-emerald-400"}`} />
        {queueLabel}
      </div>
    </header>
  );
}

export function FootballSkin(props: SkinProps) {
  const msg = useMsg();
  const { view, layout, dispatch, submittingType, ctx, queueDepth, offline } = props;
  const state = ctx.state;

  const primaryGroups = layout.groups.filter((g) => g.prominence === "primary");
  const secondaryGroups = layout.groups.filter((g) => g.prominence === "secondary");
  const drawerGroups = layout.groups.filter((g) => g.prominence === "drawer");

  const renderAttribution = (action: PadActionView, values: ActionValues, setValue: (path: string, value: PadFieldValue | undefined) => void) => renderFootballAttribution(action, values, setValue, state, ctx.personNames, msg);
  const groupArgs: FootballGroupArgs = { view, state, dispatch, submittingType, msg, renderAttribution, personNames: ctx.personNames };

  return (
    <div className="space-y-3" data-role="football-skin">
      {renderHeader(layout, queueDepth, offline, msg)}

      {primaryGroups.map((group) => renderSection(group.id, msg, renderFootballGroupContent(group, groupArgs)))}

      {secondaryGroups.map((group) => renderSection(group.id, msg, renderFootballGroupContent(group, groupArgs)))}

      {drawerGroups.map((group) => (
        <details key={group.id} className="card group p-3">
          <summary className="btn btn-ghost w-full cursor-pointer list-none justify-between">
            <span>{msg(groupLabelKey(group.id))}</span>
            <span aria-hidden className="text-xs text-purple-400 group-open:rotate-180">
              &#9662;
            </span>
          </summary>
          <div className="mt-3 space-y-2">{group.actions.map((type) => renderGenericAction(view, type, dispatch, submittingType, msg, renderAttribution))}</div>
        </details>
      ))}
    </div>
  );
}

export const footballSkin: SkinDef = {
  key: "football",
  sports: ["football"],
  layout: footballLayout,
  Component: FootballSkin,
};
