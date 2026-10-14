// The room's own header (canvas): phone — a back arrow (44px target) and two
// lines, "Open Rapid · Round 3" / "Board 2 · 10+5"; desktop — "‹ Back to
// fixture", a divider, the meta line and the board line on one row. At the
// far end (T17B fix 2, D19) the sound switch: one icon button whose pressed
// state IS the setting (aria-pressed), the same 44px box in both states.
import Link from "next/link";
import { compactClock, type RoomT } from "./room-copy";
import type { RoomSnapshot } from "./room-snapshot";

export type SoundSwitch = { on: boolean; onToggle: () => void };

/** A speaker; waves when sounds are on, a cross when they are off. Same box, same stroke, either way. */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg data-sound-icon={on ? "on" : "off"} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" fillOpacity="0.14" />
      {on ? (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      ) : (
        <path d="m16 9.5 5 5m0-5-5 5" />
      )}
    </svg>
  );
}

export function RoomHeader({
  snap,
  t,
  sound = null,
}: {
  snap: Pick<RoomSnapshot, "meta" | "links">;
  t: RoomT;
  /** The move-sounds switch (D19); none drawn without one. */
  sound?: SoundSwitch | null;
}) {
  const meta = t("externalPlay.room.header.meta", { division: snap.meta.divisionName, round: snap.meta.roundNo });
  const board = t("externalPlay.room.header.board", {
    board: snap.meta.boardNo,
    clock: compactClock(snap.meta.limitSeconds, snap.meta.incrementSeconds),
  });
  return (
    <header
      data-testid="room-header"
      className={`flex h-[52px] min-w-0 items-center gap-1 border-b border-[#e7e3f3] pl-1 md:h-16 md:gap-4 md:px-8 ${sound ? "pr-1" : "pr-4"}`}
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
      {sound ? (
        <button
          type="button"
          data-testid="room-sound"
          aria-pressed={sound.on}
          aria-label={t("externalPlay.room.sound.label")}
          title={t("externalPlay.room.sound.label")}
          onClick={sound.onToggle}
          className="ml-auto flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#5b21b6] transition-colors hover:bg-[#f3effc] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5b21b6] aria-[pressed=false]:text-[#6b5b8a] md:-mr-2"
        >
          <SpeakerIcon on={sound.on} />
        </button>
      ) : null}
    </header>
  );
}
