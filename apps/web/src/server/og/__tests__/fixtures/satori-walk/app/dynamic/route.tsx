/**
 * FIXTURE for `share-image-surfaces.test.tsx` — not a route (it lives under
 * `__tests__`). A dynamic import: no `from "next/og"`, so only the
 * `new ImageResponse` literal rule can find this one.
 */
export async function GET(): Promise<Response> {
  const { ImageResponse } = await import("next/og");
  return new ImageResponse(<div style={{ display: "flex" }}>dynamic</div>, { width: 1200, height: 630 });
}
