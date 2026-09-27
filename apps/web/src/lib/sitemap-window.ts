// The sitemap's cache window, and its test-only override — ONE parse, shared.
//
// Read by the server (server/public-site/sitemap-cache.ts), by the e2e spec
// that proves the window (e2e/sitemap.spec.ts), and by the smoke check
// (scripts/smoke.ts). The three must agree on what counts as an override, or a
// runner could wait out a window the server is not using. Pure and import-free
// so smoke.ts can load it under `node --experimental-strip-types`.

/** Shipped cache window for the sitemap's competition read: about an hour. */
export const SITEMAP_REVALIDATE_SECONDS = 3600;

/**
 * `SITEMAP_REVALIDATE_SECONDS` from the environment, when it is a positive
 * integer; `undefined` for anything else (unset, empty, zero, negative,
 * fractional, junk). Production sets nothing. An e2e or smoke server sets a
 * few seconds so a pick-up can be proven without waiting an hour.
 */
export function sitemapWindowOverride(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The window in force: the override when usable, the shipped hour otherwise. */
export function sitemapRevalidateSeconds(raw: string | undefined = process.env.SITEMAP_REVALIDATE_SECONDS): number {
  return sitemapWindowOverride(raw) ?? SITEMAP_REVALIDATE_SECONDS;
}
