// R26: the single-sport ratchet. Lists the unreasoned single-sport pins in the
// sport sweep's scope and ratchets them against a committed baseline, so the
// list can only shrink.
//
// Scope: every *.test.ts under packages/engine/src/{scheduling,competition},
// plus every *.test.ts under packages/engine/src or apps/web/src whose FILE
// name says standings, progression, seeding or tiebreak. node_modules and
// dot-directories are skipped; symlinks are not followed.
//
// A pin: a registry sport key in matching quotes ("generic", 'generic',
// `generic`) on a code line of an in-scope file that does not sweep. A file
// whose code names forEachSport, sportCases, SPORT_KEYS or builtinModules
// sweeps the registry and pins nothing. Full-line // comments are not code.
//
// A reason: `// single-sport: <reason>`, the reason non-empty. Where it counts:
//   - trailing a code line: that line only;
//   - on its own line directly above a test call (it / test / describe /
//     bench, it.each(...)(...) included): that call, header to closing line;
//   - on its own line anywhere else: the rest of its block — every following
//     line indented at least as deep, up to the first line indented shallower.
//     The house convention (scripts/matrix/__tests__, Task 7 M-2) puts it on
//     the first line of the test body, which covers exactly that test; at the
//     top level of a file it covers the rest of the file.
// The ratchet key is `<file>:<sport>`: moving a line is no change; a new file,
// or a new sport in a file, is.
//
// usage: single-sport.ts [--check | --write | --init] [--root DIR]
//   (no mode)  list the unreasoned pins;
//   --check    list them, then compare with the committed baseline;
//   --write    rewrite the baseline to today's set. It only ever REMOVES
//              entries: a write that would add one — even as a swap that keeps
//              the count — is refused. Adding REASONED tests changes nothing;
//   --init     write the first baseline; refused when one already exists.
//   --root     the checkout to scan (default: this file's own checkout).
// Exit codes, each with one meaning:
//   0  ok;
//   1  the ratchet is violated (--check): a new unreasoned pin, or a baseline
//      entry that no longer exists (a stale entry keeps the ratchet honest);
//   2  refused: bad arguments; a scope root that scanned ZERO files (a scope
//      that finds nothing is wrong, not clean); a missing or malformed
//      baseline; --write that would add an entry; --init over an existing one;
//   3  the scanner crashed — never 1, which would read as a ratchet verdict.
// Deterministic: files in codepoint order, lines in file order, baseline sorted.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SPORT_KEYS } from "./lib/catalogue.ts";
import { isMainModule } from "./lib/main-module.ts";

