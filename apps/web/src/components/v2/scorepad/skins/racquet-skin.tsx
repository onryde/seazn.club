"use client";
// Racquet/net skin (S11/#420 W9). Rally-first layout for the three
// setbased/kernel.ts sports: volleyball, badminton, tabletennis — one shared
// action family ({key}.rally/.timeout/.sanction/.sub/.expedite.start), gated
// per sport/variant by cfg.records.*, plus a runtime gate on the
// expedite-scoring panel. See the dispatch brief; contract in ./types.ts.
//
// layout() never keys on a sport name. Badminton has no timeouts/subs;
// tabletennis has no subs but does have expedite; beach volleyball drops subs
// that indoor keeps — a layout keyed on "volleyball" vs "badminton" would
// pass for one and drop actions for another (the brief's own measured
// warning). Instead every DISTINCT action type present in the view is
// classified by its kernel-shared SUFFIX (".rally", ".summary", ".timeout",
// ".sanction", ".sub", ".expedite.start") — the one part of the vocabulary
// all three sports share by construction (setbased/kernel.ts:998-1180,
// coarseEventType aside: "set.summary" vs "game.summary" both end in
// ".summary"). An unrecognised suffix (defensive — a future kernel addition)
// lands in a catch-all "more" drawer rather than being silently dropped, so
// "no skin hides an action" holds even against a type this file predates.
//
// THE RALLY TYPE CAN NAME MORE THAN ONE ACTION IN ONE VIEW. `{key}.rally`
// covers THREE distinct PadAction shapes on this kernel: plain (`wonBy`
// only), attributed (+server/scorer), and — once table tennis's expedite
// fires — the returns/serving variant (setbased/kernel.ts:1008-1076). All
// three share one TYPE STRING, spread across TWO panels ("Rally" always
// shown; "Expedite scoring" gated on `state.expedite`). This file collects
// the view's DISTINCT types ONCE, across every panel together, before
// classifying — never per-panel — or the same type would be placed twice and
// fail the shared gate's "no skin places the same action twice" check. See
// racquet-skin.test.ts's "collapses across two panels" test for the pinned
// proof, and the coverage sweep's own `fullView` (skin-coverage.test.ts),
// which is gate-free and so hands this file BOTH panels at once for every
// cfg where `cfg.records.expedite` is true — i.e. on every tabletennis cfg.
//
// THE HEADER'S "serving" FIELD IS A DELIBERATE PLACEHOLDER, NOT A GAP: the
// kernel holds no serving state at all — SetBasedRally's own doc comment,
// twice over: "the set-based kernel holds no serving state ... so the engine
// cannot name the receiver from what it stores." Badminton/volleyball serve
// on point-won and table tennis rotates on a fixed count; neither is
// derivable from `SetBasedState`, and `SkinProps` hands a skin no
// lineup/roster context to compute it independently either (see the
// Component section below). "—" is this codebase's own established "no
// value yet" glyph (view-model.ts's `summaryHeadline` doc cites generic's own
// headline convention), so the field stays honest rather than fabricating a
// side. It is still always PRESENT — satisfies the coverage gate's "score
// header for every variant" — just not always meaningful.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { padLabel } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
import type { PadFieldValue } from "@seazn/engine/sport";
import { ActionForm, type ActionValues } from "../action-form";
import type { PadActionView, PadView } from "../view-model";
import {
  type SkinDef,
  type SkinDispatch,
  type SkinGroup,
  type SkinHeader,
  type SkinHeaderField,
  type SkinLayout,
  type SkinLayoutCtx,
  type SkinProminence,
  type SkinProps,
} from "./types";
import { renderLockedTile } from "./shared";

// ---------------------------------------------------------------------------
// layout() — PURE. No React, no DOM, no i18n lookup (types.ts's own rule):
// apps/web's vitest is `environment: "node"` (vitest.config.ts:71), so
// skin-coverage.test.ts and this file's own tests can only ever assert on
// this function's DATA output, never on rendered markup.
// ---------------------------------------------------------------------------

