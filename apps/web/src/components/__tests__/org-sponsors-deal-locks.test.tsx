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
//   K6  numbered     drop the `invoice_number` arm of `deleteIsRefusedForHistory`          -> "a sponsor whose shown deal is NUMBERED"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
// The island reads a router (to clear the pencil's ?edit=1 once its editor is done); nothing in this file navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import {
  OrgSponsors, PosterField, SPONSOR_TIERS, SponsorForm, posterDraftOf, sponsorEditPatch, type PosterDraft, type SponsorItem, type SponsorsHubData,
} from "@/components/org-sponsors";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSponsorTree } from "@/components/sponsors/__tests__/_sponsor-tree";
import { findAll } from "@/components/sponsors/__tests__/_markup";
import type { PaymentStatus, SponsorDeal } from "@/lib/sponsor-deals";
import { POSTER_HEIGHT, POSTER_WIDTH } from "@/lib/sponsor-poster";
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
  poster_path: null,
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
const classTokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

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
        // The Poster field (a plan with tiers only) says where a poster shows - "while this sponsor is a Title sponsor" - so it names the Title
        // tier. That is a sentence about the poster, not a control that places the sponsor, so the field is taken out of the word sweep and
        // the sweep reads everything else; the field itself is counted (it is there on a plan with tiers and only there).
        const field = findAll(html, "sponsor-poster-field");
        expect(field, `${label}, tiers=${hasTiers}: the poster field is on a plan with tiers only`).toHaveLength(hasTiers ? 1 : 0);
        const rest = field.length > 0 ? html.replace(field[0]!.outer, "") : html;
        expect(rest.length, `${label}, tiers=${hasTiers}: the sweep still reads the rest of the editor`).toBeGreaterThan(500);
        for (const w of PLACEMENT_WORDS()) expect(flat(rest), `${label}, tiers=${hasTiers}: says "${w}"`).not.toContain(w);
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

  it("a sponsor whose shown deal is NUMBERED but unpaid (an invoice: sponsor invoices F10) is not asked to confirm either; the 409 reads the dictionary's words, and its unnumbered twin still asks (both checked)", async () => {
    // The server's rule (server/usecases/sponsors.ts `dealHoldsHistory`, Task 20): a numbered deal is history, paid or not, so the
    // delete is a 409 `sponsor_has_deal_history`. An online and an offline deal, each numbered and awaiting payment - no money.
    const SERVER = "this sponsor has deal history (money paid or refunded, a numbered invoice, or a pre-deals order) — end its deals instead";
    const NUMBERED: [string, SponsorDeal][] = [
      ["offline", dealOf("d1", "pending", { deal_status: "awaiting_payment", payment_method: "offline", invoice_number: 3 })],
      ["online", dealOf("d1", "pending", { deal_status: "awaiting_payment", payment_method: "online", invoice_number: 1 })],
    ];
    let checked = 0;
    for (const [label, deal] of NUMBERED) {
      confirmMock.mockClear();
      calls.length = 0;
      answer = (_url, method) =>
        method === "DELETE"
          ? { status: 409, body: { ok: false, error: { code: "sponsor_has_deal_history", message: SERVER } } }
          : { status: 200, body: { data: [] } };
      const m = mount([row({ id: "a", name: LONG_NAME, deal })]);
      m.remove(LONG_NAME);
      await flush();
      expect(confirmMock, `${label}: no confirm for a delete that cannot happen`).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.method === "DELETE"), `${label}: the delete is still sent - the server owns the rule`).toHaveLength(1);
      expect(m.text(), label).toContain(msg("sponsors.error.hasDealHistory"));
      expect(m.text(), label).not.toContain(SERVER);
      expect(m.hasRow(LONG_NAME), `${label}: the row stays`).toBe(true);
      checked++;
    }
    expect(checked).toBe(NUMBERED.length);
    // The twin: the same unpaid deal with no number (complimentary, or made before invoices were numbered) still asks first.
    confirmMock.mockClear();
    answer = () => ({ status: 200, body: { data: null } });
    mount([row({ id: "b", name: "Ridge Cycles", deal: dealOf("d2", "pending", { deal_status: "awaiting_payment", payment_method: "offline", invoice_number: null }) })])
      .remove("Ridge Cycles");
    await flush();
    expect(confirmMock, "an unnumbered unpaid deal asks").toHaveBeenCalledTimes(1);
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

  it("the history refusal is true for a NUMBERED unpaid deal in every locale: it names invoices, and claims no payment history (4 checked)", () => {
    // A numbered deal that took no money is refused as history (Task 20, F10), so "payment history" alone would be false for it. Each
    // locale's own word for an invoice, as its `sponsors.deal.action.sendInvoice` button uses it.
    const CASES: [string, Dict, RegExp, RegExp][] = [
      ["en", uiEn as unknown as Dict, /\binvoices?\b/i, /payment history/i],
      ["es", uiEs as unknown as Dict, /\bfacturas?\b/i, /historial de pagos/i],
      ["fr", uiFr as unknown as Dict, /\bfactures?\b/i, /historique de paiements/i],
      ["nl", uiNl as unknown as Dict, /\bfacturen\b|\bfactuur\b/i, /betaalgeschiedenis/i],
    ];
    let checked = 0;
    for (const [locale, dict, invoiceWord, paymentHistory] of CASES) {
      const text = t(dict, "sponsors.error.hasDealHistory");
      expect(text, `${locale}: the key resolves`).not.toBe("sponsors.error.hasDealHistory");
      expect(text, `${locale}: names invoices`).toMatch(invoiceWord);
      expect(text, `${locale}: no "payment history" claim`).not.toMatch(paymentHistory);
      checked++;
    }
    expect(checked).toBe(4);
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

// --- the poster field (Title-sponsor hero poster, batch C Task 6; spec docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §8) ---
// An OPTIONAL fourth field on the sponsor page's editor (never the Add form): a 4:5 tile that is the live crop, the hint beside it, Remove,
// and a crop warning when the picture would lose more than a quarter. Its state is its OWN (`PosterDraft`), not a key on the logo's draft:
// the draft test above still pins that one to a name, a link and a logo. The cap and the formats are the LOGO picker's constants (the poster
// is exactly as strong as the logo, no stronger: spec §4 premise 4), so the hint is tied to behaviour the same way the logo's is - parse
// "up to N MB" out of the rendered hint, then drive the real picker at N and at N + 1 bytes.
//
// Expected copy is the owner-approved sentences (spec §10) typed here, filled with the declared constants (`POSTER_WIDTH`, `POSTER_HEIGHT`);
// the crop figures are the spec §11 worked table, never `posterCrop`'s output read back into the page.
//
// Killers (one at a time, restore from a cp backup):
//   P1  patch    `sponsorEditPatch` sends `poster_path: null` on `removed` even when nothing is stored     -> "removed + none stored"
//   P2  gate     pass `poster` to the editor whatever `hasTiers` says                                         -> "DENIED and GRANTED"
//   P3  size     drop the `file.size > MAX_LOGO_BYTES` check in `pickPoster`                                  -> "one more is refused"
//   P4  stale    drop the pick-sequence check after the measuring `await`                                     -> "a slow pick that lands after"
//   P4b owner    drop the effect that follows the sponsor the editor is open for                              -> "a slow pick that lands after"
//   P4d owner    drop the owner comparison after the measuring `await`                                        -> "a slow pick that lands after"
//   P5  crop     draw the crop warning whatever `crop.warn` says                                              -> "crop: warn true shows"
//   P6  reset    `startEdit` keeps the poster draft of the last editor                                        -> "an abandoned pick is not carried"
//   I1  region   drop `role="status"` / `empty:hidden`, wrap the region in the warning, key it on the warning, or give Remove a bare class
//                                                                                                            -> "the warning's live region is one element"
//   M3  413      a poster's 413 (grant or PUT) says the logo's sentence, or a logo's says the poster's        -> "over the storage's cap"
const POSTER_NONE: PosterDraft = { file: null, preview: null, removed: false, crop: null };
const POSTER_STORED = "https://cdn.example/posters/old.png";
const POSTER_NEW = "https://cdn.example/posters/new.png";
const posterProp = (value: PosterDraft = POSTER_NONE, over: Record<string, unknown> = {}) => ({ value, onPick: () => {}, onRemove: () => {}, ...over });
const posterTiles = (html: string) => [...html.matchAll(/<button\b[^>]*data-testid="sponsor-poster-tile"[^>]*>([\s\S]*?)<\/button>/g)];
const posterHints = (html: string) => [...html.matchAll(/<p\b[^>]*data-testid="sponsor-poster-hint"[^>]*>([\s\S]*?)<\/p>/g)];
const posterCrops = (html: string) => [...html.matchAll(/<p\b[^>]*data-testid="sponsor-poster-crop"[^>]*>([\s\S]*?)<\/p>/g)];
const posterRemoves = (html: string) => [...html.matchAll(/<button\b[^>]*data-testid="sponsor-poster-remove"[^>]*>([\s\S]*?)<\/button>/g)];
const POSTER_HINT_EN = `Shows beside the competition name while this sponsor is a Title sponsor. PNG, JPG or WebP, up to 2 MB. Best at ${POSTER_WIDTH} × ${POSTER_HEIGHT} (4:5, Instagram portrait).`;
const CONTENT_UPLOAD_OK = { status: 200, body: { data: { upload_url: "https://storage.example/put", public_url: POSTER_NEW } } };
const closeMock = vi.fn();
type Bitmap = { width: number; height: number; close: () => void };
/** `createImageBitmap` of a picture `w` x `h`: what the browser answers for a measured file. */
const bitmapOf = (w: number, h: number) => async (): Promise<Bitmap> => ({ width: w, height: h, close: closeMock });
const pngFile = (size = 1, name = "poster.png") => new File([new Uint8Array(size)], name, { type: "image/png" });
type PosterWire = { value: PosterDraft; onPick: (f: File) => void | Promise<void>; onRemove: () => void };
const posterOf = (m: ReturnType<typeof mount>) => propsOf(m.form()).poster as PosterWire | undefined;

afterEach(() => {
  vi.stubGlobal("createImageBitmap", undefined);
  closeMock.mockReset();
});

describe("the poster field: its presence (the Add form never has it; a plan without tiers has none)", () => {
  it("the Add form never has a poster field; the sponsor page's editor has exactly one tile, described by one hint (empty case first)", () => {
    // The empty case first: no `poster` prop (the Add form, and the editor of a plan without tiers) draws nothing of it.
    const bare = formMarkup();
    for (const id of ["sponsor-poster-tile", "sponsor-poster-hint", "sponsor-poster-remove", "sponsor-poster-crop", "sponsor-poster-input"]) {
      expect(bare, `no poster prop: no ${id}`).not.toContain(`data-testid="${id}"`);
    }
    expect(flat(stripTags(bare)), "and no label for it").not.toContain(msg("sponsors.poster.label"));
    // The real Add form on a page whose plan has tiers: still no poster prop - a poster belongs to a sponsor that exists.
    const addPage = mount([], { hasTiers: true });
    const add = addPage.island.tree().find((e) => e.type === SponsorForm);
    expect(add, "premise: the add form is on the page").toBeDefined();
    expect(propsOf(add!).poster, "the Add form has no poster").toBeUndefined();
    expect(posterTiles(renderToStaticMarkup(add!)), "and draws no tile").toHaveLength(0);

    // The editor: exactly one tile, exactly one hint, the tile described by the hint.
    let checked = 0;
    for (const html of [formMarkup({ poster: posterProp() }), formMarkup({ poster: posterProp(), compact: true })]) {
      const tiles = posterTiles(html);
      const hints = posterHints(html);
      expect(tiles, "exactly one tile").toHaveLength(1);
      expect(hints, "exactly one hint").toHaveLength(1);
      const tag = /<button\b[^>]*data-testid="sponsor-poster-tile"[^>]*>/.exec(html)![0];
      expect(attr(tag, "aria-label"), "the tile keeps its accessible name").toBe(msg("sponsors.sheet.poster"));
      expect(msg("sponsors.sheet.poster"), "premise: that name is the word Poster").toBe("Poster");
      expect(stripTags(tiles[0]![1]!), "no visible word inside the dashed box").toBe("");
      const hintId = attr(/<p\b[^>]*data-testid="sponsor-poster-hint"[^>]*>/.exec(html)![0], "id");
      expect(hintId, "the hint has an id").toBeTruthy();
      expect(attr(tag, "aria-describedby"), "the tile is described by its hint").toBe(hintId);
      // The logo tile is still the logo's: its own hint, its own id.
      const logoTag = /<button\b[^>]*\baria-label="Logo"[^>]*>/.exec(html)![0];
      expect(attr(logoTag, "aria-describedby"), "the logo tile keeps ITS hint").not.toBe(hintId);
      expect(flat(stripTags(html)), "the visible label").toContain(msg("sponsors.poster.label"));
      checked++;
    }
    expect(checked, "form and compact form").toBe(2);
    // Two editors on one page must not share a hint id.
    const two = renderToStaticMarkup(
      <>
        <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}} poster={posterProp()} />
        <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}} poster={posterProp()} />
      </>,
    );
    const ids = posterHints(two).map((h) => attr(/<p\b[^>]*data-testid="sponsor-poster-hint"[^>]*>/.exec(h[0])![0], "id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, "each poster hint has its own id").toBe(2);
  });

  it("DENIED and GRANTED: the editor is handed a poster only when the plan can place a Title sponsor (hasTiers), whatever is stored", () => {
    let checked = 0;
    for (const [hasTiers, stored] of [[true, POSTER_STORED], [true, null], [false, POSTER_STORED], [false, null]] as const) {
      const m = mount([row({ id: "a", name: "Quay Chandlers", poster_path: stored })], { hasTiers });
      m.edit("Quay Chandlers");
      const poster = posterOf(m);
      const html = renderToStaticMarkup(m.form());
      if (hasTiers) {
        expect(poster, `tiers, stored=${stored}: GRANTED`).toBeDefined();
        expect(poster!.value, `tiers, stored=${stored}: it opens at what is stored`).toEqual({ file: null, preview: stored, removed: false, crop: null });
        expect(posterTiles(html), `tiers, stored=${stored}: one tile`).toHaveLength(1);
      } else {
        expect(poster, `no tiers, stored=${stored}: DENIED`).toBeUndefined();
        expect(posterTiles(html), `no tiers, stored=${stored}: no tile`).toHaveLength(0);
        expect(html, `no tiers, stored=${stored}: a stored poster is not drawn in the editor`).not.toContain(POSTER_STORED);
      }
      checked++;
    }
    expect(checked, "both plans x stored and not stored").toBe(4);
  });
});

