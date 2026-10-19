// T16 — the watch island's poll: GET /public/fixtures/{id}/board, the real
// route on the real usecase and database. Pushes carry each move to entitled
// spectators (lib/realtime); this is how every other spectator, and a pushed
// one whose push was lost, catches up. It answers what the public page
// already shows — the bridge's public snapshot and whether the round is open
// — and nothing for a fixture the public cannot see.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const OPENED = new Date(Date.now() - 2 * 60_000);
const call = (id: string) => GET(new Request(`http://x/api/v1/public/fixtures/${id}/board`), { params: Promise.resolve({ id }) });
/** The v1 envelope's data — what the island's `api()` client unwraps. */
const data = async (res: Response) => ((await res.json()) as { data: unknown }).data;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("GET /public/fixtures/{id}/board", () => {
  it("the empty case first: an online board whose round is not opened — no game, round not opened", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: OPENED });
    const res = await call(s.fixtureId);
    expect(res.status).toBe(200);
    // `roundOpenedAt` (T16 fix round 1): the round's open time for the Match details line — null until it opens.
    expect(await data(res)).toEqual({ roundOpened: false, roundOpenedAt: null, externalPlay: null });
  });

  it("round opened, then a game on the board: the view-only board as the ledger stands, no Lichess id anywhere", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: OPENED, roundOpenedAt: OPENED });
    // The open time is the one the round was opened at (the seed's `roundOpenedAt`).
    expect(await data(await call(s.fixtureId))).toEqual({ roundOpened: true, roundOpenedAt: OPENED.toISOString(), externalPlay: null });
    const gameId = `gm${randomUUID().slice(0, 6)}`;
    // Labelled SQL: the room's create and T10's move append write this row; here it stands for a game at 1.e4.
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
         moves_uci, move_count, white_ms, black_ms, last_move_at)
      values (${s.fixtureId}, ${s.orgId}, 'live', ${OPENED}, ${gameId}, 'away', ${s.home.lichessId}, ${s.away.lichessId},
              ${sql.json(["e2e4"])}, 1, 600000, 600000, ${OPENED})`;
    const res = await call(s.fixtureId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=2, stale-while-revalidate=5");
    const body = (await data(res)) as {
      roundOpened: boolean;
      roundOpenedAt: string | null;
      externalPlay: { status: string; watch: Record<string, unknown>; decided: boolean; hold: unknown; result: unknown };
    };
    expect(body.roundOpened).toBe(true);
    expect(body.roundOpenedAt).toBe(OPENED.toISOString());
    expect(body.externalPlay.status).toBe("live");
    // Nothing recorded on the fixture yet: not decided, no hold, no result (I1's three fields).
    expect([body.externalPlay.decided, body.externalPlay.hold, body.externalPlay.result]).toEqual([false, null, null]);
    // After 1.e4, from the rules (FEN), not from our replay.
    expect(body.externalPlay.watch).toMatchObject({
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      lastMove: "e2e4",
      turn: "black",
      ply: 1,
      whiteSide: "away",
      over: false,
    });
    const raw = JSON.stringify(body);
    for (const secret of [gameId, s.home.lichessId, s.away.lichessId, "lichess.org"]) expect(raw, secret).not.toContain(secret);
  });

  it("a game decided on the pad: the fixture decides — decided, no hold, the result; the open time unchanged", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: OPENED, roundOpenedAt: OPENED });
    // Labelled SQL, as above: a game at 1.e4 with the away side on White.
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
         moves_uci, move_count, white_ms, black_ms, last_move_at)
      values (${s.fixtureId}, ${s.orgId}, 'live', ${OPENED}, ${`gm${randomUUID().slice(0, 6)}`}, 'away', ${s.away.lichessId},
              ${s.home.lichessId}, ${sql.json(["e2e4"])}, 1, 600000, 600000, ${OPENED})`;
    // The organiser enters the result on the pad (its own write): the away side — White — wins.
    const organiser = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    await scoreEvent(organiser, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(organiser, s.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: s.away.entrantId } });
    const body = (await data(await call(s.fixtureId))) as {
      roundOpened: boolean;
      roundOpenedAt: string | null;
      externalPlay: { decided: boolean; hold: unknown; result: Record<string, unknown> | null };
    };
    expect([body.roundOpened, body.roundOpenedAt]).toEqual([true, OPENED.toISOString()]);
    expect([body.externalPlay.decided, body.externalPlay.hold], "the fixture's decision, before the sweep closes the bridge").toEqual([true, null]);
    // White won: 1–0, White's score first (the chess result notation).
    expect(body.externalPlay.result).toMatchObject({ kind: "win", winner: "away", score: "1–0" });
  });

  it("a fixture the public cannot see is not found: a private competition, an unknown id, not an id", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: OPENED, roundOpenedAt: OPENED });
    // Labelled SQL: the organiser makes the competition private.
    await sql`update competitions set visibility = 'private' where id = ${s.competitionId}`;
    const cells: [string, string][] = [
      ["private competition", s.fixtureId],
      ["unknown id", randomUUID()],
      ["not an id", "not-a-uuid"],
    ];
    let checked = 0;
    for (const [label, id] of cells) {
      expect((await call(id)).status, label).toBe(404);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
    // The positive pair: the same fixture, public again, answers.
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    expect((await call(s.fixtureId)).status).toBe(200);
  });
});
