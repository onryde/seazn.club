export const dynamic = "force-dynamic";
// Division console (PROMPT-15 task 1): entrants & rosters, fixture console
// (per stage: generate/complete/schedule), standings with the cascade trace.
import Link from "@/components/ui/console-link";
import { Globe, MonitorPlay, Printer, UserPlus } from "lucide-react";
import { StatusChip, divisionChipState } from "@/components/ui/status-chip";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { requireDivisionPage } from "@/server/page-auth";
import { getDivision, listVariantOptions } from "@/server/usecases/divisions";
import { divisionConsumesSlotOnArchive } from "@/server/usecases/division-slots";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages, getStandings, getSeedProposal, getStageRosterDrift } from "@/server/usecases/stages";
import { listStageQualificationMeta, type StageQualMetaRow } from "@/server/usecases/stage-qualification";
import { divisionQualification } from "@/server/public-site/division-qualification";
import { formatLockedStageIds } from "@/server/usecases/stage-rules";
import { STAGE_RULES_SPORTS } from "@/lib/match-rules";
// From the DB-free module, not through the server-only usecase above: this
// page's tests mock `@/server/usecases/stages` wholesale, and a mocked
// predicate is a second copy of the rule (F3 ultrareview finding 9 was a
// second copy of this exact rule).
import { isRosterDriftEligible } from "@/lib/roster-drift-eligibility";
import { listDivisionFixtures, listFixtureHeadlines } from "@/server/usecases/fixtures";
import { BracketPanel } from "@/components/v2/bracket-panel";
import { listEntrants, DEPARTED_STATUSES } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
// P9 pass 4d, item 1: StagesPanel's per-fixture court editor needs the org's
// real courts (id/name/venue) to build its picker and to venue-qualify a
// name two courts share — same `listVenues(auth)` call `d/new/page.tsx`
// already makes for CourtMultiPicker (default includeArchived: false; the
// picker excludes archived courts either way via `courtGroups`).
import { listVenues } from "@/server/usecases/venues";
import { resolveVenueTz } from "@/lib/tz";
import { fixtureAwaitsSeedDraw, resolvePhase, type DivisionStatus } from "@/lib/division-phase";
import { defaultMatchMinutes } from "@/server/usecases/competition-desk";
import { comparePools } from "@/lib/pool-order";
import { hasFeature, orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { listEntrantLogoUrls } from "@/server/usecases/teams";
import { resolveModule } from "@/server/engine-db";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import type { ProgressionSpec } from "@seazn/engine/competition";
import { seedingSourceReady } from "@/lib/seeding-source-ready";
import { withTenant } from "@/lib/db";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import { EmbedSnippet } from "@/components/v2/embed-snippet";
import { DivisionSettings } from "@/components/v2/division-settings";
import type { StageDraft } from "@/components/v2/format-templates";
import { formatLocked } from "@/lib/format-lock";
import { resolveLogoUrl } from "@/server/public-site/data";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { entrantListLocked } from "@/lib/open-entry-stages";
import { StagesPanel } from "@/components/v2/stages-panel";
import { ProgressionPanel } from "@/components/v2/progression-panel";
import { LaunchActions } from "@/components/v2/launch-actions";
import { StandingsTable } from "@/components/public-site/standings-table";
import { ResultsMatrix } from "@/components/public-site/results-matrix";
import { StatsPanel } from "@/components/v2/stats-panel";
import { LadderPanel } from "@/components/v2/ladder-panel";
import { AmericanoPanel } from "@/components/v2/americano-panel";
import { UpgradeGate } from "@/components/upgrade-gate";
import { RulesEditor } from "@/components/discipline/rules-editor";
import { DisciplinePanel } from "@/components/discipline/discipline-panel";
import {
  activeSuspensionsByEntrant,
  divisionSquad,
  getDisciplineRules,
  listSuspensions,
} from "@/server/usecases/discipline";
import { PaymentRequiredError } from "@/lib/errors";
import type { StandingsRow } from "@seazn/engine/competition";
import type { MetricSpecLike } from "@/lib/public-site";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";

const TABS = ["entrants", "fixtures", "standings", "stats"] as const;
// v8: editors get a Settings tab (general/format/sharing/danger).
// SPEC-1: card-sport divisions also get a Discipline tab (rules + queue).
const EDIT_TABS = [...TABS, "discipline", "settings"] as const;
type Tab = (typeof EDIT_TABS)[number];
const TABLE_KINDS = new Set(["league", "group", "swiss"]);

export default async function DivisionPage({
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
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug);
  const { auth, canEdit } = page;
  const id = page.division.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const division = await getDivision(auth, id);
  // Landing tab follows the division's life: while you're building the field
  // it's entrants; once the tournament starts, match day lives on fixtures.
  const defaultTab: Tab =
    division.status === "active" || division.status === "completed" ? "fixtures" : "entrants";
  const requested: Tab | null = (EDIT_TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : null;
  // SPEC-1: is discipline offered here? getDisciplineRules returns null when the
  // sport has no card model (tab hidden), throws 402 when the sport HAS a model
  // but the org isn't entitled (tab shown with the PlusReveal), or a doc when
  // entitled. Editors only — the config surface lives with the organiser.
  let disciplineRules: Awaited<ReturnType<typeof getDisciplineRules>> = null;
  let disciplineAvailable = false;
  let disciplineGated = false;
  if (canEdit) {
    try {
      disciplineRules = await getDisciplineRules(auth, id);
      disciplineAvailable = disciplineRules !== null;
    } catch (err) {
      if (err instanceof PaymentRequiredError) {
        disciplineAvailable = true;
        disciplineGated = true;
      } else throw err;
    }
  }
  const disciplineEntitled = disciplineAvailable && !disciplineGated;
  const tab: Tab =
    (requested === "settings" && !canEdit) || (requested === "discipline" && !disciplineAvailable)
      ? defaultTab
      : (requested ?? defaultTab);
  const [competition, stages, fixtures, entrants, scheduleSettings, canExport, venues, planKey] =
    await Promise.all([
    getCompetition(auth, division.competition_id),
    listStages(auth, id),
    listDivisionFixtures(auth, id),
    listEntrants(auth, id),
    getScheduleSettings(auth, id),
    hasFeature(auth.orgId, "exports"),
    // Archived-INCLUSIVE, matching the schedule page. `StagesPanel` builds its
    // court names through `resolveCourtNames`, whose whole contract is that an
    // archived court still RESOLVES to a name (a fixture placed before its
    // court was archived must not render a bare uuid), and `FixtureLine`'s
    // `courtById` is documented archived-inclusive too. Without the flag a
    // name colliding only with an archived sibling rendered unqualified here
    // and venue-qualified on the board — the same court, two labels.
    listVenues(auth, { includeArchived: true }),
    orgPlanKey(auth.orgId),
  ]);
  const viewerPlan = viewerPlanFrom(planKey);
  // How long a match is assumed to last on THIS division — resolved once,
  // here, and used twice: by `resolvePhase`'s fixture shape below and by the
  // run sheet's "Needs result" filter (`StagesPanel`'s `matchMinutes` prop).
  // The panel cannot resolve it itself — its own schedule-settings fetch runs
  // only `if (canEdit)`, so a viewer would never have it, and `ScheduleConfig`
  // lives under `@/server` where a client component cannot import it.
  const matchMinutes = scheduleSettings.config.matchMinutes ?? defaultMatchMinutes();
  // Competition Desk (2026-09-02, task 6): the division's derived phase
  // (`resolvePhase`, division-phase.ts) — this page needs only the phase
  // itself (gates the StagesPanel start-locks tip); ATTENTION is the
  // competition page's job, so eventCount/awaitingRegistrations are stubbed
  // at 0 rather than fetched here.
  const phase = resolvePhase({
    divisionStatus: division.status as DivisionStatus,
    // K3 (fix round G) / M1 (fix round I): the "does this stage owe a draw"
    // predicate used to be a HAND-COPIED twin of competition-desk.ts's own
    // expression — written out in two files, drifting independently, and
    // untested at every layer (mutating either copy to a constant left
    // 137/137 green). This page now ships only the raw FACTS and the
    // predicate lives once, in division-phase.ts's `stageOwesDraw`, pinned
    // against a real database in competition-desk.test.ts. `hasFixtures` is
    // computed once here too — it was evaluated twice per stage.
    stages: stages.map((s) => {
      const hasFixtures = fixtures.some((f) => f.stage_id === s.id);
      const timing = (s.progression as { timing?: string } | null)?.timing ?? null;
      return {
        id: s.id,
        name: s.name,
        seq: s.seq,
        status: s.status,
        hasFixtures,
        timing,
        // M1 (fix round I, Critical — instance TWELVE). `stageOwesDraw` now
        // asks the panel's OWN visibility gate, so this page has to answer
        // it too or the two authorities disagree about one division: the
        // desk would read `setting_up` (a bracket generated and never drawn)
        // where this page read `scheduled`, and the start-locks tip is gated
        // on exactly that word. It is the same `seedingSourceReady` this
        // file already imports for the ProgressionPanel below, over the same
        // in-memory `stages` — no extra query, no second expression.
        sourceReady:
          timing === "setup" && s.progression !== null
            ? seedingSourceReady(stages, s, s.progression as unknown as Pick<ProgressionSpec, "sources">)
            : false,
        // Unread by `resolvePhase` — it feeds only the `needs_draw` row's
        // action LABEL, and ATTENTION is the competition page's job (see the
        // `eventCount`/`hasScorer` stubs below for the same reason). Pinned:
        // division-phase.test.ts's "resolvePhase never reads `proposal`"
        // mutates all four states and gets the same phase, so this constant
        // cannot silently become load-bearing.
        proposal: "none" as const,
      };
    }),
    fixtures: fixtures.map((f) => ({
      id: f.id,
      status: f.status,
      scheduledAt: f.scheduled_at,
      // Same stub reasoning as `eventCount`/`hasScorer` below: this page reads
      // the PHASE, and the kick-off clock exists only for the competition
      // page's live-recording attentions. A stub here cannot silently become
      // load-bearing — `resolvePhase` never reads it.
      startedAt: null,
      stageId: f.stage_id,
      // M1: the draw fact, read off the fixture's own entrants, slot labels
      // and outcome — through the SAME shared derivation the desk uses, so
      // the two authorities cannot drift. It was a bare "either entrant is
      // null" in both files, which is also true of every round after the
      // first of a fully drawn bracket.
      awaitsSeedDraw: fixtureAwaitsSeedDraw(f),
      eventCount: 0,
      // Final review minor fix: was a bare `?? 60`, retyping a number that
      // had already drifted from the desk's own schema-derived default (30).
      // `resolvePhase` never reads `matchMinutes` (only `resolveAttention`
      // does, and this page only calls the former — see the comment above),
      // so this is inert HERE either way; the same resolved value is what the
      // run sheet's "Needs result" filter counts on, which is not inert at
      // all, and sharing the one derivation keeps this page from silently
      // disagreeing with competition-desk.ts.
      matchMinutes,
      // Same reason as `eventCount` above: unread by `resolvePhase`, stubbed
      // rather than fetched (a fixture_officials lookup belongs to the
      // competition desk's ATTENTION computation, not this page's phase-only
      // one).
      hasScorer: false,
    })),
    now: new Date().toISOString(),
    // H1 fix (final review round 3, Critical — corrected ruling): this used
    // to be the bare org zone (`resolveVenueTz(null, page.org.timezone)`) —
    // the same bucket-vs-print split competition-desk.ts had, one level up.
    // `scheduleSettings.tz` IS the resolved venue zone for THIS division
    // (`ScheduleSettingsWire.tz` = `loadSettings`'s `displayTz`: the
    // division's own schedule_settings.tz override, falling back to the
    // org's timezone only when the division has none) — the same single
    // value this page already passes to `StagesPanel`'s `tz` prop below.
    tz: scheduleSettings.tz,
    awaitingRegistrations: 0,
  });
  // Review wave 3: the panel gets court IDENTITY and display only — same trim
  // the schedule page does, and for the same reason. `listVenues` rows carry
  // every court's weekly `hours` and dated `exceptions` (the Directory calendar
  // editor's data), which StagesPanel never reads and which the schedule page
  // measured at 33KB over its RSC payload budget. Neither page has a budget
  // test, so this would have grown silently.
  const panelVenues = venues.map((v) => ({
    ...v,
    courts: v.courts.map(({ hours: _hours, exceptions: _exceptions, ...court }) => court),
  }));
  // Moved up from just before the JSX return (still THE canonical
  // frozen/editable derivation, unchanged) — the P6/D4b task B proposal
  // panel below needs it to gate getSeedProposal, which must not fetch (let
  // alone render mutating controls) for a viewer or a frozen competition.
  // `billingFrozen`, never `frozen`: this repo has THREE unrelated freezes and
  // two of them meet on this page. This one is the org's BILLING freeze
  // (`assertCompetitionNotFrozen`, competitions.ts:320) — an over-quota org is
  // read-only. It is NOT `divisions.schedule_locked`, the schedule freeze that
  // stops a board being edited, which is passed separately as `scheduleLocked`.
  // Gating a schedule control on this one silently never fires.
  const billingFrozen = competition.frozen ?? false;
  const editable = canEdit && !billingFrozen;
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // Effective entrant model (sport default ← config.entrants override) — shared
  // by the entrants panel (add form + roster editor) and the Settings tab.
  const entrantModel = effectiveEntrantModel(sportModule.entrantModel ?? null, division.config);
  // R7 B2 — per-config catalog (see the fixture console page). The roster
  // editor's default-position picker offers this division's groups.
  const lineupCatalog = lineupCatalogFor(sportModule, division.config);
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // Departed entrants keep their row in the table — a withdrawal (or a
  // disqualification) settles the matches they had left and leaves the ones
  // they actually played, so the results stand — but the row has to SAY so.
  // `StandingsRow` carries no status, so the statuses travel beside the rows.
  // Handed over RAW, one status per entrant: which of them counts as departed,
  // and what word it prints, is the TABLE's single decision
  // (`DEPARTED_STATUS_CHIPS`). Filtering to one status here is precisely what
  // left `disqualified` unmarked on all three of these pages at once (C1) —
  // `patchEntrant` accepts it, so a disqualified entrant reached the standings
  // ranked among the competing and styled exactly like them.
  // `listEntrants` already selects `status`, so this costs no extra query.
  const entrantStatuses = Object.fromEntries(entrants.map((e) => [e.id, e.status]));
  // Entrants who have left the field. A withdrawal is a STATUS FLIP, not a
  // delete, so these ids are still in `entrantNames` and in a ladder's
  // persisted order — which is exactly how a <select> came to offer a choice
  // the server 422s on. Derived here, beside the roster read, because the
  // panels below only ever receive id -> NAME and cannot tell the two apart.
  // The pair is NOT spelled here. `standings-withdrawn-wiring` reds on a page
  // that restates it, because a page that names one status will miss the next
  // one added — read it from the server's single source instead.
  const departedEntrantIds = entrants.filter((e) => DEPARTED_STATUSES.has(e.status)).map((e) => e.id);
  // The FIELD — the exact complement of the line above, and the same set the
  // generate path reads as `status in ('registered','confirmed')`. Spelled as
  // a complement rather than by naming the two live statuses for the reason
  // the line above documents: `DEPARTED_STATUSES` is the one place this
  // vocabulary lives, and a page that restates it goes stale the day a fifth
  // status arrives (`departed-entrants-wiring.test.ts` reds on a page that
  // does). That the complement really IS the server's predicate is pinned by
  // `lib/__tests__/swiss-legend.test.ts`, which reds if `EntrantStatus` grows
  // a value that is neither departed nor in the field.
  //
  // Feeds StagesPanel's swiss shape legend and its round-1 pairing menu, and
  // nothing else. Ids, not a count: a swiss stage carrying `config.qualified`
  // pairs only the qualifiers still in the field, which is an intersection.
  const activeEntrantIds = entrants.filter((e) => !DEPARTED_STATUSES.has(e.status)).map((e) => e.id);
  // Swiss round-1 pairing, review ruling R1: the menu's hint prints seed
  // NUMBERS only when the field's seeds really are 1..N in pairing order, so
  // it needs each entrant's seed. `listEntrants` already selects `seed`.
  const entrantSeeds = Object.fromEntries(entrants.map((e) => [e.id, e.seed]));
  const BRACKET_STAGE_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);
  const hasKnockout = stages.some((s) => BRACKET_STAGE_KINDS.has(s.kind));
  // P6/D4b task B — the proposal panel, one per propose/confirm-at-setup
  // stage. F2 (unified progression field): was `s.seeding != null`; the
  // naive rename `s.progression != null` would ALSO catch on_complete
  // (auto-seed) stages, which never go through propose/confirm (Decision
  // 3 — the two DB-level flows stay separate) — timing: "setup" is the
  // real signal, not mere presence. getSeedProposal is read-only (no
  // route: stage_seed_proposals has no GET, see its docstring) and
  // organiser-only, so it's fetched only on the fixtures tab for an
  // editable (canEdit, not frozen) division — same conditional-fetch shape
  // as entrantLogos/headlines just above/below.
  const seedingStages = stages.filter(
    (s) => (s.progression as { timing?: string } | null)?.timing === "setup",
  );
  // Hide the panel entirely (not just show it "empty") until every source
  // stage it draws standings from has actually completed — otherwise the
  // organiser sees a Recompute button whose only possible outcome is a
  // SEEDING_SOURCE_INCOMPLETE 409 (stage-seeding.ts's own gate). The rule
  // itself lives in lib/seeding-source-ready.ts (one definition, pure, no
  // DB) — see its docstring for exactly how it mirrors
  // resolveProgressionSource.
  const seedingSourcesReady = seedingStages.map((s) =>
    seedingSourceReady(
      stages,
      s,
      s.progression as unknown as Pick<ProgressionSpec, "sources">,
    ),
  );
  // F3 Task 5c (ruling 14 — seeding stays propose-and-confirm, no
  // auto-confirm). Fetched on EVERY tab, not just fixtures: ruling 14's whole
  // consequence is that a stage now fills only when the organiser confirms, so
  // a proposal that nobody is told about leaves a published bracket full of
  // placeholders after the results are already in. The organiser is usually on
  // entrants or standings when the group stage finishes, which is exactly when
  // the proposal appears. Cost is one indexed read per setup-timing stage, and
  // there is at most a handful per division.
  const seedProposals =
    editable && seedingStages.length > 0
      ? await Promise.all(seedingStages.map((s) => getSeedProposal(auth, s.id)))
      : [];
  // "draft" = computed, waiting for the organiser to confirm it. "stale" = a
  // source's standings moved underneath it and it needs recomputing. Both are
  // waiting on a human; "confirmed" is done and never nags.
  const pendingSeedProposals = seedProposals.filter(
    (p) => p?.status === "draft" || p?.status === "stale",
  ).length;
  // F3 Task 5 (5a) — the roster-drift banner StagesPanel renders per stage.
  // Only the ROOT stage (no progression source) draws fixtures directly from
  // the live active roster (getStageRosterDrift's own doc comment,
  // usecases/stages.ts) — every other stage either reads a frozen qualified
  // list or is structurally insulated from entrant churn, so there is at
  // most one stage worth asking. Same conditional-fetch shape as
  // seedProposals just above: organiser-only, fixtures-tab-only.
  //
  // F3 ultrareview finding 9 — was `stages.find((s) => s.progression === null)`,
  // which is a LOOSER rule than the one the usecase itself applies: a ladder
  // or americano stage has no progression but is ineligible (it mints its own
  // entrants / has no bulk-generated board), so in a division whose first
  // roster-drawn stage is a ladder, `find` landed on the ladder, the usecase
  // returned an empty drift for it, and the real league stage behind it was
  // never asked. `filter` over the SHARED predicate covers every eligible
  // stage — normally exactly one, so normally the same single query.
  const rosterDriftStages = stages.filter(isRosterDriftEligible);
  const rosterDrift =
    tab === "fixtures" && editable && rosterDriftStages.length > 0
      ? Object.fromEntries(
          await Promise.all(
            rosterDriftStages.map(async (s) => [s.id, await getStageRosterDrift(auth, s.id)] as const),
          ),
        )
      : {};
  // Per-stage match format (design §T5, D7) — which stages the API will refuse
  // a format write on, so the panel's row can decline to OFFER the editor
  // instead of letting the organiser discover the 409 after pressing Save. The
  // panel cannot derive this: `FIXTURE_COLS` does not carry `config_snapshot`
  // (a payload-budget ruling, stages.ts:147-162) and `score_events` reaches no
  // prop, leaving only the non-monotonic `fixtures.status`. Same per-stage
  // shape as `rosterDrift` above, and skipped entirely for a sport with no
  // per-stage rules — the row never renders there, so the page should not pay
  // for the query.
  const formatLockedStages =
    tab === "fixtures" && editable && STAGE_RULES_SPORTS.has(division.sport_key)
      ? await formatLockedStageIds(auth, id)
      : [];
  const stageNames = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  // Badge chips on standings rows (v3/03 §5) — resolved once per render.
  // PROMPT-62: the bracket panel on the fixtures tab shows them too.
  const entrantLogos =
    tab === "standings" || tab === "entrants" || (tab === "fixtures" && hasKnockout)
      ? await listEntrantLogoUrls(auth, id)
      : undefined;
  // PROMPT-62: score headlines for bracket nodes (match_states join).
  const headlines =
    (tab === "fixtures" && hasKnockout) || tab === "standings"
      ? await listFixtureHeadlines(auth, id)
      : undefined;
  const cascade = division.tiebreakers ?? sportModule.defaultTiebreakers;

  // SPEC-1: the Discipline tab's queue + squad, and the entrant-row chips.
  const disciplineData =
    tab === "discipline" && disciplineEntitled
      ? await (async () => {
          const [suspensions, squad] = await Promise.all([
            listSuspensions(auth, id),
            divisionSquad(auth, id),
          ]);
          return { suspensions, squad };
        })()
      : null;
  const entrantSuspensions =
    tab === "entrants" && disciplineEntitled
      ? Object.fromEntries(
          [...(await withTenant(auth.orgId, (tx) => activeSuspensionsByEntrant(tx, id)))].map(
            ([eid, list]) => [
              eid,
              list.map((x) => ({ personName: x.personName, remaining: x.remaining })),
            ],
          ),
        )
      : undefined;

  // Standings per table stage (+ per pool), with pool labels.
  const tableStages = stages.filter((s) => TABLE_KINDS.has(s.kind));
  const standings =
    tab === "standings"
      ? await Promise.all(
          tableStages.map(async (stage) => {
            // Pool A above Pool B: the same helper every public surface uses
            // (`lib/pool-order.ts`), so the console cannot drift from them.
            const pools = [
              ...(await withTenant(auth.orgId, (tx) =>
                tx<{ id: string; key: string; name: string }[]>`
                  select id, key, name from pools where stage_id = ${stage.id}`,
              )),
            ].sort(comparePools);
            const tables =
              pools.length > 0
                ? await Promise.all(
                    pools.map(async (p) => ({
                      caption: `${stage.name} — ${p.name}`,
                      poolId: p.id as string | null,
                      snap: await getStandings(auth, stage.id, p.id),
                    })),
                  )
                : [{ caption: stage.name, poolId: null as string | null, snap: await getStandings(auth, stage.id) }];
            return { stage, tables };
          }),
        )
      : [];
  // The standings table and results grid take their words from the PUBLIC
  // dictionary (the same helpers as the hub's table), in this viewer's
  // locale. Loaded only on the tab that draws them, like `standings` above.
  const publicDict = tab === "standings" ? await getDictionary(locale, "public") : {};
  // Standings qualification status (R1a, spec 2026-09-22 §4.2): the same cut
  // line, markers, legend and popover the public pages draw. The meta comes
  // from V414's `stage_qualification_meta` — the function `public_stages_v`
  // calls — read for the table stages of the tenant-scoped `listStages` above
  // and nothing else; the view is built by the helper the division page, the
  // embed and the hub use. Its words are this VIEWER's, like the rest of the
  // table's (`publicDict`, `locale`), where the ISR public pages use the org's.
  // No meta for any stage → nothing to build.
  const qualMeta =
    tab === "standings"
      ? await listStageQualificationMeta(auth, tableStages.map((s) => s.id))
      : new Map<string, StageQualMetaRow>();
  const qualificationFor =
    qualMeta.size > 0
      ? divisionQualification({
          module_: sportModule,
          division,
          dict: publicDict,
          locale,
          fixtures,
          entrantStatuses,
          entrantNames,
          cascade,
        })
      : null;

  // Stream Overlay W1 (task 6) — the per-PAGE half of every run-sheet row's
  // stream panel, resolved ONCE here rather than per row.
  //
  // Both entitlement reads carry the competition id, the same way `news.auto`
  // and `embeds.enabled` do below and the same way the overlay route's own
  // gate does (`app/overlay/fixtures/[fixtureId]/page.tsx`): an Event Pass
  // grants for the competition it was bought for, so an org-wide resolve would
  // deny a pass holder the fixture they paid for.
  //
  // `overlayDict` travels because it has to: the console layout provides the
  // `ui` namespace, the overlay's own copy is `public.overlay.*`, and
  // `getDictionary` is `server-only` so the client island cannot load it.
  // Sliced to that prefix, so the flight carries ~20 strings and not the whole
  // public catalogue.
  //
  // Everything after the FIRST read is behind `streamEntitled`. Streaming is
  // a dark rollout — `streaming.overlay` is granted by no plan today
  // (`lib/feature-copy.ts`) — so on every division page that currently exists
  // this costs exactly one entitlement query and neither the second read, the
  // `public` dictionary import, nor a byte of it on the RSC flight. Skipped
  // entirely off the fixtures tab and for a viewer who cannot edit: neither
  // can reach a panel at all.
  const streamOffered = tab === "fixtures" && editable;
  const streamEntitled =
    streamOffered && (await hasFeature(auth.orgId, "streaming.overlay", competition.id));
  const streamPanel = streamOffered
    ? {
        entitled: streamEntitled,
        relayEntitled:
          streamEntitled && (await hasFeature(auth.orgId, "streaming.relay", competition.id)),
        sportKey: division.sport_key,
        overlayDict: streamEntitled
          ? (Object.fromEntries(
              Object.entries(await getDictionary(locale, "public")).filter(([k]) =>
                k.startsWith("overlay."),
              ),
            ) as Record<string, string>)
          : {},
        viewerPlan,
      }
    : undefined;

  return (
    <>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6">
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="page-title">
              {division.name}
            </h1>
            <span className="chip">
              {division.sport_key} · {division.variant_key}
            </span>
            <StatusChip state={divisionChipState(division.status)} locale={locale} />
            {billingFrozen && <StatusChip state="frozen" locale={locale} />}
            <div className="flex-1" />
            {/* Icon + label on desktop, icon-only under `sm` (v3/02 pattern 5). */}
            <Link
              href={routes.slideshowDivision(id)}
              target="_blank"
              aria-label={t(dict, "aria.slideshowNewTab")}
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.slideshow")} ↗</span>
            </Link>
            {/* Division-level registration nav link removed (RS001
                demolition); RS004 built the competition-level Registration
                hub as its replacement but deliberately left this page's own
                link into it for later ("the filter lands with the real
                Registrants table" — design §5). RS005 R2 is that later:
                straight into the hub's Registrants tab, this division
                pre-filtered via `division_id` (routes.ts).
                Reuses the competition page's own "Registration" nav
                label/aria (action.registration/aria.registration) and icon
                (UserPlus) — same destination, same concept, one fewer
                dictionary key.
                NOT gated on competition.visibility, unlike View Public/QR
                below: this is an ORGANISER surface behind /o/, not the
                public register link the deleted surface used to gate — a
                private competition still has registrants to manage.
                requireDivisionPage already routes through
                requireCompetitionPage, which 404s a scorer and admits
                everyone else who can reach this page at all, so (matching
                the competition page's RegistrationHubNavEntry comment on
                why IT skips a canEdit gate) no further gate is owed here
                either. */}
            <Link
              href={routes.competitionRegistration(orgSlug, compSlug, "registrants", id)}
              aria-label={t(dict, "aria.registration")}
              className="btn btn-ghost gap-1.5"
            >
              <UserPlus className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.registration")}</span>
            </Link>
            {competition.visibility !== "private" && (
              // G9: straight to this division's public view — which is now the
              // HUB with the division selected, not the standalone division
              // page (owner ruling 2026-09-17; that page is slated for a 308
              // into the hub). Both spellings are the hub's own: "matches" is
              // one of `deriveHubTabs`' ids (`lib/matches-hub.ts`), and
              // `?division=` is what `readDivisionParam` reads and
              // `competition-landing.tsx` seeds into the Matches tab.
              <a
                href={`/shared/${orgSlug}/${competition.slug}?tab=matches&division=${divSlug}`}
                target="_blank"
                aria-label={t(dict, "aria.viewPublic")}
                className="btn btn-ghost gap-1.5"
              >
                <Globe className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.viewPublic")} ↗</span>
              </a>
            )}
            {competition.visibility !== "private" && (
              // v3/10 #3: division-scoped QR poster PDF for the venue wall.
              <a
                href={`/shared/${orgSlug}/${competition.slug}/poster.pdf?division=${divSlug}`}
                target="_blank"
                aria-label={t(dict, "aria.qrPoster")}
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.qr")}</span>
              </a>
            )}
          </div>
          {/* v8: primary actions live on their own row under the title —
              Start / Schedule / Invite wrap cleanly at 390px. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <LaunchActions
              divisionId={id}
              orgSlug={orgSlug}
              compSlug={compSlug}
              divSlug={divSlug}
              status={division.status}
              canEdit={editable}
              // Starting publishes the schedule, so it can be refused on
              // conflicts; these two let the refusal sheet name the matches it
              // is about. Both are already loaded above for the tabs.
              fixtures={fixtures}
              entrantNames={entrantNames}
              // Whether starting really closes the entrant list — open-format
              // stages (ladder/americano) keep it open, so the confirmation
              // must not claim otherwise. Already loaded above.
              stageKinds={stages.map((s) => s.kind)}
              // Whether starting also moves the PARENT competition published
              // → live. `startDivision` guards that on the competition's
              // current status, so the confirmation needs it to know whether
              // the line is true. `competition` is already loaded above and
              // `status` is in its COLS — no extra query.
              competitionStatus={competition.status}
              viewerPlan={viewerPlan}
            />
          </div>
        </div>

        {/* v3/02 §3.3: tabs scroll horizontally with an edge fade — never wrap. */}
        <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
          {(canEdit ? EDIT_TABS.filter((tk) => tk !== "discipline" || disciplineAvailable) : TABS).map(
            (tabKey) => (
              <Link
                key={tabKey}
                href={routes.division(orgSlug, compSlug, divSlug, tabKey)}
                className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === tabKey
                    ? "border-purple-600 text-purple-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {tabKey === "discipline" ? t(dict, "disc.tab") : t(dict, `div.detail.tab.${tabKey}`)}
                {/* F3 Task 5c (ruling 14): a seed proposal is waiting on the
                    organiser. The dot rides INSIDE the tab label so it adds no
                    layout width of its own — this strip is `.scroll-x` and its
                    active tab can already scroll out of view, so anything that
                    widens a tab makes that worse at 320px. Screen readers get
                    the count as words; sighted users get the dot plus the
                    title. */}
                {tabKey === "fixtures" && pendingSeedProposals > 0 && (
                  <span
                    className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-500 align-middle"
                    data-pending-seed-proposals={pendingSeedProposals}
                    title={t(dict, "progression.pendingProposal.hint")}
                  >
                    <span className="sr-only">
                      {t(dict, "progression.pendingProposal.badge")}
                    </span>
                  </span>
                )}
              </Link>
            ),
          )}
        </nav>

        {tab === "entrants" && (
          <EntrantsPanel
            divisionId={id}
            entrants={entrants}
            logoUrls={entrantLogos}
            canEdit={editable}
            positionGroups={lineupCatalog.groups}
            roles={lineupCatalog.roles ?? []}
            // RS007/V380 dropped `divisions.eligibility` (jsonb) — the real
            // first-class columns, so EntrantsPanel's badge reflects every
            // division's actual restriction instead of always reading empty.
            eligibility={{
              category: division.category,
              age_min: division.age_min,
              age_max: division.age_max,
              eligibility_note: division.eligibility_note,
            }}
            entrantModel={entrantModel}
            suspensions={entrantSuspensions}
            rosterLocked={entrantListLocked(division.status, stages.map((s) => s.kind))}
            viewerPlan={viewerPlan}
            divisionStatus={division.status}
          />
        )}

        {tab === "fixtures" && (
          <>
            {/* PROMPT-62: two-sided tree for each knockout stage, above the
                flat list (which keeps scheduling + Documents). Renders nothing
                until the bracket is generated or for non-single-elim shapes. */}
            {stages
              .filter((st) => BRACKET_STAGE_KINDS.has(st.kind))
              .map((st) => (
                <div key={st.id} className="mb-6">
                  <BracketPanel
                    kind={st.kind}
                    fixtures={fixtures.filter((f) => f.stage_id === st.id)}
                    divisionFixtures={fixtures}
                    entrantNames={entrantNames}
                    entrantBadges={entrantLogos}
                    headlines={headlines}
                    orgSlug={orgSlug}
                    compSlug={compSlug}
                    divSlug={divSlug}
                  />
                </div>
              ))}
            {stages
              .filter((st) => st.kind === "americano")
              .map((st) => (
                <AmericanoPanel key={st.id} stageId={st.id} canEdit={editable} viewerPlan={viewerPlan} />
              ))}
            {stages
              .filter((st) => st.kind === "ladder")
              .map((st) => (
                <div key={st.id} className="mb-6">
                  <h2 className="mb-2 text-lg font-semibold text-slate-900">{st.name}</h2>
                  <LadderPanel
                    stageId={st.id}
                    order={(st.config.ladder_order as string[] | undefined) ?? []}
                    entrants={entrantNames}
                    departedEntrantIds={departedEntrantIds}
                    locale={locale}
                    canEdit={editable}
                    viewerPlan={viewerPlan}
                  />
                </div>
              ))}
            {/* P6/D4b task B — one proposal panel per propose/confirm-at-setup
                stage, above StagesPanel: propose/edit/confirm who fills the
                stage's TBD slots before the stage's own timetable card. */}
            {seedingStages.map((st, i) => (
              <ProgressionPanel
                key={st.id}
                stageId={st.id}
                stageName={st.name}
                proposal={seedProposals[i] ?? null}
                sourceReady={seedingSourcesReady[i] ?? false}
                fixtures={fixtures}
                entrantNames={entrantNames}
                stageNames={stageNames}
                departedEntrantIds={departedEntrantIds}
                locale={locale}
                canEdit={editable}
              />
            ))}
            <StagesPanel
              divisionId={id}
              competitionId={competition.id}
              orgSlug={orgSlug}
              compSlug={compSlug}
              divSlug={divSlug}
              stages={stages}
              fixtures={fixtures}
              entrantNames={entrantNames}
              activeEntrantIds={activeEntrantIds}
              entrantSeeds={entrantSeeds}
              venues={panelVenues}
              rosterDrift={rosterDrift}
              canEdit={editable}
              sportKey={division.sport_key}
              divisionConfig={(division.config ?? {}) as Record<string, unknown>}
              formatLockedStageIds={formatLockedStages}
              tz={scheduleSettings.tz}
              // The GOVERNING clock, resolved here exactly as the schedule page
              // resolves it for the board: `ScheduleSettingsWire` serves only
              // the display `tz`, and anchoring the panel's board-slot grid on
              // that would shift every offered time on a division carrying a
              // zone override (#448).
              orgTz={resolveVenueTz(null, page.org.timezone)}
              canExport={canExport}
              phase={phase}
              matchMinutes={matchMinutes}
              viewerPlan={viewerPlan}
              stream={streamPanel}
            />
          </>
        )}

        {tab === "standings" && (
          <div className="space-y-8">
            {standings.length === 0 && (
              <p className="text-sm text-slate-500">
                {t(dict, "div.detail.standings.empty")}
              </p>
            )}
            {standings.map(({ stage, tables }) => (
              <section key={stage.id} className="card p-5">
                {tables.map(({ caption, poolId, snap }) => {
                  const poolFixtures = fixtures
                    .filter(
                      (f) =>
                        f.stage_id === stage.id && (f.pool_id ?? null) === poolId,
                    )
                    .map((f) => ({
                      ...f,
                      summary:
                        headlines?.[f.id] !== undefined
                          ? { headline: headlines[f.id] }
                          : null,
                    }));
                  const ranked = [...(snap.rows as StandingsRow[])].sort(
                    (a, b) => (a.rank ?? 99) - (b.rank ?? 99),
                  );
                  // This table's cut line and statuses (null: no cut, or
                  // anything the builder cannot be sure of — then the table
                  // is as before). The pool is the one this table was read for.
                  const stageMeta = qualMeta.get(stage.id);
                  const qualification =
                    stageMeta && qualificationFor
                      ? qualificationFor(
                          { id: stage.id, kind: stage.kind, ...stageMeta },
                          { pool_id: poolId, rows: snap.rows as StandingsRow[] },
                        )
                      : null;
                  return (
                    <div key={caption} className="mb-6 last:mb-0 space-y-3">
                      <StandingsTable
                        rows={snap.rows as StandingsRow[]}
                        metricSpecs={sportModule.metrics as MetricSpecLike[]}
                        cascade={cascade}
                        entrantNames={entrantNames}
                        entrantLogos={entrantLogos}
                        entrantStatuses={entrantStatuses}
                        caption={caption}
                        dict={publicDict}
                        qualification={qualification}
                      />
                      {poolFixtures.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                            {t(dict, "div.detail.resultsGrid")}
                          </summary>
                          <div className="mt-2">
                            <ResultsMatrix
                              entrantIds={ranked.map((r) => r.entrantId)}
                              entrantNames={entrantNames}
                              entrantLogos={entrantLogos}
                              fixtures={poolFixtures as never}
                              fixtureHref={(fid) => {
                                const row = fixtures.find((f) => f.id === fid);
                                return row
                                  ? routes.fixture(orgSlug, compSlug, divSlug, row.fixture_no)
                                  : "#";
                              }}
                              dict={publicDict}
                            />
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
                {/* Cascade trace (doc 05 §4): the exact tie-break order in force. */}
                <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  {t(dict, "div.detail.tiebreak.label")}{" "}
                  {cascade.map((key, i) => (
                    <span key={key}>
                      {i > 0 && " → "}
                      <span className="text-slate-500">{localizedTieBreakLabel(dict, key)}</span>
                    </span>
                  ))}
                  {" "}
                  {division.tiebreakers
                    ? t(dict, "div.detail.tiebreak.override")
                    : t(dict, "div.detail.tiebreak.default")}
                </p>
              </section>
            ))}
          </div>
        )}

        {tab === "stats" && (
          <StatsPanel
            divisionId={id}
            publicBase={
              competition.visibility !== "private"
                ? `/shared/${orgSlug}/${compSlug}`
                : null
            }
            viewerPlan={viewerPlan}
          />
        )}

        {/* SPEC-1: Discipline tab — rules editor + pending/active/history queue.
            Gated orgs (sport has cards but plan doesn't) see the PlusReveal. */}
        {tab === "discipline" && canEdit && (
          <div className="max-w-3xl space-y-6">
            {disciplineGated ? (
              <UpgradeGate feature="discipline.enforced" viewerPlan={viewerPlan} />
            ) : disciplineRules ? (
              <>
                <RulesEditor
                  divisionId={id}
                  enabled={disciplineRules.enabled}
                  rules={disciplineRules.rules}
                  sportColors={disciplineRules.sportColors}
                  canEdit={editable}
                />
                {disciplineData && (
                  <DisciplinePanel
                    divisionId={id}
                    initial={disciplineData.suspensions}
                    squad={disciplineData.squad}
                    canEdit={editable}
                  />
                )}
              </>
            ) : null}
          </div>
        )}

        {/* v8 spec §2: settings tab collects general/format/sharing/danger —
            the embed snippet and danger zone moved here from the page bottom. */}
        {tab === "settings" && canEdit && (
          <DivisionSettings
            division={{
              id,
              name: division.name,
              sport_key: division.sport_key,
              variant_key: division.variant_key,
              config: division.config,
              // Uploads store the storage path; resolve it so the tile
              // survives remounts (tab switches) — same fix as the card.
              logo_url: resolveLogoUrl(division.logo_storage_path, division.logo_url),
              logo_storage_path: division.logo_storage_path,
              required_court_tags: division.required_court_tags,
            }}
            orgId={auth.orgId}
            variants={await listVariantOptions(auth, division.sport_key)}
            locked={formatLocked([{ fixture_count: fixtures.length }])}
            stages={stages.map((st) => ({
              name: st.name,
              kind: st.kind,
              config: (st.config ?? null) as Record<string, unknown> | null,
              // StageRow.progression is untyped JSONB (Record<string,
              // unknown> | null) — this is the DB-read boundary where that
              // gets asserted into DivisionSettings's stricter shape,
              // mirroring stages.ts's own `as unknown as ProgressionSpec`
              // read-site precedent rather than casting again downstream.
              progression: (st.progression ?? null) as unknown as StageDraft["progression"],
            }))}
            canEdit={editable}
            entrantModel={entrantModel}
            entrantModelSource={
              (() => {
                const e = (division.config as { entrants?: unknown } | null)?.entrants;
                return e && typeof e === "object" ? "override" : "sport";
              })()
            }
            divisionPathPrefix={`/o/${orgSlug}/c/${compSlug}/d/`}
            fixturesHref={routes.division(orgSlug, compSlug, divSlug, "fixtures")}
            autoPosts={division.auto_posts}
            // Both gates below carry the competition id: V396 made `news.auto`
            // and `embeds.enabled` false on Free and left them granted on both
            // Event Pass rungs, so an org-wide resolve would show a pass holder
            // a locked control on the competition they paid for.
            canAutoPost={await hasFeature(auth.orgId, "news.auto", competition.id)}
            showSeeds={division.show_seeds}
            viewerPlan={viewerPlan}
            embed={
              competition.visibility !== "private" ? (
                <EmbedSnippet
                  divisionId={id}
                  entitled={await hasFeature(auth.orgId, "embeds.enabled", competition.id)}
                  viewerPlan={viewerPlan}
                />
              ) : (
                <p className="text-xs text-slate-500">
                  {t(dict, "div.detail.embed.private")}
                </p>
              )
            }
            danger={
              <DivisionDangerZone
                divisionId={id}
                divisionName={division.name}
                orgSlug={orgSlug}
                compSlug={compSlug}
                // Whether archiving keeps this division's quota slot spent
                // (V354). Awaited inline like `canAutoPost` and `embed` above
                // — this whole subtree only renders on the settings tab of an
                // editor's page, so the query is not on the read path anyone
                // else pays for. Answered by the SQL predicate the quota
                // charge uses; the client is told, never asked to derive it.
                slotHeldOnArchive={await divisionConsumesSlotOnArchive(auth, id)}
              />
            }
          />
        )}
      </main>
    </>
  );
}
