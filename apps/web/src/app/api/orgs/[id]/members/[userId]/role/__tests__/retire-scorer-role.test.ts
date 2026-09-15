// #707 Task 6 — org-member scorer role is gone at every layer: the API schema
// refuses it before SQL, and V404's CHECK refuses it if something bypasses the
// route. `ORG_ROLES` is the compile-time tripwire — restoring "scorer" there
// would reopen every invite/UI surface without a migration.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { ORG_ROLES, type User } from "@/lib/types";

const HAS_DB = !!process.env.DATABASE_URL;

const fakeOwner: User = {
  id: randomUUID(),
  display_name: "Owner",
  email: "owner@test.local",
  avatar_url: null,
  timezone: null,
  locale: null,
};

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireOrgRole: vi.fn(async () => ({ user: fakeOwner, role: "owner" as const })),
    invalidateUserOrgs: vi.fn(async () => {}),
  };
});

import { POST } from "../route";

async function seedOrgWithMember(): Promise<{ orgId: string; memberId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Retire Scorer " + suffix}, ${"retire-scorer-" + suffix})
    returning id`;
  const [{ id: memberId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${"member-" + suffix + "@test.local"}, 'Member')
    returning id`;
  await sql`
    insert into org_members (org_id, user_id, role)
    values (${orgId}, ${memberId}, 'viewer')`;
  return { orgId, memberId };
}

function roleReq(body: unknown): Request {
  return new Request("http://localhost/api/orgs/x/members/y/role", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("ORG_ROLES — scorer retired (#707)", () => {
  it("excludes scorer so invite/UI schemas cannot resurrect it without a deliberate edit", () => {
    expect(ORG_ROLES).not.toContain("scorer");
  });
});

describe.skipIf(!HAS_DB)("POST /api/orgs/{id}/members/{userId}/role — scorer role refused", () => {
  it("returns 400 when role is scorer (zod rejects before SQL)", async () => {
    const { orgId, memberId } = await seedOrgWithMember();
    const res = await POST(roleReq({ role: "scorer" }), {
      params: Promise.resolve({ id: orgId, userId: memberId }),
    });
    expect(res.status).toBe(400);
    const [{ role }] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${memberId}`;
    expect(role).toBe("viewer");
  });

  it("org_members CHECK rejects role scorer on direct insert (V404 applied)", async () => {
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'org_members_role_check'`;
    expect(
      check?.def.includes("'scorer'"),
      "V404__retire_scorer_role.sql must be applied before this suite runs",
    ).toBe(false);

    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values (${"Check " + suffix}, ${"check-" + suffix}) returning id`;
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name)
      values (${"check-" + suffix + "@test.local"}, 'Check')
      returning id`;
    await expect(
      sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'scorer')`,
    ).rejects.toThrow(/check|violates/i);
  });
});
