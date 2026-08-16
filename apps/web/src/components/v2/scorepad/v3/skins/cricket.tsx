// Cricket SkinDefV3 — R2/task C. Converts cricket to the v3 chassis (spec
// `docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-design.md` §2/§3,
// wave brief `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/
// R2-cricket.md`, execution plan `docs/superpowers/plans/2026-08-16-
// scorepad-v3-r2-cricket.md`). Replaces `../../skins/cricket-skin.tsx` (v2,
// left on disk — R8 deletes it) as the sport's PAD surface; nothing here is
// imported by or imports that file.
//
// PURE DATA, no React: every `SkinDefV3` method (scorebug/tiles/dock/
// context/sheets/swap/phase) returns plain data, same testability stance as
// every other v3 primitive (apps/web vitest is `environment:"node"`, no
// jsdom). This file is `.tsx` only because the task brief names it that —
// it contains no JSX.
//
// FACTORY, NOT A BARE OBJECT (a real gap this task found, not a stylistic
// choice): `ScorebugSpec.context`/`ScorebugHalf.big`/`WhoLine.name` and
// `DockSpec.title` are documented "already resolved by the caller"
// (scorebug.tsx's own header; detail-dock.tsx's own `DockController.title`
// doc) — i.e. the SKIN must hand back fully-localised text for these few
// fields, unlike every OTHER string field on these types (`TileSpec.label`,
// `ContextSlot.label`, `DockChip.label`, `GuidedSheetStep.title`/
// `options[].label`), which are all i18n KEYS the chassis renderer resolves
// itself via its own `t` prop. But `SkinDefV3`'s methods take `(view)`
// only — no `t` anywhere in the contract (R1 ruling, `_INDEX.md`) — so a
// skin has no way to pre-resolve those few fields without SOME `t` in
// scope. R1 shipped no real skin to hit this; this is the first one that
// does. Resolution, kept to the SMALLEST possible footprint: `cricketSkinV3`
// is a FACTORY taking `t` once, closing it over ONLY for `scorebug`/`dock`
// (the two methods with a pre-resolved-string field) — every other member
// (`tiles`/`context`/`sheets`/`swap`/`phase`) is a plain, `t`-free function
// of `view` alone, independently exported and testable with no `t` involved.
// `V3_SKINS.cricket` (registry.ts, a LATER task's file) will need
// `cricketSkinV3(t)` called once with a real `t` in scope (e.g. inside the
// component that resolves the skin, memoized on `t`) rather than assigned
// as a bare value — flagged prominently in this task's report for whoever
// wires that.
//
// EVENT VOCABULARY (scouted 2026-08-16, packages/engine/src/sports/cricket/
// cricket.ts): 15 `cricket.*` types. Extras are NOT separate events — a wide
// is `cricket.ball` with `runs.extras{kind,runs}`. `cricket.ball` and
// `cricket.superover.ball` share one schema (`CricketBall`); which type this
// file dispatches switches on `state.phase === "super_over"`
// (`ballEventType` below), matching v2's own `cricket-skin.tsx:502`.
//
// OWNER HYBRID RULING (plan doc §1.1): Toss/Review/Retire/Innings-close/
// Declare get real, phase-aware tiles; the other 8 event types (player.line,
// innings.summary, followon, match.close, newball, powerplay, interruption,
// revise) ride the chassis's generic "More" sheet — already fully handled by
// pad-host.tsx's own `moreActions`/`dedicatedEventTypes` builders (task B),
// including cfg-conditional inclusion (follow-on/match.close only appear
// there at all once `padSpec(cfg)` itself declares them for a two-innings
// cfg) — nothing extra needed from this file for that half.
//
// FALSE PREMISE FOUND (plan doc's phase tags for these two, corrected here):
// the plan's task-brief text tags "Innings close (post)" and "Declare (post,
// two-innings variants only)". The ENGINE's own `padSpec(cfg)` disagrees:
// `inningsCloseAction`/`declareAction`/`followOnAction`/`matchCloseAction`
// all live in the SAME "Innings" panel as `retireAction`, and that whole
// panel is declared `phase: "live"` (cricket.ts:2726-2731) — matching
// Retire's OWN "(live)" tag in the same brief sentence. A literal `post`
// PadPhase gating would make these tiles NEVER reachable in practice: `post`
// (via `phase()`'s G3 mapping) only occurs once `state.phase` is
// `done`/`final` — i.e. the WHOLE MATCH has ended, at which point closing an
// innings or declaring is nonsensical (there is no engine notion of
// "between innings" distinct from `live`). Implemented here as `live`,
// matching engine ground truth and Retire's own sibling tag; recorded here
// rather than silently deviating from the literal brief text.
"use client";
import type { EventEnvelope } from "@seazn/engine/core";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import {
  MORE_SHEET_KEY,
  type ContextStripSpec,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugSpec,
  type SkinDefV3,
  type SwapSlot,
  type TileSpec,
} from "../types";

