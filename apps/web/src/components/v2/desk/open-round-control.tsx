"use client";

// T16 (D12, canvas OpenRoundPhone / OpenRoundConfirmPhone / OpenRoundDesktop) - what the organiser reads when a round is opened:
// the confirmation's body (how many players and which pairings the press reaches), the invite state of each pairing, the
// check-in groups of a staggered round, and the words of the open's and the resend's answers. The CONTROL that used to mount
// these on each stage card is gone (phase 2, spec 2026-10-24-arbiter-round-column-design.md §8): the round is opened in the Arbiter
// Panel's column (arbiter/round-column.tsx), which reads the very same helpers from here, so the two never word a press differently.
//
// What a press will do (`round.press`) is the reader's prediction of the server's own decision (open-round-view.ts), so nothing
// offers a press the server refuses as already open. The counts here are of the UNINVITED - never "is anyone invited?" - so a
// pairing that arrives after the open is still offered (recurring failure class 13) and nobody is invited twice.
//
// Offered only while the club is offered online chess (T20: an open STARTS play); the page decides that, not these helpers.
// One DOM, mobile-first: `min-w-0` down every name.
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import { SEAT_WORD_KEYS, seatWords } from "@/lib/invite-status";
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
import { useVenueClock } from "../venue-clock";
import type { OpenRoundNotice, ResendNotice } from "./open-round-state";

type Msg = ReturnType<typeof useMsg>;
type Plural = ReturnType<typeof useMsgPlural>;

const INK = "text-[#2e1065]";
const MUTED = "text-[#6b5b8a]";
const SOFT = "text-[#4a3a6b]";

export const owedPlayers = (round: OpenRoundView) => round.pairings.reduce((n, p) => n + p.owedSeats, 0);

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

/** One pairing's invite state, in words: "Not invited", "Invited 19:04", partly, or past inviting. `clock` reads an instant in the
 *  venue's zone (`useVenueClock`), naming it when the viewer is elsewhere. */
export function inviteState(p: OpenRoundPairing, clock: (iso: string) => string, msg: Msg, plural: Plural) {
  if (p.invitedAt === null) {
    return p.owedSeats > 0 ? msg("runsheet.round.notInvited") : msg("runsheet.round.noInviteOwed");
  }
  return (
    <>
      {msg("runsheet.round.invited")}{" "}
      <time dateTime={p.invitedAt}>{clock(p.invitedAt)}</time>
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
 *  draws nothing and the hero's one clock (the next board to close) stays the truth. Both are reached by open-round-control.test.tsx. */
export function timedBatches(round: OpenRoundView): (OpenRoundBatch & { opensAt: string; closesAt: string })[] | null {
  if (round.press === "reopen" || !round.staggered || round.batches.length < 2) return null;
  const timed = round.batches.flatMap((b) => (b.opensAt !== null && b.closesAt !== null ? [{ ...b, opensAt: b.opensAt, closesAt: b.closesAt }] : []));
  return timed.length === round.batches.length ? timed : null;
}

/** The seats of the boards the round column lists, by fixture id (`ArbiterBoard.seats`): the waiting list's own source. */
export type BoardSeats = ReadonlyMap<string, ArbiterBoard["seats"]>;

/** One pairing's seats in the words the waiting list uses (Task 16 D2): "White: Here · Black: Not delivered". `seatWords` is the one
 *  helper both read, so the two can never word a seat two ways. Null when the board has no seat to read, or neither seat has a word
 *  to give: the caller then keeps the stamp line (`inviteState`), which is all it knows. */
function seatsLine(p: OpenRoundPairing, seats: BoardSeats | undefined, msg: Msg) {
  const board = seats?.get(p.fixtureId) ?? null;
  if (board === null) return null;
  const parts = (["white", "black"] as const).flatMap((colour) => {
    const words = seatWords(board[colour]);
    if (words.length === 0) return [];
    const colourWord = msg(colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black");
    return [
      <span key={colour} data-seat={colour}>
        {msg("arbiter.column.confirmSeat", { colour: colourWord, words: words.map((w) => msg(SEAT_WORD_KEYS[w] as MessageKey)).join(", ") })}
      </span>,
    ];
  });
  if (parts.length === 0) return null;
  return (
    <>
      {parts.flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))}
    </>
  );
}

/** The confirmation's body: who this press reaches and what starts. Exported for its static test. `seats`, where the caller has the
 *  round's boards (the check-in hero), words each seat the way the waiting list does; without it a row reads the stamp line. */
export function OpenRoundConfirmBody({ round, tz, seats }: { round: OpenRoundView; tz: string; seats?: BoardSeats }) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const clock = useVenueClock(tz);
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
              {boardLabel(p, msg)} · {seatsLine(p, seats, msg) ?? inviteState(p, clock, msg, plural)}
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
          ? msg("runsheet.round.confirmWindowReinvite", { time: clock(round.deadlineAt) })
          : round.staggered && round.batches.length > 1
            ? msg("runsheet.round.confirmWindowStaggered", { minutes: round.windowMinutes, span: round.staggerSpanMinutes })
            : msg("runsheet.round.confirmWindow", { minutes: round.windowMinutes })}
      </p>
      {round.press !== "reinvite" && round.scheduledAt !== null && (
        <p>{msg("runsheet.round.confirmScheduled", { time: clock(round.scheduledAt) })}</p>
      )}
    </>
  );
}

