import { ImageResponse as Og } from "next/og";

/**
 * FIXTURE for `share-image-surfaces.test.tsx` — never imported by the app.
 * An aliased import: no `new ImageResponse` literal anywhere, so only the
 * `next/og` import rule can find this one.
 */
export function aliasedShareImage(): Og {
  return new Og(<div style={{ display: "flex" }}>aliased</div>, { width: 1200, height: 630 });
}
