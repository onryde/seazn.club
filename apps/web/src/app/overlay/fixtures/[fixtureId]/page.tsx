// The transparent per-fixture overlay a club adds to OBS as a Browser source.
//
// Two gates, both server-side, both `notFound()` so a non-entitled org is
// indistinguishable from a missing fixture (R1): the public visibility rules
// (via `publicFixtureSlugs` + `getPublicFixture`, the same reads the public
// match page makes) and the `streaming.overlay` entitlement. The client never
// decides. No redirect anywhere on this route (R8).
//
// R2005 change 1 — the compositor's door. A composed stream session's
// `overlayUrl` carries `sid` + `st`; with BOTH present the visibility gate is
// replaced by `relayPageAccess` (the relay page token for that session, the
// session on this fixture, composed, not terminal) and the facts come from the
// uncached base-table read (`relayOverlayPageFacts`), so a private
// competition's fixture streams with its score bug. Any failure there is the
// same `notFound()`. The entitlement gate applies on both doors. Without
// `sid`/`st` nothing below differs from before, `?host=` included: the
// compositor's signals are turned on only behind a verified relay access.
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { overlayStartLabel } from "@/lib/overlay-model";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { publicOverlayPageFacts, relayOverlayPageFacts } from "@/server/overlay/page-facts";
import { relayPageAccess, relayParamsOf, type RelayPageAccess } from "@/server/overlay/relay-access";
import { COMPOSITOR_HOST, isCompositorHost } from "@/lib/overlay-compositor";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { resolveTemplate, templateParam } from "@/components/overlay/template-registry";
import { resolveDelayMs } from "@/lib/overlay-delay";
import { OVERLAY_KEY_PARAM, OVERLAY_REALTIME_PURPOSE } from "@/lib/realtime-purpose";

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
/** RT: the signed key rides under the token route's own parameter name, so the panel that writes it, this page that
 *  reads it and the route that verifies it spell it once (lib/realtime-purpose.ts). */
/** R2007 decision 2: `template` is read first; `style` is the alias every pre-R2007 OBS URL carries, kept forever. */
/** R2005: `sid` + `st` are the composed session's relay page access, `host=compositor` its signals switch. */
type Query = {
  template?: string | string[];
  style?: string | string[];
  lang?: string;
  delay?: string;
  sid?: string | string[];
  st?: string | string[];
  host?: string | string[];
} & {
  [K in typeof OVERLAY_KEY_PARAM]?: string | string[];
};

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { fixtureId } = await params;
  const query = await searchParams;
  const { lang, delay } = query;
  const key = query[OVERLAY_KEY_PARAM];

  // Task 5d — closes the delay-compensation seam: an unparseable or
  // out-of-range `?delay=` falls back to 0 (undelayed) rather than
  // throwing, the same stance `resolveTemplate` below documents for `?template=`
  // ("A 404 or an exception here would take a club off air over a query
  // string"). Resolved HERE, server-side, beside `style`/`lang` — never on
  // the client — for the same reason those two are (this route's own
  // `dynamic = "force-dynamic"` comment above).
  const delayMs = resolveDelayMs(delay);

  // R2005 change 1: both present ⇒ the relay door, and ONLY the relay door — a refusal there is a 404, never a quiet
  // fall-through to the public read (the compositor's page must not render whatever the public door happens to allow).
  const relayParams = relayParamsOf(query);
  let access: RelayPageAccess | null = null;
  if (relayParams) {
    access = await relayPageAccess(fixtureId, relayParams);
    if (!access) notFound();
  }
  const facts = access ? await relayOverlayPageFacts(fixtureId) : await publicOverlayPageFacts(fixtureId);
  if (!facts) notFound();
  const { org, competition, sportKey, fixture, sides, realtime, venueTz, stageName } = facts;

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

  // Formatted HERE, where the locale is, through the ONE formatter
  // (`overlayStartLabel`, Task 2) and the VENUE zone Task 0 puts on the payload
  // — never UTC, and never `Intl` inlined at this call site.
  const startLabel = overlayStartLabel(fixture.scheduled_at, locale, venueTz);

  // First paint from the SAME contract the stage polls (Task 0, design §3.2):
  // the cached public row plus the folded-state clock/innings, one fold per
  // last_seq. `venueTz` here and on `initial` come from the same
  // `resolveVenueTz` call chain; the page keeps `getPublicFixture`'s copy for
  // the start label because that read already happened for the gate.
  // R2005: the relay door reads the row off the base tables and folds under its own cache namespace, and the first
  // paint carries the stored beat's phase as the route's relay answer does (fallback B).
  const live = await loadOverlayLiveData(fixture.id, access ? { relay: true } : {});
  const initial = access?.programmePhase ? { ...live, programmePhase: access.programmePhase } : live;

  // RT (lane-close fix, ruled 2026-09-29): the signed key the organiser's panel put in this URL (`?key=`). Passed to the
  // stage WITH the overlay purpose, so its transport asks the token route for realtime even on a plan without it; the
  // route verifies the key (constant-time, fixture-bound) and a bad one simply leaves the stage on the poll. Not checked
  // here: one authority for the grant. A repeated `?key=` is not a key.
  const overlayKey = typeof key === "string" && key.length > 0 ? key : undefined;

  return (
    <OverlayStage
      fixtureId={fixture.id}
      initial={initial}
      realtime={realtime}
      sportKey={sportKey}
      // Owner answer 18 (Q7): resolved against the REGISTRY, and only the id
      // crosses to the client — never the template's `component`, which would
      // be a React element type travelling as an RSC prop. R2007 decision 2:
      // `?template=` wins when present, `?style=` is the alias; an unknown,
      // misspelt or sport-unsuitable id lands on this sport's default and a
      // retired one on its replacement, never an error: an OBS browser source
      // cannot fix a typo mid-match.
      style={resolveTemplate(templateParam(query), sportKey).id}
      sides={sides}
      startLabel={startLabel}
      slateMeta={{
        competition: competition.name,
        // stages.name — not division.name (that is the league/flight label).
        ...(stageName ? { stage: stageName } : {}),
      }}
      dict={dict}
      decidedTemplates={decidedOutcomeTemplates((k, v) => msgFor(locale, k, v))}
      delayMs={delayMs}
      {...(overlayKey ? { realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey } : {})}
      // R2005: the relay access rides every poll; `host` only behind it (and the page never passes `sceneOverride`).
      {...(access ? { relay: { sid: access.sid, st: access.st } } : {})}
      {...(access && isCompositorHost(query.host) ? { host: COMPOSITOR_HOST } : {})}
      fit
    />
  );
}
