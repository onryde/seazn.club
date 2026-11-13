// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C17, C22): the setup screen's match count
// and knockout draw, folded from the real generator's structure (`previewStageDraw`, stages/preview.ts) — the same generate()
// the create runs, over the same stage inputs (`quickMatchStageInputs`), so the number on the Start button cannot drift
// from the fixtures generated (pre-flight A8) and there is never a second bracket algorithm (§4).
//
// League + Knockout (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D1, T3; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §3, §12): ONE division of TWO stages, the league
// and then the organiser's own `league_ko` template's knockout stage, which takes the top `qualifiers` (2 or 4) of the league
// table. That count lives in the stage graph and nowhere else (D1). Its Start count is the league's plus the knockout's of
// `qualifiers` sides (q − 1, no third place); only the league's rounds are previewed, since the bracket waits on the table.
//
// No string here is copy (pre-flight C2, C10): plan 2 names seed i after the i-th side as typed, a bye in words, and a
// card and a waiting seat's feeder through `fixtureLabel`/`winnerOfLabel` (components/quick-match/fixture-label.ts), from
// the round's role and the match's place among its round's non-bye matches.
import type { RoundRole } from "@seazn/engine/competition";
import { STAGE_TEMPLATES, type StageDraft } from "@/lib/format-templates";
import {
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_MIN_SIDES,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
} from "@/lib/quick-match-constants";
import { previewStageDraw, type PreviewDrawFeed } from "./stages";

/** The stored and API format (V506's and V517's check): `knockout` is kept for the rows that have it; a guest makes a League or a
 *  League + Knockout. */
export type QuickMatchFormat = "league" | "knockout" | "league_knockout";
/** League + Knockout's count: the top 2 play a final, the top 4 semi-finals and a final (QUICK_MATCH_QUALIFIERS). */
export type QuickMatchQualifiers = (typeof QUICK_MATCH_QUALIFIERS)[number];
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
/** A PreviewStageInput, and a CreateStage once its `seq` is added: ONE input for the preview and the create. The progression
 *  is the league_ko template's (a League + Knockout's knockout stage), null on every other stage. */
export interface QuickMatchStageInput {
  kind: "league" | "knockout";
  name: string;
  config: { legs: number } | Record<string, never>;
  progression: StageDraft["progression"];
}

/** A format and a count that disagree (`league_knockout` ⇔ a count): the schema refuses the pair (`checkQualifiers`), but a
 *  caller that builds its input in code never parsed one, so the stage graph refuses it too, as a fault. */
function refuseQualifierMismatch(format: QuickMatchFormat, qualifiers: QuickMatchQualifiers | null): void {
  if ((format === "league_knockout") !== (qualifiers !== null)) {
    throw new Error(
      format === "league_knockout"
        ? "a league_knockout quick match needs qualifiers (2 or 4)"
        : `a ${format} quick match takes no qualifiers, got ${qualifiers}`,
    );
  }
}

/** The organiser's League + Knockout template's KNOCKOUT stage (lib/format-templates.ts `league_ko`, P1), built for `q`: the
 *  top q of the previous stage, rank order, drawn at setup. Its league is not reused: the template's is `legs: 1`, and a quick
 *  match's league plays `plays` legs, so the league stays the quick match's own. */
function templateKnockout(q: QuickMatchQualifiers): StageDraft {
  const template = STAGE_TEMPLATES.find((t) => t.key === "league_ko");
  if (!template) throw new Error("quick match: the league_ko template is missing");
  const knockout = template.build({ qualified: q, swissRounds: 1, poolCount: 1, legs: 1 })[1];
  if (knockout?.kind !== "knockout" || knockout.progression === null) {
    throw new Error("quick match: the league_ko template's second stage is not a knockout fed by the league");
  }
  return knockout;
}

/**
 * A quick match's stage graph, in seq order: ONE answer for the preview, the create and every reader that counts stages. A
 * League or a Knockout is one stage; a League + Knockout is the league (`legs` = plays) then the league_ko template's knockout
 * of the top `qualifiers`, both named after the match. A format and a count that disagree are refused, as a fault.
 */
export function quickMatchStageInputs(input: {
  format: QuickMatchFormat;
  plays: number;
  name: string;
  qualifiers: QuickMatchQualifiers | null;
}): QuickMatchStageInput[] {
  const { format, plays, name, qualifiers } = input;
  refuseQualifierMismatch(format, qualifiers);
  const league: QuickMatchStageInput = { kind: "league", name, config: { legs: plays }, progression: null };
  if (format === "league") return [league];
  if (format === "knockout") return [{ kind: "knockout", name, config: {}, progression: null }];
  return [league, { kind: "knockout", name, config: {}, progression: templateKnockout(qualifiers!).progression }];
}

