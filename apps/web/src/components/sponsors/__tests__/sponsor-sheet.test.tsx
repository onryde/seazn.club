// Sponsor deals PR 2, Task 15 - a sponsor's own page (components/sponsors/sponsor-sheet.tsx; spec §6.2, mockup screen 2 "option B"):
// details, deals and report link, opened from `?sponsor=<id>`; the page body below md, a side panel from md.
//
// Every expectation is typed from the brief, the spec or the engine's own declarations (`allowedActions`, `dealChip`) - never read
// back from the component. vitest is `environment: "node"`: the body's markup is read from `renderToStaticMarkup` (classes, ids,
// the words), a click is the element's own handler called in the tree `_sponsor-tree.tsx` expands (SponsorSheetBody is stateless;
// every bit of state is OrgSponsors'), and the one stateful leaf (the report link) is driven with its own `renderIsland`. What none
// of that can see (CSS, real widths, a real tap, the panel over the list) is `e2e/sponsor-deals.spec.ts`, run by CI.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   S1  editor          render a tier <select> in the sponsor page's editor                       -> "the editor has no tier or competition control"
//   S1b placement note  drop the placement note (hasTiers, not locked)                              -> "a deal sets the tier: the note"
//   S2  F28 live        show the 'Tier now' line for a live deal                                  -> "a live deal: no 'Tier now' line"
//   S3  F28 open        drop the 'Tier now' line for an open deal                                 -> "an open deal: the line"
//   S4  actions         draw every action on every deal (ignore allowedActions)                   -> "buttons are allowedActions"
//   S5  not the row     act on the ROW's deal instead of the deal whose button was tapped         -> "Mark as paid on a deal the row does not show"
//   S6  money           End now drops the paid-kept sentence for a LIVE paid deal                 -> "End now on a LIVE paid deal"
//   S7  stream          the stream toggle PATCHes while locked                                    -> "locked: nothing is sent"
//   S8  filter          list every sponsor's deals                                                -> "only this sponsor's deals"
//   S9  wrapper         md and up: render the body without the side Modal                         -> "from md: ONE Modal, side"
//   S10 close           the suspended wrapper still navigates                                     -> "Escape while Add deal is open"
//   S11 seam            the report section ignores hub.reportLinks                                -> "hub.reportLinks reaches ShareReport"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
const mdUp = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/components/ui/use-md-up", () => ({ useMdUp: () => mdUp.value }));

