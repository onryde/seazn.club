// Integration tests for PROMPT-22 (Jul3/02): officials CRUD, auto → apply,
// manual set/lock, hide-names public read, entitlement gates. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { sql } from "@/lib/db";
import { LIVE_STATUSES, MAX_EXPIRY_MS, type OutboxStatus } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  createOfficial,
  listOfficials,
  importOfficials,
  autoAssignOfficials,
  applyOfficialAssignments,
  patchFixtureOfficials,
} from "../officials";
import { acceptedOfficialCovers, fixtureScope } from "../scorers";
import { orgMarksSummary, putMark } from "../official-marks";
import { createCourt, createVenue } from "../venues";
import { makeUser as makeSeedUser, seedOrg as seedSeedOrg, seedFutureDivision } from "./_seed";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";

// The assignment notice is RENDERED by `officialAssignedEmail` and queued on the email outbox (phase 3 wave 4, kind
// `official_assigned`) in the transaction that commits the assignment. The builder is WRAPPED, never replaced: the real
// render runs, and the spy records what the notice was built from (each fixture's label, venue and court, and the
// language) by the time the producer resolves. vi.hoisted for the same reason officials-ai-route.test.ts uses it: the
// vi.mock factory below hoists above this const otherwise. The rest of the module is the real one (importOriginal).
const mail = vi.hoisted(() => ({ assigned: vi.fn<typeof import("@/lib/email").officialAssignedEmail>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.assigned.mockImplementation(actual.officialAssignedEmail);
  return { ...actual, officialAssignedEmail: mail.assigned };
});
// The outbox's one network seam: captured, never sent. The row, the seal, the gate and the attempt are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" | "enterprise" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Off " + suffix}, ${"off-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
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

// competition + division + 4 entrants + league fixtures, all scheduled on one
// court in 30-minute slots.
async function seedScheduledDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Officials Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    // full config override: the shared test DB's variant row may be a stale
    // partial — don't depend on it
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const t0 = Date.UTC(2026, 6, 10, 9, 0, 0);
  // P9: court_id, not the frozen court_label — engineInput() (officials.ts)
  // reads court_id for block-stay/sort grouping now, so a real court row is
  // what makes "all scheduled on one court" (this helper's own header
  // comment) still true post-cutover.
  const venue = await createVenue(auth, { name: "Officials Venue", sort: 0 });
  const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_id = ${court.id}
      where id = ${fixtures[i]!.id}`;
  }
  return { comp, division, stage: stage!, fixtures, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("officials assignment (Jul3/02)", () => {
  it("auto-proposes, applies, caches, and ledgers the assignment", async () => {
    // officials.auto is a Pro Plus feature since V290 (hard move, no grandfather)
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    await createOfficial(auth, {
      display_name: "Ref One",
      role_keys: ["referee"],
    });
    await createOfficial(auth, {
      display_name: "Ref Two",
      role_keys: ["referee"],
    });

    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"],
        poolLock: false,
        blockStay: true,
        fairness: "tournament",
        teamRefKeepDivision: false,
        restMinMinutes: 0,
        blockGapMinutes: 30,
      },
      rng_seed: "t",
    });
    expect(proposal.assignments).toHaveLength(fixtures.length);
    expect(proposal.conflicts.filter((c) => c.severity === "block")).toEqual([]);

    const officials = await listOfficials(auth);
    const idByName = new Map(officials.map((o) => [o.display_name, o.id]));
    const { applied } = await applyOfficialAssignments(auth, division.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixtureId,
        official_id: a.officialId,
        role_key: a.roleKey,
        locked: false,
      })),
    });
    expect(applied).toBe(fixtures.length);
    expect(idByName.size).toBe(2);

    // read cache + ledger + chain
    const [cached] = await sql<{ officials: { name: string; role: string }[] }[]>`
      select officials from fixtures where id = ${fixtures[0]!.id}`;
    expect(cached!.officials).toHaveLength(1);
    expect(cached!.officials[0]).toMatchObject({ role: "referee" });
    const [ev] = await sql<{ type: string; broken: string | null }[]>`
      select type, verify_division_events_chain(division_id)::text as broken
      from division_events
      where division_id = ${division.id} and type = 'officials_assigned'`;
    expect(ev).toMatchObject({ type: "officials_assigned", broken: null });
  });

  // Task 10 (v4/03 §10): an AI-sourced apply stamps its provenance (trimmed
  // instruction) into the officials_assigned event; a plain apply carries none.
  it("stamps the ai block into officials_assigned when present, omits it otherwise", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    await createOfficial(auth, {
      display_name: "Ref One",
      role_keys: ["referee"],
    });
    await createOfficial(auth, {
      display_name: "Ref Two",
      role_keys: ["referee"],
    });
    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"],
        poolLock: false,
        blockStay: true,
        fairness: "tournament",
        teamRefKeepDivision: false,
        restMinMinutes: 0,
        blockGapMinutes: 30,
      },
      rng_seed: "t",
    });
    const assignments = proposal.assignments.map((a) => ({
      fixture_id: a.fixtureId,
      official_id: a.officialId,
      role_key: a.roleKey,
      locked: false,
    }));

    // With an ai block → trimmed instruction lands in the latest event payload.
    await applyOfficialAssignments(auth, division.id, {
      assignments,
      ai: {
        instruction: "  cover every fixture  ",
        summary: "assigned refs",
        model: "claude-o",
        repair_rounds: 1,
      },
    });
    const [withAi] = await sql<
      {
        payload: {
          applied: number;
          ai?: {
            instruction: string;
            summary: string;
            model: string;
            repair_rounds: number;
          };
        };
      }[]
    >`
      select payload from division_events
      where division_id = ${division.id} and type = 'officials_assigned'
      order by seq desc limit 1`;
    expect(withAi.payload.ai?.instruction).toBe("cover every fixture");
    expect(withAi.payload.ai?.summary).toBe("assigned refs");
    expect(withAi.payload.ai?.model).toBe("claude-o");
    expect(withAi.payload.ai?.repair_rounds).toBe(1);
    expect(fixtures.length).toBeGreaterThan(0);

    // Without an ai block → the event payload has no ai key at all.
    await applyOfficialAssignments(auth, division.id, { assignments });
    const [noAi] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events
      where division_id = ${division.id} and type = 'officials_assigned'
      order by seq desc limit 1`;
    expect("ai" in noAi.payload).toBe(false);
  });

  it("team-as-referee is never assigned to its own fixture", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures, entrants } = await seedScheduledDivision(auth);
    // one team-ref official belonging to entrant A — plays in 3 of 6 fixtures
    await createOfficial(auth, {
      display_name: "Team A (ref)",
      role_keys: ["referee"],
      entrant_id: entrants[0]!.id,
    });
    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"],
        poolLock: false,
        blockStay: false,
        fairness: "tournament",
        teamRefKeepDivision: false,
        restMinMinutes: 0,
        blockGapMinutes: 30,
      },
      rng_seed: "t",
    });
    const aFixtures = new Set(
      fixtures
        .filter(
          (f: { home_entrant_id: string | null; away_entrant_id: string | null }) =>
            f.home_entrant_id === entrants[0]!.id || f.away_entrant_id === entrants[0]!.id,
        )
        .map((f: { id: string }) => f.id),
    );
    for (const a of proposal.assignments) {
      expect(aFixtures.has(a.fixtureId)).toBe(false);
    }
  });

  it("maxPerDay caps on the ORG's calendar day, not the UTC day (#448)", async () => {
    const { auth } = await seedOrg("pro");
    // An org west of Greenwich: a Saturday evening there is already Sunday UTC.
    await sql`
      update organizations set timezone = 'America/Los_Angeles' where id = ${auth.orgId}`;
    const { division, fixtures } = await seedScheduledDivision(auth);

    // Four fixtures on ONE local Saturday (2026-07-11 PDT, UTC-7):
    // 10:00 and 12:00 are still Saturday UTC; 18:00 and 20:00 are Sunday UTC.
    const local = ["17:00", "19:00", "01:00", "03:00"]; // the same times in UTC
    const utcDay = ["11", "11", "12", "12"];
    const picked = fixtures.slice(0, 4) as { id: string }[];
    expect(picked).toHaveLength(4);
    for (const [i, f] of picked.entries()) {
      await sql`
        update fixtures
        set scheduled_at = ${`2026-07-${utcDay[i]}T${local[i]}:00.000Z`}, court_label = 'Court 1'
        where id = ${f.id}`;
    }
    // Park the rest well clear so they cannot compete for the capped official.
    for (const [i, f] of (fixtures.slice(4) as { id: string }[]).entries()) {
      await sql`
        update fixtures set scheduled_at = ${`2026-09-${String(i + 1).padStart(2, "0")}T18:00:00.000Z`}
        where id = ${f.id}`;
    }

    await createOfficial(auth, {
      display_name: "Capped Ref",
      role_keys: ["referee"],
      max_per_day: 2,
    });

    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"],
        poolLock: false,
        blockStay: false,
        fairness: "tournament",
        teamRefKeepDivision: false,
        restMinMinutes: 0,
        blockGapMinutes: 30,
      },
      rng_seed: "t",
    });

    const pickedIds = new Set(picked.map((f) => f.id));
    const onLocalSaturday = proposal.assignments.filter((a) => pickedIds.has(a.fixtureId));
    // Bucketing on UTC sees 2 + 2 and fills all four; the org's calendar day
    // allows only 2, leaving the other two slots unfilled.
    expect(onLocalSaturday).toHaveLength(2);
    expect(
      proposal.conflicts.filter((c) => c.kind === "role_unfilled" && pickedIds.has(c.fixtureId!)),
    ).toHaveLength(2);
  });

  it("locked assignments survive apply; re-apply keeps them", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, {
      display_name: "Pinned",
      role_keys: ["referee"],
    });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: true }],
    });
    await applyOfficialAssignments(auth, division.id, { assignments: [] });
    const [row] = await sql<{ locked: boolean }[]>`
      select locked from fixture_officials where fixture_id = ${fixtures[0]!.id}`;
    expect(row).toMatchObject({ locked: true });
  });

  it("hide-names strips officials from the public read (25 Jun)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, {
      display_name: "Secret Ref",
      role_keys: ["referee"],
    });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: false }],
    });
    // publish so timetable fields (and officials) are public at all
    await sql`update divisions set status = 'scheduled' where id = ${division.id}`;
    const before = await sql<{ officials: unknown[] }[]>`
      select officials from public_fixtures_v where id = ${fixtures[0]!.id}`;
    expect(before[0]!.officials).toHaveLength(1);

    await patchDivision(auth, division.id, { officials_hide_names: true });
    const after = await sql<{ officials: unknown[] }[]>`
      select officials from public_fixtures_v where id = ${fixtures[0]!.id}`;
    expect(after[0]!.officials).toEqual([]);
  });

  it("Community: manual single- and multi-role free (V319); auto still 402", async () => {
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, {
      display_name: "Solo",
      role_keys: ["referee"],
    });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: false }],
    });

    // multi-role officials are free on every plan since V319 (#253).
    const multi = await createOfficial(auth, {
      display_name: "Multi",
      role_keys: ["referee", "judge"],
    });
    expect(multi.role_keys).toEqual(["referee", "judge"]);

    // officials.auto (the AI Officials path) STAYS gated.
    await expect(
      autoAssignOfficials(auth, division.id, {
        policy: {
          roles: ["referee"],
          poolLock: false,
          blockStay: false,
          fairness: "tournament",
          teamRefKeepDivision: false,
          restMinMinutes: 0,
          blockGapMinutes: 30,
        },
        rng_seed: "t",
      }),
    ).rejects.toMatchObject({ featureKey: "officials.auto" });
  });

  it("Community: multiple officials per fixture are free (V319, #253)", async () => {
    const { auth } = await seedOrg("community");
    const { fixtures } = await seedScheduledDivision(auth);
    const refA = await createOfficial(auth, {
      display_name: "Ref A",
      role_keys: ["referee"],
    });
    const refB = await createOfficial(auth, {
      display_name: "Ref B",
      role_keys: ["referee"],
    });

    // two officials, same role, on a Community org — no per_fixture.max cap.
    const { officials } = await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [
        { official_id: refA.id, role_key: "referee", locked: false },
        { official_id: refB.id, role_key: "referee", locked: false },
      ],
    });
    expect(officials).toHaveLength(2);
  });

  // Regression guard (#253): a Community org can create a multi-role official,
  // assign a 2nd official to one fixture, and record a mark — all with no 402.
  it("Community regression: multi-role, 2nd official, and marks all free (#253)", async () => {
    const { auth } = await seedOrg("community");
    const { fixtures } = await seedScheduledDivision(auth);

    const multi = await createOfficial(auth, {
      display_name: "Multi",
      role_keys: ["referee", "judge"],
    });
    expect(multi.role_keys).toEqual(["referee", "judge"]);
    const refB = await createOfficial(auth, {
      display_name: "Ref B",
      role_keys: ["umpire"],
    });

    // two officials, two roles, one fixture (exercises the ex-roles_multi and
    // ex-per_fixture.max patch gates).
    const { officials } = await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [
        { official_id: multi.id, role_key: "referee", locked: false },
        { official_id: refB.id, role_key: "umpire", locked: false },
      ],
    });
    expect(officials).toHaveLength(2);

    // record a mark — needs an accepted, decided assignment.
    const [fo] = await sql<{ id: string }[]>`
      select id from fixture_officials
      where fixture_id = ${fixtures[0]!.id} and official_id = ${multi.id} limit 1`;
    await sql`update fixture_officials set response = 'accepted' where id = ${fo!.id}`;
    await sql`update fixtures set status = 'decided' where id = ${fixtures[0]!.id}`;
    await putMark(auth, fo!.id, { mark: 5, comment: "great" });
    expect(await orgMarksSummary(auth, multi.id)).toMatchObject({ average: 5, count: 1 });
  });

  it("bulk officials import is idempotent on display name", async () => {
    const { auth } = await seedOrg();
    const csv = "Name,Roles,MaxPerDay\nUma Umpire,referee,4\nJay Judge,referee judge,\n";
    const first = await importOfficials(auth, "officials.csv", "text/csv", Buffer.from(csv));
    expect(first).toEqual({ created: 2, skipped: 0 });
    const again = await importOfficials(auth, "officials.csv", "text/csv", Buffer.from(csv));
    expect(again).toEqual({ created: 0, skipped: 2 });
    const officials = await listOfficials(auth);
    expect(officials.find((o) => o.display_name === "Jay Judge")?.role_keys).toEqual([
      "referee",
      "judge",
    ]);
  });
});

