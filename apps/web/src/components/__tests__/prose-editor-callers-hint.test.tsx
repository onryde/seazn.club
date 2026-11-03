// Match Day PB3 item 1 — every ProseEditor draws its grey hint.
//
// `placeholder` was only ever the textbox's accessible name; C8 added the opt-in
// `showPlaceholder` that DRAWS it and turned it on for the New competition form.
// The four other editors (org About, payment instructions, the news composer,
// competition settings) pass a placeholder that has never been seen. This pins
// that each one now opts in, with copy that exists in all four locales and reads
// as a hint rather than as a second label.
//
// Two layers, because neither alone is enough (AGENTS.md class 1 and 2):
//   - a SOURCE sweep over every `<ProseEditor` call site in the app, so a fifth
//     editor added later that forgets the opt-in reds here (anti-vacuity: the
//     sweep reports how many it checked and zero is a failure);
//   - the real component driven through the hook harness for each caller, so the
//     prop that reaches ProseEditor is the one the component actually computes
//     from its dictionary, not the one the source text suggests.
// That the hint is PAINTED grey, disappears on typing and is not in the saved
// Markdown is proven in a browser by e2e/walkthrough/match-day-pb3-minors.spec.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ProseEditor } from "@/components/prose-editor";
import { OrgAbout } from "@/components/org-about";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { Composer } from "@/components/news/composer";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn().mockResolvedValue({}) };
});

const en = enUi as unknown as Dict;
const LOCALES = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as Record<string, Record<string, string>>;

/** The hint key each caller reads, from the component's own source. */
const HINT_KEYS = {
  about: "settings.org.about.placeholder",
  payment: "pay.cashPlaceholder",
  news: "news.composer.bodyPlaceholder",
  settings: "compset.descriptionPlaceholder",
} as const;

// ── layer 1: the source sweep ────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sourceFiles(full, out);
    } else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every `<ProseEditor ... />` opening tag's attribute text, with its file. */
function proseEditorCallSites(): { file: string; attrs: string }[] {
  const found: { file: string; attrs: string }[] = [];
  for (const file of sourceFiles(join(__dirname, "..", ".."))) {
    const text = readFileSync(file, "utf8");
    // `<ProseEditor` then everything up to the self-closing `/>` — an attribute
    // value in this repo never contains `/>`.
    for (const m of text.matchAll(/<ProseEditor\b([\s\S]*?)\/>/g)) found.push({ file, attrs: m[1]! });
  }
  return found;
}

describe("every ProseEditor call site draws its hint", () => {
  const sites = proseEditorCallSites();

  it("checked the five known callers (anti-vacuity: zero checked is a failure)", () => {
    // org About, payment instructions, news composer, competition settings, and
    // the New competition form. A sixth editor raises the floor, never lowers it.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("each passes a placeholder AND opts in to drawing it", () => {
    const offenders = sites
      .filter(({ attrs }) => !/\bplaceholder=/.test(attrs) || !/\bshowPlaceholder\b/.test(attrs))
      .map(({ file }) => file.replace(/^.*\/src\//, "src/"));
    expect(offenders).toEqual([]);
  });
});

// ── layer 2: the real components, driven ─────────────────────────────────────

const editorOf = (island: { tree: () => import("react").ReactElement[] }) => {
  const editors = island.tree().filter((el) => el.type === ProseEditor);
  expect(editors).toHaveLength(1);
  return propsOf(editors[0]!);
};

describe("the four editors that never drew a hint now do", () => {
  const cases: [string, () => ReturnType<typeof renderIsland>, string][] = [
    [
      "org About",
      () => renderIsland(OrgAbout, { orgId: "o1", initialValue: null, branding: {} }),
      HINT_KEYS.about,
    ],
    [
      "payment instructions",
      () => renderIsland(OrgPaymentInstructions, { orgId: "o1", initialValue: null }),
      HINT_KEYS.payment,
    ],
    [
      "news composer",
      () => renderIsland(Composer, { orgId: "o1", competitions: [], onDone: () => {} }),
      HINT_KEYS.news,
    ],
    [
      "competition settings",
      () =>
        renderIsland(CompetitionSettings, {
          competition: {
            id: "c1",
            name: "Summer Cup",
            slug: "summer-cup",
            description: null,
            starts_on: "2026-06-01",
            ends_on: "2026-08-31",
            frozen: false,
            visibility: "public",
            status: "draft",
            discoverable: false,
            discovery: {},
            branding: {},
          },
          orgId: "o1",
          canEdit: true,
          discoveryBranding: false,
          viewerPlan: "community",
        }),
      HINT_KEYS.settings,
    ],
  ];

  for (const [label, mount, key] of cases) {
    it(`${label}: opts in, with the catalog's hint for ${key}`, () => {
      const props = editorOf(mount());
      expect(props.showPlaceholder).toBe(true);
      const sentence = t(en, key as never);
      expect(sentence, "the key must exist (t() returns the key on a miss)").not.toBe(key);
      expect(props.placeholder).toBe(sentence);
    });
  }

  it("competition settings read-only (frozen) mounts no editor, so there is no hint to draw", () => {
    // The negative pair: the opt-in lives on the editable branch only.
    const island = renderIsland(CompetitionSettings, {
      competition: {
        id: "c1", name: "Summer Cup", slug: "summer-cup", description: null,
        starts_on: "2026-06-01", ends_on: "2026-08-31", frozen: true, visibility: "public",
        status: "draft", discoverable: false, discovery: {}, branding: {},
      },
      orgId: "o1", canEdit: true, discoveryBranding: false, viewerPlan: "community",
    });
    expect(island.tree().filter((el) => el.type === ProseEditor)).toHaveLength(0);
  });
});

// ── layer 3: the copy ────────────────────────────────────────────────────────

describe("the hint copy exists in all four locales and reads as a hint", () => {
  const keys = Object.values(HINT_KEYS);

  it("checked every key in every locale (anti-vacuity)", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of keys) {
        expect(dict[key], `${locale} ${key}`).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(LOCALES).length * keys.length);
  });

  it("is translated: no non-English locale repeats the English sentence", () => {
    for (const key of keys) {
      for (const locale of ["es", "fr", "nl"]) {
        expect(LOCALES[locale]![key], `${locale} ${key}`).not.toBe(LOCALES.en![key]);
      }
    }
  });

  it("the About and Settings hints are sentences that tell people what to write, not a restated label", () => {
    // The old copy was "About your organisation" / "Competition description": a
    // second label, drawn grey under a heading that already says it. A hint
    // names what goes in the box, so it is longer than a label and ends the
    // thought with a stop or an ellipsis.
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of [HINT_KEYS.about, HINT_KEYS.settings]) {
        const s = dict[key]!;
        expect(s.length, `${locale} ${key} is a label, not a hint: "${s}"`).toBeGreaterThanOrEqual(40);
        expect(/[.…]$/.test(s), `${locale} ${key} should end the sentence: "${s}"`).toBe(true);
      }
    }
  });

  it("the payment example keeps {{reference}} verbatim and is several lines in every locale", () => {
    // `{{reference}}` is the literal token the organiser types into their
    // instructions (the server swaps in each registrant's reference), so a
    // translation that localised or dropped it would teach the wrong thing.
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const s = dict[HINT_KEYS.payment]!;
      expect(s, locale).toContain("{{reference}}");
      expect(s.split("\n").length, `${locale} should be a multi-line example`).toBeGreaterThanOrEqual(4);
    }
  });
});
