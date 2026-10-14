// T15 — the arbiter panel's organiser routes over HTTP:
//   POST /fixtures/{id}/external-play/arbiter         the receive-only join
//   DELETE …/arbiter/{participantId}                  the panel closed (fix round 1, I2)
//   POST /fixtures/{id}/external-play/resync          reconcile, trigger `organiser`
//   POST /fixtures/{id}/external-play/video-override  D11, Task 8's usecase
// Who may call each, and that a refused caller writes nothing. The usecases'
// own behaviour is external-play-arbiter.test.ts's (and reconcile's/preflight's).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
// A door that hands the routes a user-less context — what an API key would be
// if it ever got past NEVER_KEY_ROUTES. Only one test sets it.
const door = vi.hoisted(() => ({ userless: false }));
vi.mock("@/server/api-v1/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/api-v1/auth")>();
  return {
    ...actual,
    requireResourceAuth: async (...args: Parameters<typeof actual.requireResourceAuth>) => {
      const auth = await actual.requireResourceAuth(...args);
      return door.userless ? { ...auth, via: "api_key" as const, userId: null, keyId: "k-test" } : auth;
    },
  };
});
// RealtimeKit at its module boundary: the meeting is the seeded row, a new
// participant is minted locally. Nothing reaches Cloudflare.
const rtk = vi.hoisted(() => ({ minted: [] as string[], removed: [] as string[] }));
vi.mock("@/server/external-play/video/realtimekit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/video/realtimekit")>();
  const { sql: db } = await import("@/lib/db");
  return {
    ...actual,
    ensureMeeting: vi.fn(async (fixtureId: string) => {
      const [row] = await db<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${fixtureId}`;
      if (!row) throw new actual.RealtimeKitError(503, "unavailable", "test: no meeting seeded");
      return { meetingId: row.meeting_id };
    }),
    addParticipant: vi.fn(async (a: { preset: string }) => {
      const id = `arb-${randomUUID().slice(0, 8)}`;
      rtk.minted.push(`${a.preset}:${id}`);
      return { participantId: id, authToken: `tok-${id}` };
    }),
    removeParticipant: vi.fn(async (a: { participantId: string }) => {
      rtk.removed.push(a.participantId);
    }),
  };
});
// The resync throttle's counter (M3): deterministic, per key, reset per test.
const limiter = vi.hoisted(() => ({ counts: new Map<string, number>() }));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { createApiKey } from "@/server/usecases/api-keys";
import { POST as arbiterRoute } from "@/app/api/v1/fixtures/[id]/external-play/arbiter/route";
import { DELETE as leaveRoute } from "@/app/api/v1/fixtures/[id]/external-play/arbiter/[participantId]/route";
import { ARBITER_RESYNC_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { POST as resyncRoute } from "@/app/api/v1/fixtures/[id]/external-play/resync/route";
import { POST as overrideRoute } from "@/app/api/v1/fixtures/[id]/external-play/video-override/route";
import { seedOnlineChessRound, seedOwner, type SeedOnlineChessRoundResult } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

/** One opened round, its boards live on Lichess under `policy`, both
 *  players' cameras in each board's meeting (T8's writer). `b` is board 1. */
async function liveBoard(policy: "required" | "optional" = "required", fixtures = 1) {
  const r = await seedOnlineChessRound({ fixtures, cameraPolicy: policy });
  await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
            values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
  for (const b of r.boards) {
    // T9/T10's writer: a game on file, two plies played.
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side,
        white_lichess_id, black_lichess_id, moves_uci, move_count, started_at, last_move_at, white_ms, black_ms, clock_increment_s)
      values (${b.fixtureId}, ${r.orgId}, 'live', now(), ${`g${randomUUID().slice(0, 7)}`}, 'home',
        ${b.home.lichessId}, ${b.away.lichessId}, ${sql.json(["e2e4", "e7e5"])}, 2, now(), now(), 600000, 600000, 10)`;
    await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id)
              values (${b.fixtureId}, ${r.orgId}, ${`m-${randomUUID().slice(0, 8)}`}, (select home_entrant_id from fixtures where id = ${b.fixtureId}), (select away_entrant_id from fixtures where id = ${b.fixtureId}))`;
    await sql`insert into fixture_video_participants (fixture_id, person_id, preset, participant_id) values
      (${b.fixtureId}, ${b.home.personId}, 'player', ${`pw-${b.fixtureId.slice(0, 6)}`}),
      (${b.fixtureId}, ${b.away.personId}, 'player', ${`pb-${b.fixtureId.slice(0, 6)}`})`;
  }
  return { r, b: r.boards[0]! };
}

const arbiters = (fixtureId: string) =>
  sql`select 1 from fixture_video_participants where fixture_id = ${fixtureId} and preset = 'arbiter'`;
const overrides = (fixtureId: string) =>
  sql<{ note: string; actor_user_id: string }[]>`
    select note, actor_user_id from online_chess_audit where fixture_id = ${fixtureId} and kind = 'video_override'`;

type Call = { name: string; send: (r: SeedOnlineChessRoundResult, fixtureId: string, headers?: Record<string, string>) => Promise<Response> };
const CALLS: Call[] = [
  { name: "arbiter", send: (_r, f, h) => arbiterRoute(post(`/fixtures/${f}/external-play/arbiter`, {}, h), ctx(f)) },
  { name: "resync", send: (_r, f, h) => resyncRoute(post(`/fixtures/${f}/external-play/resync`, {}, h), ctx(f)) },
  {
    name: "video-override",
    send: (_r, f, h) => overrideRoute(post(`/fixtures/${f}/external-play/video-override`, { note: "video down" }, h), ctx(f)),
  },
];

beforeEach(() => {
  authState.userId = "";
  door.userless = false;
  rtk.minted.length = 0;
  rtk.removed.length = 0;
  limiter.counts = new Map();
  __setRateLimitCounterForTests(async (key, windowSeconds) => {
    const n = (limiter.counts.get(key) ?? 0) + 1;
    limiter.counts.set(key, n);
    return { count: n, ttlMs: windowSeconds * 1000 };
  });
});
afterAll(async () => {
  __setRateLimitCounterForTests(null);
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("the arbiter's routes — who may call them", () => {
  it("another club's organiser and a viewer are refused by every route; none writes", async () => {
    const { r, b } = await liveBoard();
    const stranger = await seedOwner();
    const viewer = await member(r.orgId, "viewer");
    const callers: [string, string, number][] = [
      ["other club's organiser", stranger.userId!, 401],
      ["viewer", viewer, 403],
    ];
    let checked = 0;
    for (const call of CALLS) {
      for (const [who, userId, status] of callers) {
        authState.userId = userId;
        const res = await call.send(r, b.fixtureId);
        expect(res.status, `${call.name}, ${who}`).toBe(status);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: three routes × two callers").toBe(6);
    expect(await arbiters(b.fixtureId)).toHaveLength(0);
    expect(await overrides(b.fixtureId)).toHaveLength(0);
    expect(rtk.minted).toEqual([]);
    // The positive pair: an ADMIN of the same club may watch.
    authState.userId = await member(r.orgId, "admin");
    expect((await CALLS[0]!.send(r, b.fixtureId)).status).toBe(200);
  });

  it("C1: an org ADMIN who plays on the board is refused the watch for THAT reason — and may watch another board", async () => {
    const { r, b } = await liveBoard("required", 2);
    // A full organiser of the club, so membership cannot be what refuses them.
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${b.home.userId}, 'admin')`;
    authState.userId = b.home.userId;
    const res = await read(await CALLS[0]!.send(r, b.fixtureId));
    expect([res.status, res.body.error?.code]).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
    expect(await arbiters(b.fixtureId)).toHaveLength(0);
    expect(rtk.minted).toEqual([]);
    // The positive pair: the same admin, a board of the same club they do not play on.
    const other = r.boards[1]!;
    expect((await read(await CALLS[0]!.send(r, other.fixtureId))).status).toBe(200);
    expect(rtk.minted.map((m) => m.split(":")[0])).toEqual(["arbiter"]);
  });

  it("an API key with manage scope is refused at the door by every route (NEVER_KEY_ROUTES)", async () => {
    const { r, b } = await liveBoard();
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'arbiter routes') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `arb-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    let checked = 0;
    for (const call of CALLS) {
      const res = await read(await call.send(r, b.fixtureId, { authorization: `Bearer ${secret}` }));
      expect(res.status, call.name).toBe(403);
      expect(res.body.error?.message, call.name).toMatch(/cannot access this endpoint/);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await arbiters(b.fixtureId)).toHaveLength(0);
    expect(await overrides(b.fixtureId)).toHaveLength(0);
  });

  it("defence in depth: a user-less context past the door is refused by the usecase, nothing written", async () => {
    const { r, b } = await liveBoard();
    authState.userId = r.ownerUserId;
    door.userless = true;
    const codes: string[] = [];
    for (const call of CALLS) {
      const res = await read(await call.send(r, b.fixtureId));
      expect(res.status, call.name).toBe(403);
      codes.push(res.body.error?.code ?? "");
    }
    expect(codes).toEqual(["ARBITER_NEEDS_SESSION", "ORGANISER_SESSION_REQUIRED", "ORGANISER_SESSION_REQUIRED"]);
    expect(await arbiters(b.fixtureId)).toHaveLength(0);
    expect(await overrides(b.fixtureId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("POST …/external-play/arbiter", () => {
  it("the organiser gets their own token and the players' participant ids by colour — never a player's token", async () => {
    const { r, b } = await liveBoard();
    authState.userId = r.ownerUserId;
    const res = await read(await CALLS[0]!.send(r, b.fixtureId));
    expect(res.status).toBe(200);
    const data = res.body.data as { authToken: string; participantId: string; white: string[]; black: string[] };
    expect(data.white).toEqual([`pw-${b.fixtureId.slice(0, 6)}`]);
    expect(data.black).toEqual([`pb-${b.fixtureId.slice(0, 6)}`]);
    expect(rtk.minted.map((m) => m.split(":")[0])).toEqual(["arbiter"]);
    expect(data.participantId).toBe(rtk.minted[0]!.split(":")[1]);
    expect(data.authToken).toBe(`tok-${data.participantId}`);
    expect(Object.keys(data).sort()).toEqual(["authToken", "black", "participantId", "white"]);
  });
});

describe.skipIf(!HAS_DB)("DELETE …/external-play/arbiter/{participantId} (I2)", () => {
  const del = (fixtureId: string, participantId: string, headers: Record<string, string> = {}) =>
    leaveRoute(
      new Request(`https://test.local/api/v1/fixtures/${fixtureId}/external-play/arbiter/${participantId}`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: fixtureId, participantId }) },
    );
  const removedAt = async (participantId: string) => {
    const [row] = await sql<{ removed_at: Date | null }[]>`
      select removed_at from fixture_video_participants where participant_id = ${participantId}`;
    return row?.removed_at ?? null;
  };
  async function joined(r: SeedOnlineChessRoundResult, fixtureId: string, userId: string): Promise<string> {
    authState.userId = userId;
    const res = await read(await CALLS[0]!.send(r, fixtureId));
    expect(res.status, "premise: the join succeeded").toBe(200);
    return (res.body.data as { participantId: string }).participantId;
  }

  it("the organiser who joined removes their own watch; a repeat answers removed:false; the vendor is called once", async () => {
    const { r, b } = await liveBoard();
    const pid = await joined(r, b.fixtureId, r.ownerUserId);
    const first = await read(await del(b.fixtureId, pid));
    expect([first.status, first.body.data]).toEqual([200, { removed: true }]);
    expect(rtk.removed).toEqual([pid]);
    expect(await removedAt(pid)).not.toBeNull();
    const again = await read(await del(b.fixtureId, pid));
    expect([again.status, again.body.data]).toEqual([200, { removed: false }]);
    expect(rtk.removed).toEqual([pid]);
  });

  it("an organiser demoted to viewer mid-watch may still end their OWN watch (read scope); nobody ends another's", async () => {
    const { r, b } = await liveBoard();
    const admin = await member(r.orgId, "admin");
    const mine = await joined(r, b.fixtureId, admin);
    const theirs = await joined(r, b.fixtureId, r.ownerUserId);
    await sql`update org_members set role = 'viewer' where org_id = ${r.orgId} and user_id = ${admin}`;
    authState.userId = admin;
    const cases: [string, () => Promise<Response>, number][] = [
      ["another organiser's watch", () => del(b.fixtureId, theirs), 404],
      ["my watch, on another board id", () => del(randomUUID(), mine), 404],
      ["a stranger", async () => {
        authState.userId = (await seedOwner()).userId!;
        return del(b.fixtureId, mine);
      }, 401],
    ];
    let checked = 0;
    for (const [why, call, status] of cases) {
      expect((await call()).status, why).toBe(status);
      checked++;
    }
    expect(checked).toBe(3);
    expect(rtk.removed).toEqual([]);
    // The positive pair: the demoted viewer, their own watch.
    authState.userId = admin;
    const own = await read(await del(b.fixtureId, mine));
    expect([own.status, own.body.data]).toEqual([200, { removed: true }]);
    expect(rtk.removed).toEqual([mine]);
    expect(await removedAt(theirs)).toBeNull();
  });

  it("an API key is refused at the door (NEVER_KEY_ROUTES); nothing removed", async () => {
    const { r, b } = await liveBoard();
    const pid = await joined(r, b.fixtureId, r.ownerUserId);
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'arbiter routes') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `arb-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const res = await read(await del(b.fixtureId, pid, { authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(rtk.removed).toEqual([]);
    expect(await removedAt(pid)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("POST …/external-play/resync", () => {
  it("a board with no game at Lichess: nothing to read, nothing written", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    authState.userId = r.ownerUserId;
    const res = await read(await CALLS[1]!.send(r, r.boards[0]!.fixtureId));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ read: false, adopted: 0, finished: false });
  });

  it("M3: an over-the-board fixture is a 404, never a 'nothing read' — the positive pair is the same club's online board", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    authState.userId = r.ownerUserId;
    await sql`update divisions set config = config - 'onlinePlay' where id = (select division_id from fixtures where id = ${r.boards[0]!.fixtureId})`;
    const otb = await read(await CALLS[1]!.send(r, r.boards[0]!.fixtureId));
    expect([otb.status, otb.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    expect(limiter.counts.size, "refused before the throttle counts").toBe(0);
    const online = await seedOnlineChessRound({ fixtures: 1 });
    authState.userId = online.ownerUserId;
    expect((await CALLS[1]!.send(online, online.boards[0]!.fixtureId)).status).toBe(200);
  });

  it(`M3: past ${ARBITER_RESYNC_LIMIT.max} resyncs of ONE board in a window the next is 429 — another board is not throttled`, async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    authState.userId = r.ownerUserId;
    const [one, two] = r.boards;
    const statuses: number[] = [];
    for (let i = 0; i <= ARBITER_RESYNC_LIMIT.max; i++) statuses.push((await CALLS[1]!.send(r, one!.fixtureId)).status);
    expect(statuses).toEqual([...Array(ARBITER_RESYNC_LIMIT.max).fill(200), 429]);
    expect((await CALLS[1]!.send(r, two!.fixtureId)).status, "per fixture").toBe(200);
  });
});

describe.skipIf(!HAS_DB)("POST …/external-play/video-override", () => {
  it("records ONE override under the organiser's name; a second press keeps the first record", async () => {
    const { r, b } = await liveBoard();
    authState.userId = r.ownerUserId;
    expect((await read(await CALLS[2]!.send(r, b.fixtureId))).body.data).toEqual({ overridden: true });
    const again = await overrideRoute(
      post(`/fixtures/${b.fixtureId}/external-play/video-override`, { note: "a later reason" }),
      ctx(b.fixtureId),
    );
    expect(again.status).toBe(200);
    expect(await overrides(b.fixtureId)).toEqual([{ note: "video down", actor_user_id: r.ownerUserId }]);
  });

  it("Task 8's refusals pass through: VIDEO_NOT_REQUIRED off Required; an empty reason is refused; nothing written", async () => {
    const { r, b } = await liveBoard("optional");
    authState.userId = r.ownerUserId;
    const res = await read(await CALLS[2]!.send(r, b.fixtureId));
    expect([res.status, res.body.error?.code]).toEqual([409, "VIDEO_NOT_REQUIRED"]);
    const blank = await overrideRoute(
      post(`/fixtures/${b.fixtureId}/external-play/video-override`, { note: "   " }),
      ctx(b.fixtureId),
    );
    expect(blank.status).toBeGreaterThanOrEqual(400);
    expect(blank.status).toBeLessThan(500);
    expect(await overrides(b.fixtureId)).toHaveLength(0);
  });
});
