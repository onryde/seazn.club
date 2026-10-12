import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { ID, REPO, ROW_HEADER, RULES_DIR, STATUS, allRows, fileExists, hasToken, isMatrixCase, parseRuleRows, proofProblems, readRepoFile, ruleFiles, testTitles, type ReadRepoFile, type RuleRow } from "./rules-reference.ts";

/** Signed rows whose proving test lands in a later W2a task. A task that adds
 *  the proof deletes its id here in the same commit; Task 16 Step 5 requires
 *  this map to be EMPTY. A row not named here must already be proved. */
const AWAITING_PROOF: ReadonlyMap<string, string> = new Map([]);

/** The ten ids W2a seeds, typed from spec §6 (2026-10-08-format-matrix-w2a-design.md, "W2a seeds only"). */
const SEEDED = ["X-BR-1", "X-BR-2", "X-ST-1", "X-ST-2", "X-DR-1", "BG-KO-1", "BG-KO-2", "CA-KO-1", "GN-KO-1", "CK-KO-1"];

const W2B_DATE = "2026-10-08";
const signed = (ruling: number, date = W2B_DATE) => `signed ${ruling} ${date}`;
const deviation = (ruling: number) => `deviation ${ruling} ${W2B_DATE}`;
/** Orchestrator pre-flight rulings are no owner signature (AGENTS.md class 17): their rows stay open until the owner signs. */
const OPEN = "⬜ open";
/** The rows W2b adds, by rules file, each with the status it must carry. Typed from spec
 *  2026-10-08-format-matrix-w2b-design.md §6 and Appendix A — the spec is the source here, never the parsed files — as the
 *  W2b ledger's rulings amend it (plan PF-13: "53 new ids + CK-WO-2 + X-WD-6, plus the X-BR-1 amendment"):
 *  - Appendix A's 53 new ids, with Appendix A's status (`signed <ruling>` from _INDEX rulings 83–99; BD-WO-2 and BD-RT-1
 *    are recorded deviations);
 *  - CK-WO-2 (plan PF-6): an orchestrator ruling the ledger reports to the owner, so OPEN; X-WD-6 (plan PF-7) was the same
 *    until owner ruling 113 (2026-10-11) settled its wording ("Amends X-RS-1, X-RT-1 and X-WD-6"), so it carries 113;
 *  - X-WO-1 and VB-RT-1 carry owner ruling 108 (2026-10-11), which changed their text: a credited result pays the table
 *    points of its credited score (a volleyball side at fault at two sets all takes the 3-2 loss's point);
 *  - X-RS-1 carries owner ruling 113 (2026-10-11), which changed its text after ruling 112 (a walkover stays
 *    recordable after the start until something is played): nothing played means not started, for every reason, and a
 *    retirement waits for play; ruling 114 keeps 112's "played" (any sport event, scoring or not). X-RT-1 carried 113 too;
 *  - X-RT-1, X-PS-1 and X-PS-2 carry owner ruling 115 (2026-10-12), which changed their text ("Amends X-PS-1, X-PS-2
 *    and X-RT-1"): a disqualification with nothing played is treated like a walkover — its credit, and no match in
 *    players' stats. Appendix A carries the same text, so none of the three is in AMENDED_TEXT;
 *  - HK-AB-1 and IH-AB-1 carry owner ruling 117 (2026-10-12), which confirmed R16-3 and qualifies them: where the cfg
 *    refuses a draw, a level abandon is accepted with no result (X-AB-1). Appendix A carries the same text. FB-AB-1 keeps
 *    its text: football takes a draw in every draw kind (football.ts `supportsDraws`), so no football cfg reaches it;
 *  - X-PS-2 and X-AB-1 carry owner ruling 120 (2026-10-12), which amends them ("X-PS-2 and X-AB-1, the stats clause
 *    only"): an abandon counts as a match in players' stats only if something was played before it. Appendix A carries
 *    the same text, so neither is in AMENDED_TEXT. */
