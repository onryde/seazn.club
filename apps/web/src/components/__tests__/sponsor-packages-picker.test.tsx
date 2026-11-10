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
// Batch F fix round 1 (review I1, I2, m1, m3, m4, m6, m8, M-a) - each guard mutated once, restored from a cp backup:
//   K6  ended       drop `d.deal_status !== "ended"` from hasOpenDealOn               -> "an ENDED deal for the same sponsor and package never asks"
//   K7  re-read     drop the re-read after a failed write                            -> "a create that fails AFTER it saved ... re-reads the list"
//   K8  resend gate offer Resend on every deal                                       -> "Resend invoice is offered exactly where the deal offers"
//   K9  end gate    offer End now on every deal                                      -> "End now is offered on every deal that has not ended"
//   K10 end body    always the live body                                             -> "the End now confirm says what happens to the public pages"
//   K11 finished    ignore finishedCompetitionIds                                     -> "a package whose competition has finished offers no Send invoice"
// Batch G (New-1, New-2, New-3, m1 remainder):
//   K12 intent      `has_payment_intent` -> `marked_paid_by === null` (the old twin)  -> "on the SAME fact the server refunds on"
//   K13 banner      drop payLinkStillOpen (show every sent link)                      -> "the Invoice sent banner shows a pay link only while"
// Final fix (final review m1):
//   K16 exits       no-plan view back to the upsell alone                            -> "keeps every exit from the deals it already has"
//   K17 resend gate drop `hasMonetize &&` from Resend                                -> "...: no Resend without the plan"
//   K18 empty case  show the Orders list without the plan even with no deals         -> "a plan without sponsors.monetize and no deals reads only"
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
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
  has_payment_intent: false,
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
    expect(opts.title).toBe(msg("sponsors.deal.confirm.dup.title"));
    expect(opts.confirmLabel).toBe(msg("sponsors.deal.confirm.dup.label"));
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

  it("an ENDED deal for the same sponsor and package never asks - a legacy order and an ended deal (review m6: the sponsor matches, so only the ended rule keeps it quiet)", async () => {
    let checked = 0;
    for (const ended of [
      deal({ sponsor_id: "sp-a", deal_status: "ended", ended_reason: "legacy" }),
      deal({ sponsor_id: "sp-a", deal_status: "ended", ended_reason: "ended_now" }),
    ]) {
      confirmMock.mockClear();
      await sendFor([ended]);
      expect(confirmMock, String(ended.ended_reason)).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
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
    // Codes are the usecases' (server/usecases/sponsor-deals.ts), typed here. A create's stripe_unavailable comes AFTER the deal is
    // saved (createDeal sends the invoice post-commit, F11), so it reads the saved-draft words, never "nothing was changed" (I1).
    const CASES: [number, string, MessageKey][] = [
      [409, "connect_required", "sponsors.error.connectRequired"],
      [422, "on_payment_needs_payment", "sponsors.error.needsPayment"],
      [409, "deal_changed", "sponsors.error.dealChanged"],
      [502, "stripe_unavailable", "sponsors.error.invoiceSavedNoLink"],
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

describe("the gate and the first read", () => {
  it("a plan without sponsors.monetize and no deals reads only the deal list, shows the upsell, and no Orders (the empty case of the whole console; final review m1)", async () => {
    const m = await mount({ hasMonetize: false });
    expect(net.calls.map((c) => `${c.method} ${c.url}`), "the deals are read to offer their exits; packages are not").toEqual([
      `GET ${API}/sponsor-deals`,
    ]);
    expect(m.text()).toContain(msg("sponsors.sell.upsell"));
    expect(m.text(), "no Orders heading for an org with nothing to exit").not.toContain(msg("sponsors.orders.title"));
    expect(m.text(), "and never the 'send a package invoice' empty line it cannot act on").not.toContain(msg("sponsors.orders.empty"));
    // The two views share the `sponsor-packages` wrapper; each has its own testid (the e2e tells them apart by these).
    expect(m.has("sponsor-sell-upsell")).toBe(true);
    expect(m.has("sponsor-pkg-create")).toBe(false);
  });

  it("with the plan: the package form's testid, not the upsell's (the pair of the above)", async () => {
    const m = await mount();
    expect(m.has("sponsor-pkg-create")).toBe(true);
    expect(m.has("sponsor-sell-upsell")).toBe(false);
  });

  it("the first read is packages + deals - the packages and the deal list, nothing else (counted)", async () => {
    await mount();
    expect(net.calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([`GET ${API}/sponsor-deals`, `GET ${API}/sponsor-packages`]);
  });
});

describe("a plan without sponsors.monetize keeps every exit from the deals it already has (final review m1)", () => {
  // The exits are not the plan's: POST /end and /refund ask no feature (server/usecases/sponsor-deals.ts endDealNow,
  // refundDeal), while an invoice does (sendDealInvoice -> assertOnlineAllowed, 402). So after a downgrade the Orders rows
  // offer End now, Refund and the evidence pack exactly as allowedActions says, and nothing that sells: no package form, no
  // Send invoice, no Resend. Typed from the spec's action table (§5.2), not read from the component.
  const LIVE = deal({ id: "d-live", deal_status: "live", payment_status: "paid", has_payment_intent: true });
  const OPEN = deal({ id: "d-open", sponsor_id: "sp-c", sponsor_name: "Quay Chandlers", deal_status: "awaiting_payment" });
  const LOST = deal({ id: "d-lost", sponsor_id: "sp-b", sponsor_name: "Ridge Cycles", deal_status: "ended", ended_reason: "dispute_lost", payment_status: "refunded", dispute_id: "dp_1" });

  it("a live paid deal, an unpaid open one and a lost dispute: End now and Refund where offered, the evidence link, no Resend, no Send invoice (all three rows)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [LIVE, OPEN, LOST] } });
    const m = await mount({ hasMonetize: false });
    expect(m.text()).toContain(msg("sponsors.sell.upsell"));
    expect(m.text()).toContain(msg("sponsors.orders.title"));
    const ROWS: [string, { end: boolean; refund: boolean; evidence: boolean }][] = [
      ["d-live", { end: true, refund: true, evidence: false }],
      ["d-open", { end: true, refund: false, evidence: false }],
      ["d-lost", { end: false, refund: false, evidence: true }],
    ];
    let checked = 0;
    for (const [id, want] of ROWS) {
      expect(m.has(`order-end-${id}`), `${id} End now`).toBe(want.end);
      expect(m.has(`order-refund-${id}`), `${id} Refund`).toBe(want.refund);
      expect(m.has(`order-evidence-${id}`), `${id} evidence`).toBe(want.evidence);
      expect(m.has(`order-resend-${id}`), `${id}: no Resend without the plan (the server would answer 402)`).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
    // Nothing that sells: neither package's Send invoice opener, the form, nor the package create.
    for (const id of ["invoice-open-p1", "invoice-open-p2", "invoice-send", "invoice-sponsor"]) expect(m.has(id), id).toBe(false);
    expect(m.text()).not.toContain(msg("sponsors.pkg.create"));
    expect(callsTo("GET", "/sponsor-packages"), "the packages are not read").toEqual([]);
  });

  it("the pair: with the plan, the same unpaid open deal DOES offer Resend (so the gate, not the deal, hid it)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [OPEN] } });
    const m = await mount();
    expect(m.has("order-resend-d-open")).toBe(true);
  });

  it("End now still asks, POSTs /sponsor-deals/{id}/end and re-reads the deals; a refusal reads its own words", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [LIVE] } });
    answerWith("POST", "/sponsor-deals/d-live/end", { body: { ok: true, data: { ...LIVE, deal_status: "ended", ended_reason: "ended_now" } } });
    const m = await mount({ hasMonetize: false });
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    answerWith("GET", "/sponsor-deals", { body: { data: [{ ...LIVE, deal_status: "ended", ended_reason: "ended_now" }] } });
    m.click("order-end-d-live");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(callsTo("POST", "/end").map((c) => c.url)).toEqual([`${API}/sponsor-deals/d-live/end`]);
    expect(callsTo("GET", "/sponsor-deals").length, "re-read").toBe(readsBefore + 1);
    expect(m.has("order-end-d-live"), "ended: nothing left to end").toBe(false);
    expect(m.has("order-refund-d-live"), "a paid deal ended by End now can still be refunded").toBe(true);

    answerWith("POST", "/sponsor-deals/d-live/refund", refuseWith(409, "deal_not_refundable"));
    m.click("order-refund-d-live");
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.notRefundable"));
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

  it("a sponsor already under a LIVE deal - paid, or complimentary (review M-a) - is not told it will be hidden: the live deal keeps it shown (the pair, both checked)", async () => {
    let checked = 0;
    for (const live of [
      deal({ id: "d-live", sponsor_id: "sp-a", package_id: "p2", deal_status: "live", payment_status: "paid" }),
      deal({ id: "d-comp", sponsor_id: "sp-a", package_id: "p2", deal_status: "live", payment_method: "complimentary", payment_status: "none", sponsor_email: null }),
    ]) {
      answerWith("GET", "/sponsor-deals", { body: { data: [live] } });
      const m = await mount();
      m.click("invoice-open-p1");
      expect(m.pickerValue()).toBe("sp-a");
      expect(m.has("invoice-hidden-note"), `${String(live.payment_method)}: no hidden line for the sponsor with a live deal`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
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

// =================================================================================================================================
// Batch F fix round 1: the console can exit the deals it creates (review I2), a failed write re-reads (I1), and the copy says
// what is true for the deal in front of it (m1, m3, m4, m8). Expected values: spec §5.2's action table and the dictionary's
// own keys, typed here - never read from the component.
// =================================================================================================================================

const refuseWith = (status: number, code: string) => ({ status, body: { ok: false, error: { code, message: "the server's own English sentence" } } });

describe("a Send invoice that fails AFTER it saved the deal re-reads the list, says the invoice is saved, and a second Send asks first (review I1)", () => {
  it("stripe_unavailable on the create: the deals are re-read, the saved-draft words show (not 'nothing was changed'), the draft's Resend is offered, and the second Send meets the duplicate confirm", async () => {
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    answerWith("POST", "/sponsors/sp-a/deals", refuseWith(502, "stripe_unavailable"));
    // What the server holds after the create committed and its invoice failed: the draft (createDeal, F11).
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-saved", deal_status: "draft" })] } });
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("invoice-send");
    await flush();
    expect(callsTo("GET", "/sponsor-deals").length, "the list is re-read after the failure").toBe(readsBefore + 1);
    expect(m.text()).toContain(msg("sponsors.error.invoiceSavedNoLink"));
    expect(m.text()).not.toContain(msg("sponsors.error.stripeUnavailable"));
    expect(m.has("order-resend-d-saved"), "the saved draft is listed, with its Resend").toBe(true);
    expect(m.has("invoice-send"), "the form stays open").toBe(true);
    m.click("invoice-send");
    await flush();
    expect(confirmMock, "the second Send asks first: the saved draft is an open deal for the sponsor and package").toHaveBeenCalledTimes(1);
    expect((confirmMock.mock.calls[0]![0] as { title: string }).title).toBe(msg("sponsors.deal.confirm.dup.title"));
    const posts = callsTo("POST", "/deals");
    expect(posts, "both Sends POSTed (the second confirmed)").toHaveLength(2);
    for (const post of posts) expect(Object.keys(post.body!), "the console never asks to end the current deal").not.toContain("end_current");
  });

  it("a refusal BEFORE anything was saved (connect_required) still re-reads, and leaves no deal behind to resend (the pair)", async () => {
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    answerWith("POST", "/sponsors/sp-a/deals", refuseWith(409, "connect_required"));
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("invoice-send");
    await flush();
    expect(callsTo("GET", "/sponsor-deals").length).toBe(readsBefore + 1);
    expect(m.text()).toContain(msg("sponsors.error.connectRequired"));
    expect(m.text()).toContain(msg("sponsors.orders.empty"));
  });
});

describe("Resend invoice is offered exactly where the deal offers it, and goes through send-invoice (review I2)", () => {
  // Spec §5.2: an ONLINE deal that is still unpaid (pending or failed) and has not ended can have its invoice (re)sent - a draft
  // sends it, an awaiting-payment, live or scheduled deal resends it. Typed from the spec.
  const CASES: [string, Record<string, unknown>, boolean][] = [
    ["online draft", { deal_status: "draft" }, true],
    ["online awaiting payment", { deal_status: "awaiting_payment" }, true],
    ["online live, unpaid", { deal_status: "live" }, true],
    ["online scheduled, failed", { deal_status: "scheduled", payment_status: "failed" }, true],
    ["online awaiting approval (paid)", { deal_status: "awaiting_approval", payment_status: "paid" }, false],
    ["online live, paid", { deal_status: "live", payment_status: "paid" }, false],
    ["online ended, unpaid", { deal_status: "ended", ended_reason: "ended_now" }, false],
    ["offline awaiting payment", { deal_status: "awaiting_payment", payment_method: "offline" }, false],
    ["complimentary live", { deal_status: "live", payment_method: "complimentary", payment_status: "none" }, false],
  ];

  it("offered for an online unpaid deal that has not ended, and for nothing else (all nine checked)", async () => {
    let checked = 0;
    for (const [label, over, offered] of CASES) {
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x", ...over })] } });
      const m = await mount();
      expect(m.has("order-resend-d-x"), label).toBe(offered);
      if (offered) expect(flat(textOf(m.find("order-resend-d-x"))), label).toBe(msg("sponsors.order.resend"));
      checked++;
    }
    expect(checked).toBe(CASES.length);
    expect(CASES.filter((c) => c[2]).length, "both arms exercised").toBeGreaterThan(0);
  });

  it("a tap POSTs /sponsor-deals/{id}/send-invoice with no body, shows the link it answered and re-reads; no confirm", async () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_resent";
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x" })] } });
    answerWith("POST", "/sponsor-deals/d-x/send-invoice", { body: { ok: true, data: { deal: deal({ id: "d-x" }), checkout_url: url } } });
    const m = await mount();
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("order-resend-d-x");
    await flush();
    const posts = callsTo("POST", "/send-invoice");
    expect(posts.map((c) => c.url)).toEqual([`${API}/sponsor-deals/d-x/send-invoice`]);
    expect(posts[0]!.body).toBeNull();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(propsOf(m.find("invoice-link")).children).toBe(url);
    expect(callsTo("GET", "/sponsor-deals").length).toBe(readsBefore + 1);
  });

  it("a failed Resend reads Resend's own words and re-reads: stripe_unavailable is 'not sent' (the old link may be closed), deal_paid_online is the sponsor's payment on its way (both)", async () => {
    let checked = 0;
    for (const [status, code, key] of [
      [502, "stripe_unavailable", "sponsors.error.resendStripeUnavailable"],
      [409, "deal_paid_online", "sponsors.error.resendPaidOnline"],
    ] as [number, string, MessageKey][]) {
      net.calls.length = 0;
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x" })] } });
      answerWith("POST", "/sponsor-deals/d-x/send-invoice", refuseWith(status, code));
      const m = await mount();
      const readsBefore = callsTo("GET", "/sponsor-deals").length;
      m.click("order-resend-d-x");
      await flush();
      expect(m.text(), code).toContain(msg(key));
      expect(m.text(), code).not.toContain(msg("sponsors.error.stripeUnavailable"));
      expect(callsTo("GET", "/sponsor-deals").length, `${code}: re-read`).toBe(readsBefore + 1);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("End now is offered on every deal that has not ended, asks first, and says what happens to the public pages (review I2)", () => {
  it("every deal status: offered unless ended (all six checked)", async () => {
    let checked = 0;
    for (const status of DEAL_STATUSES) {
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x", deal_status: status })] } });
      const m = await mount();
      expect(m.has("order-end-d-x"), status).toBe(status !== "ended");
      if (status !== "ended") expect(flat(textOf(m.find("order-end-d-x")))).toBe(msg("sponsors.order.endNow"));
      checked++;
    }
    expect(checked).toBe(DEAL_STATUSES.length);
  });

  it("the confirm body follows the deal: a live deal; an open one behind the sponsor's live deal; an open one with none (each body asserted; the three bodies are different sentences)", async () => {
    // Spec §8a / deal-apply step 4: a live deal keeps the sponsor shown; without one, an open deal hides it.
    const LIVE_OTHER = deal({ id: "d-live", package_id: "p2", deal_status: "live", payment_status: "paid" });
    // The middle case is PAID and not live, so its body also owes New-2's paid-kept sentence (batch G).
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP" }).format(250);
    const CASES: [string, Record<string, unknown>[], string, MessageKey, MessageKey | null][] = [
      ["the live deal itself (paid: the PR 2 ruling - a LIVE paid deal keeps its money too)", [LIVE_OTHER], "d-live", "sponsors.deal.confirm.end.bodyLive", "sponsors.deal.confirm.end.paidKept"],
      ["the live deal itself, unpaid", [deal({ id: "d-live", package_id: "p2", deal_status: "live", payment_status: "pending" })], "d-live", "sponsors.deal.confirm.end.bodyLive", null],
      ["an open deal behind a live one", [LIVE_OTHER, deal({ id: "d-open", deal_status: "scheduled", payment_status: "paid" })], "d-open", "sponsors.deal.confirm.end.bodyKept", "sponsors.deal.confirm.end.paidKept"],
      ["an open deal, nothing live", [deal({ id: "d-open", deal_status: "awaiting_payment" })], "d-open", "sponsors.deal.confirm.end.bodyHidden", null],
    ];
    const seen = new Set<string>();
    let checked = 0;
    for (const [label, rows, target, key, paid] of CASES) {
      confirmMock.mockClear();
      confirmMock.mockImplementationOnce(async () => false);
      answerWith("GET", "/sponsor-deals", { body: { data: rows } });
      const m = await mount();
      m.click(`order-end-${target}`);
      await flush();
      expect(confirmMock, label).toHaveBeenCalledTimes(1);
      const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; tone?: string };
      const want = [msg(key, { name: LONG_NAME }), ...(paid ? [msg(paid, { amount, name: LONG_NAME })] : [])].join(" ");
      expect(opts.body, label).toBe(want);
      expect(opts.title).toBe(msg("sponsors.deal.confirm.end.title"));
      expect(opts.confirmLabel).toBe(msg("sponsors.deal.confirm.end.label"));
      expect(opts.tone).toBe("danger");
      seen.add(opts.body);
      checked++;
    }
    expect(checked).toBe(4);
    expect(seen.size, "four different bodies (live paid / live unpaid / kept / hidden)").toBe(4);
  });

  it("declining sends nothing; confirming POSTs /sponsor-deals/{id}/end with no body and re-reads", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x" })] } });
    answerWith("POST", "/sponsor-deals/d-x/end", { body: { ok: true, data: deal({ id: "d-x", deal_status: "ended", ended_reason: "ended_now" }) } });
    const m = await mount();
    confirmMock.mockImplementationOnce(async () => false);
    m.click("order-end-d-x");
    await flush();
    expect(callsTo("POST", "/end")).toEqual([]);
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("order-end-d-x");
    await flush();
    const posts = callsTo("POST", "/end");
    expect(posts.map((c) => c.url)).toEqual([`${API}/sponsor-deals/d-x/end`]);
    expect(posts[0]!.body).toBeNull();
    expect(callsTo("GET", "/sponsor-deals").length).toBe(readsBefore + 1);
  });

  it("a refused End now reads its code's words and re-reads (the deal moved under it)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x" })] } });
    answerWith("POST", "/sponsor-deals/d-x/end", refuseWith(409, "deal_changed"));
    const m = await mount();
    const readsBefore = callsTo("GET", "/sponsor-deals").length;
    m.click("order-end-d-x");
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.dealChanged"));
    expect(callsTo("GET", "/sponsor-deals").length).toBe(readsBefore + 1);
  });
});

describe("the invoice form says when the new deal will start: behind a live deal it queues (spec §8a), otherwise it hides the sponsor until paid", () => {
  it("exactly one of the two lines, by the picked sponsor: live deal -> the queue line; none -> the hidden line (both directions)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-live", sponsor_id: "sp-a", package_id: "p2", deal_status: "live", payment_status: "paid" })] } });
    const m = await mount();
    m.click("invoice-open-p1");
    expect(flat(textOf(m.find("invoice-queued-note")))).toBe(msg("sponsors.order.queuedAfterCurrent"));
    expect(m.has("invoice-hidden-note")).toBe(false);
    m.pick("sp-c");
    expect(m.has("invoice-queued-note"), "a sponsor with no live deal does not queue").toBe(false);
    expect(m.has("invoice-hidden-note")).toBe(true);
  });
});

