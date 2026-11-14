// The word the stream panel shows for a YouTube Connect session (owner direction 2026-11-14, stream-output-health-warning design):
// ONE of three, from what YouTube says of the BROADCAST (its life) and of its STREAM (streamStatus + healthStatus.status).
//   live_receiving  broadcast live AND stream `active` with health `good` / `ok`
//   not_live        broadcast not live
//   live_no_video   broadcast live, and the stream is not `active`, or its health is `noData` / `bad`
//
// The broadcast's life is YouTube's own RAW `lifeCycleStatus`, never the port's collapsed `life`: the collapse reads `liveStarting` as
// "live" (right for the end step), but a broadcast YouTube is still starting is not live, and the status line must not say it is (fix
// round 1, I1). The raw values are typed below from YouTube's discovery document (youtube.googleapis.com/$discovery/rest?version=v3,
// schema LiveBroadcastStatus, `lifeCycleStatus`): lifeCycleStatusUnspecified, created, ready, testing, live, complete, revoked,
// testStarting, liveStarting - NOT from the port's list, which one test below checks AGAINST this one. The word for each is typed
// from the three sentences above, never read back out of `youtubeLiveWordOf`. The table is every (life x stream status x health)
// combination of those lists plus "stream not read" - so a value YouTube gains and the port adds is a combination this table meets
// and refuses to leave without a ruling (the partition checks below). Anti-vacuity: each class reports how many combinations it met,
// and zero is a failure. The sweep THROUGH the real driver (every raw wire value -> word) is google.test.ts's.
import { describe, expect, it } from "vitest";
import { LIFE_CYCLES, STREAM_HEALTHS, STREAM_STATUSES, type LifeCycle, type StreamHealth, type StreamStatus } from "../port";
import { YOUTUBE_LIVE_WORDS } from "@/lib/youtube";
import { youtubeLiveWordOf } from "../live-status";

/** YouTube's documented lifeCycleStatus values the port admits (the discovery document's nine, less the zero value), typed here. */
const DOCUMENTED_LIFE_CYCLES = ["created", "ready", "testStarting", "testing", "liveStarting", "live", "complete", "revoked"] as const;

// The rulings, typed once from the owner's words (a literal list per class, never derived from the function):
const LIFE_LIVE = "live";
// Includes the two TRANSITIONAL values: "Transition into LIVE has been requested" is not live yet (YouTube shows "Preparing stream").
const LIFE_NOT_LIVE: (LifeCycle | "absent")[] = ["created", "ready", "testStarting", "testing", "liveStarting", "complete", "revoked", "absent"];
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
    expect(sameSet(DOCUMENTED_LIFE_CYCLES, LIFE_CYCLES), "the port admits exactly the documented raw values").toBe(true);
    expect(sameSet([LIFE_LIVE, ...LIFE_NOT_LIVE], [...DOCUMENTED_LIFE_CYCLES, "absent"])).toBe(true);
    expect(sameSet([STATUS_ACTIVE, ...STATUS_NOT_ACTIVE], STREAM_STATUSES)).toBe(true);
    expect(sameSet([...HEALTH_HEALTHY, ...HEALTH_NOT_RECEIVING], STREAM_HEALTHS)).toBe(true);
    expect(new Set([LIFE_LIVE, ...LIFE_NOT_LIVE]).size).toBe(DOCUMENTED_LIFE_CYCLES.length + 1);
    expect(new Set([...HEALTH_HEALTHY, ...HEALTH_NOT_RECEIVING]).size).toBe(STREAM_HEALTHS.length);
  });
});

describe("youtubeLiveWordOf: every (broadcast life cycle x stream status x health) combination", () => {
  it("the whole table", () => {
    const met = { receiving: 0, notLive: 0, noVideo: 0, noEvidence: 0 };
    let total = 0;
    for (const life of [...DOCUMENTED_LIFE_CYCLES, "absent"] as const) {
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
    // Anti-vacuity: the table is the full product (9 lives x (1 + 6 statuses x 6 healths-or-null)), and every class was met.
    expect(total).toBe((DOCUMENTED_LIFE_CYCLES.length + 1) * (1 + STREAM_STATUSES.length * (STREAM_HEALTHS.length + 1)));
    expect(total).toBe(9 * (1 + 6 * 6));
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

  it("liveStarting and testStarting are NOT live (I1): a healthy, active stream under a broadcast YouTube is still starting reads not_live, never live_receiving", () => {
    const healthy = { status: "active", health: "good" } as const;
    expect(youtubeLiveWordOf("liveStarting", healthy), "Transition into LIVE has been requested").toBe("not_live");
    expect(youtubeLiveWordOf("testStarting", healthy), "Transition into TESTING has been requested").toBe("not_live");
    expect(youtubeLiveWordOf("liveStarting", null)).toBe("not_live");
    // the positive pair: the same stream under `live` IS receiving, so the two above are the life cycle and not the stream
    expect(youtubeLiveWordOf("live", healthy)).toBe("live_receiving");
  });
});
