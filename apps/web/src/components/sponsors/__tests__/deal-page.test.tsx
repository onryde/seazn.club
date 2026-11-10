// Sponsor deals PR 2, Task 17 - the deal page (components/sponsors/deal-page.tsx; spec §6.5, mockup screen 5): one deal - what happens
// next, the timeline, the deal's facts and what going live switches on - opened from `?sponsor=<id>&deal=<id>`, the page body below md
// and a side panel from md (the same wrapper as the sponsor's page).
//
// Every expectation is typed from the brief, the spec or the mockup's own words - never read back from the component. The one
// exception is deliberate and labelled: the sweep that ties the buttons to `allowedActions` (the engine's answer, the single authority).
// vitest is `environment: "node"`: the body's markup is read from `renderToStaticMarkup`, a click is the element's own handler called in
// the tree `_sponsor-tree.tsx` expands (DealPageBody is stateless; every bit of state is OrgSponsors'). What none of that can see
// (CSS, real widths, a real tap, the panel over the list) is `e2e/sponsor-deals.spec.ts`, run by CI.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   D1  actions   render Refund for a complimentary deal                                          -> "the buttons are the engine's answer"
//   D2  order     draw the buttons in a hand-written order (End now first)                        -> "in DEAL_ACTIONS order"
//   D3  evidence  draw Evidence pack before the actions / on every deal                           -> "Evidence pack: only when disputed, and last"
//   D4  seam      OrgSponsors ignores hub.dealId                                                  -> "hub.dealId opens the deal page"
//   D5  money     the refund confirm reads the card words for a deal marked paid by hand          -> "Refund ... a deal marked paid by hand"
//   D6  timeline  hide a missed step like a skipped one                                           -> "an ended unpaid deal: Not paid"
//   D7  pay link  the banner outlives its deal                                                    -> "the pay-link banner follows its deal"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
const mdUp = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/components/ui/use-md-up", () => ({ useMdUp: () => mdUp.value }));

import { OrgSponsors, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { AddDealSheet } from "@/components/sponsors/add-deal-sheet";
import { DealPageBody, type DealPageBodyProps } from "@/components/sponsors/deal-page";
import { SponsorSheet } from "@/components/sponsors/sponsor-sheet";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "./_sponsor-tree";
import { attrOf, findAll, findOne, textOfMarkup } from "./_markup";
import {
  allowedActions, DEAL_ACTIONS, DEAL_STATUSES, GO_LIVE_RULES, PAYMENT_METHODS, PAYMENT_STATUSES, initialPaymentStatus,
  type DealAction, type SponsorDeal,
} from "@/lib/sponsor-deals";
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
const SLUG = "harbour-vale";
const API = `/api/v1/orgs/${ORG}`;
const SPONSOR_URL = `/o/${SLUG}/sponsors?tab=sponsors&sponsor=a`;
const COMPS = [
  { id: "c-season", name: "Season 2026/27", ends_on: "2027-08-31" },
  { id: "c-winter", name: "Winter League 2026/27", ends_on: null },
];

// --- fixtures: the mockup's own deals (screen 1's rows, screen 5's two states) ---------------------------------------------------

const BASE: SponsorDeal = {
  id: "d0", sponsor_id: "a", package_id: "p0", deal_status: "live", payment_status: "paid", payment_method: "online",
  go_live: "on_payment", package_name: "Silver Season", tier: "silver", includes_on_stream: false, competition_id: "c-season",
  amount_cents: 30_000, currency: "gbp", sponsor_name: "Quay Fisheries", sponsor_email: "accounts@quayfisheries.co.uk",
  ends_at: "2027-09-01T00:00:00.000Z", created_at: "2026-10-14T09:00:00.000Z", created_by: null, invoice_sent_at: null, paid_at: null,
  marked_paid_by: null, approved_at: null, approved_by: null, live_at: null, ended_at: null, ended_reason: null, parked_at: null,
  disputed_at: null, dispute_id: null, has_payment_intent: false, invoice_number: null,
};
const deal = (over: Partial<SponsorDeal>): SponsorDeal => ({ ...BASE, ...over });

/** Screen 5, first state: "Paid online, waiting for approval - Quay Fisheries". */
const QUAY = deal({
  id: "dq", deal_status: "awaiting_approval", payment_status: "paid", payment_method: "online", go_live: "on_approval",
  invoice_sent_at: "2026-10-14T09:05:00.000Z", paid_at: "2026-10-16T11:00:00.000Z", has_payment_intent: true,
});
/** Screen 5, second state: an offline deal awaiting its bank transfer. */
const MARLOW = deal({
  id: "dm", sponsor_name: "Marlow & Daughters Bakery", sponsor_email: null, deal_status: "awaiting_payment", payment_status: "pending",
  payment_method: "offline", go_live: "on_payment", created_at: "2026-10-20T09:00:00.000Z",
});
/** Screen 1: Ridge Gold - online, invoice sent, awaiting payment. */
const RIDGE = deal({
  id: "dr", package_name: "Gold Season", tier: "gold", amount_cents: 60_000, deal_status: "awaiting_payment", payment_status: "pending",
  payment_method: "online", go_live: "on_payment", invoice_sent_at: "2026-10-28T10:00:00.000Z", sponsor_name: "Ridge Gold Physiotherapy",
});
/** Screen 1: Kestrel Taxis - an online draft, not sent yet. */
const KESTREL = deal({
  id: "dk", package_name: "Partner", tier: "partner", amount_cents: 12_000, competition_id: null, deal_status: "draft",
  payment_status: "pending", payment_method: "online", go_live: "on_payment", sponsor_name: "Kestrel Taxis", ends_at: null,
});
/** Screen 1: Harbourside - live and paid. */
const HARBOUR = deal({
  id: "dh", package_name: "Title Season", tier: "title", amount_cents: 150_000, deal_status: "live", payment_status: "paid",
  go_live: "on_payment", live_at: "2026-10-02T09:00:00.000Z", paid_at: "2026-10-02T08:00:00.000Z", has_payment_intent: true,
  includes_on_stream: true,
});
/** Screen 1: Old Anchor - live and complimentary. */
const OLD_ANCHOR = deal({
  id: "do", package_name: "Partner", tier: "partner", amount_cents: 0, competition_id: "c-winter", deal_status: "live",
  payment_status: "none", payment_method: "complimentary", go_live: "immediate", sponsor_email: null, live_at: "2026-09-01T09:00:00.000Z",
  ends_at: null,
});

const noop = () => {};
function props(over: Partial<DealPageBodyProps> = {}): DealPageBodyProps {
  return {
    deal: QUAY, sponsorName: "Quay Fisheries", orgId: ORG, canEdit: true, busy: false, tz: "UTC", orgTz: "UTC", competitions: COMPS,
    createdBy: "Sam Patel", competitionFinished: false, payLink: null, error: null, notice: null, onAction: noop, ...over,
  };
}
const html = (over: Partial<DealPageBodyProps> = {}) => renderToStaticMarkup(<DealPageBody {...props(over)} />);
const actionsOf = (markup: string) => findAll(markup, "deal-page-action").map((b) => attrOf(b.open, "data-action"));
const step = (markup: string, key: string) => findAll(markup, "deal-page-step").find((s) => attrOf(s.open, "data-step") === key);
const stepWords = (markup: string, key: string): [string, string] | null => {
  const s = step(markup, key);
  if (!s) return null;
  return [textOfMarkup(findOne(s.outer, "deal-page-step-title").outer), textOfMarkup(findOne(s.outer, "deal-page-step-line").outer)];
};

beforeEach(() => {
  vi.clearAllMocks();
  mdUp.value = null;
});

// --- the header: the package, the price, the sponsor and the chip -----------------------------------------------------------------

describe("the header (acceptance: the package, the price, the sponsor and the chip)", () => {
  it("reads 'Silver Season · £300', the sponsor, and the deal's chip (screen 5, Quay Fisheries)", () => {
    const markup = html();
    expect(textOfMarkup(findOne(markup, "deal-page-name").outer)).toBe("Silver Season · £300");
    expect(textOfMarkup(findOne(markup, "deal-page-sponsor").outer)).toBe("Quay Fisheries");
    const chip = findOne(markup, "deal-chip");
    expect(attrOf(chip.open, "data-chip-kind")).toBe("awaiting_approval");
    expect(textOfMarkup(chip.outer)).toBe("Awaiting approval");
  });

  it("a complimentary deal has no price to show: it says Complimentary, not £0", () => {
    const markup = html({ deal: OLD_ANCHOR, sponsorName: "Old Anchor Café" });
    expect(textOfMarkup(findOne(markup, "deal-page-name").outer)).toBe("Partner · Complimentary");
  });

  it("the page is the deal's: its id and status ride on the section", () => {
    const section = findOne(html(), "deal-page");
    expect(attrOf(section.open, "data-deal-id")).toBe("dq");
    expect(attrOf(section.open, "data-deal-status")).toBe("awaiting_approval");
  });

  it("the dispute badges: 'Disputed' while a dispute is open, 'Dispute lost' only when the engine ended the deal for it", () => {
    const CASES: { label: string; d: SponsorDeal; badge: string | null }[] = [
      { label: "an open dispute", d: deal({ deal_status: "live", payment_status: "paid", disputed_at: "2026-11-02T10:00:00.000Z", dispute_id: "dp_1" }), badge: "Disputed" },
      // The producer KEEPS `disputed_at` on a loss (usecases/sponsors.ts: the loss path sets status/deal_status/ended_*, never clears it), so
      // the lost deal arrives with both set - and the dispute is over, so it must read "Dispute lost" alone, not "Disputed" beside it.
      { label: "a lost dispute (disputed_at kept)", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "dispute_lost", ended_at: "2026-11-05T10:00:00.000Z", disputed_at: "2026-11-02T10:00:00.000Z", dispute_id: "dp_1" }), badge: "Dispute lost" },
      { label: "a lost dispute with nothing else recorded", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "dispute_lost", ended_at: "2026-11-05T10:00:00.000Z", dispute_id: "dp_1" }), badge: "Dispute lost" },
      // A pre-deals order that lost a dispute: the legacy branch only flips the order to refunded (no `ended_reason` of its own), so the
      // loss is told by the refund + the dispute id - the old screen's rule.
      { label: "a legacy order that lost a dispute", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "legacy", ended_at: "2026-10-01T10:00:00.000Z", disputed_at: "2026-09-02T10:00:00.000Z", dispute_id: "dp_9" }), badge: "Dispute lost" },
      { label: "a legacy order refunded by the club (no dispute)", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "legacy", ended_at: "2026-10-01T10:00:00.000Z" }), badge: null },
      { label: "a dispute still open on an ended deal", d: deal({ deal_status: "ended", payment_status: "paid", ended_reason: "ended_now", ended_at: "2026-11-03T10:00:00.000Z", disputed_at: "2026-11-02T10:00:00.000Z", dispute_id: "dp_1" }), badge: "Disputed" },
      // The false claim to refuse: a deal the CLUB refunded after a dispute it won still carries the dispute's id.
      { label: "a club refund after a won dispute", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "refunded", ended_at: "2026-11-05T10:00:00.000Z", dispute_id: "dp_1" }), badge: null },
      { label: "no dispute", d: deal({ deal_status: "live", payment_status: "paid" }), badge: null },
    ];
    let checked = 0;
    for (const c of CASES) {
      const badges = findAll(html({ deal: c.d }), "deal-page-badge").map((b) => textOfMarkup(b.outer));
      expect(badges, c.label).toEqual(c.badge === null ? [] : [c.badge]);
      checked++;
    }
    expect(checked).toBe(8);
  });
});

