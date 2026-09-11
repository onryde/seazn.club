// Competition home — the spectator landing (W2 Task 12).
//
// This page used to BE the competition: a hero, a live-now strip and a grid of
// division cards, all of it hardcoded English. It is now a hero plus ONE mount
// — `CompetitionLanding` — which renders the hub document's six tabs and polls
// it. The divisions grid and the live-now rail are gone from this file; the
// Overview tab draws both, from the same document the rest of the page reads.
//
// Unlisted competitions still render with noindex; private ones never reach
// here (the view 404s them).
//
// ── THE LOCALE THIS PAGE RENDERS IN IS THE ORG'S, NOT THE VIEWER'S ─────────
// Task 11 deliberately left the choice here (its review F9), so it is made
// here and the reasoning is written down rather than left to be re-derived.
//
// `competition-hub.ts:368` resolves ONE locale — the org's `default_locale` —
// and pre-resolves every string in the document against it: `divisionName`,
// board labels, format lines, slot sentences. Those strings arrive already
// translated and this page cannot re-translate them. So a page that resolved
// the VIEWER's locale for its chrome would put two languages in one panel,
// three once `lib/format.ts`'s en-GB dates are counted.
//
// And this route is ISR (`revalidate` below). A per-visitor locale read would
// make the cached copy wrong for everybody who is not the visitor who warmed
// it — the same argument the division page settled on when it resolved
// `getDictionary(orgLocale, "public")` (`[divisionSlug]/page.tsx:94-103`).
//
// ── AND IT IS READ OFF THE DOCUMENT, NOT OFF THE ORG ROW ──────────────────
// `toLocale(hub.locale)`, not `toLocale(org.default_locale)`. They are the
// same value in the steady state — `hub.locale` IS the org's, resolved by the
// builder — but the two reads are cached SEPARATELY (`REVALIDATE_FAST` on the
// hub, 30s on this page), so an org that changes its default locale has a
// window where they disagree. Reading the document's own field makes the
// chrome match the content it wraps by construction, in that window too,
// instead of only by the two caches happening to agree.
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { getPublicCompetition } from "@/server/public-site/data";
import { getPublicCompetitionHub } from "@/server/public-site/competition-hub";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { publicThemeStyle } from "@/lib/public-theme";
import { hasFeature } from "@/lib/entitlements";
import { resolveSponsors } from "@/server/usecases/sponsors";
import { renderProse } from "@/lib/prose";
import { competitionMetaDescription } from "@/lib/public-meta";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, plural, t } from "@/lib/i18n";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { SponsorsBoard } from "@/components/public-site/sponsors-board";
import { CompetitionLanding } from "@/components/public-site/matches-hub/competition-landing";
// ONE producer for the competition's date line, shared with the Info tab that
// renders the same two dates a tab away. Two implementations of "1 September
// 2026 – 20 September 2026" is how one of them ends up a day out; `info-tab`'s
// is the one that already fixes the calendar-date/timezone trap below.
import { competitionDateLine } from "@/components/public-site/matches-hub/info-tab";
import { ShareBar, type ShareBarLabels } from "@/components/share-bar";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

interface Branding {
  logo?: string;
  banner?: string;
  colors?: { primary?: string };
  sponsors?: { name: string; url?: string; logo?: string }[];
}

