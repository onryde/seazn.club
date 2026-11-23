// Seazn-hosted Task 25b, chess follow-up: the seam end to end for the `chess-room` kind. A connection drop made by the camera room's REAL
// producers (the player's loader `makeJoinOwnCamera` and the arbiter's `makeJoinArbiter`, each over the SDK port, through the ONE
// `watchRoomDrops` they share), sent by the REAL beacon (a recording `navigator.sendBeacon`: its URL and its text/plain string body),
// POSTed to the REAL route, through the REAL pipeline over a REAL database whose boards have REAL `fixture_video_meetings` rows (a
// meeting per player, D16) and a real bridge (`fixture_external_play.white_side`) — so the kind's subject lookup (its SQL) is run, not
// stubbed, and what it matches is the meeting of the side the report NAMES (a colour through the bridge), live or not. What comes out is the server's log line and its Sentry warning. Only Sentry's
// capture and Redis's windowed INCR are stand-ins (and the browser Sentry facade, which a drop must NOT reach).
// ONE SPORT, on purpose: a camera room is online chess (`boardgame`); nothing here reads a sport rule.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => new Map<string, number>());
// Redis stands in as CONFIGURED and answering, whatever the job's REDIS_URL: the windowed INCR on this map, DEL on the same map.
vi.mock("@/lib/cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string) => {
    const next = (counter.get(key) ?? 0) + 1;
    counter.set(key, next);
    return { count: next, ttlMs: 60_000 };
  },
  cacheDel: async (...keys: string[]) => {
    for (const key of keys) counter.delete(key);
  },
}));
const sentry = vi.hoisted(() => ({ messages: [] as { message: string; context: unknown }[] }));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureMessage: (message: string, context: unknown) => void sentry.messages.push({ message, context }),
}));
const browserSentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/sentry-browser", () => browserSentry);

