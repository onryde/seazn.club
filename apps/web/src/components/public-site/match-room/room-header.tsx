// The room's own header (canvas): phone — a back arrow (44px target) and two
// lines, "Open Rapid · Round 3" / "Board 2 · 10+5"; desktop — "‹ Back to
// fixture", a divider, the meta line and the board line on one row.
import Link from "next/link";
import { compactClock, type RoomT } from "./room-copy";
import type { RoomSnapshot } from "./room-snapshot";

export function RoomHeader({ snap, t }: { snap: Pick<RoomSnapshot, "meta" | "links">; t: RoomT }) {
  const meta = t("externalPlay.room.header.meta", { division: snap.meta.divisionName, round: snap.meta.roundNo });
  const board = t("externalPlay.room.header.board", {
    board: snap.meta.boardNo,
    clock: compactClock(snap.meta.limitSeconds, snap.meta.incrementSeconds),
  });
  return (
    <header
      data-testid="room-header"
      className="flex h-[52px] min-w-0 items-center gap-1 border-b border-[#e7e3f3] pl-1 pr-4 md:h-16 md:gap-4 md:px-8"
    >
      <Link
        href={snap.links.fixture}
        aria-label={t("externalPlay.room.backAria")}
        data-testid="room-back"
        className="flex h-11 w-11 shrink-0 items-center justify-center text-[#2e1065] md:w-auto md:gap-1 md:text-[15px] md:font-semibold md:text-[#5b21b6]"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span className="max-md:hidden">{t("externalPlay.room.backToFixture")}</span>
      </Link>
      <span aria-hidden className="h-6 w-px shrink-0 bg-[#e7e3f3] max-md:hidden" />
      <div className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-4">
        <span className="min-w-0 truncate text-xs text-[#6b5b8a] md:text-sm">{meta}</span>
        <span className="min-w-0 truncate text-[15px] font-semibold md:text-base">{board}</span>
      </div>
    </header>
  );
}
