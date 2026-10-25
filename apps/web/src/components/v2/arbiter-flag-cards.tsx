// The arbiter's flag cards (T15) and their formatter, shared by the arbiter
// panel and the organiser queue (T16), so a flag, a board's state, a settle
// button and a decision's answer read the same wherever an organiser meets
// them. The flag cards are evidence only: nothing in them decides.
import { useMemo } from "react";
import { useLocale, usePlural, useT } from "@/components/i18n/dict-provider";
import { fullMoveOf, timelineSegments, type ArbiterBoard, type ArbiterFlag, type CameraOffReport, type NoResultOffer } from "@/lib/arbiter-view";
import { formatTimeOfDay } from "@/components/public-site/match-room/room-time";
import type { ArbiterNotice, SettleChoice } from "./arbiter-decision";
import { extendBoardSentence, extendedNoticeTime, extendFailureText } from "./checkin-extend-ui";

export const MUTED = "text-[#6b5b8a]";
export const SOFT = "text-[#4a3a6b]";
/** The panel's clock face: Barlow, tabular numerals. For the check-in countdown, the seat clocks and the tally's numbers only - it
 *  lives here (not in arbiter-panel.tsx) so the round column can read it without importing the panel that mounts the column. */
export const CLOCK_FACE = "[font-family:var(--font-barlow,var(--font-geist-sans))] font-semibold tabular-nums";
// T17B fix 2 (D7): the hand on every button (Tailwind v4 preflight gives <button> the arrow); never on a disabled one.
export const BUTTON_QUIET =
  "min-h-11 cursor-pointer rounded-[10px] border border-[#c9bdf0] bg-white px-3 text-[15px] font-semibold text-[#2e1065] disabled:cursor-not-allowed disabled:opacity-60";
const CHIP = "self-start rounded-full px-2.5 py-[3px] text-xs font-semibold";
export const CHIP_AMBER = `${CHIP} bg-[#fef3c7] text-[#713f12]`;
export const CHIP_NEUTRAL = `${CHIP} bg-[#f3effc] text-[#4a3a6b]`;
export const CARD = "flex flex-col gap-1.5 rounded-xl border bg-white p-3";

export type Fmt = {
  t: ReturnType<typeof useT>;
  plural: ReturnType<typeof usePlural>;
  locale: string;
  mounted: boolean;
  /** "19:42", or null before mount. */
  hm(iso: string): string | null;
  /** "19:31:05", or null before mount. */
  hms(iso: string): string | null;
  duration(seconds: number): string;
  list(items: string[]): string;
};

export function useFmt(nowMs: number | null): Fmt {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const mounted = nowMs !== null;
  return useMemo<Fmt>(() => {
    const hmsFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    return {
      t,
      plural,
      locale,
      mounted,
      hm: (iso) => (mounted ? formatTimeOfDay(iso, locale) : null),
      hms: (iso) => (mounted ? hmsFmt.format(new Date(iso)) : null),
      duration: (raw) => {
        const s = Math.max(0, Math.round(raw));
        if (s < 60) return t("arbiter.duration.sec", { sec: s });
        const min = Math.floor(s / 60);
        const sec = s % 60;
        return sec === 0 ? t("arbiter.duration.min", { min }) : t("arbiter.duration.minSec", { min, sec });
      },
      list: (items) => new Intl.ListFormat(locale, { type: "conjunction" }).format(items),
    };
  }, [t, plural, locale, mounted]);
}

export function FlagCard({ flag, f }: { flag: ArbiterFlag; f: Fmt }) {
  const someone = (n: string | null) => n ?? f.t("arbiter.flag.aPlayer");
  switch (flag.kind) {
    case "out_of_band_play": {
      const found = f.hm(flag.at);
      let sentence: string;
      if (flag.plies === null) sentence = f.t("arbiter.flag.outOfBand.unread");
      else {
        const count = flag.plies.to - flag.plies.from + 1;
        const from = fullMoveOf(flag.plies.from);
        const to = fullMoveOf(flag.plies.to);
        sentence =
          from === to
            ? f.plural("arbiter.flag.outOfBand.single", count, { move: from })
            : f.plural("arbiter.flag.outOfBand.range", count, { from, to });
      }
      return (
        <article className={`${CARD} border-[#f5d27a]`}>
          <span className={CHIP_AMBER}>{f.t("arbiter.flag.outOfBand.chip")}</span>
          <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{sentence}</p>
          {found && <span className={`text-xs ${MUTED}`}>{f.t("arbiter.flag.foundAt", { time: found })}</span>}
        </article>
      );
    }
    case "camera_lost":
      return <CameraReportCard flag={flag} f={f} />;
    case "camera_connection_problems":
      return (
        <article className={`${CARD} border-[#e7e3f3]`}>
          <span className={CHIP_NEUTRAL}>
            {flag.seconds === null
              ? f.t("arbiter.flag.connection.chipPlain")
              : f.t("externalPlay.flag.cameraConnectionProblems", { duration: f.duration(flag.seconds) })}
          </span>
          <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">
            {flag.stamps === null
              ? f.t("arbiter.flag.connection.unread", { name: someone(flag.personName) })
              : f.plural("arbiter.flag.connection.body", flag.stamps, { name: someone(flag.personName) })}
          </p>
        </article>
      );
    case "multiple_devices":
      return <DevicesCard flag={flag} f={f} />;
  }
}

