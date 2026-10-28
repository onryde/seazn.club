// EventEnvelope, fold kernel, void semantics — spec 03 §2.
// foldMatch is the ONLY state-derivation function in the system.
import { z } from "zod";
import { EngineError } from "./errors.ts";
import {
  DEFAULT_LINEUP_POLICY,
  LineupEntry,
  LineupPositionChange,
  LineupReplacement,
  LineupRetirement,
  LineupSubstitution,
  REPLAY_LINEUP_POLICY,
  initSquads,
  isLineupEventType,
  reduceLineupEvent,
  type LineupPolicy,
  type SquadState,
} from "./lineup.ts";
import { pendingAfter, type PendingEndingSanction, type SanctionEndingDecl } from "./sanction-ending.ts";
import { GameTime, compareGameTime, gameTimeOf } from "./time.ts";
import {
  EntrantId,
  FORFEIT_REASONS,
  forbidsLevelResult,
  isLevelOutcome,
  type ForfeitAward,
  type ForfeitPhase,
  type ForfeitReason,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
} from "./types.ts";

// spec 03 §2 — ids and time are injected (uuid in prod, `e-${n}` in tests);
// seq is gapless per fixture, assigned by persistence.
export interface EventEnvelope<T = unknown> {
  id: string;
  fixtureId: string;
  seq: number;
  type: string; // sport-namespaced: 'cricket.ball', 'football.goal', 'core.void'
  payload: T;
  recordedAt: string; // ISO, injected
  recordedBy: string | null;
  voids?: string; // id of the event this void cancels (type === 'core.void')
}

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  fixtureId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: z.unknown(),
  recordedAt: z.string().min(1),
  recordedBy: z.string().min(1).nullable(),
  voids: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Core event payloads — spec 03 §2 table (sport-independent).
// ---------------------------------------------------------------------------

export const CoreStart = z.strictObject({}); // scheduled → in_play
export const CoreVoid = z.strictObject({}); // target id travels in envelope.voids
// W2b (spec §5.1, plan D1/D3 R1). `by` is the forfeiting entrant, or "both" for a double walkover; `reason` is the
// closed vocabulary (never free text, never the system-only "bye"). "both" is only ever a walkover — both sides
// absent — so the schema refuses it with any other reason (INVALID_EVENT, before any phase is judged).
export const CoreForfeit = z
  .strictObject({ by: EntrantId, reason: z.enum(FORFEIT_REASONS) })
  .refine((p) => p.by !== "both" || p.reason === "walkover", {
    message: 'a forfeit by "both" sides is a double walkover: its reason is "walkover"',
    path: ["reason"],
  });
// W2b (plan D5): `expunge: true` marks an abandon written by the withdrawal cascade — the match leaves the table
// entirely (`outcomeOf` reads null while it is active). `true` or absent; never `false`.
export const CoreAbandon = z.strictObject({ reason: z.string().min(1), expunge: z.literal(true).optional(), noResult: z.literal(true).optional() });

/** The one reader for a `core.forfeit` payload. Every sport module used to cast
 *  it inline as `{ by: string }`, which is why the REQUIRED `reason` was
 *  silently dropped in all eight of them — the cast named the field it wanted
 *  and the compiler had nothing to say about the one it did not. Parsing here
 *  instead means a module cannot read `by` without the reason coming with it.
 *
 *  The `.parse` CANNOT introduce a new throw on stored data, which is the
 *  question to ask of any cast-to-parse change: `foldMatch` already calls
 *  `validateCoreEvent` on every active event, ungated by `strict` (see the
 *  fold loop below), so a `core.forfeit` whose payload does not satisfy this
 *  exact schema has been failing INVALID_EVENT on every fold since long before
 *  this helper existed. By the time a module's reducer runs, the payload is
 *  known good; parsing again is belt-and-braces, not a new gate. */
export function forfeitOf(payload: unknown): { by: string; reason: ForfeitReason } {
  return CoreForfeit.parse(payload);
}

/** The reason of a `core.forfeit` payload, or null when the payload is not one — the non-throwing read the
 *  kernel-ownership predicate needs (it is called on events the fold has not validated yet). */
function forfeitReasonOf(payload: unknown): ForfeitReason | null {
  const parsed = CoreForfeit.safeParse(payload);
  return parsed.success ? parsed.data.reason : null;
}
export const CoreFinalize = z.strictObject({}); // locks ledger
export const CoreNote = z.strictObject({ text: z.string().min(1) }); // no state effect
// Jul3/07 §4 — MOTM/MVP and friends: append-only, undoable via core.void,
// no state effect on the match itself (a stats-layer fact).
export const CoreAward = z.strictObject({ person: z.string().min(1), key: z.string().min(1) });
// W4 (#407) — play stopped, and may restart. `core.abandon` is terminal and was
// the only way to record that play had stopped, so a floodlight failure, a
// thunderstorm, a serious injury or a crowd incident — every one of which is
// routinely followed by a restart — was unrecordable in every sport. The reason
// is what the official wrote in the match record; it is never adjudicated.
//
// W4a (#425) §1.2 — both carry an optional `at`, and it is the flagship reason
// the model is game clock rather than wall clock: "how much GAME time did this
// stoppage consume?" is `resume.at − suspend.at`, zero in a clock-stop sport
// and non-zero where the clock ran on. Real elapsed time stays available from
// the `recordedAt` delta, and how long the official was ALLOWED is a separate
// explicit duration on the interruption event (§5.4) — three different
// questions, three different sources.
//
// The pair sharing ONE stamp is correct, not a bug: in a clock-stop sport the
// game clock does not move across the stoppage at all. Optional with no
// default, so every stoppage recorded before this wave still folds unchanged.
export const CoreSuspend = z.strictObject({
  reason: z.string().min(1).optional(),
  at: GameTime.optional(),
});
export const CoreResume = z.strictObject({ at: GameTime.optional() }); // play restarts

// W2a (spec §5.1, X-ST-1) — the organiser's settle. Kernel-owned like core.void
// and core.suspend: validated and folded here, NEVER forwarded to module.apply,
// so every sport gains it at once and no frozen golden moves. Not in CoreEv
// (plan finding 2): CoreEv is the payload set modules see.
export const SETTLE_METHODS = ["lot", "higher_seed", "organiser"] as const;
export const SettleMethod = z.enum(SETTLE_METHODS);
export type SettleMethod = z.infer<typeof SettleMethod>;
export const CoreSettle = z.strictObject({
  winner: EntrantId,
  method: SettleMethod,
  note: z.string().trim().min(1).max(500).optional(),
});
export const settledMethod = (m: SettleMethod): `settled_${SettleMethod}` => `settled_${m}`;

/** An active settle: who advances, who does not, why, and the event that said so. */
export interface Settlement {
  readonly winner: string;
  readonly loser: string;
  readonly method: SettleMethod;
  readonly eventId: string;
}

/** W2b PF-1 (X-WD-1) — a `core.forfeit{reason:"withdrew"}` the kernel admitted over a held LEVEL result. Kept beside
 *  module state like a settle (the module, already decided, would refuse it): `outcomeOf` reads it as
 *  `award{winner, loser, reason:"withdrew"}`, and the module's level state is what `forfeitCredit` credits from —
 *  retirement credit, the played score standing. */
export interface LevelWithdrawal {
  readonly winner: string;
  readonly loser: string;
  readonly eventId: string;
}

/** What `outcomeOf` reads from a fold. `expunged` and `levelWithdrawal` are optional so a caller holding only
 *  `{state, settlement}` (a pad re-deriving its settle) still compiles; every fold result carries both. */
export interface FoldedOutcomeFacts<State> {
  readonly state: State;
  readonly settlement: Settlement | null;
  /** W2b D5 — an active abandon carries `expunge: true`: the match is out of the table, no outcome at all. */
  readonly expunged?: boolean;
  /** W2b PF-1 — the admitted withdrawal over a held level result, if any. */
  readonly levelWithdrawal?: LevelWithdrawal | null;
}

/** THE settle precondition (spec §5.1 as amended by controller ruling C12). One predicate for the kernel and the
 *  console (through the server's `settle_applies`): a level outcome, or nothing decided while the match is abandoned
 *  or a module-declared decider is pending (chess phase "tiebreak": lots is the organiser's settle, ruling 73).
 *  `outcome` is the EFFECTIVE outcome — `outcomeOf(module, folded)`, never `module.outcome(state)` — so an active
 *  settle reads as a win and is not settleable again. Ruling D-C5: a decided outcome (any win or award, settled_* and
 *  tiebreak_* included) answers false whatever the module phase still says; after a settle in chess phase "tiebreak"
 *  the module state is untouched and its hook still says pending. */
export interface SettleFacts { readonly outcome: MatchOutcome | null; readonly abandoned: boolean; readonly state: unknown }
export function settleApplies(module: { awaitingDecider?(state: never): boolean }, f: SettleFacts): boolean {
  if (isLevelOutcome(f.outcome)) return true;
  if (f.outcome !== null) return false; // decided (D-C5): never re-settled, whatever the phase
  // P1 follow-up: a fixture nobody started has no fold — the console is fed `match_states.state ?? null` — and a
  // module's hook reads its own state shape (boardgame: `s.phase`). No state, no decider owed; never ask the hook.
  return f.abandoned || (f.state != null && module.awaitingDecider?.(f.state as never) === true);
}

