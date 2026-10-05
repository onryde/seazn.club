// W1d Task 22 (ruling 62, D19): lib/backlog.ts writes the per-wave backlog section of _INDEX.md from the triage, the ledger and the
// catalogue. The tables are DATA: this file holds the writer to what the inputs say and to what each wave's design row says, and
// w1d-backlog-index.test.ts holds the committed section to what the writer produces.
//
// Where an expected value comes from (never from the writer under test):
//   - a wave's name and scope words: design section 8's own table, typed here from it;
//   - an example case, a count, a layer: the triage's own groups, re-counted here from the rows;
//   - a carry's facts (ruling 70's cells, the flips, the mexicano counts): the committed dispatch cut, re-counted here;
//   - a refusal: the guard's own NAME, never only an exit code (a catch-all would hide a deleted guard).
// Every sweep reports how many items it checked, and zero is a failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BacklogRefused, DEFAULT_BASELINE, DEFAULT_DESIGN, backingOf, cell, designWaves, exampleCases, examplesOf, loadBacklogInput, parseCarries, parseCuts, renderBacklog,
  type BacklogInput, type DesignWave,
} from "../lib/backlog.ts";
import { findSecrets } from "../lib/redact.ts";
import { LAYERS } from "../lib/results.ts";
import { CATALOGUE_DIR } from "../lib/triage.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const BASE = resolve(REPO, TRUTH_RUNS, "w1d-baseline");
/** The baseline's commit as the heading names it: a prefix of the tag's commit (README, T17). */
const SHA = "47f210e3f";
const TAG_SHA = "47f210e3f2094405e4ed4c8b5c9ea6bd2a6085d9";

