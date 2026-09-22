// The entrants row's ACTION SET, in all four locales.
//
// Found in review (2026-09-22): the row's Delete button and the `title` that
// explains why it is only sometimes there were HARDCODED ENGLISH, in no
// dictionary at all. The sweep that fixed Delete found five more in the same
// block, and the owner ruled the half-fix worse than the original: a Spanish
// console reading "Withdraw | Eliminar" on one row is a defect the uniformly
// English row did not have. So the whole set moves together.
//
// This file covers the controls a customer meets on the COLLAPSED row —
// Withdraw / Reinstate / Delete and the seed field's accessible name.
// `entrants-panel-row-expanded-i18n.test.tsx` covers the two behind the
// disclosure, which `renderToStaticMarkup` cannot press.
//
// It also had a SECOND consequence, which is why each translation ships with
// its spec: three Playwright specs located these controls by the English word
// — `swiss-pre-start-field-change.spec.ts` (Delete),
// `withdrawn-entrant-organiser.spec.ts` (Withdraw) and `mobile.spec.ts` (the
// seed input's aria-label) — and two of them honestly said so in a comment.
// A naive dictionary fix breaks them silently. Each is now on a testid.
//
// Rendered rather than key-checked: a dictionary entry nothing reads is the
// inert seam this repo keeps paying for (AGENTS.md 1). These assertions fold
// the real dictionary through the real component and read what the row would
// actually paint, which is the only thing that can tell a wired key from a
// declared one. `renderToStaticMarkup` runs no effects, so the panel draws
// from its `entrants` prop — exactly the roster the page hands it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: vi.fn(async () => ({ items: [], nextCursor: null })) };
});

const DICTS: Record<Locale, Dict> = { en, fr, es, nl };

/** The stable handles the Playwright specs click. Named here so a rename has
 *  to move this constant and the e2e's own copy together. */
const TESTID = {
  delete: "entrant-row-delete",
  withdraw: "entrant-row-withdraw",
  reinstate: "entrant-row-reinstate",
  seed: "entrant-row-seed",
} as const;

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};

const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "individual",
  squadNumbers: true,
  captain: true,
  maxTeamMembers: null,
};

// A realistically long name, not "Bob": the seed field's accessible name
// INTERPOLATES it, so a short one cannot tell a working `{name}` from a
// dropped one.
const ENTRANT = {
  id: "e1",
  kind: "individual",
  team_id: null,
  display_name: "Ada Lovelace",
  seed: null,
  status: "registered",
  badge_url: null,
};

const WITHDRAWN = { ...ENTRANT, status: "withdrawn" };

function panelHtml(locale: Locale, over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <EntrantsPanel
        divisionId="div-1"
        entrants={[ENTRANT]}
        canEdit
        positionGroups={[]}
        roles={[]}
        eligibility={NO_ELIGIBILITY}
        entrantModel={MODEL}
        viewerPlan="community"
        divisionStatus="setup"
        {...over}
      />
    </DictProvider>,
  );
}

/** React escapes `&<>"'` into entities on the way out; the dictionary holds the
 *  characters themselves (French apostrophes, most of all). Comparing raw
 *  markup against the dict would fail on punctuation rather than on copy. */
