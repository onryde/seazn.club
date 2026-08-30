// v3/__tests__/period-class-order.test.ts — R6 FIX PASS 3, GAP 2.
//
// FOUND BY DRIVING THE PRODUCT. Hockey's umpire was offered, in this order:
//
//     Red card   Green card   Yellow card
//
// and ice hockey's:
//
//     Major  Match  Minor  Misconduct  Bench minor  Double minor  Game misconduct
//
// Neither is a ladder. Both are POSTGRES JSONB KEY ORDER: `cfg` reaches the
// pad through a jsonb column, and jsonb stores object keys sorted by LENGTH
// first, then bytewise — so `red`(3) leads `green`(5) leads `yellow`(6), and
// ice hockey's three five-letter classes (`major`, `match`, `minor`) float to
// the top while `game_misconduct`, the second-most severe thing an official
// can give, sinks to last for being long. `classOptions` read
// `Object.keys(cfg.suspensions.classes)` and nothing sorted them.
//
// An umpire reaching for a green card under time pressure taps red.
//
// WHY THE FIX IS THE SKIN'S DECLARATION ORDER, NOT A RUNTIME SORT. The task
// brief proposed ordering ice hockey by "ascending penalty minutes, which the
// module already derives — 2/4/5/10/20/25". That premise is FALSE against the
// real table (`sports/period/suspensions.ts`): `minutes` is 2/2/4/5/10/null/5
// — `match` is a FIVE-minute class carrying 25 PIM, so sorting by minutes puts
// the sport's most severe penalty fifth of seven, and `game_misconduct`'s
// `minutes: null` sorts nowhere at all. 2/4/5/10/20/25 is the PIM ladder, and
// `pim` is declared on only three of the seven classes.
//
// The ladder that IS total and unambiguous is the one each skin already
// declares — `HOCKEY_CLASSES` and `ICEHOCKEY_CLASSES` are written in severity
// order and are literals the skin owns. So the skin imposes its own order,
// which is what the brief's headline asked for, and this file pins that
// declared order against the ENGINE's own severity numbers so it cannot drift
// into a hand-maintained list nobody checks.

import { describe, expect, it } from "vitest";
import type { GuidedSheetSpec, PadHostView, SheetChoiceStep } from "../types";
import { hockeySkinV3, hockeySpec, HOCKEY_CLASSES } from "../skins/hockey";
import { icehockeySkinV3, icehockeySpec, ICEHOCKEY_CLASSES } from "../skins/icehockey";
import { orderedClassKeys, type PeriodSkinSpec } from "../skins/period-shared";
import { foldPeriod, hockey, icehockey, lineupsFor, periodCfg, shippedVariantCfgs, summaryOf } from "./_period-fold";
import type { AnySportModule } from "@seazn/engine/sport";
import { initSquads } from "@seazn/engine/core";

const T = ((key: string) => key) as never;

/**
 * REPRODUCE THE DEFECT'S OWN INPUT. Postgres jsonb does not preserve insertion
 * order: it sorts an object's keys by length, then bytewise. A test that fed
 * the pad `configSchema.parse({})` would be reading the ENGINE's declaration
 * order — which is already severity order — and would pass with no sort at
 * all, proving nothing. This is what production actually hands the pad.
 */
function jsonbOrder<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))) {
    out[k] = obj[k];
  }
  return out as T;
}

/** A cfg that has been through a jsonb column, classes and all. */
function throughJsonb(cfg: unknown): unknown {
  const c = cfg as { suspensions?: { classes?: Record<string, unknown> } };
  if (!c.suspensions?.classes) return cfg;
  return { ...c, suspensions: { ...c.suspensions, classes: jsonbOrder(c.suspensions.classes) } };
}

interface Sport {
  key: "hockey" | "icehockey";
  module: AnySportModule;
  spec: PeriodSkinSpec;
  factory: typeof hockeySkinV3;
  declared: Readonly<Record<string, readonly string[]>>;
}

