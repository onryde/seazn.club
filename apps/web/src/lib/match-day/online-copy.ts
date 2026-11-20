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

/** The title as two parts, so a narrow track can wrap the division and the stage (free text) and never the round label: `lead` is
 *  everything up to the label's word, `tail` is "Round 3" (the locale's word and the number, and anything the sentence puts after it).
 *  Read off the dictionary's own sentence - the round is formatted as a marker, and the word before the marker joins the number - so
 *  every locale splits where its own sentence puts the label. A sentence with no round in it, or one the split cannot recompose into the
 *  title, is all lead: the title is never altered, only cut. */
export function onlineRoundTitleParts(
  dict: Dict,
  r: Pick<MatchDayOnlineRound, "division_name" | "stage_name" | "round_no" | "multi_stage">,
): { lead: string; tail: string } {
  const whole = onlineRoundTitle(dict, r);
  const key = r.multi_stage ? "matchDay.online.roundStage" : "matchDay.online.round";
  const marked = t(dict, key, { division: r.division_name, stage: r.stage_name, round: ROUND_MARK });
  const at = marked.lastIndexOf(ROUND_MARK);
  if (at === -1) return { lead: whole, tail: "" };
  const before = marked.slice(0, at);
  const word = before.trimEnd().lastIndexOf(" ") + 1;
  const lead = before.slice(0, word);
  const tail = before.slice(word) + String(r.round_no) + marked.slice(at + ROUND_MARK.length);
  return lead + tail === whole ? { lead, tail } : { lead: whole, tail: "" };
}
/** Stands where the round number goes while the title is cut; never part of a name a person types. */
const ROUND_MARK = "\u0001";

/** Is this board of the round the row stands for? A board of the "Needs a decision" group can be of the listed round itself (a cancelled
 *  board with an open flag is dropped from the round's own boards by the loader) or of an earlier round or stage. */
export function isOwnRound(b: Pick<MatchDayBoardRow, "stage_id" | "round_no">, r: Pick<MatchDayOnlineRound, "stage_id" | "round_no">): boolean {
  return b.stage_id === r.stage_id && b.round_no === r.round_no;
}

/** The round row's second line: "Swiss · 10+5 · 6 boards". The stage leads only when the title does not already carry it, and a round
 *  with no board on screen (every board the viewer's own, or not opened yet) names no count of boards. The count is the round's OWN boards
 *  as the list shows them: its listed boards plus those of its own held or flagged boards the "Needs a decision" group carries (a
 *  cancelled board with an open flag), never an earlier round's. */
export function onlineRoundMeta(
  dict: Dict,
  locale: Locale,
  r: Pick<MatchDayOnlineRound, "stage_name" | "multi_stage" | "round" | "stage_id" | "round_no" | "needs_decision">,
): string {
  const boards = (r.round?.boards.length ?? 0) + r.needs_decision.filter((b) => isOwnRound(b, r)).length;
  return [
    r.multi_stage ? null : r.stage_name,
    r.round?.timeControl ?? null,
    boards > 0 ? plural(dict, "matchDay.header.places.board", boards, locale) : null,
  ]
    .filter((p): p is string => p !== null && p !== "")
    .join(" · ");
}

/** The heading over a round's "Needs a decision" group (ruling MD-R25): "· earlier rounds" only when it is TRUE, which is when every board
 *  under it is of another round than the row's. A board of the listed round itself (or a mix) reads the plain heading. Null for a group
 *  with no board (no heading is drawn). */
export function needsDecisionHeading(dict: Dict, r: Pick<MatchDayOnlineRound, "stage_id" | "round_no" | "needs_decision">): string | null {
  if (r.needs_decision.length === 0) return null;
  return t(dict, r.needs_decision.every((b) => !isOwnRound(b, r)) ? "matchDay.online.needsDecision" : "matchDay.online.needsDecisionPlain");
}

/** How much of a long last word the presence mark is bound to (see `nameParts`). */
export const RING_TAIL_MAX = 16;

/** A player's name in two pieces for the board row: everything before the last word, and the last word, which the presence mark is bound
 *  to (a `whitespace-nowrap` unit) so a wrapped name never leaves its ring alone on a line. A last word longer than `RING_TAIL_MAX`
 *  characters binds only its final `RING_TAIL_MAX`, so one very long word still wraps instead of widening the row. Code points, not UTF-16
 *  units, so an emoji is never cut in half; trailing space is not part of the name. */
export function nameParts(name: string): { head: string; tail: string } {
  const cps = Array.from(name.trimEnd());
  let start = cps.length;
  while (start > 0 && !/\s/u.test(cps[start - 1]!)) start--;
  if (cps.length - start > RING_TAIL_MAX) start = cps.length - RING_TAIL_MAX;
  return { head: cps.slice(0, start).join(""), tail: cps.slice(start).join("") };
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
