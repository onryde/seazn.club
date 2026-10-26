// What `createEntrants` asks its privileged prelude to read on an ONLINE division, and who that read answers for.
//
// The Lichess-link read is org-wide by nature (one map of person -> what their link lets them do, read before the role
// drops, tested against the roster the transaction resolves). When the roster is known up front - every input names its own people - the read is scoped to
// exactly those ids, so a large org's whole linked list is not pulled to answer for one player. When it is NOT known up
// front (a team squad seeds it, or a copied roster replaces it) the whole org is read. `lichessLinkStatesByPerson` is
// wrapped by a pass-through spy so the id list it was handed is the thing asserted, beside what each path DOES.
//
// Also here: the security shape of a prelude. The callback it precedes must still run as `app_user`, so another org's
// division is still invisible (404) - if a prelude ever left the role undropped, RLS would be off for the whole
// transaction and these 404s would be 200s.
//
// Boardgame only: it is the one sport that plays online (`supportsOnlinePlay`), and `createDivision` refuses `onlinePlay`
// on any other, so no other division reaches the online branch.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type Tx } from "@/lib/db";

const spy = vi.hoisted(() => ({ calls: [] as { orgId: string; personIds: string[] | undefined }[] }));
vi.mock("../external-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-accounts")>();
  return {
    ...actual,
    lichessLinkStatesByPerson: (tx: Tx, orgId: string, personIds?: readonly string[]) => {
      spy.calls.push({ orgId, personIds: personIds === undefined ? undefined : [...personIds] });
      return actual.lichessLinkStatesByPerson(tx, orgId, personIds);
    },
  };
});

