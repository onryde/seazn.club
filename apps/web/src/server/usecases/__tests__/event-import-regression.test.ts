// P11 Task 6 — the three regression proofs (design doc
// docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md §9, and
// §2.1/§2.2 for why (a) compares derived state rather than hashes and why (b)
// is a read-path test). No production code changes here — if one of these
// cannot be made to pass honestly, that is a defect in Tasks 1-5.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";
import { importEvents } from "../event-import";
import { divisionPlayerStats, personStats } from "../player-stats";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** Grant one boolean feature out-of-plan — the same row shape as
 *  event-import-route.test.ts's own `grant` helper and e2e's
 *  setBoolEntitlementOverrideSql (apps/web/e2e/helpers.ts:342). */
async function grantBool(orgId: string, key: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${key}, true)
    on conflict (org_id, feature_key) do update set bool_value = true`;
}

/**
 * Proof (b) needs entrants with a REAL person on the roster. `_rig.ts`'s
 * divisionRig/startedDivisionWithFixture create individual entrants with
 * `members: []` — fine for (a) and (c), which never read a person id, but
 * silently wrong for (b): the generic module's `playerStats.folded`
 * (packages/engine/src/sports/generic/generic.ts:657) credits wins/losses/
 * points_for through `personsForEntrant`, which resolves via
 * `entrant_members` (packages/engine/src/stats/stats.ts:254) — an entrant
 * with zero members credits nobody, with no error. Not additive-safe to bolt
 * onto the shared rig for one caller (divisionRig's shape is depended on by
 * six other files per its own docstring), so this is built locally instead,
 * reusing the same underlying usecases divisionRig calls.
 *
 * Home/away is resolved by reading the generated fixture back, rather than
 * assumed from entrant creation order — the round-robin generator (not this
 * file) decides which entrant lands on which side.
 */
async function startedDivisionWithPersons(auth: AuthCtx): Promise<{
  divisionId: string;
  fixtureId: string;
  homePersonId: string;
  awayPersonId: string;
}> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Careers Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  // Called directly as a usecase (bypassing the route's Zod `.parse()`), so
  // NewPersonMemberInput's `.default(false)`/`.default([])` never apply —
  // those are parse-time defaults, not runtime fallbacks inside
  // insertMembers (entrants.ts:169's `${m.is_captain}` has none). Every
  // field is supplied explicitly; vitest does not typecheck test files, so
  // an omitted field here would not be caught at compile time either — it
  // was only caught by the UNDEFINED_VALUE runtime error from postgres.js.
  const member = (name: string) => ({
    new_person: { full_name: name },
    squad_number: null,
    default_position_key: null,
    is_captain: false,
    roles: [],
  });
  await createEntrants(auth, division.id, [
    { kind: "individual", display_name: "P1", seed: 1, members: [member("Player One")] },
    { kind: "individual", display_name: "P2", seed: 2, members: [member("Player Two")] },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L1", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  await startDivision(auth, division.id);
  const fixtureId = fixtures[0]!.id;

  const [fx] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
    select home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
  const members = await sql<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members
    where entrant_id in (${fx!.home_entrant_id}, ${fx!.away_entrant_id})`;
  const personOf = (entrantId: string): string => members.find((m) => m.entrant_id === entrantId)!.person_id;

  return {
    divisionId: division.id,
    fixtureId,
    homePersonId: personOf(fx!.home_entrant_id),
    awayPersonId: personOf(fx!.away_entrant_id),
  };
}

