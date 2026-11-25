// Seazn-hosted video T47 (owner 2026-11-24, option A): the little camera in a match card's top-right slot, beside the time. One glyph, two
// states, both from `HubMatch.stream` (the enum, never an address): `live` is a RED camera with a pulsing red dot (the card's green score
// "Live" dot is a different fact and a card can carry both, so the two are different colours and different shapes); `replay` is a quiet slate
// camera with no dot. The icon is not a link: the whole card already is one, and the match page holds the player.
//
// The words ("Live stream" / "Replay available") are the icon's `title` AND a visually hidden span the card names as its description
// (`aria-describedby`): the card's `aria-label` replaces its contents for a screen reader, so without that span the camera would be silent.
// The dot hangs 2px past the icon's corner, and that 2px is the camera's own right padding (`pr-0.5`, live only): the dot is anchored to
// `right-0` of it, so it sits on the icon exactly as `-right-0.5` put it, and the box holds it (the glyph is 2px left of the slot's edge; the dot is no longer past it). A dot outside its box made the card's clipping scan read
// `span 18px content in 16px` (e2e/mobile/public-pages.spec.ts T47, every width).
// The dot's pulse is `animate-stream-pulse`, switched off under `prefers-reduced-motion` in globals.css.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

export type StreamCue = "live" | "replay";

/** The id of the hidden description a card points `aria-describedby` at. */
export const streamDescriptionId = (fixtureId: string): string => `mh-stream-${fixtureId}`;

export function StreamCamera({ cue, fixtureId, dict }: { cue: StreamCue; fixtureId: string; dict: PublicDict }) {
  const words = t(dict, cue === "live" ? "matchesHub.stream.live" : "matchesHub.stream.replay");
  return (
    <span
      data-testid="mh-match-stream"
      data-stream={cue}
      title={words}
      className={`relative inline-grid shrink-0 place-items-center ${cue === "live" ? "pr-0.5 text-red-600" : "text-slate-500"}`}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-4 w-4"
      >
        <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
      </svg>
      {cue === "live" ? (
        <span
          data-testid="mh-match-stream-dot"
          aria-hidden="true"
          className="animate-stream-pulse absolute right-0 -top-px h-1.5 w-1.5 rounded-full bg-red-600 outline outline-[1.5px] outline-surface"
        />
      ) : null}
      <span id={streamDescriptionId(fixtureId)} className="sr-only">
        {words}
      </span>
    </span>
  );
}
