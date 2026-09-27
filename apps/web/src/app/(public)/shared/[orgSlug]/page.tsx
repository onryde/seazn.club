// Org landing (doc 09 §1): the org's `public` competitions once published —
// live and finished ones included. Unlisted ones, and drafts of any visibility,
// are reachable by direct link only — never listed here
// (`lib/competition-listing.ts`).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicOrg } from "@/server/public-site/data";
import { publicPosts } from "@/server/usecases/org-posts";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { kindEyebrow, TONE_ON_LIGHT } from "@/lib/news-presentation";
import { renderProse } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { OrgLiveChips } from "@/components/public-site/org-live-chips";
import { orgLiveDict } from "@/lib/hub-dict";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

/** Public pages render in the org's locale for every visitor — a pure function
 *  of the org (not the request), so the page stays ISR-cacheable. */
function orgLocale(defaultLocale: string): Locale {
  return hasLocale(defaultLocale) ? defaultLocale : DEFAULT_LOCALE;
}

export const revalidate = 30;

// ISR (task-8): a dynamic-param route with no generateStaticParams never
// gets ISR treatment in this Next version, regardless of `revalidate` above
// — empty array + default dynamicParams=true still enables on-demand ISR
// (first request renders + caches; docs: api-reference/functions/
// generate-static-params.md).
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return {};
  const dict = await getDictionary(orgLocale(data.org.default_locale), "public");
  return {
    title: data.org.name,
    description: t(dict, "org.competitionsBy", { org: data.org.name }),
  };
}

// IN UTC, and that is load-bearing. `starts_on`/`ends_on` are pg `date`
// columns — CALENDAR days, not instants — so `new Date("2026-09-01")` is UTC
// midnight, and formatting it in any zone behind UTC prints the day before
// ("31 Aug 2026" in America/New_York). The reasoning is set out at length on
// matches-hub/info-tab.tsx's `competitionDateLine`, which formats these same
// two fields for the competition page.
//
// The news strip's `publishedAt` (a timestamptz, i.e. a real instant) is
// formatted through here too and is therefore pinned to UTC as well. That is
// deliberate, not collateral: this route is ISR-cached, so ONE rendered HTML
// is served to every visitor worldwide — there is no viewer zone to resolve
// against, and the alternative is a cached page whose dates depend on which
// host filled the cache.
//
// In the ORG's locale (spectator W2, Task 15), like every other string on this
// page — it was en-GB in all four, so a Spanish club's home printed "1 Sept
// 2026" under Spanish headings. English stays day-month: `intlLocaleFor` writes
// "en" as en-GB (owner ruling 2026-09-16), because bare "en" is a US format to
// `Intl`. Not `lib/format.ts`'s `fmtDate`: that helper pins `LOCALE = "en-GB"`
// and takes no locale (the poster route says the same).
const fmtDate = (iso: string, locale: Locale) =>
  new Date(iso).toLocaleDateString(intlLocaleFor(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export default async function OrgLandingPage({ params }: Props) {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) notFound();
  // This route is ISR-cached (revalidate=30 above) — the capture fires on
  // RENDER, not per viewer request, so it counts cache fills, not loads. A
  // consented-traffic count of renders, never a total (captureServer no-ops
  // without a PostHog key, and is consent-gated).
  await captureServer({
    event: EVENTS.PUBLIC_PROFILE_VIEWED,
    distinctId: `org:${data.org.id}`,
    orgId: data.org.id,
    properties: { orgSlug },
  });
  const { org, competitions } = data;
  const locale = orgLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");
  // Latest-news strip (SPEC-2): newest 3 published posts, three compact rows —
  // the landing hero stays the org's identity, news stays quiet.
  const { posts } = await publicPosts(orgSlug, 0);
  const latestNews = posts.slice(0, 3);

  return (
    <div>
      <section className="mb-8 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
        <div className="relative p-6 sm:p-10">
          <div
            aria-hidden
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "radial-gradient(560px 220px at 88% -20%, color-mix(in oklab, var(--ps-accent) 55%, transparent), transparent), radial-gradient(420px 260px at -8% 110%, color-mix(in oklab, var(--ps-accent) 30%, transparent), transparent)",
            }}
          />
          <div className="relative">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
              {t(dict, "hero.eyebrow")}
            </p>
            <h1 className="mt-2 font-display text-5xl font-bold uppercase leading-none tracking-tight sm:text-6xl">
              {org.name}
            </h1>
            <p className="mt-3 max-w-xl text-sm text-court-muted">{t(dict, "hero.subhead")}</p>
          </div>
        </div>
        <div aria-hidden className="h-1 bg-accent" />
      </section>

      {org.about ? (
        <section className="mb-8">
          <h2 className="mb-3 font-display text-2xl font-semibold uppercase tracking-wide text-ink">
            {t(dict, "section.about")}
          </h2>
          <CompetitionProse html={await renderProse(org.about)} />
        </section>
      ) : null}

      {latestNews.length > 0 ? (
        <section className="mb-8" data-testid="latest-news-strip">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink">
              {t(dict, "news.latest")}
            </h2>
            <Link
              href={`/shared/${org.slug}/news`}
              className="text-xs font-medium uppercase tracking-wide text-accent-strong hover:underline"
            >
              {t(dict, "news.viewAll")}
            </Link>
          </div>
          <ul className="divide-y divide-zinc-200/70 overflow-hidden rounded-xl border border-zinc-200/80 bg-surface">
            {latestNews.map((p) => {
              const tone = kindEyebrow(p.kind).tone;
              return (
                <li key={p.id}>
                  <Link
                    href={`/shared/${org.slug}/news/${p.slug}`}
                    className="group flex items-center gap-3 px-4 py-3 transition hover:bg-accent-soft"
                  >
                    <span
                      className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] ${TONE_ON_LIGHT[tone]}`}
                    >
                      {t(dict, kindEyebrow(p.kind).labelKey)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink group-hover:text-accent-strong">
                      {p.title}
                    </span>
                    {p.publishedAt ? (
                      <span className="shrink-0 text-xs text-ink-muted">{fmtDate(p.publishedAt, locale)}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <h2 className="mb-3 font-display text-2xl font-semibold uppercase tracking-wide text-ink">
        {t(dict, "section.competitions")}
      </h2>
      {competitions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          {t(dict, "empty")}
        </p>
      ) : (
        // ONE island for the whole list (R10: one subscription per page). It
        // keeps each chip truthful while the page is open; the first paint is
        // this render's, from `in_play` as `getPublicOrg` counted it.
        <OrgLiveChips
          orgSlug={org.slug}
          competitions={competitions.map((c) => ({
            id: c.id,
            slug: c.slug,
            name: c.name,
            status: c.status,
            in_play: c.in_play,
            dateLine: c.starts_on
              ? `${fmtDate(c.starts_on, locale)}${c.ends_on ? ` – ${fmtDate(c.ends_on, locale)}` : ""}`
              : "",
          }))}
          dict={orgLiveDict(dict)}
          locale={locale}
        />
      )}
    </div>
  );
}
