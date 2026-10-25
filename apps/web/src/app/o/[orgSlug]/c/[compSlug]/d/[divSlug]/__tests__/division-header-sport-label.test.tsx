// Owner staging test 2026-10-19: a chess division's header read "Boardgame · classical". The chip printed the RAW
// sport and variant keys, and CSS `.chip { text-transform: capitalize }` made the key look like a label. The key
// `boardgame` stays everywhere internal (engine, DB, event types, URLs); only the WORD changes, and it comes from the
// dictionaries — `sport.<key>` through `sportLabel`, the variant through `variant.<sport>.<variant>`.
//
// Same scaffold as online-chess-flag-wiring.test.tsx beside it (no jsdom, the async server component called directly,
// its returned tree walked) with one difference that matters here: `@/lib/i18n` is REAL, so the chip carries the
// dictionaries' own words and the expected text is read from the same JSON the app ships — never typed into the test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "es" | "fr" | "nl",
  sport_key: "boardgame",
  variant_key: "classical",
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => state.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "setup",
    sport_key: state.sport_key,
    variant_key: state.variant_key,
    module_version: "1.0.0",
    config: {},
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
    camera_policy: null,
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({ divisionConsumesSlotOnArchive: vi.fn(async () => false) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
  })),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});

import DivisionPage from "../page";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const DICT = {
  en: uiEn as Record<string, string>,
  es: uiEs as Record<string, string>,
  fr: uiFr as Record<string, string>,
  nl: uiNl as Record<string, string>,
} as const;
const LOCALES = Object.keys(DICT) as (keyof typeof DICT)[];

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const renderPage = (tab = "entrants") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

function findAll(node: ReactNode, match: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (match(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, match, out);
  return out;
}

/** The header's format chip, rendered the way the browser receives it. `.chip` is the class the owner saw
 *  capitalise a raw key; the header's is the only bare `chip` span the page renders at the top of a division. */
async function headerChipHtml(): Promise<string> {
  const chips = findAll(await renderPage(), (el) => el.type === "span" && (el.props as { className?: string }).className === "chip");
  expect(chips, "exactly one bare format chip in the header").toHaveLength(1);
  return renderToStaticMarkup(chips[0]!);
}

beforeEach(() => {
  state.locale = "en";
  state.sport_key = "boardgame";
  state.variant_key = "classical";
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
});

describe("division header: the sport and variant are WORDS, not the stored keys", () => {
  it("a chess division reads the dictionary's sport and variant words in every locale — never the key", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      state.locale = locale;
      const sport = DICT[locale]["sport.boardgame"]!;
      const variant = DICT[locale]["variant.boardgame.classical"]!;
      expect(sport, `${locale}: the dictionary has a sport word`).toBeTruthy();
      expect(variant, `${locale}: the dictionary has a variant word`).toBeTruthy();
      const html = await headerChipHtml();
      // Anchored on the tag's `>`: the raw key must not open the chip, and the chip must open with the word.
      expect(html, locale).toBe(`<span class="chip">${sport} · ${variant}</span>`);
      expect(html, `${locale}: the raw key does not open the chip`).not.toContain(">boardgame");
      expect(html, `${locale}: the raw variant key is not printed`).not.toContain("· classical");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("another sport takes the same path (the label is not chess-special-cased)", async () => {
    state.sport_key = "generic";
    state.variant_key = "score";
    let checked = 0;
    for (const locale of LOCALES) {
      state.locale = locale;
      const html = await headerChipHtml();
      expect(html, locale).toBe(
        `<span class="chip">${DICT[locale]["sport.generic"]} · ${DICT[locale]["variant.generic.score"]}</span>`,
      );
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the empty case: a variant nobody names falls back to its stored key, beside the sport word", async () => {
    state.variant_key = "my-house-rules";
    const html = await headerChipHtml();
    expect(html).toBe(`<span class="chip">${DICT.en["sport.boardgame"]} · my-house-rules</span>`);
  });

  it("the word chess people read is Chess, in each locale's own spelling — not the old 'Board game'", () => {
    // Guards the dictionary value itself (the owner's ruling is a word, so a stray revert of one locale reds here).
    // The expected words are the owner's, taken from the 2026-10-19 approval; the header test above reads the JSON.
    expect(DICT.en["sport.boardgame"]).toBe("Chess");
    expect(DICT.es["sport.boardgame"]).toBe("Ajedrez");
    expect(DICT.fr["sport.boardgame"]).toBe("Échecs");
    expect(DICT.nl["sport.boardgame"]).toBe("Schaken");
  });
});
