// The 4-step builder's pure decisions (Match Day C9): the entrant kind it opens at and sends, the format it opens on
// (the first card shown, round 4), the order and the collapsed view of the Format and Sport pickers (C9 R2), and the step a server refusal belongs to. Expected values come from the engine's own declarations (each
// sport module's entrant model) and the rulebook draw sizes, never from the module under test.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { STAGE_TEMPLATES, templatesForSport } from "@/lib/format-templates";
import { PAIR_MINTING_STAGE_KINDS } from "@/lib/chess-individual-only-rule";
import {
  BUILDER_STEPS,
  OPENING_PLAN,
  SUGGESTED_COUNT,
  collapsedPicks,
  defaultSportKey,
  entrantKindAfterSportChange,
  entrantsConfigFor,
  divisionEntrantKinds,
  divisionFormatOffer,
  divisionPlaysTemplate,
  firstBlockedStep,
  formatPickerOrder,
  isPairRotationTemplate,
  openingKnobs,
  openingTemplate,
  pickAfterChange,
  rankTemplates,
  sportPickerOrder,
  stepForCreateError,
} from "../model";

const KNOBS = { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 };
const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};

describe("entrant kind", () => {
  // Owner ruling 2026-11-03 (C9 Q3, then n3 "yes"): the division takes EXACTLY the kind shown on Who plays - picked,
  // clicked or left at the sport's default. Settings can widen it later.
  it("every kind of every sport, the default included, narrows the division to that kind alone (counts)", () => {
    let checked = 0;
    let narrowedDefaults = 0;
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      for (const kind of model.kinds) {
        expect(entrantsConfigFor(model, kind), `${m.key} ${kind}`).toEqual({ kinds: [kind], defaultKind: kind });
        checked++;
      }
      // The witness for n3: at the default, the division now takes LESS than the sport allows (it used to send nothing).
      if (model.kinds.length > 1) narrowedDefaults++;
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + modelOf(m.key).kinds.length, 0));
    // badminton, tennis, table tennis, carrom (individual, pair), volleyball (team, pair), generic (all three).
    expect(narrowedDefaults).toBeGreaterThanOrEqual(6);
  });

  it("refuses a kind the sport does not allow rather than sending it (chess is individual-only)", () => {
    expect(() => entrantsConfigFor(modelOf("boardgame"), "team")).toThrow(/not a kind boardgame|not allowed/);
  });

  it("the right default differs from any one constant: volleyball opens at team, badminton at individual (class 19)", () => {
    expect(modelOf("volleyball").defaultKind).toBe("team");
    expect(modelOf("badminton").defaultKind).toBe("individual");
  });

  it("a sport change keeps a kind the organiser CHOSE when the new sport allows it, else takes the new sport's default", () => {
    expect(entrantKindAfterSportChange("pair", true, modelOf("tennis"))).toBe("pair");
    expect(entrantKindAfterSportChange("pair", true, modelOf("football"))).toBe("team");
    expect(entrantKindAfterSportChange("team", true, modelOf("badminton"))).toBe("individual");
  });

  it("an UNTOUCHED kind follows the sport: volleyball's team default does not ride into generic, whose default is individual", () => {
    // generic allows team, so keeping it would be allowed - and would send a kind the organiser never picked.
    expect(modelOf("generic").kinds).toContain("team");
    expect(entrantKindAfterSportChange("team", false, modelOf("generic"))).toBe(modelOf("generic").defaultKind);
    expect(modelOf("generic").defaultKind).not.toBe("team");
  });
});