export function openNoticeText(n: OpenRoundNotice, round: OpenRoundView, msg: Msg, plural: Plural): string[] {
  if (n.kind === "failed") {
    if (n.code === ONLINE_CHESS_DISABLED_CODE) return [msg("runsheet.round.err.disabled")];
    if (n.code === "ROUND_CHANGED") return [msg("runsheet.round.err.roundChanged")];
    if (n.code === "ROUND_NOT_ONLINE") return [msg("runsheet.round.err.notOnline")];
    return [msg("runsheet.round.err.failed")];
  }
  const r = n.result;
  if (r.opened === false && r.reason !== "already_open") return [msg(OPEN_ROUND_REFUSAL_KEYS[r.reason] as MessageKey)];
  // An invite still sending is not "0 invited": when the open reached nobody yet but queued some, the count of the invited is left
  // out (it would read as a failure) and the sending line stands alone. With nothing queued the old count stays, however small.
  const sending = r.opened ? r.retrying : 0;
  const head = r.opened
    ? [...(r.invited > 0 || sending <= 0 ? [plural(OPEN_ROUND_INVITED_KEY, r.invited)] : []), ...(sending > 0 ? [plural("runsheet.round.sending", sending)] : [])]
    : [msg(OPEN_ROUND_ALREADY_OPEN_KEY as MessageKey)];
  const boardOf = (fixtureId: string) => {
    const p = round.pairings.find((x) => x.fixtureId === fixtureId);
    return p ? boardLabel(p, msg) : fixtureId;
  };
  return [
    ...head,
    ...r.skipped.map((s) =>
      msg("runsheet.round.skipLine", { board: boardOf(s.fixtureId), reason: msg(OPEN_ROUND_SKIP_KEYS[s.reason] as MessageKey) }),
    ),
  ];
}

export function resendNoticeText(n: ResendNotice, msg: Msg, plural: Plural): string {
  if (n.kind === "resent") {
    // Both facts when both are true; "could not be sent" only when nothing went out AND nothing is waiting to.
    const lines = [
      ...(n.emailed > 0 ? [plural("runsheet.round.resent", n.emailed)] : []),
      ...(n.retrying > 0 ? [plural("runsheet.round.sending", n.retrying)] : []),
    ];
    return lines.length > 0 ? lines.join(" ") : msg("runsheet.round.resentNone");
  }
  if (n.code === "WINDOW_CLOSED" || n.code === "BOARD_HELD") return msg(RESEND_REFUSAL_KEYS[n.code] as MessageKey);
  if (n.code === ONLINE_GAME_EXISTS_CODE) return msg("externalPlay.resend.gameExists");
  if (n.code === "ROUND_CHANGED") return msg("externalPlay.resend.roundChanged");
  if (n.code === ONLINE_CHESS_DISABLED_CODE) return msg("runsheet.round.err.disabled");
  return msg("runsheet.round.resendFailed");
}
