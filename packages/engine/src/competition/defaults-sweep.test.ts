// W2d Task 11 (spec §5.10, §13.4; D5, D8, D10(f), B5, OC1, OC3, PS-7c; rule rows X-TB-1, X-TB-3, FB-TB-1, FB-TB-2,
// FB-TB-4, HK-PT-2, BG-PT-1, BG-TB-1, BG-TB-2) — the sweep of every sport's signed default order and its stage presets.
//
// Expected values come from the signed table (SPEC §5.10, typed below) and from the engine's own declarations
// (`primaryTableKey`, `reachableOutcomes`, `validateCascade`), never from `defaultTiebreakers` itself. The Swiss orders are
// the pre-W2d lists (OC1: "Swiss stages keep their current per-sport orders"), typed from the plan's Anchors row
// (main@e97823e4d8 `defaultTiebreakers`), so a Swiss order the lane changed by accident reds here.
//
// Sequence (TEST-STRATEGY rule 1): every sport × every declared cfg × every table kind, Swiss counted apart; the empty
// case first (an order of nothing is refused, so the sweep can never pass on an empty default); a second call; football
// with fair play off (PS-7c).
import { describe, expect, it } from "vitest";
import { DRAW_KINDS } from "../core/types.ts";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "../sport/module.ts";
// single-sport: football is the one sport whose cfg carries `fairPlay` (D8), the cfg PS-7c's default reads
import { football } from "../sports/football/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { validateCascade } from "./cascade-rules.ts";
import { coverage, PointsRule, reachableOutcomes } from "./points.ts";
import { resolveTableRules } from "./table-rules.ts";

// The kinds that keep a table — the engine's own declaration (`DRAW_KINDS`): league, group, swiss, americano.
const TABLE_KINDS = [...DRAW_KINDS] as TableStageKind[];

type Order = readonly TiebreakerKey[];

// SPEC §5.10, the signed round-robin, league and group defaults (D5), one per sport key. The tennis order repeats
// `h2h_two` after each step (OC3; ATP C.3, RBS:370-371).
const FIFA2026: Order = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
const SIGNED: Readonly<Record<string, Order>> = {
  football: FIFA2026,
  hockey: ["points", "wins", "diff", "for", "h2h_points", "h2h_wins", "h2h_diff", "h2h_for", "field_goals", "lots"],
  icehockey: ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "seed", "lots"],
  boardgame: ["points", "direct", "wins", "sberger", "lots"],
  cricket: ["points", "wins", "nrr", "h2h_points", "seed", "lots"],
  volleyball: ["wins", "points", "set_ratio", "point_ratio", "h2h_points", "lots"],
  badminton: ["wins", "h2h_two", "set_diff", "h2h_two", "point_diff", "h2h_two", "lots"],
  tabletennis: ["points", "h2h_points", "h2h_set_ratio", "h2h_point_ratio", "h2h_exclusion", "lots"],
  tennis: ["wins", "matches_played", "h2h_two", "set_ratio", "h2h_two", "game_ratio", "h2h_two", "seed", "lots"],
  carrom: ["points", "wins", "set_ratio", "board_ratio", "point_ratio", "h2h_points", "lots"],
  generic: ["points", "diff", "for", "h2h_points", "lots"],
};

// OC1: the Swiss orders before W2d (plan Anchors row, main@e97823e4d8), unchanged.
const SWISS: Readonly<Record<string, Order>> = {
  football: FIFA2026,
  hockey: ["points", "diff", "for", "h2h_points", "seed"],
  icehockey: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed"],
  boardgame: ["points", "buchholz_cut1", "buchholz", "sberger", "direct", "wins", "lots"],
  cricket: ["points", "wins", "nrr", "h2h_points", "seed"],
  volleyball: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  badminton: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  tabletennis: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  tennis: ["points", "set_ratio", "game_ratio", "h2h_points", "seed"],
  carrom: ["points", "wins", "set_ratio", "board_ratio", "point_ratio", "h2h_points", "lots"],
  generic: ["points", "diff", "for", "h2h_points", "lots"],
};

