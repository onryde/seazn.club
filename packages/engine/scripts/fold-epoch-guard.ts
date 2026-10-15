// CLI: pnpm --filter @onryde/seazn-engine --fail-if-no-match fold-epoch:check --against <ref>      (node --experimental-strip-types scripts/fold-epoch-guard.ts)
// Engine-split Task 1e-2 (D15, D26), 1e-M (D34): a golden fold that moved must raise that sport's version, in the SAME diff.
//
// The golden corpora (src/sports/<dir>/<key>.golden.json) pin, for every sport, what a recorded event stream folds to: the state after
// each event, the outcome, the summary and the standings deltas. A sport's version is a PAIR in src/sport/fold-epoch.ts: the MAJOR
// (FOLD_EPOCH) moves when something a phone computes moved, and native clients send it so the server can refuse one below its own for the
// fixture's sport (D31): an outdated phone is stopped instead of folding differently from the server. The MINOR (FOLD_MINOR) moves when only
// what the server computes moved (the standings deltas), and refuses nobody. This guard compares the working tree with <ref> (CI: HEAD^1)
// and refuses a tree where a sport's results moved and the half that is owed did not rise.
//
// THE RULE, per sport (epochViolations is pure and carries it):
//   - A stream's identity is `config#seed` (unique in every corpus: a duplicate is a refusal).
//   - A stream's INPUT is everything its replay starts from: the RAW config object it names in the corpus's `configs`, its events, and the
//     lineups it was recorded against. The replay re-parses that config, so a module's default can change and the old value be written
//     into the recorded configs, leaving every event and result byte for byte the same: that is a rule change, and it owes the bump.
//   - MATCHED: the identity is on both sides and the stream's INPUT is equal.
//   - CHANGED: a matched stream whose states, outcome or summary differ. A phone computes (and renders) all three, mid-match states
//     included. DELTAS-ONLY: a matched stream whose states, outcome and summary are the same and whose standings deltas differ: only the
//     server computes those. A stream that differs in both is CHANGED once. Anything that is not exactly "deltas only" is CHANGED.
//   - REMOVED: a baseline stream with no matching identity, or whose input differs (it was RE-RECORDED, so the old input is no longer
//     pinned). ADDED: the same, from the current side. A re-recorded stream is removed AND added.
//   - A MAJOR is owed when changed > 0 or removed > 0, and when the baseline had streams and none matched: FOLD_EPOCH must rise. A MINOR is
//     owed when deltas-only > 0 and nothing owes a major (the strongest class owed decides): FOLD_MINOR must rise, or FOLD_EPOCH must (a
//     major that rose may leave the minor anywhere, 0 included). A MINOR BUMP NEVER SETTLES A MAJOR: a phone computes what a major covers.
//     Streams only ADDED owe nothing (EXTEND_GOLDEN). The pair (FOLD_EPOCH, FOLD_MINOR) going DOWN lexicographically is always a violation
//     (the major fell, or it held and the minor fell). A sport with no baseline at all is new. A baseline whose table has no FOLD_MINOR
//     (before this rule existed) is a minor of 0 for every sport.
//   - A corpus with no epoch entry, an epoch entry with no corpus (nothing would ever compare it), and a sport that has vanished (corpus
//     and entry both gone) are violations: retiring a sport is a decision, not a quiet deletion.
//
// THE CLI reads the tree's corpora and table from the working tree, and the baseline's from `git` at <ref> (rev-parse, ONE ls-tree, ONE
// cat-file --batch, all relative to this engine's directory, so it works with the engine at packages/engine or at a repository root). The
// baseline's table is TypeScript: its text is written to a temp .mts file and imported under strip-types, so the baseline is what its own
// commit declared. Anything git cannot list or read at <ref> (a tree or object it fails on, a gitlink, a damaged object) is a refusal: a
// sport inside it would otherwise read as new, and a new sport owes nothing.
//   --against <ref>   required. CI passes HEAD^1: on a pull_request the checkout is the merge commit refs/pull/N/merge, whose FIRST parent
//                     is the base branch's tip, so the comparison is the PR's net change against the base it will merge into. The gates job
//                     checks out with fetch-depth 0; a shallow checkout or a root commit has no HEAD^1 and is refused, never passed.
//
// Prints one line per sport (epoch and minor before -> after, matched/changed/deltas-only/removed/added) and
// `fold-epoch: N sports checked, M streams compared`.
// Exit codes, each with one meaning (the one convention, D8):
//   0  every sport is in order; or the baseline has the corpora but neither src/sport/fold-epoch.ts nor this guard (the PR that introduces
//      them: nothing to compare);
//   1  a negative signal: at least one sport's results moved without the bump that is owed (major or minor), or the pair fell;
//   2  refused, nothing judged: usage, a ref that is not a commit (shallow clone, root commit), no git to ask, a table or corpus that is
//      missing, does not load or is malformed (the tree's must declare FOLD_MINOR for exactly the sports of FOLD_EPOCH), a table that declares
//      no sport, a duplicate stream identity, a stream that names no config of
//      its corpus, a baseline git cannot read, a baseline that lacks the table but already has this guard or holds no corpus (a moved table, a
//      renamed engine directory), or a run that compared no stream (a pass over nothing proves nothing);
//   3  a crash in the guard itself (an unexpected error is not a verdict; a bare uncaught exception would exit 1, which reads as one).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { GoldenCorpus, GoldenStream } from "../src/testkit/golden.ts";
import { isMainModule } from "./lib/main-module.ts";

