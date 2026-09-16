// Privacy hotfix (2026-09-16) — the news post scorebug.
//
// A result post's hero scorebug names its two sides from the linked fixture's
// entrants (`resolvePostSides`), REPLACING the names parsed from the post
// title. It read `public_entrants_v.display_name` as it stands, and for a
// singles or pairs entrant that column is the player's full name. So a result
// in a youth division printed the full name on a public page, even when the
// organiser had masked the title by hand. Nobody reviews this text: it is
// derived at render time.
//
// DB-backed against the real reader and the shared youth scene.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import type { OrgPost } from "@/server/usecases/org-posts";
import { resolvePostSides } from "../public-view";
import {
  closeSql,
  OPEN_FULL,
  seedYouthNameScene,
  YOUTH_MASKED,
  type YouthNameScene,
} from "@/server/public-site/__tests__/_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("resolvePostSides — the news scorebug applies the division name policy", () => {
  let s: YouthNameScene;
  let youthFixtureId: string;
  let openFixtureId: string;

  /** A consented singles opponent and the one generated fixture between them. */
  async function fixtureAgainst(divisionId: string, opponent: string): Promise<string> {
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${s.orgId}, ${opponent}, ${sql.json({ public_name: true })})
      returning id`;
    await createEntrants(s.auth, divisionId, [
      {
        kind: "individual",
        display_name: opponent,
        seed: 2,
        members: [{ person_id: personId, squad_number: 9, default_position_key: null, is_captain: true, roles: [] }],
      },
    ]);
    const [stage] = await createStages(s.auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(s.auth, stage!.id);
    return fixtures[0]!.id;
  }

  const resultPost = (fixtureId: string): OrgPost => ({
    id: "00000000-0000-0000-0000-000000000000",
    orgId: s.orgId,
    competitionId: null,
    divisionId: null,
    kind: "result",
    status: "published",
    slug: "result",
    title: "A beat B 3-1",
    bodyMd: "",
    heroImagePath: null,
    autoSource: { trigger: "fixture_decided", fixture_id: fixtureId },
    publishedAt: null,
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
  });

  beforeAll(async () => {
    s = await seedYouthNameScene();
    youthFixtureId = await fixtureAgainst(s.youth.divisionId, "Quinn Cole");
    openFixtureId = await fixtureAgainst(s.open.divisionId, "Maya Singh");
  });

  it("youth singles: both sides are the masked names, and no full name reaches the scorebug", async () => {
    const sides = await resolvePostSides(resultPost(youthFixtureId));
    expect(sides, "precondition: the fixture resolves to two sides").not.toBeNull();
    expect([sides!.home.name, sides!.away.name].sort()).toEqual([YOUTH_MASKED, "Quinn C."]);
    expect(JSON.stringify(sides)).not.toContain("Kumar");
    expect(JSON.stringify(sides)).not.toContain("Cole");
  });

  it("adult singles (positive pair): both sides keep the full names", async () => {
    const sides = await resolvePostSides(resultPost(openFixtureId));
    expect(sides, "precondition: the fixture resolves to two sides").not.toBeNull();
    expect([sides!.home.name, sides!.away.name].sort()).toEqual([OPEN_FULL, "Maya Singh"]);
  });
});
