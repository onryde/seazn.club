// reconstruct.ts — legal-sequence generators for SIDE-ATTRIBUTED streams.
//
// WHY THIS EXISTS (bench design §4, the "Reconstruction rule (honesty
// clause)"). Some sports' per-rally sequences were never publicly archived —
// badminton, volleyball and table-tennis rallies. The real SET SCORES are
// known; the rally order is not. For a side-attributed module this is
// semantically LOSSLESS, because the module attributes a rally to a SIDE and
// never to a person. So the bench generates a legal sequence folding to the
// exact real set score and flags the stream `provenance: "reconstructed"`,
// never disguising it as real.
//
// ---------------------------------------------------------------------------
// THE HONESTY CLAUSE, MECHANICALLY
// ---------------------------------------------------------------------------
// An ATTRIBUTED fact — a scorer, a card, a wicket — is NEVER reconstructed.
// Two things enforce that here rather than leaving it to a reader:
//
//  * `reconstructSetRallies` emits `{wonBy}` and nothing else. The set-based
//    rally payload also accepts `scorer` and `server` (both `PersonId`) and
//    `serving` (the serving SIDE); all three are facts about who did what, and
//    the fold needs none of them to reach the set score. Reconstruct only what
//    the fold needs.
//  * `fillPeriodMarkers` REFUSES an action whose padSpec declares any
//    attribution at all. A whistle belongs to neither side — football's own
//    `attribution: []` comment says so — and that empty list is the structural
//    marker this refusal reads. Point it at `football.goal` and it stops.
//
// ---------------------------------------------------------------------------
// THE ORACLE DIRECTION (bench `_RULES.md` §3)
// ---------------------------------------------------------------------------
// Nothing here writes an outcome or a verdict into a pack. A generator is
// handed the real world's set scores as a TARGET and produces raw events; the
// ENGINE still derives the outcome, and stage 0 still compares that against
// what the pack's `expected` block claims. The generator never touches
// `expected`.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
// The seed lives IN the pack (`streams[].reconstruction.seed`), and identical
// input gives byte-identical output on every machine. The PRNG is the ENGINE's
// own `mulberry32` (`core/rng.ts`, re-exported from `@seazn/engine/core`);
// there is no second PRNG here, no `Math.random()` and no `Date.now()`.
//
// ONE stream of draws per reconstruction, consumed in event order — NOT a
// per-set `deriveSeed` fan-out, even though `testkit/simulation.ts` sets that
// precedent. `deriveSeed` lives behind the `@seazn/engine/testkit` barrel,
// which re-exports `conformance.ts`, which imports `vitest` and
// `fast-check`; `scripts/bench` is production code run by
// `node --experimental-strip-types`, and pulling a test framework into it to
// borrow one hash function is a worse trade than consuming one stream in
// order. The consequence is stated rather than hidden: changing set 1's target
// changes set 2's rally ORDER (never its score). Recorded in the task report.
//
// ---------------------------------------------------------------------------
// WHAT IS DERIVED FROM THE ENGINE, AND WHY NONE OF IT IS COPIED HERE
// ---------------------------------------------------------------------------
// A set's win predicate is `setTo`/`finalSetTo`/`winBy`/`cap` (setbased
// kernel's `setWinner`), and the deciding set uses a different target. NONE of
// that is restated in this file. The generator asks the MODULE: it applies a
// candidate rally and reads whether the set closed off the module's own public
// `summary(state).detail.sets` ledger. A table of set targets typed in here
// would assert yesterday's numbers the first time a variant moved.
//
// Legality is likewise not asserted by construction. Every generator ends by
// folding its own output through `foldMatch` — the REAL fold path, the one
// stage 0 and the product's batch import both take — and re-reading the ledger
// off the result. `buildWalk` (testkit/helpers.ts:97) is deliberately NOT used:
// its own doc comment at :86-96 says it folds via `module.apply`, one layer
// below `foldMatch`, so a generator proven only against it is not proven on the
// path a pack actually takes.
//
// ---------------------------------------------------------------------------
// Runtime constraints (B02 GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax — `scripts/bench` runs under
// `node --experimental-strip-types`. Every relative import carries `.ts`;
// engine imports use SUBPATHS only; nothing from `apps/web` is imported.
import { z } from "zod";
import {
  foldMatchWithStoppage,
  mulberry32,
  type EventEnvelope,
  type LineupPair,
  type Rng,
} from "@seazn/engine/core";
import type { AnySportModule, PadFieldEnum } from "@seazn/engine/sport";
import { fixtureKey, type PackEvent, type PackStage, type PackStream } from "./pack-schema.ts";
import {
  PACK_FOLD_OPTIONS,
  packEnvelope,
  packLineupPair,
  sigil,
  stageScopedFoldCfg,
} from "./validate-pack.ts";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** `AnySportModule` is `SportModule<any, any, any>`, so every call into it
 *  hands back `any`. Funnelled through these three so exactly one place widens
 *  it back to `unknown` and no call site quietly inherits an `any`. */
