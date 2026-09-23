/**
 * The `Intl` locale tag a PUBLIC page writes dates and times in, for an org
 * whose locale is `locale`.
 *
 * English is day-month (owner ruling, 2026-09-16): "1 Sept 2026", never the
 * US "Sep 1, 2026" that bare "en" gives `Intl`. `lib/format.ts` pins en-GB as
 * this repo's display locale for the same reason. Every other org locale is
 * used as given; only bare "en" is ambiguous.
 *
 * ONE rule, in one place: the org home (`app/(public)/shared/[orgSlug]`), the
 * public schedule (`components/public-site/schedule.tsx`) and the match
 * centre's start time (`server/public-site/match-centre.ts`) all read it. No
 * imports, so a client island can use it.
 */
export function intlLocaleFor(locale: string): string {
  return locale === "en" ? "en-GB" : locale;
}

/**
 * An ISO instant in the org's locale and the VENUE's zone, never the runtime's.
 * An unknown zone falls back to UTC rather than throwing into a render (the
 * `lib/format.ts` rule). Null for a null or unparseable instant.
 *
 * Moved here from `components/public-site/player-matches.tsx` (plan P6): that
 * module is "use client", and a server component cannot call a function a
 * client module exports. Still import-free, so an island can use it too.
 */
export function formatPublicInstant(
  locale: string,
  tz: string,
  iso: string | null,
  opts: Intl.DateTimeFormatOptions,
): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(intlLocaleFor(locale), { timeZone: tz, ...opts }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(intlLocaleFor(locale), { timeZone: "UTC", ...opts }).format(ms);
  }
}
