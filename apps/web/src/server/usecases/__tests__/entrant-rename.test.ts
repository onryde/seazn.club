// An entrant's name follows its roster (reported from production 2026-09-22:
// pair "Sankar & Ritwik", Ritwik removed, Venkatesh added — the name stayed
// "Sankar & Ritwik" everywhere, and no screen could rename it).
//
// `patchEntrant` is the ONE server path both the console's roster editor and
// the public API reach, so the auto-rename lives there and is driven here
// through the real usecase against real Postgres (RLS, entrant_members' lack of
// an order column). Skipped without DATABASE_URL, like every DB-backed suite in
// this directory.
//
// Every "derived" name below is BUILT with `rosterDerivedName` — the same join
// the create sites use — never typed, so the test moves with the source of
// truth. And every rename case asserts the stale name is gone as well as the
// new one present: the stale name is exactly what the defect served.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rosterDerivedName } from "@/lib/entrant-roster-name";

// The public-page refresh is asserted by spying on the two helpers the name
// change fires, keeping the rest of the module real (stages.ts, imported by
// entrants.ts, still needs `fireDivisionRevalidate`).
const fireScoreRevalidate = vi.hoisted(() => vi.fn(async () => {}));
const dropNamedPublicDocuments = vi.hoisted(() => vi.fn());
vi.mock("@/server/public-site/revalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/revalidate")>()),
  fireScoreRevalidate,
  dropNamedPublicDocuments,
}));

import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, getEntrant, patchEntrant } from "../entrants";
import { createPerson } from "../persons";
import { createTeam } from "../teams";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg as sharedSeedOrg, GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

interface Person {
  id: string;
  full_name: string;
}

async function seedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Rename Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Doubles",
    slug: "doubles-" + randomUUID().slice(0, 8),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  } as never);
  return { comp, division };
}

async function seedPerson(auth: AuthCtx, name: string): Promise<Person> {
  const p = await createPerson(auth, {
    full_name: name,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  } as never);
  return { id: p.id, full_name: name };
}

const derived = (...people: Person[]) => rosterDerivedName(people.map((p) => p.full_name));
const roster = (...people: Person[]) =>
  people.map((p) => ({ person_id: p.id, is_captain: false, roles: [] as string[] }));

/** The stored name, read back through the pooled client — not the usecase's
 *  own return value, which could echo something it never wrote. */
async function storedName(entrantId: string): Promise<string> {
  const [row] = await sql<{ display_name: string }[]>`
    select display_name from entrants where id = ${entrantId}`;
  return row!.display_name;
}

/** A pair created exactly the way the console's add form creates one: the
 *  people picked, the name derived from them by the shared join. */
async function seedPair(auth: AuthCtx, divisionId: string, a: Person, b: Person, name = derived(a, b)) {
  const [entrant] = await createEntrants(auth, divisionId, [
    { kind: "pair", display_name: name, members: roster(a, b) },
  ]);
  return entrant!;
}

beforeEach(() => {
  fireScoreRevalidate.mockClear();
  dropNamedPublicDocuments.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("patchEntrant — a derived name follows the roster", () => {
  it("the production case: 'Sankar & Ritwik' − Ritwik + Venkatesh → 'Sankar & Venkatesh'", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    const pair = await seedPair(auth, division.id, sankar, ritwik);
    expect(pair.display_name).toBe(derived(sankar, ritwik));

    const out = await patchEntrant(auth, pair.id, { members: roster(sankar, venkatesh) });

    expect(out.display_name).toBe(derived(sankar, venkatesh));
    expect(await storedName(pair.id)).toBe(derived(sankar, venkatesh));
    expect(await storedName(pair.id)).not.toBe(derived(sankar, ritwik));
    // The roster really is the new one — the name did not move on its own.
    const full = await getEntrant(auth, pair.id);
    expect((full.members as { person_id: string }[]).map((m) => m.person_id).sort()).toEqual(
      [sankar.id, venkatesh.id].sort(),
    );
  });

  it("the survivor keeps its place in the name, whatever order the roster is submitted in", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    // Name written Ritwik-first: Ritwik stays, Sankar leaves.
    const pair = await seedPair(auth, division.id, ritwik, sankar);

    // Submitted newcomer-first; the name must not follow the submission order.
    await patchEntrant(auth, pair.id, { members: roster(venkatesh, ritwik) });

    expect(await storedName(pair.id)).toBe(derived(ritwik, venkatesh));
  });

  it("a custom name ('Smash Bros') is never touched by a roster edit", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    const pair = await seedPair(auth, division.id, sankar, ritwik, "Smash Bros");

    const out = await patchEntrant(auth, pair.id, { members: roster(sankar, venkatesh) });

    expect(out.display_name).toBe("Smash Bros");
    expect(await storedName(pair.id)).toBe("Smash Bros");
  });

  it("an explicit display_name in the same patch wins over the derivation", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    const out = await patchEntrant(auth, pair.id, {
      members: roster(sankar, venkatesh),
      display_name: "Court Kings",
    });

    expect(out.display_name).toBe("Court Kings");
    expect(await storedName(pair.id)).toBe("Court Kings");
  });

  it("an explicit display_name wins even when it reads like the OLD roster", async () => {
    // The case where only the "the patch named it itself" guard can hold:
    // the organiser swaps Ritwik out but deliberately keeps the old name. That
    // name IS the derivation of the prior roster, so without the guard the
    // follow-the-roster rebuild would overwrite the name they just typed.
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    const out = await patchEntrant(auth, pair.id, {
      members: roster(sankar, venkatesh),
      display_name: derived(sankar, ritwik),
    });

    expect(out.display_name).toBe(derived(sankar, ritwik));
    expect(await storedName(pair.id)).toBe(derived(sankar, ritwik));
    expect(await storedName(pair.id)).not.toBe(derived(sankar, venkatesh));
  });

  it("a team-linked entrant keeps its team snapshot even when that snapshot reads like its roster", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    // The team is NAMED exactly what its roster would derive, so only the
    // team_id guard — not the "is this name derived?" check — can keep it.
    const team = await createTeam(auth, { name: derived(sankar, ritwik) });
    const [entrant] = await createEntrants(auth, division.id, [
      { kind: "team", team_id: team.id, members: roster(sankar, ritwik) } as never,
    ]);
    expect(entrant!.display_name).toBe(derived(sankar, ritwik));

    await patchEntrant(auth, entrant!.id, { members: roster(sankar, venkatesh) });

    expect(await storedName(entrant!.id)).toBe(derived(sankar, ritwik));
  });

  it("the same people re-saved (in any order) leave the name exactly as it was", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    await patchEntrant(auth, pair.id, { members: roster(ritwik, sankar) });

    // Reversed submission must NOT reverse the name.
    expect(await storedName(pair.id)).toBe(derived(sankar, ritwik));
  });

  it("a roster cleared to nobody keeps the name it had (the column cannot be empty)", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    const out = await patchEntrant(auth, pair.id, { members: [] });

    expect(out.members).toEqual([]);
    expect(await storedName(pair.id)).toBe(derived(sankar, ritwik));
  });

  it("a patch that carries no roster never renames (a seed edit on a derived pair)", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    const out = await patchEntrant(auth, pair.id, { seed: 3 });

    expect(out.seed).toBe(3);
    expect(await storedName(pair.id)).toBe(derived(sankar, ritwik));
  });
});

