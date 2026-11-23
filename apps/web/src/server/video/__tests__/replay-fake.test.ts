// Task 21: the in-memory ReplayHost. Later tasks (the mover, the webhook, the playback reader, the download route) drive this
// fake, so what it promises is pinned here: ids, the processing -> playable | failed machine, the 720 ceiling on heights,
// remove, the pure signed embed, and a download that streams.
import { describe, expect, it } from "vitest";
import { FakeReplayHost } from "../replay-fake";
import { type ReplayHost, ReplayNotDownloadable, type ReplayState } from "../replay-ports";

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
const fetchOne = (fake: FakeReplayHost, title = "Court 1 part 1", url = "https://cf.example.invalid/tok/downloads/default.mp4") =>
  fake.fetchFromUrl({ collectionId: "col-1", title, url });

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

  it("Task 27b: two fakes never name the same copy — a copy's id is unique across the replay table (V545), and every test in a shared database, or a restarted `next dev`, makes its own fake; a named prefix is kept as given (counts reported)", async () => {
    const fakes = [new FakeReplayHost(), new FakeReplayHost(), new FakeReplayHost()];
    const ids: string[] = [];
    for (const fake of fakes) for (let i = 0; i < 3; i++) ids.push(await fetchOne(fake));
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size, "nine fetches over three fakes, nine ids").toBe(9);
    for (const id of ids) expect(id).toMatch(/^fake-video-[0-9a-f]{8}-\d+$/);
    const named = new FakeReplayHost({ idPrefix: "t-readable" });
    expect(await fetchOne(named)).toBe("t-readable-1");
  });

  it("answers a different id for every fetch, even of one title, and reads the title and collection it was sent", async () => {
    const fake = new FakeReplayHost();
    const ids = [
      await fetchOne(fake, "Same title", "https://cf.example.invalid/one/downloads/default.mp4"),
      await fetchOne(fake, "Same title", "https://cf.example.invalid/two/downloads/default.mp4"),
      await fetchOne(fake, "Other title"),
    ];
    expect(new Set(ids).size).toBe(3);
    expect((await fake.video(ids[0])).title).toBe("Same title");
    expect((await fake.video(ids[2])).title).toBe("Other title");
    expect(fake.collectionOf(ids[0])).toBe("col-1");
    // which recording was moved is readable, so a caller's "only this input's recording" test need not spy
    expect(fake.sourceOf(ids[0])).toBe("https://cf.example.invalid/one/downloads/default.mp4");
    expect(fake.sourceOf(ids[1])).toBe("https://cf.example.invalid/two/downloads/default.mp4");
    expect(fake.sourceOf("never-stored")).toBeNull();
  });

  it("is deterministic under a named prefix: two fresh fakes given one prefix issue the same ids in the same order (the default prefix is per instance, Task 27b)", async () => {
    const seq = async () => {
      const f = new FakeReplayHost({ idPrefix: "t-same" });
      return [await f.createCollection("o"), await fetchOne(f), await fetchOne(f)];
    };
    const first = await seq();
    expect(first).toEqual(["fake-collection-1", "t-same-2", "t-same-3"]);
    expect(await seq()).toEqual(first);
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

describe("FakeReplayHost: signedEmbed is pure and has the real URL's shape", () => {
  const now = new Date("2026-11-21T10:00:00.000Z");
  // The shape Task 25's tests assert on: https://<embed host>/embed/<library>/<video>?token=<64 hex>&expires=<epoch seconds>.
  // The host is the one Task 25's CSP adds to frame-src under the fake driver (plan Task 25, step 1).
  const SHAPE = /^https:\/\/embed\.fake\.invalid\/embed\/(\d+)\/([^/?]+)\?token=([0-9a-f]{64})&expires=(\d+)$/;
  const parse = (src: string) => {
    const m = SHAPE.exec(src);
    expect(m, src).not.toBeNull();
    return { library: m![1], video: m![2], token: m![3], expires: m![4] };
  };
  it("answers the full shape, expires ttlSeconds after now, and calls nothing", async () => {
    const fake = new FakeReplayHost();
    const a = fake.signedEmbed("vid-1", now, 3600);
    expect(a.expiresAt).toBe("2026-11-21T11:00:00.000Z");
    const parts = parse(a.src);
    expect(parts.video).toBe("vid-1");
    expect(parts.expires).toBe(String(Date.parse("2026-11-21T11:00:00.000Z") / 1000));
    expect(fake.videoIds()).toEqual([]); // it stored nothing and did not need the video to exist
    expect(fake.signedEmbed("vid-1", now, 3600)).toEqual(a);
  });

  it("a later call, another video or another ttl changes the URL, and the library segment stays", () => {
    const fake = new FakeReplayHost();
    const a = fake.signedEmbed("vid-1", now, 3600);
    const later = fake.signedEmbed("vid-1", new Date("2026-11-21T10:30:00.000Z"), 3600);
    expect(later.expiresAt).toBe("2026-11-21T11:30:00.000Z");
    expect(parse(later.src).token).not.toBe(parse(a.src).token);
    const other = parse(fake.signedEmbed("vid-2", now, 3600).src);
    expect(other.video).toBe("vid-2");
    expect(other.token).not.toBe(parse(a.src).token);
    const shorter = fake.signedEmbed("vid-1", now, 60);
    expect(shorter.expiresAt).toBe("2026-11-21T10:01:00.000Z");
    expect(shorter.src).not.toBe(a.src);
    expect(other.library).toBe(parse(a.src).library);
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
    for (const id of ids) {
      await expect(fake.openDownload(id), id).rejects.toThrow(/not playable|absent/);
      // Task 26: the port's typed refusal, which the download answers as "not ready" (409).
      await expect(fake.openDownload(id), id).rejects.toBeInstanceOf(ReplayNotDownloadable);
    }
    expect(ids).toHaveLength(4);
  });
});

describe("FakeReplayHost: watchMinutes (Phase 3, unmeasured against the real host)", () => {
  it("reads 0 until a test sets it, then the number it was given, and logs each window it was asked", async () => {
    const fake = new FakeReplayHost();
    const id = await fetchOne(fake);
    const from = new Date("2026-11-01T00:00:00.000Z");
    const to = new Date("2026-11-21T00:00:00.000Z");
    expect(await fake.watchMinutes(id, from, to)).toBe(0);
    fake.setWatchMinutes(id, 42.5);
    expect(await fake.watchMinutes(id, from, to)).toBe(42.5);
    expect(fake.watchWindows(id)).toEqual([{ from, to }, { from, to }]);
    expect(fake.watchWindows("never-asked")).toEqual([]);
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
