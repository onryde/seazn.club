// The enroll form's squad-preview prose, and the club-filtered empty state.
//
// THE DEFECT THIS EXISTS FOR. The empty-squad warning tells the organiser to
// "enroll now and use “Sync from team squad” later" — it NAMES A CONTROL. Once
// that control was translated (2026-09-22) the sentence pointed at a button
// that no longer existed on a Spanish console: it says "Sincronizar desde la
// plantilla del equipo". Instructions naming a control the reader cannot see
// are a functional mismatch, not a cosmetic one.
//
// The repair is not to translate the button's name as a second fragment. Four
// locales put it in four different places in the sentence — Dutch ends on
// "gebruik later “…”", French wants « » with its own spacing — and a glued
// fragment is the trap the Swiss legend already paid for. The control's own
// key is INTERPOLATED into the sentence instead (`{control}`), so whatever the
// button says, the paragraph says. `interpolate()` in `lib/i18n-runtime.ts`
// substitutes `String(vars[k])`, so a resolved message is an ordinary var
// value — no runtime change was needed to carry one message into another.
//
// The assertion that matters is therefore not "the sentence is translated" but
// "the sentence quotes THIS LOCALE'S BUTTON", derived from the button's key
// rather than from a copy of its text.
//
// Driven under the hook harness for the reason
// `entrants-panel-row-expanded-i18n.test.tsx` documents: both of these live
// behind `useState` (a picked team; a chosen club filter) that a static render
// cannot set, and an English-only witness cannot kill a literal-revert mutant.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf, type Props } from "@/components/__tests__/_hook-harness";
import {
  EntrantsPanel,
  ExistingTeamFields,
  type EntrantsPanelEligibility,
} from "@/components/v2/entrants-panel";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const active = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/components/i18n/dict-provider", async () => {
  const { t: translate, plural: pluralise } = await import("@/lib/i18n-runtime");
  const dicts: Record<string, unknown> = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  };
  const dict = () => dicts[active.locale] as never;
  return {
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dict(), key as never, vars),
    useMsgPlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>): string =>
        pluralise(dict(), key, count, active.locale as never, vars),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

const CLUB = { id: "c1", name: "Riverside" };
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  // Per-URL, so the panel's clubs effect really populates the club filter —
  // the control whose `useState` gates the club-filtered empty line.
  return {
    ...actual,
    apiV1: vi.fn(async (url: string) => {
      if (url.startsWith("/api/v1/clubs")) return [{ id: "c1", name: "Riverside" }];
      if (url.startsWith("/api/v1/teams")) return [];
      if (url.startsWith("/api/v1/persons")) return { items: [], nextCursor: null };
      return [];
    }),
  };
});

const DICTS: Record<Locale, Dict> = { en, fr, es, nl };
const value = (d: Dict, key: string): string | undefined => (d as Record<string, string>)[key];

/** Collapse runs of whitespace — applied to BOTH sides of every comparison.
 *  React re-wraps JSX text, and French typography puts NON-BREAKING spaces
 *  inside its guillemets (« {control} »), which `\s` matches and this folds to
 *  an ordinary space. Normalising only the rendered side compares a folded
 *  string against an unfolded one and fails on punctuation that is CORRECT. */
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const TEAM = {
  id: "t1",
  name: "Latecomers FC",
  short_name: null,
  club_name: null,
  club_short_name: null,
  logo_path: null,
  // null on purpose: `canCopy` is false, so the preview is not suppressed by
  // the copy-roster checkbox that defaults to on.
  latest_entrant_id: null,
  squad_count: 0,
};

/** Render the enroll form and pick a team, the way an organiser would. */
function pickedTeam(locale: Locale, squadCount: number) {
  active.locale = locale;
  const island = renderIsland(ExistingTeamFields as never, {
    teams: [{ ...TEAM, squad_count: squadCount }],
    enteredTeamIds: new Set<string>(),
    busy: false,
    onSubmit: async () => undefined,
  } as never);
  const pick = island
    .tree()
    .find((el) => propsOf(el)["data-testid"] === "enroll-team-option");
  expect(pick, 'no [data-testid="enroll-team-option"] to pick').toBeDefined();
  (propsOf(pick!).onClick as () => void)();
  const preview = island.tree().find((el) => propsOf(el)["data-testid"] === "squad-preview");
  expect(preview, "picking a team rendered no squad preview").toBeDefined();
  return {
    text: norm(textOf(propsOf(preview!).children as never)),
    empty: String(propsOf(preview!)["data-squad-empty"]),
    count: String(propsOf(preview!)["data-squad-count"]),
  };
}

