// T8 — the seat. A player is seated only when the MEETING says so; nothing
// the browser sends is read (spec §5.2, §10).
//
// The video side is the REAL T7 adapter (`ensureMeeting`, `addParticipant`,
// `hasLiveVideoPublisher`) driven against an in-memory fake of RealtimeKit's
// REST surface, so every seat below passes through the adapter's real
// response parsing — a double that answered `true`/`false` directly would
// prove only the double (AGENTS.md, "the inert seam").
//
// Single sport, deliberately: online play exists only for boardgame
// (supportsOnlinePlay / ONLINE_PLAY_SPORT), so every other sport is refused by
// the guard before the seat is reached — asserted once below ("another sport").
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { roomPhase, windowFor } from "@/server/external-play/window";
import { patchDivision } from "../divisions";
import {
  SEAT_REFUSAL_REASONS,
  isPlayableFixtureStatus,
  organiserOverrideVideo,
  seatPlayer,
  type PreflightDeps,
  type SeatResult,
} from "../external-play/preflight";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { withdrawEntrantCascade } from "../withdrawal";
import { PLAY_SCOPES, unlinkLichess } from "../external-accounts";
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

/** The grant every link made before spec §3.1's 2026-10-10 amendment carries
 *  — typed, not read from PLAY_SCOPES: it is what the earlier consent screen
 *  granted, and the play gate now refuses it (fix round 1b). */
