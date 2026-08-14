// Sport keys with bespoke SEO copy in the marketing catalog; others fall back
// to the generic block. A content decision (which sports get bespoke copy),
// not a drift risk to widen automatically — but a stale or misspelled member
// degrades silently to generic copy with nothing failing, so `__tests__/
// page.test.ts` pins it: every member must be a real engine sport key, and
// must resolve its `.intro`/`.detail` keys in all four dictionaries (#S13).
//
// It lives beside the page rather than in it because Next allows only a fixed
// set of exports from a `page.tsx`, and `app-module-exports.test.ts` enforces
// that — a helper the page needs but cannot export belongs in a sibling
// module the page imports from.
export const SPORTS_WITH_COPY = new Set([
  "cricket", "football", "volleyball", "badminton", "tabletennis", "boardgame", "carrom",
]);