// ------------------------------------------------------------------------------------------------------------ the rule (pure)

/** What each side of a comparison holds: the epoch table, and every sport's golden corpus. */
export interface Side {
  /** FOLD_EPOCH: the MAJOR of each sport. */
  epochs: Record<string, number>;
  /** FOLD_MINOR. Absent when the side's table does not declare one (a baseline from before FOLD_MINOR existed): every sport's minor is 0. */
  minors?: Record<string, number>;
  corpora: Record<string, GoldenCorpus>;
}

/** Which half of a sport's version the streams owe: the strongest class decides. */
export type Owed = "major" | "minor";

/** One sport's line of the report. `baseline` is false for a sport new in this change (nothing to compare it with). */
export interface SportRow {
  sport: string;
  matched: number;
  /** Matched streams whose states, outcome or summary differ: what a phone computes. */
  changed: number;
  /** Matched streams whose only difference is their standings deltas: what only the server computes. */
  deltasOnly: number;
  removed: number;
  added: number;
  /** The major (FOLD_EPOCH) on each side. */
  before: number | null;
  after: number | null;
  beforeMinor: number | null;
  afterMinor: number | null;
  /** What the streams owe, whether or not it was paid; null when they owe nothing. */
  owes: Owed | null;
  baseline: boolean;
  reason: string | null;
}

export interface Violation {
  sport: string;
  matched: number;
  changed: number;
  deltasOnly: number;
  removed: number;
  added: number;
  before: number | null;
  after: number | null;
  beforeMinor: number | null;
  afterMinor: number | null;
  owes: Owed | null;
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
const sameInput = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y) || canonical(x) === canonical(y);
/** What a stream's replay starts from (see THE RULE): its raw config object, its events and its lineups. */
const inputOf = (s: GoldenStream, corpus: GoldenCorpus): unknown => [get(corpus.configs, s.config) ?? null, s.events, s.lineups ?? null];
/** What a phone computes: the state after every event, the outcome and the summary. */
const phoneOutputsDiffer = (a: GoldenStream, b: GoldenStream): boolean =>
  a.outcome !== b.outcome || a.summary !== b.summary || a.states.length !== b.states.length || a.states.some((state, i) => state !== b.states[i]);
