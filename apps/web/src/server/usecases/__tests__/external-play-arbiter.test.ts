// T15 — the arbiter panel's two server halves (chess design §5.3):
//   loadArbiterRound — the opened round as the panel draws it: its boards in
//     board order, each one's state, clocks and flags; and
//   joinAsArbiter — a receive-only participant for ONE organiser on one
//     board's meeting, plus the two players' participant ids by colour (never
//     a player's token: spec §10 puts "broadcast both seats' tokens" on the
//     do-not-copy list).
// Rows are seeded through the product usecases where one writes them
// (createCompetition … startDivision, scoreEvent); rows only another task's
// writer makes are written by SQL and say whose writer they stand for. The
// real producer → this loader round trip for a flag lives in
// external-play-reconcile.test.ts (I5).
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`); nothing here branches on sport.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { ARBITER_JOIN_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import type { AuthCtx } from "@/server/api-v1/auth";
import { RealtimeKitDeferred, RealtimeKitError, type ParticipantToken } from "@/server/external-play/video/realtimekit";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { stampFixtureCheckIn } from "../me";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createDivision } from "../divisions";
import {
  arbiterRequestedRound,
  joinAsArbiter,
  leaveAsArbiter,
  loadArbiterRound,
  overrideVideoAsOrganiser,
  resyncExternalPlay,
  type ArbiterVideo,
} from "../external-play/arbiter";
import { listNeedsOrganiserExternalPlay } from "../external-play/queue";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessRound, seedOwner, seedPlayer, type SeedOnlineChessRoundResult } from "./_external-play-seed";

// M4: the loader's per-board reads, observed at the guard's door — the REAL
// functions, wrapped to count how many boards are being read AT ONCE. Only
// the test that sets `slow` changes anything.
const guardSpy = vi.hoisted(() => ({ slow: false, inFlight: 0, maxInFlight: 0, calls: 0 }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("../external-play/guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../external-play/guard")>();
  return {
    ...real,
    loadSides: async (...args: Parameters<typeof real.loadSides>) => {
      if (!guardSpy.slow) return real.loadSides(...args);
      guardSpy.calls++;
      guardSpy.inFlight++;
      guardSpy.maxInFlight = Math.max(guardSpy.maxInFlight, guardSpy.inFlight);
      try {
        await new Promise((res) => setTimeout(res, 25));
        return await real.loadSides(...args);
      } finally {
        guardSpy.inFlight--;
      }
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const OPENED = new Date("2026-10-12T19:00:00.000Z");

async function openRound(r: SeedOnlineChessRoundResult, roundNo = r.roundNo, at = OPENED): Promise<void> {
  // The open-round usecase's stamp (T19's writer), without its invites.
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
    values (${r.stageId}, ${r.orgId}, ${roundNo}, ${at}, ${r.ownerUserId})`;
}

/** A bridge row as T9 (create) / T10 (moves) leave it. */
async function bridge(
  fixtureId: string,
  orgId: string,
  b: { status: string; moves?: number; whiteMs?: number; blackMs?: number; reason?: string | null; startedAt?: Date | null },
): Promise<void> {
  const moves = Array.from({ length: b.moves ?? 0 }, (_, i) => (i % 2 === 0 ? "g1f3" : "g8f6"));
  const game = b.status !== "pending";
  await sql`
    insert into fixture_external_play (
      fixture_id, org_id, status, needs_reason, scheduled_at_basis, challenge_id, white_side, white_lichess_id,
      black_lichess_id, moves_uci, move_count, started_at, last_move_at, white_ms, black_ms, clock_increment_s)
    values (
      ${fixtureId}, ${orgId}, ${b.status}, ${b.reason ?? null}, ${OPENED},
      ${game ? `g${randomUUID().slice(0, 7)}` : null}, ${game ? "home" : null},
      ${game ? "w-acc" : null}, ${game ? "b-acc" : null},
      ${sql.json(moves)}, ${moves.length},
      ${b.startedAt ?? (moves.length > 0 ? OPENED : null)}, ${moves.length > 0 ? OPENED : null},
      ${moves.length > 0 ? (b.whiteMs ?? 185_000) : null}, ${moves.length > 0 ? (b.blackMs ?? 257_000) : null},
      ${moves.length > 0 ? 10 : null})`;
}

/** D16: the board's meetings - one per PLAYER. By default both sides have one (the board is under way); `sides` limits it. */
async function meeting(
  fixtureId: string,
  orgId: string,
  opts: { ended?: boolean; evidence?: boolean; sides?: ("home" | "away")[] } = {},
) {
  for (const side of opts.sides ?? (["home", "away"] as const)) {
    await putVideoMeeting(
      { fixtureId, orgId, side },
      { endedAt: opts.ended || opts.evidence ? new Date() : null, evidenceAt: opts.evidence ? new Date() : null },
    );
  }
}

/** The side a person plays: the entrant of the board they are a member of. */
async function sideOf(fixtureId: string, personId: string): Promise<"home" | "away"> {
  const [row] = await sql<{ side: "home" | "away" }[]>`
    select case when em.entrant_id = f.home_entrant_id then 'home' else 'away' end as side
      from fixtures f join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
     where f.id = ${fixtureId} and em.person_id = ${personId}`;
  if (!row) throw new Error("test: the person is not on the board");
  return row.side;
}

async function playerParticipant(fixtureId: string, personId: string): Promise<string> {
  return putVideoParticipant({ fixtureId, side: await sideOf(fixtureId, personId), personId });
}

function fakeVideo(over: Partial<ArbiterVideo> = {}) {
  let n = 0;
  const calls: string[] = [];
  const video: ArbiterVideo = {
    addParticipant: vi.fn(async (a: { meetingId: string; subject: string; preset: "player" | "arbiter" }): Promise<ParticipantToken> => {
      n += 1;
      calls.push(`add:${a.preset}:${a.subject}`);
      return { participantId: `arb-${n}-${randomUUID().slice(0, 4)}`, authToken: `tok-add-${n}` };
    }),
    removeParticipant: vi.fn(async (a: { meetingId: string; participantId: string }): Promise<void> => {
      calls.push(`remove:${a.participantId}`);
    }),
    ...over,
  };
  return { video, calls };
}

async function arbiterRows(fixtureId: string) {
  return sql<{ participant_id: string; user_id: string | null; person_id: string | null; removed_at: Date | null }[]>`
    select participant_id, user_id, person_id, removed_at from fixture_video_participants
     where fixture_id = ${fixtureId} and preset = 'arbiter' order by created_at, participant_id`;
}

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return [err.status, err.code ?? ""];
    throw err;
  }
  throw new Error("expected a refusal");
}

/** C1: a PLAYER of `board` who is also an admin of the club — the
 *  organiser who plays. Their session is a full organiser's. */
