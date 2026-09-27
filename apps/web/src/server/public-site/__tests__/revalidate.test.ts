// Pins the revalidation profiles (smoke 2026-07-10 regression): spectator
// tags (division/competition/discovery) use "max" — stale-while-revalidate is
// right for scoreboards — but org chrome writes come from an admin who
// immediately views their public page, so the org tag must expire NOW.
// Under "max" the very next request serves the stale page and the org color
// never shows up ("pro org landing carries the org color" smoke failure).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath }));
// The real `sendAfterDeleteOrBound` and PUSH_AFTER_DELETE_BOUND_MS: the push
// ordering below runs through them. `cacheDel` is recorded so the second DEL
// of `dropNamedPublicDocuments` is observable.
const cacheDel = vi.hoisted(() => vi.fn(async (..._keys: string[]) => {}));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDelPattern: vi.fn(),
  cacheDel,
}));
vi.mock("@/server/public-site/data", () => ({
  divisionTag: (id: string) => `division:${id}`,
  competitionTag: (id: string) => `competition:${id}`,
  orgTag: (slug: string) => `org-public:${slug}`,
  DISCOVERY_TAG: "discovery",
}));
// Recorded, not run, except where a test hands it the real implementation.
const broadcastRevalidate = vi.hoisted(() =>
  vi.fn<(tags: string[], mode: "swr" | "expire") => Promise<void>>(async () => {}),
);
vi.mock("@/lib/peer-revalidate", () => ({ broadcastRevalidate }));
// Task 7: CDN purge fires alongside the peer broadcast at the same seam —
// mocked here purely to assert the wiring, not purgeCdn's own behavior
// (that's cdn-purge.test.ts's job).
const purgeCdn = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/cdn-purge", () => ({ purgeCdn }));

import {
  dropNamedPublicDocuments,
  fireDivisionRevalidate,
  fireOrgRevalidate,
  fireDiscoveryRevalidate,
  firePostRevalidate,
  fireScoreRevalidate,
} from "../revalidate";
import { PUSH_AFTER_DELETE_BOUND_MS, sendAfterDeleteOrBound } from "@/lib/cache";
import { __setRedisForTests, __resetRedisStateForTests } from "../../../../cache-handler/redis-client.mjs";
import { decodeField } from "../../../../cache-handler/tag-state.mjs";

beforeEach(() => {
  revalidateTag.mockClear();
  revalidatePath.mockClear();
  broadcastRevalidate.mockClear();
  purgeCdn.mockClear();
  cacheDel.mockClear();
});

describe("public-site revalidation profiles", () => {
  it("org chrome expires immediately (read-your-writes)", () => {
    fireOrgRevalidate("my-org");
    expect(revalidateTag).toHaveBeenCalledWith("org-public:my-org", { expire: 0 });
  });

  it("org chrome broadcast fans out with expire mode", () => {
    fireOrgRevalidate("riverside");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["org-public:riverside"], "expire");
  });

  it("division/competition tags keep stale-while-revalidate", () => {
    fireDivisionRevalidate("d1", "c1");
    expect(revalidateTag).toHaveBeenCalledWith("division:d1", "max");
    expect(revalidateTag).toHaveBeenCalledWith("competition:c1", "max");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1", "competition:c1"], "swr");
  });

  it("division-only broadcast omits the competition tag when none is passed", () => {
    fireDivisionRevalidate("d1");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1"], "swr");
  });

  it("discovery tag keeps stale-while-revalidate", () => {
    fireDiscoveryRevalidate();
    expect(revalidateTag).toHaveBeenCalledWith("discovery", "max");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["discovery"], "swr");
  });

  it("swallows revalidateTag throwing outside a request scope", () => {
    revalidateTag.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => fireOrgRevalidate("my-org")).not.toThrow();
    // Broadcast is unconditional — it must still fire even though the local
    // revalidateTag call above threw (outside-request-scope path).
    expect(broadcastRevalidate).toHaveBeenCalledWith(["org-public:my-org"], "expire");
  });
});

// Task 7 (spec 2026-07-12 §3 A-step 1): a CDN purge must fire alongside the
// peer broadcast at every revalidation seam — otherwise a stray rendering
// change can go un-cached (or a purge can silently stop happening) with no
// test ever catching it. This is a pure wiring check: purgeCdn's own
// behavior (debounce, fail-open, env-gating) is covered by cdn-purge.test.ts.
describe("CDN purge fires alongside peer broadcast (Task 7)", () => {
  it("fireDivisionRevalidate calls purgeCdn", () => {
    fireDivisionRevalidate("d1", "c1");
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });

  it("fireOrgRevalidate calls purgeCdn", () => {
    fireOrgRevalidate("riverside");
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });

  it("fireDiscoveryRevalidate calls purgeCdn", () => {
    fireDiscoveryRevalidate();
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });

  it("fireScoreRevalidate calls purgeCdn", () => {
    fireScoreRevalidate("d1", "c1");
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });
});

