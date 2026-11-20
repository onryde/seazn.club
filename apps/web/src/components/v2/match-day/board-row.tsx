"use client";
// One online board in Match Day's list (spec 2026-11-05 §5.1; owner pick: mock Option A, "boards are rows"): "Board 3", the two players
// (White first) each with a presence mark, and the state word on the right - a court row's own grid, dot and 56px target. A board of an
// earlier round (the "Needs a decision" group, §5.5) wears its round's chip. The names WRAP rather than cut (the no-court rows' rule:
// a name cut at 320 loses the away player), and every word and mark carries its text as well as its colour.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { boardRowWord, presenceMark, type PresenceMark } from "@/lib/match-day/online";
import { boardLabel, boardWord, nameParts, presenceText } from "@/lib/match-day/online-copy";
import type { MatchDayBoardRow, MatchDayRound } from "@/lib/match-day/types";
import { MatchRoundChip } from "./round-chip";
import { WORD_TONE } from "./online-tone";

/** The state dot, by the board's state: green live, an amber ring while checking in, amber once the game exists, red while it waits for
 *  the organiser (and for a cancelled board's flags), grey once decided. */
const DOT: Record<MatchDayBoardRow["state"]["kind"], string> = {
  checking_in: "border-2 border-amber-500 bg-white",
  starting: "bg-amber-500",
  live: "bg-emerald-500",
  on_hold: "bg-red-600",
  result: "bg-slate-300",
  cancelled: "bg-red-600",
};

/** The presence mark's paint: a filled green dot here, an amber square with the camera off, an open grey ring when nobody is there. */
const MARK: Record<Exclude<PresenceMark, null>, string> = {
  here: "rounded-full bg-emerald-500",
  off: "rounded-[2px] bg-amber-500",
  away: "rounded-full border border-slate-400 bg-white",
};

function Mark({ mark, dict }: { mark: PresenceMark; dict: Dict }) {
  const text = presenceText(dict, mark);
  if (mark === null || text === null) return null;
  return (
    <span data-testid="md-presence" data-mark={mark} title={text} className={`mx-1 inline-block h-[7px] w-[7px] align-middle ${MARK[mark]}`}>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** A player's name and the presence mark that follows it. The mark is bound to the name's LAST word in a `whitespace-nowrap` unit, so when
 *  the name wraps at 320 the ring wraps WITH its word instead of standing alone on a line (controller finding V1); the rest of the name
 *  still wraps, as before. No mark, no unit: the name is plain text. */
function Seat({ name, mark, dict, seat }: { name: string; mark: PresenceMark; dict: Dict; seat: "white" | "black" }) {
  const { head, tail } = nameParts(name);
  const attr = seat === "white" ? { "data-md-board-white": "" } : { "data-md-board-black": "" };
  if (mark === null) return <span {...attr}>{name}</span>;
  return (
    <span {...attr}>
      {head}
      <span className="whitespace-nowrap">
        <span data-md-name-tail>{tail}</span>
        <Mark mark={mark} dict={dict} />
      </span>
    </span>
  );
}

export function BoardRow({
  board,
  selected,
  dict,
  locale,
  roundChip = null,
  onOpen,
}: {
  board: MatchDayBoardRow;
  selected: boolean;
  dict: Dict;
  locale: Locale;
  /** The round an earlier-round board belongs to (the "Needs a decision" group); null for a board of the round it is listed under. */
  roundChip?: MatchDayRound | null;
  onOpen: (fixtureId: string) => void;
}) {
  const word = boardWord(dict, locale, boardRowWord(board));
  // White first; the mark is the SEAT's (`home`/`away`), which `whiteSide` maps to the colour.
  const blackSide = board.whiteSide === "home" ? "away" : "home";
  return (
    <li>
      <button
        type="button"
        data-testid="md-board-row"
        data-fixture-id={board.fixtureId}
        data-state={board.state.kind}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(board.fixtureId)}
        className={`grid min-h-14 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 text-left text-slate-900 transition hover:bg-purple-50/60 ${
          selected ? "md:bg-purple-50 md:shadow-[inset_3px_0_0_var(--color-purple-600)]" : ""
        }`}
      >
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[board.state.kind]}`} />
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            {roundChip !== null && <MatchRoundChip round={roundChip} />}
            <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{boardLabel(dict, board)}</span>
          </span>
          <span className="block min-w-0 text-xs text-slate-600 [overflow-wrap:anywhere]">
            <Seat name={board.white.name} mark={presenceMark(board, board.whiteSide)} dict={dict} seat="white" />
            {` ${t(dict, "matchDay.online.versus")} `}
            <Seat name={board.black.name} mark={presenceMark(board, blackSide)} dict={dict} seat="black" />
          </span>
        </span>
        <span className="max-w-[9rem] shrink-0 text-right">
          <span data-md-board-word className={`block min-w-0 text-xs font-semibold tabular-nums [overflow-wrap:anywhere] ${WORD_TONE[word.tone]}`}>
            {word.text}
          </span>
          {word.sub !== null && <span className="mt-0.5 block min-w-0 text-xs font-medium text-slate-600 [overflow-wrap:anywhere]">{word.sub}</span>}
        </span>
      </button>
    </li>
  );
}
