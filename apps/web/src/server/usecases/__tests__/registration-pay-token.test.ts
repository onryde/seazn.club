// Player payment page, Task 1 (plan 2026-11-11-player-payment-page): the pay-page token table, the per-entry session pointer
// and the token helpers. A chase mail links `/r/pay/<token>`; the token is 32 random bytes shown once inside that url, and only
// its sha256 is stored (`registration_pay_tokens.token_hash`). Every token for an entry stays valid: the entry's state, not
// token revocation, is what closes the page.
//
// Tokens here come from the REAL producer (`issuePayLink`, which mints through `mintPayToken`), never a hand-inserted hash.
// The expected hash is computed independently with node:crypto, not with the module's own hasher.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { sql, withTenant } from "@/lib/db";
import { registrationPayPath } from "@/lib/registration-pay";
import { issuePayLink, recordPayToken, registrationIdByPayToken } from "../registrations";
import { stripeRig, seedRegistration } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** The token is the url's last path segment: `issuePayLink` hands the raw token out only inside its url. */
function tokenOf(url: string): string {
  const seg = new URL(url).pathname.split("/").pop();
  if (!seg) throw new Error(`no token segment in ${url}`);
  return seg;
}

async function pendingEntry() {
  const rig = await stripeRig();
  const seeded = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, { amountCents: 500 });
  expect(seeded.registration.status).toBe("pending");
  return { orgId: rig.orgId, registrationId: seeded.registration.id };
}

describe.skipIf(!HAS_DB)("registration pay tokens (V510)", () => {
  it("unknown token resolves to null (empty case first)", async () => {
    expect(await registrationIdByPayToken("x".repeat(43))).toBeNull();
    expect(await registrationIdByPayToken("")).toBeNull();
  });

  it("a recorded token resolves to its entry, and only its hash is stored", async () => {
    const { orgId, registrationId } = await pendingEntry();
    const { url, tokenHash } = issuePayLink("https://h");
    const token = tokenOf(url);
    expect(url).toBe(`https://h${registrationPayPath(token)}`);
    expect(url).toBe(`https://h/r/pay/${token}`);

    await recordPayToken(sql, { tokenHash, registrationId, orgId });
    expect(await registrationIdByPayToken(token)).toBe(registrationId);

    const rows = await sql<{ token_hash: Buffer; row: string }[]>`
      select t.token_hash, row_to_json(t)::text as row
        from registration_pay_tokens t where t.registration_id = ${registrationId}`;
    expect(rows).toHaveLength(1);
    const expected = createHash("sha256").update(token).digest();
    expect(Buffer.compare(rows[0].token_hash, expected)).toBe(0);
    expect(Buffer.compare(tokenHash, expected)).toBe(0);
    // No column holds the raw token (row_to_json renders bytea as hex, so the base64url token cannot hide in it either).
    expect(rows[0].row).not.toContain(token);
  });

  it("two links for one entry both resolve", async () => {
    const { orgId, registrationId } = await pendingEntry();
    const a = issuePayLink("https://h");
    const b = issuePayLink("https://h");
    await recordPayToken(sql, { tokenHash: a.tokenHash, registrationId, orgId });
    await recordPayToken(sql, { tokenHash: b.tokenHash, registrationId, orgId });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_pay_tokens where registration_id = ${registrationId}`;
    expect(n).toBe(2);
    const tokens = [tokenOf(a.url), tokenOf(b.url)];
    expect(tokens[0]).not.toBe(tokens[1]);
    let resolved = 0;
    for (const t of tokens) {
      expect(await registrationIdByPayToken(t)).toBe(registrationId);
      resolved++;
    }
    expect(resolved).toBe(2);
  });

  it("token is 43 base64url chars", () => {
    const { url } = issuePayLink("https://h");
    expect(tokenOf(url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("app_user under another org cannot read the row", async () => {
    const a = await pendingEntry();
    const b = await pendingEntry();
    const link = issuePayLink("https://h");
    await withTenant(a.orgId, (tx) =>
      recordPayToken(tx, { tokenHash: link.tokenHash, registrationId: a.registrationId, orgId: a.orgId }),
    );

    const count = (orgId: string) =>
      withTenant(orgId, async (tx) => {
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from registration_pay_tokens where token_hash = ${link.tokenHash}`;
        return n;
      });
    expect(await count(b.orgId)).toBe(0);
    // The positive pair: the row is there, and its own org reads it.
    expect(await count(a.orgId)).toBe(1);
  });

  it("pay_session_id exists and defaults null", async () => {
    const { registrationId } = await pendingEntry();
    const rows = await sql<{ pay_session_id: string | null }[]>`
      select pay_session_id from registrations where id = ${registrationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].pay_session_id).toBeNull();
  });
});