/** W2c P-7 / X-AB-5 - the TABLE half of the settle offer. A league, group, swiss or americano draw is a RESULT the
 *  standings credit, so none of `settleApplies`' arms (a level outcome, a pending decider) applies there; the one
 *  exception is an ABANDONED match that decided nobody (no effective outcome), which has no result to turn into a win,
 *  stays out of the table and, in a Swiss stage, holds the next round - the organiser's settle is how it is decided.
 *  An EXPUNGE abandon (W2b D5, a withdrawal's) also folds to no outcome but took the match out of the table altogether:
 *  nothing is owed on it, so it is never offered. `abandoned` is the ACTIVE `core.abandon` of the ledger. `noResult` (rebase ruling D3): that abandon IS the organiser's No result (`core.abandon{noResult: true}`, online chess I-3), already the settle - owed nothing more. */
export interface TableSettleFacts { readonly outcome: MatchOutcome | null; readonly abandoned: boolean; readonly expunged?: boolean; readonly noResult?: boolean }
export function settleAppliesInTable(f: TableSettleFacts): boolean {
  return f.abandoned && f.expunged !== true && f.noResult !== true && f.outcome === null;
}

/** THE stage-aware settle offer: ONE entry for the server's append guard (a table stage's settle) and the console's
 *  block, the pad's held line, and any other reader that asks "is this match owed the organiser's settle?". A bracket
 *  kind (controller ruling C12) is `settleApplies`; every other kind - and a fixture outside any stage - is the table
 *  arm above. `state` is read only by a bracket's pending-decider hook. */
export function settleOffered(
  module: { awaitingDecider?(state: never): boolean },
  stageKind: string | null | undefined,
  f: SettleFacts & { readonly expunged?: boolean; readonly noResult?: boolean },
): boolean {
  return forbidsLevelResult(stageKind) ? settleApplies(module, f) : settleAppliesInTable(f);
}

/** THE outcome of a fold. An expunge abandon (W2b D5) outranks everything — the match left the table, so there is
 *  no outcome. Then a settlement outranks the module's own outcome (a draw it settled, the null of an abandon, a
 *  legacy settled double walkover, D6), then a withdrawal admitted over a held level result (PF-1); otherwise it is
 *  exactly `module.outcome(state)`. Every reader of a fold's outcome calls this (apps/web outcome-readers.test.ts
 *  pins the list). */
export function outcomeOf<Cfg, State>(
  module: Pick<FoldableModule<Cfg, State>, "outcome">,
  folded: FoldedOutcomeFacts<State>,
): MatchOutcome | null {
  if (folded.expunged === true) return null;
  const s = folded.settlement;
  if (s !== null) return { kind: "win", winner: s.winner, loser: s.loser, method: settledMethod(s.method) };
  const w = folded.levelWithdrawal;
  if (w != null) return { kind: "award", winner: w.winner, loser: w.loser, reason: "withdrew" };
  return module.outcome(folded.state);
}

/** THE summary of a fold (W2b PF-1, review I-1; X-WO-1's one-score rule). Exactly `module.summary(state)`, except
 *  when the kernel admitted a withdrawal over a held level result: the module never saw that event, so its state
 *  still reads the draw while `outcomeOf` reads the award. The overlay hands the module its own state with the
 *  effective award in `outcome`, so the module renders the credit it renders for any award. Each module's summary
 *  reads a non-bye award's score from its own `forfeitCredit` — the one its `standingsDelta` lays over the table:
 *  football `displayedGoals`, the period kernel's `officialScore` (hockey, ice hockey), the set kernel's and the
 *  nested kernel's `displayedSets` (volleyball, badminton, table tennis; tennis), carrom's `displayedGames`, and
 *  boardgame's award line. Cricket's summary is its innings scorecard and generic's its W/O marker, neither a
 *  scoreline. So the headline and the table cannot disagree; `forfeit-credit.test.ts` sweeps every module for a
 *  walkover and a retirement (Task 13 review C1, which found the three set kernels reading played sets).
 *  Every module keeps its decision in `state.outcome`; a state without that field is refused rather than silently
 *  left on the draw. A settlement is deliberately NOT overlaid: a settled level game shows the score that was played. */
export function summaryOf<State>(
  module: { summary(state: State): ScoreSummary; outcome(state: State): MatchOutcome | null },
  folded: FoldedOutcomeFacts<State>,
): ScoreSummary {
  if (folded.levelWithdrawal == null) return module.summary(folded.state);
  const state: unknown = folded.state;
  if (typeof state !== "object" || state === null || !("outcome" in state)) {
    throw new Error("summaryOf: the module's state has no `outcome` field, so a withdrawal over its level result cannot be shown");
  }
  return module.summary({ ...state, outcome: outcomeOf(module, folded) } as State);
}

/** Ruling D-C5 — a module-declared decider is still OWED: the module's hook says one is pending AND the fold is not
 *  decided (no outcome and no active settle). A surface offering the decider (the chess pad's tie-break panel) gates
 *  on THIS, never on the module phase alone: a settle in phase "tiebreak" leaves the module state as it was. */
export function deciderPending<Cfg, State>(
  module: Pick<FoldableModule<Cfg, State>, "outcome" | "awaitingDecider">,
  folded: FoldedOutcomeFacts<State>,
): boolean {
  // P1 follow-up: the same null guard as settleApplies — no fold (a scheduled fixture's state is null), no decider.
  return folded.state != null && module.awaitingDecider?.(folded.state) === true && outcomeOf(module, folded) === null;
}

export const CORE_EVENT_SCHEMAS = {
  "core.start": CoreStart,
  "core.void": CoreVoid,
  "core.forfeit": CoreForfeit,
  "core.abandon": CoreAbandon,
  "core.finalize": CoreFinalize,
  "core.note": CoreNote,
  "core.award": CoreAward,
  "core.suspend": CoreSuspend,
  "core.resume": CoreResume,
  // W2a (spec §5.1) — kernel-owned, folded beside module state (outcomeOf).
  "core.settle": CoreSettle,
  // S3/W4b (#426) — the lineup family. Kernel-owned on the core.suspend
  // precedent: the kernel validates them here, folds them into SquadState, and
  // never forwards them to module.apply, so one implementation serves all
  // eleven sports and no module state moves. Payload shapes and the reducer
  // live in `core/lineup.ts`; this map is the registration.
  //
  // FIVE SIBLING TYPES rather than one type with a discriminated `kind`,
  // because every consumer in the system keys on the exact type string —
  // this map, DURING_STOPPAGE below, `postDecisionTypes`, a module's
  // `padSpec.fidelity` keys, the pad's filters — and a `kind` nested in one
  // payload is invisible to all of them. The full argument, and the
  // cross-parse proof that no sibling swallows another, are in
  // `core/lineup.ts` and `core/lineup.events.test.ts`.
  "core.lineup.substitution": LineupSubstitution,
  "core.lineup.replacement": LineupReplacement,
  "core.lineup.position": LineupPositionChange,
  "core.lineup.retirement": LineupRetirement,
  "core.lineup.entry": LineupEntry,
} as const;

export type CoreEventType = keyof typeof CORE_EVENT_SCHEMAS;

// Payload union modules see in apply(): EventEnvelope<Ev | CoreEv> (spec 03 §3).
// core.void, core.suspend, core.resume, core.settle (W2a) and the whole
// core.lineup.* family are absent on purpose — the kernel resolves all of them
// before a module sees anything. A module reads the RESULT of a lineup change (FoldContext.squads,
// or the onLineup hook), never the event.
export type CoreEv =
  | z.infer<typeof CoreStart>
  | z.infer<typeof CoreForfeit>
  | z.infer<typeof CoreAbandon>
  // CoreFinalize is `z.strictObject({})`, so it infers `{}` and technically
  // absorbs its siblings — no-duplicate-type-constituents is right about the
  // type and wrong about the intent. The constituent is listed because this
  // union is the documented payload set modules see in apply(); dropping the
  // name to satisfy the rule would silently remove core.finalize from that
  // contract, and would stop tracking CoreFinalize if it ever gains fields.
  // eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
  | z.infer<typeof CoreFinalize>
  | z.infer<typeof CoreNote>
  | z.infer<typeof CoreAward>;

export function isCoreEventType(type: string): type is CoreEventType {
  return Object.hasOwn(CORE_EVENT_SCHEMAS, type);
}

// W2a I-1 — the event types the kernel folds ITSELF and never hands to
// `module.apply` (spec §5.1: "like void, suspend, resume and lineup"). ONE
// source: `foldMatchWithStoppage` dispatches on `kernelOwnsEvent` below, and
// every hand-rolled replay loop outside the engine (the match-centre timeline,
// the overlay's recent window) must skip what it names — two such loops that
// forwarded `core.settle` made every sport throw INVALID_EVENT on every settled
// fixture. `core.void` is absent on purpose: `resolveVoids` strips it before
// any dispatch, so it never reaches this question.
//
// Exported for ONE reader beyond this file: the fold's invariant test (review
// N1) injects a type with no kernel branch here to reach the dispatch's final
// `else`, which throws. Nothing in production may mutate it.
export const KERNEL_OWNED_CORE: readonly string[] = ["core.suspend", "core.resume", "core.settle"];