import { OrgSponsors, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { Modal } from "@/components/modal";
import { AddDealSheet } from "@/components/sponsors/add-deal-sheet";
import { ShareReport } from "@/components/sponsors/share-report";
import {
  ReportLinkSection,
  SponsorSheet,
  SponsorSheetBody,
  sponsorDealGroups,
  type SponsorSheetBodyProps,
} from "@/components/sponsors/sponsor-sheet";
import { canShowAgain, SponsorList } from "@/components/sponsors/sponsor-list";
import { SponsorRowMore } from "@/components/sponsors/sponsor-row-more";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "./_sponsor-tree";
import { attrOf, classTokens, findAll, findOne, textOfMarkup } from "./_markup";
import {
  allowedActions, DEAL_STATUSES, GO_LIVE_RULES, PAYMENT_METHODS, PAYMENT_STATUSES, initialPaymentStatus, type SponsorDeal,
} from "@/lib/sponsor-deals";
import type { ReportLinkDefaults, ReportLinkSummary } from "@/lib/sponsor-report";
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
const LIST_URL = `/o/${SLUG}/sponsors?tab=sponsors`;

// --- fixtures --------------------------------------------------------------------------------------------------------------------

const DEAL: SponsorDeal = {
  id: "d0", sponsor_id: "s0", package_id: "p0", deal_status: "live", payment_status: "paid", payment_method: "online",
  go_live: "on_payment", package_name: "Partner", tier: "partner", includes_on_stream: false, competition_id: null,
  amount_cents: 12_000, currency: "gbp", sponsor_name: "x", sponsor_email: "accounts@example.com", ends_at: null,
  created_at: "2026-10-01T09:00:00.000Z", created_by: null, invoice_sent_at: null, paid_at: null, marked_paid_by: null,
  approved_at: null, approved_by: null, live_at: null, ended_at: null, ended_reason: null, parked_at: null, disputed_at: null,
  dispute_id: null, has_payment_intent: false, invoice_number: null,
};
const deal = (over: Partial<SponsorDeal>): SponsorDeal => ({ ...DEAL, sponsor_id: "a", ...over });

const sponsor = (over: Partial<SponsorItem> = {}): SponsorItem => ({
  id: "a", name: "Ridge Gold Physiotherapy", competition_id: null, url: "https://ridgegoldphysio.co.uk/", logo_path: null,
  tier: "partner", display_order: 0, status: "active", click_count: 12, on_stream: false, paid_order_id: null, deal: null,
  locked_by_deal: false, has_open_deal: false, last_billing_email: null, ...over,
});

const DEFAULTS: ReportLinkDefaults = { from: "2026-01-01", to: "2026-11-09", competitionId: null };
const LINK: ReportLinkSummary = {
  id: "l1", sponsorId: "a", competitionId: null, competitionName: null, from: "2026-01-01", to: "2026-06-30",
  createdAt: "2026-07-01T10:00:00.000Z",
};

const noop = () => {};
function bodyProps(over: Partial<SponsorSheetBodyProps> = {}): SponsorSheetBodyProps {
  return {
    sponsor: sponsor(), deals: [], orgId: ORG, orgSlug: SLUG, hasTiers: true, canEdit: true, busy: false, tz: "UTC", competitions: COMPS,
    editing: false, renderEditor: () => <p data-testid="editor-stub">editor</p>, onEdit: noop, onToggleStream: noop, onShowAgain: noop,
    onAddDeal: noop, onDealAction: noop, error: null, notice: null, payLink: null, reportLinks: [], reportDefaults: DEFAULTS, ...over,
  };
}
const bodyHtml = (over: Partial<SponsorSheetBodyProps> = {}) => renderToStaticMarkup(<SponsorSheetBody {...bodyProps(over)} />);
const dealsIn = (markup: string) => findAll(markup, "sponsor-sheet-deal");
const idsIn = (markup: string) => dealsIn(markup).map((d) => attrOf(d.open, "data-deal-id"));

beforeEach(() => {
  vi.clearAllMocks();
  mdUp.value = null;
});

// --- the wrapper: a page below md, a side panel from md --------------------------------------------------------------------------

describe("the wrapper: ONE body, in a page below md and in a side Modal from md", () => {
  const props = (over: Partial<Parameters<typeof SponsorSheet>[0]> = {}) => ({
    title: "Sponsor", backText: "Sponsors", backLabel: "Back to sponsors", closeHref: LIST_URL, suspended: false,
    children: <p data-testid="the-body">body</p>, ...over,
  });
  const count = (tree: ReactElement[], testid: string) => tree.filter((e) => propsOf(e)["data-testid"] === testid).length;

  it("from md: ONE Modal, placement side, titled, with the body once; a close navigates to the list URL", () => {
    mdUp.value = true;
    const island = renderIsland(SponsorSheet, props());
    const tree = island.tree();
    const modals = tree.filter((e) => e.type === Modal);
    expect(modals, "exactly one Modal").toHaveLength(1);
    expect(propsOf(modals[0]!).placement).toBe("side");
    expect(propsOf(modals[0]!).title).toBe("Sponsor");
    expect(count(tree, "the-body"), "the body once").toBe(1);
    expect(count(tree, "sponsor-sheet-back"), "the panel has its own close, no back link").toBe(0);
    (propsOf(modals[0]!).onClose as () => void)();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith(LIST_URL);
  });

  it("below md: no Modal; the body is the page, with a back link to the list that is a 44px target", () => {
    mdUp.value = false;
    const tree = renderIsland(SponsorSheet, props()).tree();
    expect(tree.filter((e) => e.type === Modal)).toHaveLength(0);
    expect(count(tree, "the-body"), "the body once").toBe(1);
    const page = tree.find((e) => propsOf(e)["data-testid"] === "sponsor-sheet-page")!;
    expect(String(propsOf(page).className ?? ""), "visible: a phone shows it").not.toContain("md:hidden");
    const back = tree.find((e) => propsOf(e)["data-testid"] === "sponsor-sheet-back")!;
    expect(propsOf(back).href).toBe(LIST_URL);
    expect(propsOf(back)["aria-label"]).toBe("Back to sponsors");
    expect(String(propsOf(back).className)).toContain("min-h-11");
    expect(flat(textOf(propsOf(back).children as never)), "its words").toBe("Sponsors");
  });

  it("before the browser is asked (the server render, hydration): the phone body, hidden from md up so a desktop never flashes it", () => {
    mdUp.value = null;
    const tree = renderIsland(SponsorSheet, props()).tree();
    expect(tree.filter((e) => e.type === Modal)).toHaveLength(0);
    expect(count(tree, "the-body"), "the body is in the server's markup (the smoke row reads it)").toBe(1);
    const page = tree.find((e) => propsOf(e)["data-testid"] === "sponsor-sheet-page")!;
    expect(String(propsOf(page).className).split(/\s+/), "hidden from md up, anchored on the whole token").toContain("md:hidden");
  });

  it("Escape while Add deal is open (suspended): a close aimed at the sponsor sheet does nothing", () => {
    mdUp.value = true;
    const modal = renderIsland(SponsorSheet, props({ suspended: true })).tree().find((e) => e.type === Modal)!;
    (propsOf(modal).onClose as () => void)();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

// --- Details: F28 ----------------------------------------------------------------------------------------------------------------

const LIVE_DEAL = deal({ id: "dl", deal_status: "live", payment_status: "paid", tier: "gold", competition_id: "c-season", package_name: "Gold Season" });

describe("Details: a LIVE deal owns the tier, scope and stream; an OPEN deal changes them later; nothing else owns them (F28, D9)", () => {
  const OPEN_DEAL = deal({ id: "do", deal_status: "awaiting_payment", payment_status: "pending", tier: "gold", package_name: "Gold Season" });
  const ENDED_DEAL = deal({ id: "de", deal_status: "ended", payment_status: "paid", tier: "gold", ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" });

  // The sponsor's STORED tier differs from the deal's in every case that has one, so a component that read the wrong source
  // (the stored tier for a live deal, the deal's for a closed one) shows the wrong word.
  const CASES: { label: string; s: SponsorItem; deals: SponsorDeal[]; shownTier: string; shownScope: string; note: boolean; tierNow: boolean; stream: "locked" | "free" }[] = [
    { label: "a live deal", s: sponsor({ tier: "partner", locked_by_deal: true, deal: LIVE_DEAL }), deals: [LIVE_DEAL], shownTier: "Gold", shownScope: "Season 2026/27", note: true, tierNow: false, stream: "locked" },
    { label: "an open deal", s: sponsor({ tier: "partner", has_open_deal: true, status: "inactive", deal: OPEN_DEAL }), deals: [OPEN_DEAL], shownTier: "Partner", shownScope: "All competitions", note: false, tierNow: true, stream: "free" },
    { label: "no deal", s: sponsor({ tier: "silver", deal: null }), deals: [], shownTier: "Silver", shownScope: "All competitions", note: false, tierNow: false, stream: "free" },
    { label: "every deal ended", s: sponsor({ tier: "silver", status: "inactive", deal: ENDED_DEAL }), deals: [ENDED_DEAL], shownTier: "Silver", shownScope: "All competitions", note: false, tierNow: false, stream: "free" },
  ];

  it("the four cases show the right source, the lock note only for a live deal, and 'Tier now X. Y when the deal goes live' only for an open one (4 checked)", () => {
    let checked = 0;
    for (const c of CASES) {
      const markup = bodyHtml({ sponsor: c.s, deals: c.deals });
      expect(textOfMarkup(findOne(markup, "sponsor-sheet-detail-tier").outer).startsWith(c.shownTier), `${c.label}: tier`).toBe(true);
      expect(textOfMarkup(findOne(markup, "sponsor-sheet-detail-scope").outer), `${c.label}: scope`).toBe(c.shownScope);
      expect(findAll(markup, "sponsor-sheet-locked-note").length, `${c.label}: lock note`).toBe(c.note ? 1 : 0);
      if (c.note) expect(textOfMarkup(findOne(markup, "sponsor-sheet-locked-note").outer)).toBe(msg("sponsors.deal.lockedNote"));
      // Owner, 2026-11-11: the tier and scope are read-only, and a deal sets them. The lock note says so for a live deal; every other
      // case (hasTiers) carries the placement note instead - never both, never neither. Typed from the brief, not read from the page.
      expect(findAll(markup, "sponsor-sheet-placement-note").length, `${c.label}: placement note`).toBe(c.note ? 0 : 1);
      if (!c.note) expect(textOfMarkup(findOne(markup, "sponsor-sheet-placement-note").outer), `${c.label}: its words`).toBe("A deal sets the tier and where this sponsor shows.");
      expect(findAll(markup, "sponsor-sheet-tier-now").length, `${c.label}: Tier now`).toBe(c.tierNow ? 1 : 0);
      if (c.tierNow) {
        expect(textOfMarkup(findOne(markup, "sponsor-sheet-tier-now").outer), "the brief's line, typed").toBe("Tier now Partner. Gold when the deal goes live.");
      }
      const stream = findOne(markup, "sponsor-sheet-stream").open;
      expect(/\sdisabled(=|\s|>)/.test(stream), `${c.label}: the stream toggle is ${c.stream}`).toBe(c.stream === "locked");
      expect(attrOf(stream, "aria-describedby") !== undefined, `${c.label}: a locked toggle points at its reason`).toBe(c.stream === "locked");
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("the locked note is the one the toggle's aria-describedby points at (the reason is announced, not only drawn)", () => {
    const markup = bodyHtml({ sponsor: CASES[0]!.s, deals: CASES[0]!.deals });
    const noteId = attrOf(findOne(markup, "sponsor-sheet-locked-note").open, "id");
    expect(noteId).toBeTruthy();
    expect(attrOf(findOne(markup, "sponsor-sheet-stream").open, "aria-describedby")).toBe(noteId);
  });

  it("each guard on the 'Tier now' line stands on its own (a stale row cannot raise it): locked wins over an open row deal, and an open flag needs an OPEN deal", () => {
    // The sponsors list and the deals list are re-read separately, so one can be a read behind the other. The line must not depend
    // on the two agreeing.
    const lockedButRowStillOpen = sponsor({ tier: "partner", locked_by_deal: true, has_open_deal: true, deal: OPEN_DEAL });
    expect(findAll(bodyHtml({ sponsor: lockedButRowStillOpen, deals: [LIVE_DEAL, OPEN_DEAL] }), "sponsor-sheet-tier-now"), "locked: a live deal owns the tier").toHaveLength(0);
    const flagButRowEnded = sponsor({ tier: "partner", has_open_deal: true, deal: ENDED_DEAL });
    expect(findAll(bodyHtml({ sponsor: flagButRowEnded, deals: [ENDED_DEAL] }), "sponsor-sheet-tier-now"), "an ended deal changes nothing").toHaveLength(0);
    // the pair: the same open deal on an unlocked sponsor DOES raise it
    const open = sponsor({ tier: "partner", has_open_deal: true, deal: OPEN_DEAL });
    expect(findAll(bodyHtml({ sponsor: open, deals: [OPEN_DEAL] }), "sponsor-sheet-tier-now")).toHaveLength(1);
  });

  it("an open deal with the SAME tier says nothing about a change (nothing will change)", () => {
    const same = deal({ id: "do2", deal_status: "awaiting_payment", payment_status: "pending", tier: "partner" });
    const markup = bodyHtml({ sponsor: sponsor({ tier: "partner", has_open_deal: true, deal: same }), deals: [same] });
    expect(findAll(markup, "sponsor-sheet-tier-now")).toHaveLength(0);
  });

  // m6 (batch H review): the line used to be raised by a differing TIER only. A deal that differs from the sponsor's placement in
  // SCOPE alone (the same tier, another competition) changes what the sponsor shows on just as much, and said nothing.
  describe("what changes when the deal goes live: tier, scope, both or neither (the placement differential)", () => {
    const AT = (tier: string, competition_id: string | null) =>
      deal({ id: `do-${tier}-${competition_id ?? "all"}`, deal_status: "awaiting_payment", payment_status: "pending", tier: tier as SponsorDeal["tier"], competition_id });
    const SP = (tier: string, competition_id: string | null) =>
      sponsor({ tier: tier as SponsorItem["tier"], competition_id, has_open_deal: true, status: "inactive" });
    const line = (markup: string, id: string) => (findAll(markup, id).length === 0 ? null : textOfMarkup(findOne(markup, id).outer));

    // Expected sentences are typed from the brief's own pattern ("... now X. Y when the deal goes live."), never read back from the page.
    const CASES: { label: string; sp: SponsorItem; d: SponsorDeal; tier: string | null; scope: string | null }[] = [
      { label: "scope only (whole org -> one competition)", sp: SP("gold", null), d: AT("gold", "c-season"), tier: null, scope: "Scope now All competitions. Season 2026/27 when the deal goes live." },
      { label: "scope only (one competition -> whole org)", sp: SP("gold", "c-season"), d: AT("gold", null), tier: null, scope: "Scope now Season 2026/27. All competitions when the deal goes live." },
      { label: "scope only (one competition -> another)", sp: SP("gold", "c-season"), d: AT("gold", "c-winter"), tier: null, scope: "Scope now Season 2026/27. Winter League 2026/27 when the deal goes live." },
      { label: "tier only", sp: SP("partner", null), d: AT("gold", null), tier: "Tier now Partner. Gold when the deal goes live.", scope: null },
      { label: "both", sp: SP("partner", null), d: AT("gold", "c-season"), tier: "Tier now Partner. Gold when the deal goes live.", scope: "Scope now All competitions. Season 2026/27 when the deal goes live." },
      { label: "neither", sp: SP("gold", "c-season"), d: AT("gold", "c-season"), tier: null, scope: null },
    ];

    it("each case raises exactly the lines that differ (6 checked, 4 differential)", () => {
      let checked = 0;
      let differing = 0;
      for (const c of CASES) {
        // The row's own deal is the one the line reads (`sponsor.deal`): the list route puts the open deal there.
        const markup = bodyHtml({ sponsor: { ...c.sp, deal: c.d }, deals: [c.d] });
        expect(line(markup, "sponsor-sheet-tier-now"), `${c.label}: tier line`).toBe(c.tier);
        expect(line(markup, "sponsor-sheet-scope-now"), `${c.label}: scope line`).toBe(c.scope);
        if (c.tier !== null || c.scope !== null) differing++;
        checked++;
      }
      expect(checked).toBe(CASES.length);
      expect(differing, "five of the six change something: the sixth is the negative pair").toBe(5);
    });

    it("the scope line obeys the same guards as the tier line: a live deal owns the scope, an ended deal changes nothing", () => {
      const open = AT("gold", "c-season");
      const live = deal({ id: "dl2", deal_status: "live", payment_status: "paid", tier: "gold", competition_id: "c-season" });
      const lockedButRowOpen = sponsor({ tier: "gold", competition_id: null, locked_by_deal: true, has_open_deal: true, deal: open });
      expect(findAll(bodyHtml({ sponsor: lockedButRowOpen, deals: [live, open] }), "sponsor-sheet-scope-now"), "locked: a live deal owns the scope").toHaveLength(0);
      const ended = deal({ id: "de2", deal_status: "ended", payment_status: "paid", tier: "gold", competition_id: "c-season", ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" });
      const flagButRowEnded = sponsor({ tier: "gold", competition_id: null, has_open_deal: true, deal: ended });
      expect(findAll(bodyHtml({ sponsor: flagButRowEnded, deals: [ended] }), "sponsor-sheet-scope-now"), "an ended deal changes nothing").toHaveLength(0);
      // the pair: the same open deal on an unlocked sponsor DOES raise it
      expect(findAll(bodyHtml({ sponsor: sponsor({ tier: "gold", competition_id: null, has_open_deal: true, deal: open }), deals: [open] }), "sponsor-sheet-scope-now")).toHaveLength(1);
    });
  });

  it("without tiers (the free plan) the tier and competition rows are not drawn at all; name, link and stream are", () => {
    const markup = bodyHtml({ hasTiers: false });
    expect(findAll(markup, "sponsor-sheet-detail-tier")).toHaveLength(0);
    expect(findAll(markup, "sponsor-sheet-detail-scope")).toHaveLength(0);
    expect(findAll(markup, "sponsor-sheet-placement-note"), "nothing to explain: the tier is not drawn").toHaveLength(0);
    expect(findAll(markup, "sponsor-sheet-detail-name")).toHaveLength(1);
    expect(findAll(markup, "sponsor-sheet-detail-link")).toHaveLength(1);
    expect(findAll(markup, "sponsor-sheet-stream")).toHaveLength(1);
  });

  it("the name, link and a no-link sponsor read as the brief says; the link is the sponsor's host and opens in a new tab", () => {
    const markup = bodyHtml();
    const link = findOne(findOne(markup, "sponsor-sheet-detail-link").outer, "sponsor-sheet-detail-link");
    expect(textOfMarkup(link.outer)).toBe("ridgegoldphysio.co.uk");
    const a = /<a [^>]*>/.exec(link.outer)![0];
    expect(attrOf(a, "href")).toBe("https://ridgegoldphysio.co.uk/");
    expect(attrOf(a, "rel")).toBe("noopener noreferrer");
    expect(textOfMarkup(findOne(bodyHtml({ sponsor: sponsor({ url: null }) }), "sponsor-sheet-detail-link").outer)).toBe(msg("sponsors.sheet.noLink"));
  });

  it("a viewer reads everything and changes nothing: no Edit, no toggle (its state as words), no Show again, no Add deal, no actions, no report link", () => {
    const d = deal({ id: "dv", deal_status: "awaiting_payment", payment_status: "pending" });
    const markup = bodyHtml({ canEdit: false, sponsor: sponsor({ on_stream: true, status: "inactive" }), deals: [d], reportDefaults: null });
    for (const id of ["sponsor-sheet-edit", "sponsor-sheet-stream", "sponsor-show-a", "sponsor-sheet-add-deal", "sponsor-sheet-deal-action", "sponsor-sheet-deal-open", "sponsor-sheet-report"]) {
      expect(findAll(markup, id), `a viewer: no ${id}`).toHaveLength(0);
    }
    expect(textOfMarkup(findOne(markup, "sponsor-sheet-stream-state").outer)).toBe(msg("sponsors.sheet.on"));
    // The pair: the same sponsor and deal for an editor DO carry them, so the absences above are not an empty fixture.
    const editor = bodyHtml({ canEdit: true, sponsor: sponsor({ on_stream: true, status: "inactive" }), deals: [d] });
    for (const id of ["sponsor-sheet-edit", "sponsor-sheet-stream", "sponsor-sheet-add-deal", "sponsor-sheet-report"]) {
      expect(findAll(editor, id).length, `an editor: ${id}`).toBeGreaterThan(0);
    }
    expect(dealsIn(markup), "a viewer still sees the deal").toHaveLength(1);
  });

  it("the head: the name, the host and the click count, the sponsor's chip - and the initial when there is no logo", () => {
    const markup = bodyHtml({ sponsor: sponsor({ logo_path: null, click_count: 12, deal: LIVE_DEAL }), deals: [LIVE_DEAL] });
    expect(textOfMarkup(findOne(markup, "sponsor-sheet-name").outer)).toBe("Ridge Gold Physiotherapy");
    expect(textOfMarkup(findOne(markup, "sponsor-sheet-meta").outer)).toBe("ridgegoldphysio.co.uk · 12 clicks");
    expect(textOfMarkup(findAll(markup, "deal-chip")[0]!.outer), "the head's chip is the row's deal").toBe("Live");
  });
});

// --- Deals ----------------------------------------------------------------------------------------------------------------------

describe("Deals: this sponsor's deals, the current ones then the past ones, newest first", () => {
  it("THE EMPTY CASE: no deals -> 'No deals yet', the hint, and ONE Add deal; no list at all", () => {
    const markup = bodyHtml({ deals: [] });
    expect(textOfMarkup(findOne(markup, "sponsor-sheet-no-deals").outer)).toContain("No deals yet");
    expect(dealsIn(markup)).toHaveLength(0);
    expect(findAll(markup, "sponsor-sheet-current")).toHaveLength(0);
    expect(findAll(markup, "sponsor-sheet-past")).toHaveLength(0);
    const adds = findAll(markup, "sponsor-sheet-add-deal");
    expect(adds, "exactly one Add deal").toHaveLength(1);
    expect(textOfMarkup(adds[0]!.outer)).toBe("Add deal");
    expect(findOne(markup, "sponsor-sheet-no-deals").inner, "the Add deal is IN the empty state").toContain('data-testid="sponsor-sheet-add-deal"');
  });

  it("only this sponsor's deals (S8): another sponsor's, and a sponsor-less legacy row, are not drawn", () => {
    const mine = deal({ id: "m1" });
    const other = deal({ id: "x1", sponsor_id: "someone-else" });
    const orphan = deal({ id: "o1", sponsor_id: null, deal_status: "ended", ended_reason: "legacy" });
    const markup = bodyHtml({ deals: [mine, other, orphan] });
    expect(idsIn(markup)).toEqual(["m1"]);
  });

  it("current (live first, then waiting) and past (ended, legacy included), each newest first (7 deals checked)", () => {
    const d = (id: string, created: string, over: Partial<SponsorDeal> = {}) => deal({ id, created_at: created, ...over });
    const LIVE = d("live-old", "2026-01-01T00:00:00.000Z", { deal_status: "live" });
    const WAIT_NEW = d("wait-new", "2026-11-01T00:00:00.000Z", { deal_status: "awaiting_payment", payment_status: "pending" });
    const WAIT_OLD = d("wait-old", "2026-10-01T00:00:00.000Z", { deal_status: "scheduled" });
    const END_NEW = d("end-new", "2026-06-01T00:00:00.000Z", { deal_status: "ended", ended_at: "2026-08-01T00:00:00.000Z" });
    const END_OLD = d("end-old", "2025-06-01T00:00:00.000Z", { deal_status: "ended", ended_at: "2025-08-01T00:00:00.000Z" });
    const LEGACY = d("legacy", "2024-06-01T00:00:00.000Z", { deal_status: "ended", ended_reason: "legacy" });
    const DRAFT = d("draft", "2026-09-01T00:00:00.000Z", { deal_status: "draft", payment_status: "pending" });
    const all = [END_OLD, WAIT_OLD, LEGACY, LIVE, END_NEW, WAIT_NEW, DRAFT]; // deliberately not in the order they are drawn
    const markup = bodyHtml({ deals: all });
    const current = findOne(markup, "sponsor-sheet-current");
    const past = findOne(markup, "sponsor-sheet-past");
    expect(idsIn(current.outer), "the live deal first although it is the oldest, then the waiting ones newest first").toEqual(["live-old", "wait-new", "wait-old", "draft"]);
    expect(idsIn(past.outer), "past, newest first, the legacy order last").toEqual(["end-new", "end-old", "legacy"]);
    expect(idsIn(markup).length, "all seven drawn").toBe(7);
    // the grouping function is the same answer
    const g = sponsorDealGroups(all, "a");
    expect(g.current.map((x) => x.id).concat(g.past.map((x) => x.id))).toEqual(idsIn(markup));
  });

  it("each deal: its chip, its price, 'package · scope', and where the money stands", () => {
    const rows = [
      deal({ id: "r1", deal_status: "live", payment_status: "paid", package_name: "Gold Season", tier: "gold", amount_cents: 60_000, competition_id: "c-season", paid_at: "2026-10-16T12:00:00.000Z" }),
      deal({ id: "r2", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online", package_name: "Silver Season", tier: "silver", amount_cents: 30_000, invoice_sent_at: "2026-10-28T10:00:00.000Z" }),
      deal({ id: "r3", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline", package_name: "Silver Season", tier: "silver", amount_cents: 30_000 }),
      deal({ id: "r4", deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate", package_name: "Partner", amount_cents: 0, competition_id: "c-winter" }),
      deal({ id: "r5", deal_status: "draft", payment_status: "pending", payment_method: "online", package_name: "Partner", amount_cents: 12_050 }),
      deal({ id: "r6", deal_status: "ended", payment_status: "paid", package_name: "Partner", amount_cents: 12_000, ended_at: "2026-08-31T12:00:00.000Z", ended_reason: "expired" }),
    ];
    const markup = bodyHtml({ deals: rows });
    const WANT: Record<string, { chip: string; price: string; what: string; state: string | null }> = {
      r1: { chip: "Live", price: "£600", what: "Gold Season · Gold · Season 2026/27", state: "Paid 16 Oct" },
      r2: { chip: "Awaiting payment", price: "£300", what: "Silver Season · Silver · All competitions", state: "Online invoice sent 28 Oct" },
      r3: { chip: "Awaiting payment", price: "£300", what: "Silver Season · Silver · All competitions", state: "Bank transfer" },
      r4: { chip: "Live", price: "Complimentary", what: "Partner · Winter League 2026/27", state: null },
      r5: { chip: "Draft", price: "£120.50", what: "Partner · All competitions", state: "Not sent yet" },
      r6: { chip: "Ended", price: "£120", what: "Partner · All competitions", state: "Ended 31 Aug" },
    };
    let checked = 0;
    for (const d of dealsIn(markup)) {
      const id = attrOf(d.open, "data-deal-id")!;
      const want = WANT[id]!;
      expect(textOfMarkup(findOne(d.outer, "deal-chip").outer), `${id} chip`).toBe(want.chip);
      expect(textOfMarkup(findOne(d.outer, "sponsor-sheet-deal-price").outer), `${id} price`).toBe(want.price);
      expect(textOfMarkup(findOne(d.outer, "sponsor-sheet-deal-what").outer), `${id} what`).toBe(want.what);
      const state = findAll(d.outer, "sponsor-sheet-deal-state");
      expect(state.length ? textOfMarkup(state[0]!.outer) : null, `${id} state`).toBe(want.state);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("a deal's tier word sits between its package and its scope, by the same rule as the list (hasTiers, or a higher tier on the deal)", () => {
  const whatOf = (markup: string, id: string) => {
    const d = dealsIn(markup).find((x) => attrOf(x.open, "data-deal-id") === id)!;
    return textOfMarkup(findOne(d.outer, "sponsor-sheet-deal-what").outer);
  };
  const rows = [
    deal({ id: "tp", package_name: "Club Package", tier: "partner", competition_id: "c-season" }),
    deal({ id: "tt", package_name: "Testing001 Gold", tier: "title", competition_id: "c-season" }),
    deal({ id: "te", package_name: "Partner", tier: "partner", competition_id: "c-season" }),
  ];

  it("with tiers: Partner and Title both say their word; a package named for its tier does not repeat it (3 checked)", () => {
    const markup = bodyHtml({ deals: rows, hasTiers: true });
    expect(whatOf(markup, "tp")).toBe("Club Package · Partner · Season 2026/27");
    expect(whatOf(markup, "tt")).toBe("Testing001 Gold · Title · Season 2026/27");
    expect(whatOf(markup, "te")).toBe("Partner · Season 2026/27");
  });

  it("without tiers: a Partner deal says none, the Title deal still does (the pair)", () => {
    const markup = bodyHtml({ deals: rows, hasTiers: false });
    expect(whatOf(markup, "tp")).toBe("Club Package · Season 2026/27");
    expect(whatOf(markup, "tt")).toBe("Testing001 Gold · Title · Season 2026/27");
  });
});

describe("a deal for a competition the page does not hold says so in words, never a bare ellipsis", () => {
  it("'package · This package's competition' - and a competition the page holds keeps its own name (the pair); the fallback is translated", () => {
    const rows = [
      deal({ id: "gone", package_name: "Cup Partner", competition_id: "c-removed" }),
      deal({ id: "known", package_name: "Cup Partner", competition_id: "c-season" }),
    ];
    const markup = bodyHtml({ deals: rows });
    const whatOf = (id: string) => {
      const d = dealsIn(markup).find((x) => attrOf(x.open, "data-deal-id") === id)!;
      return textOfMarkup(findOne(d.outer, "sponsor-sheet-deal-what").outer);
    };
    expect(whatOf("gone"), "an unknown competition").toBe(`Cup Partner · Partner · ${msg("sponsors.dealSheet.scopeUnknown")}`);
    expect(whatOf("gone"), "never the bare glyph").not.toContain("…");
    expect(whatOf("known")).toBe("Cup Partner · Partner · Season 2026/27");
    // The key exists, in words of its own, in every other locale: a locale cannot be left on English.
    let checked = 0;
    for (const [locale, dict] of [["es", uiEs], ["fr", uiFr], ["nl", uiNl]] as const) {
      const words = (dict as unknown as Record<string, string>)["sponsors.dealSheet.scopeUnknown"];
      expect(words, `${locale} has the key`).toBeTruthy();
      expect(words, `${locale} is translated`).not.toBe(msg("sponsors.dealSheet.scopeUnknown"));
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("the buttons ARE allowedActions (the engine's answer), never a client copy - and 'Open deal' is always there (S4)", () => {
  const WORDS: Record<string, string> = {
    send_invoice: "Send invoice", resend_invoice: "Resend invoice", mark_paid: "Mark as paid", approve: "Approve", end_now: "End now",
  };

  it("hand-typed rows from the spec's table (§5.2): what each state offers", () => {
    const T: [string, Partial<SponsorDeal>, string[]][] = [
      ["online draft, unpaid", { deal_status: "draft", payment_status: "pending", payment_method: "online" }, ["send_invoice", "end_now"]],
      ["online, awaiting payment", { deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online" }, ["resend_invoice", "mark_paid", "end_now"]],
      ["offline, awaiting payment", { deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline" }, ["mark_paid", "end_now"]],
      ["paid, awaiting approval", { deal_status: "awaiting_approval", payment_status: "paid", go_live: "on_approval" }, ["approve", "end_now"]],
      ["live and paid", { deal_status: "live", payment_status: "paid" }, ["end_now"]],
      ["complimentary and live", { deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate" }, ["end_now"]],
      ["scheduled and paid", { deal_status: "scheduled", payment_status: "paid" }, ["end_now"]],
      ["ended", { deal_status: "ended", payment_status: "paid", ended_reason: "expired" }, []],
    ];
    let checked = 0;
    for (const [label, over, want] of T) {
      const markup = bodyHtml({ deals: [deal({ id: "t", ...over })] });
      const drawn = findAll(markup, "sponsor-sheet-deal-action").map((b) => attrOf(b.open, "data-action"));
      expect(drawn, label).toEqual(want);
      for (const b of findAll(markup, "sponsor-sheet-deal-action")) {
        expect(textOfMarkup(b.outer), `${label}: words`).toBe(WORDS[attrOf(b.open, "data-action")!]);
      }
      expect(findAll(markup, "sponsor-sheet-deal-open"), `${label}: Open deal`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(T.length);
  });

  it("every status x payment x method the model can produce: the drawn buttons are allowedActions minus Refund (which asks about money, on the deal's page)", () => {
    let checked = 0;
    let withButtons = 0;
    for (const deal_status of DEAL_STATUSES) {
      for (const payment_method of PAYMENT_METHODS) {
        const payments = payment_method === "complimentary" ? [initialPaymentStatus("complimentary")] : PAYMENT_STATUSES.filter((p) => p !== "none");
        for (const payment_status of payments) {
          for (const go_live of GO_LIVE_RULES) {
            if (payment_method === "complimentary" && go_live === "on_payment") continue;
            const d = deal({ id: "t", deal_status, payment_status, payment_method, go_live, ended_reason: deal_status === "ended" ? "expired" : null });
            const want = allowedActions(d).filter((a) => a !== "refund");
            const drawn = findAll(bodyHtml({ deals: [d] }), "sponsor-sheet-deal-action").map((b) => attrOf(b.open, "data-action"));
            expect(drawn, `${deal_status}/${payment_status}/${payment_method}/${go_live}`).toEqual(want);
            if (want.length) withButtons++;
            checked++;
          }
        }
      }
    }
    expect(checked, "the sweep is not vacuous").toBeGreaterThan(60);
    expect(withButtons, "and both arms are exercised").toBeGreaterThan(10);
    expect(withButtons).toBeLessThan(checked);
  });

  it("Refund is never drawn here, even on a paid deal that allowedActions offers it for", () => {
    const d = deal({ id: "t", deal_status: "ended", payment_status: "paid", ended_reason: "ended_now" });
    expect(allowedActions(d), "premise: the engine offers Refund on this deal").toContain("refund");
    expect(findAll(bodyHtml({ deals: [d] }), "sponsor-sheet-deal-action")).toHaveLength(0);
  });

  it("a button is named for its deal's package (label in name), Open deal links to the deal, and a write in flight disables the buttons", () => {
    const d = deal({ id: "t1", deal_status: "awaiting_payment", payment_status: "pending", package_name: "Gold Season" });
    const markup = bodyHtml({ deals: [d] });
    const resend = findAll(markup, "sponsor-sheet-deal-action").find((b) => attrOf(b.open, "data-action") === "resend_invoice")!;
    expect(attrOf(resend.open, "aria-label")).toBe("Resend invoice: Gold Season");
    expect(attrOf(findOne(markup, "sponsor-sheet-deal-open").open, "href")).toBe(`${LIST_URL}&sponsor=a&deal=t1`);
    expect(attrOf(findOne(markup, "sponsor-sheet-deal-open").open, "aria-label")).toBe("Open deal: Gold Season");
    const busy = bodyHtml({ deals: [d], busy: true });
    for (const b of findAll(busy, "sponsor-sheet-deal-action")) expect(/\sdisabled(=|\s|>)/.test(b.open), "disabled while busy").toBe(true);
    expect(/\sdisabled(=|\s|>)/.test(findOne(busy, "sponsor-sheet-add-deal").open)).toBe(true);
  });

  it("every action is a 44px target below md", () => {
    const d = deal({ id: "t1", deal_status: "awaiting_payment", payment_status: "pending" });
    const markup = bodyHtml({ deals: [d] });
    const targets = [...findAll(markup, "sponsor-sheet-deal-action"), ...findAll(markup, "sponsor-sheet-deal-open"), ...findAll(markup, "sponsor-sheet-add-deal"), ...findAll(markup, "sponsor-sheet-edit"), ...findAll(markup, "sponsor-sheet-share")];
    expect(targets.length).toBeGreaterThanOrEqual(6);
    for (const x of targets) expect(classTokens(x.open), attrOf(x.open, "data-testid")).toContain("max-md:min-h-11");
  });
});

// --- Show on site again, moved here ---------------------------------------------------------------------------------------------

describe("Show on site again lives on the sponsor's page (spec §10.3), by the list's own predicate", () => {
  it("offered exactly where canShowAgain says, with the PR 1 label and test id (5 sponsors checked)", () => {
    const LIVE = deal({ id: "dl" });
    const CASES: [string, SponsorItem][] = [
      ["off, no deal", sponsor({ status: "inactive" })],
      ["off, its deal ended", sponsor({ status: "inactive", deal: deal({ id: "de", deal_status: "ended", payment_status: "paid" }) })],
      ["active", sponsor({ status: "active" })],
      ["off, an open deal", sponsor({ status: "inactive", has_open_deal: true })],
      ["off, under a live deal", sponsor({ status: "inactive", locked_by_deal: true, deal: LIVE })],
    ];
    let checked = 0;
    for (const [label, s] of CASES) {
      const markup = bodyHtml({ sponsor: s });
      const offered = findAll(markup, "sponsor-show-a").length === 1;
      expect(offered, label).toBe(canShowAgain(s));
      checked++;
    }
    expect(checked).toBe(5);
    expect(CASES.filter(([, s]) => canShowAgain(s)).length, "both arms exercised").toBe(2);
    const button = findOne(bodyHtml({ sponsor: CASES[0]![1] }), "sponsor-show-a");
    expect(attrOf(button.open, "aria-label")).toBe("Show on site again: Ridge Gold Physiotherapy");
    expect(textOfMarkup(button.outer)).toBe("Show on site again");
  });
});

// --- the report link --------------------------------------------------------------------------------------------------------------

describe("Report link: PR A's ShareReport for this sponsor", () => {
  it("the section is drawn for an editor with the opening dates, and carries the sponsor's live-link count", () => {
    const markup = bodyHtml({ reportLinks: [LINK, { ...LINK, id: "l2" }] });
    expect(findAll(markup, "sponsor-sheet-report")).toHaveLength(1);
    expect(textOfMarkup(findOne(markup, "sponsor-sheet-report-count").outer)).toBe("Active links: 2");
  });

  it("no section without the opening dates (a viewer's page reads none), and none for a viewer", () => {
    expect(findAll(bodyHtml({ reportDefaults: null }), "sponsor-sheet-report")).toHaveLength(0);
    expect(findAll(bodyHtml({ canEdit: false }), "sponsor-sheet-report")).toHaveLength(0);
  });

  it("S11 the seam: hub.reportLinks and hub.reportDefaults reach ShareReport when the toggle opens it (closed -> open -> closed)", () => {
    const section = renderIsland(ReportLinkSection, { orgId: ORG, sponsor: { id: "a", name: "Ridge Gold Physiotherapy" }, links: [LINK], defaults: DEFAULTS });
    const find = () => section.tree().filter((e) => e.type === ShareReport);
    expect(find(), "closed: no panel").toHaveLength(0);
    const toggle = () => section.tree().find((e) => propsOf(e)["data-testid"] === "sponsor-sheet-share")!;
    expect(propsOf(toggle())["aria-expanded"]).toBe(false);
    (propsOf(toggle()).onClick as () => void)();
    const open = find();
    expect(open, "open: one panel").toHaveLength(1);
    const p = propsOf(open[0]!);
    expect(p.links, "the sponsor's links").toEqual([LINK]);
    expect(p.defaults, "the opening dates").toBe(DEFAULTS);
    expect(p.sponsor).toEqual({ id: "a", name: "Ridge Gold Physiotherapy" });
    expect(p.orgId).toBe(ORG);
    expect(p.competitionName, "this year: no competition").toBeNull();
    expect(propsOf(toggle())["aria-expanded"]).toBe(true);
    expect(propsOf(toggle())["aria-controls"], "the toggle points at the panel").toBe(p.id);
    (p.onClose as () => void)();
    expect(find(), "Close shuts it").toHaveLength(0);
  });
});

// --- the island: the writes the sheet makes -----------------------------------------------------------------------------------------

const fetchMock = vi.fn();
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
/** What the server would send back for a re-read: the rows and deals the island was mounted with, so a write's re-read does not
 *  empty the list (which would close the sponsor's page under the test). */
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
const API = `/api/v1/orgs/${ORG}`;
const refuseWith = (status: number, code: string) => ({ status, body: { ok: false, error: { code, message: "server english" } } });

function hubOf(over: Partial<SponsorsHubData> = {}): SponsorsHubData {
  return {
    orgSlug: SLUG, orgTimezone: null, deals: [], packages: [], tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize: true, monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [],
    chargesEnabled: true, sponsorId: "a", editSponsor: false, dealId: null, dealCreatedByName: null, dealCompetitionFinished: false, reportLinks: [LINK],
    reportDefaults: DEFAULTS, ...over,
  };
}
function mount(rows: SponsorItem[], hub: SponsorsHubData, opts: { canEdit?: boolean; hasTiers?: boolean } = {}) {
  const props: Parameters<typeof OrgSponsors>[0] = {
    orgId: ORG, initialSponsors: rows, competitions: COMPS, hasTiers: opts.hasTiers ?? true, billingHref: "/billing",
    canEdit: opts.canEdit ?? true, hub,
  };
  served.rows = rows;
  served.deals = hub.deals;
  const island = renderIsland(OrgSponsors, props, expandSponsorTree);
  const has = (id: string) => island.tree().some((e) => propsOf(e)["data-testid"] === id);
  const all = (id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);
  const text = () =>
    flat(
      island
        .tree()
        .flatMap((e) => {
          const kids = propsOf(e).children;
          return (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string" || typeof k === "number").map(String);
        })
        .join(" "),
    );
  const tap = (testid: string, pick?: (e: ReactElement) => boolean) => {
    const el = all(testid).find(pick ?? (() => true));
    if (!el) throw new Error(`nothing to tap: ${testid}`);
    (propsOf(el).onClick as () => void)();
  };
  const action = (dealId: string, name: string) => tap("sponsor-sheet-deal-action", (e) => propsOf(e)["data-deal-id"] === dealId && propsOf(e)["data-action"] === name);
  return { island, props, has, all, text, tap, action };
}
const POSTS = () => calls.filter((c) => c.method === "POST").map((c) => c.url);
const GETS = () => calls.filter((c) => c.method === "GET").map((c) => c.url);

describe("OrgSponsors opens the sponsor's page for hub.sponsorId and hides the list below md", () => {
  const S = sponsor({ id: "a" });
  const OTHER = sponsor({ id: "b", name: "Quay Fisheries" });

  it("with a sponsor selected: the sheet is there, the list wrapper is max-md:hidden (but present from md), and its page carries the error/notice", () => {
    const m = mount([S, OTHER], hubOf());
    expect(m.has("sponsor-sheet")).toBe(true);
    const wrap = m.all("sponsors-list-view");
    expect(wrap).toHaveLength(1);
    expect(String(propsOf(wrap[0]!).className).split(/\s+/), "anchored on the whole token").toContain("max-md:hidden");
    expect(m.all("sponsor-notice"), "ONE live region, the sheet's").toHaveLength(1);
  });

  it("with none selected (or one this list no longer holds): the list only, the list is visible, the page-level live region is back", () => {
    for (const hub of [hubOf({ sponsorId: null }), hubOf({ sponsorId: "deleted-since" })]) {
      const m = mount([S, OTHER], hub);
      expect(m.has("sponsor-sheet")).toBe(false);
      expect(String(propsOf(m.all("sponsors-list-view")[0]!).className).split(/\s+/)).not.toContain("max-md:hidden");
      expect(m.all("sponsor-notice")).toHaveLength(1);
    }
  });

  it("the sheet shows the SELECTED sponsor (not the first row), and its editor is the ONLY one: the list rows draw none", () => {
    const m = mount([S, OTHER], hubOf({ sponsorId: "b" }));
    const sheet = m.all("sponsor-sheet");
    expect(propsOf(sheet[0]!)["data-sponsor-id"]).toBe("b");
    m.tap("sponsor-sheet-edit");
    expect(m.has("sponsor-sheet-editor"), "the sheet draws the editor").toBe(true);
    // The "Add a sponsor" form is also a SponsorForm; an EDITOR is the one with a Cancel.
    const editors = m.island.tree().filter((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined);
    expect(editors, "ONE editor open - a list row has no editor of its own any more").toHaveLength(1);
    expect(propsOf(editors[0]!).compact, "in the panel it is one column").toBe(true);
  });

  // The list's pencil is a link to `?sponsor=<id>&edit=1`; the island stays mounted across that client navigation, so the arrival is a
  // PROP change (`hub.editSponsor` / `hub.sponsorId`), not a mount. `rerender` is that navigation.
  const editorsIn = (m: ReturnType<typeof mount>) => m.island.tree().filter((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined);
  const goTo = (m: ReturnType<typeof mount>, hub: SponsorsHubData) => m.island.rerender({ ...m.props, hub });
  const BOTH = [sponsor({ id: "a", url: "https://a.example/" }), sponsor({ id: "b", name: "Quay Fisheries", url: "https://quay.example/" })];

  it("arriving by the pencil (?edit=1) opens the editor on THAT sponsor with its own name and link; the plain URL opens none (the pair)", () => {
    const opened = mount(BOTH, hubOf({ sponsorId: "b", editSponsor: true }));
    expect(opened.has("sponsor-sheet-editor"), "the Details editor is open").toBe(true);
    expect(editorsIn(opened)).toHaveLength(1);
    expect(propsOf(editorsIn(opened)[0]!).value).toMatchObject({ name: "Quay Fisheries", url: "https://quay.example/", file: null });
    const plain = mount(BOTH, hubOf({ sponsorId: "b", editSponsor: false }));
    expect(plain.has("sponsor-sheet-editor")).toBe(false);
    expect(editorsIn(plain)).toHaveLength(0);
    expect(plain.has("sponsor-sheet-edit"), "the read-only page offers its own Edit button").toBe(true);
  });

  it("the pencil clicked from the list (a client navigation: the same island, new props) opens the editor - and a SECOND pencil does too (4 arrivals checked)", () => {
    const m = mount(BOTH, hubOf({ sponsorId: null }));
    expect(m.has("sponsor-sheet")).toBe(false);
    let checked = 0;
    for (const id of ["b", "a", "b"]) {
      goTo(m, hubOf({ sponsorId: id, editSponsor: true }));
      expect(m.has("sponsor-sheet-editor"), `pencil for ${id}`).toBe(true);
      expect(propsOf(editorsIn(m)[0]!).value, `pencil for ${id}: its own name`).toMatchObject({ name: BOTH.find((r) => r.id === id)!.name });
      checked++;
      // Cancel, and back to the list: the next pencil is a fresh arrival.
      (propsOf(editorsIn(m)[0]!).onCancel as () => void)();
      expect(m.has("sponsor-sheet-editor"), `after Cancel (${id})`).toBe(false);
      goTo(m, hubOf({ sponsorId: null }));
    }
    // The sponsor's other pencil without passing through the list: a → b straight.
    goTo(m, hubOf({ sponsorId: "a", editSponsor: true }));
    goTo(m, hubOf({ sponsorId: "b", editSponsor: true }));
    expect(propsOf(editorsIn(m)[0]!).value, "a then b: b's draft, not a's").toMatchObject({ name: "Quay Fisheries" });
    checked++;
    expect(checked).toBe(4);
  });

  it("leaving the edit URL (the Back link to the plain page) closes the editor, and the page's own Edit button still opens it", () => {
    const m = mount(BOTH, hubOf({ sponsorId: "b", editSponsor: true }));
    expect(m.has("sponsor-sheet-editor")).toBe(true);
    goTo(m, hubOf({ sponsorId: "b", editSponsor: false }));
    expect(m.has("sponsor-sheet-editor"), "the plain URL is the read-only page").toBe(false);
    m.tap("sponsor-sheet-edit");
    expect(m.has("sponsor-sheet-editor"), "its own Edit button opens it, as before").toBe(true);
    expect(propsOf(editorsIn(m)[0]!).value).toMatchObject({ name: "Quay Fisheries" });
  });

  it("a write or re-read that does not change the URL leaves an open editor open (the same ?edit=1 is not a new arrival)", () => {
    const m = mount(BOTH, hubOf({ sponsorId: "b", editSponsor: true }));
    const typed = propsOf(editorsIn(m)[0]!).onChange as (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void;
    typed((p) => ({ ...p, name: "Typed but not saved" }));
    goTo(m, hubOf({ sponsorId: "b", editSponsor: true, deals: [] }));
    expect(propsOf(editorsIn(m)[0]!).value, "the draft survives a re-render with the same URL").toMatchObject({ name: "Typed but not saved" });
  });

  it("the pencil's arrival closes the ⋯ tray the reader had open on the row (the tray belongs to the list; it would still be open on the way back)", () => {
    const m = mount(BOTH, hubOf({ sponsorId: null }));
    const listProps = () => propsOf(m.island.tree().find((e) => e.type === SponsorList)!);
    const more = m.island.tree().find((e) => e.type === SponsorRowMore && propsOf(e).name === "Quay Fisheries")!;
    (propsOf(more).onToggle as () => void)();
    expect(listProps().moreOpenId, "premise: the ⋯ is open").toBe("b");
    goTo(m, hubOf({ sponsorId: "b", editSponsor: true }));
    expect(listProps().moreOpenId, "the pencil took the reader off the list").toBeNull();
  });

  it("the editor has NO tier or competition control, whatever the sponsor's deals or the plan (owner, 2026-11-11): 3 deal states x 2 plans checked", () => {
    const LIVE = deal({ id: "dl", deal_status: "live", tier: "gold" });
    const CASES: [string, SponsorItem, SponsorDeal[]][] = [
      ["a live deal", sponsor({ locked_by_deal: true, deal: LIVE }), [LIVE]],
      ["an open deal", sponsor({ has_open_deal: true, deal: deal({ id: "do", deal_status: "draft", payment_status: "pending" }) }), []],
      ["no deal", sponsor(), []],
    ];
    let checked = 0;
    for (const hasTiers of [true, false]) {
      for (const [label, s, deals] of CASES) {
        const m = mount([s], hubOf({ deals }), { hasTiers });
        m.tap("sponsor-sheet-edit");
        const form = m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined)!;
        const html = renderToStaticMarkup(form);
        expect(/<select\b/.test(html), `${label}, tiers=${hasTiers}: a select`).toBe(false);
        expect(html, `${label}, tiers=${hasTiers}: a lock note`).not.toContain("sponsor-locked-note");
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("while the editor is open the Details card holds the editor and not the read-only tier and competition rows (nothing to confuse with a control)", () => {
    const m = mount([sponsor({ tier: "silver" })], hubOf());
    m.tap("sponsor-sheet-edit");
    expect(m.has("sponsor-sheet-editor")).toBe(true);
    expect(m.has("sponsor-sheet-detail-tier"), "no tier row beside the editor").toBe(false);
    expect(m.has("sponsor-sheet-placement-note")).toBe(false);
  });

  it("saving name and link PATCHes only what changed and closes the editor (the existing saveEdit, now from the page)", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 200, body: { data: sponsor() } } : method === "GET" && url.endsWith("/sponsors") ? { status: 200, body: { data: [sponsor({ name: "New name" })] } } : defaultAnswer(url, method));
    const m = mount([sponsor()], hubOf());
    m.tap("sponsor-sheet-edit");
    const editor = () => m.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined)!;
    (propsOf(editor()).onChange as (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void)((p) => ({ ...p, name: "New name", url: "new.example.com" }));
    (propsOf(editor()).onSubmit as () => void)();
    await flush();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(`${API}/sponsors/a`);
    expect(patches[0]!.body, "exactly the two changed fields").toEqual({ name: "New name", url: "https://new.example.com" });
    expect(m.has("sponsor-sheet-editor"), "closed after saving").toBe(false);
  });
});

describe("the On stream toggle (the On stream tab's PATCH)", () => {
  it("PATCHes EXACTLY { on_stream: <next> } and re-reads the list; the re-read row shows the new state", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 200, body: { data: sponsor({ on_stream: true }) } } : method === "GET" ? { status: 200, body: { data: [sponsor({ on_stream: true })] } } : defaultAnswer(url, method));
    const m = mount([sponsor({ on_stream: false })], hubOf());
    const box = m.all("sponsor-sheet-stream")[0]!;
    expect(propsOf(box).checked).toBe(false);
    (propsOf(box).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await flush();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`${API}/sponsors/a`]);
    expect(patches[0]!.body).toEqual({ on_stream: true });
    expect(GETS()).toEqual([`${API}/sponsors`]);
    expect(propsOf(m.all("sponsor-sheet-stream")[0]!).checked, "the re-read row").toBe(true);
  });

  it("S7 locked by a live deal: nothing is sent even when the handler is called past the disabled box", async () => {
    const LIVE = deal({ id: "dl", deal_status: "live" });
    const m = mount([sponsor({ locked_by_deal: true, deal: LIVE })], hubOf({ deals: [LIVE] }));
    const box = m.all("sponsor-sheet-stream")[0]!;
    expect(propsOf(box).disabled, "premise: the box is disabled").toBe(true);
    (propsOf(box).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await flush();
    expect(calls.filter((c) => c.method !== "GET"), "no write").toEqual([]);
  });

  it("a refusal (409 sponsor_locked_by_deal: a deal went live since the page loaded) reads the dictionary's words, in the sheet, and the list is re-read", async () => {
    answer = (_url, method) => (method === "PATCH" ? refuseWith(409, "sponsor_locked_by_deal") : { status: 200, body: { data: [sponsor({ locked_by_deal: true, deal: deal({ id: "dl" }) })] } });
    const m = mount([sponsor()], hubOf());
    (propsOf(m.all("sponsor-sheet-stream")[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.lockedByDeal"));
    expect(m.text()).not.toContain("server english");
    expect(propsOf(m.all("sponsor-sheet-stream")[0]!).disabled, "the re-read row is locked").toBe(true);
  });
});

describe("the deal buttons write through the deal routes, ask where the money or the sponsor's visibility is at stake, and re-read", () => {
  const SUBJECT = sponsor({ id: "a", name: LONG_NAME });
  const rowDeal = deal({ id: "d-live", deal_status: "live", payment_status: "paid", package_name: "Gold Season", amount_cents: 60_000, tier: "gold" });

  it("S5 Mark as paid on a deal the ROW does not show: confirms with THAT deal's amount and the sponsor's name, POSTs THAT deal, re-reads sponsors and deals", async () => {
    // pickRowDeal puts the live deal on the row; the second, queued deal is acted on from the page.
    const queued = deal({ id: "d-queued", deal_status: "scheduled", payment_status: "pending", payment_method: "offline", package_name: "Silver Season", amount_cents: 30_000, created_at: "2026-10-20T09:00:00.000Z" });
    const m = mount([{ ...SUBJECT, locked_by_deal: true, deal: rowDeal }], hubOf({ deals: [rowDeal, queued] }));
    m.action("d-queued", "mark_paid");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; tone: string };
    expect(opts.title, "the AMOUNT of the deal tapped (£300), not the row's (£600)").toBe(`Record £300 from ${LONG_NAME} as received?`);
    expect(opts.confirmLabel).toBe("Mark as paid");
    expect(POSTS(), "the deal tapped, not the row's").toEqual([`${API}/sponsor-deals/d-queued/mark-paid`]);
    expect(GETS().sort(), "the list and the deals are re-read").toEqual([`${API}/sponsor-deals`, `${API}/sponsors`]);
  });

  it("declining Mark as paid sends nothing", async () => {
    const queued = deal({ id: "d-queued", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline" });
    const m = mount([SUBJECT], hubOf({ deals: [queued] }));
    confirmMock.mockImplementationOnce(async () => false);
    m.action("d-queued", "mark_paid");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("Approve is one tap (no confirm) and POSTs approve; Send invoice POSTs send-invoice and says it was sent; Resend says it was sent again", async () => {
    const CASES: [string, Partial<SponsorDeal>, string, string][] = [
      ["approve", { deal_status: "awaiting_approval", payment_status: "paid", go_live: "on_approval" }, "approve", ""],
      ["send_invoice", { deal_status: "draft", payment_status: "pending" }, "send-invoice", `Invoice sent for ${LONG_NAME}.`],
      ["resend_invoice", { deal_status: "awaiting_payment", payment_status: "pending" }, "send-invoice", `Invoice sent again for ${LONG_NAME}.`],
    ];
    let checked = 0;
    for (const [name, over, route, notice] of CASES) {
      calls.length = 0;
      confirmMock.mockClear();
      const d = deal({ id: "dx", ...over });
      const m = mount([SUBJECT], hubOf({ deals: [d] }));
      m.action("dx", name);
      await flush();
      expect(confirmMock, `${name}: no confirm`).not.toHaveBeenCalled();
      expect(POSTS(), name).toEqual([`${API}/sponsor-deals/dx/${route}`]);
      if (notice) expect(m.text(), name).toContain(notice);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a refused send (502 stripe_unavailable) reads the Resend words, never the server's, and the deals are still re-read", async () => {
    answer = (url, method) => (method === "POST" ? refuseWith(502, "stripe_unavailable") : defaultAnswer(url, method));
    const d = deal({ id: "dx", deal_status: "draft", payment_status: "pending" });
    const m = mount([SUBJECT], hubOf({ deals: [d] }));
    m.action("dx", "send_invoice");
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.resendStripeUnavailable"));
    expect(m.text()).not.toContain("server english");
    expect(GETS()).toContain(`${API}/sponsor-deals`);
  });

  it("S6 End now on a LIVE PAID deal says the money is kept and a refund is separate (the PR 2 ruling); the confirm is the danger one", async () => {
    const m = mount([{ ...SUBJECT, locked_by_deal: true, deal: rowDeal }], hubOf({ deals: [rowDeal] }));
    m.action("d-live", "end_now");
    await flush();
    const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; tone: string };
    expect(opts.title).toBe("End this deal now?");
    expect(opts.tone).toBe("danger");
    expect(opts.confirmLabel).toBe("End deal");
    expect(opts.body, "the live words, then the money words with the deal's amount and the sponsor's name").toBe(
      [msg("sponsors.deal.confirm.end.bodyLive", { name: LONG_NAME }), msg("sponsors.deal.confirm.end.paidKept", { amount: "£600", name: LONG_NAME })].join(" "),
    );
    expect(opts.body).toMatch(/doesn't refund/);
    expect(opts.body).toMatch(/Refund/);
    expect(POSTS()).toEqual([`${API}/sponsor-deals/d-live/end`]);
  });

  it("End now on a deal with no money kept (unpaid, complimentary, disputed) says nothing about a refund, and a queued deal's body follows the sponsor's live deal (6 checked)", async () => {
    const live2 = deal({ id: "d-live", deal_status: "live", payment_status: "paid" });
    const CASES: [string, SponsorDeal[], string, MessageKey, boolean][] = [
      ["live, unpaid", [deal({ id: "t", deal_status: "live", payment_status: "pending" })], "t", "sponsors.deal.confirm.end.bodyLive", false],
      ["live, complimentary", [deal({ id: "t", deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate" })], "t", "sponsors.deal.confirm.end.bodyLive", false],
      ["live, paid but disputed", [deal({ id: "t", deal_status: "live", payment_status: "paid", disputed_at: "2026-11-02T10:00:00.000Z" })], "t", "sponsors.deal.confirm.end.bodyLive", false],
      ["queued behind a live deal, unpaid", [live2, deal({ id: "t", deal_status: "scheduled", payment_status: "pending" })], "t", "sponsors.deal.confirm.end.bodyKept", false],
      ["queued, nothing live, unpaid", [deal({ id: "t", deal_status: "awaiting_payment", payment_status: "pending" })], "t", "sponsors.deal.confirm.end.bodyHidden", false],
      ["queued, paid", [deal({ id: "t", deal_status: "awaiting_approval", payment_status: "paid", go_live: "on_approval" })], "t", "sponsors.deal.confirm.end.bodyHidden", true],
    ];
    let checked = 0;
    for (const [label, deals, target, key, kept] of CASES) {
      confirmMock.mockClear();
      calls.length = 0;
      const m = mount([SUBJECT], hubOf({ deals }));
      m.action(target, "end_now");
      await flush();
      const body = (confirmMock.mock.calls[0]![0] as { body: string }).body;
      expect(body.startsWith(msg(key, { name: LONG_NAME})), `${label}: the right body`).toBe(true);
      expect(body.includes("doesn't refund"), `${label}: money words`).toBe(kept);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("declining End now sends nothing", async () => {
    const m = mount([SUBJECT], hubOf({ deals: [rowDeal] }));
    confirmMock.mockImplementationOnce(async () => false);
    m.action("d-live", "end_now");
    await flush();
    expect(calls).toEqual([]);
  });

  it("a new hub.deals (a navigation or router.refresh) replaces what the page last read, by identity", async () => {
    const first = deal({ id: "one", deal_status: "awaiting_payment", payment_status: "pending" });
    const second = deal({ id: "two", deal_status: "draft", payment_status: "pending" });
    const m = mount([SUBJECT], hubOf({ deals: [first] }));
    expect(m.all("sponsor-sheet-deal").map((e) => propsOf(e)["data-deal-id"])).toEqual(["one"]);
    m.island.rerender({ ...m.props, hub: hubOf({ deals: [second] }) });
    expect(m.all("sponsor-sheet-deal").map((e) => propsOf(e)["data-deal-id"])).toEqual(["two"]);
  });

  it("a list-only session (no sponsor selected) does not read /sponsor-deals: the list never needs it", async () => {
    const d = deal({ id: "dx", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline" });
    const m = mount([sponsor({ id: "a", deal: d, has_open_deal: true })], hubOf({ sponsorId: null, deals: [d] }));
    expect(m.has("sponsor-sheet")).toBe(false);
    expect(GETS()).toEqual([]);
  });
});

// --- Add deal is the sheet's, and the suspended wrapper follows it ---------------------------------------------------------------

describe("Add deal on the page asks OrgSponsors to open the Add deal sheet for this sponsor, and the page steps back while it is open", () => {
  it("the wrapper is not suspended until Add deal is tapped; then it is (so Escape reaches only the Add deal sheet)", () => {
    const m = mount([sponsor()], hubOf());
    const wrapper = () => m.island.tree().find((e) => e.type === SponsorSheet)!;
    expect(propsOf(wrapper()).suspended).toBe(false);
    expect(propsOf(wrapper()).closeHref).toBe(LIST_URL);
    expect(m.all("sponsor-sheet-add-deal"), "one Add deal in the empty state").toHaveLength(1);
    expect(m.island.tree().some((e) => e.type === AddDealSheet), "premise: no Add deal sheet before the tap").toBe(false);
    m.tap("sponsor-sheet-add-deal");
    expect(propsOf(wrapper()).suspended, "an Add deal sheet is open over the page").toBe(true);
    // The consumer, not just the flag: the sheet is really there, and it is for THIS sponsor.
    const sheets = m.island.tree().filter((e) => e.type === AddDealSheet);
    expect(sheets).toHaveLength(1);
    expect((propsOf(sheets[0]!).sponsor as SponsorItem).id).toBe("a");
  });
});

// --- the copy: four locales --------------------------------------------------------------------------------------------------------

describe("every new word exists in all four dictionaries, and the placeholders match", () => {
  const KEYS: MessageKey[] = [
    "sponsors.deal.action.sendInvoice", "sponsors.deal.action.endNow", "sponsors.deal.notice.invoiceSent", "sponsors.sheet.title",
    "sponsors.sheet.back", "sponsors.sheet.backLabel", "sponsors.sheet.details", "sponsors.sheet.edit", "sponsors.sheet.noLink",
    "sponsors.sheet.onStream", "sponsors.sheet.onStreamShow", "sponsors.sheet.on", "sponsors.sheet.off", "sponsors.sheet.tierNow",
    "sponsors.sheet.deals", "sponsors.sheet.current", "sponsors.sheet.past", "sponsors.sheet.noDeals", "sponsors.sheet.noDealsHint",
    "sponsors.sheet.dealActionFor", "sponsors.sheet.report", "sponsors.sheet.reportHint", "sponsors.sheet.reportLinks",
  ];
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("each key is non-empty in en/es/fr/nl with the same {placeholders} as English (23 keys x 4 locales)", () => {
    const dicts: Record<string, Record<string, string>> = { en: uiEn as never, es: uiEs as never, fr: uiFr as never, nl: uiNl as never };
    expect([...LOCALES].sort()).toEqual(["en", "es", "fr", "nl"]);
    let checked = 0;
    for (const key of KEYS) {
      const english = dicts.en![key];
      expect(english, `${key} (en)`).toBeTruthy();
      for (const loc of ["es", "fr", "nl"]) {
        const v = dicts[loc]![key];
        expect(v, `${key} (${loc})`).toBeTruthy();
        expect(placeholders(v!), `${key} (${loc}) placeholders`).toEqual(placeholders(english!));
        checked++;
      }
    }
    expect(checked).toBe(KEYS.length * 3);
  });

  it("deal vocabulary in English: the page's words say 'deal', never 'order' or 'package order'", () => {
    const words = KEYS.map((k) => msg(k, { name: "X", package: "P", action: "A", count: 1, now: "N", next: "M" })).join(" | ");
    expect(words).not.toMatch(/\border\b/i);
    expect(words).toMatch(/deal/i);
  });
});
