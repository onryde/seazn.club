"use client";
// The focus column for an online round or board (spec 2026-11-05 §6.3): the court panel's own frame - "‹ All courts" on a phone, the
// name, what it is - which the shell mounts for a round or a board opened from the list, from Needs you or from `?round=` /
// `?board=`. The round's panel (Task 7: phases, not here yet, presses) and the board's (Task 8: the chess board, flags, decisions)
// fill the body; what is here is the frame and the state line they share, with the props they will read (`reader` is the one
// `mayPress` takes - the shell builds it from the viewer's role, the club's flag and the billing freeze).
import type { ReactNode } from "react";
import { onlineRoundPhase, roundRowWord, boardRowWord, type Reader } from "@/lib/match-day/online";
import { boardName, boardWord, earlierRoundChip, onlineRoundMeta, onlineRoundTitle, roundWordLines } from "@/lib/match-day/online-copy";
import type { MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";
import { BackButton, type MatchDayCtx } from "./court-focus";
import { MatchRoundChip } from "./round-chip";
import { WORD_TONE } from "./online-tone";

function OnlineFocusFrame({
  testAttrs,
  title,
  backLabel,
  onBack,
  hiddenOnPhone,
  subtitle,
  children,
}: {
  testAttrs: Record<string, string>;
  title: string;
  backLabel: string;
  onBack: () => void;
  hiddenOnPhone: boolean;
  subtitle: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      data-testid="md-focus"
      {...testAttrs}
      aria-label={title}
      className={`grid min-w-0 content-start gap-4${hiddenOnPhone ? " max-md:hidden" : ""}`}
    >
      <BackButton label={backLabel} onBack={onBack} />
      <header className="min-w-0">
        <h2 className="min-w-0 text-xl font-semibold text-purple-950 [overflow-wrap:anywhere]">{title}</h2>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-slate-600 [overflow-wrap:anywhere]">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

/** An online round in focus. */
export function OnlineRoundPanel({
  ctx,
  round,
  nowMs,
  backLabel,
  onBack,
  hiddenOnPhone = false,
}: {
  ctx: MatchDayCtx;
  round: MatchDayOnlineRound;
  /** The shell's reader for this round's rows (`mayPress`'s input); Task 7's presses ask it. */
  reader: Reader;
  nowMs: number | null;
  backLabel: string;
  onBack: () => void;
  hiddenOnPhone?: boolean;
}) {
  const lines = roundWordLines(ctx.dict, ctx.locale, round.tz, roundRowWord(round, nowMs));
  return (
    <OnlineFocusFrame
      testAttrs={{ "data-online": "round", "data-key": round.key, "data-state": onlineRoundPhase(round, nowMs) }}
      title={onlineRoundTitle(ctx.dict, round)}
      backLabel={backLabel}
      onBack={onBack}
      hiddenOnPhone={hiddenOnPhone}
      subtitle={onlineRoundMeta(ctx.dict, ctx.locale, round)}
    >
      {lines !== null && (
        <p data-testid="md-online-state" className={`min-w-0 text-sm font-semibold [overflow-wrap:anywhere] ${WORD_TONE[lines.tone]}`}>
          {lines.main}
          {lines.sub !== null && <span className="ml-2 font-medium text-slate-600">{lines.sub}</span>}
        </p>
      )}
    </OnlineFocusFrame>
  );
}

/** An online board in focus, with the round row it sits under. */
export function OnlineBoardPanel({
  ctx,
  round,
  row,
  backLabel,
  onBack,
  hiddenOnPhone = false,
}: {
  ctx: MatchDayCtx;
  round: MatchDayOnlineRound;
  row: MatchDayBoardRow;
  /** The shell's reader for this board (`mayPress`'s input); Task 8's decisions ask it. */
  reader: Reader;
  backLabel: string;
  onBack: () => void;
  hiddenOnPhone?: boolean;
}) {
  const word = boardWord(ctx.dict, ctx.locale, boardRowWord(row));
  return (
    <OnlineFocusFrame
      testAttrs={{ "data-online": "board", "data-fixture-id": row.fixtureId, "data-state": row.state.kind }}
      title={boardName(ctx.dict, row)}
      backLabel={backLabel}
      onBack={onBack}
      hiddenOnPhone={hiddenOnPhone}
      subtitle={
        <>
          <span>{round.division_name}</span>
          <MatchRoundChip round={earlierRoundChip(ctx.dict, row.round_no)} />
          {round.stage_name !== "" && <span>{round.stage_name}</span>}
        </>
      }
    >
      <p data-testid="md-online-state" className={`min-w-0 text-sm font-semibold [overflow-wrap:anywhere] ${WORD_TONE[word.tone]}`}>
        {word.text}
        {word.sub !== null && <span className="ml-2 font-medium text-slate-600">{word.sub}</span>}
      </p>
    </OnlineFocusFrame>
  );
}
