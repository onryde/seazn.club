// Match Day Phase C, Task C1 (spec 2026-10-31-match-day-design.md §12, Phase C items 5-8) - the stage card's pure
// summaries: what the Points panel says, which steps the Tie-breaks panel numbers, the sport's word for a "set", and which
// buttons the card offers. Every expected value below comes from the engine's own declarations (the sport registry, a
// sport's own points rule and default orders) or the rulebook the engine cites - never from the code under test.
//
// Anti-vacuity (TEST-STRATEGY 2): each sweep returns how many items it visited and a zero fails; the counts that matter
// are asserted against the engine's registry, not a number typed here.
import { describe, expect, it } from "vitest";
import {
  RATIO_LEDGERS,
  isHeadToHeadKey,
  offerableKeys,
  reachableOutcomes,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import type { TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { pointsRows } from "@/components/v2/stage-rules/stage-points-model";
import {
  foldTiebreaks,
  stageActions,
  summarisePoints,
  unitLabelKey,
  type StageActionInput,
} from "@/lib/stage-card/summaries";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const LOCALES = { en, es, fr, nl } as const;
type Dict = Record<string, string>;
const dictOf = (locale: keyof typeof LOCALES): Dict => LOCALES[locale] as unknown as Dict;

const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];

/** The engine's vocabulary of rungs, as far as the registry reaches it: every default order of every sport and kind, every
 *  named preset order, and every key the engine offers a fresh order. Each is checked against the engine's own
 *  `isHeadToHeadKey`, which throws for a key outside the vocabulary - so nothing here is a guess. */
function rungUniverse(): { rungs: Set<string>; orders: { where: string; keys: readonly TiebreakerKey[] }[] } {
  const rungs = new Set<string>();
  const orders: { where: string; keys: readonly TiebreakerKey[] }[] = [];
  const visited = forEachSport(({ key, module }) => {
    for (const kind of TABLE_KINDS) {
      const keys = defaultOrderOf(module, kind);
      orders.push({ where: `${key} ${kind} default`, keys });
      for (const preset of module.tablePresets?.(kind).tiebreakers ?? []) {
        orders.push({ where: `${key} ${kind} preset ${preset.id}`, keys: preset.keys });
      }
      const cfg = declaredCfgs(module)[0]!.cfg;
      for (const offered of offerableKeys([], 0, { module, cfg, stageKind: kind, crossGroup: false })) rungs.add(offered);
    }
  });
  expect(visited, "premise: the sweep visits every registry sport").toBe(builtinModules.length);
  for (const o of orders) for (const k of o.keys) rungs.add(k);
  for (const r of rungs) expect(() => isHeadToHeadKey(r as TiebreakerKey), `${r} is an engine key`).not.toThrow();
  return { rungs, orders };
}

describe("summarisePoints", () => {
  // The empty case first (TEST-STRATEGY 2): `[].every(same)` is true, so a naive "all rows agree" answers "uniform" and
  // reads the pair off a row that is not there. With nothing to say, the answer is an empty table, never a made-up pair.
  it("says nothing - an empty table, not a uniform one - when there are no rows and no fallback", () => {
    expect(summarisePoints([], null)).toEqual({ kind: "table", rows: [], other: null });
  });

  it("with no per-score rows, the fallback pays every score: uniform", () => {
    expect(summarisePoints([], { winner: 2, loser: 0 })).toEqual({ kind: "uniform", win: 2, loss: 0 });
  });

  // The owner's screenshot: a badminton league where 2-0 and 2-1 both pay 2 / 0.
  it("the screenshot case: 2-0 and 2-1 both pay 2 / 0 is uniform 2 / 0", () => {
    const rows = [
      { score: "2-0", winner: 2, loser: 0 },
      { score: "2-1", winner: 2, loser: 0 },
    ];
    expect(summarisePoints(rows, null)).toEqual({ kind: "uniform", win: 2, loss: 0 });
    expect(summarisePoints(rows, { winner: 2, loser: 0 })).toEqual({ kind: "uniform", win: 2, loss: 0 });
  });

  it("one row is uniform (a single score cannot differ from itself)", () => {
    expect(summarisePoints([{ score: "2-0", winner: 3, loser: 1 }], null)).toEqual({ kind: "uniform", win: 3, loss: 1 });
  });

  it("rows that differ are a table, in the order given, with the fallback carried", () => {
    const rows = [
      { score: "3-0", winner: 3, loser: 0 },
      { score: "3-1", winner: 3, loser: 0 },
      { score: "3-2", winner: 2, loser: 1 },
    ];
    expect(summarisePoints(rows, null)).toEqual({ kind: "table", rows, other: null });
    expect(summarisePoints(rows, { winner: 2, loser: 0 })).toEqual({ kind: "table", rows, other: { winner: 2, loser: 0 } });
  });

  // The winner's and the loser's halves are separate numbers: a rule that pays the same winner share but a different loser
  // share is not uniform. (Only the loser differs here, so a check on the winner alone would call it uniform.)
  it("rows that differ only in the loser's points are a table", () => {
    const rows = [
      { score: "2-0", winner: 2, loser: 0 },
      { score: "2-1", winner: 2, loser: 1 },
    ];
    expect(summarisePoints(rows, null).kind).toBe("table");
  });

  // A fallback that pays differently is a payout the one line would hide: "Win 2 - Loss 0" would be untrue for any score
  // the rows do not name.
  it("uniform rows with a fallback that pays differently are a table, never a hidden payout", () => {
    const rows = [{ score: "2-0", winner: 2, loser: 0 }];
    expect(summarisePoints(rows, { winner: 3, loser: 0 })).toEqual({ kind: "table", rows, other: { winner: 3, loser: 0 } });
  });

  it("refuses a number that is no number (a guard, not a comment)", () => {
    expect(() => summarisePoints([{ score: "2-0", winner: Number.NaN, loser: 0 }], null)).toThrow(/points/i);
    expect(() => summarisePoints([], { winner: 2, loser: Number.POSITIVE_INFINITY })).toThrow(/points/i);
  });

  // The producer, not a fixture (AGENTS class 1): the rows come from each sport's OWN points rule through the stage
  // editor's `pointsRows`, over the outcomes the engine says the stage reaches. The expected kind is the number of distinct
  // payouts, counted off the engine's rule - one payout is a sentence, more is a table.
  it("reads every sport's real points rule: volleyball's 3-2 pays 2 / 1 (a table), badminton pays 2 / 0 for any score (uniform)", () => {
    const seen = { uniform: new Set<string>(), table: new Set<string>() };
    let withSetTable = 0;
    forEachSport(({ key, module }) => {
      for (const { cfg } of declaredCfgs(module)) {
        const rule = module.tablePointsRule(cfg, "league");
        const map = rule.bySetScore;
        if (map === undefined) continue;
        withSetTable++;
        const rows = pointsRows([...reachableOutcomes(module, cfg, "league")], rule)
          .filter((r) => r.pair !== null)
          .map((r) => ({ score: r.key.slice("set:".length), winner: r.pair![0], loser: r.pair![1] }));
        expect(rows.length, `${key}: a set table has at least one reachable score`).toBeGreaterThan(0);
        const star = Object.hasOwn(map, "*") ? map["*"]! : null;
        const other = star === null ? null : { winner: star[0], loser: star[1] };
        const payouts = new Set(rows.map((r) => `${r.winner}/${r.loser}`));
        if (other !== null) payouts.add(`${other.winner}/${other.loser}`);
        const got = summarisePoints(rows, other);
        expect(got.kind, `${key}: ${[...payouts].join(" | ")}`).toBe(payouts.size === 1 ? "uniform" : "table");
        if (got.kind === "uniform") {
          const [w, l] = [...payouts][0]!.split("/").map(Number);
          expect([got.win, got.loss], `${key} uniform pair`).toEqual([w, l]);
          seen.uniform.add(key);
        } else {
          expect(got.rows, `${key}: the table keeps every row`).toEqual(rows);
          seen.table.add(key);
        }
      }
    });
    expect(withSetTable, "anti-vacuity: at least two (sport, cfg) pairs pay by set score").toBeGreaterThanOrEqual(2);
    // The differential: a sweep that only ever saw one answer could not tell this function from a constant.
    expect(seen.uniform.size, "a sport whose set payouts are all the same").toBeGreaterThan(0);
    expect(seen.table.size, "a sport whose set payouts differ").toBeGreaterThan(0);
    expect(seen.uniform.has("badminton")).toBe(true);
    expect(seen.table.has("volleyball")).toBe(true);
  });
});

describe("foldTiebreaks", () => {
  it("empty -> no steps, no two-way line", () => {
    expect(foldTiebreaks([])).toEqual({ steps: [], twoWayH2h: false });
  });

  it("a list with no h2h_two comes back as it was, flagged false", () => {
    const rungs = ["points", "h2h_points", "diff", "for", "lots"];
    expect(foldTiebreaks(rungs)).toEqual({ steps: rungs, twoWayH2h: false });
  });

  // BWF Laws of Badminton 16.2: matches won (16.2.1), the game difference (16.2.3), the point difference (16.2.4), each
  // falling back to the two-way head-to-head when it leaves two level (16.2.2), then lots. The engine's badminton default is
  // that list; the test reads it off the module and holds it to the rulebook's reading of it.
  it("the BWF order folds its three two-way head-to-head rungs into one flag", () => {
    const badminton = builtinModules.find((m) => m.key === "badminton")!;
    const rungs = defaultOrderOf(badminton, "league");
    expect(rungs, "premise: badminton's engine default is the BWF order").toEqual([
      "wins", "h2h_two", "set_diff", "h2h_two", "point_diff", "h2h_two", "lots",
    ]);
    expect(foldTiebreaks(rungs)).toEqual({ steps: ["wins", "set_diff", "point_diff", "lots"], twoWayH2h: true });
  });

  it("does not mutate its input, and a second call answers the same", () => {
    const rungs = ["wins", "h2h_two", "lots"];
    const copy = [...rungs];
    const first = foldTiebreaks(rungs);
    expect(rungs).toEqual(copy);
    expect(foldTiebreaks(rungs)).toEqual(first);
  });

  it("only h2h_two folds: the other head-to-head rungs are real criteria and stay numbered", () => {
    const rungs = ["points", "h2h_points", "h2h_diff", "h2h_two", "h2h_wins", "h2h_reapply", "direct", "lots"];
    expect(foldTiebreaks(rungs)).toEqual({
      steps: ["points", "h2h_points", "h2h_diff", "h2h_wins", "h2h_reapply", "direct", "lots"],
      twoWayH2h: true,
    });
  });

  it("a list of nothing but h2h_two folds to no steps and the flag", () => {
    expect(foldTiebreaks(["h2h_two", "h2h_two"])).toEqual({ steps: [], twoWayH2h: true });
  });

  // Every order the engine declares, in every sport and stage kind: nothing numbered repeats, the steps are the order's own
  // rungs in the order's own sequence, and the flag is set exactly when the engine put an h2h_two there.
  it("sweeps every default and preset order in the registry", () => {
    const { orders, rungs } = rungUniverse();
    expect(orders.length, "anti-vacuity: orders reached").toBeGreaterThan(0);
    let withTwoWay = 0;
    let checked = 0;
    for (const { where, keys } of orders) {
      const { steps, twoWayH2h } = foldTiebreaks(keys);
      const removed = keys.length - steps.length;
      expect(steps, `${where}: h2h_two is not a numbered step`).not.toContain("h2h_two");
      expect(twoWayH2h, `${where}: flag`).toBe(removed > 0);
      // The steps are a subsequence of the order, in sequence.
      let at = 0;
      for (const s of steps) {
        const found = keys.indexOf(s as TiebreakerKey, at);
        expect(found, `${where}: ${s} keeps its place`).toBeGreaterThanOrEqual(at);
        at = found + 1;
      }
      // The engine lets only h2h_two repeat (its cascade rule `duplicate`), so once it is folded away nothing repeats.
      expect(new Set(steps).size, `${where}: no repeated numbered step`).toBe(steps.length);
      if (twoWayH2h) withTwoWay++;
      checked++;
    }
    expect(checked, "every order was checked").toBe(orders.length);
    expect(withTwoWay, "anti-vacuity: some declared order has the rung (badminton and tennis)").toBeGreaterThanOrEqual(2);
    expect(rungs.has("h2h_two"), "premise: h2h_two is in the engine's vocabulary").toBe(true);
  });
});

describe("unitLabelKey", () => {
  const BASE = (rule: string) => `div.detail.tiebreak.rule.${rule}`;

  it("badminton counts games: set_diff resolves to the games label, not the sets one", () => {
    const key = unitLabelKey("set_diff", "badminton");
    expect(key).not.toBe(BASE("set_diff"));
    expect(en[key as keyof typeof en]).toBe("game difference");
    expect(en[BASE("set_diff") as keyof typeof en], "premise: the shared label says set").toBe("set difference");
  });

  it("tennis and volleyball count sets: they keep the shared label", () => {
    expect(unitLabelKey("set_diff", "tennis")).toBe(BASE("set_diff"));
    expect(unitLabelKey("set_ratio", "volleyball")).toBe(BASE("set_ratio"));
  });

  it("a rung that carries no unit is the shared label in every sport (badminton's wins stays wins)", () => {
    expect(unitLabelKey("wins", "badminton")).toBe(BASE("wins"));
    expect(unitLabelKey("point_diff", "tabletennis")).toBe(BASE("point_diff"));
    expect(unitLabelKey("h2h_two", "badminton")).toBe(BASE("h2h_two"));
  });

  it("a sport with no set ledger (or one the registry does not know) falls back to the shared label", () => {
    expect(unitLabelKey("set_diff", "football")).toBe(BASE("set_diff"));
    expect(unitLabelKey("set_diff", "no_such_sport")).toBe(BASE("set_diff"));
    // "constructor" is an Object.prototype member, not a sport: an inherited lookup would answer it.
    expect(unitLabelKey("set_diff", "constructor")).toBe(BASE("set_diff"));
  });

  // The unit word is the engine's: a set sport's `sets_won` metric is labelled "<Unit> won", from the preset's own
  // `unitLabel`. For every registry sport and every rung the engine knows, the key resolves in all four locales; where the
  // engine says the unit is not "sets" the English label names the engine's unit (singular), and where it says "sets" the
  // shared label stands. Nothing is typed here but the shared label's own unit.
  it("every sport x every rung resolves in all four locales, in the word the engine's metric declares", () => {
    const { rungs } = rungUniverse();
    const ledger = RATIO_LEDGERS.set_ratio[0];
    expect(ledger, "premise: the unit rungs read the engine's sets ledger").toBe("sets_won");
    let checked = 0;
    let specific = 0;
    const missing: string[] = [];
    const wrongWord: string[] = [];
    const visited = forEachSport(({ key, module }) => {
      const label = module.metrics.find((m) => m.key === ledger)?.label;
      const unit = label === undefined ? null : label.replace(/\s+won$/i, "").toLowerCase();
      for (const rung of rungs) {
        const resolved = unitLabelKey(rung, key);
        for (const [locale] of Object.entries(LOCALES)) {
          if (!Object.hasOwn(dictOf(locale as keyof typeof LOCALES), resolved)) missing.push(`${locale} ${key}/${rung}: ${resolved}`);
          checked++;
        }
        const shared = BASE(rung);
        if (resolved !== shared) {
          specific++;
          // Singular of the engine's plural unit ("games" -> "game"): the labels are "game difference", "game ratio".
          const stem = unit === null ? "" : unit.replace(/s$/, "");
          if (unit === null || unit === "sets" || !en[resolved as keyof typeof en]?.includes(stem)) {
            wrongWord.push(`${key}/${rung}: ${resolved} for unit ${unit}`);
          }
        } else if (unit !== null && unit !== "sets" && /(^|_)set(_|$)/.test(rung)) {
          wrongWord.push(`${key}/${rung}: declares unit ${unit} but resolved the shared set label`);
        }
      }
    });
    expect(visited, "every registry sport").toBe(builtinModules.length);
    expect(visited, "anti-vacuity: sports").toBeGreaterThan(0);
    expect(checked, "anti-vacuity: (sport, rung, locale) cells").toBe(visited * rungs.size * Object.keys(LOCALES).length);
    expect(specific, "anti-vacuity: some sport counts games, not sets").toBeGreaterThan(0);
    expect(missing).toEqual([]);
    expect(wrongWord).toEqual([]);
  });

  // The other direction: a sport-specific label with no sport that needs it is dead copy, and a unit rung the code does not
  // know about would resolve to the wrong word. Every dictionary key shaped like a unit label is reached from the registry.
  it("every sport-specific unit label in the dictionary is the one some registry sport resolves to", () => {
    const { rungs } = rungUniverse();
    const reached = new Set<string>();
    forEachSport(({ key }) => {
      for (const rung of rungs) {
        const resolved = unitLabelKey(rung, key);
        if (resolved !== BASE(rung)) reached.add(resolved);
      }
    });
    const shaped = Object.keys(en).filter((k) => /^div\.detail\.tiebreak\.rule\.[a-z0-9_]+\.[a-z0-9_]+$/.test(k));
    expect(shaped.length, "anti-vacuity: sport-specific labels exist").toBeGreaterThan(0);
    expect([...reached].sort(), "the labels written are the labels reached").toEqual(shaped.sort());
  });

  it("the unit-bearing rungs are exactly the engine's rungs that name a set", () => {
    const { rungs } = rungUniverse();
    const named = [...rungs].filter((r) => /(^|_)set(_|$)/.test(r)).sort();
    expect(named.length, "anti-vacuity").toBeGreaterThan(0);
    const wordFor = (r: string) => unitLabelKey(r, "badminton") !== BASE(r);
    expect(named.filter((r) => !wordFor(r)), "a rung naming a set that badminton leaves in sets").toEqual([]);
    expect([...rungs].filter((r) => !named.includes(r) && wordFor(r)), "a rung not naming a set that badminton re-words").toEqual([]);
  });
});

describe("the dictionary lines the stage card prints", () => {
  const KEYS = ["stageCard.points.uniform", "stageCard.tiebreaks.h2hTwo", "stageCard.locked"] as const;

  it("exist in all four locales with their placeholders intact", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const d = dictOf(locale);
      for (const k of KEYS) {
        expect(Object.hasOwn(d, k), `${locale} ${k}`).toBe(true);
        expect(d[k]!.trim().length, `${locale} ${k} is not blank`).toBeGreaterThan(0);
        checked++;
      }
      expect(d["stageCard.points.uniform"], `${locale}: both numbers`).toMatch(/\{w\}.*\{l\}|\{l\}.*\{w\}/);
    }
    expect(checked).toBe(KEYS.length * Object.keys(LOCALES).length);
  });

  it("say the owner-approved English, verbatim", () => {
    expect(en["stageCard.points.uniform"]).toBe("Win {w} · Loss {l}");
    expect(en["stageCard.locked"]).toBe("Locked: the stage has started");
    expect(en["stageCard.tiebreaks.h2hTwo"]).toBe("If only two are still level at any step, their head-to-head result decides.");
  });

  // Spec §12 Phase C item 4: no internals in organiser copy. The new lines carry none of the words the owner struck.
  it("carry none of the internals wording the owner struck", () => {
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      for (const k of KEYS) expect(dictOf(locale)[k], `${locale} ${k}`).not.toMatch(/pinned|sport default|from before this update/i);
    }
  });
});

