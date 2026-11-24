// Blog batch 4 (knockouts): the claims of the five examples have teeth. Each test corrupts the committed golden the way a
// wrong rule would and asserts that a claim notices, and that the untouched golden passes. The harness itself
// (regenerate, every claim passes, leak scan) is blog-examples.test.ts; this file proves those claims are not decoration.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { blogExample } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import { sportLabel } from "@/blog/labels";
import { FORFEIT_REASONS } from "@seazn/engine/core";
import { appDraw, betterSeedWins, forfeitOutClaim, playBracket } from "@/blog/examples/bracket-play-b4";
import { declaredLeagueStages, leagueListsProblem } from "@/blog/examples/knockout-match-ends-level";
import { boardListProblem } from "@/blog/examples/shootout-points";
import { tooFewCopyProblem } from "@/blog/examples/third-place-match";
import { THIRD_PLACE_MIN } from "@/lib/third-place";

// A pass-through of the English copy lookup the third-place example reads (`msg`), with one seam: a test can make the stage's
// too-few-entrants sentence say something else, the way a dictionary edit that drifted from the declared minimum would.
const drift = vi.hoisted(() => ({ tooFew: null as string | null }));
vi.mock("@/lib/messages", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/messages")>();
  return { ...real, msg: (key: Parameters<typeof real.msg>[0], vars?: Parameters<typeof real.msg>[1]) => (key === "thirdPlace.tooFewCount" && drift.tooFew !== null ? drift.tooFew : real.msg(key, vars)) };
});
afterEach(() => {
  drift.tooFew = null;
});

const B4 = ["third-place-match", "knockout-match-ends-level", "page-playoff-and-stepladder", "double-elimination-explained", "what-is-a-plate"];

function failing(id: string, r: ExampleResult): string[] {
  return blogExample(id)!.claims.filter((c) => c.check(r) !== true).map((c) => c.says);
}
function mutate(id: string, f: (r: ExampleResult) => void): ExampleResult {
  const r = structuredClone(BLOG_GOLDENS[id]!);
  f(r);
  return r;
}
const rowWhere = (r: ExampleResult, col: number, value: string) => r.table!.rows.find((row) => String(row[col]) === value || String(row[col]).startsWith(`${value} (`))!;

describe("batch 4 examples are registered, pass on their goldens, and say why they are 'all'", () => {
  it("each is registered with claims, sweeps every sport, and passes", () => {
    let checked = 0;
    for (const id of B4) {
      const e = blogExample(id);
      expect(e, id).not.toBeNull();
      expect(e!.sports, id).toBe("all");
      expect(e!.claims.length, `${id}: claims`).toBeGreaterThanOrEqual(5);
      expect(failing(id, BLOG_GOLDENS[id]!), id).toEqual([]);
      expect(BLOG_GOLDENS[id]!.facts.sportCount, `${id}: sports swept`).toBe(builtinModules.length);
      checked++;
    }
    expect(checked).toBe(B4.length);
  });
});

