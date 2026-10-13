import "server-only";
// W2c Task 9 (X-PT-1, owner P-3 "A") — the "was anything played" fact a stage PointsRule reads of a forfeit. A stored
// award carries no played marker (review I7), so the fact is read from the fixture's ledger, by W2b's ONE reader
// (`playRecorded`, rulings 112–115, 118, 120, 127) under the division's module (ruling 118: chess's Start is play).
// `awarded-state.ts` derives no such fact (an event-less award, ruling 116, has no ledger: nothing played), so this is
// the one place the server asks it. Two readers share it: the standings fold (`engine-db/competition.ts`) and the
// public qualification view's loaders (`public-site/division-qualification.ts`), so the table and its what-if cannot
// disagree about where the rule's awarded score lands.
import type postgres from "postgres";
import { EngineError, playRecorded, type MatchOutcome } from "@seazn/engine/core";
import { forfeitShaped } from "@seazn/engine/competition";

type Queryable = postgres.ISql;

/** An outcome a forfeit could have decided (`forfeitShaped`: an award, or a win by walkover or forfeit). Any other is
 *  not asked: `applyPointsRule` reads `played` only for these. */
function asksPlayed(outcome: unknown): boolean {
  return outcome !== null && typeof outcome === "object" && forfeitShaped(outcome as MatchOutcome);
}

/**
 * fixture id → `playRecorded` of its ledger, for each forfeit-shaped fixture of `fixtures` and no other. ONE query for
 * the lot, and none when no fixture is forfeit-shaped (the empty case). A forfeit-shaped fixture with no ledger at all
 * (a bye or an award the server wrote without an event) had nothing played.
 */
export async function forfeitPlayedFacts(
  db: Queryable,
  fixtures: readonly { id: string; outcome: unknown }[],
  module_: { readonly startIsPlay?: boolean },
): Promise<Map<string, boolean>> {
  const ids = [...new Set(fixtures.filter((f) => asksPlayed(f.outcome)).map((f) => f.id))];
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const rows = await db<{ fixture_id: string; id: string; type: string; voids: string | null }[]>`
    select fixture_id, id, type, voids_event_id as voids
    from score_events
    where fixture_id in ${db(ids)}
    order by fixture_id, seq`;
  const ledgers = new Map<string, { id: string; type: string; voids: string | null }[]>(ids.map((id) => [id, []]));
  for (const r of rows) ledgers.get(r.fixture_id)?.push(r);
  for (const [id, ledger] of ledgers) out.set(id, playRecorded(ledger, module_));
  return out;
}

/**
 * The `played` argument for `applyPointsRule` on one fixture: its ledger's answer when its outcome is forfeit-shaped.
 * A forfeit-shaped fixture `facts` does not cover was never read — refused, never guessed: a guess either pays a played
 * match the forfeit row or an unplayed one base points. Any other outcome is not asked by the rule and passes `false`
 * (never read: `isUnplayedForfeit` answers it from the outcome alone).
 */
export function playedFor(f: { id: string; outcome: unknown }, facts: ReadonlyMap<string, boolean>): boolean {
  if (!asksPlayed(f.outcome)) return false;
  const played = facts.get(f.id);
  if (played === undefined) {
    throw new EngineError("CONFIG_INVALID", `fixture ${f.id}: a forfeit's played fact was not read`, { fixtureId: f.id });
  }
  return played;
}