function applyEvent(sportModule: AnySportModule, state: unknown, env: EventEnvelope): unknown {
  return sportModule.apply(state, env) as unknown;
}
function initState(sportModule: AnySportModule, cfg: unknown, lineups: LineupPair): unknown {
  return sportModule.init(cfg, lineups) as unknown;
}
function outcomeOf(sportModule: AnySportModule, state: unknown): unknown {
  return sportModule.outcome(state) as unknown;
}

const CORE_START: PackEvent = { type: "core.start", payload: {} };

/**
 * THE CFG A STREAM ACTUALLY FOLDS UNDER.
 *
 * `stageScopedFoldCfg` (lib/validate-pack.ts), imported rather than mirrored,
 * for the same reason this file imports `packEnvelope`, `packLineupPair`,
 * `sigil` and `PACK_FOLD_OPTIONS`: the builder and the checker must not answer
 * one question two ways.
 *
 * This was the ONE seam that did not get carried across, and it was not
 * theoretical. Stage 0 folds every stream with
 * `stageScopedFoldCfg(divisionCfg, stage?.config)` — the two stage-scoped
 * decider keys, `shootout` and `extraTime` — while the generators folded under
 * the division cfg alone. A division enabling extra time whose knockout stage
 * turns it OFF therefore generated `ET_HT`/`ET_FT` markers that the validator
 * then refused as `ALREADY_DECIDED`, because under the overlay the match was
 * already a draw at full time. The `stageRef` doc below actively told authors
 * to set the field that arms it.
 *
 * So `cfg` on every input in this file is the DIVISION cfg — exactly what
 * `resolveDivisionCfg` returns — and the stage is passed separately. One
 * function applies the overlay, and it is the validator's own.
 */
function foldCfgFor(divisionCfg: unknown, stage: PackStage | undefined): unknown {
  return stageScopedFoldCfg(divisionCfg, stage?.config);
}

/** The fixtureId every synthesised envelope carries when the caller names no
 *  fixture. No fold reads it (see `packEnvelope`'s own doc), so it exists only
 *  to keep the synthesis identical to the validator's. */
const UNNAMED_FIXTURE = fixtureKey("<reconstruct>", "<unnamed>");

/**
 * The module DECLARES this envelope type.
 *
 * `SportModule.eventSchemas` is the engine's own registry of "every event type
 * this module can be sent" (sport/module.ts:378), so a typo is refused against
 * the engine's list rather than discovered as a `unknown event type` refusal
 * fifty rallies into a fold. Optional on the interface, so a module that
 * declares none is not blocked — the fold still refuses a bad type.
 */
function assertDeclaresEventType(sportModule: AnySportModule, type: string): void {
  const declared = sportModule.eventSchemas;
  if (declared === undefined) return;
  if (Object.prototype.hasOwnProperty.call(declared, type)) return;
  throw new Error(
    `"${sportModule.key}@${sportModule.version}" declares no event type "${type}" — ` +
      `it declares [${Object.keys(declared).join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Set-based reconstruction
// ---------------------------------------------------------------------------

/** One set's REAL final score, home-side first — the archived fact a
 *  reconstruction folds to. Never an outcome, never a winner: which side took
 *  the set is the engine's to derive from these two numbers. */
export interface ReconstructedSet {
  readonly home: number;
  readonly away: number;
}

/**
 * The set ledger, read off the module's own PUBLIC summary.
 *
 * `ScoreSummary.detail` is `unknown` on the shared type (core/types.ts:146) and
 * the set-based kernel puts `{sets: [{home, away, closed}], …}` there
 * (setbased/kernel.ts's `summary`). Parsed rather than cast: a module whose
 * detail carries no such ledger is not a set-based module, and saying so is a
 * far better failure than reading `undefined.length`.
 */
const SetLedgerDetail = z.object({
  sets: z.array(
    z.object({
      home: z.number().int().nonnegative(),
      away: z.number().int().nonnegative(),
      closed: z.boolean(),
    }),
  ),
});

interface LedgerSet {
  readonly home: number;
  readonly away: number;
  readonly closed: boolean;
}

function setLedger(sportModule: AnySportModule, state: unknown): readonly LedgerSet[] {
  const parsed = SetLedgerDetail.safeParse(sportModule.summary(state).detail);
  if (!parsed.success) {
    throw new Error(
      `"${sportModule.key}@${sportModule.version}" exposes no set ledger — its ` +
        `summary().detail carries no \`sets: [{home, away, closed}]\`, so it is not a ` +
        `set-based module and its rally order is not this generator's to reconstruct`,
    );
  }
  return parsed.data.sets;
}