// --- the actions: exactly allowedActions, in DEAL_ACTIONS order (F27) --------------------------------------------------------------

describe("the buttons are the engine's answer, in DEAL_ACTIONS order (F27)", () => {
  const WORDS: Record<DealAction, string> = {
    send_invoice: "Send invoice", resend_invoice: "Resend invoice", mark_paid: "Mark as paid", approve: "Approve", refund: "Refund", end_now: "End now",
  };
  // Typed from spec §5.2 and the mockup's "Actions by state" - NOT read from allowedActions.
  const CASES: { label: string; d: SponsorDeal; want: DealAction[] }[] = [
    { label: "paid online, awaiting approval (screen 5: Approve, Refund, End now)", d: QUAY, want: ["approve", "refund", "end_now"] },
    { label: "offline, awaiting payment (screen 5: Mark as paid, End now)", d: MARLOW, want: ["mark_paid", "end_now"] },
    { label: "online, invoice sent, awaiting payment (Mark as paid, Resend invoice, End now)", d: RIDGE, want: ["resend_invoice", "mark_paid", "end_now"] },
    { label: "online draft, not sent", d: KESTREL, want: ["send_invoice", "end_now"] },
    { label: "live and paid (Refund, End now)", d: HARBOUR, want: ["refund", "end_now"] },
    { label: "live and complimentary (End now only: there is no money to refund)", d: OLD_ANCHOR, want: ["end_now"] },
    { label: "live, paid, disputed (the dispute's to settle, not the club's to refund)", d: deal({ ...HARBOUR, disputed_at: "2026-11-02T10:00:00.000Z" }), want: ["end_now"] },
    { label: "scheduled and paid", d: deal({ deal_status: "scheduled", payment_status: "paid", go_live: "on_payment" }), want: ["refund", "end_now"] },
    { label: "ended, never paid", d: deal({ deal_status: "ended", payment_status: "pending", ended_reason: "ended_now", ended_at: "2026-10-30T10:00:00.000Z" }), want: [] },
    { label: "ended, paid (the money is still the club's to refund)", d: deal({ deal_status: "ended", payment_status: "paid", ended_reason: "ended_now", ended_at: "2026-10-30T10:00:00.000Z" }), want: ["refund"] },
    { label: "ended, already refunded", d: deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "refunded", ended_at: "2026-10-30T10:00:00.000Z" }), want: [] },
  ];

  it("each state draws exactly what the spec offers, in the spec's order, with the right words (D1, D2)", () => {
    let checked = 0;
    for (const c of CASES) {
      const markup = html({ deal: c.d });
      expect(actionsOf(markup), c.label).toEqual(c.want);
      for (const b of findAll(markup, "deal-page-action")) {
        expect(textOfMarkup(b.outer), `${c.label}: words`).toBe(WORDS[attrOf(b.open, "data-action") as DealAction]);
      }
      checked++;
    }
    expect(checked).toBe(CASES.length);
    expect(CASES.some((c) => c.want.length === 0), "the empty case is in the table").toBe(true);
    expect(CASES.filter((c) => c.want.length === 3).length, "and the longest rows, where order shows").toBeGreaterThanOrEqual(2);
  });

  it("every status x payment x method x rule the model can produce draws allowedActions - the engine's answer, never a client copy", () => {
    let checked = 0;
    let withButtons = 0;
    for (const deal_status of DEAL_STATUSES) {
      for (const payment_method of PAYMENT_METHODS) {
        const payments = payment_method === "complimentary" ? [initialPaymentStatus("complimentary")] : PAYMENT_STATUSES.filter((p) => p !== "none");
        for (const payment_status of payments) {
          for (const go_live of GO_LIVE_RULES) {
            if (payment_method === "complimentary" && go_live === "on_payment") continue;
            const d = deal({ id: "t", deal_status, payment_status, payment_method, go_live, ended_reason: deal_status === "ended" ? "expired" : null });
            const drawn = actionsOf(html({ deal: d }));
            expect(drawn, `${deal_status}/${payment_status}/${payment_method}/${go_live}`).toEqual(allowedActions(d));
            // ...in DEAL_ACTIONS order: a hand-written order would break exactly here.
            expect(drawn, "in DEAL_ACTIONS order").toEqual(DEAL_ACTIONS.filter((a) => drawn.includes(a)));
            if (drawn.length) withButtons++;
            checked++;
          }
        }
      }
    }
    expect(checked, "the sweep is not vacuous").toBeGreaterThan(60);
    expect(withButtons, "both arms are exercised").toBeGreaterThan(10);
    expect(withButtons).toBeLessThan(checked);
  });

  it("a viewer reads the deal and changes nothing: no buttons, no Evidence pack, but the timeline and the facts are there", () => {
    const markup = html({ deal: deal({ ...HARBOUR, disputed_at: "2026-11-02T10:00:00.000Z" }), canEdit: false });
    expect(findAll(markup, "deal-page-action")).toHaveLength(0);
    expect(findAll(markup, "deal-page-evidence")).toHaveLength(0);
    expect(findAll(markup, "deal-page-actions")).toHaveLength(0);
    expect(findAll(markup, "deal-page-step").length).toBeGreaterThan(0);
    expect(findAll(markup, "deal-page-fact").length).toBeGreaterThan(0);
  });

  it("a write in flight disables every button (a second tap would start a second write) and a button is 44px on a phone", () => {
    const markup = html({ deal: QUAY, busy: true });
    const buttons = findAll(markup, "deal-page-action");
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(/\sdisabled(=|\s|>)/.test(b.open), "disabled while busy").toBe(true);
      expect((attrOf(b.open, "class") ?? "").split(/\s+/), "a 44px target below md").toContain("max-md:min-h-11");
    }
    for (const b of findAll(html({ deal: QUAY }), "deal-page-action")) expect(/\sdisabled(=|\s|>)/.test(b.open)).toBe(false);
  });

  it("a button is named for its deal (aria-label carries the package) and Approve is the primary one", () => {
    const markup = html({ deal: QUAY });
    const approve = findAll(markup, "deal-page-action").find((b) => attrOf(b.open, "data-action") === "approve")!;
    expect(attrOf(approve.open, "aria-label")).toBe("Approve: Silver Season");
    expect((attrOf(approve.open, "class") ?? "").split(/\s+/)).toContain("btn-primary");
    const end = findAll(markup, "deal-page-action").find((b) => attrOf(b.open, "data-action") === "end_now")!;
    expect((attrOf(end.open, "class") ?? "").split(/\s+/), "End now and Refund are the danger ones").toContain("text-red-600");
  });

  it("a click hands the deal and the action to the page that owns the write (the seam, driven through the tree)", () => {
    const onAction = vi.fn();
    const island = renderIsland(DealPageBody, props({ deal: QUAY, onAction }), expandSponsorTree);
    const buttons = island.tree().filter((e) => propsOf(e)["data-testid"] === "deal-page-action");
    expect(buttons.map((b) => propsOf(b)["data-action"])).toEqual(["approve", "refund", "end_now"]);
    for (const b of buttons) (propsOf(b).onClick as () => void)();
    expect(onAction.mock.calls.map((c) => [(c[0] as SponsorDeal).id, c[1]])).toEqual([["dq", "approve"], ["dq", "refund"], ["dq", "end_now"]]);
  });
});

