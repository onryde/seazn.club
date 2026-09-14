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
  };
}

/** The public /present kiosk's "made for a TV" banner (N1d d6), in the same
 *  locale as the board. Public kiosk pages only; organiser boards get none. */
export interface KioskTvHintLabels {
  /** The banner region's accessible name. */
  region: string;
  message: string;
  phoneView: string;
  fullScreen: string;
  /** The ✕'s accessible label. */
  dismiss: string;
}

export function kioskTvHintLabels(locale: string | null | undefined): KioskTvHintLabels {
  const l = toLocale(locale);
  return {
    region: msgFor(l, "slideshow.tvHint.label"),
    message: msgFor(l, "slideshow.tvHint.message"),
    phoneView: msgFor(l, "slideshow.tvHint.phoneView"),
    fullScreen: msgFor(l, "slideshow.tvHint.fullScreen"),
    dismiss: msgFor(l, "tips.dismiss"),
  };
}
