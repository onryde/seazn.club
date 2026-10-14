// Final review P11: a player who re-links a DIFFERENT Lichess account while their game is live or mid-create leaves a
// board whose recorded account is no longer theirs — and M-2 has just revoked that account's grant, so nothing of
// theirs can move it from Seazn. The re-link now holds every such board for the organiser as `account_changed`.
// Re-linking the SAME account changes nothing at Lichess and holds nothing.
//
// "Live or mid-create" is M-10's predicate (stages.ts lockBoardsRefusingOnlineGames): a create sent (T9's
// `create_sent_at` marker), or a recorded game no read has seen end on a bridge our side has not closed. Driven
// through the REAL re-link (upsertLichessLink, as the OAuth callback calls it) against real bridge rows; the expected
// holds are read from the brief's rule, never from the code under test.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The hold itself is the real one; a wrapper lets ONE case make it fail (the "never silent" pair).
const real = vi.hoisted(() => ({ hold: null as null | ((...a: unknown[]) => unknown) }));
vi.mock("../external-play/result", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../external-play/result")>();
  real.hold = mod.holdForOrganiser as (...a: unknown[]) => unknown;
  return { ...mod, holdForOrganiser: vi.fn(mod.holdForOrganiser) };
});

// The pairing's colours are the real rule; ONE case makes reading them fail (R2-1's fallback).
const colours = vi.hoisted(() => ({ fail: false }));
vi.mock("../external-play/guard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../external-play/guard")>();
  return {
    ...mod,
    whiteSideOf: vi.fn(async (f: Parameters<typeof mod.whiteSideOf>[0]) => {
      if (colours.fail) throw new Error("colours unreadable");
      return mod.whiteSideOf(f);
    }),
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { PLAY_SCOPES, getLichessAccessToken, unlinkLichess, upsertLichessLink } from "../external-accounts";
import { holdForOrganiser } from "../external-play/result";
import { holdBoardsOnAccountChange } from "../external-play/account-changed";
import { readRoom } from "../external-play/room";
import { listNeedsOrganiserExternalPlay } from "../external-play";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard, type SeedSide } from "./_external-play-seed";
import { roomScreen } from "@/components/public-site/match-room/room-screen";
import { initialRoomState } from "@/components/public-site/match-room/room-state";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Call = [string, RequestInit];
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // M-2 revokes the replaced grant at Lichess; every case answers it 204 and the asserts read who was revoked.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(holdForOrganiser).mockReset().mockImplementation(real.hold as typeof holdForOrganiser);
  return () => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
  };
});

const revoked = (): (string | null)[] =>
  (fetch as unknown as { mock: { calls: Call[] } }).mock.calls
    .filter(([, i]) => i.method === "DELETE")
    .map(([, i]) => new Headers(i.headers).get("authorization"));

const relink = (side: SeedSide, externalUserId: string, token = `lio_relink_${randomUUID().slice(0, 6)}`) =>
  upsertLichessLink(side.userId, { externalUserId, username: externalUserId, scopes: [...PLAY_SCOPES], token });

/** A Lichess id nobody else holds (V439: `(provider, external_user_id)` is unique). */
const freshAccount = () => `p11-${randomUUID().slice(0, 10)}`;

async function round(fixtures: number): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
    values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
  return r;
}

/** The bridge states a board can be in when its player re-links, home White. `holds`: the brief's rule — live or
 *  mid-create. */
const STATES = {
  live: { holds: true, row: { status: "live", challenge: true, createSent: false, over: false } },
  ready: { holds: true, row: { status: "ready", challenge: true, createSent: false, over: false } },
  mid_create: { holds: true, row: { status: "pending", challenge: false, createSent: true, over: false } },
  checkin: { holds: false, row: { status: "pending", challenge: false, createSent: false, over: false } },
  game_over_unread: { holds: false, row: { status: "live", challenge: true, createSent: false, over: true } },
  finished: { holds: false, row: { status: "finished", challenge: true, createSent: false, over: true } },
  // Settled by hand while Lichess still played it: our side closed the bridge, and no read saw the game end.
  closed_by_settle: { holds: false, row: { status: "finished", challenge: true, createSent: false, over: false } },
} as const;
type State = keyof typeof STATES;

