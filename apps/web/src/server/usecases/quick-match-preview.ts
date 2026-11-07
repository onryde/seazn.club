// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C17, C22): the setup screen's match count
// and knockout draw, folded from the real generator's structure (`previewStageDraw`, stages.ts) — the same generate()
// the create runs, over the same stage input (`quickMatchStageInput`), so the number on the Start button cannot drift
// from the fixtures generated (pre-flight A8) and there is never a second bracket algorithm (§4).
//
// No string here is copy (pre-flight C2, C10): plan 2 names seed i after the i-th side as typed, a feeder as the
// winner of round·seq, a bye in words, and a round by roundRoleLabel(t, role), or "Round {n}" when role is null.
import type { RoundRole } from "@seazn/engine/competition";
import { QUICK_MATCH_MAX_PLAYS, QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MIN_SIDES } from "@/lib/quick-match-constants";
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
/** matchCount: the lines that are not byes (a bye is not a match); byeCount: the byes. */
export interface QuickMatchPreview {
  matchCount: number;
  byeCount: number;
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
  // every match seat); refuse rather than show a blank or a mislabelled side.
  if (from?.side === "loser") throw new Error(`quickMatchPreview cannot name ${where}: it is fed by a loser`);
  if (seed === null && from === null) throw new Error(`quickMatchPreview cannot name ${where}: no seed and no feeder`);
  return { seed, feeder: from ? { round: from.round, seq: from.seq } : null };
}

export function quickMatchPreview(input: { format: QuickMatchFormat; sides: number; plays: number }): QuickMatchPreview {
  const { format, sides, plays } = input;
  // The create's own bounds (CreateQuickMatch: 2..6 sides, 1..4 plays). Below two sides the generator's preview
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
  let byeCount = 0;
  for (const f of [...draw].sort((a, b) => a.roundNo - b.roundNo || a.seqInRound - b.seqInRound)) {
    const where = `R${f.roundNo}·${f.seqInRound}`;
    // The engine always lands a bye's award on home (stages.ts bracketToGen), so its away seat is empty. A bye with
    // someone in that seat would be a match shown as a walk-through: refuse it rather than blank the side.
    if (f.bye && (f.awaySeed !== null || f.awayFrom !== null)) {
      throw new Error(`quickMatchPreview cannot name ${where}: a bye with its away seat filled`);
    }
    const line: QuickMatchPreviewLine = {
      home: seatOf(f.homeSeed, f.homeFrom, where),
      away: f.bye ? EMPTY_SEAT : seatOf(f.awaySeed, f.awayFrom, where),
      bye: f.bye,
    };
    if (f.bye) byeCount++;
    else matchCount++;
    const round = rounds.get(f.roundNo);
    if (round) round.lines.push(line);
    else rounds.set(f.roundNo, { roundNo: f.roundNo, role: f.role, lines: [line] });
  }
  return { matchCount, byeCount, rounds: [...rounds.values()] };
}