describe("suggested formats", () => {
  const plan = { entrants: 16, venues: 2, hours: 4, matchMinutes: 30 };

  it("the full ranking is a permutation of the offer: Show all loses no format (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const offered = templatesForSport(m.key, modelOf(m.key).kinds).map((t) => t.key);
      expect(rankTemplates(offered, plan, KNOBS).map((r) => r.key).sort(), m.key).toEqual([...offered].sort());
      checked += offered.length;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a format with no fixed draw (ladder) is never ranked into the first five ahead of four that have one", () => {
    const offered = STAGE_TEMPLATES.filter((t) => !t.retired).map((t) => t.key);
    expect(offered.length, "premise: more than five formats to rank").toBeGreaterThan(SUGGESTED_COUNT);
    expect(rankTemplates(offered, plan, KNOBS).slice(0, SUGGESTED_COUNT).map((r) => r.key)).not.toContain("ladder");
  });

  it("with NOTHING fitting the day, a format with a draw still outranks one without, whatever the offer's order", () => {
    // 16 players on 1 court in 1 hour: a league of 16 is 120 matches - nothing fits. The ladder has no draw to time.
    const tight = { entrants: 16, venues: 1, hours: 1, matchMinutes: 30 };
    const ranked = rankTemplates(["ladder", "league"], tight, KNOBS);
    expect(ranked.map((r) => [r.key, r.fits])).toEqual([
      ["league", false],
      ["ladder", false],
    ]);
  });

  it("a format that fits the day outranks one that does not: 16 players, 2 courts, 4 hours", () => {
    // A league of 16 is 120 matches (16 * 15 / 2), 60 slots on 2 courts - 30 hours. A knockout is 15 matches in 4
    // rounds: 8 slots, exactly 4 hours.
    const ranked = rankTemplates(["league", "knockout"], plan, KNOBS);
    expect(ranked.map((r) => r.key)).toEqual(["knockout", "league"]);
    expect(ranked[0]!.fits).toBe(true);
    expect(ranked[1]!.fits).toBe(false);
  });

  it("among formats that fit, the one that plays everyone most comes first: 6 players, 3 courts, 4 hours", () => {
    // League of 6: 15 matches, 5 rounds = 5 slots (2.5 h), everyone plays 5. Knockout of 6: 5 matches, 3 rounds,
    // a first-round loser plays once.
    expect(rankTemplates(["knockout", "league"], { entrants: 6, venues: 3, hours: 4, matchMinutes: 30 }, KNOBS).map((r) => r.key)).toEqual(["league", "knockout"]);
  });

  it("more courts move the suggestion: 10 players for 3 hours fit a league on 5 courts but not on 1", () => {
    // League of 10: 45 matches, 9 rounds. 5 courts: max(9, 9) = 9 slots of 20 min = 3 h. 1 court: 45 slots.
    const on = (venues: number) => rankTemplates(["league"], { entrants: 10, venues, hours: 3, matchMinutes: 20 }, KNOBS)[0]!.fits;
    expect(on(5)).toBe(true);
    expect(on(1)).toBe(false);
  });
});

describe("steps", () => {
  it("are the owner's four, in order", () => {
    expect(BUILDER_STEPS).toEqual(["who", "format", "rules", "review"]);
  });

  it("firstBlockedStep: the empty case first - nothing blocked is null; else the EARLIEST blocked step, not the first listed", () => {
    expect(firstBlockedStep({})).toBeNull();
    expect(firstBlockedStep({ who: null, format: null, rules: null })).toBeNull();
    expect(firstBlockedStep({ rules: "x", who: "y" })).toBe("who");
    expect(firstBlockedStep({ rules: "x", format: null })).toBe("rules");
  });

  it("a server refusal lands on the step that holds its field", () => {
    expect(stepForCreateError("stages", { code: "SWISS_ROUNDS_REQUIRED" })).toBe("format");
    expect(stepForCreateError("stages", {})).toBe("format");
    expect(stepForCreateError("division", { code: "CONFIG_INVALID" })).toBe("rules");
    expect(stepForCreateError("division", { code: "INVALID_TIME_CONTROL" })).toBe("rules");
    expect(stepForCreateError("division", { code: "ONLINE_CHESS_DISABLED" })).toBe("rules");
    expect(stepForCreateError("division", { code: "CHESS_INDIVIDUAL_ONLY" })).toBe("who");
    expect(stepForCreateError("division", { code: "VALIDATION_FAILED", extra: { issues: [{ path: ["name"] }] } })).toBe("who");
    expect(stepForCreateError("division", { code: "VALIDATION_FAILED", extra: { issues: [{ path: ["age_max"] }] } })).toBe("who");
    expect(stepForCreateError("division", { code: "VALIDATION_FAILED", extra: { issues: [{ path: ["tiebreakers", 0] }] } })).toBe("rules");
    // Nothing to place it by (a quota, a finished competition): Review, where Create is.
    expect(stepForCreateError("division", { code: "PAYMENT_REQUIRED" })).toBe("review");
    expect(stepForCreateError("division", {})).toBe("review");
  });
});

