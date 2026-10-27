// W2d Task 15 (spec §9, D3, D11, OC1, OC2; rule rows X-TB-1, X-TB-2, X-TB-3) — the stage editor's Tie-breaks section, as
// the pure answers its component renders. Expected values come from the rulebook (the spec's §5.5 rules, §5.10's signed
// table) and the engine's own declarations (`primaryTableKey`, `defaultTiebreakers`, `tablePresets`, `resolveTableRules`),
// never from the model under test. Every sweep counts what it checked, and zero is a failure.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { offerableKeys, validateCascade, type CascadeContext, type TableRulesPin } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { cfgOf, tableRulesOf } from "./_table-rules-fixture";
import {
  addPosition,
  addableAt,
  crossGroupLine,
  insertStep,
  moveStep,
  orderHint,
  removeStep,
  resetChoices,
  resetOrder,
  sectionControls,
  sectionLocked,
  stagePooled,
  takesBestNthFrom,
  tiebreakBadge,
  tiebreakRows,
  type StageLike,
} from "../stage-tiebreaks-model";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const football = sport("football");
const badminton = sport("badminton");
const boardgame = sport("boardgame");

/** The table stage kinds (`TableStageKind`), Swiss apart: §5.5 rule 1's first/last shape binds every one of them. */
const NON_SWISS: readonly TableStageKind[] = ["league", "group", "americano"];
/** Spec §5.6: the keys INSIDE an h2h block (the mini-table). A block modifier closes the block directly before it (rule 5). */
const H2H_BLOCK: ReadonlySet<TiebreakerKey> = new Set(["h2h_points", "h2h_diff", "h2h_for", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio"]);
const MODIFIERS: ReadonlySet<TiebreakerKey> = new Set(["h2h_reapply", "h2h_exclusion"]);
/** Spec §5.5 rule 4 (D3): the keys that compare tied entrants with each other. */
const isH2H = (k: TiebreakerKey) => k.startsWith("h2h_") || k === "direct";

const ctxOf = (m: AnySportModule, stageKind: TableStageKind, cfg: unknown = cfgOf(m)): CascadeContext => ({ module: m, cfg, stageKind, crossGroup: false });

describe("X-TB-3 the pinned shape (D11, OC1)", () => {
  it("X-TB-3 non-Swiss: row 1 is the primary measure pinned 'first' (no arrows, no remove); the last row is lots pinned 'last'", () => {
    let checked = 0;
    const visited = forEachSport(({ module: m }) => {
      for (const kind of NON_SWISS) {
        const keys = m.defaultTiebreakers(kind, cfgOf(m));
        const rows = tiebreakRows(keys, ctxOf(m, kind), false);
        expect(rows.map((r) => r.key), `${m.key} ${kind}: one row per step, in order`).toEqual(keys);
        const first = rows[0]!;
        expect([first.key, first.pinned], `${m.key} ${kind}: the sport's primary measure, pinned first`).toEqual([m.primaryTableKey, "first"]);
        expect([first.canUp, first.canDown, first.canRemove], `${m.key} ${kind}: no arrows, no remove on row 1`).toEqual([false, false, false]);
        const last = rows[rows.length - 1]!;
        expect([last.key, last.pinned], `${m.key} ${kind}: lots, pinned last`).toEqual(["lots", "last"]);
        expect([last.canUp, last.canDown, last.canRemove]).toEqual([false, false, false]);
        const middle = rows.slice(1, -1);
        for (const [i, r] of middle.entries()) {
          expect(r.pinned, `${m.key} ${kind}: middle rows move`).toBeNull();
          expect(r.canRemove).toBe(true);
          expect(r.canUp, `${m.key} ${kind} row ${i + 2}: up, except the first middle row (it would pass the primary)`).toBe(i > 0);
          expect(r.canDown, `${m.key} ${kind} row ${i + 2}: down, except the last middle row (it would pass lots)`).toBe(i < middle.length - 1);
          checked++;
        }
        expect(rows.every((r) => r.refusal === undefined), `${m.key} ${kind}: the sport's own default is valid`).toBe(true);
      }
    });
    expect(visited, "sports swept").toBeGreaterThan(5);
    expect(checked, "middle rows checked").toBeGreaterThan(20);
  });

  it("X-TB-3 OC1 a Swiss stage shows no pinned rows (its shape is W3's)", () => {
    let rows = 0;
    const visited = forEachSport(({ module: m }) => {
      const keys = m.defaultTiebreakers("swiss", cfgOf(m));
      for (const r of tiebreakRows(keys, ctxOf(m, "swiss"), false)) {
        expect(r.pinned, `${m.key} swiss ${r.key}`).toBeNull();
        expect(r.canRemove).toBe(true);
        rows++;
      }
    });
    expect(visited).toBeGreaterThan(5);
    expect(rows, "Swiss rows checked").toBeGreaterThan(20);
    // The positive pair: the same sport's league pins its ends.
    expect(tiebreakRows(boardgame.defaultTiebreakers("league", cfgOf(boardgame)), ctxOf(boardgame, "league"), false)[0]!.pinned).toBe("first");
  });

  it("a non-Swiss order that does not open on the primary or end on lots pins neither end (only the real primary and lots are pinned)", () => {
    const rows = tiebreakRows(["diff", "points", "for"], ctxOf(football, "league"), false);
    expect(rows.map((r) => r.pinned)).toEqual([null, null, null]);
    expect(rows[0]!.refusal?.reason, "spec §10: the order must start with the primary").toBe("first");
  });

  it("the empty order: no rows, and the refusal is the order's (not a step's)", () => {
    expect(tiebreakRows([], ctxOf(football, "league"), false)).toEqual([]);
    expect(orderHint(tableRulesOf(football, "league", { own: [] }), ctxOf(football, "league"))).toEqual({ empty: true, inherited: false });
  });
});

describe("+ Add step (D11, §5.5)", () => {
  it("+ Add step offers exactly offerableKeys at that position; h2h modifiers only directly after an h2h step (forEachSport × kind, counted)", () => {
    let positions = 0;
    let modifiersOffered = 0;
    let modifiersWithheld = 0;
    const visited = forEachSport(({ module: m }) => {
      for (const kind of [...NON_SWISS, "swiss"] as const) {
        const ctx = ctxOf(m, kind);
        const keys = m.defaultTiebreakers(kind, cfgOf(m));
        for (let p = 0; p <= keys.length; p++) {
          const offered = addableAt(keys, p, ctx);
          expect(offered, `${m.key} ${kind} @${p}`).toEqual(offerableKeys(keys, p, ctx));
          const afterBlock = p > 0 && H2H_BLOCK.has(keys[p - 1]!);
          for (const mod of MODIFIERS) {
            if (offered.includes(mod)) {
              expect(afterBlock, `${m.key} ${kind} @${p}: ${mod} only right after an h2h block step`).toBe(true);
              modifiersOffered++;
            } else modifiersWithheld++;
          }
          positions++;
        }
      }
    });
    expect(visited).toBeGreaterThan(5);
    expect(positions, "positions swept").toBeGreaterThan(100);
    expect(modifiersOffered, "a modifier was offered somewhere (after an h2h block)").toBeGreaterThan(0);
    expect(modifiersWithheld, "and withheld elsewhere").toBeGreaterThan(0);
  });

  it("the add point is just before lots on a non-Swiss order (lots stays last), at the end on Swiss or an order without lots", () => {
    expect(addPosition(["points", "diff", "lots"], "league")).toBe(2);
    expect(addPosition(["points", "diff"], "league")).toBe(2);
    expect(addPosition(["points", "lots"], "swiss")).toBe(2);
    expect(addPosition([], "league")).toBe(0);
    // An added step lands there, and the order still ends on lots.
    const keys = football.defaultTiebreakers("league", cfgOf(football));
    const at = addPosition(keys, "league");
    const next = insertStep(keys, at, "matches_played");
    expect(next[next.length - 1]).toBe("lots");
    expect(next[at]).toBe("matches_played");
    expect(validateCascade(next, ctxOf(football, "league")), "the spec's validator accepts the order the add makes").toEqual([]);
  });

  it("move and remove: a pure list edit; a move off the ends is a no-op", () => {
    expect(moveStep(["a", "b", "c"] as unknown as TiebreakerKey[], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveStep(["a", "b", "c"] as unknown as TiebreakerKey[], 2, 1)).toEqual(["a", "b", "c"]);
    expect(removeStep(["a", "b", "c"] as unknown as TiebreakerKey[], 1)).toEqual(["a", "c"]);
    // h2h_two repeats (OC3): removing one instance keeps the others.
    expect(removeStep(["wins", "h2h_two", "set_diff", "h2h_two", "lots"], 1)).toEqual(["wins", "set_diff", "h2h_two", "lots"]);
  });
});

describe("X-TB-1 the badge", () => {
  it("X-TB-1 badge: Inherited from division / sport default; Overridden when own; Pinned at start from activation with its source", () => {
    const own: TiebreakerKey[] = ["points", "diff", "for", "lots"];
    const division: TiebreakerKey[] = ["points", "for", "diff", "lots"];
    expect(tiebreakBadge(tableRulesOf(football, "league"))).toEqual({ kind: "inherited", from: "sport" });
    expect(tiebreakBadge(tableRulesOf(football, "league", { division }))).toEqual({ kind: "inherited", from: "division" });
    expect(tiebreakBadge(tableRulesOf(football, "league", { division, own }))).toEqual({ kind: "overridden" });
    // OC2: from the moment the stage is active, with the layer it was pinned from — each of the four.
    const pin = (sourceOrder: TableRulesPin["sources"]["tiebreakers"]): TableRulesPin => ({
      points: football.tablePointsRule(cfgOf(football), "league"),
      tiebreakers: own,
      crossGroup: ["points", "diff", "for", "lots"],
      sources: { points: "sport", tiebreakers: sourceOrder, crossGroup: "derived" },
    });
    let sources = 0;
    for (const from of ["stage", "division", "sport", "migrated"] as const) {
      expect(tiebreakBadge(tableRulesOf(football, "league", { pinned: pin(from) })), from).toEqual({ kind: "pinned", from });
      sources++;
    }
    expect(sources).toBe(4);
  });

  it("a source the wire cannot carry without a pin ('migrated' with no pinnedAt) is refused by name, never shown as inherited", () => {
    const rules = tableRulesOf(football, "league");
    const broken: StageTableRules = { ...rules, tiebreakers: { ...rules.tiebreakers, source: "migrated" } };
    expect(tiebreakBadge(broken)).toEqual({ kind: "unknown" });
  });
});

describe("X-TB-2 the lock (OC2, PF-9, PS-6)", () => {
  const stage = (id: string, pinned: boolean): StageLike => {
    const pinRule: TableRulesPin = {
      points: football.tablePointsRule(cfgOf(football), "group"),
      tiebreakers: football.defaultTiebreakers("group", cfgOf(football)),
      crossGroup: ["points", "diff", "for", "lots"],
      sources: { points: "sport", tiebreakers: "sport", crossGroup: "derived" },
    };
    return { id, kind: "group", pooled: true, bestNth: false, tableRules: tableRulesOf(football, "group", { pinned: pinned ? pinRule : null }) };
  };

  it("X-TB-2 OC2 editable between activation and the first score; locked (no arrows/remove/add/reset) once the server lists the stage in formatLockedStageIds", () => {
    const active = stage("s-active", true);
    expect(tiebreakBadge(active.tableRules).kind, "premise: activated (pinned)").toBe("pinned");
    expect(sectionLocked(active, []), "activated, no score: still editable").toBe(false);
    const open = tiebreakRows(active.tableRules.tiebreakers.keys, ctxOf(football, "group"), sectionLocked(active, []));
    expect(open.some((r) => r.canUp || r.canDown || r.canRemove), "arrows and remove while editable").toBe(true);
    expect(sectionControls(false, active.tableRules)).toMatchObject({ add: true, reset: true });

    const scored = sectionLocked(active, ["s-active"]);
    expect(scored, "the server lists it: locked").toBe(true);
    const rows = tiebreakRows(active.tableRules.tiebreakers.keys, ctxOf(football, "group"), scored);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((r) => !r.canUp && !r.canDown && !r.canRemove), "no arrows, no remove").toBe(true);
    expect(sectionControls(true, active.tableRules), "no add, no reset, no clear").toEqual({ add: false, reset: false, clear: false });
  });

  it("PF-9 / PS-6 an online stage with an opened round and no score is locked because the server says so (formatLockedStageIds holds it), not because of a score; the empty list locks nothing", () => {
    // An online round opened: the server's W2c predicate lists the stage although no fixture has a score yet.
    const online = stage("s-online", false);
    expect(sectionLocked(online, ["s-online"]), "the server's answer locks it").toBe(true);
    expect(sectionLocked(online, []), "the empty list locks nothing").toBe(false);
    expect(sectionLocked(stage("s-other", true), ["s-online"]), "another stage's lock is not this one's").toBe(false);
    // A second ask answers the same (pure).
    expect(sectionLocked(online, ["s-online"])).toBe(sectionLocked(online, ["s-online"]));
  });

  it("'Use the division's order' (clear) is offered only for a stage's OWN order, and never while locked", () => {
    const own = tableRulesOf(football, "league", { own: ["points", "diff", "for", "lots"] });
    expect(sectionControls(false, own).clear).toBe(true);
    expect(sectionControls(false, tableRulesOf(football, "league")).clear, "inherited: nothing to clear").toBe(false);
    expect(sectionControls(true, own).clear).toBe(false);
  });
});

describe("refusals inline (§9 Errors, §10)", () => {
  it("an inherited division default invalid for this stage marks the inherited step and returns the 'set this stage's own order' hint", () => {
    // Spec §5.5 rule 3: Buchholz ranks on the Swiss ledger only — a division default holding it is invalid on a league stage.
    const division: TiebreakerKey[] = ["points", "buchholz", "lots"];
    const rules = tableRulesOf(boardgame, "league", { division });
    expect(rules.tiebreakers.source, "premise: inherited from the division").toBe("division");
    const ctx = ctxOf(boardgame, "league");
    const rows = tiebreakRows(rules.tiebreakers.keys, ctx, false);
    expect(rows[1]!.refusal?.reason, "the inherited step carries its reason").toBe("stage_format");
    expect(rows[0]!.refusal).toBeUndefined();
    expect(orderHint(rules, ctx), "the hint: set this stage's own order").toEqual({ empty: false, inherited: true });
    // Positive pair: the same order as the stage's OWN is not "inherited" — the refusal stays, the hint goes.
    expect(orderHint(tableRulesOf(boardgame, "league", { own: division }), ctx)).toBeNull();
    expect(tiebreakRows(division, ctx, false)[1]!.refusal?.reason, "the own step keeps its reason").toBe("stage_format");
    // And the same division order on a Swiss stage is valid: no refusal, no hint.
    const swiss = tableRulesOf(boardgame, "swiss", { division });
    expect(tiebreakRows(swiss.tiebreakers.keys, ctxOf(boardgame, "swiss"), false).every((r) => r.refusal === undefined)).toBe(true);
    expect(orderHint(swiss, ctxOf(boardgame, "swiss"))).toBeNull();
  });

  it("a locked stage shows no refusals (its order is pinned; there is nothing to fix)", () => {
    const rows = tiebreakRows(["points", "buchholz", "lots"], ctxOf(boardgame, "league"), true);
    expect(rows.every((r) => r.refusal === undefined)).toBe(true);
  });

  it("D8: football's fair-play step is refused where the division does not track fair play, and accepted where it does", () => {
    const keys = football.defaultTiebreakers("league", { ...(cfgOf(football) as object), fairPlay: true });
    expect(keys, "premise: the fair-play order").toContain("fair_play");
    const off = tiebreakRows(keys, ctxOf(football, "league", { ...(cfgOf(football) as object), fairPlay: false }), false);
    expect(off.find((r) => r.key === "fair_play")?.refusal?.reason).toBe("fair_play_off");
    const on = tiebreakRows(keys, ctxOf(football, "league", { ...(cfgOf(football) as object), fairPlay: true }), false);
    expect(on.find((r) => r.key === "fair_play")?.refusal).toBeUndefined();
  });
});

describe("Reset (PS-7b, D5)", () => {
  it("football reset offers FIFA 2026 / UEFA / Classic from tablePresets; other sports one 'sport default' = tableRules.tiebreakers.sportDefault (PS-7b; a fixture whose sportDefault differs from the stage's current order)", () => {
    const fb = tableRulesOf(football, "league", { own: ["points", "diff", "lots"] });
    const presets = football.tablePresets!("league").tiebreakers;
    expect(presets.map((p) => p.id), "premise: D5 signs three football presets").toEqual(["fifa2026", "uefa", "classic"]);
    expect(resetChoices(football.tablePresets!("league"), fb)).toEqual(presets.map((p) => ({ id: p.id, keys: [...p.keys] })));

    const own: TiebreakerKey[] = ["wins", "point_diff", "lots"];
    const bd = tableRulesOf(badminton, "league", { own });
    expect(bd.tiebreakers.sportDefault, "premise: the sport default differs from the stage's current order").not.toEqual(bd.tiebreakers.keys);
    expect(resetOrder(bd), "the reset target is the server's sportDefault, never the current order").toEqual(bd.tiebreakers.sportDefault);
    expect(resetOrder(bd)).toEqual(badminton.defaultTiebreakers("league", cfgOf(badminton)));
    expect(resetChoices(badminton.tablePresets?.("league"), bd)).toEqual([{ id: "sport_default", keys: bd.tiebreakers.sportDefault }]);
    // A sport whose presets declare points rules only (chess) still resets to its one sport default.
    const bg = tableRulesOf(boardgame, "league", { own: ["points", "wins", "lots"] });
    expect(resetChoices(boardgame.tablePresets!("league"), bg)).toEqual([{ id: "sport_default", keys: bg.tiebreakers.sportDefault }]);
  });
});

describe("cross-group line (§5.9)", () => {
  const groupOf = (over: Partial<StageLike>): StageLike => ({
    id: "g",
    kind: "group",
    pooled: true,
    bestNth: true,
    tableRules: tableRulesOf(football, "group"),
    ...over,
  });

  it("the cross-group line shows only for a pooled stage with best-Nth progression, and holds no h2h key", () => {
    const g = groupOf({});
    expect(g.tableRules.tiebreakers.keys.some(isH2H), "premise: the stage's own order has h2h steps").toBe(true);
    const line = crossGroupLine(g);
    expect(line, "pooled + best-Nth").not.toBeNull();
    expect(line!.length).toBeGreaterThan(1);
    expect(line!.filter(isH2H), "no h2h key between groups").toEqual([]);
    expect(crossGroupLine(groupOf({ bestNth: false })), "no best-Nth: no line").toBeNull();
    expect(crossGroupLine(groupOf({ pooled: false })), "not pooled: no line").toBeNull();
    // A cross-group order that holds an h2h key (a hand-edited pin) never shows it.
    const dirty = groupOf({ tableRules: { ...g.tableRules, crossGroup: { keys: ["points", "h2h_points", "diff", "lots"] } } });
    expect(crossGroupLine(dirty)).toEqual(["points", "diff", "lots"]);
  });

  it("pooled = a group stage, or any stage split into more than one pool; best-Nth = a later stage takes a best-Nth from it", () => {
    expect(stagePooled({ kind: "group", config: {} })).toBe(true);
    expect(stagePooled({ kind: "league", config: { pools: { count: 2 } } })).toBe(true);
    expect(stagePooled({ kind: "league", config: { pools: { count: 1 } } })).toBe(false);
    expect(stagePooled({ kind: "league", config: {} })).toBe(false);
    const groups = { id: "g1", seq: 1, progression: null };
    const ko = (take: unknown[], stage: unknown = "previous") => ({ id: "k1", seq: 2, progression: { sources: [{ stage, take }] } });
    expect(takesBestNthFrom(groups, [groups, ko([{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 4 }])])).toBe(true);
    expect(takesBestNthFrom(groups, [groups, ko([{ kind: "bestNth", nth: 3, count: 4 }], { stageId: "g1" })])).toBe(true);
    expect(takesBestNthFrom(groups, [groups, ko([{ kind: "topNPerGroup", n: 2 }])]), "top-N only").toBe(false);
    expect(takesBestNthFrom(groups, [groups, ko([{ kind: "bestNth", nth: 3, count: 4 }], { stageId: "other" })]), "another source").toBe(false);
    expect(takesBestNthFrom(groups, [groups]), "no later stage").toBe(false);
    // "previous" is the stage directly before by seq, not any earlier one.
    const middle = { id: "m", seq: 2, progression: null };
    expect(takesBestNthFrom(groups, [groups, middle, { ...ko([{ kind: "bestNth", nth: 3, count: 4 }]), seq: 3 }])).toBe(false);
  });
});
