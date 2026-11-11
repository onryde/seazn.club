// Sponsor deals PR 2, Task 18 - the Packages tab as a price list (components/sponsors/package-list.tsx; spec §6.4, mockup screen 4).
//
// Packages stop being a sell console. A package is a price on the club's list: a card with its name, price, tier, where it applies,
// whether it puts the sponsor on the stream, and how many sponsors hold an open deal on it. Creating one is a sheet (today's fields plus
// On stream); retiring one asks first. The orders list is gone - deals live on the Sponsors tab - and the tab is offered on every plan:
// a package is a placement, so only the TIER and the one-competition scope are gated (placementNeedsTiers), never the list.
//
// Every expectation is typed from the brief, the mockup or the server's own rule - never read back from the component. The wire
// (what a person's tap POSTs) is read from a fetch stub, not from the component's own body builder.
//
// vitest is `environment: "node"`: the list is driven under components/__tests__/_hook-harness.tsx (the element tree back; a tap is
// the element's own handler), the cards and the sheet are read with `renderToStaticMarkup`. What neither can see - CSS, widths, tap
// area, the sheet over the page - is the e2e's (`e2e/sponsors-hub.spec.ts`, run by CI) and the 320/768/1280 look.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   P1  count     draw `used_by` as "Not used yet" whatever it is                         -> "Used by N sponsors"
//   P2  wire      drop `includes_on_stream` from the create's body                        -> "the create sheet POSTs includes_on_stream"
//   P3  gate      offer Gold and a competition scope on a plan without tiers             -> "a plan without tiers"
//   P4  retire    DELETE without asking                                                   -> "Retire asks first"
//   P5  map       show the generic words for a package's 422                               -> "a package refusal reads its own words"
//   P6  viewer    draw Create and Retire for a viewer                                      -> "a viewer"
//   L7  placement draw the tier legend above the cards                                      -> "with packages: after the last card"
//   F9  start     hand the legend startOpen=true whatever the list holds                    -> "startOpen is exactly: the list has no packages"
//   F10 link      hand the legend a literal billing href instead of the page's own          -> "the legend's upgrade link ... the page's billing href"
//   F11 fold      mount the legend without its phone fold                                    -> "the legend is folded below md"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const confirmMock = vi.hoisted(() => vi.fn<(opts?: { title?: string; body?: string; confirmLabel?: string }) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

