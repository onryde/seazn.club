// Title sponsor poster, Task 4: the showcase (spec docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §7.2-§7.9).
//
// Two kinds of test, because the component is both markup and behaviour and `apps/web` vitest has no DOM:
//   • MARKUP cases read real React's `renderToStaticMarkup` (the markup the server sends): which elements exist, which attributes
//     they carry, what an unlinked slide does NOT draw.
//   • BEHAVIOUR cases drive the island through the hook harness (`_hook-harness.tsx`, `hydrate: true`, `window.matchMedia`
//     stubbed) under fake timers: rotation, the hover / focus pause, reduced motion, the dot tap's stop, a poster that fails.
//     The handlers are invoked the way the browser would (a pointer event with a `pointerType`, a blur with a `relatedTarget`),
//     and the tree is re-read after each one: the harness returns functions, never frozen values.
//
// Sport-agnostic (a sponsor placement): no sport sweep, one reason, stated once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { POSTER_HEIGHT, POSTER_WIDTH, TITLE_ROTATE_MS } from "@/lib/sponsor-poster";
import { psColour } from "./_tailwind-contrast";
import {
  TitleSponsorShowcase,
  type ShowcaseLabels,
  type ShowcaseVariant,
  type TitleSlide,
} from "../title-sponsor-showcase";

// ── fixtures: pairwise distinct in every field a test reads ─────────────────────────────────────────────────────────────────────

/** Poster + logo + a link: the full slide. */
const A: TitleSlide = {
  id: "sp-aaa",
  name: "Northbank Bank",
  href: "/s/sp-aaa?src=site",
  poster: "https://cdn.example/storage/a-poster.png",
  logo: "https://cdn.example/storage/a-logo.png",
  sentence: "Presented by Northbank Bank",
  posterAlt: "Northbank Bank poster",
  dotLabel: "Show Northbank Bank",
};
/** No poster, a logo, no link: the logo card, unlinked. */
const B: TitleSlide = {
  id: "sp-bbb",
  name: "Kestrel Kit",
  href: null,
  poster: null,
  logo: "https://cdn.example/storage/b-logo.png",
  sentence: "Presented by Kestrel Kit",
  posterAlt: "Kestrel Kit poster",
  dotLabel: "Show Kestrel Kit",
};
/** A poster and a link, no logo. */
const C: TitleSlide = {
  id: "sp-ccc",
  name: "Halston Tyres",
  href: "/s/sp-ccc?src=site",
  poster: "https://cdn.example/storage/c-poster.png",
  logo: null,
  sentence: "Presented by Halston Tyres",
  posterAlt: "Halston Tyres poster",
  dotLabel: "Show Halston Tyres",
};
/** Neither a poster nor a logo: the monogram card. */
const D: TitleSlide = {
  id: "sp-ddd",
  name: "Vale Physio",
  href: null,
  poster: null,
  logo: null,
  sentence: "Presented by Vale Physio",
  posterAlt: "Vale Physio poster",
  dotLabel: "Show Vale Physio",
};
const LONG_NAME = "Northbank Regional Building Society & Trust";
/** The 43-character name that once put 106px of overflow on a phone. */
const LONG: TitleSlide = {
  id: "sp-long",
  name: LONG_NAME,
  href: "/s/sp-long?src=site",
  poster: null,
  logo: "https://cdn.example/storage/long-logo.png",
  sentence: `Presented by ${LONG_NAME}`,
  posterAlt: `${LONG_NAME} poster`,
  dotLabel: `Show ${LONG_NAME}`,
};

const LABELS: ShowcaseLabels = { kicker: "Title sponsor", group: "Title sponsors", visit: "Visit" };
const THREE = [A, B, C] as const;

type Over = { slides?: readonly TitleSlide[]; variant?: ShowcaseVariant };

const html = (over: Over = {}): string =>
  renderToStaticMarkup(
    <TitleSponsorShowcase slides={over.slides ?? THREE} labels={LABELS} variant={over.variant ?? "panel"} />,
  );

