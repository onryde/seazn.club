// The check-in screen (canvas "Checkin", owner-approved 2026-10-11): "Your
// board is open", who you play and the time control, the check-in countdown,
// your own camera preview with the privacy line, whether the opponent is in,
// the camera notice, and the Check in button.
//
// Two states the canvas does not draw, and which this file adds with the
// fewest new words (reported to the controller): the opponent NOT yet in
// ("Ada hasn't checked in yet", a muted row with no tick), and YOU already in
// and waiting (the button becomes a disabled "You're checked in").
import { OwnTile } from "./own-tile";
import { CameraNotice } from "./camera-notice";
import { firstName, spokenClock, type RoomPlural, type RoomT } from "./room-copy";
import type { RoomSnapshot } from "./room-snapshot";

type Props = {
  snap: Pick<RoomSnapshot, "you" | "opponent" | "meta" | "cameraPolicy">;
  /** "18:42" and "19:20", or null before mount (never server-rendered). */
  closesIn: string | null;
  closesAt: string | null;
  stream: MediaStream | null;
  cameraOn: boolean;
  busy: boolean;
  onCheckIn: () => void;
  t: RoomT;
  plural: RoomPlural;
};

export function Checkin({ snap, closesIn, closesAt, stream, cameraOn, busy, onCheckIn, t, plural }: Props) {
  const colour = t(snap.you.colour === "white" ? "externalPlay.room.colour.white" : "externalPlay.room.colour.black");
  const done = snap.you.checkedIn;
  return (
    <div data-testid="room-checkin" className="flex min-w-0 flex-1 flex-col gap-3.5 md:mx-auto md:w-full md:max-w-md">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 font-display text-[28px] font-bold uppercase tracking-[0.02em]">{t("externalPlay.room.checkin.title")}</h1>
        <p className="m-0 text-sm text-[#4a3a6b]">
          {t("externalPlay.room.checkin.youPlay", {
            colour,
            opponent: snap.opponent.name,
            clock: spokenClock(snap.meta.limitSeconds, snap.meta.incrementSeconds, plural),
          })}
        </p>
      </div>
      <div className="flex items-center justify-between rounded-xl bg-[#f3effc] px-3.5 py-2.5">
        <div className="flex flex-col text-xs text-[#6b5b8a]">
          <span>{t("externalPlay.room.checkin.closesIn")}</span>
          {closesAt !== null ? <span>{t("externalPlay.room.checkin.closesAt", { time: closesAt })}</span> : null}
        </div>
        <span data-testid="room-checkin-countdown" className="font-display text-[34px] font-semibold tabular-nums">
          {closesIn ?? ""}
        </span>
      </div>
      {snap.cameraPolicy !== "off" ? (
        <>
          <OwnTile policy={snap.cameraPolicy} stream={stream} variant="checkin" cameraOn={cameraOn} t={t} />
          <p className="m-0 text-xs leading-[1.45] text-[#6b5b8a]">
            {t("externalPlay.room.checkin.privacy", { name: firstName(snap.opponent.name) })}
          </p>
        </>
      ) : null}
      <div
        data-testid="room-checkin-opponent"
        data-in={snap.opponent.checkedIn ? "true" : "false"}
        className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[#e7e3f3] bg-white px-3 py-2.5"
      >
        {snap.opponent.checkedIn ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : (
          <span aria-hidden className="ml-1.5 mr-1 h-2 w-2 shrink-0 rounded-full bg-[#c9bdf0]" />
        )}
        {/* Wraps, never truncates: it is a sentence about the opponent, and a
            long name would cut off the part that says whether they are in. */}
        <span className={`min-w-0 break-words text-sm ${snap.opponent.checkedIn ? "" : "text-[#6b5b8a]"}`}>
          {t(snap.opponent.checkedIn ? "externalPlay.room.checkin.opponentIn" : "externalPlay.room.checkin.opponentNotIn", {
            name: snap.opponent.name,
          })}
        </span>
      </div>
      <div className="flex-1" />
      {snap.cameraPolicy === "required" ? <CameraNotice t={t} /> : null}
      <button
        type="button"
        data-testid="room-checkin-cta"
        disabled={done || busy}
        onClick={onCheckIn}
        className="min-h-12 rounded-xl border-0 bg-[#7c3aed] text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#c9bdf0]"
      >
        {t(done ? "externalPlay.room.checkin.done" : "externalPlay.room.checkin.cta")}
      </button>
    </div>
  );
}