/** How a matched pair differs: "major" when anything a phone computes does, "minor" when ONLY the standings deltas do, null when it does not. */
const foldChange = (a: GoldenStream, b: GoldenStream): Owed | null => (phoneOutputsDiffer(a, b) ? "major" : a.deltas !== b.deltas ? "minor" : null);
/** A side's minor for a sport: 0 when the side declares no FOLD_MINOR (or none for this sport), which is what a baseline from before it existed means. */
const minorOf = (side: Side, sport: string): number => (side.minors === undefined ? 0 : (get(side.minors, sport) ?? 0));

interface Indexed {
  stream: GoldenStream;
  input: unknown;
}

function indexStreams(corpus: GoldenCorpus | undefined, side: "baseline" | "current", sport: string): Map<string, Indexed> {
  const byId = new Map<string, Indexed>();
  if (corpus === undefined) return byId;
  for (const stream of corpus.streams) {
    const id = `${stream.config}#${stream.seed}`;
    if (byId.has(id)) throw new GuardRefusal(`duplicate stream identity "${id}" in the ${side} corpus of ${sport}: config#seed must name exactly one stream`);
    byId.set(id, { stream, input: inputOf(stream, corpus) });
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
  let deltasOnly = 0;
  let removed = 0;
  let added = 0;
  for (const [id, b] of bStreams) {
    const a = aStreams.get(id);
    if (a === undefined) removed++;
    else if (!sameInput(a.input, b.input)) {
      removed++; // re-recorded (its events, lineups or config differ): the old input is no longer pinned ...
      added++; //   ... and a new one is
    } else {
      matched++;
      const change = foldChange(a.stream, b.stream);
      if (change === "major") changed++;
      else if (change === "minor") deltasOnly++;
    }
  }
  for (const id of aStreams.keys()) if (!bStreams.has(id)) added++;

  // The strongest class owed decides: a stream a phone computes (or one that is gone) owes the major, whatever else moved beside it.
  // "The baseline had streams and none matched" (a renamed config, a wholesale re-record) is `removed === bStreams.size > 0`, so it needs no
  // clause of its own to demand the major; it only gets its own words in the reason.
  const owes: Owed | null = changed > 0 || removed > 0 ? "major" : deltasOnly > 0 ? "minor" : null;
  const bMinor = bEpoch === undefined ? null : minorOf(before, sport);
  const aMinor = aEpoch === undefined ? null : minorOf(after, sport);

  const reasons: string[] = [];
  // (a sport is in the union because one side names it, so with neither on the current side it was on the baseline)
  if (aEpoch === undefined && aCorpus === undefined) {
    reasons.push(`sport "${sport}" is gone (no FOLD_EPOCH entry, no golden corpus): retiring a sport is a deliberate decision this guard does not wave through`);
  } else {
    if (aCorpus !== undefined && aEpoch === undefined) reasons.push(`a golden corpus but no FOLD_EPOCH entry for "${sport}"`);
    if (aEpoch !== undefined && aCorpus === undefined) reasons.push(`a FOLD_EPOCH entry but no golden corpus for "${sport}": nothing would ever compare it`);
  }
  if (bEpoch !== undefined && aEpoch !== undefined) {
    const bMin = minorOf(before, sport);
    const aMin = minorOf(after, sport);
    // The pair goes up lexicographically: the major fell, or it held and the minor fell. (A major that rose may leave the minor anywhere.)
    if (aEpoch < bEpoch) {
      reasons.push(`FOLD_EPOCH went down (${bEpoch} -> ${aEpoch}); an epoch only rises: set FOLD_EPOCH.${sport} back to at least ${bEpoch} in ${TABLE}`);
    } else if (aEpoch === bEpoch && aMin < bMin) {
      reasons.push(`FOLD_MINOR went down (${bMin} -> ${aMin}) with FOLD_EPOCH unchanged; a minor only rises while its major holds: set FOLD_MINOR.${sport} back to at least ${bMin} in ${TABLE}`);
    }
    const majorRose = aEpoch > bEpoch;
    if (owes === "major" && !majorRose) {
      const parts: string[] = [];
      if (bStreams.size > 0 && matched === 0) parts.push("no baseline stream matched");
      if (changed > 0) parts.push(`${changed} stream(s) fold differently`);
      if (removed > 0) parts.push(`${removed} stream(s) removed or re-recorded`);
      // a minor bump is what someone reaches for first, and it does not do: say so when they did
      const minorNote = aMin > bMin ? ` (FOLD_MINOR ${bMin} -> ${aMin} does not stand in for it: a phone computes this)` : "";
      reasons.push(`major owed, a phone computes this: ${parts.join(", ")}, and FOLD_EPOCH did not rise (${bEpoch} -> ${aEpoch})${minorNote}: raise FOLD_EPOCH.${sport} to ${bEpoch + 1} in ${TABLE}, in this same change`);
    } else if (owes === "minor" && !majorRose && !(aMin > bMin)) {
      reasons.push(`minor owed, only the server computes this: ${deltasOnly} stream(s) differ only in their standings deltas, and neither FOLD_EPOCH (${bEpoch} -> ${aEpoch}) nor FOLD_MINOR (${bMin} -> ${aMin}) rose: raise FOLD_MINOR.${sport} to ${bMin + 1} in ${TABLE}, in this same change`);
    }
  }

  return { sport, matched, changed, deltasOnly, removed, added, before: bEpoch ?? null, after: aEpoch ?? null, beforeMinor: bMinor, afterMinor: aMinor, owes, baseline, reason: reasons.length === 0 ? null : reasons.join("; ") };
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
    if (r.reason !== null) {
      violations.push({ sport: r.sport, matched: r.matched, changed: r.changed, deltasOnly: r.deltasOnly, removed: r.removed, added: r.added, before: r.before, after: r.after, beforeMinor: r.beforeMinor, afterMinor: r.afterMinor, owes: r.owes, reason: r.reason });
    }
  }
  return violations;
}