// SPEC §5.10's stage presets, by sport: football's named orders (`uefa` = fifa2026 with `h2h_reapply` after the block;
// `classic` = `FOOTBALL_TIEBREAKERS.classic`, the pre-2026 World Cup order), hockey's FIH Pro League points (HK-PT-2: a drawn
// match goes to a shoot-out booked D 1 each, its winner +1, so 2/1; regulation W 3, L 0 — B2), chess's FIDE 1/½/0 in
// half-points and the 3/1/0 "football scoring" some opens use (BG-PT-1, RB2B-18), never on a Swiss stage. No other
// sport declares a preset.
const PRESET_ORDERS: Readonly<Record<string, Readonly<Record<string, Order>>>> = {
  football: {
    fifa2026: FIFA2026,
    uefa: ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "fair_play", "lots"],
    classic: ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"],
  },
};
const PRO_LEAGUE = { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, soBonus: 1, shootoutAs: "draw_plus_bonus", unit: "whole", bonuses: [] };
const FIDE = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "half", bonuses: [] };
const THREE_ONE_ZERO = { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] };
const PRESET_POINTS: Readonly<Record<string, (kind: TableStageKind) => Readonly<Record<string, unknown>>>> = {
  hockey: () => ({ pro_league: PRO_LEAGUE }),
  boardgame: (kind) => (kind === "swiss" ? { fide_1_half_0: FIDE } : { fide_1_half_0: FIDE, three_one_zero: THREE_ONE_ZERO }),
};

