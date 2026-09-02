// Badminton SkinDefV3 — R5, tapModel S. Converts badminton to the v3 chassis
// (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// redesign-design.md` §2/§3, rulings R5-1..R5-3). Replaces
// `../../skins/racquet-skin.tsx` (v2) as BADMINTON'S pad surface only — that
// file still serves table tennis and volleyball, which convert in later
// waves, so it stays on disk untouched.
//
// PURE DATA, no React — the same testability stance every v3 skin takes
// (apps/web vitest is `environment: "node"`, no jsdom). FACTORY, not a bare
// object: `ScorebugSpec.context`, `WhoLine.name` and `DockSpec.title` are
// pre-resolved TEXT, and no `SkinDefV3` method itself receives `t`
// (registry.ts's header carries the full reasoning).
//
// `t` IS REQUIRED EVERYWHERE, NEVER DEFAULTED. Cricket's `buildTiles(view, t:
// TFn = (key) => key)` let its own factory drop the second argument, ship the
// raw i18n key as the visible tile label, and stay green
// (`reference_v3_labeltext_and_default_t_threading.md`: a function with an
// extra defaulted parameter still satisfies a callback type declaring fewer,
// so tsc says nothing). Every builder here takes `t` as a REQUIRED parameter,
// and `__tests__/badminton.test.ts`'s "factory wiring" block reds if the
// factory stops threading it.
//
// WHAT THIS WAVE ACTUALLY FIXES, and each one is a defect with a register
// entry rather than a design preference:
//
//  * D-17 — WHO IS SERVING. The v2 racquet header printed a hardcoded em dash
//    where the server belongs, because the set-based kernel folded no serving
//    fact. R5-1 added `setBasedServeContext` (packages/engine, `sports/
//    setbased`), a reader over the LEDGER plus the folded state. This file
//    CONSUMES it — one derivation, in the engine, shared with the public
//    scoreboard — and never re-derives the rotation. When the reader says
//    `serveOrderKnown: false`, nothing is rendered at all: an omitted fact
//    beats an authoritative-looking wrong one, and a placeholder glyph IS the
//    defect, not a mitigation of it.
//
//  * D-7 — BELOW BAND 3 THE PAD SAID NOTHING. `badminton.rally` is band 3 and
//    the kernel keys that band alone (`fidelityEntitlements: {3:
//    "scoring.rally_by_rally"}`), so an org without the entitlement got a live
//    pad whose rally control had simply VANISHED — the chassis drops an
//    above-band tile rather than locking it (`filterTilesByBand`,
//    pad-host.tsx), and there is no locked-tile path for a band gap at all.
//    A COMMUNITY ORG RESOLVES TO BAND 2, NOT 0 (`resolveFidelityBand` breaks
//    only on a band that NAMES a missing entitlement, and bands 0-2 name
//    none), so the register's "a lone Set score button" overstates it by one
//    drawer: the real screen is Set score PLUS sanctions. This skin makes the
//    silence speak — a visible, disabled rally tile plus a context-strip
//    message worded in badminton's own vocabulary.
//
//  * D-11 — THE SCORE STATED THREE TIMES. The v2 lane put the score in the
//    fixture header, an LCD panel and a SETS/POINTS board, all above the
//    fold. v3's single scorebug retires two of the three.
//
// TAP MODEL S — the halves ARE the rally buttons (`ScorebugHalf.tappable` +
// `tapEvent`), tennis's own precedent (R4). The half tapped is the side that
// WON the rally, which is exactly `SetBasedRally.wonBy`.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `swap()`. BWF Law 16 has no substitution — a player who cannot continue
//     retires and the match is over — which `setbased/badminton.ts`'s own
//     `lineupPolicy` states as `reentry: "none"`, and `records.substitutions`
//     is false. There is no in-play swap for this sport to declare.
//   - `contextSelect()`. The one context slot this skin ever declares is
//     `readOnly` (a recording-level notice, not a person picker), and a
//     readOnly slot's picker can never open (context-strip.tsx), so there is
//     no selection for this method to turn into an event.
//   - a Timeout tile, a Sub tile, an Expedite tile. BWF play has no timeouts
//     (only the interval at 11 and the between-game break) and no
//     substitutions; expedite is an ITTF system. All three types are still
//     REGISTERED in `eventSchemas` — the shared 6-branch kernel union needs
//     them for `padSpecConformanceSuite`'s bijection check — but this
//     fixture's `cfg.records` says it records none of them, so the fold
//     refuses each with INVALID_EVENT. `refusedEventTypes` says so out loud;
//     see its own doc for why that is not redundant with the missing panels.
"use client";
import type { SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import {
  badminton as badmintonModule,
  setBasedServeContext,
  type SetBasedServeContext,
  type SetBasedState,
} from "@seazn/engine/sports/setbased";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import { featurePlan } from "@/lib/feature-copy";
import { planLabel } from "@/lib/plan-label";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type ContextStripSpec,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugHalf,
  type ScorebugSpec,
  type SkinDefV3,
  type StripItem,
  type TileSpec,
  type WhoLine,
} from "../types";
import type { SportTone } from "../sport-theme";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "badminton";
export const RALLY_TYPE = `${SPORT}.rally`;
/** The FULLY QUALIFIED coarse type, `${key}.${preset.coarseEventType}`
 *  (setbased/kernel.ts). The preset declares only the second half
 *  ("game.summary"); posting that bare half is a 422 INVALID_EVENT. */
export const SUMMARY_TYPE = `${SPORT}.${badmintonModule.coarseEventType}`;
export const SANCTION_TYPE = `${SPORT}.sanction`;
export const TIMEOUT_TYPE = `${SPORT}.timeout`;
export const SUB_TYPE = `${SPORT}.sub`;
export const EXPEDITE_TYPE = `${SPORT}.expedite.start`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/** The feature key badminton's band 3 is gated behind — `setbased/badminton
 *  .ts`'s own `rallyEntitlement`, which the kernel publishes as
 *  `padSpec(cfg).fidelityEntitlements[3]`. RESTATED here rather than read off
 *  a live `padSpec` call (which would need a cfg on every render just to word
 *  one sentence), and `__tests__/badminton.test.ts` pins this constant EQUAL
 *  to the module's own value — so a preset that ever re-keys it reds rather
 *  than leaving this file naming a stale entitlement and upselling the wrong
 *  plan. */
export const RALLY_ENTITLEMENT = "scoring.rally_by_rally";

/**
 * BWF's misconduct ladder, in the order the umpire's sheet climbs it:
 * yellow warning -> red fault -> (referee) removal from a game -> black
 * disqualification. All four are declared by `setbased/badminton.ts`'s own
 * `sanctionLevels` — this list restates that preset field so the sheet's
 * option order is a decision this file owns, and `__tests__/badminton.test.ts`
 * pins the two lists equal so they cannot drift apart.
 */
export const SANCTION_LEVELS: readonly string[] = [
  "warning",
  "penalty",
  "expulsion",
  "disqualification",
];

/**
 * The card code, as `SheetChoiceStep`'s `tone` (an ARRAY — the chassis reads
 * the LAST entry as the outcome that washes the button). The BWF's yellow is
 * `caution`; everything above it is the `dismissal` end.
 *
 * These are TEXT tones here, not swatches: the kernel models the ladder as an
 * ENUM of words (`sanctionAction`'s `{kind: "enum", path: "level"}`), not as a
 * card graphic — which is why `contrast.test.ts` holds badminton's two tones
 * to the full 4.5:1 text floor rather than football's 3:1 swatch licence.
 */
