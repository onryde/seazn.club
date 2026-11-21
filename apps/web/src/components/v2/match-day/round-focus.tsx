"use client";
// The round panel (Match Day online, plan 2026-11-05-match-day-all-in-one.md Task 7; spec §6.3 "round panel"; owner rulings MD-R2/R15/R22):
// what one online round wants from the organiser, in the focus column of the day. `RoundFocus` (bottom of this file) draws one phase of
// it - not started, paired and waiting to open, checking in, playing - for the ROW it is handed and no other: every press is that row's
// own `view` (its stage and round number), never the day's "current round", so an older stage's round row is as live as a newer one.
//
// The bodies it draws (they began as the retired Arbiter page's round column and were MOVED here, test ids unchanged): the check-in
// hero, the "Not here yet" waiting list, the playing status, the open-round block with its pairings, and the round's own reinvite /
// reopen press (`roundPress`). What the panel adds is Match Day's:
//   - presses render only while `mayPress(reader, "start")` - an editor of an offered club on a competition that is not billing-frozen
//     (O4: a frozen competition keeps its read and its phase lines, and loses every press that STARTS play). A frozen flag comes from a
//     polled view, so a panel drawn a moment before the freeze can still send one: the server answers 402 and the answer is worded as the
//     freeze (`BILLING_FROZEN_CODE`), never "failed";
//   - the open's presses refresh through the shell's own quiet day read (`onChanged`): the shell's view is its own state, so the Next
//     router's `refresh()` would not move it;
//   - "Round N+1 is ready to open" (the shell's `next`) while this round checks in or plays, and, once every board of the round is over,
//     "Pair next round" on a Swiss stage whose next round is not yet paired (MD-R15: the stage rail's own press, `POST /stages/{id}/generate`);
//   - a board held for a Lichess link says so, why, and - the one press, named for what it does - "Open round N again" (MD-R2/R22); a
//     board whose window has closed says the window closed instead of offering a press that would do nothing.
//
// House theme (spec §4): ink / soft / muted text, `#e7e3f3` borders, `#7c3aed` for the one primary button per block, 44px targets, one DOM,
// mobile-first, `min-w-0` down every ancestor of a name. The countdown is the check-in's one large element.
import { useEffect, useMemo, useReducer, type ReactNode } from "react";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import { extendEdgesOf, watchedWindows } from "@/lib/checkin-extend";
import { apiV1 } from "@/lib/client-v1";
import { INVITE_WORD_KEYS, seatWords, type SeatInviteWord } from "@/lib/invite-status";
import { linkHolds, mayPress, onlineRoundPhase, pairNextRound, roundRowWord, type LinkHold, type Reader } from "@/lib/match-day/online";
import { onlineRoundMeta, onlineRoundTitle, roundWordLines } from "@/lib/match-day/online-copy";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";
import type { MessageKey } from "@/lib/messages";
import { BILLING_FROZEN_CODE, OPEN_ROUND_SKIP_KEYS, type OpenRoundView } from "@/lib/open-round";
import { boardsOwedAnInvite, checkinClock, checkinTally, openWindowBoards, playingTally } from "@/lib/round-column";
import { isSwissRefusalCode } from "@/lib/swiss-refusals";
import { swissRefusalText } from "@/lib/swiss-refusal-text";
import { nextRoundText } from "@/lib/swiss-next-round";
import { BUTTON_QUIET, CLOCK_FACE, MUTED, SOFT } from "../arbiter-flag-cards";
import {
  boardExtendOffer,
  extendBoardLabel,
  extendBoardSentence,
  extendFailureText,
  extendHelperLine,
  extendRoundLabel,
  extendRoundLines,
  initialRoundExtend,
  liveExtendableBoards,
  roundExtendRunner,
  roundExtendUi,
  type ExtendCopy,
  type RoundExtendState,
} from "../checkin-extend-ui";
import { ConfirmDialog } from "../confirm-dialog";
import { OpenRoundConfirmBody, openNoticeText, owedPlayers, resendNoticeText, timedBatches, type BoardSeats } from "../desk/open-round-control";
import type { OpenRoundUiState } from "../desk/open-round-state";
import { useOpenRoundWith, type OpenRoundHandle } from "../desk/use-open-round";
import { useExtendClock } from "../use-extend-clock";
import { useVenueClock } from "../venue-clock";
import type { MatchDayCtx } from "./court-focus";
import { OnlineFocusFrame } from "./online-focus";
import { WORD_TONE } from "./online-tone";
import {
  boardExtendRunner,
  boardExtendUi,
  initialBoardExtend,
  initialPairNext,
  pairNextRunner,
  pairNextUi,
  type BoardExtendState,
  type PairNextState,
} from "./round-presses";

export const INK = "text-[#2e1065]";
export const CARD_BOX = "min-w-0 rounded-xl border border-[#e7e3f3] bg-white p-3";
export const BUTTON_PRIMARY =
  "min-h-11 w-full cursor-pointer rounded-[10px] bg-[#7c3aed] px-4 text-[15px] font-semibold text-white hover:bg-[#5b21b6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto";

type Msg = ReturnType<typeof useMsg>;
type Plural = ReturnType<typeof useMsgPlural>;

// ---- the round panel's bodies: the playing status, the open-round block, the round's own press -------------------------------

/** The playing phase's status (spec §5.5): "14 of 20 boards playing" and the finished clause over the boards on screen, then the
 *  round bar the panel hands over (its why line and last answer: C13). A round with no board on screen (every board is the
 *  organiser's own) prints no count at all - never "0 of 0" - and keeps the heading and the bar. A zero finished clause is not
 *  printed (desk _RULES: an empty cell is not information). The count agrees with the TOTAL ("1 of 1 board"). `owed` is the boards the
 *  round's own press would still invite: the ones of them that are over on screen are "waiting to restart check-in", not finished (D17), so playing,
 *  finished, on hold and waiting add up to the total. */
export function PlayingStatus({
  round,
  roundExtend,
  owed,
  bare = false,
  children,
}: {
  round: ArbiterRound;
  roundExtend: ReactNode;
  owed: ReadonlySet<string>;
  /** Match Day's panel (Task 7): the focus frame already names the round, so the card carries no heading of its own. */
  bare?: boolean;
  children?: ReactNode;
}) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const { playing, total, finished, held, waiting } = playingTally(round.boards, owed);
  // MD-R31: Match Day's panel says "2 boards finished" and nothing above it when every board is over - "0 of 2 playing" over "2 finished" says the
  // same thing twice. The key is ALL OVER (every board on screen finished), not "nobody playing": a held or waiting-to-restart board keeps its line.
  const allOver = bare && total > 0 && finished === total;
  return (
    <section
      aria-labelledby={bare ? undefined : "arbiter-column-status-heading"}
      aria-label={bare ? msg("runsheet.round.heading", { round: round.roundNo }) : undefined}
      data-testid="arbiter-column-status"
      className={`flex min-w-0 flex-col gap-3 ${CARD_BOX}`}
    >
      {!bare && (
        <h2 id="arbiter-column-status-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
          {msg("runsheet.round.heading", { round: round.roundNo })}
        </h2>
      )}
      {total > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5">
          {!allOver && (
            <p data-testid="arbiter-column-playing" className={`m-0 text-[15px] ${CLOCK_FACE} ${INK}`}>
              {plural("arbiter.column.playing", total, { count: playing, total })}
            </p>
          )}
          {finished > 0 && (
            <p data-testid="arbiter-column-finished" className={`m-0 text-sm ${MUTED}`}>
              {plural("arbiter.column.finished", finished)}
            </p>
          )}
          {/* A held board is the queue's and is neither playing nor finished: without this line the counts above do not add up (D7). */}
          {held > 0 && (
            <p data-testid="arbiter-column-onhold" className={`m-0 text-sm ${MUTED}`}>
              {plural("arbiter.column.onHold", held)}
            </p>
          )}
          {/* A re-armed board (D17) has no result: the restart below is what it waits for. Without this line it would be counted as finished,
              and the next round's warning ("Round 1 still has a game in play") would contradict the card. */}
          {waiting > 0 && (
            <p data-testid="arbiter-column-reopen-waiting" className={`m-0 text-sm ${MUTED}`}>
              {plural("arbiter.column.waitingToRestart", waiting)}
            </p>
          )}
        </div>
      )}
      {roundExtend}
      {/* The round's own reinvite or reopen press, its answer and its confirmation (`roundPress`): nothing when the reader names none. */}
      {children}
    </section>
  );
}

