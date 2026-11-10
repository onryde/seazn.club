// Sponsor deals, Task 12 - the Sponsors tab's manager (components/org-sponsors.tsx) on the deal API.
//
// Three things changed for a person using it, each pinned here from the side a person meets it on:
//   1. A sponsor under a LIVE deal has its tier and competition controls disabled, with the deal's reason beside them
//      (`locked_by_deal`, D9): the deal owns those fields, and a PATCH of either answers 409 `sponsor_locked_by_deal`.
//   2. Deleting a sponsor that has a deal asks first - in words that match the server's rule (deals go with the sponsor) - and a
//      refusal (409 `sponsor_has_deal_history`, `sponsor_has_open_checkout`) reads the DICTIONARY's words, never the server's.
//   3. The retired "Delete a paid placement?" promise (the server now refuses that delete) is gone.
//
// vitest is `environment: "node"`: the island runs under components/__tests__/_hook-harness.tsx (the element TREE back, a click is
// the element's own prop called); the form's markup is read with `renderToStaticMarkup`, which is where `disabled` shows. What
// neither can see (CSS, widths, tap area) is the e2e's (`e2e/sponsor-deals-api.spec.ts`, run by CI).
//
// Since sponsor deals Task 14 the rows are drawn by `SponsorList` (components/sponsors/sponsor-list.tsx), a stateless child of
// OrgSponsors: the island is mounted with `expandSponsorTree` (components/sponsors/__tests__/_sponsor-tree.tsx), which steps
// into it, so every click below is still the element's own handler on the tree a person's browser would be handed. Rows
// carry a FULL deal (`dealOf`), as the server's list sends it - the chip and the row's action read it.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   K1  lock         drop `|| lockedByDeal` from the tier / competition selects' `disabled` -> "the selects are disabled"
//   K2  wiring       `lockedByDeal={s.locked_by_deal}` -> `lockedByDeal={false}`           -> "edit passes the row's lock to the form"
//   K3  delete ask   drop the `s.deal` arm of the confirm guard                            -> "a sponsor with a deal asks first"
//   K4  mapped       `msg(sponsorSaveErrorKey(err))` -> `err.message`                      -> "a refusal reads the dictionary's words"
//   K5  show again   offer "Show on site again" on every row                                -> "offered exactly where the server accepts it"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

import { OrgSponsors, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "@/components/sponsors/__tests__/_sponsor-tree";
import type { PaymentStatus, SponsorDeal } from "@/lib/sponsor-deals";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const ORG = "org-1";
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
const COMPETITIONS = [{ id: "c1", name: "Spring Cup" }];

const row = (over: Partial<SponsorItem> & { id: string }): SponsorItem => ({
  competition_id: null,
  name: `Sponsor ${over.id}`,
  url: null,
  logo_path: null,
  tier: "gold",
  display_order: 0,
  status: "active",
  click_count: 0,
  on_stream: false,
  paid_order_id: null,
  deal: null,
  locked_by_deal: false,
  has_open_deal: false,
  last_billing_email: null,
  ...over,
});
/** A deal as the server's list sends it (the whole `SponsorDeal`), for a row to show. Live and paid unless a test says otherwise. */
const dealOf = (id: string, payment_status: PaymentStatus, over: Partial<SponsorDeal> = {}): SponsorDeal => ({
  id, sponsor_id: "a", package_id: "p1", deal_status: "live", payment_status, payment_method: "online", go_live: "on_payment",
  package_name: "Gold Season", tier: "gold", includes_on_stream: false, competition_id: null, amount_cents: 60_000, currency: "gbp",
  sponsor_name: "Sponsor", sponsor_email: null, ends_at: null, created_at: "2026-10-01T09:00:00.000Z", created_by: null,
  invoice_sent_at: null, paid_at: null, marked_paid_by: null, approved_at: null, approved_by: null, live_at: null, ended_at: null,
  ended_reason: null, parked_at: null, disputed_at: null, dispute_id: null, has_payment_intent: false, invoice_number: null,
  ...over,
});
const DEAL = dealOf("d1", "none");

const DRAFT = { name: "Name", url: "", tier: "gold" as const, competition_id: "", file: null, preview: null };

function formMarkup(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <SponsorForm
      value={DRAFT}
      onChange={() => {}}
      onSubmit={() => {}}
      submitLabel="Save"
      busy={false}
      hasTiers
      showPlacement
      lockedByDeal={false}
      competitions={COMPETITIONS}
      onPickLogo={() => {}}
      {...over}
    />,
  );
}
/** The opening tag of the `<select>` whose option list holds `needle`. */
const selectTagHolding = (html: string, needle: string): string => {
  const m = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].find((x) => x[0].includes(needle));
  if (!m) throw new Error(`no <select> holds ${needle}`);
  return /^<select\b[^>]*>/.exec(m[0])![0];
};
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);

