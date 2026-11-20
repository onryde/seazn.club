"use client";

// The Arbiter Panel's round column (spec 2026-10-24-arbiter-round-column-design.md): the one box that answers "what does this
// round want from me now". This file draws three phases and one list that belongs to the second. The queue (round-queue-cards.tsx,
// the boards that need a decision) is the aside's FIRST child in every one of them, and no CSS order is used inside the aside:
// source order is visual order.
//
//   BEFORE   the round is paired and nobody is invited: one block for each round the organiser can open, with the press, its
//            confirmation, the answer, and a read-only list of the pairings;
//   CHECK-IN the round is open and some board is still `checking_in`: the HERO (the countdown to the next board closing, who has
//            checked in, what is already playing, the round's own +5 and reinvite press, the staggered groups) and, placed by the
//            panel under the camera, the WAITING LIST (the seats that are not here, each seat's invite words, Resend, a board's +5);
//   PLAYING  no board is checking in: the STATUS ("14 of 20 boards playing", the finished clause, and the round bar the panel hands
//            over, then the round's OWN reinvite or reopen press when the reader names one - a re-armed board after the D17 void) and,
//            below it, the NEXT round's press - quiet while any board plays or the round's own press is owed, with every earlier-in-play
//            warning shown inline, and primary once every board on screen is over and nothing of this round is owed.
//
// What a BEFORE block presses is its OWN round. Each block calls `useOpenRound(view)` itself (R1 holds per round). The handle the
// panel shares for the round ON SCREEN (`openRound`, C9) is for the check-in hero and the waiting list: both press the same
// request guard, so a Resend on a row and the hero's reinvite are never in flight together. The press, its confirmation and its
// answer are the ones the run sheet's control uses (`OpenRoundConfirmBody`, `openNoticeText`, `resendNoticeText`,
// `openRoundRunner`'s in-flight guard behind `useOpenRound`), so a double click is one POST and a press from a page made stale by an
// open elsewhere reads "already open" and invites nobody.
//
// House theme (spec §4): ink / soft / muted text, `#e7e3f3` borders, `#7c3aed` for the one primary button per block, 44px
// targets, one DOM, mobile-first, `min-w-0` down every ancestor of a name. The countdown is the column's one large element.
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { ArbiterRound } from "@/lib/arbiter-view";
import type { OpenRoundView } from "@/lib/open-round";
import { boardsOwedAnInvite, nextRoundViews, playingTally, roundColumnPhase, viewOfRound } from "@/lib/round-column";
import { routes } from "@/lib/routes";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { SOFT } from "../arbiter-flag-cards";
import { useOpenRound, type OpenRoundHandle } from "../desk/use-open-round";
import {
  BUTTON_PRIMARY,
  CARD_BOX,
  CheckinHero,
  OpenRoundBlockView,
  PlayingStatus,
  roundPress,
  type PlayingEmphasis,
} from "../match-day/round-focus";
import { RoundQueueCards } from "./round-queue-cards";

// The bodies this column draws - the check-in hero, the waiting list, the playing status, the open-round block and the round's own press -
// MOVED to match-day/round-focus.tsx (Match Day's round panel, Task 7) with their test ids unchanged; this column imports them, and
// the Arbiter Panel's panel imports the waiting list (and the types) from here still. Task 10 deletes the Arbiter Panel and this column with it.
export { CheckinHero, OpenRoundBlockView, PlayingStatus, WaitingList, roundPress } from "../match-day/round-focus";
export type { CheckinHeroProps, PlayingEmphasis, WaitingListProps } from "../match-day/round-focus";

/** What the arbiter page hands the column, read once per poll. */
export type RoundColumnData = {
  /** `listOpenRounds`, in the reader's order. */
  views: OpenRoundView[];
  /** The organiser's queue: held boards (type-only: this file is a client module). */
  held: NeedsOrganiserExternalPlayRow[];
  flagged: FlaggedBoard[];
  /** Flagged boards the organiser plays on: counted in their own line, never in the queue. */
  ownFlagged: number;
  /** `getScheduleSettings(...).tz`, the venue zone. */
  tz: string;
  /** `divisionScoringClosed(division.status)`: the division has not started, so no round can be opened. */
  awaitsStart: boolean;
};

