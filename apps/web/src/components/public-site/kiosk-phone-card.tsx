"use client";
// The kiosk on a phone (OWNER RULING C1, 2026-09-15). Below the TV cut-off a
// board shows a full-screen card instead: "This board is made for a TV", Open
// the live page, and below it a small Show the board anyway that shows the
// board exactly as it is, broken phone layout included (the owner accepted
// that layout on this path). It replaces the "made for a TV" banner (N1d d6).
//
// Controller rulings (not the owner's):
// - The cut-off is Tailwind `lg` (1024px), the banner's old one: portrait
//   tablets get the card too.
// - CSS decides, never a JS width read. Both the card (`lg:hidden`) and the
//   board (`max-lg:hidden`) are in the server markup, so neither flashes at
//   any width, and a resize or rotation swaps them with no script.
// - The choice is remembered on the device, the way the banner's ✕ was:
//   localStorage, read after mount through `useSyncExternalStore` (server
//   snapshot "no choice"), every access wrapped so a throwing storage cannot
//   break the page. A device that chose the board sees the card only until
//   hydration reads the choice back.
// - A board chosen anyway carries no banner.
//
// Both boards mount it through <Slideshow>: the public /present kiosk (Open the
// live page goes to the hub) and the organiser noticeboard (it goes to the
// board's own console page). It sits OUTSIDE the slide, so it never rotates.
import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import type { KioskPhoneCardLabels } from "@/server/slideshow-labels";
import { readBoardChosen, writeBoardChosen } from "./kiosk-phone-card-logic";

/** Another tab's choice arrives as a `storage` event. This tab's own tap also
 *  sets state, since a browser that refuses the write still shows the board. */
function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

const localStorageOf = () => window.localStorage;
const isChosen = () => readBoardChosen(localStorageOf);
/** The server snapshot: no choice before mount. */
const beforeMount = () => false;

const TITLE_ID = "kiosk-phone-card-title";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink";

export function KioskPhoneGate({
  liveHref,
  labels,
  themeStyle,
  children,
}: {
  /** Where a phone should go instead of this board. */
  liveHref: string;
  labels: KioskPhoneCardLabels;
  /** The board's --ps-* palette, so the card wears the same colours. */
  themeStyle?: CSSProperties;
  /** The board. */
  children: ReactNode;
}) {
  const remembered = useSyncExternalStore(subscribeToStorage, isChosen, beforeMount);
  const [chosenNow, setChosenNow] = useState(false);
  const boardChosen = remembered || chosenNow;

  const showBoard = () => {
    writeBoardChosen(localStorageOf);
    setChosenNow(true);
  };

  return (
    <>
      {boardChosen ? null : (
        <section
          data-testid="kiosk-phone-card"
          aria-labelledby={TITLE_ID}
          style={themeStyle}
          className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-court px-6 py-12 text-center text-court-ink lg:hidden"
        >
          <span aria-hidden="true" className="text-6xl leading-none">
            📺
          </span>
          <h1
            id={TITLE_ID}
            className="max-w-sm break-words text-balance font-display text-4xl font-bold uppercase leading-tight tracking-tight"
          >
            {labels.title}
          </h1>
          <div className="flex w-full max-w-xs flex-col items-center gap-3">
            <Link
              href={liveHref}
              data-testid="kiosk-phone-card-open-live"
              className={`inline-flex min-h-11 w-full items-center justify-center break-words rounded-full bg-accent px-6 py-2.5 text-base font-semibold text-accent-ink transition hover:opacity-90 ${FOCUS}`}
            >
              {labels.openLive}
            </Link>
            <button
              type="button"
              onClick={showBoard}
              data-testid="kiosk-phone-card-show-board"
              className={`inline-flex min-h-11 items-center justify-center break-words rounded-full px-4 py-2 text-sm font-medium text-court-muted underline underline-offset-4 transition hover:text-court-ink ${FOCUS}`}
            >
              {labels.showBoard}
            </button>
          </div>
        </section>
      )}
      <div data-testid="kiosk-board" className={boardChosen ? undefined : "max-lg:hidden"}>
        {children}
      </div>
    </>
  );
}
