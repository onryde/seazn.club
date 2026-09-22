// The entrants TABLE's own chrome — its header row and its empty state.
//
// The 2026-09-22 sweep translated the row's controls and left the table they
// sit in alone, which put translated buttons under English column headers:
// "Entrant / Kind / Seed / Status / Actions" above a row whose every control
// spoke Spanish. Same complaint as the half-translated row, one level up.
//
// VOCABULARY IS PINNED TO ITS NEIGHBOUR, NOT TYPED INTO THIS TEST. Each header
// must read the same word the console already uses for that column elsewhere,
// so a locale left on English reds — and, more usefully, so the day somebody
// changes one of those neighbours this file reds instead of letting two tables
// in the same console drift onto different words for the same column. That is
// AGENTS.md 19: derive the expected value from the source of truth rather than
// freezing today's string in an assertion.
//
// ONE HONEST HOLE, stated rather than papered over: `entrants.table.status` is
// "Status" in BOTH en and nl, because that IS the Dutch word (the registrants
// table already ships it). So "nl was left on the English string" is not
// detectable for that one key, and no assertion here pretends otherwise.
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
const value = (d: Dict, key: string): string | undefined => (d as Record<string, string>)[key];

/** Each header, and the key whose word it must match. The right-hand side is
 *  the console's existing vocabulary for that column:
 *    entrant — the progression panel's own entrant column
 *    kind    — THIS panel's add-form label, so the column and the field that
 *              fills it never disagree (nl says "Soort", not the registration
 *              hub's "Type")
 *    seed    — the progression panel's rank column
 *    status  — the registrants table
 *    actions — the persons table
 */
const HEADER_SOURCE: [key: string, neighbour: string][] = [
  ["entrants.table.entrant", "progression.entrantHeader"],
  ["entrants.table.kind", "entrants.add.kind"],
  ["entrants.table.seed", "progression.rankHeader"],
  ["entrants.table.status", "reg.hub.registrants.table.status"],
  ["entrants.table.actions", "persons.col.actions"],
];

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

function decode(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The header row's cells, in render order — the thing a customer reads across
 *  the top of the table. */
function headers(html: string): string[] {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(html);
  expect(head, "the entrants table rendered no header row at all").not.toBeNull();
  return [...head![1]!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    decode(m[1]!.replace(/<[^>]*>/g, "").trim()),
  );
}

/** The text of the table's empty-state cell, or null when rows were rendered. */
function emptyCell(html: string): string | null {
  const m = /data-testid="entrants-table-empty"[^>]*>([\s\S]*?)<\/td>/.exec(html);
  return m ? decode(m[1]!.replace(/<[^>]*>/g, "").trim()) : null;
}

describe("the entrants table's header row is translated, not English under translated rows", () => {
  it("renders five headers when the viewer can edit, four when they cannot", () => {
    // The positive pair for everything below: the table really rendered, and
    // the Actions column really is the editor-only one.
    expect(headers(panelHtml("en"))).toHaveLength(5);
    expect(headers(panelHtml("en", { canEdit: false }))).toHaveLength(4);
  });

  it.each(LOCALES)("%s paints every header from its own catalogue", (locale) => {
    const painted = headers(panelHtml(locale));
    const expected = HEADER_SOURCE.map(([key]) => value(DICTS[locale], key));
    expect(painted).toEqual(expected);
  });

  it.each(LOCALES)("%s uses the console's existing word for each column", (locale) => {
    for (const [key, neighbour] of HEADER_SOURCE) {
      const mine = value(DICTS[locale], key);
      const theirs = value(DICTS[locale], neighbour);
      expect(theirs, `${neighbour} has vanished — this pin needs a new source`).toBeTruthy();
      expect(mine, `${locale}: ${key} says ${JSON.stringify(mine)}, but this console already calls that column ${JSON.stringify(theirs)} (${neighbour})`).toBe(theirs);
    }
  });

  // Not every header legitimately differs across four locales ("Status" is the
  // Dutch word too), so distinctness is asserted per-key against what the
  // NEIGHBOUR manages — never against a flat 4, which would force a wrong
  // translation to satisfy the test.
  it.each(HEADER_SOURCE)("%s is as distinct across locales as %s is", (key, neighbour) => {
    const mine = new Set(LOCALES.map((l) => value(DICTS[l], key))).size;
    const theirs = new Set(LOCALES.map((l) => value(DICTS[l], neighbour))).size;
    expect(mine).toBe(theirs);
    // And at least one locale must differ from English, or the key is untested
    // decoration whichever way the neighbour goes.
    expect(mine, `${key} reads identically in all four locales`).toBeGreaterThan(1);
  });
});

describe("the entrants table's empty state is translated", () => {
  it("says nothing when there are rows, and speaks up when there are none", () => {
    expect(emptyCell(panelHtml("en")), "an empty-state cell rendered beside real rows").toBeNull();
    const empty = panelHtml("en", { entrants: [] });
    expect(emptyCell(empty), "an empty roster showed no empty state at all").toBeTruthy();
    expect(empty, "the row that should be absent is still there").not.toContain(ENTRANT.display_name);
  });

  it.each(LOCALES)("%s paints the empty roster line from its own catalogue", (locale) => {
    expect(emptyCell(panelHtml(locale, { entrants: [] }))).toBe(
      value(DICTS[locale], "entrants.table.empty"),
    );
  });

  it("the four locales render four different empty-roster lines", () => {
    const seen = LOCALES.map((l) => emptyCell(panelHtml(l, { entrants: [] })));
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });

  // The club-filtered branch of the same cell needs the club <select>, which
  // needs a clubs fetch, which needs effects — so it is WITNESSED RENDERING in
  // `entrants-panel-enroll-prose-i18n.test.tsx` under the hook harness, and
  // only its catalogue coverage is pinned here.
  it("both empty-state keys ship in all four catalogues, none left on English", () => {
    for (const key of ["entrants.table.empty", "entrants.table.emptyForClub"]) {
      const values = LOCALES.map((l) => value(DICTS[l], key));
      for (const [i, v] of values.entries()) {
        expect(v, `${LOCALES[i]} is missing ${key}`).toBeTruthy();
      }
      expect(new Set(values).size, `two locales share ${key} — one was left in English`).toBe(
        LOCALES.length,
      );
    }
  });
});
