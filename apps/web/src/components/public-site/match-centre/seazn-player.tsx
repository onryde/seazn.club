"use client";
// Seazn-hosted video (Phase 1 Task 15; spec §5.1): the match page's player for a signed HLS address (the live, or the interim Cloudflare
// recording of a part). ONE `<video>` for the life of the component: a refreshed token arrives as a new `src` for the SAME session and
// is handed to the controller (seazn-playback.ts), which takes it without reloading, so the picture does not restart. A different part is a
// different recording and mounts its own player (the caller keys it).
//
// A signed address is a credential: it goes in `data-src` and nowhere else (hls.js owns the element's own `src`, and the controller
// sets it on a native one after hydration), and PostHog's DOM snapshots must never record it, so `ph-no-capture` is on the element and
// on its wrapper. The theme is the match card's: a black stage in the replay's frame (16:9, 200px floor), the house chip and note.
import { useEffect, useRef, useState } from "react";
import { createPlayback, type Playback } from "./seazn-playback";

/** The player's frame: 16:9 with a 200 px floor, dark. One authority for the box, so the island's reserved box (Phase 1 visual D1)
 *  is the player's box and the swap moves nothing. */
export const SEAZN_PLAYER_FRAME = "relative aspect-video min-h-[200px] w-full overflow-hidden rounded-xl bg-black";

export interface SeaznPlayerProps {
  /** The signed HLS manifest address. A new value for the same session is a token refresh. */
  src: string;
  /** The player's accessible name. */
  title: string;
  /** The sentence the player shows over the picture when it cannot play. */
  unavailable: string;
  /** Set for a live source: the chip drawn over the picture. */
  liveLabel?: string;
  /** The player gave up on its address (a fatal error): the island reads the route again for a fresh one. */
  onFatal?: () => void;
}

export function SeaznPlayer({ src, title, unavailable, liveLabel, onFatal }: SeaznPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const srcRef = useRef(src);
  const onFatalRef = useRef(onFatal);
  // The address a fatal error was raised for: the note shows while that address is the one on the player, and a fresh address clears
  // it with no state to reset.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    onFatalRef.current = onFatal;
  });

  // One controller per element, for as long as the element lives.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const playback = createPlayback(video, {
      onFatal: () => {
        setFailedSrc(srcRef.current);
        onFatalRef.current?.();
      },
    });
    playbackRef.current = playback;
    playback.setSource(srcRef.current);
    return () => {
      playback.dispose();
      playbackRef.current = null;
    };
  }, []);

  // Every address after the first: the same element, a new source.
  useEffect(() => {
    srcRef.current = src;
    playbackRef.current?.setSource(src);
  }, [src]);

  const failed = failedSrc === src;
  return (
    <div
      data-testid="seazn-player"
      className={`ph-no-capture ${SEAZN_PLAYER_FRAME}`}
    >
      <video
        ref={videoRef}
        data-src={src}
        aria-label={title}
        controls
        playsInline
        preload="none"
        className="ph-no-capture absolute inset-0 h-full w-full"
      />
      {liveLabel ? (
        <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white">
          <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
          {liveLabel}
        </span>
      ) : null}
      {failed ? (
        <p
          data-testid="seazn-player-unavailable"
          role="status"
          className="absolute inset-x-3 bottom-14 rounded-xl border border-white/15 bg-black/80 p-3 text-center text-sm text-court-ink"
        >
          {unavailable}
        </p>
      ) : null}
    </div>
  );
}
