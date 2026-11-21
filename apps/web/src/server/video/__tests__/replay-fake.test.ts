// Task 21: the in-memory ReplayHost. Later tasks (the mover, the webhook, the playback reader, the download route) drive this
// fake, so what it promises is pinned here: ids, the processing -> playable | failed machine, the 720 ceiling on heights,
// remove, the pure signed embed, and a download that streams.
import { describe, expect, it } from "vitest";
import { FakeReplayHost } from "../replay-fake";
import type { ReplayHost, ReplayState } from "../replay-ports";

/** The owner's library setting (probe B2, spec): no replay is encoded above this. */
const CEILING = 720;

const readAll = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const fetchOne = (fake: FakeReplayHost, title = "Court 1 part 1") =>
  fake.fetchFromUrl({ collectionId: "col-1", title, url: "https://cf.example.invalid/tok/downloads/default.mp4" });

describe("FakeReplayHost: collections and ids", () => {
  it("names a collection org:<orgId>; a second call makes a second collection, as the vendor does", async () => {
    const fake = new FakeReplayHost();
    const a = await fake.createCollection("org-a");
    const b = await fake.createCollection("org-a");
    expect(a).not.toBe(b);
    expect(fake.collectionName(a)).toBe("org:org-a");
    expect(fake.collectionName(b)).toBe("org:org-a");
    expect(fake.collectionName("never-made")).toBeNull();
  });

  it("answers a different id for every fetch, even of one title, and reads the title and collection it was sent", async () => {
    const fake = new FakeReplayHost();
    const ids = [await fetchOne(fake, "Same title"), await fetchOne(fake, "Same title"), await fetchOne(fake, "Other title")];
    expect(new Set(ids).size).toBe(3);
    expect((await fake.video(ids[0])).title).toBe("Same title");
    expect((await fake.video(ids[2])).title).toBe("Other title");
    expect(fake.collectionOf(ids[0])).toBe("col-1");
  });

  it("is deterministic: two fresh fakes issue the same ids in the same order", async () => {
    const seq = async () => {
      const f = new FakeReplayHost();
      return [await f.createCollection("o"), await fetchOne(f), await fetchOne(f)];
    };
    expect(await seq()).toEqual(await seq());
  });
});

describe("FakeReplayHost: the state machine", () => {
  it("a fetched video is processing with nothing to play; advance makes it playable with a length and renditions", async () => {
    const fake = new FakeReplayHost();
    const id = await fetchOne(fake);
    const before = await fake.video(id);
    expect(before).toMatchObject({ state: "processing", lengthSeconds: null, heights: [] });
    fake.advance(id);
    const after = await fake.video(id);
    expect(after.state).toBe("playable");
    expect(after.lengthSeconds).toBeGreaterThan(0);
    expect(after.heights.length).toBeGreaterThan(0);
  });

  it("fail gives failed, with no length and no renditions", async () => {
    const fake = new FakeReplayHost();
    const id = await fetchOne(fake);
    fake.fail(id);
    expect(await fake.video(id)).toMatchObject({ state: "failed", lengthSeconds: null, heights: [] });
  });

  it("one video's moves leave the others alone", async () => {
    const fake = new FakeReplayHost();
    const [a, b, c] = [await fetchOne(fake), await fetchOne(fake), await fetchOne(fake)];
    fake.advance(a);
    fake.fail(b);
    expect([(await fake.video(a)).state, (await fake.video(b)).state, (await fake.video(c)).state]).toEqual(["playable", "failed", "processing"]);
  });

  it("refuses the moves the vendor never makes, and an id it does not hold; repeating a move is harmless", async () => {
    const fake = new FakeReplayHost();
    const ok = await fetchOne(fake);
    const bad = await fetchOne(fake);
    fake.advance(ok);
    fake.advance(ok); // a repeat
    expect((await fake.video(ok)).state).toBe("playable");
    expect(() => fake.fail(ok)).toThrow(/playable/);
    fake.fail(bad);
    fake.fail(bad); // a repeat
    expect((await fake.video(bad)).state).toBe("failed");
    expect(() => fake.advance(bad)).toThrow(/failed/);
    expect(() => fake.advance("nope")).toThrow(/nope/);
    expect(() => fake.fail("nope")).toThrow(/nope/);
  });

  it("an id nobody stored reads absent, with nothing in it", async () => {
    const fake = new FakeReplayHost();
    expect(await fake.video("never-stored")).toEqual({ state: "absent", lengthSeconds: null, title: null, heights: [] });
  });
});