// P1 (spectator surface): a SCORE is read-your-own-writes for its division.
// Under "max" the first read after a score is still the pre-score document —
// the smoke hub champion check reads exactly once, and a realtime-triggered
// refresh reads once and then waits for a push that never comes after a
// final. Same reasoning as org chrome above. The competition tag keeps SWR:
// the one entry only it carries is on REVALIDATE_SLOW (public-site/data.ts).
// `usecases/__tests__/score-revalidate-in-request.test.ts` drives this through
// Next's real flush and tag manifest; this pins the call shape.
describe("fireScoreRevalidate (a scoring write)", () => {
  it("expires the division tag now and keeps stale-while-revalidate on the competition", () => {
    fireScoreRevalidate("d1", "c1");
    // Competition FIRST — the order is load-bearing (see fireScoreRevalidate;
    // score-revalidate-in-request.test.ts proves why through Next's manifest).
    expect(revalidateTag.mock.calls).toEqual([
      ["competition:c1", "max"],
      ["division:d1", { expire: 0 }],
    ]);
  });

  it("broadcasts each tag to peers in its own mode", () => {
    fireScoreRevalidate("d1", "c1");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1"], "expire");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["competition:c1"], "swr");
    expect(broadcastRevalidate).toHaveBeenCalledTimes(2);
  });

  it("swallows revalidateTag throwing outside a request scope and still broadcasts", () => {
    revalidateTag.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => fireScoreRevalidate("d1", "c1")).not.toThrow();
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1"], "expire");
  });
});

// News post pages are route-level ISR with no fetch tags — status flips purge
// by PATH (post page + feed) so archive/republish takes effect immediately on
// the serving instance (the CI smoke "archived post page 404s publicly" check
// fails without this).
describe("firePostRevalidate (news post status flips)", () => {
  it("purges the post page and the feed by path", () => {
    firePostRevalidate("riverside", "summer-schedule");
    expect(revalidatePath).toHaveBeenCalledWith("/shared/riverside/news/summer-schedule");
    expect(revalidatePath).toHaveBeenCalledWith("/shared/riverside/news");
  });

  it("swallows revalidatePath throwing outside a request scope, still purges CDN", () => {
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => firePostRevalidate("riverside", "old-notice")).not.toThrow();
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });
});

// Shared cache dual-run (spec 2026-09-24 §6.1, §6.6): `broadcastRevalidate`
// also writes each tag's state to the Redis hash every machine's cache handler
// reads, and resolves only once that write lands or the push bound passes. Here
// it runs for real, with peer fan-out off, against a Redis whose writes the
// test releases by hand.
//
// What these prove is the promise `fireScoreRevalidate` returns. Its one
// production consumer today is `dropNamedPublicDocuments` (entrants.ts,
// divisions.ts), pinned last. `invalidatePublicCache` (scoring.ts) discards the
// promise and gates its push on its own DEL only.
describe("fireScoreRevalidate's promise waits for the shared tag state (dual-run)", () => {
  /** Each HSET_IF_NEWER call stays pending until the test releases it. */
  function heldRedis() {
    const writes: Array<{ tag: string; field: string; release: () => void }> = [];
    return {
      status: "ready",
      writes,
      eval: (_script: string, _n: number, _hash: string, tag: string, field: string) =>
        new Promise((resolve) => {
          writes.push({ tag, field, release: () => resolve(1) });
        }),
    };
  }
  const write = (r: ReturnType<typeof heldRedis>, tag: string) => {
    const w = r.writes.find((x) => x.tag === tag);
    if (!w) throw new Error(`no Redis write for ${tag}`);
    return w;
  };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/peer-revalidate")>("@/lib/peer-revalidate");
    broadcastRevalidate.mockImplementation(actual.broadcastRevalidate);
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    vi.stubEnv("PEER_REVALIDATE", "");
    vi.useFakeTimers();
  });
  afterEach(() => {
    broadcastRevalidate.mockImplementation(async () => {});
    __resetRedisStateForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("a push gated on it goes out only once the division's expiry has landed in Redis", async () => {
    const redis = heldRedis();
    __setRedisForTests(redis);
    const send = vi.fn();

    sendAfterDeleteOrBound(fireScoreRevalidate("d", "c"), send);
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 100);
    expect(redis.writes.map((w) => w.tag).sort()).toEqual(["competition:c", "division:d"]);
    expect(decodeField(write(redis, "division:d").field)).toMatchObject({ stale: expect.any(Number) });
    expect(send, "Redis has not answered").not.toHaveBeenCalled();

    write(redis, "competition:c").release();
    await vi.advanceTimersByTimeAsync(0);
    expect(send, "the competition's write is not the one the push waits on").not.toHaveBeenCalled();

    write(redis, "division:d").release();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it("a Redis that never answers holds the push to the bound, and no longer", async () => {
    const redis = heldRedis();
    __setRedisForTests(redis);
    const send = vi.fn();

    sendAfterDeleteOrBound(fireScoreRevalidate("d", "c"), send);
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it("dropNamedPublicDocuments drops once now, and again only after the division's expiry has landed in Redis", async () => {
    const redis = heldRedis();
    __setRedisForTests(redis);

    dropNamedPublicDocuments(
      { competitionIds: ["c"], divisionIds: ["d"], fixtureIds: [] },
      {},
      fireScoreRevalidate("d", "c"),
    );
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 100);
    expect(cacheDel, "the first DEL does not wait").toHaveBeenCalledTimes(1);

    write(redis, "division:d").release();
    await vi.advanceTimersByTimeAsync(0);
    expect(cacheDel).toHaveBeenCalledTimes(2);
    expect(cacheDel.mock.calls[1]).toEqual(cacheDel.mock.calls[0]);
  });
});
