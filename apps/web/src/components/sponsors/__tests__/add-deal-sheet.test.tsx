// Sponsor deals, Task 16 - the Add deal sheet (components/sponsors/add-deal-sheet.tsx), mockup screen 3.
//
// vitest is `environment: "node"`: the sheet runs under components/__tests__/_hook-harness.tsx (the element TREE back; a click is the
// element's own `onChange`/`onClick` prop called, with the state the previous call left behind). The sheet is one stateful component
// that renders INLINE (no child component with its own hooks), wrapped in a `Modal` whose `footer` prop holds the buttons: `walk`
// only follows `children`, so `expandSheet` below visits the footer too. What the harness cannot see (the cards' CSS, the tap area,
// the real POST) is the e2e's (`e2e/sponsor-deals.spec.ts`, run by CI).
//
// The openings are D22 (plan 2026-11-07-sponsor-deals), the placement rule is spec §10 Q1 (on the community plan every deal is
// Partner on the whole organisation): both typed here as literals, never read back from the sheet.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   K1  opening method   `chargesEnabled` dropped from `onlineAvailable`                -> (b) Pro without Connect
//   K2  complimentary    on_payment kept for a complimentary deal (`rule` not derived)   -> "complimentary moves go-live"
//   K3  scope options    the `needsTiers` disable dropped from the competition options   -> (c) community
//   K4  package cards    `needsTiers` dropped from the card's `locked`                   -> (c) community
//   K5  in-flight        the `inFlight` ref guard dropped                                -> "a second tap while it is in flight"
//   K6  end_current      `end_current` always false                                      -> "End the current deal now"
//   K7  email opening    `last_billing_email` ignored                                    -> (d)
//   K8  dup confirm      the confirm skipped                                             -> "a second open deal on the same package"
//   K9  submit guard     the placement guard dropped from `canSubmit`                    -> "a competition picked on community"
//   K10 ends_on          sent for a competition scope                                    -> "Ends on is for the whole organisation"
// Fix round 1 (batch H review):
//   F1  finished package   `packageFinished` always false                                  -> "a package whose competition has finished"
//   F2  finished guard     `packageOpen(pkg)` dropped from `canSubmit`                     -> "the handler can be called"
//   F3  per-scope Online   `monetizeFor` ignores the scope (org-wide boolean again)        -> "Event Pass"
//   F4  waiting deal       `promotesWaiting` always false                                  -> "an earlier deal waiting"
//   F5  waiting deal       the sponsor filter dropped                                      -> "another sponsor's waiting deal"
//   F6  nothing saved      the page-level words used for an offline create                 -> "ends the current deal and sends no invoice"
// Batch H re-review (batch I first commit):
//   F7  opening method     the useState initialiser reads `hasMonetize` for `monetizeFor(firstOpen scope)` -> "the FIRST package's scope"
// Per-scope tiers (batch I, the m2 mirror):
//   T1  per-scope tiers    `tiersFor` ignores the scope (org-wide boolean again)               -> "an Event Pass lifts its own competition"
//   T2  submit guard       `placementOk` reads org-wide tiers only                             -> "a deal for the pass's competition can be sent"
//   T3  default scope      the opening scope stays on a blocked whole organisation            -> "opens on the first scope the pass places"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

import { Modal } from "@/components/modal";
import { AddDealSheet, type AddDealSheetProps, type CreateDealBody } from "@/components/sponsors/add-deal-sheet";
import type { SponsorItem } from "@/components/org-sponsors";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import { sponsorsHref } from "@/lib/sponsors-hub";
import { goLiveRulesFor, type GoLiveRule, type PaymentMethod, type SponsorDeal } from "@/lib/sponsor-deals";
import { CreateSponsorDeal } from "@/server/api-v1/schemas/sponsors";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const SLUG = "harbour-vale";

const sponsor = (over: Partial<SponsorItem> = {}): SponsorItem => ({
  id: "s1", name: "Ridge Gold Physiotherapy", competition_id: null, url: null, logo_path: null, tier: "partner", display_order: 0,
  status: "inactive", click_count: 0, on_stream: false, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false,
  last_billing_email: "accounts@ridgegoldphysio.co.uk", ...over,
});
const pkg = (over: Partial<SponsorPackageRow> & { id: string; name: string }): SponsorPackageRow => ({
  competition_id: null, description: null, price_cents: 10_000, currency: "gbp", tier: "partner", active: true, created_at: "2026-10-01T09:00:00.000Z",
  includes_on_stream: false, used_by: 0, ...over,
});
const GOLD = pkg({ id: "p-gold", name: "Gold Season", price_cents: 60_000, tier: "gold", includes_on_stream: true });
const SILVER = pkg({ id: "p-silver", name: "Silver Season", price_cents: 30_000, tier: "silver" });
const PARTNER = pkg({ id: "p-partner", name: "Partner", price_cents: 12_000, tier: "partner" });
const CUP = pkg({ id: "p-cup", name: "Cup Partner", price_cents: 9_000, tier: "partner", competition_id: "c1" });
const RETIRED = pkg({ id: "p-old", name: "Retired Bronze", price_cents: 5_000, tier: "partner", active: false });
const PACKAGES = [GOLD, SILVER, PARTNER, CUP, RETIRED];
const COMPETITIONS = [
  { id: "c1", name: "Season 2026/27", ends_on: "2027-08-31" },
  { id: "c2", name: "Winter League 2026/27", ends_on: null },
];

const OPEN_DEAL: SponsorDeal = {
  id: "d-open", sponsor_id: "s1", package_id: "p-gold", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online",
  go_live: "on_payment", package_name: "Gold Season", tier: "gold", includes_on_stream: false, competition_id: null, amount_cents: 60_000,
  currency: "gbp", sponsor_name: "Ridge Gold Physiotherapy", sponsor_email: "accounts@ridgegoldphysio.co.uk", ends_at: null,
  created_at: "2026-10-01T09:00:00.000Z", created_by: null, invoice_sent_at: "2026-10-28T09:00:00.000Z", paid_at: null, marked_paid_by: null,
  approved_at: null, approved_by: null, live_at: null, ended_at: null, ended_reason: null, parked_at: null, disputed_at: null,
  dispute_id: null, has_payment_intent: false, invoice_number: null,
};

const created: CreateDealBody[] = [];
function props(over: Partial<AddDealSheetProps> = {}): AddDealSheetProps {
  // A paid plan sells online invoices everywhere: `monetizeOrgWide` follows `hasMonetize` unless a test says otherwise (an Event Pass).
  const hasMonetize = over.hasMonetize ?? true;
  return {
    sponsor: sponsor(), deals: [], packages: PACKAGES, competitions: COMPETITIONS, tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize, monetizeOrgWide: hasMonetize,
    monetizeCompetitionIds: [], chargesEnabled: true, finishedCompetitionIds: [],
    orgSlug: SLUG, onCreate: vi.fn(async (body: CreateDealBody) => { created.push(body); }), onClose: vi.fn(), ...over,
  };
}

