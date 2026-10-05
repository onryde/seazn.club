// CLI: pnpm matrix:lock-check --against <git-ref> [--lock <path>]
// Exit codes (the one convention, D8):
//   0  append-only: every base entry unchanged (count printed);
//   1  an entry was removed or edited — each named on stderr;
//   2  refused, nothing judged: usage, a ref or file git cannot read, JSON
//      that is not a lock, or ZERO base entries compared (vacuous, R25).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { lockChanges, type LockFile } from "./lib/lock-diff.ts";

export const DEFAULT_LOCK = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json";

function asLock(text: string, what: string): LockFile {
  const v: unknown = JSON.parse(text);
  if (v === null || typeof v !== "object" || typeof (v as { runs?: unknown }).runs !== "object" || (v as { runs: unknown }).runs === null) {
    throw new Error(`${what} is not a plans lock (no "runs" object)`);
  }
  return v as LockFile;
}

export function main(argv: readonly string[]): number {
  let against: string; let lock: string;
  try {
    const { values } = parseArgs({ args: [...argv], options: { against: { type: "string" }, lock: { type: "string" } }, strict: true, allowPositionals: false });
    if (values.against === undefined) throw new Error("--against <git-ref> is required");
    against = values.against; lock = values.lock ?? DEFAULT_LOCK;
  } catch (e) { console.error(`lock-append-only: ${(e as Error).message}`); return 2; }
  let base: LockFile; let head: LockFile;
  try {
    base = asLock(execFileSync("git", ["show", `${against}:${lock}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), `${against}:${lock}`);
    head = asLock(readFileSync(lock, "utf8"), lock);
  } catch (e) { console.error(`lock-append-only: cannot read the locks — ${(e as Error).message.split("\n")[0]}`); return 2; }
  const r = lockChanges(base, head);
  if (r.compared === 0) { console.error(`lock-append-only: ${against}:${lock} holds zero entries — nothing was compared (vacuous)`); return 2; }
  for (const c of r.changed) console.error(`${c.run}: ${c.kind} — plans.lock.json is append-only (item 1); a committed run's plan never changes`);
  if (r.changed.length > 0) return 1;
  console.log(`lock-append-only: ${r.compared} entries compared, ${r.added.length} added`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
