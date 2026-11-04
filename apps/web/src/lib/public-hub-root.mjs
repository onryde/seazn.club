// The public spectator tree's URL root, the ONE place it is written (LIVE1, owner ruling 2026-11-03: "make sense
// live", option A). Plain ESM so next.config.js can import it beside the TypeScript app, the same way it imports
// ./posthog-proxy.mjs.
//
// Every spectator URL is built from these through `routes.*` in lib/routes.ts — never by hand. The guard
// lib/__tests__/public-hub-links.test.ts reds on a `/live/…` or `/shared…` string anywhere else in src, proxy.ts and
// next.config.js included.
//
// Option A: a bare `/live` (and `/<lang>/live`) is NOT the spectator tree. It stays the marketing wall,
// `app/[lang]/(marketing)/live`, rewritten from `/live` by proxy.ts's MARKETING_UNPREFIXED. Only `/live/<org>/…`
// is the hub (`app/(public)/live/[orgSlug]/…`).

/** The public hub's root: `/live/<org>[/<competition>[/<division>]]`. */
export const PUBLIC_HUB_ROOT = "/live";

/** The hub's root before LIVE1. Read in ONE place: next.config.js's permanent 308 from `/shared/:path*` to
 *  `/live/:path*`, kept forever (owner ruling) so a printed QR code or an old link still lands. Never build a
 *  link from it. */
export const LEGACY_PUBLIC_HUB_ROOT = "/shared";