describe("the form: a live deal owns the tier and the competition (sponsor deals D9)", () => {
  it("locked: both selects are disabled and the deal's reason is on the form; the name and link stay editable", () => {
    const html = formMarkup({ lockedByDeal: true });
    expect(isDisabled(selectTagHolding(html, msg("sponsors.tier.gold"))), "tier").toBe(true);
    expect(isDisabled(selectTagHolding(html, "Spring Cup")), "competition").toBe(true);
    expect(flat(html)).toContain(msg("sponsors.deal.lockedNote"));
    expect(msg("sponsors.deal.lockedNote"), "the brief's words").toBe("Set by the live deal");
    // The pair: the fields a deal does NOT own are still typeable, and the save button is not disabled by the lock.
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="file"/.test(tag));
    expect(inputs.length, "premise: the form has its text inputs").toBeGreaterThanOrEqual(2);
    for (const tag of inputs) expect(isDisabled(tag), tag).toBe(false);
    expect(isDisabled(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*Save<\/button>/.exec(html)![0].match(/^<button\b[^>]*>/)![0])).toBe(false);
  });

  it("locked: the reason is the selects' accessible description - both selects point at the one note that exists (fix round 1, m1)", () => {
    const html = formMarkup({ lockedByDeal: true });
    const noteTag = /<p\b[^>]*data-testid="sponsor-locked-note"[^>]*>/.exec(html)?.[0];
    expect(noteTag, "premise: the locked form carries the note").toBeDefined();
    const noteId = /\sid="([^"]+)"/.exec(noteTag!)?.[1];
    expect(noteId, "the note has an id to be pointed at").toBeTruthy();
    expect(html.split(`id="${noteId}"`).length - 1, "and exactly one element carries it").toBe(1);
    const describedBy = (tag: string) => /\saria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(describedBy(selectTagHolding(html, msg("sponsors.tier.gold"))), "tier").toBe(noteId);
    expect(describedBy(selectTagHolding(html, "Spring Cup")), "competition").toBe(noteId);
  });

  it("unlocked: no note, and the selects describe nothing (a dangling aria-describedby would name an element that is not there)", () => {
    const html = formMarkup({ lockedByDeal: false });
    expect(html).not.toContain("sponsor-locked-note");
    expect(selectTagHolding(html, msg("sponsors.tier.gold"))).not.toContain("aria-describedby");
    expect(selectTagHolding(html, "Spring Cup")).not.toContain("aria-describedby");
  });

  it("unlocked: the selects are enabled and no reason is shown (the pair)", () => {
    const html = formMarkup({ lockedByDeal: false });
    expect(isDisabled(selectTagHolding(html, msg("sponsors.tier.gold")))).toBe(false);
    expect(isDisabled(selectTagHolding(html, "Spring Cup"))).toBe(false);
    expect(flat(html)).not.toContain(msg("sponsors.deal.lockedNote"));
  });

  it("a plan without tiers shows no selects, so no reason either - even for a locked sponsor", () => {
    const html = formMarkup({ lockedByDeal: true, hasTiers: false });
    expect(html).not.toContain("<select");
    expect(flat(html)).not.toContain(msg("sponsors.deal.lockedNote"));
  });
});

const fetchMock = vi.fn();
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let answer: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { data: [] } });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  confirmMock.mockImplementation(async () => true);
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

/** What the hub page hands the island (Task 13). Typed, so a prop the island starts reading cannot be missing here without tsc
 *  saying so (review M6: a cast hid `hub` from the type-check). */
