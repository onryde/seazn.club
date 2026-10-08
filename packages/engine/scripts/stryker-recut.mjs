// CLI: pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants>] [--open <Host,...>] [--table]      (from packages/engine)
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
//   --open <names>  declarations too big to cut around (a statement alone over what a leg may hold): the comma-separated names of
//                top-level declarations whose MEMBERS the cuts may fall between, as `Host.member` anchors (T20-PRE; see
//                scripts/stryker-cuts.mjs). A cut inside a declaration drops that declaration's own container mutant (the object
//                literal, the function body), and the output reports how many mutants fall in no part;
//   --table      also print every unit a cut can fall before: its lines, mutants, the mutants before it, and the anchor that cuts there.
// Exit codes (D8): 0 the proposal was printed; 2 refused, nothing on stdout (usage, an unreadable file, a part count the file
// cannot be cut into).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cutUnits, planSplit, resolveSplit, topLevelStatements, unitMutants } from "./stryker-cuts.mjs";

const USAGE = "usage: pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants>] [--open <Host,...>] [--table]   (the file relative to packages/engine)";

function refuse(message) {
  process.stderr.write(`stryker-recut: ${message}\n${USAGE}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, strict: true, options: { extra: { type: "string" }, open: { type: "string" }, table: { type: "boolean" } } });
} catch (e) {
  refuse(e.message);
}
const [file, partsArg, ...rest] = parsed.positionals;
if (file === undefined || partsArg === undefined || rest.length > 0) refuse("expected a file and a part count");
const parts = /^\d+$/.test(partsArg) ? Number(partsArg) : NaN;
if (!Number.isInteger(parts) || parts < 1) refuse(`"${partsArg}" is not a part count (a whole number from 1)`);
const extra = parsed.values.extra === undefined ? 0 : /^\d+$/.test(parsed.values.extra) ? Number(parsed.values.extra) : NaN;
if (!Number.isInteger(extra)) refuse(`--extra "${parsed.values.extra}" is not a mutant count (a whole number from 0)`);

const open = parsed.values.open === undefined ? [] : parsed.values.open.split(",");
if (open.some((n) => n.trim() === "")) refuse(`--open "${parsed.values.open}" names an empty declaration (a comma-separated list of top-level names)`);

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  refuse(`${file} is unreadable or missing (give a path relative to packages/engine)`);
}

/** Stryker's own instrumenter, from @stryker-mutator/core's dependency tree (the engine does not depend on it directly): where
 *  each mutant's node starts and ends, as 1-based lines. */
async function mutantPlaces() {
  const core = createRequire(join(process.cwd(), "package.json")).resolve("@stryker-mutator/core/package.json");
  const path = createRequire(core).resolve("@stryker-mutator/instrumenter");
  const { Instrumenter } = await import(pathToFileURL(path).href);
  const instrumenter = new Instrumenter({ debug() {}, info() {}, isDebugEnabled: () => false });
  const r = await instrumenter.instrument([{ name: file, mutate: true, content: text }], { ignorers: [], plugins: null, excludedMutations: [] });
  // the instrumenter counts lines from 0
  return r.mutants.map((m) => ({ start: m.location.start.line + 1, end: m.location.end.line + 1 }));
}

const statements = topLevelStatements(text);
let units;
try {
  units = cutUnits(text, open);
} catch (e) {
  refuse(e.message);
}
const places = await mutantPlaces();
const weights = unitMutants(units, statements, places.map((p) => p.start));
const total = weights.reduce((a, b) => a + b, 0);
if (total === 0) refuse(`${file} holds no mutants: there is nothing to cut`);

// A cut before a unit needs a name no other unit shares, and a line of its own (what comes before it ends above).
const taken = new Map();
for (const u of units) for (const n of u.names) taken.set(n, (taken.get(n) ?? 0) + 1);
const anchors = units.map((u) => (u.prevEnd !== null && u.prevEnd < u.startLine ? u.names.find((n) => taken.get(n) === 1) : undefined));
const cutable = anchors.map((a) => a !== undefined);

const plan = planSplit({ weights, cutable, parts, extra });
if (plan === null) refuse(`${file} cannot be cut into ${parts} parts: ${units.length} units a cut can fall before, ${cutable.filter(Boolean).length} of them can start a part`);

const names = plan.cuts.map((c) => anchors[c]);
const ranges = resolveSplit(text, names, file);
// What Stryker will find in each range is the mutants whose WHOLE node lies inside it, which is not the same as the mutants that
// start in it when a cut falls inside a declaration: the declaration's own container node lies in no range.
const sizes = ranges.map(([a, b]) => places.filter((p) => p.start >= a && p.end <= b).length);
const inNoPart = total - sizes.reduce((x, y) => x + y, 0);
const largest = Math.max(...sizes.map((n, i) => n + (i === parts - 1 ? extra : 0)));
const kind = open.length === 0 ? `${statements.length} top-level statements` : `${statements.length} top-level statements, ${open.join(", ")} opened into members`;
const out = [];
out.push(`${file}: ${total} mutants in ${kind} (${cutable.filter(Boolean).length} places a part can start)`);
out.push(`cut into ${parts} part${parts === 1 ? "" : "s"}, the largest ${largest} mutants${extra > 0 ? ` (the last part also carries ${extra} from its leg's other files)` : ""}:`);
ranges.forEach(([a, b], i) => out.push(`  part ${i + 1}: ${sizes[i]} mutants, lines ${a}-${b}${i === parts - 1 && extra > 0 ? ` (+${extra} from the other files)` : ""}`));
out.push(`mutants in no part: ${inNoPart}${inNoPart > 0 ? " (a cut inside a declaration drops the mutant of the node that contains it, its object literal or function body; none is lost to a cut between top-level statements)" : ""}`);
out.push("paste into STRYKER_SPLITS in stryker.groups.mjs, give each leg of the file `file#N` for its part, and re-derive stryker-timeouts.json:");
out.push(`  ${JSON.stringify(file)}: [${names.map((n) => JSON.stringify(n)).join(", ")}],`);
if (parsed.values.table === true) {
  out.push("", "unit       lines        mutants  before   anchor");
  let before = 0;
  units.forEach((u, i) => {
    out.push(`${String(i + 1).padStart(9)}  ${`${u.startLine}-${u.endLine}`.padEnd(11)}  ${String(weights[i]).padStart(7)}  ${String(before).padStart(6)}   ${anchors[i] ?? (u.names.length > 0 ? `(${u.names[0]}: not unique or shares a line)` : "-")}`);
    before += weights[i];
  });
}
process.stdout.write(`${out.join("\n")}\n`);
// the instrumenter's own handles keep the process alive past the last write
process.exit(0);
