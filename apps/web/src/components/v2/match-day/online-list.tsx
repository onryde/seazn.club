"use client";
// Match Day's online block (spec 2026-11-05 §5.1, §5.2, §5.5; owner pick: mock Option A): the third block of the list, after the courts and
// the "Playing, no court" rows. For every online round one round row, its boards directly under it in board order, and - on the
// division's first row - a "Needs a decision" sub-group of the held or flagged boards no round lists (earlier rounds, or a cancelled board
// of the listed round that still has a report), each with its round chip; the heading says "earlier rounds" only when that is true. The
// rounds are in `orderOnlineRounds` order (check-in or in progress, then paired, then over). Nothing at all - no heading, no card - when
// the day has no online round, so a day of courts is exactly the page it was. A round the viewer plays on says so in one line after its
// boards (spec §6.4: the board itself stays unlisted; the line is the List column's only - no panel repeats it).
import { useId } from "react";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { orderOnlineRounds, type OnlineOpened } from "@/lib/match-day/online";
import { earlierRoundChip, needsDecisionHeading } from "@/lib/match-day/online-copy";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";
import { BoardRow } from "./board-row";
import { RoundRow } from "./round-row";

/** A board of the listed round as a row: the round's own place on it (`resolveOnlineFocus` makes the same row for a focused one). */
const rowOf = (b: ArbiterBoard, r: MatchDayOnlineRound): MatchDayBoardRow => ({ ...b, stage_id: r.stage_id, round_no: r.round_no });

export function OnlineList({
  rounds,
  selected,
  dict,
  locale,
  nowMs,
  onOpenRound,
  onOpenBoard,
}: {
  /** The rounds to list (already narrowed by the division chips); ordered here. */
  rounds: MatchDayOnlineRound[];
  /** The round or board in focus, when it is one of these. */
  selected: OnlineOpened | null;
  dict: Dict;
  locale: Locale;
  nowMs: number | null;
  onOpenRound: (key: string) => void;
  onOpenBoard: (fixtureId: string) => void;
}) {
  const headingId = useId();
  if (rounds.length === 0) return null;
  return (
    <section data-testid="md-online" aria-labelledby={headingId} className="min-w-0">
      <h2 id={headingId} className="mb-2 px-1 text-xs font-semibold text-slate-600">
        {t(dict, "matchDay.online.title")}
      </h2>
      <ul aria-label={t(dict, "matchDay.online.list.label")} className="card divide-y divide-purple-50 overflow-hidden">
        {orderOnlineRounds(rounds, nowMs).flatMap((r) => [
          <RoundRow key={r.key} round={r} selected={selected?.kind === "round" && selected.key === r.key} dict={dict} locale={locale} nowMs={nowMs} onOpen={onOpenRound} />,
          ...[...(r.round?.boards ?? [])]
            .sort((a, b) => a.boardNo - b.boardNo)
            .map((b) => (
              <BoardRow
                key={b.fixtureId}
                board={rowOf(b, r)}
                selected={selected?.kind === "board" && selected.id === b.fixtureId}
                dict={dict}
                locale={locale}
                onOpen={onOpenBoard}
              />
            )),
          // Spec §6.4: an organiser who plays on a board does not see it listed - and ONE line says so, where they would look for it.
          ...(r.own_boards > 0
            ? [
                <li key={`${r.key}:own`} data-testid="md-own-hidden" className="px-4 py-2 text-xs leading-[1.45] text-slate-600 [overflow-wrap:anywhere]">
                  {t(dict, "matchDay.online.ownHidden")}
                </li>,
              ]
            : []),
          ...(r.needs_decision.length === 0
            ? []
            : [
                <li key={`${r.key}:needs`} data-testid="md-board-subgroup" className="bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-800 [overflow-wrap:anywhere]">
                  {needsDecisionHeading(dict, r)}
                </li>,
                ...r.needs_decision.map((b) => (
                  <BoardRow
                    key={b.fixtureId}
                    board={b}
                    selected={selected?.kind === "board" && selected.id === b.fixtureId}
                    dict={dict}
                    locale={locale}
                    roundChip={earlierRoundChip(dict, b.round_no)}
                    onOpen={onOpenBoard}
                  />
                )),
              ]),
        ])}
      </ul>
    </section>
  );
}
