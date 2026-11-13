// Sign-off 2026-11-12 (controller, PO rec): a quick match's pad called its sides "Home" and "Away" ("Goal / Home",
// "Sanction / Home", a HOME header over the badminton half you tap) while the card above it named them "Red Bibs" and
// "Blue Bibs". A quick match's sides are name-only entrants: no members, so every place a skin says the side word fell
// back to Home/Away. A side with NO members is now called by its name wherever the pad says the side word; a side with a
// roster (every organiser singles entrant, every rostered team) keeps the words it had.
//
// Driven through the REAL producer and consumer (AGENTS.md class 1, the inert seam): `ScorePad` (registry.tsx) builds the
// words from the two `SideInfo`s, hands them to the skin factory AND to the real `PadHostV3`, and the server-rendered
// markup is what is read — the tile grid's sublabels and the scorebug's halves, in the words a person sees.
//
// Swept over every sport a quick match OFFERS (lib/quick-match-offer.generated.json, the product's own list), each at the
// engine's default cfg, after `core.start`. The control is the same sweep with rostered sides.
//
// Review m1 (controller ruling 2026-11-13): the words are decided per FIXTURE. When either side is called by its name,
// BOTH are, so an organiser's fixture between a rostered team and a name-only one never reads "Goal / Home" beside
// "Goal / Riverside FC". Driven over the same sweep in both orientations; and every engine sport a quick match does NOT
// offer (cricket's squad labels among them) is rendered with rostered sides to show its pad keeps the side words.
import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModuleEvent } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import offer from "@/lib/quick-match-offer.generated.json";
import type { MemberIn, SideInfo } from "@/components/v2/fixture-console";
import { ScorePad } from "../registry";
import { sideWordsFrom, withSideWords } from "../v3/side-words";

type Side = "home" | "away";
const SIDES: readonly Side[] = ["home", "away"];
// Names no side-word key resolves to, so a fallback cannot pass for a name.
const NAMES: Record<Side, string> = { home: "Red Bibs", away: "Blue Bibs" };
const WORD: Record<Side, string> = { home: en["scorepad.attribution.home"], away: en["scorepad.attribution.away"] };

/** Every sport a quick match offers, each once — the product's list, never a typed one. */
const QM_SPORTS = [...new Set(offer.offered.map((o) => o.sport_key))];

const member = (id: string, name: string): MemberIn => ({
  person_id: id,
  full_name: name,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [],
});

function side(s: Side, rostered: boolean): SideInfo {
  return {
    id: `ent-${s}`,
    name: NAMES[s],
    // A quick match's side: the name, nothing else. The control: one member, as an organiser's singles entrant has.
    members: rostered ? [member(`p-${s}`, s === "home" ? "Asha Rao" : "Bo Lindqvist")] : [],
    lineup: [],
  };
}

/** The engine's default cfg; a sport with no defaults (generic) at the first variant the engine declares for it. */
function cfgOf(mod: (typeof builtinModules)[number]): unknown {
  const defaults = mod.configSchema.safeParse({});
  if (defaults.success) return defaults.data;
  const first = Object.values(mod.variants ?? {})[0];
  if (first === undefined) throw new Error(`${mod.key} has no default cfg and declares no variant`);
  return mod.configSchema.parse(first);
}

function render(sportKey: string, rostered: boolean | Record<Side, boolean>): string {
  const r = typeof rostered === "boolean" ? { home: rostered, away: rostered } : rostered;
  const mod = builtinModules.find((m) => m.key === sportKey);
  if (!mod) throw new Error(`quick match offers ${sportKey}, which the engine does not register`);
  const started = [makeEnvelope(1, { type: "core.start", payload: {} } as ModuleEvent)];
  return renderToStaticMarkup(
    createElement(
      DictProvider,
      { dict: en as unknown as Dict, locale: "en" } as ComponentProps<typeof DictProvider>,
      createElement(ScorePad, {
        fixtureId: `fx-${sportKey}`,
        sportKey,
        moduleVersion: mod.version,
        resolvedConfig: cfgOf(mod),
        home: side("home", r.home),
        away: side("away", r.away),
        initialEvents: started,
        auth: { kind: "device_link", token: "dl_test" },
        identity: { recordedBy: null, deviceLinkId: "dl-1" },
        entitlements: {},
        stageKind: "league",
        rulesVersion: 1,
        canOrganise: false,
      }),
    ),
  );
}

/** The text of every element in the markup whose WHOLE text is one word: a tile sublabel, a scorebug half's who line. */
const wholeTexts = (html: string): string[] =>
  [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.replace(/&amp;/g, "&").trim()).filter((s) => s.length > 0);

