// Batch 1's five examples (posts #2 to #6: shoot-out points, cricket ties and no results, chess half points, matches won
// first, the table tennis loss). The registry test (blog-examples.test.ts) proves every example matches its golden and
// that every claim passes; this file proves the claims have TEETH: corrupt any cell of any table, any fact, any row, and
// some claim of that example notices. A claim nothing can fail is decoration (TEST-STRATEGY, class 3). Each count is
// reported, and a zero is a failure.
//
// Never `vitest -u`: it runs the whole suite. `UPDATE_BLOG_EXAMPLES=1` rewrites the goldens (blog-examples.test.ts).
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { blogExample } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";

const BATCH1 = ["shootout-points", "cricket-points", "chess-points", "matches-won-first", "table-tennis-loss"] as const;
// The fewest claims each example carries today: a floor, so a deleted claim is a red, never a silent shrink.
const MIN_CLAIMS: Record<(typeof BATCH1)[number], number> = {
  "shootout-points": 1 + 11 * 4, // one registry-wide claim, four per sport
  "cricket-points": 5,
  "chess-points": 5,
  "matches-won-first": 8,
  "table-tennis-loss": 5,
};

const failingClaims = (id: string, r: ExampleResult) => blogExample(id)!.claims.filter((c) => c.check(r) !== true);

describe("batch 1 examples: present, passing, and swept over what they claim to sweep", () => {
  it("all five are registered with a golden, and every claim of each passes", () => {
    let claims = 0;
    for (const id of BATCH1) {
      const e = blogExample(id);
      expect(e, `${id}: registered`).not.toBeNull();
      expect(BLOG_GOLDENS[id], `${id}: golden`).toBeDefined();
      expect(e!.claims.length, `${id}: claims`).toBeGreaterThanOrEqual(MIN_CLAIMS[id]);
      expect(failingClaims(id, BLOG_GOLDENS[id]!).map((c) => c.says), `${id}: failing claims`).toEqual([]);
      claims += e!.claims.length;
    }
    expect(claims, "anti-vacuity: claims checked").toBeGreaterThan(BATCH1.length * 4);
  });

  it("the shoot-out example claims every sport (the sweep), and the single-sport examples name their one sport and the reason", () => {
    const shoot = blogExample("shootout-points")!;
    expect(shoot.sports).toBe("all");
    const bySport = new Map<string, number>();
    for (const c of shoot.claims) if (c.sport !== undefined) bySport.set(c.sport, (bySport.get(c.sport) ?? 0) + 1);
    const visited = forEachSport(({ key }) => expect(bySport.get(key) ?? 0, `${key}: claims`).toBeGreaterThanOrEqual(4));
    expect(visited, "sports visited").toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
    const one: Record<string, string> = { "cricket-points": "cricket", "chess-points": "boardgame", "matches-won-first": "volleyball", "table-tennis-loss": "tabletennis" };
    for (const [id, sport] of Object.entries(one)) {
      const e = blogExample(id)!;
      expect(e.sports, id).toEqual([sport]);
      expect(e.singleSportReason?.length ?? 0, `${id}: reason`).toBeGreaterThan(20);
      expect(builtinModules.some((m) => m.key === sport), `${id}: ${sport} is a registry sport`).toBe(true);
      expect(e.claims.some((c) => c.sport === undefined), `${id}: a registry-wide claim stands beside the single sport`).toBe(true);
    }
  });
});

describe("batch 1 examples: the claims have teeth", () => {
  for (const id of BATCH1) {
    const golden = BLOG_GOLDENS[id]!;
    const cell = (r: ExampleResult, i: number, c: number, to: string) => {
      r.table!.rows[i]![c] = to;
      return r;
    };

    it(`${id}: corrupting any cell of its table is caught`, () => {
      let corrupted = 0;
      for (const [i, row] of golden.table!.rows.entries())
        for (let c = 0; c < row.length; c++) {
          const mutant = cell(structuredClone(golden), i, c, `${String(row[c])}9`);
          expect(failingClaims(id, mutant).length, `${id}: row ${i} column ${c}`).toBeGreaterThan(0);
          corrupted++;
        }
      expect(corrupted, `${id}: cells corrupted`).toBeGreaterThanOrEqual(golden.table!.rows.length * golden.table!.columns.length);
      expect(corrupted).toBeGreaterThan(0);
    });

    it(`${id}: dropping or swapping a row is caught`, () => {
      let dropped = 0;
      for (let i = 0; i < golden.table!.rows.length; i++) {
        const mutant = structuredClone(golden);
        mutant.table!.rows.splice(i, 1);
        expect(failingClaims(id, mutant).length, `${id}: row ${i} dropped`).toBeGreaterThan(0);
        dropped++;
      }
      const swapped = structuredClone(golden);
      [swapped.table!.rows[0], swapped.table!.rows[1]] = [swapped.table!.rows[1]!, swapped.table!.rows[0]!];
      expect(failingClaims(id, swapped).length, `${id}: first two rows swapped`).toBeGreaterThan(0);
      expect(dropped).toBeGreaterThan(1);
    });

    it(`${id}: removing or changing any fact a post can cite is caught`, () => {
      let mutated = 0;
      for (const k of Object.keys(golden.facts)) {
        const removed = structuredClone(golden);
        delete removed.facts[k];
        expect(failingClaims(id, removed).length, `${id}: fact ${k} removed`).toBeGreaterThan(0);
        const changed = structuredClone(golden);
        const v = changed.facts[k]!;
        changed.facts[k] = typeof v === "number" ? v + 1 : `${v}9`;
        expect(failingClaims(id, changed).length, `${id}: fact ${k} changed`).toBeGreaterThan(0);
        mutated++;
      }
      expect(mutated, `${id}: facts mutated`).toBe(Object.keys(golden.facts).length);
      expect(mutated).toBeGreaterThan(3);
    });

    it(`${id}: an empty result is a failure, never a crash and never a pass`, () => {
      const empty: ExampleResult = { facts: {}, text: [] };
      const claims = blogExample(id)!.claims;
      const failing = failingClaims(id, empty).length;
      // The only claims an empty result may satisfy are a sport's own, where the truth for that sport IS an empty set: the
      // shoot-out example's per-sport claims for a sport that cannot settle a league match beyond regulation (no rows, no
      // facts). Derived from the golden's count, which the registry-wide claim holds to the registry (the check above).
      const vacuousByDesign = id === "shootout-points" ? (Number(golden.facts.sportCount) - Number(golden.facts.sportsBeyond)) * 4 : 0;
      expect(vacuousByDesign, `${id}: vacuous-by-design claims`).toBe(id === "shootout-points" ? 28 : 0);
      expect(failing, `${id}: claims failing on an empty result (of ${claims.length})`).toBe(claims.length - vacuousByDesign);
      expect(failing).toBeGreaterThan(0);
    });
  }
});