// ---------------------------------------------------------------------------
// Closed vocabularies (mirrors ../../skins/cricket-skin.tsx's own — NOT
// imported from it, that file is v2 surface this wave replaces, not a
// dependency; see this file's own header). Scouted facts, not re-derived:
// WICKET_KINDS(10)/EXTRA_KINDS(5)/FIELDER_ELIGIBLE(3)/VARIABLE_OUT(1)/
// BOWLER_CREDITED(5) match CRICKET_WICKET/CRICKET_EXTRAS exactly
// (packages/engine/src/sports/cricket/cricket.ts:144-174).
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

/** Dismissals where naming a fielder is meaningful. */
export const FIELDER_ELIGIBLE_KINDS = new Set<WicketKind>(["caught", "runout", "stumped"]);
/** The one kind where the batter dismissed genuinely varies — every other
 *  kind always dismisses the striker, so asking "who's out" there would be
 *  the wasted tap D-15 exists to remove. */
export const VARIABLE_OUT_KINDS = new Set<WicketKind>(["runout"]);
const BOWLER_CREDITED_KINDS = new Set<WicketKind>(["bowled", "caught", "lbw", "stumped", "hitwicket"]);

const BALL_EVENT_TYPES = new Set(["cricket.ball", "cricket.superover.ball"]);

// ---------------------------------------------------------------------------
// Defensive shape probes — `view.cfg`/`view.state` are `unknown` by
// PadHostView's own contract (types.ts), same posture as v2's
// `CricketCfgShape`/`CricketStateShape`/`CricketInningsShape`.
// ---------------------------------------------------------------------------

