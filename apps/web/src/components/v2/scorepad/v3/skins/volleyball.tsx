// Volleyball SkinDefV3 — R5/C3, tapModel S. Converts volleyball to the v3
// chassis (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// redesign-design.md` §2/§3, rulings R5-1..R5-5). Replaces
// `../../skins/racquet-skin.tsx` (v2) as VOLLEYBALL'S pad surface only — that
// file is now unreferenced by any sport (badminton R5/C1, table tennis R5/C2
// converted first) and is deleted in this wave's own follow-up task, not
// here.
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
// VOLLEYBALL IS NEITHER BADMINTON NOR TABLE TENNIS. All three share
// `sports/setbased`'s kernel, but this file diverges from both siblings at
// every branch below, and copying either one across would be plausible and
// wrong (R5-racquet-split.md's own pitfall list):
//
//  * SIX ON COURT, NOT ONE OR TWO — AND THE HALF SHOWS NEITHER.
//    `ScorebugHalf.who` carries the SIDE label ("Home"/"Away"), never a
//    player list: `scorebug.tsx`'s `HalfContent` lays every `WhoLine` out in
//    one flex row, and six names is unreadable at 1280 and catastrophic at
//    320 — a half is also a TAP TARGET (tap model S) whose accessible name is
//    built from those lines, so six names makes that name useless too. The
//    serving fact goes on the STRIP, never on a WhoLine (no half is ever
//    marked `serving`/`servingLabel` here).
//
//    THIS IS NOT A CHASSIS GAP WORKED AROUND WITH A GUESS. A literal
//    "entrant's registered name" is NOT available to any v3 skin: `PadHostView`
//    (types.ts) carries `personNames` only, and `personNamesFrom`
//    (../../registry.tsx) documents itself as "personId -> display name, from
//    both sides' rosters" — no entrant-id entry exists anywhere in the chain
//    (traced to its source: `fixture-console.tsx`'s own `entrantNames` local
//    is a MISNOMER, built by `personNamesFrom` and carrying person ids only,
//    confirmed by that file's own "Feed name map: entrant ids AND every
//    rostered person" comment, which its code does not actually do for the
//    v3 lane). Adding one would be the chassis change this brief says to stop
//    and report rather than take. `football.tsx` — the only OTHER team sport
//    on the v3 lane — already answers this exact question the same way
//    (`buildScorebug`: `who: [{name: t(SIDE_LABEL.home)}]`), which is not a
//    coincidence: it is the established, working answer for a team sport on
//    this chassis, and volleyball inherits it rather than re-deriving it.
//    v2's own `racquet-skin.tsx` never showed a team name either — its own
//    header states only "Sets"/"Points"/"Serving", numbers with no name field
//    — so this is continuity, not a regression.
//
//  * THE DOCK ALWAYS ASKS. R5-2's singles auto-set convention (a length-1
//    side stamps its own sole player as scorer, no dock) never fires here:
//    volleyball's smallest entrant is a beach PAIR (2), never 1, so every
//    rally's scorer is asked. `buildHalf` therefore never computes or stamps
//    a `scorer` at tap time at all — unlike badminton/table tennis, there is
//    no singles branch to have one in.
//
//  * `serverFromPairOrder: true`, UNLIKE badminton — but FIVB's rule this
//    answers is 13.2 (beach), not 7.6 (indoor rotation). A beach PAIR's
//    declared `pairOrder` names the SERVER as a person, exactly like table
//    tennis's doubles; an INDOOR side's six-long roster is not a pair
//    (`SERVE_PAIR_SIZE` in the reader), so indoor never names a person —
//    only the SIDE, same as badminton's own doubles case.
//
//  * `rotationCycle: 6` + `rotationImpliedBy: "substitutions"`, AND WHY THIS
//    FILE DECLARES A SERVE ANCHOR AFTER ALL — a DELIBERATE DECISION, found by
//    VERIFYING the brief's own claim against the real engine rather than
//    trusting it, and stated here because the brief explicitly asks for one
//    ("decide deliberately... and say so in the file header") rather than a
//    silent copy of table tennis's tile.
//
//    THE BRIEF'S OWN FRAMING ("self-heals from ordinary play and needs no
//    serve-anchor tile for an ordinary set") IS TRUE FOR `side` AND FALSE FOR
//    `rotation`/`serverPersonId`, and the difference is `SetBasedServeWalk`'s
//    OWN `chainBroken` flag, which these three fields do not share equally:
//      - `side`/`servingSide` read `walk.serving` alone, which side-out sets
//        UNCONDITIONALLY on every rally (`serving = winner`) — this really
//        does self-heal from the very next rally, exactly as documented, and
//        needed NO verification to trust because the sibling skins already
//        rely on the identical mechanism.
//      - `serviceTurn`, `rotation` and (via `serviceTurn`) `serverPersonId`
//        are gated on `chainComplete` (`walk.chainBroken === null`), and nothing
//        in an ORDINARY rally (no declared `serving`) ever sets `chainBroken`
//        back to `null` for a `setStart: "alternate"` sport — `openNextSet`'s
//        own alternate branch computes each new set's opener as
//        `opponent(firstServer)`, and `firstServer` itself is set ONLY by
//        `startSet` (whose opener is this same propagating value — `null` in,
//        `null` out, forever) or by a MID-SET declaration landing on the
//        set's OWN first rally (`before === 0`). Verified directly against
//        `foldMatch` (not this file's own reading of itself): three ordinary
//        rallies, zero declarations, a fully `pairOrder`-declared beach pair —
//        `serverPersonId: null`, no `rotation` key in the answer at all.
//        Confirmed BADMINTON never surfaces this gap only because it never
//        declares `serverFromPairOrder`/`rotationCycle` at all — its own
//        `setStart: "set-winner"` reads the closed set's SCORE (always
//        derivable, no declaration needed), a genuinely different rule this
//        file cannot borrow the silence of.
//      - ONE declaration breaks the cycle for the WHOLE REST OF THE MATCH.
//        Declaring `serving` on a set's own first rally sets `firstServer`
//        (and `chainBroken = null`) for THAT set, and every later set's own
//        `startSet` call then computes a REAL, non-null opener from it via
//        `opponent(...)` — propagating `chainComplete` forward through every
//        set transition indefinitely. Also verified directly against
//        `foldMatch`: one declared anchor on set 1's first rally resolved
//        `serverPersonId` immediately, AND at 0-0 of set 2 (opened purely by
//        alternation, no second declaration) with no help from this file at
//        all. So this sport needs the anchor viable, if never actually
//        pressed, on precisely two rallies: the match's very first one, and
//        the deciding set's own first one (`decidingSetTossed: true` resets
//        `firstServer` to `null` again there — FIVB 7.1's fresh toss — the
//        one place the propagation above deliberately stops).
//
//    `SERVE_ANCHOR_TILE_ID` below is therefore genuinely narrower than table
//    tennis's: `needsServeAnchor` offers it ONLY while `serveOrderKnown` is
//    false for a FIXABLE reason (`side === null`, never "match-over" or a
//    genuine ledger contradiction), which for this sport's self-healing
//    `side` is close to never — it is live for the handful of rallies before
//    the very first one of the match, and again for the handful before the
//    decider's own first one, and withdraws itself the instant either rally
//    lands, exactly like table tennis's tile does. Unlike table tennis's own
//    anchor sheet, this one stamps neither `server` nor `scorer`: the anchor
//    rally is dispatched through `RALLY_TYPE` like any other, so the ordinary
//    scorer dock (R5-2, below) already asks the question afterward — there is
//    no singles branch on this sport to have named one at tap time anyway
//    (see "THE DOCK ALWAYS ASKS" above).
//
//    `serveCtx.rotation` is handled as a genuinely absent field either way —
//    present on a live indoor strip once the chain is anchored, absent on
//    beach (`records.substitutions` is false there by default, and a
//    2-player side can never field a 6-position rotation regardless of any
//    anchor) — never defaulted or hidden behind a truthiness check that would
//    also swallow `0` (rotation is 1-based, so `0` cannot occur, but the
//    field is read via `!== undefined` throughout regardless, matching table
//    tennis's own `serveNumber` discipline).
//
//  * NO EXPEDITE. `records.expedite` is never `true` in any shipped
//    volleyball config (`setbased/volleyball.ts`'s own `defaults`/`variants`
//    both omit it, i.e. it inherits the kernel's own `false`) and FIVB has no
//    ITTF-style Law-2.15 system at all. `EXPEDITE_TYPE` is still DECLARED (the
//    shared 6-branch kernel union needs it registered for
//    `padSpecConformanceSuite`'s bijection check, and `EVENT_BAND` mirrors
//    `padSpec`'s own map entry-for-entry, matching badminton's identical
//    "registered but preset-dead" posture) but no tile is ever built for it,
//    and `refusedEventTypes` refuses it PER FIXTURE off the fold's own cfg
//    (never hardcoded "always off") — the same defence-in-depth discipline
//    badminton's own header states for its own three preset-dead types.
//
//  * NO BWF-STYLE INTERVAL HINT. BWF Law 16.2's 60-second break at 11 points
//    is a badminton-only rule; FIVB has no analogous automatic-interval law
//    (a "technical timeout" is a per-competition option a TIMEOUT tile
//    already covers via `SetBasedTimeout.technical`, never an automatic
//    strip announcement). This file's strip is therefore shorter than
//    badminton's by one item, deliberately.
//
//  * THE LIBERO, AND WHY THIS SKIN DECLARES `swap()` WHEN NEITHER SIBLING
//    DOES. `setbased/volleyball.ts`'s own `lineupPolicy` is
//    `{reentry:"once", reentryPositionLock:true, allowSquadGrowth:false,
//    exemptions:{libero:{}}}` (FIVB 15.6 + 19.3) — badminton/table tennis
//    both declare the maximally restrictive `reentry:"none"` (their own
//    federations have no substitute at all), so neither sibling has anything
//    for a swap sheet to do. Volleyball genuinely does. See the "libero
//    swap" section below for the full design; the short version: ONE
//    `SwapSlot` per side, gated on that side ever having named a libero,
//    posting a REAL `core.lineup.replacement` (never the sport's own
//    `volleyball.sub`, which is the FIVB scoresheet's separate substitution-
//    BOX tally and does not touch `state.squads` at all —
//    `setbased/kernel.ts`'s own doc distinguishes the two facts explicitly).
//    NO ORDINARY (non-libero) substitution tile is declared: the brief's own
//    words are "libero surfaced via the Swap-sheet", not a general bench-sub
//    flow, and `volleyball.sub` stays reachable through the generic More
//    sheet for that (data-driven off `records.substitutions`, exactly
//    mirroring how badminton/table tennis treat their own always-refused
//    `timeout`/`sub`/`expedite.start` types) — two facts, two surfaces,
//    neither one a stand-in for the other.
//
//    THE REFUSAL COPY IS WORDED FROM THE MACHINE `.reason` SLUG, NEVER FROM
//    `reduceLineupEvent`'s OWN `.message`. `SwapSlot.policyMessage`'s
//    documented contract (types.ts) is "pass the engine's own sport-worded
//    prose straight through" — the shape `swap-sheet.tsx` and football's own
//    swap both take. This file does NOT take that shape for the one refusal
//    it can reach (FIVB 15.6's reentry limit): the engine's own message
//    interpolates a raw person ID ("`"${personId}" has already returned
//    once...`", `core/lineup.ts`), which is exactly the "engine's own English
//    ID-bearing prose" R2b's binding ruling forbids surfacing (see
//    `_INDEX.md`'s "R5 — what is already true", the paragraph this brief's own
//    dispatch quotes). So `LIBERO_REFUSAL_KEY` below maps every
//    `LineupRejectionReason` this engine can return to this skin's OWN
//    localised copy, in all four dictionaries, and NEVER reads
//    `LineupReduceResult.message`. `refusalMessage()`'s brand does not forbid
//    this — it forbids passing `.reason` itself as the message, and every
//    value this file passes is a real translated string.
"use client";
import type { LineupPolicy, LineupRejectionReason, SquadMember, SquadState } from "@seazn/engine/core";
import { DEFAULT_LINEUP_POLICY, memberOf } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import {
  volleyball as volleyballModule,
  setBasedServeContext,
  type SetBasedCfg,
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
  type Blocked,
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
  type SwapSlot,
  type TileSpec,
  type WhoLine,
} from "../types";
import type { SportTone } from "../sport-theme";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "volleyball";
export const RALLY_TYPE = `${SPORT}.rally`;
/** The FULLY QUALIFIED coarse type, `${key}.${preset.coarseEventType}`
 *  (setbased/kernel.ts). Volleyball's OWN coarse type is "set.summary", not
 *  "game.summary" — the preset declares only that bare half; posting it
 *  unqualified is a 422 INVALID_EVENT
 *  (`reference_gallery_racquet_capture_traps.md`). */