const scratch = mkdtempSync(join(tmpdir(), "w1d-t22-bl-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
/** A package script as package.json spells it, run for real (node + its preload), cwd the repo. */
function runScript(script: string, tail: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const words = (scripts[script] ?? "").split(" ");
  expect(words[0], `${script} runs node`).toBe("node");
  const r = spawnSync(process.execPath, [...words.slice(1), ...tail], { cwd: REPO, encoding: "utf8", timeout: 2 * SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** The triage CLI over the committed baseline, once: the triage.json every real-input test reads. */
let triaged: string | null = null;
function triageJsonPath(): string {
  if (triaged !== null) return triaged;
  const out = join(scratch, "triage");
  mkdirSync(out, { recursive: true });
  const r = runScript("matrix:triage", [
    "--runs", ...LAYERS.map((l) => resolve(BASE, l, "results.json")),
    "--rekey", resolve(REPO, TRUTH_RUNS, "w1drv-l3", "results.json"), "--rekey-map", resolve(CATALOGUE_DIR, "p-map.json"), "--out", out,
  ]);
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
  triaged = join(out, "triage.json");
  return triaged;
}

let real: BacklogInput;
let md: string;
beforeAll(() => {
  real = loadBacklogInput({ triage: triageJsonPath(), sha: SHA });
  md = renderBacklog(real);
}, spawnBudget(2));
/** A deep copy the test may break: the real input stays whole for the next test. */
const copy = (): BacklogInput => structuredClone(real);
const refusal = (input: BacklogInput): string => {
  try {
    renderBacklog(input);
  } catch (e) {
    if (e instanceof BacklogRefused) return e.name;
    throw e;
  }
  return "no refusal";
};

// --- a markdown reader, restated here (the writer's own helpers are not trusted to read their own output) -------------------

/** The cells of a table row: split on a pipe that is not escaped, each unescaped. */
const cellsOf = (line: string): string[] => line.replace(/^\| /, "").replace(/ \|$/, "").split(/(?<!\\) \| /).map((c) => c.replaceAll("\\|", "|"));
/** The text of one wave's section: from its `### <wave> — ` heading to the next heading of that level. */
function waveSection(doc: string, wave: string): string {
  const at = doc.search(new RegExp(`^### ${wave} — `, "m"));
  expect(at, `${wave} has a section`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(at);
  const next = rest.slice(4).search(/^### /m);
  return next < 0 ? rest : rest.slice(0, next + 4);
}
/** The rows of the first table in `text` whose header starts with `| ${firstHeader} |`: each as its cells. Empty when there is none. */
function tableAfter(text: string, firstHeader: string): string[][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`| ${firstHeader} |`));
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("| ")) break;
    rows.push(cellsOf(l));
  }
  return rows;
}

// --- cells ------------------------------------------------------------------------------------------------------------------------

describe("cell: a table cell never holds a bare pipe (a case id and an audit title both can)", () => {
  it("escapes every pipe, and the reader's split gives the cell back", () => {
    const id = "league_ko|boardgame|blitz|LIFECYCLE@1280";
    expect(cell(id)).toBe("league_ko\\|boardgame\\|blitz\\|LIFECYCLE@1280");
    expect(cell("plain")).toBe("plain");
    expect(cell("")).toBe("");
    const row = `| ${cell("a|b")} | ${cell("c")} | ${cell("|")} |`;
    expect(cellsOf(row)).toEqual(["a|b", "c", "|"]);
  });
});

// --- examples ---------------------------------------------------------------------------------------------------------------------

describe("exampleCases: up to five, and the layers each get one before any layer gets two", () => {
  const rows = (spec: string): { caseId: string; layer: string }[] => spec.split(" ").map((s, i) => ({ caseId: `${s}-${i}`, layer: s }));
  it("L1 L1 L1 L1 L1 L1 L1 L2 L3 L3 -> the first of L1, L2, L3, then the next two in plan order", () => {
    expect(exampleCases(rows("L1 L1 L1 L1 L1 L1 L1 L2 L3 L3"))).toEqual(["L1-0", "L2-7", "L3-8", "L1-1", "L1-2"]);
  });
  it("fewer than five: all of them, once each, in plan order within a layer", () => {
    expect(exampleCases(rows("L3 L1 L3"))).toEqual(["L1-1", "L3-0", "L3-2"]);
  });
  it("the empty case: no rows, no examples (and the count asked for caps it)", () => {
    expect(exampleCases([])).toEqual([]);
    expect(exampleCases(rows("L1 L1 L1 L1"), 2)).toEqual(["L1-0", "L1-1"]);
  });
});

describe("examplesOf: a gap's own cases, or (a gap with none of its own) the cases that also fail one of its checks", () => {
  const layerOf = new Map([["a", "L1"], ["b", "L2"], ["c", "L2"]]);
  it("own cases win, and an also-case is shown only when there is no own one", () => {
    expect(examplesOf({ caseIds: ["c", "a"], alsoCaseIds: ["b"] }, layerOf)).toEqual(["a", "c"]);
    expect(examplesOf({ caseIds: [], alsoCaseIds: ["c", "b"] }, layerOf)).toEqual(["c", "b"]);
    expect(examplesOf({ caseIds: [] }, layerOf)).toEqual([]);
  });
});

// --- the design's rows ----------------------------------------------------------------------------------------------------------

describe("designWaves: design section 8's rows, numbered waves only", () => {
  const design = readFileSync(DEFAULT_DESIGN, "utf8");
  it("W2 to W10 in order, nine of them; the four done waves (W1a to W1d) are no backlog's", () => {
    const w = designWaves(design);
    expect(w.map((x) => x.id)).toEqual(["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]);
    // The names, typed from section 8's own row headings.
    expect(w.map((x) => x.name)).toEqual(["sport scoring fidelity", "Swiss", "knockout family", "round-robin family", "double elimination", "americano, mexicano, ladder", "scorer sheets", "operational [O]", "sweep"]);
  });
  it("the empty case: a document with no such table has no waves", () => {
    expect(designWaves("# nothing here\n\n| a | b |\n")).toEqual([]);
  });
});

describe("backingOf: a gap's wave is a row of design section 8 (T19 review m3)", () => {
  const waves = designWaves(readFileSync(DEFAULT_DESIGN, "utf8"));
  // Typed from section 8: W4's scope reads "knockout, ko_plate, qualifying_main, third place, stepladder, page_playoff"; W5's reads
  // "league, triple_rr, group, league_ko, groups_ko, group_stepladder, group_playoffs"; W7's name reads "americano, mexicano, ladder".
  const named: [string, string, string][] = [
    ["knockout_third_place", "W4", "third place"],
    ["page_playoff_only", "W4", "page_playoff"],
    ["stepladder_only", "W4", "stepladder"],
    ["group_only", "W5", "group"],
    ["mexicano", "W7", "mexicano"],
    ["americano", "W7", "americano"],
  ];
  it.each(named)("%s is named by %s as '%s'", (row, wave, item) => {
    expect(backingOf(row, waves, wave)).toEqual({ row, kind: "named", item });
  });
  it("group_group_ko is in no row's scope: it reaches W5 by the family word 'group' (section 8's clause), not by name", () => {
    expect(backingOf("group_group_ko", waves, "W5")).toEqual({ row: "group_group_ko", kind: "family", item: "group" });
  });
  it("a row no wave names or owns by family is refused by name", () => {
    expect(() => backingOf("nonesuch", waves, "W4")).toThrow(expect.objectContaining({ name: "NewGapUnbacked" }));
  });
  it("a row another wave names, filed under a wave that does not, is refused by name (the other direction)", () => {
    expect(() => backingOf("americano", waves, "W5")).toThrow(expect.objectContaining({ name: "NewGapWaveDisagrees" }));
    expect(() => backingOf("stepladder_only", waves, "W5")).toThrow(expect.objectContaining({ name: "NewGapWaveDisagrees" }));
  });
  it("a named match outranks a longer family one, even across waves: the kind decides before the length", () => {
    // Row `a_b_c`: wave A names `c` (a suffix: named, one word); wave B lists `a b` (inside the row, not at its end: family, two words).
    const synthetic: DesignWave[] = [{ id: "WA", name: "alpha", scope: "c" }, { id: "WB", name: "beta", scope: "a b" }];
    expect(backingOf("a_b_c", synthetic, "WA")).toEqual({ row: "a_b_c", kind: "named", item: "c" });
    expect(() => backingOf("a_b_c", synthetic, "WB")).toThrow(expect.objectContaining({ name: "NewGapWaveDisagrees" }));
  });
  it("a family match yields to another wave's named one: group_stepladder is named by W5, so W4 cannot claim it by 'stepladder'", () => {
    expect(backingOf("group_stepladder", waves, "W5")).toEqual({ row: "group_stepladder", kind: "named", item: "group_stepladder" });
    expect(() => backingOf("group_stepladder", waves, "W4")).toThrow(expect.objectContaining({ name: "NewGapWaveDisagrees" }));
  });
});

// --- the committed catalogue file --------------------------------------------------------------------------------------------------

describe("backlog-carries.json: the prose the section holds, as data", () => {
  it("parses, names each carry once, and holds no wave id the code could have typed (a wave is its anchor gap's route)", () => {
    const text = readFileSync(resolve(CATALOGUE_DIR, "backlog-carries.json"), "utf8");
    const c = parseCarries(JSON.parse(text));
    expect(c.carries.length, "carries").toBeGreaterThan(0);
    expect(new Set(c.carries.map((x) => x.id)).size, "a carry id once").toBe(c.carries.length);
    for (const x of c.carries) expect(Object.keys(x).sort(), x.id).toEqual(["anchor", "id", "text", "title"]);
    expect(c.heading).toContain("{sha}");
  });
  it("refuses a carry with no anchor, and a file with no carry (the empty case: a section without its carries is a different document)", () => {
    const head = { heading: "h {sha}", intro: ["a {baseline}"] };
    expect(() => parseCarries({ ...head, carries: [{ id: "x", title: "t", anchor: "SC-O1", text: "t" }] }), "the valid shape parses").not.toThrow();
    expect(() => parseCarries({ ...head, carries: [] })).toThrow(/carries/);
    expect(() => parseCarries({ ...head, carries: [{ id: "x", title: "t", text: "t" }] })).toThrow(/anchor/);
    expect(() => parseCarries({ ...head, carries: [{ id: "x", title: "t", anchor: "not a gap", text: "t" }] })).toThrow(/anchor/);
    expect(() => parseCarries({ heading: "no baseline named", intro: ["a {baseline}"], carries: [{ id: "x", title: "t", anchor: "SC-O1", text: "t" }] })).toThrow(/sha/);
    expect(() => parseCarries({ heading: "h {sha}", intro: ["a"], carries: [{ id: "x", title: "t", anchor: "SC-O1", text: "t" }] })).toThrow(/baseline/);
    const dup = { id: "x", title: "t", anchor: "SC-O1", text: "t" };
    expect(() => parseCarries({ ...head, carries: [dup, dup] })).toThrow(/duplicate/);
  });
});

// --- the section, over the committed baseline ------------------------------------------------------------------------------------

describe("the section over the committed baseline: structure and counts, re-counted from the inputs", () => {
  it("opens with the heading naming the baseline, one `###` section per wave of section 8, in wave order, none twice", () => {
    expect(md.split("\n")[0]).toBe(`## W1d truth-run backlog (baseline \`${SHA}\`)`);
    const heads = [...md.matchAll(/^### (W\d+) — (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]);
    expect(heads.length, "waves written").toBe(9);
  });

  it("each gap table row is the triage's group: its id, its title, its case count (+ also), its layers, and up to five of its own cases", () => {
    let checked = 0;
    for (const wave of ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]) {
      const rows = tableAfter(waveSection(md, wave), "gap");
      const want = real.triage.gaps.filter((g) => g.wave === wave);
      expect(rows.map((r) => r[0]), `${wave}: the gaps, in the triage's order`).toEqual(want.map((g) => g.gap));
      for (const g of want) {
        const r = rows.find((x) => x[0] === g.gap)!;
        expect(r[1], `${g.gap}: title`).toBe(g.title);
        expect(r[2], `${g.gap}: cases`).toBe(g.alsoCaseIds === undefined ? String(g.caseIds.length) : `${g.caseIds.length} (+${g.alsoCaseIds.length} also)`);
        expect(r[3], `${g.gap}: layers`).toBe(g.layers.join(", "));
        const ex = r[4]!.split(", ").map((c) => c.replace(/^`|`$/g, ""));
        expect(ex.length, `${g.gap}: min(5, cases)`).toBe(Math.min(5, g.caseIds.length));
        expect(new Set(ex).size, `${g.gap}: examples are distinct`).toBe(ex.length);
        for (const e of ex) expect(g.caseIds, `${g.gap}: ${e} is one of its cases`).toContain(e);
        // When the gap spans layers, no layer is left out while another has two (up to the five the cell holds).
        const layerOf = new Map(real.triage.rows.map((x) => [x.caseId, x.layer]));
        const have = new Set(ex.map((e) => layerOf.get(e)));
        for (const l of new Set(g.caseIds.map((c) => layerOf.get(c)))) if (ex.length >= g.layers.length) expect(have.has(l), `${g.gap}: an example of ${l}`).toBe(true);
        checked++;
      }
    }
    expect(checked, "every gap of the triage was read").toBe(real.triage.gaps.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the cases add up: the gap tables hold every triaged red once (the triage's own count), and the summary table agrees wave by wave", () => {
    const rowsTotal = real.triage.rows.length;
    expect(rowsTotal, "the triage keyed something").toBeGreaterThan(0);
    expect(rowsTotal).toBe(real.triage.checked);
    const summary = tableAfter(md, "wave");
    expect(summary.map((r) => r[0])).toEqual(["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]);
    let sum = 0;
    for (const r of summary) {
      const own = real.triage.rows.filter((x) => x.wave === r[0]).length;
      expect(Number(r[3]), `${r[0]}: ❌ cases`).toBe(own);
      expect(Number(r[2]), `${r[0]}: ❌ gaps`).toBe(real.triage.gaps.filter((g) => g.wave === r[0]).length);
      sum += Number(r[3]);
    }
    expect(sum, "the summary's ❌ cases sum to the triaged reds").toBe(rowsTotal);
  });

  it("the audit ids add up: each wave's row counts the ledger's ids of that wave by outcome, and the five outcomes sum to the audit's ids", () => {
    const summary = tableAfter(md, "wave");
    const outcomes = ["reproduced", "exercised-not-reproduced", "not-exercised", "verified-by-read", "verified-by-failing-test"] as const;
    let ids = 0;
    for (const r of summary) {
      const mine = real.ledger.entries.filter((e) => e.wave === r[0]);
      expect(Number(r[4]), `${r[0]}: audit ids`).toBe(mine.length);
      outcomes.forEach((o, i) => {
        expect(Number(r[5 + i]), `${r[0]}: ${o}`).toBe(mine.filter((e) => e.outcome === o).length);
      });
      expect(outcomes.reduce((n, _o, i) => n + Number(r[5 + i]), 0), `${r[0]}: the outcomes cover the wave's ids`).toBe(mine.length);
      ids += mine.length;
    }
    expect(ids, "every audit id of the ledger is in some wave").toBe(real.ledger.entries.length);
    expect(ids).toBeGreaterThan(0);
  });

  it("the not-exercised tables hold exactly the ledger's not-exercised ids of each wave, once each, with the ledger's own severity and title", () => {
    let checked = 0;
    for (const wave of ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]) {
      const rows = tableAfter(waveSection(md, wave), "id");
      const want = real.ledger.entries.filter((e) => e.wave === wave && e.outcome === "not-exercised");
      expect(rows.map((r) => r[0]), `${wave}: ids`).toEqual(want.map((e) => e.id));
      for (const e of want) {
        const r = rows.find((x) => x[0] === e.id)!;
        expect([r[1], r[2]], `${e.id}: severity and title`).toEqual([e.severity, e.title]);
        checked++;
      }
    }
    expect(checked, "every not-exercised id was read").toBe(real.ledger.counts["not-exercised"]);
    expect(checked).toBeGreaterThan(0);
  });

  it("a wave with no ❌ case says so (the empty case first); the waves that have one do not; every wave states what the ledger holds for it", () => {
    let empties = 0;
    for (const wave of ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]) {
      const sec = waveSection(md, wave);
      const gaps = real.triage.gaps.filter((g) => g.wave === wave).length;
      expect(sec.includes(`No ❌ case of the baseline is keyed to ${wave}.`), `${wave}: the empty statement iff no gap`).toBe(gaps === 0);
      if (gaps === 0) empties++;
      expect(sec.includes("| gap |"), `${wave}: a gap table iff a gap`).toBe(gaps > 0);
      const ids = real.ledger.entries.filter((e) => e.wave === wave).length;
      expect(sec.includes(`No audit id routes to ${wave}.`), `${wave}: no id says so`).toBe(ids === 0);
    }
    expect(empties, "four waves have no red in this baseline").toBe(4);
  });

  it("a wave's tables never hold another wave's case or id", () => {
    let checked = 0;
    for (const g of real.triage.gaps) {
      for (const wave of ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]) {
        if (wave !== g.wave) { expect(waveSection(md, wave).includes(`| ${g.gap} |`), `${g.gap} is not in ${wave}'s section`).toBe(false); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the carries: each hangs on its anchor gap, in that gap's wave", () => {
  it("the six carries and the five design-row lines sit in the section of the wave their anchor routes to", () => {
    // Anchor and wave typed from section 8 and the routing the carry cites (SC-P4 is W2's, SW-H1 W3's, ST-G5 W5's, NEW-W1d-1 W7's).
    const expected: [string, string][] = [
      ["SC-P4 and the prompt's trap 2 contradict each other", "W2"],
      ["Owner ruling 70", "W3"],
      ["Recommendation (the controller's, not an owner ruling)", "W3"],
      ["The swiss_playoff R4 reason flip", "W3"],
      ["ST-G5 pool of one", "W5"],
      ["Mexicano R4: an intermittent 500", "W7"],
    ];
    let checked = 0;
    for (const [title, wave] of expected) {
      const hits = [...md.matchAll(new RegExp(`^- \\*\\*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm"))];
      expect(hits, `${title}: once`).toHaveLength(1);
      expect(waveSection(md, wave).includes(`- **${title}`), `${title} is under ${wave}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
    for (const gap of real.newGaps.gaps) {
      const line = `- **${gap.id} (${gap.wave}): a design row backs the wave.**`;
      expect([...md.matchAll(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))], `${gap.id}: once`).toHaveLength(1);
      expect(waveSection(md, gap.wave).includes(line), `${gap.id} is under ${gap.wave}`).toBe(true);
      checked++;
    }
    expect(checked, "six carries and five NEW gaps").toBe(11);
  });

  it("the design-row line says named or family, with the design's own word: group_group_ko is the one that is not named", () => {
    const line = (id: string): string => md.split("\n").find((l) => l.startsWith(`- **${id} (`))!;
    expect(line("NEW-W1d-3")).toContain("names `stepladder` for `stepladder_only`");
    expect(line("NEW-W1d-4")).toContain("names `third place` for `knockout_third_place`");
    expect(line("NEW-W1d-4")).toContain("names `page_playoff` for `page_playoff_only`");
    expect(line("NEW-W1d-5")).toContain("names `group` for `group_only`");
    expect(line("NEW-W1d-5")).toContain("does not name `group_group_ko`");
    expect(line("NEW-W1d-5")).toContain("lists `group`");
    expect(line("NEW-W1d-1")).toContain("names `mexicano` for `mexicano`");
    expect(line("NEW-W1d-2")).toContain("names `americano` for `americano`");
  });

  it("ruling 70's carry names its three cells, from the cut's state flips, and the retirement rule the W3 prompt states", () => {
    const sec = waveSection(md, "W3");
    for (const id of ["swiss_knockout|football|11-a-side|R4", "swiss_knockout|carrom|club-29|R4", "swiss_knockout|generic|score|R4"]) expect(sec, id).toContain(`\`${id}\``);
    expect(sec).toContain("re-baseline L3 in the same change");
    expect(sec).toContain("`ruling70`");
    expect(sec).toContain("RULING_70_IDS");
  });

  it("the swiss_playoff reason flip: both cells, the per-dispatch reasons from the cut, and where the committed run keys them", () => {
    const sec = waveSection(md, "W3");
    const flip = sec.split("\n").find((l) => l.startsWith("- **The swiss_playoff R4 reason flip"))!;
    for (const id of ["swiss_playoff|boardgame|blitz|R4", "swiss_playoff|generic|score|R4"]) expect(flip, id).toContain(`\`${id}\``);
    // README: dispatch 1 reads SW-H1, dispatches 2 and 3 the drawn-game stall; the committed run (dispatch 3) keys SC-O1 (boardgame) and SC-O2 (generic).
    expect(flip).toContain("dispatch 1 SW-H1, dispatch 2 stall, dispatch 3 stall");
    expect(flip).toContain("SC-O1");
    expect(flip).toContain("SC-O2");
  });

  it("the mexicano carry's counts are the cut's: 9 of the 11 R4 cells flip, and the 500s per dispatch are re-counted from the reasons", () => {
    const cuts = parseCuts(JSON.parse(readFileSync(resolve(BASE, "dispatch-cuts.json"), "utf8")));
    const l3 = (JSON.parse(readFileSync(resolve(BASE, "L3", "results.json"), "utf8")) as { cases: { caseId: string }[] }).cases;
    const R4 = /^mexicano\|[^|]+\|[^|]+\|R4$/;
    const total = l3.filter((c) => R4.test(c.caseId)).length;
    const inCut = cuts.ids.filter((id) => R4.test(id));
    expect(total, "mexicano R4 cells in the committed L3").toBe(11);
    expect(inCut.length).toBe(9);
    const per = cuts.dispatches.map((d) => d.cases.filter((c) => R4.test(c.caseId) && c.reason.includes("500 INTERNAL")).length);
    expect(per.reduce((a, b) => a + b, 0), "the 500 shows in some dispatch, or the carry would be vacuous").toBeGreaterThan(0);
    const line = waveSection(md, "W7").split("\n").find((l) => l.startsWith("- **Mexicano R4: an intermittent 500"))!;
    expect(line).toContain(`${inCut.length} of the ${total}`);
    expect(line).toContain(`${per[0]}, ${per[1]} and ${per[2]} of those ${inCut.length}`);
    expect(line).toContain("`dispatch-cuts.json`");
    // The two cells that keep one shape: cricket and generic.
    expect(line).toContain("cricket");
    expect(line).toContain("generic");
    // Every check id the prose names is one a flipped cell fails in some dispatch of the cut (typed prose, held to the data).
    const failing = new Set(cuts.dispatches.flatMap((d) => d.cases.filter((c) => R4.test(c.caseId)).flatMap((c) => c.checks.filter((k) => k.verdict === "fail").map((k) => k.id))));
    const named = [...line.matchAll(/`((?:I\d+|r4|life)[a-z0-9-]*)`/g)].map((m) => m[1]!);
    expect(named.length, "the line names check ids").toBeGreaterThan(0);
    for (const id of named) expect(failing.has(id), `${id} is failed by a flipped cell in some dispatch`).toBe(true);
  });

  it("the ST-G5 carry: 7 entrants in 4 pools, the 12 cases, and the 409 the rule's note names; a product decision owned by ST-G5's wave", () => {
    const line = waveSection(md, "W5").split("\n").find((l) => l.startsWith("- **ST-G5 pool of one"))!;
    expect(line).toContain("7 entrants");
    expect(line).toContain("4 pools");
    expect(line).toContain("STAGE_COMPLETED_SEEDING_FAILED");
    expect(line).toContain(`${real.triage.gaps.find((g) => g.gap === "ST-G5")!.caseIds.length} cases`);
    expect(line).toMatch(/product decision/);
  });

  it("the SC-P4 carry quotes the three sources and the ledger's own reading of SC-P4", () => {
    const line = waveSection(md, "W2").split("\n").find((l) => l.startsWith("- **SC-P4 and the prompt's trap 2"))!;
    const e = real.ledger.entries.find((x) => x.id === "SC-P4")!;
    expect(e.outcome, "the ledger reads SC-P4").not.toBeNull();
    expect(line).toContain(`the ledger reads SC-P4 \`${e.outcome}\``);
    expect(line).toContain(e.evidence!);
    expect(line).toContain("the declared 3/0 loses to the FIH 2/1 the rulebook adopts");
    expect(line).toContain("FIH 2/1 is Pro League only");
    expect(line).toMatch(/false premise 20/);
  });
});

describe("the writer refuses what would make the section lie (each guard, once, by its own name)", () => {
  it("a triage that keyed nothing is the vacuous case, refused (zero reds would read as a clean backlog)", () => {
    const i = copy();
    i.triage.rows = []; i.triage.gaps = []; i.triage.checked = 0;
    expect(refusal(i)).toBe("NoCases");
  });
  it("a gap whose cases are not the triage's rows is refused, in either direction", () => {
    const a = copy();
    a.triage.gaps[0]!.caseIds = a.triage.gaps[0]!.caseIds.slice(1);
    expect(refusal(a)).toBe("TriageInconsistent");
    const b = copy();
    b.triage.rows = b.triage.rows.slice(1);
    expect(refusal(b)).toBe("TriageInconsistent");
  });
  it("a gap in a wave section 8 has no backlog for is refused (a wave nobody writes would swallow its reds)", () => {
    const i = copy();
    i.triage.gaps[0]!.wave = "W99";
    expect(refusal(i)).toBe("UnknownWave");
    const j = copy();
    j.ledger.entries[0]!.wave = "W99";
    expect(refusal(j)).toBe("UnknownWave");
  });
  it("a triage with an untriaged red is refused: its gaps are not every red", () => {
    const i = copy();
    i.triage.untriaged.push("some|case|that|nothing|keyed");
    expect(refusal(i)).toBe("TriageInconsistent");
  });
  it("a ledger with a finding is refused (an id with no outcome would drop out of every table)", () => {
    const i = copy();
    i.ledger.findings.push({ kind: "no-outcome", id: "SC-O1" });
    expect(refusal(i)).toBe("LedgerHasFindings");
  });
  it("a design with no wave table is refused", () => {
    const i = copy();
    i.design = "# no waves here\n";
    expect(refusal(i)).toBe("DesignRowMissing");
  });
  it("a NEW gap filed under a wave whose row does not name its format is refused; so is one whose row nothing names", () => {
    const a = copy();
    for (const g of a.triage.gaps) if (g.gap === "NEW-W1d-2") g.wave = "W5";
    for (const g of a.newGaps.gaps) if (g.id === "NEW-W1d-2") g.wave = "W5";
    expect(refusal(a)).toBe("NewGapWaveDisagrees");
    const b = copy();
    const g = b.triage.gaps.find((x) => x.gap === "NEW-W1d-2")!;
    const was = g.caseIds[0]!;
    const now = was.replace(/^americano/, "nonesuch");
    g.caseIds = [now, ...g.caseIds.slice(1)];
    for (const r of b.triage.rows) if (r.caseId === was) r.caseId = now;
    expect(refusal(b)).toBe("NewGapUnbacked");
  });
  it("a NEW gap the catalogue holds and the triage keys no case to is refused (nothing shows its design row); one the two files file under different waves is refused", () => {
    const a = copy();
    const gone = a.triage.gaps.find((x) => x.gap === "NEW-W1d-3")!;
    a.triage.gaps = a.triage.gaps.filter((x) => x !== gone);
    a.triage.rows = a.triage.rows.filter((r) => !gone.caseIds.includes(r.caseId));
    a.triage.checked = a.triage.rows.length;
    // The cases it owned that other gaps list as co-failures go with it (the triage is whole without them).
    for (const g of a.triage.gaps) {
      if (g.alsoCaseIds === undefined) continue;
      const left = g.alsoCaseIds.filter((id) => !gone.caseIds.includes(id));
      if (left.length === 0) delete g.alsoCaseIds;
      else g.alsoCaseIds = left;
    }
    for (const r of a.triage.rows) if (r.also !== undefined) r.also = r.also.filter((x) => x.gap !== gone.gap);
    expect(refusal(a)).toBe("NewGapUnbacked");
    const b = copy();
    b.triage.gaps.find((x) => x.gap === "NEW-W1d-2")!.wave = "W5";
    expect(refusal(b)).toBe("NewGapWaveDisagrees");
  });
  it("a carry whose text names a placeholder no derivation fills, or whose derivation has no placeholder to land in, is refused", () => {
    const a = copy();
    a.carries.carries[0]!.text += " {nonesuch}";
    expect(refusal(a)).toBe("CarryPlaceholder");
    const b = copy();
    const ruling = b.carries.carries.find((c) => c.text.includes("{cells}"))!;
    ruling.text = ruling.text.replaceAll("{cells}", "the cells");
    expect(refusal(b)).toBe("CarryPlaceholder");
  });
  it("a carry no derivation knows, and a derivation with no carry in the file, are each refused (nothing is dropped silently)", () => {
    const a = copy();
    a.carries.carries.push({ id: "nonesuch", title: "t", anchor: "SC-O1", text: "t" });
    expect(refusal(a)).toBe("CarryUnknown");
    const b = copy();
    b.carries.carries = b.carries.carries.slice(1);
    expect(refusal(b)).toBe("CarryMissing");
  });
  it("a carry whose source is gone is refused: no state flip in the cut, no ledger entry, no rule note, no mexicano cell", () => {
    const flips = copy();
    for (const d of flips.cuts.dispatches) for (const c of d.cases) c.state = "red";
    expect(refusal(flips)).toBe("CarryEmpty");
    const entry = copy();
    entry.ledger.entries = entry.ledger.entries.filter((e) => e.id !== "SC-P4");
    expect(refusal(entry)).toBe("CarrySourceMissing");
    const note = copy();
    note.rules.rules = note.rules.rules.filter((r) => r.gap !== "ST-G5");
    expect(refusal(note)).toBe("CarrySourceMissing");
    const mex = copy();
    mex.l3CaseIds = mex.l3CaseIds.filter((id) => !id.startsWith("mexicano|"));
    expect(refusal(mex)).toBe("CarryEmpty");
  });
  it("a carry whose anchor routes to another wave than the gaps its data is keyed to is refused (the wave is found, never typed)", () => {
    // The mexicano carry hangs on FX-G11 (a mexicano route); its 500s are keyed by the triage to a gap of the same wave.
    const i = copy();
    i.routing.routes["FX-G11"] = "W5";
    expect(refusal(i)).toBe("CarryWaveDisagrees");
    // The ST-G5 carry: the anchor's route against the wave its triage group sits in.
    const j = copy();
    j.routing.routes["ST-G5"] = "W4";
    expect(refusal(j)).toBe("CarryWaveDisagrees");
  });
  it("a carry whose anchor routes to no wave is refused (the wave is found, so there must be one to find)", () => {
    const i = copy();
    i.routing.routes = {};
    expect(refusal(i)).toBe("CarryWaveDisagrees");
  });
  it("the section holds no secret and nothing redact() would change (a fixpoint: the repo is public)", () => {
    expect(findSecrets(md)).toEqual([]);
    expect(md.length).toBeGreaterThan(20_000);
  });
  it("a reason class the flip carry does not know is refused, not printed as a guess", () => {
    const i = copy();
    for (const d of i.cuts.dispatches) for (const c of d.cases) if (c.caseId.startsWith("swiss_playoff|")) c.reason = "something else entirely";
    expect(refusal(i)).toBe("CarryEmpty");
    const j = copy();
    const d1 = j.cuts.dispatches[0]!.cases.find((c) => c.caseId === "swiss_playoff|boardgame|blitz|R4")!;
    d1.reason = "I4-nothing-ends-stuck: a reason of a class nobody wrote down, with another shape";
    expect(refusal(j)).toBe("CarryShapeUnknown");
  });
});

// --- the guards that share a name, told apart by their message ----------------------------------------------------------------------

/** The refusal's name and message: a guard that shares its name with another (TriageInconsistent, CarryEmpty, CarrySourceMissing) is
 *  told apart by what it says, so deleting one cannot hide behind the other. */
function refused(input: BacklogInput): { name: string; message: string } {
  try {
    renderBacklog(input);
  } catch (e) {
    if (e instanceof BacklogRefused) return { name: e.name, message: e.message };
    throw e;
  }
  return { name: "no refusal", message: "" };
}
/** The triage without the named cases, still whole: their rows, their place in every gap's lists (a gap left with none is gone) and
 *  the checked count. */
function withoutCases(input: BacklogInput, ids: readonly string[]): BacklogInput {
  const i = structuredClone(input);
  i.triage.rows = i.triage.rows.filter((r) => !ids.includes(r.caseId));
  i.triage.checked = i.triage.rows.length;
  for (const g of i.triage.gaps) {
    g.caseIds = g.caseIds.filter((id) => !ids.includes(id));
    if (g.alsoCaseIds !== undefined) {
      const left = g.alsoCaseIds.filter((id) => !ids.includes(id));
      if (left.length === 0) delete g.alsoCaseIds;
      else g.alsoCaseIds = left;
    }
  }
  i.triage.gaps = i.triage.gaps.filter((g) => g.caseIds.length > 0 || g.alsoCaseIds !== undefined);
  return i;
}
const gapCases = (input: BacklogInput, gap: string): string[] => input.triage.gaps.find((g) => g.gap === gap)!.caseIds;

describe("each guard of the writer, by its own message (a guard that shares its name with another is not covered by the name)", () => {
  it("TriageInconsistent: a case in two rows, a triage that is not clean, a checked count that is not the rows', gap lists that are not the rows' cases, a case under the wrong gap, a co-failure no row keys", () => {
    const dup = copy();
    dup.triage.rows.push(structuredClone(dup.triage.rows[0]!));
    expect(refused(dup)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/two rows/) });
    const dirty = copy();
    dirty.triage.untriaged.push("some|case|that|nothing|keyed");
    expect(refused(dirty)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/not clean/) });
    const checked = copy();
    checked.triage.checked += 1;
    expect(refused(checked)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/checked/) });
    const lists = copy();
    lists.triage.gaps[0]!.caseIds = lists.triage.gaps[0]!.caseIds.slice(1);
    expect(refused(lists)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/gaps' cases are not the rows' cases/) });
    const wrong = copy();
    const moved = wrong.triage.gaps[0]!.caseIds[0]!;
    wrong.triage.gaps[0]!.caseIds = wrong.triage.gaps[0]!.caseIds.slice(1);
    wrong.triage.gaps[1]!.caseIds = [...wrong.triage.gaps[1]!.caseIds, moved];
    expect(refused(wrong)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/is listed under/) });
    const stray = copy();
    stray.triage.gaps[0]!.alsoCaseIds = ["nonesuch|x|y|z"];
    expect(refused(stray)).toMatchObject({ name: "TriageInconsistent", message: expect.stringMatching(/co-failure/) });
  });

  it("UnknownWave: a gap, an audit id and a carry's anchor each name the wave section 8 lacks; an audit id with no wave at all is refused too", () => {
    const gap = copy();
    gap.triage.gaps[0]!.wave = "W99";
    expect(refused(gap)).toMatchObject({ name: "UnknownWave", message: expect.stringMatching(/is keyed to W99/) });
    const id = copy();
    id.ledger.entries[0]!.wave = "W99";
    expect(refused(id)).toMatchObject({ name: "UnknownWave", message: expect.stringMatching(/routes to W99/) });
    const none = copy();
    none.ledger.entries[0]!.wave = null;
    expect(refused(none)).toMatchObject({ name: "UnknownWave", message: expect.stringMatching(/no wave/) });
    const anchor = copy();
    anchor.routing.routes["SC-P4"] = "W99";
    expect(refused(anchor)).toMatchObject({ name: "UnknownWave", message: expect.stringMatching(/sc-p4-oracle/) });
  });

  it("CarrySourceMissing: the cut lacks a case in a dispatch, the triage keys nothing to an anchor, the ledger has no outcome, the rule names no scenario, a flip cell has no row", () => {
    const cut = copy();
    cut.cuts.dispatches[1]!.cases = cut.cuts.dispatches[1]!.cases.filter((c) => c.caseId !== cut.cuts.ids[0]);
    expect(refused(cut)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/the dispatch cut holds/) });
    const sw = withoutCases(copy(), gapCases(real, "SW-H1"));
    expect(refused(sw)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/ruling-70.*keys no case to SW-H1/) });
    const st = withoutCases(copy(), gapCases(real, "ST-G5"));
    expect(refused(st)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/st-g5-pool-of-one.*keys no case to ST-G5/) });
    const outcome = copy();
    outcome.ledger.entries.find((e) => e.id === "SC-P4")!.outcome = null;
    expect(refused(outcome)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/holds no outcome for SC-P4/) });
    const scenario = copy();
    for (const r of scenario.rules.rules) if (r.gap === "ST-G5") delete r.match.scenario;
    expect(refused(scenario)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/names no scenario/) });
    const swissRow = withoutCases(copy(), ["swiss_playoff|boardgame|blitz|R4"]);
    expect(refused(swissRow)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/swiss-playoff-reason-flip.*keys swiss_playoff\|boardgame\|blitz\|R4 to no gap/) });
    const mexRow = withoutCases(copy(), ["mexicano|football|11-a-side|R4"]);
    expect(refused(mexRow)).toMatchObject({ name: "CarrySourceMissing", message: expect.stringMatching(/mexicano-generate-500.*keys mexicano\|football\|11-a-side\|R4 to no gap/) });
  });

  it("CarryEmpty: no state flip, no steady two-reason cell, no mexicano cell, no flipped one, and no dispatch showing the 500 are each refused, each by what it says", () => {
    const states = copy();
    for (const d of states.cuts.dispatches) for (const c of d.cases) c.state = "red";
    expect(refused(states)).toMatchObject({ name: "CarryEmpty", message: expect.stringMatching(/no cell of the dispatch cut changes state/) });
    const reasons = copy();
    for (const d of reasons.cuts.dispatches) for (const c of d.cases) if (c.caseId.startsWith("swiss_playoff|")) c.reason = "something else entirely";
    expect(refused(reasons)).toMatchObject({ name: "CarryEmpty", message: expect.stringMatching(/two reasons/) });
    const noMex = copy();
    noMex.l3CaseIds = noMex.l3CaseIds.filter((id) => !id.startsWith("mexicano|"));
    expect(refused(noMex)).toMatchObject({ name: "CarryEmpty", message: expect.stringMatching(/holds no mexicano R4 cell/) });
    const steady = copy();
    for (const d of steady.cuts.dispatches) for (const c of d.cases) if (/^mexicano\|/.test(c.caseId)) c.checks = structuredClone(steady.cuts.dispatches[0]!.cases.find((x) => x.caseId === c.caseId)!.checks);
    expect(refused(steady)).toMatchObject({ name: "CarryEmpty", message: expect.stringMatching(/changes its failing-check set/) });
    const quiet = copy();
    for (const d of quiet.cuts.dispatches) for (const c of d.cases) c.reason = c.reason.replaceAll("500 INTERNAL", "an error");
    expect(refused(quiet)).toMatchObject({ name: "CarryEmpty", message: expect.stringMatching(/500 INTERNAL/) });
  });

  it("the mexicano count is the cells that FLIP: a cell whose failing set never changes is a mexicano R4 cell of the cut and is not counted", () => {
    const i = copy();
    const id = "mexicano|football|11-a-side|R4";
    for (const d of i.cuts.dispatches) {
      const c = d.cases.find((x) => x.caseId === id)!;
      c.checks = structuredClone(i.cuts.dispatches[0]!.cases.find((x) => x.caseId === id)!.checks);
    }
    const line = renderBacklog(i).split("\n").find((l) => l.startsWith("- **Mexicano R4: an intermittent 500"))!;
    expect(line).toContain("In 8 of the 11");
    expect(line).toContain("the 8 cells");
    expect(line).toContain("The other 3 cells (football, cricket and generic)");
  });

  it("a NEW gap with no case of its own (only co-failures) is refused: nothing shows which row backs it; an intro placeholder nothing fills is refused", () => {
    const own = withoutCases(copy(), gapCases(real, "NEW-W1d-4"));
    expect(own.triage.gaps.find((g) => g.gap === "NEW-W1d-4")!.caseIds, "the gap kept its co-failures and lost its own cases").toEqual([]);
    expect(refused(own)).toMatchObject({ name: "NewGapUnbacked", message: expect.stringMatching(/no case of its own/) });
    const intro = copy();
    intro.carries.intro.push("an unfilled {nonesuch}");
    expect(refused(intro)).toMatchObject({ name: "CarryPlaceholder", message: expect.stringMatching(/the intro names \{nonesuch\}/) });
  });

  it("a swiss_playoff cell that changes its state or its failing set is no cell of the reason-flip carry: refused, never silently left out", () => {
    const failing = copy();
    const d2 = failing.cuts.dispatches[1]!.cases.find((c) => c.caseId === "swiss_playoff|boardgame|blitz|R4")!;
    d2.checks = d2.checks.map((k) => (k.verdict === "fail" ? { ...k, verdict: "pass" } : k));
    expect(refused(failing)).toMatchObject({ name: "CarryShapeUnknown", message: expect.stringMatching(/changes its state or its failing-check set/) });
    const state = copy();
    state.cuts.dispatches[2]!.cases.find((c) => c.caseId === "swiss_playoff|generic|score|R4")!.state = "works";
    expect(refused(state)).toMatchObject({ name: "CarryShapeUnknown", message: expect.stringMatching(/swiss_playoff\|generic\|score\|R4 changes its state/) });
  });

  it("a carry's text that carries a secret is redacted in the section (the repo is public)", () => {
    const i = copy();
    i.carries.carries[0]!.text += " password=hunter2abcdef";
    const out = renderBacklog(i);
    expect(out).not.toContain("hunter2abcdef");
    expect(out).toContain("[redacted]");
  });
});