// ------------------------------------------------------------------------------------------------------------------ the CLI

const TABLE = "src/sport/fold-epoch.ts";
const SPORTS_DIR = "src/sports";
const GUARD_FILE = "scripts/fold-epoch-guard.ts";
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
function commitSnapshot(commit: string, ref: string): Snapshot & { hasGuard: boolean } {
  const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim();
  const ls = git(["ls-tree", "-r", "-z", "--name-only", "--full-name", commit, "--", TABLE, SPORTS_DIR, GUARD_FILE]); // pathspecs are relative to cwd, the names printed are not
  if (ls.status !== 0) throw new GuardRefusal(`git ls-tree ${ref} failed: ${ls.stderr.trim()}`);
  const full = ls.stdout.split("\0").filter((n) => n !== "");
  const hasTable = full.includes(`${prefix}${TABLE}`);
  const hasGuard = full.includes(`${prefix}${GUARD_FILE}`);
  const corpusNames = full.filter((n) => n.endsWith(CORPUS_SUFFIX)).sort();
  const wanted = [...(hasTable ? [`${prefix}${TABLE}`] : []), ...corpusNames];
  const texts = wanted.length === 0 ? [] : blobs(commit, ref, wanted);
  const table = hasTable ? (texts.shift() as string) : null;
  return { at: ` at ${ref}`, table, hasGuard, corpora: corpusNames.map((n, i) => ({ rel: n.slice(prefix.length), text: texts[i] as string })) };
}

/** What a table file declares: the majors, and the minors when it declares any (undefined for a table from before FOLD_MINOR existed). */
interface Tables {
  epochs: Record<string, number>;
  minors: Record<string, number> | undefined;
}

/** A side's FOLD_EPOCH and FOLD_MINOR are whatever its own commit declared: its source is imported from a temp file. The tree's table must
 *  declare FOLD_MINOR (`requireMinor`); a baseline's may predate it. A table that declares one holds it for exactly the sports of the other. */