describe("a name-only side is called by its name on the pad, in every sport a quick match offers", () => {
  it("no element reads Home or Away, and each side's name is on the pad", () => {
    expect(QM_SPORTS.length, "anti-vacuity: the offer lists sports").toBeGreaterThan(0);
    let checked = 0;
    const faults: string[] = [];
    for (const sportKey of QM_SPORTS) {
      const texts = wholeTexts(render(sportKey, false));
      for (const s of SIDES) {
        if (texts.includes(WORD[s])) faults.push(`${sportKey}: an element reads "${WORD[s]}"`);
        if (!texts.some((x) => x === NAMES[s] || x.includes(NAMES[s]))) faults.push(`${sportKey}: "${NAMES[s]}" is nowhere`);
        checked++;
      }
    }
    expect(faults.join("\n")).toBe("");
    expect(checked).toBe(QM_SPORTS.length * 2);
  });

  it("the control: rostered sides keep the side words, in every one of those sports", () => {
    let checked = 0;
    const faults: string[] = [];
    for (const sportKey of QM_SPORTS) {
      const texts = wholeTexts(render(sportKey, true));
      for (const s of SIDES) {
        // The side word stays where it stood, and the entrant's name is not put in its place.
        if (!texts.includes(WORD[s])) faults.push(`${sportKey}: no element reads "${WORD[s]}"`);
        if (texts.includes(NAMES[s])) faults.push(`${sportKey}: "${NAMES[s]}" stands as a whole label`);
        checked++;
      }
    }
    expect(faults.join("\n")).toBe("");
    expect(checked).toBe(QM_SPORTS.length * 2);
  });
});

describe("one side rostered, the other name-only: BOTH sides are called by name (review m1, per fixture)", () => {
  it("in every sport a quick match offers, each way round: no element reads Home or Away, and both names are on the pad", () => {
    expect(QM_SPORTS.length, "anti-vacuity: the offer lists sports").toBeGreaterThan(0);
    let checked = 0;
    const faults: string[] = [];
    for (const sportKey of QM_SPORTS) {
      for (const rostered of [{ home: true, away: false }, { home: false, away: true }]) {
        const texts = wholeTexts(render(sportKey, rostered));
        const which = `${sportKey} (${rostered.home ? "home" : "away"} rostered)`;
        for (const s of SIDES) {
          if (texts.includes(WORD[s])) faults.push(`${which}: an element reads "${WORD[s]}"`);
          if (!texts.some((x) => x === NAMES[s] || x.includes(NAMES[s]))) faults.push(`${which}: "${NAMES[s]}" is nowhere`);
          checked++;
        }
      }
    }
    expect(faults.join("\n")).toBe("");
    expect(checked).toBe(QM_SPORTS.length * 2 * 2);
  });
});

describe("an organiser's sport a quick match does not offer, both sides rostered: the pad keeps its side words", () => {
  /** Every engine sport outside the offer: the product's list subtracted from the engine's own registry. */
  const OTHER_SPORTS = builtinModules.map((m) => m.key).filter((k) => !QM_SPORTS.includes(k));

  it("no entrant name stands in a side word's place, and where the pad says a side word it is still Home/Away", () => {
    expect(OTHER_SPORTS, "anti-vacuity: the engine registers sports a quick match does not offer").toContain("cricket");
    let checked = 0;
    let saysWords = 0;
    const faults: string[] = [];
    for (const sportKey of OTHER_SPORTS) {
      const texts = wholeTexts(render(sportKey, true));
      for (const s of SIDES) {
        if (texts.includes(NAMES[s])) faults.push(`${sportKey}: "${NAMES[s]}" stands as a whole label`);
        if (texts.includes(WORD[s])) saysWords++;
        checked++;
      }
    }
    expect(faults.join("\n")).toBe("");
    expect(checked).toBe(OTHER_SPORTS.length * 2);
    // Not vacuous: at least one of these pads says the side words, so a name replacing them would be seen.
    expect(saysWords).toBeGreaterThan(0);
  });
});

describe("sideWordsFrom / withSideWords — the empty cases", () => {
  const none = { members: [] as unknown[] };
  const one = { members: [{}] };
  const echo = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key);

  it("a blank or missing name gives no word (the side keeps Home/Away); two rostered sides never have one", () => {
    expect(sideWordsFrom({ home: none, away: none }, { home: "   ", away: "" })).toEqual({});
    expect(sideWordsFrom({ home: none, away: none }, {})).toEqual({});
    expect(sideWordsFrom({ home: one, away: one }, { home: "Ada", away: "Bo" })).toEqual({});
  });

  it("per fixture (review m1): one name-only side names BOTH sides, a blank name still keeps its word", () => {
    expect(sideWordsFrom({ home: one, away: none }, { home: "Ada", away: " Blue Bibs " })).toEqual({ home: "Ada", away: "Blue Bibs" });
    expect(sideWordsFrom({ home: none, away: one }, { home: "Red Bibs", away: "Bo" })).toEqual({ home: "Red Bibs", away: "Bo" });
    // The rostered side has no name to give: it keeps its word; the name-only side still has its name.
    expect(sideWordsFrom({ home: one, away: none }, { home: "  ", away: "Blue Bibs" })).toEqual({ away: "Blue Bibs" });
    // A name-only side with a blank name decides nothing: the rostered pair keeps the words.
    expect(sideWordsFrom({ home: one, away: none }, { home: "Ada", away: "" })).toEqual({});
  });

  it("no words hands back the same translator; with words, only the two side-word keys change", () => {
    expect(withSideWords(echo, {})).toBe(echo);
    const t = withSideWords(echo, { home: "Red Bibs" });
    expect(t("scorepad.attribution.home")).toBe("Red Bibs");
    expect(t("scorepad.attribution.away"), "a side without a word keeps its key").toBe("scorepad.attribution.away");
    expect(t("pad.sanction.endsMatch", { side: "x" })).toBe('pad.sanction.endsMatch{"side":"x"}');
  });
});