import { Modal } from "@/components/modal";
import { PackageCard, PackageCreateSheet, PackageList, parsePriceCents, type PackageCardProps } from "@/components/sponsors/package-list";
import { TierLegend } from "@/components/sponsors/tier-legend";
import { expandWithHooks, propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";
import uiEn from "@/dictionaries/en/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ORG = "org-1";
const COMPS = [
  { id: "c-season", name: "Season 2026/27" },
  { id: "c-sixes", name: "Summer Sixes 2027" },
];

// --- fixtures: the mockup's own five packages (screen 4) ---------------------------------------------------------------------------

const pkg = (over: Partial<SponsorPackageRow> & { id: string; name: string }): SponsorPackageRow => ({
  competition_id: null, description: null, price_cents: 10_000, currency: "gbp", tier: "partner", active: true,
  created_at: "2026-10-01T09:00:00.000Z", includes_on_stream: false, used_by: 0, ...over,
});
const TITLE = pkg({ id: "p-title", name: "Title Season", tier: "title", price_cents: 150_000, competition_id: "c-season", includes_on_stream: true, used_by: 1 });
const GOLD = pkg({ id: "p-gold", name: "Gold Season", tier: "gold", price_cents: 60_000, competition_id: "c-season", includes_on_stream: true, used_by: 1 });
const SILVER = pkg({ id: "p-silver", name: "Silver Season", tier: "silver", price_cents: 30_000, competition_id: "c-season", used_by: 2 });
const PARTNER = pkg({ id: "p-partner", name: "Partner", tier: "partner", price_cents: 12_000, used_by: 2 });
const SIXES = pkg({ id: "p-sixes", name: "Summer Sixes Gold", tier: "gold", price_cents: 25_000, competition_id: "c-sixes", includes_on_stream: true, used_by: 0 });
const FIVE = [TITLE, GOLD, SILVER, PARTNER, SIXES];

function props(over: Partial<Parameters<typeof PackageList>[0]> = {}): Parameters<typeof PackageList>[0] {
  return {
    orgId: ORG, initialPackages: FIVE, competitions: COMPS, tiersOrgWide: true, tiersCompetitionIds: [], hasMonetize: true, billingHref: "/o/x/settings/billing",
    finishedCompetitionIds: [], canEdit: true, ...over,
  };
}
const listHtml = (over: Partial<Parameters<typeof PackageList>[0]> = {}) => renderToStaticMarkup(<PackageList {...props(over)} />);

function cardProps(over: Partial<PackageCardProps> = {}): PackageCardProps {
  return { pkg: PARTNER, competitions: COMPS, finished: false, canEdit: true, busy: false, onRetire: () => {}, ...over };
}
const cardHtml = (over: Partial<PackageCardProps> = {}) => renderToStaticMarkup(<PackageCard {...cardProps(over)} />);
const testidTag = (html: string, id: string): string | undefined => new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0];
const innerOf = (html: string, id: string): string | undefined => {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*data-testid="${id}"[^>]*>`).exec(html);
  if (!open) return undefined;
  const tag = open[1]!;
  const rest = html.slice(open.index + open[0].length);
  // The elements read here hold only text and inline children, so the first closing tag of the same name ends them.
  const end = rest.indexOf(`</${tag}>`);
  return flat(rest.slice(0, end));
};
const countOf = (html: string, id: string) => (html.match(new RegExp(`data-testid="${id}"`, "g")) ?? []).length;

// --- the island's rig: a fetch stub, and a tree that steps into the list's children and the sheet's modal footer ----------------------

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let answer: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { data: [] } });
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  calls.push({ url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
  const r = answer(url, method);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  confirmMock.mockImplementation(async () => true);
  answer = () => ({ status: 200, body: { data: [] } });
  vi.stubGlobal("fetch", fetchMock);
});

type AnyComponent = (p: never) => ReactNode;
const STEP_INTO: readonly AnyComponent[] = [PackageCard, PackageCreateSheet] as unknown as AnyComponent[];
/** Every element in the list's tree: the cards and the sheet are stepped into, and a Modal's footer is walked as well as its children. */
function expand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const type = node.type as AnyComponent;
  if (STEP_INTO.includes(type)) return expand(expandWithHooks(type as (p: unknown) => ReactNode, node.props), out);
  const p = node.props as { children?: ReactNode; footer?: ReactNode };
  expand(p.children, out);
  if (node.type === Modal) expand(p.footer, out);
  return out;
}
const mount = (over: Partial<Parameters<typeof PackageList>[0]> = {}) => {
  const island = renderIsland(PackageList, props(over), expand);
  const byId = (id: string) => island.tree().filter((el) => propsOf(el)["data-testid"] === id);
  const one = (id: string): ReactElement => {
    const hits = byId(id);
    if (hits.length !== 1) throw new Error(`expected one ${id}, found ${hits.length}`);
    return hits[0]!;
  };
  /** Types into a control of the open sheet the way the browser does: the element's own onChange, handed an event. */
  const type = (id: string, value: string) => (propsOf(one(id)).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const toggle = (id: string, checked: boolean) => (propsOf(one(id)).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
  const tap = async (id: string) => {
    (propsOf(one(id)).onClick as () => void)();
    await flush();
  };
  return { island, byId, one, type, toggle, tap, text: () => island.text() };
};
async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- the tier legend (owner, 2026-11-11: "some description or legend in package under the panel for explain the different tier usage") ---
// Its own words and weights are tier-legend.test.tsx's; what the LIST owes is where it sits and on whom it shows.

const at = (html: string, id: string) => html.indexOf(`data-testid="${id}"`);

describe("the tier legend sits under the price list, on every plan, with or without packages", () => {
  it("with packages: after the last card, before the online-invoices note (L7 placement)", () => {
    const html = listHtml();
    const lastCard = html.lastIndexOf('data-testid="package-card"');
    expect(countOf(html, "package-card"), "premise: the five fixture cards are drawn").toBe(5);
    expect(countOf(html, "tier-legend")).toBe(1);
    expect(at(html, "tier-legend"), "after the cards").toBeGreaterThan(lastCard);
    expect(at(html, "tier-legend"), "before the note").toBeLessThan(at(html, "package-online-note"));
  });

  it("with none: after the empty state, before the note - a club with no packages is told what a tier is when it needs it most", () => {
    const html = listHtml({ initialPackages: [] });
    expect(countOf(html, "package-empty")).toBe(1);
    expect(countOf(html, "tier-legend")).toBe(1);
    expect(at(html, "tier-legend")).toBeGreaterThan(at(html, "package-empty"));
    expect(at(html, "tier-legend")).toBeLessThan(at(html, "package-online-note"));
  });

  it("on every plan and for a viewer: four rows each, and the plan line (its board sentence and its tiers sentence) only where the plan has no organisation-wide tiers (8 checked)", () => {
    let checked = 0;
    for (const tiersOrgWide of [true, false]) {
      for (const canEdit of [true, false]) {
        for (const initialPackages of [FIVE, []]) {
          const html = listHtml({ tiersOrgWide, canEdit, initialPackages });
          const label = `tiers=${tiersOrgWide} edit=${canEdit} packages=${initialPackages.length}`;
          expect(countOf(html, "tier-legend-row"), `${label}: four tiers`).toBe(4);
          expect(countOf(html, "tier-legend-plan"), `${label}: the plan line`).toBe(tiersOrgWide ? 0 : 1);
          expect(countOf(html, "tier-legend-plan-board"), `${label}: what its pages and stream do`).toBe(tiersOrgWide ? 0 : 1);
          expect(countOf(html, "tier-legend-plan-tiers"), `${label}: what needs a paid plan`).toBe(tiersOrgWide ? 0 : 1);
          checked++;
        }
      }
    }
    expect(checked).toBe(8);
  });

  it("startOpen is exactly: the list has no packages - the legend opens on a phone when the tab has nothing else to say, and folds when the price list is the page (2 x 2 checked)", () => {
    let checked = 0;
    for (const tiersOrgWide of [true, false]) {
      for (const [initialPackages, want] of [[[], true], [FIVE, false], [[TITLE], false]] as const) {
        const legendEl = mount({ tiersOrgWide, initialPackages: [...initialPackages] })
          .island.tree()
          .find((el) => el.type === TierLegend);
        expect(legendEl, `tiers=${tiersOrgWide} packages=${initialPackages.length}: the list mounts the legend`).toBeDefined();
        expect(propsOf(legendEl!).startOpen, `tiers=${tiersOrgWide} packages=${initialPackages.length}`).toBe(want);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(6);
  });

  it("the legend's upgrade link is the page's billing href, an editor's, and only on a plan without tiers (2 x 2 checked)", () => {
    let checked = 0;
    for (const tiersOrgWide of [true, false]) {
      for (const canEdit of [true, false]) {
        const html = listHtml({ tiersOrgWide, canEdit, billingHref: "/o/club/settings/billing", hasMonetize: true });
        const want = !tiersOrgWide && canEdit;
        expect(countOf(html, "tier-legend-upgrade"), `tiers=${tiersOrgWide} edit=${canEdit}`).toBe(want ? 1 : 0);
        if (want) expect(testidTag(html, "tier-legend-upgrade"), "the page's own href").toContain('href="/o/club/settings/billing"');
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("the legend is folded below md, and the online note sits right after the fold: on a phone with packages the note rises by the legend's whole height (the closed body is max-md:hidden)", () => {
    const html = listHtml({ hasMonetize: false });
    const fold = at(html, "tier-legend-fold");
    expect(fold, "premise: the fold is drawn").toBeGreaterThan(-1);
    const toggle = /<button\b[^>]*data-role="phone-disclosure-toggle"[^>]*>/.exec(html.slice(fold))?.[0] ?? "";
    expect(toggle, "the legend's toggle is phone-only").toMatch(/class="[^"]*\smd:hidden"/);
    expect(toggle, "folded on first paint (a list with packages)").toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(toggle)?.[1];
    expect(html.slice(fold), "its body is hidden below md and nothing else is").toMatch(new RegExp(`<div class="grid min-w-0 flex-1 grid-cols-\\[minmax\\(0,1fr\\)\\] max-md:hidden" id="${controls}">`));
    expect(at(html, "tier-legend-fold"), "the fold sits before the note").toBeLessThan(at(html, "package-online-note"));
    // Nothing between the fold's end and the note takes height on a phone: only closing wrappers lie between them.
    const afterLegend = html.slice(html.indexOf("</section>", fold) + "</section>".length, at(html, "package-online-note"));
    expect(afterLegend.replace(/<\/div>/g, "").replace(/<p\s*$/, "").trim(), "only the closing wrappers lie between the legend and the note").toBe("");
  });
});

// --- the empty case first -----------------------------------------------------------------------------------------------------------

describe("the empty case: no packages yet", () => {
  it("says so and offers Create to an editor - on every plan, a community editor included", () => {
    let checked = 0;
    for (const tiersOrgWide of [true, false]) {
      for (const hasMonetize of [true, false]) {
        const html = listHtml({ initialPackages: [], tiersOrgWide, hasMonetize });
        const label = `tiers=${tiersOrgWide} monetize=${hasMonetize}`;
        expect(flat(html), label).toContain(msg("sponsors.pkg.empty"));
        expect(countOf(html, "package-card"), `${label}: no card`).toBe(0);
        expect(countOf(html, "sponsor-pkg-create"), `${label}: Create is offered`).toBe(1);
        expect(flat(innerOf(html, "sponsor-pkg-create") ?? ""), label).toBe(msg("sponsors.pkg.create"));
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("a viewer is told the same and offered nothing to press (P6)", () => {
    const html = listHtml({ initialPackages: [], canEdit: false });
    expect(flat(html)).toContain(msg("sponsors.pkg.empty"));
    expect(countOf(html, "sponsor-pkg-create")).toBe(0);
  });

  it("the list wraps everything under one testid, so the hub's smoke and e2e find the price list", () => {
    expect(countOf(listHtml({ initialPackages: [] }), "sponsor-package-list")).toBe(1);
    expect(countOf(listHtml(), "sponsor-package-list")).toBe(1);
  });
});

// --- the cards -----------------------------------------------------------------------------------------------------------------------

describe("each package is a card: name, price, tier, scope, On stream and how many sponsors use it", () => {
  it("the mockup's five packages: each card carries its own name, price, tier and scope (5 checked)", () => {
    const WANT: { pkg: SponsorPackageRow; name: string; price: string; tier: string; scope: string }[] = [
      { pkg: TITLE, name: "Title Season", price: "£1,500", tier: "Title", scope: "Season 2026/27" },
      { pkg: GOLD, name: "Gold Season", price: "£600", tier: "Gold", scope: "Season 2026/27" },
      { pkg: SILVER, name: "Silver Season", price: "£300", tier: "Silver", scope: "Season 2026/27" },
      { pkg: PARTNER, name: "Partner", price: "£120", tier: "Partner", scope: "Any competition" },
      { pkg: SIXES, name: "Summer Sixes Gold", price: "£250", tier: "Gold", scope: "Summer Sixes 2027" },
    ];
    let checked = 0;
    for (const w of WANT) {
      const html = cardHtml({ pkg: w.pkg });
      expect(innerOf(html, "package-name"), w.name).toBe(w.name);
      expect(innerOf(html, "package-price"), w.name).toBe(w.price);
      expect(innerOf(html, "package-tier"), w.name).toBe(w.tier);
      expect(innerOf(html, "package-scope"), w.name).toBe(w.scope);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a price with pence keeps them; a whole price drops them; the card's currency is the package's own", () => {
    expect(innerOf(cardHtml({ pkg: pkg({ id: "x", name: "X", price_cents: 12_050 }) }), "package-price")).toBe("£120.50");
    expect(innerOf(cardHtml({ pkg: pkg({ id: "x", name: "X", price_cents: 12_000, currency: "eur" }) }), "package-price")).toBe("€120");
  });

  it("'Used by N sponsors' comes from used_by: 2 reads 'Used by 2 sponsors', 1 reads 'Used by 1 sponsor', 0 reads 'Not used yet' (P1)", () => {
    const CASES: [number, string][] = [
      [0, "Not used yet"],
      [1, "Used by 1 sponsor"],
      [2, "Used by 2 sponsors"],
      [12, "Used by 12 sponsors"],
    ];
    let checked = 0;
    for (const [used_by, words] of CASES) {
      expect(innerOf(cardHtml({ pkg: pkg({ id: "u", name: "U", used_by }) }), "package-used-by"), `used_by ${used_by}`).toBe(words);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("On stream shows when the package includes it, and only then (the pair)", () => {
    expect(innerOf(cardHtml({ pkg: GOLD }), "package-on-stream")).toBe("On stream");
    expect(countOf(cardHtml({ pkg: SILVER }), "package-on-stream")).toBe(0);
  });

  it("a package for a competition the list does not know says so rather than printing an id", () => {
    const html = cardHtml({ pkg: pkg({ id: "g", name: "G", competition_id: "c-deleted" }) });
    expect(innerOf(html, "package-scope")).toBe(msg("sponsors.dealSheet.scopeUnknown"));
    expect(html).not.toContain("c-deleted");
  });

  it("retired: a Retired chip, no Retire button, and the used-by line still stands", () => {
    const html = cardHtml({ pkg: pkg({ id: "r", name: "Old", active: false, used_by: 1 }) });
    expect(innerOf(html, "package-retired")).toBe("Retired");
    expect(countOf(html, "package-retire")).toBe(0);
    expect(innerOf(html, "package-used-by")).toBe("Used by 1 sponsor");
    // The pair: an active one has the button and no chip.
    const active = cardHtml({ pkg: PARTNER });
    expect(countOf(active, "package-retire")).toBe(1);
    expect(countOf(active, "package-retired")).toBe(0);
  });

  it("finished: a package for a competition that has finished says it is not sold; one for a competition still going does not", () => {
    expect(innerOf(cardHtml({ pkg: GOLD, finished: true }), "package-finished")).toBe("Competition finished");
    expect(countOf(cardHtml({ pkg: GOLD, finished: false }), "package-finished")).toBe(0);
  });

  it("Retire is for an editor: a viewer sees the card and no button; the button names its package for a screen reader", () => {
    expect(countOf(cardHtml({ canEdit: false }), "package-retire")).toBe(0);
    expect(countOf(cardHtml({ canEdit: false }), "package-name")).toBe(1);
    const tag = testidTag(cardHtml({ pkg: GOLD }), "package-retire")!;
    expect(tag).toContain(`aria-label="${msg("sponsors.pkg.retire", { name: "Gold Season" })}"`);
  });

  it("a phone's Retire is a 44px target and a long name wraps inside the card (the class that makes both)", () => {
    const html = cardHtml({ pkg: pkg({ id: "l", name: "Harbourside Building Supplies and Timber Co Title Season" }) });
    expect(testidTag(html, "package-retire")).toMatch(/max-md:min-h-11/);
    expect(testidTag(html, "package-name")).toMatch(/break-words/);
    expect(testidTag(html, "package-card")).toMatch(/min-w-0/);
  });

  it("the list draws one card per package, in the order the server sent them (5 checked), with the packages' ids on them", () => {
    const html = listHtml();
    const ids = [...html.matchAll(/data-testid="package-card"[^>]*data-package-id="([^"]+)"|data-package-id="([^"]+)"[^>]*data-testid="package-card"/g)].map((m) => m[1] ?? m[2]);
    expect(ids).toEqual(FIVE.map((p) => p.id));
  });
});

// --- the create sheet ------------------------------------------------------------------------------------------------------------------

describe("the create sheet: today's fields plus the On stream toggle", () => {
  const sheet = (over: Partial<Parameters<typeof PackageCreateSheet>[0]> = {}) =>
    renderToStaticMarkup(
      <PackageCreateSheet
        draft={{ name: "", price: "", currency: "gbp", tier: "partner", competition_id: "", includes_on_stream: false }}
        onChange={() => {}} onSubmit={() => {}} onClose={() => {}} competitions={COMPS} tiersOrgWide tiersCompetitionIds={[]} busy={false} canSave={false} error={null}
        billingHref="/o/x/settings/billing" {...over}
      />,
    );

  it("has every field a package needs, each labelled in the dictionary's words", () => {
    const html = sheet();
    for (const id of ["package-create-name", "package-create-price", "package-create-currency", "package-create-tier", "package-create-scope", "package-create-on-stream"]) {
      expect(countOf(html, id), id).toBe(1);
    }
    const words = flat(html);
    for (const key of ["sponsors.pkg.name", "sponsors.pkg.price", "sponsors.pkg.currency", "sponsors.tierLabel", "sponsors.scopeLabel", "sponsors.pkg.onStream"] as MessageKey[]) {
      expect(words, key).toContain(msg(key));
    }
    expect(words).toContain(msg("sponsors.pkg.onStreamHint"));
  });

  it("the sheet is the house Modal, titled 'Create package', with Cancel and Create in its footer", () => {
    const el = expandWithHooks(PackageCreateSheet, {
      draft: { name: "", price: "", currency: "gbp", tier: "partner", competition_id: "", includes_on_stream: false },
      onChange: () => {}, onSubmit: () => {}, onClose: () => {}, competitions: COMPS, tiersOrgWide: true, tiersCompetitionIds: [], busy: false, canSave: false, error: null,
      billingHref: "/x",
    }) as ReactElement;
    expect(el.type).toBe(Modal);
    expect(propsOf(el).title).toBe("Create package");
    expect(textOf(propsOf(el).footer as ReactNode)).toContain("Cancel");
    expect(textOf(propsOf(el).footer as ReactNode)).toContain("Create package");
  });

  it("the Create button is disabled until the package can be saved, and while a write is in flight", () => {
    const submitTag = (html: string) => testidTag(html, "package-create-submit")!;
    const disabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);
    expect(disabled(submitTag(sheet({ canSave: false })))).toBe(true);
    expect(disabled(submitTag(sheet({ canSave: true })))).toBe(false);
    expect(disabled(submitTag(sheet({ canSave: true, busy: true }))), "a second tap would send a second package").toBe(true);
  });

  it("a plan without tiers: every tier but Partner and every competition is disabled, with the reason and the way out (P3)", () => {
    const html = sheet({ tiersOrgWide: false });
    const tierSelect = /<select\b[^>]*data-testid="package-create-tier"[^>]*>[\s\S]*?<\/select>/.exec(html)![0];
    const scopeSelect = /<select\b[^>]*data-testid="package-create-scope"[^>]*>[\s\S]*?<\/select>/.exec(html)![0];
    const options = (select: string) => [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ value: /value="([^"]*)"/.exec(m[1]!)?.[1], disabled: /\sdisabled(=|\s|$)/.test(m[1]!) }));
    const tiers = options(tierSelect);
    expect(tiers.map((o) => o.value), "every tier is listed").toEqual([...SPONSOR_TIERS]);
    expect(tiers.filter((o) => !o.disabled).map((o) => o.value), "only Partner is open").toEqual(["partner"]);
    const scopes = options(scopeSelect);
    expect(scopes.filter((o) => !o.disabled).map((o) => o.value), "only the whole organisation is open").toEqual([""]);
    expect(scopes.length, "and both competitions are listed, shut").toBe(1 + COMPS.length);
    expect(flat(html)).toContain(msg("sponsors.pkg.tiersHint"));
    expect(testidTag(html, "package-create-upgrade")).toContain('href="/o/x/settings/billing"');
  });

  it("a plan with tiers: everything is open and there is no reason shown (the pair)", () => {
    const html = sheet({ tiersOrgWide: true });
    expect(/<option\b[^>]*\sdisabled/.test(html)).toBe(false);
    expect(flat(html)).not.toContain(msg("sponsors.pkg.tiersHint"));
    expect(countOf(html, "package-create-upgrade")).toBe(0);
  });

  it("an Event Pass on one competition opens that competition and every tier on it, and nothing else - the whole organisation stays Partner-only, with the reason (counted)", () => {
    // The server's gate (usecases/sponsors.ts `createSponsorPackage`): a competition-scoped package asks `sponsors.tiers` on THAT competition; the whole
    // organisation asks the plan only, so a pass never lifts it. c-season holds the pass; c-sixes does not.
    const pass = { tiersOrgWide: false, tiersCompetitionIds: ["c-season"] };
    const options = (html: string, id: string) => {
      const select = new RegExp(`<select\\b[^>]*data-testid="${id}"[^>]*>[\\s\\S]*?<\\/select>`).exec(html)![0];
      return [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ value: /value="([^"]*)"/.exec(m[1]!)?.[1], disabled: /\sdisabled(=|\s|$)/.test(m[1]!) }));
    };
    // [tier, expected open scopes] - typed from the rule: Partner is open on the whole organisation (no tiers needed there), a competition
    // needs tiers on it, and any other tier needs them org-wide for the whole organisation.
    const cases: [SponsorTier, string[]][] = [
      ["partner", ["", "c-season"]],
      ["gold", ["c-season"]],
    ];
    let checked = 0;
    for (const [tier, open] of cases) {
      const html = sheet({ ...pass, draft: { name: "", price: "", currency: "gbp", tier, competition_id: "", includes_on_stream: false } });
      expect(options(html, "package-create-scope").filter((o) => !o.disabled).map((o) => o.value), `${tier}: the scopes it can be placed on`).toEqual(open);
      checked++;
    }
    const base = sheet(pass);
    expect(options(base, "package-create-tier").filter((o) => !o.disabled).map((o) => o.value), "on the whole organisation only Partner is open").toEqual(["partner"]);
    const onCompetition = sheet({ ...pass, draft: { name: "", price: "", currency: "gbp", tier: "partner", competition_id: "c-season", includes_on_stream: false } });
    expect(options(onCompetition, "package-create-tier").filter((o) => !o.disabled).map((o) => o.value), "on the pass's competition every tier is open").toEqual([...SPONSOR_TIERS]);
    const onOther = sheet({ ...pass, draft: { name: "", price: "", currency: "gbp", tier: "partner", competition_id: "c-sixes", includes_on_stream: false } });
    expect(options(onOther, "package-create-tier").filter((o) => !o.disabled).map((o) => o.value), "a competition without a pass places nothing").toEqual([]);
    expect(flat(base), "something is still shut, so the reason and the way out show").toContain(msg("sponsors.pkg.tiersHint"));
    expect(countOf(base, "package-create-upgrade")).toBe(1);
    checked += 3;
    expect(checked).toBe(5);
  });

  it("a refusal shows inside the sheet, as an alert; no refusal shows nothing", () => {
    expect(testidTag(sheet({ error: "Nope" }), "package-create-error")).toContain('role="alert"');
    expect(flat(sheet({ error: "Nope" }))).toContain("Nope");
    expect(countOf(sheet({ error: null }), "package-create-error")).toBe(0);
  });
});

describe("the price a person types becomes whole minor units, exactly - or nothing", () => {
  it("accepts what money looks like (9 checked) and refuses what it does not (11 checked)", () => {
    const OK: [string, number][] = [
      ["250", 25_000], ["250.5", 25_050], ["250.50", 25_050], ["0.99", 99], ["12,50", 1_250], [" 120 ", 12_000], ["1.1", 110], ["19.99", 1_999],
    ];
    for (const [text, cents] of OK) expect(parsePriceCents(text), text).toBe(cents);
    // "1.005" has a third decimal: money has two, so it is refused below and not rounded to a price nobody typed.
    const NO = ["", "0", "0.00", "-5", "abc", "250abc", "1.005", "1e3", "1..5", "£250", "12,345"];
    for (const text of NO) expect(parsePriceCents(text), JSON.stringify(text)).toBeNull();
    expect(OK.length).toBe(8);
    expect(NO.length).toBe(11);
  });

  it("is exact where a float is not: 19.99 and 1.15 are not 1998.9999 and 114.99999", () => {
    expect(parsePriceCents("19.99")).toBe(1_999);
    expect(parsePriceCents("1.15")).toBe(115);
    expect(parsePriceCents("0.07")).toBe(7);
  });
});

// --- the island: create, retire, and what a refusal says ---------------------------------------------------------------------------

describe("create: the sheet POSTs the package, then the list re-reads", () => {
  it("empty first: Create opens a blank sheet; nothing is sent until the person saves", async () => {
    const m = mount({ initialPackages: [] });
    expect(m.byId("package-create-sheet")).toEqual([]);
    await m.tap("sponsor-pkg-create");
    expect(m.byId("package-create-name"), "the sheet is open").toHaveLength(1);
    expect(calls, "opening sends nothing").toEqual([]);
  });

  it("the create sheet POSTs includes_on_stream with the typed name, a price in minor units, currency, tier and scope (P2)", async () => {
    answer = (url, method) =>
      method === "POST"
        ? { status: 201, body: { data: { ...GOLD, id: "p-new", name: "Autumn Gold" } } }
        : { status: 200, body: { data: [pkg({ id: "p-new", name: "Autumn Gold", tier: "gold", price_cents: 25_050, currency: "eur", competition_id: "c-sixes", includes_on_stream: true })] } };
    const m = mount();
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "  Autumn Gold ");
    m.type("package-create-price", "250.50");
    m.type("package-create-currency", "eur");
    m.type("package-create-tier", "gold");
    m.type("package-create-scope", "c-sixes");
    m.toggle("package-create-on-stream", true);
    await m.tap("package-create-submit");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsor-packages`]);
    expect(posts[0]!.body, "exactly the fields the server's schema takes").toEqual({
      name: "Autumn Gold", price_cents: 25_050, currency: "eur", tier: "gold", competition_id: "c-sixes", includes_on_stream: true,
    });
    // The list re-reads (GET), the sheet closes, the new package is on the list and the person is told.
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsor-packages`]);
    expect(m.byId("package-create-name"), "saved: the sheet closes").toEqual([]);
    expect(m.text()).toContain("Autumn Gold");
    expect(m.text()).toContain(msg("sponsors.pkg.created", { name: "Autumn Gold" }));
  });

  it("a failed re-read keeps what the write already showed: the new package is on the list, the sheet is closed and nothing is reported as failed", async () => {
    answer = (_url, method) =>
      method === "POST"
        ? { status: 201, body: { data: { ...GOLD, id: "p-kept", name: "Kept anyway" } } }
        : { status: 500, body: { ok: false, error: "boom" } };
    const m = mount({ initialPackages: [] });
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "Kept anyway");
    m.type("package-create-price", "100");
    await m.tap("package-create-submit");
    expect(calls.filter((c) => c.method === "GET"), "premise: the re-read was attempted").toHaveLength(1);
    expect(m.text(), "the package the create answered is shown").toContain("Kept anyway");
    expect(m.byId("package-create-name"), "the sheet closed").toEqual([]);
    expect(m.byId("package-list-error"), "a failed re-read is not an error to the person").toEqual([]);
    expect(m.byId("package-empty"), "and the list is not empty").toEqual([]);
  });

  it("the toggle off sends includes_on_stream: false, never omits it; no scope sends no competition_id (the pair)", async () => {
    answer = (_url, method) => (method === "POST" ? { status: 201, body: { data: GOLD } } : { status: 200, body: { data: FIVE } });
    const m = mount();
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "Plain");
    m.type("package-create-price", "100");
    await m.tap("package-create-submit");
    const body = calls.find((c) => c.method === "POST")!.body!;
    expect(body.includes_on_stream).toBe(false);
    expect(Object.keys(body)).not.toContain("competition_id");
    expect(body).toEqual({ name: "Plain", price_cents: 10_000, currency: "gbp", tier: "partner", includes_on_stream: false });
  });

  it("an unsaveable draft cannot be sent: no name, no price, a bad price - the submit handler sends nothing (3 checked)", async () => {
    let checked = 0;
    for (const [name, price] of [["", "100"], ["Name", ""], ["Name", "12.345"]] as const) {
      calls.length = 0;
      const m = mount();
      await m.tap("sponsor-pkg-create");
      m.type("package-create-name", name);
      m.type("package-create-price", price);
      expect(propsOf(m.one("package-create-submit")).disabled, `${name}/${price}`).toBe(true);
      // `disabled` keeps a browser from firing it; the handler must not rely on that (a guard, not a comment).
      await m.tap("package-create-submit");
      expect(calls.filter((c) => c.method === "POST"), `${JSON.stringify([name, price])} sent nothing`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the sequence: a second package starts from a blank sheet, and Cancel throws a half-typed draft away", async () => {
    answer = (_url, method) => (method === "POST" ? { status: 201, body: { data: GOLD } } : { status: 200, body: { data: FIVE } });
    const m = mount();
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "First");
    m.type("package-create-price", "100");
    m.toggle("package-create-on-stream", true);
    await m.tap("package-create-submit");
    await m.tap("sponsor-pkg-create");
    expect(propsOf(m.one("package-create-name")).value, "name is blank again").toBe("");
    expect(propsOf(m.one("package-create-price")).value, "price is blank again").toBe("");
    expect(propsOf(m.one("package-create-on-stream")).checked, "the toggle is off again").toBe(false);
    m.type("package-create-name", "Half typed");
    await m.tap("package-create-cancel");
    expect(m.byId("package-create-name"), "cancelled: closed").toEqual([]);
    await m.tap("sponsor-pkg-create");
    expect(propsOf(m.one("package-create-name")).value, "the half-typed name did not survive").toBe("");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a plan without tiers cannot SAVE a tiered or one-competition package even when the draft got there past the disabled options (3 checked)", async () => {
    // The options are disabled in the markup, but a stale draft or a hand-edited DOM can still set them: the server refuses it
    // (402 on `sponsors.tiers`), so the sheet must not offer to send it - the same placement rule as the server's, however the draft arrived.
    let checked = 0;
    for (const [tier, scope] of [["gold", ""], ["partner", "c-sixes"], ["title", "c-sixes"]] as const) {
      calls.length = 0;
      const m = mount({ tiersOrgWide: false });
      await m.tap("sponsor-pkg-create");
      m.type("package-create-name", "Forced");
      m.type("package-create-price", "100");
      m.type("package-create-tier", tier);
      m.type("package-create-scope", scope);
      expect(propsOf(m.one("package-create-submit")).disabled, `${tier}/${scope || "whole"}: the button is off`).toBe(true);
      await m.tap("package-create-submit");
      expect(calls.filter((c) => c.method === "POST"), `${tier}/${scope || "whole"}: nothing was sent`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
    // The pair: the same draft on a plan WITH tiers is saveable (the guard is the plan, not the draft).
    const withTiers = mount({ tiersOrgWide: true });
    await withTiers.tap("sponsor-pkg-create");
    withTiers.type("package-create-name", "Forced");
    withTiers.type("package-create-price", "100");
    withTiers.type("package-create-tier", "gold");
    expect(propsOf(withTiers.one("package-create-submit")).disabled).toBe(false);
  });

  it("an Event Pass on one competition saves a package for THAT competition and refuses every other placement (4 checked, 2 pairs)", async () => {
    // Per scope, like the server: tiers on c-season only. Typed from the gate (`createSponsorPackage`), never read back from the sheet.
    const pass = { tiersOrgWide: false, tiersCompetitionIds: ["c-season"] };
    let checked = 0;
    for (const [tier, scope, saveable] of [
      ["gold", "c-season", true],
      ["title", "c-season", true],
      ["gold", "c-sixes", false],
      ["gold", "", false],
    ] as const) {
      calls.length = 0;
      const m = mount(pass);
      await m.tap("sponsor-pkg-create");
      m.type("package-create-name", "Pass package");
      m.type("package-create-price", "100");
      m.type("package-create-tier", tier);
      m.type("package-create-scope", scope);
      expect(propsOf(m.one("package-create-submit")).disabled, `${tier}/${scope || "whole"}: ${saveable ? "placed by the pass" : "the server would answer 402"}`).toBe(!saveable);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a plan without tiers opens the sheet on Partner for the whole organisation, and what it sends says so", async () => {
    answer = (_url, method) => (method === "POST" ? { status: 201, body: { data: PARTNER } } : { status: 200, body: { data: [PARTNER] } });
    const m = mount({ tiersOrgWide: false, initialPackages: [] });
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "Club partner");
    m.type("package-create-price", "120");
    await m.tap("package-create-submit");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ tier: "partner", includes_on_stream: false });
    expect(Object.keys(calls.find((c) => c.method === "POST")!.body!)).not.toContain("competition_id");
  });
});

describe("Retire asks first, then retires, then the list re-reads (P4)", () => {
  it("asks with the package's name; declining sends nothing; accepting DELETEs that package", async () => {
    const m = mount();
    const retireFor = (id: string) => m.island.tree().find((el) => propsOf(el)["data-testid"] === "package-retire" && String(propsOf(el)["aria-label"]).includes(id))!;
    expect(retireFor("Gold Season")).toBeDefined();
    confirmMock.mockImplementationOnce(async () => false);
    (propsOf(retireFor("Gold Season")).onClick as () => void)();
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0]![0]!;
    expect(asked.title).toBe(msg("sponsors.pkg.retireConfirm.title"));
    expect(asked.body).toBe(msg("sponsors.pkg.retireConfirm.body", { name: "Gold Season" }));
    expect(calls, "declined: nothing sent").toEqual([]);

    answer = (_url, method) =>
      method === "DELETE" ? { status: 200, body: { data: { ...GOLD, active: false } } } : { status: 200, body: { data: [TITLE, { ...GOLD, active: false }, SILVER, PARTNER, SIXES] } };
    (propsOf(retireFor("Gold Season")).onClick as () => void)();
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/v1/orgs/${ORG}/sponsor-packages/${GOLD.id}`]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(m.byId("package-retired"), "the list now shows it retired").toHaveLength(1);
    expect(m.text()).toContain(msg("sponsors.pkg.retiredDone", { name: "Gold Season" }));
  });

  it("the retire words say deals, not orders, and say what is and is not affected", () => {
    const body = msg("sponsors.pkg.retireConfirm.body", { name: "Gold Season" });
    expect(body).toContain("Gold Season");
    expect(body).not.toMatch(/\border/i);
    expect(body).toMatch(/deal/i);
  });
});