describe("the poster hint: it says what the picker takes, in the owner's words, tied to behaviour", () => {
  it("the hint names every format the poster's file input accepts, the cap and the recommended size - and the input accepts what the logo's does", () => {
    const html = formMarkup({ poster: posterProp() });
    const inputs = [...html.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
    expect(inputs, "the logo's input and the poster's").toHaveLength(2);
    const posterInput = inputs.find((tag) => /data-testid="sponsor-poster-input"/.test(tag))!;
    const logoInput = inputs.find((tag) => !/data-testid="sponsor-poster-input"/.test(tag))!;
    const accepted = (attr(posterInput, "accept") ?? "").split(",");
    expect(accepted, "the poster picker takes PNG, JPG and WebP").toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(attr(logoInput, "accept"), "exactly what the logo picker takes: one list").toBe(attr(posterInput, "accept"));
    const names = accepted.map((type) => LOGO_TYPE_NAME[type]);
    expect(names.every((n) => typeof n === "string"), "premise: every accepted type has a name here").toBe(true);
    const list = new Intl.ListFormat("en-GB", { style: "long", type: "disjunction" }).format(names as string[]);
    const hint = stripTags(posterHints(html)[0]![1]!);
    expect(hint, "the owner-approved sentence, word for word").toBe(POSTER_HINT_EN);
    expect(hint, "the list is the input's own").toContain(`${list}, up to`);
    expect(hint, "it names the recommended size from the declared constants").toContain(`${POSTER_WIDTH} × ${POSTER_HEIGHT} (4:5`);
    expect(hint, "and where it shows").toContain("Shows beside the competition name");
  });
});

describe("the poster tile: the live 4:5 crop, Remove, and the crop warning", () => {
  it("a stored poster previews object-cover in the 4:5 tile with Remove; none: the icon and no Remove; a picked one previews the same way", () => {
    const stored = formMarkup({ poster: posterProp({ ...POSTER_NONE, preview: POSTER_STORED }) });
    const tile = posterTiles(stored)[0]!;
    const img = /<img\b[^>]*>/.exec(tile[1]!)![0];
    expect(attr(img, "src"), "the stored poster").toBe(POSTER_STORED);
    expect((attr(img, "class") ?? "").split(/\s+/), "it fills the tile, cropped as the public panel crops it").toContain("object-cover");
    expect((attr(img, "class") ?? "").split(/\s+/), "and is not letterboxed like the logo").not.toContain("object-contain");
    const tag = /<button\b[^>]*data-testid="sponsor-poster-tile"[^>]*>/.exec(stored)![0];
    expect((attr(tag, "class") ?? "").split(/\s+/), "the tile is 4:5").toContain("aspect-[4/5]");
    expect(posterRemoves(stored), "a stored poster offers Remove").toHaveLength(1);
    expect(stripTags(posterRemoves(stored)[0]![1]!)).toBe(msg("sponsors.poster.remove"));

    const none = formMarkup({ poster: posterProp() });
    expect(posterTiles(none)[0]![1], "none: the icon").toContain("<svg");
    expect(posterTiles(none)[0]![1], "none: no picture").not.toContain("<img");
    expect(posterRemoves(none), "none: nothing to remove").toHaveLength(0);

    const picked = formMarkup({ poster: posterProp({ ...POSTER_NONE, file: pngFile(), preview: "blob:picked" }) });
    expect(attr(/<img\b[^>]*>/.exec(posterTiles(picked)[0]![1]!)![0], "src"), "a picked file previews").toBe("blob:picked");
    expect(posterRemoves(picked), "a picked poster offers Remove").toHaveLength(1);
  });

  it("Remove calls onRemove, and the tile's file input hands the picked file to onPick and clears itself so the same file can be picked again", () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    const island = renderIsland(PosterField, { value: { ...POSTER_NONE, preview: POSTER_STORED }, onPick, onRemove });
    const remove = island.tree().find((e) => propsOf(e)["data-testid"] === "sponsor-poster-remove")!;
    (propsOf(remove).onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
    const input = island.tree().find((e) => propsOf(e)["data-testid"] === "sponsor-poster-input")!;
    expect(propsOf(input).type).toBe("file");
    const file = pngFile();
    const target = { files: [file], value: "C:\\fakepath\\poster.png" };
    (propsOf(input).onChange as (e: unknown) => void)({ target });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(file);
    expect(target.value, "cleared").toBe("");
    // The empty case: a cancelled dialog hands over no file, and picks nothing.
    (propsOf(input).onChange as (e: unknown) => void)({ target: { files: [], value: "" } });
    expect(onPick, "no file, no pick").toHaveBeenCalledTimes(1);
  });

  it("crop: warn true shows the width or the height sentence with its percent and the recommended size; warn false shows nothing (5 checked)", () => {
    // Figures are the spec §11 worked table: 1920 x 1080 cuts 55% of the width (warn), 1080 x 1920 cuts 30% of the height (warn),
    // 1080 x 1080 cuts 20% (no warning), 1080 x 1350 cuts nothing, and an unmeasured picture has no crop at all.
    const CASES: [string, PosterDraft["crop"], string | null][] = [
      ["wider, 55% (warn)", { side: "width", percent: 55, warn: true }, `This picture is wider than 4:5, so 55% of its width will be cut off. ${POSTER_WIDTH} × ${POSTER_HEIGHT} fits exactly.`],
      ["taller, 30% (warn)", { side: "height", percent: 30, warn: true }, `This picture is taller than 4:5, so 30% of its height will be cut off. ${POSTER_WIDTH} × ${POSTER_HEIGHT} fits exactly.`],
      ["square, 20% (no warn)", { side: "width", percent: 20, warn: false }, null],
      ["exactly 4:5", { side: null, percent: 0, warn: false }, null],
      ["not measured", null, null],
    ];
    let checked = 0;
    let warned = 0;
    for (const [label, crop, sentence] of CASES) {
      const html = formMarkup({ poster: posterProp({ ...POSTER_NONE, file: pngFile(), preview: "blob:picked", crop }) });
      const found = posterCrops(html);
      if (sentence === null) {
        expect(found, `${label}: no warning`).toHaveLength(0);
      } else {
        expect(found, `${label}: one warning`).toHaveLength(1);
        expect(flat(stripTags(found[0]![1]!)), label).toBe(sentence);
        warned++;
      }
      checked++;
    }
    expect(checked).toBe(5);
    expect(warned, "both sentences were exercised").toBe(2);
  });

  it("the warning's live region is one element in one place whether or not it has a warning, hides itself when empty; Remove is a phone-sized tap target (fix round 1, I1)", () => {
    // A screen reader announces a warning that ARRIVES in a live region that was already there: a wrapper that appears together with the
    // warning (or is re-keyed when it changes) is not announced. Static markup cannot tell "same element" from "a new one", so the island's
    // own tree is read: the region sits in the same slot of the same parent, unkeyed, with and without a warning.
    const WARN: PosterDraft["crop"] = { side: "width", percent: 55, warn: true };
    const regionOf = (crop: PosterDraft["crop"]) => {
      const island = renderIsland(PosterField, { value: { ...POSTER_NONE, file: pngFile(), preview: "blob:picked", crop }, onPick: () => {}, onRemove: () => {} });
      const tree = island.tree();
      const regions = tree.filter((e) => propsOf(e).role === "status");
      expect(regions, `crop ${JSON.stringify(crop)}: exactly one role="status" region`).toHaveLength(1);
      const region = regions[0]!;
      const parent = tree.find((e) => [propsOf(e).children].flat().includes(region))!;
      const slot = [propsOf(parent).children].flat().indexOf(region);
      return { region, slot, parentTestId: propsOf(parent)["data-testid"] ?? null, hasWarning: tree.some((e) => propsOf(e)["data-testid"] === "sponsor-poster-crop") };
    };
    const without = regionOf(null);
    const withWarning = regionOf(WARN);
    expect(without.hasWarning, "premise: the first draw has no warning").toBe(false);
    expect(withWarning.hasWarning, "premise: the second draw has one").toBe(true);
    expect(withWarning.slot, "the region is in the same slot of its parent with and without the warning").toBe(without.slot);
    expect(withWarning.region.type, "and is the same kind of element").toBe(without.region.type);
    expect(withWarning.region.key, "never keyed on the warning (a changed key remounts it)").toBeNull();
    expect(without.region.key).toBeNull();
    for (const { region } of [without, withWarning]) {
      expect(classTokens(propsOf(region).className as string), "empty, it draws nothing and takes no gap").toContain("empty:hidden");
    }
    // Remove: the shared small button, which grows to a thumb-sized tap target on a phone (the sponsor sheet's own SMALL_BTN).
    const island = renderIsland(PosterField, { value: { ...POSTER_NONE, preview: POSTER_STORED }, onPick: () => {}, onRemove: () => {} });
    const remove = island.tree().find((e) => propsOf(e)["data-testid"] === "sponsor-poster-remove")!;
    expect(classTokens(propsOf(remove).className as string), "Remove is at least 44px tall below md").toContain("max-md:min-h-11");
  });
});

describe("the poster field is in the page's language (en / es / fr / nl)", () => {
  // The owner-approved sentences, spec §10, typed here; the format list is written the way each language writes a list.
  const WANT = {
    en: {
      dict: uiEn, label: "Poster (optional)", remove: "Remove poster", tooBig: "Posters can be up to 2 MB.",
      hint: POSTER_HINT_EN,
      cropWidth: `This picture is wider than 4:5, so 55% of its width will be cut off. ${POSTER_WIDTH} × ${POSTER_HEIGHT} fits exactly.`,
      cropHeight: `This picture is taller than 4:5, so 30% of its height will be cut off. ${POSTER_WIDTH} × ${POSTER_HEIGHT} fits exactly.`,
    },
    es: {
      dict: uiEs, label: "Cartel (opcional)", remove: "Quitar cartel", tooBig: "Los carteles pueden pesar hasta 2 MB.",
      hint: `Se muestra junto al nombre de la competición mientras este patrocinador sea Principal. PNG, JPG o WebP, hasta 2 MB. Ideal a ${POSTER_WIDTH} × ${POSTER_HEIGHT} (4:5, retrato de Instagram).`,
      cropWidth: `Esta imagen es más ancha que 4:5, así que se recortará el 55% de su ancho. ${POSTER_WIDTH} × ${POSTER_HEIGHT} encaja exactamente.`,
      cropHeight: `Esta imagen es más alta que 4:5, así que se recortará el 30% de su alto. ${POSTER_WIDTH} × ${POSTER_HEIGHT} encaja exactamente.`,
    },
    fr: {
      dict: uiFr, label: "Affiche (facultatif)", remove: "Retirer l'affiche", tooBig: "Les affiches peuvent atteindre 2 Mo.",
      hint: `S'affiche à côté du nom de la compétition tant que ce sponsor est Titre. PNG, JPG ou WebP, jusqu'à 2 Mo. Idéal en ${POSTER_WIDTH} × ${POSTER_HEIGHT} (4:5, portrait Instagram).`,
      cropWidth: `Cette image est plus large que 4:5 : 55 % de sa largeur sera coupé. ${POSTER_WIDTH} × ${POSTER_HEIGHT} s'ajuste exactement.`,
      cropHeight: `Cette image est plus haute que 4:5 : 30 % de sa hauteur sera coupé. ${POSTER_WIDTH} × ${POSTER_HEIGHT} s'ajuste exactement.`,
    },
    nl: {
      dict: uiNl, label: "Poster (optioneel)", remove: "Poster verwijderen", tooBig: "Posters mogen maximaal 2 MB zijn.",
      hint: `Staat naast de naam van de competitie zolang deze sponsor Titel is. PNG, JPG of WebP, tot 2 MB. Het best op ${POSTER_WIDTH} × ${POSTER_HEIGHT} (4:5, Instagram staand).`,
      cropWidth: `Deze afbeelding is breder dan 4:5, dus 55% van de breedte valt weg. ${POSTER_WIDTH} × ${POSTER_HEIGHT} past precies.`,
      cropHeight: `Deze afbeelding is hoger dan 4:5, dus 30% van de hoogte valt weg. ${POSTER_WIDTH} × ${POSTER_HEIGHT} past precies.`,
    },
  } as const;

  it("the label, the hint, Remove, the size refusal and both crop sentences read right in each locale (4 x 6 checked)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const w = WANT[locale];
      const dict = w.dict as unknown as Dict;
      const render = (crop: PosterDraft["crop"]) =>
        flat(stripTags(renderToStaticMarkup(
          <DictProvider dict={dict} locale={locale}>
            <SponsorForm value={DRAFT} onChange={() => {}} onSubmit={() => {}} submitLabel="Save" busy={false} onPickLogo={() => {}}
              poster={posterProp({ ...POSTER_NONE, file: pngFile(), preview: "blob:picked", crop })} />
          </DictProvider>,
        )));
      const text = render({ side: "width", percent: 55, warn: true });
      expect(text, `${locale}: label`).toContain(w.label);
      expect(text, `${locale}: hint`).toContain(w.hint);
      expect(text, `${locale}: Remove`).toContain(w.remove);
      expect(text, `${locale}: wider`).toContain(w.cropWidth);
      expect(render({ side: "height", percent: 30, warn: true }), `${locale}: taller`).toContain(w.cropHeight);
      expect(t(dict, "sponsors.poster.tooBig", { mb: 2 }), `${locale}: tooBig`).toBe(w.tooBig);
      checked += 6;
    }
    expect(checked).toBe(24);
  });
});