describe.skipIf(!HAS_DB)("event-import — regression proofs (P11 Task 6)", () => {
  it("(a) twin: import-derived state matches a live-scored twin fixture; hashes are not compared; B's chain is intact", async () => {
    const { auth } = await seedOrg();
    // Same shape event-import-write.test.ts's own sibling task already
    // proved: 2 entrants, split across 2 league stages, each stage's round
    // robin over the SAME 2 division entrants yielding exactly 1 fixture —
    // so A and B share entrant identity by construction (_rig.ts's own
    // docstring on startedDivisionWithFixture).
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    const [aId, bId] = fixtureIds;
    expect(fixtureIds).toHaveLength(2);
    const stream = decidingStream();

    // Fixture A: scored live, one event at a time, through the real scoring
    // path a courtside scorer actually uses.
    for (const [i, ev] of stream.entries()) {
      await scoreEvent(auth, aId!, { expected_seq: i, type: ev.type, payload: ev.payload });
    }

    // Fixture B: the identical stream, imported in one call.
    const report = await importEvents(auth, divisionId, {
      import_id: "twin-import",
      streams: [{ fixture: { id: bId! }, events: stream }],
    });
    expect(report.results[0]!.status).toBe("imported");
    expect(report.results[0]!.eventsAppended).toBe(stream.length);

    // Everything the WRITER derives must agree between the twins. Hash
    // equality is deliberately never asserted: V226's canonical string
    // includes the event id, the fixture id and recorded_at
    // (V226__hash_chain_functions.sql:20-23), and A/B necessarily differ in
    // all three — "byte-identical hash chain" is impossible by construction,
    // not merely hard (design doc §2.2).
    const [msA] = await sql<{ summary: unknown; last_seq: number }[]>`
      select summary, last_seq from match_states where fixture_id = ${aId}`;
    const [msB] = await sql<{ summary: unknown; last_seq: number }[]>`
      select summary, last_seq from match_states where fixture_id = ${bId}`;
    expect(msB!.summary).toEqual(msA!.summary);
    expect(msB!.last_seq).toBe(msA!.last_seq);

    const [fxA] = await sql<{ outcome: unknown; status: string; config_snapshot: unknown }[]>`
      select outcome, status, config_snapshot from fixtures where id = ${aId}`;
    const [fxB] = await sql<{ outcome: unknown; status: string; config_snapshot: unknown }[]>`
      select outcome, status, config_snapshot from fixtures where id = ${bId}`;
    expect(fxB!.outcome).toEqual(fxA!.outcome);
    expect(fxB!.status).toBe(fxA!.status);
    expect(fxB!.config_snapshot).toEqual(fxA!.config_snapshot);

    // B's seq is gapless 1..n — the same invariant event-import-write.test.ts
    // already checks for a single-stream import, re-proved here on the twin.
    const seqRows = await sql<{ seq: number }[]>`
      select seq from score_events where fixture_id = ${bId} order by seq`;
    expect(seqRows.map((r) => r.seq)).toEqual(seqRows.map((_, i) => i + 1));

    // Chain INTEGRITY on B (not equality against A, which is impossible):
    // each row's prev_hash must equal its predecessor's row_hash, first row
    // null. This is deliberately a SEPARATE assertion from the derived-state
    // comparison above, not a replacement for it — the trigger
    // (score_events_hash_chain, V226:14-27) fires for ANY insert into
    // score_events, including a hypothetical second writer that reimplements
    // the fold slightly wrong, so an intact chain proves nothing about code
    // reuse. It only catches a future bulk insert that bypasses the trigger
    // entirely (e.g. a raw COPY). The derived-state comparison above is what
    // actually catches "the import path forgot the snapshot freeze, the
    // status write, or the match_states upsert" — see the Task 6 report for
    // why this task's mutation check deliberately targets event-import.ts,
    // not the shared appendEventInTx writer.
    const chainRows = await sql<{ seq: number; prev_hash: string | null; row_hash: string }[]>`
      select seq, prev_hash, row_hash from score_events where fixture_id = ${bId} order by seq`;
    chainRows.forEach((r, i) => {
      expect(r.prev_hash).toBe(i === 0 ? null : chainRows[i - 1]!.row_hash);
    });
    // Belt-and-suspenders: the DB's own verifier (V226:54-68) also
    // recomputes row_hash itself, not just the linkage — null = intact.
    const [{ broken }] = await sql<{ broken: string | null }[]>`
      select verify_score_events_chain(${bId}) as broken`;
    expect(broken).toBeNull();
  });

  it("(b) careers day one: divisionPlayerStats/personStats surface an imported fixture's history (read path, no side-effect wait)", async () => {
    const { auth } = await seedOrg();
    // stats.player is false on `community` (V112__entitlements_v2.sql:60),
    // the plan every fresh rig org resolves to having no subscription row.
    await grantBool(auth.orgId, "stats.player");
    const { divisionId, fixtureId, homePersonId, awayPersonId } = await startedDivisionWithPersons(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "careers-1",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.status).toBe("imported");

    // This is a READ-path assertion by design (spec §2.1):
    // recomputePlayerStats/divisionPlayerStats/personStats have ZERO call
    // sites in scoring.ts's or event-import.ts's decided-fixture side-effect
    // chain (onDecided/refreshDiscipline/refreshNews) — they recompute from
    // score_events lazily, on every read. A test that waited for some
    // "stats updated" signal to fire would wait forever and pass vacuously
    // the moment it gave up waiting; calling the read usecases directly is
    // the only way this claim is provable at all.
    const division = await divisionPlayerStats(auth, divisionId, {});
    const home = division.rows.find((r) => r.person_id === homePersonId);
    const away = division.rows.find((r) => r.person_id === awayPersonId);
    // decidingStream() decides generic.result {p1Score: 3, p2Score: 1} — a
    // home win, 3-1 (_rig.ts's own docstring, folded through generic.ts
    // directly to confirm). foldGenericStats (generic.ts:394-471) credits
    // the winner wins:1/points_for:3 and the loser losses:1/points_for:1.
    expect(home?.stats.wins).toBe(1);
    expect(home?.stats.points_for).toBe(3);
    expect(away?.stats.losses).toBe(1);
    expect(away?.stats.points_for).toBe(1);

    const homeCareer = await personStats(auth, homePersonId, divisionId);
    expect(homeCareer.divisions).toHaveLength(1);
    expect(homeCareer.divisions[0]!.division_id).toBe(divisionId);
    expect(homeCareer.divisions[0]!.stats.wins).toBe(1);
    expect(homeCareer.divisions[0]!.stats.points_for).toBe(3);

    const awayCareer = await personStats(auth, awayPersonId, divisionId);
    expect(awayCareer.divisions[0]!.stats.losses).toBe(1);
  });

  it("(c) replay: re-importing the same import_id is byte-identical and does not re-fire post-commit side effects", async () => {
    const { auth } = await seedOrg();
    // news.auto is false on `community` too (V112:60-62's sibling rows) —
    // grant it, and turn the division's own opt-in on, so the FIRST import
    // genuinely drafts a post. Skipping either leaves refreshNews a no-op
    // (scoring.ts:303-318) regardless of whether the replay path is correct,
    // which would make "the draft count is unchanged" trivially true (0==0)
    // whether or not side effects re-fire — the non-vacuousness guard a few
    // lines down (draftsAfterFirst > 0) exists to rule exactly that out.
    await grantBool(auth.orgId, "news.auto");
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`update divisions set auto_posts = true where id = ${divisionId}`;

    const importId = "replay-1";
    const call = () =>
      importEvents(auth, divisionId, {
        import_id: importId,
        streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
      });

    const first = await call();
    expect(first.results[0]!.status).toBe("imported");

    const draftsAfterFirst = await sql<{ n: number }[]>`
      select count(*)::int as n from org_posts where division_id = ${divisionId}`;
    // Non-vacuousness guard (see comment above `grantBool` call): if this is
    // 0, the count-unchanged assertion below would hold no matter what the
    // replay path does, and the whole check would be theatre.
    expect(draftsAfterFirst[0]!.n).toBeGreaterThan(0);

    const snapshotEvents = () =>
      sql`select * from score_events where fixture_id = ${fixtureId} order by seq`;
    const snapshotMatchState = () => sql`select * from match_states where fixture_id = ${fixtureId}`;
    const snapshotFixture = () => sql`select * from fixtures where id = ${fixtureId}`;
    const snapshotImports = () =>
      sql`select * from event_imports where division_id = ${divisionId} and import_id = ${importId} order by fixture_id`;

    const eventsBefore = await snapshotEvents();
    const matchStateBefore = await snapshotMatchState();
    const fixtureBefore = await snapshotFixture();
    const importsBefore = await snapshotImports();
    expect(importsBefore).toHaveLength(1);

    const second = await call();
    expect(second.results[0]!.status).toBe("skipped_duplicate");
    expect(second.results[0]!.eventsAppended).toBe(0);

    expect(await snapshotEvents()).toEqual(eventsBefore);
    expect(await snapshotMatchState()).toEqual(matchStateBefore);
    expect(await snapshotFixture()).toEqual(fixtureBefore);
    expect(await snapshotImports()).toEqual(importsBefore);

    // The observable proxy for "post-commit side effects did not re-fire":
    // onDecided/refreshDiscipline/refreshNews/captureServer only run after a
    // successful WRITE (event-import.ts step 8), which the replay guard
    // (event-import.ts's `if (existing)` branch) returns ahead of — so a
    // correct replay never reaches them a second time.
    const draftsAfterReplay = await sql<{ n: number }[]>`
      select count(*)::int as n from org_posts where division_id = ${divisionId}`;
    expect(draftsAfterReplay[0]!.n).toBe(draftsAfterFirst[0]!.n);
  });
});