type GroupId = "rally" | "setScore" | "timeouts" | "sanctions" | "subs" | "expedite" | "more";

// Draw order AND the fixed prominence each group draws at. "more" sits last,
// at drawer prominence — a safety net, never the headline surface.
const GROUP_ORDER: readonly GroupId[] = ["rally", "setScore", "timeouts", "sanctions", "subs", "expedite", "more"];

const GROUP_PROMINENCE: Record<GroupId, SkinProminence> = {
  rally: "primary",
  setScore: "secondary",
  timeouts: "drawer",
  sanctions: "drawer",
  subs: "drawer",
  expedite: "drawer",
  more: "drawer",
};

/** Sport-agnostic classification by the kernel's own shared action-type
 *  SUFFIX — never a sport-key prefix check, so this works identically for
 *  volleyball/badminton/tabletennis without special-casing any one of them.
 *  ".expedite.start" is tested before ".summary" only because both are
 *  plausible-looking suffixes of unrelated strings; in practice the two
 *  never collide on this kernel's real vocabulary. */
function classify(type: string): GroupId {
  if (type.endsWith(".rally")) return "rally";
  if (type.endsWith(".expedite.start")) return "expedite";
  if (type.endsWith(".summary")) return "setScore"; // volleyball's "set.summary" OR badminton/tabletennis's "game.summary"
  if (type.endsWith(".timeout")) return "timeouts";
  if (type.endsWith(".sanction")) return "sanctions";
  if (type.endsWith(".sub")) return "subs";
  return "more";
}

/** Every DISTINCT action type in the view, first-seen order, walked across
 *  ALL panels together — see the module header on why per-panel collection
 *  would double-place the rally type once expedite is in play. */
function distinctTypes(view: PadView): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const panel of view.panels) {
    for (const action of panel.actions) {
      if (!seen.has(action.type)) {
        seen.add(action.type);
        out.push(action.type);
      }
    }
  }
  return out;
}

function buildGroups(view: PadView): SkinGroup[] {
  const byGroup = new Map<GroupId, string[]>();
  for (const type of distinctTypes(view)) {
    const id = classify(type);
    const list = byGroup.get(id) ?? [];
    list.push(type);
    byGroup.set(id, list);
  }
  const groups: SkinGroup[] = [];
  for (const id of GROUP_ORDER) {
    const actions = byGroup.get(id);
    if (actions && actions.length > 0) groups.push({ id, prominence: GROUP_PROMINENCE[id], actions });
  }
  return groups;
}

/** Defensive record read — `ctx.state`/`ctx.summary` are `unknown` by
 *  contract, and the coverage sweep hands every layout() call a bare
 *  `state: {}` (skin-coverage.test.ts's sweep()), so every read here must
 *  degrade rather than throw. */
function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function scoreline(home: unknown, away: unknown): string {
  const h = typeof home === "number" ? home : 0;
  const a = typeof away === "number" ? away : 0;
  return `${h}–${a}`;
}

/** `setbased/kernel.ts`'s `SetBasedState` shape, read structurally — this
 *  file never imports the kernel type (a skin only ever sees `unknown`, per
 *  `SkinLayoutCtx`), so every access here is a probe, not a cast. */
function buildHeader(ctx: SkinLayoutCtx): SkinHeader {
  const state = asRecord(ctx.state);
  const setsWon = asRecord(state.setsWon);
  const sets = Array.isArray(state.sets) ? state.sets : [];
  const lastSet = sets.length > 0 ? asRecord(sets[sets.length - 1]) : {};
  // A trailing set is "open" (live) only while it exists and has not closed
  // — kernel.ts's own `openSet()`. Closed-or-absent means no rally has
  // started the next one: 0-0, honestly, not `totalPoints()`'s match-wide
  // sum (a different, less useful number for "what's happening right now").
  const isOpen = sets.length > 0 && lastSet.closed !== true;

  const fields: SkinHeaderField[] = [
    {
      id: "sets",
      value: scoreline(setsWon.home, setsWon.away),
      captionKey: "scorepad.skin.racquet.header.sets",
      emphasis: true,
    },
    {
      id: "points",
      value: isOpen ? scoreline(lastSet.home, lastSet.away) : "0–0",
      captionKey: "scorepad.skin.racquet.header.points",
      emphasis: true,
    },
    {
      id: "serving",
      // Deliberately a placeholder — see the module header: this kernel
      // folds no serving-side fact on any of these three sports, ever.
      value: "—",
      captionKey: "scorepad.skin.racquet.header.serving",
      emphasis: false,
    },
  ];
  return { fields };
}

