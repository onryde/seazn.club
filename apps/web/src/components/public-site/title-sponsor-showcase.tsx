"use client";

// The Title sponsor's poster, on the public competition page (spec docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md
// §7). One client component draws it twice, told apart by `variant`:
//   • "panel": from `md` up, a 4:5 poster beside the hero (the hero mounts it in a `max-md:hidden` box), a micro-label above it
//     and the sponsor's name below it;
//   • "band": below `md`, a thumbnail, the whole "Presented by {sponsor}" sentence and a Visit button, in a strip under the hero
//     (mounted in an `md:hidden` box).
// The hero does not choose between them with JS: both are in the server's markup and CSS shows one, so there is no hydration
// guess and a resize needs no re-render. The hidden one's lazy images never download.
//
// ── WHAT IT OWNS, AND WHAT IT DOES NOT ─────────────────────────────────────────────────────────────────────────────────────────
// It takes finished SLIDES: every string is already resolved on the server (`titleSlides` in sponsors-board.tsx), so no
// dictionary crosses into this client bundle (`lib/hub-dict.ts` keeps `titleSponsor.*` out of the hub's slice on purpose). It
// does not import sponsors-board.tsx (that module is server-side: it may import types from `@/server/usecases/sponsors`), and
// nothing here reads a database or a server module. What it adds is behaviour: the rotation, its pauses and its stop.
//
// ── ROTATION (§7.6) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Slides crossfade every `TITLE_ROTATE_MS`. The rules for WHEN it turns are `autoRotates` in lib/sponsor-poster.ts, and this
// file only feeds it: a mouse over the showcase or focus inside it PAUSES (a finger does not: a tap on a phone is not a hover
// that ever ends); a dot tap STOPS it for the page view (D12, the WCAG 2.2.2 stop, so no separate pause button is drawn);
// reduced motion means it never starts. A dot still works under reduced motion: the visitor is then the one moving it.
// The timer is armed by an effect and advances state from INSIDE its callback, never synchronously in the effect.
//
// ── A POSTER THAT FAILS (D14) ──────────────────────────────────────────────────────────────────────────────────────────────────
// Any http(s) host is accepted at write time, and the image optimiser only serves the configured storage host, so a poster can
// 4xx. The browser's `error` event marks that poster URL broken (keyed by the URL, not the sponsor, so a sponsor who swaps in a
// new poster is not stuck on the card), and the slide then draws the same card a sponsor without a poster gets: the logo on
// white, or a monogram. The premium slot never shows a broken image. (This is the only thing that can catch it: the
// server cannot know the image will fail.)
//
// ── NAMES NEVER CLIP (D8) ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A sponsor's name is what they paid for, so every place it is drawn wraps to two lines and then ends in an ellipsis, with
// `min-w-0` down the whole chain (a 43-character name in a flex or grid child that cannot shrink put 106px of horizontal
// overflow on a phone once). The full text stays in `title` and in the accessible name.
//
// ── ACCESSIBILITY (§7.8) ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Two or more slides make a labelled carousel; one slide has no carousel role, no dots and no timer. A slide that is not on show
// is `aria-hidden` AND `inert` (never one without the other: hidden-but-focusable is a keyboard trap, focusable-but-unseen is
// a ghost link). The slide box says `aria-live="off"` while it turns by itself and `polite` otherwise.
//
// ── ONE LINK, ONLY WHEN THERE IS A URL (D6, §7.9) ──────────────────────────────────────────────────────────────────────────────
// `slide.href` is the tracked redirect (`/s/<id>?src=site`), or null when the sponsor gave no url. With none there is no anchor
// and no `href=""`; with one the anchor is the only interactive thing in its slide (the dots are siblings, never inside it).
import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { usePrefersReducedMotion } from "@/components/ui/use-prefers-reduced-motion";
import { POSTER_HEIGHT, POSTER_WIDTH, TITLE_ROTATE_MS, autoRotates, nextSlide } from "@/lib/sponsor-poster";

/** One Title sponsor, finished: every string is resolved (the hero builds these on the server, from the same rows as the sentence). */
export interface TitleSlide {
  id: string;
  name: string;
  /** The tracked redirect to the sponsor's url, or null when it gave none (then nothing is a link). */
  href: string | null;
  /** The sponsor's poster (a public CDN url), or null. */
  poster: string | null;
  /** The sponsor's logo, for the card a missing or failed poster falls back to. */
  logo: string | null;
  /** "Presented by {sponsor}", the whole sentence (never split: word order is the locale's). */
  sentence: string;
  /** The poster's alt text when it is not inside a link that already names the sponsor. */
  posterAlt: string;
  /** The dot's accessible name, "Show {sponsor}". */
  dotLabel: string;
}
export interface ShowcaseLabels {
  /** The micro-label over the panel's poster. */
  kicker: string;
  /** The carousel's accessible name. */
  group: string;
  /** The band's Visit button. */
  visit: string;
}
export type ShowcaseVariant = "panel" | "band";

