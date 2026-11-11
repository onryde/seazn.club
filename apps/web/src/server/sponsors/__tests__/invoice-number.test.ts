// Sponsor deals, Task 20 (plan 2026-11-07-sponsor-deals D11, F10; spec §7 "Invoice numbers run per org, in sequence, and are
// never reused"): the per-org invoice counter, its allocator, the format, the prune fence, and createDeal numbering online and
// offline deals inside its own transaction.
//
// Where each expected value comes from: the spec and the brief (per org, from 1, in sequence; online and offline are numbered,
// complimentary never; "SP-" and four digits: 1 → SP-0001, 9999 → SP-9999, 12345 → SP-12345), never read back from the code.
// The sequence, not just the feature: the empty case first (a new org's first number is 1), a second call, another org, ten at
// once, a rolled-back allocation, a refused create, a create that fails inside its transaction, and a deal ended (End now) —
// its number is kept, never reused. "Another sport" is not applicable: sponsors read no sport key. Real Postgres.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Stripe and the mail transport are the two network seams an online create reaches (it sends its invoice after it commits).
const stripeMock = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeMock.create, retrieve: stripeMock.retrieve, expire: stripeMock.expire } } }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_test" })) }));

import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { formatInvoiceNumber, type GoLiveRule, type PaymentMethod } from "@/lib/sponsor-deals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { createDeal, endDealNow, getDeal, type CreateDealInput } from "@/server/usecases/sponsor-deals";
import { allocateInvoiceNumber } from "../invoice-number";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const ORIGIN = "https://invoice-number.test";

