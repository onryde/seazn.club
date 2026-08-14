import "server-only";
import { cookies, headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n";

/**
 * Resolve the locale for a server render (v5 i18n spec §4). Order:
 *   1. `seazn_locale` cookie (explicit switcher pick)
 *   2. signed-in user's `users.locale`
 *   3. `orgDefault` — the owning org's default, for public league pages only
 *   4. `x-seazn-locale` request header (proxy's Accept-Language negotiation)
 *   5. en
 *
 * Marketing `[lang]` pages don't call this — the path segment is authoritative
 * there (see the marketing layout).
 *
 * Note: this reads cookies()/headers(), so any component that calls it opts
 * into dynamic rendering. The static root layout deliberately does NOT call it.
 *
 * P6 fix round 2: `cookies()`/`headers()` throw "outside a request scope"
 * unconditionally when there is no real Next.js request — the shape of a
 * server-component "page" function called directly, this repo's own
 * convention for testing one (no jsdom; see officials-loads-deferred.test.tsx
 * and its `renderTab` helper). That previously forced every caller to choose
 * between real localization and a testable page, and cost this exact
 * surface its localization once already (schedule/page.tsx, fix round 1).
 *
 * The throw is SYNCHRONOUS — Next's own guard (`throwForMissingRequestStore`)
 * fires the instant `cookies()`/`headers()` is called, before a Promise ever
 * exists to reject. A `.then().catch()` chained onto the call does NOT see
 * it (the exception propagates from evaluating `cookies()` itself, never
 * reaching `.then`); `getCurrentUser()` below is safe under plain `.catch()`
 * only because it is declared `async`, so JS wraps even its synchronous
 * internal throw into a rejected Promise before this function ever sees it.
 * `cookies`/`headers` are not `async` functions, so each read needs an
 * actual try/catch around the call. Both fall through to the next priority
 * on failure (ultimately DEFAULT_LOCALE) — a throw reads as "not
 * available", never a crash. In a real request this branch is unreachable:
 * `cookies()`/`headers()` only ever throw this specific "wrong time/place"
 * guard, never a data-availability error, so a genuine in-request call is
 * unaffected.
 */
export async function resolveLocale(opts?: { orgDefault?: Locale }): Promise<Locale> {
  let cookieLocale: string | undefined;
  try {
    cookieLocale = (await cookies()).get("seazn_locale")?.value;
  } catch {
    cookieLocale = undefined;
  }
  if (cookieLocale && hasLocale(cookieLocale)) return cookieLocale;

  const user = await getCurrentUser().catch(() => null);
  if (user?.locale && hasLocale(user.locale)) return user.locale;

  if (opts?.orgDefault) return opts.orgDefault;

  let headerLocale: string | null = null;
  try {
    headerLocale = (await headers()).get("x-seazn-locale");
  } catch {
    headerLocale = null;
  }
  return headerLocale && hasLocale(headerLocale) ? headerLocale : DEFAULT_LOCALE;
}
