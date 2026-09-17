// Owner decision 2026-09-16 — a decided cricket match's margin reaches every
// locale in that locale's words.
//
// The defect: `CricketState.margin` was English prose the engine composed
// ("by 12 runs", "by 1 wicket"), and `resultMsg` passed it verbatim into
// `{margin}` — so es/fr/nl spectators read "Home Blazers ganó by 12 runs". The
// engine now publishes `{ kind, value? }`; `cricketMarginMsg` turns that into a
// key naming the unit AND the plural form (chosen in the doc's locale) plus
// the bare count.
//
// What this file pins, rendered through the REAL four dictionaries exactly as
// `getDictionary` merges them ({ ...en, ...locale }):
//   - every margin kind the engine DECLARES (`CRICKET_MARGIN_KINDS`, never a
//     list typed here) resolves to a real template in every locale — a raw
//     dotted key on the page is the failure;
//   - the exact sentence per locale for one and for many, so a formatter that
//     picks the wrong unit or ignores the plural reds on copy, not on a key
//     name the dictionary could also have gotten wrong;
//   - no English margin word survives in es/fr — the regression itself.
import { describe, expect, it } from "vitest";
import { CRICKET_MARGIN_KINDS, type CricketMargin } from "@seazn/engine/sports/cricket";
import { RESULT_MARGIN_KEYS, cricketMarginMsg } from "../match-centre";
import type { Dict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];
const RAW: Record<Locale, Record<string, unknown>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };
const DICTS = Object.fromEntries(LOCALES.map((l) => [l, { ...enPublic, ...RAW[l] } as Dict])) as Record<Locale, Dict>;
const UI: Record<Locale, Record<string, unknown>> = { en: enUi, es: esUi, fr: frUi, nl: nlUi };

const W = "Home Blazers";

/** A representative margin for every kind the engine declares. Counted kinds
 *  get a count; the rest carry none. Typed against `CricketMargin` so a kind
 *  whose shape changes reds tsc here. */
function marginOf(kind: (typeof CRICKET_MARGIN_KINDS)[number], value: number): CricketMargin {
  return kind === "super_over" || kind === "boundary_count" ? { kind } : { kind, value };
}

function render(locale: Locale, margin: CricketMargin, method?: string): string {
  const msg = cricketMarginMsg(W, margin, method, locale);
  return t(DICTS[locale], msg.key, msg.params);
}

