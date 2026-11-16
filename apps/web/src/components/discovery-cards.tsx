// Discovery showcase cards & strips (doc 15 §2, PROMPT-19). Server-rendered
// presentational components shared by the home page, /discover and the
// per-sport pages. Everything here renders public_discovery_v data only —
// no person data ever reaches these props.
import Link from "next/link";
import type { DiscoveryEntry } from "@/server/public-site/discovery";
import { t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

// Re-exported, not redeclared: this file's own copy of the map had already
// drifted from the onboarding wizard's (F8). `lib/sport-emoji.ts` is the one
// source, and its test reds when the sport catalog grows past it.
import { SPORT_EMOJI, sportEmoji } from "@/lib/sport-emoji";
import { routes } from "@/lib/routes";
export { SPORT_EMOJI, sportEmoji };

function formatDates(startsOn: string | null, endsOn: string | null, lang: Locale): string | null {
  if (!startsOn) return null;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(lang, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return endsOn && endsOn !== startsOn ? `${fmt(startsOn)} – ${fmt(endsOn)}` : fmt(startsOn);
}

/** schema.org SportsEvent markup for a directory entry (doc 15 §2 SEO). */
function jsonLd(entry: DiscoveryEntry): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: entry.name,
    ...(entry.starts_on ? { startDate: entry.starts_on } : {}),
    ...(entry.ends_on ? { endDate: entry.ends_on } : {}),
    ...(entry.city || entry.country
      ? {
          location: {
            "@type": "Place",
            name: [entry.city, entry.country].filter(Boolean).join(", "),
          },
        }
      : {}),
    organizer: { "@type": "Organization", name: entry.org_name },
    url: `https://seazn.club${routes.publicHub(entry.org_slug, entry.slug)}`,
  });
}

/** Discovery competition card (home "this week", /discover directory). */
export function DiscoveryCard({
  entry,
  dict,
  lang,
  withJsonLd = false,
}: {
  entry: DiscoveryEntry;
  dict: Dict;
  lang: Locale;
  withJsonLd?: boolean;
}) {
  const dates = formatDates(entry.starts_on, entry.ends_on, lang);
  const location = [entry.city, entry.country].filter(Boolean).join(", ");
  return (
    <Link
      href={routes.publicHub(entry.org_slug, entry.slug)}
      className="card relative block overflow-hidden p-5 transition hover:border-purple-300 hover:shadow-md"
    >
      {withJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(entry) }} />
      )}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-2xl">{sportEmoji(entry.sports?.[0])}</span>
        <span className="flex items-center gap-1">
          {entry.in_play_count > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-600">
              {t(dict, "discovery.badge.live")}
            </span>
          )}
          {entry.featured && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
              {t(dict, "discovery.badge.featured")}
            </span>
          )}
        </span>
      </div>
      <h3 className="truncate font-semibold text-slate-800">{entry.name}</h3>
      {/* tagline/hero only arrive from the view with `discovery.branding`. */}
      {entry.tagline && <p className="mt-0.5 truncate text-xs text-slate-500">{entry.tagline}</p>}
      <p className="mt-1 truncate text-xs text-slate-500">{t(dict, "discovery.by", { org: entry.org_name })}</p>
      <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-slate-500">
        {dates && <span>📅 {dates}</span>}
        {location && <span>📍 {location}</span>}
        {entry.entrant_count > 0 && <span>👥 {entry.entrant_count}</span>}
      </p>
    </Link>
  );
}