/** Where the aside sits (spec §5.1). The panel knows its own path, so it says: `grid` on the board grid (the aside spans the two
 *  rows of the middle track from md, and is the first thing on a phone), `solo` on the paths with no grid (before the round opens, and
 *  a round with no board on screen: the notice in track 1, the aside in track 2). */
export type ColumnPlacement = "solo" | "grid";

export type RoundColumnProps = {
  round: ArbiterRound | null;
  requested: "unavailable" | "own" | null;
  data: RoundColumnData;
  nowMs: number | null;
  slugs: { org: string; comp: string; div: string };
  /** C9: the round on screen's handle, owned by ArbiterPanel and shared with WaitingList. */
  openRound: OpenRoundHandle;
  on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
  /** C13: the panel's one RoundExtend, placed by phase. null when the panel mounts it elsewhere. */
  roundExtend: ReactNode;
  /** Required: a column that does not say where it sits is placed by accident (spec §5.1, C10). */
  placement: ColumnPlacement;
};

/** Spec §5.1: the aside is one real box (a landmark is never `contents`) placed by NAME, so its place does not depend on where it sits
 *  in the DOM. Below md it is first on the page (`order -2` on the grid path, one ahead of the waiting list's -1; `-1` where there is no
 *  waiting list to lead). From md it is the second track: on the grid path it spans both rows, and from lg it moves to the third track
 *  beside the board, over the decision group. A two-entry lookup rather than a conditional string, so the two places are read side by
 *  side and a third cannot be added without choosing its classes. */
const ASIDE_BASE = "flex min-w-0 flex-col gap-3";
const ASIDE_PLACEMENT: Record<ColumnPlacement, string> = {
  grid: "max-md:order-[-2] md:col-start-2 md:row-start-1 md:row-span-2 lg:col-start-3 lg:row-start-1 lg:row-span-1",
  solo: "max-md:order-[-1] md:col-start-2 md:row-start-1",
};

