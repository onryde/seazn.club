// CLI: pnpm run matrix:pr-rows --body-file <path> --changed-file <path> [--lock-diff-file <path>]
// W1d Task 7 (R27, D13): the matrix rows a PR declares. A PR that touches packages/engine/** or
// apps/web/src/server/usecases/stages.ts declares, in its body, the rows the matrix samples:
//   Matrix rows: league, swiss        (catalogue rows)
//   Matrix rows: all                  (every row)
//   Matrix rows: none — <reason>      (a declaration of none; the fixed sample still runs)
// The CI job reads the body LIVE (a body edit fires no run, and a re-run replays the original event payload),
// writes it and the changed-file list (`git diff --name-only`, one path per line) to files, and appends this
// CLI's stdout to $GITHUB_OUTPUT. The first `Matrix rows:` line counts, and a fenced code block or an HTML comment is
// ignored (neither is a declaration: a quote of the template, and text GitHub does not render).
// Engine split 2b (plan Review Focus 5): the engine is the registry package @onryde/seazn-engine, so no PR touches
// packages/engine/** any more and an engine bump reaches this repo as a version change in pnpm-lock.yaml. The job also writes
// the lock's own diff (`git diff -- pnpm-lock.yaml`), and a diff that moves the engine's version declares like an engine path.
// Exit codes, each with one meaning (the one convention, D8):
//   0  decided: `rows=<csv|all|none>` is the whole of stdout, the one line the job appends to $GITHUB_OUTPUT;
//   1  a negative signal, stdout empty: the PR touches a declaring path and its body carries no `Matrix rows:`
//      line (R27) — each such path is named on stderr, with what to write and to re-run the job;
//   2  refused, nothing written: usage; unreadable input (a body, change list or lock diff that cannot be read); an empty
//      change list (vacuous: a PR changes a file); a declared row the catalogue lacks (UnknownRow); a change list naming
//      pnpm-lock.yaml with no lock diff given, or a lock diff that disagrees with the change list (the job's wiring is wrong);
//   3  a crash while it loads, through `pnpm run matrix:pr-rows` (its preload, scripts/lib/crash-exit.ts).
//      Run it only through that script: without the preload a load crash exits 1, which reads as a verdict.
// An uncaught throw would exit 1 without the preload, so every input failure is caught here. Every line printed
// passes through redact(): a PR body is free text, and a refused declaration is echoed back.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "../../../scripts/lib/main-module.ts";
import { ROW_KEYS } from "../lib/catalogue.ts";
import { UnknownRow, formatRows, parseRows } from "../lib/pr-sample.ts";
import { redact } from "../lib/redact.ts";

