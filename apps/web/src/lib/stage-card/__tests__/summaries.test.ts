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
  stageCounts,
  summarisePoints,
  unitLabelKey,
  type StageAction,
  type StageActionInput,
  type StageButton,
} from "@/lib/stage-card/summaries";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { Fixture } from "@/server/api-v1/schemas";
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

describe("stageCounts", () => {
  // The three buckets are read off the fixture-status declarations the rest of the app already holds (`lib/fixture-status.ts`,
  // held to the V432 CHECK by its own migration test) and the owner/controller ruling for this card: OPEN is scheduled,
  // in_play and the held needs_decision; SETTLED is decided, finalized, forfeited, abandoned and cancelled.
  const OPEN = ["scheduled", "in_play", "needs_decision"] as const;
  const SETTLED = ["decided", "finalized", "forfeited", "abandoned", "cancelled"] as const;

  it("empty -> all zero", () => {
    expect(stageCounts([])).toEqual({ played: 0, inPlay: 0, unplayed: 0 });
  });

  it("accumulates a mixed list, leaves its input alone, and answers the same twice", () => {
    const fixtures = [
      { status: "decided" },
      { status: "decided" },
      { status: "forfeited" },
      { status: "in_play" },
      { status: "scheduled" },
      { status: "scheduled" },
      { status: "scheduled" },
      { status: "needs_decision" },
    ];
    const copy = fixtures.map((f) => ({ ...f }));
    const first = stageCounts(fixtures);
    expect(first).toEqual({ played: 3, inPlay: 2, unplayed: 3 });
    expect(fixtures).toEqual(copy);
    expect(stageCounts(fixtures)).toEqual(first);
  });

  // Anti-vacuity: the schema's own status list (the Zod enum the run-sheet tests sweep) is the population, and it is held to
  // the lib list first, so a status added to the schema fails HERE rather than going uncounted.
  it("sweeps every fixtures.status: each lands in exactly one bucket, the one its class says", () => {
    const statuses: readonly string[] = Fixture.shape.status.options;
    expect([...statuses].sort(), "premise: the schema and lib/fixture-status.ts agree").toEqual([...FIXTURE_STATUSES].sort());
    expect([...OPEN, ...SETTLED].sort(), "premise: this test classifies every status once").toEqual([...statuses].sort());
    // And the settled set is the app's own two declarations, not a second spelling of it.
    expect([...SETTLED].sort()).toEqual([...SETTLED_FIXTURE_STATUSES, ...LOCKED_FIXTURE_STATUSES].sort());
    let checked = 0;
    for (const status of statuses) {
      const got = stageCounts([{ status }]);
      expect(got.played + got.inPlay + got.unplayed, `${status}: exactly one bucket`).toBe(1);
      if ((SETTLED as readonly string[]).includes(status)) expect(got, status).toEqual({ played: 1, inPlay: 0, unplayed: 0 });
      else expect(got.played, `${status} is open, never played`).toBe(0);
      if (status === "scheduled") expect(got.unplayed, status).toBe(1);
      if (status === "in_play" || status === "needs_decision") expect(got.inPlay, status).toBe(1);
      checked++;
    }
    expect(checked, "anti-vacuity: statuses swept").toBe(statuses.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("refuses a status it does not know, including an Object.prototype name (a guard, not a comment)", () => {
    expect(() => stageCounts([{ status: "paused" }])).toThrow(/unknown fixture status "paused"/);
    expect(() => stageCounts([{ status: "constructor" }])).toThrow(/unknown fixture status/);
    expect(() => stageCounts([{ status: "" }])).toThrow(/unknown fixture status/);
  });

  // The seam, driven through its real consumer: one fixture of each status on an active stage. Settled ones leave nothing open
  // so Complete leads, enabled; an open one holds Complete back, disabled, whatever its flavour.
  it("feeds stageActions: Complete leads on a settled status and is held back, disabled, on an open one", () => {
    let checked = 0;
    for (const status of Fixture.shape.status.options) {
      const got = stageActions({
        status: "active", ...stageCounts([{ status }]), hasFixtures: true, adhoc: false, pairNext: false, canUnpair: false,
      });
      if ((SETTLED as readonly string[]).includes(status)) {
        expect(got, status).toEqual({ primary: { action: "complete", enabled: true }, secondary: [] });
      } else {
        expect(got, status).toEqual({ primary: null, secondary: [{ action: "complete", enabled: false }] });
      }
      checked++;
    }
    expect(checked).toBe(OPEN.length + SETTLED.length);
  });
});

describe("stageCounts - held fixtures (a plain abandon awaiting its settle keeps status 'abandoned')", () => {
  // Review I2: the status map reads `abandoned` as settled, but the page lists it as awaiting its settle and the server still
  // refuses Complete for it (W2b X-AB-5). The held ids make it OPEN, whatever its status says.
  it("an abandoned fixture is played without the held list and open (inPlay) with it", () => {
    const fixtures = [{ id: "a", status: "decided" }, { id: "b", status: "abandoned" }];
    expect(stageCounts(fixtures)).toEqual({ played: 2, inPlay: 0, unplayed: 0 });
    expect(stageCounts(fixtures, new Set(["b"]))).toEqual({ played: 1, inPlay: 1, unplayed: 0 });
  });

  it("a held id counts once, in inPlay, for every status the schema has; an id that is not held changes nothing", () => {
    let checked = 0;
    for (const status of Fixture.shape.status.options) {
      expect(stageCounts([{ id: "x", status }], new Set(["x"])), `${status}: held`).toEqual({ played: 0, inPlay: 1, unplayed: 0 });
      expect(stageCounts([{ id: "x", status }], new Set(["y"])), `${status}: someone else's id`).toEqual(stageCounts([{ id: "x", status }]));
      checked++;
    }
    expect(checked, "anti-vacuity: statuses swept").toBe(Fixture.shape.status.options.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the status sweep stays honest: an unknown status is refused even when the fixture is held", () => {
    expect(() => stageCounts([{ id: "x", status: "paused" }], new Set(["x"]))).toThrow(/unknown fixture status "paused"/);
  });

  it("feeds stageActions: a stage whose only unsettled match is a held abandon has Complete disabled, not leading", () => {
    const fixtures = [{ id: "a", status: "decided" }, { id: "b", status: "abandoned" }];
    const input = { status: "active", hasFixtures: true, adhoc: false, pairNext: false, canUnpair: false };
    expect(stageActions({ ...input, ...stageCounts(fixtures) }), "no held list: the old answer").toEqual({ primary: { action: "complete", enabled: true }, secondary: [] });
    expect(stageActions({ ...input, ...stageCounts(fixtures, new Set(["b"])) })).toEqual({ primary: null, secondary: [{ action: "complete", enabled: false }] });
  });
});

describe("stageActions", () => {
  const base: StageActionInput = {
    status: "active", played: 0, inPlay: 0, unplayed: 0, hasFixtures: true, adhoc: true, pairNext: false, canUnpair: false,
  };
  const of = (over: Partial<StageActionInput>) => stageActions({ ...base, ...over });
  const on = (action: StageAction): StageButton => ({ action, enabled: true });
  const off = (action: StageAction): StageButton => ({ action, enabled: false });
  const named = (a: ReturnType<typeof stageActions>): StageAction[] =>
    [a.primary, ...a.secondary].filter((b): b is StageButton => b !== null).map((b) => b.action);

  // The empty case first: a stage with no fixtures has nothing to complete and nothing to add a match to.
  it("a pending stage with no fixtures offers Generate, and nothing else", () => {
    expect(of({ status: "pending", hasFixtures: false })).toEqual({ primary: on("generate"), secondary: [] });
  });

  it("an active stage with no fixtures at all offers nothing (nothing to complete, nowhere to add a match)", () => {
    expect(of({ status: "active", hasFixtures: false })).toEqual({ primary: null, secondary: [] });
  });

  it("not started with fixtures: Generate leads, Add match is there for a stage that takes ad-hoc matches, Complete is not", () => {
    expect(of({ status: "pending", unplayed: 3 })).toEqual({ primary: on("generate"), secondary: [on("add_match")] });
  });

  // The owner's screenshot: active, one match in play, two still to schedule.
  it("the screenshot case (1 in play, 2 unplayed): no lead, Generate gone, Complete present but DISABLED", () => {
    expect(of({ status: "active", inPlay: 1, unplayed: 2 })).toEqual({
      primary: null,
      secondary: [on("add_match"), off("complete")],
    });
  });

  // Any single open match disables Complete - in play and not yet begun alike (a check on `unplayed` alone, or `inPlay` alone,
  // would leave Complete enabled over the other).
  it("Complete is disabled while ANY match is open and enabled, as the lead, once none is", () => {
    expect(of({ inPlay: 1 }).secondary).toContainEqual(off("complete"));
    expect(of({ unplayed: 1 }).secondary).toContainEqual(off("complete"));
    expect(of({ played: 5, inPlay: 1 }).secondary).toContainEqual(off("complete"));
    expect(of({ played: 5, unplayed: 1 }).secondary).toContainEqual(off("complete"));
    expect(of({ played: 5 })).toEqual({ primary: on("complete"), secondary: [on("add_match")] });
  });

  it("all played: Complete leads, enabled; Generate stays gone; Add match remains", () => {
    expect(of({ status: "active", played: 3 })).toEqual({ primary: on("complete"), secondary: [on("add_match")] });
  });

  it("a stage kind that takes no ad-hoc match never offers Add match", () => {
    for (const s of [
      of({ status: "pending", adhoc: false, unplayed: 3 }),
      of({ status: "active", adhoc: false, inPlay: 1 }),
      of({ status: "active", adhoc: false, played: 3 }),
    ]) {
      expect(named(s)).not.toContain("add_match");
    }
  });

  it("a completed stage offers nothing - not even Unpair or Pair next", () => {
    expect(of({ status: "complete", played: 3 })).toEqual({ primary: null, secondary: [] });
    expect(of({ status: "complete", played: 3, canUnpair: true, pairNext: true })).toEqual({ primary: null, secondary: [] });
  });

  // I1 (stage-rail.tsx): a Swiss stage becomes active once round 1 is paired, and "Pair next round" is a generate on that
  // ACTIVE stage. The rail's own comment records the defect where Complete led over it (2026-09-20).
  describe("Swiss", () => {
    it("round 1 all played, rounds still to pair: Pair next leads and Complete does not (counts that leave the unseated shells out)", () => {
      const got = of({ status: "active", played: 4, pairNext: true });
      expect(got.primary).toEqual(on("pair_next"));
      expect(got.secondary).toEqual([on("add_match"), on("complete")]);
      expect(named(got)).not.toContain("generate");
    });

    it("the same stage with its unseated shells counted as unplayed: Pair next leads and Complete is disabled", () => {
      const got = of({ status: "active", played: 4, unplayed: 4, pairNext: true });
      expect(got.primary).toEqual(on("pair_next"));
      expect(got.secondary).toEqual([on("add_match"), off("complete")]);
    });

    it("shells minted, nothing paired yet (still pending): Pair next leads; no Generate, no Complete", () => {
      const got = of({ status: "pending", unplayed: 4, pairNext: true });
      expect(got).toEqual({ primary: on("pair_next"), secondary: [on("add_match")] });
    });

    // The rail's label gate is `fixtureCount > 0 && swissHasUnseated`; with no fixtures it says Generate fixtures.
    it("a round to pair but no fixtures at all is still Generate (the rail's own gate), not Pair next", () => {
      expect(of({ status: "pending", hasFixtures: false, pairNext: true })).toEqual({ primary: on("generate"), secondary: [] });
    });

    it("every round paired and played: Complete leads again", () => {
      expect(of({ status: "active", played: 12, pairNext: false })).toEqual({ primary: on("complete"), secondary: [on("add_match")] });
    });

    it("Unpair is offered when the panel says the latest round can be unpaired, and not otherwise", () => {
      const seated = of({ status: "active", unplayed: 4, canUnpair: true });
      expect(seated).toEqual({ primary: null, secondary: [on("add_match"), on("unpair"), off("complete")] });
      expect(named(of({ status: "active", unplayed: 4, canUnpair: false }))).not.toContain("unpair");
    });

    it("Unpair sits beside Pair next while later rounds wait (the rail shows both)", () => {
      const got = of({ status: "active", unplayed: 4, pairNext: true, canUnpair: true });
      expect(got.primary).toEqual(on("pair_next"));
      expect(got.secondary).toContainEqual(on("unpair"));
    });
  });

  // M1: "started" is stated here as a RULE, not copied from the code. Spec §12 item 8 hides Generate once the stage has
  // started; `generateStageFixtures` (server/usecases/stages.ts) is what moves a stage pending -> active, so a stage has
  // started exactly when its status is no longer pending - and a match with a result or under way is proof of it whatever the
  // status says (contradictory input is read as started, so Generate never offers to rebuild under a result). Hand-written
  // truth table of whether Generate is offered (no round to pair, so Pair next cannot stand in for it).
  const STARTED_STATUSES = new Set(["active", "complete"]);
  const startedByRule = (status: string, played: number, inPlay: number): boolean => STARTED_STATUSES.has(status) || played > 0 || inPlay > 0;

  it("Generate is offered exactly on a stage that has not started (hand-written truth table)", () => {
    const table: [string, number, number, boolean][] = [
      // status,    played, inPlay, Generate offered
      ["pending", 0, 0, true],
      ["pending", 1, 0, false],
      ["pending", 0, 1, false],
      ["pending", 3, 2, false],
      ["active", 0, 0, false],
      ["active", 2, 0, false],
      ["active", 0, 1, false],
      ["complete", 0, 0, false],
      ["complete", 6, 0, false],
    ];
    for (const [status, played, inPlay, offered] of table) {
      const got = of({ status, played, inPlay, unplayed: 0, hasFixtures: true });
      expect(named(got).includes("generate"), `${status} played=${played} inPlay=${inPlay}`).toBe(offered);
      expect(startedByRule(status, played, inPlay), `rule: ${status} played=${played} inPlay=${inPlay}`).toBe(!offered);
    }
    expect(table.length).toBeGreaterThan(0);
  });

  // The lifecycle swept (status x counts x the five flags), each property stated from the owner's rulings and the rail's gates
  // rather than recomputed from the function's own branches.
  it("sweeps the lifecycle: every button's presence, lead and enabled flag follow the stated rules", () => {
    let checked = 0;
    const seen = { completeLed: 0, generateLed: 0, pairNextLed: 0, completeDisabled: 0, unpair: 0 };
    for (const status of ["pending", "active", "complete"]) {
      for (const played of [0, 2]) {
        for (const inPlay of [0, 1]) {
          for (const unplayed of [0, 3]) {
            for (const hasFixtures of [false, true]) {
              for (const adhoc of [false, true]) {
                for (const pairNext of [false, true]) {
                  for (const canUnpair of [false, true]) {
                    const s: StageActionInput = { status, played, inPlay, unplayed, hasFixtures, adhoc, pairNext, canUnpair };
                    const got = stageActions(s);
                    const at = JSON.stringify(s);
                    const actions = named(got);
                    const open = inPlay + unplayed;
                    const live = status !== "complete";
                    const started = startedByRule(status, played, inPlay);
                    const pairing = pairNext && hasFixtures;
                    // Nothing is offered on a complete stage.
                    if (!live) expect(actions, at).toEqual([]);
                    // A lead is always pressable; a button never appears twice.
                    if (got.primary !== null) expect(got.primary.enabled, at).toBe(true);
                    expect(new Set(actions).size, `${at}: no action twice`).toBe(actions.length);
                    // Generate: only before the start, and not in place of a round to pair.
                    expect(actions.includes("generate"), at).toBe(live && !started && !pairing);
                    // Pair next: whenever a round waits and the stage has fixtures; it leads.
                    expect(actions.includes("pair_next"), at).toBe(live && pairing);
                    if (live && pairing) expect(got.primary?.action, at).toBe("pair_next");
                    // Unpair: the panel's flag, on any live stage.
                    expect(actions.includes("unpair"), at).toBe(live && canUnpair);
                    // Add match: a kind that takes one, with fixtures.
                    expect(actions.includes("add_match"), at).toBe(live && adhoc && hasFixtures);
                    // Complete: present once started with fixtures; enabled exactly when nothing is open; leads only then,
                    // and never over a round to pair.
                    const complete = [got.primary, ...got.secondary].find((b) => b?.action === "complete") ?? null;
                    expect(complete !== null, at).toBe(live && started && hasFixtures);
                    if (complete !== null) {
                      expect(complete.enabled, at).toBe(open === 0);
                      if (!complete.enabled) seen.completeDisabled++;
                    }
                    if (got.primary?.action === "complete") {
                      expect(open, at).toBe(0);
                      expect(pairing, at).toBe(false);
                      seen.completeLed++;
                    }
                    if (got.primary?.action === "generate") seen.generateLed++;
                    if (got.primary?.action === "pair_next") seen.pairNextLed++;
                    if (actions.includes("unpair")) seen.unpair++;
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked, "anti-vacuity: every combination ran").toBe(3 * 2 * 2 * 2 * 2 * 2 * 2 * 2);
    for (const [what, n] of Object.entries(seen)) expect(n, `some state: ${what}`).toBeGreaterThan(0);
  });

  it("refuses a status it does not know and counts that are no counts (a guard, not a comment)", () => {
    expect(() => of({ status: "archived" })).toThrow(/status/i);
    expect(() => of({ played: -1 })).toThrow(/count/i);
    expect(() => of({ unplayed: Number.NaN })).toThrow(/count/i);
    expect(() => of({ inPlay: 1.5 })).toThrow(/count/i);
  });
});
