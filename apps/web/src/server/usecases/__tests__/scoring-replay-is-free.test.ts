import { afterEach, describe, expect, it, vi } from "vitest";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";

const cacheGet = vi.hoisted(() => vi.fn());
// `cacheEnabled` is mocked TRUE, and that is load-bearing for the fail-open
// case below, not decoration. `rate-limit.ts:60` reads
// `failClosed && cacheEnabled()`; with the REAL one it returns false wherever
// REDIS_URL is unset — which is this suite — so the failClosed branch is never
// reached and a fail-open assertion would pass no matter what policy the bucket
// declared. Verified by mutation: with the real `cacheEnabled`, giving
// REPLAY_LIMIT `failClosed: true` left this file 4/4 green.
const cacheEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/cache", async (orig) => ({ ...(await orig<object>()), cacheGet, cacheEnabled }));

afterEach(() => {
  __setRateLimitCounterForTests(null);
  cacheGet.mockReset();
});

const AUTH = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
const WRITE_BUCKET = "rl:scorev1:";
const REPLAY_BUCKET = "rl:scorereplayv1:";
const REPLAYED = { event: { seq: 7 }, state: {}, outcome: null, status: "in_play" };

const send = (fixtureId: string, key: string) =>
  import("../scoring").then(({ scoreEvent }) =>
    scoreEvent(AUTH, fixtureId, {
      expected_seq: 6,
      type: "badminton.rally",
      payload: {},
      idempotency_key: key,
    } as never),
  );

/** Records every bucket the limiter charges, counting each key independently
 *  so the write and replay buckets cannot mask one another. */
function recordingCounter(seen: string[]) {
  const counts = new Map<string, number>();
  return async (key: string) => {
    seen.push(key);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
}

// "Free" in this file's name has always meant free of a WRITE — no double
// append, and no slot taken from the cadence real scoring shares. It has never
// meant unmetered, and since W1 round 2 it explicitly does not: a replay passes
// its own far more generous ceiling (`REPLAY_LIMIT`), because bounded cost per
// request times an unbounded request count is unbounded, and a `dl_` secret is
// a shareable URL. Both halves are asserted together below rather than in
// separate cases, so neither can be quietly inverted into the other.
describe("scoreEvent limiter placement", () => {
  it("a cached replay spends no WRITE slot, but does spend a replay slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(recordingCounter(seen));
    cacheGet.mockResolvedValue(REPLAYED);

    const out = await send("00000000-0000-4000-8000-0000000000ff", "k-1");

    expect(out).toMatchObject({ status: "in_play" });
    // The half that made the queue drain: the replay short-circuited BEFORE the
    // write limiter, so a retry cannot eat the cadence its own pad needs.
    expect(seen.filter((k) => k.startsWith(WRITE_BUCKET))).toEqual([]);
    // The half added in round 2: it is metered, just not there.
    expect(seen).toEqual([`${REPLAY_BUCKET}00000000-0000-4000-8000-0000000000ff`]);
  });

  // Positive pair: without this, "spends no write slot" would also pass if the
  // write limiter were removed entirely.
  it("a first-time write DOES consume a write slot, and no replay slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(recordingCounter(seen));
    cacheGet.mockResolvedValue(null);

    const err = await send("00000000-0000-4000-8000-0000000000ff", "k-2").catch((e) => e);

    expect(seen).toEqual([`${WRITE_BUCKET}00000000-0000-4000-8000-0000000000ff`]);
    // `seen` alone cannot tell "the limiter charged a slot and ALLOWED" from
    // "charged a slot and REFUSED". A 429 would mean this case never reached the
    // entitlement/DB failure it is written around, and a blanket catch would
    // have hidden exactly that.
    expect((err as { status?: number } | undefined)?.status).not.toBe(429);
  });
});

/** Fires until the limiter refuses and returns how many it ALLOWED through.
 *  "Allowed" means "got past the limiter", not "succeeded" — on the write path
 *  every call still fails afterwards at the entitlement/DB step, which is not a
 *  429 and so does not end the count.
 *
 *  Both ceilings are measured this way and compared against EACH OTHER, so
 *  neither number is typed into this file: `REPLAY_LIMIT` derives its max from
 *  `SCORING_LIMIT` in scoring.ts, and that one multiple is the only place it
 *  lives. Pin the relationship here and a change to either moves both sides
 *  together instead of leaving this suite asserting yesterday's constant. */
async function allowedBeforeRefusal(fire: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const err = await fire().catch((e) => e);
    if ((err as { status?: number } | undefined)?.status === 429) return i;
  }
  throw new Error("no 429 within 500 attempts — the ceiling is missing entirely");
}

describe("the replay ceiling", () => {
  it("is strictly more generous than the write cadence", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(recordingCounter(seen));

    cacheGet.mockResolvedValue(null);
    const writes = await allowedBeforeRefusal(() =>
      send("00000000-0000-4000-8000-0000000000a1", "w"),
    );

    cacheGet.mockResolvedValue(REPLAYED);
    const replays = await allowedBeforeRefusal(() =>
      send("00000000-0000-4000-8000-0000000000a2", "r"),
    );

    // Both ceilings must EXIST — a zero would satisfy the comparison below
    // vacuously if the other side were zero too.
    expect(writes).toBeGreaterThan(0);
    // The property the owner asked for: an abuse ceiling, never a pacing
    // control. Setting REPLAY_LIMIT equal to (or below) SCORING_LIMIT reds here.
    expect(replays).toBeGreaterThan(writes);
  });

  it("fails OPEN when the counter yields no count", async () => {
    // Same policy as the write limiter: a Redis outage must never stop a scorer
    // recording a match. `REPLAY_LIMIT` sets no `failClosed`, so a null count
    // allows — proven by driving far past the ceiling it would otherwise hit.
    __setRateLimitCounterForTests(async () => null);
    cacheGet.mockResolvedValue(REPLAYED);

    for (let i = 0; i < 200; i++) {
      await expect(send("00000000-0000-4000-8000-0000000000a3", "r")).resolves.toMatchObject({
        status: "in_play",
      });
    }
  });
});