async function bridge(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, state: State): Promise<void> {
  const s = STATES[state].row;
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
       create_sent_at, mint_claimed_at, game_over_at)
    values (${b.fixtureId}, ${r.orgId}, ${s.status}, now() - interval '5 minutes',
            ${s.challenge ? `g${randomUUID().slice(0, 7)}` : null}, ${s.challenge ? "home" : null},
            ${s.challenge ? b.home.lichessId : null}, ${s.challenge ? b.away.lichessId : null},
            ${s.createSent ? new Date() : null}, ${s.createSent ? new Date() : null}, ${s.over ? new Date() : null})`;
}

const bridgeOf = async (fixtureId: string) => {
  const [row] = await sql<{ status: string; needs_reason: string | null; last_error: string | null; revoked_seat: string | null }[]>`
    select status, needs_reason, last_error, revoked_seat from fixture_external_play where fixture_id = ${fixtureId}`;
  return row ?? null;
};

describe.runIf(HAS_DB)("a re-link to a different Lichess account holds the player's live boards (P11)", () => {
  it("the empty case: re-linking the SAME account holds nothing, in any state — and the old grant is still revoked", async () => {
    let checked = 0;
    for (const state of Object.keys(STATES) as State[]) {
      const r = await round(1);
      const b = r.boards[0]!;
      await bridge(r, b, state);
      const before = await bridgeOf(b.fixtureId);
      await relink(b.home, b.home.lichessId);
      expect(await bridgeOf(b.fixtureId), state).toEqual(before);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(STATES).length);
    expect(revoked(), "M-2 still revokes each replaced token").toHaveLength(checked);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a DIFFERENT account holds the board exactly when its game is live or mid-create — for either colour", async () => {
    let checked = 0;
    let held = 0;
    for (const state of Object.keys(STATES) as State[]) {
      for (const colour of ["home", "away"] as const) {
        const r = await round(1);
        const b = r.boards[0]!;
        await bridge(r, b, state);
        const before = await bridgeOf(b.fixtureId);
        const from = b[colour].lichessId;
        const to = freshAccount();
        await relink(b[colour], to);
        const after = await bridgeOf(b.fixtureId);
        if (STATES[state].holds) {
          // Final re-review P11 (1): a seat hold — the re-linked player's OWN seat. The bridge plays home White; a
          // create in flight records no colours, so the seat is the PAIRING's (R2-1) — home White too here, with no
          // pairing card (chess.md §2: Swiss home is White). The Black-on-home pairing is its own case (R2-1 below).
          const seat = colour === "home" ? "white" : "black";
          expect(after, `${state} ${colour}`).toMatchObject({ status: "needs_organiser", needs_reason: "account_changed", revoked_seat: seat });
          expect(after!.last_error, `${state} ${colour}: the organiser's detail names both accounts`).toContain(`${from} → ${to}`);
          held += 1;
        } else {
          expect(after, `${state} ${colour}`).toEqual(before);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(Object.keys(STATES).length * 2);
    expect(held, "the live and mid-create cells").toBe(3 * 2);
    expect(checked - held, "the cells that hold nothing").toBe(4 * 2);
    // A board with no live game is never even asked — the hold's own refusal (a finished bridge) is not the filter.
    expect(vi.mocked(holdForOrganiser), "one hold asked per holding cell, none for the rest").toHaveBeenCalledTimes(held);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("the hold reaches its readers: the organiser's queue lists the board as account_changed on the re-linked seat; that player's room is frozen, the opponent's plays on (P11 (1))", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await relink(b.home, freshAccount());
    const queue = await listNeedsOrganiserExternalPlay(r.owner, r.divisionId);
    expect(queue.map((q) => [q.fixtureId, q.reason, q.revokedSeat])).toEqual([[b.fixtureId, "account_changed", "white"]]);
    const deps = {
      publish: vi.fn(async () => {}),
      create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
      offered: vi.fn(async () => true),
      mintRealtime: vi.fn(async () => "rt-token"),
    } as never;
    // The ruling: the re-linked seat cannot act (its game is on the old account); the innocent opponent keeps playing
    // and can still win on the clock (M7's reasoning) — neither room reads "held", since the game goes on.
    const want = new Map([
      [b.home.userId, { label: "the re-linked player", view: [false, false, "you"] }],
      [b.away.userId, { label: "the opponent", view: [false, true, "opponent"] }],
    ]);
    let checked = 0;
    for (const [userId, { label, view }] of want) {
      const room = await readRoom({ kind: "session", userId }, b.fixtureId, deps);
      expect([room.held, room.canAct, room.frozen], label).toEqual(view);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the hold lands BEFORE the old grant is revoked, so the organiser reads the account change, not the revoked token a move would meet", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    const atRevoke: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") atRevoke.push((await bridgeOf(b.fixtureId))!.needs_reason);
      return new Response(null, { status: 204 });
    }));
    await relink(b.home, freshAccount());
    expect(atRevoke).toEqual(["account_changed"]);
  });

  it("never silent: a listing that fails is logged by user and holds nothing — it never throws into the re-link", async () => {
    // A user id the uuid column refuses: the listing's own query fails (22P02).
    await expect(holdBoardsOnAccountChange("not-a-uuid", { from: "a", to: "b" })).resolves.toBeUndefined();
    const logged = errorSpy.mock.calls as unknown[][];
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ userId: "not-a-uuid" });
    expect(holdForOrganiser).not.toHaveBeenCalled();
  });

  it("only the re-linked player's boards: another live board in the round is untouched", async () => {
    const r = await round(2);
    const [mine, theirs] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await bridge(r, mine, "live");
    await bridge(r, theirs, "live");
    await relink(mine.away, freshAccount());
    expect((await bridgeOf(mine.fixtureId))!.needs_reason).toBe("account_changed");
    expect(await bridgeOf(theirs.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
  });

  it("a board no longer playable (decided by hand) is not held, though its bridge still reads live", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await sql`update fixtures set status = 'decided' where id = ${b.fixtureId}`;
    await relink(b.home, freshAccount());
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
  });

  it("the sequence: a second re-link — back to the first account, or on to a third — leaves the first hold as it was", async () => {
    let checked = 0;
    for (const second of ["back", "third"] as const) {
      const r = await round(1);
      const b = r.boards[0]!;
      await bridge(r, b, "live");
      const first = b.home.lichessId;
      await relink(b.home, freshAccount());
      const held = await bridgeOf(b.fixtureId);
      expect(held!.needs_reason).toBe("account_changed");
      await relink(b.home, second === "back" ? first : freshAccount());
      expect(await bridgeOf(b.fixtureId), second).toEqual(held);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a board already held for another reason keeps that reason (a mid-game hold never replaces the first diagnosis)", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "provider_error", detail: "first" });
    await relink(b.home, freshAccount());
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "provider_error", last_error: "first" });
  });

  it("a re-link that fails (the account is another Seazn user's: 409) holds nothing and revokes nothing", async () => {
    const r = await round(2);
    const [mine, theirs] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await bridge(r, mine, "live");
    await expect(relink(mine.home, theirs.home.lichessId)).rejects.toMatchObject({ status: 409, code: "LICHESS_ALREADY_LINKED" });
    expect(await bridgeOf(mine.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
    expect(revoked()).toEqual([]);
  });

  it("a FIRST link (no row before it) is not a re-link and holds nothing", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    // No link on file, and nothing held by its removal: the row goes by hand, not through the unlink (which holds).
    await sql`delete from user_external_accounts where user_id = ${b.home.userId} and provider = 'lichess'`;
    await relink(b.home, freshAccount());
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
    expect(vi.mocked(holdForOrganiser)).not.toHaveBeenCalled();
  });

  it("never silent: a hold that fails is logged by user and board, the other board is still held, and the link and the revoke stand", async () => {
    // The same player on two live boards (a double round, say): the first hold fails, the second must still land.
    const r = await round(2);
    const [b1, b2] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await sql`update fixtures set home_entrant_id = ${b1.home.entrantId} where id = ${b2.fixtureId}`;
    await bridge(r, b1, "live");
    await bridge(r, b2, "live");
    const order = [b1.fixtureId, b2.fixtureId].sort();
    vi.mocked(holdForOrganiser).mockImplementationOnce(async () => {
      throw new HttpError(500, "boom", "TEST_HOLD_FAILED");
    });
    const to = freshAccount();
    const token = "lio_p11_after_fail";
    await relink(b1.home, to, token);
    expect(vi.mocked(holdForOrganiser).mock.calls.map(([a]) => a.fixtureId), "both boards asked, in fixture order").toEqual(order);
    expect(await bridgeOf(order[0]!)).toMatchObject({ status: "live", needs_reason: null });
    expect((await bridgeOf(order[1]!))!.needs_reason).toBe("account_changed");
    const logged = errorSpy.mock.calls as unknown[][];
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ userId: b1.home.userId, fixtureId: order[0] });
    expect(JSON.stringify(logged), "never the token").not.toContain(token);
    expect(await getLichessAccessToken(b1.home.userId)).toBe(token);
    expect(revoked(), "the old grant is revoked all the same").toEqual([`Bearer lio_seed_${b1.home.lichessId}`]);
  });
});