/** The set at `index`, or the empty set that does not exist yet. A rally
 *  APPENDS the open set, so before the first rally of set `i` the ledger is
 *  `i` entries long. */
function ledgerAt(ledger: readonly LedgerSet[], index: number): LedgerSet {
  return ledger[index] ?? { home: 0, away: 0, closed: false };
}

const scoreText = (set: ReconstructedSet): string => `${set.home}–${set.away}`;

/**
 * The grid is at most (home+1)×(away+1) cells and each costs one
 * `module.apply`. A real set is bounded by the sport's own cap (badminton 30,
 * volleyball's uncapped endgame in practice the low thirties), so this ceiling
 * is never met by a real score — it exists so a typo'd six-figure score refuses
 * in microseconds instead of hanging.
 */
const MAX_SET_CELLS = 20_000;

// ---------------------------------------------------------------------------
// The generator's two INTERNAL refusals
//
// Both used to sit inline, and the review's mutation sweep found each of them
// surviving ALONE with zero red — the textbook "two guards covering for each
// other", plus the external oracle covering both. They are pure functions here
// so each is killable on its own, because they are not decoration: the B03 pack
// builder will depend on this generator THROWING rather than handing back a
// wrong stream, and an untested refusal that a refactor silently removes is how
// a wrong pack ships.
//
// `null` = no issue. A message = what diverged, with both values.
// ---------------------------------------------------------------------------

/** Did the module bank the set the caller asked for? Compares the ledger entry
 *  the ENGINE produced against the target, on all three facts — a set that
 *  closed on the wrong score, and a set that never closed at all, are different
 *  defects and the message says which. */
export function setBankedIssue(
  banked: LedgerSet,
  target: ReconstructedSet,
  setIndex: number,
): string | null {
  if (banked.home === target.home && banked.away === target.away && banked.closed) return null;
  return (
    `set ${setIndex + 1}: asked for ${scoreText(target)}, the fold banked ` +
    `${scoreText(banked)}${banked.closed ? "" : " (still open)"}`
  );
}

/** Does the REAL fold path agree with the plan? Both sides arrive as the
 *  already-joined score strings, so this function cannot re-derive either one
 *  and cannot become a comparison of a value against itself. */
export function foldAgreementIssue(got: string, want: string): string | null {
  if (got === want) return null;
  return `foldMatch disagrees with the plan: asked for [${want}], the real fold path produced [${got}]`;
}

export interface ReconstructSetRalliesInput {
  readonly module: AnySportModule;
  /** The DIVISION's resolved cfg — exactly what `resolveDivisionCfg`
   *  (lib/validate-pack.ts) returns, with no stage overlay applied. Pass the
   *  stage below and `foldCfgFor` applies the overlay through the validator's
   *  own function, so the stream is generated under exactly the cfg stage 0
   *  will later fold it under. */
  readonly cfg: unknown;
  /** The stage this stream belongs to, when it has one. Its `shootout` /
   *  `extraTime` keys OVERLAY the division cfg on the fold path — see
   *  `foldCfgFor`. Absent means no overlay, which is what a single-stage
   *  division with a plain stage config already gets. */
  readonly stage?: PackStage;
  /** Who played, on which side. Build it with `packLineupPair` from the same
   *  stream the events are going into — the entrant ids the fold sees are the
   *  SIGILLED pack refs, and a generator that used bare refs would emit
   *  `wonBy` values `sideOf` cannot resolve. */
  readonly lineups: LineupPair;
  /** The module's own rally envelope type, e.g. `"badminton.rally"`. Checked
   *  against the module's `eventSchemas` registry. */
  readonly rallyType: string;
  /** The real set scores, in the order they were played. */
  readonly sets: readonly ReconstructedSet[];
  readonly seed: number;
  /** Only ever the envelope's `fixtureId`, which no fold reads. */
  readonly fixtureId?: string;
}

