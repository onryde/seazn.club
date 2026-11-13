// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C17, C22): the setup screen's match count
// and knockout draw, folded from the real generator's structure (`previewStageDraw`, stages/preview.ts) — the same generate()
// the create runs, over the same stage input (`quickMatchStageInput`), so the number on the Start button cannot drift
// from the fixtures generated (pre-flight A8) and there is never a second bracket algorithm (§4).
//
// No string here is copy (pre-flight C2, C10): plan 2 names seed i after the i-th side as typed, a bye in words, and a
// card and a waiting seat's feeder through `fixtureLabel`/`winnerOfLabel` (components/quick-match/fixture-label.ts), from
// the round's role and the match's place among its round's non-bye matches.
import type { RoundRole } from "@seazn/engine/competition";
import {
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_MIN_SIDES,
} from "@/lib/quick-match-constants";
import { previewStageDraw, type PreviewDrawFeed } from "./stages";

export type QuickMatchFormat = "league" | "knockout";
/** seed i = the i-th side as typed; feeder = the winner of round·seq; both null on a bye's empty seat. */
export interface QuickMatchPreviewSide {
  seed: number | null;
  feeder: { round: number; seq: number } | null;
}
export interface QuickMatchPreviewLine {
  home: QuickMatchPreviewSide;
  away: QuickMatchPreviewSide;
  bye: boolean;
}
/** role: the engine's typed round role for a knockout round; null for a league round. */
export interface QuickMatchPreviewRound {
  roundNo: number;
  role: RoundRole | null;
  lines: QuickMatchPreviewLine[];
}
/** matchCount: the lines that are not byes (a bye is not a match). */
export interface QuickMatchPreview {
  matchCount: number;
  rounds: QuickMatchPreviewRound[];
}
/** A PreviewStageInput, and Task 5's CreateStage once `seq: 1` is added: ONE input for the preview and the create. */
export interface QuickMatchStageInput {
  kind: QuickMatchFormat;
  name: string;
  config: { legs: number } | Record<string, never>;
  progression: null;
}

export function quickMatchStageInput(input: { format: QuickMatchFormat; plays: number; name: string }): QuickMatchStageInput {
  return input.format === "league"
    ? { kind: "league", name: input.name, config: { legs: input.plays }, progression: null }
    : { kind: "knockout", name: input.name, config: {}, progression: null };
}

const EMPTY_SEAT: QuickMatchPreviewSide = { seed: null, feeder: null };

function seatOf(seed: number | null, from: PreviewDrawFeed | null, where: string): QuickMatchPreviewSide {
  // A loser feed (a third-place match) is not "the winner of" anything, and a match seat with neither a seed nor a
  // feeder has no name at all. Neither occurs in a quick match stage (no third place; the generator seats or feeds
  // every match seat); refuse rather than show a blank or a mislabeled side.
  if (from?.side === "loser") throw new Error(`quickMatchPreview cannot name ${where}: it is fed by a loser`);
  if (seed === null && from === null) throw new Error(`quickMatchPreview cannot name ${where}: no seed and no feeder`);
  return { seed, feeder: from ? { round: from.round, seq: from.seq } : null };
}

