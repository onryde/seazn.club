// Arbiter Panel round column, Task 2 (spec docs/superpowers/specs/2026-10-24-arbiter-round-column-design.md, section 6): the arbiter
// loader says, for each board IN CHECK-IN, whether each player is here and what each seat's invite did (`ArbiterBoard.seats`).
//
// Driven against a real Postgres through the product's own producers: `openRound` queues the invites on the email outbox (the
// keyless CI environment ends every row `dead`, which is the default reading), `resendExternalPlayNotice` is the second call, the
// real unpair + regenerate re-pairs a Swiss board, and `loadArbiterRound` / `listFlaggedExternalPlay` are the readers. A row's
// status is then moved by SQL with the V470 CHECKs honoured (a body only while queued/sending, a lease only while sending), because
// no producer here can make the provider answer `delivered`: that is Resend's webhook.
//
// Every expected word is written from the spec (section 6.1's table), never read back from `inviteWordOf`; every expected "here" is
// `checkInCounts`' answer at the stamp, never the loader's.
//
// Single-sport by construction: online play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`); nothing here
// branches on sport.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import { OUTBOX_STATUSES, type OutboxStatus } from "@/server/email-outbox/constants";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  WINDOW_OPEN_LEAD_MS,
  boardAnchor,
  checkInCounts,
  windowFor,
} from "@/server/external-play/window";
import { log } from "@/server/logger";
import { stampFixtureCheckIn } from "../me";
import { scoreEvent } from "../scoring";
import { getFixtureState } from "../fixtures";
import { mintOrgOwnerAuth } from "../external-play/auth";

// Nothing here may reach the network: the keyless gate ends a row before the transport is asked, and this replaces the transport
// anyway, so a key that leaks into the environment cannot send a real email.
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: () => Promise.resolve({ ok: false as const, reason: "http" as const, status: 422, errorName: "validation_error", detail: "refused" }),
}));
// The outbox read, wrapped so a test can count its calls (the empty case) and make it answer a status the panel has no word for.
// Every call is the real read unless a test says otherwise.
vi.mock("@/server/email-outbox/status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox/status")>();
  return { ...actual, latestEmailStatus: vi.fn(actual.latestEmailStatus) };
});

// The check-in read, wrapped the same way: the round is read ONCE, never per board.
vi.mock("../external-play/check-ins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/check-ins")>();
  return { ...actual, checkedInAtOfBoards: vi.fn(actual.checkedInAtOfBoards) };
});

import { latestEmailStatus } from "@/server/email-outbox/status";
import { listFlaggedExternalPlay, loadArbiterRound } from "../external-play/arbiter";
import { checkedInAtOfBoards } from "../external-play/check-ins";
import { resendExternalPlayNotice } from "../external-play/invite";
import { openRound } from "../external-play/open-round";
import { CHESS_SEAT_REF_TYPE, STAMP_COLUMN, chessSeatRef, seatStampBound, type Colour } from "../external-play/seat-stamp";
import { generateStageFixtures, unpairSwissRound } from "../stages";
import {
  seedOnlineChessRound,
  seedOnlineChessRoundWithRankedBoard,
  seedOnlineSwiss,
  seedOwner,
  type SeedOnlineChessRoundResult,
  type SeedRoundBoard,
  type SeedSide,
} from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const ORIGIN = "https://seazn.test";

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  vi.clearAllMocks();
  // The keyless environment (CI, a fresh checkout): every invite row ends `dead` / `no_api_key`.
  vi.stubEnv("RESEND_API_KEY", "");
});

// ---------------------------------------------------------------------------------------------------------------------------
// The rig

/** A round opened through the product's own usecase, so every board is invited, bound and stamped by the real producer. */
async function openedRound(fixtures: number): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures });
  const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
  expect(out, "premise: the real open stamped the round and invited it").toMatchObject({ opened: true });
  return r;
}

type OutboxRow = { id: string; recipient: string; status: OutboxStatus };
const rowsOf = (orgId: string, fixtureId: string, colour: Colour) =>
  sql<OutboxRow[]>`
    select id, recipient, status from email_outbox
     where org_id = ${orgId} and ref_type = ${CHESS_SEAT_REF_TYPE} and ref_id = ${chessSeatRef(fixtureId, colour)}
     order by created_at, id`;

/** Move a row to `status` with the V470 CHECKs honoured: a body only while queued/sending, a lease exactly while sending. */
async function setStatus(id: string, status: OutboxStatus): Promise<void> {
  await sql`
    update email_outbox
       set status = ${status}, body_sealed = null,
           lease_until = case when ${status}::text = 'sending' then now() + interval '2 minutes' end,
           status_at = now()
     where id = ${id}`;
}

