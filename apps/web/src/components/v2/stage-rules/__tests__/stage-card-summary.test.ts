// Match Day C3 (spec 2026-10-31 §12 Phase C items 5, 6, 12) - the stage card's summary line, as the pure answers it is built from:
// what the stage pays in one phrase, whether its points / tie-break order differ from the division's, and which of the three
// rules sections to name when it does. Expected values come from the engine's declarations (`tablePointsRule`,
// `defaultTiebreakers`, `reachableOutcomes` through the sport registry) and the en dictionary - never from the code under test.
// Every sweep counts what it checked, and zero is a failure.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { PointsRule } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { pointsLineDict } from "@/lib/rules-line";
import { pointsDiffer } from "../stage-points-model";
import { stagePointsHeadline } from "../../rules/points-editor";
import { inheritedOrder } from "../stage-tiebreaks-model";
import { cfgOf, tableRulesOf } from "./_table-rules-fixture";

const UI = enUi as Record<string, string>;
const msg = (key: MessageKey, vars?: Record<string, string | number>): string => {
  let out = UI[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replaceAll(`{${k}}`, String(v));
  return out;
};
const POINTS_DICT = pointsLineDict(enPublic as Dict);
const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const badminton = sport("badminton"); // single-sport: the set-table sport the owner's screenshot shows ("Win 2 · Loss 0")
const football = sport("football"); // single-sport: a draw-able rule with no set table

const stageOf = (kind: TableStageKind) => ({ kind, config: {} });
/** The rule a stage of this sport/kind plays by the engine's own declaration. */
const sportRule = (m: AnySportModule, kind: TableStageKind): PointsRule => m.tablePointsRule(m.configSchema.parse(cfgOf(m)), kind);
/** The same rule paying one more point for a regulation win: the smallest rule that is not the sport's. */
const richer = (rule: PointsRule): PointsRule => {
  const win = rule.win?.regulation;
  if (rule.bySetScore !== undefined) {
    return { ...rule, bySetScore: Object.fromEntries(Object.entries(rule.bySetScore).map(([k, v]) => [k, [v[0] + 1, v[1]]])) } as PointsRule;
  }
  return { ...rule, win: { ...rule.win, regulation: (win ?? 0) + 1 } } as PointsRule;
};

describe("pointsDiffer (item 12: a stage that differs says so)", () => {
  it("a stage reading the live layers, with no rule of its own and no pin, does not differ", () => {
    expect(pointsDiffer(badminton, cfgOf(badminton), stageOf("league"), null, null)).toBe(false);
    expect(pointsDiffer(football, cfgOf(football), stageOf("league"), null, null)).toBe(false);
  });

  it("its own rule that pays something else differs; one that pays what the division pays does not", () => {
    for (const m of [badminton, football]) {
      const base = sportRule(m, "league");
      expect(pointsDiffer(m, cfgOf(m), stageOf("league"), richer(base), null), `${m.key}: richer`).toBe(true);
      expect(pointsDiffer(m, cfgOf(m), stageOf("league"), base, null), `${m.key}: the same rule`).toBe(false);
    }
  });

  it("a pin that no longer matches the live division differs (the division's points moved after the stage started)", () => {
    const base = sportRule(badminton, "league");
    expect(pointsDiffer(badminton, cfgOf(badminton), stageOf("league"), null, richer(base))).toBe(true);
    expect(pointsDiffer(badminton, cfgOf(badminton), stageOf("league"), null, base)).toBe(false);
  });

  it("key order of a stored rule is not a difference (jsonb does not keep it)", () => {
    const base = sportRule(football, "league");
    const shuffled = Object.fromEntries(Object.entries(base).reverse()) as PointsRule;
    expect(pointsDiffer(football, cfgOf(football), stageOf("league"), shuffled, null)).toBe(false);
  });

  it("a stage kind with no table says nothing (a bracket has no points to differ)", () => {
    expect(pointsDiffer(badminton, cfgOf(badminton), { kind: "knockout", config: {} }, null, null)).toBe(false);
  });

  it("sweeps every sport and table kind: an unchanged stage never differs, one paying a richer rule always does", () => {
    let visited = 0;
    const kinds: TableStageKind[] = ["league", "group", "swiss"];
    for (const m of builtinModules) {
      for (const kind of kinds) {
        const cfg = cfgOf(m);
        const base = sportRule(m, kind);
        if (base === undefined) continue;
        expect(pointsDiffer(m, cfg, stageOf(kind), null, null), `${m.key} ${kind}: live`).toBe(false);
        expect(pointsDiffer(m, cfg, stageOf(kind), null, richer(base)), `${m.key} ${kind}: richer pin`).toBe(true);
        visited++;
      }
    }
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThanOrEqual(builtinModules.length * kinds.length);
  });
});

describe("stagePointsHeadline (the Points clause of the summary line)", () => {
  const args = (m: AnySportModule, kind: TableStageKind, over: { stored?: unknown; pinned?: unknown } = {}) => ({
    module: m,
    kind,
    stageConfig: {},
    divisionConfig: cfgOf(m) as Record<string, unknown>,
    stored: over.stored ?? null,
    pinned: over.pinned ?? null,
    pointsDict: POINTS_DICT,
  });

  it("a set table that pays every score the same is 'Win W · Loss L', the numbers the engine's own rule pays", () => {
    const rule = sportRule(badminton, "league");
    const pair = rule.bySetScore!["*"]!;
    expect(stagePointsHeadline(args(badminton, "league"), msg)).toBe(
      UI["stageCard.points.uniform"]!.replace("{w}", String(pair[0])).replace("{l}", String(pair[1])),
    );
  });

  it("follows what the stage plays: its own rule, else its pin, else the live layers", () => {
    const base = sportRule(badminton, "league");
    const rich = richer(base);
    const pair = rich.bySetScore!["*"]!;
    const said = (w: number, l: number) => UI["stageCard.points.uniform"]!.replace("{w}", String(w)).replace("{l}", String(l));
    expect(stagePointsHeadline(args(badminton, "league", { stored: rich }), msg), "own rule").toBe(said(pair[0], pair[1]));
    expect(stagePointsHeadline(args(badminton, "league", { pinned: rich }), msg), "pin").toBe(said(pair[0], pair[1]));
    expect(stagePointsHeadline(args(badminton, "league", { stored: base, pinned: rich }), msg), "an own rule outranks a pin").toBe(
      said(base.bySetScore!["*"]![0], base.bySetScore!["*"]![1]),
    );
  });

  it("a sport that can draw is the public points line's first clause, capitalised (win, draw, loss)", () => {
    const line = stagePointsHeadline(args(football, "league"), msg);
    expect(line).not.toBeNull();
    expect(line!.charAt(0)).toBe(line!.charAt(0).toUpperCase());
    expect(line!.toLowerCase()).toContain("win");
    expect(line!.toLowerCase()).toContain("draw");
    expect(line!, "one clause, not the whole sentence").not.toContain("walkover");
  });

  it("without the public dictionary a draw-able rule says nothing (no invented English)", () => {
    expect(stagePointsHeadline({ ...args(football, "league"), pointsDict: undefined }, msg)).toBeNull();
  });

  it("a stage with no table says nothing", () => {
    expect(stagePointsHeadline(args(badminton, "knockout" as TableStageKind), msg)).toBeNull();
  });
});

describe("inheritedOrder (the order a stage would rank by if it followed the division today)", () => {
  it("is the division's own order when it sets one, else the sport's default for the stage", () => {
    const division: TiebreakerKey[] = ["points", "for", "diff", "lots"];
    const rules = tableRulesOf(football, "league");
    expect(inheritedOrder(division, rules)).toEqual(division);
    expect(inheritedOrder(null, rules)).toEqual(football.defaultTiebreakers("league", cfgOf(football)));
  });

  it("sweeps every sport and table kind: with no division order, it is exactly the engine's default", () => {
    let visited = 0;
    for (const m of builtinModules) {
      for (const kind of ["league", "group", "swiss"] as const) {
        expect(inheritedOrder(null, tableRulesOf(m, kind)), `${m.key} ${kind}`).toEqual(m.defaultTiebreakers(kind, cfgOf(m)));
        visited++;
      }
    }
    expect(visited).toBe(builtinModules.length * 3);
  });
});