/** T17B fix 2, D9: the player was connected from more than one place at the same time in the match — evidence about
 *  the player (amber, as camera_lost is), never a block: the camera on one device says nothing about the others. */
function DevicesCard({ flag, f }: { flag: Extract<ArbiterFlag, { kind: "multiple_devices" }>; f: Fmt }) {
  const name = flag.personName ?? f.t("arbiter.flag.aPlayer");
  const r = flag.report;
  if (r === null) {
    return (
      <article className={`${CARD} border-[#f5d27a]`}>
        <span className={CHIP_AMBER}>{f.t("arbiter.flag.devices.chipPlain")}</span>
        <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{f.t("arbiter.flag.devices.unread", { name })}</p>
      </article>
    );
  }
  const spans = r.intervals.map((iv) => {
    const from = f.hms(iv.from);
    const to = f.hms(iv.to);
    return from && to ? f.t("arbiter.flag.cameraOff.span", { from, to }) : null;
  });
  const allTimed = spans.length > 0 && spans.every((x): x is string => x !== null);
  return (
    <article className={`${CARD} border-[#f5d27a]`}>
      <span className={CHIP_AMBER}>{f.t("arbiter.flag.devices.chip", { count: r.devices })}</span>
      <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">
        {allTimed
          ? f.t("arbiter.flag.devices.spans", { name, count: r.devices, spans: f.list(spans as string[]) })
          : f.t("arbiter.flag.devices.count", { name, count: r.devices })}{" "}
        {f.t("arbiter.flag.devices.why")}
      </p>
    </article>
  );
}

export function CameraReportCard({ flag, f }: { flag: Extract<ArbiterFlag, { kind: "camera_lost" }>; f: Fmt }) {
  const name = flag.personName ?? f.t("arbiter.flag.aPlayer");
  const r: CameraOffReport | null = flag.report;
  if (r === null) {
    return (
      <article className={`${CARD} border-[#f5d27a]`}>
        <span className={CHIP_AMBER}>{f.t("arbiter.flag.cameraOff.chipPlain")}</span>
        <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{f.t("arbiter.flag.cameraOff.unread", { name })}</p>
      </article>
    );
  }
  const spans = r.intervals.map((iv) => {
    const from = f.hms(iv.from);
    const to = f.hms(iv.to);
    return from && to ? f.t("arbiter.flag.cameraOff.span", { from, to }) : null;
  });
  const allTimed = spans.every((s): s is string => s !== null);
  const agree = r.intervals.every((iv) => iv.confirmedByEvents);
  const segments = timelineSegments({ windowFrom: flag.windowFrom, windowSeconds: r.windowSeconds, intervals: r.intervals });
  const start = flag.windowFrom ? f.hm(flag.windowFrom) : null;
  const end = flag.windowFrom ? f.hm(new Date(Date.parse(flag.windowFrom) + r.windowSeconds * 1000).toISOString()) : null;
  const sessions = f.plural("arbiter.flag.cameraOff.sessions", r.sessions);
  return (
    <article className={`${CARD} gap-2 border-[#f5d27a] p-3 lg:p-3.5`}>
      <span className={CHIP_AMBER}>{f.t("arbiter.flag.cameraOff.chip", { off: f.duration(r.offSeconds), window: f.duration(r.windowSeconds) })}</span>
      <p className="m-0 text-[13px] leading-[1.5] lg:text-sm">
        {allTimed && <>{f.t("arbiter.flag.cameraOff.spans", { name, spans: f.list(spans as string[]) })} </>}
        {agree && <>{f.t("arbiter.flag.cameraOff.agree")} </>}
        {f.plural("arbiter.flag.cameraOff.connections", r.connections, { sessions })}
      </p>
      {segments.length > 0 && (
        <div aria-hidden="true" className="relative h-2.5 overflow-hidden rounded-[5px] bg-[#dcfce7] lg:h-3 lg:rounded-md">
          {segments.map((s, i) => (
            <span key={i} className="absolute top-0 bottom-0 bg-[#b45309]" style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }} />
          ))}
        </div>
      )}
      {start && end && (
        <div className={`flex justify-between text-[11px] lg:text-xs ${MUTED}`}>
          <span>
            <span className="lg:hidden">{f.t("arbiter.flag.timeline.start", { time: start })}</span>
            <span className="max-lg:hidden">{f.t("arbiter.flag.timeline.firstMove", { time: start })}</span>
          </span>
          <span>
            <span className="lg:hidden">{f.t("arbiter.flag.timeline.end", { time: end })}</span>
            <span className="max-lg:hidden">{f.t("arbiter.flag.timeline.gameOver", { time: end })}</span>
          </span>
        </div>
      )}
    </article>
  );
}

