// T16 fix round 1, I4 — the watch panel's pieces around the board, built to
// the approved canvas (WatchDesktop, WatchStatesDesktop, WatchFinishedPhone):
// the move list, Match details, the finished board's result header, the
// status line above the board (owner ruling 2026-10-13, option B: the start
// position from the round's open, "Waiting for White's first move"), and the
// cards that say why there is no live board (a hold, an unopened round). Hookless and `t`-driven, so each renders bare in a node test.
// Spectator-safe by construction: they read the public doc and the page's own
// public facts — no token, no room path, no Lichess link.
import type { ReactNode } from "react";
import { BoardgameMethod } from "@seazn/engine/sports/boardgame";
import type { PublicGameResult, PublicHold } from "@/server/external-play/public-view";
import { spokenClock, type RoomPlural, type RoomT } from "../match-room/room-copy";

const METHODS: ReadonlySet<string> = new Set(BoardgameMethod.options);

/** "14:05", or "Thu 16 Oct, 19:00" with the day, in the VENUE's zone (one zone per fixture). */
export function formatWatchTime(iso: string, timeZone: string, locale: string, withDay: boolean): string {
  const opts: Intl.DateTimeFormatOptions = withDay
    ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
  }
}

/** A moment this panel can print: a public page must never 500 on one it cannot read — the row is left out. */
function readable(iso: string | null | undefined): iso is string {
  return typeof iso === "string" && !Number.isNaN(Date.parse(iso));
}

