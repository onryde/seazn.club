// The move-sounds switch (T17B fix 2, D19; moved by D24). One icon button whose pressed state IS the setting
// (aria-pressed), the same 44px box in both states. It sits in the player's own clock bar, beside their time — the
// header it first lived in is no longer where the eyes are during a game — so it takes the bar's colour (dark when it is
// the player's move, lavender when it is not) instead of its own.
import type { RoomT } from "./room-copy";

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

export function SoundToggle({ sound, t }: { sound: SoundSwitch; t: RoomT }) {
  return (
    <button
      type="button"
      data-testid="room-sound"
      aria-pressed={sound.on}
      aria-label={t("externalPlay.room.sound.label")}
      title={t("externalPlay.room.sound.label")}
      onClick={sound.onToggle}
      className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-current transition-colors hover:bg-current/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current aria-[pressed=false]:opacity-60"
    >
      <SpeakerIcon on={sound.on} />
    </button>
  );
}