describe("cricketMarginMsg — the structured margin, worded per locale", () => {
  it("covers every margin kind the engine declares, in every locale, at every count — never a raw key", () => {
    expect(CRICKET_MARGIN_KINDS.length).toBeGreaterThanOrEqual(5);
    const broken: string[] = [];
    for (const locale of LOCALES) {
      for (const kind of CRICKET_MARGIN_KINDS) {
        for (const method of [undefined, "regulation", "dls", "innings"]) {
          for (const value of [0, 1, 2, 5, 21, 101]) {
            const msg = cricketMarginMsg(W, marginOf(kind, value), method, locale);
            const template = lookup(DICTS[locale], msg.key);
            const text = t(DICTS[locale], msg.key, msg.params);
            if (typeof template !== "string" || text.includes("{") || !text.includes(W)) {
              broken.push(`${locale}/${kind}/${method}/${value}: ${msg.key} -> ${text}`);
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("emits only keys from its own exported family (so the parity gate's list is the real list)", () => {
    const emitted = new Set<string>();
    for (const locale of LOCALES) {
      for (const kind of CRICKET_MARGIN_KINDS) {
        for (const method of [undefined, "dls"]) {
          for (const value of [0, 1, 2]) emitted.add(cricketMarginMsg(W, marginOf(kind, value), method, locale).key);
        }
      }
    }
    const counted = [...emitted].filter((k) => !/\.(super_over|boundary_count)$/.test(k)).sort();
    expect(counted).toEqual([...RESULT_MARGIN_KEYS].sort());
  });

  // The exact sentences. One and many per unit, per locale — the pair is the
  // witness: a formatter that always chose `.other` passes every "many" row
  // and fails every "one" row, and one that swapped runs for wickets fails
  // both.
  const EXPECTED: Record<Locale, Record<string, string>> = {
    en: {
      "runs/1": "Home Blazers won by 1 run",
      "runs/12": "Home Blazers won by 12 runs",
      "wickets/1": "Home Blazers won by 1 wicket",
      "wickets/3": "Home Blazers won by 3 wickets",
      "innings_and_runs/1": "Home Blazers won by an innings and 1 run",
      "innings_and_runs/50": "Home Blazers won by an innings and 50 runs",
      "dls:runs/1": "Home Blazers won by 1 run (DLS)",
      "dls:runs/4": "Home Blazers won by 4 runs (DLS)",
      "dls:wickets/1": "Home Blazers won by 1 wicket (DLS)",
      "dls:wickets/7": "Home Blazers won by 7 wickets (DLS)",
      super_over: "Home Blazers won on the super over",
      boundary_count: "Home Blazers won on boundary count",
    },
    es: {
      "runs/1": "Home Blazers ganó por 1 carrera",
      "runs/12": "Home Blazers ganó por 12 carreras",
      "wickets/1": "Home Blazers ganó por 1 wicket",
      "wickets/3": "Home Blazers ganó por 3 wickets",
      "innings_and_runs/1": "Home Blazers ganó por un innings y 1 carrera",
      "innings_and_runs/50": "Home Blazers ganó por un innings y 50 carreras",
      "dls:runs/1": "Home Blazers ganó por 1 carrera (DLS)",
      "dls:runs/4": "Home Blazers ganó por 4 carreras (DLS)",
      "dls:wickets/1": "Home Blazers ganó por 1 wicket (DLS)",
      "dls:wickets/7": "Home Blazers ganó por 7 wickets (DLS)",
      super_over: "Home Blazers ganó en el super over",
      boundary_count: "Home Blazers ganó por recuento de boundaries",
    },
    fr: {
      "runs/1": "Home Blazers a gagné par 1 course",
      "runs/12": "Home Blazers a gagné par 12 courses",
      "wickets/1": "Home Blazers a gagné par 1 wicket",
      "wickets/3": "Home Blazers a gagné par 3 wickets",
      "innings_and_runs/1": "Home Blazers a gagné par un innings et 1 course",
      "innings_and_runs/50": "Home Blazers a gagné par un innings et 50 courses",
      "dls:runs/1": "Home Blazers a gagné par 1 course (DLS)",
      "dls:runs/4": "Home Blazers a gagné par 4 courses (DLS)",
      "dls:wickets/1": "Home Blazers a gagné par 1 wicket (DLS)",
      "dls:wickets/7": "Home Blazers a gagné par 7 wickets (DLS)",
      super_over: "Home Blazers a gagné au super over",
      boundary_count: "Home Blazers a gagné au décompte des boundaries",
    },
    nl: {
      "runs/1": "Home Blazers won met 1 run",
      "runs/12": "Home Blazers won met 12 runs",
      "wickets/1": "Home Blazers won met 1 wicket",
      "wickets/3": "Home Blazers won met 3 wickets",
      "innings_and_runs/1": "Home Blazers won met een innings en 1 run",
      "innings_and_runs/50": "Home Blazers won met een innings en 50 runs",
      "dls:runs/1": "Home Blazers won met 1 run (DLS)",
      "dls:runs/4": "Home Blazers won met 4 runs (DLS)",
      "dls:wickets/1": "Home Blazers won met 1 wicket (DLS)",
      "dls:wickets/7": "Home Blazers won met 7 wickets (DLS)",
      super_over: "Home Blazers won de super over",
      boundary_count: "Home Blazers won op het aantal boundaries",
    },
  };

  function caseOf(label: string): { margin: CricketMargin; method: string | undefined } {
    const [head, count] = label.split("/");
    const [method, kind] = head!.includes(":") ? head!.split(":") : [undefined, head];
    return { margin: marginOf(kind as (typeof CRICKET_MARGIN_KINDS)[number], Number(count ?? 0)), method };
  }

  for (const locale of LOCALES) {
    it(`${locale}: every margin reads as a sentence in ${locale}, singular and plural`, () => {
      const got = Object.fromEntries(
        Object.keys(EXPECTED[locale]).map((label) => {
          const { margin, method } = caseOf(label);
          return [label, render(locale, margin, method)];
        }),
      );
      expect(got).toEqual(EXPECTED[locale]);
    });
  }

  it("French puts ZERO in the singular and English does not — the plural comes from the locale, not `=== 1`", () => {
    expect(render("fr", { kind: "wickets", value: 0 })).toBe("Home Blazers a gagné par 0 wicket");
    expect(render("en", { kind: "wickets", value: 0 })).toBe("Home Blazers won by 0 wickets");
  });

  it("DLS never rides on an innings victory — there is no such sentence, so the plain one is kept", () => {
    expect(render("en", { kind: "innings_and_runs", value: 2 }, "dls")).toBe(
      "Home Blazers won by an innings and 2 runs",
    );
  });

  it("no English margin word survives in es or fr — the regression the owner reported", () => {
    // nl is excluded ON PURPOSE: Dutch cricket writes "runs" and "wickets", and
    // "won" is the Dutch past tense of winnen — English-looking, correct Dutch.
    const english = /\b(by|runs?|an innings|boundary count)\b/;
    const leaks: string[] = [];
    for (const locale of ["es", "fr"] as const) {
      const labels = Object.keys(EXPECTED[locale]);
      // A floor: an emptied table would make "no leaks" vacuously true.
      expect(labels.length).toBeGreaterThanOrEqual(12);
      for (const label of labels) {
        const { margin, method } = caseOf(label);
        const rendered = render(locale, margin, method);
        if (english.test(rendered.replace(W, ""))) leaks.push(`${locale}/${label}: ${rendered}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("the tie-break sentences name the cricket terms the match centre's own labels use, in every locale (owner ruling 2026-09-17)", () => {
    // Owner ruling 2026-09-17: es and fr keep the English cricket terms in the
    // result line, as the ball glyph ("Boundary") and the super-over label
    // ("Super over") already do on the same page. "recuento de límites",
    // "décompte des limites" and "súper over" are gone. Each locale's label is
    // read from its own dictionary, so a label that changes moves this with it.
    for (const locale of LOCALES) {
      const superOver = String(DICTS[locale]["matchCentre.superOver"]).toLowerCase();
      const boundary = String(DICTS[locale]["matchCentre.ball.boundary"]).toLowerCase();
      expect(superOver, `${locale}: the premise, an English super-over label`).toBe("super over");
      expect(boundary, `${locale}: the premise, an English boundary label`).toBe("boundary");
      expect(render(locale, { kind: "super_over" }), `${locale}: super over`).toContain(superOver);
      expect(render(locale, { kind: "boundary_count" }), `${locale}: boundary count`).toMatch(/\bboundar(y|ies)\b/);
      expect(render(locale, { kind: "boundary_count" }), `${locale}: a translated term`).not.toMatch(/l[íi]mites|súper/i);
    }
  });

  it("the boundary-count sentence is the SAME one the organiser's fixture page already says, in every locale", () => {
    // Review m5: `fixture.decidedBy.boundaryCount` (ui.json) had the approved
    // translation all along while this surface printed "boundary count" in
    // English. One sentence, one wording — so the two cannot drift again. The
    // 2026-09-17 ruling moved both surfaces to "boundaries" together.
    for (const locale of LOCALES) {
      const ui = { ...UI.en, ...UI[locale] } as Dict;
      expect(render(locale, { kind: "boundary_count" })).toBe(t(ui, "fixture.decidedBy.boundaryCount", { winner: "Home Blazers" }));
      // The super-over sentence moved with it (same ruling), so it is pinned the same way.
      expect(render(locale, { kind: "super_over" }), `${locale}: super over`).toBe(t(ui, "fixture.decidedBy.superOver", { winner: "Home Blazers" }));
    }
  });
});
