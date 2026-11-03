// W3 app-B T9 (ST-G21; rulebook-W3 §8 T9, X-SW-9) - which tie-break columns the TV board prints beside Pts.
//
// The rule: the FIRST TWO keys of the stage's own order that the engine declares Swiss-only and whose column the table
// shows. The "Swiss-only" fact is the engine's (`KEY_RULES[key].swissOnly`, read through `validateCascade`'s `stage_format`
// refusal - the one door the engine exports it through); no list of keys is typed in the code under test.
//
// Conventions (TEST-STRATEGY.md): the empty case is stated first; every sweep reports how many items it checked and zero
// is a failure; an expected list is derived from the engine's own declarations per sport (`unpinnedRulesDoc` = the stage
// rules the production loader serves, the order the engine's `defaultTiebreakers("swiss", cfg)` declares), never typed - except
// the three chains the brief and the rulebook (X-SW-9) NAME, which are pinned once as premise anchors beside the sweep.
import { describe, expect, it } from "vitest";
import { validateCascade, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { tableColumns, tableLayoutFor } from "@/server/public-site/standings-view";
import { SLIDE_TIEBREAK_MAX, slideTiebreakColumns, swissOnlyKeysOf } from "../slide-tiebreak-columns";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
  return m;
};

const row = (entrantId: string): StandingsRow => ({ entrantId, played: 1, won: 1, drawn: 0, lost: 0, points: 3, rank: 1, metrics: {} });

/** What the engine refuses outside a Swiss, key by key: its own declaration of "Swiss-only", asked of the WHOLE order at once
 *  (the code under test asks key by key). */
function engineSwissOnly(m: AnySportModule, cfg: unknown, order: readonly string[]): string[] {
  return validateCascade(order as TiebreakerKey[], { module: m, cfg, stageKind: "league", crossGroup: false })
    .filter((r) => r.reason === "stage_format")
    .map((r) => String(r.key));
}

/** The columns a stage's table shows for `order` (the public table's own selection, `tableColumns`). */
const shownFor = (m: AnySportModule, order: readonly string[], doc: Parameters<typeof tableLayoutFor>[0]) =>
  tableColumns(m.metrics, order, [row("a")], tableLayoutFor(doc, "swiss"));

const swissDoc = (m: AnySportModule, cfg: unknown) => unpinnedRulesDoc({ module: m, kind: "swiss", divisionConfig: cfg });
const leagueDoc = (m: AnySportModule, cfg: unknown) => unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: cfg });

describe("ST-G21 slideTiebreakColumns - the empty cases first", () => {
  it("no columns, no cascade, no Swiss-only keys: nothing", () => {
    expect(slideTiebreakColumns([], [], new Set())).toEqual([]);
    const m = sport("football");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const shown = shownFor(m, doc.tiebreakers, doc);
    expect(shown.length, "premise: the table has columns").toBeGreaterThan(0);
    expect(slideTiebreakColumns(shown, [], swissOnlyKeysOf(m, doc.tiebreakers)), "an empty cascade").toEqual([]);
    expect(slideTiebreakColumns(shown, doc.tiebreakers, new Set()), "no key is Swiss-only").toEqual([]);
  });

  it("the Swiss-only set of an empty order is empty, and an unknown key never throws", () => {
    const m = sport("football");
    expect(swissOnlyKeysOf(m, []).size).toBe(0);
    // A stored order is data (the engine throws CONFIG_INVALID on a key outside its vocabulary): the board degrades to "not a
    // tie-break column" and goes on drawing, it never takes the TV down.
    expect(() => swissOnlyKeysOf(m, ["no_such_key", "buchholz"])).not.toThrow();
    expect([...swissOnlyKeysOf(m, ["no_such_key", "buchholz"])]).toEqual(["buchholz"]);
  });

  it("a module this build cannot resolve answers as a resolved one does: the public table shows the ladders without a module, so the board keeps them (review m1)", () => {
    const m = sport("football");
    const order = ["points", "diff", "buchholz", "opp_diff", "lots"];
    expect([...swissOnlyKeysOf(null, order)].sort(), "no module").toEqual(["buchholz", "opp_diff"]);
    expect([...swissOnlyKeysOf(null, order)].sort()).toEqual([...swissOnlyKeysOf(m, order)].sort());
    // and the same through the whole rule: the columns a table with no module shows (structural + derived only) are the first two
    const shown = tableColumns([], order, [row("a")], tableLayoutFor(null, "swiss"));
    expect(slideTiebreakColumns(shown, order, swissOnlyKeysOf(null, order)).map((c) => c.key)).toEqual(["buchholz", "opp_diff"]);
  });
});

