// CLI: pnpm --filter @onryde/seazn-engine --fail-if-no-match fold-epoch:check --against <ref>      (node --experimental-strip-types scripts/fold-epoch-guard.ts)
// Engine-split Task 1e-2 (D15, D26): a golden fold that moved must bump that sport's FOLD_EPOCH in the SAME diff.
//
// The golden corpora (src/sports/<dir>/<key>.golden.json) pin, for every sport, what a recorded event stream folds to: the state after
// each event, the outcome, the summary and the standings deltas. Native clients send their FOLD_EPOCH (src/sport/fold-epoch.ts) and the
// server refuses one lower than its own for the fixture's sport (D31), so an outdated phone is stopped instead of folding differently
// from the server. That only works if the number moves whenever a result does. This guard compares the working tree with <ref> (CI: HEAD^1)
// and refuses a tree where a sport's results moved and its epoch did not rise.
//
// THE RULE, per sport (epochViolations is pure and carries it):
//   - A stream's identity is `config#seed` (unique in every corpus: a duplicate is a refusal).
//   - MATCHED: the identity is on both sides and the stream's INPUT is equal (its events, and the lineups it was recorded against).
//   - CHANGED: a matched stream whose states, outcome, summary or deltas differ. Mid-match states count: a phone renders them.
//   - REMOVED: a baseline stream with no matching identity, or whose input differs (it was RE-RECORDED, so the old input is no longer
//     pinned). ADDED: the same, from the current side. A re-recorded stream is removed AND added.
//   - A bump (epoch above the baseline's) is required when changed > 0 or removed > 0, and when the baseline had streams and none matched.
//     Streams only ADDED need none (EXTEND_GOLDEN). An epoch that went DOWN is always a violation. A sport with no baseline at all is new.
//   - A corpus with no epoch entry, an epoch entry with no corpus (nothing would ever compare it), and a sport that has vanished (corpus
//     and entry both gone) are violations: retiring a sport is a decision, not a quiet deletion.
//
// THE CLI reads the tree's corpora and table from the working tree, and the baseline's from `git` at <ref> (rev-parse, ls-tree, show,
// all relative to this engine's directory, so it works with the engine at packages/engine or at a repository root). The baseline's table
// is TypeScript: it is written to a temp .mts file and imported under strip-types, so the baseline is what its own commit declared.
//   --against <ref>   required. CI passes HEAD^1: on a pull_request the checkout is the merge commit refs/pull/N/merge, whose FIRST parent
//                     is the base branch's tip, so the comparison is the PR's net change against the base it will merge into. The gates job
//                     checks out with fetch-depth 0; a shallow checkout or a root commit has no HEAD^1 and is refused, never passed.
//
// Prints one line per sport (epoch before -> after, matched/changed/removed/added) and `fold-epoch: N sports checked, M streams compared`.
// Exit codes, each with one meaning (the one convention, D8):
//   0  every sport is in order; or the baseline has no src/sport/fold-epoch.ts yet (the PR that introduces it: nothing to compare);
//   1  a negative signal: at least one sport's results moved without a bump, or an epoch fell;
//   2  refused, nothing judged: usage, a ref that is not a commit (shallow clone, root commit), no git to ask, a table or corpus that is
//      missing, does not load or is malformed, a table that declares no sport, a duplicate stream identity, or a run that compared no stream
//      (a pass over nothing proves nothing);
//   3  a crash in the guard itself (an unexpected error is not a verdict; a bare uncaught exception would exit 1, which reads as one).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { GoldenCorpus, GoldenStream } from "../src/testkit/golden.ts";

// ------------------------------------------------------------------------------------------------------------ the rule (pure)

/** What each side of a comparison holds: the epoch table, and every sport's golden corpus. */
export interface Side {
  epochs: Record<string, number>;
  corpora: Record<string, GoldenCorpus>;
}

/** One sport's line of the report. `baseline` is false for a sport new in this change (nothing to compare it with). */
export interface SportRow {
  sport: string;
  matched: number;
  changed: number;
  removed: number;
  added: number;
  before: number | null;
  after: number | null;
  baseline: boolean;
  reason: string | null;
}

