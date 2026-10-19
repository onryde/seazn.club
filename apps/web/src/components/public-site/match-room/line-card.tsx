"use client";
// The check-in line, as the check-in card shows it (spec §6.1 (2), §5.7.9): the player's place, the estimate to being let in,
// what to do (keep the page open), when the board's check-in closes and, when the estimate plus the camera's tail runs past
// that, a warning. It replaces the preflight actions; the card around it (the camera tile, who you play) is the check-in's own.
//
// Words: the position is a `role="status"` region that speaks when the NUMBER changes - the estimate sits outside it, so a poll
// that moves only the estimate is silent. The warning is announced ONCE: it is visible whenever the server says so, and a
// separate screen-reader-only region says it the first time it appears and never again.
import { useEffect, useState } from "react";
import { etaPhrase } from "./line-view";
import type { RoomPlural, RoomT } from "./room-copy";
import { LINE_ABANDON_AFTER_MS, type LineWire } from "./room-snapshot";
import { useWakeLock } from "./use-wake-lock";

export type LineCardView = {
  wire: LineWire;
  /** The cap in the viewer's zone and locale, or null before mount (a time of day is never server-rendered). */
  closesAt: string | null;
  /** Why the player is at the back again - sticky in the reducer, shown for as long as the card shows. */
  left: LineWire["left"];
};

export function LineBlock({ view, t, plural }: { view: LineCardView; t: RoomT; plural: RoomPlural }) {
  const { wire, closesAt, left } = view;
  const eta = etaPhrase(wire.etaS);
  // Best effort: a sleeping phone stops the claim loop and costs the place.
  useWakeLock(true);
  // The warning, spoken once: set the first time the server says so, never cleared. Set from a timer, not in the effect body: the
  // live region must be committed EMPTY and then gain the words, which is what a screen reader announces (text present at mount is not).
  const [spoken, setSpoken] = useState(false);
  useEffect(() => {
    if (!wire.mayTimeOut) return undefined;
    const id = setTimeout(() => setSpoken(true), 0);
    return () => clearTimeout(id);
  }, [wire.mayTimeOut]);
  return (
    <section
      data-testid="room-line"
      data-position={wire.position}
      className="flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-[#e7e3f3] bg-white p-4"
    >
      {left !== null ? (
        <p
          data-testid="room-line-left"
          data-left={left}
          className="m-0 rounded-xl bg-[#f3effc] px-3 py-2 text-[13px] leading-[1.45] text-[#4a3a6b]"
        >
          {t(left === "silent" ? "externalPlay.room.state.line.left" : "externalPlay.room.state.line.leftCamera")}
        </p>
      ) : null}
      <p
        role="status"
        data-testid="room-line-position"
        className="m-0 font-display text-[26px] font-semibold leading-[1.15] tabular-nums"
      >
        {t("externalPlay.room.state.line.title", { position: wire.position })}
      </p>
      <p data-testid="room-line-eta" className="m-0 text-[15px] font-semibold tabular-nums text-[#7c3aed]">
        {plural(eta.unit === "minutes" ? "externalPlay.room.state.line.eta.minutes" : "externalPlay.room.state.line.eta.seconds", eta.count)}
      </p>
      <p data-testid="room-line-body" className="m-0 text-[13px] leading-[1.45] text-[#4a3a6b]">
        {t("externalPlay.room.state.line.body", { seconds: LINE_ABANDON_AFTER_MS / 1_000 })}
      </p>
      {closesAt !== null ? (
        <p data-testid="room-line-closes" className="m-0 text-xs leading-[1.45] text-[#6b5b8a]">
          {t("externalPlay.room.state.line.closes", { time: closesAt })}
        </p>
      ) : null}
      {wire.mayTimeOut ? (
        <p
          data-testid="room-line-may-time-out"
          className="m-0 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[13px] leading-[1.45] text-[#713f12]"
        >
          {t("externalPlay.room.state.line.mayTimeOut")}
        </p>
      ) : null}
      <div role="status" aria-live="polite" data-testid="room-line-announce" className="sr-only">
        {spoken ? t("externalPlay.room.state.line.mayTimeOut") : ""}
      </div>
    </section>
  );
}