const SPORTS: readonly Sport[] = [
  { key: "hockey", module: hockey as AnySportModule, spec: hockeySpec, factory: hockeySkinV3, declared: HOCKEY_CLASSES },
  { key: "icehockey", module: icehockey as AnySportModule, spec: icehockeySpec, factory: icehockeySkinV3, declared: ICEHOCKEY_CLASSES },
];

function liveView(sport: Sport, cfg: unknown): PadHostView {
  const state = foldPeriod(sport.module, cfg, [["core.start"]]);
  const squads = (state.squads ?? initSquads(lineupsFor(sport.module, cfg))) as PadHostView["squads"];
  return {
    cfg,
    state,
    summary: summaryOf(sport.module, state),
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads,
    events: [],
    contextOverrides: {},
  } as unknown as PadHostView;
}

/** The class step's options, exactly as the guided sheet offers them. */
function offeredClasses(sport: Sport, cfg: unknown): string[] {
  const sheet = sport.factory(T).sheets!(liveView(sport, cfg))["suspension-home"] as GuidedSheetSpec;
  const step = sheet.steps.find((s) => s.id === "class");
  // Narrowed rather than cast: the class step MUST be a choice step for the
  // question "in what order are the options offered" to mean anything at all.
  expect(step?.kind, `${sport.key}: the class step is not a choice step`).toBe("choice");
  return ((step as SheetChoiceStep).options ?? []).map((o) => o.id);
}

// ---------------------------------------------------------------------------
// 0. THE HARNESS IS NOT A MIRROR. If `jsonbOrder` did nothing, every assertion
//    below would pass against the unsorted code and this file would be
//    decoration. So prove it scrambles, and that it reproduces EXACTLY what
//    the walkthrough photographed.
// ---------------------------------------------------------------------------

describe("the jsonb reordering this test feeds in is the one production hands the pad", () => {
  it("hockey's cards come out of jsonb as red, green, yellow — the screenshot's own order", () => {
    expect(Object.keys(jsonbOrder(HOCKEY_CLASSES))).toEqual(["red", "green", "yellow"]);
    expect(Object.keys(HOCKEY_CLASSES)).not.toEqual(["red", "green", "yellow"]);
  });

  it("ice hockey's come out major, match, minor, misconduct, bench minor, double minor, game misconduct", () => {
    expect(Object.keys(jsonbOrder(ICEHOCKEY_CLASSES))).toEqual([
      "major",
      "match",
      "minor",
      "misconduct",
      "bench_minor",
      "double_minor",
      "game_misconduct",
    ]);
    expect(Object.keys(jsonbOrder(ICEHOCKEY_CLASSES))).not.toEqual(Object.keys(ICEHOCKEY_CLASSES));
  });
});

// ---------------------------------------------------------------------------
// 1. THE FIX. Whatever order the cfg arrives in, the sheet offers the ladder.
// ---------------------------------------------------------------------------