// --- Evidence pack: the one control that is not a DealAction ----------------------------------------------------------------------

describe("Evidence pack: only when disputed, and last (D3)", () => {
  const DISPUTED = deal({ ...HARBOUR, disputed_at: "2026-11-02T10:00:00.000Z", dispute_id: "dp_1" });

  it("a disputed deal draws it AFTER every action, as a download of this deal's evidence route", () => {
    const markup = html({ deal: DISPUTED });
    const evidence = findOne(markup, "deal-page-evidence");
    expect(attrOf(evidence.open, "href")).toBe(`${API}/sponsor-deals/dh/evidence`);
    expect(evidence.open, "a download").toMatch(/\sdownload(=|\s|>)/);
    expect(textOfMarkup(evidence.outer)).toBe("Evidence pack");
    const actions = findOne(markup, "deal-page-actions").inner;
    expect(actionsOf(markup), "the actions are still the engine's").toEqual(["end_now"]);
    expect(actions.indexOf('data-testid="deal-page-evidence"'), "Evidence pack comes after the last action").toBeGreaterThan(actions.lastIndexOf('data-testid="deal-page-action"'));
  });

  it("with every action there too, it is still last (the longest row)", () => {
    // disputed + awaiting approval: Approve and End now are offered (Refund is not: a dispute is the dispute's to settle).
    const d = deal({ ...QUAY, disputed_at: "2026-11-02T10:00:00.000Z" });
    const markup = html({ deal: d });
    const html2 = findOne(markup, "deal-page-actions").inner;
    expect(actionsOf(markup)).toEqual(["approve", "end_now"]);
    expect(html2.lastIndexOf('data-testid="deal-page-action"')).toBeLessThan(html2.indexOf('data-testid="deal-page-evidence"'));
    expect(html2.trimEnd().endsWith("</a>"), "nothing follows the pack").toBe(true);
  });

  it("a LOST dispute is over: no evidence pack to download, not even an empty actions row (the producer keeps disputed_at on a loss; 3 counted)", () => {
    const lost = deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "dispute_lost", ended_at: "2026-11-05T10:00:00.000Z", disputed_at: "2026-11-02T10:00:00.000Z", dispute_id: "dp_1" });
    const legacyLoss = deal({ deal_status: "ended", payment_status: "refunded", ended_reason: "legacy", ended_at: "2026-10-01T10:00:00.000Z", disputed_at: "2026-09-02T10:00:00.000Z", dispute_id: "dp_9" });
    let checked = 0;
    for (const d of [lost, legacyLoss]) {
      const markup = html({ deal: d });
      expect(findAll(markup, "deal-page-evidence"), d.id).toHaveLength(0);
      expect(findAll(markup, "deal-page-actions"), `${d.ended_reason}: nothing to press`).toHaveLength(0);
      checked++;
    }
    // The pair: the same deal ended some OTHER way, with the dispute still open, keeps its pack.
    expect(findAll(html({ deal: deal({ ...lost, ended_reason: "ended_now", payment_status: "paid" }) }), "deal-page-evidence")).toHaveLength(1);
    checked++;
    expect(checked).toBe(3);
  });

  it("the positive pair: no dispute, no pack - however many actions, and a dispute id with no open dispute is not a dispute", () => {
    for (const d of [QUAY, MARLOW, HARBOUR, OLD_ANCHOR, deal({ ...HARBOUR, dispute_id: "dp_old", disputed_at: null })]) {
      expect(findAll(html({ deal: d }), "deal-page-evidence"), d.id).toHaveLength(0);
    }
    expect(findAll(html({ deal: DISPUTED }), "deal-page-evidence")).toHaveLength(1);
  });

  it("a disputed deal with no other action still shows the actions row (the pack is reachable on its own)", () => {
    const d = deal({ deal_status: "ended", payment_status: "paid", ended_reason: "ended_now", ended_at: "2026-11-03T10:00:00.000Z", disputed_at: "2026-11-02T10:00:00.000Z" });
    const markup = html({ deal: d });
    expect(actionsOf(markup)).toEqual([]);
    expect(findAll(markup, "deal-page-evidence")).toHaveLength(1);
  });
});

// --- THE EMPTY CASE: a legacy deal ---------------------------------------------------------------------------------------------------

describe("a legacy (pre-deals) deal opened by id (the empty case)", () => {
  const LEGACY = deal({
    id: "dlg", package_name: "Gold package", tier: "gold", deal_status: "ended", payment_status: "pending", payment_method: "online",
    ended_reason: "legacy", ended_at: "2026-10-01T09:00:00.000Z", sponsor_email: "old@example.com", competition_id: null, ends_at: null,
  });

  it("an unpaid one is the read-only view: the header, the timeline and the facts, and NO actions at all", () => {
    const markup = html({ deal: LEGACY });
    expect(findAll(markup, "deal-page-action")).toHaveLength(0);
    expect(findAll(markup, "deal-page-actions"), "not even an empty row").toHaveLength(0);
    expect(findAll(markup, "deal-page-evidence")).toHaveLength(0);
    expect(textOfMarkup(findOne(markup, "deal-page-name").outer)).toBe("Gold package · £300");
    expect(attrOf(findOne(markup, "deal-chip").open, "data-chip-kind")).toBe("ended");
    expect(stepWords(markup, "ended")).toEqual(["Ended", "1 Oct 2026 · From before deals existed"]);
    expect(findAll(markup, "deal-page-going-live"), "an ended deal switches nothing on").toHaveLength(0);
  });

  it("a PAID legacy order's timeline shows only what was recorded: V495 leaves the invoice and go-live times empty, so nothing says 'Never sent' or 'Never went live' (2 counted)", () => {
    const paid = deal({ ...LEGACY, payment_status: "paid", paid_at: "2026-09-20T09:00:00.000Z" });
    const markup = html({ deal: paid });
    expect(findAll(markup, "deal-page-step").map((x) => [attrOf(x.open, "data-step"), attrOf(x.open, "data-state")])).toEqual([
      ["created", "done"], ["paid", "done"], ["ended", "done"],
    ]);
    const words = flat(textOfMarkup(findOne(markup, "deal-page-timeline").outer));
    expect(words).not.toContain("Never sent");
    expect(words).not.toContain("Never went live");
    // The unpaid one: the payment never arrived and that IS known, so "Not paid" still shows; the unknown steps do not.
    const unpaid = html({ deal: LEGACY });
    expect(findAll(unpaid, "deal-page-step").map((x) => [attrOf(x.open, "data-step"), attrOf(x.open, "data-state")])).toEqual([
      ["created", "done"], ["paid", "missed"], ["ended", "done"],
    ]);
    expect(flat(textOfMarkup(findOne(unpaid, "deal-page-timeline").outer))).not.toContain("Never");
  });

  it("a PAID legacy order keeps the one thing the engine offers it - Refund - because the money is still the club's to give back", () => {
    const paid = deal({ ...LEGACY, payment_status: "paid", paid_at: "2026-09-20T09:00:00.000Z" });
    expect(actionsOf(html({ deal: paid }))).toEqual(["refund"]);
    expect(actionsOf(html({ deal: paid }))).toEqual(allowedActions(paid));
  });
});

