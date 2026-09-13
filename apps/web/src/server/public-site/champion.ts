// Spectator surface W2, Task 4 — the ONE division champion rule.
//
// PURE: no `sql`, no `server-only`, no React. It was an inline IIFE inside the
// division page (`app/(public)/shared/[orgSlug]/[competitionSlug]/
// [divisionSlug]/page.tsx`), which is the only place it existed and therefore
// the only place it could be read from. The hub needs the same crown on every
// table it publishes, so the rule moves here and the page imports it — one
// authority, not a second copy that agrees today.
//
// The VALUE was unchanged by the move; `__tests__/champion.test.ts` pinned
// that, including the two cases the inline version got right by construction
// (the decisive stage is the highest `seq`, and a knockout's champion is never
// the last array element).
//
// 2026-09-13 (hub Knockout tab): a BRACKET's crown now comes from
// `bracketChampion` below — the engine's own rule, shared with the hub's
// knockout view so the two can never name different winners. That moved the
// bracket crown on four shapes, each pinned as `CHANGED` in the suite (a
// decided final with the bronze unplayed now crowns; a flagged-complete stage
// with its final unplayed, a bronze listed before its final, and an `in_play`
// final with a winner do not). League and group crowns are unchanged.
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
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  outcome: { winner?: string } | null;
  /** The bracket-role flags (V368) — optional for the reason `data.ts` gives
   *  on `PublicFixture`: a real row always carries them. */
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  home_entrant_id?: string | null;
}

/**
 * The fixture statuses that SETTLE a bracket game, in the DB's vocabulary: the
 * repo's own settled set (`usecases/stages.ts`'s `DECIDED`), and the DB side of
 * the engine's `SETTLED` (`packages/engine/src/competition/stage.ts`) —
 * `decided`/`finalized` read as the engine's `decided`, `forfeited` as its
 * `walkover` (`engine-db/competition.ts` `toEngineStatus`). The engine's third
 * member, `void` (a `cancelled`/`abandoned` row), is left out: a void game
 * carries no winner, so it could never pass the winner test anyway. The suite
 * reads `stages.ts` to keep the two sets equal.
 */
export const BRACKET_SETTLED: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

export interface BracketChampion {
  fixtureId: string;
  winner: string;
}

/**
 * The fixture that crowns ONE bracket stage, and its winner — the single
 * authority for a bracket's crown. `divisionChampion` (the Table tab's crown,
 * the division page's banner) and the hub's knockout view both answer with it.
 *
 * The ENGINE's rule (`bracketRanks`, `competition/stage.ts`): the latest-round
 * final that is settled AND produced a winner.
 *   • "Final" means `is_final`; a bronze match never is one. With no flag
 *     anywhere — a hand-built bracket, not one the engine generated — the last
 *     round's SINGLE non-bronze fixture is the final, and two there is none.
 *   • A decided final crowns whether or not the bronze match has been played.
 *
 * ONE addition the engine never needs, because it only ranks a COMPLETED
 * stage: a later final still to be played withholds the crown. The live case
 * is a double-elimination RESET (`is_final` + `conditional`), owed only when
 * the losers' champion wins the first grand final. `bracket.ts` seats the
 * winners' champion at HOME there, so the reset is owed exactly when that
 * grand final's winner is not its home entrant — the same test the engine's
 * own harness voids the reset on (`testkit/simulation.ts`). Nothing in
 * production writes that void, so "owed" is read off the RESULT, never off the
 * reset's row. A later final that is not conditional is always owed.
 */
export function bracketChampion(fixtures: readonly ChampionFixture[]): BracketChampion | null {
  const winnerOf = (f: ChampionFixture): string | null =>
    BRACKET_SETTLED.has(f.status) ? (f.outcome?.winner ?? null) : null;

  let finals = fixtures.filter((f) => f.is_final === true && f.third_place !== true);
  if (finals.length === 0) {
    const field = fixtures.filter((f) => f.third_place !== true);
    const lastRound = Math.max(...field.map((f) => f.round_no));
    const last = field.filter((f) => f.round_no === lastRound);
    finals = last.length === 1 ? last : [];
  }

  // Latest round first — the engine sorts `b.round - a.round`.
  const byRound = [...finals].sort((a, b) => b.round_no - a.round_no);
  const deciding = byRound.find((f) => winnerOf(f) !== null);
  if (deciding === undefined) return null;
  const winner = winnerOf(deciding)!;

  for (const later of byRound) {
    if (later.round_no <= deciding.round_no) continue;
    const owed = later.conditional !== true || winner !== deciding.home_entrant_id;
    if (owed) return null;
  }
  return { fixtureId: deciding.id, winner };
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
 * A BRACKET decisive stage is crowned by `bracketChampion` alone: its final,
 * on the engine's rule, regardless of the stage flag or an unplayed bronze.
 *
 * A TABLE stage crowns when it is FLAGGED complete, or when every one of its
 * fixtures is already decided — a fully-played stage is not always flipped to
 * `complete` — and its champion is rank 1 of the stage's overall snapshot,
 * falling back to the stage's only pool table when no overall one was
 * computed.
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

  // BEFORE the stage-done gate, on purpose: a bracket's champion is decided by
  // its final, and the gate would make a decided final wait for a bronze match
  // (or trust a stage flag over an unplayed final).
  if (BRACKET_KINDS.has(decisive.kind)) {
    return bracketChampion(stageFixtures)?.winner ?? null;
  }

  const finished = (f: ChampionFixture) =>
    f.status === "decided" || f.status === "finalized" || f.outcome?.winner != null;
  const stageDone =
    decisive.status === "complete" ||
    (stageFixtures.length > 0 && stageFixtures.every(finished));
  if (!stageDone) return null;

  const snap =
    standings.find((s) => s.stage_id === decisive.id && !s.pool_id) ??
    standings.find((s) => s.stage_id === decisive.id);
  if (!snap) return null;
  const top = snap.rows.find((r) => r.rank === 1);
  return top?.entrantId ?? null;
}
