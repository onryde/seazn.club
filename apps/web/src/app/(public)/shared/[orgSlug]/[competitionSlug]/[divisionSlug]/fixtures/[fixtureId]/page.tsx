// Live match page (doc 09 §2): render-agnostic scoreboard from the fold
// cache's ScoreSummary, live via realtime push (Pro) or 15 s polling, with
// SportsEvent JSON-LD (doc 09 §3).
//
// Task 14 (spectator surface W1) replaced the legacy `<LiveScore>` scorebug
// with the full match centre (`<MatchCentre>`, Task 10's shell + Tasks
// 11-13's real tab panels): `initial` is built here from the SAME
// `getPublicFixture` result the poll endpoint's own `match_centre` field
// mirrors (`server/public-site/data.ts`), so first paint and every refresh
// after it render the identical document shape (rule R10). `ShareButton`'s
// `useMsg()` (ui.json) needs a `<DictProvider>` ancestor to see the request
// locale at all — this route had none before this task, so its "Share on
// WhatsApp"/"Copied" labels always rendered in English regardless of
// `org.default_locale`; wrapping the page fixes that for real, the same
// convention `(public)/r/[ref]/page.tsx` already uses.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture } from "@/server/public-site/data";
import { sportsEventJsonLd } from "@/lib/public-site";
import { publicThemeStyle } from "@/lib/public-theme";
import { MatchCentreWithTabParam } from "@/components/public-site/match-centre/match-centre-with-tab-param";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";
import { ShareButton } from "@/components/share-button";
import { DictProvider } from "@/components/i18n/dict-provider";
import { fixtureSubheading } from "./fixture-subheading";
import { shareTextFor } from "./share-text";
import { resolveSlotLabel } from "@/lib/slot-label";
import { toLocale } from "@/lib/i18n-constants";
import type { Dict } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { getDictionary, t } from "@/lib/i18n";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import { decidedOutcomeText, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
// P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, same pattern
// as data.ts:502-503 and every other public surface this fix round wires.
// This IS a server component and getPublicFixture already carries `org`, so
// (unlike schedule/page.tsx's org-console equivalent) there is no
// direct-invocation-test/cookies() trap here: msgFor() takes an explicit
// Locale and never touches next/headers.
const lookup = (locale: Parameters<typeof msgFor>[0]) =>
  (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor(locale, k, v);

/**
 * R3.5/Task G — the sentence a decided fixture owes its reader: WHO won and,
 * where the copy exists, HOW. `fixture.outcome` (winner + method) and
 * `fixture.summary` (headline + the shoot-out tally inside `detail`) were
 * both already on this page as unused data; this composes them once so the
 * page body, the OG description and the WhatsApp share text below can't
 * drift on the wording.
 */
function decidedLineFor(
  fixture: { outcome: { kind?: string; winner?: string; method?: string } | null; summary: { detail?: unknown } | null },
  entrantNames: Record<string, string>,
  msgFn: ReturnType<typeof lookup>,
  // The shootout sentence is the SPORT's: ice hockey and field hockey have a
  // shootout, football has penalties. Threaded so the share/OG text and the
  // court card cannot describe one match two ways — which they did, briefly,
  // when only the court card was made sport-aware.
  sportKey: string,
): string | null {
  return decidedOutcomeText(
    fixture.outcome,
    entrantNames,
    msgFn,
    shootoutScoreFromDetail(fixture.summary?.detail),
    sportKey,
  );
}

/** Appends the decided sentence onto a headline (metadata/share text share
 *  this exact join so the two surfaces read consistently). Never invents a
 *  headline — a decided sentence with no headline stands alone. */
function withDecidedLine(headline: string | undefined, decidedLine: string | null): string | undefined {
  if (!decidedLine) return headline;
  return headline ? `${headline} — ${decidedLine}` : decidedLine;
}

/**
 * Task 14 — the decided fixture's raw score lines ("HOM 156/6" ·
 * "AWY 98 all out") plus the localised result sentence, straight off the
 * SAME match-centre document the page's own `<MatchCentre>` (and every
 * live poll after it) renders — never re-derived from `fixture.outcome`/
 * `summary` a second way. `null` when the document has neither (a decided
 * fixture the builder could not resolve a header for), so a title never
 * grows a bare "()".
 */
function scoreAndResultFor(matchCentre: MatchCentreDocT, dict: Dict): string | null {
  const scoreParts = matchCentre.header.sides
    .map((side, i) => {
      const line = matchCentre.header.scoreLines[i];
      return line ? `${side.short || side.name} ${line}` : null;
    })
    .filter((s): s is string => s !== null);
  const resultPhrase = matchCentre.header.statusLine
    ? t(dict, matchCentre.header.statusLine.key, matchCentre.header.statusLine.params)
    : null;
  const parts = [...scoreParts, ...(resultPhrase ? [resultPhrase] : [])];
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

// Task 14d — this page briefly read `searchParams` (`?tab=`) directly and
// shipped `export const dynamic = "force-dynamic"` to work around the
// resulting `DYNAMIC_SERVER_USAGE` throw, which broke the ISR contract
// (task-8) this route is audited against (public-isr-contract.test.ts). The
// `?tab=` deep link now moves client-side instead — see
// `match-centre-with-tab-param.tsx` (`useSearchParams` inside a `<Suspense>`
// boundary) — so this page never touches `searchParams` at all, and stays
// cacheable exactly like its sibling public pages.
type Props = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return {};
  const locale = toLocale(data.org.default_locale);
  const msgFn = lookup(locale);
  const dict = await getDictionary(locale, "public");
  const ui = await getDictionary(locale, "ui");
  const home = data.fixture.home_entrant_id
    ? (data.entrantNames[data.fixture.home_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(data.fixture.home_slot_label, msgFn, "schedule.tbd");
  const away = data.fixture.away_entrant_id
    ? (data.entrantNames[data.fixture.away_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(data.fixture.away_slot_label, msgFn, "schedule.tbd");
  const decidedLine = decidedLineFor(data.fixture, data.entrantNames, msgFn, data.division.sport_key);
  const decided = data.fixture.status === "decided" || data.fixture.status === "finalized";
  // Task 14 acceptance (a) — a decided fixture's title carries both the raw
  // score lines and the result phrase, so a share/search preview shows the
  // final score without opening the page.
  const scoreAndResult = decided ? scoreAndResultFor(data.matchCentre, dict) : null;
  // Task 14c (task-14b-review.md Remaining-English list) — the "vs"/"at"
  // glue words in this page's <title>/description were hardcoded English in
  // every locale; both are now whole-string templates (`fixture.meta.*`,
  // `ui.json`), mirroring the `fixture.share.*` templates `share-text.ts`
  // already uses for the identical "vs"→"contre"/"tegen" word choice.
  const title = scoreAndResult
    ? t(ui, "fixture.meta.titleDecided", { home, away, division: data.division.name, result: scoreAndResult })
    : t(ui, "fixture.meta.title", { home, away, division: data.division.name });
  return {
    title,
    description:
      withDecidedLine(data.fixture.summary?.headline, decidedLine) ??
      t(ui, "fixture.meta.description", { home, away, competition: data.competition.name }),
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function FixturePage({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) notFound();
  const { org, competition, division, fixture, entrantNames, realtime } = data;
  const locale = toLocale(org.default_locale);
  const msgFn = lookup(locale);
  // `public` (match-centre copy, threaded to `<MatchCentre>` as an explicit
  // prop — Task 11's convention) and `ui` (`ShareButton`'s `useMsg()`, via
  // the `<DictProvider>` below — the SAME split `(public)/r/[ref]/page.tsx`
  // already uses).
  const dict = await getDictionary(locale, "public");
  const ui = await getDictionary(locale, "ui");

  const home = fixture.home_entrant_id
    ? (entrantNames[fixture.home_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(fixture.home_slot_label, msgFn, "schedule.tbd");
  const away = fixture.away_entrant_id
    ? (entrantNames[fixture.away_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(fixture.away_slot_label, msgFn, "schedule.tbd");
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;
  const decidedLine = decidedLineFor(fixture, entrantNames, msgFn, division.sport_key);

  const jsonLd = sportsEventJsonLd({
    name: t(ui, "fixture.meta.jsonLdName", { home, away, division: division.name, competition: competition.name }),
    ...(fixture.scheduled_at ? { startDate: fixture.scheduled_at } : {}),
    // P9 cutover: venue_name is DERIVED (fixtures.venue_id via data.ts's
    // withCourtVenueNames) — venue is frozen, no writer touches it any more.
    ...(fixture.venue_name ? { location: fixture.venue_name } : {}),
    url: `https://seazn.club${basePath}/fixtures/${fixture.id}`,
    homeTeam: home,
    awayTeam: away,
    eventStatus:
      fixture.status === "cancelled"
        ? "EventCancelled"
        : fixture.status === "finalized" || fixture.status === "decided"
          ? "EventCompleted"
          : "EventScheduled",
  });

  // Task 14 — the SAME `LiveFixtureData` shape the poll endpoint returns
  // (`match_centre`, snake_case on the wire — `getPublicFixture`'s own
  // `matchCentre` field, camelCase, is the identical document under a
  // different key), so `useLiveFixture`'s first render and every refresh
  // after it are one shape, never two.
  const initial: LiveFixtureData = {
    status: fixture.status,
    summary: fixture.summary,
    outcome: fixture.outcome,
    match_centre: data.matchCentre,
  };

  return (
    <DictProvider dict={ui} locale={locale}>
      <div style={publicThemeStyle(competition.branding)}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        <nav className="mb-4 text-xs text-ink-muted">
          <Link
            href={`/shared/${org.slug}/${competition.slug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {competition.name}
          </Link>{" "}
          /{" "}
          <Link href={basePath} className="hover:text-accent-strong hover:underline">
            {division.name}
          </Link>
        </nav>

        <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-ink">
            {home} <span className="text-ink-muted">{msgFn("schedule.vs")}</span> {away}
          </h1>
          {/* One-tap share (v3/10 #2) — the message reads like a human wrote it.
              Task 14b — both `title` and `text` now go through the request
              locale: `title` reuses the SAME `schedule.vs` word the visible
              <h1> above already renders (it was still a bare "vs" here,
              inconsistent with that heading in every non-English locale);
              `text` is `shareTextFor` (`./share-text.ts`), localised via
              `fixture.share.decided`/`fixture.share.live`/
              `fixture.share.fullTime`. */}
          <ShareButton
            title={`${home} ${msgFn("schedule.vs")} ${away}`}
            text={shareTextFor(
              fixture.status === "decided" || fixture.status === "finalized",
              home,
              away,
              division.name,
              competition.name,
              withDecidedLine(fixture.summary?.headline, decidedLine),
              ui,
            )}
            url={`${basePath}/fixtures/${fixture.id}`}
          />
        </div>
        {/* R11 fix round, C3 — `fixtureSubheading` returns "" for an in-play
            fixture with no scheduled time (the court card right below
            already carries the LIVE chip); joining through `filter(Boolean)`
            rather than string concatenation means that empty case doesn't
            leave a stray leading " · " in front of the venue/court name, and
            the whole line disappears rather than rendering blank when there
            is neither a subheading nor a venue/court to show. */}
        {(() => {
          const subheadingParts = [
            fixtureSubheading(fixture.status, fixture.scheduled_at, t(dict, "matchCentre.status.timeTbd")),
            fixture.venue_name,
            fixture.court_name,
          ].filter((part): part is string => Boolean(part));
          return subheadingParts.length > 0 ? (
            <p className="mb-4 text-sm text-ink-muted">{subheadingParts.join(" · ")}</p>
          ) : null;
        })()}

        {/* Task 14 — the match centre replaces the old bare scorebug
            (`<LiveScore>`, retired). `<MatchCentre>` drives its own live
            transport (`useLiveFixture`) from `initial` and re-renders every
            open tab in place on each poll/realtime update (rule R10) — the
            decided-fixture sentence R3.5/Task G|O introduced now lives in
            the document's own `header.statusLine` (`CourtCard`), resolved
            through the SAME `dict` every panel gets, so it updates live in
            the viewer's own locale without this page re-rendering. */}
        <MatchCentreWithTabParam
          fixtureId={fixture.id}
          initial={initial}
          realtime={realtime}
          dict={dict}
          locale={locale}
        />
      </div>
    </DictProvider>
  );
}
