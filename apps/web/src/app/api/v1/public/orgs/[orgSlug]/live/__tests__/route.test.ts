// Spectator W2, Task 15 — the public endpoint the org home's chip island polls.
// This file proves the ROUTE's own job, the way the hub route's `route.test.ts`
// does: wiring to `publicOrgLive`, the v1 envelope, the public cache header,
// the rate limiter, and a 404 reaching the client as a 404. What the usecase
// LISTS and COUNTS is proven against real Postgres in
// `server/public-site/__tests__/org-home-live-db.test.ts`; its Redis key is
// witnessed through this route in `route-cache.test.ts` beside this file.
import { beforeEach, describe, expect, it, vi } from "vitest";
const limiter = vi.hoisted(() => ({ rateLimit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limiter.rateLimit }));
const usecase = vi.hoisted(() => ({ publicOrgLive: vi.fn() }));
vi.mock("@/server/usecases/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/public")>();
  return { ...actual, publicOrgLive: usecase.publicOrgLive };
});
import { GET } from "../route";
import { HttpError } from "@/lib/errors";

const ctx = { params: Promise.resolve({ orgSlug: "riverside" }) };
const body = {
  competitions: [
    { id: "8d0c1c64-3f39-4d5c-9b1f-0d4f3f3a2c11", status: "published", in_play: 2 },
    { id: "1a2b3c4d-0000-4000-8000-000000000002", status: "completed", in_play: 0 },
  ],
};

describe("GET /api/v1/public/orgs/{orgSlug}/live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the usecase's list in the v1 envelope with the public cache header", async () => {
    usecase.publicOrgLive.mockResolvedValue(body);
    const res = await GET(new Request("http://x/api/v1/public/orgs/riverside/live"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    expect(await res.json()).toEqual({ ok: true, data: body, requestId: expect.any(String) });
    expect(usecase.publicOrgLive).toHaveBeenCalledWith("riverside");
  });

  it("an unknown org (a 404 from the usecase) is a 404 envelope, never a 500", async () => {
    usecase.publicOrgLive.mockRejectedValue(new HttpError(404, "organization not found"));
    const res = await GET(new Request("http://x/"), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("calls the per-IP public POLL rate limiter", async () => {
    usecase.publicOrgLive.mockResolvedValue(body);
    await GET(new Request("http://x/api/v1/public/orgs/riverside/live"), ctx);
    expect(limiter.rateLimit).toHaveBeenCalledWith("pubv1poll:unknown", { max: 300, windowSeconds: 60 });
  });
});
