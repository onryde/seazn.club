// Sponsor deals PR 2, Task 14 - the Sponsors tab's list (components/sponsors/sponsor-list.tsx): each sponsor row carries its
// deal's chip and ONE next action (`rowNextAction`, lib/sponsor-deals.ts, F15), grouped by the deal's tier.
//
// Every expectation is typed from the MOCKUP (screen 1 of 2026-11-01_sponsor-deals-mockups: the eight rows, their chips, sub-lines,
// actions and the group counts 1 / 1 / 2 / 4) or from spec §6 - never read back from the component. vitest is
// `environment: "node"`: the list's markup is read from `renderToStaticMarkup`; a click is the element's own handler called, in the
// tree `_sponsor-tree.tsx` expands (SponsorList, SponsorRowMore and DealChip are stateless; every bit of state is OrgSponsors').
// What neither can see (CSS, real widths, a real tap) is `e2e/sponsor-deals.spec.ts`, run by CI at 320 / 768 / 1280.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   L1  one action     render `allowedActions(deal)[1]` beside the row's action                       -> "one action at most"
//   L2  precedence     `rowNextAction(deal)` -> a draft row offers Send invoice                       -> "the eight mockup rows"
//   L3  group key      group by `s.tier` instead of `s.deal?.tier ?? s.tier`                         -> "a pending gold deal"
//   L4  fold           drop `max-md:hidden` from the tray                                              -> "the tray is hidden below md"
//   L5  fold twice     render the controls a second time (a phone copy)                                -> "each control exists once"
//   L6  viewer         drop the `canEdit &&` guard on the action                                      -> "a viewer"
//   L7  tap            the toggle loses `h-11 w-11`                                                    -> "the toggle is a 44px target"
//   L8  truncation     drop `min-w-0` from the name's wrapper                                          -> "a 43-character name"
//   L9  wiring         Resend invoice POSTs `/approve`                                                 -> "Resend invoice POSTs"
//   L10 write words    resend refusal read through the shared map                                     -> "a refused Resend"
//   L11 stored tier    `move()` drops its `sameOrderBand` guard                                       -> "a call that gets past the disabled arrow"
//   L12 arrows         the up/down `disabled` drops `sameOrderBand`                                   -> "the arrows between a native gold"
//   L13 confirm        Mark as paid skips the confirm                                                  -> "Mark as paid asks first"
//   L14 cancel         Mark as paid ignores a "no" and POSTs anyway                                   -> "cancelled: no POST"
//   L15 edit           `startEdit` stops clearing `moreOpenId`                                         -> "Edit does not leave the row's tray open"
//   L16 live region    the notice renders only while it has text                                      -> "always mounted"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

