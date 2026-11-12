// Archive a sponsor, batch B (plan Tasks 6-7; spec docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §7, §8, §10): the list's
// "Show archived (N)" switch and trailing group, the sponsor page's Archive card, archived banner and read-only state, the Overview chip.
// Sport-agnostic (sponsor visibility has no sport): no sport sweep.
//
// Expected strings come from the dictionary JSON (never the component) or, for the four-locale refusal words, are typed from spec §10.
// The blocking table is spec §8, typed here row by row - never read back from `blocksArchive`. Every sweep reports what it checked.
//
// Killers (one at a time, restored from a cp backup):
//   A1 switch always drawn      `archived.length > 0` -> `>= 0`                      -> "empty first"
//   A2 archived in tier group   archived rows are mixed into the live groups         -> "trailing group"
//   A3 moves kept               `canReorder = !isArchived && ...` -> `group.length > 1` -> "no move buttons"
//   A4 blocking is live only    `archiveBlocked` reads `isLiveDeal` only             -> "the blocking sweep"
//   A5 Edit on an archived page `canWrite` -> `canEdit` on the Edit button            -> "archived: read-only page"
//   A6 ?edit=1 honoured         `editing` loses its `archived_at === null`            -> "?edit=1 on an archived sponsor"
//   A7 neighbour is archived    move() drops its live-only group                      -> "a move never swaps with an archived neighbour"
//   A8 On stream filter         page.test: includeArchived on the On stream tab       -> page.test.tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { OrgSponsors, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { ARCHIVED_ROW, SponsorList, type SponsorListProps } from "@/components/sponsors/sponsor-list";
import { ReportLinkSection } from "@/components/sponsors/sponsor-sheet";
import { OverviewTab } from "@/components/sponsors/overview-tab";
import { SAVE_ERROR_MSG } from "@/components/sponsors/save-error";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "./_sponsor-tree";
import { attrOf, classTokens, findAll } from "./_markup";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import { sponsorHref } from "@/lib/sponsors-hub";
import type { SponsorDeal } from "@/lib/sponsor-deals";
import type { SponsorOverviewRow } from "@/lib/sponsor-report";
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
const DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as const;

const ORG = "org-1";
const SLUG = "harbour-vale";
const COMPS = [{ id: "c-season", name: "Season 2026/27" }];

const DEAL: SponsorDeal = {
  id: "d0", sponsor_id: "live1", package_id: "p0", deal_status: "ended", payment_status: "paid", payment_method: "offline",
  go_live: "immediate", package_name: "Partner", tier: "partner", includes_on_stream: false, competition_id: null,
  amount_cents: 12_000, currency: "gbp", sponsor_name: "x", sponsor_email: "accounts@example.com", ends_at: null,
  created_at: "2026-10-01T09:00:00.000Z", created_by: null, invoice_sent_at: null, paid_at: "2026-10-02T09:00:00.000Z", marked_paid_by: null,
  approved_at: null, approved_by: null, live_at: "2026-10-01T09:00:00.000Z", ended_at: "2026-10-20T09:00:00.000Z", ended_reason: "ended_now",
  parked_at: null, disputed_at: null, dispute_id: null, has_payment_intent: false, invoice_number: 1, written_off_at: null, written_off_by: null,
};
const deal = (over: Partial<SponsorDeal>): SponsorDeal => ({ ...DEAL, ...over });

const sponsor = (over: Partial<SponsorItem> & { id: string; name: string }): SponsorItem => ({
  competition_id: null, url: null, logo_path: null, poster_path: null, tier: "partner", display_order: 0, status: "active", click_count: 0,
  on_stream: false, archived_at: null, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null, ...over,
});
const ARCHIVED_AT = "2026-11-03T10:30:00.000Z";
const GOLD = sponsor({ id: "g1", name: "Ridge Gold Physiotherapy", tier: "gold" });
const P1 = sponsor({ id: "p1", name: "Northbank Print", display_order: 1 });
const P2 = sponsor({ id: "p2", name: "Harbour Print", display_order: 2 });
const OLD = sponsor({ id: "a1", name: "Old Mill Bakery", archived_at: ARCHIVED_AT });
const OLD2 = sponsor({ id: "a2", name: "Quay Cafe", archived_at: ARCHIVED_AT, tier: "gold" });

