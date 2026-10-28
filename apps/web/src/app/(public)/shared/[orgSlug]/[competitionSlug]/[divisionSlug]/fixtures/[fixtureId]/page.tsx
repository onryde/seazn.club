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
import { getPublicFixture, type PublicFixture } from "@/server/public-site/data";
import { sportsEventJsonLd } from "@/lib/public-site";
import { publicThemeStyle } from "@/lib/public-theme";
import { MatchCentreWithTabParam } from "@/components/public-site/match-centre/match-centre-with-tab-param";
import { ReplayEmbed } from "@/components/public-site/match-centre/replay-embed";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";
import { ShareButton } from "@/components/share-button";
import { PosterButton } from "@/components/public-site/poster-button";
import { posterFileName } from "@/lib/poster-file-name";
import { statusOf } from "@/server/public-site/match-centre";
import { DictProvider } from "@/components/i18n/dict-provider";
import { MatchCentreSubheading } from "./subheading";
import { WatchPanel } from "@/components/public-site/match-centre/watch-panel";
import { showWatchPanel } from "@/components/public-site/match-centre/watch-state";
import type { PublicWatchDoc } from "@/server/external-play/public-view";
import { YourBoard } from "@/components/public-site/your-board";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { assertTimeControl } from "@/server/external-play/time-controls";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { shareTextFor } from "./share-text";
import { streamLinkLabelKey } from "./stream-link";
import { replayPlan } from "./replay-plan";
import { resolveSlotLabel } from "@/lib/slot-label";
import { toLocale } from "@/lib/i18n-constants";
import type { Dict } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { getDictionary, t } from "@/lib/i18n";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import { decidedOutcomeText, shootoutScoreFromDetail, tiebreakScoreFromDetail } from "@/lib/scoring-vocab";
import { linkOnlyRobots } from "@/lib/competition-listing";
import { FORFEIT_SENTENCE_KEYS, creditsNobody as outcomeCreditsNobody } from "@/lib/forfeit-tag";
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
  // W2b T13 review M-4 — a credited result (a forfeit, a double walkover, an
  // abandon with its reason) is described by the match centre's OWN status
  // line, which its builder words from `forfeitTag` with the two facts this
  // page does not hold (a double walkover's next round, an abandon's result).
  // Re-deriving it here said "{winner} won" for a walkover and nothing for a
  // double walkover.
  matchCentre: MatchCentreDocT,
  dict: Dict,
): string | null {
  const line = matchCentre.header.statusLine;
  if (line !== null && (FORFEIT_SENTENCE_KEYS as readonly string[]).includes(line.key)) {
    return t(dict, line.key, line.params);
  }
  return decidedOutcomeText(
    fixture.outcome,
    entrantNames,
    msgFn,
    shootoutScoreFromDetail(fixture.summary?.detail),
    sportKey,
    tiebreakScoreFromDetail(fixture.summary?.detail),
  );
}

/** W2b T13 review M-4 — the statuses whose fixture HAS a result to share: a
 *  forfeited one is over with a credited result (a walkover read "follow it
 *  live" before). A held fixture (`needs_decision`, an abandon awaiting a
 *  settle) has none yet. One list for the title and the share text. */
const RESULT_STATUSES: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

/** A double walkover credits nobody: its summary's 0 — 0 is not a score, so
 *  no title or description prints it beside the sentence that says so. The
 *  one predicate every host asks (design review M-1), read off the fixture. */
