// GET /api/users/identity: who the visitor is, for the analytics bootstrap. Unlike GET /api/users/me it answers an
// anonymous visitor with 200 and no identity, because a 401 is logged by the browser as a console error on every public
// page (found by Lighthouse on the marketing pages, 2026-11-16).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { OrgMembership, User } from "@/lib/types";

const user: User = { id: randomUUID(), display_name: "Identity Route Test", email: "identity-route@test.local", avatar_url: null, timezone: null, locale: null };
const org = { id: randomUUID(), name: "Riverside" } as OrgMembership;

const getCurrentUser = vi.fn<() => Promise<User | null>>();
const resolveActiveOrg = vi.fn<(u: User) => Promise<OrgMembership | null>>();
const planOf = vi.fn<(orgId: string) => Promise<string>>();
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => getCurrentUser(), resolveActiveOrg: (u: User) => resolveActiveOrg(u) }));
// The one query behind the payload is the plan lookup; it is answered here so the file needs no database. The value
// it receives is the organisation id, which the test checks.
vi.mock("@/lib/db", () => ({
  sql: async (_strings: TemplateStringsArray, orgId: string) => [{ plan_key: await planOf(orgId) }],
}));

const { GET } = await import("../route");
const NO_STORE = "private, no-store";

beforeEach(() => {
  getCurrentUser.mockReset();
  resolveActiveOrg.mockReset();
  planOf.mockReset();
});

describe("GET /api/users/identity", () => {
  it("an anonymous visitor gets 200 with no identity, never a 401, and it is not cacheable", async () => {
    getCurrentUser.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ ok: true, data: null });
    // No session means no lookups at all.
    expect(resolveActiveOrg).not.toHaveBeenCalled();
    expect(planOf).not.toHaveBeenCalled();
  });

  it("a signed-in member gets the minimised { id, org } payload, with no email", async () => {
    getCurrentUser.mockResolvedValueOnce(user);
    resolveActiveOrg.mockResolvedValueOnce(org);
    planOf.mockResolvedValueOnce("pro");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const json = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(json).toEqual({ ok: true, data: { id: user.id, org: { id: org.id, name: org.name, plan: "pro" } } });
    expect(planOf).toHaveBeenCalledWith(org.id);
    expect(JSON.stringify(json)).not.toContain(user.email);
  });

  it("a signed-in user with no organisation gets org: null", async () => {
    getCurrentUser.mockResolvedValueOnce(user);
    resolveActiveOrg.mockResolvedValueOnce(null);
    const res = await GET();
    expect(await res.json()).toEqual({ ok: true, data: { id: user.id, org: null } });
    expect(planOf).not.toHaveBeenCalled();
  });
});