const W2B_ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cross-sport.md": {
    "X-RS-1": signed(118, "2026-10-12"), "X-RS-2": signed(83), "X-RS-3": signed(83),
    "X-DW-1": signed(84), "X-DW-2": signed(84), "X-DW-3": signed(84), "X-DW-4": signed(85),
    "X-WO-1": signed(108, "2026-10-11"), "X-RT-1": signed(118, "2026-10-12"),
    "X-AB-1": signed(120, "2026-10-12"), "X-AB-2": signed(88), "X-AB-3": signed(88), "X-AB-4": signed(89),
    "X-WD-1": signed(90), "X-WD-2": signed(90), "X-WD-3": signed(90), "X-WD-4": signed(90),
    "X-PS-1": signed(115, "2026-10-12"), "X-PS-2": signed(120, "2026-10-12"), "X-DE-1": signed(93), "X-WD-5": signed(90),
    "X-BL-1": signed(98, "2026-10-09"), "X-WD-6": signed(113, "2026-10-11"),
  },
  "football.md": { "FB-WO-1": signed(86), "FB-RT-1": signed(87), "FB-AB-1": signed(88) },
  "hockey.md": { "HK-WO-1": signed(86), "HK-RT-1": signed(87), "HK-AB-1": signed(117, "2026-10-12") },
  "icehockey.md": { "IH-WO-1": signed(86), "IH-RT-1": signed(87), "IH-AB-1": signed(117, "2026-10-12") },
  "volleyball.md": { "VB-WO-1": signed(86), "VB-RT-1": signed(108, "2026-10-11") },
  "tabletennis.md": { "TT-WO-1": signed(86), "TT-RT-1": signed(87) },
  "tennis.md": { "TN-WO-1": signed(86), "TN-RT-1": signed(87) },
  "badminton.md": { "BD-WO-1": signed(86), "BD-WO-2": deviation(86), "BD-RT-1": deviation(87) },
  "cricket.md": { "CK-WO-1": signed(86), "CK-AB-1": signed(88), "CK-AB-2": signed(88), "CK-WO-2": OPEN },
  "boardgame.md": { "BG-WO-1": signed(86), "BG-DW-1": signed(84), "BG-WO-2": signed(90), "BG-WO-3": signed(99, "2026-10-09") },
  "carrom.md": { "CA-WO-1": signed(86), "CA-RT-1": signed(87), "CA-AB-1": signed(88) },
  "generic.md": { "GN-WO-1": signed(86), "GN-RT-1": signed(87), "GN-AB-1": signed(88) },
};
/** Appendix A's own per-file count ("54 rows: cross-sport.md 23, football.md 3, …"), less the X-BR-1 amendment it counts
 *  in cross-sport, plus PF-7's X-WD-6 (cross-sport) and PF-6's CK-WO-2 (cricket). Pins W2B_ROWS against a dropped entry. */
const W2B_PER_FILE: Readonly<Record<string, number>> = {
  "cross-sport.md": 23 - 1 + 1, "football.md": 3, "hockey.md": 3, "icehockey.md": 3, "volleyball.md": 2, "tabletennis.md": 2,
  "tennis.md": 2, "badminton.md": 3, "cricket.md": 3 + 1, "boardgame.md": 4, "carrom.md": 3, "generic.md": 3,
};
/** X-BR-1, amended by owner ruling 84 (W2b-R2): "decided only by a win" → "decided only by a win or a double walkover".
 *  W2b's proof of the amended text sits beside W2a's (plan, Task 7: "added to X-BR-1's proved by"). */
const X_BR_1 = {
  says: "decided only by a win or a double walkover",
  saidBefore: "decided only by a win (",
  status: signed(84),
  proof: "apps/web/src/server/engine-db/__tests__/double-walkover-seating.test.ts",
} as const;
const w2bIds = (): string[] => Object.values(W2B_ROWS).flatMap((ids) => Object.keys(ids));

/** A row's test paths (matrix cases excluded). */
const testPaths = (r: RuleRow): number => r.provedBy.filter((p) => !isMatrixCase(p)).length;

/** Everything the parsed rows owe W2b, as data: each pinned id present, in its file, with its status; X-BR-1 amended. */
function w2bProblems(rows: readonly RuleRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [file, ids] of Object.entries(W2B_ROWS)) {
    for (const [id, status] of Object.entries(ids)) {
      const r = byId.get(id);
      if (r === undefined) { out.push(`${id}: missing (owed in ${file})`); continue; }
      if (r.file !== file) out.push(`${id}: in ${r.file}, not ${file}`);
      if (r.status !== status) out.push(`${id}: status "${r.status}", not "${status}"`);
    }
  }
  const br = byId.get("X-BR-1");
  if (br === undefined) return [...out, "X-BR-1: missing"];
  if (!br.rule.includes(X_BR_1.says) || br.rule.includes(X_BR_1.saidBefore)) out.push(`X-BR-1: the rule does not say "${X_BR_1.says}": ${br.rule}`);
  if (br.status !== X_BR_1.status) out.push(`X-BR-1: status "${br.status}", not "${X_BR_1.status}"`);
  if (!br.provedBy.includes(X_BR_1.proof)) out.push(`X-BR-1: proved by does not name ${X_BR_1.proof}`);
  return out;
}

/** The approved W2b spec. Its Appendix A is the W2b rows' written source, read at test time (review M-2), so a row whose
 *  text drifts from the spec — "3-0" becoming "5-0" — is a failure, and a spec amendment moves the pin with it. */
const W2B_SPEC = join(REPO, "docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md");
/** "### `cricket.md`", or "### `football.md (new)`" for a file W2b creates. */
const APPENDIX_SECTION = /^### `([a-z-]+\.md)(?: \(new\))?`/;
interface AppendixA {
  /** Each row's id, rule text and the rules file its `### \`<file>.md\`` subsection names. */
  readonly rows: readonly { id: string; rule: string; file: string }[];
  /** Row-shaped lines whose id cell is not an id: "X-BR-1 (amend)". */
  readonly amendments: readonly string[];
  /** The total the appendix states of itself ("54 rows: …"). */
  readonly stated: number;
}
/** Appendix A of the W2b spec, from its heading to the next `## ` heading. A row outside a file subsection, a row that is
 *  not 6 cells, a missing stated total and an appendix with no row are refusals, never an empty answer. */