/**
 * A legal rally sequence folding to EXACTLY the declared set scores.
 *
 * The whole problem is the ORDER, not the count: 24–22 is a legal badminton
 * game and 23–21 en route to it is not, because the set would already have
 * closed. So the walk is planned per set on a lattice whose live/closed cells
 * the MODULE decides, and a target no legal order can reach is refused by name
 * rather than silently rounded to one that can.
 *
 * Returns `core.start` followed by one rally per point. Throws — with the set
 * index and the offending score — on anything it cannot honestly produce.
 */
export function reconstructSetRallies(input: ReconstructSetRalliesInput): PackEvent[] {
  const { module: sportModule, lineups, rallyType, sets, seed } = input;
  const cfg = foldCfgFor(input.cfg, input.stage);
  const fixtureId = input.fixtureId ?? UNNAMED_FIXTURE;
  assertDeclaresEventType(sportModule, rallyType);
  if (sets.length === 0) throw new Error("a reconstruction needs at least one set score");

  const homeId = lineups.home.entrantId;
  const awayId = lineups.away.entrantId;
  const rally = (side: Side): PackEvent => ({
    type: rallyType,
    payload: { wonBy: side === "home" ? homeId : awayId },
  });

  const rng: Rng = mulberry32(seed);
  const events: PackEvent[] = [CORE_START];
  let state = applyEvent(sportModule, initState(sportModule, cfg, lineups), packEnvelope(fixtureId, CORE_START, 0));

  sets.forEach((target, setIndex) => {
    if (target.home === target.away) {
      throw new Error(
        `set ${setIndex + 1} declares ${scoreText(target)} — a set-based set has no draw ` +
          `(the engine's own set predicate returns no winner while the scores are level)`,
      );
    }
    if (outcomeOf(sportModule, state) !== null) {
      throw new Error(
        `the declared set list is already decided at set ${setIndex} — ` +
          `"${sportModule.key}" awarded the match before set ${setIndex + 1} (${scoreText(target)}) ` +
          `could be played, so this sheet describes a match that never happened`,
      );
    }
    const path = planSet(sportModule, state, target, setIndex, rally, fixtureId, events.length, rng);
    for (const side of path) {
      const event = rally(side);
      state = applyEvent(sportModule, state, packEnvelope(fixtureId, event, events.length));
      events.push(event);
    }
    // Engine-checked postcondition. The plan chose the order; the module says
    // whether the set it actually banked is the one that was asked for.
    const issue = setBankedIssue(ledgerAt(setLedger(sportModule, state), setIndex), target, setIndex);
    if (issue !== null) throw new Error(issue);
  });

  if (outcomeOf(sportModule, state) === null) {
    throw new Error(
      `the declared set list reaches no decided outcome — ` +
        `"${sportModule.key}" still reports the match live after ${sets.length} set(s), so a pack ` +
        `carrying this stream would be refused on seeding (import.not_decided)`,
    );
  }

  // The proof, on the REAL fold path rather than on `module.apply`: re-fold the
  // finished stream through `foldMatch` and re-read the ledger. A generator
  // that handed back a stream the product's own import would refuse is worse
  // than one that refused to generate it.
  verifyAgainstFoldMatch(sportModule, cfg, lineups, events, sets, fixtureId);
  return events;
}

type Side = "home" | "away";

/**
 * WHICH ORDER the points of one set are scored in.
 *
 * A monotone lattice walk from 0–0 to the target, where every cell but the last
 * must be a LIVE set and the last must be the CLOSED one. Both facts come from
 * the module: the planner applies a rally and reads `closed` off the ledger.
 *
 * Exact, not greedy. A greedy walk can paint itself into a corner — 24–22 needs
 * the 22nd away point before the 23rd home point, and a rule that took the
 * bigger remainder first would close the set at 21–19 and have five points left
 * over. So feasibility is solved backwards over the whole grid first, and the
 * seeded draw then chooses only among moves that can still finish.
 */
