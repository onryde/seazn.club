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
import type { AuthCtx } from "@/server/api-v1/auth";
import { RealtimeKitError, type ParticipantToken } from "@/server/external-play/video/realtimekit";
import { stampFixtureCheckIn } from "../me";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { joinAsArbiter, loadArbiterRound, overrideVideoAsOrganiser, resyncExternalPlay, type ArbiterVideo } from "../external-play/arbiter";
import { seedOnlineChessRound, seedOwner, seedPlayer, type SeedOnlineChessRoundResult } from "./_external-play-seed";

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

async function meeting(fixtureId: string, orgId: string, opts: { ended?: boolean; evidence?: boolean } = {}) {
  await sql`
    insert into fixture_video_meetings (fixture_id, org_id, meeting_id, ended_at, camera_evidence_at)
    values (${fixtureId}, ${orgId}, ${`m-${randomUUID().slice(0, 8)}`},
            ${opts.ended || opts.evidence ? new Date() : null}, ${opts.evidence ? new Date() : null})`;
}

async function playerParticipant(fixtureId: string, personId: string): Promise<string> {
  const pid = `pp-${randomUUID().slice(0, 8)}`;
  await sql`
    insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
    values (${fixtureId}, ${personId}, 'player', ${pid})`;
  return pid;
}

