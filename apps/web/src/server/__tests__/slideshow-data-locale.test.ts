// buildDivisionSlides (P6 fix round 3, Important 4) — resolves an unfilled
// slot's label through the ORG's own default_locale, not the client-safe
// English default. DB-backed: buildDivisionSlides does real queries (unlike
// its pure public twin, buildPublicDivisionSlides — see public-slides.test.ts
// — which cannot prove locale threading because it has no DB/org row to
// read a default_locale off in the first place).
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { buildDivisionSlides, type FixtureSlideItem } from "../slideshow-data";

// The "Unit + typecheck" CI job is a DB-FREE gate: every DB-backed suite
// self-skips there (~2300 skipped) and runs in the DB-backed job instead.
// Without this guard the suite THROWS "DATABASE_URL is not set" rather than
// skipping, which reds a job that is not supposed to touch a database — and
// it passes locally, where DATABASE_URL is always set. Same pattern as
// embed-data.test.ts:9,38 and locale-columns.test.ts:10.
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("buildDivisionSlides — locale threading", () => {
  it("resolves an unfilled slot's label through the org's OWN default_locale, not the client-safe English default", async () => {
    const { auth } = await seedOrg();
    await sql`update organizations set default_locale = 'es' where id = ${auth.orgId}`;

    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Locale Cup",
      visibility: "public",
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
      ["A", "B"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const fixtureId = fixtures[0]!.id;

    // Force an unfilled, LABELED slot directly, rather than through P5's
    // .seeding machinery (stage-seeding.ts, Do-Not-Touch this session) —
    // this proves buildDivisionSlides' CONSUMPTION of home_slot_label,
    // independent of how a real one gets produced.
    await sql`
      update fixtures
      set home_entrant_id = null,
          home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })}
      where id = ${fixtureId}`;

    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const fixturesSlides = slides.filter(
      (s): s is Extract<(typeof slides)[number], { kind: "fixtures" }> => s.kind === "fixtures",
    );
    const homeTexts = fixturesSlides.flatMap((s) => s.items.map((i: FixtureSlideItem) => i.home));
    expect(homeTexts).toContain("Ganador del Grupo A");
    expect(homeTexts).not.toContain("Winner of Group A");
  });
});
