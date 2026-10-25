// Switching a chess division to online play WARNS about the players who cannot be paired online yet (owner ruling
// 2026-10-25, "apply rec": allow the switch, say who is not ready; blocking is rejected - organisers switch first and
// collect links later). `listLichessLinkGaps` is the list that warning prints, so it is driven here against the real
// database, through the real usecases that build the roster, with the real Lichess-link reader behind it - not a second
// linked-ness query. "Cannot be paired online" is the SEAT gate's word, so the lists are held against the seat gate itself
// (`playGrantRefusal`, the function `seatPlayer` calls), not against a table typed here.
//
// Two kinds of gap, two lists (controller ruling, fix round 1):
//   - `unlinked`: no Lichess link at all (seat reason lichess_link_required);
//   - `reconnect`: a link that cannot play (seat reason lichess_reconsent_required): identity-only, or a grant short of a
//     play scope;
//   - `empty` (fix round 2): an entrant with NO member - nobody can claim its seat (`not_a_player`) and no game is created
//     for it (`no_person`) - named by the ENTRANT, in a list of its own: it is not a player who lacks a link, so it must
//     never be counted as one.
// The link states are read in the prelude for the division's OWN persons only (fix round 2), never the whole org.
// What each list must do, stated from the ruling and the schema (entrants_status_check, V212), not from the code:
//   - it names PEOPLE, one row each, however many entrants carry them (a link is per person, not per team);
//   - it names only people in the FIELD: a withdrawn or disqualified entrant's players are not owed a link;
//   - it is empty when nobody is short, and for a division with no entrants at all (the empty case, stated first);
//   - a player who links drops off it, and one who unlinks comes back (state in both directions, a second call included);
//   - it is the same list before and after the division is switched, and it is scoped to the caller's club.
// And the other half of the ruling: the SAVE is not blocked. `patchDivision` turns online play on with unlinked players on
// the roster - through the use-case and through the PATCH route - so a later "just refuse it" fails here.
//
// Boardgame only: it is the one sport that plays online (online-play.ts `supportsOnlinePlay`); the component suite owns the
// "another sport never shows the warning" case.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// A pass-through spy on the link-state reader: what the prelude ASKS for is asserted beside what the list DOES.
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

// Outside a Next request there is no incrementalCache (the use-cases already swallow it); a passthrough keeps the route honest.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql, type Tx } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants, listLichessLinkGaps, patchEntrant } from "../entrants";
import { PLAY_SCOPES, lichessLinkStatesByPerson, unlinkLichess, upsertLichessLink } from "../external-accounts";
import { loadSides } from "../external-play/guard";
import { playGrantRefusal } from "../external-play/preflight";
import { seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";
import { PATCH } from "@/app/api/v1/divisions/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  spy.calls.length = 0;
});

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

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

/** The no-link half of the answer. The reconnect half has its own suite below. */
const unlinkedOf = async (auth: AuthCtx, divisionId: string) => (await listLichessLinkGaps(auth, divisionId)).unlinked;

