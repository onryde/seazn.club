import { ImageResponse } from "next/og";

/**
 * FIXTURE for `share-image-surfaces.test.tsx`. Imports `next/og`, but sits in a
 * `__tests__` directory, which the walk skips — test files render share images
 * too, and they are not surfaces.
 */
export const ignored = (): ImageResponse =>
  new ImageResponse(<div style={{ display: "flex" }}>ignored</div>, { width: 1200, height: 630 });
