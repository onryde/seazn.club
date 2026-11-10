// Sponsor deals, Task 12 - the transitional Packages tab (components/sponsor-packages.tsx), driven the way a person drives it.
//
// "Send invoice" no longer takes a typed sponsor name: it picks one of the org's sponsors and POSTs a DEAL for it
// (`POST /sponsors/{id}/deals`), reads the pay link from the create answer `{ deal, checkout_url }` (F11), lists orders from
// `GET /sponsor-deals`, and refunds / downloads evidence through the deal paths. vitest is `environment: "node"` (no DOM), so
// the island runs under components/__tests__/_hook-harness.tsx: React's own hook dispatcher, the element TREE back, a click is
// the element's own `onClick` prop called. `fetch` is stubbed and its request is READ - "did the picker send what it shows?" is a
// check on the request body, not on a fixture. What this cannot see (CSS, widths, tap area) is the e2e's.
//
// Expected values come from the spec (§5.2's open / not-open statuses, typed below) and the fixtures' own values, never from the
// component. Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   K1  body        `sponsor_email: ...` -> `sponsor_name: ...` in the deal POST   -> "POSTs the deal body and nothing else"
//   K2  default     sort by display_order -> first in the array                    -> "opens at the first sponsor by display_order"
//   K3  dup match   `d.sponsor_id === chosen.id` -> match on the typed email        -> "the duplicate-invoice confirm keys on the sponsor"
//   K4  pay link    `result.checkout_url` -> a constant                              -> "shows the pay link the create answered"
//   K5  empty       drop the empty-sponsors arm                                      -> "with no sponsors the form says Add a sponsor first"
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn(async (_opts?: unknown) => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

import { SponsorPackages } from "@/components/sponsor-packages";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DEAL_STATUSES, type DealStatus } from "@/lib/sponsor-deals";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const ORG = "org-1";
const API = `/api/v1/orgs/${ORG}`;

/** A name as long as a real club's, so a truncation or a wrap shows in the text it is given. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";

const PKG_ORG_WIDE = { id: "p1", competition_id: null, name: "Gold board", description: null, price_cents: 25_000, currency: "gbp", tier: "gold", active: true };
const PKG_ONE_COMP = { ...PKG_ORG_WIDE, id: "p2", competition_id: "c1", name: "Cup board" };
const PACKAGES = [PKG_ORG_WIDE, PKG_ONE_COMP];

/** Deliberately NOT in display order in the array: the picker must sort, not trust the array. */
const SPONSORS = [
  { id: "sp-b", name: "Ridge Cycles", display_order: 2 },
  { id: "sp-a", name: LONG_NAME, display_order: 0 },
  { id: "sp-c", name: "Quay Chandlers", display_order: 1 },
];
const SPONSOR_ORDER = ["sp-a", "sp-c", "sp-b"]; // by display_order, from the fixtures above

const deal = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  sponsor_id: "sp-a",
  package_id: "p1",
  deal_status: "awaiting_payment",
  payment_status: "pending",
  payment_method: "online",
  go_live: "on_payment",
  package_name: "Gold board",
  tier: "gold",
  includes_on_stream: false,
  competition_id: null,
  amount_cents: 25_000,
  currency: "gbp",
  sponsor_name: LONG_NAME,
  sponsor_email: "pay@harbourside.test",
  ends_at: null,
  created_at: "2026-11-01T10:00:00.000Z",
  created_by: null,
  invoice_sent_at: null,
  paid_at: null,
  marked_paid_by: null,
  approved_at: null,
  approved_by: null,
  live_at: null,
  ended_at: null,
  ended_reason: null,
  parked_at: null,
  disputed_at: null,
  dispute_id: null,
  invoice_number: null,
  ...over,
});

type Answer = { status?: number; body: unknown };
type Call = { url: string; method: string; body: Record<string, unknown> | null };