/** True for a type the kernel always folds itself: suspend, resume, settle and the lineup family. */
export function isKernelOwnedEventType(type: string): boolean {
  return KERNEL_OWNED_CORE.includes(type) || isLineupEventType(type);
}

/**
 * Does this module take `core.lineup.*` events at all? Owner ruling 2026-10-15: only a module that DECLARES lineup support
 * does, and the declaration is its `lineupPolicy` (the hook that says what its variant permits a squad to do). A module with
 * none (boardgame, carrom, generic) reads no squad, so a substitution recorded there moved the kernel's squads and nothing the
 * sport shows: the pad kept a player who had been taken off, and a generic tap credited a point to them. Reading the hook,
 * not a list of sport names, means a sport that declares a policy tomorrow is admitted tomorrow, and one that forgets to is
 * refused (a test pins which of the shipped modules decline).
 *
 * The WRITE path's gate only (see the lineup branch of `foldMatchWithStoppage`): the question is never asked of a replayed event.
 */
export function admitsLineupEvents(module: { readonly lineupPolicy?: unknown }): boolean {
  return module.lineupPolicy !== undefined;
}

/** `isKernelOwnedEventType`, plus its two CONDITIONAL members, each an event the module would refuse:
 *  - `core.finalize` on a settled fixture the module has not decided (a settled abandon, a settled pending
 *    tie-break; plan finding 21);
 *  - W2b PF-1: `core.forfeit{reason:"withdrew"}` over an unsettled LEVEL result (X-WD-1) — the module is already
 *    decided, so the kernel folds it beside module state (`LevelWithdrawal`).
 *  `settled` = an active `core.settle` precedes the event; an accepted ledger holds at most one, and at most one
 *  admitted withdrawal (the fold refuses a second: the outcome is no longer level). */
export function kernelOwnsEvent<State>(
  module: { outcome(state: State): MatchOutcome | null },
  event: { readonly type: string; readonly payload?: unknown },
  folded: { readonly state: State; readonly settled: boolean },
): boolean {
  if (isKernelOwnedEventType(event.type)) return true;
  const forfeit = event.type === "core.forfeit";
  if (!forfeit && event.type !== "core.finalize") return false;
  // ONE module read serves both conditional members (apps/web outcome-readers.test.ts counts the bare reads here).
  const moduleOutcome = module.outcome(folded.state);
  return forfeit
    ? !folded.settled && isLevelOutcome(moduleOutcome) && forfeitReasonOf(event.payload) === "withdrew"
    : folded.settled && moduleOutcome === null;
}

/** W2b (plan D3) — a module that declares no `walkoverPhases` records a walkover only before play (Appendix A
 *  X-RS-1; ruling 112: a Start with nothing played after it is still before play). */
const DEFAULT_WALKOVER_PHASES: readonly ForfeitPhase[] = ["pre"];

/**
 * W2b ruling 112 (amends Appendix A X-RS-1) — has anything been PLAYED: an active module-owned (sport) event after an
 * active `core.start`. THE one reading: the fold's phase guard asks it of the active ledger before each forfeit, and the
 * console's forfeit dialog asks it of the fixture's ledger through `forfeitAdmission`'s `playRecorded`.
 *  - Every type the kernel registers (CORE_EVENT_SCHEMAS: start, void, forfeit, abandon, finalize, note, award,
 *    suspend, resume, settle and the five `core.lineup.*` types) is the kernel's own or an annotation — never play. Any
 *    other type is the module's namespace (`<sport>.*`, validated by its own schema) and is play.
 *  - A sport event BEFORE the start (a pre-kick-off card, a hockey suspension, a generic score) is not play: the ruling
 *    counts what follows Start, as every module's own phase does (each still reads "pre" there).
 *  - A voided event never counts. `ledger` is in seq order; a `core.void` names its target in `voids` (an envelope's
 *    field; the console maps its `voids_event_id` onto it). Voids are not themselves voidable (`resolveVoids`).
 *  - Ruling 118: `module` is the fixture's sport module, REQUIRED so no caller can forget it. A module declaring
 *    `startIsPlay` (chess: Seazn records no moves) is played from an active `core.start`; every other module from its
 *    first sport event after it.
 */
export function playRecorded(
  ledger: readonly { readonly id: string; readonly type: string; readonly voids?: string | null }[],
  module: { readonly startIsPlay?: boolean },
): boolean {
  const voided = new Set<string>();
  for (const e of ledger) if (e.type === "core.void" && typeof e.voids === "string") voided.add(e.voids);
  let started = false;
  for (const e of ledger) {
    if (voided.has(e.id)) continue;
    if (e.type === "core.start") {
      // Ruling 118: where the sport records nothing between the Start and its result (chess), the Start is play.
      if (module.startIsPlay === true) return true;
      started = true;
    } else if (started && !isCoreEventType(e.type)) return true;
  }
  return false;
}

/** W2b (plan D3 R2, R4, R5; rulings 112, 113) — the forfeit reasons a phase admits, in FORFEIT_REASONS order. `played`
 *  is `playRecorded` of the ledger ("nothing played means not started, for every forfeit reason", ruling 113):
 *  - a walkover only in the module's walkover phases (R2), judged in "pre" while nothing is played (ruling 112: a Start
 *    with no sport event after it), else in the module's phase;
 *  - a retirement only once something is played (ruling 113: nobody retires from a match never played);
 *  - a disqualification once play started (R4: the module's phase, so from the Start on — misconduct before play is
 *    real, ruling 113);
 *  - a withdrawal in any phase (R5).
 *  Never asked of "over" (the type says so): the module's own done/final guard and guarantee 4 answer for it (R0). The
 *  one list the guard judges by AND the refusal names, so the copy can never offer a reason the guard refuses. */
function forfeitReasonsAllowed(phase: Exclude<ForfeitPhase, "over">, walkoverPhases: readonly ForfeitPhase[], played: boolean): ForfeitReason[] {
  const walkoverPhase = played ? phase : "pre";
  return FORFEIT_REASONS.filter((reason) => {
    if (reason === "walkover") return walkoverPhases.includes(walkoverPhase);
    if (reason === "withdrew") return true;
    if (reason === "retired") return played && phase !== "pre";
    return phase !== "pre";
  });
}

/** W2b (C17) — the phase the D3 guard judges a forfeit in. A SportModule must declare `forfeitPhase`; a hand-built
 *  FoldableModule (the core tests' fakes) that does not is judged from the stream itself — pre until an active
 *  `core.start`, play after, over once decided — so no fake escapes the guard. */
function forfeitPhaseOf<State>(
  module: { forfeitPhase?(state: State): ForfeitPhase },
  state: State,
  started: boolean,
  decided: boolean,
): ForfeitPhase {
  if (module.forfeitPhase !== undefined) return module.forfeitPhase(state);
  return decided ? "over" : started ? "play" : "pre";
}

/** W2b (plan D3 R1–R3) — a double walkover ("both") is a walkover, so only where the phase admits one, and never in a
 *  tie-break: the classical game was played (W2b-R14). */
function doubleWalkoverAdmitted(phase: Exclude<ForfeitPhase, "over">, allowed: readonly ForfeitReason[]): boolean {
  return allowed.includes("walkover") && phase !== "tiebreak";
}

/**
 * W2b Task 11 (UI-1; spec §5.5) — what the D3 phase guard admits for a forfeit recorded against `state` NOW: the
 * module's own phase, the reasons that phase admits (`forfeitReasonsAllowed`, the list the guard judges by) and whether
 * a double walkover is admitted. "over" admits nothing (R0: the module's own guard refuses there). The organiser
 * console's forfeit dialog offers exactly this — less PF-2's cascade-only reasons, which the SERVER refuses — so it can
 * never offer what the guard refuses (core/forfeit-admission.test.ts runs the guard to prove the two agree).
 * Ruling 112: `playRecorded` is `playRecorded(ledger)` of the ledger `state` was folded from — the fact the guard reads
 * beside the state, since no module keeps it — so a walkover stays offered after a Start until something is played.
 */
export function forfeitAdmission<State>(
  module: { forfeitPhase(state: State): ForfeitPhase; walkoverPhases?: readonly ForfeitPhase[] },
  state: State,
  facts: { readonly playRecorded: boolean },
): { phase: ForfeitPhase; reasons: ForfeitReason[]; both: boolean } {
  const phase = module.forfeitPhase(state);
  if (phase === "over") return { phase, reasons: [], both: false };
  const reasons = forfeitReasonsAllowed(phase, module.walkoverPhases ?? DEFAULT_WALKOVER_PHASES, facts.playRecorded);
  return { phase, reasons, both: doubleWalkoverAdmitted(phase, reasons) };
}

// Core events are owned by the kernel, so the kernel — not the sport module —
// validates their payloads (spec 03 §2). Unknown `core.*` types are invalid.
export function validateCoreEvent(event: EventEnvelope): void {
  if (!event.type.startsWith("core.")) return;
  if (!isCoreEventType(event.type)) {
    throw new EngineError("INVALID_EVENT", `unknown core event type "${event.type}"`, {
      eventId: event.id,
    });
  }
  const parsed = CORE_EVENT_SCHEMAS[event.type].safeParse(event.payload);
  if (!parsed.success) {
    throw new EngineError("INVALID_EVENT", `invalid ${event.type} payload`, {
      eventId: event.id,
      issues: parsed.error.issues,
    });
  }
}