describe("the poster picker: the size it refuses at is the cap the hint names (the island's own pickPoster)", () => {
  it("that many bytes are taken and measured, one more is refused with the poster size words and leaves the draft untouched", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    const hintMb = Number(/up to (\d+) MB/.exec(flat(stripTags(formMarkup({ poster: posterProp() }))))?.[1]);
    expect(Number.isInteger(hintMb) && hintMb > 0, "premise: the hint carries a whole number of MB").toBe(true);
    const cap = hintMb * 1024 * 1024;
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    const atCap = pngFile(cap);
    await posterOf(m)!.onPick(atCap);
    await flush();
    const taken = posterOf(m)!.value;
    expect(taken.file, "a file of exactly the cap is taken").toBe(atCap);
    expect(taken.preview, "and previewed").toMatch(/^blob:/);
    expect(taken.removed).toBe(false);
    expect(closeMock, "the measuring bitmap is closed").toHaveBeenCalledTimes(1);
    expect(m.text(), "no size complaint at the cap").not.toContain(msg("sponsors.poster.tooBig", { mb: hintMb }));
    await posterOf(m)!.onPick(pngFile(cap + 1));
    await flush();
    expect(posterOf(m)!.value, "one byte over the cap leaves the draft exactly as it was").toBe(taken);
    expect(m.text(), "one more byte is refused, in the poster's words").toContain(msg("sponsors.poster.tooBig", { mb: hintMb }));
    expect(closeMock, "a refused file is never measured").toHaveBeenCalledTimes(1);
    // The pair: the logo's own sentence is not what a poster says.
    expect(m.text()).not.toContain(msg("settings.org.sponsors.tooBig"));
  });

  it("a picture is measured into a crop (1920 x 1080 cuts 55% of the width: warn); a measuring failure still takes the file, with no crop", async () => {
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    vi.stubGlobal("createImageBitmap", bitmapOf(1920, 1080));
    await posterOf(m)!.onPick(pngFile());
    await flush();
    expect(posterOf(m)!.value.crop, "spec §11: 1920 x 1080 -> width, 55, warn").toEqual({ side: "width", percent: 55, warn: true });
    // Through the real consumer: the editor now draws the warning.
    expect(flat(stripTags(renderToStaticMarkup(m.form())))).toContain("so 55% of its width will be cut off");
    // 1080 x 1350: exactly 4:5, nothing to warn about.
    vi.stubGlobal("createImageBitmap", bitmapOf(POSTER_WIDTH, POSTER_HEIGHT));
    await posterOf(m)!.onPick(pngFile());
    await flush();
    expect(posterOf(m)!.value.crop).toEqual({ side: null, percent: 0, warn: false });
    expect(posterCrops(renderToStaticMarkup(m.form())), "a picture that fits shows no warning").toHaveLength(0);
    // The browser cannot read it (createImageBitmap missing, or it rejects): the file is still taken.
    let checked = 0;
    for (const failing of [undefined, async () => { throw new Error("cannot decode"); }]) {
      vi.stubGlobal("createImageBitmap", failing);
      const f = pngFile();
      await posterOf(m)!.onPick(f);
      await flush();
      expect(posterOf(m)!.value.file, "the file is taken").toBe(f);
      expect(posterOf(m)!.value.crop, "with no crop").toBeNull();
      expect(posterCrops(renderToStaticMarkup(m.form())), "and no warning").toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a slow pick that lands after a newer one, or after Remove, is dropped (the sequence, not the feature)", async () => {
    const m = mount([row({ id: "a", name: "Quay Chandlers", poster_path: POSTER_STORED }), row({ id: "b", name: "Ridge Cycles", poster_path: null })]);
    m.edit("Quay Chandlers");
    // A is slow to measure; B is quick and is picked after it.
    let releaseA!: (b: Bitmap) => void;
    vi.stubGlobal("createImageBitmap", (f: File) => (f.name === "a.png" ? new Promise<Bitmap>((resolve) => { releaseA = resolve; }) : bitmapOf(1080, 1350)()));
    const a = pngFile(1, "a.png");
    const b = pngFile(1, "b.png");
    const pendingA = posterOf(m)!.onPick(a);
    await posterOf(m)!.onPick(b);
    await flush();
    expect(posterOf(m)!.value.file, "B landed").toBe(b);
    releaseA({ width: 1920, height: 1080, close: () => {} });
    await pendingA;
    await flush();
    expect(posterOf(m)!.value.file, "A landed late and was dropped: B is still the pick").toBe(b);
    expect(posterOf(m)!.value.crop, "and B's crop was not overwritten by A's").toEqual({ side: null, percent: 0, warn: false });
    // Remove while a pick is still measuring: the removal stands.
    let releaseC!: (b: Bitmap) => void;
    vi.stubGlobal("createImageBitmap", () => new Promise<Bitmap>((resolve) => { releaseC = resolve; }));
    const pendingC = posterOf(m)!.onPick(pngFile(1, "c.png"));
    posterOf(m)!.onRemove();
    releaseC({ width: 1080, height: 1350, close: () => {} });
    await pendingC;
    await flush();
    expect(posterOf(m)!.value, "the pick that was still measuring does not resurrect after Remove").toEqual({ file: null, preview: null, removed: true, crop: null });
    // The editor moves to another sponsor (a pencil, Back) while a pick is still measuring: it does not land in that sponsor's draft.
    let releaseD!: (b: Bitmap) => void;
    vi.stubGlobal("createImageBitmap", () => new Promise<Bitmap>((resolve) => { releaseD = resolve; }));
    const pendingD = posterOf(m)!.onPick(pngFile(1, "d.png"));
    m.edit("Ridge Cycles");
    releaseD({ width: 1080, height: 1350, close: () => {} });
    await pendingD;
    await flush();
    expect(posterOf(m)!.value, "the next sponsor's draft is its own stored poster, not the pick that was still measuring").toEqual(POSTER_NONE);
  });
});