describe.skipIf(!HAS_DB)("non-member official fixture access rule", () => {
  it("accepted official (no org_members row) covers only their fixture, in-org", async () => {
    const { auth } = await seedSeedOrg("pro");
    const { fixtures } = await seedFutureDivision(auth);
    const fixtureId = fixtures[0]!.id;
    const user = await makeSeedUser("Ref Three"); // deliberately NOT inserted into org_members
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref Three', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref Three', ${sql.json(["umpire"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'umpire', 'accepted')`;

    const members = await sql`select 1 from org_members where user_id = ${user.id}`;
    expect(members.length).toBe(0); // still a non-member — Option 2

    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(true);
    const scope = await fixtureScope(fixtureId);
    expect(scope?.org_id).toBe(auth.orgId);
  });
});

// P9 sweep (pass 3c-4): the assignment notice (officials.ts, now queueAssignedNotices) used to SELECT
// f.venue/f.court_label straight into the assignment-notice email — both
// frozen since pass 3a, so a fixture assigned an official after the cutover
// emailed a blank "where" line regardless of its real venue_id/court_id.
describe.skipIf(!HAS_DB)("P9: assignment-notice email carries the live venue/court name", () => {
  it("uses the resolved venue/court name, not a disagreeing frozen venue/court_label", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedScheduledDivision(auth);
    const venue = await createVenue(auth, { name: "Live Notice Venue", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Live Notice Court", sort: 0, tags: [] });
    // seedScheduledDivision already pointed fixtures[0] at its own court_id —
    // repoint venue_id/court_id here to a venue/court whose NAME disagrees
    // with a hand-poisoned, stale venue/court_label, so a read that fell
    // back to the frozen columns would show the wrong text, not just blank.
    await sql`
      update fixtures set venue_id = ${venue.id}, court_id = ${court.id},
                          venue = 'Stale Venue', court_label = 'Stale Court'
      where id = ${fixtures[0]!.id}`;
    const email = `ref-${randomUUID().slice(0, 8)}@example.com`;
    const official = await createOfficial(auth, {
      display_name: "Notice Ref",
      role_keys: ["referee"],
      email,
    });
    mail.assigned.mockClear();

    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });

    const call = mail.assigned.mock.calls.find((c) => c[0].officialName === "Notice Ref");
    expect(call, "the assignment notice was never built for this official").toBeTruthy();
    const args = call![0];
    expect(args.fixtures).toHaveLength(1);
    expect(args.fixtures[0]!.venue).toBe("Live Notice Venue");
    expect(args.fixtures[0]!.court_label).toBe("Live Notice Court");
    expect(args.fixtures[0]!.venue).not.toBe("Stale Venue");
    expect(args.fixtures[0]!.court_label).not.toBe("Stale Court");
  });
});

// F5/Task 9: the assignment notice (officials.ts, now queueAssignedNotices) used to build its "X vs Y"
// label from `fx?.home_name ?? "TBD"` — a bare literal, never selecting
// home_slot_label/away_slot_label. An official can be pre-assigned to a
// court/time slot before the bracket resolves entrants, so the digest must
// resolve the SAME slot label every other surface already shows for it.
describe.skipIf(!HAS_DB)("F5/Task 9: assignment digest resolves slot labels, not bare TBD", () => {
  it("uses the resolved slot label for a day-one fixture with unresolved entrants", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedScheduledDivision(auth);
    const fixtureId = fixtures[0]!.id;
    // Day-one placeholder: null entrant ids with a real home_slot_label
    // (the shape stage-seeding.ts's descriptorLabel() actually produces),
    // away deliberately left null so its fallback to schedule.tbd stays
    // visible in the assertion and this test doesn't false-positive on a
    // whole-row check.
    await sql`
      update fixtures
      set home_entrant_id = null, away_entrant_id = null,
          home_slot_label = ${sql.json({ key: "bracket.round.roundOf", params: { n: 4 } })},
          away_slot_label = null
      where id = ${fixtureId}`;
    const email = `slot-label-${randomUUID().slice(0, 8)}@example.com`;
    const official = await createOfficial(auth, {
      display_name: "Slot Label Ref",
      role_keys: ["referee"],
      email,
    });
    mail.assigned.mockClear();

    await patchFixtureOfficials(auth, fixtureId, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });

    const call = mail.assigned.mock.calls.find((c) => c[0].officialName === "Slot Label Ref");
    expect(call, "the assignment notice was never built for this official").toBeTruthy();
    const args = call![0];
    expect(args.fixtures).toHaveLength(1);
    expect(args.fixtures[0]!.label).toBe("Round of 4 vs TBD");
    expect(args.fixtures[0]!.label).not.toBe("TBD vs TBD");
  });
});

// Phase 3 wave 4 (T2, kind `official_assigned`): the assignment notice is a row on the email outbox, written in the
// transaction that commits the assignment (R1), one row per official who has an address and NEWLY got a fixture (R6:
// the carry-over diff, so a re-apply or a re-set that keeps an official notifies nobody), and the request makes the
// first attempt after commit (R5). The ref names the assignment: the auto apply's ledger entry
// (`division_event / <division>:<seq>:<official>`) or the manual set's fixture (`fixture_official / <fixture>:<official>`),
// with the official in it so two officials sharing one address in one apply do not supersede each other. The language
// is the official's (F5, D4): a claimed official's account, then the org's default, then `en`; the fixture labels are
// built in that same language. Expected subjects come from the emails dictionary on disk (`dictionarySubject`) and the
// join word from the ui dictionaries by import, never from the code under test.
//
// Not built (owner rule 2026-10-26, mainstream only): a rollback witnessed by a failing statement after the enqueue
// (`plantFailingUpdate` does not exist); the row shares the producer's transaction by construction.
// Sport: not applicable (the notice does not vary by sport).
describe.skipIf(!HAS_DB)("the assignment notice goes through the email outbox (official_assigned)", () => {
  type NoticeRow = {
    id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
    recipient_user_id: string | null; transactional: boolean; subject: string; status: OutboxStatus;
    created_at: Date; expires_at: Date;
  };
  /** Every assignment notice this organisation queued, oldest first. */
  const noticesOf = (orgId: string) =>
    sql<NoticeRow[]>`
      select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status, created_at, expires_at
        from email_outbox where kind = 'official_assigned' and org_id = ${orgId}
       order by created_at, id`;
  /** The notices once the request's own first attempt (a deferred `dispatchNow`) is over: none left queued or sending. */
  const settledNoticesOf = async (orgId: string) => {
    await vi.waitFor(
      async () => {
        const rows = await noticesOf(orgId);
        expect(rows.filter((r) => r.status === "queued" || r.status === "sending"), "the request's first attempt is over").toEqual([]);
      },
      { timeout: 15_000, interval: 100 },
    );
    return noticesOf(orgId);
  };
  const orgName = async (orgId: string) =>
    (await sql<{ name: string }[]>`select name from organizations where id = ${orgId}`)[0]!.name;
  const lastAssignedSeq = async (divisionId: string) =>
    (
      await sql<{ seq: number }[]>`
        select seq from division_events where division_id = ${divisionId} and type = 'officials_assigned'
         order by seq desc limit 1`
    )[0]!.seq;
  const address = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.com`;
  const assign = (fixtureId: string, officialId: string) => ({ fixture_id: fixtureId, official_id: officialId, role_key: "referee", locked: false });

  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
    mail.assigned.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("an apply queues one notice per official with an email, listing that official's new fixtures", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const email = address("assigned");
    const mailed = await createOfficial(auth, { display_name: "Mailed Ref", role_keys: ["referee"], email });
    const unmailed = await createOfficial(auth, { display_name: "Unmailed Ref", role_keys: ["referee"] });

    await applyOfficialAssignments(auth, division.id, {
      assignments: [assign(fixtures[0]!.id, mailed.id), assign(fixtures[1]!.id, mailed.id), assign(fixtures[2]!.id, unmailed.id)],
    });

    const rows = await settledNoticesOf(auth.orgId);
    expect(rows, "one row: the official with an address; none for the one without").toHaveLength(1);
    const seq = await lastAssignedSeq(division.id);
    expect(rows[0]).toMatchObject({
      kind: "official_assigned",
      ref_type: "division_event",
      ref_id: `${division.id}:${seq}:${mailed.id}`,
      recipient: email,
      recipient_user_id: null,
      transactional: true,
      org_id: auth.orgId,
      subject: dictionarySubject("en", "officialAssigned.subject", { orgName: await orgName(auth.orgId) }),
      // R5: the request made the first attempt after commit (the worker never runs here).
      status: "sent",
    });
    // The bound, not the fixture's start (P-W4-3): an assignment made after the match must still reach the official.
    expect(Math.abs(rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime() - MAX_EXPIRY_MS)).toBeLessThan(1_000);
    expect(transport.deliver.mock.calls.map((c) => (c[0] as { to: string }).to), "one send, to the official").toEqual([email]);
    expect(mail.assigned.mock.calls, "built once, for the official with an address").toHaveLength(1);
    expect(mail.assigned.mock.calls[0]![0].officialName).toBe("Mailed Ref");
    expect(mail.assigned.mock.calls[0]![0].fixtures, "listing that official's two new fixtures, not the third").toHaveLength(2);
  });

  it("re-applying the same assignments queues nothing new", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const official = await createOfficial(auth, { display_name: "Steady Ref", role_keys: ["referee"], email: address("steady") });
    const input = { assignments: [assign(fixtures[0]!.id, official.id)] };

    await applyOfficialAssignments(auth, division.id, input);
    expect(await settledNoticesOf(auth.orgId), "premise: the first apply queued its notice").toHaveLength(1);
    await applyOfficialAssignments(auth, division.id, input);

    expect(await settledNoticesOf(auth.orgId), "the second apply carried the assignment over: no new row").toHaveLength(1);
    expect(mail.assigned.mock.calls, "and built nothing").toHaveLength(1);
  });

  it("two applies that each add a fixture give two notices", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const official = await createOfficial(auth, { display_name: "Growing Ref", role_keys: ["referee"], email: address("growing") });

    await applyOfficialAssignments(auth, division.id, { assignments: [assign(fixtures[0]!.id, official.id)] });
    const first = await lastAssignedSeq(division.id);
    await applyOfficialAssignments(auth, division.id, {
      assignments: [assign(fixtures[0]!.id, official.id), assign(fixtures[1]!.id, official.id)],
    });
    const second = await lastAssignedSeq(division.id);

    const rows = await settledNoticesOf(auth.orgId);
    expect(rows.map((r) => r.ref_id), "one per apply, each naming its own ledger entry").toEqual([
      `${division.id}:${first}:${official.id}`,
      `${division.id}:${second}:${official.id}`,
    ]);
    for (const r of rows) expect(LIVE_STATUSES, `${r.ref_id} is live, not replaced`).toContain(r.status);
    expect(mail.assigned.mock.calls.map((c) => c[0].fixtures.length), "the second lists only the fixture it added").toEqual([1, 1]);
  });

  it("a manual set notifies the newly set official, a re-set keeping them does not, and a re-set adding another notifies only the newcomer", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedScheduledDivision(auth);
    const email = address("manual");
    const official = await createOfficial(auth, { display_name: "Manual Ref", role_keys: ["referee"], email });
    const set = { set: [{ official_id: official.id, role_key: "referee", locked: false }] };

    await patchFixtureOfficials(auth, fixtures[0]!.id, set);
    const rows = await settledNoticesOf(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ref_type: "fixture_official",
      ref_id: `${fixtures[0]!.id}:${official.id}`,
      recipient: email,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
    });

    await patchFixtureOfficials(auth, fixtures[0]!.id, set);
    expect(await settledNoticesOf(auth.orgId), "the re-set kept the official: no new row").toHaveLength(1);
    expect(mail.assigned.mock.calls).toHaveLength(1);

    // The other direction (class 13): a re-set that KEEPS A and ADDS B tells B, and only B.
    const newcomerEmail = address("newcomer");
    const newcomer = await createOfficial(auth, { display_name: "Newcomer Ref", role_keys: ["referee"], email: newcomerEmail });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [...set.set, { official_id: newcomer.id, role_key: "referee", locked: false }],
    });
    const after = await settledNoticesOf(auth.orgId);
    expect(after.map((r) => [r.recipient, r.ref_id, r.status]), "one new row, to the newcomer; A's first row untouched").toEqual([
      [email, `${fixtures[0]!.id}:${official.id}`, "sent"],
      [newcomerEmail, `${fixtures[0]!.id}:${newcomer.id}`, "sent"],
    ]);
    expect(mail.assigned.mock.calls.map((c) => c[0].officialName), "built once more, for the newcomer only").toEqual(["Manual Ref", "Newcomer Ref"]);
  });

  it("an apply that repeats a locked assignment does not notify it again, and still notifies a new one in the same apply", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const lockedEmail = address("locked");
    const locked = await createOfficial(auth, { display_name: "Locked Ref", role_keys: ["referee"], email: lockedEmail });
    const freshEmail = address("fresh");
    const added = await createOfficial(auth, { display_name: "Fresh Ref", role_keys: ["referee"], email: freshEmail });
    // A locked assignment survives an apply (the apply replaces only unlocked rows). Its own notice is the manual set's.
    await patchFixtureOfficials(auth, fixtures[0]!.id, { set: [{ official_id: locked.id, role_key: "referee", locked: true }] });
    expect((await settledNoticesOf(auth.orgId)).map((r) => r.recipient), "premise: the lock's own notice").toEqual([lockedEmail]);
    mail.assigned.mockClear();

    // The AI console and the API can echo a locked row back in an apply: the insert writes nothing for it.
    await applyOfficialAssignments(auth, division.id, {
      assignments: [assign(fixtures[0]!.id, locked.id), assign(fixtures[1]!.id, added.id)],
    });

    const seq = await lastAssignedSeq(division.id);
    const rows = await settledNoticesOf(auth.orgId);
    expect(rows.map((r) => [r.recipient, r.ref_type]), "nothing new for the locked official; one row for the new one").toEqual([
      [lockedEmail, "fixture_official"],
      [freshEmail, "division_event"],
    ]);
    expect(rows[1]!.ref_id).toBe(`${division.id}:${seq}:${added.id}`);
    expect(mail.assigned.mock.calls.map((c) => [c[0].officialName, c[0].fixtures.length])).toEqual([["Fresh Ref", 1]]);
  });

  it("empty: an official with no email gets no row, and the assignment stands", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedScheduledDivision(auth);
    const official = await createOfficial(auth, { display_name: "Silent Ref", role_keys: ["referee"] });

    const { officials } = await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });

    expect(await noticesOf(auth.orgId)).toEqual([]);
    expect(mail.assigned.mock.calls).toEqual([]);
    expect(officials, "the assignment stands").toEqual([expect.objectContaining({ official_id: official.id, role: "referee" })]);
    const stored = await sql`select 1 from fixture_officials where fixture_id = ${fixtures[0]!.id} and official_id = ${official.id}`;
    expect(stored).toHaveLength(1);
  });

  it("F5: an official's labels and email share the official's language", async () => {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const { fixtures } = await seedScheduledDivision(auth);
    // A: claimed, the account's language is Dutch. B: unclaimed, so the org's French.
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${address("claimed-account")}, 'Claimed Ref', true, 'nl') returning id`;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${auth.orgId}, 'Claimed Ref', ${user!.id}) returning id`;
    const claimedEmail = address("claimed");
    const [claimed] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys, email)
      values (${auth.orgId}, ${person!.id}, 'Claimed Ref', ${sql.json(["referee"])}, ${claimedEmail}) returning id`;
    const unclaimedEmail = address("unclaimed");
    const unclaimed = await createOfficial(auth, { display_name: "Unclaimed Ref", role_keys: ["referee"], email: unclaimedEmail });

    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [
        { official_id: claimed!.id, role_key: "referee", locked: false },
        { official_id: unclaimed.id, role_key: "referee", locked: false },
      ],
    });

    const [names] = await sql<{ home: string; away: string }[]>`
      select h.display_name as home, a.display_name as away
        from fixtures f join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
       where f.id = ${fixtures[0]!.id}`;
    // Premise: the two languages' join words differ, so a label in the wrong one is seen.
    expect(nlUi["schedule.vs"]).not.toBe(frUi["schedule.vs"]);
    const name = await orgName(auth.orgId);
    expect(dictionarySubject("nl", "officialAssigned.subject", { orgName: name })).not.toBe(
      dictionarySubject("fr", "officialAssigned.subject", { orgName: name }),
    );

    const rows = await settledNoticesOf(auth.orgId);
    const subjectOf = (to: string) => rows.find((r) => r.recipient === to)?.subject;
    expect(subjectOf(claimedEmail), "A: the account's Dutch").toBe(dictionarySubject("nl", "officialAssigned.subject", { orgName: name }));
    expect(subjectOf(unclaimedEmail), "B: the org's French").toBe(dictionarySubject("fr", "officialAssigned.subject", { orgName: name }));
    expect(rows.map((r) => r.recipient_user_id), "a literal address, claimed or not").toEqual([null, null]);

    const built = (official: string) => mail.assigned.mock.calls.find((c) => c[0].officialName === official);
    expect(built("Claimed Ref")?.[1]).toBe("nl");
    expect(built("Claimed Ref")?.[0].fixtures.map((f) => f.label)).toEqual([`${names!.home} ${nlUi["schedule.vs"]} ${names!.away}`]);
    expect(built("Unclaimed Ref")?.[1]).toBe("fr");
    expect(built("Unclaimed Ref")?.[0].fixtures.map((f) => f.label)).toEqual([`${names!.home} ${frUi["schedule.vs"]} ${names!.away}`]);
  });
});
