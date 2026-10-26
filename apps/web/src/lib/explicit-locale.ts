import { hasLocale, type Locale } from "@/lib/i18n-constants";

/** The visitor's explicit locale pick (footer switcher → seazn_locale cookie), or null when they never chose one or the cookie names no
 *  shipped locale — then the caller's next D4 step applies. Read from the request's own cookie header, so an anonymous request needs no
 *  session. Shared by the public register route (its registrant's pick) and the funnel start (the claim email's language). */
export function explicitLocale(req: Request): Locale | null {
  const raw = req.headers.get("cookie")?.match(/(?:^|;\s*)seazn_locale=([^;]+)/)?.[1];
  if (!raw) return null;
  const v = decodeURIComponent(raw);
  return hasLocale(v) ? v : null;
}
