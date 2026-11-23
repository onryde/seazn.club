// Batch 5 (Task 11): the claims of #22 to #27 have teeth. Every claim passes on its committed golden (blog-examples.test.ts
// holds that); here each one must FAIL on an empty result, and the load-bearing ones fail on a golden corrupted in the
// one way the claim exists to catch. Anti-vacuity: the counts of claims checked are asserted.
import { describe, expect, it } from "vitest";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";

// #22 americano-rotation and #23 mexicano-next-round are HELD (blog-held-posts.test.ts); their claims were swept before the hold.
const B5 = ["ladder-challenge", "knockout-withdrawal", "forfeit-scores", "double-walkover"] as const;
const EMPTY: ExampleResult = { facts: {}, text: [] };
const clone = (id: string): ExampleResult => JSON.parse(JSON.stringify(BLOG_GOLDENS[id]!)) as ExampleResult;
const claimsOf = (id: string) => BLOG_EXAMPLES.find((e) => e.id === id)!.claims;
const failing = (id: string, r: ExampleResult) => claimsOf(id).filter((c) => c.check(r) !== true).map((c) => c.says);

const CLAIM_COUNT = B5.reduce((n, id) => n + claimsOf(id).length, 0);

describe("batch 5 claims have teeth", () => {
  it(`every one of the ${CLAIM_COUNT} claims of batch 5 passes on its golden and fails on an empty result`, () => {
    let checked = 0;
    for (const id of B5) {
      expect(claimsOf(id).length, `${id}: claims`).toBeGreaterThan(0);
      for (const c of claimsOf(id)) {
        expect(c.check(BLOG_GOLDENS[id]!), `${id}: ${c.says}`).toBe(true);
        expect(c.check(EMPTY), `${id}: '${c.says}' passes on an empty result`).not.toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: batch 5 claims checked").toBe(CLAIM_COUNT);
    expect(checked, "anti-vacuity: batch 5 claims checked").toBeGreaterThanOrEqual(B5.length * 2);
  });

  it("ladder: a ladder that did not swap on a win, or a refusal inside the reach, is caught", () => {
    const noSwap = clone("ladder-challenge");
    noSwap.table!.rows[0]![3] = noSwap.table!.rows[1]![3] = "Ana, Ben, Cy, Dev, Eli, Fay";
    expect(failing("ladder-challenge", noSwap).length).toBeGreaterThan(0);
    const reach = clone("ladder-challenge");
    reach.facts.reach = 4; // a reach of 4 would have allowed the refused 4-place challenge
    expect(failing("ladder-challenge", reach).length).toBeGreaterThan(0);
  });

  it("forfeits: a football walkover shown as hockey's 5-0 is caught", () => {
    const r = clone("forfeit-scores");
    const row = r.table!.rows.find((x) => String(x[0]).startsWith("Football"))!;
    row[1] = "5 — 0";
    r.facts.footballScore = "5 — 0";
    expect(failing("forfeit-scores", r).length).toBeGreaterThan(0);
  });

  it("forfeits: a caption that calls the 'any other game' tile 'no score', and a nested-bracket row label, are caught (cleanup N1, N3)", () => {
    const caption = clone("forfeit-scores");
    expect(caption.diagram!.title, "premise: the caption quotes the any-other-game tile").toContain("any other game shows");
    caption.diagram!.title = caption.diagram!.title.replace(/ and any other game shows .*\.$/, " and cricket and any other game show no score.");
    expect(failing("forfeit-scores", caption), "the old caption wording").toContain("the picture's caption says what the tiles show: how many sports show a score, and exactly what each of the others shows");
    const nested = clone("forfeit-scores");
    const carrom = nested.table!.rows.find((x) => String(x[0]).startsWith("Carrom"))!;
    expect(carrom[0], "premise: the carrom label is a flat list").toBe("Carrom, Club, 29 points");
    carrom[0] = "Carrom (Club (29 points))";
    expect(failing("forfeit-scores", nested)).toContain("no sport cell nests brackets: the variant is a plain list after the sport's name");
  });

  it("double walkover: a point paid to either side is caught", () => {
    const r = clone("double-walkover");
    r.table!.rows.find((x) => String(x[0]).startsWith("Table tennis"))![2] = 1;
    r.facts.tabletennisPoints = 1;
    expect(failing("double-walkover", r).length).toBeGreaterThan(0);
  });

  it("knockout withdrawal: a played quarter-final that changed, or a walkover to the wrong player, is caught (the sweep below holds the rest)", () => {
    const played = clone("knockout-withdrawal");
    played.table!.rows[1]![2] = "Walkover: Eli goes through";
    expect(failing("knockout-withdrawal", played).length).toBeGreaterThan(0);
    const wrong = clone("knockout-withdrawal");
    wrong.facts.opponent = "Cy";
    expect(failing("knockout-withdrawal", wrong).length).toBeGreaterThan(0);
  });
});

// ---- fix round 1 (I5): the pilot's per-cell and per-fact corruption sweep, over every batch 5 example ----
//
// For each example: every table cell, every fact, every diagram value is corrupted in turn (a string gets a "9" appended, a
// number gets 1 added), and every fact and row is also removed; at least one claim of that example must fail on each. A row
// swapped with its neighbour must fail too. A claim that throws on a corrupted result breaks the contract (a missing or
// wrong value is a failure, never a crash), so a throw is its own finding. What the sweep cannot hold is only prose: the
// table's caption and column headings, and the diagram's title (the caption read aloud), which have no rule behind them.
// Anti-vacuity: each example reports how many mutants it swept, and zero is a failure.
type Mutant = { label: string; apply: (r: ExampleResult) => void };

const bump = (v: unknown): string | number => (typeof v === "number" ? v + 1 : `${String(v)}9`);

function mutantsOf(g: ExampleResult): Mutant[] {
  const out: Mutant[] = [];
  for (const k of Object.keys(g.facts)) {
    out.push({ label: `fact ${k} changed`, apply: (r) => void (r.facts[k] = bump(r.facts[k]) as never) });
    out.push({ label: `fact ${k} removed`, apply: (r) => void delete r.facts[k] });
  }
  const rows = g.table?.rows ?? [];
  rows.forEach((row, i) => {
    row.forEach((_, j) => out.push({ label: `cell [${i}][${j}] changed`, apply: (r) => void (r.table!.rows[i]![j] = bump(r.table!.rows[i]![j]) as never) }));
    out.push({ label: `row ${i} removed`, apply: (r) => void r.table!.rows.splice(i, 1) });
    if (i + 1 < rows.length && JSON.stringify(row) !== JSON.stringify(rows[i + 1]))
      out.push({ label: `rows ${i}/${i + 1} swapped`, apply: (r) => void ([r.table!.rows[i], r.table!.rows[i + 1]] = [r.table!.rows[i + 1]!, r.table!.rows[i]!]) });
  });
  const d = g.diagram as unknown as Record<string, unknown> | undefined;
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (v !== null && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
    if (path[0] === "title" || path[0] === "kind") return;
    out.push({
      label: `diagram ${path.join(".")} changed`,
      apply: (r) => {
        let at: any = r.diagram; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const p of path.slice(0, -1)) at = at[p];
        at[path[path.length - 1]!] = typeof v === "boolean" ? !v : bump(v);
      },
    });
  };
  if (d !== undefined) walk(d, []);
  return out;
}

/** Mutants the example's claims cannot see and no rule could: each carries WHY, and must still be uncaught (a stale entry fails). */
const UNCHECKED: Readonly<Record<string, readonly { label: string; why: string }[]>> = {};

describe("batch 5: the corruption sweep (every cell, fact and diagram value of every example)", () => {
  for (const id of B5) {
    // The title carries the count the sweep will run (read from the golden at collection), so a JSON or CI report shows how many
    // corrupted results each example was held against, not only that the floor below was cleared.
    const swept = mutantsOf(BLOG_GOLDENS[id]!).length;
    it(`${id}: all ${swept} corrupted cells, facts and diagram values are held by a claim`, () => {
      const golden = BLOG_GOLDENS[id]!;
      const mutants = mutantsOf(golden);
      expect(mutants.length, `${id}: the count in the title is the count swept`).toBe(swept);
      expect(mutants.length, `anti-vacuity: ${id} mutants`).toBeGreaterThan(Object.keys(golden.facts).length);
      const exempt = new Map((UNCHECKED[id] ?? []).map((u) => [u.label, u.why]));
      const survived: string[] = [];
      const threw: string[] = [];
      const staleExemptions: string[] = [];
      let caughtCount = 0;
      for (const m of mutants) {
        const r = structuredClone(golden);
        m.apply(r);
        let caught = false;
        for (const c of claimsOf(id)) {
          try {
            if (c.check(r) !== true) caught = true;
          } catch (e) {
            threw.push(`${m.label}: '${c.says}' threw ${(e as Error).message}`);
            caught = true;
          }
        }
        if (exempt.has(m.label)) {
          if (caught) staleExemptions.push(m.label);
        } else if (!caught) survived.push(m.label);
        else caughtCount++;
      }
      // `expect.fail` with the whole list: vitest elides a long array's (or string's) tail in a diff, and the list is the finding.
      if (threw.length > 0) expect.fail(`a claim must fail a corrupted result, never throw: ${threw.join(" | ")}`);
      if (survived.length > 0) expect.fail(`${id}: ${survived.length} corrupted values no claim notices: ${survived.join(" | ")}`);
      if (staleExemptions.length > 0) expect.fail(`${id}: exemptions that a claim now catches: ${staleExemptions.join(" | ")}`);
      // Every mutant was either caught by a claim or is a named exemption that a claim must still miss: nothing was skipped.
      expect(caughtCount + exempt.size, `${id}: ${mutants.length} swept`).toBe(mutants.length);
    });
  }
});