describe("sponsorEditPatch: what a save sends (pure)", () => {
  const STORED_ROW = { name: "Quay Chandlers", url: "https://quay.example", poster_path: POSTER_STORED };
  const BARE_ROW = { name: "Quay Chandlers", url: "https://quay.example", poster_path: null };
  const SAME = { name: "Quay Chandlers", url: "https://quay.example" };
  const REMOVED: PosterDraft = { file: null, preview: null, removed: true, crop: null };

  it("unchanged, set, replace, removed, removed with nothing stored, name + poster, logo: each sends exactly its keys (8 checked)", () => {
    const ROWS: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["unchanged, none stored", sponsorEditPatch(BARE_ROW, SAME, posterDraftOf(BARE_ROW), {}), {}],
      ["unchanged, one stored: it is not re-sent", sponsorEditPatch(STORED_ROW, SAME, posterDraftOf(STORED_ROW), {}), {}],
      ["uploaded.poster, none stored", sponsorEditPatch(BARE_ROW, SAME, { ...POSTER_NONE, file: pngFile() }, { poster: POSTER_NEW }), { poster_path: POSTER_NEW }],
      ["uploaded.poster replaces a stored one", sponsorEditPatch(STORED_ROW, SAME, { ...POSTER_NONE, file: pngFile() }, { poster: POSTER_NEW }), { poster_path: POSTER_NEW }],
      ["removed + stored: null", sponsorEditPatch(STORED_ROW, SAME, REMOVED, {}), { poster_path: null }],
      ["removed + none stored: nothing to remove, nothing sent", sponsorEditPatch(BARE_ROW, SAME, REMOVED, {}), {}],
      ["name + poster: both keys, and the url untouched", sponsorEditPatch(BARE_ROW, { name: " New name ", url: "https://quay.example" }, { ...POSTER_NONE, file: pngFile() }, { poster: POSTER_NEW }), { name: "New name", poster_path: POSTER_NEW }],
      ["uploaded.logo: logo_path alone", sponsorEditPatch(STORED_ROW, SAME, posterDraftOf(STORED_ROW), { logo: "https://cdn.example/logo.png" }), { logo_path: "https://cdn.example/logo.png" }],
    ];
    let checked = 0;
    for (const [label, got, want] of ROWS) {
      expect(got, label).toEqual(want);
      checked++;
    }
    expect(checked).toBe(8);
    expect(ROWS.filter(([, , want]) => Object.keys(want).length === 0).length, "premise: the empty case is exercised (three rows send nothing)").toBe(3);
    // The url keeps its own rule: a bare domain is given a scheme, a cleared box is null.
    expect(sponsorEditPatch(BARE_ROW, { name: "Quay Chandlers", url: "new.example.com" }, posterDraftOf(BARE_ROW), {})).toEqual({ url: "https://new.example.com" });
    expect(sponsorEditPatch(BARE_ROW, { name: "Quay Chandlers", url: "" }, posterDraftOf(BARE_ROW), {})).toEqual({ url: null });
  });

  it("posterDraftOf: an empty form for no sponsor, the stored poster previewed for one that has it, nothing picked, nothing removed", () => {
    expect(posterDraftOf(undefined)).toEqual(POSTER_NONE);
    expect(posterDraftOf(row({ id: "a", poster_path: POSTER_STORED }))).toEqual({ file: null, preview: POSTER_STORED, removed: false, crop: null });
    expect(posterDraftOf(row({ id: "a", poster_path: null }))).toEqual(POSTER_NONE);
  });
});