export function quickMatchPreview(input: { format: QuickMatchFormat; sides: number; plays: number }): QuickMatchPreview {
  const { format, sides, plays } = input;
  // The create's own bounds (CreateQuickMatch: 2..6 sides, 1..2 plays). Below two sides the generator's preview
  // clamps the field up to two, so an unguarded "1 side" would preview a match the create refuses.
  if (!Number.isInteger(sides) || sides < QUICK_MATCH_MIN_SIDES || sides > QUICK_MATCH_MAX_SIDES) {
    throw new RangeError(`quick match sides must be ${QUICK_MATCH_MIN_SIDES} to ${QUICK_MATCH_MAX_SIDES}, got ${sides}`);
  }
  if (!Number.isInteger(plays) || plays < 1 || plays > QUICK_MATCH_MAX_PLAYS) {
    throw new RangeError(`quick match plays must be 1 to ${QUICK_MATCH_MAX_PLAYS}, got ${plays}`);
  }

  const draw = previewStageDraw(quickMatchStageInput({ format, plays, name: "" }), sides);
  if (draw.length === 0) throw new Error(`quickMatchPreview cannot name a draw of no fixtures (${format}, ${sides} sides)`);

  const rounds = new Map<number, QuickMatchPreviewRound>();
  let matchCount = 0;
  for (const f of [...draw].sort((a, b) => a.roundNo - b.roundNo || a.seqInRound - b.seqInRound)) {
    const where = `R${f.roundNo}·${f.seqInRound}`;
    // The engine always lands a bye's award on home (stages/generators.ts bracketToGen), so its away seat is empty. A bye with
    // someone in that seat would be a match shown as a walk-through: refuse it rather than blank the side.
    if (f.bye && (f.awaySeed !== null || f.awayFrom !== null)) {
      throw new Error(`quickMatchPreview cannot name ${where}: a bye with its away seat filled`);
    }
    const line: QuickMatchPreviewLine = {
      home: seatOf(f.homeSeed, f.homeFrom, where),
      away: f.bye ? EMPTY_SEAT : seatOf(f.awaySeed, f.awayFrom, where),
      bye: f.bye,
    };
    if (!f.bye) matchCount++;
    const round = rounds.get(f.roundNo);
    if (round) round.lines.push(line);
    else rounds.set(f.roundNo, { roundNo: f.roundNo, role: f.role, lines: [line] });
  }
  return { matchCount, rounds: [...rounds.values()] };
}

// ---------------------------------------------------------------------------
// The setup screen's whole table (plan 2 pre-flight D1): every league count the form can ask for, computed here and
// handed to the setup island as a prop, so the Start button's number is a lookup — never a fetch that can land stale or
// out of order. Every cell is a `quickMatchPreview` call over an in-range input, so its RangeError is unreachable. ONE
// table serves every sport: the preview, the stage input it shares with the create, and the engine's generators all take
// no sport (quick-match-preview-table.test.ts pins the first two inputs).
//
// League only (owner 2026-11-12, "take out"): a guest picks no knockout for now, so the table the setup page ships holds
// no knockout cell. The knockout draws (`quickMatchKnockoutDraws`) are KEPT, unshipped, for League + Knockout, which
// comes in a later PR and will preview its knockout phase the same way.
// ---------------------------------------------------------------------------

/** A knockout seat on the setup screen: seed i (the i-th side as typed), or the winner of an earlier pair of this draw
 *  (`round` 1-based into `rounds`, `pair` 1-based into that round's `pairs`). A seat the engine feeds from a bye line is
 *  already that line's holder, so the screen never names the winner of a match nobody plays (plan-1 T4 review). */
export type QuickMatchDrawSeat = { seed: number } | { winnerOf: { round: number; pair: number } };
/** role: the engine's typed round role; the island names it with roundRoleLabel, or "Round {n}" when null. */
export interface QuickMatchDrawRound {
  role: RoundRole | null;
  /** The round's matches as [home, away], in draw order. A bye is no match and is never a pair. */
  pairs: [QuickMatchDrawSeat, QuickMatchDrawSeat][];
}
export interface QuickMatchLeagueCell {
  matchCount: number;
}
export interface QuickMatchKnockoutCell {
  matchCount: number;
  /** The seeds that sit out round one, in draw order. */
  byes: number[];
  rounds: QuickMatchDrawRound[];
}
/** Keyed `"league:<sides>:<plays>"`. A key outside the table (one side, three plays) holds nothing, and every lookup is
 *  typed `| undefined`, so the compiler makes each caller handle that miss. */
export type QuickMatchPreviewTable = { [key: `league:${number}:${number}`]: QuickMatchLeagueCell | undefined };
/** Keyed `"knockout:<sides>:1"`: a knockout carries no plays (its stage has no legs), so its key always ends `:1`. Not
 *  shipped to a guest today (League only); kept for League + Knockout. */