export const SUMMARY_TYPE = `${SPORT}.${volleyballModule.coarseEventType}`;
export const SANCTION_TYPE = `${SPORT}.sanction`;
export const TIMEOUT_TYPE = `${SPORT}.timeout`;
/** FIVB's own scoresheet substitution-BOX tally (`SetBasedSub`,
 *  `setbased/kernel.ts`) — `{by, off?, on?}`, a per-set count with no policy
 *  check beyond phase. NOT what the libero swap below posts (see this file's
 *  header) — kept only for `EVENT_BAND`'s bijection and `refusedEventTypes`'s
 *  per-fixture defence. */
export const SUB_TYPE = `${SPORT}.sub`;
export const EXPEDITE_TYPE = `${SPORT}.expedite.start`;
/** The libero exchange, ALWAYS a real `core.lineup.replacement` — never a
 *  sport-namespaced type. Declared here (not `${SPORT}.something`) because
 *  the wire type this skin's `swap()` actually posts must match
 *  `SwapSlot.eventType` verbatim (types.ts's own documented obligation), and
 *  `core/lineup.ts`'s five `core.lineup.*` siblings are the ONLY event family
 *  the kernel folds into `state.squads` for any of the three racquet sports
 *  (see this file's header). */
export const LIBERO_TYPE = "core.lineup.replacement";

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/** The feature key volleyball's band 3 is gated behind —
 *  `setbased/volleyball.ts`'s own `rallyEntitlement`, published as
 *  `padSpec(cfg).fidelityEntitlements[3]`. RESTATED here rather than read off
 *  a live `padSpec` call, and `__tests__/volleyball.test.ts` pins this
 *  constant EQUAL to the module's own value — the identical badminton/table
 *  tennis pattern, and by design the identical STRING (all three dossiers
 *  cite "doc 10" for tier-2/3 rally scoring). */
export const RALLY_ENTITLEMENT = "scoring.rally_by_rally";

