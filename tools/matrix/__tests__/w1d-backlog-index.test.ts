// W1d Task 22 (ruling 62, D19): the committed "W1d truth-run backlog" section of _INDEX.md is what `pnpm matrix:backlog` writes from
// the committed baseline and catalogue, byte for byte, and the W2 status row says so.
//
// The section's tables are data, never typed (the brief). So:
//   - the command the section prints is RUN AS PRINTED (after the README's triage command writes the triage.json it reads), and what
//     it writes is compared with the section byte for byte: an edit of the catalogue, the baseline or the section that is not an edit
//     of the other reds this file;
//   - the section is ALSO held to three sources the writer does not read: TRIAGE.md (written by the triage's own renderer: each wave's
//     gap and red counts, each gap's case count and layers, its `also` lines), AUDIT-LEDGER.md (the not-exercised table, written by the
//     ledger's own renderer), and the committed results.json (an example case is a red case of the layer the table says);
//   - each quotation a carry makes of another document is found in that document, so a carry cannot outlive the text it describes.
// Every sweep reports how many items it checked, and zero is a failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAYERS, type Layer } from "../lib/results.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const SPECS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts";
const BASE = resolve(REPO, TRUTH_RUNS, "w1d-baseline");
const read = (rel: string): string => readFileSync(resolve(REPO, rel), "utf8");
/** Whitespace collapsed: a quotation may sit on a wrapped line of its source. */
const flat = (s: string): string => s.replace(/\s+/g, " ");
/** The README's own rows (T17): the commit every results.json records as its harness commit, and the tag's full commit. Read, never typed:
 *  a re-baseline moves them with the README. */
const README = read(`${SPECS}/truth-runs/w1d-baseline/README.md`);
const HARNESS_COMMIT = /^\| harness commit \| `([0-9a-f]+)`/m.exec(README)![1]!;
const TAG_SHA = /^\| tag \| .*?`([0-9a-f]{40})`/m.exec(README)![1]!;

// Created in beforeAll, not at module top: sectionOf() below THROWS while this file is collected when the section is edited, and a throw at
// collection runs no hook, so a directory made at the top leaked (T22 review m7). Registered before every other hook, so it exists for them.
let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "w1d-t22-ix-")); });
afterAll(() => { if (scratch !== "") rmSync(scratch, { recursive: true, force: true }); });

const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
function runScript(script: string, tail: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const words = (scripts[script] ?? "").split(" ");
  expect(words[0], `${script} runs node`).toBe("node");
  const r = spawnSync(process.execPath, [...words.slice(1), ...tail], { cwd: REPO, encoding: "utf8", timeout: 2 * SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// --- the committed section --------------------------------------------------------------------------------------------------------

const INDEX = read(`${SPECS}/_INDEX.md`);
const HEADING = /^## W1d truth-run backlog \(baseline `([0-9a-f]{7,40})`\)$/gm;
/** The section: from its heading to the next level-2 heading (or the end of the file). */
function sectionOf(doc: string): { sha: string; text: string } {
  const heads = [...doc.matchAll(HEADING)];
  expect(heads, "exactly one backlog section").toHaveLength(1);
  const at = heads[0]!.index;
  const rest = doc.slice(at + 3);
  const next = rest.search(/^## /m);
  return { sha: heads[0]![1]!, text: (next < 0 ? doc.slice(at) : doc.slice(at, at + 3 + next)).trimEnd() };
}
const { sha: SHA, text: SECTION } = sectionOf(INDEX);

/** The cells of a table row: split on a pipe that is not escaped, each unescaped. */
const cellsOf = (line: string): string[] => line.replace(/^\| /, "").replace(/ \|$/, "").split(/(?<!\\) \| /).map((c) => c.replaceAll("\\|", "|"));
/** The rows of the first table in `text` whose header starts with `| ${first} |`, each as its cells. */
function tableAfter(text: string, first: string): string[][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`| ${first} |`));
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("| ")) break;
    rows.push(cellsOf(l));
  }
  return rows;
}
/** The numbered waves of design section 8, in its order: `| **W<n> — name** …` (the done waves W1a..W1d are not `W<digits> — `). Read from
 *  the design document, so a new wave row moves this list with the section and no count is typed here. */
