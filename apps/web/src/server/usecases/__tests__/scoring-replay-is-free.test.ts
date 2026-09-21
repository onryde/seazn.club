import { afterEach, describe, expect, it, vi } from "vitest";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";

const cacheGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cache", async (orig) => ({ ...(await orig<object>()), cacheGet }));

afterEach(() => {
  __setRateLimitCounterForTests(null);
  cacheGet.mockReset();
});

describe("scoreEvent limiter placement", () => {
  it("a cached replay consumes no limiter slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      seen.push(key);
      return seen.length;
    });
    cacheGet.mockResolvedValue({ event: { seq: 7 }, state: {}, outcome: null, status: "in_play" });

    const { scoreEvent } = await import("../scoring");
    const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
    const out = await scoreEvent(auth, "00000000-0000-4000-8000-0000000000ff", {
      expected_seq: 6,
      type: "badminton.rally",
      payload: {},
      idempotency_key: "k-1",
    } as never);

    expect(out).toMatchObject({ status: "in_play" });
    expect(seen).toEqual([]); // the replay short-circuited BEFORE the limiter
  });

  // Positive pair: without this, "consumes no slot" would also pass if the
  // limiter were removed entirely.
  it("a first-time write DOES consume a slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      seen.push(key);
      return seen.length;
    });
    cacheGet.mockResolvedValue(null);

    const { scoreEvent } = await import("../scoring");
    const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
    await scoreEvent(auth, "00000000-0000-4000-8000-0000000000ff", {
      expected_seq: 6,
      type: "badminton.rally",
      payload: {},
      idempotency_key: "k-2",
    } as never).catch(() => undefined); // entitlement/DB failure past the limiter is fine here

    expect(seen).toEqual(["rl:scorev1:00000000-0000-4000-8000-0000000000ff"]);
  });
});
