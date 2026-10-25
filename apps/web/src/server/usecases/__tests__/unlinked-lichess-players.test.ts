// Switching a chess division to online play WARNS about the players who have no Lichess link (owner ruling 2026-10-25,
// "apply rec": allow the switch, list who is unlinked; blocking is rejected - organisers switch first and collect links
// later). `listUnlinkedLichessPlayers` is the list that warning prints, so it is driven here against the real database,
// through the real usecases that build the roster, with the real Lichess-link reader (`personIdsWithLichessLink`) behind
// it - not a second linked-ness query.
//
// What the list must do, stated from the ruling and the schema (entrants_status_check, V212), not from the code:
//   - it names PEOPLE, one row each, however many entrants carry them (a link is per person, not per team);
//   - it names only people in the FIELD: a withdrawn or disqualified entrant's players are not owed a link;
//   - it is empty when nobody is unlinked, and for a division with no entrants at all (the empty case, stated first);
//   - a player who links drops off it, and one who unlinks comes back (state in both directions, a second call included);
//   - it is the same list before and after the division is switched, and it is scoped to the caller's club.
// And the other half of the ruling: the SAVE is not blocked. `patchDivision` turns online play on with unlinked players on
// the roster - through the use-case and through the PATCH route - so a later "just refuse it" fails here.
//
// Boardgame only: it is the one sport that plays online (online-play.ts `supportsOnlinePlay`); the component suite owns the
// "another sport never shows the warning" case.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Outside a Next request there is no incrementalCache (the use-cases already swallow it); a passthrough keeps the route honest.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants, listUnlinkedLichessPlayers, patchEntrant } from "../entrants";
import { PLAY_SCOPES, unlinkLichess, upsertLichessLink } from "../external-accounts";
import { seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";
import { PATCH } from "@/app/api/v1/divisions/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const ONLINE_CONFIG = { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } } as const;

async function seedDivisionOf(auth: AuthCtx): Promise<string> {
  const competition = await createCompetition(auth, {
    name: "Unlinked " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", clock: { base: 600, increment: 5 } },
  });
  return division.id;
}

const player = (auth: AuthCtx, name: string, linked: boolean): Promise<SeedPlayer> =>
  seedPlayer(auth.orgId, name, `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`, linked);

/** One individual entrant for `p`, through the real use-case (the division is OFF, so no link is demanded of the roster). */
async function enter(auth: AuthCtx, divisionId: string, p: SeedPlayer, name: string): Promise<string> {
  const [created] = await createEntrants(auth, divisionId, [
    { display_name: name, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
  ]);
  return created!.id;
}

/** A team-shaped entrant (raw SQL: boardgame's entrant model is individual-only, but the reader is per PERSON and must
 *  not care how many people one entrant carries - the registration gate it mirrors is per person too). */
async function enterTeam(auth: AuthCtx, divisionId: string, name: string, members: SeedPlayer[]): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name) values (${divisionId}, 'team', ${name}) returning id`;
  for (const m of members) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${id}, ${m.personId}, ${auth.orgId})`;
  }
  return id;
}

const link = (p: SeedPlayer) =>
  upsertLichessLink(p.userId, {
    externalUserId: p.lichessId,
    username: p.lichessId,
    scopes: [...PLAY_SCOPES],
    token: `lio_seed_${p.lichessId}`,
  });

const names = (rows: { full_name: string }[]) => rows.map((r) => r.full_name);