const WAVES: string[] = [...read("docs/superpowers/specs/2026-09-27-format-matrix-design.md").matchAll(/^\| \*\*(W\d+) — /gm)].map((m) => m[1]!);
function waveSection(wave: string): string {
  const at = SECTION.search(new RegExp(`^### ${wave} — `, "m"));
  expect(at, `${wave} has a section`).toBeGreaterThanOrEqual(0);
  const rest = SECTION.slice(at);
  const next = rest.slice(4).search(/^### /m);
  return next < 0 ? rest : rest.slice(0, next + 4);
}

// --- the commands, run as printed ------------------------------------------------------------------------------------------------

/** The README's triage command, as printed (`$OUT` replaced): what writes the triage.json the backlog reads. */
function triageArgs(out: string): string[] {
  const body = read(`${SPECS}/truth-runs/w1d-baseline/README.md`).split("## Reproduce\n")[1]!;
  const line = /^ {4}pnpm matrix:triage (.+)$/m.exec(body);
  expect(line, "the README prints the triage command").not.toBeNull();
  return line![1]!.split(" ").map((a) => a.replaceAll("$OUT", out));
}
/** The section's own `pnpm matrix:backlog` line, as printed (`$OUT` replaced). */
function backlogArgs(out: string): string[] {
  const lines = [...SECTION.matchAll(/^ {4}pnpm matrix:backlog (.+)$/gm)];
  expect(lines, "the section prints the backlog command once").toHaveLength(1);
  return lines[0]![1]!.split(" ").map((a) => a.replaceAll("$OUT", out));
}

let made = "";
let madeBy: string[] = [];
beforeAll(() => {
  const out = join(scratch, "out");
  mkdirSync(out, { recursive: true });
  const t = runScript("matrix:triage", triageArgs(out));
  expect(t.status, `${t.stderr}\n${t.stdout}`).toBe(0);
  madeBy = backlogArgs(out);
  const b = runScript("matrix:backlog", madeBy);
  expect(b.status, `${b.stderr}\n${b.stdout}`).toBe(0);
  made = readFileSync(join(out, "backlog.md"), "utf8");
}, spawnBudget(2));

describe("the committed section is what the command it prints writes", () => {
  it("byte for byte (the file the command writes, less its final newline, is the section)", () => {
    expect(made.length, "the command wrote a section, not an empty file").toBeGreaterThan(20_000);
    expect(SECTION.length).toBeGreaterThan(20_000);
    expect(SECTION === made.trimEnd(), "the section differs from what `pnpm matrix:backlog` writes: regenerate it into _INDEX.md").toBe(true);
    expect(made.endsWith("\n"), "the writer ends the file with one newline").toBe(true);
    expect(made.endsWith("\n\n")).toBe(false);
  });

  it("the section is in the file exactly as written: nothing between it and the next heading (or the end of the file) but one blank line", () => {
    const at = INDEX.search(/^## W1d truth-run backlog /m);
    expect(at).toBeGreaterThan(0);
    expect(INDEX.startsWith(made, at), "the file holds the writer's output at the heading").toBe(true);
    const after = INDEX.slice(at + made.length);
    expect(after === "" || after.startsWith("\n## "), `what follows the section is ${JSON.stringify(after.slice(0, 20))}`).toBe(true);
  });

  it("the printed command's arguments are the harness's real inputs: the triage.json the README's command writes, this heading's sha, a file out", () => {
    expect(madeBy.length).toBe(6);
    expect(madeBy[0]).toBe("--triage");
    expect(madeBy[1]!.endsWith("/out/triage.json")).toBe(true);
    expect(madeBy.slice(2, 4)).toEqual(["--sha", SHA]);
    expect(madeBy[4]).toBe("--out");
    expect(madeBy[5]!.endsWith("/out/backlog.md")).toBe(true);
  });

  it("the heading's sha is the harness commit EXACTLY (T22 review m1): the README's row, every layer's `harnessCommit`, and a prefix of the tag's commit", () => {
    expect(SHA, "the heading names the commit the README calls the harness commit").toBe(HARNESS_COMMIT);
    expect(TAG_SHA.startsWith(SHA), "the tag's commit begins with it").toBe(true);
    let checked = 0;
    for (const l of LAYERS) {
      const run = JSON.parse(readFileSync(resolve(BASE, l, "results.json"), "utf8")) as { harnessCommit: string };
      expect(run.harnessCommit, `${l}: harness commit`).toBe(SHA);
      checked++;
    }
    expect(checked).toBe(LAYERS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

// --- the section against the files the writer does not read ---------------------------------------------------------------------

describe("the section agrees with TRIAGE.md (the triage's own renderer)", () => {
  const triageMd = read(`${SPECS}/truth-runs/w1d-baseline/TRIAGE.md`);

  it("each wave's gap and red counts are the `## <wave> — N reds in M gaps` headings; a wave TRIAGE.md has no heading for has none in the summary", () => {
    const summary = tableAfter(SECTION, "wave");
    expect(WAVES.length, "design section 8 has numbered waves").toBeGreaterThan(0);
    expect(summary.map((r) => r[0])).toEqual(WAVES);
    const heads = new Map([...triageMd.matchAll(/^## (W\d+) — (\d+) reds? in (\d+) gaps?$/gm)].map((m) => [m[1]!, { reds: Number(m[2]), gaps: Number(m[3]) }]));
    expect(heads.size, "TRIAGE.md has wave headings").toBeGreaterThan(0);
    let checked = 0;
    let reds = 0;
    for (const r of summary) {
      const h = heads.get(r[0]!) ?? { reds: 0, gaps: 0 };
      expect([Number(r[2]), Number(r[3])], `${r[0]}: gaps and reds`).toEqual([h.gaps, h.reds]);
      reds += Number(r[3]);
      checked++;
    }
    expect(checked, "every numbered wave of design section 8 was compared").toBe(WAVES.length);
    expect([...heads.keys()].every((w) => WAVES.includes(w)), "TRIAGE.md names no wave the section lacks").toBe(true);
    expect(reds, "the reds TRIAGE.md's own title states").toBe(Number(/^# Triage — (\d+) reds of /m.exec(triageMd)![1]));
  });

  it("each gap's case count, layers and `also` lines are TRIAGE.md's, in its order", () => {
    // `## <wave> — N reds in M gaps`, then per gap `### <gap> — <title>`, `N cases; layers L1, L2` and (apart) its `- also fails here:` lines.
    const blocks = triageMd.split(/^(?=## W\d+ — )/m).filter((x) => x.startsWith("## W"));
    const headed = [...triageMd.matchAll(/^## W\d+ — (\d+) reds? in (\d+) gaps?$/gm)];
    expect(headed.length, "TRIAGE.md has wave blocks").toBeGreaterThan(0);
    expect(blocks.length, "wave blocks read from TRIAGE.md are its wave headings").toBe(headed.length);
    let checked = 0;
    for (const block of blocks) {
      const wave = /^## (W\d+) — /.exec(block)![1]!;
      const theirs = block.split(/^(?=### )/m).filter((x) => x.startsWith("### ")).map((g) => ({
        gap: /^### (\S+) — /.exec(g)![1]!,
        cases: /\n\n(\d+) cases?; layers (.+)\n/.exec(g)!,
        also: [...g.matchAll(/^- also fails here: /gm)].length,
      }));
      const mine = tableAfter(waveSection(wave), "gap");
      expect(mine.map((r) => r[0]), `${wave}: gap order`).toEqual(theirs.map((g) => g.gap));
      for (const g of theirs) {
        const r = mine.find((x) => x[0] === g.gap)!;
        expect(r[2], `${g.gap}: cases`).toBe(g.also === 0 ? g.cases[1] : `${g.cases[1]} (+${g.also} also)`);
        expect(r[3], `${g.gap}: layers`).toBe(g.cases[2]);
        checked++;
      }
    }
    const stated = headed.reduce((n, m) => n + Number(m[2]), 0);
    expect(checked, "every gap TRIAGE.md's own headings state was compared").toBe(stated);
    // The section's gap tables hold no gap TRIAGE.md lacks: a table lost or added changes this count.
    const inSection = WAVES.reduce((n, w) => n + tableAfter(waveSection(w), "gap").length, 0);
    expect(inSection, "gap rows in the section").toBe(stated);
    expect(stated).toBeGreaterThan(0);
  });
});

describe("the section agrees with AUDIT-LEDGER.md (the ledger's own renderer)", () => {
  const ledgerMd = read(`${SPECS}/truth-runs/w1d-baseline/AUDIT-LEDGER.md`);
  /** The rows of the ledger's table under `## <title> — N ids`: `| id | wave | sev | title | evidence |`. */
  function ledgerRows(title: string): string[][] {
    const at = ledgerMd.indexOf(`## ${title} — `);
    expect(at, `${title} in the ledger`).toBeGreaterThanOrEqual(0);
    const rest = ledgerMd.slice(at + 3);
    const next = rest.search(/^## /m);
    const body = next < 0 ? rest : rest.slice(0, next);
    return body.split("\n").filter((l) => /^\| [A-Z]{2}-/.test(l)).map(cellsOf);
  }

  it("the not-exercised ids of every wave are the ledger's `not-exercised` table, with its severity and title: all of them, none twice, none missing", () => {
    const want = ledgerRows("not-exercised");
    const head = /^## not-exercised — (\d+) ids$/m.exec(ledgerMd)!;
    expect(want.length, "rows read from the ledger").toBe(Number(head[1]));
    expect(want.length).toBeGreaterThan(0);
    const got: string[][] = [];
    for (const wave of WAVES) for (const r of tableAfter(waveSection(wave), "id")) got.push([r[0]!, wave, r[1]!, r[2]!]);
    const key = (r: string[]): string => `${r[0]} ${r[1]}`;
    expect(got.map(key).sort(), "the ids and their waves").toEqual(want.map((r) => key([r[0]!, r[1]!])).sort());
    for (const r of want) {
      const g = got.find((x) => x[0] === r[0])!;
      expect([g[2], g[3]], `${r[0]}: severity and title`).toEqual([r[2], r[3]]);
    }
    expect(new Set(got.map((r) => r[0])).size, "no id twice").toBe(got.length);
  });

  it("each wave's audit-id counts are the ledger's own: reproduced, not-exercised and verified-by-read ids per wave, re-counted from its three tables", () => {
    const summary = tableAfter(SECTION, "wave");
    const per = (title: string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of ledgerRows(title)) m.set(r[1]!, (m.get(r[1]!) ?? 0) + 1);
      return m;
    };
    // `reproduced` rows are bullets (`- **SC-O1** (W2) …`), not table rows.
    const repro = new Map<string, number>();
    const at = ledgerMd.indexOf("## Reproduced — ");
    const sect = ledgerMd.slice(at + 3, at + 3 + ledgerMd.slice(at + 3).search(/^## /m));
    for (const m of sect.matchAll(/^- \*\*[A-Z]{2}-[A-Z]+\d+\*\* \((W\d+)\)/gm)) repro.set(m[1]!, (repro.get(m[1]!) ?? 0) + 1);
    const ne = per("not-exercised");
    const vr = per("verified-by-read");
    let checked = 0;
    for (const r of summary) {
      expect(Number(r[5]), `${r[0]}: reproduced`).toBe(repro.get(r[0]!) ?? 0);
      expect(Number(r[7]), `${r[0]}: not-exercised`).toBe(ne.get(r[0]!) ?? 0);
      expect(Number(r[8]), `${r[0]}: verified-by-read`).toBe(vr.get(r[0]!) ?? 0);
      expect(Number(r[4]), `${r[0]}: audit ids`).toBe((repro.get(r[0]!) ?? 0) + (ne.get(r[0]!) ?? 0) + (vr.get(r[0]!) ?? 0) + Number(r[6]) + Number(r[9]));
      checked++;
    }
    expect(checked).toBe(WAVES.length);
    // The audit's ids: the five outcome headings of the ledger state their own counts (`## <outcome> — N ids`).
    const stated = [...ledgerMd.matchAll(/^## (?:Reproduced|False premises found|not-exercised|verified-by-read|verified-by-failing-test) — (\d+) ids?/gm)].reduce((n, m) => n + Number(m[1]), 0);
    expect(stated, "the ledger states ids").toBeGreaterThan(0);
    expect(summary.reduce((n, r) => n + Number(r[4]), 0), "the audit's ids").toBe(stated);
  });
});

describe("the example cases are red cases of the committed layers", () => {
  it("each example of each gap is a `red` case in the results.json of a layer the gap lists, and the table's layers are those of its cases", () => {
    const state = new Map<string, { layer: Layer; state: string }>();
    for (const l of LAYERS) {
      const run = JSON.parse(readFileSync(resolve(BASE, l, "results.json"), "utf8")) as { cases: { caseId: string; state: string }[] };
      for (const c of run.cases) state.set(c.caseId, { layer: l, state: c.state });
    }
    let examples = 0;
    let gaps = 0;
    for (const wave of WAVES) {
      for (const r of tableAfter(waveSection(wave), "gap")) {
        const layers = new Set(r[3]!.split(", "));
        for (const e of r[4]!.split(", ").map((c) => c.replace(/^`|`$/g, ""))) {
          const s = state.get(e);
          expect(s, `${r[0]}: ${e} is a case of the committed layers`).toBeDefined();
          expect(s!.state, `${r[0]}: ${e}`).toBe("red");
          expect(layers.has(s!.layer), `${r[0]}: ${e} is a ${s!.layer} case, and the gap lists ${[...layers].join(", ")}`).toBe(true);
          examples++;
        }
        gaps++;
      }
    }
    const stated = [...read(`${SPECS}/truth-runs/w1d-baseline/TRIAGE.md`).matchAll(/^## W\d+ — \d+ reds? in (\d+) gaps?$/gm)].reduce((n, m) => n + Number(m[1]), 0);
    expect(gaps, "gaps read are the ones TRIAGE.md's headings state").toBe(stated);
    expect(gaps).toBeGreaterThan(0);
    expect(examples, "examples read").toBeGreaterThan(gaps);
  });

  it("the reds the gap tables count are the committed layers' red cases, re-counted from the results and from TRIAGE.md's own title", () => {
    let reds = 0;
    for (const l of LAYERS) reds += (JSON.parse(readFileSync(resolve(BASE, l, "results.json"), "utf8")) as { cases: { state: string }[] }).cases.filter((c) => c.state === "red").length;
    let counted = 0;
    for (const wave of WAVES) for (const r of tableAfter(waveSection(wave), "gap")) counted += Number(/^\d+/.exec(r[2]!)![0]);
    expect(reds, "the layers hold reds").toBeGreaterThan(0);
    expect(reds, "TRIAGE.md's title states the same count").toBe(Number(/^# Triage — (\d+) reds of /m.exec(read(`${SPECS}/truth-runs/w1d-baseline/TRIAGE.md`))![1]));
    expect(counted).toBe(reds);
  });
});

// --- the status row ---------------------------------------------------------------------------------------------------------------

describe("the W2 status row has left `not started` for the backlog being ready or a later state, and the status table keeps every wave's row", () => {
  /** The status table's rows: between its heading and the next one. */
  const rows = (): string[] => {
    const at = INDEX.indexOf("\n## Status\n");
    const rest = INDEX.slice(at + 1);
    return rest.slice(0, rest.slice(3).search(/^## /m) + 3).split("\n").filter((l) => /^\| W\d+[a-z-]* \|/.test(l));
  };
  // This pin must not red on the edits the programme MANDATES (T22 review m5): the W2 planner's own status edit ("in progress", then
  // done) and W3's re-baseline. So it holds the one thing that would be a defect, a lost flip, and the one cross-check that is true only
  // while the state is still this task's: the sha the row names.
  it("W2's state is not `not started` (the flip is not lost), and while it still says `backlog ready` it names this section's baseline", () => {
    const w2 = rows().find((l) => l.startsWith("| W2 |"));
    expect(w2, "W2's row").toBeDefined();
    const state = cellsOf(w2!)[2]!.replaceAll("*", "").trim();
    expect(state.length, "W2's state is not empty").toBeGreaterThan(0);
    expect(/^not started/i.test(state), `W2's state reads: ${state.slice(0, 80)}`).toBe(false);
    if (/^backlog ready/i.test(state)) {
      expect(state.startsWith(`backlog ready (W1d baseline \`${SHA}\`)`), `W2's state reads: ${state.slice(0, 80)}`).toBe(true);
    }
  });
  it("the status table still has a row for every wave of design section 8, once each, and no name twice (a flip is an edit of one row, not a rewrite of the table)", () => {
    const names = rows().map((l) => l.split(" | ")[0]!.replace("| ", ""));
    const design = [...read("docs/superpowers/specs/2026-09-27-format-matrix-design.md").matchAll(/^\| \*\*(W\d+[a-z]?) — /gm)].map((m) => m[1]!);
    expect(design.length, "design section 8 has waves").toBeGreaterThan(WAVES.length);
    for (const w of design) expect(names.filter((n) => n === w), `${w}'s row`).toHaveLength(1);
    expect(new Set(names).size, "no wave twice").toBe(names.length);
  });
});

// --- the carries' quotations ------------------------------------------------------------------------------------------------------

const RB2B_7 = /\bRB2B-7\b/;

describe("each quotation a carry makes is in the document it quotes", () => {
  const outside = INDEX.replace(SECTION, "");

  it("W2's trap 2, the SC-P4 premise, design section 8's row and the rulebook's RB2B-7 say what the carry says they say", () => {
    expect(flat(read(`${SPECS}/W2-scoring-fidelity.md`))).toContain("the declared 3/0 loses to the FIH 2/1 the rulebook adopts (§7.1), so the case is ❌ until fixed");
    expect(flat(outside)).toContain("\"FIH 2/1 shoot-out split\" is the FIH Pro League rule only; FIH tournament regulations use 3/1/0 with draws standing and no pool shoot-outs, which the product already does by default");
    expect(flat(outside)).toContain("The gap narrows to \"no points fields when shoot-outs are switched on\"");
    expect(flat(read("docs/superpowers/specs/2026-09-27-format-matrix-design.md"))).toContain("FIH 2/1 is Pro League only");
    const rulebook = flat(read(`${SPECS}/rulebook-W2-goals-boards.md`));
    expect(rulebook).toContain("turning shoot-outs on for a hockey table stage opens SO points fields seeded 2/1");
    expect(rulebook).toContain("**None is a ruling.**");
    // The plan's false premise 20 is this contradiction, and no entry of this file names RB2B-7 outside the section. (W2a's
    // owner rulings 72-74, 2026-10-08, cite OTHER rulebook rows - RB2B-14, -16, -23, -28 - as their source; the carry's claim is
    // about the one row, RB2B-7, that no ruling signs.)
    expect(flat(outside)).toContain("**W2 prompt trap 2** (\"declared 3/0 loses to the FIH 2/1 the rulebook adopts\", SC-P4)");
    expect(RB2B_7.test(outside), "an RB2B-7 entry in this file would be a ruling the carry says is absent").toBe(false);
    // The pin sees RB2B-7 and leaves the other rows W2a's rulings cite alone (RB2B-70 would not be it either).
    expect(RB2B_7.test("signed: RB2B-7")).toBe(true);
    expect(RB2B_7.test("RB2B-14, RB2B-16 and RB2B-70")).toBe(false);
  });

  it("the W3 prompt states the re-baseline handoff, and ruling 70 carries the recommendation the section calls the controller's", () => {
    const w3 = flat(read(`${SPECS}/W3-swiss.md`));
    expect(w3).toContain("The fix for SW-H1 removes owner ruling 70's override in the same change");
    expect(w3).toContain("`RULING_70_IDS` in `tools/matrix/lib/pr-sample.ts`");
    expect(w3).toContain("re-baseline L3");
    expect(flat(outside)).toContain("Recommendation (mine, not a ruling): move P6 up in W3");
  });

  it("the section itself never labels a recommendation an owner ruling", () => {
    const rec = SECTION.split("\n").find((l) => l.startsWith("- **Recommendation"))!;
    expect(rec).toContain("the controller's, not an owner ruling");
    expect(rec).not.toMatch(/owner (ruled|approved|said)/i);
  });
});