describe("the poster field through the island: a save, a removal, a refusal, and what is not carried over", () => {
  const OKAY = (rowOver: Partial<SponsorItem> = {}) => (url: string, method: string) => {
    if (url.includes("/content-upload") && method === "POST") return CONTENT_UPLOAD_OK;
    if (url === "https://storage.example/put") return { status: 200, body: {} };
    if (method === "GET") return { status: 200, body: { data: [row({ id: "a", name: "Quay Chandlers", ...rowOver })] } };
    return { status: 200, body: { data: {} } };
  };
  const save = async (m: ReturnType<typeof mount>) => {
    (propsOf(m.form()).onSubmit as () => void)();
    await flush();
  };

  it("Save sends the poster PATCH alone (upload grant, storage PUT, then PATCH { poster_path }), re-reads the list, and the page shows the new poster", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    answer = OKAY({ poster_path: POSTER_NEW });
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    await posterOf(m)!.onPick(pngFile(10));
    await flush();
    await save(m);
    const grant = calls.find((c) => c.url.includes("/content-upload"))!;
    expect(grant.method).toBe("POST");
    expect(grant.body, "the grant is asked for the file's own type").toEqual({ content_type: "image/png" });
    expect(calls.some((c) => c.url === "https://storage.example/put" && c.method === "PUT"), "the bytes are PUT to storage").toBe(true);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsors/a`]);
    expect(patches[0]!.body, "the poster alone: no name, no link, no logo").toEqual({ poster_path: POSTER_NEW });
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url), "the list is re-read").toEqual([`/api/v1/orgs/${ORG}/sponsors`]);
    expect(m.has("sponsor-sheet-editor"), "saved: the editor closes").toBe(false);
    expect(propsOf(m.find("sponsor-sheet-poster-thumb")).src, "the read-only Details row shows what was saved").toBe(POSTER_NEW);
  });

  it("replacing a stored poster uploads the new one; removing it sends null; removing nothing sends nothing and uploads nothing (the sequence)", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    // replace
    answer = OKAY({ poster_path: POSTER_NEW });
    const replaced = mount([row({ id: "a", name: "Quay Chandlers", poster_path: POSTER_STORED })]);
    replaced.edit("Quay Chandlers");
    await posterOf(replaced)!.onPick(pngFile());
    await flush();
    await save(replaced);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ poster_path: POSTER_NEW }]);
    // remove a stored poster
    calls.length = 0;
    answer = OKAY({ poster_path: null });
    const removed = mount([row({ id: "a", name: "Quay Chandlers", poster_path: POSTER_STORED })]);
    removed.edit("Quay Chandlers");
    posterOf(removed)!.onRemove();
    expect(posterOf(removed)!.value, "Remove empties the tile").toEqual({ file: null, preview: null, removed: true, crop: null });
    await save(removed);
    expect(calls.filter((c) => c.url.includes("/content-upload")), "a removal uploads nothing").toHaveLength(0);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body), "removing a stored poster sends null").toEqual([{ poster_path: null }]);
    // pick, then Remove, with nothing stored: the pick was never saved, so there is nothing to send and nothing to upload
    calls.length = 0;
    answer = OKAY();
    const none = mount([row({ id: "a", name: "Quay Chandlers", poster_path: null })]);
    none.edit("Quay Chandlers");
    await posterOf(none)!.onPick(pngFile());
    await flush();
    posterOf(none)!.onRemove();
    await save(none);
    expect(calls.filter((c) => c.url.includes("/content-upload")), "a poster removed before Save is never uploaded").toHaveLength(0);
    expect(calls.filter((c) => c.method === "PATCH"), "and nothing is PATCHed").toHaveLength(0);
    // a name change on a sponsor with a stored poster does not re-send the poster
    calls.length = 0;
    answer = OKAY();
    const named = mount([row({ id: "a", name: "Old name", poster_path: POSTER_STORED })]);
    named.edit("Old name");
    (propsOf(named.form()).onChange as (fn: (p: typeof DRAFT) => typeof DRAFT) => void)((p) => ({ ...p, name: "New name" }));
    await save(named);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body), "the name alone").toEqual([{ name: "New name" }]);
  });

  it("a new logo and a new poster in one save upload both and PATCH both keys (the two uploads do not share a file)", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    let grants = 0;
    answer = (url, method) => {
      if (url.includes("/content-upload") && method === "POST") {
        grants++;
        return { status: 200, body: { data: { upload_url: `https://storage.example/put-${grants}`, public_url: `https://cdn.example/${grants === 1 ? "logo" : "poster"}.png` } } };
      }
      if (url.startsWith("https://storage.example/put-")) return { status: 200, body: {} };
      return { status: 200, body: { data: [] } };
    };
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    const logo = pngFile(1, "logo.png");
    (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => unknown) => void)((p) => ({ ...p, file: logo }));
    await posterOf(m)!.onPick(pngFile(1, "poster.png"));
    await flush();
    await save(m);
    expect(grants, "two grants: one per file").toBe(2);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ logo_path: "https://cdn.example/logo.png", poster_path: "https://cdn.example/poster.png" }]);
  });

  it("a refused poster upload shows the dictionary's words for its status and saves nothing (415, 403, and a storage PUT that fails)", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    let checked = 0;
    for (const [label, grant, key] of [
      ["415", { status: 415, body: { ok: false, error: "Unsupported image type" } }, "settings.org.sponsors.uploadTypeNotAllowed"],
      ["403", { status: 403, body: { ok: false, error: "Forbidden" } }, "settings.org.sponsors.uploadNotAllowed"],
    ] as const) {
      calls.length = 0;
      answer = (url, method) => (url.includes("/content-upload") && method === "POST" ? grant : { status: 200, body: { data: [] } });
      const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
      m.edit("Quay Chandlers");
      await posterOf(m)!.onPick(pngFile());
      await flush();
      await save(m);
      expect(m.text(), label).toContain(msg(key));
      expect(calls.filter((c) => c.method === "PATCH"), `${label}: nothing saved`).toHaveLength(0);
      expect(m.has("sponsor-sheet-editor"), `${label}: the editor stays open`).toBe(true);
      expect(posterOf(m)!.value.file, `${label}: the pick is still there to retry`).not.toBeNull();
      checked++;
    }
    calls.length = 0;
    answer = (url, method) => (url.includes("/content-upload") && method === "POST" ? CONTENT_UPLOAD_OK : url === "https://storage.example/put" ? { status: 500, body: {} } : { status: 200, body: { data: [] } });
    const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
    m.edit("Quay Chandlers");
    await posterOf(m)!.onPick(pngFile());
    await flush();
    await save(m);
    expect(m.text(), "storage PUT 500").toContain(msg("settings.org.logo.uploadFailed"));
    expect(calls.filter((c) => c.method === "PATCH"), "storage PUT 500: nothing saved").toHaveLength(0);
    checked++;
    expect(checked).toBe(3);
  });

  it("over the storage's cap (413, on the grant or on the PUT) a poster says the POSTER size words and a logo still says the logo's (fix round 1, M3; 4 checked)", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    const hintMb = Number(/up to (\d+) MB/.exec(flat(stripTags(formMarkup({ poster: posterProp() }))))?.[1]);
    expect(Number.isInteger(hintMb) && hintMb > 0, "premise: the hint carries a whole number of MB").toBe(true);
    const POSTER_WORDS = msg("sponsors.poster.tooBig", { mb: hintMb });
    const LOGO_WORDS = msg("settings.org.sponsors.tooBig");
    expect(POSTER_WORDS, "premise: the two sentences differ (a mapping that mixed them up would show it)").not.toBe(LOGO_WORDS);
    const REFUSALS = {
      grant: (url: string, method: string) => (url.includes("/content-upload") && method === "POST" ? { status: 413, body: { ok: false, error: "Payload Too Large" } } : { status: 200, body: { data: [] } }),
      put: (url: string, method: string) =>
        url.includes("/content-upload") && method === "POST" ? CONTENT_UPLOAD_OK : url === "https://storage.example/put" ? { status: 413, body: {} } : { status: 200, body: { data: [] } },
    };
    let checked = 0;
    for (const where of ["grant", "put"] as const) {
      for (const what of ["poster", "logo"] as const) {
        calls.length = 0;
        answer = REFUSALS[where];
        const m = mount([row({ id: "a", name: "Quay Chandlers" })]);
        m.edit("Quay Chandlers");
        if (what === "poster") {
          await posterOf(m)!.onPick(pngFile());
          await flush();
        } else {
          (propsOf(m.form()).onChange as (fn: (p: typeof DRAFT) => unknown) => void)((p) => ({ ...p, file: pngFile(1, "logo.png") }));
        }
        await save(m);
        const label = `${what} 413 on the ${where}`;
        expect(calls.some((c) => c.url.includes("/content-upload")), `${label}: the upload was attempted`).toBe(true);
        expect(m.text(), label).toContain(what === "poster" ? POSTER_WORDS : LOGO_WORDS);
        expect(m.text(), `${label}: not the other file's words`).not.toContain(what === "poster" ? LOGO_WORDS : POSTER_WORDS);
        expect(calls.filter((c) => c.method === "PATCH"), `${label}: nothing saved`).toHaveLength(0);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("an abandoned pick is not carried into the next editor: Cancel then Edit again, and a second sponsor's pencil, both open at what is STORED", async () => {
    vi.stubGlobal("createImageBitmap", bitmapOf(1080, 1350));
    answer = OKAY();
    const m = mount([
      row({ id: "a", name: "Quay Chandlers", poster_path: POSTER_STORED }),
      row({ id: "b", name: "Ridge Cycles", poster_path: null }),
    ]);
    m.edit("Quay Chandlers");
    await posterOf(m)!.onPick(pngFile());
    await flush();
    expect(posterOf(m)!.value.file, "premise: a pick is in the draft").not.toBeNull();
    // Cancel closes the editor; the page's own Edit button opens it again.
    (propsOf(m.form()).onCancel as () => void)();
    (propsOf(m.find("sponsor-sheet-edit")).onClick as () => void)();
    expect(posterOf(m)!.value, "Edit again: back to what is stored").toEqual({ file: null, preview: POSTER_STORED, removed: false, crop: null });
    // The pencil on ANOTHER sponsor: its own stored poster (none), not the first one's pick.
    await posterOf(m)!.onPick(pngFile());
    await flush();
    m.edit("Ridge Cycles");
    expect(posterOf(m)!.value, "the next sponsor's editor starts at its own stored poster").toEqual(POSTER_NONE);
  });
});