describe("batch 1 examples: each one separates the right answer from the wrong constant (class 19)", () => {
  // The claims prove the golden equals the declarations; this proves the golden could not be mistaken for a simpler wrong
  // rule. A post whose example pays the same number in every row cannot witness a regression to a flat constant.
  const facts = (id: string) => BLOG_GOLDENS[id]!.facts;

  it("shoot-out: an extra-time win and a shoot-out win in football pay differently, and the shoot-out loser is not left at nothing", () => {
    const f = facts("shootout-points");
    expect(f.footballOtWin, "extra time vs shoot-out winner").not.toBe(f.footballSoWin);
    expect(f.footballOtLoss, "extra time vs shoot-out loser").not.toBe(f.footballSoLoss);
    expect(f.icehockeyOtLoss, "an ice hockey overtime loss earns something").not.toBe("0");
    expect(f.icehockeyRecreationalOtLoss, "...and the recreational variant's does not").toBe("0");
  });

  it("cricket: a win, a tie and a loss pay three different amounts", () => {
    const f = facts("cricket-points");
    expect(new Set([f.winWinner, f.tieEach, f.winLoser]).size, "win, tie, loss").toBe(3);
    expect(f.superOverWinner, "a super over turns a tie (shared) into a win").not.toBe(f.tieEach);
  });

  it("chess: the two counts crown different leaders, and the first leader is the one with the draws", () => {
    const f = facts("chess-points");
    expect(f.halfLeader).not.toBe(f.threeLeader);
    expect(f.halfLeader).toBe("Ben");
    expect(f.anaHalf).not.toBe(f.benHalf);
    expect(f.anaThree).not.toBe(f.benThree);
  });

  it("volleyball: the team with more points sits below the team with more wins, and the two place columns differ", () => {
    const f = facts("matches-won-first");
    expect(Number(f.redsPoints), "Reds have more points").toBeGreaterThan(Number(f.bluesPoints));
    expect(Number(f.redsWon), "Blues have more wins").toBeLessThan(Number(f.bluesWon));
    expect(Number(f.bluesPlaceWins), "so Blues rank above Reds with wins first").toBeLessThan(Number(f.redsPlaceWins));
    expect(f.winsFirstOrder).not.toBe(f.pointsFirstOrder);
  });

  it("table tennis: a forfeit before play pays the loser less than a played loss", () => {
    const f = facts("table-tennis-loss");
    expect(Number(f.forfeitLoser)).toBeLessThan(Number(f.won30Loser));
    expect(f.won30Loser, "a played loss pays the same at every score").toBe(f.won32Loser);
    expect(f.won30Loser).toBe(f.won31Loser);
  });
});

describe("batch 1 examples: the sport lists a post prints", () => {
  // The generic sport is "a generic division" in prose and in every list; a bare "generic" among sport names reads as a typo.
  // Read from the goldens a post renders from, so it is what a reader gets, not what the formatter was meant to do.
  const BARE_GENERIC = /(^|, | and )generic(,| and |$)/i;
  const lists: [string, string, string][] = [];
  for (const id of BATCH1) for (const [key, v] of Object.entries(BLOG_GOLDENS[id]!.facts)) if (key.endsWith("List") && typeof v === "string") lists.push([id, key, v]);

  it("no list names the generic sport bare, and the lists that hold it say 'a generic division'", () => {
    expect(lists.length, "anti-vacuity: sport and format lists checked").toBeGreaterThan(0);
    for (const [id, key, v] of lists) expect(BARE_GENERIC.test(v), `${id}.${key}: '${v}'`).toBe(false);
    const holders = lists.filter(([, , v]) => /a generic division/i.test(v));
    // The four posts' other-sports lists (cricket, chess, table tennis, volleyball) are the ones that hold every sport but a few.
    expect(holders.length, "anti-vacuity: lists that hold the generic sport").toBeGreaterThanOrEqual(4);
  });
});