export type QuickMatchKnockoutDraws = { [key: `knockout:${number}:1`]: QuickMatchKnockoutCell | undefined };

function knockoutCell(preview: QuickMatchPreview, sides: number): QuickMatchKnockoutCell {
  // Where each match line lands in the cell: its round's place and its 1-based place among that round's matches. A
  // round's lines are in seq order and its seqs run 1..k (bracketToGen's per-round counter), so seq s is lines[s − 1].
  const placeOf = new Map<QuickMatchPreviewLine, { round: number; pair: number }>();
  const roundAt = new Map<number, QuickMatchPreviewRound>();
  preview.rounds.forEach((r, i) => {
    roundAt.set(r.roundNo, r);
    r.lines.filter((l) => !l.bye).forEach((l, j) => placeOf.set(l, { round: i + 1, pair: j + 1 }));
  });
  const where = (round: number, seq: number) => `the knockout of ${sides} R${round}·${seq}`;

  const holderOf = (bye: QuickMatchPreviewLine, at: string): number => {
    if (bye.home.seed === null) throw new Error(`quickMatchKnockoutDraws cannot name ${at}: the bye's holder is no seed`);
    return bye.home.seed;
  };
  const seatOf = (side: QuickMatchPreviewSide, at: string): QuickMatchDrawSeat => {
    if (side.seed !== null && side.feeder !== null) {
      throw new Error(`quickMatchKnockoutDraws cannot name ${at}: the seat is both seeded and fed`);
    }
    if (side.seed !== null) return { seed: side.seed };
    // quickMatchPreview refuses a match seat with neither, so a seat with no seed has a feeder.
    const { round, seq } = side.feeder!;
    const source = roundAt.get(round)?.lines[seq - 1];
    if (!source) {
      throw new Error(`quickMatchKnockoutDraws cannot name ${at}: it is fed by ${where(round, seq)}, which is not in the draw`);
    }
    if (source.bye) return { seed: holderOf(source, where(round, seq)) };
    return { winnerOf: placeOf.get(source)! };
  };

  return {
    matchCount: preview.matchCount,
    byes: preview.rounds.flatMap((r) => r.lines.flatMap((l, j) => (l.bye ? [holderOf(l, where(r.roundNo, j + 1))] : []))),
    rounds: preview.rounds.map((r) => ({
      role: r.role,
      pairs: r.lines.flatMap((l, j): [QuickMatchDrawSeat, QuickMatchDrawSeat][] =>
        l.bye ? [] : [[seatOf(l.home, where(r.roundNo, j + 1)), seatOf(l.away, where(r.roundNo, j + 1))]],
      ),
    })),
  };
}

export function quickMatchPreviewTable(): QuickMatchPreviewTable {
  const table: Record<string, QuickMatchLeagueCell> = {};
  for (let sides = QUICK_MATCH_MIN_SIDES; sides <= QUICK_MATCH_MAX_SIDES; sides++) {
    for (let plays = 1; plays <= QUICK_MATCH_MAX_PLAYS; plays++) {
      table[`league:${sides}:${plays}`] = { matchCount: quickMatchPreview({ format: "league", sides, plays }).matchCount };
    }
  }
  return table as QuickMatchPreviewTable;
}

/** Every knockout draw a quick match of 3..6 sides would make (C22), structure only. No caller in the product today: a
 *  guest is offered League only (owner 2026-11-12); kept for League + Knockout's preview of its knockout phase. */
export function quickMatchKnockoutDraws(): QuickMatchKnockoutDraws {
  const draws: Record<string, QuickMatchKnockoutCell> = {};
  // C16: two sides is always a league.
  for (let sides = QUICK_MATCH_KNOCKOUT_MIN_SIDES; sides <= QUICK_MATCH_MAX_SIDES; sides++) {
    draws[`knockout:${sides}:1`] = knockoutCell(quickMatchPreview({ format: "knockout", sides, plays: 1 }), sides);
  }
  return draws as QuickMatchKnockoutDraws;
}
