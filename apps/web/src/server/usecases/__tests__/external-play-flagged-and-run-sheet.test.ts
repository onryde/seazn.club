// T16 — the two division-wide readers behind the organiser's fixtures tab:
//   - listFlaggedExternalPlay: the queue's "Flagged · the game carried on"
//     list — every board with OPEN flags, any round, any state;
//   - listRunSheetOnlinePlay: the run sheet's chips — camera policy, open
//     flags by kind, held for the organiser.
//
// Flag rows here are SQL stand-ins for their producers (reconcile's
// out_of_band_play, the sweep's camera judgments — driven for real in
// external-play-reconcile.test.ts and external-play-sweep.test.ts, whose T16
// cases read their flags back through these readers). Holds come from the
// real writer (holdForOrganiser). Single-sport by construction: online play
// exists only for `boardgame` (guard.ts).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { listFlaggedExternalPlay } from "../external-play/arbiter";
import { closeExternalPlayFlags } from "../external-play/flags";
import { holdForOrganiser } from "../external-play/result";
import { listRunSheetOnlinePlay } from "../external-play/run-sheet";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return [err.status, err.code ?? ""];
    throw err;
  }
  throw new Error("expected a refusal");
}

async function round(fixtures = 1): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
    values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
  return r;
}

async function gameBridge(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, status: "ready" | "live" = "live") {
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
    values (${b.fixtureId}, ${r.orgId}, ${status}, now() - interval '5 minutes', ${`gm-${randomUUID().slice(0, 12)}`},
            'home', ${b.home.lichessId}, ${b.away.lichessId})`;
}

async function flag(r: SeedOnlineChessRoundResult, fixtureId: string, kind = "out_of_band_play", personId: string | null = null) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
    values (${fixtureId}, ${r.orgId}, ${kind}, ${personId}, ${kind === "out_of_band_play" ? "plies 3-4 (e7e5 g1f3); camera not required (policy off)" : null})
    returning id`;
  return row!.id;
}

async function decide(r: SeedOnlineChessRoundResult, b: SeedRoundBoard) {
  const fs = await getFixtureState(r.owner, b.fixtureId);
  await scoreEvent(r.owner, b.fixtureId, { expected_seq: fs.last_seq, type: "core.start", payload: {} });
  await scoreEvent(r.owner, b.fixtureId, { expected_seq: fs.last_seq + 1, type: "boardgame.result", payload: { winner: b.home.entrantId } });
}