function planSet(
  sportModule: AnySportModule,
  base: unknown,
  target: ReconstructedSet,
  setIndex: number,
  rally: (side: Side) => PackEvent,
  fixtureId: string,
  baseEventCount: number,
  rng: Rng,
): Side[] {
  const H = target.home;
  const A = target.away;
  if ((H + 1) * (A + 1) > MAX_SET_CELLS) {
    throw new Error(
      `set ${setIndex + 1} declares ${scoreText(target)}, which is ${(H + 1) * (A + 1)} lattice ` +
        `cells — past this generator's ${MAX_SET_CELLS}-cell ceiling. A real set is bounded by the ` +
        `sport's own cap, so this is a mis-transcribed score rather than a long one`,
    );
  }
  const ledgerHere = setLedger(sportModule, base);
  if (ledgerHere.length !== setIndex) {
    throw new Error(
      `set ${setIndex + 1}: the fold already holds ${ledgerHere.length} set(s), so the stream this ` +
        `generator was handed does not start where set ${setIndex + 1} does`,
    );
  }

  const width = A + 1;
  const at = (x: number, y: number): number => x * width + y;
  const states = new Array<unknown>((H + 1) * width);
  const present = new Array<boolean>((H + 1) * width).fill(false);
  const closed = new Array<boolean>((H + 1) * width).fill(false);

  states[at(0, 0)] = base;
  present[at(0, 0)] = true;

  // Forward pass, in order of points scored so far, so every predecessor is
  // already resolved. A cell reachable ONLY through a closed set is left
  // absent: no legal walk passes through it.
  for (let scored = 1; scored <= H + A; scored++) {
    for (let x = Math.max(0, scored - A); x <= Math.min(H, scored); x++) {
      const y = scored - x;
      let from: unknown;
      let side: Side | null = null;
      if (x > 0 && present[at(x - 1, y)] === true && closed[at(x - 1, y)] === false) {
        from = states[at(x - 1, y)];
        side = "home";
      } else if (y > 0 && present[at(x, y - 1)] === true && closed[at(x, y - 1)] === false) {
        from = states[at(x, y - 1)];
        side = "away";
      }
      if (side === null) continue;
      const next = applyEvent(
        sportModule,
        from,
        packEnvelope(fixtureId, rally(side), baseEventCount + scored - 1),
      );
      states[at(x, y)] = next;
      present[at(x, y)] = true;
      closed[at(x, y)] = ledgerAt(setLedger(sportModule, next), setIndex).closed;
    }
  }

  // Backward pass. The endpoint must be CLOSED — that is the set ending on its
  // declared score — and every cell before it must be live.
  const finishes = new Array<boolean>((H + 1) * width).fill(false);
  finishes[at(H, A)] = present[at(H, A)] === true && closed[at(H, A)] === true;
  for (let scored = H + A - 1; scored >= 0; scored--) {
    for (let x = Math.max(0, scored - A); x <= Math.min(H, scored); x++) {
      const y = scored - x;
      if (present[at(x, y)] !== true || closed[at(x, y)] === true) continue;
      finishes[at(x, y)] =
        (x < H && finishes[at(x + 1, y)] === true) || (y < A && finishes[at(x, y + 1)] === true);
    }
  }

  if (finishes[at(0, 0)] !== true) {
    throw new Error(
      `no legal rally order reaches set ${setIndex + 1}'s declared ${scoreText(target)} under ` +
        `"${sportModule.key}"'s own set predicate${earliestCloseHint(H, A, width, present, closed)}`,
    );
  }

  const path: Side[] = [];
  let x = 0;
  let y = 0;
  while (x < H || y < A) {
    const canHome = x < H && finishes[at(x + 1, y)] === true;
    const canAway = y < A && finishes[at(x, y + 1)] === true;
    if (!canHome && !canAway) {
      throw new Error(`set ${setIndex + 1}: the plan reached ${x}–${y} with no legal continuation`);
    }
    // The draw is consumed ONLY where there is a real choice, so a set with
    // exactly one legal order (21–0 has one) costs the stream no entropy and
    // the seed still reaches the sets that have alternatives.
    const side: Side = canHome && canAway ? (rng() < 0.5 ? "home" : "away") : canHome ? "home" : "away";
    path.push(side);
    if (side === "home") x += 1;
    else y += 1;
  }
  return path;
}

/** Why a target is unreachable, in the terms an author will recognise: the
 *  LATEST score under it at which the set was already over — i.e. the closest a
 *  legal rally order can get before the set ends under it. Scanned downward
 *  from the target for that reason: the earliest such score is usually a
 *  whitewash and tells an author nothing about their transcription. Derived
 *  from the same grid the refusal came from, never a rule restated in prose. */
