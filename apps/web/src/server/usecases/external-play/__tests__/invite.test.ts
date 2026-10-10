// T19 — the invite helpers and the organiser's Resend (re-homed here from the
// deleted usecases/external-play.ts). The per-seat stamp is the invite record;
// these pin what may write it and what may clear it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

const mail = vi.hoisted(() => ({
  sent: [] as { to: string; fixtureUrl: string }[],
  fail: new Set<string>(),
  throws: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1]) => {
        if (mail.throws.has(to)) throw new Error("provider exploded");
        if (mail.fail.has(to)) return false;
        mail.sent.push({ to, fixtureUrl: args.fixtureUrl });
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
import { createGameIfReady } from "../create-game";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { addFixture } from "../../stages";
import { seedOnlineChessRound, seedOwner, type SeedOnlineChessRoundResult } from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
  mail.throws.clear();
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
    expect(await rowOf(f)).toMatchObject({ round_open_id: id, white_emailed_at: null, black_emailed_at: null });

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

  it("a board whose game was made before any invite: Resend leaves the game row exactly as it was", async () => {
    // Reached by the real path: a board added to the round after the open,
    // seated and created by its players before the organiser opened again.
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

    await resendExternalPlayNotice(r.owner, fixture_id, ORIGIN);
    expect(await rowOf(fixture_id)).toEqual(before);
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
