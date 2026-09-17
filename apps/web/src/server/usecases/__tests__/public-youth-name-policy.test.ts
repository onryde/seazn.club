// Privacy hotfix (2026-09-16) — two anonymous public readers that ignored the
// division's youth / name-display policy:
//
//  - `publicEntrants` (GET /api/v1/public/.../entrants) masked a youth
//    member's NAME but still served their `person_id` beside it (and their
//    photo). The id is the player-card URL, and the card printed the full
//    name, so the mask was one hop from undone.
//  - `publicSuspensions` (the division page's suspensions strip) names people
//    through SQL `public_person_name(full_name, consent)` — consent only, no
//    youth axis (V229). A consented youth player's full name was printed.
//  - `publicDivisionStats` (GET /api/v1/public/.../divisions/{slug}/stats, the
//    public leaderboard) names people the same way — same leak.
//
// DB-backed against the real readers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { publicEntrants } from "../public";
import { publicSuspensions } from "../discipline";
import { divisionPlayerStats, publicDivisionStats } from "../player-stats";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  closeSql,
  OPEN_FULL,
  seedYouthNameScene,
  YOUTH_MASKED,
  type YouthNameScene,
} from "@/server/public-site/__tests__/_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

type Member = { name: string; person_id: string | null; photo: string | null };
type EntrantsDoc = { entrants: { display_name: string; members: Member[] }[] };

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("publicEntrants — a masked member carries no person id and no photo", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  it("youth division: the member's name is masked AND person_id and photo are null", async () => {
    const out = (await publicEntrants(s.orgSlug, s.compSlug, s.youth.divisionSlug)) as EntrantsDoc;
    expect(out.entrants).toHaveLength(1);
    const [member] = out.entrants[0]!.members;
    expect(member!.name).toBe(YOUTH_MASKED);
    expect(member!.person_id).toBeNull();
    expect(member!.photo).toBeNull();
    expect(JSON.stringify(out)).not.toContain(s.youth.personId);
    expect(JSON.stringify(out)).not.toContain("Kumar");
  });

  it("open division (positive pair): the consented member keeps the full name, person_id and photo", async () => {
    const out = (await publicEntrants(s.orgSlug, s.compSlug, s.open.divisionSlug)) as EntrantsDoc;
    const [member] = out.entrants[0]!.members;
    expect(member!.name).toBe(OPEN_FULL);
    expect(member!.person_id).toBe(s.open.personId);
    expect(member!.photo).toBe(s.open.photo);
  });
});