export interface Violation {
  sport: string;
  matched: number;
  changed: number;
  removed: number;
  added: number;
  before: number | null;
  after: number | null;
  reason: string;
}

/** An input the guard refuses to judge: exit 2, never a verdict. */
export class GuardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRefusal";
  }
}

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const get = <T>(o: Record<string, T>, k: string): T | undefined => (own(o, k) ? o[k] : undefined);

const sortKeys = (_key: string, v: unknown): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v;
/** JSON with every object's keys in one order, so a payload written with its keys shuffled is the same input. */
const canonical = (v: unknown): string => JSON.stringify(v ?? null, sortKeys);
/** Whether two streams ask for the same fold: the same events and the same lineups. The recorder writes keys in one order, so the plain
 *  text of the two is equal in practice and settles it; only when the text differs is the order-insensitive form asked. */
const sameInput = (a: GoldenStream, b: GoldenStream): boolean => {
  const x: unknown = [a.events, a.lineups ?? null];
  const y: unknown = [b.events, b.lineups ?? null];
  return JSON.stringify(x) === JSON.stringify(y) || canonical(x) === canonical(y);
};
const outputsDiffer = (a: GoldenStream, b: GoldenStream): boolean =>
  a.outcome !== b.outcome || a.summary !== b.summary || a.deltas !== b.deltas || a.states.length !== b.states.length || a.states.some((state, i) => state !== b.states[i]);

function indexStreams(corpus: GoldenCorpus | undefined, side: "baseline" | "current", sport: string): Map<string, GoldenStream> {
  const byId = new Map<string, GoldenStream>();
  for (const s of corpus?.streams ?? []) {
    const id = `${s.config}#${s.seed}`;
    if (byId.has(id)) throw new GuardRefusal(`duplicate stream identity "${id}" in the ${side} corpus of ${sport}: config#seed must name exactly one stream`);
    byId.set(id, s);
  }
  return byId;
}

function compareSport(sport: string, before: Side, after: Side): SportRow {
  const bEpoch = get(before.epochs, sport);
  const aEpoch = get(after.epochs, sport);
  const bCorpus = get(before.corpora, sport);
  const aCorpus = get(after.corpora, sport);
  const baseline = bEpoch !== undefined || bCorpus !== undefined;
  const bStreams = indexStreams(bCorpus, "baseline", sport);
  const aStreams = indexStreams(aCorpus, "current", sport);

  let matched = 0;
  let changed = 0;
  let removed = 0;
  let added = 0;
  for (const [id, b] of bStreams) {
    const a = aStreams.get(id);
    if (a === undefined) removed++;
    else if (!sameInput(a, b)) {
      removed++; // re-recorded: the old input is no longer pinned ...
      added++; //   ... and a new one is
    } else {
      matched++;
      if (outputsDiffer(a, b)) changed++;
    }
  }
  for (const id of aStreams.keys()) if (!bStreams.has(id)) added++;

  const reasons: string[] = [];
  if (baseline && aEpoch === undefined && aCorpus === undefined) {
    reasons.push(`sport "${sport}" is gone (no FOLD_EPOCH entry, no golden corpus): retiring a sport is a deliberate decision this guard does not wave through`);
  } else {
    if (aCorpus !== undefined && aEpoch === undefined) reasons.push(`a golden corpus but no FOLD_EPOCH entry for "${sport}"`);
    if (aEpoch !== undefined && aCorpus === undefined) reasons.push(`a FOLD_EPOCH entry but no golden corpus for "${sport}": nothing would ever compare it`);
  }
  if (bEpoch !== undefined && aEpoch !== undefined && aEpoch < bEpoch) reasons.push(`FOLD_EPOCH went down (${bEpoch} -> ${aEpoch}); an epoch only rises`);
  // "The baseline had streams and none matched" (a renamed config, a wholesale re-record) is `removed === bStreams.size > 0`, so it needs no
  // clause of its own to demand the bump; it only gets its own words in the reason.
  const needsBump = changed > 0 || removed > 0;
  if (needsBump && bEpoch !== undefined && aEpoch !== undefined && !(aEpoch > bEpoch)) {
    const parts: string[] = [];
    if (bStreams.size > 0 && matched === 0) parts.push("no baseline stream matched");
    if (changed > 0) parts.push(`${changed} stream(s) fold differently`);
    if (removed > 0) parts.push(`${removed} stream(s) removed or re-recorded`);
    reasons.push(`${parts.join(", ")}, and FOLD_EPOCH did not rise (${bEpoch} -> ${aEpoch})`);
  }

  return { sport, matched, changed, removed, added, before: bEpoch ?? null, after: aEpoch ?? null, baseline, reason: reasons.length === 0 ? null : reasons.join("; ") };
}

