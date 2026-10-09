// T8 — the seat. A player is seated only when the MEETING says so; nothing
// the browser sends is read (spec §5.2, §10).
//
// The video side is the REAL T7 adapter (`ensureMeeting`, `addParticipant`,
// `hasLiveVideoPublisher`) driven against an in-memory fake of RealtimeKit's
// REST surface, so every seat below passes through the adapter's real
// response parsing — a double that answered `true`/`false` directly would
// prove only the double (AGENTS.md, "the inert seam").
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import {
  addParticipant,
  ensureMeeting,
  hasLiveVideoPublisher,
} from "@/server/external-play/video/realtimekit";
import { isPlayableFixtureStatus, seatPlayer, type PreflightDeps } from "../external-play/preflight";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture } from "./_external-play-seed";

/** The round is opened ten minutes before the scheduled time in these
 *  fixtures, so `now = NOW` sits inside the window (D12: the window hangs
 *  off the open stamp, T−10 … T+20 of it). */
const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

// ─── A fake RealtimeKit backend ────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const RTK_PREFIX = "/client/v4/accounts/acct-1/realtime/kit/app-1";

const RTK_ENV: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: "acct-1",
  REALTIMEKIT_API_TOKEN: "rtk-test-token",
  REALTIMEKIT_APP_ID: "app-1",
  REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
  REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
};
function configureRealtimeKit(): void {
  for (const [k, v] of Object.entries(RTK_ENV)) vi.stubEnv(k, v);
}

type FakeParticipant = { meetingId: string; subject: string; peers: number; everJoined: boolean };
type FailRule = (method: string, path: string) => Response | "network" | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** RealtimeKit's documented shapes, in memory. A participant is LIVE while at
 *  least one peer (tab) is connected with one of its tokens — measured
 *  2026-10-09 (rtk-token-regen.log): two tabs on one participant are one
 *  session row carrying both peers, and a regenerated token does not
 *  invalidate the earlier one. Nothing here touches the network. */
