// Competition Desk W1, Task 3 — getCompetitionDesk (spec 2026-09-02 §"The
// shared model"): the per-division phase/attention/counts the desk's own
// list and card views both read. Real Postgres required; skipped without
// DATABASE_URL. seedOrg/seedDivision copied from add-fixture.test.ts (org +
// sports + pro plan + competition + division + N entrants), with
// seedDivision's return narrowed to the ids this file actually needs.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { getCompetitionDesk, competitionPhase } from "../competition-desk";
import { createAssignment } from "../scorers";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Af " + suffix}, ${"af-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

// F4 fix tests: `createAssignment` needs a real users row (FK), same
// pattern as scorers.test.ts's own `makeUser`.
async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name})
    returning id`;
  return id;
}

// Same seeding as add-fixture.test.ts's seedDivision, return narrowed to
// { competitionId, divisionId } — the only two ids this file's tests read.
async function seedDivision(auth: AuthCtx, count: number) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Af Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { competitionId: comp.id, divisionId: division.id };
}

describe.skipIf(!HAS_DB)("getCompetitionDesk", () => {
  afterAll(async () => {
    await sql.end({ timeout: 1 });
  });

  // Found by driving the product: a competition created seconds ago rendered
  // "Finished · 0 divisions" in its masthead, directly above the "No divisions
  // yet" empty state. `competitionPhase` derives from the division phases, and
  // an EMPTY set satisfied none of the `includes` tests and fell through to
  // finished — the same vacuous truth the division rule was amended for.
  it("a competition with no divisions is setting up, never finished", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Af Empty " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const desk = await getCompetitionDesk(auth, comp.id);
    expect(desk.divisions.size).toBe(0);
    expect(competitionPhase(desk)).toEqual({ kind: "setting_up" });
  });

  it("a fresh division with no stage is setting_up with no attention", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.attention).toEqual([]);
    expect(competitionPhase(desk)).toEqual({ kind: "setting_up" });
  });

  // Found by DRIVING round C's fix, not by a suite: the rows were corrected to
  // read "Scheduled" while the masthead above them still read "Setting up" —
  // on a knockout whose only dated fixture was a TBD-entrant final (excluded
  // from `next` by card-stats) and on a mid-season league with one match
  // played. The masthead must never contradict the rows beneath it.
  it("the masthead agrees with its rows when no date is available", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    await sql`update fixtures set status = 'decided', scheduled_at = now() - interval '2 days'
              where division_id = ${divisionId} and fixture_no = 1`;
    await sql`update fixtures set scheduled_at = null
              where division_id = ${divisionId} and fixture_no <> 1`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("scheduled");
    // The whole point: the pill over the ledger says what the ledger says.
    expect(competitionPhase(desk)).toEqual({ kind: "scheduled" });
  });

  // L2 (fix round H, Important): `nothingHasHappened` is a CONJUNCTION —
  // `d.phase === "setting_up" && d.played === 0` — and its two halves had
  // never been mutated separately. The `played === 0` half is killed by the
  // "K1 sibling" case further down (phase `setting_up`, 6 played, masthead
  // must be `scheduled`). The `phase === "setting_up"` half was killed by
  // NOTHING: replacing the whole guard with `divisions.every(d => d.played
  // === 0)` left 147/147 green while re-creating instance TEN, driven at
  // 09:13Z on 2026-09-03 — a timetable published yesterday, 0 of 6 played,
  // masthead correctly "Scheduled" today and "Setting up" under the mutant.
  //
  // This is that case: nothing played at all, and a phase that is NOT
  // `setting_up`. Its expected value differs under each candidate predicate,
  // which is the only shape that can pin one half of a conjunction.
  //
  // Deliberately DATED IN THE PAST: a future date would be rescued by the
  // ladder's `next` rung two steps above and never reach this guard at all,
  // so the test would pass under both the guard and its mutant.
  it("L2: a published timetable with nothing played yet is 'scheduled' — the phase half of nothingHasHappened", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    // `scheduled` is exactly what the ordinary Publish action sets
    // (schedule.ts's publishSchedule) — an organiser who published a
    // timetable and never pressed Start.
    await sql`update divisions set status = 'scheduled' where id = ${divisionId}`;
    await sql`update fixtures set scheduled_at = now() - interval '1 day'
              where division_id = ${divisionId}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    // Print the asserted CONTENT beside the verdict: this is the state the
    // guard's two halves disagree about, and nothing else.
    expect(d.played).toBe(0);
    expect(d.total).toBe(6);
    expect(d.phase).toBe("scheduled");
    // The masthead says what the rows say. Under `every(d => d.played === 0)`
    // this reads "Setting up" above six dated, overdue fixtures.
    expect(competitionPhase(desk)).toEqual({ kind: "scheduled" });
  });

  it("F1 fix: unscheduled fixtures on an active division are 'setting_up', never 'scheduled', with an unscheduled attention", async () => {
    // Final review, Critical: the OLD rule 5 was a bare "otherwise", so this
    // exact shape — a started division, fixtures generated, none carrying a
    // time — read "Scheduled" while its own status line said "nothing
    // scheduled". Rule 5 now requires a live fixture to actually carry a
    // scheduledAt; with none, the division is still setting_up.
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-08T10:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 6 });
    expect(d.total).toBe(6);
  });
  it("F1 fix, contrast: the same league with ONE fixture given a real (future) time reads 'scheduled'", async () => {
    // Isolates the fix: it is not "generated fixtures never read scheduled",
    // it is specifically "no fixture carries a time yet" — one dated,
    // still-unplayed fixture is enough.
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set scheduled_at = ${new Date("2026-09-20T09:00:00Z").toISOString()} where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-08T10:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("scheduled");
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 5 });
  });

  // fix-round-c, Defect 2 (owner ruling 2026-09-02): F1's fallback
  // over-applied — a mid-season division that has already played a fixture
  // but not yet dated its next round read "setting_up" beside a part-filled
  // progress bar. Proven end to end through the real `getCompetitionDesk`
  // assembly (not just the pure resolver's own unit coverage), the same way
  // the F1 fix above is. Reproduced live before this fix: 1 of 6 played, 5
  // unscheduled, "Setting up".
  it("fix-round-c Defect 2: a played fixture with nothing else dated reads 'scheduled', never 'setting_up'", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'decided' where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("scheduled");
    expect(d.played).toBe(1);
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 5 });
  });

  // G1 fix (fix round D, Critical): the root of the finding. card-stats.ts's
  // own `next` query has no `>= now()` floor and picks the EARLIEST fixture
  // overall (`scheduled_at asc nulls last`, LIMIT 1) — a past, unresulted
  // kick-off sorts ahead of a genuinely future one and the query stops
  // there, so `s?.next` alone can never see the later fact. `next` here must
  // come from a SEARCH over the division's own full fixtures list instead.
  // Live repro: "Next Tue 1 Sep 11:00 · 0 of 6 played · 4 unscheduled"
  // directly under a Needs-you row reading "result missing for Riverside FC
  // v Harbour CC / the match window has passed" — the SAME fixture.
  describe("G1: getCompetitionDesk's own next SEARCHES the division's fixtures, never just card-stats' single (possibly stale) candidate", () => {
    it("a past, unresulted kick-off is skipped in favor of a genuinely later dated fixture in the SAME division", async () => {
      const { auth } = await seedOrg();
      const { competitionId, divisionId } = await seedDivision(auth, 4);
      const [stage] = await createStages(auth, divisionId, {
        seq: 1, kind: "league", name: "League", config: {}, progression: null,
      });
      await generateStageFixtures(auth, stage!.id);
      await sql`update divisions set status = 'active' where id = ${divisionId}`;
      const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no`;
      // fixture 1: dated in the PAST, still 'scheduled' (no result) — this is
      // the stale candidate card-stats' own query would pick (earliest
      // scheduled_at, nulls last).
      await sql`update fixtures set scheduled_at = now() - interval '2 days' where id = ${rows[0]!.id}`;
      // fixture 2: dated genuinely in the FUTURE — the real answer. Rounded
      // to the whole second before the round trip: comparing a sub-second
      // JS timestamp against what a `timestamptz` column round-trips
      // through pg-to-JS conversion flaked here on the fractional part.
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      future.setMilliseconds(0);
      await sql`update fixtures set scheduled_at = ${future.toISOString()} where id = ${rows[1]!.id}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.next).not.toBeNull();
      expect(Date.parse(d.next!.scheduled_at!)).toBe(future.getTime());
      expect(d.attention).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: [rows[0]!.id] });
    });
    it("with ONLY a past-dated fixture, next is null and the masthead ladder does not claim a next date", async () => {
      const { auth } = await seedOrg();
      const { competitionId, divisionId } = await seedDivision(auth, 4);
      const [stage] = await createStages(auth, divisionId, {
        seq: 1, kind: "league", name: "League", config: {}, progression: null,
      });
      await generateStageFixtures(auth, stage!.id);
      await sql`update divisions set status = 'active' where id = ${divisionId}`;
      const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
      await sql`update fixtures set scheduled_at = now() - interval '2 days' where id = ${f!.id}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.next).toBeNull();
      expect(competitionPhase(desk).kind).not.toBe("next");
    });
    it("an in_play fixture is always next, even with a later dated fixture also present", async () => {
      const { auth } = await seedOrg();
      const { competitionId, divisionId } = await seedDivision(auth, 4);
      const [stage] = await createStages(auth, divisionId, {
        seq: 1, kind: "league", name: "League", config: {}, progression: null,
      });
      await generateStageFixtures(auth, stage!.id);
      await sql`update divisions set status = 'active' where id = ${divisionId}`;
      const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no`;
      await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '5 minutes' where id = ${rows[0]!.id}`;
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      await sql`update fixtures set scheduled_at = ${future.toISOString()} where id = ${rows[1]!.id}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.next?.in_play).toBe(true);
    });
  });

  it("regression #1: an all-decided league is finished, never 'nothing scheduled'", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    await sql`update fixtures set status = 'decided' where division_id = ${divisionId}`;
    await sql`update stages set status = 'complete' where id = ${stage!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("finished");
    expect(d.played).toBe(6);
    expect(d.attention.some((a) => a.kind === "unscheduled")).toBe(false);
  });

  it("an in_play fixture with no events raises no_scorer and lifts the competition to in_play", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("match_day");
    expect(d.in_play).toBe(1);
    expect(d.attention[0]).toMatchObject({ kind: "no_scorer", fixtureIds: [f!.id], count: 1 });
    expect(d.fixture_names[f!.id]?.fixture_no).toBe(1);
    expect(desk.in_play).toBe(1);
    expect(competitionPhase(desk)).toEqual({ kind: "in_play", n: 1 });
  });

  // F2 fix (final review, Important): the event-count subquery used to have
  // no fixture filter at all — a full Seq Scan + HashAggregate over the
  // WHOLE score_events table on every render. This proves the FUNCTIONAL
  // side of the fix stayed correct after filtering it down to this
  // competition's in_play fixture ids (the plan-shape side is proven by
  // EXPLAIN ANALYZE in fix-round-b-report.md, not reachable from vitest): an
  // in_play fixture that DOES have a recorded event must not raise no_scorer.
  // REWRITTEN by review 7's blocker. This test's "recorded event" WAS
  // `core.start` — the event that puts a fixture in play — so it asserted that
  // a live match with nothing recorded and nobody assigned must NOT ask for a
  // scorer. That is the defect itself, frozen as an expected value and carried
  // through the whole wave (recurring failure class 4, verbatim). It is the
  // pair now: a real recorded event clears the row, a bare kick-off does not.
  it("F2 regression: a REAL recorded event clears no_scorer — and a bare kick-off does not, because kicking off is not recording", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f!.id}`;
    // Kick-off only: the fixture is live and NOTHING has been recorded, which
    // is exactly what the row exists to say.
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${f!.id}, ${auth.orgId}, 0, 'core.start', '{}')`;
    const started = await getCompetitionDesk(auth, competitionId);
    expect(
      started.divisions.get(divisionId)!.attention.some((a) => a.kind === "no_scorer"),
      "a live match with only a kick-off, and nobody assigned, must ask for a scorer",
    ).toBe(true);

    // One real event, and the row clears — which is also what proves the
    // event-count query still counts anything at all after the filter.
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${f!.id}, ${auth.orgId}, 1, 'generic.result', '{"p1Score":1,"p2Score":0}')`;
    const scored = await getCompetitionDesk(auth, competitionId);
    expect(
      scored.divisions.get(divisionId)!.attention.some((a) => a.kind === "no_scorer"),
      "a recorded event clears the row",
    ).toBe(false);
  });

  // F3 fix (final review, Important): used to be one row PER FIXTURE.
  it("F3: several in_play fixtures with no scorer aggregate into ONE no_scorer row for the division", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 2`;
    for (const r of rows) {
      await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${r.id}`;
    }
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    const noScorerRows = d.attention.filter((a) => a.kind === "no_scorer");
    expect(noScorerRows).toHaveLength(1);
    expect(noScorerRows[0]).toMatchObject({ count: 2 });
  });

  // F4 fix (final review, Important): a scorer_assignment covering the
  // fixture or its division clears the row — and both scopes count.
  it("F4: a fixture-scoped scorer assignment suppresses no_scorer for that fixture, even at zero events", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f!.id}`;
    const userId = await makeUser("scorer");
    await createAssignment(auth.orgId, userId, { type: "fixture", id: f!.id }, null);
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.attention.some((a) => a.kind === "no_scorer")).toBe(false);
  });

  it("F4: a division-scoped scorer assignment ALSO suppresses no_scorer — assigning clears the row, not just the first score event", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f!.id}`;
    // Before the assignment: the row is up, same as the plain no_scorer test above.
    const before = await getCompetitionDesk(auth, competitionId);
    expect(before.divisions.get(divisionId)!.attention.some((a) => a.kind === "no_scorer")).toBe(true);
    const userId = await makeUser("scorer");
    await createAssignment(auth.orgId, userId, { type: "division", id: divisionId }, null);
    // After: cleared by the assignment alone — no score event was ever recorded.
    const after = await getCompetitionDesk(auth, competitionId);
    expect(after.divisions.get(divisionId)!.attention.some((a) => a.kind === "no_scorer")).toBe(false);
  });

  it("F4: an assignment on a DIFFERENT fixture/division does not suppress this one's no_scorer", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 2`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${rows[0]!.id}`;
    const userId = await makeUser("scorer");
    // Assigned to the OTHER fixture in the same division, not the in_play one.
    await createAssignment(auth.orgId, userId, { type: "fixture", id: rows[1]!.id }, null);
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.attention.some((a) => a.kind === "no_scorer")).toBe(true);
  });

  // Fix round 1, finding 1: DEFAULT_MATCH_MINUTES must come from
  // ScheduleConfig's own zod default (schemas.ts, 30), not a retyped
  // constant. This division has NO schedule_settings row at all, so
  // getCompetitionDesk falls all the way back to DEFAULT_MATCH_MINUTES — a
  // fixture scheduled 45 minutes ago clears a 30-minute match (result
  // overdue) but not a 60-minute one, so this witnesses the regression: it
  // passes with 30 and fails with 60.
  it("no schedule_settings row: a fixture 45 minutes past kickoff is result_missing under the schema's 30-minute default, not a 60-minute one", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'scheduled', scheduled_at = now() - interval '45 minutes' where id = ${f!.id}`;
    const [settingsRow] = await sql<{ division_id: string }[]>`select division_id from schedule_settings where division_id = ${divisionId}`;
    expect(settingsRow).toBeUndefined();
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.attention).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: [f!.id] });
  });

  // Final review, "the open question" (4th vacuous "Finished"): deleteStage
  // lets an organiser remove the sole, last, UNPLAYED stage of an already-
  // active division — proving the fix end to end through the real usecase,
  // not just the pure resolver (division-phase.test.ts's own unit coverage).
  it("stages.ts deleteStage: removing the last unplayed stage of an active division reads setting_up through getCompetitionDesk, never finished", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const before = await getCompetitionDesk(auth, competitionId);
    expect(before.divisions.get(divisionId)!.phase).not.toBe("finished"); // sanity: started, unplayed
    const { deleteStage } = await import("../stages");
    await deleteStage(auth, stage!.id);
    const after = await getCompetitionDesk(auth, competitionId);
    const d = after.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.total).toBe(0);
  });

  // H1 fix (final review round 3, Critical — corrected ruling): proves the
  // CALLER's own choice of zone, not just the pure resolver's behaviour
  // (division-phase.test.ts's unit coverage) — `getCompetitionDesk` used to
  // pass the bare org zone to `resolvePhase`'s bucketing `tz`, even though
  // `display_tz` (the value it ALREADY prints with) is the division's own
  // resolved venue zone. Live: a division with venue Asia/Kolkata inside an
  // org based in Europe/London read "Scheduled" on a fixture that was
  // genuinely dated TODAY at the venue. NOW and the fixture's `scheduled_at`
  // are two DIFFERENT instants (2026-09-02T20:00Z / 2026-09-02T23:30Z),
  // chosen so Kolkata (UTC+5:30) reads both as the SAME calendar day while
  // London (BST, UTC+1) reads them as DIFFERENT days — a same-zone case
  // cannot witness this, see division-phase.test.ts's sibling unit test.
  it("H1: match_day is bucketed in the division's own venue zone, not the org's", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`
      select org_id from competitions where id = ${competitionId}`;
    await sql`update organizations set timezone = 'Europe/London' where id = ${orgId}`;
    await sql`insert into schedule_settings (division_id, tz, config)
               values (${divisionId}, 'Asia/Kolkata', '{}'::jsonb)`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set scheduled_at = '2026-09-02T23:30:00Z' where id = ${f!.id}`;
    await sql`update fixtures set scheduled_at = null where division_id = ${divisionId} and id <> ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-02T20:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.display_tz).toBe("Asia/Kolkata");
    expect(d.phase).toBe("match_day");
  });

  // H2 fix (final review round 3, Important — corrected ruling): G3's gate
  // (`divisionStatus === "active"`) also excluded `scheduled` — exactly what
  // the ordinary Publish action sets (schedule.ts's `publishSchedule`). Live:
  // six fixtures dated YESTERDAY on a published, never-started division
  // produced NO "Needs you" section at all. Proven end to end through the
  // real usecase (not just division-phase.test.ts's pure resolver coverage):
  // a division that has been PUBLISHED (status 'scheduled') but never
  // started still raises `result_missing` for an overdue fixture.
  it("H2: a published-but-unstarted division (status 'scheduled') still raises result_missing for an overdue fixture", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "League", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    // Deliberately 'scheduled', never 'active' — the exact shape the ordinary
    // Publish action leaves a division in when the organiser never presses Start.
    await sql`update divisions set status = 'scheduled' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set scheduled_at = now() - interval '1 day' where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.attention).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: [f!.id] });
  });

  // ---------------------------------------------------------------------
  // Fix round G. K1 (Critical, instance NINE) and K3 (coverage).
  //
  // K3's finding: `needsProposal` — the predicate `needs_draw`, the "Needs
  // draw" pill, the "Compute proposal" action and resolvePhase's rule 4 ALL
  // reach production through — was untested at EVERY layer. Mutating it to
  // `false` left 137/137 green, because every multi-stage unit test builds
  // the same shape (stage 1 complete + `needsProposal: true`) by HAND, which
  // is the one case the guard already handles: no test ever derived the
  // field from a stage's own `progression`.
  //
  // These four seed a real two-stage division through the real usecases and
  // let `getCompetitionDesk` derive it, so the mutants die BOTH ways: to
  // `false` the setup-timing case loses its `needs_draw`, and to `true` the
  // on_complete cases lose their `needs_fixtures` and gain a `needs_draw`
  // pointing at a "Compute proposal" panel that is never rendered for them.
  describe("K1/K3: a later stage that has nothing to play", () => {
    /** League (seq 1, generated) + `Finals` (seq 2, no fixtures) carrying a
     *  real progression at the given timing — the shape an organiser gets
     *  from the wizard's "league then knockout" formats. */
    async function twoStages(timing: "setup" | "on_complete") {
      const { auth } = await seedOrg();
      const { competitionId, divisionId } = await seedDivision(auth, 4);
      const [league] = await createStages(auth, divisionId, {
        seq: 1, kind: "league", name: "League", config: {}, progression: null,
      });
      await generateStageFixtures(auth, league!.id);
      const [finals] = await createStages(auth, divisionId, {
        seq: 2, kind: "knockout", name: "Finals", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing,
        },
      });
      await sql`update divisions set status = 'active' where id = ${divisionId}`;
      // Every league fixture played, none live — the state the finding was
      // driven in. Deliberately leaves stage 1 'active': the organiser never
      // pressed "Complete stage", which is the whole point.
      await sql`update fixtures set status = 'decided' where division_id = ${divisionId}`;
      return { auth, competitionId, divisionId, leagueId: league!.id, finalsId: finals!.id };
    }

    it("K1: an unseeded on_complete stage blocks 'finished' and raises needs_fixtures naming it", async () => {
      const { auth, competitionId, divisionId } = await twoStages("on_complete");
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      // Print the asserted CONTENT beside the verdict: without these the row
      // could be "not finished" for entirely the wrong reason.
      expect(d.played).toBe(6);
      expect(d.total).toBe(6);
      expect(d.phase).not.toBe("finished");
      expect(d.phase).toBe("scheduled");
      expect(d.attention).toContainEqual({ kind: "needs_fixtures", stageName: "Finals" });
      // NOT needs_draw: an on_complete stage has no proposal to compute, and
      // the panel that action points at is never rendered for one.
      expect(d.attention.some((a) => a.kind === "needs_draw")).toBe(false);
      expect(d.needs_draw_stage).toBeNull();
      // K2: the masthead must not read "Setting up" over a row 6 of 6 played.
      expect(competitionPhase(desk)).toEqual({ kind: "scheduled" });
    });

    it("K1 sibling: the same with stage 1 COMPLETE — setting_up, still with the needs_fixtures row", async () => {
      const { auth, competitionId, divisionId, leagueId } = await twoStages("on_complete");
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.played).toBe(6);
      expect(d.phase).toBe("setting_up");
      expect(d.attention).toContainEqual({ kind: "needs_fixtures", stageName: "Finals" });
      // K2 again, on the shape whose row word IS "setting_up": the masthead
      // still must not agree with it, because 6 fixtures have been played.
      expect(competitionPhase(desk)).toEqual({ kind: "scheduled" });
    });

    /**
     * M1 (fix round I, Critical — INSTANCE TWELVE), the shape the sixth
     * review drove: the organiser never pressed "Complete stage", so the
     * league is still `active` while all six of its fixtures are terminal.
     * The desk used to show red "Needs draw · Compute proposal" here and the
     * landing `?tab=fixtures` had ZERO compute-proposal controls (counted
     * live at 11:33Z on 2026-09-03; control run with the league complete: 1).
     */
    it("M1: a setup-timing stage whose source is NOT complete asks for FIXTURES, never a draw", async () => {
      const { auth, competitionId, divisionId } = await twoStages("setup");
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention.some((a) => a.kind === "needs_draw")).toBe(false);
      expect(d.needs_draw_stage).toBeNull();
      expect(d.attention).toContainEqual({ kind: "needs_fixtures", stageName: "Finals" });
    });

    /**
     * M1, the other half — and the shape the sixth review used as its
     * healthy CONTROL, which was ALSO wrong. With the league complete but
     * the finals bracket never generated, the panel DOES render a "Compute
     * proposal" button, and clicking it (live, 11:39Z on 2026-09-03) returns
     * the panel's error banner: `computeSeedProposal` 422s
     * SEEDING_RULES_MISSING — "this stage has no generated TBD fixtures yet
     * — generate its fixtures first". Presence was never the question, so
     * this row must be `needs_fixtures` too, whose "Generate fixtures" door
     * is on that same screen and works.
     */
    it("M1 control: a complete source is NOT enough — with no TBD bracket the compute door 422s, so it is still needs_fixtures", async () => {
      const { auth, competitionId, divisionId, leagueId } = await twoStages("setup");
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention.some((a) => a.kind === "needs_draw")).toBe(false);
      expect(d.attention).toContainEqual({ kind: "needs_fixtures", stageName: "Finals" });
    });

    it("K3/M1: needs_draw once the bracket IS generated and its source complete — the only state where the panel's door works", async () => {
      const { auth, competitionId, divisionId, leagueId, finalsId } = await twoStages("setup");
      // The order the API itself demands: generate the TBD bracket FIRST
      // (computeSeedProposal resolves the proposal against those very
      // fixtures), then complete the source.
      await generateStageFixtures(auth, finalsId);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention).toContainEqual({ kind: "needs_draw", stageName: "Finals", door: "compute" });
      expect(d.needs_draw_stage).toEqual({ name: "Finals" });
      expect(d.attention.some((a) => a.kind === "needs_fixtures")).toBe(false);
    });

    it("K3/M1: the action names the panel's OWN door — a draft proposal makes it 'confirm', not 'compute'", async () => {
      const { auth, competitionId, divisionId, leagueId, finalsId } = await twoStages("setup");
      await generateStageFixtures(auth, finalsId);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status)
                select org_id, ${finalsId}, '{}'::jsonb, 'draft' from stages where id = ${finalsId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention).toContainEqual({ kind: "needs_draw", stageName: "Finals", door: "confirm" });
    });

    it("K3/M1: a STALE proposal makes the action point at the panel's 'recompute' door", async () => {
      const { auth, competitionId, divisionId, leagueId, finalsId } = await twoStages("setup");
      await generateStageFixtures(auth, finalsId);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      // Reachable in production: confirmSeedProposal re-derives the
      // standings hash and marks the row stale (stages.ts:2956) when the
      // source standings moved under a draft, and the dependent-stage sweep
      // (stages.ts:3143) does the same. The panel then renders "Recompute".
      await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status)
                select org_id, ${finalsId}, '{}'::jsonb, 'stale' from stages where id = ${finalsId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention).toContainEqual({ kind: "needs_draw", stageName: "Finals", door: "recompute" });
    });

    it("K3/M1: a CONFIRMED draw is not owed at all — the panel shows no button, so the row is gone", async () => {
      const { auth, competitionId, divisionId, leagueId, finalsId } = await twoStages("setup");
      await generateStageFixtures(auth, finalsId);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      // Confirming FILLS the slots; that, not the proposal row, is what the
      // desk reads — so seed the fill the way a confirm would.
      await sql`update fixtures set home_entrant_id = (select id from entrants where division_id = ${divisionId} limit 1),
                                    away_entrant_id = (select id from entrants where division_id = ${divisionId} offset 1 limit 1)
                 where stage_id = ${finalsId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention.some((a) => a.kind === "needs_draw")).toBe(false);
      expect(d.needs_draw_stage).toBeNull();
    });

    it("K3 contrast: 'on_complete' at the same position owes NO draw — the two timings must not collapse", async () => {
      const { auth, competitionId, divisionId, leagueId } = await twoStages("on_complete");
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const desk = await getCompetitionDesk(auth, competitionId);
      const d = desk.divisions.get(divisionId)!;
      expect(d.attention.some((a) => a.kind === "needs_draw")).toBe(false);
      expect(d.needs_draw_stage).toBeNull();
    });
  });
});
