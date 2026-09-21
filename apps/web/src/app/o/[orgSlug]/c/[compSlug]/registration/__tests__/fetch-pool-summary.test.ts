// RS012 scope item 4 — real-Postgres coverage for the Registrants tab's pool
// summary banner (`fetchPoolSummary`, ../data.ts). This is direct-SQL,
// same style as fetch-division-rows.test.ts, because the three things this
// query has to get right — "waiting" (the SPOT_HOLDERS + not-yet-assigned
// pool, exactly the predicate soloPoolIsFull/the sweep already use),
// "free_slots" (room on ALREADY-REGISTERED teams, the same population
// listAssignTargets computes, not the abstract capacity×roster_cap bound),
// and the place_by_at/closes_at fallback — are none of them provable by
// reading the SQL, only by running it. Real Postgres required, skipped
// without DATABASE_URL (repo convention).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { fetchPoolSummary, parseRegistrantsQuery } from "../data";
import { seedOrg, asOwner, rig } from "@/server/usecases/__tests__/_registration-fixtures";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";

const HAS_DB = !!process.env.DATABASE_URL;

// The `sports` table is the product's own catalog, not a test scratch space:
// `/onboarding` lists every row in it, so a sport this file mints and leaves
// behind becomes a tile on a real account's welcome screen — and on the dev DB
// it stays there for good.
//
// The key is RANDOM per run, so a literal cleanup cannot work. Every site that
// inserts a sport registers its key here instead, and the one hook below takes
// them all away — which means the NEXT sport minted in this file is cleaned up
// by construction rather than by remembering.
const MINTED_SPORT_KEYS = new Set<string>();

/** Record a sport key this file inserted, so `afterAll` can take it away. */
function mintedSport(key: string): string {
  MINTED_SPORT_KEYS.add(key);
  return key;
}

afterAll(async () => {
  if (!HAS_DB || MINTED_SPORT_KEYS.size === 0) return;
  const keys = [...MINTED_SPORT_KEYS];
  // Divisions first: the FK is NO ACTION, so a sport row cannot go while a
  // division references it. Everything hanging off a division cascades.
  await sql`delete from divisions where sport_key in ${sql(keys)}`;
  await sql`delete from sport_variants where sport_key in ${sql(keys)}`;
  await sql`delete from sports where key in ${sql(keys)}`;
});

// No DB needed — this is page.tsx's own href-building rule
// (`${routes.competitionRegistration(org, comp, "registrants", divisionId)}&free_agent=1`)
// fed straight back through `parseRegistrantsQuery`, proving the banner's row
// link actually lands on the pre-filtered table (division + free_agent
// checked), not just that the string LOOKS right.
describe("pool summary banner href resolves to the table's own filter state (RS012 scope item 4)", () => {
  it("division_id + free_agent=1 parses to that division selected, freeAgent true", () => {
    const divisionId = "11111111-1111-1111-1111-111111111111";
    const href = `${routes.competitionRegistration("acme", "summer-cup", "registrants", divisionId)}&free_agent=1`;
    expect(href).toBe(`/o/acme/c/summer-cup/registration?tab=registrants&division_id=${divisionId}&free_agent=1`);

    const url = new URL(href, "https://example.test");
    const raw = Object.fromEntries(url.searchParams.entries());
    const filters = parseRegistrantsQuery(raw);
    expect(filters.divisionId).toBe(divisionId);
    expect(filters.freeAgent).toBe(true);
  });
});

/** A team division whose roster cap is small and KNOWN (`lineupSize +
 *  benchMax`), so free_slots arithmetic is checkable by hand — the shared
 *  `generic` fixture's cap of 1 (registration-assign.test.ts's own header
 *  comment) is too small to tell "summed correctly" apart from "non-zero".
 *  Reference:
 *  .claude/agent-memory/implementer/reference_custom_sport_key_needs_direct_division_insert.md
 *  — `createDivision` resolves sport_key against the engine's fixed module
 *  registry, so a fresh test-only key's `divisions`/`sports` rows go in via
 *  raw SQL, the same way audit-ledger.test.ts's seedFixture does. */
async function seedCustomTeamDivision(
  owner: AuthCtx,
  competitionId: string,
  opts: {
    lineupSize: number;
    benchMax: number;
    allowFreeAgents?: boolean;
    placeByAt?: string | null;
    closesAt?: string | null;
  },
): Promise<{ id: string; name: string }> {
  const suffix = randomUUID().slice(0, 8);
  const sportKey = mintedSport(`pool-test-${suffix}`);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportKey}, 'Pool Test Sport', '1.0.0',
      ${sql.json({ groups: [], lineup: { size: opts.lineupSize, benchMax: opts.benchMax } })})`;
  const name = `Pool Division ${suffix}`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, ${name}, ${`pool-div-${suffix}`}, ${sportKey}, 'std',
      ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
      '1.0.0')
    returning id`;
  await putRegistrationSettings(owner, divisionId, {
    enabled: true,
    entrant_kind: "team",
    allow_free_agents: opts.allowFreeAgents ?? true,
    place_by_at: opts.placeByAt ?? null,
    closes_at: opts.closesAt ?? null,
  });
  return { id: divisionId, name };
}

