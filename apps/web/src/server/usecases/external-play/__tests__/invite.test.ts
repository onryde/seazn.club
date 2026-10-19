// T19 — the invite helpers and the organiser's Resend (re-homed here from the
// deleted usecases/external-play.ts). The per-seat stamp is the invite record;
// these pin what may write it and what may clear it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { backendPid, pollWaitersBehind } from "./_lock-waiters";
import { HttpError } from "@/lib/errors";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS, WINDOW_OPEN_LEAD_MS, boardAnchor, windowFor } from "@/server/external-play/window";

const mail = vi.hoisted(() => ({
  sent: [] as { to: string; fixtureUrl: string; deadlineLabel: string; opensLabel: string | undefined; locale: string }[],
  fail: new Set<string>(),
  throws: new Set<string>(),
  // The FIRST send to this address waits on `gate` (review M6's staging).
  holdFirst: null as null | { to: string; gate: Promise<void>; reached: () => void },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1], locale: string) => {
        const hold = mail.holdFirst;
        if (hold && hold.to === to) {
          mail.holdFirst = null;
          hold.reached();
          await hold.gate;
        }
        if (mail.throws.has(to)) throw new Error("provider exploded");
        if (mail.fail.has(to)) return false;
        mail.sent.push({ to, fixtureUrl: args.fixtureUrl, deadlineLabel: args.deadlineLabel, opensLabel: args.opensLabel, locale });
        return true;
      },
    ),
  };
});

const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

import { openRound } from "../open-round";
import { claimSeat, releaseSeat, resendExternalPlayNotice } from "../invite";
import { readRoom } from "../room";
import { createGameIfReady } from "../create-game";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { addFixture } from "../../stages";
import {
  seedOnlineChessRound,
  seedOnlineChessRoundWithRankedBoard,
  seedOwner,
  type SeedOnlineChessRoundResult,
} from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;

beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
  mail.throws.clear();
  mail.holdFirst = null;
  vi.clearAllMocks();
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Row = {
  round_open_id: string | null;
  white_emailed_at: Date | null;
  black_emailed_at: Date | null;
  status: string;
  challenge_id: string | null;
  create_sent_at: Date | null;
};
async function rowOf(fixtureId: string): Promise<Row | null> {
  const [r] = await sql<Row[]>`
    select round_open_id, white_emailed_at, black_emailed_at, status, challenge_id, create_sent_at
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return r ?? null;
}
async function openId(stageId: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select id from stage_round_opens where stage_id = ${stageId} and round_no = 1`;
  return r!.id;
}
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal");
}
const open = (r: SeedOnlineChessRoundResult, now?: Date) =>
  openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, now ? { now } : {});
const ORIGIN = "https://seazn.test";