function earliestCloseHint(
  H: number,
  A: number,
  width: number,
  present: readonly boolean[],
  closed: readonly boolean[],
): string {
  for (let scored = H + A - 1; scored >= 1; scored--) {
    for (let x = Math.max(0, scored - A); x <= Math.min(H, scored); x++) {
      const y = scored - x;
      if (present[x * width + y] === true && closed[x * width + y] === true) {
        return ` — the set is already over at ${x}–${y}`;
      }
    }
  }
  return "";
}

/** The generated stream, re-folded through `foldMatch` and re-read off the
 *  module's ledger. This is the ONLY legality proof this file makes; the walk
 *  itself proves nothing, because it was built with `module.apply`. */
function verifyAgainstFoldMatch(
  sportModule: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  events: readonly PackEvent[],
  sets: readonly ReconstructedSet[],
  fixtureId: string,
): void {
  const envelopes = events.map((event, i) => packEnvelope(fixtureId, event, i));
  const { state } = foldMatchWithStoppage(sportModule, cfg, lineups, envelopes, PACK_FOLD_OPTIONS);
  const ledger = setLedger(sportModule, state);
  // Both sides through `scoreText`, never one inline template and one call: a
  // comparison whose two halves format the same fact in two places diverges the
  // first time either moves, and reds on the formatting rather than the data.
  // The mutation sweep caught exactly that — changing the separator reddened
  // twenty-two exactness tests instead of the one note test it touched.
  const got = ledger.map((set) => `${scoreText(set)}${set.closed ? "" : "*"}`).join(", ");
  const want = sets.map(scoreText).join(", ");
  const issue = foldAgreementIssue(got, want);
  if (issue !== null) throw new Error(issue);
}

// ---------------------------------------------------------------------------
// The stream a pack carries
// ---------------------------------------------------------------------------

export interface ReconstructSetBasedStreamInput {
  readonly module: AnySportModule;
  /** The DIVISION cfg, unoverlaid — see `ReconstructSetRalliesInput.cfg`. */
  readonly cfg: unknown;
  readonly divisionRef: string;
  /**
   * WHICH STAGE of that division — the STAGE ITSELF, not merely its ref.
   *
   * It supplies two facts that must never disagree: the `stageRef` written
   * onto the returned stream, and the `shootout` / `extraTime` overlay the
   * fold applies (`foldCfgFor`). Taking the ref alone is how they came to
   * disagree: the doc here used to say "SET IT whenever the stage carries a
   * cfg overlay", and setting it made the VALIDATOR apply an overlay the
   * generator never had — so the field that was supposed to close the gap was
   * the one that opened it. One object, one answer.
   *
   * Optional because a single-stage division binds without a `stageRef` at
   * all; pass it whenever the division has more than one stage, and always
   * when the stage's config carries either decider key.
   */
  readonly stage?: PackStage;
  readonly fixtureExtKey: string;
  /** Entrant REFS, bare — the sigil is applied where the fold needs it. */
  readonly home: string;
  readonly away: string;
  readonly rallyType: string;
  readonly sets: readonly ReconstructedSet[];
  readonly seed: number;
  /**
   * The per-fixture team sheets, where the record gives them (doubles pairs
   * and their declared `pairOrder`, a volleyball rotation order).
   *
   * ACCEPTED HERE rather than attached to the returned stream afterwards, and
   * the difference is load-bearing. `packLineupPair` reads `stream.lineups`,
   * so the pair the generator folds under is built from the draft BELOW — a
   * caller who set `lineups` on the result would generate under empty sheets
   * and validate under real ones, which is the placer/verifier fork this
   * file's header warns about. Before this field existed the two agreed only
   * because the field did not exist, which is an invariant by accident.
   */
  readonly lineups?: PackStream["lineups"];
}

/** `PackReconstruction.note` is bounded at 500 chars by the schema. */
const MAX_NOTE = 500;

/**
 * A whole `PackStream`, flagged `reconstructed` and CARRYING ITS SEED.
 *
 * The seed is written here rather than left to the caller on purpose: a
 * generated stream whose seed was not recorded cannot be reproduced on another
 * machine, which is the one thing the field exists for, and "remember to copy
 * the seed across" is exactly the obligation this repo keeps forgetting.
 */
