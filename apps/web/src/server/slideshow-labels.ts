import "server-only";
// Every user-facing string of the noticeboard <Slideshow> (components/v2/
// slideshow.tsx), resolved on the server in ONE locale and handed to the
// client component as a prop (R10e u1). The public /present kiosk passes the
// org's `default_locale` — the same locale `buildPublicDivisionSlides` builds
// its slides in (N1c) — so a board's chrome and its slides cannot disagree.
//
// A plain object rather than a <DictProvider>: the kiosk tree has no provider,
// and `msgFor` bundles all four `ui` catalogs, which must never reach the
// browser. Kept out of slideshow-data.ts so the organiser pages' tests, which
// mock that module wholesale, keep resolving it.
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { intlLocaleFor } from "@/lib/public-date-locale";

/** The fixture statuses a slide row names in words. `in_play` is not one: a
 *  live row shows the pulsing `live` chip instead. */
export type SlideshowStatus =
  | "scheduled"
  | "decided"
  | "finalized"
  | "forfeited"
  | "abandoned"
  | "cancelled";

export interface SlideshowLabels {
  exit: string;
  back: string;
  live: string;
  emptyTitle: string;
  emptyBody: string;
  entrant: string;
  played: string;
  won: string;
  drawn: string;
  lost: string;
  points: string;
  /** Template: `{round}`. */
  round: string;
  vs: string;
  tbd: string;
  sponsors: string;
  /** Template: `{n}`, the 1-based slide number. */
  slide: string;
  /** Template: `{n}`, the rung number. */
  rung: string;
  final: string;
  winnersBracket: string;
  losersBracket: string;
  grandFinal: string;
  reset: string;
  qualifier1: string;
  eliminator: string;
  qualifier2: string;
  status: Record<SlideshowStatus, string>;
  /** The card a phone sees instead of the board (C1). */
  phoneCard: KioskPhoneCardLabels;
  /** The `Intl` locale the board's wall clock is written in: the board's own
   *  locale through `intlLocaleFor` (owner ruling 2026-09-16 — English as
   *  en-GB, a 24-hour clock). Not a string to render: without it the clock
   *  fell back to the BROWSER's locale, so an en-US TV read "02:30 PM". */
  clockLocale: string;
}

export function slideshowLabels(locale: string | null | undefined): SlideshowLabels {
  const l = toLocale(locale);
  // No vars: `msgFor` returns the raw template, so `{round}`/`{n}` survive
  // for the client to fill per row.
  const m = (key: Parameters<typeof msgFor>[1]) => msgFor(l, key);
  return {
    exit: m("slideshow.exit"),
    back: m("slideshow.back"),
    live: m("chip.live"),
    emptyTitle: m("slideshow.empty.title"),
    emptyBody: m("slideshow.empty.body"),
    entrant: m("slideshow.col.entrant"),
    played: m("slideshow.col.played"),
    won: m("slideshow.col.won"),
    drawn: m("slideshow.col.drawn"),
    lost: m("slideshow.col.lost"),
    points: m("slideshow.col.points"),
    round: m("slideshow.round"),
    vs: m("schedule.vs"),
    tbd: m("bracket.tbd"),
    sponsors: m("sponsors.title"),
    slide: m("slideshow.slideN"),
    rung: m("slideshow.rung"),
    final: m("bracket.round.final"),
    winnersBracket: m("bracket.winners"),
    losersBracket: m("bracket.losers"),
    grandFinal: m("bracket.grandFinal"),
    reset: m("bracket.reset"),
    qualifier1: m("bracket.round.qualifier1"),
    eliminator: m("bracket.round.eliminator"),
    qualifier2: m("bracket.round.qualifier2"),
    status: {
      scheduled: m("slideshow.status.scheduled"),
      // "Ended", not "Final": the latter collides with the Final ROUND (F2).
      decided: m("slideshow.status.ended"),
      finalized: m("slideshow.status.ended"),
      forfeited: m("slideshow.status.forfeit"),
      abandoned: m("slideshow.status.abandoned"),
      cancelled: m("slideshow.status.cancelled"),
    },
    phoneCard: {
      title: m("slideshow.phoneCard.title"),
      openLive: m("slideshow.phoneCard.openLive"),
      showBoard: m("slideshow.phoneCard.showBoard"),
    },
    clockLocale: intlLocaleFor(l),
  };
}

/** The card a board shows below the TV cut-off (OWNER RULING C1, 2026-09-15;
 *  `components/public-site/kiosk-phone-card.tsx`), in the board's locale. It
 *  replaced the "made for a TV" banner (N1d d6). The heading names the card's
 *  region, so it needs no label of its own. */
export interface KioskPhoneCardLabels {
  title: string;
  openLive: string;
  showBoard: string;
}