describe("the opening format (owner Q5) and the kinds it is picked for (Q3): the empty cases", () => {
  it("nothing offered opens on League; a division that takes no kind never opens on a pair-rotation format", () => {
    expect(openingTemplate([], 30, ["individual", "pair"], [])).toBe("league");
    // Americano/mexicano only: a division with no declared kinds can play neither. The fallback is League, never the
    // offer's first - that one is unplayable by construction (C9 review 2, n4: fail closed).
    expect(openingTemplate(["americano", "mexicano"], 30, [], [])).toBe("league");
    expect(openingTemplate(["americano", "mexicano"], 30, ["pair"], ["americano"])).toBe("league");
    expect(openingTemplate(["americano", "knockout"], 30, [], [])).toBe("knockout");
    // A plan that locks the first (Community lacks formats.advanced) opens on the next it includes; a lock on an unranked
    // key moves nothing.
    expect(openingTemplate(["americano", "knockout"], 30, ["individual", "pair"], ["americano"])).toBe("knockout");
    // A lock on the first card shown moves the opening to the NEXT card shown - not to the League fallback. No
    // partner-rotation format here, so the cards are shown in the suggester's order.
    const offer = ["league", "knockout", "ko_plate"];
    const shown = rankTemplates(offer, { ...OPENING_PLAN, matchMinutes: 30 }, openingKnobs(OPENING_PLAN.entrants)).map((r) => r.key);
    expect(shown[1], "premise: the second card shown is not the fallback").not.toBe("league");
    expect(openingTemplate(offer, 30, ["team"], [])).toBe(shown[0]);
    expect(openingTemplate(offer, 30, ["team"], [shown[0]!])).toBe(shown[1]);
    expect(openingTemplate(["americano", "knockout"], 30, ["individual", "pair"], ["not-a-template"])).toBe(openingTemplate(["americano", "knockout"], 30, ["individual", "pair"], []));
  });

  it("the kinds a division takes: none shown is every kind the sport allows; the kind shown, default or not, alone (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      expect(divisionEntrantKinds(model, null), m.key).toEqual(model.kinds);
      // n3: the default is a kind like any other - the division takes it alone.
      for (const kind of model.kinds) expect(divisionEntrantKinds(model, kind), `${m.key} ${kind}`).toEqual([kind]);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });
});


