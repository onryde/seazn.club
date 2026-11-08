import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 5; plan 2 Task 9, pre-flight A9):
// "your recent quick matches" for THIS request's visitor, as the pages that mount the strip read it (the marketing home
// and `/<lang>/play`). The strip itself takes its rows as props (eslint.config.mjs keeps every value import of @/server
// out of components/quick-match/**), so this is the one place a page asks for them.
//
// It only ever READS the visitor cookie, through `next/headers` (a page has no request object; the create route reads
// the request's own cookies and is the only place the key is minted, quick-match-visitor.ts). And it fails soft: the
// strip is an extra on the busiest page in the product, so every failure is an empty strip, never a 500.
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { log } from "@/server/logger";
import { listRecentQuickMatches, type RecentQuickMatch } from "./quick-match-home";
import { hashVisitorKey, isVisitorKeyShaped, QUICK_MATCH_VISITOR_COOKIE } from "./quick-match-tokens";

/**
 * The rows the strip shows for this request, or none:
 *  - no visitor cookie, or one that is not a visitor key's shape (`isVisitorKeyShaped`): none, and nothing is read. A
 *    malformed value is never hashed into a query (pre-flight B2a), and none is ever minted here;
 *  - `cookies()` throwing outside a request (a page rendered directly, as this repo's page tests do): none. Next's own
 *    render signals (a static render that met `cookies()`) are rethrown first, so the framework still sees them;
 *  - a read that throws (the database): none, one warning (not an error: an outage would otherwise log an error per
 *    visitor with a cookie, on the busiest page);
 *  - a row whose home token does not open: skipped by `listRecentQuickMatches`, which warns once for the read.
 */
export async function readRecentQuickMatches(): Promise<RecentQuickMatch[]> {
  let held: string | undefined;
  try {
    held = (await cookies()).get(QUICK_MATCH_VISITOR_COOKIE)?.value;
  } catch (err) {
    unstable_rethrow(err);
    return [];
  }
  if (held === undefined || !isVisitorKeyShaped(held)) return [];
  try {
    return await listRecentQuickMatches(hashVisitorKey(held));
  } catch (err) {
    log.warn({ err }, "quick match recent strip: the visitor's recent matches could not be read; the strip is hidden");
    return [];
  }
}