function fakeRealtimeKit() {
  /** HTTP requests, `METHOD /path` relative to the app. */
  const http: string[] = [];
  /** Adapter functions seatPlayer called, in order. */
  const adapter: string[] = [];
  const participants = new Map<string, FakeParticipant>();
  const tokens = new Map<string, string>(); // token → participant id
  let seq = 0;
  let fail: FailRule = () => null;
  let mintBarrier: Promise<void> | null = null;

  const doFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname.replace(RTK_PREFIX, "");
    http.push(`${method} ${path}`);
    const failed = fail(method, path);
    if (failed === "network") throw new TypeError("fetch failed");
    if (failed) return failed;
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/meetings") {
      seq += 1;
      return json(201, { success: true, data: { id: `mtg-${RUN}-${seq}` } });
    }
    if (method === "PATCH" && (m = path.match(/^\/meetings\/([^/]+)$/))) {
      return json(200, { success: true, data: { id: m[1], status: "INACTIVE" } });
    }
    if (method === "POST" && (m = path.match(/^\/meetings\/([^/]+)\/participants$/))) {
      if (mintBarrier) await mintBarrier;
      const body = JSON.parse(String(init?.body)) as { custom_participant_id: string };
      seq += 1;
      const id = `p-${RUN}-${seq}`;
      const token = `jwt-add-${id}`;
      participants.set(id, { meetingId: m[1]!, subject: body.custom_participant_id, peers: 0, everJoined: false });
      tokens.set(token, id);
      return json(201, { success: true, data: { id, token } });
    }
    if (method === "POST" && (m = path.match(/^\/meetings\/([^/]+)\/participants\/([^/]+)\/token$/))) {
      const id = decodeURIComponent(m[2]!);
      if (!participants.has(id)) return json(404, { success: false, error: { code: 404, message: "not found" } });
      seq += 1;
      const token = `jwt-regen-${id}-${seq}`;
      tokens.set(token, id);
      return json(200, { success: true, data: { token } });
    }
    if (method === "GET" && (m = path.match(/^\/meetings\/([^/]+)\/active-session$/))) {
      const mid = m[1]!;
      const anyone = [...participants.values()].some((p) => p.meetingId === mid && p.peers > 0);
      if (!anyone) return json(404, { success: false, error: { code: 404, message: "no active session" } });
      return json(200, { success: true, data: { id: `sess-${mid}`, status: "LIVE" } });
    }
    if (method === "GET" && (m = path.match(/^\/sessions\/sess-([^/]+)\/participants$/))) {
      const mid = m[1]!;
      const rows = [...participants.entries()]
        .filter(([, p]) => p.meetingId === mid && p.everJoined)
        .map(([id, p]) => ({
          id: `conn-${id}`,
          user_id: id,
          custom_participant_id: p.subject,
          joined_at: "2026-10-01T12:01:00Z",
          left_at: p.peers > 0 ? null : "2026-10-01T12:04:00Z",
        }));
      return json(200, { success: true, data: { participants: rows } });
    }
    throw new Error(`fake RealtimeKit: unrouted ${method} ${path}`);
  };
  const fetch = doFetch as unknown as typeof globalThis.fetch;

  const video: NonNullable<PreflightDeps["video"]> = {
    ensureMeeting: (fixtureId) => {
      adapter.push("ensureMeeting");
      return ensureMeeting(fixtureId, { fetch });
    },
    addParticipant: (a) => {
      adapter.push(`addParticipant:${a.preset}`);
      return addParticipant(a, { fetch });
    },
    hasLiveVideoPublisher: (a) => {
      adapter.push("hasLiveVideoPublisher");
      return hasLiveVideoPublisher(a, { fetch });
    },
  };

  return {
    video,
    http,
    adapter,
    participants,
    /** A browser tab joining the meeting WITH a token the server handed out. */
    joinWith(token: string): void {
      const id = tokens.get(token);
      const p = id === undefined ? undefined : participants.get(id);
      if (!p) throw new Error(`fake RealtimeKit: no participant holds token ${token}`);
      p.peers += 1;
      p.everJoined = true;
    },
    /** One tab of this participant closes. */
    leave(participantId: string): void {
      const p = participants.get(participantId);
      if (!p || p.peers === 0) throw new Error(`fake RealtimeKit: ${participantId} is not connected`);
      p.peers -= 1;
    },
    failWhen(rule: FailRule): void {
      fail = rule;
    },
    holdMintsUntil(barrier: Promise<void>): void {
      mintBarrier = barrier;
    },
  };
}

const seed = (over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    ...over,
  });

async function meetingRows(fixtureId: string): Promise<number> {
  const rows = await sql<{ fixture_id: string }[]>`
    select fixture_id from fixture_video_meetings where fixture_id = ${fixtureId}`;
  return rows.length;
}

/** A refusal that must carry no token and must not have touched RealtimeKit. */
function expectInertRefusal(
  got: unknown,
  reason: string,
  rtk: ReturnType<typeof fakeRealtimeKit>,
): void {
  expect(got).toEqual({ seated: false, reason });
  expect(Object.prototype.hasOwnProperty.call(got, "participant"), `${reason} carries no token`).toBe(false);
  expect(rtk.adapter, `${reason}: no adapter call`).toEqual([]);
  expect(rtk.http, `${reason}: no RealtimeKit request`).toEqual([]);
}

afterAll(async () => {
  await sql.end();
});