/** One row per sport that appears on either side, alphabetical. `null` before (no baseline at all) compares nothing. */
export function compareSides(before: Side | null, after: Side): SportRow[] {
  if (before === null) return [];
  const sports = new Set([...Object.keys(before.epochs), ...Object.keys(before.corpora), ...Object.keys(after.epochs), ...Object.keys(after.corpora)]);
  return [...sports].sort().map((sport) => compareSport(sport, before, after));
}

/** The sports that broke the rule. Pure. `null` before means there is no baseline to hold the tree to. */
export function epochViolations(before: Side | null, after: Side): Violation[] {
  const violations: Violation[] = [];
  for (const r of compareSides(before, after)) {
    if (r.reason !== null) violations.push({ sport: r.sport, matched: r.matched, changed: r.changed, removed: r.removed, added: r.added, before: r.before, after: r.after, reason: r.reason });
  }
  return violations;
}

// ------------------------------------------------------------------------------------------------------------------ the CLI

const TABLE = "src/sport/fold-epoch.ts";
const SPORTS_DIR = "src/sports";
const CORPUS_SUFFIX = ".golden.json";
const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: fold-epoch-guard.ts --against <ref>";
const MAX_BUFFER = 256 * 1024 * 1024;

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const err = (s: string): void => { process.stderr.write(`${s}\n`); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: ENGINE_DIR, encoding: "utf8", maxBuffer: MAX_BUFFER });
  // No git, or an answer too big to hold, is a refusal naming that: not a "not a commit" that blames the ref.
  if (r.error !== undefined) throw new GuardRefusal(`could not run git ${args[0] ?? ""}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** What one side holds: its table's source (null when it has none), and the text of every golden corpus file, named relative to the engine. */
interface Snapshot {
  /** How the side is named in a message: "" for the working tree, " at <ref>" for a commit. */
  at: string;
  table: string | null;
  corpora: { rel: string; text: string }[];
}

function workingSnapshot(): Snapshot {
  const orNull = <T>(f: () => T, none: T): T => {
    try {
      return f();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return none;
      throw e;
    }
  };
  const table = orNull(() => readFileSync(join(ENGINE_DIR, TABLE), "utf8"), null);
  const files = orNull(() => (readdirSync(join(ENGINE_DIR, SPORTS_DIR), { recursive: true }) as string[]), [])
    .filter((f) => f.endsWith(CORPUS_SUFFIX))
    .map((f) => `${SPORTS_DIR}/${f}`)
    .sort();
  return { at: "", table, corpora: files.map((rel) => ({ rel, text: readFileSync(join(ENGINE_DIR, rel), "utf8") })) };
}

/** Every blob named in `names` at `commit`, in order, from ONE `git cat-file --batch` (a process per file is a second each on a slow runner). */
function blobs(commit: string, ref: string, names: string[]): string[] {
  if (names.some((n) => n.includes("\n"))) throw new GuardRefusal(`a path at ${ref} contains a newline, which git cat-file --batch cannot be asked for`);
  const r = spawnSync("git", ["cat-file", "--batch"], { cwd: ENGINE_DIR, input: `${names.map((n) => `${commit}:${n}`).join("\n")}\n`, maxBuffer: MAX_BUFFER });
  if (r.error !== undefined) throw new GuardRefusal(`could not run git cat-file: ${r.error.message}`);
  if (r.status !== 0) throw new GuardRefusal(`git cat-file --batch ${ref} failed: ${String(r.stderr).trim()}`);
  const buf = r.stdout;
  const texts: string[] = [];
  let at = 0;
  for (const name of names) {
    const eol = buf.indexOf(0x0a, at);
    const header = eol < 0 ? "" : buf.toString("utf8", at, eol);
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (m === null) throw new GuardRefusal(`git cat-file could not read ${ref}:${name} as a file (${header || "no answer"})`);
    const size = Number(m[1]);
    texts.push(buf.toString("utf8", eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1; // the content is followed by one newline
  }
  return texts;
}

/** The engine's table and corpora as `commit` held them. Paths are repo-root-relative to git and engine-relative to the rest of the guard
 *  (`git rev-parse --show-prefix` is "packages/engine/" in the monorepo and "" in the engine's own repo). */
function commitSnapshot(commit: string, ref: string): Snapshot {
  const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim();
  const ls = git(["ls-tree", "-r", "-z", "--name-only", "--full-name", commit, "--", TABLE, SPORTS_DIR]); // pathspecs are relative to cwd, the names printed are not
  if (ls.status !== 0) throw new GuardRefusal(`git ls-tree ${ref} failed: ${ls.stderr.trim()}`);
  const full = ls.stdout.split("\0").filter((n) => n !== "");
  const hasTable = full.includes(`${prefix}${TABLE}`);
  const corpusNames = full.filter((n) => n.endsWith(CORPUS_SUFFIX)).sort();
  const wanted = [...(hasTable ? [`${prefix}${TABLE}`] : []), ...corpusNames];
  const texts = wanted.length === 0 ? [] : blobs(commit, ref, wanted);
  const table = hasTable ? (texts.shift() as string) : null;
  return { at: ` at ${ref}`, table, corpora: corpusNames.map((n, i) => ({ rel: n.slice(prefix.length), text: texts[i] as string })) };
}

/** The baseline's FOLD_EPOCH is whatever its own commit declared: its source is imported from a temp file. */
async function loadTable(source: string, label: string): Promise<Record<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), "fold-epoch-guard-"));
  try {
    const file = join(dir, "fold-epoch.mts");
    writeFileSync(file, source);
    let table: unknown;
    try {
      table = ((await import(pathToFileURL(file).href)) as { FOLD_EPOCH?: unknown }).FOLD_EPOCH;
    } catch (e) {
      throw new GuardRefusal(`${label} does not load: ${messageOf(e)}`);
    }
    if (!isObject(table)) throw new GuardRefusal(`${label} does not load: it has no FOLD_EPOCH object export`);
    const entries = Object.entries(table);
    if (entries.length === 0) throw new GuardRefusal(`${label} declares no sport: an empty FOLD_EPOCH guards nothing`);
    for (const [sport, epoch] of entries) {
      if (!Number.isInteger(epoch) || (epoch as number) < 1) throw new GuardRefusal(`${label}: FOLD_EPOCH.${sport} is ${String(epoch)}, and an epoch is a positive integer`);
    }
    return Object.fromEntries(entries as [string, number][]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseCorpus(text: string, label: string, sport: string): GoldenCorpus {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new GuardRefusal(`${label} is not valid JSON: ${messageOf(e)}`);
  }
  if (!isObject(v) || typeof v.key !== "string" || !Array.isArray(v.streams)) throw new GuardRefusal(`${label} is not a golden corpus (it needs a string key and a streams array)`);
  if (v.key !== sport) throw new GuardRefusal(`${label} names sport "${v.key}", but its file name says "${sport}"`);
  v.streams.forEach((s: unknown, i: number) => {
    const ok =
      isObject(s) && typeof s.config === "string" && typeof s.seed === "number" && Array.isArray(s.events) &&
      Array.isArray(s.states) && s.states.every((x: unknown) => typeof x === "string") &&
      typeof s.outcome === "string" && typeof s.summary === "string" && typeof s.deltas === "string";
    if (!ok) throw new GuardRefusal(`${label}: stream #${i} is malformed (it needs config, seed, events, states, outcome, summary and deltas)`);
  });
  return v as unknown as GoldenCorpus;
}