describe.skipIf(!HAS_DB)("listLichessLinkGaps.unlinked - who the online-switch warning names as having no link", () => {
  it("empty case first: a division with no entrants names nobody", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);

    expect(await unlinkedOf(auth, divisionId)).toEqual([]);
  });

  it("nobody unlinked: every player holds a link, so the list is empty (and the warning absent)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    await enter(auth, divisionId, await player(auth, "Linked One", true), "Linked One");
    await enter(auth, divisionId, await player(auth, "Linked Two", true), "Linked Two");

    expect(await unlinkedOf(auth, divisionId)).toEqual([]);
  });

  it("one unlinked among linked players: exactly that person, by person id and full name", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const ok = await player(auth, "Has Link", true);
    const missing = await player(auth, "No Link", false);
    await enter(auth, divisionId, ok, "Has Link");
    await enter(auth, divisionId, missing, "No Link");

    expect(await unlinkedOf(auth, divisionId)).toEqual([{ kind: "person", id: missing.personId, name: "No Link" }]);
  });

  it("many unlinked: all of them, alphabetical without regard to case, and no linked player among them", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    // Entered out of alphabetical order, with a lowercase initial: a case-sensitive order would put "bea" last.
    const unlinked = ["Cy Wong", "bea Lopez", "Ana Ruiz", "Dev Rao", "Eli Kim", "Fay Ode", "Gus Lund"];
    for (const n of unlinked) await enter(auth, divisionId, await player(auth, n, false), n);
    await enter(auth, divisionId, await player(auth, "Zed Linked", true), "Zed Linked");

    const got = await unlinkedOf(auth, divisionId);

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

    const got = new Set((await unlinkedOf(auth, divisionId)).map((r) => r.id));

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

    expect(names(await unlinkedOf(auth, divisionId))).toEqual(["Comes And Goes"]);
    await patchEntrant(auth, entrantId, { status: "withdrawn" });
    expect(await unlinkedOf(auth, divisionId)).toEqual([]);
    await patchEntrant(auth, entrantId, { status: "registered" });
    expect(names(await unlinkedOf(auth, divisionId))).toEqual(["Comes And Goes"]);
  });

  it("a person on a withdrawn entrant AND a live one is named once (the live entry still owes the link)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Two Entries", false);
    const gone = await enterTeam(auth, divisionId, "Old Team", [p]);
    await enterTeam(auth, divisionId, "New Team", [p]);
    await patchEntrant(auth, gone, { status: "withdrawn" });

    expect(await unlinkedOf(auth, divisionId)).toEqual([{ kind: "person", id: p.personId, name: "Two Entries" }]);
  });

  it("team events: unlinked is per PERSON - the team's unlinked members are named, not the team, and the linked member is not", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const [linked, a, b] = [await player(auth, "Tia Linked", true), await player(auth, "Uma Open", false), await player(auth, "Vic Open", false)];
    await enterTeam(auth, divisionId, "Rooks United", [linked, a, b]);
    // The same unlinked person on a second entrant of the division: still one row.
    await enterTeam(auth, divisionId, "Bishops", [a]);

    const got = await unlinkedOf(auth, divisionId);

    expect(got).toEqual([
      { kind: "person", id: a.personId, name: "Uma Open" },
      { kind: "person", id: b.personId, name: "Vic Open" },
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

    const before = await unlinkedOf(auth, divisionId);
    expect(names(before)).toEqual(["Links Later", "Never Links"]);
    expect(await unlinkedOf(auth, divisionId), "a second call").toEqual(before);

    await link(p);
    expect(names(await unlinkedOf(auth, divisionId)), "after they link").toEqual(["Never Links"]);

    await unlinkLichess(p.userId);
    expect(names(await unlinkedOf(auth, divisionId)), "after they unlink again").toEqual(["Links Later", "Never Links"]);
  });

  it("a person with no Seazn account at all (no user row) is unlinked too", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Walk In') returning id`;
    await createEntrants(auth, divisionId, [
      { display_name: "Walk In", kind: "individual", members: [{ person_id: personId, is_captain: false, roles: [] }] },
    ]);

    expect(await unlinkedOf(auth, divisionId)).toEqual([{ kind: "person", id: personId, name: "Walk In" }]);
  });

  it("is scoped to the caller's club: another club's division is a 404, and its players' links never answer for this one", async () => {
    const mine = await seedOwner();
    const theirs = await seedOwner();
    const theirDivision = await seedDivisionOf(theirs);
    await enter(theirs, theirDivision, await player(theirs, "Their Player", false), "Their Player");

    await expect(listLichessLinkGaps(mine, theirDivision)).rejects.toMatchObject({ status: 404 });
    // The prelude is not under RLS, so its own scope is what keeps it off another club's roster: it asked about nobody.
    expect(spy.calls, "the prelude ran once").toHaveLength(1);
    expect(spy.calls[0]!.personIds, "and named none of the other club's people").toEqual([]);
  });
});

/** A link made under the identity-only flow (V405): the account is known, the token and the consent never were. The two
 *  CHECKs of V451 allow exactly this shape (token and consent null together; scopes may be empty then). */