function readAppendixA(text: string): AppendixA {
  const at = text.indexOf("\n## Appendix A");
  if (at < 0) throw new Error('W2b spec: no "## Appendix A" section');
  const lines = text.slice(at + 1).split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
  const body = end < 0 ? lines : lines.slice(0, end);
  const stated = /^(\d+) rows: /m.exec(body.join("\n"));
  if (stated?.[1] === undefined) throw new Error('W2b spec: Appendix A no longer states its own total ("N rows: …")');
  let file: string | undefined;
  const rows: { id: string; rule: string; file: string }[] = [];
  const amendments: string[] = [];
  for (const line of body) {
    const h = APPENDIX_SECTION.exec(line);
    if (h?.[1] !== undefined) { file = h[1]; continue; }
    if (!line.startsWith("| ")) continue; // prose, and the |---| separator
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    if (cells[0] === "id") continue; // the header
    if (cells.length !== 6) throw new Error(`W2b spec: an Appendix A row has ${cells.length} cells, not 6: ${line.slice(0, 48)}`);
    const [id, rule] = cells as [string, string];
    if (!ID.test(id)) { amendments.push(id); continue; }
    if (file === undefined) throw new Error(`W2b spec: Appendix A row ${id} sits before any \`<file>.md\` subsection`);
    rows.push({ id, rule, file });
  }
  if (rows.length === 0) throw new Error("W2b spec: no row parsed from Appendix A");
  return { rows, amendments, stated: Number(stated[1]) };
}
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
    says: "Walkover and retirement credit is derived from the stage's own cfg (best-of, target score, overs), and the same credited score is used in the table, tie-breaks, the public page and the qualification view; a credited result pays the table points of its credited score, the offender's side included (a bye keeps the clean-sweep pair).",
    by: "owner ruling 108 (2026-10-11): a credited result pays the table points of its credited score",
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