// ---------------------------------------------------------------------------
// Void resolution — spec 03 §2 guarantee 3 (undo = void).
// ---------------------------------------------------------------------------

// Drops voided events and the void events themselves, preserving order.
// Modules never see core.void. Voids are NOT themselves voidable (PROMPT-02
// decision): a core.void targeting another core.void is rejected with
// INVALID_EVENT, so "re-enable by voiding the void" cannot exist — undoing an
// undo means re-recording the event.
export function resolveVoids(events: readonly EventEnvelope[]): EventEnvelope[] {
  const indexOf = new Map<string, number>();
  events.forEach((event, i) => indexOf.set(event.id, i));

  const voided = new Set<string>();
  events.forEach((event, i) => {
    if (event.type !== "core.void") return;
    if (!event.voids) {
      throw new EngineError("INVALID_EVENT", "core.void requires a `voids` target id", {
        eventId: event.id,
      });
    }
    const targetIndex = indexOf.get(event.voids);
    // "cancels a prior event" (spec 03 §2): the target must exist earlier in
    // the ledger — unknown, later, or self targets are all invalid.
    if (targetIndex === undefined || targetIndex >= i) {
      throw new EngineError(
        "INVALID_EVENT",
        `core.void targets unknown or non-prior event "${event.voids}"`,
        { eventId: event.id },
      );
    }
    // targetIndex came from indexOf, so the lookup cannot miss.
    if ((events[targetIndex] as EventEnvelope).type === "core.void") {
      throw new EngineError("INVALID_EVENT", "voids are not themselves voidable", {
        eventId: event.id,
        targetId: event.voids,
      });
    }
    voided.add(event.voids);
  });

  return events.filter((event) => event.type !== "core.void" && !voided.has(event.id));
}

// ---------------------------------------------------------------------------
// Fold kernel — spec 03 §2.
// ---------------------------------------------------------------------------

// Structural subset of the SportModule contract (spec 03 §3) the kernel needs;
// the full interface lands with PROMPT-03 and is assignable to this.
/**
 * W4a (#425) §3.3 — which half of the fold this event is being folded FOR.
 *
 * `foldMatch` is both the write gate and the only read path: `append-event.ts`
 * validates a candidate by folding the whole stream including it, and the state
 * route, the score page and standings replay that same stream. Without a signal
 * telling the two apart, every check runs identically on both — which is why a
 * refusal computed from `cfg` was a fixture-bricking bug rather than a
 * validation, and why "reject it on the write path" was not expressible.
 *
 * `strict: true` means the event is NOT yet in the ledger. A cfg-derived
 * refusal is then a mistake the scorer can still fix, and refusing is the
 * kindest thing the fold can do. `strict: false` means it is history: cfg has
 * moved since it was recorded, there is no event to void, and the fold must
 * degrade rather than make the fixture unviewable.
 */
export interface FoldContext {
  readonly strict: boolean;
  /**
   * S3/W4b (#426) — the squads as folded so far: who is on the field, where,
   * and what has already happened to them.
   *
   * This is the read path that costs the eight uninterested modules nothing.
   * `ctx` was already optional (W4a), so a module that never asks does not
   * move; a module that needs to name the keeper mid-fold — to attribute a
   * penalty save, to know whether a card leaves a side without one — reads
   * `personsAtPosition(ctx.squads.home, "GK")` and stays out of the squad
   * business entirely.
   *
   * OPTIONAL because `apply()` is also reachable directly, from
   * `testkit/conformance.ts`, `testkit/simulation.ts` and
   * `helpers.buildStream`, which pass no context at all. A module reading this
   * must therefore handle its absence — the fold always supplies it.
   */
  readonly squads?: SquadState;
  /**
   * W2c Task 16b (X-WO-1 part B) - the stage PointsRule's award for THIS forfeit, present ONLY when the kernel has
   * decided it is a forfeit with nothing played (`unplayedForfeitEvent`) and the caller offered one
   * (`FoldOptions.forfeitAward`). A module that reads it keeps it in its own state, where its forfeit credit and its
   * summary read it. Absent for every other event, so no state it does not apply to moves.
   */
  readonly forfeitAward?: ForfeitAward;
}

/**
 * W2c Task 16b (P-3 "A") - does a stage rule's award land on THIS forfeit event? Exactly when nothing was played before
 * it (`playRecorded` of the active ledger, ruling 112) or when it is a walkover (a side that never arrived played
 * nothing, whatever the ledger holds - chess's Start is play and a no-show after it is still a walkover), and never for
 * a double walkover (nobody forfeited TO anyone). This is `isUnplayedForfeit`'s rule (competition/points.ts, the table's
 * reading of the decided outcome) stated for the EVENT, because the kernel decides before the module has an outcome;
 * sport/forfeit-award.test.ts holds the two together across every sport, reason and ledger shape.
 */
export function unplayedForfeitEvent(payload: unknown, playedBefore: boolean): boolean {
  const { by, reason } = forfeitOf(payload);
  return by !== "both" && (reason === "walkover" || !playedBefore);
}

/**
 * How much of the stream is new — the seam itself.
 *
 * `strictFromSeq` is the seq of the first event that is not yet in the ledger.
 * Events at or after it are validated in full; everything before is replayed.
 * `append-event.ts` passes the candidate's seq (exactly one strict event);
 * every READ path passes nothing.
 *
 * ABSENT MEANS TOLERANT, and that direction is deliberate. A caller that
 * forgets the option under-validates a write it was probably not making; a
 * caller that forgets it under the opposite default bricks every fixture in a
 * division whose config was edited. Only one of those is recoverable.
 *
 * A value at or below the stream's first seq makes the whole stream strict,
 * which is what a test simulating a pad wants.
 */
export interface FoldOptions<State = unknown> {
  readonly strictFromSeq?: number;
  /**
   * W2c Task 16b (X-WO-1 part B; Task 9 P-3 "A") - the stage PointsRule's `forfeit.awardScore`, winner first, offered to
   * a fold of that stage's matches. The kernel withholds it from every forfeit that is not one with nothing played
   * (`unplayedForfeitEvent`) and hands it to the module through `FoldContext.forfeitAward` for the rest, so a forfeit
   * after play keeps the module's own credit. Absent means no rule awards a score: every state is exactly what it was
   * before this option existed. Only a module that declares `awardScoreKeys` reads it; offering it to another sport
   * is harmless (it is ignored), so a caller need not branch on the sport.
   */
  readonly forfeitAward?: ForfeitAward;
  /**
   * Called once for every ACTIVE event — after `resolveVoids`, so never for a
   * voided event or the void itself — AFTER the kernel has folded it, with the
   * state and the squads as they stand after it. Kernel-owned events are
   * observed exactly like module events: `core.suspend`, `core.resume` and the
   * whole `core.lineup.*` family each get their call, even though the module
   * never sees them.
   *
   * "Refused" means THROWN, and only a throw skips the call: the error
   * propagates before it. Two events the fold accepts as NO-OPS are still
   * passed in, with state and squads unchanged — a `core.lineup.*` event the
   * replay policy refuses structurally (an unknown person, someone taken off
   * who is not on; ignored, not thrown, on a non-strict fold), and a
   * `core.resume` with no open stoppage. An observer must not read "was
   * called" as "changed something".
   *
   * "Unchanged" is by REFERENCE: `squads` is replaced only when a lineup event
   * is accepted, so an ignored one hands over the very objects the previous
   * call received — an observer may compare them to tell the two apart (the
   * cricket scorecard does). Pinned in events.test.ts.
   *
   * WHY IT EXISTS. A derivation that needs the state after EVERY event — the
   * cricket scorecard's accumulators read `FineInnings` ball by ball — cannot
   * call `foldMatch` per prefix (quadratic), so it used to replay the stream
   * itself through `module.apply`. That is a second copy of this loop, and it
   * got the kernel-owned half wrong: `deriveCricketScorecard` handed
   * `core.suspend` and `core.lineup.*` to `cricket.apply`, which threw
   * `unknown event type`, and every public consumer dropped the scorecard. A
   * copy that merely SKIPPED them would still be wrong: a lineup event reaches
   * the module through `onLineup`, and a concussion replacement who then bowls
   * is refused by a module that never heard of him. Riding this fold instead
   * leaves one implementation of which events a module sees and how.
   *
   * Observation only: the return value is ignored and nothing it does can move
   * the fold. Everything handed over is typed read-only (shallowly — `State`
   * is generic, so no deeper guarantee is expressible here without a cast at
   * the call site); a caller must not mutate any of it.
   */
  readonly onFolded?: (
    state: Readonly<State>,
    event: Readonly<EventEnvelope>,
    squads: Readonly<SquadState>,
  ) => void;
}

/**
 * The default a module applies when `apply()` is called WITHOUT a context.
 *
 * `apply` is reachable two ways: through the fold (which always supplies one)
 * and directly, from `testkit/conformance.ts`, `testkit/simulation.ts` and
 * `helpers.buildStream`, which are all building a stream event by event — the
 * write shape. So an absent context reads as STRICT, and the tolerant reading
 * only ever comes from the fold saying so explicitly. Modules call this rather
 * than spelling the default out, so the polarity lives in one place.
 */
export function isStrictFold(ctx?: FoldContext): boolean {
  return ctx?.strict !== false;
}