import { OrgSponsors, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { AddDealSheet, type CreateDealBody } from "@/components/sponsors/add-deal-sheet";
import { canShowAgain, SponsorList, type SponsorListProps } from "@/components/sponsors/sponsor-list";
import { SponsorRowMore } from "@/components/sponsors/sponsor-row-more";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "./_sponsor-tree";
import { attrOf, classTokens, findAll, findOne, textOfMarkup } from "./_markup";
import { ApiV1Error } from "@/lib/client-v1";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";
import type { SponsorDeal } from "@/lib/sponsor-deals";
import { t } from "@/lib/i18n-runtime";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
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
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
const COMPS = [
  { id: "c-season", name: "Season 2026/27" },
  { id: "c-winter", name: "Winter League 2026/27" },
];

// --- fixtures --------------------------------------------------------------------------------------------------------------------

const DEAL: SponsorDeal = {
  id: "d0", sponsor_id: "s0", package_id: "p0", deal_status: "live", payment_status: "paid", payment_method: "online",
  go_live: "on_payment", package_name: "Partner", tier: "partner", includes_on_stream: false, competition_id: null,
  amount_cents: 12_000, currency: "gbp", sponsor_name: "x", sponsor_email: "accounts@example.com", ends_at: null,
  created_at: "2026-10-01T09:00:00.000Z", created_by: null, invoice_sent_at: null, paid_at: null, marked_paid_by: null,
  approved_at: null, approved_by: null, live_at: null, ended_at: null, ended_reason: null, parked_at: null, disputed_at: null,
  dispute_id: null, has_payment_intent: false, invoice_number: null,
};
const deal = (over: Partial<SponsorDeal>): SponsorDeal => ({ ...DEAL, ...over });

const sponsor = (over: Partial<SponsorItem> & { id: string; name: string }): SponsorItem => ({
  competition_id: null, url: null, logo_path: null, tier: "partner", display_order: 0, status: "active", click_count: 0,
  on_stream: false, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null, ...over,
});

/** The mockup's eight rows (screen 1), in the mockup's group order. `chip` / `sub` / `action` are the words in the picture. */
interface MockupRow {
  s: SponsorItem;
  group: (typeof SPONSOR_TIERS)[number];
  chip: string;
  sub: string;
  /** The `RowAction` and its button words, or null: no button. */
  action: [string, string] | null;
}
const MOCKUP: MockupRow[] = [
  {
    s: sponsor({
      id: "s1", name: LONG_NAME, tier: "title", click_count: 41, locked_by_deal: true, url: "https://harbourside.example/",
      deal: deal({ id: "d1", sponsor_id: "s1", deal_status: "live", payment_status: "paid", package_name: "Title Season", tier: "title", amount_cents: 150_000, competition_id: "c-season" }),
    }),
    group: "title", chip: "Live", sub: "Title Season · £1,500 · Season 2026/27", action: null,
  },
  {
    s: sponsor({
      id: "s2", name: "Ridge Gold Physiotherapy", tier: "partner", click_count: 12, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d2", sponsor_id: "s2", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online", package_name: "Gold Season", tier: "gold", amount_cents: 60_000, invoice_sent_at: "2026-10-28T10:00:00.000Z" }),
    }),
    group: "gold", chip: "Awaiting payment", sub: "Gold Season · £600 · Online invoice sent 28 Oct", action: ["resend_invoice", "Resend invoice"],
  },
  {
    s: sponsor({
      id: "s3", name: "Quay Fisheries", tier: "partner", click_count: 7, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d3", sponsor_id: "s3", deal_status: "awaiting_approval", payment_status: "paid", payment_method: "online", go_live: "on_approval", package_name: "Silver Season", tier: "silver", amount_cents: 30_000, paid_at: "2026-10-16T12:00:00.000Z" }),
    }),
    group: "silver", chip: "Awaiting approval", sub: "Silver Season · £300 · Paid 16 Oct", action: ["approve", "Approve"],
  },
  {
    s: sponsor({
      id: "s4", name: "Marlow & Daughters Bakery", tier: "partner", click_count: 3, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d4", sponsor_id: "s4", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", package_name: "Silver Season", tier: "silver", amount_cents: 30_000 }),
    }),
    group: "silver", chip: "Awaiting payment", sub: "Silver Season · £300 · Bank transfer", action: ["mark_paid", "Mark as paid"],
  },
  {
    s: sponsor({
      id: "s5", name: "Old Anchor Café", tier: "partner", click_count: 9, locked_by_deal: true,
      deal: deal({ id: "d5", sponsor_id: "s5", deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate", package_name: "Partner", tier: "partner", amount_cents: 0, competition_id: "c-winter" }),
    }),
    group: "partner", chip: "Live", sub: "Partner · Complimentary · Winter League 2026/27", action: null,
  },
  {
    s: sponsor({
      id: "s6", name: "Kestrel Taxis", tier: "partner", click_count: 0, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d6", sponsor_id: "s6", deal_status: "draft", payment_status: "pending", payment_method: "online", package_name: "Partner", tier: "partner", amount_cents: 12_000 }),
    }),
    group: "partner", chip: "Draft", sub: "Partner · £120 · Not sent yet", action: ["open_deal", "Open deal"],
  },
  {
    s: sponsor({ id: "s7", name: "Northbank Print", tier: "partner", click_count: 2, status: "inactive", url: "https://northbank-print.co.uk/", deal: null }),
    group: "partner", chip: "No deal", sub: "No deal · northbank-print.co.uk", action: ["add_deal", "Add deal"],
  },
  {
    s: sponsor({
      id: "s8", name: "Tidewell Garage", tier: "partner", click_count: 18, status: "inactive",
      deal: deal({ id: "d8", sponsor_id: "s8", deal_status: "ended", payment_status: "paid", package_name: "Partner", tier: "partner", amount_cents: 12_000, ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" }),
    }),
    group: "partner", chip: "Ended", sub: "Partner · £120 · Ended 31 Aug", action: ["add_deal", "Add deal"],
  },
];
const ROWS = MOCKUP.map((m) => m.s);
/** The mockup's link-click counts per row (the `title="N link clicks"` on each row of screen 1), typed here - the fixture sets the same
 *  numbers on the sponsors, so the row can be seen to read them back. */
const MOCKUP_CLICKS: Record<string, number> = { s1: 41, s2: 12, s3: 7, s4: 3, s5: 9, s6: 0, s7: 2, s8: 18 };

const noop = () => {};
function listProps(sponsors: SponsorItem[], over: Partial<SponsorListProps> = {}): SponsorListProps {
  return {
    sponsors, hasTiers: true, canEdit: true, busy: false, orgSlug: SLUG, tz: "UTC", competitions: COMPS, editingId: null,
    renderEditor: () => null, moreOpenId: null, onToggleMore: noop, onEdit: noop, onMove: noop, onRemove: noop,
    onAction: noop, onAddDeal: noop, ...over,
  };
}
const listHtml = (sponsors: SponsorItem[], over: Partial<SponsorListProps> = {}) =>
  renderToStaticMarkup(<SponsorList {...listProps(sponsors, over)} />);

/** One sponsor's `<li>`. */
function rowOf(markup: string, id: string): string {
  const li = findAll(markup, "sponsor-row").find((f) => attrOf(f.open, "data-sponsor-id") === id);
  if (!li) throw new Error(`no row for ${id}`);
  return li.outer;
}

beforeEach(() => vi.clearAllMocks());

// --- the list --------------------------------------------------------------------------------------------------------------------

describe("the eight mockup rows: each chip, sub-line and ONE next action (mockup screen 1)", () => {
  it("the fixture IS the mockup: eight rows, groups 1 / 1 / 2 / 4", () => {
    expect(MOCKUP).toHaveLength(8);
    const counts = SPONSOR_TIERS.map((tier) => MOCKUP.filter((m) => m.group === tier).length);
    expect(counts).toEqual([1, 1, 2, 4]);
  });

  it("each row shows the chip its deal state names, the sub-line, and the action rowNextAction picks (8 checked)", () => {
    const markup = listHtml(ROWS);
    expect(findAll(markup, "sponsor-row"), "all eight rows render").toHaveLength(8);
    let checked = 0;
    for (const m of MOCKUP) {
      const row = rowOf(markup, m.s.id);
      expect(textOfMarkup(findOne(row, "deal-chip").outer), `${m.s.name}: chip`).toBe(m.chip);
      expect(textOfMarkup(findOne(row, "sponsor-row-sub").outer), `${m.s.name}: sub-line`).toBe(m.sub);
      expect(textOfMarkup(findOne(row, "sponsor-row-clicks").outer), `${m.s.name}: clicks`).toBe(String(MOCKUP_CLICKS[m.s.id]));
      const actions = findAll(row, "sponsor-row-action");
      if (m.action === null) {
        expect(actions, `${m.s.name}: no button`).toHaveLength(0);
      } else {
        expect(actions, `${m.s.name}: exactly one button`).toHaveLength(1);
        expect(attrOf(actions[0]!.open, "data-action"), `${m.s.name}: which action`).toBe(m.action[0]);
        expect(textOfMarkup(actions[0]!.outer), `${m.s.name}: its words`).toBe(m.action[1]);
      }
      checked++;
    }
    expect(checked).toBe(8);
    const withAction = MOCKUP.filter((m) => m.action !== null).length;
    expect(withAction, "six rows offer an action; the two live rows do not").toBe(6);
    expect(findAll(markup, "sponsor-row-action"), "and no row offers more than one").toHaveLength(withAction);
  });

  it("a draft row opens the deal and never offers Send invoice; a scheduled one opens it too (precedence, F15)", () => {
    const draft = rowOf(listHtml(ROWS), "s6");
    expect(textOfMarkup(draft)).not.toContain("Send invoice");
    const scheduled = sponsor({
      id: "s9", name: "Quayside Chandlers", status: "inactive",
      deal: deal({ id: "d9", sponsor_id: "s9", deal_status: "scheduled", payment_status: "pending", payment_method: "online" }),
    });
    const action = findOne(rowOf(listHtml([scheduled]), "s9"), "sponsor-row-action");
    expect(attrOf(action.open, "data-action")).toBe("open_deal");
  });

  it("Open deal navigates (a link to the deal); Add deal and the three writes are buttons (Add deal opens the sheet)", () => {
    const markup = listHtml(ROWS);
    const open = findOne(rowOf(markup, "s6"), "sponsor-row-action");
    expect(open.open.startsWith("<a "), "a link").toBe(true);
    expect(attrOf(open.open, "href")).toBe(`/o/${SLUG}/sponsors?tab=sponsors&sponsor=s6&deal=d6`);
    // Both rows whose action is Add deal (a sponsor with no deal, and one whose deal ended).
    for (const id of ["s7", "s8"]) {
      const add = findOne(rowOf(markup, id), "sponsor-row-action");
      expect(attrOf(add.open, "data-action"), id).toBe("add_deal");
      expect(add.open.startsWith("<button "), `${id}: Add deal is a button`).toBe(true);
      expect(attrOf(add.open, "href"), `${id}: no href to follow`).toBeUndefined();
    }
    for (const id of ["s2", "s3", "s4"]) {
      const button = findOne(rowOf(markup, id), "sponsor-row-action");
      expect(button.open.startsWith("<button "), `${id}: a button`).toBe(true);
      expect(attrOf(button.open, "type")).toBe("button");
    }
  });

  it("an action is named for its sponsor to a screen reader, and the name starts with the words on the button (label in name)", () => {
    const markup = listHtml(ROWS);
    const resend = findOne(rowOf(markup, "s2"), "sponsor-row-action");
    expect(attrOf(resend.open, "aria-label")).toBe("Resend invoice: Ridge Gold Physiotherapy");
    const approve = findOne(rowOf(markup, "s3"), "sponsor-row-action");
    expect(attrOf(approve.open, "aria-label")).toBe("Approve: Quay Fisheries");
  });

  it("every action is disabled while a write is in flight (busy), links excepted", () => {
    const markup = listHtml(ROWS, { busy: true });
    for (const id of ["s2", "s3", "s4", "s7", "s8"]) {
      expect(attrOf(findOne(rowOf(markup, id), "sponsor-row-action").open, "disabled"), id).toBe("");
    }
    expect(attrOf(findOne(rowOf(listHtml(ROWS, { busy: false }), "s2"), "sponsor-row-action").open, "disabled")).toBeUndefined();
  });
});

describe("the empty case, and the plan without tiers", () => {
  it("no sponsors: the empty-state copy, and no list at all", () => {
    const markup = listHtml([]);
    expect(textOfMarkup(markup)).toBe("No sponsors yet. They'll appear on your public pages as soon as you add one.");
    expect(markup).not.toContain("<ul");
    expect(findAll(markup, "sponsor-row")).toHaveLength(0);
  });

  it("a viewer with no sponsors reads the same words", () => {
    expect(textOfMarkup(listHtml([], { canEdit: false }))).toBe("No sponsors yet. They'll appear on your public pages as soon as you add one.");
  });

  it("without tiers: one flat list, no group headers, even for a gold deal (all eight rows still there)", () => {
    const markup = listHtml(ROWS, { hasTiers: false });
    expect(findAll(markup, "sponsor-group")).toHaveLength(0);
    expect(findAll(markup, "sponsor-group-header")).toHaveLength(0);
    expect(markup.match(/<ul\b/g)).toHaveLength(1);
    expect(findAll(markup, "sponsor-row")).toHaveLength(8);
  });
});

describe("rows group by the deal's tier, in SPONSOR_TIERS order (spec §6.1, mockup screen 1)", () => {
  it("the mockup's groups: Title 1, Gold 1, Silver 2, Partner 4, each row under its own deal's tier (8 checked)", () => {
    const markup = listHtml(ROWS);
    const groups = findAll(markup, "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual([...SPONSOR_TIERS]);
    expect(groups.map((g) => textOfMarkup(findOne(g.outer, "sponsor-group-header").outer))).toEqual(["Title 1", "Gold 1", "Silver 2", "Partner 4"]);
    let checked = 0;
    for (const g of groups) {
      const tier = attrOf(g.open, "data-tier");
      const ids = findAll(g.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"));
      expect(ids, tier).toEqual(MOCKUP.filter((m) => m.group === tier).map((m) => m.s.id));
      checked += ids.length;
    }
    expect(checked).toBe(8);
  });

  it("a pending gold deal on a partner sponsor sits in Gold - the sponsor's own tier is not the group", () => {
    const ridge = ROWS.find((r) => r.id === "s2")!;
    expect(ridge.tier, "premise: the sponsor row itself says partner").toBe("partner");
    const gold = findAll(listHtml(ROWS), "sponsor-group").find((g) => attrOf(g.open, "data-tier") === "gold")!;
    expect(findAll(gold.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["s2"]);
  });

  it("a sponsor with no deal sits under its own tier; a group nobody is in is not drawn (the empty case of a group)", () => {
    const only = sponsor({ id: "s10", name: "Plain Sponsor", tier: "silver", deal: null });
    const groups = findAll(listHtml([only]), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["silver"]);
  });
});

describe("what a row says about itself", () => {
  it("the sub-line's date is read in the viewer's zone (tz), not the server's - the same instant is the 28th in UTC and the 29th in London (both checked)", () => {
    const late = sponsor({
      id: "s11", name: "Late Sender", status: "inactive", has_open_deal: true,
      deal: deal({ id: "d11", sponsor_id: "s11", deal_status: "awaiting_payment", payment_status: "pending", package_name: "Gold Season", tier: "gold", amount_cents: 60_000, invoice_sent_at: "2026-08-28T23:30:00.000Z" }),
    });
    const sub = (tz: string) => textOfMarkup(findOne(rowOf(listHtml([late], { tz }), "s11"), "sponsor-row-sub").outer);
    // 23:30 UTC on 28 Aug is 00:30 on the 29th in London (BST, UTC+1, until 25 Oct). August, not September: ICU spells en-GB's
    // September "Sept", and what is asserted here is the day, not that spelling.
    expect(sub("UTC")).toBe("Gold Season · £600 · Online invoice sent 28 Aug");
    expect(sub("Europe/London")).toBe("Gold Season · £600 · Online invoice sent 29 Aug");
  });

  it("a price with pence keeps them; a whole amount does not (both checked)", () => {
    const priced = (cents: number) =>
      sponsor({ id: "s12", name: "Priced", deal: deal({ id: "d12", sponsor_id: "s12", amount_cents: cents, competition_id: null }) });
    const sub = (cents: number) => textOfMarkup(findOne(rowOf(listHtml([priced(cents)]), "s12"), "sponsor-row-sub").outer);
    expect(sub(12_050)).toBe("Partner · £120.50 · All competitions");
    expect(sub(12_000)).toBe("Partner · £120 · All competitions");
  });

  it("a live deal scoped to the whole org names 'All competitions' (one competition's name is the mockup rows above)", () => {
    const wide = sponsor({ id: "s13", name: "Wide", deal: deal({ id: "d13", sponsor_id: "s13", competition_id: null }) });
    expect(textOfMarkup(findOne(rowOf(listHtml([wide]), "s13"), "sponsor-row-sub").outer)).toBe("Partner · £120 · All competitions");
  });

  it("the dispute and package badges ride on the name as before (3 checked)", () => {
    const lost = sponsor({ id: "s14", name: "Lost One", dispute_lost: true });
    const parked = sponsor({ id: "s15", name: "Parked One", dispute_parked: true });
    const paid = sponsor({ id: "s16", name: "Paid One", paid_order_id: "o1" });
    const markup = listHtml([lost, parked, paid]);
    const name = (id: string) => textOfMarkup(findOne(rowOf(markup, id), "sponsor-row-name").outer);
    expect(name("s14")).toBe("Lost One Dispute lost");
    expect(name("s15")).toBe("Parked One Disputed — parked");
    expect(name("s16")).toBe("Paid One Paid");
  });

  it("the clicks count keeps its words for a screen reader", () => {
    const markup = listHtml(ROWS);
    const clicks = findOne(rowOf(markup, "s1"), "sponsor-row-clicks");
    expect(attrOf(clicks.open, "aria-label")).toBe("41 clicks");
    expect(textOfMarkup(clicks.outer)).toBe("41");
  });
});

describe("a 43-character name truncates, and every ancestor can shrink (phone composition, AGENTS.md)", () => {
  it("the name is `truncate`, and its wrappers up to the grid carry min-w-0 (the 43-character name)", () => {
    expect(LONG_NAME.length, "premise: the realistic name").toBe(43);
    const row = rowOf(listHtml(ROWS), "s1");
    const name = findOne(row, "sponsor-row-name");
    expect(classTokens(name.open), "the name line can shrink").toContain("min-w-0");
    expect(classTokens(findOne(name.outer, "sponsor-row-name-text").open)).toContain("truncate");
    expect(classTokens(findOne(row, "sponsor-row-main").open), "the column holding name and sub-line").toContain("min-w-0");
    expect(classTokens(findOne(row, "sponsor-row-sub").open), "the sub-line truncates too").toContain("truncate");
    // The grid's own column is `minmax(0,1fr)`: a bare `1fr` would not shrink below the name.
    expect(attrOf(findOne(row, "sponsor-row-grid").open, "class")).toContain("minmax(0,1fr)");
  });

  it("a badge wraps under the name instead of squeezing it: the name line wraps and the name may fill a line (seen at 320: 'O...' beside 'Disputed - parked')", () => {
    const parked = sponsor({
      id: "s13", name: "Old Anchor Café", dispute_parked: true,
      deal: deal({ id: "d13", sponsor_id: "s13", payment_status: "none", payment_method: "complimentary" }),
    });
    const line = findOne(rowOf(listHtml([parked]), "s13"), "sponsor-row-name");
    expect(textOfMarkup(line.outer), "premise: the badge is on the name line").toContain(msg("sponsors.parkedBadge"));
    expect(classTokens(line.open), "the line wraps").toContain("flex-wrap");
    const text = classTokens(findOne(line.outer, "sponsor-row-name-text").open);
    expect(text, "the name can take a whole line").toContain("max-w-full");
    expect(text, "and still truncates there").toContain("truncate");
  });
});

describe("below md the clicks and the edit, move and delete controls fold behind a 44px ⋯ (spec §6.1, mockup screen 1)", () => {
  const CONTROLS = (name: string) => [
    msg("sponsors.edit", { name }),
    msg("settings.org.sponsors.moveUp", { name }),
    msg("settings.org.sponsors.moveDown", { name }),
    msg("settings.org.sponsors.remove", { name }),
  ];

  it("each control exists ONCE in a row, the tray is hidden below md until opened, and shows when opened (closed and open both checked)", () => {
    let checked = 0;
    for (const open of [false, true]) {
      const markup = listHtml(ROWS, { moreOpenId: open ? "s1" : null });
      const row = rowOf(markup, "s1");
      for (const label of CONTROLS(LONG_NAME)) {
        expect(row.split(`aria-label="${label}"`).length - 1, `${label} (open=${open})`).toBe(1);
        checked++;
      }
      expect(row.split('data-testid="sponsor-row-clicks"').length - 1, `clicks (open=${open})`).toBe(1);
      const tray = findOne(row, "sponsor-row-tools");
      expect(classTokens(tray.open).includes("max-md:hidden"), `the tray is hidden below md while closed (open=${open})`).toBe(!open);
      // The controls are INSIDE the tray (that is what folding them means), so hiding the tray hides all of them.
      for (const label of CONTROLS(LONG_NAME)) expect(tray.outer, label).toContain(`aria-label="${label}"`);
      expect(tray.outer).toContain('data-testid="sponsor-row-clicks"');
    }
    expect(checked, "4 controls x 2 states").toBe(8);
  });

  it("a row not opened keeps its own tray folded while another row's is open", () => {
    const markup = listHtml(ROWS, { moreOpenId: "s1" });
    expect(classTokens(findOne(rowOf(markup, "s1"), "sponsor-row-tools").open)).not.toContain("max-md:hidden");
    expect(classTokens(findOne(rowOf(markup, "s2"), "sponsor-row-tools").open)).toContain("max-md:hidden");
  });

  it("the ⋯ toggle: 'More for {name}', aria-expanded follows the state, aria-controls names the tray, md:hidden, a 44px target", () => {
    for (const open of [false, true]) {
      const row = rowOf(listHtml(ROWS, { moreOpenId: open ? "s1" : null }), "s1");
      const toggle = findOne(row, "sponsor-row-more");
      expect(attrOf(toggle.open, "aria-label")).toBe(`More for ${LONG_NAME}`);
      expect(attrOf(toggle.open, "aria-expanded")).toBe(open ? "true" : "false");
      expect(attrOf(toggle.open, "type")).toBe("button");
      const tray = findOne(row, "sponsor-row-tools");
      expect(attrOf(toggle.open, "aria-controls"), "points at an element that exists").toBe(attrOf(tray.open, "id"));
      expect(attrOf(tray.open, "id")).toBeTruthy();
      const tokens = classTokens(toggle.open);
      // `md:hidden` as a WHOLE token: the substring also sits inside `max-md:hidden`.
      expect(tokens, "gone from md up").toContain("md:hidden");
      expect(tokens, "44px wide").toContain("w-11");
      expect(tokens, "44px tall").toContain("h-11");
    }
  });

  it("tapping the toggle asks to open that row's tray (and the same tap closes it)", () => {
    const toggled: string[] = [];
    const tree = expandSponsorTree(<SponsorList {...listProps(ROWS, { onToggleMore: (id) => toggled.push(id) })} />);
    const toggle = tree.find((e) => propsOf(e)["aria-label"] === `More for ${LONG_NAME}`);
    expect(toggle, "premise: the toggle is in the tree").toBeDefined();
    (propsOf(toggle!).onClick as () => void)();
    expect(toggled).toEqual(["s1"]);
  });

  it("the tray's controls are 44px targets below md (the icon buttons grow on a phone)", () => {
    const tray = findOne(rowOf(listHtml(ROWS, { moreOpenId: "s1" }), "s1"), "sponsor-row-tools");
    const buttons = [...tray.outer.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length, "edit, up, down, delete").toBe(4);
    for (const b of buttons) {
      const tokens = classTokens(b);
      expect(tokens, b).toContain("max-md:h-11");
      expect(tokens, b).toContain("max-md:w-11");
    }
  });

  it("the action button is a 44px target below md too", () => {
    const action = findOne(rowOf(listHtml(ROWS), "s2"), "sponsor-row-action");
    expect(classTokens(action.open)).toContain("max-md:min-h-11");
  });
});

describe("a viewer reads the list and changes nothing (R19: 'a viewer gets the read-only view')", () => {
  it("no action, no ⋯, no edit / move / delete / Show on site again - and still the chip, the sub-line and the clicks (8 rows checked)", () => {
    const markup = listHtml(ROWS, { canEdit: false });
    let checked = 0;
    for (const m of MOCKUP) {
      const row = rowOf(markup, m.s.id);
      expect(findAll(row, "sponsor-row-action"), `${m.s.name}: no action`).toHaveLength(0);
      expect(findAll(row, "sponsor-row-more"), `${m.s.name}: no ⋯`).toHaveLength(0);
      expect(row, m.s.name).not.toContain("<button");
      expect(textOfMarkup(findOne(row, "deal-chip").outer), `${m.s.name}: the chip is still read`).toBe(m.chip);
      expect(textOfMarkup(findOne(row, "sponsor-row-sub").outer)).toBe(m.sub);
      expect(findAll(row, "sponsor-row-clicks"), `${m.s.name}: the clicks are still read`).toHaveLength(1);
      // Nothing folded: with no controls to fold, the clicks are not hidden behind a toggle that does not exist.
      expect(classTokens(findOne(row, "sponsor-row-tools").open), m.s.name).not.toContain("max-md:hidden");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the editor sees the same rows WITH their actions (the pair)", () => {
    const markup = listHtml(ROWS, { canEdit: true });
    expect(findAll(markup, "sponsor-row-action")).toHaveLength(6);
    expect(findAll(markup, "sponsor-row-more")).toHaveLength(8);
  });
});

describe("Show on site again is NOT on the list any more: it moved to the sponsor's page (Task 15, spec §10.3)", () => {
  // One home, never two copies that can disagree. The pair that proves it was not simply deleted is in sponsor-sheet.test.tsx: the
  // page offers it for the SAME rows, by the same predicate (`canShowAgain`).
  it("the rows that qualify (Northbank, Tidewell) carry no Show control on the list; their name links to the page that does", () => {
    const off = ROWS.filter((r) => canShowAgain(r));
    expect(off.map((r) => r.id), "premise: Northbank and Tidewell are the hidden rows nothing holds").toEqual(["s7", "s8"]);
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const r of off) {
      expect(findAll(markup, `sponsor-show-${r.id}`), `${r.id}: no Show on site again on the list`).toHaveLength(0);
      expect(attrOf(findOne(rowOf(markup, r.id), "sponsor-row-name-link").open, "href"), `${r.id}: the name opens the page`).toBe(
        `/o/${SLUG}/sponsors?tab=sponsors&sponsor=${r.id}`,
      );
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the row's name opens the sponsor's own page (Task 15)", () => {
  it("every row's name is ONE link to its sponsor's page, the text still truncates, and a phone's tap area is 44px (8 rows checked)", () => {
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(markup, r.id);
      const links = findAll(row, "sponsor-row-name-link");
      expect(links, `${r.id}: exactly one name link`).toHaveLength(1);
      expect(attrOf(links[0]!.open, "href"), r.id).toBe(`/o/${SLUG}/sponsors?tab=sponsors&sponsor=${r.id}`);
      expect(textOfMarkup(links[0]!.outer), `${r.id}: the link's words are the name, nothing else`).toBe(r.name);
      const link = classTokens(links[0]!.open);
      expect(link, `${r.id}: the link can shrink`).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
      // A 20px line of text is not a 44px target: the padding grows the tap area below md and the negative margin takes the space back.
      expect(link, `${r.id}: phone tap area`).toEqual(expect.arrayContaining(["max-md:py-3", "max-md:-my-3"]));
      // The padding overlaps the sub-line below it; a later sibling paints (and hit-tests) on top unless the link is lifted.
      expect(link, `${r.id}: lifted above the sub-line its padding overlaps`).toEqual(expect.arrayContaining(["relative", "z-[1]"]));
      expect(classTokens(findOne(links[0]!.outer, "sponsor-row-name-text").open), `${r.id}: the text truncates`).toContain("truncate");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("a viewer's name is a link too (the page is read-only for them)", () => {
    expect(findAll(listHtml(ROWS, { canEdit: false }), "sponsor-row-name-link")).toHaveLength(8);
  });
});

describe("Edit swaps the row for the editor the parent builds", () => {
  it("the editing row renders what renderEditor returns, in place of its content; the others stay rows", () => {
    const markup = renderToStaticMarkup(
      <SponsorList {...listProps(ROWS, { editingId: "s7", renderEditor: (s) => <p data-testid="editor-stub">{`editing ${s.name}`}</p> })} />,
    );
    expect(textOfMarkup(findOne(rowOf(markup, "s7"), "editor-stub").outer)).toBe("editing Northbank Print");
    expect(findAll(rowOf(markup, "s7"), "deal-chip"), "the chip is replaced with the row").toHaveLength(0);
    expect(findAll(markup, "deal-chip")).toHaveLength(7);
  });
});

describe("Move: the first and last row of a GROUP cannot move further", () => {
  it("up is disabled on the first row of a group and down on the last (Silver: Quay is first, Marlow last)", () => {
    const markup = listHtml(ROWS);
    const dis = (id: string, key: "moveUp" | "moveDown", name: string) => {
      const label = msg(`settings.org.sponsors.${key}`, { name });
      const tag = [...rowOf(markup, id).matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((b) => attrOf(b, "aria-label") === label)!;
      return attrOf(tag, "disabled") !== undefined;
    };
    expect(dis("s3", "moveUp", "Quay Fisheries")).toBe(true);
    expect(dis("s3", "moveDown", "Quay Fisheries")).toBe(false);
    expect(dis("s4", "moveUp", "Marlow & Daughters Bakery")).toBe(false);
    expect(dis("s4", "moveDown", "Marlow & Daughters Bakery")).toBe(true);
  });
});

describe("Move: neighbours in one group swap only when they share a STORED tier (the server orders by it - review I1)", () => {
  // Server order is stored tier, then display_order: a native gold sponsor sorts before a PARTNER sponsor whose pending deal is gold,
  // though both are drawn in Gold. G1 and G2 are native gold; P is the partner with the gold deal.
  const G1 = sponsor({ id: "g1", name: "Native Gold One", tier: "gold", display_order: 0 });
  const G2 = sponsor({ id: "g2", name: "Native Gold Two", tier: "gold", display_order: 1 });
  const P = sponsor({
    id: "p1", name: "Partner With Gold Deal", tier: "partner", display_order: 0, status: "inactive", has_open_deal: true,
    deal: deal({ id: "dp1", sponsor_id: "p1", deal_status: "awaiting_payment", payment_status: "pending", tier: "gold", package_name: "Gold Season" }),
  });
  const MIXED = [G1, G2, P];
  const disabled = (markup: string, id: string, key: "moveUp" | "moveDown", name: string): boolean => {
    const label = msg(`settings.org.sponsors.${key}`, { name });
    const tag = [...rowOf(markup, id).matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((b) => attrOf(b, "aria-label") === label);
    if (!tag) throw new Error(`no ${key} for ${name}`);
    return attrOf(tag, "disabled") !== undefined;
  };

  it("premise: all three are drawn in ONE group (Gold), in the server's order", () => {
    const groups = findAll(listHtml(MIXED), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["gold"]);
    expect(findAll(groups[0]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["g1", "g2", "p1"]);
  });

  it("the arrows between a native gold and the partner with a gold deal are disabled; the arrows between two native golds are not (4 checked)", () => {
    const markup = listHtml(MIXED);
    expect(disabled(markup, "g1", "moveDown", G1.name), "G1 down: its neighbour G2 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveUp", G2.name), "G2 up: its neighbour G1 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveDown", G2.name), "G2 down: its neighbour P is stored partner").toBe(true);
    expect(disabled(markup, "p1", "moveUp", P.name), "P up: its neighbour G2 is stored gold").toBe(true);
  });

  it("a call that gets past the disabled arrow still sends no reorder; the legal swap beside it does send one", async () => {
    const m = mount(MIXED);
    m.click(msg("settings.org.sponsors.moveDown", { name: G2.name }));
    m.click(msg("settings.org.sponsors.moveUp", { name: P.name }));
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/sponsors/reorder")), "no reorder was sent across stored tiers").toHaveLength(0);
    // The pair: the same call between two native golds is a real reorder.
    m.click(msg("settings.org.sponsors.moveDown", { name: G1.name }));
    await flush();
    const reorder = calls.filter((c) => c.url.endsWith("/sponsors/reorder"));
    expect(reorder).toHaveLength(1);
    expect(reorder[0]!.body).toEqual({ ids: ["g2", "g1", "p1"] });
  });

  it("without tiers (one flat list) the same rule holds: a stored-tier boundary is not crossed", async () => {
    const m = mount(MIXED, { hasTiers: false });
    m.click(msg("settings.org.sponsors.moveDown", { name: G2.name }));
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/sponsors/reorder"))).toHaveLength(0);
  });
});

describe("Move: two rows drawn side by side in a group may sit APART in the stored order (the display_order gap; T14 re-review)", () => {
  // All three are STORED gold, in the server's order X (0), B (5), Z (9). B has a SILVER deal, so it is drawn in Silver, and the Gold
  // group is [X, Z]: neighbours on screen with B between them in the stored list. They share a stored tier, so they CAN swap - the swap
  // exchanges their two positions in the whole list and leaves B where it is.
  const X = sponsor({ id: "x", name: "Gold X", tier: "gold", display_order: 0 });
  const B = sponsor({
    id: "b", name: "Gold B With Silver Deal", tier: "gold", display_order: 5, status: "inactive", has_open_deal: true,
    deal: deal({ id: "db", sponsor_id: "b", deal_status: "awaiting_payment", payment_status: "pending", tier: "silver", package_name: "Silver Season" }),
  });
  const Z = sponsor({ id: "z", name: "Gold Z", tier: "gold", display_order: 9 });
  const GAP = [X, B, Z];
  /** Is the arrow ENABLED? */
  const enabled = (markup: string, id: string, key: "moveUp" | "moveDown", name: string): boolean => {
    const label = msg(`settings.org.sponsors.${key}`, { name });
    const tag = [...rowOf(markup, id).matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((b) => attrOf(b, "aria-label") === label);
    if (!tag) throw new Error(`no ${key} for ${name}`);
    return attrOf(tag, "disabled") === undefined;
  };

  it("premise: X and Z are drawn together in Gold while B sits alone in Silver, and the stored order has a gap between X and Z", () => {
    const groups = findAll(listHtml(GAP), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["gold", "silver"]);
    expect(findAll(groups[0]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["x", "z"]);
    expect(findAll(groups[1]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["b"]);
    expect(GAP.map((s) => s.display_order), "the stored order: X, then B, then Z").toEqual([0, 5, 9]);
  });

  it("X can move down and Z can move up; every other arrow is disabled - B's both included (6 checked)", () => {
    const markup = listHtml(GAP);
    expect(enabled(markup, "x", "moveDown", X.name), "X down: its drawn neighbour Z shares the stored tier").toBe(true);
    expect(enabled(markup, "z", "moveUp", Z.name), "Z up: its drawn neighbour X shares the stored tier").toBe(true);
    expect(enabled(markup, "x", "moveUp", X.name), "X is first in Gold").toBe(false);
    expect(enabled(markup, "z", "moveDown", Z.name), "Z is last in Gold").toBe(false);
    expect(enabled(markup, "b", "moveUp", B.name), "B up: alone in Silver").toBe(false);
    expect(enabled(markup, "b", "moveDown", B.name), "B down: alone in Silver").toBe(false);
  });

  it("X down posts the whole order with X and Z exchanged and B left in the middle: ids [z, b, x]", async () => {
    const m = mount(GAP);
    m.click(msg("settings.org.sponsors.moveDown", { name: X.name }));
    await flush();
    const reorder = calls.filter((c) => c.url.endsWith("/sponsors/reorder"));
    expect(reorder).toHaveLength(1);
    expect(reorder[0]!.body).toEqual({ ids: ["z", "b", "x"] });
  });

  it("B's arrows send nothing even when called past the disabled button (it has no neighbour to swap with)", async () => {
    const m = mount(GAP);
    m.click(msg("settings.org.sponsors.moveUp", { name: B.name }));
    m.click(msg("settings.org.sponsors.moveDown", { name: B.name }));
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/sponsors/reorder"))).toHaveLength(0);
  });
});

// --- the island: the writes the actions make ---------------------------------------------------------------------------------------

const HUB: SponsorsHubData = {
  orgSlug: SLUG, deals: [], packages: [], hasMonetize: true, monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [],
  chargesEnabled: true, sponsorId: null, dealId: null, reportLinks: [], reportDefaults: null,
};

const fetchMock = vi.fn();
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let answer: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { data: [] } });

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ status: 200, body: { data: [] } });
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

function mount(rows: SponsorItem[], opts: { canEdit?: boolean; hasTiers?: boolean; hub?: SponsorsHubData } = {}) {
  const island = renderIsland(
    OrgSponsors,
    {
      orgId: ORG, initialSponsors: rows, competitions: COMPS, hasTiers: opts.hasTiers ?? true, billingHref: "/billing",
      canEdit: opts.canEdit ?? true, hub: opts.hub ?? HUB,
    },
    expandSponsorTree,
  );
  const byLabel = (label: string): ReactElement => {
    const el = island.tree().find((e) => propsOf(e)["aria-label"] === label);
    if (!el) throw new Error(`no control labelled "${label}"`);
    return el;
  };
  return { island, byLabel, click: (label: string) => (propsOf(byLabel(label)).onClick as () => void)(), text: () => flat(island.text()) };
}

const POSTS = () => calls.filter((c) => c.method === "POST").map((c) => c.url);

describe("the three row actions call the deal routes (Tasks 6 and 7), then re-read the list", () => {
  it("Resend invoice POSTs the deal's send-invoice, once, and says so (L9)", async () => {
    const m = mount(ROWS);
    m.click("Resend invoice: Ridge Gold Physiotherapy");
    await flush();
    expect(POSTS()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals/d2/send-invoice`]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url), "the list is re-read").toEqual([`/api/v1/orgs/${ORG}/sponsors`]);
    expect(m.text(), "the row changes nothing visible, so the page says it was sent").toContain("Invoice sent again for Ridge Gold Physiotherapy.");
  });

  it("Mark as paid POSTs the deal's mark-paid and Approve its approve (2 checked), each with no notice", async () => {
    const CASES: [string, string, string][] = [
      ["Mark as paid: Marlow & Daughters Bakery", "d4", "mark-paid"],
      ["Approve: Quay Fisheries", "d3", "approve"],
    ];
    let checked = 0;
    for (const [label, dealId, route] of CASES) {
      calls.length = 0;
      const m = mount(ROWS);
      m.click(label);
      await flush();
      expect(POSTS(), label).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals/${dealId}/${route}`]);
      expect(m.text(), label).not.toContain("Invoice sent again");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Mark as paid asks first, naming the amount and the sponsor; cancelled, nothing is sent (the negative)", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const m = mount(ROWS);
    m.click("Mark as paid: Marlow & Daughters Bakery");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; tone?: string };
    // The words are the controller's: "Record £X from {sponsor} as received?" - Marlow's deal is £300.
    expect(asked.title).toBe("Record £300 from Marlow & Daughters Bakery as received?");
    expect(asked.body).toContain("go-live rule");
    expect(asked.confirmLabel, "the button says what it does").toBe("Mark as paid");
    expect(asked.tone).toBe("default");
    expect(POSTS(), "cancelled: no POST").toEqual([]);
    expect(calls, "cancelled: nothing was sent or re-read").toEqual([]);
    expect(m.text(), "and no error or notice appears").not.toContain("Invoice sent again");
  });

  it("Mark as paid, confirmed, sends exactly one POST (the pair), and Approve and Resend invoice ask nothing", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: ROWS } } : { status: 200, body: { data: {} } });
    const m = mount(ROWS);
    m.click("Mark as paid: Marlow & Daughters Bakery");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(POSTS()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals/d4/mark-paid`]);
    confirmMock.mockClear();
    calls.length = 0;
    m.click("Approve: Quay Fisheries");
    m.click("Resend invoice: Ridge Gold Physiotherapy");
    await flush();
    expect(confirmMock, "Approve is one tap (End now reverses it); Resend is harmless").not.toHaveBeenCalled();
    expect(POSTS()).toEqual([
      `/api/v1/orgs/${ORG}/sponsor-deals/d3/approve`,
      `/api/v1/orgs/${ORG}/sponsor-deals/d2/send-invoice`,
    ]);
  });

  it("the sentence shows the amount the row shows - pence kept, in the sponsor's own currency", async () => {
    const priced = sponsor({
      id: "s20", name: "Euro Cafe", status: "inactive", has_open_deal: true,
      deal: deal({ id: "d20", sponsor_id: "s20", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", amount_cents: 12_050, currency: "eur" }),
    });
    confirmMock.mockResolvedValueOnce(false);
    const m = mount([priced]);
    m.click("Mark as paid: Euro Cafe");
    await flush();
    expect((confirmMock.mock.calls[0]![0] as { title: string }).title).toBe("Record €120.50 from Euro Cafe as received?");
  });

  it("a refused Resend reads the resend words for its code, never the server's English - and the list is still re-read (L10)", async () => {
    const SERVER = "the sponsor's own payment is already on its way";
    answer = (url, method) =>
      method === "POST"
        ? { status: 409, body: { ok: false, error: { code: "deal_paid_online", message: SERVER } } }
        : { status: 200, body: { data: [] } };
    const m = mount(ROWS);
    m.click("Resend invoice: Ridge Gold Physiotherapy");
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.resendPaidOnline"));
    expect(m.text()).not.toContain(SERVER);
    expect(m.text(), "no 'sent' notice on a refusal").not.toContain("Invoice sent again");
    expect(calls.filter((c) => c.method === "GET"), "a refusal means the deal moved: re-read").toHaveLength(1);
  });

  it("a refused Approve reads the shared words (the pair to the resend-specific ones)", async () => {
    answer = (url, method) =>
      method === "POST"
        ? { status: 409, body: { ok: false, error: { code: "deal_not_awaiting_approval", message: "server english" } } }
        : { status: 200, body: { data: [] } };
    const m = mount(ROWS);
    m.click("Approve: Quay Fisheries");
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.notAwaitingApproval"));
    expect(m.text()).not.toContain("server english");
  });

  it("a viewer's island has none of them to click", () => {
    const m = mount(ROWS, { canEdit: false });
    expect(() => m.byLabel("Approve: Quay Fisheries")).toThrow(/no control labelled/);
    expect(() => m.byLabel("Resend invoice: Ridge Gold Physiotherapy")).toThrow(/no control labelled/);
  });
});

describe("the status line is one live region that is always mounted, so only its text changes (review m4)", () => {
  const statusEls = (m: ReturnType<typeof mount>) => m.island.tree().filter((e) => propsOf(e).role === "status");

  it("it is there, empty, before any write; after Resend invoice it is the SAME one region carrying the words", async () => {
    const m = mount(ROWS);
    const before = statusEls(m);
    expect(before, "exactly one status region before anything happens").toHaveLength(1);
    expect(propsOf(before[0]!)["data-testid"]).toBe("sponsor-notice");
    expect(propsOf(before[0]!).children, "empty: no text yet").toBeFalsy();
    m.click("Resend invoice: Ridge Gold Physiotherapy");
    await flush();
    const after = statusEls(m);
    expect(after, "still exactly one region").toHaveLength(1);
    expect(propsOf(after[0]!).children).toBe("Invoice sent again for Ridge Gold Physiotherapy.");
  });

  it("the next write clears the words (the region stays)", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: ROWS } } : { status: 200, body: { data: {} } });
    const m = mount(ROWS);
    m.click("Resend invoice: Ridge Gold Physiotherapy");
    await flush();
    expect(propsOf(statusEls(m)[0]!).children).toBeTruthy();
    m.click("Approve: Quay Fisheries");
    await flush();
    expect(statusEls(m)).toHaveLength(1);
    expect(propsOf(statusEls(m)[0]!).children, "a different write: the old sentence is gone").toBeFalsy();
  });
});

describe("Edit does not leave the row's ⋯ tray open behind it (review m3)", () => {
  it("open ⋯, Edit, Cancel: the editor is gone and the tray is closed again", () => {
    const m = mount(ROWS);
    const list = () => propsOf(m.island.tree().find((e) => e.type === SponsorList)!);
    const trayOf = (id: string) => m.island.tree().find((e) => propsOf(e).id === `sponsor-tools-${id}`);
    const more = m.island.tree().find((e) => e.type === SponsorRowMore && propsOf(e).name === "Ridge Gold Physiotherapy")!;
    (propsOf(more).onToggle as () => void)();
    expect(list().moreOpenId, "premise: the ⋯ is open").toBe("s2");
    expect(classTokens(`<div class="${propsOf(trayOf("s2")!).className as string}">`), "premise: the tray shows").not.toContain("max-md:hidden");

    m.click(msg("sponsors.edit", { name: "Ridge Gold Physiotherapy" }));
    expect(list().editingId, "premise: the row is being edited").toBe("s2");
    expect(list().moreOpenId, "the open state does not ride along into the editor").toBeNull();

    const form = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined)!;
    (propsOf(form).onCancel as () => void)();
    expect(list().editingId).toBeNull();
    expect(classTokens(`<div class="${propsOf(trayOf("s2")!).className as string}">`), "after Cancel the tray is folded again").toContain("max-md:hidden");
  });
});

describe("Move reorders within the GROUP the row is drawn in (the deal's tier), and persists the global order", () => {
  it("moving Marlow up swaps it with Quay (both in Silver) and POSTs the whole order with them swapped", async () => {
    const m = mount(ROWS);
    m.click(msg("settings.org.sponsors.moveUp", { name: "Marlow & Daughters Bakery" }));
    await flush();
    const reorder = calls.find((c) => c.url === `/api/v1/orgs/${ORG}/sponsors/reorder`);
    expect(reorder?.body).toEqual({ ids: ["s1", "s2", "s4", "s3", "s5", "s6", "s7", "s8"] });
  });

  it("a partner sponsor with a pending gold deal is alone in Gold: it cannot move, and no other row is swapped with it", async () => {
    const m = mount(ROWS);
    const up = m.byLabel(msg("settings.org.sponsors.moveUp", { name: "Ridge Gold Physiotherapy" }));
    expect(propsOf(up).disabled, "first and last of its group").toBe(true);
    const down = m.byLabel(msg("settings.org.sponsors.moveDown", { name: "Ridge Gold Physiotherapy" }));
    expect(propsOf(down).disabled).toBe(true);
  });
});

describe("Add a sponsor asks for a name, a logo and a link - and nothing else (spec §6.1)", () => {
  it("the add form shows no tier and no competition select, on a plan WITH tiers, and says why (the hint)", () => {
    const m = mount([], { hasTiers: true });
    const add = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel === undefined);
    expect(add, "premise: the add form is on the page").toBeDefined();
    const markup = renderToStaticMarkup(add!);
    expect(markup).not.toContain("<select");
    expect(markup).toContain(msg("settings.org.sponsors.name"));
    expect(markup).toContain(msg("settings.org.sponsors.link"));
    expect(markup).toContain(msg("sponsors.logoLabel"));
    expect(m.text()).toContain("Name, logo and link. Add a deal afterwards to set their tier and where they show.");
  });

  it("Add sponsor POSTs the name and link with the partner tier - no tier or competition is chosen here", async () => {
    answer = (url, method) => (method === "POST" ? { status: 201, body: { data: {} } } : { status: 200, body: { data: [] } });
    const m = mount([], { hasTiers: true });
    const add = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel === undefined)!;
    (propsOf(add).onChange as (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void)((p) => ({ ...p, name: "New Sponsor", url: "new.example" }));
    const add2 = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel === undefined)!;
    (propsOf(add2).onSubmit as () => void)();
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`/api/v1/orgs/${ORG}/sponsors`);
    expect(post?.body).toEqual({ name: "New Sponsor", url: "https://new.example", tier: "partner" });
  });

  it("the EDIT form still offers the tier and competition (where a sponsor with no deal is placed by hand) - the pair", () => {
    const markup = renderToStaticMarkup(
      <SponsorForm
        value={{ name: "N", url: "", tier: "gold", competition_id: "", file: null, preview: null }}
        onChange={noop} onSubmit={noop} onCancel={noop} submitLabel="Save" busy={false} hasTiers showPlacement lockedByDeal={false}
        competitions={COMPS} onPickLogo={noop}
      />,
    );
    expect(markup.match(/<select\b/g)).toHaveLength(2);
  });
});

// --- the copy --------------------------------------------------------------------------------------------------------------------

describe("the new copy exists in all four locales, with its placeholders intact", () => {
  const KEYS: [MessageKey, string[]][] = [
    ["sponsors.deal.action.addDeal", []],
    ["sponsors.deal.action.openDeal", []],
    ["sponsors.deal.action.resendInvoice", []],
    ["sponsors.deal.action.markPaid", []],
    ["sponsors.deal.action.approve", []],
    ["sponsors.deal.action.for", ["action", "name"]],
    ["sponsors.deal.subline.complimentary", []],
    ["sponsors.deal.subline.invoiceSent", ["date"]],
    ["sponsors.deal.subline.bankTransfer", []],
    ["sponsors.deal.subline.notSent", []],
    ["sponsors.deal.subline.paid", ["date"]],
    ["sponsors.deal.subline.ended", ["date"]],
    ["sponsors.deal.notice.invoiceResent", ["name"]],
    ["sponsors.deal.markPaid.title", ["amount", "name"]],
    ["sponsors.deal.markPaid.body", []],
    ["sponsors.list.more", ["name"]],
    ["sponsors.form.hint", []],
  ];
  const DICTS: Record<string, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };

  it("every key is a non-empty string in en / es / fr / nl and names the same {placeholders} in each (17 keys x 4 locales)", () => {
    expect(LOCALES.length, "premise: four locales").toBe(4);
    let checked = 0;
    for (const [key, vars] of KEYS) {
      for (const locale of LOCALES) {
        const words = DICTS[locale]![key];
        expect(typeof words === "string" && words.trim().length > 0, `${key} in ${locale}`).toBe(true);
        const named = [...words!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(named, `${key} in ${locale}`).toEqual([...vars].sort());
        checked++;
      }
    }
    expect(checked).toBe(68);
  });

  it("'deal' is the word in English: no 'order' sneaks into the new strings", () => {
    for (const [key] of KEYS) expect(uiEn[key as keyof typeof uiEn], key).not.toMatch(/\border\b/i);
  });

  it("the hint is the brief's sentence (English)", () => {
    expect(uiEn["sponsors.form.hint"]).toBe("Name, logo and link. Add a deal afterwards to set their tier and where they show.");
  });
});


// --- Add deal: the row's button opens the sheet, and the sheet makes the deal through the v1 route (Task 16) ---------------------------

describe("Add deal on a row opens the Add deal sheet for that sponsor; the sheet's create is the v1 POST, then a re-read", () => {
  const PACKAGE: SponsorPackageRow = {
    id: "p-gold", competition_id: null, name: "Gold Season", description: null, price_cents: 60_000, currency: "gbp", tier: "gold",
    active: true, created_at: "2026-10-01T09:00:00.000Z", includes_on_stream: true, used_by: 0,
  };
  // The three scope fields carry values no default could produce (an Event Pass org: not org-wide, one competition covered, another
  // finished), so a pass-through that dropped one - or read a constant - is caught by the value arriving.
  const HUB_WITH_PACKAGES: SponsorsHubData = {
    ...HUB, packages: [PACKAGE], hasMonetize: true, monetizeOrgWide: false, monetizeCompetitionIds: ["c-pass"], finishedCompetitionIds: ["c-done"],
    chargesEnabled: false,
  };
  const sheetsIn = (m: ReturnType<typeof mount>) => m.island.tree().filter((e) => e.type === AddDealSheet);
  const BODY: CreateDealBody = { package_id: "p-gold", competition_id: null, payment_method: "offline", go_live: "on_payment", end_current: false };

  it("no sheet until the button is tapped; then ONE, for that sponsor, handed the hub's packages and plan flags (every hub field it reads, counted)", () => {
    const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
    expect(sheetsIn(m), "premise: closed to begin with").toHaveLength(0);
    m.click("Add deal: Northbank Print");
    const sheets = sheetsIn(m);
    expect(sheets).toHaveLength(1);
    const p = propsOf(sheets[0]!);
    expect((p.sponsor as SponsorItem).id).toBe("s7");
    expect(p.packages, "hub.packages").toBe(HUB_WITH_PACKAGES.packages);
    expect(p.hasMonetize, "hub.hasMonetize").toBe(true);
    expect(p.monetizeOrgWide, "hub.monetizeOrgWide - false here: a pass org").toBe(false);
    expect(p.monetizeCompetitionIds, "hub.monetizeCompetitionIds").toBe(HUB_WITH_PACKAGES.monetizeCompetitionIds);
    expect(p.finishedCompetitionIds, "hub.finishedCompetitionIds").toBe(HUB_WITH_PACKAGES.finishedCompetitionIds);
    expect(p.chargesEnabled, "hub.chargesEnabled - false here, so Online is locked on the sheet").toBe(false);
    // The pairs: each flag is passed through as it is, not pinned (counted).
    let flags = 0;
    for (const hasMonetize of [true, false]) {
      for (const chargesEnabled of [true, false]) {
        const other = mount(ROWS, { hub: { ...HUB_WITH_PACKAGES, hasMonetize, chargesEnabled } });
        other.click("Add deal: Northbank Print");
        const q = propsOf(sheetsIn(other)[0]!);
        expect([q.hasMonetize, q.chargesEnabled], `monetize=${hasMonetize} charges=${chargesEnabled}`).toEqual([hasMonetize, chargesEnabled]);
        flags++;
      }
    }
    expect(flags).toBe(4);
    // The scope fields move with the hub too (an org-wide plan, nothing finished): the other value arrives, not the first one's.
    const wide = mount(ROWS, { hub: { ...HUB_WITH_PACKAGES, monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [] } });
    wide.click("Add deal: Northbank Print");
    const w = propsOf(sheetsIn(wide)[0]!);
    expect([w.monetizeOrgWide, w.monetizeCompetitionIds, w.finishedCompetitionIds]).toEqual([true, [], []]);
    const noTiers = mount(ROWS, { hub: HUB_WITH_PACKAGES, hasTiers: false });
    noTiers.click("Add deal: Northbank Print");
    expect(propsOf(sheetsIn(noTiers)[0]!).hasTiers, "hasTiers").toBe(false);
    expect(p.hasTiers).toBe(true);
    expect(p.orgSlug).toBe(SLUG);
    expect(p.deals, "the org's deals feed the 'already has one' confirm").toEqual(HUB_WITH_PACKAGES.deals);
    expect(p.competitions).toBe(COMPS);
    expect(POSTS(), "opening the sheet writes nothing").toEqual([]);
    expect(calls, "and reads nothing").toEqual([]);
    (p.onClose as () => void)();
    expect(sheetsIn(m), "closed again").toHaveLength(0);
  });

  it("onCreate POSTs the body as given to /sponsors/{id}/deals, re-reads the list and the deals, and says what happened (offline -> 'Deal saved')", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 201, body: { data: { deal: {}, checkout_url: null } } });
    const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
    m.click("Add deal: Northbank Print");
    await (propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>)(BODY);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: `/api/v1/orgs/${ORG}/sponsors/s7/deals`, method: "POST", body: BODY }]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url).sort()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals`, `/api/v1/orgs/${ORG}/sponsors`]);
    expect(m.text()).toContain("Deal saved for Northbank Print.");
  });

  it("an online deal says the invoice went out", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 201, body: { data: { deal: {}, checkout_url: "https://pay.example" } } });
    const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
    m.click("Add deal: Northbank Print");
    await (propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>)({ ...BODY, payment_method: "online", sponsor_email: "pay@northbank.example" });
    expect(m.text()).toContain("Invoice sent for Northbank Print.");
    expect(m.text()).not.toContain("Deal saved");
  });

  it("a refusal rejects (the sheet shows it, choices kept), leaves the sheet open, puts nothing on the page - and still re-reads", async () => {
    answer = (url, method) =>
      method === "POST" ? { status: 422, body: { ok: false, error: { code: "package_retired", message: "server english" } } } : { status: 200, body: { data: ROWS } };
    const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
    m.click("Add deal: Northbank Print");
    const onCreate = propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>;
    const err = await onCreate(BODY).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiV1Error);
    expect((err as ApiV1Error).code).toBe("package_retired");
    expect(sheetsIn(m), "still open").toHaveLength(1);
    expect(m.text()).not.toContain("server english");
    expect(m.text()).not.toContain(msg("sponsors.error.packageRetired"));
    expect(calls.filter((c) => c.method === "GET"), "a refusal can mean a deal moved: re-read both").toHaveLength(2);
  });

  it("an ONLINE Stripe refusal RESOLVES (the deal may be saved, so the sheet must close) and the page says it: Send for a draft, Resend for a deal that is live, 'look at the deals' when the current deal was being ended", async () => {
    answer = (url, method) =>
      method === "POST" ? { status: 502, body: { ok: false, error: { code: "stripe_unavailable", message: "server english" } } } : { status: 200, body: { data: ROWS } };
    // Expected words from the lifecycle table (a draft is sent, a live/scheduled deal is resent) and
    // the create's own Stripe calls.
    const CASES: Array<[string, Partial<CreateDealBody>, MessageKey]> = [
      ["on_payment, no end", { go_live: "on_payment" }, "sponsors.error.invoiceSavedNoLink"],
      ["on_approval, no end", { go_live: "on_approval" }, "sponsors.error.invoiceSavedNoLink"],
      ["immediate, no end", { go_live: "immediate" }, "sponsors.error.invoiceSavedResend"],
      ["immediate, ends the current deal", { go_live: "immediate", end_current: true }, "sponsors.error.invoiceNotSentCheck"],
      ["on_payment, ends the current deal", { go_live: "on_payment", end_current: true }, "sponsors.error.invoiceNotSentCheck"],
    ];
    let checked = 0;
    for (const [label, over, key] of CASES) {
      calls.length = 0;
      const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
      m.click("Add deal: Northbank Print");
      // RESOLVING is the signal the sheet closes on (the sheet itself closes after a resolved create: add-deal-sheet.test.tsx); a
      // rejection would keep it open over a deal that may already be saved.
      const err = await (propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>)({ ...BODY, payment_method: "online", sponsor_email: "a@b.example", ...over }).then(() => null, (e: unknown) => e);
      expect(err, `${label}: resolves`).toBeNull();
      expect(m.text(), label).toContain(msg(key));
      expect(m.text(), label).not.toContain("server english");
      expect(m.text(), `${label}: no success notice`).not.toContain("Invoice sent for");
      expect(calls.filter((c) => c.method === "GET"), `${label}: the saved draft shows on the re-read`).toHaveLength(2);
      checked++;
    }
    expect(checked).toBe(CASES.length);
    // The two sentences differ, or the Send/Resend split above proves nothing.
    expect(msg("sponsors.error.invoiceSavedResend")).not.toBe(msg("sponsors.error.invoiceSavedNoLink"));
  });

  it("a Stripe refusal of a create that sends NO invoice (offline or complimentary, ending the current deal) rejects: saved nothing, so the sheet stays open with its choices and the page says nothing", async () => {
    answer = (url, method) =>
      method === "POST" ? { status: 502, body: { ok: false, error: { code: "stripe_unavailable", message: "server english" } } } : { status: 200, body: { data: ROWS } };
    let checked = 0;
    for (const method of ["offline", "complimentary"] as const) {
      calls.length = 0;
      const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
      m.click("Add deal: Northbank Print");
      const onCreate = propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>;
      const err = await onCreate({ ...BODY, payment_method: method, go_live: "immediate", end_current: true }).then(() => null, (e: unknown) => e);
      expect(err, method).toBeInstanceOf(ApiV1Error);
      expect((err as ApiV1Error).code, method).toBe("stripe_unavailable");
      expect(sheetsIn(m), `${method}: still open`).toHaveLength(1);
      for (const key of ["sponsors.error.stripeUnavailable", "sponsors.error.invoiceSavedNoLink", "sponsors.error.invoiceSavedResend", "sponsors.error.invoiceNotSentCheck"] as const) {
        expect(m.text(), `${method}: ${key} is the sheet's to show, not the page's`).not.toContain(msg(key));
      }
      expect(m.text()).not.toContain("server english");
      checked++;
    }
    expect(checked).toBe(2);
  });
});
