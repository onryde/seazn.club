// A Match Day code (`md_…`, capture S4 design §3; MD-1 Task 1) opens only the md_ routes, which resolve it themselves.
// Every organiser door refuses it with a 403 BEFORE it looks at the session — never a 401 from a fall-through to the
// cookie (Review Focus 5). No DB: the refusal comes before any lookup, and the session reader here fails loudly if reached.
import { describe, expect, it, vi } from "vitest";

const reachedSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => {
      reachedSession();
      throw new Error("the session was read: an md_ bearer fell through");
    },
  };
});

import { HttpError } from "@/lib/errors";
import { requireAuth, requireFixtureActor, requireOrgAuth } from "@/server/api-v1/auth";

const ORG = "22222222-2222-4222-8222-222222222222";
const FIXTURE = "44444444-4444-4444-8444-444444444444";
const MD = "md_" + "A".repeat(43);

const req = (token: string): Request =>
  new Request("https://example.test/api/v1/x", { headers: { authorization: `Bearer ${token}` } });

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("not refused");
}

describe("an md_ bearer on an organiser door", () => {
  it.each([
    ["requireOrgAuth write", () => requireOrgAuth(req(MD), ORG, "write")],
    ["requireOrgAuth read", () => requireOrgAuth(req(MD), ORG, "read")],
    ["requireAuth", () => requireAuth(req(MD), "read")],
    ["requireFixtureActor score", () => requireFixtureActor(req(MD), FIXTURE, "score")],
    ["requireFixtureActor read", () => requireFixtureActor(req(MD), FIXTURE, "read")],
  ])("%s is 403, before the session", async (_name, call) => {
    reachedSession.mockClear();
    const e = await refusal(call());
    expect(e.status).toBe(403);
    expect(reachedSession).not.toHaveBeenCalled();
  });
});
