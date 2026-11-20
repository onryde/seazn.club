// Match Day online, Task 3 - GET /api/v1/fixtures/{id}/match-day-board over HTTP: the REAL handler, the real door (`requireResourceAuth`,
// the key route allowlist), the v1 envelope and the published schema. What the usecase suite cannot see: that the answer survives the wire
// - the position, the flags built in full, each side's presence, camera and `joinable`, `stage_id`, `round_no` and `hold_reason` - parsed
// by the schema the OpenAPI document publishes (a plain z.object STRIPS a key it does not name, so a key the schema forgot would be served
// by the usecase and gone from the wire), and who the door lets through: a read-scope key, a signed-in viewer, the organiser who plays on
// the board (refused 403 by the usecase, over the wire), another club's caller (refused by the door), a key pinned to another competition.
//
// Chess-only by construction (online play is `boardgame`'s door, guard.ts): the registry sweep of the other sports is the usecase suite's.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { fenAfter } from "@/server/external-play/fen";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { MatchDayBoard } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { closeExternalPlayFlags } from "@/server/usecases/external-play/flags";
import { loadMatchDayBoard } from "@/server/usecases/external-play/arbiter";
import { seedOnlineChessRound, seedOwner } from "@/server/usecases/__tests__/_external-play-seed";
import { arrived, bridgeRow, openFlag, openStamp, presenceRow } from "@/server/usecases/__tests__/_match-day-online-seed";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { GET as boardRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
afterEach(() => vi.unstubAllEnvs());

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, secret?: string) =>
  new Request(`https://test.local/api/v1/fixtures/${id}/match-day-board`, {
    method: "GET",
    headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
  });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Envelope });

/** 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5: twelve plies, White to move. */
const RUY_12 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5"];
const FEN_AFTER_12 = "r1bqk2r/2ppbppp/p1n2n2/1p2p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 w kq - 0 7";