describe.skipIf(!HAS_DB)("patchEntrant — public pages hear about the change", () => {
  it("fires the name-change refresh for the entrant's division and competition, and drops the documents naming it", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { comp, division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const venkatesh = await seedPerson(auth, "Venkatesh");
    const pair = await seedPair(auth, division.id, sankar, ritwik);
    // Two more entrants and a league, so the pair plays fixtures and some
    // fixtures do NOT involve it — the dropped set must be the pair's own.
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Bystander One", members: [] },
      { kind: "individual", display_name: "Bystander Two", members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const pairFixtures = (
      await sql<{ id: string }[]>`
        select id from fixtures where home_entrant_id = ${pair.id} or away_entrant_id = ${pair.id}`
    ).map((f) => f.id);
    const allFixtures = await sql<{ id: string }[]>`select id from fixtures where division_id = ${division.id}`;
    // Guard the fixture shape this test depends on, so it cannot pass vacuously.
    expect(pairFixtures.length).toBeGreaterThan(0);
    expect(allFixtures.length).toBeGreaterThan(pairFixtures.length);

    fireScoreRevalidate.mockClear();
    dropNamedPublicDocuments.mockClear();
    await patchEntrant(auth, pair.id, { members: roster(sankar, venkatesh) });

    expect(fireScoreRevalidate).toHaveBeenCalledTimes(1);
    expect(fireScoreRevalidate).toHaveBeenCalledWith(division.id, comp.id);
    expect(dropNamedPublicDocuments).toHaveBeenCalledTimes(1);
    const [scope] = dropNamedPublicDocuments.mock.calls[0] as unknown as [
      { competitionIds: string[]; divisionIds: string[]; fixtureIds: string[] },
    ];
    expect(scope.competitionIds).toEqual([comp.id]);
    expect(scope.divisionIds).toEqual([division.id]);
    expect([...scope.fixtureIds].sort()).toEqual([...pairFixtures].sort());
  });

  it("an explicit rename (the Name field) refreshes the public pages too", async () => {
    const { auth } = await sharedSeedOrg("pro");
    const { comp, division } = await seedDivision(auth);
    const sankar = await seedPerson(auth, "Sankar");
    const ritwik = await seedPerson(auth, "Ritwik");
    const pair = await seedPair(auth, division.id, sankar, ritwik);

    fireScoreRevalidate.mockClear();
    await patchEntrant(auth, pair.id, { display_name: "Court Kings" });

    expect(fireScoreRevalidate).toHaveBeenCalledWith(division.id, comp.id);
  });

  it("a refused patch (unknown entrant) refreshes nothing", async () => {
    const { auth } = await sharedSeedOrg("pro");
    fireScoreRevalidate.mockClear();
    await expect(patchEntrant(auth, randomUUID(), { display_name: "Nobody" })).rejects.toMatchObject({
      status: 404,
    });
    expect(fireScoreRevalidate).not.toHaveBeenCalled();
    expect(dropNamedPublicDocuments).not.toHaveBeenCalled();
  });
});
