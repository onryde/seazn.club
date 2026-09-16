/** Lichess HTTP surface — thin re-export so call sites can import from `lichess/client`. */
import { createLichessAdapter } from "./adapter";

export { createLichessAdapter };
export type { LichessAdapterDeps } from "./adapter";

/** Default adapter instance: real fetch, base URL overridable for the e2e stub (Task 14). */
export function defaultLichessAdapter() {
  return createLichessAdapter({
    fetch,
    baseUrl: process.env.LICHESS_BASE_URL ?? "https://lichess.org",
  });
}