/** The order a stage with nothing of its own and no division order ranks by: the product's one resolver (X-TB-1). */
function defaultOrder(module: AnySportModule, kind: TableStageKind, cfg: unknown): Order {
  return resolveTableRules({
    module,
    stageKind: kind,
    mergedCfg: cfg,
    stageOwn: { points: null, tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  }).tiebreakers;
}

describe("W2d T11 — every sport's signed default order (spec §5.10, §13.4)", () => {
  it("states the empty case first: an empty order is refused for every stage kind, so no sweep below can pass on an empty default", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const kind of TABLE_KINDS) {
        expect(validateCascade([], { module, cfg: declaredCfgs(module)[0]!.cfg, stageKind: kind, crossGroup: false })).toEqual([
          { index: -1, key: null, reason: "empty" },
        ]);
        checked++;
      }
    });
    expect(TABLE_KINDS, "premise: the four kinds that keep a table").toEqual(["league", "group", "swiss", "americano"]);
    expect(checked).toBe(Object.keys(SIGNED).length * TABLE_KINDS.length);
  });

  it("X-TB-3 FB-TB-1 BG-TB-1 every sport × declared cfg × table kind: the default passes validateCascade, a non-Swiss one starts with primaryTableKey and ends in exactly one lots, and its cross-group order passes too (Swiss skips the shape rule only, OC1; counted, Swiss cells apart)", () => {
    let nonSwiss = 0;
    let swiss = 0;
    let fairPlayOff = 0;
    let fairPlayDropped = 0;
    const sports: string[] = [];
    forEachSport(({ module }) => {
      sports.push(module.key);
      const signed = SIGNED[module.key];
      const swissOrder = SWISS[module.key];
      expect(signed, `${module.key}: SPEC §5.10 names its default`).toBeDefined();
      expect(swissOrder, `${module.key}: the plan's Anchors row names its Swiss order`).toBeDefined();
      // Every declared cfg, and each again with fair play switched off (FB-TB-4, PS-7c): no declared cfg turns it off, so
      // without the second set the sweep could never see a default that kept a step its division does not track. A sport
      // whose schema has no `fairPlay` strips the key, and its expected order has no fair_play step to drop.
      const cfgs = declaredCfgs(module).flatMap(({ name, cfg }) => {
        const off = module.configSchema.safeParse({ ...(cfg as object), fairPlay: false });
        expect(off.success, `${module.key} ${name}: fairPlay false parses`).toBe(true);
        return [{ name, cfg, tracked: true }, { name: `${name} fairPlay off`, cfg: off.data as unknown, tracked: false }];
      });
      for (const { name, cfg, tracked } of cfgs) {
        const expectSigned = tracked ? signed : signed?.filter((key) => key !== "fair_play");
        const expectSwiss = tracked ? swissOrder : swissOrder?.filter((key) => key !== "fair_play");
        if (!tracked) fairPlayOff++;
        if (!tracked && expectSigned?.length !== signed?.length) fairPlayDropped++;
        for (const kind of TABLE_KINDS) {
          const label = `${module.key} ${name} ${kind}`;
          const order = defaultOrder(module, kind, cfg);
          const ctx = { module, cfg, stageKind: kind, crossGroup: false } as const;
          expect(validateCascade(order, ctx), label).toEqual([]);
          // The cross-group order (§5.9) is the default without its head-to-head steps; rule 4 never refuses it.
          const rules = resolveTableRules({ module, stageKind: kind, mergedCfg: cfg, stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null });
          expect(validateCascade(rules.crossGroup, { ...ctx, crossGroup: true }), `${label} cross-group`).toEqual([]);
          if (kind === "swiss") {
            expect(order, `${label}: OC1, the Swiss order is unchanged`).toEqual(expectSwiss);
            swiss++;
          } else {
            expect(order, `${label}: SPEC §5.10`).toEqual(expectSigned);
            // X-TB-3 read off the order itself, beside the validator: the primary measure first, lots last and once.
            expect(order[0], `${label}: step 0`).toBe(module.primaryTableKey);
            expect(order.at(-1), `${label}: last step`).toBe("lots");
            expect(order.filter((key) => key === "lots"), `${label}: lots once`).toHaveLength(1);
            nonSwiss++;
          }
          // A second call answers the same, and a fresh list (the caller owns it).
          const again = module.defaultTiebreakers(kind, module.configSchema.parse(cfg));
          expect(again, `${label}: a second call`).toEqual(order);
          expect(again, `${label}: a fresh list`).not.toBe(module.defaultTiebreakers(kind, module.configSchema.parse(cfg)));
        }
      }
    });
    expect(sports.sort()).toEqual(Object.keys(SIGNED).sort());
    expect(nonSwiss, "non-Swiss cells checked").toBeGreaterThanOrEqual(sports.length * 3);
    expect(swiss, "Swiss cells checked (OC1: the shape rule skipped, the key and format rules run)").toBeGreaterThanOrEqual(sports.length);
    expect(nonSwiss).toBe(swiss * 3);
    // Anti-vacuity for the fair-play-off half: it ran for every declared cfg, and at least one signed order lost a step.
    expect(fairPlayOff, "fair-play-off cfgs checked").toBeGreaterThanOrEqual(sports.length);
    expect(fairPlayDropped, "a fair-play-off cfg whose signed order drops fair_play").toBeGreaterThan(0);
  });

  it("OC1 the Swiss orders really are exempt, not merely valid: every sport's Swiss order run as a league is refused 'first' or 'last' where it breaks the shape (counted)", () => {
    // The positive pair of the Swiss half above: a Swiss order is accepted BECAUSE OC1 skips the shape rule, not because
    // it happens to fit it. Expected from X-TB-3's text against each typed Swiss order.
    let shapeBroken = 0;
    let checked = 0;
    forEachSport(({ module }) => {
      const order = SWISS[module.key]!;
      const cfg = declaredCfgs(module)[0]!.cfg;
      const asLeague = validateCascade(order, { module, cfg, stageKind: "league", crossGroup: false }).map((r) => r.reason);
      const breaks = order[0] !== module.primaryTableKey || order.at(-1) !== "lots";
      expect(asLeague.some((reason) => reason === "first" || reason === "last"), module.key).toBe(breaks);
      if (breaks) shapeBroken++;
      checked++;
    });
    expect(checked).toBe(Object.keys(SWISS).length);
    // Read off the typed Swiss lists: hockey, ice hockey and cricket end on seed; volleyball, badminton and tennis start
    // with points where they rank on wins; table tennis ends on h2h_points. Football, chess, carrom and generic fit.
    expect(shapeBroken, "anti-vacuity: Swiss orders the shape rule would refuse").toBe(7);
  });

  it("PS-7c FB-TB-4 football: the default omits fair_play when the division's cfg does not track it and holds it when it does; both pass validateCascade", () => {
    // single-sport: football is the one sport whose cfg carries `fairPlay` (D8); SPEC §5.10's fifa2026 row with and without
    // its fair-play step.
    const withFairPlay: Order = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
    const withoutFairPlay: Order = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "lots"];
    const on = football.configSchema.parse({ fairPlay: true });
    const off = football.configSchema.parse({ fairPlay: false });
    let checked = 0;
    for (const kind of TABLE_KINDS) {
      expect(defaultOrder(football, kind, on), `${kind} on`).toEqual(withFairPlay);
      expect(defaultOrder(football, kind, off), `${kind} off`).toEqual(withoutFairPlay);
      expect(validateCascade(defaultOrder(football, kind, on), { module: football, cfg: on, stageKind: kind, crossGroup: false })).toEqual([]);
      expect(validateCascade(defaultOrder(football, kind, off), { module: football, cfg: off, stageKind: kind, crossGroup: false })).toEqual([]);
      checked++;
    }
    expect(checked).toBe(TABLE_KINDS.length);
  });

  it("PS-7c the football default and validateCascade read fair play the ONE way: over cfgs a hand-written `cfg.fairPlay` test would read differently (raw partial, schema-refused, truthy non-boolean), the default holds fair_play exactly when the validator accepts it", () => {
    // single-sport: football is the one sport whose cfg carries `fairPlay` (D8).
    // Each cfg is one where a second, hand-written reading would disagree with the validator's (`tracksFairPlay`: parsed
    // through the schema when it parses, else read as given, and only `true` counts):
    //   {}                        — raw: `cfg.fairPlay` is undefined, the schema's default is true;
    //   { fairPlay: "yes" }       — refused by the schema; truthy, but not `true`;
    //   { fairPlay: true, points: 7 } — a refused cfg that still says true (read as given, as the fold reads it);
    //   { fairPlay: 1 }           — refused; truthy, not `true`.
    const cfgs: { label: string; cfg: unknown; tracks: boolean }[] = [
      { label: "raw {}", cfg: {}, tracks: true },
      { label: "refused, 'yes'", cfg: { fairPlay: "yes" }, tracks: false },
      { label: "refused, true", cfg: { fairPlay: true, points: 7 }, tracks: true },
      { label: "refused, 1", cfg: { fairPlay: 1 }, tracks: false },
      { label: "parsed on", cfg: football.configSchema.parse({ fairPlay: true }), tracks: true },
      { label: "parsed off", cfg: football.configSchema.parse({ fairPlay: false }), tracks: false },
    ];
    let checked = 0;
    for (const { label, cfg, tracks } of cfgs) {
      // The premise: the schema really parses or refuses each as described.
      const parses = football.configSchema.safeParse(cfg).success;
      expect(parses, `${label}: premise`).toBe(!label.startsWith("refused"));
      for (const kind of TABLE_KINDS) {
        // Asked directly (not through the resolver, which parses first), so an unparsed cfg reaches the default as given.
        const order = football.defaultTiebreakers(kind, cfg as never);
        const accepted = validateCascade(FIFA2026, { module: football, cfg, stageKind: kind, crossGroup: false }).length === 0;
        expect(accepted, `${label} ${kind}: the validator`).toBe(tracks);
        expect(order.includes("fair_play"), `${label} ${kind}: the default`).toBe(accepted);
        checked++;
      }
    }
    expect(checked).toBe(cfgs.length * TABLE_KINDS.length);
  });
});

