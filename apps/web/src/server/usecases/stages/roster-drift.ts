import "server-only";
// Roster drift for a stage that draws from the live roster, and the sealed-setup
// and attachment counts a Generate or Rebuild reports.

import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ROSTER_DRIFT_INELIGIBLE_KINDS, isRosterDriftEligible } from "@/lib/roster-drift-eligibility";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { Tx, StageRosterDriftEntrant, StageRosterDrift, SealedSetupCounts } from "./types";

// ---------------------------------------------------------------------------
// Roster drift (F3 Task 5, 2026-08-18 plan — supersedes ruling 7's framing;
// see the plan's "Corrected premise"). Only a stage with NO progression
// source draws fixtures directly from the live active roster — the exact
// same condition `generateStageFixtures`'s own `pre` gate above tests
// (`if (!stage.progression) return null`, which falls through to the plain
// `select ... from entrants where status in (...)` path). A later stage
// either reads a FROZEN qualified list at completion (`timing:"on_complete"`
// — intentionally excludes non-qualifiers, that's not drift) or generates
// pure-topology placeholders with no entrant reference at all
// (`timing:"setup"` — structurally insulated, stage-seeding.ts's
// sourceShapeOf reads pool shape, never entrant rows). `ladder` and
// `americano` are excluded for a different reason: a ladder's fixtures come
// from individual challenges (issueChallenge), never a bulk generate
// (generateStageFixtures returns `[]` for it above), and americano mints its
// own `pair` entrants on the fly per fixture (americanoGen above) rather
// than referencing the division's registered entrants directly — this
// signal would misreport ~100% of entrants "unplaced" for both.
// ---------------------------------------------------------------------------
// Re-exported so existing `import { … } from "./stages"` call sites need no
// churn; the rule itself lives in a DB-free module (lib/roster-drift-
// eligibility.ts) so the division page and its tests can import the REAL
// function rather than restating it in a mock of this server-only file.
export { ROSTER_DRIFT_INELIGIBLE_KINDS, isRosterDriftEligible };

const NO_ATTACHMENTS = {
  officials: 0, lineups: 0, deviceLinks: 0, streams: 0, youtubeBroadcasts: 0, availability: 0, calls: 0,
} as const;

/** The two `fixtures.status` values that still expect their entrants to turn
 *  up. The full vocabulary is eight (`FIXTURE_STATUSES`, lib/fixture-status.ts):
 *  the other six — `decided`, `finalized`, `abandoned`, `forfeited`,
 *  `cancelled`, and W2a's `needs_decision` (played, waiting on the organiser's
 *  settle, not on its entrants) — are history or never-to-be-played, so a name
 *  on one of them is a RECORD, not an outstanding obligation. Same
 *  membership as `withdrawal.ts`'s `PENDING` (which decides whether a
 *  withdrawal walks a fixture over or voids it) and `venues.ts`'s
 *  `UNPLAYED_FIXTURE_STATUSES`, kept local for the same reason those are:
 *  each is a judgement about its own question, not one shared table. */
const PENDING_FIXTURE_STATUSES = ["scheduled", "in_play"];

/** Derived, never stored (ruling 7) — a plain join over `entrants` and
 *  `fixtures`, computed fresh on every call. No migration: `entrants` keeps
 *  `created_at` only (no `updated_at`) because "since when" is not needed to
 *  answer "does the board match the roster" (plan, 5a). */
