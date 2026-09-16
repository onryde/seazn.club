/**
 * FIXTURE for `share-image-surfaces.test.tsx` — not a route (it lives under
 * `__tests__`). A dynamic import with no static import statement, so only the
 * construction-literal rule can find this one.
 *
 * Do not spell out the import this file lacks in this comment: the walk reads
 * comments as text, and naming the missing token here once made this fixture
 * match the very rule it exists to rule out.
 */
export async function GET(): Promise<Response> {
  const { ImageResponse } = await import("next/og");
  return new ImageResponse(<div style={{ display: "flex" }}>dynamic</div>, { width: 1200, height: 630 });
}