describe("a package refusal reads its own words, never the generic Reload line and never the server's (P5)", () => {
  const refuse = (status: number, code: string) => (_url: string, method: string) =>
    method === "GET" ? { status: 200, body: { data: FIVE } } : { status, body: { ok: false, error: { code, message: "Invalid input: price_cents" } } };

  it("create: 422 VALIDATION says what a package needs; the sheet stays open with what was typed", async () => {
    answer = refuse(422, "VALIDATION");
    const m = mount();
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "Big");
    m.type("package-create-price", "99999999");
    await m.tap("package-create-submit");
    const shown = textOf(m.one("package-create-error") as ReactElement);
    expect(shown).toBe(msg("sponsors.error.packageInvalid"));
    expect(shown).not.toBe(msg("sponsors.error.invalid"));
    expect(shown).not.toContain("Invalid input");
    expect(propsOf(m.one("package-create-name")).value, "what was typed is kept").toBe("Big");
  });

  it("create: a plan refusal (402) and a rate limit (429) keep the shared words", async () => {
    let checked = 0;
    for (const [status, code, key] of [[402, "PAYMENT_REQUIRED", "sponsors.error.planRequired"], [429, "RATE_LIMITED", "sponsors.error.rateLimited"]] as const) {
      answer = refuse(status, code);
      const m = mount();
      await m.tap("sponsor-pkg-create");
      m.type("package-create-name", "X");
      m.type("package-create-price", "10");
      await m.tap("package-create-submit");
      expect(textOf(m.one("package-create-error") as ReactElement), code).toBe(msg(key));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("retire: 422 VALIDATION says the package could not be retired and to reload; the list shows it, outside any sheet", async () => {
    answer = refuse(422, "VALIDATION");
    const m = mount();
    const btn = m.island.tree().find((el) => propsOf(el)["data-testid"] === "package-retire")!;
    (propsOf(btn).onClick as () => void)();
    await flush();
    const shown = textOf(m.one("package-list-error") as ReactElement);
    expect(shown).toBe(msg("sponsors.error.packageRetireInvalid"));
    expect(shown).not.toBe(msg("sponsors.error.invalid"));
  });

  it("an unknown failure (a dropped connection) reads the house fallback, not a crash", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("network");
    });
    const m = mount();
    await m.tap("sponsor-pkg-create");
    m.type("package-create-name", "X");
    m.type("package-create-price", "10");
    await m.tap("package-create-submit");
    expect(textOf(m.one("package-create-error") as ReactElement)).toBe(msg("settings.saveFailed"));
  });
});

