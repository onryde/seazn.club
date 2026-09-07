// W8/F5 (partial): a Stripe outage on /settings/billing must not be SILENT.
//
// `getBillingOverview` is best-effort by design — it swallows a failed live
// Stripe read and returns null, and the page then renders as if the org had no
// Stripe customer at all. That behaviour is deliberate and UNCHANGED here; what
// was missing is any trace of it. An outage looked, in the logs, exactly like a
// community org visiting the page.
//
// The pair below is the point: the fetch-failed `return null` logs, and the
// legitimate "this org has no Stripe customer" `return null` — a different
// early return, ABOVE the try — stays quiet. A log line hoisted out of the
// catch would satisfy the first test and fail the second.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is mocked (the
// suite never has a key). Seeds are run-unique (randomUUID) and torn down in
// afterAll.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({
  retrieveCustomer: vi.fn(),
  listPaymentMethods: vi.fn(),
  listInvoices: vi.fn(),
  listTaxIds: vi.fn(),
  retrieveSubscription: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listPaymentMethods: stripeMock.listPaymentMethods,
      listTaxIds: stripeMock.listTaxIds,
    },
    invoices: { list: stripeMock.listInvoices },
    subscriptions: { retrieve: stripeMock.retrieveSubscription },
  }),
}));

// Whole-module mock rather than vi.spyOn: `log` is a module-scope pino
// singleton, and a spy on it outlives the test unless the file restores it —
// a later "we logged it" assertion then passes on an EARLIER test's call.
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { sql } from "@/lib/db";
import { getBillingOverview } from "../billing-manage";

const HAS_DB = !!process.env.DATABASE_URL;
const orgIds: string[] = [];
const userIds: string[] = [];

/** An org whose subscription row carries (or does not carry) a Stripe customer. */
async function seedOrg(customerId: string | null): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`f5-${suffix}@test.local`}, 'F5 Owner', true) returning id`;
  userIds.push(ownerId);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"F5 Org " + suffix}, ${"f5-org-" + suffix}, ${ownerId}) returning id`;
  orgIds.push(orgId);
  await sql`
    with s as (
      insert into subscriptions
        (owner_user_id, plan_key, status, stripe_customer_id, stripe_subscription_id)
      values (${ownerId}, 'pro', 'active', ${customerId}, null)
      returning id
    )
    update organizations o set subscription_id = s.id from s where o.id = ${orgId}`;
  return orgId;
}

/** Everything the live read fetches, all healthy. */
function stripeAllOk(customerId: string) {
  stripeMock.retrieveCustomer.mockResolvedValue({
    id: customerId,
    deleted: false,
    balance: 0,
    name: null,
    address: null,
    invoice_settings: { default_payment_method: null },
  });
  stripeMock.listPaymentMethods.mockResolvedValue({ data: [] });
  stripeMock.listInvoices.mockResolvedValue({ data: [] });
  stripeMock.listTaxIds.mockResolvedValue({ data: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`update organizations set subscription_id = null where id = any(${orgIds})`;
    await sql`delete from subscriptions where owner_user_id = any(${userIds})`;
    await sql`delete from organizations where id = any(${orgIds})`;
    await sql`delete from users where id = any(${userIds})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getBillingOverview: a Stripe outage is logged, not silent", () => {
  it("logs the failed live read — with the org it happened to — and still returns null", async () => {
    const customerId = `cus_f5_${randomUUID().slice(0, 8)}`;
    const orgId = await seedOrg(customerId);
    stripeAllOk(customerId);
    const outage = new Error("Stripe is unreachable");
    stripeMock.retrieveCustomer.mockRejectedValue(outage);

    // The page's contract is unchanged: it still degrades to the no-customer
    // render rather than throwing.
    expect(await getBillingOverview(orgId)).toBeNull();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    const [fields, message] = logMock.error.mock.calls[0];
    expect(fields).toMatchObject({ err: outage, orgId });
    expect(message).toBe("getBillingOverview: Stripe fetch failed, rendering as no-customer");
  });

  it("stays quiet for an org that simply has no Stripe customer", async () => {
    // The OTHER `return null` — an early return above the try. It is not a
    // failure and must not read as one in the logs, or the new line is noise
    // on every community org's billing page visit.
    const orgId = await seedOrg(null);

    expect(await getBillingOverview(orgId)).toBeNull();

    expect(logMock.error).not.toHaveBeenCalled();
  });
});
