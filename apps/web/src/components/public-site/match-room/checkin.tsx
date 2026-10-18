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
import { canCheckIn, type CameraTestView } from "./camera-test";
import { isHandoverActive, type HandoverView } from "./camera-handover";
import { spokenClock, type RoomPlural, type RoomT } from "./room-copy";
import type { RoomSnapshot } from "./room-snapshot";
import { LineBlock, type LineCardView } from "./line-card";
import { SeatWaitNote } from "./seat-wait-note";

type Props = {
  snap: Pick<RoomSnapshot, "you" | "opponent" | "meta" | "cameraPolicy">;
  /** "18:42" and "19:20", or null before mount (never server-rendered). */
  closesIn: string | null;
  closesAt: string | null;
  stream: MediaStream | null;
  cameraOn: boolean;
  busy: boolean;
  /** T17B fix 2 (D2): the seat answered `camera_starting` and the room is re-asking — the button waits, and says so. */
  checkingCamera?: boolean;
  /** T17B fix 2 (D15): the on-page camera test — camera "required" only (null otherwise: today's check-in). Check in
   *  waits for it; pressing Check in hands the camera over (the test track stopped) BEFORE `onCheckIn` runs. */
  cameraTest?: {
    view: CameraTestView;
    onTest: () => void;
    onFrame: (stream: MediaStream) => void;
    onHandOver: () => void;
  } | null;
  /** T17B fix 2 (D23): the frozen frame between Check in's stop of the test camera and the SDK's first video frame. */
  handover?: {
    view: HandoverView;
    register: (el: HTMLVideoElement | null) => void;
    onSdkFrame: (stream: MediaStream) => void;
  } | null;
  /** D21-fix-3: an optional camera seated with no token because the platform's call budget was spent, the room asking
   *  again (cameraRetryDue): the tile says "Connecting your camera…" - nothing is wrong, the token is late. */
  cameraPending?: boolean;
  /** Spec §5.7.9, §6.1 (2): the platform's call budget is holding the claim in the check-in line. The line replaces the
   *  preflight actions (the camera test and the button); everything else on the card is the check-in's own. */
  line?: LineCardView | null;
  /** Spec §6.1 (3): whole seconds left of the seat door's 429 wait, or null. The button is shut for as long as it runs. */
  seatWaitS?: number | null;
  onCheckIn: () => void;
  t: RoomT;
  plural: RoomPlural;
};

export function Checkin({
  snap,
  closesIn,
  closesAt,
  stream,
  cameraOn,
  busy,
  checkingCamera = false,
  cameraTest = null,
  handover = null,
  cameraPending = false,
  line = null,
  seatWaitS = null,
  onCheckIn,
  t,
  plural,
}: Props) {
  const colour = t(snap.you.colour === "white" ? "externalPlay.room.colour.white" : "externalPlay.room.colour.black");
  const done = snap.you.checkedIn;
  // D15: under "required" Check in waits for a tested camera — and with no test wired at all, it stays shut (a guard).
  const required = snap.cameraPolicy === "required";
  const test = required && !done ? cameraTest : null;
  const untested = required && !done && (test === null || !canCheckIn(test.view));
  const testStream = test !== null && (test.view.status === "testing" || test.view.status === "live") ? test.view.stream : null;
  // D23: after the test camera is stopped, the tile is covered until the SDK's own video proves a frame in it.
  const covered = handover !== null && isHandoverActive(handover.view) ? handover : null;
  const tileOn = test === null ? cameraOn : test.view.status === "live" || (test.view.status === "handed" && cameraOn);
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
      {/* The line is the player's place; the check-in's own countdown is to the DEADLINE, which a queued player is allowed to pass
          (the line card says when their check-in really closes). */}
      {line !== null ? <LineBlock view={line} t={t} plural={plural} /> : null}
      {line === null ? (
        <div className="flex items-center justify-between rounded-xl bg-[#f3effc] px-3.5 py-2.5">
          <div className="flex flex-col text-xs text-[#6b5b8a]">
            <span>{t("externalPlay.room.checkin.closesIn")}</span>
            {closesAt !== null ? <span>{t("externalPlay.room.checkin.closesAt", { time: closesAt })}</span> : null}
          </div>
          <span data-testid="room-checkin-countdown" className="font-display text-[34px] font-semibold tabular-nums">
            {closesIn ?? ""}
          </span>
        </div>
      ) : null}
      {snap.cameraPolicy !== "off" ? (
        <>
          <OwnTile
            policy={snap.cameraPolicy}
            stream={testStream ?? stream}
            variant="checkin"
            cameraOn={tileOn}
            onFrame={testStream !== null ? test?.onFrame : covered?.onSdkFrame}
            videoRef={handover?.register}
            frozen={covered?.view.frame ?? null}
            connecting={covered?.view.status === "connecting" || cameraPending}
            t={t}
          />
          {test !== null && line === null ? <CameraTestRow view={test.view} onTest={test.onTest} t={t} /> : null}
          <p data-testid="room-checkin-privacy" className="m-0 text-xs leading-[1.45] text-[#6b5b8a]">
            {t("externalPlay.room.checkin.privacy")}
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
      {line === null ? <SeatWaitNote remainingS={seatWaitS} t={t} /> : null}
      {line === null ? (
        <button
          type="button"
          data-testid="room-checkin-cta"
          disabled={done || busy || checkingCamera || untested || seatWaitS !== null}
          onClick={() => {
            // The ruling's order: the test camera is released first, so the SDK's join never meets a busy device.
            test?.onHandOver();
            onCheckIn();
          }}
          className="min-h-12 cursor-pointer rounded-xl border-0 bg-[#7c3aed] text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#c9bdf0]"
        >
          {t(done ? "externalPlay.room.checkin.done" : checkingCamera ? "externalPlay.room.checkin.cameraStarting" : "externalPlay.room.checkin.cta")}
        </button>
      ) : null}
    </div>
  );
}

const FAILURE_KEY = {
  denied: "externalPlay.room.checkin.test.denied",
  notFound: "externalPlay.room.checkin.test.notFound",
  inUse: "externalPlay.room.checkin.test.inUse",
  other: "externalPlay.room.checkin.test.other",
  ended: "externalPlay.room.checkin.test.ended",
} as const;

/** D15: what the test is doing, and the one way forward — Test camera, Test again — until the camera is proven. */
function CameraTestRow({ view, onTest, t }: { view: CameraTestView; onTest: () => void; t: RoomT }) {
  if (view.status === "live" || view.status === "handed") return null;
  const asking = view.status === "testing";
  return (
    <div data-testid="room-checkin-test" data-status={view.status} className="flex min-w-0 flex-col gap-2">
      {view.status === "failed" ? (
        <p
          data-testid="room-checkin-test-failure"
          data-failure={view.failure}
          role="alert"
          className="m-0 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[13px] leading-[1.45] text-[#713f12]"
        >
          {t(FAILURE_KEY[view.failure])}
        </p>
      ) : view.status === "idle" ? (
        <p className="m-0 text-xs leading-[1.45] text-[#6b5b8a]">{t("externalPlay.room.checkin.test.needed")}</p>
      ) : null}
      <button
        type="button"
        data-testid="room-checkin-test-cta"
        disabled={asking}
        onClick={onTest}
        className="min-h-11 cursor-pointer rounded-xl border border-[#c9bdf0] bg-white text-[15px] font-semibold text-[#2e1065] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t(
          asking
            ? "externalPlay.room.checkin.test.starting"
            : view.status === "failed"
              ? "externalPlay.room.checkin.test.again"
              : "externalPlay.room.checkin.test.cta",
        )}
      </button>
    </div>
  );
}