function racquetLayout(view: PadView, ctx: SkinLayoutCtx): SkinLayout {
  return { header: buildHeader(ctx), groups: buildGroups(view) };
}

// ---------------------------------------------------------------------------
// Component — thin: everything it draws is derived from `layout`/`view`. The
// one thing it decides for itself is HOW to turn a placed action TYPE into a
// control, via `actionsForType` + the two render paths below.
//
// NO ROSTER DATA. `SkinProps` carries no `lineups`/`personNames` (unlike
// `PadRenderer`'s own default attribution wiring — pad-renderer.tsx's header
// comment names this as the seam S11's skins draw their own version of).
// `AttributionPicker` needs `lineups` to resolve a "side" pick to a real
// entrant id and a squad to offer person candidates from, so it cannot be
// reused here as-is. This file resolves "side" itself, from the live folded
// state's own `entrants.{home,away}` (always present — `SetBasedState`
// declares it required); "person" items (server/scorer/off/on/sanction
// subject) have no roster to offer candidates from and stay unset, which is
// safe because every such field is OPTIONAL on this kernel's own schemas
// (view-model.ts's `checkActionValidity` only requires FIELDS, never
// attribution) — the action still fires, just without that extra credit.
// ---------------------------------------------------------------------------

type MsgFn = ReturnType<typeof useMsg>;

const GROUP_LABEL_KEY: Record<GroupId, MessageKey> = {
  rally: "scorepad.skin.racquet.group.rally",
  setScore: "scorepad.skin.racquet.group.setScore",
  timeouts: "scorepad.skin.racquet.group.timeouts",
  sanctions: "scorepad.skin.racquet.group.sanctions",
  subs: "scorepad.skin.racquet.group.subs",
  expedite: "scorepad.skin.racquet.group.expedite",
  more: "scorepad.skin.more",
};

function groupLabelKey(id: string): MessageKey {
  return (GROUP_LABEL_KEY as Record<string, MessageKey | undefined>)[id] ?? "scorepad.skin.more";
}

function homeAwayIds(state: unknown): { home: string; away: string } {
  const entrants = asRecord(asRecord(state).entrants);
  return {
    home: typeof entrants.home === "string" ? entrants.home : "home",
    away: typeof entrants.away === "string" ? entrants.away : "away",
  };
}

/** `view.panels` may carry more than one action for a group's type — the
 *  rally type's co-existing shapes (module header). Deduped by declared
 *  shape (field + attribution paths) so the coverage sweep's gate-free view,
 *  which can map the SAME final action object into two panels at once, never
 *  renders an identical control twice. */