describe("ST-G21 swissOnlyKeysOf - the engine's declaration, not a list", () => {
  it("the Swiss ladders and Opp diff are Swiss-only; Sonneborn-Berger, the ledger and the ratios are not (rulebook X-SW-9; the engine's rule 3)", () => {
    const m = sport("football");
    const set = swissOnlyKeysOf(m, ["points", "diff", "for", "wins", "buchholz", "buchholz_cut1", "opp_diff", "sberger", "direct", "set_ratio", "lots"]);
    expect([...set].sort()).toEqual(["buchholz", "buchholz_cut1", "opp_diff"]);
  });

  it("agrees with the engine on every key of every sport's Swiss and league defaults (registry sweep, counted)", () => {
    let keys = 0;
    let swiss = 0;
    const visited = forEachSport(({ module: m }) => {
      for (const { cfg } of declaredCfgs(m)) {
        for (const order of [swissDoc(m, cfg).tiebreakers, leagueDoc(m, cfg).tiebreakers]) {
          const want = new Set(engineSwissOnly(m, cfg, order));
          const got = swissOnlyKeysOf(m, order);
          expect([...got].sort(), `${m.key}: ${order.join(",")}`).toEqual([...want].sort());
          expect([...swissOnlyKeysOf(null, order)].sort(), `${m.key}: rule 3 needs no sport`).toEqual([...want].sort());
          keys += order.length;
          swiss += got.size;
        }
      }
    });
    expect(visited, "sports swept").toBe(builtinModules.length);
    expect(keys, "keys compared").toBeGreaterThan(100);
    expect(swiss, "Swiss-only keys met (anti-vacuity: the sweep saw the answer yes)").toBeGreaterThan(20);
  });
});

