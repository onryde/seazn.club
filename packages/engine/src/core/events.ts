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
import { GameTime, compareGameTime, gameTimeOf } from "./time.ts";
import { EntrantId, isLevelOutcome, type LineupPair, type MatchOutcome } from "./types.ts";

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
export const CoreForfeit = z.strictObject({ by: EntrantId, reason: z.string().min(1) });
export const CoreAbandon = z.strictObject({ reason: z.string().min(1) });

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
export function forfeitOf(payload: unknown): { by: string; reason: string } {
  return CoreForfeit.parse(payload);
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
  return f.abandoned || module.awaitingDecider?.(f.state as never) === true;
}

/** THE outcome of a fold. A settlement outranks the module's own outcome (a
 *  draw it settled, or the null of an abandon); otherwise it is exactly
 *  `module.outcome(state)`. Every reader of a fold's outcome calls this
 *  (apps/web outcome-readers.test.ts pins the list). */
export function outcomeOf<Cfg, State>(
  module: Pick<FoldableModule<Cfg, State>, "outcome">,
  folded: { readonly state: State; readonly settlement: Settlement | null },
): MatchOutcome | null {
  const s = folded.settlement;
  if (s !== null) return { kind: "win", winner: s.winner, loser: s.loser, method: settledMethod(s.method) };
  return module.outcome(folded.state);
}

/** Ruling D-C5 — a module-declared decider is still OWED: the module's hook says one is pending AND the fold is not
 *  decided (no outcome and no active settle). A surface offering the decider (the chess pad's tie-break panel) gates
 *  on THIS, never on the module phase alone: a settle in phase "tiebreak" leaves the module state as it was. */
export function deciderPending<Cfg, State>(
  module: Pick<FoldableModule<Cfg, State>, "outcome" | "awaitingDecider">,
  folded: { readonly state: State; readonly settlement: Settlement | null },
): boolean {
  return module.awaitingDecider?.(folded.state) === true && outcomeOf(module, folded) === null;
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
   * Absent ⇒ DEFAULT_LINEUP_POLICY — no growth, no return, no exemption, no
   * cap. Nothing a module could do before this wave becomes impossible, and
   * nothing new becomes possible without a variant asking for it.
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
 *  returns, because core.suspend / core.resume never reach the module. */
export function foldMatchWithStoppage<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  opts?: FoldOptions<State>,
): { state: State; stoppage: MatchStoppage | null; squads: SquadState; settlement: Settlement | null } {
  const active = resolveVoids(events);
  const strictFromSeq = opts?.strictFromSeq;
  const onFolded = opts?.onFolded;
  const postDecision = new Set([...POST_DECISION_CORE, ...(module.postDecisionTypes ?? [])]);
  const duringStoppage = new Set(DURING_STOPPAGE);

  let state = module.init(cfg, lineups);
  let decided = false;
  let stoppage: MatchStoppage | null = null;
  // W2a (X-ST-1): the active settle, kept BESIDE module state (outcomeOf reads
  // it), and whether an accepted core.abandon is in the active ledger.
  let settlement: Settlement | null = null;
  let abandonActive = false;

  // S3/W4b (#426) — the squads start as the team sheets declared them, with
  // positions intact, and the module is offered the snapshot immediately so its
  // own State and the kernel's can never be two constructions of one fact.
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

  for (const event of active) {
    // §3.3 seam. Everything below whose verdict a cfg edit can move is gated on
    // this. `validateCoreEvent` is not: it is a payload-schema check on the
    // stream alone, and no config edit can change its answer.
    const strict = strictFromSeq !== undefined && event.seq >= strictFromSeq;
    validateCoreEvent(event);
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
    if (decided && !postDecision.has(event.type)) {
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
    if (event.type === "core.settle") {
      // X-ST-1 precondition (spec §5.1). Not gated on `strict` (D2): the
      // module outcome it reads is folded against the frozen cfg, and the
      // shape "level, or abandoned with nothing" does not move with cfg.
      const effective = outcomeOf(module, { state, settlement });
      if (!settleApplies(module, { outcome: effective, abandoned: abandonActive, state })) {
        throw new EngineError(
          "SETTLE_NOT_APPLICABLE",
          settlement !== null
            ? "this fixture is already settled — void the settle first"
            : "settle applies only to a level result, an abandoned match with no result, or a pending tie-break",
          { eventId: event.id, outcome: effective, abandoned: abandonActive },
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
    } else if (event.type === "core.finalize" && settlement !== null && module.outcome(state) === null) {
      // Plan finding 21: a settled ABANDON has no module outcome, and modules
      // refuse to finalize an undecided state. The kernel owns finalize exactly
      // here.
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
    } else {
      // The seam reaches the module too. Three of the eleven re-validate the
      // stamp inside apply() — not redundantly, because the testkit calls
      // apply() directly — and nested/kernel refuses an interruption against a
      // cfg allowance. Each is the same fixture-bricking shape as the guard
      // above and needs the same signal; the other eight ignore the argument.
      state = module.apply(state, event, { strict, squads });
      if (event.type === "core.abandon") abandonActive = true;
      if (!decided) {
        decided = module.outcome(state) !== null;
        // A decided match is not awaiting resumption. core.abandon and
        // core.forfeit are both legal mid-stoppage and both decide, and
        // core.resume is not a post-decision type — so a stoppage left open
        // here could never be cleared, and the read side would show an
        // abandoned match as "play suspended, awaiting restart" forever.
        if (decided) stoppage = null;
      }
    }
    // ONE call site, below every branch, so a kernel-owned event is observed
    // exactly like a module event — see `FoldOptions.onFolded`.
    onFolded?.(state, event, squads);
  }
  return { state, stoppage, squads, settlement };
}
