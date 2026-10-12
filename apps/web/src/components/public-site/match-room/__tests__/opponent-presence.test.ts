// T14 review I8 (controller ruling): the opponent's presence pill comes from
// the viewer's OWN RealtimeKit client — who is in the meeting, and whether the
// opponent has a live camera producer — never from a server call. The rule,
// as ruled:
//   - no pill until the viewer has joined AND settled; none if the join
//     failed, the socket is down, or the viewer left;
//   - "off" only when the opponent is genuinely absent, or present without a
//     live camera;
//   - "live" when present with a live camera producer.
// The model below is that rule written from the ruling, not from the code.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { makeJoinOwnCamera, type MeetingLink } from "../camera-loader";
import { opponentPresenceView, PRESENCE_SETTLE_MS, PRESENCE_TICK_MS } from "../opponent-presence";
import { fakeRealtimeKit } from "./_fake-realtimekit";

const OPP = { peer: "opp-peer", user: "rtk-opponent" };
const T0 = 1_760_000_000_000;
const link = (joinedAt: number, peers: MeetingLink["peers"] = []): MeetingLink => ({ joinedAt, peers });

describe("opponentPresenceView — the rule", () => {
  it("the empty cases first: no opponent to show, or no meeting link ⇒ no pill", () => {
    expect(opponentPresenceView(null, { participantId: OPP.user }, T0)).toBeNull();
    expect(opponentPresenceView(link(T0 - 60_000, [{ userId: OPP.user, videoLive: true }]), null, T0)).toBeNull();
  });

  it("settle: nothing before PRESENCE_SETTLE_MS after the join, the answer at it", () => {
    const l = link(T0, [{ userId: OPP.user, videoLive: true }]);
    expect(opponentPresenceView(l, { participantId: OPP.user }, T0 + PRESENCE_SETTLE_MS - 1)).toBeNull();
    expect(opponentPresenceView(l, { participantId: OPP.user }, T0 + PRESENCE_SETTLE_MS)).toBe(true);
    // The settle is longer than one tick, so a pill never flashes "off"
    // before the peer list has loaded.
    expect(PRESENCE_SETTLE_MS).toBeGreaterThan(PRESENCE_TICK_MS);
  });

  it("settled: present + live ⇒ live; present, no camera ⇒ off; absent ⇒ off; no seat in the meeting at all ⇒ off; another participant's camera never counts", () => {
    const at = T0 + PRESENCE_SETTLE_MS;
    const cases: [MeetingLink["peers"], string | null, boolean][] = [
      [[{ userId: OPP.user, videoLive: true }], OPP.user, true],
      [[{ userId: OPP.user, videoLive: false }], OPP.user, false],
      [[], OPP.user, false],
      [[{ userId: "rtk-arbiter", videoLive: true }], OPP.user, false],
      [[{ userId: "rtk-arbiter", videoLive: true }], null, false],
      // Two tabs of the same person: live if either is.
      [[{ userId: OPP.user, videoLive: false }, { userId: OPP.user, videoLive: true }], OPP.user, true],
    ];
    let checked = 0;
    for (const [peers, id, want] of cases) {
      expect(opponentPresenceView(link(T0, peers), { participantId: id }, at), JSON.stringify(peers)).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(6);
  });
});

/** The ruling's rule, over what the test itself did to the meeting. */
type Model = { connected: boolean; joinedAt: number; oppIn: boolean; cam: "none" | "live" | "paused"; screen: boolean };
function expected(m: Model, now: number): boolean | null {
  if (!m.connected || now - m.joinedAt < PRESENCE_SETTLE_MS) return null;
  return m.oppIn && m.cam === "live";
}

type Cmd =
  | { k: "oppJoin" }
  | { k: "oppLeave" }
  | { k: "camOn" }
  | { k: "camPause" }
  | { k: "camResume" }
  | { k: "camClose" }
  | { k: "screen" }
  | { k: "arbiterJoin" }
  | { k: "drop" }
  | { k: "rejoin" }
  | { k: "wait"; ms: number };
// Weighted towards what it takes to REACH "live" (opponent in, camera on,
// settled) so all three outcomes are visited often, not by luck.
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { arbitrary: fc.constant({ k: "oppJoin" } as const), weight: 4 },
  { arbitrary: fc.constant({ k: "oppLeave" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "camOn" } as const), weight: 4 },
  { arbitrary: fc.constant({ k: "camPause" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "camResume" } as const), weight: 2 },
  { arbitrary: fc.constant({ k: "camClose" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "screen" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "arbiterJoin" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "drop" } as const), weight: 1 },
  { arbitrary: fc.constant({ k: "rejoin" } as const), weight: 1 },
  {
    arbitrary: fc.constantFrom(500, PRESENCE_TICK_MS, PRESENCE_SETTLE_MS - 1, PRESENCE_SETTLE_MS, 7_000).map((ms) => ({ k: "wait", ms }) as const),
    weight: 5,
  },
);


