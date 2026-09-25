// The prod shape of the per-stage rules label defect (2026-09-24), seeded
// through the product's own writers, shared by the fixture-label regression
// and the hub/division-page DB tests so the two prove one scene.
//
// southend-sports-community / badminton-2026 / boys-singles: a public badminton
// `short` division; a Swiss stage whose `rules` are exactly prod's; a League
// stage beside it with none. Both generated.
import { sql } from "@/lib/db";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { putStageRules } from "@/server/usecases/stage-rules";

/** The prod Swiss stage's stored rules, exactly. */
export const SWISS_RULES = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };

export interface StageRulesScene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionConfig: Record<string, unknown>;
  swissStageId: string;
  leagueStageId: string;
  /** A fixture of the stage that overrides the division's rules. */
  swissFixtureId: string;
  /** A fixture of the stage that does not. */
  leagueFixtureId: string;
}

export async function seedStageRulesScene(): Promise<StageRulesScene> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Badminton 2026",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Boys Singles",
    sport_key: "badminton",
    variant_key: "short",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    ["Ada", "Bo", "Cy", "Di"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [swiss] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "Swiss", config: {} });
  const [league] = await createStages(auth, division.id, { seq: 2, kind: "league", name: "League", config: {} });
  await putStageRules(auth, swiss!.id, { rules: SWISS_RULES });
  const swissFixtures = await generateStageFixtures(auth, swiss!.id);
  const leagueFixtures = await generateStageFixtures(auth, league!.id);

  const [row] = await sql<
    { org_slug: string; comp_slug: string; div_slug: string; config: Record<string, unknown> }[]
  >`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  return {
    orgId: auth.orgId,
    orgSlug: row!.org_slug,
    compSlug: row!.comp_slug,
    divSlug: row!.div_slug,
    divisionConfig: row!.config,
    swissStageId: swiss!.id,
    leagueStageId: league!.id,
    swissFixtureId: swissFixtures.fixtures[0]!.id,
    leagueFixtureId: leagueFixtures.fixtures[0]!.id,
  };
}
