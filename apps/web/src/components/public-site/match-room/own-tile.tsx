"use client";
// The player's OWN camera, as a local preview (canvas: a dark tile labelled
// "You · mic off"; at check-in, "Camera on" / "Mic off" chips). The stream
// comes from `use-own-camera` — this file never sees a participant token, and
// there is no subscription to any other participant anywhere in it. Policy
// `off` creates no meeting at all, so the tile is not drawn (spec §5.1).
import { useEffect, useRef } from "react";
import type { CameraPolicyWire } from "./room-snapshot";
import type { RoomT } from "./room-copy";

type Props = {
  policy: CameraPolicyWire;
  stream: MediaStream | null;
  variant?: "room" | "checkin";
  /** Check-in only: the "Camera on" chip shows only while a stream runs. */
  cameraOn?: boolean;
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

export function OwnTile({ policy, stream, variant = "room", cameraOn = false, t }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
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
