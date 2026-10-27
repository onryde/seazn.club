// The rules reference checker, the monorepo's half (engine-split 1d-5, spec §5.4 "split by where the proof lives").
//
// packages/engine/rules/*.md hold the engine's rules; each row names the tests that prove it and the code that enforces it. Those
// paths are mostly NOT the engine's: apps/web, e2e, tools/ and packages/reference prove most of them. The engine checks the paths it
// owns (packages/engine/test/rules-reference.test.ts, " (engine paths)"); this file checks every other path, the W2b rows' text
// against the W2b spec, and the CI wiring of both checkers, because all three read the monorepo and must survive the engine leaving it.
//
// The rows are read through the engine's PUBLISHED testkit (`@seazn/engine/testkit`), as a consumer of the package would read them.
// Phase-1 couplings that 2b must resolve, listed in the reverse inventory (1d-6): the proof checker (`proofProblems`, which needs
// `typescript` and so cannot ship in the testkit), the shared W2b pins and the spawn budget are imported from packages/engine/test/.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allRows, type RuleRow } from "@seazn/engine/testkit";
import { describe, expect, it } from "vitest";
import { AWAITING_PROOF, REPO, fileExists, inEngine, isMatrixCase, proofBudget, proofProblems, readRepoFile, type ReadRepoFile } from "../../packages/engine/test/rules-reference.ts";
import { SPAWN_MS, spawnBudget } from "../../packages/engine/test/stryker-spawn.ts";
import { readAppendixA, w2bIds, w2bProblems, type AppendixA } from "../../packages/engine/test/w2b-rows.ts";

/** The approved W2b spec. Its Appendix A is the W2b rows' written source, read at test time (review M-2), so a row whose
 *  text drifts from the spec — "3-0" becoming "5-0" — is a failure, and a spec amendment moves the pin with it. */
const W2B_SPEC = join(REPO, "docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md");

/** The W2b rows whose text is NOT Appendix A's, each with its whole expected text and what changed it. Every entry must
 *  differ from Appendix A (or, for X-BR-1, have Appendix A's amend line): a stale entry is a failure. Every other W2b id
 *  carries Appendix A's text exactly. */
const AMENDED_TEXT: Readonly<Record<string, { says: string; by: string }>> = {
  "X-BR-1": {
    says: "In a bracket kind, a fixture is decided only by a win or a double walkover (from play, a decider, a forfeit or settle); `draw`, `tie` and `no_result` are never a decided result.",
    by: "Appendix A's own amend line (ruling 84): \"a win\" became \"a win or a double walkover\"",
  },
  "X-RS-1": {
    says: "A forfeit records one reason from a closed list (walkover, retired, disqualified, withdrew), never free text, and nothing played means not started for every reason (rulings 112, 113): played is an active sport (module-owned) event after `core.start`, scoring or not (ruling 114), kernel admin events and voided events not counting; a walkover and a double walkover are recordable until something is played (chess keeps its wider walkover phases, FIDE 6.7.1), a disqualification from the Start, a retirement only once something is played, and a withdrawal in any phase until the match has a result, or over a held level result (PF-1). Amended by ruling 118 (2026-10-12): in chess the Start itself is play (Seazn records no moves), so a chess retirement is recordable from the Start.",
    by: "owner rulings 112, 113 and 114 (2026-10-11): nothing played means not started, for every reason; played is any sport event after the Start; ruling 118 (2026-10-12): in chess the Start itself is play",
  },
  "X-WO-1": {
    says: "Walkover and retirement credit is derived from the stage's own cfg (best-of, target score, overs), and the same credited score is used in the table, tie-breaks, the public page and the qualification view; a credited result pays the table points of its credited score, the offender's side included (a bye keeps the clean-sweep pair). The exception: a sport may declare a *loss-not-played* value, and then the side that loses an award (walkover, retirement, default, disqualification or withdrawal; never a bye, which has no loser) is paid that value instead. The winner is still paid its credited score's points. Table tennis declares 0 (ITTF 3.7.5.1). No other sport declares one.",
    by: "owner ruling 108 (2026-10-11): a credited result pays the table points of its credited score; amended by W2d D6 (owner Q6, 2026-10-20; signed 2026-10-24): a sport may declare a loss-not-played value, table tennis 0",
  },
  "VB-RT-1": {
    says: "Volleyball retirement (incomplete team) = winner given the sets and points it needed; the retiring side keeps what it won, and both sides take the table points of that credited set score (retiring at two sets all is a 3-2 loss).",
    by: "owner ruling 108 (2026-10-11): retiring at two sets all is the 3-2 loss's point",
  },
  "X-WD-1": {
    says: "When a side withdraws from a held (needs_decision) bracket fixture, the fixture is walked over to the remaining side, reason \"withdrew\", with the sport's retirement credit.",
    by: "W2b ledger I-1 and Task 15 review M-6: the sport's own retirement credit",
  },
  "BD-RT-1": {
    says: "Badminton retirement = points played stand, the current game completed for the winner to its legal end (21, or two clear up to the 30 cap), remaining games 21-0 (until W5's 16.2.5).",
    by: "Task 15 review M-6, owner Q2: the current game runs to its legal end, not a flat 21",
  },
  "FB-AB-1": {
    says: "Football abandon under abandonPolicy award: leader wins with the real score; level = draw with the real score in draw kinds; in brackets a level abandon stays abandoned for the desk to settle, never needs_decision.",
    by: "Task 14 fix round 1 M-1: spec §5.4 rule 2, a level abandon in a bracket stays abandoned (HK-AB-1 and IH-AB-1 say \"Same as FB-AB-1\", so they take it by reference and keep Appendix A's text)",
  },
};
/** The two W2b rows Appendix A does not hold (orchestrator rulings PF-6, PF-7; X-WD-6 worded by ruling 113), pinned here
 *  by their whole text. */
