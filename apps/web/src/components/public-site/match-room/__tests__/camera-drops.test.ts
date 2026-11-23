// Connection drops (owner 2026-11-22: "we have logger and sentry"; owner 2026-11-23: through OUR server, not the browser's Sentry):
// every RealtimeKit `roomLeft` that is NOT our own leave is ONE `chess-room` client report, beaconed to the shared route
// (lib/client-report-beacon.ts -> POST /api/v1/public/client-reports) with the surface, the fixture, the side and the SDK's own leave
// state; the next `roomJoined` leaves a browser breadcrumb, "realtimekit: room rejoined", carrying the gap; the SDK's socket and media
// connection updates are breadcrumbs. Swept over BOTH surfaces that join a meeting - the player's camera (camera-loader.ts) and the
// arbiter's (arbiter-camera.ts) - driven through their REAL loaders over the SDK port (_fake-realtimekit.ts). The SDK facts the
// expected values come from are the 2.0.2 typings and source: `roomLeft` carries `{ state: LeaveRoomState }`, `roomJoined` carries
// `{ reconnected }` (index.d.ts l.2358-2363), a socket drop emits roomLeft "disconnected" (index.es.js l.24413-24423) and the client's
// own leave() emits roomLeft "left" (l.24497-24500).
//
// What these tests prove is what the loaders HAND OUT. A drop: a recording `navigator.sendBeacon` (its URL and its text/plain string
// body), every body parsed by the ROUTE'S OWN schema (`ClientReport`, server/client-reports), so a body the route would refuse fails here
// and not silently in a browser (a beacon reads no answer). And it is sent ONCE: nothing of a drop goes to lib/sentry-browser.ts as well
// (its captureMessage is a recording mock that must stay silent). What is NOT a drop stays a breadcrumb through that facade: it loads the
// SDK lazily, only with a DSN and the visitor's analytics consent, queues a call while it loads and drops it otherwise (proven in
// lib/__tests__/sentry-browser-init.test.ts).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/sentry-browser", () => sentry);