describe("the class picker is a severity ladder, never the order the cfg arrived in", () => {
  it("hockey offers green, yellow, red — FIH escalation — from a jsonb-ordered cfg", () => {
    const cfg = throughJsonb(periodCfg(hockey));
    expect(offeredClasses(SPORTS[0]!, cfg)).toEqual(["green", "yellow", "red"]);
  });

  it("ice hockey offers minor first and match last, from a jsonb-ordered cfg", () => {
    const cfg = throughJsonb(periodCfg(icehockey));
    expect(offeredClasses(SPORTS[1]!, cfg)).toEqual([
      "minor",
      "bench_minor",
      "double_minor",
      "major",
      "misconduct",
      "game_misconduct",
      "match",
    ]);
  });

  // One sample is not a sweep: `youth` and `recreational` carry different
  // class SETS, and a rule that only holds for the default cfg breaks in half
  // the divisions running it.
  for (const sport of SPORTS) {
    it(`${sport.key}: every shipped variant offers its classes in declared order, jsonb or not`, () => {
      const variants = shippedVariantCfgs(sport.module);
      expect(variants.length).toBeGreaterThan(0);
      const ladder = Object.keys(sport.declared);
      for (const { variant, cfg } of variants) {
        const offered = offeredClasses(sport, throughJsonb(cfg));
        if (offered.length === 0) continue; // a variant with no suspensions at all
        const expected = ladder.filter((k) => offered.includes(k));
        expect(offered, `${sport.key}/${variant}`).toEqual(expected);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. THE LADDER IS THE ENGINE'S, NOT A LIST SOMEBODY TYPED. Derived from the
//    module's own class table so it moves when a preset does — and so the
//    brief's false "ascending minutes" premise is recorded rather than
//    repeated.
// ---------------------------------------------------------------------------

describe("each skin's declared order really is ascending severity, by the engine's own numbers", () => {
  /** Penalty minutes on the scoresheet: explicit `pim` when the class carries
   *  one, else its `minutes`. A permanent class with no duration is the top of
   *  the ladder by definition. */
  function severityOf(cls: Record<string, unknown>): number {
    if (typeof cls.pim === "number") return cls.pim;
    if (typeof cls.minutes === "number") return cls.minutes;
    return Number.POSITIVE_INFINITY;
  }

  for (const sport of SPORTS) {
    it(`${sport.key}: the skin's declaration order is non-decreasing in severity`, () => {
      const classes = (periodCfg(sport.module) as { suspensions: { classes: Record<string, Record<string, unknown>> } })
        .suspensions.classes;
      const ladder = Object.keys(sport.declared).filter((k) => k in classes);
      expect(ladder.length).toBeGreaterThan(1);
      const scores = ladder.map((k) => severityOf(classes[k]!));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i], `${sport.key}: ${ladder[i - 1]} -> ${ladder[i]} goes DOWN in severity`).toBeGreaterThanOrEqual(
          scores[i - 1]!,
        );
      }
    });
  }

  it("ice hockey's ladder is the PIM ladder 2/2/4/5/10/20/25 — NOT the minutes column", () => {
    const classes = (periodCfg(icehockey) as { suspensions: { classes: Record<string, Record<string, unknown>> } })
      .suspensions.classes;
    const ladder = Object.keys(ICEHOCKEY_CLASSES);
    expect(ladder.map((k) => severityOf(classes[k]!))).toEqual([2, 2, 4, 5, 10, 20, 25]);
    // The brief said to sort by `minutes`. Pinned as a FALSE premise: `match`
    // is 5 minutes and would land mid-ladder, and `game_misconduct` is null.
    expect(classes.match!.minutes).toBe(5);
    expect(classes.game_misconduct!.minutes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. A CLASS THE SKIN NEVER HEARD OF. An organiser can add one to cfg; it must
//    still be offerable (never silently dropped — that would take an option
//    away from an official), just after the ladder it is not part of.
// ---------------------------------------------------------------------------

describe("orderedClassKeys", () => {
  it("keeps an undeclared class, placed after every declared one, in cfg order", () => {
    const cfg = jsonbOrder({ zzz_custom: {}, red: {}, green: {}, aaa_custom: {}, yellow: {} });
    expect(orderedClassKeys(hockeySpec, cfg)).toEqual(["green", "yellow", "red", "aaa_custom", "zzz_custom"]);
  });

  it("drops nothing and invents nothing — the cfg decides membership, the skin decides order", () => {
    const cfg = jsonbOrder({ red: {}, green: {} }); // no yellow in this division
    expect(orderedClassKeys(hockeySpec, cfg)).toEqual(["green", "red"]);
  });

  it("an empty cfg offers nothing", () => {
    expect(orderedClassKeys(hockeySpec, {})).toEqual([]);
  });
});