function creditsNobody(fixture: { outcome: unknown }): boolean {
  return outcomeCreditsNobody(fixture.outcome);
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
function scoreAndResultFor(matchCentre: MatchCentreDocT, dict: Dict, scoreless = false): string | null {
  const scoreParts = (scoreless ? [] : matchCentre.header.sides)
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

/**
 * The two side names this page prints: its h1, `<title>` and description, the
 * share text, the poster's file name and the JSON-LD teams.
 *
 * A side with an entrant is that entrant's (masked) name. A side still WAITING
 * is the match centre's own name for it — `matchCentre.header.sides`, built by
 * `loadMatchCentre` beside this fixture in `getPublicFixture` — so the headline
 * and the court card directly below it say the same words ("Winner of
 * Semi-finals, match 1"). Resolving the stored slot label a second time here
 * printed the organiser board's "Winner of R1·1" above a court card that said
 * otherwise (N1 fix round 1, I1): one authority, already loaded, no extra query.
 */
function sideNamesFor(
  data: {
    fixture: Pick<PublicFixture, "home_entrant_id" | "away_entrant_id">;
    entrantNames: Record<string, string>;
    matchCentre: MatchCentreDocT;
  },
  msgFn: ReturnType<typeof lookup>,
): [string, string] {
  const nameOf = (entrantId: string | null, side: 0 | 1): string =>
    entrantId
      ? (data.entrantNames[entrantId] ?? resolveSlotLabel(null, msgFn, "schedule.tbd"))
      : data.matchCentre.header.sides[side].name;
  return [nameOf(data.fixture.home_entrant_id, 0), nameOf(data.fixture.away_entrant_id, 1)];
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
  const [home, away] = sideNamesFor(data, msgFn);
  const decidedLine = decidedLineFor(data.fixture, data.entrantNames, msgFn, data.division.sport_key, data.matchCentre, dict);
  const decided = RESULT_STATUSES.has(data.fixture.status);
  const headline = creditsNobody(data.fixture) ? undefined : data.fixture.summary?.headline;
  // Task 14 acceptance (a) — a decided fixture's title carries both the raw
  // score lines and the result phrase, so a share/search preview shows the
  // final score without opening the page.
  const scoreAndResult = decided ? scoreAndResultFor(data.matchCentre, dict, creditsNobody(data.fixture)) : null;
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
      withDecidedLine(headline, decidedLine) ??
      t(ui, "fixture.meta.description", { home, away, competition: data.competition.name }),
    // Doc 09 §1: link-only = crawlers out, page up. Unlisted, and — owner
    // decision 2026-09-27 — a DRAFT, which is unlisted until published.
    ...linkOnlyRobots(data.competition),
  };
}

/** Match details' time control: the division's clock as the online catalogue reads it, or null for one it cannot
 *  (the line is then left out rather than guessed). */
function watchClockOf(config: unknown): { limitSeconds: number; incrementSeconds: number } | null {
  try {
    const tc = assertTimeControl((config as { clock?: BoardgameClockInput } | null)?.clock);
    return { limitSeconds: tc.limitSeconds, incrementSeconds: tc.incrementSeconds };
  } catch {
    return null;
  }
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

  const [home, away] = sideNamesFor(data, msgFn);
  const onlineBoard = supportsOnlinePlay(division.sport_key) && readOnlinePlay(division.config) === "lichess";
  const watchDoc: PublicWatchDoc = { roundOpened: data.roundOpened, roundOpenedAt: data.roundOpenedAt, externalPlay: data.externalPlay };
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;
  const decidedLine = decidedLineFor(fixture, entrantNames, msgFn, division.sport_key, data.matchCentre, dict);
  // T16 — the replay parts the player lists, and whether the club's own link still shows beside it (replay-plan.ts).
  const plan = replayPlan({ status: fixture.status, streamUrl: fixture.stream_url ?? null, parts: data.parts });

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
        : // W2a: a held fixture (`needs_decision`) was PLAYED — only the verdict waits — so the event took place.
          fixture.status === "finalized" || fixture.status === "decided" || fixture.status === "needs_decision"
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
        {/* `‹ Competition · Division` — the design board's breadcrumb. The
            leading chevron says "up from here" before either link is read,
            which a bare "A / B" does not; the competition page's own nav
            already opens with `←` for the same reason. The separator is `·`
            rather than `/`, matching every other meta line on this surface
            (the court card's, the sponsor ticker's).

            `aria-hidden` on the chevron: it is punctuation, and a screen
            reader announcing "single left-pointing angle quotation mark"
            before the competition's name is noise. */}
        <nav className="mb-4 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
          <span aria-hidden>‹</span>
          <Link
            href={`/shared/${org.slug}/${competition.slug}`}
            className="inline-flex min-h-11 items-center hover:text-accent-strong hover:underline"
          >
            {competition.name}
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={basePath}
            className="inline-flex min-h-11 items-center hover:text-accent-strong hover:underline"
          >
            {division.name}
          </Link>
        </nav>

        {/* T16 — a player's door into their match room. This HTML is shared (ISR), so it carries no door: the
            island asks the lobby route after hydration, and only one of the two players gets an answer. ABOVE the
            headline, not under it: a player's first visit is a cold one (the invite mail), so the site's cookie notice
            — fixed to the bottom, ~240px tall at 320 — is up when the card arrives, and under the headline it sat over
            "Go to your board" (e2e run 38481554563, 320x700). Here it clears the notice at 320x568. A spectator gets
            nothing, so their page does not move. */}
        {onlineBoard ? <YourBoard fixtureId={fixture.id} /> : null}

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
          {/* Spectator boards §match-centre: the header row carries TWO
              actions, `Poster` then `Share`. The poster is a picture of this
              match (1080x1350, cut server-side at `poster.png`); the share is
              the link. They sit together because they answer the same
              question — "send this to the group" — with the two things people
              actually send. */}
          <div className="flex flex-wrap items-center gap-2">
          <PosterButton
            href={`${basePath}/fixtures/${fixture.id}/poster.png`}
            fileName={posterFileName(home, away)}
            // `statusOf`, not `data.matchCentre.header.status`: the same
            // function the header itself derives that field with, applied to
            // the status this component already holds. Reaching back through
            // the whole match-centre document for a value one call away made
            // the page depend on a field it never otherwise reads.
            variant={statusOf(fixture.status)}
          />
          <ShareButton
            title={`${home} ${msgFn("schedule.vs")} ${away}`}
            text={shareTextFor(
              RESULT_STATUSES.has(fixture.status),
              home,
              away,
              division.name,
              competition.name,
              withDecidedLine(creditsNobody(fixture) ? undefined : fixture.summary?.headline, decidedLine),
              ui,
            )}
            url={`${basePath}/fixtures/${fixture.id}`}
          />
          </div>
        </div>
        {/* M1 k2 — a client island, not a server-rendered `<p>`. This line was
            composed here once per request from the fixture row, so after a
            rain-delay reschedule the court card below showed the new kick-off
            (its document refetched at 895 ms) and this still showed the old
            one — one page, two times, until the reader reloaded (rule R10).
            It now renders from the SAME live snapshot `<MatchCentre>` does,
            published to `live-fixture-channel` rather than fetched a second
            time, and off the same `startTimeText` output the court card's
            "Starts …" sentence renders — one kick-off, one wording, one
            timezone. `initial` is this request's own document, so first paint
            is byte-identical to a server render. */}
        <MatchCentreSubheading
          fixtureId={fixture.id}
          initial={initial}
          dict={dict}
          {...(onlineBoard ? { roundOpen: { at: data.roundOpenedAt, timeZone: data.venueTz, locale } } : {})}
        />

        {/* Stream overlay W1 (design §3.9) — the club's own broadcast, under
            the headline block and above the match centre. PLACEMENT ONLY:
            spectator W1 owns this page's composition and moves the link into
            its court header's action row (spec §7), so nothing here builds a
            header of its own.

            Three things are deliberate:
            • `rel="noopener"` is not optional. The href is organiser-supplied,
              and `target="_blank"` without it hands the opened tab a live
              `window.opener` handle to this page. The host is already held to
              R16's allowlist at save time (`usecases/fixtures.ts`); this is the
              second, independent guard, on the read side. `noopener` ALONE,
              not `noopener noreferrer` — the three documents that pin this
              (design §3.9, W1-step-one item 7, and `PublicFixture.stream_url`'s
              own doc comment in `server/public-site/data.ts`) all say
              `noopener`, and the referrer is worth keeping: it is how the
              club's own destination sees the traffic came from its seazn page.
            • No `setup`-division check. `public_fixtures_v` redacts
              `stream_url` to null in the VIEW (V401, `case when d.status =
              'setup' …`), so a second check here would be a copy of a rule
              that is already enforced one layer down.
            • The label comes from `streamLinkLabelKey`, which returns null for
              a void fixture — that is why this renders on the KEY and not on
              `stream_url` alone (§3.9: nothing for cancelled/abandoned/
              forfeited, whatever the organiser saved). */}
        {/* YouTube Connect T16 — which of the two the page shows is `replayPlan`'s call (replay-plan.ts, swept over every status):
            the YouTube replay parts become the player inside the court card below, and this pill stays for the club's own link
            only - never a second link to a video the player already carries. With no parts it is exactly what it always was. */}
        {(() => {
          const labelKey = streamLinkLabelKey(fixture.status);
          return fixture.stream_url && labelKey && plan.showOwnLink ? (
            <p className="mb-4">
              <a
                data-testid="public-stream-link"
                href={fixture.stream_url}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink shadow-sm transition hover:opacity-90"
              >
                {t(dict, labelKey)}
              </a>
            </p>
          ) : null;
        })()}

        {/* T16 — the online board, watched here (D3: one venue, no Lichess link). The server's doc paints
            first; the island keeps it live (its poll, and the moves pushed through the match centre's channel). */}
        {onlineBoard && showWatchPanel(fixture.status, watchDoc) ? (
          <WatchPanel
            fixtureId={fixture.id}
            initial={watchDoc}
            names={{ home, away }}
            details={{ scheduledAt: fixture.scheduled_at ?? null, clock: watchClockOf(division.config), timeZone: data.venueTz }}
            pairedWhiteSide={data.pairedWhiteSide}
          />
        ) : null}

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
          replay={plan.parts.length > 0 ? <ReplayEmbed parts={plan.parts} /> : undefined}
        />
      </div>
    </DictProvider>
  );
}