const net = { answers: new Map<string, Answer>(), calls: [] as Call[] };
const fetchMock = vi.fn();
const answerWith = (method: string, path: string, answer: Answer) => net.answers.set(`${method} ${API}${path}`, answer);
const callsTo = (method: string, pathPart: string): Call[] => net.calls.filter((c) => c.method === method && c.url.includes(pathPart));

beforeEach(() => {
  vi.clearAllMocks();
  net.answers.clear();
  net.calls.length = 0;
  confirmMock.mockImplementation(async () => true);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    net.calls.push({ url, method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const hit = net.answers.get(`${method} ${url}`);
    const status = hit?.status ?? 200;
    return { ok: status < 400, status, json: async () => hit?.body ?? { data: null } };
  });
  vi.stubGlobal("fetch", fetchMock);
  answerWith("GET", "/sponsor-packages", { body: { data: PACKAGES } });
  answerWith("GET", "/sponsor-deals", { body: { data: [] } });
});

/** Macrotask turns: each await in a chain lands on its own turn. */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const baseProps = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  competitions: [{ id: "c1", name: "Spring Cup" }],
  sponsors: SPONSORS,
  hasMonetize: true,
  billingHref: "/o/riverside/settings/billing",
  sponsorsHref: "/o/riverside/sponsors?tab=sponsors",
  ...over,
});

async function mount(over: Record<string, unknown> = {}) {
  const island = renderIsland(SponsorPackages, baseProps(over) as Parameters<typeof SponsorPackages>[0]);
  await flush();
  const find = (id: string): ReactElement => {
    const el = island.tree().find((e) => propsOf(e)["data-testid"] === id);
    if (!el) throw new Error(`no element with data-testid="${id}"`);
    return el;
  };
  const has = (id: string) => island.tree().some((e) => propsOf(e)["data-testid"] === id);
  const click = (id: string) => (propsOf(find(id)).onClick as () => void)();
  const pick = (value: string) => (propsOf(find("invoice-sponsor")).onChange as (e: unknown) => void)({ target: { value } });
  const typeEmail = (value: string) => (propsOf(find("invoice-email")).onChange as (e: unknown) => void)({ target: { value } });
  const pickerValue = () => propsOf(find("invoice-sponsor")).value as string;
  const pickerOptions = () =>
    island
      .tree()
      .filter((e) => e.type === "option" && typeof propsOf(e).value === "string" && String(propsOf(e).value).startsWith("sp-"))
      .map((e) => String(propsOf(e).value));
  return { island, find, has, click, pick, typeEmail, pickerValue, pickerOptions, text: () => flat(island.text()) };
}

describe("the picker opens at the first sponsor by display_order (rule 19: pin the opening value)", () => {
  it("opens on the sponsor with the lowest display_order, though it is not first in the array; options follow the same order", async () => {
    const m = await mount();
    expect(SPONSORS[0]!.id, "premise: the array's first sponsor is NOT the lowest display_order").not.toBe(SPONSOR_ORDER[0]);
    m.click("invoice-open-p1");
    expect(m.pickerValue()).toBe(SPONSOR_ORDER[0]);
    expect(m.pickerOptions()).toEqual(SPONSOR_ORDER);
  });

  it("re-opens at the first sponsor (not the last pick), and drops the last email so an invoice never goes to the wrong person", async () => {
    const m = await mount();
    m.click("invoice-open-p1");
    m.pick("sp-b");
    m.typeEmail("someone@ridge.test");
    expect(m.pickerValue()).toBe("sp-b");
    m.click("invoice-open-p1"); // closes
    m.click("invoice-open-p1"); // opens again
    expect(m.pickerValue()).toBe(SPONSOR_ORDER[0]);
    expect(propsOf(m.find("invoice-email")).value).toBe("");
  });
});