describe("FakeReplayHost: heights never exceed 720", () => {
  it("holds in every state, and the list is not ordered, so the best rendition is the maximum and not the last", async () => {
    const fake = new FakeReplayHost();
    const processing = await fetchOne(fake);
    const playable = await fetchOne(fake);
    const failed = await fetchOne(fake);
    const removed = await fetchOne(fake);
    fake.advance(playable);
    fake.fail(failed);
    await fake.remove(removed);
    const seen = new Map<ReplayState, number[]>();
    for (const id of [processing, playable, failed, removed, "never-stored"]) {
      const v = await fake.video(id);
      seen.set(v.state, v.heights);
      for (const h of v.heights) expect(h, `${v.state} height`).toBeLessThanOrEqual(CEILING);
    }
    expect([...seen.keys()].sort()).toEqual(["absent", "failed", "playable", "processing"]); // every state was checked
    const heights = seen.get("playable")!;
    expect(heights.length).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBe(CEILING);
    expect(heights[heights.length - 1]).not.toBe(Math.max(...heights));
  });
});

describe("FakeReplayHost: remove", () => {
  it("deletes a video in any state; after it the video reads absent, a second remove answers absent, the others stay", async () => {
    const fake = new FakeReplayHost();
    const [a, b, c] = [await fetchOne(fake), await fetchOne(fake), await fetchOne(fake)];
    fake.advance(a);
    fake.fail(b);
    expect(fake.videoIds()).toEqual([a, b, c].sort());
    expect(await fake.remove(a)).toBe("deleted");
    expect((await fake.video(a)).state).toBe("absent");
    expect(await fake.remove(a)).toBe("absent");
    expect(await fake.remove(b)).toBe("deleted");
    expect(await fake.remove(c)).toBe("deleted");
    expect(await fake.remove("never-stored")).toBe("absent");
    expect(fake.videoIds()).toEqual([]);
  });
});

describe("FakeReplayHost: signedEmbed is pure", () => {
  const now = new Date("2026-11-21T10:00:00.000Z");
  it("expires ttlSeconds after now, names the video, carries the expiry as epoch seconds, and calls nothing", async () => {
    const fake = new FakeReplayHost();
    const a = fake.signedEmbed("vid-1", now, 3600);
    expect(a.expiresAt).toBe("2026-11-21T11:00:00.000Z");
    const url = new URL(a.src);
    expect(url.pathname).toContain("vid-1");
    expect(url.searchParams.get("expires")).toBe(String(Date.parse("2026-11-21T11:00:00.000Z") / 1000));
    expect(url.searchParams.get("token")).toBeTruthy();
    expect(fake.videoIds()).toEqual([]); // it stored nothing and did not need the video to exist
    expect(fake.signedEmbed("vid-1", now, 3600)).toEqual(a);
    const later = fake.signedEmbed("vid-1", new Date("2026-11-21T10:30:00.000Z"), 3600);
    expect(later.expiresAt).toBe("2026-11-21T11:30:00.000Z");
    expect(later.src).not.toBe(a.src);
    expect(fake.signedEmbed("vid-2", now, 3600).src).not.toBe(a.src);
  });
});

describe("FakeReplayHost: openDownload", () => {
  it("streams the same fixed, non-empty bytes every time, says how many, and names an .mp4", async () => {
    const fake = new FakeReplayHost();
    const id = await fetchOne(fake);
    fake.advance(id);
    const first = await fake.openDownload(id);
    const bytes = await readAll(first.body);
    expect(bytes.length).toBeGreaterThan(0);
    expect(first.bytes).toBe(bytes.length);
    expect(first.fileName).toMatch(/\.mp4$/);
    const second = await fake.openDownload(id);
    expect(await readAll(second.body)).toEqual(bytes);
  });

  it("has no file for a video that is still processing, failed, removed or never stored", async () => {
    const fake = new FakeReplayHost();
    const processing = await fetchOne(fake);
    const failed = await fetchOne(fake);
    fake.fail(failed);
    const removed = await fetchOne(fake);
    fake.advance(removed);
    await fake.remove(removed);
    const ids = [processing, failed, removed, "never-stored"];
    for (const id of ids) await expect(fake.openDownload(id), id).rejects.toThrow(/not playable|absent/);
    expect(ids).toHaveLength(4);
  });
});

describe("FakeReplayHost: watchMinutes (Phase 3)", () => {
  it("reads 0 until a test sets it, then the number it was given, for any window", async () => {
    const fake = new FakeReplayHost();
    const id = await fetchOne(fake);
    const from = new Date("2026-11-01T00:00:00.000Z");
    const to = new Date("2026-11-21T00:00:00.000Z");
    expect(await fake.watchMinutes(id, from, to)).toBe(0);
    fake.setWatchMinutes(id, 42.5);
    expect(await fake.watchMinutes(id, from, to)).toBe(42.5);
    await expect(fake.watchMinutes(id, to, from)).rejects.toThrow(/backwards/);
  });
});

describe("FakeReplayHost implements the whole port", () => {
  it("assigns to ReplayHost (a compile-time guard) and carries every port method at run time", () => {
    const fake: ReplayHost = new FakeReplayHost();
    const methods = ["createCollection", "fetchFromUrl", "video", "remove", "signedEmbed", "openDownload", "watchMinutes"] as const;
    for (const m of methods) expect(typeof fake[m], m).toBe("function");
    expect(methods).toHaveLength(7);
  });
});
