// Revshare attribution at signup, through the REAL createOrgForUser: the rs_ref
// cookie (written client-side by <RevshareCapture>) is consumed and stamped on the
// new billing GROUP (subscriptions.revshare_ref_code) — for a user's FIRST org only.
// Only next/headers is stubbed: the cookie jar, the one thing a vitest "node"
// environment cannot supply.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const jar = new Map<string, string>();
const deleted: string[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    delete: (n: string) => {
      deleted.push(n);
      jar.delete(n);
    },
    set: vi.fn(),
  }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function newUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`rs-org-${uniq()}@test.local`}, 'Rs Signup', true) returning id`;
  return u.id;
}
/** The ref_code on the billing group the org pays through. */
async function refOf(orgId: string): Promise<string | null> {
  const [r] = await sql<{ revshare_ref_code: string | null }[]>`
    select s.revshare_ref_code from organizations o
      join subscriptions s on s.id = o.subscription_id where o.id = ${orgId}`;
  return r.revshare_ref_code;
}

(HAS_DB ? describe : describe.skip)("revshare attribution at org creation", () => {
  beforeEach(() => {
    jar.clear();
    deleted.length = 0;
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("stamps a valid rs_ref cookie on a first-time user's billing group and clears the cookie", async () => {
    jar.set("rs_ref", "aff_Zq-9_x");
    const org = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
    expect(await refOf(org.id)).toBe("aff_Zq-9_x");
    expect(deleted).toContain("rs_ref");
  });

  it("no cookie -> null (positive pair above)", async () => {
    const org = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
    expect(await refOf(org.id)).toBeNull();
    expect(deleted).not.toContain("rs_ref");
  });

  it.each(["bad code;drop", "a".repeat(65), "has space", ""])(
    "a hostile/malformed cookie %j is never stored",
    async (bad) => {
      jar.set("rs_ref", bad);
      const org = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
      expect(await refOf(org.id)).toBeNull();
    },
  );

  it("an explicit null overrides the cookie and leaves it unconsumed", async () => {
    jar.set("rs_ref", "aff_keep");
    const org = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`, { revshareRefCode: null });
    expect(await refOf(org.id)).toBeNull();
    expect(deleted).not.toContain("rs_ref");
  });

  it("an EXISTING org member cannot claim an affiliate by clicking a link later (H1)", async () => {
    // someone who already belongs to an org — a joined member, not even an owner
    const owner = await newUser();
    const existingOrg = await createOrgForUser(owner, `Rs Host ${uniq()}`);
    const member = await newUser();
    await sql`insert into org_members (org_id, user_id, role) values (${existingOrg.id}, ${member}, 'viewer')`;
    jar.set("rs_ref", "aff_fraud");
    const org = await createOrgForUser(member, `Rs Second ${uniq()}`);
    expect(await refOf(org.id)).toBeNull();
    expect(deleted).toContain("rs_ref"); // consumed, just not honoured
  });

  it("an existing PAYING customer cannot claim an affiliate either (H1)", async () => {
    const payer = await newUser();
    await sql`
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id)
      values (${payer}, 'pro', 'active', ${`cus_rs_${uniq()}`})`;
    jar.set("rs_ref", "aff_fraud");
    const org = await createOrgForUser(payer, `Rs Paid ${uniq()}`);
    expect(await refOf(org.id)).toBeNull();
  });

  it("disabled switch: nothing is stamped and the cookie is left alone (stg)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    jar.set("rs_ref", "aff_stg");
    const org = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
    expect(await refOf(org.id)).toBeNull();
    expect(deleted).not.toContain("rs_ref");
  });

  it("a route-handler jar is emptied by the first creation, so the next signup is unattributed", async () => {
    jar.set("rs_ref", "aff_once");
    const first = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
    const second = await createOrgForUser(await newUser(), `Rs Org ${uniq()}`);
    expect(await refOf(first.id)).toBe("aff_once");
    expect(await refOf(second.id)).toBeNull();
  });
});