describe("Send invoice POSTs a deal for the picked sponsor - the body is exactly the brief's, nothing else", () => {
  const created = (checkout_url: string | null) => ({
    status: 201,
    body: { ok: true, data: { deal: deal({ id: "d9", sponsor_id: "sp-c", sponsor_name: "Quay Chandlers" }), checkout_url } },
  });

  it("an org-wide package: /sponsors/{picked id}/deals with { package_id, competition_id: null, online, on_payment, sponsor_email } and no sponsor_name / sponsor_id", async () => {
    answerWith("POST", "/sponsors/sp-c/deals", created("https://checkout.stripe.com/c/pay/cs_test_a"));
    const m = await mount();
    m.click("invoice-open-p1");
    m.pick("sp-c");
    m.typeEmail("pay@quay.test");
    m.click("invoice-send");
    await flush();
    const posts = callsTo("POST", "/deals");
    expect(posts.map((c) => c.url)).toEqual([`${API}/sponsors/sp-c/deals`]);
    expect(posts[0]!.body).toEqual({
      package_id: PKG_ORG_WIDE.id,
      competition_id: null,
      payment_method: "online",
      go_live: "on_payment",
      sponsor_email: "pay@quay.test",
    });
    expect(Object.keys(posts[0]!.body!)).not.toContain("sponsor_name");
    expect(Object.keys(posts[0]!.body!)).not.toContain("sponsor_id");
  });

  it("a package for one competition sends THAT competition (the differential: the other package sends null)", async () => {
    answerWith("POST", "/sponsors/sp-a/deals", created("https://checkout.stripe.com/c/pay/cs_test_b"));
    const m = await mount();
    m.click("invoice-open-p2");
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    const posts = callsTo("POST", "/deals");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url, "the default pick is the first sponsor").toBe(`${API}/sponsors/${SPONSOR_ORDER[0]}/deals`);
    expect(posts[0]!.body!.package_id).toBe(PKG_ONE_COMP.id);
    expect(posts[0]!.body!.competition_id).toBe(PKG_ONE_COMP.competition_id);
  });

  it("shows the pay link the create ANSWERED (F11), closes the form, and re-reads the deals", async () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_from_the_create";
    answerWith("POST", "/sponsors/sp-a/deals", created(url));
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("invoice-send");
    await flush();
    expect(propsOf(m.find("invoice-link")).children, "the banner's code element carries the answered url").toBe(url);
    expect(m.has("invoice-send"), "the form is closed after a send").toBe(false);
    expect(callsTo("GET", "/sponsor-deals").length, "the orders list is re-read").toBe(readsBefore + 1);
  });

  it("an answer with no checkout_url shows no link banner (the pay link is null unless the deal is online)", async () => {
    answerWith("POST", "/sponsors/sp-a/deals", created(null));
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    expect(m.has("invoice-link")).toBe(false);
    expect(callsTo("POST", "/deals")).toHaveLength(1);
  });

  it("never reads or writes /sponsor-orders - the retired rail (counted over a whole send + read session)", async () => {
    answerWith("POST", "/sponsors/sp-a/deals", created("https://checkout.stripe.com/c/pay/cs_test_c"));
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    expect(net.calls.length, "premise: the session made requests").toBeGreaterThanOrEqual(4);
    expect(net.calls.filter((c) => c.url.includes("sponsor-orders"))).toEqual([]);
  });

  it("the Send button needs a sponsor and a valid email", async () => {
    const m = await mount();
    m.click("invoice-open-p1");
    expect(propsOf(m.find("invoice-send")).disabled, "no email yet").toBe(true);
    m.typeEmail("not-an-email");
    expect(propsOf(m.find("invoice-send")).disabled).toBe(true);
    m.typeEmail("pay@quay.test");
    expect(propsOf(m.find("invoice-send")).disabled).toBe(false);
  });
});

describe("the empty case: an org with no sponsors cannot send an invoice", () => {
  it("opening the form says Add a sponsor first, links to the Sponsors tab, and offers no Send button or picker", async () => {
    const m = await mount({ sponsors: [] });
    m.click("invoice-open-p1");
    expect(m.text()).toContain(msg("sponsors.order.noSponsors"));
    expect(msg("sponsors.order.noSponsors"), "the brief's words").toBe("Add a sponsor first");
    expect(propsOf(m.find("invoice-no-sponsors")).href).toBe("/o/riverside/sponsors?tab=sponsors");
    expect(m.has("invoice-send")).toBe(false);
    expect(m.has("invoice-sponsor")).toBe(false);
    expect(callsTo("POST", "/deals")).toEqual([]);
  });

  it("with sponsors the same form offers the picker and Send, and not the empty note (the pair)", async () => {
    const m = await mount();
    m.click("invoice-open-p1");
    expect(m.has("invoice-send")).toBe(true);
    expect(m.has("invoice-sponsor")).toBe(true);
    expect(m.has("invoice-no-sponsors")).toBe(false);
  });
});