function fakeVideo(over: Partial<ArbiterVideo> = {}) {
  let n = 0;
  const calls: string[] = [];
  const video: ArbiterVideo = {
    ensureMeeting: vi.fn(async (fixtureId: string) => {
      calls.push(`ensure:${fixtureId}`);
      const [row] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${fixtureId}`;
      if (!row) throw new Error("test: seed the meeting first");
      return { meetingId: row.meeting_id };
    }),
    addParticipant: vi.fn(async (a: { meetingId: string; subject: string; preset: "player" | "arbiter" }): Promise<ParticipantToken> => {
      n += 1;
      calls.push(`add:${a.preset}:${a.subject}`);
      return { participantId: `arb-${n}-${randomUUID().slice(0, 4)}`, authToken: `tok-add-${n}` };
    }),
    refreshParticipantToken: vi.fn(async (a: { meetingId: string; participantId: string }): Promise<ParticipantToken> => {
      calls.push(`refresh:${a.participantId}`);
      return { participantId: a.participantId, authToken: `tok-refresh-${a.participantId}` };
    }),
    ...over,
  };
  return { video, calls };
}

async function arbiterRows(fixtureId: string) {
  return sql<{ participant_id: string; user_id: string | null; person_id: string | null }[]>`
    select participant_id, user_id, person_id from fixture_video_participants
     where fixture_id = ${fixtureId} and preset = 'arbiter' order by created_at, id`;
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
    expect(byId.get(e!.fixtureId)!.state).toEqual({ kind: "result", score: "1–0" });
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
    const r = await seedOnlineChessRound({ fixtures: 1, roundNo: 2 });
    await openRound(r, 2, new Date(OPENED.getTime() + 60_000));
    await openRound(r, 1, OPENED);
    expect((await loadArbiterRound(r.owner, r.divisionId))!.roundNo).toBe(2);
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
    await sql`insert into fixture_video_guard_faults (fixture_id, person_id, started_at, ended_at) values
      (${fid}, ${board.home.personId}, '2026-10-12T19:20:00Z', '2026-10-12T19:20:40Z'),
      (${fid}, ${board.home.personId}, '2026-10-12T19:25:00Z', '2026-10-12T19:25:50Z')`;

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
      (${fid}, ${r.orgId}, 'camera_lost', ${r.boards[0]!.home.personId}, null)`;
    const flags = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags;
    expect(flags.length).toBe(2);
    expect(flags.find((f) => f.kind === "out_of_band_play")).toMatchObject({ plies: null });
    expect(flags.find((f) => f.kind === "camera_lost")).toMatchObject({ report: null, personName: "P1W" });
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

  it("joins as preset 'arbiter' under the organiser's user, and answers the two players' participant ids by colour", async () => {
    const { r, board, white, black } = await liveRequired();
    const { video, calls } = fakeVideo();
    const out = await joinAsArbiter(r.owner, board.fixtureId, { video });
    expect(out.white).toEqual([white]);
    expect(out.black).toEqual([black]);
    expect(out.authToken).toBe("tok-add-1");
    expect(calls).toEqual([`ensure:${board.fixtureId}`, `add:arbiter:${r.ownerUserId}`]);
    const rows = await arbiterRows(board.fixtureId);
    expect(rows.map((x) => [x.user_id, x.person_id])).toEqual([[r.ownerUserId, null]]);
    // Never a player's token: the answer has exactly these three fields.
    expect(Object.keys(out).sort()).toEqual(["authToken", "black", "white"]);
  });

  it("a second join by the same organiser refreshes the SAME participant; another organiser gets their own", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    await joinAsArbiter(r.owner, board.fixtureId, { video });
    const [first] = await arbiterRows(board.fixtureId);
    const again = await joinAsArbiter(r.owner, board.fixtureId, { video });
    expect(again.authToken).toBe(`tok-refresh-${first!.participant_id}`);
    expect((await arbiterRows(board.fixtureId)).length, "no second participant for the same user").toBe(1);
    // Positive pair: a different organiser of the same club is a second arbiter.
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${`arb-${randomUUID().slice(0, 8)}@t.local`}, 'Second', true, 'en') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${u!.id}, 'admin')`;
    await joinAsArbiter({ ...r.owner, userId: u!.id }, board.fixtureId, { video });
    expect((await arbiterRows(board.fixtureId)).map((x) => x.user_id)).toEqual([r.ownerUserId, u!.id]);
    expect(calls.filter((c) => c.startsWith("add:")).length).toBe(2);
  });

  it("two first joins at once: one participant on file, and both answers are usable (the loser refreshes the winner's)", async () => {
    const { r, board } = await liveRequired();
    // Staged: both calls are inside addParticipant before either inserts.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const base = fakeVideo();
    const video: ArbiterVideo = {
      ...base.video,
      addParticipant: vi.fn(async (a) => {
        const minted = await base.video.addParticipant(a);
        arrived += 1;
        if (arrived === 2) release();
        await gate;
        return minted;
      }),
    };
    const [x, y] = await Promise.all([
      joinAsArbiter(r.owner, board.fixtureId, { video }),
      joinAsArbiter(r.owner, board.fixtureId, { video }),
    ]);
    expect(arrived, "the race was staged: both minted before either inserted").toBe(2);
    const rows = await arbiterRows(board.fixtureId);
    expect(rows.length).toBe(1);
    const winner = rows[0]!.participant_id;
    // One answer is the winner's own minted token; the other a refresh of the winner's participant.
    const tokens = [x.authToken, y.authToken];
    expect(tokens).toContain(`tok-refresh-${winner}`);
    expect(tokens.filter((t) => t.startsWith("tok-add-")).length).toBe(1);
  });

  it("refuses with nothing written: an API key (no user), a device link, a vendor outage, an override, camera off, another org", async () => {
    const { r, board } = await liveRequired();
    const { video, calls } = fakeVideo();
    let checked = 0;
    expect(await codeOf(joinAsArbiter({ ...r.owner, userId: null }, board.fixtureId, { video }))).toEqual([403, "ARBITER_NEEDS_SESSION"]);
    checked++;
    // A scoring device link carries its ISSUER's userId (doc 13 §7) — still not a person watching.
    expect(
      await codeOf(joinAsArbiter({ ...r.owner, via: "device_link", deviceLinkId: "dl-test" }, board.fixtureId, { video })),
    ).toEqual([403, "ARBITER_NEEDS_SESSION"]);
    checked++;

    const outage = fakeVideo({
      ensureMeeting: vi.fn(async () => {
        throw new RealtimeKitError(503, "unavailable", "test outage");
      }),
    });
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, { video: outage.video }))).toEqual([503, "VIDEO_UNAVAILABLE"]);
    checked++;

    await sql`update fixture_external_play set video_override_at = now() where fixture_id = ${board.fixtureId}`;
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, { video }))).toEqual([409, "VIDEO_OVERRIDDEN"]);
    checked++;

    const off = await seedOnlineChessRound({ fixtures: 1 });
    await openRound(off);
    await bridge(off.boards[0]!.fixtureId, off.orgId, { status: "live", moves: 2 });
    expect(await codeOf(joinAsArbiter(off.owner, off.boards[0]!.fixtureId, { video }))).toEqual([409, "VIDEO_NOT_IN_USE"]);
    checked++;

    const stranger = await seedOwner();
    expect(await codeOf(joinAsArbiter(stranger, board.fixtureId, { video }))).toEqual([404, "NOT_FOUND"]);
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
    expect(await codeOf(joinAsArbiter(admin, one!.fixtureId, { video }))).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
    expect(calls, "refused before ensureMeeting: nothing made, nothing minted").toEqual([]);
    expect(await arbiterRows(one!.fixtureId)).toEqual([]);
    const out = await joinAsArbiter(admin, two!.fixtureId, { video });
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
      expect(await codeOf(joinAsArbiter(auth, fixtureId, { video })), why).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
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

  it("an ended meeting is the vendor adapter's 409, passed through — the arbiter never makes another", async () => {
    const { r, board } = await liveRequired();
    const ended = fakeVideo({
      ensureMeeting: vi.fn(async () => {
        throw new HttpError(409, "ended", "VIDEO_MEETING_ENDED");
      }),
    });
    expect(await codeOf(joinAsArbiter(r.owner, board.fixtureId, { video: ended.video }))).toEqual([409, "VIDEO_MEETING_ENDED"]);
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
});

describe.runIf(HAS_DB)("fixture_video_participants.user_id — V436's guards (SQLSTATE + constraint name)", () => {
  it("a PLAYER row never carries a user; an arbiter user has one row per fixture", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    const fid = r.boards[0]!.fixtureId;
    await meeting(fid, r.orgId);
    const refused = async (q: () => Promise<unknown>) => {
      try {
        await q();
      } catch (err) {
        const e = err as { code?: string; constraint_name?: string };
        return [e.code, e.constraint_name];
      }
      return ["no error", ""];
    };
    expect(
      await refused(
        () => sql`insert into fixture_video_participants (fixture_id, person_id, preset, participant_id, user_id)
                  values (${fid}, ${r.boards[0]!.home.personId}, 'player', 'p-x', ${r.ownerUserId})`,
      ),
    ).toEqual(["23514", "fixture_video_participants_user_check"]);
    await sql`insert into fixture_video_participants (fixture_id, preset, participant_id, user_id)
              values (${fid}, 'arbiter', 'a-1', ${r.ownerUserId})`;
    expect(
      await refused(
        () => sql`insert into fixture_video_participants (fixture_id, preset, participant_id, user_id)
                  values (${fid}, 'arbiter', 'a-2', ${r.ownerUserId})`,
      ),
    ).toEqual(["23505", "fixture_video_participants_arbiter_idx"]);
  });
});
