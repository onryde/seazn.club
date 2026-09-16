// Spectator W2, Task 14 — the public endpoint the player page's island polls.
// Mirrors `competitions/[slug]/hub/__tests__/route.test.ts`: this file proves
// the ROUTE's own job — wiring to `publicPlayerMatches` with all three path
// params, the v1 envelope, the public cache header, the rate limiter, and a
// 404 from the usecase reaching the client as a 404. The usecase's gate and
// cache-aside are `usecases/__tests__/public-player-matches-usecase.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
const limiter = vi.hoisted(() => ({ rateLimit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limiter.rateLimit }));
const usecase = vi.hoisted(() => ({ publicPlayerMatches: vi.fn() }));
vi.mock("@/server/usecases/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/public")>();
  return { ...actual, publicPlayerMatches: usecase.publicPlayerMatches };
});
import { GET } from "../route";
import { HttpError } from "@/lib/errors";

const PERSON = "11111111-2222-3333-4444-555555555555";
const ctx = { params: Promise.resolve({ orgSlug: "riverside", slug: "cup", personId: PERSON }) };
const doc = {
  matches: [
    {
      fixtureId: "f1",
      href: "/shared/riverside/cup/premier/fixtures/f1",
      divisionName: "Premier",
      divisionSlug: "premier",
      scheduledAt: null,
      tz: "UTC",
      opponentName: "Queens",
      line: "54 (40)",
      result: "live",
    },
  ],
  generatedAt: "2026-09-05T12:00:00.000Z",
};
const url = `http://x/api/v1/public/orgs/riverside/competitions/cup/players/${PERSON}/matches`;

describe("GET /api/v1/public/orgs/{org}/competitions/{slug}/players/{personId}/matches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the usecase's document in the v1 envelope with the public cache header", async () => {
    usecase.publicPlayerMatches.mockResolvedValue(doc);
    const res = await GET(new Request(url), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    expect(await res.json()).toEqual({ ok: true, data: doc, requestId: expect.any(String) });
    expect(usecase.publicPlayerMatches).toHaveBeenCalledWith("riverside", "cup", PERSON);
  });

  it("an unknown person, or a private competition, is a 404 envelope — never a 500", async () => {
    usecase.publicPlayerMatches.mockRejectedValue(new HttpError(404, "player not found"));
    const res = await GET(new Request(url), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  // The hub route's own measured case: `@/lib/rate-limit` is mocked, so a
  // removed `await publicRateLimit(req)` survives every other test here.
  it("calls the per-IP public rate limiter before touching the usecase", async () => {
    usecase.publicPlayerMatches.mockResolvedValue(doc);
    await GET(new Request(url), ctx);
    expect(limiter.rateLimit).toHaveBeenCalledWith("pubv1:unknown", { max: 60, windowSeconds: 60 });
  });
});
