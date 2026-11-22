"use client";
// Seazn-hosted video (Phase 2 Task 25): the replay host's player for one part of a Seazn replay — the host's own embed page in an
// <iframe>, in the player's frame (16:9, 200 px floor, dark: SEAZN_PLAYER_FRAME), so a part that turns from the interim recording
// to the host's copy keeps its box.
//
// The address is a credential (its `token` and `expires` are the host's signed query), so it is set on the element after hydration and
// nowhere else: never in the server markup, a label or a title, and `ph-no-capture` is on the frame and on its box, so PostHog's DOM
// snapshots never record it (the network recording's copy is masked by lib/scrub-score-url.ts).
//
// The host checks the token when the frame LOADS, and never again (plan B8), so the frame loads ONE address per mount
// (`createEmbedLoad`): a later answer's fresh token is not a reason to touch a playing frame (a new `src` restarts the video). An
// address whose token has already passed is not loaded at all: the frame asks the island for a fresh read (`onStale`) and loads the
// next address it is given, whatever its expiry, so a viewer's wrong clock costs one read, never a frame that asks for ever.
import { useEffect, useRef } from "react";
import { SEAZN_PLAYER_FRAME } from "./seazn-player";

/** The element the address is set on: an HTMLIFrameElement in the browser. */
export interface EmbedFrameElement { src: string }
export interface EmbedLoad {
  /** The island's current address for this part. Loaded when it is the first fresh one; otherwise see the header. */
  offer: (src: string, expiresAt: string) => void;
}

export function createEmbedLoad(frame: EmbedFrameElement, { onStale, now }: { onStale: () => void; now: () => number }): EmbedLoad {
  let loaded = false;
  let asked = false;
  let last: string | null = null;
  return {
    offer(src, expiresAt) {
      if (loaded || src === last) return;   // one load per mount; the same address again (a re-render) is nothing new
      last = src;
      const expires = Date.parse(expiresAt);
      const passed = !Number.isFinite(expires) || expires <= now();
      if (passed && !asked) {
        asked = true;
        onStale();
        return;
      }
      loaded = true;
      frame.src = src;
    },
  };
}

export interface SeaznReplayFrameProps {
  /** The host's signed embed address. A new value for the same part is a refreshed token: not loaded once a frame is playing. */
  src: string;
  /** When its token lapses (ISO). */
  expiresAt: string;
  /** The frame's accessible name. */
  title: string;
  /** The address's token has passed: the island reads the route again for a fresh one. */
  onStale: () => void;
}

export function SeaznReplayFrame({ src, expiresAt, title, onStale }: SeaznReplayFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadRef = useRef<EmbedLoad | null>(null);

  // The loader asks (`onStale`) only on the first address it is offered — it loads or asks then, and never asks again — so the callback
  // it is built with is the one that address came with.
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    loadRef.current ??= createEmbedLoad(frame, { onStale, now: Date.now });
    loadRef.current.offer(src, expiresAt);
  }, [src, expiresAt, onStale]);

  return (
    <div data-testid="seazn-replay-frame-box" className={`ph-no-capture ${SEAZN_PLAYER_FRAME}`}>
      <iframe
        ref={frameRef}
        data-testid="seazn-replay-frame"
        title={title}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        className="ph-no-capture absolute inset-0 h-full w-full border-0"
      />
    </div>
  );
}
