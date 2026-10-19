// apps/web/src/server/usecases/__tests__/external-play-room-account.test.ts
//
// Owner staging test 2026-10-19: a player opened their personal match link while signed in to ANOTHER Seazn account,
// was told to "Link Lichess", and the link went to the wrong account. The room now knows whose seat it is and who is
// looking: the snapshot carries `account`, decided on the server from the seat's solo user and the viewer's session
// (the token identity carries the viewer; a session identity IS the seat's user, by construction).
//
//   signed out, or the seat's own account  → "ok"            (today's flow, the link prompt included)
//   signed in as someone else              → "wrong_account" (the viewer's OWN email, never the seat's)
//   a seat tied to no account              → no snapshot: 409 ROOM_SEAT_NO_ACCOUNT, for a link that VERIFIED for this
//                                            board (a seat is a person with a solo user, so there is nothing to read; no
//                                            sign-in can fix it, so it does not matter who looks)
//
// Driven through the REAL room read and seat claim against the database, on real tokens - the page and the shell are
// the other suites' (room-screen.test.ts, room-account-cards.test.tsx, play/__tests__/page.test.tsx).
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { mintMatchRoomToken } from "../match-room-token";
import { claimRoomSeat, readRoom, seatAccount, type RoomDeps, type RoomIdentity } from "../external-play/room";
import { ROOM_ACCOUNT_STATES, ROOM_SEAT_NO_ACCOUNT } from "@/components/public-site/match-room/room-snapshot";
import { makeUser } from "./_seed";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

const T = new Date(Date.now() + 5 * 60_000);
const now = new Date();

function deps(): RoomDeps {
  return {
    now,
    publish: vi.fn(async () => {}),
    create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
    offered: vi.fn(async () => true),
    mintRealtime: vi.fn(async () => "rt-token"),
  } as never;
}

async function seed(over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) {
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    roundOpenedAt: T,
    linked: true,
    homeFullName: "Ada Okonkwo",
    awayFullName: "Bo Lind",
    ...over,
  });
}