beforeEach(() => {
  stubOutboxEnv();
  stripeMock.create.mockReset().mockImplementation(async () => ({
    id: `cs_${uniq()}`, url: `https://checkout.stripe.test/${uniq()}`, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  }));
  stripeMock.retrieve.mockReset();
  stripeMock.expire.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    // The counter and the deals RESTRICT their org.
    await sql`delete from sponsor_invoice_counters where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A bare org (the allocator's own cases). */
async function bareOrg(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Numbers Org', ${`numbers-${uniq()}`}) returning id`;
  made.orgIds.push(id);
  return id;
}

/** The org's counter as stored: null when it has none (it has numbered nothing). */
const counter = async (orgId: string): Promise<number | null> =>
  (await sql<{ last_number: number }[]>`select last_number from sponsor_invoice_counters where org_id = ${orgId}`)[0]?.last_number ?? null;

/** One allocation in its own tenant transaction, committed. */
const allocate = (orgId: string): Promise<number> => withTenant(orgId, (tx) => allocateInvoiceNumber(tx, orgId));

// ---- the format (no DB) --------------------------------------------------------------------------------------------------------
describe("formatInvoiceNumber (D11): SP- and at least four digits", () => {
  it("1 → SP-0001, 9999 → SP-9999, 12345 → SP-12345: padded to four, never cut (count reported)", () => {
    const CASES: [number, string][] = [[1, "SP-0001"], [9999, "SP-9999"], [12345, "SP-12345"]];
    let checked = 0;
    for (const [n, shown] of CASES) {
      expect(formatInvoiceNumber(n), String(n)).toBe(shown);
      checked++;
    }
    expect(checked, "numbers checked").toBe(3);
  });

  it("refuses what the allocator never hands out — 0, a negative, a fraction — rather than print SP-0000 (count reported)", () => {
    let checked = 0;
    for (const n of [0, -1, 1.5]) {
      expect(() => formatInvoiceNumber(n), String(n)).toThrow(RangeError);
      checked++;
    }
    expect(checked, "non-numbers checked").toBe(3);
  });
});

// ---- the allocator -----------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("allocateInvoiceNumber: one counter per org, in sequence, inside the caller's transaction", () => {
  it("empty first: a new org has no counter, and its first number is 1 (the counter then reads 1)", async () => {
    const o = await bareOrg();
    expect(await counter(o), "no counter before the first number").toBeNull();
    expect(await allocate(o)).toBe(1);
    expect(await counter(o)).toBe(1);
  });

  it("org A and org B interleaved each run their own sequence: A 1, 2, 3 and B 1, 2", async () => {
    const a = await bareOrg();
    const b = await bareOrg();
    const got: { a: number[]; b: number[] } = { a: [], b: [] };
    for (const which of ["a", "b", "a", "b", "a"] as const) got[which].push(await allocate(which === "a" ? a : b));
    expect(got).toEqual({ a: [1, 2, 3], b: [1, 2] });
    expect([await counter(a), await counter(b)]).toEqual([3, 2]);
  });

  it("10 concurrent allocations for one org answer exactly {1..10}: no number twice, none skipped (the race, with at least 2 transactions proven open at once)", async () => {
    const o = await bareOrg();
    // The race is real only if transactions OVERLAP: run one after another (a pool of one connection, or a loop), ten allocations
    // pass even for an allocator that reads the counter and then writes it. So no allocation runs until BARRIER transactions are
    // open at the same time, each holding its own connection; a run that never gets there fails here by name instead of passing
    // as a race it never ran. 2 is the least overlap that races, and fits the pool's default of 5 (lib/db.ts DB_POOL_MAX).
    const BARRIER = 2;
    let inFlight = 0;
    let peak = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const neverOpened = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the barrier never opened: at most ${peak} transaction(s) were open at once, so the allocations ran one after another and raced nothing`)), 20_000);
    });
    let got: number[];
    try {
      got = await Promise.all(Array.from({ length: 10 }, () => withTenant(o, async (tx) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (inFlight >= BARRIER) open();
        try {
          await Promise.race([opened, neverOpened]);
          return await allocateInvoiceNumber(tx, o);
        } finally {
          inFlight--;
        }
      })));
    } finally {
      clearTimeout(timer);
    }
    expect(peak, "transactions open at once (the overlap the race needs)").toBeGreaterThanOrEqual(BARRIER);
    expect(got.length, "allocations made").toBe(10);
    expect([...got].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await counter(o)).toBe(10);
  });

  it("a rolled-back allocation leaves the counter where it was: the next allocation answers the same number; its committed twin moves it", async () => {
    const o = await bareOrg();
    expect(await allocate(o), "a committed allocation").toBe(1);
    let inside: number | null = null;
    await expect(withTenant(o, async (tx) => {
      inside = await allocateInvoiceNumber(tx, o);
      throw new Error("the caller's transaction fails after allocating");
    })).rejects.toThrow("the caller's transaction fails after allocating");
    expect(inside, "the rolled-back transaction saw the next number").toBe(2);
    expect(await counter(o), "unmoved by the rollback").toBe(1);
    expect(await allocate(o), "the same number again").toBe(2);
    expect(await counter(o)).toBe(2);
  });

  it("under another org's tenant, an allocation is refused by RLS (42501) and moves neither counter", async () => {
    const a = await bareOrg();
    const b = await bareOrg();
    expect(await allocate(b)).toBe(1);
    await expect(withTenant(a, (tx) => allocateInvoiceNumber(tx, b))).rejects.toMatchObject({ code: "42501" });
    expect([await counter(a), await counter(b)]).toEqual([null, 1]);
  });
});

// ---- the prune fence ---------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("the prune fence: a numbered invoice is never deleted by its own org (app_user)", () => {
  it("each deletable kind of deal, once numbered, is fenced (0 rows); its unnumbered twin is deleted (count reported)", async () => {
    const orgId = await bareOrg();
    const [{ id: packageId }] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${orgId}, 'Partner', 25000, 'gbp', 'partner')
      returning id`;
    // Kinds the V495 fence admits (no money paid or refunded, no stored session, not legacy) — typed from its header.
    const KINDS: [string, Record<string, unknown>][] = [
      ["a draft (online, its invoice never sent)", { deal_status: "draft", payment_method: "online", sponsor_email: "pay@acme.test" }],
      ["an offline deal awaiting payment", {}],
      ["a live offline deal still unpaid", { deal_status: "live", go_live: "immediate", live_at: new Date() }],
      ["an unpaid deal that ended", { deal_status: "ended", ended_at: new Date(), ended_reason: "ended_now" }],
    ];
    const insert = async (over: Record<string, unknown>): Promise<string> => {
      const [{ id: sponsorId }] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${orgId}, ${`Acme ${uniq()}`}) returning id`;
      const row: Record<string, unknown> = {
        org_id: orgId, package_id: packageId, sponsor_name: "Acme", sponsor_email: null, amount_cents: 25000, currency: "gbp",
        status: "pending", sponsor_id: sponsorId, deal_status: "awaiting_payment", payment_method: "offline", go_live: "on_payment",
        tier: "partner", includes_on_stream: false, package_name: "Partner", competition_id: null, ...over,
      };
      const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
      return r!.id;
    };
    const tenantDelete = async (id: string): Promise<number> =>
      (await withTenant(orgId, (tx) => tx`delete from sponsor_orders where id = ${id} returning id`)).length;
    let checked = 0;
    for (const [i, [label, over]] of KINDS.entries()) {
      const numbered = await insert({ ...over, invoice_number: i + 1 });
      const twin = await insert(over);
      expect(await tenantDelete(numbered), `${label}, numbered: fenced`).toBe(0);
      expect(await tenantDelete(twin), `${label}, unnumbered: deleted`).toBe(1);
      expect((await sql`select invoice_number from sponsor_orders where id = ${numbered}`)[0], `${label}: the numbered deal stays`)
        .toEqual({ invoice_number: i + 1 });
      checked++;
    }
    expect(checked, "deal kinds checked").toBe(KINDS.length);
    expect(checked).toBe(4);
  });
});

// ---- createDeal ------------------------------------------------------------------------------------------------------------------
interface Org {
  orgId: string;
  auth: AuthCtx;
}

/** A Pro org (online selling is `sponsors.monetize`) with a Connect account that can take charges, edited by a real user. */
async function dealOrg(): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`numbers-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Numbers ${s}`}, ${`numbers-deals-${s}`}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

async function pkg(o: Org): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${o.orgId}, ${`Pkg ${uniq()}`}, 25000, 'gbp', 'partner')
    returning id`;
  return row!.id;
}

async function sponsor(o: Org): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${`Acme ${uniq()}`}, 'partner', 'active') returning id`;
  return row!.id;
}

const input = (packageId: string, method: PaymentMethod, rule: GoLiveRule, over: Partial<CreateDealInput> = {}): CreateDealInput => ({
  package_id: packageId,
  competition_id: null,
  payment_method: method,
  go_live: rule,
  sponsor_email: method === "online" ? `pay-${uniq()}@test.local` : null,
  ends_on: null,
  end_current: false,
  ...over,
});

/** The number a deal's row holds. */
const storedNumber = async (dealId: string): Promise<number | null> =>
  (await sql<{ invoice_number: number | null }[]>`select invoice_number from sponsor_orders where id = ${dealId}`)[0]!.invoice_number;

/** Spec §7 / D11, typed here: the methods that carry an invoice (complimentary has none). */
const NUMBERED_METHODS: readonly PaymentMethod[] = ["online", "offline"];

describe.skipIf(!HAS_DB)("createDeal numbers online and offline deals in its own transaction; complimentary takes none", () => {
  it("empty first: no counter before the first deal; a complimentary deal takes none; then offline is 1 and online is 2 — and another org starts at 1", async () => {
    const o = await dealOrg();
    const p = await pkg(o);
    expect(await counter(o.orgId), "empty first: no counter").toBeNull();
    const comp = await createDeal(o.auth, await sponsor(o), input(p, "complimentary", "immediate"), ORIGIN);
    expect(comp.deal.invoice_number, "complimentary: no number").toBeNull();
    expect(await counter(o.orgId), "a complimentary deal moves no counter").toBeNull();
    const off = await createDeal(o.auth, await sponsor(o), input(p, "offline", "on_payment"), ORIGIN);
    expect([off.deal.invoice_number, await storedNumber(off.deal.id)], "offline: the first number").toEqual([1, 1]);
    const on = await createDeal(o.auth, await sponsor(o), input(p, "online", "on_payment"), ORIGIN);
    expect([on.deal.invoice_number, await storedNumber(on.deal.id)], "online: the next").toEqual([2, 2]);
    expect(on.checkout_url, "premise: the online invoice was sent").not.toBeNull();
    expect((await getDeal(o.auth, on.deal.id)).invoice_number, "the deal read carries it").toBe(2);
    expect(await counter(o.orgId)).toBe(2);

    const other = await dealOrg();
    const first = await createDeal(other.auth, await sponsor(other), input(await pkg(other), "offline", "immediate"), ORIGIN);
    expect(first.deal.invoice_number, "per org: another org starts at 1").toBe(1);
  });

  it("every method × go-live rule a deal can be made with: online and offline are numbered in creation order, complimentary never (count reported)", async () => {
    const o = await dealOrg();
    const p = await pkg(o);
    // The combinations the Add deal sheet offers (spec §5.2: "When paid" is not offered for complimentary).
    const COMBOS: [PaymentMethod, GoLiveRule][] = [
      ["online", "on_payment"], ["online", "immediate"], ["online", "on_approval"],
      ["offline", "on_payment"], ["offline", "immediate"], ["offline", "on_approval"],
      ["complimentary", "immediate"], ["complimentary", "on_approval"],
    ];
    let next = 1;
    let checked = 0;
    for (const [method, rule] of COMBOS) {
      const { deal } = await createDeal(o.auth, await sponsor(o), input(p, method, rule), ORIGIN);
      const expected = NUMBERED_METHODS.includes(method) ? next++ : null;
      expect([deal.invoice_number, await storedNumber(deal.id)], `${method} / ${rule}`).toEqual([expected, expected]);
      checked++;
    }
    expect(checked, "combinations checked").toBe(COMBOS.length);
    expect(next - 1, "numbered deals").toBe(6);
    expect(await counter(o.orgId)).toBe(6);
  });

  it("a refused create takes no number: complimentary on payment (422) and online with no billing email (422) leave the counter, and the next deal is the next number", async () => {
    const o = await dealOrg();
    const p = await pkg(o);
    const s = await sponsor(o);
    expect((await createDeal(o.auth, s, input(p, "offline", "on_payment"), ORIGIN)).deal.invoice_number).toBe(1);
    await expect(createDeal(o.auth, s, input(p, "complimentary", "on_payment"), ORIGIN))
      .rejects.toMatchObject({ status: 422, code: "on_payment_needs_payment" });
    await expect(createDeal(o.auth, s, input(p, "online", "on_payment", { sponsor_email: null }), ORIGIN))
      .rejects.toMatchObject({ status: 422, code: "sponsor_email_required" });
    expect(await counter(o.orgId), "refusals move nothing").toBe(1);
    expect((await createDeal(o.auth, await sponsor(o), input(p, "offline", "on_payment"), ORIGIN)).deal.invoice_number).toBe(2);
  });

  it("a create that fails INSIDE its transaction leaves the counter unmoved, and the next create takes that same number (MUTATE: allocate outside the transaction)", async () => {
    const o = await dealOrg();
    const p = await pkg(o);
    // The one way to fail the insert after the number is taken, with no mock: a row already holding number 1 (written on the
    // privileged connection, so no counter ever moved). The create allocates 1, and its insert is refused by the unique key.
    const [{ id: blocker }] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, invoice_number)
      values (${o.orgId}, ${p}, ${await sponsor(o)}, 'Acme', null, 25000, 'gbp', 'pending',
              'awaiting_payment', 'offline', 'on_payment', 'partner', false, 'Partner', 1)
      returning id`;
    const s = await sponsor(o);
    await expect(createDeal(o.auth, s, input(p, "offline", "on_payment"), ORIGIN))
      .rejects.toMatchObject({ code: "23505", constraint_name: "sponsor_orders_org_invoice_number_key" });
    expect(await counter(o.orgId), "the failed create's number went back with its transaction").toBeNull();
    expect((await sql`select 1 from sponsor_orders where sponsor_id = ${s}`).length, "and it wrote no deal").toBe(0);

    await sql`delete from sponsor_orders where id = ${blocker}`;
    const { deal } = await createDeal(o.auth, s, input(p, "offline", "on_payment"), ORIGIN);
    expect(deal.invoice_number, "the same number, not the next").toBe(1);
    expect(await counter(o.orgId)).toBe(1);
  });

  it("after End now a deal keeps its number and the next deal takes the next one: a number is never reused", async () => {
    const o = await dealOrg();
    const p = await pkg(o);
    const s = await sponsor(o);
    const first = (await createDeal(o.auth, s, input(p, "offline", "immediate"), ORIGIN)).deal;
    expect(first.invoice_number).toBe(1);
    const ended = await endDealNow(o.auth, first.id);
    expect([ended.deal_status, ended.invoice_number], "ended, still SP-0001").toEqual(["ended", 1]);
    const second = (await createDeal(o.auth, s, input(p, "offline", "immediate"), ORIGIN)).deal;
    expect(second.invoice_number, "the next number, not the freed one").toBe(2);
  });
});