describe.skipIf(!HAS_DB)("claimSeat / releaseSeat — the stamp's own guards", () => {
  it("claims an empty seat once; a second claim of the same seat answers false", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    mail.fail.add(r.boards[0]!.home.email).add(r.boards[0]!.away.email);
    await open(r); // stamps the round, attaches the row, both sends fail ⇒ both released
    const id = await openId(r.stageId);
    const f = r.boards[0]!.fixtureId;
    // A send that reached nobody unbinds the row (fix round 1): the binding is
    // the round's "someone was invited" record.
    expect(await rowOf(f)).toMatchObject({ round_open_id: null, white_emailed_at: null, black_emailed_at: null });
    await sql`update fixture_external_play set round_open_id = ${id} where fixture_id = ${f}`; // stands for attachToOpen

    const at = new Date();
    expect(await claimSeat(sql, f, "white", id, at)).toBe(true);
    expect(await claimSeat(sql, f, "white", id, new Date(at.getTime() + 1000))).toBe(false);
    expect((await rowOf(f))!.white_emailed_at!.getTime()).toBe(at.getTime());
    // the other colour is its own seat
    expect(await claimSeat(sql, f, "black", id, at)).toBe(true);
  });

  it("refuses a row that names another open, and a row a game (or a maybe-game) stands behind", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    mail.fail.add(r.boards[0]!.home.email).add(r.boards[0]!.away.email);
    await open(r);
    const id = await openId(r.stageId);
    const f = r.boards[0]!.fixtureId;
    await sql`update fixture_external_play set round_open_id = ${id} where fixture_id = ${f}`; // stands for attachToOpen
    expect(await claimSeat(sql, f, "white", randomUUID(), new Date())).toBe(false);

    await sql`update fixture_external_play set create_sent_at = now() where fixture_id = ${f}`;
    expect(await claimSeat(sql, f, "white", id, new Date()), "create marker").toBe(false);
    await sql`update fixture_external_play set create_sent_at = null, challenge_id = ${`gm-${randomUUID().slice(0, 12)}`} where fixture_id = ${f}`;
    expect(await claimSeat(sql, f, "white", id, new Date()), "challenge").toBe(false);
    await sql`update fixture_external_play set challenge_id = null, status = 'needs_organiser', needs_reason = 'provider_error' where fixture_id = ${f}`;
    expect(await claimSeat(sql, f, "white", id, new Date()), "held").toBe(false);
    // positive pair: back to a plain pending row, the same claim succeeds
    await sql`update fixture_external_play set status = 'pending', needs_reason = null where fixture_id = ${f}`;
    expect(await claimSeat(sql, f, "white", id, new Date())).toBe(true);
  });

  it("releaseSeat clears only the exact stamp the caller wrote", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await open(r);
    const f = r.boards[0]!.fixtureId;
    const stamped = (await rowOf(f))!.white_emailed_at!;
    await releaseSeat(sql, f, "white", new Date(stamped.getTime() + 1));
    expect((await rowOf(f))!.white_emailed_at!.getTime(), "someone else's stamp survives").toBe(stamped.getTime());
    await releaseSeat(sql, f, "white", stamped);
    expect((await rowOf(f))!.white_emailed_at).toBeNull();
    expect((await rowOf(f))!.black_emailed_at, "the other seat is untouched").not.toBeNull();
    expect((await rowOf(f))!.round_open_id, "a seat still reached keeps the row bound").not.toBeNull();
    // ...and un-stamping the last reached seat unbinds the row.
    await releaseSeat(sql, f, "black", (await rowOf(f))!.black_emailed_at!);
    expect(await rowOf(f)).toMatchObject({ round_open_id: null, white_emailed_at: null, black_emailed_at: null });
  });
});

