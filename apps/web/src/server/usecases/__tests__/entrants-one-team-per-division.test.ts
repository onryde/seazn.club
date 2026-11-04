// UI5 item 3 (owner, demo of 2026-11-03): one person, one team per division. Every organiser roster write goes through
// `insertMembers` (create, a roster PATCH, a squad sync), and it now refuses a person who is already on ANOTHER entrant in
// the same division with 409 PERSON_ON_OTHER_TEAM, naming the person and the team. Before, all three writes allowed it and
// the roster editor only warned ("You can still save").
//
// What stays allowed, each asserted beside its refusal: the same person in a DIFFERENT division; re-saving the SAME team
// (a PATCH or a squad sync that keeps them); a person whose other team has WITHDRAWN; an empty roster; and an americano
// division, whose stage mints a `pair` entrant per rotation from its individuals (`pairEntrantsFor`), so everyone there is on
// many pairs by design. The refusal writes nothing: the whole create batch rolls back, a refused PATCH or sync leaves the
// roster as it was. `divisionRoster` (the UI's source for "On <team>") reads the same rows the refusal reads.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, divisionRoster, getEntrant, patchEntrant, syncEntrantRosterFromSquad } from "../entrants";
import { createPerson } from "../persons";
import { setTeamSquad } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const CODE = "PERSON_ON_OTHER_TEAM";

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"One " + suffix}, ${"one-" + suffix}) returning id`;
  // Pro: no entrant cap or division cap gets in the way of the rig.
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function rig() {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "One Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = async (name: string) =>
    createDivision(auth, comp.id, { name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG } as never);
  const person = async (full_name: string) =>
    (await createPerson(auth, { full_name, consent: {}, dob: null, gender: null, external_ref: null })).id;
  return { auth, division, person };
}

const member = (person_id: string) => ({ person_id, is_captain: false, roles: [] as string[] });
const team = (display_name: string, people: string[]) => ({ kind: "team" as const, display_name, members: people.map(member) });
const rosterOf = async (auth: AuthCtx, entrantId: string): Promise<string[]> =>
  ((await getEntrant(auth, entrantId)).members as { person_id: string }[]).map((m) => m.person_id).sort();
const entrantsNamed = async (divisionId: string, name: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId} and display_name = ${name}`)[0]!.n;

/** The refusal's shape: 409, the code, and every conflicting person named with the team they are on. */
const refusedFor = (conflicts: { person_id: string; person_name: string; entrant_id: string; entrant_name: string; entrant_kind?: string }[]) => ({
  status: 409,
  code: CODE,
  extra: { conflicts },
});