describe("stageActions", () => {
  const base: StageActionInput = { status: "active", played: 0, inPlay: 0, unplayed: 0, hasFixtures: true, adhoc: true };
  const of = (over: Partial<StageActionInput>) => stageActions({ ...base, ...over });
  const all = (a: ReturnType<typeof stageActions>) => [a.primary, ...a.secondary];

  // The empty case first: a stage with no fixtures has nothing to complete and nothing to add a match to.
  it("a pending stage with no fixtures offers Generate, and nothing else", () => {
    expect(of({ status: "pending", hasFixtures: false })).toEqual({ primary: "generate", secondary: [] });
  });

  it("an active stage with no fixtures at all offers nothing (nothing to complete, nowhere to add a match)", () => {
    expect(of({ status: "active", hasFixtures: false })).toEqual({ primary: null, secondary: [] });
  });

  it("not started with fixtures: Generate leads, Add match is there for a stage that takes ad-hoc matches, Complete is not", () => {
    const got = of({ status: "pending", unplayed: 3 });
    expect(got.primary).toBe("generate");
    expect(all(got)).not.toContain("complete");
    expect(got.secondary).toContain("add_match");
  });

  // The owner's screenshot: active, one match in play, two still to schedule.
  it("the screenshot case (1 in play, 2 unplayed): Complete is not primary, Generate is gone", () => {
    const got = of({ status: "active", inPlay: 1, unplayed: 2 });
    expect(got.primary).not.toBe("complete");
    expect(got.primary).toBeNull();
    expect(all(got)).not.toContain("generate");
    // Complete stays reachable from the stage-actions menu: it is just never the lead while matches are open.
    expect(got.secondary).toEqual(["add_match", "complete"]);
  });

  it("all played: Complete leads, Generate stays gone, Add match remains", () => {
    const got = of({ status: "active", played: 3 });
    expect(got).toEqual({ primary: "complete", secondary: ["add_match"] });
  });

  it("a stage kind that takes no ad-hoc match never offers Add match", () => {
    for (const s of [
      of({ status: "pending", adhoc: false, unplayed: 3 }),
      of({ status: "active", adhoc: false, inPlay: 1 }),
      of({ status: "active", adhoc: false, played: 3 }),
    ]) {
      expect(all(s)).not.toContain("add_match");
    }
  });

  it("a completed stage offers nothing", () => {
    expect(of({ status: "complete", played: 3 })).toEqual({ primary: null, secondary: [] });
  });

  // Complete is never the lead while anything is open, and Generate never survives the start - swept over the lifecycle
  // (status x counts x the two flags) rather than three hand-picked states.
  it("sweeps the lifecycle: Complete leads only when nothing is open, Generate only before the start", () => {
    let checked = 0;
    let completeLed = 0;
    let generateLed = 0;
    for (const status of ["pending", "active", "complete"]) {
      for (const played of [0, 2]) {
        for (const inPlay of [0, 1]) {
          for (const unplayed of [0, 3]) {
            for (const hasFixtures of [false, true]) {
              for (const adhoc of [false, true]) {
                const s: StageActionInput = { status, played, inPlay, unplayed, hasFixtures, adhoc };
                const got = stageActions(s);
                const open = inPlay + unplayed;
                const started = status !== "pending" || played + inPlay > 0;
                if (got.primary === "complete") {
                  expect(open, JSON.stringify(s)).toBe(0);
                  expect(status, JSON.stringify(s)).not.toBe("complete");
                  expect(hasFixtures, JSON.stringify(s)).toBe(true);
                  completeLed++;
                }
                if (got.primary === "generate") generateLed++;
                if (started) expect(all(got), JSON.stringify(s)).not.toContain("generate");
                if (status === "complete") expect(all(got), JSON.stringify(s)).toEqual([null]);
                expect(new Set(got.secondary).size, `${JSON.stringify(s)}: no action twice`).toBe(got.secondary.length);
                expect(got.secondary, JSON.stringify(s)).not.toContain(got.primary);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked, "anti-vacuity: every combination ran").toBe(3 * 2 * 2 * 2 * 2 * 2);
    expect(completeLed, "some state leads with Complete").toBeGreaterThan(0);
    expect(generateLed, "some state leads with Generate").toBeGreaterThan(0);
  });

  // A pending stage that nonetheless holds a played match is contradictory input; it counts as started, so Generate - the
  // action that would rebuild under a result - is never offered over it.
  it("a stage with a result or a match in play is started whatever its status says", () => {
    expect(all(of({ status: "pending", played: 1, unplayed: 2 }))).not.toContain("generate");
    expect(all(of({ status: "pending", inPlay: 1 }))).not.toContain("generate");
  });

  it("refuses a status it does not know and counts that are no counts (a guard, not a comment)", () => {
    expect(() => of({ status: "archived" })).toThrow(/status/i);
    expect(() => of({ played: -1 })).toThrow(/count/i);
    expect(() => of({ unplayed: Number.NaN })).toThrow(/count/i);
    expect(() => of({ inPlay: 1.5 })).toThrow(/count/i);
  });
});
