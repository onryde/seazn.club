// The opponent's presence, as the canvas draws it: "Ada · on camera" with a
// live dot. Compliance without a face — players never see each other (D7),
// so there is no <video> and no subscription here, by construction.
import { firstName, type RoomT } from "./room-copy";

export function PresencePill({ name, cameraLive, t }: { name: string; cameraLive: boolean; t: RoomT }) {
  return (
    <span
      data-testid="room-presence-pill"
      data-state={cameraLive ? "live" : "off"}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-[#e7e3f3] bg-white px-3 md:flex-none md:px-3.5"
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${cameraLive ? "bg-[#15803d]" : "bg-[#c9bdf0]"}`}
      />
      <span className="min-w-0 truncate text-[13px] md:text-sm">
        {t(cameraLive ? "externalPlay.room.presence.live" : "externalPlay.room.presence.off", { name: firstName(name) })}
      </span>
    </span>
  );
}
