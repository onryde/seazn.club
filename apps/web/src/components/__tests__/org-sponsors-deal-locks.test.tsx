// Sponsor deals, Task 12 - the Sponsors tab's manager (components/org-sponsors.tsx) on the deal API.
//
// Three things changed for a person using it, each pinned here from the side a person meets it on:
//   1. The EDIT form has no tier or competition control at all (owner, 2026-11-11: "why showing tier in sponsor edit?"): a sponsor's
//      tier and scope are its deals' to set, so the editor is a name, a link and a logo, on every plan and under every deal state. (A
//      LIVE deal still owns the stream box and a PATCH of the tier or scope still answers 409 `sponsor_locked_by_deal`, D9.)
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
//   K1  selects      draw a tier <select> in SponsorForm again                              -> "no tier or competition control"
//   K2  draft        `draftOf` puts `tier` back into the edit draft                          -> "the edit draft is a name, a link and a logo"
//   K3  delete ask   drop the `s.deal` arm of the confirm guard                            -> "a sponsor with a deal asks first"
//   K4  mapped       `msg(sponsorSaveErrorKey(err))` -> `err.message`                      -> "a refusal reads the dictionary's words"
//   K5  show again   offer "Show on site again" on every row                                -> "offered exactly where the server accepts it"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
// The island reads a router (to clear the pencil's ?edit=1 once its editor is done); nothing in this file navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { OrgSponsors, SPONSOR_TIERS, SponsorForm, type SponsorItem, type SponsorsHubData } from "@/components/org-sponsors";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "@/components/sponsors/__tests__/_sponsor-tree";
import type { PaymentStatus, SponsorDeal } from "@/lib/sponsor-deals";
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

const DRAFT = { name: "Name", url: "", file: null, preview: null };

function formMarkup(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}} {...over} />,
  );
}
const formMarkupEl = () => (
  <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}} />
);
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);

/** Every word the old tier / competition controls drew: the two labels, the "all competitions" option, each tier's name and the
 *  deal-lock note. Typed from the dictionary keys, never from the form. */
const PLACEMENT_WORDS = (): string[] => [
  msg("sponsors.tierLabel"),
  msg("sponsors.scopeLabel"),
  msg("sponsors.scopeAll"),
  msg("sponsors.deal.lockedNote"),
  ...SPONSOR_TIERS.map((tier) => msg(TIER_MSG[tier])),
  ...COMPETITIONS.map((c) => c.name),
];

describe("the form: a name, a link and a logo - no tier or competition control (owner, 2026-11-11)", () => {
  it("drawn on its own it is the name and link boxes, the logo button and Save, and nothing that places the sponsor (the positive pair of the sweeps below)", () => {
    const html = formMarkup();
    expect(html, "no select of any kind").not.toContain("<select");
    expect(html, "no lock note").not.toContain("sponsor-locked-note");
    const words = PLACEMENT_WORDS();
    expect(words.length, "premise: the sweep names the two labels, the option, the note, four tiers and a competition").toBe(4 + SPONSOR_TIERS.length + COMPETITIONS.length);
    for (const w of words) expect(flat(html), `the form says "${w}"`).not.toContain(w);
    // The positive pair: what the form IS.
    expect(flat(html)).toContain(msg("settings.org.sponsors.name"));
    expect(flat(html)).toContain(msg("settings.org.sponsors.link"));
    expect(flat(html)).toContain(msg("sponsors.logoLabel"));
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="file"/.test(tag));
    expect(inputs, "name and link").toHaveLength(2);
    for (const tag of inputs) expect(isDisabled(tag), tag).toBe(false);
    expect(isDisabled(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*Save<\/button>/.exec(html)![0].match(/^<button\b[^>]*>/)![0])).toBe(false);
  });
});

