// Sponsor deals PR 2, Task 14 - the Sponsors tab's list (components/sponsors/sponsor-list.tsx): each sponsor row carries its
// deal's chip and ONE next action (`rowNextAction`, lib/sponsor-deals.ts, F15), grouped by the tier each sponsor shows at now.
//
// Every expectation is typed from the MOCKUP (screen 1 of 2026-11-01_sponsor-deals-mockups: the eight rows, their chips, sub-lines
// and actions), from spec §6, or from the owner's own rulings of 2026-11-11 (the group is the tier a sponsor shows at NOW - Title 1,
// Partner 7 here - and the pencil is the one way in) - never read back from the component. vitest is
// `environment: "node"`: the list's markup is read from `renderToStaticMarkup`; a click is the element's own handler called, in the
// tree `_sponsor-tree.tsx` expands (SponsorList, SponsorRowMore and DealChip are stateless; every bit of state is OrgSponsors').
// What neither can see (CSS, real widths, a real tap) is `e2e/sponsor-deals.spec.ts`, run by CI at 320 / 768 / 1280.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   L1  one action     render `allowedActions(deal)[1]` beside the row's action                       -> "one action at most"
//   L2  precedence     `rowNextAction(deal)` -> a draft row offers Send invoice                       -> "the eight mockup rows"
//   L3  group key      group by `s.deal?.tier ?? s.tier` (the OLD key: the waiting deal's tier)        -> "a waiting title deal on a partner sponsor sits in PARTNER"
//   L4  fold           drop `max-md:hidden` from the tray                                              -> "the tray is hidden below md"
//   L20 pencil         the pencil goes back INTO the tray (folded with the rest)                       -> "the PENCIL is not in the tray"
//   L21 pencil         the pencil's cell is `max-md:hidden` (never shown on a phone)                   -> "the PENCIL is not in the tray"
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
//   L15 pencil tray    the pencil's arrival stops clearing `moreOpenId`                               -> "the pencil's arrival closes the ⋯ tray the reader had open" (sponsor-sheet.test.tsx)
//   L17 name           the name is a link again (`sponsor-row-name-link`)                              -> "the name is plain text"
//   L18 pencil         the pencil links to the plain sponsor URL (no `edit=1`)                         -> "the pencil is a link to the sponsor's page with its editor open"
//   L19 viewer         the viewer gets the pencil (edit link) instead of Open                          -> "a viewer's row opens the page read-only"
//   L22 chips          a chip goes back to `shrink-0` (it runs under the pencil in a 130px column)      -> "a chip may shrink and truncate"
//   L23 tiny phones    the logo tile loses `max-[376px]:hidden`                                       -> "below 376 the logo tile is hidden"
//   L24 tiny phones    the name loses `max-[376px]:line-clamp-2` (back to one truncated line)         -> "below 376 the name wraps to two lines"
//   L25 viewer         the viewer's Open cell or button is `max-md:hidden`                             -> "a viewer's Open is on screen on a phone"
//   L26 chip title     a chip loses its `title` (a cut "Disputed - parked" cannot be read)               -> "a truncated chip carries its full words as its title"
//   L27 breakpoint     the narrow layout goes back to `max-[360px]` (a 360 / 375 phone is cramped)      -> "the narrow layout starts below 376"
//   L28 sub-line       the sub-line loses `max-[376px]:line-clamp-2` (the price is cut mid-number)      -> "below 376 the sub-line takes two lines"
//   L29 lone sponsor   the arrows are drawn for a group of one (`canReorder` -> true)                  -> "a sponsor alone in its group has no arrows"
//   L30 clicks words   the clicks span goes back to the bare number                                    -> "the clicks read as a counted noun"
//   L31 spacer         the group-of-one spacer is dropped                                             -> "a lone row keeps the arrows' room"
//   L32 clicks width   the clicks span loses `md:min-w-[5rem]`                                         -> "every row's tray is the same width"
//   L33 deal track     the deal cell goes back to `md:w-72` (the name is cut to 84px at 768)           -> "the deal column is 13rem from md and 18rem from lg"
//   L16 live region    the notice renders only while it has text                                      -> "always mounted"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
// The island reads a router (to clear the pencil's ?edit=1 once its editor is done); nothing in this file navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { OrgSponsors, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { AddDealSheet, type CreateDealBody } from "@/components/sponsors/add-deal-sheet";
import { canShowAgain, groupTierOf, SponsorList, tierComing, type SponsorListProps } from "@/components/sponsors/sponsor-list";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "./_sponsor-tree";
import { attrOf, classTokens, findAll, findOne, textOfMarkup } from "./_markup";
import { ApiV1Error } from "@/lib/client-v1";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { sponsorEditHref, sponsorHref } from "@/lib/sponsors-hub";
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
const DICT_BY_LOCALE = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as const;
/** One string out of a locale's own dictionary file, its `{name}` / `{count}` filled - typed from the file, never from the component. */
function words(locale: (typeof LOCALES)[number], key: string, vars: Record<string, string | number> = {}): string {
  const raw = (DICT_BY_LOCALE[locale] as Record<string, string>)[key];
  if (raw === undefined) throw new Error(`${locale} has no "${key}"`);
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), raw);
}
/** What a locale calls n clicks: the plural FORM its CLDR rule picks (Intl.PluralRules is the rulebook; `one` and `other` are the only
 *  two forms the row has, so any other category is a count this helper has no words for and fails loud). */
function clicksWords(locale: (typeof LOCALES)[number], n: number): string {
  const category = new Intl.PluralRules(locale).select(n);
  if (category !== "one" && category !== "other") throw new Error(`${locale} puts ${n} in "${category}", which the row has no words for`);
  return words(locale, `sponsors.row.clicks.${category}`, { count: n });
}

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
  dispute_id: null, has_payment_intent: false, invoice_number: null, written_off_at: null, written_off_by: null,
};
/** D11: an online or offline deal is numbered when it is made, a complimentary one never. A row offers Resend invoice only for a numbered
 *  deal (T24 m5: an unnumbered one has no invoice page to link), so a fixture that stood in for a real deal without a number would
 *  test the stg-only shape. */
const deal = (over: Partial<SponsorDeal>): SponsorDeal => ({
  ...DEAL,
  invoice_number: (over.payment_method ?? DEAL.payment_method) === "complimentary" ? null : 1,
  ...over,
});

const sponsor = (over: Partial<SponsorItem> & { id: string; name: string }): SponsorItem => ({
  competition_id: null, url: null, logo_path: null, poster_path: null, tier: "partner", display_order: 0, status: "active", click_count: 0,
  on_stream: false, archived_at: null, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null, ...over,
});

/** The mockup's eight rows (screen 1), in the mockup's order. `chip` / `action` are the words in the picture. Two things are the OWNER'S
 *  since the mockup (2026-11-11), typed here from his words and not from the component: a row is grouped under the tier its sponsor
 *  shows at NOW (`group`; the mockup grouped a waiting deal under its own tier), and the sub-line names the deal's tier beside the
 *  package ("Testing001 Gold · Title · £20 · Bank transfer"; `sub`). `hint` is the row's "<Tier> when live" chip, or null. */
