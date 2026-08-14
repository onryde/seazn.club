"use client";
// Cricket skin (S11/#420 W9). Hand-crafted layout for cricket, replacing the
// universal renderer's panel walk for this sport (see ./types.ts's own
// header for the architecture rule this file exists under, and
// __tests__/cricket-skin.test.ts for the measured facts this file is built
// against).
//
// THE ONE-TYPE-THREE-PANELS FACT THIS FILE IS BUILT AROUND: cricket's own
// padSpec (packages/engine/src/sports/cricket/cricket.ts) declares THREE
// different PadActions — the Over panel's plain ball, the Extras panel's
// wide/no-ball/bye/leg-bye/penalty, and the Wicket panel's dismissal — that
// all share the identical wire type "cricket.ball" (same event, different
// field subsets). `skin-coverage.test.ts`'s dedup-by-type sweep collapses
// these to ONE type, and its "no skin places the same action twice" check is
// a flattened count across every group — so "cricket.ball" may appear in
// this layout's groups EXACTLY ONCE, never once per panel it happens to back.
// `cricketLayout` below therefore groups by DISTINCT ACTION TYPE (never by
// panel), through one static table — so the extras/wicket UI richness the
// brief asks for is drawn ENTIRELY inside the Component, as sub-sections of
// the one "thisOver" primary group, using `scorepad.skin.cricket.group.extras`
// / `.group.wicket` as SECTION captions rather than as separate SkinGroup
// entries (a SkinGroup with its own action entry for either would duplicate
// "cricket.ball" and fail the shared gate).
//
// PERSON NAMES (S12/#421 pass B — this comment was stale): S11 added
// `personNames?: Readonly<Record<string, string>>` to `SkinLayoutCtx`
// (./types.ts), but no skin actually read it — this file included, until now.
// Every person picker below resolves through `displayPerson`, which prefers
// `ctx.personNames[id]` and falls back to the raw id — `personNames` is
// optional precisely because `skin-coverage.test.ts`'s sweep hands `layout()`
// no roster at all, and a skin must stay total without one.
import { useState, type ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { padLabel, wicketLabel, extraLabel } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
import type { PadAttributionItem, PadFieldValue } from "@seazn/engine/sport";
import { ActionForm, type ActionValues } from "../action-form";
import { deriveFieldPathLabel, type PadActionView, type PadView } from "../view-model";
import {
  actionByType,
  type SkinDef,
  type SkinGroup,
  type SkinHeader,
  type SkinHeaderField,
  type SkinLayout,
  type SkinLayoutCtx,
  type SkinProminence,
  type SkinProps,
} from "./types";
import { renderLockedTile } from "./shared";

type MsgFn = ReturnType<typeof useMsg>;

// ---------------------------------------------------------------------------
// cfg / state shape probes — ctx.cfg / ctx.state are `unknown` by contract
// (SkinLayoutCtx's own doc comment); every read below is defensive and total.
// ---------------------------------------------------------------------------

interface CricketCfgShape {
  ballsPerOver?: number;
  inningsPerSide?: 1 | 2;
  dls?: { enabled?: boolean };
}

interface CricketInningsShape {
  battingSide?: "home" | "away";
  runs?: number;
  wickets?: number;
  legalBalls?: number;
  closed?: boolean;
  fine?: {
    striker?: string | null;
    nonStriker?: string | null;
    currentBowler?: string | null;
    dismissed?: string[];
  } | null;
}

interface CricketStateShape {
  phase?: string;
  innings?: CricketInningsShape[];
  revisedTarget?: number | null;
  targetSource?: "dls" | "manual" | null;
  orders?: { home?: string[]; away?: string[] };
  entrants?: { home?: string; away?: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function asCfg(cfg: unknown): CricketCfgShape {
  return asRecord(cfg) as CricketCfgShape;
}
function asState(state: unknown): CricketStateShape {
  return asRecord(state) as CricketStateShape;
}

function ballsPerOverOf(cfg: unknown): number {
  const bpo = asCfg(cfg).ballsPerOver;
  return typeof bpo === "number" && bpo > 0 ? bpo : 6;
}

// spec §2.4 notation, mirrored from the engine's own oversText — decimalised
// overs, always with the decimal point.
function oversText(balls: number, bpo: number): string {
  return `${Math.floor(balls / bpo)}.${balls % bpo}`;
}

function currentInnings(state: CricketStateShape): CricketInningsShape | null {
  const innings = state.innings ?? [];
  return innings.find((i) => !i.closed) ?? innings[innings.length - 1] ?? null;
}

function opponentSide(side: "home" | "away"): "home" | "away" {
  return side === "home" ? "away" : "home";
}

// ---------------------------------------------------------------------------
// Header — criterion 3. score/wickets/overs always; target/dlsPar are
// MUTUALLY EXCLUSIVE captions for the same number (the number a chasing side
// must beat), chosen by whether it is DLS-sourced — never both at once for
// the same figure. See cricket-skin.test.ts's own header comment for why
// this split beats "always show both".
// ---------------------------------------------------------------------------

/** The runs needed to win, or null when there is nothing to chase (or not
 *  enough state to say). Single-innings: `revisedTarget` when set, else the
 *  trivial "first innings + 1" fallback (arithmetic, not domain logic).
 *  Two-innings (test): only an EXPLICIT revision — the natural 4th-innings
 *  target needs cross-innings aggregation the engine owns privately
 *  (`chaseTarget()`, cricket.ts, not exported), and reimplementing that here
 *  would be exactly the domain-logic duplication this file must not do. */
function chaseValue(cfg: CricketCfgShape, state: CricketStateShape): number | null {
  const innings = state.innings ?? [];
  const singleInnings = cfg.inningsPerSide !== 2;
  if (singleInnings) {
    if (innings.length < 2) return null;
    if (state.revisedTarget != null) return state.revisedTarget;
    const first = innings[0];
    return typeof first?.runs === "number" ? first.runs + 1 : null;
  }
  return state.revisedTarget ?? null;
}

function buildHeader(cfg: unknown, state: unknown): SkinHeader {
  const cfgShape = asCfg(cfg);
  const stateShape = asState(state);
  const bpo = ballsPerOverOf(cfg);
  const open = currentInnings(stateShape);

  const fields: SkinHeaderField[] = [
    { id: "score", value: String(open?.runs ?? 0), captionKey: "scorepad.skin.cricket.header.score", emphasis: true },
    { id: "wickets", value: String(open?.wickets ?? 0), captionKey: "scorepad.skin.cricket.header.wickets", emphasis: true },
    { id: "overs", value: oversText(open?.legalBalls ?? 0, bpo), captionKey: "scorepad.skin.cricket.header.overs", emphasis: false },
  ];

  const value = chaseValue(cfgShape, stateShape);
  if (value !== null) {
    const isDls = cfgShape.dls?.enabled === true && stateShape.targetSource === "dls";
    fields.push(
      isDls
        ? { id: "dlsPar", value: String(value), captionKey: "scorepad.skin.cricket.header.dlsPar", emphasis: false }
        : { id: "target", value: String(value), captionKey: "scorepad.skin.cricket.header.target", emphasis: false },
    );
  }

  return { fields };
}

// ---------------------------------------------------------------------------
// Groups — criteria 1, 2, 4. One static type->group table, so "cricket.ball"
// (declared by three PadActions — see file header) is placed EXACTLY ONCE
// regardless of how many of those three panels the current view carries.
// "more" is a safety net: cricket-skin.test.ts's whole-cfg-space sweep proves
// it never fires against the shipped spec, but it keeps a FUTURE cricket
// action type from silently failing the shared coverage gate's "missing"
// check the day someone adds one and forgets this table.
// ---------------------------------------------------------------------------

type GroupId = "setup" | "thisOver" | "reviews" | "innings" | "more";

const TYPE_GROUP: Readonly<Record<string, GroupId>> = {
  "cricket.toss": "setup",
  "cricket.player.line": "setup",
  "cricket.ball": "thisOver",
  "cricket.superover.ball": "thisOver",
  "cricket.review": "reviews",
  "cricket.innings.summary": "innings",
  "cricket.innings.close": "innings",
  "cricket.innings.declare": "innings",
  "cricket.followon": "innings",
  "cricket.match.close": "innings",
  "cricket.newball": "innings",
  "cricket.powerplay": "innings",
  "cricket.interruption": "innings",
  "cricket.retire": "innings",
  "cricket.revise": "innings",
};

const GROUP_ORDER: readonly GroupId[] = ["setup", "thisOver", "reviews", "innings", "more"];

const GROUP_PROMINENCE: Readonly<Record<GroupId, SkinProminence>> = {
  setup: "primary", // the ONLY action available pre/post match — never a drawer
  thisOver: "primary", // the over's rhythm — criterion 2
  reviews: "drawer",
  innings: "drawer",
  more: "drawer",
};

const GROUP_CAPTION_KEY: Readonly<Record<GroupId, MessageKey>> = {
  setup: "scorepad.skin.cricket.group.setup",
  thisOver: "scorepad.skin.cricket.group.thisOver",
  reviews: "scorepad.skin.cricket.group.reviews",
  innings: "scorepad.skin.cricket.group.innings",
  more: "scorepad.skin.more",
};

/** PURE. No React, no DOM, no i18n lookup — see ./types.ts's SkinDef contract
 *  and skin-coverage.test.ts, which calls this directly across the whole
 *  cfg space with no rendering involved. */
export function cricketLayout(view: PadView, ctx: SkinLayoutCtx): SkinLayout {
  // Distinct action types actually present, first-seen order. Deduped by
  // TYPE (never by panel) — see file header.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const panel of view.panels) {
    for (const action of panel.actions) {
      if (!seen.has(action.type)) {
        seen.add(action.type);
        order.push(action.type);
      }
    }
  }

  const buckets = new Map<GroupId, string[]>();
  for (const type of order) {
    const group = TYPE_GROUP[type] ?? "more";
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group)!.push(type);
  }

  const groups: SkinGroup[] = [];
  for (const id of GROUP_ORDER) {
    const actions = buckets.get(id);
    if (actions && actions.length > 0) groups.push({ id, prominence: GROUP_PROMINENCE[id], actions });
  }

  return { header: buildHeader(ctx.cfg, ctx.state), groups };
}

// ---------------------------------------------------------------------------
// Payload construction — pure, so the dismissal-with-fielder path (dispatch
// brief criterion 6) is unit-testable without DOM. Shape verified against
// CricketBall/CricketWicket (cricket.ts): same fields, same optionality,
// same bowlerCredited derivation v1's BallForm already used.
// ---------------------------------------------------------------------------

export type WicketKind =
  | "bowled" | "caught" | "lbw" | "runout" | "stumped"
  | "hitwicket" | "retired" | "obstructed" | "timedout" | "hitballtwice";
export type ExtraKind = "wide" | "noball" | "bye" | "legbye" | "penalty";

export const WICKET_KINDS: readonly WicketKind[] = [
  "bowled", "caught", "lbw", "runout", "stumped",
  "hitwicket", "retired", "obstructed", "timedout", "hitballtwice",
];
export const EXTRA_KINDS: readonly ExtraKind[] = ["wide", "noball", "bye", "legbye", "penalty"];

const BOWLER_CREDITED_KINDS = new Set<WicketKind>(["bowled", "caught", "lbw", "stumped", "hitwicket"]);
/** Dismissals where naming a fielder is meaningful. */
export const FIELDER_ELIGIBLE_KINDS = new Set<WicketKind>(["caught", "runout", "stumped"]);
/** Of those, the one kind where the batter dismissed genuinely varies
 *  (a run-out can take either end) — every other kind always dismisses the
 *  striker, so asking "who's out" there would be a tap this skin's tap-count
 *  budget (dispatch criterion 5) does not have to spend. */
const VARIABLE_OUT_KINDS = new Set<WicketKind>(["runout"]);

export interface BallEntry {
  over: number;
  ballInOver: number;
  striker: string;
  nonStriker: string;
  bowler: string;
  extra?: { kind: ExtraKind; runs: number };
  wicket?: { kind: WicketKind; out: string; fielder?: string; fielderAssist?: string; incoming?: string };
  freeHit?: boolean;
}

/** batRuns is the value tapped on the run pad — 0 for a dismissal or most
 *  extras, otherwise the runs actually completed off the bat. Boundary is
 *  derived, never asked for separately: a scorer who taps "4" means a
 *  boundary. */
export function buildBallPayload(batRuns: number, entry: BallEntry): Record<string, unknown> {
  const boundary = batRuns === 4 ? 4 : batRuns === 6 ? 6 : undefined;
  return {
    over: entry.over,
    ballInOver: entry.ballInOver,
    striker: entry.striker,
    nonStriker: entry.nonStriker,
    bowler: entry.bowler,
    runs: {
      bat: batRuns,
      ...(entry.extra ? { extras: entry.extra } : {}),
    },
    ...(boundary ? { boundary } : {}),
    ...(entry.freeHit ? { freeHit: true } : {}),
    ...(entry.wicket
      ? {
          wicket: {
            kind: entry.wicket.kind,
            out: entry.wicket.out,
            ...(entry.wicket.fielder ? { fielder: entry.wicket.fielder } : {}),
            ...(entry.wicket.fielderAssist ? { fielderAssist: entry.wicket.fielderAssist } : {}),
            ...(entry.wicket.incoming ? { incoming: entry.wicket.incoming } : {}),
            bowlerCredited: BOWLER_CREDITED_KINDS.has(entry.wicket.kind),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// React Component — mostly screenshot-only, not unit-tested (apps/web's
// vitest is `environment: "node"`, no jsdom/@testing-library — see
// ./types.ts's own header). Thin by design: everything it draws comes from
// `layout` or `view`, so this and `cricketLayout` can never disagree.
// Screenshot-verified at 375px/1280px via a throwaway render harness
// (dispatch report), since no route mounts a skin yet (pad-renderer.tsx's
// registry wiring is a sibling task, not owned here).
//
// ONE exception (S11 review fix): `ThisOverGroup` owns real hook state (the
// batter/bowler picker), which is exactly the kind of fact a pure `layout()`
// comparison or a static screenshot cannot see — a picker can render the
// right thing at mount and silently go stale on every render after. That
// state-sync property is unit-tested directly, through the node-only
// `_hook-harness` (`renderIsland`), the same technique pad-renderer.test.tsx
// and period-skin.test.ts already use for a component with its own hooks.
// See `ThisOverGroup`'s own export comment and cricket-skin.test.ts.
// ---------------------------------------------------------------------------

/** Resolves a person id through `ctx.personNames` (file header) — the raw id
 *  is the last-resort fallback, never a crash or a blank, so this stays total
 *  for the coverage sweep's no-roster case. */
function displayPerson(id: string, personNames: Readonly<Record<string, string>> | undefined): string {
  return personNames?.[id] ?? id;
}

/** `field.id` is skin-local (`buildHeader` above is the only producer) — the
 *  chase-value field is EITHER "dlsPar" or "target", never both at once
 *  (mutually exclusive captions for the same number, see the header comment
 *  above `chaseValue`). Both carry the SAME testid: this is the DLS-revised-
 *  target surface e2e (`scoring.spec.ts`'s own `ck-revised-target` check,
 *  re-anchored here at the S13/#422 cutover from v1's `cricket-pad.tsx`,
 *  deleted this session) needs to find, regardless of which caption is
 *  showing. The v2 scorepad rendered NO data-testid anywhere before this —
 *  this is the first one added to this surface, not a move of an existing
 *  one. */
const CHASE_VALUE_FIELD_IDS = new Set(["dlsPar", "target"]);

/** Exported (same reason as `ThisOverGroup` below) so
 *  `__tests__/cricket-skin-revised-target.test.ts` can drive it directly
 *  through the node-only `_hook-harness` — this file's only OTHER piece with
 *  its own JSX-instantiated identity worth testing in isolation, even though
 *  it owns no hook state itself (a plain `layout()` comparison cannot see
 *  the rendered testid/caption text this component is responsible for). */
export function ScoreHeader({ header, msg }: { header: SkinHeader; msg: MsgFn }) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-1 px-3 pt-2.5 pb-3 text-center sm:grid-cols-5">
      {header.fields.map((field) => (
        <div
          key={field.id}
          className="flex flex-col items-center"
          {...(CHASE_VALUE_FIELD_IDS.has(field.id) ? { "data-testid": "ck-revised-target" } : {})}
        >
          <span
            className={
              field.emphasis
                ? "text-xl font-bold tabular-nums tracking-tight text-white sm:text-2xl"
                : "text-sm font-semibold tabular-nums text-slate-300"
            }
          >
            {field.value}
          </span>
          {/* S13/#422 W11 cutover — text-slate-500 on bg-slate-900 measures
           *  ~3.74:1, below AA's 4.5:1 floor (same byte-identical pattern
           *  period-skin.tsx's header caption had, dac2b6bb). text-slate-400
           *  clears it at ~6.79:1 — the same fix, reused rather than
           *  reinvented. */}
          {field.captionKey && (
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
              {msg(field.captionKey as MessageKey)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The signature element (dispatch brief: "the over's rhythm ... is the
 *  primary surface"): one segment per ball in the over, sized to
 *  `ctx.cfg.ballsPerOver` — so the hundred's 5-ball over is visibly,
 *  structurally different from a 6-ball one, not just correct in a number
 *  buried in the header. Filled segments are balls bowled so far this over. */
function OverProgress({ ballInOver, bpo }: { ballInOver: number; bpo: number }) {
  const filled = Math.max(0, Math.min(bpo, ballInOver));
  return (
    <div className="flex items-center justify-center gap-1 pb-2.5" aria-hidden="true">
      {Array.from({ length: bpo }, (_, i) => (
        <span key={i} className={`h-1.5 w-5 rounded-full ${i < filled ? "bg-emerald-400" : "bg-slate-700"}`} />
      ))}
    </div>
  );
}

function attributionCaption(item: PadAttributionItem, msg: MsgFn): string {
  return item.labelKey ? padLabel(item.labelKey.key, msg, item.labelKey.label) : deriveFieldPathLabel(item.path);
}

/** Generic attribution for the actions this skin reuses `ActionForm` for
 *  (toss, review, player-line, and any admin action that ever grows one).
 *  "person" ids resolve through `ctx.personNames`; "side" ids (entrant ids)
 *  fall back to the raw id regardless — `personNames` is keyed by PERSON id
 *  only, so an entrant id is never found there, exactly as intended (an
 *  entrant is not a person). */
function renderSkinAttribution(
  state: CricketStateShape,
  msg: MsgFn,
  personNames: Readonly<Record<string, string>> | undefined,
) {
  const people = [...(state.orders?.home ?? []), ...(state.orders?.away ?? [])];
  const sides = [state.entrants?.home, state.entrants?.away].filter((id): id is string => Boolean(id));
  return function renderAttribution(
    action: PadActionView,
    values: ActionValues,
    setValue: (path: string, value: PadFieldValue | undefined) => void,
  ): ReactNode {
    if (action.attribution.length === 0) return null;
    return (
      <div className="space-y-2 border-t border-slate-100 pt-2">
        {action.attribution.map((item) => {
          const current = values[item.path];
          const caption = attributionCaption(item, msg);
          const ids = item.kind === "side" ? sides : people;
          return (
            <label key={item.path} className="block">
              <span className="label">{caption}</span>
              <select
                className="select min-h-11"
                value={typeof current === "string" ? current : ""}
                onChange={(e) => setValue(item.path, e.target.value === "" ? undefined : e.target.value)}
              >
                <option value="" disabled>
                  {msg("scorepad.field.choose")}
                </option>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {displayPerson(id, personNames)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    );
  };
}

export interface ThisOverProps {
  msg: MsgFn;
  view: PadView;
  state: CricketStateShape;
  bpo: number;
  submittingType: string | null;
  dispatch: (type: string, payload: unknown) => Promise<void>;
  /** personId -> display name (SkinLayoutCtx.personNames, S11). Optional —
   *  `skin-coverage.test.ts`'s sweep never hands one in, and this component
   *  must stay total without it (see `displayPerson`). */
  personNames?: Readonly<Record<string, string>>;
}

/** The primary surface (dispatch criterion 2): run pad always visible;
 *  extras are one-tap chips (default 1 run, matching the common case);
 *  the dismissal flow expands in two short steps (kind, then — only when the
 *  kind needs one — who/fielder) and submits on its own last tap. See the
 *  dispatch report for the counted tap totals against v1.
 *
 *  Exported (S11 review fix) so `__tests__/cricket-skin.test.ts` can drive
 *  it directly through the node-only `_hook-harness` — this is the one part
 *  of the Component with its own hook state (the batter/bowler picker), so
 *  it is the one part that needs more than a pure `layout()` comparison or a
 *  screenshot to prove correct. See that file's own header. */
export function ThisOverGroup({ msg, view, state, bpo, submittingType, dispatch, personNames }: ThisOverProps) {
  const open = currentInnings(state);
  const battingSide = open?.battingSide ?? "home";
  const bowlingSide = opponentSide(battingSide);
  const battingOrder = state.orders?.[battingSide] ?? [];
  const bowlingOrder = state.orders?.[bowlingSide] ?? [];
  const fine = open?.fine ?? null;

  const ballType = state.phase === "super_over" && actionByType(view, "cricket.superover.ball") ? "cricket.superover.ball" : "cricket.ball";
  // S13/#422 W11 cutover audit ("a shared helper silently drops every
  // duplicate-typed pad action"): `cricket.ball` is genuinely declared 3x
  // (over/extras/wicket panels -- this file's own header), so `actionByType`
  // below returns only the Over panel's plain-ball action, never the
  // Extras/Wicket ones. That is safe HERE and only here, never a template
  // for a new call site: `action` is read ONLY for `.availability` two lines
  // down, and `resolveActionView` (view-model.ts) derives availability
  // purely from `action.type` via `spec.fidelity`/`fidelityEntitlements` --
  // so all three `cricket.ball` actions are availability-identical by
  // construction, at every band/entitlement combination, pinned by
  // cricket-skin.test.ts's own sweep. Nothing else about `action` (fields,
  // attribution, labelKey) is read anywhere in this function -- the run pad/
  // extras chips/wicket flow below are hand-built, not driven from it.
  const action = actionByType(view, ballType);
  // The card's own caption, not the action's ("Ball") -- this surface also
  // owns the extras and wicket sub-flows, so "This over" (the group caption
  // every other group already uses) describes the whole card, where the
  // bare action label would undersell it.
  const label = msg("scorepad.skin.cricket.group.thisOver");

  // Local picker selection, resynced to the fold whenever the fold's OWN
  // value changes (S11 review fix — reviewed defect: `useState(initial)`
  // seeds ONCE at mount and silently ignores every later value, so after the
  // first ball the picker's idea of who is on strike drifts from the fold's
  // and every subsequent ball is attributed to the wrong batter).
  //
  // React's own answer is "adjusting state when a prop changes" — this repo
  // already relies on the identical render-phase-update pattern in
  // use-board-actions.ts (`seenFixtures`/`setOverrides({})`, "Render-time
  // state adjustment ... no effect cascade"): track the LAST FOLD VALUE seen
  // in its own state slot, and when the incoming fold value differs from it,
  // overwrite the local selection during render (see _hook-harness.tsx's own
  // render-phase-update note for why this converges rather than looping).
  //
  // Comparing the FOLD'S PRIMITIVE VALUE (a person id or null), never an
  // object/array reference, is load-bearing: `ctx.state` is a fresh object
  // every render in the real pipeline, so reference comparison would resync
  // on every render and defeat the other half of this fix below.
  //
  // A manual override (via onChange) only ever touches `striker`/
  // `nonStriker`/`bowler`, never the `lastFold*` slot — so it survives any
  // re-render whose fold value is unchanged, and is overwritten only once
  // the fold itself actually moves. That is the deliberate answer to "must
  // not fight a deliberate correction mid-entry": follow the fold whenever
  // the fold's own value changes, keep the manual choice until it does.
  const [striker, setStriker] = useState(fine?.striker ?? battingOrder[0] ?? "");
  const [lastFoldStriker, setLastFoldStriker] = useState(fine?.striker ?? null);
  const [nonStriker, setNonStriker] = useState(fine?.nonStriker ?? battingOrder[1] ?? "");
  const [lastFoldNonStriker, setLastFoldNonStriker] = useState(fine?.nonStriker ?? null);
  const [bowler, setBowler] = useState(fine?.currentBowler ?? bowlingOrder[0] ?? "");
  const [lastFoldBowler, setLastFoldBowler] = useState(fine?.currentBowler ?? null);
  if ((fine?.striker ?? null) !== lastFoldStriker) {
    setLastFoldStriker(fine?.striker ?? null);
    setStriker(fine?.striker ?? battingOrder[0] ?? "");
  }
  if ((fine?.nonStriker ?? null) !== lastFoldNonStriker) {
    setLastFoldNonStriker(fine?.nonStriker ?? null);
    setNonStriker(fine?.nonStriker ?? battingOrder[1] ?? "");
  }
  if ((fine?.currentBowler ?? null) !== lastFoldBowler) {
    setLastFoldBowler(fine?.currentBowler ?? null);
    setBowler(fine?.currentBowler ?? bowlingOrder[0] ?? "");
  }
  const [wicketOpen, setWicketOpen] = useState(false);
  const [wicketKind, setWicketKind] = useState<WicketKind | null>(null);
  const [wicketOut, setWicketOut] = useState<string>("");

  if (!action || action.availability.kind === "locked") {
    return (
      <section className="card p-3">
        <h3 className="label !mb-2">{label}</h3>
        {action?.availability.kind === "locked" && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {msg(action.availability.reason.key)}
          </p>
        )}
      </section>
    );
  }

  const submitting = submittingType === ballType;
  const legalBalls = open?.legalBalls ?? 0;
  // TWO DIFFERENT QUANTITIES, and collapsing them into one was a real defect
  // (S12/#421, found by submitting a ball against the real API — cricket had
  // no browser coverage before this session).
  //
  //   ballsCompletedInOver  0..bpo-1  — how many legal balls this over has
  //                                     already seen. What the progress dots
  //                                     fill, and what `legalBalls % bpo` is.
  //   ballInOver            1..bpo    — WHICH ball of the over this delivery
  //                                     IS. What `CricketBall` declares, and
  //                                     it is `z.number().int().positive()`,
  //                                     so 0 is not merely off by one, it is
  //                                     schema-invalid.
  //
  // Sending the count as the ordinal meant the FIRST ball of EVERY over was
  // submitted as `ballInOver: 0` and rejected 422 by the server — i.e. no
  // cricket over could ever be scored past its own first delivery. No unit
  // test saw it: the skin-coverage gate asserts on `layout()`'s data, never on
  // a built payload, and every payload test used a mid-over state where the
  // off-by-one is still a positive number.
  const ballsCompletedInOver = legalBalls % bpo;
  const ballInOver = ballsCompletedInOver + 1;
  const over = Math.floor(legalBalls / bpo);
  const dismissed = new Set(fine?.dismissed ?? []);
  const canScore = striker !== "" && nonStriker !== "" && bowler !== "";

  function base() {
    return { over, ballInOver, striker, nonStriker, bowler };
  }
  function closeWicket() {
    setWicketOpen(false);
    setWicketKind(null);
    setWicketOut("");
  }
  function send(payload: Record<string, unknown>) {
    void dispatch(ballType, payload);
    closeWicket();
  }
  function runTap(runs: number) {
    if (!canScore || submitting) return;
    send(buildBallPayload(runs, base()));
  }
  function extraTap(kind: ExtraKind) {
    if (!canScore || submitting) return;
    send(buildBallPayload(0, { ...base(), extra: { kind, runs: 1 } }));
  }
  function pickKind(kind: WicketKind) {
    if (!canScore || submitting) return;
    if (VARIABLE_OUT_KINDS.has(kind)) {
      // "" is the "not yet chosen" sentinel -- a run-out can dismiss either
      // end, so (unlike every other kind) this must not default to the
      // striker: an explicit tap is required before `needsOutChoice` clears.
      setWicketKind(kind);
      setWicketOut("");
      return;
    }
    if (FIELDER_ELIGIBLE_KINDS.has(kind)) {
      setWicketKind(kind);
      setWicketOut(striker);
      return;
    }
    send(buildBallPayload(0, { ...base(), wicket: { kind, out: striker } }));
  }
  function pickOut(who: string) {
    setWicketOut(who);
  }
  function pickFielder(fielder: string) {
    if (!wicketKind) return;
    send(buildBallPayload(0, { ...base(), wicket: { kind: wicketKind, out: wicketOut || striker, fielder } }));
  }
  function confirmWithoutFielder() {
    if (!wicketKind) return;
    send(buildBallPayload(0, { ...base(), wicket: { kind: wicketKind, out: wicketOut || striker } }));
  }

  const needsOutChoice = wicketKind !== null && VARIABLE_OUT_KINDS.has(wicketKind) && wicketOut === "";
  const needsFielder = wicketKind !== null && FIELDER_ELIGIBLE_KINDS.has(wicketKind) && wicketOut !== "";

  return (
    <section className="card space-y-3 p-3" data-role="cricket-this-over">
      <h3 className="label !mb-0">{label}</h3>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
        {(["striker", "nonStriker", "bowler"] as const).map((role) => {
          const value = role === "striker" ? striker : role === "nonStriker" ? nonStriker : bowler;
          const onChange = role === "striker" ? setStriker : role === "nonStriker" ? setNonStriker : setBowler;
          const pool = role === "bowler" ? bowlingOrder : battingOrder.filter((p) => !dismissed.has(p));
          // BALL_ATTRIBUTION (cricket.ts) ships no labelKey for any of these
          // three person slots — same "left unlabelled deliberately" pattern
          // as wicket.out/wicket.fielder (cricket.ts's own comment on
          // WICKET_ATTRIBUTION). deriveFieldPathLabel is the established
          // fallback for exactly that case (view-model.ts): a real, visible
          // caption derived from the engine's own path string, never
          // authored copy, so this is deliberately NOT a msg() call.
          return (
            <label key={role} className="block">
              <span className="label">{deriveFieldPathLabel(role)}</span>
              {/* S12/#421 — `min-h-11`. `.select` (a components-layer class)
                  sets its own padding, but Tailwind's utilities layer wins, so
                  the `px-2 py-1 text-xs` density recipe here collapsed these to
                  33px at 320 — measured in a real browser, against this repo's
                  44px touch bar. That matters more here than it would on an
                  incidental control: these three are the REQUIRED entry before
                  every over, so a courtside scorer hits them once per over for
                  the whole innings. `min-h-11` is a different property from the
                  padding utilities, so it survives the same override that ate
                  the padding, and it is the same 44px idiom the chassis already
                  uses for its own chips and phase tabs. */}
              <select
                className="select min-h-11 px-2 py-1 text-xs"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              >
                <option value="">—</option>
                {pool.map((id) => (
                  <option key={id} value={id}>
                    {displayPerson(id, personNames)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      {/* The COUNT, not the ordinal — an over that has seen no legal ball
          fills no dot. Passing the ordinal here would light the first dot
          before the first delivery. */}
      <OverProgress ballInOver={ballsCompletedInOver} bpo={bpo} />

      <div className="grid grid-cols-6 gap-1.5" role="group" aria-label={label}>
        {[0, 1, 2, 3, 4, 6].map((r) => (
          <button
            key={r}
            type="button"
            disabled={submitting || !canScore}
            onClick={() => runTap(r)}
            className={`flex h-12 items-center justify-center rounded-lg border text-base font-semibold transition disabled:opacity-40 ${
              r === 4 || r === 6
                ? "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <div>
        <p className="label !mb-1">{msg("scorepad.skin.cricket.group.extras")}</p>
        <div className="flex flex-wrap gap-1.5">
          {EXTRA_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={submitting || !canScore}
              onClick={() => extraTap(kind)}
              className="btn btn-ghost h-11 px-3 text-xs disabled:opacity-40"
            >
              {extraLabel(kind, msg)}
            </button>
          ))}
        </div>
      </div>

      <div>
        {!wicketOpen ? (
          <button
            type="button"
            disabled={submitting || !canScore}
            onClick={() => setWicketOpen(true)}
            className="btn btn-ghost h-11 w-full border border-rose-200 text-rose-700 disabled:opacity-40"
          >
            {msg("scorepad.skin.cricket.group.wicket")}
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-2">
            <div className="flex items-center justify-between">
              <p className="label !mb-0">{msg("scorepad.skin.cricket.group.wicket")}</p>
              <button type="button" onClick={closeWicket} className="text-xs text-rose-700 underline">
                {msg("scorepad.action.cancel")}
              </button>
            </div>
            {!wicketKind ? (
              <div className="flex flex-wrap gap-1.5">
                {WICKET_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={submitting}
                    onClick={() => pickKind(kind)}
                    className="btn btn-ghost h-11 px-2.5 text-xs disabled:opacity-40"
                  >
                    {wicketLabel(kind, msg)}
                  </button>
                ))}
              </div>
            ) : needsOutChoice ? (
              <div className="flex flex-wrap gap-1.5">
                {[striker, nonStriker].map((who) => (
                  <button
                    key={who}
                    type="button"
                    onClick={() => pickOut(who)}
                    className="btn btn-ghost h-11 px-2.5 text-xs"
                  >
                    {displayPerson(who, personNames)}
                  </button>
                ))}
              </div>
            ) : needsFielder ? (
              <div className="flex flex-wrap gap-1.5">
                {bowlingOrder.map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={submitting}
                    onClick={() => pickFielder(id)}
                    className="btn btn-ghost h-11 px-2.5 text-xs disabled:opacity-40"
                  >
                    {displayPerson(id, personNames)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={confirmWithoutFielder}
                  className="btn btn-ghost h-11 px-2.5 text-xs italic disabled:opacity-40"
                >
                  {msg("scorepad.action.confirm")}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** Shared renderer for every group this skin does NOT hand-build a bespoke
 *  surface for (setup / reviews / innings / more): each action reuses the
 *  universal renderer's own `ActionForm` (action-form.tsx), so a scorer who
 *  has used any other sport's admin actions sees the identical interaction
 *  here, and this file spends its hand-crafted effort where the brief asks
 *  for it — the over's rhythm — rather than re-inventing ten rare admin
 *  forms from scratch. */
function AdminGroup({
  group,
  view,
  state,
  msg,
  submittingType,
  dispatch,
  drawer,
  personNames,
}: {
  group: SkinGroup;
  view: PadView;
  state: CricketStateShape;
  msg: MsgFn;
  submittingType: string | null;
  dispatch: (type: string, payload: unknown) => Promise<void>;
  drawer: boolean;
  personNames: Readonly<Record<string, string>> | undefined;
}) {
  const caption = msg(GROUP_CAPTION_KEY[group.id as GroupId] ?? "scorepad.skin.more");
  const renderAttribution = renderSkinAttribution(state, msg, personNames);

  const body = (
    <div className="flex flex-col gap-2">
      {group.actions.map((type) => {
        const action = actionByType(view, type);
        if (!action) return null;
        // Shared with every other skin AND with the universal renderer — this
        // copy had already drifted, omitting `aria-disabled`, which announced a
        // locked control to a screen reader as an ordinary element.
        if (action.availability.kind === "locked") return renderLockedTile(action, msg);
        return (
          <ActionForm
            key={type}
            action={action}
            submitting={submittingType === type}
            onSubmit={(payload) => void dispatch(type, payload)}
            renderAttribution={renderAttribution}
          />
        );
      })}
    </div>
  );

  if (drawer) {
    return (
      <details className="card group p-3">
        <summary className="btn btn-ghost w-full cursor-pointer list-none justify-between">
          <span>{caption}</span>
          {/* S13/#422 W11 cutover — text-purple-400 on white ~2.79:1, below
           *  AA's 4.5:1; text-purple-700 clears it at ~7.07:1 and matches
           *  the label beside it (.btn-ghost's own text-purple-700). */}
          <span aria-hidden="true" className="text-xs text-purple-700 group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="mt-3">{body}</div>
      </details>
    );
  }

  return (
    <section className="card p-3">
      <h3 className="label !mb-2">{caption}</h3>
      {body}
    </section>
  );
}

export function CricketSkin(props: SkinProps) {
  const msg = useMsg();
  const { view, ctx, layout, dispatch, submittingType, offline, queueDepth } = props;
  const stateShape = asState(ctx.state);
  const bpo = ballsPerOverOf(ctx.cfg);

  return (
    // 375px is the real scoring surface (dispatch brief) -- full width there,
    // and this is deliberately a max-width, not a fixed one, so it never
    // fights whatever column a future host page already constrains this to.
    // Screenshot-verified: an UNCONSTRAINED render at a bare 1280px spreads
    // the header's few fields and the 6-column run pad into oversized gaps
    // with nothing to anchor them -- neither device-score-pad.tsx nor
    // pad-renderer.tsx self-constrains either, so this is a deliberate
    // divergence for this file, not a copied convention. 27rem matches the
    // width this app's other docked card (ai-console.tsx's AI panel) already
    // settled on, rather than inventing a new number.
    <div className="mx-auto w-full space-y-3 sm:max-w-[27rem]" data-role="cricket-skin">
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        {layout.header && <ScoreHeader header={layout.header} msg={msg} />}
        {/* Status chrome this skin draws itself -- SkinProps's own doc
         *  comment on queueDepth/offline (./types.ts): "Mirrors the chassis
         *  result ... for status chrome a skin draws itself." Same visual
         *  language as the universal renderer's own queue strip
         *  (pad-renderer.tsx), so a scorer moving between a skinned and an
         *  unskinned sport sees one consistent connection indicator. */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800/70 px-3 py-1.5">
          <span
            className={`flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              offline || queueDepth > 0 ? "text-amber-400" : "text-emerald-400"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${offline || queueDepth > 0 ? "animate-live-pulse bg-amber-400" : "bg-emerald-400"}`}
            />
            {offline ? msg("scorepad.queue.offline") : queueDepth > 0 ? msg("scorepad.queue.pending", { count: queueDepth }) : msg("scorepad.queue.synced")}
          </span>
        </div>
      </header>

      {layout.groups.map((group) =>
        group.id === "thisOver" ? (
          <ThisOverGroup
            key={group.id}
            msg={msg}
            view={view}
            state={stateShape}
            bpo={bpo}
            submittingType={submittingType}
            dispatch={dispatch}
            personNames={ctx.personNames}
          />
        ) : (
          <AdminGroup
            key={group.id}
            group={group}
            view={view}
            state={stateShape}
            msg={msg}
            submittingType={submittingType}
            dispatch={dispatch}
            drawer={group.prominence === "drawer"}
            personNames={ctx.personNames}
          />
        ),
      )}
    </div>
  );
}

export const cricketSkin: SkinDef = {
  key: "cricket",
  sports: ["cricket"],
  layout: cricketLayout,
  Component: CricketSkin,
};
