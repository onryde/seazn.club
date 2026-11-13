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
import { refusalCode, setupSports } from "../play/setup-props";
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

  it("ships the Format list (plan 5 T6): one `shape` radio, League, chosen, at the two sides it opens on; no `format` field", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    const shapes = html.match(/<input[^>]*name="shape"[^>]*>/g) ?? [];
    expect(shapes, "two sides: League alone (spec §12)").toHaveLength(1);
    expect(shapes[0]).toMatch(/value="league"/);
    expect(shapes[0], "chosen, so the plain post sends it").toContain('checked="');
    expect(html, "no format field: one radio, one fact").not.toMatch(/name="format"/);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain(">Format<");
    // The old League-only line is gone: the row's hint says it, and "Top of the table wins" is false for a knockout.
    expect(html).not.toContain('data-testid="qm-league-help"');
  });

  it("hands the island each rules' C23 knockoutAllowed as the offer says it, both ways (the list reads it, never a default)", async () => {
    const mixed: QuickMatchSport[] = [
      {
        ...OFFER[0]!,
        variants: [
          { variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: false },
          { variant_key: "bwf-3x15", labelKey: "variant.badminton.bwf3x15", knockoutAllowed: true },
        ],
      },
      OFFER[1]!,
    ];
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(mixed);
    const props = await islandProps({});
    const seen = props.sports.flatMap((sp) => sp.variants.map((v) => [sp.sport_key, v.key, v.knockoutAllowed]));
    expect(seen).toEqual([
      ["badminton", "bwf", false],
      ["badminton", "bwf-3x15", true],
      ["boardgame", "rapid", true],
    ]);
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

describe.skipIf(!HAS_DB)("/<lang>/play over the live offer (real listQuickMatchSports, real offerFor)", () => {
  it("every offered sport is a chip, and its default (first kind, preferred rules, two sides, league) is a create the schema and the offer accept", async () => {
    const [live, ui] = await Promise.all([listQuickMatchSports(), getDictionary("en", "ui")]);
    const html = await render("en");
    const sports = setupSports(live, ui);
    let checked = 0;
    let variants = 0;
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
      // The Format list reads each rules' C23 answer (plan 5 T6): the island is handed exactly what the create's guard asks.
      for (const v of s.variants) {
        expect(v.knockoutAllowed, `${s.sport_key}/${v.key} knockoutAllowed`).toBe((await offerFor(s.sport_key, v.key)).knockoutAllowed);
        variants++;
      }
      checked++;
    }
    expect(variants, "rules swept").toBeGreaterThanOrEqual(checked);
    // Anti-vacuity: a DB without `sync:sports` offers nothing, and an empty sweep proves nothing.
    expect(checked, "sports swept").toBeGreaterThan(0);
    expect(checked).toBe(live.length);
  });
});