/** `walk` plus the Modal's `footer` (where the sheet's buttons are). */
function expandSheet(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expandSheet(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const p = node.props as { children?: ReactNode; footer?: ReactNode };
  expandSheet(p.children, out);
  expandSheet(p.footer, out);
  return out;
}
const mount = (over: Partial<AddDealSheetProps> = {}) => {
  const p = props(over);
  return { island: renderIsland(AddDealSheet, p, expandSheet), p };
};
type Island = ReturnType<typeof mount>["island"];

const all = (island: Island, testid: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === testid);
const one = (island: Island, testid: string): ReactElement => {
  const found = all(island, testid);
  if (found.length !== 1) throw new Error(`expected exactly one data-testid="${testid}", found ${found.length}`);
  return found[0]!;
};
const has = (island: Island, testid: string) => all(island, testid).length > 0;
const textIn = (island: Island, testid: string) => flat(textOf(one(island, testid)));
const pick = (island: Island, testid: string) => (propsOf(one(island, testid)).onChange as (e: unknown) => void)({ target: { checked: true } });
const chooseScope = (island: Island, value: string) => (propsOf(one(island, "add-deal-scope")).onChange as (e: unknown) => void)({ target: { value } });
const typeInto = (island: Island, testid: string, value: string) => (propsOf(one(island, testid)).onChange as (e: unknown) => void)({ target: { value } });
const tick = (island: Island, testid: string, checked: boolean) => (propsOf(one(island, testid)).onChange as (e: unknown) => void)({ target: { checked } });
const submit = (island: Island) => (propsOf(one(island, "add-deal-submit")).onClick as () => Promise<void>)();
const isDisabled = (island: Island, testid: string) => propsOf(one(island, testid)).disabled === true;

/** The checked radio of a group (`prefix` + value), read off the rendered radios - what a person sees ticked. */
function checkedOf(island: Island, prefix: string): string[] {
  return island.tree()
    .filter((e) => {
      const p = propsOf(e);
      return p.type === "radio" && typeof p["data-testid"] === "string" && (p["data-testid"] as string).startsWith(prefix) && p.checked === true;
    })
    .map((e) => (propsOf(e)["data-testid"] as string).slice(prefix.length));
}
const methodOf = (island: Island) => checkedOf(island, "add-deal-payment-");
const ruleOf = (island: Island) => checkedOf(island, "add-deal-golive-");
const packageOf = (island: Island) => checkedOf(island, "add-deal-package-");
const scopeOf = (island: Island) => String(propsOf(one(island, "add-deal-scope")).value);
const optionIds = (island: Island) => island.tree().filter((e) => e.type === "option" && String(propsOf(e)["data-testid"] ?? "").startsWith("add-deal-scope-option-"));
const summaryOf = (island: Island) => textIn(island, "add-deal-summary");

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockImplementation(async () => true);
  created.length = 0;
});

