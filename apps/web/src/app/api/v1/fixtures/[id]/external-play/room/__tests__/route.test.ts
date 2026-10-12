// T14 — the match-room routes over HTTP: who the caller is (a `?t=`
// personal link wins; else the session cookie; an API key is never an
// identity), the envelope, and that the act route's schema is only a first
// gate — T3's assertUci is the validation (M5). The usecase's own behaviour
// is external-play-room.test.ts's; this file proves the wiring.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AuthError } from "@/lib/errors";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // The session cookie, as the real requireUser reads it: none ⇒ AuthError.
    requireUser: async () => {
      if (!authState.userId) throw new AuthError("Not authenticated");
      return { id: authState.userId };
    },
    getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null),
  };
});

import { sql } from "@/lib/db";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { GET as roomGet, POST as roomPost } from "@/app/api/v1/fixtures/[id]/external-play/room/route";
import { POST as actPost } from "@/app/api/v1/fixtures/[id]/external-play/room/act/route";
import { POST as clockZeroPost } from "@/app/api/v1/fixtures/[id]/external-play/room/clock-zero/route";
import { POST as cameraFaultPost } from "@/app/api/v1/fixtures/[id]/external-play/room/camera-fault/route";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (fixtureId: string, tail = "", t?: string) =>
  `https://test.local/api/v1/fixtures/${fixtureId}/external-play/room${tail}${t ? `?t=${encodeURIComponent(t)}` : ""}`;
type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message: string } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
const post = (u: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(u, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Real clock: the check-in is stamped by the DB's now().
const OPENED = new Date(Date.now() - 2 * 60_000);
async function seed() {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: OPENED,
    roundOpenedAt: OPENED,
    linked: true,
    homeFullName: "Ada Okonkwo",
    awayFullName: "Bo Lind",
  });
  const [open] = await sql<{ id: string; opened_at: Date }[]>`
    select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
  const tokenFor = (personId: string) =>
    mintMatchRoomToken({ fixtureId: s.fixtureId, personId, roundOpenId: open!.id, roundOpenedAt: open!.opened_at.toISOString() });
  return { ...s, tokenFor };
}

beforeEach(() => {
  authState.userId = "";
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("match-room routes — structure", () => {
  it("no route module reaches Lichess or accepts a camera claim (design §3.4, spec §10 do-not-copy)", () => {
    const files = ["../route.ts", "../act/route.ts", "../clock-zero/route.ts", "../camera-fault/route.ts"];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toContain("lichess/board-api");
      expect(src, f).not.toContain("cameraOk");
      checked += 1;
    }
    expect(checked, "anti-vacuity: route modules read").toBe(4);
  });
});

describe.skipIf(!HAS_DB)("GET/POST /fixtures/{id}/external-play/room", () => {
  it("no session and no link ⇒ 401, before the fixture is even looked at", async () => {
    const s = await seed();
    const r = await read(await roomGet(new Request(url(s.fixtureId)), ctx(s.fixtureId)));
    expect(r.status).toBe(401);
  });

  it("a `?t=` link reads that player's seat, and WINS over a session of someone else", async () => {
    const s = await seed();
    authState.userId = s.home.userId; // signed in as home …
    const t = await s.tokenFor(s.away.personId); // … following away's link
    const r = await read(await roomGet(new Request(url(s.fixtureId, "", t)), ctx(s.fixtureId)));
    expect(r.status).toBe(200);
    expect((r.body.data!.you as { name: string }).name).toBe("Bo Lind");
  });

  it("the session alone reads its own seat; a session on neither side is the same 404 as a bad link", async () => {
    const s = await seed();
    authState.userId = s.home.userId;
    const mine = await read(await roomGet(new Request(url(s.fixtureId)), ctx(s.fixtureId)));
    expect((mine.body.data!.you as { name: string }).name).toBe("Ada Okonkwo");
    authState.userId = randomUUID();
    const stranger = await read(await roomGet(new Request(url(s.fixtureId)), ctx(s.fixtureId)));
    const badLink = await read(await roomGet(new Request(url(s.fixtureId, "", "not-a-token")), ctx(s.fixtureId)));
    expect([stranger.status, stranger.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    expect([badLink.status, badLink.body.error?.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("an API key alone is not an identity: a Bearer header with no session and no link ⇒ 401", async () => {
    const s = await seed();
    const req = new Request(url(s.fixtureId), { headers: { authorization: "Bearer sk_live_whatever" } });
    expect((await roomGet(req, ctx(s.fixtureId))).status).toBe(401);
  });

  it("POST takes the seat (camera policy off), stamps the check-in, and answers { snapshot, seat, create } (review m3: T9's answer is not dropped)", async () => {
    const s = await seed();
    const t = await s.tokenFor(s.home.personId);
    const r = await read(await roomPost(post(url(s.fixtureId, "", t)), ctx(s.fixtureId)));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data!).sort()).toEqual(["create", "seat", "snapshot"]);
    expect(r.body.data!.create, "one seat asks T9 for nothing").toBeNull();
    expect(r.body.data!.seat).toEqual({ seated: true, participant: null });
    expect((r.body.data!.snapshot as { you: { checkedIn: boolean } }).you.checkedIn).toBe(true);
    const [row] = await sql<{ checked_in_at: Date | null }[]>`
      select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
    expect(row?.checked_in_at).toBeInstanceOf(Date);
  });
});