import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";
import { ClientReport } from "@/server/client-reports/kinds";
import { makeJoinOwnCamera, roomDropReport } from "../camera-loader";
import { makeJoinArbiter } from "@/components/v2/match-day/online/arbiter-camera";
import { fakeRealtimeKit, type FakeMeeting } from "./_fake-realtimekit";

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const camera = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-cam`, kind: "video", screenShare: false });

const PLAYER_FIXTURE = "6f1d2c3b-4a59-4e8f-9a01-b2c3d4e5f601";
const ARBITER_FIXTURE = "7a2e3d4c-5b6a-4f90-8b12-c3d4e5f6a702";
const OPP = { peer: "opp-peer", user: "rtk-opponent" };
const WHITE = { peer: "w-peer", user: "rtk-white" };
const PLAYER_TOKEN = "own-rtk-token-secret";
const ARBITER_TOKEN = "arb-rtk-token-secret";

type Joined = { m: FakeMeeting; leave(): Promise<void> };
type Surface = {
  surface: "player" | "arbiter";
  fixtureId: string;
  side: string;
  join(): Promise<Joined>;
  /** Drives the guard into failing closed - ITS leave, which is ours. */
  failClosed(j: Joined): Promise<void>;
};

const SURFACES: Surface[] = [
  {
    surface: "player",
    fixtureId: PLAYER_FIXTURE,
    side: "white",
    async join() {
      const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)) });
      const cam = await makeJoinOwnCamera(rtk.load, () => undefined)(PLAYER_TOKEN, { fixtureId: PLAYER_FIXTURE, side: "white" });
      await settle();
      return { m: rtk.meetings[0]!, leave: () => cam.leave() };
    },
    async failClosed({ m }) {
      m.failNext.unsubscribe = 1_000;
      await m.participants.subscribe([OPP.peer], ["video", "audio"]);
      await settle();
    },
  },
  {
    surface: "arbiter",
    fixtureId: ARBITER_FIXTURE,
    side: "home",
    async join() {
      const rtk = fakeRealtimeKit({
        presetMaxVideoStreams: 2,
        selfUserId: "rtk-arbiter",
        setup: (m) => (m.peerJoins(WHITE.peer, WHITE.user), camera(m, WHITE.peer)),
      });
      const cams = await makeJoinArbiter(rtk.load, () => undefined)({
        authToken: ARBITER_TOKEN,
        players: [WHITE.user],
        fixtureId: ARBITER_FIXTURE,
        side: "home",
      });
      await settle();
      return { m: rtk.meetings[0]!, leave: () => cams.leave() };
    },
    async failClosed({ m }) {
      m.failNext.unsubscribe = 1_000;
      await m.participants.subscribe([WHITE.peer], ["audio"]);
      await settle();
    },
  },
];

let clock = 0;
/** Every beacon the page sent: the URL and the string body, as `navigator.sendBeacon` was handed them. */
const beacons: { url: string; body: string }[] = [];
beforeEach(() => {
  sentry.captureMessage.mockClear();
  sentry.addBreadcrumb.mockClear();
  sentry.captureException.mockClear();
  beacons.length = 0;
  vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => (beacons.push({ url, body }), true) });
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What a `chess-room` report holds: the one body the route takes for a drop. */
type Drop = { kind: "chess-room"; fixtureId: string; surface: string; side: string | null; leaveState: string };
/** The drops sent, each as the ROUTE parses it (`ClientReport`: a body its closed schema refuses throws here), all to the route's path. */
const drops = (): Drop[] =>
  beacons.map((b) => {
    expect(b.url, "every beacon goes to the client-report route").toBe(CLIENT_REPORTS_PATH);
    return ClientReport.parse(JSON.parse(b.body)) as Drop;
  });
/** The browser Sentry facade's `captureMessage` calls: a drop must never be one. */
const sentDropsToBrowserSentry = () => sentry.captureMessage.mock.calls;
const crumbs = (message: string) =>
  sentry.addBreadcrumb.mock.calls.map((c) => c[0] as { message: string; data: Record<string, unknown> }).filter((b) => b.message === message);
const clearSent = () => {
  sentry.captureMessage.mockClear();
  sentry.addBreadcrumb.mockClear();
  beacons.length = 0;
};

describe("realtimekit drops: a `chess-room` report per unplanned roomLeft, a breadcrumb per rejoin (both surfaces) - the report to our server's route, the breadcrumb to the browser Sentry client", () => {
  it("the join's own roomJoined is no rejoin: nothing reported (the empty case)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      expect(m.calls, `${s.surface}: premise, joined`).toContain("join");
      expect(drops(), s.surface).toEqual([]);
      expect(beacons, `${s.surface}: no beacon of any kind`).toEqual([]);
      expect(crumbs("realtimekit: room rejoined"), s.surface).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("a socket drop is ONE report naming surface/fixture/side/leave state; the rejoin is a breadcrumb with the gap; a second cycle repeats both with its OWN gap", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      clock = 2_000_000;
      m.dropSocket();
      expect(drops(), `${s.surface}: one report`).toEqual([
        { kind: "chess-room", fixtureId: s.fixtureId, surface: s.surface, side: s.side, leaveState: "disconnected" },
      ]);
      clock = 2_003_500;
      m.self.emit("roomJoined", { reconnected: true });
      await settle();
      const back = crumbs("realtimekit: room rejoined");
      expect(back, s.surface).toHaveLength(1);
      expect(back[0]).toMatchObject({
        category: "realtimekit",
        level: "info",
        data: { surface: s.surface, fixtureId: s.fixtureId, side: s.side, gapMs: 3_500, reconnected: true },
      });
      expect(drops(), `${s.surface}: a rejoin is no drop`).toHaveLength(1);
      // A second cycle: its own report, and a gap measured from ITS drop, not the first one.
      clock = 3_000_000;
      m.self.emit("roomLeft", { state: "failed" });
      clock = 3_000_250;
      m.self.emit("roomJoined", { reconnected: false });
      await settle();
      expect(drops().map((d) => d.leaveState), s.surface).toEqual(["disconnected", "failed"]);
      expect(crumbs("realtimekit: room rejoined").map((b) => b.data.gapMs), s.surface).toEqual([3_500, 250]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("a drop is sent ONCE: to the beacon, and never to the browser Sentry too (a visitor who accepted analytics would report it twice)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      m.dropSocket();
      m.self.emit("roomLeft", { state: "failed" });
      await settle();
      expect(drops(), `${s.surface}: one report per drop`).toHaveLength(2);
      expect(sentDropsToBrowserSentry(), `${s.surface}: nothing through lib/sentry-browser.ts's captureMessage`).toEqual([]);
      expect(sentry.captureException, `${s.surface}: nor a captured exception`).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("two roomLefts before one rejoin (disconnected, then failed): two reports, ONE breadcrumb timed from the first", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      clock = 5_000_000;
      m.self.emit("roomLeft", { state: "disconnected" });
      clock = 5_001_000;
      m.self.emit("roomLeft", { state: "failed" });
      clock = 5_009_000;
      m.self.emit("roomJoined", { reconnected: false });
      await settle();
      expect(drops(), s.surface).toHaveLength(2);
      expect(crumbs("realtimekit: room rejoined").map((b) => b.data.gapMs), s.surface).toEqual([9_000]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("the real reconnect sequence (socket down, back up, roomJoined): one report, one rejoin breadcrumb, socket updates as breadcrumbs", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      await m.reconnect();
      await settle();
      expect(drops(), s.surface).toHaveLength(1);
      expect(crumbs("realtimekit: room rejoined"), s.surface).toHaveLength(1);
      expect(crumbs("realtimekit: socket connection").map((b) => b.data), s.surface).toEqual([
        { surface: s.surface, state: "disconnected", reconnected: false, reconnectionAttempt: 0 },
        { surface: s.surface, state: "connected", reconnected: true, reconnectionAttempt: undefined },
      ]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("a media transport update is a breadcrumb naming the transport and its state - and no report", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const { m } = await s.join();
      m.meta.emit("mediaConnectionUpdate", { transport: "recv", state: "disconnected", sfuSessionId: "sfu-1" });
      expect(crumbs("realtimekit: media connection").map((b) => b.data), s.surface).toEqual([
        { surface: s.surface, transport: "recv", state: "disconnected" },
      ]);
      expect(beacons, `${s.surface}: a transport update is no drop`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("OUR leave (the owner's leave()) is never a drop; a roomLeft 'left' we did not ask for still is (it is the flag, not the state)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const j = await s.join();
      // Positive pair: the SDK leaving on its own with state "left" (its picture-in-picture hang-up) is reported.
      j.m.self.emit("roomLeft", { state: "left" });
      expect(drops(), `${s.surface}: a leave we did not make`).toHaveLength(1);
      await j.leave();
      expect(j.m.calls, `${s.surface}: premise, the meeting was left`).toContain("leave");
      expect(drops(), `${s.surface}: our own leave adds nothing`).toHaveLength(1);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("the guard failing closed (ITS leave) is never a drop - it is reported as the guard's own fault already", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      clearSent();
      const j = await s.join();
      await s.failClosed(j);
      expect(j.m.calls.filter((c) => c === "leave"), `${s.surface}: premise, the guard left`).toHaveLength(1);
      expect(drops(), s.surface).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("only a lost connection is a drop: kicked/ended (our server's doing) and every other planned leave state is a breadcrumb, never a report - swept over the SDK's own LeaveRoomState", async () => {
    // The states, read from the SDK's declaration (realtimekit 2.0.2 index.d.ts), not typed here: a state a later SDK adds
    // lands in this sweep and is judged by the rule below. The rule (review m1): a socket/media drop ("disconnected"), the SDK
    // giving up ("failed") and the SDK leaving on its own ("left", unflagged) are drops; "kicked" (the arbiter revocation
    // removes a participant) and "ended" (the teardown and the retire end the meeting) are OUR server's, and the rest
    // ("rejected", "connected-meeting", "stageLeft") lose no connection.
    const dts = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@cloudflare/realtimekit")), "index.d.ts"), "utf8");
    const union = /type LeaveRoomState = ([^;]+);/.exec(dts)?.[1] ?? "";
    const states = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(states.length, "anti-vacuity: the SDK's LeaveRoomState was read").toBe(8);
    const DROPS = new Set(["disconnected", "failed", "left"]);
    expect(states.filter((x) => DROPS.has(x)).sort(), "premise: every drop state is one the SDK declares").toEqual([...DROPS].sort());
    let checked = 0;
    for (const s of SURFACES) {
      for (const state of states) {
        clearSent();
        const { m } = await s.join();
        m.self.emit("roomLeft", { state });
        m.self.emit("roomJoined", { reconnected: true });
        await settle();
        const label = `${s.surface} ${state}`;
        if (DROPS.has(state)) {
          expect(drops().map((d) => d.leaveState), label).toEqual([state]);
          expect(crumbs("realtimekit: room left"), label).toEqual([]);
          expect(crumbs("realtimekit: room rejoined"), `${label}: a drop's rejoin`).toHaveLength(1);
        } else {
          expect(beacons, `${label}: never a report`).toEqual([]);
          expect(crumbs("realtimekit: room left").map((b) => b.data), label).toEqual([
            { surface: s.surface, fixtureId: s.fixtureId, side: s.side, leaveState: state },
          ]);
          expect(crumbs("realtimekit: room rejoined"), `${label}: no drop, so no rejoin`).toEqual([]);
        }
        expect(sentDropsToBrowserSentry(), label).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(SURFACES.length * states.length);
  });

  it("a drop with no board or no side named has nothing to find its meeting by (one per player): no report, and none through the browser Sentry either", async () => {
    // The guard on the assumption "every caller names its board and side": the report's builder refuses it, and the loader sends nothing.
    expect(roomDropReport("player", { fixtureId: null, side: "white" }, "disconnected")).toBeNull();
    expect(roomDropReport("player", { fixtureId: PLAYER_FIXTURE, side: null }, "disconnected")).toBeNull();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)) });
    const nameless = [undefined, { fixtureId: PLAYER_FIXTURE, side: null }, { fixtureId: null, side: "white" }] as const;
    for (const where of nameless) {
      clearSent();
      await makeJoinOwnCamera(rtk.load, () => undefined)(PLAYER_TOKEN, where);
      await settle();
      const m = rtk.meetings.at(-1)!;
      expect(m.calls, "premise: joined").toContain("join");
      m.dropSocket();
      expect(beacons, `a drop that cannot be named: ${JSON.stringify(where)}`).toEqual([]);
      expect(sentDropsToBrowserSentry()).toEqual([]);
    }
    expect(rtk.meetings.length, "anti-vacuity: every case joined its own meeting").toBe(nameless.length);
    // The positive pair: the same drop WITH a board and a side is a report (a loader that could not send would pass the above).
    expect(roomDropReport("player", { fixtureId: PLAYER_FIXTURE, side: "white" }, "disconnected")).not.toBeNull();
  });

  it("a side the route does not list is no report, never a string the route would refuse; every named side is kept", () => {
    expect(roomDropReport("arbiter", { fixtureId: ARBITER_FIXTURE, side: "left-hand" }, "failed")).toBeNull();
    expect(roomDropReport("arbiter", { fixtureId: ARBITER_FIXTURE, side: "HOME" }, "failed")).toBeNull();
    let checked = 0;
    for (const side of ["white", "black", "home", "away"]) {
      const report = roomDropReport("player", { fixtureId: PLAYER_FIXTURE, side }, "left");
      expect(ClientReport.parse(report), side).toEqual(report);
      expect(report?.side, side).toBe(side);
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(roomDropReport("player", { fixtureId: PLAYER_FIXTURE, side: "white" }, "kicked"), "a planned leave is no report").toBeNull();
  });

  it("never a token, a peer's user id or a name in anything sent: the beacon bodies and the browser breadcrumbs", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      const { m } = await s.join();
      await m.reconnect();
      m.meta.emit("mediaConnectionUpdate", { transport: "send", state: "failed" });
      await settle();
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
    expect(beacons.length, "anti-vacuity: a drop was beaconed").toBeGreaterThan(0);
    expect(sentry.addBreadcrumb.mock.calls.length, "anti-vacuity: breadcrumbs were left").toBeGreaterThan(0);
    const sent = JSON.stringify([beacons, sentry.captureMessage.mock.calls, sentry.addBreadcrumb.mock.calls]);
    for (const secret of [PLAYER_TOKEN, ARBITER_TOKEN, OPP.user, WHITE.user, "rtk-arbiter", "self-user"]) {
      expect(sent, secret).not.toContain(secret);
    }
    // Only the declared fields ride a body.
    for (const b of beacons) expect(Object.keys(JSON.parse(b.body)).sort()).toEqual(["fixtureId", "kind", "leaveState", "side", "surface"]);
  });
});
