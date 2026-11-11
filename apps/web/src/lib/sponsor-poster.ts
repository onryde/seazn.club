// The pure rules behind a Title sponsor's poster (spec docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md):
// the poster's size, the crop the browser's `object-cover` will make of a picked picture (§11), and when a showcase of several
// posters turns by itself (§7.6). Client-safe on purpose: the editor (a client island) and the public showcase (a client component)
// both import it, so it carries no import beyond types and touches no browser or server API.

/** The recommended poster size, 4:5 (Instagram portrait). The `<Image>` is given these as its intrinsic size; the box it fills is
 *  4:5 as well, so `object-cover` loses nothing on a picture of exactly this ratio. */
export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT = 1350;

/** How long each Title sponsor stays up before the next one fades in (D4). */
export const TITLE_ROTATE_MS = 6_000;

/** What a `cover`-fit into the 4:5 box cuts off a picture of a given size. `side` is the edge that loses pixels (`null` when the
 *  picture is exactly 4:5), `percent` how much of that edge goes, and `warn` whether it is MORE than a quarter (D11). */
export interface PosterCrop {
  side: "width" | "height" | null;
  percent: number;
  warn: boolean;
}

/**
 * The crop a picture of `width` x `height` takes in the 4:5 box (spec §11).
 *
 * The box is 4:5, so a picture is wider than it when `5w > 4h` and taller when `5w < 4h`. Wider: the width loses
 * `(5w - 4h) / 5w`. Taller: the height loses `(4h - 5w) / 4h`. The warning is "more than 25 %", stated in integers so no float
 * ever decides it: `15w > 16h` for the width and `3h > 5w` for the height. The percent shown is `ceil(100 x lost)`, taken from the
 * integer numerator and denominator: the integer quotient is exact when it is whole, and a non-whole one is never within a float
 * epsilon of the next integer at the sizes a picture has.
 *
 * `null` means the size is unknown (zero, negative, NaN or infinite): the editor then shows no warning, and nothing throws.
 */
export function posterCrop(width: number, height: number): PosterCrop | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const wide = 5 * width;
  const tall = 4 * height;
  if (wide === tall) return { side: null, percent: 0, warn: false };
  if (wide > tall) {
    return { side: "width", percent: Math.ceil((100 * (wide - tall)) / wide), warn: 15 * width > 16 * height };
  }
  return { side: "height", percent: Math.ceil((100 * (tall - wide)) / tall), warn: 3 * height > 5 * width };
}

/** The slide after `index` of `count`, wrapping to the first. There is no slide to move to when there are none, and answering
 *  `NaN` would put an invalid index into state, so that is refused by name. */
export function nextSlide(index: number, count: number): number {
  if (!(count >= 1)) throw new RangeError("no slides");
  return (index + 1) % count;
}

/** What decides whether a showcase turns by itself. */
export interface RotationState {
  /** How many slides the showcase holds. */
  count: number;
  /** The visitor asked their device for less motion: nothing moves on its own. */
  reducedMotion: boolean;
  /** A mouse is over the showcase, or focus is inside it. */
  paused: boolean;
  /** A dot was tapped: the visitor took over for this page view (D12, the WCAG 2.2.2 stop). */
  stopped: boolean;
}

/** True only when there is something to turn to (two or more slides), the visitor has not asked for reduced motion, the showcase is
 *  not paused and the rotation has not been stopped (spec §7.6). */
export function autoRotates(s: RotationState): boolean {
  return s.count >= 2 && !s.reducedMotion && !s.paused && !s.stopped;
}
