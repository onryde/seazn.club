/**
 * The board an auto pass leaves behind: `applySchedule` writes only the rows a proposal lists, so every
 * other card keeps its stored slot. A proposal is therefore judged together with those slots, by the
 * write gate's own verdict.
 */
import {
  validateAssignments,
  validateInstructionRules,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";

export const sameSlot = (a: Assignment, b: Assignment | undefined): boolean =>
  b !== undefined && a.court === b.court && a.startAt === b.startAt;

export interface SettleInput {
  /** The pass's new placements, pins included. */
  proposed: readonly Assignment[];
  /** Cards listed exactly where they are because they start before the floor. */
  held: readonly Assignment[];
  /** Where every other card of the run that has a time is now. */
  stored: ReadonlyMap<string, Assignment>;
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
  /** Placements taken back, with what the gate said about each. */
  refused: Map<string, Conflict>;
}

/**
 * Takes placements back until the write gate accepts the proposal. A refused card falls back to its
 * stored slot (or to no time), which can in turn refuse a placement made around where it was going, so
 * this repeats. It ends: each round takes at least one card back, and a proposal that changes nothing
 * introduces nothing.
 */
export function settleProposal({ proposed, held, stored, keepStored, refuses }: SettleInput): Settled {
  const fresh = new Map(proposed.map((a) => [a.fixtureId, a]));
  const refused = new Map<string, Conflict>();
  const changes = (id: string): boolean => {
    const row = fresh.get(id);
    return row !== undefined && !sameSlot(row, stored.get(id));
  };
  for (;;) {
    const kept = keepStored ? [...stored.values()].filter((a) => !fresh.has(a.fixtureId)) : [];
    const verdict = refuses([...fresh.values(), ...held, ...kept]);
    if (verdict.length === 0) return { fresh: [...fresh.values()], kept, refused };
    const victims = new Map<string, Conflict>();
    for (const c of verdict) {
      const other = c.details?.otherFixtureId;
      // One card per conflict: with the one that moved taken back, the other may stand.
      if (changes(c.fixtureId)) victims.set(c.fixtureId, c);
      else if (other !== undefined && changes(other)) {
        victims.set(other, { ...c, fixtureId: other, details: { ...c.details!, otherFixtureId: c.fixtureId } });
      }
    }
    // A refusal that names no card this proposal moved: take every move back rather than offer it.
    if (victims.size === 0) {
      for (const id of fresh.keys()) if (changes(id)) victims.set(id, { ...verdict[0]!, fixtureId: id });
    }
    if (victims.size === 0) {
      throw new Error("auto pass: the write gate refuses a proposal that moves no card");
    }
    for (const [id, why] of victims) {
      fresh.delete(id);
      refused.set(id, why);
    }
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