/** R27's two declaring paths, verbatim from _RULES.md: a PR touching either declares its rows. */
export const DECLARING: readonly RegExp[] = [/^packages\/engine\//, /^apps\/web\/src\/server\/usecases\/stages\.ts$/];

/** The lock whose diff carries an engine bump since engine split 2b, and the engine's name in it. */
export const LOCK = "pnpm-lock.yaml";
/** `@onryde/seazn-engine@<version>` (a version line, a package key, a snapshot key) or `@<specifier>` (an importer's specifier). */
const ENGINE_IN_LOCK = /@onryde\/seazn-engine@([~^]?\d[^\s'"(),:]*)/g;

const USAGE = "usage: pr-rows.ts --body-file <path> --changed-file <path> [--lock-diff-file <path>]";

/** What a `git diff -- pnpm-lock.yaml` does to the engine: whether it changes any line at all, and the engine versions (and
 *  specifiers) on the lines it removes and on the lines it adds. The engine moved when those two sets differ; a peer-only
 *  re-resolution rewrites the engine's lines with the version they already had, so its sets are equal. */
export function engineInLockDiff(lockDiff: string): { changesLines: boolean; removed: readonly string[]; added: readonly string[] } {
  const removed = new Set<string>();
  const added = new Set<string>();
  let changesLines = false;
  for (const line of lockDiff.split(/\r?\n/)) {
    if (/^(?:---|\+\+\+) (?:a\/|b\/|\/dev\/null)/.test(line)) continue;   // the file headers, not a change
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    changesLines = true;
    for (const m of line.matchAll(ENGINE_IN_LOCK)) (sign === "-" ? removed : added).add(m[1]);
  }
  return { changesLines, removed: [...removed].sort(), added: [...added].sort() };
}

/** The body with every fenced code block (``` or ~~~, per CommonMark: up to three spaces of indent, a closing fence of
 *  the same character and at least the opening length) removed. A quoted `Matrix rows:` line inside one is a quote of
 *  the template, not a declaration; an unterminated fence runs to the end of the body, as markdown renders it. */
export function stripFences(body: string): string {
  const kept: string[] = [];
  let open: { ch: string; len: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      // A backtick fence's info string holds no backtick: "```x``` text" is inline code, not a fence.
      if (m !== null && !(m[1][0] === "`" && m[2].includes("`"))) { open = { ch: m[1][0], len: m[1].length }; continue; }
      kept.push(line);
    } else if (m !== null && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === "") {
      open = null;
    }
  }
  return kept.join("\n");
}

/** The text with every HTML comment (`<!-- … -->`, on one line or across several) removed. GitHub does not render a
 *  comment, so a `Matrix rows:` line inside one is invisible to the author and the reviewer: reading it would be a fail-open
 *  (the job would sample rows nobody can see declared). An unterminated comment hides the rest of the text, as the rendering
 *  does. Run it AFTER stripFences: a `<!--` quoted inside a code fence is text, and must not hide what follows the fence.
 *  What stays is joined as it was, so text glued to a comment keeps its own line start. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/** The first `Matrix rows:` line that carries a value (a label with nothing after it, on its own line, declares
 *  nothing — `[ \\t]*`, not `\\s*`, so it never borrows the next line as its value). null: the body declares nothing,
 *  which is not `none`. Throws UnknownRow for a row the catalogue lacks. */
export function rowsFromBody(body: string): readonly string[] | "all" | null {
  const m = /^Matrix rows:[ \t]*(\S.*)$/im.exec(stripComments(stripFences(body)));
  return m === null ? null : parseRows(m[1]);
}

export type Decision =
  | { readonly exit: 0; readonly rows: readonly string[] | "all" }
  | { readonly exit: 1 | 2; readonly why: string };

/** What a PR's body, changed files and lock diff decide. `changed` is the raw lines of the change list: blanks and a CR from a
 *  CRLF file are dropped, and none left is refused (a PR with no changed file is a wiring fault, never "no rows"). `lockDiff`
 *  is the job's `git diff -- pnpm-lock.yaml`; it must agree with the change list (the lock listed exactly when its diff changes
 *  a line), and a change list naming the lock with no lock diff given is refused: an engine bump would pass undeclared. */
export function decide(input: { body: string; changed: readonly string[]; lockDiff?: string | undefined }): Decision {
  const changed = input.changed.map((l) => l.trim()).filter((l) => l !== "");
  if (changed.length === 0) return { exit: 2, why: "no changed file in the change list — nothing to decide from (vacuous); a PR changes at least one file, so the list the job wrote is wrong" };
  const lockListed = changed.includes(LOCK);
  let engineBump: string | null = null;
  if (input.lockDiff === undefined) {
    if (lockListed) return { exit: 2, why: `the change list names ${LOCK} but no lock diff was given (--lock-diff-file): whether it moves @onryde/seazn-engine cannot be decided, so the job's wiring is wrong` };
  } else {
    const lock = engineInLockDiff(input.lockDiff);
    if (lock.changesLines !== lockListed) {
      return { exit: 2, why: lockListed
        ? `the change list names ${LOCK} but its lock diff changes no line: the two files the job wrote disagree`
        : `the lock diff changes lines of ${LOCK} but the change list does not name it: the two files the job wrote disagree` };
    }
    if (lock.removed.join(" ") !== lock.added.join(" ")) {
      engineBump = `${LOCK} (@onryde/seazn-engine ${lock.removed.join(", ") || "absent"} → ${lock.added.join(", ") || "absent"})`;
    }
  }
  let declared: readonly string[] | "all" | null;
  try {
    declared = rowsFromBody(input.body);
  } catch (e) {
    if (e instanceof UnknownRow) return { exit: 2, why: `${e.name}: ${e.message}` };
    throw e;
  }
  if (declared !== null) return { exit: 0, rows: declared };
  const touched = [...changed.filter((f) => DECLARING.some((re) => re.test(f))), ...(engineBump === null ? [] : [engineBump])];
  if (touched.length === 0) return { exit: 0, rows: [] };
  return {
    exit: 1,
    why: `R27: this PR touches ${touched.length} path(s) that declare matrix rows — ${touched.join(", ")} — and its body has no \`Matrix rows:\` line. `
      + `Edit the PR body to add one (\`Matrix rows: league, swiss\`, \`Matrix rows: all\` or \`Matrix rows: none — <reason>\`; rows: ${ROW_KEYS.join(", ")}), `
      + "then re-run this job: it reads the body live, so a re-run picks the edit up.",
  };
}

const write = (stream: NodeJS.WriteStream, s: string): void => { stream.write(`${redact(s)}\n`); };

export function main(argv: readonly string[]): number {
  let bodyFile: string;
  let changedFile: string;
  let lockDiffFile: string | undefined;
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:pr-rows -- <flags>`; a bare one is never a value.
    const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { "body-file": { type: "string" }, "changed-file": { type: "string" }, "lock-diff-file": { type: "string" } }, strict: true, allowPositionals: false });
    if (values["body-file"] === undefined || values["changed-file"] === undefined) throw new Error("--body-file and --changed-file are both required");
    bodyFile = values["body-file"];
    changedFile = values["changed-file"];
    lockDiffFile = values["lock-diff-file"];
  } catch (e) {
    write(process.stderr, `pr-rows: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const read = (flag: string, path: string): string | null => {
    try { return readFileSync(path, "utf8"); } catch (e) {
      write(process.stderr, `pr-rows: ${flag} ${path} is unreadable — ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const body = read("--body-file", bodyFile);
  if (body === null) return 2;
  const changed = read("--changed-file", changedFile);
  if (changed === null) return 2;
  let lockDiff: string | undefined;
  if (lockDiffFile !== undefined) {
    const text = read("--lock-diff-file", lockDiffFile);
    if (text === null) return 2;
    lockDiff = text;
  }
  const d = decide({ body, changed: changed.split("\n"), lockDiff });
  if (d.exit === 0) {
    process.stdout.write(`rows=${formatRows(d.rows)}\n`);
    return 0;
  }
  write(process.stderr, `pr-rows: ${d.why}`);
  return d.exit;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
