import { ImageResponse as Og } from "next/og";

/**
 * FIXTURE for `share-image-surfaces.test.tsx` — never imported by the app.
 * An aliased import: the class is only ever constructed under its alias, so
 * only the import rule can find this one.
 *
 * Do not spell out the construction this file lacks in this comment: the walk
 * reads comments as text, and naming the missing token here once made this
 * fixture match the very rule it exists to rule out.
 */
export function aliasedShareImage(): Og {
  return new Og(<div style={{ display: "flex" }}>aliased</div>, { width: 1200, height: 630 });
}
