// The entrants row's EXPANDED half, in all four locales.
//
// Two of the six strings the 2026-09-22 sweep found sit behind the row's
// disclosure — "Sync from team squad" with its policy `title`, and the
// "Loading roster…" line the expanded body shows until the members arrive.
// `open` is a `useState` the row owns, so `renderToStaticMarkup` can never
// reach them: it renders one frozen instant and has no way to press anything.
// That is why `EntrantTableRow` is exported and driven here under the
// dispatcher harness instead — the same reason `_hook-harness.tsx` exists.
//
// `useMsg` is bound to a chosen locale rather than read from a `DictProvider`
// because the harness's `useContext` returns a context's DEFAULT value (there
// is no provider tree in it), which would pin every locale to the shipped
// English catalogue — and an English-only witness CANNOT kill the mutant that
// matters here: reverting `{msg("entrants.row.syncSquad")}` to the literal
// "Sync from team squad" renders byte-identical English. The binding uses the
// production lookup (`t` from `@/lib/i18n-runtime`, exactly what `useMsg`
// calls), so interpolation and key-fallback behave as they do in the app.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf, type Props } from "@/components/__tests__/_hook-harness";
import { EntrantTableRow, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

// Hoisted so the (also hoisted) mock factory can read it; each test sets it
// before rendering.
const active = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/components/i18n/dict-provider", async () => {
  const { t: translate, plural: pluralise } = await import("@/lib/i18n-runtime");
  const dicts: Record<string, unknown> = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  };
  return {
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dicts[active.locale] as never, key as never, vars),
    // `entrants-panel.tsx` also imports `useMsgPlural` (the enroll form's
    // squad count). A partial mock that omitted it would hand the module an
    // `undefined` import — fine until something in this file renders that
    // form, and then a confusing "not a function" a long way from here.
    useMsgPlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>): string =>
        pluralise(dicts[active.locale] as never, key, count, active.locale as never, vars),
  };
});
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  // Never resolves: the expanded body shows its loading line until `members`
  // arrives, and a promise that settles would race the assertion.
  return { ...actual, apiV1: vi.fn(() => new Promise(() => {})) };
});

const DICTS: Record<Locale, Dict> = { en, fr, es, nl };