interface MockupRow {
  s: SponsorItem;
  group: (typeof SPONSOR_TIERS)[number];
  chip: string;
  sub: string;
  hint: string | null;
  /** The `RowAction` and its button words, or null: no button. */
  action: [string, string] | null;
}
const MOCKUP: MockupRow[] = [
  {
    s: sponsor({
      id: "s1", name: LONG_NAME, tier: "title", click_count: 41, locked_by_deal: true, url: "https://harbourside.example/",
      deal: deal({ id: "d1", sponsor_id: "s1", deal_status: "live", payment_status: "paid", package_name: "Title Season", tier: "title", amount_cents: 150_000, competition_id: "c-season" }),
    }),
    group: "title", chip: "Live", sub: "Title Season · Title · £1,500 · Season 2026/27", hint: null, action: null,
  },
  {
    s: sponsor({
      id: "s2", name: "Ridge Gold Physiotherapy", tier: "partner", click_count: 12, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d2", sponsor_id: "s2", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online", package_name: "Gold Season", tier: "gold", amount_cents: 60_000, invoice_sent_at: "2026-10-28T10:00:00.000Z" }),
    }),
    group: "partner", chip: "Awaiting payment", sub: "Gold Season · Gold · £600 · Online invoice sent 28 Oct", hint: "Gold when live", action: ["resend_invoice", "Resend invoice"],
  },
  {
    s: sponsor({
      id: "s3", name: "Quay Fisheries", tier: "partner", click_count: 7, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d3", sponsor_id: "s3", deal_status: "awaiting_approval", payment_status: "paid", payment_method: "online", go_live: "on_approval", package_name: "Silver Season", tier: "silver", amount_cents: 30_000, paid_at: "2026-10-16T12:00:00.000Z" }),
    }),
    group: "partner", chip: "Awaiting approval", sub: "Silver Season · Silver · £300 · Paid 16 Oct", hint: "Silver when live", action: ["approve", "Approve"],
  },
  {
    s: sponsor({
      id: "s4", name: "Marlow & Daughters Bakery", tier: "partner", click_count: 3, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d4", sponsor_id: "s4", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", package_name: "Silver Season", tier: "silver", amount_cents: 30_000 }),
    }),
    group: "partner", chip: "Awaiting payment", sub: "Silver Season · Silver · £300 · Bank transfer", hint: "Silver when live", action: ["mark_paid", "Mark as paid"],
  },
  {
    s: sponsor({
      id: "s5", name: "Old Anchor Café", tier: "partner", click_count: 9, locked_by_deal: true,
      deal: deal({ id: "d5", sponsor_id: "s5", deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate", package_name: "Partner", tier: "partner", amount_cents: 0, competition_id: "c-winter" }),
    }),
    group: "partner", chip: "Live", sub: "Partner · Complimentary · Winter League 2026/27", hint: null, action: null,
  },
  {
    s: sponsor({
      id: "s6", name: "Kestrel Taxis", tier: "partner", click_count: 0, status: "inactive", has_open_deal: true,
      deal: deal({ id: "d6", sponsor_id: "s6", deal_status: "draft", payment_status: "pending", payment_method: "online", package_name: "Partner", tier: "partner", amount_cents: 12_000 }),
    }),
    group: "partner", chip: "Draft", sub: "Partner · £120 · Not sent yet", hint: null, action: ["open_deal", "Open deal"],
  },
  {
    s: sponsor({ id: "s7", name: "Northbank Print", tier: "partner", click_count: 2, status: "inactive", url: "https://northbank-print.co.uk/", deal: null }),
    group: "partner", chip: "No deal", sub: "No deal · northbank-print.co.uk", hint: null, action: ["add_deal", "Add deal"],
  },
  {
    s: sponsor({
      id: "s8", name: "Tidewell Garage", tier: "partner", click_count: 18, status: "inactive",
      deal: deal({ id: "d8", sponsor_id: "s8", deal_status: "ended", payment_status: "paid", package_name: "Partner", tier: "partner", amount_cents: 12_000, ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" }),
    }),
    group: "partner", chip: "Ended", sub: "Partner · £120 · Ended 31 Aug", hint: null, action: ["add_deal", "Add deal"],
  },
];
const ROWS = MOCKUP.map((m) => m.s);
/** The mockup's link-click counts per row (the `title="N link clicks"` on each row of screen 1), typed here - the fixture sets the same
 *  numbers on the sponsors, so the row can be seen to read them back. */
const MOCKUP_CLICKS: Record<string, number> = { s1: 41, s2: 12, s3: 7, s4: 3, s5: 9, s6: 0, s7: 2, s8: 18 };

const noop = () => {};
function listProps(sponsors: SponsorItem[], over: Partial<SponsorListProps> = {}): SponsorListProps {
  return {
    sponsors, hasTiers: true, canEdit: true, busy: false, orgSlug: SLUG, tz: "UTC", competitions: COMPS, moreOpenId: null,
    onToggleMore: noop, onMove: noop, onRemove: noop, onAction: noop, onAddDeal: noop, ...over,
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
  it("the fixture IS the mockup's eight rows, grouped by the tier each sponsor shows at now: Title 1, Partner 7 (three of them waiting on a higher-tier deal)", () => {
    expect(MOCKUP).toHaveLength(8);
    const counts = SPONSOR_TIERS.map((tier) => MOCKUP.filter((m) => m.group === tier).length);
    expect(counts).toEqual([1, 0, 0, 7]);
    expect(MOCKUP.filter((m) => m.hint !== null).map((m) => m.s.id), "premise: the three rows whose deal is a higher tier than the sponsor").toEqual(["s2", "s3", "s4"]);
  });

  it("each row shows the chip its deal state names, the sub-line, and the action rowNextAction picks (8 checked)", () => {
    const markup = listHtml(ROWS);
    expect(findAll(markup, "sponsor-row"), "all eight rows render").toHaveLength(8);
    let checked = 0;
    for (const m of MOCKUP) {
      const row = rowOf(markup, m.s.id);
      expect(textOfMarkup(findOne(row, "deal-chip").outer), `${m.s.name}: chip`).toBe(m.chip);
      expect(textOfMarkup(findOne(row, "sponsor-row-sub").outer), `${m.s.name}: sub-line`).toBe(m.sub);
      const hint = findAll(row, "sponsor-row-tier-hint");
      expect(hint.map((h) => textOfMarkup(h.outer)), `${m.s.name}: the tier hint`).toEqual(m.hint === null ? [] : [m.hint]);
      expect(textOfMarkup(findOne(row, "sponsor-row-clicks").outer), `${m.s.name}: clicks`).toBe(clicksWords("en", MOCKUP_CLICKS[m.s.id]!));
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

  it("final review m1: a row's Resend invoice on an online deal whose invoice never went out (it went live before its first send) reads 'Send invoice'; once sent, 'Resend invoice' (the pair)", () => {
    let checked = 0;
    for (const [sent, words] of [[null, "Send invoice"], ["2026-10-28T10:00:00.000Z", "Resend invoice"]] as const) {
      const row = sponsor({
        id: "sx", name: "Kestrel Taxis", has_open_deal: false, locked_by_deal: true,
        deal: deal({ id: "dx", sponsor_id: "sx", deal_status: "live", payment_status: "pending", payment_method: "online", go_live: "immediate", live_at: "2026-10-28T09:00:00.000Z", invoice_sent_at: sent }),
      });
      const button = findOne(rowOf(listHtml([row]), "sx"), "sponsor-row-action");
      expect(attrOf(button.open, "data-action"), "premise: the row offers Resend invoice").toBe("resend_invoice");
      expect(textOfMarkup(button.outer)).toBe(words);
      expect(attrOf(button.open, "aria-label")).toBe(`${words}: Kestrel Taxis`);
      checked++;
    }
    expect(checked).toBe(2);
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

describe("rows group by the tier the sponsor shows at NOW, in SPONSOR_TIERS order (owner, 2026-11-11; spec §6.1)", () => {
  it("the mockup's rows: Title 1, Partner 7, each row under its sponsor's tier; gold and silver are not drawn - nobody shows at them yet (8 checked)", () => {
    const markup = listHtml(ROWS);
    const groups = findAll(markup, "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["title", "partner"]);
    expect(groups.map((g) => textOfMarkup(findOne(g.outer, "sponsor-group-header").outer))).toEqual(["Title 1", "Partner 7"]);
    let checked = 0;
    for (const g of groups) {
      const tier = attrOf(g.open, "data-tier");
      const ids = findAll(g.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"));
      expect(ids, tier).toEqual(MOCKUP.filter((m) => m.group === tier).map((m) => m.s.id));
      checked += ids.length;
    }
    expect(checked).toBe(8);
  });

  // The owner's own screen (stg): package "Testing001 Gold" has tier Title; sponsor Testoo2 has an offline deal of it awaiting payment
  // while the sponsor itself is still a Partner. It was listed under TITLE.
  const WAITING = sponsor({
    id: "t2", name: "Testoo2", tier: "partner", status: "inactive", has_open_deal: true,
    deal: deal({ id: "dt2", sponsor_id: "t2", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", package_name: "Testing001 Gold", tier: "title", amount_cents: 2_000 }),
  });
  const groupOf = (markup: string, id: string) =>
    findAll(markup, "sponsor-group").find((g) => findAll(g.outer, "sponsor-row").some((r) => attrOf(r.open, "data-sponsor-id") === id));
  const hintOf = (markup: string, id: string) => findAll(rowOf(markup, id), "sponsor-row-tier-hint").map((h) => textOfMarkup(h.outer));

  it("a waiting title deal on a partner sponsor sits in PARTNER with the hint 'Title when live' - the deal's tier is not the group (the Testoo2 case)", () => {
    expect(WAITING.tier, "premise: the sponsor itself is a partner").toBe("partner");
    expect(WAITING.deal?.tier, "premise: its deal is a title deal").toBe("title");
    const markup = listHtml([WAITING]);
    expect(attrOf(groupOf(markup, "t2")!.open, "data-tier")).toBe("partner");
    expect(hintOf(markup, "t2")).toEqual(["Title when live"]);
    expect(textOfMarkup(findOne(rowOf(markup, "t2"), "sponsor-row-sub").outer), "and the sub-line names the package's tier").toBe(
      "Testing001 Gold · Title · £20 · Bank transfer",
    );
  });

  it("a LIVE title deal sits in Title with no hint; a sponsor with no deal and one whose deal ended sit under their own tier with none (the other three cases)", () => {
    const live = sponsor({
      id: "l1", name: "Live Title", tier: "title", locked_by_deal: true,
      deal: deal({ id: "dl1", sponsor_id: "l1", deal_status: "live", package_name: "Title Season", tier: "title" }),
    });
    const none = sponsor({ id: "n1", name: "No Deal Silver", tier: "silver", deal: null });
    const ended = sponsor({
      id: "e1", name: "Ended Gold", tier: "gold", status: "inactive",
      deal: deal({ id: "de1", sponsor_id: "e1", deal_status: "ended", payment_status: "paid", package_name: "Gold Season", tier: "gold", ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" }),
    });
    // An ENDED deal of another tier than the sponsor's stored one: nothing is coming, so there is no hint and the stored tier groups it.
    const endedElsewhere = sponsor({
      id: "e2", name: "Ended Elsewhere", tier: "silver", status: "inactive",
      deal: deal({ id: "de2", sponsor_id: "e2", deal_status: "ended", payment_status: "paid", package_name: "Title Season", tier: "title", ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" }),
    });
    const rows = [live, none, ended, endedElsewhere];
    const markup = listHtml(rows);
    const expected: [string, string][] = [["l1", "title"], ["n1", "silver"], ["e1", "gold"], ["e2", "silver"]];
    let checked = 0;
    for (const [id, tier] of expected) {
      expect(attrOf(groupOf(markup, id)!.open, "data-tier"), id).toBe(tier);
      expect(hintOf(markup, id), `${id}: no hint`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a waiting deal of the SAME tier as its sponsor has no hint (nothing changes when it goes live), and a waiting deal beside a LIVE one is the live one's row", () => {
    const same = sponsor({
      id: "w1", name: "Waiting Gold", tier: "gold", status: "inactive", has_open_deal: true,
      deal: deal({ id: "dw1", sponsor_id: "w1", deal_status: "awaiting_payment", payment_status: "pending", package_name: "Gold Season", tier: "gold" }),
    });
    // The row shows the LIVE deal when there is one (`pickRowDeal`), and the sponsor is locked by it: whatever else waits changes
    // nothing until it ends, so no hint is drawn even if the row's own deal were another tier.
    const held = sponsor({
      id: "w2", name: "Held By Live", tier: "gold", locked_by_deal: true, has_open_deal: true,
      deal: deal({ id: "dw2", sponsor_id: "w2", deal_status: "live", package_name: "Gold Season", tier: "gold" }),
    });
    const markup = listHtml([same, held]);
    expect(hintOf(markup, "w1")).toEqual([]);
    expect(hintOf(markup, "w2")).toEqual([]);
  });

  it("a waiting deal drawn without tiers (the flat list) has no hint: there are no groups for it to move between", () => {
    const markup = listHtml([WAITING], { hasTiers: false });
    expect(findAll(markup, "sponsor-group")).toHaveLength(0);
    expect(findAll(markup, "sponsor-row-tier-hint")).toHaveLength(0);
  });

  it("a sponsor with no deal sits under its own tier; a group nobody is in is not drawn (the empty case of a group)", () => {
    const only = sponsor({ id: "s10", name: "Plain Sponsor", tier: "silver", deal: null });
    const groups = findAll(listHtml([only]), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["silver"]);
  });

  it("the helpers the rows and the sponsor page share: groupTierOf is the stored tier, tierComing names the waiting deal's tier only when it differs (8 checked)", () => {
    const cases: [string, SponsorItem, SponsorTier, SponsorTier | null][] = [
      ["waiting title deal on a partner", WAITING, "partner", "title"],
      ["no deal", sponsor({ id: "h1", name: "h1", tier: "gold" }), "gold", null],
      ["same tier", sponsor({ id: "h2", name: "h2", tier: "gold", has_open_deal: true, deal: deal({ id: "dh2", tier: "gold", deal_status: "scheduled" }) }), "gold", null],
      ["live deal", sponsor({ id: "h3", name: "h3", tier: "title", locked_by_deal: true, deal: deal({ id: "dh3", tier: "title" }) }), "title", null],
      ["draft deal", sponsor({ id: "h4", name: "h4", tier: "partner", has_open_deal: true, deal: deal({ id: "dh4", tier: "silver", deal_status: "draft" }) }), "partner", "silver"],
      ["ended deal", sponsor({ id: "h5", name: "h5", tier: "partner", deal: deal({ id: "dh5", tier: "gold", deal_status: "ended" }) }), "partner", null],
      // A live deal holds the sponsor's tier (D9): whatever waits beside it changes nothing until that one ends.
      ["held by a live deal, a gold one waits", sponsor({ id: "h7", name: "h7", tier: "partner", locked_by_deal: true, has_open_deal: true, deal: deal({ id: "dh7", tier: "gold", deal_status: "awaiting_payment" }) }), "partner", null],
      // Defensive: the flag says a deal waits but the row's own deal is the ended one - an ended deal changes nothing when "it goes live".
      ["open flag, ended row deal", sponsor({ id: "h6", name: "h6", tier: "partner", has_open_deal: true, deal: deal({ id: "dh6", tier: "gold", deal_status: "ended" }) }), "partner", null],
    ];
    let checked = 0;
    for (const [name, row, group, coming] of cases) {
      expect(groupTierOf(row), `${name}: group`).toBe(group);
      expect(tierComing(row), `${name}: coming`).toBe(coming);
      checked++;
    }
    expect(checked).toBe(8);
  });
});

describe("the tier word beside a deal's package: 'Testing001 Gold · Title · £20 · Bank transfer' (owner, 2026-11-11)", () => {
  const say = (d: Partial<SponsorDeal>, hasTiers: boolean) => {
    const row = sponsor({ id: "tw", name: "Tier Word", has_open_deal: true, deal: deal({ id: "dtw", sponsor_id: "tw", ...d }) });
    return textOfMarkup(findOne(rowOf(listHtml([row], { hasTiers }), "tw"), "sponsor-row-sub").outer);
  };
  const OFFLINE = { deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", amount_cents: 2_000 } as const;

  it("on a plan with tiers every tier says its word, between the package and the price (4 tiers checked)", () => {
    let checked = 0;
    for (const [tier, word] of [["title", "Title"], ["gold", "Gold"], ["silver", "Silver"], ["partner", "Partner"]] as const) {
      expect(say({ ...OFFLINE, package_name: "Testing001 Gold", tier }, true), tier).toBe(`Testing001 Gold · ${word} · £20 · Bank transfer`);
      checked++;
    }
    expect(checked).toBe(SPONSOR_TIERS.length);
  });

  it("on a plan without tiers a Partner deal says no tier word, but a deal carrying a higher tier still says it (the pair)", () => {
    expect(say({ ...OFFLINE, package_name: "Club Package", tier: "partner" }, false)).toBe("Club Package · £20 · Bank transfer");
    expect(say({ ...OFFLINE, package_name: "Club Package", tier: "gold" }, false)).toBe("Club Package · Gold · £20 · Bank transfer");
  });

  it("a package named for its own tier does not say it twice ('Partner · Partner'); a longer name that contains it does (the pair)", () => {
    expect(say({ ...OFFLINE, package_name: "Partner", tier: "partner" }, true)).toBe("Partner · £20 · Bank transfer");
    expect(say({ ...OFFLINE, package_name: "gold", tier: "gold" }, true), "case does not matter").toBe("gold · £20 · Bank transfer");
    expect(say({ ...OFFLINE, package_name: "Gold Season", tier: "gold" }, true)).toBe("Gold Season · Gold · £20 · Bank transfer");
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
    expect(sub("UTC")).toBe("Gold Season · Gold · £600 · Online invoice sent 28 Aug");
    expect(sub("Europe/London")).toBe("Gold Season · Gold · £600 · Online invoice sent 29 Aug");
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

  it("the clicks read as a counted noun, and the title says what a click is (owner, 2026-11-11: a bare icon and number was not read as a count) - 4 locales x 0, 1, 2 and 41", () => {
    // The premise that makes the sweep able to fail: a locale's one-form and other-form are different words, so a row that always used
    // one of them would be caught, and a row that dropped the noun would be caught by the number-only check below.
    let checked = 0;
    for (const locale of LOCALES) {
      expect(clicksWords(locale, 1), `${locale}: the singular is not the plural`).not.toBe(clicksWords(locale, 2));
      for (const n of [0, 1, 2, 41]) {
        const markup = renderToStaticMarkup(
          <DictProvider dict={DICT_BY_LOCALE[locale] as unknown as Dict} locale={locale}>
            <SponsorList {...listProps([sponsor({ id: "k", name: "Counted Sponsor", click_count: n })])} />
          </DictProvider>,
        );
        const clicks = findOne(markup, "sponsor-row-clicks");
        const shown = textOfMarkup(clicks.outer);
        expect(shown, `${locale} ${n}: the locale's own words for the count`).toBe(clicksWords(locale, n));
        expect(shown, `${locale} ${n}: more than the bare number`).not.toBe(String(n));
        expect(attrOf(clicks.open, "title"), `${locale} ${n}: the title says what a click is`).toBe(words(locale, "sponsors.row.clicksHint"));
        // The count is read out as its words: no aria-label on a span (it names nothing there) that would stand in for them.
        expect(clicks.open, `${locale} ${n}: no aria-label replacing the count`).not.toContain("aria-label");
        checked++;
      }
    }
    expect(checked, "4 locales x 4 counts").toBe(16);
  });

  it("the English words, typed from the owner's wording: 0 clicks, 1 click, 2 clicks; Taps through to their website; and French counts 0 as singular (the plural rule is the locale's, not English's)", () => {
    const html = (locale: (typeof LOCALES)[number], n: number) =>
      renderToStaticMarkup(
        <DictProvider dict={DICT_BY_LOCALE[locale] as unknown as Dict} locale={locale}>
          <SponsorList {...listProps([sponsor({ id: "k", name: "Counted Sponsor", click_count: n })])} />
        </DictProvider>,
      );
    const read = (locale: (typeof LOCALES)[number], n: number) => textOfMarkup(findOne(html(locale, n), "sponsor-row-clicks").outer);
    expect([0, 1, 2].map((n) => read("en", n))).toEqual(["0 clicks", "1 click", "2 clicks"]);
    expect(attrOf(findOne(html("en", 5), "sponsor-row-clicks").open, "title")).toBe("Taps through to their website");
    expect([0, 1, 2].map((n) => read("fr", n)), "CLDR: French `one` covers 0 and 1").toEqual(["0 clic", "1 clic", "2 clics"]);
    expect([0, 1, 2].map((n) => read("es", n))).toEqual(["0 clics", "1 clic", "2 clics"]);
    expect([0, 1, 2].map((n) => read("nl", n))).toEqual(["0 klikken", "1 klik", "2 klikken"]);
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

describe("a chip on the name line can never run under the pencil, and below 376 the name gets the room (owner, 2026-11-11; seen at 320: a 80px name column)", () => {
  const LOST = sponsor({ id: "c1", name: "Lost One", dispute_lost: true });
  const PARKED = sponsor({ id: "c2", name: "Parked One", dispute_parked: true });
  const PAID = sponsor({ id: "c3", name: "Paid One", paid_order_id: "o1" });
  const WAITING = sponsor({
    id: "c4", name: "Waiting One", status: "inactive", has_open_deal: true,
    deal: deal({ id: "dc4", sponsor_id: "c4", deal_status: "awaiting_payment", payment_status: "pending", package_name: "Gold Season", tier: "gold" }),
  });

  it("every chip on the name line - Dispute lost, Disputed - parked, Paid and '<Tier> when live' - may shrink and truncate instead of holding its width (4 kinds checked)", () => {
    const markup = listHtml([LOST, PARKED, PAID, WAITING]);
    let checked = 0;
    for (const [id, words] of [["c1", "Dispute lost"], ["c2", "Disputed — parked"], ["c3", "Paid"], ["c4", "Gold when live"]] as const) {
      const chips = findAll(findOne(rowOf(markup, id), "sponsor-row-name").outer, id === "c4" ? "sponsor-row-tier-hint" : "sponsor-row-badge");
      expect(chips, `${id}: exactly one chip`).toHaveLength(1);
      expect(textOfMarkup(chips[0]!.outer), `${id}: the chip says its words`).toBe(words);
      const tokens = classTokens(chips[0]!.open);
      expect(tokens, `${id}: a chip may shrink and truncate`).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "truncate"]));
      expect(tokens, `${id}: and does not hold its full width`).not.toContain("shrink-0");
      checked++;
    }
    expect(checked, "four kinds of chip").toBe(4);
  });

  it("a truncated chip carries its full words as its title, so a cut word can be read on hover or long-press (4 kinds x 4 locales)", () => {
    const DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as const;
    // The three badges' words come from each locale's own dictionary file, not from the component.
    const KEYS = { c1: "sponsors.lostBadge", c2: "sponsors.parkedBadge", c3: "sponsors.paidBadge" } as const;
    const seen = new Set<string>();
    let checked = 0;
    for (const locale of LOCALES) {
      const markup = renderToStaticMarkup(
        <DictProvider dict={DICTS[locale] as unknown as Dict} locale={locale}>
          <SponsorList {...listProps([LOST, PARKED, PAID, WAITING])} />
        </DictProvider>,
      );
      for (const id of ["c1", "c2", "c3", "c4"] as const) {
        const chips = findAll(findOne(rowOf(markup, id), "sponsor-row-name").outer, id === "c4" ? "sponsor-row-tier-hint" : "sponsor-row-badge");
        expect(chips, `${locale} ${id}: exactly one chip`).toHaveLength(1);
        const words = textOfMarkup(chips[0]!.outer);
        expect(words.length, `${locale} ${id}: the chip has words`).toBeGreaterThan(0);
        if (id !== "c4") expect(words, `${locale} ${id}: the locale's own words`).toBe((DICTS[locale] as Record<string, string>)[KEYS[id]]);
        expect(attrOf(chips[0]!.open, "title"), `${locale} ${id}: the title is the chip's own words, in full`).toBe(words);
        seen.add(`${locale}:${words}`);
        checked++;
      }
    }
    expect(checked, "four kinds of chip in four locales").toBe(16);
    expect(seen.size, "the four locales really rendered four different sets of words").toBeGreaterThan(12);
  });

  it("below 376 the logo tile is hidden and the grid is two columns (name, pencil), the deal and the tray starting at the first; from 376 nothing changes (the markup carries both)", () => {
    const row = rowOf(listHtml(ROWS), "s1");
    const grid = findOne(row, "sponsor-row-grid");
    const cls = classTokens(grid.open);
    expect(cls, "the three-column grid is still the base").toContain("grid-cols-[2.25rem_minmax(0,1fr)_auto]");
    expect(cls, "below 376 it is name + pencil").toContain("max-[376px]:grid-cols-[minmax(0,1fr)_auto]");
    expect(cls, "from md it is unchanged").toContain("md:grid-cols-[2.25rem_minmax(0,1fr)_auto_auto_auto]");
    const logo = findOne(row, "sponsor-row-logo");
    expect(classTokens(logo.open), "below 376 the logo tile is hidden").toContain("max-[376px]:hidden");
    // The hidden tile is the ONLY thing taking the first column, so the next cells start at the first column there.
    for (const id of ["sponsor-row-deal", "sponsor-row-tools"]) {
      const tokens = classTokens(findOne(row, id).open);
      expect(tokens, `${id}: starts at column 1 below 376`).toContain("max-[376px]:col-start-1");
      expect(tokens, `${id}: spans both columns (all of them, below 376)`).toContain("col-span-2");
      expect(tokens, `${id}: and still starts at column 2 from 376`).toContain("col-start-2");
    }
  });

  it("below 376 the name wraps to two lines (line-clamp-2) instead of cutting at about nine characters; from 376 it still truncates on one line (8 rows checked)", () => {
    let checked = 0;
    for (const r of ROWS) {
      const text = classTokens(findOne(findOne(rowOf(listHtml(ROWS), r.id), "sponsor-row-name").outer, "sponsor-row-name-text").open);
      expect(text, `${r.id}: two lines below 376`).toEqual(expect.arrayContaining(["max-[376px]:line-clamp-2", "max-[376px]:whitespace-normal", "max-[376px]:break-words"]));
      expect(text, `${r.id}: from 376 it is the one truncated line it was`).toEqual(expect.arrayContaining(["truncate", "min-w-0", "max-w-full"]));
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the narrow layout starts below 376, not below 360: a 360 and a 375 phone (the commonest widths) get it, and the old 360 bound is gone (every narrow token on 8 rows)", () => {
    // `max-[N]` is `width < N` in Tailwind v4, so 376 puts 360 and 375 inside the narrow layout and 376 itself outside.
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(listHtml(ROWS), r.id);
      for (const el of [
        findOne(row, "sponsor-row-grid"), findOne(row, "sponsor-row-logo"), findOne(row, "sponsor-row-deal"), findOne(row, "sponsor-row-tools"),
        findOne(row, "sponsor-row-sub"), findOne(findOne(row, "sponsor-row-name").outer, "sponsor-row-name-text"),
      ]) {
        const narrow = classTokens(el.open).filter((c) => c.startsWith("max-["));
        expect(narrow.length, `${r.id}: carries narrow-layout tokens`).toBeGreaterThan(0);
        for (const c of narrow) expect(c, `${r.id}: ${c}`).toMatch(/^max-\[376px\]:/);
        checked++;
      }
    }
    expect(checked, "6 elements on 8 rows").toBe(48);
  });

  it("below 376 the sub-line takes two lines (line-clamp-2) so a price is not cut mid-number; from 376 it is the one truncated line it was (8 rows checked)", () => {
    let checked = 0;
    for (const r of ROWS) {
      const tokens = classTokens(findOne(rowOf(listHtml(ROWS), r.id), "sponsor-row-sub").open);
      expect(tokens, `${r.id}: two lines below 376`).toEqual(expect.arrayContaining(["max-[376px]:line-clamp-2", "max-[376px]:whitespace-normal", "max-[376px]:break-words"]));
      expect(tokens, `${r.id}: from 376 it is the one truncated line it was`).toEqual(expect.arrayContaining(["truncate", "text-xs"]));
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the logo tile exists once per row, image or initial, and carries the same hidden-below-376 class either way (stored logo and initial both checked)", () => {
    const withLogo = sponsor({ id: "c5", name: "Logo One", logo_path: "https://cdn.example/logo.png" });
    const markup = listHtml([withLogo, PAID]);
    let checked = 0;
    for (const [id, tag] of [["c5", "<img"], ["c3", "<span"]] as const) {
      const logos = findAll(rowOf(markup, id), "sponsor-row-logo");
      expect(logos, `${id}: one logo tile`).toHaveLength(1);
      expect(logos[0]!.open.startsWith(tag), `${id}: ${tag}`).toBe(true);
      expect(classTokens(logos[0]!.open), id).toContain("max-[376px]:hidden");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a viewer's Open is on screen on a phone: neither its cell nor the link is hidden below md, and it keeps its 44px (8 rows checked)", () => {
    const markup = listHtml(ROWS, { canEdit: false });
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(markup, r.id);
      const lead = findOne(row, "sponsor-row-lead");
      const open = findOne(lead.outer, "sponsor-row-open");
      for (const el of [lead.open, open.open]) {
        // `hidden` as a WHOLE token: the substring also sits inside `max-md:hidden`.
        expect(classTokens(el), r.id).not.toContain("max-md:hidden");
        expect(classTokens(el), r.id).not.toContain("hidden");
      }
      expect(classTokens(open.open), `${r.id}: 44px`).toEqual(expect.arrayContaining(["max-md:h-11", "max-md:w-11"]));
      checked++;
    }
    expect(checked).toBe(8);
  });
});

describe("below md the clicks and the move and delete controls fold behind a 44px ⋯; the pencil does not (spec §6.1, mockup screen 1; owner, 2026-11-11)", () => {
  /** What the ⋯ folds. The pencil is NOT among them: it is the one way into a sponsor, so it is on the row whether the tray is open or not. */
  const FOLDED = (name: string) => [
    msg("settings.org.sponsors.moveUp", { name }),
    msg("settings.org.sponsors.moveDown", { name }),
    msg("settings.org.sponsors.remove", { name }),
  ];
  /** A sponsor alone in its group has nothing to move past, so the tray folds only the delete (owner, 2026-11-11). */
  const FOLDED_ALONE = (name: string) => [msg("settings.org.sponsors.remove", { name })];
  const RIDGE = "Ridge Gold Physiotherapy";

  it("each control exists ONCE in a row, the tray is hidden below md until opened, and shows when opened (closed and open both checked; a lone Title row and a Partner row in a group of seven)", () => {
    // Harbourside is alone in Title: no arrows to fold, only the delete. Ridge is in Partner with six others: all three.
    const CASES: [string, string, string[]][] = [
      ["s1", LONG_NAME, FOLDED_ALONE(LONG_NAME)],
      ["s2", RIDGE, FOLDED(RIDGE)],
    ];
    let checked = 0;
    for (const [id, name, folded] of CASES) {
      for (const open of [false, true]) {
        const markup = listHtml(ROWS, { moreOpenId: open ? id : null });
        const row = rowOf(markup, id);
        for (const label of [...folded, msg("sponsors.edit", { name })]) {
          expect(row.split(`aria-label="${label}"`).length - 1, `${id} ${label} (open=${open})`).toBe(1);
          checked++;
        }
        expect(row.split('data-testid="sponsor-row-clicks"').length - 1, `${id} clicks (open=${open})`).toBe(1);
        const tray = findOne(row, "sponsor-row-tools");
        expect(classTokens(tray.open).includes("max-md:hidden"), `${id}: the tray is hidden below md while closed (open=${open})`).toBe(!open);
        // The folded controls are INSIDE the tray (that is what folding them means), so hiding the tray hides all of them.
        for (const label of folded) expect(tray.outer, label).toContain(`aria-label="${label}"`);
        expect(tray.outer).toContain('data-testid="sponsor-row-clicks"');
      }
    }
    expect(checked, "(1 folded control + the pencil) + (3 folded controls + the pencil), x 2 states").toBe(12);
  });

  it("the PENCIL is not in the tray: it sits beside the ⋯, on the row, and nothing about it is hidden below md - open or shut (owner, 2026-11-11: editors did not know where to tap)", () => {
    let checked = 0;
    for (const open of [false, true]) {
      const row = rowOf(listHtml(ROWS, { moreOpenId: open ? "s1" : null }), "s1");
      const tray = findOne(row, "sponsor-row-tools");
      expect(tray.outer, `the tray does not hold the pencil (open=${open})`).not.toContain('data-testid="sponsor-row-edit"');
      const lead = findOne(row, "sponsor-row-lead");
      const pencil = findOne(lead.outer, "sponsor-row-edit");
      const more = findOne(lead.outer, "sponsor-row-more");
      expect(lead.outer.indexOf(pencil.open), `the pencil comes before the ⋯, in the same cell (open=${open})`).toBeLessThan(lead.outer.indexOf(more.open));
      // Nothing between the pencil and the row hides it below md: not the link, not its cell. (`hidden` as a WHOLE token: the substring
      // also sits inside `max-md:hidden`.)
      for (const el of [pencil.open, lead.open]) {
        const tokens = classTokens(el);
        expect(tokens, `open=${open}`).not.toContain("max-md:hidden");
        expect(tokens, `open=${open}`).not.toContain("hidden");
      }
      // 44px, on a phone, like the ⋯ beside it.
      expect(classTokens(pencil.open)).toEqual(expect.arrayContaining(["max-md:h-11", "max-md:w-11"]));
      expect(classTokens(more.open)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
      checked++;
    }
    expect(checked, "open and shut").toBe(2);
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

  it("the tray's controls are 44px targets below md (the icon buttons grow on a phone) - a row with arrows and a row without", () => {
    let checked = 0;
    for (const [id, expected] of [["s2", 3], ["s1", 1]] as const) {
      const tray = findOne(rowOf(listHtml(ROWS, { moreOpenId: id }), id), "sponsor-row-tools");
      const buttons = [...tray.outer.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
      expect(buttons.length, `${id}: ${expected === 3 ? "up, down, delete" : "only the delete: alone in its group"}`).toBe(expected);
      // The pencil is a link and is NOT in the tray (it is beside the ⋯): the tray holds no link at all.
      expect([...tray.outer.matchAll(/<a\b[^>]*>/g)].length, "no link in the tray").toBe(0);
      for (const b of buttons) {
        const tokens = classTokens(b);
        expect(tokens, b).toContain("max-md:h-11");
        expect(tokens, b).toContain("max-md:w-11");
        checked++;
      }
    }
    expect(checked, "3 + 1 buttons").toBe(4);
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
      expect(findAll(row, "sponsor-row-edit"), `${m.s.name}: no pencil`).toHaveLength(0);
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
  it("the rows that qualify (Northbank, Tidewell) carry no Show control on the list; their pencil opens the page that does", () => {
    const off = ROWS.filter((r) => canShowAgain(r));
    expect(off.map((r) => r.id), "premise: Northbank and Tidewell are the hidden rows nothing holds").toEqual(["s7", "s8"]);
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const r of off) {
      expect(findAll(markup, `sponsor-show-${r.id}`), `${r.id}: no Show on site again on the list`).toHaveLength(0);
      expect(attrOf(findOne(rowOf(markup, r.id), "sponsor-row-edit").open, "href"), `${r.id}: the pencil opens the page`).toBe(
        `/o/${SLUG}/sponsors?tab=sponsors&sponsor=${r.id}&edit=1`,
      );
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the row's name is plain text; the pencil is the one way in (owner, 2026-11-11: 'keep the pencil and remove the name link')", () => {
  it("no row's name is a link: the name text is a bare span, still truncating, and no anchor wraps it (8 rows checked)", () => {
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(markup, r.id);
      expect(findAll(row, "sponsor-row-name-link"), `${r.id}: no name link`).toHaveLength(0);
      const name = findOne(row, "sponsor-row-name");
      expect(name.outer, `${r.id}: nothing in the name line is an anchor`).not.toContain("<a ");
      const text = findOne(name.outer, "sponsor-row-name-text");
      expect(text.open.startsWith("<span"), `${r.id}: a span`).toBe(true);
      expect(textOfMarkup(text.outer), `${r.id}: the words are the name, nothing else`).toBe(r.name);
      expect(classTokens(text.open), `${r.id}: the text truncates`).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "truncate"]));
      // The phone tap-padding hack belonged to the link; nothing in the name line carries it now.
      expect(name.outer, `${r.id}: no phone tap padding`).not.toContain("max-md:py-3");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("an editor's pencil is ONE link per row to the sponsor's page with its editor open - the sponsor's own URL plus edit=1 (8 rows checked)", () => {
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(markup, r.id);
      const pencils = findAll(row, "sponsor-row-edit");
      expect(pencils, `${r.id}: exactly one pencil`).toHaveLength(1);
      expect(pencils[0]!.open.startsWith("<a "), `${r.id}: a link, not a button`).toBe(true);
      expect(attrOf(pencils[0]!.open, "href"), r.id).toBe(sponsorEditHref(SLUG, r.id));
      expect(attrOf(pencils[0]!.open, "href"), `${r.id}: the shape`).toBe(`/o/${SLUG}/sponsors?tab=sponsors&sponsor=${r.id}&edit=1`);
      expect(attrOf(pencils[0]!.open, "aria-label"), `${r.id}: it still says whom it edits`).toBe(`Edit ${r.name}`);
      expect(findAll(row, "sponsor-row-open"), `${r.id}: an editor has no Open button`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("a viewer's row has the same button position but it OPENS the page read-only: Open <name>, the plain sponsor URL, no edit flag (8 rows checked)", () => {
    const markup = listHtml(ROWS, { canEdit: false });
    let checked = 0;
    for (const r of ROWS) {
      const row = rowOf(markup, r.id);
      const open = findAll(row, "sponsor-row-open");
      expect(open, `${r.id}: exactly one Open button`).toHaveLength(1);
      expect(open[0]!.open.startsWith("<a "), `${r.id}: a link`).toBe(true);
      expect(attrOf(open[0]!.open, "href"), r.id).toBe(sponsorHref(SLUG, r.id));
      expect(attrOf(open[0]!.open, "href"), `${r.id}: no edit flag for a viewer`).not.toContain("edit=");
      expect(attrOf(open[0]!.open, "aria-label"), r.id).toBe(`Open ${r.name}`);
      // 44px on a phone, and in the same cell an editor's pencil is in (there is nothing to fold for a viewer).
      expect(classTokens(open[0]!.open), `${r.id}: phone tap area`).toEqual(expect.arrayContaining(["max-md:h-11", "max-md:w-11"]));
      expect(findOne(row, "sponsor-row-lead").outer, `${r.id}: in the row's lead cell, where the pencil is`).toContain('data-testid="sponsor-row-open"');
      expect(findAll(row, "sponsor-row-edit"), `${r.id}: no pencil for a viewer`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the row never draws an editor of its own any more: the row is the same markup whoever is being edited (the pair: the sponsor's page owns it)", () => {
    const markup = listHtml(ROWS);
    expect(findAll(markup, "sponsor-row")).toHaveLength(8);
    expect(findAll(markup, "deal-chip"), "every row keeps its chip").toHaveLength(8);
    expect("editingId" in listProps(ROWS), "SponsorList takes no editor state").toBe(false);
    expect("renderEditor" in listProps(ROWS)).toBe(false);
  });
});

describe("Move: the first and last row of a GROUP cannot move further", () => {
  it("up is disabled on the first row of a group and down on the last (Partner: Ridge is first, Tidewell last, Marlow mid-group) - 6 checked", () => {
    const markup = listHtml(ROWS);
    const dis = (id: string, key: "moveUp" | "moveDown", name: string) => {
      const label = msg(`settings.org.sponsors.${key}`, { name });
      const tag = [...rowOf(markup, id).matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((b) => attrOf(b, "aria-label") === label)!;
      return attrOf(tag, "disabled") !== undefined;
    };
    expect(dis("s2", "moveUp", "Ridge Gold Physiotherapy"), "Ridge up: first in Partner").toBe(true);
    expect(dis("s2", "moveDown", "Ridge Gold Physiotherapy"), "Ridge down: Quay follows").toBe(false);
    expect(dis("s8", "moveUp", "Tidewell Garage"), "Tidewell up: Northbank precedes").toBe(false);
    expect(dis("s8", "moveDown", "Tidewell Garage"), "Tidewell down: last in Partner").toBe(true);
    expect(dis("s4", "moveUp", "Marlow & Daughters Bakery"), "Marlow up: mid group").toBe(false);
    expect(dis("s4", "moveDown", "Marlow & Daughters Bakery"), "Marlow down: mid group").toBe(false);
  });

  it("a sponsor ALONE in its group has no arrows at all - not a disabled pair (Harbourside is alone in Title); a group of two or more keeps both (owner, 2026-11-11)", () => {
    const markup = listHtml(ROWS);
    // The tray's buttons: the ⋯ toggle and a deal action live elsewhere on the row.
    const trayButtons = (id: string) => [...findOne(rowOf(markup, id), "sponsor-row-tools").outer.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    const buttonsOf = (id: string) => trayButtons(id).map((b) => attrOf(b, "aria-label"));
    const up = (name: string) => msg("settings.org.sponsors.moveUp", { name });
    const down = (name: string) => msg("settings.org.sponsors.moveDown", { name });
    // The negative, then its positive pair: the same markup gives the lone row nothing and a Partner row both.
    expect(buttonsOf("s1"), "Harbourside: only the delete").toEqual([msg("settings.org.sponsors.remove", { name: LONG_NAME })]);
    expect(buttonsOf("s1"), "no up").not.toContain(up(LONG_NAME));
    expect(buttonsOf("s1"), "no down").not.toContain(down(LONG_NAME));
    // `disabled` as an ATTRIBUTE: the delete's class list carries `disabled:opacity-30` in every row, so a substring scan is always true.
    expect(trayButtons("s1").map((b) => attrOf(b, "disabled")), "and nothing in its tray is a disabled button").toEqual([undefined]);
    expect(buttonsOf("s2"), "Ridge (Partner of seven): up, down, delete, in that order").toEqual([
      up("Ridge Gold Physiotherapy"), down("Ridge Gold Physiotherapy"), msg("settings.org.sponsors.remove", { name: "Ridge Gold Physiotherapy" }),
    ]);
    // Every row of every group: the arrows are there exactly where the group has two or more.
    let checked = 0;
    for (const m of MOCKUP) {
      const size = MOCKUP.filter((o) => o.group === m.group).length;
      const has = buttonsOf(m.s.id).includes(up(m.s.name));
      expect(has, `${m.s.name} (group ${m.group} of ${size})`).toBe(size > 1);
      expect(buttonsOf(m.s.id).includes(down(m.s.name)), `${m.s.name}: down goes with up`).toBe(size > 1);
      checked++;
    }
    expect(checked, "all eight rows").toBe(8);
  });

  it("the sequence: a group that grows from one to two gains its arrows, and the new second row's edge is disabled; shrinking back takes them away (flat list too)", () => {
    const solo = sponsor({ id: "g1", name: "Native Gold One", tier: "gold", display_order: 0 });
    const mate = sponsor({ id: "g2", name: "Native Gold Two", tier: "gold", display_order: 1 });
    const labels = (markup: string, id: string) => [...rowOf(markup, id).matchAll(/<button\b[^>]*>/g)].map((m) => attrOf(m[0], "aria-label"));
    const up = (name: string) => msg("settings.org.sponsors.moveUp", { name });
    const down = (name: string) => msg("settings.org.sponsors.moveDown", { name });
    let checked = 0;
    for (const hasTiers of [true, false]) {
      const one = listHtml([solo], { hasTiers });
      expect(labels(one, "g1"), `hasTiers=${hasTiers}: alone, no arrows`).not.toEqual(expect.arrayContaining([up(solo.name)]));
      const two = listHtml([solo, mate], { hasTiers });
      expect(labels(two, "g1"), `hasTiers=${hasTiers}: with a mate, the first row has both`).toEqual(expect.arrayContaining([up(solo.name), down(solo.name)]));
      expect(labels(two, "g2"), `hasTiers=${hasTiers}: and so does the second`).toEqual(expect.arrayContaining([up(mate.name), down(mate.name)]));
      const edge = (label: string) => attrOf([...rowOf(two, "g1").matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((b) => attrOf(b, "aria-label") === label)!, "disabled");
      expect(edge(up(solo.name)), `hasTiers=${hasTiers}: first row's up is the group's edge: present but disabled`).toBeDefined();
      expect(edge(down(solo.name)), `hasTiers=${hasTiers}: its down swaps with the mate`).toBeUndefined();
      checked++;
    }
    expect(checked, "tiered and flat").toBe(2);
  });

  it("the arrows carry the same words as their title and their accessible name: 'Move {name} up on your public board' - 4 locales x 2 arrows", () => {
    const NAME = "Ridge Gold Physiotherapy";
    let checked = 0;
    for (const locale of LOCALES) {
      const markup = renderToStaticMarkup(
        <DictProvider dict={DICT_BY_LOCALE[locale] as unknown as Dict} locale={locale}>
          <SponsorList {...listProps(ROWS)} />
        </DictProvider>,
      );
      const tags = [...rowOf(markup, "s2").matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
      for (const [key, dir] of [["moveUp", "up"], ["moveDown", "down"]] as const) {
        const label = words(locale, `settings.org.sponsors.${key}`, { name: NAME });
        const tag = tags.find((b) => attrOf(b, "aria-label") === label);
        expect(tag, `${locale} ${dir}: a button named ${label}`).toBeDefined();
        expect(attrOf(tag!, "title"), `${locale} ${dir}: the title is the same words`).toBe(label);
        expect(label.includes(NAME), `${locale} ${dir}: it names the sponsor`).toBe(true);
        checked++;
      }
    }
    expect(checked, "4 locales x up and down").toBe(8);
    // English, typed from the owner's words.
    const enMarkup = renderToStaticMarkup(<SponsorList {...listProps(ROWS)} />);
    const labels = [...rowOf(enMarkup, "s2").matchAll(/<button\b[^>]*>/g)].map((m) => attrOf(m[0], "aria-label"));
    expect(labels).toContain("Move Ridge Gold Physiotherapy up on your public board");
    expect(labels).toContain("Move Ridge Gold Physiotherapy down on your public board");
  });
});

describe("From md every row's tray is the same width, so the pencil, the deal and the controls stand in the same columns (owner, 2026-11-11)", () => {
  // Each row is its own grid: the name takes what is left (`1fr`), so the pencil and the deal cell sit where the tray's width leaves them.
  // The tray was as wide as its contents - "1 click" against "41 clicks", three buttons against one - and every row drifted. Now the
  // clicks box has one least width and a row without arrows keeps their room in a spacer. What a browser then DRAWS is measured in
  // `e2e/sponsor-deals.spec.ts` (x of the pencil, the deal cell, the clicks and the delete on every row); here, the markup that makes it so.
  const REM = (token: string): number => {
    const m = /^(?:md:)?(?:min-w|w)-\[(\d+(?:\.\d+)?)rem\]$/.exec(token) ?? /^(?:md:)?(?:min-w|w)-(\d+(?:\.\d+)?)$/.exec(token);
    if (!m) throw new Error(`not a width token: ${token}`);
    return token.includes("[") ? Number(m[1]) : Number(m[1]) * 0.25;
  };
  const trayOf = (markup: string, id: string) => findOne(rowOf(markup, id), "sponsor-row-tools");

  it("the clicks box has a least width from md and its words stand to the right - and not below md, where the tray wraps (8 rows)", () => {
    const markup = listHtml(ROWS);
    let checked = 0;
    for (const m of MOCKUP) {
      const tokens = classTokens(findOne(rowOf(markup, m.s.id), "sponsor-row-clicks").open);
      expect(tokens, `${m.s.name}: a least width from md`).toContain("md:min-w-[5rem]");
      expect(tokens, `${m.s.name}: words to the right from md`).toContain("md:text-right");
      // Whole tokens: an unprefixed `min-w-[5rem]` would hold a phone's tray open too.
      expect(tokens, `${m.s.name}: no least width below md`).not.toContain("min-w-[5rem]");
      expect(tokens, `${m.s.name}: nor right-aligned below md`).not.toContain("text-right");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("a sponsor alone in its group keeps the arrows' room in an aria-hidden spacer with nothing in it; a group of two or more has none (8 rows, one spacer: Harbourside)", () => {
    const markup = listHtml(ROWS);
    let withSpacer: string[] = [];
    let checked = 0;
    for (const m of MOCKUP) {
      const tray = trayOf(markup, m.s.id);
      const spacers = findAll(tray.outer, "sponsor-row-move-spacer");
      const size = MOCKUP.filter((o) => o.group === m.group).length;
      expect(spacers.length, `${m.s.name} (group ${m.group} of ${size}): a spacer exactly when alone`).toBe(size === 1 ? 1 : 0);
      if (spacers.length === 1) {
        withSpacer = [...withSpacer, m.s.id];
        const sp = spacers[0]!;
        expect(attrOf(sp.open, "aria-hidden"), "hidden from the accessibility tree").toBe("true");
        expect(sp.open.startsWith("<div "), "a plain block, not a control").toBe(true);
        // Nothing to reach inside it: no button, link, field, tab stop, or any words.
        expect(sp.outer, "it is empty").toBe(`${sp.open}</div>`);
        expect(attrOf(sp.open, "tabindex"), "no tab stop").toBeUndefined();
        expect(attrOf(sp.open, "role"), "no role").toBeUndefined();
        const tokens = classTokens(sp.open);
        expect(tokens, "gone below md").toContain("max-md:hidden");
        expect(tokens, "does not shrink").toContain("shrink-0");
      }
      // The arrows stay ABSENT in the tray as a whole - the spacer is not hidden buttons.
      if (size === 1) {
        const labels = [...tray.outer.matchAll(/<button\b[^>]*>/g)].map((b) => attrOf(b[0], "aria-label"));
        expect(labels, `${m.s.name}: only the delete`).toEqual([msg("settings.org.sponsors.remove", { name: m.s.name })]);
      }
      checked++;
    }
    expect(checked, "all eight rows").toBe(8);
    expect(withSpacer, "premise: Harbourside is the only sponsor alone in its group").toEqual(["s1"]);
  });

  it("a viewer's tray has no spacer (it has no arrows to make room for), and its rows still match each other (8 rows)", () => {
    const markup = listHtml(ROWS, { canEdit: false });
    let checked = 0;
    for (const m of MOCKUP) {
      expect(findAll(rowOf(markup, m.s.id), "sponsor-row-move-spacer"), m.s.name).toHaveLength(0);
      expect(classTokens(findOne(rowOf(markup, m.s.id), "sponsor-row-clicks").open), `${m.s.name}: the same least width`).toContain("md:min-w-[5rem]");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the spacer is the width of what it stands in for, and every editor row's tray adds up to the same width (clicks box + controls + gaps; 8 rows)", () => {
    const markup = listHtml(ROWS);
    // Read from the markup of the neighbours, not typed here: an arrow is `w-7`, the tray's gap is `gap-1`, the clicks box has its least width.
    const arrowToken = classTokens(
      [...trayOf(markup, "s2").outer.matchAll(/<button\b[^>]*>/g)].map((b) => b[0]).find((b) => attrOf(b, "aria-label") === msg("settings.org.sponsors.moveUp", { name: "Ridge Gold Physiotherapy" }))!,
    ).find((t) => /^w-\d/.test(t));
    expect(arrowToken, "premise: an arrow button has a width token").toBeDefined();
    const arrow = REM(arrowToken!);
    const gapToken = classTokens(trayOf(markup, "s2").open).find((t) => /^gap-\d/.test(t));
    expect(gapToken, "premise: the tray has a gap token").toBeDefined();
    const gap = Number(gapToken!.slice(4)) * 0.25;
    const spacerToken = classTokens(findOne(rowOf(markup, "s1"), "sponsor-row-move-spacer").open).find((t) => t.startsWith("md:w-"));
    expect(spacerToken, "premise: the spacer has a width from md").toBeDefined();
    expect(REM(spacerToken!), "two arrows and the gap between them").toBeCloseTo(2 * arrow + gap, 5);

    const totals = new Map<string, number>();
    for (const m of MOCKUP) {
      const tray = trayOf(markup, m.s.id);
      const clicksBox = REM(classTokens(findOne(tray.outer, "sponsor-row-clicks").open).find((t) => t.startsWith("md:min-w-"))!);
      const buttons = [...tray.outer.matchAll(/<button\b[^>]*>/g)].length;
      const spacer = findAll(tray.outer, "sponsor-row-move-spacer").length;
      const items = 1 + buttons + spacer;
      totals.set(m.s.id, clicksBox + buttons * arrow + spacer * REM(spacerToken!) + (items - 1) * gap);
    }
    expect(totals.size, "all eight rows were summed").toBe(8);
    expect([...new Set(totals.values())].map((v) => Number(v.toFixed(4))), "one width for every row").toHaveLength(1);
    // Premise that makes the sum able to differ: the rows really are built differently (three buttons against one and a spacer).
    expect(new Set(MOCKUP.map((m) => findAll(trayOf(markup, m.s.id).outer, "sponsor-row-move-spacer").length)).size, "both shapes are in the fixture").toBe(2);
  });

  it("the deal column is 13rem from md and 18rem from lg, on every row, so the name keeps 164px at 768 (the name was cut to 84px with 18rem) - 8 rows", () => {
    // The track, not the name: a unit test cannot lay a row out. What was MEASURED on a build (768px viewport, real page chrome): the grid's
    // content is 660px wide, the logo, pencil, tray (11rem) and four 12px gaps leave 660 - 36 - 28 - 176 - 48 = 372px for the name and the deal
    // cell, so a 288px deal cell left the name 84px and a 208px one leaves it 164px (the owner's floor is 160). The width is a rem value read
    // off the markup, and the arithmetic below is the check that it stays inside the floor.
    const markup = listHtml(ROWS);
    const REM_PER_STEP = 0.25; // Tailwind's spacing scale: w-N is N * 0.25rem
    // What was measured at 768 (the numbers in the comment above): the grid, then what is not the name or the deal cell.
    const GRID_PX = 660, LOGO_PX = 36, PENCIL_PX = 28, TRAY_PX = 11 * 16, GAPS_PX = 4 * 12;
    const AVAILABLE_AT_768_PX = GRID_PX - LOGO_PX - PENCIL_PX - TRAY_PX - GAPS_PX;
    const NAME_FLOOR_PX = 160; // the owner's floor
    expect(AVAILABLE_AT_768_PX, "premise: the measured 372px for the name and the deal cell").toBe(372);
    let checked = 0;
    for (const m of MOCKUP) {
      const tokens = classTokens(findOne(rowOf(markup, m.s.id), "sponsor-row-deal").open);
      expect(tokens, `${m.s.name}: 13rem from md`).toContain("md:w-52");
      expect(tokens, `${m.s.name}: 18rem from lg, as it was`).toContain("lg:w-72");
      expect(tokens, `${m.s.name}: not 18rem at md any more`).not.toContain("md:w-72");
      // The cell's width at md is the token the row RENDERS, parsed - not a number typed beside the assertion above, which would stay true
      // whatever the row drew.
      const mdTokens = tokens.filter((t) => /^md:w-\d+$/.test(t));
      expect(mdTokens, `${m.s.name}: exactly one md width token`).toHaveLength(1);
      const mdPx = Number(mdTokens[0]!.slice("md:w-".length)) * REM_PER_STEP * 16;
      expect(AVAILABLE_AT_768_PX - mdPx, `${m.s.name}: the name column at 768 (${mdTokens[0]} = ${mdPx}px) stays at or above the owner's floor`).toBeGreaterThanOrEqual(NAME_FLOOR_PX);
      checked++;
    }
    expect(checked, "all eight rows").toBe(8);
  });

  it("the sequence: a group that grows from one to two loses its spacer and gains its arrows; a flat list of one has the spacer too", () => {
    const solo = sponsor({ id: "g1", name: "Native Gold One", tier: "gold", display_order: 0 });
    const mate = sponsor({ id: "g2", name: "Native Gold Two", tier: "gold", display_order: 1 });
    let checked = 0;
    for (const hasTiers of [true, false]) {
      const one = listHtml([solo], { hasTiers });
      expect(findAll(one, "sponsor-row-move-spacer"), `hasTiers=${hasTiers}: alone, a spacer`).toHaveLength(1);
      const two = listHtml([solo, mate], { hasTiers });
      expect(findAll(two, "sponsor-row-move-spacer"), `hasTiers=${hasTiers}: with a mate, none`).toHaveLength(0);
      expect([...two.matchAll(/<button\b[^>]*aria-label="Move /g)].length, `hasTiers=${hasTiers}: and four arrows`).toBe(4);
      checked++;
    }
    expect(checked, "tiered and flat").toBe(2);
  });
});

describe("Move: neighbours swap only when they share a STORED tier (the server orders by it - review I1)", () => {
  // Server order is stored tier, then display_order. G1 and G2 are native gold; P is a PARTNER whose waiting deal is gold. With tiers
  // the groups are stored-tier bands (owner, 2026-11-11), so P is drawn in Partner and the pair G1 / G2 is the whole Gold group; the
  // plan WITHOUT tiers draws one flat list, where the stored-tier boundary between G2 and P is real and the arrows must respect it.
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

  it("premise: with tiers the partner with a gold deal is drawn in PARTNER, not Gold; Gold holds the two native golds", () => {
    const groups = findAll(listHtml(MIXED), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["gold", "partner"]);
    expect(findAll(groups[0]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["g1", "g2"]);
    expect(findAll(groups[1]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["p1"]);
  });

  it("with tiers: the two golds swap with each other and stop at the group's edges; P is alone in Partner and has NO arrows (4 checked + 2 absent)", () => {
    const markup = listHtml(MIXED);
    expect(disabled(markup, "g1", "moveUp", G1.name), "G1 up: first in Gold").toBe(true);
    expect(disabled(markup, "g1", "moveDown", G1.name), "G1 down: its neighbour G2 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveUp", G2.name), "G2 up: its neighbour G1 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveDown", G2.name), "G2 down: last in Gold").toBe(true);
    const pButtons = [...findOne(rowOf(markup, "p1"), "sponsor-row-tools").outer.matchAll(/<button\b[^>]*>/g)].map((m) => attrOf(m[0], "aria-label"));
    expect(pButtons, "P: alone in Partner, so only the delete - no disabled pair").toEqual([msg("settings.org.sponsors.remove", { name: P.name })]);
  });

  it("without tiers (one flat list, the server's order) the arrows between a native gold and the partner are disabled; the arrows between two native golds are not (4 checked)", () => {
    const markup = listHtml(MIXED, { hasTiers: false });
    expect(disabled(markup, "g1", "moveDown", G1.name), "G1 down: its neighbour G2 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveUp", G2.name), "G2 up: its neighbour G1 shares the stored tier").toBe(false);
    expect(disabled(markup, "g2", "moveDown", G2.name), "G2 down: its neighbour P is stored partner").toBe(true);
    expect(disabled(markup, "p1", "moveUp", P.name), "P up: its neighbour G2 is stored gold").toBe(true);
  });

  it("a call that gets past the disabled arrow still sends no reorder across stored tiers (the flat list); the legal swap beside it does send one", async () => {
    const m = mount(MIXED, { hasTiers: false });
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

  it("with tiers the edge click sends nothing too (the group's last row), P has no arrow to click, and the golds' swap sends one", async () => {
    const m = mount(MIXED);
    m.click(msg("settings.org.sponsors.moveDown", { name: G2.name }));
    expect(() => m.byLabel(msg("settings.org.sponsors.moveUp", { name: P.name })), "P is alone in Partner: no up arrow in the tree").toThrow(/no control labelled/);
    expect(() => m.byLabel(msg("settings.org.sponsors.moveDown", { name: P.name })), "and no down arrow").toThrow(/no control labelled/);
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/sponsors/reorder"))).toHaveLength(0);
    m.click(msg("settings.org.sponsors.moveDown", { name: G1.name }));
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/sponsors/reorder")).map((c) => c.body)).toEqual([{ ids: ["g2", "g1", "p1"] }]);
  });
});

describe("Move: a row whose waiting deal is another tier keeps its place in its own stored group (owner, 2026-11-11)", () => {
  // X, B and Z are all STORED gold, in the server's order X (0), B (5), Z (9). B has a SILVER deal waiting. It used to be drawn in Silver
  // (its deal's tier), leaving X and Z side by side in Gold with B between them in the stored list; now the group is the stored tier,
  // so B stays between them and says "Silver when live".
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

  it("premise: all three are drawn in Gold, in the stored order, and B carries the 'Silver when live' hint", () => {
    const groups = findAll(listHtml(GAP), "sponsor-group");
    expect(groups.map((g) => attrOf(g.open, "data-tier"))).toEqual(["gold"]);
    expect(findAll(groups[0]!.outer, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["x", "b", "z"]);
    expect(findAll(rowOf(listHtml(GAP), "b"), "sponsor-row-tier-hint").map((h) => textOfMarkup(h.outer))).toEqual(["Silver when live"]);
  });

  it("X can move down, Z up, B both ways; X up and Z down are the group's edges (6 checked)", () => {
    const markup = listHtml(GAP);
    expect(enabled(markup, "x", "moveUp", X.name), "X is first in Gold").toBe(false);
    expect(enabled(markup, "x", "moveDown", X.name), "X down: B shares the stored tier").toBe(true);
    expect(enabled(markup, "b", "moveUp", B.name), "B up: X shares the stored tier").toBe(true);
    expect(enabled(markup, "b", "moveDown", B.name), "B down: Z shares the stored tier").toBe(true);
    expect(enabled(markup, "z", "moveUp", Z.name), "Z up: B shares the stored tier").toBe(true);
    expect(enabled(markup, "z", "moveDown", Z.name), "Z is last in Gold").toBe(false);
  });

  it("X down posts the whole order with X and B exchanged: ids [b, x, z]", async () => {
    const m = mount(GAP);
    m.click(msg("settings.org.sponsors.moveDown", { name: X.name }));
    await flush();
    const reorder = calls.filter((c) => c.url.endsWith("/sponsors/reorder"));
    expect(reorder).toHaveLength(1);
    expect(reorder[0]!.body).toEqual({ ids: ["b", "x", "z"] });
  });
});

// --- the island: the writes the actions make ---------------------------------------------------------------------------------------

const HUB: SponsorsHubData = {
  orgSlug: SLUG, orgTimezone: null, deals: [], packages: [], tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize: true, monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [],
  chargesEnabled: true, sponsorId: null, editSponsor: false, dealId: null, dealCreatedByName: null, dealWrittenOffByName: null, dealCompetitionFinished: false, reportLinks: [], reportDefaults: null,
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
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url), "the list is re-read").toEqual([`/api/v1/orgs/${ORG}/sponsors?archived=1`]);
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
    // Task 23's words: a resend says its new email replaces the earlier link (the deal's invoice was already sent).
    expect(propsOf(after[0]!).children).toBe("Invoice sent again for Ridge Gold Physiotherapy. The new email replaces the earlier link.");
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

describe("Move reorders within the GROUP the row is drawn in (the sponsor's own tier), and persists the global order", () => {
  it("moving Marlow up swaps it with Quay (both in Partner) and POSTs the whole order with them swapped", async () => {
    const m = mount(ROWS);
    m.click(msg("settings.org.sponsors.moveUp", { name: "Marlow & Daughters Bakery" }));
    await flush();
    const reorder = calls.find((c) => c.url === `/api/v1/orgs/${ORG}/sponsors/reorder`);
    expect(reorder?.body).toEqual({ ids: ["s1", "s2", "s4", "s3", "s5", "s6", "s7", "s8"] });
  });

  it("a partner sponsor with a waiting gold deal moves with the PARTNER group: first in it, so Up is disabled and Down swaps it with Quay", async () => {
    const m = mount(ROWS);
    const up = m.byLabel(msg("settings.org.sponsors.moveUp", { name: "Ridge Gold Physiotherapy" }));
    expect(propsOf(up).disabled, "first in Partner").toBe(true);
    const down = m.byLabel(msg("settings.org.sponsors.moveDown", { name: "Ridge Gold Physiotherapy" }));
    expect(propsOf(down).disabled, "Quay follows it in Partner").toBe(false);
    m.click(msg("settings.org.sponsors.moveDown", { name: "Ridge Gold Physiotherapy" }));
    await flush();
    const reorder = calls.find((c) => c.url === `/api/v1/orgs/${ORG}/sponsors/reorder`);
    expect(reorder?.body).toEqual({ ids: ["s1", "s3", "s2", "s4", "s5", "s6", "s7", "s8"] });
  });
});

describe("Add and Edit ask for a name, a logo and a link - and nothing else (spec §6.1; owner, 2026-11-11)", () => {
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

  it("the EDIT form, opened by the pencil's URL, asks for the same three things and no tier or competition either (owner, 2026-11-11), on a plan WITH tiers", () => {
    const m = mount(ROWS, { hasTiers: true, hub: { ...HUB, sponsorId: "s2", editSponsor: true } });
    const form = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined);
    expect(form, "premise: the sponsor page's editor is open on arrival").toBeDefined();
    expect(propsOf(form!).value, "and it opens on THIS sponsor's name").toMatchObject({ name: "Ridge Gold Physiotherapy" });
    const markup = renderToStaticMarkup(form!);
    expect(markup, "no tier or competition select").not.toContain("<select");
    expect(markup).toContain(msg("settings.org.sponsors.name"));
    expect(markup).toContain(msg("settings.org.sponsors.link"));
    expect(markup).toContain(msg("sponsors.logoLabel"));
    // the pair: the editor is the form (a Cancel), not the add box
    expect(propsOf(form!).onCancel).toBeDefined();
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
    ["sponsors.logoHint", ["formats", "mb"]],
  ];
  const DICTS: Record<string, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };

  it("every key is a non-empty string in en / es / fr / nl and names the same {placeholders} in each (18 keys x 4 locales)", () => {
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
    expect(checked).toBe(72);
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
    // The tier scopes come from the hub too, per scope (an Event Pass lifts its own competition): the other value arrives, not the first one's.
    const pass = mount(ROWS, { hub: { ...HUB_WITH_PACKAGES, tiersOrgWide: false, tiersCompetitionIds: ["c1"] } });
    pass.click("Add deal: Northbank Print");
    const ps = propsOf(sheetsIn(pass)[0]!);
    expect([ps.tiersOrgWide, ps.tiersCompetitionIds], "an Event Pass on one competition").toEqual([false, ["c1"]]);
    expect([p.tiersOrgWide, p.tiersCompetitionIds], "the hub's own, a paid plan").toEqual([HUB_WITH_PACKAGES.tiersOrgWide, HUB_WITH_PACKAGES.tiersCompetitionIds]);
    // The list's own org-level `hasTiers` (an affordance for its tier groups) is NOT what the sheet places by: it never receives it.
    const noTiers = mount(ROWS, { hub: HUB_WITH_PACKAGES, hasTiers: false });
    noTiers.click("Add deal: Northbank Print");
    expect(propsOf(sheetsIn(noTiers)[0]!).hasTiers, "the sheet reads the hub's per-scope answer, not the org-level flag").toBeUndefined();
    expect(p.orgSlug).toBe(SLUG);
    expect(p.deals, "the org's deals feed the 'already has one' confirm").toEqual(HUB_WITH_PACKAGES.deals);
    expect(p.competitions).toBe(COMPS);
    expect(POSTS(), "opening the sheet writes nothing").toEqual([]);
    expect(calls, "and reads nothing").toEqual([]);
    (p.onClose as () => void)();
    expect(sheetsIn(m), "closed again").toHaveLength(0);
  });

  it("onCreate POSTs the body as given to /sponsors/{id}/deals, re-reads the list and the deals, and says what happened (offline -> 'Deal saved')", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 201, body: { data: { deal: {}, invoice_url: null } } });
    const m = mount(ROWS, { hub: HUB_WITH_PACKAGES });
    m.click("Add deal: Northbank Print");
    await (propsOf(sheetsIn(m)[0]!).onCreate as (b: CreateDealBody) => Promise<void>)(BODY);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: `/api/v1/orgs/${ORG}/sponsors/s7/deals`, method: "POST", body: BODY }]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url).sort()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals`, `/api/v1/orgs/${ORG}/sponsors?archived=1`]);
    expect(m.text()).toContain("Deal saved for Northbank Print.");
  });

  it("an online deal says the invoice went out", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 201, body: { data: { deal: {}, invoice_url: "https://app.example/r/sponsor/invoice/tok_abcdefghijklmnopqrstuvwx" } } });
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

  it("an ONLINE Stripe refusal RESOLVES (the deal may be saved, so the sheet must close) and the page says it: its own words for a draft and for a deal that is live (both name Send invoice: nothing went out), 'look at the deals' when the current deal was being ended", async () => {
    answer = (url, method) =>
      method === "POST" ? { status: 502, body: { ok: false, error: { code: "stripe_unavailable", message: "server english" } } } : { status: 200, body: { data: ROWS } };
    // Expected words from the lifecycle table (a draft offers send_invoice; a live/scheduled deal offers resend_invoice, which reads
    // Send invoice while nothing has gone out - final review m1, re-review N1) and the create's own Stripe calls.
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
    // The two sentences differ, or the key split above proves nothing (add-deal-sheet.test.tsx reads the button each one names).
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

// --- an ended deal still due (T24 m8): the row says so and puts the money first ---------------------------------------------------------

describe("an ended deal still due: 'Ended · unpaid', Mark as paid, and a new deal only once it is settled (T24 m8)", () => {
  /** An OFFLINE deal that went live, then ended unpaid because its term ran out - the sponsor had the placement, so the money is owed. */
  const due = (over: Partial<SponsorDeal> = {}, id = "u1", name = "Quay Chandlers") =>
    sponsor({
      id, name, status: "inactive",
      deal: deal({
        id: `d-${id}`, sponsor_id: id, deal_status: "ended", payment_status: "pending", payment_method: "offline", package_name: "Partner",
        tier: "partner", amount_cents: 30_000, live_at: "2026-08-01T12:00:00.000Z", ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired", ...over,
      }),
    });

  it("the row's chip reads Ended · unpaid and its one action is Mark as paid (a button named for the sponsor); the sub-line still says when it ended", () => {
    const row = rowOf(listHtml([due()]), "u1");
    expect(textOfMarkup(findOne(row, "deal-chip").outer)).toBe("Ended · unpaid");
    const actions = findAll(row, "sponsor-row-action");
    expect(actions, "exactly one action").toHaveLength(1);
    expect(attrOf(actions[0]!.open, "data-action")).toBe("mark_paid");
    expect(textOfMarkup(actions[0]!.outer)).toBe("Mark as paid");
    expect(attrOf(actions[0]!.open, "aria-label")).toBe("Mark as paid: Quay Chandlers");
    expect(actions[0]!.open.startsWith("<button "), "a write, so a button").toBe(true);
    expect(textOfMarkup(findOne(row, "sponsor-row-sub").outer)).toBe("Partner · £300 · Ended 31 Aug");
    // The empty case's pair: no row of the list offers Add deal where the money is still owed.
    expect(textOfMarkup(row)).not.toContain("Add deal");
  });

  it("every ended deal that is NOT due keeps plain 'Ended' and Add deal (the pair; 5 rows checked)", () => {
    const NOT_DUE: [string, Partial<SponsorDeal>][] = [
      ["paid", { payment_status: "paid" }],
      ["the club ended it (End now)", { ended_reason: "ended_now" }],
      ["it never went live", { live_at: null }],
      ["an online deal", { payment_method: "online" }],
      ["written off", { ended_reason: "written_off" }],
    ];
    let checked = 0;
    for (const [label, over] of NOT_DUE) {
      const row = rowOf(listHtml([due(over)]), "u1");
      expect(textOfMarkup(findOne(row, "deal-chip").outer), label).toBe("Ended");
      expect(attrOf(findOne(row, "sponsor-row-action").open, "data-action"), label).toBe("add_deal");
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a viewer sees the chip and no button", () => {
    const row = rowOf(listHtml([due()], { canEdit: false }), "u1");
    expect(textOfMarkup(findOne(row, "deal-chip").outer)).toBe("Ended · unpaid");
    expect(findAll(row, "sponsor-row-action")).toHaveLength(0);
  });

  it("tapping Mark as paid asks in the ended deal's words (it stays ended, the invoice reads Paid), then POSTs that deal's mark-paid", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [due()] } } : { status: 200, body: { data: {} } });
    const m = mount([due()]);
    m.click("Mark as paid: Quay Chandlers");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0]![0] as { title: string; body: string };
    expect(asked.title).toBe("Record £300 from Quay Chandlers as received?");
    expect(asked.body, "the ended deal's body, not the go-live rule's").toBe(msg("sponsors.deal.markPaid.bodyEnded"));
    expect(asked.body).not.toContain("go-live rule");
    expect(POSTS()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals/d-u1/mark-paid`]);
  });
});