// C9 review 2, N1 (with the owner's n3 "yes"): the Format step reads the DIVISION's kinds, not only the sport's. Americano
// and Mexicano rotate individual players into pairs (stages.ts americanoGen plays one person per entrant), so a division
// that takes no individual players - narrowed to Pairs or Teams on Who plays - is not offered them.
describe("what a division narrowed on Who plays is offered (N1: the partner-rotation formats need individual players)", () => {
  // The oracle restates the rule from the stage kinds the server mints pairs for, never from the module under test.
  const mintsPairs = (key: string) => STAGE_TEMPLATES.find((t) => t.key === key)!.build(KNOBS).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind));
  const takesIndividuals = (kinds: readonly string[]) => kinds.includes("individual");

  it("empty case first: a division that takes no kind plays no partner-rotation format, and an empty offer stays empty", () => {
    expect(divisionFormatOffer([], [])).toEqual([]);
    expect(divisionFormatOffer([], ["individual"])).toEqual([]);
    expect(divisionPlaysTemplate("americano", [])).toBe(false);
    expect(divisionPlaysTemplate("mexicano", [])).toBe(false);
    // Nothing else needs a kind: a league is played by whatever the division takes, even nothing declared.
    expect(divisionPlaysTemplate("league", [])).toBe(true);
  });

  it("every sport x every kind it allows: the offer is the sport's, less the partner-rotation formats when the kind is not individual (counts)", () => {
    let checked = 0;
    const dropped: string[] = [];
    const kept: string[] = [];
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      const sportOffer = templatesForSport(m.key, model.kinds).map((t) => t.key);
      for (const kind of model.kinds) {
        const kinds = divisionEntrantKinds(model, kind);
        const want = sportOffer.filter((k) => !mintsPairs(k) || takesIndividuals(kinds));
        expect(divisionFormatOffer(sportOffer, kinds), `${m.key} ${kind}`).toEqual(want);
        if (sportOffer.some(mintsPairs)) (takesIndividuals(kinds) ? kept : dropped).push(`${m.key} ${kind}`);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + modelOf(m.key).kinds.length, 0));
    // The review's list: badminton, tennis, table tennis and carrom with Pairs; generic with Teams (and Pairs).
    expect(dropped.sort()).toEqual(["badminton pair", "carrom pair", "generic pair", "generic team", "tabletennis pair", "tennis pair"]);
    // The positive pair: the same sports at Individuals keep both formats.
    expect(kept.sort()).toEqual(["badminton individual", "carrom individual", "generic individual", "tabletennis individual", "tennis individual"]);
  });

  it("the owner's two by name: badminton at Individuals is offered Americano and Mexicano; at Pairs, neither", () => {
    const offer = templatesForSport("badminton", modelOf("badminton").kinds).map((t) => t.key);
    expect(offer, "premise: the sport is offered both").toEqual(expect.arrayContaining(["americano", "mexicano"]));
    expect(divisionFormatOffer(offer, ["individual"])).toEqual(expect.arrayContaining(["americano", "mexicano"]));
    expect(divisionFormatOffer(offer, ["pair"])).not.toContain("americano");
    expect(divisionFormatOffer(offer, ["pair"])).not.toContain("mexicano");
  });

  it("the opening is the first card SHOWN (round 4, I1 'A'): Americano ranks first yet opens only when nothing else is offered", () => {
    // The premise: Americano outranks a knockout at the opening plan (else the cases below say nothing) - and the picker
    // shows it after the knockout (R2), so the old opening (the ranking's first) and the right one differ.
    const plan = { ...OPENING_PLAN, matchMinutes: 30 };
    expect(rankTemplates(["americano", "knockout"], plan, openingKnobs(plan.entrants)).map((r) => r.key)).toEqual(["americano", "knockout"]);
    for (const kinds of [["individual", "pair"], ["individual"], ["pair"], ["team"]]) {
      expect(openingTemplate(["americano", "knockout"], 30, kinds, []), kinds.join("+")).toBe("knockout");
    }
    // Offered alone, it is the first card shown - to a division of individuals (n3: an untouched badminton), which plays it.
    expect(openingTemplate(["americano"], 30, ["individual"], [])).toBe("americano");
    expect(openingTemplate(["americano"], 30, ["pair"], [])).toBe("league");
  });

  it("a picked card after the sport or the kind changes: kept while still offered, else dropped so the opening applies (n1)", () => {
    expect(pickAfterChange(null, ["league", "americano"])).toBeNull();
    expect(pickAfterChange("americano", [])).toBeNull();
    expect(pickAfterChange("americano", ["league", "americano"])).toBe("americano");
    // Never a picked League in its place (the old fallback): League is not the opening's suggestion.
    expect(pickAfterChange("americano", ["league", "knockout"])).toBeNull();
  });

  it("the sequence across sports (format-templates' templateAfterSportChange, retired with n1): chess and football drop a pair pick, a retired format is never kept, an offered pick is", () => {
    const offerOf = (key: string) => {
      const model = modelOf(key);
      return divisionFormatOffer(templatesForSport(key, model.kinds).map((t) => t.key), divisionEntrantKinds(model, model.defaultKind));
    };
    expect(pickAfterChange("americano", offerOf("boardgame"))).toBeNull();
    expect(pickAfterChange("mexicano", offerOf("boardgame"))).toBeNull();
    expect(pickAfterChange("swiss", offerOf("boardgame"))).toBe("swiss");
    expect(pickAfterChange("americano", offerOf("badminton"))).toBe("americano");
    // Retired from every sport's offer (owner ruling 2026-11-01): a builder can never be left holding it.
    expect(pickAfterChange("triple_rr", offerOf("badminton"))).toBeNull();
    // badminton Americano -> chess (dropped) -> badminton: the pick is not remembered.
    const onChess = pickAfterChange("americano", offerOf("boardgame"));
    expect(pickAfterChange(onChess, offerOf("badminton"))).toBeNull();
    // The engine holds football as teams only: a pair format is dropped there too; one it is offered stays.
    expect(modelOf("football").kinds).not.toContain("individual");
    expect(pickAfterChange("americano", offerOf("football"))).toBeNull();
    expect(pickAfterChange("league_ko", offerOf("football"))).toBe("league_ko");
  });
});