function decode(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A control as a customer meets it: its visible word, and the `title`/
 *  `aria-label` a tooltip or a screen reader would announce. */
function control(html: string, testid: string): { label: string; title: string; aria: string } {
  const m = new RegExp(`<(?:button|input)([^>]*data-testid="${testid}"[^>]*)(?:/>|>([\\s\\S]*?)</button>)`).exec(html);
  expect(m, `no [data-testid="${testid}"] on the entrant row`).not.toBeNull();
  const attrs = m![1]!;
  const pick = (name: string): string => {
    const a = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return a ? decode(a[1]!) : "";
  };
  return {
    label: decode((m![2] ?? "").replace(/<[^>]*>/g, "").trim()),
    title: pick("title"),
    aria: pick("aria-label"),
  };
}

const value = (d: Dict, key: string): string | undefined => (d as Record<string, string>)[key];

/** Every locale carries the key, and no two share a value — the shape a string
 *  left in English cannot produce. Shared by every row below. */
function expectFourDistinct(key: string, vars?: Record<string, string>): void {
  const values = LOCALES.map((l) => (vars ? t(DICTS[l], key, vars) : value(DICTS[l], key)));
  for (const [i, v] of values.entries()) {
    expect(v, `${LOCALES[i]} is missing ${key}`).toBeTruthy();
    expect(v, `${LOCALES[i]} renders ${key} as the key itself — it is not in that catalogue`).not.toBe(key);
  }
  expect(new Set(values).size, `two locales share ${key} — one was left in English`).toBe(LOCALES.length);
}

describe("the entrants row's controls read from the dictionary, not hardcoded words", () => {
  // The positive pair for every negative below: the row really did render, so
  // an empty page cannot satisfy anything here.
  it("renders the roster row it is asked to render", () => {
    expect(panelHtml("en")).toContain(ENTRANT.display_name);
  });

  it.each(LOCALES)("%s paints the locale's own Delete label and policy tooltip", (locale) => {
    const { label, title } = control(panelHtml(locale), TESTID.delete);
    expect(label, `${locale} renders a Delete label that is not entrants.row.delete`).toBe(
      value(DICTS[locale], "entrants.row.delete"),
    );
    expect(title, `${locale} renders a tooltip that is not entrants.row.deleteHint`).toBe(
      value(DICTS[locale], "entrants.row.deleteHint"),
    );
  });

  it.each(LOCALES)("%s paints the locale's own Withdraw label", (locale) => {
    expect(control(panelHtml(locale), TESTID.withdraw).label).toBe(
      value(DICTS[locale], "entrants.row.withdraw"),
    );
  });

  it.each(LOCALES)("%s paints the locale's own Reinstate label on a withdrawn entrant", (locale) => {
    const html = panelHtml(locale, { entrants: [WITHDRAWN] });
    // Positive pair: the withdrawn row rendered, and it swapped the control —
    // without this an absent Withdraw would satisfy nothing and prove nothing.
    expect(html).toContain(WITHDRAWN.display_name);
    expect(html, "a withdrawn entrant is still being offered Withdraw").not.toContain(
      `data-testid="${TESTID.withdraw}"`,
    );
    expect(control(html, TESTID.reinstate).label).toBe(value(DICTS[locale], "entrants.row.reinstate"));
  });

  // The seed field has no visible label at all — its accessible name IS the
  // label, so leaving it English left every non-English screen-reader user with
  // an unlabelled number box. It interpolates the entrant, so the assertion is
  // against the INTERPOLATED sentence, not the raw pattern.
  it.each(LOCALES)("%s names the seed field for the entrant it belongs to", (locale) => {
    const { aria } = control(panelHtml(locale), TESTID.seed);
    expect(aria).toBe(t(DICTS[locale], "entrants.row.seedLabel", { name: ENTRANT.display_name }));
    expect(aria, `${locale}'s seed label does not name the entrant`).toContain(ENTRANT.display_name);
    // A pattern that kept its placeholder would still "contain the name" if the
    // name were "{name}", and would still be truthy. Pin the placeholder gone.
    expect(aria, `${locale} left {name} uninterpolated`).not.toContain("{name}");
  });

  // The witness. Four locales, four different words — the shape the defect
  // could not produce, because a hardcoded literal renders the SAME English in
  // all four.
  it.each([
    ["entrants.row.delete", TESTID.delete, "label"],
    ["entrants.row.deleteHint", TESTID.delete, "title"],
    ["entrants.row.withdraw", TESTID.withdraw, "label"],
  ] as const)("%s renders four different strings across the four locales", (_key, testid, field) => {
    const seen = LOCALES.map((l) => control(panelHtml(l), testid)[field]);
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });

  it("Reinstate renders four different strings across the four locales", () => {
    const seen = LOCALES.map((l) => control(panelHtml(l, { entrants: [WITHDRAWN] }), TESTID.reinstate).label);
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });

  it("the seed field's accessible name differs in all four locales", () => {
    const seen = LOCALES.map((l) => control(panelHtml(l), TESTID.seed).aria);
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });

  // A key present in `en` and missing from `nl` renders as the KEY itself
  // (`t()` falls back to the key rather than throwing), which is uglier than
  // English — so every key is pinned in every catalogue.
  it("every collapsed-row key ships in all four catalogues, none left on English", () => {
    for (const key of [
      "entrants.row.delete",
      "entrants.row.deleteHint",
      "entrants.row.withdraw",
      "entrants.row.reinstate",
    ]) {
      expectFourDistinct(key);
    }
    expectFourDistinct("entrants.row.seedLabel", { name: ENTRANT.display_name });
  });

  // `deletable={divisionStatus === "setup"}` — the control is the tooltip's own
  // claim made true. Without this row the tooltip would be decoration.
  it("offers no delete control once the division has left setup", () => {
    const started = panelHtml("en", { divisionStatus: "active" });
    expect(started, "the roster row did not render at all").toContain(ENTRANT.display_name);
    expect(started).not.toContain(`data-testid="${TESTID.delete}"`);
    // Withdraw survives a started division — it is the only removal path left,
    // and a test that only checked Delete's absence would pass on a row that
    // had lost both.
    expect(started).toContain(`data-testid="${TESTID.withdraw}"`);
  });

  it("offers no row controls to a viewer who cannot edit", () => {
    const spectator = panelHtml("en", { canEdit: false });
    expect(spectator, "the roster row did not render at all").toContain(ENTRANT.display_name);
    for (const id of Object.values(TESTID)) {
      expect(spectator, `${id} is offered to a spectator`).not.toContain(`data-testid="${id}"`);
    }
  });
});
