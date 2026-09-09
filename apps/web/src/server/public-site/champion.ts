// Spectator surface W2, Task 4 — the ONE division champion rule.
//
// PURE: no `sql`, no `server-only`, no React. It was an inline IIFE inside the
// division page (`app/(public)/shared/[orgSlug]/[competitionSlug]/
// [divisionSlug]/page.tsx`), which is the only place it existed and therefore
// the only place it could be read from. The hub needs the same crown on every
// table it publishes, so the rule moves here and the page imports it — one
// authority, not a second copy that agrees today.
//
// The VALUE is deliberately unchanged by the move; `__tests__/champion.test.ts`
// is what pins that, including the two cases the inline version got right by
// construction (the decisive stage is the highest `seq`, and a knockout's
// champion is the highest ROUND's winner, never the last array element).
//
// Structural input types, not `PublicFixture`/`PublicStage`/`PublicStandings`
// — the same posture `lib/round-role-label.ts`'s `LaneRoundFixture` takes.
// A real row from `data.ts` satisfies these without a cast, and a test can
// build one without inventing twenty fields it does not use. It also keeps
// this module free of any import from `./data`, which is `server-only`.

/** Stage kinds whose rounds are BRACKET POSITIONS — the champion is the last
 *  round's winner rather than a table's rank 1.
 *
 *  Exported because the division page declared this set locally and the hub
 *  needs the same answer; the page now imports it. Note this is the DISPLAY
 *  set the public surface has always used and includes `page_playoff`, which
 *  `PublicStage["kind"]` does not list — hence `ReadonlySet<string>`, not a
 *  set of that union. The engine's own authority for the same concept is
 *  `BRACKET_STAGE_KINDS` (`@seazn/engine/competition`), and
 *  `lib/__tests__/bracket-kinds-sync.test.ts` already pins this repo's
 *  hand-copied siblings against it. */
export const BRACKET_KINDS: ReadonlySet<string> = new Set([
  "knockout",
  "double_elim",
  "stepladder",
  "page_playoff",
]);

export interface ChampionStage {
  id: string;
  seq: number;
  kind: string;
  status: string;
}

export interface ChampionFixture {
  stage_id: string;
  round_no: number;
  status: string;
  outcome: { winner?: string } | null;
}

export interface ChampionStandings {
  stage_id: string;
  pool_id: string | null;
  rows: readonly { entrantId: string; rank?: number }[];
}

/**
 * The division's champion entrant id, or null while there is nobody to crown.
 *
 * EMPTY CASE FIRST, and stated rather than fallen into: a division with no
 * stages has no decisive stage, and every question below it ("is it complete",
 * "is every fixture decided") answers vacuously — `[].every(...)` is `true`,
 * which is precisely how a contains-ladder crowns a phantom. The `stageDone`
 * expression below carries its own `stageFixtures.length > 0` guard for the
 * same reason, one level down: a stage with no fixtures at all is not a
 * fully-played stage.
 *
 * Then: crown when the decisive (highest `seq`) stage is FLAGGED complete, or
 * when every one of its fixtures is already decided — a fully-played stage is
 * not always flipped to `complete`. A bracket's champion is the winner of its
 * highest-numbered decided round; a league's or group's is rank 1 of the
 * stage's overall snapshot, falling back to the stage's only pool table when
 * no overall one was computed.
 */
export function divisionChampion(
  stages: readonly ChampionStage[],
  fixtures: readonly ChampionFixture[],
  standings: readonly ChampionStandings[],
): string | null {
  if (stages.length === 0) return null;

  const decisive = [...stages].sort((a, b) => b.seq - a.seq)[0];
  if (!decisive) return null;

  const stageFixtures = fixtures.filter((f) => f.stage_id === decisive.id);
  const finished = (f: ChampionFixture) =>
    f.status === "decided" || f.status === "finalized" || f.outcome?.winner != null;
  const stageDone =
    decisive.status === "complete" ||
    (stageFixtures.length > 0 && stageFixtures.every(finished));
  if (!stageDone) return null;

  if (BRACKET_KINDS.has(decisive.kind)) {
    const decided = stageFixtures.filter((f) => f.outcome?.winner);
    if (decided.length === 0) return null;
    const final = decided.reduce((a, b) => (b.round_no > a.round_no ? b : a));
    return final.outcome?.winner ?? null;
  }

  const snap =
    standings.find((s) => s.stage_id === decisive.id && !s.pool_id) ??
    standings.find((s) => s.stage_id === decisive.id);
  if (!snap) return null;
  const top = snap.rows.find((r) => r.rank === 1);
  return top?.entrantId ?? null;
}