const noop = () => {};
function listProps(live: SponsorItem[], over: Partial<SponsorListProps> = {}): SponsorListProps {
  return {
    sponsors: live, hasTiers: true, canEdit: true, busy: false, orgSlug: SLUG, tz: "UTC", competitions: COMPS, moreOpenId: null,
    onToggleMore: noop, onMove: noop, onRemove: noop, onAction: noop, onAddDeal: noop, ...over,
  };
}
const listHtml = (live: SponsorItem[], over: Partial<SponsorListProps> = {}) => renderToStaticMarkup(<SponsorList {...listProps(live, over)} />);
function rowOf(markup: string, id: string): string {
  const li = findAll(markup, "sponsor-row").find((f) => attrOf(f.open, "data-sponsor-id") === id);
  if (!li) throw new Error(`no row for ${id}`);
  return li.outer;
}

describe("the list: Show archived (N), the trailing group", () => {
  it("empty first: no archived sponsor -> no switch in the markup at all", () => {
    const html = listHtml([GOLD, P1, P2], { archived: [], showArchived: false });
    expect(findAll(html, "sponsors-archived-filter")).toHaveLength(0);
    expect(html).not.toContain("sponsors-archived-switch");
    expect(html).not.toContain("data-archived");
    // the pair: the live list still draws
    expect(findAll(html, "sponsor-row")).toHaveLength(3);
    // and `showArchived` with nothing archived draws no group either
    expect(findAll(listHtml([GOLD], { archived: [], showArchived: true }), "sponsor-group").map((g) => attrOf(g.open, "data-tier"))).toEqual(["gold"]);
  });

  it("one archived: 'Show archived (1)', aria-checked=false, and no archived row in the DOM", () => {
    const html = listHtml([GOLD, P1], { archived: [OLD], showArchived: false });
    const filter = findAll(html, "sponsors-archived-filter");
    expect(filter).toHaveLength(1);
    expect(attrOf(filter[0]!.open, "data-archived-count")).toBe("1");
    expect(flat(filter[0]!.inner)).toContain(msg("sponsors.archive.show", { count: 1 }));
    expect(msg("sponsors.archive.show", { count: 1 })).toBe("Show archived (1)");
    const sw = findAll(html, "sponsors-archived-switch");
    expect(attrOf(sw[0]!.open, "role")).toBe("switch");
    expect(attrOf(sw[0]!.open, "aria-checked")).toBe("false");
    expect(findAll(html, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["g1", "p1"]);
    expect(html).not.toContain(OLD.name);
    expect(html).not.toContain('data-tier="archived"');
  });

  it("switch on: a trailing group data-tier='archived' after every tier group, rows greyed with the chip, N matches", () => {
    const html = listHtml([GOLD, P1], { archived: [OLD, OLD2], showArchived: true });
    const tiers = findAll(html, "sponsor-group").map((g) => attrOf(g.open, "data-tier"));
    expect(tiers).toEqual(["gold", "partner", "archived"]);
    expect(attrOf(findAll(html, "sponsors-archived-switch")[0]!.open, "aria-checked")).toBe("true");
    const group = findAll(html, "sponsor-group").find((g) => attrOf(g.open, "data-tier") === "archived")!;
    const rows = findAll(group.outer, "sponsor-row");
    expect(rows.map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["a1", "a2"]);
    let checked = 0;
    for (const r of rows) {
      expect(attrOf(r.open, "data-archived")).toBe("true");
      expect(classTokens(r.open)).toContain(ARCHIVED_ROW);
      expect(flat(findAll(r.outer, "sponsor-row-archived-chip")[0]!.inner)).toBe(msg("sponsors.archive.chip"));
      checked++;
    }
    expect(checked).toBe(2);
    // the live rows are not greyed and carry no chip (negative with its positive pair above)
    for (const id of ["g1", "p1"]) {
      const live = rowOf(html, id);
      expect(live).not.toContain("sponsor-row-archived-chip");
      expect(live).not.toContain('data-archived="true"');
    }
    expect(flat(findAll(group.outer, "sponsor-group-header")[0]!.inner)).toContain(msg("sponsors.archive.group"));
    expect(SPONSOR_TIERS).not.toContain("archived");
  });

  it("flat list (a plan with no tiers): the archived group still trails the list", () => {
    const html = listHtml([P1, P2], { hasTiers: false, archived: [OLD], showArchived: true });
    expect(html.indexOf('data-tier="archived"')).toBeGreaterThan(html.lastIndexOf('data-sponsor-id="p2"'));
    expect(findAll(html, "sponsor-row").map((r) => attrOf(r.open, "data-sponsor-id"))).toEqual(["p1", "p2", "a1"]);
  });

  it("an archived row has no move buttons and no row action; a live row in the same render still has both (the pair)", () => {
    const html = listHtml([P1, P2], { archived: [OLD, OLD2], showArchived: true });
    const move = (id: string, name: string) =>
      [msg("settings.org.sponsors.moveUp", { name }), msg("settings.org.sponsors.moveDown", { name })].map((l) => rowOf(html, id).includes(`aria-label="${l}"`));
    expect(move("p1", P1.name), "live: both arrows (a group of two)").toEqual([true, true]);
    expect(findAll(rowOf(html, "p1"), "sponsor-row-action"), "live no-deal row offers Add deal").toHaveLength(1);
    let checked = 0;
    for (const o of [OLD, OLD2]) {
      expect(move(o.id, o.name), `${o.id}: no arrows`).toEqual([false, false]);
      expect(findAll(rowOf(html, o.id), "sponsor-row-action"), `${o.id}: no action`).toHaveLength(0);
      // the trash stays; the way in is the READ-ONLY page (an Open link, never the edit pencil)
      expect(rowOf(html, o.id)).toContain(`aria-label="${msg("settings.org.sponsors.remove", { name: o.name })}"`);
      expect(rowOf(html, o.id)).toContain(`href="${sponsorHref(SLUG, o.id).replaceAll("&", "&amp;")}"`);
      expect(rowOf(html, o.id)).not.toContain("sponsor-row-edit");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("viewer: the switch shows, and an archived row has no trash", () => {
    const html = listHtml([P1], { canEdit: false, archived: [OLD], showArchived: true });
    expect(findAll(html, "sponsors-archived-switch")).toHaveLength(1);
    expect(rowOf(html, "a1")).not.toContain(msg("settings.org.sponsors.remove", { name: OLD.name }).slice(0, 12) + "\"");
    expect(rowOf(html, "a1")).not.toContain(`aria-label="${msg("settings.org.sponsors.remove", { name: OLD.name })}"`);
    expect(rowOf(html, "a1")).toContain("sponsor-row-open");
  });
});

describe("the copy: four locales", () => {
  it("every archive key exists in all four locales with its placeholders intact (count reported)", () => {
    const need: [string, string[]][] = [
      ["sponsors.archive.title", []], ["sponsors.archive.button", []], ["sponsors.archive.buttonLabel", ["name"]],
      ["sponsors.archive.hint", []], ["sponsors.archive.blocked", []], ["sponsors.archive.done", ["name"]],
      ["sponsors.archive.banner", ["date"]], ["sponsors.archive.unarchive", []], ["sponsors.archive.unarchiveLabel", ["name"]],
      ["sponsors.archive.unarchived", ["name"]], ["sponsors.archive.show", ["count"]], ["sponsors.archive.group", []],
      ["sponsors.archive.chip", []], ["sponsors.error.archived", []],
    ];
    let checked = 0;
    for (const l of LOCALES) {
      const d = DICTS[l] as Record<string, string>;
      for (const [key, vars] of need) {
        const v = d[key];
        expect(v, `${l} ${key}`).toBeTypeOf("string");
        for (const name of vars) expect(v, `${l} ${key} {${name}}`).toContain(`{${name}}`);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * need.length);
  });

  it("save-error: sponsor_has_current_deal and sponsor_archived read the spec's words in en/es/fr/nl", () => {
    // typed from spec §10
    const BLOCKED = { en: "End or settle its deal first.", es: "Primero termina o liquida su acuerdo.", fr: "Terminez ou réglez d'abord son accord.", nl: "Beëindig of vereffen eerst de deal." };
    const ARCHIVED = {
      en: "This sponsor is archived. Unarchive it first.", es: "Este patrocinador está archivado. Desarchívalo primero.",
      fr: "Ce sponsor est archivé. Désarchivez-le d'abord.", nl: "Deze sponsor is gearchiveerd. Haal hem eerst uit het archief.",
    };
    for (const l of LOCALES) {
      expect((DICTS[l] as Record<string, string>)[SAVE_ERROR_MSG.sponsor_has_current_deal]).toBe(BLOCKED[l]);
      expect((DICTS[l] as Record<string, string>)[SAVE_ERROR_MSG.sponsor_archived]).toBe(ARCHIVED[l]);
    }
    expect(SAVE_ERROR_MSG.sponsor_has_current_deal).not.toBe(SAVE_ERROR_MSG.sponsor_has_open_deal);
  });

  it("hasDealHistory's refusal now ends 'Archive it instead.' in four locales", () => {
    const END = { en: "Archive it instead.", es: "Archívalo en su lugar.", fr: "Archivez-le plutôt.", nl: "Archiveer hem in plaats daarvan." };
    for (const l of LOCALES) expect((DICTS[l] as Record<string, string>)["sponsors.error.hasDealHistory"]!.endsWith(END[l]), l).toBe(true);
  });
});

// --- the page, with state ---------------------------------------------------------------------------------------------------------

const HUB: SponsorsHubData = {
  orgSlug: SLUG, orgTimezone: "Europe/London", deals: [], packages: [], tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize: true,
  monetizeOrgWide: true, monetizeCompetitionIds: [], finishedCompetitionIds: [], chargesEnabled: true, sponsorId: null, editSponsor: false,
  dealId: null, dealCreatedByName: null, dealWrittenOffByName: null, dealCompetitionFinished: false, reportLinks: [], reportDefaults: null,
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
function mount(rows: SponsorItem[], opts: { canEdit?: boolean; hasTiers?: boolean; hub?: Partial<SponsorsHubData> } = {}) {
  const island = renderIsland(
    OrgSponsors,
    { orgId: ORG, initialSponsors: rows, competitions: COMPS, hasTiers: opts.hasTiers ?? true, billingHref: "/billing", canEdit: opts.canEdit ?? true, hub: { ...HUB, ...opts.hub } },
    expandSponsorTree,
  );
  const byId = (id: string): ReactElement | undefined => island.tree().find((e) => propsOf(e)["data-testid"] === id);
  const click = (id: string) => (propsOf(byId(id) ?? (() => { throw new Error(`no ${id}`); })()).onClick as () => void)();
  return { island, byId, click, text: () =>
      flat(
        island
          .tree()
          .flatMap((e) => {
            const kids = propsOf(e).children;
            return (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string" || typeof k === "number").map(String);
          })
          .join(" "),
      ),
    rowIds: () => island.tree().filter((e) => propsOf(e)["data-testid"] === "sponsor-row").map((e) => propsOf(e)["data-sponsor-id"]) };
}
const archivedRow = (s: SponsorItem): SponsorItem => ({ ...s, archived_at: ARCHIVED_AT });
const liveRow = (s: SponsorItem): SponsorItem => ({ ...s, archived_at: null });
const isOn = (m: ReturnType<typeof mount>) => propsOf(m.byId("sponsors-archived-switch")!)["aria-checked"];

describe("the sequence: archive, show archived, unarchive, the row back in place, archive again", () => {
  it("through the sponsor page and the list's switch, with the real handlers", async () => {
    const m = mount([GOLD, P1, P2], { hub: { sponsorId: "p1" } });
    expect(m.byId("sponsors-archived-switch"), "empty first: no switch").toBeUndefined();
    // archive
    answer = (url, method) => (method === "POST" && url.endsWith("/sponsors/p1/archive") ? { status: 200, body: { data: archivedRow(P1) } } : { status: 200, body: { data: [] } });
    m.click("sponsor-sheet-archive-button");
    await flush();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/v1/orgs/${ORG}/sponsors/p1/archive`]);
    expect(m.text()).toContain(msg("sponsors.archive.done", { name: P1.name }));
    expect(m.byId("sponsor-sheet-archive"), "the card is replaced by the banner").toBeUndefined();
    expect(m.byId("sponsor-sheet-archived")).toBeDefined();
    expect(m.rowIds(), "off: the archived row is not in the list").toEqual(["g1", "p2"]);
    expect(isOn(m)).toBe(false);
    expect(m.text()).toContain(msg("sponsors.archive.show", { count: 1 }));
    // show archived
    m.click("sponsors-archived-switch");
    expect(isOn(m)).toBe(true);
    expect(m.rowIds()).toEqual(["g1", "p2", "p1"]);
    // unarchive
    answer = (url, method) => (method === "DELETE" && url.endsWith("/sponsors/p1/archive") ? { status: 200, body: { data: liveRow(P1) } } : { status: 200, body: { data: [] } });
    m.click("sponsor-sheet-unarchive");
    await flush();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `/api/v1/orgs/${ORG}/sponsors/p1/archive` });
    expect(m.text()).toContain(msg("sponsors.archive.unarchived", { name: P1.name }));
    expect(m.byId("sponsors-archived-switch"), "the last archived one is back: the switch is gone").toBeUndefined();
    expect(m.rowIds().sort(), "the row is back, live").toEqual(["g1", "p1", "p2"]);
    expect(m.byId("sponsor-sheet-archive"), "the page swaps the banner for the card").toBeDefined();
    expect(m.byId("sponsor-sheet-archived")).toBeUndefined();
    // a second archive: the switch comes back OFF (its state was reset by the unarchive)
    answer = (url, method) => (method === "POST" ? { status: 200, body: { data: archivedRow(P1) } } : { status: 200, body: { data: [] } });
    m.click("sponsor-sheet-archive-button");
    await flush();
    expect(isOn(m), "re-archiving shows the switch off again").toBe(false);
    expect(m.rowIds()).toEqual(["g1", "p2"]);
  });

  it("a 409 sponsor_has_current_deal (the page thought it free) shows the blocked words, leaves the row live, and re-reads rows and deals", async () => {
    const m = mount([P1], { hub: { sponsorId: "p1" } });
    answer = (url, method) =>
      method === "POST"
        ? { status: 409, body: { error: { code: "sponsor_has_current_deal", message: "x" } } }
        : { status: 200, body: { data: url.includes("sponsor-deals") ? [] : [P1] } };
    m.click("sponsor-sheet-archive-button");
    await flush();
    expect(m.text()).toContain(msg("sponsors.archive.blocked"));
    expect(m.rowIds()).toEqual(["p1"]);
    expect(m.byId("sponsors-archived-switch")).toBeUndefined();
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url).sort()).toEqual([`/api/v1/orgs/${ORG}/sponsor-deals`, `/api/v1/orgs/${ORG}/sponsors?archived=1`]);
  });

  it("a re-read keeps the archived rows (it asks for ?archived=1), so a write elsewhere does not lose the switch", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [{ ...P1, status: "inactive" }, OLD] } } : { status: 200, body: { data: liveRow(P1) } });
    const m2 = mount([{ ...P1, status: "inactive" }, OLD], { hub: { sponsorId: "p1" } });
    m2.click("sponsor-show-p1");
    await flush();
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors?archived=1`]);
    expect(m2.text()).toContain(msg("sponsors.archive.show", { count: 1 }));
  });

  it("a move never swaps with an archived neighbour (flat list: [a, archived, b] -> a goes below b, the archived one stays put)", async () => {
    const a = sponsor({ id: "a", name: "Alpha" });
    const z = archivedRow(sponsor({ id: "z", name: "Zulu" }));
    const b = sponsor({ id: "b", name: "Bravo" });
    const m = mount([a, z, b], { hasTiers: false });
    const down = m.island.tree().find((e) => propsOf(e)["aria-label"] === msg("settings.org.sponsors.moveDown", { name: "Alpha" }))!;
    (propsOf(down).onClick as () => void)();
    await flush();
    expect(calls.map((c) => c.body)).toEqual([{ ids: ["b", "z", "a"] }]);
    // the pair: with nothing archived the same tap swaps the two neighbours
    calls.length = 0;
    const m2 = mount([a, b], { hasTiers: false });
    (propsOf(m2.island.tree().find((e) => propsOf(e)["aria-label"] === msg("settings.org.sponsors.moveDown", { name: "Alpha" }))!).onClick as () => void)();
    await flush();
    expect(calls.map((c) => c.body)).toEqual([{ ids: ["b", "a"] }]);
  });
});

describe("the sponsor page: the Archive card", () => {
  const withDeals = (s: SponsorItem, deals: SponsorDeal[], canEdit = true) => mount([s], { canEdit, hub: { sponsorId: s.id, deals } });

  it("live sponsor, editor, no deals: the Archive card with its hint and an enabled button labelled 'Archive {name}'", () => {
    const m = withDeals(P1, []);
    const card = m.byId("sponsor-sheet-archive");
    expect(card).toBeDefined();
    expect(flat(renderToStaticMarkup(card!))).toContain(msg("sponsors.archive.hint"));
    const btn = m.byId("sponsor-sheet-archive-button")!;
    expect(propsOf(btn)["aria-label"]).toBe(msg("sponsors.archive.buttonLabel", { name: P1.name }));
    expect(propsOf(btn).disabled).toBe(false);
    expect(propsOf(btn)["aria-describedby"]).toBeUndefined();
    expect(m.byId("sponsor-sheet-archive-blocked")).toBeUndefined();
  });

  // Spec §8, typed row by row.
  const START = { go_live: "immediate" as const, ended_at: null, ended_reason: null, live_at: null, paid_at: null };
  const BLOCKING: [string, Partial<SponsorDeal>][] = [
    ["draft", { ...START, deal_status: "draft", payment_status: "pending" }],
    ["awaiting_payment", { ...START, deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online" }],
    ["awaiting_approval", { ...START, deal_status: "awaiting_approval", payment_status: "paid", go_live: "on_approval" }],
    ["scheduled, paid", { ...START, deal_status: "scheduled", payment_status: "paid" }],
    ["scheduled, unpaid", { ...START, deal_status: "scheduled", payment_status: "pending" }],
    ["live", { ...START, deal_status: "live", live_at: "2026-10-01T09:00:00.000Z" }],
    ["live, parked by a dispute", { ...START, deal_status: "live", live_at: "2026-10-01T09:00:00.000Z", parked_at: "2026-10-05T09:00:00.000Z", disputed_at: "2026-10-05T09:00:00.000Z" }],
    ["ended still due: expired", { deal_status: "ended", payment_method: "offline", payment_status: "pending", ended_reason: "expired", paid_at: null }],
    ["ended still due: competition_finished", { deal_status: "ended", payment_method: "offline", payment_status: "pending", ended_reason: "competition_finished", paid_at: null }],
  ];
  const SETTLED: [string, Partial<SponsorDeal>][] = [
    ["ended_now", { payment_status: "pending", paid_at: null, ended_reason: "ended_now" }],
    ["refunded", { payment_status: "refunded", ended_reason: "refunded" }],
    ["written_off", { payment_status: "pending", paid_at: null, ended_reason: "written_off" }],
    ["dispute_lost", { payment_status: "paid", ended_reason: "dispute_lost" }],
    ["ended, paid", { payment_status: "paid", ended_reason: "expired" }],
    ["offline, never went live", { payment_status: "pending", paid_at: null, live_at: null, ended_reason: "expired" }],
    ["online, unpaid (expired)", { payment_method: "online", payment_status: "pending", paid_at: null, ended_reason: "expired" }],
    ["paid, open dispute", { payment_status: "paid", ended_reason: "expired", disputed_at: "2026-10-10T09:00:00.000Z" }],
    ["legacy", { ended_reason: "legacy", payment_status: "paid" }],
  ];

  it("each blocking deal (spec §8 'yes' rows) disables the button and draws the visible blocked line, linked by aria-describedby (count reported)", () => {
    let checked = 0;
    for (const [label, over] of BLOCKING) {
      const m = withDeals(P1, [deal({ id: "dx", sponsor_id: "p1", ...over })]);
      const btn = m.byId("sponsor-sheet-archive-button")!;
      expect(propsOf(btn).disabled, label).toBe(true);
      const line = m.byId("sponsor-sheet-archive-blocked");
      expect(line, label).toBeDefined();
      expect(propsOf(btn)["aria-describedby"], label).toBe(propsOf(line!).id);
      expect(flat(renderToStaticMarkup(line!)), label).toContain("End or settle its deal first.");
      checked++;
    }
    expect(checked).toBe(BLOCKING.length);
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("an ended, settled deal leaves the button enabled (the positive pair of the blocking sweep; count reported)", () => {
    let checked = 0;
    for (const [label, over] of SETTLED) {
      const m = withDeals(P1, [deal({ id: "dx", sponsor_id: "p1", deal_status: "ended", ...over })]);
      expect(propsOf(m.byId("sponsor-sheet-archive-button")!).disabled, label).toBe(false);
      expect(m.byId("sponsor-sheet-archive-blocked"), label).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(SETTLED.length);
    // another sponsor's blocking deal does not hold this one
    const other = withDeals(P1, [deal({ id: "dy", sponsor_id: "someone-else", deal_status: "live" })]);
    expect(propsOf(other.byId("sponsor-sheet-archive-button")!).disabled).toBe(false);
  });

  it("viewer: no Archive card, on a live and on an archived sponsor; the archived banner still shows, with no Unarchive", () => {
    expect(withDeals(P1, [], false).byId("sponsor-sheet-archive")).toBeUndefined();
    const m = withDeals(archivedRow(P1), [], false);
    expect(m.byId("sponsor-sheet-archived")).toBeDefined();
    expect(m.byId("sponsor-sheet-unarchive")).toBeUndefined();
    expect(m.byId("sponsor-sheet-archive")).toBeUndefined();
  });

  it("archived: the banner names the date in the org timezone; Unarchive is present; Edit, editor, Show again, Add deal and the stream checkbox are absent; Deals and Report link remain", () => {
    // 23:30Z on 3 July is 00:30 on 4 July in Europe/London (BST): the org zone moves the day, the viewer's (UTC) would not.
    const a = { ...P1, status: "inactive", archived_at: "2026-07-03T23:30:00.000Z" };
    const m = mount([a], { hub: { sponsorId: "p1", orgTimezone: "Europe/London", deals: [deal({ id: "dh", sponsor_id: "p1", deal_status: "ended" })], reportDefaults: { from: "2026-01-01", to: "2026-12-31" } as never } });
    const banner = m.byId("sponsor-sheet-archived")!;
    expect(flat(renderToStaticMarkup(banner))).toContain(msg("sponsors.archive.banner", { date: "4 July 2026" }));
    expect(propsOf(m.byId("sponsor-sheet-unarchive")!)["aria-label"]).toBe(msg("sponsors.archive.unarchiveLabel", { name: P1.name }));
    for (const gone of ["sponsor-sheet-edit", "sponsor-sheet-editor", "sponsor-show-p1", "sponsor-sheet-add-deal", "sponsor-sheet-stream", "sponsor-sheet-archive"]) {
      expect(m.byId(gone), `${gone} is absent while archived`).toBeUndefined();
    }
    expect(m.byId("sponsor-sheet-stream-state"), "the read-only On/Off text shows instead").toBeDefined();
    expect(m.byId("sponsor-sheet-deals"), "Deals stay").toBeDefined();
    expect(m.byId("sponsor-sheet-deal"), "its ended deal is still listed, and still opens").toBeDefined();
    expect(m.byId("sponsor-sheet-deal-open")).toBeDefined();
    expect(m.island.tree().some((e) => e.type === ReportLinkSection), "Report link stays").toBe(true);
    // the pair: the same sponsor, live, has them (Edit, Show again, the stream tick, Add deal)
    const live = mount([{ ...P1, status: "inactive" }], { hub: { sponsorId: "p1" } });
    for (const here of ["sponsor-sheet-edit", "sponsor-show-p1", "sponsor-sheet-stream", "sponsor-sheet-add-deal", "sponsor-sheet-archive"]) {
      expect(live.byId(here), `${here} is present while live`).toBeDefined();
    }
  });

  it("?edit=1 on an archived sponsor opens the read-only page, never the editor (D24); on a live one it opens the editor (the pair)", () => {
    const a = mount([archivedRow(P1)], { hub: { sponsorId: "p1", editSponsor: true } });
    expect(a.byId("sponsor-sheet-editor")).toBeUndefined();
    expect(a.island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined)).toBeUndefined();
    expect(a.byId("sponsor-sheet-detail-name")).toBeDefined();
    const live = mount([P1], { hub: { sponsorId: "p1", editSponsor: true } });
    expect(live.byId("sponsor-sheet-editor")).toBeDefined();
  });

  it("Add deal never opens for an archived sponsor, whatever asked", () => {
    const m = mount([archivedRow(P1)], { hub: { sponsorId: "p1" } });
    expect(m.island.tree().find((e) => propsOf(e).sponsor && (propsOf(e).sponsor as SponsorItem).id === "p1" && propsOf(e).onCreate !== undefined)).toBeUndefined();
  });
});

describe("Overview: the Archived chip", () => {
  const row = (over: Partial<SponsorOverviewRow>): SponsorOverviewRow =>
    ({ sponsorId: "x", name: "X", timesShown: 1, onScreenMs: 1000, viewerImpressions: null, peakViewers: null, clicks: 1, archived: false, ...over }) as SponsorOverviewRow;
  it("an archived row carries the chip; a live row and a deleted one do not", () => {
    const rows = [row({ sponsorId: "a", name: "Arch", archived: true }), row({ sponsorId: "l", name: "Live" }), row({ sponsorId: null, name: "Gone" })];
    const island = renderIsland(OverviewTab, {
      orgId: ORG, orgSlug: SLUG, period: { kind: "this_year" } as never, nowIso: "2026-11-12T10:00:00.000Z", competitions: [], rows, canEdit: false, links: [], shareDefaults: null,
    } as never);
    const markup = renderToStaticMarkup(island.tree()[0]!);
    expect(markup).toBeTypeOf("string");
    const chips = findAll(markup, "sponsor-overview-archived");
    expect(chips).toHaveLength(1);
    expect(flat(chips[0]!.inner)).toBe(msg("sponsors.archive.chip"));
    expect(findAll(markup, "sponsor-overview-row-a")[0]!.outer).toContain("sponsor-overview-archived");
    expect(findAll(markup, "sponsor-overview-row-l")[0]!.outer).not.toContain("sponsor-overview-archived");
  });
});
