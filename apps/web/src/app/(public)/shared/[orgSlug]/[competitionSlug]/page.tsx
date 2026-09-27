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
// the VIEWER's locale for its chrome would put two languages in one panel.
//
// And this route is ISR (`revalidate` below). A per-visitor locale read would
// make the cached copy wrong for everybody who is not the visitor who warmed
// it — the same argument the division page settled on when it resolved
// `getDictionary(orgLocale, "public")` (`[divisionSlug]/page.tsx:94-103`).
//
// ── AND IT IS READ OFF THE DOCUMENT, NOT OFF THE ORG ROW ──────────────────
// `toLocale(hub.locale)`, not `toLocale(org.default_locale)`. They are the
// same value in the steady state — `hub.locale` IS the org's, resolved by the
// builder at `competition-hub.ts:368` — but the shell and the document are two
// independently-expiring 30s cache entries (`REVALIDATE_FAST = 30`,
// `data.ts:158`, on both; the page's own `revalidate` is the same number) that
// share one invalidation tag (`orgTag(orgSlug)`, so a `revalidateTag` busts
// them together). The drift is therefore TTL-only and bounded at ~30s — not a
// wider gap — but inside that window the document's pre-resolved strings
// (`divisionName`, board labels, slot sentences) cannot be re-translated, so
// matching the chrome to the document is right by construction rather than by
// the two entries happening to expire together.
//
// ONE CONSEQUENCE, and it is a real trade rather than an oversight:
// `generateMetadata` below resolves from the ORG ROW, because it renders no
// document and building one to translate a sentence made of the shell's own
// two fields would be a cache entry's worth of work for nothing. So inside
// that same ~30s window the `<title>` and `<meta description>` can be in a
// different language from the body, and can carry a newer competition name
// than the `<h1>`. The visible page stays self-consistent, which is the half a
// reader can see; the invisible half is allowed to be up to 30s fresher.
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
import { hubDict } from "@/lib/hub-dict";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { SponsorsBoard, SponsorsHeroTitle } from "@/components/public-site/sponsors-board";
import { CompetitionLanding } from "@/components/public-site/matches-hub/competition-landing";
// ONE producer for the competition's date line, shared with the Info tab that
// renders the same two dates a tab away. Two implementations of "1 September
// 2026 – 20 September 2026" is how one of them ends up a day out; `info-tab`'s
// is the one that already fixes the calendar-date/timezone trap below.
import { competitionDateLine } from "@/components/public-site/matches-hub/info-tab";
import { ShareBar } from "@/components/share-bar";
import { shareLabels } from "@/components/public-site/share-labels";
import { linkOnlyRobots } from "@/lib/competition-listing";

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
    // Doc 09 §1: link-only = crawlers out, page up. Unlisted, and — owner
    // decision 2026-09-27 — a DRAFT, which is unlisted until published.
    ...linkOnlyRobots(data.competition),
  };
}