/** The logo card's image is square-boxed and `object-contain`: the logo's own ratio is unknown. */
const LOGO_PX = 240;
const SIZES = {
  panel: { poster: "(min-width: 1024px) 300px, 220px", logo: "(min-width: 1024px) 180px, 132px" },
  band: { poster: "56px", logo: "34px" },
} as const;

/** The link's own attributes, one place: the redirect counts the click, the new tab keeps the reader's place, `sponsored` marks
 *  the paid placement for crawlers. */
const LINK_ATTRS = { target: "_blank", rel: "nofollow noopener sponsored" } as const;

/** What fills a slide: its poster, or the card when it has none or it failed. A plain function, not a component, so the one
 *  island above owns every hook and the tree stays flat. */
function slideFace(
  slide: TitleSlide,
  variant: ShowcaseVariant,
  failed: boolean,
  dotsBelow: boolean,
  onFailed: (poster: string) => void,
): ReactNode {
  if (!slide.poster || failed) return fallbackCard(slide, variant, dotsBelow);
  const poster = slide.poster; // the closure below cannot see the narrowing of `slide.poster`
  return (
    <Image
      data-testid="title-slide-poster"
      src={slide.poster}
      alt={variant === "band" || slide.href ? "" : slide.posterAlt}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      sizes={SIZES[variant].poster}
      className="h-full w-full object-cover"
      onError={() => onFailed(poster)}
    />
  );
}

/** The card a slide without a (working) poster shows: white, the logo centred at 60% of its width (the name beneath it in the
 *  panel only: the 56px thumbnail has no room, and the sentence beside it says the name), or a monogram when there is no logo.
 *  With dots (`dotsBelow`) the panel's capsule sits over the card's bottom 52px, so the content is centred in what is left of it:
 *  a name drawn under the logo would otherwise run under the capsule. */
function fallbackCard(slide: TitleSlide, variant: ShowcaseVariant, dotsBelow: boolean): ReactNode {
  const panel = variant === "panel";
  const glyph = [...slide.name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <div
      data-testid="title-slide-fallback"
      className={`flex h-full w-full min-w-0 flex-col items-center justify-center bg-white text-center ${panel ? `gap-3 px-4 pt-4 ${dotsBelow ? "pb-14" : "pb-4"}` : "p-1"}`}
    >
      {slide.logo ? (
        <Image
          src={slide.logo}
          alt=""
          width={LOGO_PX}
          height={LOGO_PX}
          sizes={SIZES[variant].logo}
          className="aspect-square w-3/5 object-contain"
        />
      ) : (
        <span
          data-testid="title-slide-monogram"
          aria-hidden
          className={`grid aspect-square w-3/5 place-items-center bg-accent font-display font-bold uppercase text-accent-ink ${panel ? "rounded-2xl text-5xl" : "rounded-md text-xl"}`}
        >
          {glyph}
        </span>
      )}
      {panel ? (
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold leading-tight text-zinc-900">{slide.name}</span>
      ) : null}
    </div>
  );
}