interface CricketCfgShape {
  ballsPerOver?: number;
  ballsPerInnings?: number | null;
  inningsPerSide?: 1 | 2;
  dls?: { enabled?: boolean };
  followOn?: { enabled?: boolean };
  superOver?: boolean;
}
interface CricketFineShape {
  striker?: string | null;
  nonStriker?: string | null;
  currentBowler?: string | null;
  freeHitPending?: boolean;
}
interface CricketInningsShape {
  battingSide?: "home" | "away";
  runs?: number;
  wickets?: number;
  legalBalls?: number;
  closed?: boolean;
  fine?: CricketFineShape | null;
}
interface CricketStateShape {
  phase?: "pre" | "live" | "super_over" | "done" | "final";
  innings?: CricketInningsShape[];
  orders?: { home?: string[]; away?: string[] };
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

/** `cfg.ballsPerOver`, falling back to 6 — the `hundred` variant sets 5
 *  (cricket.ts:2811); this must never be assumed. */
export function ballsPerOverOf(cfg: unknown): number {
  const bpo = asCfg(cfg).ballsPerOver;
  return typeof bpo === "number" && bpo > 0 ? bpo : 6;
}

/** Decimalised overs notation, mirrored from the engine's own convention:
 *  always a decimal point, ball-within-over never carries a leading zero
 *  beyond the single digit it already is. */
export function oversText(legalBalls: number, bpo: number): string {
  return `${Math.floor(legalBalls / bpo)}.${legalBalls % bpo}`;
}

function opponentSide(side: "home" | "away"): "home" | "away" {
  return side === "home" ? "away" : "home";
}

/** The open innings, or the most recently closed one once none is open
 *  (post-match display). `null` pre-toss / before any innings exists. */
export function currentInnings(state: CricketStateShape): CricketInningsShape | null {
  const innings = state.innings ?? [];
  return innings.find((i) => !i.closed) ?? innings[innings.length - 1] ?? null;
}

/** `cricket.ball` normally; `cricket.superover.ball` while the engine is
 *  actually in a super over — v2's own switch, `cricket-skin.tsx:502`. */
export function ballEventType(state: CricketStateShape): "cricket.ball" | "cricket.superover.ball" {
  return state.phase === "super_over" ? "cricket.superover.ball" : "cricket.ball";
}

export interface ResolvedPeople {
  battingSide: "home" | "away";
  bowlingSide: "home" | "away";
  striker: string;
  nonStriker: string;
  bowler: string;
}

/** Striker/non-striker/bowler, fold-authoritative (`fine.*`) with the SAME
 *  default v2's `ThisOverGroup` used before any manual pick existed:
 *  `battingOrder[0]`/`[1]`, `bowlingOrder[0]` — stateless here (no local
 *  component state available to a pure skin builder), so this default is
 *  recomputed fresh each call rather than remembered across renders. Empty
 *  string when even the order itself isn't populated yet (pre-lineup).
 *
 *  `overrides` (G5 — controller ruling 2026-08-16): `view.contextOverrides`,
 *  a slot id -> person id map of PENDING context-strip picks the HOST holds
 *  (types.ts's own doc on `PadHostView.contextOverrides`). Checked FIRST,
 *  ahead of `fine.*` and the order-derived default — an override represents
 *  a scorer's own just-tapped choice, which must win over both the last
 *  KNOWN fold value and the fallback default. Defaults to `{}` so every
 *  pre-G5 call site (none passed a second argument) keeps behaving
 *  identically. */
export function resolvePeople(state: CricketStateShape, overrides: Readonly<Record<string, string>> = {}): ResolvedPeople {
  const innings = currentInnings(state);
  const battingSide = innings?.battingSide ?? "home";
  const bowlingSide = opponentSide(battingSide);
  const battingOrder = state.orders?.[battingSide] ?? [];
  const bowlingOrder = state.orders?.[bowlingSide] ?? [];
  const fine = innings?.fine ?? null;
  return {
    battingSide,
    bowlingSide,
    striker: overrides.striker ?? fine?.striker ?? battingOrder[0] ?? "",
    nonStriker: overrides.nonStriker ?? fine?.nonStriker ?? battingOrder[1] ?? "",
    bowler: overrides.bowler ?? fine?.currentBowler ?? bowlingOrder[0] ?? "",
  };
}

function basePayload(state: CricketStateShape, bpo: number, overrides: Readonly<Record<string, string>>): Record<string, unknown> {
  const innings = currentInnings(state);
  const legalBalls = innings?.legalBalls ?? 0;
  const people = resolvePeople(state, overrides);
  return {
    over: Math.floor(legalBalls / bpo),
    ballInOver: (legalBalls % bpo) + 1,
    striker: people.striker,
    nonStriker: people.nonStriker,
    bowler: people.bowler,
  };
}

function runPayload(base: Record<string, unknown>, runs: number): Record<string, unknown> {
  const boundary = runs === 4 ? 4 : runs === 6 ? 6 : undefined;
  return { ...base, runs: { bat: runs }, ...(boundary !== undefined ? { boundary } : {}) };
}

function extraPayload(base: Record<string, unknown>, kind: ExtraKind, runs = 1): Record<string, unknown> {
  return { ...base, runs: { bat: 0, extras: { kind, runs } } };
}

// ---------------------------------------------------------------------------
// Shared vocabulary lookup (S7/#427's ENUM_VOCAB, scoring-vocab.ts) — every
// enum this skin needs a label for (wicket kind, extra kind, toss "elected",
// review "kind"/"outcome") already has FOUR-LOCALE copy registered there;
// reusing it is what "reuse existing keys rather than minting duplicates"
// means for anything enum-shaped (the brief's own two named namespaces,
// `scorepad.skin.cricket.*`/`pad.cricket.action.*`, are the NON-enum half of
// that same instruction).
// ---------------------------------------------------------------------------

function vocabKey(field: string, value: string): MessageKey | null {
  for (const map of ENUM_VOCAB[field] ?? []) if (value in map) return map[value]!;
  return null;
}

/** Throws only for a value genuinely absent from ENUM_VOCAB — unreachable
 *  through this file's own closed `WICKET_KINDS`/`EXTRA_KINDS`/literal enum
 *  call sites below, kept total (never a silently-wrong fallback string). */
function requiredVocabKey(field: string, value: string): MessageKey {
  const key = vocabKey(field, value);
  if (key === null) throw new Error(`cricket skin: no vocab key for ${field}="${value}"`);
  return key;
}

// ---------------------------------------------------------------------------
// Over dots (C-gaps §G1) — real per-ball outcomes from `view.events`, never
// v2's bare filled/unfilled segment count (OverProgress, cricket-skin.tsx).
// ---------------------------------------------------------------------------

function ballOutcomeSymbol(payload: Record<string, unknown>): string {
  if (payload.wicket) return "W";
  const runs = payload.runs as { bat?: number; extras?: { kind?: string; runs?: number } } | undefined;
  const extras = runs?.extras;
  if (extras?.kind === "wide") return extras.runs && extras.runs > 1 ? `wd${extras.runs}` : "wd";
  if (extras?.kind === "noball") {
    const bat = runs?.bat ?? 0;
    return bat > 0 ? `nb${bat}` : "nb";
  }
  if (extras?.kind === "bye") return `b${extras.runs ?? 1}`;
  if (extras?.kind === "legbye") return `lb${extras.runs ?? 1}`;
  const boundary = payload.boundary;
  if (boundary === 4 || boundary === 6) return String(boundary);
  const bat = runs?.bat ?? 0;
  return bat === 0 ? "•" : String(bat);
}

/**
 * The CURRENT over's own balls, oldest first, as real outcome symbols.
 * `bpo` is genuinely load-bearing, not incidental: step 1 windows to the
 * LAST `bpo` ball-type events (a wrong `bpo` mis-sizes this window — a
 * `hundred` fixture with `bpo=6` would silently pull in one ball from the
 * PREVIOUS over); step 2 trims forward from the last `ballInOver === 1`
 * found inside that window, so a window straddling an over boundary never
 * leaks the tail of the over before it. `EventEnvelope.payload` is read
 * defensively (`unknown` on the wire type) — a malformed/foreign payload
 * degrades to a dot rather than throwing.
 */
export function overDots(events: readonly EventEnvelope[], bpo: number): string[] {
  const balls = events.filter((e) => BALL_EVENT_TYPES.has(e.type));
  const windowed = balls.slice(-bpo);
  let start = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const payload = windowed[i]!.payload as Record<string, unknown>;
    if (payload.ballInOver === 1) {
      start = i;
      break;
    }
  }
  return windowed.slice(start).map((e) => ballOutcomeSymbol(e.payload as Record<string, unknown>));
}