describe("third-place-match", () => {
  const id = "third-place-match";
  it("a shared 3rd placed 4th, a 4th place in the shared bracket, or a play-off decided by seed is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Dev")[2] = "4th"; })).length).toBeGreaterThan(0);
    // "1-2-3-3-4": the wrong constant for the place after a shared third.
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Eli")[2] = "4th"; r.facts.nextPlaceAfterShared = "4th"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Cy")[3] = "3rd"; rowWhere(r, 0, "Dev")[3] = "4th"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Gus")[2] = "6th"; })).length).toBeGreaterThan(0);
  });
  it("a play-off allowed at three players, an extra match count or a sport left out is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.facts.smallestPlayoffField = 3; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.facts.matchesPlayoff = Number(r.facts.matchesShared) + 2; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.facts.sportsOffered = builtinModules.length - 1; }))).toHaveLength(1);
  });
  it("the too-few-entrants sentence the post quotes: a changed count or a changed minimum is caught, and the copy that is true is not", () => {
    const said = String(BLOG_GOLDENS[id]!.facts.tooFewMessage);
    const min = THIRD_PLACE_MIN;
    expect(tooFewCopyProblem(said, min), "the committed sentence").toBe(true);
    // The product's own sentence for the declared minimum, then the same sentence with the count and the size each moved on by one.
    const cases: [string, string][] = [
      ["the entrants it counts", said.replace(`has ${min - 1} entrants`, `has ${min - 2} entrants`)],
      ["the size it asks for", said.replace(`at least ${min}`, `at least ${min + 1}`)],
      ["the size it asks for, spelled as a word", said.replace(`at least ${min}`, "at least four")],
    ];
    for (const [what, doctored] of cases) {
      expect(doctored, `${what}: the doctored sentence differs`).not.toBe(said);
      expect(tooFewCopyProblem(doctored, min), what).not.toBe(true);
    }
    // The wrong declared minimum is caught the other way round: the sentence is right for 4 and the declaration says 5.
    expect(tooFewCopyProblem(said, min + 1)).not.toBe(true);
    expect(cases.length, "cases refused").toBe(3);
    expect(failing(id, mutate(id, (r) => { r.facts.tooFewMessage = said.replace(`has ${min - 1} entrants`, `has ${min} entrants`); })), "a stage that is no short of the minimum").toHaveLength(1);
  });
  it("a dictionary that asks for another size than the declared minimum is caught even when the post quotes the dictionary faithfully", () => {
    // The shipped sentence drifts to 'at least 5' while THIRD_PLACE_MIN stays 4: the fact and the product copy agree with each other, so only the declared minimum can refuse it.
    const drifted = String(BLOG_GOLDENS[id]!.facts.tooFewMessage).replace(`at least ${THIRD_PLACE_MIN}`, `at least ${THIRD_PLACE_MIN + 1}`);
    expect(drifted, "the drifted sentence differs").not.toBe(BLOG_GOLDENS[id]!.facts.tooFewMessage);
    expect(failing(id, mutate(id, () => undefined)), "before the drift").toHaveLength(0);
    drift.tooFew = drifted;
    expect(failing(id, mutate(id, (r) => { r.facts.tooFewMessage = drifted; })), "after the drift").toHaveLength(1);
  });
});

describe("knockout-match-ends-level", () => {
  const id = "knockout-match-ends-level";
  it("every sport's row is claimed: a wrong decider or a wrong 'still level' answer is caught by that sport's own claims", () => {
    const e = blogExample(id)!;
    let corrupted = 0;
    const visited = forEachSport(({ key }) => {
      const label = sportLabel(key);
      for (const [col, value] of [[1, "Coin toss"], [2, "Maybe"]] as const) {
        const r = mutate(id, (x) => { rowWhere(x, 0, label)[col] = value; });
        const own = e.claims.filter((c) => c.sport === key && c.check(r) !== true);
        expect(own.length, `${key} column ${col}`).toBeGreaterThan(0);
        corrupted++;
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(corrupted).toBe(builtinModules.length * 2);
  });
  it("a youth shoot-out typed as the adult count, a missing kick number, or a league preset with deciders is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.facts.footballYouthKicks = r.facts.footballKicks!; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Football")[1] = "Extra time, penalties"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.leagueRulesPresetCount = 2; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[0] !== "Tennis"); })).length).toBeGreaterThan(0);
  });
});

describe("shootout-points: the sports that break a level league match with an extra board are named apart", () => {
  const id = "shootout-points";
  it("a missing, extra or renamed sport in the list is caught by the one claim, and the list is not empty", () => {
    const r0 = mutate(id, () => undefined);
    expect(failing(id, r0), "the committed result passes every claim before it is corrupted").toHaveLength(0);
    const listed = String(r0.facts.leagueBoardSports);
    expect(listed, "the fact exists").not.toBe("undefined");
    expect(listed.length, "sports named").toBeGreaterThan(0);
    // The list names no sport that the beyond-regulation list names: the two lists are apart.
    expect(String(r0.facts.beyondList).toLowerCase(), "the beyond list holds none of them").not.toContain(listed.toLowerCase());
    let caught = 0;
    for (const v of ["", `${listed} and football`, "ice hockey", listed.toLowerCase()]) {
      expect(failing(id, mutate(id, (r) => { r.facts.leagueBoardSports = v; })), `leagueBoardSports = '${v}'`).toHaveLength(1);
      caught++;
    }
    expect(caught, "mutants run").toBe(4);
  });
  it("the claim refuses a sweep that saw nothing, a sport that decides some other way, a renamed decider word and a wrong list", () => {
    const ok = { visited: builtinModules.length, board: ["Carrom"], other: [] as string[], word: "extra board", fact: "Carrom" };
    expect(boardListProblem(ok), "a sound sweep").toBe(true);
    const refused: [string, Parameters<typeof boardListProblem>[0], RegExp][] = [
      ["no sport visited", { ...ok, visited: 0 }, /visited no sport/],
      ["nobody breaks a tie with a board", { ...ok, board: [], fact: "" }, /nothing to name/],
      ["a sport that decides some other way", { ...ok, other: ["Tennis"] }, /some other way/],
      ["the product renames the decider", { ...ok, word: "tie board" }, /the post says 'extra board'/],
      ["a list with another sport", { ...ok, fact: "Carrom and football" }, /leagueBoardSports is/],
    ];
    for (const [what, doctored, why] of refused) expect(boardListProblem(doctored), what).toMatch(why);
    expect(refused.length, "cases refused").toBe(5);
  });
});