describe("the frame: a Modal titled for the sponsor, its buttons in the footer", () => {
  it("titles the sheet with the sponsor, closes through the caller, and Cancel is a button that closes too", () => {
    const { island, p } = mount();
    const modals = island.tree().filter((e) => e.type === Modal);
    expect(modals).toHaveLength(1);
    expect(propsOf(modals[0]!).title).toBe("Add deal for Ridge Gold Physiotherapy");
    (propsOf(modals[0]!).onClose as () => void)();
    (propsOf(one(island, "add-deal-cancel")).onClick as () => void)();
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("D22 openings: payment follows the plan, go-live opens on payment, scope opens at the package's", () => {
  it("(a) Pro with Connect: online / when paid, whole organisation", () => {
    const { island } = mount();
    expect(methodOf(island)).toEqual(["online"]);
    expect(ruleOf(island)).toEqual(["on_payment"]);
    expect(scopeOf(island)).toBe("");
    expect(isDisabled(island, "add-deal-payment-online")).toBe(false);
    expect(has(island, "add-deal-payment-link-online"), "no lock hint when online is open").toBe(false);
  });

  it("(b) Pro without Connect: offline / when paid; Online is locked with 'Connect Stripe first' pointing at the Connect settings", () => {
    const { island } = mount({ hasMonetize: true, chargesEnabled: false });
    expect(methodOf(island)).toEqual(["offline"]);
    expect(ruleOf(island)).toEqual(["on_payment"]);
    expect(isDisabled(island, "add-deal-payment-online")).toBe(true);
    const link = one(island, "add-deal-payment-link-online");
    expect(flat(textOf(link))).toBe("Connect Stripe first");
    expect(propsOf(link).href).toBe(routes.connect(SLUG));
    expect(propsOf(link).href, "the connect page, not billing").not.toBe(routes.billing(SLUG));
    // The pair: Offline and Complimentary stay open.
    expect(isDisabled(island, "add-deal-payment-offline")).toBe(false);
    expect(isDisabled(island, "add-deal-payment-complimentary")).toBe(false);
  });

  it("(b') no paid plan at all: Online is locked with 'Paid plans only. Upgrade to send invoices' pointing at Billing - even with Connect on", () => {
    const { island } = mount({ hasMonetize: false, chargesEnabled: true });
    expect(methodOf(island)).toEqual(["offline"]);
    expect(isDisabled(island, "add-deal-payment-online")).toBe(true);
    expect(textIn(island, "add-deal-payment-lock-online")).toBe("Paid plans only. Upgrade to send invoices");
    expect(propsOf(one(island, "add-deal-payment-link-online")).href).toBe(routes.billing(SLUG));
  });

  it("(c) community: offline; Online locked with the upgrade hint; Gold, Silver and the competition's Partner locked; the whole-organisation Partner open and chosen; every competition option disabled with the tier hint", () => {
    const { island } = mount({ tiersOrgWide: false, hasMonetize: false, chargesEnabled: false });
    expect(methodOf(island)).toEqual(["offline"]);
    expect(isDisabled(island, "add-deal-payment-online")).toBe(true);
    expect(propsOf(one(island, "add-deal-payment-link-online")).href).toBe(routes.billing(SLUG));
    // Spec §10 Q1: on community every deal is Partner on the whole organisation. Typed, not asked of the predicate.
    const expected: Record<string, boolean> = { "p-gold": true, "p-silver": true, "p-cup": true, "p-partner": false };
    let checked = 0;
    for (const [id, locked] of Object.entries(expected)) {
      expect(isDisabled(island, `add-deal-package-${id}`), `${id} locked`).toBe(locked);
      expect(has(island, `add-deal-package-upgrade-${id}`), `${id} offers the upgrade link`).toBe(locked);
      if (locked) expect(propsOf(one(island, `add-deal-package-upgrade-${id}`)).href).toBe(routes.billing(SLUG));
      checked++;
    }
    expect(checked).toBe(4);
    expect(packageOf(island), "the open Partner package is the one chosen").toEqual(["p-partner"]);
    // F29: the scope select. Whole organisation open; every competition option disabled, and the hint says why.
    const options = optionIds(island);
    expect(options.map((o) => propsOf(o)["data-testid"])).toEqual(["add-deal-scope-option-whole", "add-deal-scope-option-c1", "add-deal-scope-option-c2"]);
    expect(propsOf(options[0]!).disabled, "whole organisation stays open").not.toBe(true);
    for (const o of options.slice(1)) expect(propsOf(o).disabled, String(propsOf(o).value)).toBe(true);
    expect(textIn(island, "add-deal-scope-hint")).toContain(msg("sponsors.dealSheet.scopeTiersHint"));
    expect(propsOf(one(island, "add-deal-scope-upgrade")).href).toBe(routes.billing(SLUG));
  });

  it("(c) positive pair: on a paid plan every competition option is enabled and there is no tier hint", () => {
    const { island } = mount();
    const options = optionIds(island);
    expect(options).toHaveLength(3);
    let checked = 0;
    for (const o of options) {
      expect(propsOf(o).disabled, String(propsOf(o).value)).not.toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
    expect(has(island, "add-deal-scope-upgrade")).toBe(false);
    for (const p of [GOLD, SILVER, PARTNER, CUP]) expect(isDisabled(island, `add-deal-package-${p.id}`), p.name).toBe(false);
  });

  it("(d) the billing email opens at the sponsor's last one; a sponsor with none opens empty", () => {
    expect(propsOf(one(mount().island, "add-deal-email")).value).toBe("accounts@ridgegoldphysio.co.uk");
    expect(propsOf(one(mount({ sponsor: sponsor({ last_billing_email: null }) }).island, "add-deal-email")).value).toBe("");
  });

  it("(e) a package for one competition: the scope opens at it and cannot be changed", () => {
    const { island } = mount();
    pick(island, "add-deal-package-p-cup");
    expect(scopeOf(island)).toBe("c1");
    expect(propsOf(one(island, "add-deal-scope")).disabled).toBe(true);
    expect(textIn(island, "add-deal-scope-hint")).toContain(msg("sponsors.dealSheet.scopeFixed"));
    // Moving off it frees the select again, back at the whole organisation.
    pick(island, "add-deal-package-p-partner");
    expect(scopeOf(island)).toBe("");
    expect(propsOf(one(island, "add-deal-scope")).disabled).not.toBe(true);
  });
});

describe("Tiers and competition deals are placed per scope: an Event Pass lifts its own competition and never the whole organisation (the m2 mirror)", () => {
  // The server's gate is per scope (server/sponsors/deal-gates.ts `assertPlacementAllowed`: `requireFeature(org, "sponsors.tiers",
  // competitionId)`; a null scope resolves org-wide, which on a pass org is the community answer). A pass org: tiers are reachable on
  // SOME scope, org-wide is false, and only c1 is lifted. Typed from that rule, never read back from the sheet.
  const PASS = { tiersOrgWide: false, tiersCompetitionIds: ["c1"] } as const;
  const CUP2 = pkg({ id: "p-cup2", name: "Winter Partner", price_cents: 7_000, tier: "partner", competition_id: "c2" });
  const WITH_CUP2 = { packages: [...PACKAGES, CUP2] };

  it("the packages: the pass's competition's package and any-competition tiers are open; another competition's package is locked, with the way out (counted)", () => {
    const { island } = mount({ ...PASS, ...WITH_CUP2 });
    // [id, locked, why]
    const expected: [string, boolean, string][] = [
      ["p-cup", false, "a package for the pass's own competition"],
      ["p-cup2", true, "a package for a competition with no pass"],
      ["p-partner", false, "Partner on the whole organisation needs no tiers"],
      ["p-gold", false, "Gold for any competition: the pass's competition can take it"],
      ["p-silver", false, "Silver for any competition: the pass's competition can take it"],
    ];
    let checked = 0;
    for (const [id, locked, why] of expected) {
      expect(isDisabled(island, `add-deal-package-${id}`), `${id}: ${why}`).toBe(locked);
      expect(has(island, `add-deal-package-upgrade-${id}`), `${id}: the way out`).toBe(locked);
      checked++;
    }
    expect(checked).toBe(expected.length);
  });

  it("a Gold package for any competition opens on the first scope the pass places - the whole organisation is disabled - and a deal for it can be sent (T2, T3)", async () => {
    const { island, p } = mount(PASS);
    pick(island, "add-deal-package-p-gold");
    expect(scopeOf(island), "not the blocked whole organisation").toBe("c1");
    const options = optionIds(island);
    const disabledBy = Object.fromEntries(options.map((o) => [String(propsOf(o).value), propsOf(o).disabled === true]));
    expect(disabledBy, "the whole organisation and the competition without a pass are disabled; the pass's competition is open").toEqual({ "": true, c1: false, c2: true });
    expect(isDisabled(island, "add-deal-submit"), "sendable: the scope it opened on is placed").toBe(false);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ package_id: "p-gold", competition_id: "c1" }));
  });

  it("a Partner package for any competition opens on the whole organisation (it needs no tiers there); only the pass's competition can be picked beside it", () => {
    const { island } = mount(PASS);
    pick(island, "add-deal-package-p-partner");
    expect(scopeOf(island)).toBe("");
    const options = optionIds(island);
    expect(Object.fromEntries(options.map((o) => [String(propsOf(o).value), propsOf(o).disabled === true]))).toEqual({ "": false, c1: false, c2: true });
    chooseScope(island, "c2");
    expect(isDisabled(island, "add-deal-submit"), "a competition without a pass cannot be sent (it would be a 402)").toBe(true);
    chooseScope(island, "c1");
    expect(isDisabled(island, "add-deal-submit")).toBe(false);
  });

  it("the scope hint says why a competition is disabled, with the way out - and a pass holder whose every competition is lifted sees no hint (the pair)", () => {
    const partial = mount(PASS).island;
    pick(partial, "add-deal-package-p-partner");
    expect(textIn(partial, "add-deal-scope-hint")).toContain(msg("sponsors.dealSheet.scopeTiersHint"));
    expect(propsOf(one(partial, "add-deal-scope-upgrade")).href).toBe(routes.billing(SLUG));
    const all2 = mount({ tiersOrgWide: false, tiersCompetitionIds: ["c1", "c2"] }).island;
    pick(all2, "add-deal-package-p-partner");
    expect(has(all2, "add-deal-scope-hint")).toBe(false);
  });

  it("the sequence: the scope is re-derived per package - Gold lands on the pass's competition, Partner goes back to the whole organisation, a hand-picked competition stays, and a hand-picked whole organisation is refused for Silver", () => {
    const { island } = mount(PASS);
    pick(island, "add-deal-package-p-gold");
    expect(scopeOf(island), "Gold: the whole organisation is not placed").toBe("c1");
    pick(island, "add-deal-package-p-partner");
    expect(scopeOf(island), "Partner needs no tiers on the whole organisation, and nobody picked c1 by hand").toBe("");
    chooseScope(island, "c1");
    pick(island, "add-deal-package-p-gold");
    pick(island, "add-deal-package-p-partner");
    expect(scopeOf(island), "a hand-picked competition stays").toBe("c1");
    chooseScope(island, "");
    expect(scopeOf(island)).toBe("");
    pick(island, "add-deal-package-p-silver");
    expect(scopeOf(island), "a hand-picked whole organisation is not placed for Silver: back to the competition that is").toBe("c1");
    expect(isDisabled(island, "add-deal-submit")).toBe(false);
  });

  it("nothing lifted anywhere is the community sheet: every tiered package locked, every competition disabled (the empty case)", () => {
    const { island } = mount({ tiersOrgWide: false, tiersCompetitionIds: [] });
    expect(isDisabled(island, "add-deal-package-p-gold")).toBe(true);
    expect(isDisabled(island, "add-deal-package-p-silver")).toBe(true);
    expect(isDisabled(island, "add-deal-package-p-cup")).toBe(true);
    expect(isDisabled(island, "add-deal-package-p-partner")).toBe(false);
  });
});

describe("the package cards", () => {
  it("lists the active packages only (counted), each with name, price, tier, its scope, and 'On stream' only where it is included", () => {
    const { island } = mount();
    const ids = island.tree().filter((e) => propsOf(e).type === "radio" && String(propsOf(e)["data-testid"] ?? "").startsWith("add-deal-package-")).map((e) => propsOf(e).value);
    expect(ids).toEqual(["p-gold", "p-silver", "p-partner", "p-cup"]);
    expect(has(island, "add-deal-package-p-old"), "a retired package is not for sale").toBe(false);
    const cards: Record<string, { price: string; tier: string; scope: string; stream: boolean }> = {
      "p-gold": { price: "£600", tier: "Gold", scope: "Any competition", stream: true },
      "p-silver": { price: "£300", tier: "Silver", scope: "Any competition", stream: false },
      "p-partner": { price: "£120", tier: "Partner", scope: "Any competition", stream: false },
      "p-cup": { price: "£90", tier: "Partner", scope: "Season 2026/27", stream: false },
    };
    let checked = 0;
    for (const [id, want] of Object.entries(cards)) {
      const text = textIn(island, `add-deal-package-card-${id}`);
      const name = PACKAGES.find((p) => p.id === id)!.name;
      for (const part of [name, want.price, want.tier, want.scope]) expect(text, `${id}: ${part}`).toContain(part);
      expect(text.includes("On stream"), `${id}: On stream chip`).toBe(want.stream);
      // §8a: no website-board or slideshow chips on the card.
      expect(text).not.toMatch(/Website board|Slideshow/);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("opens on the first package the plan allows, and choosing another moves the summary and the price", () => {
    const { island } = mount();
    expect(packageOf(island)).toEqual(["p-gold"]);
    expect(summaryOf(island)).toContain("gets Gold Season");
    pick(island, "add-deal-package-p-silver");
    expect(packageOf(island)).toEqual(["p-silver"]);
    expect(summaryOf(island)).toContain("gets Silver Season");
    expect(summaryOf(island)).toContain("£300");
  });

  it("no packages on sale: says so, links to the Packages tab, offers nothing to send", () => {
    const { island } = mount({ packages: [RETIRED] });
    expect(has(island, "add-deal-no-packages")).toBe(true);
    expect(propsOf(one(island, "add-deal-packages-link")).href).toBe(sponsorsHref(SLUG, "packages"));
    expect(has(island, "add-deal-summary")).toBe(false);
    expect(isDisabled(island, "add-deal-submit")).toBe(true);
  });
});

describe("payment and go-live", () => {
  it("complimentary moves go-live from 'when paid' to 'straight away', and 'When paid' disappears (counted)", () => {
    const { island } = mount();
    expect(ruleOf(island)).toEqual(["on_payment"]);
    expect(has(island, "add-deal-golive-on_payment")).toBe(true);
    pick(island, "add-deal-payment-complimentary");
    expect(methodOf(island)).toEqual(["complimentary"]);
    expect(ruleOf(island)).toEqual(["immediate"]);
    expect(has(island, "add-deal-golive-on_payment"), "When paid is hidden for a complimentary deal").toBe(false);
    // The offered cards are exactly the lifecycle table's list for the method.
    const offered = (m: PaymentMethod) => goLiveRulesFor(m).filter((r) => has(island, `add-deal-golive-${r}`));
    expect(offered("complimentary")).toEqual(["immediate", "on_approval"]);
    // Back to a paid method: the choice is the person's, and When paid is offered again.
    pick(island, "add-deal-payment-offline");
    expect(has(island, "add-deal-golive-on_payment")).toBe(true);
  });

  it("the go-live sub-copy follows the method, word for word from the mockup", () => {
    const { island } = mount();
    const sub = (rule: GoLiveRule) => textIn(island, `add-deal-golive-sub-${rule}`);
    expect(sub("on_payment")).toBe("As soon as the invoice is paid.");
    expect(sub("immediate")).toBe("Before payment arrives.");
    expect(sub("on_approval")).toBe("You press Approve when ready.");
    pick(island, "add-deal-payment-offline");
    expect(sub("on_payment")).toBe("When you mark it paid.");
    expect(sub("immediate")).toBe("Before payment arrives.");
    pick(island, "add-deal-payment-complimentary");
    expect(sub("immediate")).toBe("When you save.");
  });

  it("the email: required for online (the button waits), optional for offline, absent for complimentary", () => {
    const { island } = mount({ sponsor: sponsor({ last_billing_email: null }) });
    expect(textIn(island, "add-deal-email-field")).toContain("Send invoice to");
    expect(isDisabled(island, "add-deal-submit"), "online with no address").toBe(true);
    typeInto(island, "add-deal-email", "not an address");
    expect(isDisabled(island, "add-deal-submit"), "online with a malformed address").toBe(true);
    typeInto(island, "add-deal-email", "pay@ridge.example");
    expect(isDisabled(island, "add-deal-submit")).toBe(false);
    typeInto(island, "add-deal-email", "");
    pick(island, "add-deal-payment-offline");
    expect(textIn(island, "add-deal-email-field")).toContain("Sponsor's email (optional)");
    expect(isDisabled(island, "add-deal-submit"), "offline needs no address").toBe(false);
    typeInto(island, "add-deal-email", "broken");
    expect(isDisabled(island, "add-deal-submit"), "but one that is typed must be an address").toBe(true);
    pick(island, "add-deal-payment-complimentary");
    expect(has(island, "add-deal-email"), "a complimentary deal has no invoice").toBe(false);
    expect(isDisabled(island, "add-deal-submit"), "a leftover bad address does not block it").toBe(false);
  });
});

describe("the primary button names what will happen (the three mockup choices, and the queue)", () => {
  const label = (island: Island) => flat(textOf(one(island, "add-deal-submit")));
  it("online -> Send invoice; offline after approval -> Save deal; complimentary straight away -> Save and go live", () => {
    const { island } = mount();
    expect(label(island)).toBe("Send invoice");
    pick(island, "add-deal-payment-offline");
    pick(island, "add-deal-golive-on_approval");
    expect(label(island)).toBe("Save deal");
    pick(island, "add-deal-payment-complimentary");
    pick(island, "add-deal-golive-immediate");
    expect(label(island)).toBe("Save and go live");
  });

  it("behind a live deal, 'straight away' no longer goes live, so the button says Save deal - until the current deal is ended", () => {
    const { island } = mount({ sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
    pick(island, "add-deal-payment-complimentary");
    pick(island, "add-deal-golive-immediate");
    expect(label(island)).toBe("Save deal");
    tick(island, "add-deal-end-current", true);
    expect(label(island)).toBe("Save and go live");
  });
});

describe("a sponsor with a live deal", () => {
  it("shows the queue note and the End-the-current-deal checkbox; without a live deal neither is there", () => {
    expect(has(mount().island, "add-deal-queue-note")).toBe(false);
    expect(has(mount().island, "add-deal-end-current")).toBe(false);
    const { island } = mount({ sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
    expect(textIn(island, "add-deal-queue-note")).toBe("This deal starts when the current one ends");
    expect(flat(textOf(one(island, "add-deal-end-current-label")))).toBe("End the current deal now instead");
    expect(propsOf(one(island, "add-deal-end-current")).checked).toBe(false);
  });

  it("the summary follows the checkbox: queued behind the live deal -> hidden for nothing; current deal ended -> says it is hidden until then", () => {
    const { island } = mount({ sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
    pick(island, "add-deal-payment-offline");
    expect(summaryOf(island)).toContain("is already live under another deal");
    expect(summaryOf(island)).not.toContain("hidden");
    tick(island, "add-deal-end-current", true);
    expect(summaryOf(island)).not.toContain("already live");
    expect(summaryOf(island)).toContain("Ridge Gold Physiotherapy is hidden from your pages until then.");
  });

  it("End the current deal now is sent as end_current: true, and only when it is ticked", async () => {
    const { island, p } = mount({ sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ end_current: false }));
    tick(island, "add-deal-end-current", true);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ end_current: true }));
    expect(p.onCreate).toHaveBeenCalledTimes(2);
  });

  it("a sponsor with no live deal never sends end_current: true, whatever was ticked before", async () => {
    const { island, p } = mount({ sponsor: sponsor({ locked_by_deal: false }) });
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ end_current: false }));
  });
});

describe("Ends on: the whole organisation only", () => {
  it("shows a date field for the whole organisation, and for a competition the date it runs to instead", async () => {
    const { island, p } = mount();
    expect(has(island, "add-deal-ends-on")).toBe(true);
    typeInto(island, "add-deal-ends-on", "2027-03-31");
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ competition_id: null, ends_on: "2027-03-31" }));
    chooseScope(island, "c1");
    expect(has(island, "add-deal-ends-on")).toBe(false);
    expect(textIn(island, "add-deal-runs-hint")).toBe(msg("sponsors.dealSheet.scopeRuns", { name: "Season 2026/27", date: "31 Aug 2027" }));
    chooseScope(island, "c2");
    expect(textIn(island, "add-deal-runs-hint"), "no end date known").toBe(msg("sponsors.dealSheet.scopeRunsNoDate", { name: "Winter League 2026/27" }));
  });

  it("a package for a competition the page does not hold reads its fallback in lower case INSIDE a sentence (the hint and the summary), never capitalised mid-sentence", () => {
    const GHOST = pkg({ id: "p-ghost", name: "Ghost Cup", tier: "partner", competition_id: "gone" });
    const { island } = mount({ packages: [GHOST] });
    expect(checkedOf(island, "add-deal-package-"), "premise: the only package is chosen").toEqual(["p-ghost"]);
    expect(has(island, "add-deal-runs-hint"), "premise: a package for a competition fixes the scope, so the hint is drawn").toBe(true);
    const inline = msg("sponsors.dealSheet.scopeUnknownInline");
    const capitalised = msg("sponsors.dealSheet.scopeUnknown");
    expect(inline, "premise: the two forms differ").not.toBe(capitalised);
    expect(textIn(island, "add-deal-runs-hint")).toBe(msg("sponsors.dealSheet.scopeRunsNoDate", { name: inline }));
    // The summary names the scope in the middle of its sentence too ("... for {scope} ...").
    expect(summaryOf(island), "the summary names it in lower case").toContain(inline);
    expect(summaryOf(island), "and never in the capitalised form").not.toContain(capitalised);
    // The pair: a competition the page DOES hold keeps its own name, exactly as written.
    const { island: known } = mount({ packages: [CUP] });
    expect(textIn(known, "add-deal-runs-hint")).toBe(msg("sponsors.dealSheet.scopeRuns", { name: "Season 2026/27", date: "31 Aug 2027" }));
    expect(summaryOf(known)).toContain("Season 2026/27");
  });

  it("a date typed for the whole organisation is NOT sent once a competition is picked (what is shown is what is sent)", async () => {
    const { island, p } = mount();
    typeInto(island, "add-deal-ends-on", "2027-03-31");
    chooseScope(island, "c1");
    await submit(island);
    const body = (p.onCreate as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CreateDealBody;
    expect(body.competition_id).toBe("c1");
    expect("ends_on" in body, "no ends_on for a competition").toBe(false);
  });

  it("an empty date sends no ends_on", async () => {
    const { island, p } = mount();
    await submit(island);
    expect("ends_on" in ((p.onCreate as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CreateDealBody)).toBe(false);
  });
});

describe("the summary reads what is on the sheet", () => {
  it("online, when paid: the mockup's sentence with the sheet's own values", () => {
    const { island } = mount({ sponsor: sponsor({ name: "Ridge Gold Physiotherapy" }) });
    chooseScope(island, "c1");
    expect(summaryOf(island)).toBe(
      "Ridge Gold Physiotherapy gets Gold Season for Season 2026/27. We email an invoice for £600 to accounts@ridgegoldphysio.co.uk. They go live when it is paid.",
    );
    typeInto(island, "add-deal-email", "billing@ridge.example");
    expect(summaryOf(island)).toContain("to billing@ridge.example.");
  });

  it("a sponsor on the pages today whose deal waits for payment is told it is hidden until then; one already off the pages is not", () => {
    const shown = mount({ sponsor: sponsor({ status: "active" }) }).island;
    expect(summaryOf(shown)).toContain("is hidden from your pages until then.");
    pick(shown, "add-deal-payment-complimentary");
    pick(shown, "add-deal-golive-immediate");
    expect(summaryOf(shown), "goes live now: nothing to hide").not.toContain("hidden");
    expect(summaryOf(mount({ sponsor: sponsor({ status: "inactive" }) }).island)).not.toContain("hidden");
  });
});

describe("what is sent is what is shown (the seam)", () => {
  /** The choices a person can read off the rendered sheet, turned into the body the server wants. */
  function bodyFromScreen(island: Island): CreateDealBody {
    const [packageId] = packageOf(island);
    const [method] = methodOf(island);
    const [rule] = ruleOf(island);
    const scope = scopeOf(island);
    const email = has(island, "add-deal-email") ? String(propsOf(one(island, "add-deal-email")).value).trim() : "";
    const endsOn = has(island, "add-deal-ends-on") ? String(propsOf(one(island, "add-deal-ends-on")).value) : "";
    const endCurrent = has(island, "add-deal-end-current") ? propsOf(one(island, "add-deal-end-current")).checked === true : false;
    return {
      package_id: packageId!,
      competition_id: scope === "" ? null : scope,
      payment_method: method as PaymentMethod,
      go_live: rule as GoLiveRule,
      ...(email ? { sponsor_email: email } : {}),
      ...(endsOn ? { ends_on: endsOn } : {}),
      end_current: endCurrent,
    };
  }

  // The ids are REAL uuids here: the server's body schema (strict, `package_id: Uuid`) refuses anything else, so the sweep can only
  // prove the bodies it sends are bodies the server takes if it sends what a real org's ids look like.
  const U_PACKAGE = "0b6e0d6a-5c1e-4a3b-8f0e-1d2c3b4a5f60";
  const U_COMP = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const U_PACKAGES = [pkg({ id: U_PACKAGE, name: "Gold Season", price_cents: 60_000, tier: "gold" })];
  const U_COMPETITIONS = [{ id: U_COMP, name: "Winter League 2026/27", ends_on: null }];

  it("every payment method x every go-live card it offers x whole organisation / a competition (counted); every body parses through the server's strict schema", async () => {
    let checked = 0;
    let parsed = 0;
    for (const method of ["online", "offline", "complimentary"] as const) {
      for (const rule of goLiveRulesFor(method)) {
        for (const scope of ["", U_COMP]) {
          const { island, p } = mount({ sponsor: sponsor({ locked_by_deal: true, status: "active" }), packages: U_PACKAGES, competitions: U_COMPETITIONS });
          pick(island, `add-deal-payment-${method}`);
          pick(island, `add-deal-golive-${rule}`);
          chooseScope(island, scope);
          if (scope === "") typeInto(island, "add-deal-ends-on", "2027-06-30");
          tick(island, "add-deal-end-current", checked % 2 === 0);
          const shown = bodyFromScreen(island);
          await submit(island);
          expect(p.onCreate, `${method}/${rule}/${scope || "whole"}`).toHaveBeenCalledTimes(1);
          const sent = (p.onCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateDealBody;
          expect(sent, `${method}/${rule}/${scope || "whole"}`).toEqual(shown);
          // The server's own contract (server/api-v1/schemas/sponsors.ts): strict, uuids, an ISO day, a real email.
          expect(() => CreateSponsorDeal.parse(sent), `${method}/${rule}/${scope || "whole"}: the body the server takes`).not.toThrow();
          parsed++;
          checked++;
        }
      }
    }
    expect(checked, "8 valid pairs x 2 scopes").toBe(16);
    expect(parsed, "every one of them went through the schema").toBe(16);
  });

  it("the schema check is live: an unknown key, a non-uuid package and a bad day are each refused (so a pass above means something)", () => {
    const ok: CreateDealBody = { package_id: U_PACKAGE, competition_id: null, payment_method: "offline", go_live: "on_payment", end_current: false };
    expect(() => CreateSponsorDeal.parse(ok), "premise: the base body parses").not.toThrow();
    expect(() => CreateSponsorDeal.parse({ ...ok, currency: "gbp" }), "strict: an unknown key").toThrow();
    expect(() => CreateSponsorDeal.parse({ ...ok, package_id: "p-gold" }), "a package id that is not a uuid").toThrow();
    expect(() => CreateSponsorDeal.parse({ ...ok, ends_on: "30/06/2027" }), "an ends_on that is not an ISO day").toThrow();
  });

  it("a complimentary deal sends no billing email even when the sponsor has one on file", async () => {
    const { island, p } = mount();
    pick(island, "add-deal-payment-complimentary");
    await submit(island);
    const body = (p.onCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateDealBody;
    expect(body.payment_method).toBe("complimentary");
    expect("sponsor_email" in body).toBe(false);
  });

  it("an offline deal with the field emptied sends no email; with one typed, sends it trimmed", async () => {
    const { island, p } = mount();
    pick(island, "add-deal-payment-offline");
    typeInto(island, "add-deal-email", "");
    await submit(island);
    expect("sponsor_email" in ((p.onCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateDealBody)).toBe(false);
    typeInto(island, "add-deal-email", "  pay@ridge.example ");
    await submit(island);
    expect((p.onCreate as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toMatchObject({ sponsor_email: "pay@ridge.example" });
  });

  it("a package for one competition sends that competition", async () => {
    const { island, p } = mount();
    pick(island, "add-deal-package-p-cup");
    await submit(island);
    expect(p.onCreate).toHaveBeenCalledWith(expect.objectContaining({ package_id: "p-cup", competition_id: "c1" }));
  });

  it("the guard: a competition forced onto a community sheet (the disabled option cannot be picked, but the handler can be called) sends nothing", async () => {
    const { island, p } = mount({ tiersOrgWide: false, hasMonetize: false, chargesEnabled: false });
    chooseScope(island, "c1");
    expect(isDisabled(island, "add-deal-submit"), "the button waits").toBe(true);
    await submit(island);
    expect(p.onCreate).not.toHaveBeenCalled();
  });
});

// --- fix round 1 ------------------------------------------------------------------------------------------------------------------

describe("Online is offered only for a scope the plan sells it on: an Event Pass lifts its own competition and never the whole organisation (m2)", () => {
  // The server's gate is per scope (server/sponsors/deal-gates.ts `assertOnlineAllowed`: `requireFeature(org, "sponsors.monetize",
  // competitionId)`; a null scope resolves org-wide, which on a pass org is the community answer). A pass org: `hasMonetize` (reachable
  // on SOME scope) is true, org-wide is false, and only c1 is lifted.
  const PASS = { hasMonetize: true, monetizeOrgWide: false, monetizeCompetitionIds: ["c1"], chargesEnabled: true } as const;
  const WHOLE_SENTENCE = "Online invoices for the whole organisation need a paid plan. An Event Pass covers its own competition only.";
  const COMP_SENTENCE = "This competition has no Event Pass, and online invoices need a paid plan or a pass for it.";

  it("the whole organisation (where it opens): Online is locked with the scope's sentence and an upgrade way out, and the sheet opens on Offline", async () => {
    const { island, p } = mount(PASS);
    expect(scopeOf(island)).toBe("");
    expect(methodOf(island), "no Online on the whole organisation: it would be a 402").toEqual(["offline"]);
    expect(isDisabled(island, "add-deal-payment-online")).toBe(true);
    expect(textIn(island, "add-deal-payment-lock-scope")).toBe(WHOLE_SENTENCE);
    expect(propsOf(one(island, "add-deal-payment-link-online")).href, "a way out: the plan, not Connect").toBe(routes.billing(SLUG));
    expect(textIn(island, "add-deal-payment-lock-online")).not.toContain("Paid plans only");
    // What is shown is what is sent.
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ payment_method: "offline", competition_id: null }));
  });

  it("the pass's competition: Online opens, with no lock hint, and a deal for it is sent online", async () => {
    const { island, p } = mount(PASS);
    chooseScope(island, "c1");
    expect(isDisabled(island, "add-deal-payment-online")).toBe(false);
    expect(has(island, "add-deal-payment-lock-online"), "no hint where Online is open").toBe(false);
    pick(island, "add-deal-payment-online");
    expect(methodOf(island)).toEqual(["online"]);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ payment_method: "online", competition_id: "c1" }));
  });

  it("a competition with no pass: Online is locked with ITS sentence (not the whole-organisation one)", () => {
    const { island } = mount(PASS);
    chooseScope(island, "c2");
    expect(isDisabled(island, "add-deal-payment-online")).toBe(true);
    expect(textIn(island, "add-deal-payment-lock-scope")).toBe(COMP_SENTENCE);
    expect(textIn(island, "add-deal-payment-lock-scope")).not.toBe(WHOLE_SENTENCE);
  });

  it("a package for the pass's competition opens ON Online; a package for any other competition does not", () => {
    const passPkg = mount({ ...PASS, packages: [CUP] });
    expect(scopeOf(passPkg.island)).toBe("c1");
    expect(methodOf(passPkg.island), "its scope is lifted: the plan's best choice").toEqual(["online"]);
    const otherPkg = mount({ ...PASS, packages: [pkg({ id: "p-c2", name: "Winter Partner", competition_id: "c2" })] });
    expect(scopeOf(otherPkg.island)).toBe("c2");
    expect(methodOf(otherPkg.island)).toEqual(["offline"]);
  });

  it("a choice that no longer holds falls to Offline, and is SENT as Offline: Online picked on the pass's competition, then the scope moved to the whole organisation", async () => {
    const { island, p } = mount(PASS);
    chooseScope(island, "c1");
    pick(island, "add-deal-payment-online");
    chooseScope(island, "");
    expect(methodOf(island)).toEqual(["offline"]);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ payment_method: "offline", competition_id: null }));
  });

  it("the pairs: a paid plan opens Online on the whole organisation AND on every competition; a covered scope without Stripe charges says Connect, not the scope sentence (counted)", () => {
    let checked = 0;
    for (const scope of ["", "c1", "c2"]) {
      const paid = mount({ hasMonetize: true, monetizeOrgWide: true, monetizeCompetitionIds: [], chargesEnabled: true });
      chooseScope(paid.island, scope);
      expect(isDisabled(paid.island, "add-deal-payment-online"), `paid plan, scope ${scope || "whole"}`).toBe(false);
      checked++;
    }
    const noCharges = mount({ ...PASS, chargesEnabled: false });
    chooseScope(noCharges.island, "c1");
    expect(has(noCharges.island, "add-deal-payment-lock-scope"), "scope covered: not the scope sentence").toBe(false);
    expect(propsOf(one(noCharges.island, "add-deal-payment-link-online")).href).toBe(routes.connect(SLUG));
    checked++;
    const none = mount({ hasMonetize: false, monetizeOrgWide: false, monetizeCompetitionIds: [], chargesEnabled: true });
    expect(textIn(none.island, "add-deal-payment-lock-online"), "no plan at all: the plan sentence").toBe("Paid plans only. Upgrade to send invoices");
    expect(has(none.island, "add-deal-payment-lock-scope")).toBe(false);
    checked++;
    expect(checked).toBe(5);
  });
});