// ── markup readers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The attribute string of every element carrying `data-testid="<testid>"`, in document order. */
function attrsOf(markup: string, testid: string): string[] {
  return [...markup.matchAll(new RegExp(`<[a-z0-9]+\\b([^>]*\\bdata-testid="${testid}"[^>]*)>`, "g"))].map((m) => m[1]!);
}
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}
/** The element's whole markup (opening tag to its matching close), the nth one carrying that test id. */
function elementHtml(markup: string, testid: string, nth = 0): string {
  const open = [...markup.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bdata-testid="${testid}"[^>]*>`, "g"))][nth];
  if (!open) throw new Error(`no element #${nth} with data-testid="${testid}"`);
  const tokens = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  tokens.lastIndex = open.index;
  let depth = 0;
  for (let tok = tokens.exec(markup); tok; tok = tokens.exec(markup)) {
    depth += tok[1] ? -1 : 1;
    if (depth === 0) return markup.slice(open.index, tokens.lastIndex);
  }
  throw new Error(`unbalanced markup under data-testid="${testid}"`);
}
const count = (markup: string, re: RegExp): number => markup.match(re)?.length ?? 0;

// ── WCAG relative luminance, for the dots (1.4.11) ──────────────────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const lum = ([r, g, b]: Rgb): number => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (x: Rgb, y: Rgb): number => {
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** `top` at `alpha` over `under`. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => [0, 1, 2].map((i) => alpha * top[i]! + (1 - alpha) * under[i]!) as unknown as Rgb;
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;

// ── markup ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("TitleSponsorShowcase: markup", () => {
  it("empty slides render nothing, in both variants", () => {
    expect(html({ slides: [] })).toBe("");
    expect(html({ slides: [], variant: "band" })).toBe("");
  });

  it("one slide: no dots, no carousel roles, no capsule", () => {
    for (const variant of ["panel", "band"] as const) {
      const h = html({ slides: [A], variant });
      expect(attrsOf(h, "title-showcase"), `${variant}: the root is drawn`).toHaveLength(1);
      expect(h, variant).not.toContain(`data-testid="title-showcase-dots"`);
      expect(h, variant).not.toContain(`data-testid="title-showcase-dot"`);
      expect(h, variant).not.toContain("aria-roledescription");
      expect(h, variant).not.toContain("aria-live");
      expect(h, variant).not.toContain("bg-black/");
      // Its one slide is the current one and is reachable.
      const slide = attrsOf(h, "title-slide")[0]!;
      expect(attr(slide, "data-current")).toBe("true");
      expect(slide).not.toMatch(/\baria-hidden\b/);
      expect(slide).not.toMatch(/\binert\b/);
    }
  });

  it("three slides: a labelled carousel, three 44px dots labelled 'Show <name>', the first aria-current; only slide 0 is reachable (counts reported)", () => {
    const h = html();
    const root = attrsOf(h, "title-showcase")[0]!;
    expect(attr(root, "data-variant")).toBe("panel");
    expect(attr(root, "aria-roledescription")).toBe("carousel");
    expect(attr(root, "aria-label")).toBe(LABELS.group);

    const dots = [...h.matchAll(/<button\b([^>]*\bdata-testid="title-showcase-dot"[^>]*)>/g)].map((m) => m[1]!);
    expect(dots, "dots drawn").toHaveLength(THREE.length);
    dots.forEach((d, i) => {
      expect(attr(d, "aria-label"), `dot ${i}`).toBe(THREE[i]!.dotLabel);
      expect(d, `dot ${i} is a 44px target`).toMatch(/\bh-11 w-11\b/);
      expect(d, `dot ${i} is a button, not a submit`).toContain('type="button"');
      // The current dot, and only the current dot.
      expect(attr(d, "aria-current"), `dot ${i}`).toBe(i === 0 ? "true" : undefined);
    });
    expect(count(h, /aria-current="true"/g), "aria-current dots").toBe(1);

    const slides = attrsOf(h, "title-slide");
    expect(slides, "slides drawn").toHaveLength(THREE.length);
    let reachable = 0;
    slides.forEach((s, i) => {
      expect(attr(s, "data-sponsor-id")).toBe(THREE[i]!.id);
      const current = attr(s, "data-current") === "true";
      expect(current, `slide ${i} current`).toBe(i === 0);
      const hidden = /\baria-hidden="true"/.test(s);
      const inert = /\binert=""/.test(s);
      // Hidden slides are out of the tab order AND the accessibility tree; the current one is in both. Never half of either.
      expect(hidden, `slide ${i} aria-hidden`).toBe(!current);
      expect(inert, `slide ${i} inert`).toBe(!current);
      expect(s, `slide ${i} opacity`).toContain(current ? "opacity-100" : "opacity-0");
      expect(s, `slide ${i} crossfade`).toMatch(/transition-opacity duration-700 motion-reduce:transition-none/);
      if (!hidden && !inert) reachable += 1;
    });
    expect(reachable, "slides reachable by keyboard and screen reader").toBe(1);
  });

  it("a linked slide is ONE <a> to the tracked redirect, a new tab, rel sponsored; an unlinked one has no <a> and no href= at all (panel and band)", () => {
    let checked = 0;
    for (const variant of ["panel", "band"] as const) {
      const linked = html({ slides: [A], variant });
      expect(count(linked, /<a\b/g), `${variant} linked: one anchor`).toBe(1);
      expect(linked, variant).toContain('href="/s/sp-aaa?src=site"');
      expect(linked, variant).toContain('target="_blank"');
      expect(linked, variant).toMatch(/rel="nofollow noopener sponsored"/);
      checked += 1;

      const unlinked = html({ slides: [B], variant });
      expect(unlinked, `${variant} unlinked: no anchor`).not.toContain("<a ");
      expect(unlinked, `${variant} unlinked: no href at all`).not.toContain("href=");
      expect(unlinked, `${variant} unlinked still draws its slide`).toContain('data-sponsor-id="sp-bbb"');
      checked += 1;
    }
    expect(checked, "cases checked").toBe(4);
  });

  it("a mixed rotation links the linked slides and only those: no empty href anywhere", () => {
    for (const variant of ["panel", "band"] as const) {
      const h = html({ slides: [A, B, C], variant });
      expect(count(h, /<a\b/g), `${variant}: anchors`).toBe(2);
      expect(h, variant).not.toContain('href=""');
      const slideB = elementHtml(h, "title-slide", 1);
      expect(slideB, `${variant}: the unlinked slide in the middle`).toContain('data-sponsor-id="sp-bbb"');
      expect(slideB, variant).not.toContain("<a ");
    }
  });

  it("the panel's link is named by the sponsor; an unlinked poster is named by its alt; the band's thumbnail has an empty alt", () => {
    const linked = html({ slides: [A] });
    expect(attr(/<a\b([^>]*)>/.exec(linked)![1]!, "aria-label")).toBe(A.name);
    // The link carries the name, so the poster inside it adds no second one.
    expect(attr(attrsOf(linked, "title-slide-poster")[0]!, "alt")).toBe("");

    const unlinkedPoster = { ...C, href: null } satisfies TitleSlide;
    expect(html({ slides: [unlinkedPoster] })).toContain(`alt="${esc(unlinkedPoster.posterAlt)}"`);

    const band = html({ slides: [A], variant: "band" });
    expect(band).toContain('alt=""');
    expect(band).not.toContain(`alt="${A.posterAlt}"`);
  });

  it("the poster is a lazy next/image at the contract's intrinsic size, with the variant's sizes", () => {
    const panel = html({ slides: [A] });
    expect(panel).toContain(`width="${POSTER_WIDTH}"`);
    expect(panel).toContain(`height="${POSTER_HEIGHT}"`);
    expect(panel).toContain('sizes="(min-width: 1024px) 300px, 220px"');
    expect(panel).toContain('loading="lazy"');
    expect(panel).toContain("object-cover");
    // The image is optimised through the app's own route, the poster URL encoded into it.
    expect(panel).toContain(`/_next/image?url=${encodeURIComponent(A.poster!)}`);
    const band = html({ slides: [A], variant: "band" });
    expect(band).toContain('sizes="56px"');
    expect(band).toContain('loading="lazy"');
  });

  it("band: Visit only on a linked slide; the sentence is the given string WHOLE, clamped to two lines, title = the sentence", () => {
    const linked = html({ slides: [A], variant: "band" });
    const visit = elementHtml(linked, "title-band-visit");
    expect(visit).toContain(LABELS.visit);
    expect(visit, "Visit is a span inside the one anchor, never a second link").not.toContain("<a");
    expect(count(linked, /data-testid="title-band-visit"/g)).toBe(1);

    const unlinked = html({ slides: [B], variant: "band" });
    expect(unlinked).not.toContain('data-testid="title-band-visit"');
    expect(unlinked).not.toContain(LABELS.visit);

    // The unlinked row is a plain block, and carries no pointer affordance of a link.
    expect(unlinked).not.toContain("<a ");

    for (const slide of [A, B, LONG]) {
      const h = html({ slides: [slide], variant: "band" });
      const attrs = attrsOf(h, "title-band-sentence")[0]!;
      expect(attr(attrs, "title"), slide.name).toBe(esc(slide.sentence));
      expect(attrs, slide.name).toMatch(/\bline-clamp-2\b/);
      expect(attrs, slide.name).toMatch(/\bbreak-words\b/);
      expect(attrs, slide.name).toMatch(/\bmin-w-0\b/);
      // WHOLE: the sentence in one text node, never split into a label above and a name below.
      expect(elementHtml(h, "title-band-sentence")).toContain(`>${esc(slide.sentence)}</`);
    }
  });

  it("fallback: no poster + logo is a white card with the logo (the name too, in the panel only); no logo is a monogram of the first letter", () => {
    const panel = html({ slides: [B] });
    const card = elementHtml(panel, "title-slide-fallback");
    expect(attrsOf(panel, "title-slide-fallback")[0]).toMatch(/\bbg-white\b/);
    expect(card).toContain(encodeURIComponent(B.logo!));
    expect(card, "the panel's card names the sponsor").toContain(B.name);
    expect(panel, "no poster image is drawn for it").not.toContain('data-testid="title-slide-poster"');

    const band = html({ slides: [B], variant: "band" });
    const bandCard = elementHtml(band, "title-slide-fallback");
    expect(bandCard).toContain(encodeURIComponent(B.logo!));
    expect(bandCard, "in the 56px thumbnail the logo is alone").not.toContain(B.name);

    const mono = html({ slides: [D] });
    const monoCard = elementHtml(mono, "title-slide-fallback");
    expect(monoCard).not.toContain("<img");
    expect(elementHtml(mono, "title-slide-monogram")).toMatch(/>V<\/span>$/);
    expect(monoCard, "the panel's monogram card names the sponsor too").toContain(D.name);
    // A name that begins in lower case, or with a surrogate pair, or with nothing, still draws exactly one glyph and never throws.
    for (const [name, glyph] of [
      ["kestrel", "K"],
      ["  🎾 Tennis", "🎾"],
      ["", "?"],
    ] as const) {
      const h = html({ slides: [{ ...D, name }] });
      expect(elementHtml(h, "title-slide-monogram"), JSON.stringify(name)).toMatch(new RegExp(`>${glyph}</span>$`));
    }
  });

  it("a mixed set draws a poster for the slides that have one and a card for those that do not (counts reported)", () => {
    const h = html({ slides: [A, B, C, D] });
    expect(count(h, /data-testid="title-slide-poster"/g), "posters").toBe(2);
    expect(count(h, /data-testid="title-slide-fallback"/g), "fallback cards").toBe(2);
    expect(count(h, /data-testid="title-slide"/g), "slides").toBe(4);
  });

  it("panel caption: the current name, two lines then an ellipsis, break-words, title = the full name, min-w-0 down the chain", () => {
    const h = html({ slides: [LONG, A] });
    const caption = attrsOf(h, "title-slide-caption");
    expect(caption, "one caption, not one per slide").toHaveLength(1);
    expect(attr(caption[0]!, "title")).toBe(esc(LONG.name));
    expect(caption[0]).toMatch(/\bline-clamp-2\b/);
    expect(caption[0]).toMatch(/\bbreak-words\b/);
    expect(caption[0]).toMatch(/\bmin-w-0\b/);
    expect(elementHtml(h, "title-slide-caption")).toContain(esc(LONG.name));
    // Two lines of height are reserved, so a one-line name does not move the layout when the rotation reaches a long one.
    expect(caption[0]).toMatch(/\bmin-h-\[2\.5em\]/);
    // The chain: the root carries min-w-0 as well, and the band (no caption) has no `title-slide-caption` at all.
    expect(attrsOf(h, "title-showcase")[0]).toMatch(/\bmin-w-0\b/);
    expect(html({ slides: [LONG], variant: "band" })).not.toContain("title-slide-caption");
  });

  it("the panel draws the micro-label; the band does not", () => {
    expect(html({ slides: [A] })).toContain(LABELS.kicker);
    expect(html({ slides: [A], variant: "band" })).not.toContain(LABELS.kicker);
  });

  it("dot contrast clears 3:1 (WCAG 1.4.11) over a white AND a black poster pixel, active and inactive, read from the shipped classes (count 4)", () => {
    const h = html();
    const capsule = attrsOf(h, "title-showcase-dots")[0]!;
    const capsuleAlpha = Number(/\bbg-black\/(\d+)\b/.exec(capsule)?.[1]) / 100;
    expect(capsuleAlpha, "the capsule's dark strip is in the shipped classes").toBeGreaterThan(0);
    const dotSpans = [...h.matchAll(/<span\b([^>]*\bdata-testid="title-showcase-dot-mark"[^>]*)>/g)].map((m) => m[1]!);
    const inactive = dotSpans.find((s) => /\bbg-white\/\d+\b/.test(s));
    const active = dotSpans.find((s) => /\bbg-white\b(?!\/)/.test(s));
    expect(inactive, "an inactive dot mark").toBeDefined();
    expect(active, "an active dot mark").toBeDefined();
    const inactiveAlpha = Number(/\bbg-white\/(\d+)\b/.exec(inactive!)![1]) / 100;

    let checked = 0;
    for (const [pixelName, pixel] of [["white", WHITE], ["black", BLACK]] as const) {
      const strip = over(BLACK, capsuleAlpha, pixel);
      for (const [dotName, dot] of [["inactive", over(WHITE, inactiveAlpha, strip)], ["active", WHITE]] as const) {
        expect(ratio(dot, strip), `${dotName} dot over a ${pixelName} poster pixel`).toBeGreaterThanOrEqual(3);
        checked += 1;
      }
    }
    expect(checked, "contrast cases checked").toBe(4);
  });

  it("the panel's capsule is centred by its own width, never pinned at left:50% (which wrapped four dots into a 3 + 1 blob in the browser)", () => {
    const capsule = attrsOf(html({ slides: [A, B, C, D] }), "title-showcase-dots")[0]!;
    for (const token of ["inset-x-0", "mx-auto", "w-fit", "bottom-2", "rounded-full"]) expect(capsule, token).toMatch(new RegExp(`(?:^|[\\s"])${token}(?=[\\s"])`));
    expect(capsule).not.toMatch(/left-1\/2/);
    expect(capsule).not.toMatch(/-translate-x-1\/2/);
  });

  it("the panel's card keeps its content clear of the dots' capsule, and only when there is a capsule", () => {
    const withDots = attrsOf(html({ slides: [B, C] }), "title-slide-fallback")[0]!;
    expect(withDots).toMatch(/\bpb-14\b/);
    const alone = attrsOf(html({ slides: [B] }), "title-slide-fallback")[0]!;
    expect(alone).not.toMatch(/\bpb-14\b/);
    expect(alone).toMatch(/\bpb-4\b/);
    // The band's thumbnail has no capsule and no room for padding.
    expect(attrsOf(html({ slides: [B, C], variant: "band" }), "title-slide-fallback")[0]).not.toMatch(/\bpb-14\b/);
  });

  it("a slide that is not on show takes no pointer either (pointer-events-none), and the one on show does, in both variants (count 6)", () => {
    let checked = 0;
    for (const variant of ["panel", "band"] as const) {
      attrsOf(html({ variant }), "title-slide").forEach((slideAttrs, i) => {
        const token = /(?:^|[\s"])pointer-events-none(?=[\s"])/;
        expect(token.test(slideAttrs), `${variant} slide ${i}`).toBe(i !== 0);
        checked += 1;
      });
    }
    expect(checked, "slides checked").toBe(6);
  });

  it("band dots sit on the court colour with no capsule, and clear 3:1 there too (count 2)", () => {
    const h = html({ variant: "band" });
    expect(attrsOf(h, "title-showcase-dots")[0]).not.toMatch(/\bbg-black\//);
    const court = hex(psColour("court"));
    const marks = [...h.matchAll(/<span\b([^>]*\bdata-testid="title-showcase-dot-mark"[^>]*)>/g)].map((m) => m[1]!);
    const inactive = marks.find((s) => /\bbg-white\/\d+\b/.test(s))!;
    const inactiveAlpha = Number(/\bbg-white\/(\d+)\b/.exec(inactive)![1]) / 100;
    let checked = 0;
    for (const dot of [over(WHITE, inactiveAlpha, court), WHITE]) {
      expect(ratio(dot, court)).toBeGreaterThanOrEqual(3);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

// ── behaviour ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A `matchMedia` stub: the visitor's reduced-motion setting is `reduced`. */
function stubMotion(reduced: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: reduced,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

type Island = ReturnType<typeof renderIsland<{ slides: readonly TitleSlide[]; labels: ShowcaseLabels; variant: ShowcaseVariant }>>;

function mount(slides: readonly TitleSlide[] = THREE, variant: ShowcaseVariant = "panel"): Island {
  return renderIsland(TitleSponsorShowcase, { slides, labels: LABELS, variant }, walk, { hydrate: true });
}

const byId = (island: Island, testid: string): ReactElement[] =>
  island.tree().filter((el) => propsOf(el)["data-testid"] === testid);
const rootOf = (island: Island): ReactElement => byId(island, "title-showcase")[0]!;
/** The sponsor id of the slide that is on show. */
const currentId = (island: Island): string => {
  const on = byId(island, "title-slide").filter((el) => propsOf(el)["data-current"] === "true");
  expect(on, "exactly one slide is current").toHaveLength(1);
  return String(propsOf(on[0]!)["data-sponsor-id"]);
};
const dotsOf = (island: Island): ReactElement[] => byId(island, "title-showcase-dot");

type Handler<E> = (e: E) => void;
const fire = <E,>(el: ReactElement, name: string, event: E): void => (propsOf(el)[name] as Handler<E>)(event);

describe("TitleSponsorShowcase: behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMotion(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("one slide schedules no timer at all; three slides schedule exactly one (the twin: the timer is real when it should be)", () => {
    mount([A]);
    expect(vi.getTimerCount(), "one slide").toBe(0);
    mount(THREE);
    expect(vi.getTimerCount(), "three slides").toBe(1);
  });

  it(`rotates every ${TITLE_ROTATE_MS} ms and wraps: just before → slide 0, on the beat → 1, then 2, then back to 0`, () => {
    const island = mount();
    expect(currentId(island)).toBe(A.id);
    vi.advanceTimersByTime(TITLE_ROTATE_MS - 1);
    expect(currentId(island), "one ms early").toBe(A.id);
    vi.advanceTimersByTime(1);
    expect(currentId(island), "on the beat").toBe(B.id);
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island)).toBe(C.id);
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "wrapped").toBe(A.id);
    // The dots and the caption follow the slide on show.
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    const currentDots = dotsOf(island).filter((d) => propsOf(d)["aria-current"] === "true");
    expect(currentDots).toHaveLength(1);
    expect(propsOf(currentDots[0]!)["aria-label"]).toBe(B.dotLabel);
    expect(island.text()).toContain(B.name);
  });

  it("while it rotates the slides announce nothing (aria-live off)", () => {
    const island = mount();
    const live = island.tree().filter((el) => propsOf(el)["aria-live"] !== undefined);
    expect(live.length, "elements carrying aria-live").toBeGreaterThan(0);
    for (const el of live) expect(propsOf(el)["aria-live"]).toBe("off");
  });

  it("a mouse over the showcase pauses it, and leaving resumes; a touch does NOT pause", () => {
    const island = mount();
    fire(rootOf(island), "onPointerEnter", { pointerType: "mouse" });
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island), "paused for 30 s").toBe(A.id);
    expect(vi.getTimerCount(), "no timer runs while it is paused").toBe(0);
    fire(rootOf(island), "onPointerLeave", { pointerType: "mouse" });
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "resumed").toBe(B.id);

    // The twin: a finger lands, the page keeps turning.
    const touch = mount();
    fire(rootOf(touch), "onPointerEnter", { pointerType: "touch" });
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(touch), "a touch is not a hover").toBe(B.id);
  });

  it("focus inside pauses it; blur to outside resumes; blur to a child does not", () => {
    const island = mount();
    const child = { id: "a dot inside" };
    const inside = { contains: (n: unknown) => n === child };
    fire(rootOf(island), "onFocus", {});
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island), "paused while focus is inside").toBe(A.id);

    // Focus moving from one child to another fires blur on the first, naming the second: still inside.
    fire(rootOf(island), "onBlur", { currentTarget: inside, relatedTarget: child });
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island), "a blur to a child keeps the pause").toBe(A.id);

    // Focus leaving for something else, or for nothing (the window lost focus), resumes.
    fire(rootOf(island), "onBlur", { currentTarget: inside, relatedTarget: { id: "elsewhere" } });
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "resumed after a blur to outside").toBe(B.id);

    fire(rootOf(island), "onFocus", {});
    fire(rootOf(island), "onBlur", { currentTarget: inside, relatedTarget: null });
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "resumed after a blur to nothing").toBe(C.id);
  });

  it("reduced motion: nothing moves in 30 s and no timer runs, but a dot still switches the slide", () => {
    stubMotion(true);
    const island = mount();
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island)).toBe(A.id);
    expect(vi.getTimerCount()).toBe(0);
    fire(dotsOf(island)[2]!, "onClick", {});
    expect(currentId(island), "the dot is the visitor's control").toBe(C.id);
    // The twin is the rotation case above: with motion allowed the same three slides DO turn.
  });

  it("a dot tap shows that sponsor and STOPS the rotation for this view (D12)", () => {
    const island = mount();
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "premise: it was turning").toBe(B.id);
    fire(dotsOf(island)[2]!, "onClick", {});
    expect(currentId(island), "the tapped sponsor").toBe(C.id);
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island), "30 s later, still that sponsor").toBe(C.id);
    expect(vi.getTimerCount(), "the timer is gone").toBe(0);
    // Having stopped, the carousel says so to a screen reader when the visitor moves it again.
    const live = island.tree().filter((el) => propsOf(el)["aria-live"] !== undefined);
    for (const el of live) expect(propsOf(el)["aria-live"]).toBe("polite");
    // Even leaving and re-entering with a mouse does not restart it: the stop is for the page view.
    fire(rootOf(island), "onPointerEnter", { pointerType: "mouse" });
    fire(rootOf(island), "onPointerLeave", { pointerType: "mouse" });
    vi.advanceTimersByTime(5 * TITLE_ROTATE_MS);
    expect(currentId(island)).toBe(C.id);
  });

  it("a poster that fails to load falls back to the logo card, and the other slides keep their posters (D14)", () => {
    // The poster is on a host the image optimiser is not configured for: the browser's <img> errors, and the premium slot must not
    // show a broken image.
    const offHost = { ...A, poster: "https://elsewhere.example/not-ours.png" } satisfies TitleSlide;
    const island = mount([offHost, B, C]);
    expect(byId(island, "title-slide-poster")).toHaveLength(2);
    expect(byId(island, "title-slide-fallback")).toHaveLength(1);

    const firstSlide = byId(island, "title-slide")[0]!;
    const img = walk(firstSlide).find((el) => propsOf(el)["data-testid"] === "title-slide-poster");
    expect(img, "the first slide's poster image").toBeDefined();
    expect(propsOf(img!).src).toBe(offHost.poster);
    (propsOf(img!).onError as Handler<unknown>)({});

    expect(byId(island, "title-slide-poster"), "the failed poster is gone, the other kept").toHaveLength(1);
    expect(byId(island, "title-slide-fallback"), "its logo card replaced it").toHaveLength(2);
    const card = walk(byId(island, "title-slide")[0]!).find((el) => propsOf(el)["data-testid"] === "title-slide-fallback");
    expect(card, "the card sits in the failed slide").toBeDefined();
    const logo = walk(card!).find((el) => propsOf(el).src === offHost.logo);
    expect(logo, "and shows that sponsor's logo").toBeDefined();
    expect(currentId(island), "the failure does not move the rotation").toBe(offHost.id);
  });

  it("a failed poster on a slide with no logo falls back to the monogram, in the band too", () => {
    const island = mount([{ ...C, poster: "https://elsewhere.example/gone.png" }, A], "band");
    const img = walk(byId(island, "title-slide")[0]!).find((el) => propsOf(el)["data-testid"] === "title-slide-poster");
    (propsOf(img!).onError as Handler<unknown>)({});
    expect(byId(island, "title-slide-monogram")).toHaveLength(1);
    expect(byId(island, "title-slide-poster")).toHaveLength(1);
  });

  it("failed posters ACCUMULATE: slide 0's and slide 2's posters both fail, and after a full lap both are still cards (D14)", () => {
    const island = mount(); // A: poster, B: none, C: poster
    const posterIn = (slideAt: number): ReactElement | undefined =>
      walk(byId(island, "title-slide")[slideAt]!).find((el) => propsOf(el)["data-testid"] === "title-slide-poster");
    const fail = (slideAt: number): void => {
      const img = posterIn(slideAt);
      expect(img, `slide ${slideAt} still has a poster to fail`).toBeDefined();
      (propsOf(img!).onError as Handler<unknown>)({});
    };
    expect(byId(island, "title-slide-poster"), "before any failure").toHaveLength(2);

    fail(0);
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "the rotation reached slide 2").toBe(C.id);
    fail(2);
    // A full lap: back to slide 0, through the slide that failed first.
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "wrapped to slide 0").toBe(A.id);

    expect(byId(island, "title-slide-poster"), "no poster is left to load").toHaveLength(0);
    let cards = 0;
    for (const slideAt of [0, 1, 2]) {
      const hasCard = walk(byId(island, "title-slide")[slideAt]!).some((el) => propsOf(el)["data-testid"] === "title-slide-fallback");
      expect(hasCard, `slide ${slideAt} draws a card`).toBe(true);
      cards += 1;
    }
    expect(cards, "slides checked").toBe(3);
  });

  it("a failed poster is a failed URL, not a failed sponsor: the same sponsor with a NEW poster after a refresh shows it", () => {
    const island = mount();
    const posterIn = (slideAt: number): ReactElement | undefined =>
      walk(byId(island, "title-slide")[slideAt]!).find((el) => propsOf(el)["data-testid"] === "title-slide-poster");
    (propsOf(posterIn(0)!).onError as Handler<unknown>)({});
    expect(posterIn(0), "the failed poster is a card").toBeUndefined();

    const replaced = { ...A, poster: "https://cdn.example/storage/a-poster-v2.png" } satisfies TitleSlide;
    island.rerender({ slides: [replaced, B, C], labels: LABELS, variant: "panel" });
    const img = posterIn(0);
    expect(img, "the new poster is drawn, not the card").toBeDefined();
    expect(propsOf(img!).src).toBe(replaced.poster);
    expect(byId(island, "title-slide-poster"), "A's new poster and C's").toHaveLength(2);

    // The twin: the old URL is still remembered as failed, so putting it back draws the card again.
    island.rerender({ slides: [A, B, C], labels: LABELS, variant: "panel" });
    expect(posterIn(0), "the old poster is still a card").toBeUndefined();
    expect(byId(island, "title-slide-poster")).toHaveLength(1);
  });

  it("when the slide count changes under a running rotation it turns by the NEW count, and a shrunk list never leaves nothing on show", () => {
    const island = mount();
    expect(currentId(island)).toBe(A.id);
    // Three beats after the list shrinks to two: A, B, A, B (a rotation still turning by the old count of three would go A, B, A, A).
    island.rerender({ slides: [A, B], labels: LABELS, variant: "panel" });
    expect(currentId(island), "the rerender itself moves nothing").toBe(A.id);
    const seen: string[] = [];
    for (let beat = 0; beat < 3; beat += 1) {
      vi.advanceTimersByTime(TITLE_ROTATE_MS);
      seen.push(currentId(island));
    }
    expect(seen, "two slides turn A, B, A, B").toEqual([B.id, A.id, B.id]);
    // Growing back to three: the next beat reaches the third slide.
    island.rerender({ slides: [A, B, C], labels: LABELS, variant: "panel" });
    vi.advanceTimersByTime(TITLE_ROTATE_MS);
    expect(currentId(island), "three slides again").toBe(C.id);
    // The index is now 2 of 3; one slide left: it falls back to the first, and with none nothing is drawn.
    island.rerender({ slides: [A], labels: LABELS, variant: "panel" });
    expect(currentId(island), "index 2 of 1 slide falls back to the first").toBe(A.id);
    island.rerender({ slides: [], labels: LABELS, variant: "panel" });
    expect(island.tree(), "nothing to show, nothing drawn").toHaveLength(0);
  });
});