describe("ST-G21 slideTiebreakColumns - the first two Swiss-only keys of the stage's order", () => {
  it("a LEAGUE order names no Swiss-only key, so no column - for every sport and declared cfg; the same table under the Swiss order has two (counted)", () => {
    let leagues = 0;
    let swisses = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m)) {
        const league = leagueDoc(m, cfg);
        expect(
          slideTiebreakColumns(shownFor(m, league.tiebreakers, league), league.tiebreakers, swissOnlyKeysOf(m, league.tiebreakers)),
          `${m.key} ${name}: a league stage`,
        ).toEqual([]);
        leagues++;
        const swiss = swissDoc(m, cfg);
        const got = slideTiebreakColumns(shownFor(m, swiss.tiebreakers, swiss), swiss.tiebreakers, swissOnlyKeysOf(m, swiss.tiebreakers));
        expect(got.length, `${m.key} ${name}: the Swiss order gives the board its two`).toBe(SLIDE_TIEBREAK_MAX);
        swisses++;
      }
    });
    expect(leagues, "league stages checked").toBeGreaterThan(builtinModules.length);
    expect(swisses, "Swiss stages checked").toBe(leagues);
  });

  it("every sport and declared cfg: the columns are the stage order's first two keys the engine refuses outside a Swiss, in the order's own order (registry sweep, counted)", () => {
    let checked = 0;
    const seen = new Set<string>();
    const visited = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m)) {
        const doc = swissDoc(m, cfg);
        const want = engineSwissOnly(m, cfg, doc.tiebreakers).slice(0, SLIDE_TIEBREAK_MAX);
        const got = slideTiebreakColumns(shownFor(m, doc.tiebreakers, doc), doc.tiebreakers, swissOnlyKeysOf(m, doc.tiebreakers));
        expect(got.map((c) => c.key), `${m.key} ${name}`).toEqual(want);
        for (const c of got) {
          expect(c.kind, `${m.key} ${c.key} is a derived column`).toBe("derived");
          seen.add(c.key);
        }
        checked++;
      }
    });
    expect(visited, "sports swept (11 built-ins)").toBe(11);
    expect(checked, "(sport, cfg) pairs checked").toBeGreaterThan(30);
    // Anti-vacuity: the sweep saw every shape the registry produces - the two-ladder chains and the football-family Opp diff.
    expect([...seen].sort()).toEqual(["buchholz", "buchholz_cut1", "opp_diff"]);
  });

  it("premise anchors (the brief, rulebook X-SW-9): badminton -> Buchholz Cut-1, Buchholz; football -> Buchholz, Opp diff; chess -> Buchholz Cut-1, Buchholz (the first two of three)", () => {
    for (const [key, want] of [
      ["badminton", ["buchholz_cut1", "buchholz"]],
      ["football", ["buchholz", "opp_diff"]],
      ["boardgame", ["buchholz_cut1", "buchholz"]],
    ] as const) {
      const m = sport(key);
      const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
      const got = slideTiebreakColumns(shownFor(m, doc.tiebreakers, doc), doc.tiebreakers, swissOnlyKeysOf(m, doc.tiebreakers));
      expect(got.map((c) => c.key), key).toEqual(want);
    }
    // chess's chain holds Sonneborn-Berger after the two ladders: "the first two of three" - SB is a third tie-break, not offered
    const chess = sport("boardgame");
    const chain = swissDoc(chess, declaredCfgs(chess)[0]!.cfg).tiebreakers;
    expect(chain, "premise: chess's Swiss chain holds a third tie-break column after the two ladders").toContain("sberger");
  });

  it("at most two, in the CASCADE's order (not the column order), and a key whose column the table does not show is skipped", () => {
    const m = sport("football");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const three = ["points", "buchholz_cut1", "buchholz", "opp_diff", "lots"];
    const shown = shownFor(m, three, doc);
    expect(shown.map((c) => c.key), "premise: the three derived columns are shown").toEqual(expect.arrayContaining(["buchholz_cut1", "buchholz", "opp_diff"]));
    const swissOnly = swissOnlyKeysOf(m, three);
    expect(slideTiebreakColumns(shown, three, swissOnly).map((c) => c.key), "three Swiss-only keys: the third is not offered").toEqual(["buchholz_cut1", "buchholz"]);
    expect(SLIDE_TIEBREAK_MAX, "owner option A: up to two").toBe(2);

    // Cascade order, not column order: the columns come out buchholz before opp_diff (DERIVED_METRICS order); the order says opp_diff first.
    const reversed = ["points", "opp_diff", "buchholz", "lots"];
    const shownReversed = shownFor(m, reversed, doc);
    expect(shownReversed.map((c) => c.key).indexOf("buchholz"), "premise: the table lists Buchholz before Opp diff").toBeLessThan(shownReversed.map((c) => c.key).indexOf("opp_diff"));
    expect(slideTiebreakColumns(shownReversed, reversed, swissOnlyKeysOf(m, reversed)).map((c) => c.key)).toEqual(["opp_diff", "buchholz"]);

    // A Swiss-only key whose column is not in `shown` is skipped and the next one takes its place.
    const withoutFirst = shown.filter((c) => c.key !== "buchholz_cut1");
    expect(slideTiebreakColumns(withoutFirst, three, swissOnly).map((c) => c.key)).toEqual(["buchholz", "opp_diff"]);
    // One column only: one comes back (the board has a template for one).
    expect(slideTiebreakColumns(shown.filter((c) => c.key === "buchholz"), three, swissOnly).map((c) => c.key)).toEqual(["buchholz"]);
  });

  it("a stored order that repeats a key (the engine refuses it, but a stored order is data) draws that column once", () => {
    const m = sport("football");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const repeated = ["points", "buchholz", "buchholz", "opp_diff", "lots"];
    expect(new Set(repeated).size, "premise: the order repeats a key").toBeLessThan(repeated.length);
    expect(engineSwissOnly(m, declaredCfgs(m)[0]!.cfg, repeated).filter((k) => k === "buchholz"), "premise: the engine sees the repeat").toHaveLength(2);
    const got = slideTiebreakColumns(shownFor(m, repeated, doc), repeated, swissOnlyKeysOf(m, repeated));
    expect(got.map((c) => c.key)).toEqual(["buchholz", "opp_diff"]);
  });

  it("Sonneborn-Berger is valid in any stage, so it is never a tie-break column even when the table shows it", () => {
    const m = sport("boardgame");
    const order = ["points", "sberger", "buchholz", "lots"];
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const shown = shownFor(m, order, doc);
    expect(shown.some((c) => c.key === "sberger"), "premise: the table shows SB").toBe(true);
    expect(swissOnlyKeysOf(m, order).has("sberger")).toBe(false);
    expect(slideTiebreakColumns(shown, order, swissOnlyKeysOf(m, order)).map((c) => c.key)).toEqual(["buchholz"]);
  });
});
