// The entrants row's DELETE control, in all four locales.
//
// Found in review (2026-09-22): the row's Delete button and the `title` that
// explains why it is only sometimes there were HARDCODED ENGLISH, in no
// dictionary at all — so an organiser on the Spanish, French or Dutch console
// read one English word in the middle of a translated table, and a tooltip
// that said nothing to them.
//
// It also had a SECOND consequence, which is the reason it is fixed as one
// change rather than two: `e2e/walkthrough/swiss-pre-start-field-change.spec.ts`
// located the control by that English literal, and honestly said so in a
// comment. A naive dictionary fix would have left the walkthrough clicking a
// string the product no longer renders. The button now carries
// `data-testid="entrant-row-delete"` and the spec keys on that instead.
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

const DELETE_KEY = "entrants.row.delete";
const HINT_KEY = "entrants.row.deleteHint";

/** The stable handle the walkthrough clicks. Named here so a rename has to
 *  move this constant, and the e2e's own copy, together. */
const DELETE_TESTID = "entrant-row-delete";

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

const ENTRANT = {
  id: "e1",
  kind: "individual",
  team_id: null,
  display_name: "Ada Lovelace",
  seed: null,
  status: "registered",
  badge_url: null,
};

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

/** The row's delete control as a customer meets it: its visible word and the
 *  tooltip that explains when it is offered. */
function deleteControl(html: string): { label: string; title: string } {
  const m = new RegExp(`<button([^>]*data-testid="${DELETE_TESTID}"[^>]*)>([\\s\\S]*?)</button>`).exec(html);
  expect(m, `no [data-testid="${DELETE_TESTID}"] control on the entrant row`).not.toBeNull();
  const title = /title="([^"]*)"/.exec(m![1]!);
  expect(title, "the delete control carries no title — the policy tooltip is gone").not.toBeNull();
  return {
    label: decode(m![2]!.replace(/<[^>]*>/g, "").trim()),
    title: decode(title![1]!),
  };
}

const value = (d: Dict, key: string): string | undefined => (d as Record<string, string>)[key];

describe("the entrants row's Delete control reads from the dictionary, not a hardcoded word", () => {
  // The positive pair for every negative below: the row really did render, so
  // an empty page cannot satisfy anything here.
  it("renders the roster row it is asked to render", () => {
    expect(panelHtml("en")).toContain(ENTRANT.display_name);
  });

  it.each(LOCALES)("%s paints the locale's own Delete label and policy tooltip", (locale) => {
    const { label, title } = deleteControl(panelHtml(locale));
    const dict = DICTS[locale];
    expect(label, `${locale} renders a Delete label that is not ${DELETE_KEY}`).toBe(value(dict, DELETE_KEY));
    expect(title, `${locale} renders a tooltip that is not ${HINT_KEY}`).toBe(value(dict, HINT_KEY));
  });

  // The witness. Four locales, four different words on the button and four
  // different tooltips — the shape the defect could not produce, because a
  // hardcoded literal renders the SAME English in all four.
  it("the four locales render four different Delete labels, and four different tooltips", () => {
    const labels = LOCALES.map((l) => deleteControl(panelHtml(l)).label);
    const titles = LOCALES.map((l) => deleteControl(panelHtml(l)).title);
    expect(new Set(labels).size, `labels were ${JSON.stringify(labels)}`).toBe(LOCALES.length);
    expect(new Set(titles).size, `tooltips were ${JSON.stringify(titles)}`).toBe(LOCALES.length);
  });

  // A key that exists in `en` and is missing from `nl` renders as the KEY
  // itself (t() falls back to the key, never throws), which is a different and
  // uglier failure than English — so both keys are pinned in every catalogue.
  it("both keys ship in all four catalogues, with no locale left on the English string", () => {
    for (const key of [DELETE_KEY, HINT_KEY]) {
      const values = LOCALES.map((l) => value(DICTS[l], key));
      for (const [i, v] of values.entries()) {
        expect(v, `${LOCALES[i]} is missing ${key}`).toBeTruthy();
      }
      expect(new Set(values).size, `two locales share ${key} — one was left in English`).toBe(LOCALES.length);
    }
  });

  // `deletable={divisionStatus === "setup"}` — the control is the tooltip's own
  // claim made true. Without this row the tooltip would be decoration.
  it("offers no delete control once the division has left setup", () => {
    const started = panelHtml("en", { divisionStatus: "active" });
    expect(started, "the roster row did not render at all").toContain(ENTRANT.display_name);
    expect(started).not.toContain(`data-testid="${DELETE_TESTID}"`);
  });

  it("offers no delete control to a viewer who cannot edit", () => {
    const spectator = panelHtml("en", { canEdit: false });
    expect(spectator, "the roster row did not render at all").toContain(ENTRANT.display_name);
    expect(spectator).not.toContain(`data-testid="${DELETE_TESTID}"`);
  });
});