async function tokenFor(
  s: SeedOnlineChessFixtureResult,
  personId: string,
  over: Partial<{ fixtureId: string; roundOpenId: string; roundOpenedAt: Date }> = {},
): Promise<string> {
  const [open] = await sql<{ id: string; opened_at: Date }[]>`
    select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
  if (!open) throw new Error("premise: the seed opened round 1");
  return mintMatchRoomToken({
    fixtureId: over.fixtureId ?? s.fixtureId,
    personId,
    roundOpenId: over.roundOpenId ?? open.id,
    roundOpenedAt: (over.roundOpenedAt ?? open.opened_at).toISOString(),
  });
}

async function emailOf(userId: string): Promise<string> {
  const [row] = await sql<{ email: string }[]>`select email from users where id = ${userId}`;
  if (!row) throw new Error("premise: the user exists");
  return row.email;
}

const tokenAs = (token: string, viewer?: { userId: string; email: string } | null): RoomIdentity =>
  viewer === undefined ? { kind: "token", token } : { kind: "token", token, viewer };

/** Tie a seat's person to no Seazn account, as an account removed or unlinked after the link went out leaves it. */
async function untie(personId: string) {
  await sql`update persons set user_id = null where id = ${personId}`;
}

const noAccount = { status: 409, code: ROOM_SEAT_NO_ACCOUNT };

afterAll(async () => {
  await sql.end();
});

describe.skipIf(!process.env.DATABASE_URL)("match room - whose seat it is, and who is looking (snapshot.account)", () => {
  it("the four cases through the real read: signed out and the seat's own account are ok; another account is wrong_account; a seat with no account is the 409 for any viewer", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    const homeEmail = await emailOf(s.home.userId);
    const stranger = await makeUser("stranger");

    // 1. Signed out: no viewer on the token identity.
    expect((await readRoom(tokenAs(token), s.fixtureId, deps())).account).toEqual({ state: "ok" });
    // 2. The seat's own account: the viewer IS the seat's user.
    expect((await readRoom(tokenAs(token, { userId: s.home.userId, email: homeEmail }), s.fixtureId, deps())).account).toEqual({
      state: "ok",
    });
    // 3. Another account: the card names the VIEWER's own email.
    const wrong = await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps());
    expect(wrong.account).toEqual({ state: "wrong_account", viewerEmail: stranger.email });
    // 4. A seat tied to no account: nobody's sign-in can fix it, so it does not matter who looks - and the seat call says the same.
    await untie(s.home.personId);
    await expect(readRoom(tokenAs(token), s.fixtureId, deps())).rejects.toMatchObject(noAccount);
    await expect(readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps())).rejects.toMatchObject(noAccount);
    await expect(readRoom(tokenAs(token, { userId: s.home.userId, email: homeEmail }), s.fixtureId, deps())).rejects.toMatchObject(noAccount);
    await expect(claimRoomSeat(tokenAs(token), s.fixtureId, deps())).rejects.toMatchObject(noAccount);
  });

  it("the no-account answer is given ONLY to a link that verified for this board: every other failure is still the one 404", async () => {
    const s = await seed();
    const other = await seed();
    const otherOpen = (
      await sql<{ id: string }[]>`select id from stage_round_opens where stage_id = ${other.stageId} and round_no = 1`
    )[0]!;
    await untie(s.home.personId);
    const bystander = await makeUser("bystander");
    const [bystanderPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${s.orgId}, 'Bystander', ${bystander.id}) returning id`;
    const cases: [string, string][] = [
      // Each claim wrong ALONE, for the very person whose seat has no account.
      ["another fixture", await tokenFor(s, s.home.personId, { fixtureId: other.fixtureId })],
      ["another round's open", await tokenFor(s, s.home.personId, { roundOpenId: otherOpen.id })],
      ["expired", await tokenFor(s, s.home.personId, { roundOpenedAt: new Date("2000-01-01T00:00:00Z") })],
      // A valid link for a person who is NOT on this board.
      ["a person on neither side", await tokenFor(s, bystanderPerson!.id)],
      // A valid link for the OTHER side's person whose seat has an account: the room, as ever (the positive pair below).
    ];
    let checked = 0;
    for (const [label, token] of cases) {
      await expect(readRoom(tokenAs(token), s.fixtureId, deps()), label).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      await expect(claimRoomSeat(tokenAs(token), s.fixtureId, deps()), `${label} (seat)`).rejects.toMatchObject({ status: 404 });
      checked += 1;
    }
    expect(checked, "anti-vacuity: four failures, one at a time").toBe(4);
    // The positive pair: the unaffected side's own link still reads.
    expect((await readRoom(tokenAs(await tokenFor(s, s.away.personId)), s.fixtureId, deps())).you.name).toBe("Bo Lind");
    // A session of the user whose person was untied is no seat any more: the one 404, as before.
    await expect(readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).rejects.toMatchObject({ status: 404 });
  });

  it("a side with more than one member is not a chess seat: its member's link is the one 404, not 'no account'", async () => {
    const s = await seed();
    await untie(s.home.personId);
    const [second] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${s.orgId}, 'Second Member') returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${s.home.entrantId}, ${second!.id}, ${s.orgId})`;
    await expect(readRoom(tokenAs(await tokenFor(s, s.home.personId)), s.fixtureId, deps())).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("PRIVACY: the seat account's email is in no snapshot, in any state - only the viewer's own is - and not in the no-account answer", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    const seatEmail = await emailOf(s.home.userId);
    const awayEmail = await emailOf(s.away.userId);
    const stranger = await makeUser("stranger");
    expect(seatEmail.length, "premise: the seat has an email to leak").toBeGreaterThan(0);

    const snaps = [
      await readRoom(tokenAs(token), s.fixtureId, deps()),
      await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps()),
      await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps()),
    ];
    // The mismatched snapshot is the one that must carry the viewer's email and nobody else's.
    expect(JSON.stringify(snaps[1])).toContain(stranger.email);
    let checked = 0;
    for (const snap of snaps) {
      const wire = JSON.stringify(snap);
      expect(wire, `${snap.account.state}: the seat's email`).not.toContain(seatEmail);
      expect(wire, `${snap.account.state}: the opponent's email`).not.toContain(awayEmail);
      // Nor a masked form of it (its local part).
      expect(wire, `${snap.account.state}: a masked form`).not.toContain(seatEmail.split("@")[0]!);
      checked += 1;
    }
    expect(checked).toBe(3);
    // The no-account answer carries no email at all, the viewer's included.
    await untie(s.home.personId);
    const err = await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps()).catch((e) => e);
    expect(err).toMatchObject(noAccount);
    expect(JSON.stringify({ message: err.message, code: err.code, extra: err.extra })).not.toContain(stranger.email);
    expect(JSON.stringify({ message: err.message, code: err.code, extra: err.extra })).not.toContain(seatEmail);
  });

  it("the sequence: a mismatched read, then the right account on the SAME link - the card gives way to the normal flow", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.away.personId);
    const stranger = await makeUser("stranger");
    const wrong = await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps());
    expect(wrong.account.state).toBe("wrong_account");
    expect(wrong.you.name, "the card names the seat's player").toBe("Bo Lind");
    const right = await readRoom(tokenAs(token, { userId: s.away.userId, email: await emailOf(s.away.userId) }), s.fixtureId, deps());
    expect(right.account).toEqual({ state: "ok" });
    expect(right.you.name).toBe("Bo Lind");
    // And back: a read is a read, nothing was written by being wrong.
    const again = await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps());
    expect(again.account.state).toBe("wrong_account");
  });

  it("each side is its own seat: the home player's account looking at the away link is wrong, and the reverse", async () => {
    const s = await seed();
    const sides = [
      { seat: s.home, other: s.away },
      { seat: s.away, other: s.home },
    ];
    let checked = 0;
    for (const { seat, other } of sides) {
      const token = await tokenFor(s, seat.personId);
      const otherEmail = await emailOf(other.userId);
      const looking = await readRoom(tokenAs(token, { userId: other.userId, email: otherEmail }), s.fixtureId, deps());
      expect(looking.account, `${seat.personId}`).toEqual({ state: "wrong_account", viewerEmail: otherEmail });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a session identity is the seat's own user by construction: ok, with no email on the wire", async () => {
    const s = await seed();
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(v.account).toEqual({ state: "ok" });
  });

  it("the seat claim's snapshot carries it too, on the very refusal that raises the Lichess link prompt", async () => {
    // An unlinked seat: the seat call answers lichess_link_required - the prompt the owner saw.
    const s = await seed({ linked: false });
    const token = await tokenFor(s, s.home.personId);
    const stranger = await makeUser("stranger");
    const claim = await claimRoomSeat(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps());
    expect(claim.seat).toMatchObject({ seated: false, reason: "lichess_link_required" });
    expect(claim.snapshot.account).toEqual({ state: "wrong_account", viewerEmail: stranger.email });
    // The same refusal for the seat's own account and for a signed-out viewer keeps today's flow.
    const own = await claimRoomSeat(tokenAs(token, { userId: s.home.userId, email: await emailOf(s.home.userId) }), s.fixtureId, deps());
    expect(own.seat).toMatchObject({ seated: false, reason: "lichess_link_required" });
    expect(own.snapshot.account).toEqual({ state: "ok" });
    const out = await claimRoomSeat(tokenAs(token), s.fixtureId, deps());
    expect(out.snapshot.account).toEqual({ state: "ok" });
  });

  it("anti-vacuity: every state the wire names was reached by a real read", async () => {
    // The states come from the type's own list, and each is witnessed by a read (never a retyped set).
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    const stranger = await makeUser("stranger");
    const reached = new Set<string>();
    reached.add((await readRoom(tokenAs(token), s.fixtureId, deps())).account.state);
    reached.add((await readRoom(tokenAs(token, { userId: stranger.id, email: stranger.email }), s.fixtureId, deps())).account.state);
    expect([...reached].sort()).toEqual([...ROOM_ACCOUNT_STATES].sort());
    expect(ROOM_ACCOUNT_STATES.length).toBe(2);
  });
});

describe("seatAccount - the comparison itself, and its premise", () => {
  it("a resolved seat always has a solo user: a seat without one is refused loudly, never read as ok", () => {
    expect(() => seatAccount({ kind: "token", token: "t", viewer: { userId: "u", email: "u@x" } }, null)).toThrow(/solo user/);
    expect(() => seatAccount({ kind: "session", userId: "u" }, null)).toThrow(/solo user/);
  });

  it("the viewer is compared with the seat's user by id: same ⇒ ok, different ⇒ wrong_account carrying the VIEWER's email, none ⇒ ok", () => {
    expect(seatAccount({ kind: "token", token: "t", viewer: { userId: "a", email: "a@x" } }, "a")).toEqual({ state: "ok" });
    expect(seatAccount({ kind: "token", token: "t", viewer: { userId: "b", email: "b@x" } }, "a")).toEqual({
      state: "wrong_account",
      viewerEmail: "b@x",
    });
    expect(seatAccount({ kind: "token", token: "t", viewer: null }, "a")).toEqual({ state: "ok" });
    expect(seatAccount({ kind: "token", token: "t" }, "a")).toEqual({ state: "ok" });
  });
});