// --- the timeline -------------------------------------------------------------------------------------------------------------------

describe("the timeline (mockup screen 5): dealTimeline's steps, drawn", () => {
  it("screen 5's first state, word for word: Quay Fisheries paid online, waiting for approval (6 rows)", () => {
    const markup = html({ deal: QUAY });
    const rows = findAll(markup, "deal-page-step").map((s) => [attrOf(s.open, "data-step"), attrOf(s.open, "data-state")]);
    expect(rows).toEqual([["created", "done"], ["invoice_sent", "done"], ["paid", "done"], ["approved", "next"], ["live", "not_yet"], ["ends", "not_yet"]]);
    expect(stepWords(markup, "created")).toEqual(["Created", "14 Oct 2026 · Sam Patel"]);
    expect(stepWords(markup, "invoice_sent")).toEqual(["Invoice sent", "14 Oct 2026 · accounts@quayfisheries.co.uk"]);
    expect(stepWords(markup, "paid")).toEqual(["Paid", "16 Oct 2026 · £300 by card"]);
    expect(stepWords(markup, "approved")).toEqual(["Awaiting your approval", "Paid and ready. Approve to put them live."]);
    expect(stepWords(markup, "live")).toEqual(["Live", "Not yet"]);
    expect(stepWords(markup, "ends")).toEqual(["Ends", "31 Aug 2027"]);
  });

  it("screen 5's second state, word for word: an offline deal awaiting its payment (4 rows - an offline deal has no invoice step)", () => {
    const markup = html({ deal: MARLOW });
    expect(findAll(markup, "deal-page-step").map((s) => attrOf(s.open, "data-step"))).toEqual(["created", "paid", "live", "ends"]);
    expect(stepWords(markup, "created")).toEqual(["Created", "20 Oct 2026 · Sam Patel"]);
    expect(stepWords(markup, "paid")).toEqual(["Awaiting payment", "Offline payment of £300. Mark it paid when it arrives."]);
    expect(stepWords(markup, "live")).toEqual(["Live", "Goes live when you mark it paid"]);
    expect(stepWords(markup, "ends")).toEqual(["Ends", "31 Aug 2027"]);
  });

  it("exactly ONE step is the next one, it says so to a screen reader, and it is the one the deal waits on", () => {
    let checked = 0;
    for (const d of [QUAY, MARLOW, RIDGE, KESTREL]) {
      const markup = html({ deal: d });
      const next = findAll(markup, "deal-page-step").filter((s) => attrOf(s.open, "data-state") === "next");
      expect(next, d.id).toHaveLength(1);
      expect(attrOf(next[0]!.open, "aria-current"), `${d.id}: the next step is the current one`).toBe("step");
      expect(findAll(markup, "deal-page-step").filter((s) => attrOf(s.open, "aria-current") !== undefined), d.id).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(4);
    // ...and the step it waits on, typed: the invoice (draft), the payment (the two awaiting payment), the approval (Quay).
    const waiting = (d: SponsorDeal) => attrOf(findAll(html({ deal: d }), "deal-page-step").find((s) => attrOf(s.open, "data-state") === "next")!.open, "data-step");
    expect([waiting(KESTREL), waiting(RIDGE), waiting(MARLOW), waiting(QUAY)]).toEqual(["invoice_sent", "paid", "paid", "approved"]);
  });

  it("a draft that has not been sent says so, and what to do (Send the invoice)", () => {
    const markup = html({ deal: KESTREL });
    expect(stepWords(markup, "invoice_sent")).toEqual(["Send the invoice", "Not sent yet. Send it to accounts@quayfisheries.co.uk."]);
    expect(stepWords(markup, "paid")).toEqual(["Paid", "Not yet"]);
    const noEmail = html({ deal: deal({ ...KESTREL, sponsor_email: null }) });
    expect(stepWords(noEmail, "invoice_sent")).toEqual(["Send the invoice", "Not sent yet."]);
  });

  it("D6 an ended deal that was never paid shows 'Not paid', and its sibling - the same deal still open - shows 'Not yet'", () => {
    const ended = deal({ ...RIDGE, deal_status: "ended", ended_reason: "ended_now", ended_at: "2026-11-01T10:00:00.000Z" });
    const markup = html({ deal: ended });
    expect(stepWords(markup, "paid")).toEqual(["Paid", "Not paid"]);
    expect(step(markup, "paid") && attrOf(step(markup, "paid")!.open, "data-state")).toBe("missed");
    expect(stepWords(markup, "live")).toEqual(["Live", "Never went live"]);
    expect(stepWords(markup, "ended")).toEqual(["Ended", "1 Nov 2026 · Ended by you"]);
    expect(step(markup, "ends"), "an ended deal has no future end").toBeUndefined();
    // the pair
    const open = html({ deal: RIDGE });
    expect(stepWords(open, "paid")).toEqual(["Awaiting payment", "Waiting for Quay Fisheries to pay £600 online."]);
    expect(stepWords(open, "live")).toEqual(["Live", "Goes live when it is paid"]);
  });

  it("the rail's dot marks the state with a glyph, not colour alone: a check for done, an X for missed, nothing for next and not yet (D8)", () => {
    const glyphOf = (markup: string, key: string, state: string): string | null => {
      const s = step(markup, key);
      expect(s, `${key} is drawn`).toBeDefined();
      expect(attrOf(s!.open, "data-state"), `${key} is ${state}`).toBe(state);
      return /<svg[^>]*class="([^"]*)"/.exec(s!.outer)?.[1] ?? null;
    };
    const ended = html({ deal: deal({ ...RIDGE, deal_status: "ended", ended_reason: "ended_now", ended_at: "2026-11-01T10:00:00.000Z" }) });
    const open = html({ deal: RIDGE });
    expect(glyphOf(open, "created", "done"), "done").toMatch(/lucide-check/);
    expect(glyphOf(ended, "paid", "missed"), "missed").toMatch(/lucide-x\b/);
    expect(glyphOf(open, "paid", "next"), "next: the ring is the mark").toBeNull();
    expect(glyphOf(open, "live", "not_yet"), "not yet: the dashed dot is the mark").toBeNull();
  });

  it("a step the deal never had is not drawn: a complimentary deal has no invoice and no payment (and no 'Not paid' once ended)", () => {
    const live = html({ deal: OLD_ANCHOR });
    expect(findAll(live, "deal-page-step").map((s) => attrOf(s.open, "data-step"))).toEqual(["created", "live", "ends"]);
    const ended = html({ deal: deal({ ...OLD_ANCHOR, deal_status: "ended", ended_reason: "expired", ended_at: "2026-10-31T10:00:00.000Z" }) });
    expect(findAll(ended, "deal-page-step").map((s) => attrOf(s.open, "data-step"))).toEqual(["created", "live", "ended"]);
    expect(textOfMarkup(ended)).not.toContain("Not paid");
    expect(stepWords(ended, "ended")).toEqual(["Ended", "31 Oct 2026 · End date reached"]);
  });

  it("every end reason has words, each different (7 checked) - the reason is never the raw code", () => {
    const WANT: Record<string, string> = {
      refunded: "Refunded", dispute_lost: "Dispute lost", ended_now: "Ended by you", expired: "End date reached",
      competition_finished: "The competition finished", legacy: "From before deals existed", duplicate_payment: "A second payment on a paid deal",
    };
    let checked = 0;
    for (const [reason, words] of Object.entries(WANT)) {
      const d = deal({ deal_status: "ended", payment_status: "paid", ended_reason: reason as SponsorDeal["ended_reason"], ended_at: "2026-10-31T10:00:00.000Z" });
      expect(stepWords(html({ deal: d }), "ended"), reason).toEqual(["Ended", `31 Oct 2026 · ${words}`]);
      checked++;
    }
    expect(checked).toBe(7);
    expect(new Set(Object.values(WANT)).size).toBe(7);
  });

  it("the creator is named when known and omitted - not guessed - when not (a removed member, a deleted user)", () => {
    expect(stepWords(html({ createdBy: "Sam Patel" }), "created")).toEqual(["Created", "14 Oct 2026 · Sam Patel"]);
    expect(stepWords(html({ createdBy: null }), "created")).toEqual(["Created", "14 Oct 2026"]);
  });

  it("dates are read in the viewer's zone: late on the 14th in London's winter is the 15th in Auckland", () => {
    const late = deal({ ...QUAY, created_at: "2026-10-14T23:30:00.000Z" });
    expect(stepWords(html({ deal: late, tz: "UTC" }), "created")![1]).toBe("14 Oct 2026 · Sam Patel");
    expect(stepWords(html({ deal: late, tz: "Pacific/Auckland" }), "created")![1]).toBe("15 Oct 2026 · Sam Patel");
  });

  it("a paid line says only what is true of the money: by card for a Stripe payment, 'recorded as received' for one marked by hand, plain once refunded", () => {
    const CASES: [string, Partial<SponsorDeal>, string][] = [
      ["card (Stripe paid it)", { has_payment_intent: true }, "16 Oct 2026 · £300 by card"],
      ["marked paid by hand (an online deal)", { has_payment_intent: false }, "16 Oct 2026 · £300 recorded as received"],
      ["an offline deal, marked paid", { payment_method: "offline", has_payment_intent: false }, "16 Oct 2026 · £300 recorded as received"],
      ["refunded since", { payment_status: "refunded", has_payment_intent: true }, "16 Oct 2026 · £300"],
    ];
    let checked = 0;
    for (const [label, over, line] of CASES) {
      const d = deal({ ...QUAY, ...over });
      expect(stepWords(html({ deal: d }), "paid")![1], label).toBe(line);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("how a deal goes live is said for its rule: on payment (online, offline), on approval, queued behind a live deal", () => {
    expect(stepWords(html({ deal: RIDGE }), "live")![1]).toBe("Goes live when it is paid");
    expect(stepWords(html({ deal: MARLOW }), "live")![1]).toBe("Goes live when you mark it paid");
    expect(stepWords(html({ deal: QUAY }), "live")![1]).toBe("Not yet");
    const queued = deal({ ...QUAY, deal_status: "scheduled", go_live: "on_payment", approved_at: null });
    expect(stepWords(html({ deal: queued }), "live")).toEqual(["Scheduled", "Goes live when Quay Fisheries's current deal ends."]);
    const live = deal({ ...HARBOUR, live_at: "2026-10-02T09:00:00.000Z" });
    expect(stepWords(html({ deal: live }), "live")).toEqual(["Live", "2 Oct 2026"]);
    const held = deal({ ...live, parked_at: "2026-11-02T10:00:00.000Z" });
    expect(stepWords(html({ deal: held }), "live")).toEqual(["Live", "2 Oct 2026 · on hold while a dispute is open"]);
  });

  describe("when it ends: its own date, the competition's, or none", () => {
    const WITH = (over: Partial<SponsorDeal>) => deal({ ...MARLOW, ...over });
    it("its own end date wins, and says nothing of the competition", () => {
      const d = WITH({ ends_at: "2027-04-01T00:00:00.000Z", competition_id: "c-season" });
      expect(stepWords(html({ deal: d, competitionFinished: true }), "ends")).toEqual(["Ends", "31 Mar 2027"]);
    });
    it("the day shown is the last day the CLUB typed, in the ORG's zone, whatever zone the viewer is in (the producer stores the start of the next day: 6 counted)", () => {
      // The producer's value (createDeal: `(ends_on::date + 1)::timestamp at time zone <org tz>`): "Ends 31 Aug" at a Los Angeles org is
      // 1 Sep 00:00 PDT = 07:00Z. Typed from that rule, with the org zone and the viewer's zone DIFFERENT, so neither reading can pass for the other.
      const LA = "America/Los_Angeles";
      const stored = new Date("2026-09-01T00:00:00-07:00").toISOString();
      const own = WITH({ ends_at: stored, competition_id: null });
      let checked = 0;
      for (const viewer of ["UTC", "Europe/London", "Pacific/Auckland", LA]) {
        expect(stepWords(html({ deal: own, tz: viewer, orgTz: LA }), "ends"), `viewer in ${viewer}`).toEqual(["Ends", "31 Aug 2026"]);
        checked++;
      }
      // The org zone decides: the same instant at a UTC org is the 1st of September 00:00, so the club typed the 31st there too -
      // while an org AHEAD of UTC stores the 31st at its own midnight, 12:00Z, and a viewer in UTC must still read the 31st.
      expect(stepWords(html({ deal: WITH({ ends_at: "2026-09-01T00:00:00.000Z", competition_id: null }), tz: "Pacific/Auckland", orgTz: "UTC" }), "ends")).toEqual(["Ends", "31 Aug 2026"]);
      checked++;
      const auckland = new Date("2026-09-01T00:00:00+12:00").toISOString();
      expect(stepWords(html({ deal: WITH({ ends_at: auckland, competition_id: null }), tz: "UTC", orgTz: "Pacific/Auckland" }), "ends")).toEqual(["Ends", "31 Aug 2026"]);
      checked++;
      expect(checked).toBe(6);
    });
    it("a competition deal with no end date ends when the competition does - with the date it is due, when it has one", () => {
      const d = WITH({ ends_at: null, competition_id: "c-season" });
      expect(stepWords(html({ deal: d }), "ends")).toEqual(["Ends", "When Season 2026/27 finishes, due 31 Aug 2027"]);
      const noDate = WITH({ ends_at: null, competition_id: "c-winter" });
      expect(stepWords(html({ deal: noDate }), "ends")).toEqual(["Ends", "When Winter League 2026/27 finishes"]);
    });
    it("once the desk says the competition has finished, the page says so (the deal is open until the next check) - from the desk's answer, not the date", () => {
      const d = WITH({ ends_at: null, competition_id: "c-season" });
      expect(stepWords(html({ deal: d, competitionFinished: true }), "ends")).toEqual(["Ends", "Season 2026/27 has finished, so this deal ends shortly."]);
      // a date in the past is only a hint: without the desk's answer the page does not claim it
      const past = html({ deal: d, competitions: [{ id: "c-season", name: "Season 2026/27", ends_on: "2020-01-01" }], competitionFinished: false });
      expect(stepWords(past, "ends")![1]).toBe("When Season 2026/27 finishes, due 1 Jan 2020");
    });
    it("a whole-organisation deal with no end date has none", () => {
      expect(stepWords(html({ deal: WITH({ ends_at: null, competition_id: null }), competitionFinished: true }), "ends")).toEqual(["Ends", "No end date"]);
    });
  });
});

// --- the deal's facts ---------------------------------------------------------------------------------------------------------------

describe("the Deal block: package and tier, scope, payment, the invoice email, the go-live rule", () => {
  const fact = (markup: string, key: string) => {
    const row = findAll(markup, "deal-page-fact").find((f) => attrOf(f.open, "data-fact") === key);
    return row ? textOfMarkup(findOne(row.outer, "deal-page-fact-value").outer) : null;
  };
  const keys = (markup: string) => findAll(markup, "deal-page-fact").map((f) => attrOf(f.open, "data-fact"));

  it("screen 5's Quay Fisheries: Silver Season (Silver), Season 2026/27, Online invoice, the email, After I approve", () => {
    const markup = html({ deal: QUAY });
    expect(keys(markup)).toEqual(["package", "scope", "payment", "invoice_to", "goes_live"]);
    expect(fact(markup, "package")).toBe("Silver Season Silver");
    expect(fact(markup, "scope")).toBe("Season 2026/27");
    expect(fact(markup, "payment")).toBe("Online invoice");
    expect(fact(markup, "invoice_to")).toBe("accounts@quayfisheries.co.uk");
    expect(fact(markup, "goes_live")).toBe("After I approve");
  });

  it("an offline deal with no email has no 'Invoice to' row, and reads Offline / When paid", () => {
    const markup = html({ deal: MARLOW });
    expect(keys(markup)).toEqual(["package", "scope", "payment", "goes_live"]);
    expect(fact(markup, "payment")).toBe("Offline");
    expect(fact(markup, "goes_live")).toBe("When paid");
  });

  it("a whole-organisation deal reads 'All competitions'; a complimentary one reads Complimentary / Straight away", () => {
    const markup = html({ deal: OLD_ANCHOR });
    expect(fact(markup, "payment")).toBe("Complimentary");
    expect(fact(markup, "goes_live")).toBe("Straight away");
    expect(fact(html({ deal: KESTREL }), "scope")).toBe("All competitions");
  });

  it("a deal on a competition the page was not handed names it as this package's competition, never a bare ellipsis (4 places counted)", () => {
    // `orgCompetitions` hands the page at most 100 competitions, so a deal can point at one the list does not hold.
    const lost = deal({ ...MARLOW, ends_at: null, competition_id: "c-not-in-the-list" });
    let checked = 0;
    expect(fact(html({ deal: lost }), "scope")).toBe("This package's competition");
    checked++;
    for (const markup of [html({ deal: lost }), html({ deal: lost, competitionFinished: true })]) {
      expect(stepWords(markup, "ends")![1], "the ends step names the competition in words").toContain("This package's competition");
      expect(textOfMarkup(markup), "no placeholder ellipsis anywhere on the page").not.toContain("\u2026");
      checked++;
    }
    // the same page for a competition the list DOES hold still reads the competition's own name
    expect(fact(html({ deal: deal({ ...MARLOW, ends_at: null, competition_id: "c-season" }) }), "scope")).toBe("Season 2026/27");
    checked++;
    expect(checked).toBe(4);
  });

  it("the three go-live rules read as the Add deal sheet names them, each differently (3 checked)", () => {
    const WANT: [SponsorDeal["go_live"], string][] = [["on_payment", "When paid"], ["immediate", "Straight away"], ["on_approval", "After I approve"]];
    let checked = 0;
    for (const [rule, words] of WANT) {
      expect(fact(html({ deal: deal({ ...RIDGE, go_live: rule }) }), "goes_live"), rule).toBe(words);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the tier is the deal's own snapshot (a later package edit never moves it) and the facts carry the price", () => {
    const titled = deal({ ...QUAY, tier: "title", package_name: "Title Season" });
    expect(fact(html({ deal: titled }), "package")).toBe("Title Season Title");
  });
});

// --- Going live will ----------------------------------------------------------------------------------------------------------------

describe("'Going live will': what the deal switches on, true to the deal's state", () => {
  const box = (markup: string) => {
    const found = findAll(markup, "deal-page-going-live");
    if (found.length === 0) return null;
    return {
      title: textOfMarkup(findOne(found[0]!.outer, "deal-page-going-live-title").outer),
      items: findAll(found[0]!.outer, "deal-page-going-live-item").map((i) => [attrOf(i.open, "data-effect"), attrOf(i.open, "data-on"), textOfMarkup(i.outer)]),
      hint: textOfMarkup(findOne(found[0]!.outer, "deal-page-going-live-hint").outer),
    };
  };

  it("an open deal, screen 5 word for word: Set the tier to Silver, Show them on your public pages, On stream is not in this package", () => {
    expect(box(html({ deal: QUAY }))).toEqual({
      title: "Going live will",
      items: [
        ["tier", "yes", "Set the tier to Silver"],
        ["pages", "yes", "Show them on your public pages"],
        ["stream", "no", "On stream is not in this package"],
      ],
      hint: "A refund or the end date switches these off again.",
    });
  });

  it("a package that includes On stream says 'Put them on stream' - and an open deal waiting on payment says the same (5 open states checked)", () => {
    let checked = 0;
    for (const d of [QUAY, MARLOW, RIDGE, KESTREL, deal({ ...QUAY, deal_status: "scheduled" })]) {
      const withStream = box(html({ deal: deal({ ...d, includes_on_stream: true }) }))!;
      expect(withStream.title, d.id).toBe("Going live will");
      expect(withStream.items[2], d.id).toEqual(["stream", "yes", "Put them on stream"]);
      expect(box(html({ deal: deal({ ...d, includes_on_stream: false }) }))!.items[2], d.id).toEqual(["stream", "no", "On stream is not in this package"]);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a LIVE deal is in the present tense, not 'Going live will' - and a parked one says it is held off the pages and the stream", () => {
    const live = box(html({ deal: HARBOUR }))!;
    expect(live.title).toBe("While it is live");
    expect(live.items).toEqual([
      ["tier", "yes", "The tier is Title"],
      ["pages", "yes", "They show on your public pages"],
      ["stream", "yes", "They are on stream"],
    ]);
    expect(live.hint).toBe("A refund, End now or the end date switches these off.");
    const parked = box(html({ deal: deal({ ...HARBOUR, parked_at: "2026-11-02T10:00:00.000Z", disputed_at: "2026-11-02T10:00:00.000Z" }) }))!;
    expect(parked.items).toEqual([
      ["tier", "yes", "The tier is Title"],
      ["held", "no", "Off your public pages and the stream until the dispute is resolved"],
    ]);
  });

  it("an ENDED deal switches nothing on, so there is no box (the empty case: the box is not drawn for every state)", () => {
    expect(box(html({ deal: deal({ deal_status: "ended", ended_reason: "expired", ended_at: "2026-10-31T10:00:00.000Z" }) }))).toBeNull();
    expect(box(html({ deal: QUAY }))).not.toBeNull();
  });

  it("the states checked: every deal status either draws the box (open, live) or not (ended) - 6 checked", () => {
    let checked = 0;
    for (const status of DEAL_STATUSES) {
      const d = deal({ deal_status: status, ended_reason: status === "ended" ? "expired" : null });
      expect(box(html({ deal: d })) !== null, status).toBe(status !== "ended");
      checked++;
    }
    expect(checked).toBe(6);
  });
});

// --- the pay link ---------------------------------------------------------------------------------------------------------------------

describe("the pay link banner on the page", () => {
  it("shows the link the last send made, with a copy control, and nothing when there is none", () => {
    const markup = html({ deal: RIDGE, payLink: "https://checkout.stripe.test/c/pay_123" });
    expect(textOfMarkup(findOne(markup, "sponsor-pay-link-url").outer)).toBe("https://checkout.stripe.test/c/pay_123");
    expect(findAll(markup, "sponsor-pay-link")).toHaveLength(1);
    expect(findAll(html({ deal: RIDGE }), "sponsor-pay-link")).toHaveLength(0);
  });
});

// --- a page-level error and notice ---------------------------------------------------------------------------------------------------

describe("the page shows its own refusal and its own notice (a side panel's backdrop covers the page's)", () => {
  it("an error is drawn; the live region is always mounted so a notice is announced", () => {
    const markup = html({ error: "Something failed", notice: "Invoice sent again for Quay Fisheries." });
    expect(textOfMarkup(markup)).toContain("Something failed");
    expect(textOfMarkup(findOne(markup, "sponsor-notice").outer)).toBe("Invoice sent again for Quay Fisheries.");
    const quiet = html({});
    expect(findAll(quiet, "sponsor-notice"), "mounted even when empty").toHaveLength(1);
    expect(textOfMarkup(findOne(quiet, "sponsor-notice").outer)).toBe("");
  });
});

// --- the island: hub.dealId opens the page; the writes it makes ---------------------------------------------------------------------

const fetchMock = vi.fn();
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
const served: { rows: SponsorItem[]; deals: SponsorDeal[] } = { rows: [], deals: [] };
function defaultAnswer(url: string, method: string): { status: number; body: unknown } {
  if (method === "GET" && url.endsWith("/sponsor-deals")) return { status: 200, body: { ok: true, data: served.deals } };
  if (method === "GET") return { status: 200, body: { ok: true, data: served.rows } };
  return { status: 200, body: { ok: true, data: {} } };
}
let answer: (url: string, method: string) => { status: number; body: unknown } = defaultAnswer;

beforeEach(() => {
  calls.length = 0;
  answer = defaultAnswer;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const a = answer(url, method);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  });
  vi.stubGlobal("fetch", fetchMock);
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const POSTS = () => calls.filter((c) => c.method === "POST").map((c) => c.url);

const sponsor = (over: Partial<SponsorItem> = {}): SponsorItem => ({
  id: "a", name: "Quay Fisheries", competition_id: null, url: null, logo_path: null, tier: "partner", display_order: 0, status: "active",
  click_count: 0, on_stream: false, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null, ...over,
});
function hubOf(over: Partial<SponsorsHubData> = {}): SponsorsHubData {
  return {
    orgSlug: SLUG, orgTimezone: null, deals: [], packages: [], tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize: true, monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [],
    chargesEnabled: true, sponsorId: "a", dealId: null, dealCreatedByName: null, dealCompetitionFinished: false, reportLinks: [],
    reportDefaults: { from: "2026-01-01", to: "2026-11-09", competitionId: null }, ...over,
  };
}
function mount(rows: SponsorItem[], hub: SponsorsHubData, opts: { canEdit?: boolean } = {}) {
  const p: Parameters<typeof OrgSponsors>[0] = {
    orgId: ORG, initialSponsors: rows, competitions: COMPS, hasTiers: true, billingHref: "/billing", canEdit: opts.canEdit ?? true, hub,
  };
  served.rows = rows;
  served.deals = hub.deals;
  const island = renderIsland(OrgSponsors, p, expandSponsorTree);
  const all = (id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);
  const has = (id: string) => all(id).length > 0;
  const tap = (testid: string, pick?: (e: ReactElement) => boolean) => {
    const el = all(testid).find(pick ?? (() => true));
    if (!el) throw new Error(`nothing to tap: ${testid}`);
    (propsOf(el).onClick as () => void)();
  };
  const action = (name: DealAction) => tap("deal-page-action", (e) => propsOf(e)["data-action"] === name);
  const text = () => flat(textOf(island.tree().filter((e) => propsOf(e)["data-testid"] === "deal-page") as never));
  const words = (testid: string) => all(testid).map((e) => flat(textOf(propsOf(e).children as never)));
  return { island, props: p, has, all, tap, action, text, words };
}

describe("D4 hub.dealId opens the deal page on top of its sponsor (the seam, through the island)", () => {
  const SUBJECT = sponsor();

  it("a deal of the selected sponsor: the deal page is there, the sponsor's page is not, and the list behind is hidden below md", () => {
    const m = mount([SUBJECT], hubOf({ deals: [QUAY], dealId: "dq" }));
    expect(m.has("deal-page")).toBe(true);
    expect(m.has("sponsor-sheet")).toBe(false);
    expect(propsOf(m.all("deal-page")[0]!)["data-deal-id"]).toBe("dq");
    expect(String(propsOf(m.all("sponsors-list-view")[0]!).className).split(/\s+/)).toContain("max-md:hidden");
  });

  it("closing and going back lead to the SPONSOR's page, not the list (the wrapper's close target)", () => {
    const m = mount([SUBJECT], hubOf({ deals: [QUAY], dealId: "dq" }));
    const wrapper = m.island.tree().find((e) => e.type === SponsorSheet)!;
    expect(propsOf(wrapper).closeHref).toBe(SPONSOR_URL);
    expect(propsOf(wrapper).backText, "the back link names the sponsor").toBe("Quay Fisheries");
    expect(propsOf(wrapper).backLabel).toBe("Back to Quay Fisheries");
  });

  it("a deal id the sponsor does not own (or one the list no longer holds) falls back to the sponsor's page, never a stranger's deal", () => {
    const foreign = deal({ id: "dx", sponsor_id: "someone-else" });
    for (const hub of [hubOf({ deals: [QUAY, foreign], dealId: "dx" }), hubOf({ deals: [QUAY], dealId: "gone" })]) {
      const m = mount([SUBJECT], hub);
      expect(m.has("deal-page")).toBe(false);
      expect(m.has("sponsor-sheet")).toBe(true);
    }
  });

  it("the org's zone reaches the page: a deal the club typed 'Ends 31 Aug' at a Los Angeles org shows the 31st, and an org with no zone reads as UTC (2 counted)", () => {
    // The producer's own value: the start of the NEXT day at the org's zone (createDeal), 1 Sep 00:00 PDT.
    const la = deal({ ...MARLOW, sponsor_id: "a", competition_id: null, ends_at: new Date("2026-09-01T00:00:00-07:00").toISOString() });
    const inLa = mount([SUBJECT], hubOf({ orgTimezone: "America/Los_Angeles", deals: [la], dealId: "dm" }));
    expect(flat(textOf(inLa.all("deal-page-step").find((x) => propsOf(x)["data-step"] === "ends") as never))).toContain("31 Aug 2026");
    const utc = deal({ ...MARLOW, sponsor_id: "a", competition_id: null, ends_at: "2026-09-01T00:00:00.000Z" });
    const noZone = mount([SUBJECT], hubOf({ orgTimezone: null, deals: [utc], dealId: "dm" }));
    expect(flat(textOf(noZone.all("deal-page-step").find((x) => propsOf(x)["data-step"] === "ends") as never))).toContain("31 Aug 2026");
  });

  it("the server's two reads reach the page: who created the deal, and whether its competition has finished", () => {
    const open = deal({ ...MARLOW, sponsor_id: "a", ends_at: null, competition_id: "c-season" });
    const m = mount([SUBJECT], hubOf({ deals: [open], dealId: "dm", dealCreatedByName: "Sam Patel", dealCompetitionFinished: true }));
    const steps = Object.fromEntries(m.all("deal-page-step").map((s) => [propsOf(s)["data-step"], flat(textOf(s as never))]));
    expect(steps.created).toContain("Sam Patel");
    expect(steps.ends).toContain("Season 2026/27 has finished, so this deal ends shortly.");
    const quiet = mount([SUBJECT], hubOf({ deals: [open], dealId: "dm", dealCreatedByName: null, dealCompetitionFinished: false }));
    const quietSteps = Object.fromEntries(quiet.all("deal-page-step").map((s) => [propsOf(s)["data-step"], flat(textOf(s as never))]));
    expect(quietSteps.created).not.toContain("Sam Patel");
    expect(quietSteps.ends).toContain("When Season 2026/27 finishes");
  });

  it("a viewer's deal page (canEdit off) has no buttons", () => {
    const m = mount([SUBJECT], hubOf({ deals: [QUAY], dealId: "dq" }), { canEdit: false });
    expect(m.has("deal-page")).toBe(true);
    expect(m.all("deal-page-action")).toHaveLength(0);
  });
});

describe("the writes the deal page makes", () => {
  const SUBJECT = sponsor();
  const mk = (over: Partial<SponsorDeal>) => deal({ sponsor_id: "a", ...over });

  it("Approve is one tap and POSTs approve; the deals are re-read", async () => {
    const m = mount([SUBJECT], hubOf({ deals: [mk(QUAY)], dealId: "dq" }));
    m.action("approve");
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(POSTS()).toEqual([`${API}/sponsor-deals/dq/approve`]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toContain(`${API}/sponsor-deals`);
  });

  it("D5 Refund on a deal marked paid by hand asks in the RECORDED words - no card, no Stripe payout - then POSTs refund", async () => {
    const byHand = mk({ id: "dh1", deal_status: "live", payment_status: "paid", payment_method: "online", has_payment_intent: false, paid_at: "2026-10-16T11:00:00.000Z" });
    const m = mount([SUBJECT], hubOf({ deals: [byHand], dealId: "dh1" }));
    m.action("refund");
    await flush();
    const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; tone: string };
    expect(opts.title).toBe("Refund this deal?");
    expect(opts.confirmLabel).toBe("Refund £300");
    expect(opts.tone).toBe("danger");
    expect(opts.body, "money words, then the placement words for a live deal, then that it is final").toBe(
      "This records £300 as refunded to Quay Fisheries. The deal was marked as paid by hand, so no money moves through Stripe: pay Quay Fisheries back yourself. " +
        "The deal ends now. A deal queued behind it goes live if its end date hasn't passed; otherwise Quay Fisheries comes off your public pages. This can't be undone.",
    );
    expect(opts.body.toLowerCase(), "an offline-recorded refund never mentions a card").not.toContain("card");
    expect(POSTS()).toEqual([`${API}/sponsor-deals/dh1/refund`]);
  });

  it("Refund on a Stripe card payment says it goes back to the card and the payout is reversed", async () => {
    const card = mk({ id: "dc1", deal_status: "live", payment_status: "paid", has_payment_intent: true });
    const m = mount([SUBJECT], hubOf({ deals: [card], dealId: "dc1" }));
    m.action("refund");
    await flush();
    const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
    expect(body.startsWith("£300 goes back to Quay Fisheries's card and your payout is reversed.")).toBe(true);
  });

  it("the refund's placement words follow the deal's state (live / ended / queued behind a live one / nothing live - 4 checked)", async () => {
    const live = mk({ id: "d-live", deal_status: "live", payment_status: "paid", has_payment_intent: true });
    const CASES: [string, SponsorDeal[], string, string][] = [
      ["live", [live], "d-live", "The deal ends now. A deal queued behind it goes live if its end date hasn't passed; otherwise Quay Fisheries comes off your public pages."],
      ["ended", [mk({ id: "t", deal_status: "ended", payment_status: "paid", ended_reason: "ended_now", ended_at: "2026-10-30T10:00:00.000Z" })], "t", "The deal has already ended, so your public pages don't change."],
      ["queued behind a live deal", [live, mk({ id: "t", deal_status: "scheduled", payment_status: "paid" })], "t", "This deal ends without going live; Quay Fisheries's live deal keeps it on your public pages."],
      ["queued, nothing live", [mk({ id: "t", deal_status: "awaiting_approval", payment_status: "paid", go_live: "on_approval" })], "t", "This deal ends without going live, so Quay Fisheries stays off your public pages."],
    ];
    let checked = 0;
    for (const [label, deals, target, words] of CASES) {
      confirmMock.mockClear();
      calls.length = 0;
      const m = mount([SUBJECT], hubOf({ deals, dealId: target }));
      m.action("refund");
      await flush();
      const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
      expect(body, label).toContain(words);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("declining the refund sends nothing", async () => {
    confirmMock.mockImplementationOnce(async () => false);
    const m = mount([SUBJECT], hubOf({ deals: [mk(QUAY)], dealId: "dq" }));
    m.action("refund");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("a refused refund shows the dictionary's words for its code, never the server's", async () => {
    answer = (url, method) => (method === "POST" ? { status: 409, body: { ok: false, error: { code: "deal_disputed", message: "server english" } } } : defaultAnswer(url, method));
    const m = mount([SUBJECT], hubOf({ deals: [mk(QUAY)], dealId: "dq" }));
    m.action("refund");
    await flush();
    const shown = flat(textOf(m.island.tree().filter((e) => propsOf(e)["data-testid"] === "deal-page") as never));
    expect(shown).toContain(msg("sponsors.error.dealDisputed"));
    expect(shown).not.toContain("server english");
  });

  it("End now asks, in the live words for a live deal, then POSTs end", async () => {
    const live = mk({ id: "dl", deal_status: "live", payment_status: "paid", has_payment_intent: true });
    const m = mount([SUBJECT], hubOf({ deals: [live], dealId: "dl" }));
    m.action("end_now");
    await flush();
    const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string };
    expect(opts.title).toBe("End this deal now?");
    expect(opts.confirmLabel).toBe("End deal");
    expect(opts.body.startsWith("Quay Fisheries's live deal ends now. Its tier, public page and stream switch off")).toBe(true);
    expect(opts.body, "a paid deal's money is kept: Refund is the separate step").toContain("doesn't refund");
    expect(POSTS()).toEqual([`${API}/sponsor-deals/dl/end`]);
  });

  it("Mark as paid on an ONLINE deal whose invoice went out also says the pay link stops working; an offline deal does not", async () => {
    const online = mk({ ...RIDGE, id: "do1" });
    const m = mount([SUBJECT], hubOf({ deals: [online], dealId: "do1" }));
    m.action("mark_paid");
    await flush();
    const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain("The deal is marked paid and follows its go-live rule");
    expect(body).toContain("Its pay link stops working, so Quay Fisheries can't pay it as well.");
    expect(POSTS()).toEqual([`${API}/sponsor-deals/do1/mark-paid`]);

    confirmMock.mockClear();
    const offline = mk({ ...MARLOW, id: "do2" });
    const m2 = mount([SUBJECT], hubOf({ deals: [offline], dealId: "do2" }));
    m2.action("mark_paid");
    await flush();
    expect((confirmMock.mock.calls[0]![0] as { body: string }).body).not.toContain("pay link");
  });

  it("D7 the pay-link banner follows its deal: a Resend shows the link, and it goes when the deal can no longer be paid", async () => {
    const LINK = "https://checkout.stripe.test/c/pay_abc";
    const sent = mk({ ...RIDGE, id: "dr1" });
    answer = (url, method) => {
      if (method === "POST" && url.endsWith("/send-invoice")) return { status: 200, body: { ok: true, data: { deal: sent, checkout_url: LINK } } };
      return defaultAnswer(url, method);
    };
    const m = mount([SUBJECT], hubOf({ deals: [sent], dealId: "dr1" }));
    expect(m.has("sponsor-pay-link"), "no link before a send").toBe(false);
    m.action("resend_invoice");
    await flush();
    expect(m.words("sponsor-pay-link-url")).toEqual([LINK]);
    expect(m.text()).toContain("Invoice sent again for Quay Fisheries.");

    // The deal is then ended elsewhere: the re-read answers it ended, and the banner goes with the link it paid.
    served.deals = [mk({ ...sent, deal_status: "ended", ended_reason: "ended_now", ended_at: "2026-11-09T10:00:00.000Z" })];
    m.action("end_now");
    await flush();
    expect(m.has("sponsor-pay-link"), "the banner outlived its deal").toBe(false);
  });

  it("the banner is for ITS deal only: a link made for another deal is not shown on this one", async () => {
    const other = mk({ ...RIDGE, id: "d-other" });
    const mine = mk({ ...RIDGE, id: "d-mine" });
    answer = (url, method) => {
      if (method === "POST" && url.endsWith("/send-invoice")) return { status: 200, body: { ok: true, data: { deal: other, checkout_url: "https://checkout.stripe.test/c/other" } } };
      return defaultAnswer(url, method);
    };
    const m = mount([SUBJECT], hubOf({ deals: [other, mine], dealId: "d-mine" }));
    // act on the OTHER deal through the runner, as the sponsor page's button would, while this deal's page is open
    const wrapper = m.island.tree().find((e) => e.type === DealPageBody)!;
    (propsOf(wrapper).onAction as (d: SponsorDeal, a: DealAction) => void)(other, "resend_invoice");
    await flush();
    expect(m.has("sponsor-pay-link"), "another deal's link").toBe(false);
  });

  it("the banner also follows an Add deal create: its answer carries the link, shown on the sponsor's page", async () => {
    const created = mk({ ...RIDGE, id: "d-new" });
    answer = (url, method) => {
      if (method === "POST" && url.endsWith("/sponsors/a/deals")) return { status: 201, body: { ok: true, data: { deal: created, checkout_url: "https://checkout.stripe.test/c/new" } } };
      return defaultAnswer(url, method);
    };
    const m = mount([SUBJECT], hubOf({ deals: [], dealId: null }));
    m.tap("sponsor-sheet-add-deal");
    const sheet = m.island.tree().find((e) => e.type === AddDealSheet)!;
    served.deals = [created];
    await (propsOf(sheet).onCreate as (b: Record<string, unknown>) => Promise<void>)({
      package_id: "p0", competition_id: null, payment_method: "online", go_live: "on_payment", sponsor_email: "x@example.com",
    });
    await flush();
    expect(m.words("sponsor-pay-link-url")).toEqual(["https://checkout.stripe.test/c/new"]);
  });
});

// --- the words exist in all four locales ------------------------------------------------------------------------------------------------

describe("the deal page's words exist in en, es, fr and nl (a sweep over its key families)", () => {
  const FAMILIES = [
    "sponsors.deal.timeline.", "sponsors.deal.goingLive.", "sponsors.deal.confirm.", "sponsors.deal.facts.", "sponsors.deal.payLink.",
    "sponsors.deal.badge.", "sponsors.deal.section.",
  ];
  const DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as unknown as Record<string, Record<string, string>>;

  it("every key in the families is in all four dictionaries, non-empty, and es/fr/nl are translated (not the English)", () => {
    const keys = Object.keys(DICTS.en!).filter((k) => FAMILIES.some((f) => k.startsWith(f)));
    expect(keys.length, "the sweep is not vacuous").toBeGreaterThan(60);
    // Words that are the same in a language on purpose: Dutch says "Live" (as `sponsors.deal.chip.live` already does) and "Deal" (as
    // every other deal screen's Dutch does).
    const SAME_OK = new Set(["sponsors.deal.section.deal", "sponsors.deal.timeline.live"]);
    let checked = 0;
    for (const key of keys) {
      for (const loc of ["es", "fr", "nl"]) {
        const text = DICTS[loc]![key];
        expect(text, `${loc}: ${key}`).toBeTruthy();
        if (!SAME_OK.has(key)) expect(text, `${loc} is translated: ${key}`).not.toBe(DICTS.en![key]);
        // the placeholders survive translation
        const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(holes(text!), `${loc}: placeholders of ${key}`).toEqual(holes(DICTS.en![key]!));
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 3);
  });

  it("no 'order' left in the deal screens' words: this PR calls it a deal", () => {
    const keys = Object.keys(DICTS.en!).filter((k) => FAMILIES.some((f) => k.startsWith(f)) || k === "sponsors.deal.evidenceTitle" || k === "sponsors.deal.evidence");
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) expect(DICTS.en![key]!.toLowerCase(), key).not.toMatch(/\border(s)?\b/);
  });
});
