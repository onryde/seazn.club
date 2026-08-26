// Live match page (doc 09 §2): render-agnostic scoreboard from the fold
// cache's ScoreSummary, live via realtime push (Pro) or 15 s polling, with
// SportsEvent JSON-LD (doc 09 §3).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture } from "@/server/public-site/data";
import { sportsEventJsonLd } from "@/lib/public-site";
import { publicThemeStyle } from "@/lib/public-theme";
import { LiveScore } from "@/components/public-site/live-score";
import { ShareButton } from "@/components/share-button";
import { fixtureSubheading } from "./fixture-subheading";
import { resolveSlotLabel } from "@/lib/slot-label";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeText, decidedOutcomeTemplates, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
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
): string | null {
  return decidedOutcomeText(
    fixture.outcome,
    entrantNames,
    msgFn,
    shootoutScoreFromDetail(fixture.summary?.detail),
  );
}

/** Appends the decided sentence onto a headline (metadata/share text share
 *  this exact join so the two surfaces read consistently). Never invents a
 *  headline — a decided sentence with no headline stands alone. */
function withDecidedLine(headline: string | undefined, decidedLine: string | null): string | undefined {
  if (!decidedLine) return headline;
  return headline ? `${headline} — ${decidedLine}` : decidedLine;
}

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return {};
  const msgFn = lookup(toLocale(data.org.default_locale));
  const home = data.fixture.home_entrant_id
    ? (data.entrantNames[data.fixture.home_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(data.fixture.home_slot_label, msgFn, "schedule.tbd");
  const away = data.fixture.away_entrant_id
    ? (data.entrantNames[data.fixture.away_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(data.fixture.away_slot_label, msgFn, "schedule.tbd");
  const decidedLine = decidedLineFor(data.fixture, data.entrantNames, msgFn);
  return {
    title: `${home} vs ${away} — ${data.division.name}`,
    description:
      withDecidedLine(data.fixture.summary?.headline, decidedLine) ??
      `${home} vs ${away} at ${data.competition.name}`,
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
  const msgFn = lookup(toLocale(org.default_locale));

  const home = fixture.home_entrant_id
    ? (entrantNames[fixture.home_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(fixture.home_slot_label, msgFn, "schedule.tbd");
  const away = fixture.away_entrant_id
    ? (entrantNames[fixture.away_entrant_id] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
    : resolveSlotLabel(fixture.away_slot_label, msgFn, "schedule.tbd");
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;
  const decidedLine = decidedLineFor(fixture, entrantNames, msgFn);

  const jsonLd = sportsEventJsonLd({
    name: `${home} vs ${away} — ${division.name}, ${competition.name}`,
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

  return (
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
          {home} <span className="text-ink-muted">vs</span> {away}
        </h1>
        {/* One-tap share (v3/10 #2) — the message reads like a human wrote it. */}
        <ShareButton
          title={`${home} vs ${away}`}
          text={
            fixture.status === "decided" || fixture.status === "finalized"
              ? `${home} vs ${away} — ${withDecidedLine(fixture.summary?.headline, decidedLine) ?? "full-time"} (${division.name}, ${competition.name})`
              : `${home} vs ${away} — ${division.name}, ${competition.name}. Follow it live:`
          }
          url={`${basePath}/fixtures/${fixture.id}`}
        />
      </div>
      <p className="mb-4 text-sm text-ink-muted">
        {fixtureSubheading(fixture.status, fixture.scheduled_at)}
        {fixture.venue_name ? ` · ${fixture.venue_name}` : ""}
        {fixture.court_name ? ` · ${fixture.court_name}` : ""}
      </p>

      {/* R3.5/Task G gave this page the winner-and-HOW sentence (`decidedLine`
          above, still used by the OG description and share text below, which
          are inherently one-shot renders). R3.5/Task O moved the VISIBLE copy
          of it from a static paragraph here into `LiveScore` itself: a Server
          Component can only render `decidedLine` once, at request time, so a
          spectator already on this page when a decider lands never saw it
          without a reload. `LiveScore` recomputes the same sentence from its
          own live `data.outcome` on every poll/realtime update — the
          `decidedTemplates` prop is the (pre-localized, not yet interpolated)
          copy this client island has no dictionary of its own to produce. */}
      <LiveScore
        fixtureId={fixture.id}
        initial={{ status: fixture.status, summary: fixture.summary, outcome: fixture.outcome }}
        realtime={realtime}
        entrantNames={entrantNames}
        sportKey={division.sport_key}
        decidedTemplates={decidedOutcomeTemplates(msgFn)}
      />
    </div>
  );
}
