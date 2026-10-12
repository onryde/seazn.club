// Both clocks and both names (canvas: the opponent on the left, "You" on the
// right; the side to move is the dark card; game over mutes both). The strip
// is dumb on purpose (Seam A: a seat on hold reads so on YOUR card, never
// "your move", and its clock is not muted — it still runs on Lichess): names arrive resolved from the room usecase, and the
// milliseconds arrive already derived by the shell (clock-math), so a wrong
// name or a wrong time is provable at ONE site, never here.
import { formatClock } from "./clock-math";
import type { Colour } from "./room-snapshot";
import type { RoomT } from "./room-copy";

type Side = { name: string; colour: Colour; ms: number };

function Card({
  testId,
  active,
  over,
  title,
  sub,
  ms,
  truncateTitle,
}: {
  testId: string;
  active: boolean;
  over: boolean;
  title: string;
  sub: React.ReactNode;
  ms: number;
  truncateTitle: boolean;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={`flex min-w-0 items-center justify-between gap-1.5 rounded-[10px] px-2.5 py-2 md:gap-3 md:rounded-xl md:px-4 md:py-2.5 ${
        active ? "bg-[#2e1065] text-white" : "bg-[#f3effc] text-[#2e1065]"
      }`}
    >
      <div className="flex min-w-0 flex-col">
        <span className={`text-[13px] font-semibold md:text-base ${truncateTitle ? "min-w-0 truncate" : ""}`}>{title}</span>
        <span className={`min-w-0 truncate text-[11px] md:text-[13px] ${active ? "text-[#ddd3f7]" : "text-[#6b5b8a]"}`}>{sub}</span>
      </div>
      <span
        className={`font-display text-[26px] font-semibold tabular-nums md:text-4xl ${over ? "text-[#6b5b8a]" : ""}`}
      >
        {formatClock(ms)}
      </span>
    </div>
  );
}

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
  const yourMove = !over && !seatOnHold && turn === you.colour;
  const colourOf = (c: Colour) => t(c === "white" ? "externalPlay.room.colour.white" : "externalPlay.room.colour.black");
  return (
    <div data-turn={turn} className="grid min-w-0 grid-cols-2 gap-2 md:gap-3">
      <Card
        testId="room-clock-opponent"
        active={!over && turn === opponent.colour}
        over={over}
        title={opponent.name}
        sub={colourOf(opponent.colour)}
        ms={opponent.ms}
        truncateTitle
      />
      <Card
        testId="room-clock-you"
        active={yourMove}
        over={over}
        title={t("externalPlay.room.you")}
        sub={
          seatOnHold ? (
            <>
              <span className="md:hidden">{t("externalPlay.room.seatOnHold")}</span>
              <span className="max-md:hidden">{t("externalPlay.room.colourSeatOnHold", { colour: colourOf(you.colour) })}</span>
            </>
          ) : yourMove ? (
            <>
              <span className="md:hidden">{t("externalPlay.room.yourMove")}</span>
              <span className="max-md:hidden">{t("externalPlay.room.colourYourMove", { colour: colourOf(you.colour) })}</span>
            </>
          ) : (
            colourOf(you.colour)
          )
        }
        ms={you.ms}
        truncateTitle={false}
      />
    </div>
  );
}