/** The round's open id: what a seat's stamp must name to count as stamped for it. */
async function openIdOf(fixtureId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select o.id from stage_round_opens o join fixtures f on f.stage_id = o.stage_id and f.round_no = o.round_no
     where f.id = ${fixtureId}`;
  return row!.id;
}

/** Stamp a seat as invited, bound to `openId` (default: the board's own open). */
async function stampSeat(fixtureId: string, colour: Colour, openId?: string): Promise<void> {
  const bound = openId ?? (await openIdOf(fixtureId));
  await sql`
    update fixture_external_play
       set ${sql(STAMP_COLUMN[colour])} = now(), round_open_id = ${bound}, updated_at = now()
     where fixture_id = ${fixtureId}`;
}

type Seats = NonNullable<ArbiterBoard["seats"]>;
async function boardsOf(r: SeedOnlineChessRoundResult): Promise<ArbiterBoard[]> {
  const view = await loadArbiterRound(r.owner, r.divisionId);
  expect(view, "premise: the round is in view").not.toBeNull();
  return view!.boards;
}
async function seatsOf(r: SeedOnlineChessRoundResult, fixtureId: string): Promise<Seats> {
  const board = (await boardsOf(r)).find((b) => b.fixtureId === fixtureId);
  expect(board, "premise: the board is listed").toBeDefined();
  expect(board!.state, "premise: the board is in check-in").toEqual({ kind: "checking_in" });
  expect(board!.seats, "a board in check-in carries its seats").not.toBeNull();
  return board!.seats!;
}

/** The state a board is in past check-in, written onto the bridge row the real open made (a game on file, in each stage). */
async function putGame(fixtureId: string, kind: "starting" | "live" | "on_hold"): Promise<void> {
  const moves = kind === "live" ? ["g1f3", "g8f6"] : [];
  const at = new Date();
  await sql`
    update fixture_external_play
       set status = ${kind === "on_hold" ? "needs_organiser" : kind === "live" ? "live" : "ready"},
           needs_reason = ${kind === "on_hold" ? "provider_error" : null},
           challenge_id = ${`g${randomUUID().slice(0, 7)}`}, white_side = 'home', white_lichess_id = 'w-acc', black_lichess_id = 'b-acc',
           moves_uci = ${sql.json(moves)}, move_count = ${moves.length},
           started_at = ${moves.length > 0 ? at : null}, last_move_at = ${moves.length > 0 ? at : null},
           white_ms = ${moves.length > 0 ? 880_000 : null}, black_ms = ${moves.length > 0 ? 890_000 : null},
           clock_increment_s = ${moves.length > 0 ? 10 : null}
     where fixture_id = ${fixtureId}`;
}

/** Four boards past check-in, one of each state: starting, live, on hold, and a result. */
async function pastCheckIn(r: SeedOnlineChessRoundResult, boards: SeedOnlineChessRoundResult["boards"]): Promise<void> {
  const [starting, live, hold, done] = boards;
  await putGame(starting!.fixtureId, "starting");
  await putGame(live!.fixtureId, "live");
  await putGame(hold!.fixtureId, "on_hold");
  const auth = await mintOrgOwnerAuth(r.orgId);
  await scoreEvent(auth, done!.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, done!.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: done!.home.entrantId } });
}

/** The words of a seat, with the board and the colour that make an assertion's failure readable. */
const words = (s: Seats) => ({ white: s.white.invites, black: s.black.invites });

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: the empty case and the boards that carry none", () => {
  it("empty case: a round with no board in check-in issues no outbox read", async () => {
    const r = await openedRound(3);
    for (const [i, kind] of (["starting", "live", "on_hold"] as const).entries()) await putGame(r.boards[i]!.fixtureId, kind);
    vi.mocked(latestEmailStatus).mockClear();
    const boards = await boardsOf(r);
    expect(boards.map((b) => b.state.kind), "premise: not one board is in check-in").toEqual(["starting", "live", "on_hold"]);
    expect(boards.map((b) => b.seats)).toEqual([null, null, null]);
    expect(vi.mocked(latestEmailStatus), "the outbox is not read for a round with no board in check-in").toHaveBeenCalledTimes(0);
    expect(vi.mocked(checkedInAtOfBoards), "nor are the check-ins").toHaveBeenCalledTimes(0);
  });

  it("a board past check-in (starting, live, on hold, result) carries seats null; the board in check-in beside them carries its seats", async () => {
    const r = await openedRound(5);
    const [inCheckIn, ...rest] = r.boards;
    await pastCheckIn(r, rest);
    const boards = await boardsOf(r);
    expect(boards.map((b) => b.state.kind), "premise: one board of each state").toEqual(["checking_in", "starting", "live", "on_hold", "result"]);
    const byKind = new Map(boards.map((b) => [b.state.kind, b.seats]));
    let checked = 0;
    for (const kind of ["starting", "live", "on_hold", "result"] as const) {
      expect(byKind.get(kind), `a ${kind} board carries no seats`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    // The positive pair: the null above is the state's doing, not the loader's failure to read anything.
    expect(boards[0]!.fixtureId).toBe(inCheckIn!.fixtureId);
    expect(boards[0]!.seats).not.toBeNull();
    // The reads were asked about the one board in check-in and nobody else's.
    expect(vi.mocked(latestEmailStatus).mock.calls.map((c) => [...c[2]].sort())).toEqual([
      [chessSeatRef(inCheckIn!.fixtureId, "black"), chessSeatRef(inCheckIn!.fixtureId, "white")].sort(),
    ]);
    expect(vi.mocked(checkedInAtOfBoards).mock.calls.map((c) => [...c[0]])).toEqual([[inCheckIn!.fixtureId]]);
  });

  it("one read per round, not per board: several boards in check-in cost ONE outbox read and ONE check-in read, and each board keeps its own facts", async () => {
    const r = await openedRound(4);
    const [a, b, c, past] = r.boards;
    await putGame(past!.fixtureId, "starting");
    // Each board's own facts, so a batch that mixed boards up would show: b's White mail was delivered; c's Black player is here.
    const [bWhite] = await rowsOf(r.orgId, b!.fixtureId, "white");
    await setStatus(bWhite!.id, "delivered");
    await stampFixtureCheckIn(c!.away.personId, c!.fixtureId, r.orgId);
    vi.mocked(latestEmailStatus).mockClear();
    vi.mocked(checkedInAtOfBoards).mockClear();
    const boards = await boardsOf(r);
    expect(boards.map((x) => x.state.kind), "premise: three boards in check-in and one past it").toEqual([
      "checking_in",
      "checking_in",
      "checking_in",
      "starting",
    ]);
    expect(vi.mocked(latestEmailStatus), "ONE outbox read for the whole round").toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkedInAtOfBoards), "ONE check-in read for the whole round").toHaveBeenCalledTimes(1);
    // ... asked about exactly the three boards in check-in, both seats of each.
    const inCheckIn = [a!, b!, c!];
    expect([...vi.mocked(latestEmailStatus).mock.calls[0]![2]].sort()).toEqual(
      inCheckIn.flatMap((x) => (["white", "black"] as const).map((col) => chessSeatRef(x.fixtureId, col))).sort(),
    );
    expect([...vi.mocked(checkedInAtOfBoards).mock.calls[0]![0]].sort()).toEqual(inCheckIn.map((x) => x.fixtureId).sort());
    const seatFacts = (x: ArbiterBoard) =>
      x.seats === null ? null : { white: [x.seats.white.here, ...x.seats.white.invites], black: [x.seats.black.here, ...x.seats.black.invites] };
    expect(boards.map(seatFacts)).toEqual([
      { white: [false, "not_delivered"], black: [false, "not_delivered"] },
      { white: [false, "delivered"], black: [false, "not_delivered"] },
      { white: [false, "not_delivered"], black: [true, "not_delivered"] },
      null,
    ]);
  });

  it("the Flagged list carries seats null, even for a board in check-in, and reads no outbox", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
              values (${b.fixtureId}, ${r.orgId}, 'camera_lost', ${b.home.personId}, null)`;
    // The positive pair: the round's own view of this very board has its seats.
    expect((await seatsOf(r, b.fixtureId)).white.invites.length, "premise: the round view reads this board's seats").toBeGreaterThan(0);
    vi.mocked(latestEmailStatus).mockClear();
    vi.mocked(checkedInAtOfBoards).mockClear();
    const { boards } = await listFlaggedExternalPlay(r.owner, r.divisionId);
    expect(boards.map((x) => x.fixtureId)).toEqual([b.fixtureId]);
    expect(boards[0]!.state, "premise: the flagged board is still in check-in").toEqual({ kind: "checking_in" });
    expect(boards[0]!.seats).toBeNull();
    expect(vi.mocked(latestEmailStatus), "the Flagged list has no second pass").toHaveBeenCalledTimes(0);
    expect(vi.mocked(checkedInAtOfBoards)).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: who is here", () => {
  it("checked in during the window: here; before the window opened: not here (the edges of the window as well)", async () => {
    const r = await openedRound(2);
    const [one, two] = r.boards;
    const [open] = await sql<{ openedAt: Date; staggered: boolean }[]>`
      select opened_at as "openedAt", staggered from stage_round_opens where stage_id = ${r.stageId} and round_no = ${r.roundNo}`;
    // Board 1 is rank 0, board 2 rank 1: the window the loader judges them by is each board's own, read from window.ts's declaration.
    const win = (rank: number) => {
      const anchor = boardAnchor(open!.openedAt, rank, open!.staggered, 0);
      return { anchor, ...windowFor(anchor) };
    };
    const w1 = win(0);
    const w2 = win(1);
    const stamps = [
      // A minute before the window opens, and a minute inside it.
      { board: one!, side: "home" as const, anchor: w1.anchor, at: new Date(w1.opensAt.getTime() - MIN) },
      { board: one!, side: "away" as const, anchor: w1.anchor, at: new Date(w1.opensAt.getTime() + MIN) },
      // The opening edge counts; the deadline itself does not (`roomPhase`: open while now < deadline).
      { board: two!, side: "home" as const, anchor: w2.anchor, at: w2.opensAt },
      { board: two!, side: "away" as const, anchor: w2.anchor, at: w2.deadline },
    ];
    for (const s of stamps) await stampFixtureCheckIn(s.board[s.side].personId, s.board.fixtureId, r.orgId, { at: s.at });
    // The expected answers come from the window rule, not from the loader.
    const expected = stamps.map((s) => checkInCounts(s.at, s.anchor));
    expect(expected, "premise: the sweep has both answers in it").toContain(true);
    expect(expected).toContain(false);

    const boards = await boardsOf(r);
    const got = [
      boards[0]!.seats!.white.here,
      boards[0]!.seats!.black.here,
      boards[1]!.seats!.white.here,
      boards[1]!.seats!.black.here,
    ];
    expect(got).toEqual(expected);
    // Pinned by hand as well, so a window rule that moved would still be caught here: before the window is not here, inside is, the
    // opening edge is, the deadline is not.
    expect(expected).toEqual([false, true, true, false]);
  });

  // [reader:arbiter-here] is what batch-anchor-source-guard.test.ts pins: the loader's `seats` pass asks window.ts's `checkInCounts`
  // with THIS board's anchor (rank, stagger, extension), not the round's. The round below is staggered (a camera policy that is not
  // `off`, as the real open stores it), so a rank-0 board and a rank-20 board have different windows, and a pass that judged every
  // board by the round's own opening would get one of them wrong at every edge. Every instant is written from window.ts's constants
  // (OPENED + batch x GAP, less the lead for batch 0, plus the deadline), never read back from windowFor.
  const OPENED = new Date("2026-10-01T12:00:00.000Z");
  const startOf = (batch: number) => new Date(OPENED.getTime() + batch * CHECKIN_BATCH_GAP_MS);
  const opensOf = (batch: number) => (batch === 0 ? new Date(OPENED.getTime() - WINDOW_OPEN_LEAD_MS) : startOf(batch));
  const closesOf = (batch: number) => new Date(startOf(batch).getTime() + DEADLINE_AFTER_MS);

  /** Stamp the board's home player at `at`, then read the white seat the way the arbiter's page does. */
  async function hereAt(r: SeedOnlineChessRoundResult, board: SeedRoundBoard, at: Date): Promise<boolean> {
    await stampFixtureCheckIn(board.home.personId, board.fixtureId, r.orgId, { at });
    return (await seatsOf(r, board.fixtureId)).white.here;
  }

  it("[reader:arbiter-here] a stamp counts only inside ITS board's window (staggered round): each board's own edges, and one instant that is here for one board and not the other", async () => {
    // A staggered round opened by the real usecase at OPENED: board 1 sits in batch 0, `ranked` in batch 2 (rank 2 x the batch size).
    const r = await seedOnlineChessRoundWithRankedBoard({ cameraPolicy: "required" }, 2 * CHECKIN_BATCH_SIZE);
    const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId }, { now: OPENED });
    expect(out, "premise: the real open stamped the round").toMatchObject({ opened: true });
    const [open] = await sql<{ openedAt: Date; staggered: boolean }[]>`
      select opened_at as "openedAt", staggered from stage_round_opens where stage_id = ${r.stageId} and round_no = ${r.roundNo}`;
    expect(open!.staggered, "premise: the open stored a staggered round").toBe(true);
    expect(open!.openedAt.getTime(), "premise: the open is dated at the injected clock").toBe(OPENED.getTime());
    const boards = [
      { batch: 0, board: r.boards[0]! },
      { batch: 2, board: r.ranked },
    ];

    // Each board's own edges: 1 ms before it opens is not here, its opening is, 1 ms before its deadline is, its deadline is not.
    let checked = 0;
    for (const { batch, board } of boards) {
      const o = opensOf(batch).getTime();
      const c = closesOf(batch).getTime();
      expect(await hereAt(r, board, new Date(o - 1)), `batch ${batch}: a stamp 1 ms before the window`).toBe(false);
      expect(await hereAt(r, board, new Date(o)), `batch ${batch}: a stamp at its opening`).toBe(true);
      expect(await hereAt(r, board, new Date(c - 1)), `batch ${batch}: a stamp 1 ms before the deadline`).toBe(true);
      expect(await hereAt(r, board, new Date(c)), `batch ${batch}: a stamp at the deadline`).toBe(false);
      checked += 4;
    }
    expect(checked, "anti-vacuity: edges read (four per batch, two batches)").toBe(8);

    // The differential, both ways round. Batch 0 holds [OPENED - lead, OPENED + deadline); batch 2 holds [OPENED + 2 gaps, + deadline).
    // Five minutes before the opening is inside batch 0 only; twelve minutes after it is past batch 0's deadline and inside batch 2.
    const early = new Date(OPENED.getTime() - 5 * MIN);
    const late = new Date(OPENED.getTime() + 12 * MIN);
    expect(early >= opensOf(0) && early < closesOf(0) && early < opensOf(2), "premise: the early instant is in batch 0 only").toBe(true);
    expect(late >= closesOf(0) && late >= opensOf(2) && late < closesOf(2), "premise: the late instant is in batch 2 only").toBe(true);
    const got: boolean[][] = [];
    for (const at of [early, late]) {
      const row: boolean[] = [];
      for (const { board } of boards) row.push(await hereAt(r, board, at));
      got.push(row);
    }
    expect(got, "[batch 0, batch 2] at the early instant, then at the late one").toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("a seat with no linked person is not here and has no mailbox to read: Not invited", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    // Both players check in, then the black seat's entrant loses its member: that seat resolves no person and no address.
    await stampFixtureCheckIn(b.home.personId, b.fixtureId, r.orgId);
    await stampFixtureCheckIn(b.away.personId, b.fixtureId, r.orgId);
    expect(await seatsOf(r, b.fixtureId), "premise: both are here with their mail on file").toMatchObject({
      white: { here: true },
      black: { here: true },
    });
    await sql`delete from entrant_members where entrant_id = ${b.away.entrantId}`;
    const seats = await seatsOf(r, b.fixtureId);
    expect(seats.white.here, "the other seat is untouched").toBe(true);
    expect(seats.black).toEqual({ here: false, invites: ["not_invited"] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: what the invite did", () => {
  it("CI default: a dead row and a released stamp reads Not delivered", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    // The premises, read from the tables: the keyless open left a dead row per seat and released both stamps.
    for (const colour of ["white", "black"] as const) {
      expect((await rowsOf(r.orgId, b.fixtureId, colour)).map((x) => x.status), `premise: ${colour}'s invite ended dead`).toEqual(["dead"]);
    }
    const [bridge] = await sql<{ white: Date | null; black: Date | null }[]>`
      select white_emailed_at as white, black_emailed_at as black from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(bridge, "premise: both stamps were released by the chess hook").toEqual({ white: null, black: null });
    expect(words(await seatsOf(r, b.fixtureId))).toEqual({ white: ["not_delivered"], black: ["not_delivered"] });
  });

  // Spec 6.1's table, row by row. The seat's stamp is re-bound to the open first, as a delivered or retrying invite holds it.
  it.each([
    ["delivered row, stamp held: Delivered", "delivered", "delivered"],
    ["sent row: Sent", "sent", "sent"],
    ["queued row: Delayed", "queued", "delayed"],
  ] as const)("%s", async (_name, status, word) => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    const [white] = await rowsOf(r.orgId, b.fixtureId, "white");
    await setStatus(white!.id, status);
    await stampSeat(b.fixtureId, "white");
    const seats = await seatsOf(r, b.fixtureId);
    expect(seats.white.invites).toEqual([word]);
    // The other seat is untouched by it.
    expect(seats.black.invites).toEqual(["not_delivered"]);
  });

  it("sweep: every outbox status reads its spec word end to end (twelve statuses, the replaced one reads no mail at all)", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    const [white] = await rowsOf(r.orgId, b.fixtureId, "white");
    // Spec 6.1, written out: the word per status. `replaced` is never an answer, so with no other row the seat reads as never invited.
    const SPEC: Record<OutboxStatus, string> = {
      delivered: "delivered",
      complained: "delivered",
      sent: "sent",
      delayed: "delayed",
      queued: "delayed",
      sending: "delayed",
      bounced: "bounced",
      failed: "not_delivered",
      suppressed: "not_delivered",
      expired: "not_delivered",
      dead: "not_delivered",
      replaced: "not_invited",
    };
    let checked = 0;
    for (const status of OUTBOX_STATUSES) {
      await setStatus(white!.id, status);
      expect((await seatsOf(r, b.fixtureId)).white.invites, `outbox status ${status}`).toEqual([SPEC[status]]);
      checked++;
    }
    expect(checked, "every status the outbox declares was driven through the loader").toBe(OUTBOX_STATUSES.length);
    expect(Object.keys(SPEC).length, "the spec table covers every status the outbox declares").toBe(OUTBOX_STATUSES.length);
  });

  it("resend after Not delivered: the new row is the word (the second call)", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    expect(words(await seatsOf(r, b.fixtureId)), "premise: the first call read Not delivered").toEqual({
      white: ["not_delivered"],
      black: ["not_delivered"],
    });
    await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);
    const rows = await rowsOf(r.orgId, b.fixtureId, "white");
    expect(rows.length, "premise: the resend wrote a second row beside the dead one").toBe(2);
    expect(rows.map((x) => x.status), "premise: the keyless resend ended dead as well").toEqual(["dead", "dead"]);
    // The provider takes the new one: it is the newest row, so it is the word.
    await setStatus(rows[1]!.id, "sent");
    expect((await seatsOf(r, b.fixtureId)).white.invites).toEqual(["sent"]);
    // And the old dead row is not the word even though it is still on file.
    expect((await rowsOf(r.orgId, b.fixtureId, "white")).map((x) => x.status)).toEqual(["dead", "sent"]);
  });

  it("two rows that are one mailbox (padding and case): the LATER status answers, whatever order the read returns them in", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    const [dead] = await rowsOf(r.orgId, b.fixtureId, "white");
    // `latestEmailStatus` keeps one row per lower(recipient) and does not trim, so a padded copy of the same address is a SECOND
    // row, and the read orders by ref then lower(recipient): the padded one sorts FIRST (a space sorts before a letter).
    const padded = ` ${b.home.email.toUpperCase()} `;
    const [newer] = await sql<{ id: string }[]>`
      insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at, created_at, status_at)
      values (${randomUUID()}, 'chess_invite', ${CHESS_SEAT_REF_TYPE}, ${chessSeatRef(b.fixtureId, "white")}, ${r.orgId}, ${padded},
              'padded copy', true, 'delivered', now() + interval '1 hour', now(), now() + interval '1 minute')
      returning id`;
    expect(newer, "premise: the padded row is on file").toBeDefined();
    expect(dead!.recipient, "premise: the dead row is the plain address").toBe(b.home.email);
    expect((await seatsOf(r, b.fixtureId)).white.invites, "the later status answers: delivered, not the plain row's dead").toEqual(["delivered"]);
    // The differential: the same two rows with their times swapped. Now the plain row is the later one.
    await sql`update email_outbox set status_at = now() + interval '2 minutes' where id = ${dead!.id}`;
    expect((await seatsOf(r, b.fixtureId)).white.invites, "swap the times: the other row answers").toEqual(["not_delivered"]);
  });

  it("re-paired seat: the previous player's mail is not this seat's word", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const emailOf = new Map(s.players.map((p) => [p.entrantId, p.email]));
    type Board = { fixtureId: string; home: string; away: string };
    const boardsNow = () =>
      sql<Board[]>`
        select id as "fixtureId", home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${s.stageId} and round_no = 1 and status = 'scheduled'
           and home_entrant_id is not null and away_entrant_id is not null
         order by seq_in_round`;
    const before = await boardsNow();
    expect(before, "premise: 4 players, 2 boards").toHaveLength(2);
    expect(await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }), "premise: the real open invited them").toMatchObject({
      opened: true,
    });
    // Player A's mail was DELIVERED, on every seat of the round.
    for (const board of before) {
      for (const colour of ["white", "black"] as const) {
        for (const row of await rowsOf(s.orgId, board.fixtureId, colour)) await setStatus(row.id, "delivered");
      }
    }
    // The real unpair, then the real re-pair with a different pairing. No new mail is sent: the round is not opened again.
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const after = await boardsNow();
    expect(after, "premise: the re-pair seated two boards").toHaveLength(2);
    const [opened] = await sql<{ n: number }[]>`select count(*)::int as n from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
    expect(opened!.n, "premise: the round is still the one in view").toBe(1);

    const view = (await loadArbiterRound(s.owner, s.divisionId))!;
    const seatsById = new Map(view.boards.map((x) => [x.fixtureId, x.seats]));
    let repaired = 0;
    let kept = 0;
    for (const now of after) {
      const was = before.find((x) => x.fixtureId === now.fixtureId);
      expect(was, "premise: the re-pair kept the board's fixture").toBeDefined();
      const seats = seatsById.get(now.fixtureId);
      expect(seats, "premise: the board is in check-in again").not.toBeNull();
      // White is home on a board with no pairing card.
      for (const [colour, wasEntrant, nowEntrant] of [
        ["white", was!.home, now.home],
        ["black", was!.away, now.away],
      ] as const) {
        const invites = seats![colour].invites;
        if (emailOf.get(wasEntrant) === emailOf.get(nowEntrant)) {
          expect(invites, `${colour} of ${now.fixtureId}: the same player, so their delivered mail stands`).toEqual(["delivered"]);
          kept++;
        } else {
          expect(invites, `${colour} of ${now.fixtureId}: a new player, so the previous player's mail is not theirs`).toEqual(["not_invited"]);
          repaired++;
        }
      }
    }
    expect(repaired, "anti-vacuity: the re-pair changed at least one seat").toBeGreaterThan(0);
    expect(kept, "anti-vacuity: and kept at least one").toBeGreaterThan(0);
    expect(repaired + kept).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: the stamp", () => {
  it("stamped with no row: Not delivered, and a warning is logged (the unstamped seat with no row reads Not invited, quietly)", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    // No mail on file for either seat; only white holds a stamp bound to this open.
    await sql`delete from email_outbox where org_id = ${r.orgId} and ref_id in (${chessSeatRef(b.fixtureId, "white")}, ${chessSeatRef(b.fixtureId, "black")})`;
    await stampSeat(b.fixtureId, "white");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(words(await seatsOf(r, b.fixtureId))).toEqual({ white: ["not_delivered"], black: ["not_invited"] });
      const calls = warn.mock.calls.filter(([o]) => typeof o === "object" && o !== null && "fixtureId" in o && o.fixtureId === b.fixtureId);
      expect(calls, "one warning, for the stamped seat only").toHaveLength(1);
      const [obj, msg] = calls[0]!;
      expect(obj).toMatchObject({ fixtureId: b.fixtureId, colour: "white" });
      expect(String(msg)).toMatch(/stamped/);
      // The warning names the board and the seat, never an address.
      expect(JSON.stringify(calls)).not.toContain(b.home.email);
      expect(JSON.stringify(calls)).not.toContain(b.away.email);
    } finally {
      warn.mockRestore();
    }
  });

  it("a stamp from an earlier open is not bound: the seat reads as not stamped (labelled SQL move: no product path moves a fixture between rounds)", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    await sql`delete from email_outbox where org_id = ${r.orgId} and ref_id = ${chessSeatRef(b.fixtureId, "white")}`;
    // The seat is stamped under THIS round's open, then the board moves to a round with an open of its own, opened later (so it is the
    // round in view). The binding trigger only fires on a write of round_open_id, so the stamp keeps naming the old open.
    const earlier = await openIdOf(b.fixtureId);
    await stampSeat(b.fixtureId, "white", earlier);
    const [later] = await sql<{ id: string }[]>`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${r.stageId}, ${r.orgId}, ${r.roundNo + 1}, now() + interval '1 minute', ${r.ownerUserId}) returning id`;
    await sql`update fixtures set round_no = ${r.roundNo + 1} where id = ${b.fixtureId}`;
    expect(await openIdOf(b.fixtureId), "premise: the board's open is now the later one").toBe(later!.id);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect((await seatsOf(r, b.fixtureId)).white.invites, "stamped under the EARLIER open: not stamped for this one").toEqual(["not_invited"]);
      expect(warn.mock.calls.filter(([o]) => typeof o === "object" && o !== null && "colour" in o), "and no anomaly is logged").toHaveLength(0);
      // The positive pair: the same stamp under THIS open is the held stamp with no mail.
      await stampSeat(b.fixtureId, "white");
      expect((await seatsOf(r, b.fixtureId)).white.invites).toEqual(["not_delivered"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("another club's row for the same ref id is not read", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    const stranger = await seedOwner();
    // Same ref type, same ref id, the same mailbox, delivered, and NEWER than this club's dead row: unfenced, it would answer.
    await sql`
      insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at)
      values (${randomUUID()}, 'chess_invite', ${CHESS_SEAT_REF_TYPE}, ${chessSeatRef(b.fixtureId, "white")}, ${stranger.orgId},
              ${b.home.email}, 'another club', true, 'delivered', now() + interval '1 hour')`;
    const seats = await seatsOf(r, b.fixtureId);
    expect(seats.white.invites, "this club's own word, not the other club's Delivered").toEqual(["not_delivered"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: one bad row does not fail the panel", () => {
  it("a status the panel has no word for: that seat gets no words and the error is logged without the address; every other seat keeps its words", async () => {
    const r = await openedRound(2);
    const [one, two] = r.boards;
    const real = await vi.importActual<typeof import("@/server/email-outbox/status")>("@/server/email-outbox/status");
    vi.mocked(latestEmailStatus).mockImplementationOnce(async (...args) => {
      const rows = await real.latestEmailStatus(...args);
      // Board 1's white seat answers a status no code knows (a thirteenth, or a corrupt row).
      return rows.map((x) => (x.refId === chessSeatRef(one!.fixtureId, "white") ? { ...x, status: "teleported" as never } : x));
    });
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const boards = await boardsOf(r);
      expect(boards).toHaveLength(2);
      expect(boards[0]!.seats!.white.invites, "the bad seat: no words").toEqual([]);
      expect(boards[0]!.seats!.black.invites, "the other seat of the same board").toEqual(["not_delivered"]);
      expect(boards[1]!.seats!.white.invites, "the next board").toEqual(["not_delivered"]);
      expect(boards[1]!.seats!.black.invites).toEqual(["not_delivered"]);
      expect(error, "exactly one error, for the one bad seat").toHaveBeenCalledTimes(1);
      const [obj, msg] = error.mock.calls[0]!;
      expect(obj).toMatchObject({ fixtureId: one!.fixtureId, colour: "white", refId: chessSeatRef(one!.fixtureId, "white") });
      expect(JSON.stringify(error.mock.calls), "the status value is in the line").toContain("teleported");
      expect(typeof msg).toBe("string");
      // Never an address, of any of the four players (nor the half before the @).
      const everyone: SeedSide[] = [one!.home, one!.away, two!.home, two!.away];
      let checked = 0;
      for (const p of everyone) {
        expect(JSON.stringify(error.mock.calls)).not.toContain(p.email);
        expect(JSON.stringify(error.mock.calls)).not.toContain(p.email.split("@")[0]!);
        checked++;
      }
      expect(checked).toBe(4);
    } finally {
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound seats: the sequence of a board's states", () => {
  it("settled on the pad, then voided: the board is back in check-in and its seats are derived afresh from the rows and check-ins of NOW", async () => {
    const r = await openedRound(1);
    const b = r.boards[0]!;
    const auth = await mintOrgOwnerAuth(r.orgId);
    expect(await seatsOf(r, b.fixtureId), "premise: in check-in, nothing delivered, nobody here").toEqual({
      white: { here: false, invites: ["not_delivered"] },
      black: { here: false, invites: ["not_delivered"] },
    });

    // Settled on the pad: no longer in check-in, so no seats.
    await scoreEvent(auth, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, b.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.home.entrantId } });
    const settled = (await boardsOf(r))[0]!;
    expect(settled.state, "premise: the result is on the board").toMatchObject({ kind: "result" });
    expect(settled.seats).toBeNull();

    // While it is settled the mail moves on and a player checks in.
    const [white] = await rowsOf(r.orgId, b.fixtureId, "white");
    await setStatus(white!.id, "delivered");
    await stampFixtureCheckIn(b.home.personId, b.fixtureId, r.orgId);

    // The result is voided on the pad: the fixture is open again and, with no game on file, the board is back in check-in.
    const [decided] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${b.fixtureId} and type = 'boardgame.result' order by seq desc limit 1`;
    const fs = await getFixtureState(r.owner, b.fixtureId);
    await scoreEvent(auth, b.fixtureId, { expected_seq: fs.last_seq, type: "core.void", payload: { event_id: decided!.id } });
    expect(await seatsOf(r, b.fixtureId), "the seats of NOW: the delivered mail, the player who checked in meanwhile").toEqual({
      white: { here: true, invites: ["delivered"] },
      black: { here: false, invites: ["not_delivered"] },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// seatStampBound is pure, so its table needs no database. Each row is written from the rule ("the row names the open on screen, and
// THAT colour's stamp is set"), and the last two rows are the colour independence the loader's "Not invited" vs "Not delivered" hangs on.
describe("seatStampBound: the table", () => {
  const STAMP = new Date("2026-10-24T12:00:00.000Z");
  const row = (o: { open: string | null; white?: boolean; black?: boolean }) => ({
    roundOpenId: o.open,
    whiteEmailedAt: o.white ? STAMP : null,
    blackEmailedAt: o.black ? STAMP : null,
  });
  const TABLE: [string, ReturnType<typeof row>, string | null, Colour, boolean][] = [
    ["the round on screen has no open: nothing is bound (both stamped)", row({ open: "A", white: true, black: true }), null, "white", false],
    ["no open on screen, black asked", row({ open: "A", white: true, black: true }), null, "black", false],
    ["a row bound to no open, none on screen, stamped: still not bound (null is not a match)", row({ open: null, white: true }), null, "white", false],
    ["a row bound to no open, an open on screen", row({ open: null, white: true, black: true }), "A", "white", false],
    ["the row names ANOTHER open (white)", row({ open: "B", white: true, black: true }), "A", "white", false],
    ["the row names ANOTHER open (black)", row({ open: "B", white: true, black: true }), "A", "black", false],
    ["same open, only the OTHER colour stamped (asked white)", row({ open: "A", black: true }), "A", "white", false],
    ["same open, only the OTHER colour stamped (asked black)", row({ open: "A", white: true }), "A", "black", false],
    ["same open, this colour stamped (white)", row({ open: "A", white: true }), "A", "white", true],
    ["same open, this colour stamped (black)", row({ open: "A", black: true }), "A", "black", true],
    ["same open, both stamped (white)", row({ open: "A", white: true, black: true }), "A", "white", true],
    ["same open, both stamped (black)", row({ open: "A", white: true, black: true }), "A", "black", true],
    ["same open, neither stamped", row({ open: "A" }), "A", "white", false],
  ];

  it("answers each row of the table", () => {
    let checked = 0;
    for (const [name, r, openId, colour, expected] of TABLE) {
      expect(seatStampBound(r, openId, colour), name).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: the whole table was asked").toBe(TABLE.length);
    // Both answers are in the table, or it could not tell a constant from the rule.
    expect(TABLE.some((t) => t[4])).toBe(true);
    expect(TABLE.some((t) => !t[4])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("checkedInAtOfBoards: nothing to ask about", () => {
  // No database: an empty id list is answered without a statement. With no DATABASE_URL a stray statement would THROW, and with one the
  // counter pins it, so the test means the same in both modes (as status.test.ts does for latestEmailStatus).
  it("empty ids answers an empty map and issues no statement", async () => {
    const before = statementCount();
    const answer = await checkedInAtOfBoards([]);
    expect(answer).toEqual(new Map());
    expect(statementCount() - before).toBe(0);
  });
});

describe.runIf(HAS_DB)("checkedInAtOfBoards: one read, grouped by board", () => {
  it("a non-empty ask is ONE statement (the counter is live), and the answer is fixture -> person -> stamp, absent for a board nobody checked in on", async () => {
    const r = await openedRound(3);
    const [one, two, nobody] = r.boards;
    const t1 = new Date("2026-10-24T12:01:00.000Z");
    const t2 = new Date("2026-10-24T12:02:00.000Z");
    await stampFixtureCheckIn(one!.home.personId, one!.fixtureId, r.orgId, { at: t1 });
    await stampFixtureCheckIn(one!.away.personId, one!.fixtureId, r.orgId, { at: t2 });
    await stampFixtureCheckIn(two!.home.personId, two!.fixtureId, r.orgId, { at: t2 });
    const before = statementCount();
    const answer = await checkedInAtOfBoards([one!.fixtureId, two!.fixtureId, nobody!.fixtureId]);
    expect(statementCount() - before, "one statement for three boards").toBe(1);
    expect(answer).toEqual(
      new Map([
        [one!.fixtureId, new Map([[one!.home.personId, t1], [one!.away.personId, t2]])],
        [two!.fixtureId, new Map([[two!.home.personId, t2]])],
      ]),
    );
    expect(answer.has(nobody!.fixtureId)).toBe(false);
  });
});