describe.skipIf(!HAS_DB)("listUnlinkedLichessPlayers - who the online-switch warning names", () => {
  it("empty case first: a division with no entrants names nobody", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);

    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([]);
  });

  it("nobody unlinked: every player holds a link, so the list is empty (and the warning absent)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    await enter(auth, divisionId, await player(auth, "Linked One", true), "Linked One");
    await enter(auth, divisionId, await player(auth, "Linked Two", true), "Linked Two");

    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([]);
  });

  it("one unlinked among linked players: exactly that person, by person id and full name", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const ok = await player(auth, "Has Link", true);
    const missing = await player(auth, "No Link", false);
    await enter(auth, divisionId, ok, "Has Link");
    await enter(auth, divisionId, missing, "No Link");

    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([{ person_id: missing.personId, full_name: "No Link" }]);
  });

  it("many unlinked: all of them, alphabetical without regard to case, and no linked player among them", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    // Entered out of alphabetical order, with a lowercase initial: a case-sensitive order would put "bea" last.
    const unlinked = ["Cy Wong", "bea Lopez", "Ana Ruiz", "Dev Rao", "Eli Kim", "Fay Ode", "Gus Lund"];
    for (const n of unlinked) await enter(auth, divisionId, await player(auth, n, false), n);
    await enter(auth, divisionId, await player(auth, "Zed Linked", true), "Zed Linked");

    const got = await listUnlinkedLichessPlayers(auth, divisionId);

    expect(names(got)).toEqual(["Ana Ruiz", "bea Lopez", "Cy Wong", "Dev Rao", "Eli Kim", "Fay Ode", "Gus Lund"]);
    expect(got).toHaveLength(unlinked.length);
  });

  // entrants_status_check (V212): registered, confirmed are the field; withdrawn, disqualified have left it. A swept
  // table, with a count: a loop that ran over nothing would pass.
  it("only the field is named: a withdrawn or disqualified entrant's player is not owed a link", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const table = [
      { status: "registered", listed: true },
      { status: "confirmed", listed: true },
      { status: "withdrawn", listed: false },
      { status: "disqualified", listed: false },
    ] as const;
    const byStatus = new Map<string, SeedPlayer>();
    for (const { status } of table) {
      const p = await player(auth, `Status ${status}`, false);
      const entrantId = await enter(auth, divisionId, p, `Status ${status}`);
      await patchEntrant(auth, entrantId, { status });
      byStatus.set(status, p);
    }

    const got = new Set((await listUnlinkedLichessPlayers(auth, divisionId)).map((r) => r.person_id));

    let checked = 0;
    for (const { status, listed } of table) {
      expect(got.has(byStatus.get(status)!.personId), `${status} listed?`).toBe(listed);
      checked++;
    }
    expect(checked, "anti-vacuity: every status was checked").toBe(4);
    expect(got.size).toBe(2);
  });

  it("a withdrawal reaches the list: the entrant is named, then withdrawn, then gone; reinstated, named again", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Comes And Goes", false);
    const entrantId = await enter(auth, divisionId, p, "Comes And Goes");

    expect(names(await listUnlinkedLichessPlayers(auth, divisionId))).toEqual(["Comes And Goes"]);
    await patchEntrant(auth, entrantId, { status: "withdrawn" });
    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([]);
    await patchEntrant(auth, entrantId, { status: "registered" });
    expect(names(await listUnlinkedLichessPlayers(auth, divisionId))).toEqual(["Comes And Goes"]);
  });

  it("a person on a withdrawn entrant AND a live one is named once (the live entry still owes the link)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Two Entries", false);
    const gone = await enterTeam(auth, divisionId, "Old Team", [p]);
    await enterTeam(auth, divisionId, "New Team", [p]);
    await patchEntrant(auth, gone, { status: "withdrawn" });

    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([{ person_id: p.personId, full_name: "Two Entries" }]);
  });

  it("team events: unlinked is per PERSON - the team's unlinked members are named, not the team, and the linked member is not", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const [linked, a, b] = [await player(auth, "Tia Linked", true), await player(auth, "Uma Open", false), await player(auth, "Vic Open", false)];
    await enterTeam(auth, divisionId, "Rooks United", [linked, a, b]);
    // The same unlinked person on a second entrant of the division: still one row.
    await enterTeam(auth, divisionId, "Bishops", [a]);

    const got = await listUnlinkedLichessPlayers(auth, divisionId);

    expect(got).toEqual([
      { person_id: a.personId, full_name: "Uma Open" },
      { person_id: b.personId, full_name: "Vic Open" },
    ]);
    expect(names(got)).not.toContain("Rooks United");
  });

  it("a player who links drops off the list, one who unlinks comes back, and a second call agrees with the first", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Links Later", false);
    const stays = await player(auth, "Never Links", false);
    await enter(auth, divisionId, p, "Links Later");
    await enter(auth, divisionId, stays, "Never Links");

    const before = await listUnlinkedLichessPlayers(auth, divisionId);
    expect(names(before)).toEqual(["Links Later", "Never Links"]);
    expect(await listUnlinkedLichessPlayers(auth, divisionId), "a second call").toEqual(before);

    await link(p);
    expect(names(await listUnlinkedLichessPlayers(auth, divisionId)), "after they link").toEqual(["Never Links"]);

    await unlinkLichess(p.userId);
    expect(names(await listUnlinkedLichessPlayers(auth, divisionId)), "after they unlink again").toEqual(["Links Later", "Never Links"]);
  });

  it("a person with no Seazn account at all (no user row) is unlinked too", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Walk In') returning id`;
    await createEntrants(auth, divisionId, [
      { display_name: "Walk In", kind: "individual", members: [{ person_id: personId, is_captain: false, roles: [] }] },
    ]);

    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual([{ person_id: personId, full_name: "Walk In" }]);
  });

  it("is scoped to the caller's club: another club's division is a 404, and its players' links never answer for this one", async () => {
    const mine = await seedOwner();
    const theirs = await seedOwner();
    const theirDivision = await seedDivisionOf(theirs);
    await enter(theirs, theirDivision, await player(theirs, "Their Player", false), "Their Player");

    await expect(listUnlinkedLichessPlayers(mine, theirDivision)).rejects.toMatchObject({ status: 404 });
  });
});