const SANCTION_LEVEL_TONE: Readonly<Partial<Record<string, readonly SportTone[]>>> = {
  warning: ["caution"],
  default: ["dismissal"],
};
function toneFor(level: string): readonly SportTone[] {
  return SANCTION_LEVEL_TONE[level] ?? SANCTION_LEVEL_TONE.default!;
}

/**
 * Event type -> fidelity band, MIRRORING `setBasedPadSpec`'s own `fidelity`
 * map (setbased/kernel.ts) rather than inventing a second scale. The chassis
 * filters tiles by this table's engine-side twin (`filterTilesByBand` reads
 * `PadSpec.fidelity`); this copy exists so `buildTiles` can decline to DRAW an
 * out-of-band tile in the first place, which is a different and earlier
 * decision than the chassis's safety filter — football's own `EVENT_BAND`
 * takes the identical posture and states the identical reason.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  [SUMMARY_TYPE]: 0,
  [TIMEOUT_TYPE]: 1,
  [SANCTION_TYPE]: 1,
  [SUB_TYPE]: 1,
  [EXPEDITE_TYPE]: 1,
  [RALLY_TYPE]: 3,
};

function withinBand(eventType: string, band: FidelityBand): boolean {
  const need = EVENT_BAND[eventType];
  return need === undefined || need <= band;
}

// ---------------------------------------------------------------------------
// The folded state, as this file reads it. A STRUCTURAL view of
// `SetBasedState` (setbased/kernel.ts) — every field optional, because a pad
// can mount against a pre-fold `{}` and must degrade rather than throw.
// ---------------------------------------------------------------------------

interface BadmintonSetShape {
  home?: number;
  away?: number;
  closed?: boolean;
}
interface BadmintonRecordFlags {
  timeouts?: boolean;
  sanctions?: boolean;
  substitutions?: boolean;
  expedite?: boolean;
}
interface BadmintonCfgShape {
  bestOf?: number;
  setTo?: number;
  finalSetTo?: number;
  winBy?: number;
  cap?: number | null;
  records?: BadmintonRecordFlags;
}
interface BadmintonStateShape {
  cfg?: BadmintonCfgShape;
  entrants?: { home?: string; away?: string };
  phase?: string;
  sets?: BadmintonSetShape[];
  setsWon?: { home?: number; away?: number };
  squads?: SquadState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asState(state: unknown): BadmintonStateShape {
  return asRecord(state) as BadmintonStateShape;
}
function asCfg(cfg: unknown): BadmintonCfgShape {
  return asRecord(cfg) as BadmintonCfgShape;
}

/** The fixture's resolved config. Prefers the FOLD'S OWN copy
 *  (`SetBasedState.cfg`, which is what `apply` actually ran against) and falls
 *  back to `PadHostView.cfg` only for a pad mounted before any fold exists. */
function cfgOf(view: PadHostView): BadmintonCfgShape {
  const folded = asState(view.state).cfg;
  return folded !== undefined ? folded : asCfg(view.cfg);
}

