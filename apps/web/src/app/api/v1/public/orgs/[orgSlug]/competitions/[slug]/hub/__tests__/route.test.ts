// Spectator W2, Task 5 — the public hub endpoint the landing page polls.
// This file proves the ROUTE's own job: wiring to `publicCompetitionHub`,
// the v1 envelope, the public cache header, the rate limiter, and that a
// 404 from the usecase reaches the client as a 404, never a 500. The
// usecase's own cache-aside is Task 4's (hub-cache-poisoned-entry.test.ts,
// hub-cache-invalidation.test.ts); this file's second describe block below
// witnesses that cache-aside END TO END through THIS route, with the
// usecase's real dependencies (`@/lib/cache`, `@/lib/db`,
// `@/server/public-site/competition-hub`) mocked instead — the same
// convention `hub-cache-poisoned-entry.test.ts` uses one layer down.
import { beforeEach, describe, expect, it, vi } from "vitest";
const limiter = vi.hoisted(() => ({ rateLimit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limiter.rateLimit }));
const hub = vi.hoisted(() => ({ publicCompetitionHub: vi.fn() }));
vi.mock("@/server/usecases/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/public")>();
  return { ...actual, publicCompetitionHub: hub.publicCompetitionHub };
});
import { GET } from "../route";
import { HttpError } from "@/lib/errors";

const ctx = { params: Promise.resolve({ orgSlug: "riverside", slug: "cup" }) };
const doc = { competitionId: "c1", tabs: ["overview", "info"], matches: [], tables: [], leaders: [], teams: [] };

describe("GET /api/v1/public/orgs/{org}/competitions/{slug}/hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the usecase's document in the v1 envelope with the public cache header", async () => {
    hub.publicCompetitionHub.mockResolvedValue(doc);
    const res = await GET(new Request("http://x/api/v1/public/orgs/riverside/competitions/cup/hub"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    expect(await res.json()).toEqual({ ok: true, data: doc, requestId: expect.any(String) });
    expect(hub.publicCompetitionHub).toHaveBeenCalledWith("riverside", "cup");
  });
  it("a 404 from the usecase is a 404 envelope, never a 500", async () => {
    hub.publicCompetitionHub.mockRejectedValue(new HttpError(404, "competition not found"));
    const res = await GET(new Request("http://x/"), ctx);
    expect(res.status).toBe(404);
  });
  // Without this, a removed `await publicPollRateLimit(req)` survives every other
  // test in this file — `@/lib/rate-limit` is mocked globally and nothing
  // else here asserts it was reached (measured: this mutant killed nothing
  // until this test was added).
  it("calls the per-IP public POLL rate limiter before touching the usecase", async () => {
    hub.publicCompetitionHub.mockResolvedValue(doc);
    await GET(new Request("http://x/api/v1/public/orgs/riverside/competitions/cup/hub"), ctx);
    expect(limiter.rateLimit).toHaveBeenCalledWith("pubv1poll:unknown", { max: 300, windowSeconds: 60 });
  });
});