import pino from "pino";
import { incrWindow } from "@/lib/cache";
import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";
import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { makeJoinArbiter } from "@/components/v2/match-day/online/arbiter-camera";
import { makeJoinOwnCamera } from "@/components/public-site/match-room/camera-loader";
import { fakeRealtimeKit, type FakeMeeting } from "@/components/public-site/match-room/__tests__/_fake-realtimekit";
import { log } from "@/server/logger";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const PLAYER_TOKEN = "own-rtk-token-secret-Zq81";
const ARBITER_TOKEN = "arb-rtk-token-secret-Yp72";
const OPP = { peer: "opp-peer", user: "rtk-opponent" };
const WHITE = { peer: "w-peer", user: "rtk-white" };
/** Every thing that must never reach a log line, an event or a beacon. */
const FORBIDDEN = [PLAYER_TOKEN, ARBITER_TOKEN, OPP.user, WHITE.user, "rtk-arbiter", "self-user", "token", "expires", "://", "?"];

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const camera = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-cam`, kind: "video", screenShare: false });

describe.skipIf(!HAS_DB)("a camera room's drop, from the loader's own roomLeft to the server's log line and Sentry warning", () => {
  /** One side's meeting row on a seeded board: null = none; `endedAgo` null = live, else ended that long ago (a Postgres interval). */
  type Room = { endedAgo: string | null } | null;
  const LIVE: Room = { endedAgo: null };
  const ENDED_LONG_AGO: Room = { endedAgo: "2 hours" };
  const ENDED_JUST_NOW: Room = { endedAgo: "5 minutes" };
  /** Seeds an online board with the given meeting rows and, unless `whiteSide` is null (no game has fixed the colours), its bridge naming
   *  the side that plays White. A fixture's id is public, so only a LIVE room of the NAMED side counts (chess-room.ts). */
  async function seedBoard(rooms: { home: Room; away: Room }, whiteSide: "home" | "away" | null): Promise<string> {
    const { fixtureId } = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date(Date.now() + 3_600_000) });
    for (const side of ["home", "away"] as const) {
      const room = rooms[side];
      if (room === null) continue;
      const endedAgo = room.endedAgo;
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
        select id, ${side}, org_id, ${`cr-seam-${side}-${fixtureId}`}, home_entrant_id, away_entrant_id,
               case when ${endedAgo}::text is null then null else now() - (${endedAgo}::text)::interval end
        from fixtures where id = ${fixtureId}`;
    }
    if (whiteSide !== null) {
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, white_side)
        select id, org_id, now(), ${whiteSide} from fixtures where id = ${fixtureId}
        on conflict (fixture_id) do update set white_side = ${whiteSide}`;
    }
    return fixtureId;
  }
  /** The boards: a live room on both sides (White is home), no room at all, a room that ended long ago, one that ended minutes ago,
   *  only HOME's room live, the colours swapped (White is AWAY, and only away's room is live), and a game not made yet (no bridge). */
  const board = { withRoom: "", noRoom: "", endedLongAgo: "", endedJustNow: "", homeOnly: "", swapped: "", noGame: "" };
  beforeAll(async () => {
    board.withRoom = await seedBoard({ home: LIVE, away: LIVE }, "home");
    board.noRoom = await seedBoard({ home: null, away: null }, "home");
    board.endedLongAgo = await seedBoard({ home: ENDED_LONG_AGO, away: ENDED_LONG_AGO }, "home");
    board.endedJustNow = await seedBoard({ home: ENDED_JUST_NOW, away: ENDED_JUST_NOW }, "home");
    board.homeOnly = await seedBoard({ home: LIVE, away: ENDED_LONG_AGO }, "home");
    board.swapped = await seedBoard({ home: ENDED_LONG_AGO, away: LIVE }, "away");
    board.noGame = await seedBoard({ home: LIVE, away: LIVE }, null);
    const rows = async (id: string) =>
      (await sql<{ side: string; live: boolean }[]>`
        select side, (ended_at is null) as live from fixture_video_meetings where fixture_id = ${id} order by side`).map((r) => `${r.side}:${r.live ? "live" : "ended"}`);
    const white = async (id: string) => (await sql<{ white_side: string | null }[]>`select white_side from fixture_external_play where fixture_id = ${id}`)[0]?.white_side ?? null;
    expect(await rows(board.withRoom), "PREMISE: a live room on both sides").toEqual(["away:live", "home:live"]);
    expect(await rows(board.noRoom), "PREMISE: no room").toEqual([]);
    expect(await rows(board.endedLongAgo), "PREMISE: both ended").toEqual(["away:ended", "home:ended"]);
    expect(await rows(board.endedJustNow), "PREMISE: both ended").toEqual(["away:ended", "home:ended"]);
    expect(await rows(board.homeOnly), "PREMISE: only home's room is live").toEqual(["away:ended", "home:live"]);
    expect([await rows(board.swapped), await white(board.swapped)], "PREMISE: only away's room is live, and away is White").toEqual([["away:live", "home:ended"], "away"]);
    expect([await rows(board.noGame), await white(board.noGame)], "PREMISE: live rooms, no game has fixed the colours").toEqual([["away:live", "home:live"], null]);
    expect(await white(board.withRoom), "PREMISE: White is home").toBe("home");
  });

  let warn: ReturnType<typeof vi.spyOn>;
  const beacons: { url: string; body: string }[] = [];
  /** What the pipeline wrote into the logger's own destination outside pino's serialiser (its server-log-only lines). */
  const serverOnly: string[] = [];
  // The logger's level, pinned per test and restored: CI's smoke jobs run with LOG_LEVEL=error (ci.yml), under which pino's warn and
  // the pipeline's server-log-only line are both silent, and these tests are about what a WARN line does. Set BEFORE any spy on `log`
  // (pino's level setter reassigns the level methods, which would replace a spy), restored AFTER the spies are.
  let ambientLevel = "";
  beforeEach(() => {
    ambientLevel = log.level;
    log.level = "info";
    counter.clear();
    sentry.messages.length = 0;
    beacons.length = 0;
    browserSentry.captureMessage.mockClear();
    __setRateLimitCounterForTests((key, windowSeconds) => incrWindow(key, windowSeconds));
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => (beacons.push({ url, body }), true) });
    warn = vi.spyOn(log, "warn");
    serverOnly.length = 0;
    const destination = (log as unknown as Record<symbol, { write: (s: string) => boolean }>)[pino.symbols.streamSym]!;
    vi.spyOn(destination, "write").mockImplementation((chunk: string) => (serverOnly.push(String(chunk)), true));
  });
  afterEach(() => {
    __setRateLimitCounterForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    log.level = ambientLevel;
  });

  /** Each recorded beacon, POSTed to the route as the browser sends it: its URL, a text/plain string, the viewer's IP. */
  const deliver = async (ip = "203.0.113.91") => {
    const statuses: number[] = [];
    for (const { url, body } of beacons.splice(0)) {
      const res = await POST(new Request(`http://app.test${url}`, {
        method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": ip },
      }));
      statuses.push(res.status);
    }
    return statuses;
  };
  const own = () => warn.mock.calls.filter((c: unknown[]) => c[1] === "realtimekit: room dropped");
  const repeats = () => serverOnly.filter((l) => l.includes('"msg":"realtimekit: room dropped"') && l.includes('"clientReportSentry":"repeat"'));

  /** The player's camera, joined through its REAL loader for `fixtureId`. */
  async function joinPlayer(fixtureId: string, colour: "white" | "black" = "white"): Promise<FakeMeeting> {
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)) });
    await makeJoinOwnCamera(rtk.load, () => undefined)(PLAYER_TOKEN, { fixtureId, side: colour });
    await settle();
    return rtk.meetings[0]!;
  }
  /** The arbiter's camera on the same board, through ITS real loader. */
  async function joinArbiter(fixtureId: string, side: "home" | "away" = "home"): Promise<FakeMeeting> {
    const rtk = fakeRealtimeKit({
      presetMaxVideoStreams: 2,
      selfUserId: "rtk-arbiter",
      setup: (m) => (m.peerJoins(WHITE.peer, WHITE.user), camera(m, WHITE.peer)),
    });
    await makeJoinArbiter(rtk.load, () => undefined)({ authToken: ARBITER_TOKEN, players: [WHITE.user], fixtureId, side });
    await settle();
    return rtk.meetings[0]!;
  }

  it("EMPTY CASE FIRST: the join itself reports nothing; a drop on a board with NO camera room is answered 204 and logged, sent and counted as nothing", async () => {
    const m = await joinPlayer(board.noRoom);
    expect(beacons, "the join is no drop").toEqual([]);
    m.dropSocket();
    expect(beacons, "the drop was beaconed").toHaveLength(1);
    expect(await deliver()).toEqual([204]);
    expect(own(), "no line").toEqual([]);
    expect(serverOnly, "no server-log line either").toEqual([]);
    expect(sentry.messages, "no event").toEqual([]);
    expect(browserSentry.captureMessage, "and not through the browser Sentry").not.toHaveBeenCalled();
  });

  it("a room that ENDED LONG AGO is dropped without a word - a fixture's id is public, so an old board can be neither forged against nor have a dedupe slot taken", async () => {
    const m = await joinPlayer(board.endedLongAgo);
    m.dropSocket();
    expect(beacons, "the drop was beaconed (the client cannot know the room is over)").toHaveLength(1);
    expect(await deliver()).toEqual([204]);
    expect(own(), "no line").toEqual([]);
    expect(serverOnly, "no server-log line either").toEqual([]);
    expect(sentry.messages, "no event").toEqual([]);
    expect([...counter.keys()].filter((k) => k.startsWith("client-report-sentry")), "no dedupe slot was taken").toEqual([]);
    // The pair that makes the above mean something: a drop on a LIVE board, answered by the same pipeline in the same test, is sent.
    (await joinPlayer(board.withRoom)).dropSocket();
    expect(await deliver()).toEqual([204]);
    expect(sentry.messages, "the live board's drop reached Sentry").toHaveLength(1);
  });

  it("a room that ended only minutes ago still counts: the result's own teardown races the client's last event", async () => {
    const m = await joinPlayer(board.endedJustNow);
    m.dropSocket();
    expect(await deliver()).toEqual([204]);
    expect(own().map((c: unknown[]) => (c[0] as { fixtureId: string }).fixtureId)).toEqual([board.endedJustNow]);
    expect(sentry.messages).toHaveLength(1);
  });

  it("the meeting of the side a report NAMES decides: with only home's room live, the arbiter's home drop and White's (home) drop count, the arbiter's away drop and Black's (away) do not", async () => {
    const drops: [string, () => Promise<FakeMeeting>][] = [
      ["arbiter home", () => joinArbiter(board.homeOnly, "home")],
      ["arbiter away", () => joinArbiter(board.homeOnly, "away")],
      ["player white", () => joinPlayer(board.homeOnly, "white")],
      ["player black", () => joinPlayer(board.homeOnly, "black")],
    ];
    const answered: string[] = [];
    for (const [name, join] of drops) {
      (await join()).dropSocket();
      expect(await deliver(), name).toEqual([204]);
      answered.push(`${name}:${sentry.messages.length}`);
    }
    // Cumulative Sentry events after each drop: counted, refused, counted, refused.
    expect(answered).toEqual(["arbiter home:1", "arbiter away:1", "player white:2", "player black:2"]);
    expect(sentry.messages.map((e) => (e.context as { tags: Record<string, string> }).tags).map((t) => [t.surface, t.side])).toEqual([["arbiter", "home"], ["player", "white"]]);
    expect(own().map((c: unknown[]) => (c[0] as { side: string }).side), "and only those two left a line").toEqual(["home", "white"]);
    expect([...counter.keys()].filter((k) => k.startsWith("client-report-sentry:") && k.includes(":away:")), "the refused drops took no dedupe slot").toEqual([]);
  });

  it("a colour is read through the bridge's White side: with White on away and only away's room live, White's drop counts and Black's (home, ended) does not; with no game made, a colour names no meeting", async () => {
    (await joinPlayer(board.swapped, "white")).dropSocket();
    expect(await deliver()).toEqual([204]);
    expect(own().map((c: unknown[]) => (c[0] as { side: string }).side), "White -> away's live room").toEqual(["white"]);
    (await joinPlayer(board.swapped, "black")).dropSocket();
    expect(await deliver()).toEqual([204]);
    expect(sentry.messages, "Black -> home's ended room: refused").toHaveLength(1);
    // No bridge: neither colour names a meeting; the arbiter's own meeting side still does (the pair that proves the board is live).
    (await joinPlayer(board.noGame, "white")).dropSocket();
    (await joinPlayer(board.noGame, "black")).dropSocket();
    expect(await deliver("198.51.100.77")).toEqual([204, 204]);
    expect(sentry.messages, "no game, no colour").toHaveLength(1);
    (await joinArbiter(board.noGame, "home")).dropSocket();
    expect(await deliver("198.51.100.78")).toEqual([204]);
    expect(sentry.messages.map((e) => (e.context as { tags: Record<string, string> }).tags).map((t) => [t.surface, t.side])).toEqual([["player", "white"], ["arbiter", "home"]]);
  });

  it("the player's socket drop on a board WITH a room: one line and one warning, codes only; the flapping line's repeat is a server-log line only", async () => {
    const m = await joinPlayer(board.withRoom);
    m.dropSocket();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe(CLIENT_REPORTS_PATH);
    expect(await deliver()).toEqual([204]);
    const fields = { fixtureId: board.withRoom, surface: "player", side: "white", leaveState: "disconnected" };
    expect(own().map((c: unknown[]) => c[0])).toEqual([{ clientReport: "chess-room", ...fields }]);
    expect(sentry.messages.map((e) => [e.message, (e.context as { level: string }).level])).toEqual([["realtimekit: room dropped", "warning"]]);
    expect((sentry.messages[0]!.context as { tags: Record<string, string> }).tags).toEqual({
      client_report: "chess-room", area: "realtimekit", event: "room_dropped", surface: "player", leave_state: "disconnected", fixture_id: board.withRoom, side: "white",
    });
    // The same line flaps again (a second socket drop, the same state): a repeat, never a second event.
    m.dropSocket();
    expect(await deliver("198.51.100.92")).toEqual([204]);
    expect(sentry.messages, "still one event").toHaveLength(1);
    expect(repeats(), "the repeat is a line on the server log").toHaveLength(1);
    let checked = 0;
    for (const bit of FORBIDDEN) {
      expect(JSON.stringify([own(), sentry.messages, serverOnly]).includes(bit), `"${bit}" reached a log line or the event`).toBe(false);
      checked++;
    }
    expect(checked).toBe(FORBIDDEN.length);
    expect(browserSentry.captureMessage, "nothing through the browser Sentry").not.toHaveBeenCalled();
  });

  it("the arbiter's drop on the same board is its OWN event (a second join), and the SDK giving up is another: three events in all", async () => {
    const player = await joinPlayer(board.withRoom);
    const arbiter = await joinArbiter(board.withRoom);
    player.dropSocket();
    arbiter.dropSocket();
    arbiter.self.emit("roomLeft", { state: "failed" });
    expect(beacons, "three drops, three beacons").toHaveLength(3);
    expect(await deliver()).toEqual([204, 204, 204]);
    expect(sentry.messages.map((e) => (e.context as { tags: Record<string, string> }).tags)
      .map((t) => [t.surface, t.side, t.leave_state])).toEqual([
      ["player", "white", "disconnected"], ["arbiter", "home", "disconnected"], ["arbiter", "home", "failed"],
    ]);
    expect(own(), "each a Sentry-forwarded line").toHaveLength(3);
    expect(browserSentry.captureMessage).not.toHaveBeenCalled();
  });

  it("a planned leave (kicked, ended) and our own leave reach nothing: no beacon, so no line and no event", async () => {
    const m = await joinPlayer(board.withRoom);
    expect(m.calls, "PREMISE: joined (the second test shows a drop of this same room IS beaconed)").toContain("join");
    m.self.emit("roomLeft", { state: "kicked" });
    m.self.emit("roomLeft", { state: "ended" });
    expect(beacons).toEqual([]);
    expect(await deliver()).toEqual([]);
    expect([own().length, sentry.messages.length]).toEqual([0, 0]);
  });
});