export async function getStageRosterDrift(auth: AuthCtx, stageId: string): Promise<StageRosterDrift> {
  // W4 B2 fix round 2 (item 5): the sealed kinds of setup (streams, YouTube broadcasts) are read on the pooled privileged
  // client AFTER the tenant transaction closes — never inside it (42501 under app_user, and a second pooled connection
  // inside `withTenant` is lib/db.ts's self-deadlock). A read for a banner and a confirm: the window between the two reads
  // is one READ COMMITTED step, the same staleness the page already has.
  const { drift, boarded } = await withTenant(auth.orgId, async (tx): Promise<{ drift: StageRosterDrift; boarded: boolean }> => {
    const [stage] = await tx<
      { division_id: string; kind: string; progression: Record<string, unknown> | null; config: unknown }[]
    >`select division_id, kind, progression, config from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.progression !== null || ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)) {
      return { drift: { ghosts: [], unplaced: [], vacantLines: 0, attachments: NO_ATTACHMENTS }, boarded: false };
    }

    // A stage with NO fixtures has no BOARD, and drift is defined against a
    // board — "the names on your fixtures no longer match your roster".
    // Without this, a freshly-created stage (the single most common state a
    // stage is ever in: created, not yet generated) reported EVERY active
    // entrant as "unplaced", so the banner fired on a division where nothing
    // had gone wrong and the one-click rebuild it offers would have been a
    // no-op regenerate. F3 ultrareview finding 6. `Generate` is the call to
    // action there, and stages-panel already renders it prominently.
    const [{ count: fixtureCount }] = await tx<{ count: number }[]>`
      select count(*)::int as count from fixtures where stage_id = ${stageId}`;
    if (fixtureCount === 0) return { drift: { ghosts: [], unplaced: [], vacantLines: 0, attachments: NO_ATTACHMENTS }, boarded: false };

    // Odd-Swiss sit-out (W3 item 6) — CLOSED by the bye-row follow-up.
    // Two suppression heuristics were tried and reviewed out (2026-09-06):
    // a `created_at` predicate that silently hid genuine withdraw→reinstate
    // drift, and a round-membership rule that was vacuous while `swissGen`
    // wrote no fixture for `pairRound`'s `bye`. `swissGen` now persists that
    // bye as a forfeited award row (home set / away null), so the sit-out is
    // in `referencedIds` and does not land in `unplaced`. Late registrations
    // between rounds still appear as unplaced-only; the UI softens that via
    // `swissAwaitingPairing` (no destructive rebuild). Pre-fix stages that
    // never wrote a bye row still score via the absence fallback in swissGen.
    //
    // The two directions read DIFFERENT fixture sets, and that asymmetry is
    // the fix for a third false banner (found 2026-09-20 by driving a
    // six-player Swiss division). A ghost is someone no longer active who is
    // STILL EXPECTED TO PLAY, so only a fixture in `PENDING_FIXTURE_STATUSES`
    // can make one: an organiser who withdraws an entrant after their round
    // is played leaves a `forfeited`/`decided` row whose result is supposed to
    // stand, and the unfiltered set called that drift and offered to rebuild
    // the board mid-event. `unplaced` keeps the UNFILTERED set on purpose —
    // an entrant holding only a played fixture IS placed, and narrowing that
    // side too would swap this banner for the opposite one.
    const [active, referenced, expectedToPlay] = await Promise.all([
      tx<StageRosterDriftEntrant[]>`
        select id, display_name from entrants
        where division_id = ${stage.division_id} and status in ('registered', 'confirmed')
        order by display_name`,
      tx<StageRosterDriftEntrant[]>`
        select distinct e.id, e.display_name
        from entrants e
        where e.id in (
          select home_entrant_id from fixtures where stage_id = ${stageId} and home_entrant_id is not null
          union
          select away_entrant_id from fixtures where stage_id = ${stageId} and away_entrant_id is not null
        )
        order by e.display_name`,
      tx<StageRosterDriftEntrant[]>`
        select distinct e.id, e.display_name
        from entrants e
        where e.id in (
          select home_entrant_id from fixtures
            where stage_id = ${stageId} and home_entrant_id is not null
              and status = any(${PENDING_FIXTURE_STATUSES})
          union
          select away_entrant_id from fixtures
            where stage_id = ${stageId} and away_entrant_id is not null
              and status = any(${PENDING_FIXTURE_STATUSES})
        )
        order by e.display_name`,
    ]);
    const activeIds = new Set(active.map((e) => e.id));
    const referencedIds = new Set(referenced.map((e) => e.id));
    return {
      drift: {
        ghosts: expectedToPlay.filter((e) => !activeIds.has(e.id)),
        unplaced: active.filter((e) => !referencedIds.has(e.id)),
        vacantLines: isRootKnockout(stage) ? await vacantFirstRoundLines(tx, stageId) : 0,
        attachments: await stageAttachmentCounts(tx, stageId, { streams: 0, youtubeBroadcasts: 0 }),
      },
      boarded: true,
    };
  });
  if (!boarded) return drift;
  const sealed = await sealedStageSetupCounts(sql, auth.orgId, stageId);
  return { ...drift, attachments: { ...drift.attachments, ...sealed } };
}

/** A ROOT knockout — no progression and no fed `config.qualified` list: the bracket drawn straight from the roster, the
 *  one `reconcileRootBracket` reconciles and Start's `roster_drift` read covers (schedule.ts). */
function isRootKnockout(stage: { kind: string; progression: unknown; config: unknown }): boolean {
  if (stage.kind !== "knockout" || stage.progression !== null) return false;
  const config = stage.config;
  return !(typeof config === "object" && config !== null && Array.isArray((config as { qualified?: unknown }).qualified));
}

/** W4 B2 fix round 2 (item 1): `StageRosterDrift.vacantLines` — the first-round lines with an empty place: a match still to
 *  be played with a seat nobody is on, or a bye with nobody on it. The same two shapes Start's `roster_drift` read names
 *  (schedule.ts), which is what makes Start refuse; this is what lets the desk show the remedy. */
async function vacantFirstRoundLines(tx: Tx, stageId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from fixtures f
     where f.stage_id = ${stageId} and f.round_no = 1
       and ((f.status = 'scheduled' and (f.home_entrant_id is null or f.away_entrant_id is null))
            or (f.home_entrant_id is null and f.away_entrant_id is null))`;
  return row?.n ?? 0;
}

/** `SealedSetupCounts` for a stage, on a PRIVILEGED client only — the pooled `sql` outside any transaction, or a
 *  `withTenant` `privilegedPrelude`'s own connection. Org-scoped in SQL (each sealed table carries its `org_id`), as V430
 *  requires of every read on that client. A match with a live stream code (minted when the stream panel opens; its phone
 *  pairings cascade with it) or per-match stream settings (the destination pre-pick) counts once; an ENDED code is
 *  history, not setup. */
export async function sealedStageSetupCounts(db: Tx | typeof sql, orgId: string, stageId: string): Promise<SealedSetupCounts> {
  const [counts] = await db<{ streams: number; youtube_broadcasts: number }[]>`
    select
      (select count(*) from fixtures f
        where f.stage_id = ${stageId} and f.org_id = ${orgId}
          and (exists (select 1 from fixture_stream_codes c
                        where c.fixture_id = f.id and c.org_id = ${orgId} and c.ended_at is null)
               or exists (select 1 from fixture_stream_settings st
                           where st.fixture_id = f.id and st.org_id = ${orgId})))::int as streams,
      (select count(*) from youtube_broadcasts yb
         join fixtures f on f.id = yb.fixture_id
        where f.stage_id = ${stageId} and yb.org_id = ${orgId})::int as youtube_broadcasts`;
  return { streams: counts?.streams ?? 0, youtubeBroadcasts: counts?.youtube_broadcasts ?? 0 };
}

/** The organiser work attached to a stage's fixtures that a delete of them CASCADEs into (`StageRosterDrift.attachments`):
 *  what Rebuild's confirm lists, and what a knockout's Generate refuses to redraw over (W4 B2 fix round 1, I1; every kind
 *  that can exist before Start since fix round 2, item 5). The tenant-readable kinds in one round trip on `tx` — each a
 *  plain count over the stage's own fixture ids — joined with the sealed kinds the caller read on a privileged client. */
export async function stageAttachmentCounts(
  tx: Tx,
  stageId: string,
  sealed: SealedSetupCounts,
): Promise<StageRosterDrift["attachments"]> {
  const [counts] = await tx<
    { officials: number; lineups: number; device_links: number; availability: number; calls: number }[]
  >`
    select
      (select count(*) from fixture_officials fo
         join fixtures f on f.id = fo.fixture_id where f.stage_id = ${stageId})::int as officials,
      (select count(*) from lineups l
         join fixtures f on f.id = l.fixture_id where f.stage_id = ${stageId})::int as lineups,
      (select count(*) from device_links dl
         join fixtures f on f.id = dl.fixture_id where f.stage_id = ${stageId})::int as device_links,
      (select count(*) from fixture_availability fa
         join fixtures f on f.id = fa.fixture_id where f.stage_id = ${stageId})::int as availability,
      (select count(*) from fixture_calls fc
         join fixtures f on f.id = fc.fixture_id where f.stage_id = ${stageId})::int as calls`;
  return {
    officials: counts?.officials ?? 0,
    lineups: counts?.lineups ?? 0,
    deviceLinks: counts?.device_links ?? 0,
    streams: sealed.streams,
    youtubeBroadcasts: sealed.youtubeBroadcasts,
    availability: counts?.availability ?? 0,
    calls: counts?.calls ?? 0,
  };
}