/** The move a ply is written as: "30. Rd8#" for White's, "30… Kh8" for Black's. */
export function moveLabel(ply: number, san: string): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}. ${san}` : `${n}… ${san}`;
}

const NOTE_ICON: Record<NoteKind, { stroke: string; path: ReactNode }> = {
  not_opened: {
    stroke: "#7c3aed",
    path: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
  tiebreak: {
    stroke: "#b45309",
    path: (
      <>
        <path d="M8 5v14" />
        <path d="M16 5v14" />
      </>
    ),
  },
  confirm: {
    stroke: "#6b5b8a",
    path: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
};

type NoteKind = "not_opened" | PublicHold;

const NOTE_COPY: Record<NoteKind, { title: string; body: string; testid: string }> = {
  not_opened: { title: "externalPlay.watch.notOpenedTitle", body: "externalPlay.watch.notOpened", testid: "watch-not-opened" },
  tiebreak: { title: "externalPlay.watch.hold.tiebreakTitle", body: "externalPlay.watch.hold.tiebreakBody", testid: "watch-hold" },
  confirm: { title: "externalPlay.watch.hold.confirmTitle", body: "externalPlay.needsOrganiser", testid: "watch-hold" },
};

/** What the board is waiting for: the first move (from the round's open), then whose move it is. */
export type WatchStatusKind = "waiting" | "white" | "black";

const STATUS_COPY: Record<WatchStatusKind, string> = {
  waiting: "externalPlay.watch.status.waiting",
  white: "externalPlay.watch.status.whiteToMove",
  black: "externalPlay.watch.status.blackToMove",
};

/** The one line above the board while the game is to be played. One slot for every kind, one line high, so the
 *  first move swaps its words and nothing below it moves; as wide as the board's column (WatchBoard's own
 *  `max-w-[560px]`, centred below lg), so it starts where the board starts. The marker is the colour to move — a hollow disc for
 *  White, a filled one for Black — and, while it waits for the first move, it pulses (motion-safe only). */
export function WatchStatus({ kind, t }: { kind: WatchStatusKind; t: RoomT }) {
  const black = kind === "black";
  return (
    <p
      data-testid="watch-status"
      data-kind={kind}
      aria-live="polite"
      className="mx-auto my-0 flex min-h-6 w-full min-w-0 max-w-[560px] items-center gap-2 text-sm font-semibold leading-6 text-[#2e1065] lg:mx-0"
    >
      <span
        aria-hidden="true"
        className={`size-2.5 shrink-0 rounded-full border-2 border-[#2e1065] ${black ? "bg-[#2e1065]" : "bg-white"} ${
          kind === "waiting" ? "motion-safe:animate-pulse" : ""
        }`}
      />
      <span className="min-w-0 truncate">{t(STATUS_COPY[kind] as never)}</span>
    </p>
  );
}

/** The card that says why there is no live board to watch — never an empty board. */
export function WatchNote({ kind, t }: { kind: NoteKind; t: RoomT }) {
  const copy = NOTE_COPY[kind];
  const icon = NOTE_ICON[kind];
  const held = kind === "tiebreak" || kind === "confirm";
  return (
    <div
      data-testid={copy.testid}
      {...(held ? { "data-hold": kind } : {})}
      className={`flex min-w-0 gap-3 rounded-xl border p-4 ${
        kind === "tiebreak" ? "border-[#f5d27a] bg-[#fffbeb]" : "border-[#e7e3f3] bg-[#fdfcf8]"
      }`}
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke={icon.stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-0.5 shrink-0"
      >
        {icon.path}
      </svg>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="m-0 text-base font-semibold leading-snug text-[#2e1065]">{t(copy.title as never)}</h3>
        <p className="m-0 text-sm leading-relaxed text-[#4a3a6b]">{t(copy.body as never)}</p>
      </div>
    </div>
  );
}

/** The game's moves, two plies a row, the last one marked (the canvas's amber). Newest at the bottom, and the
 *  scroll anchored there (`flex-col-reverse`), so a long game shows its latest moves without a script. */
export function WatchMoves({ moves, t }: { moves: readonly string[]; t: RoomT }) {
  if (moves.length === 0) return null;
  const rows: { n: number; white: string; black: string | null }[] = [];
  for (let i = 0; i < moves.length; i += 2) rows.push({ n: i / 2 + 1, white: moves[i]!, black: moves[i + 1] ?? null });
  const last = moves.length - 1;
  const ply = (san: string, index: number) =>
    index === last ? (
      <span data-testid="watch-move-last" className="justify-self-start rounded px-1 font-semibold text-[#713f12] bg-[#fef3c7]">
        {san}
      </span>
    ) : (
      <span className="min-w-0 px-1">{san}</span>
    );
  return (
    <div data-testid="watch-moves" className="min-w-0 rounded-[14px] border border-[#e7e3f3] bg-white px-4 py-3">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-[#6b5b8a]">{t("externalPlay.watch.moves")}</h3>
      <div
        role="region"
        aria-label={t("externalPlay.watch.moves")}
        tabIndex={0}
        className="mt-2 flex max-h-56 min-w-0 flex-col-reverse overflow-y-auto rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed]"
      >
        <ol className="m-0 grid list-none grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 gap-y-1 p-0 text-sm tabular-nums text-[#2e1065]">
          {rows.map((r, i) => (
            <li key={r.n} className="contents">
              <span className="text-[#6b5b8a]">{r.n}.</span>
              {ply(r.white, 2 * i)}
              {r.black === null ? <span /> : ply(r.black, 2 * i + 1)}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export type WatchDetailsFacts = {
  scheduledAt: string | null;
  roundOpenedAt: string | null;
  clock: { limitSeconds: number; incrementSeconds: number } | null;
  timeZone: string;
  locale: string;
};

/** Match details (canvas aside): when it was scheduled, when the round opened, the time control, where it is
 *  played. A fact the page does not have is left out, never shown blank. */
export function WatchDetails({ facts, t, plural }: { facts: WatchDetailsFacts; t: RoomT; plural: RoomPlural }) {
  const rows: [string, string, string][] = [];
  if (readable(facts.scheduledAt)) {
    rows.push(["scheduled", t("externalPlay.watch.details.scheduled"), formatWatchTime(facts.scheduledAt, facts.timeZone, facts.locale, true)]);
  }
  if (readable(facts.roundOpenedAt)) {
    rows.push(["round-opened", t("externalPlay.watch.details.roundOpened"), formatWatchTime(facts.roundOpenedAt, facts.timeZone, facts.locale, false)]);
  }
  if (facts.clock !== null) {
    rows.push(["time-control", t("externalPlay.watch.details.timeControl"), spokenClock(facts.clock.limitSeconds, facts.clock.incrementSeconds, plural)]);
  }
  rows.push(["played", t("externalPlay.watch.details.played"), t("externalPlay.watch.details.online")]);
  return (
    <div data-testid="watch-details" className="flex min-w-0 flex-col gap-2 border-t border-[#e7e3f3] pt-3">
      <h3 className="m-0 text-[15px] font-semibold text-[#2e1065]">{t("externalPlay.watch.details.title")}</h3>
      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([key, label, value]) => (
          <div key={key} data-detail={key} className="contents">
            <dt className="text-[#6b5b8a]">{label}</dt>
            <dd className="m-0 min-w-0 text-[#2e1065] [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The finished board's header (canvas WatchFinishedPhone): who won, how and on which move, and the score, White
 *  first. With no result on the fixture yet it says the game is over and nothing more. */
export function WatchResult({
  result,
  names,
  ply,
  t,
}: {
  result: PublicGameResult | null;
  names: { home: string; away: string };
  ply: number;
  t: RoomT;
}) {
  const title =
    result === null
      ? t("externalPlay.watch.result.over")
      : result.kind === "win"
        ? t("externalPlay.watch.result.won", { name: result.winner === "away" ? names.away : names.home })
        : result.kind === "draw"
          ? t("externalPlay.watch.result.draw")
          : t("externalPlay.watch.result.noResult");
  const parts: string[] = [];
  if (result?.method != null && METHODS.has(result.method)) parts.push(t(`method.${result.method}` as never));
  if (ply > 0) parts.push(t("externalPlay.watch.result.move", { move: Math.ceil(ply / 2) }));
  const score = result?.score ?? "";
  return (
    <div
      data-testid="watch-result"
      data-kind={result?.kind ?? "none"}
      className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-[#2e1065] px-4 py-3 text-white"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{title}</h3>
        {parts.length > 0 ? <span className="text-[13px] text-[#ddd3f7]">{parts.join(" · ")}</span> : null}
      </div>
      {score !== "" ? <span className="shrink-0 font-display text-[32px] font-bold leading-none tabular-nums">{score}</span> : null}
    </div>
  );
}