export interface FoldableModule<Cfg = unknown, State = unknown> {
  init(cfg: Cfg, lineups: LineupPair): State;
  // `ctx` is optional so the eight modules with no cfg-derived refusal inside
  // apply() need not move at all; the three that have one read it (see
  // isStrictFold).
  apply(state: State, event: EventEnvelope, ctx?: FoldContext): State; // pure; throws EngineError
  outcome(state: State): MatchOutcome | null; // null = still live
  // Sport-declared types still accepted after the outcome is decided
  // (spec 03 §2 guarantee 4).
  postDecisionTypes?: readonly string[];
  // W2a C12: a level game held for a decider the scorer records (boardgame phase
  // "tiebreak"). While it is true and the outcome is null, `settleApplies` is
  // true: lots is the organiser's settle there (ruling 73). Optional; absent
  // reads as "no decider pending", so no module that does not declare it moves.
  awaitingDecider?(state: State): boolean;
  // W2a ruling D-C7 (spec §7): the module's own event types that RECORD the
  // pending decider (boardgame: "boardgame.tiebreak"). The kernel refuses them
  // TIEBREAK_NOT_APPLICABLE whenever `deciderPending` is false — above guarantee
  // 4, so a decided fixture answers with the decider's own refusal, never
  // ALREADY_DECIDED. Optional; absent reads as "no decider types".
  deciderTypes?: readonly string[];
  // W2c D7 (D-R7): the entrant a decider event (one of `deciderTypes`) would advance, read from its payload and the
  // fixture's two entrants. The server's withdrawn-entrant guard asks it instead of reading `payload.winner`, because
  // a decider need not carry a winner: chess's Armageddon records Black and the result, and the engine derives who
  // advances. Undefined = the payload names nobody (the fold refuses it with its own code). Optional; absent reads as
  // "the payload's `winner`".
  deciderWinner?(payload: unknown, entrants: { readonly home: string; readonly away: string }): string | undefined;
  // W2b (plan D3) — where in the match a forfeit is being recorded, read from the module's own phase union: "pre"
  // before play, "play" while it runs (a shoot-out and a super over included, ruling 102 Q5), "tiebreak" for a
  // pending decider (chess), "over" once done/final/abandoned. The kernel's phase guard judges every
  // `core.forfeit` against it, BEFORE the module sees the event. Required on SportModule; optional here only for
  // hand-built fakes, which are judged from the stream (forfeitPhaseOf).
  forfeitPhase?(state: State): ForfeitPhase;
  // W2b (plan D3 R2) — the phases a walkover (one side or both) may be recorded in. Absent ⇒ ["pre"]. Only
  // boardgame widens it (FIDE Laws 6.7.1: a no-show after the session starts; R14: a tie-break no-show). Ruling 112:
  // the kernel judges a walkover in "pre" while nothing is played after the start (`playRecorded`), whatever the phase.
  walkoverPhases?: readonly ForfeitPhase[];
  // W2b ruling 118 — the sport records no play between the Start and the result (chess: Seazn records no moves), so
  // an active `core.start` is itself play (`playRecorded`): after it a retirement is recordable, and a retirement or
  // a disqualification is a game both players played (X-PS-2). Absent ⇒ false: "nothing played means not started"
  // (rulings 113–115). Only boardgame declares it.
  startIsPlay?: boolean;
  // W4a (#425) §7 — every phase in which a STAMPED event may legally occur, in
  // the order they occur, for this cfg. Wider than "the phases where play is
  // running": a card before the opening whistle and a card in the shootout are
  // both stampable, so both phases belong here or the fold refuses them.
  //
  // The single source of order for game-time comparison, and the obligation on
  // a sport is to hand over the SAME FUNCTION its `apply()` passes to
  // `compareGameTime` — not an equal-looking list. Two lists that agree today
  // is the defect this replaces: an event the guard accepted is then backwards
  // one layer down. Ice hockey and hockey supply `playPhases` from
  // `sports/period/kernel.ts`, and `sports/period/phases.test.ts` asserts the
  // module holds that exact reference.
  //
  // Optional, and absent means "derive it" (see foldMatchWithStoppage) — a
  // deliberately weaker fallback that keeps every module that has not declared
  // one working unchanged. An empty or duplicated list is neither: both are
  // refused as CONFIG_INVALID (validateDeclaredPhases).
  playPhases?(cfg: Cfg): readonly string[];
  /**
   * W2e (spec 2026-10-28 §5.2; D3 (1), D12; rule X-SE-1) — the sanction levels that END a match in this sport, and the
   * ones after which the pad asks whether a team can still field six. The kernel reads `eventType` and `endLevels`: after
   * a live sanction at an end level, the WRITE path takes no event but `core.forfeit` (its ending) or `core.abandon` until
   * the match is decided (`ENDING_SANCTION_PENDING`); replay is untouched. The pad and the scoring route read the same
   * declaration through `pendingEndingSanction` and `scorerMayForfeit` (core/sanction-ending.ts), so no sport's list is
   * typed twice. Absent ⇒ no sanction ends a match, and nothing the kernel does moves.
   */
  readonly sanctionEnding?: SanctionEndingDecl;

  /**
   * S3/W4b (#426) — what this VARIANT permits a lineup to do: re-entry mode
   * and FIVB's position lock, mid-fixture squad growth, the substitution cap
   * and the exemptions held outside it.
   *
   * A hook on cfg rather than a constant on the module, because every one of
   * those differs by variant and not by sport: football Law 3.3 forbids a
   * return while the grassroots dispensations that share the module are
   * rolling; a T20 permits a concussion replacement a village friendly does
   * not. A module that hard-codes any of them has answered for the wrong
   * competition.
   *
   * Absent ⇒ the module takes NO `core.lineup.*` event on the write path (owner
   * ruling 2026-10-15; `LINEUP_NOT_SUPPORTED`, see `admitsLineupEvents`): the
   * declaration is the opt-in, because a module that declares none reads no
   * squad, and a substitution recorded there moved the kernel's squads and
   * nothing the sport shows. A module that wants the kernel's most restrictive
   * answer (no growth, no return, no exemption, no cap) says so, with
   * `lineupPolicy: () => DEFAULT_LINEUP_POLICY`, as table tennis does. A ledger
   * that already holds a lineup event for such a module still REPLAYS: only the
   * write path refuses.
   */
  lineupPolicy?(cfg: Cfg): LineupPolicy;

  /**
   * S3/W4b (#426) — the kernel handing over the squads after it has folded a
   * `core.lineup.*` event, so a module that keeps its own view of who is on the
   * field can persist the snapshot into its own State.
   *
   * Called once at `init` and once after every ACCEPTED change — never after a
   * refusal, and never with a squad the kernel has not accepted. The init call
   * is what stops a module's State and the kernel's SquadState being two
   * constructions of the same fact that can drift apart.
   *
   * OPTIONAL, and the eight modules that do not care declare nothing: no module
   * State moves, so no frozen golden shifts. Pass B wires football and the
   * three family kernels; nothing in `src/sports/**` implements it yet.
   */
  onLineup?(state: State, squads: SquadState): State;
}

/**
 * A module that declares `playPhases` must declare a usable list (§7). Both
 * failures below are facts about the module and its cfg — knowable before the
 * first event, wrong for every event after it — so they are refused once, at
 * fold start, as CONFIG_INVALID.
 *
 * EMPTY is not "declares nothing". Read that way it would silently drop the
 * sport onto the derive-from-the-stream fallback, which is the strictly weaker
 * path §3.3 exists to close, for precisely the cfg whose list came out empty.
 * Read as declared-and-exhaustive it was worse: every stamped event in the
 * sport was refused. Both readings hide the module bug; this surfaces it.
 *
 * DUPLICATES orphan the later entry, because `compareGameTime` orders by
 * `indexOf` (time.ts) — two phases the module says are distinct then sort as
 * one, and every comparison against the orphan is quietly wrong with nothing in
 * the state or the goldens to show it.
 */
function validateDeclaredPhases(phases: readonly string[]): void {
  if (phases.length === 0) {
    throw new EngineError(
      "CONFIG_INVALID",
      "module declared an empty phase order — declare every phase a stamp may name, or declare none at all",
      { phaseOrder: [] },
    );
  }
  if (new Set(phases).size !== phases.length) {
    throw new EngineError(
      "CONFIG_INVALID",
      `module declared a duplicated phase order (${phases.join(", ")}) — phase order is matched by index, so a repeat is unorderable`,
      { phaseOrder: [...phases] },
    );
  }
}

// Core types always accepted post-decision: annotations and the finalize lock.
// core.suspend is deliberately absent — a decided match cannot be suspended.
// W2a: core.settle closes a DECIDED level result (a draw, a tie, a no_result);
// its own precondition (settleApplies) refuses it on a win.
const POST_DECISION_CORE: readonly string[] = ["core.note", "core.finalize", "core.award", "core.settle"];

// W4 (#407) — the kernel owns core.suspend / core.resume exactly as it owns
// core.void: it validates them, folds them, and NEVER forwards them to
// module.apply. One implementation therefore serves all eleven sports (and
// every future one), no module state moves, and no frozen golden shifts.

// W2e X-SE-1 — the two events the write path still takes while a match-ending sanction waits for its ending: the ending
// itself (`core.forfeit`, whose reason the phase guard and, for a scorer, D13 judge) and an abandon. Everything else is
// ENDING_SANCTION_PENDING until a forfeit is recorded or the sanction is voided (a void never reaches the loop).
const ADMITTED_WHILE_ENDING_PENDING: readonly string[] = ["core.forfeit", "core.abandon"];

