// Seazn-hosted video, Task 14: GET /api/v1/public/fixtures/{id}/video — the thin door in front of `seaznFixtureVideo`.
// Three things are this route's own, and each is pinned here:
//   - it answers the read's video for the PATH's fixture, in the v1 envelope;
//   - `Cache-Control: private, no-store`, on every answer: the body holds signed playback URLs, and an edge or a browser that
//     kept one would serve it past its token's life (and to someone else, at the edge);
//   - the public per-IP limit its sibling realtime-token spends (60 a minute, `pubv1`), checked BEFORE the read, so a refused
//     request signs nothing.
// The read itself is a spy (its own DB suite, server/video/__tests__/seazn-video.test.ts, proves the answer); the limiter is the
// REAL one over an in-memory INCR, as app/api/v1/public/__tests__/poll-rate-limit.test.ts drives it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return { count: next, ttlMs: 60_000 };
  },
}));
const VIDEO = {
  live: { src: "https://playback.fake.invalid/fake.in-1.1790000000/manifest/video.m3u8", expiresAt: "2026-09-21T10:00:00.000Z" },
  replay: [{ partNo: 1, player: "hls" as const, src: "https://playback.fake.invalid/fake.v-1.1790000000/manifest/video.m3u8", expiresAt: "2026-09-21T10:00:00.000Z" }],
};
const read = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/server/video/seazn-video", () => ({ seaznFixtureVideo: read.fn }));

import { GET } from "../route";

const FIXTURE = "3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b";
const call = (ip = "203.0.113.40", id = FIXTURE) =>
  GET(new Request(`http://app.test/api/v1/public/fixtures/${id}/video`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  counters.clear();
  read.fn.mockReset();
  read.fn.mockResolvedValue(VIDEO);
});

describe("GET /api/v1/public/fixtures/{id}/video", () => {
  it("answers the read's video for the PATH's fixture, read at the request's time, in the v1 envelope", async () => {
    const before = Date.now();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: VIDEO });
    expect(read.fn).toHaveBeenCalledTimes(1);
    const [id, now] = read.fn.mock.calls[0]!;
    expect(id).toBe(FIXTURE);
    expect(now).toBeInstanceOf(Date);
    expect((now as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((now as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("is never cached: `private, no-store` on a video, and on an empty one too", async () => {
    expect((await call()).headers.get("cache-control")).toBe("private, no-store");
    read.fn.mockResolvedValue({ live: null, replay: [] });
    const empty = await call();
    expect(await empty.json()).toMatchObject({ ok: true, data: { live: null, replay: [] } });
    expect(empty.headers.get("cache-control")).toBe("private, no-store");
  });

  it("spends the public 60-a-minute bucket like realtime-token: 60 from one IP are served, the 61st is 429 and reads nothing", async () => {
    const ip = "198.51.100.40";
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call(ip)).status);
    expect(statuses.slice(0, 60).filter((s) => s !== 200), "the first 60").toEqual([]);
    expect(statuses[60], "the 61st").toBe(429);
    expect(read.fn, "the refused request never reached the read").toHaveBeenCalledTimes(60);
    expect(Object.fromEntries(counters), "the 60 bucket, never the poll bucket").toEqual({ [`rl:pubv1:${ip}`]: 61 });
  });

  it("a read that fails is an error, never a cached or partial video", async () => {
    read.fn.mockRejectedValue(new Error("mint failed"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
