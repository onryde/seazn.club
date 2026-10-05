// CLI: pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants>] [--table]      (from packages/engine)
// W1d Task 15, fix round 1, I1 / T15-CUT: proposes the cuts for splitting one source file into <parts> Stryker legs. Run it
// when test/stryker-sizing.test.ts says a leg is over the 200-minute line (or empty), or when a file grows past what its legs
// hold; paste its STRYKER_SPLITS line into stryker.groups.mjs, give each leg of the file `<file>#N`, and re-derive
// stryker-timeouts.json from the sizing test's table.
//
// It counts with Stryker's own instrumenter (the code that writes a dry run's "Instrumented N source file(s) with M
// mutant(s)" line), attributes each mutant to the top-level statement it starts in, and picks the cuts, each before a named
// top-level statement, that minimise the largest part. Floors are keyed per FAMILY (stryker-floor.json), so a re-split never
// touches a floor.
//   --extra <n>  the mutants of the other files the file's LAST leg also holds (that leg's tail), counted into the last part;
//   --table      also print every top-level statement: its lines, mutants, the mutants before it, and the anchor that cuts there.
// Exit codes (D8): 0 the proposal was printed; 2 refused, nothing on stdout (usage, an unreadable file, a part count the file
// cannot be cut into).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { planSplit, resolveSplit, statementMutants, topLevelStatements } from "./stryker-cuts.mjs";

const USAGE = "usage: pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants>] [--table]   (the file relative to packages/engine)";

function refuse(message) {
  process.stderr.write(`stryker-recut: ${message}\n${USAGE}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, strict: true, options: { extra: { type: "string" }, table: { type: "boolean" } } });
} catch (e) {
  refuse(e.message);
}
const [file, partsArg, ...rest] = parsed.positionals;
if (file === undefined || partsArg === undefined || rest.length > 0) refuse("expected a file and a part count");
const parts = /^\d+$/.test(partsArg) ? Number(partsArg) : NaN;
if (!Number.isInteger(parts) || parts < 1) refuse(`"${partsArg}" is not a part count (a whole number from 1)`);
const extra = parsed.values.extra === undefined ? 0 : /^\d+$/.test(parsed.values.extra) ? Number(parsed.values.extra) : NaN;
if (!Number.isInteger(extra)) refuse(`--extra "${parsed.values.extra}" is not a mutant count (a whole number from 0)`);

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  refuse(`${file} is unreadable or missing (give a path relative to packages/engine)`);
}

/** Stryker's own instrumenter, from @stryker-mutator/core's dependency tree (the engine does not depend on it directly). */
async function mutantStartLines() {
  const core = createRequire(join(process.cwd(), "package.json")).resolve("@stryker-mutator/core/package.json");
  const path = createRequire(core).resolve("@stryker-mutator/instrumenter");
  const { Instrumenter } = await import(pathToFileURL(path).href);
  const instrumenter = new Instrumenter({ debug() {}, info() {}, isDebugEnabled: () => false });
  const r = await instrumenter.instrument([{ name: file, mutate: true, content: text }], { ignorers: [], plugins: null, excludedMutations: [] });
  return r.mutants.map((m) => m.location.start.line + 1); // the instrumenter counts lines from 0
}

const statements = topLevelStatements(text);
const weights = statementMutants(statements, await mutantStartLines());
const total = weights.reduce((a, b) => a + b, 0);
if (total === 0) refuse(`${file} holds no mutants: there is nothing to cut`);

// A cut before statement i needs a name no other statement shares, and a line of its own (the statement before it ends above).
const taken = new Map();
for (const s of statements) for (const n of s.names) taken.set(n, (taken.get(n) ?? 0) + 1);
const anchors = statements.map((s, i) => (i > 0 && statements[i - 1].endLine < s.startLine ? s.names.find((n) => taken.get(n) === 1) : undefined));
const cutable = anchors.map((a) => a !== undefined);

const plan = planSplit({ weights, cutable, parts, extra });
if (plan === null) refuse(`${file} cannot be cut into ${parts} parts: ${statements.length} top-level statements, ${cutable.filter(Boolean).length} of them can start a part`);

const names = plan.cuts.map((c) => anchors[c]);
const ranges = resolveSplit(text, names, file);
const out = [];
out.push(`${file}: ${total} mutants in ${statements.length} top-level statements (${cutable.filter(Boolean).length} can start a part)`);
out.push(`cut into ${parts} part${parts === 1 ? "" : "s"}, the largest ${plan.max} mutants${extra > 0 ? ` (the last part also carries ${extra} from its leg's other files)` : ""}:`);
ranges.forEach(([a, b], i) => out.push(`  part ${i + 1}: ${plan.sizes[i] - (i === parts - 1 ? extra : 0)} mutants, lines ${a}-${b}${i === parts - 1 && extra > 0 ? ` (+${extra} from the other files)` : ""}`));
out.push("paste into STRYKER_SPLITS in stryker.groups.mjs, give each leg of the file `file#N` for its part, and re-derive stryker-timeouts.json:");
out.push(`  ${JSON.stringify(file)}: [${names.map((n) => JSON.stringify(n)).join(", ")}],`);
if (parsed.values.table === true) {
  out.push("", "statement  lines        mutants  before   anchor");
  let before = 0;
  statements.forEach((s, i) => {
    out.push(`${String(i + 1).padStart(9)}  ${`${s.startLine}-${s.endLine}`.padEnd(11)}  ${String(weights[i]).padStart(7)}  ${String(before).padStart(6)}   ${anchors[i] ?? (s.names.length > 0 ? `(${s.names[0]}: not unique or shares a line)` : "-")}`);
    before += weights[i];
  });
}
process.stdout.write(`${out.join("\n")}\n`);
// the instrumenter's own handles keep the process alive past the last write
process.exit(0);