describe("the page's notes: online invoices are paid to Stripe, or need a paid plan", () => {
  it("a plan that sells online says where the money goes; one that does not says what it needs and links the way out", () => {
    const yes = listHtml({ hasMonetize: true });
    expect(flat(yes)).toContain(msg("sponsors.pkg.onlineNote"));
    expect(countOf(yes, "package-online-upgrade")).toBe(0);
    const no = listHtml({ hasMonetize: false });
    expect(flat(no)).toContain(msg("sponsors.pkg.onlineLocked"));
    expect(flat(no)).not.toContain(msg("sponsors.pkg.onlineNote"));
    expect(testidTag(no, "package-online-upgrade")).toContain('href="/o/x/settings/billing"');
  });

  it("the page names no 'order' anywhere a person reads (the vocabulary is deal)", () => {
    const words = flat(listHtml()) + " " + flat(listHtml({ initialPackages: [], hasMonetize: false }));
    expect(words).not.toMatch(/\border/i);
    expect(words).not.toMatch(/\binvoice\b.*\bpackage\b.*\bsend\b/i);
  });
});

// --- the words exist, in every locale (a missing key reads back as itself, which would make every `toContain(msg(key))` above vacuous) ---

describe("every word this screen reads exists in all four dictionaries (and is not its own key)", () => {
  it("the new keys (counted)", async () => {
    const LOCALES = ["en", "es", "fr", "nl"] as const;
    const KEYS: MessageKey[] = [
      "sponsors.pkg.empty", "sponsors.pkg.hint", "sponsors.pkg.onStream", "sponsors.pkg.onStreamHint", "sponsors.pkg.usedBy.one", "sponsors.pkg.usedBy.other",
      "sponsors.pkg.notUsed", "sponsors.pkg.retireShort", "sponsors.pkg.created", "sponsors.pkg.retiredDone", "sponsors.pkg.tiersHint", "sponsors.pkg.onlineNote",
      "sponsors.pkg.onlineLocked", "sponsors.error.packageInvalid", "sponsors.error.packageRetireInvalid", "sponsors.hub.tab.packages",
    ];
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<string, string>;
      for (const key of KEYS) {
        expect(typeof dict[key], `${locale}: ${key}`).toBe("string");
        expect(dict[key]!.trim().length, `${locale}: ${key} is not blank`).toBeGreaterThan(0);
        expect(dict[key], `${locale}: ${key} is not its own key`).not.toBe(key);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * KEYS.length);
    expect(msg("sponsors.hub.tab.packages"), "the tab's label (brief)").toBe("Packages");
  });
});
