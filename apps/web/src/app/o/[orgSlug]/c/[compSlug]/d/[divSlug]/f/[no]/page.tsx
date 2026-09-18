export const dynamic = "force-dynamic";
// Fixture console (PROMPT-15 task 1): schedule, lineups, sport-shaped scoring
// pad, void/undo, finalize. Server shell — all interaction in FixtureConsole.
import Link from "@/components/ui/console-link";
import { notFound } from "next/navigation";
import { requireFixturePage } from "@/server/page-auth";
import {
  eventRecorderNames,
  getFixture,
  getFixtureState,
  getLineup,
  listEvents,
  loadFixturePadCfg,
} from "@/server/usecases/fixtures";
import { getDivision } from "@/server/usecases/divisions";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { getCompetition } from "@/server/usecases/competitions";
import { getEntrant } from "@/server/usecases/entrants";
import { resolveModule } from "@/server/engine-db";
import {
  FixtureConsole,
  type SideInfo,
  type LineupSlotIn,
} from "@/components/v2/fixture-console";
import { listFixtureAvailability } from "@/server/usecases/me";
import { CheckinQr } from "@/components/v2/checkin-qr";
import { FixtureOfficialsStrip } from "@/components/v2/fixture-officials-strip";
import { hasFeature, orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { suspensionsForFixture } from "@/server/usecases/discipline";
import { sql } from "@/lib/db";
// S13/#422 W11 — the v2 scoring pad, resolved server-side unconditionally
// (S12/#421's flag has been removed entirely — see resolveScorePadBootstrap's
// own doc for what a resolution failure does instead of gating on a flag).
import { resolveScorePadBootstrap } from "@/server/usecases/fidelity";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { eventOutToEnvelope } from "@/components/v2/scorepad/wire";

export default async function FixturePage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string; no: string }>;
}) {
  const { orgSlug, compSlug, divSlug, no } = await params;
  const fixtureNo = Number(no);
  if (!Number.isInteger(fixtureNo) || fixtureNo < 1) notFound();
  const page = await requireFixturePage(orgSlug, compSlug, divSlug, fixtureNo);
  const { auth, canScore, canEdit } = page;
  const id = page.fixtureId;
  // Accepted officials scoring without edit rights get the courtside chrome.
  const isOfficialScorer = canScore && !canEdit;
  const fixture = await getFixture(auth, id);
  // §T4 — the cfg the PAD renders against: the fixture's frozen snapshot if it
  // has been scored, otherwise the division config with this stage's overlay
  // applied. Deliberately not `division.config`, which is what this page used
  // to hand the pad: it disagrees with the fold for any scored fixture, and it
  // cannot see a per-stage format override at all.
  const [division, state, events, recorderNames, availability, schedule, padCfg] =
    await Promise.all([
      getDivision(auth, fixture.division_id),
      getFixtureState(auth, id),
      listEvents(auth, id, 0),
      eventRecorderNames(auth, id),
      listFixtureAvailability(auth, id),
      getScheduleSettings(auth, fixture.division_id),
      loadFixturePadCfg(auth, id),
    ]);
  const [competition, planKey] = await Promise.all([
    getCompetition(auth, division.competition_id),
    orgPlanKey(auth.orgId),
  ]);
  const viewerPlan = viewerPlanFrom(planKey);
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // R7 B2 — the catalog that governs THIS division, not the module's
  // static one: a competition's config moves the starting size (football
  // small-sided, cricket playersPerSide) and the keeper minimum (hockey /
  // ice hockey `goalkeeper: "optional"`).
  const lineupCatalog = lineupCatalogFor(sportModule, division.config);

  // PROMPT-63 §4: ledger-integrity strip (organiser surface, once events
  // exist). The verifier is the V226 DB function; download is Pro-gated.
  let audit: { verified: boolean; tamperedSeq: number | null; entitled: boolean } | null = null;
  if (canEdit && events.length > 0) {
    const [[{ bad }], entitled] = await Promise.all([
      sql<{ bad: string | null }[]>`select verify_score_events_chain(${id})::text as bad`,
      hasFeature(auth.orgId, "scoring.audit_export", division.competition_id),
    ]);
    let tamperedSeq: number | null = null;
    if (bad !== null) {
      const [row] = await sql<{ seq: number }[]>`select seq from score_events where id = ${bad}`;
      tamperedSeq = row?.seq ?? null;
    }
    audit = { verified: bad === null, tamperedSeq, entitled };
  }

  async function side(entrantId: string | null): Promise<SideInfo | null> {
    if (!entrantId) return null;
    const [entrant, lineup] = await Promise.all([
      getEntrant(auth, entrantId),
      getLineup(auth, id, entrantId),
    ]);
    return {
      id: entrant.id,
      name: entrant.display_name,
      kind: entrant.kind,
      members: entrant.members as SideInfo["members"],
      lineup: lineup.slots as LineupSlotIn[],
    };
  }
  const [home, away] = await Promise.all([
    side(fixture.home_entrant_id),
    side(fixture.away_entrant_id),
  ]);
  // SPEC-1: active suspensions among this fixture's entrants, joined into the
  // pad bootstrap (no client fetch). Returns [] when the org isn't entitled.
  const activeSuspensions = await suspensionsForFixture(auth, fixture.division_id, [
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  ]);

  // S13/#422 — the v2 pad's bootstrap, resolved unconditionally now that the
  // feature flag that used to gate it is gone. `null` only on a resolution failure
  // (resolveScorePadBootstrap's own doc) — FixtureConsole renders no pad
  // section in that case, since there is no v1 fallback left.
  const scorePadV2 = await resolveScorePadBootstrap({
    sportModule,
    rawConfig: padCfg,
    hasFeatureFn: (key) => hasFeature(auth.orgId, key, division.competition_id),
    initialEvents: events.map((e) => eventOutToEnvelope(fixture.id, e)),
    identity: { recordedBy: auth.userId, deviceLinkId: null },
  });

  return (
    <>
      <main className="mx-auto max-w-5xl px-4 py-8">
        {isOfficialScorer && (
          <p className="mb-4 text-xs text-slate-400">
            <Link href="/me" className="hover:text-purple-600">
              ← My matches
            </Link>
            <span className="ml-2">
              {competition.name} · {division.name}
            </span>
          </p>
        )}

        {/* Player self-check-in QR (PROMPT-53) — top of the match panel, and
            only BEFORE the match starts (owner feedback 2026-07-13): check-in
            is an arrival tool, once play begins it's just noise. */}
        {!isOfficialScorer &&
          canScore &&
          !(competition.frozen ?? false) &&
          fixture.status === "scheduled" && (
            <div className="mb-3 flex justify-end">
              <CheckinQr fixtureId={fixture.id} />
            </div>
          )}

        {/* Assigned-officials strip (design v11 §D2): organiser surface only —
            a red "Declined" badge is the cue to re-pick. */}
        {canEdit && Array.isArray(fixture.officials) && (
          <FixtureOfficialsStrip officials={fixture.officials as never} />
        )}

        <FixtureConsole
          fixture={{
            id: fixture.id,
            status: fixture.status,
            scheduled_at: fixture.scheduled_at,
            scheduled_tz: schedule.tz,
            venue_name: fixture.venue_name,
            court_name: fixture.court_name,
            round_no: fixture.round_no,
            home_slot_label: fixture.home_slot_label,
            away_slot_label: fixture.away_slot_label,
          }}
          sport={{
            key: division.sport_key,
            config: padCfg as Record<string, unknown>,
            scorerLabel: sportModule.officialLabel.scorer,
            positionGroups: lineupCatalog.groups,
            roles: lineupCatalog.roles ?? [],
            lineupSize: lineupCatalog.lineup.size,
            benchMax: lineupCatalog.lineup.benchMax ?? 0,
          }}
          home={home}
          away={away}
          initialState={{
            status: state.status,
            last_seq: state.last_seq,
            summary: state.summary,
            state: state.state,
            outcome: state.outcome,
          }}
          initialEvents={events.map((e) => ({
            id: e.id,
            seq: e.seq,
            type: e.type,
            payload: e.payload,
            recorded_at: e.recorded_at,
            recorded_by: e.recorded_by,
            voids_event_id: e.voids_event_id,
            device_link_id: e.device_link_id,
          }))}
          canEdit={canScore && !(competition.frozen ?? false)}
          recorderNames={recorderNames}
          availability={availability}
          activeSuspensions={activeSuspensions}
          publicPath={
            // Share needs a page strangers can open (v3/10 #2) — private
            // competitions have none.
            competition.visibility !== "private"
              ? `/shared/${orgSlug}/${competition.slug}/${division.slug}/fixtures/${fixture.id}`
              : null
          }
          scorePadV2={scorePadV2}
          // R7/C1 — the audit verdict now renders in the activity panel's
          // own footer, beside the rows it is a verdict ABOUT. It used to be
          // a loose strip below the whole console, two cards away from them.
          audit={audit}
          // R7/C3 (D-19) — the gate stays here (only this server component
          // knows about the freeze); the PANEL moved into the console, beside
          // the pad's heading. It used to render as the last card below.
          deviceHandover={
            canEdit &&
            !(competition.frozen ?? false) &&
            fixture.status !== "finalized" &&
            fixture.status !== "cancelled"
          }
          viewerPlan={viewerPlan}
        />
      </main>
    </>
  );
}