/** How many stages a quick match of `format` is built with: its stage graph's length (`quickMatchStageInputs`). The saver's
 *  rename and the home's read refuse any other count. */
export function quickMatchStageCount(format: QuickMatchFormat): number {
  return format === "league_knockout" ? 2 : 1;
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

export function quickMatchPreview(input: {
  format: QuickMatchFormat;
  sides: number;
  plays: number;
  /** League + Knockout's count; left out is null (every other format). */
  qualifiers?: QuickMatchQualifiers | null;
}): QuickMatchPreview {
  const { format, sides, plays } = input;
  const qualifiers = input.qualifiers ?? null;
  // The create's own bounds (CreateQuickMatch: 2..6 sides, 1..2 plays). Below two sides the generator's preview
  // clamps the field up to two, so an unguarded "1 side" would preview a match the create refuses.
  if (!Number.isInteger(sides) || sides < QUICK_MATCH_MIN_SIDES || sides > QUICK_MATCH_MAX_SIDES) {
    throw new RangeError(`quick match sides must be ${QUICK_MATCH_MIN_SIDES} to ${QUICK_MATCH_MAX_SIDES}, got ${sides}`);
  }
  if (!Number.isInteger(plays) || plays < 1 || plays > QUICK_MATCH_MAX_PLAYS) {
    throw new RangeError(`quick match plays must be 1 to ${QUICK_MATCH_MAX_PLAYS}, got ${plays}`);
  }

  refuseQualifierMismatch(format, qualifiers);
  // §3: a League + Knockout needs three sides (two would replay the league as its final), and semi-finals need four. The
  // create's own refusals (FORMAT_NOT_OFFERED, SEMIS_TOO_FEW_SIDES), so the table holds no count for a match it would refuse.
  if (format === "league_knockout" && (sides < QUICK_MATCH_KNOCKOUT_MIN_SIDES || (qualifiers === 4 && sides < QUICK_MATCH_SEMIS_MIN_SIDES))) {
    throw new RangeError(`a league and knockout of the top ${qualifiers} needs more than ${sides} sides`);
  }
  const [first, knockout] = quickMatchStageInputs({ format, plays, name: "", qualifiers });
  const preview = previewOf(first!, sides, format);
  if (knockout === undefined) return preview;
  // The knockout stage is drawn over its qualifiers: the top q seats of the table, so a bracket of q (no byes: q is 2 or 4).
  const after = previewOf(knockout, qualifiers!, format);
  return { matchCount: preview.matchCount + after.matchCount, rounds: preview.rounds };
}

/** One stage's preview over `sides` seats: its non-bye lines counted, its rounds folded. */
function previewOf(stage: QuickMatchStageInput, sides: number, format: QuickMatchFormat): QuickMatchPreview {
  const draw = previewStageDraw(stage, sides);
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
// A guest picks a League or a League + Knockout (plan 5 D1; owner 2026-11-12 "take out" the plain Knockout), so the table the
// setup page ships holds league cells and League + Knockout cells, and no plain knockout cell. The knockout draws
// (`quickMatchKnockoutDraws`) are KEPT, unshipped.
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
/** Keyed `"league:<sides>:<plays>"`, and `"league_knockout:<sides>:<plays>:<qualifiers>"` for a League + Knockout (the top 2
 *  from three sides, the top 4 from four, §3). A key outside the table (one side, three plays, semi-finals of three) holds
 *  nothing, and every lookup is typed `| undefined`, so the compiler makes each caller handle that miss. */
export type QuickMatchPreviewTable = { [key: `league:${number}:${number}`]: QuickMatchLeagueCell | undefined } & {
  [key: `league_knockout:${number}:${number}:${number}`]: QuickMatchLeagueCell | undefined;
};
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
      for (const qualifiers of QUICK_MATCH_QUALIFIERS) {
        if (sides < QUICK_MATCH_KNOCKOUT_MIN_SIDES || (qualifiers === 4 && sides < QUICK_MATCH_SEMIS_MIN_SIDES)) continue;
        table[`league_knockout:${sides}:${plays}:${qualifiers}`] = {
          matchCount: quickMatchPreview({ format: "league_knockout", sides, plays, qualifiers }).matchCount,
        };
      }
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