const NOT_IN_APPENDIX_A: Readonly<Record<string, { says: string; by: string }>> = {
  "CK-WO-2": {
    says: "Unlimited-overs (Test, first-class) cricket walkover credits the result and its table points only: no runs or overs are credited, and the match is out of NRR (with no quota, NRR is undefined).",
    by: "plan PF-6",
  },
  "X-WD-6": {
    says: "A withdrawal (reason \"withdrew\") takes the sport's walkover credit while nothing is played (no Start, or a Start with nothing played, ruling 113) and the sport's retirement credit once something is played (a held level result included, X-WD-1).",
    by: "plan PF-7 and ruling 113",
  },
};
interface TextCheck { problems: string[]; fromAppendix: number; amended: number; added: number }
/** Each W2b row's text against Appendix A, its recorded amendment or its recorded addition, and every Appendix A row
 *  owed as a W2b id. A missing row is w2bProblems' to report; this counts what it compared, so zero compared shows. */
function w2bTextProblems(rows: readonly RuleRow[], appendix: AppendixA): TextCheck {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const inAppendix = new Map(appendix.rows.map((a) => [a.id, a]));
  const owed = [...w2bIds(), "X-BR-1"];
  const check: TextCheck = { problems: [], fromAppendix: 0, amended: 0, added: 0 };
  const p = check.problems;
  for (const id of owed) {
    const r = byId.get(id);
    if (r === undefined) continue;
    const a = inAppendix.get(id);
    if (a !== undefined && a.file !== r.file) p.push(`${id}: Appendix A files it in ${a.file}, the rows in ${r.file}`);
    const amended = AMENDED_TEXT[id];
    const added = NOT_IN_APPENDIX_A[id];
    if (amended !== undefined) {
      if (r.rule !== amended.says) p.push(`${id}: the text is not its amendment (${amended.by}): ${r.rule}`);
      if (a === undefined && !appendix.amendments.includes(`${id} (amend)`)) p.push(`${id}: recorded as amended, but Appendix A has no amend line for it`);
      if (a !== undefined && a.rule === amended.says) p.push(`${id}: recorded as amended, but Appendix A already says it`);
      check.amended++;
    } else if (added !== undefined) {
      if (a !== undefined) p.push(`${id}: Appendix A holds it now (${added.by}); pin it from there`);
      if (r.rule !== added.says) p.push(`${id}: the text is not ${added.by}'s: ${r.rule}`);
      check.added++;
    } else if (a === undefined) {
      p.push(`${id}: not in Appendix A, and recorded as neither amended nor added`);
    } else {
      if (r.rule !== a.rule) p.push(`${id}: the text is not Appendix A's: "${r.rule}" (Appendix A: "${a.rule}")`);
      check.fromAppendix++;
    }
  }
  const owedSet = new Set(owed);
  for (const a of appendix.rows) if (!owedSet.has(a.id)) p.push(`${a.id}: in Appendix A but owed by no W2b pin`);
  return check;
}