async function loadTable(source: string, label: string, requireMinor: boolean): Promise<Tables> {
  const dir = mkdtempSync(join(tmpdir(), "fold-epoch-guard-"));
  try {
    const file = join(dir, "fold-epoch.mts");
    writeFileSync(file, source);
    let loaded: { FOLD_EPOCH?: unknown; FOLD_MINOR?: unknown };
    try {
      loaded = (await import(pathToFileURL(file).href)) as { FOLD_EPOCH?: unknown; FOLD_MINOR?: unknown };
    } catch (e) {
      throw new GuardRefusal(`${label} does not load: ${messageOf(e)}`);
    }
    const table = loaded.FOLD_EPOCH;
    if (!isObject(table)) throw new GuardRefusal(`${label} does not load: it has no FOLD_EPOCH object export`);
    const entries = Object.entries(table);
    if (entries.length === 0) throw new GuardRefusal(`${label} declares no sport: an empty FOLD_EPOCH guards nothing`);
    for (const [sport, epoch] of entries) {
      if (!Number.isInteger(epoch) || (epoch as number) < 1) throw new GuardRefusal(`${label}: FOLD_EPOCH.${sport} is ${String(epoch)}, and an epoch is a positive integer`);
    }
    const epochs = Object.fromEntries(entries as [string, number][]);

    const minor = loaded.FOLD_MINOR;
    if (minor === undefined) {
      if (requireMinor) throw new GuardRefusal(`${label} does not load: it has no FOLD_MINOR object export`);
      return { epochs, minors: undefined };
    }
    if (!isObject(minor)) throw new GuardRefusal(`${label} does not load: its FOLD_MINOR is not an object`);
    const minorEntries = Object.entries(minor);
    for (const [sport, n] of minorEntries) {
      if (!Number.isInteger(n) || (n as number) < 0) throw new GuardRefusal(`${label}: FOLD_MINOR.${sport} is ${String(n)}, and a minor is a non-negative integer`);
    }
    const minors = Object.fromEntries(minorEntries as [string, number][]);
    const lacking = Object.keys(epochs).filter((s) => !own(minors, s));
    const extra = Object.keys(minors).filter((s) => !own(epochs, s));
    if (lacking.length > 0 || extra.length > 0) {
      const parts = [...(lacking.length > 0 ? [`FOLD_MINOR lacks ${lacking.join(", ")}`] : []), ...(extra.length > 0 ? [`FOLD_MINOR has ${extra.join(", ")}, which FOLD_EPOCH has not`] : [])];
      throw new GuardRefusal(`${label}: FOLD_MINOR and FOLD_EPOCH must name the same sports (${parts.join("; ")})`);
    }
    return { epochs, minors };
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
  if (!isObject(v) || typeof v.key !== "string" || !isObject(v.configs) || !Array.isArray(v.streams)) {
    throw new GuardRefusal(`${label} is not a golden corpus (it needs a string key, a configs object and a streams array)`);
  }
  const configs = v.configs;
  if (v.key !== sport) throw new GuardRefusal(`${label} names sport "${v.key}", but its file name says "${sport}"`);
  v.streams.forEach((s: unknown, i: number) => {
    const ok =
      isObject(s) && typeof s.config === "string" && typeof s.seed === "number" && Array.isArray(s.events) &&
      Array.isArray(s.states) && s.states.every((x: unknown) => typeof x === "string") &&
      typeof s.outcome === "string" && typeof s.summary === "string" && typeof s.deltas === "string";
    if (!ok) throw new GuardRefusal(`${label}: stream #${i} is malformed (it needs config, seed, events, states, outcome, summary and deltas)`);
    // the config is part of the stream's input (THE RULE): one that names nothing would compare as an empty input on both sides
    const config = (s as { config: string }).config;
    if (!own(configs, config)) throw new GuardRefusal(`${label}: stream #${i} names config "${config}", which is not one of the corpus's configs`);
  });
  return v as unknown as GoldenCorpus;
}

/** A side's table and corpora; `null` when the side has no table at all. */
async function readSide(snap: Snapshot, requireMinor: boolean): Promise<Side | null> {
  if (snap.table === null) return null;
  const { epochs, minors } = await loadTable(snap.table, `${TABLE}${snap.at}`, requireMinor);
  const corpora: Record<string, GoldenCorpus> = {};
  for (const { rel, text } of snap.corpora) {
    const sport = basename(rel, CORPUS_SUFFIX);
    if (own(corpora, sport)) throw new GuardRefusal(`two golden corpora for sport "${sport}"${snap.at} (${rel} is the second)`);
    corpora[sport] = parseCorpus(text, `${rel}${snap.at}`, sport);
  }
  return minors === undefined ? { epochs, corpora } : { epochs, minors, corpora };
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
    const after = await readSide(workingSnapshot(), true);
    if (after === null) throw new GuardRefusal(`${TABLE} is missing from the working tree: a deleted table must not read as "no epochs"`);

    const commit = resolveCommit(ref);
    const baseline = commitSnapshot(commit, ref);
    const before = await readSide(baseline, false);
    if (before === null) {
      // The ONE pass without a comparison: the PR that introduces the table, onto a base that has the corpora and neither the table nor this
      // guard. A base that already has the guard, or holds no corpus where this tree has them, is a table that MOVED or an engine directory
      // that was RENAMED, and passing it would let any unbumped fold change through by moving the file in the same PR.
      if (baseline.hasGuard) {
        throw new GuardRefusal(`no ${TABLE} at ${ref}, but the baseline already has ${GUARD_FILE}: the table was moved or renamed, and a fold change cannot be judged against a baseline that has no table at the path this tree reads`);
      }
      if (baseline.corpora.length === 0) {
        throw new GuardRefusal(`no ${TABLE} at ${ref}, and the baseline holds no golden corpus under ${SPORTS_DIR}: the engine directory was moved or renamed, and there is nothing to hold this tree to`);
      }
      out(`fold-epoch: no ${TABLE} at ${ref}: nothing to compare yet (the tree holds ${Object.keys(after.epochs).length} sports, ${countStreams(after)} streams)`);
      return 0;
    }

    const rows = compareSides(before, after);
    const compared = rows.filter((r) => r.baseline);
    const streams = compared.reduce((n, r) => n + r.matched, 0);
    const violations = rows.filter((r) => r.reason !== null);
    for (const r of rows) {
      const epoch = `epoch ${r.before ?? "(none)"} -> ${r.after ?? "(none)"}, minor ${r.beforeMinor ?? "(none)"} -> ${r.afterMinor ?? "(none)"}`;
      out(`fold-epoch: ${r.sport}: ${epoch}, matched ${r.matched} changed ${r.changed} deltas-only ${r.deltasOnly} removed ${r.removed} added ${r.added}${r.reason === null ? "" : ` - VIOLATION: ${r.reason}`}`);
    }
    out(`fold-epoch: ${compared.length} sports checked, ${streams} streams compared against ${ref}: ${violations.length} violation(s)`);
    if (violations.length > 0) {
      const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim(); // "packages/engine/" in the monorepo, "" with the engine at a repository root
      out(`fold-epoch: to clear the violation(s) above, raise the sport's entry in ${prefix}${TABLE} in this same change: FOLD_EPOCH where a line says major owed (a phone computes what moved), FOLD_MINOR where it says minor owed (only the server does); CI compares the whole PR with the branch it merges into; to check it before pushing: pnpm --filter @onryde/seazn-engine fold-epoch:check --against origin/main`);
      return 1;
    }
    if (streams === 0) throw new GuardRefusal(`compared no stream against ${ref}: the baseline holds no golden corpus to hold the tree to, and a pass over nothing proves nothing`);
    return 0;
  } catch (e) {
    if (!(e instanceof GuardRefusal)) throw e;
    err(`fold-epoch: ${e.message}`);
    return 2;
  }
}

// Main-module guard [R32]: importing this file from a test must not run it. isMainModule compares REAL paths (the engine's gates use it too):
// a checkout under a symlinked directory (macOS /var -> /private/var, a symlinked worktree) gives argv[1] the link and import.meta.url the
// target, and a guard that compared the two as given would run nothing and exit 0, which for a gate is a pass.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => {
      err(`fold-epoch: the guard itself crashed (this is not a verdict): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exitCode = 3;
    },
  );
}
