// The two room states with NO approved drawing yet (controller, 2026-10-11):
//   A — "Lichess link revoked" for the frozen player;
//   B — "Online chess is off for this club".
// Their LOGIC is final (room-screen.ts decides when each shows, room-state.ts
// stops polling on B). Their PRESENTATION is deliberately minimal: one plain
// card each, behind this one seam, until the owner's drawing arrives. Do not
// style these to taste — replace them with the drawing.
import { StateCard } from "./room-cards";
import type { RoomT } from "./room-copy";

/** Seam A — the viewer's own Lichess link was revoked mid-game. */
export function RevokedSeam({ t }: { t: RoomT }) {
  return (
    <StateCard testId="room-seam-revoked" icon={null} title={t("externalPlay.room.state.revoked.title")}>
      <p className="m-0 text-sm text-[#4a3a6b]">{t("externalPlay.room.state.revoked.body")}</p>
    </StateCard>
  );
}

/** Seam B — the club is not offered online chess and no game is on file. */
export function OffForClubSeam({ t }: { t: RoomT }) {
  return <StateCard testId="room-seam-off-for-club" icon={null} title={t("externalPlay.room.state.offForClub.title")} />;
}
