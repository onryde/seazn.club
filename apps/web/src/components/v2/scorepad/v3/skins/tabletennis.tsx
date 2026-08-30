// Table tennis SkinDefV3 — R5/C2, tapModel S. Converts table tennis to the v3
// chassis (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// redesign-design.md` §2/§3, ruling R5-1..R5-5). Replaces
// `../../skins/racquet-skin.tsx` (v2) as TABLE TENNIS'S pad surface only —
// that file still serves volleyball, which converts in a later wave, so it
// stays on disk untouched.
//
// PURE DATA, no React — the same testability stance every v3 skin takes
// (apps/web vitest is `environment: "node"`, no jsdom). FACTORY, not a bare
// object: `ScorebugSpec.context`, `WhoLine.name` and `DockSpec.title` are
// pre-resolved TEXT, and no `SkinDefV3` method itself receives `t`
// (registry.ts's header carries the full reasoning). `t` IS REQUIRED
// EVERYWHERE, NEVER DEFAULTED — the cricket `buildTiles(view, t = (key) =>
// key)` incident this repo already paid for once
// (`reference_v3_labeltext_and_default_t_threading.md`).
//
// TABLE TENNIS IS NOT BADMINTON WITH A DIFFERENT PALETTE. Both share
// `sports/setbased`'s kernel, but the LAW is different at every branch this
// file touches, and copying badminton's derivations across would be
// plausible and wrong (R5-racquet-split.md's own pitfall list):
//
//  * `serve.within` is `"fixed-turns"` (ITTF 2.13.3), not `"rally-winner"`
//    (BWF 10.3). Badminton's rotation self-heals from the very next rally,
//    because `serving := winner` unconditionally after every rally. Table
//    tennis's rotation is a PURE FUNCTION OF THE SCORE once the set's first
//    server is known, and is NEVER updated by an individual rally's own
//    winner — so unlike badminton, this kernel genuinely cannot resolve the
//    serve at all without an anchor (`setBasedServeContext`'s own
//    `firstServer`), and that anchor does not arrive for free the way it
//    does for a side-out sport.
//  * `serverFromPairOrder: true` — unlike badminton, a table tennis DOUBLES
//    pair's own service order (ITTF 2.13.4) means the engine names a SERVER
//    PERSON in doubles, not merely a side.
//  * `acceleratesAtDeuce: true` (ITTF 2.13.3's own deuce clause) and the
//    ITTF Law 2.15 expedite system are both table tennis's alone; badminton
//    declares neither.
//
// D-17'S ANCHOR, AND WHY THIS FILE DECLARES A TILE FOR IT. R5-1's own
// project record is explicit: "table tennis needs [a declared server] once
// per match" — unlike badminton (whose rotation self-heals from any rally)
// or volleyball. Without an anchor, `believedServer` (kernel.ts) returns
// `null` FOREVER for this sport, however many rallies are tapped — so
// leaving the anchor undeclared would make "put serveNumber on the strip"
// (the wave brief's own words) hollow for every ordinary match. `serving`
// (`SetBasedRally`'s own optional field) is deliberately NEVER stamped onto
// the tapModel-S halves' own tap — see `buildHalf`'s doc for why that would
// defeat the engine's own drift detector — so the ONE tile this file adds,
// `SERVE_ANCHOR_TILE_ID`, is a SEPARATE, EXPLICIT, opt-in declaration: the
// umpire's own observation of who served AND who won one rally, recorded
// together because `serving` only exists on the `rally` event and a rally
// requires `wonBy`. It appears ONLY while the engine cannot already answer,
// and never ambushes an ordinary scoring tap.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `swap()`. `lineupPolicy: () => ({reentry: "none", ...})`
//     (`setbased/tabletennis.ts`) — S3/W4b (#426) ruling 2, the ITTF has no
//     substitute, the pair named on the sheet plays the match. No in-play
//     swap for this sport to declare, same stance badminton takes.
//   - `contextSelect()`. The one context slot this skin declares is
//     `readOnly` (D-7's recording notice), and a readOnly slot's picker can
//     never open (context-strip.tsx), so there is no selection for this
//     method to turn into an event.
"use client";
import type { SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import {
  tabletennis as tabletennisModule,
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

const SPORT = "tabletennis";
export const RALLY_TYPE = `${SPORT}.rally`;
/** The FULLY QUALIFIED coarse type, `${key}.${preset.coarseEventType}`
 *  (setbased/kernel.ts). The preset declares only the second half
 *  ("game.summary"); posting that bare half is a 422 INVALID_EVENT
 *  (`reference_gallery_racquet_capture_traps.md`, paid for building this
 *  wave's own gallery states). */
export const SUMMARY_TYPE = `${SPORT}.${tabletennisModule.coarseEventType}`;
export const SANCTION_TYPE = `${SPORT}.sanction`;
export const TIMEOUT_TYPE = `${SPORT}.timeout`;
export const SUB_TYPE = `${SPORT}.sub`;
export const EXPEDITE_TYPE = `${SPORT}.expedite.start`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/** The feature key table tennis's band 3 is gated behind —
 *  `setbased/tabletennis.ts`'s own `rallyEntitlement`, which the kernel
 *  publishes as `padSpec(cfg).fidelityEntitlements[3]`. RESTATED here rather
 *  than read off a live `padSpec` call, and
 *  `__tests__/tabletennis.test.ts` pins this constant EQUAL to the module's
 *  own value — badminton's identical pattern, and by design the identical
 *  STRING (both dossiers cite "doc 10" for tier-2/3 rally scoring). */
export const RALLY_ENTITLEMENT = "scoring.rally_by_rally";

/**
 * S7/#427 — the ITTF umpire's card ladder, in the order the sheet climbs it.
 * `setbased/tabletennis.ts`'s own `sanctionLevels` restated here so the
 * sheet's option order is a decision this file owns, and
 * `__tests__/tabletennis.test.ts` pins the two lists equal so they cannot
 * drift apart. ONLY TWO — the ITTF umpire has yellow and red, and no third:
 * `expulsion`/`disqualification` are the REFEREE removing a player, not a
 * card the umpire shows (DOMAIN.tabletennis.md, and
 * `reference_engine_domain_dossiers_miscite_laws.md`'s own caution about
 * trusting that file's LAW CITATIONS, not its factual claims about who holds
 * which card).
 */
export const SANCTION_LEVELS: readonly string[] = ["warning", "penalty"];

/** Same tone posture as badminton's ladder (`SANCTION_LEVEL_TONE`): a text
 *  ENUM, not a swatch, so `contrast.test.ts` holds it to the full 4.5:1 text
 *  floor. `penalty` fails through to `default` exactly as badminton's own
 *  three non-warning steps do — a partial map is deliberate, never an empty
 *  array standing in for "no tone". */
const SANCTION_LEVEL_TONE: Readonly<Partial<Record<string, readonly SportTone[]>>> = {
  warning: ["caution"],
  default: ["dismissal"],
};
function toneFor(level: string): readonly SportTone[] {
  return SANCTION_LEVEL_TONE[level] ?? SANCTION_LEVEL_TONE.default!;
}

/**
 * ITTF Law 2.15.2 — the receiver wins the point on their thirteenth good
 * return. The engine's own `EXPEDITE_RETURNS` constant (`setbased/kernel.ts`)
 * is NOT re-exported from the `@seazn/engine/sports/setbased` barrel this
 * file is limited to (`packages/engine/**` is DO-NOT-TOUCH for this task —
 * the reader is reviewed and merged; consume it, do not extend its exports).
 * Restated here, and pinned in `__tests__/tabletennis.test.ts` against a REAL
 * fold: a rally crediting the SERVING side their 13th-return win throws
 * `EXPEDITE_WRONG_WINNER` at this exact threshold and not one short of it —
 * the same "restate, then prove equal to the source of truth" posture
 * `RALLY_ENTITLEMENT`/`SANCTION_LEVELS` already take for a value this file
 * cannot import directly.
 */
export const EXPEDITE_RETURNS_THRESHOLD = 13;

/**
 * Event type -> fidelity band, MIRRORING `setBasedPadSpec`'s own `fidelity`
 * map (setbased/kernel.ts) rather than inventing a second scale — badminton's
 * `EVENT_BAND` takes the identical posture. The chassis filters tiles by this
 * table's engine-side twin (`filterTilesByBand` reads `PadSpec.fidelity`);
 * this copy exists so `buildTiles` can decline to DRAW an out-of-band tile in
 * the first place, an earlier and separate decision from the chassis's
 * safety filter.
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

interface TableTennisSetShape {
  home?: number;
  away?: number;
  closed?: boolean;
}
interface TableTennisRecordFlags {
  timeouts?: boolean;
  sanctions?: boolean;
  substitutions?: boolean;
  expedite?: boolean;
}
interface TableTennisCfgShape {
  bestOf?: number;
  setTo?: number;
  finalSetTo?: number;
  winBy?: number;
  cap?: number | null;
  records?: TableTennisRecordFlags;
}
interface TableTennisStateShape {
  cfg?: TableTennisCfgShape;
  entrants?: { home?: string; away?: string };
  phase?: string;
  sets?: TableTennisSetShape[];
  setsWon?: { home?: number; away?: number };
  squads?: SquadState;
  /** ITTF Law 2.15.1 — the umpire's own introduction of the expedite system.
   *  MATCH-scoped: `bankSet` never clears it (`kernel.ts`'s own comment). */
  expedite?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asState(state: unknown): TableTennisStateShape {
  return asRecord(state) as TableTennisStateShape;
}
function asCfg(cfg: unknown): TableTennisCfgShape {
  return asRecord(cfg) as TableTennisCfgShape;
}

/** The fixture's resolved config. Prefers the FOLD'S OWN copy
 *  (`SetBasedState.cfg`, what `apply` actually ran against) and falls back to
 *  `PadHostView.cfg` only for a pad mounted before any fold exists — the
 *  identical precedent badminton's own `cfgOf` sets. */
function cfgOf(view: PadHostView): TableTennisCfgShape {
  const folded = asState(view.state).cfg;
  return folded !== undefined ? folded : asCfg(view.cfg);
}

function readPhase(state: TableTennisStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

function entrantOf(state: TableTennisStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: TableTennisStateShape, entrantId: unknown): Side | null {
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
// phase() — OPT-IN (G3). `SetBasedState.phase` is `pre|live|done|final|
// abandoned`, mapped down onto `PadPhase`'s closed three exactly as
// badminton's own `resolvePhase` does.
// ---------------------------------------------------------------------------

const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

// ---------------------------------------------------------------------------
// The open game, and its score. Same reading as badminton's `openGame`:
// `SetBasedState.sets` is "closed sets in order + at most one trailing open
// set", so a finished game never reports as live.
// ---------------------------------------------------------------------------

interface OpenGame {
  home: number;
  away: number;
  index: number;
}

function openGame(state: TableTennisStateShape): OpenGame | null {
  const sets = state.sets ?? [];
  const index = sets.length - 1;
  const set = sets[index];
  if (set === undefined || set.closed === true) return null;
  return { home: set.home ?? 0, away: set.away ?? 0, index };
}

/** Points a side has in the game the board is resting on — the open game
 *  while one is open, otherwise the LAST GAME PLAYED. Returning 0 with no
 *  game open (review of PR #678, finding 5) meant a DECIDED match showed 0 as
 *  the biggest number on the screen, with only the small games strip carrying
 *  the result. 0 survives for the one true case: no games played at all. */
function pointsOf(state: TableTennisStateShape, side: Side): number {
  const open = openGame(state);
  if (open !== null) return open[side];
  const sets = state.sets ?? [];
  const last = sets[sets.length - 1];
  return last?.[side] ?? 0;
}

/** `applySummary`'s strict branch (kernel.ts): a game with ANY point already
 *  recorded is being scored rally-by-rally, and the fold refuses a summary
 *  for it. Consumed by BOTH `buildTiles` (withholds the Set score tile) and
 *  `refusedEventTypes` (withholds the generic More form) — one predicate,
 *  the badminton precedent this file mirrors. */
function gameInProgress(state: TableTennisStateShape): boolean {
  const open = openGame(state);
  return open !== null && (open.home > 0 || open.away > 0);
}

/**
 * ITTF 2.15.1's own floor: 9 points, BOTH sides, in the game being played.
 *
 * Not derived from `setTo` — 9 is written into the law as a number, alongside
 * the ten minutes, and it does not scale with a shortened variant the way an
 * interval mark does. A hardbat-21 game reaching 9-9 is the same "both sides
 * are scoring freely, the system is not needed" judgement the law is making.
 *
 * Reads the OPEN game only: expedite is declared during play, and a closed
 * game's final score says nothing about whether the current one is stuck.
 */
const EXPEDITE_SCORE_FLOOR = 9;

function bothReachedExpediteFloor(state: TableTennisStateShape): boolean {
  const open = openGame(state);
  if (open === null) return false;
  return open.home >= EXPEDITE_SCORE_FLOOR && open.away >= EXPEDITE_SCORE_FLOOR;
}

function gameNumber(state: TableTennisStateShape): number {
  const sets = state.sets ?? [];
  const open = openGame(state);
  return open === null ? sets.length + 1 : open.index + 1;
}

/** `setTarget` (kernel.ts) — the deciding game may run to `finalSetTo`. */
function targetOf(cfg: TableTennisCfgShape, gameIndex: number): number {
  const bestOf = cfg.bestOf ?? 5;
  const setTo = cfg.setTo ?? 11;
  return gameIndex === bestOf - 1 ? (cfg.finalSetTo ?? setTo) : setTo;
}

/** `summaryScoreBound` (kernel.ts) — the cfg-derived plausibility ceiling for
 *  the Set score sheet's two number fields. Table tennis ships with `cap:
 *  null` (uncapped — ITTF deuce runs indefinitely, 12-10, 15-13, …), so this
 *  reads the same margin-past-target fallback badminton's uncapped branch
 *  uses; a custom cfg that DOES set a cap is honoured, never assumed absent. */
function scoreBound(cfg: TableTennisCfgShape): number {
  const cap = cfg.cap;
  if (typeof cap === "number") return cap;
  return Math.max(cfg.setTo ?? 11, cfg.finalSetTo ?? 11) + 20;
}

// ---------------------------------------------------------------------------
// Serving — CONSUMED from the engine (R5-1), never re-derived here. Same
// shim pattern badminton's own `serveInput` establishes; see that file's doc
// for the full reasoning on every field this shim populates.
// ---------------------------------------------------------------------------

function serveInput(view: PadHostView, state: TableTennisStateShape): SetBasedState | null {
  const cfg = state.cfg;
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
    // `serverFromPairOrder: true` — UNLIKE badminton, table tennis's own
    // reader genuinely reads this to name a doubles server (ITTF 2.13.4), so
    // omitting it here would be wrong rather than merely unused.
    squads: view.squads,
  };
  return shim as SetBasedState;
}

/**
 * Who is serving the next rally, or `null` when the engine will not say.
 * Consumes the SAME reader badminton's `serveContextOf` does, over table
 * tennis's own preset — `serveOrderKnown === false` renders NOTHING, never a
 * placeholder (D-17).
 */
export function serveContextOf(
  view: PadHostView,
  state: TableTennisStateShape,
): SetBasedServeContext | null {
  const input = serveInput(view, state);
  if (input === null) return null;
  return setBasedServeContext(tabletennisModule, input, view.events);
}

/** The starting roster for one side, first-named first (pairOrder, falling
 *  back to team-sheet order) — identical to badminton's `onFieldPlayers`. */
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

/** "The only member" of a SINGLES side — an identity, never a derivation
 *  (badminton's own `soleMemberOf`, restated here identically). Table tennis
 *  needs it too: the engine's own `serverFromPairOrder` answer is `null`
 *  whenever the squad is not EXACTLY two (`SERVE_PAIR_SIZE`, kernel.ts), so a
 *  singles side still needs this fallback despite the preset naming a
 *  doubles server. */
function soleMemberOf(squads: SquadState, side: Side): string | null {
  const players = onFieldPlayers(squads, side);
  return players.length === 1 ? (players[0]?.personId ?? null) : null;
}

interface ServingInfo {
  side: Side;
  personId: string | null;
}

function servingInfo(view: PadHostView, state: TableTennisStateShape): ServingInfo | null {
  const ctx = serveContextOf(view, state);
  // ONE guard, deliberately — `SetBasedServeContext`'s own documented
  // invariant is `serveOrderKnown === (servingSide !== null)`, and a second
  // check on `serveOrderKnown` here would be a pair no mutation can tell
  // apart (`reference_redundant_guard_pair_is_mutation_unkillable.md`, paid
  // for on badminton's own equivalent). The invariant is asserted directly,
  // against the real engine, in `__tests__/tabletennis.test.ts`.
  if (ctx === null || ctx.side === null) return null;
  const side = ctx.side;
  return { side, personId: ctx.serverPersonId ?? soleMemberOf(view.squads, side) };
}

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel S.
// ---------------------------------------------------------------------------

/** "Best of 5 · Game 2", plus the endgame the ITTF has words for. `Deuce` is
 *  2.13.3's own clause — one short of the target on both sides — DERIVED
 *  from the game's own cfg-resolved target, never hardcoded at 10: the
 *  hardbat-21 variant (setTo/finalSetTo: 21) must accelerate at 20-all off
 *  the SAME code path, which is exactly what `targetOf` gives for free.
 *  Golden point mirrors badminton's own capped-endgame wording for a custom
 *  cfg that sets a cap — table tennis ships uncapped, but the schema
 *  genuinely allows one, and this reads it rather than assuming it absent. */
function buildContext(state: TableTennisStateShape, cfg: TableTennisCfgShape, t: TFn): string {
  const bestOf = cfg.bestOf ?? 5;
  // CLAMPED to `bestOf`. `gameNumber` is "closed games plus one", which is what makes
  // "Game 2" appear the instant game 1 banks — correct while a match is
  // live, and wrong the moment it ends: every game is then closed, so a
  // decided best-of-5 board announced "Game 6", a game nobody played.
  // The scorebug renders its context line in EVERY phase (`scorebug.tsx`) and
  // `pad-host.tsx` renders the scorebug in "post", so the decided board is a
  // real screen a scorer reads, not a transient. Found in review of PR #678.
  // Clamping to `bestOf` removed "Game 6" but not the class: a best-of-5 won
  // 3-0 has THREE games in the book and `gameNumber` (closed + 1) says 4 — a
  // game nobody played, which `Math.min` cannot see because 4 <= bestOf.
  // Once the match is over the board names the LAST game played.
  const played = (state.sets ?? []).length;
  const decided = POST_PHASES.has(readPhase(state));
  const game = decided ? Math.max(played, 1) : Math.min(gameNumber(state), bestOf);
  const base = t("pad.tabletennis.context.line", { bestOf, game });
  const open = openGame(state);
  if (open === null || open.home !== open.away) return base;
  const cap = cfg.cap;
  if (typeof cap === "number" && open.home === cap - 1) {
    return `${base} · ${t("pad.tabletennis.context.goldenPoint")}`;
  }
  const target = targetOf(cfg, gameNumber(state) - 1);
  // `>=`, not `===`. ITTF 2.13.3's win-by-two stays in force at EVERY
  // subsequent tie, and the kernel agrees — `accelerateFromNow()` is a floor,
  // not an equality. The exact test showed "Deuce" at 10-10 and then dropped
  // it at 11-11, 12-12, 13-13, which is precisely where a scorer needs the
  // reminder most. Found in review of PR #678.
  if (open.home >= target - 1) return `${base} · ${t("pad.tabletennis.context.deuce")}`;
  return base;
}

function buildHalf(
  view: PadHostView,
  state: TableTennisStateShape,
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
          return {
            name: nameOf(view, member.personId, t),
            ...(isServing ? { serving: true, servingLabel: t("pad.tabletennis.scorebug.serving") } : {}),
          };
        })
      : [{ name: t(SIDE_LABEL[side]) }]; // defensive: assertScorebugSpec requires a non-empty `who`

  // Band 3 gate: `tabletennis.rally` IS a band-3 event, so below it a
  // tappable half would be a dead-end tap.
  const tappable = resolvePhase(view) === "live" && view.band >= 3;
  // R5-2 — SINGLES AUTO-SET, badminton's own precedent: a length-1 side has
  // nothing to choose, so its sole member IS whoever won the rally, stamped
  // INTO the tap. A pair is left for the dock's own question (`buildDock`).
  const soleScorer = players.length === 1 ? players[0]?.personId : undefined;
  // The SERVER, as a PERSON, for the `serves` playerStats metric
  // (setbased/tabletennis.ts declares one) — safe to stamp on EVERY tap
  // regardless of side, because it feeds a stats tally only
  // (`creditPersons`, kernel.ts) and nothing validates or drift-checks it.
  // NOT the same field as `SetBasedRally.serving` below.
  const server = serving && serving.personId !== null ? serving.personId : undefined;
  return {
    who,
    big: String(pointsOf(state, side)),
    tappable,
    ...(tappable
      ? {
          hintKey: "pad.tabletennis.scorebug.rally.hint",
          tapEvent: {
            type: RALLY_TYPE,
            payload: {
              wonBy: entrantOf(state, side),
              // `SetBasedRally.serving` (the SIDE that served this rally) is
              // deliberately ABSENT from the ordinary scoring tap. It is the
              // umpire's own independent observation and
              // `setBasedServeWalk` uses it as a drift detector against its
              // own belief (kernel.ts) — a pad that filled it in from
              // `serveContextOf`'s own answer would make the detector
              // compare a derivation with itself and agree forever, exactly
              // the trap badminton's identical omission avoids. Unlike
              // badminton, table tennis genuinely needs this fact declared
              // SOMEWHERE (`fixed-turns` never self-heals the way side-out
              // does) — `SERVE_ANCHOR_TILE_ID` below is that declaration, a
              // separate and explicit surface rather than an ambush on every
              // ordinary tap.
              ...(server !== undefined ? { server } : {}),
              ...(soleScorer !== undefined ? { scorer: soleScorer } : {}),
            },
          },
        }
      : {}),
  };
}

/**
 * THE STRIP IS THE UMPIRE'S CALL — badminton's own R5-3 discipline, and it
 * holds for table tennis too: games standing, who is serving, and WHICH
 * serve of the turn (1st/2nd — ITTF 2.13.3, a fact this sport alone among
 * the three R5 racquet sports has to say). Expedite is added, live only,
 * once the umpire has introduced it (2.15.1) — a genuinely new fact this
 * sport alone carries.
 *
 * NOTHING ON THIS STRIP TAKES `tone: "led"`, matching badminton's ruling
 * (R5-3/R4-4): the chassis already spends `--sport-led` on the serve pip,
 * the score digits and the board's top hairline — a strip item claiming it
 * too would be a second thing shouting.
 */
function buildStrip(
  view: PadHostView,
  state: TableTennisStateShape,
  phase: PadPhase,
  serving: ServingInfo | null,
  serveCtx: SetBasedServeContext | null,
  t: TFn,
): StripItem[] {
  const items: StripItem[] = [
    {
      id: "games",
      label: t("pad.tabletennis.scorebug.strip.games"),
      value: `${state.setsWon?.home ?? 0}–${state.setsWon?.away ?? 0}`,
    },
  ];
  // OMITTED, never rendered stale — D-17's whole point, badminton's own
  // posture: the engine's own `serveOrderKnown` is the verdict.
  if (serving) {
    const value = serving.personId ? nameOf(view, serving.personId, t) : t(SIDE_LABEL[serving.side]);
    items.push({ id: "server", label: t("pad.tabletennis.scorebug.strip.server"), value, accent: true });
    // ITTF 2.13.3 — which serve of the current turn comes next, 1-based.
    // Present only while the reader's chain is unbroken (kernel.ts's own
    // `chainComplete` gate on `serveNumber`), so a mid-set drift omits this
    // exactly as it omits the server name.
    if (serveCtx?.serveNumber !== undefined) {
      // No label, and the value is a COMPLETE PHRASE — badminton's own
      // `serviceCourt` established this in the same family and for the same
      // reason: a "Serve: 2nd" pairing reads as a table cell, not as something
      // an umpire would say, and the chassis renders `label` and `value`
      // concatenated in that order. In English that produced "Serve 2nd",
      // which is not English. Carrying the whole phrase in the value also lets
      // each locale order the noun and the ordinal its own way — es/fr/nl put
      // the noun first, English does not.
      items.push({
        id: "serve",
        value: t(serveCtx.serveNumber === 1 ? "pad.tabletennis.scorebug.strip.serve.first" : "pad.tabletennis.scorebug.strip.serve.second"),
      });
    }
  }
  // Live only. ITTF 2.15.1 — the umpire's own introduction of expedite, in
  // force for the rest of the match (2.15.4) once given.
  if (phase === "live" && state.expedite === true) {
    items.push({ id: "expedite", value: t("pad.tabletennis.scorebug.strip.expedite") });
  }
  return items;
}

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const serving = servingInfo(view, state);
  const serveCtx = serving ? serveContextOf(view, state) : null;
  const phase = resolvePhase(view);
  return {
    context: buildContext(state, cfg, t),
    phase,
    halves: [buildHalf(view, state, "home", serving, t), buildHalf(view, state, "away", serving, t)],
    strip: buildStrip(view, state, phase, serving, serveCtx, t),
  };
}