async function seedTeamEntry(
  divisionId: string,
  playerCount: number,
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" = "confirmed",
): Promise<string> {
  const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (${competitionId}, 'Contact', ${`c-${randomUUID().slice(0, 8)}@test.local`}, ${`tok-${randomUUID()}`}, 'gbp')
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group.id}, ${divisionId}, ${"Team " + randomUUID().slice(0, 4)}, false, ${status})
    returning id`;
  for (let i = 0; i < playerCount; i++) {
    await sql`
      insert into registration_players (registration_id, full_name, source)
      values (${reg.id}, ${"Player " + i}, 'captain_entered')`;
  }
  return reg.id;
}

async function seedSolo(
  divisionId: string,
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" = "pending",
): Promise<string> {
  const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (${competitionId}, 'Solo Contact', ${`s-${randomUUID().slice(0, 8)}@test.local`}, ${`tok-${randomUUID()}`}, 'gbp')
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group.id}, ${divisionId}, ${"Solo " + randomUUID().slice(0, 4)}, true, ${status})
    returning id`;
  return reg.id;
}

/** Marks `soloId` as already placed on `teamRegId` — the same shape
 *  `assignSoloSignUp` itself writes (registration-assign.ts): a
 *  registration_players row under the TEAM's registration, carrying
 *  `assigned_from_registration_id` back to the solo sign-up's own row. This
 *  is the ONLY thing the `not exists (...)` pool predicate checks. */
async function markAssigned(teamRegId: string, soloId: string): Promise<void> {
  await sql`
    insert into registration_players (registration_id, full_name, source, assigned_from_registration_id)
    values (${teamRegId}, 'Assigned Solo', 'organiser_assigned', ${soloId})`;
}

describe.skipIf(!HAS_DB)("fetchPoolSummary — real Postgres", () => {
  it("returns [] for a competition with no waiting solo sign-ups anywhere, including an allow_free_agents division with an empty pool", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      allow_free_agents: true,
    });

    const rows = await fetchPoolSummary(owner, competition.id);
    expect(rows).toEqual([]);
  });

  it("sums free roster room across registered teams (one full, two with room) and carries the division name", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    // Roster cap = 3 + 1 = 4. THREE teams, chosen so the correct sum (5)
    // differs from a naive "count the teams" mistake (3) — a two-team
    // fixture whose free counts happened to sum to the team count (found by
    // hand-mutating `sum(greatest(...))` down to a bare `count(*)` during
    // RS012 review: the original two-team version of this test, 0 free + 2
    // free = 2 teams, could not tell the two implementations apart).
    const division = await seedCustomTeamDivision(owner, competition.id, { lineupSize: 3, benchMax: 1 });
    await seedTeamEntry(division.id, 4); // full: 4/4, free 0
    await seedTeamEntry(division.id, 1); // 1/4, free 3
    await seedTeamEntry(division.id, 2); // 2/4, free 2
    await seedSolo(division.id, "pending");

    const rows = await fetchPoolSummary(owner, competition.id);
    expect(rows).toEqual([
      {
        division_id: division.id,
        division_name: division.name,
        waiting: 1,
        free_slots: 5,
        place_by_at: null,
      },
    ]);
  });

  it("reports free_slots: 0 for a division with waiting solo sign-ups but zero registered teams", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const division = await seedCustomTeamDivision(owner, competition.id, { lineupSize: 2, benchMax: 1 });
    await seedSolo(division.id, "confirmed");

    const rows = await fetchPoolSummary(owner, competition.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ division_id: division.id, waiting: 1, free_slots: 0 });
  });

  it("excludes an already-assigned solo sign-up, and one that has withdrawn, from `waiting`", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const division = await seedCustomTeamDivision(owner, competition.id, { lineupSize: 2, benchMax: 1 });
    const team = await seedTeamEntry(division.id, 0);
    const stillWaiting = await seedSolo(division.id, "pending");
    const assigned = await seedSolo(division.id, "confirmed");
    await markAssigned(team, assigned);
    await seedSolo(division.id, "withdrawn"); // never held a spot the sweep would count

    const rows = await fetchPoolSummary(owner, competition.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.waiting).toBe(1);
    expect(rows[0]!.division_id).toBe(division.id);
    void stillWaiting;
  });

  it("place_by_at falls back to closes_at, and is null when the division has set neither (V389's own fallback)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const withClosesOnly = await seedCustomTeamDivision(owner, competition.id, {
      lineupSize: 1,
      benchMax: 0,
      closesAt: "2026-10-01T00:00:00Z",
    });
    await seedSolo(withClosesOnly.id, "pending");
    const withNeither = await seedCustomTeamDivision(owner, competition.id, { lineupSize: 1, benchMax: 0 });
    await seedSolo(withNeither.id, "pending");
    const withPlaceBy = await seedCustomTeamDivision(owner, competition.id, {
      lineupSize: 1,
      benchMax: 0,
      placeByAt: "2026-09-15T00:00:00Z",
      closesAt: "2026-10-01T00:00:00Z", // place_by_at must win over this
    });
    await seedSolo(withPlaceBy.id, "pending");

    const rows = await fetchPoolSummary(owner, competition.id);
    const byId = new Map(rows.map((r) => [r.division_id, r]));
    expect(byId.get(withClosesOnly.id)?.place_by_at).toBe("2026-10-01T00:00:00.000Z");
    expect(byId.get(withNeither.id)?.place_by_at).toBeNull();
    expect(byId.get(withPlaceBy.id)?.place_by_at).toBe("2026-09-15T00:00:00.000Z");
  });
});