/** An open stoppage: play has been suspended and not yet resumed. */
export interface MatchStoppage {
  /** As the official recorded it ("floodlight failure"); never adjudicated. */
  reason?: string;
  /** The `core.suspend` event that opened it — the read side's undo handle. */
  eventId: string;
  /**
   * W4a (#425) §1.2 — the game time the suspension was called, when the pad
   * recorded one. This is the half of `resume.at − suspend.at` that only the
   * fold knows: without it a consumer had to re-scan the raw ledger for
   * `eventId` to answer "how much GAME time has this stoppage consumed?", which
   * is exactly the work folding exists to spare it. The stamp is the one the
   * monotonic guard accepted, not a second parse of the payload.
   *
   * Optional with no default: a stoppage recorded before this wave has no
   * stamp, and the key is then ABSENT, so the object is byte-identical to the
   * one that shape produced before.
   */
  at?: GameTime;
}

// The only types the ledger accepts while play is suspended: the annotations
// (which have no play effect) and the events that end the stoppage one way or
// the other. Everything else — every sport event, and core.start — is refused
// with WRONG_PHASE, because it claims play happened while play was stopped.
const DURING_STOPPAGE: readonly string[] = [
  "core.resume",
  "core.note",
  "core.award",
  "core.abandon",
  "core.forfeit",
  "core.finalize",
  // W2a finding 4: a settle closes an abandon that left the stoppage open.
  "core.settle",
  // S3/W4b (#426) — a lineup change during a stoppage is not a claim that play
  // happened; it is the commonest thing that happens while play is stopped. An
  // injury stoppage exists precisely so the replacement can be made, and
  // refusing these here would have made the ordinary injury substitution
  // unrecordable in every sport that can suspend play.
  "core.lineup.substitution",
  "core.lineup.replacement",
  "core.lineup.position",
  "core.lineup.retirement",
  "core.lineup.entry",
];

// The only state-derivation function in the system (spec 03 §2). Guarantees:
//  1. determinism — referentially transparent, same inputs → deep-equal state;
//  2. validation before append — persistence folds before inserting, so a
//     throwing event never enters the ledger;
//  3. undo = void — resolveVoids strips voided events + voids before modules
//     see anything;
//  4. monotonic decision — once outcome(state) is non-null, further events are
//     rejected (ALREADY_DECIDED) except core.note / core.finalize / the
//     module's declared postDecisionTypes;
//  5. suspended play records nothing (W4) — between a core.suspend and its
//     core.resume the ledger accepts only annotations and the events that end
//     the stoppage; anything else is WRONG_PHASE. Both types are kernel-owned
//     and never reach the module, so no sport had to change to gain them.
//  6. monotonic game time (W4a #425 §3.3) — an event carrying a `GameTime` at
//     `payload.at` may not be stamped earlier than the newest accepted stamp
//     (NON_MONOTONIC_TIME). Equal stamps are legal; unstamped events are
//     unconstrained, so every stream recorded before this wave is unaffected.
export function foldMatch<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  opts?: FoldOptions<State>,
): State {
  return foldMatchWithStoppage(module, cfg, lineups, events, opts).state;
}

/** foldMatch plus guarantee 5: the open stoppage, if play is suspended right
 *  now. Same fold, same errors — the state is byte-for-byte what foldMatch
 *  returns, because core.suspend / core.resume never reach the module.
 *
 *  W2b adds two facts beside the state, both read by `outcomeOf`: `expunged` (D5 — an active abandon carries
 *  `expunge: true`) and `levelWithdrawal` (PF-1 — a withdrawal the kernel admitted over a held level result). */
