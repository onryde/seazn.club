"use client";
// A board's decisions and the video-outage card (spec 2026-11-05 §6.1 "Decide"): MOVED here from the retired Arbiter page (its
// `Decision` and the inline outage section, deleted with the page in Task 10), test ids and copy unchanged. Match Day's board panel
// draws the one set of buttons. What Match Day adds is WHO may press (`may`, from `mayPress`, lib/match-day/online.ts):
//   - `finish`: resync, let the game go on, settle - the decisions that FINISH play write or unblock a RESULT, the scoring the billing
//     freeze exempts (owner O4), so they are every editor's, flag or freeze or neither;
//   - `start`: "+5 min" on the board's check-in - a START press, refused 402 by the server on a frozen competition and not offered there.
// A reader with neither (a view-only member) gets no section at all; one with only `finish` gets everything but the "+5 min".
// Every button is still offered only on what the SERVER's own reading of the board says it would accept (`canResync`, the flags on
// screen, `offersSettle`, `checkin`) - nothing here decides that again.
import { useId, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { boardIsOver, offersSettle, type ArbiterBoard } from "@/lib/arbiter-view";
import type { ArbiterDecisionState, SettleChoice } from "../arbiter-decision";
import {
  BUTTON_QUIET,
  MUTED,
  noticeLapsed,
  noticeSentence,
  settleChoices,
  settleGuidance,
  SETTLE_GUIDANCE_KEY,
  SOFT,
  type Fmt,
} from "../arbiter-flag-cards";
import { boardExtendOffer, extendBoardLabel, extendClosesLine, extendHelperLine } from "../checkin-extend-ui";

/** What the section calls: the decisions' handlers (Match Day's board panel binds them to its own runner). */
export type DecisionOn = {
  extend(): void;
  resync(): void;
  /** "Let the game go on" for the flags on screen, by id (ruling A). */
  goOn(flagIds: readonly string[]): void;
  toggleSettle(): void;
  settle(choice: SettleChoice): void;
};

/** Who may press what (`mayPress`'s two kinds that this section draws). */
export type DecisionMay = { start: boolean; finish: boolean };

export function BoardDecision({
  board,
  decision,
  roundBusy,
  nowMs,
  settleHref,
  may,
  on,
  f,
  headingId,
  className,
}: {
  board: ArbiterBoard;
  decision: ArbiterDecisionState;
  /** The round-wide "+5 min" is in flight: one request at a time across the panel. */
  roundBusy: boolean;
  /** The viewer's ticking clock (null before it is known): the "+5 min" is offered inside the check-in window and nowhere else. */
  nowMs: number | null;
  /** The board's match page, where a board with no game on file is settled; null when it has none. */
  settleHref: string | null;
  may: DecisionMay;
  on: DecisionOn;
  f: Fmt;
  headingId: string;
  /** The section's own placement classes (Match Day's board panel sets its own `order-*`). */
  className: string;
}) {
  const settlePanel = useId();
  const over = boardIsOver(board.state);
  const canResync = may.finish && board.canResync;
  // R4 (T16 fix round 1): an open flag is closable whether or not the game is over — job 5 raises camera flags AFTER
  // the game, so a finished board is the usual home of one. Over, the words are the queue's: the game cannot go on.
  const canGoOn = may.finish && board.flags.length > 0;
  // Settled here when an online game is on file (a bridge row); a board
  // nobody reached has none, and keeps T15's way to its match page.
  const canSettle = may.finish && offersSettle(board);
  // The reducer owns "a notice belongs to the board on screen" (R4: a switch
  // clears it, an answer for the board left behind shows nothing).
  // An "extended" answer that names a closing time the ticking clock has reached stops showing (`noticeLapsed`).
  const notice = decision.notice !== null && !noticeLapsed(decision.notice, board.checkin?.deadlineAt ?? null, nowMs) ? decision.notice : null;
  // Spec §3.2.2: offered only on what the server's own reading of the board said it would accept, re-asked of the ticking clock: the
  // snapshot is up to a poll old, and "+5 min" exists only between the board's opening and its deadline (owner, 2026-10-19). Where it
  // is not offered the panel says nothing in its place (Task 7 M5, owner sign-off: Match Day prints no unprompted reason).
  const offer = boardExtendOffer(board.checkin, nowMs);
  const extend = may.start && offer !== null && offer.offered ? board.checkin : null;
  if (!canResync && !canGoOn && !canSettle && extend === null && notice === null) return null;
  const busy = decision.busy !== null || roundBusy;
  const guidance = settleGuidance(board);
  return (
    <section aria-labelledby={headingId} data-testid="arbiter-decision" className={className}>
      <h2 id={headingId} className="m-0 text-[17px] font-semibold">
        <span className="lg:hidden">{f.t("arbiter.decide.headingBoard", { n: board.boardNo })}</span>
        <span className="max-lg:hidden">{f.t("arbiter.decide.heading")}</span>
      </h2>
      {extend !== null && (
        <>
          <button
            type="button"
            data-testid="arbiter-extend-board"
            onClick={on.extend}
            disabled={busy}
            aria-busy={decision.busy?.kind === "extend" || undefined}
            className={BUTTON_QUIET}
          >
            {decision.busy?.kind === "extend" ? f.t("externalPlay.checkinExtend.busy") : extendBoardLabel(extend.extensionsLeft, f)}
          </button>
          <p data-testid="arbiter-extend-closes" data-deadline-at={extend.deadlineAt} className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendClosesLine(extend.deadlineAt, f)}
          </p>
          <p data-testid="arbiter-extend-helper" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendHelperLine(f)}
          </p>
        </>
      )}
      {canResync && (
        <button type="button" onClick={on.resync} disabled={busy} aria-busy={decision.busy?.kind === "resync" || undefined} className={BUTTON_QUIET}>
          {f.t("arbiter.decide.resync")}
        </button>
      )}
      {canGoOn && (
        <button
          type="button"
          onClick={() => on.goOn(board.flags.map((x) => x.id))}
          disabled={busy}
          aria-busy={decision.busy?.kind === "goOn" || undefined}
          className={BUTTON_QUIET}
        >
          {over ? f.t("externalPlay.queue.markReviewed") : f.t("arbiter.decide.goOn")}
        </button>
      )}
      {canSettle && (
        <>
          <button
            type="button"
            onClick={on.toggleSettle}
            aria-expanded={decision.settleOpen}
            aria-controls={settlePanel}
            className="min-h-11 cursor-pointer rounded-[10px] bg-[#7c3aed] px-3 text-[15px] font-semibold text-white"
          >
            {f.t("arbiter.decide.settle")}
          </button>
          {decision.settleOpen && !board.canSettle && settleHref !== null && (
            <div id={settlePanel} className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-[#e7e3f3] bg-white p-3 text-sm">
              <p className={`m-0 leading-[1.45] ${SOFT}`}>{f.t("arbiter.decide.settleElsewhere")}</p>
              <Link href={settleHref} className="min-h-11 content-center font-semibold text-[#5b21b6]">
                {f.t("arbiter.decide.settleLink", { n: board.boardNo })}
              </Link>
            </div>
          )}
          {decision.settleOpen && board.canSettle && (
            <fieldset
              id={settlePanel}
              data-testid="arbiter-settle"
              className="m-0 flex min-w-0 flex-col gap-2 rounded-[10px] border border-[#e7e3f3] bg-white p-3 text-sm"
            >
              <legend className="float-left mb-0.5 w-full p-0 text-[15px] font-semibold">
                {board.tiebreakOwed ? f.t("externalPlay.settle.pickLegend") : f.t("externalPlay.settle.legend")}
              </legend>
              <p className={`m-0 leading-[1.45] ${SOFT}`}>
                {board.tiebreakOwed ? f.t("arbiter.decide.tiebreakBody") : f.t("arbiter.decide.settleBody")}
              </p>
              <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                {settleChoices(
                  { whiteSide: board.whiteSide, whiteName: board.white.name, blackName: board.black.name, tiebreakOwed: board.tiebreakOwed, noResultOffer: board.noResultOffer },
                  f,
                ).map((c, _i, all) => {
                  // M-5: the side column is narrow, so no label is ever cut — each wraps, and each takes a row of its
                  // own (a winner's name in full, then its verb) except Draw and No result, the one pair that shares a
                  // row. A Draw with no No result beside it spans too, never left half-width alone.
                  const sharesRow = (c.choice === "draw" || c.choice === "no_result") && all.some((x) => x.choice === "no_result");
                  return (
                    <button
                      key={c.choice}
                      type="button"
                      data-settle={c.choice}
                      onClick={() => on.settle(c.choice)}
                      disabled={busy}
                      aria-busy={decision.busy?.kind === "settle" || undefined}
                      className={`${BUTTON_QUIET} min-w-0 break-words py-2${sharesRow ? "" : " min-[360px]:col-span-2"}`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {guidance !== null && (
                <p data-testid="arbiter-settle-guidance" data-why={guidance} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
                  {f.t(SETTLE_GUIDANCE_KEY[guidance])}
                </p>
              )}
            </fieldset>
          )}
        </>
      )}
      <p role="status" className={`m-0 min-h-0 text-[13px] leading-[1.45] ${SOFT}`}>
        {notice ? noticeSentence(notice, f, over, board.checkin?.deadlineAt ?? null) : null}
      </p>
    </section>
  );
}

/** The canvas's outage card ("Only during a video outage"): video required, the board still to be played, not already let go, and the
 *  join answered that the vendor is down (`unavailable`). One predicate: Match Day's board panel derives `unavailable` from its cameras
 *  (`anyUnavailable`, board-cameras.tsx, Task 9); `showsOutageCard` (online/arbiter-video.tsx) derives it from one join's state. */
export function outageOffered(b: Pick<ArbiterBoard, "cameraPolicy" | "playable" | "videoOverridden">, unavailable: boolean): boolean {
  return b.cameraPolicy === "required" && b.playable && !b.videoOverridden && unavailable;
}

/** The words of the outage card, by whether the game HAS STARTED: a first move was played (`started_at`, reconcile.ts; the loader exposes it as
 *  `ArbiterBoard.cameraReport !== null`, which inside this card - required, not let go - is exactly "started_at is set"). NOT `canResync`: a game
 *  can be on file at Lichess with nobody having moved (a game that is starting, a held no-show), and there the card is still about SEATING
 *  ("players can't take a seat ... let this board start without video"). Once a move was played the players were seated and playing, and the
 *  override means "carry on without video; camera evidence stops here" (MD-R37/R38). The decision and its gate are the same either way: only the
 *  sentence and the button say which. */
export function outageWords(started: boolean): { body: "arbiter.outage.body" | "arbiter.outage.bodyStarted"; cta: "arbiter.outage.cta" | "arbiter.outage.ctaStarted" } {
  return started ? { body: "arbiter.outage.bodyStarted", cta: "arbiter.outage.ctaStarted" } : { body: "arbiter.outage.body", cta: "arbiter.outage.cta" };
}

/** "Let this board play without video": the decision that unblocks a board whose camera the vendor cannot give, written to the audit log
 *  (D11). A decision that FINISHES nothing and STARTS nothing the freeze guards: the video override is scoring-side (owner O4 lists it with
 *  the decisions that stay offered), so its gate is `finish`. `children` is anything the card carries under the button. */
export function OutageCard({
  started,
  busy,
  overriding,
  onOverride,
  f,
  headingId,
  className,
  children,
}: {
  /** The board's `cameraReport !== null` (a first move was played): which sentence and which button (`outageWords`). */
  started: boolean;
  busy: boolean;
  overriding: boolean;
  onOverride(): void;
  f: Fmt;
  headingId: string;
  className: string;
  children?: ReactNode;
}) {
  const words = outageWords(started);
  return (
    <section aria-labelledby={headingId} data-testid="arbiter-outage" data-started={started ? "true" : "false"} className={className}>
      <span className="text-[11px] font-semibold tracking-[0.06em] uppercase">{f.t("arbiter.outage.eyebrow")}</span>
      <h2 id={headingId} className="m-0 text-[15px] font-semibold">
        {f.t("arbiter.outage.title")}
      </h2>
      <p className="m-0 text-[13px] leading-[1.45]">{f.t(words.body)}</p>
      <button
        type="button"
        onClick={onOverride}
        disabled={busy}
        aria-busy={overriding || undefined}
        className="min-h-11 cursor-pointer rounded-[10px] bg-[#713f12] px-3 text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {f.t(words.cta)}
      </button>
      {children}
    </section>
  );
}