const TESTID = {
  disclosure: "entrant-row-disclosure",
  syncSquad: "entrant-row-sync-squad",
  rosterLoading: "entrant-row-roster-loading",
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

/** A TEAM entrant — `onSyncSquad` is handed down only when `entrant.team_id`
 *  is set (entrants-panel.tsx), so an individual could never witness this
 *  control at all. */
const TEAM_ENTRANT = {
  id: "e1",
  kind: "team",
  team_id: "t1",
  display_name: "Lovelace Wanderers",
  seed: null,
  status: "registered",
  badge_url: null,
};

function rowProps(over: Props = {}) {
  return {
    entrant: TEAM_ENTRANT,
    logoUrl: null,
    canEdit: true,
    busy: false,
    persons: [],
    positionGroups: [],
    roles: [],
    entrantModel: MODEL,
    eligibility: NO_ELIGIBILITY,
    otherTeamsFor: () => [],
    deletable: true,
    onPatch: () => {},
    onWithdraw: () => {},
    onBadge: () => {},
    onSyncSquad: async () => undefined,
    onDelete: () => {},
    ...over,
  } as never;
}

/** Render the row, then press its disclosure the way an organiser would.
 *  Synchronously: `toggle` sets `open` before it awaits the roster fetch, and
 *  the loading line is exactly the state between those two moments. */
function expandedRow(locale: Locale, over: Props = {}) {
  active.locale = locale;
  const island = renderIsland(EntrantTableRow as never, rowProps(over));
  const collapsed = island.tree();
  const toggle = collapsed.find((el) => propsOf(el)["data-testid"] === TESTID.disclosure);
  expect(toggle, `no [data-testid="${TESTID.disclosure}"] to press`).toBeDefined();
  (propsOf(toggle!).onClick as () => void)();
  const tree = island.tree();
  const find = (testid: string) => tree.find((el) => propsOf(el)["data-testid"] === testid);
  return { tree, find, text: textOf(island.text()) };
}

const value = (d: Dict, key: string): string | undefined => (d as Record<string, string>)[key];

describe("the entrants row's expanded half reads from the dictionary", () => {
  // The positive pair: pressing the disclosure really did open the body. A
  // suite that only asserted labels would pass on a row that never opened,
  // because `find` would return undefined and every `expect(...).toBe` below
  // would be reached only through an already-failing assertion.
  it("the disclosure opens the body — nothing below is asserted on a closed row", () => {
    const { find, tree } = expandedRow("en");
    expect(tree.length, "the row rendered nothing at all").toBeGreaterThan(5);
    expect(find(TESTID.rosterLoading), "the body never opened").toBeDefined();
  });

  it.each(LOCALES)("%s paints the locale's own Sync-from-squad label and tooltip", (locale) => {
    const { find } = expandedRow(locale);
    const sync = find(TESTID.syncSquad);
    expect(sync, `no [data-testid="${TESTID.syncSquad}"] on the expanded row`).toBeDefined();
    expect(textOf(propsOf(sync!).children as never).trim()).toBe(
      value(DICTS[locale], "entrants.row.syncSquad"),
    );
    expect(propsOf(sync!).title).toBe(value(DICTS[locale], "entrants.row.syncSquadHint"));
  });

  it.each(LOCALES)("%s paints the locale's own roster loading line", (locale) => {
    const { find } = expandedRow(locale);
    const loading = find(TESTID.rosterLoading);
    expect(loading, `no [data-testid="${TESTID.rosterLoading}"] on the expanded row`).toBeDefined();
    expect(textOf(propsOf(loading!).children as never).trim()).toBe(
      value(DICTS[locale], "entrants.row.loadingRoster"),
    );
  });

  // The witness a hardcoded literal cannot produce: four locales, four
  // different strings, read off the rendered row rather than the catalogue.
  it("the four locales render four different Sync labels, tooltips and loading lines", () => {
    const read = (l: Locale) => {
      const { find } = expandedRow(l);
      return {
        label: textOf(propsOf(find(TESTID.syncSquad)!).children as never).trim(),
        title: String(propsOf(find(TESTID.syncSquad)!).title),
        loading: textOf(propsOf(find(TESTID.rosterLoading)!).children as never).trim(),
      };
    };
    const seen = LOCALES.map(read);
    for (const field of ["label", "title", "loading"] as const) {
      const values = seen.map((s) => s[field]);
      expect(new Set(values).size, `${field} rendered ${JSON.stringify(values)}`).toBe(LOCALES.length);
    }
  });

  it("every expanded-row key ships in all four catalogues, none left on English", () => {
    for (const key of [
      "entrants.row.syncSquad",
      "entrants.row.syncSquadHint",
      "entrants.row.loadingRoster",
    ]) {
      const values = LOCALES.map((l) => value(DICTS[l], key));
      for (const [i, v] of values.entries()) {
        expect(v, `${LOCALES[i]} is missing ${key}`).toBeTruthy();
        expect(t(DICTS[LOCALES[i]!]!, key), `${LOCALES[i]} falls back to the key`).not.toBe(key);
      }
      expect(new Set(values).size, `two locales share ${key} — one was left in English`).toBe(
        LOCALES.length,
      );
    }
  });

  // `canEdit && onSyncSquad` gates the control. Without this row, an absent
  // Sync button would satisfy nothing and the loading assertions alone could
  // not tell an opened body from a control that had quietly disappeared.
  it("offers no Sync control on an entrant that is not a team", () => {
    const { find } = expandedRow("en", { onSyncSquad: undefined });
    expect(find(TESTID.rosterLoading), "the body never opened").toBeDefined();
    expect(find(TESTID.syncSquad)).toBeUndefined();
  });
});
