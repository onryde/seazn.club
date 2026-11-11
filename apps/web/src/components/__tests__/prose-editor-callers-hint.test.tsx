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
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ProseEditor, textboxName } from "@/components/prose-editor";
import { OrgProfileCard } from "@/components/org-profile-card";
import { expandSettingsCard } from "@/components/v2/__tests__/_settings-card-expand";
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

/** The key of the on-screen copy that labels each box: its accessible name (PB3 review C1). Reused from the existing field labels. */
const LABEL_KEYS = {
  about: "settings.org.about",
  payment: "pay.cashTitle",
  news: "news.composer.body",
  settings: "compset.description",
} as const;

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

  it("each that draws the hint also names its box with `label` (the hint is not the accessible name)", () => {
    const drawing = sites.filter(({ attrs }) => /\bshowPlaceholder\b/.test(attrs));
    expect(drawing.length, "anti-vacuity: the five known callers draw a hint").toBeGreaterThanOrEqual(5);
    const offenders = drawing.filter(({ attrs }) => !/\blabel=/.test(attrs)).map(({ file }) => file.replace(/^.*\/src\//, "src/"));
    expect(offenders).toEqual([]);
  });
});

// ── layer 2: the real components, driven ─────────────────────────────────────

type Mounted = { tree: () => ReactElement[] };

const editorOf = (island: Mounted) => {
  const editors = island.tree().filter((el) => el.type === ProseEditor);
  expect(editors).toHaveLength(1);
  return propsOf(editors[0]!);
};

describe("the four editors that never drew a hint now do", () => {
  const cases: [string, () => Mounted, string, string][] = [
    [
      // Settings C8 (owner 2026-11-11): the About editor lives in the Organisation card now. The card passes its
      // columns as props, so the tree is expanded through the frame — without it the editor is invisible and
      // `editorOf`'s length-1 check would red on a zero, never pass on one.
      "org About",
      () =>
        renderIsland(
          OrgProfileCard,
          {
            orgId: "o1",
            orgSlug: "riverside",
            initialName: "Riverside",
            initialBranding: {},
            initialAbout: null,
            canEdit: true,
            brandGate: { locked: false },
          },
          expandSettingsCard,
        ),
      HINT_KEYS.about,
      LABEL_KEYS.about,
    ],
    [
      "payment instructions",
      () => renderIsland(OrgPaymentInstructions, { orgId: "o1", initialValue: null }),
      HINT_KEYS.payment,
      LABEL_KEYS.payment,
    ],
    [
      "news composer",
      () => renderIsland(Composer, { orgId: "o1", competitions: [], onDone: () => {} }),
      HINT_KEYS.news,
      LABEL_KEYS.news,
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
        }, expandSettingsCard),
      HINT_KEYS.settings,
      LABEL_KEYS.settings,
    ],
  ];

  for (const [label, mount, key, labelKey] of cases) {
    it(`${label}: opts in, with the catalog's hint for ${key}`, () => {
      const props = editorOf(mount());
      expect(props.showPlaceholder).toBe(true);
      const sentence = t(en, key as never);
      expect(sentence, "the key must exist (t() returns the key on a miss)").not.toBe(key);
      expect(props.placeholder).toBe(sentence);
    });

    // PB3 review C1: drawing the hint stops it being the accessible name, so each box names ITSELF - with the copy that labels it on
    // screen - and not with the generic "Description" (a screen reader announced the payment box and the news body as that).
    it(`${label}: the box is named by its own label ${labelKey}, never the generic "Description"`, () => {
      const props = editorOf(mount());
      const name = t(en, labelKey as never);
      expect(name, "the label key must exist").not.toBe(labelKey);
      expect(props.label).toBe(name);
      expect(props.label, "the hint is not the name").not.toBe(props.placeholder);
      // The generic fallback is for a box that names nothing; only competition settings' OWN label happens to read the same.
      if (labelKey !== LABEL_KEYS.settings) expect(props.label).not.toBe(t(en, "editor.description"));
    });
  }

  it("the four labels are four different names (a sweep: zero checked is a failure)", () => {
    const names = Object.values(LABEL_KEYS).map((k) => t(en, k as never));
    expect(names).toHaveLength(4);
    expect(new Set(names).size, `the boxes share a name: ${names.join(" | ")}`).toBe(4);
  });

  it("competition settings read-only (frozen) mounts no editor, so there is no hint to draw", () => {
    // The negative pair: the opt-in lives on the editable branch only.
    const island = renderIsland(CompetitionSettings, {
      competition: {
        id: "c1", name: "Summer Cup", slug: "summer-cup", description: null,
        starts_on: "2026-06-01", ends_on: "2026-08-31", frozen: true, visibility: "public",
        status: "draft", discoverable: false, discovery: {}, branding: {},
      },
      orgId: "o1", canEdit: true, discoveryBranding: false, viewerPlan: "community",
    }, expandSettingsCard);
    // Expanded through the C8 frame, so "no editor" is measured where the editor would be: the read-only box is there.
    expect(island.tree().filter((el) => el.type === "textarea")).toHaveLength(1);
    expect(island.tree().filter((el) => el.type === ProseEditor)).toHaveLength(0);
  });
});

// ── the accessible name's precedence ─────────────────────────────────────────

describe("textboxName: an explicit label is the name; the hint is not", () => {
  it("label wins over the placeholder, with the hint drawn or not", () => {
    expect(textboxName({ label: "Story", placeholder: "Write the report…", showPlaceholder: true }, "Description")).toBe("Story");
    expect(textboxName({ label: "Story", placeholder: "Write the report…", showPlaceholder: false }, "Description")).toBe("Story");
  });

  it("no label: the hint drawn falls back to the generic name; the hint not drawn keeps the placeholder as the name (as it always was)", () => {
    expect(textboxName({ placeholder: "Write the report…", showPlaceholder: true }, "Description")).toBe("Description");
    expect(textboxName({ placeholder: "Write the report…", showPlaceholder: false }, "Description")).toBe("Write the report…");
    expect(textboxName({ showPlaceholder: false }, "Description")).toBe("Description");
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
