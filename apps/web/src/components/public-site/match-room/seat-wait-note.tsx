"use client";
// The seat 429 wait's words (spec §6.1 (3)): a visible countdown while the button is shut, and a screen-reader region that
// speaks when the wait STARTS and when it ENDS - not each second. The visible number is aria-hidden for that reason.
import { useEffect, useRef, useState } from "react";
import type { RoomT } from "./room-copy";

export function SeatWaitNote({ remainingS, t }: { remainingS: number | null; t: RoomT }) {
  // What the region says: set once at the start (the first value, so a ticking face never re-speaks) and once at the end.
  const [announce, setAnnounce] = useState("");
  const running = useRef(false);
  useEffect(() => {
    if (remainingS !== null && !running.current) {
      running.current = true;
      setAnnounce(`${t("externalPlay.room.state.seatWait.title")} ${t("externalPlay.room.state.seatWait.countdown", { seconds: remainingS })}`);
    } else if (remainingS === null && running.current) {
      running.current = false;
      setAnnounce(t("externalPlay.room.state.seatWait.ready"));
    }
  }, [remainingS, t]);
  return (
    <div data-testid="room-seat-wait" data-waiting={remainingS !== null ? "true" : "false"} className="flex min-w-0 flex-col gap-1">
      {remainingS !== null ? (
        <div className="rounded-xl border border-[#c9bdf0] bg-[#f3effc] px-3 py-2.5 text-[13px] leading-[1.45] text-[#4a3a6b]" aria-hidden>
          <p className="m-0 font-semibold text-[#2e1065]">{t("externalPlay.room.state.seatWait.title")}</p>
          <p data-testid="room-seat-wait-countdown" className="m-0 tabular-nums">
            {t("externalPlay.room.state.seatWait.countdown", { seconds: remainingS })}
          </p>
        </div>
      ) : null}
      <div role="status" aria-live="polite" data-testid="room-seat-wait-announce" className="sr-only">
        {announce}
      </div>
    </div>
  );
}
