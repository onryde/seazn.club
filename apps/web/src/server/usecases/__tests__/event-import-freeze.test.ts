// Final review C-1: the batch importer had no counterpart to `scoreEvent`'s
// over-quota freeze (scoring.ts:195 + :214). An org past
// `competitions.max_active` is read-only for live scoring, schedule apply,
// division create and competition patch — but could still bulk-write finished
// results in through this path. The freeze is a CALL-level 402 here (owner
// ruling R-A): one import is scoped to one division, therefore to one
// competition, so the verdict is identical for every stream and resolving it
// per stream would be N identical lookups for one answer.
//
// The seed deliberately does NOT reuse `pass-quota-freeze-lock.test.ts`'s
// helpers (they live under lib/__tests__ and pull in the whole pass/grace
// apparatus, none of which this claim needs): the ONLY thing required to put
// an org over quota is `limit + 1` active competitions, and the freeze
// selector (`selectFrozen`, entitlement-freeze.ts:26) keeps the `limit` most
// recently ACTIVE — activity being `greatest(created_at, max(score_event
// .recorded_at))`. The rig's competition is created first and has no score
// events anywhere in it, so it is the least recently active of the set and it
// is the one that freezes. That is what makes this deterministic rather than
// a coin flip over which competition the selector picks.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { importEvents } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** `n` extra active competitions, all created AFTER the rig's. Raw SQL on
 *  purpose: `createCompetition` enforces the quota itself (402 on the one that
 *  tips it over), so seeding an over-quota org through the usecase is
 *  impossible by construction — the state being tested is a DOWNGRADE, which
 *  is exactly how an org legitimately ends up here (doc 10 §2.4: existing data
 *  is never deleted, it goes read-only). */
async function seedActiveCompetitions(orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const suffix = randomUUID().slice(0, 8);
    await sql`
      insert into competitions (org_id, name, slug, status)
      values (${orgId}, ${"Filler " + suffix}, ${"filler-" + suffix}, 'draft')`;
  }
}

describe.skipIf(!HAS_DB)("importEvents — over-quota competition freeze (C-1)", () => {
  it("402s the whole call and writes NOTHING when the division's competition is frozen", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    // Read the ceiling rather than hard-coding it — the community cap has moved
    // four times (V112 2, V270 1, V311 5, V319 10) and this suite is about the
    // guard, not the number.
    const limit = await getLimit(auth.orgId, "competitions.max_active");
    expect(limit).not.toBeNull();
    await seedActiveCompetitions(auth.orgId, limit as number);

    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-frozen",
        streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "competitions.max_active" });

    // The assertion that matters: the ledger, not the response. A guard placed
    // after the stream loop would still 402 and would still have written.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(0);
    const [{ receipts }] = await sql<{ receipts: number }[]>`
      select count(*)::int as receipts from event_imports where division_id = ${divisionId}`;
    expect(receipts).toBe(0);
  });

  // Non-vacuousness control: without this, a "fix" that 402'd every import
  // would pass the case above. The org here holds exactly `limit` active
  // competitions — at the ceiling, not over it — so nothing freezes.
  it("negative control: an org exactly AT its ceiling still imports", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const limit = await getLimit(auth.orgId, "competitions.max_active");
    await seedActiveCompetitions(auth.orgId, (limit as number) - 1);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-in-quota",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.status).toBe("imported");
  });
});