describe("the pill over a meeting's life — real loader, ported SDK, any order of events", () => {
  it("fast-check: after every event the view is exactly the ruling's rule; every outcome and every event is reached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const seen = { live: 0, off: 0, none: 0 };
    const applied = new Map<string, number>();
    let runs = 0;
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 40 }), async (cmds) => {
          runs += 1;
          let now = T0;
          vi.setSystemTime(now);
          const rtk = fakeRealtimeKit();
          const cam = await makeJoinOwnCamera(rtk.load)("own-token");
          const m = rtk.meetings[0]!;
          const model: Model = { connected: true, joinedAt: now, oppIn: false, cam: "none", screen: false };
          let camSeq = 0;
          let camId: string | null = null;
          for (const c of cmds) {
            applied.set(c.k, (applied.get(c.k) ?? 0) + 1);
            switch (c.k) {
              case "oppJoin":
                if (!model.oppIn) {
                  m.peerJoins(OPP.peer, OPP.user);
                  model.oppIn = true;
                  model.cam = "none";
                  camId = null;
                }
                break;
              case "oppLeave":
                if (model.oppIn) {
                  m.peerLeaves(OPP.peer);
                  model.oppIn = false;
                  model.cam = "none";
                  camId = null;
                }
                break;
              case "camOn":
                if (model.oppIn && model.cam === "none") {
                  camId = `cam-${(camSeq += 1)}`;
                  m.produce(OPP.peer, { producerId: camId, kind: "video", screenShare: false });
                  model.cam = "live";
                }
                break;
              case "camPause":
                if (camId && model.cam === "live") {
                  m.toggle(OPP.peer, camId, true);
                  model.cam = "paused";
                }
                break;
              case "camResume":
                if (camId && model.cam === "paused") {
                  m.toggle(OPP.peer, camId, false);
                  model.cam = "live";
                }
                break;
              case "camClose":
                if (camId) {
                  m.closeProducer(OPP.peer, camId);
                  camId = null;
                  model.cam = "none";
                }
                break;
              case "screen":
                if (model.oppIn) m.produce(OPP.peer, { producerId: `screen-${(camSeq += 1)}`, kind: "video", screenShare: true });
                break;
              case "arbiterJoin":
                m.peerJoins(`arb-${(camSeq += 1)}`, "rtk-arbiter");
                break;
              case "drop":
                if (model.connected) {
                  m.dropSocket();
                  model.connected = false;
                }
                break;
              case "rejoin":
                m.reconnect();
                model.connected = true;
                model.joinedAt = now;
                break;
              case "wait":
                now += c.ms;
                vi.setSystemTime(now);
                break;
            }
            const got = opponentPresenceView(cam.link(), { participantId: OPP.user }, now);
            expect(got).toBe(expected(model, now));
            if (got === true) seen.live += 1;
            else if (got === false) seen.off += 1;
            else seen.none += 1;
            // D7 holds throughout, whatever the pill says.
            expect(m.participants.videoSubscribed.size).toBe(0);
          }
          await cam.leave();
          expect(opponentPresenceView(cam.link(), { participantId: OPP.user }, now), "left ⇒ no pill").toBeNull();
        }),
        { numRuns: 300, seed: 20261012 },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(runs, "anti-vacuity: runs").toBe(300);
    // Every outcome reached, often.
    expect(seen.live, "live reached").toBeGreaterThan(50);
    expect(seen.off, "off reached").toBeGreaterThan(50);
    expect(seen.none, "no pill reached").toBeGreaterThan(50);
    // Every event kind applied.
    for (const k of ["oppJoin", "oppLeave", "camOn", "camPause", "camResume", "camClose", "screen", "arbiterJoin", "drop", "rejoin", "wait"]) {
      expect(applied.get(k) ?? 0, `applied: ${k}`).toBeGreaterThan(20);
    }
  });
});
