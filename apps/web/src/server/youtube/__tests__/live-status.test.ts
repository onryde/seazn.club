// The word the stream panel shows for a YouTube Connect session (owner direction 2026-11-14, stream-output-health-warning design):
// ONE of three, from what YouTube says of the BROADCAST (its life) and of its STREAM (streamStatus + healthStatus.status).
//   live_receiving  broadcast live AND stream `active` with health `good` / `ok`
//   not_live        broadcast not live
//   live_no_video   broadcast live, and the stream is not `active`, or its health is `noData` / `bad`
//
// The expectations below are typed from those three sentences (and the Google value sets in port.ts), NOT read back out of
// `youtubeLiveWordOf`. The table is every (life x stream status x health) combination of the port's own value lists, plus "stream not
// read" - so a value YouTube gains and the port adds is a combination this table meets and refuses to leave without a ruling (the
// partition checks below). Anti-vacuity: each class reports how many combinations it met, and zero is a failure.
import { describe, expect, it } from "vitest";
import { BROADCAST_LIVES, STREAM_HEALTHS, STREAM_STATUSES, type BroadcastLife, type StreamHealth, type StreamStatus } from "../port";
import { YOUTUBE_LIVE_WORDS } from "@/lib/youtube";
import { youtubeLiveWordOf } from "../live-status";

// The rulings, typed once from the owner's words (a literal list per class, never derived from the function):
const LIFE_LIVE: BroadcastLife = "live";
const LIFE_NOT_LIVE: BroadcastLife[] = ["created", "ready", "testing", "complete", "revoked", "absent"];
const STATUS_ACTIVE: StreamStatus = "active";
const STATUS_NOT_ACTIVE: StreamStatus[] = ["created", "ready", "inactive", "error", "absent"];
const HEALTH_HEALTHY: StreamHealth[] = ["good", "ok"];
// `revoked` is not in the owner's two words (`noData`/`bad`); it is YouTube's "this stream's ingestion is revoked" - nothing is arriving.
const HEALTH_NOT_RECEIVING: StreamHealth[] = ["bad", "noData", "revoked"];

const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

describe("the three words are exactly the owner's three, in this order", () => {
  it("YOUTUBE_LIVE_WORDS", () => {
    expect([...YOUTUBE_LIVE_WORDS]).toEqual(["live_receiving", "not_live", "live_no_video"]);
  });
});

describe("the rulings above partition YouTube's value sets (a value added to the port without a ruling fails here)", () => {
  it("lives, stream statuses and healths: every value is in exactly one ruling, none twice", () => {
    expect(sameSet([LIFE_LIVE, ...LIFE_NOT_LIVE], BROADCAST_LIVES)).toBe(true);
    expect(sameSet([STATUS_ACTIVE, ...STATUS_NOT_ACTIVE], STREAM_STATUSES)).toBe(true);
    expect(sameSet([...HEALTH_HEALTHY, ...HEALTH_NOT_RECEIVING], STREAM_HEALTHS)).toBe(true);
    expect(new Set([LIFE_LIVE, ...LIFE_NOT_LIVE]).size).toBe(BROADCAST_LIVES.length);
    expect(new Set([...HEALTH_HEALTHY, ...HEALTH_NOT_RECEIVING]).size).toBe(STREAM_HEALTHS.length);
  });
});

describe("youtubeLiveWordOf: every (broadcast life x stream status x health) combination", () => {
  it("the whole table", () => {
    const met = { receiving: 0, notLive: 0, noVideo: 0, noEvidence: 0 };
    let total = 0;
    for (const life of BROADCAST_LIVES) {
      // The stream is not read for a broadcast that is not live, so `null` is one of its inputs too - and for a live one it is the
      // "not read" case, which is no evidence.
      const streams: ({ status: StreamStatus; health: StreamHealth | null } | null)[] = [null];
      for (const status of STREAM_STATUSES) for (const health of [...STREAM_HEALTHS, null]) streams.push({ status, health });
      for (const stream of streams) {
        total++;
        const what = `${life} / ${stream ? `${stream.status} / ${stream.health}` : "stream not read"}`;
        const got = youtubeLiveWordOf(life, stream);
        if (life !== LIFE_LIVE) {
          expect(got, what).toBe("not_live");
          met.notLive++;
        } else if (stream === null) {
          expect(got, `${what}: a live broadcast whose stream was not read says nothing`).toBeNull();
          met.noEvidence++;
        } else if (stream.status !== STATUS_ACTIVE) {
          expect(got, what).toBe("live_no_video");
          met.noVideo++;
        } else if (stream.health === null) {
          expect(got, `${what}: active but YouTube gave no health says nothing`).toBeNull();
          met.noEvidence++;
        } else if (HEALTH_HEALTHY.includes(stream.health)) {
          expect(got, what).toBe("live_receiving");
          met.receiving++;
        } else {
          expect(HEALTH_NOT_RECEIVING, `premise: ${what}`).toContain(stream.health);
          expect(got, what).toBe("live_no_video");
          met.noVideo++;
        }
      }
    }
    // Anti-vacuity: the table is the full product (7 lives x (1 + 6 statuses x 6 healths-or-null)), and every class was met.
    expect(total).toBe(BROADCAST_LIVES.length * (1 + STREAM_STATUSES.length * (STREAM_HEALTHS.length + 1)));
    expect(total).toBe(7 * (1 + 6 * 6));
    expect(met.receiving, "live_receiving combinations").toBe(HEALTH_HEALTHY.length);
    expect(met.notLive, "not_live combinations").toBe(LIFE_NOT_LIVE.length * (1 + STREAM_STATUSES.length * (STREAM_HEALTHS.length + 1)));
    expect(met.noVideo, "live_no_video combinations").toBe(STATUS_NOT_ACTIVE.length * (STREAM_HEALTHS.length + 1) + HEALTH_NOT_RECEIVING.length);
    expect(met.noEvidence, "no-evidence combinations").toBe(1 + 1);
    expect(met.receiving + met.notLive + met.noVideo + met.noEvidence).toBe(total);
  });

  it("a health value no ruling covers (a cast past the port) is no evidence, never a guessed word - the guard has a case that reaches it", () => {
    expect(youtubeLiveWordOf("live", { status: "active", health: "somethingNew" as unknown as StreamHealth })).toBeNull();
  });

  it("the single combination that is live_receiving differs from its neighbours (an ordering-differential case)", () => {
    expect(youtubeLiveWordOf("live", { status: "active", health: "good" })).toBe("live_receiving");
    expect(youtubeLiveWordOf("live", { status: "active", health: "ok" })).toBe("live_receiving");
    expect(youtubeLiveWordOf("live", { status: "active", health: "noData" })).toBe("live_no_video");
    expect(youtubeLiveWordOf("live", { status: "inactive", health: "good" }), "a stream that is not active is not receiving, however its health reads").toBe("live_no_video");
    expect(youtubeLiveWordOf("ready", { status: "active", health: "good" }), "a healthy stream under a broadcast that is not live is not live yet").toBe("not_live");
  });
});