export function RoundColumn(p: RoundColumnProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const phase = roundColumnPhase(p.round, p.requested);
  // "none" is the panel's notice standing alone (spec §5.2 rule 1): no column, and no queue with it.
  if (phase === "none") return null;
  const asideClass = `${ASIDE_BASE} ${ASIDE_PLACEMENT[p.placement]}`;

  // First in the aside in every phase, ahead of the phase block: source order is visual order (C10). It renders nothing at all
  // when there is nothing to decide.
  const queue = (
    <RoundQueueCards
      round={p.round}
      held={p.data.held}
      flagged={p.data.flagged}
      ownFlagged={p.data.ownFlagged}
      slugs={p.slugs}
      onSelect={p.on.select}
    />
  );

  if (phase === "checkin") {
    // `checking_in` boards on screen mean a round on screen; a named refusal rather than an assumption.
    if (p.round === null) return null;
    return (
      <aside aria-label={msg("arbiter.column.label")} data-testid="arbiter-round-column" data-phase={phase} className={asideClass}>
        {queue}
        <CheckinHero
          round={p.round}
          view={viewOfRound(p.data.views, p.round)}
          tz={p.data.tz}
          nowMs={p.nowMs}
          openRound={p.openRound}
          roundExtend={p.roundExtend}
        />
      </aside>
    );
  }

  // A named refusal, not an assumption: a view with no pairing has nothing to open or to list. `listOpenRounds` never sends one
  // (open-round-view.ts skips a group with no playable board: `live.length === 0`, "openRound: no_fixtures"), but its type allows
  // it, and a block with an Open round press over "0 boards" is worse than none - in the before phase it falls to the "nothing
  // paired" line below, which is true. Filtered BEFORE the stage count, so a stage with no block does not make the others name theirs.
  const views = nextRoundViews(p.data.views, p.round).filter((v) => v.pairings.length > 0);
  // The stage is named only when more than one STAGE has a block (spec §5.4), not when more than one block exists.
  const showStage = new Set(views.map((v) => v.stageId)).size > 1;

  if (phase === "playing") {
    if (p.round === null) return null;
    // Final review I2: the round on screen's OWN press, when the reader names one. After D17 (the arbiter's No result, then the organiser's
    // void) the re-armed board keeps its bridge row `finished`, so it paints as a result and no board is `checking_in`: this is the one
    // place the organiser's re-open can be pressed. The handle is the panel's (the same one the check-in hero and the waiting list read).
    const own = roundPress({
      round: p.round,
      view: viewOfRound(p.data.views, p.round),
      tz: p.data.tz,
      openRound: p.openRound,
      msg,
      plural,
      buttonClass: `${BUTTON_PRIMARY} py-2 text-balance`,
    });
    // The boards the press would invite are, on screen, over without a result: the card counts them as WAITING TO RESTART CHECK-IN, not finished.
    const owed = boardsOwedAnInvite(own.owedView);
    // Primary needs every board on screen over. With no board on screen at all (a round whose every board is the organiser's own)
    // the empty set would satisfy "every board is over" vacuously, and nobody can say it is: `total > 0` keeps the press quiet.
    // The next round waits for the owed press too: a board owed its re-open is not "over", whatever its bridge row says (`finished`
    // already leaves the waiting boards out; the press check covers an owed press whose boards are not on screen).
    const { total, finished } = playingTally(p.round.boards, owed);
    const primary = total > 0 && finished === total && own.owedView === null;
    return (
      <aside aria-label={msg("arbiter.column.label")} data-testid="arbiter-round-column" data-phase={phase} className={asideClass}>
        {queue}
        <PlayingStatus round={p.round} roundExtend={p.roundExtend} owed={owed}>
          {own.button}
          {own.notice}
          {own.dialog}
        </PlayingStatus>
        {views.map((view) => (
          <NextRoundBlock key={`${view.stageId}:${view.roundNo}`} view={view} tz={p.data.tz} showStage={showStage} playing={{ primary }} />
        ))}
      </aside>
    );
  }

  return (
    <aside aria-label={msg("arbiter.column.label")} data-testid="arbiter-round-column" data-phase={phase} className={asideClass}>
      {queue}
      {p.data.awaitsStart ? (
        // Before Start `listOpenRounds` answers [], so "nothing paired" would also be true: the start line wins (pre-flight A8),
        // and no press is offered even if a view arrived.
        <p data-testid="arbiter-column-start-first" className={`m-0 text-sm leading-[1.5] ${SOFT} ${CARD_BOX}`}>
          {msg("externalPlay.openRound.startFirst")}
        </p>
      ) : views.length === 0 ? (
        <div data-testid="arbiter-column-nothing" className={`flex flex-col items-start gap-1 ${CARD_BOX}`}>
          <p className={`m-0 text-sm leading-[1.5] ${SOFT}`}>{msg("arbiter.column.nothingPaired")}</p>
          {/* Another page, not this one: the Fixtures tab is where a round is paired. */}
          <Link
            href={routes.division(p.slugs.org, p.slugs.comp, p.slugs.div, "fixtures")}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-[#5b21b6] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]"
          >
            {msg("arbiter.column.toFixtures")}
          </Link>
        </div>
      ) : (
        views.map((view) => <NextRoundBlock key={`${view.stageId}:${view.roundNo}`} view={view} tz={p.data.tz} showStage={showStage} />)
      )}
    </aside>
  );
}

/** One open-able round with a handle of its own: the thin hook wrapper around the pure view. */
function NextRoundBlock({ view, tz, showStage, playing }: { view: OpenRoundView; tz: string; showStage: boolean; playing?: PlayingEmphasis }) {
  const handle = useOpenRound(view);
  return (
    <OpenRoundBlockView view={view} state={handle.state} tz={tz} showStage={showStage} on={{ ask: handle.ask, cancel: handle.cancel, open: handle.open }} playing={playing} />
  );
}