function actionsForType(view: PadView, type: string): PadActionView[] {
  const all = view.panels.flatMap((panel) => panel.actions).filter((a) => a.type === type);
  const seen = new Set<string>();
  const out: PadActionView[] = [];
  for (const a of all) {
    const sig = `${a.fields.map((f) => f.path).join(",")}|${a.attribution.map((it) => it.path).join(",")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(a);
  }
  return out;
}

/** A zero-field action whose only REQUIRED input is a side pick (the plain
 *  rally, and every sport's `sub`) needs its own control: `ActionForm`'s own
 *  one-tap shortcut fires the instant `fields.length === 0`, before its
 *  `renderAttribution` seam ever runs — correct for a truly empty action
 *  (badminton's `expedite.start`), wrong here, where skipping straight to
 *  submit would send a payload missing the engine's required `wonBy`/`by`.
 *  This predicate is how that class is told apart from the rest. */
function isSideTapOnly(action: PadActionView): boolean {
  return action.fields.length === 0 && action.attribution.some((item) => item.kind === "side");
}

function sideAttributionPath(action: PadActionView): string {
  const item = action.attribution.find((it) => it.kind === "side");
  return item?.path ?? "by";
}

function SideTapAction(props: {
  action: PadActionView;
  ids: { home: string; away: string };
  dispatch: SkinDispatch;
  submitting: boolean;
  msg: MsgFn;
  compact: boolean;
}): ReactNode {
  const { action, ids, dispatch, submitting, msg, compact } = props;
  const path = sideAttributionPath(action);
  const label = padLabel(action.labelKey.key, msg, action.labelKey.label);

  async function tap(side: "home" | "away") {
    if (submitting) return;
    await dispatch(action.type, { [path]: side === "home" ? ids.home : ids.away });
  }

  return (
    <div className="space-y-1">
      {compact && <p className="text-xs font-medium text-slate-500">{label}</p>}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`btn btn-primary w-full ${compact ? "h-14" : "h-20 text-lg"}`}
          disabled={submitting}
          onClick={() => void tap("home")}
        >
          {msg("scorepad.attribution.home")}
        </button>
        <button
          type="button"
          className={`btn btn-primary w-full ${compact ? "h-14" : "h-20 text-lg"}`}
          disabled={submitting}
          onClick={() => void tap("away")}
        >
          {msg("scorepad.attribution.away")}
        </button>
      </div>
    </div>
  );
}

/** `ActionForm`'s `renderAttribution` seam, filled in with what this file
 *  CAN offer without roster data — see the Component section header. */
function makeAttributionRenderer(state: unknown, msg: MsgFn) {
  return function renderAttribution(
    action: PadActionView,
    values: ActionValues,
    setValue: (path: string, value: PadFieldValue | undefined) => void,
  ): ReactNode {
    if (action.attribution.length === 0) return null;
    const ids = homeAwayIds(state);
    const sideItems = action.attribution.filter((item) => item.kind === "side");
    const personItems = action.attribution.filter((item) => item.kind === "person");
    return (
      <div className="space-y-2">
        {sideItems.map((item) => {
          const pressed = values[item.path];
          return (
            <div key={item.path} className="flex gap-2">
              <button
                type="button"
                className={`btn flex-1 ${pressed === ids.home ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setValue(item.path, pressed === ids.home ? undefined : ids.home)}
              >
                {msg("scorepad.attribution.home")}
              </button>
              <button
                type="button"
                className={`btn flex-1 ${pressed === ids.away ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setValue(item.path, pressed === ids.away ? undefined : ids.away)}
              >
                {msg("scorepad.attribution.away")}
              </button>
            </div>
          );
        })}
        {/* Person picks (server/scorer/off/on/the sanctioned player) need a
         *  live roster this file is never handed. Every such item is
         *  optional on this kernel's schemas, so leaving it unset never
         *  blocks the tap above — this note says so rather than the row
         *  just silently never appearing. */}
        {personItems.length > 0 && <p className="text-xs text-slate-400">{msg("scorepad.attribution.noRoster")}</p>}
      </div>
    );
  };
}

function GroupBody(props: {
  view: PadView;
  group: SkinGroup;
  ctx: SkinLayoutCtx;
  dispatch: SkinDispatch;
  submittingType: string | null;
  msg: MsgFn;
}): ReactNode {
  const { view, group, ctx, dispatch, submittingType, msg } = props;
  const ids = homeAwayIds(ctx.state);
  const compact = group.prominence !== "primary";
  const renderAttribution = makeAttributionRenderer(ctx.state, msg);

  return (
    <div className="flex flex-col gap-2">
      {group.actions.flatMap((type) => {
        const actions = actionsForType(view, type);
        // At most ONE tap control per type. The plain rally (`wonBy` only)
        // and the attributed rally (+server/scorer) are BOTH zero-field —
        // the kernel declares them together, unconditionally, in every cfg
        // (setbased/kernel.ts's Rally panel) — so both satisfy
        // `isSideTapOnly` and would otherwise render as two identical-
        // looking Home/Away button rows for what a scorer reads as one
        // control. The extra attribution on the richer shape is unreachable
        // without roster data anyway (module header), so nothing is lost by
        // collapsing to the first.
        const tap = actions.find(isSideTapOnly);
        const detailed = actions.filter((a) => !isSideTapOnly(a));
        const nodes: ReactNode[] = [];
        if (tap) {
          nodes.push(
            tap.availability.kind === "locked" ? (
              renderLockedTile(tap, msg)
            ) : (
              <SideTapAction
                key={`${tap.type}:tap`}
                action={tap}
                ids={ids}
                dispatch={dispatch}
                submitting={submittingType === tap.type}
                msg={msg}
                compact={compact}
              />
            ),
          );
        }
        for (const action of detailed) {
          const key = `${action.type}:${action.fields.map((f) => f.path).join(",")}`;
          nodes.push(
            action.availability.kind === "locked" ? (
              renderLockedTile(action, msg)
            ) : (
              <ActionForm
                key={key}
                action={action}
                submitting={submittingType === action.type}
                onSubmit={(payload) => void dispatch(action.type, payload)}
                renderAttribution={renderAttribution}
              />
            ),
          );
        }
        return nodes;
      })}
    </div>
  );
}

function ScoreHeader(props: { header: SkinHeader; msg: MsgFn }): ReactNode {
  return (
    <header
      data-role="racquet-header"
      className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 px-3 py-3 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]"
    >
      <div className="flex items-stretch justify-center gap-6">
        {props.header.fields.map((field) => (
          <div key={field.id} className="flex flex-col items-center justify-center">
            <p
              className={
                field.emphasis
                  ? "text-2xl font-bold tabular-nums tracking-tight text-white sm:text-3xl"
                  : "text-base font-semibold text-slate-300"
              }
            >
              {field.value}
            </p>
            {field.captionKey && (
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {props.msg(field.captionKey as MessageKey)}
              </p>
            )}
          </div>
        ))}
      </div>
    </header>
  );
}

export function RacquetSkin(props: SkinProps): ReactNode {
  const msg = useMsg();
  const { view, layout, ctx, dispatch, submittingType, offline, queueDepth } = props;

  return (
    <div className="space-y-3" data-skin="racquet">
      {layout.header && <ScoreHeader header={layout.header} msg={msg} />}

      {offline && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{msg("scorepad.queue.offline")}</p>}
      {!offline && queueDepth > 0 && (
        <p className="text-xs text-slate-500">{msg("scorepad.queue.pending", { count: queueDepth })}</p>
      )}

      {layout.groups.map((group) => {
        const label = msg(groupLabelKey(group.id));
        const body = <GroupBody view={view} group={group} ctx={ctx} dispatch={dispatch} submittingType={submittingType} msg={msg} />;

        if (group.prominence === "drawer") {
          return (
            <details key={group.id} className="card group p-3">
              <summary className="btn btn-ghost w-full cursor-pointer list-none justify-between">
                <span>{label}</span>
                <span aria-hidden className="text-xs text-purple-400 group-open:rotate-180">
                  ▾
                </span>
              </summary>
              <div className="mt-3">{body}</div>
            </details>
          );
        }

        // primary (rally) and secondary (set score) both draw as an ordinary
        // visible card — the prominence difference is the ORDER they land in
        // (rally always first, per GROUP_ORDER) and the bigger touch targets
        // `SideTapAction`/`ActionForm` give a non-compact group, not a
        // different container.
        return (
          <section key={group.id} className="card p-3">
            <h3 className="label !mb-2">{label}</h3>
            {body}
          </section>
        );
      })}
    </div>
  );
}

export const racquetSkin: SkinDef = {
  key: "racquet",
  sports: ["volleyball", "badminton", "tabletennis"],
  layout: racquetLayout,
  Component: RacquetSkin,
};
