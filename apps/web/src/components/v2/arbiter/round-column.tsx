"use client";

// The Arbiter Panel's round column (spec 2026-10-24-arbiter-round-column-design.md): the one box that answers "what does this
// round want from me now". This file is its BEFORE phase - the round is paired and nobody is invited: one block for each round
// the organiser can open, with the press, its confirmation, the answer, and a read-only list of the pairings. The check-in and
// playing phases draw in later tasks; until then they render nothing, so the panel is unchanged.
//
// What a block presses is its OWN round. Each block calls `useOpenRound(view)` itself (R1 holds per round); the handle the
// panel shares for the round ON SCREEN (`openRound`) is for the check-in hero and the waiting list, and in this phase there is
// no round on screen. The press, its confirmation and its answer are the ones the run sheet's control uses
// (`OpenRoundConfirmBody`, `openNoticeText`, `openRoundRunner`'s in-flight guard behind `useOpenRound`), so a double click is one
// POST and a press from a page made stale by an open elsewhere reads "already open" and invites nobody.
//
// House theme (spec §4): ink / soft / muted text, `#e7e3f3` borders, `#7c3aed` for the one primary button per block, 44px
// targets, one DOM, mobile-first, `min-w-0` down every ancestor of a name.
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { ArbiterRound } from "@/lib/arbiter-view";
import type { OpenRoundView } from "@/lib/open-round";
import { nextRoundViews, roundColumnPhase } from "@/lib/round-column";
import { routes } from "@/lib/routes";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { MUTED, SOFT } from "../arbiter-flag-cards";
import { ConfirmDialog } from "../confirm-dialog";
import { OpenRoundConfirmBody, openNoticeText, owedPlayers } from "../desk/open-round-control";
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

export function RoundColumn(p: RoundColumnProps) {
  const msg = useMsg();
  const phase = roundColumnPhase(p.round, p.requested);
  // Only the before phase is drawn here. "none" is the panel's notice standing alone (spec §5.2 rule 1).
  if (phase !== "before") return null;

  const views = nextRoundViews(p.data.views, p.round);
  // The stage is named only when more than one STAGE has a block (spec §5.4), not when more than one block exists.
  const showStage = new Set(views.map((v) => v.stageId)).size > 1;
  return (
    <aside
      aria-label={msg("arbiter.column.label")}
      data-testid="arbiter-round-column"
      data-phase={phase}
      // Spec §5.1, the paths with no board grid: first on a phone, the second track from `md`. A landmark is never `contents`.
      className="flex min-w-0 flex-col gap-3 max-md:order-[-1] md:col-start-2"
    >
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

      {/* A scrolling region a keyboard can reach (AGENTS class 23): focusable, a region, named. A long round scrolls here rather
          than pushing the rest of the page away. */}
      <div
        role="region"
        tabIndex={0}
        aria-label={msg("runsheet.round.pairingsLabel", { round: view.roundNo })}
        data-testid="arbiter-column-pairings"
        className="max-h-[40vh] min-w-0 overflow-y-auto rounded-lg border border-[#e7e3f3]"
      >
        <ul className="m-0 min-w-0 list-none divide-y divide-[#e7e3f3] p-0">
          {view.pairings.map((p) => (
            <li key={p.fixtureId} data-testid={`arbiter-column-pairing-${p.fixtureId}`} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
              <span className={`min-w-16 shrink-0 text-xs font-semibold ${MUTED}`}>{msg("arbiter.boardNo", { n: p.boardNo })}</span>
              <span className="min-w-0 flex-1 basis-40 text-sm break-words">
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