describe.skipIf(!HAS_DB)("POST /fixtures/{id}/external-play/room/act and /clock-zero", () => {
  async function liveGame() {
    const s = await seed();
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id, moves_uci, move_count)
      values (${s.fixtureId}, ${s.orgId}, 'ready', ${OPENED}, ${`gm-${randomUUID().slice(0, 12)}`}, 'home',
              ${s.home.lichessId}, ${s.away.lichessId}, '[]'::jsonb, 0)`;
    return s;
  }

  it("the schema refuses a takeback or an over-long uci with 400 before the usecase", async () => {
    const s = await liveGame();
    const t = await s.tokenFor(s.home.personId);
    let checked = 0;
    for (const body of [{ kind: "takeback" }, { kind: "move", uci: "e2e4qq" }, {}]) {
      const r = await read(await actPost(post(url(s.fixtureId, "/act", t), body), ctx(s.fixtureId)));
      expect(r.status, JSON.stringify(body)).toBe(400);
      checked += 1;
    }
    expect(checked, "anti-vacuity: refused bodies").toBe(3);
  });

  it("a length-valid but malformed uci passes the schema and is refused by assertUci (M5): 400 INVALID_UCI", async () => {
    const s = await liveGame();
    const t = await s.tokenFor(s.home.personId);
    const r = await read(await actPost(post(url(s.fixtureId, "/act", t), { kind: "move", uci: "e2e9x" }), ctx(s.fixtureId)));
    expect([r.status, r.body.error?.code]).toEqual([400, "INVALID_UCI"]);
  });

  it("act and clock-zero resolve the caller the same way: a stranger's session is 404, never a 400 or a 200", async () => {
    const s = await liveGame();
    authState.userId = randomUUID();
    const act = await read(await actPost(post(url(s.fixtureId, "/act"), { kind: "resign" }), ctx(s.fixtureId)));
    const cz = await read(await clockZeroPost(post(url(s.fixtureId, "/clock-zero")), ctx(s.fixtureId)));
    expect([act.status, cz.status]).toEqual([404, 404]);
  });

  it("clock-zero before both have moved asks nothing and answers reconciled: false", async () => {
    const s = await liveGame();
    authState.userId = s.away.userId;
    const r = await read(await clockZeroPost(post(url(s.fixtureId, "/clock-zero")), ctx(s.fixtureId)));
    expect([r.status, r.body.data]).toEqual([200, { reconciled: false }]);
  });
});

describe.skipIf(!HAS_DB)("POST /fixtures/{id}/external-play/room/camera-fault (I-1)", () => {
  /** A camera-required board's meeting, both players seated in it. */
  async function cameraSeats() {
    const s = await seed();
    await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${s.fixtureId}, ${s.orgId}, ${`mtg-${randomUUID()}`})`;
    const part = { home: `pt-h-${randomUUID().slice(0, 8)}`, away: `pt-a-${randomUUID().slice(0, 8)}` };
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${s.fixtureId}, ${s.home.personId}, 'player', ${part.home}), (${s.fixtureId}, ${s.away.personId}, 'player', ${part.away})`;
    return { s, part };
  }
  const faults = (fixtureId: string) =>
    sql<{ person_id: string; ended_at: Date | null }[]>`
      select person_id, ended_at from fixture_video_guard_faults where fixture_id = ${fixtureId}`;

  it("the schema refuses an unknown state, a missing seat, and a CLIENT-sent time — 400 before the usecase, nothing written", async () => {
    const { s, part } = await cameraSeats();
    const t = await s.tokenFor(s.home.personId);
    let checked = 0;
    for (const body of [{ state: "paused", participantId: part.home }, { state: "start" }, { state: "start", participantId: part.home, at: "2026-10-12T10:00:00Z" }, {}]) {
      const r = await read(await cameraFaultPost(post(url(s.fixtureId, "/camera-fault", t), body), ctx(s.fixtureId)));
      expect(r.status, JSON.stringify(body)).toBe(400);
      checked += 1;
    }
    expect(checked, "anti-vacuity: refused bodies").toBe(4);
    expect(await faults(s.fixtureId)).toEqual([]);
  });

  it("a link stamps its OWN seat (200 { open }); the opponent's seat, and a stranger's session, are the room's 404", async () => {
    const { s, part } = await cameraSeats();
    const t = await s.tokenFor(s.home.personId);
    const theirs = await read(await cameraFaultPost(post(url(s.fixtureId, "/camera-fault", t), { state: "start", participantId: part.away }), ctx(s.fixtureId)));
    expect([theirs.status, theirs.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    authState.userId = randomUUID();
    const stranger = await read(await cameraFaultPost(post(url(s.fixtureId, "/camera-fault"), { state: "start", participantId: part.home }), ctx(s.fixtureId)));
    expect([stranger.status, stranger.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    expect(await faults(s.fixtureId), "nothing written by either").toEqual([]);
    const mine = await read(await cameraFaultPost(post(url(s.fixtureId, "/camera-fault", t), { state: "start", participantId: part.home }), ctx(s.fixtureId)));
    expect([mine.status, mine.body.data]).toEqual([200, { open: true }]);
    expect(await faults(s.fixtureId)).toEqual([{ person_id: s.home.personId, ended_at: null }]);
  });
});
