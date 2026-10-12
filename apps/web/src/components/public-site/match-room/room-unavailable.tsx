// The room with no room to show: the link or session does not resolve to one
// of the fixture's players (canvas card 7). Server-rendered, no transport, no
// header (there is no fixture we may describe to this visitor).
import { UnavailableCard } from "./room-cards";
import type { RoomT } from "./room-copy";

export function RoomHeaderless({ fixtureHref, t }: { fixtureHref: string; t: RoomT }) {
  return (
    <div data-testid="match-room" data-screen="unavailable" className="flex min-h-screen min-w-0 flex-col bg-[#fdfcf8] px-4 py-6 text-[#2e1065] md:p-10">
      <UnavailableCard fixtureHref={fixtureHref} t={t} />
    </div>
  );
}
