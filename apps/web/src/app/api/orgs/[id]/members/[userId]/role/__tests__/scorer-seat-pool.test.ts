// V393 (entitlements v18 W2 T12, owner ruling 2026-09-03): `scorers.max` is
// deleted from `plan_entitlements`, and the two enforcement branches that read
// it fall back to `members.max`.
//
// THE TRAP THIS FILE EXISTS FOR. `getLimit` resolves a key with NO ROW to 0
// (`const base = row ? row.int_value : 0`, lib/entitlements.ts) — deleting an
// int key DENIES it, it does not free it. A migration that removed the row and
// left `quotaKey = role === "scorer" ? "scorers.max" : "members.max"` in place
// would refuse EVERY scorer promotion with a 402, which is the exact inverse of
// the ruling. So the first assertion here is that a promotion the old cap
// allowed still succeeds, and the second is that the refusal, when it comes,
// names `members.max` rather than a key that no longer exists.
//
// THE POOLS STAY SEPARATE, and that is deliberate: design §2 records the
// alternative ("merging into staff seats would let scorers eat the 10 staff")
// as REJECTED. What changed is where the number comes from, not how the seats
// are counted — the scorer seat is no longer separately SOLD, so it draws the
// same figure as the staff seat.
//
// Real handler, real DB, real `getLimit`. Only the session door is faked
// (`requireOrgRole` / `invalidateUserOrgs`), the same pattern as
// api/v1/officials/[id]/availability/__tests__/route.test.ts — authz is not
// what is under test here, the seat pool is.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireOrgRole: async () => undefined,
    invalidateUserOrgs: async () => undefined,
  };
});

import { sql } from "@/lib/db";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

/** The cap, READ from the live matrix — never typed. It has moved three times
 *  (V319 members 5, V391 members 3, V393 deleted the scorer pool's own key),
 *  and a stale literal turns every "expect 402" into an accept. */
async function communityCap(key: string): Promise<number> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = ${key}`;
  expect(row?.int_value, `${key} must be a finite community cap`).toBeTypeOf("number");
  return row!.int_value!;
}

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedCommunityOrg(): Promise<{ orgId: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"T12 " + suffix}, ${"t12-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { orgId, ownerId };
}

async function addMember(orgId: string, role: string): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

interface Body {
  ok: boolean;
  feature_key?: string;
  reason?: string;
}

async function setRole(
  orgId: string,
  userId: string,
  role: string,
): Promise<{ status: number; body: Body }> {
  const res = await POST(
    new Request("https://test.local/api/orgs/x/members/y/role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
    { params: Promise.resolve({ id: orgId, userId }) },
  );
  return { status: res.status, body: (await res.json()) as Body };
}

describe.skipIf(!HAS_DB)("V393: the scorer seat draws on members.max", () => {
  it("`scorers.max` has no row on any plan, so getLimit would resolve it to 0", async () => {
    const rows = await sql<{ plan_key: string }[]>`
      select plan_key from plan_entitlements where feature_key = 'scorers.max'`;
    expect(rows, "V393 deletes the key; a surviving row means the deletion regressed").toEqual([]);
    const overrides = await sql<{ org_id: string }[]>`
      select org_id from org_entitlement_overrides where feature_key = 'scorers.max'`;
    expect(overrides).toEqual([]);
  });

  it("promotes a member to scorer instead of denying it at the deleted key's 0", async () => {
    const { orgId } = await seedCommunityOrg();
    const member = await addMember(orgId, "viewer");
    const res = await setRole(orgId, member, "scorer");
    // The whole point: 200, not the 402 a leftover `scorers.max` read produces.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${member}`;
    expect(row!.role).toBe("scorer");
  });

  it("refuses the promotion past members.max's cap, naming members.max", async () => {
    const cap = await communityCap("members.max");
    const { orgId } = await seedCommunityOrg();
    // Fill the scorer pool to the cap the members.max figure now sets. Each of
    // these is a promotion, so the accepts are load-bearing too: a run that
    // 402s early fails here rather than passing the refusal below vacuously.
    for (let i = 0; i < cap; i += 1) {
      const m = await addMember(orgId, "viewer");
      const ok = await setRole(orgId, m, "scorer");
      expect(ok.status, `promotion ${i + 1} of ${cap} should fit`).toBe(200);
    }
    const overflow = await addMember(orgId, "viewer");
    const refused = await setRole(orgId, overflow, "scorer");
    expect(refused.status).toBe(402);
    expect(refused.body.feature_key).toBe("members.max");
    // …and the member is unchanged: the refusal happened inside the tx.
    const [row] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${overflow}`;
    expect(row!.role).toBe("viewer");
  });

  it("demoting a scorer back to a staff role is charged the staff pool, also members.max", async () => {
    const cap = await communityCap("members.max");
    const { orgId } = await seedCommunityOrg();
    // The owner already holds one staff seat; fill the rest.
    for (let i = 0; i < cap - 1; i += 1) await addMember(orgId, "viewer");
    const scorer = await addMember(orgId, "scorer");
    const refused = await setRole(orgId, scorer, "viewer");
    expect(refused.status).toBe(402);
    expect(refused.body.feature_key).toBe("members.max");
  });

  afterAll(async () => {
    if (HAS_DB) await sql.end({ timeout: 5 });
  });
});