describe("the opening method is the plan's best choice for the FIRST package's scope, and stays the person's pick when the package or scope moves (D22; batch H re-review)", () => {
  // The useState initialiser reads `monetizeFor(firstOpen scope)`. Every test above asserts the method AT OPENING, where
  // `hasMonetize` (reachable on SOME scope) and `monetizeFor(first scope)` agree on a paid plan and differ only on a pass org,
  // and the shown method is DERIVED (`pickedMethod === "online" && !onlineOpen ? "offline"`), so a wrong initialiser only
  // shows once the person MOVES the package or the scope after opening. An Event Pass org: only c1 is lifted.
  const PASS = { hasMonetize: true, monetizeOrgWide: false, monetizeCompetitionIds: ["c1"], chargesEnabled: true } as const;

  it("opens on Offline (the whole organisation is not lifted); moving to the pass's competition by SCOPE leaves it Offline - nobody picked Online", async () => {
    const { island, p } = mount({ ...PASS, packages: [PARTNER] });
    expect(methodOf(island)).toEqual(["offline"]);
    chooseScope(island, "c1");
    expect(isDisabled(island, "add-deal-payment-online"), "premise: Online is open on c1").toBe(false);
    expect(methodOf(island), "the method the sheet opened on is kept; it was never turned Online").toEqual(["offline"]);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ payment_method: "offline", competition_id: "c1" }));
  });

  it("opens on Offline; moving to the pass's competition by PACKAGE leaves it Offline, and what is sent is Offline", async () => {
    const { island, p } = mount({ ...PASS, packages: [PARTNER, CUP] });
    expect(packageOf(island)).toEqual(["p-partner"]);
    expect(methodOf(island)).toEqual(["offline"]);
    pick(island, "add-deal-package-p-cup");
    expect(scopeOf(island), "premise: the package fixed the scope at c1").toBe("c1");
    expect(isDisabled(island, "add-deal-payment-online"), "premise: Online is open on c1").toBe(false);
    expect(methodOf(island)).toEqual(["offline"]);
    await submit(island);
    expect(p.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ payment_method: "offline", competition_id: "c1" }));
  });

  it("the pair: opens on Online when the FIRST package's scope is lifted; moving to the whole organisation falls to Offline, and moving back is Online again (counted)", () => {
    const { island } = mount({ ...PASS, packages: [CUP, PARTNER] });
    let checked = 0;
    expect(packageOf(island)).toEqual(["p-cup"]);
    expect(methodOf(island)).toEqual(["online"]);
    checked++;
    pick(island, "add-deal-package-p-partner");
    expect(methodOf(island), "not lifted on the whole organisation: derived Offline").toEqual(["offline"]);
    checked++;
    pick(island, "add-deal-package-p-cup");
    expect(methodOf(island), "the person's pick was never changed").toEqual(["online"]);
    checked++;
    expect(checked).toBe(3);
  });
});