export default async function CompetitionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  // ── THE HUB FIRST, THEN THE SHELL, AND SEQUENTIALLY ─────────────────────
  // `getPublicCompetitionHub` awaits `getPublicCompetition` itself on every
  // invocation (`competition-hub.ts:692` — outside its own cached callback,
  // because `unstable_cache` needs its tag list at call time). So the shell is
  // read either way and this second call is a warm hit on an entry the line
  // above has already populated.
  //
  // A `Promise.all` here would NOT have been "one query, not two": on a cold
  // entry `unstable_cache` has no in-flight registry to join. Read on
  // next@16.2.9 — `unstable-cache.js:209-219` — the miss path is a bare
  // `await workUnitAsyncStorage.run(innerCacheStore, cb, …)` and the cache
  // write is queued into `pendingRevalidates` only AFTER it resolves, so two
  // concurrent misses on the same key both run the callback. Sequencing makes
  // the single read true by construction instead of claimed.
  //
  // Latency is unchanged: the hub is the long pole either way, and the shell
  // read is inside it.
  const hub = await getPublicCompetitionHub(orgSlug, competitionSlug);
  const data = await getPublicCompetition(orgSlug, competitionSlug);
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

  // The five share words, from the ONE mapping every public page uses
  // (`components/public-site/share-labels.ts` — short visible "WhatsApp", the
  // full sentence as the accessible name). This page is a competition, so its
  // accessible name says so.
  const shareBarLabels = shareLabels(dict, "share.whatsappAria");
  // From the SHELL's slugs, deliberately, while `presentHref`/`registerHref`
  // below come off the document. The two cannot differ today (both resolve to
  // the route params), so this is a rule for the ~30s window above, and the
  // rule is not "one authority" but "the right authority for the job": a share
  // URL is copied into WhatsApp and kept, so it wants the NEWEST slug, which is
  // the shell's, while the document's hrefs are in-product navigation and
  // consistency with the rest of the document is worth more there.
  //
  // What a stale slug actually costs has now been written here wrongly THREE
  // times: "one permanent redirect (`sharedRenameTarget`)", then "both just
  // `notFound()`", then a measured version that the K fix round falsified hours
  // later. Re-measured 2026-09-16 against a prod build, rename rows seeded in
  // `slug_history` and every URL curled unfollowed:
  //
  //   - a stale ORG slug 308s on both trees, but they land in DIFFERENT places.
  //     /present keeps the whole tail — /shared/<old>/<comp>/present goes to
  //     /shared/<new>/<comp>/present, the division board likewise — because the
  //     kiosk layout now defers (`publicOrgOrNull`) and each board page runs
  //     the lookup with its full path. THIS tree does not: /shared/<old>/<comp>
  //     lands on /shared/<new>, the org hub, and /register with it. The chrome
  //     layout still enters through `publicOrgOr404`, and a layout holds only
  //     `orgSlug`, so its tail-less redirect wins the response before the
  //     page-level lookup above — which would keep the tail — ever runs.
  //   - a stale COMPETITION slug now 308s at its own depth on both trees:
  //     /shared/<org>/<old> here, /shared/<org>/<old>/present on the board, and
  //     the division board keeps /{div}. The bare `notFound()` that made the
  //     board 404 was F3 and is gone. /register is the exception and still
  //     404s: it consults no rename history at all.
  //
  // So what is left is THIS tree's tail-drop, and it is not fixed here. The
  // blocker this comment used to claim — "reading the rest of the path in a
  // layout means `headers()`, which costs the `revalidate = 30` cache" — is not
  // one. The kiosk fix moved the decision DOWN into the page, which already
  // holds every param and stays static; that is the shape a fix here takes.
  // Both halves are driven against real renames in `kiosk-phone-card.spec.ts`,
  // including the org-hub landing above, so a fix moves a red test.
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
              {competitionDateLine(hub.info, locale) ? (
                <p data-testid="mh-hero-dates" className="mt-2 text-sm text-court-muted">
                  {competitionDateLine(hub.info, locale)}
                </p>
              ) : null}
              {/* The title sponsor, under the competition name (owner ruling
                  2026-09-12, Option B). It renders `null` when there is no
                  title tier — including for every free org, which has none by
                  construction — so no predicate is needed here and an absent
                  sponsor costs no space. The rest of the board is below the
                  tabs; `sponsors-board.tsx`'s header carries the reasoning. */}
              <SponsorsHeroTitle sponsors={sponsors} tiered={tiered} dict={dict} />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <ShareBar path={sharePath} title={hub.name} labels={shareBarLabels} />
                {/* v13 (PROMPT-64): kiosk mode — cast this URL to any screen.
                    The `▸` stays OUT of the dictionary string: a decorative
                    glyph inside translated copy is what gets mangled per
                    locale (Task 6 ruling 24).

                    `max-md:hidden` — and this is a PRODUCT call, not a layout
                    one. Present casts the competition to a big screen at a
                    ground; it is not something anyone does from the phone they
                    are holding, and on a phone it was the fourth control in a
                    hero row that already wrapped onto two lines.

                    It is HIDDEN, not removed: the Info tab renders the same
                    link (`mh-info-present`) at every width, so the kiosk is
                    still reachable on a phone, one tab away — which is what
                    makes this a fold rather than a feature a phone loses. */}
                <Link
                  data-testid="mh-hero-present"
                  href={hub.info.presentHref}
                  className="inline-flex min-h-11 items-center rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-court-muted ring-1 ring-inset ring-white/15 transition hover:bg-white/20 hover:text-court-ink max-md:hidden"
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
          live-now rail, the competition's prose, the divisions grid — is now a
          panel of this root, drawn from the hub document. The slots are
          `undefined` rather than an element that renders nothing, which is the
          caller contract both `OverviewTab` and `InfoTab` state: a heading over
          an absent block reads as content that failed to load.

          The sponsor board is deliberately NOT among them — see below. */}
      <CompetitionLanding
        initial={hub}
        // The HUB SLICE, not the whole dictionary. `CompetitionLanding` is a
        // client root, so whatever it is handed is serialised into the HTML —
        // the full `public.json` was 85 KB of a 131 KB page, and put every
        // string in the body whether or not anything rendered it. See
        // `lib/hub-dict.ts`; the differential test there is what keeps the
        // slice honest, not the prefix list.
        dict={hubDict(dict)}
        locale={locale}
        descriptionSlot={descriptionHtml ? <CompetitionProse html={descriptionHtml} /> : undefined}
        // The Info tab's own share block. The hero's bar is the prominent one;
        // this is the one a spectator who scrolled into "everything about this
        // competition" expects to find there, and leaving the slot empty would
        // have shipped that section dead.
        shareSlot={<ShareBar path={sharePath} title={hub.name} labels={shareBarLabels} />}
      />

      {/* THE PERIMETER BOARD, on the PAGE rather than inside a tab.
          A sponsor board that lives in the Overview and Info panels vanishes
          the moment a spectator taps Matches, Table, Stats or Teams — which is
          most of the surface, and all of the surface a game is actually watched
          on. Below the panel it is present on every tab, spans the full content
          width (a perimeter board is the width of the ground, not a column),
          and is the last thing on the page, where a board at a venue sits.

          Mounted unconditionally: it returns `null` when it has nothing to draw
          — no sponsors at all, or a tiered org whose only sponsor is the title
          tier now rendered in the hero. */}
      <SponsorsBoard sponsors={sponsors} tiered={tiered} dict={dict} />
    </div>
  );
}