beforeEach(() => {
  configureRealtimeKit();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── The playable-status predicate (pure) ──────────────────────────────────

describe("isPlayableFixtureStatus (controller ruling Q2, 2026-10-09)", () => {
  // Expected values from the RULING ("scheduled or in_play, nothing else"),
  // never from the function.
  const PLAYABLE = new Set(["scheduled", "in_play"]);

  it.skipIf(!process.env.DATABASE_URL)(
    "sweeps EVERY status the fixtures CHECK constraint allows and reports the count",
    async () => {
      // The universe comes from the schema's own declaration, so a status
      // added by a later migration is swept without anyone editing this test.
      const [row] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class t on t.oid = c.conrelid
         where t.relname = 'fixtures' and c.contype = 'c'
           and pg_get_constraintdef(c.oid) like '%status = ANY%'`;
      const statuses = [...(row?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]!);
      expect(statuses.length, "premise: the CHECK was found and parsed").toBeGreaterThanOrEqual(7);
      let checked = 0;
      let playable = 0;
      for (const s of statuses) {
        expect(isPlayableFixtureStatus(s), s).toBe(PLAYABLE.has(s));
        if (PLAYABLE.has(s)) playable += 1;
        checked += 1;
      }
      expect(checked, "anti-vacuity").toBe(statuses.length);
      expect(playable, "both playable statuses exist in the schema").toBe(2);
    },
  );

  it("an unknown or empty status is NOT playable", () => {
    let checked = 0;
    for (const s of ["", "SCHEDULED", "walkover", "void", " scheduled"]) {
      expect(isPlayableFixtureStatus(s), JSON.stringify(s)).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

// ─── Refusals: the states where NO seat is granted ─────────────────────────

describe.skipIf(!process.env.DATABASE_URL)("seatPlayer refusals", () => {
  it("empty case: a fixture that is not an online-play fixture at all ⇒ not_a_player", async () => {
    const s = await seed({ onlinePlay: "off" });
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "not_a_player", rtk);
  });

  it("a fixture id that does not exist ⇒ not_a_player, never a throw", async () => {
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: randomUUID(), personId: randomUUID() }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "not_a_player", rtk);
  });

  it("D12: a paired-but-UNOPENED round ⇒ round_not_open, and no meeting is created", async () => {
    // The default state of a freshly paired Swiss round: fixtures exist,
    // nothing has been sent. NOT window_closed — the window has not started,
    // and conflating the two would tell the player the wrong thing.
    const s = await seed({ roundOpenedAt: undefined, cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "round_not_open", rtk);
    expect(await meetingRows(s.fixtureId), "an unopened round spends nothing on video").toBe(0);
  });

  it("D12: the SCHEDULE does not open the window — a past scheduled_at with no stamp is still round_not_open", async () => {
    // The defect this ruling exists to prevent: anchoring on the timetable
    // seats players for a round that had not started.
    const s = await seed({ roundOpenedAt: undefined });
    const rtk = fakeRealtimeKit();
    const wellAfterSchedule = new Date(T.getTime() + 60_000);
    const got = await seatPlayer(
      { fixtureId: s.fixtureId, personId: s.home.personId },
      { now: wellAfterSchedule, video: rtk.video },
    );
    expectInertRefusal(got, "round_not_open", rtk);
  });

  it("past T+20 of the OPEN stamp ⇒ window_closed", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const late = new Date(OPENED.getTime() + 20 * 60_000 + 1);
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: late, video: rtk.video });
    expectInertRefusal(got, "window_closed", rtk);
  });

  it("the last millisecond before T+20 of the stamp is still inside the window (boundary pair)", async () => {
    const s = await seed();
    const rtk = fakeRealtimeKit();
    const edge = new Date(OPENED.getTime() + 20 * 60_000 - 1);
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: edge, video: rtk.video });
    expect(got).toEqual({ seated: true, participant: null });
  });

  it("a stamp more than ten minutes in the future: the window has not STARTED ⇒ round_not_open, not window_closed", async () => {
    // roomPhase answers "before" here. A window that has not begun is the
    // round_not_open story (D12), never "closed".
    const s = await seed({ roundOpenedAt: new Date(NOW.getTime() + 10 * 60_000 + 1) });
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "round_not_open", rtk);
  });

  it("someone who is neither player ⇒ not_a_player, with the SAME shape as a missing fixture", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: randomUUID() }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "not_a_player", rtk);
  });

  it("ANOTHER fixture's entrant gets not_a_player and no token, even under required", async () => {
    const mine = await seed({ cameraPolicy: "required" });
    const theirs = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer(
      { fixtureId: mine.fixtureId, personId: theirs.home.personId },
      { now: NOW, video: rtk.video },
    );
    expectInertRefusal(got, "not_a_player", rtk);
    expect(await meetingRows(mine.fixtureId)).toBe(0);
  });

  it("another sport: a non-boardgame division is refused by the guard, not by the camera", async () => {
    const { auth } = await import("./_seed").then((m) => m.seedOrg());
    const { division, fixtures } = await import("./_seed").then((m) => m.seedFutureDivision(auth));
    const fixture = fixtures[0];
    if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
    expect(division.sport_key, "premise: this is not a boardgame division").not.toBe("boardgame");
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: fixture.id, personId: randomUUID() }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "not_a_player", rtk);
  });

  it("a BYE (home = recipient, away = null, forfeited — swiss-shell.ts) ⇒ not_a_player for its one entrant", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await sql`update fixtures set away_entrant_id = null, status = 'forfeited' where id = ${s.fixtureId}`;
    const rtk = fakeRealtimeKit();
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(got, "not_a_player", rtk);
  });

  it("an empty roster: a side with no members matches nobody, not even a hostile null person id", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await sql`delete from entrant_members where entrant_id = ${s.away.entrantId}`;
    const rtk = fakeRealtimeKit();
    // The removed member is no longer a player of this fixture.
    const removed = await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(removed, "not_a_player", rtk);
    // loadSide gives an empty side `personId: null`; a caller smuggling a null
    // through must not "match" it.
    const hostile = await seatPlayer(
      { fixtureId: s.fixtureId, personId: null as unknown as string },
      { now: NOW, video: rtk.video },
    );
    expectInertRefusal(hostile, "not_a_player", rtk);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("seatPlayer on a fixture that can no longer be played (ruling Q2)", () => {
  it("withdrawn: after withdrawEntrantCascade on a league stage the board is abandoned ⇒ fixture_not_playable", async () => {
    // MEASURED path (2026-10-09): a league withdrawal before 50% played
    // expunges, and the fixture becomes `abandoned` — which guard.ts still
    // loads. The Swiss path cannot be driven yet: the boardgame module
    // refuses a `pre` forfeit until W2b lands (WRONG_PHASE), not worked
    // around here.
    const s = await seed({ cameraPolicy: "required" });
    const out = await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
    const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
    expect(out.policy, "premise: the league expunge path ran").toBe("expunge");
    expect(f?.status, "premise: the withdrawal left the board abandoned").toBe("abandoned");

    const rtk = fakeRealtimeKit();
    const stayer = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(stayer, "fixture_not_playable", rtk);
    const leaver = await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: NOW, video: rtk.video });
    expectInertRefusal(leaver, "fixture_not_playable", rtk);
    // A non-player still learns nothing about the board's state.
    const probe = await seatPlayer({ fixtureId: s.fixtureId, personId: randomUUID() }, { now: NOW, video: rtk.video });
    expectInertRefusal(probe, "not_a_player", rtk);
    expect(await meetingRows(s.fixtureId)).toBe(0);
  });

  it("sweeps every settled status and reports the count", async () => {
    // decided / forfeited are settled-OPEN: guard.ts loads them (spectator and
    // room views must), so the seat refuses them itself. finalized / cancelled
    // never get past the guard, whose answer is not_a_player (guard.ts,
    // loadOnlinePlayFixture) — recorded here so a change in either place shows.
    const cases: { status: string; reason: string }[] = [
      { status: "decided", reason: "fixture_not_playable" },
      { status: "forfeited", reason: "fixture_not_playable" },
      { status: "abandoned", reason: "fixture_not_playable" },
      { status: "finalized", reason: "not_a_player" },
      { status: "cancelled", reason: "not_a_player" },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed({ cameraPolicy: "required" });
      await sql`update fixtures set status = ${c.status} where id = ${s.fixtureId}`;
      const rtk = fakeRealtimeKit();
      const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video });
      expectInertRefusal(got, c.reason, rtk);
      checked += 1;
    }
    expect(checked, "anti-vacuity: five settled statuses").toBe(5);
  });

  it("positive pair: in_play is still playable (a reload mid-game re-seats)", async () => {
    const s = await seed();
    await sql`update fixtures set status = 'in_play' where id = ${s.fixtureId}`;
    const rtk = fakeRealtimeKit();
    expect(
      await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: rtk.video }),
    ).toEqual({ seated: true, participant: null });
  });
});
