// The room with no room to show: the link or session does not resolve to one
// of the fixture's players (canvas card 7). Server-rendered, no transport, no
// header (there is no fixture we may describe to this visitor).
//
// Final re-review 4, I2: or the board is being re-paired (the server's 409) —
// the re-pair card, headerless for the same reason, never card 7's "it may
// belong to other players", and re-asking the page until the board is paired
// again (RepairingRefresh).
import { RepairingCard, UnavailableCard } from "./room-cards";
import type { RoomT } from "./room-copy";
import { RepairingRefresh } from "./room-repairing-refresh";

const HEADERLESS = "flex min-h-screen min-w-0 flex-col bg-[#fdfcf8] px-4 py-6 text-[#2e1065] md:p-10";

export function RoomHeaderless({ fixtureHref, t }: { fixtureHref: string; t: RoomT }) {
  return (
    <div data-testid="match-room" data-screen="unavailable" className={HEADERLESS}>
      <UnavailableCard fixtureHref={fixtureHref} t={t} />
    </div>
  );
}

/** I2: the page loaded inside a re-pair gap — the room's re-pair card, and the page re-asked at the room's cadence. */
export function RoomRepairingHeaderless({ t }: { t: RoomT }) {
  return (
    <div data-testid="match-room" data-screen="repairing" className={HEADERLESS}>
      <RepairingCard t={t} />
      <RepairingRefresh />
    </div>
  );
}
