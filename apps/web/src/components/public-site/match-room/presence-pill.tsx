// The opponent's presence, as the canvas draws it: "Ada · on camera" with a
// live dot. Compliance without a face — players never see each other (D7),
// so there is no <video> and no subscription here, by construction.
//
// D16 (§5.6.3): the state is the opponent's OWN browser's last report, relayed by the server - live, off, or unknown (no
// fresh report). Unknown is drawn as an empty ring, not the green of live and not the lavender of off: a stale report
// must not claim a fact we do not have.
import { firstName, type RoomT } from "./room-copy";

export type PresenceState = "live" | "off" | "unknown";

const DOT: Record<PresenceState, string> = {
  live: "h-2 w-2 shrink-0 rounded-full bg-[#15803d]",
  off: "h-2 w-2 shrink-0 rounded-full bg-[#c9bdf0]",
  unknown: "h-2 w-2 shrink-0 rounded-full border border-[#8b86a3] bg-transparent",
};

const COPY: Record<PresenceState, "externalPlay.room.presence.live" | "externalPlay.room.presence.off" | "externalPlay.room.presence.unknown"> = {
  live: "externalPlay.room.presence.live",
  off: "externalPlay.room.presence.off",
  unknown: "externalPlay.room.presence.unknown",
};

export function PresencePill({ name, state, t }: { name: string; state: PresenceState; t: RoomT }) {
  return (
    <span
      data-testid="room-presence-pill"
      data-state={state}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-[#e7e3f3] bg-white px-3 md:flex-none md:px-3.5"
    >
      <span aria-hidden className={DOT[state]} />
      <span className={`min-w-0 truncate text-[13px] md:text-sm ${state === "unknown" ? "text-[#5f5a78]" : ""}`}>
        {t(COPY[state], { name: firstName(name) })}
      </span>
    </span>
  );
}