describe("loadBacklogInput's own refusals, by name and by what each says", () => {
  const load = (over: Partial<Parameters<typeof loadBacklogInput>[0]>): BacklogRefused => {
    try {
      loadBacklogInput({ triage: triageJsonPath(), sha: SHA, ...over });
    } catch (e) {
      if (e instanceof BacklogRefused) return e;
      throw e;
    }
    throw new Error("loadBacklogInput did not refuse");
  };
  it("a baseline directory with no layer, and a design that is not there, are each refused by name", () => {
    const empty = join(scratch, "empty-baseline");
    mkdirSync(empty, { recursive: true });
    expect(load({ baseline: empty })).toMatchObject({ name: "BaselineUnreadable", message: expect.stringContaining("results.json") });
    expect(load({ design: join(scratch, "no-such-design.md") })).toMatchObject({ name: "DesignUnreadable" });
  });
  it("a catalogue with no carries file, and one whose carries file its schema refuses, are each refused by name", () => {
    const dir = join(scratch, "catalogue-copy");
    mkdirSync(dir, { recursive: true });
    for (const f of ["triage-rules.json", "gap-routing.json", "new-gaps.json", "audit-verdicts.json"]) writeFileSync(join(dir, f), readFileSync(resolve(CATALOGUE_DIR, f)));
    expect(load({ catalogue: dir })).toMatchObject({ name: "CatalogueUnreadable", message: expect.stringContaining("backlog-carries.json") });
    writeFileSync(join(dir, "backlog-carries.json"), JSON.stringify({ heading: "no sha here" }));
    expect(load({ catalogue: dir })).toMatchObject({ name: "CatalogueUnreadable", message: expect.stringContaining("schema refuses") });
  });
  it("a sha that is no commit name, and one that is not the layers' commit, are each refused with their own words", () => {
    expect(load({ sha: "47f" })).toMatchObject({ name: "ShaNotBaseline", message: expect.stringContaining("is not a commit name") });
    expect(load({ sha: "47F210E3F" })).toMatchObject({ name: "ShaNotBaseline", message: expect.stringContaining("is not a commit name") });
    expect(load({ sha: "deadbeef0" })).toMatchObject({ name: "ShaNotBaseline", message: expect.stringContaining("was made at") });
  });
});

