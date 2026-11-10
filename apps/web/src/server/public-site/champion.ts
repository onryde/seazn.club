// Spectator surface W2, Task 4 — the ONE division champion rule.
//
// PURE: no `sql`, no `server-only`, no React. It was an inline IIFE inside the
// division page (`app/(public)/live/[orgSlug]/[competitionSlug]/
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

import type { BracketTitle } from "@seazn/engine/competition";

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

/** W4 (C16): which side of a source stage a stage is fed from. A knockout's Plate takes the main draw's LOSERS
 *  (`roundLosers` / `firstLosses`); everything else — a table's top N, a rank range — takes the winners' side. */
export interface StageFeed {
  stageId: string;
  side: "winners" | "losers";
}

export interface ChampionStage {
  id: string;
  seq: number;
  kind: string;
  status: string;
  /** The stages this one is seeded from, read off its stored progression (`data.ts`). Optional: a stage with none
   *  declared (a hand-built row, a first stage) is a root, and with no feed anywhere the decisive stage is the
   *  highest `seq`, as it has always been. */
  feeds_from?: readonly StageFeed[];
}

export interface ChampionFixture {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  outcome: { winner?: string; kind?: string } | null;
  /** The bracket-role flags (V368) — optional for the reason `data.ts` gives
   *  on `PublicFixture`: a real row always carries them. */
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  home_entrant_id?: string | null;
  away_entrant_id?: string | null;
  /** V498 (W4 Task 12): when the organiser ruled the final joint winners. Optional until that column is read by the
   *  public views; a decided final carrying it crowns BOTH finalists. */
  joint_winners_at?: string | null;
}

/**
 * The fixture statuses that SETTLE a bracket game, in the DB's vocabulary: the
 * repo's own settled set (`usecases/stages/swiss-gen.ts`'s `DECIDED`), and the DB side of
 * the engine's `SETTLED` (`packages/engine/src/competition/stage.ts`) —
 * `decided`/`finalized` read as the engine's `decided`, `forfeited` as its
 * `walkover` (`lib/fixture-engine-status.ts` `engineFixtureStatus`; stage completion reads it through
 * `completionEngineStatus`, `engine-db/recorded-abandon.ts`). The engine's third
 * member, `void` (a `cancelled`/`abandoned` row), is left out: a void game
 * carries no winner, so it could never pass the winner test anyway - and a
 * recorded abandon still held for the organiser's settle reads `in_play` to
 * completion, so it is not settled either. The suite
 * reads `usecases/stages/` to keep the two sets equal.
 */
export const BRACKET_SETTLED: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

/**
 * What a division's deciding bracket crowned — the engine's own `BracketTitle` (`@seazn/engine/competition`), so the
 * app and the engine can never name different shapes: ONE champion, TWO joint winners, or a VACANT title (both
 * finalists departed — X-CH-3). Every reader renders all three; none may collapse a joint or vacant title to "no
 * champion", which is what returning a single id did.
 */
export type DivisionTitle = BracketTitle;

/** The entrants a title crowns: one, both of a joint pair, or nobody (vacant). */
export function titleEntrantIds(title: DivisionTitle | null): readonly string[] {
  if (title === null) return [];
  switch (title.kind) {
    case "champion":
      return [title.champion];
    case "joint":
      return title.winners;
    case "vacant":
      return [];
  }
}

export type BracketTitleRead = DivisionTitle & { fixtureId: string };

/**
 * The title ONE bracket stage's deciding final crowned, and that final's fixture id — the single authority for a
 * bracket's crown. `divisionTitle` (the Table tab's crown, the division page's banner, the OG card) and the hub's
 * knockout view all answer with it.
 *
 * The ENGINE's rule (`bracketTitle`, `competition/stage.ts`): the latest-round final that is settled and decided
 * something.
 *   • "Final" means `is_final`; a bronze match never is one. With no flag anywhere — a hand-built bracket, not one the
 *     engine generated — the last round's SINGLE non-bronze fixture is the final, and two there is none.
 *   • A decided final crowns whether or not the bronze match has been played.
 *   • A final with a winner crowns that winner (`champion`); a settled final ruled joint (`joint_winners_at`) crowns
 *     both of its seated sides (`joint`); a settled final both sides walked from (`double_walkover`, X-CH-3) crowns
 *     nobody (`vacant`).
 *
 * ONE addition the engine never needs, because it only titles a COMPLETED stage: a later final still to be played
 * withholds the title. The live case is a double-elimination RESET (`is_final` + `conditional`), owed only when the
 * losers' champion wins the first grand final. `bracket.ts` seats the winners' champion at HOME there, so the reset is
 * owed exactly when that grand final's winner is not its home entrant — the same test the engine's own harness voids
 * the reset on (`testkit/simulation.ts`). Nothing in production writes that void, so "owed" is read off the RESULT,
 * never off the reset's row. A later final that is not conditional is always owed. A vacant or joint grand final has no
 * winner, so it never owes a reset's absence: it is itself the deciding final.
 */