describe.skipIf(!HAS_DB)("publicSuspensions — the strip applies the division name policy", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  it("youth division: a consented player's ban is listed under the masked name, never the full name", async () => {
    const rows = await publicSuspensions(s.orgSlug, s.compSlug, s.youth.divisionSlug);
    expect(rows).toEqual([{ name: YOUTH_MASKED, remaining: 2 }]);
  });

  it("open division (positive pair): a consented player's ban keeps the full name", async () => {
    const rows = await publicSuspensions(s.orgSlug, s.compSlug, s.open.divisionSlug);
    expect(rows).toEqual([{ name: OPEN_FULL, remaining: 2 }]);
  });

  it("youth division, NO consent recorded: still initials — the policy never loosens the consent gate", async () => {
    // `public_person_name` initials an absent consent ("Quinn Cole" → "Q.C.")
    // while `resolvePersonDisplayName` does not mask an absent consent at all.
    // Routing the strip through the resolver's NAME would have published this
    // person in full; the strip must stay the stricter of the two.
    const [{ id }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent) values (${s.orgId}, 'Quinn Cole', ${sql.json({})})
      returning id`;
    await sql`
      insert into suspensions (org_id, division_id, person_id, status, source, reason, matches_total)
      values (${s.orgId}, ${s.youth.divisionId}, ${id}, 'active', 'manual', 'test ban', 1)`;
    const rows = await publicSuspensions(s.orgSlug, s.compSlug, s.youth.divisionSlug);
    expect(rows.map((r) => r.name).sort()).toEqual([YOUTH_MASKED, "Q.C."].sort());
  });
});

describe.skipIf(!HAS_DB)("publicDivisionStats — the public leaderboard applies the division name policy", () => {
  let s: YouthNameScene;
  let quinnId: string;

  /** Real stats, through the real write path: a fixture in the division and
   *  a `generic.score` attributed to each person. `publicDivisionStats` serves
   *  the snapshot as it stands and never folds (owner ruling 2026-09-17, the
   *  stats refresh), so `beforeAll` folds each division through the
   *  organiser's own read first, the pattern `player-stats.test.ts` uses. */
  async function scoreFor(divisionId: string, scorers: { entrantId: string; personId: string; points: number }[], opponent: string) {
    await createEntrants(s.auth, divisionId, [{ kind: "individual", display_name: opponent, seed: 2, members: [] }]);
    const [stage] = await createStages(s.auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(s.auth, stage!.id);
    await startDivision(s.auth, divisionId);
    const f = fixtures[0]!;
    let seq = 0;
    await scoreEvent(s.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
    for (const sc of scorers) {
      await scoreEvent(s.auth, f.id, {
        expected_seq: seq++,
        type: "generic.score",
        payload: { by: sc.entrantId, points: sc.points, person: sc.personId },
      });
    }
  }

  beforeAll(async () => {
    s = await seedYouthNameScene();
    // A youth player with NO consent recorded, as the youth division's
    // second entrant — the opponent in the one generated fixture.
    [{ id: quinnId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent) values (${s.orgId}, 'Quinn Cole', ${sql.json({})})
      returning id`;
    const [quinnEntrant] = await createEntrants(s.auth, s.youth.divisionId, [
      {
        kind: "individual",
        display_name: "Quinn Cole",
        seed: 3,
        members: [{ person_id: quinnId, squad_number: 9, default_position_key: null, is_captain: true, roles: [] }],
      },
    ]);
    const [stage] = await createStages(s.auth, s.youth.divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(s.auth, stage!.id);
    await startDivision(s.auth, s.youth.divisionId);
    const f = fixtures[0]!;
    await scoreEvent(s.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(s.auth, f.id, {
      expected_seq: 1,
      type: "generic.score",
      payload: { by: s.youth.entrantId, points: 3, person: s.youth.personId },
    });
    await scoreEvent(s.auth, f.id, {
      expected_seq: 2,
      type: "generic.score",
      payload: { by: quinnEntrant!.id, points: 1, person: quinnId },
    });
    await scoreFor(s.open.divisionId, [{ entrantId: s.open.entrantId, personId: s.open.personId, points: 3 }], "Open Opponent");
    await divisionPlayerStats(s.auth, s.youth.divisionId, {});
    await divisionPlayerStats(s.auth, s.open.divisionId, {});
  });

  it("youth division: a consented player's row carries the masked name, never the full name", async () => {
    const out = await publicDivisionStats(s.orgSlug, s.compSlug, s.youth.divisionSlug);
    const names = out.rows.map((r) => r.name);
    expect(names, `rows: ${JSON.stringify(out.rows)}`).toContain(YOUTH_MASKED);
    expect(JSON.stringify(out)).not.toContain("Kumar");
    // The rows carry a name and stats only — no person id or link to withhold.
    for (const row of out.rows) expect(Object.keys(row).sort()).toEqual(["name", "stats"]);
  });

  it("youth division, NO consent recorded: still initials — the policy never loosens the consent gate", async () => {
    const out = await publicDivisionStats(s.orgSlug, s.compSlug, s.youth.divisionSlug);
    const names = out.rows.map((r) => r.name);
    expect(names, `rows: ${JSON.stringify(out.rows)}`).toContain("Q.C.");
    expect(JSON.stringify(out)).not.toContain("Quinn");
  });

  it("open division (positive pair): a consented player's row keeps the full name", async () => {
    const out = await publicDivisionStats(s.orgSlug, s.compSlug, s.open.divisionSlug);
    expect(out.rows.map((r) => r.name), `rows: ${JSON.stringify(out.rows)}`).toContain(OPEN_FULL);
  });
});