describe("knockout-match-ends-level: what a new LEAGUE stage plays, swept over every sport", () => {
  const id = "knockout-match-ends-level";
  it("a league list that drops a sport that decides, adds one that does not, or forgets the variant that does, is caught by the one sweep claim", () => {
    const r0 = mutate(id, () => undefined);
    // The committed lists are non-trivial: each names at least one sport, and the three lists share none (the anti-vacuity of the cases below).
    const [level, decides, variants] = ["leagueLevelSports", "leagueDecidesSports", "leagueDecidesVariants"].map((k) => String(r0.facts[k]));
    expect(level!.length, "sports that stay level").toBeGreaterThan(0);
    expect(decides!.length, "sports that decide in a league").toBeGreaterThan(0);
    expect(variants!.length, "variants that decide in a league").toBeGreaterThan(0);
    let caught = 0;
    for (const [k, v] of [
      ["leagueDecidesSports", "Ice hockey"],
      ["leagueDecidesSports", `${decides!} and football`],
      ["leagueDecidesVariants", ""],
      ["leagueLevelSports", `${level!} and ice hockey`],
      ["leagueLevelSports", "football"],
    ] as const) {
      expect(failing(id, mutate(id, (r) => { r.facts[k] = v; })), `${k} = '${v}'`).toHaveLength(1);
      caught++;
    }
    expect(caught, "mutants run").toBe(5);
  });
  it("the claim refuses a registry it cannot read anything from: no sport, a short sweep, nobody deciding, nobody level, a league preset, a wrong list", () => {
    const d = declaredLeagueStages();
    const facts = mutate(id, () => undefined).facts;
    expect(leagueListsProblem(d, facts, builtinModules.length), "the committed lists").toBe(true);
    expect(d.swept, "sports swept").toBe(builtinModules.length);
    expect(d.variants, "variants swept").toBeGreaterThanOrEqual(builtinModules.length);
    const refused: [string, ReturnType<typeof declaredLeagueStages>, RegExp][] = [
      ["no sport swept", { ...d, swept: 0 }, /0 sports swept/],
      ["a short sweep", { ...d, swept: d.swept - 1 }, /sports swept of/],
      ["fewer variants than sports", { ...d, variants: d.swept - 1 }, /variants swept over/],
      ["nobody decides in a league", { ...d, decides: [] }, /anti-vacuity/],
      ["nobody stays level", { ...d, level: [] }, /anti-vacuity/],
      ["a league stage with a preset decider", { ...d, presetKeys: 1 }, /presets 1 decider keys/],
      ["a list that names a sport more", { ...d, decides: [...d.decides, "Football"] }, /leagueDecidesSports is/],
    ];
    for (const [what, doctored, why] of refused) expect(leagueListsProblem(doctored, facts, builtinModules.length), what).toMatch(why);
    expect(refused.length, "cases refused").toBe(7);
  });
  it("the hockey rows say what the declarations say: ice hockey's starting variant decides a league match, hockey's starting variant does not, its FIH shoot-out variant does", () => {
    const r0 = mutate(id, () => undefined);
    expect(String(r0.facts.leagueDecidesSports)).toContain("ice hockey");
    expect(String(r0.facts.leagueLevelSports)).toContain("hockey");
    expect(String(r0.facts.leagueLevelSports)).not.toContain("ice hockey");
    expect(String(r0.facts.leagueDecidesVariants)).toContain("Hockey");
  });
});

describe("page-playoff-and-stepladder", () => {
  const id = "page-playoff-and-stepladder";
  it("a Page playoff that knocks out the Qualifier 1 loser, pairs 1 v 3, or keeps the Eliminator loser is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Qualifier 2")[2] = "Ben (2) v Cy (3)"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Qualifier 1")[2] = "Ana (1) v Cy (3)"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Final")[2] = "Ben (2) v Dev (4)"; })).length).toBeGreaterThan(0);
  });
  it("a stepladder with a missing rung, or a top seed playing twice, is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Rung 2"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.stepTopMatches = 2; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.pageField = 5; })).length).toBeGreaterThan(0);
  });
});

