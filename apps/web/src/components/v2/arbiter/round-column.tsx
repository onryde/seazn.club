"use client";

// The Arbiter Panel's round column (spec 2026-10-24-arbiter-round-column-design.md): the one box that answers "what does this
// round want from me now". This file draws two phases and one list that belongs to the second:
//
//   BEFORE   the round is paired and nobody is invited: one block for each round the organiser can open, with the press, its
//            confirmation, the answer, and a read-only list of the pairings;
//   CHECK-IN the round is open and some board is still `checking_in`: the HERO (the countdown to the next board closing, who has
//            checked in, what is already playing, the round's own +5 and reinvite press, the staggered groups) and, placed by the
//            panel under the camera, the WAITING LIST (the seats that are not here, each seat's invite words, Resend, a board's +5).
//
// The playing phase draws in a later task; until then it renders nothing, so the panel is unchanged.
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
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import { fmtTime } from "@/lib/format";
import { INVITE_WORD_KEYS, type SeatInviteWord } from "@/lib/invite-status";
import type { MessageKey } from "@/lib/messages";
import type { OpenRoundView } from "@/lib/open-round";
import { checkinClock, checkinTally, nextRoundViews, openWindowBoards, roundColumnPhase, viewOfRound } from "@/lib/round-column";
import { routes } from "@/lib/routes";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { BUTTON_QUIET, CLOCK_FACE, MUTED, SOFT } from "../arbiter-flag-cards";
import { boardExtendOffer, extendBoardLabel } from "../checkin-extend-ui";
import { ConfirmDialog } from "../confirm-dialog";
import { OpenRoundConfirmBody, openNoticeText, owedPlayers, resendNoticeText, timedBatches } from "../desk/open-round-control";
import type { OpenRoundUiState } from "../desk/open-round-state";
import { useOpenRound, type OpenRoundHandle } from "../desk/use-open-round";

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
};

const INK = "text-[#2e1065]";
const CARD_BOX = "min-w-0 rounded-xl border border-[#e7e3f3] bg-white p-3";
const BUTTON_PRIMARY =
  "min-h-11 w-full cursor-pointer rounded-[10px] bg-[#7c3aed] px-4 text-[15px] font-semibold text-white hover:bg-[#5b21b6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto";

/** Spec §5.1, the paths with no board grid: first on a phone, the second track from `md`, and row 1 by name so the place does not
 *  depend on where the aside sits in the DOM. A landmark is never `contents`. Task 8 owns the grid path's placement. */
const ASIDE_CLASS = "flex min-w-0 flex-col gap-3 max-md:order-[-1] md:col-start-2 md:row-start-1";