export function bracketTitleOf(fixtures: readonly ChampionFixture[]): BracketTitleRead | null {
  const settled = (f: ChampionFixture): boolean => BRACKET_SETTLED.has(f.status);
  const winnerOf = (f: ChampionFixture): string | null => (settled(f) ? (f.outcome?.winner ?? null) : null);
  const jointOf = (f: ChampionFixture): readonly [string, string] | null =>
    settled(f) && f.joint_winners_at != null && f.home_entrant_id != null && f.away_entrant_id != null
      ? [f.home_entrant_id, f.away_entrant_id]
      : null;
  const vacantOf = (f: ChampionFixture): boolean => settled(f) && f.outcome?.kind === "double_walkover";
  const decides = (f: ChampionFixture): boolean => winnerOf(f) !== null || jointOf(f) !== null || vacantOf(f);

  let finals = fixtures.filter((f) => f.is_final === true && f.third_place !== true);
  if (finals.length === 0) {
    const field = fixtures.filter((f) => f.third_place !== true);
    const lastRound = Math.max(...field.map((f) => f.round_no));
    const last = field.filter((f) => f.round_no === lastRound);
    finals = last.length === 1 ? last : [];
  }

  // Latest round first — the engine sorts `b.round - a.round`.
  const byRound = [...finals].sort((a, b) => b.round_no - a.round_no);
  const deciding = byRound.find(decides);
  if (deciding === undefined) return null;
  const winner = winnerOf(deciding);

  for (const later of byRound) {
    if (later.round_no <= deciding.round_no) continue;
    // Only a WINNER can make a later conditional final unnecessary (the winners' champion took the grand final).
    const owed = later.conditional !== true || winner === null || winner !== deciding.home_entrant_id;
    if (owed) return null;
  }
  if (winner !== null) return { kind: "champion", champion: winner, fixtureId: deciding.id };
  const joint = jointOf(deciding);
  if (joint !== null) return { kind: "joint", winners: joint, fixtureId: deciding.id };
  return { kind: "vacant", fixtureId: deciding.id };
}

export interface ChampionStandings {
  stage_id: string;
  pool_id: string | null;
  rows: readonly { entrantId: string; rank?: number }[];
}

/** A stage row with its stored progression, as `data.ts` reads it (the progression itself stays private; only the
 *  graph derived below is published). */
export interface StageProgressionRow {
  id: string;
  seq: number;
  progression: unknown;
}

const LOSER_TAKES: ReadonlySet<string> = new Set(["roundLosers", "firstLosses"]);

/**
 * Each stage's `feeds_from`, read off the stored progressions of one division's stages. `"previous"` is the
 * immediately preceding stage by `seq`; an explicit `{stageId}` names any stage. A source whose every take is a
 * losers' take is the `losers` side; anything else (a table cut, no `take` array) the `winners'`. A source naming no
 * stage of the division, or a malformed progression, contributes no edge — the graph degrades to "no feed", never
 * throws on a public read.
 */
