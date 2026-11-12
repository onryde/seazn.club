// Sponsor deals T22 - GET /api/v1/orgs/{id}/sponsor-deals/{dealId}/invoice.pdf: the console's copy of a deal's invoice, over
// the REAL handler, the REAL session door (`requireOrgAuth` against real org_members rows) and the REAL tables. Only
// `requireUser` (who is signed in) is faked, as routes.test.ts beside it does.
//
// What it owns: who may download ("read": a viewer can, the granted pair; an API key cannot, F8, the denied pair), the
// attachment (application/pdf named after the invoice number), and the 404s that hide what is not this org's invoice - a
// complimentary deal (no number), another org's deal, an id that names nothing. The document's contents are invoice-doc.test.ts
// and invoice-pdf.test.ts. Sport-agnostic (a deal reads no sport).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { emailsQueuedWithin } from "@/server/email-outbox";
import { createDeal } from "@/server/usecases/sponsor-deals";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { pdfTextRuns } from "../../../../../../../../e2e/pdf-uris";
import { GET as INVOICE_PDF } from "../[dealId]/invoice.pdf/route";

const HAS_DB = !!process.env.DATABASE_URL;
const made: string[] = [];

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.length > 0) {
    await sql`delete from sponsor_orders where org_id = any(${made}::uuid[])`;
    await sql`delete from sponsor_invoice_counters where org_id = any(${made}::uuid[])`;
    await sql`delete from organizations where id = any(${made}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const get = (orgId: string, dealId: string, headers: HeadersInit = {}) =>
  INVOICE_PDF(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-deals/${dealId}/invoice.pdf`, { headers }), {
    params: Promise.resolve({ id: orgId, dealId }),
  });

/** A fresh org (its owner signed in), a sponsor, a package, and a deal by the REAL createDeal. */
async function orgWithDeal(method: "offline" | "complimentary", sponsorEmail: string | null = null) {
  const { auth } = await seedOrg("community");
  made.push(auth.orgId);
  authState.userId = auth.userId!;
  const [sp] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${auth.orgId}, 'Harbour Bank') returning id`;
  const [pk] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${auth.orgId}, 'Partner', 5000, 'gbp', 'partner') returning id`;
  const { deal } = await createDeal(auth, sp!.id, {
    package_id: pk!.id,
    competition_id: null,
    payment_method: method,
    go_live: method === "complimentary" ? "immediate" : "on_payment",
    sponsor_email: sponsorEmail,
    ends_on: null,
    end_current: false,
  }, "http://localhost");
  return { auth, orgId: auth.orgId, dealId: deal.id, ownerId: auth.userId! };
}

describe.skipIf(!HAS_DB)("the console invoice PDF", () => {
  it("is classified console-only (F8): never key-accessible", () => {
    expect(NEVER_KEY_ROUTES).toContain("GET /orgs/:id/sponsor-deals/:dealId/invoice.pdf");
  });

  it("a VIEWER downloads it ('read'): application/pdf, an attachment named after the number, holding that number", async () => {
    const o = await orgWithDeal("offline");
    const viewer = await makeUser("viewer");
    await sql`insert into org_members (org_id, user_id, role) values (${o.orgId}, ${viewer.id}, 'viewer')`;
    authState.userId = viewer.id;
    const res = await get(o.orgId, o.dealId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="SP-0001.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfTextRuns(body).map((r) => r.text)).toContain("SP-0001");
  });

  it("404 for what is not this org's invoice: another org's NUMBERED deal, an id that names nothing, a complimentary deal (3 counted)", async () => {
    const comp = await orgWithDeal("complimentary");
    const numberOf = async (dealId: string) =>
      (await sql<{ invoice_number: number | null }[]>`select invoice_number from sponsor_orders where id = ${dealId}`)[0]!.invoice_number;
    expect(await numberOf(comp.dealId), "premise: a complimentary deal is never numbered").toBeNull();
    const other = await orgWithDeal("offline");
    const third = await orgWithDeal("offline");
    // Review m5: the cross-org row asks for a deal that HAS an invoice, so only the org boundary can refuse it.
    expect(await numberOf(third.dealId), "premise: the other org's deal is numbered").not.toBeNull();
    // Signed in as `other`'s owner, asking `other`'s org for third's deal, then for nothing; then comp's owner for its own deal.
    let checked = 0;
    for (const [as, orgId, dealId] of [
      [other.ownerId, other.orgId, third.dealId],
      [other.ownerId, other.orgId, randomUUID()],
      [comp.ownerId, comp.orgId, comp.dealId],
    ] as const) {
      authState.userId = as;
      const res = await get(orgId, dealId);
      expect(res.status, `${orgId} ${dealId}`).toBe(404);
      expect(res.headers.get("content-type")).not.toBe("application/pdf");
      checked++;
    }
    expect(checked).toBe(3);
    // The positive pairs: `other`'s own deal downloads, and so does third's, asked by its own owner of its own org.
    authState.userId = other.ownerId;
    expect((await get(other.orgId, other.dealId)).status).toBe(200);
    authState.userId = third.ownerId;
    expect((await get(third.orgId, third.dealId)).status).toBe(200);
  });

  it("final review I1: the club's download rotates nothing and sends nothing - the sponsor's token, the send count and the org's email outbox (what the 50-a-day cap counts) are unchanged by two downloads", async () => {
    const o = await orgWithDeal("offline", "pay@harbour.test");
    const state = async () => {
      const [d] = await sql<{ hash: Buffer | null; sends: number; sent_at: Date | null }[]>`
        select invoice_token_hash as hash, invoice_send_count as sends, invoice_sent_at as sent_at from sponsor_orders where id = ${o.dealId}`;
      const [mail] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where org_id = ${o.orgId}`;
      return { hash: d!.hash?.toString("hex") ?? null, sends: d!.sends, sentAt: d!.sent_at?.toISOString() ?? null, outbox: mail!.n };
    };
    const before = await state();
    expect(before.hash, "premise: createDeal minted the sponsor's token, so a rotation would show").not.toBeNull();
    let downloads = 0;
    for (let i = 0; i < 2; i++) {
      expect((await get(o.orgId, o.dealId)).status).toBe(200);
      downloads++;
    }
    expect(downloads).toBe(2);
    expect(await state(), "the sponsor's link, the sends and the outbox are as they were").toEqual(before);
    expect(await emailsQueuedWithin(o.orgId, "sponsor_invoice", 24), "the daily cap's own count").toBe(0);
  });

  it("an API key is refused (F8), even a manage-scoped one on an org with API access", async () => {
    const o = await orgWithDeal("offline");
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const res = await get(o.orgId, o.dealId, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/^API keys cannot access this endpoint/);
    expect(res.headers.get("content-type")).not.toBe("application/pdf");
  });
});
