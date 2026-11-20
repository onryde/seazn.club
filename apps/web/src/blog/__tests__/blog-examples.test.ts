// The example harness (design: "Generated examples", "What is tested"). Four sweeps, each reporting what it
// checked (zero checked is a failure, TEST-STRATEGY): every registered example regenerates to its committed
// golden; every claim holds against the sport module's own declarations; every tie-break key an organiser can
// meet has a label; and the claims have teeth (a tampered result is caught).
//
// Never `vitest -u`: it runs the whole suite. `UPDATE_BLOG_EXAMPLES=1` rewrites the goldens instead, and the
// golden's diff is what a reviewer reads.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { BLOG_EXAMPLES, blogExample } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import { resultLabel, sportLabel, tiebreakLabel } from "@/blog/labels";
import { findBlogLeaks } from "@/blog/leaks";

const GOLDEN_DIR = join(process.cwd(), "src", "blog", "examples", "__golden__");
const UPDATE = process.env.UPDATE_BLOG_EXAMPLES === "1";
const goldenPath = (id: string) => join(GOLDEN_DIR, `${id}.json`);
const stable = (r: ExampleResult) => `${JSON.stringify(r, null, 2)}\n`;

describe("registry", () => {
  it("is not empty, and its ids are unique, kebab-case and the pilot's is in it", () => {
    expect(BLOG_EXAMPLES.length, "anti-vacuity: registered examples").toBeGreaterThan(0);
    const ids = BLOG_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size, "unique ids").toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(ids).toContain("standings-points");
    expect(blogExample("standings-points")?.id).toBe("standings-points");
    expect(blogExample("no-such-example")).toBeNull();
  });

  it("every example carries claims, and a single-sport example states why (an 'all' example needs no reason)", () => {
    let checked = 0;
    for (const e of BLOG_EXAMPLES) {
      expect(e.claims.length, `${e.id}: claims`).toBeGreaterThan(0);
      if (e.sports === "all") {
        expect(e.singleSportReason, `${e.id}: 'all' carries no single-sport reason`).toBeUndefined();
      } else {
        expect(e.sports.length, `${e.id}: sports`).toBeGreaterThan(0);
        if (e.sports.length === 1) expect(e.singleSportReason?.length ?? 0, `${e.id}: single-sport reason`).toBeGreaterThan(10);
        const keys = new Set(builtinModules.map((m) => m.key));
        for (const s of e.sports) expect(keys.has(s), `${e.id}: ${s} is a sport`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBe(BLOG_EXAMPLES.length);
  });

  it("the golden folder and the registry name the same examples (no orphan file, no missing golden), and goldens.ts loads each", () => {
    const files = existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort() : [];
    const ids = BLOG_EXAMPLES.map((e) => e.id).sort();
    expect(files.length, "anti-vacuity: golden files").toBeGreaterThan(0);
    expect(files).toEqual(ids);
    expect(Object.keys(BLOG_GOLDENS).sort()).toEqual(ids);
    for (const id of ids) expect(BLOG_GOLDENS[id], id).toEqual(JSON.parse(readFileSync(goldenPath(id), "utf8")));
  });
});

describe("regenerate: build() deep-equals the committed golden", () => {
  it("every registered example", () => {
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      for (const e of BLOG_EXAMPLES) writeFileSync(goldenPath(e.id), stable(e.build()));
    }
    let checked = 0;
    for (const e of BLOG_EXAMPLES) {
      const golden = JSON.parse(readFileSync(goldenPath(e.id), "utf8")) as ExampleResult;
      // JSON round trip: the golden is plain data, so compare what a page would read.
      expect(JSON.parse(JSON.stringify(e.build())), `${e.id} no longer matches its golden (UPDATE_BLOG_EXAMPLES=1 moves it)`).toEqual(golden);
      expect(readFileSync(goldenPath(e.id), "utf8"), `${e.id}: golden is written in the canonical form`).toBe(stable(golden));
      checked++;
    }
    expect(checked, "examples regenerated").toBe(BLOG_EXAMPLES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("build() is deterministic: two runs of every example are equal", () => {
    for (const e of BLOG_EXAMPLES) expect(e.build(), e.id).toEqual(e.build());
  });
});

describe("claims: each one checks the result against a declaration, never against the result itself", () => {
  it("every claim of every example passes", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const e of BLOG_EXAMPLES) {
      const golden = BLOG_GOLDENS[e.id]!;
      for (const c of e.claims) {
        const verdict = c.check(golden);
        checked++;
        if (verdict !== true) failures.push(`${e.id}: ${c.says} (${c.source}) -> ${verdict === false ? "false" : verdict}`);
      }
    }
    expect(checked, "claims checked").toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it("every claim names its source, and a claim says what it asserts", () => {
    let checked = 0;
    for (const e of BLOG_EXAMPLES)
      for (const c of e.claims) {
        expect(c.says.length, `${e.id}: says`).toBeGreaterThan(10);
        expect(c.source.length, `${e.id}: source of '${c.says}'`).toBeGreaterThan(5);
        checked++;
      }
    expect(checked).toBeGreaterThan(0);
  });

  it("the pilot sweeps the whole registry: claims for every sport, per forEachSport, and the count is the registry's size", () => {
    const pilot = blogExample("standings-points")!;
    expect(pilot.sports).toBe("all");
    const bySport = new Map<string, number>();
    for (const c of pilot.claims) if (c.sport !== undefined) bySport.set(c.sport, (bySport.get(c.sport) ?? 0) + 1);
    const visited = forEachSport(({ key }) => {
      expect(bySport.get(key) ?? 0, `${key}: claims`).toBeGreaterThanOrEqual(4);
    });
    expect(visited, "sports visited").toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
    expect(bySport.size, "sports with claims").toBe(visited);
    // A claim with no sport is example-wide (it reads the registry itself); the pilot has some, and the rest are per sport.
    const wide = pilot.claims.filter((c) => c.sport === undefined);
    expect(wide.length, "example-wide claims").toBeGreaterThan(0);
    expect(wide.length + [...bySport.values()].reduce((a, b) => a + b, 0)).toBe(pilot.claims.length);
  });

  it("volleyball: the 3-2 win pays the declared 2-1, which differs from the 3-0 a wrong constant would give (class 19)", () => {
    const facts = BLOG_GOLDENS["standings-points"]!.facts;
    const volleyball = builtinModules.find((m) => m.key === "volleyball")!;
    const cfg = declaredCfgs(volleyball)[0]!.cfg;
    const map = volleyball.tablePointsRule(cfg, "league").bySetScore!;
    // The declaration itself: the two scores pay different pairs (else this test could not tell them apart).
    expect(map["3-2"]).not.toEqual(map["3-0"]);
    expect(String(facts.volleyballWin32)).toBe(String(map["3-2"]![0]));
    expect(String(facts.volleyballLoss32)).toBe(String(map["3-2"]![1]));
    expect(String(facts.volleyballWin30)).toBe(String(map["3-0"]![0]));
    expect(facts.volleyballWin32).not.toBe(facts.volleyballWin30);
  });

  it("the claims have teeth: corrupting any one sport's win, loss, level or first-key cell is caught by that sport's claims", () => {
    const pilot = blogExample("standings-points")!;
    const golden = BLOG_GOLDENS["standings-points"]!;
    let corrupted = 0;
    for (const m of builtinModules) {
      const label = sportLabel(m.key);
      for (const col of [1, 2, 3, 4]) {
        const mutant = structuredClone(golden);
        const row = mutant.table!.rows.find((r) => r[0] === label)!;
        row[col] = `${String(row[col])}9`;
        const failing = pilot.claims.filter((c) => c.sport === m.key && c.check(mutant) !== true);
        expect(failing.length, `${m.key}: column ${col} corrupted`).toBeGreaterThan(0);
        // ...and no other sport's claims notice it (the example-wide claims may: they read every row).
        expect(pilot.claims.filter((c) => c.sport !== undefined && c.sport !== m.key && c.check(mutant) !== true).length, `${m.key}: a neighbour's claim fired`).toBe(0);
        corrupted++;
      }
      const factless = structuredClone(golden);
      // Set sports keep their win under a score ("volleyballWin30"), the others under the sport's own name.
      for (const k of [`${m.key}Win`, `${m.key}Win30`, `${m.key}Win20`]) delete factless.facts[k];
      expect(pilot.claims.filter((c) => c.sport === m.key && c.check(factless) !== true).length, `${m.key}: a missing win fact`).toBeGreaterThan(0);
      corrupted++;
    }
    expect(corrupted).toBe(builtinModules.length * 5);
  });
});

describe("the example-wide claims have teeth too", () => {
  const pilot = blogExample("standings-points")!;
  const golden = BLOG_GOLDENS["standings-points"]!;
  const wide = pilot.claims.filter((c) => c.sport === undefined);
  const failing = (r: ExampleResult) => wide.filter((c) => c.check(r) !== true).map((c) => c.says);

  it("pass on the golden, and a table that drops a sport, reorders two, or lies about the count fails the row claim", () => {
    expect(wide.length, "anti-vacuity: example-wide claims").toBe(2);
    expect(failing(golden)).toEqual([]);
    const dropped = structuredClone(golden);
    dropped.table!.rows.pop();
    expect(failing(dropped).length, "a sport dropped").toBeGreaterThan(0);
    const swapped = structuredClone(golden);
    [swapped.table!.rows[0], swapped.table!.rows[1]] = [swapped.table!.rows[1]!, swapped.table!.rows[0]!];
    expect(failing(swapped).length, "two rows swapped").toBeGreaterThan(0);
    const miscounted = structuredClone(golden);
    miscounted.facts.sportCount = Number(miscounted.facts.sportCount) + 1;
    expect(failing(miscounted).length, "a wrong sportCount").toBeGreaterThan(0);
  });

  it("a table whose every sport ranks by the same key, or names a key no sport declares, fails the ranking claim", () => {
    const flat = structuredClone(golden);
    for (const r of flat.table!.rows) r[4] = "Points";
    expect(failing(flat).length, "every sport ranks by points").toBeGreaterThan(0);
    const alien = structuredClone(golden);
    alien.table!.rows[0]![4] = "Goal difference";
    expect(failing(alien).length, "a key no sport declares first").toBeGreaterThan(0);
  });
});

describe("the pilot's result reads like copy: no key, no identifier, no developer word", () => {
  it("table cells, caption, text and fact values pass the leak scan", () => {
    const g = BLOG_GOLDENS["standings-points"]!;
    const strings = [g.table!.caption, ...g.table!.columns, ...g.table!.rows.flat().map(String), ...g.text, ...Object.values(g.facts).map(String)];
    expect(strings.length, "anti-vacuity: strings scanned").toBeGreaterThan(50);
    const leaks = strings.flatMap((s) => findBlogLeaks(s).map((l) => `${l.rule}: ${l.match} in '${s}'`));
    expect(leaks).toEqual([]);
  });
});

describe("labels", () => {
  it("every tie-break key any sport's league or Swiss default order can hold has a label (every declared config)", () => {
    let keys = 0;
    const missing: string[] = [];
    forEachSport(({ module }) => {
      for (const { cfg } of declaredCfgs(module))
        for (const kind of ["league", "swiss"] as const)
          for (const key of module.defaultTiebreakers(kind, cfg)) {
            keys++;
            try {
              expect(tiebreakLabel(key).length).toBeGreaterThan(0);
            } catch {
              missing.push(`${module.key}/${kind}: ${key}`);
            }
          }
    });
    expect(keys, "anti-vacuity: keys checked").toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it("a missing label throws, naming the key; a present one is the organiser screen's word", () => {
    expect(() => tiebreakLabel("no_such_rule")).toThrow(/no_such_rule/);
    expect(() => resultLabel("no_such_result")).toThrow(/no_such_result/);
    expect(() => sportLabel("curling")).toThrow(/curling/);
    expect(tiebreakLabel("points")).toBe("points");
    expect(tiebreakLabel("wins")).toBe("wins");
    expect(tiebreakLabel("buchholz_cut1")).toBe("Buchholz Cut-1");
    expect(resultLabel("drawn")).toBe("Drawn");
    expect(sportLabel("boardgame")).toBe("Chess");
  });

  it("no label is a code identifier", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const { cfg } of declaredCfgs(module))
        for (const key of module.defaultTiebreakers("league", cfg)) {
          expect(findBlogLeaks(tiebreakLabel(key)), `${key}: ${tiebreakLabel(key)}`).toEqual([]);
          checked++;
        }
    });
    expect(checked).toBeGreaterThan(0);
  });
});
