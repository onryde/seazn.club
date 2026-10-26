"use client";

// The Arbiter Panel round column's QUEUE (spec 2026-10-24-arbiter-round-column-design.md §5.6): the boards that need a decision,
// as compact cards, first in the column in every phase. The panel already has the full decision area for the board on screen, so
// a card does not settle anything - it says what happened and where, and offers the way to the decision:
//
//   - a board of the round on screen: "Review board 4" is a BUTTON that selects it in place (nothing on the panel links to the
//     panel's own URL - that was the self-link defect);
//   - a board of another round or stage: "Review board 4" is a LINK to the panel pinned to that board's round;
//   - a board the organiser plays on (a held card): shown with the settle-own-board line, no action, and not counted;
//   - a cancelled flagged board: it can never be selected, so its card keeps the inline "Mark as reviewed" it has on the Fixtures
//     tab. That mounts a second decision reducer and runner on the page, for that card only - accepted and recorded (pre-flight T7).
//
// Held and flagged cards are separate cards: a held board with an open flag is in both lists, and is counted ONCE (C6,
// `attentionCount`, the same function the Fixtures-tab entry line reads). The `ownFlagged` line says how many flagged boards the
// organiser plays on are left out of the list (C11): it is rendered, never inert. House theme (spec §4): held is red, flagged is
// amber, text is ink / soft / muted, 44px targets, `min-w-0` down every ancestor of a name.
import { useMemo, useReducer } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import type { ArbiterRound } from "@/lib/arbiter-view";
import { apiV1 } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import { attentionCount, countedHeld, reviewTarget, type ReviewTarget } from "@/lib/round-column";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { arbiterDecision, decisionRunner, initialArbiterDecision } from "../arbiter-decision";
import { boardStateWord, BUTTON_QUIET, MUTED, noticeSentence, SOFT, useFmt } from "../arbiter-flag-cards";
import { HELD_TITLE_KEYS, heldBody, namesByColour, where } from "../external-play-held-copy";

export type RoundQueueCardsProps = {
  /** The round on screen, or null: a board in it is selected in place, any other board is linked to. */
  round: ArbiterRound | null;
  /** The organiser's held boards (some may be `seated`: shown, never counted). */
  held: readonly NeedsOrganiserExternalPlayRow[];
  /** Boards with open flags, any state; boards the organiser plays on are never in it. */
  flagged: readonly FlaggedBoard[];
  /** C11: how many flagged boards the organiser plays on are left out of `flagged`. Rendered above zero. */
  ownFlagged: number;
  slugs: { org: string; comp: string; div: string };
  /** The panel's `select`: "Review board N" for a board of the round on screen. */
  onSelect(fixtureId: string): void;
};

const INK = "text-[#2e1065]";
const TITLE_ID = "arbiter-column-queue-title";
const CARD = "flex min-w-0 flex-col gap-2 rounded-xl border bg-white p-3";
const CHIP = "inline-flex items-center rounded-full border px-2.5 py-[3px] text-xs font-semibold";
const CHIP_HELD = `${CHIP} border-[#f1c4c0] bg-[#fef2f2] text-[#b42318]`;
const CHIP_FLAGGED = `${CHIP} border-[#f5d27a] bg-[#fef3c7] text-[#713f12]`;
const ACTION = `${BUTTON_QUIET} w-full sm:w-auto`;