function readPhase(state: BadmintonStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

function entrantOf(state: BadmintonStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: BadmintonStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

function vocabKey(field: string, value: string): MessageKey | null {
  for (const map of ENUM_VOCAB[field] ?? []) {
    const key = map[value];
    if (key) return key;
  }
  return null;
}
function vocabText(field: string, value: unknown, t: TFn): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const key = vocabKey(field, value);
  return key ? t(key) : value;
}

// ---------------------------------------------------------------------------
// phase() — OPT-IN, and the opt-in is the point. A skin that omits this method
// keeps `pad-host.tsx`'s self-correcting local `phase` state, which is
// TAB-SHAPED: an action reads as unavailable because a tab is unselected
// rather than because the match is not there (D-16 / ruling G3). `phase()`
// makes the MATCH authoritative.
//
// `SetBasedState.phase` is `pre|live|done|final|abandoned` (kernel.ts) — five
// values MAPPED DOWN onto `PadPhase`'s closed three. Never widen `PadPhase`
// to carry a sport's richer phase; the type's own doc forbids it.
// ---------------------------------------------------------------------------

const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

// ---------------------------------------------------------------------------
// The open game, and its score.
//
// `SetBasedState.sets` is "closed sets in order + at most one trailing open
// set" (kernel.ts). `openSet` there returns null when the trailing entry is
// closed — the same reading here, so "the current game's score" can never
// silently report a finished game's final score as live.
// ---------------------------------------------------------------------------

interface OpenGame {
  home: number;
  away: number;
  index: number;
}

function openGame(state: BadmintonStateShape): OpenGame | null {
  const sets = state.sets ?? [];
  const index = sets.length - 1;
  const set = sets[index];
  if (set === undefined || set.closed === true) return null;
  return { home: set.home ?? 0, away: set.away ?? 0, index };
}

/** Points a side has in the game the board is resting on.
 *
 *  The open game while one is open; otherwise the LAST GAME PLAYED. Returning
 *  0 with no game open (review of PR #678, finding 5) meant a DECIDED match
 *  — every game closed by definition — showed 0 as the biggest number on the
 *  screen, the one read from across the court, with only the small games
 *  strip carrying the result. Between games it was equally wrong for the same
 *  reason: the game just banked is what a paper scoresheet leaves showing.
 *
 *  0 survives for exactly one case, and it is the true one: a match with no
 *  games at all, before the first rally. */
function pointsOf(state: BadmintonStateShape, side: Side): number {
  const open = openGame(state);
  if (open !== null) return open[side];
  // DECIDED ONLY. Between games the board must read 0 — the scorer is looking
  // at the game about to start, and it starts at nothing. A first cut of this
  // fell back whenever no game was open, on the reasoning that a paper
  // scoresheet leaves the last game showing; the walkthrough suite caught it
  // ("a new game starts at nothing, not at the last game's score") and the
  // walkthrough is right. Only once the MATCH is over is there no next game
  // for the board to be waiting on.
  if (!POST_PHASES.has(readPhase(state))) return 0;
  const sets = state.sets ?? [];
  const last = sets[sets.length - 1];
  return last?.[side] ?? 0;
}

/** `setInProgress`'s badminton twin (`applySummary`'s strict branch,
 *  kernel.ts): a game with ANY point already recorded is being scored
 *  rally-by-rally, and the fold refuses a summary for it. Consumed by BOTH
 *  `buildTiles` (which withholds the Set score tile) and `refusedEventTypes`
 *  (which withholds the generic More form) — one predicate, so the two cannot
 *  be broken by halves. */
function gameInProgress(state: BadmintonStateShape): boolean {
  const open = openGame(state);
  return open !== null && (open.home > 0 || open.away > 0);
}

/** The number of the game being played right now, 1-based. Closed games plus
 *  one — which is what makes "Game 2" appear the instant game 1 banks, the
 *  fact `scoring.spec.ts`'s "not always game 1" test has always been about. */
function gameNumber(state: BadmintonStateShape): number {
  const sets = state.sets ?? [];
  const open = openGame(state);
  return open === null ? sets.length + 1 : open.index + 1;
}

/** `setTarget` (kernel.ts) — the deciding game may run to a different target,
 *  which is what `finalSetTo` is for. */
function targetOf(cfg: BadmintonCfgShape, gameIndex: number): number {
  const bestOf = cfg.bestOf ?? 3;
  const setTo = cfg.setTo ?? 21;
  return gameIndex === bestOf - 1 ? (cfg.finalSetTo ?? setTo) : setTo;
}

/** `summaryScoreBound` (kernel.ts) — the cfg-derived plausibility ceiling for
 *  the Set score sheet's two number fields. Badminton is a CAPPED sport, so
 *  the cap itself is the bound; the uncapped fallback mirrors the kernel's own
 *  `+20` margin for a config that removes the cap. */
function scoreBound(cfg: BadmintonCfgShape): number {
  const cap = cfg.cap;
  if (typeof cap === "number") return cap;
  return Math.max(cfg.setTo ?? 21, cfg.finalSetTo ?? 21) + 20;
}

// ---------------------------------------------------------------------------
// Serving — CONSUMED from the engine (R5-1), never re-derived here.
//
// `setBasedServeContext(source, state, events)` is a pure reader over the
// LEDGER plus the folded state. Both halves are genuinely needed: the ledger
// carries the rally order the BWF's Law 10.1 "winner serves next" rule walks,
// and the state carries the set boundaries Law 8.1 re-anchors on. Three
// skin-local derivations were rejected outright by the ruling that produced
// the reader, because the public scoreboard needs the same answer.
//
// `PadHostView.events` (types.ts) is the SUPPORTED route to the ledger and it
// already exists — do not add a second one.
// ---------------------------------------------------------------------------

/**
 * Adapts `PadHostView`'s split shape into the reader's real input.
 *
 * `PadHostView` keeps `squads` beside `state`, where `SetBasedState.squads` is
 * one of `state`'s own (optional) properties — so this builds the ONE object
 * the reader expects rather than casting `view.state` wholesale. `view.squads`
 * is always populated (`initSquads(lineups)` fallback, types.ts's own doc),
 * and `state.squads` is absent until it says something the team sheet does not
 * (sports/squad-state.ts), so preferring the view's copy is strictly more
 * informative and never less correct.
 *
 * Typed as exactly the `Pick<SetBasedState, ...>` of the fields the reader's
 * call graph actually touches, then widened in a SINGLE `as` — deliberately
 * not `as unknown as`, which would skip checking the literal against any shape
 * at all. Drop `setsWon` from the literal by hand and `tsc --noEmit` reds on
 * this exact line; do the same through `unknown` and it stays silent until a
 * render crashes. The list, verified against `setBasedServeWalk` +
 * `setBasedServeContext` (kernel.ts):
 *
 *   cfg       replayed against (`setBasedReplayState`), and `cfg.records
 *             .expedite` is read directly on every rally
 *   entrants  the id -> side map the walk resolves `wonBy`/`serving` through
 *   phase     `done`/`final`/`abandoned` short-circuit to "match-over"
 *   sets      the ledger-vs-state agreement check, set by set
 *   setsWon   the same agreement check
 *   squads    read ONLY under `serverFromPairOrder`/`rotationCycle`, neither
 *             of which badminton declares — supplied anyway, because omitting
 *             a field on the grounds that today's preset never reads it is how
 *             R4's own shim shipped wrong twice
 */
function serveInput(view: PadHostView, state: BadmintonStateShape): SetBasedState | null {
  const cfg = state.cfg;
  // No fold, no answer. `setBasedReplayState` needs a REAL parsed cfg (it
  // replays `applyRally` against it and reads `cfg.records.expedite` per
  // rally), and `view.cfg` is not guaranteed to be the same object shape, so
  // this refuses rather than replaying against a half-built config and
  // reporting a confident side off it.
  if (cfg === undefined || cfg.records === undefined) return null;
  if (state.entrants?.home === undefined || state.entrants.away === undefined) return null;
  const shim: Pick<SetBasedState, "cfg" | "entrants" | "phase" | "sets" | "setsWon" | "squads"> = {
    cfg: cfg as SetBasedState["cfg"],
    entrants: { home: state.entrants.home, away: state.entrants.away },
    phase: (readPhase(state) as SetBasedState["phase"]) ?? "live",
    sets: (state.sets ?? []).map((set) => ({
      home: set.home ?? 0,
      away: set.away ?? 0,
      closed: set.closed === true,
    })),
    setsWon: { home: state.setsWon?.home ?? 0, away: state.setsWon?.away ?? 0 },
    squads: view.squads,
  };
  return shim as SetBasedState;
}

/**
 * Who is serving the next rally, or `null` when the engine will not say.
 *
 * THE ONE RULE THIS FUNCTION EXISTS FOR: `serveOrderKnown === false` renders
 * NOTHING. Not an em dash, not "—", not "Unknown" — D-17 is precisely the
 * defect of printing a placeholder where a fact belongs, and a mitigation that
 * prints a different placeholder is the same defect in a new glyph.
 *
 * `serverPersonId` is `null` for every badminton fixture the reader will ever
 * see: BWF Law 10.5 picks the doubles server by the SERVICE COURT the players
 * are standing in, which this kernel does not fold, so the preset declares no
 * `serverFromPairOrder` and the reader names no person. A SINGLES side is a
 * different question and is answered below, in `soleMemberOf` — "the only
 * member on this side", never a second copy of a rotation rule.
 */
export function serveContextOf(
  view: PadHostView,
  state: BadmintonStateShape,
): SetBasedServeContext | null {
  const input = serveInput(view, state);
  if (input === null) return null;
  return setBasedServeContext(badmintonModule, input, view.events);
}

/** The starting roster for one side, first-named first (pairOrder, falling
 *  back to team-sheet order). `positions.lineup.size = 1` is ONE nominated
 *  UNIT (setbased/badminton.ts) — one person for an individual entrant, two
 *  for a pair — so this is where singles and doubles actually differ, and it
 *  differs by LENGTH, never by a variant flag. */
function onFieldPlayers(squads: SquadState, side: Side): readonly SquadState["home"]["members"][number][] {
  return squads[side].members
    .filter((member) => member.onField && member.role === "player")
    .slice()
    .sort((a, b) => {
      const pa = a.pairOrder ?? Number.POSITIVE_INFINITY;
      const pb = b.pairOrder ?? Number.POSITIVE_INFINITY;
      return pa !== pb ? pa - pb : a.orderNo - b.orderNo;
    });
}

/**
 * The one on-field player of a SINGLES side, or null for a pair (or an empty
 * roster). "The only member" — an identity, not a derivation: it never asks
 * who is serving, so it holds even while the serve reader refuses to answer.
 */
function soleMemberOf(squads: SquadState, side: Side): string | null {
  const players = onFieldPlayers(squads, side);
  return players.length === 1 ? (players[0]?.personId ?? null) : null;
}

interface ServingInfo {
  side: Side;
  /** Present only where a PERSON is genuinely unambiguous — a singles side.
   *  Never a doubles guess (see `serveContextOf`'s own doc). */
  personId: string | null;
}

function servingInfo(view: PadHostView, state: BadmintonStateShape): ServingInfo | null {
  const ctx = serveContextOf(view, state);
  // ONE guard, deliberately. The reader's own documented INVARIANT is
  // `serveOrderKnown === (servingSide !== null)`, so also testing
  // `serveOrderKnown` here would be a SECOND check that can never disagree
  // with this one — and a pair of guards where either alone suffices is a pair
  // where neither can be killed by mutation: knocking out either half leaves
  // the other one silently covering for it, and the suite stays green while
  // the defence is half gone. Found exactly that way while mutation-checking
  // this file. The invariant itself is asserted directly, against the real
  // engine, in `__tests__/badminton.test.ts` — a fact proven once beats a
  // condition restated twice.
  if (ctx === null || ctx.side === null) return null;
  const side = ctx.side;
  return { side, personId: ctx.serverPersonId ?? soleMemberOf(view.squads, side) };
}

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

/**
 * R8/#676 — every value the `server` slot can take for THIS fixture, which is
 * answerable WITHOUT knowing who is serving: each side contributes exactly the
 * string `buildStrip` would print for it. Mirrors that derivation rather than
 * restating it — `soleMemberOf` for a singles side, the side label for a pair,
 * the same two branches and in the same order.
 *
 * Used only to hold the slot's width (`StripItem.reserve`), never displayed.
 */
function serverCandidates(view: PadHostView, t: TFn): string[] {
  return (["home", "away"] as const).map((side) => {
    const sole = soleMemberOf(view.squads, side);
    return sole === null ? t(SIDE_LABEL[side]) : nameOf(view, sole, t);
  });
}

/** Both BWF service courts — the `court` slot's whole value space. */
function courtCandidates(t: TFn): string[] {
  return [
    t("pad.badminton.scorebug.strip.court.right"),
    t("pad.badminton.scorebug.strip.court.left"),
  ];
}

/**
 * Is the reader refusing because its two halves DISAGREE, as opposed to a
 * fixture that simply has no server yet?
 *
 * The distinction is the whole of the R8/#676 ruling. A drift refusal
 * (`ledger-mismatch`, `recorded-disagrees`) is transient-shaped and the row
 * must not re-flow around it, so the slots are RESERVED. `undeclared` and
 * `match-over` are not: before the first rally nobody can say who serves and
 * the pad renders nothing at all — today's behaviour, pinned by
 * `walkthrough/scorepad-v3-badminton-match.spec.ts`'s own `toHaveCount(0)`,
 * and explicitly kept by the owner ruling.
 */
function serveDrifted(view: PadHostView, state: BadmintonStateShape): boolean {
  const ctx = serveContextOf(view, state);
  if (ctx === null) return false;
  return ctx.unknownBecause === "ledger-mismatch" || ctx.unknownBecause === "recorded-disagrees";
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel S, and D-11's fix: ONE score, rendered once.
// ---------------------------------------------------------------------------

/** "Best of 3 · Game 2", plus the endgame BWF actually has words for.
 *  `setting` is 20-all (win by two from here); `golden point` is 29-all under
 *  the hard cap of 30, where the next rally simply ends the game — the one
 *  rule that genuinely distinguishes badminton from volleyball on this same
 *  kernel, and worth saying on screen. Golden point wins when both apply,
 *  because it is the stronger statement. */
function buildContext(state: BadmintonStateShape, cfg: BadmintonCfgShape, t: TFn): string {
  const bestOf = cfg.bestOf ?? 3;
  // CLAMPED to `bestOf`. `gameNumber` is "closed games plus one", which is what makes
  // "Game 2" appear the instant game 1 banks — correct while a match is
  // live, and wrong the moment it ends: every game is then closed, so a
  // decided best-of-3 board announced "Game 4", a game nobody played.
  // The scorebug renders its context line in EVERY phase (`scorebug.tsx`) and
  // `pad-host.tsx` renders the scorebug in "post", so the decided board is a
  // real screen a scorer reads, not a transient. Found in review of PR #678.
  // Clamping to `bestOf` removed "Game 6" but not the class of defect: a
  // best-of-3 won 2-0 has TWO games in the book and `gameNumber` (closed + 1)
  // still says 3 — a game nobody played, and `Math.min` cannot see it because
  // 3 <= bestOf. Once the match is over the board names the LAST game played;
  // while it is live "closed + 1" is exactly right, and that is the case that
  // makes "Game 2" appear the instant game 1 banks.
  const played = (state.sets ?? []).length;
  const decided = POST_PHASES.has(readPhase(state));
  const game = decided ? Math.max(played, 1) : Math.min(gameNumber(state), bestOf);
  const base = t("pad.badminton.context.line", { bestOf, game });
  const open = openGame(state);
  if (open === null || open.home !== open.away) return base;
  const cap = cfg.cap;
  if (typeof cap === "number" && open.home === cap - 1) {
    return `${base} · ${t("pad.badminton.context.goldenPoint")}`;
  }
  const target = targetOf(cfg, gameNumber(state) - 1);
  if (open.home === target - 1) return `${base} · ${t("pad.badminton.context.setting")}`;
  return base;
}

function buildHalf(
  view: PadHostView,
  state: BadmintonStateShape,
  side: Side,
  serving: ServingInfo | null,
  t: TFn,
): ScorebugHalf {
  const players = onFieldPlayers(view.squads, side);
  const servingPersonId = serving && serving.side === side ? serving.personId : null;
  const who: WhoLine[] =
    players.length > 0
      ? players.map((member) => {
          const isServing = servingPersonId !== null && member.personId === servingPersonId;
          // `servingLabel` IS SUPPLIED WHEREVER `serving` IS (R1's standing
          // item). With `serving: true` and no label the chassis renders a
          // decorative `aria-hidden` dot and NOTHING for a screen reader
          // (scorebug.tsx's `whoNames` deliberately does not fabricate one) —
          // the cue would be silently absent, which is worse than absent
          // loudly. Pre-localised by the SKIN, because the chassis must never
          // resolve a sport-namespaced key (types.ts's own rule).
          return {
            name: nameOf(view, member.personId, t),
            ...(isServing ? { serving: true, servingLabel: t("pad.badminton.scorebug.serving") } : {}),
          };
        })
      : [{ name: t(SIDE_LABEL[side]) }]; // defensive: assertScorebugSpec requires a non-empty `who`

  // Band 3 gate: `badminton.rally` IS a band-3 event, so below it a tappable
  // half would be a dead-end tap. WITHHELD against the ACTIVE band, not merely
  // the entitled one — the same `filterTilesByBand`-vs-`buildPadView`
  // distinction football's `EVENT_BAND` states.
  const tappable = resolvePhase(view) === "live" && view.band >= 3;
  // R5-2 — SINGLES AUTO-SET. `players` is this side's whole on-field roster,
  // so a length-1 side has nothing to choose: its sole member IS whoever won
  // the rally, and that is stamped INTO THE TAP rather than left for the
  // dock's question. A pair is left off on purpose — the dock asks (see
  // `buildDock`).
  const soleScorer = players.length === 1 ? players[0]?.personId : undefined;
  // The SERVER, as a person, for the `serves` playerStats metric
  // (setbased/badminton.ts declares one). Only ever the sole member of a
  // singles serving side — never a doubles guess, for the reason
  // `serveContextOf` states. NOT the same field as `SetBasedRally.serving`,
  // which is an ENTRANT id and is deliberately never sent (see below).
  const server = serving && serving.personId !== null ? serving.personId : undefined;
  return {
    who,
    big: String(pointsOf(state, side)),
    tappable,
    ...(tappable
      ? {
          hintKey: "pad.badminton.scorebug.rally.hint",
          tapEvent: {
            type: RALLY_TYPE,
            payload: {
              wonBy: entrantOf(state, side),
              // `SetBasedRally.serving` (the SIDE that served this rally) is
              // deliberately ABSENT. It is the umpire's own observation, and
              // `setBasedServeWalk` uses it as an independent drift detector
              // against its own belief — so a pad that filled it in from that
              // same belief would make the detector compare a derivation with
              // itself and agree forever. Badminton loses nothing by omitting
              // it: `serve.within` is "rally-winner", so from the first rally
              // onward the ledger names the server by itself.
              ...(server !== undefined ? { server } : {}),
              ...(soleScorer !== undefined ? { scorer: soleScorer } : {}),
            },
          },
        }
      : {}),
  };
}

/**
 * BWF Law 16.2 — the 60-second interval when a side first reaches 11 points.
 * DERIVED from the game's own target rather than hardcoded at 11, so the
 * `short` variant (games to 11, setbased/badminton.ts) gets its own halfway
 * mark instead of an interval it can never reach: `ceil(21/2) = 11` is the
 * BWF's own number, and `ceil(11/2) = 6` is the same rule one format down.
 *
 * Returns null once the mark is passed — the interval has happened, and a hint
 * that lingers for the rest of the game is furniture, not information.
 *
 * "PASSED" IS NOT `leader > mark`, which is the off-by-one this used to ship.
 * `Math.max` has no memory of when the mark was reached, so the strip announced
 * "Interval" at 11-9 (right), and went on announcing it at 11-10 and again at
 * 11-11 (wrong: the interval was taken two rallies ago and play has resumed),
 * clearing only at 12-11. Its own doc claimed otherwise — asserted, never run.
 * The file's regression case could not see it either: that stream scores one
 * side every rally, so `leader` never sits still while the game moves under it.
 *
 * BWF Law 8.1 supplies the missing memory with no event scan and no history:
 * the side that wins a rally serves the next one, so "the leader is ON the mark
 * AND still serving" is exactly "the leader's own rally is the one that just
 * took them there". Once the trailing side wins a point, serve moves and the
 * announcement is over — which is the same fact, read the same way, that this
 * skin's serve chrome already runs on.
 *
 * Two states deliberately do NOT go dark: both sides on the mark (11-11 — long
 * past, returns null), and a serve the reader will not name (coarse tiers, a
 * broken chain). The second keeps the announcement, because an umpire missing a
 * 60-second interval is a worse outcome than one seeing it a rally late.
 */
function intervalHint(
  view: PadHostView,
  state: BadmintonStateShape,
  cfg: BadmintonCfgShape,
  t: TFn,
): StripItem | null {
  const open = openGame(state);
  // A game not yet started is 0-0 of the game ABOUT TO BE PLAYED, not "no
  // game": `SetBasedState.sets` only materialises a set once something lands
  // in it, so between games (and before the first rally of the match) there is
  // no open entry at all — and "Interval at 11" is exactly the thing a scorer
  // wants to see then. `gameNumber` already reads that boundary the same way.
  const index = open?.index ?? (state.sets ?? []).length;
  const mark = Math.ceil(targetOf(cfg, index) / 2);
  const home = open?.home ?? 0;
  const away = open?.away ?? 0;
  const leader = Math.max(home, away);
  if (leader > mark) return null;
  if (leader === mark) {
    // Both there: 11-11 is a game that reached its interval long ago.
    if (home === away) return null;
    const onMark: Side = home === mark ? "home" : "away";
    const serving = servingInfo(view, state);
    if (serving !== null && serving.side !== onMark) return null;
    return { id: "interval", value: t("pad.badminton.scorebug.strip.intervalNow") };
  }
  return {
    id: "interval",
    label: t("pad.badminton.scorebug.strip.interval"),
    value: String(mark),
  };
}

/**
 * BWF Law 10.2 — WHICH SERVICE COURT. The server serves from the RIGHT court
 * when their own score in the current game is EVEN, and from the LEFT when it
 * is odd. Derived, never stored: it is a pure function of the serving side's
 * score, which is why the kernel has no field for it and why this belongs on
 * the pad rather than in the fold.
 *
 * Worth the strip slot because it is the OTHER half of what a BWF umpire calls
 * between rallies — "love all, play" is a score, "second server, left court" is
 * a position — and it is the fact this board's own scorer most often has to
 * hold in their head. It sits BESIDE the server rather than in the tile grid:
 * a service court is a STATE, and nothing about it is tappable.
 *
 * `null` while the serve is unknown, for the same reason the server item is
 * omitted then: a court derived from a side we cannot name is a confident
 * wrong answer wearing a true rule.
 */
function serviceCourt(state: BadmintonStateShape, serving: ServingInfo | null, t: TFn): StripItem | null {
  if (serving === null) return null;
  const score = pointsOf(state, serving.side);
  return {
    id: "court",
    // No label. "Right service court" is already a complete phrase, and a
    // "Court: Right" pairing reads as a table cell rather than as something an
    // umpire would say — the register the rest of this strip is written in.
    value: t(score % 2 === 0 ? "pad.badminton.scorebug.strip.court.right" : "pad.badminton.scorebug.strip.court.left"),
  };
}

/**
 * THE STRIP IS THE UMPIRE'S CALL, and that is this board's one real design
 * decision. Everything on it is something a BWF umpire says out loud between
 * rallies, in the order they say it: the games standing, who is serving, which
 * court they serve from, and how far the interval is. Nothing here is a number
 * put on screen because there was room for it — `setsWon` earns its place
 * because a badminton match is decided in GAMES and the halves only ever show
 * points, and the two positional facts earn theirs because they are what the
 * scorer would otherwise be holding in their head.
 *
 * NOTHING ON THIS STRIP TAKES `tone: "led"`. The accent is the SERVE and only
 * the serve (owner ruling R5-3, and R4-4's own discipline for tennis before
 * it): the chassis already spends `--sport-led` on the serve pip, the score
 * digits and the board's top hairline, and a fourth LED-panelled strip item
 * would leave the board with four things shouting and no signature. The
 * interval is the loudest candidate — a 60-second break IS an event — and it
 * is deliberately the quietest treatment on the strip.
 */
function buildStrip(
  view: PadHostView,
  state: BadmintonStateShape,
  cfg: BadmintonCfgShape,
  phase: PadPhase,
  serving: ServingInfo | null,
  drifted: boolean,
  t: TFn,
): StripItem[] {
  const items: StripItem[] = [
    {
      id: "games",
      label: t("pad.badminton.scorebug.strip.games"),
      // U+2013 EN dash, the joiner every scoreline in this product uses.
      value: `${state.setsWon?.home ?? 0}–${state.setsWon?.away ?? 0}`,
    },
  ];
  // OMITTED, never rendered stale — D-17's whole point. The engine's own
  // `serveOrderKnown` is the verdict, and there is no placeholder branch.
  //
  // R8/#676 adds a WIDTH branch, not a value branch. `reserve` carries both
  // sides' possible answers so the slot is the same width whichever one lands,
  // and `reserved` holds that width open while the reader is refusing over
  // DRIFT — so the centred row does not re-centre around the gap. Nothing is
  // printed in the gap; see `serveDrifted` for why `undeclared` is excluded.
  const serverReserve = serverCandidates(view, t);
  if (serving) {
    const value = serving.personId
      ? nameOf(view, serving.personId, t)
      : t(SIDE_LABEL[serving.side]);
    // `accent`, and it is the ONLY accented item on this strip. `StripItem
    // .accent` is full-strength ink where the rest of the row is `pad-ink-70`
    // — a WEIGHT step, not a colour one, which is the whole point: the serve
    // is this board's thesis and it has to lead the row, but the accent
    // COLOUR (`tone: "led"`) is reserved for the pip, so lifting it here costs
    // nothing from the one place the sport's colour is allowed to appear.
    // Games, court and interval stay at 70% behind it.
    items.push({
      id: "server",
      label: t("pad.badminton.scorebug.strip.server"),
      value,
      accent: true,
      reserve: serverReserve,
    });
  } else if (drifted) {
    items.push({
      // No `id`: this slot reports nothing, so nothing may locate it as if it
      // did (assertScorebugSpec enforces that). The LABEL is still supplied —
      // it is part of the width the answered state occupies, and the chassis
      // renders it only into the invisible sizer.
      label: t("pad.badminton.scorebug.strip.server"),
      value: "",
      reserved: true,
      reserve: serverReserve,
    });
  }
  // Live only, both of them. A finished match has no court to serve from and
  // no interval to come, and status that outlives its own match is furniture.
  if (phase === "live") {
    const courtReserve = courtCandidates(t);
    const court = serviceCourt(state, serving, t);
    // The court DIES on a refusal and is never held: it reads the parity of
    // the OPTIMISTIC score (`serviceCourt`), so a court kept across a drift
    // would be a genuinely wrong answer rather than a stale one. Only its
    // WIDTH survives.
    if (court) items.push({ ...court, reserve: courtReserve });
    else if (drifted) items.push({ value: "", reserved: true, reserve: courtReserve });
    const interval = intervalHint(view, state, cfg, t);
    if (interval) items.push(interval);
  }
  return items;
}

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const serving = servingInfo(view, state);
  const phase = resolvePhase(view);
  return {
    context: buildContext(state, cfg, t),
    phase,
    halves: [buildHalf(view, state, "home", serving, t), buildHalf(view, state, "away", serving, t)],
    strip: buildStrip(view, state, cfg, phase, serving, serving === null && serveDrifted(view, state), t),
  };
}

// ---------------------------------------------------------------------------
// context() — D-7's explanation, and the ONLY reason this skin declares a
// context strip at all.
//
// The chassis has no locked-tile path for a band GAP (`filterTilesByBand`
// drops an above-band tile outright, and `renderLockedTile` in the legacy lane
// only ever fired for an action AT OR BELOW the band whose entitlement was
// missing — unreachable for a kernel that keys one band). So the explanation
// has to be authored. It lives HERE rather than repeated on the tile because
// `TileSpec.disabled`'s own doc says so: one cause, one sentence, next to
// nothing that pretends to be a control.
//
// `readOnly: true` — there is no person to pick and nothing a tap could fix,
// so the chip renders as plain text and its picker can never open
// (context-strip.tsx). `contextSelect` is therefore not declared.
// ---------------------------------------------------------------------------

/** Whether rally-by-rally is out of reach for this fixture right now. Read off
 *  the ACTIVE band, which is what actually governs whether the halves are
 *  tappable — not off `view.entitlements`, which answers a related but
 *  different question (what the ORG holds, which a scorer may also have
 *  stepped down from deliberately). */
function rallyOutOfBand(view: PadHostView): boolean {
  return view.band < 3;
}

export function buildContextStrip(view: PadHostView, t: TFn): ContextStripSpec | null {
  if (resolvePhase(view) !== "live" || !rallyOutOfBand(view)) return null;
  return {
    slots: [
      {
        id: "recording",
        label: "pad.badminton.context.recording",
        pool: "onfield",
        required: false,
        readOnly: true,
        // Pre-localised (the chassis renders `message` verbatim), and it names
        // the plan through `featurePlan()` — the SAME cheapest-plan-per-key
        // table `<UpgradeGate>` and the recording chip already use, never a
        // second mapping invented here. Worded in BADMINTON's vocabulary:
        // "rally by rally" and "each game's final score" are what a scorer is
        // choosing between, where "band 3" and "Every detail" are not.
        message: t("pad.badminton.context.recording.locked", {
          plan: planLabel(featurePlan(RALLY_ENTITLEMENT)),
        }),
        // A TIER, not a fault. The chassis's default message register is the
        // red it was built for (cricket's ineligible bowler, which genuinely
        // blocks every scoring tile); this pad is working exactly as
        // configured, and reusing rejection red for a plan boundary would
        // teach a scorer that red here means nothing in particular. `info`
        // puts it in the same amber the recording chip words its own plan lock
        // in, two controls away.
        messageTone: "info",
        candidates: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// tiles()
// ---------------------------------------------------------------------------

export function sanctionSheetKey(side: Side): string {
  return `sanction-${side}`;
}

export const RALLY_LOCKED_TILE_ID = "rallyLocked";
export const SET_SCORE_TILE_ID = "setScore";

export function buildTiles(view: PadHostView, t: TFn): TileSpec[] {
  const state = asState(view.state);
  const live = resolvePhase(view) === "live";
  const band = view.band;
  const offerable = (eventType: string): boolean => live && withinBand(eventType, band);
  const tiles: TileSpec[] = [];

  // ORDER IS LOAD-BEARING. `tile-grid.tsx` is a bare `grid-cols-4` and nothing
  // checks that a side pair lands home-left / away-right — array order IS
  // row/column order (`reference_v3_board_two_lanes_and_dock_after_sheet.md`;
  // football's R3/B2 shipped Home's second yellow bodily inside the AWAY lane
  // with 65 green assertions). The one side-paired block below is pushed FIRST
  // and as an atomic 0-or-2 unit, so home is always column 0 and away always
  // column 2, in every band/phase combination.

  // Sanctions — a MINOR row, per side. `SetBasedSanction.by` is REQUIRED, so
  // the side is fixed by WHICH tile was tapped rather than asked inside the
  // sheet. Gated on this fixture's own `records.sanctions` as well as the
  // band: an organiser CAN configure the flag off (`makeConfigSchema` defaults
  // it from the preset but does not freeze it), and the fold refuses the event
  // outright when it is.
  if (offerable(SANCTION_TYPE) && recordsFlag(view, "sanctions")) {
    for (const side of SIDES) {
      tiles.push({
        id: sanctionSheetKey(side),
        label: "pad.badminton.action.sanction",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { sheet: sanctionSheetKey(side) },
      });
    }
  }

  // Set score — the band-0 action that survives at every band, and the one
  // control a community org actually has. Withheld while the CURRENT game is
  // being scored rally-by-rally; the paired `refusedEventTypes` entry is what
  // keeps the generic More sheet from offering the same refused action again.
  if (offerable(SUMMARY_TYPE) && !gameInProgress(state)) {
    tiles.push({
      id: SET_SCORE_TILE_ID,
      label: "pad.badminton.action.setScore",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: SET_SCORE_TILE_ID },
    });
  }

  // D-7 — THE SILENCE, GIVEN A FACE. Below band 3 the chassis drops the rally
  // affordance entirely and the scorer is left with a board whose halves do
  // nothing and no reason anywhere on screen. This tile is that reason's
  // affordance: VISIBLE, disabled, span-4 so it reads as a statement about the
  // board rather than a button someone missed, and paired with the context
  // slot above which carries the sentence (`assertDisabledTilesExplained`,
  // tile-grid.tsx, is the rule that pairing satisfies — this skin's own test
  // asserts it returns no violations).
  //
  // THE ACTION IS `MORE_SHEET_KEY` FOR A STRUCTURAL REASON, not a shrug.
  // `filterTilesByBand` resolves a tile's event type and drops the tile when
  // that type's band exceeds the org's — so a tile pointing at `badminton
  // .rally` in ANY form would be filtered out by the very gate it exists to
  // explain. `MORE_SHEET_KEY` is the one action value `tileEventType` resolves
  // to `null` BY NAME (pad-host.tsx), which is the "unclassifiable, therefore
  // kept" branch. `disabled: true` is what makes the tap inert regardless: the
  // chassis renders a native `<button disabled>`, so nothing opens.
  if (live && rallyOutOfBand(view)) {
    tiles.push({
      id: RALLY_LOCKED_TILE_ID,
      label: "pad.badminton.action.rally",
      labelText: t("pad.badminton.tile.rallyLocked"),
      sublabelText: t("pad.badminton.tile.rallyLocked.sublabel"),
      kind: "minor",
      span: 4,
      phases: ["live"],
      disabled: true,
      action: { sheet: MORE_SHEET_KEY },
    });
  }

  tiles.push({
    id: "more",
    label: "scorepad.skin.more",
    kind: "minor",
    span: 4,
    phases: ["live"],
    action: { sheet: MORE_SHEET_KEY },
  });

  return tiles;
}

/** This FIXTURE's own record flags, from the fold's cfg. Per-fixture, never
 *  the preset's declared defaults: `SetBasedCfg.records` is a real config knob
 *  (S6/#416 moved it off the preset for exactly this reason — the beach
 *  volleyball regression), so a badminton fixture configured to record
 *  timeouts genuinely can, and a pad that read the preset instead would refuse
 *  an action the fold would have accepted. */
function recordsFlag(view: PadHostView, flag: keyof BadmintonRecordFlags): boolean {
  return cfgOf(view).records?.[flag] === true;
}

/**
 * `SkinDefV3.refusedEventTypes` — the More sheet's SECOND exclusion set: "the
 * fold will not accept this at all right now". Deliberately NOT unioned with
 * `dedicatedEventTypes` ("already reachable through a narrowed surface"): the
 * two exclude for opposite reasons and a later reader must be able to tell
 * which applied.
 *
 * FOUR entries, in two groups:
 *
 *  - `game.summary`, while the current game already has a point. `applySummary`'s
 *    strict branch refuses it outright ("this set is being scored
 *    rally-by-rally"). This one is THE ONLY DEFENCE: `buildTiles` withholds
 *    the tile, and withholding a tile does not remove an action — it MOVES it
 *    into the More sheet (`moreActions` re-offers everything not dedicated),
 *    which is precisely the D-16-shaped dead-end tap.
 *
 *  - `timeout` / `sub` / `expedite.start`, whenever this fixture's cfg says it
 *    does not record them. BWF play has none of the three, so for every
 *    shipped badminton config all three are refused always. `apply` throws
 *    INVALID_EVENT for each (kernel.ts's `strict && !records.<flag>` guards),
 *    and `padSpec` builds no panel for a flag that is off, so today these
 *    never reach the More sheet by either route. That makes them DEFENCE IN
 *    DEPTH rather than a live fix — and the distinction is worth keeping
 *    straight, because the two layers are in different packages with nothing
 *    tying them together. Tennis's `game.award` entry has exactly this status
 *    and the same justification.
 *
 * Read PER FIXTURE, off the fold's own cfg — never off the preset's declared
 * defaults. A config that legitimately turns one of the three ON must not have
 * its action refused here.
 */
export function refusedEventTypes(view: PadHostView): string[] {
  const state = asState(view.state);
  const refused: string[] = [];
  if (gameInProgress(state)) refused.push(SUMMARY_TYPE);
  if (!recordsFlag(view, "timeouts")) refused.push(TIMEOUT_TYPE);
  if (!recordsFlag(view, "substitutions")) refused.push(SUB_TYPE);
  if (!recordsFlag(view, "expedite")) refused.push(EXPEDITE_TYPE);
  return refused;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), the standing
// convention every v3 skin's `sheets` takes.
// ---------------------------------------------------------------------------

/**
 * The Set score sheet — two numbers, prefilled from the CURRENT open game so a
 * scorer edits up from where the fold already is rather than counting from
 * zero (cricket's over-summary precedent). `min`/`max` are enforced by the
 * chassis renderer, not left to `buildPayload`: the stepper and the editable
 * field are two paths to the same control.
 */
function setScoreSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const bound = scoreBound(cfg);
  const open = openGame(state);
  return {
    event: SUMMARY_TYPE,
    steps: [
      {
        id: "home",
        kind: "number",
        title: "pad.badminton.sheet.setScore.home.title",
        initial: open?.home ?? 0,
        min: 0,
        max: bound,
      },
      {
        id: "away",
        kind: "number",
        title: "pad.badminton.sheet.setScore.away.title",
        initial: open?.away ?? 0,
        min: 0,
        max: bound,
      },
    ],
    buildPayload: (answers) => ({ home: Number(answers.home ?? 0), away: Number(answers.away ?? 0) }),
  };
}

/**
 * The sanction sheet, per side. The LEVEL is always asked; the PERSON is asked
 * only when there is genuinely a choice — a singles side has one on-field
 * player, so its sole member is stamped by `buildPayload` instead of being
 * offered as a one-option picker (D-14/D-15's "re-asking is the defect" rule).
 *
 * `SetBasedSanction.person` is OPTIONAL in the schema (absent = a team
 * sanction) but BWF cards are shown to a player, so this sheet always fills it
 * where a person is knowable, and simply omits it for a side with no roster at
 * all — which is a legitimate state, not an error.
 *
 * `reason` (the free-text offence note the umpire's sheet carries) is NOT
 * collected: no text step kind exists, and inventing one for this sheet is a
 * chassis change, not a skin change. Same ruling tennis's own sanction sheet
 * records.
 */
function sanctionSheet(view: PadHostView, side: Side): GuidedSheetSpec {
  const state = asState(view.state);
  const players = onFieldPlayers(view.squads, side);
  const sole = players.length === 1 ? players[0]!.personId : null;
  const steps: GuidedSheetStep[] = [
    {
      id: "level",
      kind: "choice",
      title: "pad.badminton.sheet.sanction.level.title",
      options: SANCTION_LEVELS.map((level) => ({
        id: level,
        label: vocabKey("level", level) ?? level,
        tone: toneFor(level),
      })),
    },
  ];
  if (players.length > 1) {
    steps.push({
      id: "person",
      kind: "person",
      title: "pad.badminton.sheet.sanction.person.title",
      pool: "onfield",
      side,
      candidates: players.map((member) => member.personId),
    });
  }
  return {
    event: SANCTION_TYPE,
    steps,
    buildPayload: (answers) => {
      const person = answers.person ?? sole ?? undefined;
      return {
        by: entrantOf(state, side),
        level: answers.level,
        ...(person !== undefined && person !== null ? { person } : {}),
      };
    },
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {
    [SET_SCORE_TILE_ID]: setScoreSheet(view),
  };
  for (const side of SIDES) sheets[sanctionSheetKey(side)] = sanctionSheet(view, side);
  return sheets;
}

// ---------------------------------------------------------------------------
// dock() — RULING R5-2, and the wave's product headline.
//
// `badminton.rally` carries THREE padSpec actions on ONE wire type: the plain
// rally (`wonBy` only), the ATTRIBUTED rally (`wonBy` + `server` + `scorer`
// person pickers) and the expedite rally. Dedicating the type — which tap
// model S does automatically, because `dedicatedEventTypes` reads a tappable
// half's own `tapEvent.type` — retires all three from the More sheet, and with
// them the generic form's attribution FIELDS (R3.5). So if the dock does not
// ask for the scorer, per-player badminton stats become unrecordable on this
// pad, which would be a regression dressed as a redesign.
//
// The dock therefore carries the SCORER. The SERVER is derived and never
// asked: `buildHalf` stamps it at tap time for a singles side, and for a pair
// nobody can name it at all (BWF Law 10.5 reads the service court).
// ---------------------------------------------------------------------------

function scorerChip(personId: string, labelText: string): DockChip {
  return {
    id: `scorer:${personId}`,
    // A display NAME is not a dictionary key — routing one through `t()` fires
    // a missing-key warning on every render and only renders right by
    // accident. `labelText` is the pre-resolved slot for exactly this
    // (football's goal dock and tennis's point dock take the same posture).
    label: "pad.badminton.dock.person",
    labelText,
    mutate: (payload) => ({ ...payload, scorer: personId }),
  };
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  if (eventType !== RALLY_TYPE) return null;
  const state = asState(view.state);
  // Read from the PAYLOAD, not `view.state`: by the time the dock renders, the
  // optimistic fold has already advanced past the rally that opened it, so the
  // state cannot answer "which half was tapped" any more. `wonBy` is the whole
  // question here — tap model S means the half tapped IS the winning side, so
  // the winning PAIR is that side's on-field roster.
  const winner = typeof payload?.wonBy === "string" ? sideOfEntrant(state, payload.wonBy) : null;
  const scorer = typeof payload?.scorer === "string" ? payload.scorer : undefined;
  const title = t("pad.badminton.dock.rally.scorer.title");

  // SINGLES NEVER REACHES A DOCK — checked HERE, before the settled-scorer
  // branch, because that is where it was being lost.
  //
  // The guard used to sit only below, after `if (scorer !== undefined)`
  // returned. But `buildHalf` stamps `scorer` onto every SINGLES tap at tap
  // time, so a singles rally always arrives here with `scorer` already set and
  // returned early — meaning the dock opened on EVERY singles rally, titled
  // "Which player won it?", offering exactly one answer that was already
  // chosen. Not an edge case: it was every point of every singles match, the
  // format most badminton is played in. The harm is idempotent (the chip
  // re-stamps the same person) which is why nothing broke and nothing caught
  // it — `badminton.test.ts`'s own case is named "returns nothing" and then
  // asserts `.not.toBeNull()`, so the suite was pinning the defect in place.
  //
  // `winner === null` deliberately falls through rather than suppressing: an
  // unresolvable side cannot be shown to be singles, and swallowing the dock
  // on a resolution failure would lose a real doubles question.
  const winnerPair = winner === null ? null : onFieldPlayers(view.squads, winner);
  if (winnerPair !== null && winnerPair.length <= 1) return null;

  if (scorer !== undefined) {
    // One-way, and the alternatives leave (the chassis's own no-inverse rule):
    // once a scorer lands, the dock shows only that chip. A second tap
    // re-affirms the same value rather than offering the partner beside a
    // payload that already names someone.
    //
    // UNIT-TESTABLE AND UNIT-PROVABLE IS NOT ENOUGH HERE, and R3's goal dock
    // is the precedent: a pure builder whose output depends on the ADVANCED
    // payload can be fully green and fully inert at the same time, because
    // whether tapping a chip actually re-invokes this function with the
    // mutated payload is a `DetailDock`/`dockStore` re-render that a
    // node-environment test cannot exercise at all.
    // `e2e/scorepad-v3-badminton.spec.ts` carries that proof: it asserts the
    // scorer in the DRAINED, SUBMITTED event, not in this function's return.
    return { title, chips: [scorerChip(scorer, nameOf(view, scorer, t))] };
  }

  // Singles is already gone (the guard above), so anything reaching here with a
  // resolved winner is a genuine PAIR choice. A hand-built payload with no
  // resolvable side still lands here and gets no dock, same as before.
  if (winnerPair === null) return null;
  return {
    title,
    chips: winnerPair.map((member) => scorerChip(member.personId, nameOf(view, member.personId, t))),
  };
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half. Without it every
// `badminton.rally` row reads identically "Rally recorded", which is useless
// in a panel whose whole job is finding ONE rally to correct (R2 sign-off
// defect D2).
// ---------------------------------------------------------------------------

/** DE-DUPES, and that is not a nicety: in SINGLES `buildHalf` stamps the same
 *  personId as both `scorer` and `server` on every rally the server wins —
 *  roughly half of them — so the activity row read "Lin Dan · Lin Dan". A
 *  name repeated against itself tells a reader nothing and looks like a bug in
 *  the scoring, which for one rally in two is most of the log. Found in review
 *  of PR #678. Order-preserving: the first mention wins its position. */
function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  const unique = [...new Set(kept)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

export function badmintonDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;

  switch (eventType) {
    case RALLY_TYPE: {
      // A person first where one is known, because that is what a scorer
      // scans for when correcting a misattribution. Where NOBODY was
      // attributed, name the winning SIDE rather than returning nothing: an
      // unattributed rally is not an edge case — a doubles rally sent before the dock's scorer question is answered has no person on it, and a
      // ribbon of identical "Rally recorded" rows, each with its own Void
      // button, is how the wrong point gets voided at a scoring desk. Found
      // by reading the ribbon on a real 320px screen after five taps (R5).
      const people = join([named(payload.scorer), named(payload.server)]);
      if (people !== undefined) return people;
      const side = sideOfEntrant(state, payload.wonBy);
      return side ? t(SIDE_LABEL[side]) : undefined;
    }
    case SUMMARY_TYPE: {
      const home = payload.home;
      const away = payload.away;
      const score =
        typeof home === "number" && typeof away === "number" ? `${home}–${away}` : undefined;
      return join([score, payload.partial === true ? t("pad.badminton.ribbon.partial") : undefined]);
    }
    case SANCTION_TYPE:
      return join([
        vocabText("level", payload.level, t),
        named(payload.person),
        typeof payload.reason === "string" ? payload.reason : undefined,
      ]);
    case TIMEOUT_TYPE: {
      // R5 review: this case was MISSING, so the ribbon rendered a bare
      // "Time-out recorded" with no side, where both siblings name one
      // (`tabletennis.tsx`'s and `volleyball.tsx`'s own TIMEOUT_TYPE cases).
      // Not an unreachable path: `refusedEventTypes` reads `records.timeouts`
      // PER FIXTURE rather than hardcoding the type off, so any cfg that
      // records time-outs reaches this line.
      //
      // `payload.by` is an ENTRANT id — `ctx.state` (R3.5/Task E's own
      // addition to this contract) is what resolves it to a home/away side;
      // `ActivityDetailContext` carries no fold otherwise. Undefined (falling
      // back to the bare base copy) rather than a raw id when the side cannot
      // be resolved.
      const side = sideOfEntrant(state, payload.by);
      return side ? t(SIDE_LABEL[side]) : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
//
// EVERY builder that needs copy is threaded its `t` HERE, explicitly. None of
// them defaults the parameter, so a forgotten wrapper is a tsc error rather
// than a raw i18n key on a live pad — see this file's header for the incident
// that rule comes from, and `__tests__/badminton.test.ts`'s "factory wiring"
// block for the test that reds when a wrapper is dropped.
// ---------------------------------------------------------------------------

export function badmintonSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: SPORT,
    tapModel: "S",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    context: (view) => buildContextStrip(view, t),
    refusedEventTypes,
    activityDetail: badmintonDetail,
    // No swap()/contextSelect() — see this file's header.
  };
}