/** A side's table and corpora; `null` when the side has no table at all. */
async function readSide(snap: Snapshot): Promise<Side | null> {
  if (snap.table === null) return null;
  const epochs = await loadTable(snap.table, `${TABLE}${snap.at}`);
  const corpora: Record<string, GoldenCorpus> = {};
  for (const { rel, text } of snap.corpora) {
    const sport = basename(rel, CORPUS_SUFFIX);
    if (own(corpora, sport)) throw new GuardRefusal(`two golden corpora for sport "${sport}"${snap.at} (${rel} is the second)`);
    corpora[sport] = parseCorpus(text, `${rel}${snap.at}`, sport);
  }
  return { epochs, corpora };
}

function resolveCommit(ref: string): string {
  const rev = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const commit = rev.stdout.trim();
  if (rev.status !== 0 || commit === "") {
    const shallow = git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
    throw new GuardRefusal(
      `"${ref}" is not a commit in this repository (git rev-parse --verify ${ref}^{commit} failed)${shallow ? "; this is a shallow clone, so fetch the history (actions/checkout fetch-depth: 0)" : ""}`,
    );
  }
  return commit;
}

function parse(argv: string[]): string {
  let against: string | undefined;
  try {
    against = parseArgs({ args: argv, allowPositionals: false, strict: true, options: { against: { type: "string" } } }).values.against;
  } catch (e) {
    throw new GuardRefusal(`${messageOf(e)}\n${USAGE}`);
  }
  if (against === undefined) throw new GuardRefusal(`--against <ref> is required\n${USAGE}`);
  if (against === "" || against.startsWith("-")) throw new GuardRefusal(`"${against}" is not a ref\n${USAGE}`);
  return against;
}