async function seatedAdmin(r: SeedOnlineChessRoundResult, userId: string): Promise<AuthCtx> {
  await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${userId}, 'admin')`;
  return { ...r.owner, userId, role: "admin" } as AuthCtx;
}

// ---------------------------------------------------------------------------
// listFlaggedExternalPlay
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("listFlaggedExternalPlay — the queue's Flagged list", () => {
  it("the empty case first: no flags ⇒ nothing; a CLOSED flag only ⇒ still nothing", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b);
    expect(await listFlaggedExternalPlay(r.owner, r.divisionId)).toEqual({ boards: [], ownBoards: 0 });
    const id = await flag(r, b.fixtureId);
    await closeExternalPlayFlags(r.owner, b.fixtureId, [id]);
    expect(await listFlaggedExternalPlay(r.owner, r.divisionId)).toEqual({ boards: [], ownBoards: 0 });
  });

  it("every board with an OPEN flag, any round and any state — a finished game is the usual case — each with its open flags only", async () => {
    const r = await round(3);
    const [one, two, three] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await gameBridge(r, one);
    await gameBridge(r, two);
    await gameBridge(r, three);
    // `two` moves to round 2 (the list is division-wide, not the round in view).
    await sql`update fixtures set round_no = 2 where id = ${two.fixtureId}`;
    await decide(r, one);
    const open = await flag(r, one.fixtureId, "camera_lost", one.away.personId);
    const shut = await flag(r, one.fixtureId);
    await closeExternalPlayFlags(r.owner, one.fixtureId, [shut]);
    const second = await flag(r, two.fixtureId);
    // `three` has no flag: not listed.

    const { boards, ownBoards } = await listFlaggedExternalPlay(r.owner, r.divisionId);
    expect(ownBoards).toBe(0);
    const [stage] = await sql<{ name: string }[]>`select name from stages where id = ${r.stageId}`;
    expect(boards.map((x) => [x.fixtureId, x.roundNo, x.stageName, x.flags.map((f) => f.id)])).toEqual([
      [one.fixtureId, 1, stage!.name, [open]],
      [two.fixtureId, 2, stage!.name, [second]],
    ]);
    // The finished board reads as its result (White, home, won: 1–0).
    expect(boards[0]!.state).toEqual({ kind: "result", score: "1–0" });
    expect(boards[1]!.state.kind).not.toBe("result");
  });

  it("the sequence: 'Let the game go on' on the flags shown takes the board off the list; a flag raised after it puts it back", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b);
    await flag(r, b.fixtureId);
    const shown = (await listFlaggedExternalPlay(r.owner, r.divisionId)).boards[0]!.flags.map((f) => f.id);
    expect(await closeExternalPlayFlags(r.owner, b.fixtureId, shown)).toEqual({ closed: 1, stillOpen: 0 });
    expect((await listFlaggedExternalPlay(r.owner, r.divisionId)).boards).toEqual([]);
    const late = await flag(r, b.fixtureId);
    expect((await listFlaggedExternalPlay(r.owner, r.divisionId)).boards.map((x) => x.flags.map((f) => f.id))).toEqual([[late]]);
  });

  it("C1: a board the viewer plays on is never listed — counted; another organiser sees it", async () => {
    const r = await round(2);
    const [mine, other] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await gameBridge(r, mine);
    await gameBridge(r, other);
    await flag(r, mine.fixtureId);
    await flag(r, other.fixtureId);
    const admin = await seatedAdmin(r, mine.home.userId);
    const seen = await listFlaggedExternalPlay(admin, r.divisionId);
    expect([seen.boards.map((x) => x.fixtureId), seen.ownBoards]).toEqual([[other.fixtureId], 1]);
    const owner = await listFlaggedExternalPlay(r.owner, r.divisionId);
    expect([owner.boards.map((x) => x.fixtureId).sort(), owner.ownBoards]).toEqual([[mine.fixtureId, other.fixtureId].sort(), 0]);
  });

  it("another club's division ⇒ 404 and nothing read; another division's flags never leak in", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b);
    await flag(r, b.fixtureId);
    const other = await round();
    expect(await codeOf(listFlaggedExternalPlay(other.owner, r.divisionId))).toEqual([404, "NOT_FOUND"]);
    // The other club's own division is empty: r's flag is r's.
    expect((await listFlaggedExternalPlay(other.owner, other.divisionId)).boards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listRunSheetOnlinePlay
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("listRunSheetOnlinePlay — the run sheet's chips", () => {
  it("the empty case first: no bridge row and no flag ⇒ no entry at all", async () => {
    const r = await round(2);
    expect(await listRunSheetOnlinePlay(r.owner, r.divisionId)).toEqual({});
  });

  it("open flags counted BY KIND (camera vs moves off Seazn); a closed flag is not counted, and the entry stays while a bridge row does", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b);
    const ids = [
      await flag(r, b.fixtureId, "camera_lost", b.home.personId),
      await flag(r, b.fixtureId, "camera_connection_problems", b.away.personId),
      await flag(r, b.fixtureId, "out_of_band_play"),
    ];
    const before = (await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId];
    expect([before?.cameraFlagCount, before?.offSeaznFlagCount, before?.live, before?.held]).toEqual([2, 1, true, null]);
    await closeExternalPlayFlags(r.owner, b.fixtureId, ids.slice(0, 2));
    const after = (await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId];
    expect([after?.cameraFlagCount, after?.offSeaznFlagCount]).toEqual([0, 1]);
  });

  it("a flag on a board with no bridge row still gets an entry (the evidence outlives the bridge)", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await flag(r, b.fixtureId, "camera_lost", b.home.personId);
    const e = (await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId];
    expect([e?.cameraFlagCount, e?.live, e?.held]).toEqual([1, false, null]);
  });

  it("held while still to be played, through the real writer — and not once the fixture is decided by another path", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "provider_error" });
    expect((await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId]?.held).toBe("provider_error");
    await decide(r, b);
    const e = (await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId];
    expect([e?.held, e?.live], "decided by hand: no longer held, no game running").toEqual([null, false]);
  });

  it("live while the game is being played — and not once the fixture has its result, even with the bridge row still reading live", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b, "live");
    expect((await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId]?.live, "premise: live").toBe(true);
    await decide(r, b);
    const [bridge] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(bridge!.status, "premise: the bridge row still says live").toBe("live");
    expect((await listRunSheetOnlinePlay(r.owner, r.divisionId))[b.fixtureId]?.live, "decided: no game running ('Camera ok' would lie)").toBe(false);
  });

  it("camera policy: the stage's own value wins, else the division's — each board reads its own stage", async () => {
    const r = await round(2);
    const [one, two] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await gameBridge(r, one);
    await gameBridge(r, two);
    await sql`update divisions set camera_policy = 'optional' where id = ${r.divisionId}`;
    // A second stage of the same division, holding `two`, with its own policy.
    const [s2] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, config, camera_policy)
      select division_id, org_id, seq + 1, kind, 'Finals', config, 'required' from stages where id = ${r.stageId}
      returning id`;
    await sql`update fixtures set stage_id = ${s2!.id} where id = ${two.fixtureId}`;
    const sheet = await listRunSheetOnlinePlay(r.owner, r.divisionId);
    expect([sheet[one.fixtureId]?.cameraPolicy, sheet[two.fixtureId]?.cameraPolicy]).toEqual(["optional", "required"]);
  });

  it("another club's division ⇒ 404", async () => {
    const r = await round();
    await gameBridge(r, r.boards[0]!);
    const other = await round();
    expect(await codeOf(listRunSheetOnlinePlay(other.owner, r.divisionId))).toEqual([404, "NOT_FOUND"]);
  });
});