/** Runs per `bpo`-ball over, or `null` before any legal ball this innings —
 *  presentation-only, cheaply derived, never folded/stored (plan doc's own
 *  "Also settled by the same scout" note). */
export function runRate(runs: number, legalBalls: number, bpo: number): number | null {
  if (legalBalls <= 0) return null;
  return (runs / legalBalls) * bpo;
}

/**
 * A locale-INVARIANT format code (T20/ODI/HUNDRED/TEST), deliberately never
 * routed through `t`: these four are used as bare notation internationally
 * (the same convention a distance unit symbol or a jersey number gets),
 * unlike "Over"/"RR" in the same context line, which genuinely are words —
 * see `buildScorebug`'s own two new dictionary keys for those. `null` when
 * cfg matches none of the four shipped presets (a custom cfg) — the context
 * line simply omits this segment rather than fabricate a label.
 */
export function variantCode(cfg: CricketCfgShape): string | null {
  if (cfg.inningsPerSide === 2) return "TEST";
  if (cfg.ballsPerOver === 5) return "HUNDRED";
  if (cfg.ballsPerInnings === 120) return "T20";
  if (cfg.ballsPerInnings === 300) return "ODI";
  return null;
}

// ---------------------------------------------------------------------------
// phase() — G3. `state.phase` (pre|live|super_over|done|final) maps down to
// the chassis's 3-value PadPhase; `super_over` joins `live` (no PadPhase
// slot of its own, per the controller ruling — types.ts's own doc on
// SkinDefV3.phase).
// ---------------------------------------------------------------------------

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = asState(view.state).phase;
  if (phase === "pre") return "pre";
  if (phase === "done" || phase === "final") return "post";
  return "live"; // live | super_over | (defensive) undefined
}

// ---------------------------------------------------------------------------
// scorebug() — needs `t` for `context`/`WhoLine.name` (this file's header).
// ---------------------------------------------------------------------------

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const cfg = asCfg(view.cfg);
  const state = asState(view.state);
  const bpo = ballsPerOverOf(view.cfg);
  const innings = currentInnings(state);
  const runs = innings?.runs ?? 0;
  const wickets = innings?.wickets ?? 0;
  const legalBalls = innings?.legalBalls ?? 0;
  const people = resolvePeople(state, view.contextOverrides);

  const contextParts: string[] = [];
  const vc = variantCode(cfg);
  if (vc) contextParts.push(vc);
  contextParts.push(`${t("scorepad.skin.cricket.context.over")} ${oversText(legalBalls, bpo)}`);
  const rate = runRate(runs, legalBalls, bpo);
  if (rate !== null) contextParts.push(`${t("scorepad.skin.cricket.context.runRate")} ${rate.toFixed(1)}`);

  const strikerName = people.striker ? (view.personNames[people.striker] ?? people.striker) : "";
  const nonStrikerName = people.nonStriker ? (view.personNames[people.nonStriker] ?? people.nonStriker) : "";
  const bowlerName = people.bowler ? (view.personNames[people.bowler] ?? people.bowler) : "";
  const dots = overDots(view.events, bpo);

  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      { who: [{ name: t("scorepad.skin.cricket.scorebug.batting") }], big: `${runs}/${wickets}` },
      { who: [{ name: t("scorepad.skin.cricket.scorebug.overs") }], big: oversText(legalBalls, bpo) },
    ],
    strip: [
      { value: `▸${strikerName}`, accent: true },
      { value: nonStrikerName },
      { value: dots.length > 0 ? dots.join(" ") : "—" },
      { value: `⚾${bowlerName}` },
    ],
  };
}

