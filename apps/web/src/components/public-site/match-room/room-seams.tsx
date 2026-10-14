// The room state with NO approved drawing yet (controller, 2026-10-11):
//   held — a game on file the server takes no move on (T14 review I2: a
//          provider_error hold, T13's deadline hold, a withdrawn board).
// Its LOGIC is final (room-screen.ts decides when it shows). Its
// PRESENTATION is deliberately minimal: one plain card, behind this seam,
// until the owner's drawing arrives. Do not style it to taste — replace it
// with the drawing. (Seams A and B were drawn and approved 2026-10-12: they
// are built in room-cards.tsx and room-shell.tsx.)
import { StateCard } from "./room-cards";
import type { RoomT } from "./room-copy";

/** Seam "held" — a game on file nobody may act on. Sits under the true
 *  clocks and a view-only board (room-shell.tsx). */
export function HeldSeam({ t }: { t: RoomT }) {
  return (
    <StateCard testId="room-seam-held" icon={null} title={t("externalPlay.room.state.held.title")}>
      <p className="m-0 text-sm text-[#4a3a6b]">{t("externalPlay.room.state.held.body")}</p>
    </StateCard>
  );
}