// Final re-review P11 (4): UNLINKING mid-game leaves the same board P11 holds on a re-link — a game recorded for an
// account that is no longer linked, whose grant the unlink revokes at Lichess. It is held as `token_revoked` (the
// unlink revokes Seazn's access, which is exactly that sentence; `account_changed` would tell the organiser a
// different account was linked, which an unlink never does), on the unlinking player's seat, before the revoke.
describe.runIf(HAS_DB)("an unlink holds the player's live boards as token_revoked (P11 (4))", () => {
  const unlink = (side: SeedSide) => unlinkLichess(side.userId);

  it("holds the board exactly when its game is live or mid-create — on the unlinking player's own seat, for either colour — counted", async () => {
    let checked = 0;
    let held = 0;
    for (const state of Object.keys(STATES) as State[]) {
      for (const colour of ["home", "away"] as const) {
        const r = await round(1);
        const b = r.boards[0]!;
        await bridge(r, b, state);
        const before = await bridgeOf(b.fixtureId);
        await unlink(b[colour]);
        const after = await bridgeOf(b.fixtureId);
        if (STATES[state].holds) {
          // The bridge plays home White; a create in flight records no colours ⇒ the PAIRING's seat (R2-1), home
          // White with no pairing card (chess.md §2).
          const seat = colour === "home" ? "white" : "black";
          expect(after, `${state} ${colour}`).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: seat });
          expect(after!.last_error, `${state} ${colour}: the organiser's detail names the account`).toContain(b[colour].lichessId);
          held += 1;
        } else {
          expect(after, `${state} ${colour}: no live game, nothing held`).toEqual(before);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(Object.keys(STATES).length * 2);
    expect(held, "the live and mid-create cells").toBe(3 * 2);
    expect(checked - held, "the cells that hold nothing").toBe(4 * 2);
    expect(vi.mocked(holdForOrganiser), "one hold asked per holding cell, none for the rest").toHaveBeenCalledTimes(held);
    expect(revoked(), "every unlink still revokes its grant").toHaveLength(checked);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("the empty case: a player with no link — and an unlink run twice — holds nothing and revokes nothing more", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await unlink(b.home);
    const held = await bridgeOf(b.fixtureId);
    expect(held!.needs_reason).toBe("token_revoked");
    vi.mocked(holdForOrganiser).mockClear();
    await unlink(b.home);
    expect(await bridgeOf(b.fixtureId), "the second unlink finds no link").toEqual(held);
    expect(vi.mocked(holdForOrganiser)).not.toHaveBeenCalled();
    expect(revoked(), "one grant, revoked once").toHaveLength(1);
  });

  it("the hold lands BEFORE the grant is revoked at Lichess, and the link row goes after both", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    const atRevoke: [string | null, number][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from user_external_accounts where user_id = ${b.home.userId} and provider = 'lichess'`;
        atRevoke.push([(await bridgeOf(b.fixtureId))!.needs_reason, n]);
      }
      return new Response(null, { status: 204 });
    }));
    await unlink(b.home);
    expect(atRevoke, "held, the link still on file").toEqual([["token_revoked", 1]]);
  });

  it("the hold reaches its readers: the queue lists token_revoked on the unlinking seat; that player's room is frozen, the opponent's plays on", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await unlink(b.away);
    const queue = await listNeedsOrganiserExternalPlay(r.owner, r.divisionId);
    expect(queue.map((q) => [q.fixtureId, q.reason, q.revokedSeat])).toEqual([[b.fixtureId, "token_revoked", "black"]]);
    const deps = {
      publish: vi.fn(async () => {}),
      create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
      offered: vi.fn(async () => true),
      mintRealtime: vi.fn(async () => "rt-token"),
    } as never;
    const room = await readRoom({ kind: "session", userId: b.home.userId }, b.fixtureId, deps);
    expect([room.held, room.canAct, room.frozen], "the opponent plays on").toEqual([false, true, "opponent"]);
  });

  it("the sequence: unlink, then link a DIFFERENT account — the unlink's hold stands as it was (a first link holds nothing more)", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    await unlink(b.home);
    const held = await bridgeOf(b.fixtureId);
    expect(held).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "white" });
    await relink(b.home, freshAccount());
    expect(await bridgeOf(b.fixtureId)).toEqual(held);
  });

  it("never silent, never blocking: a hold that fails is logged by user and board, and the unlink still revokes and removes the link", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    await bridge(r, b, "live");
    vi.mocked(holdForOrganiser).mockImplementationOnce(async () => {
      throw new HttpError(500, "boom", "TEST_HOLD_FAILED");
    });
    await expect(unlink(b.home)).resolves.toBeUndefined();
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
    const logged = errorSpy.mock.calls as unknown[][];
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ userId: b.home.userId, fixtureId: b.fixtureId });
    expect(revoked()).toEqual([`Bearer lio_seed_${b.home.lichessId}`]);
    expect(await getLichessAccessToken(b.home.userId), "the link is gone").toBeNull();
  });
});

// Final re-review 2, R2-1: a hold an unlink or a re-link raises must not tell the player who did NOTHING that their
// link was revoked, or send them to re-link. The player whose account changed keeps A (its own words and its
// re-link); the other reads the neutral hold (no button). The expected screens are the brief's rule: on a live
// board the innocent plays on (P11 (1)); on a mid-create board there is no game to play on, so the board is with
// the organiser. Driven through the REAL unlink / re-link, the real room read and the real screen decision.
describe.runIf(HAS_DB)("R2-1: whoever did not change reads a neutral hold, never 'your link was revoked'", () => {
  const deps = () =>
    ({
      publish: vi.fn(async () => {}),
      create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
      offered: vi.fn(async () => true),
      mintRealtime: vi.fn(async () => "rt-token"),
    }) as never;
  const screenOf = async (userId: string, fixtureId: string) => {
    const snap = await readRoom({ kind: "session", userId }, fixtureId, deps());
    return roomScreen(initialRoomState(snap, Date.now())).kind;
  };

  it("both seats, both triggers (unlink, re-link), live and mid-create — the changer reads A, the other never does — counted", async () => {
    const WANT = {
      live: { changer: "revoked", other: "live" },
      mid_create: { changer: "revoked", other: "seatHeld" },
    } as const;
    let checked = 0;
    for (const trigger of ["unlink", "relink"] as const) {
      for (const state of ["live", "mid_create"] as const) {
        for (const changer of ["home", "away"] as const) {
          const r = await round(1);
          const b = r.boards[0]!;
          await bridge(r, b, state);
          const other = changer === "home" ? "away" : "home";
          if (trigger === "unlink") await unlinkLichess(b[changer].userId);
          else await relink(b[changer], freshAccount());
          const label = `${trigger} ${state} ${changer}`;
          expect((await bridgeOf(b.fixtureId))!.status, `${label}: premise — held`).toBe("needs_organiser");
          expect(await screenOf(b[changer].userId, b.fixtureId), `${label}: the changer`).toBe(WANT[state].changer);
          expect(await screenOf(b[other].userId, b.fixtureId), `${label}: the other player`).toBe(WANT[state].other);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 2 * 2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("mid-create, the seat is the PAIRING's colour: with Black on home (a pairing card), home's re-link holds Black, and home's room is the frozen one", async () => {
    const r = await round(1);
    const b = r.boards[0]!;
    const auth = await mintOrgOwnerAuth(r.orgId);
    const st = await getFixtureState(auth, b.fixtureId);
    await scoreEvent(auth, b.fixtureId, { expected_seq: st.last_seq, type: "boardgame.pairing", payload: { white: b.away.entrantId } });
    await bridge(r, b, "mid_create");
    await relink(b.home, freshAccount());
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ needs_reason: "account_changed", revoked_seat: "black" });
    const home = await readRoom({ kind: "session", userId: b.home.userId }, b.fixtureId, deps());
    const away = await readRoom({ kind: "session", userId: b.away.userId }, b.fixtureId, deps());
    expect([home.you.colour, home.frozen], "home is Black, and frozen").toEqual(["black", "you"]);
    expect([away.you.colour, away.frozen], "away is White, and plays nobody's freeze").toEqual(["white", "opponent"]);
  });

  it("never silent, never unheld: a mid-create board whose colours cannot be read is held with NO seat (both frozen, nobody blamed — each reads the neutral hold), logged by user and board; a live board's recorded colours are never asked", async () => {
    const r = await round(2);
    const [mid, live] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await sql`update fixtures set home_entrant_id = ${mid.home.entrantId} where id = ${live.fixtureId}`;
    await bridge(r, mid, "mid_create");
    await bridge(r, live, "live");
    colours.fail = true;
    try {
      await relink(mid.home, freshAccount());
    } finally {
      colours.fail = false;
    }
    expect(await bridgeOf(mid.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "account_changed", revoked_seat: null });
    expect(await bridgeOf(live.fixtureId), "the recorded colours stand").toMatchObject({ needs_reason: "account_changed", revoked_seat: "white" });
    const logged = errorSpy.mock.calls as unknown[][];
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ userId: mid.home.userId, fixtureId: mid.fixtureId });
    let checked = 0;
    for (const side of [mid.home, mid.away]) {
      expect(await screenOf(side.userId, mid.fixtureId), side === mid.home ? "home" : "away").toBe("seatHeld");
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});
