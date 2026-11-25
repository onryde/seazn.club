// A post's own artwork: a hand-made picture with two drawings of the same thing, wide and phone. A post places one with
// `{{art:<id>}}` alone on a line. It is how a how-to post, which has nothing to generate from the engine, carries its
// picture without a made-up worked example. Client-safe (no fs).
//
// The files are self-contained SVGs under public/help/blog: an <img> cannot load the page's fonts, so their headings are
// drawn as outlines. blog-art.test.tsx holds every file named here (size, no outside reference, no web font, the words).

export interface BlogArtDrawing {
  /** Under /help/blog/. */
  src: string;
  /** The SVG's own viewBox, so the page reserves its space before it loads. */
  width: number;
  height: number;
}

export interface BlogArt {
  /** The picture's name: the img's alt text and the SVG's own aria-label. */
  alt: string;
  wide: BlogArtDrawing;
  /** Shown below 600px, where the wide drawing's words would be too small to read. */
  phone: BlogArtDrawing;
}

export const BLOG_ART: Readonly<Record<string, BlogArt>> = {
  "stream-flow": {
    alt: "How a match gets from your phone to viewers: a phone on a tripod with a power bank sends video over 4G, 5G or Wi-Fi; the score from the scorer joins it; the match plays on your YouTube channel.",
    wide: { src: "/help/blog/what-you-need-to-stream-a-match-flow.svg", width: 1200, height: 700 },
    phone: { src: "/help/blog/what-you-need-to-stream-a-match-flow-phone.svg", width: 360, height: 1100 },
  },
};

/** `{{art:<id>}}` alone on a line (trim the line first). */
export const ART_LINE = /^\{\{art:([a-z0-9-]+)\}\}$/;

export function blogArt(id: string): BlogArt | undefined {
  return Object.hasOwn(BLOG_ART, id) ? BLOG_ART[id] : undefined;
}
