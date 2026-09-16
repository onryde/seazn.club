import { escapeShareImage } from "../../server/og/escape-frame";

/**
 * FIXTURE for `share-image-surfaces.test.tsx` — not a route (it lives under
 * `__tests__`). The route half of the helper escape: it carries neither the
 * `next/og` import nor the literal, so it is NOT derived — its helper is, and
 * that is what turns the gate red.
 */
export default function Image(): Response {
  return escapeShareImage();
}