/** Slab chip — the hero's counters. */
const CHIP = "rounded-full bg-white/12 px-3 py-1 backdrop-blur";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) return {};
  // The org row's locale, not the hub document's: this description is built
  // from the shell's OWN two fields (the competition's name and the org's), so
  // it is self-consistent with what it wraps without paying for a second
  // cached read on a path that renders no document.
  const dict = await getDictionary(toLocale(data.org.default_locale), "public");
  return {
    title: `${data.competition.name} — ${data.org.name}`,
    description: competitionMetaDescription(
      data.competition.description,
      // The fallback sentence, in the org's language. `lib/public-meta.ts`
      // used to build this in English for all four locales; the i18n decision
      // lives here now, where a locale is already resolved.
      t(dict, "landing.metaDescription", {
        competition: data.competition.name,
        org: data.org.name,
      }),
    ),
    // Doc 09 §1: unlisted = link-only. Keep crawlers out but the page up.
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function CompetitionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  // Both reads go through the same `unstable_cache`d shell — `getPublicCompetitionHub`
  // fetches it too, to derive its tag list — so this is one query, not two.
  const [data, hub] = await Promise.all([
    getPublicCompetition(orgSlug, competitionSlug),
    getPublicCompetitionHub(orgSlug, competitionSlug),
  ]);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  // The shell exists and the document does not: the two reads are not atomic,
  // so a competition deleted between them lands here. There is nothing to
  // render — every section below is derived from `hub` — and a 404 is the
  // honest answer for a competition that no longer exists.
  if (!hub) notFound();

  const { org, competition } = data;
  const branding = (competition.branding ?? {}) as Branding;
  const locale = toLocale(hub.locale);
  const dict = await getDictionary(locale, "public");

  // Sponsors (v10 PROMPT-56): table rows via the resolver (blob shim only for
  // un-backfilled orgs). Tier grouping is Pro `sponsors.tiers` — without it
  // every row collapses to the free flat partner strip.
  const tiered = await hasFeature(org.id, "sponsors.tiers", competition.id);
  const sponsors = await resolveSponsors(org.id, competition.id, { tiered });

  // Markdown → sanitized HTML — the editor's Preview runs this exact pipeline,
  // so what organisers saw is what ships.
  const descriptionHtml = competition.description
    ? await renderProse(competition.description)
    : null;

  // Every counter in the hero is derived from the SAME document the tabs
  // render, and by the same predicate. `bucket === "live"` is what
  // `landingStatus` (`lib/matches-hub.ts`) and the Overview's live rail both
  // use — the wave's own defect class 2 is two sections of one page counting
  // the same thing two ways, and the old page's `liveNow.length` came from a
  // different query altogether.
  const divisionCount = hub.divisions.length;
  const entrantCount = hub.divisions.reduce((n, d) => n + d.entrantCount, 0);
  const liveCount = hub.matches.filter((m) => m.bucket === "live").length;

  const shareLabels: ShareBarLabels = {
    share: t(dict, "share.share"),
    whatsapp: t(dict, "share.whatsapp"),
    whatsappAria: t(dict, "share.whatsappAria"),
    copy: t(dict, "share.copy"),
    copied: t(dict, "share.copied"),
  };
  const sharePath = `/shared/${org.slug}/${competition.slug}`;

  return (
    // Pro orgs with branding.colors.primary re-theme this whole subtree —
    // the contrast guard in publicThemeStyle falls back to violet.
    <div style={publicThemeStyle(competition.branding)}>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link href={`/shared/${org.slug}`} className="hover:text-accent-strong hover:underline">
          ← {org.name}
        </Link>
      </nav>

      {/* Hero — court slab; banner photo (Pro) sits under a slab-tinted wash */}
      <section
        data-testid="mh-hero"
        className="relative mb-6 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
      >
        {branding.banner ? (
          <>
            {/* competition branding.banner — raw jsonb (z.record(string, unknown)),
                not routed through resolveLogoUrl and has no upload UI today, so it
                isn't provably a storage URL; stays <img> until that's confirmed
                (task-4 report: skipped-ambiguous-source) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={branding.banner}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-court via-court/75 to-court/40" />
          </>
        ) : (
          <div
            aria-hidden
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "radial-gradient(560px 220px at 88% -20%, color-mix(in oklab, var(--ps-accent) 55%, transparent), transparent), radial-gradient(420px 260px at -8% 110%, color-mix(in oklab, var(--ps-accent) 30%, transparent), transparent)",
            }}
          />
        )}
        <div className="relative flex flex-col gap-5 p-6 sm:p-8">
          <div className="flex flex-wrap items-start gap-4">
            {branding.logo ? (
              // competition branding.logo — same unconstrained jsonb / no-upload-UI
              // situation as branding.banner above; skipped-ambiguous-source.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logo}
                alt=""
                className="h-14 w-14 rounded-xl bg-white/95 object-contain p-1 shadow"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
                {org.name}
              </p>
              <h1 className="mt-1 font-display text-4xl font-bold uppercase leading-none tracking-tight sm:text-5xl">
                {hub.name}
              </h1>
              {/* `hub.info`'s startsOn/endsOn are CALENDAR dates (pg `date`), so
                  this formats in UTC. The line this replaced was
                  `new Date(d).toLocaleDateString("en-GB", …)` with no zone at
                  all, which formats in whatever zone the Node process runs in:
                  right in production only because fly.toml sets no TZ and the
                  machine is UTC. Under TZ=America/New_York it rendered
                  "4 September 2026" for a competition starting on the 5th.
                  `competitionDateLine` fixes the zone internally so no caller
                  can choose it — see its own header for the full reasoning. */}
              {competitionDateLine(hub.info) ? (
                <p data-testid="mh-hero-dates" className="mt-2 text-sm text-court-muted">
                  {competitionDateLine(hub.info)}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <ShareBar path={sharePath} title={hub.name} labels={shareLabels} />
                {/* v13 (PROMPT-64): kiosk mode — cast this URL to any screen.
                    The `▸` stays OUT of the dictionary string: a decorative
                    glyph inside translated copy is what gets mangled per
                    locale (Task 6 ruling 24). */}
                <Link
                  data-testid="mh-hero-present"
                  href={hub.info.presentHref}
                  className="inline-flex min-h-11 items-center rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-court-muted ring-1 ring-inset ring-white/15 transition hover:bg-white/20 hover:text-court-ink"
                >
                  {t(dict, "landing.present")} ▸
                </Link>
              </div>
            </div>
            {/* Gated on the DOCUMENT's flag, which is the same
                `publicRegistrationInfo` read the Overview and Info tabs show
                their own register links from. The page no longer calls that
                usecase itself — a second read is a second answer. */}
            {hub.info.registrationOpen ? (
              <Link
                data-testid="mh-hero-register"
                href={hub.info.registerHref}
                className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-accent-strong shadow transition hover:bg-accent-soft"
              >
                {t(dict, "landing.register")}
              </Link>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium">
            {divisionCount === 0 ? (
              // A hero with no counters reads as a page that failed to load.
              // This says the true thing instead — and it is the sentence the
              // dictionary already carries for it.
              <span data-testid="mh-hero-no-divisions" className={CHIP}>
                {t(dict, "landing.noDivisions")}
              </span>
            ) : (
              <>
                <span data-testid="mh-hero-divisions" className={CHIP}>
                  {plural(dict, "landing.divisions", divisionCount, locale)}
                </span>
                {/* No entrants chip without divisions: `entrantCount` is a sum
                    OVER the divisions, so with none it is not "0 entrants", it
                    is a number about nothing. */}
                <span data-testid="mh-hero-entrants" className={CHIP}>
                  {plural(dict, "landing.entrants", entrantCount, locale)}
                </span>
              </>
            )}
            {liveCount > 0 ? (
              <span
                data-testid="mh-hero-live"
                className="flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1 text-emerald-200 backdrop-blur"
              >
                <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-300" />
                {plural(dict, "landing.liveCount", liveCount, locale)}
              </span>
            ) : null}
          </div>
        </div>
        <div aria-hidden className="h-1 bg-accent" />
      </section>

      {/* THE MOUNT. Everything that was below the hero on this page — the
          live-now rail, the competition's prose, the divisions grid, the
          sponsor board — is now a panel of this root, drawn from the hub
          document. The slots are `undefined` rather than an element that
          renders nothing, which is the caller contract both `OverviewTab` and
          `InfoTab` state: a heading over an absent block reads as content that
          failed to load. */}
      <CompetitionLanding
        initial={hub}
        dict={dict}
        locale={locale}
        sponsorsSlot={
          sponsors.length > 0 ? (
            <SponsorsBoard sponsors={sponsors} tiered={tiered} dict={dict} />
          ) : undefined
        }
        descriptionSlot={descriptionHtml ? <CompetitionProse html={descriptionHtml} /> : undefined}
        // The Info tab's own share block. The hero's bar is the prominent one;
        // this is the one a spectator who scrolled into "everything about this
        // competition" expects to find there, and leaving the slot empty would
        // have shipped that section dead.
        shareSlot={<ShareBar path={sharePath} title={hub.name} labels={shareLabels} />}
      />
    </div>
  );
}