export function RoundColumn(p: RoundColumnProps) {
  const msg = useMsg();
  const phase = roundColumnPhase(p.round, p.requested);
  // Before and check-in are drawn here. "none" is the panel's notice standing alone (spec §5.2 rule 1); playing is a later task's.
  if (phase !== "before" && phase !== "checkin") return null;

  if (phase === "checkin") {
    // `checking_in` boards on screen mean a round on screen; a named refusal rather than an assumption.
    if (p.round === null) return null;
    return (
      <aside aria-label={msg("arbiter.column.label")} data-testid="arbiter-round-column" data-phase={phase} className={ASIDE_CLASS}>
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
  // it, and a block with an Open round press over "0 boards" is worse than none - it falls to the "nothing paired" line below,
  // which is true. Filtered BEFORE the stage count, so a stage with no block does not make the others name theirs.
  const views = nextRoundViews(p.data.views, p.round).filter((v) => v.pairings.length > 0);
  // The stage is named only when more than one STAGE has a block (spec §5.4), not when more than one block exists.
  const showStage = new Set(views.map((v) => v.stageId)).size > 1;
  return (
    <aside aria-label={msg("arbiter.column.label")} data-testid="arbiter-round-column" data-phase={phase} className={ASIDE_CLASS}>
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
function NextRoundBlock({ view, tz, showStage }: { view: OpenRoundView; tz: string; showStage: boolean }) {
  const handle = useOpenRound(view);
  return <OpenRoundBlockView view={view} state={handle.state} tz={tz} showStage={showStage} on={{ ask: handle.ask, cancel: handle.cancel, open: handle.open }} />;
}

/** C25: pure (state in, markup out): one view's heading, lede, press, confirmation and notice, then its pairings. */
export function OpenRoundBlockView({
  view,
  state,
  tz,
  showStage,
  on,
}: {
  view: OpenRoundView;
  state: OpenRoundUiState;
  tz: string;
  showStage: boolean;
  on: { ask(): void; cancel(): void; open(): void };
}) {
  const msg = useMsg();
  const plural = useMsgPlural();
  // A named refusal, not an assumption: the column hands this only views whose press is "open", but a view the reader says
  // cannot be opened gets no press and no confirmation here.
  const canOpen = view.press === "open";
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
      aria-labelledby={headingId}
      data-testid="arbiter-column-open"
      data-stage-id={view.stageId}
      data-round-no={view.roundNo}
      className={`flex flex-col gap-3 ${CARD_BOX}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={headingId} className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
          {heading}
        </h2>
        <p className={`m-0 text-[13px] leading-[1.45] ${MUTED}`}>{plural("runsheet.round.pairedLede", boards, { players: boards * 2 })}</p>
      </div>

      {canOpen && (
        <button
          type="button"
          data-testid="arbiter-column-open-cta"
          disabled={state.busy !== null}
          aria-busy={state.busy?.kind === "open" || undefined}
          onClick={on.ask}
          className={BUTTON_PRIMARY}
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

      <ConfirmDialog
        open={canOpen && state.confirming}
        testId="arbiter-column-confirm"
        title={msg("runsheet.round.confirmTitle", { round: view.roundNo })}
        confirmLabel={plural("runsheet.round.confirmCta", owed)}
        confirmVariant="primary"
        cancelLabel={msg("confirm.cancel")}
        busy={state.busy !== null}
        onConfirm={on.open}
        onCancel={on.cancel}
      >
        <OpenRoundConfirmBody round={view} tz={tz} />
      </ConfirmDialog>
    </section>
  );
}

// ---- check-in: the hero ---------------------------------------------------------------------------------------------------------

/** "07:42": whole minutes and seconds left to `atIso`, rounded UP, so a clock that is still counting never reads 00:00 (the board
 *  closes AT its deadline, and one millisecond short of it there is still a second on the face). Minutes are not capped. */
export function countdownText(atIso: string, nowMs: number): string {
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
};

/** The check-in hero (spec §5.3): the countdown to the NEXT board closing, who has checked in, what is already playing, the round's
 *  +5 (the node the panel hands over), the round's own reinvite or reopen press, and the staggered groups. */
export function CheckinHero({ round, view, tz, nowMs, openRound, roundExtend }: CheckinHeroProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const { state } = openRound;
  const clock = checkinClock(round.boards, nowMs);
  const tally = checkinTally(round.boards, nowMs);
  const batches = view === null ? null : timedBatches(view);
  // The round's own press: a seat whose invite was released (Not delivered, Bounced) is invited again from here (C4), and a round
  // nobody was reached by opens again. Any other press belongs to the Fixtures tab or to no one.
  const owedView = view !== null && (view.press === "reinvite" || view.press === "reopen") ? view : null;
  const notice = view !== null && state.notice !== null ? openNoticeText(state.notice, view, msg, plural) : null;
  const owed = owedView === null ? 0 : owedPlayers(owedView);
  const reinvite = owedView?.press === "reinvite";

  const clockLabel =
    clock.kind === "closes" ? msg("arbiter.column.checkin.closesIn") : clock.kind === "opens" ? msg("arbiter.column.checkin.opensIn") : msg("arbiter.column.checkin.closed");

  return (
    <section aria-labelledby="arbiter-checkin-heading" data-testid="arbiter-checkin-hero" className={`flex flex-col gap-3 ${CARD_BOX}`}>
      <h2 id="arbiter-checkin-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
        {msg("runsheet.round.heading", { round: round.roundNo })}
      </h2>

      {/* The one large element of the column. Three states of one clock, each with its own words; before mount (nowMs null) the
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

      {/* A zero clause is never printed (desk _RULES: an empty cell is not information). A held board is the queue's, not playing. */}
      {(tally.playing > 0 || tally.finished > 0) && (
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
        </div>
      )}

      {/* The panel's one "+5 min to the round", exactly as it is handed over (its button, why line and answer). */}
      {roundExtend}

      {owedView !== null && (
        <button
          type="button"
          data-testid="arbiter-column-reinvite"
          disabled={state.busy !== null}
          aria-busy={state.busy?.kind === "open" || undefined}
          onClick={openRound.ask}
          className={`${BUTTON_QUIET} w-full sm:w-auto`}
        >
          {reinvite ? plural("runsheet.round.inviteCta", owed) : msg("runsheet.round.openCta")}
        </button>
      )}

      {/* The press's answer stays under it even after the answer flips the press away (a successful reinvite leaves nobody owed). */}
      {notice !== null && (
        <div role="status" data-testid="arbiter-column-reinvite-notice" className={`min-w-0 space-y-0.5 text-sm ${SOFT}`}>
          {notice.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
        </div>
      )}

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
                  {msg("runsheet.round.batchOpens", { time: fmtTime(tz, b.opensAt) })}
                </span>
                <span data-field="closes" className={`text-xs ${MUTED}`}>
                  {msg("runsheet.round.batchCloses", { time: fmtTime(tz, b.closesAt) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The reinvite's confirmation: the run sheet's own words and body. Closed unless the reader offers the press. */}
      <ConfirmDialog
        open={owedView !== null && state.confirming}
        testId="arbiter-column-reinvite-dialog"
        title={
          reinvite
            ? msg("runsheet.round.confirmTitleReinvite", { round: round.roundNo })
            : msg("runsheet.round.confirmTitleReopen", { round: round.roundNo })
        }
        confirmLabel={reinvite ? plural("runsheet.round.inviteCta", owed) : plural("runsheet.round.confirmCta", owed)}
        confirmVariant="primary"
        cancelLabel={msg("confirm.cancel")}
        busy={state.busy !== null}
        onConfirm={openRound.open}
        onCancel={openRound.cancel}
      >
        {owedView !== null && <OpenRoundConfirmBody round={owedView} tz={tz} />}
      </ConfirmDialog>
    </section>
  );
}

// ---- check-in: the waiting list -------------------------------------------------------------------------------------------------

/** C9: placed by Task 8 in the board group (under the camera from md). Shares the column's handle. */
export type WaitingListProps = {
  /** `round.boards`; the list filters with `openWindowBoards`, the SAME set the hero's tally counts. */
  boards: readonly ArbiterBoard[];
  /** `viewOfRound(...)`; null => no Resend on any row (the guard). */
  view: OpenRoundView | null;
  openRound: OpenRoundHandle;
  nowMs: number | null;
  on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
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

/** The seats that are not here yet (spec §5.3): the `checking_in` boards whose window is open now, with at least one seat not here,
 *  in board order - the same boards the tally counts, so its denominator and this list never disagree. A board whose `seats` is null
 *  is listed with both seats "Not here yet" and no chip (the tally counts it as two seats, none here). Empty: no list at all, and
 *  no help line (with no row there is nothing to explain). */
export function WaitingList({ boards, view, openRound, nowMs, on }: WaitingListProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const { state } = openRound;
  const rows = openWindowBoards(boards, nowMs).filter((b) => !(b.seats !== null && b.seats.white.here && b.seats.black.here));
  if (rows.length === 0) return null;
  // The extend label reads the step and the presses left from the dictionary; it needs no clock face.
  const copy = { t: (key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars), plural, hm: () => null };

  return (
    <section aria-labelledby="arbiter-waiting-heading" data-testid="arbiter-waiting" className={`flex flex-col gap-2 ${CARD_BOX}`}>
      <h2 id="arbiter-waiting-heading" data-testid="arbiter-waiting-heading" className={`m-0 min-w-0 text-base font-semibold break-words ${INK}`}>
        {plural("arbiter.column.waiting", rows.length)}
      </h2>
      <ul className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] p-0">
        {rows.map((b) => {
          // C14: the row's +5 is the live clock's reading of THIS board's window, never the snapshot's `canExtend`.
          const offer = boardExtendOffer(b.checkin, nowMs);
          const canExtend = offer !== null && offer.offered;
          // Resend is the round's view's word for this pairing; no view, or no pairing for this board, means no Resend.
          const canResend = view?.pairings.find((x) => x.fixtureId === b.fixtureId)?.canResend === true;
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
                  const seat = b.seats?.[colour] ?? null;
                  const here = seat !== null && seat.here;
                  return (
                    <li key={colour} data-testid="arbiter-seat" data-colour={colour} data-here={String(here)} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`w-14 shrink-0 text-xs ${MUTED}`}>{msg(colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black")}</span>
                      <span data-field="name" className={`min-w-0 flex-1 basis-32 text-sm font-medium break-words ${INK}`}>
                        {b[colour].name}
                      </span>
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
                          {(seat?.invites ?? []).map((word, i) => (
                            <span key={`${word}:${i}`} data-testid="arbiter-invite-word" data-word={word} className={`${CHIP} ${CHIP_PAIR[word]}`}>
                              {msg(INVITE_WORD_KEYS[word] as MessageKey)}
                            </span>
                          ))}
                        </>
                      )}
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
