export const dynamic = "force-dynamic";
// Drag-and-drop schedule board for one division (doc 12 §2, PROMPT-17).
// Community used to render it view-only; V353 (#382) opened `scheduling.board`
// and `scheduling.constraints` to every plan, so the gates below no longer fire
// on any tier. They stay: an override or a future tier still moves through them.
import Link from "@/components/ui/console-link";
import { venueLabel } from "@/lib/venue";
import { resolveVenueTz } from "@/lib/tz";
import { requireDivisionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages } from "@/server/usecases/stages";
import { listDivisionFixturesForBoard } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
// P9 scope item 5: org venues+courts feed the court multi-picker (both the
// board's inline settings card and the standalone settings tab) plus
// MovePanel's court-id -> name lookup — see ScheduleBoard's own
// `courtNamesById` comment.
import { listVenues } from "@/server/usecases/venues";
import { hasFeature, orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { preferredCurrency } from "@/lib/currency-server";
import { withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/v2/schedule-board";
import { RungConfigProvider } from "@/components/v2/board/rung-config-provider";
import { resolveRungConfig } from "@/lib/ai-rung";
import {
  StandaloneScheduleSettings,
  StandaloneCourtsSettings,
  CourtsTabLabel,
} from "@/components/v2/board/settings-panel";
import { HealthPanel } from "@/components/v2/board/health-panel";
import { OfficialsPanel } from "@/components/v2/officials-panel";
import { HistoryPanel } from "@/components/v2/history-panel";
import { ConstraintsPanel } from "@/components/v2/constraints-panel";
import {
  listOfficialsForConsole,
  listOfficialBlackouts,
  listOfficialBusyElsewhere,
  type OfficialConsoleRow,
  type OfficialBlackoutRow,
  type OfficialBusyRow,
} from "@/server/usecases/officials";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { UpgradeGate } from "@/components/upgrade-gate";
import { HealthTabLabel } from "@/components/v2/board/health-panel";
import { resolveLocale } from "@/lib/resolve-locale";
import { msgFor } from "@/lib/messages-i18n";
import { DEFAULT_LOCALE } from "@/lib/i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
// P6 fix round 2: resolveLocale() now falls back safely (resolve-locale.ts)
// when there is no real Next.js request — the direct-invocation shape this
// repo's own tests use for a server-component "page" function (see
// officials-loads-deferred.test.tsx's `renderTab` helper, no jsdom). Only
// AWAITED on the officials tab (matches wantsOfficials/marksEnabled just
// below — same "don't pay for it on tabs that never show it" discipline
// #230 item 4 established, and the one this file's own deferred-load test
// guards).

const TABS = ["board", "health", "settings", "courts", "constraints", "officials", "history"] as const;
type Tab = (typeof TABS)[number];

/** The "didn't load it" arm of a gated `Promise.all` slot. Explicitly typed
 *  because a bare `Promise.resolve([])` infers `never[]`, and the resulting
 *  `T[] | never[]` union has no callable `.map` at the use sites below. */
const notLoaded = <T,>(): Promise<T[]> => Promise.resolve([]);

export default async function DivisionSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ orgSlug, compSlug, divSlug }, { tab: rawTab }] = await Promise.all([
    params,
    searchParams,
  ]);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "board";
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug, { tail: "/schedule" });
  const { auth, canEdit } = page;
  // The GOVERNING venue clock (#448), resolved exactly as `loadSettings` does
  // it server-side — `resolveVenueTz(null, org.timezone)`, org → UTC, with the
  // division's own `tz` deliberately excluded so a display override cannot
  // change what a typed time MEANS. Every absolute date/time control below
  // reads and writes on it. It is NOT `settings.tz`, which is the display lane.
  //
  // Taken from the membership already loaded for this page rather than from the
  // settings payload: `ScheduleSettingsWire` intentionally omits `orgTz`, and
  // widening the wire to carry it would be a public API change for a value the
  // page can resolve locally from the same source of truth.
  const orgTz = resolveVenueTz(null, page.org.timezone);
  const id = page.division.id;
  const division = await getDivision(auth, id);
  // #230 item 4: officials data is read by the Officials tab, and nothing else
  // reads the roster or the busy table at all — so Board, Settings, Constraints
  // and History used to pay for the whole org roster plus a cross-organisation
  // query on every navigation. `listOfficialBusyElsewhere` is the one worth
  // gating: it runs on the bare superuser connection by design (officials.ts —
  // the read straddles two orgs, which `withTenant` cannot express), so the
  // fewer tabs that trigger it, the fewer times that read runs at all.
  // `officialsMeta` below was already gated this way.
  //
  // Blackouts are the exception: the board's AI preflight line ("N with
  // blackout dates", ai-preflight.tsx) is fed by ScheduleBoard's
  // `officialsWithBlackout`, which is this list de-duplicated. Deferring it off
  // the board would silently show 0 there, so it loads on board too.
  const wantsOfficials = tab === "officials";
  const wantsBlackouts = tab === "officials" || tab === "board";
  const [
    competition,
    stages,
    fixtures,
    entrants,
    settings,
    boardEditable,
    constraints,
    aiAllowed,
    officials,
    blackouts,
    busy,
    currency,
    venues,
    planKey,
  ] = await Promise.all([
    getCompetition(auth, division.competition_id),
    listStages(auth, id),
    // F1 follow-up (payload budget "gap 15"): the board's own projection —
    // no ext_key/is_final, and lane/third_place/conditional only where set
    // (they drive the knockout round codes; see the function's comment).
    listDivisionFixturesForBoard(auth, id),
    listEntrants(auth, id),
    getScheduleSettings(auth, id),
    hasFeature(auth.orgId, "scheduling.board"),
    hasFeature(auth.orgId, "scheduling.constraints"),
    hasFeature(auth.orgId, "scheduling.ai"),
    wantsOfficials ? listOfficialsForConsole(auth) : notLoaded<OfficialConsoleRow>(),
    wantsBlackouts ? listOfficialBlackouts(auth) : notLoaded<OfficialBlackoutRow>(),
    wantsOfficials ? listOfficialBusyElsewhere(auth) : notLoaded<OfficialBusyRow>(),
    preferredCurrency(auth.orgId),
    // Unconditional like `settings`/`stages` above (board AND settings tabs
    // both need it; not worth a per-tab gate for one cheap query set).
    // P9: archived INCLUDED deliberately — this list serves two jobs. The
    // picker filters archived out itself (twice), so selection is unaffected;
    // but a fixture placed before its court was archived still needs that
    // court's NAME to render, and without it the board showed a bare uuid.
    listVenues(auth, { includeArchived: true }),
    orgPlanKey(auth.orgId),
  ]);
  const viewerPlan = viewerPlanFrom(planKey);

  // P9: the board gets court IDENTITY and display only. `listVenues` rows
  // carry every court's weekly `hours` and dated `exceptions` — the Directory
  // calendar editor's data, and P10's lattice input — which the board never
  // reads and which put this page's five-division RSC payload 33KB over its
  // budget (board-v3.spec.ts:287). Dropping them here is the fix; the board's
  // `Venue`/`Court` types no longer declare them, so nothing downstream can
  // quietly start depending on a calendar that is not sent.
  const boardVenues = venues.map((v) => ({
    ...v,
    courts: v.courts.map(({ hours: _hours, exceptions: _exceptions, ...court }) => court),
  }));

  // Feed wiring for TBD card labels ("Winner of R1·2" — doc 12 §2).
  // `stage_id` lets feedLabels() mark a CROSS-stage edge with its source
  // stage, so the board's round codes resolve a feeder in the right stage.
  const feedRows = await withTenant(auth.orgId, (tx) =>
    tx<FeedRow[]>`
      select id, stage_id, round_no, seq_in_round, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${id}`,
  );

  // SPEC-3 marks & reports for the Officials tab: the fixture_officials
  // surrogate ids (the cache jsonb doesn't carry them), existing marks (Pro
  // only), and submitted reports. Loaded only on the officials tab.
  const marksEnabled = tab === "officials" && (await hasFeature(auth.orgId, "officials.marks"));
  // Fixture-picker labels below (finding #2, fix round 2) — the signed-in
  // organiser's own locale (cookie -> users.locale -> header -> en), NOT
  // org.default_locale: that fallback is documented as "for public league
  // pages only" (resolve-locale.ts), and this page is org-authed.
  const officialsLocale = tab === "officials" ? await resolveLocale() : DEFAULT_LOCALE;
  const officialsMeta =
    tab === "officials"
      ? await withTenant(auth.orgId, async (tx) => {
          const ids = await tx<
            { id: string; fixture_id: string; official_id: string; role_key: string }[]
          >`
            select fo.id, fo.fixture_id, fo.official_id, fo.role_key
            from fixture_officials fo join fixtures f on f.id = fo.fixture_id
            where f.division_id = ${id}`;
          const marks = marksEnabled
            ? await tx<{ fixture_official_id: string; mark: number }[]>`
                select om.fixture_official_id, om.mark from official_marks om
                join fixtures f on f.id = om.fixture_id where f.division_id = ${id}`
            : [];
          const reports = await tx<
            {
              fixture_id: string;
              id: string;
              fixture_official_id: string;
              body: string;
              incidents: unknown;
              submitted_at: Date | null;
              official_name: string;
            }[]
          >`
            select mr.fixture_id, mr.id, mr.fixture_official_id, mr.body, mr.incidents,
                   mr.submitted_at, o.display_name as official_name
            from match_reports mr join officials o on o.id = mr.official_id
            join fixtures f on f.id = mr.fixture_id
            where f.division_id = ${id} and mr.status = 'submitted'`;
          return { ids, marks, reports };
        })
      : null;
  const foIdByAssignment = Object.fromEntries(
    (officialsMeta?.ids ?? []).map((r) => [`${r.fixture_id}:${r.official_id}:${r.role_key}`, r.id]),
  );
  const marksByFoId = Object.fromEntries(
    (officialsMeta?.marks ?? []).map((r) => [r.fixture_official_id, r.mark]),
  );
  const reportsByFixture: Record<
    string,
    {
      id: string;
      fixtureOfficialId: string;
      status: "submitted";
      body: string;
      incidents: { kind: "red_card" | "misconduct" | "injury" | "other"; person_id?: string; entrant_id?: string; note: string }[];
      submittedAt: string | null;
      officialName: string;
    }[]
  > = {};
  for (const r of officialsMeta?.reports ?? []) {
    (reportsByFixture[r.fixture_id] ??= []).push({
      id: r.id,
      fixtureOfficialId: r.fixture_official_id,
      status: "submitted",
      body: r.body,
      incidents: (r.incidents ?? []) as never,
      submittedAt: r.submitted_at ? r.submitted_at.toISOString() : null,
      officialName: r.official_name,
    });
  }

  // `billingFrozen`, never `frozen`: this repo has THREE unrelated freezes and
  // two of them meet on this page. This one is the org's BILLING freeze
  // (`assertCompetitionNotFrozen`, competitions.ts:320) — an over-quota org is
  // read-only. It is NOT `divisions.schedule_locked`, the schedule freeze that
  // stops a board being edited, which is passed separately as `scheduleLocked`.
  // Gating a schedule control on this one silently never fires.
  const billingFrozen = competition.frozen ?? false;
  const editable = canEdit && !billingFrozen && boardEditable;

  return (
    <>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4">
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="page-title">
              Schedule — {division.name}
            </h1>
            {/* Exports used to sit here as five loose buttons, duplicating a
                Documents menu that already existed on the fixtures view. One
                home now: the menu (documents-menu.tsx), which gained Rosters,
                Standings and Participants in the move. The paywall goes with
                them — with nothing left to gate, an "upgrade for exports"
                prompt on this page pointed at a feature that isn't here. */}
          </div>
        </div>

        {/* Tabs (Jul3): the board + each panel is its own view — the page was
            one long scroll otherwise. */}
        <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
          {TABS.map((tabId) => (
            <Link
              key={tabId}
              href={`${routes.divisionSchedule(orgSlug, compSlug, divSlug)}?tab=${tabId}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition ${
                tab === tabId
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {tabId === "health" ? <HealthTabLabel /> : tabId === "courts" ? <CourtsTabLabel /> : tabId}
            </Link>
          ))}
        </nav>

        {tab === "board" && (
          <>
            {!boardEditable && canEdit && !billingFrozen && (
              <div className="mb-4">
                <UpgradeGate feature="scheduling.board" compact viewerPlan={viewerPlan} />
              </div>
            )}
            {/* #385: the AI rung weights and token budgets, resolved HERE —
                this is a server component, and `resolveRungConfig` reads
                AI_RUNG_* through a computed `process.env` key that Next never
                substitutes into a client bundle. Without this the confirm card
                prices on the built-in defaults while the server charges on the
                overrides. */}
            <RungConfigProvider value={resolveRungConfig()}>
            <ScheduleBoard
              divisions={[{ id: division.id, name: division.name, slug: division.slug, status: division.status, seq: Number(division.seq), schedule_locked: division.schedule_locked }]}
              stages={stages.map((s) => ({ id: s.id, division_id: id, seq: s.seq, kind: s.kind, name: s.name, status: s.status }))}
              fixtures={fixtures}
              entrantNames={Object.fromEntries(entrants.map((e) => [e.id, e.display_name]))}
              // What an AI run is PRICED on — the same filter the server
              // applies when it sizes the pack (schedule-ai.ts:505).
              activeEntrantCounts={{
                [id]: entrants.filter(
                  (e) => e.status !== "withdrawn" && e.status !== "disqualified",
                ).length,
              }}
              feedLabels={feedLabels(feedRows)}
              settings={{ division_id: id, config: settings.config, tz: settings.tz, orgTz }}
              canEdit={editable}
              constraintsAllowed={constraints}
              canManage={canEdit && !billingFrozen}
              aiAllowed={aiAllowed}
              currency={currency}
              competitionStart={competition.starts_on}
              competitionEnd={competition.ends_on}
              venueCap={venueLabel(division.sport_key)}
              venues={boardVenues}
              showSettings={false}
              officialsWithBlackout={new Set(blackouts.map((b) => b.official_id)).size}
              viewerPlan={viewerPlan}
            />
            </RungConfigProvider>
          </>
        )}

        {/* D3 schedule health (design doc bench-product-value/designs/
            2026-08-13-schedule-health-design.md) — one panel per stage: the
            route is stage-scoped (round-robin vs bracket gates one of its
            five metrics), but this page is division-scoped and a division
            may hold several stages, so there is no single "the" stage to
            pick. Report-only — renders even for a stage with no schedule
            yet (the panel's own empty state), never blocks anything. */}
        {tab === "health" && (
          <div className="space-y-4">
            {stages.map((s) => (
              <HealthPanel key={s.id} stageId={s.id} stageLabel={s.name} />
            ))}
          </div>
        )}

        {tab === "officials" && (
        <OfficialsPanel
          divisionId={id}
          officials={officials.map((o) => ({
            id: o.id,
            display_name: o.display_name,
            role_keys: o.role_keys,
            entrant_id: o.entrant_id,
            max_per_day: o.max_per_day,
            email: o.email,
            claimed: o.claimed,
            invite_pending: o.invite_pending,
          }))}
          fixtures={fixtures.map((f) => {
            const names = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
            const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
              msgFor(officialsLocale, k, v);
            const home = f.home_entrant_id
              ? (names[f.home_entrant_id] ?? lookup("schedule.tbd"))
              : resolveSlotLabel(f.home_slot_label, lookup, "schedule.tbd");
            const away = f.away_entrant_id
              ? (names[f.away_entrant_id] ?? lookup("schedule.tbd"))
              : resolveSlotLabel(f.away_slot_label, lookup, "schedule.tbd");
            return {
              id: f.id,
              label: `${home} vs ${away}`,
              scheduled_at: f.scheduled_at,
              status: f.status,
              officials: (f.officials ?? []) as {
                official_id: string; name: string; role: string; locked: boolean;
                response?: string; decline_reason?: string | null;
              }[],
            };
          })}
          stages={stages.map((s) => ({ id: s.id, name: s.name, seq: s.seq }))}
          hideNames={division.officials_hide_names}
          canEdit={canEdit && !billingFrozen}
          blackouts={blackouts}
          busyElsewhere={busy}
          venueTz={settings.tz}
          marksEnabled={marksEnabled}
          foIdByAssignment={foIdByAssignment}
          marksByFoId={marksByFoId}
          reportsByFixture={reportsByFixture}
          viewerPlan={viewerPlan}
        />
        )}

        {/* Core scheduling settings on their own tab (organiser ask) —
            moved off the board where they crowded the grid. */}
        {tab === "settings" && (
          <StandaloneScheduleSettings
            divisionId={id}
            config={settings.config}
            canEdit={editable}
            constraintsAllowed={constraints}
            venueCap={venueLabel(division.sport_key)}
            venues={boardVenues}
            orgTz={orgTz}
            // The competition's own dates — already in scope for the board's
            // day range above. The panel's date pickers carry them as
            // min/max, matching the server's containment 422.
            competitionWindow={{ startsOn: competition.starts_on, endsOn: competition.ends_on }}
            // D2 capacity pre-check card: `fixtures` is already fetched
            // unconditionally above (every tab, not gated like the
            // officials-only reads) — no new query for this.
            fixtures={fixtures}
            viewerPlan={viewerPlan}
          />
        )}

        {/* Court selection on its own tab (organiser ask) — pulled off the
            Settings tab where it sat beside hours/match-length; picking which
            courts the auto-scheduler may fill is a different decision from
            those, and burying it inside that card was the complaint. */}
        {tab === "courts" && (
          <StandaloneCourtsSettings
            divisionId={id}
            config={settings.config}
            canEdit={editable}
            venueCap={venueLabel(division.sport_key)}
            venues={boardVenues}
          />
        )}

        {tab === "constraints" && (
        <ConstraintsPanel
          divisionId={id}
          initialSettings={{
            division_id: id,
            config: settings.config as Record<string, unknown>,
          }}
          canEdit={canEdit && !billingFrozen && constraints}
          orgTz={orgTz}
          // P9 review wave 3, finding #12: same `boardVenues` the board and
          // settings tabs already get above — resolves the blackout scope
          // picker's court ids to names instead of the uuids it showed before.
          venues={boardVenues}
          viewerPlan={viewerPlan}
        />
        )}

        {tab === "history" && (
        <HistoryPanel
          divisionId={id}
          scheduleLocked={division.schedule_locked}
          canEdit={canEdit && !billingFrozen}
          viewerPlan={viewerPlan}
        />
        )}
      </main>
    </>
  );
}
