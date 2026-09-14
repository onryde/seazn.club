"use client";
// The public /present kiosk's "made for a TV" hint (spectator N1d d6).
//
// The kiosk is a board for a screen across a hall. Opened on a phone it is that
// board squeezed into 390px, so on a narrow viewport it pins this banner over
// the top: what the page is for, a link to the hub (the page made for a phone),
// Full screen where the browser has the API, and a ✕ that is remembered. The
// slides keep running underneath.
//
// DECIDED AFTER MOUNT. Width, the stored dismissal and the Fullscreen API are
// browser facts, read through `useSyncExternalStore` with a server snapshot of
// "nothing to show". The server render and hydration's first client pass both
// render nothing, so the markup cannot mismatch, and the browser's answer
// arrives on the pass after. (A client-side navigation onto the kiosk has no
// server markup to match, so React reads the browser's answer at once.)
//
// Public /present pages only: they hand it to the board as `notice`. The
// organiser noticeboards never do. Every string arrives resolved in the org's
// locale (`kioskTvHintLabels`), as the board's own `labels` do.
import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { KioskTvHintLabels } from "@/server/slideshow-labels";
import {
  KIOSK_TV_HINT_QUERY,
  canRequestFullscreen,
  readTvHintDismissed,
  shouldShowTvHint,
  writeTvHintDismissed,
} from "./kiosk-tv-hint-logic";

/** The legacy half of `MediaQueryList`: iOS Safari 13 and older have only this. */
interface LegacyMediaQueryList {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** Subscribe to the viewport crossing the query's width, which a resize or a
 *  rotation does. Exported for its own test: a static render never subscribes.
 *  An old Safari has no `addEventListener` on the list, only `addListener`; a
 *  browser with neither gets no subscription, and the banner keeps the width it
 *  read first. It must never throw: it runs in an effect, and a throw there
 *  takes the whole kiosk to the error screen. */
export function subscribeToNarrowViewport(onChange: () => void): () => void {
  const query = window.matchMedia(KIOSK_TV_HINT_QUERY) as MediaQueryList & LegacyMediaQueryList;
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  if (typeof query.addListener === "function") {
    query.addListener(onChange);
    return () => query.removeListener?.(onChange);
  }
  return () => undefined;
}

/** Another tab's ✕ arrives as a `storage` event. This tab's own ✕ also sets
 *  state, since a browser that refuses the write still hides it for the visit. */
function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Nothing in the page can add or remove the Fullscreen API. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

const isNarrow = () => window.matchMedia(KIOSK_TV_HINT_QUERY).matches;
const localStorageOf = () => window.localStorage;
const isDismissed = () => readTvHintDismissed(localStorageOf);
const hasFullscreen = () => canRequestFullscreen(document);
/** The server snapshot for all three: nothing to show before mount. */
const beforeMount = () => false;

const CONTROL =
  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink";

export function KioskTvHint({ hubHref, labels }: { hubHref: string; labels: KioskTvHintLabels }) {
  const narrow = useSyncExternalStore(subscribeToNarrowViewport, isNarrow, beforeMount);
  const remembered = useSyncExternalStore(subscribeToStorage, isDismissed, beforeMount);
  const fullscreen = useSyncExternalStore(subscribeToNothing, hasFullscreen, beforeMount);
  const [closed, setClosed] = useState(false);

  if (!shouldShowTvHint({ narrow, dismissed: remembered || closed })) return null;

  const dismiss = () => {
    writeTvHintDismissed(localStorageOf);
    setClosed(true);
  };
  const goFullScreen = () => {
    // Rejects where the page may not go full screen (an iframe without the
    // permission); there is nothing to tell a spectator then.
    void Promise.resolve(document.documentElement.requestFullscreen()).catch(() => undefined);
  };

  return (
    <div
      role="region"
      aria-label={labels.region}
      data-testid="kiosk-tv-hint"
      className="fixed inset-x-0 top-0 z-50 border-b border-white/15 bg-court/95 text-court-ink shadow-lg backdrop-blur"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <p className="flex min-w-0 flex-[1_1_12rem] items-center gap-2 text-base font-medium">
          <span aria-hidden="true">📺</span>
          <span className="min-w-0 break-words">{labels.message}</span>
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            href={hubHref}
            data-testid="kiosk-tv-hint-phone-view"
            className={`${CONTROL} bg-court-ink px-4 text-court hover:opacity-90`}
          >
            {labels.phoneView}
          </Link>
          {fullscreen ? (
            <button
              type="button"
              onClick={goFullScreen}
              data-testid="kiosk-tv-hint-full-screen"
              className={`${CONTROL} bg-white/10 px-4 ring-1 ring-inset ring-white/20 hover:bg-white/20`}
            >
              {labels.fullScreen}
            </button>
          ) : null}
          <button
            type="button"
            onClick={dismiss}
            aria-label={labels.dismiss}
            data-testid="kiosk-tv-hint-dismiss"
            className={`${CONTROL} min-w-11 text-court-muted hover:bg-white/10 hover:text-court-ink`}
          >
            <X aria-hidden="true" className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
