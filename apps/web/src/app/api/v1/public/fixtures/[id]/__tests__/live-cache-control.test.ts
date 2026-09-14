// Pin live Cache-Control on the response the route ACTUALLY sends. Review
// 2026-09-14 (I8): the previous version only `readFileSync`'d the route
// source and regex-matched for the constant, which would pass on a route that
// declared `LIVE_CACHE_CONTROL` and never once put it on a response. This
// calls the real exported `GET` (the pattern `route-cache.test.ts` and
// `overlay/__tests__/route.test.ts` in this tree use) and reads the header off
// the real `Response`.
//
// Both routes' own data loaders are mocked so this file needs no DATABASE_URL
// — `publicFixture` (this route) and `loadOverlayLiveData` (the overlay twin)
// are the only two seams between the route and the database.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

const publicFixture = vi.hoisted(() => vi.fn(async () => ({ id: "fx-1" })));
vi.mock("@/server/usecases/public", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/public")>()),
  publicFixture,
}));

const loadOverlayLiveData = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "scheduled",
    summary: null,
    outcome: null,
    lastSeq: null,
    venueTz: "UTC",
  })),
);
vi.mock("@/server/overlay/load", () => ({ loadOverlayLiveData }));

import { GET as GET_FIXTURE } from "../route";
import { GET as GET_OVERLAY } from "../overlay/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) => new Request(`https://test.local/api/v1/public/fixtures/${id}`);

const EXPECTED = "public, s-maxage=2, stale-while-revalidate=30";

describe("live public fixture Cache-Control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicFixture.mockResolvedValue({ id: "fx-1" });
    loadOverlayLiveData.mockResolvedValue({
      status: "scheduled",
      summary: null,
      outcome: null,
      lastSeq: null,
      venueTz: "UTC",
    });
  });

  it("fixture summary route's real 200 response carries the short public header", async () => {
    const res = await GET_FIXTURE(req("fx-1"), ctx("fx-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(EXPECTED);
    // Never the private/no-store this route regressed to (I9) — a route that
    // set BOTH headers (e.g. appended rather than replaced) must still fail.
    expect(res.headers.get("Cache-Control")).not.toContain("no-store");
  });

  it("overlay route's real 200 response carries the SAME short public header", async () => {
    const res = await GET_OVERLAY(req("fx-1"), ctx("fx-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(EXPECTED);
    expect(res.headers.get("Cache-Control")).not.toContain("no-store");
  });
});