/**
 * S7/#427 — the FIVB card ladder verbatim, in the order the sheet climbs it.
 * `setbased/volleyball.ts`'s own `sanctionLevels` restated here so the
 * sheet's option order is a decision this file owns, and
 * `__tests__/volleyball.test.ts` pins the two lists equal so they cannot
 * drift apart. FOUR steps — the FIVB ladder, badminton's own shape, NOT table
 * tennis's two: `DOMAIN.volleyball.md:38` is volleyball's own vocabulary for
 * all four (and `reference_engine_domain_dossiers_miscite_laws.md`'s own
 * caution about trusting that file's LAW CITATIONS, never its factual claims
 * about who holds which card, is heeded — the four steps themselves are not
 * in question here).
 */
export const SANCTION_LEVELS: readonly string[] = [
  "warning",
  "penalty",
  "expulsion",
  "disqualification",
];

/** Same tone posture as badminton's own ladder (`SANCTION_LEVEL_TONE`): a
 *  text ENUM, not a swatch, so `contrast.test.ts` holds it to the full
 *  4.5:1 text floor. `penalty`/`expulsion`/`disqualification` all fall
 *  through to `default` exactly as badminton's own three non-warning steps
 *  do. */
const SANCTION_LEVEL_TONE: Readonly<Partial<Record<string, readonly SportTone[]>>> = {
  warning: ["caution"],
  default: ["dismissal"],
};
function toneFor(level: string): readonly SportTone[] {
  return SANCTION_LEVEL_TONE[level] ?? SANCTION_LEVEL_TONE.default!;
}

/**
 * Event type -> fidelity band, MIRRORING `setBasedPadSpec`'s own `fidelity`
 * map (setbased/kernel.ts) rather than inventing a second scale — badminton's
 * and table tennis's identical `EVENT_BAND` take the same posture. The
 * chassis filters tiles by this table's engine-side twin (`filterTilesByBand`
 * reads `PadSpec.fidelity`); this copy exists so `buildTiles` can decline to
 * DRAW an out-of-band tile in the first place, an earlier and separate
 * decision from the chassis's safety filter.
 *
 * `LIBERO_TYPE` (`core.lineup.replacement`) is DELIBERATELY ABSENT from this
 * map: it is not a sport-namespaced type, it carries no `padSpec.fidelity`
 * entry for ANY sport, and `filterTilesByBand`/`tileEventType` (pad-host.tsx)
 * fail OPEN for an unclassified type by design — the libero tile's own
 * band gate is enforced directly in `buildTiles`/`buildSwap` below
 * (`LIBERO_BAND`), never through this map.
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

/** The administrative tier the libero swap is offered at — timeouts,
 *  sanctions and the scoresheet sub tally all sit here, and the libero
 *  exchange is the same kind of non-scoring, lineup-management fact. Not
 *  read off `EVENT_BAND[SUB_TYPE]` (which WOULD equal the same number today,
 *  but coupling the two would imply `buildEvent` posts `SUB_TYPE`, which it
 *  never does — see `LIBERO_TYPE`'s own doc). */
const LIBERO_BAND: FidelityBand = 1;

// ---------------------------------------------------------------------------
// The folded state, as this file reads it. A STRUCTURAL view of
// `SetBasedState` (setbased/kernel.ts) — every field optional, because a pad
// can mount against a pre-fold `{}` and must degrade rather than throw.
// ---------------------------------------------------------------------------