// ---------------------------------------------------------------------------
// context() — D-7's explanation, badminton's exact mechanism. The chassis
// has no locked-tile path for a band GAP, so the explanation has to be
// authored; see badminton.tsx's own header for the full reasoning this file
// does not repeat.
// ---------------------------------------------------------------------------

function rallyOutOfBand(view: PadHostView): boolean {
  return view.band < 3;
}

export function buildContextStrip(view: PadHostView, t: TFn): ContextStripSpec | null {
  if (resolvePhase(view) !== "live" || !rallyOutOfBand(view)) return null;
  return {
    slots: [
      {
        id: "recording",
        label: "pad.tabletennis.context.recording",
        pool: "onfield",
        required: false,
        readOnly: true,
        message: t("pad.tabletennis.context.recording.locked", {
          plan: planLabel(featurePlan(RALLY_ENTITLEMENT)),
        }),
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
export function timeoutTileId(side: Side): string {
  return `timeout-${side}`;
}

export const RALLY_LOCKED_TILE_ID = "rallyLocked";
export const SET_SCORE_TILE_ID = "setScore";
export const EXPEDITE_START_TILE_ID = "expediteStart";
export const SERVE_ANCHOR_TILE_ID = "serveAnchor";

/** This FIXTURE's own record flags, from the fold's cfg. Per-fixture, never
 *  the preset's declared defaults (S6/#416, the beach-volleyball regression)
 *  — badminton's own `recordsFlag` restated identically. */
function recordsFlag(view: PadHostView, flag: keyof TableTennisRecordFlags): boolean {
  return cfgOf(view).records?.[flag] === true;
}

/**
 * Whether the "note the server" declaration is worth offering right now —
 * the reader cannot say who is serving AND a fresh declaration could
 * actually resolve it. Two `unknownBecause` reasons are excluded on purpose:
 * `recorded-disagrees` (R4-7's own rule — the engine deliberately refuses to
 * re-anchor off a declaration mid-dispute; the NEXT set resolves it, not a
 * same-set redeclaration) and `ledger-mismatch` (a structural disagreement
 * between the ledger and the folded state, which no new event fixes).
 * `match-over` is excluded by the outer `live` gate already.
 */
function needsServeAnchor(view: PadHostView, state: TableTennisStateShape): boolean {
  const ctx = serveContextOf(view, state);
  if (ctx === null || ctx.side !== null) return false;
  return ctx.unknownBecause !== "recorded-disagrees" && ctx.unknownBecause !== "ledger-mismatch";
}

export function buildTiles(view: PadHostView, t: TFn): TileSpec[] {
  const state = asState(view.state);
  const live = resolvePhase(view) === "live";
  const band = view.band;
  const offerable = (eventType: string): boolean => live && withinBand(eventType, band);
  const tiles: TileSpec[] = [];

  // ORDER IS LOAD-BEARING (`reference_v3_board_two_lanes_and_dock_after_
  // sheet.md`) — every side-paired block is pushed FIRST and as an atomic
  // 0-or-2 unit, so home is always column 0 and away always column 2 in
  // every band/phase combination. Sanctions and Timeouts are each such a
  // block; Set score, Expedite start and the serve anchor carry no side
  // identity and are pushed only after both pairs.

  // Sanctions — a MINOR row, per side. `SetBasedSanction.by` is REQUIRED, so
  // the side is fixed by WHICH tile was tapped.
  if (offerable(SANCTION_TYPE) && recordsFlag(view, "sanctions")) {
    for (const side of SIDES) {
      tiles.push({
        id: sanctionSheetKey(side),
        label: "pad.tabletennis.action.sanction",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { sheet: sanctionSheetKey(side) },
      });
    }
  }

  // Timeouts — table tennis's own difference from badminton: the ITTF
  // sheet carries one timeout per player per match (`records.timeouts`
  // defaults `true`). `SetBasedTimeout` is `{by, technical?}` and `technical`
  // is an FIVB-only concept (an automatic volleyball timeout at 8/16) this
  // sport's own laws have no notion of, so it is never set here — a direct
  // event, no sheet, mirroring tennis's own zero-field "Award game" tiles.
  if (offerable(TIMEOUT_TYPE) && recordsFlag(view, "timeouts")) {
    for (const side of SIDES) {
      tiles.push({
        id: timeoutTileId(side),
        label: "pad.tabletennis.action.timeout",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { event: { type: TIMEOUT_TYPE, payload: { by: entrantOf(state, side) } } },
      });
    }
  }

  // Set score — the band-0 action that survives at every band. Withheld
  // while the CURRENT game is being scored rally-by-rally; the paired
  // `refusedEventTypes` entry keeps the generic More sheet from offering the
  // same refused action again.
  if (offerable(SUMMARY_TYPE) && !gameInProgress(state)) {
    tiles.push({
      id: SET_SCORE_TILE_ID,
      label: "pad.tabletennis.action.setScore",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: SET_SCORE_TILE_ID },
    });
  }

  // Start expedite — ITTF 2.15.1, a direct event (empty payload,
  // `SetBasedExpediteStart` is `z.strictObject({})`). Hidden once already in
  // force, mirroring the kernel's own padSpec gate
  // (`state.expedite` truthy) — 2.15.4 runs it to the end of the match, so a
  // second declaration only errors.
  //
  // ALSO hidden at 9-all-or-better, which is the second half of 2.15.1: the
  // system comes in after ten minutes of play "unless both players or pairs
  // have scored at least 9 points". The gate used to carry no score term at
  // all, so one tap put a legal-looking match irreversibly into expedite from
  // any score — 2.15.4 keeps it there to the end of the MATCH, `applyExpedite`
  // refuses only a second start, and the only recovery is voiding the event.
  // Hidden rather than shown-and-disabled, matching the "already in force"
  // branch immediately above it: there is no action to offer, so offering a
  // dead one would be furniture.
  //
  // The TEN-MINUTE half of 2.15.1 is still unenforced and cannot be enforced
  // here — this pad folds no game clock (the kernel holds no elapsed time at
  // all). Recorded as owed in `_INDEX.md` rather than left as an unstated gap;
  // the score half is enforceable today and is enforced today.
  if (
    offerable(EXPEDITE_TYPE) &&
    recordsFlag(view, "expedite") &&
    state.expedite !== true &&
    !bothReachedExpediteFloor(state)
  ) {
    tiles.push({
      id: EXPEDITE_START_TILE_ID,
      label: "pad.tabletennis.action.expediteStart",
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { event: { type: EXPEDITE_TYPE, payload: {} } },
    });
  }

  // The serve anchor — D-17's declaration, table tennis's own requirement
  // (this file's header). Visible ONLY while the engine cannot already
  // answer and a declaration could resolve it; gone the moment it does.
  if (offerable(RALLY_TYPE) && needsServeAnchor(view, state)) {
    tiles.push({
      id: SERVE_ANCHOR_TILE_ID,
      label: "pad.tabletennis.action.serveAnchor",
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { sheet: SERVE_ANCHOR_TILE_ID },
    });
  }

  // D-7 — THE SILENCE, GIVEN A FACE. Badminton's exact mechanism: VISIBLE,
  // disabled, span-4, paired with the context slot above which carries the
  // sentence (`assertDisabledTilesExplained`, tile-grid.tsx).
  //
  // THE ACTION IS `MORE_SHEET_KEY` FOR A STRUCTURAL REASON. `filterTilesByBand`
  // resolves a tile's event type and drops the tile when that type's band
  // exceeds the org's — so a tile pointing at `tabletennis.rally` in ANY
  // form would be filtered out by the very gate it exists to explain.
  // `MORE_SHEET_KEY` is the one action value `tileEventType` resolves to
  // `null` BY NAME (pad-host.tsx), the "unclassifiable, therefore kept"
  // branch. `disabled: true` makes the tap inert regardless.
  if (live && rallyOutOfBand(view)) {
    tiles.push({
      id: RALLY_LOCKED_TILE_ID,
      label: "pad.tabletennis.action.rally",
      labelText: t("pad.tabletennis.tile.rallyLocked"),
      sublabelText: t("pad.tabletennis.tile.rallyLocked.sublabel"),
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

/**
 * `SkinDefV3.refusedEventTypes` — the More sheet's SECOND exclusion set,
 * badminton's exact shape with table tennis's own record flags:
 *
 *  - `game.summary`, while the current game already has a point —
 *    `applySummary`'s strict branch refuses it outright. THE ONLY DEFENCE.
 *  - `timeout` / `sub` / `expedite.start`, whenever THIS FIXTURE's cfg says
 *    it does not record them. Read PER FIXTURE, off the fold's own cfg —
 *    never off the preset's declared defaults, because `records` is a real
 *    per-fixture cfg knob (S6/#416). `substitutions` defaults `false` for
 *    every shipped table tennis config (the ITTF has no substitute) but a
 *    custom cfg could legitimately flip it, and refusing it unconditionally
 *    would block an action the fold would have accepted — the identical
 *    trap `refusedEventTypes` closed for badminton's own `timeouts` flag.
 *    `timeout`/`expedite` are DEFENCE IN DEPTH here (this skin already
 *    builds no tile for them when the flag is off); `sub` is the only
 *    defence, since no tile for it exists at all.
 */
export function refusedEventTypes(view: PadHostView): string[] {
  const state = asState(view.state);
  const refused: string[] = [];
  if (gameInProgress(state)) refused.push(SUMMARY_TYPE);
  if (!recordsFlag(view, "timeouts")) refused.push(TIMEOUT_TYPE);
  if (!recordsFlag(view, "substitutions")) refused.push(SUB_TYPE);
  // The expedite tile and this list must agree, or hiding the tile only moves
  // the illegal action into the More sheet — the same "one predicate, both
  // places" rule `gameInProgress` above is written to. `state.expedite` is
  // included here for the same reason: a second declaration is an engine
  // refusal, and the More sheet was the one surface still offering it.
  if (
    !recordsFlag(view, "expedite") ||
    state.expedite === true ||
    bothReachedExpediteFloor(state)
  ) {
    refused.push(EXPEDITE_TYPE);
  }
  return refused;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), the standing
// convention every v3 skin's `sheets` takes.
// ---------------------------------------------------------------------------

/** The Set score sheet — badminton's exact shape: two numbers, prefilled
 *  from the CURRENT open game. Titled "Points", not "Games": table tennis's
 *  `game.summary` scores POINTS within one game, the same two-level
 *  hierarchy badminton's own coarse event carries (unlike tennis's
 *  three-level points -> games -> sets, whose own sheet is titled "Games"
 *  for exactly that reason). */
function setScoreSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
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
        title: t("pad.tabletennis.sheet.setScore.home.title"),
        initial: open?.home ?? 0,
        min: 0,
        max: bound,
      },
      {
        id: "away",
        kind: "number",
        title: t("pad.tabletennis.sheet.setScore.away.title"),
        initial: open?.away ?? 0,
        min: 0,
        max: bound,
      },
    ],
    buildPayload: (answers) => ({ home: Number(answers.home ?? 0), away: Number(answers.away ?? 0) }),
  };
}

/** The sanction sheet, per side — badminton's exact shape, ITTF's own
 *  two-step ladder. `reason` is free text with no text step in this
 *  chassis, so it is not collected, same ruling badminton and tennis both
 *  record for their own sanction sheets. */
function sanctionSheet(view: PadHostView, side: Side, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const players = onFieldPlayers(view.squads, side);
  const sole = players.length === 1 ? players[0]!.personId : null;
  const steps: GuidedSheetStep[] = [
    {
      id: "level",
      kind: "choice",
      title: t("pad.tabletennis.sheet.sanction.level.title"),
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
      title: t("pad.tabletennis.sheet.sanction.person.title"),
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

/**
 * The serve anchor sheet — D-17's declaration, unique to this sport among
 * the three R5 racquet skins (this file's header explains why). Two choice
 * steps, EACH asked because `serving` and `wonBy` are independent facts
 * (serving and winning a rally are different things) and both are required
 * on the wire — there is no partial declaration to send. Attribution is
 * stamped the SAME way `buildHalf` stamps an ordinary tap: `server`/`scorer`
 * for a singles side, never asked for a pair (nothing changes about R5-2's
 * own rule just because this rally arrived through a sheet).
 */
function serveAnchorSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const options = SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] }));
  return {
    event: RALLY_TYPE,
    steps: [
      { id: "serving", kind: "choice", title: t("pad.tabletennis.sheet.serveAnchor.serving.title"), options },
      { id: "wonBy", kind: "choice", title: t("pad.tabletennis.sheet.serveAnchor.wonBy.title"), options },
    ],
    buildPayload: (answers) => {
      const servingSide: Side = answers.serving === "away" ? "away" : "home";
      const winnerSide: Side = answers.wonBy === "away" ? "away" : "home";
      const server = soleMemberOf(view.squads, servingSide);
      const scorer = soleMemberOf(view.squads, winnerSide);
      return {
        wonBy: entrantOf(state, winnerSide),
        serving: entrantOf(state, servingSide),
        ...(server !== null ? { server } : {}),
        ...(scorer !== null ? { scorer } : {}),
      };
    },
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {
    [SET_SCORE_TILE_ID]: setScoreSheet(view, t),
    [SERVE_ANCHOR_TILE_ID]: serveAnchorSheet(view, t),
  };
  for (const side of SIDES) sheets[sanctionSheetKey(side)] = sanctionSheet(view, side, t);
  return sheets;
}

// ---------------------------------------------------------------------------
// dock() — RULING R5-2, badminton's exact scorer pattern, PLUS this sport's
// own expedite enrichment.
//
// `${key}.rally` carries THREE padSpec actions on ONE wire type (the plain
// rally, the ATTRIBUTED rally, and — table tennis's own third shape — the
// EXPEDITE rally, `wonBy`+`serving`+`returns`). Dedicating the type (tap
// model S) retires all three from the More sheet, and with them the generic
// form's `returns` field — so without this dock, table tennis's own
// expedite system would be silently unrecordable, the exact FP-2 shape this
// wave's own false-premises section warns about. The RETURNS chip below is
// the recovery: it never touches `serving` (that fact is the serve anchor's
// job, above, and re-deriving it here at dock-render time — after the
// optimistic fold has already advanced past this rally — would risk crediting
// the wrong winner, `EXPEDITE_WRONG_WINNER`).
//
// The sentence that used to end that paragraph — "so it is always safe to
// offer regardless of who won: ... never an engine refusal" — was FALSE, and
// was written rather than executed. Folding the pad's own two payloads proves
// it: when the serve anchor HAS supplied `serving` and the SERVING side won,
// stamping `returns: 13` makes `kernel.ts`'s `checkExpedite` throw
// `EXPEDITE_WRONG_WINNER` (ITTF 2.15.4 — the receiver takes the point on their
// 13th good return, so a 13-return rally cannot credit the server). The throw
// rejects the WHOLE rally: the scorer answered two questions correctly, tapped
// the chip the pad itself offered, and lost the point and the serve fact with
// no explanation. `expediteOfferable` below is the gate — the pad now declines
// to ask a question whose only answer it would refuse.
// ---------------------------------------------------------------------------

function scorerChip(personId: string, labelText: string): DockChip {
  return {
    id: `scorer:${personId}`,
    label: "pad.tabletennis.dock.person",
    labelText,
    mutate: (payload) => ({ ...payload, scorer: personId }),
  };
}

/**
 * Whether the 13th-return question may be ASKED of this rally.
 *
 * Three states, and they are not the same question:
 *
 *  - serve UNKNOWN — offer it. `checkExpedite` cannot compare a receiver it
 *    does not have, so it counts the rally in `expediteUnchecked` and lets it
 *    stand; that is the coarse tier working as designed, not a defect. The
 *    dock says so in its title rather than implying a check that never ran.
 *  - serve KNOWN, the RECEIVER won — offer it. This is the only shape ITTF
 *    2.15.4 describes, and the only one the fold accepts.
 *  - serve KNOWN, the SERVER won — DO NOT offer it. The fold would throw and
 *    take the whole rally with it.
 *
 * `winner === null` falls through to offering: an unresolvable winner is
 * already a rally this dock cannot reason about, and withholding the question
 * there would lose a legitimate expedite answer to a resolution failure.
 */
function expediteOfferable(
  state: TableTennisStateShape,
  payload: Record<string, unknown> | undefined,
  winner: Side | null,
): boolean {
  const serving = typeof payload?.serving === "string" ? payload.serving : undefined;
  if (serving === undefined || winner === null) return true;
  return sideOfEntrant(state, serving) !== winner;
}

/** Whether the fold will actually be able to CHECK the answer — false when the
 *  serve side is unknown, which is what titles the question honestly. */
function expediteChecked(payload: Record<string, unknown> | undefined): boolean {
  return typeof payload?.serving === "string";
}

function expediteReturnChip(): DockChip {
  return {
    id: "expediteReturn",
    label: "pad.tabletennis.dock.rally.expedite.chip",
    mutate: (payload) => ({ ...payload, returns: EXPEDITE_RETURNS_THRESHOLD }),
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
  const winner = typeof payload?.wonBy === "string" ? sideOfEntrant(state, payload.wonBy) : null;
  const scorer = typeof payload?.scorer === "string" ? payload.scorer : undefined;
  const returns = typeof payload?.returns === "number" ? payload.returns : undefined;

  // Step 1 — R5-2's scorer question, badminton's exact rule: only a genuine
  // PAIR choice opens it; a singles side already stamped its sole scorer at
  // tap time (`buildHalf`) and has nothing left to ask here.
  if (scorer === undefined && winner !== null) {
    const pair = onFieldPlayers(view.squads, winner);
    if (pair.length > 1) {
      return {
        title: t("pad.tabletennis.dock.rally.scorer.title"),
        chips: pair.map((member) => scorerChip(member.personId, nameOf(view, member.personId, t))),
      };
    }
  }

  // Step 2 — the expedite return count, offered once the scorer question (if
  // any) is settled, for as long as this rally has not already flagged it AND
  // the fold would accept the answer (`expediteOfferable`, above).
  if (state.expedite === true && returns === undefined && expediteOfferable(state, payload, winner)) {
    return {
      title: t(
        expediteChecked(payload)
          ? "pad.tabletennis.dock.rally.expedite.title"
          : "pad.tabletennis.dock.rally.expedite.unchecked.title",
      ),
      chips: [expediteReturnChip()],
    };
  }

  // Step 3 — EVERY question settled, and the dock STAYS OPEN showing the
  // answers, exactly as badminton's does. Falling through to `null` here was a
  // real defect, found by driving a doubles fixture rather than by any
  // assertion: the moment the scorer tapped a chip the whole dock vanished,
  // taking with it both the confirmation of what they had just chosen and the
  // "Send now" control — the only way to commit before the hold expires. A
  // scorer moving between this pad and badminton's would have met two
  // different behaviours for the same gesture.
  //
  // The rule is ONE QUESTION ASKED, ONE ANSWER SHOWN — never "was it a pair?".
  // The first cut of this fix gated the whole branch on `pair.length > 1`,
  // reasoning that a singles side has no scorer to ask for (true: `buildHalf`
  // stamps its sole scorer at tap time). But step 2 asks a second question
  // that has nothing to do with pairs — the ITTF expedite return count — so
  // under expedite a SINGLES scorer answered a real question and watched the
  // dock and its "Send now" vanish anyway, and a DOUBLES scorer got the
  // scorer chip back with no confirmation of the expedite answer at all. Both
  // are the same defect this step exists to close, so each answered question
  // contributes its own chip and the pair test only gates the scorer's.
  const settled: DockChip[] = [];
  if (scorer !== undefined && winner !== null && onFieldPlayers(view.squads, winner).length > 1) {
    settled.push(scorerChip(scorer, nameOf(view, scorer, t)));
  }
  if (returns !== undefined) {
    settled.push(expediteReturnChip());
  }
  if (settled.length > 0) {
    // Titled by the question the scorer answered LAST — expedite is step 2, so
    // when it is present it is the more recent of the two. The unchecked
    // variant carries through here too: the confirmation must not claim a
    // check the fold never performed, which is the whole point of having two
    // titles rather than one.
    return {
      title: t(
        returns === undefined
          ? "pad.tabletennis.dock.rally.scorer.title"
          : expediteChecked(payload)
            ? "pad.tabletennis.dock.rally.expedite.title"
            : "pad.tabletennis.dock.rally.expedite.unchecked.title",
      ),
      chips: settled,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half.
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

export function tabletennisDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;

  switch (eventType) {
    case RALLY_TYPE: {
      const returns = payload.returns;
      const wentToLimit = typeof returns === "number" && returns >= EXPEDITE_RETURNS_THRESHOLD;
      const expedite = wentToLimit ? t("pad.tabletennis.ribbon.expediteReturn") : undefined;
      // A person first where one is known, because that is what a scorer scans
      // for when correcting a misattribution. Where NOBODY was attributed —
      // a doubles rally sent before the dock's scorer question is answered —
      // name the winning SIDE rather than returning nothing: a ribbon of
      // identical "Rally recorded" rows, each with its own Void button, is how
      // the wrong point gets voided at a scoring desk. The expedite flag alone
      // is not enough to tell two rows apart either, so the side joins it.
      const people = join([named(payload.scorer), named(payload.server)]);
      if (people !== undefined) return join([people, expedite]);
      const side = sideOfEntrant(state, payload.wonBy);
      return side ? join([t(SIDE_LABEL[side]), expedite]) : expedite;
    }
    case SUMMARY_TYPE: {
      const home = payload.home;
      const away = payload.away;
      const score = typeof home === "number" && typeof away === "number" ? `${home}–${away}` : undefined;
      return join([score, payload.partial === true ? t("pad.tabletennis.ribbon.partial") : undefined]);
    }
    case SANCTION_TYPE:
      return join([vocabText("level", payload.level, t), named(payload.person), typeof payload.reason === "string" ? payload.reason : undefined]);
    case TIMEOUT_TYPE: {
      // `payload.by` is an ENTRANT id — `ctx.state` (R3.5/Task E's own
      // addition to this contract, football's `shootout.kick` precedent) is
      // what resolves it to a home/away side; `ActivityDetailContext` carries
      // no fold otherwise. Undefined (falls to the bare "Time-out recorded"
      // base) rather than a raw id when the side cannot be resolved.
      const side = sideOfEntrant(state, payload.by);
      return side ? t(SIDE_LABEL[side]) : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function tabletennisSkinV3(t: TFn): SkinDefV3<PadHostView> {
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
    activityDetail: tabletennisDetail,
    // No swap()/contextSelect() — see this file's header.
  };
}
