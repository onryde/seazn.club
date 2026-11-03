// The 4-step builder's pure decisions (Match Day C9): the entrant kind it opens at and sends, the four formats it
// suggests, and the step a server refusal belongs to. Expected values come from the engine's own declarations (each
// sport module's entrant model) and the rulebook draw sizes, never from the module under test.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { STAGE_TEMPLATES, templatesForSport } from "@/lib/format-templates";
import {
  BUILDER_STEPS,
  SUGGESTED_COUNT,
  entrantKindAfterSportChange,
  entrantsConfigFor,
  firstBlockedStep,
  rankTemplates,
  stepForCreateError,
  suggestTemplates,
} from "../model";

const KNOBS = { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 };
const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};

describe("entrant kind", () => {
  it("every sport opens at the engine's default kind and sends NOTHING for it, so the payload is the one the server defaults (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      expect(entrantsConfigFor(model, model.defaultKind), m.key).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(5);
  });

  it("a kind other than the sport's default is sent as the default kind, with every kind the sport allows kept (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      for (const kind of model.kinds) {
        if (kind === model.defaultKind) continue;
        expect(entrantsConfigFor(model, kind), `${m.key} ${kind}`).toEqual({ kinds: [...model.kinds], defaultKind: kind });
        checked++;
      }
    }
    // badminton, tennis, table tennis, carrom: pair; volleyball: pair; generic: team + pair.
    expect(checked).toBeGreaterThanOrEqual(6);
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

  it("every sport gets exactly four distinct suggestions, all from its own offer (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const offered = templatesForSport(m.key).map((t) => t.key);
      const picks = suggestTemplates(offered, plan, KNOBS);
      expect(picks.length, m.key).toBe(Math.min(SUGGESTED_COUNT, offered.length));
      expect(new Set(picks).size, m.key).toBe(picks.length);
      for (const p of picks) expect(offered, `${m.key} ${p}`).toContain(p);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(SUGGESTED_COUNT).toBe(4);
  });

  it("the full ranking is a permutation of the offer: Show all loses no format (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const offered = templatesForSport(m.key).map((t) => t.key);
      expect(rankTemplates(offered, plan, KNOBS).map((r) => r.key).sort(), m.key).toEqual([...offered].sort());
      checked += offered.length;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a format with no fixed draw (ladder) is never suggested ahead of four that have one", () => {
    const offered = STAGE_TEMPLATES.filter((t) => !t.retired).map((t) => t.key);
    expect(suggestTemplates(offered, plan, KNOBS)).not.toContain("ladder");
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
