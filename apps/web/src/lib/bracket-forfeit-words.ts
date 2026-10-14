// W2b Task 13 — each bracket card's and schedule row's forfeit tag and sentence. Its own module (fix round 1): the
// client `schedule.tsx` needs it, and it lived in the Server Component `bracket.tsx`, whose value import of the
// `@seazn/engine/scheduling` barrel (server-only THEN: it reached the gRPC client; the client now lives in `@seazn/scheduler`)
// then reached the browser bundle (`next build`: Module not found: dns).
// Keep this module's imports client-safe — client-graph-no-server-barrel.test.ts sweeps every client root.
import type { PublicFixture } from "@/server/public-site/data";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import {
  doubleWalkoverNextWinner,
  forfeitCopyLookup,
  forfeitLedgerOfReason,
  forfeitTag,
  forfeitWords,
  type ForfeitCopy,
  type ForfeitWords,
} from "@/lib/forfeit-tag";

/**
 * W2b Task 13 — each bracket card's tag and sentence, by fixture id: `forfeitTag` over the fixture's outcome and the
 * ledger the public read carries (`abandon_reason`), worded from the pre-resolved copy. A double walkover names the
 * side its next match was walked over to when the line feeds one (`feedsNextMatch`, `doubleWalkoverNextWinner`) —
 * the stage's own fixtures are all here. An abandon has no result sentence on a tile, so it names its reason alone.
 */
export function bracketForfeitWords(
  fixtures: readonly PublicFixture[],
  entrantNames: Readonly<Record<string, string>>,
  copy: ForfeitCopy | undefined,
): ReadonlyMap<string, ForfeitWords> {
  const out = new Map<string, ForfeitWords>();
  if (copy === undefined) return out;
  const lookup = forfeitCopyLookup(copy);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const nameOf = (id: string) => entrantNames[id] ?? "?";
  for (const f of fixtures) {
    const tag = forfeitTag(f.outcome, forfeitLedgerOfReason(f.abandon_reason), f);
    if (tag === null) continue;
    const next =
      tag.kind === "double_walkover"
        ? doubleWalkoverNextWinner(
            feedsNextMatch({ winner_to_fixture: f.winner_to_fixture ?? null, loser_to_fixture: f.loser_to_fixture ?? null }),
            f.winner_to_fixture ? byId.get(f.winner_to_fixture) : null,
          )
        : null;
    out.set(f.id, forfeitWords(tag, lookup, nameOf, { next: next === null ? null : nameOf(next) }));
  }
  return out;
}
