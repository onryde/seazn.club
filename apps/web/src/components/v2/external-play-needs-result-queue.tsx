"use client";
// T16 — "Online play — needs result" on the division's fixtures tab (canvas
// HoldQueueDesktop / HoldQueuePhone). Two lists, side by side at `lg`, one
// column below it:
//   - Held: boards the sweep or the result writer held for the organiser.
//     Each names what happened (one title and one sentence per needs_reason,
//     external-play-held-copy.ts) and offers what settles it: Resync from
//     Lichess when a game is on file, and Settle — four buttons by colour, or
//     "Pick the winner" for a drawn knockout game, which opens on its own;
//   - Flagged: boards whose game carried on with OPEN flags. Evidence, never
//     a verdict: the flag cards are the arbiter panel's own, and "Let the game
//     go on" (or, once the game is over, "Mark as reviewed") closes exactly
//     the flags on screen.
//
// Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §8): this queue is on the Fixtures tab only where the Arbiter Panel is NOT
// offered (online play switched off, or the club not offered online chess), so it links nowhere into it: the panel would 404.
// Where the panel is offered, the same two lists are the round column's queue, there.
//
// Every action here FINISHES play or reviews it, so nothing is gated by the
// online-chess flag (T20). The invite resend is not here: the server refuses
// it for every held board (invite.ts, 409 BOARD_HELD / ONLINE_GAME_EXISTS).
//
// The requests share the arbiter panel's reducer and runner
// (arbiter-decision.ts): one request at a time across the whole queue, and an
// answer shows on the row it was sent for.
import { useEffect, useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { boardIsOver } from "@/lib/arbiter-view";
import { apiV1 } from "@/lib/client-v1";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { arbiterDecision, decisionRunner, initialArbiterDecision, type ArbiterDecisionState, type ArbiterNotice } from "./arbiter-decision";
import { boardStateWord, BUTTON_QUIET, FlagCard, MUTED, noticeSentence, settleChoices, settleGuidance, SETTLE_GUIDANCE_KEY, SOFT, useFmt, type Fmt } from "./arbiter-flag-cards";
import { HELD_TITLE_KEYS, heldBody, namesByColour, queueRowAnchor, where } from "./external-play-held-copy";

export type HeldRow = Pick<
  NeedsOrganiserExternalPlayRow,
  "fixtureId" | "homeName" | "awayName" | "reason" | "whiteSide" | "revokedSeat" | "roundNo" | "boardNo" | "stageName" | "canResync" | "seated" | "noResultOffer"
>;

export type ExternalPlayQueueProps = {
  held: HeldRow[];
  flagged: FlaggedBoard[];
  /** Flagged boards the viewer plays on: hidden from them (C1), counted. */
  ownFlagged: number;
};

const CHIP = "self-start rounded-full px-2.5 py-[3px] text-xs font-semibold";
const CHIP_HELD = `${CHIP} bg-[#fef2f2] text-[#b42318]`;
const LIST_HEADING = "m-0 text-[13px] font-semibold text-[#4a3a6b]";
const SETTLE_TOGGLE =
  "flex min-h-11 cursor-pointer list-none items-center justify-center rounded-[10px] bg-[#7c3aed] px-3 text-[15px] font-semibold text-white [&::-webkit-details-marker]:hidden";

function Names({ white, black, f }: { white: string; black: string; f: Fmt }) {
  return (
    <p className="m-0 min-w-0 text-[15px] leading-snug font-semibold break-words text-[#2e1065]">
      {white} <span className={`font-normal ${MUTED}`}>{f.t("arbiter.vs")}</span> {black}
    </p>
  );
}

/** What the last answer says. A closed flag on a finished game was reviewed,
 *  not let go on: the queue says so, as the panel does (noticeSentence's `over`). */
function sentence(n: ArbiterNotice, over: boolean, f: Fmt): string {
  return noticeSentence(n, f, over);
}

/** The answer, on the row it was sent for (visual only: the queue's one live
 *  region announces it). A plain function, not a component: it is part of the
 *  row's own markup. */
function rowNotice(fixtureId: string, decision: ArbiterDecisionState, over: boolean, f: Fmt) {
  const n = decision.notice?.boardId === fixtureId ? decision.notice : null;
  if (n === null) return null;
  return (
    <p data-testid="external-play-row-notice" className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
      {sentence(n, over, f)}
    </p>
  );
}

export function ExternalPlayNeedsResultQueue({ held, flagged, ownFlagged }: ExternalPlayQueueProps) {
  const router = useRouter();
  const [decision, dispatch] = useReducer(arbiterDecision, null, initialArbiterDecision);
  // Flag times of day render after mount: the server's timezone is not the
  // organiser's (as in the arbiter panel).
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    return () => clearTimeout(first);
  }, []);
  const f = useFmt(nowMs);
  const runner = useMemo(
    () =>
      decisionRunner({
        dispatch,
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
        // The queue never overrides video: that decision is the panel's.
        overrideNote: "",
      }),
    [router],
  );
  // Whether the board acted on last had its result: kept with the press, as
  // a settled or reviewed row leaves the list on the refresh that answers it.
  const [actedOnOver, setActedOnOver] = useState(false);
  // The answer shows on the row it was sent for: the row is "on screen".
  const on = (fixtureId: string, over: boolean) => {
    setActedOnOver(over);
    dispatch({ type: "select", boardId: fixtureId });
  };

  const rowIds = new Set([...held.map((r) => r.fixtureId), ...flagged.map((b) => b.fixtureId)]);
  const notice = decision.notice;
  // The row it answers has left the list (settled, or its flags closed): the
  // answer shows here instead of vanishing with it.
  const orphan = notice !== null && !rowIds.has(notice.boardId);
  const status = (
    <p role="status" data-testid="external-play-queue-status" className={orphan ? `m-0 text-sm leading-[1.45] ${SOFT}` : "sr-only"}>
      {notice ? sentence(notice, actedOnOver, f) : null}
    </p>
  );
  if (held.length === 0 && flagged.length === 0 && ownFlagged === 0) {
    return notice === null ? null : <section data-testid="external-play-needs-result-queue">{status}</section>;
  }
  const busy = decision.busy !== null;
  const decided = held.filter((r) => r.reason !== "tiebreak_owed");
  const knockouts = new Map<string, HeldRow[]>();
  for (const r of held) {
    if (r.reason !== "tiebreak_owed") continue;
    knockouts.set(r.stageName, [...(knockouts.get(r.stageName) ?? []), r]);
  }

  const heldCard = (row: HeldRow) => {
    const { whiteName, blackName } = namesByColour(row);
    const body = heldBody({ reason: row.reason, revokedSeat: row.revokedSeat, whiteName, blackName });
    const tiebreak = row.reason === "tiebreak_owed";
    const guidance = settleGuidance({ tiebreakOwed: tiebreak, noResultOffer: row.noResultOffer });
    const fieldset = (
      <fieldset data-testid="external-play-settle" className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="float-left mb-0.5 w-full p-0 text-sm font-semibold text-[#2e1065]">
          {tiebreak ? f.t("externalPlay.settle.pickLegend") : f.t("externalPlay.settle.legend")}
        </legend>
        <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {settleChoices({ whiteSide: row.whiteSide, whiteName, blackName, tiebreakOwed: tiebreak, noResultOffer: row.noResultOffer }, f).map((c) => (
            <button
              key={c.choice}
              type="button"
              data-testid={`external-play-resolve-${c.choice}`}
              data-settle={c.choice}
              disabled={busy}
              aria-busy={(decision.busy?.kind === "settle" && decision.busy.boardId === row.fixtureId) || undefined}
              onClick={() => {
                on(row.fixtureId, false);
                void runner.settle(row.fixtureId, c.choice);
              }}
              className={`${BUTTON_QUIET} min-w-0 break-words${c.wide ? " min-[360px]:col-span-2 py-2" : ""}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {guidance !== null && (
          <p data-testid="external-play-settle-guidance" data-why={guidance} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
            {f.t(SETTLE_GUIDANCE_KEY[guidance])}
          </p>
        )}
      </fieldset>
    );
    return (
      <li
        key={row.fixtureId}
        id={queueRowAnchor(row.fixtureId)}
        data-testid={queueRowAnchor(row.fixtureId)}
        data-reason={row.reason}
        className="flex min-w-0 scroll-mt-20 flex-col gap-2 rounded-xl border border-[#f1c4c0] bg-white p-3 lg:p-3.5"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span data-testid="external-play-held-title" className={CHIP_HELD}>
            {f.t(HELD_TITLE_KEYS[row.reason])}
          </span>
          <span className={`text-xs ${MUTED}`}>{where(row, f)}</span>
        </div>
        <Names white={whiteName} black={blackName} f={f} />
        <p data-testid="external-play-held-body" className={`m-0 text-[13px] leading-[1.45] lg:text-sm ${SOFT}`}>
          {f.t(body.key, body.vars)}
        </p>
        {row.seated ? (
          <p className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>{f.t("arbiter.notice.settleOwnBoard")}</p>
        ) : (
          <>
            {row.canResync && (
              <button
                type="button"
                data-testid="external-play-resync"
                disabled={busy}
                aria-busy={(decision.busy?.kind === "resync" && decision.busy.boardId === row.fixtureId) || undefined}
                onClick={() => {
                  on(row.fixtureId, false);
                  void runner.resync(row.fixtureId);
                }}
                className={BUTTON_QUIET}
              >
                {f.t("arbiter.decide.resync")}
              </button>
            )}
            {tiebreak ? (
              fieldset
            ) : (
              <details className="group flex min-w-0 flex-col gap-2">
                <summary data-testid="external-play-settle-toggle" className={SETTLE_TOGGLE}>
                  {f.t("externalPlay.queue.settle")}
                </summary>
                <div className="mt-2">{fieldset}</div>
              </details>
            )}
          </>
        )}
        {rowNotice(row.fixtureId, decision, false, f)}
      </li>
    );
  };

  return (
    <section data-testid="external-play-needs-result-queue" aria-labelledby="external-play-queue-title" className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0">
        <h2 id="external-play-queue-title" className="m-0 text-[17px] font-semibold text-[#2e1065]">
          {f.t("externalPlay.queue.title")}
        </h2>
        <p className={`m-0 mt-0.5 text-sm leading-[1.45] ${SOFT}`}>{f.t("externalPlay.queue.help")}</p>
      </div>
      {status}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {held.length > 0 && (
          <div data-testid="external-play-held" className="flex min-w-0 flex-col gap-2.5">
            <h3 className={LIST_HEADING}>{f.t("externalPlay.queue.heldHeading", { count: held.length })}</h3>
            {decided.length > 0 && <ul className="m-0 flex min-w-0 list-none flex-col gap-2.5 p-0">{decided.map(heldCard)}</ul>}
            {[...knockouts].map(([stage, rows]) => (
              <div key={stage} className="flex min-w-0 flex-col gap-2.5">
                <h4 className={LIST_HEADING}>{f.t("externalPlay.queue.knockoutHeading", { stage })}</h4>
                <ul className="m-0 flex min-w-0 list-none flex-col gap-2.5 p-0">{rows.map(heldCard)}</ul>
              </div>
            ))}
          </div>
        )}
        {(flagged.length > 0 || ownFlagged > 0) && (
          <div data-testid="external-play-flagged" className="flex min-w-0 flex-col gap-2.5">
            <h3 className={LIST_HEADING}>{f.t("externalPlay.queue.flaggedHeading", { count: flagged.length })}</h3>
            <p className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>{f.t("externalPlay.queue.flaggedLede")}</p>
            <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
              {flagged.map((b) => {
                const over = boardIsOver(b.state);
                return (
                  <li
                    key={b.fixtureId}
                    id={`external-play-flagged-${b.fixtureId}`}
                    data-testid={`external-play-flagged-${b.fixtureId}`}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-[#e7e3f3] bg-[#faf8ff] p-3 lg:p-3.5"
                  >
                    <span className={`text-xs ${MUTED}`}>
                      {where({ roundNo: b.roundNo, boardNo: b.boardNo, stageName: b.stageName }, f)} · {boardStateWord(b.state, f)}
                    </span>
                    <Names white={b.white.name} black={b.black.name} f={f} />
                    {b.flags.map((flag) => (
                      <FlagCard key={flag.id} flag={flag} f={f} />
                    ))}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                      <button
                        type="button"
                        data-testid="external-play-go-on"
                        disabled={busy}
                        aria-busy={(decision.busy?.kind === "goOn" && decision.busy.boardId === b.fixtureId) || undefined}
                        onClick={() => {
                          on(b.fixtureId, over);
                          void runner.goOn(
                            b.fixtureId,
                            b.flags.map((x) => x.id),
                          );
                        }}
                        className={BUTTON_QUIET}
                      >
                        {over ? f.t("externalPlay.queue.markReviewed") : f.t("arbiter.decide.goOn")}
                      </button>
                    </div>
                    {rowNotice(b.fixtureId, decision, over, f)}
                  </li>
                );
              })}
            </ul>
            {ownFlagged > 0 && <p className={`m-0 text-[13px] ${MUTED}`}>{f.plural("externalPlay.queue.ownFlagged", ownFlagged)}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