interface VolleyballSetShape {
  home?: number;
  away?: number;
  closed?: boolean;
}
interface VolleyballRecordFlags {
  timeouts?: boolean;
  sanctions?: boolean;
  substitutions?: boolean;
  expedite?: boolean;
}
interface VolleyballCfgShape {
  bestOf?: number;
  setTo?: number;
  finalSetTo?: number;
  winBy?: number;
  cap?: number | null;
  records?: VolleyballRecordFlags;
}
interface VolleyballStateShape {
  cfg?: VolleyballCfgShape;
  entrants?: { home?: string; away?: string };
  phase?: string;
  sets?: VolleyballSetShape[];
  setsWon?: { home?: number; away?: number };
  squads?: SquadState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asState(state: unknown): VolleyballStateShape {
  return asRecord(state) as VolleyballStateShape;
}
function asCfg(cfg: unknown): VolleyballCfgShape {
  return asRecord(cfg) as VolleyballCfgShape;
}

/** The fixture's resolved config. Prefers the FOLD'S OWN copy
 *  (`SetBasedState.cfg`, what `apply` actually ran against) and falls back to
 *  `PadHostView.cfg` only for a pad mounted before any fold exists — the
 *  identical precedent badminton's and table tennis's own `cfgOf` set. */
function cfgOf(view: PadHostView): VolleyballCfgShape {
  const folded = asState(view.state).cfg;
  return folded !== undefined ? folded : asCfg(view.cfg);
}

function readPhase(state: VolleyballStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

function entrantOf(state: VolleyballStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: VolleyballStateShape, entrantId: unknown): Side | null {
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
// phase() — OPT-IN (G3), the identical mapping every setbased skin uses.
// ---------------------------------------------------------------------------

const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

// ---------------------------------------------------------------------------
// The open set, and its score. Same reading as the siblings' own open-game
// helpers, renamed to this sport's own vocabulary — FIVB calls its
// periodisation unit a SET, never a "game" (`unitLabel: {one:"Set",
// many:"Sets"}`, setbased/volleyball.ts), and `state.sets`/`setsWon` are the
// kernel's shared field names regardless of what any one sport calls the
// thing they count.
// ---------------------------------------------------------------------------

interface OpenSet {
  home: number;
  away: number;
  index: number;
}

function openSet(state: VolleyballStateShape): OpenSet | null {
  const sets = state.sets ?? [];
  const index = sets.length - 1;
  const set = sets[index];
  if (set === undefined || set.closed === true) return null;
  return { home: set.home ?? 0, away: set.away ?? 0, index };
}

function pointsOf(state: VolleyballStateShape, side: Side): number {
  const open = openSet(state);
  return open === null ? 0 : open[side];
}

/** `applySummary`'s strict branch (kernel.ts): a set with ANY point already
 *  recorded is being scored rally-by-rally, and the fold refuses a summary
 *  for it. Consumed by BOTH `buildTiles` (withholds the Set score tile) and
 *  `refusedEventTypes` (withholds the generic More form) — one predicate,
 *  the badminton/table tennis precedent this file mirrors. */
function setInProgress(state: VolleyballStateShape): boolean {
  const open = openSet(state);
  return open !== null && (open.home > 0 || open.away > 0);
}

function setNumber(state: VolleyballStateShape): number {
  const sets = state.sets ?? [];
  const open = openSet(state);
  return open === null ? sets.length + 1 : open.index + 1;
}

/** `setTarget` (kernel.ts) — the deciding set may run to `finalSetTo`. */
function targetOf(cfg: VolleyballCfgShape, setIndex: number): number {
  const bestOf = cfg.bestOf ?? 5;
  const setTo = cfg.setTo ?? 25;
  return setIndex === bestOf - 1 ? (cfg.finalSetTo ?? setTo) : setTo;
}

/** `summaryScoreBound` (kernel.ts) — the cfg-derived plausibility ceiling for
 *  the Set score sheet's two number fields. Volleyball ships `cap: null`
 *  (uncapped — FIVB win-by-2 runs indefinitely, 26-24, 30-28, …) on every
 *  shipped variant, so this reads the same margin-past-target fallback the
 *  siblings' own uncapped branch uses; a custom cfg that DOES set a cap is
 *  honoured, never assumed absent. */
function scoreBound(cfg: VolleyballCfgShape): number {
  const cap = cfg.cap;
  if (typeof cap === "number") return cap;
  return Math.max(cfg.setTo ?? 25, cfg.finalSetTo ?? 15) + 20;
}

// ---------------------------------------------------------------------------
// Serving — CONSUMED from the engine (R5-1), never re-derived here. Same
// shim pattern the siblings' own `serveInput` establishes; see badminton.tsx
// for the full field-by-field reasoning this file does not repeat.
// ---------------------------------------------------------------------------

function serveInput(view: PadHostView, state: VolleyballStateShape): SetBasedState | null {
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
    // `serverFromPairOrder: true` AND `rotationCycle: 6` — UNLIKE badminton,
    // this reader genuinely reads `squads` for volleyball: a beach pair's
    // declared `pairOrder` names the server (FIVB 13.2), and an indoor
    // side's on-field count (where a squad IS declared) feeds the rotation
    // number (FIVB 7.6.2).
    squads: view.squads,
  };
  return shim as SetBasedState;
}

/**
 * Who is serving the next rally, or `null` when the engine will not say.
 * Consumes the SAME reader badminton's/table tennis's `serveContextOf` does,
 * over volleyball's own preset — `serveOrderKnown === false` renders
 * NOTHING, never a placeholder (D-17).
 */
export function serveContextOf(
  view: PadHostView,
  state: VolleyballStateShape,
): SetBasedServeContext | null {
  const input = serveInput(view, state);
  if (input === null) return null;
  return setBasedServeContext(volleyballModule, input, view.events);
}

/** The starting roster for one side, ON FIELD, first-named first (pairOrder,
 *  falling back to team-sheet order) — identical to the siblings' own
 *  `onFieldPlayers`. Used for the scorer dock's chips and the sanction
 *  sheet's person step; NEVER for the half's own `who`, which this sport
 *  never populates with players at all (this file's header). */
function onFieldPlayers(squads: SquadState, side: Side): readonly SquadMember[] {
  return squads[side].members
    .filter((member) => member.onField && member.role === "player")
    .slice()
    .sort((a, b) => {
      const pa = a.pairOrder ?? Number.POSITIVE_INFINITY;
      const pb = b.pairOrder ?? Number.POSITIVE_INFINITY;
      return pa !== pb ? pa - pb : a.orderNo - b.orderNo;
    });
}

/** The BENCH roster for one side — `onFieldPlayers`'s exact complement,
 *  never sorted beyond team-sheet order (pairOrder has no bench meaning). */
function benchPlayers(squads: SquadState, side: Side): readonly SquadMember[] {
  return squads[side].members.filter((member) => !member.onField && member.role === "player");
}

interface ServingInfo {
  side: Side;
  /** `null` for every indoor fixture (no `serverFromPairOrder` answer for a
   *  six-long roster) and for a barred libero (FIVB 19.3.2.4 — the reader
   *  itself refuses to name her, `setBasedServeContext`'s own doc); a real
   *  person for a beach pair whose order is declared and complete. NEVER a
   *  skin-side fallback — unlike a singles sport, volleyball has no side
   *  small enough that "the only possible player" is itself derivable, so
   *  there is nothing here for this file to guess in the engine's place. */
  personId: string | null;
}

function servingInfo(view: PadHostView, state: VolleyballStateShape): ServingInfo | null {
  const ctx = serveContextOf(view, state);
  if (ctx === null || ctx.side === null) return null;
  return { side: ctx.side, personId: ctx.serverPersonId };
}

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel S. The half carries the SIDE, not the roster (this
// file's header); the strip carries every positional fact instead.
// ---------------------------------------------------------------------------

/** "Best of 5 · Set 2", plus the endgame FIVB actually has words for.
 *  `Deuce` is the same 2013.3-shaped clause the siblings use, one short of
 *  the game's own cfg-resolved target — derived, never hardcoded at 24, so a
 *  21-point beach set accelerates at 20-all on the SAME code path. Golden
 *  point mirrors the siblings' own capped-endgame wording for a custom cfg
 *  that sets a cap — volleyball ships uncapped on every variant, but the
 *  schema genuinely allows one, and this reads it rather than assuming it
 *  absent. */
function buildContext(state: VolleyballStateShape, cfg: VolleyballCfgShape, t: TFn): string {
  const bestOf = cfg.bestOf ?? 5;
  // CLAMPED to `bestOf`. `setNumber` is "closed sets plus one", which is what makes
  // "Set 2" appear the instant set 1 banks — correct while a match is
  // live, and wrong the moment it ends: every set is then closed, so a
  // decided best-of-5 board announced "Set 6", a set nobody played.
  // The scorebug renders its context line in EVERY phase (`scorebug.tsx`) and
  // `pad-host.tsx` renders the scorebug in "post", so the decided board is a
  // real screen a scorer reads, not a transient. Found in review of PR #678.
  const set = Math.min(setNumber(state), bestOf);
  const base = t("pad.volleyball.context.line", { bestOf, set });
  const open = openSet(state);
  if (open === null || open.home !== open.away) return base;
  const cap = cfg.cap;
  if (typeof cap === "number" && open.home === cap - 1) {
    return `${base} · ${t("pad.volleyball.context.goldenPoint")}`;
  }
  const target = targetOf(cfg, setNumber(state) - 1);
  if (open.home === target - 1) return `${base} · ${t("pad.volleyball.context.deuce")}`;
  return base;
}

function buildHalf(
  view: PadHostView,
  state: VolleyballStateShape,
  side: Side,
  serving: ServingInfo | null,
  t: TFn,
): ScorebugHalf {
  // ONE WhoLine, the SIDE label — never the roster, never the entrant's own
  // registered name (unavailable to any v3 skin; this file's header). No
  // `serving`/`servingLabel` here either: the serve is a STRIP fact for this
  // sport, not a half fact.
  const who: WhoLine[] = [{ name: t(SIDE_LABEL[side]) }];

  // Band 3 gate: `volleyball.rally` IS a band-3 event, so below it a
  // tappable half would be a dead-end tap.
  const tappable = resolvePhase(view) === "live" && view.band >= 3;
  // The SERVER, as a PERSON, for the `serves` playerStats metric
  // (setbased/volleyball.ts declares one). Side-INDEPENDENT: it names who
  // served the rally that is ABOUT TO BE recorded, which is the same fact
  // regardless of which half the scorer taps to record its winner — the
  // identical badminton/table tennis posture. Only ever non-null for a beach
  // pair whose order is declared and complete; every indoor rally omits it.
  const server = serving && serving.personId !== null ? serving.personId : undefined;
  return {
    who,
    big: String(pointsOf(state, side)),
    tappable,
    ...(tappable
      ? {
          hintKey: "pad.volleyball.scorebug.rally.hint",
          tapEvent: {
            type: RALLY_TYPE,
            payload: {
              wonBy: entrantOf(state, side),
              // `SetBasedRally.serving` (the SIDE that served this rally) is
              // deliberately ABSENT — the umpire's own independent
              // observation, and `setBasedServeWalk` uses it as a drift
              // detector against its own belief (kernel.ts). Volleyball loses
              // nothing by omitting it: `serve.within` is "rally-winner", so
              // from the first rally onward the ledger names the server by
              // itself.
              ...(server !== undefined ? { server } : {}),
              // NO `scorer` HERE — see this file's header. Volleyball's
              // smallest side is a pair, never one, so R5-2's singles
              // auto-set branch never fires: the dock always asks
              // (`buildDock` below).
            },
          },
        }
      : {}),
  };
}

/**
 * THE STRIP IS THE FULL POSITIONAL PICTURE for this sport — sets standing,
 * who is serving, and (indoor only) the rotation number, since none of it
 * lives on the half. Live only, both server and rotation: a finished match
 * has nobody left to serve.
 *
 * NOTHING ON THIS STRIP TAKES `tone: "led"`, matching the siblings' own R5-3
 * ruling: the chassis already spends `--sport-led` on the serve pip, the
 * score digits and the board's top hairline.
 */
function buildStrip(
  view: PadHostView,
  state: VolleyballStateShape,
  phase: PadPhase,
  serving: ServingInfo | null,
  serveCtx: SetBasedServeContext | null,
  t: TFn,
): StripItem[] {
  const items: StripItem[] = [
    // `id: "games"` — deliberately NOT "sets", despite the visible label
    // reading "Sets": `e2e/gallery.capture.ts`'s shared `captureRacquetServing`
    // helper (badminton's and table tennis's own before it) reads
    // `[data-strip-item-id="games"]` as the sport-agnostic "top-line unit
    // tally" locator. Reusing the id keeps that harness working unmodified
    // for a third sport; only the LABEL text is volleyball's own word.
    {
      id: "games",
      label: t("pad.volleyball.scorebug.strip.sets"),
      value: `${state.setsWon?.home ?? 0}–${state.setsWon?.away ?? 0}`,
    },
  ];
  // OMITTED, never rendered stale — D-17's whole point. The engine's own
  // `serveOrderKnown` is the verdict, and there is no placeholder branch.
  if (phase === "live" && serving) {
    const value = serving.personId ? nameOf(view, serving.personId, t) : t(SIDE_LABEL[serving.side]);
    items.push({ id: "server", label: t("pad.volleyball.scorebug.strip.server"), value, accent: true });
    // FIVB 7.6.2 — the serving side's own court-position number, 1-based.
    // Present only where the reader's own chain is unbroken AND the side
    // fields a full six (`sideFieldsTheRotation`, kernel.ts) — a beach pair
    // never gets one, and a mid-set drift omits this exactly as it omits the
    // server name. `!== undefined`, never a truthiness check: `rotation` is
    // 1-based so `0` cannot legally occur, but the same discipline table
    // tennis's own `serveNumber` takes is followed regardless.
    if (serveCtx?.rotation !== undefined) {
      items.push({ id: "rotation", label: t("pad.volleyball.scorebug.strip.rotation"), value: String(serveCtx.rotation) });
    }
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
// context() — D-7's explanation, the siblings' exact mechanism. See
// badminton.tsx's own header for the full reasoning this file does not
// repeat: the chassis has no locked-tile path for a band GAP, so the
// explanation has to be authored.
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
        label: "pad.volleyball.context.recording",
        pool: "onfield",
        required: false,
        readOnly: true,
        message: t("pad.volleyball.context.recording.locked", {
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
export function liberoSwapSlotId(side: Side): string {
  return `libero-${side}`;
}

export const RALLY_LOCKED_TILE_ID = "rallyLocked";
export const SET_SCORE_TILE_ID = "setScore";
export const SERVE_ANCHOR_TILE_ID = "serveAnchor";

/** FIVB 7.6.2 — six court positions, rotated one place each time the side
 *  takes the serve back. */
const ROTATION_CYCLE = 6;

/**
 * Does this side field the six positions FIVB 7.6.2 numbers?
 *
 * The kernel's own `sideFieldsTheRotation` rule restated for the pad (the two
 * cannot share: it is not exported): a DECLARED squad is sized, and where none
 * was declared the preset's `rotationImpliedBy: "substitutions"` stands in —
 * indoor has a bench and records substitutions, a beach pair has neither.
 * Pinned against real folds of BOTH variants rather than asserted, because a
 * hand-copied engine rule is TSC-blind if the engine's own moves.
 */
function fieldsTheRotation(view: PadHostView, state: VolleyballStateShape, side: Side): boolean {
  // Read `state.squads`, NOT `view.squads`. The kernel asks "was a squad
  // DECLARED?" and, once one was, sizes it and never consults the cfg flag.
  // `state.squads` is absent exactly where a squad adds no information, which
  // is what makes that fallback reachable — whereas the pad's `view.squads` is
  // always materialised from the team sheet, so keying off it would make the
  // fallback dead and the sizing check answer for a squad the engine never
  // saw. A first cut of this gated on "are there on-field players?" instead:
  // for a declared squad yielding none, the kernel answers false while that
  // test fell through to the flag and answered true, leaving the anchor tile
  // permanently offered for a rotation the engine can never resolve — the
  // exact failure this helper exists to prevent (review of PR #678).
  const squad = state.squads?.[side];
  if (squad !== undefined) {
    return squad.members.filter((m) => m.onField && m.role === "player").length === ROTATION_CYCLE;
  }
  return recordsFlag(view, "substitutions");
}

/**
 * Whether the "note the server" declaration is worth offering right now —
 * the reader cannot say something a fresh declaration could actually resolve.
 *
 * Two exclusions, shared with table tennis's own `needsServeAnchor` (restated
 * rather than shared, since the two files cannot import from each other):
 * `recorded-disagrees` is excluded because the engine deliberately refuses to
 * re-anchor off a declaration mid-dispute (R4-7's own rule — the NEXT set
 * resolves it, not a same-set redeclaration), and `ledger-mismatch` is
 * excluded because a structural disagreement between the ledger and the
 * folded state is not something a new event fixes. `match-over` is excluded
 * by the outer `live` gate already.
 *
 * WHERE VOLLEYBALL PARTS COMPANY WITH ITS SIBLINGS (R5 review, finding 4 —
 * found by PLAYING the pad, not by any assertion). The siblings stop at
 * `side === null`, and for them that is the whole question. Here it is not:
 * `serving` self-heals on every ordinary rally (kernel.ts's own walk), but
 * `chainBroken` — which gates the ROTATION NUMBER — clears only via a fresh
 * declaration or a resolved set boundary. Gating on `side` alone therefore
 * withdrew this tile after the FIRST ordinary tap while the rotation stayed
 * dark for the rest of the set, with no affordance anywhere to bring it back:
 * driven live, a scorer who simply started scoring was left with sanction,
 * time-out and More, and never saw a rotation number again.
 *
 * That is the natural flow, not an edge case — nothing asks a scorer to visit
 * a separate tile before their first point. So the tile stays offered while
 * anything it can fix is still unresolved, and withdraws the moment the pad
 * can report both. A side that fields no six (a beach pair) has no rotation to
 * resolve and so is unaffected — `fieldsTheRotation` is what keeps the tile
 * from becoming permanent furniture there.
 */
function needsServeAnchor(view: PadHostView, state: VolleyballStateShape): boolean {
  const ctx = serveContextOf(view, state);
  if (ctx === null) return false;
  if (ctx.unknownBecause === "recorded-disagrees" || ctx.unknownBecause === "ledger-mismatch") {
    return false;
  }
  if (ctx.side === null) return true;
  return ctx.rotation === undefined && fieldsTheRotation(view, state, ctx.side);
}

/** This FIXTURE's own record flags, from the fold's cfg. Per-fixture, never
 *  the preset's declared defaults (S6/#416, the beach-volleyball regression
 *  THIS sport is named for) — the siblings' own `recordsFlag` restated
 *  identically. */
function recordsFlag(view: PadHostView, flag: keyof VolleyballRecordFlags): boolean {
  return cfgOf(view).records?.[flag] === true;
}

/** Whether a role a `SquadMember` carries includes "libero". */
function hasLiberoRole(member: SquadMember): boolean {
  return member.roles?.includes("libero") === true;
}

/** Whether this SIDE has ever named or used a libero — the tile/slot gate.
 *  Checked across the WHOLE squad (on field and bench), because a libero
 *  currently on court must not make the capability disappear for the very
 *  side that named her. */
function liberoNamed(squads: SquadState, side: Side): boolean {
  return squads[side].members.some(hasLiberoRole);
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
  // every band/phase combination. Sanctions, Timeouts and the libero swap
  // are each such a block, GATED MATCH-WIDE (never per side alone — a
  // per-side gate on the libero pair specifically would break the 0-or-2
  // invariant the moment only one side had ever named one); Set score
  // carries no side identity and is pushed only after all three pairs.

  // Sanctions — a MINOR row, per side. `SetBasedSanction.by` is REQUIRED, so
  // the side is fixed by WHICH tile was tapped.
  if (offerable(SANCTION_TYPE) && recordsFlag(view, "sanctions")) {
    for (const side of SIDES) {
      tiles.push({
        id: sanctionSheetKey(side),
        label: "pad.volleyball.action.sanction",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { sheet: sanctionSheetKey(side) },
      });
    }
  }

  // Timeouts — a real FIVB allowance (indoor default `records.timeouts:
  // true`), a direct event, no sheet: `SetBasedTimeout` is `{by, technical?}`
  // and `technical` (an automatic 8/16-point TV timeout, an OPTIONAL
  // competition rule) is never set here, mirroring table tennis's own
  // zero-field timeout tile — a scorer who needs to flag one as technical
  // has the generic More sheet for that, same as every other cfg-driven
  // field this skin does not collect on its own tile.
  if (offerable(TIMEOUT_TYPE) && recordsFlag(view, "timeouts")) {
    for (const side of SIDES) {
      tiles.push({
        id: timeoutTileId(side),
        label: "pad.volleyball.action.timeout",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { event: { type: TIMEOUT_TYPE, payload: { by: entrantOf(state, side) } } },
      });
    }
  }

  // The libero swap — FIVB 15.6/19.3, this file's own headline addition. A
  // MATCH-WIDE gate: either side having EVER named a libero is enough to
  // offer BOTH tiles, so the pair stays atomic even when only one side's
  // sheet happens to have used theirs yet (the other side's own swap sheet
  // then shows a genuinely empty candidate list, which `swapCandidates`'s
  // existing "no roster" empty state already renders honestly — not a
  // defect, the same shape a genuinely empty bench already produces
  // elsewhere on this chassis).
  const anyLibero = live && band >= LIBERO_BAND && (liberoNamed(view.squads, "home") || liberoNamed(view.squads, "away"));
  if (anyLibero) {
    for (const side of SIDES) {
      tiles.push({
        id: liberoSwapSlotId(side),
        label: "pad.volleyball.action.libero",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { swap: liberoSwapSlotId(side) },
      });
    }
  }

  // Set score — the band-0 action that survives at every band. Withheld
  // while the CURRENT set is being scored rally-by-rally; the paired
  // `refusedEventTypes` entry keeps the generic More sheet from offering the
  // same refused action again.
  if (offerable(SUMMARY_TYPE) && !setInProgress(state)) {
    tiles.push({
      id: SET_SCORE_TILE_ID,
      label: "pad.volleyball.action.setScore",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: SET_SCORE_TILE_ID },
    });
  }

  // The serve anchor — this file's header explains why it exists despite
  // the brief's own warning against copying table tennis's tile: `side`
  // self-heals from an ordinary rally, but `rotation`/`serverPersonId` never
  // do for an "alternate" sport without one declared rally somewhere. Visible
  // ONLY while the engine cannot already answer AND a declaration could
  // resolve it (`needsServeAnchor`); gone the moment it does.
  if (offerable(RALLY_TYPE) && needsServeAnchor(view, state)) {
    tiles.push({
      id: SERVE_ANCHOR_TILE_ID,
      label: "pad.volleyball.action.serveAnchor",
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { sheet: SERVE_ANCHOR_TILE_ID },
    });
  }

  // D-7 — THE SILENCE, GIVEN A FACE. The siblings' exact mechanism: VISIBLE,
  // disabled, span-4, paired with the context slot above which carries the
  // sentence (`assertDisabledTilesExplained`, tile-grid.tsx).
  if (live && rallyOutOfBand(view)) {
    tiles.push({
      id: RALLY_LOCKED_TILE_ID,
      label: "pad.volleyball.action.rally",
      labelText: t("pad.volleyball.tile.rallyLocked"),
      sublabelText: t("pad.volleyball.tile.rallyLocked.sublabel"),
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
 * the siblings' exact shape with volleyball's own record flags:
 *
 *  - `set.summary`, while the current set already has a point —
 *    `applySummary`'s strict branch refuses it outright. THE ONLY DEFENCE.
 *  - `timeout` / `sub` / `expedite.start`, whenever THIS FIXTURE's cfg says
 *    it does not record them. Read PER FIXTURE, off the fold's own cfg —
 *    never off the preset's declared defaults, because `records` is a real
 *    per-fixture cfg knob (S6/#416, the beach-volleyball regression this
 *    sport is literally the subject of). `timeout`/`expedite` are DEFENCE IN
 *    DEPTH here (this skin already builds no tile for them when the flag is
 *    off, or ever for expedite); `sub` is likewise defence in depth — the
 *    scoresheet-box tally is intentionally reachable through the generic
 *    form for a fixture that DOES record substitutions (this file's header:
 *    it is a genuinely different fact from the libero swap's real lineup
 *    change, and neither one stands in for the other).
 */
export function refusedEventTypes(view: PadHostView): string[] {
  const state = asState(view.state);
  const refused: string[] = [];
  if (setInProgress(state)) refused.push(SUMMARY_TYPE);
  if (!recordsFlag(view, "timeouts")) refused.push(TIMEOUT_TYPE);
  if (!recordsFlag(view, "substitutions")) refused.push(SUB_TYPE);
  if (!recordsFlag(view, "expedite")) refused.push(EXPEDITE_TYPE);
  return refused;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), the standing
// convention every v3 skin's `sheets` takes.
// ---------------------------------------------------------------------------

/** The Set score sheet — the siblings' exact shape: two numbers, prefilled
 *  from the CURRENT open set. Titled "Points", not "Sets": volleyball's
 *  `set.summary` scores POINTS within one set, the same two-level hierarchy
 *  badminton's/table tennis's own coarse event carries. */
function setScoreSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const bound = scoreBound(cfg);
  const open = openSet(state);
  return {
    event: SUMMARY_TYPE,
    steps: [
      {
        id: "home",
        kind: "number",
        title: t("pad.volleyball.sheet.setScore.home.title"),
        initial: open?.home ?? 0,
        min: 0,
        max: bound,
      },
      {
        id: "away",
        kind: "number",
        title: t("pad.volleyball.sheet.setScore.away.title"),
        initial: open?.away ?? 0,
        min: 0,
        max: bound,
      },
    ],
    buildPayload: (answers) => ({ home: Number(answers.home ?? 0), away: Number(answers.away ?? 0) }),
  };
}

/** The sanction sheet, per side — the siblings' exact shape, FIVB's own
 *  four-step ladder. `reason` is free text with no text step in this
 *  chassis, so it is not collected, same ruling badminton/table tennis both
 *  record for their own sanction sheets. */
function sanctionSheet(view: PadHostView, side: Side, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const players = onFieldPlayers(view.squads, side);
  const sole = players.length === 1 ? players[0]!.personId : null;
  const steps: GuidedSheetStep[] = [
    {
      id: "level",
      kind: "choice",
      title: t("pad.volleyball.sheet.sanction.level.title"),
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
      title: t("pad.volleyball.sheet.sanction.person.title"),
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
 * The serve anchor sheet — this file's header explains why it exists. Two
 * choice steps, EACH asked because `serving` and `wonBy` are independent
 * facts (serving and winning a rally are different things) and both are
 * required on the wire — there is no partial declaration to send.
 *
 * UNLIKE table tennis's own anchor sheet, this one stamps neither `server`
 * nor `scorer`: volleyball has no singles case to have named one at tap time
 * (this file's header, "THE DOCK ALWAYS ASKS"), and the anchor rally
 * dispatches through the ordinary `RALLY_TYPE`, so `buildDock` below already
 * asks the scorer question afterward exactly as it would for any other tap —
 * inventing a second attribution path here would just be a parallel copy of
 * that same question.
 */
function serveAnchorSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const options = SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] }));
  return {
    event: RALLY_TYPE,
    steps: [
      { id: "serving", kind: "choice", title: t("pad.volleyball.sheet.serveAnchor.serving.title"), options },
      { id: "wonBy", kind: "choice", title: t("pad.volleyball.sheet.serveAnchor.wonBy.title"), options },
    ],
    buildPayload: (answers) => {
      const servingSide: Side = answers.serving === "away" ? "away" : "home";
      const winnerSide: Side = answers.wonBy === "away" ? "away" : "home";
      return {
        wonBy: entrantOf(state, winnerSide),
        serving: entrantOf(state, servingSide),
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
// swap() — FIVB 15.6/19.3, the libero exchange. See this file's header for
// the full design: ONE slot per side, gated match-wide, posting a REAL
// `core.lineup.replacement` and wording any refusal from the machine
// `.reason` slug rather than the engine's own ID-bearing English prose.
// ---------------------------------------------------------------------------

/**
 * Every `LineupRejectionReason` this engine can return, mapped to THIS
 * SKIN's own copy — a full `Record`, matching `scoring-vocab.ts`'s own
 * `SQUAD_ROLE_KEY`/`SQUAD_PROVENANCE_KEY` posture for a closed engine union:
 * the Record forces every member mapped and the string forces real copy to
 * exist, both at compile time, so a future `LineupRejectionReason` addition
 * reds this file's own typecheck rather than shipping a silently-uncovered
 * reason.
 *
 * ONLY TWO reasons carry volleyball's own dedicated wording:
 *  - `reentry-limit` — FIVB 15.6's "once, and only once" cap. The ONE
 *    reason `liberoCandidatesFor` below can actually produce, because it is
 *    the only one computable from a bench candidate's own recorded history
 *    (`timesOff`/`timesOn`) without knowing which specific player is coming
 *    OFF at the same time (`bringOn`'s own reentry checks, `core/lineup.ts`,
 *    read only the candidate going ON).
 *  - `reentry-position` — FIVB 15.6's position lock. NOT reachable from this
 *    file's own `blocked` computation (see `buildLiberoEvent`'s own doc: the
 *    position sent is always auto-derived to be the historically correct
 *    one), but dedicated anyway, defensively, for the same reason
 *    `RALLY_ENTITLEMENT`/`SANCTION_LEVELS` are restated rather than assumed
 *    — the wave's own brief names both "once" AND "position lock" as facts
 *    this skin owes wording for.
 *
 * Every other reason is either impossible by construction from this file's
 * own calls (`exemption-cap-reached` — the exemption is uncapped;
 * `exemption-not-declared` — always declared; `squad-growth-forbidden` — this
 * file never grows a squad) or reachable only from a genuine state race
 * (`not-on-field`/`already-on-field`/`unknown-person` and siblings) that no
 * amount of client-side pre-checking can rule out — those fall to the SAME
 * chassis-generic `pad.swap.refused` swap-sheet.tsx's own header documents
 * as the shared fallback, never a fabricated volleyball-specific sentence
 * for a case this file cannot actually distinguish.
 */
const LIBERO_REFUSAL_KEY: Readonly<Record<LineupRejectionReason, string>> = {
  "reentry-limit": "pad.volleyball.swap.refused.reentryLimit",
  "reentry-position": "pad.volleyball.swap.refused.reentryPosition",
  "reentry-forbidden": "pad.swap.refused",
  "not-on-field": "pad.swap.refused",
  "already-on-field": "pad.swap.refused",
  "unknown-person": "pad.swap.refused",
  "not-a-player": "pad.swap.refused",
  "unknown-entrant": "pad.swap.refused",
  "unknown-lineup-event": "pad.swap.refused",
  "invalid-payload": "pad.swap.refused",
  "squad-growth-forbidden": "pad.swap.refused",
  "sub-cap-reached": "pad.swap.refused",
  "exemption-not-declared": "pad.swap.refused",
  "exemption-cap-reached": "pad.swap.refused",
};

/** Mirrors `core/lineup.ts`'s own `bringOn` reentry checks (S3/W4b #426) for
 *  ONE candidate, independent of who is coming off — restated, never
 *  re-derived as a second policy, and `__tests__/volleyball.test.ts` proves
 *  this restatement equal to a REAL `reduceLineupEvent` refusal rather than
 *  merely asserting its own reading of itself back. `null` for a candidate
 *  who has never left the field at all (not a re-entry, unconstrained) and
 *  for one whose return is still within the allowance. */
function liberoBlockedReason(member: SquadMember, policy: LineupPolicy): LineupRejectionReason | null {
  if (member.timesOff === 0) return null;
  if (policy.reentry === "none") return "reentry-forbidden";
  if (policy.reentry === "once" && member.timesOn >= 1) return "reentry-limit";
  return null;
}

/**
 * The ON list for one side's libero swap sheet, SCOPE and ELIGIBILITY both:
 * every bench member who is EITHER the libero herself (bringing her on) OR
 * has already left the field once via this exchange (bringing them back) —
 * an ordinary bench player who has never been off and carries no libero role
 * is excluded entirely rather than offered-then-refused, because nothing
 * this file builds could ever turn them into a libero replacement. Of THOSE
 * eligible candidates, one whose own history already exhausts FIVB 15.6's
 * allowance is kept VISIBLE and marked `blocked` with the reason beside the
 * name (R2b's binding "visible, blocked, and REASONED — not removed" ruling)
 * rather than silently dropped from the list.
 */
function liberoCandidatesFor(
  squads: SquadState,
  side: Side,
  policy: LineupPolicy,
  t: TFn,
): { candidates: string[]; blocked: Blocked } {
  const eligible = benchPlayers(squads, side).filter((member) => hasLiberoRole(member) || member.timesOff > 0);
  const blocked: Record<string, string> = {};
  for (const member of eligible) {
    const reason = liberoBlockedReason(member, policy);
    if (reason !== null) blocked[member.personId] = t(LIBERO_REFUSAL_KEY[reason]);
  }
  return { candidates: eligible.map((member) => member.personId), blocked };
}

/**
 * Builds the real `core.lineup.replacement` for one libero swap. The
 * `positionKey` sent is AUTO-DERIVED, never asked (this sheet has no
 * position step): a player returning to the field goes back to their own
 * `lastPositionKey` (FIVB 15.6's own lock — recorded at the moment they
 * left, `core/lineup.ts`'s own `takeOff`), and the libero replacing someone
 * takes over the departing player's CURRENT position. Both are the
 * historically/contextually correct value by construction, which is what
 * makes `reentry-position` unreachable from this file's own UI (see
 * `LIBERO_REFUSAL_KEY`'s own doc) — this function is the reason why, not an
 * assertion made elsewhere.
 */
function buildLiberoEvent(
  view: PadHostView,
  state: VolleyballStateShape,
  side: Side,
  off: string,
  on: string,
) {
  const squad = view.squads[side];
  const onMember = memberOf(squad, on);
  const offMember = memberOf(squad, off);
  const positionKey =
    onMember !== undefined && onMember.timesOff > 0 && onMember.lastPositionKey !== undefined
      ? onMember.lastPositionKey
      : offMember?.positionKey;
  return {
    type: LIBERO_TYPE,
    payload: {
      side: entrantOf(state, side),
      off,
      on: {
        personId: on,
        slot: "starting" as const,
        orderNo: onMember?.orderNo ?? 1,
        ...(positionKey !== undefined ? { positionKey } : {}),
        ...(onMember?.roles !== undefined ? { roles: onMember.roles } : {}),
      },
      exemption: "libero",
    },
  };
}

export function buildSwap(view: PadHostView, t: TFn): SwapSlot[] {
  const state = asState(view.state);
  if (resolvePhase(view) !== "live" || view.band < LIBERO_BAND) return [];
  const squads = view.squads;
  if (!(liberoNamed(squads, "home") || liberoNamed(squads, "away"))) return [];
  const policy = volleyballModule.lineupPolicy?.(cfgOf(view) as SetBasedCfg) ?? DEFAULT_LINEUP_POLICY;
  return SIDES.map((side) => {
    const { candidates, blocked } = liberoCandidatesFor(squads, side, policy, t);
    return {
      id: liberoSwapSlotId(side),
      offLabel: "pad.volleyball.sheet.libero.off.title",
      onLabel: "pad.volleyball.sheet.libero.on.title",
      side,
      eventType: LIBERO_TYPE,
      // The exemption channel is UNCAPPED (`setbased/volleyball.ts`'s own
      // `exemptions: {libero: {}}`, no `max`) and this file never attempts
      // squad growth, so there is no SIDE-LEVEL structural block for this
      // slot to report — every reachable refusal is PER CANDIDATE, carried
      // via `blocked` above.
      policyOk: true,
      candidates,
      blocked,
      buildEvent: (off, on) => buildLiberoEvent(view, state, side, off, on),
    };
  });
}

// ---------------------------------------------------------------------------
// dock() — RULING R5-2. UNLIKE the siblings, this dock has no singles branch
// to skip: volleyball's smallest side is a beach PAIR (2), so every rally's
// scorer is asked. The `pair.length <= 1` guard below is still kept —
// defensively, matching the siblings' own posture — because a degenerate
// ONE-PLAYER roster (a hand-built test fixture, or `gallery.capture.ts`'s
// own single-name recipe) must still commit on the hold with no dock rather
// than rendering a pointless one-chip question.
// ---------------------------------------------------------------------------

function scorerChip(personId: string, labelText: string): DockChip {
  return {
    id: `scorer:${personId}`,
    label: "pad.volleyball.dock.person",
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
  const winner = typeof payload?.wonBy === "string" ? sideOfEntrant(state, payload.wonBy) : null;
  const scorer = typeof payload?.scorer === "string" ? payload.scorer : undefined;
  const title = t("pad.volleyball.dock.rally.scorer.title");

  if (scorer !== undefined) {
    // One-way, and the alternatives leave (the chassis's own no-inverse
    // rule): once a scorer lands, the dock shows only that chip.
    return { title, chips: [scorerChip(scorer, nameOf(view, scorer, t))] };
  }

  if (winner === null) return null;
  const onCourt = onFieldPlayers(view.squads, winner);
  if (onCourt.length <= 1) return null;
  return { title, chips: onCourt.map((member) => scorerChip(member.personId, nameOf(view, member.personId, t))) };
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half.
// ---------------------------------------------------------------------------

function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export function volleyballDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;

  switch (eventType) {
    case RALLY_TYPE: {
      // A person first where one is known, because that is what a scorer
      // scans for when correcting a misattribution. Where NOBODY was
      // attributed, name the winning SIDE rather than returning nothing: an
      // unattributed rally is not an edge case — volleyball's halves are TEAM-level, so it is the ordinary one, and a
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
      const score = typeof home === "number" && typeof away === "number" ? `${home}–${away}` : undefined;
      return join([score, payload.partial === true ? t("pad.volleyball.ribbon.partial") : undefined]);
    }
    case SANCTION_TYPE:
      return join([vocabText("level", payload.level, t), named(payload.person), typeof payload.reason === "string" ? payload.reason : undefined]);
    case TIMEOUT_TYPE: {
      // `payload.by` is an ENTRANT id — `ctx.state` (R3.5/Task E's addition to
      // this contract) is what resolves it to a home/away side. Undefined
      // (falls to the bare "Time-out recorded" base) rather than a raw id
      // when the side cannot be resolved.
      const side = sideOfEntrant(state, payload.by);
      return side ? t(SIDE_LABEL[side]) : undefined;
    }
    // V-3 (found by reading the Activity panel after recording both, not by a
    // unit test): a substitution and a libero replacement each rendered as one
    // bare, name-free line, so a set with six subs and a dozen libero swaps —
    // an ordinary indoor set — produced a column of identical rows, each with
    // its own Void button. Volleyball is the WORST sport in the pad for this:
    // FIVB allows six substitutions a set and unlimited libero replacements,
    // so this panel has more repeated rows than any other skin's.
    //
    // The pair reads the same way football's already does
    // (`pad.football.ribbon.sub.pair`, "{on} for {off}") — same shape, same
    // word order decision left to each locale — because a scorer who works
    // two sports should not have to learn two grammars for one fact.
    case SUB_TYPE: {
      const side = sideOfEntrant(state, payload.by);
      const off = named(payload.off);
      const on = named(payload.on);
      const pair = off === undefined || on === undefined ? undefined : t("pad.volleyball.ribbon.sub.pair", { on, off });
      return join([side ? t(SIDE_LABEL[side]) : undefined, pair]);
    }
    case LIBERO_TYPE: {
      // `core.lineup.replacement` is ASYMMETRIC, and reading it as though it
      // were not is how this row goes name-free a second time (engine
      // `core/lineup.ts:204` — `side: EntrantId`, `off: string`, `on:
      // LineupSlot`). So: `side` is an entrant id like every other event here
      // and needs the same `sideOfEntrant` resolution; `off` is a BARE person
      // id; and only `on` is an object whose person is `.personId`.
      // `buildLiberoEvent` above builds exactly that shape.
      const side = sideOfEntrant(state, payload.side);
      const slotPerson = (slot: unknown): unknown =>
        typeof slot === "object" && slot !== null ? (slot as { personId?: unknown }).personId : undefined;
      const off = named(payload.off);
      const on = named(slotPerson(payload.on));
      const pair = off === undefined || on === undefined ? undefined : t("pad.volleyball.ribbon.sub.pair", { on, off });
      return join([side ? t(SIDE_LABEL[side]) : undefined, pair]);
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function volleyballSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: SPORT,
    tapModel: "S",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    context: (view) => buildContextStrip(view, t),
    swap: (view) => buildSwap(view, t),
    refusedEventTypes,
    activityDetail: volleyballDetail,
    // No contextSelect() — the one context slot this skin ever declares is
    // `readOnly` (D-7's recording notice), and a readOnly slot's picker can
    // never open (context-strip.tsx), so there is no selection for this
    // method to turn into an event. Same stance every sibling in this family
    // takes.
  };
}