export function TitleSponsorShowcase({
  slides,
  labels,
  variant,
}: {
  slides: readonly TitleSlide[];
  labels: ShowcaseLabels;
  variant: ShowcaseVariant;
}): ReactNode {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const reducedMotion = usePrefersReducedMotion();

  const count = slides.length;
  const rotating = autoRotates({ count, reducedMotion, paused: hovered || focused, stopped });
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setIndex((i) => nextSlide(i, count)), TITLE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotating, count]);

  if (count === 0) return null;
  // The slides can change under a showing index (a refresh that drops a sponsor): fall back to the first, never to nothing.
  const at = index < count ? index : 0;
  const current = slides[at]!;
  const panel = variant === "panel";
  // Broken is a set of poster URLs, and it only grows: each failure adds to what the earlier ones left.
  const markBroken = (poster: string) => setBroken((prev) => (prev.has(poster) ? prev : new Set(prev).add(poster)));
  const isBroken = (slide: TitleSlide) => slide.poster !== null && broken.has(slide.poster);

  const Root = count >= 2 ? "section" : "div";
  const carousel = count >= 2 ? { "aria-roledescription": "carousel", "aria-label": labels.group } : {};
  const live = count >= 2 ? (rotating ? "off" : "polite") : undefined;

  const slideProps = (slide: TitleSlide, i: number) => ({
    "data-testid": "title-slide",
    "data-sponsor-id": slide.id,
    "data-current": i === at ? "true" : "false",
    "aria-hidden": i === at ? undefined : (true as const),
    inert: i !== at,
  });
  const fade = (i: number) =>
    `transition-opacity duration-700 motion-reduce:transition-none ${i === at ? "opacity-100" : "pointer-events-none opacity-0"}`;

  // The panel's capsule is centred with `inset-x-0 mx-auto w-fit`, NOT `left-1/2 -translate-x-1/2`: a box pinned at `left: 50%`
  // may only be as wide as the half that remains, so four 44px dots (176px) wrapped into a 3 + 1 blob on a 300px poster.
  const dots =
    count >= 2 ? (
      <div
        data-testid="title-showcase-dots"
        className={
          panel
            ? "absolute inset-x-0 bottom-2 mx-auto flex w-fit max-w-[calc(100%-1rem)] flex-wrap justify-center rounded-full bg-black/70"
            : "-mb-2 flex flex-wrap justify-center"
        }
      >
        {slides.map((slide, i) => (
          <button
            key={slide.id}
            type="button"
            data-testid="title-showcase-dot"
            aria-label={slide.dotLabel}
            aria-current={i === at ? "true" : undefined}
            onClick={() => {
              // Show that sponsor, and take over: the rotation stays off for this page view (D12).
              setIndex(i);
              setStopped(true);
            }}
            className="grid h-11 w-11 place-items-center rounded-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
          >
            <span
              aria-hidden
              data-testid="title-showcase-dot-mark"
              className={`block h-2 rounded-full transition-all motion-reduce:transition-none ${i === at ? "w-5 bg-white" : "w-2 bg-white/50"}`}
            />
          </button>
        ))}
      </div>
    ) : null;

  return (
    <Root
      data-testid="title-showcase"
      data-variant={variant}
      {...carousel}
      className={`min-w-0 ${panel ? "flex flex-col gap-2" : ""}`}
      onPointerEnter={(e) => {
        // A mouse hovers; a finger only taps, and a tap's "leave" never comes, so it must not pause for good.
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving between the showcase's own controls blurs one and focuses the next: still inside.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {panel ? (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">{labels.kicker}</p>
          <div className="relative">
            <div
              aria-live={live}
              className="relative aspect-[4/5] overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-white/18"
            >
              {slides.map((slide, i) => (
                <div key={slide.id} {...slideProps(slide, i)} className={`absolute inset-0 ${fade(i)}`}>
                  {slide.href ? (
                    <a
                      href={slide.href}
                      {...LINK_ATTRS}
                      aria-label={slide.name}
                      className="block h-full w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-white"
                    >
                      {slideFace(slide, variant, isBroken(slide), count >= 2, markBroken)}
                    </a>
                  ) : (
                    slideFace(slide, variant, isBroken(slide), count >= 2, markBroken)
                  )}
                </div>
              ))}
            </div>
            {dots}
          </div>
          {/* The name of the sponsor on show. Two lines of height are reserved (2 x leading-tight = 2.5em), so a one-line name
              does not shift the hero's layout when the rotation reaches a long one. */}
          <p
            data-testid="title-slide-caption"
            title={current.name}
            className="line-clamp-2 min-h-[2.5em] min-w-0 break-words text-center font-display text-lg font-semibold uppercase leading-tight tracking-tight text-court-ink"
          >
            {current.name}
          </p>
        </>
      ) : (
        <>
          {/* Every slide is a whole row (thumbnail, sentence, Visit), stacked in ONE grid cell, so the cell is as tall as the
              tallest row and the rotation moves nothing below it. */}
          <div aria-live={live} className="grid min-w-0">
            {slides.map((slide, i) => {
              const rowCols = slide.href ? "grid-cols-[56px_minmax(0,1fr)_auto]" : "grid-cols-[56px_minmax(0,1fr)]";
              const row = (
                <>
                  <div className="relative aspect-[4/5] w-14 overflow-hidden rounded-md bg-white ring-1 ring-white/20">
                    {slideFace(slide, variant, isBroken(slide), count >= 2, markBroken)}
                  </div>
                  <span
                    data-testid="title-band-sentence"
                    title={slide.sentence}
                    className="line-clamp-2 min-w-0 break-words font-display text-base font-semibold uppercase leading-tight tracking-tight"
                  >
                    {slide.sentence}
                  </span>
                  {slide.href ? (
                    <span
                      data-testid="title-band-visit"
                      className="inline-flex min-h-11 items-center rounded-lg bg-surface px-3.5 text-sm font-semibold text-accent-strong shadow"
                    >
                      {labels.visit}
                    </span>
                  ) : null}
                </>
              );
              return (
                <div key={slide.id} {...slideProps(slide, i)} className={`grid min-w-0 items-center [grid-area:1/1] ${fade(i)}`}>
                  {slide.href ? (
                    <a
                      href={slide.href}
                      {...LINK_ATTRS}
                      className={`grid min-w-0 ${rowCols} items-center gap-3 rounded-lg transition hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-court-ink`}
                    >
                      {row}
                    </a>
                  ) : (
                    <div className={`grid min-w-0 ${rowCols} items-center gap-3`}>{row}</div>
                  )}
                </div>
              );
            })}
          </div>
          {dots}
        </>
      )}
    </Root>
  );
}