// ---------------------------------------------------------------------------
// tiles() — §2.5. Two primary: run "0" and "1" — the two most common
// delivery outcomes in limited-overs cricket (dot balls and singles
// together are the large majority of legal deliveries; ICC-era ball-by-ball
// data across T20/ODI puts each comfortably ahead of every other single run
// value), so they earn the chassis's one visual-weight signal reserved for
// "taps most often" (tile-grid.tsx's own hierarchy rule) — not 4/6, which
// are rarer and already visually loud via the boundary/wicket colouring
// convention on other sports. Wicket is the only `destructive` tile
// (§2.5's own cap: "Wicket, Card"). Everything else is `standard`/`minor`.
// ---------------------------------------------------------------------------

const RUN_VALUES = [0, 1, 2, 3, 4, 6] as const;
const PRIMARY_RUNS = new Set<number>([0, 1]);
const MINOR_EXTRA_KINDS: readonly ExtraKind[] = ["noball", "bye", "legbye", "penalty"];

export function buildTiles(view: PadHostView): TileSpec[] {
  const cfg = asCfg(view.cfg);
  const state = asState(view.state);
  const bpo = ballsPerOverOf(view.cfg);
  const base = basePayload(state, bpo, view.contextOverrides);
  const type = ballEventType(state);
  const twoInnings = cfg.inningsPerSide === 2;

  const tiles: TileSpec[] = [
    { id: "toss", label: "pad.cricket.action.toss", kind: "primary", phases: ["pre"], action: { sheet: "toss" } },
  ];

  for (const r of RUN_VALUES) {
    tiles.push({
      id: `run${r}`,
      label: `pad.cricket.tile.runs.${r}`,
      kind: PRIMARY_RUNS.has(r) ? "primary" : "standard",
      phases: ["live"],
      action: { event: { type, payload: runPayload(base, r) } },
    });
  }

  tiles.push({
    id: "wide",
    label: requiredVocabKey("kind", "wide"),
    kind: "standard",
    phases: ["live"],
    action: { event: { type, payload: extraPayload(base, "wide") } },
  });

  tiles.push({
    id: "wicket",
    label: "pad.cricket.action.wicket",
    kind: "destructive",
    span: 4,
    phases: ["live"],
    action: { sheet: "wicket" },
  });

  for (const kind of MINOR_EXTRA_KINDS) {
    tiles.push({
      id: `extra-${kind}`,
      label: requiredVocabKey("kind", kind),
      kind: "minor",
      phases: ["live"],
      action: { event: { type, payload: extraPayload(base, kind) } },
    });
  }

  tiles.push({ id: "review", label: "pad.cricket.action.review", kind: "standard", phases: ["live"], action: { sheet: "review" } });
  tiles.push({ id: "retire", label: "pad.cricket.action.retire", kind: "standard", phases: ["live"], action: { swap: true } });
  tiles.push({
    id: "inningsClose",
    label: "pad.cricket.action.inningsClose",
    kind: "standard",
    phases: ["live"],
    action: { sheet: "inningsClose" },
  });

  if (twoInnings) {
    tiles.push({
      id: "declare",
      label: "pad.cricket.action.declare",
      kind: "standard",
      phases: ["live"],
      action: { event: { type: "cricket.innings.declare", payload: {} } },
    });
  }

  tiles.push({
    id: "more",
    label: "scorepad.skin.more",
    kind: "minor",
    span: 4,
    phases: ["live", "post"],
    action: { sheet: MORE_SHEET_KEY },
  });

  return tiles;
}