describe("double-elimination-explained", () => {
  const id = "double-elimination-explained";
  it("a player out after one defeat, a winners' loser who never plays again, or a reset after the unbeaten player won is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Losers' round 1"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Grand final (reset)"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Grand final")[3] = "Ana (1)"; })).length).toBeGreaterThan(0);
    // The wrong constant: without the reset the runner-up is NOT out after two defeats.
    expect(failing(id, mutate(id, (r) => { r.facts.noResetRunnerUpDefeats = 2; }))).toHaveLength(1);
  });
});

describe("what-is-a-plate", () => {
  const id = "what-is-a-plate";
  it("a walkover loser in the plate, the bye holder left out, or a later loser drawn in is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Fay")[4] = "Yes"; })).length).toBeGreaterThan(0);
    // The wrong constant: a round-one-losers-only plate leaves out the bye holder.
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Ana")[4] = "No"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Ben")[4] = "Yes"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.sportsOffered = 0; }))).toHaveLength(1);
  });
  it("review I-3: the walkover winner's first match is the NEXT one, and losing it puts them in the plate; the walkover-as-first-match reading is caught", () => {
    const winner = String(BLOG_GOLDENS[id]!.facts.walkoverWinner);
    const asWalkoverReading = (r: ExampleResult) => {
      // The wrong reading: the walkover win counts as the player's first match, so a later loss is no first loss.
      const row = rowWhere(r, 0, winner);
      row[1] = "Quarter-finals";
      row[2] = "Won";
      row[4] = "No";
    };
    const caught = failing(id, mutate(id, asWalkoverReading));
    expect(caught.length, "the wrong reading is caught").toBeGreaterThan(0);
    expect(caught.some((c) => c.includes("WON a first-round walkover")), "by the walkover-winner claim itself").toBe(true);
    // The untouched golden shows the two readings DIFFER: this player is in the plate.
    expect(rowWhere(BLOG_GOLDENS[id]!, 0, winner)[4]).toBe("Yes");
    // A plate list that drops the walkover winner, or a left-out name that is not the walkover loser, is caught.
    expect(failing(id, mutate(id, (r) => { r.facts.plateNames = String(r.facts.plateNames).split(", ").filter((n) => n !== winner).join(", "); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.excludedNames = winner; })).length).toBeGreaterThan(0);
  });
});