async function identityOnly(p: SeedPlayer): Promise<void> {
  await sql`
    insert into user_external_accounts (user_id, provider, external_user_id, username, scopes)
    values (${p.userId}, 'lichess', ${p.lichessId}, ${p.lichessId}, '{}'::text[])`;
}

/** A consented grant that is one play scope short: the other way a stored link cannot play. */
async function partialGrant(p: SeedPlayer): Promise<void> {
  const short = PLAY_SCOPES.length > 1 ? PLAY_SCOPES.slice(0, -1) : ["preference:read"];
  // Guard, not a comment: the grant really is short of a play scope, or this case would prove nothing.
  expect(PLAY_SCOPES.every((scope) => short.includes(scope)), "premise: the partial grant lacks a play scope").toBe(false);
  await upsertLichessLink(p.userId, { externalUserId: p.lichessId, username: p.lichessId, scopes: [...short], token: `lio_part_${p.lichessId}` });
}

/** An entrant with nobody on it, through the real use-case (what an API client that sends no `members` creates). */
async function enterMemberless(auth: AuthCtx, divisionId: string, name: string): Promise<string> {
  const [created] = await createEntrants(auth, divisionId, [{ display_name: name, kind: "individual", members: [] }]);
  return created!.id;
}

describe.skipIf(!HAS_DB)("listLichessLinkGaps.reconnect - a link that cannot play is named apart from no link", () => {
  it("empty case first: nobody entered, and everybody able to play, both name nobody", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    expect(await listLichessLinkGaps(auth, divisionId)).toEqual({ unlinked: [], reconnect: [], empty: [] });

    await enter(auth, divisionId, await player(auth, "Plays One", true), "Plays One");
    await enter(auth, divisionId, await player(auth, "Plays Two", true), "Plays Two");
    expect(await listLichessLinkGaps(auth, divisionId)).toEqual({ unlinked: [], reconnect: [], empty: [] });
  });

  // The oracle is the seat gate, not this file: `playGrantRefusal` is what `seatPlayer` calls (preflight.ts), so each
  // player's list is checked against the reason the gate actually gives them, and the table's own expectation is pinned
  // to it first - a table that disagreed with the gate would be asserting its own typing.
  it("four people, four states, swept against the seat gate: able to play is in neither list; no link is unlinked; identity-only and a short grant are reconnect", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const plays = await player(auth, "Plays Fine", true);
    const none = await player(auth, "No Link At All", false);
    const identity = await player(auth, "Identity Only", false);
    await identityOnly(identity);
    const partial = await player(auth, "Partial Grant", false);
    await partialGrant(partial);
    const table = [
      { who: plays, name: "Plays Fine", seat: null, list: "neither" },
      { who: none, name: "No Link At All", seat: "lichess_link_required", list: "unlinked" },
      { who: identity, name: "Identity Only", seat: "lichess_reconsent_required", list: "reconnect" },
      { who: partial, name: "Partial Grant", seat: "lichess_reconsent_required", list: "reconnect" },
    ] as const;
    for (const t of table) await enter(auth, divisionId, t.who, t.name);

    const gaps = await listLichessLinkGaps(auth, divisionId);

    const where = (id: string) => [gaps.unlinked, gaps.reconnect].map((l) => l.some((r) => r.id === id));
    let checked = 0;
    for (const t of table) {
      expect(await playGrantRefusal(t.who.userId), `${t.name}: the seat gate's own reason`).toBe(t.seat);
      const [inUnlinked, inReconnect] = where(t.who.personId);
      expect({ unlinked: inUnlinked, reconnect: inReconnect }, `${t.name} is listed under`).toEqual({
        unlinked: t.list === "unlinked",
        reconnect: t.list === "reconnect",
      });
      checked++;
    }
    expect(checked, "anti-vacuity: every state was checked").toBe(4);
    expect(gaps.unlinked).toEqual([{ kind: "person", id: none.personId, name: "No Link At All" }]);
    expect(gaps.reconnect).toEqual([
      { kind: "person", id: identity.personId, name: "Identity Only" },
      { kind: "person", id: partial.personId, name: "Partial Grant" },
    ]);
  });

  it("the two lists are two lists: one person is never in both, and a reconnect person is not counted as unlinked", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const a = await player(auth, "Ana Reconnect", false);
    await identityOnly(a);
    const b = await player(auth, "Bo Reconnect", false);
    await identityOnly(b);
    const c = await player(auth, "Cy Unlinked", false);
    for (const [p, n] of [[a, "Ana Reconnect"], [b, "Bo Reconnect"], [c, "Cy Unlinked"]] as const) await enter(auth, divisionId, p, n);

    const gaps = await listLichessLinkGaps(auth, divisionId);

    expect(names(gaps.unlinked)).toEqual(["Cy Unlinked"]);
    expect(names(gaps.reconnect)).toEqual(["Ana Reconnect", "Bo Reconnect"]);
    const unlinkedIds = new Set(gaps.unlinked.map((r) => r.id));
    expect(gaps.reconnect.filter((r) => unlinkedIds.has(r.id)), "no row is in both").toEqual([]);
  });

  it("a reconnect player who re-consents leaves the list; one who unlinks moves to the OTHER list; a second call agrees", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Round Trip", false);
    await identityOnly(p);
    await enter(auth, divisionId, p, "Round Trip");

    const first = await listLichessLinkGaps(auth, divisionId);
    expect(names(first.reconnect)).toEqual(["Round Trip"]);
    expect(first.unlinked).toEqual([]);
    expect(await listLichessLinkGaps(auth, divisionId), "a second call").toEqual(first);

    await link(p); // re-consent: the real upsert replaces the identity-only row with a full grant
    expect(await listLichessLinkGaps(auth, divisionId), "after they re-consent").toEqual({ unlinked: [], reconnect: [], empty: [] });

    await unlinkLichess(p.userId);
    const after = await listLichessLinkGaps(auth, divisionId);
    expect(names(after.unlinked), "after they unlink: no link at all now").toEqual(["Round Trip"]);
    expect(after.reconnect).toEqual([]);
  });

  it("only the field is named here too: a reconnect player on a withdrawn entrant is not owed anything, until reinstated", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Comes Back", false);
    await identityOnly(p);
    const entrantId = await enter(auth, divisionId, p, "Comes Back");

    expect(names((await listLichessLinkGaps(auth, divisionId)).reconnect)).toEqual(["Comes Back"]);
    await patchEntrant(auth, entrantId, { status: "withdrawn" });
    expect((await listLichessLinkGaps(auth, divisionId)).reconnect).toEqual([]);
    await patchEntrant(auth, entrantId, { status: "registered" });
    expect(names((await listLichessLinkGaps(auth, divisionId)).reconnect)).toEqual(["Comes Back"]);
  });

  it("a team sorts its members into the right list, per person", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const ok = await player(auth, "Tia Ready", true);
    const re = await player(auth, "Uma Reconnect", false);
    await identityOnly(re);
    const no = await player(auth, "Vic Nolink", false);
    await enterTeam(auth, divisionId, "Rooks United", [ok, re, no]);

    const gaps = await listLichessLinkGaps(auth, divisionId);

    expect(gaps.unlinked).toEqual([{ kind: "person", id: no.personId, name: "Vic Nolink" }]);
    expect(gaps.reconnect).toEqual([{ kind: "person", id: re.personId, name: "Uma Reconnect" }]);
  });
});