export function reconstructSetBasedStream(input: ReconstructSetBasedStreamInput): PackStream {
  const { divisionRef, fixtureExtKey, home, away, sets, seed } = input;
  const note = `reconstructed to fold to ${sets.map(scoreText).join(", ")}`.slice(0, MAX_NOTE);
  const draft: PackStream = {
    divisionRef,
    ...(input.stage === undefined ? {} : { stageRef: input.stage.ref }),
    fixtureExtKey,
    home,
    away,
    provenance: "reconstructed",
    reconstruction: { seed, note },
    ...(input.lineups === undefined ? {} : { lineups: input.lineups }),
    events: [],
  };
  // The SAME function stage 0 builds the fold's `LineupPair` with, off the
  // very stream the events are going into — so the ids the generator writes
  // into `wonBy` and the ids the validator folds under cannot disagree.
  const lineups = packLineupPair(draft);
  return {
    ...draft,
    events: reconstructSetRallies({
      module: input.module,
      cfg: input.cfg,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      lineups,
      rallyType: input.rallyType,
      sets,
      seed,
      fixtureId: fixtureKey(divisionRef, fixtureExtKey),
    }),
  };
}

// ---------------------------------------------------------------------------
// Period fillers — the whistles a match sheet does not record as events
// ---------------------------------------------------------------------------

export interface FillPeriodMarkersInput {
  readonly module: AnySportModule;
  /** The DIVISION cfg, unoverlaid — see `ReconstructSetRalliesInput.cfg`. This
   *  is the football/hockey entry point, i.e. exactly the sports where
   *  `shootout` and `extraTime` exist, so the stage below is the difference
   *  between a sheet that folds and one the validator refuses. */
  readonly cfg: unknown;
  /** The stage this fixture belongs to. Its overlay decides which period
   *  markers `padSpec` even OFFERS: football declares `ET_HT`/`ET_FT` only
   *  under `cfg.extraTime.enabled` (`football.ts:2160`) and enters `ET_H1` at
   *  full time only under the same flag (`:1004`). */
  readonly stage?: PackStage;
  readonly lineups: LineupPair;
  /**
   * The sheet's own events, GROUPED BY PERIOD: one array per period, in the
   * order they were played, `core.start` included at the head of the first.
   *
   * Grouped rather than flat because that is the shape the archive actually
   * has — a report gives goals with minutes, and the minute says which half —
   * and because a filler handed a flat list would have to GUESS where the
   * whistle went, which is an invention.
   */
  readonly segments: readonly (readonly PackEvent[])[];
  /** The module's own period-marker envelope type — `"football.period"`,
   *  `"hockey.period.advance"`. The two kernels use different vocabularies
   *  (`phase` vs `to`), which is why the caller names the type and the ENGINE
   *  supplies the value. */
  readonly markerType: string;
  readonly fixtureId?: string;
  /** Markers appended after the last segment before the filler gives up. */
  readonly maxTrailingMarkers?: number;
}

const DEFAULT_MAX_TRAILING_MARKERS = 8;

const isEnumField = (field: { kind: string }): field is PadFieldEnum => field.kind === "enum";

/**
 * Every period marker the ENGINE declares for this cfg, as candidate events.
 *
 * The values come from `padSpec(cfg)` — the module's own declaration of what a
 * scorer may send — and NEVER from a list typed in here. A marker vocabulary
 * typed into the bench asserts yesterday's labels: football's is `HT`/`FT`,
 * plus `QT`/`3QT` at `halves: 4` and `ET_HT`/`ET_FT` with extra time enabled,
 * and the period kernel's is a different key with a different list again.
 *
 * Dotted paths are skipped. A dotted `PadField.path` addresses a NESTED
 * payload field (football's period action also declares `at.period`, the game-
 * time stamp), and a marker is identified by its top-level enum.
 */
