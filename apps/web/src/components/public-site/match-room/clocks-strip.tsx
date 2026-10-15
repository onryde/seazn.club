// The clocks (canvas: the side to move is the dark card; game over mutes both).
// T17B fix 2, D24 (owner): while the game is LIVE the opponent's clock is a bar
// above the board and the player's a bar below it — by VIEWER, never by colour
// (`ClockBar`, placed by the shell); once a result is shown the pair sits side
// by side above the board again, opponent on the left, "You" on the right
// (`ClocksStrip`). Both are dumb on purpose (Seam A: a seat on hold reads so on YOUR card, never
// "your move", and its clock is not muted — it still runs on Lichess): names arrive resolved from the room usecase, and the
// milliseconds arrive already derived by the shell (clock-math), so a wrong
// name or a wrong time is provable at ONE site, never here.
import { formatClock } from "./clock-math";
import type { Colour } from "./room-snapshot";
import type { RoomT } from "./room-copy";

type Side = { name: string; colour: Colour; ms: number };

/** One side's clock: name and colour on the left, the time on the right, the side to move dark. `extra` sits beside
 *  the time (D24: the player's sound switch). */
function Card({
  testId,
  active,
  over,
  title,
  sub,
  ms,
  truncateTitle,
  extra = null,
  className = "",
}: {
  testId: string;
  active: boolean;
  over: boolean;
  title: string;
  sub: React.ReactNode;
  ms: number;
  truncateTitle: boolean;
  extra?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={`flex min-w-0 items-center justify-between gap-1.5 rounded-[10px] px-2.5 py-2 md:gap-3 md:rounded-xl md:px-4 md:py-2.5 ${
        active ? "bg-[#2e1065] text-white" : "bg-[#f3effc] text-[#2e1065]"
      } ${className}`}
    >
      <div className="flex min-w-0 flex-col">
        <span className={`text-[13px] font-semibold md:text-base ${truncateTitle ? "min-w-0 truncate" : ""}`}>{title}</span>
        <span className={`min-w-0 truncate text-[11px] md:text-[13px] ${active ? "text-[#ddd3f7]" : "text-[#6b5b8a]"}`}>{sub}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        {extra}
        <span
          className={`font-display text-[26px] font-semibold tabular-nums md:text-4xl ${over ? "text-[#6b5b8a]" : ""}`}
        >
          {formatClock(ms)}
        </span>
      </div>
    </div>
  );
}

/** The sub-line of the player's own card: whose move it is, or the colour, or a seat on hold (Seam A). */
function yourSub(a: { colour: Colour; yourMove: boolean; seatOnHold: boolean; t: RoomT }): React.ReactNode {
  const { t } = a;
  const colour = t(a.colour === "white" ? "externalPlay.room.colour.white" : "externalPlay.room.colour.black");
  if (a.seatOnHold) {
    return (
      <>
        <span className="md:hidden">{t("externalPlay.room.seatOnHold")}</span>
        <span className="max-md:hidden">{t("externalPlay.room.colourSeatOnHold", { colour })}</span>
      </>
    );
  }
  if (a.yourMove) {
    return (
      <>
        <span className="md:hidden">{t("externalPlay.room.yourMove")}</span>
        <span className="max-md:hidden">{t("externalPlay.room.colourYourMove", { colour })}</span>
      </>
    );
  }
  return colour;
}

/**
 * One clock as a bar (D24): the opponent's above the board, the player's below. Each is as wide as the board it
 * frames (the shell gives it the board's column). Same card as the strip's, same testids, so a wrong name or a wrong
 * time is still provable at one site. `sound` is the player's switch, beside their time; the opponent's bar has none.
 */
export function ClockBar({
  side,
  who,
  turn,
  over,
  seatOnHold = false,
  sound = null,
  className = "",
  t,
}: {
  side: "opponent" | "you";
  who: Side;
  turn: Colour;
  over: boolean;
  /** Your seat is frozen (Seam A): the opponent's still plays. */
  seatOnHold?: boolean;
  sound?: React.ReactNode;
  className?: string;
  t: RoomT;
}) {
  if (side === "opponent") {
    return (
      <Card
        testId="room-clock-opponent"
        active={!over && turn === who.colour}
        over={over}
        title={who.name}
        sub={t(who.colour === "white" ? "externalPlay.room.colour.white" : "externalPlay.room.colour.black")}
        ms={who.ms}
        truncateTitle
        className={className}
      />
    );
  }
  const yourMove = !over && !seatOnHold && turn === who.colour;
  return (
    <Card
      testId="room-clock-you"
      active={yourMove}
      over={over}
      title={t("externalPlay.room.you")}
      sub={yourSub({ colour: who.colour, yourMove, seatOnHold, t })}
      ms={who.ms}
      truncateTitle={false}
      extra={sound}
      className={className}
    />
  );
}

/** The pair, side by side above the board: the opponent on the left, "You" on the right (the result state, D24). */
export function ClocksStrip({
  you,
  opponent,
  turn,
  over,
  seatOnHold = false,
  t,
}: {
  you: Side;
  opponent: Side;
  turn: Colour;
  over: boolean;
  /** Your seat is frozen (Seam A): the opponent's still plays. */
  seatOnHold?: boolean;
  t: RoomT;
}) {
  return (
    <div data-testid="room-clocks-strip" data-turn={turn} className="grid min-w-0 grid-cols-2 gap-2 md:gap-3">
      <ClockBar side="opponent" who={opponent} turn={turn} over={over} t={t} />
      <ClockBar side="you" who={you} turn={turn} over={over} seatOnHold={seatOnHold} t={t} />
    </div>
  );
}