describe("a package whose competition has finished is not sold (m1)", () => {
  const FINISHED = "This package's competition has finished, so it can't be sold any more.";

  it("it is shown locked with the reason and no upgrade link, the other cards stay open, and the sheet opens on the first package that is still sold (counted)", () => {
    const { island } = mount({ finishedCompetitionIds: ["c1"] });
    let cards = 0;
    for (const id of ["p-gold", "p-silver", "p-partner", "p-cup"]) {
      expect(isDisabled(island, `add-deal-package-${id}`), id).toBe(id === "p-cup");
      cards++;
    }
    expect(cards).toBe(4);
    expect(textIn(island, "add-deal-package-finished-p-cup")).toBe(FINISHED);
    expect(has(island, "add-deal-package-upgrade-p-cup"), "an upgrade does not bring a finished competition back").toBe(false);
    expect(has(island, "add-deal-package-lock-p-cup"), "it is not the plan's lock").toBe(false);
    expect(packageOf(island)).toEqual(["p-gold"]);
    // The opening skips it: a sheet whose first package is the finished one opens on the next.
    const first = mount({ packages: [CUP, PARTNER], finishedCompetitionIds: ["c1"] });
    expect(packageOf(first.island)).toEqual(["p-partner"]);
  });

  it("it is never sent: the radio is disabled, and even the handler called anyway (a stale tap) sends nothing", async () => {
    const { island, p } = mount({ packages: [CUP], finishedCompetitionIds: ["c1"] });
    expect(packageOf(island), "nothing is chosen").toEqual([]);
    pick(island, "add-deal-package-p-cup");
    expect(isDisabled(island, "add-deal-submit")).toBe(true);
    await submit(island);
    expect(p.onCreate).not.toHaveBeenCalled();
  });

  it("the pairs: the same package is sold while its competition is running; another competition's end locks nothing here; a whole-organisation package is never locked by the list (counted)", async () => {
    let checked = 0;
    for (const finished of [[], ["c2"]]) {
      const { island, p } = mount({ packages: [CUP], finishedCompetitionIds: finished });
      expect(isDisabled(island, "add-deal-package-p-cup"), `finished=${JSON.stringify(finished)}`).toBe(false);
      expect(packageOf(island)).toEqual(["p-cup"]);
      await submit(island);
      expect(p.onCreate).toHaveBeenCalledTimes(1);
      checked++;
    }
    const whole = mount({ packages: [PARTNER], finishedCompetitionIds: ["c1", "c2"] });
    expect(isDisabled(whole.island, "add-deal-package-p-partner")).toBe(false);
    checked++;
    expect(checked).toBe(3);
  });

  it("the lock does not depend on the plan: a paid plan locks it too, and a community sheet shows the finished reason before the plan's", () => {
    const paid = mount({ tiersOrgWide: true, finishedCompetitionIds: ["c1"] });
    expect(isDisabled(paid.island, "add-deal-package-p-cup")).toBe(true);
    const community = mount({ tiersOrgWide: false, hasMonetize: false, chargesEnabled: false, finishedCompetitionIds: ["c1"] });
    expect(has(community.island, "add-deal-package-finished-p-cup")).toBe(true);
    expect(has(community.island, "add-deal-package-lock-p-cup"), "one reason at a time").toBe(false);
  });
});

