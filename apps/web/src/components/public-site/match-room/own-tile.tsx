"use client";
// The player's OWN camera, as a local preview (canvas: a dark tile labelled
// "You · mic off"; at check-in, "Camera on" / "Mic off" chips). The stream
// comes from `use-own-camera` — this file never sees a participant token, and
// there is no subscription to any other participant anywhere in it. Policy
// `off` creates no meeting at all, so the tile is not drawn (spec §5.1).
import { useEffect, useLayoutEffect, useRef } from "react";
import type { CameraPolicyWire } from "./room-snapshot";
import type { RoomT } from "./room-copy";

type Props = {
  policy: CameraPolicyWire;
  stream: MediaStream | null;
  variant?: "room" | "checkin";
  /** Check-in only: the "Camera on" chip shows only while a stream runs. */
  cameraOn?: boolean;
  /** T17B fix 2 (D15): called once the preview has PAINTED a frame of `stream` — the camera test's proof. */
  onFrame?: (stream: MediaStream) => void;
  /** T17B fix 2 (D23): the tile's <video>, handed up so Check in can keep its last frame before the camera stops. */
  videoRef?: (el: HTMLVideoElement | null) => void;
  /** T17B fix 2 (D23): the frame kept at Check in, laid over the tile until the SDK's own video is playing. */
  frozen?: HTMLCanvasElement | null;
  t: RoomT;
};

function Silhouette({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="absolute bottom-0 left-1/2 -translate-x-1/2">
      <circle cx="32" cy="24" r="12" fill="#4c3d6e" />
      <path d="M8 64c0-14 11-22 24-22s24 8 24 22z" fill="#4c3d6e" />
    </svg>
  );
}

/** D23: the kept frame, mirrored and cropped exactly as the live <video> is, with the words for what is happening.
 *  The picture is drawn in a LAYOUT effect, so it is on the page in the same paint that takes the video away; it is
 *  the first child, so the words (a later sibling) paint over it. */
function Frozen({ frame, variant, t }: { frame: HTMLCanvasElement; variant: "room" | "checkin"; t: RoomT }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    el.width = frame.width;
    el.height = frame.height;
    g.drawImage(frame, 0, 0);
  }, [frame]);
  return (
    <div data-testid="room-own-tile-frozen" className="absolute inset-0">
      <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      {/* The small phone tile has no room for a sentence: it is still announced. */}
      <span
        role="status"
        className={`absolute inset-x-1.5 bottom-2 mx-auto w-fit max-w-[calc(100%-12px)] rounded-full bg-[rgba(27,18,48,0.75)] px-2.5 py-1 text-center text-xs text-white ${variant === "room" ? "max-md:sr-only" : ""}`}
      >
        {t("externalPlay.room.checkin.connecting")}
      </span>
    </div>
  );
}

export function OwnTile({ policy, stream, variant = "room", cameraOn = false, onFrame, videoRef, frozen = null, t }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    videoRef?.(video.current);
    return () => videoRef?.(null);
  }, [videoRef]);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
  // D15: the frame proof — a frame of THIS stream presented by the preview (requestVideoFrameCallback), or, where the
  // browser has none, the first decoded frame (`loadeddata` with a width). Never a timer: no frame, no proof.
  useEffect(() => {
    const el = video.current;
    if (!el || !stream || !onFrame) return;
    let done = false;
    const prove = () => {
      if (done || el.videoWidth === 0) return;
      done = true;
      onFrame(stream);
    };
    if (typeof el.requestVideoFrameCallback === "function") {
      // A presented frame without a size yet asks for the next one.
      const tick = () => {
        prove();
        if (!done) id = el.requestVideoFrameCallback(tick);
      };
      let id = el.requestVideoFrameCallback(tick);
      return () => {
        done = true;
        el.cancelVideoFrameCallback(id);
      };
    }
    const onData = () => prove();
    el.addEventListener("loadeddata", onData);
    if (el.readyState >= 2) prove();
    return () => {
      done = true;
      el.removeEventListener("loadeddata", onData);
    };
  }, [stream, onFrame]);
  if (policy === "off") return null;
  const checkin = variant === "checkin";
  return (
    <figure
      data-testid="room-own-tile"
      data-mic="muted"
      data-stream={stream ? "on" : "off"}
      className={
        checkin
          ? "relative m-0 h-[200px] w-full max-w-[288px] shrink-0 overflow-hidden rounded-xl bg-[#1b1230]"
          : "relative m-0 h-[84px] w-[112px] shrink-0 overflow-hidden rounded-[10px] bg-[#1b1230] md:h-[216px] md:w-[288px] md:rounded-xl"
      }
    >
      {stream ? null : <Silhouette size={checkin ? 120 : 64} />}
      <video
        ref={video}
        muted
        playsInline
        autoPlay
        aria-hidden
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${stream ? "" : "hidden"}`}
      />
      {frozen !== null ? <Frozen frame={frozen} variant={variant} t={t} /> : null}
      {checkin ? (
        <>
          {cameraOn ? (
            <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-[rgba(27,18,48,0.75)] px-2 py-1 text-xs text-white">
              <span aria-hidden className="h-2 w-2 rounded-full bg-[#22c55e]" />
              {t("externalPlay.room.checkin.cameraOn")}
            </span>
          ) : null}
          <span className="absolute right-2.5 top-2.5 rounded-full bg-[rgba(27,18,48,0.75)] px-2 py-1 text-xs text-white">
            {t("externalPlay.room.checkin.micOff")}
          </span>
        </>
      ) : (
        <figcaption className="absolute bottom-[5px] left-1.5 rounded-md bg-[rgba(27,18,48,0.7)] px-1.5 py-0.5 text-[11px] text-white md:bottom-2 md:left-2 md:px-2 md:text-xs">
          {t("externalPlay.room.micMuted")}
        </figcaption>
      )}
    </figure>
  );
}