/** The next round while a round is on screen (spec §5.5): the press is quiet until every board on screen is over, the earlier
 *  rounds still in play are named inline beside it, and the pairings list (the before phase's) is not drawn. */
export type PlayingEmphasis = { primary: boolean };

/** Match Day's round panel (Task 7) draws the open-round block with its own test ids, its earlier-round warnings inline and its press
 *  primary exactly when no earlier round is still in play. No heading: the focus frame names the round. */
export type PanelBlock = { ctaTestId: string; confirmTestId: string };

/** C25: pure (state in, markup out): one view's heading, lede, press, confirmation and notice, then its pairings. */
export function OpenRoundBlockView({
  view,
  state,
  tz,
  showStage,
  on,
  playing,
  mayPress,
  panel,
}: {
  view: OpenRoundView;
  state: OpenRoundUiState;
  tz: string;
  showStage: boolean;
  on: { ask(): void; cancel(): void; open(): void };
  /** Set in the playing phase (the next round beside a round on screen); absent in the before phase. */
  playing?: PlayingEmphasis;
  /** Whether the reader may START play from here (Match Day: `mayPress(reader, "start")`, the billing freeze and the club's flag). REQUIRED:
   *  a default of "may" would hand a press to any caller that forgot to say. No press and no confirmation without it; the pairings still list. */
  mayPress: boolean;
  /** Match Day's round panel. */
  panel?: PanelBlock;
}) {
  const msg = useMsg();
  const plural = useMsgPlural();
  // A named refusal, not an assumption: the round panel hands this only views whose press is "open", but a view the reader says
  // cannot be opened gets no press and no confirmation here.
  const canOpen = view.press === "open" && mayPress;
  const headingId = `arbiter-column-open-${view.stageId}-${view.roundNo}`;
  const captionId = `${headingId}-pairings`;
  const heading = showStage
    ? msg("arbiter.roundLine", { stage: view.stageName, round: view.roundNo })
    : msg("runsheet.round.heading", { round: view.roundNo });
  // The lede counts the FIXTURE: two seats for each board in the pairings, whoever has or has not been invited.
  const boards = view.pairings.length;
  const notice = state.notice ? openNoticeText(state.notice, view, msg, plural) : null;
  const owed = owedPlayers(view);

  return (
    <section
      aria-labelledby={panel ? undefined : headingId}
      aria-label={panel ? heading : undefined}
      data-testid="arbiter-column-open"
      data-stage-id={view.stageId}
      data-round-no={view.roundNo}
      className={`flex flex-col gap-3 ${CARD_BOX}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {!panel && (
          <h2 id={headingId} className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
            {heading}
          </h2>
        )}
        <p className={`m-0 text-[13px] leading-[1.45] ${MUTED}`}>{plural("runsheet.round.pairedLede", boards, { players: boards * 2 })}</p>
      </div>

      {/* Playing phase: every round still in play, one sentence each and NOT only in the confirmation, so the press is made
          knowingly. A warning, never a block (D8: the organiser drives). Amber is the spec's caution pair. */}
      {(playing || panel) && canOpen && view.earlierInPlay.length > 0 && (
        <div
          role="note"
          data-testid="arbiter-column-earlier"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-[#f5d27a] bg-[#fef3c7] px-3 py-2 text-[13px] leading-[1.45] text-[#713f12]"
        >
          {view.earlierInPlay.map((e) => (
            <span key={e.roundNo} data-earlier-round={e.roundNo} className="min-w-0 break-words">
              {plural("runsheet.round.confirmEarlierInPlay", e.games, { round: e.roundNo })}
            </span>
          ))}
        </div>
      )}

      {canOpen && (
        <button
          type="button"
          // The before phase's press and the playing phase's are the same press (same hook, same confirmation); the playing one
          // wears its own test id and says whether it is the primary action of the round panel right now.
          data-testid={panel ? panel.ctaTestId : playing ? "arbiter-column-next" : "arbiter-column-open-cta"}
          data-primary={panel ? String(view.earlierInPlay.length === 0) : playing ? String(playing.primary) : undefined}
          disabled={state.busy !== null}
          aria-busy={state.busy?.kind === "open" || undefined}
          onClick={on.ask}
          className={
            panel
              ? view.earlierInPlay.length === 0
                ? BUTTON_PRIMARY
                : `${BUTTON_QUIET} w-full sm:w-auto`
              : playing && !playing.primary
                ? `${BUTTON_QUIET} w-full sm:w-auto`
                : BUTTON_PRIMARY
          }
        >
          {msg("runsheet.round.openCta")}
        </button>
      )}

      {notice !== null && (
        <div role="status" data-testid="arbiter-column-open-notice" className={`min-w-0 space-y-0.5 text-sm ${SOFT}`}>
          {notice.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
        </div>
      )}

      {/* The before phase lists the pairings. Beside a round on screen the confirmation already names who is invited, so the list is
          left out (spec §5.5). */}
      {!playing && (
        <>
          <p id={captionId} className={`m-0 text-xs font-semibold ${MUTED}`}>
            {msg("runsheet.round.pairingsLabel", { round: view.roundNo })}
          </p>
          {/* A scrolling region a keyboard can reach (AGENTS class 23): focusable, a region, named. A long round scrolls here rather
              than pushing the rest of the page away. Its name is the caption above it, and with more than one stage the block's
              heading first: two stages can share a round number, and two landmarks must not share a name. */}
          <div
            role="region"
            tabIndex={0}
            aria-labelledby={showStage ? `${headingId} ${captionId}` : captionId}
            data-testid="arbiter-column-pairings"
            className="max-h-[40vh] min-w-0 overflow-y-auto rounded-lg border border-[#e7e3f3]"
          >
            <ul className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] p-0">
              {view.pairings.map((p) => (
                <li key={p.fixtureId} data-testid={`arbiter-column-pairing-${p.fixtureId}`} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className={`min-w-16 shrink-0 text-xs font-semibold ${MUTED}`}>{msg("arbiter.boardNo", { n: p.boardNo })}</span>
                  <span data-field="names" className="min-w-0 flex-1 basis-40 text-sm break-words">
                    <span className={`font-medium ${INK}`}>{p.whiteName}</span>
                    <span className={`mx-1.5 ${MUTED}`}>{msg("schedule.vs")}</span>
                    <span className={`font-medium ${INK}`}>{p.blackName}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <ConfirmDialog
        open={canOpen && state.confirming}
        testId={panel ? panel.confirmTestId : "arbiter-column-confirm"}
        title={msg("runsheet.round.confirmTitle", { round: view.roundNo })}
        confirmLabel={plural("runsheet.round.confirmCta", owed)}
        confirmVariant="primary"
        cancelLabel={msg("confirm.cancel")}
        stackActions
        busy={state.busy !== null}
        onConfirm={on.open}
        onCancel={on.cancel}
      >
        <OpenRoundConfirmBody round={view} tz={tz} />
      </ConfirmDialog>
    </section>
  );
}

// ---- the round on screen's own press ----------------------------------------------------------------------------------------------

/** The check-in hero's press (quiet). BUTTON_QUIET has min-h-11 and no vertical padding. This label is long ("Inviter de nouveau et relancer l'enregistrement"
 *  wraps to two lines from 320 to 375), and two lines of text would touch the border: py-2 keeps them clear of it, on this press only. */
const HERO_PRESS_CLASS = `${BUTTON_QUIET} w-full py-2 max-md:max-w-sm`;
/** The press where it is THE action of what is on screen (the playing status, and beside a link hold's reason). */
const PRIMARY_PRESS_CLASS = `${BUTTON_PRIMARY} py-2 text-balance`;

/** What `roundPress` builds: the press's button, its answer, its confirmation, and what the boards are owed. */
export type RoundPress = ReturnType<typeof roundPress>;

/** The round on screen's own reinvite or reopen press: its button, its answer and its confirmation, drawn by the check-in hero and,
 *  since the final review (I2), by the playing status. A plain function and not a component, so each caller's tree holds the button
 *  itself and a test (or a hook harness that renders one level) sees it where the caller put it. The caller owns the hooks.
 *
 *  `view.press` is the reader's prediction of the branch `openRound` takes (open-round-view.ts), so "reinvite" and "reopen" are the
 *  only presses of the round on screen that are offered here; "open" belongs to the next round's block and "none" to no one. The
 *  confirmation is the run sheet's (`OpenRoundConfirmBody`), titled and labelled for what the press does: the reinvite uses the run
 *  sheet's title and button; the reopen has its own, because its press says "Invite again and restart check-in" and an action keeps
 *  one name through the flow (the first-time open's "Open Round N?" would be a different action). The answer is drawn whenever one
 *  stands, even after the answer has flipped the press away. */
export function roundPress(a: {
  round: ArbiterRound;
  /** `viewOfRound(...)`: null when `listOpenRounds` has none for the round on screen. */
  view: OpenRoundView | null;
  tz: string;
  openRound: OpenRoundHandle;
  msg: Msg;
  plural: Plural;
  /** The button's class: the hero's quiet press and the playing status's primary one differ only in this. */
  buttonClass: string;
  /** Whether the reader may START play from here (Match Day's `mayPress(reader, "start")`). Without it there is no button and the
   *  confirmation cannot be open; the answer is still drawn, and `owedView` still says what the boards are owed. Required, never defaulted. */
  mayPress: boolean;
  /** Match Day (MD-R2/R22): a board of the round is held for a Lichess link, so the press is named for what it does here -
   *  "Open round N again" - and carries its own test id. */
  linkHeld?: boolean;
}): { owedView: OpenRoundView | null; button: ReactNode; notice: ReactNode; dialog: ReactNode } {
  const { round, view, tz, openRound, msg, plural } = a;
  const { state } = openRound;
  const owedView = view !== null && (view.press === "reinvite" || view.press === "reopen") ? view : null;
  const notice = view !== null && state.notice !== null ? openNoticeText(state.notice, view, msg, plural) : null;
  const owed = owedView === null ? 0 : owedPlayers(owedView);
  const reinvite = owedView?.press === "reinvite";
  // The confirmation words each seat as the waiting list does (D2): the round on screen's own boards are where the seats are read.
  const seatsOf: BoardSeats = new Map(round.boards.map((b) => [b.fixtureId, b.seats]));
  return {
    owedView,
    button:
      owedView === null || !a.mayPress ? null : (
        <button
          type="button"
          data-testid={a.linkHeld === true ? "md-round-reopen-cta" : "arbiter-column-reinvite"}
          disabled={state.busy !== null}
          aria-busy={state.busy?.kind === "open" || undefined}
          onClick={openRound.ask}
          className={a.buttonClass}
        >
          {a.linkHeld === true
            ? msg("matchDay.round.openAgain", { round: round.roundNo })
            : reinvite
              ? plural("runsheet.round.inviteCta", owed)
              : msg("arbiter.column.reopenCta")}
        </button>
      ),
    notice:
      notice === null ? null : (
        <div role="status" data-testid="arbiter-column-reinvite-notice" className={`min-w-0 space-y-0.5 text-sm ${SOFT}`}>
          {notice.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
        </div>
      ),
    dialog: (
      <ConfirmDialog
        open={owedView !== null && a.mayPress && state.confirming}
        testId="arbiter-column-reinvite-dialog"
        title={
          a.linkHeld === true
            ? msg("matchDay.round.openAgainTitle", { round: round.roundNo })
            : reinvite
              ? msg("runsheet.round.confirmTitleReinvite", { round: round.roundNo })
              : msg("arbiter.column.reopenConfirmTitle", { round: round.roundNo })
        }
        // M3: the press says "Open round N again", so its dialog asks "Open Round N again?" and its button says it again (an action keeps one name through
        // the flow); the body below still lists who is invited.
        confirmLabel={
          a.linkHeld === true
            ? msg("matchDay.round.openAgain", { round: round.roundNo })
            : reinvite
              ? plural("runsheet.round.inviteCta", owed)
              : plural("arbiter.column.reopenConfirmCta", owed)
        }
        confirmVariant="primary"
        cancelLabel={msg("confirm.cancel")}
        stackActions
        busy={state.busy !== null}
        onConfirm={openRound.open}
        onCancel={openRound.cancel}
      >
        {owedView !== null && <OpenRoundConfirmBody round={owedView} tz={tz} seats={seatsOf} />}
      </ConfirmDialog>
    ),
  };
}

// ---- check-in: the hero ---------------------------------------------------------------------------------------------------------

/** "07:42": whole minutes and seconds left to `atIso`, rounded UP, so a clock that is still counting never reads 00:00 (the board
 *  closes AT its deadline, and one millisecond short of it there is still a second on the face). Minutes are not capped. */
function countdownText(atIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(atIso) - nowMs) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
}

export type CheckinHeroProps = {
  round: ArbiterRound;
  /** `viewOfRound(...)`: null when `listOpenRounds` has none for the round on screen (no press, no groups). */
  view: OpenRoundView | null;
  tz: string;
  nowMs: number | null;
  /** C9: the round on screen's handle, shared with the waiting list. */
  openRound: OpenRoundHandle;
  /** C13: the panel's one RoundExtend, placed here in this phase. */
  roundExtend: ReactNode;
  /** Match Day (Task 7): whether the reader may START play from here (`roundPress`'s). Required, never defaulted. */
  mayPress: boolean;
  /** Match Day (MD-R2/R22): a board is held for a Lichess link, so the round's press is "Open round N again" (`roundPress`'s). */
  linkHeld?: boolean;
  /** Match Day: the focus frame already names the round, so the card carries no heading of its own. */
  bare?: boolean;
  /** Match Day (M3): the round's press, built by the caller so its button can stand beside the reason it exists (the link-hold block). Absent, the
   *  hero builds and draws its own. */
  press?: RoundPress;
  /** Whether the hero draws the press's button and answer (default true). The confirmation is always the hero's. */
  pressInHero?: boolean;
};

/** The check-in hero (spec §5.3): the countdown to the NEXT board closing, who has checked in, what is already playing, the round's
 *  +5 (the node the panel hands over), the round's own reinvite or reopen press, and the staggered groups. */
export function CheckinHero({ round, view, tz, nowMs, openRound, roundExtend, mayPress, linkHeld = false, bare = false, press: given, pressInHero = true }: CheckinHeroProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const venueAt = useVenueClock(tz);
  const clock = checkinClock(round.boards, nowMs);
  const tally = checkinTally(round.boards, nowMs);
  const batches = view === null ? null : timedBatches(view);
  // The round's own press: a seat whose invite was released (Not delivered, Bounced) is invited again from here (C4), and a round
  // nobody was reached by opens again. Any other press belongs to the Fixtures tab or to no one.
  const press =
    given ??
    roundPress({
      round,
      view,
      tz,
      openRound,
      msg,
      plural,
      buttonClass: HERO_PRESS_CLASS,
      mayPress,
      linkHeld,
    });

  const clockLabel =
    clock.kind === "closes" ? msg("arbiter.column.checkin.closesIn") : clock.kind === "opens" ? msg("arbiter.column.checkin.opensIn") : msg("arbiter.column.checkin.closed");

  return (
    <section
      aria-labelledby={bare ? undefined : "arbiter-checkin-heading"}
      aria-label={bare ? msg("runsheet.round.heading", { round: round.roundNo }) : undefined}
      data-testid="arbiter-checkin-hero"
      className={`flex flex-col gap-3 ${CARD_BOX}`}
    >
      {!bare && (
        <h2 id="arbiter-checkin-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
          {msg("runsheet.round.heading", { round: round.roundNo })}
        </h2>
      )}

      {/* The one large element of the hero. Three states of one clock, each with its own words; before mount (nowMs null) the
          label stands alone and the digits wait for the viewer's clock. A running face is a timer a screen reader is not made to
          read every second (role=timer is aria-live off). */}
      <div data-testid="arbiter-checkin-clock" data-kind={clock.kind} className="flex min-w-0 flex-col gap-1">
        <p id="arbiter-checkin-clock-label" className={clock.kind === "closed" ? `m-0 text-[15px] font-semibold ${INK}` : `m-0 text-[13px] ${MUTED}`}>
          {clockLabel}
        </p>
        {clock.kind !== "closed" && nowMs !== null && (
          <span role="timer" aria-labelledby="arbiter-checkin-clock-label" className={`${CLOCK_FACE} text-3xl leading-none lg:text-4xl ${INK}`}>
            {countdownText(clock.at, nowMs)}
          </span>
        )}
      </div>

      {/* The empty tally prints nothing: no board in an open window is not "0 of 0 players". */}
      {tally.seats > 0 && (
        <div data-testid="arbiter-checkin-tally" className="flex min-w-0 flex-col gap-1.5">
          <p id="arbiter-checkin-tally-text" className={`m-0 text-[15px] ${CLOCK_FACE} ${MUTED}`}>
            {plural("arbiter.column.checkin.tally", tally.seats, { count: tally.here, total: tally.seats })}
          </p>
          <div
            role="progressbar"
            aria-labelledby="arbiter-checkin-tally-text"
            aria-valuemin={0}
            aria-valuenow={tally.here}
            aria-valuemax={tally.seats}
            className="h-2 w-full overflow-hidden rounded-full bg-[#e7e3f3]"
          >
            <div className="h-full rounded-full bg-[#7c3aed]" style={{ width: `${Math.round((tally.here * 100) / tally.seats)}%` }} />
          </div>
        </div>
      )}

      {/* A zero clause is never printed (desk _RULES: an empty cell is not information). A held board is the queue's, not playing, and has
          its own line so the counts add up (D7). */}
      {(tally.playing > 0 || tally.finished > 0 || tally.held > 0) && (
        <div className="flex min-w-0 flex-col gap-0.5">
          {tally.playing > 0 && (
            <p data-testid="arbiter-checkin-playing" className={`m-0 text-sm ${SOFT}`}>
              {plural("arbiter.column.alreadyPlaying", tally.playing)}
            </p>
          )}
          {tally.finished > 0 && (
            <p data-testid="arbiter-checkin-finished" className={`m-0 text-sm ${MUTED}`}>
              {plural("arbiter.column.finished", tally.finished)}
            </p>
          )}
          {tally.held > 0 && (
            <p data-testid="arbiter-checkin-onhold" className={`m-0 text-sm ${MUTED}`}>
              {plural("arbiter.column.onHold", tally.held)}
            </p>
          )}
        </div>
      )}

      {/* The panel's one "+5 min to the round", exactly as it is handed over (its button, why line and answer). */}
      {roundExtend}

      {pressInHero && press.button}

      {/* The press's answer stays under it even after the answer flips the press away (a successful reinvite leaves nobody owed). */}
      {pressInHero && press.notice}

      {view !== null && batches !== null && (
        <div data-testid="arbiter-column-batches" className="flex min-w-0 flex-col gap-1">
          <p id="arbiter-column-batches-label" className={`m-0 text-xs font-semibold ${MUTED}`}>
            {msg("runsheet.round.batchesLabel", { round: view.roundNo })}
          </p>
          <ul aria-labelledby="arbiter-column-batches-label" className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] rounded-lg border border-[#e7e3f3] bg-[#faf9ff] px-3 py-0">
            {batches.map((b, i) => (
              <li
                key={i}
                data-testid={`arbiter-column-batch-${i}`}
                data-opens-at={b.opensAt}
                data-closes-at={b.closesAt}
                className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
              >
                <span data-field="boards" className={`min-w-0 text-sm font-semibold ${INK}`}>
                  {b.fromBoard === b.toBoard ? msg("arbiter.boardNo", { n: b.fromBoard }) : msg("arbiter.column.batchBoards", { from: b.fromBoard, to: b.toBoard })}
                </span>
                <span data-field="opens" className={`text-xs ${MUTED}`}>
                  {msg("runsheet.round.batchOpens", { time: venueAt(b.opensAt) })}
                </span>
                <span data-field="closes" className={`text-xs ${MUTED}`}>
                  {msg("runsheet.round.batchCloses", { time: venueAt(b.closesAt) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The press's confirmation, closed unless the reader offers the press (`roundPress`). */}
      {press.dialog}
    </section>
  );
}

// ---- check-in: the waiting list -------------------------------------------------------------------------------------------------

/** C9: the waiting list, in the round panel's check-in phase. Shares the round panel's open-round handle. */
export type WaitingListProps = {
  /** `round.boards`; the list filters with `openWindowBoards`, the SAME set the hero's tally counts. */
  boards: readonly ArbiterBoard[];
  /** `viewOfRound(...)`; null => no Resend on any row (the guard). */
  view: OpenRoundView | null;
  openRound: OpenRoundHandle;
  nowMs: number | null;
  /** A decision or round-wide "+5 min" request is in flight on the panel: every row's +5 waits, as the panel's own +5 does. A row's
   *  press moves the pane to its board, and the panel's reducer refuses a second request - a press that moved the pane and then was
   *  refused would strand the first request's answer on a deselected board. (Resend has its own gate: the handle's.) */
  requestBusy: boolean;
  on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
  /** Match Day (Task 7): whether the reader may START play from here - Resend and a board's "+5 min" are START writes. The seats and
   *  their invite words list either way. Required, never defaulted. */
  mayPress: boolean;
  /** Match Day: where the section sits. The default classes (`COLUMN_WAITING_PLACEMENT`) are `order-*` for a parent that is a flex track
   *  of ordered groups; Match Day's round panel is a plain column and passes "" so the list stays in source order. */
  placement?: string;
  /** Match Day: the answer to the last "+5 min", under the board it was pressed for (the board panel says it in its own decision area). */
  extendNotice?: { fixtureId: string; text: string } | null;
};

/** Spec §4: violet for what is on its way or has arrived, amber for late, red for what failed, an outline for no mail at all. A
 *  Record over the declared words, so a seventh word cannot be added without choosing its colour. */
const VIOLET_CHIP = "border-[#c9bdf0] bg-[#f3effc] text-[#5b21b6]";
const AMBER_CHIP = "border-[#f5d27a] bg-[#fef3c7] text-[#713f12]";
const RED_CHIP = "border-[#f1c4c0] bg-[#fef2f2] text-[#b42318]";
const CHIP_PAIR: Record<SeatInviteWord, string> = {
  sent: VIOLET_CHIP,
  delivered: VIOLET_CHIP,
  delayed: AMBER_CHIP,
  bounced: RED_CHIP,
  not_delivered: RED_CHIP,
  not_invited: "border-[#c9bdf0] bg-white text-[#4a3a6b]",
};
const CHIP = "inline-flex items-center rounded-full border px-2.5 py-[3px] text-xs font-semibold";

const COLUMN_WAITING_PLACEMENT = "max-md:order-[-1] md:max-lg:order-8 lg:order-3";

/** The seats that are not here yet (spec §5.3): the `checking_in` boards whose window is open now, with at least one seat not here,
 *  in board order - the same boards the tally counts, so its denominator and this list never disagree. A board whose `seats` is null
 *  is listed with both seats "Not here yet" and no chip (the tally counts it as two seats, none here). Empty: no list at all, and
 *  no help line (with no row there is nothing to explain). */
export function WaitingList({ boards, view, openRound, nowMs, requestBusy, on, mayPress, placement = COLUMN_WAITING_PLACEMENT, extendNotice = null }: WaitingListProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const { state } = openRound;
  const rows = openWindowBoards(boards, nowMs).filter((b) => !(b.seats !== null && b.seats.white.here && b.seats.black.here));
  if (rows.length === 0) return null;
  // The extend label reads the step and the presses left from the dictionary: it needs the plain lookup and nothing else.
  const copy = { t: (key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars) };

  return (
    // The panel's board group is `contents` below md, so on a phone this is a flex item of the page: -1 puts it straight after the column
    // (the aside is -2). From md to lg the panel's two groups are ONE flex column (the track) whose children carry order-1..7 (heading,
    // camera, other reports 4, then the flags, the decision and the outage card at 5..7): `md:max-lg:order-8` is last, so the decision is
    // above the list (Task 16 D4). From lg the board group is its own flex column again, children order-1..4 (heading, camera, other
    // reports): `lg:order-3` is "under the camera" and above the other reports. A bare order of 0 would tie with the picker and the
    // watch-only line and sort by DOM order, landing above the heading (order-1) and the camera (order-2) - not under the camera.
    <section aria-labelledby="arbiter-waiting-heading" data-testid="arbiter-waiting" className={`flex flex-col gap-2 ${placement} ${CARD_BOX}`}>
      <h2 id="arbiter-waiting-heading" data-testid="arbiter-waiting-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
        {plural("arbiter.column.waiting", rows.length)}
      </h2>
      <ul className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] p-0">
        {rows.map((b) => {
          // C14: the row's +5 is the live clock's reading of THIS board's window, never the snapshot's `canExtend`.
          const offer = boardExtendOffer(b.checkin, nowMs);
          const canExtend = mayPress && offer !== null && offer.offered;
          // Resend is the round's view's word for this pairing; no view, or no pairing for this board, means no Resend.
          const canResend = mayPress && view?.pairings.find((x) => x.fixtureId === b.fixtureId)?.canResend === true;
          const rowNotice = state.rowNotice?.fixtureId === b.fixtureId ? state.rowNotice.notice : null;
          return (
            <li key={b.fixtureId} data-testid="arbiter-waiting-row" data-fixture-id={b.fixtureId} className="flex min-w-0 flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
              <button
                type="button"
                data-testid="arbiter-waiting-board"
                onClick={() => on.select(b.fixtureId)}
                className={`inline-flex min-h-11 w-fit max-w-full cursor-pointer items-center rounded-lg px-1 text-sm font-semibold text-[#5b21b6] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]`}
              >
                {msg("arbiter.boardNo", { n: b.boardNo })}
              </button>
              <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
                {(["white", "black"] as const).map((colour) => {
                  // The words a seat shows come from `seatWords`, the helper the reopen/reinvite confirmation reads as well (D2).
                  const words = seatWords(b.seats?.[colour] ?? null);
                  const here = words.includes("here");
                  const invites = words.filter((w): w is SeatInviteWord => w !== "here");
                  return (
                    // D3: two lines at every width. The colour and the name, then the words (presence and invite chips) on a row of their
                    // own under the name, so the rows of the list line up whether or not a chip would have fitted beside it.
                    <li key={colour} data-testid="arbiter-seat" data-colour={colour} data-here={String(here)} className="flex min-w-0 flex-col gap-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className={`w-14 shrink-0 text-xs ${MUTED}`}>{msg(colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black")}</span>
                        <span data-field="name" className={`min-w-0 flex-1 text-sm font-medium break-words ${INK}`}>
                          {b[colour].name}
                        </span>
                      </div>
                      {/* pl-16 = the colour column (w-14) and the gap (gap-2), so the words start under the name. */}
                      <div data-testid="arbiter-seat-words" className="flex min-w-0 flex-wrap items-center gap-1.5 pl-16">
                        {here ? (
                          <span data-field="presence" className={`inline-flex items-center gap-1.5 text-xs font-semibold ${SOFT}`}>
                            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[#4ade80]" />
                            {msg("arbiter.column.here")}
                          </span>
                        ) : (
                          <>
                            <span data-field="presence" className={`${CHIP} ${AMBER_CHIP}`}>
                              {msg("arbiter.column.notHereYet")}
                            </span>
                            {/* One chip per invite word. A seat that is here shows none; one the loader could not read has none to show. */}
                            {invites.map((word, i) => (
                              <span key={`${word}:${i}`} data-testid="arbiter-invite-word" data-word={word} className={`${CHIP} ${CHIP_PAIR[word]}`}>
                                {msg(INVITE_WORD_KEYS[word] as MessageKey)}
                              </span>
                            ))}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {(canResend || canExtend) && (
                <div className="flex min-w-0 flex-wrap gap-2">
                  {canResend && (
                    <button
                      type="button"
                      data-testid="arbiter-waiting-resend"
                      data-fixture-id={b.fixtureId}
                      disabled={state.busy !== null}
                      aria-busy={(state.busy?.kind === "resend" && state.busy.fixtureId === b.fixtureId) || undefined}
                      onClick={() => openRound.resend(b.fixtureId)}
                      className={`${BUTTON_QUIET} w-full sm:w-auto`}
                    >
                      {msg("runsheet.round.resend")}
                    </button>
                  )}
                  {canExtend && (
                    <button
                      type="button"
                      data-testid="arbiter-waiting-extend"
                      data-fixture-id={b.fixtureId}
                      disabled={requestBusy}
                      onClick={() => on.extendBoard(b.fixtureId)}
                      className={`${BUTTON_QUIET} w-full sm:w-auto`}
                    >
                      {extendBoardLabel(b.checkin.extensionsLeft, copy)}
                    </button>
                  )}
                </div>
              )}
              {rowNotice !== null && (
                <p role="status" data-testid="arbiter-waiting-notice" className={`m-0 text-xs ${SOFT}`}>
                  {resendNoticeText(rowNotice, msg, plural)}
                </p>
              )}
              {extendNotice !== null && extendNotice.fixtureId === b.fixtureId && (
                <p role="status" data-testid="arbiter-waiting-extend-notice" className={`m-0 text-xs ${SOFT}`}>
                  {extendNotice.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {/* The list's last line. Delivered is the mail server's word, not the player's. */}
      <p data-testid="arbiter-invite-help" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
        {msg("arbiter.invite.help")}
      </p>
    </section>
  );
}

// ---- Match Day's round panel ------------------------------------------------------------------------------------------------------

export type RoundFocusProps = {
  ctx: MatchDayCtx;
  /** The row on screen. Every press below is THIS row's round (its own `view`), never another round's. */
  round: MatchDayOnlineRound;
  /** The shell's next round for this row: the row of the SAME stage whose round number is this one's + 1, paired and not opened
   *  (`nextRoundOf`), or null. */
  next: MatchDayOnlineRound | null;
  /** `mayPress`'s input (the shell builds it from the viewer's role, the club's flag and the billing freeze). */
  reader: Reader;
  nowMs: number | null;
  backLabel: string;
  onBack(): void;
  /** The shell's quiet day read: a press's effect shows without waiting for the poll. It MUST keep its identity across renders (the
   *  shell passes a `useCallback`): the open's and the "+5 min" runners are built over it and hold the in-flight flag that keeps a
   *  double tap off the network, so a new function each render would rebuild them. */
  onChanged(): void;
  /** MD-R30: a press was answered 402 - the competition is billing-frozen NOW. The page's `frozen` was read at load and cannot say so, so the shell keeps
   *  this and folds it into the reader before `mayPress`. Called when an answer on screen says so (an effect over that fact, so a poll's new row object
   *  never calls it twice); it MUST keep its identity across renders. */
  onFrozen(): void;
  onOpenBoard(fixtureId: string): void;
  onOpenRound(key: string): void;
  hiddenOnPhone?: boolean;
};

/** One POST on the v1 envelope, shared by the panel's two `+5 min` runners. (The open's and the resend's are `useOpenRoundWith`'s; Pair
 *  next's path is `pairNextPath`: the stage's own generate route.) */
const post = (path: string, body?: unknown) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) });

/** What `checkin-extend-ui.ts` reads its words from: the panel's plain lookup, its plural lookup and the venue's clock. */
function extendCopyOf(msg: Msg, plural: Plural, hm: (iso: string) => string | null): ExtendCopy {
  return { t: (key, vars) => msg(key as MessageKey, vars), plural, hm };
}

export function RoundFocus(p: RoundFocusProps) {
  const { ctx, round, next, reader } = p;
  // The check-in clock's digits and the "+5 min" press arriving and leaving AT a window's edge need a finer clock than the shell's minute: the
  // panel's own, as the board panel runs it, while a check-in window is still to be watched. Without it the countdown froze at the instant of the
  // last poll and the round's press waited for the next one.
  const edges = extendEdgesOf(watchedWindows((round.round?.boards ?? []).map((b) => b.checkin)));
  const ticking = useExtendClock(edges.length > 0, edges, true);
  const nowMs = ticking ?? p.nowMs;
  const msg = useMsg();
  const plural = useMsgPlural();
  const venueAt = useVenueClock(round.tz);
  // The runners below live as long as the panel (their in-flight flag is what keeps a double tap off the network), so `onChanged` must keep
  // its identity across renders (the shell's `useCallback` over its stable day read): a poll must never rebuild them.
  const refresh = p.onChanged;

  const canPress = mayPress(reader, "start");
  const phase = onlineRoundPhase(round, nowMs);
  const lines = roundWordLines(ctx.dict, ctx.locale, round.tz, roundRowWord(round, nowMs));
  const view = round.view;
  const rr = round.round;

  const openRound = useOpenRoundWith(view, refresh);
  const [roundExt, dispatchRound] = useReducer(roundExtendUi, undefined, initialRoundExtend);
  const [boardExt, dispatchBoard] = useReducer(boardExtendUi, undefined, initialBoardExtend);
  const [pair, dispatchPair] = useReducer(pairNextUi, undefined, initialPairNext);
  // The two "+5 min" presses share the panel and answer in two places: starting either clears the other's answer (its counts or time are
  // about deadlines the press has just moved).
  const roundRunner = useMemo(
    () =>
      roundExtendRunner({
        dispatch: (a) => {
          if (a.type === "extend") dispatchBoard({ type: "clear" });
          dispatchRound(a);
        },
        post,
        refresh,
      }),
    [refresh],
  );
  const boardRunner = useMemo(
    () =>
      boardExtendRunner({
        dispatch: (a) => {
          if (a.type === "extend") dispatchRound({ type: "clear" });
          dispatchBoard(a);
        },
        post,
        refresh,
      }),
    [refresh],
  );
  const pairRunner = useMemo(() => pairNextRunner({ dispatch: dispatchPair, post, refresh }), [refresh]);

  // MD-R30: the freeze's own answer, from any of the four presses the server guards (open, resend, a board's +5, the round's +5). Pair next is NOT one of
  // them: the stage's generate route has no freeze guard, so its 402 is a plan limit (MD-R32), and the shell is not told the competition froze.
  const frozenAnswered = [openRound.state.notice, openRound.state.rowNotice?.notice ?? null, roundExt.notice, boardExt.notice].some(
    (n) => n !== null && n.kind === "failed" && n.code === BILLING_FROZEN_CODE,
  );
  const onFrozen = p.onFrozen;
  useEffect(() => {
    if (frozenAnswered) onFrozen();
  }, [frozenAnswered, onFrozen]);

  const copy = extendCopyOf(msg, plural, venueAt);
  const holds = linkHolds(round, nowMs);
  const pairTarget = pairNextRound(round);
  const requestBusy = roundExt.busy || boardExt.busy !== null;

  const roundExtend =
    rr === null ? null : (
      <RoundExtendBar
        round={rr}
        state={roundExt}
        requestBusy={boardExt.busy !== null}
        nowMs={nowMs}
        canPress={canPress}
        onExtend={() => void roundRunner.extend(rr.stageId, rr.roundNo)}
        f={copy}
      />
    );
  const extendBoard = (fixtureId: string) => {
    const target = rr?.boards.find((b) => b.fixtureId === fixtureId);
    // An id not in this round, or any request in flight, does nothing at all.
    if (target === undefined || requestBusy) return;
    void boardRunner.extend(fixtureId, target.boardNo);
  };
  const extendNotice = boardExtendNotice(boardExt, rr, copy);

  // M5: right after Pair next round answers "Round N is paired", the next round IS ready: one card says it and offers the go-to press, not two cards
  // saying the same thing. Reloaded (no answer standing), the ready line is the card.
  const pairedReady = pair.notice !== null && pair.notice.kind === "paired" && next !== null && pair.notice.round === next.round_no;
  const readyLine = next === null || pairedReady ? null : <ReadyLine next={next} canPress={canPress} onOpenRound={p.onOpenRound} />;
  const pairBlock = (
    <PairNextBlock
      target={pairTarget}
      stageId={round.stage_id}
      canPress={canPress}
      state={pair}
      onPair={(to) => void pairRunner.pair(round.stage_id, to)}
      go={pairedReady && canPress ? { next, onOpenRound: p.onOpenRound } : null}
    />
  );
  // The round's own reinvite / reopen press, built once for the check-in and the playing phase. Beside a link hold's reason it is THE action (primary,
  // drawn in the block under the reasons - M3); otherwise the hero's quiet press or the status's primary one.
  const holdsPress = holds.length > 0;
  const own =
    rr !== null && (phase === "checkin" || phase === "playing")
      ? roundPress({
          round: rr,
          view,
          tz: round.tz,
          openRound,
          msg,
          plural,
          buttonClass: holdsPress || phase === "playing" ? PRIMARY_PRESS_CLASS : HERO_PRESS_CLASS,
          mayPress: canPress,
          linkHeld: holdsPress,
        })
      : null;

  let body: ReactNode = null;
  if (phase === "not_started") {
    body = (
      <p data-testid="md-round-start-first" className={`m-0 text-sm leading-[1.5] ${SOFT} ${CARD_BOX}`}>
        {msg("externalPlay.openRound.startFirst")}
      </p>
    );
  } else if (phase === "before") {
    // A named refusal, not an assumption: a row paired and not opened always carries its view (`readOnlineRounds` builds it from one), but
    // the type allows none, and a block with an Open round press over no pairings is worse than the line that says nothing is paired.
    body =
      view === null || view.pairings.length === 0 ? (
        <p data-testid="md-round-nothing" className={`m-0 text-sm leading-[1.5] ${SOFT} ${CARD_BOX}`}>
          {msg("arbiter.column.nothingPaired")}
        </p>
      ) : (
        <OpenRoundBlockView
          view={view}
          state={openRound.state}
          tz={round.tz}
          showStage={round.multi_stage}
          on={{ ask: openRound.ask, cancel: openRound.cancel, open: openRound.open }}
          mayPress={canPress}
          panel={{ ctaTestId: "md-round-open-cta", confirmTestId: "md-round-confirm" }}
        />
      );
  } else if (rr !== null && own !== null && phase === "checkin") {
    body = (
      <>
        <CheckinHero
          round={rr}
          view={view}
          tz={round.tz}
          nowMs={nowMs}
          openRound={openRound}
          roundExtend={roundExtend}
          mayPress={canPress}
          linkHeld={holdsPress}
          press={own}
          pressInHero={!holdsPress}
          bare
        />
        <WaitingList
          boards={rr.boards}
          view={view}
          openRound={openRound}
          nowMs={nowMs}
          requestBusy={requestBusy}
          on={{ select: p.onOpenBoard, extendBoard }}
          mayPress={canPress}
          placement=""
          extendNotice={extendNotice}
        />
        <LinkHoldsBlock holds={holds} onOpenBoard={p.onOpenBoard} press={own} />
        {readyLine}
        {pairBlock}
      </>
    );
  } else if (rr !== null && own !== null) {
    // Playing: no board is checking in. The round's own press, when the reader names one (a re-armed board after the D17 void, or a board
    // held for a link whose window still runs), is drawn inside the status - or, with a link hold, in the hold's block.
    body = (
      <>
        <PlayingStatus round={rr} roundExtend={roundExtend} owed={boardsOwedAnInvite(own.owedView)} bare>
          {!holdsPress && own.button}
          {!holdsPress && own.notice}
          {own.dialog}
        </PlayingStatus>
        <LinkHoldsBlock holds={holds} onOpenBoard={p.onOpenBoard} press={own} />
        {readyLine}
        {pairBlock}
      </>
    );
  }

  return (
    <OnlineFocusFrame
      testAttrs={{ "data-online": "round", "data-key": round.key, "data-state": phase }}
      title={onlineRoundTitle(ctx.dict, round)}
      backLabel={p.backLabel}
      onBack={p.onBack}
      hiddenOnPhone={p.hiddenOnPhone ?? false}
      subtitle={onlineRoundMeta(ctx.dict, ctx.locale, round)}
    >
      {lines !== null && (
        <p data-testid="md-online-state" className={`min-w-0 text-sm font-semibold [overflow-wrap:anywhere] ${WORD_TONE[lines.tone]}`}>
          {lines.main}
          {lines.sub !== null && <span className="ml-2 font-medium text-slate-600">{lines.sub}</span>}
        </p>
      )}
      {body}
    </OnlineFocusFrame>
  );
}

/** The answer to a board's "+5 min", as the waiting list prints it under that board: the sentence the board panel's decision area says
 *  ("Added 5 minutes to board 3. Check-in now closes 19:14.") or the door's refusal, in the venue's clock. */
function boardExtendNotice(state: BoardExtendState, round: ArbiterRound | null, f: ExtendCopy): { fixtureId: string; text: string } | null {
  const n = state.notice;
  if (n === null) return null;
  if (n.kind === "failed") return { fixtureId: n.fixtureId, text: extendFailureText(n.code, f) };
  const live = round?.boards.find((b) => b.fixtureId === n.fixtureId)?.checkin?.deadlineAt ?? null;
  return { fixtureId: n.fixtureId, text: extendBoardSentence(n.result, n.boardNo, f, live) };
}

/** Spec §3.2.2: "+5 min to the round" - one press gives every board of the round whose check-in is open five more minutes, and the answer
 *  says how many and why the rest were left alone. Offered while at least one board would accept it (the server's own reading of each board,
 *  re-asked of the TICKING clock) and, once pressed, for as long as its answer is on screen. The press is `canPress`'s; the reason and the
 *  answer say what they say to a reader who may not press. (The test ids are the retired Arbiter page's bar's, unchanged.) */
function RoundExtendBar({
  round,
  state,
  requestBusy,
  nowMs,
  canPress,
  onExtend,
  f,
}: {
  round: ArbiterRound;
  state: RoundExtendState;
  requestBusy: boolean;
  nowMs: number | null;
  canPress: boolean;
  onExtend: () => void;
  f: ExtendCopy;
}) {
  const lines =
    state.notice === null ? [] : state.notice.kind === "answered" ? extendRoundLines(state.notice.result, f) : [extendFailureText(state.notice.code, f)];
  const reach = liveExtendableBoards(round.boards, nowMs, round.extendableBoards);
  const offered = canPress && (reach > 0 || state.busy);
  // M5: no line says why a press is NOT there ("Can't extend check-in: it has closed" printed itself under a clock that already reads closed, to a
  // reader who pressed nothing). The bar is its press and the answer to it; a bar with neither draws nothing.
  if (!offered && lines.length === 0) return null;
  return (
    <div data-testid="arbiter-extend-round" className="flex w-full min-w-0 flex-col items-start gap-1.5">
      {offered && (
        <>
          <button
            type="button"
            data-testid="arbiter-extend-round-cta"
            onClick={onExtend}
            disabled={state.busy || requestBusy}
            aria-busy={state.busy || undefined}
            className={`${BUTTON_QUIET} w-full max-md:max-w-sm`}
          >
            {state.busy ? f.t("externalPlay.checkinExtend.busy") : extendRoundLabel(f)}
          </button>
          <p data-testid="arbiter-extend-round-helper" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendHelperLine(f)}
            {reach > 0 && <> {f.plural("externalPlay.checkinExtend.roundHint", reach)}</>}
          </p>
        </>
      )}
      <div role="status" data-testid="arbiter-extend-round-notice" className={`flex min-w-0 flex-col gap-0.5 text-[13px] leading-[1.45] ${SOFT}`}>
        {lines.map((line, i) => (
          <p key={i} className="m-0">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** "Round N+1 is ready to open": the shell's `next` row, already paired. The line is always said; its press only goes to that row (whose own
 *  panel carries the open) and is the press's reader's - nothing here opens anything. */
function ReadyLine({ next, canPress, onOpenRound }: { next: MatchDayOnlineRound; canPress: boolean; onOpenRound(key: string): void }) {
  const msg = useMsg();
  return (
    <div data-testid="md-round-ready" data-key={next.key} className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${CARD_BOX}`}>
      <p className={`m-0 min-w-0 flex-1 basis-48 text-[15px] font-semibold [overflow-wrap:anywhere] ${INK}`}>{msg("matchDay.round.ready", { round: next.round_no })}</p>
      {canPress && (
        <button type="button" data-testid="md-round-ready-go" onClick={() => onOpenRound(next.key)} className={`${BUTTON_QUIET} w-full sm:w-auto`}>
          {msg("matchDay.round.readyGo", { round: next.round_no })}
        </button>
      )}
    </div>
  );
}

/** MD-R15: "Pair next round", on a round whose every board is over, in a Swiss stage whose next round waits to be paired. The press is the stage
 *  rail's own (`POST /stages/{id}/generate`); the answer stays under it even after the press has gone (the round it paired is the stage's
 *  next, so a refreshed row no longer offers it). A refusal says what the server said, in the reader's language. */
function PairNextBlock({
  target,
  stageId,
  canPress,
  state,
  onPair,
  go,
}: {
  target: number | null;
  stageId: string;
  canPress: boolean;
  state: PairNextState;
  onPair(round: number): void;
  /** Once "paired" is the answer on screen and that round is the shell's next one, the go-to press stands in this card (M5: one card, not a second
   *  "ready to open" card saying the same thing). */
  go: { next: MatchDayOnlineRound; onOpenRound(key: string): void } | null;
}) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const offered = canPress && target !== null;
  if (!offered && state.notice === null) return null;
  const n = state.notice;
  const text =
    n === null
      ? null
      : n.kind === "paired"
        ? [msg("matchDay.round.pairedNotice", { round: n.round }), ...(n.caution === null ? [] : [nextRoundText(n.caution, msg)])]
        : [
            // MD-R32: the generate route has no freeze guard, so its 402 is a plan limit (a format or a stage the plan does not include), never the
            // "over its plan's limit on active competitions" sentence the four guarded presses use.
            n.code === BILLING_FROZEN_CODE
              ? msg("matchDay.round.pairPlanLimit")
              : isSwissRefusalCode(n.code)
                ? swissRefusalText(n.code, n.extra, msg, plural)
                : msg("matchDay.round.pairFailed"),
          ];
  return (
    <section aria-label={msg("schedule.pairNext")} data-testid="md-round-pair" data-stage-id={stageId} className={`flex min-w-0 flex-col gap-2 ${CARD_BOX}`}>
      {offered && (
        <>
          <p className={`m-0 text-sm leading-[1.5] ${SOFT}`}>{msg("matchDay.round.pairHint", { round: target })}</p>
          <button
            type="button"
            data-testid="md-round-pair-next"
            data-primary="true"
            disabled={state.busy}
            aria-busy={state.busy || undefined}
            onClick={() => onPair(target)}
            className={BUTTON_PRIMARY}
          >
            {msg("schedule.pairNext")}
          </button>
        </>
      )}
      {text !== null && (
        <div role="status" data-testid="md-round-pair-notice" className={`min-w-0 space-y-0.5 text-sm ${SOFT}`}>
          {text.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
        </div>
      )}
      {go !== null && (
        <button type="button" data-testid="md-round-ready-go" onClick={() => go.onOpenRound(go.next.key)} className={`${BUTTON_QUIET} w-full sm:w-auto`}>
          {msg("matchDay.round.readyGo", { round: go.next.round_no })}
        </button>
      )}
    </section>
  );
}

/** MD-R2/R22: the boards of the round on screen held for a Lichess link - each with why, in the words the open's own answer uses - and the
 *  window's word when it has closed (an open can no longer invite that board: said, never a press that loops silently). The press itself
 *  is the round's own ("Open round N again"), drawn under the reasons in this block (M3): one action, one name. */
function LinkHoldsBlock({ holds, onOpenBoard, press }: { holds: readonly LinkHold[]; onOpenBoard(fixtureId: string): void; press: RoundPress }) {
  const msg = useMsg();
  if (holds.length === 0) return null;
  // M1: "the time to take a seat has passed" is only said where there is NO press under it. While "Open round N again" is offered, that press starts the
  // window again, so the sentence beside it would contradict the page; to a reader who may not press (a frozen competition, a viewer) there is no press
  // and the sentence is what explains why the board waits.
  const sayClosed = press.button === null;
  return (
    <section aria-labelledby="md-round-linkhold-heading" data-testid="md-round-linkhold" className={`flex min-w-0 flex-col gap-2 ${CARD_BOX}`}>
      <h3 id="md-round-linkhold-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
        {msg("matchDay.round.linkHold.title")}
      </h3>
      <ul className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] p-0">
        {holds.map(({ board, reason, windowClosed }) => (
          <li
            key={board.fixtureId}
            data-testid="md-round-linkhold-board"
            data-fixture-id={board.fixtureId}
            data-reason={reason}
            data-window-closed={String(windowClosed)}
            className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0"
          >
            <button
              type="button"
              data-testid="md-round-linkhold-board-open"
              onClick={() => onOpenBoard(board.fixtureId)}
              className="inline-flex min-h-11 w-fit max-w-full cursor-pointer items-center rounded-lg px-1 text-sm font-semibold text-[#5b21b6] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]"
            >
              {msg("arbiter.boardNo", { n: board.boardNo })}
            </button>
            <p className={`m-0 min-w-0 text-sm break-words ${INK}`}>
              <span className="font-medium">{board.white.name}</span>
              <span className={`mx-1.5 ${MUTED}`}>{msg("schedule.vs")}</span>
              <span className="font-medium">{board.black.name}</span>
            </p>
            <p data-testid="md-round-linkhold-reason" className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
              {msg(OPEN_ROUND_SKIP_KEYS[reason] as MessageKey)}
            </p>
            {windowClosed && sayClosed && (
              <p data-testid="md-round-linkhold-closed" className="m-0 text-[13px] font-semibold leading-[1.45] text-[#713f12]">
                {msg(OPEN_ROUND_SKIP_KEYS.window_closed as MessageKey)}
              </p>
            )}
          </li>
        ))}
      </ul>
      {/* M3: the round's own press stands under the reasons it answers, with its answer ("Open round N again"); the confirmation is the hero's or the
          status's. Nothing here when the reader names no press (a viewer, a frozen competition, a round with nothing owed). */}
      {press.button}
      {press.notice}
    </section>
  );
}