/** The (row, proving test path) pairs the proof check below reads: every signed or deviation row not awaiting proof, each of its
 *  non-matrix paths OUTSIDE packages/engine/ (the engine's half reads the rest). Counted from the table, not from the check's own reads. */
const PROOF_PAIRS = allRows()
  .filter((r) => !r.status.startsWith("⬜") && !AWAITING_PROOF.has(r.id))
  .reduce((n, r) => n + r.provedBy.filter((p) => !isMatrixCase(p) && !inEngine(p)).length, 0);

/** A synthetic signed row: the fixtures of the real-repo reader test below. */
const row = (provedBy: string[]): RuleRow => ({ id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy, file: "synthetic.md" });
const noTitle = (p: string) => `X-ZZ-1: ${p} has no it/test/describe title naming "X-ZZ-1"`;

describe("rules reference (ruling 75, spec §6)", () => {
  it("the default reader reads the real repo: a missing file is undefined, any other failure is loud, and proofProblems uses it when none is injected", () => {
    expect(readRepoFile("packages/engine/rules/carrom.md")).toContain("CA-KO-1");
    expect(readRepoFile("packages/engine/rules/no-such.md")).toBeUndefined();
    expect(() => readRepoFile("packages/engine/rules")).toThrow(/EISDIR/);
    expect(proofProblems(row(["apps/web/src/no-such-file.test.ts"]))).toEqual(["X-ZZ-1: apps/web/src/no-such-file.test.ts does not exist"]);
    // A REAL test file, read through the default reader: it exists, and none of its titles names the synthetic id.
    const real = "packages/engine/test/source-bytes.test.ts";
    expect(proofProblems(row([real]))).toEqual([noTitle(real)]);
  });

  // The monorepo's half of the proof check that used to be one test in the engine: every proof path that is NOT under
  // packages/engine/ (the engine checks those, " (engine paths)"). Each half reports what it checked, and zero is a failure.
  it("every signed or deviation row names a proving test that exists and contains the id (or awaits proof by name) (app, tools and reference paths)", (ctx) => {
    const outsideEngine = (p: string): boolean => !inEngine(p);
    const reads: string[] = [];
    const read: ReadRepoFile = (p) => { reads.push(p); return readRepoFile(p); };
    let rows = 0;
    let paths = 0;
    for (const r of allRows()) {
      // an open row proves nothing yet, and a row that awaits its proof by name must claim none: the engine half asserts that
      if (r.status.startsWith("⬜") || AWAITING_PROOF.has(r.id)) continue;
      expect(proofProblems(r, read, outsideEngine), r.id).toEqual([]);
      const mine = r.provedBy.filter((p) => !isMatrixCase(p) && outsideEngine(p)).length;
      paths += mine;
      if (mine > 0) rows++;
    }
    expect(rows, "signed rows with a proof path outside the engine").toBeGreaterThan(0);
    expect(paths, "proof paths outside the engine, each read and its titles checked").toBeGreaterThan(0);
    // the split is observed, not assumed: every path this half read is outside the engine (a literal, not the predicate under test),
    // and it read exactly the paths it counted
    expect(reads.filter((p) => p.startsWith("packages/engine/")), "engine paths this half read").toEqual([]);
    expect(reads.length, "paths this half read").toBe(paths);
    // Batch 4 review M7 (AGENTS.md class 20), as the engine half has it: one read and, per distinct file, one TypeScript parse for
    // every pair, so the cost grows with the table. The budget is stated from the pairs the table has, and the run made exactly those.
    expect(reads.length, "the reads the budget was derived from are the reads made").toBe(PROOF_PAIRS);
    expect(ctx.task.timeout, "the timeout vitest applied is the one stated from those pairs, not a default").toBe(proofBudget(reads.length));
  }, proofBudget(PROOF_PAIRS));

  it("every enforced-at path exists (app, tools and reference paths)", () => {
    const checked: string[] = [];
    for (const r of allRows()) for (const p of r.enforcedAt) {
      if (inEngine(p)) continue; // the engine's: checked beside the rules, " (engine paths)"
      expect(fileExists(p), `${r.id}: ${p}`).toBe(true);
      checked.push(p);
    }
    expect(checked.length, "enforced-at paths outside the engine").toBeGreaterThan(0);
    expect(checked.filter((p) => p.startsWith("packages/engine/")), "engine paths this half checked").toEqual([]);
  });
});