export function foldMatchWithStoppage<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  opts?: FoldOptions<State>,
): {
  state: State;
  stoppage: MatchStoppage | null;
  squads: SquadState;
  settlement: Settlement | null;
  expunged: boolean;
  levelWithdrawal: LevelWithdrawal | null;
} {
  const active = resolveVoids(events);
  const strictFromSeq = opts?.strictFromSeq;
  const forfeitAward = opts?.forfeitAward;
  const onFolded = opts?.onFolded;
  const postDecision = new Set([...POST_DECISION_CORE, ...(module.postDecisionTypes ?? [])]);
  const deciderTypes = new Set(module.deciderTypes); // absent ⇒ empty
  const duringStoppage = new Set(DURING_STOPPAGE);

  let state = module.init(cfg, lineups);
  let decided = false;
  let stoppage: MatchStoppage | null = null;
  // W2a (X-ST-1): the active settle, kept BESIDE module state (outcomeOf reads
  // it), and whether an accepted core.abandon is in the active ledger.
  let settlement: Settlement | null = null;
  let abandonActive = false;
  // W2b. `expunged`: the active abandon carries `expunge: true` (D5). `started`: an active core.start was folded —
  // the phase a hook-less fake is judged in (C17). `levelWithdrawal`: PF-1's admission. All three come from the
  // ACTIVE ledger (`resolveVoids` ran first), so a void of the abandon, the start or the withdrawal clears them.
  let expunged = false;
  let started = false;
  let levelWithdrawal: LevelWithdrawal | null = null;
  const walkoverPhases = module.walkoverPhases ?? DEFAULT_WALKOVER_PHASES;
  // W2e X-SE-1: the live end-level sanction no forfeit has followed yet (`pendingAfter`, the step the pad's reader
  // shares), over the ACTIVE ledger, so a void of the sanction or of its forfeit moves it.
  const admittedWhileEndingPending = new Set(ADMITTED_WHILE_ENDING_PENDING);
  let pendingEnding: PendingEndingSanction | null = null;

  // S3/W4b (#426) — the squads start as the team sheets declared them, with
  // positions intact, and the module is offered the snapshot immediately so its
  // own State and the kernel's can never be two constructions of one fact.
  // (a module with no `lineupPolicy` reaches the fallback only on REPLAY of a ledger that already holds a lineup event: the
  // write path refuses the event before the reducer is asked, see the gate below)
  const lineupPolicy = module.lineupPolicy?.(cfg) ?? DEFAULT_LINEUP_POLICY;
  let squads = initSquads(lineups);
  if (module.onLineup !== undefined) state = module.onLineup(state, squads);

  // W4a (#425) §3.3 — monotonic time guard. A timer only moves forward, but a
  // manually typed time (§4) can go anywhere, and an out-of-order stamp makes
  // lazy expiry silently wrong: a suspension started at seq 4 / 05:00 would
  // "expire" after one started at seq 3 / 08:00. Guarding here means all eleven
  // modules inherit it from one place and none of them changes.
  //
  // PHASE ORDER comes from the MODULE (§7). `module.playPhases(cfg)` is the one
  // source of order, and it has to be, for two reasons:
  //
  //  1. Deriving it from the stream fails open on the commonest manual-entry
  //     mistake there is. Order of first appearance made "P2 100 then P1 50"
  //     forward motion — P1 was unseen, so it was appended as the LATER phase —
  //     which is precisely the backwards stamp this guard exists to reject.
  //  2. A module's own `compareGameTime(…, playPhases)` calls inside apply()
  //     would otherwise be ordering against a different list than the guard. An
  //     event the guard accepted could then be backwards one layer down, and
  //     lazy expiry (§3.1) would sweep against an order nothing agrees on.
  //
  // A declared order is treated as EXHAUSTIVE — every phase in which a stamped
  // event may legally occur, including the ones where play is not running (a
  // pre-kickoff card, a shootout card). Nothing about the type makes that true;
  // it is an obligation on the module (§7), and the two ways a module can break
  // it are refused below rather than absorbed. A stamp naming a phase outside
  // the list is then INVALID_EVENT — the scorer picked a period this sport does
  // not have, which is payload validation, checked on EVERY stamp including the
  // first, where there is no high-water mark to compare against yet.
  //
  // FALLBACK, only when the module declares nothing: derive order of first
  // appearance, as above. Strictly weaker, and kept solely so a module that has
  // not yet declared its phases behaves exactly as it did before this wave.
  // On that path a period is registered before it is compared, so UNKNOWN_PHASE
  // can never escape the fold.
  const declaredPhases = module.playPhases?.(cfg);
  if (declaredPhases !== undefined) validateDeclaredPhases(declaredPhases);
  const phaseOrder: string[] = declaredPhases === undefined ? [] : [...declaredPhases];
  let highWater: GameTime | null = null;

  for (const [index, event] of active.entries()) {
    // §3.3 seam. Everything below whose verdict a cfg edit can move is gated on
    // this. `validateCoreEvent` is not: it is a payload-schema check on the
    // stream alone, and no config edit can change its answer.
    const strict = strictFromSeq !== undefined && event.seq >= strictFromSeq;
    validateCoreEvent(event);
    // Owner ruling 2026-10-15 (engine lineup fix). A lineup change for a sport that declares no `lineupPolicy` is refused
    // before any other guard, because nothing about the match's state can make it admissible: the answer is the sport's, not
    // the moment's (below it would read ALREADY_DECIDED after a result and WRONG_PHASE during a stoppage). `strict` only, like
    // every refusal a declaration decides: a ledger that already holds such an event was accepted when it was written, and a
    // replay that threw would brick the fixture with no event left to void (cfg and declarations are not the ledger's to
    // police retroactively). It keeps folding exactly as before, so no recorded fixture moves.
    if (strict && isLineupEventType(event.type) && !admitsLineupEvents(module)) {
      throw new EngineError(
        "LINEUP_NOT_SUPPORTED",
        `event "${event.type}" rejected: this sport does not record line-up changes`,
        { eventId: event.id, seq: event.seq, type: event.type },
      );
    }
    // W2e X-SE-1 (D3 (1)) — a sanction at a level the sport declares as match-ending waits for its ending, recorded as
    // its own event. Until then the write path takes only that ending or an abandon. `strict` only, in the shape of the
    // refusal above: a ledger written before W2e with play after a black card was accepted then, and replays exactly as
    // recorded (anti-goal 1). Not once the match is decided: guarantee 4 governs a finished match, so a note or a
    // finalize after a pre-W2e result is still admitted and a further rally answers ALREADY_DECIDED.
    if (strict && pendingEnding !== null && !decided && !admittedWhileEndingPending.has(event.type)) {
      throw new EngineError(
        "ENDING_SANCTION_PENDING",
        `event "${event.type}" rejected: a ${pendingEnding.level} sanction against ${pendingEnding.by} ends the match — record the ending (core.forfeit) or void the sanction first`,
        { by: pendingEnding.by, level: pendingEnding.level },
      );
    }
    // GUARANTEE 4 is deliberately NOT gated on `strict`, and the reason is
    // worth recording because it looks like an oversight. It IS cfg-derived at
    // one remove — `decided` comes from `module.outcome(state)`, folded against
    // a cfg read live — and lowering `bestOf`, `maxBoards` or cricket's
    // `playersPerSide` does decide a recorded match earlier on replay than it
    // decided when it was scored, which bricks it. But tolerating it HERE fixes
    // nothing: every module also refuses its own events once its state reaches
    // the terminal phase (`WRONG_PHASE: … not allowed in phase "done"`), so the
    // throw simply moves one layer down. Making that class readable is a
    // coordinated change across the kernel and all eleven modules, not a
    // one-line gate, and it is filed rather than half-done here.
    // Ruling D-C7 (spec §7): a decider event outside a pending decider — before
    // the game, live, after a win, a settle, a tie-break, a held double forfeit,
    // an abandon or a finalize — is the decider's own refusal, checked ABOVE
    // guarantee 4 so a decided fixture never answers ALREADY_DECIDED for it.
    // Not gated on `strict`, like guarantee 4 and the settle precondition.
    if (deciderTypes.has(event.type) && !deciderPending(module, { state, settlement, expunged, levelWithdrawal })) {
      throw new EngineError(
        "TIEBREAK_NOT_APPLICABLE",
        `event "${event.type}" rejected: no tie-break is pending — it follows only a drawn knockout game that nothing has decided yet`,
        { eventId: event.id, outcome: outcomeOf(module, { state, settlement, expunged, levelWithdrawal }) },
      );
    }
    // W2b D4 (X-AB-4) — a forfeit while an unvoided abandon is active. ABOVE guarantee 4 on purpose: a football
    // award-policy abandon DECIDES the match, so guarantee 4 would answer ALREADY_DECIDED first and hide the guidance
    // the organiser needs (settle to decide; void the abandon to replay). Voids resolve first, so void-then-forfeit
    // reaches the phase guard below instead (play started: retired, disqualified or withdrew — and a walkover while
    // nothing was played, ruling 112: an abandon is the kernel's, not play). Once a settle decided
    // the abandoned match there is nothing left to settle or replay, so it falls to guarantee 4: ALREADY_DECIDED
    // (review M-6).
    if (event.type === "core.forfeit" && abandonActive && settlement === null) {
      throw new EngineError(
        "ABANDONED_SETTLE_OR_VOID",
        "this match was abandoned — settle it to decide it, or void the abandon first if it is being replayed",
        { eventId: event.id },
      );
    }
    // W2b PF-1 (X-WD-1) — the one forfeit guarantee 4 admits: a withdrawal over a held LEVEL result that nothing has
    // settled (the effective outcome is still level). Walkover, retired and disqualified there stay ALREADY_DECIDED.
    // One-shot: once admitted the effective outcome is an award, so a second one answers ALREADY_DECIDED.
    const withdrawalOverLevel =
      decided &&
      event.type === "core.forfeit" &&
      forfeitReasonOf(event.payload) === "withdrew" &&
      isLevelOutcome(outcomeOf(module, { state, settlement, expunged, levelWithdrawal }));
    if (decided && !postDecision.has(event.type) && !withdrawalOverLevel) {
      throw new EngineError(
        "ALREADY_DECIDED",
        `event "${event.type}" rejected: match outcome already decided`,
        { eventId: event.id },
      );
    }
    if (stoppage !== null && !duringStoppage.has(event.type)) {
      throw new EngineError(
        "WRONG_PHASE",
        `event "${event.type}" rejected: play is suspended — resume or abandon first`,
        { eventId: event.id, stoppage },
      );
    }
    // W2b D3 (X-RS-1) — the phase guard, before the module sees the event, on every fold (strict or not: recorded
    // streams are migrated, Task 5). The phase is the module's own reading of its state, so a stoppage reads as the
    // phase it interrupted: retired, disqualified and withdrew stay admitted there, a walkover follows R2. R0: in
    // phase "over" nothing is judged here — the module's done/final guard and guarantee 4 answer as before.
    // Ruling 112: a walkover is judged in "pre" while nothing is played — `playRecorded` of the active ledger before
    // this event (`active` is void-resolved, so a voided sport event never counts).
    if (event.type === "core.forfeit") {
      const phase = forfeitPhaseOf(module, state, started, decided);
      if (phase !== "over") {
        const { by, reason } = forfeitOf(event.payload);
        const played = playRecorded(active.slice(0, index), module);
        const allowed = forfeitReasonsAllowed(phase, walkoverPhases, played);
        // R3 (W2b-R14): never both sides in a tie-break — the classical game was played.
        const bothRefused = by === "both" && phase === "tiebreak";
        if (!allowed.includes(reason) || bothRefused) {
          throw new EngineError(
            "FORFEIT_REASON_WRONG_PHASE",
            bothRefused
              ? `a double walkover is not recordable in phase "${phase}": the game was played — record one side's walkover or withdrawal`
              : `forfeit reason "${reason}" is not recordable in phase "${phase}" — allowed here: ${allowed.join(", ")}`,
            // `played` (ruling 113): the phase reads "play" from the Start, but a retirement waits for play — the copy
            // names "nothing played yet" rather than "once play has started" for that refusal.
            { eventId: event.id, phase, reason, both: by === "both", allowed, bothAllowed: doubleWalkoverAdmitted(phase, allowed), played },
          );
        }
      }
    }
    // The time guard runs ABOVE the kernel-owned branches below, so a
    // core.suspend / core.resume stamp is checked and counted like any other.
    // Inside the module branch it would have been dead code for the one pair
    // §1.2 names as the reason the model is game clock at all.
    //
    // Two carve-outs, both load-bearing (§3.3):
    //  - An UNSTAMPED event is unconstrained. gameTimeOf returns null for every
    //    payload written before this wave, so no recorded stream changes
    //    meaning — this null is what makes the wave additive. It is neither
    //    checked against the high-water mark nor allowed to advance it.
    //  - An EQUAL stamp is legal. core.suspend and its core.resume share one
    //    (§1.2) — in a clock-stop sport that is the NORMAL reading, not an edge
    //    case — and so do two penalties awarded at a single whistle. Only a
    //    strictly earlier stamp throws.
    //
    // CORRECTIONS (§4.1) need no third carve-out. `active` is the post-void
    // stream, so a mis-typed stamp that has been voided is not there to be
    // beaten and its replacement lands forward of whatever survives. The limit
    // is deliberate: a correction re-appended BEHIND a still-live later stamp
    // is rejected, because the fold applies events in append order and a
    // replacement carrying an earlier time would sweep lazy expiry against an
    // order nothing agrees on. Void back to the mistake, then re-append.
    const at = gameTimeOf(event.payload);
    if (at !== null) {
      if (!phaseOrder.includes(at.period)) {
        if (declaredPhases !== undefined && strict) {
          // INVALID_EVENT, not UNKNOWN_PHASE. `at.period` is a free string the
          // client supplies, so this is a typo or a stale pad sending a period
          // this sport does not have — the same class of mistake as any other
          // bad payload field, and the scorer can retype it. Raising the
          // internal-invariant code here made a typo a 500 and a page; naming
          // the valid phases makes it fixable at the pad instead.
          //
          // STRICT ONLY, and the comment above is the reason: every word of it
          // is about an event being entered NOW. Applied to history the same
          // check says something else entirely — that an organiser lowering
          // `bestOf`, cutting an overtime period or renaming a phase has made
          // every already-scored fixture in the division throw on every read,
          // with no event to void. The stamp was legal when it was recorded;
          // what changed is cfg, and cfg is not the ledger's to police
          // retroactively.
          throw new EngineError(
            "INVALID_EVENT",
            `event "${event.type}" is stamped in period "${at.period}", which this sport does not have — expected one of ${phaseOrder.join(", ")}`,
            { eventId: event.id, seq: event.seq, period: at.period, phaseOrder: [...phaseOrder] },
          );
        }
        // On replay, and on the undeclared-module fallback, the period is
        // REGISTERED rather than refused — the event still reaches the module
        // and still folds. Appending puts it after every phase the cfg still
        // declares, which is a guess; the monotonic check below is what stops
        // that guess from turning into a second refusal.
        phaseOrder.push(at.period);
      }
      const backwards = highWater !== null && compareGameTime(at, highWater, phaseOrder) < 0;
      if (backwards && strict) {
        throw new EngineError(
          "NON_MONOTONIC_TIME",
          `event "${event.type}" is stamped ${at.period} ${at.elapsed}s, before the newest accepted stamp ${(highWater as GameTime).period} ${(highWater as GameTime).elapsed}s`,
          { eventId: event.id, seq: event.seq, at, previous: highWater },
        );
      }
      // A backwards stamp on REPLAY is accepted and the event still dispatches,
      // but the high-water mark is deliberately not moved backwards. This guard
      // orders against `playPhases(cfg)`, so a cfg edit alone can turn a run
      // that was forward when it was recorded into a backwards one — a fact
      // about the config, not about the ledger. Leaving the mark at the
      // furthest-forward stamp keeps the check at full strength for the
      // candidate, the one event whose order a scorer can still fix.
      if (!backwards) highWater = at;
    }
    if (withdrawalOverLevel) {
      // W2b PF-1 — kernel-owned, folded beside module state like a settle; the module never sees it.
      const { by } = forfeitOf(event.payload);
      const { home, away } = { home: lineups.home.entrantId, away: lineups.away.entrantId };
      if (by !== home && by !== away) {
        throw new EngineError("INVALID_EVENT", `core.forfeit by "${by}" is neither side of this fixture`, { eventId: event.id });
      }
      levelWithdrawal = { winner: by === home ? away : home, loser: by, eventId: event.id };
    } else if (!kernelOwnsEvent(module, event, { state, settled: settlement !== null })) {
      // W2a I-1: ONE gate decides what the module sees — `kernelOwnsEvent`,
      // the same predicate every replay loop outside the engine must skip on.
      // The seam reaches the module too. Three of the eleven re-validate the
      // stamp inside apply() — not redundantly, because the testkit calls
      // apply() directly — and nested/kernel refuses an interruption against a
      // cfg allowance. Each is the same fixture-bricking shape as the guard
      // above and needs the same signal; the other eight ignore the argument.
      // W2c Task 16b: the stage rule's award reaches the module only for a forfeit with nothing played - decided HERE,
      // from the active ledger before this event (the one `playRecorded` reading), never by the module.
      const award =
        forfeitAward !== undefined && event.type === "core.forfeit" && unplayedForfeitEvent(event.payload, playRecorded(active.slice(0, index), module))
          ? forfeitAward
          : undefined;
      state = module.apply(state, event, award === undefined ? { strict, squads } : { strict, squads, forfeitAward: award });
      if (event.type === "core.start") started = true;
      if (event.type === "core.abandon") {
        abandonActive = true;
        expunged = (event.payload as z.infer<typeof CoreAbandon>).expunge === true;
      }
      if (!decided) {
        decided = module.outcome(state) !== null;
        // A decided match is not awaiting resumption. core.abandon and
        // core.forfeit are both legal mid-stoppage and both decide, and
        // core.resume is not a post-decision type — so a stoppage left open
        // here could never be cleared, and the read side would show an
        // abandoned match as "play suspended, awaiting restart" forever.
        if (decided) stoppage = null;
      }
    } else if (event.type === "core.settle") {
      // X-ST-1 precondition (spec §5.1). Not gated on `strict` (D2): the
      // module outcome it reads is folded against the frozen cfg, and the
      // shape "level, or abandoned with nothing" does not move with cfg.
      const effective = outcomeOf(module, { state, settlement, expunged, levelWithdrawal });
      // W2b D5: an expunged match left the table — there is nothing to settle (void the abandon first). Without this
      // the settle would be accepted and read as nothing, since `outcomeOf` answers null while expunged.
      const applies = !expunged && settleApplies(module, { outcome: effective, abandoned: abandonActive, state });
      // W2b D6 (finding 4): a settle recorded before W2b over a chess double forfeit — then a held no_result, now a
      // double walkover — still REPLAYS, and the settlement wins. A new write of it is refused like any other.
      const legacySettle = !strict && effective?.kind === "double_walkover";
      if (!applies && !legacySettle) {
        throw new EngineError(
          "SETTLE_NOT_APPLICABLE",
          settlement !== null
            ? "this fixture is already settled — void the settle first"
            : expunged
              ? "this match was expunged by a withdrawal — void the abandon first"
              : "settle applies only to a level result, an abandoned match with no result, or a pending tie-break",
          // `expunged` only when true, so the refusal every pre-W2b reader parses keeps its shape.
          { eventId: event.id, outcome: effective, abandoned: abandonActive, ...(expunged ? { expunged } : {}) },
        );
      }
      const p = event.payload as z.infer<typeof CoreSettle>;
      const { home, away } = { home: lineups.home.entrantId, away: lineups.away.entrantId };
      if (p.winner !== home && p.winner !== away) {
        throw new EngineError("INVALID_EVENT", `core.settle winner "${p.winner}" is neither side of this fixture`, { eventId: event.id });
      }
      settlement = { winner: p.winner, loser: p.winner === home ? away : home, method: p.method, eventId: event.id };
      decided = true;
      stoppage = null;
      // kernel-owned: the module never sees it
    } else if (event.type === "core.suspend") {
      // Guarded by the WRONG_PHASE branch above, so this is the first suspend.
      const reason = (event.payload as z.infer<typeof CoreSuspend>).reason;
      // `at` is the stamp the guard above validated and counted, so the open
      // stoppage and the high-water mark can never disagree about when play
      // stopped. Absent when the pad recorded none (§1.2).
      stoppage = {
        ...(reason === undefined ? {} : { reason }),
        eventId: event.id,
        ...(at === null ? {} : { at }),
      };
      // kernel-owned: the module never sees it
    } else if (event.type === "core.resume") {
      // A resume with no open stoppage is a NO-OP, not an error. Undo is void
      // (guarantee 3): voiding a mis-entered core.suspend leaves the resume
      // that followed it pointing at nothing, which is meaningless but not
      // contradictory — refusing it made the whole match unfoldable until the
      // scorer also voided the resume, which is not an undo anyone would find.
      stoppage = null;
      // kernel-owned: the module never sees it
    } else if (isLineupEventType(event.type)) {
      // THE POLICY IS THE SEAM (§3.3), not a second `if (strict)` around each
      // check. On the write path the variant's own policy applies and a
      // refusal is an error the scorer can still fix. On REPLAY the reducer
      // runs against REPLAY_LINEUP_POLICY — every knob at its most permissive
      // — so no cfg-derived condition can refuse at all. That is the whole
      // reason the reducer takes a policy rather than reading cfg itself: an
      // organiser tightening `maxSubs`, or switching a variant from rolling
      // substitution to no-return, must not make every already-scored fixture
      // in the division unreadable. cfg is not the ledger's to police
      // retroactively.
      const reduced = reduceLineupEvent(
        squads,
        event,
        strict ? lineupPolicy : REPLAY_LINEUP_POLICY,
      );
      if (!reduced.ok) {
        if (strict) {
          throw new EngineError("LINEUP_INVALID", reduced.message, {
            eventId: event.id,
            seq: event.seq,
            reason: reduced.reason,
          });
        }
        // Replay reaches here only for a STRUCTURAL refusal — an unknown
        // person, someone taken off who was not on — which no config edit
        // can make coherent and which there is no longer an event to void. The
        // squads are left as they were and the fixture stays readable. Note
        // this is a no-op and NOT an approximation: applying half a swap would
        // put the squads in a state no ledger ever recorded.
      } else {
        squads = reduced.squads;
        if (module.onLineup !== undefined) state = module.onLineup(state, squads);
      }
      // kernel-owned: the module never sees it
    } else if (event.type === "core.finalize") {
      // kernelOwnsEvent's one CONDITIONAL member — core.finalize on a settled
      // fixture the module has not decided (a settled abandon, a settled pending
      // tie-break): modules refuse to finalize an undecided state (plan finding 21).
      // kernel-owned: the module never sees it
    } else {
      // Review N1: an assumption is a guard. kernelOwnsEvent claimed this type and
      // no branch above folds it — a type added to KERNEL_OWNED_CORE without its
      // branch. Silently dropping it would fold the ledger as if the event never
      // happened. A plain Error, not an EngineError: only a bug reaches it, so it
      // must surface as a 500 rather than a refusal a scorer is asked to fix.
      throw new Error(
        `foldMatchWithStoppage: kernelOwnsEvent claims "${event.type}" but no kernel branch folds "${event.type}" — ` +
          "a type added to KERNEL_OWNED_CORE owes its branch in the fold's dispatch",
      );
    }
    // Below every branch: the event was accepted, kernel-owned or the module's.
    pendingEnding = pendingAfter(module.sanctionEnding, pendingEnding, event);
    // ONE call site, below every branch, so a kernel-owned event is observed
    // exactly like a module event — see `FoldOptions.onFolded`.
    onFolded?.(state, event, squads);
  }
  return { state, stoppage, squads, settlement, expunged, levelWithdrawal };
}
