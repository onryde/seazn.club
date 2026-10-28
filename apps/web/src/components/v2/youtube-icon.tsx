// The official YouTube icon — the one piece of YouTube artwork in the product. One component, so no surface can draw its own version.
//
// YouTube's branding guidelines (developers.google.com/youtube/terms/branding-guidelines, page last updated 2025-08-20, read
// 2026-10-28) bind it, and each rule is held below by a test (components/v2/__tests__/youtube-icon.test.tsx):
//   * UNALTERED: "You cannot modify the colors of the YouTube logos or YouTube Icons." The red (#FF0000) and the white play triangle
//     are the mark's own, the proportions are the artwork's own (28.57 x 20), nothing is stretched, tinted, rotated or given an effect.
//   * "Make sure the logo is fully and clearly visible. It must not be altered or partially covered." No clipping box: the viewBox is
//     the artwork's own bounds, and a caller never wraps it in an `overflow-hidden` shell narrower than the mark.
//   * MINIMUM SIZE: the brand site's digital minimum is 20 px tall (brand.youtube / the how-YouTube-works brand page; the
//     guidelines page defers to it for the number). Both sizes here are at least 20.
//   * CLEAR SPACE: at least the size of the triangle inside the icon (about 0.43 of its height) on every side. Callers leave 10 px
//     or more beside it (`gap-2.5`, `gap-3`); the mark itself carries no padding so a row's own rhythm is not fought. The link's
//     44px tap area is a pseudo-element, so it does not move the icon or its clear space.
//   * "Do not display any YouTube branding image as the most prominent element on your page": the icon is a 20 to 24 px lead-in to a
//     row, always beside its channel's NAME in text (or inside a "Watch replay" button).
//   * The YouTube Icon (not the full logo) is the right mark here: a row has no room for the full logo (the guidelines' own
//     conditions for the Icon).
//
// The logo is ONLY EVER a link (owner ruling 2026-10-28, from YouTube's branding terms: "any logo used within an application must be
// clickable and link back to YouTube content"). So it has exactly two homes, and a test sweeps the source for any third
// (__tests__/youtube-icon.test.tsx):
//   * `YoutubeIconLink` — a connected channel's row on the Streaming page: the logo links to that channel on YouTube;
//   * the fixture panel's "Watch replay" link — a link to a YouTube replay, drawn inside that link (fixture-stream-panel.tsx).
// Every other YouTube row (the destination picker, a pasted-key row, the Connect YouTube buttons) wears `PlatformMark`'s neutral tile
// or nothing: a row or a button is not a link to YouTube, so it may not carry the logo.
//
// Decorative for assistive tech WHEN IT IS BESIDE ITS OWN TEXT (the replay link: "Watch replay" names it); the link that carries the
// logo alone (`YoutubeIconLink`) is named by `label` instead.

import { REFUSAL_FOCUS_RING } from "./refusal-focus";
import { youtubeChannelUrl } from "@/lib/youtube";

/** The artwork's own coordinate space (the official icon is 28.57 wide by 20 tall). */
const ART_W = 28.57;
const ART_H = 20;

/** Pixel heights per size. The brand minimum is 20; `sm` is exactly it. */
export const YOUTUBE_ICON_HEIGHT_PX = { sm: 20, md: 24 } as const;
export type YoutubeIconSize = keyof typeof YOUTUBE_ICON_HEIGHT_PX;

export function YoutubeIcon({ size }: { size: YoutubeIconSize }) {
  const height = YOUTUBE_ICON_HEIGHT_PX[size];
  const width = Math.round(((height * ART_W) / ART_H) * 100) / 100;
  return (
    <svg
      data-youtube-icon={size}
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${ART_W} ${ART_H}`}
      width={width}
      height={height}
      className="block shrink-0"
    >
      <path
        d="M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 2.24288e-07 14.285 0 14.285 0C14.285 0 5.35042 2.24288e-07 3.12323 0.597366C1.89323 0.926623 0.926623 1.89323 0.597366 3.12324C2.24288e-07 5.35042 0 10 0 10C0 10 2.24288e-07 14.6496 0.597366 16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z"
        fill="#FF0000"
      />
      <path d="M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z" fill="#FFFFFF" />
    </svg>
  );
}

/** The logo as a link to a connected channel on YouTube (owner 2026-10-28). The href is built here from the channel id, so the logo can
 *  only ever lead to YouTube. Named by `label` ("<channel> on YouTube", the caller's translation): the artwork itself stays hidden.
 *  Keyboard focus is the house violet-600 ring (REFUSAL_FOCUS_RING is that ring for any box that is not already a link or a button).
 *  The tap area is a 44 x 44 px `::before` centred on the icon, so it is a real target on a phone while the visible icon keeps
 *  its own size and clear space: the link itself adds no padding. */
export function YoutubeIconLink({ channelId, label, size }: { channelId: string; label: string; size: YoutubeIconSize }) {
  return (
    <a
      data-testid="youtube-logo-link"
      href={youtubeChannelUrl(channelId)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={`relative inline-flex shrink-0 rounded-sm before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] ${REFUSAL_FOCUS_RING}`}
    >
      <YoutubeIcon size={size} />
    </a>
  );
}
