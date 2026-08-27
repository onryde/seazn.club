// #14: half the app disambiguated court names through buildCourtDirectory
// (the board, the picker, the AI pack), half selected the bare `courts.name`
// column — getFixture/listDivisionFixtures/patchFixture (fixtures.ts) were
// three of the read paths that didn't. A court name is unique only WITHIN
// its venue (courts_venue_name_active_idx is scoped per venue), so two
// venues may legally each name one court "Court 1"; these reads must render
// them distinguishably, through the same rule (courtNamesById ->
// buildCourtDirectory), and never fall back to a bare uuid.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { getFixture, listDivisionFixtures, patchFixture } from "../fixtures";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedTwoFixtureDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Court Names " + randomUUID().slice(0, 6),
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
  await createEntrants(auth, division.id, [
    { kind: "individual", display_name: "A", seed: 1, members: [] },
    { kind: "individual", display_name: "B", seed: 2, members: [] },
    { kind: "individual", display_name: "C", seed: 3, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  expect(fixtures.length).toBeGreaterThanOrEqual(2);
  return { division, fixtures };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("fixtures.ts court-name reads (#14)", () => {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

  it("getFixture/patchFixture/listDivisionFixtures disambiguate two same-named courts across two venues", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedTwoFixtureDivision(auth);
    const venueA = await createVenue(auth, { name: "Riverside", sort: 0 });
    const venueB = await createVenue(auth, { name: "Lakeside", sort: 1 });
    const courtA = await createCourt(auth, venueA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtB = await createCourt(auth, venueB.id, { name: "Court 1", sort: 0, tags: [] });

    // patchFixture is the writer AND the read path under test (#14's
    // stages.ts:2784 sibling — but here just exercising the normal PATCH
    // response, not the FK-validation fix).
    const patched1 = await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z",
      court_id: courtA.id,
    });
    const patched2 = await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: "2026-07-20T09:30:00.000Z",
      court_id: courtB.id,
    });
    expect(patched1.court_name).toBe("Court 1 (Riverside)");
    expect(patched2.court_name).toBe("Court 1 (Lakeside)");
    expect(patched1.court_name ?? "").not.toMatch(uuidRe);
    expect(patched2.court_name ?? "").not.toMatch(uuidRe);

    const g1 = await getFixture(auth, fixtures[0]!.id);
    const g2 = await getFixture(auth, fixtures[1]!.id);
    expect(g1.court_name).toBe("Court 1 (Riverside)");
    expect(g2.court_name).toBe("Court 1 (Lakeside)");

    const list = await listDivisionFixtures(auth, division.id);
    const l1 = list.find((f) => f.id === fixtures[0]!.id)!;
    const l2 = list.find((f) => f.id === fixtures[1]!.id)!;
    expect(l1.court_name).toBe("Court 1 (Riverside)");
    expect(l2.court_name).toBe("Court 1 (Lakeside)");
    for (const f of list) expect(f.court_name ?? "").not.toMatch(uuidRe);
  });

  it("a court name unique in the org still renders bare (no over-qualification)", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedTwoFixtureDivision(auth);
    const venue = await createVenue(auth, { name: "Only Venue", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 9", sort: 0, tags: [] });
    const patched = await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z",
      court_id: court.id,
    });
    expect(patched.court_name).toBe("Court 9");
  });

  // generateStageFixtures (stages.ts) re-reads and returns EVERY fixture in
  // the stage on regeneration (idempotent) — same court_name resolution
  // pattern as fixtures.ts above, applied at 3 sites in stages.ts
  // (generateStageFixtures, generateProgressionSetupFixtures,
  // confirmSeedProposal). Only the exported, directly-callable one is
  // exercised here; the other two are byte-identical code (mechanically
  // applied together) rather than separately re-proven.
  it("generateStageFixtures (stages.ts) disambiguates two same-named courts across two venues", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedTwoFixtureDivision(auth);
    const venueA = await createVenue(auth, { name: "Riverside", sort: 0 });
    const venueB = await createVenue(auth, { name: "Lakeside", sort: 1 });
    const courtA = await createCourt(auth, venueA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtB = await createCourt(auth, venueB.id, { name: "Court 1", sort: 0, tags: [] });
    await sql`update fixtures set court_id = ${courtA.id} where id = ${fixtures[0]!.id}`;
    await sql`update fixtures set court_id = ${courtB.id} where id = ${fixtures[1]!.id}`;

    // Idempotent regeneration — no new fixtures, but re-reads and returns
    // every fixture in the stage with a freshly-resolved court_name.
    const regen = await generateStageFixtures(auth, fixtures[0]!.stage_id);
    expect(regen.created).toBe(0);
    const r1 = regen.fixtures.find((f) => f.id === fixtures[0]!.id)!;
    const r2 = regen.fixtures.find((f) => f.id === fixtures[1]!.id)!;
    expect(r1.court_name).toBe("Court 1 (Riverside)");
    expect(r2.court_name).toBe("Court 1 (Lakeside)");
    expect(r1.court_name ?? "").not.toMatch(uuidRe);
  });
});