export function boardStateWord(state: ArbiterBoard["state"], f: Fmt): string {
  switch (state.kind) {
    case "live":
      return f.t("arbiter.state.live");
    case "checking_in":
      return f.t("arbiter.state.checkingIn");
    case "starting":
      return f.t("arbiter.state.starting");
    case "on_hold":
      return f.t("arbiter.state.onHold");
    case "result":
      return state.noResult ? f.t("arbiter.state.noResult") : (state.score ?? f.t("arbiter.state.over"));
    case "cancelled":
      return f.t("arbiter.state.cancelled");
  }
}

/** What an answered decision request says, by its notice (arbiter-decision.ts). */
/** `over`: the board's game is over, so a close was a REVIEW, never a go-on (R4, T16 fix round 1) — the panel and the
 *  queue both say so in the queue's words. `liveDeadlineAt`: the board's deadline as the screen reads it NOW, so an "extended" answer
 *  never names a time that differs from the board's own "Check-in closes" line (spec §3.2.2). */
export function noticeSentence(n: ArbiterNotice, f: Fmt, over = false, liveDeadlineAt: string | null = null): string {
  switch (n.kind) {
    case "resynced":
      return n.adopted === 0 ? f.t("arbiter.notice.resyncedNone") : f.plural("arbiter.notice.resynced", n.adopted);
    case "resync_nothing":
      return f.t("arbiter.notice.resyncNothing");
    case "resync_failed":
      // A player's stored Lichess access that cannot be opened is an operator fault on our side (reconcile's 503,
      // passed through by resyncExternalPlay): a retry does not fix it.
      return n.code === "LICHESS_TOKEN_UNAVAILABLE" ? f.t("arbiter.notice.resyncTokenUnavailable") : f.t("arbiter.notice.resyncFailed");
    case "went_on":
      if (over) return n.stillOpen === 0 ? f.t("externalPlay.queue.reviewed") : f.plural("externalPlay.queue.reviewedNew", n.stillOpen);
      return n.stillOpen === 0 ? f.t("arbiter.notice.wentOn") : f.plural("arbiter.notice.wentOnNew", n.stillOpen);
    case "go_on_failed":
      return n.code === "ARBITER_PLAYS_THIS_BOARD" ? f.t("arbiter.notice.goOnOwnBoard") : f.t("arbiter.notice.failed");
    case "settled":
      return n.status === "tiebreak_owed" ? f.t("arbiter.notice.settledTiebreak") : f.t("arbiter.notice.settled");
    case "settle_failed":
      return n.code === "ALREADY_RESOLVED"
        ? f.t("arbiter.notice.alreadyResolved")
        : n.code === "BOARD_CHANGED"
          ? f.t("arbiter.notice.boardChanged")
          : n.code === "ONLINE_GAME_OVER"
            ? f.t("arbiter.notice.onlineGameOver")
            : n.code === "ONLINE_GAME_NEVER_STARTED"
              ? f.t("arbiter.notice.onlineGameNeverStarted")
              : n.code === "TIEBREAK_NEEDS_WINNER"
                ? f.t("arbiter.notice.needsWinner")
                : n.code === "ARBITER_PLAYS_THIS_BOARD"
                  ? f.t("arbiter.notice.settleOwnBoard")
                  : // I-3's two 409s: No result where it is refused (a screen loaded before the board's stage or hold changed).
                    n.code === "KNOCKOUT_NEEDS_WINNER"
                    ? f.t("arbiter.notice.knockoutNeedsWinner")
                    : n.code === "SWISS_NEEDS_RESULT"
                      ? f.t("arbiter.notice.swissNeedsResult")
                      : // M-7: the screen's No result / double walkover is no longer the board's (who turned up changed).
                        n.code === "NO_RESULT_CHANGED"
                        ? f.t("arbiter.notice.noResultChanged")
                        : f.t("arbiter.notice.failed");
    case "extended":
      return extendBoardSentence(n.result, n.boardNo, f, liveDeadlineAt);
    case "extend_failed":
      return extendFailureText(n.code, f);
    case "overridden":
      return f.t("arbiter.notice.overridden");
    case "override_failed":
      return n.code === "FIXTURE_NOT_PLAYABLE"
        ? f.t("arbiter.notice.notPlayable")
        : n.code === "VIDEO_NOT_REQUIRED"
          ? f.t("arbiter.notice.notRequired")
          : n.code === "ARBITER_PLAYS_THIS_BOARD"
            ? f.t("arbiter.notice.ownBoard")
            : f.t("arbiter.notice.failed");
  }
}