describe("ending the current deal promotes an earlier deal that is waiting, which keeps the sponsor on the pages (m3)", () => {
  const LIVE_SPONSOR = sponsor({ locked_by_deal: true, status: "active" });
  const waiting = (over: Partial<SponsorDeal> = {}): SponsorDeal =>
    ({ ...OPEN_DEAL, id: "d-wait", deal_status: "scheduled", payment_method: "offline", ends_at: null, ...over });
  const HIDDEN = "Ridge Gold Physiotherapy is hidden from your pages until then.";
  /** A waiting deal that stays waiting for the sponsor's next deal, with the new deal NOT going live now (offline, after approval). */
  function mountEnding(deals: SponsorDeal[], endCurrent: boolean) {
    const m = mount({ sponsor: LIVE_SPONSOR, deals });
    pick(m.island, "add-deal-payment-offline");
    pick(m.island, "add-deal-golive-on_approval");
    tick(m.island, "add-deal-end-current", endCurrent);
    return m;
  }

  it("ticked, with a deal waiting behind the live one: nothing is hidden (the waiting deal goes live in its place)", () => {
    const { island } = mountEnding([waiting()], true);
    expect(summaryOf(island)).not.toContain("hidden");
    expect(summaryOf(island), "and it is no longer 'queued behind the live deal' either").not.toContain("already live");
  });

  it("the pairs (counted): nothing waiting -> hidden; the waiting deal is past its own end (the sweep ends it, it is never promoted) -> hidden; another sponsor's waiting deal -> hidden; a waiting deal with a future end -> not hidden", () => {
    const cases: { label: string; deals: SponsorDeal[]; hidden: boolean }[] = [
      { label: "nothing waiting", deals: [], hidden: true },
      { label: "waiting but past its end", deals: [waiting({ ends_at: "2020-01-01T00:00:00.000Z" })], hidden: true },
      { label: "another sponsor's waiting deal", deals: [waiting({ sponsor_id: "someone-else" })], hidden: true },
      { label: "a live deal is not a waiting one", deals: [{ ...OPEN_DEAL, id: "d-live", deal_status: "live", payment_method: "offline" }], hidden: true },
      { label: "waiting, ends in the future", deals: [waiting({ ends_at: "2099-01-01T00:00:00.000Z" })], hidden: false },
      { label: "waiting, no end", deals: [waiting()], hidden: false },
    ];
    let checked = 0;
    for (const c of cases) {
      const { island } = mountEnding(c.deals, true);
      expect(summaryOf(island).includes(HIDDEN), c.label).toBe(c.hidden);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("unticked, the deal queues behind the live one and the sheet says that - never hidden, whether or not another deal waits", () => {
    for (const deals of [[], [waiting()]]) {
      const { island } = mountEnding(deals, false);
      expect(summaryOf(island)).toContain("is already live under another deal");
      expect(summaryOf(island)).not.toContain("hidden");
    }
  });
});

describe("one tap, one deal", () => {
  it("a second tap while it is in flight sends nothing, and the button is disabled and back again afterwards", async () => {
    let release!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { island } = mount({ onCreate });
    const stale = propsOf(one(island, "add-deal-submit")).onClick as () => Promise<void>;
    const first = stale();
    const second = stale();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(isDisabled(island, "add-deal-submit"), "disabled while in flight").toBe(true);
    release();
    await Promise.all([first, second]);
    expect(isDisabled(island, "add-deal-submit"), "enabled again").toBe(false);
    const again = submit(island);
    release();
    await again;
    expect(onCreate, "a deliberate second tap after it finished is a second deal").toHaveBeenCalledTimes(2);
  });

  it("Escape and the close button do nothing while it is in flight", async () => {
    let release!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { island, p } = mount({ onCreate });
    const sending = submit(island);
    const modal = island.tree().find((e) => e.type === Modal)!;
    (propsOf(modal).onClose as () => void)();
    (propsOf(one(island, "add-deal-cancel")).onClick as () => void)();
    expect(p.onClose).not.toHaveBeenCalled();
    release();
    await sending;
    // Resolving means the deal is made: the sheet closes itself, once.
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes it when nothing is in flight; a refusal does not close it", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new ApiV1Error("x", 422, "package_retired"));
    const { island, p } = mount({ onCreate });
    await submit(island);
    expect(p.onClose, "a refusal keeps the sheet open").not.toHaveBeenCalled();
    (propsOf(one(island, "add-deal-cancel")).onClick as () => void)();
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("a refusal stays on the sheet, in the dictionary's words", () => {
  it("shows the mapped sentence, keeps every choice, and lets the person fix it and send again", async () => {
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new ApiV1Error("package not found", 422, "package_retired"))
      .mockResolvedValueOnce(undefined);
    const { island } = mount({ onCreate });
    pick(island, "add-deal-payment-offline");
    pick(island, "add-deal-package-p-silver");
    await submit(island);
    expect(textIn(island, "add-deal-error")).toBe(msg("sponsors.error.packageRetired"));
    expect(textIn(island, "add-deal-error")).not.toContain("package not found");
    expect(packageOf(island)).toEqual(["p-silver"]);
    expect(methodOf(island)).toEqual(["offline"]);
    expect(isDisabled(island, "add-deal-submit")).toBe(false);
    await submit(island);
    expect(has(island, "add-deal-error"), "a new attempt clears the old refusal").toBe(false);
  });

  it("a stripe_unavailable the sheet is handed reads the words of ITS create: Send invoice for a saved draft, Resend invoice for a deal that is live, 'look at the deals' when the current deal was being ended (counted)", async () => {
    // The page resolves for an ONLINE create's refusal (it closes the sheet and speaks itself), so a sheet only meets it from another
    // caller - but the words must still be right: each names the action the saved deal actually offers (`allowedActions`), and a
    // refusal while the current deal is being ended cannot promise that nothing was changed OR that a draft exists.
    let checked = 0;
    const CASES: { rule: GoLiveRule; ending: boolean; key: MessageKey }[] = [
      { rule: "on_payment", ending: false, key: "sponsors.error.invoiceSavedNoLink" },
      { rule: "on_approval", ending: false, key: "sponsors.error.invoiceSavedNoLink" },
      { rule: "immediate", ending: false, key: "sponsors.error.invoiceSavedResend" },
      { rule: "on_payment", ending: true, key: "sponsors.error.invoiceNotSentCheck" },
      { rule: "immediate", ending: true, key: "sponsors.error.invoiceNotSentCheck" },
    ];
    for (const c of CASES) {
      const onCreate = vi.fn().mockRejectedValue(new ApiV1Error("x", 502, "stripe_unavailable"));
      const { island } = mount({ onCreate, sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
      pick(island, `add-deal-golive-${c.rule}`);
      if (c.ending) tick(island, "add-deal-end-current", true);
      await submit(island);
      expect(textIn(island, "add-deal-error"), `${c.rule} ending=${c.ending}`).toBe(msg(c.key));
      checked++;
    }
    expect(checked).toBe(CASES.length);
    // And the words name the button the person will find: Resend where the deal is live, Send where it is a draft.
    expect(msg("sponsors.error.invoiceSavedNoLink")).toContain(msg("sponsors.deal.action.sendInvoice"));
    expect(msg("sponsors.error.invoiceSavedResend")).toContain(msg("sponsors.deal.action.resendInvoice"));
    expect(msg("sponsors.error.invoiceSavedResend"), "the live deal's words do not send the club to a button it will not find").not.toContain(msg("sponsors.deal.action.sendInvoice"));
  });

  it("a create that ends the current deal and sends no invoice, refused by Stripe, SAVED NOTHING: the sheet says so in the shared words and keeps every choice (F6)", async () => {
    // Offline / complimentary + end_current: the only Stripe call is closing the live deal's pay link, before anything is written.
    // (The page rethrows this refusal for the sheet; it does not close it.)
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new ApiV1Error("x", 502, "stripe_unavailable"))
      .mockResolvedValueOnce(undefined);
    const { island, p } = mount({ onCreate, sponsor: sponsor({ locked_by_deal: true, status: "active" }) });
    pick(island, "add-deal-payment-offline");
    pick(island, "add-deal-golive-on_approval");
    tick(island, "add-deal-end-current", true);
    await submit(island);
    expect(textIn(island, "add-deal-error")).toBe(msg("sponsors.error.stripeUnavailable"));
    expect(msg("sponsors.error.stripeUnavailable"), "the shared words are the 'nothing was changed' ones").toContain("nothing was changed");
    expect(p.onClose, "the sheet is still open").not.toHaveBeenCalled();
    expect(methodOf(island)).toEqual(["offline"]);
    expect(ruleOf(island)).toEqual(["on_approval"]);
    expect(propsOf(one(island, "add-deal-end-current")).checked, "the choices are kept").toBe(true);
    expect(isDisabled(island, "add-deal-submit"), "and it can be sent again").toBe(false);
    await submit(island);
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(p.onClose, "the retry succeeded: now it closes").toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[1]![0], "the same body again").toEqual(onCreate.mock.calls[0]![0]);
  });

  it("anything that is not a v1 refusal (a dropped connection) reads the house fallback, never the browser's English", async () => {
    const onCreate = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { island } = mount({ onCreate });
    await submit(island);
    expect(textIn(island, "add-deal-error")).toBe(msg("settings.saveFailed"));
  });
});

describe("a second open deal on the same package asks first", () => {
  it("online: the house 'send a second invoice' confirm; declining sends nothing, accepting sends", async () => {
    const { island, p } = mount({ deals: [OPEN_DEAL] });
    confirmMock.mockImplementationOnce(async () => false);
    await submit(island);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: msg("sponsors.deal.confirm.dup.title"),
      body: msg("sponsors.deal.confirm.dup.body", { name: "Ridge Gold Physiotherapy" }),
      confirmLabel: msg("sponsors.deal.confirm.dup.label"),
    });
    expect(p.onCreate, "declined").not.toHaveBeenCalled();
    await submit(island);
    expect(p.onCreate, "accepted").toHaveBeenCalledTimes(1);
  });

  it("offline: the same question in words that do not talk about invoices", async () => {
    const { island, p } = mount({ deals: [OPEN_DEAL] });
    pick(island, "add-deal-payment-offline");
    await submit(island);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: msg("sponsors.dealSheet.dup.title"),
      body: msg("sponsors.dealSheet.dup.body", { name: "Ridge Gold Physiotherapy" }),
      confirmLabel: msg("sponsors.dealSheet.dup.label"),
    });
    expect(p.onCreate).toHaveBeenCalledTimes(1);
  });

  it("the pairs: another package, another sponsor's deal, a live deal and an ended one on the same package ask nothing (counted)", async () => {
    const cases: Array<[string, SponsorDeal[]]> = [
      ["another package", [{ ...OPEN_DEAL, package_id: "p-silver" }]],
      ["another sponsor", [{ ...OPEN_DEAL, sponsor_id: "someone-else" }]],
      ["a live deal", [{ ...OPEN_DEAL, deal_status: "live" }]],
      ["an ended deal", [{ ...OPEN_DEAL, deal_status: "ended" }]],
      ["no deals", []],
    ];
    let checked = 0;
    for (const [label, deals] of cases) {
      const { island, p } = mount({ deals });
      await submit(island);
      expect(confirmMock, label).not.toHaveBeenCalled();
      expect(p.onCreate, label).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the question is asked once per tap even when the tap is repeated while it is open", async () => {
    let answer!: (ok: boolean) => void;
    confirmMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { island, p } = mount({ deals: [OPEN_DEAL] });
    const stale = propsOf(one(island, "add-deal-submit")).onClick as () => Promise<void>;
    const first = stale();
    const second = stale();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    answer(true);
    await Promise.all([first, second]);
    expect(p.onCreate).toHaveBeenCalledTimes(1);
  });
});
