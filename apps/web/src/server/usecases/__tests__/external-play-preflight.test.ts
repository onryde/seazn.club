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

// Sentry is the one place a swallowed (optional-policy) outage becomes visible;
// mocked so the tests can see it was reported.
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import {
  RealtimeKitError,
  addParticipant,
  ensureMeeting,
  hasLiveVideoPublisher,
  refreshParticipantToken,
} from "@/server/external-play/video/realtimekit";
import { captureError } from "@/lib/sentry";
import { patchDivision } from "../divisions";
import {
  SEAT_REFUSAL_REASONS,
  isPlayableFixtureStatus,
  seatPlayer,
  type PreflightDeps,
  type SeatResult,
} from "../external-play/preflight";
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
  // meeting_id is UNIQUE across the (reused) test DB: every fake instance
  // gets its own prefix on top of the file's RUN suffix.
  const FAKE = `${RUN}-${randomUUID().slice(0, 6)}`;
  let seq = 0;
  let fail: FailRule = () => null;
  // Two-tab race: hold every add-participant answer until N have arrived.
  let holdMintsFor = 0;
  let mintsArrived = 0;
  let releaseMints: () => void = () => undefined;
  const mintsReleased = new Promise<void>((r) => {
    releaseMints = r;
  });

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
      return json(201, { success: true, data: { id: `mtg-${FAKE}-${seq}` } });
    }
    if (method === "PATCH" && (m = path.match(/^\/meetings\/([^/]+)$/))) {
      return json(200, { success: true, data: { id: m[1], status: "INACTIVE" } });
    }
    if (method === "POST" && (m = path.match(/^\/meetings\/([^/]+)\/participants$/))) {
      mintsArrived += 1;
      if (holdMintsFor > 0) {
        if (mintsArrived >= holdMintsFor) releaseMints();
        await mintsReleased;
      }
      const body = JSON.parse(String(init?.body)) as { custom_participant_id: string };
      seq += 1;
      const id = `p-${FAKE}-${seq}`;
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
    refreshParticipantToken: (a) => {
      adapter.push("refreshParticipantToken");
      return refreshParticipantToken(a, { fetch });
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
    /** Every add-participant request waits until `n` have arrived, so
     *  concurrent first claims all mint before any of them stores. */
    holdMintsUntilArrived(n: number): void {
      holdMintsFor = n;
    },
    /** The token a result carries, joined in a NEW tab. */
    join(result: SeatResult): string {
      const token = "participant" in result && result.participant ? result.participant.authToken : null;
      if (!token) throw new Error(`fake RealtimeKit: nothing to join with in ${JSON.stringify(result)}`);
      this.joinWith(token);
      return token;
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

// ─── Policy branches ───────────────────────────────────────────────────────

type ParticipantRow = {
  person_id: string | null;
  participant_id: string;
  preset: string;
  last_publisher_seen_at: Date | null;
};
async function participantRows(fixtureId: string): Promise<ParticipantRow[]> {
  return sql<ParticipantRow[]>`
    select person_id, participant_id, preset, last_publisher_seen_at
      from fixture_video_participants where fixture_id = ${fixtureId}
     order by created_at, id`;
}
type Seeded = Awaited<ReturnType<typeof seed>>;
function claim(
  s: Seeded,
  side: "home" | "away",
  rtk: ReturnType<typeof fakeRealtimeKit>,
  now: Date = NOW,
): Promise<SeatResult> {
  return seatPlayer({ fixtureId: s.fixtureId, personId: s[side].personId }, { now, video: rtk.video });
}
const count = (xs: string[], x: string) => xs.filter((c) => c === x).length;
/** The production default adapter with NO RealtimeKit credentials at all:
 *  any call it makes throws `unconfigured` before a request is sent. */
function unconfigureRealtimeKit(): void {
  for (const k of Object.keys(RTK_ENV)) vi.stubEnv(k, "");
}
/** The token a camera refusal or a seat carries must be the CALLER's own
 *  participant — the one stored for (fixture, caller) — never the opponent's. */
async function expectOwnToken(s: Seeded, side: "home" | "away", got: SeatResult): Promise<string> {
  const p = "participant" in got ? got.participant : null;
  expect(p, `${side} carries a token`).not.toBeNull();
  const rows = await participantRows(s.fixtureId);
  const mine = rows.filter((r) => r.person_id === s[side].personId);
  expect(mine.length, `exactly one participant for the ${side} player`).toBe(1);
  expect(p?.participantId, "the token is for the caller's own participant").toBe(mine[0]?.participant_id);
  expect(p?.authToken.length).toBeGreaterThan(0);
  return p!.participantId;
}

describe.skipIf(!process.env.DATABASE_URL)("seatPlayer under each camera policy", () => {
  it("empty case — policy off: seated with NO tile, and no meeting is ever created", async () => {
    const s = await seed(); // nothing set anywhere ⇒ the competition floor 'off'
    const rtk = fakeRealtimeKit();
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(rtk.adapter, "zero video spend on an off division (spec §5.1)").toEqual([]);
    expect(rtk.http).toEqual([]);
    expect(await meetingRows(s.fixtureId)).toBe(0);
  });

  it("policy off seats through the PRODUCTION adapter with RealtimeKit entirely unconfigured — proof nothing is called", async () => {
    unconfigureRealtimeKit();
    const s = await seed();
    expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW })).toEqual({
      seated: true,
      participant: null,
    });
  });

  it("policy optional: the caller gets their own tile, and the publisher is never even asked", async () => {
    const s = await seed({ cameraPolicy: "optional" });
    const rtk = fakeRealtimeKit();
    const got = await claim(s, "home", rtk);
    expect(got.seated).toBe(true);
    await expectOwnToken(s, "home", got);
    expect(count(rtk.adapter, "hasLiveVideoPublisher"), "optional must not ASK — asking invites a future refusal").toBe(0);
    expect(count(rtk.adapter, "addParticipant:player")).toBe(1);
    expect((await participantRows(s.fixtureId))[0]?.preset).toBe("player");
  });

  it("policy optional + a RealtimeKit outage: still seated (no tile), and the outage is REPORTED, not swallowed", async () => {
    const s = await seed({ cameraPolicy: "optional" });
    const rtk = fakeRealtimeKit();
    rtk.failWhen((m, path) => (m === "POST" && path === "/meetings" ? json(503, { success: false }) : null));
    vi.mocked(captureError).mockClear();
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError).mock.calls[0]?.[0]).toBeInstanceOf(RealtimeKitError);
  });

  it("policy optional with the production adapter unconfigured: seated, no tile", async () => {
    unconfigureRealtimeKit();
    const s = await seed({ cameraPolicy: "optional" });
    expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW })).toEqual({
      seated: true,
      participant: null,
    });
  });

  it("policy required, first claim: camera_required WITH the caller's own token to join, and no stamp", async () => {
    // Nobody has joined, so RealtimeKit answers its well-formed "no active
    // session" 404 — the NORMAL pre-join state, read as not-live, never as an
    // outage (T7 isActiveSessionAbsent).
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const got = await claim(s, "home", rtk);
    expect(got.seated).toBe(false);
    expect(!got.seated && got.reason).toBe("camera_required");
    await expectOwnToken(s, "home", got);
    expect(count(rtk.adapter, "hasLiveVideoPublisher"), "the meeting is asked, every time").toBe(1);
    expect((await participantRows(s.fixtureId))[0]?.last_publisher_seen_at).toBeNull();
  });

  it("policy required: the refusal's token joins the meeting, and the NEXT claim seats — the preflight loop closes", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const first = await claim(s, "home", rtk);
    const pid = await expectOwnToken(s, "home", first);
    rtk.join(first); // the browser joins with exactly what the server handed out
    const before = [...rtk.adapter];
    const second = await claim(s, "home", rtk);
    expect(second.seated).toBe(true);
    expect(second.seated && second.participant?.participantId, "the same participant").toBe(pid);
    const during = rtk.adapter.slice(before.length);
    expect(count(during, "addParticipant:player"), "a returning player is never re-minted").toBe(0);
    expect(count(during, "refreshParticipantToken"), "a returning player gets a regenerated token").toBe(1);
    expect(count(during, "hasLiveVideoPublisher")).toBe(1);
    const [row] = await participantRows(s.fixtureId);
    expect(row?.last_publisher_seen_at?.toISOString(), "the verification is stamped at the claim time").toBe(
      NOW.toISOString(),
    );
  });

  it("the stage's policy is what gates, not the division's", async () => {
    const s = await seed({ cameraPolicy: "required", stageCameraPolicy: "off" });
    const rtk = fakeRealtimeKit();
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(rtk.http).toEqual([]);
  });

  it("the competition floor gates when nothing nearer is set", async () => {
    const s = await seed({ competitionCameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const got = await claim(s, "home", rtk);
    expect(!got.seated && got.reason).toBe("camera_required");
  });

  it("both players: one meeting, two participants, and each token is its OWN player's", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const h = await claim(s, "home", rtk);
    const w = await claim(s, "away", rtk);
    const hp = await expectOwnToken(s, "home", h);
    const wp = await expectOwnToken(s, "away", w);
    expect(hp, "two DISTINCT participants").not.toBe(wp);
    expect(await meetingRows(s.fixtureId), "one meeting for the board, not one per player").toBe(1);
    // The opponent seating does not disturb the first player.
    rtk.join(h);
    expect((await claim(s, "home", rtk)).seated).toBe(true);
    const w2 = await claim(s, "away", rtk);
    expect(!w2.seated && w2.reason, "home's live tile is not away's").toBe("camera_required");
  });

  it("sweeps all three policies against both join states and reports the count", async () => {
    // Expected values from spec §5.1 (off: no tile; optional: tile, never
    // blocks; required: seated only when joined-and-live).
    const cases: { policy: "off" | "optional" | "required"; joined: boolean; seated: boolean; tile: boolean }[] = [
      { policy: "off", joined: false, seated: true, tile: false },
      { policy: "off", joined: true, seated: true, tile: false },
      { policy: "optional", joined: false, seated: true, tile: true },
      { policy: "optional", joined: true, seated: true, tile: true },
      { policy: "required", joined: false, seated: false, tile: true },
      { policy: "required", joined: true, seated: true, tile: true },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed({ cameraPolicy: c.policy });
      const rtk = fakeRealtimeKit();
      const first = await claim(s, "home", rtk);
      // "joined" is only possible with a token the server issued — off issues none.
      if (c.joined && "participant" in first && first.participant) rtk.join(first);
      const got = await claim(s, "home", rtk);
      expect(got.seated, `${c.policy}/${c.joined}`).toBe(c.seated);
      const tile = "participant" in got && got.participant !== null;
      expect(tile, `${c.policy}/${c.joined} tile`).toBe(c.tile);
      checked += 1;
    }
    expect(checked, "anti-vacuity: 3 policies × 2 join states").toBe(6);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("a RealtimeKit outage is video_unavailable — never camera-off, never a seat", () => {
  const down = json(503, { success: false, errors: [{ code: 10000, message: "upstream" }] });
  const html200 = new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });

  it("first-claim failure points under required, swept and counted", async () => {
    const points: { name: string; rule: FailRule }[] = [
      { name: "create meeting 503", rule: (m, p) => (m === "POST" && p === "/meetings" ? down.clone() : null) },
      { name: "create meeting network", rule: (m, p) => (m === "POST" && p === "/meetings" ? "network" : null) },
      { name: "add participant 503", rule: (m, p) => (m === "POST" && p.endsWith("/participants") ? down.clone() : null) },
      { name: "active session 503", rule: (m, p) => (m === "GET" && p.endsWith("/active-session") ? down.clone() : null) },
      { name: "active session HTML 200", rule: (m, p) => (m === "GET" && p.endsWith("/active-session") ? html200.clone() : null) },
    ];
    let checked = 0;
    for (const pt of points) {
      const s = await seed({ cameraPolicy: "required" });
      const rtk = fakeRealtimeKit();
      rtk.failWhen(pt.rule);
      vi.mocked(captureError).mockClear();
      const got = await claim(s, "home", rtk);
      expect(got, pt.name).toEqual({ seated: false, reason: "video_unavailable" });
      expect(rtk.http.length, `${pt.name}: premise — RealtimeKit WAS reached`).toBeGreaterThan(0);
      expect(vi.mocked(captureError), `${pt.name}: the outage is reported`).toHaveBeenCalledTimes(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: five first-claim failure points").toBe(5);
  });

  it("a player who HAD passed, then an outage: video_unavailable, never camera_lost — swept and counted", async () => {
    const points: { name: string; rule: FailRule }[] = [
      { name: "token refresh 503", rule: (m, p) => (m === "POST" && p.endsWith("/token") ? down.clone() : null) },
      { name: "active session 503", rule: (m, p) => (m === "GET" && p.endsWith("/active-session") ? down.clone() : null) },
      {
        name: "active session lowercase 'live'",
        rule: (m, p) =>
          m === "GET" && p.endsWith("/active-session")
            ? json(200, { success: true, data: { id: "sess-x", status: "live" } })
            : null,
      },
      { name: "session participants network", rule: (m, p) => (m === "GET" && p.startsWith("/sessions/") ? "network" : null) },
    ];
    let checked = 0;
    for (const pt of points) {
      const s = await seed({ cameraPolicy: "required" });
      const rtk = fakeRealtimeKit();
      rtk.join(await claim(s, "home", rtk));
      expect((await claim(s, "home", rtk)).seated, `${pt.name}: premise — the camera passed`).toBe(true);
      rtk.failWhen(pt.rule);
      const got = await claim(s, "home", rtk, new Date(NOW.getTime() + 30_000));
      expect(got, pt.name).toEqual({ seated: false, reason: "video_unavailable" });
      checked += 1;
    }
    expect(checked, "anti-vacuity: four returning-player failure points").toBe(4);
  });

  it("the production adapter, unconfigured, under required ⇒ video_unavailable", async () => {
    unconfigureRealtimeKit();
    const s = await seed({ cameraPolicy: "required" });
    expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW })).toEqual({
      seated: false,
      reason: "video_unavailable",
    });
  });

  it("VIDEO_MEETING_ENDED (409) propagates unchanged, under required and optional (controller ruling Q3)", async () => {
    let checked = 0;
    for (const policy of ["required", "optional"] as const) {
      const s = await seed({ cameraPolicy: policy });
      await sql`
        insert into fixture_video_meetings (fixture_id, org_id, meeting_id, ended_at)
        values (${s.fixtureId}, ${s.orgId}, ${`mtg-ended-${randomUUID()}`}, now())`;
      const rtk = fakeRealtimeKit();
      await expect(claim(s, "home", rtk), policy).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_ENDED" });
      expect(rtk.http, `${policy}: refused before any request`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sequences", () => {
  it("a SECOND claim by a seated player: same participant, regenerated token, one row, re-verified", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    rtk.join(await claim(s, "home", rtk));
    const a = await claim(s, "home", rtk);
    const mark = rtk.adapter.length;
    const b = await claim(s, "home", rtk);
    expect(a.seated && b.seated).toBe(true);
    expect(b.seated && b.participant?.participantId).toBe(a.seated && a.participant?.participantId);
    expect(count(rtk.adapter.slice(mark), "addParticipant:player"), "a reload must not mint a second participant").toBe(0);
    expect(count(rtk.adapter.slice(mark), "hasLiveVideoPublisher"), "but it MUST re-verify").toBe(1);
    expect((await participantRows(s.fixtureId)).length).toBe(1);
  });

  it("a SECOND TAB racing the first claim: one participant is stored, both tabs get tokens for it, neither knocks the other out", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    rtk.holdMintsUntilArrived(2); // both claims mint before either stores
    // Stage the race deterministically: while this SHARE lock is held, plain
    // selects pass but every insert into the table waits. Released only once
    // TWO backends are waiting on a lock — so without the meeting-row lock
    // both claims have already looked, found nothing, and queued an insert.
    let releaseTable: () => void = () => undefined;
    const tableReleased = new Promise<void>((r) => {
      releaseTable = r;
    });
    let tableLocked: () => void = () => undefined;
    const locked = new Promise<void>((r) => {
      tableLocked = r;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`lock table fixture_video_participants in share mode`;
      tableLocked();
      await tableReleased;
    });
    await locked;
    const racing = Promise.all([claim(s, "home", rtk), claim(s, "home", rtk)]);
    let waiting = 0;
    try {
      for (let i = 0; i < 200 && waiting < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query ilike '%fixture_video_%'`;
        waiting = w?.n ?? 0;
      }
    } finally {
      releaseTable();
      await blocker;
    }
    expect(waiting, "premise: both claims were held at the same point").toBeGreaterThanOrEqual(2);
    const [t1, t2] = await racing;
    expect(count(rtk.adapter, "addParticipant:player"), "premise: the race really happened").toBe(2);
    const rows = await participantRows(s.fixtureId);
    expect(rows.length, "the meeting-row lock lets exactly one participant be stored").toBe(1);
    const stored = rows[0]!.participant_id;
    for (const t of [t1, t2]) {
      expect(!t.seated && t.reason).toBe("camera_required");
      expect("participant" in t && t.participant?.participantId, "both tabs hold the STORED participant").toBe(stored);
    }
    // Both tabs join; one closes; the other keeps the seat (measured: a
    // regenerated token does not invalidate the earlier one).
    rtk.join(t1);
    rtk.join(t2);
    expect((await claim(s, "home", rtk)).seated).toBe(true);
    rtk.leave(stored);
    expect((await claim(s, "home", rtk)).seated, "the other tab is still live").toBe(true);
  });

  it("seating after the player LEFT the meeting: camera_lost with a token to rejoin, stable on repeat, and rejoining re-seats", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    rtk.join(await claim(s, "home", rtk));
    const seated = await claim(s, "home", rtk);
    expect(seated.seated, "premise: the camera really did pass first").toBe(true);
    const pid = seated.seated ? seated.participant!.participantId : "";
    rtk.leave(pid);

    const lost = await claim(s, "home", rtk, new Date(NOW.getTime() + 30_000));
    expect(!lost.seated && lost.reason, "had it and lost it").toBe("camera_lost");
    await expectOwnToken(s, "home", lost);
    // Asked again with the world unchanged, the answer is the same story —
    // the player did not become someone who "never had it".
    const again = await claim(s, "home", rtk, new Date(NOW.getTime() + 45_000));
    expect(!again.seated && again.reason, "a repeat claim tells the same story").toBe("camera_lost");

    rtk.join(again); // rejoin with the newest token the server issued
    const back = await claim(s, "home", rtk, new Date(NOW.getTime() + 60_000));
    expect(back.seated).toBe(true);
    expect(back.seated && back.participant?.participantId, "the same participant").toBe(pid);
  });

  it("a player is never handed an ARBITER participant, even when one exists for the same person", async () => {
    // The player preset denies the video toggle; an arbiter's need not. An
    // organiser who also plays (and once joined this board as arbiter) must
    // still be minted a PLAYER participant for their seat.
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const { meetingId } = await rtk.video.ensureMeeting(s.fixtureId);
    const arbiterId = `p-arbiter-${randomUUID().slice(0, 8)}`;
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${s.fixtureId}, ${s.home.personId}, 'arbiter', ${arbiterId})`;
    const got = await claim(s, "home", rtk);
    expect(!got.seated && got.reason, "premise: refused on the camera, not on video").toBe("camera_required");
    const token = "participant" in got ? got.participant : null;
    expect(token?.participantId).not.toBe(arbiterId);
    const [player] = await sql<{ participant_id: string }[]>`
      select participant_id from fixture_video_participants
       where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId} and preset = 'player'`;
    expect(token?.participantId, "the token is the player-preset participant").toBe(player?.participant_id);
    expect(rtk.participants.get(token!.participantId)?.meetingId).toBe(meetingId);
  });

  it("after a WITHDRAWAL, a previously seated player can no longer take the seat", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    rtk.join(await claim(s, "home", rtk));
    expect((await claim(s, "home", rtk)).seated, "premise: seated").toBe(true);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
    const mark = rtk.http.length;
    expect(await claim(s, "home", rtk)).toEqual({ seated: false, reason: "fixture_not_playable" });
    expect(rtk.http.slice(mark), "no video call for an unplayable board").toEqual([]);
  });

  it("a policy DOWNGRADE mid-round through the real writer (patchDivision) relaxes the gate; a re-tightening is refused", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const owner = await mintOrgOwnerAuth(s.orgId);
    const rtk = fakeRealtimeKit();
    const r1 = await claim(s, "home", rtk);
    expect(!r1.seated && r1.reason).toBe("camera_required");
    await patchDivision(owner, s.divisionId, { camera_policy: "optional" });
    const r2 = await claim(s, "home", rtk);
    expect(r2.seated, "optional never blocks").toBe(true);
    expect(r2.seated && r2.participant?.participantId, "the same participant, reused").toBe(
      !r1.seated && "participant" in r1 ? r1.participant.participantId : "",
    );
    await patchDivision(owner, s.divisionId, { camera_policy: "off" });
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    // T6's downgrade-only guard: the round is open, so tightening is refused
    // and the seat keeps answering under 'off'.
    await expect(patchDivision(owner, s.divisionId, { camera_policy: "required" })).rejects.toMatchObject({
      status: 409,
      code: "POLICY_LOCKED",
    });
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("which refusals carry a token (controller ruling Q1)", () => {
  it("every refusal reason, swept: only the two camera refusals carry the caller's own token", async () => {
    // From the RULING, not the code: a token only once every other check has
    // passed, and only for the caller's own participant.
    const TOKEN_BEARING = new Set(["camera_required", "camera_lost"]);
    const TOKENLESS = new Set(["window_closed", "not_a_player", "round_not_open", "fixture_not_playable", "video_unavailable"]);
    expect(
      [...SEAT_REFUSAL_REASONS].sort(),
      "the code's reason list is exactly the ruling's — a new reason needs a row here",
    ).toEqual([...TOKEN_BEARING, ...TOKENLESS].sort());

    const seen = new Map<string, SeatResult>();
    const req = () => seed({ cameraPolicy: "required" });
    {
      const s = await req();
      seen.set("not_a_player", await seatPlayer({ fixtureId: s.fixtureId, personId: randomUUID() }, { now: NOW, video: fakeRealtimeKit().video }));
    }
    {
      const s = await seed({ cameraPolicy: "required", roundOpenedAt: undefined });
      seen.set("round_not_open", await claim(s, "home", fakeRealtimeKit()));
    }
    {
      const s = await req();
      seen.set("window_closed", await claim(s, "home", fakeRealtimeKit(), new Date(OPENED.getTime() + 21 * 60_000)));
    }
    {
      const s = await req();
      await sql`update fixtures set status = 'decided' where id = ${s.fixtureId}`;
      seen.set("fixture_not_playable", await claim(s, "home", fakeRealtimeKit()));
    }
    {
      const s = await req();
      const rtk = fakeRealtimeKit();
      rtk.failWhen((m, p) => (m === "GET" && p.endsWith("/active-session") ? json(503, { success: false }) : null));
      seen.set("video_unavailable", await claim(s, "home", rtk));
    }
    const camS = await req();
    {
      seen.set("camera_required", await claim(camS, "home", fakeRealtimeKit()));
    }
    const lostS = await req();
    {
      const rtk = fakeRealtimeKit();
      rtk.join(await claim(lostS, "home", rtk));
      const ok = await claim(lostS, "home", rtk);
      rtk.leave(ok.seated ? ok.participant!.participantId : "");
      seen.set("camera_lost", await claim(lostS, "home", rtk));
    }

    let checked = 0;
    for (const [reason, got] of seen) {
      expect(!got.seated && got.reason, `premise: the ${reason} case produced ${reason}`).toBe(reason);
      expect("participant" in got, `${reason}: token present?`).toBe(TOKEN_BEARING.has(reason));
      checked += 1;
    }
    await expectOwnToken(camS, "home", seen.get("camera_required")!);
    await expectOwnToken(lostS, "home", seen.get("camera_lost")!);
    expect(checked, "anti-vacuity: every refusal reason produced once").toBe(SEAT_REFUSAL_REASONS.length);
  });
});