describe("the enroll form's squad preview speaks the reader's language", () => {
  it("picking a team shows the preview, and it reports the real squad", () => {
    // Positive pair + the VALUE, not just the presence: a preview that always
    // said "empty" would satisfy every copy assertion below.
    expect(pickedTeam("en", 0).empty).toBe("true");
    expect(pickedTeam("en", 3).empty).toBe("false");
    expect(pickedTeam("en", 3).count).toBe("3");
  });

  it.each(LOCALES)("%s counts the squad in its own words, singular and plural", (locale) => {
    expect(pickedTeam(locale, 1).text).toBe(
      norm(plural(DICTS[locale], "entrants.add.squadPreview", 1, locale, {})),
    );
    expect(pickedTeam(locale, 4).text).toBe(
      norm(plural(DICTS[locale], "entrants.add.squadPreview", 4, locale, {})),
    );
  });

  // The pluralisation is the point of using `plural()` at all: English said
  // "1 player" and "4 players" through a `> 1 ? "s" : ""` before this, which
  // is the construction that cannot survive translation.
  it("singular and plural are different sentences in every locale", () => {
    for (const l of LOCALES) {
      expect(pickedTeam(l, 1).text, `${l} says the same thing for 1 and 4`).not.toBe(
        pickedTeam(l, 4).text,
      );
      expect(pickedTeam(l, 1).text).toContain("1");
      expect(pickedTeam(l, 4).text).toContain("4");
    }
  });

  // THE ONE THAT MATTERS. Not "is it translated" but "does it quote the button
  // this locale actually shows" — derived from the button's own key, so the
  // prose cannot drift from the control again.
  it.each(LOCALES)("%s quotes the Sync control by the name that locale shows", (locale) => {
    const { text } = pickedTeam(locale, 0);
    const button = value(DICTS[locale], "entrants.row.syncSquad")!;
    expect(text, `${locale}'s warning names a control it does not show`).toContain(button);
    expect(text).toBe(norm(t(DICTS[locale], "entrants.add.squadEmpty", { control: button })));
  });

  it("the empty-squad warning is a different sentence in each of the four locales", () => {
    const seen = LOCALES.map((l) => pickedTeam(l, 0).text);
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });

  // The mutant this kills: gluing the English button name in as a literal, or
  // leaving the placeholder unsubstituted.
  it("no locale ships the sentence with its placeholder still in it", () => {
    for (const l of LOCALES) expect(pickedTeam(l, 0).text).not.toContain("{control}");
  });

  // ADDED AFTER A MUTATION SWEEP, which is the only reason it exists. Every
  // assertion above derives its expectation from the SAME catalogue the
  // component reads, so setting nl to the English sentence moved both sides
  // together and all three mutants SURVIVED — a derived bound is a tautology.
  //
  // The rendered comparison did not save it either, and the way it failed is
  // worth keeping: with nl's sentence set to the English one, nl still renders
  // DIFFERENTLY from en, because `{control}` interpolates the Dutch button name
  // into the English sentence. The four stayed "distinct" while one of them was
  // pure English prose. So the catalogue is compared RAW here, placeholder and
  // all, which is the only view in which the two are equal.
  it("every enroll-prose key ships in all four catalogues, none left on English", () => {
    for (const key of [
      "entrants.add.squadPreview.one",
      "entrants.add.squadPreview.other",
      "entrants.add.squadEmpty",
    ]) {
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

/** Render the panel with an EMPTY roster, let its clubs effect settle, then
 *  choose a club — the state the club-filtered empty line belongs to. */
async function clubFilteredEmpty(locale: Locale, over: Props = {}): Promise<string> {
  active.locale = locale;
  const island = renderIsland(EntrantsPanel as never, {
    divisionId: "div-1",
    entrants: [],
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community",
    divisionStatus: "setup",
    ...over,
  } as never);
  // The clubs fetch resolves on a microtask; the select does not exist before.
  await Promise.resolve();
  await Promise.resolve();
  const select = island
    .tree()
    .find((el) => propsOf(el)["data-testid"] === "entrants-club-filter");
  expect(select, 'no [data-testid="entrants-club-filter"] — the clubs effect never landed').toBeDefined();
  (propsOf(select!).onChange as (e: unknown) => void)({ target: { value: CLUB.id } });
  const cell = island.tree().find((el) => propsOf(el)["data-testid"] === "entrants-table-empty");
  expect(cell, "no empty-state cell on a filtered, empty roster").toBeDefined();
  return norm(textOf(propsOf(cell!).children as never));
}

describe("the club-filtered empty state is translated too", () => {
  it("an unfiltered empty roster says the OTHER sentence — the branch is real", async () => {
    // Without this pair the filtered assertions would pass on a component that
    // rendered the same line either way.
    const filtered = await clubFilteredEmpty("en");
    expect(filtered).toBe(en["entrants.table.emptyForClub"]);
    expect(filtered).not.toBe(en["entrants.table.empty"]);
  });

  it.each(LOCALES)("%s paints the club-filtered line from its own catalogue", async (locale) => {
    expect(await clubFilteredEmpty(locale)).toBe(value(DICTS[locale], "entrants.table.emptyForClub"));
  });

  it("the four locales render four different club-filtered lines", async () => {
    const seen: string[] = [];
    for (const l of LOCALES) seen.push(await clubFilteredEmpty(l));
    expect(new Set(seen).size, `rendered ${JSON.stringify(seen)}`).toBe(LOCALES.length);
  });
});