/** In-memory files for synthetic rows: no synthetic row borrows a real file as its proof. Every path is repo-relative. */
const PROVES_TS = "apps/web/src/server/__tests__/proves.test.ts";
const PROVES_SPEC = "apps/web/e2e/proves.spec.ts";
const PROVES_TSX = "apps/web/src/components/__tests__/proves.test.tsx";
const NEAR_MISS = "apps/web/src/server/__tests__/near-miss.test.ts";
const COMMENT_ONLY = "apps/web/src/server/__tests__/comment-only.test.ts";
const BODY_STRING = "apps/web/src/server/__tests__/body-string.test.ts";
const DB_GATED = "apps/web/src/server/__tests__/db-gated.test.ts";
const GATED_GROUP = "apps/web/src/server/__tests__/gated-group.test.ts";
const SKIPPED_GROUP = "apps/web/src/server/__tests__/skipped-group.test.ts";
const SERIAL_SPEC = "apps/web/e2e/serial.spec.ts";
const WOULD_PROVE = 'it("X-ZZ-1: would prove, if its location counted", () => {});';
/** Locations that must be refused even though each file holds a proving title. */
const REFUSED_LOCATIONS: Array<[string, string]> = [
  ["packages/engine/rules/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["docs/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["packages/engine/test/rules-reference.test.ts", "is the checker itself, which holds every id as data"],
  ["packages/engine/test/rules-reference.ts", "is the checker itself, which holds every id as data"],
  ["apps/web/src/server/helper.ts", "is not a test file (*.test.ts, *.test.tsx or *.spec.ts)"],
  ["apps/web/src/server/notes.md", "is not a test file (*.test.ts, *.test.tsx or *.spec.ts)"],
  ["./apps/web/src/server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["apps/web/src/other/../server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["/apps/web/src/server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["../elsewhere/proves.test.ts", "is not a normalised repo-relative path"],
];
const FIXTURES = new Map<string, string>([
  [PROVES_TS, 'it("X-ZZ-1: proves it", () => {});'],
  [PROVES_SPEC, 'test("X-ZZ-1: proves it in the browser", async () => {});'],
  [PROVES_TSX, 'describe("X-ZZ-1 group", () => {});'],
  [COMMENT_ONLY, '// it("X-ZZ-1: only a comment", () => {});\nit("unrelated", () => {});'],
  [BODY_STRING, 'it("unrelated", () => { expect("X-ZZ-1").toBe("X-ZZ-1"); });'],
  [NEAR_MISS, 'it("X-ZZ-10: a different rule", () => {});'],
  // The shapes later W2a proofs are written in: DB-gated unit tests and serial Playwright groups (re-review M-2).
  [DB_GATED, 'it.skipIf(!HAS_DB)("X-ZZ-1: needs a database", async () => {});'],
  [GATED_GROUP, 'describe.skipIf(!HAS_DB)("db group", () => { it("X-ZZ-1: inside a gated group", () => {}); });'],
  [SERIAL_SPEC, 'test.describe.serial("X-ZZ-1 walkthrough", () => { test("step one", async () => {}); });'],
  // An unconditional skip proves nothing, and neither does anything inside it (re-review M-1).
  [SKIPPED_GROUP, 'describe.skip("db group", () => { it("X-ZZ-1: inside a skipped group", () => {}); });'],
  ...REFUSED_LOCATIONS.map(([p]): [string, string] => [p, WOULD_PROVE]),
]);
const read: ReadRepoFile = (p) => FIXTURES.get(p);
const row = (provedBy: string[]): RuleRow => ({ id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy, file: "synthetic.md" });
const noTitle = (p: string) => `X-ZZ-1: ${p} has no it/test/describe title naming "X-ZZ-1"`;

describe("rules reference (ruling 75, spec §6)", () => {
  it("empty case first: a file with no rule table parses to no rows", () => {
    expect(parseRuleRows("# nothing here\n", "empty.md")).toEqual([]);
  });

  it("parses at least one row from every rule file, and zero rows overall is a failure", () => {
    const files = ruleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f).length, f).toBeGreaterThan(0);
    expect(allRows().length).toBeGreaterThan(0);
  });

  it("the ten ids W2a seeds are all present: the expectation is spec §6's list, not the parsed files", () => {
    expect(SEEDED).toHaveLength(10);
    const have = new Set(allRows().map((r) => r.id));
    expect(SEEDED.filter((id) => !have.has(id))).toEqual([]);
  });

  it("every id is well-formed and unique across all files", () => {
    const rows = allRows();
    const seen = new Map<string, string>();
    for (const r of rows) {
      expect(r.id, `${r.file}: ${r.id}`).toMatch(ID);
      expect(seen.get(r.id), `${r.id} in ${r.file} and ${seen.get(r.id)}`).toBeUndefined();
      seen.set(r.id, r.file);
    }
    expect(seen.size).toBe(rows.length);
  });

  it("every status is signed <ruling> <date>, deviation <ruling> <date> or ⬜ open", () => {
    const rows = allRows();
    for (const r of rows) expect(r.status, r.id).toMatch(STATUS);
    expect(rows.length).toBeGreaterThan(0);
    // The three forms and near-misses of each (synthetic: at Task 2 no real row is a deviation or open).
    let accepted = 0;
    for (const ok of ["signed 73 2026-10-08", "deviation 5 2026-10-08", "⬜ open"]) { expect(ok, ok).toMatch(STATUS); accepted++; }
    expect(accepted).toBe(3);
    let refused = 0;
    for (const bad of ["signed 73 08-10-2026", "signed 2026-10-08", "deviation 2026-10-08", "signed 73 2026-10-08 extra", "prefix signed 73 2026-10-08", "open", "⬜ open "]) { expect(bad, bad).not.toMatch(STATUS); refused++; }
    expect(refused).toBe(7);
  });

  it("every signed or deviation row names a proving test that exists and contains the id (or awaits proof by name)", () => {
    let checked = 0;
    for (const r of allRows()) {
      if (r.status.startsWith("⬜")) continue;
      if (AWAITING_PROOF.has(r.id)) {
        expect(r.provedBy, `${r.id} awaits ${AWAITING_PROOF.get(r.id)} and must not claim proof yet`).toEqual([]);
        checked++;
        continue;
      }
      expect(proofProblems(r), r.id).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the proof checks catch a row with no test, a missing file and a file that does not name the id (synthetic signed rows)", () => {
    expect(proofProblems(row([]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["apps/web/src/server/__tests__/no-such.test.ts"]), read)).toEqual(["X-ZZ-1: apps/web/src/server/__tests__/no-such.test.ts does not exist"]);
    expect(proofProblems(row([BODY_STRING]), read)).toEqual([noTitle(BODY_STRING)]);
    expect(proofProblems(row([PROVES_TS]), read)).toEqual([]); // the positive pair: an in-memory file whose title names the id
  });

  it("the default reader reads the real repo: a missing file is undefined, any other failure is loud, and proofProblems uses it when none is injected", () => {
    expect(readRepoFile("packages/engine/rules/carrom.md")).toContain("CA-KO-1");
    expect(readRepoFile("packages/engine/rules/no-such.md")).toBeUndefined();
    expect(() => readRepoFile("packages/engine/rules")).toThrow(/EISDIR/);
    expect(proofProblems(row(["apps/web/src/no-such-file.test.ts"]))).toEqual(["X-ZZ-1: apps/web/src/no-such-file.test.ts does not exist"]);
    // A REAL test file, read through the default reader: it exists, and none of its titles names the synthetic id.
    const real = "packages/engine/test/source-bytes.test.ts";
    expect(proofProblems(row([real]))).toEqual([noTitle(real)]);
  });

  it("a matrix: entry is additional evidence only: skipped beside a real proving test, and a matrix-only row names no proving test (synthetic signed rows)", () => {
    expect(proofProblems(row([PROVES_TS, "matrix:SC-O1"]), read)).toEqual([]);
    expect(proofProblems(row(["matrix:SC-O1"]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["matrix:SC-O1", "matrix:SC-O2"]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(isMatrixCase("matrix:SC-O1")).toBe(true);
    expect(isMatrixCase(PROVES_TS)).toBe(false); // the negative pair
  });

  it("a proof path must be a normalised repo-relative test file outside packages/engine/rules/, docs/ and the checker itself (synthetic signed rows)", () => {
    let checked = 0;
    for (const [p, why] of REFUSED_LOCATIONS) {
      expect(proofProblems(row([p]), read), p).toEqual([`X-ZZ-1: ${p} ${why}`]);
      checked++;
    }
    expect(checked).toBe(10);
    // The positive pairs: a test file, a spec file and a .tsx test file elsewhere in the repo are all accepted.
    for (const ok of [PROVES_TS, PROVES_SPEC, PROVES_TSX]) expect(proofProblems(row([ok]), read), ok).toEqual([]);
  });

  it("test titles are the first string argument of it/test/describe/test.describe calls: not a comment, a body string, a second argument, a skipped or generated test", () => {
    const source = [
      '// it("X-ZZ-1: in a line comment", () => {});',
      '/* test("X-ZZ-1: in a block comment", () => {}); */',
      'const note = "X-ZZ-1 in a plain string";',
      'describe("outer X-ZZ-1 suite", () => {',
      '  it("X-ZZ-1: nested title", () => { const inner = "X-ZZ-1 body string"; });',
      '  it.skip("X-ZZ-1: skipped", () => {});',
      '  it.each([1])("X-ZZ-1: generated", () => {});',
      "});",
      "test(`X-ZZ-1: template`, () => {});",
      'test.describe("pw X-ZZ-1 group", () => {});',
      'test.skip("X-ZZ-1: pw skipped", () => {});',
      'it("a title", "X-ZZ-1 second argument");',
      "it(TITLE, () => {});",
      'other("X-ZZ-1: not a test call");',
    ].join("\n");
    expect(testTitles("a.test.ts", source)).toEqual(["outer X-ZZ-1 suite", "X-ZZ-1: nested title", "X-ZZ-1: template", "pw X-ZZ-1 group", "a title"]);
    expect(testTitles("b.test.tsx", 'const view = () => <div>{1}</div>;\nit("X-ZZ-1: after jsx", () => {});')).toEqual(["X-ZZ-1: after jsx"]);
    expect(testTitles("c.test.ts", "")).toEqual([]); // the empty case
  });

  it("a conditional skip and a Playwright describe mode carry a title; an unconditional skip, todo or fixme neither yields one nor is entered (re-review M-1, M-2)", () => {
    const source = [
      'it.skipIf(!HAS_DB)("X-ZZ-1: db gated", () => {});',
      'it.runIf(HAS_DB)("X-ZZ-1: db only", () => {});',
      'test.skipIf(browserName === "webkit")("X-ZZ-1: not on webkit", async () => {});',
      'test.runIf(isCi)("X-ZZ-1: only in ci", async () => {});',
      'describe.skipIf(!HAS_DB)("X-ZZ-1 gated group", () => { it("X-ZZ-1: inside gated", () => {}); });',
      'describe.runIf(HAS_DB)("X-ZZ-1 run group", () => {});',
      'test.describe.serial("X-ZZ-1 serial group", () => { test("X-ZZ-1: in serial", async () => {}); });',
      'test.describe.parallel("X-ZZ-1 parallel group", () => {});',
      // None of the following is a proof, and nothing inside any of them is either.
      'describe.skip("X-ZZ-1 skipped group", () => { it("X-ZZ-1: in skipped group", () => {}); });',
      'describe.todo("X-ZZ-1 todo group", () => { it("X-ZZ-1: in todo group", () => {}); });',
      'it.skip("X-ZZ-1: skipped", () => {});',
      'it.todo("X-ZZ-1: todo");',
      'test.fixme("X-ZZ-1: fixme", async () => {});',
      'test.describe.skip("X-ZZ-1 pw skipped group", () => { test("X-ZZ-1: in pw skipped", async () => {}); });',
      'test.describe.fixme("X-ZZ-1 pw fixme group", () => { test("X-ZZ-1: in pw fixme", async () => {}); });',
      'describe.skip.each([1])("X-ZZ-1 skipped each", () => { it("X-ZZ-1: in skipped each", () => {}); });',
      // Wrong shapes are not title-bearing calls, whatever their names.
      'it.skipIf("X-ZZ-1: gate used as the test", () => {});',
      'it(HAS_DB)("X-ZZ-1: a call, not a gate", () => {});',
      'other.skipIf(c)("X-ZZ-1: not a test root", () => {});',
      // A skip that is not a test's skip hides nothing: its body is still read.
      'unrelated.skip(() => { it("X-ZZ-1: beside a skip that is not a test skip", () => {}); });',
      'test.describe.configure({ mode: "serial" });',
    ].join("\n");
    const titles = testTitles("gated.test.ts", source);
    expect(titles).toEqual([
      "X-ZZ-1: db gated", "X-ZZ-1: db only", "X-ZZ-1: not on webkit", "X-ZZ-1: only in ci",
      "X-ZZ-1 gated group", "X-ZZ-1: inside gated", "X-ZZ-1 run group",
      "X-ZZ-1 serial group", "X-ZZ-1: in serial", "X-ZZ-1 parallel group", "X-ZZ-1: beside a skip that is not a test skip",
    ]);
    expect(titles).toHaveLength(11); // anti-vacuity: eleven titles read, not an empty list that happens to agree
  });

  it("a DB-gated or serial proof counts; the same id inside an unconditional skip is refused, and inside a conditional one is accepted (probe pin, synthetic signed rows)", () => {
    for (const ok of [DB_GATED, GATED_GROUP, SERIAL_SPEC]) expect(proofProblems(row([ok]), read), ok).toEqual([]);
    expect(proofProblems(row([SKIPPED_GROUP]), read)).toEqual([noTitle(SKIPPED_GROUP)]);
    // The pair that differs in one word: skip vs skipIf around the same body.
    const body = (wrap: string) => `${wrap}("db group", () => { it("X-ZZ-1: inside", () => {}); });`;
    expect(testTitles("p.test.ts", body("describe.skip"))).toEqual([]);
    expect(testTitles("p.test.ts", body("describe.skipIf(!HAS_DB)"))).toEqual(["db group", "X-ZZ-1: inside"]);
  });

  it("the title memo (M-3) keys on the source, not just the path: one path, two sources, back again; a caller's edit never reaches the memo", () => {
    const path = "memo.test.ts";
    const a = 'it("X-ZZ-1: first source", () => {});';
    const b = 'it("X-ZZ-2: second source", () => {});';
    const seen: string[][] = [];
    for (const source of [a, b, a, a]) seen.push(testTitles(path, source));
    expect(seen).toEqual([["X-ZZ-1: first source"], ["X-ZZ-2: second source"], ["X-ZZ-1: first source"], ["X-ZZ-1: first source"]]);
    // The list handed out is the caller's own: pushing into it must not change the next answer for the same source.
    seen[3]!.push("X-ZZ-9: smuggled");
    expect(testTitles(path, a)).toEqual(["X-ZZ-1: first source"]);
  });

  it("an id must be a whole token in the title: a longer id, a prefix or a suffix is a near-miss, not a proof (synthetic titles)", () => {
    const cases: Array<[string, boolean]> = [
      ["X-ZZ-1: a title", true], ["(X-ZZ-1)", true], ["X-ZZ-1", true], ["covers X-ZZ-1.", true],
      ["X-ZZ-10: another rule", false], ["X-ZZ-1-b", false], ["AX-ZZ-1", false], ["R-X-ZZ-1", false], ["1X-ZZ-1", false], ["X-ZZ-1a", false], ["X-ZZ-2", false],
    ];
    for (const [title, want] of cases) expect(hasToken(title, "X-ZZ-1"), title).toBe(want);
    expect(cases).toHaveLength(11);
    // End to end through a file: X-ZZ-1 against a file holding only X-ZZ-10 is refused, X-ZZ-10 against it is not.
    expect(proofProblems(row([NEAR_MISS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems({ ...row([NEAR_MISS]), id: "X-ZZ-10" }, read)).toEqual([]);
    expect(proofProblems(row([COMMENT_ONLY]), read)).toEqual([noTitle(COMMENT_ONLY)]);
  });

  it("every listed test path must prove the id, not just one of them (synthetic signed rows)", () => {
    const missing = "apps/web/src/server/__tests__/no-such.test.ts";
    expect(proofProblems(row([PROVES_TS, NEAR_MISS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems(row([NEAR_MISS, PROVES_TS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems(row([PROVES_TS, missing]), read)).toEqual([`X-ZZ-1: ${missing} does not exist`]);
    expect(proofProblems(row([PROVES_TS, PROVES_SPEC, PROVES_TSX]), read)).toEqual([]); // the positive pair: all three prove it
  });

  it("the parser refuses a row that is not 6 cells, and ID refuses a malformed id (synthetic inputs)", () => {
    expect(() => parseRuleRows(`${ROW_HEADER}\n|---|---|---|---|---|---|\n| X-ZZ-1 | rule | cite | ⬜ open | — |\n`, "bad.md")).toThrow(/5 cells, not 6/);
    let checked = 0;
    for (const bad of ["x-br-1", "XBR-1", "X-BR-", "ABCD-BR-1"]) { expect(bad, bad).not.toMatch(ID); checked++; }
    expect(checked).toBe(4);
    expect("X-BR-1").toMatch(ID); // the positive pair
  });

  it("a row's path cells split on <br>, strip backticks and read — as none, and prose after the table is not a row (synthetic input)", () => {
    const text = [
      ROW_HEADER,
      "|---|---|---|---|---|---|",
      "| X-ZZ-1 | r | c | signed 1 2026-10-08 | `a/one.ts`<br>`b/two.ts` | `c/three.test.ts` |",
      "| X-ZZ-2 | r | c | ⬜ open | — | — |",
      "",
      "Notes after the table are prose, not rows.",
    ].join("\n");
    const rows = parseRuleRows(text, "synthetic.md");
    expect(rows.map((r) => r.id)).toEqual(["X-ZZ-1", "X-ZZ-2"]);
    expect(rows[0]).toMatchObject({ enforcedAt: ["a/one.ts", "b/two.ts"], provedBy: ["c/three.test.ts"], file: "synthetic.md" });
    expect(rows[1]).toMatchObject({ enforcedAt: [], provedBy: [] });
  });

  it("a row-shaped line the parser did not read is a failure: a row after prose, a second table, or no table header (synthetic inputs)", () => {
    const head = [ROW_HEADER, "|---|---|---|---|---|---|", "| X-ZZ-1 | r | c | ⬜ open | — | — |"];
    // lines 1-3 are the table, 4 is blank, 5 is prose, 6 is a row after it: the table ended at the blank line
    const afterProse = [...head, "", "prose between", "| X-ZZ-3 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(afterProse, "skip.md")).toThrow(/skip\.md: 1 row-shaped line\(s\) not read as rows.*line 6: \| X-ZZ-3 \|/);
    const secondTable = [...head, "", ROW_HEADER, "|---|---|---|---|---|---|", "| X-ZZ-4 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(secondTable, "two.md")).toThrow(/two\.md: 1 row-shaped line\(s\) not read as rows.*line 7: \| X-ZZ-4 \|/);
    const noHeader = ["# A file whose header was mistyped", "", "| X-ZZ-5 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(noHeader, "nohead.md")).toThrow(/nohead\.md: 1 row-shaped line\(s\) not read as rows.*line 3: \| X-ZZ-5 \|/);
    // The positive pairs: the same rows in one table all read; a malformed id inside the table is read (ID reports it), not skipped.
    expect(parseRuleRows([...head, "| X-ZZ-3 | r | c | ⬜ open | — | — |"].join("\n"), "ok.md").map((r) => r.id)).toEqual(["X-ZZ-1", "X-ZZ-3"]);
    expect(parseRuleRows([...head, "| x-zz-9 | r | c | ⬜ open | — | — |"].join("\n"), "bad-id.md").map((r) => r.id)).toEqual(["X-ZZ-1", "x-zz-9"]);
  });

  it("every AWAITING_PROOF id is a real signed row (a stale entry is a failure)", () => {
    const signed = new Set(allRows().filter((r) => !r.status.startsWith("⬜")).map((r) => r.id));
    for (const id of AWAITING_PROOF.keys()) expect(signed.has(id), id).toBe(true);
  });

  it("every enforced-at path exists", () => {
    let checked = 0;
    for (const r of allRows()) for (const p of r.enforcedAt) { expect(fileExists(p), `${r.id}: ${p}`).toBe(true); checked++; }
    expect(checked).toBeGreaterThan(0);
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

  it("W2b: the 55 new ids (Appendix A's 53, plus CK-WO-2 and X-WD-6) are present, each in its file and signed or deviation with its ruling number from Appendix A (108, 113, 115 or 118 where that ruling changed the text; PF-6 open), and X-BR-1's text says 'a win or a double walkover'", () => {
    const ids = w2bIds();
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55); // no id pinned twice
    expect(ids.filter((id) => SEEDED.includes(id))).toEqual([]); // spec §6: new and unique against the W2a seed
    for (const [file, n] of Object.entries(W2B_PER_FILE)) expect(Object.keys(W2B_ROWS[file] ?? {}), file).toHaveLength(n);
    expect(Object.keys(W2B_ROWS).sort()).toEqual(Object.keys(W2B_PER_FILE).sort());
    expect(Object.values(W2B_PER_FILE).reduce((a, b) => a + b, 0)).toBe(55);
    // Appendix A's 53 are signed or deviation, and so is X-WD-6 since ruling 113; only PF-6's CK-WO-2 is open.
    const open = Object.values(W2B_ROWS).flatMap((ids) => Object.entries(ids)).filter(([, s]) => s === OPEN).map(([id]) => id);
    expect(open.sort()).toEqual(["CK-WO-2"]);
    expect(w2bProblems(allRows())).toEqual([]);
  });

  it("the W2b pin sees a dropped row, a row in the wrong file, a wrong status and X-BR-1's old text (synthetic edits of the real rows)", () => {
    const rows = allRows();
    const edit = (id: string, patch: Partial<RuleRow>) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    expect(w2bProblems(rows.filter((r) => r.id !== "HK-WO-1"))).toEqual(["HK-WO-1: missing (owed in hockey.md)"]);
    expect(w2bProblems(edit("CK-AB-2", { file: "cross-sport.md" }))).toEqual(["CK-AB-2: in cross-sport.md, not cricket.md"]);
    expect(w2bProblems(edit("X-WO-1", { status: signed(86) }))).toEqual([`X-WO-1: status "${signed(86)}", not "${signed(108, "2026-10-11")}"`]);
    const br = rows.find((r) => r.id === "X-BR-1");
    expect(br).toBeDefined();
    const old = (br?.rule ?? "").replace(X_BR_1.says, "decided only by a win");
    expect(w2bProblems(edit("X-BR-1", { rule: old }))).toHaveLength(1);
    expect(w2bProblems(edit("X-BR-1", { provedBy: ["apps/web/src/server/engine-db/__tests__/settle-seating.test.ts"] }))).toHaveLength(1);
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

  it("Appendix A's reader refuses no section, no stated total, a row before any file subsection, a 5-cell row and a table with no row; a new file's \"(new)\" heading counts and the next ## heading ends it (synthetic spec text)", () => {
    const head = "\n## Appendix A — rows\n\n1 rows: x.md 1.\n\n";
    const table = "| id | rule | citation | status | enforced at | proved by |\n|---|---|---|---|---|---|\n";
    expect(() => readAppendixA("# a spec\n")).toThrow(/no "## Appendix A" section/);
    expect(() => readAppendixA("\n## Appendix A\n\n### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — | — |\n")).toThrow(/states its own total/);
    expect(() => readAppendixA(head + table + "| X-ZZ-1 | r | c | s | — | — |\n")).toThrow(/X-ZZ-1 sits before any/);
    expect(() => readAppendixA(head + "### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — |\n")).toThrow(/5 cells, not 6/);
    expect(() => readAppendixA(head + "### `x.md`\n" + table)).toThrow(/no row parsed/);
    // The positive pair: one row read, and a row under the next ## heading is not Appendix A's.
    const next = "## Appendix B\n\n### `y.md`\n" + table + "| X-ZZ-2 | r2 | c | s | — | — |\n";
    const two = "### `z.md (new)`\n" + table + "| X-ZZ-3 | r3 | c | s | — | — |\n";
    expect(readAppendixA(head + "### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — | — |\n| X-ZZ-1 (amend) | a | c | s | — | — |\n" + two + next)).toEqual({
      rows: [{ id: "X-ZZ-1", rule: "r", file: "x.md" }, { id: "X-ZZ-3", rule: "r3", file: "z.md" }],
      amendments: ["X-ZZ-1 (amend)"],
      stated: 1,
    });
  });

  it("every W2b row names a proving test and an enforcement site, and the open row's proofs prove it too, so no listed proof is unchecked evidence (the signed rows' are proved by the check above)", () => {
    const byId = new Map(allRows().map((r) => [r.id, r]));
    let named = 0;
    let openProved = 0;
    for (const id of [...w2bIds(), "X-BR-1"]) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      if (r === undefined) continue;
      expect(testPaths(r), `${id} lists no proving test`).toBeGreaterThan(0);
      expect(r.enforcedAt.length, `${id} names no enforcement site`).toBeGreaterThan(0);
      named++;
      if (r.status !== OPEN) continue;
      expect(proofProblems(r), id).toEqual([]);
      openProved++;
    }
    expect(named).toBe(56);
    expect(openProved).toBe(1);
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

  it("one step, in the gates job, named for the checker", () => {
    expect(lines.filter((l) => l === HEAD)).toHaveLength(1);
    expect(at).toBeGreaterThan(0);
    const jobHead = lines.slice(0, at).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();
    expect(jobHead).toBe("  gates:");
  });

  it("nothing narrows it: the workflow triggers on every pull request, the job has no condition, the step is only a name and a run block", () => {
    const onAt = lines.indexOf("on:");
    const afterOn = lines.findIndex((l, i) => i > onAt && /^[a-z]/.test(l));
    expect(onAt).toBeGreaterThanOrEqual(0);
    expect(lines.slice(onAt + 1, afterOn).filter(code)).toEqual(["  pull_request:"]); // no paths:, paths-ignore: or branches: under it
    const gates = lines.indexOf("  gates:");
    const steps = lines.indexOf("    steps:", gates);
    expect(lines.slice(gates + 1, steps).filter(code)).toEqual(["    name: Typecheck + lint + drift gates", "    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}"]);
    expect(stepLines().filter((l) => /^ {8}[a-z-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ""))).toEqual(["run"]);
  });

  it("the step runs only this file with the JSON reporter, clears any stale report first, and ends in a node judge (no jq)", () => {
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

  it("the judge is green on a clean single-file pass and red, naming its reason, on each of six faults, run through real bash and node", (ctx) => {
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

  it("the step is red when vitest exits non-zero on a clean report, when it writes no report, and when only a stale clean one is left from an earlier run", (ctx) => {
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
});