const HUB: SponsorsHubData = {
  orgSlug: "harbour-vale",
  deals: [],
  packages: [],
  hasMonetize: true,
  monetizeOrgWide: true,
  monetizeCompetitionIds: [],
  finishedCompetitionIds: [],
  chargesEnabled: true,
  sponsorId: null,
  dealId: null,
  reportLinks: [],
  reportDefaults: null,
};

function mount(rows: SponsorItem[], opts: { canEdit?: boolean; sponsorId?: string } = {}) {
  const props: Parameters<typeof OrgSponsors>[0] = {
    orgId: ORG,
    initialSponsors: rows,
    competitions: COMPETITIONS,
    hasTiers: true,
    billingHref: "/billing",
    canEdit: opts.canEdit ?? true,
    hub: opts.sponsorId === undefined ? HUB : { ...HUB, sponsorId: opts.sponsorId },
  };
  const island = renderIsland(OrgSponsors, props, expandSponsorTree);
  const byLabel = (key: MessageKey, name: string): ReactElement => {
    const label = msg(key, { name });
    const el = island.tree().find((e) => propsOf(e)["aria-label"] === label);
    if (!el) throw new Error(`no control labelled "${label}"`);
    return el;
  };
  const form = (): ReactElement => {
    const el = island.tree().find((e) => "lockedByDeal" in propsOf(e) && "submitLabel" in propsOf(e) && propsOf(e).onCancel !== undefined);
    if (!el) throw new Error("no edit form is open");
    return el;
  };
  return {
    island,
    edit: (name: string) => (propsOf(byLabel("sponsors.edit", name)).onClick as () => void)(),
    remove: (name: string) => (propsOf(byLabel("settings.org.sponsors.remove", name)).onClick as () => void)(),
    form,
    hasRow: (name: string) => island.tree().some((e) => e.type === "li" && textOf(e).includes(name)),
    has: (testId: string) => island.tree().some((e) => propsOf(e)["data-testid"] === testId),
    find: (testId: string): ReactElement => {
      const el = island.tree().find((e) => propsOf(e)["data-testid"] === testId);
      if (!el) throw new Error(`no element with data-testid="${testId}"`);
      return el;
    },
    // The words on screen, read from the EXPANDED tree: the sponsor's page (its error line among them) is a child component, and
    // `island.text()` reads only what the island itself returned. Each element's own string children, so nothing is counted twice.
    text: () =>
      flat(
        island
          .tree()
          .flatMap((e) => {
            const kids = propsOf(e).children;
            return (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string" || typeof k === "number").map(String);
          })
          .join(" "),
      ),
  };
}

describe("Edit hands the form the ROW's lock (the join between the list and the form)", () => {
  it("a locked sponsor opens its form locked; an unlocked one opens it free (both checked)", () => {
    const locked = mount([row({ id: "a", name: LONG_NAME, deal: DEAL, locked_by_deal: true })]);
    locked.edit(LONG_NAME);
    expect(propsOf(locked.form()).lockedByDeal).toBe(true);
    const free = mount([row({ id: "b", name: "Quay Chandlers" })]);
    free.edit("Quay Chandlers");
    expect(propsOf(free.form()).lockedByDeal).toBe(false);
  });

  it("the ADD form is never locked (a new sponsor has no deal)", () => {
    const m = mount([]);
    const add = m.island.tree().find((e) => "lockedByDeal" in propsOf(e) && "submitLabel" in propsOf(e));
    expect(add, "premise: the add form is on the page").toBeDefined();
    expect(propsOf(add!).lockedByDeal).toBe(false);
  });

  it("saving a locked sponsor's name sends the name ALONE - the disabled tier and scope never ride the PATCH", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 200, body: { data: {} } });
    const m = mount([row({ id: "a", name: "Old name", tier: "title", competition_id: "c1", deal: DEAL, locked_by_deal: true })]);
    m.edit("Old name");
    (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => typeof DRAFT) => void)((p) => ({ ...p, name: "New name" }));
    (propsOf(m.form()).onSubmit as () => void)();
    await flush();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors/a`]);
    expect(patches[0]!.body).toEqual({ name: "New name" });
  });

  it("a PATCH the server still refuses (409 sponsor_locked_by_deal) reads the dictionary's words", async () => {
    const SERVER = "this sponsor has a live deal: its tier, scope, stream and visibility come from the deal";
    answer = (_url, method) =>
      method === "PATCH"
        ? { status: 409, body: { ok: false, error: { code: "sponsor_locked_by_deal", message: SERVER } } }
        : { status: 200, body: { data: [] } };
    const m = mount([row({ id: "a", name: "Old name", deal: DEAL, locked_by_deal: true })]);
    m.edit("Old name");
    (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => typeof DRAFT) => void)((p) => ({ ...p, name: "New name" }));
    (propsOf(m.form()).onSubmit as () => void)();
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.lockedByDeal"));
    expect(m.text()).not.toContain(SERVER);
  });
});

describe("a refused logo upload reads the dictionary's words, never the server's (fix round 1, m6)", () => {
  it("the upload route's refusal - a sentence, or a structured validation error - shows 'Upload not allowed' and saves nothing (both checked)", async () => {
    const CASES: [string, unknown][] = [
      ["Unsupported image type", { ok: false, error: "Unsupported image type" }],
      ["Invalid input: content_type", { ok: false, error: { code: "VALIDATION", message: "Invalid input: content_type" } }],
    ];
    let checked = 0;
    for (const [serverText, body] of CASES) {
      calls.length = 0;
      answer = (url, method) =>
        url.includes("/content-upload") && method === "POST" ? { status: 415, body } : { status: 200, body: { data: [] } };
      const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
      m.edit("Quay Chandlers");
      const file = new File(["x"], "logo.png", { type: "image/png" });
      (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => unknown) => void)((p) => ({ ...p, file }));
      (propsOf(m.form()).onSubmit as () => void)();
      await flush();
      expect(calls.some((c) => c.url.includes("/content-upload")), `${serverText}: the upload was attempted`).toBe(true);
      expect(m.text(), serverText).toContain(msg("settings.org.sponsors.uploadNotAllowed"));
      expect(m.text(), serverText).not.toContain(serverText);
      expect(m.text(), serverText).not.toContain("[object Object]");
      expect(calls.filter((c) => c.method === "PATCH"), `${serverText}: nothing was saved`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });
});

describe("Delete: the confirm says what the server will really do, and a refusal is the dictionary's words", () => {
  it("a sponsor with a deal asks first, in the deal copy, and the old paid-placement promise is gone", async () => {
    answer = () => ({ status: 200, body: { data: null } });
    const m = mount([row({ id: "a", name: LONG_NAME, deal: DEAL })]);
    m.remove(LONG_NAME);
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string };
    expect(opts.title).toBe(msg("sponsors.deleteDeal.title"));
    expect(opts.body).toBe(msg("sponsors.deleteDeal.body", { name: LONG_NAME }));
    expect(opts.confirmLabel).toBe(msg("sponsors.deleteDeal.label"));
    expect(opts.body, "it must not claim a paid placement is kept or refunded - the server refuses that delete").not.toMatch(/NOT refunded/i);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors/a`]);
    expect(m.hasRow(LONG_NAME), "a confirmed delete leaves the list").toBe(false);
  });

  it("declining the confirm sends nothing and keeps the row", async () => {
    confirmMock.mockImplementation(async () => false);
    const m = mount([row({ id: "a", name: "Quay Chandlers", deal: DEAL })]);
    m.remove("Quay Chandlers");
    await flush();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(m.hasRow("Quay Chandlers")).toBe(true);
  });

  it("a sponsor with no deal deletes without a confirm, as before (the pair)", async () => {
    answer = () => ({ status: 200, body: { data: null } });
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.remove("Quay Chandlers");
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("a sponsor with a PAID deal is not asked to confirm a delete the server refuses: the server's refusal is shown in the dictionary's words and the row stays", async () => {
    const SERVER = "this sponsor has deal history (money paid or refunded, or a pre-deals order) — end its deals instead";
    answer = (_url, method) =>
      method === "DELETE"
        ? { status: 409, body: { ok: false, error: { code: "sponsor_has_deal_history", message: SERVER } } }
        : { status: 200, body: { data: [] } };
    const m = mount([row({ id: "a", name: "Quay Chandlers", deal: DEAL, paid_order_id: "o1" })]);
    m.remove("Quay Chandlers");
    await flush();
    expect(confirmMock, "no confirm for a delete that cannot happen").not.toHaveBeenCalled();
    expect(m.text()).toContain(msg("sponsors.error.hasDealHistory"));
    expect(m.text()).not.toContain(SERVER);
    expect(m.hasRow("Quay Chandlers")).toBe(true);
  });

  it("a sponsor whose shown deal was paid, or refunded, is not asked to confirm a delete that cannot happen either (both checked)", async () => {
    const SERVER = "this sponsor has deal history";
    let checked = 0;
    for (const payment_status of ["paid", "refunded"] as const) {
      confirmMock.mockClear();
      answer = (_url, method) =>
        method === "DELETE"
          ? { status: 409, body: { ok: false, error: { code: "sponsor_has_deal_history", message: SERVER } } }
          : { status: 200, body: { data: [] } };
      const m = mount([row({ id: "a", name: "Quay Chandlers", deal: dealOf("d1", payment_status) })]);
      m.remove("Quay Chandlers");
      await flush();
      expect(confirmMock, payment_status).not.toHaveBeenCalled();
      expect(m.text(), payment_status).toContain(msg("sponsors.error.hasDealHistory"));
      expect(m.hasRow("Quay Chandlers"), payment_status).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
    // The pair: a deal that took no money (complimentary, or unpaid) still asks.
    confirmMock.mockClear();
    answer = () => ({ status: 200, body: { data: null } });
    mount([row({ id: "b", name: "Ridge Cycles", deal: dealOf("d2", "pending") })]).remove("Ridge Cycles");
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("each delete refusal reads its own words: history, and an open payment link that could not be closed (both checked)", async () => {
    const CASES: [string, MessageKey][] = [
      ["sponsor_has_deal_history", "sponsors.error.hasDealHistory"],
      ["sponsor_has_open_checkout", "sponsors.error.hasOpenCheckout"],
    ];
    let checked = 0;
    for (const [code, key] of CASES) {
      answer = (_url, method) =>
        method === "DELETE" ? { status: 409, body: { ok: false, error: { code, message: "server english" } } } : { status: 200, body: { data: [] } };
      const m = mount([row({ id: "a", name: "Quay Chandlers", deal: DEAL })]);
      m.remove("Quay Chandlers");
      await flush();
      expect(m.text(), code).toContain(msg(key));
      expect(m.text(), code).not.toContain("server english");
      expect(m.hasRow("Quay Chandlers"), `${code}: the row stays`).toBe(true);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });
});

describe("the copy that replaces the paid-placement promise", () => {
  it("states the real rule: deals go with the sponsor, history blocks the delete (and says so)", () => {
    expect(msg("sponsors.deleteDeal.body", { name: "X" })).toMatch(/deal/i);
    expect(msg("sponsors.error.hasDealHistory")).toMatch(/can.t be deleted/i);
    expect(msg("sponsors.error.hasOpenCheckout")).toMatch(/payment link/i);
  });
});

describe("Show on site again (now on the sponsor's page, Task 15): a hidden sponsor whose deals have all ended is switched back on by hand (spec §10.3, batch F fix round 2)", () => {
  // Spec §10.3 (owner, 2026-11-07): "After all of a sponsor's deals have ended: the club may switch the sponsor back on by hand,
  // as for a sponsor with no deal." The server's rule for `PATCH { status }` (server/usecases/sponsors.ts `patchSponsor`): a
  // live deal refuses it (409 sponsor_locked_by_deal), a deal waiting to go live refuses it (409 sponsor_has_open_deal), and a
  // dispute-parked (`pending`) placement refuses it. Typed here from that rule, never read from the component.
  const CASES: [string, Partial<SponsorItem>, boolean, boolean][] = [
    ["inactive, its deals all ended", { status: "inactive", deal: dealOf("d1", "pending", { deal_status: "ended" }) }, true, true],
    ["inactive, no deal at all", { status: "inactive" }, true, true],
    ["active", { status: "active" }, true, false],
    ["inactive, a deal waiting to go live", { status: "inactive", deal: dealOf("d2", "pending", { deal_status: "awaiting_payment" }), has_open_deal: true }, true, false],
    ["inactive, under a live deal", { status: "inactive", deal: dealOf("d3", "paid"), locked_by_deal: true }, true, false],
    ["parked by a dispute", { status: "pending", dispute_parked: true, deal: dealOf("d4", "paid") }, true, false],
    ["inactive, no deal, but the viewer cannot edit", { status: "inactive" }, false, false],
  ];

  it("offered exactly where the server accepts it - inactive with no open or live deal, for an editor (all seven checked)", () => {
    let checked = 0;
    for (const [label, over, canEdit, offered] of CASES) {
      const m = mount([row({ id: "a", name: LONG_NAME, ...over })], { canEdit, sponsorId: "a" });
      expect(m.has("sponsor-show-a"), label).toBe(offered);
      checked++;
    }
    expect(checked).toBe(CASES.length);
    expect(CASES.filter((c) => c[3]).length, "both arms exercised").toBe(2);
  });

  it("its words: 'Show on site again', named for the sponsor to a screen reader (label in name)", () => {
    const m = mount([row({ id: "a", name: LONG_NAME, status: "inactive" })], { sponsorId: "a" });
    const button = m.find("sponsor-show-a");
    expect(flat(textOf(button)), "the visible words").toBe(msg("sponsors.showAgain"));
    expect(propsOf(button)["aria-label"]).toBe(msg("sponsors.showAgainLabel", { name: LONG_NAME }));
    expect(String(propsOf(button)["aria-label"]).startsWith(msg("sponsors.showAgain")), "the accessible name starts with the visible words").toBe(true);
  });

  it("a tap PATCHes the sponsor with EXACTLY { status: 'active' } - no confirm - and re-reads the list; the switched-on row offers it no more", async () => {
    answer = (_url, method) =>
      method === "PATCH"
        ? { status: 200, body: { ok: true, data: row({ id: "a", name: LONG_NAME, status: "active" }) } }
        : { status: 200, body: { ok: true, data: [row({ id: "a", name: LONG_NAME, status: "active" })] } };
    const m = mount([row({ id: "a", name: LONG_NAME, status: "inactive", deal: dealOf("d1", "pending", { deal_status: "ended" }) })], { sponsorId: "a" });
    (propsOf(m.find("sponsor-show-a")).onClick as () => void)();
    await flush();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors/a`]);
    expect(patches[0]!.body).toEqual({ status: "active" });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url), "the list is re-read").toEqual([`/api/v1/orgs/${ORG}/sponsors`]);
    expect(m.has("sponsor-show-a"), "now active: nothing to show again").toBe(false);
  });

  it("a deal that arrived since the page loaded: the server's 409 sponsor_has_open_deal reads the dictionary's words, and the re-read hides the control", async () => {
    const SERVER = "this sponsor has a deal waiting to go live: it shows once that deal is live";
    answer = (_url, method) =>
      method === "PATCH"
        ? { status: 409, body: { ok: false, error: { code: "sponsor_has_open_deal", message: SERVER } } }
        : { status: 200, body: { ok: true, data: [row({ id: "a", name: LONG_NAME, status: "inactive", has_open_deal: true, deal: dealOf("d9", "pending", { deal_status: "awaiting_payment" }) })] } };
    const m = mount([row({ id: "a", name: LONG_NAME, status: "inactive" })], { sponsorId: "a" });
    (propsOf(m.find("sponsor-show-a")).onClick as () => void)();
    await flush();
    expect(m.text()).toContain(msg("sponsors.error.hasOpenDeal"));
    expect(m.text()).not.toContain(SERVER);
    expect(calls.filter((c) => c.method === "GET"), "re-read after the refusal").toHaveLength(1);
    expect(m.has("sponsor-show-a"), "the re-read row has an open deal: no control").toBe(false);
  });
});
