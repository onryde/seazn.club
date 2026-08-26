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
// is a FACTORY taking `t` once, closing it over for `scorebug`/`dock`/
// `context` (the methods with a pre-resolved-string field — `context`
// joined this list in R2b, `ContextSlot.message`'s own doc in ../types.ts,
// once the bowler-eligibility block needed an interpolated name/quota baked
// into a string before it reaches the chassis) — every other member
// (`tiles`/`sheets`/`phase`) is a plain, `t`-free function of `view`
// alone, independently exported and testable with no `t` involved. (cricket
// declares no `swap` at all as of R2b — see the "swap() — DROPPED" section
// further down.)
// (`tiles` is the one exception worth flagging: it also RECEIVES an
// optional `t` for `TileSpec.labelText`'s own sake, but keeps a working
// default — `buildTiles`'s own header explains why that one is defaulted
// rather than required, unlike `buildContext` below which follows the
// identical defaulted-for-back-compat shape for the SAME reason: dozens of
// pre-R2b call sites in this file's own test suite pass it only one
// argument.)
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
// Engine rules this file uses rather than re-states. R2b imported exactly one
// (`nextBattingSide`) and MIRRORED the over-bowler eligibility rule as a local
// `isEligibleOverBowler`, because the export had not been granted — which cost
// that wave's review a byte-for-byte verification to trust, and left a rule
// free to drift across a package boundary. R2c needs the eligible LIST (to
// narrow the bowler chip's candidates, not merely to test one name), which is
// exactly what the engine's own filter already is, so the mirror is DELETED
// and the rule imported. Same reasoning `nextBattingSide` was granted on.
import { activeInnings, eligibleBowlers, nextBattingSide, reviewsRemaining } from "@seazn/engine/sports/cricket";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import {
  type Blocked,
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type ContextStripSpec,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugSpec,
  type SkinDefV3,
  type StripItem,
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
/**
 * R2b-over (review finding — the fourth instance of "the pad must never
 * offer what the engine will refuse", `_INDEX.md`): dismissals still legal
 * while a free hit is pending — the engine's own restriction, verbatim
 * (`cricket.ts:1275-1276`): `if (fine.freeHitPending && wicket.kind !==
 * "runout" && wicket.kind !== "obstructed") invalid(...)`. Every OTHER
 * WICKET_KINDS member is refused outright in that state. `wicketSheet`
 * (below) is the only reader — narrows the "kind" step's `options` to this
 * set whenever `freeHitPending(view.events, ...)` (the SAME fold
 * `buildScorebug`'s indicator and `cricketBallDetail`'s activity note
 * already use) is true, so the sheet can never offer a tap the server would
 * bounce.
 */
export const FREE_HIT_WICKET_KINDS = new Set<WicketKind>(["runout", "obstructed"]);
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
  /** t20: 4, odi: 10, hundred: 4 (cricket.ts's own `variants`); absent for
   *  test cricket (no cap). Bug fix (R2b live bug, 2026-08-17) — needed so
   *  `resolvePeople`'s bowler default can mirror the engine's own quota
   *  check (cricket.ts:1166-1171) rather than proposing an exhausted
   *  bowler. */
  maxOversPerBowler?: number;
  /** R2c / C3 — the per-innings player-review allowance. ABSENT means
   *  uncapped, never zero (the engine's own `reviewsRemaining` reading). */
  reviews?: { perInnings?: number } | undefined;
}
interface CricketFineShape {
  striker?: string | null;
  nonStriker?: string | null;
  currentBowler?: string | null;
  freeHitPending?: boolean;
  /** Bug fix (R2b live bug, 2026-08-17): mirrors the engine's own
   *  `FineInnings.prevOverBowler`/`.bowlerBalls` (cricket.ts:415/419) —
   *  needed by `resolvePeople`'s bowler default to mirror the engine's own
   *  consecutive-over/quota checks (cricket.ts:1160-1171). Both absent from
   *  this shape until this fix; see `resolvePeople`'s own doc for why. */
  prevOverBowler?: string | null;
  bowlerBalls?: Record<string, number>;
}
interface CricketInningsShape {
  battingSide?: "home" | "away";
  runs?: number;
  wickets?: number;
  legalBalls?: number;
  closed?: boolean;
  fine?: CricketFineShape | null;
  /** R2c / C3 — the per-side review ledger the engine's own `reviewsRemaining`
   *  reads. Absent from this shape until C3 needed it, the same way
   *  `prevOverBowler`/`bowlerBalls` were absent until R2b needed them: this
   *  shape carries only what the skin has had a reason to read. `lost`, not
   *  `taken`, is the counter that spends an allowance. */
  reviews?: Record<"home" | "away", { taken: number; lost: number }> | undefined;
}
interface CricketStateShape {
  phase?: "pre" | "live" | "super_over" | "done" | "final";
  innings?: CricketInningsShape[];
  /** R3.5 — the super over's OWN innings list. The engine keeps it here and
   *  never in `innings` (a super-over innings is the third and fourth of the
   *  match, numbered by `activeInnings`'s own `offset`). Absent from this
   *  shape until now, which is exactly why the pad spent every super over
   *  describing the innings before it: `currentInnings`/`dueBattingSide`/
   *  `chaseTarget` (below) could not see this field, so they answered every
   *  question — score, target, bowler, whether tiles should be live — off
   *  the closed MAIN innings, unconditionally. `null` is the fold's own
   *  "not yet in a super over" value (`CricketState.superOver`,
   *  cricket.ts:470-473); absent is the shape-probe default every OTHER
   *  optional field on this interface already tolerates. */
  superOver?: { innings?: CricketInningsShape[] } | null;
  orders?: { home?: string[]; away?: string[] };
  /** Set by `cricket.revise` (either branch — DLS auto-compute or a manual
   *  `target`), present from fidelity band 1 upward (cricket.ts:465-466).
   *  Absent from this shape until this fix (a real regression, not a
   *  deferred gap — see `buildScorebug`'s own comment on the strip item
   *  these two drive). */
  revisedTarget?: number | null;
  targetSource?: "dls" | "manual" | null;
  /** Bug fix (owner-confirmed live blocker, 2026-08-17 — R2b-next): who bats
   *  first (`CricketState.battingFirst`, cricket.ts:460) and whether a
   *  follow-on was enforced (`.followOnEnforced`, cricket.ts:463) — needed
   *  by `dueBattingSide` (below) to mirror the engine's own
   *  `nextBattingSide` innings-sequencing rule. Absent from this shape until
   *  this fix, same "add the field this fix needs" pattern every other
   *  addition here already follows. */
  battingFirst?: "home" | "away";
  followOnEnforced?: boolean;
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
 *  (post-match display). `null` pre-toss / before any innings exists, and
 *  `null` again between a tie and the first super-over ball (the SO innings
 *  list exists but is empty — see `activeInnings`'s own doc for why that is
 *  not the same thing as "no super over").
 *
 * R3.5 — delegates to the engine's `activeInnings` so this and the position
 * axis (`cricketPosition`, cricket.ts) cannot fork on which innings list is
 * live; see that function's own doc for why this is not a local switch. This
 * keeps the pre-existing "fall back to the last innings once every one is
 * closed" display rule, now applied to whichever list is ACTUALLY active. */
export function currentInnings(state: CricketStateShape): CricketInningsShape | null {
  const { list } = activeInnings<CricketInningsShape>({
    innings: state.innings ?? [],
    superOver: state.superOver ? { innings: state.superOver.innings ?? [] } : null,
  });
  return list.find((i) => !i.closed) ?? list[list.length - 1] ?? null;
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
 * R2b-next (owner-confirmed live blocker, 2026-08-17): the batting side for
 * the innings that would open NEXT, but ONLY in the one state where that
 * question is actually live — the current/fallback innings (`currentInnings`
 * above) is CLOSED and the fold would still accept another one. `null` in
 * every other case: no innings exists yet, the current one is still OPEN
 * (its own `battingSide` already answers this), or nothing further is due
 * (the genuinely terminal case — the closure message stays correct there).
 *
 * A thin wrapper around the engine's own `nextBattingSide` (cricket.ts,
 * exported this same wave) — never a hand-copy of its alternation/follow-on
 * branches, the recurring defect class this repo keeps hitting when a rule
 * gets forked across the engine/apps-web boundary. `state.innings.length`
 * is the SAME index `createInnings` itself addresses by (cricket.ts:662).
 *
 * R3.5 — inside a super over the MAIN-innings sequencing rule above does not
 * apply: `nextBattingSide` counts main innings only, and by the time a super
 * over exists both are always closed — it would report a main-innings side
 * "due" while the engine is mid-decider, which is the fork this branch
 * exists to stop. The super over's own rule is simply "the OTHER side bats
 * next", and only while the current pair is incomplete: `null` while an
 * innings is still open (its own `battingSide` already answers the
 * question), `null` before the first ball of the whole super over (nobody is
 * "due" yet — C2, the pad is about to offer the very first pick), and `null`
 * once a pair has just completed (a `repeat` policy opens the next pair on
 * the next ball itself, with no due-side gap to announce in between).
 */
export function dueBattingSide(state: CricketStateShape, cfg: CricketCfgShape): "home" | "away" | null {
  const so = state.superOver?.innings;
  if (state.phase === "super_over" && so !== undefined) {
    const open = so.find((i) => !i.closed);
    if (open) return null; // an innings is in progress
    if (so.length === 0) return null; // none created yet — C2
    if (so.length % 2 === 1) {
      // Pair incomplete: the other side is due.
      return opponentSide((so[so.length - 1] as CricketInningsShape).battingSide ?? "home");
    }
    return null; // pair complete: a repeat opens the next pair on the next ball
  }
  const innings = currentInnings(state);
  if (innings === null || innings.closed !== true) return null;
  return nextBattingSide({
    battingFirst: state.battingFirst ?? "home",
    followOnEnforced: state.followOnEnforced ?? false,
    cfg: { inningsPerSide: cfg.inningsPerSide ?? 1 },
    inningsCount: state.innings?.length ?? 0,
  });
}

/**
 * R2b-next: the innings to build a NEW payload/tile-set/sheet-default
 * against — as opposed to `currentInnings` (DISPLAY: `buildScorebug` must
 * keep showing the closed innings' own final score no matter what). `null`
 * whenever a FRESH innings is what is actually being scored: pre-match
 * (nothing recorded at all) and "closed, another due" (nothing recorded for
 * THAT one either) collapse to the identical treatment throughout this file
 * — `inningsFidelity`, `nextOverNumber`, and this function's own callers
 * below all already do the right thing for `null` (an unopened innings
 * offers both fidelity lanes and starts counting from over 1, exactly what
 * a not-yet-created next innings should do too). `dueBattingSide` (above) is
 * the one place that DOES tell the two `null`-producing cases apart, and
 * every caller needing that distinction reads it separately.
 */
function scoringInnings(state: CricketStateShape, cfg: CricketCfgShape): CricketInningsShape | null {
  return dueBattingSide(state, cfg) !== null ? null : currentInnings(state);
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
 *  `battingOrder[0]`/`[1]` for striker/non-striker — stateless here (no
 *  local component state available to a pure skin builder), so this default
 *  is recomputed fresh each call rather than remembered across renders.
 *  Empty string when even the order itself isn't populated yet (pre-lineup).
 *
 *  `overrides` (G5 — controller ruling 2026-08-16): `view.contextOverrides`,
 *  a slot id -> person id map of PENDING context-strip picks the HOST holds
 *  (types.ts's own doc on `PadHostView.contextOverrides`). Checked FIRST,
 *  ahead of `fine.*` and the order-derived default — an override represents
 *  a scorer's own just-tapped choice, which must win over both the last
 *  KNOWN fold value and the fallback default. Defaults to `{}` so every
 *  pre-G5 call site (none passed a second argument) keeps behaving
 *  identically.
 *
 *  Bug fix (owner-reported, live data, 2026-08-17): the bowler default used
 *  to read `bowlingOrder[0]` unconditionally — at an over boundary
 *  (`fine.currentBowler === null`) with bowlingOrder[0] having just bowled
 *  the previous over or exhausted his quota, this proposed a bowler the
 *  engine would refuse outright, and the scorer could not start the next
 *  over at all (see this file's own test suite for the exact live
 *  reproduction). Now the first ELIGIBLE name in `bowlingOrder`
 *  (the engine's own `eligibleBowlers`) — `""` (never an illegal name) when
 *  nobody qualifies, forcing the scorer to choose via the context strip
 *  rather than silently shipping a payload the engine will reject. `cfg`
 *  (new 3rd param, defaulted to `{}`) is what this needs: every pre-fix call
 *  site either already had a `CricketCfgShape` in scope (updated below) or
 *  — for direct 2-arg test calls — gets `maxOversPerBowler: undefined` (no
 *  quota check) and `ballsPerOverOf({}) === 6`, which reproduces the OLD
 *  bowlingOrder[0]-always behaviour exactly whenever `fine.prevOverBowler`/
 *  `.bowlerBalls` are absent too (every pre-fix fixture), so no existing
 *  caller's behaviour silently changes underneath it. This does NOT touch
 *  the mid-over branch (`fine?.currentBowler`, checked first) or the
 *  `overrides.bowler` branch (checked first of all) — a manual pick is never
 *  second-guessed, and the fold's own strict mid-over refusal
 *  (cricket.ts:1173-1178) is untouched. */
export function resolvePeople(
  state: CricketStateShape,
  overrides: Readonly<Record<string, string>> = {},
  cfg: CricketCfgShape = {},
): ResolvedPeople {
  // R2b-next: `scoringInnings`/`dueBattingSide` (above) — `battingSide`
  // falls through to the DUE side (closed, another innings still due)
  // ahead of the stale closed innings' own `battingSide`; `innings` itself
  // (for `fine`, below) is `null` in that same state, so striker/nonStriker/
  // bowler all fall to their own "unopened innings" defaults, exactly as
  // they already do before innings ONE's own first ball.
  const innings = scoringInnings(state, cfg);
  const due = dueBattingSide(state, cfg);
  const battingSide = due ?? innings?.battingSide ?? "home";
  const bowlingSide = opponentSide(battingSide);
  const battingOrder = state.orders?.[battingSide] ?? [];
  const bowlingOrder = state.orders?.[bowlingSide] ?? [];
  const fine = innings?.fine ?? null;
  const bpo = ballsPerOverOf(cfg);
  return {
    battingSide,
    bowlingSide,
    striker: overrides.striker ?? fine?.striker ?? battingOrder[0] ?? "",
    nonStriker: overrides.nonStriker ?? fine?.nonStriker ?? battingOrder[1] ?? "",
    bowler:
      overrides.bowler ??
      fine?.currentBowler ??
      eligibleBowlers(bowlingOrder, fine, cfg.maxOversPerBowler, bpo)[0] ??
      "",
  };
}

export type BowlerBlockReason = "prevOver" | "notInLineup" | "quota" | "noEligible";

/**
 * R2b live bug PART 2 (owner-reported, reproduced against real data,
 * 2026-08-17): `resolvePeople`'s own default (above) already stops
 * PROPOSING an ineligible bowler, but a scorer who MANUALLY overrides the
 * bowler chip at an over boundary can still end up with an ineligible
 * `people.bowler` — the context-strip's candidate picker offers BOTH
 * sides' whole on-field roster with no eligibility narrowing at all
 * (`buildContext`'s own CANDIDATE-LIST GAP note, below — a pre-existing,
 * still-open gap this function does not close, only catches the
 * consequence of). Tapping a run/wicket tile at that point still emits a
 * `cricket.ball` the client's deliberately non-strict optimistic fold
 * accepts, only for the server to refuse it moments later as a generic
 * rejection. This function is the gate that stops the TAP itself, in the
 * tile-building path — `null` means the ball-emitting tiles stay tappable
 * as normal; any other value is why they must not be (`buildTiles`/
 * `buildContext` below, the only two callers).
 *
 * MID-OVER (`fine.currentBowler` already set) is never checked — that
 * bowler is already locked in by the fold unconditionally, regardless of
 * eligibility data, the same short-circuit `resolvePeople`'s own bowler
 * branch and `bowlerIsReadOnly` already take.
 *
 * Priority mirrors the ENGINE's own real order at an over boundary
 * verbatim (`applyDelivery`, cricket.ts:1160-1171): consecutive-over
 * first, then fielding-lineup membership, then quota — each an early
 * return, exactly like the engine's own sequential `invalid()` calls only
 * ever throw on the FIRST ground that matches. The engine's own
 * `eligibleBowlers` already owns two of these three grounds verbatim
 * (consecutive-over + quota) — reused below for the QUOTA determination
 * specifically (by the time it is called, consecutive-over is already
 * ruled out, so a `false` result can only mean quota). It is deliberately
 * NOT reused for the lineup-membership check: that is the one ground
 * `eligibleBowlers`'s own doc explains is ABSENT from that filter,
 * because every one of its OTHER callers draws `personId` FROM
 * `bowlingOrder` itself, so it always already holds — the manual-override
 * path is the first caller that can break that invariant (a picked name
 * can be a BATTING-side player), so this function checks lineup membership
 * directly rather than asking the engine's filter to take on a ground it
 * deliberately does not carry.
 *
 * `"noEligible"` — the dead-end case the task brief required a decision
 * on, not a silent block-everything: every fielding-side player is either
 * the previous over's bowler or already at quota, so NOBODY can legally
 * open the next over. This does not read as a CRICKET rule (the laws of
 * the game do not contemplate a fielding side too small to field a legal
 * bowler) so much as a data/product edge case — see this task's own
 * report for why that reads as a decision still owed, not resolved here.
 * `resolvePeople`'s own default already encodes the signal (`""`, never an
 * illegal name) and this function reads it rather than re-deriving it.
 */
export function bowlerBlockReason(
  state: CricketStateShape,
  people: ResolvedPeople,
  cfg: CricketCfgShape,
): BowlerBlockReason | null {
  // R2b-next: `scoringInnings`, not `currentInnings` — reading the CLOSED
  // innings' own stale `fine` here (prevOverBowler/bowlerBalls from the
  // innings that just ended) would wrongly block `people.bowler`, who was
  // resolved against the NEW innings and has no history in this one at all.
  const innings = scoringInnings(state, cfg);
  const fine = innings?.fine ?? null;
  if ((fine?.currentBowler ?? null) !== null) return null;
  if (people.bowler === "") return "noEligible";
  if (people.bowler === (fine?.prevOverBowler ?? null)) return "prevOver";
  const bowlingOrder = state.orders?.[people.bowlingSide] ?? [];
  if (!bowlingOrder.includes(people.bowler)) return "notInLineup";
  const bpo = ballsPerOverOf(cfg);
  // Consecutive-over and lineup membership are both already ruled out above,
  // so the engine filter rejecting this name can only mean the quota.
  return eligibleBowlers([people.bowler], fine, cfg.maxOversPerBowler, bpo).length > 0 ? null : "quota";
}

function basePayload(state: CricketStateShape, cfg: CricketCfgShape, overrides: Readonly<Record<string, string>>): Record<string, unknown> {
  // R2b-next: `scoringInnings`, not `currentInnings` — closed + another due
  // reads as `null` here, so `legalBalls` falls to 0 and over/ballInOver
  // below come out 0/1, the engine's own first-delivery numbering
  // (`applyDelivery`'s `expectedOver`/`expectedBall` off `legalBalls: 0`),
  // instead of the closed innings' own final over count.
  const innings = scoringInnings(state, cfg);
  const bpo = ballsPerOverOf(cfg);
  const legalBalls = innings?.legalBalls ?? 0;
  const people = resolvePeople(state, overrides, cfg);
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

/** The two fields `freeHitPending` (below) needs off one ball's own payload
 *  — `over`/`ballInOver` for the innings-boundary check, `extraKind` for the
 *  arm/consume/carry transition. `null` for anything not ball-shaped enough
 *  to answer either question (a non-ball event, or a malformed payload
 *  missing the numeric fields) — silently skipped by the caller, same
 *  defensive-payload posture `overDots`/`ballOutcomeSymbol` already take. */
function freeHitBallOf(
  event: { type: string; payload: unknown },
): { over: number; ballInOver: number; extraKind?: string } | null {
  if (!BALL_EVENT_TYPES.has(event.type)) return null;
  const payload = event.payload as Record<string, unknown> | null | undefined;
  const over = payload?.over;
  const ballInOver = payload?.ballInOver;
  if (typeof over !== "number" || typeof ballInOver !== "number") return null;
  const runs = payload?.runs as { extras?: { kind?: string } } | undefined;
  return { over, ballInOver, extraKind: runs?.extras?.kind };
}

/**
 * R2b (owner ruling, live-tile audit — freeHit chip removal): the ONE
 * derivation shared by the read-only indicator (`buildScorebug`, below) and
 * the activity log's own label (`cricketBallDetail`, below) — they answer
 * the same question, "is/was a free hit pending", and must not risk drifting
 * apart into two implementations (the recurring defect class in this repo).
 * Given the whole ball history of ONE innings (or enough of it — see the
 * innings-boundary note below), oldest first, folds FORWARD through it and
 * returns whether a free hit is pending immediately AFTER the last event
 * given. Mirrors the engine's own transition rule verbatim
 * (`finishDelivery`, cricket.ts ~line 1363): a white-ball no-ball ARMS it; a
 * LEGAL delivery (not wide, not no-ball) CONSUMES it; anything else (a wide,
 * or a non-white-ball no-ball) carries the existing state forward unchanged.
 *
 * THE CORRECTNESS TRAP this exists to avoid: "was the previous row a
 * no-ball?" gets `no-ball -> wide -> legal` silently wrong (the legal ball
 * IS still a free hit — a wide never consumes it) and misses that
 * consecutive no-balls each re-arm it. Folding forward over the WHOLE
 * sequence gets both right by construction, not by a special case: calling
 * this with everything up to (not including) some ball answers "was THAT
 * ball itself a free hit"; calling it with everything recorded so far
 * answers "is a free hit pending right now" — the SAME function, just a
 * different slice, which is what keeps the indicator and the activity label
 * from ever answering this two different ways.
 *
 * INNINGS-BOUNDARY RESET: a fresh `FineInnings` always starts
 * `freeHitPending: false` (cricket.ts:650, `createInnings`) — a pending flag
 * dangling at one innings' close must never leak into the next. There is no
 * reliable explicit boundary EVENT to key off (an innings can auto-close,
 * e.g. all out/overs complete, with no dedicated event landing in the
 * ledger at all), so this detects the boundary the same way `overDots`
 * already implicitly tolerates one: within one innings, each ball's own
 * `(over, ballInOver)` is monotonically non-decreasing (an illegal ball
 * holds it steady, a legal one advances it) — a ball whose pair is LOWER
 * than the one immediately before it can only mean a fresh innings (or
 * super over) just started, so the fold resets to `false` right there,
 * before applying that ball's own transition on top.
 *
 * Ignores non-ball event types entirely (`freeHitBallOf` above), same
 * convention as `prev`/`history` on `SkinDefV3.activityDetail` (types.ts):
 * no sport vocabulary to filter with belongs at the boundary, only inside
 * this file.
 */
export function freeHitPending(
  events: readonly { type: string; payload: unknown }[],
  whiteBall: boolean,
): boolean {
  let pending = false;
  let prevKey: { over: number; ballInOver: number } | null = null;
  for (const event of events) {
    const ball = freeHitBallOf(event);
    if (ball === null) continue;
    if (prevKey !== null && (ball.over < prevKey.over || (ball.over === prevKey.over && ball.ballInOver < prevKey.ballInOver))) {
      pending = false; // (over, ballInOver) regressed — a new innings/super over started here
    }
    const legal = ball.extraKind !== "wide" && ball.extraKind !== "noball";
    pending = ball.extraKind === "noball" && whiteBall ? true : legal ? false : pending;
    prevKey = { over: ball.over, ballInOver: ball.ballInOver };
  }
  return pending;
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
 *
 * R2b-cricket-over review fix (item 1): takes a single `ActivityDetailContext`
 * object (../types.ts) — wired by DIRECT REFERENCE as `SkinDefV3.
 * activityDetail: cricketBallDetail` (below, no wrapper), so this
 * function's signature must match that contract exactly.
 *
 * `ctx.history` (R2b, owner ruling — freeHit chip removal): the data
 * already exists on every `cricket.ball`/`cricket.superover.ball` payload
 * (`bowler`, a person id) — the bowler-changed note is a RENDERING change,
 * not a new event. This function derives the single "previous ball" fact
 * as `history`'s own LAST element (item 2 — review proved that is always
 * exactly what the removed, separately-passed `prev` parameter carried;
 * see `ActivityDetailContext`'s own doc, types.ts). When that derived
 * event is a real ball AND its own `bowler` genuinely differs from THIS
 * ball's `bowler`, the base detail above gets a bowler-changed note
 * APPENDED (never replaces it — a wicket off the first ball of a new spell
 * must still read as a wicket) via `bowlerChanged`/the
 * `pad.cricket.ribbon.ball.bowlerChanged` key. `bowlerChanged` below
 * rejects a structural row (e.g. `core.start`) via this file's own
 * `BALL_EVENT_TYPES`.
 *
 * `ctx.history` is ALSO used, separately, for the free-hit note (R2b, owner
 * ruling): when BOTH `history` and `cfg` are given, this ALSO appends a
 * free-hit note — via the SAME `freeHitPending` fold (above) the read-only
 * scorebug indicator uses, so the two can never disagree — wrapping
 * whatever detail already exists (composes with the bowler-changed note
 * above it, never replaces either). `history` must be every
 * strictly-older, non-voided ball in the SAME innings, oldest first
 * (`ActivityDetailContext`'s own doc, types.ts); `cfg` is `PadHostView.cfg`
 * verbatim, re-derived here via `asCfg` like every other builder in this
 * file. Either missing means "cannot determine" — no note, never a guess
 * (`freeHitPending` is simply not called at all in that case).
 *
 * NAMED as of R2b follow-up (owner ruling, live-tile audit wave — "name the
 * bowler, not just 'New bowler'"): `ctx.personNames` resolves `bowler` (a
 * raw id) to a display name — same shape as `history`/`cfg` (an optional,
 * additive, closure-captured data bag `pad-host.tsx` forwards verbatim from
 * `PadHostView.personNames`). Falls back to `t("eventCopy.unknownPerson")`
 * on a missing/unresolved id — the SAME fallback `bowlerBlockMessage` (this
 * file, below) already uses for this exact bowler-naming problem
 * elsewhere — and NEVER the raw id: an unresolved id in the activity log is
 * worse than the name-free note it replaces, so this function does not
 * fall back to the id the way `ActivityPanel`'s own `nameOf`
 * (`personNames[id] ?? id`) safely can (that fallback never reaches
 * composed prose; this one would).
 */
export function cricketBallDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, history, cfg, personNames } = ctx;
  if (!BALL_EVENT_TYPES.has(eventType)) return undefined;
  const p = payload as {
    wicket?: { kind?: string };
    runs?: { bat?: number; extras?: { kind?: string; runs?: number } };
    bowler?: unknown;
  };
  let detail = baseBallDetail(t, p);
  // Item 2: the single "previous ball" fact is `history`'s own last
  // element — the nearest OLDER, non-voided event (`history` is
  // oldest-first) — rather than a separately-passed `prev` argument.
  const prev = history && history.length > 0 ? history[history.length - 1] : undefined;
  if (bowlerChanged(p.bowler, prev)) {
    // `bowlerChanged` above already proved `p.bowler` is a non-empty
    // string (its own doc) — re-narrowed here rather than cast, so this
    // stays a genuine type guard, not an `as`.
    const bowlerId = typeof p.bowler === "string" ? p.bowler : "";
    const name = personNames?.[bowlerId] ?? t("eventCopy.unknownPerson");
    detail = t("pad.cricket.ribbon.ball.bowlerChanged", { detail, name });
  }
  if (history !== undefined && cfg !== undefined) {
    const whiteBall = asCfg(cfg).ballsPerInnings !== null;
    if (freeHitPending(history, whiteBall)) detail = t("pad.cricket.ribbon.ball.freeHit", { detail });
  }
  return detail;
}

/** The outcome-only detail — wicket, then extras-by-kind, then plain runs
 *  (same decision order as `ballOutcomeSymbol`). Factored out of
 *  `cricketBallDetail` so the bowler-changed note (above) can wrap the
 *  result without duplicating this chain. */
function baseBallDetail(
  t: TFn,
  p: { wicket?: { kind?: string }; runs?: { bat?: number; extras?: { kind?: string; runs?: number } } },
): string {
  if (p.wicket?.kind) return t(requiredVocabKey("kind", p.wicket.kind));
  const extraKind = p.runs?.extras?.kind;
  if (extraKind) return t(requiredVocabKey("kind", extraKind));
  const bat = p.runs?.bat ?? 0;
  if (bat === 0) return t("pad.cricket.ribbon.ball.dot");
  if (bat === 1) return t("pad.cricket.ribbon.ball.run");
  return t("pad.cricket.ribbon.ball.runs", { runs: bat });
}

/**
 * True when `prev` is a real ball — `BALL_EVENT_TYPES`, never a
 * structural row (`core.start`, `cricket.innings.summary`) or a
 * `core.void` marker sitting between two real balls; `activity.tsx`'s own
 * `priorActivityEvents` does not filter by type, so this file must —
 * whose `bowler` genuinely differs from THIS ball's own `bowler`. Both
 * compared as raw ids (`CricketBall.bowler`, packages/engine), never
 * resolved to a name first, so two different people who happen to share a
 * display name can never misread as "unchanged" and vice versa. An empty
 * id on either side (the bowling order not populated yet) never counts as
 * a change — that would misfire on the very first ball a bowler is ever
 * recorded for.
 *
 * Takes `prev` as a plain, already-derived value rather than `history`
 * itself (R2b-cricket-over review fix, item 2) — `cricketBallDetail`
 * above derives it as `history`'s own last element before calling this,
 * so this function's own shape stays a trivial, self-contained "compare
 * two ball payloads" check.
 */
function bowlerChanged(bowler: unknown, prev?: { type: string; payload: Record<string, unknown> }): boolean {
  if (!prev || !BALL_EVENT_TYPES.has(prev.type)) return false;
  const prevBowler = (prev.payload as { bowler?: unknown }).bowler;
  return (
    typeof bowler === "string" && bowler !== "" &&
    typeof prevBowler === "string" && prevBowler !== "" &&
    bowler !== prevBowler
  );
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
  // R3.5 — a super over has its OWN target, and the main innings' is stale
  // the moment the match goes to one. Engine rule (applySuperOverBall,
  // cricket.ts:1572-1573): the SECOND innings of each pair chases the first
  // + 1; the first chases nothing (nobody bats twice in the same pair), and
  // neither does a pair still open (nothing to chase until the first
  // innings of the pair has actually closed).
  const so = state.superOver?.innings;
  if (state.phase === "super_over" && so !== undefined) {
    if (so.length === 0 || so.length % 2 === 1) return null;
    const first = so[so.length - 2] as CricketInningsShape;
    return typeof first.runs === "number" ? { value: first.runs + 1, isDls: false } : null;
  }
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
  const people = resolvePeople(state, view.contextOverrides, cfg);

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

  // R2b (owner ruling, live-tile audit — freeHit chip removal): the
  // READ-ONLY replacement for the old dock chip — the scorer no longer
  // declares what the fold already knows. Appended LAST (after target, same
  // "never reindex the pinned strip[0..3] items" convention the target
  // block above already established) — `freeHitPending` is the SAME fold
  // `cricketBallDetail`'s own activity-log note uses (that function's own
  // doc has the full correctness-trap/innings-boundary reasoning), called
  // here with EVERYTHING recorded so far, which answers "is a free hit
  // pending right now". Gated on live/super-over phase (matching
  // `buildContext`'s own gate) so a stray pending flag can never survive
  // into a finished match's display. `id: "freeHit"` is the stable,
  // i18n-independent Playwright hook (`StripItem.id`, types.ts).
  if (
    (state.phase === "live" || state.phase === "super_over") &&
    freeHitPending(view.events, cfg.ballsPerInnings !== null)
  ) {
    strip.push({ id: "freeHit", value: t("scorepad.skin.cricket.header.freeHit"), accent: true });
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

/**
 * R2b (owner sign-off finding, single-line label fix): the over-summary
 * tile's over number now rides INSIDE its `label` sentence ("End of over
 * 2"), via `TileSpec.labelText` — a chassis-rendered, pre-localised raw
 * string (types.ts), never re-resolved through `t()`. Building that one
 * string needs a REAL `t`, unlike every other tile here (a bare i18n KEY,
 * resolved later by the chassis's own `t(tile.label)` call, tile-grid.tsx)
 * — so `t` is threaded in here, DEFAULTED rather than required like
 * `buildScorebug`/`buildDock` below take it: the reachability sweep
 * (`__tests__/cricket-dispatch-totality.test.ts`) and most of this file's
 * own unit tests call `buildTiles(view)` with no second argument at all,
 * and none of them inspect label TEXT (only tile ids/kinds/phases/
 * actions) — a default no-op translator (echoes the bare key, ignoring
 * vars) keeps every one of those call sites compiling and passing
 * unchanged. Production always supplies the real one (`cricketSkinV3`'s
 * own `tiles: (view) => buildTiles(view, t)` below) — relying on this
 * default there would silently ship the raw i18n KEY as the tile's
 * visible label.
 */
export function buildTiles(view: PadHostView, t: TFn = (key) => key): TileSpec[] {
  const cfg = asCfg(view.cfg);
  const state = asState(view.state);
  const bpo = ballsPerOverOf(cfg);
  const base = basePayload(state, cfg, view.contextOverrides);
  const type = ballEventType(state);
  const twoInnings = cfg.inningsPerSide === 2;
  const innings = currentInnings(state);
  // R2b-next: fidelity/next-over-number are computed off `scoringInnings`,
  // not the raw (possibly closed) `innings` above — see that function's own
  // doc for why `null` is exactly right for "closed, another due" too.
  const scoring = scoringInnings(state, cfg);
  const fidelity = inningsFidelity(scoring);
  // R2b (owner ruling, bowler-eligibility block, 2026-08-17): the SAME
  // resolvePeople() call every other builder in this file uses (G5's own
  // "one default computed in one place" reasoning) — so a tile that goes
  // disabled here is blocking exactly the payload `basePayload` above just
  // built, never a second, possibly-disagreeing computation.
  const people = resolvePeople(state, view.contextOverrides, cfg);
  const bowlerBlocked = bowlerBlockReason(state, people, cfg) !== null;
  // R2b (owner ruling, live-tile audit defect 2, `_INDEX.md`, HIGH):
  // `currentInnings()` falls back to the JUST-CLOSED innings once none is
  // open — load-bearing for READ paths (`buildScorebug` above must still
  // show the closed innings' final score) — but every delivery-capable tile
  // used to stay tappable against it, and every tap 422d with "over/
  // ballInOver do not match the ledger", a message that names ball
  // sequencing, not the real cause (closure). `closedTile` reuses the EXACT
  // bowler-block mechanism (`TileSpec.disabled` + a message on
  // `ContextSlot`, `buildContext` below) rather than inventing a second one —
  // same posture `ballTile` already takes for bowler-ineligibility, just
  // gated on a different, independent condition (never OR'd into
  // `bowlerBlocked` itself: `buildContext` below needs to tell the two
  // causes apart to avoid showing a stale, possibly-misleading
  // bowler-eligibility message once the real cause is closure).
  const inningsClosed = innings?.closed === true;
  const closedTile = (spec: TileSpec): TileSpec => (inningsClosed ? { ...spec, disabled: true } : spec);
  // R2b-next (owner-confirmed live blocker, 2026-08-17): the gate above
  // originally applied REGARDLESS of whether another innings was still due
  // — the state this fix now targets. `dueBattingSide` (above) narrows it:
  // `blockedByClosure` is true only for the GENUINELY terminal case (closed,
  // nothing further due), and is what the ball-emitting tiles and the
  // over-summary tile gate on below instead of the unnarrowed
  // `inningsClosed` — both are able to CREATE the next innings on tap (the
  // engine's own two implicit-open paths, `createInnings` from either
  // `cricket.ball` or `cricket.innings.summary`, cricket.ts:2935-2944/
  // :1401-1413 — no dedicated "start innings" event exists or should be
  // invented, per this fix's own brief). `review`/`inningsClose`/`declare`
  // stay on the unnarrowed `closedTile`/`inningsClosed` below, unchanged —
  // none of them make sense against an innings that has not been created
  // yet (nothing is open to review, close, or declare on).
  const dueSide = dueBattingSide(state, cfg);
  const blockedByClosure = inningsClosed && dueSide === null;
  const dueAwareTile = (spec: TileSpec): TileSpec => (blockedByClosure ? { ...spec, disabled: true } : spec);

  const tiles: TileSpec[] = [
    { id: "toss", label: "pad.cricket.action.toss", kind: "primary", phases: ["pre"], action: { sheet: "toss" } },
  ];

  // R2b (Q1 owner ruling, `_INDEX.md`): ball-derived tiles only when this
  // innings can legally take a `cricket.ball` at all — never once it is
  // coarse, where the fold refuses one outright (cricket.ts:1128-1131/
  // :2936-2938). Every visible tap stays legal at the moment it is visible.
  if (fidelity !== "coarse") {
    // R2b (bowler-eligibility block): every tile pushed inside this branch
    // emits `cricket.ball`/`cricket.superover.ball` — exactly the set
    // Ruling 1 names ("runs, extras, wicket — everything that emits a
    // cricket.ball") — so `ballTile` below is the ONLY place `disabled`
    // gets set in this function; non-ball tiles (review/retire/
    // inningsClose/declare/overSummary/more, pushed further down, outside
    // this branch) are untouched.
    const ballTile = (spec: TileSpec): TileSpec => (bowlerBlocked || blockedByClosure ? { ...spec, disabled: true } : spec);

    for (const r of RUN_VALUES) {
      tiles.push(ballTile({
        id: `run${r}`,
        label: `pad.cricket.tile.runs.${r}`,
        kind: PRIMARY_RUNS.has(r) ? "primary" : "standard",
        phases: ["live"],
        action: { event: { type, payload: runPayload(base, r) } },
      }));
    }

    tiles.push(ballTile({
      id: "wide",
      label: requiredVocabKey("kind", "wide"),
      kind: "standard",
      phases: ["live"],
      action: { event: { type, payload: extraPayload(base, "wide") } },
    }));

    tiles.push(ballTile({
      id: "wicket",
      label: "pad.cricket.action.wicket",
      kind: "destructive",
      span: 4,
      phases: ["live"],
      action: { sheet: "wicket" },
    }));

    for (const kind of MINOR_EXTRA_KINDS) {
      // R2b task 4 (`_INDEX.md`, owner ruling): penalty runs default to 5
      // (Law 41), not the ordinary single every OTHER minor extra opens
      // with — a real, deliberate exception, not an oversight. The other
      // three kinds (noball/bye/legbye) keep `extraPayload`'s own default.
      const runs = kind === "penalty" ? 5 : undefined;
      tiles.push(ballTile({
        id: `extra-${kind}`,
        label: requiredVocabKey("kind", kind),
        kind: "minor",
        phases: ["live"],
        action: { event: { type, payload: extraPayload(base, kind, runs) } },
      }));
    }
  }

  tiles.push(closedTile({ id: "review", label: "pad.cricket.action.review", kind: "standard", phases: ["live"], action: { sheet: "review" } }));
  // R2c / C2 (owner-approved amendment to R2b's defect-4 ruling, 2026-08-18):
  // Retire is a tile again, but a `{sheet}` one rather than the `{swap:true}`
  // tile R2b removed. Both faults that justified the removal are gone — the
  // sheet carries the real reason enum and narrows to the crease — and the
  // duplicate-entry-point problem solves itself: a `{swap:true}` action
  // contributed NOTHING to `dedicatedEventTypes` (pad-host.tsx), which is
  // exactly why the generic More-sheet `cricket.retire` stayed reachable
  // alongside it, whereas a sheet's own `event` IS counted, so declaring
  // `retireSheet` removes the generic entry with no extra wiring.
  tiles.push(closedTile({ id: "retire", label: "pad.cricket.action.retire", kind: "standard", phases: ["live"], action: { sheet: "retire" } }));
  tiles.push(closedTile({
    id: "inningsClose",
    label: "pad.cricket.action.inningsClose",
    kind: "standard",
    phases: ["live"],
    action: { sheet: "inningsClose" },
  }));

  if (twoInnings) {
    tiles.push(closedTile({
      id: "declare",
      label: "pad.cricket.action.declare",
      kind: "standard",
      phases: ["live"],
      action: { event: { type: "cricket.innings.declare", payload: {} } },
    }));
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
    const overLabel = "pad.cricket.action.endOfOver";
    tiles.push(dueAwareTile({
      id: "overSummary",
      label: overLabel,
      // R2b follow-up (owner sign-off, single-line label fix): the over
      // number now rides INSIDE the label sentence itself ("End of over
      // 2") via TileSpec.labelText (types.ts), rendered verbatim by
      // tile-grid.tsx, never re-resolved through t() — NOT a separate
      // sublabelText line any more (this tile was that field's original
      // motivating case; see types.ts's own follow-up note on
      // sublabelText, right below its doc). `label` above still carries
      // the real dictionary key ("End of over {over}", en/ui.json) as the
      // fallback/canonical value tile-grid.tsx resolves for any tile that
      // doesn't set labelText. R2b-next: `scoring`, not `innings` — reads
      // over 1 for a closed-with-another-due innings, not a number derived
      // from the closed innings' own final legalBalls.
      labelText: t(overLabel, { over: nextOverNumber(scoring, bpo) }),
      kind: "primary",
      span: 2,
      phases: ["live"],
      action: { sheet: "overSummary" },
    }));
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
// dock() — needs `t` for DockSpec.title (this file's header).
//
// R2b (owner ruling, live-tile audit, 2026-08-17): this dock USED TO offer a
// `freeHit` chip unconditionally on every ball — "shot type" (design doc
// §3's cricket row) has no home in `CricketBall`'s `z.strictObject` schema,
// so `freeHit` (the one genuinely optional `CricketBall` field) was what it
// always offered instead. That chip is GONE. It was never gated on whether a
// free hit was actually pending (by dock-render time the optimistic fold has
// already advanced past the just-tapped ball, so `view.state`'s own
// `freeHitPending` already reflects AFTER this ball, not before it — there
// was no cheap way to gate it correctly from here), so tapping it on an
// ordinary ball surfaced as a bare rejected-submission error (the fold's own
// `"freeHit flagged but no free hit is pending"` check) — the owner hit this
// live. `payload.freeHit` was also never load-bearing: the server derives
// `freeHitPending` purely from the preceding no-ball
// (`finishDelivery`/`freeHitPending`, cricket.ts), and the free-hit
// dismissal restriction reads `fine.freeHitPending`, never the payload flag
// — so the flag was validated but never consumed; its only possible effect
// was an error. Replaced by a READ-ONLY indicator (`buildScorebug`, above)
// and an activity-log note (`cricketBallDetail`, above) — the scorer no
// longer declares what the fold already knows, and the client never sends
// `freeHit: true` at all any more.
//
// `buildDock` itself stays non-null for every ball event type even once
// `chips` ends up empty (a plain run/wide/penalty tap, now that freeHit is
// gone) — `e2e/scorepad-v3-cricket.spec.ts`'s undo tests tap a PLAIN run and
// assert `[data-role="v3-dock"]` becomes visible, using dock PRESENCE as a
// generic "this tap is still in the hold window" proxy, unrelated to free
// hit specifically; returning `null` there would silently break that
// already-passing coverage. The dock still shows its title, dismiss
// control, and countdown with no chips in that case.
//
// R2b task 4 (`_INDEX.md`, owner ruling): `heldPayload`, the optional 3rd
// argument (the widened chassis contract, `SkinDefV3.dock`, ../types.ts),
// is what lets THIS dock tell a no-ball apart from a plain single — both
// dispatch the identical `cricket.ball` event TYPE, so `eventType` alone
// can never answer "which tile was actually tapped". A no-ball's dock
// offers bat-run chips (+1/+2/+3/+4/+6 — a no-ball is batted normally, so
// this is legal; a WIDE is deliberately excluded even though it is also an
// extra, because the engine refuses any bat run off one, cricket.ts:1229 —
// "bat runs are impossible off a wide"). A bye/leg-bye's dock offers
// extra-run chips (2/3/4) that raise the EXTRA's own `runs`, never `bat`.
// Every other case — a plain run tap, a wide, a penalty, or the pre-existing
// 2-arg call with no payload at all — now offers no chips at all.
// ---------------------------------------------------------------------------

const BAT_RUN_VALUES = [1, 2, 3, 4, 6] as const;
const EXTRA_RUN_VALUES = [2, 3, 4] as const;

/** A no-ball's dock chip that sets `runs.bat` to `n`, preserving the
 *  no-ball's own `runs.extras` verbatim (never dropped, never re-kinded) —
 *  and, for `n` in {4, 6}, also stamps `boundary`, mirroring `runPayload`'s
 *  own convention for the plain run4/run6 tiles exactly: the same two
 *  literal values, the same "boundary present only for 4 or 6" shape. */
function batRunChip(n: (typeof BAT_RUN_VALUES)[number]): DockChip {
  const boundary = n === 4 ? 4 : n === 6 ? 6 : undefined;
  return {
    id: `batRun${n}`,
    label: `pad.cricket.dock.batRun${n}`,
    mutate: (payload) => {
      const extras = (payload.runs as { extras?: unknown } | undefined)?.extras;
      return {
        ...payload,
        runs: { bat: n, ...(extras !== undefined ? { extras } : {}) },
        ...(boundary !== undefined ? { boundary } : {}),
      };
    },
  };
}

/** A bye/leg-bye's dock chip that raises the EXTRA's own `runs` to `n`.
 *  `bat` is read from (never assumed on top of) the current payload — it is
 *  always 0 for a real bye/leg-bye, but a chip should never silently touch
 *  a field it was not asked to change — and `extras.kind` is preserved
 *  verbatim so a leg-bye can never mutate into a bye or vice versa. */
function extraRunChip(n: (typeof EXTRA_RUN_VALUES)[number]): DockChip {
  return {
    id: `extraRun${n}`,
    label: `pad.cricket.dock.extraRun${n}`,
    mutate: (payload) => {
      const runs = payload.runs as { bat?: number; extras?: { kind?: string } } | undefined;
      return { ...payload, runs: { bat: runs?.bat ?? 0, extras: { kind: runs?.extras?.kind, runs: n } } };
    },
  };
}

export function buildDock(eventType: string, t: TFn, heldPayload?: Record<string, unknown>): DockSpec | null {
  if (!BALL_EVENT_TYPES.has(eventType)) return null;
  const chips: DockChip[] = [];
  const extraKind = (heldPayload?.runs as { extras?: { kind?: string } } | undefined)?.extras?.kind;
  if (extraKind === "noball") {
    for (const n of BAT_RUN_VALUES) chips.push(batRunChip(n));
  } else if (extraKind === "bye" || extraKind === "legbye") {
    for (const n of EXTRA_RUN_VALUES) chips.push(extraRunChip(n));
  }
  return { title: t("pad.cricket.dock.title"), chips };
}

const BOWLER_BLOCK_MESSAGE_KEY: Record<Exclude<BowlerBlockReason, "noEligible">, MessageKey> = {
  prevOver: "pad.cricket.context.bowler.blocked.prevOver",
  notInLineup: "pad.cricket.context.bowler.blocked.notInLineup",
  quota: "pad.cricket.context.bowler.blocked.quota",
};

/**
 * R2b (owner ruling, bowler-eligibility block, 2026-08-17): turns a
 * `bowlerBlockReason` into the pre-localised prose `ContextSlot.message`
 * carries (`buildContext`, below) — naming the bowler via `personNames`,
 * NEVER a raw personId (the same posture `use-pad-pipeline.ts`'s own doc
 * states for why the engine's OWN rejection text must never reach the
 * scorer: English-only, no server-side i18n, and built around a raw id,
 * not a display name). Falls back to `eventCopy.unknownPerson` on a
 * missing name — the SAME fallback `chipLabel` (context-strip.tsx) already
 * uses for the very chip this message sits beside, so the two can never
 * name the bowler two different ways.
 *
 * `"noEligible"` names nobody — there is no single bowler at fault — and
 * gets its own dedicated key with no `name` var at all, rather than a
 * name-shaped hole in the per-reason map above.
 *
 * The `"quota"` branch reads `cfg.maxOversPerBowler` directly rather than
 * threading the number through `BowlerBlockReason` itself: by the time
 * `bowlerBlockReason` has returned `"quota"`, that field is guaranteed
 * defined (its own doc — `eligibleBowlers` can only reject a
 * lineup-resident, non-consecutive name via its quota branch, which is
 * unreachable when `maxOversPerBowler === undefined`) — the `throw` below
 * is `requiredVocabKey`'s own "never a silently-wrong fallback" posture
 * (this file, above), not a reachable runtime path through either of this
 * function's two real callers.
 */
function bowlerBlockMessage(
  t: TFn,
  reason: BowlerBlockReason,
  bowlerId: string,
  personNames: Readonly<Record<string, string>>,
  cfg: CricketCfgShape,
): string {
  if (reason === "noEligible") return t("pad.cricket.context.bowler.blocked.noEligible");
  const name = personNames[bowlerId] ?? t("eventCopy.unknownPerson");
  if (reason === "quota") {
    const quota = cfg.maxOversPerBowler;
    if (quota === undefined) {
      throw new Error("cricket skin: quota block reason with no cfg.maxOversPerBowler");
    }
    return t(BOWLER_BLOCK_MESSAGE_KEY.quota, { name, quota });
  }
  return t(BOWLER_BLOCK_MESSAGE_KEY[reason], { name });
}

/**
 * R2c / C1 — the bowler picker's per-candidate blocks: every name in the
 * fielding side that cannot legally open the next over, each mapped to the
 * reason, ready for `ContextSlot.blocked` (types.ts).
 *
 * The candidate list itself is the fielding side (`ContextSlot.candidates`,
 * set alongside this in `buildContext`) — SCOPE, which removes. This is
 * ELIGIBILITY, which does not: an ineligible bowler stays visible with the
 * reason beside their name, per R2b's binding "visible, blocked, and
 * REASONED — not removed" ruling. Removing them would leave a scorer hunting
 * for a bowler who is simply gone.
 *
 * Wording comes from `bowlerBlockMessage` above — the SAME function, and
 * therefore the same four `blocked.*` keys in all four locales, that already
 * words the slot-level message. The picker and the message can never phrase
 * one fact two ways, and R2c owes no new dictionary entries for it.
 *
 * `notInLineup` is structurally unreachable here (every id comes FROM
 * `bowlingOrder`), and `noEligible` is a SLOT-level statement rather than a
 * per-candidate one — when nobody qualifies, every candidate carries its own
 * individual reason instead, which is strictly more informative.
 *
 * Returns `{}` mid-over: the fold has locked that bowler in regardless of
 * eligibility, and the slot is read-only, so there is no picker to narrow —
 * the same short-circuit `resolvePeople` and `bowlerBlockReason` already take.
 */
/**
 * The same three grounds as `bowlerBlockMessage`, worded WITHOUT the person's
 * name — for the picker, where the reason renders directly beside the name it
 * would otherwise repeat.
 *
 * Found by looking at the sign-off capture, not by a test: every test asserted
 * the string matched, and it did. The rendered chip read "G R2c BowlerA … G
 * R2c BowlerA bowled the last over and cannot bowl this one too", which is
 * both silly and, at 320px on a touch surface, expensive in the one dimension
 * there is least of.
 *
 * The name-bearing wording is still correct where it is used — the SLOT
 * message stands alone and must name who is at fault — so this is a second
 * variant rather than a replacement, and the two cannot drift apart on the
 * FACT they state because both are driven by the same `BowlerBlockReason`.
 */
function bowlerBlockShortMessage(
  t: TFn,
  // Narrower than `BowlerBlockReason` on purpose. Only these two are
  // reachable per candidate: every id comes FROM `bowlingOrder`, so
  // "notInLineup" cannot arise, and "noEligible" is a statement about the
  // WHOLE list rather than about one name. Typing the two real cases is
  // honest and leaves no unreachable branch to rot (tsc caught the dead one).
  reason: "prevOver" | "quota",
  cfg: CricketCfgShape,
): string {
  if (reason === "prevOver") return t("pad.cricket.context.bowler.blocked.prevOver.short");
  const quota = cfg.maxOversPerBowler;
  if (quota === undefined) {
    throw new Error("cricket skin: quota block reason with no cfg.maxOversPerBowler");
  }
  return t("pad.cricket.context.bowler.blocked.quota.short", { quota });
}

export function bowlerBlocked(
  t: TFn,
  state: CricketStateShape,
  people: ResolvedPeople,
  cfg: CricketCfgShape,
): Blocked {
  const innings = scoringInnings(state, cfg);
  const fine = innings?.fine ?? null;
  if ((fine?.currentBowler ?? null) !== null) return {};
  const bowlingOrder = state.orders?.[people.bowlingSide] ?? [];
  const eligible = new Set(
    eligibleBowlers(bowlingOrder, fine, cfg.maxOversPerBowler, ballsPerOverOf(cfg)),
  );
  const out: Record<string, string> = {};
  for (const id of bowlingOrder) {
    if (eligible.has(id)) continue;
    const reason = id === (fine?.prevOverBowler ?? null) ? ("prevOver" as const) : ("quota" as const);
    out[id] = bowlerBlockShortMessage(t, reason, cfg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// context() — §2.4, closes D-14. Fold-and-override-authoritative (same
// `resolvePeople(state, view.contextOverrides, cfg)` the tiles/sheets use, so
// the strip and the next tap NEVER disagree). No `contextSelect`: cricket has no
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

export function buildContext(view: PadHostView, t: TFn = (key) => key): ContextStripSpec | null {
  const state = asState(view.state);
  if (state.phase !== "live" && state.phase !== "super_over") return null;
  const cfg = asCfg(view.cfg);
  const innings = currentInnings(state);
  if (innings === null) return null;
  // R2b-next (owner-confirmed live blocker, 2026-08-17): closed, with
  // another innings due, is treated identically to "no innings open yet"
  // (the check right above) — there is genuinely no fold-backed state to
  // show or edit for an innings that has not been created (same reasoning
  // `scoringInnings`'s own doc gives). This is not new UI to design: it is
  // the SAME strip-less window innings ONE's own first ball already scores
  // through today. `basePayload`/`resolvePeople` (below, and in buildTiles)
  // still compute correct silent defaults for that first tap, exactly as
  // they already do before innings one's own first ball.
  if (dueBattingSide(state, cfg) !== null) return null;
  const people = resolvePeople(state, view.contextOverrides, cfg);
  const bowlerReadOnly = bowlerIsReadOnly(innings);
  // R2b (owner ruling, live-tile audit defect 2, `_INDEX.md`): closure is the
  // ROOT cause once it applies — a bowler-eligibility read off the CLOSED
  // innings' own stale `fine` would be a second, possibly-misleading message
  // stacked on (or shown INSTEAD of) the real one, so the eligibility check
  // is skipped entirely rather than computed and overridden. Mirrors
  // `buildTiles`'s own `inningsClosed`/`closedTile` — see that function's
  // header for the full defect/investigation writeup (not duplicated here).
  const inningsClosed = innings.closed === true;
  const closedMessage = inningsClosed ? t("pad.cricket.context.innings.closed") : undefined;
  // R2b (owner ruling, bowler-eligibility block, 2026-08-17): the SAME
  // decision `buildTiles` gates its own `disabled` tiles on — the strip and
  // the tap can never disagree about WHETHER the bowler is blocked, same
  // "one default computed in one place" reasoning G5 already established
  // for WHO the bowler is.
  const blockReason = inningsClosed ? null : bowlerBlockReason(state, people, cfg);
  return {
    slots: [
      {
        id: "striker",
        label: "pad.cricket.context.striker",
        personId: people.striker || undefined,
        pool: "onfield",
        required: true,
        readOnly: true, // blocker 2 — see this file's header above
        message: closedMessage, // defect 2 — see this file's header above
      },
      {
        id: "nonStriker",
        label: "pad.cricket.context.nonStriker",
        personId: people.nonStriker || undefined,
        pool: "onfield",
        required: true,
        readOnly: true, // blocker 2 — see this file's header above
        message: closedMessage, // defect 2 — see this file's header above
      },
      {
        // CANDIDATE-LIST GAP (checked as part of the R2b live bug fix,
        // 2026-08-17 — reported, not fixed here): when this slot is
        // editable (over boundary, not readOnly), tapping it opens a picker
        // whose candidates come from `pad-host.tsx`'s `combinedPool(squads)`
        // — resolved through `ContextSlot.pool` alone, via
        // `context-strip.tsx`'s `resolvePool`. `ContextSlot` (types.ts) has
        // no `candidates`/`side` field — only `SheetPersonStep` (the wicket
        // sheet's own `out`/`fielder` steps, G6 above) supports narrowing a
        // person picker's list; a context-strip slot cannot. Two consequences,
        // neither fixable from this file alone: (1) the picker offers BOTH
        // sides' on-field roster, not just the bowling side (`combinedPool`'s
        // own header already flags this as a "slightly wider-than-ideal"
        // pre-existing gap); (2) within the bowling side, it offers every
        // on-field player regardless of the SAME eligibility this fix just
        // taught the default to respect (consecutive-over/quota) — the chip
        // does not stop a scorer from tapping an ineligible name, the same
        // shape of defect this fix closes for the untouched default, just
        // reachable through the picker instead. Fixing this needs a
        // `candidates`-like field on `ContextSlot` (types.ts) plus a
        // `context-strip.tsx` change to honour it — both out of this file's
        // grant (types.ts is a concurrent task's file this wave; see this
        // task's own report). Flagged here rather than silently left
        // unmentioned, per the brief's own ask to report even a null result.
        //
        // R2b UPDATE (bowler-eligibility block, 2026-08-17): the picker
        // itself is STILL unfixed — it still offers an ineligible name —
        // but the CONSEQUENCE of tapping one is no longer a silent trip to
        // the server. `blockReason`/`message` below catch it here: the next
        // render shows this exact slot's `message` and every ball tile
        // goes `disabled` (`buildTiles`), so an ineligible pick now surfaces
        // immediately, in the pad, naming the reason — never a bare 422.
        id: "bowler",
        label: "pad.cricket.context.bowler",
        personId: people.bowler || undefined,
        pool: "onfield",
        required: true,
        // R2c / C1 — closes the CANDIDATE-LIST GAP recorded above. SCOPE:
        // the fielding side only, so the engine's "not in the fielding
        // lineup" refusal is now structurally unreachable from the picker
        // rather than merely caught after the fact. ELIGIBILITY: the
        // fielding side's own ineligible bowlers stay visible, each with
        // its reason (bowlerBlocked, above).
        candidates: state.orders?.[people.bowlingSide] ?? [],
        blocked: inningsClosed ? {} : bowlerBlocked(t, state, people, cfg),
        // defect 3 (readOnly) / defect 2 (closure) — see this file's header
        // above for both. Closure forces readOnly too: there is no "over
        // boundary" concept once the innings itself is over.
        readOnly: inningsClosed || bowlerReadOnly ? true : undefined,
        message: closedMessage ?? (blockReason ? bowlerBlockMessage(t, blockReason, people.bowler, view.personNames, cfg) : undefined),
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
  const cfg = asCfg(view.cfg);
  const people = resolvePeople(state, view.contextOverrides, cfg);
  const base = basePayload(state, cfg, view.contextOverrides);
  // G6: exactly the two batters who can be run out — never an empty-string
  // placeholder (resolvePeople's own "order not populated yet" fallback) —
  // so a not-yet-populated crease offers zero candidates rather than a
  // phantom "" entry `renderCandidateRow` would render as a blank button.
  const outCandidates = [people.striker, people.nonStriker].filter((id): id is string => id !== "");
  // R2b-over (review finding — same recurring defect class this whole branch
  // targets): the SAME `freeHitPending` fold buildScorebug's own indicator
  // and cricketBallDetail's own activity note already use (that function's
  // own header, above) — called here with the identical two arguments
  // buildScorebug uses, so this gate can never disagree with what the
  // scorer is already shown on the scorebug strip.
  const freeHit = freeHitPending(view.events, cfg.ballsPerInnings !== null);
  // FREE_HIT_WICKET_KINDS' own doc (above) has the engine restriction this
  // mirrors (cricket.ts:1275-1276). Filtering WICKET_KINDS (rather than
  // hardcoding the pair here too) means a future change to either closed
  // set only has one place to update.
  const kindOptions = (freeHit ? WICKET_KINDS.filter((k) => FREE_HIT_WICKET_KINDS.has(k)) : WICKET_KINDS).map((k) => ({
    id: k,
    label: requiredVocabKey("kind", k),
  }));

  const steps: GuidedSheetStep[] = [
    {
      id: "kind",
      kind: "choice",
      title: "pad.cricket.sheet.wicket.kind.title",
      options: kindOptions,
      // Owner ruling (this task's own brief): never leave a silently
      // shortened list unexplained — a scorer expecting "bowled" and not
      // finding it needs to know why. `SheetChoiceStep.hintKey`'s own doc
      // (types.ts) has the full reasoning for why this is a plain i18n key
      // rather than SheetNumberStep's pre-resolved convention. (Field
      // renamed from `hint` — R2b-cricket-over follow-up, hint-field
      // naming pass, 2026-08-17.)
      hintKey: freeHit ? "pad.cricket.sheet.wicket.kind.freeHitHint" : undefined,
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
/**
 * R2c / C2 — cricket's own Retire flow, replacing the generic More-sheet
 * `cricket.retire` form. AMENDS R2b's defect-4 ruling (owner-approved
 * 2026-08-18): that audit dropped the dedicated tile because it hardcoded
 * `reason: "other"` and scoped its picker to the whole batting side, and kept
 * the generic form because it at least had a real reason enum. Neither fault
 * survives here — the enum AND the crease — so the reason the tile was
 * dropped no longer applies.
 *
 * Still ONE entry point, with nothing extra to remove: `dedicatedEventTypes`
 * (pad-host.tsx) folds every sheet's own `event` into the dedicated set, so
 * declaring this sheet is itself what drops `cricket.retire` from the More
 * sheet. That is the same mechanism the old `{swap:true}` tile could NOT
 * trigger, which is precisely how the two divergent entry points arose.
 *
 * `incoming` is deliberately NOT asked. The engine's own payload marks it
 * optional and defaults it to the next batter in the order
 * (`CricketRetire`), which is the ordinary case, so asking would add a tap
 * to every retirement to restate what the fold already knows — the same
 * "never re-ask what the fold already knows" rule the chassis is built on,
 * and the same fewer-taps-on-the-common-case trade the R2b dock ruling made.
 * A sport that later needs an explicit incoming batter adds a third step.
 *
 * The crease is `fine.striker`/`fine.nonStriker` — verbatim what the engine
 * itself checks (`applyRetire`: `"… is not at the crease"`). Empty-string
 * placeholders are filtered for the same reason `wicketSheet`'s own
 * `outCandidates` filters them: `resolvePeople` yields `""` before the order
 * is populated, and `renderCandidateRow` would draw that as a blank button.
 */
function retireSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const people = resolvePeople(state, view.contextOverrides, cfg);
  const creaseCandidates = [people.striker, people.nonStriker].filter((id): id is string => id !== "");
  return {
    event: "cricket.retire",
    steps: [
      {
        id: "person",
        kind: "person",
        title: "pad.cricket.sheet.retire.person.title",
        pool: "onfield",
        side: people.battingSide,
        candidates: creaseCandidates,
      },
      {
        id: "reason",
        kind: "choice",
        title: "pad.cricket.sheet.retire.reason.title",
        options: [
          { id: "hurt", label: "pad.cricket.sheet.retire.reason.hurt" },
          { id: "out", label: "pad.cricket.sheet.retire.reason.out" },
          { id: "other", label: "pad.cricket.sheet.retire.reason.other" },
        ],
      },
    ],
    buildPayload: (answers) => ({ person: answers.person, reason: answers.reason }),
  };
}

/**
 * R2c / C3 — the `by` step refuses a side that has spent its player-review
 * allowance, instead of letting the scorer finish the sheet and meet a
 * generic 422 from `applyReview`.
 *
 * `t` is REQUIRED, never defaulted: R2b proved a defaulted translator is a
 * tsc-invisible silent-fallback trap (dropping the argument at the factory
 * type-checks, lints, and ships a raw i18n key to a scorer), and _INDEX.md
 * carries "R3-R7 skin authors: require `t`" as a standing instruction.
 *
 * WHY THIS IS NOT A STEP-ORDERING PROBLEM, since the brief said it was. Both
 * sides' quotas are readable from `view` here, at build time. The only fact
 * that arrives later is `kind` — and `kind` is step 1 while `by` is step 3,
 * so `blocked(answers)` already has it. A reorder would have been worse than
 * unnecessary: it would ask the side even for an UMPIRE review, which the
 * engine never caps at all.
 *
 * The quota arithmetic itself is the engine's `reviewsRemaining`, not a local
 * copy — that rule was already forked twice inside cricket.ts and a third
 * copy here is exactly the drift this wave exists to stop. Two subtleties it
 * owns so this file does not restate them: only an UNSUCCESSFUL player review
 * is spent (the counter is `lost`, never `taken`), and an absent allowance
 * means uncapped rather than zero.
 */
function reviewSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const squads = view.squads;
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const innings = scoringInnings(state, cfg);
  const sideOfEntrant: Record<string, "home" | "away"> = {
    [squads.home.entrantId]: "home",
    [squads.away.entrantId]: "away",
  };
  const blockedSides = (answers: Readonly<Record<string, string>>): Blocked => {
    // Umpire reviews are never capped (the engine gates the quota on
    // `kind === "player"`), so nothing is blocked until that is the answer.
    if (answers.kind !== "player") return {};
    if (innings === null || innings === undefined) return {};
    const out: Record<string, string> = {};
    for (const [entrantId, side] of Object.entries(sideOfEntrant)) {
      if (reviewsRemaining(innings, cfg.reviews?.perInnings, side) !== 0) continue;
      // Name-free: the option's own label already says which side this is,
      // so repeating it here just spends width. Same finding as
      // `bowlerBlockShortMessage` (above) — caught in the capture, not a test.
      out[entrantId] = t("pad.cricket.sheet.review.by.blocked.noneLeft.short");
    }
    return out;
  };
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
        blocked: blockedSides,
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
 * Q2 was REVERSED by the owner on 2026-08-17 (`_INDEX.md`, "R2b — Q2
 * REVERSED"): the three `SheetNumberStep`s below capture THIS OVER's
 * runs/wickets/balls, not the innings-so-far total, and `buildPayload`
 * appends them onto the fold's current totals before emitting — re-keying
 * the running total every over was the worse trade, and a scorer thinks in
 * per-over terms, not running totals.
 *
 * All three PREFILL to 0 (`balls` to `ballsPerOverOf(cfg)` — never a
 * hardcoded 6, `hundred` sets 5, cricket.ts:2811) with `min: 0`: this is an
 * increment form, the one documented exception to `SheetNumberStep`'s own
 * "the scorer edits the total up" doc (types.ts). `balls` alone also
 * carries `max: bpo`: a completed over is always exactly `bpo` LEGAL
 * deliveries — extras (wides/no-balls) are not legal deliveries, so they
 * can never push it past `bpo` — while below `bpo` stays legitimate, since
 * an innings can end mid-over (all out, target reached, time). No `max` on
 * `runs`/`wickets`: `allOut`/`ballsLimit` are strict, cfg/squad-derived
 * checks the ENGINE makes (`applySummary`, same file) and are not exported
 * for this pad to duplicate — same "the fold's own validation is still the
 * correctness backstop" posture the wicket sheet's `fielder` step already
 * takes (`wicketSheet`'s own doc, above).
 *
 * The engine's own "summary totals may not decrease" guard
 * (cricket.ts:1416-1426) stays structurally UNREACHABLE through this sheet,
 * now via a different mechanism than the original ruling: every answer is
 * floored at `min: 0` and `buildPayload` only ever ADDS it onto the fold's
 * own current `runs`/`wickets`/`legalBalls` reads below, so the emitted
 * total can never fall below what the fold already holds. (The addition
 * itself is the one new failure mode this reversal accepts — a bug there
 * could still emit a total that is higher than before, which passes the
 * guard while drifting wrong permanently with nothing to catch it; the
 * `hintText` anchor below is the owner's chosen mitigation, not a fix.)
 *
 * `hintText` on all three: the fold's CURRENT total as `${runs}/${wickets}`
 * — the exact notation `buildScorebug`'s own `halves[0].big` already uses,
 * so it needs no translation (numerals + "/" read identically on every
 * locale) and this function can stay `t`-free like every OTHER member here
 * except `scorebug`/`dock` (this file's header). Now load-bearing rather
 * than decorative: it is the only place the scorer sees what the delta
 * above is being added to. `hintText` is baked once when this record is
 * built (G4, types.ts) and rendered VERBATIM by guided-sheet.tsx (never
 * through `t()`, that file's own doc on `SheetNumberStep.hintText`) — it
 * cannot react to a scorer's still-in-progress stepper taps on ANY step
 * (guided-sheet.tsx is out of this wave's file grant, and
 * `SheetNumberStep.hintText` is a plain `string`, not a function of the
 * live edit value or of answers already given earlier in the SAME wizard
 * run). What ships instead: a correct, always-fresh "before" anchor —
 * rebuilt every `sheets(view)` call, per `PadHostView`'s own "never stale"
 * obligation — sitting directly above the ALREADY-live editable field
 * (task 2's own `renderNumberStep`). Flagged here as a deliberate
 * deviation, not a silent reinterpretation.
 *
 * Field renamed from `hint` (R2b-cricket-over follow-up, hint-field naming
 * pass, 2026-08-17) — see `SheetChoiceStep.hintKey`'s doc (types.ts) for
 * why the bare name, shared with that unrelated KEY-convention field, was
 * a defect.
 */
function overSummarySheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  // R2b-next: `scoringInnings`, not `currentInnings` — a closed innings with
  // another due must prefill/hint from 0/0/0, not the closed innings' own
  // final totals, or buildPayload below would ADD this over's entered delta
  // onto a completely unrelated (and much larger) base.
  const innings = scoringInnings(state, cfg);
  const bpo = ballsPerOverOf(cfg);
  const runs = innings?.runs ?? 0;
  const wickets = innings?.wickets ?? 0;
  const legalBalls = innings?.legalBalls ?? 0;
  const before = `${runs}/${wickets}`;

  const steps: GuidedSheetStep[] = [
    { id: "runs", kind: "number", title: "pad.cricket.sheet.overSummary.runs.title", initial: 0, min: 0, hintText: before },
    { id: "wickets", kind: "number", title: "pad.cricket.sheet.overSummary.wickets.title", initial: 0, min: 0, hintText: before },
    { id: "balls", kind: "number", title: "pad.cricket.sheet.overSummary.balls.title", initial: bpo, min: 0, max: bpo, hintText: before },
  ];

  return {
    event: "cricket.innings.summary",
    steps,
    buildPayload: (answers) => ({
      runs: runs + Number(answers.runs),
      wickets: wickets + Number(answers.wickets),
      legalBalls: legalBalls + Number(answers.balls),
      partial: true,
    }),
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  return {
    wicket: wicketSheet(view),
    toss: tossSheet(view),
    retire: retireSheet(view),
    review: reviewSheet(view, t),
    inningsClose: inningsCloseSheet(),
    overSummary: overSummarySheet(view),
  };
}

// ---------------------------------------------------------------------------
// swap() — DROPPED (R2b, owner ruling, live-tile audit defect 4,
// 2026-08-17). This section used to build a `SwapSlot` for `cricket.retire`
// (off/on pair, hardcoded `reason: "other"`) backing the tile removed above
// in `buildTiles`. That flow scoped its "off" picker to the WHOLE batting
// side rather than the crease (engine backstops it at cricket.ts:1676),
// while the generic More-sheet's own `cricket.retire` action was already
// separately reachable with a real reason enum — two divergent entry points
// for one event, the defect this removal closes. `cricketSkinV3` below now
// omits `swap` entirely (same "absent means never applicable" convention
// `context`/`contextSelect` already establish in this file) — cricket has
// no SwapSheet surface at all. `SwapSheet`/`SwapSlot` remain CHASSIS code
// (swap-sheet.tsx, types.ts, pad-host.tsx) untouched by this removal — they
// stay available for R3-R7, simply unused by cricket now.
// ---------------------------------------------------------------------------

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
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, _view, payload) => buildDock(eventType, t, payload),
    context: (view) => buildContext(view, t),
    sheets: (view) => buildSheets(view, t),
    // D2 (R2 sign-off): the skin supplies per-ball detail so the activity
    // panel's rows differ from one another. Declared HERE rather than the
    // chassis importing `cricketBallDetail` directly — sport vocabulary stays
    // skin-owned. Without this line the function exists, its unit tests pass,
    // and every row still reads "Ball recorded" in the product.
    activityDetail: cricketBallDetail,
    // No swap — see this file's own "swap() — DROPPED" section above
    // (owner ruling, live-tile audit defect 4). cricket.retire is reached
    // through the generic More sheet only.
  };
}
