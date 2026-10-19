"use client";

// T16 (D12, canvas OpenRoundPhone / OpenRoundConfirmPhone / OpenRoundDesktop)
// — the organiser opens an online round. A round is PAIRED automatically and
// OPENED by hand: until then nobody is invited and nobody can take a seat.
// This control states which (paired, open, still owed), lists every pairing
// with whether its invite went out and when, and opens the round only after a
// confirmation that says how many players and which pairings it reaches.
//
// What a press will do (`round.press`) is the reader's prediction of the
// server's own decision (open-round-view.ts), so the control never offers a
// press the server refuses as already open. It counts the UNINVITED — never
// "is anyone invited?" — so a pairing that arrives after the open is still
// offered (recurring failure class 13) and nobody is invited twice.
//
// Rendered by the stage card only while the club is offered online chess
// (T20: an open STARTS play); the page decides that, not this component.
// One DOM, mobile-first: one column, `min-w-0` down every name, 44px targets.
import { useMemo, useReducer } from "react";
import { useRouter } from "next/navigation";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { fmtTime } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { ONLINE_CHESS_DISABLED_CODE } from "@/lib/online-chess";
import {
  ONLINE_GAME_EXISTS_CODE,
  OPEN_ROUND_ALREADY_OPEN_KEY,
  OPEN_ROUND_INVITED_KEY,
  OPEN_ROUND_REFUSAL_KEYS,
  OPEN_ROUND_SKIP_KEYS,
  RESEND_REFUSAL_KEYS,
  type OpenRoundBatch,
  type OpenRoundPairing,
  type OpenRoundView,
} from "@/lib/open-round";
import { ConfirmDialog } from "../confirm-dialog";
import {
  initialOpenRoundUi,
  openRoundRunner,
  openRoundUi,
  type OpenRoundNotice,
  type ResendNotice,
} from "./open-round-state";

type Msg = ReturnType<typeof useMsg>;
type Plural = ReturnType<typeof useMsgPlural>;