describe("no batch 4 claim is vacuous: an empty result fails every one of them", () => {
  it("claims never pass on an empty result", () => {
    let checked = 0;
    for (const id of B4) {
      const e = blogExample(id)!;
      for (const c of e.claims) {
        expect(c.check({ facts: {}, text: [] }), `${id}: ${c.says}`).not.toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(B4.length * 5);
  });
});

// ---- fix round 1: a forfeit loser is out at once (X-DE-1) ----
describe("bracket-play-b4: a forfeiter is never seated on a loser edge (the app's advancingSides sends nobody)", () => {
  const FOUR = ["Ana", "Ben", "Cy", "Dev"] as const;
  const SEEDS4 = new Map<string, number>(FOUR.map((p, i) => [p, i + 1]));
  type Kind = "knockout" | "double_elim" | "page_playoff";
  const draw = (kind: Kind, cfg: Record<string, unknown>) => {
    const d = appDraw(kind, cfg, FOUR, SEEDS4);
    if ("refused" in d) throw new Error(`the four-player ${kind} draw was refused`);
    return d;
  };
  /** The named line is forfeited by its home side; every other line goes to the better seed. */
  const forfeitAt = (lineId: string) => (home: string, away: string, f: Parameters<ReturnType<typeof betterSeedWins>>[2]) =>
    f.id === lineId ? { forfeitedBy: home } : betterSeedWins(SEEDS4)(home, away, f);

  it("a forfeit in a line whose loser edge feeds another line is refused by name, for every format that has loser edges", () => {
    // Each case forfeits a line that FEEDS a loser edge: a winners' round-one line, a semi-final with a third-place match,
    // and Qualifier 1 (whose loser meets the Eliminator's winner).
    const cases: { kind: Kind; cfg: Record<string, unknown>; line: (d: ReturnType<typeof draw>) => string }[] = [
      { kind: "double_elim", cfg: {}, line: (d) => d.fixtures.find((f) => f.bracket === "WB" && f.round === 0)!.id },
      { kind: "knockout", cfg: { thirdPlace: true }, line: (d) => d.fixtures.find((f) => f.round === 0)!.id },
      { kind: "page_playoff", cfg: {}, line: (d) => d.fixtures.find((f) => f.id === "pp-q1")!.id },
    ];
    let refused = 0;
    for (const c of cases) {
      const d = draw(c.kind, c.cfg);
      const line = c.line(d);
      expect(() => playBracket(c.kind, d, forfeitAt(line) as never), `${c.kind}: forfeit at ${line}`).toThrow(/forfeited it and is out.*advancingSides/);
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it("the guard does not refuse a forfeit whose loser has no loser edge to fall down (the pair that keeps it from refusing everything)", () => {
    // A plain knockout has no loser edges; a double elimination's losers' bracket line sends its loser out for good.
    const ko = draw("knockout", {});
    const koLines = playBracket("knockout", ko, forfeitAt(ko.fixtures.find((f) => f.round === 0)!.id) as never);
    expect(koLines.filter((l) => l.row.walkedOver === "loser").length).toBe(1);
    const de = draw("double_elim", {});
    const lb = de.fixtures.find((f) => f.bracket === "LB")!.id;
    const deLines = playBracket("double_elim", de, forfeitAt(lb) as never);
    expect(deLines.filter((l) => l.row.walkedOver === "loser").length).toBe(1);
  });
});

describe("the forfeit claim: a forfeit, withdrawal, retirement or disqualification loser is out, read from the app's own rule", () => {
  const withRows = { facts: {}, text: [], table: { caption: "c", columns: ["a"], rows: [["x"]] } };
  it("holds on the app's real rule for every reason the engine declares, and fails an empty result", () => {
    expect(FORFEIT_REASONS.length, "anti-vacuity: declared forfeit reasons").toBeGreaterThan(0);
    const claim = forfeitOutClaim();
    expect(claim.check(withRows)).toBe(true);
    expect(claim.check({ facts: {}, text: [] })).not.toBe(true);
  });
  it("fails a rule that sends the forfeit loser down the loser edge, or does not read the edge as dead", () => {
    const sends = forfeitOutClaim({ advancingSides: (o) => ({ winner: (o as { winner: string }).winner, loser: (o as { loser: string }).loser }), killsLoserEdge: () => true });
    expect(sends.check(withRows)).not.toBe(true);
    const alive = forfeitOutClaim({ advancingSides: (o) => ({ winner: (o as { winner: string }).winner, loser: undefined }), killsLoserEdge: () => false });
    expect(alive.check(withRows)).not.toBe(true);
    // One reason only: a rule that forgets `retired` alone is caught, so the claim sweeps every declared reason.
    const forgetsRetired = forfeitOutClaim({
      advancingSides: (o) => ({ winner: (o as { winner: string }).winner, loser: (o as { reason: string }).reason === "retired" ? (o as { loser: string }).loser : undefined }),
      killsLoserEdge: () => true,
    });
    expect(forgetsRetired.check(withRows)).not.toBe(true);
  });
});

describe("every fact a batch 4 post prints is tied to a claim", () => {
  // Minor 6 of review 1: prose facts (pageChampion, stepBottomWins, wbChampionPlace, plateNames, playoff places, semiLoserA/B ...)
  // were printed in a post and tied to no claim, so a wrong golden value would have shipped as a true-looking sentence.
  // The posts are the authority on WHICH facts are printed; each is corrupted in turn and some claim must fail.
  const CONTENT = join(process.cwd(), "content", "blog");
  const corrupt = (v: string | number): string | number => (typeof v === "number" ? v + 1 : `${v} (corrupted)`);
  it("corrupting any single cited fact fails at least one claim, and the cited set is read from the posts", () => {
    let cited = 0;
    const survivors: string[] = [];
    for (const id of B4) {
      const body = readFileSync(join(CONTENT, `${id}.md`), "utf8");
      const keys = [...new Set([...body.matchAll(new RegExp(`\\{\\{fact:${id}\\.([A-Za-z0-9]+)\\}\\}`, "g"))].map((m) => m[1]!))];
      expect(keys.length, `${id}: the post cites no fact, so this check would be vacuous`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(BLOG_GOLDENS[id]!.facts, `${id}: ${key} is cited by the post but absent from the golden`).toHaveProperty(key);
        cited++;
        if (failing(id, mutate(id, (r) => { r.facts[key] = corrupt(r.facts[key]!); })).length === 0) survivors.push(`${id}.${key}`);
      }
    }
    expect(cited, "facts checked").toBeGreaterThan(40);
    expect(survivors, "cited facts no claim notices").toEqual([]);
  });
});
