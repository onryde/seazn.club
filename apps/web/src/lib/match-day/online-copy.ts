// Match Day online rows - the words (plan 2026-11-05-match-day-all-in-one.md Task 6; spec §5.1). The pure rules (lib/match-day/online.ts)
// answer WHAT a row says as data (`RoundRowWord`, `BoardRowWord`, `PresenceMark`); this file turns that data into the reader's language,
// from the `matchDay.online.*` keys the page's picked dictionary already carries (no new prefix crosses to the client). Client-safe and
// DOM-free, so the node-environment suite reaches every word without rendering a component.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { fmtPublicTime } from "@/lib/format";
import type { BoardRowWord, PresenceMark, RoundRowWord } from "./online";
import type { MatchDayBoardRow, MatchDayOnlineRound, MatchDayRound } from "./types";

/** How loud a word is, from the row dot's own palette: a board playing, one waiting on a player, one waiting on the organiser, a score,
 *  and the quiet states. The components map a tone to a colour; the tone is the fact. */
export type WordTone = "live" | "wait" | "hold" | "done" | "quiet";

/** "Online Rapid · Round 3", and "U18 · Swiss · Round 2" when the division has more than one round row (the stage then tells them apart,
 *  spec §5.2). */
export function onlineRoundTitle(dict: Dict, r: Pick<MatchDayOnlineRound, "division_name" | "stage_name" | "round_no" | "multi_stage">): string {
  return r.multi_stage
    ? t(dict, "matchDay.online.roundStage", { division: r.division_name, stage: r.stage_name, round: r.round_no })
    : t(dict, "matchDay.online.round", { division: r.division_name, round: r.round_no });
}

/** The round row's second line: "Swiss · 10+5 · 6 boards". The stage leads only when the title does not already carry it, and a round
 *  with no board on screen (every board the viewer's own, or not opened yet) names no count of boards. */
export function onlineRoundMeta(dict: Dict, locale: Locale, r: Pick<MatchDayOnlineRound, "stage_name" | "multi_stage" | "round">): string {
  const boards = r.round?.boards.length ?? 0;
  return [
    r.multi_stage ? null : r.stage_name,
    r.round?.timeControl ?? null,
    boards > 0 ? plural(dict, "matchDay.header.places.board", boards, locale) : null,
  ]
    .filter((p): p is string => p !== null && p !== "")
    .join(" · ");
}

/** What the round row says on the right: a main line, and a quieter one under it (check-in: "closes 19:58" over "9 of 12 here"). Null
 *  when it has nothing to say - a round whose every board is the viewer's own (`total` 0) reads "0 of 0 playing" otherwise. Times print
 *  in the venue's zone (`tz`), as the arbiter column printed them. */
export function roundWordLines(dict: Dict, locale: Locale, tz: string, word: RoundRowWord): { main: string; sub: string | null; tone: WordTone } | null {
  switch (word.kind) {
    case "closes":
      return {
        main: t(dict, "matchDay.online.word.closes", { time: fmtPublicTime(locale, tz, word.at) }),
        sub: t(dict, "matchDay.online.word.here", { here: word.here, seats: word.seats }),
        tone: "wait",
      };
    case "playing":
      return word.total === 0
        ? null
        : { main: t(dict, "matchDay.online.word.playing", { playing: word.playing, total: word.total }), sub: null, tone: "live" };
    case "paired":
      return { main: t(dict, "matchDay.online.word.paired"), sub: null, tone: "quiet" };
    case "not_started":
      return { main: t(dict, "matchDay.online.word.notStarted"), sub: null, tone: "quiet" };
    case "over":
      return { main: t(dict, "matchDay.online.word.over"), sub: null, tone: "quiet" };
  }
}

/** "Board 3". */
export function boardLabel(dict: Dict, b: Pick<MatchDayBoardRow, "boardNo">): string {
  return t(dict, "matchDay.online.board", { n: b.boardNo });
}

/** "Board 3 · Abara v Petrovic": a board's whole name, which the "left the list" notice prints. */
export function boardName(dict: Dict, b: Pick<MatchDayBoardRow, "boardNo" | "white" | "black">): string {
  return `${boardLabel(dict, b)} · ${b.white.name} ${t(dict, "matchDay.online.versus")} ${b.black.name}`;
}

/** What a board row says on the right: "Live · move 12", "On hold" over "1 flag", "1-0". A hold and a cancelled board that still has an
 *  open flag carry the count on a second, quieter line (a "·" at the end of a wrapped line would dangle). */
export function boardWord(dict: Dict, locale: Locale, word: BoardRowWord): { text: string; sub: string | null; tone: WordTone } {
  const flags = (n: number) => (n > 0 ? plural(dict, "matchDay.online.flags", n, locale) : null);
  switch (word.kind) {
    case "checking_in":
      return { text: t(dict, "matchDay.online.word.checkingIn"), sub: null, tone: "wait" };
    case "starting":
      return { text: t(dict, "matchDay.online.word.starting"), sub: null, tone: "wait" };
    case "live":
      return { text: t(dict, "matchDay.online.word.live", { n: word.moveNo }), sub: null, tone: "live" };
    case "on_hold":
      return { text: t(dict, "matchDay.online.word.onHold"), sub: flags(word.flags), tone: "hold" };
    case "result":
      return word.score === null
        ? { text: t(dict, "matchDay.online.word.finished"), sub: null, tone: "quiet" }
        : { text: word.score, sub: null, tone: "done" };
    case "no_result":
      return { text: t(dict, "matchDay.online.word.noResult"), sub: null, tone: "quiet" };
    case "cancelled":
      return { text: t(dict, "matchDay.online.word.cancelled"), sub: flags(word.flags), tone: "hold" };
  }
}

/** The words behind a presence mark (a colour alone says nothing to a screen reader, and little to everyone else): null for no mark. */
export function presenceText(dict: Dict, mark: PresenceMark): string | null {
  switch (mark) {
    case "here":
      return t(dict, "matchDay.online.mark.here");
    case "off":
      return t(dict, "matchDay.online.mark.off");
    case "away":
      return t(dict, "matchDay.online.mark.away");
    case null:
      return null;
  }
}

/** The chip a board of an EARLIER round wears in the "Needs a decision" group: "R2", the board's own fallback (`matchDayRounds`:
 *  `R${round_no}`, not coded) - an online round is a Swiss or league round, never a bracket role. */
export function earlierRoundChip(dict: Dict, roundNo: number): MatchDayRound {
  return { code: `R${roundNo}`, label: t(dict, "matchDay.online.roundN", { n: roundNo }), coded: false };
}

/** The header's "N boards playing": the boards of the rounds on the list that are checking in, starting or live. A held board waits for
 *  the organiser and a decided one is over, so neither counts; a board of an earlier round (the "Needs a decision" group) is never
 *  playing. */
export function boardsPlaying(rounds: readonly Pick<MatchDayOnlineRound, "round">[]): number {
  let n = 0;
  for (const r of rounds) {
    for (const b of r.round?.boards ?? []) {
      if (b.state.kind === "checking_in" || b.state.kind === "starting" || b.state.kind === "live") n++;
    }
  }
  return n;
}