// --- the CLI -----------------------------------------------------------------------------------------------------------------------

describe("matrix:backlog, run for real", () => {
  const args = (over: Record<string, string | undefined> = {}): string[] => {
    const all: Record<string, string | undefined> = { "--triage": triageJsonPath(), "--sha": SHA, "--out": join(scratch, "backlog.md"), ...over };
    return Object.entries(all).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
  };

  it("writes exactly what the writer renders from the same inputs, says what it wrote, and exits 0", () => {
    const out = join(scratch, "cli-ok.md");
    const r = runScript("matrix:backlog", args({ "--out": out }));
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(md);
    expect(r.stdout).toContain(`backlog: ${real.triage.gaps.length} gaps, ${real.triage.rows.length} ❌ cases, ${real.ledger.counts["not-exercised"]} not-exercised ids, 9 waves`);
    expect(r.stdout).toMatch(/exit 0: done/);
  }, spawnBudget(1));

  it("the documented form `pnpm run matrix:backlog -- <flags>` works: pnpm hands the script a literal `--` first", () => {
    const out = join(scratch, "cli-dashdash.md");
    const r = runScript("matrix:backlog", ["--", ...args({ "--out": out })]);
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(md);
  }, spawnBudget(1));

  it("usage: a missing flag, an unknown flag and no flag at all exit 2 with the usage line, nothing written", () => {
    let checked = 0;
    for (const missing of ["--triage", "--sha", "--out"]) {
      const out = join(scratch, `cli-miss-${missing.slice(2)}.md`);
      const r = runScript("matrix:backlog", args({ "--out": out, [missing]: undefined }));
      expect(r.status, `without ${missing}`).toBe(2);
      expect(r.stderr).toContain("usage: backlog.ts");
      checked++;
    }
    expect(runScript("matrix:backlog", ["--bogus"]).status).toBe(2);
    expect(runScript("matrix:backlog", []).status).toBe(2);
    expect(checked).toBe(3);
  }, spawnBudget(5));

  it("a sha that is not the baseline's commit (a typo, another commit) is refused by name, nothing written", () => {
    const out = join(scratch, "cli-badsha.md");
    const r = runScript("matrix:backlog", args({ "--sha": "deadbeef0", "--out": out }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("backlog: ShaNotBaseline: ");
    expect(() => readFileSync(out)).toThrow();
    // Too short to name a commit at all.
    expect(runScript("matrix:backlog", args({ "--sha": "47f", "--out": out })).stderr).toContain("backlog: ShaNotBaseline: ");
    // The tag's full commit is a longer name of the same commit.
    const full = join(scratch, "cli-fullsha.md");
    const ok = runScript("matrix:backlog", args({ "--sha": TAG_SHA, "--out": full }));
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(full, "utf8").split("\n")[0]).toBe(`## W1d truth-run backlog (baseline \`${TAG_SHA}\`)`);
  }, spawnBudget(3));

  it("an unreadable triage and a triage the schema refuses are each refused by name, nothing written", () => {
    const out = join(scratch, "cli-badtriage.md");
    const gone = runScript("matrix:backlog", args({ "--triage": join(scratch, "no-such-triage.json"), "--out": out }));
    expect(gone.status).toBe(2);
    expect(gone.stderr).toContain("backlog: TriageUnreadable: ");
    // The three ways in are told apart by what each says: a file that is not there and a file that is not JSON are no schema refusal.
    expect(gone.stderr).toContain("ENOENT");
    expect(gone.stderr).not.toContain("schema refuses");
    const notJson = join(scratch, "not-json-triage.json");
    writeFileSync(notJson, "{ this is not json");
    const bad = runScript("matrix:backlog", args({ "--triage": notJson, "--out": out }));
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("backlog: TriageUnreadable: ");
    expect(bad.stderr).toMatch(/JSON/);
    expect(bad.stderr).not.toContain("schema refuses");
    const refused = runScript("matrix:backlog", args({ "--triage": resolve(CATALOGUE_DIR, "baseline.json"), "--out": out }));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("backlog: TriageUnreadable: ");
    expect(refused.stderr).toContain("schema refuses");
    expect(() => readFileSync(out)).toThrow();
  }, spawnBudget(2));

  it("a triage written from another run than the committed baseline is refused by name, nothing written", () => {
    const t = JSON.parse(readFileSync(triageJsonPath(), "utf8")) as { runs: { runId: string }[] };
    expect(t.runs.length, "the triage names its runs").toBe(3);
    t.runs[0]!.runId = `${t.runs[0]!.runId}-other`;
    const other = join(scratch, "other-triage.json");
    writeFileSync(other, JSON.stringify(t));
    expect(() => loadBacklogInput({ triage: other, sha: SHA })).toThrow(expect.objectContaining({ name: "TriageNotBaseline" }));
    const r = runScript("matrix:backlog", args({ "--triage": other, "--out": join(scratch, "cli-other.md") }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("backlog: TriageNotBaseline: ");
  }, spawnBudget(1));

  it("the baseline directory is the committed one by default: the layers' harness commit is what --sha is held to", () => {
    expect(DEFAULT_BASELINE).toBe(BASE);
    let checked = 0;
    for (const l of LAYERS) {
      const run = JSON.parse(readFileSync(resolve(BASE, l, "results.json"), "utf8")) as { harnessCommit: string };
      expect(TAG_SHA.startsWith(run.harnessCommit), l).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