async function seatedAdmin(r: SeedOnlineChessRoundResult, userId: string): Promise<AuthCtx> {
  await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${userId}, 'admin')`;
  return { ...r.owner, userId, role: "admin" } as AuthCtx;
}

/** The roster edit a re-seat is: the entrant's member person replaced. */
async function replaceMember(entrantId: string, orgId: string): Promise<void> {
  const stand = await seedPlayer(orgId, "Stand-in", `s-${randomUUID().slice(0, 8)}`, false);
  await sql`delete from entrant_members where entrant_id = ${entrantId}`;
  await sql`insert into entrant_members (entrant_id, person_id, is_captain, roles) values (${entrantId}, ${stand.personId}, false, '{}')`;
}

// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("loadArbiterRound — the empty case first", () => {
  it("a division whose round was never opened has nothing to watch: null, and nothing blocks (D8)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    expect(await loadArbiterRound(r.owner, r.divisionId)).toBeNull();
  });

  it("another organisation's division is NOT FOUND, never an empty view", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(r);
    const stranger = await seedOwner();
    expect(await codeOf(loadArbiterRound(stranger, r.divisionId))).toEqual([404, "NOT_FOUND"]);
  });
});

describe.runIf(HAS_DB)("loadArbiterRound — the boards of the opened round", () => {
  it("M4: the boards are read together, not one after another — and the answer is the same as one at a time", async () => {
    const r = await seedOnlineChessRound({ fixtures: 4 });
    await openRound(r);
    const [, b, c] = r.boards;
    await bridge(b!.fixtureId, r.orgId, { status: "live", moves: 6 });
    await bridge(c!.fixtureId, r.orgId, { status: "needs_organiser", reason: "provider_error", moves: 2 });
    const quick = await loadArbiterRound(r.owner, r.divisionId);
    guardSpy.slow = true;
    try {
      const slow = await loadArbiterRound(r.owner, r.divisionId);
      expect(guardSpy.calls, "anti-vacuity: one side read per board").toBe(4);
      expect(guardSpy.maxInFlight, "every board's read in flight at once").toBe(4);
      expect(slow).toEqual(quick);
    } finally {
      guardSpy.slow = false;
    }
  });

  it("lists the paired boards in board order — never the bye, never the unpaired seat", async () => {
    const r = await seedOnlineChessRound({ fixtures: 3, bye: true, unpaired: true });
    await openRound(r);
    const view = await loadArbiterRound(r.owner, r.divisionId);
    expect(view).not.toBeNull();
    expect(view!.roundNo).toBe(1);
    expect(view!.stageId).toBe(r.stageId);
    // The seed's division clock is 15+10 (a ship-1 control).
    expect(view!.timeControl).toBe("15+10");
    expect(view!.boards.map((b) => b.fixtureId)).toEqual(r.boards.map((b) => b.fixtureId));
    expect(view!.boards.map((b) => b.boardNo)).toEqual([1, 2, 3]);
    // White is home on a board with no pairing card (guard.ts whiteSideOf).
    expect(view!.boards.map((b) => [b.white.name, b.black.name])).toEqual(
      r.boards.map((b, i) => [`P${i + 1}W`, `P${i + 1}B`]),
    );
  });

  it("each board's state: checking in, starting, live at the move being played, on hold, a result", async () => {
    const r = await seedOnlineChessRound({ fixtures: 5 });
    await openRound(r);
    const [a, b, c, d, e] = r.boards;
    // a: no bridge at all — nobody has arrived.
    await bridge(b!.fixtureId, r.orgId, { status: "ready" });
    await bridge(c!.fixtureId, r.orgId, { status: "live", moves: 60, whiteMs: 185_000, blackMs: 257_000 });
    await bridge(d!.fixtureId, r.orgId, { status: "needs_organiser", reason: "provider_error", moves: 4 });
    const auth = await mintOrgOwnerAuth(r.orgId);
    await scoreEvent(auth, e!.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, e!.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: e!.home.entrantId } });
    const view = (await loadArbiterRound(r.owner, r.divisionId))!;
    const byId = new Map(view.boards.map((x) => [x.fixtureId, x]));
    expect(byId.get(a!.fixtureId)!.state).toEqual({ kind: "checking_in" });
    expect(byId.get(b!.fixtureId)!.state).toEqual({ kind: "starting" });
    // 60 plies played: move 31 is being played (FIDE numbering).
    expect(byId.get(c!.fixtureId)!.state).toEqual({ kind: "live", moveNo: 31 });
    expect(byId.get(d!.fixtureId)!.state).toEqual({ kind: "on_hold" });
    // White (home) won: 1–0, White first (FIDE game score).
    expect(byId.get(e!.fixtureId)!.state).toEqual({ kind: "result", score: "1–0", noResult: false });
    // The live board's clocks as T10 stored them, running (ply >= 2); an even
    // ledger leaves White to move.
    expect(byId.get(c!.fixtureId)!.clock).toEqual({
      whiteMs: 185_000,
      blackMs: 257_000,
      asOf: OPENED.toISOString(),
      running: true,
      turn: "white",
    });
    expect(byId.get(a!.fixtureId)!.clock).toBeNull();
    // Resync reads a game on file that is not over; nothing else.
    expect(view.boards.map((x) => x.canResync)).toEqual([false, true, true, true, false]);
    expect(view.boards.map((x) => x.playable)).toEqual([true, true, true, true, false]);
    // T16: settled from the panel only with an online game on file (resolve
    // needs the bridge row; `a` has none) and not over. Nothing here is a
    // knockout draw on hold.
    expect(view.boards.map((x) => x.canSettle)).toEqual([false, true, true, true, false]);
    expect(view.boards.map((x) => x.tiebreakOwed)).toEqual([false, false, false, false, false]);
  });

  it("T16: whiteSide is the colour on file (the bridge's white_side), and the names follow it", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    await openRound(r);
    const [a, b] = r.boards;
    await bridge(a!.fixtureId, r.orgId, { status: "ready" });
    await bridge(b!.fixtureId, r.orgId, { status: "ready" });
    await sql`update fixture_external_play set white_side = 'away' where fixture_id = ${b!.fixtureId}`;
    await sql`update fixture_external_play set white_side = 'home' where fixture_id = ${a!.fixtureId}`;
    const view = (await loadArbiterRound(r.owner, r.divisionId))!;
    expect(view.boards.map((x) => [x.whiteSide, x.white.name, x.black.name])).toEqual([
      ["home", "P1W", "P1B"],
      ["away", "P2B", "P2W"],
    ]);
  });

  it("C1: the viewer's OWN board is never listed — counted, so the panel can say why; another organiser still sees it", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    await openRound(r);
    const [one, two] = r.boards;
    const admin = await seatedAdmin(r, one!.home.userId);
    const mine = (await loadArbiterRound(admin, r.divisionId))!;
    expect(mine.boards.map((b) => b.fixtureId)).toEqual([two!.fixtureId]);
    expect(mine.ownBoards).toBe(1);
    // The positive pair: the organiser who plays nowhere sees both.
    const theirs = (await loadArbiterRound(r.owner, r.divisionId))!;
    expect(theirs.boards.map((b) => b.fixtureId)).toEqual([one!.fixtureId, two!.fixtureId]);
    expect(theirs.ownBoards).toBe(0);
  });

  it("C1: every board the viewer's own — no board at all, and the count says so (the panel's plain state)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(r);
    const admin = await seatedAdmin(r, r.boards[0]!.away.userId);
    const view = (await loadArbiterRound(admin, r.divisionId))!;
    expect(view.boards).toEqual([]);
    expect(view.ownBoards).toBe(1);
  });

  it("a second opened round replaces the first in view; a later-opened EARLIER round number does not win by number", async () => {
    // Forward: round 1 opened, then round 2 — round 2 is in view.
    const forward = await seedOnlineChessRound({ fixtures: 1, roundNo: 2 });
    await openRound(forward, 1, OPENED);
    await openRound(forward, 2, new Date(OPENED.getTime() + 60_000));
    expect((await loadArbiterRound(forward.owner, forward.divisionId))!.roundNo, "round 2 opened second").toBe(2);
    // O1 (re-review 2), the differential: round 2 opened FIRST, round 1
    // LATER. The later opening is in view (the module's contract: the most
    // recently opened round), so round 1, never round 2 by its higher number.
    // The forward case alone cannot tell number from time; this one can.
    const back = await seedOnlineChessRound({ fixtures: 1, roundNo: 2 });
    await openRound(back, 2, OPENED);
    await openRound(back, 1, new Date(OPENED.getTime() + 60_000));
    expect((await loadArbiterRound(back.owner, back.divisionId))!.roundNo, "round 1 opened second").toBe(1);
  });

  it("camera policy, and whether the camera report is still to come", async () => {
    const r = await seedOnlineChessRound({ fixtures: 3, cameraPolicy: "required" });
    await openRound(r);
    const [a, b] = r.boards;
    await bridge(a!.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(a!.fixtureId, r.orgId);
    await bridge(b!.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(b!.fixtureId, r.orgId, { evidence: true });
    // The third board: no game yet — no report to expect.
    const view = (await loadArbiterRound(r.owner, r.divisionId))!;
    expect(view.boards.map((x) => x.cameraPolicy)).toEqual(["required", "required", "required"]);
    expect(view.boards.map((x) => x.cameraReport)).toEqual(["pending", "settled", null]);

    const off = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(off);
    await bridge(off.boards[0]!.fixtureId, off.orgId, { status: "live", moves: 10 });
    const offView = (await loadArbiterRound(off.owner, off.divisionId))!;
    expect(offView.boards[0]!.cameraPolicy).toBe("off");
    expect(offView.boards[0]!.cameraReport, "no camera, no report").toBeNull();
  });

  it("a video override is shown, and leaves no camera report to wait for", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    await bridge(r.boards[0]!.fixtureId, r.orgId, { status: "live", moves: 4 });
    await sql`update fixture_external_play set video_override_at = now() where fixture_id = ${r.boards[0]!.fixtureId}`;
    const board = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect(board.videoOverridden).toBe(true);
    expect(board.cameraReport).toBeNull();
  });
});

describe.runIf(HAS_DB)("loadArbiterRound - a meeting per player (D16, §5.6.4): each board ONCE, whatever its rows", () => {
  type Row = { evidence?: boolean; ended?: boolean };
  type Case = {
    label: string;
    rows: { home?: Row; away?: Row };
    /** Make the away row a meeting stamped for ANOTHER pairing (the board was re-paired since). */
    awayStale?: boolean;
    state: { home: "none" | "open" | "ended"; away: "none" | "open" | "ended" };
    report: "pending" | "settled" | null;
    warns: number;
  };
  // Expected values from the spec's own table (§5.6.4), not from the code: 0 rows -> both none and no report on a started
  // Required board; 1 row -> pending, with the warning; 2 rows -> one stamped is pending, both stamped is settled.
  const CASES: Case[] = [
    { label: "0 rows", rows: {}, state: { home: "none", away: "none" }, report: null, warns: 0 },
    { label: "1 row (home), open", rows: { home: {} }, state: { home: "open", away: "none" }, report: "pending", warns: 1 },
    { label: "1 row (away), stamped - still pending: the other player's meeting has not been judged", rows: { away: { evidence: true } }, state: { home: "none", away: "ended" }, report: "pending", warns: 1 },
    { label: "2 rows, neither stamped", rows: { home: {}, away: {} }, state: { home: "open", away: "open" }, report: "pending", warns: 0 },
    { label: "2 rows, one stamped", rows: { home: { evidence: true }, away: {} }, state: { home: "ended", away: "open" }, report: "pending", warns: 0 },
    { label: "2 rows, both stamped", rows: { home: { evidence: true }, away: { evidence: true } }, state: { home: "ended", away: "ended" }, report: "settled", warns: 0 },
    { label: "2 rows, home ended and away still live", rows: { home: { ended: true }, away: {} }, state: { home: "ended", away: "open" }, report: "pending", warns: 0 },
    { label: "2 rows, the away one made for an earlier pairing - it is no meeting of this board's", rows: { home: {}, away: {} }, awayStale: true, state: { home: "open", away: "none" }, report: "pending", warns: 1 },
  ];

  it("a started Required board is listed ONCE with 0, 1 and 2 meeting rows, its sides and camera report as the table says, and the one-row warning logged exactly where it should - counted", async () => {
    const r = await seedOnlineChessRound({ fixtures: CASES.length, cameraPolicy: "required" });
    await openRound(r);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      for (const [i, c] of CASES.entries()) {
        const b = r.boards[i]!;
        await bridge(b.fixtureId, r.orgId, { status: "live", moves: 10 });
        for (const side of ["home", "away"] as const) {
          const row = c.rows[side];
          if (!row) continue;
          await putVideoMeeting(
            { fixtureId: b.fixtureId, orgId: r.orgId, side },
            { endedAt: row.ended || row.evidence ? new Date() : null, evidenceAt: row.evidence ? new Date() : null },
          );
        }
        if (c.awayStale) {
          await sql`update fixture_video_meetings set away_entrant_id = home_entrant_id where fixture_id = ${b.fixtureId} and side = 'away'`;
        }
      }
      let checked = 0;
      const view = (await loadArbiterRound(r.owner, r.divisionId))!;
      expect(view.boards.length, "every board listed once - never once per meeting row").toBe(CASES.length);
      expect(new Set(view.boards.map((b) => b.fixtureId)).size).toBe(CASES.length);
      for (const [i, c] of CASES.entries()) {
        const b = view.boards.find((x) => x.fixtureId === r.boards[i]!.fixtureId)!;
        expect([b.sides.home.state, b.sides.away.state], `${c.label}: sides`).toEqual([c.state.home, c.state.away]);
        expect(b.cameraReport, `${c.label}: camera report`).toBe(c.report);
        const warned = warn.mock.calls.filter((call) => (call[0] as { fixtureId?: string }).fixtureId === r.boards[i]!.fixtureId).length;
        expect(warned, `${c.label}: the one-row warning`).toBe(c.warns);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every row-count case").toBe(CASES.length);
      expect(new Set(CASES.map((c) => c.report)), "and all three report values were produced").toEqual(new Set([null, "pending", "settled"]));
    } finally {
      warn.mockRestore();
    }
  });

  it("an unstarted Required board and a camera-off board have no report whatever their rows say (the empty case first)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    await meeting(r.boards[0]!.fixtureId, r.orgId, { evidence: true });
    const unstarted = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect([unstarted.sides.home.state, unstarted.sides.away.state]).toEqual(["ended", "ended"]);
    expect(unstarted.cameraReport, "no first move yet: nothing to report on").toBeNull();
  });

  it("a colour swap after a player arrived relabels the panel and leaves both meetings alone: same rows, same sides, and a join by SIDE reaches the same meeting", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const b = r.boards[0]!;
    await bridge(b.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(b.fixtureId, r.orgId);
    const home = await playerParticipant(b.fixtureId, b.home.personId);
    const rowsOf = () => sql`select side, meeting_id, ended_at from fixture_video_meetings where fixture_id = ${b.fixtureId} order by side`;
    const before = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    const rowsBefore = await rowsOf();
    expect(before.whiteSide, "premise: home is White").toBe("home");
    await sql`update fixture_external_play set white_side = 'away' where fixture_id = ${b.fixtureId}`; // the pairing card
    const after = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect(after.whiteSide, "the pane is relabelled").toBe("away");
    expect(after.sides, "the meetings are not").toEqual(before.sides);
    expect(await rowsOf(), "and neither are their rows").toEqual(rowsBefore);
    const { video } = fakeVideo();
    const out = await joinAsArbiter(r.owner, b.fixtureId, "home", { video });
    expect(out.players, "the home meeting still holds the home player - now Black").toEqual([home]);
  });

  it("a flag's window is its own player's meeting: two rows ended at different times, and each player's connection time is counted over THEIR window", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const b = r.boards[0]!;
    await bridge(b.fixtureId, r.orgId, { status: "live", moves: 60, startedAt: new Date("2026-10-12T19:18:00.000Z") });
    await sql`update fixture_external_play set game_over_at = '2026-10-12T19:39:00Z' where fixture_id = ${b.fixtureId}`;
    // Home's room closed at 19:30, away's at 19:44 (after the game): the windows are 19:18-19:30 and 19:18-19:39.
    await putVideoMeeting({ fixtureId: b.fixtureId, orgId: r.orgId, side: "home" }, { endedAt: new Date("2026-10-12T19:30:00Z") });
    await putVideoMeeting({ fixtureId: b.fixtureId, orgId: r.orgId, side: "away" }, { endedAt: new Date("2026-10-12T19:44:00Z") });
    // The SAME stamp span for each player, straddling home's room end: 19:29:00 to 19:31:00.
    await sql`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at) values
      (${b.fixtureId}, 'home', ${b.home.personId}, '2026-10-12T19:29:00Z', '2026-10-12T19:31:00Z'),
      (${b.fixtureId}, 'away', ${b.away.personId}, '2026-10-12T19:29:00Z', '2026-10-12T19:31:00Z')`;
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, opened_at, note) values
      (${b.fixtureId}, ${r.orgId}, 'camera_connection_problems', ${b.home.personId}, '2026-10-12T19:45:00Z', 'x'),
      (${b.fixtureId}, ${r.orgId}, 'camera_connection_problems', ${b.away.personId}, '2026-10-12T19:46:00Z', 'y')`;
    const flags = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags;
    const homeFlag = flags.find((f) => f.kind === "camera_connection_problems" && f.personName === "P1W");
    const awayFlag = flags.find((f) => f.kind === "camera_connection_problems" && f.personName === "P1B");
    // Expected: the span clipped to each window - 19:29-19:30 is 60 s of home's, 19:29-19:31 is all 120 s of away's.
    expect(homeFlag, "home's flag").toMatchObject({ seconds: 60, stamps: 1 });
    expect(awayFlag, "away's flag").toMatchObject({ seconds: 120, stamps: 1 });
  });
});