describe.skipIf(!HAS_DB)("one person, one team per division (UI5 item 3)", () => {
  it("create: a person already on another team in the division is refused by name, and nothing of the batch is written", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Shared");
    const bo = await person("Bo Free");
    const [red] = await createEntrants(auth, div.id, [team("Red", [ada])]);

    await expect(createEntrants(auth, div.id, [team("Blue", [bo, ada])])).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Shared", entrant_id: red!.id, entrant_name: "Red" }]),
    );
    expect(await entrantsNamed(div.id, "Blue"), "the refused team was not written").toBe(0);

    // A batch is atomic: two new teams naming the same person, neither existing before - the second is refused, and the
    // first rolls back with it.
    const cy = await person("Cy Twice");
    await expect(createEntrants(auth, div.id, [team("Green", [cy]), team("Gold", [cy])])).rejects.toMatchObject({ status: 409, code: CODE });
    expect(await entrantsNamed(div.id, "Green"), "the batch rolled back whole").toBe(0);
    expect(await entrantsNamed(div.id, "Gold")).toBe(0);

    // The positive pair, same division: the same team without the shared person goes through.
    const [blue] = await createEntrants(auth, div.id, [team("Blue", [bo])]);
    expect(await rosterOf(auth, blue!.id)).toEqual([bo]);
  });

  it("another division: the same person is allowed (the rule is per division, never per competition or org)", async () => {
    const { auth, division, person } = await rig();
    const a = await division("A");
    const b = await division("B");
    const ada = await person("Ada Two Divisions");
    const [inA] = await createEntrants(auth, a.id, [team("Red", [ada])]);
    const [inB] = await createEntrants(auth, b.id, [team("Red B", [ada])]);
    expect(await rosterOf(auth, inA!.id)).toEqual([ada]);
    expect(await rosterOf(auth, inB!.id)).toEqual([ada]);
  });

  it("PATCH: re-saving the same team passes (twice); adding someone from another team is refused and the roster is unchanged", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Patch");
    const bo = await person("Bo Patch");
    const cy = await person("Cy Patch");
    const [red] = await createEntrants(auth, div.id, [team("Red", [ada])]);
    const [blue] = await createEntrants(auth, div.id, [team("Blue", [cy])]);

    // The same team re-saved with its own person kept (and one more added): its own membership is never a conflict. A
    // second identical save is the second call.
    await patchEntrant(auth, red!.id, { members: [member(ada), member(bo)] });
    await patchEntrant(auth, red!.id, { members: [member(ada), member(bo)] });
    expect(await rosterOf(auth, red!.id)).toEqual([ada, bo].sort());

    await expect(patchEntrant(auth, blue!.id, { members: [member(cy), member(ada)] })).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Patch", entrant_id: red!.id, entrant_name: "Red" }]),
    );
    expect(await rosterOf(auth, blue!.id), "a refused PATCH leaves the roster as it was").toEqual([cy]);

    // A rename (no roster in the patch) never asks: the team keeps its people under its new name.
    await patchEntrant(auth, red!.id, { display_name: "Red Renamed" });
    expect(await rosterOf(auth, red!.id)).toEqual([ada, bo].sort());
    // ...and the refusal names the team as it is called NOW.
    await expect(patchEntrant(auth, blue!.id, { members: [member(bo)] })).rejects.toMatchObject(
      refusedFor([{ person_id: bo, person_name: "Bo Patch", entrant_id: red!.id, entrant_name: "Red Renamed" }]),
    );

    // An emptied roster is never a conflict (the empty case).
    await patchEntrant(auth, blue!.id, { members: [] });
    expect(await rosterOf(auth, blue!.id)).toEqual([]);
  });

  it("squad sync: syncing the same team again passes; a squad that now holds someone from another team is refused, roster unchanged", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Squad");
    const wes = await person("Wes Squad");
    const [{ id: teamId }] = await withTenant(auth.orgId, (tx) => tx<{ id: string }[]>`
      insert into teams (org_id, name) values (${auth.orgId}, ${"Squad FC " + randomUUID().slice(0, 6)}) returning id`);
    await setTeamSquad(auth, teamId, [member(wes)]);
    const [enrolled] = await createEntrants(auth, div.id, [{ kind: "team", team_id: teamId, members: [] }]);
    expect(await rosterOf(auth, enrolled!.id), "premise: seeded from the squad").toEqual([wes]);

    // The same squad synced again, twice: the team's own people are not a conflict.
    await syncEntrantRosterFromSquad(auth, enrolled!.id);
    await syncEntrantRosterFromSquad(auth, enrolled!.id);
    expect(await rosterOf(auth, enrolled!.id)).toEqual([wes]);

    const [red] = await createEntrants(auth, div.id, [team("Red", [ada])]);
    await setTeamSquad(auth, teamId, [member(wes), member(ada)]);
    await expect(syncEntrantRosterFromSquad(auth, enrolled!.id)).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Squad", entrant_id: red!.id, entrant_name: "Red" }]),
    );
    expect(await rosterOf(auth, enrolled!.id), "a refused sync leaves the roster as it was").toEqual([wes]);
  });

  it("after a withdrawal: a person whose team has withdrawn can join another team; the roster map stops naming the departed team", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Withdrawn");
    const [red] = await createEntrants(auth, div.id, [team("Red", [ada])]);
    expect((await divisionRoster(auth, div.id)).map((r) => r.entrant_id), "premise: Red holds Ada").toEqual([red!.id]);

    await patchEntrant(auth, red!.id, { status: "withdrawn" });
    expect(await divisionRoster(auth, div.id), "a departed team is no longer in the map").toEqual([]);
    const [blue] = await createEntrants(auth, div.id, [team("Blue", [ada])]);
    expect(await rosterOf(auth, blue!.id)).toEqual([ada]);
  });

  it("another kind: a pair and an individual hold their people the same way", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Pair");
    const bo = await person("Bo Pair");
    const [pair] = await createEntrants(auth, div.id, [{ kind: "pair", display_name: "Ada & Bo", members: [member(ada), member(bo)] }]);
    await expect(createEntrants(auth, div.id, [{ kind: "individual", display_name: "Ada Pair", members: [member(ada)] }])).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Pair", entrant_id: pair!.id, entrant_name: "Ada & Bo", entrant_kind: "pair" }]),
    );
    // Several conflicts in one write: every one is named, in the order the roster lists them.
    await expect(createEntrants(auth, div.id, [{ kind: "pair", display_name: "Again", members: [member(bo), member(ada)] }])).rejects.toMatchObject(
      refusedFor([
        { person_id: bo, person_name: "Bo Pair", entrant_id: pair!.id, entrant_name: "Ada & Bo" },
        { person_id: ada, person_name: "Ada Pair", entrant_id: pair!.id, entrant_name: "Ada & Bo" },
      ]),
    );
  });

  it("an americano division: the rotation's pair entrants never count, so an individual's roster still saves; a second individual is refused", async () => {
    const { auth, division, person } = await rig();
    const div = await division("Am");
    const ada = await person("Ada Americano");
    const bo = await person("Bo Americano");
    const [solo] = await createEntrants(auth, div.id, [{ kind: "individual", display_name: "Ada Americano", members: [member(ada)] }]);
    await createEntrants(auth, div.id, [{ kind: "individual", display_name: "Bo Americano", members: [member(bo)] }]);
    // What the americano stage's Generate writes (`pairEntrantsFor`): a stage of kind americano, and a pair entrant per
    // rotation holding two of its individuals' people, written straight to the tables as the generator does.
    await withTenant(auth.orgId, async (tx) => {
      await tx`insert into stages (division_id, seq, kind, name, config) values (${div.id}, 1, 'americano', 'Americano', ${tx.json({})})`;
      const [{ id: rotation }] = await tx<{ id: string }[]>`
        insert into entrants (division_id, kind, display_name) values (${div.id}, 'pair', 'Ada Americano / Bo Americano') returning id`;
      await tx`insert into entrant_members (entrant_id, person_id, is_captain) values (${rotation}, ${ada}, false), (${rotation}, ${bo}, false)`;
    });

    await patchEntrant(auth, solo!.id, { members: [member(ada)] });
    expect(await rosterOf(auth, solo!.id), "the rotation pair is not another team").toEqual([ada]);
    expect((await divisionRoster(auth, div.id)).filter((r) => r.person_id === ada).map((r) => r.entrant_id), "nor in the map").toEqual([solo!.id]);
    // The positive pair: the individual entrants still count, so entering Ada a second time is refused - and, held by an
    // INDIVIDUAL entrant (herself), the conflict says so by its kind and the sentence says "entered", never "on Ada
    // Americano" (the copy the e2e caught reading "Yara is already on Yara").
    const again = createEntrants(auth, div.id, [{ kind: "individual", display_name: "Ada Again", members: [member(ada)] }]);
    await expect(again).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Americano", entrant_id: solo!.id, entrant_name: "Ada Americano", entrant_kind: "individual" }]),
    );
    await expect(again).rejects.toThrow("Ada Americano is already entered in this division");
    expect((await divisionRoster(auth, div.id)).find((r) => r.person_id === ada), "the map carries the holder's kind").toMatchObject({
      entrant_id: solo!.id,
      entrant_kind: "individual",
    });
  });
});