export function RoundQueueCards({ round, held, flagged, ownFlagged, slugs, onSelect }: RoundQueueCardsProps) {
  const router = useRouter();
  const [decision, dispatch] = useReducer(arbiterDecision, null, initialArbiterDecision);
  // Flag times of day are not drawn here, so the formatter needs neither a clock nor a zone: stated as null, never left to default.
  const f = useFmt(null, null);
  const runner = useMemo(
    () =>
      decisionRunner({
        dispatch,
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
        // The column only closes flags; overriding video is the panel's decision.
        overrideNote: "",
      }),
    [router],
  );

  // The answer shows on the card it was sent for. When the refresh that answers it takes the card away, it shows in the block's
  // status line instead of vanishing with the card; otherwise that line is only for screen readers (the card shows it).
  const notice = decision.notice;
  const cardIds = new Set([...held.map((r) => r.fixtureId), ...flagged.map((b) => b.fixtureId)]);
  const orphan = notice !== null && !cardIds.has(notice.boardId);
  const status = (
    <p role="status" data-testid="arbiter-column-queue-status" className={orphan ? `m-0 text-sm leading-[1.45] ${SOFT}` : "sr-only"}>
      {notice ? noticeSentence(notice, f, true) : null}
    </p>
  );

  if (held.length === 0 && flagged.length === 0 && ownFlagged === 0) {
    return notice === null ? null : (
      <section data-testid="arbiter-column-queue" className="flex min-w-0 flex-col gap-2">
        {status}
      </section>
    );
  }

  // C6: distinct boards, the seated ones left out. Red when a counted card is held; a flagged board alone is amber's, not red's.
  const counted = attentionCount(held, flagged);
  const anyHeld = countedHeld(held).length > 0;
  const busy = decision.busy !== null;

  const names = (white: string, black: string) => (
    <p data-testid="arbiter-column-card-names" className={`m-0 min-w-0 text-[15px] leading-snug font-semibold break-words ${INK}`}>
      {white} <span className={`font-normal ${MUTED}`}>{f.t("arbiter.vs")}</span> {black}
    </p>
  );

  // `boardNo` null: the board has no number to name it by, so the action says so (the where line falls back to the stage).
  const review = (fixtureId: string, boardNo: number | null, target: ReviewTarget) => {
    if (target.kind === "none") return null;
    const label = boardNo === null ? f.t("arbiter.column.reviewThis") : f.t("arbiter.column.review", { board: boardNo });
    if (target.kind === "select") {
      return (
        <button type="button" data-testid="arbiter-column-review" data-target="select" onClick={() => onSelect(fixtureId)} className={ACTION}>
          {label}
        </button>
      );
    }
    return (
      <Link
        href={routes.divisionArbiter(slugs.org, slugs.comp, slugs.div, fixtureId)}
        data-testid="arbiter-column-review"
        data-target="link"
        className={`${ACTION} inline-flex items-center justify-center`}
      >
        {label}
      </Link>
    );
  };

  const cardNotice = (fixtureId: string) =>
    notice !== null && notice.boardId === fixtureId ? (
      <p data-testid="arbiter-column-card-notice" className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
        {noticeSentence(notice, f, true)}
      </p>
    ) : null;

  const heldCard = (row: NeedsOrganiserExternalPlayRow) => {
    const { whiteName, blackName } = namesByColour(row);
    const body = heldBody({ reason: row.reason, revokedSeat: row.revokedSeat, whiteName, blackName });
    return (
      <li key={`held:${row.fixtureId}`} data-testid="arbiter-column-card" data-kind="held" data-fixture-id={row.fixtureId} className={`${CARD} border-[#f1c4c0]`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span data-testid="arbiter-column-card-chip" className={CHIP_HELD}>
            {f.t(HELD_TITLE_KEYS[row.reason])}
          </span>
          <span data-testid="arbiter-column-card-where" className={`min-w-0 text-xs break-words ${MUTED}`}>
            {where(row, f)}
          </span>
        </div>
        {names(whiteName, blackName)}
        <p data-testid="arbiter-column-card-body" className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
          {f.t(body.key, body.vars)}
        </p>
        {row.seated ? (
          <p data-testid="arbiter-column-seated" className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
            {f.t("arbiter.notice.settleOwnBoard")}
          </p>
        ) : (
          review(row.fixtureId, row.boardNo, reviewTarget(row.fixtureId, round, { seated: row.seated, cancelled: false }))
        )}
      </li>
    );
  };

  const flaggedCard = (b: FlaggedBoard) => {
    // A cancelled board can never be selected (the round excludes it), so `reviewTarget` says "none" and the card closes its review itself.
    const target = reviewTarget(b.fixtureId, round, { seated: false, cancelled: b.state.kind === "cancelled" });
    return (
      <li key={`flagged:${b.fixtureId}`} data-testid="arbiter-column-card" data-kind="flagged" data-fixture-id={b.fixtureId} className={`${CARD} border-[#f5d27a]`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span data-testid="arbiter-column-card-chip" className={CHIP_FLAGGED}>
            {f.plural("arbiter.flagCount", b.flags.length)}
          </span>
          <span data-testid="arbiter-column-card-where" className={`min-w-0 text-xs break-words ${MUTED}`}>
            {where({ roundNo: b.roundNo, boardNo: b.boardNo, stageName: b.stageName }, f)}
          </span>
          <span data-testid="arbiter-column-card-state" className={`text-xs ${MUTED}`}>
            {boardStateWord(b.state, f)}
          </span>
        </div>
        {names(b.white.name, b.black.name)}
        {target.kind === "none" ? (
          <button
            type="button"
            data-testid="arbiter-column-mark-reviewed"
            disabled={busy}
            aria-busy={(decision.busy?.kind === "goOn" && decision.busy.boardId === b.fixtureId) || undefined}
            onClick={() => {
              // The answer shows on the card it was sent for: the card is "on screen" while its request is out.
              dispatch({ type: "select", boardId: b.fixtureId });
              void runner.goOn(
                b.fixtureId,
                b.flags.map((flag) => flag.id),
              );
            }}
            className={ACTION}
          >
            {f.t("externalPlay.queue.markReviewed")}
          </button>
        ) : (
          review(b.fixtureId, b.boardNo, target)
        )}
        {cardNotice(b.fixtureId)}
      </li>
    );
  };

  return (
    <section data-testid="arbiter-column-queue" aria-labelledby={counted > 0 ? TITLE_ID : undefined} className="flex min-w-0 flex-col gap-2">
      {counted > 0 && (
        <h2
          id={TITLE_ID}
          data-testid={TITLE_ID}
          data-tone={anyHeld ? "held" : "flagged"}
          className={`m-0 min-w-0 text-base font-semibold break-words ${anyHeld ? "text-[#b42318]" : INK}`}
        >
          {f.plural("arbiter.column.queue", counted)}
        </h2>
      )}
      {status}
      {(held.length > 0 || flagged.length > 0) && (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
          {held.map(heldCard)}
          {flagged.map(flaggedCard)}
        </ul>
      )}
      {ownFlagged > 0 && (
        <p data-testid="arbiter-column-own-flagged" className={`m-0 text-[13px] leading-[1.45] ${MUTED}`}>
          {f.plural("externalPlay.queue.ownFlagged", ownFlagged)}
        </p>
      )}
    </section>
  );
}