// C9 R2 (owner 2026-11-03): "show 5 format and then 6th one as a show more", and "in step 1, in sport, can we have
// similar format way of choosing the sport?". The rule, from the brief: the first five, then the Show more tile; the
// one picked never folds away - outside the first five it takes the fifth slot.
describe("a collapsed picker (Format and Sport): five, the pick pinned into the fifth slot", () => {
  it("empty case first: an empty order shows nothing, whatever is picked", () => {
    expect(collapsedPicks([], null)).toEqual([]);
    expect(collapsedPicks([], "league")).toEqual([]);
  });

  it("the pick at every position of an eight-long order: inside the first five nothing moves; outside, it is the fifth (counts)", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let checked = 0;
    for (const [i, picked] of order.entries()) {
      const shown = collapsedPicks(order, picked);
      expect(shown, picked).toEqual(i < 5 ? ["a", "b", "c", "d", "e"] : ["a", "b", "c", "d", picked]);
      checked++;
    }
    expect(checked).toBe(order.length);
    expect(collapsedPicks(order, null), "nothing picked: the first five").toEqual(["a", "b", "c", "d", "e"]);
  });

  it("fewer than five in the order: every one, and nothing invented", () => {
    expect(collapsedPicks(["a", "b", "c"], "c")).toEqual(["a", "b", "c"]);
    expect(collapsedPicks(["a", "b", "c", "d", "e"], "e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a pick the order does not hold (a format the sport no longer offers) is never shown as a phantom sixth", () => {
    expect(collapsedPicks(["a", "b", "c", "d", "e", "f"], "zz")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

/** The partner-rotation formats by the DECLARATIONS: the templates whose stage graph holds a kind that mints pair
 *  entrants (chess-individual-only-rule.ts PAIR_MINTING_STAGE_KINDS), never a list of keys. */
const MINTING = STAGE_TEMPLATES.filter((t) => t.build(KNOBS).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind))).map((t) => t.key);

describe("Americano and Mexicano sort after every other format (owner 2026-11-03)", () => {
  it("the formats held last are the ones that mint pairs, and they are the owner's two by name", () => {
    expect([...MINTING].sort(), "the owner named Americano and Mexicano").toEqual(["americano", "mexicano"]);
    let checked = 0;
    for (const t of STAGE_TEMPLATES) {
      expect(isPairRotationTemplate(t.key), t.key).toBe(MINTING.includes(t.key));
      checked++;
    }
    expect(checked).toBe(STAGE_TEMPLATES.length);
    expect(isPairRotationTemplate("no-such-template")).toBe(false);
  });

  it("empty case first: an empty ranking orders to nothing", () => {
    expect(formatPickerOrder([])).toEqual([]);
  });

  it("every sport at several plans: the whole ranking, once; the pair formats after every other; each side in the ranking's order (counts)", () => {
    const plans = [
      { entrants: 16, venues: 2, hours: 4, matchMinutes: 30 },
      { entrants: 8, venues: 4, hours: 8, matchMinutes: 20 },
      { entrants: 32, venues: 1, hours: 2, matchMinutes: 45 },
    ];
    let checked = 0;
    let moved = 0;
    for (const m of builtinModules) {
      for (const plan of plans) {
        const offered = templatesForSport(m.key, modelOf(m.key).kinds).map((t) => t.key);
        const ranked = rankTemplates(offered, plan, KNOBS).map((r) => r.key);
        const order = formatPickerOrder(ranked);
        expect([...order].sort(), m.key).toEqual([...ranked].sort());
        const firstPair = order.findIndex((k) => MINTING.includes(k));
        if (firstPair >= 0) expect(order.slice(firstPair).every((k) => MINTING.includes(k)), `${m.key}: nothing after a pair format but pair formats`).toBe(true);
        expect(order.filter((k) => !MINTING.includes(k)), m.key).toEqual(ranked.filter((k) => !MINTING.includes(k)));
        expect(order.filter((k) => MINTING.includes(k)), m.key).toEqual(ranked.filter((k) => MINTING.includes(k)));
        // The witness: the ranking put a pair format ahead of another format, and the picker did not.
        if (ranked.some((k, i) => MINTING.includes(k) && ranked.slice(i + 1).some((x) => !MINTING.includes(x)))) moved++;
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * plans.length);
    expect(moved, "some sport's ranking put a pair format ahead of another, or the rule is untested").toBeGreaterThan(0);
  });

  it("collapsed: a pair format shows only when fewer than five others are offered, or it is the pick (every sport, counts)", () => {
    const plan = { entrants: 16, venues: 2, hours: 4, matchMinutes: 30 };
    let pairsOffered = 0;
    for (const m of builtinModules) {
      const offered = templatesForSport(m.key, modelOf(m.key).kinds).map((t) => t.key);
      const order = formatPickerOrder(rankTemplates(offered, plan, KNOBS).map((r) => r.key));
      const others = order.filter((k) => !MINTING.includes(k)).length;
      for (const pair of order.filter((k) => MINTING.includes(k))) {
        pairsOffered++;
        expect(collapsedPicks(order, null).includes(pair), `${m.key} ${pair}, nothing picked`).toBe(others < 5);
        expect(collapsedPicks(order, pair), `${m.key} ${pair}, picked`).toContain(pair);
        const otherPick = order.find((k) => !MINTING.includes(k))!;
        expect(collapsedPicks(order, otherPick).includes(pair), `${m.key} ${pair}, another picked`).toBe(others < 5);
      }
    }
    expect(pairsOffered, "some sport offers the pair formats").toBeGreaterThan(0);
  });
});

/** The owner's popular sports, in his order (brief 2026-11-03): football, cricket, badminton, tennis, table tennis. */
const POPULAR = ["football", "cricket", "badminton", "tennis", "tabletennis"];
const REGISTRY = builtinModules.map((m) => m.key);

describe("the sport picker's order (owner 2026-11-03): the organisation's own, the popular five, the registry, generic last", () => {
  it("empty case first: no sports listed orders to nothing, whatever the history", () => {
    expect(sportPickerOrder([], [])).toEqual([]);
    expect(sportPickerOrder([], ["football", "boardgame"])).toEqual([]);
  });

  it("no history: the popular five in the owner's order, the rest in the registry's, generic last (the registry, counts)", () => {
    for (const k of [...POPULAR, "generic"]) expect(REGISTRY, `premise: the registry ships ${k}`).toContain(k);
    const order = sportPickerOrder(REGISTRY, []);
    expect(order.slice(0, 5)).toEqual(POPULAR);
    expect(order.slice(5, -1)).toEqual(REGISTRY.filter((k) => !POPULAR.includes(k) && k !== "generic"));
    expect(order.at(-1)).toBe("generic");
    expect([...order].sort()).toEqual([...REGISTRY].sort());
    expect(order.length).toBeGreaterThanOrEqual(10);
    // The witness: the registry's own order is not the picker's (it ships chess third).
    expect(order).not.toEqual(REGISTRY);
  });

  it("the page's order does not leak in: the registry decides, whatever order the page lists the sports in", () => {
    const byName = [...REGISTRY].sort();
    expect(sportPickerOrder(byName, [])).toEqual(sportPickerOrder(REGISTRY, []));
  });

  it("each registry sport as the one most recently run comes first; generic, most recent or not, stays last (counts)", () => {
    let checked = 0;
    for (const k of REGISTRY) {
      const order = sportPickerOrder(REGISTRY, [k]);
      if (k === "generic") expect(order.at(-1), k).toBe("generic");
      else expect(order[0], k).toBe(k);
      expect(order.at(-1), k).toBe("generic");
      expect(new Set(order).size, k).toBe(REGISTRY.length);
      checked++;
    }
    expect(checked).toBe(REGISTRY.length);
  });

  it("the history in its own order, most recent first, then the popular ones it did not name, then the rest", () => {
    const order = sportPickerOrder(REGISTRY, ["carrom", "generic", "badminton", "boardgame"]);
    expect(order.slice(0, 3)).toEqual(["carrom", "badminton", "boardgame"]);
    expect(order.slice(3, 7)).toEqual(POPULAR.filter((k) => k !== "badminton"));
    expect(order.at(-1)).toBe("generic");
  });

  it("a sport in the history the page does not list is left out; a listed sport the registry does not ship sits before generic", () => {
    expect(sportPickerOrder(["badminton", "generic"], ["hockey"])).toEqual(["badminton", "generic"]);
    expect(sportPickerOrder(["generic", "padel", "badminton"], [])).toEqual(["badminton", "padel", "generic"]);
    // Names Object.prototype owns are sports like any other here (a Set, never an object lookup).
    expect(sportPickerOrder(["constructor", "football"], ["toString"])).toEqual(["football", "constructor"]);
  });

  it("the picked sport is never folded away: each registry sport picked, the collapsed five hold it (counts)", () => {
    let pinned = 0;
    for (const k of REGISTRY) {
      const order = sportPickerOrder(REGISTRY, []);
      const shown = collapsedPicks(order, k);
      expect(shown, k).toContain(k);
      expect(shown.length, k).toBe(5);
      if (order.indexOf(k) >= 5) {
        expect(shown[4], `${k} takes the fifth slot`).toBe(k);
        pinned++;
      }
    }
    expect(pinned, "some sport sits past the first five, so the pin is exercised").toBeGreaterThan(0);
  });
});

// C9 round 3 (controller ruling): the builder opens on the FIRST TILE the Sport step shows - the organisation's most
// recent sport, else football (the owner's popular order, 2026-11-03) - never on whatever the page listed first.
describe("the default sport is the first tile shown (C9 round 3)", () => {
  it("empty case first: no sports listed opens on none; only generic listed opens on generic", () => {
    expect(defaultSportKey([], [])).toBe("");
    expect(defaultSportKey([], ["football"])).toBe("");
    expect(defaultSportKey(["generic"], [])).toBe("generic");
    expect(defaultSportKey(["generic"], ["generic"])).toBe("generic");
  });

  it("no history: football, whatever order the page lists the registry in (the registry ships it, and not first)", () => {
    expect(REGISTRY, "premise: the registry ships football").toContain("football");
    // The witness: the page lists sports by name (d/new/page.tsx `order by name`; the key stands in), so its first row
    // is not football - opening on the page's first row would differ.
    expect([...REGISTRY].sort()[0], "witness: the page's first row is not football").not.toBe("football");
    expect(defaultSportKey(REGISTRY, [])).toBe("football");
    expect(defaultSportKey([...REGISTRY].sort(), [])).toBe("football");
    expect(defaultSportKey([...REGISTRY].reverse(), [])).toBe("football");
  });

  it("each registry sport as the most recent one opens on it, generic excepted (it stays last, so football opens) (counts)", () => {
    let checked = 0;
    for (const k of REGISTRY) {
      expect(defaultSportKey(REGISTRY, [k, "tennis"]), k).toBe(k === "generic" ? "tennis" : k);
      checked++;
    }
    expect(checked).toBe(REGISTRY.length);
    expect(defaultSportKey(REGISTRY, ["generic"])).toBe("football");
  });

  it("a history the page does not list is skipped; without football the next popular sport opens; it is always a listed sport", () => {
    expect(defaultSportKey(["badminton", "tennis", "generic"], ["hockey"])).toBe("badminton");
    expect(defaultSportKey(REGISTRY.filter((k) => k !== "football"), [])).toBe(POPULAR[1]);
    expect(defaultSportKey(["padel", "generic"], [])).toBe("padel");
    let listed = 0;
    for (let n = 1; n <= REGISTRY.length; n++) {
      const keys = REGISTRY.slice(-n);
      expect(keys, `${n}`).toContain(defaultSportKey(keys, []));
      listed++;
    }
    expect(listed).toBe(REGISTRY.length);
  });
});