// ---------------------------------------------------------------------------
// dock() — needs `t` for DockSpec.title (this file's header). Free hit only:
// "shot type" (design doc §3's cricket row) has no home in `CricketBall`'s
// `z.strictObject` schema — no field anywhere carries how a shot was played,
// and a strict-object dock mutation adding an unrecognised key would 422 at
// send time. Flagged as a real, engine-schema-shaped gap (out of this wave's
// "no packages/engine work" scope), not a silent scope cut: `freeHit` is the
// one genuinely optional `CricketBall` field, so it is what this dock
// offers. Unconditional (not gated on `fine.freeHitPending`): by dock-render
// time the optimistic fold has ALREADY advanced past the just-tapped ball
// (spec §2.3), so `view.state`'s OWN freeHitPending already reflects
// AFTER this ball, not before it — this chassis gives a skin's `dock(type,
// view)` no per-held-event payload to check instead. Tapping it on an
// ineligible ball surfaces as a normal rejected-submission error (the fold's
// own `"freeHit flagged but no free hit is pending"` check), same as any
// other invalid pick elsewhere in this chassis — not a crash.
// ---------------------------------------------------------------------------

export function buildDock(eventType: string, t: TFn): DockSpec | null {
  if (!BALL_EVENT_TYPES.has(eventType)) return null;
  return {
    title: t("pad.cricket.dock.title"),
    chips: [{ id: "freeHit", label: "pad.cricket.dock.freeHit", mutate: (payload) => ({ ...payload, freeHit: true }) }],
  };
}

// ---------------------------------------------------------------------------
// context() — §2.4, closes D-14. Fold-and-override-authoritative (same
// `resolvePeople(state, view.contextOverrides)` the tiles/sheets use, so the
// strip and the next tap NEVER disagree). No `contextSelect`: cricket has no
// event that records "who is currently bowling/batting" as its own
// standalone fact (all 15 event types checked — see this file's header) —
// declaring one would either invent an event (`createSkinDispatch`'s guard
// forbids that) or silently no-op a real tap, so this skin omits the method
// entirely rather than shipping a function that always returns null (same
// "chassis provides the mechanism, first real skin decides the policy"
// posture `context`/`swap` already establish one level up — types.ts).
//
// G5 (controller ruling 2026-08-16, found by review): the ORIGINAL version
// of this comment recorded that picking a candidate did not persist
// anywhere — the chip would silently revert on the next render, forever.
// Fixed at the HOST, not here: `PadHostView.contextOverrides` (types.ts) is
// pending-selection state `pad-host.tsx` now keeps and feeds back through
// every render, and `resolvePeople`'s own `overrides` parameter (this
// file) is what makes the strip and the payload read it identically. This
// skin still declares no `contextSelect` — the fix does not need one; a
// per-slot override is not itself a persisted engine fact, exactly the gap
// `contextSelect` exists to close for a sport whose engine CAN persist one.
// ---------------------------------------------------------------------------

