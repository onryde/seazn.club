// PROMPT-53 /me reads and writes: cross-org isolation (user A never sees
// user B's persons), RSVP upsert semantics, guardian-gated consent with tag
// revalidation, QR check-in defaulting. Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { MyFixture } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { createPerson } from "../persons";
import {
  listMyFixtures,
  setMyAvailability,
  checkInToFixture,
  listMyPersons,
  listMyPlayerStats,
  setMyConsent,
} from "../me";

vi.mock("@/server/public-site/revalidate", () => ({
  fireDivisionRevalidate: vi.fn(),
}));
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(tag: string): Promise<{ orgId: string; ownerId: string; owner: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Me ${tag} ${suffix}`}, ${`me-${tag}-${suffix}`}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const owner: AuthCtx = {
    orgId,
    via: "session",
    userId: ownerId,
    role: "owner",
    keyId: null,
  };
  return { orgId, ownerId, owner };
}

/** Division of 4 individual entrants, each backed by a person; fixtures generated + started. */
async function rig(owner: AuthCtx, opts: { dob?: string | null } = {}) {
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Me Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const persons = [];
  for (const n of ["Ada", "Ben", "Cal", "Dee"]) {
    persons.push(
      await createPerson(owner, {
        full_name: n,
        consent: {},
        dob: opts.dob ?? null,
      } as never),
    );
  }
  const entrants = await createEntrants(
    owner,
    division.id,
    persons.map((p, i) => ({
      kind: "individual" as const,
      display_name: p.full_name,
      seed: i + 1,
      members: [
        {
          person_id: p.id,
          squad_number: null,
          default_position_key: null,
          is_captain: false,
          roles: [],
        },
      ],
    })),
  );
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, persons, entrants, fixtures };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("player home /me (PROMPT-53)", () => {
  it("cross-org isolation: my persons across orgs, nobody else's", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const rigA = await rig(a.owner);
    const rigB = await rig(b.owner);
    const player = await makeUser("player");
    const stranger = await makeUser("stranger");
    // Claim Ada in org A and Ben in org B for the same login.
    await sql`update persons set user_id = ${player} where id = ${rigA.persons[0].id}`;
    await sql`update persons set user_id = ${player} where id = ${rigB.persons[1].id}`;

    const mine = await listMyFixtures(player);
    const orgs = new Set(mine.upcoming.map((f) => f.org_name));
    expect(orgs.size).toBe(2);
    // League of 4: each entrant plays 3.
    expect(mine.upcoming.filter((f) => f.person_id === rigA.persons[0].id)).toHaveLength(3);
    expect(mine.teams).toHaveLength(2);

    const theirs = await listMyFixtures(stranger);
    expect(theirs.upcoming).toHaveLength(0);
    expect(theirs.teams).toHaveLength(0);

    const personsList = await listMyPersons(player);
    expect(personsList.map((p) => p.full_name).sort()).toEqual(["Ada", "Ben"]);
    // dob never rides out on the /me payload.
    expect(Object.keys(personsList[0])).not.toContain("dob");
  });

  it("hasPhotoFeature is false for a person only linked as an official — officials have no photo upload", async () => {
    const { owner, orgId } = await seedOrg("official-photo");
    const { persons } = await rig(owner);
    const refPerson = await createPerson(owner, {
      full_name: "Ref Sam",
      consent: {},
      dob: null,
    } as never);
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${orgId}, ${refPerson.id}, ${refPerson.full_name}, ${sql.json(["referee"])})
      returning id`;
    expect(official).toBeDefined();
    // #402 / V348 — an official-ONLY person lives in the 'official' lane, which
    // is precisely what lets one login hold a player person AND an official one
    // in the same org under persons_org_user_lane_uq. `inviteOfficial` mints it
    // that way in production (officials.ts is the only official-lane insert);
    // this hand-rolled setup bypasses that rail, so it stamps the lane itself.
    // Setup only — the two hasPhotoFeature assertions below are untouched.
    await sql`update persons set lane = 'official' where id = ${refPerson.id}`;

    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    await sql`update persons set user_id = ${player} where id = ${refPerson.id}`;

    const personsList = await listMyPersons(player);
    const rostered = personsList.find((p) => p.id === persons[0].id)!;
    const officialOnly = personsList.find((p) => p.id === refPerson.id)!;
    expect(rostered.hasPhotoFeature).toBe(true);
    expect(officialOnly.hasPhotoFeature).toBe(false);
  });

  it("withdrawn entrants drop out of /me", async () => {
    const { owner } = await seedOrg("w");
    const { persons, entrants } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    expect((await listMyFixtures(player)).upcoming.length).toBeGreaterThan(0);
    await sql`update entrants set status = 'withdrawn' where id = ${entrants[0].id}`;
    expect((await listMyFixtures(player)).upcoming).toHaveLength(0);
  });

  it("RSVP upserts (in → out keeps one row), 403 on a fixture that isn't mine", async () => {
    const { owner } = await seedOrg("r");
    const { persons, fixtures } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    const myFixture = (await listMyFixtures(player)).upcoming[0];

    const first = await setMyAvailability(player, myFixture.id, {
      status: "in",
    });
    expect(first.status).toBe("in");
    const second = await setMyAvailability(player, myFixture.id, {
      status: "out",
      note: "away that weekend",
    });
    expect(second.status).toBe("out");
    expect(second.note).toBe("away that weekend");
    const rows = await sql`
      select 1 from fixture_availability
      where fixture_id = ${myFixture.id} and person_id = ${persons[0].id}`;
    expect(rows).toHaveLength(1);

    // A fixture between the OTHER entrants is not mine.
    const mineIds = (await listMyFixtures(player)).upcoming.map((f) => f.id);
    const other = fixtures.find((f) => !mineIds.includes(f.id))!;
    expect(other).toBeDefined();
    await expect(setMyAvailability(player, other.id, { status: "in" })).rejects.toMatchObject({
      status: 403,
      code: "NOT_YOUR_FIXTURE",
    });
  });

  it("check-in stamps presence, defaults RSVP to 'in', never clobbers an 'out'", async () => {
    const { owner } = await seedOrg("c");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    const [f1, f2] = (await listMyFixtures(player)).upcoming;

    // Fresh row: turning up answers the RSVP.
    const fresh = await checkInToFixture(player, f1.id);
    expect(fresh?.status).toBe("in");
    expect(fresh?.checked_in_at).not.toBeNull();

    // Existing 'out' answer survives a check-in.
    await setMyAvailability(player, f2.id, { status: "out" });
    const kept = await checkInToFixture(player, f2.id);
    expect(kept?.status).toBe("out");
    expect(kept?.checked_in_at).not.toBeNull();

    // No claimed person on the fixture → null (claim-first interstitial).
    const stranger = await makeUser("stranger");
    expect(await checkInToFixture(stranger, f1.id)).toBeNull();
  });

  it("listMyPlayerStats: my snapshots labelled via the module model, isolated per user (G6)", async () => {
    const a = await seedOrg("stats");
    const rigA = await rig(a.owner);
    const player = await makeUser("statsplayer");
    const stranger = await makeUser("statsstranger");
    await sql`update persons set user_id = ${player} where id = ${rigA.persons[0].id}`;
    // Snapshot written by the stats folder in production — sport_key rides the
    // snapshot row; the module version comes from the division.
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${rigA.division.id}, ${rigA.persons[0].id}, 'football', ${sql.json({ goals: 2, assists: 0 })}, 1)`;

    const mine = await listMyPlayerStats(player);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.competition_public).toBe(true);
    expect(mine[0]!.division_slug).toBeTruthy();
    expect(mine[0]!.org_slug).toBeTruthy();
    const goals = mine[0]!.metrics.find((m) => m.key === "goals");
    expect(goals?.value).toBe(2);
    expect(mine[0]!.metrics.find((m) => m.key === "assists")).toBeUndefined();

    expect(await listMyPlayerStats(stranger)).toHaveLength(0);
  });

  it("isPlayerOnly: claimed person + no org = true; members and strangers = false", async () => {
    const { owner, ownerId } = await seedOrg("po");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;

    const { isPlayerOnly } = await import("../me");
    expect(await isPlayerOnly(player)).toBe(true); // claimed, no memberships
    expect(await isPlayerOnly(ownerId)).toBe(false); // org member
    expect(await isPlayerOnly(await makeUser("stranger"))).toBe(false); // neither
  });

  it("consent flip persists, revalidates the person's divisions; guardian gate 403s", async () => {
    const { owner } = await seedOrg("g");
    const adult = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${adult.persons[0].id}`;

    vi.mocked(fireDivisionRevalidate).mockClear();
    const updated = await setMyConsent(player, adult.persons[0].id, {
      public_name: true,
    });
    expect(updated.consent.public_name).toBe(true);
    expect(updated.consent_locked).toBe(false);
    expect(fireDivisionRevalidate).toHaveBeenCalledWith(adult.division.id, adult.competition.id);

    // Under-16: read shows locked, write 403s, organiser values hold.
    const minor = await rig(owner, { dob: "2013-01-01" });
    const kid = await makeUser("kid");
    await sql`update persons set user_id = ${kid} where id = ${minor.persons[0].id}`;
    const [kidPerson] = await listMyPersons(kid);
    expect(kidPerson.consent_locked).toBe(true);
    await expect(
      setMyConsent(kid, minor.persons[0].id, { public_name: true }),
    ).rejects.toMatchObject({
      status: 403,
      code: "CONSENT_LOCKED",
    });

    // Not my person → 404 (no oracle about other users' persons).
    await expect(
      setMyConsent(player, minor.persons[0].id, { public_name: true }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("listMyFixtures rows parse against the published MyFixture contract (review finding #9) — court_id/venue_id and derived court_name/venue_name, not the retired venue/court_label", async () => {
    const { owner, orgId } = await seedOrg("contract");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;

    const before = await listMyFixtures(player);
    expect(before.upcoming.length).toBeGreaterThan(0);
    const targetId = before.upcoming[0]!.id;

    // A real venue/court by id (P9 cutover) attached to one of the player's
    // own fixtures — proves the derived court_name/venue_name resolve, not
    // just that the schema shape happens to line up.
    const [{ id: venueId }] = await sql<{ id: string }[]>`
      insert into venues (org_id, name) values (${orgId}, ${"Riverside"}) returning id`;
    const [{ id: courtId }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags)
      values (${venueId}, ${orgId}, ${"Court 9"}, ${sql.array([])})
      returning id`;
    await sql`update fixtures set venue_id = ${venueId}, court_id = ${courtId} where id = ${targetId}`;

    const mine = await listMyFixtures(player);
    // Would throw pre-fix: the published schema still required `venue`/
    // `court_label` as present keys, which listMyFixtures stopped selecting —
    // parsing a REAL row (not a hand-built literal) is what catches that.
    for (const f of mine.upcoming) MyFixture.parse(f);

    const withCourt = mine.upcoming.find((f) => f.id === targetId)!;
    expect(withCourt.venue_name).toBe("Riverside");
    expect(withCourt.court_name).toBe("Court 9");

    // The OTHER half of contract drift, and the half a `.parse()` alone cannot
    // see: a field the usecase ships but the schema never declares is STRIPPED
    // by z.object rather than rejected, so the parse stays green while the
    // published contract quietly understates the payload. Reading the field
    // back off the PARSED value is what makes that visible — `venue_tz` has
    // been on the wire since V305 and undeclared here ever since, and the
    // times in this payload are unreadable without it.
    const parsed = MyFixture.parse(withCourt);
    expect(parsed.venue_tz).toBe(withCourt.venue_tz);
    expect(parsed.venue_tz).not.toBeUndefined();
  });

  // #14: listMyFixtures is a SUPERUSER, cross-org read (no withTenant/RLS) —
  // a court name is unique only WITHIN its venue, so it must venue-qualify
  // via the same rule the board/AI pack use, not show two indistinguishable
  // "Court 1" entries for two different physical courts.
  it("#14: disambiguates two same-named courts across two venues; never renders a bare uuid", async () => {
    const { owner, orgId } = await seedOrg("court-disambig");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;

    const before = await listMyFixtures(player);
    expect(before.upcoming.length).toBeGreaterThanOrEqual(2);
    const [f1, f2] = before.upcoming;

    const [{ id: venueA }] = await sql<{ id: string }[]>`
      insert into venues (org_id, name) values (${orgId}, ${"Riverside"}) returning id`;
    const [{ id: venueB }] = await sql<{ id: string }[]>`
      insert into venues (org_id, name) values (${orgId}, ${"Lakeside"}) returning id`;
    const [{ id: courtA }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags)
      values (${venueA}, ${orgId}, ${"Court 1"}, ${sql.array([])}) returning id`;
    const [{ id: courtB }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags)
      values (${venueB}, ${orgId}, ${"Court 1"}, ${sql.array([])}) returning id`;
    await sql`update fixtures set venue_id = ${venueA}, court_id = ${courtA} where id = ${f1!.id}`;
    await sql`update fixtures set venue_id = ${venueB}, court_id = ${courtB} where id = ${f2!.id}`;

    const mine = await listMyFixtures(player);
    for (const f of mine.upcoming) MyFixture.parse(f);
    const c1 = mine.upcoming.find((f) => f.id === f1!.id)!;
    const c2 = mine.upcoming.find((f) => f.id === f2!.id)!;
    expect(c1.court_name).toBe("Court 1 (Riverside)");
    expect(c2.court_name).toBe("Court 1 (Lakeside)");
    // Every fixture's own id/person_id/etc. are legitimately uuids — only the
    // NAME field is under test here.
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
    for (const f of mine.upcoming) expect(f.court_name ?? "").not.toMatch(uuidRe);
  });
});
