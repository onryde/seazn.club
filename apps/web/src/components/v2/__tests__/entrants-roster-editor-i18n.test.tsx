// The entrant roster editor's own controls, in all four locales: each
// member's "remove", the "Find player…" search and "Save roster".
//
// `useMsg` is bound to a chosen locale, the same way
// entrants-panel-row-expanded-i18n.test.tsx binds it. The binding uses the
// production lookup (`t`), so key fallback behaves as it does in the app. An
// English-only witness could not catch these strings reverting to literals,
// because English renders byte-identical either way.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RosterEditor, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
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
  return {
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dicts[active.locale] as never, key as never, vars),
    useMsgPlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>): string =>
        pluralise(dicts[active.locale] as never, key, count, active.locale as never, vars),
  };
});

const DICTS: Record<Locale, Dict> = { en, fr, es, nl };
const KEYS = {
  remove: "entrants.roster.remove",
  find: "entrants.roster.findPlayer",
  save: "entrants.roster.save",
} as const;

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};

const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "pair",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

/** A pair with ONE member: under its cap of two, so the search is offered,
 *  and with a member, so a "remove" is. Save is always there for an editor. */
function renderRoster(locale: Locale): string {
  active.locale = locale;
  return renderToStaticMarkup(
    <RosterEditor
      kind="pair"
      members={[
        {
          person_id: "p1",
          full_name: "Ada Lovelace",
          dob: null,
          gender: null,
          squad_number: null,
          default_position_key: null,
          is_captain: false,
          roles: [],
        },
      ]}
      persons={[{ id: "p2", full_name: "Grace Hopper", dob: null, gender: null }]}
      positionGroups={[]}
      roles={[]}
      canEdit={true}
      busy={false}
      allowCaptain={false}
      allowSquadNumbers={false}
      entrantModel={MODEL}
      eligibility={NO_ELIGIBILITY}
      conflictsFor={() => []}
      onSave={() => {}}
    />,
  );
}

const value = (locale: Locale, key: string): string => {
  const v = (DICTS[locale] as Record<string, string>)[key];
  expect(v, `${locale} has no ${key}`).toBeTruthy();
  return v!;
};

/** What renderToStaticMarkup writes for a text or attribute value. */
const escaped = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The label text of every <button> in the markup, in order. */
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const placeholders = (html: string) => [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);

describe("the entrant roster editor reads its controls from the dictionary", () => {
  it.each(LOCALES)("%s paints its own remove, Find player and Save roster", (locale) => {
    const html = renderRoster(locale);
    const buttons = buttonLabels(html);
    expect(buttons, "the member's remove").toContain(escaped(value(locale, KEYS.remove)));
    expect(buttons, "Save roster").toContain(escaped(value(locale, KEYS.save)));
    expect(placeholders(html), "the player search").toEqual([escaped(value(locale, KEYS.find))]);
  });

  // The witness a hardcoded literal cannot produce: four locales, four
  // different strings, read off the rendered editor rather than the catalogue.
  it("the four locales render four different labels for each control", () => {
    const seen = LOCALES.map((l) => {
      const html = renderRoster(l);
      const buttons = buttonLabels(html);
      return {
        remove: buttons.find((b) => b === escaped(value(l, KEYS.remove))),
        save: buttons.find((b) => b === escaped(value(l, KEYS.save))),
        find: placeholders(html)[0],
      };
    });
    for (const field of ["remove", "save", "find"] as const) {
      const values = seen.map((s) => s[field]);
      expect(values.every(Boolean), `${field} missing in ${JSON.stringify(values)}`).toBe(true);
      expect(new Set(values).size, `${field} rendered ${JSON.stringify(values)}`).toBe(LOCALES.length);
    }
  });

  it("every roster-editor key ships in all four catalogues, none left on English", () => {
    for (const key of Object.values(KEYS)) {
      const values = LOCALES.map((l) => value(l, key));
      for (const [i, v] of values.entries()) {
        expect(t(DICTS[LOCALES[i]!]!, key), `${LOCALES[i]} falls back to the key`).toBe(v);
      }
      expect(new Set(values).size, `two locales share ${key}, so one was left in English`).toBe(
        LOCALES.length,
      );
    }
  });
});