describe.runIf(HAS_DB)("loadArbiterRound — flags, as evidence", () => {
  it("no flag on file: an empty list (the empty case, stated)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(r);
    expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags).toEqual([]);
  });

  it("every flag kind, read: plies from reconcile's note, the camera report from the sweep's, connection time from the guard's stamps", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const board = r.boards[0]!;
    const fid = board.fixtureId;
    await bridge(fid, r.orgId, { status: "live", moves: 60, startedAt: new Date("2026-10-12T19:18:00.000Z") });
    // The game ended at 19:39 (reconcile's game_over_at) and the sweep settled
    // the evidence after it: the match window is 19:18 → 19:39.
    await sql`update fixture_external_play set game_over_at = '2026-10-12T19:39:00Z' where fixture_id = ${fid}`;
    await meeting(fid, r.orgId, { evidence: true });
    // T7 tore the room down after the game; job 5 read it 2+ minutes later.
    await sql`update fixture_video_meetings set ended_at = '2026-10-12T19:44:00Z', camera_evidence_at = '2026-10-12T19:47:00Z'
               where fixture_id = ${fid}`;
    // reconcile's writer (I5) — its note shape.
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, opened_at, note) values
      (${fid}, ${r.orgId}, 'out_of_band_play', null, '2026-10-12T19:38:00Z',
       'plies 51-53 (a2a3 a7a6 b2b3) played at Lichess, not through Seazn; camera required')`;
    // the sweep's job 5 writer — its note shapes.
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, opened_at, note) values
      (${fid}, ${r.orgId}, 'camera_lost', ${board.away.personId}, '2026-10-12T19:41:00Z',
       'camera off 189 s of 1260 s in the match: 2026-10-12T19:31:05.000Z to 2026-10-12T19:34:14.000Z (its own off/on events agree); from 2 camera connections over 1 session; camera required')`;
    // The note says 999 s; the guard's own stamps say 40 + 50 = 90 s. The
    // stamps are the authority (controller addendum 2026-10-12).
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, opened_at, note) values
      (${fid}, ${r.orgId}, 'camera_connection_problems', ${board.home.personId}, '2026-10-12T19:42:00Z',
       '999 s stamped as our side''s camera connection problems, 7 stamps in the match: x to y; camera required')`;
    await sql`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at) values
      (${fid}, 'home', ${board.home.personId}, '2026-10-12T19:20:00Z', '2026-10-12T19:20:40Z'),
      (${fid}, 'home', ${board.home.personId}, '2026-10-12T19:25:00Z', '2026-10-12T19:25:50Z')`;

    const flags = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags;
    expect(flags.map((f) => f.kind), "oldest first").toEqual(["out_of_band_play", "camera_lost", "camera_connection_problems"]);
    expect(flags[0]).toMatchObject({ kind: "out_of_band_play", at: "2026-10-12T19:38:00.000Z", plies: { from: 51, to: 53 } });
    expect(flags[1]).toMatchObject({
      kind: "camera_lost",
      personName: "P1B",
      windowFrom: "2026-10-12T19:18:00.000Z",
      report: {
        offSeconds: 189,
        windowSeconds: 1260,
        intervals: [{ from: "2026-10-12T19:31:05.000Z", to: "2026-10-12T19:34:14.000Z", confirmedByEvents: true }],
        connections: 2,
        sessions: 1,
      },
    });
    expect(flags[2]).toMatchObject({ kind: "camera_connection_problems", personName: "P1W", seconds: 90, stamps: 2 });
  });

  it("a note no reader understands is still shown — as a flag with no numbers, never dropped", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(r);
    const fid = r.boards[0]!.fixtureId;
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
      (${fid}, ${r.orgId}, 'out_of_band_play', null, 'a note from an older writer'),
      (${fid}, ${r.orgId}, 'camera_lost', ${r.boards[0]!.home.personId}, null),
      (${fid}, ${r.orgId}, 'camera_connection_problems', ${r.boards[0]!.away.personId}, '999 s stamped')`;
    // A stamp on file — but the board has no first move, so there is no match
    // window to read it over (match-window.ts): no number, never the note's.
    await meeting(fid, r.orgId, { sides: ["away"] });
    await sql`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at)
              values (${fid}, 'away', ${r.boards[0]!.away.personId}, '2026-10-12T19:20:00Z', '2026-10-12T19:22:00Z')`;
    const flags = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags;
    expect(flags.length).toBe(3);
    expect(flags.find((f) => f.kind === "out_of_band_play")).toMatchObject({ plies: null });
    expect(flags.find((f) => f.kind === "camera_lost")).toMatchObject({ report: null, personName: "P1W" });
    expect(flags.find((f) => f.kind === "camera_connection_problems")).toMatchObject({ seconds: null, stamps: null, personName: "P1B" });
  });
});

// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("arbiterRequestedRound — ?fixture= opens EXACTLY that board, or says it cannot (I3)", () => {
  /** Two rounds of one division: board 1 stays in round 1, board 2 is
   *  moved to round 2 (the next round's pairing), both opened, round 2 last. */
  async function twoRounds() {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [one, two] = r.boards;
    await sql`update fixtures set round_no = 2, seq_in_round = 1 where id = ${two!.fixtureId}`;
    await openRound(r, 1, OPENED);
    await openRound(r, 2, new Date(OPENED.getTime() + 60_000));
    return { r, one: one!, two: two! };
  }

  it("an EARLIER round's board: that round, with that board in it — never the latest round", async () => {
    const { r, one, two } = await twoRounds();
    expect((await loadArbiterRound(r.owner, r.divisionId))!.roundNo, "premise: the default is the latest round").toBe(2);
    const asked = await arbiterRequestedRound(r.owner, r.divisionId, one.fixtureId);
    expect(asked).toEqual({ kind: "round", stageId: r.stageId, roundNo: 1 });
    const view = (await loadArbiterRound(r.owner, r.divisionId, { round: asked as { stageId: string; roundNo: number } }))!;
    expect(view.roundNo).toBe(1);
    expect(view.boards.map((b) => b.fixtureId)).toEqual([one.fixtureId]);
    // The positive pair: the latest round's own board is its round.
    expect(await arbiterRequestedRound(r.owner, r.divisionId, two.fixtureId)).toEqual({ kind: "round", stageId: r.stageId, roundNo: 2 });
  });

  it("a HELD board (needs_organiser) is opened too: `?fixture=` lands on ITS round with that board on hold - what the Fixtures tab's 'Needs a decision' chip leans on", async () => {
    const { r, one, two } = await twoRounds();
    // Premise from the product's own reader: nothing is held yet, so every id below is held by the writes that follow.
    expect(await listNeedsOrganiserExternalPlay(r.owner, r.divisionId), "premise: nothing held yet").toEqual([]);
    await bridge(one.fixtureId, r.orgId, { status: "needs_organiser", reason: "provider_error", moves: 4 });
    await bridge(two.fixtureId, r.orgId, { status: "needs_organiser", reason: "fair_play" });
    const held = (await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).map((q) => q.fixtureId).sort();
    expect(held, "premise: the queue lists both boards as held, one per round").toEqual([one.fixtureId, two.fixtureId].sort());

    // Round numbers are the seed's layout (`twoRounds`: board one stays in round 1, board two moved to round 2).
    const rounds = new Map([[one.fixtureId, 1], [two.fixtureId, 2]]);
    let checked = 0;
    for (const fixtureId of held) {
      const asked = await arbiterRequestedRound(r.owner, r.divisionId, fixtureId);
      expect(asked, `${fixtureId}: a held board is a round, not 'unavailable'`).toEqual({ kind: "round", stageId: r.stageId, roundNo: rounds.get(fixtureId) });
      const view = (await loadArbiterRound(r.owner, r.divisionId, { round: asked as { stageId: string; roundNo: number } }))!;
      const board = view.boards.find((b) => b.fixtureId === fixtureId);
      expect(board, `${fixtureId}: the held board is in the round the panel opens`).toBeDefined();
      expect(board!.state, `${fixtureId}: and it reads on hold`).toEqual({ kind: "on_hold" });
      checked++;
    }
    expect(checked, "anti-vacuity: held boards opened").toBe(2);
    // The differential: a board of the same rounds that is NOT held resolves to a round too but never reads on hold.
    const clear = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(clear, 1, OPENED);
    const free = await arbiterRequestedRound(clear.owner, clear.divisionId, clear.boards[0]!.fixtureId);
    expect(free).toEqual({ kind: "round", stageId: clear.stageId, roundNo: 1 });
    const freeView = (await loadArbiterRound(clear.owner, clear.divisionId, { round: free as { stageId: string; roundNo: number } }))!;
    expect(freeView.boards[0]!.state).not.toEqual({ kind: "on_hold" });
  });

  it("unavailable, never another board: an unknown id, a malformed id, another club's board, another division's, a round never opened, a cancelled board", async () => {
    const { r, one } = await twoRounds();
    const stranger = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(stranger);
    const unopened = await seedOnlineChessRound({ fixtures: 1 });
    const cancelled = await seedOnlineChessRound({ fixtures: 2, unpaired: true });
    await openRound(cancelled);
    await sql`update fixtures set status = 'cancelled' where id = ${cancelled.boards[1]!.fixtureId}`;
    const otherDivision = await createDivision(r.owner, r.competitionId, {
      name: "Second",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
    });
    const cases: [string, Promise<unknown>][] = [
      ["unknown id", arbiterRequestedRound(r.owner, r.divisionId, randomUUID())],
      ["malformed id", arbiterRequestedRound(r.owner, r.divisionId, "not-a-uuid'; select 1")],
      ["another club's board", arbiterRequestedRound(r.owner, r.divisionId, stranger.boards[0]!.fixtureId)],
      ["another club's board, asked of its own division", arbiterRequestedRound(r.owner, stranger.divisionId, stranger.boards[0]!.fixtureId)],
      ["this club's board, asked of another division", arbiterRequestedRound(r.owner, otherDivision.id, one.fixtureId)],
      ["a round never opened", arbiterRequestedRound(unopened.owner, unopened.divisionId, unopened.boards[0]!.fixtureId)],
      ["a cancelled board", arbiterRequestedRound(cancelled.owner, cancelled.divisionId, cancelled.boards[1]!.fixtureId)],
      ["an unpaired seat", arbiterRequestedRound(cancelled.owner, cancelled.divisionId, cancelled.unpairedFixtureId!)],
    ];
    let checked = 0;
    for (const [why, asked] of cases) {
      expect(await asked, why).toEqual({ kind: "unavailable" });
      checked++;
    }
    expect(checked).toBe(8);
    // The positive pair of the last case: the round's other board is there.
    expect(await arbiterRequestedRound(cancelled.owner, cancelled.divisionId, cancelled.boards[0]!.fixtureId)).toMatchObject({ kind: "round" });
  });

  it("C1: a board the viewer plays on is 'own' — named, never opened", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    await openRound(r);
    const admin = await seatedAdmin(r, r.boards[0]!.home.userId);
    expect(await arbiterRequestedRound(admin, r.divisionId, r.boards[0]!.fixtureId)).toEqual({ kind: "own" });
    expect(await arbiterRequestedRound(admin, r.divisionId, r.boards[1]!.fixtureId)).toMatchObject({ kind: "round" });
  });

  // N1 (re-review 1): a pinned board keeps its own round, so the panel must
  // be able to say a newer round is open. "Current" is the module's own
  // contract: the division's most recently OPENED round (D12), never the
  // highest number.
  it("N1: a pinned EARLIER round is not current while a newer one is open; the latest round, pinned or not, is — by opening order, not round number", async () => {
    const { r } = await twoRounds();
    const pin = async (roundNo: number) => (await loadArbiterRound(r.owner, r.divisionId, { round: { stageId: r.stageId, roundNo } }))!;
    const latest = async () => (await loadArbiterRound(r.owner, r.divisionId))!;
    let checked = 0;
    const is = (view: { roundNo: number; current: boolean }, roundNo: number, current: boolean, why: string) => {
      expect({ roundNo: view.roundNo, current: view.current }, why).toEqual({ roundNo, current });
      checked++;
    };
    is(await latest(), 2, true, "no pin: the latest round, current");
    is(await pin(1), 1, false, "round 1 pinned, round 2 opened after it");
    is(await pin(2), 2, true, "the latest round pinned");
    // Ordering differential: round 1 opened LAST is the current one, whatever
    // its number — and round 2, pinned, is then the earlier one.
    await sql`update stage_round_opens set opened_at = ${new Date(OPENED.getTime() + 120_000)} where stage_id = ${r.stageId} and round_no = 1`;
    is(await latest(), 1, true, "no pin, round 1 re-opened last");
    is(await pin(1), 1, true, "round 1 pinned, opened last");
    is(await pin(2), 2, false, "round 2 pinned, opened before round 1");
    // Stage differential: the division's NEXT stage opens its own round 1
    // last — the same round number, another stage, so stage 1's round 1 is
    // no longer current.
    const [next] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name) values (${r.divisionId}, 2, 'knockout', 'Final') returning id`;
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${next!.id}, ${r.orgId}, 1, ${new Date(OPENED.getTime() + 180_000)}, ${r.ownerUserId})`;
    is(await pin(1), 1, false, "stage 1 round 1 pinned, stage 2 round 1 opened last");
    const after = await latest();
    expect({ stageId: after.stageId, current: after.current }, "no pin: stage 2's round 1").toEqual({ stageId: next!.id, current: true });
    expect(checked).toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("joinAsArbiter — receive-only, its own participant, never a player's token", () => {
  async function liveRequired() {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const board = r.boards[0]!;
    await bridge(board.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(board.fixtureId, r.orgId);
    const white = await playerParticipant(board.fixtureId, board.home.personId);
    const black = await playerParticipant(board.fixtureId, board.away.personId);
    return { r, board, white, black };
  }

  it("joins as preset 'arbiter' under the organiser's user, in the NAMED side's meeting, and answers its own participant and that side's player - one list", async () => {
    const { r, board, white, black } = await liveRequired();
    let checked = 0;
    for (const [side, player] of [["home", white], ["away", black]] as const) {
      const { video, calls } = fakeVideo();
      const out = await joinAsArbiter(r.owner, board.fixtureId, side, { video });
      expect(out.side, side).toBe(side);
      expect(out.players, `${side}: that side's player only`).toEqual([player]);
      expect(out.authToken).toBe("tok-add-1");
      // The custom id: the organiser's user id and a per-open nonce (T17B fix 2, D3) - internal ids only. One vendor request:
      // the meeting is the player's, already made, and the arbiter never makes it (D16).
      expect(calls, side).toHaveLength(1);
      expect(calls[0], side).toMatch(new RegExp(`^add:arbiter:${r.ownerUserId}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
      // Never a player's token: the answer has exactly these four fields.
      expect(Object.keys(out).sort()).toEqual(["authToken", "participantId", "players", "side"]);
      const rows = (await arbiterRows(board.fixtureId)).filter((x) => x.participant_id === out.participantId);
      expect(rows.map((x) => [x.user_id, x.person_id, x.removed_at])).toEqual([[r.ownerUserId, null, null]]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("D16: the arbiter's participant lands in the meeting of the side it NAMED - the mint is addressed to that meeting's vendor id, the row carries that side", async () => {
    const { r, board } = await liveRequired();
    const meetingIds = new Map(
      (await sql<{ side: string; meeting_id: string }[]>`select side, meeting_id from fixture_video_meetings where fixture_id = ${board.fixtureId}`).map((m) => [m.side, m.meeting_id]),
    );
    expect(meetingIds.size, "premise: two different meetings").toBe(2);
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      const addressed: string[] = [];
      const { video } = fakeVideo({
        addParticipant: vi.fn(async (a: { meetingId: string }): Promise<ParticipantToken> => {
          addressed.push(a.meetingId);
          return { participantId: `arb-${side}-${randomUUID().slice(0, 4)}`, authToken: "t" };
        }),
      });
      const out = await joinAsArbiter(r.owner, board.fixtureId, side, { video });
      expect(addressed, `${side}: the mint is for that meeting`).toEqual([meetingIds.get(side)]);
      const [row] = await sql<{ side: string }[]>`select side from fixture_video_participants where participant_id = ${out.participantId}`;
      expect(row?.side, `${side}: the row is on that side`).toBe(side);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("D16: a side with NO meeting yet is a 409 VIDEO_MEETING_NOT_STARTED with ZERO vendor requests and no row; the side that has one joins; a meeting made for an earlier pairing is not started either", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const board = r.boards[0]!;
    await bridge(board.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(board.fixtureId, r.orgId, { sides: ["home"] });
    const { video, calls } = fakeVideo();
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "away", { video }))).toEqual([409, "VIDEO_MEETING_NOT_STARTED"]);
    expect(calls, "zero vendor requests - nothing created, nothing minted").toEqual([]);
    expect(await arbiterRows(board.fixtureId)).toEqual([]);
    expect((await sql`select 1 from fixture_video_meetings where fixture_id = ${board.fixtureId} and side = 'away'`).length, "and no meeting made").toBe(0);
    expect((await joinAsArbiter(r.owner, board.fixtureId, "home", { video })).side, "the positive pair").toBe("home");
    // A meeting stamped for ANOTHER pairing (the board was re-paired since) is not this pairing's meeting.
    await meeting(board.fixtureId, r.orgId, { sides: ["away"] });
    await sql`update fixture_video_meetings set away_entrant_id = home_entrant_id where fixture_id = ${board.fixtureId} and side = 'away'`;
    const before = calls.length;
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "away", { video }))).toEqual([409, "VIDEO_MEETING_NOT_STARTED"]);
    expect(calls.length, "refused before any request").toBe(before);
  });

  it("D16: a side whose meeting has ENDED keeps VIDEO_MEETING_ENDED - the other side's, still live, is joinable - and nothing is created", async () => {
    const { r, board } = await liveRequired();
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${board.fixtureId} and side = 'home'`;
    const { video, calls } = fakeVideo();
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video }))).toEqual([409, "VIDEO_MEETING_ENDED"]);
    expect(calls).toEqual([]);
    expect((await joinAsArbiter(r.owner, board.fixtureId, "away", { video })).side).toBe("away");
  });

  it("D16: past ARBITER_JOIN_LIMIT joins by one organiser of one board the next is a 429 and mints nothing; another board and another organiser have their own count", async () => {
    const counts = new Map<string, number>();
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { count: n, ttlMs: windowSeconds * 1000 };
    });
    try {
      const { r, board } = await liveRequired();
      const other = await liveRequired();
      const { video, calls } = fakeVideo();
      for (let i = 0; i < ARBITER_JOIN_LIMIT.max; i += 1) await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
      const minted = calls.filter((c) => c.startsWith("add:")).length;
      expect(minted, "anti-vacuity: the joins before the limit reached the vendor").toBe(ARBITER_JOIN_LIMIT.max);
      expect((await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video })))[0], "the next").toBe(429);
      expect((await codeOf(joinAsArbiter(r.owner, board.fixtureId, "away", { video })))[0], "either side: the count is per board").toBe(429);
      expect(calls.filter((c) => c.startsWith("add:")).length, "the refused joins minted nothing").toBe(minted);
      expect((await joinAsArbiter(other.r.owner, other.board.fixtureId, "home", { video })).side, "another board").toBe("home");
    } finally {
      __setRateLimitCounterForTests(null);
    }
  });

  it("I2: every open mints a FRESH participant — never a refresh, never a reuse — and each is its own watch on file", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    const first = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    const again = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    expect(again.participantId).not.toBe(first.participantId);
    expect([first.authToken, again.authToken]).toEqual(["tok-add-1", "tok-add-2"]);
    // Two at once: two more, never one shared.
    const [x, y] = await Promise.all([
      joinAsArbiter(r.owner, board.fixtureId, "home", { video }),
      joinAsArbiter(r.owner, board.fixtureId, "home", { video }),
    ]);
    expect(new Set([first, again, x, y].map((o) => o.participantId)).size).toBe(4);
    expect((await arbiterRows(board.fixtureId)).map((o) => o.user_id)).toEqual(Array(4).fill(r.ownerUserId));
    expect(calls.filter((c) => c.startsWith("add:")).length).toBe(4);
    expect(calls.filter((c) => !c.startsWith("add:")), "nothing refreshed, nothing removed").toEqual([]);
  });

  it("I2: a mint whose record cannot be written is removed at the vendor at once — never an untracked participant", async () => {
    const { r, board } = await liveRequired();
    // The vendor hands back an id already on file for this board: the
    // record's unique (fixture_id, participant_id) refuses it.
    await sql`insert into fixture_video_participants (fixture_id, side, preset, participant_id, user_id)
              values (${board.fixtureId}, 'home', 'arbiter', 'dup-1', ${r.ownerUserId})`;
    const { video, calls } = fakeVideo({
      addParticipant: vi.fn(async (): Promise<ParticipantToken> => ({ participantId: "dup-1", authToken: "tok-dup" })),
    });
    await expect(joinAsArbiter(r.owner, board.fixtureId, "home", { video })).rejects.toMatchObject({ code: "23505" });
    expect(calls).toEqual(["remove:dup-1"]);
    // T17B fix 2 (D3): the participant the vendor delete took is no live watch on file either.
    expect((await arbiterRows(board.fixtureId)).map((x) => [x.participant_id, x.removed_at !== null])).toEqual([["dup-1", true]]);
  });

  it("I2: only an owner or admin watches — a role the route let through (an accepted official, a viewer) is refused before anything is made", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    let checked = 0;
    for (const role of ["viewer", null] as const) {
      expect(await codeOf(joinAsArbiter({ ...r.owner, role } as AuthCtx, board.fixtureId, "home", { video })), String(role)).toEqual([403, "ARBITER_NOT_ORGANISER"]);
      checked++;
    }
    expect(checked).toBe(2);
    expect(calls).toEqual([]);
    expect(await arbiterRows(board.fixtureId)).toEqual([]);
  });

  it("I2: leaving removes the caller's own participant at the vendor and stamps the watch's end; a second leave changes nothing", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    const other = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    expect(await leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video })).toEqual({ removed: true });
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual([`remove:${out.participantId}`]);
    const rows = await arbiterRows(board.fixtureId);
    expect(rows.find((x) => x.participant_id === out.participantId)!.removed_at).toBeInstanceOf(Date);
    expect(rows.find((x) => x.participant_id === other.participantId)!.removed_at, "only that watch").toBeNull();
    // SEQUENCE: again — already removed, the vendor is not called twice.
    expect(await leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video })).toEqual({ removed: false });
    expect(calls.filter((c) => c.startsWith("remove:")).length).toBe(1);
  });

  it("I2: a leave is refused for anything not the caller's own arbiter participant on this board — nothing removed", async () => {
    const { r, board, white } = await liveRequired();
    const { video, calls } = fakeVideo();
    const mine = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${`arb2-${randomUUID().slice(0, 8)}@t.local`}, 'Second', true, 'en') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${u!.id}, 'admin')`;
    const colleague = { ...r.owner, userId: u!.id } as AuthCtx;
    const theirs = await joinAsArbiter(colleague, board.fixtureId, "home", { video });
    const elsewhere = await liveRequired();
    const stranger = await seedOwner();
    const cases: [string, () => Promise<unknown>, [number, string]][] = [
      ["a colleague's participant", () => leaveAsArbiter(r.owner, board.fixtureId, theirs.participantId, { video }), [404, "NOT_FOUND"]],
      ["a player's participant", () => leaveAsArbiter(r.owner, board.fixtureId, white, { video }), [404, "NOT_FOUND"]],
      ["my participant, named on another board", () => leaveAsArbiter(elsewhere.r.owner, elsewhere.board.fixtureId, mine.participantId, { video }), [404, "NOT_FOUND"]],
      ["another club", () => leaveAsArbiter(stranger, board.fixtureId, mine.participantId, { video }), [404, "NOT_FOUND"]],
      // The same user, under another club's authority: the board is not that club's.
      ["my participant, under another club", () => leaveAsArbiter({ ...r.owner, orgId: stranger.orgId }, board.fixtureId, mine.participantId, { video }), [404, "NOT_FOUND"]],
      ["no session", () => leaveAsArbiter({ ...r.owner, userId: null }, board.fixtureId, mine.participantId, { video }), [403, "ARBITER_NEEDS_SESSION"]],
    ];
    let checked = 0;
    for (const [why, call, refusal] of cases) {
      expect(await codeOf(call()), why).toEqual(refusal);
      checked++;
    }
    expect(checked).toBe(6);
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
    expect((await arbiterRows(board.fixtureId)).map((x) => x.removed_at)).toEqual([null, null]);
  });

  it("I2: leaving after the room was torn down stamps the watch with no vendor call — INACTIVE keeps every token out", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${board.fixtureId}`;
    expect(await leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video })).toEqual({ removed: true });
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
    expect((await arbiterRows(board.fixtureId))[0]!.removed_at).toBeInstanceOf(Date);
  });

  it("D16: a leave removes the participant from the meeting it was MINTED in - for each side, the vendor is addressed with that side's meeting id", async () => {
    const { r, board } = await liveRequired();
    const meetingIds = new Map(
      (await sql<{ side: string; meeting_id: string }[]>`select side, meeting_id from fixture_video_meetings where fixture_id = ${board.fixtureId}`).map((m) => [m.side, m.meeting_id]),
    );
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      const removed: { meetingId: string; participantId: string }[] = [];
      const { video } = fakeVideo({
        removeParticipant: vi.fn(async (a: { meetingId: string; participantId: string }) => void removed.push(a)),
      });
      const out = await joinAsArbiter(r.owner, board.fixtureId, side, { video });
      expect(await leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video }), side).toEqual({ removed: true });
      expect(removed, `${side}: removed from that side's meeting, and no other`).toEqual([{ meetingId: meetingIds.get(side), participantId: out.participantId }]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I2: the sweep ending the watch while this leave is at the vendor: the stamp is the sweep's — removed:false, its time kept", async () => {
    const { r, board } = await liveRequired();
    const swept = new Date(Date.now() - 1_000);
    const { video } = fakeVideo({
      // Staged inside the vendor call: another remover stamps the row first.
      removeParticipant: vi.fn(async (a: { meetingId: string; participantId: string }) => {
        await sql`update fixture_video_participants set removed_at = ${swept} where participant_id = ${a.participantId}`;
      }),
    });
    const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    expect(await leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video })).toEqual({ removed: false });
    expect((await arbiterRows(board.fixtureId))[0]!.removed_at?.getTime()).toBe(swept.getTime());
  });

  it("I2: a vendor outage on leave is a 503 and the watch stays OPEN — the sweep retries it", async () => {
    const { r, board } = await liveRequired();
    const { video } = fakeVideo({
      removeParticipant: vi.fn(async () => {
        throw new RealtimeKitError(503, "unavailable", "test outage");
      }),
    });
    const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    expect(await codeOf(leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video }))).toEqual([503, "VIDEO_UNAVAILABLE"]);
    expect((await arbiterRows(board.fixtureId))[0]!.removed_at).toBeNull();
  });

  // D21: the platform's RealtimeKit call budget is spent. The organiser is told to try again — the same 503 as an outage —
  // but it is not an outage: nothing is reported to Sentry, and nothing is left half done.
  it("D21: a join the call budget defers is a 503 VIDEO_UNAVAILABLE that is NOT reported as an error - at its one request (D16: the arbiter makes no meeting) - and the retry joins", async () => {
    const { r, board } = await liveRequired();
    let checked = 0;
    const stages = {
      "mint (addParticipant)": (err: Error) => fakeVideo({ addParticipant: vi.fn(async () => { throw err; }) }),
    };
    for (const [stage, make] of Object.entries(stages)) {
      vi.mocked(captureError).mockClear();
      const deferred = make(new RealtimeKitDeferred("test: budget spent"));
      expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video: deferred.video })), stage).toEqual([503, "VIDEO_UNAVAILABLE"]);
      expect(vi.mocked(captureError), `${stage}: a deferral is not an error`).not.toHaveBeenCalled();
      expect(await arbiterRows(board.fixtureId), `${stage}: nothing half done`).toEqual([]);
      // The pair: a real outage on the same call IS reported.
      const outage = make(new RealtimeKitError(503, "unavailable", "test outage"));
      expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video: outage.video })), `${stage}: outage`).toEqual([503, "VIDEO_UNAVAILABLE"]);
      expect(vi.mocked(captureError), `${stage}: an outage is reported`).toHaveBeenCalledTimes(1);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(stages).length);
    const { video } = fakeVideo();
    expect((await joinAsArbiter(r.owner, board.fixtureId, "home", { video })).authToken, "retried, it joins").toBeTruthy();
  });

  it("D21: a leave the call budget defers is a 503 and the watch stays OPEN for the sweep — and is not reported as an error", async () => {
    const { r, board } = await liveRequired();
    vi.mocked(captureError).mockClear();
    const { video } = fakeVideo({
      removeParticipant: vi.fn(async () => {
        throw new RealtimeKitDeferred("test: budget spent");
      }),
    });
    const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video });
    expect(await codeOf(leaveAsArbiter(r.owner, board.fixtureId, out.participantId, { video }))).toEqual([503, "VIDEO_UNAVAILABLE"]);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
    expect((await arbiterRows(board.fixtureId))[0]!.removed_at).toBeNull();
  });

  it("M2: only a board still being played is watched — every fixture status swept (ruling Q2: scheduled, in_play), refused before any room is made", async () => {
    const PLAYABLE = ["scheduled", "in_play"]; // controller ruling Q2 (2026-10-09), not the code's predicate
    const NOT_LOADED = ["finalized", "cancelled"]; // the online-play guard's own exclusions: not a board at all
    const { r, board } = await liveRequired();
    let checked = 0;
    for (const status of FIXTURE_STATUSES) {
      await sql`update fixtures set status = ${status} where id = ${board.fixtureId}`;
      const { video, calls } = fakeVideo();
      const out = await joinAsArbiter(r.owner, board.fixtureId, "home", { video }).then(
        () => "joined",
        (e: unknown) => (e instanceof HttpError ? `${e.status} ${e.code}` : String(e)),
      );
      const want = PLAYABLE.includes(status) ? "joined" : NOT_LOADED.includes(status) ? "404 NOT_FOUND" : "409 FIXTURE_NOT_PLAYABLE";
      expect(out, status).toBe(want);
      if (want !== "joined") expect(calls, `${status}: nothing made`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every fixture status").toBe(FIXTURE_STATUSES.length);
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("M2: a board whose game is over (bridge finished) and a round never opened are refused before any room is made; the positive pairs join", async () => {
    let checked = 0;
    // The game ended at Lichess, the fixture not yet settled.
    const over = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(over);
    await bridge(over.boards[0]!.fixtureId, over.orgId, { status: "finished", moves: 12 });
    await meeting(over.boards[0]!.fixtureId, over.orgId);
    const a = fakeVideo();
    expect(await codeOf(joinAsArbiter(over.owner, over.boards[0]!.fixtureId, "home", { video: a.video }))).toEqual([409, "FIXTURE_NOT_PLAYABLE"]);
    expect(a.calls).toEqual([]);
    checked++;
    await sql`update fixture_external_play set status = 'live' where fixture_id = ${over.boards[0]!.fixtureId}`;
    expect((await joinAsArbiter(over.owner, over.boards[0]!.fixtureId, "home", { video: a.video })).authToken, "positive pair: live").toBe("tok-add-1");
    // No open for this round (D12): no match exists yet.
    const shut = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await meeting(shut.boards[0]!.fixtureId, shut.orgId);
    const b = fakeVideo();
    expect(await codeOf(joinAsArbiter(shut.owner, shut.boards[0]!.fixtureId, "home", { video: b.video }))).toEqual([409, "ROUND_NOT_OPEN"]);
    expect(b.calls).toEqual([]);
    checked++;
    // Another round's open does not open this one.
    await openRound(shut, shut.roundNo + 1);
    expect(await codeOf(joinAsArbiter(shut.owner, shut.boards[0]!.fixtureId, "home", { video: b.video }))).toEqual([409, "ROUND_NOT_OPEN"]);
    checked++;
    await openRound(shut);
    expect((await joinAsArbiter(shut.owner, shut.boards[0]!.fixtureId, "home", { video: b.video })).authToken, "positive pair: opened").toBe("tok-add-1");
    expect(checked).toBe(3);
  });

  it("refuses with nothing written: an API key (no user), a device link, a vendor outage, an override, camera off, another org", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    let checked = 0;
    expect(await codeOf(joinAsArbiter({ ...r.owner, userId: null }, board.fixtureId, "home", { video }))).toEqual([403, "ARBITER_NEEDS_SESSION"]);
    checked++;
    // A scoring device link carries its ISSUER's userId (doc 13 §7) — still not a person watching.
    expect(
      await codeOf(joinAsArbiter({ ...r.owner, via: "device_link", deviceLinkId: "dl-test" }, board.fixtureId, "home", { video })),
    ).toEqual([403, "ARBITER_NEEDS_SESSION"]);
    checked++;

    const outage = fakeVideo({
      addParticipant: vi.fn(async () => {
        throw new RealtimeKitError(503, "unavailable", "test outage");
      }),
    });
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video: outage.video }))).toEqual([503, "VIDEO_UNAVAILABLE"]);
    checked++;

    await sql`update fixture_external_play set video_override_at = now() where fixture_id = ${board.fixtureId}`;
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video }))).toEqual([409, "VIDEO_OVERRIDDEN"]);
    checked++;

    const off = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(off);
    await bridge(off.boards[0]!.fixtureId, off.orgId, { status: "live", moves: 2 });
    expect(await codeOf(joinAsArbiter(off.owner, off.boards[0]!.fixtureId, "home", { video }))).toEqual([409, "VIDEO_NOT_IN_USE"]);
    checked++;

    const stranger = await seedOwner();
    expect(await codeOf(joinAsArbiter(stranger, board.fixtureId, "home", { video }))).toEqual([404, "NOT_FOUND"]);
    checked++;

    expect(checked).toBe(6);
    expect(calls.filter((c) => c.startsWith("add:")), "no participant was minted").toEqual([]);
    expect(await arbiterRows(board.fixtureId)).toEqual([]);
  });

  it("C1: an admin seated on board 1 is refused board 1 — before any meeting or participant — but may watch board 2", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, cameraPolicy: "required" });
    await openRound(r);
    const [one, two] = r.boards;
    for (const b of [one!, two!]) {
      await bridge(b.fixtureId, r.orgId, { status: "live", moves: 10 });
      await meeting(b.fixtureId, r.orgId);
      await playerParticipant(b.fixtureId, b.home.personId);
      await playerParticipant(b.fixtureId, b.away.personId);
    }
    const admin = await seatedAdmin(r, one!.home.userId);
    const { video, calls } = fakeVideo();
    expect(await codeOf(joinAsArbiter(admin, one!.fixtureId, "home", { video }))).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
    expect(calls, "refused before any vendor request: nothing made, nothing minted").toEqual([]);
    expect(await arbiterRows(one!.fixtureId)).toEqual([]);
    const out = await joinAsArbiter(admin, two!.fixtureId, "home", { video });
    expect(out.authToken).toBe("tok-add-1");
    expect((await arbiterRows(two!.fixtureId)).map((x) => x.user_id)).toEqual([one!.home.userId]);
  });

  it("C1: the refusal holds across both colours and after re-seating — off the roster but still in the meeting, or checked in", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, cameraPolicy: "required" });
    await openRound(r);
    const [one, two] = r.boards;
    for (const b of [one!, two!]) {
      await bridge(b.fixtureId, r.orgId, { status: "live", moves: 10 });
      await meeting(b.fixtureId, r.orgId);
    }
    const whitePlayer = await seatedAdmin(r, one!.home.userId);
    const blackPlayer = await seatedAdmin(r, one!.away.userId);
    const { video, calls } = fakeVideo();
    let checked = 0;
    const refused = async (auth: AuthCtx, fixtureId: string, why: string) => {
      expect(await codeOf(joinAsArbiter(auth, fixtureId, "home", { video })), why).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
      checked++;
    };
    // The bridge seats home as White.
    await refused(whitePlayer, one!.fixtureId, "home, White");
    await refused(blackPlayer, one!.fixtureId, "away, Black");
    // Colours swapped (a re-paired board: away is White now).
    await sql`update fixture_external_play set white_side = 'away' where fixture_id = ${one!.fixtureId}`;
    await refused(whitePlayer, one!.fixtureId, "home, now Black");
    await refused(blackPlayer, one!.fixtureId, "away, now White");
    // Re-seated off the roster after T8 seated them in the meeting.
    await playerParticipant(one!.fixtureId, one!.home.personId);
    await replaceMember(one!.home.entrantId, r.orgId);
    await refused(whitePlayer, one!.fixtureId, "off the roster, still a player participant");
    // Re-seated off the roster after checking in (no camera participant yet).
    const checkedIn = await seatedAdmin(r, two!.away.userId);
    await stampFixtureCheckIn(two!.away.personId, two!.fixtureId, r.orgId);
    await replaceMember(two!.away.entrantId, r.orgId);
    await refused(checkedIn, two!.fixtureId, "off the roster, checked in");
    expect(checked).toBe(6);
    expect(calls, "no meeting made, no participant minted").toEqual([]);
    expect([...(await arbiterRows(one!.fixtureId)), ...(await arbiterRows(two!.fixtureId))]).toEqual([]);
  });

  it("an ended meeting is refused by name, read from the row - the arbiter never makes another", async () => {
    const { r, board } = await liveRequired();
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${board.fixtureId}`;
    const ended = fakeVideo();
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, "home", { video: ended.video }))).toEqual([409, "VIDEO_MEETING_ENDED"]);
    expect(ended.calls, "and no request was made").toEqual([]);
  });
});

describe.runIf(HAS_DB)("the decision actions' usecases — who may press them", () => {
  const audits = (fixtureId: string) =>
    sql`select 1 from online_chess_audit where fixture_id = ${fixtureId} and kind = 'video_override'`;

  it("a key (no user), a device link, another club: refused before reconcile or the audit write; the organiser's press is recorded under their user", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    await openRound(r);
    const board = r.boards[0]!;
    await bridge(board.fixtureId, r.orgId, { status: "live", moves: 10 });
    const stranger = await seedOwner();
    const callers: [string, Parameters<typeof resyncExternalPlay>[0], [number, string]][] = [
      ["no user", { ...r.owner, userId: null }, [403, "ORGANISER_SESSION_REQUIRED"]],
      ["device link", { ...r.owner, via: "device_link", deviceLinkId: "dl-test" }, [403, "ORGANISER_SESSION_REQUIRED"]],
      ["another club", stranger, [404, "NOT_FOUND"]],
    ];
    let checked = 0;
    for (const [who, auth, refusal] of callers) {
      const reads: string[] = [];
      const deps = { exportGame: async (id: string) => (reads.push(id), null) };
      expect(await codeOf(resyncExternalPlay(auth, board.fixtureId, deps)), `resync, ${who}`).toEqual(refusal);
      expect(reads, `resync, ${who}: Lichess never read`).toEqual([]);
      expect(await codeOf(overrideVideoAsOrganiser(auth, board.fixtureId, "down")), `override, ${who}`).toEqual(refusal);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await audits(board.fixtureId)).toHaveLength(0);
    // The positive pair: the organiser's own press writes the one record.
    expect(await overrideVideoAsOrganiser(r.owner, board.fixtureId, "video down")).toEqual({ overridden: true });
    expect(
      await sql`select actor_user_id, note from online_chess_audit where fixture_id = ${board.fixtureId} and kind = 'video_override'`,
    ).toEqual([{ actor_user_id: r.ownerUserId, note: "video down" }]);
  });

  // Self-override (coordinator ruling, 2026-10-12): letting a board play
  // without video excuses its players' cameras, so an organiser who plays on
  // the board would be excusing their own. C1's shared seated predicate
  // decides; resync stays allowed, because it only re-reads Lichess.
  it("self-override: an admin seated on board 1 is refused the override there (any seat kind, nothing written) but may override board 2; resync on board 1 is allowed", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, cameraPolicy: "required" });
    await openRound(r);
    const [one, two] = r.boards;
    for (const b of [one!, two!]) await bridge(b.fixtureId, r.orgId, { status: "live", moves: 10 });
    await meeting(one!.fixtureId, r.orgId);
    const onRoster = await seatedAdmin(r, one!.home.userId);
    // Off the roster, still a player participant: the seat only the shared
    // predicate sees (a roster-only check would let this one through).
    const offRoster = await seatedAdmin(r, one!.away.userId);
    await playerParticipant(one!.fixtureId, one!.away.personId);
    await replaceMember(one!.away.entrantId, r.orgId);
    let checked = 0;
    for (const [who, auth] of [["on the roster", onRoster], ["off the roster, player participant", offRoster]] as const) {
      expect(await codeOf(overrideVideoAsOrganiser(auth, one!.fixtureId, "video down")), who).toEqual([
        403,
        "ARBITER_PLAYS_THIS_BOARD",
      ]);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await audits(one!.fixtureId), "no record for the refused board").toHaveLength(0);
    expect(
      (await sql<{ at: Date | null }[]>`select video_override_at as at from fixture_external_play where fixture_id = ${one!.fixtureId}`)[0]?.at,
      "board 1 still needs its cameras",
    ).toBeNull();
    // The positive pair: the same admin, a board they do not play on.
    expect(await overrideVideoAsOrganiser(onRoster, two!.fixtureId, "video down")).toEqual({ overridden: true });
    expect(
      await sql`select actor_user_id, note from online_chess_audit where fixture_id = ${two!.fixtureId} and kind = 'video_override'`,
    ).toEqual([{ actor_user_id: one!.home.userId, note: "video down" }]);
    // Resync on their OWN board: allowed, and Lichess is read.
    const reads: string[] = [];
    const out = await resyncExternalPlay(onRoster, one!.fixtureId, { exportGame: async (id: string) => (reads.push(id), null) });
    expect(reads, "Lichess read once for board 1").toHaveLength(1);
    expect(out.adopted).toBe(0);
  });
});

describe.runIf(HAS_DB)("fixture_video_participants.user_id / removed_at — V454's guards (SQLSTATE + constraint name)", () => {
  const refused = async (q: () => Promise<unknown>) => {
    try {
      await q();
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      return [e.code, e.constraint_name];
    }
    return ["no error", ""];
  };

  it("a PLAYER row never carries a user, nor a removal; an arbiter user has one row per WATCH (I2: no reuse)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    const fid = r.boards[0]!.fixtureId;
    await meeting(fid, r.orgId);
    expect(
      await refused(
        () => sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, user_id)
                  values (${fid}, 'home', ${r.boards[0]!.home.personId}, 'player', 'p-x', ${r.ownerUserId})`,
      ),
    ).toEqual(["23514", "fixture_video_participants_user_check"]);
    expect(
      await refused(
        () => sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, removed_at)
                  values (${fid}, 'home', ${r.boards[0]!.home.personId}, 'player', 'p-y', now())`,
      ),
    ).toEqual(["23514", "fixture_video_participants_removed_check"]);
    // Two watches by the same organiser of the same board: two rows, each its own.
    await sql`insert into fixture_video_participants (fixture_id, side, preset, participant_id, user_id, removed_at)
              values (${fid}, 'home', 'arbiter', 'a-1', ${r.ownerUserId}, now())`;
    await sql`insert into fixture_video_participants (fixture_id, side, preset, participant_id, user_id)
              values (${fid}, 'home', 'arbiter', 'a-2', ${r.ownerUserId})`;
    expect((await arbiterRows(fid)).map((x) => x.participant_id)).toEqual(["a-1", "a-2"]);
    // The positive pair of the removal check: an arbiter row takes one.
    expect(await refused(() => sql`update fixture_video_participants set removed_at = now() where fixture_id = ${fid} and participant_id = 'a-2'`)).toEqual([
      "no error",
      "",
    ]);
  });

  it("M5: deleting the watcher's account keeps the watch, with no user — the CHECK lets an arbiter row lose its user", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    const fid = r.boards[0]!.fixtureId;
    await meeting(fid, r.orgId);
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${`gone-${randomUUID().slice(0, 8)}@t.local`}, 'Gone', true, 'en') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${u!.id}, 'admin')`;
    await sql`insert into fixture_video_participants (fixture_id, side, preset, participant_id, user_id)
              values (${fid}, 'home', 'arbiter', 'a-gone', ${u!.id})`;
    expect(await refused(() => sql`delete from users where id = ${u!.id}`), "the account delete is not refused").toEqual(["no error", ""]);
    const rows = await sql<{ participant_id: string; user_id: string | null; created_at: Date }[]>`
      select participant_id, user_id, created_at from fixture_video_participants where fixture_id = ${fid} and preset = 'arbiter'`;
    expect(rows.map((x) => [x.participant_id, x.user_id])).toEqual([["a-gone", null]]);
    expect(rows[0]!.created_at, "the watch keeps its time").toBeInstanceOf(Date);
  });
});
