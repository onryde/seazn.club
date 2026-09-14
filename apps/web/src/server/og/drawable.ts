import "server-only";

/**
 * The ONLY thing a satori layout will put in an `<img src>`: bytes, already
 * fetched and re-encoded by `server/og/poster-image.ts`.
 *
 * satori does not merely read a `src` — it FETCHES it, server-side, from
 * inside our own network, and every surface that draws one of these is a
 * public route whose logo and badge URLs are organiser-supplied. Refusing
 * anything that is not a `data:` URI at the last step before satori means the
 * guard holds even for a caller that forgets the fetcher: a raw URL renders
 * whatever that card already shows without a logo, never a request.
 *
 * It also keeps the original reason the match poster grew this function — a
 * relative path throws inside satori and takes the WHOLE image down, not one
 * tile — and it is why an uploaded `.webp` logo appears at all: satori draws a
 * remote webp as an empty box, and only the fetcher's re-encode gets past that.
 *
 * One function, imported by every satori frame in this directory, so there is a
 * single place to change the rule and a single place to mutate when proving it.
 */
export function drawableImage(src: string | null | undefined): string | null {
  return typeof src === "string" && src.startsWith("data:image/") ? src : null;
}