describe("an ended deal that was never paid says so (review m3)", () => {
  it("ended + pending or failed reads Ended, unpaid; ended + paid, and a live unpaid deal, keep their payment label (all four)", async () => {
    const CASES: [Record<string, unknown>, MessageKey][] = [
      [{ deal_status: "ended", payment_status: "pending", ended_reason: "ended_now" }, "sponsors.order.status.endedUnpaid"],
      [{ deal_status: "ended", payment_status: "failed", ended_reason: "expired" }, "sponsors.order.status.endedUnpaid"],
      [{ deal_status: "ended", payment_status: "paid", ended_reason: "expired" }, "sponsors.order.status.paid"],
      [{ deal_status: "live", payment_status: "pending" }, "sponsors.order.status.pending"],
    ];
    let checked = 0;
    for (const [over, key] of CASES) {
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-x", ...over })] } });
      const m = await mount();
      expect(m.text(), JSON.stringify(over)).toContain(msg(key));
      if (key !== "sponsors.order.status.endedUnpaid") expect(m.text()).not.toContain(msg("sponsors.order.status.endedUnpaid"));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the refund confirm says whether money moves through Stripe - on the SAME fact the server refunds on (review m1, batch G New-3)", () => {
  // server/usecases/sponsor-deals.ts refundDeal: a recorded payment intent is refunded through Stripe; none is recorded only.
  // The list carries that fact as `has_payment_intent` (never the intent id). `marked_paid_by` is NOT it: it is nulled when the
  // marking user is deleted, and the second case below is exactly that row.
  it("intent recorded: the card body; no intent - marked by hand (marker since deleted, or still there), or offline: the recorded body (all four)", async () => {
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP" }).format(250);
    const CASES: [string, Record<string, unknown>, MessageKey][] = [
      ["online, paid at Stripe", { payment_method: "online", has_payment_intent: true, marked_paid_by: null }, "sponsors.deal.confirm.refund.body"],
      ["online, marked paid by a user since deleted", { payment_method: "online", has_payment_intent: false, marked_paid_by: null }, "sponsors.deal.confirm.refund.bodyRecorded"],
      ["online, marked paid by hand", { payment_method: "online", has_payment_intent: false, marked_paid_by: "u-1" }, "sponsors.deal.confirm.refund.bodyRecorded"],
      ["offline", { payment_method: "offline", has_payment_intent: false, marked_paid_by: "u-1", sponsor_email: null }, "sponsors.deal.confirm.refund.bodyRecorded"],
    ];
    let checked = 0;
    for (const [label, over, key] of CASES) {
      confirmMock.mockClear();
      confirmMock.mockImplementationOnce(async () => false);
      answerWith("GET", "/sponsor-deals", { body: { data: [deal({ id: "d-paid", deal_status: "live", payment_status: "paid", ...over })] } });
      const m = await mount();
      m.click("order-refund-d-paid");
      await flush();
      const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
      expect(body, label).toBe(
        [
          msg(key, { amount, name: LONG_NAME }),
          msg("sponsors.deal.confirm.refund.placementLive", { name: LONG_NAME }),
          msg("sponsors.deal.confirm.refund.irreversible"),
        ].join(" "),
      );
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the refund confirm says what the public pages do, by the deal's state (review m1 remainder, batch G)", () => {
  // A refund ends the deal (spec §5.2), so the pages do what ending it does - spec §8a / deal-apply step 4: a live deal hands
  // over to its queue or comes off; a deal that never went live leaves the sponsor as it was - shown under its live deal, else
  // hidden; a deal that has already ended changes nothing. Typed from the spec, one sentence per state.
  const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP" }).format(250);
  const LIVE_OTHER = deal({ id: "d-live", package_id: "p2", deal_status: "live", payment_status: "paid", has_payment_intent: true });
  const CASES: [string, Record<string, unknown>[], MessageKey][] = [
    ["live", [deal({ id: "d-r", deal_status: "live", payment_status: "paid", has_payment_intent: true })], "sponsors.deal.confirm.refund.placementLive"],
    ["scheduled behind the sponsor's live deal", [LIVE_OTHER, deal({ id: "d-r", deal_status: "scheduled", payment_status: "paid", has_payment_intent: true })], "sponsors.deal.confirm.refund.placementKept"],
    ["awaiting approval, nothing live", [deal({ id: "d-r", deal_status: "awaiting_approval", payment_status: "paid", has_payment_intent: true })], "sponsors.deal.confirm.refund.placementHidden"],
    ["ended (expired), paid", [deal({ id: "d-r", deal_status: "ended", ended_reason: "expired", payment_status: "paid", has_payment_intent: true })], "sponsors.deal.confirm.refund.placementEnded"],
  ];

  it("live -> hands over or comes off; behind a live deal -> kept; nothing live -> stays off; ended -> no change (all four, four different bodies)", async () => {
    const seen = new Set<string>();
    let checked = 0;
    for (const [label, rows, placement] of CASES) {
      confirmMock.mockClear();
      confirmMock.mockImplementationOnce(async () => false);
      answerWith("GET", "/sponsor-deals", { body: { data: rows } });
      const m = await mount();
      m.click("order-refund-d-r");
      await flush();
      const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
      expect(body, label).toBe(
        [
          msg("sponsors.deal.confirm.refund.body", { amount, name: LONG_NAME }),
          msg(placement, { name: LONG_NAME }),
          msg("sponsors.deal.confirm.refund.irreversible"),
        ].join(" "),
      );
      seen.add(body);
      checked++;
    }
    expect(checked).toBe(4);
    expect(seen.size, "four different sentences").toBe(4);
  });

  it("a recorded refund says the same about the pages (the placement does not depend on how the money moves)", async () => {
    confirmMock.mockImplementationOnce(async () => false);
    answerWith("GET", "/sponsor-deals", {
      body: { data: [LIVE_OTHER, deal({ id: "d-r", deal_status: "scheduled", payment_method: "offline", payment_status: "paid", marked_paid_by: "u-1" })] },
    });
    const m = await mount();
    m.click("order-refund-d-r");
    await flush();
    expect((confirmMock.mock.calls[0]![0] as { body: string }).body).toBe(
      [
        msg("sponsors.deal.confirm.refund.bodyRecorded", { amount, name: LONG_NAME }),
        msg("sponsors.deal.confirm.refund.placementKept", { name: LONG_NAME }),
        msg("sponsors.deal.confirm.refund.irreversible"),
      ].join(" "),
    );
  });

  it("the card body's money sentence no longer promises the placement comes off, in any locale (counted)", () => {
    const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
    const PAGES: Record<string, RegExp> = { en: /public pages/i, es: /páginas públicas/i, fr: /pages publiques/i, nl: /openbare pagina/i };
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      for (const key of ["sponsors.deal.confirm.refund.body", "sponsors.deal.confirm.refund.bodyRecorded"]) {
        expect(dict[key], `${loc} ${key}`).toBeTruthy();
        expect(dict[key], `${loc} ${key}`).not.toMatch(PAGES[loc]!);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });
});

describe("End now on a paid deal - live or not - says the money stays and a refund is separate (batch G New-2; PR 2 ruling: live too)", () => {
  // Ending a deal never moves money (server/usecases/sponsor-deals.ts endDealNow); Refund stays offered on a paid deal ended
  // by End now (lib/sponsor-deals.ts allowedActions). A disputed payment is not the club's to refund, so it is not told to.
  // The first arm of this was "paid but NOT live"; the PR 2 ruling (batch H brief) extends it to a LIVE paid deal.
  const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP" }).format(250);
  const LIVE_OTHER = deal({ id: "d-live", package_id: "p2", deal_status: "live", payment_status: "paid" });
  const CASES: [string, Record<string, unknown>[], boolean][] = [
    ["scheduled, paid, behind a live deal", [LIVE_OTHER, deal({ id: "d-e", deal_status: "scheduled", payment_status: "paid" })], true],
    ["awaiting approval, paid", [deal({ id: "d-e", deal_status: "awaiting_approval", payment_status: "paid" })], true],
    ["live, paid (the PR 2 ruling: a LIVE paid deal keeps its money too)", [deal({ id: "d-e", deal_status: "live", payment_status: "paid" })], true],
    ["live, paid, disputed", [deal({ id: "d-e", deal_status: "live", payment_status: "paid", disputed_at: "2026-11-02T10:00:00.000Z" })], false],
    ["awaiting payment, unpaid", [deal({ id: "d-e", deal_status: "awaiting_payment", payment_status: "pending" })], false],
    ["scheduled, paid, disputed", [LIVE_OTHER, deal({ id: "d-e", deal_status: "scheduled", payment_status: "paid", disputed_at: "2026-11-02T10:00:00.000Z" })], false],
  ];

  it("paid (live or not) -> the paid-kept sentence names the amount; unpaid or disputed -> none (all six)", async () => {
    const paidKept = msg("sponsors.deal.confirm.end.paidKept", { amount, name: LONG_NAME });
    let checked = 0;
    for (const [label, rows, says] of CASES) {
      confirmMock.mockClear();
      confirmMock.mockImplementationOnce(async () => false);
      answerWith("GET", "/sponsor-deals", { body: { data: rows } });
      const m = await mount();
      m.click("order-end-d-e");
      await flush();
      const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
      if (says) expect(body.endsWith(` ${paidKept}`), label).toBe(true);
      else expect(body, label).not.toContain(paidKept);
      checked++;
    }
    expect(checked).toBe(6);
    expect(CASES.filter((c) => c[2]).length, "both arms exercised").toBe(3);
  });

  it("the sentence exists in all four locales, names the amount and the Refund button by its own label (counted)", () => {
    const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const text = dict["sponsors.deal.confirm.end.paidKept"];
      expect(text, loc).toBeTruthy();
      expect(text, loc).toContain("{amount}");
      expect(text, loc).toContain(dict["sponsors.deal.action.refund"]!);
      if (loc !== "en") expect(text, loc).not.toBe(LOCALES.en!["sponsors.deal.confirm.end.paidKept"]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the Invoice sent banner shows a pay link only while its deal can still be paid (batch G New-1)", () => {
  const url = "https://checkout.stripe.com/c/pay/cs_test_banner";
  const OPEN = deal({ id: "d-new", sponsor_id: "sp-a" });
  const OTHER = deal({ id: "d-other", sponsor_id: "sp-c", sponsor_name: "Quay Chandlers", package_id: "p2" });

  it("End now on ANOTHER deal leaves it; End now on the sent deal hides it (the pair, keyed on the deal id)", async () => {
    answerWith("GET", "/sponsor-deals", { body: { data: [OTHER] } });
    answerWith("POST", "/sponsors/sp-a/deals", { status: 201, body: { ok: true, data: { deal: OPEN, checkout_url: url } } });
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    answerWith("GET", "/sponsor-deals", { body: { data: [OPEN, OTHER] } });
    m.click("invoice-send");
    await flush();
    expect(propsOf(m.find("invoice-link")).children, "shown after the send").toBe(url);

    answerWith("GET", "/sponsor-deals", { body: { data: [OPEN, { ...OTHER, deal_status: "ended", ended_reason: "ended_now" }] } });
    m.click("order-end-d-other");
    await flush();
    expect(m.has("invoice-link"), "another deal ending leaves the link").toBe(true);

    answerWith("GET", "/sponsor-deals", { body: { data: [{ ...OPEN, deal_status: "ended", ended_reason: "ended_now" }] } });
    m.click("order-end-d-new");
    await flush();
    expect(callsTo("POST", "/end").map((c) => c.url)).toEqual([`${API}/sponsor-deals/d-other/end`, `${API}/sponsor-deals/d-new/end`]);
    expect(m.has("invoice-link"), "the sent deal ended: its link is dead").toBe(false);
    expect(m.text()).not.toContain(msg("sponsors.deal.payLink.sent"));
  });

  it("a re-read that shows the resent deal paid, or refunded, hides it (both)", async () => {
    let checked = 0;
    for (const settled of [{ payment_status: "paid", deal_status: "live" }, { payment_status: "refunded", deal_status: "ended", ended_reason: "refunded" }]) {
      const X = deal({ id: "d-x" });
      answerWith("GET", "/sponsor-deals", { body: { data: [X, OTHER] } });
      answerWith("POST", "/sponsor-deals/d-x/send-invoice", { body: { ok: true, data: { deal: X, checkout_url: url } } });
      const m = await mount();
      m.click("order-resend-d-x");
      await flush();
      expect(propsOf(m.find("invoice-link")).children, "shown after the resend").toBe(url);
      // Any later re-read (here End now on the other deal) brings the settled row.
      answerWith("GET", "/sponsor-deals", { body: { data: [{ ...X, ...settled }, OTHER] } });
      m.click("order-end-d-other");
      await flush();
      expect(m.has("invoice-link"), JSON.stringify(settled)).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the duplicate confirm says whether the open deal still has money to take (review m8)", () => {
  async function dupBody(existing: Record<string, unknown>[]): Promise<string> {
    answerWith("GET", "/sponsor-deals", { body: { data: existing } });
    confirmMock.mockImplementationOnce(async () => false);
    const m = await mount();
    m.click("invoice-open-p1");
    m.typeEmail("pay@harbourside.test");
    m.click("invoice-send");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    return (confirmMock.mock.calls[0]![0] as { body: string }).body;
  }

  it("an open deal still unpaid -> the could-pay-twice body; open deals with nothing left to pay -> the settled body; one of each -> could-pay-twice (all four)", async () => {
    const UNPAID = deal({ id: "d-u", deal_status: "awaiting_payment", payment_status: "failed" });
    const PAID_WAITING = deal({ id: "d-p", deal_status: "awaiting_approval", payment_status: "paid" });
    const COMP_QUEUED = deal({ id: "d-c", deal_status: "scheduled", payment_method: "complimentary", payment_status: "none" });
    const CASES: [string, Record<string, unknown>[], MessageKey][] = [
      ["unpaid", [UNPAID], "sponsors.deal.confirm.dup.body"],
      ["paid, awaiting approval", [PAID_WAITING], "sponsors.deal.confirm.dup.bodySettled"],
      ["complimentary, queued", [COMP_QUEUED], "sponsors.deal.confirm.dup.bodySettled"],
      ["one of each", [PAID_WAITING, UNPAID], "sponsors.deal.confirm.dup.body"],
    ];
    let checked = 0;
    for (const [label, rows, key] of CASES) {
      confirmMock.mockClear();
      expect(await dupBody(rows), label).toBe(msg(key, { name: LONG_NAME }));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("a package whose competition has finished offers no Send invoice (review m4; the create refuses it anyway)", () => {
  it("the finished competition's package shows the finished label and keeps Retire; the whole-org package keeps Send invoice", async () => {
    const m = await mount({ finishedCompetitionIds: ["c1"] });
    expect(m.has("invoice-open-p2"), "p2 is for c1, which has finished").toBe(false);
    expect(flat(textOf(m.find("pkg-finished-p2")))).toBe(msg("sponsors.pkg.competitionFinished"));
    expect(m.has("invoice-open-p1"), "the whole-org package is still sold").toBe(true);
    expect(m.has("pkg-finished-p1")).toBe(false);
    const retire = m.island.tree().filter((e) => propsOf(e)["aria-label"] === msg("sponsors.pkg.retire", { name: PKG_ONE_COMP.name }));
    expect(retire, "Retire is still offered on the finished package").toHaveLength(1);
  });

  it("nothing finished (the prop absent or empty): both packages offer Send invoice and no finished label (both)", async () => {
    let checked = 0;
    for (const over of [{}, { finishedCompetitionIds: [] }]) {
      const m = await mount(over);
      expect(m.has("invoice-open-p2")).toBe(true);
      expect(m.has("pkg-finished-p2")).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("End now's live-deal sentence is true by F19: a queued deal goes live only if its end date has not passed (batch F fix round 2)", () => {
  // server/sponsors/deal-apply.ts: ending the live deal promotes the next scheduled deal unless it is already past its own end
  // (F19, it stays queued and hidden until the sweep ends it). The sentence must carry that condition in every locale.
  const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
  const END_DATE: Record<string, RegExp> = { en: /end date/i, es: /fecha de fin/i, fr: /date de fin/i, nl: /einddatum/i };

  it("names the queued deal's end date in all four locales, and still names the sponsor (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const text = dict["sponsors.deal.confirm.end.bodyLive"];
      expect(text, loc).toMatch(END_DATE[loc]!);
      expect(text, loc).toContain("{name}");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
