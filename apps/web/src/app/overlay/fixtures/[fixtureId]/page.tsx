// The transparent per-fixture overlay a club adds to OBS as a Browser source.
//
// Two gates, both server-side, both `notFound()` so a non-entitled org is
// indistinguishable from a missing fixture (R1): the public visibility rules
// (via `publicFixtureSlugs` + `getPublicFixture`, the same reads the public
// match page makes) and the `streaming.overlay` entitlement. The client never
// decides. No redirect anywhere on this route (R8).
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture, publicFixtureSlugs } from "@/server/public-site/data";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { overlayStartLabel } from "@/lib/overlay-model";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { resolveTheme } from "@/components/overlay/theme-registry";
import { resolveDelayMs } from "@/lib/overlay-delay";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// RE-PIN (2026-09-09): the brief's own `export const revalidate = 30` +
// `generateStaticParams() { return [] }` (ISR, matching the sibling public
// match page) throws `DYNAMIC_SERVER_USAGE` at request time — confirmed
// against a live server: HTTP 500, "An error occurred in the Server
// Components render", `digest: 'DYNAMIC_SERVER_USAGE'`. The sibling page
// (`(public)/shared/.../fixtures/[fixtureId]/page.tsx`) hit the exact same
// throw and documents it (its own Task 14d comment): in this Next version
// (`node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-
// components.md`), reading `searchParams` inside a page that stays
// statically/ISR-cacheable is invalid. That page's fix was to stop reading
// `searchParams` at all (`?tab=` moved to a client `useSearchParams`) — not
// available here, because `?style=`/`?lang=` MUST resolve server-side (the
// theme id and the locale/dict both have to be picked before the client
// island ever mounts, per owner answer 18 and R1's two 404 gates). So this
// route takes the OTHER of the two documented escape hatches instead:
// `dynamic = "force-dynamic"`, which is "equivalent to" reading a dynamic API
// per that same doc — opts the ROUTE itself out of ISR/prerendering, not the
// data underneath it: `getPublicFixture`/`publicFixtureSlugs` are still
// `unstable_cache`-wrapped at 30 s (Task 0/9), so every request still hits a
// cheap cached read; only the page's OWN render runs per-request rather than
// being replayed from a prerendered/ISR'd HTML shell.
export const dynamic = "force-dynamic";
export async function generateStaticParams() {
  return [];
}

type Params = { fixtureId: string };
type Query = { style?: string; lang?: string; delay?: string };

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { fixtureId } = await params;
  const { style, lang, delay } = await searchParams;

  // Task 5d — closes the delay-compensation seam: an unparseable or
  // out-of-range `?delay=` falls back to 0 (undelayed) rather than
  // throwing, the same stance `resolveTheme` below documents for `?style=`
  // ("A 404 or an exception here would take a club off air over a query
  // string"). Resolved HERE, server-side, beside `style`/`lang` — never on
  // the client — for the same reason those two are (this route's own
  // `dynamic = "force-dynamic"` comment above).
  const delayMs = resolveDelayMs(delay);

  const slugs = await publicFixtureSlugs(fixtureId);
  if (!slugs) notFound();
  const data = await getPublicFixture(slugs.orgSlug, slugs.compSlug, slugs.divSlug, fixtureId);
  if (!data) notFound();
  const { org, competition, division, fixture, entrantNames, realtime, venueTz } = data;

  // Competition-scoped, like every other spectator-side entitlement read here:
  // an Event Pass grants for the competition it was bought for.
  // Deviation from design §3.1's 2-arg org-wide read, recorded (review
  // 2026-09-08 finding 59): competition-scoped on purpose — an Event Pass
  // grants for the competition it was bought for (`getPublicFixture`'s own
  // realtime read does the same at data.ts). The override layer resolves
  // first either way (entitlements.ts), so the test org is unaffected; a
  // 2-arg read would deny a paid-for pass fixture.
  if (!(await hasFeature(org.id, "streaming.overlay", competition.id))) notFound();

  // `?lang` wins for a club broadcasting in a language other than the org's
  // own public locale; the org's default is the fallback, as on every public
  // surface.
  const locale = toLocale(lang ?? org.default_locale);
  const dict = (await getDictionary(locale, "public")) as Record<string, string>;

  const sides: [
    { id: string; name: string },
    { id: string; name: string },
  ] = [
    {
      id: fixture.home_entrant_id ?? "home",
      name: fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "—") : "—",
    },
    {
      id: fixture.away_entrant_id ?? "away",
      name: fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "—") : "—",
    },
  ];

  // Formatted HERE, where the locale is, through the ONE formatter
  // (`overlayStartLabel`, Task 2) and the VENUE zone Task 0 puts on the payload
  // — never UTC, and never `Intl` inlined at this call site.
  const startLabel = overlayStartLabel(fixture.scheduled_at, locale, venueTz);

  // First paint from the SAME contract the stage polls (Task 0, design §3.2):
  // the cached public row plus the folded-state clock/innings, one fold per
  // last_seq. `venueTz` here and on `initial` come from the same
  // `resolveVenueTz` call chain; the page keeps `getPublicFixture`'s copy for
  // the start label because that read already happened for the gate.
  const initial = await loadOverlayLiveData(fixture.id);

  return (
    <OverlayStage
      fixtureId={fixture.id}
      initial={initial}
      realtime={realtime}
      sportKey={division.sport_key}
      // Owner answer 18 (Q7): resolved against the REGISTRY, and only the id
      // crosses to the client — never the theme's `component`, which would be
      // a React element type travelling as an RSC prop. An unknown, misspelt
      // or sport-unsuitable `?style=` lands on this sport's default rather
      // than erroring: an OBS browser source cannot fix a typo mid-match.
      style={resolveTheme(style, division.sport_key).id}
      sides={sides}
      startLabel={startLabel}
      dict={dict}
      decidedTemplates={decidedOutcomeTemplates((k, v) => msgFor(locale, k, v))}
      delayMs={delayMs}
      fit
    />
  );
}
