// Connection drops, reported with what we already have (owner 2026-11-22: "we have logger and sentry"): every
// RealtimeKit `roomLeft` that is NOT our own leave is a Sentry warning, "realtimekit: room dropped", tagged with the
// surface, the fixture, the side and the SDK's own leave state; the next `roomJoined` leaves a breadcrumb,
// "realtimekit: room rejoined", carrying the gap; the SDK's socket and media connection updates are breadcrumbs.
// Swept over BOTH surfaces that join a meeting - the player's camera (camera-loader.ts) and the arbiter's
// (arbiter-camera.ts) - driven through their REAL loaders over the SDK port (_fake-realtimekit.ts). The SDK facts the
// expected values come from are the 2.0.2 typings and source: `roomLeft` carries `{ state: LeaveRoomState }`,
// `roomJoined` carries `{ reconnected }` (index.d.ts l.2358-2363), a socket drop emits roomLeft "disconnected"
// (index.es.js l.24413-24423) and the client's own leave() emits roomLeft "left" (l.24497-24500).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

import { makeJoinOwnCamera } from "../camera-loader";
import { makeJoinArbiter } from "@/components/v2/match-day/online/arbiter-camera";
import { fakeRealtimeKit, type FakeMeeting } from "./_fake-realtimekit";

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const camera = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-cam`, kind: "video", screenShare: false });

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
    fixtureId: "fx-player",
    side: "white",
    async join() {
      const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)) });
      const cam = await makeJoinOwnCamera(rtk.load, () => undefined)(PLAYER_TOKEN, { fixtureId: "fx-player", side: "white" });
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
    fixtureId: "fx-arbiter",
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
        fixtureId: "fx-arbiter",
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
beforeEach(() => {
  sentry.captureMessage.mockClear();
  sentry.addBreadcrumb.mockClear();
  sentry.captureException.mockClear();
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

const drops = () => sentry.captureMessage.mock.calls.filter((c) => c[0] === "realtimekit: room dropped");
const crumbs = (message: string) =>
  sentry.addBreadcrumb.mock.calls.map((c) => c[0] as { message: string; data: Record<string, unknown> }).filter((b) => b.message === message);

describe("realtimekit drops: a warning per unplanned roomLeft, a breadcrumb per rejoin (both surfaces)", () => {
  it("the join's own roomJoined is no rejoin: nothing reported (the empty case)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.captureMessage.mockClear();
      sentry.addBreadcrumb.mockClear();
      const { m } = await s.join();
      expect(m.calls, `${s.surface}: premise, joined`).toContain("join");
      expect(drops(), s.surface).toEqual([]);
      expect(crumbs("realtimekit: room rejoined"), s.surface).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("a socket drop is ONE warning tagged surface/fixture/side/leave state; the rejoin is a breadcrumb with the gap; a second cycle repeats both with its OWN gap", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.captureMessage.mockClear();
      sentry.addBreadcrumb.mockClear();
      const { m } = await s.join();
      clock = 2_000_000;
      m.dropSocket();
      expect(drops(), `${s.surface}: one warning`).toEqual([
        [
          "realtimekit: room dropped",
          { level: "warning", tags: { area: "realtimekit", surface: s.surface, fixtureId: s.fixtureId, side: s.side, leaveState: "disconnected" } },
        ],
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
      // A second cycle: its own warning, and a gap measured from ITS drop, not the first one.
      clock = 3_000_000;
      m.self.emit("roomLeft", { state: "failed" });
      clock = 3_000_250;
      m.self.emit("roomJoined", { reconnected: false });
      await settle();
      expect(drops().map((c) => (c[1] as { tags: { leaveState: string } }).tags.leaveState), s.surface).toEqual(["disconnected", "failed"]);
      expect(crumbs("realtimekit: room rejoined").map((b) => b.data.gapMs), s.surface).toEqual([3_500, 250]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("two roomLefts before one rejoin (disconnected, then failed): two warnings, ONE breadcrumb timed from the first", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.captureMessage.mockClear();
      sentry.addBreadcrumb.mockClear();
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

  it("the real reconnect sequence (socket down, back up, roomJoined): one warning, one rejoin breadcrumb, socket updates as breadcrumbs", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.captureMessage.mockClear();
      sentry.addBreadcrumb.mockClear();
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

  it("a media transport update is a breadcrumb naming the transport and its state", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.addBreadcrumb.mockClear();
      const { m } = await s.join();
      m.meta.emit("mediaConnectionUpdate", { transport: "recv", state: "disconnected", sfuSessionId: "sfu-1" });
      expect(crumbs("realtimekit: media connection").map((b) => b.data), s.surface).toEqual([
        { surface: s.surface, transport: "recv", state: "disconnected" },
      ]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("OUR leave (the owner's leave()) is never a drop; a roomLeft 'left' we did not ask for still is (it is the flag, not the state)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      sentry.captureMessage.mockClear();
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
      sentry.captureMessage.mockClear();
      const j = await s.join();
      await s.failClosed(j);
      expect(j.m.calls.filter((c) => c === "leave"), `${s.surface}: premise, the guard left`).toHaveLength(1);
      expect(drops(), s.surface).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("never a token, a peer's user id or a name in anything sent to Sentry", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      const { m } = await s.join();
      await m.reconnect();
      m.meta.emit("mediaConnectionUpdate", { transport: "send", state: "failed" });
      await settle();
      checked += 1;
    }
    expect(checked).toBe(SURFACES.length);
    const sent = JSON.stringify([sentry.captureMessage.mock.calls, sentry.addBreadcrumb.mock.calls]);
    expect(sentry.captureMessage.mock.calls.length + sentry.addBreadcrumb.mock.calls.length, "anti-vacuity: something was sent").toBeGreaterThan(0);
    for (const secret of [PLAYER_TOKEN, ARBITER_TOKEN, OPP.user, WHITE.user, "rtk-arbiter", "self-user"]) {
      expect(sent, secret).not.toContain(secret);
    }
  });
});