// --- the logo tile (owner, 2026-11-11, stg: "are there will be any particular format of image to be ? remove logo word in that imge upload?") ---
// The tile is an icon: no "Logo" word inside the dashed box (its accessible name stays), and ONE hint beside it says what it takes. The
// words are the owner-approved sentence; the format list and the size are the picker's own (the `accept` it offers, the cap `pickLogo`
// enforces), so the hint cannot say something the picker does not do.
//
// Killers (one at a time, restore from a cp backup):
//   G1  the word        draw `msg("sponsors.logoLabel")` inside the tile again                       -> "no visible Logo word"
//   G2  the name        drop the tile's `aria-label`                                                 -> "the tile keeps its accessible name"
//   G3  the link        drop `aria-describedby` from the tile                                        -> "the tile is described by the hint"
//   G4  the formats     type the format list into the hint ("PNG or JPG")                            -> "the hint names every format the picker accepts"
//   G5  the size        type "2" into the hint instead of the cap                                    -> "the cap the hint names is the cap the picker enforces"
//   G6  the cap         MAX_LOGO_BYTES = 5 * 1024 * 1024                                              -> "the cap the hint names ..." and the 2 MB sentence
//   G7  the locale      format the list with a fixed "en"                                            -> "the list is in the page's language"
const LOGO_TYPE_NAME: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPG", "image/webp": "WebP" };
const LOGO_HINT_EN = "PNG, JPG or WebP, up to 2 MB. A square logo on a transparent background works best.";
/** Visible text of a markup string: tags gone, the two entities React writes for ' and & read back. */
const stripTags = (h: string) => h.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The picker's tile: the one button in the form that carries the logo label. */
const tileIn = (html: string) => [...html.matchAll(/<button\b[^>]*\baria-label="Logo"[^>]*>([\s\S]*?)<\/button>/g)];
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