const PRE_AMENDMENT_GRANT = ["board:play", "challenge:write"];
async function narrowGrant(userId: string): Promise<void> {
  await sql`update user_external_accounts set scopes = ${sql.array(PRE_AMENDMENT_GRANT)} where user_id = ${userId}`;
}
async function restoreGrant(userId: string): Promise<void> {
  await sql`update user_external_accounts set scopes = ${sql.array([...PLAY_SCOPES])} where user_id = ${userId}`;
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
  // Gated like every describe below: with no DATABASE_URL (CI's unit job) the lazy client throws on end(), which
  // failed the whole file there instead of running its DB-free half.
  if (process.env.DATABASE_URL) await sql.end();
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

  it("positive pair: the in_play STATUS is playable (a status sweep — an online board stays scheduled during play; re-entry is pinned below)", async () => {
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
        insert into fixture_video_meetings (fixture_id, org_id, meeting_id, ended_at, home_entrant_id, away_entrant_id)
        values (${s.fixtureId}, ${s.orgId}, ${`mtg-ended-${randomUUID()}`}, now(), (select home_entrant_id from fixtures where id = ${s.fixtureId}), (select away_entrant_id from fixtures where id = ${s.fixtureId}))`;
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

// ─── Re-entry after T+20 (controller ruling I1; condition (c) amended in fix round 2) ───
//
// "T+20 is the deadline to be seated and have the game created — not a cap on
// the game" (spec §3.6). After the window, a caller passes the window check
// only when ALL THREE hold:
//   (a) they were seated on this fixture — T9's game record names their
//       Lichess account for their colour;
//   (b) the game exists — the effective bridge carries a game id;
//   (c) the game is not over — that bridge is `ready` (T9's create + accept)
//       or `live` (T10's first accepted move); `finished` / `needs_organiser`
//       refuse.
// The camera checks still apply. A caller never seated still gets
// window_closed (a no-show is T13's).
//
// Every fixture below stays `scheduled`: that IS the production state of an
// online game in progress — `fixtures.status` turns `in_play` only through
// `core.start`, which T12 emits as it writes the result. Nothing here sets
// `in_play`.

/** Past T+20 of the OPEN stamp, derived from the window's own constants so
 *  moving DEADLINE_AFTER_MS moves this with it. */
const LATE = new Date(windowFor(OPENED).deadline.getTime() + 20 * 60_000);

type Rtk = ReturnType<typeof fakeRealtimeKit>;
type BridgeStatus = "ready" | "live" | "finished" | "needs_organiser";

/** The bridge as the product writes it. Default: T9's create-game record
 *  (task-9-brief.md, the `ready` UPDATE) — the Lichess game id, White's side
 *  and the two Lichess accounts it SEATED, written together immediately after
 *  T9 re-verified both seats through seatPlayer. create-game.ts is not built
 *  yet, so this writes those columns exactly as T9 does. `live` is T10's flip
 *  on the first accepted move; `needs_organiser` is T9's accept-failure write
 *  (game id recorded, reason provider_error); `finished` is the game over. */
async function recordGame(
  s: Seeded,
  over: {
    challengeId?: string | null;
    whiteSide?: Side | null;
    white?: string;
    black?: string;
    status?: BridgeStatus;
    basis?: Date;
  } = {},
): Promise<void> {
  const whiteSide = over.whiteSide === undefined ? "home" : over.whiteSide;
  const whiteOf: Side = whiteSide ?? "home";
  const blackOf: Side = whiteOf === "home" ? "away" : "home";
  const challengeId = over.challengeId === undefined ? `g${randomUUID().slice(0, 11)}` : over.challengeId;
  const status = over.status ?? "ready";
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, needs_reason, scheduled_at_basis, challenge_id, white_side,
       white_lichess_id, black_lichess_id, started_at, finished_at)
    values (${s.fixtureId}, ${s.orgId}, ${status},
            ${status === "needs_organiser" ? "provider_error" : null},
            ${over.basis ?? T}, ${challengeId}, ${whiteSide},
            ${over.white ?? s[whiteOf].lichessId}, ${over.black ?? s[blackOf].lichessId},
            ${status === "live" || status === "finished" ? OPENED : null},
            ${status === "finished" ? NOW : null})
    on conflict (fixture_id) do update set
      status = excluded.status, needs_reason = excluded.needs_reason,
      scheduled_at_basis = excluded.scheduled_at_basis,
      challenge_id = excluded.challenge_id, white_side = excluded.white_side,
      white_lichess_id = excluded.white_lichess_id, black_lichess_id = excluded.black_lichess_id,
      started_at = excluded.started_at, finished_at = excluded.finished_at`;
}

/** The writes that move a bridge after T9 created it: T10's flip to `live`
 *  on the first accepted move, the game's end, or the organiser hand-off. */
async function setBridgeStatus(s: Seeded, status: BridgeStatus): Promise<void> {
  await sql`
    update fixture_external_play
       set status = ${status},
           needs_reason = ${status === "needs_organiser" ? "provider_error" : null},
           finished_at = ${status === "finished" ? NOW : null}
     where fixture_id = ${s.fixtureId}`;
}

async function setFixtureStatus(s: Seeded, status: string): Promise<void> {
  await sql`update fixtures set status = ${status} where id = ${s.fixtureId}`;
}

async function fixtureStatus(s: Seeded): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
  return row?.status;
}

/** Both players seated in the window under `required`, as T9 needs them
 *  before it creates a game: each claims, joins with the token they were
 *  issued, and claims again. Returns each player's participant id. */
async function seatBothLive(s: Seeded, rtk: Rtk): Promise<Record<Side, string>> {
  const pid: Record<Side, string> = { home: "", away: "" };
  for (const sd of ["home", "away"] as const) {
    rtk.join(await claim(s, sd, rtk));
    const got = await claim(s, sd, rtk);
    expect(got.seated, `premise: ${sd} seated inside the window`).toBe(true);
    pid[sd] = got.seated && got.participant ? got.participant.participantId : "";
  }
  return pid;
}

describe.skipIf(!process.env.DATABASE_URL)("re-entry after T+20 (ruling I1, amending Q1)", () => {
  it("premise: LATE is past the window, by the window's own rule", () => {
    expect(roomPhase(LATE, OPENED)).toBe("closed");
  });

  it("required: a seated player reloads mid-game after T+20 — on a `ready` AND a `live` game, both colours — their OWN token, then re-seated once live", async () => {
    let checked = 0;
    for (const status of ["ready", "live"] as const) {
      const s = await seed({ cameraPolicy: "required" });
      const rtk = fakeRealtimeKit();
      const pid = await seatBothLive(s, rtk);
      // White is AWAY on this board, so each player's account sits in the
      // column for their COLOUR, not their side.
      await recordGame(s, { whiteSide: "away", status });
      expect(await fixtureStatus(s), "premise: the production state — the board is still scheduled").toBe("scheduled");
      for (const sd of ["home", "away"] as const) {
        rtk.leave(pid[sd]); // the reload: the old tab is gone from the meeting
        const back = await claim(s, sd, rtk, LATE);
        // T9 verified them live before it created the game, so the evidence
        // says they HAD the camera: camera_lost, never window_closed.
        expect(!back.seated && back.reason, `${status}/${sd}: a camera refusal, not window_closed`).toBe("camera_lost");
        expect(await expectOwnToken(s, sd, back), `${status}/${sd}: their own participant`).toBe(pid[sd]);
        rtk.join(back);
        const seated = await claim(s, sd, rtk, LATE);
        expect(seated.seated, `${status}/${sd}: re-seated once live`).toBe(true);
        expect(seated.seated && seated.participant?.participantId).toBe(pid[sd]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: two bridge statuses × two colours").toBe(4);
  });

  it("required, camera not live yet: a camera refusal WITH their own token, unchanged an hour later, while the live opponent is seated", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    const pid = await seatBothLive(s, rtk);
    await recordGame(s, { status: "live" });
    rtk.leave(pid.home);
    // A long game: 15+10 runs well past T+20 (SHIP1_TIME_CONTROLS).
    for (const at of [LATE, new Date(LATE.getTime() + 60 * 60_000)]) {
      const got = await claim(s, "home", rtk, at);
      expect(got.seated, "not live, so not seated").toBe(false);
      expect(!got.seated && got.reason).toBe("camera_lost");
      expect(await expectOwnToken(s, "home", got)).toBe(pid.home);
    }
    const opponent = await claim(s, "away", rtk, LATE);
    expect(opponent.seated, "the opponent, still live, re-enters").toBe(true);
    expect(opponent.seated && opponent.participant?.participantId, "with THEIR own participant").toBe(pid.away);
  });

  it("off seats a re-entering player with no tile and no RealtimeKit call; optional hands them their own tile", async () => {
    let checked = 0;
    for (const policy of ["off", "optional"] as const) {
      const s = await seed({ cameraPolicy: policy });
      const rtk = fakeRealtimeKit();
      for (const sd of ["home", "away"] as const) {
        expect((await claim(s, sd, rtk)).seated, `premise: ${policy} ${sd} seated in the window`).toBe(true);
      }
      await recordGame(s);
      const mark = rtk.http.length;
      const back = await claim(s, "home", rtk, LATE);
      if (policy === "off") {
        expect(back).toEqual({ seated: true, participant: null });
        expect(rtk.http.slice(mark), "off: still no RealtimeKit call").toEqual([]);
      } else {
        expect(back.seated).toBe(true);
        await expectOwnToken(s, "home", back);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: two policies").toBe(2);
  });

  it("a caller NOT re-entering gets window_closed after T+20 — no token, no RealtimeKit call — each condition failing ALONE, swept and counted", async () => {
    const cases: { name: string; as: Side; arrange: (s: Seeded, rtk: Rtk) => Promise<void> }[] = [
      { name: "a no-show: nobody came in the window and no game exists (T13's)", as: "home", arrange: async () => undefined },
      {
        name: "(a) alone: the game on record was created for OTHER Lichess accounts",
        as: "home",
        arrange: async (s) => {
          await recordGame(s, { white: `other-w-${RUN}`, black: `other-b-${RUN}` });
        },
      },
      {
        name: "(a) alone: the caller UNLINKED their Lichess account after the game was created",
        as: "home",
        arrange: async (s, rtk) => {
          await seatBothLive(s, rtk);
          await recordGame(s);
          // The real writer. Its revoke goes to Lichess over global fetch.
          const revoke = vi.fn(async () => new Response(null, { status: 200 }));
          vi.stubGlobal("fetch", revoke);
          try {
            await unlinkLichess(s.home.userId);
          } finally {
            vi.unstubAllGlobals();
          }
          expect(revoke, "premise: the real unlink ran (it revoked at Lichess)").toHaveBeenCalledTimes(1);
          // Final re-review P11 (4): the unlink also holds the live board (token_revoked, this seat), which (c)
          // refuses on its own. Lifted by hand so (a) — no account to match the record — stands ALONE.
          const [held] = await sql<{ needs_reason: string | null; revoked_seat: string | null }[]>`
            select needs_reason, revoked_seat from fixture_external_play where fixture_id = ${s.fixtureId}`;
          expect(held, "premise: the unlink held the board on its own seat").toEqual({ needs_reason: "token_revoked", revoked_seat: "white" });
          await sql`
            update fixture_external_play set status = 'ready', needs_reason = null, revoked_seat = null, last_error = null
             where fixture_id = ${s.fixtureId}`;
        },
      },
      {
        name: "(a) alone: a record with no colour cannot say whose account is whose",
        // The away player's account IS in the black column; without a colour
        // the record still must not seat them.
        as: "away",
        arrange: async (s, rtk) => {
          await seatBothLive(s, rtk);
          await recordGame(s, { whiteSide: null });
        },
      },
      {
        name: "(b) alone: both seated, the accounts recorded, but no game id",
        as: "home",
        arrange: async (s, rtk) => {
          await seatBothLive(s, rtk);
          await recordGame(s, { challengeId: null });
        },
      },
      {
        name: "(c) alone: the game is over (`finished`)",
        as: "home",
        arrange: async (s, rtk) => {
          await seatBothLive(s, rtk);
          await recordGame(s, { status: "finished" });
        },
      },
      {
        name: "(c) alone: the board went to the organiser (`needs_organiser`, T9's accept failure)",
        as: "home",
        arrange: async (s, rtk) => {
          await seatBothLive(s, rtk);
          await recordGame(s, { status: "needs_organiser" });
        },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed({ cameraPolicy: "required" });
      await c.arrange(s, fakeRealtimeKit());
      expect(await fixtureStatus(s), `${c.name}: premise — still scheduled`).toBe("scheduled");
      const late = fakeRealtimeKit();
      const got = await claim(s, c.as, late, LATE);
      expect(got, c.name).toEqual({ seated: false, reason: "window_closed" });
      expectInertRefusal(got, "window_closed", late);
      checked += 1;
    }
    expect(checked, "anti-vacuity: seven ways not to re-enter").toBe(7);
  });

  it("a game recorded for an OLDER timetable is still this fixture's game: the seated player re-enters (fix round 1)", async () => {
    // Controller ruling 2026-10-10 (T9 fix round 1, I1): a bridge row that
    // carries a challenge_id is never stale, whatever its status — a
    // reschedule after the create cannot un-create the game, so it cannot
    // lock its players out either. This was "(b) alone" in the sweep above
    // until the ruling; it is now the positive pair.
    let checked = 0;
    for (const status of ["ready", "live"] as const) {
      const s = await seed({ cameraPolicy: "off" });
      const rtk = fakeRealtimeKit();
      for (const sd of ["home", "away"] as const) {
        expect((await claim(s, sd, rtk)).seated, `premise: ${sd} seated in the window`).toBe(true);
      }
      await recordGame(s, { status, basis: new Date(T.getTime() - 86_400_000) });
      expect(await claim(s, "home", rtk, LATE), status).toEqual({ seated: true, participant: null });
      checked += 1;
    }
    expect(checked, "anti-vacuity: ready and live").toBe(2);
  });

  it("a previously seated player whose board has been settled is refused, no token — swept and counted", async () => {
    let checked = 0;
    for (const status of ["decided", "forfeited", "abandoned"]) {
      const s = await seed({ cameraPolicy: "required" });
      await seatBothLive(s, fakeRealtimeKit());
      await recordGame(s, { status: "live" });
      await setFixtureStatus(s, status);
      const late = fakeRealtimeKit();
      expectInertRefusal(await claim(s, "home", late, LATE), "fixture_not_playable", late);
      checked += 1;
    }
    expect(checked, "anti-vacuity: three settled statuses").toBe(3);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("which refusals carry a token (controller ruling Q1)", () => {
  it("every refusal reason, swept: only the two camera refusals carry the caller's own token", async () => {
    // From the RULING, not the code: a token only once every other check has
    // passed, and only for the caller's own participant.
    const TOKEN_BEARING = new Set(["camera_required", "camera_lost"]);
    const TOKENLESS = new Set([
      "window_closed", "not_a_player", "round_not_open", "fixture_not_playable", "video_unavailable",
      // Fix round 2: the play grant, checked before any token is minted.
      "lichess_link_required", "lichess_reconsent_required",
    ]);
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
    {
      const s = await req();
      await sql`delete from user_external_accounts where user_id = ${s.home.userId}`;
      seen.set("lichess_link_required", await claim(s, "home", fakeRealtimeKit()));
    }
    {
      const s = await req();
      await narrowGrant(s.home.userId);
      seen.set("lichess_reconsent_required", await claim(s, "home", fakeRealtimeKit()));
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

// ─── The play grant at the seat (fix round 2, controller ruling) ──────────
//
// T2's gate (assertLichessConsentForPlay) is asked by the SEAT, after the
// identity checks and before any token is minted, so a player whose grant is
// missing or stale is told so by name — the re-link screen's two reasons —
// instead of being seated into a room whose game can never be created.

describe.skipIf(!process.env.DATABASE_URL)("the play grant is checked at the seat (fix round 2)", () => {
  it("no link, or a stale grant, is refused BY NAME under every camera policy — no token, no RealtimeKit call — swept and counted", async () => {
    const arrange: Array<[string, (s: Seeded) => Promise<void>]> = [
      ["lichess_link_required", async (s) => {
        // The real writer; its revoke goes to Lichess over global fetch.
        const revoke = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", revoke);
        try {
          await unlinkLichess(s.home.userId);
        } finally {
          vi.unstubAllGlobals();
        }
        expect(revoke, "premise: the real unlink ran").toHaveBeenCalledTimes(1);
      }],
      ["lichess_reconsent_required", (s) => narrowGrant(s.home.userId)],
    ];
    let checked = 0;
    for (const policy of ["off", "optional", "required"] as const) {
      for (const [reason, run] of arrange) {
        const s = await seed({ cameraPolicy: policy });
        await run(s);
        const rtk = fakeRealtimeKit();
        expectInertRefusal(await claim(s, "home", rtk), reason, rtk);
        expect(await participantRows(s.fixtureId), `${policy}/${reason}: nothing minted`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: three policies × two refusals").toBe(6);
  });

  it("the positive pair: the full grant, consented, is seated — under off with no RealtimeKit call", async () => {
    const s = await seed({ cameraPolicy: "off" });
    await narrowGrant(s.home.userId);
    await restoreGrant(s.home.userId); // re-consented: the full grant again
    const rtk = fakeRealtimeKit();
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(rtk.http).toEqual([]);
  });

  it("RE-ENTRY after T+20 by a player whose grant was downgraded since is refused, no token; the opponent, grant intact, re-enters", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    await seatBothLive(s, rtk);
    await recordGame(s, { status: "live" });
    await narrowGrant(s.home.userId);
    const late = fakeRealtimeKit();
    expectInertRefusal(await claim(s, "home", late, LATE), "lichess_reconsent_required", late);
    const opponent = await claim(s, "away", rtk, LATE);
    expect(opponent.seated, "the opponent re-enters").toBe(true);
  });

  it("a refusal that re-linking cannot cure comes FIRST: a board that cannot be played, an unopened round, a closed window — swept and counted", async () => {
    const cases: Array<[string, () => Promise<{ s: Seeded; at: Date }>]> = [
      ["fixture_not_playable", async () => {
        const s = await seed({ cameraPolicy: "required" });
        await sql`update fixtures set status = 'decided' where id = ${s.fixtureId}`;
        return { s, at: NOW };
      }],
      ["round_not_open", async () => ({ s: await seed({ cameraPolicy: "required", roundOpenedAt: undefined }), at: NOW })],
      ["window_closed", async () => ({ s: await seed({ cameraPolicy: "required" }), at: LATE })],
    ];
    let checked = 0;
    for (const [reason, arrange] of cases) {
      const { s, at } = await arrange();
      await narrowGrant(s.home.userId);
      const rtk = fakeRealtimeKit();
      expectInertRefusal(await claim(s, "home", rtk, at), reason, rtk);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// ─── A forged camera claim is inert (spec §5.2, §10, test item 5) ──────────

describe.skipIf(!process.env.DATABASE_URL)("a forged camera claim is inert", () => {
  it("an extra cameraOk:true on the argument changes nothing — the meeting is asked anyway", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    // The POC's gate, forced onto the call as a hostile client would:
    // seatPlayer has no such parameter, so this must be dead weight.
    const forged = { fixtureId: s.fixtureId, personId: s.home.personId, cameraOk: true } as unknown as {
      fixtureId: string;
      personId: string;
    };
    const got = await seatPlayer(forged, { now: NOW, video: rtk.video });
    expect(!got.seated && got.reason).toBe("camera_required");
    expect(count(rtk.adapter, "hasLiveVideoPublisher"), "the meeting was asked — that is the point").toBe(1);
  });

  it("the module names no client-supplied camera flag anywhere in its source", () => {
    // Audit-shaped, so it carries its own anti-vacuity: positive controls that
    // prove the right file was read, and a size floor.
    const src = readFileSync(join(__dirname, "../external-play/preflight.ts"), "utf8");
    expect(src.length, "premise: the file was actually read").toBeGreaterThan(500);
    expect(src, "positive control: this IS the preflight module").toContain("hasLiveVideoPublisher");
    expect(src, "positive control: and it is the one that gates the seat").toContain("camera_required");
    expect(src).not.toMatch(/camera[_ ]?ok/i);
    expect(src).not.toMatch(/\bclaimsCamera\b|\bcameraGranted\b|\bvideoEnabled\b/);
  });
});

// ─── D11: an organiser proceeds without video ──────────────────────────────

async function auditRows(fixtureId: string) {
  return sql<{ kind: string; actor_user_id: string; note: string; org_id: string }[]>`
    select kind, actor_user_id, note, org_id from online_chess_audit
     where fixture_id = ${fixtureId} order by created_at, id`;
}
async function competitionEventCount(competitionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from competition_events where competition_id = ${competitionId}`;
  return row?.n ?? 0;
}
async function overrideStamp(fixtureId: string): Promise<Date | null> {
  const [row] = await sql<{ video_override_at: Date | null }[]>`
    select video_override_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return row?.video_override_at ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)("organiserOverrideVideo (D11 — a vendor outage must not cancel a tournament)", () => {
  it("after an override, a required division seats the player with no tile, and RealtimeKit is never called", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await organiserOverrideVideo({
      fixtureId: s.fixtureId,
      actorUserId: s.ownerUserId,
      note: "RealtimeKit 503 for twenty minutes; both players present in the hall",
    });
    // Every RealtimeKit request would fail — so a seat proves the override
    // short-circuited BEFORE the vendor was touched.
    const rtk = fakeRealtimeKit();
    rtk.failWhen(() => "network");
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(await claim(s, "away", rtk)).toEqual({ seated: true, participant: null });
    expect(rtk.adapter, "the override exists because the vendor may be the broken thing").toEqual([]);
    expect(rtk.http).toEqual([]);
  });

  it("SEQUENCE: outage ⇒ video_unavailable, organiser overrides, the same player is then seated", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const rtk = fakeRealtimeKit();
    rtk.failWhen((m, p) => (m === "GET" && p.endsWith("/active-session") ? json(503, { success: false }) : null));
    expect(await claim(s, "home", rtk)).toEqual({ seated: false, reason: "video_unavailable" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    const mark = rtk.http.length;
    expect(await claim(s, "home", rtk)).toEqual({ seated: true, participant: null });
    expect(rtk.http.slice(mark)).toEqual([]);
  });

  it("the override does not outrank the other refusals: an unopened round is still round_not_open", async () => {
    const s = await seed({ cameraPolicy: "required", roundOpenedAt: undefined });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    const rtk = fakeRealtimeKit();
    expectInertRefusal(await claim(s, "home", rtk), "round_not_open", rtk);
  });

  it("records ONE online_chess_audit row with the actor and the note, and nothing in competition_events", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const eventsBefore = await competitionEventCount(s.competitionId);
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "  vendor outage  " });
    const rows = await auditRows(s.fixtureId);
    expect(rows).toEqual([
      { kind: "video_override", actor_user_id: s.ownerUserId, note: "vendor outage", org_id: s.orgId },
    ]);
    expect(await overrideStamp(s.fixtureId), "the stamp the seat reads").not.toBeNull();
    expect(
      await competitionEventCount(s.competitionId),
      "one authority per fact (addendum 2): no competition_events row",
    ).toBe(eventsBefore);
  });

  it("is idempotent and FIRST-WRITER-WINS: a second override changes neither the stamp nor the record", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "one" });
    const first = await overrideStamp(s.fixtureId);
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "two" });
    expect((await overrideStamp(s.fixtureId))?.getTime()).toBe(first?.getTime());
    const rows = await auditRows(s.fixtureId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.note, "the reason on the record is the one the decision was taken on").toBe("one");
  });

  it("two organisers overriding at once still leave exactly one record", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await Promise.all([
      organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "a" }),
      organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "b" }),
    ]);
    expect((await auditRows(s.fixtureId)).length).toBe(1);
  });

  it("an empty note is refused — an unexplained override is not an audit trail", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await expect(
      organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "   " }),
    ).rejects.toMatchObject({ status: 422, code: "OVERRIDE_NOTE_REQUIRED" });
    expect(await auditRows(s.fixtureId)).toEqual([]);
    expect(await overrideStamp(s.fixtureId)).toBeNull();
  });

  it("a fixture we do not serve is 404, and nothing is written", async () => {
    const s = await seed({ onlinePlay: "off" });
    await expect(
      organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "x" }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await auditRows(s.fixtureId)).toEqual([]);
  });

  // Minor m5 (fix round 1): the override exists for ONE situation — video
  // required and RealtimeKit unavailable on a board still being played.
  it("is refused unless the effective policy is REQUIRED: under off and optional nothing is written — swept and counted", async () => {
    let checked = 0;
    for (const policy of ["off", "optional"] as const) {
      const s = await seed({ cameraPolicy: policy });
      await expect(
        organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" }),
      ).rejects.toMatchObject({ status: 409, code: "VIDEO_NOT_REQUIRED" });
      expect(await auditRows(s.fixtureId), `${policy}: no audit row`).toEqual([]);
      expect(await overrideStamp(s.fixtureId), `${policy}: no stamp`).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: two policies").toBe(2);
  });

  it("is refused on a board that can no longer be played, and nothing is written — swept and counted", async () => {
    let checked = 0;
    for (const status of ["decided", "forfeited", "abandoned"]) {
      const s = await seed({ cameraPolicy: "required" });
      await setFixtureStatus(s, status);
      await expect(
        organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" }),
      ).rejects.toMatchObject({ status: 409, code: "FIXTURE_NOT_PLAYABLE" });
      expect(await auditRows(s.fixtureId), `${status}: no audit row`).toEqual([]);
      expect(await overrideStamp(s.fixtureId), `${status}: no stamp`).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: three settled statuses").toBe(3);
  });

  it("positive pair: accepted when the EFFECTIVE policy is required (the stage's, over an optional division)", async () => {
    const s = await seed({ cameraPolicy: "optional", stageCameraPolicy: "required" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    expect((await auditRows(s.fixtureId)).length).toBe(1);
    expect(await overrideStamp(s.fixtureId)).not.toBeNull();
  });

  // Minor m1 (fix round 1): where the override sits against the window and
  // round checks. It relaxes the camera only.
  it("the override never bypasses the window: a caller never seated is still window_closed after T+20", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    const rtk = fakeRealtimeKit();
    expectInertRefusal(await claim(s, "home", rtk, LATE), "window_closed", rtk);
  });

  it("the override never bypasses fixture_not_playable: a board settled after the override", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    await setFixtureStatus(s, "decided");
    const rtk = fakeRealtimeKit();
    expectInertRefusal(await claim(s, "home", rtk), "fixture_not_playable", rtk);
  });

  it("position pair: on RE-ENTRY after T+20 the override still applies — seated, no tile, no RealtimeKit call", async () => {
    const s = await seed({ cameraPolicy: "required" });
    await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: s.ownerUserId, note: "vendor outage" });
    const rtk = fakeRealtimeKit();
    rtk.failWhen(() => "network");
    // T9's seats, under the override: both seated with no tile.
    for (const sd of ["home", "away"] as const) {
      expect(await claim(s, sd, rtk), `premise: ${sd}`).toEqual({ seated: true, participant: null });
    }
    await recordGame(s); // T9's `ready` record; the board stays scheduled
    expect(await claim(s, "home", rtk, LATE)).toEqual({ seated: true, participant: null });
    expect(rtk.http).toEqual([]);
  });
});

// ─── Property: random orderings of the seat's world ────────────────────────
//
// Actions: open the round, a player joins / leaves the meeting (only with a
// token the server actually issued them), a player claims the seat, the
// organiser DOWNGRADES the policy through the real writer (patchDivision —
// after a round opens, T6's guard allows only relaxing), and — fix round 1 —
// time passes BEYOND T+20, T9 creates the game (it re-verifies BOTH seats
// through seatPlayer and records the game — bridge `ready` — only if both
// pass), T10's first accepted move flips the bridge to `live`, the game ends
// (bridge `finished`, or `needs_organiser`), or a game is on record for OTHER
// accounts. `fixtures.status` is never touched: during a real online game the
// board stays `scheduled` (core.start is T12's, at the result). Every run
// starts under `required` with the round unopened.
//
// The expected result of every claim comes from a MODEL of the rules
// (spec §5.1/§5.2/§3.6, D12, rulings Q1/Q3/I1), never from the code:
//   round not open            ⇒ round_not_open, no token, no RealtimeKit call
//   past T+20, not re-entry   ⇒ window_closed, no token, no RealtimeKit call
//     (re-entry = seated by the create that recorded this game ∧ the game
//      exists ∧ its bridge is `ready` or `live` — ruling I1, (c) as amended
//      in fix round 2)
//   off                       ⇒ seated, no tile, no RealtimeKit call
//   optional                  ⇒ seated with the caller's own tile, publisher never asked
//   required, live now        ⇒ seated with the caller's own tile
//   required, not live now    ⇒ camera_lost if this player was ever verified
//                               live before, else camera_required; own token
// plus the controller's invariants, each counted on its own.

type Side = "home" | "away";
type Act =
  | { kind: "open" }
  | { kind: "join"; side: Side }
  | { kind: "leave"; side: Side }
  | { kind: "seat"; side: Side }
  | { kind: "downgrade" }
  | { kind: "late" }
  | { kind: "create" }
  | { kind: "start" }
  | { kind: "end"; to: "finished" | "needs_organiser" }
  | { kind: "foreign" }
  // Fix round 2: a player's grant goes stale (the pre-amendment grant) or is
  // restored by re-consenting.
  | { kind: "narrow"; side: Side }
  | { kind: "relink"; side: Side };

const side = fc.constantFrom<Side>("home", "away");
const act: fc.Arbitrary<Act> = fc.oneof(
  { arbitrary: fc.constant<Act>({ kind: "open" }), weight: 2 },
  { arbitrary: side.map((x): Act => ({ kind: "join", side: x })), weight: 3 },
  { arbitrary: side.map((x): Act => ({ kind: "leave", side: x })), weight: 2 },
  { arbitrary: side.map((x): Act => ({ kind: "seat", side: x })), weight: 5 },
  { arbitrary: fc.constant<Act>({ kind: "downgrade" }), weight: 2 },
  { arbitrary: fc.constant<Act>({ kind: "late" }), weight: 3 },
  { arbitrary: fc.constant<Act>({ kind: "create" }), weight: 2 },
  { arbitrary: fc.constant<Act>({ kind: "start" }), weight: 1 },
  {
    arbitrary: fc.constantFrom<"finished" | "needs_organiser">("finished", "needs_organiser").map(
      (to): Act => ({ kind: "end", to }),
    ),
    weight: 1,
  },
  { arbitrary: fc.constant<Act>({ kind: "foreign" }), weight: 1 },
  { arbitrary: side.map((x): Act => ({ kind: "narrow", side: x })), weight: 1 },
  { arbitrary: side.map((x): Act => ({ kind: "relink", side: x })), weight: 1 },
);
/** Edge weighting. LIVE: a seated-and-live player, so the lose/re-verify
 *  paths (camera_lost) are reached, not just possible. CREATED+late: T9's game
 *  (bridge `ready`) and T+20 passed, so re-entry on a `ready` bridge is
 *  reached. GAME: the same, flipped `live` by T10's first move; GAME_LEFT:
 *  that, with home's tab gone and T+20 passed, so a re-entering camera
 *  refusal is reached. ENDED: the game over, then T+20 passed, so condition
 *  (c) failing alone is reached. FOREIGN: a game on record for other
 *  accounts, so condition (a) failing alone is reached. Each is a PREFIX: the
 *  random tail can still undo any of it, and every action in it is checked
 *  against the model like any other. */
const LIVE_PREFIX: Act[] = [
  { kind: "open" },
  { kind: "seat", side: "home" },
  { kind: "join", side: "home" },
  { kind: "seat", side: "home" },
];
const CREATED_PREFIX: Act[] = [
  ...LIVE_PREFIX,
  { kind: "seat", side: "away" },
  { kind: "join", side: "away" },
  { kind: "create" },
];
const GAME_PREFIX: Act[] = [...CREATED_PREFIX, { kind: "start" }];
const GAME_LEFT_PREFIX: Act[] = [...GAME_PREFIX, { kind: "leave", side: "home" }, { kind: "late" }];
const ENDED_PREFIX: Act[] = [...GAME_PREFIX, { kind: "end", to: "finished" }, { kind: "late" }];
// Fix round 2: the prefixes whose counter was reached only by the random
// tail now END WITH the claim they exist for — adding two actions to the
// alphabet moved the seeded tails, and a path reached by luck went to zero.
const FOREIGN_PREFIX: Act[] = [{ kind: "open" }, { kind: "foreign" }, { kind: "late" }, { kind: "seat", side: "home" }];
/** Fix round 2: a seated player's grant goes stale after the game, then T+20
 *  passes — the re-entry the grant must refuse. */
const STALE_REENTRY_PREFIX: Act[] = [
  ...GAME_PREFIX, { kind: "narrow", side: "home" }, { kind: "late" }, { kind: "seat", side: "home" },
];
/** Two downgrades reach `off`, then a seat. */
const OFF_PREFIX: Act[] = [{ kind: "open" }, { kind: "downgrade" }, { kind: "downgrade" }, { kind: "seat", side: "home" }];
/** A stale grant refused, re-consented, seated again. */
const RELINK_PREFIX: Act[] = [
  { kind: "open" },
  { kind: "narrow", side: "home" },
  { kind: "seat", side: "home" },
  { kind: "relink", side: "home" },
  { kind: "seat", side: "home" },
];
const prefix = fc.oneof(
  { arbitrary: fc.constant<Act[]>([]), weight: 2 },
  { arbitrary: fc.constant<Act[]>(LIVE_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>([...CREATED_PREFIX, { kind: "late" }, { kind: "seat", side: "home" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>(GAME_PREFIX), weight: 2 },
  { arbitrary: fc.constant<Act[]>(GAME_LEFT_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>(ENDED_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>(FOREIGN_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>(STALE_REENTRY_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>(OFF_PREFIX), weight: 1 },
  { arbitrary: fc.constant<Act[]>(RELINK_PREFIX), weight: 1 },
);
const scenario = fc
  .tuple(prefix, fc.array(act, { minLength: 1, maxLength: 16 }))
  .map(([head, rest]) => [...head, ...rest]);

const LOWER = { required: "optional", optional: "off", off: "off" } as const;

describe.skipIf(!process.env.DATABASE_URL)("property: random orderings of open / join / leave / seat / downgrade / late / create / start / end", () => {
  const totals = {
    runs: 0,
    actions: 0,
    claims: 0,
    roundNotOpen: 0,
    seatedRequiredLive: 0,
    cameraRequired: 0,
    cameraLost: 0,
    seatedOptional: 0,
    seatedOff: 0,
    downgrades: 0,
    joinsApplied: 0,
    leavesApplied: 0,
    gamesCreated: 0,
    gamesForeign: 0,
    starts: 0,
    ends: 0,
    lateClaims: 0,
    // Past T+20 and NOT re-entry, by the first of the three conditions
    // that fails in the model.
    lateNoGame: 0,
    lateForeignGame: 0,
    lateGameOver: 0,
    // Past T+20 and re-entry, by outcome and by the bridge it re-entered on.
    lateReentrySeated: 0,
    lateReentryCameraRefused: 0,
    lateReentryOnReady: 0,
    lateReentryOnLive: 0,
    // The controller's invariants, counted on their own.
    violationsRequiredNotLive: 0,
    violationsBeforeOpen: 0,
    violationsOutsideWindow: 0,
    // Fix round 2: the play grant.
    narrows: 0,
    relinks: 0,
    reconsentRefused: 0,
    lateReentryReconsentRefused: 0,
    violationsSeatedWithoutGrant: 0,
  };

  // CI round 1 (G-1): run as ONE property the 80 orderings needed a 300 s pin, which overrides --testTimeout as
  // surely as an inline one. The same seed now SAMPLES the 80 orderings once, they run in 4 rounds of their own,
  // and the closing test holds the invariants and the per-path counts across every round. Every replay seeds a whole
  // fixture, so there was never any shrinking to lose (endOnFailure); a failure names its sequence in its message.
  const RUNS = 80;
  const ROUNDS = 4;
  const SCENARIOS = fc.sample(scenario, { seed: 20261009, numRuns: RUNS });
  let roundsRun = 0;
  const runScenario = async (acts: Act[]): Promise<void> => {
    totals.runs += 1;
    const s = await seed({ cameraPolicy: "required", roundOpenedAt: undefined });
    const owner = await mintOrgOwnerAuth(s.orgId);
    const rtk = fakeRealtimeKit();
    // The model. Object fields, not locals: they change inside the
    // loop, and a narrowed local would be read stale by the type checker.
    const m: {
      policy: "required" | "optional" | "off";
      roundOpen: boolean;
      late: boolean;
      game: "none" | "players" | "others";
      bridge: "none" | "ready" | "live" | "finished" | "needs_organiser";
    } = { policy: "required", roundOpen: false, late: false, game: "none", bridge: "none" };
    const token: Record<Side, string | null> = { home: null, away: null };
    const pid: Record<Side, string | null> = { home: null, away: null };
    const peers: Record<Side, number> = { home: 0, away: 0 };
    const verified: Record<Side, boolean> = { home: false, away: false };
    const grant: Record<Side, boolean> = { home: true, away: true };

    /** One claim, checked against the model. Returns whether it seated. */
    const check = async (sd: Side, where: string): Promise<boolean> => {
      totals.claims += 1;
      const httpBefore = rtk.http.length;
      const adapterBefore = rtk.adapter.length;
      const got = await claim(s, sd, rtk, m.late ? LATE : NOW);
      const live = peers[sd] > 0;
      const reentry = m.game === "players" && (m.bridge === "ready" || m.bridge === "live");
      const carriesToken = "participant" in got && got.participant !== null;

      // The invariants.
      if (got.seated && !m.roundOpen) totals.violationsBeforeOpen += 1;
      // No override is ever applied here, so EVERY seat under required
      // needs a live player — a null tile is no exemption.
      if (got.seated && m.policy === "required" && !live) totals.violationsRequiredNotLive += 1;
      if (m.late && !reentry && (got.seated || carriesToken)) totals.violationsOutsideWindow += 1;
      if (got.seated && !grant[sd]) totals.violationsSeatedWithoutGrant += 1;

      if (!m.roundOpen) {
        expect(got, where).toEqual({ seated: false, reason: "round_not_open" });
        expect(rtk.http.length, `${where}: no RealtimeKit call`).toBe(httpBefore);
        totals.roundNotOpen += 1;
        return false;
      }
      if (m.late) totals.lateClaims += 1;
      if (m.late && !reentry) {
        expect(got, where).toEqual({ seated: false, reason: "window_closed" });
        expect(rtk.http.length, `${where}: no RealtimeKit call`).toBe(httpBefore);
        if (m.game === "none") totals.lateNoGame += 1;
        else if (m.game === "others") totals.lateForeignGame += 1;
        else totals.lateGameOver += 1;
        return false;
      }
      if (!grant[sd]) {
        // After every check re-linking cannot cure; before any token.
        expect(got, where).toEqual({ seated: false, reason: "lichess_reconsent_required" });
        expect(rtk.http.length, `${where}: no RealtimeKit call`).toBe(httpBefore);
        totals.reconsentRefused += 1;
        if (m.late) totals.lateReentryReconsentRefused += 1;
        return false;
      }
      if (m.late) {
        if (m.bridge === "ready") totals.lateReentryOnReady += 1;
        if (m.bridge === "live") totals.lateReentryOnLive += 1;
      }
      if (m.policy === "off") {
        expect(got, where).toEqual({ seated: true, participant: null });
        expect(rtk.http.length, `${where}: no RealtimeKit call`).toBe(httpBefore);
        totals.seatedOff += 1;
        if (m.late) totals.lateReentrySeated += 1;
        return true;
      }
      const carried = "participant" in got ? got.participant : null;
      expect(carried, `${where}: a token`).not.toBeNull();
      if (pid[sd] === null) pid[sd] = carried!.participantId;
      expect(carried!.participantId, `${where}: the caller's own, single participant`).toBe(pid[sd]);
      const other: Side = sd === "home" ? "away" : "home";
      if (pid[other] !== null) expect(carried!.participantId, `${where}: never the opponent's`).not.toBe(pid[other]);
      token[sd] = carried!.authToken;

      if (m.policy === "optional") {
        expect(got.seated, where).toBe(true);
        expect(rtk.adapter.slice(adapterBefore), `${where}: optional never asks`).not.toContain(
          "hasLiveVideoPublisher",
        );
        totals.seatedOptional += 1;
        if (m.late) totals.lateReentrySeated += 1;
        return true;
      }
      if (live) {
        expect(got.seated, where).toBe(true);
        verified[sd] = true;
        totals.seatedRequiredLive += 1;
        if (m.late) totals.lateReentrySeated += 1;
        return true;
      }
      const want = verified[sd] ? "camera_lost" : "camera_required";
      expect(!got.seated && got.reason, where).toBe(want);
      if (want === "camera_lost") totals.cameraLost += 1;
      else totals.cameraRequired += 1;
      if (m.late) totals.lateReentryCameraRefused += 1;
      return false;
    };

    for (const [i, x] of acts.entries()) {
      totals.actions += 1;
      const where = `${JSON.stringify(acts)} → #${i} ${JSON.stringify(x)}`;
      if (x.kind === "open") {
        if (!m.roundOpen) {
          await sql`
            insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
            values (${s.stageId}, ${s.orgId}, 1, ${OPENED}, ${s.ownerUserId})`;
          m.roundOpen = true;
        }
      } else if (x.kind === "join") {
        if (token[x.side] !== null) {
          rtk.joinWith(token[x.side]!);
          peers[x.side] += 1;
          totals.joinsApplied += 1;
        }
      } else if (x.kind === "leave") {
        if (peers[x.side] > 0) {
          rtk.leave(pid[x.side]!);
          peers[x.side] -= 1;
          totals.leavesApplied += 1;
        }
      } else if (x.kind === "downgrade") {
        if (m.policy !== "off") {
          m.policy = LOWER[m.policy];
          await patchDivision(owner, s.divisionId, { camera_policy: m.policy });
          totals.downgrades += 1;
        }
      } else if (x.kind === "late") {
        m.late = true;
      } else if (x.kind === "create") {
        // T9: a game already on record is `already`; otherwise BOTH
        // seats are re-verified through seatPlayer, and the game is
        // recorded for the two accounts only if both pass.
        if (m.game === "none") {
          const home = await check("home", `${where} (T9 seats home)`);
          const away = await check("away", `${where} (T9 seats away)`);
          if (home && away) {
            await recordGame(s, { status: "ready" });
            m.game = "players";
            m.bridge = "ready";
            totals.gamesCreated += 1;
          }
        }
      } else if (x.kind === "start") {
        // T10: the first accepted move flips a `ready` bridge to `live`.
        if (m.bridge === "ready") {
          await setBridgeStatus(s, "live");
          m.bridge = "live";
          totals.starts += 1;
        }
      } else if (x.kind === "end") {
        // The game is over, or handed to the organiser — the board
        // itself stays `scheduled` until T12 writes a result.
        if (m.bridge === "ready" || m.bridge === "live") {
          await setBridgeStatus(s, x.to);
          m.bridge = x.to;
          totals.ends += 1;
        }
      } else if (x.kind === "narrow") {
        if (grant[x.side]) {
          await narrowGrant(s[x.side].userId);
          grant[x.side] = false;
          totals.narrows += 1;
        }
      } else if (x.kind === "relink") {
        if (!grant[x.side]) {
          await restoreGrant(s[x.side].userId);
          grant[x.side] = true;
          totals.relinks += 1;
        }
      } else if (x.kind === "foreign") {
        if (m.game === "none") {
          await recordGame(s, { status: "ready", white: `other-w-${RUN}`, black: `other-b-${RUN}` });
          m.game = "others";
          m.bridge = "ready";
          totals.gamesForeign += 1;
        }
      } else {
        await check(x.side, where);
      }
    }
    expect(await fixtureStatus(s), `${JSON.stringify(acts)}: the board was never started by the test`).toBe(
      "scheduled",
    );
    // Per run: one stored player participant per side that ever claimed.
    const rows = await participantRows(s.fixtureId);
    for (const sd of ["home", "away"] as const) {
      const mine = rows.filter((r) => r.person_id === s[sd].personId);
      expect(mine.length, `${JSON.stringify(acts)}: ${sd} participants`).toBe(pid[sd] === null ? 0 : 1);
    }
  };
  for (let k = 0; k < ROUNDS; k++) {
    const chunk = SCENARIOS.slice((k * RUNS) / ROUNDS, ((k + 1) * RUNS) / ROUNDS);
    it(`round ${k + 1} of ${ROUNDS}: 20 orderings, every claim checked against the model`, async () => {
      let mine = 0;
      for (const acts of chunk) {
        await runScenario(acts);
        mine++;
      }
      expect(mine, "anti-vacuity: this round's runs").toBe(RUNS / ROUNDS);
      roundsRun++;
    });
  }
  it(`nobody is seated under required without being live, nor before the round opens, nor past T+20 except by re-entry — and every claim matches the model — across every round`, () => {
    expect(roundsRun, "anti-vacuity: rounds run").toBe(ROUNDS);

    console.log(`PROPERTY_COUNTS ${JSON.stringify(totals)}`);
    expect(totals.violationsBeforeOpen, "INVARIANT: nobody seated before the round opens").toBe(0);
    expect(totals.violationsRequiredNotLive, "INVARIANT: nobody seated under required without being live").toBe(0);
    expect(
      totals.violationsOutsideWindow,
      "INVARIANT: no token and no seat past T+20 except re-entry under exactly the three conditions",
    ).toBe(0);
    // Anti-vacuity: zero checked is a failure, per path the property is named for.
    expect(totals.runs, "runs").toBe(RUNS);
    expect(totals.claims, "claims").toBeGreaterThan(0);
    expect(totals.roundNotOpen, "claims before the round opened").toBeGreaterThan(0);
    expect(totals.seatedRequiredLive, "seats under required with a live player").toBeGreaterThan(0);
    expect(totals.cameraRequired, "camera_required refusals").toBeGreaterThan(0);
    expect(totals.cameraLost, "camera_lost refusals").toBeGreaterThan(0);
    expect(totals.seatedOptional, "seats after a downgrade to optional").toBeGreaterThan(0);
    expect(totals.seatedOff, "seats after a downgrade to off").toBeGreaterThan(0);
    expect(totals.leavesApplied, "leaves").toBeGreaterThan(0);
    expect(totals.gamesCreated, "games T9 created").toBeGreaterThan(0);
    expect(totals.lateClaims, "claims past T+20").toBeGreaterThan(0);
    expect(totals.lateNoGame, "past T+20, no game").toBeGreaterThan(0);
    expect(totals.lateForeignGame, "past T+20, a game for other accounts").toBeGreaterThan(0);
    expect(totals.lateGameOver, "past T+20, the game over (finished / needs_organiser)").toBeGreaterThan(0);
    expect(totals.lateReentrySeated, "re-entry past T+20, seated").toBeGreaterThan(0);
    expect(totals.lateReentryCameraRefused, "re-entry past T+20, a camera refusal with a token").toBeGreaterThan(0);
    expect(totals.lateReentryOnReady, "re-entry on a `ready` bridge").toBeGreaterThan(0);
    expect(totals.lateReentryOnLive, "re-entry on a `live` bridge").toBeGreaterThan(0);
    expect(totals.violationsSeatedWithoutGrant, "INVARIANT: nobody seated without the full grant").toBe(0);
    expect(totals.narrows, "grants gone stale").toBeGreaterThan(0);
    expect(totals.relinks, "grants restored").toBeGreaterThan(0);
    expect(totals.reconsentRefused, "re-consent refusals").toBeGreaterThan(0);
    expect(totals.lateReentryReconsentRefused, "re-entry past T+20 refused on a stale grant").toBeGreaterThan(0);
  });
});