describe("the duplicate-invoice confirm keys on the SPONSOR and the package, and fires only for an OPEN deal", () => {
  /** Spec §5.2: a deal is open until it is live or ended. Typed here from the spec, never read from the component. */
  const OPEN: Record<DealStatus, boolean> = {
    draft: true,
    awaiting_payment: true,
    awaiting_approval: true,
    scheduled: true,
    live: false,
    ended: false,
  };

  async function sendFor(existing: Record<string, unknown>[], opts: { sponsor?: string; email?: string; pkg?: string } = {}) {
    answerWith("GET", "/sponsor-deals", { body: { data: existing } });
    answerWith("POST", `/sponsors/${opts.sponsor ?? "sp-a"}/deals`, {
      status: 201,
      body: { ok: true, data: { deal: deal({ id: "d9" }), checkout_url: "https://checkout.stripe.com/c/pay/cs_test_d" } },
    });
    const m = await mount();
    m.click(`invoice-open-${opts.pkg ?? "p1"}`);
    if (opts.sponsor) m.pick(opts.sponsor);
    m.typeEmail(opts.email ?? "pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    return m;
  }

  it("every deal status: open ones ask first, live and ended ones do not (all six checked)", async () => {
    let checked = 0;
    for (const status of DEAL_STATUSES) {
      confirmMock.mockClear();
      net.calls.length = 0;
      await sendFor([deal({ deal_status: status })]);
      expect(confirmMock.mock.calls.length, `${status} asks`).toBe(OPEN[status] ? 1 : 0);
      expect(callsTo("POST", "/deals").length, `${status} still sends once confirmed`).toBe(1);
      checked++;
    }
    expect(checked).toBe(DEAL_STATUSES.length);
    expect(checked).toBe(Object.keys(OPEN).length);
  });

  it("the confirm uses the dup-confirm copy, and declining it sends nothing", async () => {
    confirmMock.mockImplementation(async () => false);
    await sendFor([deal({ deal_status: "awaiting_payment" })]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; confirmLabel: string };
    expect(opts.title).toBe(msg("sponsors.order.dupConfirm.title"));
    expect(opts.confirmLabel).toBe(msg("sponsors.order.dupConfirm.label"));
    expect(callsTo("POST", "/deals")).toEqual([]);
  });

  it("the same sponsor with a DIFFERENT email still asks (the old rule keyed on the email)", async () => {
    await sendFor([deal({ sponsor_email: "someone.else@harbourside.test" })]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("a different sponsor with the SAME email does not ask", async () => {
    await sendFor([deal({ sponsor_id: "sp-c", sponsor_email: "pay@harbourside.test" })]);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("an open deal on a DIFFERENT package does not ask", async () => {
    await sendFor([deal({ package_id: "p2" })]);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("a legacy order (no sponsor, ended) never asks", async () => {
    await sendFor([deal({ sponsor_id: null, deal_status: "ended", ended_reason: "legacy" })]);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("the orders list reads the deals, and Refund / Evidence use the deal paths", () => {
  const PAID = deal({ id: "d-paid", deal_status: "live", payment_status: "paid", paid_at: "2026-11-02T10:00:00.000Z" });

  it("lists GET /sponsor-deals: the sponsor's name (long, kept whole), its amount and a payment label for every payment status (all five)", async () => {
    // Expected labels: the dictionary's own words per payment status, typed from the money column's value set.
    const LABELS: Record<string, MessageKey> = {
      pending: "sponsors.order.status.pending",
      paid: "sponsors.order.status.paid",
      failed: "sponsors.order.status.failed",
      refunded: "sponsors.order.status.refunded",
      none: "sponsors.order.status.none",
    };
    answerWith("GET", "/sponsor-deals", {
      body: {
        data: Object.keys(LABELS).map((status, i) =>
          deal({ id: `d-${status}`, payment_status: status, sponsor_name: `${LONG_NAME} ${i}` }),
        ),
      },
    });
    const m = await mount();
    let checked = 0;
    for (const [status, key] of Object.entries(LABELS)) {
      expect(m.text(), `${status}`).toContain(msg(key));
      checked++;
    }
    expect(checked).toBe(5);
    expect(m.text()).toContain(`${LONG_NAME} 0`);
    expect(callsTo("GET", "/sponsor-deals").length).toBeGreaterThanOrEqual(1);
  });

  it("a deal with no billing email (offline, complimentary) renders without the word null", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ sponsor_email: null, payment_method: "complimentary", payment_status: "none", deal_status: "live" })] } });
    const m = await mount();
    expect(m.text()).toContain(LONG_NAME);
    expect(m.text()).not.toContain("null");
  });

  it("Refund is offered for a paid deal only - not pending, refunded, charged back, or complimentary (all five checked)", async () => {
    // Spec §5.2: a refund is for a paid, undisputed deal that has not been refunded already.
    const CASES: [string, Record<string, unknown>, boolean][] = [
      ["paid", PAID, true],
      ["pending", deal({ id: "d-pending" }), false],
      ["refunded", deal({ id: "d-refunded", payment_status: "refunded", deal_status: "ended", ended_reason: "refunded" }), false],
      ["charged back", deal({ id: "d-disputed", payment_status: "paid", deal_status: "live", disputed_at: "2026-11-03T10:00:00.000Z", dispute_id: "dp_1" }), false],
      ["complimentary", deal({ id: "d-comp", payment_method: "complimentary", payment_status: "none", deal_status: "live" }), false],
    ];
    let checked = 0;
    for (const [label, d, offered] of CASES) {
      answerWith("GET", "/sponsor-deals", { body: { data: [d] } });
      const m = await mount();
      expect(m.has(`order-refund-${String(d.id)}`), label).toBe(offered);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("Refund asks first, then POSTs /sponsor-deals/{id}/refund and re-reads; declining sends nothing", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [PAID] } });
    answerWith("POST", "/sponsor-deals/d-paid/refund", { body: { ok: true, data: deal({ id: "d-paid", payment_status: "refunded" }) } });
    const m = await mount();
    confirmMock.mockImplementationOnce(async () => false);
    m.click("order-refund-d-paid");
    await flush();
    expect(callsTo("POST", "/refund")).toEqual([]);
    m.click("order-refund-d-paid");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(callsTo("POST", "/refund").map((c) => c.url)).toEqual([`${API}/sponsor-deals/d-paid/refund`]);
  });

  it("the evidence pack link is the deal's own path, shown for a charged-back deal only", async () => {
    const disputed = deal({ id: "d-disputed", payment_status: "paid", deal_status: "live", disputed_at: "2026-11-03T10:00:00.000Z", dispute_id: "dp_1" });
    answerWith("GET", "/sponsor-deals", { body: { data: [disputed, PAID] } });
    const m = await mount();
    expect(propsOf(m.find("order-evidence-d-disputed")).href).toBe(`${API}/sponsor-deals/d-disputed/evidence`);
    expect(m.has("order-evidence-d-paid"), "a clean paid deal has no evidence link").toBe(false);
  });
});

describe("a refusal reads the dictionary's words for its CODE, never the server's English sentence", () => {
  const SERVER_SENTENCE = "the server's own English sentence";
  const refuse = (status: number, code: string) => ({ status, body: { ok: false, error: { code, message: SERVER_SENTENCE } } });

  it("Send invoice: connect_required, on_payment_needs_payment, deal_changed and stripe_unavailable each read their own key (all four)", async () => {
    // Codes are the usecases' (server/usecases/sponsor-deals.ts), typed here; the keys are the ones this task adds.
    const CASES: [number, string, MessageKey][] = [
      [409, "connect_required", "sponsors.error.connectRequired"],
      [422, "on_payment_needs_payment", "sponsors.error.needsPayment"],
      [409, "deal_changed", "sponsors.error.dealChanged"],
      [502, "stripe_unavailable", "sponsors.error.stripeUnavailable"],
    ];
    let checked = 0;
    for (const [status, code, key] of CASES) {
      net.calls.length = 0;
      answerWith("POST", "/sponsors/sp-a/deals", refuse(status, code));
      const m = await mount();
      m.click("invoice-open-p1");
      m.typeEmail("pay@harbourside.test");
      m.click("invoice-send");
      await flush();
      expect(m.text(), code).toContain(msg(key));
      expect(m.text(), `${code}: not the server's sentence`).not.toContain(SERVER_SENTENCE);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("Refund: deal_not_refundable and deal_disputed read their own keys", async () => {
    let checked = 0;
    for (const [code, key] of [
      ["deal_not_refundable", "sponsors.error.notRefundable"],
      ["deal_disputed", "sponsors.error.dealDisputed"],
    ] as [string, MessageKey][]) {
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-paid", deal_status: "live", payment_status: "paid" })] } });
      answerWith("POST", "/sponsor-deals/d-paid/refund", refuse(409, code));
      const m = await mount();
      m.click("order-refund-d-paid");
      await flush();
      expect(m.text(), code).toContain(msg(key));
      expect(m.text()).not.toContain(SERVER_SENTENCE);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an unknown code reads the house fallback, not the server's sentence", async () => {
    answerWith("POST", "/sponsors/sp-a/deals", refuse(500, "INTERNAL"));
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    expect(m.text()).toContain(msg("settings.saveFailed"));
    expect(m.text()).not.toContain(SERVER_SENTENCE);
  });
});

describe("the gate and the first read are unchanged", () => {
  it("a plan without sponsors.monetize reads nothing and shows the upsell (the empty case of the whole console)", async () => {
    const m = await mount({ hasMonetize: false });
    expect(net.calls).toEqual([]);
    expect(m.text()).toContain(msg("sponsors.sell.upsell"));
  });

  it("the first read is packages + deals - the packages and the deal list, nothing else (counted)", async () => {
    await mount();
    expect(net.calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([`GET ${API}/sponsor-deals`, `GET ${API}/sponsor-packages`]);
  });
});

describe("a selection the page no longer lists falls back to the first sponsor - never to an empty or stale form (fix round 1, m5)", () => {
  it("the picked sponsor leaves the list while the form is open: the picker shows the first sponsor, and Send goes to THAT one", async () => {
    answerWith("POST", "/sponsors/sp-a/deals", { status: 201, body: { ok: true, data: { deal: deal({ id: "d7" }), checkout_url: null } } });
    const m = await mount();
    m.click("invoice-open-p1");
    m.pick("sp-b");
    expect(m.pickerValue(), "premise: the pick took").toBe("sp-b");
    // The page hands fresh data down (a refresh after the sponsor was deleted elsewhere): sp-b is gone.
    m.island.rerender(baseProps({ sponsors: SPONSORS.filter((s) => s.id !== "sp-b") }) as Parameters<typeof SponsorPackages>[0]);
    expect(m.pickerOptions(), "premise: the stale sponsor is no longer offered").toEqual(["sp-a", "sp-c"]);
    expect(m.pickerValue(), "the form falls back to the first sponsor by display_order").toBe(SPONSOR_ORDER[0]);
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    expect(callsTo("POST", "/deals").map((c) => c.url), "the invoice goes to the sponsor the form shows, not the stale pick").toEqual([`${API}/sponsors/sp-a/deals`]);
  });
});

describe("the form says an unpaid invoice hides the sponsor, unless a live deal keeps it on the pages (fix round 1, item 7)", () => {
  // The invoice form has no go-live choice: every invoice is `go_live: "on_payment"` (asserted above), so the line follows the
  // sponsor, not an option. Spec: a sponsor whose only deal awaits payment is hidden on the public pages until it is live.
  const note = (m: Awaited<ReturnType<typeof mount>>) => (m.has("invoice-hidden-note") ? flat(textOf(m.find("invoice-hidden-note"))) : null);

  it("a sponsor with no deal, or only a deal that has not gone live, is told it stays off the public pages until the invoice is paid (both checked)", async () => {
    let checked = 0;
    for (const d of [[], [deal({ sponsor_id: "sp-a", deal_status: "awaiting_payment" })], [deal({ sponsor_id: "sp-a", deal_status: "scheduled" })]]) {
      answerWith("GET", "/sponsor-deals", { body: { data: d } });
      const m = await mount();
      m.click("invoice-open-p1");
      expect(m.pickerValue(), "premise: the form is on sp-a").toBe("sp-a");
      expect(note(m), `${d.length} deal(s)`).toBe(msg("sponsors.order.hiddenUntilPaid"));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a sponsor already under a LIVE deal is not told it will be hidden - the live deal keeps it shown (the pair)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-live", sponsor_id: "sp-a", package_id: "p2", deal_status: "live", payment_status: "paid" })] } });
    const m = await mount();
    m.click("invoice-open-p1");
    expect(m.pickerValue()).toBe("sp-a");
    expect(m.has("invoice-hidden-note"), "no line for the sponsor with a live deal").toBe(false);
  });

  it("the line follows the PICKED sponsor: live-dealt sponsor none, a free sponsor has it, back again none (derived, not copied)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-live", sponsor_id: "sp-a", package_id: "p2", deal_status: "live", payment_status: "paid" })] } });
    const m = await mount();
    m.click("invoice-open-p1");
    expect(m.has("invoice-hidden-note")).toBe(false);
    m.pick("sp-c");
    expect(note(m)).toBe(msg("sponsors.order.hiddenUntilPaid"));
    m.pick("sp-a");
    expect(m.has("invoice-hidden-note")).toBe(false);
  });

  it("an org with no sponsors shows the Add a sponsor first link and no such line", async () => {
    const m = await mount({ sponsors: [] });
    m.click("invoice-open-p1");
    expect(m.has("invoice-no-sponsors")).toBe(true);
    expect(m.has("invoice-hidden-note")).toBe(false);
  });
});

describe("the copy fixed in fix round 1 (m2, m3) says what is true now, in all four locales (counted)", () => {
  const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

  it("a deal-locked sponsor's refusal does not point at an End-deal control that does not exist until PR 2", () => {
    const FORBIDDEN: Record<string, RegExp> = { en: /end the deal|add a new one/i, es: /finaliza|a(ñ|n)ade uno nuevo/i, fr: /terminez|ajoutez-en un nouveau/i, nl: /beëindig|voeg een nieuwe toe/i };
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const text = dict["sponsors.error.lockedByDeal"];
      expect(text, loc).toBeTruthy();
      expect(text, loc).not.toMatch(FORBIDDEN[loc]!);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a disputed payment says disputed, not charged back, in every locale", () => {
    const DISPUTED: Record<string, RegExp> = { en: /disputed/i, es: /disputa/i, fr: /contestation|litige/i, nl: /betwist/i };
    const CHARGEBACK: Record<string, RegExp> = { en: /charged back/i, es: /contracargo/i, fr: /rétrofacturé|rétrofacturation/i, nl: /teruggeboekt/i };
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const text = dict["sponsors.error.dealDisputed"];
      expect(text, loc).toMatch(DISPUTED[loc]!);
      expect(text, loc).not.toMatch(CHARGEBACK[loc]!);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the hidden-until-paid line exists in all four locales and is not the English one outside en (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const text = dict["sponsors.order.hiddenUntilPaid"];
      expect(text, loc).toBeTruthy();
      if (loc !== "en") expect(text, loc).not.toBe(LOCALES.en!["sponsors.order.hiddenUntilPaid"]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
