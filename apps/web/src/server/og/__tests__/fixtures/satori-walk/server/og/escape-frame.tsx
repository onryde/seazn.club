import { ImageResponse } from "next/og";

/**
 * FIXTURE for `share-image-surfaces.test.tsx` — never imported by the app.
 * A shared helper that builds the image, so the route that uses it
 * (`app/escape/opengraph-image.tsx`) carries neither the import nor the literal.
 */
export function escapeShareImage(): ImageResponse {
  return new ImageResponse(<div style={{ display: "flex" }}>escape</div>, { width: 1200, height: 630 });
}