const INK = "text-[#2e1065]";
const MUTED = "text-[#6b5b8a]";
const SOFT = "text-[#4a3a6b]";
const BUTTON_PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-[#7c3aed] px-4 text-sm font-semibold text-white hover:bg-[#5b21b6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] focus-visible:ring-offset-2 disabled:opacity-60";
const BUTTON_QUIET =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-[#e7e3f3] bg-white px-3 text-sm font-medium text-[#5b21b6] hover:bg-[#f5f3ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] disabled:opacity-60";

const owedPlayers = (round: OpenRoundView) => round.pairings.reduce((n, p) => n + p.owedSeats, 0);

/** Seats this round's open already invited: two per board minus what it still owes, on the boards with a stamp. */
const alreadyInvitedPlayers = (round: OpenRoundView) =>
  round.pairings.reduce((n, p) => n + (p.invitedAt === null ? 0 : 2 - p.owedSeats), 0);

function names(p: OpenRoundPairing, msg: Msg) {
  return (
    <span className="min-w-0 truncate">
      <span className={`font-medium ${INK}`}>{p.whiteName}</span>
      <span className={`mx-1.5 ${MUTED}`}>{msg("schedule.vs")}</span>
      <span className={`font-medium ${INK}`}>{p.blackName}</span>
    </span>
  );
}

/** One pairing's invite state, in words: "Not invited", "Invited 19:04", partly, or past inviting. */
function inviteState(p: OpenRoundPairing, tz: string, msg: Msg, plural: Plural) {
  if (p.invitedAt === null) {
    return p.owedSeats > 0 ? msg("runsheet.round.notInvited") : msg("runsheet.round.noInviteOwed");
  }
  return (
    <>
      {msg("runsheet.round.invited")}{" "}
      <time dateTime={p.invitedAt}>{fmtTime(tz, p.invitedAt)}</time>
      {p.owedSeats > 0 && <> · {plural("runsheet.round.stillToInvite", p.owedSeats)}</>}
    </>
  );
}

const boardLabel = (p: OpenRoundPairing, msg: Msg) => msg("arbiter.boardNo", { n: p.boardNo });

/** The check-in groups to draw (spec §3.2.1, "What the organiser sees"): a round that staggers over more than one group,
 *  with the times to draw. A single group has one deadline and the "open until" line already says it; an unopened round
 *  has no times yet (`opensAt`/`closesAt` are null, and its span is in the confirmation); a 'reopen' press restamps the
 *  window, so the old times are not the truth. Null means nothing to draw, never an empty list.
 *
 *  A named refusal, not an assumption: `OpenRoundBatch` types each time `string | null` on its own, and the producer
 *  (open-round-view.ts: one open row feeds every batch) never makes a batch with one time and not the other, or a round with
 *  some batches timed and some not - but the type allows both, and a row with a hole in it is worse than no list, so either
 *  draws nothing and the single "open until" line stays the truth. Both are reached by open-round-control.test.tsx. */
function timedBatches(round: OpenRoundView): (OpenRoundBatch & { opensAt: string; closesAt: string })[] | null {
  if (round.press === "reopen" || !round.staggered || round.batches.length < 2) return null;
  const timed = round.batches.flatMap((b) => (b.opensAt !== null && b.closesAt !== null ? [{ ...b, opensAt: b.opensAt, closesAt: b.closesAt }] : []));
  return timed.length === round.batches.length ? timed : null;
}

/** A group's boards: "Boards 11–20", or "Board 21" for a group of one. */
const batchBoards = (b: OpenRoundBatch, msg: Msg) =>
  b.fromBoard === b.toBoard ? msg("arbiter.boardNo", { n: b.fromBoard }) : msg("runsheet.round.batchBoards", { from: b.fromBoard, to: b.toBoard });

/** The confirmation's body: who this press reaches and what starts. Exported for its static test. */
export function OpenRoundConfirmBody({ round, tz }: { round: OpenRoundView; tz: string }) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const owed = owedPlayers(round);
  const already = alreadyInvitedPlayers(round);
  const invitees = round.pairings.filter((p) => p.owedSeats > 0);
  const listLabel = msg("runsheet.round.confirmListLabel");
  return (
    <>
      <p>
        {round.press === "reinvite"
          ? plural("runsheet.round.confirmBodyReinvite", owed)
          : plural("runsheet.round.confirmBody", owed)}
      </p>
      {/* R1 (T16 fix round 1): an earlier round still being played does not stop this open — the organiser drives — but
          it is said before the press, one line per round. */}
      {round.earlierInPlay.length > 0 && (
        <div role="note" data-testid="open-round-earlier" className="flex flex-col gap-0.5 rounded-lg bg-[#fef3c7] px-3 py-2 text-[#713f12]">
          {round.earlierInPlay.map((e) => (
            <span key={e.roundNo} data-earlier-round={e.roundNo}>
              {plural("runsheet.round.confirmEarlierInPlay", e.games, { round: e.roundNo })}
            </span>
          ))}
        </div>
      )}
      {/* A scrolling region a keyboard can reach (AGENTS.md #23): focusable, named. */}
      <ul
        tabIndex={0}
        aria-label={listLabel}
        className="max-h-[40vh] min-w-0 divide-y divide-[#e7e3f3] overflow-y-auto rounded-lg border border-[#e7e3f3]"
      >
        {invitees.map((p) => (
          <li key={p.fixtureId} data-testid={`open-round-invitee-${p.fixtureId}`} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
            {names(p, msg)}
            <span className={`text-xs ${MUTED}`}>
              {boardLabel(p, msg)} · {inviteState(p, tz, msg, plural)}
            </span>
          </li>
        ))}
      </ul>
      {already > 0 && (
        <div role="note" data-testid="open-round-already-note" className={`rounded-lg bg-[#f5f3ff] px-3 py-2 ${SOFT}`}>
          {plural("runsheet.round.reopenNotice", already)}
        </div>
      )}
      <p>
        {round.press === "reinvite" && round.deadlineAt !== null
          ? msg("runsheet.round.confirmWindowReinvite", { time: fmtTime(tz, round.deadlineAt) })
          : round.staggered && round.batches.length > 1
            ? msg("runsheet.round.confirmWindowStaggered", { minutes: round.windowMinutes, span: round.staggerSpanMinutes })
            : msg("runsheet.round.confirmWindow", { minutes: round.windowMinutes })}
      </p>
      {round.press !== "reinvite" && round.scheduledAt !== null && (
        <p>{msg("runsheet.round.confirmScheduled", { time: fmtTime(tz, round.scheduledAt) })}</p>
      )}
    </>
  );
}

function openNoticeText(n: OpenRoundNotice, round: OpenRoundView, msg: Msg, plural: Plural): string[] {
  if (n.kind === "failed") {
    if (n.code === ONLINE_CHESS_DISABLED_CODE) return [msg("runsheet.round.err.disabled")];
    if (n.code === "ROUND_CHANGED") return [msg("runsheet.round.err.roundChanged")];
    if (n.code === "ROUND_NOT_ONLINE") return [msg("runsheet.round.err.notOnline")];
    return [msg("runsheet.round.err.failed")];
  }
  const r = n.result;
  if (r.opened === false && r.reason !== "already_open") return [msg(OPEN_ROUND_REFUSAL_KEYS[r.reason] as MessageKey)];
  const head = r.opened ? plural(OPEN_ROUND_INVITED_KEY, r.invited) : msg(OPEN_ROUND_ALREADY_OPEN_KEY as MessageKey);
  const boardOf = (fixtureId: string) => {
    const p = round.pairings.find((x) => x.fixtureId === fixtureId);
    return p ? boardLabel(p, msg) : fixtureId;
  };
  return [
    head,
    ...r.skipped.map((s) =>
      msg("runsheet.round.skipLine", { board: boardOf(s.fixtureId), reason: msg(OPEN_ROUND_SKIP_KEYS[s.reason] as MessageKey) }),
    ),
  ];
}

function resendNoticeText(n: ResendNotice, msg: Msg, plural: Plural): string {
  if (n.kind === "resent") return n.emailed > 0 ? plural("runsheet.round.resent", n.emailed) : msg("runsheet.round.resentNone");
  if (n.code === "WINDOW_CLOSED" || n.code === "BOARD_HELD") return msg(RESEND_REFUSAL_KEYS[n.code] as MessageKey);
  if (n.code === ONLINE_GAME_EXISTS_CODE) return msg("externalPlay.resend.gameExists");
  if (n.code === "ROUND_CHANGED") return msg("externalPlay.resend.roundChanged");
  if (n.code === ONLINE_CHESS_DISABLED_CODE) return msg("runsheet.round.err.disabled");
  return msg("runsheet.round.resendFailed");
}

export function OpenRoundControl({ round, tz }: { round: OpenRoundView; tz: string }) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const router = useRouter();
  const [state, dispatch] = useReducer(openRoundUi, undefined, initialOpenRoundUi);
  const runner = useMemo(
    () => openRoundRunner({ dispatch, post: (path, body) => apiV1(path, { method: "POST", json: body }), refresh: () => router.refresh() }),
    [router],
  );

  // The reader never sends a round with no pairing (openRound: no_fixtures); a guard, not a comment.
  if (round.pairings.length === 0) {
    return (
      <p className={`px-4 py-3 text-sm ${MUTED}`} data-testid="open-round-empty">
        {msg("externalPlay.openRound.noFixtures")}
      </p>
    );
  }

  // One (stage, round) per control on a page: a stable id, no useId.
  const headingId = `open-round-${round.stageId}-${round.roundNo}`;
  const owed = owedPlayers(round);
  const canPress = round.press !== "none";
  const stateLine =
    round.state === "paired"
      ? msg("runsheet.round.paired")
      : round.press === "reopen"
        ? msg("runsheet.round.reopenState")
        : round.press === "none"
          ? msg(OPEN_ROUND_ALREADY_OPEN_KEY as MessageKey)
          : plural("runsheet.round.owed", owed);
  const title =
    round.press === "reinvite"
      ? msg("runsheet.round.confirmTitleReinvite", { round: round.roundNo })
      : round.press === "reopen"
        ? msg("runsheet.round.confirmTitleReopen", { round: round.roundNo })
        : msg("runsheet.round.confirmTitle", { round: round.roundNo });
  const cta = round.press === "reinvite" ? plural("runsheet.round.inviteCta", owed) : msg("runsheet.round.openCta");
  const confirmLabel = round.press === "reinvite" ? plural("runsheet.round.inviteCta", owed) : plural("runsheet.round.confirmCta", owed);
  const notice = state.notice ? openNoticeText(state.notice, round, msg, plural) : null;
  // Each group has its OWN deadline: group 0's no-shows reach the organiser before the last group has even opened, so a
  // staggered round draws the groups and not the one "open until" line, which could only name the last group's close.
  const batches = timedBatches(round);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="open-round"
      data-state={round.state}
      data-press={round.press}
      data-uninvited-count={owed}
      className="min-w-0 border-t border-[#e7e3f3] px-4 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 id={headingId} className={`text-sm font-semibold ${INK}`}>
          {msg("runsheet.round.heading", { round: round.roundNo })}
        </h4>
        {round.scheduledAt !== null && (
          <time dateTime={round.scheduledAt} className={`text-xs ${MUTED}`}>
            {msg("runsheet.round.scheduled", { time: fmtTime(tz, round.scheduledAt) })}
          </time>
        )}
      </div>
      <p className={`mt-1 text-sm font-medium ${SOFT}`} data-testid="open-round-state">
        {stateLine}
      </p>
      {round.state === "paired" && (
        <p className={`mt-0.5 text-xs ${MUTED}`}>
          {plural("runsheet.round.pairedLede", round.pairings.length, { players: owed })}
        </p>
      )}
      {round.state === "open" && round.deadlineAt !== null && round.press !== "reopen" && batches === null && (
        <p className={`mt-0.5 text-xs ${MUTED}`}>{msg("runsheet.round.openUntil", { time: fmtTime(tz, round.deadlineAt) })}</p>
      )}
      {canPress && (
        <button
          type="button"
          data-testid="open-round-cta"
          disabled={state.busy !== null}
          onClick={() => dispatch({ type: "ask" })}
          className={`${BUTTON_PRIMARY} mt-2 w-full sm:w-auto`}
        >
          {cta}
        </button>
      )}
      {notice !== null && (
        <div role="status" data-testid="open-round-notice" className={`mt-2 space-y-0.5 text-sm ${SOFT}`}>
          {notice.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}

      {batches !== null && (
        <div className="mt-3 min-w-0" data-testid="open-round-batches">
          <p className={`text-xs ${MUTED}`}>{msg("runsheet.round.batchesLede")}</p>
          <ul aria-label={msg("runsheet.round.batchesLabel", { round: round.roundNo })} className="mt-1 min-w-0 divide-y divide-[#e7e3f3] rounded-lg border border-[#e7e3f3] bg-[#faf9ff] px-3">
            {batches.map((b, i) => (
              <li
                key={i}
                data-testid={`open-round-batch-${i}`}
                data-opens-at={b.opensAt}
                data-closes-at={b.closesAt}
                className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
              >
                <span data-field="boards" className={`min-w-28 shrink-0 text-sm font-semibold ${INK}`}>
                  {batchBoards(b, msg)}
                </span>
                <span data-field="opens" className={`text-xs ${SOFT}`}>
                  {msg("runsheet.round.batchOpens", { time: fmtTime(tz, b.opensAt) })}
                </span>
                <span data-field="closes" className={`text-xs ${SOFT}`}>
                  {msg("runsheet.round.batchCloses", { time: fmtTime(tz, b.closesAt) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul aria-label={msg("runsheet.round.pairingsLabel", { round: round.roundNo })} className="mt-3 min-w-0 divide-y divide-[#e7e3f3]">
        {round.pairings.map((p) => {
          const rowNotice = state.rowNotice?.fixtureId === p.fixtureId ? state.rowNotice.notice : null;
          return (
            <li
              key={p.fixtureId}
              data-testid={`open-round-${p.owedSeats > 0 ? "pending" : "already"}-${p.fixtureId}`}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <span className={`w-16 shrink-0 text-xs font-semibold ${MUTED}`}>{boardLabel(p, msg)}</span>
              <span className="flex min-w-0 flex-1 basis-40 text-sm">{names(p, msg)}</span>
              <span className={`text-xs ${MUTED}`}>{inviteState(p, tz, msg, plural)}</span>
              {p.canResend && (
                <button
                  type="button"
                  data-testid={`open-round-resend-${p.fixtureId}`}
                  disabled={state.busy !== null}
                  onClick={() => void runner.resend(p.fixtureId)}
                  className={BUTTON_QUIET}
                >
                  {msg("runsheet.round.resend")}
                </button>
              )}
              {rowNotice !== null && (
                <p role="status" data-testid="open-round-row-notice" className={`basis-full text-xs ${SOFT}`}>
                  {resendNoticeText(rowNotice, msg, plural)}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={state.confirming}
        testId="open-round-confirm"
        title={title}
        confirmLabel={confirmLabel}
        confirmVariant="primary"
        cancelLabel={msg("confirm.cancel")}
        busy={state.busy !== null}
        onConfirm={() => void runner.open(round.stageId, round.roundNo)}
        onCancel={() => dispatch({ type: "cancel" })}
      >
        <OpenRoundConfirmBody round={round} tz={tz} />
      </ConfirmDialog>
    </section>
  );
}
