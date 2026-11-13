import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// prerender, not renderToStaticMarkup: the page nests async server components (MarketingNav awaits getCurrentUser), which
// the synchronous renderer cannot await (home-signed-in.test.tsx, same folder, same harness).
import { prerender } from "react-dom/static";

// The quick match setup page, `/<lang>/play` (plan 2 Task 4; spec docs/superpowers/specs/2026-11-03-quick-match-design.md
// §5 step 2; pre-flight amendments B4, Q2; ledger "CARRY to T4": a real form post, `?e=` read on the server).
//
// HTML assertions anchor on `="` (AGENTS.md: React serialises an omitted prop as "$undefined", so a bare probe passes in
// both states). `listQuickMatchSports` is mocked per case (B4k) and defaults to the REAL one, which the DB-gated sweep at
// the end drives over the live offer.
//
// Sport: the stubbed cases use badminton (two kinds) and chess (one kind); the DB-gated case sweeps every sport the live
// catalog offers.

const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/en/play",
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("@/server/usecases/quick-match-sports", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-sports")>();
  return { ...real, listQuickMatchSports: vi.fn(real.listQuickMatchSports) };
});

import { listQuickMatchSports, offerFor, type QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { getDictionary } from "@/lib/i18n";
import PlayPage, { dynamic, generateMetadata } from "../play/page";
import { prefillSport, refusalCode, setupSports } from "../play/setup-props";
import { parseStartPrefill } from "../start/prefill";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { QuickMatchSetupForm, type SetupFormProps } from "@/components/quick-match/setup-form";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { ClearFlashParam } from "@/components/quick-match/clear-flash-param";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const HAS_DB = !!process.env.DATABASE_URL;

const OFFER: QuickMatchSport[] = [
  {
    sport_key: "badminton",
    labelKey: "sport.badminton",
    kinds: ["individual", "pair"],
    variants: [
      { variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: true },
      { variant_key: "bwf-3x15", labelKey: "variant.badminton.bwf3x15", knockoutAllowed: true },
    ],
  },
  {
    sport_key: "boardgame",
    labelKey: "sport.boardgame",
    kinds: ["individual"],
    variants: [{ variant_key: "rapid", labelKey: "variant.boardgame.rapid", knockoutAllowed: true }],
  },
];

/** An `<input>` with this name and value, whatever order React writes its attributes in (it puts `checked` between). */
const field = (name: string, value: string) =>
  new RegExp(`<input[^>]*\\bname="${name}"[^>]*\\bvalue="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);

/** The sport chips the server's HTML writes `checked` (the sport the form opens on), by value, in document order. */
const checkedSports = (html: string): string[] =>
  (html.match(/<input[^>]*\bname="sport_key"[^>]*>/g) ?? [])
    .filter((tag) => /\schecked=""/.test(tag))
    .map((tag) => tag.match(/\bvalue="([^"]*)"/)?.[1] ?? "?");
/** The sport chips the server's HTML writes `disabled` (pickable only once the script runs, I1), by value. */
const disabledSports = (html: string): string[] =>
  (html.match(/<input[^>]*\bname="sport_key"[^>]*>/g) ?? [])
    .filter((tag) => /\sdisabled=""/.test(tag))
    .map((tag) => tag.match(/\bvalue="([^"]*)"/)?.[1] ?? "?");

/** Catalog sports the probe's offer does NOT list (every variant of them excluded): `?sport=` must ignore them. From the
 *  offer's own generated file (quick-match-sports.ts reads the same one), never typed here. */
const UNOFFERED_SPORTS: string[] = (() => {
  const offered = new Set(offerJson.offered.map((o) => o.sport_key));
  return [...new Set(offerJson.excluded.map((x) => x.sport_key))].filter((k) => !offered.has(k));
})();

async function render(lang: string, search: Record<string, string | string[]> = {}): Promise<string> {
  const element = await PlayPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve(search) });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

/** The props the page hands the island: found in the page's own element tree, before any render (what the page puts
 *  in its payload, whatever the island then does with it). */
async function islandProps(search: Record<string, string | string[]>): Promise<SetupFormProps> {
  const root = await PlayPage({ params: Promise.resolve({ lang: "en" }), searchParams: Promise.resolve(search) });
  const found: SetupFormProps[] = [];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === QuickMatchSetupForm) found.push(el.props as unknown as SetupFormProps);
    visit(el.props.children);
  };
  visit(root);
  expect(found, "the page mounts one setup island").toHaveLength(1);
  return found[0]!;
}

beforeEach(() => {
  getCurrentUser.mockResolvedValue(null);
});
afterEach(() => {
  vi.mocked(listQuickMatchSports).mockReset();
});

describe("/<lang>/play: the empty case first (Q2)", () => {
  it("no sport offered: the unavailable line and no Start button", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce([]);
    const html = await render("en");
    expect(html).toContain("Quick matches aren&#x27;t available right now. Try again later.");
    expect(html).not.toContain('data-testid="qm-start"');
    expect(html).not.toContain('action="/api/quick-match"');
  });

  it("the offer cannot be read (the catalog query throws): the same honest line, never a 500", async () => {
    vi.mocked(listQuickMatchSports).mockRejectedValueOnce(new Error("db down"));
    const html = await render("en");
    expect(html).toContain("Quick matches aren&#x27;t available right now.");
    expect(html).not.toContain('data-testid="qm-start"');
  });
});

describe("/<lang>/play: the form", () => {
  it("is a real post to the create route, with the chips, the locale and the Start button (positive pair of Q2)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    expect(html).toContain('action="/api/quick-match"');
    expect(html).toMatch(/method="post"/);
    expect(html).toMatch(field("sport_key", "badminton"));
    expect(html).toMatch(field("sport_key", "boardgame"));
    expect(html).toMatch(field("locale", "en"));
    expect(html).toContain('data-testid="qm-start"');
    expect(html).toContain(">Badminton<");
    expect(html).toContain(">Chess<");
    expect(html).toContain("Each pair plays");
  });

  it("works without the script: the server's Start is not disabled, and the names it posts are required (I1)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    const startTag = html.match(/<button[^>]*data-testid="qm-start"[^>]*>/)?.[0];
    expect(startTag, "the Start button's tag").toBeDefined();
    expect(startTag).not.toContain('disabled="');
    const sides = html.match(/<input[^>]*name="sides"[^>]*>/g) ?? [];
    expect(sides).toHaveLength(2);
    for (const tag of sides) expect(tag).toContain('required="');
    expect(html.match(/<input[^>]*name="name"[^>]*>/)?.[0]).toContain('required="');
  });

  it("clips the glow on its own layer, never on <main>, so the phone Start bar can stick (m6)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    const main = html.match(/<main[^>]*class="([^"]*)"/)?.[1];
    expect(main, "the page's <main>").toBeDefined();
    expect(main!.split(/\s+/)).not.toContain("overflow-hidden");
    expect(html.match(/<div[^>]*data-testid="qm-glow"[^>]*>/)?.[0]).toMatch(/class="[^"]*\boverflow-hidden\b/);
  });

  it("renders no raw dictionary key (every word the island reads was handed over)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    expect(html).not.toMatch(/quickMatch\.|bracket\.round|variant\.|sport\.badminton/);
  });

  it("speaks the page's language: fr chips, fr Start, the fr locale posted", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const [html, fr] = await Promise.all([render("fr"), getDictionary("fr", "marketing")]);
    expect(html).toMatch(field("locale", "fr"));
    expect(html).toContain(String(fr["quickMatch.setup.start"]));
    expect(html).not.toContain(">Start playing<");
  });

  it("is dynamic (no cached render: the offer and ?e= are per request)", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("metadata: the quick match title and the prefixed canonical path", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "en" }) });
    expect(meta.title).toBe("Quick match — keep score with friends");
    expect(meta.alternates?.canonical).toBe("/en/play");
  });
});

describe("/<lang>/play?e=: a refusal read on the server (the no-JS path)", () => {
  it("mounts ClearFlashParam once, with an offer and without one, so the spent ?e= leaves the URL (T6 review m2)", async () => {
    let checked = 0;
    for (const offer of [OFFER, []]) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(offer);
      const root = await PlayPage({ params: Promise.resolve({ lang: "en" }), searchParams: Promise.resolve({ e: "QUICK_MATCH_TOO_MANY_ALIVE" }) });
      let mounted = 0;
      const visit = (node: ReactNode) => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!isValidElement(node)) return;
        const el = node as ReactElement<{ children?: ReactNode }>;
        if (el.type === ClearFlashParam) mounted++;
        visit(el.props.children);
      };
      visit(root);
      expect(mounted, `offer of ${offer.length}`).toBe(1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the per-visitor cap reads its line, with spec §7.9's 5", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en", { e: "QUICK_MATCH_TOO_MANY_ALIVE" });
    expect(html).toContain('data-testid="qm-setup-error"');
    expect(html).toContain("You have 5 quick matches on the go on this device.");
  });

  it("a crafted code reads the generic line; a repeated ?e= reads its first", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    expect(await render("en", { e: "<script>" })).toContain("We couldn&#x27;t start your quick match. Try again.");
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const twice = await render("en", { e: ["QUICK_MATCH_RATE_LIMITED", "QUICK_MATCH_CREATE_FAILED"] });
    expect(twice).toContain("Too many new matches from this network.");
  });

  it("no ?e=, or a blank one: no error line (the positive pair above has one)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    expect(await render("en")).not.toContain('data-testid="qm-setup-error"');
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    expect(await render("en", { e: "  " })).not.toContain('data-testid="qm-setup-error"');
  });

  it("the island is handed a known code or null, never the raw ?e= (m1)", async () => {
    const crafted = "<img src=x onerror=alert(1)>";
    const cases: [Record<string, string | string[]>, string | null][] = [
      [{}, null],
      [{ e: "" }, null],
      [{ e: "   " }, null],
      [{ e: crafted }, QUICK_MATCH_ERRORS.CREATE_FAILED],
      [{ e: "QUICK_MATCH_TOO_MANY_ALIVE" }, QUICK_MATCH_ERRORS.TOO_MANY_ALIVE],
      [{ e: [" QUICK_MATCH_RATE_LIMITED ", crafted] }, QUICK_MATCH_ERRORS.RATE_LIMITED],
    ];
    for (const [search, code] of cases) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      expect((await islandProps(search)).initialError, JSON.stringify(search)).toBe(code);
    }
    // Every code the create route can send survives the trip: the map refuses nothing it should keep.
    const codes = Object.values(QUICK_MATCH_ERRORS);
    for (const c of codes) expect(refusalCode(c)).toBe(c);
    expect(codes.length).toBeGreaterThanOrEqual(10);
  });
});

// The marketing hero's Sport select posts `?sport=<key>` here (owner 2026-11-13, "A, apply rec": the hero's quick match
// start). Every expected key comes from the offer the page reads (OFFER, the stubbed listQuickMatchSports) or from the
// probe's generated offer file, never a list typed here. Boardgame is OFFER's SECOND sport, so a preselected boardgame
// differs from the default the form opens on without one (the ordering-differential case).
describe("/<lang>/play?sport=: the hero's sport, preselected", () => {
  const offered = OFFER.map((s) => s.sport_key);

  it("the empty case first: no ?sport=, or a blank one, hands the island null (it opens on the offer's first)", async () => {
    let checked = 0;
    const searches: Record<string, string | string[]>[] = [{}, { sport: "" }, { sport: "   " }, { sport: [] }];
    for (const search of searches) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      expect((await islandProps(search)).initialSport ?? null, JSON.stringify(search)).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("an offered sport is handed to the island as is; a repeated ?sport= reads its first", async () => {
    let checked = 0;
    for (const key of offered) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      expect((await islandProps({ sport: key })).initialSport, key).toBe(key);
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      expect((await islandProps({ sport: [` ${key} `, "cricket"] })).initialSport, `[${key}, …]`).toBe(key);
      checked++;
    }
    expect(checked, "offered sports checked").toBe(OFFER.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("a sport the offer does not list, an unknown key or garbage: ignored (null), never the raw value", async () => {
    // A catalog sport the probe excludes, and an offered-elsewhere sport this offer lacks (football is in the generated
    // offer but not in OFFER): both are "not on this page's chips".
    const notHere = offerJson.offered.map((o) => o.sport_key).find((k) => !offered.includes(k));
    expect(notHere, "a generated-offer sport missing from OFFER").toBeDefined();
    expect(UNOFFERED_SPORTS.length, "the generated offer excludes at least one whole sport").toBeGreaterThan(0);
    const ignored = [
      ...UNOFFERED_SPORTS,
      notHere!,
      "Badminton", // keys are exact: the canonical funnel name is not a key
      "badminton;drop table sports",
      "<img src=x onerror=alert(1)>",
      "../badminton",
      "nope",
    ];
    let checked = 0;
    for (const raw of ignored) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      expect((await islandProps({ sport: raw })).initialSport ?? null, raw).toBeNull();
      checked++;
    }
    expect(checked).toBe(ignored.length);
    // The pure rule the page asks, over the same inputs: the empty offer lists nothing, so nothing is preselected.
    for (const key of offered) expect(prefillSport(key, []), `${key} with no offer`).toBeNull();
    expect(prefillSport(undefined, OFFER)).toBeNull();
  });

  it("the server's HTML opens on the preselected sport: its chip checked, the others disabled until the script runs (I1)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const plain = await render("en");
    expect(checkedSports(plain), "no ?sport=: the offer's first").toEqual([offered[0]]);
    let checked = 0;
    for (const key of offered) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      const html = await render("en", { sport: key });
      expect(checkedSports(html), key).toEqual([key]);
      expect(disabledSports(html), `${key}: the other chips wait for the script`).toEqual(offered.filter((k) => k !== key));
      checked++;
    }
    expect(checked).toBe(OFFER.length);
    // The preselected sport's own rules and kinds ride with it: boardgame plays one kind (a hidden `kind`), badminton two.
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const boardgame = await render("en", { sport: "boardgame" });
    expect(boardgame).toMatch(/<input[^>]*\btype="hidden"[^>]*\bname="kind"[^>]*\bvalue="individual"/);
    expect(boardgame).toMatch(/<option[^>]*\bvalue="rapid"[^>]*\bselected=""/);
    expect(boardgame).not.toMatch(/<option[^>]*\bvalue="bwf"/);
  });

  it("an ignored ?sport= opens exactly as no ?sport= does", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const plain = await render("en");
    let checked = 0;
    for (const raw of [...UNOFFERED_SPORTS, "nope"]) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      const html = await render("en", { sport: raw });
      expect(checkedSports(html), raw).toEqual(checkedSports(plain));
      expect(html, `${raw} never reaches the page`).not.toContain(`"${raw}"`);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

// Under the Start, a quiet door to the organiser's /start wizard carrying the chosen sport (owner 2026-11-13,
// quick-match-decision-log.md "Or register to start a season"; start wizard plan Task 5). The island test
// (components/quick-match/__tests__/register-season-link.test.tsx) follows the chips and pins where it sits; this is the
// server's HTML, which is the whole page without the script. Expected: the offer's first sport or the `?sport=` read, the
// dictionaries' words, and `/<lang>/start` as /start's parser reads it.
describe("/<lang>/play: the door to a season, under the Start", () => {
  /** Every `qm-register-season` link in the HTML: its href and its text. */
  const doors = (html: string) =>
    [...html.matchAll(/<a\b([^>]*\bdata-testid="qm-register-season"[^>]*)>([^<]*)<\/a>/g)].map((m) => ({
      href: m[1]!.match(/\bhref="([^"]*)"/)?.[1],
      text: m[2]!,
    }));

  it("the empty case first: no offer, no form, no Start, so no door", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce([]);
    const html = await render("en");
    expect(html).not.toContain('data-testid="qm-start"');
    expect(doors(html)).toEqual([]);
  });

  it("once, after the Start, with the offer's first sport and each locale's words (the positive pair)", async () => {
    let checked = 0;
    for (const lang of ["en", "es", "fr", "nl"] as const) {
      vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
      const [html, d] = await Promise.all([render(lang), getDictionary(lang, "marketing")]);
      const found = doors(html);
      expect(found, `${lang}: one door`).toHaveLength(1);
      expect(html, lang).toContain(`href="/${lang}/start?sport=${OFFER[0]!.sport_key}"`);
      expect(found[0]!.text.replace(/&#x27;/g, "'"), lang).toBe(d["quickMatch.setup.registerSeason"]);
      const door = html.search(/data-testid="qm-register-season"/);
      expect(door, `${lang}: after the Start`).toBeGreaterThan(html.search(/data-testid="qm-start"/));
      expect(door, `${lang}: inside the form`).toBeLessThan(html.indexOf("</form>"));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("carries the sport `?sport=` opened the form on, not the offer's first (the ordering differential)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en", { sport: OFFER[1]!.sport_key });
    expect(OFFER[1]!.sport_key, "premise: not the default").not.toBe(OFFER[0]!.sport_key);
    expect(doors(html).map((d) => d.href)).toEqual([`/en/start?sport=${OFFER[1]!.sport_key}`]);
  });
});

describe.skipIf(!HAS_DB)("/<lang>/play over the live offer (real listQuickMatchSports, real offerFor)", () => {
  it("the door under the Start carries every live sport through to /start's parser", async () => {
    const [live, ui] = await Promise.all([listQuickMatchSports(), getDictionary("en", "ui")]);
    const sports = setupSports(live, ui);
    let checked = 0;
    for (const s of sports) {
      const html = await render("en", { sport: s.sport_key });
      const href = html.match(/<a\b[^>]*\bdata-testid="qm-register-season"[^>]*>/)?.[0].match(/\bhref="([^"]*)"/)?.[1];
      expect(href, s.sport_key).toBeDefined();
      const url = new URL(href!, "https://seazn.test");
      expect(url.pathname).toBe("/en/start");
      expect(parseStartPrefill(Object.fromEntries(url.searchParams), "2026-11-13").sportKey, s.sport_key).toBe(s.sport_key);
      checked++;
    }
    expect(checked, "live sports swept").toBe(sports.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("?sport= for every live sport opens the form on it; a sport the offer excludes opens on the default", async () => {
    const [live, ui] = await Promise.all([listQuickMatchSports(), getDictionary("en", "ui")]);
    const sports = setupSports(live, ui);
    let checked = 0;
    for (const s of sports) {
      expect(checkedSports(await render("en", { sport: s.sport_key })), s.sport_key).toEqual([s.sport_key]);
      checked++;
    }
    // Anti-vacuity, and a differential: at least one live sport is not the default the form opens on anyway.
    expect(checked, "live sports swept").toBe(sports.length);
    expect(checked).toBeGreaterThanOrEqual(2);
    let ignored = 0;
    for (const raw of UNOFFERED_SPORTS) {
      expect(checkedSports(await render("en", { sport: raw })), raw).toEqual([sports[0]!.sport_key]);
      ignored++;
    }
    expect(ignored, "excluded sports swept").toBeGreaterThan(0);
  });

  it("every offered sport is a chip, and its default (first kind, preferred rules, two sides, league) is a create the schema and the offer accept", async () => {
    const [live, ui] = await Promise.all([listQuickMatchSports(), getDictionary("en", "ui")]);
    const html = await render("en");
    const sports = setupSports(live, ui);
    let checked = 0;
    for (const s of sports) {
      expect(html, `${s.sport_key} chip`).toMatch(field("sport_key", s.sport_key));
      const body = {
        name: `${s.name} · test`,
        sport_key: s.sport_key,
        variant_key: s.defaultVariant,
        kind: s.kinds[0]!.kind,
        format: "league",
        sides: ["A", "B"],
        plays: 1,
        email: null,
        locale: "en",
      };
      expect(CreateQuickMatch.safeParse(body).success, `${s.sport_key} default body`).toBe(true);
      const offer = await offerFor(s.sport_key, s.defaultVariant);
      expect(offer.offered, `${s.sport_key}/${s.defaultVariant} offered`).toBe(true);
      expect(offer.kinds, `${s.sport_key} kinds`).toContain(body.kind);
      checked++;
    }
    // Anti-vacuity: a DB without `sync:sports` offers nothing, and an empty sweep proves nothing.
    expect(checked, "sports swept").toBeGreaterThan(0);
    expect(checked).toBe(live.length);
  });
});