describe.skipIf(!HAS_DB)("sendFixtureInvite — a throwing provider is a failed send", () => {
  it("an exception from the sender un-stamps that seat and reports send_failed; the open still completes", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.throws.add(b.away.email);
    expect(await open(r)).toEqual({
      opened: true,
      invited: 1,
      skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }],
    });
    const row = (await rowOf(b.fixtureId))!;
    expect([row.white_emailed_at, row.black_emailed_at].filter((x) => x !== null)).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("resendExternalPlayNotice", () => {
  it("refuses a round the organiser has not opened — nothing sent, no row written", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const f = r.boards[0]!.fixtureId;
    expect(await refusal(resendExternalPlayNotice(r.owner, f, ORIGIN))).toEqual({
      status: 409,
      code: "ROUND_NOT_OPEN",
    });
    expect(mail.sent).toHaveLength(0);
    expect(await rowOf(f)).toBeNull();
  });

  it("re-sends both seats after the open, to the board's own page", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r);
    mail.sent.length = 0;
    expect(await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN)).toEqual({ emailed: 2 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual([b.home.email, b.away.email].sort());
    expect(mail.sent.every((m) => m.fixtureUrl.startsWith(ORIGIN) && m.fixtureUrl.includes(b.fixtureId))).toBe(true);
  });

  it("T14: each invite links the player's OWN match room, and its personal link resolves to their seat with no session", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r);
    mail.sent.length = 0;
    await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);
    let checked = 0;
    for (const player of [b.home, b.away]) {
      const sent = mail.sent.find((m) => m.to === player.email)!;
      const link = new URL(sent.fixtureUrl);
      expect(link.origin).toBe(new URL(ORIGIN).origin);
      expect(link.pathname).toMatch(new RegExp(`^/shared/[^/]+/[^/]+/[^/]+/fixtures/${b.fixtureId}/play$`));
      const t = link.searchParams.get("t");
      expect(t, "a personal link token").toBeTruthy();
      const byLink = await readRoom({ kind: "token", token: t! }, b.fixtureId);
      // The link is THIS player's seat: the same view their own session reads.
      const bySession = await readRoom({ kind: "session", userId: player.userId }, b.fixtureId);
      expect([byLink.you.name, byLink.you.colour, byLink.opponent.name]).toEqual([
        bySession.you.name,
        bySession.you.colour,
        bySession.opponent.name,
      ]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both seats' links resolved").toBe(2);
  });

  it("stamps a seat whose open-round send failed, so the next open does not mail it a second time", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r);
    mail.fail.clear();
    expect(await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN)).toEqual({ emailed: 2 });
    const row = (await rowOf(b.fixtureId))!;
    expect(row.white_emailed_at).not.toBeNull();
    expect(row.black_emailed_at).not.toBeNull();
    mail.sent.length = 0;
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(0);
  });

  it("a resend the provider refuses is not counted and leaves that seat un-stamped", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r); // home's send fails ⇒ home un-stamped
    const before = (await rowOf(b.fixtureId))!;
    const homeCol = before.white_emailed_at === null ? "white_emailed_at" : "black_emailed_at";
    expect(await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN)).toEqual({ emailed: 1 });
    expect((await rowOf(b.fixtureId))![homeCol], "a refused send records no invite").toBeNull();
  });

  it("a board whose game was made before any invite: Resend REFUSES 409 ONLINE_GAME_EXISTS, mails nobody, and leaves the row exactly as it was", async () => {
    // Reached by the real path: a board added to the round after the open,
    // seated and created by its players before the organiser opened again.
    // The same rule openRound applies: no invite into a board a game stands
    // behind (review M6).
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    await open(r);
    const { fixture_id } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: r.spares[0]!.home.entrantId,
      away_entrant_id: r.spares[0]!.away.entrantId,
      round_no: 1,
      scheduled_at: "2026-10-01T12:10:00.000Z",
    });
    expect((await createGameIfReady(fixture_id, { publish: async () => undefined })).created).toBe(true);
    const before = (await rowOf(fixture_id))!;
    expect(before.challenge_id, "premise: a game").not.toBeNull();
    expect(before.round_open_id, "premise: never attached to the open").toBeNull();
    mail.sent.length = 0;

    expect(await refusal(resendExternalPlayNotice(r.owner, fixture_id, ORIGIN))).toEqual({
      status: 409,
      code: "ONLINE_GAME_EXISTS",
    });
    expect(mail.sent).toHaveLength(0);
    expect(await rowOf(fixture_id)).toEqual(before);
  });

  it("a create of unknown outcome (a game MAY exist) ⇒ 409 ONLINE_GAME_EXISTS; a held board without one ⇒ 409 BOARD_HELD", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    await open(r);
    const [a, b] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
    await createGameIfReady(a.fixtureId, { publish: async () => undefined });
    expect((await rowOf(a.fixtureId))!.create_sent_at, "premise: the T9 marker").not.toBeNull();
    // A hold with no game behind it, forced by SQL (T13's no-show sweep is
    // not built): the organiser decides that board, not an invite.
    await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'provider_error'
               where fixture_id = ${b.fixtureId}`;
    mail.sent.length = 0;
    expect(await refusal(resendExternalPlayNotice(r.owner, a.fixtureId, ORIGIN))).toEqual({
      status: 409,
      code: "ONLINE_GAME_EXISTS",
    });
    expect(await refusal(resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN))).toEqual({
      status: 409,
      code: "BOARD_HELD",
    });
    expect(mail.sent).toHaveLength(0);
  });

  it("the window rule openRound holds: after the deadline a resend is refused 409 WINDOW_CLOSED and mails nobody", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    const t0 = new Date(Date.now() - DEADLINE_AFTER_MS - MIN);
    mail.fail.add(b.home.email); // a seat left to invite: the case a resend exists for
    await open(r, t0);
    mail.fail.clear();
    mail.sent.length = 0;
    const before = await rowOf(b.fixtureId);
    expect(await refusal(resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN))).toEqual({
      status: 409,
      code: "WINDOW_CLOSED",
    });
    expect(mail.sent).toHaveLength(0);
    expect(await rowOf(b.fixtureId)).toEqual(before);
    // positive pair: one minute inside the deadline it sends.
    const r2 = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await open(r2, new Date(Date.now() - DEADLINE_AFTER_MS + MIN));
    mail.sent.length = 0;
    expect(await resendExternalPlayNotice(r2.owner, r2.boards[0]!.fixtureId, ORIGIN)).toEqual({ emailed: 2 });
  });

  it("the per-seat lock: a resend claims an un-invited seat BEFORE it sends, so an open racing it does not mail that seat again", async () => {
    // Staged, not raced. Home's open-round send failed (un-stamped). The
    // resend's send to home is held at the provider; while it is held, the
    // organiser opens the round again. The resend's claim — made under the
    // division lock, before the send — is what the open sees.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r);
    mail.fail.clear();
    mail.sent.length = 0;
    let release!: () => void;
    let reached!: () => void;
    const atProvider = new Promise<void>((res) => (reached = res));
    mail.holdFirst = { to: b.home.email, gate: new Promise<void>((res) => (release = res)), reached };

    const resend = resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);
    await atProvider;
    expect(await open(r), "the resend's claim already holds home").toEqual({
      opened: false,
      reason: "already_open",
      skipped: [],
    });
    release();
    expect(await resend).toEqual({ emailed: 2 });
    expect(mail.sent.filter((m) => m.to === b.home.email), "home mailed exactly once").toHaveLength(1);
  });

  it("the division lock: a resend waits for a pairing write holding it", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await open(r);
    mail.sent.length = 0;
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      let done = false;
      const p = resendExternalPlayNotice(r.owner, r.boards[0]!.fixtureId, ORIGIN).finally(() => (done = true));
      // I-3: only a session blocked by OUR holder counts — another suite's lock waiter never does.
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%", finished: () => done })) > 0;
      expect(done, "the resend ran through a held division lock").toBe(false);
      expect(waited).toBe(true);
      await holder`commit`;
      expect(await p).toEqual({ emailed: 2 });
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  });

  // Review M6 (fix round 1): the bridge row is read FOR UPDATE, so T9's
  // claim marker cannot land between the resend's game check and its seat
  // claim. Staged: a writer holds the row while it sets the marker T9's claim
  // sets (`create_sent_at`). The resend must wait for it, then see the marker
  // and refuse. Without the lock it reads "no game", waits only at its
  // attach, and then mails a board whose game is being made.
  it("the bridge row lock: a resend racing T9's create marker waits for it, then refuses 409 ONLINE_GAME_EXISTS and mails nobody", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const f = r.boards[0]!.fixtureId;
    await open(r);
    mail.sent.length = 0;
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`update fixture_external_play set create_sent_at = now(), updated_at = now() where fixture_id = ${f}`;
      let done = false;
      const p = resendExternalPlayNotice(r.owner, f, ORIGIN).finally(() => (done = true));
      p.catch(() => undefined);
      // I-3: only a session blocked by OUR holder counts — another suite's lock waiter never does.
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%fixture_external_play%", finished: () => done })) > 0;
      expect(done, "the resend ran through a held bridge row").toBe(false);
      expect(waited).toBe(true);
      await holder`commit`;
      expect(await refusal(p)).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
      expect(mail.sent).toHaveLength(0);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  });

  // Review M6 (fix round 1): the resend re-reads the board under the
  // division lock. A re-pair that holds the lock while the resend waits must
  // not leave the resend mailing the board's OLD players. Staged: the holder
  // re-seats home by SQL inside the held lock, as unpair + generate would
  // under that same lock.
  it("a board re-paired while the resend waits on the division lock ⇒ 409 ROUND_CHANGED; its old players are not mailed", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const f = r.boards[0]!.fixtureId;
    await open(r);
    mail.sent.length = 0;
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      await holder`update fixtures set home_entrant_id = ${r.spares[0]!.home.entrantId} where id = ${f}`;
      let done = false;
      const p = resendExternalPlayNotice(r.owner, f, ORIGIN).finally(() => (done = true));
      p.catch(() => undefined);
      // I-3: only a session blocked by OUR holder counts — another suite's lock waiter never does.
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%", finished: () => done })) > 0;
      expect(done, "the resend ran through a held division lock").toBe(false);
      expect(waited).toBe(true);
      await holder`commit`;
      expect(await refusal(p)).toEqual({ status: 409, code: "ROUND_CHANGED" });
      expect(mail.sent).toHaveLength(0);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  });

  it("another organisation's caller gets the same 404 as a board that is not online", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await open(r);
    mail.sent.length = 0;
    const stranger = await seedOwner();
    expect(await refusal(resendExternalPlayNotice(stranger, r.boards[0]!.fixtureId, ORIGIN))).toEqual({
      status: 404,
      code: undefined,
    });
    expect(await refusal(resendExternalPlayNotice(r.owner, randomUUID(), ORIGIN))).toEqual({
      status: 404,
      code: undefined,
    });
    expect(mail.sent).toHaveLength(0);
  });

  it("a finished bridge ⇒ 409 ALREADY_RESOLVED; a withdrawn board ⇒ 409 FIXTURE_NOT_PLAYABLE", async () => {
    // Forced by SQL: the sync that writes 'finished' and the withdrawal that
    // writes 'abandoned' are not this task's subjects.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    await open(r);
    mail.sent.length = 0;
    const [a, b] = r.boards;
    await sql`update fixture_external_play set status = 'finished', challenge_id = ${`gm-${randomUUID().slice(0, 12)}`} where fixture_id = ${a!.fixtureId}`;
    expect(await refusal(resendExternalPlayNotice(r.owner, a!.fixtureId, ORIGIN))).toEqual({
      status: 409,
      code: "ALREADY_RESOLVED",
    });
    await sql`update fixtures set status = 'abandoned' where id = ${b!.fixtureId}`;
    expect(await refusal(resendExternalPlayNotice(r.owner, b!.fixtureId, ORIGIN))).toEqual({
      status: 409,
      code: "FIXTURE_NOT_PLAYABLE",
    });
    expect(mail.sent).toHaveLength(0);
  });
});

// ─── Timed check-in batches in the mail and the resend (spec §3.2.1; capacity tests 6 [reader:invite] [reader:resend], 12) ───
// The expected instants are written from the constants (OPENED + batch x CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS). The label
// FORMAT is the mail's own and is not what is under test, so the expected label is made with the same Intl options.
describe.skipIf(!HAS_DB)("invites and resend in timed batches", () => {
  const OPENED = new Date("2026-10-01T12:00:30.000Z");
  const S = CHECKIN_BATCH_SIZE;
  const batchStart = (batch: number) => new Date(OPENED.getTime() + batch * CHECKIN_BATCH_GAP_MS);
  const label = (at: Date, locale: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
  const seedRound = () => seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
  /** What the mail may name for an opening: the instant rounded UP to the next whole minute (written here, not read from the mail). */
  const promised = (at: Date) => new Date(Math.ceil(at.getTime() / MIN) * MIN);

  it("[reader:invite] each mail names its BOARD's own deadline; a board in batch 2 also names when its check-in opens, batch 0 does not", async () => {
    const r = await seedRound();
    await open(r, OPENED);
    const first = r.boards[0]!;
    let checked = 0;
    for (const [b, batch] of [[first, 0], [r.ranked, 2]] as const) {
      for (const p of [b.home, b.away]) {
        const m = mail.sent.find((x) => x.to === p.email);
        expect(m, `batch ${batch}: ${p.email} was mailed`).toBeDefined();
        expect(m!.deadlineLabel, `batch ${batch} deadline`).toBe(label(new Date(batchStart(batch).getTime() + DEADLINE_AFTER_MS), m!.locale));
        if (batch === 0) expect(m!.opensLabel, "batch 0 opens at the Open press: no opens-at line").toBeUndefined();
        else expect(m!.opensLabel, `batch ${batch} opens-at`).toBe(label(promised(batchStart(batch)), m!.locale));
        checked += 1;
      }
    }
    expect(mail.sent.length, "exactly the four seats of the two real boards").toBe(4);
    expect(checked, "anti-vacuity").toBe(4);
    expect(label(batchStart(2), "en"), "premise: the two boards' deadlines read differently").not.toBe(label(batchStart(0), "en"));
  });

  it("the mail's opens-at never names a minute BEFORE the batch really opens: an opening at :00 s is named as it is, at :01 and :59 s it is named at the next whole minute (the build review's M-1)", async () => {
    // Batch 2 opens 2 x CHECKIN_BATCH_GAP_MS after the open, and the gap is whole minutes, so the seconds of the open ARE the seconds of the opening.
    expect(CHECKIN_BATCH_GAP_MS % MIN, "premise: the gap is a whole number of minutes").toBe(0);
    const cases = [
      { sec: "00", roundsUp: false },
      { sec: "01", roundsUp: true },
      { sec: "59", roundsUp: true },
    ] as const;
    const seen: string[] = [];
    for (const c of cases) {
      mail.sent.length = 0;
      const opened = new Date(`2026-10-01T12:00:${c.sec}.000Z`);
      const r = await seedRound();
      await open(r, opened);
      const m = mail.sent.find((x) => x.to === r.ranked.home.email);
      expect(m, `:${c.sec}: the ranked board's player was mailed`).toBeDefined();
      const real = new Date(opened.getTime() + 2 * CHECKIN_BATCH_GAP_MS);
      const named = c.roundsUp ? new Date(Math.floor(real.getTime() / MIN) * MIN + MIN) : real;
      expect(named.getTime(), `:${c.sec}: the named minute is never before the real opening`).toBeGreaterThanOrEqual(real.getTime());
      expect(named.getTime() - real.getTime(), `:${c.sec}: and no more than a minute after it`).toBeLessThan(MIN);
      expect(m!.opensLabel, `:${c.sec}: opens-at`).toBe(label(named, m!.locale));
      seen.push(m!.opensLabel!);
    }
    expect(seen.length, "openings driven").toBe(3);
    expect(seen[0], "premise: :00 and :01 name different minutes (rounding moved it)").not.toBe(seen[1]);
    expect(seen[1], ":01 and :59 name the same next minute").toBe(seen[2]);
  });

  it("[reader:resend] the organiser's Resend judges the BOARD's window: inside batch 2's own, refused for batch 0 once ITS has closed; at batch 2's deadline exactly, refused", async () => {
    const r = await seedRound();
    await open(r, OPENED);
    const afterBatch0 = new Date(batchStart(0).getTime() + DEADLINE_AFTER_MS + 1);
    expect(afterBatch0.getTime(), "premise: batch 2's window is still running").toBeLessThan(batchStart(2).getTime() + DEADLINE_AFTER_MS);
    mail.sent.length = 0;
    expect(await refusal(resendExternalPlayNotice(r.owner, r.boards[0]!.fixtureId, ORIGIN, { now: afterBatch0 }))).toEqual({
      status: 409,
      code: "WINDOW_CLOSED",
    });
    expect(mail.sent, "batch 0 mailed nobody").toHaveLength(0);
    expect(await resendExternalPlayNotice(r.owner, r.ranked.fixtureId, ORIGIN, { now: afterBatch0 })).toEqual({ emailed: 2 });
    const edge = new Date(batchStart(2).getTime() + DEADLINE_AFTER_MS);
    expect(await resendExternalPlayNotice(r.owner, r.ranked.fixtureId, ORIGIN, { now: new Date(edge.getTime() - 1) })).toEqual({ emailed: 2 });
    mail.sent.length = 0;
    expect(await refusal(resendExternalPlayNotice(r.owner, r.ranked.fixtureId, ORIGIN, { now: edge }))).toEqual({
      status: 409,
      code: "WINDOW_CLOSED",
    });
    expect(mail.sent).toHaveLength(0);
  });

  // Final review M-5: the mail keyed its "opens for check-in at HH:MM" paragraph on the BOARD being in a later batch, not on that
  // batch still being shut when the mail is SENT. A resend after the batch opened told the player their check-in "opens at" a time
  // that had already passed, and gave no sign it was open now.
  it("(M-5, a resend) a resend after the board's batch has OPENED says nothing about when it opens; before it, it still does; at the opening exactly, it is open", async () => {
    const r = await seedRound();
    await open(r, OPENED);
    const opensAt = batchStart(2);
    const send = async (now: Date) => {
      mail.sent.length = 0;
      expect(await resendExternalPlayNotice(r.owner, r.ranked.fixtureId, ORIGIN, { now }), `resend at ${now.toISOString()}`).toEqual({ emailed: 2 });
      const got = mail.sent.filter((m) => [r.ranked.home.email, r.ranked.away.email].includes(m.to));
      expect(got, "both players of the ranked board were mailed").toHaveLength(2);
      return got;
    };
    let checked = 0;
    // (1) BEFORE the batch opens: the mail names when, rounded up as the invite does.
    for (const m of await send(new Date(opensAt.getTime() - 1))) {
      expect(m.opensLabel, "1 ms before the opening: still names it").toBe(label(promised(opensAt), m.locale));
      checked += 1;
    }
    // (2) AT the opening and after it (up to the batch's own deadline): the batch is open, so there is no "opens at".
    const deadline = new Date(opensAt.getTime() + DEADLINE_AFTER_MS);
    for (const now of [opensAt, new Date(opensAt.getTime() + MIN), new Date(deadline.getTime() - 1)]) {
      for (const m of await send(now)) {
        expect(m.opensLabel, `at ${now.toISOString()} the batch is already open: no opens-at line`).toBeUndefined();
        expect(m.deadlineLabel, "and the deadline named is the batch's own").toBe(label(deadline, m.locale));
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: mails checked (2 players x 4 resends)").toBe(8);
    expect(opensAt.getTime(), "premise: the resends past the opening are inside the batch's own window").toBeLessThan(deadline.getTime());
  });

  it("(M-5, a resend) batch 0 never named an opening, and still does not, whenever it is resent - even on a clock far enough behind the stamp that its window has not opened", async () => {
    const r = await seedRound();
    await open(r, OPENED);
    let checked = 0;
    const behind = new Date(OPENED.getTime() - 2 * WINDOW_OPEN_LEAD_MS);
    expect(behind.getTime(), "premise: before batch 0's own opening (the lead ahead of the stamp)").toBeLessThan(windowFor(boardAnchor(OPENED, 0, true)).opensAt.getTime());
    for (const now of [behind, new Date(OPENED.getTime() + 1), new Date(OPENED.getTime() + DEADLINE_AFTER_MS - 1)]) {
      mail.sent.length = 0;
      expect(await resendExternalPlayNotice(r.owner, r.boards[0]!.fixtureId, ORIGIN, { now })).toEqual({ emailed: 2 });
      for (const m of mail.sent) {
        expect(m.opensLabel, `batch 0 at ${now.toISOString()}`).toBeUndefined();
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(6);
  });
});
