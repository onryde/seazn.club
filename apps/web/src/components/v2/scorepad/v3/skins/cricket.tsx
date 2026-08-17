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
  type StripItem,
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
  /** Set by `cricket.revise` (either branch — DLS auto-compute or a manual
   *  `target`), present from fidelity band 1 upward (cricket.ts:465-466).
   *  Absent from this shape until this fix (a real regression, not a
   *  deferred gap — see `buildScorebug`'s own comment on the strip item
   *  these two drive). */
  revisedTarget?: number | null;
  targetSource?: "dls" | "manual" | null;
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

/**
 * Defect 3 (R2 review finding, `docs/superpowers/plans/2026-08-16-scorepad-
 * v3-r2-cricket.md`): bowler is genuinely editable ONLY at an over
 * boundary — `fine.currentBowler === null` ("null = new over pending",
 * cricket.ts:414/1152). Once a bowler is on record for the over
 * (`fine.currentBowler` a person id), the strict fold refuses any other pick
 * outright (cricket.ts:1173-1178, "over in progress belongs to X") — the
 * SAME refusal shape striker/non-striker already get `readOnly: true` for
 * (`buildContext` below), so the chip must not offer a choice mid-over
 * either. No `fine` at all (a coarse-fidelity innings) can neither prove a
 * boundary nor submit a ball event regardless of who is picked
 * (cricket.ts:1130, "recorded at summary fidelity") — defaults read-only,
 * the safe side of "never a control that merely LOOKS disabled"
 * (ContextSlot.readOnly's own doc, ../types.ts).
 */
export function bowlerIsReadOnly(innings: CricketInningsShape | null): boolean {
  return innings?.fine?.currentBowler !== null;
}

/** The open innings, or the most recently closed one once none is open
 *  (post-match display). `null` pre-toss / before any innings exists. */
export function currentInnings(state: CricketStateShape): CricketInningsShape | null {
  const innings = state.innings ?? [];
  return innings.find((i) => !i.closed) ?? innings[innings.length - 1] ?? null;
}

export type InningsFidelity = "unopened" | "coarse" | "fine";

/**
 * R2b (Q1 owner ruling, `_INDEX.md`): which entry granularity governs the
 * CURRENT innings — first-event-wins, read straight off the fold, never
 * configured (no cfg field, no org band, no picker anywhere). `"unopened"`
 * when no innings exists yet, so NEITHER lane has locked in; `"coarse"` once
 * a `cricket.innings.summary` opened it (`fine === null` — `createInnings`,
 * cricket.ts:661-678, called with `"coarse"` from `applySummary`,
 * cricket.ts:1406); `"fine"` once a `cricket.ball` opened it instead
 * (`createInnings(...,"fine")`, cricket.ts:2940). The two lanes are mutually
 * exclusive WITHIN one innings — the fold refuses ball-on-coarse
 * (cricket.ts:1128-1131/:2936-2938) AND summary-on-fine (:1402-1404) in both
 * directions — so `buildTiles`/`buildSheets` below gate on THIS, never on
 * `view.band`: the brief's own recommendation to band-gate the over-summary
 * tile was refused by the fold itself (`_INDEX.md`'s "false premises found"
 * for this wave), not by preference.
 *
 * Reuses `bowlerIsReadOnly`'s own narrowing pattern (this file, above) —
 * read `innings?.fine` directly, no second accessor invented for the same
 * fact.
 */
export function inningsFidelity(innings: CricketInningsShape | null): InningsFidelity {
  if (innings === null) return "unopened";
  return innings.fine === null ? "coarse" : "fine";
}

/**
 * 1-indexed: the over an over-summary entry, if confirmed unedited, would
 * complete — matching how a scorer counts overs aloud ("this is over 14"),
 * not `basePayload`'s own 0-indexed `over` field (that one names the over a
 * BALL belongs to; this one names the over a SUMMARY closes out). An
 * unopened innings (`innings === null`) reads as over 1, same as one freshly
 * opened with 0 `legalBalls` recorded yet — both are "the first over about
 * to be entered." `bpo` is genuinely load-bearing here, same reason
 * `ballsPerOverOf`'s own doc gives: `hundred` sets 5, never assume 6.
 */
