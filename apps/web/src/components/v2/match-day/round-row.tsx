"use client";
// One online round in Match Day's list (spec 2026-11-05 §5.1): the round's name, its stage/time-control/boards line, and on the right
// the round's one-line state - "closes 19:58 / 9 of 12 here" in check-in, "6 of 10 playing", "Paired, not opened". It is a row like a
// court's (the court list's own grid, 56px target) and opens the round's panel. A square purple dot says "round" where a board's dot
// says how it stands.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { onlineRoundPhase, roundRowWord } from "@/lib/match-day/online";
import { onlineRoundMeta, onlineRoundTitle, roundWordLines } from "@/lib/match-day/online-copy";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";
import { WORD_TONE } from "./online-tone";

export function RoundRow({
  round,
  selected,
  dict,
  locale,
  nowMs,
  onOpen,
}: {
  round: MatchDayOnlineRound;
  selected: boolean;
  dict: Dict;
  locale: Locale;
  /** The shell's clock (null where the mount has none): the check-in window's edge, read against it. */
  nowMs: number | null;
  onOpen: (key: string) => void;
}) {
  const lines = roundWordLines(dict, locale, round.tz, roundRowWord(round, nowMs));
  const meta = onlineRoundMeta(dict, locale, round);
  return (
    <li>
      <button
        type="button"
        data-testid="md-round-row"
        data-key={round.key}
        data-state={onlineRoundPhase(round, nowMs)}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(round.key)}
        className={`grid min-h-14 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 text-left text-slate-900 transition hover:bg-purple-50/60 ${
          selected ? "md:bg-purple-50 md:shadow-[inset_3px_0_0_var(--color-purple-600)]" : ""
        }`}
      >
        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-purple-600" />
        <span className="min-w-0">
          <span className="block min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{onlineRoundTitle(dict, round)}</span>
          {meta !== "" && <span className="block truncate text-xs text-slate-600">{meta}</span>}
        </span>
        <span className="max-w-[9rem] shrink-0 text-right">
          {lines !== null && (
            <>
              <span data-md-round-word className={`block min-w-0 text-xs font-semibold [overflow-wrap:anywhere] ${WORD_TONE[lines.tone]}`}>
                {lines.main}
              </span>
              {lines.sub !== null && <span className="mt-0.5 block min-w-0 text-xs font-medium text-slate-600 [overflow-wrap:anywhere]">{lines.sub}</span>}
            </>
          )}
        </span>
      </button>
    </li>
  );
}