// UI5 fix round 1 (controller ruling Q3): reinstating a withdrawn entrant brings its roster back into the field, so the
// one-team rule asks again — the bypass the review found (`patchEntrant`'s status write never asked it).
describe.skipIf(!HAS_DB)("one person, one team per division: reinstating a withdrawn entrant (UI5 fix round 1, Q3)", () => {
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;

  it("a withdrawn team whose player has since joined another team is refused by name; it stays withdrawn", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada Reinstate");
    const bo = await person("Bo Reinstate");
    const [red] = await createEntrants(auth, div.id, [team("Red", [ada, bo])]);
    await patchEntrant(auth, red!.id, { status: "withdrawn" });
    const [blue] = await createEntrants(auth, div.id, [team("Blue", [ada])]); // allowed: Red holds no one now

    await expect(patchEntrant(auth, red!.id, { status: "registered" })).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada Reinstate", entrant_id: blue!.id, entrant_name: "Blue" }]),
    );
    expect(await statusOf(red!.id), "a refused reinstatement writes nothing").toBe("withdrawn");
    expect(await rosterOf(auth, red!.id), "and keeps the roster").toEqual([ada, bo].sort());

    // Its cleared pair: once Ada leaves Blue, the same reinstatement goes through — and its own people are never a conflict.
    await patchEntrant(auth, blue!.id, { members: [] });
    await patchEntrant(auth, red!.id, { status: "registered" });
    expect(await statusOf(red!.id)).toBe("registered");
    // The second call: re-asserting the active status is no reinstatement, and asks nothing.
    await patchEntrant(auth, red!.id, { status: "registered" });
    expect(await statusOf(red!.id)).toBe("registered");
  });

  it("a reinstatement that also replaces the roster is asked of the NEW roster; an empty roster reinstates", async () => {
    const { auth, division, person } = await rig();
    const div = await division("A");
    const ada = await person("Ada New Roster");
    const cy = await person("Cy New Roster");
    const [red] = await createEntrants(auth, div.id, [team("Red", [ada])]);
    await patchEntrant(auth, red!.id, { status: "withdrawn" });
    const [blue] = await createEntrants(auth, div.id, [team("Blue", [ada])]);
    // Ada's old seat on Red is replaced by Cy in the same write: nothing clashes.
    await patchEntrant(auth, red!.id, { status: "confirmed", members: [member(cy)] });
    expect(await statusOf(red!.id)).toBe("confirmed");
    expect(await rosterOf(auth, red!.id)).toEqual([cy]);
    // ...but a new roster naming Blue's player is refused, by the roster write's own check.
    await patchEntrant(auth, red!.id, { status: "withdrawn" });
    await expect(patchEntrant(auth, red!.id, { status: "registered", members: [member(ada)] })).rejects.toMatchObject(
      refusedFor([{ person_id: ada, person_name: "Ada New Roster", entrant_id: blue!.id, entrant_name: "Blue" }]),
    );
    expect(await statusOf(red!.id)).toBe("withdrawn");
    // The empty case: a withdrawn entrant with nobody on it reinstates.
    const [empty] = await createEntrants(auth, div.id, [team("Empty", [])]);
    await patchEntrant(auth, empty!.id, { status: "withdrawn" });
    await patchEntrant(auth, empty!.id, { status: "registered" });
    expect(await statusOf(empty!.id)).toBe("registered");
  });
});