export function buildContext(view: PadHostView): ContextStripSpec | null {
  const state = asState(view.state);
  if (state.phase !== "live" && state.phase !== "super_over") return null;
  if (currentInnings(state) === null) return null;
  const people = resolvePeople(state, view.contextOverrides);
  return {
    slots: [
      { id: "striker", label: "pad.cricket.context.striker", personId: people.striker || undefined, pool: "onfield", required: true },
      { id: "nonStriker", label: "pad.cricket.context.nonStriker", personId: people.nonStriker || undefined, pool: "onfield", required: true },
      { id: "bowler", label: "pad.cricket.context.bowler", personId: people.bowler || undefined, pool: "onfield", required: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// sheets() — G4. Closes over `view` (types.ts's own doc on why: buildPayload
// needs over/ballInOver/striker/nonStriker/bowler, which the wizard itself
// never asks for). No `t` needed here — `title`/`options[].label` on every
// GuidedSheetStep are i18n KEYS the renderer resolves itself
// (guided-sheet.tsx calls `t(step.title)`/`t(opt.label)`), unlike
// scorebug/dock's pre-resolved fields.
// ---------------------------------------------------------------------------

const CLOSE_REASONS: readonly (readonly [string, string])[] = [
  ["all_out", "allOut"], ["overs_complete", "oversComplete"], ["target_reached", "targetReached"],
  ["time", "time"], ["weather", "weather"], ["forfeited", "forfeited"], ["other", "other"],
];

/**
 * Kind -> who out (runout only) -> fielder (caught/runout/stumped only).
 * Closes D-15.
 *
 * `out`'s candidates (G6 — controller ruling 2026-08-16, superseding this
 * function's own pre-review design): `SheetPersonStep{pool:"onfield",
 * side:battingSide}` ALONE would offer the whole batting-side on-field
 * roster — `SquadMember.onField` is never cleared by a dismissal, only by
 * lineup/substitution events, so by the ninth wicket that pool lists ~9
 * already-out players beside the 2 real ones (a wrong-but-tappable list,
 * D-15 wearing a new coat). `candidates: [striker, nonStriker]` (types.ts's
 * `SheetPersonStep.candidates`) supersedes `pool` and closes it exactly:
 * a run-out has exactly two possible batters, and this skin already knows
 * both from `resolvePeople`. `pool`/`side` stay declared alongside it (every
 * OTHER person step in this chassis still needs them, and a `SheetPersonStep`
 * requires both regardless) but are now dead weight for THIS step
 * specifically once `candidates` is present — kept rather than contorting
 * the type to make them conditionally absent, same "additive, never a
 * breaking narrowing" posture `when` (G2) and `candidates` itself both take.
 * `fielder` has no such narrowing available (a run-out or catch can
 * genuinely come from anyone currently fielding) and keeps its
 * whole-side `pool:"onfield"` — the fold's own validation
 * (`"X" is not at the crease`) is still the correctness backstop there,
 * same as every other pick in this chassis.
 */
function wicketSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const people = resolvePeople(state, view.contextOverrides);
  const base = basePayload(state, ballsPerOverOf(view.cfg), view.contextOverrides);
  // G6: exactly the two batters who can be run out — never an empty-string
  // placeholder (resolvePeople's own "order not populated yet" fallback) —
  // so a not-yet-populated crease offers zero candidates rather than a
  // phantom "" entry `renderCandidateRow` would render as a blank button.
  const outCandidates = [people.striker, people.nonStriker].filter((id): id is string => id !== "");

  const steps: GuidedSheetStep[] = [
    {
      id: "kind",
      kind: "choice",
      title: "pad.cricket.sheet.wicket.kind.title",
      options: WICKET_KINDS.map((k) => ({ id: k, label: requiredVocabKey("kind", k) })),
    },
    {
      id: "out",
      kind: "person",
      title: "pad.cricket.sheet.wicket.who.title",
      pool: "onfield",
      side: people.battingSide,
      candidates: outCandidates,
      when: (answers) => VARIABLE_OUT_KINDS.has(answers.kind as WicketKind),
    },
    {
      id: "fielder",
      kind: "person",
      title: "pad.cricket.sheet.wicket.fielder.title",
      pool: "onfield",
      side: people.bowlingSide,
      when: (answers) => FIELDER_ELIGIBLE_KINDS.has(answers.kind as WicketKind),
    },
  ];

  return {
    event: ballEventType(state),
    steps,
    buildPayload: (answers) => {
      const kind = answers.kind as WicketKind;
      const out = VARIABLE_OUT_KINDS.has(kind) ? answers.out : people.striker;
      const fielder = FIELDER_ELIGIBLE_KINDS.has(kind) ? answers.fielder : undefined;
      return {
        ...base,
        runs: { bat: 0 },
        wicket: {
          kind,
          out,
          ...(fielder ? { fielder } : {}),
          bowlerCredited: BOWLER_CREDITED_KINDS.has(kind),
        },
      };
    },
  };
}

/** Who won -> elected to. `CricketToss` requires both (`wonBy: EntrantId`,
 *  `elected: enum(bat/bowl)`, cricket.ts:239-242) — nothing here is skipped
 *  by `when`, both steps always show. */
function tossSheet(view: PadHostView): GuidedSheetSpec {
  const squads = view.squads;
  return {
    event: "cricket.toss",
    steps: [
      {
        id: "wonBy",
        kind: "choice",
        title: "pad.cricket.sheet.toss.wonBy.title",
        options: [
          { id: squads.home.entrantId, label: "scorepad.attribution.home" },
          { id: squads.away.entrantId, label: "scorepad.attribution.away" },
        ],
      },
      {
        id: "elected",
        kind: "choice",
        title: "pad.cricket.sheet.toss.elected.title",
        options: [
          { id: "bat", label: requiredVocabKey("elected", "bat") },
          { id: "bowl", label: requiredVocabKey("elected", "bowl") },
        ],
      },
    ],
    buildPayload: (answers) => ({ wonBy: answers.wonBy, elected: answers.elected }),
  };
}

/** Kind -> outcome -> called by (side). `CricketReview` also carries two
 *  OPTIONAL person attributions (`person`/`against`, cricket.ts:293-299) —
 *  deliberately not asked here: every guided-sheet step REQUIRES an answer
 *  to advance (there is no "skip" affordance in this chassis), so adding a
 *  step for an optional field would force a tap the engine itself does not
 *  require — the opposite of what this wave exists to fix. Left reachable
 *  only via the generic "More" sheet, same as before this skin existed. */
function reviewSheet(view: PadHostView): GuidedSheetSpec {
  const squads = view.squads;
  return {
    event: "cricket.review",
    steps: [
      {
        id: "kind",
        kind: "choice",
        title: "pad.cricket.sheet.review.kind.title",
        options: [
          { id: "player", label: requiredVocabKey("kind", "player") },
          { id: "umpire", label: requiredVocabKey("kind", "umpire") },
        ],
      },
      {
        id: "outcome",
        kind: "choice",
        title: "pad.cricket.sheet.review.outcome.title",
        options: [
          { id: "upheld", label: requiredVocabKey("outcome", "upheld") },
          { id: "struck_down", label: requiredVocabKey("outcome", "struck_down") },
          { id: "umpires_call", label: requiredVocabKey("outcome", "umpires_call") },
        ],
      },
      {
        id: "by",
        kind: "choice",
        title: "pad.cricket.sheet.review.by.title",
        options: [
          { id: squads.home.entrantId, label: "scorepad.attribution.home" },
          { id: squads.away.entrantId, label: "scorepad.attribution.away" },
        ],
      },
    ],
    buildPayload: (answers) => ({ kind: answers.kind, outcome: answers.outcome, by: answers.by }),
  };
}

/** One step: why the innings closed. `CricketClose.reason` is OPTIONAL in
 *  the schema (the three auto-closes stay unstamped, cricket.ts:244-247),
 *  but the manual cases this tile exists for (time/weather/forfeited/other)
 *  are exactly the ones the fold cannot derive on its own — worth the one
 *  tap, unlike review's optional persons above. */
function inningsCloseSheet(): GuidedSheetSpec {
  return {
    event: "cricket.innings.close",
    steps: [
      {
        id: "reason",
        kind: "choice",
        title: "pad.cricket.sheet.inningsClose.reason.title",
        options: CLOSE_REASONS.map(([value, suffix]) => ({ id: value, label: `pad.cricket.sheet.inningsClose.reason.${suffix}` })),
      },
    ],
    buildPayload: (answers) => ({ reason: answers.reason }),
  };
}

export function buildSheets(view: PadHostView): Record<string, GuidedSheetSpec> {
  return {
    wicket: wicketSheet(view),
    toss: tossSheet(view),
    review: reviewSheet(view),
    inningsClose: inningsCloseSheet(),
  };
}

// ---------------------------------------------------------------------------
// swap() — §2.7. `cricket.retire`: `person`/`incoming` are exactly an
// off/on pair (cricket.ts:274-278, `incoming` optional there — supplied
// here since the whole point of offering the on-picker is to name someone).
// `reason` is REQUIRED with no default (hurt/out/other) and the SwapSheet
// primitive collects only the off/on pair, no third field — "other" is the
// honest generic bucket (never presumes "hurt" for what might be a tactical
// swap of the auto-assigned next batter, design doc §2.7's OTHER named use
// of this same flow: "new batter after a wicket"). `policyOk: true`
// unconditionally: unlike football/hockey's substitutions, cricket.retire
// does not run through `reduceLineupEvent`/`lineupPolicy(cfg)` (it is the
// sport's own event, validated by the cricket fold itself, not the generic
// lineup reducer) — there is no pre-computable policy verdict to gate on
// here; a genuinely illegal retire still surfaces as a normal rejected
// submission, same backstop as the wicket sheet's own fielder step (still
// whole-side, G6's own doc explains why that one can't be narrowed).
// ---------------------------------------------------------------------------

export function buildSwap(view: PadHostView): SwapSlot | null {
  const state = asState(view.state);
  if (state.phase !== "live" && state.phase !== "super_over") return null;
  if (currentInnings(state) === null) return null;
  const people = resolvePeople(state, view.contextOverrides);
  if (!people.striker) return null; // nobody at the crease yet to retire
  return {
    offLabel: "pad.cricket.sheet.retire.who.title",
    onLabel: "pad.cricket.sheet.retire.incoming.title",
    side: people.battingSide,
    policyOk: true,
    buildEvent: (off, on) => ({ type: "cricket.retire", payload: { person: off, incoming: on, reason: "other" } }),
  };
}

// ---------------------------------------------------------------------------
// The factory (this file's header explains why a factory, not a bare
// object).
// ---------------------------------------------------------------------------

export function cricketSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: "cricket",
    tapModel: "T",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: buildTiles,
    dock: (eventType) => buildDock(eventType, t),
    context: buildContext,
    sheets: buildSheets,
    swap: buildSwap,
  };
}