const countStreams = (side: Side): number => Object.values(side.corpora).reduce((n, c) => n + c.streams.length, 0);

/** Runs one CLI invocation and returns its exit code (the entry point at the bottom sets `process.exitCode` from it). */
export async function main(argv: string[]): Promise<number> {
  try {
    const ref = parse(argv);
    const after = await readSide(workingSnapshot());
    if (after === null) throw new GuardRefusal(`${TABLE} is missing from the working tree: a deleted table must not read as "no epochs"`);

    const commit = resolveCommit(ref);
    const before = await readSide(commitSnapshot(commit, ref));
    if (before === null) {
      out(`fold-epoch: no ${TABLE} at ${ref}: nothing to compare yet (the tree holds ${Object.keys(after.epochs).length} sports, ${countStreams(after)} streams)`);
      return 0;
    }

    const rows = compareSides(before, after);
    const compared = rows.filter((r) => r.baseline);
    const streams = compared.reduce((n, r) => n + r.matched, 0);
    const violations = rows.filter((r) => r.reason !== null);
    for (const r of rows) {
      const epoch = `epoch ${r.before ?? "(none)"} -> ${r.after ?? "(none)"}`;
      out(`fold-epoch: ${r.sport}: ${epoch}, matched ${r.matched} changed ${r.changed} removed ${r.removed} added ${r.added}${r.reason === null ? "" : ` - VIOLATION: ${r.reason}`}`);
    }
    out(`fold-epoch: ${compared.length} sports checked, ${streams} streams compared against ${ref}: ${violations.length} violation(s)`);
    if (violations.length > 0) return 1;
    if (streams === 0) throw new GuardRefusal(`compared no stream against ${ref}: the baseline holds no golden corpus to hold the tree to, and a pass over nothing proves nothing`);
    return 0;
  } catch (e) {
    if (!(e instanceof GuardRefusal)) throw e;
    err(`fold-epoch: ${e.message}`);
    return 2;
  }
}

// Main-module guard [R32]: importing this file from a test must not run it. Compared by REAL path: a checkout under a symlinked directory
// (macOS /var -> /private/var, a symlinked worktree) gives argv[1] the link and import.meta.url the target, and a guard that compared the
// two as given would run nothing and exit 0, which for a gate is a pass.
const isMain = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => {
      err(`fold-epoch: the guard itself crashed (this is not a verdict): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exitCode = 3;
    },
  );
}
