import { describe, expect, it, vi, beforeEach } from "vitest";

const rateLimit = vi.fn(
  async (_key: string, _cfg: { max: number; windowSeconds: number; failClosed?: boolean }) => {},
);
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));

const resolveDeviceLinkToken = vi.fn();
const deviceLinkCoversFixture = vi.fn();
vi.mock("@/server/usecases/device-links", () => ({
  resolveDeviceLinkToken,
  deviceLinkCoversFixture,
}));

const LINK = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  issued_by: "33333333-3333-4333-8333-333333333333",
};
const FIXTURE = "44444444-4444-4444-8444-444444444444";

function req(): Request {
  return new Request("https://example.test/api/v1/fixtures/x/events", {
    headers: { authorization: "Bearer dl_test_token" },
  });
}

describe("device-link refusals are metered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDeviceLinkToken.mockResolvedValue(LINK);
  });

  // The defect: a cross-fixture 403 costs the prober nothing, at either intent.
  it.each(["read", "score"] as const)(
    "meters a cross-fixture refusal at %s intent",
    async (intent) => {
      deviceLinkCoversFixture.mockReturnValue(false);
      const { requireFixtureActor } = await import("@/server/api-v1/auth");

      await expect(requireFixtureActor(req(), FIXTURE, intent)).rejects.toThrow(
        /different fixture/,
      );

      // Placement, not just occurrence: the meter must have been reached, and
      // it can only have been reached BEFORE the throw that ended the call.
      expect(rateLimit).toHaveBeenCalledTimes(1);
      expect(rateLimit.mock.calls[0]?.[0]).toBe(`dlv1-refuse:${LINK.id}`);
    },
  );

  // The pre-existing grant meter must be untouched: same key, same budget,
  // still score-only. Without this row, moving or widening the original call
  // would pass unnoticed.
  it("still meters a granted score exactly once, on the original key", async () => {
    deviceLinkCoversFixture.mockReturnValue(true);
    const { requireFixtureActor } = await import("@/server/api-v1/auth");

    await requireFixtureActor(req(), FIXTURE, "score");

    expect(rateLimit.mock.calls.map((c) => c[0])).toEqual([`dlv1:${LINK.id}`]);
    expect(rateLimit.mock.calls[0]?.[1]).toMatchObject({ max: 10, windowSeconds: 1 });
  });

  // Its negative pair: a granted READ still reaches no meter at all, which is
  // what the intent gate at :259 exists to do.
  it("does not meter a granted read", async () => {
    deviceLinkCoversFixture.mockReturnValue(true);
    const { requireFixtureActor } = await import("@/server/api-v1/auth");

    await requireFixtureActor(req(), FIXTURE, "read");

    expect(rateLimit).not.toHaveBeenCalled();
  });
});