async function member(orgId: string, role: "admin" | "viewer", userId?: string): Promise<string> {
  const id = userId ?? (await makeUser(role)).id;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${id}, ${role})`;
  return id;
}

/** A round opened ten minutes ago on the REAL clock (the route reads it) with three boards:
 *  board 1 live, twelve plies, home's player here (counted check-in, present, camera live) and an open connection-problems flag;
 *  board 2 held (`no_show_white`); board 3 a plain live board the players of board 1 do not play. */
async function seedRound() {
  const r = await seedOnlineChessRound({ fixtures: 3, cameraPolicy: "required" });
  const opened = new Date(Date.now() - 10 * 60_000);
  await openStamp(r, r.roundNo, opened);
  const [one, two, three] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0], (typeof r.boards)[0]];
  await bridgeRow(one.fixtureId, r.orgId, { status: "live", moves: 2 }, opened);
  await sql`update fixture_external_play set moves_uci = ${sql.json(RUY_12)}, move_count = ${RUY_12.length},
                   started_at = '2026-10-12T19:18:00Z', game_over_at = '2026-10-12T19:39:00Z' where fixture_id = ${one.fixtureId}`;
  const participantId = await arrived(one, r.orgId, "home", new Date(opened.getTime() + 60_000), { state: "live", at: new Date() });
  await presenceRow(one, "home", participantId, { joinedAt: new Date(opened.getTime() + 120_000) });
  await sql`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at) values
    (${one.fixtureId}, 'home', ${one.home.personId}, '2026-10-12T19:20:00Z', '2026-10-12T19:20:40Z'),
    (${one.fixtureId}, 'home', ${one.home.personId}, '2026-10-12T19:25:00Z', '2026-10-12T19:25:50Z')`;
  const flagId = await openFlag(r.orgId, one.fixtureId, { kind: "camera_connection_problems", personId: one.home.personId, openedAt: new Date("2026-10-12T19:42:00Z") });
  await bridgeRow(two.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_white", moves: 2 }, opened);
  await bridgeRow(three.fixtureId, r.orgId, { status: "live", moves: 2 }, opened);
  return { r, opened, one, two, three, flagId };
}

describe.skipIf(!HAS_DB)("/api/v1/fixtures/{id}/match-day-board", () => {
  let s: Awaited<ReturnType<typeof seedRound>>;
  let secret: string;

  beforeAll(async () => {
    s = await seedRound();
    secret = (await createApiKey(s.r.owner, { name: "match day board read", scopes: ["read"] })).secret;
  });

  it("an API key with the read scope reads the board: 200, and the position, the flag card, each side's presence/camera/joinable and the focus keys survive the wire", async () => {
    const res = await read(await boardRoute(get(s.one.fixtureId, secret), ctx(s.one.fixtureId)));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const raw = res.body.data!;
    const board = MatchDayBoard.parse(raw);

    // The position: the game's twelve plies, from the seed's own list.
    expect(board.position).toEqual({ fen: FEN_AFTER_12, lastMove: ["b7", "b5"], turn: "white" });
    expect(board.position!.fen, "the same position the public read's replay reaches").toBe(fenAfter(RUY_12).fen);
    expect([board.stage_id, board.round_no, board.hold_reason]).toEqual([s.r.stageId, s.r.roundNo, null]);

    // The board as the round view paints it, with every key the usecase gave: nothing was stripped (the schema is open on purpose), by the
    // PARSE as well as on the wire - a plain z.object would drop `sides`, `flags` and the rest and parse to a shell.
    expect(board, "the published schema keeps every key it was given").toEqual(raw);
    expect(raw, "the wire carries every key of the usecase's board").toEqual(JSON.parse(JSON.stringify(await loadMatchDayBoard(s.r.owner, s.one.fixtureId))) as unknown);
    expect(Object.keys(raw).sort()).toEqual(expect.arrayContaining(["position", "stage_id", "round_no", "hold_reason", "sides", "flags", "flagCount", "state", "clock", "seats", "checkin"]));
    expect(raw.flags, "the flag card is built in full, with the guard's own seconds and stamps").toEqual([
      { id: s.flagId, kind: "camera_connection_problems", at: "2026-10-12T19:42:00.000Z", personName: "P1W", seconds: 90, stamps: 2 },
    ]);
    expect(raw.flagCount).toBe(1);
    const sides = raw.sides as Record<"home" | "away", Record<string, unknown>>;
    expect(sides.home).toMatchObject({ state: "open", presence: { present: true, leftAt: null }, camera: { state: "live" }, joinable: true });
    expect(sides.away).toMatchObject({ state: "none", presence: { present: false }, camera: { state: "unknown" }, joinable: false });
  });

  it("a held board's reason rides the wire; a live board's is null - the vocabulary the schema carries is the server's own", async () => {
    const held = await read(await boardRoute(get(s.two.fixtureId, secret), ctx(s.two.fixtureId)));
    expect(held.status).toBe(200);
    const board = MatchDayBoard.parse(held.body.data);
    expect([(board.state as { kind: string }).kind, board.hold_reason]).toEqual(["on_hold", "no_show_white"]);
    expect(NEEDS_REASONS as readonly string[]).toContain(board.hold_reason);
    const live = MatchDayBoard.parse((await read(await boardRoute(get(s.three.fixtureId, secret), ctx(s.three.fixtureId)))).body.data);
    expect(live.hold_reason).toBeNull();
  });

  it("a board with no game on file answers a null position (the empty case, over the wire)", async () => {
    const fresh = await seedOnlineChessRound({ fixtures: 1 });
    await openStamp(fresh, fresh.roundNo, new Date(Date.now() - 60_000));
    const key = (await createApiKey(fresh.owner, { name: "no game", scopes: ["read"] })).secret;
    const res = await read(await boardRoute(get(fresh.boards[0]!.fixtureId, key), ctx(fresh.boards[0]!.fixtureId)));
    expect(res.status).toBe(200);
    expect(MatchDayBoard.parse(res.body.data).position).toBeNull();
    expect(res.body.data).toHaveProperty("position", null);
  });

  it("a signed-in VIEWER reads it (200) - the read-only page's own read; the same request from an admin of the club passes too", async () => {
    const viewer = await member(s.r.orgId, "viewer");
    const admin = await member(s.r.orgId, "admin");
    let checked = 0;
    for (const [who, userId] of [["viewer", viewer], ["admin", admin]] as const) {
      authState.userId = userId;
      const res = await read(await boardRoute(get(s.one.fixtureId), ctx(s.one.fixtureId)));
      expect(res.status, who).toBe(200);
      expect(MatchDayBoard.parse(res.body.data).position, who).toMatchObject({ fen: FEN_AFTER_12 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the organiser who PLAYS on the board is refused 403 ARBITER_PLAYS_THIS_BOARD over the wire, and reads the round's other board", async () => {
    const player = await member(s.r.orgId, "admin", s.one.home.userId);
    authState.userId = player;
    const refused = await read(await boardRoute(get(s.one.fixtureId), ctx(s.one.fixtureId)));
    expect([refused.status, refused.body.ok, refused.body.error?.code]).toEqual([403, false, "ARBITER_PLAYS_THIS_BOARD"]);
    expect(refused.body.data, "nothing of the board travels with the refusal").toBeUndefined();
    const other = await read(await boardRoute(get(s.three.fixtureId), ctx(s.three.fixtureId)));
    expect(other.status).toBe(200);
  });

  it("another club's caller never reads it: a signed-in stranger and a key of another club are refused by the door, with no board in the body", async () => {
    const stranger = await seedOwner();
    const strangerKey = (await createApiKey(stranger, { name: "stranger", scopes: ["read"] })).secret;
    authState.userId = stranger.userId!;
    let checked = 0;
    for (const [why, request] of [
      ["a signed-in member of another club", get(s.one.fixtureId)],
      ["a read key of another club", get(s.one.fixtureId, strangerKey)],
    ] as const) {
      const res = await read(await boardRoute(request, ctx(s.one.fixtureId)));
      expect(res.status, why).toBeGreaterThanOrEqual(401);
      expect(res.status, why).toBeLessThan(500);
      expect(res.body.ok, why).toBe(false);
      expect(JSON.stringify(res.body), `${why}: no board data in the refusal`).not.toContain(FEN_AFTER_12);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a key pinned to ANOTHER competition of the club is refused 403, and the key pinned to this board's competition reads it (the allowlist carries the fixture pin)", async () => {
    const other = await createCompetition(s.r.owner, { name: "Another competition", visibility: "public", branding: {}, starts_on: "2026-10-01", ends_on: "2026-10-02" });
    const wrong = (await createApiKey(s.r.owner, { name: "pinned elsewhere", scopes: ["read"], competition_id: other.id })).secret;
    const right = (await createApiKey(s.r.owner, { name: "pinned here", scopes: ["read"], competition_id: s.r.competitionId })).secret;
    expect((await read(await boardRoute(get(s.one.fixtureId, wrong), ctx(s.one.fixtureId)))).status).toBe(403);
    expect((await read(await boardRoute(get(s.one.fixtureId, right), ctx(s.one.fixtureId)))).status).toBe(200);
  });

  it("an id that is no board is 404 on the wire: an unknown uuid, a malformed id", async () => {
    let checked = 0;
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await read(await boardRoute(get(id, secret), ctx(id)));
      expect([res.status, res.body.ok], id).toEqual([404, false]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the sequence over the wire (owner O1): a cancelled board with an open flag reads with its card; once the flag is closed the same request is 404", async () => {
    const c = await seedRound();
    const key = (await createApiKey(c.r.owner, { name: "cancelled", scopes: ["read"] })).secret;
    await sql`update fixtures set status = 'cancelled' where id = ${c.one.fixtureId}`;
    const open = await read(await boardRoute(get(c.one.fixtureId, key), ctx(c.one.fixtureId)));
    expect(open.status).toBe(200);
    expect((open.body.data!.state as { kind: string }).kind).toBe("cancelled");
    expect((open.body.data!.flags as { id: string }[]).map((f) => f.id)).toEqual([c.flagId]);
    expect(await closeExternalPlayFlags(c.r.owner, c.one.fixtureId, [c.flagId])).toEqual({ closed: 1, stillOpen: 0 });
    const gone = await read(await boardRoute(get(c.one.fixtureId, key), ctx(c.one.fixtureId)));
    expect([gone.status, gone.body.error?.code]).toEqual([404, "NOT_FOUND"]);
  });
});