/** An "extended" answer says when check-in now closes. On a ticking clock that time arrives: from the instant it does, the sentence
 *  would say "Check-in now closes 19:55" about a moment already past, so the panel stops showing it (the board's own line has already
 *  turned into the reason "Can't extend check-in: it has closed"). The time is the one the sentence names - the later of the press's and the board's
 *  live deadline - so the two never part. Every other notice stays until the arbiter's next action replaces it. Not before the
 *  viewer's clock is known (`nowMs` null). */
export function noticeLapsed(n: ArbiterNotice, liveDeadlineAt: string | null, nowMs: number | null): boolean {
  if (n.kind !== "extended" || nowMs === null) return false;
  return nowMs >= Date.parse(extendedNoticeTime(n.result.deadlineAt, liveDeadlineAt));
}

/** The settle buttons, by colour as the panel and the queue name the
 *  players; the server settles by side. A drawn knockout game takes a winner
 *  only (spec §3.6). The choice in place of a winner is the server's own
 *  reading, carried on the row (`noResultOffer`, I-3): "No result" where the
 *  void is offered; where both players stayed away, W2b's double walkover by
 *  its own name and its own kind (`double_walkover`, fix round 4 M-7: the
 *  server refuses the other one) — `wide`, a row of its own, so the longer
 *  label is never cut (fix round 3); nothing where it is refused. */
export function settleChoices(
  board: { whiteSide: "home" | "away"; whiteName: string; blackName: string; tiebreakOwed: boolean; noResultOffer: NoResultOffer },
  f: Fmt,
): { choice: SettleChoice; label: string; wide?: true }[] {
  const white: SettleChoice = board.whiteSide === "home" ? "home_wins" : "away_wins";
  const black: SettleChoice = board.whiteSide === "home" ? "away_wins" : "home_wins";
  if (board.tiebreakOwed) {
    return [
      { choice: white, label: f.t("externalPlay.settle.goesThrough", { name: board.whiteName }) },
      { choice: black, label: f.t("externalPlay.settle.goesThrough", { name: board.blackName }) },
    ];
  }
  return [
    { choice: white, label: f.t("externalPlay.settle.wins", { name: board.whiteName }) },
    { choice: black, label: f.t("externalPlay.settle.wins", { name: board.blackName }) },
    { choice: "draw", label: f.t("externalPlay.resolve.draw") },
    ...(board.noResultOffer.kind === "void"
      ? [{ choice: "no_result" as const, label: f.t("externalPlay.resolve.noResult") }]
      : board.noResultOffer.kind === "double_walkover"
        ? [{ choice: "double_walkover" as const, label: f.t("externalPlay.resolve.doubleWalkover"), wide: true as const }]
        : []),
  ];
}

/** The sentence said where a refused "No result" would have been, by why it is refused. */
export const SETTLE_GUIDANCE_KEY = {
  knockout: "arbiter.decide.knockoutNeedsWinner",
  swiss: "arbiter.decide.swissNeedsResult",
} as const;

/** Why "No result" is missing — only where it would otherwise be offered (a
 *  tie-break never offers it); null when nothing is missing. */
export function settleGuidance(board: { tiebreakOwed: boolean; noResultOffer: NoResultOffer }): keyof typeof SETTLE_GUIDANCE_KEY | null {
  return board.noResultOffer.kind === "refused" && !board.tiebreakOwed ? board.noResultOffer.why : null;
}