export function nextOverNumber(innings: CricketInningsShape | null, bpo: number): number {
  return Math.floor((innings?.legalBalls ?? 0) / bpo) + 1;
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

/**
 * D2 fix (Activity panel sign-off review, 2026-08-17): a localised,
 * differentiating detail for one `cricket.ball`/`cricket.superover.ball`
 * row — "Wide" / "Bowled" / "Dot ball" / "4 runs" — for
 * `ActivityPanel`'s `resolveDetail` prop (activity.tsx). Before this, every
 * ball row read the identical per-TYPE caption "Ball recorded" regardless
 * of outcome, because `buildRibbon` (the chassis) resolves a label per
 * event type and the chassis is deliberately sport-agnostic — it must not
 * know cricket's payload shape (`runs.bat`, `runs.extras.kind`,
 * `wicket.kind`). This skin owns that vocabulary instead, mirroring
 * `ballOutcomeSymbol`'s own decision order (wicket, then extras-by-kind,
 * then plain runs) but producing WORDS via `t`/`requiredVocabKey` rather
 * than the compact over-dot symbols that function renders.
 *
 * Reuses the WICKET/EXTRA `"kind"` vocab (`ENUM_VOCAB`/`requiredVocabKey`)
 * already translated for the wicket sheet and the extras tiles — zero new
 * dictionary keys for those two branches, only the plain-runs branch below
 * needs new copy (`pad.cricket.ribbon.ball.dot`/`.run`/`.runs`).
 *
 * Deliberately coarse, not further sub-differentiated: two wides that
 * differ only by extra-run count both read "Wide" (the CATEGORY, not the
 * count) — differentiating dot/single/boundary/wide/no-ball/wicket already
 * closes the defect a screenshot caught (three identical "Ball recorded"
 * rows); adding per-count granularity on top is a documented, deliberate
 * scope boundary, not a gap.
 *
 * Returns `undefined` for any non-ball event type, so wiring this as a
 * generic `resolveDetail` leaves every other cricket row (toss/review/
 * retire/…) on its existing static caption untouched.
 */
export function cricketBallDetail(
  t: TFn,
  eventType: string,
  payload: Record<string, unknown>,
): string | undefined {
  if (!BALL_EVENT_TYPES.has(eventType)) return undefined;
  const p = payload as {
    wicket?: { kind?: string };
    runs?: { bat?: number; extras?: { kind?: string; runs?: number } };
  };
  if (p.wicket?.kind) return t(requiredVocabKey("kind", p.wicket.kind));
  const extraKind = p.runs?.extras?.kind;
  if (extraKind) return t(requiredVocabKey("kind", extraKind));
  const bat = p.runs?.bat ?? 0;
  if (bat === 0) return t("pad.cricket.ribbon.ball.dot");
  if (bat === 1) return t("pad.cricket.ribbon.ball.run");
  return t("pad.cricket.ribbon.ball.runs", { runs: bat });
}

/** Runs per `bpo`-ball over, or `null` before any legal ball this innings —
 *  presentation-only, cheaply derived, never folded/stored (plan doc's own
 *  "Also settled by the same scout" note). */
export function runRate(runs: number, legalBalls: number, bpo: number): number | null {
  if (legalBalls <= 0) return null;
  return (runs / legalBalls) * bpo;
}

/**
 * The runs the chasing side needs to win, with the caption it should carry —
 * ported from v2's own `chaseValue`+`isDls` pair (`../../skins/cricket-
 * skin.tsx`). Major 3 (R2 review finding, `docs/superpowers/plans/2026-08-
 * 16-scorepad-v3-r2-cricket.md`): `buildScorebug`'s first version read an
 * EXPLICIT `revisedTarget` only, so an ORDINARY chase — no DLS revise, nobody
 * manually set a target — showed nothing at all, even though that is the
 * COMMON case (most matches never see a `cricket.revise`).
 *
 * Single-innings: an explicit `revisedTarget` when one has been recorded,
 * else the trivial "first innings + 1" arithmetic — ONLY once a second
 * innings actually exists (there is nothing to chase before that). Two-
 * innings (test): only an EXPLICIT revision — the natural 4th-innings target
 * needs cross-innings aggregation the engine owns privately (`chaseTarget()`,
 * cricket.ts, not exported), and reimplementing that here would be exactly
 * the domain-logic duplication v2's own comment already warned against; a
 * two-innings match with no revise shows no target at all, matching v2 byte
 * for byte.
 *
 * `isDls` mirrors v2's own guard exactly: `cfg.dls` must be CURRENTLY
 * enabled, not merely true when the revise happened. When `value` comes from
 * the arithmetic fallback (no `revisedTarget` recorded at all), `targetSource`
 * is necessarily not `"dls"` either — the engine only ever sets the two
 * together — so `isDls` is always false there; not a separate branch, the
 * same single check v2 uses for both cases.
 */
export function chaseTarget(cfg: CricketCfgShape, state: CricketStateShape): { value: number; isDls: boolean } | null {
  const innings = state.innings ?? [];
  const singleInnings = cfg.inningsPerSide !== 2;
  let value: number | null;
  if (singleInnings) {
    if (innings.length < 2) {
      value = null;
    } else if (state.revisedTarget != null) {
      value = state.revisedTarget;
    } else {
      const first = innings[0];
      value = typeof first?.runs === "number" ? first.runs + 1 : null;
    }
  } else {
    value = state.revisedTarget ?? null;
  }
  if (value === null) return null;
  return { value, isDls: cfg.dls?.enabled === true && state.targetSource === "dls" };
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

  // REGRESSION FIX (not a deferred gap — found inside this wave's own blast
  // radius, then extended by Major 3's own review finding): v2's
  // `chaseValue`/`ck-revised-target` (cricket-skin.tsx) showed the chasing
  // side's target the moment one existed — including the plain "first
  // innings + 1" arithmetic for an ordinary chase with no DLS revise, the
  // COMMON case; this v3 rewrite originally read `revisedTarget` only, which
  // Major 3 closes via `chaseTarget` above (ported from v2 verbatim).
  // Appended to `strip`, never `context`: `context` is the chassis's most
  // MUTED text (scorebug.tsx's `creamTextSubtle`, 11px) reserved for ambient
  // format/over/run-rate, while `strip` already supports per-item `accent`
  // emphasis (the striker marker uses it) and sits one visual step below the
  // halves — the closest available slot to "the score itself" without
  // widening `halves`' fixed 2-slot tuple, which would touch the shared
  // chassis type/renderer this wave must not edit. APPENDED after bowler,
  // not prepended: prepending would reindex the four existing items
  // `cricket.test.ts` already pins at strip[0]/[1]/[3] for no functional
  // gain. `accent: true` so it reads with the same visual weight as the
  // on-strike marker, matching "the most-read number after the score" — the
  // other three passive items stay muted. Gated on `chaseTarget` returning
  // non-null ONLY (no fidelity-band check): the fold populates
  // `revisedTarget` from band 1 up (cricket.ts:465-466), the arithmetic
  // fallback needs nothing from the fold beyond ordinary summary-level
  // innings totals, and this builder never reads `view.band` — a lower-band
  // pad still gets it. The ball-by-ball strip items above it (striker/dots/
  // bowler) are the band-3 surface, this is not. `target.isDls` picks the
  // caption (a DLS par is "be ahead of this line right now", not "reach
  // this total by the end") — see `chaseTarget`'s own doc for why that flag
  // is always false on the arithmetic-fallback branch, not a separate check.
  const strip: StripItem[] = [
    { value: `▸${strikerName}`, accent: true },
    { value: nonStrikerName },
    { value: dots.length > 0 ? dots.join(" ") : "—" },
    { value: `⚾${bowlerName}` },
  ];
  const target = chaseTarget(cfg, state);
  if (target) {
    strip.push({
      label: t(target.isDls ? "scorepad.skin.cricket.header.dlsPar" : "scorepad.skin.cricket.header.target"),
      value: String(target.value),
      accent: true,
    });
  }

  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      { who: [{ name: t("scorepad.skin.cricket.scorebug.batting") }], big: `${runs}/${wickets}` },
      { who: [{ name: t("scorepad.skin.cricket.scorebug.overs") }], big: oversText(legalBalls, bpo) },
    ],
    strip,
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
  const innings = currentInnings(state);
  const fidelity = inningsFidelity(innings);

  const tiles: TileSpec[] = [
    { id: "toss", label: "pad.cricket.action.toss", kind: "primary", phases: ["pre"], action: { sheet: "toss" } },
  ];

  // R2b (Q1 owner ruling, `_INDEX.md`): ball-derived tiles only when this
  // innings can legally take a `cricket.ball` at all — never once it is
  // coarse, where the fold refuses one outright (cricket.ts:1128-1131/
  // :2936-2938). Every visible tap stays legal at the moment it is visible.
  if (fidelity !== "coarse") {
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

  // R2b (Q1 owner ruling): the over-by-over entry point — hidden once this
  // innings is ball-level, where the fold refuses `cricket.innings.summary`
  // just as firmly (cricket.ts:1402-1404), the mirror image of the guard
  // above. `primary`/span-2 even when it co-occurs with run0/run1 (innings
  // unopened): a genuine, first-tap fork in how the WHOLE innings gets
  // scored earns the same weight as the two most-common ball outcomes, not
  // less — `assertTileHierarchy`'s ">2 primaries" convention (tile-grid.tsx)
  // is advisory only and not wired to any skin's real output yet (R1 fix
  // round 1's own note), so this is a deliberate exception, not a defect.
  if (fidelity !== "fine") {
    tiles.push({
      id: "overSummary",
      label: "pad.cricket.action.endOfOver",
      // Locale-invariant numeral, same convention `variantCode()` documents
      // above for T20/ODI/HUNDRED/TEST: a bare over count needs no
      // translation, and `tile-grid.tsx` (out of this wave's file grant)
      // resolves `sublabel` as `t(tile.sublabel)` with no `vars` — a key
      // needing interpolation would have nowhere to receive one. A bare
      // numeral renders correctly on every locale with zero dictionary
      // entries because `msgFor`'s own fallback echoes an unregistered key
      // verbatim (`messages-i18n.test.ts`), which is exactly a numeral's
      // own "translation."
      sublabel: String(nextOverNumber(innings, bpo)),
      kind: "primary",
      span: 2,
      phases: ["live"],
      action: { sheet: "overSummary" },
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
//
// BLOCKER 2 (found by a later review, 2026-08-16, same plan doc): G5 made an
// override PERSIST, but never asked whether the engine would actually ACCEPT
// one for every slot — it does not. `cricket.ts`'s `applyDelivery` runs
// striker/non-striker under `strictOrder: true` (cricket.ts:1183-1200), and
// on the LIVE submit path (`isStrictFold` defaults true — only
// reconciliation/replay of already-ledgered history ever passes
// `strict:false`) a submitted ball whose striker/nonStriker disagrees with
// the fold's OWN derived pair is refused outright, not silently corrected.
// So a scorer tapping either chip and picking anyone could open the picker,
// choose a name, and watch every subsequent ball get rejected — the exact
// "picker opens and silently fails" shape G5 closed, reopened for two of
// three slots. Bowler is different: `currentBowler === null` (an over
// boundary, cricket.ts:1152-1172) accepts ANY eligible bowler with no
// fold-match check at all — a genuine edit — so only striker/nonStriker get
// an UNCONDITIONAL `readOnly: true` below (ContextSlot.readOnly,
// ../types.ts). The two names stay in the strip regardless: they are real,
// useful information (who is on strike right now) even though a scorer
// cannot reassign them from here.
//
// DEFECT 3 (found by a later review, 2026-08-16, same plan doc): blocker 2's
// own bowler comment left the chip unconditionally tappable and flagged,
// rather than closed, the mid-over case — the fold is JUST as strict about
// bowler there as it is about striker/non-striker (cricket.ts:1173-1178,
// "over in progress belongs to X"), so a scorer could tap it, pick anyone,
// and watch the next ball get rejected — the identical "picker opens and
// silently fails" shape this file has now closed twice. `bowlerIsReadOnly`
// (above) derives the answer straight from `fine.currentBowler` instead of
// leaving the chip permanently open: `true` mid-over, `undefined` (editable)
// at an over boundary, matching striker/nonStriker's own "absent means
// editable" convention rather than writing a redundant `readOnly: false`.
// ---------------------------------------------------------------------------

export function buildContext(view: PadHostView): ContextStripSpec | null {
  const state = asState(view.state);
  if (state.phase !== "live" && state.phase !== "super_over") return null;
  const innings = currentInnings(state);
  if (innings === null) return null;
  const people = resolvePeople(state, view.contextOverrides);
  const bowlerReadOnly = bowlerIsReadOnly(innings);
  return {
    slots: [
      {
        id: "striker",
        label: "pad.cricket.context.striker",
        personId: people.striker || undefined,
        pool: "onfield",
        required: true,
        readOnly: true, // blocker 2 — see this file's header above
      },
      {
        id: "nonStriker",
        label: "pad.cricket.context.nonStriker",
        personId: people.nonStriker || undefined,
        pool: "onfield",
        required: true,
        readOnly: true, // blocker 2 — see this file's header above
      },
      {
        id: "bowler",
        label: "pad.cricket.context.bowler",
        personId: people.bowler || undefined,
        pool: "onfield",
        required: true,
        readOnly: bowlerReadOnly ? true : undefined, // defect 3 — see this file's header above
      },
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

/**
 * R2b — the over-by-over entry point (Q1/Q2 owner rulings, `_INDEX.md`).
 * Three `SheetNumberStep`s, each PREFILLED from the fold's own current
 * innings total (Q2: "the scorer edits them up," never an increment form —
 * an increment would have to add in pad code against a fold that could be
 * stale by the time it lands, types.ts's own doc on `SheetNumberStep`).
 *
 * `min` on each step is the CURRENT fold value for that field, not 0: this
 * is what keeps the engine's own "summary totals may not decrease" guard
 * (cricket.ts:1416-1426) structurally UNREACHABLE through this sheet's
 * stepper/field, rather than merely caught after a rejected submission —
 * Q2's own "the monotone guard can never fire on a correct entry," enforced
 * here. No `max` on any of the three: `allOut`/`ballsLimit` are strict,
 * cfg/squad-derived checks the ENGINE makes (`applySummary`, same file) and
 * are not exported for this pad to duplicate — same "the fold's own
 * validation is still the correctness backstop" posture the wicket sheet's
 * `fielder` step already takes (`wicketSheet`'s own doc, above).
 *
 * `balls` prefills to CURRENT + one full `ballsPerOverOf(cfg)` (never a
 * hardcoded 6 — `hundred` sets 5, cricket.ts:2811) — "assume a full over
 * unless told otherwise" — and stays EDITABLE, not derived: an innings can
 * end mid-over (all out, target reached, time), so the balls this entry
 * closes out are not always a whole extra over.
 *
 * `hint` on all three: the fold's CURRENT total as `${runs}/${wickets}` —
 * the exact notation `buildScorebug`'s own `halves[0].big` already uses, so
 * it needs no translation (numerals + "/" read identically on every locale)
 * and this function can stay `t`-free like every OTHER member here except
 * `scorebug`/`dock` (this file's header). This is the closest HONEST
 * approximation of the plan's own design note ("a before → after ledger
 * line... live as the numbers change"): `hint` is baked once when this
 * record is built (G4, types.ts) and rendered VERBATIM by guided-sheet.tsx
 * (never through `t()`, that file's own doc on `SheetNumberStep.hint`) — it
 * cannot react to a scorer's still-in-progress stepper taps on ANY step
 * (guided-sheet.tsx is out of this wave's file grant, and
 * `SheetNumberStep.hint` is a plain `string`, not a function of the live
 * edit value or of answers already given earlier in the SAME wizard run).
 * What ships instead: a correct, always-fresh "before" anchor — rebuilt
 * every `sheets(view)` call, per `PadHostView`'s own "never stale"
 * obligation — sitting directly above the ALREADY-live editable field
 * (task 2's own `renderNumberStep`), which together is the closest real
 * approximation of the ledger the design note describes. Flagged here as a
 * deliberate deviation, not a silent reinterpretation.
 */
function overSummarySheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const innings = currentInnings(state);
  const bpo = ballsPerOverOf(view.cfg);
  const runs = innings?.runs ?? 0;
  const wickets = innings?.wickets ?? 0;
  const legalBalls = innings?.legalBalls ?? 0;
  const before = `${runs}/${wickets}`;

  const steps: GuidedSheetStep[] = [
    { id: "runs", kind: "number", title: "pad.cricket.sheet.overSummary.runs.title", initial: runs, min: runs, hint: before },
    { id: "wickets", kind: "number", title: "pad.cricket.sheet.overSummary.wickets.title", initial: wickets, min: wickets, hint: before },
    { id: "balls", kind: "number", title: "pad.cricket.sheet.overSummary.balls.title", initial: legalBalls + bpo, min: legalBalls, hint: before },
  ];

  return {
    event: "cricket.innings.summary",
    steps,
    buildPayload: (answers) => ({
      runs: Number(answers.runs),
      wickets: Number(answers.wickets),
      legalBalls: Number(answers.balls),
      partial: true,
    }),
  };
}

export function buildSheets(view: PadHostView): Record<string, GuidedSheetSpec> {
  return {
    wicket: wicketSheet(view),
    toss: tossSheet(view),
    review: reviewSheet(view),
    inningsClose: inningsCloseSheet(),
    overSummary: overSummarySheet(view),
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
    // D2 (R2 sign-off): the skin supplies per-ball detail so the activity
    // panel's rows differ from one another. Declared HERE rather than the
    // chassis importing `cricketBallDetail` directly — sport vocabulary stays
    // skin-owned. Without this line the function exists, its unit tests pass,
    // and every row still reads "Ball recorded" in the product.
    activityDetail: cricketBallDetail,
    swap: buildSwap,
  };
}