describe("W2b rows (spec §6, Appendix A; plan PF-6, PF-7, PF-13; rulings 108, 112, 113, 114, 115, 118)", () => {
  it("empty case first: with no rows, every one of the 55 W2b ids and X-BR-1 is reported missing", () => {
    const problems = w2bProblems([]);
    expect(problems).toHaveLength(56);
    expect(problems.filter((p) => !/: missing/.test(p))).toEqual([]);
    // The text pin compares nothing and says so (its counts are zero), and never mistakes a missing row for a match.
    expect(w2bTextProblems([], readAppendixA(readFileSync(W2B_SPEC, "utf8")))).toEqual({ problems: [], fromAppendix: 0, amended: 0, added: 0 });
  });

  it("W2b: each row's text is Appendix A's, read from the spec at test time, or its recorded amendment (rulings 84, 108, 112, 113, 114; ledger I-1; Task 15 M-6; Task 14 M-1), Appendix A amended in place (rulings 113, 115) or addition (PF-6, PF-7)", () => {
    const appendix = readAppendixA(readFileSync(W2B_SPEC, "utf8"));
    expect(appendix.rows.length + appendix.amendments.length, "Appendix A parses to the total it states").toBe(appendix.stated);
    expect(appendix.amendments).toEqual(["X-BR-1 (amend)"]);
    const check = w2bTextProblems(allRows(), appendix);
    expect(check.problems).toEqual([]);
    // Anti-vacuity: every W2b id and X-BR-1 was compared, each through exactly one of the three branches.
    const amendedInAppendix = Object.keys(AMENDED_TEXT).filter((id) => appendix.rows.some((a) => a.id === id)).length;
    expect(check).toEqual({
      problems: [],
      fromAppendix: appendix.rows.length - amendedInAppendix,
      amended: Object.keys(AMENDED_TEXT).length,
      added: Object.keys(NOT_IN_APPENDIX_A).length,
    });
    expect(check.fromAppendix + check.amended + check.added).toBe(w2bIds().length + 1);
    expect(check.fromAppendix).toBeGreaterThan(0);
  });

  it("the text pin sees a changed number, an amendment reverted, a stale amendment, a lost amend line, an added row edited or moved into Appendix A, a row in another file and an Appendix A row nobody owes (synthetic edits)", () => {
    const appendix = readAppendixA(readFileSync(W2B_SPEC, "utf8"));
    const rows = allRows();
    const edit = (id: string, patch: Partial<RuleRow>) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    const problems = (rs: readonly RuleRow[], app: AppendixA = appendix) => w2bTextProblems(rs, app).problems;
    const fb = rows.find((r) => r.id === "FB-WO-1");
    expect(fb?.rule).toContain("3-0");
    const seen: string[][] = [];
    seen.push(problems(edit("FB-WO-1", { rule: (fb?.rule ?? "").replace("3-0", "5-0") })));
    const wasAppendix = appendix.rows.find((a) => a.id === "X-WO-1")?.rule;
    expect(wasAppendix).toBeDefined();
    seen.push(problems(edit("X-WO-1", { rule: wasAppendix ?? "" })));
    const caughtUp = appendix.rows.map((a) => (a.id === "FB-AB-1" ? { ...a, rule: AMENDED_TEXT["FB-AB-1"]?.says ?? "" } : a));
    seen.push(problems(rows, { ...appendix, rows: caughtUp }));
    seen.push(problems(rows, { ...appendix, amendments: [] }));
    seen.push(problems(edit("CK-WO-2", { rule: "Unlimited-overs cricket walkover = 1-0." })));
    seen.push(problems(rows, { ...appendix, rows: [...appendix.rows, { id: "X-WD-6", rule: NOT_IN_APPENDIX_A["X-WD-6"]?.says ?? "", file: "cross-sport.md" }] }));
    seen.push(problems(edit("FB-WO-1", { file: "hockey.md" })));
    seen.push(problems(rows, { ...appendix, rows: [...appendix.rows, { id: "X-ZZ-9", rule: "r", file: "cross-sport.md" }] }));
    const want = [
      /^FB-WO-1: the text is not Appendix A's: ".*5-0/,
      /^X-WO-1: the text is not its amendment \(owner ruling 108/,
      /^FB-AB-1: recorded as amended, but Appendix A already says it$/,
      /^X-BR-1: recorded as amended, but Appendix A has no amend line for it$/,
      /^CK-WO-2: the text is not plan PF-6's: /,
      /^X-WD-6: Appendix A holds it now \(plan PF-7 and ruling 113\)/,
      /^FB-WO-1: Appendix A files it in football\.md, the rows in hockey\.md$/,
      /^X-ZZ-9: in Appendix A but owed by no W2b pin$/,
    ];
    expect(seen).toHaveLength(want.length);
    for (const [i, got] of seen.entries()) {
      expect(got, String(want[i])).toHaveLength(1);
      expect(got[0], String(want[i])).toMatch(want[i]!);
    }
  });
});

// Review I-3: the proofs live in apps/web, e2e and tools, so a PR that touches none of packages/engine/** must still
// run this checker. The engine job in ci.yml is path-filtered; the `gates` job is not.
describe("the checker runs on every pull request: CI wiring (review I-3)", () => {
  const lines = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8").split("\n");
  const code = (l: string) => l.trim() !== "" && !l.trimStart().startsWith("#");
  const HEAD = "      - name: Engine rules reference checker (DB-free)";
  const REPORT = "vitest-results-rules.json";
  const at = lines.indexOf(HEAD);
  /** The step's own lines: everything after its `- name:` line indented 8 or more (its keys and its block scalar). */
  const stepLines = (): string[] => {
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && !l.startsWith("        ")) break;
      out.push(l);
    }
    return out;
  };

  it("the engine checker's step appears once, in the gates job, named for the checker", () => {
    expect(lines.filter((l) => l === HEAD)).toHaveLength(1);
    expect(at).toBeGreaterThan(0);
    const jobHead = lines.slice(0, at).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();
    expect(jobHead).toBe("  gates:");
  });

  it("nothing narrows the engine checker's step: the workflow triggers on every pull request, the job has no condition, the step is only a name and a run block", () => {
    const onAt = lines.indexOf("on:");
    const afterOn = lines.findIndex((l, i) => i > onAt && /^[a-z]/.test(l));
    expect(onAt).toBeGreaterThanOrEqual(0);
    expect(lines.slice(onAt + 1, afterOn).filter(code)).toEqual(["  pull_request:"]); // no paths:, paths-ignore: or branches: under it
    const gates = lines.indexOf("  gates:");
    const steps = lines.indexOf("    steps:", gates);
    expect(lines.slice(gates + 1, steps).filter(code)).toEqual(["    name: Typecheck + lint + drift gates", "    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}"]);
    expect(stepLines().filter((l) => /^ {8}[a-z-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ""))).toEqual(["run"]);
  });

  it("the engine checker's step runs only packages/engine/test/rules-reference.test.ts with the JSON reporter, clears any stale report first, and ends in a node judge (no jq)", () => {
    const script = stepLines().filter((l) => l.startsWith("          ")).map((l) => l.slice(10));
    expect(script.slice(0, 3)).toEqual([
      "set -euo pipefail",
      `rm -f ${REPORT}`,
      `./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=${REPORT} --testTimeout=30000 packages/engine/test/rules-reference.test.ts`,
    ]);
    // The judge is the rest: one `node -e '…'` block, nothing after its closing quote, no single quote inside it.
    expect(script[3]).toBe("node -e '");
    expect(script.at(-1)).toBe("'");
    const body = script.slice(4, -1);
    expect(body.length).toBeGreaterThan(0);
    expect(body.filter((l) => l.includes("'"))).toEqual([]);
    expect(script.join("\n")).not.toMatch(/\bjq\b/);
  });

  /** Every `runStep` is one bash spawn (which itself runs a stand-in vitest and a node judge). AGENTS.md class 20: a flat
   *  timeout beside a derived cost is a latent red. Vitest's 5 s default fired at 17 s and 6 s under a CPU burner (24 burners on
   *  12 cores: about 2 s a run), so each test below states its budget from the runs it makes, at the same cap the spawn carries
   *  (`SPAWN_MS`, via `spawnBudget`), and asserts that the runs it made are the runs the budget was derived from. */
  let spawns = 0;

  /** Runs the step's REAL run block in a scratch checkout whose vitest is a stand-in: it writes FAKE_JSON to the
   *  `--outputFile=` the step passed it, then exits FAKE_EXIT. Plain `bash`: the block's own `set -e` carries the fail-fast. */
  const runStep = (o: { json: object | null; exit?: number; stale?: object }) => {
    spawns++;
    const root = realpathSync(mkdtempSync(join(tmpdir(), `w2a-rules-ci-${process.pid}-`)));
    try {
      const bin = join(root, "packages/engine/node_modules/.bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "vitest"), ["#!/bin/sh", 'out=""', 'for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done', 'if [ -n "$FAKE_JSON" ]; then cp "$FAKE_JSON" "$out"; fi', 'exit "$FAKE_EXIT"', ""].join("\n"));
      chmodSync(join(bin, "vitest"), 0o755);
      let fake = "";
      if (o.json !== null) { fake = join(root, "fake-report.json"); writeFileSync(fake, JSON.stringify(o.json)); }
      if (o.stale !== undefined) writeFileSync(join(root, REPORT), JSON.stringify(o.stale)); // a report left by an earlier run
      writeFileSync(join(root, "step.sh"), stepLines().filter((l) => l.startsWith("          ")).map((l) => l.slice(10)).join("\n") + "\n");
      const r = spawnSync("bash", ["step.sh"], { cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_JSON: fake, FAKE_EXIT: String(o.exit ?? 0) }, encoding: "utf8", timeout: SPAWN_MS });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const report = (o: Record<string, unknown> = {}) => ({ numTotalTests: 11, numPassedTests: 11, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: "a.test.ts" }], ...o });

  // Each red changes exactly one field, so no condition is covered by another: a file that collected zero tests
  // still has its one testResults entry, and a stray second file leaves every count clean.
  const REDS: Array<[string, object, string]> = [
    ["zero tests in the one file", report({ numTotalTests: 0, numPassedTests: 0 }), "ZERO tests"],
    ["no file matched at all", report({ numTotalTests: 0, numPassedTests: 0, testResults: [] }), "ZERO tests"],
    ["a failed test", report({ numFailedTests: 1 }), "failed test(s)"],
    ["a failed suite", report({ numFailedTestSuites: 1 }), "failed suite(s)"],
    ["a skipped test", report({ numPendingTests: 1 }), "skipped"],
    ["a todo test", report({ numTodoTests: 1 }), "todo"],
    ["a stray file", report({ testResults: [{ name: "a.test.ts" }, { name: "b.test.ts" }] }), "ran 2 files, not exactly 1"],
  ];
  /** One green run, then one run per red. */
  const JUDGE_RUNS = 1 + REDS.length;
  /** A non-zero vitest exit, no report written, and a stale report left behind. */
  const STEP_RUNS = 3;

  it(`the engine step's judge is green on a clean single-file pass and red, naming its reason, on each of ${REDS.length} faults, run through real bash and node`, (ctx) => {
    spawns = 0;
    const green = runStep({ json: report() });
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout).toContain("rules reference: 11/11 tests passed");
    for (const [what, json, why] of REDS) {
      const r = runStep({ json });
      expect(r.status, `${what}: ${r.stdout}`).toBe(1);
      expect(r.stderr, what).toContain(`::error::`);
      expect(r.stderr, what).toContain(why);
    }
    expect(REDS).toHaveLength(7);
    expect(spawns, "the runs the budget was derived from are the runs made").toBe(JUDGE_RUNS);
    expect(ctx.task.timeout, "the timeout vitest applied is the one stated from those runs, not a default").toBe(spawnBudget(spawns));
  }, spawnBudget(JUDGE_RUNS));

  it("the engine checker's step is red when vitest exits non-zero on a clean report, when it writes no report, and when only a stale clean one is left from an earlier run", (ctx) => {
    spawns = 0;
    const failedExit = runStep({ json: report(), exit: 1 });
    expect(failedExit.status).not.toBe(0);
    expect(failedExit.stdout).not.toContain("rules reference:"); // set -e stopped it before the judge
    const noReport = runStep({ json: null });
    expect(noReport.status).not.toBe(0);
    const stale = runStep({ json: null, stale: report() }); // rm -f clears the clean stale report, so the judge finds none
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).not.toContain("rules reference:");
    expect(spawns, "the runs the budget was derived from are the runs made").toBe(STEP_RUNS);
    expect(ctx.task.timeout, "the timeout vitest applied is the one stated from those runs, not a default").toBe(spawnBudget(spawns));
  }, spawnBudget(STEP_RUNS));

  // ---- Added by engine-split 1d-5 (R30). The engine file moved out of this job's reach once the engine leaves, and its monorepo half
  // needs a step of its own: a separate step with its own report, so the step above keeps running only the engine file.
  const ENGINE_FILE = "packages/engine/test/rules-reference.test.ts";
  const ROOT_FILE = "scripts/__tests__/rules-reference.test.ts";
  const ROOT_HEAD = "      - name: Root rules reference checker (DB-free)";
  const ROOT_REPORT = "vitest-results-rules-root.json";
  const rootAt = lines.indexOf(ROOT_HEAD);
  /** A step's own lines, from the index of its `- name:` line. */
  const bodyAt = (from: number): string[] => {
    const out: string[] = [];
    for (const l of lines.slice(from + 1)) {
      if (l.trim() !== "" && !l.startsWith("        ")) break;
      out.push(l);
    }
    return out;
  };
  const scriptAt = (from: number): string[] => bodyAt(from).filter((l) => l.startsWith("          ")).map((l) => l.slice(10));

  it("the gates job runs scripts/__tests__/rules-reference.test.ts, in a step of its own after the engine checker's, which still runs only the engine file", () => {
    expect(lines.filter((l) => l === ROOT_HEAD)).toHaveLength(1);
    expect(at, "the engine checker's step").toBeGreaterThan(0);
    expect(rootAt, "the root checker's step comes after it").toBeGreaterThan(at);
    expect(lines.slice(0, rootAt).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop(), "the job the root step is in").toBe("  gates:");
    expect(scriptAt(rootAt)[2]).toBe(`./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=${ROOT_REPORT} --testTimeout=30000 ${ROOT_FILE}`);
    // the two steps run one file each, and not each other's
    expect(scriptAt(at).filter((l) => l.includes(ROOT_FILE))).toEqual([]);
    expect(scriptAt(rootAt).filter((l) => l.includes(ENGINE_FILE))).toEqual([]);
    expect(scriptAt(at).filter((l) => l.includes(ENGINE_FILE))).toHaveLength(1);
  });

  it("the whole-directory scripts step leaves this file to its own step: it excludes it, so the file runs once per pull request", () => {
    const dirStep = lines.findIndex((l) => l === "      - name: Repo-root scripts tests (real Postgres)");
    expect(dirStep, "the Repo-root scripts tests step").toBeGreaterThan(0);
    const run = lines.slice(dirStep + 1).find((l) => l.startsWith("        run: "));
    expect(run, "its run line").toBeDefined();
    expect(run).toContain("scripts/__tests__");
    expect(run, "excludes the root rules checker").toContain(`--exclude '**/${ROOT_FILE}'`);
    // the exclusion is exact: nothing else under scripts/__tests__ is left out of that run
    expect(run!.match(/--exclude/g)).toHaveLength(1);
    // ...and the file still has its own step (else it would run in neither)
    expect(lines.filter((l) => l === ROOT_HEAD)).toHaveLength(1);
  });

  it("the root step is the engine step with its own file and report, name-and-run only, and the same judge byte for byte", () => {
    const engineScript = scriptAt(at).join("\n");
    const derived = engineScript
      .replaceAll(ENGINE_FILE, ROOT_FILE)
      .replaceAll("vitest-results-rules.json", ROOT_REPORT)
      .replaceAll("rules reference", "root rules reference");
    expect(derived, "the substitution changed the engine step's text").not.toBe(engineScript);
    expect(scriptAt(rootAt).join("\n")).toBe(derived);
    expect(bodyAt(rootAt).filter((l) => /^ {8}[a-z-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ""))).toEqual(["run"]);
    expect(scriptAt(rootAt).join("\n")).not.toMatch(/\bjq\b/);
  });
});