function markerCandidates(
  sportModule: AnySportModule,
  cfg: unknown,
  markerType: string,
): PackEvent[] {
  const spec = sportModule.padSpec?.(cfg);
  if (spec === undefined) {
    throw new Error(
      `"${sportModule.key}" declares no padSpec, so there is no engine-declared vocabulary for ` +
        `"${markerType}" and a filler could only invent one`,
    );
  }
  const actions = spec.panels.flatMap((panel) => panel.actions).filter((a) => a.type === markerType);
  if (actions.length === 0) {
    const declared = [...new Set(spec.panels.flatMap((p) => p.actions).map((a) => a.type))];
    throw new Error(
      `"${sportModule.key}" declares no pad action for "${markerType}" — it declares ` +
        `[${declared.join(", ")}]`,
    );
  }
  const out: PackEvent[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.attribution.length > 0) {
      throw new Error(
        `"${markerType}" collects attribution ` +
          `[${action.attribution.map((a) => `${a.kind}:${a.path}`).join(", ")}] — a period marker ` +
          `belongs to neither side, and reconstructing an attributed fact is forbidden by the ` +
          `honesty clause (bench design §4)`,
      );
    }
    const enums = action.fields.filter(isEnumField).filter((f) => !f.path.includes("."));
    // ONE top-level enum, or none. With two, the loop below would emit
    // candidates that each set only ONE of them — a partial payload the engine
    // would refuse, degrading to a confusing `accepted none of` rather than to
    // a wrong marker. No shipped module declares two (football's period action
    // has `phase` plus the dotted `at.period` stamp, which is filtered out
    // above), so this refuses rather than guessing at a cross product whose
    // shape no authored source gives.
    if (enums.length > 1) {
      throw new Error(
        `"${markerType}" declares ${enums.length} top-level enum fields ` +
          `([${enums.map((f) => f.path).join(", ")}]) — this filler names a marker by ONE of them, ` +
          `and which combination is legal is a question no authored source answers`,
      );
    }
    const payloads: Record<string, unknown>[] =
      enums.length === 0
        ? [{}]
        : enums.flatMap((field) => field.values.map((value) => ({ [field.path]: value })));
    for (const payload of payloads) {
      const key = JSON.stringify(payload);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: markerType, payload: payload as PackEvent["payload"] });
    }
  }
  return out;
}

/**
 * The sheet's events with the match's own structural markers filled in.
 *
 * NO SEED, and nothing random: the filler INVENTS nothing. At every boundary
 * it offers the engine every marker the module declares and keeps the one the
 * engine accepts. Exactly one is legal from any given phase — football's
 * `applyPeriod` and the period kernel's `applyAdvance` both refuse every other
 * — so the answer is the engine's, not a choice. If two were ever accepted the
 * filler REFUSES rather than picking, because picking would be the invention.
 */
export function fillPeriodMarkers(input: FillPeriodMarkersInput): PackEvent[] {
  const { module: sportModule, lineups, segments, markerType } = input;
  const cfg = foldCfgFor(input.cfg, input.stage);
  const fixtureId = input.fixtureId ?? UNNAMED_FIXTURE;
  const maxTrailing = input.maxTrailingMarkers ?? DEFAULT_MAX_TRAILING_MARKERS;
  // NO `assertDeclaresEventType` here, deliberately. `markerCandidates` already
  // refuses a type the module declares no PAD ACTION for, which is the stronger
  // condition (a pad action's `type` is by contract a key in `eventSchemas`,
  // sport/module.ts:321) and the more useful message — it lists the actions
  // rather than every event type. Two guards answering one question is how one
  // of them stops being tested.
  const candidates = markerCandidates(sportModule, cfg, markerType);

  const events: PackEvent[] = [];
  let state = initState(sportModule, cfg, lineups);
  const push = (event: PackEvent): void => {
    state = applyEvent(sportModule, state, packEnvelope(fixtureId, event, events.length));
    events.push(event);
  };
  const nextMarker = (): PackEvent => {
    const accepted = candidates.filter((candidate) => {
      try {
        applyEvent(sportModule, state, packEnvelope(fixtureId, candidate, events.length));
        return true;
      } catch {
        return false;
      }
    });
    if (accepted.length === 0) {
      throw new Error(
        `"${sportModule.key}" accepted none of [${candidates.map(showPayload).join(", ")}] here — ` +
          `the match cannot be carried further by markers alone. A shoot-out kick and a goal are ` +
          `ATTRIBUTED facts, and this filler may not invent one`,
      );
    }
    if (accepted.length > 1) {
      throw new Error(
        `"${sportModule.key}" accepted ${accepted.length} markers here ` +
          `([${accepted.map(showPayload).join(", ")}]) — a filler that picked between them would be ` +
          `inventing the sheet rather than completing it`,
      );
    }
    return accepted[0] as PackEvent;
  };

  segments.forEach((segment, i) => {
    for (const event of segment) push(event);
    if (i < segments.length - 1) push(nextMarker());
  });

  let trailing = 0;
  while (outcomeOf(sportModule, state) === null) {
    if (trailing >= maxTrailing) {
      throw new Error(
        `"${sportModule.key}" is still undecided after ${trailing} trailing marker(s) — the sheet ` +
          `is short of periods, or its result needs an event this filler may not invent`,
      );
    }
    push(nextMarker());
    trailing += 1;
  }
  return events;
}

const showPayload = (event: PackEvent): string => JSON.stringify(event.payload);
