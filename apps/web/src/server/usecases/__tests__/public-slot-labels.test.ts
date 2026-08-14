// publicSchedule / publicFixture (API v1) — Gap 9, fix round 3. V362 exposed
// fixtures.home_slot_label/away_slot_label on public_fixtures_v, but neither
// usecase selected them, so an API consumer saw nothing where the HTML
// schedule page (public-site/data.ts) already shows a label.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { publicFixture, publicSchedule } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;

async function setup() {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Public Slot Labels",
    visibility: "public", // required: public_fixtures_v filters on this
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fixtureId = fixtures[0]!.id;

  // Force an unfilled, labeled slot directly — how it got there is out of
  // this task's scope (P5's stage-seeding.ts is Do-Not-Touch); this proves
  // the READ path's column selection, independent of production.
  await sql`
    update fixtures
    set home_entrant_id = null,
        home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })}
    where id = ${fixtureId}`;

  return { orgSlug, compSlug: comp.slug, divSlug: division.slug, fixtureId };
}

describe.skipIf(!HAS_DB)("publicSchedule / publicFixture — home_slot_label/away_slot_label (Gap 9)", () => {
  it("publicSchedule includes home_slot_label for an unfilled slot", async () => {
    const { orgSlug, compSlug, divSlug, fixtureId } = await setup();
    const out = (await publicSchedule(orgSlug, compSlug, divSlug)) as {
      fixtures: { id: string; home_slot_label: unknown; home_entrant_id: string | null }[];
    };
    const fixture = out.fixtures.find((f) => f.id === fixtureId);
    expect(fixture).toBeDefined();
    expect(fixture!.home_entrant_id).toBeNull();
    expect(fixture!.home_slot_label).toEqual({ key: "slot.winner_group", params: { g: "A" } });
  });

  it("publicFixture includes home_slot_label for an unfilled slot", async () => {
    const { fixtureId } = await setup();
    const out = (await publicFixture(fixtureId)) as {
      home_slot_label: unknown;
      home_entrant_id: string | null;
    };
    expect(out.home_entrant_id).toBeNull();
    expect(out.home_slot_label).toEqual({ key: "slot.winner_group", params: { g: "A" } });
  });
});