describe("W2d T11 — the stage presets (spec §5.10; tablePresets)", () => {
  it("FB-TB-2 HK-PT-2 BG-PT-1 every sport × table kind: the presets are exactly SPEC §5.10's, every preset order passes validateCascade under every declared cfg, and every preset points rule is a PointsRule that covers reachableOutcomes (counted)", () => {
    let orders = 0;
    let rules = 0;
    let declaring = 0;
    forEachSport(({ module }) => {
      const wantOrders = PRESET_ORDERS[module.key] ?? {};
      const wantPoints = PRESET_POINTS[module.key];
      for (const kind of TABLE_KINDS) {
        const presets = module.tablePresets?.(kind) ?? { points: [], tiebreakers: [] };
        const label = `${module.key} ${kind}`;
        expect(Object.fromEntries(presets.tiebreakers.map((p) => [p.id, [...p.keys]])), `${label} orders`).toEqual(wantOrders);
        expect(Object.fromEntries(presets.points.map((p) => [p.id, p.rule])), `${label} points`).toEqual(wantPoints?.(kind) ?? {});
        if (presets.points.length + presets.tiebreakers.length > 0) declaring++;
        for (const { name, cfg } of declaredCfgs(module)) {
          for (const preset of presets.tiebreakers) {
            expect(validateCascade(preset.keys, { module, cfg, stageKind: kind, crossGroup: false }), `${label} ${name} ${preset.id}`).toEqual([]);
            orders++;
          }
          for (const preset of presets.points) {
            // A preset is a whole rule as the schema reads it: parsing it changes nothing.
            expect(PointsRule.parse(preset.rule), `${label} ${preset.id} parses`).toEqual(preset.rule);
            expect(coverage(preset.rule, reachableOutcomes(module, cfg, kind)), `${label} ${name} ${preset.id} coverage`).toEqual({ ok: true });
            rules++;
          }
        }
      }
    });
    expect(orders, "preset orders checked").toBeGreaterThan(0);
    expect(rules, "preset points rules checked").toBeGreaterThan(0);
    // football 4 kinds, hockey 4, boardgame 4.
    expect(declaring, "sport × kind cells that declare a preset").toBe(3 * TABLE_KINDS.length);
  });

  it("BG-PT-1 chess's 3/1/0 preset is a round-robin preset only: absent on swiss, present on every other table kind, and no other sport offers it", () => {
    // SPEC §5.10 chess / boardgame: "Preset 3/1/0 on non-Swiss stages".
    let present = 0;
    let absent = 0;
    forEachSport(({ module }) => {
      for (const kind of TABLE_KINDS) {
        const ids = (module.tablePresets?.(kind)?.points ?? []).map((p) => p.id);
        if (module.key === "boardgame" && kind !== "swiss") {
          expect(ids, `${module.key} ${kind}`).toContain("three_one_zero");
          present++;
        } else {
          expect(ids, `${module.key} ${kind}`).not.toContain("three_one_zero");
          absent++;
        }
      }
    });
    expect(present, "boardgame's non-swiss table kinds").toBe(TABLE_KINDS.filter((k) => k !== "swiss").length);
    expect(present).toBeGreaterThan(0);
    expect(present + absent).toBe(Object.keys(SIGNED).length * TABLE_KINDS.length);
  });

  it("FB-TB-4 a football preset under a division that does not track fair play is refused at its fair_play step only — the editor must drop that step (the preset list takes no cfg)", () => {
    // single-sport: football is the one sport whose presets hold fair_play (D8).
    const off = football.configSchema.parse({ fairPlay: false });
    let checked = 0;
    for (const kind of TABLE_KINDS) {
      for (const preset of football.tablePresets?.(kind)?.tiebreakers ?? []) {
        expect(validateCascade(preset.keys, { module: football, cfg: off, stageKind: kind, crossGroup: false }), `${kind} ${preset.id}`).toEqual([
          { index: preset.keys.indexOf("fair_play"), key: "fair_play", reason: "fair_play_off", need: "fairPlay" },
        ]);
        const dropped = preset.keys.filter((key) => key !== "fair_play");
        expect(validateCascade(dropped, { module: football, cfg: off, stageKind: kind, crossGroup: false }), `${kind} ${preset.id} without fair_play`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(3 * TABLE_KINDS.length);
  });
});
