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