export const SCOPE_DIRS = ["packages/engine/src/scheduling", "packages/engine/src/competition"] as const;
export const NAME_ROOTS = ["packages/engine/src", "apps/web/src"] as const;
export const SCOPE_NAME = /(standing|progression|seeding|tiebreak)[^/\\]*\.test\.ts$/i;
export const SWEEPS = /\b(forEachSport|sportCases|SPORT_KEYS|builtinModules)\b/;
export const BASELINE_PATH = "scripts/matrix/catalogue/single-sport-baseline.json";
export const REASON = /\/\/\s*single-sport:\s*\S/;
const COMMENT_LINE = /^\s*\/\//;
const TEST_CALL = /^\s*(?:it|test|describe|bench)(?:\.\w+)*\s*\(/;
const CLOSER = /^[)\]}]/;
const REOPENS = /[([{]$/;
const GENERATED_BY = "scripts/matrix/single-sport.ts";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: single-sport.ts [--check | --write | --init] [--root DIR]";

export interface Pin { file: string; line: number; sport: string; reasoned: boolean }
export interface Scan { scanned: number; perRoot: Record<string, number>; pins: Pin[] }

/** A sport-key pattern over no keys would match every empty quoted string. */
export class EmptySportList extends Error {
  constructor() {
    super("single-sport: the sport list is empty — a pattern over no keys matches every empty string");
    this.name = "EmptySportList";
  }
}

/** A named refusal: the CLI exits 2 with its message. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
const blank = (l: string): boolean => l.trim() === "";
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".test.ts")) out.push(p);
  }
}

function filesUnder(root: string, d: string): string[] {
  const abs = resolve(root, d);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  walk(abs, out);
  return out;
}

/** Which lines a `// single-sport:` reason covers (see the header). */
function reasonedLines(lines: readonly string[]): boolean[] {
  const out = lines.map(() => false);
  const cover = (from: number, to: number): void => { for (let x = from; x < to; x++) out[x] = true; };
  lines.forEach((l, i) => {
    if (!REASON.test(l)) return;
    if (!COMMENT_LINE.test(l)) { out[i] = true; return; }
    const ind = indentOf(l);
    let j = i + 1;
    while (j < lines.length && COMMENT_LINE.test(lines[j] ?? "") && indentOf(lines[j] ?? "") === ind) j++;
    const next = lines[j];
    if (next !== undefined && indentOf(next) === ind && TEST_CALL.test(next)) {
      let k = j + 1;
      for (; k < lines.length; k++) {
        const t = lines[k] ?? "";
        if (blank(t) || indentOf(t) > ind) continue;
        if (indentOf(t) === ind && CLOSER.test(t.trim())) {
          if (REOPENS.test(t.trim())) continue; // `])("row %s", (s) => {` reopens the call
          k++;
        }
        break;
      }
      cover(i, k);
      return;
    }
    let k = i + 1;
    while (k < lines.length && (blank(lines[k] ?? "") || indentOf(lines[k] ?? "") >= ind)) k++;
    cover(i, k);
  });
  return out;
}

function sportPattern(sports: readonly string[]): RegExp {
  if (sports.length === 0) throw new EmptySportList();
  const alt = sports.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(["'\`])(${alt})\\1`, "g");
}

/** Every quoted sport key on a code line of `text`, with its reasoned flag.
 *  No sweep exemption here — that is a whole-file rule (scanSingleSport). */
export function pinsIn(text: string, file: string, sports: readonly string[] = SPORT_KEYS): Pin[] {
  const re = sportPattern(sports);
  const lines = text.split("\n");
  const reasoned = reasonedLines(lines);
  const pins: Pin[] = [];
  lines.forEach((l, i) => {
    if (COMMENT_LINE.test(l)) return;
    for (const m of l.matchAll(re)) pins.push({ file, line: i + 1, sport: m[2] ?? "", reasoned: reasoned[i] ?? false });
  });
  return pins;
}

/** Does the file's CODE sweep the registry? A sweep named in a comment does not count. */
const sweeps = (text: string): boolean => text.split("\n").some((l) => !COMMENT_LINE.test(l) && SWEEPS.test(l));

export function scanSingleSport(root: string, sports: readonly string[] = SPORT_KEYS): Scan {
  const perRoot: Record<string, number> = {};
  const files = new Set<string>();
  for (const d of SCOPE_DIRS) {
    const found = filesUnder(root, d);
    perRoot[d] = found.length;
    for (const f of found) files.add(f);
  }
  for (const d of NAME_ROOTS) {
    const found = filesUnder(root, d).filter((f) => SCOPE_NAME.test(f));
    perRoot[d] = found.length;
    for (const f of found) files.add(f);
  }
  const pins: Pin[] = [];
  const rel = (abs: string): string => relative(root, abs).split(sep).join("/");
  for (const abs of [...files].sort((a, b) => byCodepoint(rel(a), rel(b)))) {
    const text = readFileSync(abs, "utf8");
    if (sweeps(text)) continue;
    pins.push(...pinsIn(text, rel(abs), sports));
  }
  return { scanned: files.size, perRoot, pins };
}

const keyOf = (p: Pin): string => `${p.file}:${p.sport}`;
const unreasonedKeys = (pins: readonly Pin[]): string[] => [...new Set(pins.filter((p) => !p.reasoned).map(keyOf))];

export function checkRatchet(pins: readonly Pin[], baseline: readonly string[]): { added: string[]; stale: string[] } {
  const now = unreasonedKeys(pins);
  return { added: now.filter((k) => !baseline.includes(k)), stale: baseline.filter((k) => !now.includes(k)) };
}

/** The committed baseline's entries. A missing or malformed file is a Refusal. */
export function loadBaseline(root: string): string[] {
  const path = resolve(root, BASELINE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Refusal(`no baseline at ${BASELINE_PATH} — restore it (a missing baseline would accept any pin), or run --init for the first one`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Refusal(`${BASELINE_PATH} does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  const b = parsed as { schemaVersion?: unknown; unreasoned?: unknown } | null;
  if (b === null || typeof b !== "object" || b.schemaVersion !== 1) throw new Refusal(`${BASELINE_PATH}: schemaVersion must be 1`);
  const list = b.unreasoned;
  if (!Array.isArray(list) || !list.every((k): k is string => typeof k === "string")) throw new Refusal(`${BASELINE_PATH}: unreasoned must be an array of strings`);
  return list;
}

const serialize = (keys: readonly string[]): string =>
  `${JSON.stringify({ schemaVersion: 1, generatedBy: GENERATED_BY, unreasoned: [...new Set(keys)].sort(byCodepoint) }, null, 2)}\n`;

const say = (s: string): void => { process.stdout.write(`${s}\n`); };
const warn = (s: string): void => { process.stderr.write(`${s}\n`); };

type Mode = "list" | "check" | "write" | "init";

export function main(argv: string[], deps: { scan?: (root: string) => Scan } = {}): number {
  let values: { check?: boolean; write?: boolean; init?: boolean; root?: string };
  try {
    // pnpm 10 passes a `--` through (`pnpm matrix:single-sport -- --check`):
    // one leading separator is dropped, so both spellings work.
    const args = argv[0] === "--" ? argv.slice(1) : argv;
    ({ values } = parseArgs({ args, options: { check: { type: "boolean" }, write: { type: "boolean" }, init: { type: "boolean" }, root: { type: "string" } } }));
  } catch (e) {
    warn(`single-sport: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const modes = (["check", "write", "init"] as const).filter((m) => values[m] === true);
  if (modes.length > 1) { warn(`single-sport: ${modes.map((m) => `--${m}`).join(" and ")} are exclusive\n${USAGE}`); return 2; }
  const mode: Mode = modes[0] ?? "list";
  try {
    return run(values.root ?? REPO_ROOT, mode, deps.scan ?? ((r) => scanSingleSport(r)));
  } catch (e) {
    if (e instanceof Refusal) { warn(`::error::single-sport: ${e.message}`); return 2; }
    warn(`::error::single-sport: the scanner crashed (exit 3 — not a ratchet verdict): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 3;
  }
}

function run(root: string, mode: Mode, scan: (root: string) => Scan): number {
  const s = scan(root);
  const roots = [...SCOPE_DIRS, ...NAME_ROOTS];
  const empty = roots.filter((d) => !((s.perRoot[d] ?? 0) > 0));
  if (s.scanned === 0 || empty.length > 0) {
    throw new Refusal(`scanned ZERO files under ${(empty.length > 0 ? empty : roots).join(", ")} in ${root} — the scope is wrong, not clean`);
  }
  const unreasoned = s.pins.filter((p) => !p.reasoned);
  const keys = unreasonedKeys(s.pins);
  for (const p of unreasoned) say(`unreasoned single-sport test: ${p.file}:${p.line} pins "${p.sport}"`);
  say(`single-sport: ${s.scanned} files scanned (${roots.map((d) => `${d} ${s.perRoot[d] ?? 0}`).join(", ")}); ${s.pins.length} pins, ${unreasoned.length} unreasoned in ${keys.length} file:sport entries`);
  const path = resolve(root, BASELINE_PATH);

  if (mode === "list") return 0;
  if (mode === "init") {
    if (existsSync(path)) throw new Refusal(`a baseline already exists at ${BASELINE_PATH} — --init writes only the first one; use --write, which can only remove entries`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialize(keys));
    say(`single-sport: first baseline written to ${BASELINE_PATH} — ${keys.length} entries`);
    return 0;
  }
  const baseline = loadBaseline(root);
  const { added, stale } = checkRatchet(s.pins, baseline);
  if (mode === "write") {
    if (added.length > 0) {
      throw new Refusal(`refusing to add to the baseline — the ratchet only turns down. Sweep with forEachSport, or add \`// single-sport: <reason>\`:\n  ${added.join("\n  ")}`);
    }
    writeFileSync(path, serialize(keys));
    say(`single-sport: baseline written — ${keys.length} entries, ${stale.length} removed`);
    return 0;
  }
  for (const k of added) warn(`::error::new unreasoned single-sport pin ${k} — sweep with forEachSport, or add \`// single-sport: <reason>\``);
  for (const k of stale) warn(`::error::stale single-sport baseline entry ${k} — run: pnpm matrix:single-sport --write (it only removes entries)`);
  if (added.length + stale.length > 0) { say(`single-sport: check FAILED — ${added.length} new, ${stale.length} stale`); return 1; }
  say(`single-sport: check passed against ${BASELINE_PATH}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
