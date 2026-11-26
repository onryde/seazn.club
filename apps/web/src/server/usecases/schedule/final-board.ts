/**
 * The board an auto pass leaves behind: `applySchedule` writes only the rows a proposal lists, so every
 * other card keeps its stored slot. A proposal is therefore judged together with those slots, by the
 * write gate's own verdict.
 */
import {
  dayKeyInTz,
  isBlockingConflict,
  roundSequenceKey,
  RULE_BY_REASON,
  validateAssignments,
  validateInstructionRules,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { pairRoundBreach } from "./held";

const MS_PER_MIN = 60_000;

/**
 * Gate calls that take back only what each refusal implicates. The gate judges the whole proposal, about a
 * second at 500 rows, so the calls are capped: the one after these widens to every move of each refused
 * round sequence, the next takes every move back, and the last confirms that.
 */
export const PRECISE_GATE_CALLS = 5;
export const MAX_GATE_CALLS = PRECISE_GATE_CALLS + 3;

export const sameSlot = (a: Assignment, b: Assignment | undefined): boolean =>
  b !== undefined && a.court === b.court && a.startAt === b.startAt;

export interface SettleInput {
  /** The pass's new placements, pins included. */
  proposed: readonly Assignment[];
  /** Cards listed exactly where they are because they start before the floor. */
  held: readonly Assignment[];
  /** Where every other card of the run that has a time is now. */
  stored: ReadonlyMap<string, Assignment>;
  /** Every card with a time now, the ones outside the run (played, other stages and divisions) included. */
  standing: ReadonlyMap<string, Assignment>;
  /** The write gate's config. */
  config: SlotConfig & VerifyConfig;
  /** POLISH: a card the pass does not place again stays on the proposal, where it is. */
  keepStored: boolean;
  /** What the write gate would refuse about a proposal listing exactly `rows`. */
  refuses: (rows: readonly Assignment[]) => readonly Conflict[];
}

export interface Settled {
  /** The new placements the write gate accepts. */
  fresh: Assignment[];
  /** Cards listed at their stored slot besides the held ones (POLISH only). */
  kept: Assignment[];
  /** Placements taken back, each with the reason that is about it. */
  refused: Map<string, Conflict>;
}

const sequenceOf = (a: Assignment | undefined): string | undefined =>
  a?.roundNo === undefined ? undefined : roundSequenceKey(a);

/** `why` as said on the card `id`: filed on another card, that card becomes the one it is with. */
const saidOn = (why: Conflict, id: string): Conflict =>
  why.fixtureId === id
    ? why
    : {
        ...why,
        fixtureId: id,
        ...(why.details !== undefined ? { details: { ...why.details, otherFixtureId: why.fixtureId } } : {}),
      };

const shares = (a: readonly string[], b: readonly string[]): boolean => a.some((x) => b.includes(x));

/**
 * What the gate would say of `card` beside `fixed`, from those two alone: their round order, then a court
 * or a player they would both have. The cheap tests only pick which pairs the engine's rules are asked about.
 */
function pairRefusal(card: Assignment, fixed: Assignment, config: SlotConfig & VerifyConfig): Conflict | undefined {
  const sequence = sequenceOf(card);
  if (sequence !== undefined && sequence === sequenceOf(fixed) && card.roundNo !== fixed.roundNo) {
    const [early, late] = card.roundNo! < fixed.roundNo! ? [card, fixed] : [fixed, card];
    if (late.startAt < early.endAt + (early.roundGapMinutes ?? 0) * MS_PER_MIN) {
      const breach = pairRoundBreach(card, fixed, config.tz);
      if (breach !== undefined) {
        return { ...breach, fixtureId: card.fixtureId, details: { ...breach.details!, otherFixtureId: fixed.fixtureId } };
      }
    }
  }
  const gap = config.gapMinutes * MS_PER_MIN;
  if (card.startAt - gap >= fixed.endAt || fixed.startAt >= card.endAt + gap) return undefined;
  if (card.court !== fixed.court && !shares(card.entrants, fixed.entrants) && !shares(card.people, fixed.people)) {
    return undefined;
  }
  return validateAssignments([card], config, [fixed], [], false).find(
    (c) => isBlockingConflict(c) && c.details?.otherFixtureId === fixed.fixtureId,
  );
}

/**
 * Takes placements back until the write gate accepts the proposal. A refused card falls back to its
 * stored slot (or to no time), which can in turn refuse a placement made around where it was going; those
 * are followed here, pair by pair, so a chain does not cost a gate call a link. It ends within
 * `MAX_GATE_CALLS`: each call but the last takes a card back, and a proposal that changes nothing
 * introduces nothing.
 */
export function settleProposal({ proposed, held, stored, standing, config, keepStored, refuses }: SettleInput): Settled {
  const fresh = new Map(proposed.map((a) => [a.fixtureId, a]));
  const refused = new Map<string, Conflict>();
  const rowOf = new Map([...standing, ...fresh]);
  const changes = (id: string): boolean => {
    const row = fresh.get(id);
    return row !== undefined && !sameSlot(row, stored.get(id));
  };

  /** The cards to take back for `verdict`: for each refusal, the moved card or cards it is about. */
  const implicated = (verdict: readonly Conflict[], moved: readonly Assignment[]): Map<string, Conflict> => {
    const victims = new Map<string, Conflict>();
    /** `sequence#round` of every victim. */
    const goingBack = new Set<string>();
    const take = (id: string, why: Conflict): void => {
      if (victims.has(id)) return;
      victims.set(id, saidOn(why, id));
      goingBack.add(`${sequenceOf(rowOf.get(id))}#${rowOf.get(id)?.roundNo}`);
    };
    // A refusal on a card that stays: only what moved against it can give way.
    for (const c of verdict) {
      if (changes(c.fixtureId)) continue;
      const other = c.details?.otherFixtureId;
      if (other !== undefined && changes(other)) {
        take(other, c);
        continue;
      }
      // A round-order refusal names no card, only the other round (or the over-full day).
      const sequence = sequenceOf(rowOf.get(c.fixtureId));
      if (sequence === undefined) continue;
      const inSequence = moved.filter((a) => sequenceOf(a) === sequence);
      if (c.details?.kind === "rounds_per_day") {
        for (const a of inSequence) if (dayKeyInTz(a.startAt, config.tz!) === c.details.day) take(a.fixtureId, c);
        continue;
      }
      const ofRound = inSequence.filter((a) => a.roundNo === c.details?.otherRoundNo);
      const filedOn = standing.get(c.fixtureId);
      const breaking = filedOn === undefined ? [] : ofRound.filter((a) => pairRoundBreach(a, filedOn, config.tz));
      for (const a of breaking.length > 0 ? breaking : ofRound) take(a.fixtureId, c);
    }
    // A refusal on a card that moved: one card per conflict, so where its counterpart (the card, or one
    // of the round, it names) is already going back, it may stand.
    for (const c of verdict) {
      if (!changes(c.fixtureId)) continue;
      const other = c.details?.otherFixtureId;
      if (other !== undefined && victims.has(other)) continue;
      const round = c.details?.otherRoundNo;
      if (round !== undefined && goingBack.has(`${sequenceOf(rowOf.get(c.fixtureId))}#${round}`)) continue;
      take(c.fixtureId, c);
    }
    return victims;
  };

  /** The first refusal of each round sequence `verdict` touches. */
  const bySequence = (verdict: readonly Conflict[]): Map<string, Conflict> => {
    const first = new Map<string, Conflict>();
    for (const c of verdict) {
      const sequence = sequenceOf(rowOf.get(c.fixtureId));
      if (sequence !== undefined && !first.has(sequence)) first.set(sequence, c);
    }
    return first;
  };

  /** Takes back whatever the gate would now refuse beside a card that went back to its stored slot. */
  const follow = (taken: string[]): void => {
    for (const id of taken) {
      const back = stored.get(id);
      if (back === undefined) continue;
      for (const [other, row] of fresh) {
        if (!changes(other)) continue;
        const why = pairRefusal(row, back, config);
        if (why === undefined) continue;
        // Already so where the two are now: the move introduces nothing.
        const was = stored.get(other);
        if (was !== undefined && pairRefusal(was, back, config) !== undefined) continue;
        fresh.delete(other);
        refused.set(other, why);
        taken.push(other);
      }
    }
  };

  for (let call = 1; ; call++) {
    const kept = keepStored ? [...stored.values()].filter((a) => !fresh.has(a.fixtureId)) : [];
    const verdict = refuses([...fresh.values(), ...held, ...kept]);
    if (verdict.length === 0) return { fresh: [...fresh.values()], kept, refused };
    const moved = [...fresh.values()].filter((a) => changes(a.fixtureId));
    if (moved.length === 0) {
      throw new Error("auto pass: the write gate refuses a proposal that moves no card");
    }
    const victims = call <= PRECISE_GATE_CALLS + 1 ? implicated(verdict, moved) : new Map<string, Conflict>();
    // Wider only where nothing is implicated, or the narrow calls are spent: the refused sequences.
    if (call === PRECISE_GATE_CALLS + 1 || (call <= PRECISE_GATE_CALLS && victims.size === 0)) {
      const reasons = bySequence(verdict);
      for (const a of moved) {
        const why = reasons.get(sequenceOf(a) ?? "");
        if (why !== undefined && !victims.has(a.fixtureId)) victims.set(a.fixtureId, saidOn(why, a.fixtureId));
      }
    }
    // Then every move. A card is told only a refusal of its own sequence, never another's.
    if (victims.size === 0) {
      const reasons = bySequence(verdict);
      for (const a of moved) {
        const why = verdict.find((c) => c.fixtureId === a.fixtureId) ?? reasons.get(sequenceOf(a) ?? "");
        victims.set(
          a.fixtureId,
          why !== undefined
            ? saidOn(why, a.fixtureId)
            : { fixtureId: a.fixtureId, reason: "no_slot", rule: RULE_BY_REASON.no_slot },
        );
      }
    }
    for (const [id, why] of victims) {
      fresh.delete(id);
      refused.set(id, why);
    }
    follow([...victims.keys()]);
  }
}

/**
 * What the verifier says about cards listed exactly where they already are. The engine is never asked
 * about them (a held card is an obstacle to it, a kept one it did not place there), so a clash one of
 * them is in is reported from here, as the engine reports a pin's. `others` is the rest of the board.
 */
export function storedSlotConflicts(
  cards: readonly Assignment[],
  config: SlotConfig & VerifyConfig,
  others: readonly Assignment[],
  dependencies: readonly OrderDependency[],
): Conflict[] {
  if (cards.length === 0) return [];
  const ids = new Set(cards.map((a) => a.fixtureId));
  return [
    ...validateAssignments(cards, config, others, dependencies).filter((c) => ids.has(c.fixtureId)),
    ...validateInstructionRules(cards, config, others),
  ];
}