import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateEntrant } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { PLAY_SCOPES } from "../external-accounts";
import { linkWithoutPlayConsent, reconnectLichess, seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  spy.calls.length = 0;
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function seedDivisionOf(auth: AuthCtx, online: boolean): Promise<string> {
  const competition = await createCompetition(auth, {
    name: "Link set " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(auth, competition.id, {
    name: online ? "Online" : "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(online ? { onlinePlay: "lichess" } : {}), clock: { base: 600, increment: 5 } },
  });
  return division.id;
}

const player = (auth: AuthCtx, linked: boolean): Promise<SeedPlayer> =>
  seedPlayer(auth.orgId, `${linked ? "Linked" : "Unlinked"} ${randomUUID().slice(0, 6)}`, `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`, linked);

const entryOf = (p: SeedPlayer, name: string): CreateEntrant => ({
  display_name: name,
  kind: "individual",
  members: [{ person_id: p.personId, is_captain: false, roles: [] }],
});

/** A team whose persistent squad is `players` (raw SQL: `createTeam` is plan-gated and not under test). */
async function teamWithSquad(orgId: string, players: SeedPlayer[]): Promise<string> {
  const [{ id: teamId }] = await sql<{ id: string }[]>`
    insert into teams (org_id, name) values (${orgId}, ${"Squad " + randomUUID().slice(0, 8)}) returning id`;
  for (const p of players) {
    await sql`insert into team_members (team_id, person_id, org_id) values (${teamId}, ${p.personId}, ${orgId})`;
  }
  return teamId;
}

const entrantCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`)[0]!.n;

describe.skipIf(!HAS_DB)("createEntrants on an online division - who the link read answers for", () => {
  it("explicit members: the read is scoped to exactly the people named, and they enter", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [a, b] = [await player(auth, true), await player(auth, true)];
    // Linked people the batch does NOT name: in the org's whole set, so a scoped read must leave them out.
    await player(auth, true);

    const created = await createEntrants(auth, divisionId, [entryOf(a, "A"), entryOf(b, "B")]);

    expect(created).toHaveLength(2);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.orgId).toBe(auth.orgId);
    expect([...spy.calls[0]!.personIds!].sort()).toEqual([a.personId, b.personId].sort());
  });

  it("explicit members: the same person named twice is asked about once", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const a = await player(auth, true);

    await createEntrants(auth, divisionId, [entryOf(a, "A1"), entryOf(a, "A2")]);

    expect(spy.calls[0]!.personIds).toEqual([a.personId]);
  });

  it("explicit members: an unlinked player among them is refused, whatever else is named, and nobody enters", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [good, bad] = [await player(auth, true), await player(auth, false)];

    await expect(createEntrants(auth, divisionId, [entryOf(good, "Good"), entryOf(bad, "Bad")])).rejects.toMatchObject({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
    });

    expect([...spy.calls[0]!.personIds!].sort()).toEqual([good.personId, bad.personId].sort());
    expect(await entrantCount(divisionId)).toBe(0);
  });

  // A person created inside the transaction holds no account and names no one up front: the read is for nobody, and
  // the new person - absent from it - is refused, exactly as before the read was scoped.
  it("an inline new person names no one to the read, and is refused", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);

    await expect(
      createEntrants(auth, divisionId, [
        { display_name: "Walk-in", kind: "individual", members: [{ new_person: { full_name: "Walk In" }, is_captain: false, roles: [] }] },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });

    expect(spy.calls[0]!.personIds).toEqual([]);
    expect(await entrantCount(divisionId)).toBe(0);
  });

  // Another org's person, named explicitly on THIS org's division: the scoped read keeps the org filter, so the
  // foreign (linked) person is not answered for and the roster is refused.
  it("a linked person of ANOTHER org named on this org's division is not answered for", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const otherAuth = await seedOwner();
    const foreign = await player(otherAuth, true);

    await expect(createEntrants(auth, divisionId, [entryOf(foreign, "Foreign")])).rejects.toMatchObject({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
    });

    expect(spy.calls[0]!.personIds).toEqual([foreign.personId]);
    expect(await entrantCount(divisionId)).toBe(0);
  });

  it("a team squad seeds the roster: the roster is not known up front, so the whole org is read - and the squad is gated", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [linked, unlinked] = [await player(auth, true), await player(auth, false)];
    const goodTeam = await teamWithSquad(auth.orgId, [linked]);
    const badTeam = await teamWithSquad(auth.orgId, [unlinked]);

    const created = await createEntrants(auth, divisionId, [{ display_name: "x", kind: "individual", team_id: goodTeam, members: [] }]);
    expect(created).toHaveLength(1);
    await expect(
      createEntrants(auth, divisionId, [{ display_name: "x", kind: "individual", team_id: badTeam, members: [] }]),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });

    expect(spy.calls.map((c) => c.personIds), "both reads were org-wide").toEqual([undefined, undefined]);
  });

  it("a copied roster replaces the members: not known up front, so the whole org is read - and the copy is gated", async () => {
    const auth = await seedOwner();
    // The source entrant lives in an over-the-board division (no link demanded there), the copy target is online.
    const otbId = await seedDivisionOf(auth, false);
    const onlineId = await seedDivisionOf(auth, true);
    const [linked, unlinked, decoy] = [await player(auth, true), await player(auth, false), await player(auth, true)];
    const goodTeam = await teamWithSquad(auth.orgId, [linked]);
    const badTeam = await teamWithSquad(auth.orgId, [unlinked]);
    const [goodSource] = await createEntrants(auth, otbId, [{ display_name: "src", kind: "individual", team_id: goodTeam, members: [] }]);
    const [badSource] = await createEntrants(auth, otbId, [{ display_name: "src", kind: "individual", team_id: badTeam, members: [] }]);
    spy.calls.length = 0;

    // Members ARE named here (a decoy), beside the copy: the copy wins, so the decoy is not the roster - the read must
    // not be scoped to it. (Without the decoy the squad rule alone would make the read org-wide and hide a copy bug.)
    const decoyMember = { person_id: decoy.personId, is_captain: false, roles: [] };
    const created = await createEntrants(auth, onlineId, [
      { display_name: "x", kind: "individual", team_id: goodTeam, members: [decoyMember], copy_roster_from_entrant_id: goodSource!.id },
    ]);
    expect(created).toHaveLength(1);
    const stored = await sql<{ person_id: string }[]>`select person_id from entrant_members where entrant_id = ${created[0]!.id}`;
    expect(stored.map((m) => m.person_id), "premise: the copied roster replaced the named member").toEqual([linked.personId]);
    await expect(
      createEntrants(auth, onlineId, [
        { display_name: "x", kind: "individual", team_id: badTeam, members: [decoyMember], copy_roster_from_entrant_id: badSource!.id },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });

    expect(spy.calls.map((c) => c.personIds), "both reads were org-wide").toEqual([undefined, undefined]);
  });

  it("one input unknown makes the whole batch's read org-wide - the explicit input is still gated", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [explicit, squadded, unlinked] = [await player(auth, true), await player(auth, true), await player(auth, false)];
    const team = await teamWithSquad(auth.orgId, [squadded]);

    const created = await createEntrants(auth, divisionId, [
      entryOf(explicit, "Explicit"),
      { display_name: "x", kind: "individual", team_id: team, members: [] },
    ]);
    expect(created).toHaveLength(2);
    expect(spy.calls.map((c) => c.personIds)).toEqual([undefined]);

    await expect(
      createEntrants(auth, divisionId, [entryOf(unlinked, "Unlinked explicit"), { display_name: "y", kind: "individual", members: [] }]),
    ).rejects.toMatchObject({ code: "LICHESS_LINK_REQUIRED" });
  });

  // ---- Owner ruling 2026-10-25: registration refuses exactly what the seat gate refuses (`lichessGrantPlays`). ----

  /** A player with an account whose Lichess link does NOT let Seazn submit moves, in the given shape. */
  const nonPlaying = async (auth: AuthCtx, shape: "identity-only" | { without: string }): Promise<SeedPlayer> => {
    const p = await player(auth, false);
    await linkWithoutPlayConsent(p, shape);
    return p;
  };
  const refusalOf = async (promise: Promise<unknown>): Promise<{ status?: number; code?: string; ids?: unknown }> => {
    const e = (await promise.then(
      () => null,
      (err: unknown) => err,
    )) as { status?: number; code?: string; extra?: { person_ids?: unknown } } | null;
    expect(e, "premise: it was refused").not.toBeNull();
    return { status: e!.status, code: e!.code, ids: e!.extra?.person_ids };
  };

  it("a player whose link is identity-only is refused with the RECONNECT reason, names them, and nobody enters", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const idOnly = await nonPlaying(auth, "identity-only");

    const got = await refusalOf(createEntrants(auth, divisionId, [entryOf(idOnly, "Identity only")]));

    expect(got).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED", ids: [idOnly.personId] });
    expect(await entrantCount(divisionId)).toBe(0);
  });

  it("a grant short of ANY one play scope is refused with the reconnect reason (one case per declared scope)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    let checked = 0;
    for (const dropped of PLAY_SCOPES) {
      const narrow = await nonPlaying(auth, { without: dropped });
      expect(await refusalOf(createEntrants(auth, divisionId, [entryOf(narrow, `Without ${dropped}`)])), dropped).toEqual({
        status: 422,
        code: "LICHESS_RECONSENT_REQUIRED",
        ids: [narrow.personId],
      });
      checked++;
    }
    expect(checked, "anti-vacuity: every play scope swept").toBe(PLAY_SCOPES.length);
    expect(PLAY_SCOPES.length, "premise: the play grant has more than one scope").toBeGreaterThan(1);
    expect(await entrantCount(divisionId)).toBe(0);
  });

  it("a mixed batch names the right person under the right reason - the first refused entrant, in input order", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [ok, reconnect, unlinked] = [await player(auth, true), await nonPlaying(auth, "identity-only"), await player(auth, false)];

    // The gate runs entrant by entrant: whichever refused entrant comes FIRST decides the reason, and only its people are named.
    expect(await refusalOf(createEntrants(auth, divisionId, [entryOf(ok, "Ok"), entryOf(reconnect, "Reconnect"), entryOf(unlinked, "Unlinked")]))).toEqual({
      status: 422,
      code: "LICHESS_RECONSENT_REQUIRED",
      ids: [reconnect.personId],
    });
    expect(await refusalOf(createEntrants(auth, divisionId, [entryOf(ok, "Ok"), entryOf(unlinked, "Unlinked"), entryOf(reconnect, "Reconnect")]))).toEqual({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
      ids: [unlinked.personId],
    });
    expect(await entrantCount(divisionId), "nobody entered, whatever else was named").toBe(0);
  });

  // A chess entrant holds ONE person (boardgame allows `individual` only), so a single roster never mixes the two reasons
  // in the product - the mix is across entrants, above; the gate's own split inside one roster is its unit test's.
  it("a team squad whose player must reconnect is refused for them, and one whose player plays is not (the whole org is read)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const [ok, reconnect] = [await player(auth, true), await nonPlaying(auth, "identity-only")];
    const [goodTeam, badTeam] = [await teamWithSquad(auth.orgId, [ok]), await teamWithSquad(auth.orgId, [reconnect])];
    const seeded = (team: string): CreateEntrant => ({ display_name: "x", kind: "individual", team_id: team, members: [] });

    expect(await createEntrants(auth, divisionId, [seeded(goodTeam)]), "premise: the squad that plays enters").toHaveLength(1);
    const got = await refusalOf(createEntrants(auth, divisionId, [seeded(badTeam)]));

    expect(got).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED", ids: [reconnect.personId] });
    expect(spy.calls.map((c) => c.personIds), "the squad is not known up front").toEqual([undefined, undefined]);
    expect(await entrantCount(divisionId)).toBe(1);
  });

  // The sequence the reason exists for: told to reconnect, the player reconnects, and the very same request now enters.
  it("refused as reconnect, then the player reconnects: the same request enters them", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, true);
    const p = await nonPlaying(auth, "identity-only");
    const request = () => createEntrants(auth, divisionId, [entryOf(p, "Comes back")]);

    expect(await refusalOf(request())).toMatchObject({ code: "LICHESS_RECONSENT_REQUIRED" });
    await reconnectLichess(p);
    const created = await request();

    expect(created).toHaveLength(1);
    expect(await entrantCount(divisionId)).toBe(1);
  });

  it("an over-the-board division enters a player whose link does not play (the demand is for online play only)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, false);
    const idOnly = await nonPlaying(auth, "identity-only");

    expect(await createEntrants(auth, divisionId, [entryOf(idOnly, "Over the board")])).toHaveLength(1);
    expect(spy.calls).toEqual([]);
  });

  it("an over-the-board division reads no link set at all (negative pair of the above)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth, false);
    const unlinked = await player(auth, false);

    const created = await createEntrants(auth, divisionId, [entryOf(unlinked, "Walk-in")]);

    expect(created).toHaveLength(1);
    expect(spy.calls).toEqual([]);
  });
});

// A prelude runs privileged, BEFORE the role drops; the callback must still run as the tenant role. The proof is
// behavioural: another org's division is not visible to this org's create, online (prelude reads the link set) or not.
describe.skipIf(!HAS_DB)("createEntrants with a prelude - the tenant boundary holds", () => {
  it("another org's division is a 404 and enters nobody, online or over the board", async () => {
    const owner = await seedOwner();
    const intruder = await seedOwner();
    const theirOnline = await seedDivisionOf(owner, true);
    const theirOtb = await seedDivisionOf(owner, false);
    const mine = await player(intruder, true);
    let checked = 0;

    for (const divisionId of [theirOnline, theirOtb]) {
      await expect(createEntrants(intruder, divisionId, [entryOf(mine, "Mine")]), divisionId).rejects.toMatchObject({
        status: 404,
      });
      expect(await entrantCount(divisionId), divisionId).toBe(0);
      checked++;
    }

    expect(checked, "anti-vacuity: both divisions tried").toBe(2);
    // The intruder's own division still works: the 404 is the boundary, not a broken create.
    const ownDivision = await seedDivisionOf(intruder, true);
    expect(await createEntrants(intruder, ownDivision, [entryOf(mine, "Mine")])).toHaveLength(1);
  });
});