describe("the logo tile: an icon with an accessible name, and one hint that says what it takes (owner, 2026-11-11)", () => {
  it("the tile shows no visible Logo word - an icon only - and keeps its accessible name (empty and with a picked preview)", () => {
    let checked = 0;
    for (const html of [formMarkup(), formMarkup({ compact: true }), formMarkup({ value: { ...DRAFT, preview: "blob:picked" } })]) {
      const tiles = tileIn(html);
      expect(tiles.length, "exactly one tile").toBe(1);
      const tag = /<button\b[^>]*\baria-label="Logo"[^>]*>/.exec(html)![0];
      expect(attr(tag, "aria-label"), "the tile keeps its accessible name").toBe(msg("sponsors.logoLabel"));
      expect(msg("sponsors.logoLabel"), "premise: that name is the word the owner asked to see go").toBe("Logo");
      expect(stripTags(tiles[0]![1]!), "no visible word inside the dashed box").toBe("");
      checked++;
    }
    expect(checked, "empty, compact and previewed").toBe(3);
    // the pair: the empty tile draws the icon, a previewed one draws the picture
    expect(tileIn(formMarkup())[0]![1]).toContain("<svg");
    expect(tileIn(formMarkup({ value: { ...DRAFT, preview: "blob:picked" } }))[0]![1]).toContain("<img");
  });

  it("one hint says what the picker takes, in the owner's words, and the tile is described by it", () => {
    let checked = 0;
    for (const html of [formMarkup(), formMarkup({ compact: true })]) {
      expect(flat(stripTags(html)), "the hint").toContain(LOGO_HINT_EN);
      const hints = [...html.matchAll(/<p\b[^>]*>([^<]*)<\/p>/g)].filter((m) => flat(m[1]!) === LOGO_HINT_EN);
      expect(hints.length, "exactly one hint").toBe(1);
      const id = attr(hints[0]![0], "id");
      expect(id, "the hint has an id").toBeTruthy();
      const tag = /<button\b[^>]*\baria-label="Logo"[^>]*>/.exec(html)![0];
      expect(attr(tag, "aria-describedby"), "the tile is described by the hint").toBe(id);
      checked++;
    }
    expect(checked).toBe(2);
    // two forms on one page (add + edit) must not share an id
    const a = attr(/<p\b[^>]*>PNG/.exec(formMarkup())![0], "id");
    const both = renderToStaticMarkup(<>{formMarkupEl()}{formMarkupEl()}</>);
    const ids = [...both.matchAll(/<p\b([^>]*)>PNG/g)].map((m) => attr(`<p${m[1]}>`, "id"));
    expect(a).toBeTruthy();
    expect(ids.length).toBe(2);
    expect(new Set(ids).size, "each form's hint has its own id").toBe(2);
  });

  it("the hint names every format the picker accepts - the file input's own `accept` - and no other", () => {
    const html = formMarkup();
    const input = /<input\b[^>]*type="file"[^>]*>/.exec(html)![0];
    const accepted = (attr(input, "accept") ?? "").split(",");
    expect(accepted, "the picker still takes PNG, JPG and WebP").toEqual(["image/png", "image/jpeg", "image/webp"]);
    const names = accepted.map((type) => LOGO_TYPE_NAME[type]);
    expect(names.every((n) => typeof n === "string"), "premise: every accepted type has a name here").toBe(true);
    const list = new Intl.ListFormat("en-GB", { style: "long", type: "disjunction" }).format(names as string[]);
    expect(flat(stripTags(html)), "the hint lists exactly those").toContain(`${list}, up to`);
  });

  it("the cap the hint names is the cap the picker enforces: that many bytes are taken, one more is refused with the size words", () => {
    const html = formMarkup();
    const mb = Number(/up to (\d+) MB/.exec(flat(stripTags(html)))?.[1]);
    expect(Number.isInteger(mb) && mb > 0, "premise: the hint carries a whole number of MB").toBe(true);
    const cap = mb * 1024 * 1024;
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    const pick = (size: number) => {
      const file = new File([new Uint8Array(size)], "logo.png", { type: "image/png" });
      const form = m.form();
      (propsOf(form).onPickLogo as (f: File, set: unknown) => void)(file, propsOf(form).onChange);
      return file;
    };
    const atCap = pick(cap);
    expect((propsOf(m.form()).value as { file: File | null }).file, "a file of exactly the cap is taken").toBe(atCap);
    expect(m.text(), "and says nothing about size").not.toContain(msg("settings.org.sponsors.tooBig"));
    const over = pick(cap + 1);
    expect((propsOf(m.form()).value as { file: File | null }).file, "one byte more is not taken").not.toBe(over);
    expect(m.text(), "it says the size limit").toContain(msg("settings.org.sponsors.tooBig"));
  });

  it("the hint is in the page's language, with the list written the way that language writes it (en / es / fr / nl)", () => {
    const WANT: Record<string, { dict: Dict; locale: "en" | "es" | "fr" | "nl"; list: string; sentence: string }> = {
      en: { dict: uiEn as unknown as Dict, locale: "en", list: "PNG, JPG or WebP", sentence: LOGO_HINT_EN },
      es: { dict: uiEs as unknown as Dict, locale: "es", list: "PNG, JPG o WebP", sentence: "PNG, JPG o WebP, hasta 2 MB. Un logotipo cuadrado con fondo transparente funciona mejor." },
      fr: { dict: uiFr as unknown as Dict, locale: "fr", list: "PNG, JPG ou WebP", sentence: "PNG, JPG ou WebP, jusqu'à 2 Mo. Un logo carré sur fond transparent donne le meilleur résultat." },
      nl: { dict: uiNl as unknown as Dict, locale: "nl", list: "PNG, JPG of WebP", sentence: "PNG, JPG of WebP, tot 2 MB. Een vierkant logo met een transparante achtergrond werkt het best." },
    };
    let checked = 0;
    for (const [locale, w] of Object.entries(WANT)) {
      const html = renderToStaticMarkup(
        <DictProvider dict={w.dict} locale={w.locale}>
          <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}} />
        </DictProvider>,
      );
      expect(flat(stripTags(html)), locale).toContain(w.sentence);
      expect(flat(stripTags(html)), `${locale}: the list`).toContain(w.list);
      checked++;
    }
    expect(checked, "four locales").toBe(4);
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
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    // A string body is JSON; the storage PUT's body is the File itself (never parsed).
    calls.push({ url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
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
  orgTimezone: null,
  deals: [],
  packages: [],
  tiersOrgWide: true,
  tiersCompetitionIds: [],
  hasMonetize: true,
  monetizeOrgWide: true,
  monetizeCompetitionIds: [],
  finishedCompetitionIds: [],
  chargesEnabled: true,
  sponsorId: null,
  editSponsor: false,
  dealId: null,
  dealCreatedByName: null,
  dealCompetitionFinished: false,
  reportLinks: [],
  reportDefaults: null,
};

function mount(rows: SponsorItem[], opts: { canEdit?: boolean; sponsorId?: string; hasTiers?: boolean } = {}) {
  const props: Parameters<typeof OrgSponsors>[0] = {
    orgId: ORG,
    initialSponsors: rows,
    competitions: COMPETITIONS,
    hasTiers: opts.hasTiers ?? true,
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
    const el = island.tree().find((e) => e.type === SponsorForm && propsOf(e).onCancel !== undefined);
    if (!el) throw new Error("no edit form is open");
    return el;
  };
  return {
    island,
    // The list's pencil is a LINK to `?sponsor=<id>&edit=1`: following it is a prop change on the same mounted island (the page re-reads
    // the URL), so the editor is opened the way a browser opens it - by the URL's answer - not by clicking a handler that is not there.
    edit: (name: string) => {
      const s = rows.find((r) => r.name === name);
      if (!s) throw new Error(`no row named "${name}"`);
      island.rerender({ ...props, hub: { ...props.hub, sponsorId: s.id, editSponsor: true } });
    },
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

describe("Edit opens a form that is a name, a link and a logo, whatever the plan or the sponsor's deals (the join between the list and the form)", () => {
  const LIVE = dealOf("dl", "paid");
  const OPEN = dealOf("do", "pending", { deal_status: "awaiting_payment" });
  const ENDED = dealOf("de", "paid", { deal_status: "ended", ended_at: "2026-09-01T10:00:00.000Z", ended_reason: "expired" });
  const ROWS: [string, Partial<SponsorItem>][] = [
    ["a live deal", { deal: LIVE, locked_by_deal: true }],
    ["an open deal", { deal: OPEN, has_open_deal: true, status: "inactive" }],
    ["every deal ended", { deal: ENDED, status: "inactive" }],
    ["no deal", {}],
  ];

  it("the open editor draws no select and no placement words: both plans x four deal states (8 checked)", () => {
    let checked = 0;
    for (const hasTiers of [true, false]) {
      for (const [label, over] of ROWS) {
        const m = mount([row({ id: "a", name: "Quay Chandlers", tier: "gold", competition_id: "c1", ...over })], { hasTiers });
        m.edit("Quay Chandlers");
        const html = renderToStaticMarkup(m.form());
        expect(html, `${label}, tiers=${hasTiers}: a select`).not.toContain("<select");
        for (const w of PLACEMENT_WORDS()) expect(flat(html), `${label}, tiers=${hasTiers}: says "${w}"`).not.toContain(w);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("the draft it is handed holds exactly a name, a link and a logo - the stored tier and scope are not in it", () => {
    const m = mount([row({ id: "a", name: "Quay Chandlers", tier: "gold", competition_id: "c1", url: "https://quay.example" })]);
    m.edit("Quay Chandlers");
    const value = propsOf(m.form()).value as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["file", "name", "preview", "url"]);
    expect(value.name).toBe("Quay Chandlers");
    expect(value.url).toBe("https://quay.example");
  });

  it("the ADD form is the same form (a new sponsor has no deal): no placement either, and no Cancel", () => {
    const m = mount([]);
    const add = m.island.tree().find((e) => e.type === SponsorForm);
    expect(add, "premise: the add form is on the page").toBeDefined();
    expect(propsOf(add!).onCancel, "the add form has no Cancel").toBeUndefined();
    expect(renderToStaticMarkup(add!)).not.toContain("<select");
  });

  it("saving a sponsor that holds a stored tier and scope PATCHes the changed name and link ALONE - neither rides along", async () => {
    answer = (url, method) => (method === "GET" ? { status: 200, body: { data: [] } } : { status: 200, body: { data: {} } });
    const m = mount([row({ id: "b", name: "Old name", tier: "silver", competition_id: "c1" })]);
    m.edit("Old name");
    (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => typeof DRAFT) => void)((p) => ({ ...p, name: "New name", url: "new.example.com" }));
    (propsOf(m.form()).onSubmit as () => void)();
    await flush();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors/b`]);
    expect(patches[0]!.body).toEqual({ name: "New name", url: "https://new.example.com" });
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

describe("a refused logo upload reads the dictionary's words, never the server's (fix round 1, m6; and which words, Task 18)", () => {
  // The STATUS says which words are true: a type the route will not take is a different fix from "not allowed to upload", and a file
  // over the cap is the size limit. Expected words come from the dictionary keys, never from the component's own table.
  const UPLOAD_ERRORS: { label: string; status: number; body: unknown; serverText: string; key: MessageKey }[] = [
    { label: "415 a sentence", status: 415, body: { ok: false, error: "Unsupported image type" }, serverText: "Unsupported image type", key: "settings.org.sponsors.uploadTypeNotAllowed" },
    { label: "400 a structured validation error", status: 400, body: { ok: false, error: { code: "VALIDATION", message: "Invalid input: content_type" } }, serverText: "Invalid input: content_type", key: "settings.org.sponsors.uploadTypeNotAllowed" },
    { label: "422 validation", status: 422, body: { ok: false, error: { code: "VALIDATION", message: "Invalid enum value" } }, serverText: "Invalid enum value", key: "settings.org.sponsors.uploadTypeNotAllowed" },
    { label: "413 over the size cap", status: 413, body: { ok: false, error: "Payload Too Large" }, serverText: "Payload Too Large", key: "settings.org.sponsors.tooBig" },
    { label: "403 not allowed to upload", status: 403, body: { ok: false, error: "Forbidden" }, serverText: "Forbidden", key: "settings.org.sponsors.uploadNotAllowed" },
    { label: "401 signed out", status: 401, body: { ok: false, error: { code: "UNAUTHENTICATED", message: "Sign in" } }, serverText: "Sign in", key: "settings.org.sponsors.uploadNotAllowed" },
  ];
  const ALL_UPLOAD_KEYS: MessageKey[] = ["settings.org.sponsors.uploadTypeNotAllowed", "settings.org.sponsors.tooBig", "settings.org.sponsors.uploadNotAllowed", "settings.org.logo.uploadFailed"];

  async function submitWithLogo(): Promise<ReturnType<typeof mount>> {
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    const file = new File(["x"], "logo.png", { type: "image/png" });
    (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => unknown) => void)((p) => ({ ...p, file }));
    (propsOf(m.form()).onSubmit as () => void)();
    await flush();
    return m;
  }

  it("the upload route's refusal shows the words its STATUS earns - a sentence or a structured error is never shown - and saves nothing (counted)", async () => {
    let checked = 0;
    for (const c of UPLOAD_ERRORS) {
      calls.length = 0;
      answer = (url, method) =>
        url.includes("/content-upload") && method === "POST" ? { status: c.status, body: c.body } : { status: 200, body: { data: [] } };
      const m = await submitWithLogo();
      expect(calls.some((x) => x.url.includes("/content-upload")), `${c.label}: the upload was attempted`).toBe(true);
      expect(m.text(), c.label).toContain(msg(c.key));
      // The pair: none of the OTHER refusals' words is on the screen (a mapping that always said one thing would pass the line above).
      // The dictionary strings overlap by prefix ("Upload not allowed" / "That image type isn't allowed"), so compare whole messages.
      for (const other of ALL_UPLOAD_KEYS.filter((k) => k !== c.key)) {
        if (msg(c.key).includes(msg(other))) continue;
        expect(m.text(), `${c.label}: not ${other}`).not.toContain(msg(other));
      }
      expect(m.text(), c.label).not.toContain(c.serverText);
      expect(m.text(), c.label).not.toContain("[object Object]");
      expect(calls.filter((x) => x.method === "PATCH"), `${c.label}: nothing was saved`).toEqual([]);
      checked++;
    }
    expect(checked, "every refusal was driven").toBe(UPLOAD_ERRORS.length);
    expect(new Set(UPLOAD_ERRORS.map((c) => c.key)).size, "premise: the table reaches three different messages").toBe(3);
  });

  it("the storage PUT is refused: over the cap reads the size limit, anything else reads 'Upload failed' (and the PATCH is never sent)", async () => {
    let checked = 0;
    for (const [status, key] of [[413, "settings.org.sponsors.tooBig"], [500, "settings.org.logo.uploadFailed"], [403, "settings.org.logo.uploadFailed"]] as const) {
      calls.length = 0;
      answer = (url, method) => {
        if (url.includes("/content-upload") && method === "POST") return { status: 200, body: { data: { upload_url: "https://storage.example/put", public_url: "https://cdn.example/logo.png" } } };
        if (url === "https://storage.example/put") return { status, body: {} };
        return { status: 200, body: { data: [] } };
      };
      const m = await submitWithLogo();
      expect(calls.some((x) => x.url === "https://storage.example/put" && x.method === "PUT"), `${status}: the PUT was attempted`).toBe(true);
      expect(m.text(), `PUT ${status}`).toContain(msg(key));
      expect(calls.filter((x) => x.method === "PATCH"), `PUT ${status}: nothing was saved`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the empty case of the grant: a 200 with no upload url is the generic refusal, not a type or size message", async () => {
    answer = (url, method) =>
      url.includes("/content-upload") && method === "POST" ? { status: 200, body: { data: {} } } : { status: 200, body: { data: [] } };
    const m = await submitWithLogo();
    expect(m.text()).toContain(msg("settings.org.sponsors.uploadNotAllowed"));
    expect(m.text()).not.toContain(msg("settings.org.sponsors.uploadTypeNotAllowed"));
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
