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

function render(sportKey: string, rostered: boolean): string {
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
        resolvedConfig: mod.configSchema.parse({}),
        home: side("home", rostered),
        away: side("away", rostered),
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

  it("the control: rostered sides keep the side words, in every one of those sports (an organiser's pad is unchanged)", () => {
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

describe("sideWordsFrom / withSideWords — the empty cases", () => {
  const none = { members: [] as unknown[] };
  const one = { members: [{}] };
  const echo = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key);

  it("a blank or missing name gives no word (the side keeps Home/Away); a rostered side never has one", () => {
    expect(sideWordsFrom({ home: none, away: none }, { home: "   ", away: "" })).toEqual({});
    expect(sideWordsFrom({ home: none, away: none }, {})).toEqual({});
    expect(sideWordsFrom({ home: one, away: none }, { home: "Ada", away: " Blue Bibs " })).toEqual({ away: "Blue Bibs" });
  });

  it("no words hands back the same translator; with words, only the two side-word keys change", () => {
    expect(withSideWords(echo, {})).toBe(echo);
    const t = withSideWords(echo, { home: "Red Bibs" });
    expect(t("scorepad.attribution.home")).toBe("Red Bibs");
    expect(t("scorepad.attribution.away"), "a side without a word keeps its key").toBe("scorepad.attribution.away");
    expect(t("pad.sanction.endsMatch", { side: "x" })).toBe('pad.sanction.endsMatch{"side":"x"}');
  });
});