// An entrant with no member is refused at the seat: `loadSide` (external-play/guard.ts) resolves `personId` from the
// entrant's members, so a member-less side has none; `seatPlayer` answers `not_a_player` to anyone for a side without a
// person (preflight.ts), and `createGameIfReady` answers `no_person` (create-game.ts) - nobody could ever be paired.
describe.skipIf(!HAS_DB)("listLichessLinkGaps.empty - an entrant with no member cannot be paired online, so it is named, as itself", () => {
  it("premise, through the real seat loader: a member-less side has no person to seat; a side with a ready player has one", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const empty = await enterMemberless(auth, divisionId, "Empty Seat");
    const ready = await enter(auth, divisionId, await player(auth, "Ready Player", true), "Ready Player");

    const { home, away } = await loadSides({ homeEntrantId: empty, awayEntrantId: ready });

    expect(home.personId, "member-less: nobody to seat").toBeNull();
    expect(away.personId, "its positive pair: a rostered player seats").not.toBeNull();
  });

  it("is named by the ENTRANT in a list of its own, sorted case-insensitively, and is NOT counted among the players without a link", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const second = await enterMemberless(auth, divisionId, "board 2 (nobody yet)");
    const first = await enterMemberless(auth, divisionId, "Alpha Table");
    const missing = await player(auth, "Zoe Unlinked", false);
    const early = await player(auth, "Abe Unlinked", false);
    await enter(auth, divisionId, missing, "Zoe Unlinked");
    await enter(auth, divisionId, early, "Abe Unlinked");
    await enter(auth, divisionId, await player(auth, "Linked", true), "Linked");

    const gaps = await listLichessLinkGaps(auth, divisionId);

    expect(gaps.empty).toEqual([
      { kind: "entrant", id: first, name: "Alpha Table" },
      { kind: "entrant", id: second, name: "board 2 (nobody yet)" },
    ]);
    // The players without a link are the two PEOPLE and nobody else: an empty entrant is not a player with no link.
    expect(gaps.unlinked).toEqual([
      { kind: "person", id: early.personId, name: "Abe Unlinked" },
      { kind: "person", id: missing.personId, name: "Zoe Unlinked" },
    ]);
    expect(gaps.reconnect).toEqual([]);
  });

  it("an empty entrant alone: the no-link list is empty (the only gap is not a missing link)", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const id = await enterMemberless(auth, divisionId, "Nobody Yet");

    expect(await listLichessLinkGaps(auth, divisionId)).toEqual({
      unlinked: [],
      reconnect: [],
      empty: [{ kind: "entrant", id, name: "Nobody Yet" }],
    });
  });

  it("only while it is in the field and still empty: withdrawn is not named, reinstated is, and rostering someone replaces it with that person", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const id = await enterMemberless(auth, divisionId, "Open Board");
    const emptyOf = async () => (await listLichessLinkGaps(auth, divisionId)).empty;

    expect(names(await emptyOf())).toEqual(["Open Board"]);
    await patchEntrant(auth, id, { status: "disqualified" });
    expect(await emptyOf(), "disqualified").toEqual([]);
    await patchEntrant(auth, id, { status: "confirmed" });
    expect(names(await emptyOf())).toEqual(["Open Board"]);

    const p = await player(auth, "Finally Rostered", true);
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${id}, ${p.personId}, ${auth.orgId})`;
    expect(await listLichessLinkGaps(auth, divisionId), "rostered with a ready player: nothing left to say").toEqual({ unlinked: [], reconnect: [], empty: [] });
  });

  it("an entrant rostered with someone who has no link is that PERSON's gap, not an empty entrant", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const p = await player(auth, "Has A Seat No Link", false);
    await enter(auth, divisionId, p, "Has A Seat No Link");

    const gaps = await listLichessLinkGaps(auth, divisionId);

    expect(gaps.empty).toEqual([]);
    expect(gaps.unlinked).toEqual([{ kind: "person", id: p.personId, name: "Has A Seat No Link" }]);
  });
});

// Fix round 2: the Lichess-link read in the prelude is scoped to the division's own people, not the whole org (a 5,000
// player club would otherwise read every link it has to answer for eight players). It is the `personIds` argument
// `lichessLinkStatesByPerson` already took, and `createEntrants` already passes the same way for a known roster.
describe.skipIf(!HAS_DB)("the link-state read is scoped to the division's own people", () => {
  it("asks only about the people in THIS division's field: not another division's, not a withdrawn entrant's, not the org's other persons", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const otherDivision = await seedDivisionOf(auth);
    const inField = [await player(auth, "In Field A", false), await player(auth, "In Field B", true)];
    for (const p of inField) await enter(auth, divisionId, p, `Entry ${p.lichessId}`);
    const identity = await player(auth, "In Field Reconnect", false);
    await identityOnly(identity);
    await enter(auth, divisionId, identity, "Entry reconnect");
    const departed = await player(auth, "Withdrawn Player", false);
    await patchEntrant(auth, await enter(auth, divisionId, departed, "Entry departed"), { status: "withdrawn" });
    const elsewhere = await player(auth, "Other Division Player", false);
    await enter(auth, otherDivision, elsewhere, "Entry elsewhere");
    await player(auth, "Org Member Without Entry", true); // a linked person nobody entered

    await listLichessLinkGaps(auth, divisionId);

    expect(spy.calls, "the prelude read the link states once").toHaveLength(1);
    const asked = spy.calls[0]!;
    expect(asked.orgId).toBe(auth.orgId);
    expect(asked.personIds, "scoped: never the unscoped (whole-org) read").toBeDefined();
    expect([...asked.personIds!].sort()).toEqual([inField[0]!.personId, inField[1]!.personId, identity.personId].sort());
    expect(asked.personIds!.length, "anti-vacuity: it asked about someone").toBeGreaterThan(0);
  });

  it("an empty division asks about nobody (an empty list), never the whole org", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    await player(auth, "Linked Bystander", true);

    expect(await listLichessLinkGaps(auth, divisionId)).toEqual({ unlinked: [], reconnect: [], empty: [] });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.personIds).toEqual([]);
  });

  it("the scoped answers are the right ones: a reconnect and an unlinked person in the field are still told apart", async () => {
    const auth = await seedOwner();
    const divisionId = await seedDivisionOf(auth);
    const re = await player(auth, "Scoped Reconnect", false);
    await identityOnly(re);
    const none = await player(auth, "Scoped None", false);
    await enter(auth, divisionId, re, "Scoped Reconnect");
    await enter(auth, divisionId, none, "Scoped None");

    const gaps = await listLichessLinkGaps(auth, divisionId);

    expect(names(gaps.reconnect)).toEqual(["Scoped Reconnect"]);
    expect(names(gaps.unlinked)).toEqual(["Scoped None"]);
  });

  // The reader's own `personIds` argument, directly: it had no caller outside createEntrants' sibling until now.
  it("lichessLinkStatesByPerson, named ids only: answers for those and no one else, never another org's person", async () => {
    const o = await seedOwner();
    const other = await seedOwner();
    const ready = await player(o, "States Ready", true);
    const re = await player(o, "States Reconnect", false);
    await identityOnly(re);
    const none = await player(o, "States None", false);
    const foreign = await player(other, "Foreign Ready", true);
    const read = (ids?: readonly string[]) => sql.begin((tx) => lichessLinkStatesByPerson(tx, o.orgId, ids));

    expect(Object.fromEntries(await read()), "premise: unscoped is the whole org, a state per linked person").toEqual({
      [ready.personId]: "plays",
      [re.personId]: "reconnect",
    });
    expect(Object.fromEntries(await read([re.personId])), "named, reconnect").toEqual({ [re.personId]: "reconnect" });
    expect(Object.fromEntries(await read([ready.personId, none.personId])), "a named person with no link is absent").toEqual({ [ready.personId]: "plays" });
    expect(Object.fromEntries(await read([])), "naming nobody asks about nobody").toEqual({});
    expect(Object.fromEntries(await read([foreign.personId])), "another org's person, named").toEqual({});
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
    const before = await unlinkedOf(auth, divisionId);
    expect(names(before), "premise: two are unlinked going in").toEqual(["Ann Unlinked", "Ben Unlinked"]);

    const saved = await patchDivision(auth, divisionId, { variant_key: "classical", config: { ...ONLINE_CONFIG } });

    expect(saved.refused, "nothing was refused").toEqual([]);
    expect((saved.config as { onlinePlay?: string }).onlinePlay).toBe("lichess");
    expect(((await getDivision(auth, divisionId)).config as { onlinePlay?: string }).onlinePlay, "it was stored").toBe("lichess");
    // The warning stays: the same two are still owed a link once the division is online.
    expect(await unlinkedOf(auth, divisionId)).toEqual(before);
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