export function stageFeedsOf(rows: readonly StageProgressionRow[]): Map<string, StageFeed[]> {
  const bySeq = [...rows].sort((a, b) => a.seq - b.seq);
  const known = new Set(rows.map((r) => r.id));
  const out = new Map<string, StageFeed[]>();
  for (const [i, row] of bySeq.entries()) {
    const sources = (row.progression as { sources?: unknown } | null)?.sources;
    if (!Array.isArray(sources)) continue;
    const feeds: StageFeed[] = [];
    for (const src of sources as { stage?: unknown; take?: unknown }[]) {
      const ref = src?.stage;
      const stageId =
        ref === "previous"
          ? bySeq[i - 1]?.id
          : typeof ref === "object" && ref !== null && typeof (ref as { stageId?: unknown }).stageId === "string"
            ? (ref as { stageId: string }).stageId
            : undefined;
      if (stageId === undefined || !known.has(stageId) || stageId === row.id) continue;
      const take = Array.isArray(src.take) ? (src.take as { kind?: unknown }[]) : [];
      const losers = take.length > 0 && take.every((t) => typeof t?.kind === "string" && LOSER_TAKES.has(t.kind));
      feeds.push({ stageId, side: losers ? "losers" : "winners" });
    }
    if (feeds.length > 0) out.set(row.id, feeds);
  }
  return out;
}

/**
 * The stage whose result titles the division (C16). Not the highest `seq`: a Knockout + Plate division stores the
 * Plate AFTER the main draw, and the Plate's winner is the consolation winner, never the champion.
 *
 * Read off the progression graph: a stage another stage is fed from on the WINNERS' side is a feeder, not the end of
 * the road (a group stage feeding a bracket); a stage fed ONLY from the losers' side (`roundLosers` / `firstLosses`)
 * is a consolation. The decisive stage is the latest of those that remain. With no feed declared anywhere that is
 * every stage, so the latest by `seq` — what it was before the graph was read. An empty list has none.
 */
export function decisiveStageOf<S extends ChampionStage>(stages: readonly S[]): S | undefined {
  if (stages.length === 0) return undefined;
  const feeder = new Set<string>();
  for (const s of stages) for (const f of s.feeds_from ?? []) if (f.side === "winners") feeder.add(f.stageId);
  const consolation = (s: ChampionStage): boolean => {
    const feeds = s.feeds_from ?? [];
    return feeds.length > 0 && feeds.every((f) => f.side === "losers");
  };
  const candidates = stages.filter((s) => !feeder.has(s.id) && !consolation(s));
  const pool = candidates.length > 0 ? candidates : stages; // a malformed graph (a cycle) falls back to seq
  return [...pool].sort((a, b) => b.seq - a.seq)[0];
}

/**
 * The division's title, or null while there is nobody to crown.
 *
 * EMPTY CASE FIRST, and stated rather than fallen into: a division with no
 * stages has no decisive stage, and every question below it ("is it complete",
 * "is every fixture decided") answers vacuously — `[].every(...)` is `true`,
 * which is precisely how a contains-ladder crowns a phantom. The `stageDone`
 * expression below carries its own `stageFixtures.length > 0` guard for the
 * same reason, one level down: a stage with no fixtures at all is not a
 * fully-played stage.
 *
 * A BRACKET decisive stage is titled by `bracketTitleOf` alone: its final,
 * on the engine's rule, regardless of the stage flag or an unplayed bronze.
 *
 * A TABLE stage crowns when it is FLAGGED complete, or when every one of its
 * fixtures is already decided — a fully-played stage is not always flipped to
 * `complete` — and its champion is rank 1 of the stage's overall snapshot,
 * falling back to the stage's only pool table when no overall one was
 * computed. A table never answers joint or vacant.
 */
export function divisionTitle(
  stages: readonly ChampionStage[],
  fixtures: readonly ChampionFixture[],
  standings: readonly ChampionStandings[],
): DivisionTitle | null {
  const decisive = decisiveStageOf(stages);
  if (!decisive) return null;

  const stageFixtures = fixtures.filter((f) => f.stage_id === decisive.id);

  // BEFORE the stage-done gate, on purpose: a bracket's title is decided by
  // its final, and the gate would make a decided final wait for a bronze match
  // (or trust a stage flag over an unplayed final).
  if (BRACKET_KINDS.has(decisive.kind)) {
    const t = bracketTitleOf(stageFixtures);
    if (t === null) return null;
    return t.kind === "champion"
      ? { kind: "champion", champion: t.champion }
      : t.kind === "joint"
        ? { kind: "joint", winners: t.winners }
        : { kind: "vacant" };
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
  return top ? { kind: "champion", champion: top.entrantId } : null;
}