describe.skipIf(!HAS_DB)("switching online play ON with unlinked players: the save is allowed (owner ruling 2026-10-25)", () => {
  it("patchDivision saves onlinePlay = lichess with unlinked players on the roster, and the list is the same before and after", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const a = await player(auth, "Ann Unlinked", false);
    const b = await player(auth, "Ben Unlinked", false);
    await enter(auth, divisionId, a, "Ann Unlinked");
    await enter(auth, divisionId, b, "Ben Unlinked");
    await enter(auth, divisionId, await player(auth, "Cat Linked", true), "Cat Linked");
    const before = await listUnlinkedLichessPlayers(auth, divisionId);
    expect(names(before), "premise: two are unlinked going in").toEqual(["Ann Unlinked", "Ben Unlinked"]);

    const saved = await patchDivision(auth, divisionId, { variant_key: "classical", config: { ...ONLINE_CONFIG } });

    expect(saved.refused, "nothing was refused").toEqual([]);
    expect((saved.config as { onlinePlay?: string }).onlinePlay).toBe("lichess");
    expect(((await getDivision(auth, divisionId)).config as { onlinePlay?: string }).onlinePlay, "it was stored").toBe("lichess");
    // The warning stays: the same two are still owed a link once the division is online.
    expect(await listUnlinkedLichessPlayers(auth, divisionId)).toEqual(before);
  });

  it("the PATCH route accepts the switch with unlinked players: 200, stored, nobody blocked", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    await enter(auth, divisionId, await player(auth, "Route Unlinked", false), "Route Unlinked");
    // `pro` carries `api.access` but not `api.write` - the override the sibling route suites use to mint a manage key.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'api.write', true, 'test')
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(auth.orgId);
    const { secret } = await createApiKey(auth, { name: "manager", scopes: ["manage"] });

    const res = await PATCH(
      new Request(`https://test.local/api/v1/divisions/${divisionId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ variant_key: "classical", config: ONLINE_CONFIG }),
      }),
      { params: Promise.resolve({ id: divisionId }) },
    );
    const body = (await res.json()) as { data?: { config?: { onlinePlay?: string } }; error?: { code: string } };

    expect(res.status, JSON.stringify(body.error)).toBe(200);
    expect(body.data?.config?.onlinePlay).toBe("lichess");
    const [{ stored }] = await sql<{ stored: string | null }[]>`select config->>'onlinePlay' as stored from divisions where id = ${divisionId}`;
    expect(stored).toBe("lichess");
  });
});
