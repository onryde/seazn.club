// The `/api/health` HTTP-check interval, read from the Fly configs that deploy
// this app. lib/db.ts's idle timeout must stay ABOVE it: the health route runs
// `select 1` on the pool, so a timeout at or below the interval re-dials on
// every check — the ~24.7k reconnects in 6 days that prod showed at 20 s.
//
// Read from the files rather than typed into the test, so slowing the check or
// lowering the timeout is what reddens it — not a literal compared with itself.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

export const FLY_CONFIGS = ["fly.toml", "fly.stg.toml"] as const;

const UNIT_S: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

/** Seconds between `/api/health` checks in one fly config. Throws — never
 *  returns a default — when the check or its interval cannot be found, so a
 *  renamed path or reshaped block fails loudly instead of passing vacuously. */
export function healthCheckIntervalS(file: (typeof FLY_CONFIGS)[number]): number {
  const toml = readFileSync(join(REPO_ROOT, file), "utf8");
  const blocks = toml
    .split(/^\s*\[\[http_service\.checks\]\]\s*$/m)
    .slice(1)
    // A block ends at the next table header (`[[vm]]`, `[env]`, …).
    .map((b) => b.split(/^\s*\[/m)[0] ?? "");
  const health = blocks.find((b) => /^\s*path\s*=\s*"\/api\/health"\s*$/m.test(b));
  if (!health) throw new Error(`${file}: no [[http_service.checks]] block for /api/health`);
  const m = /^\s*interval\s*=\s*"(\d+(?:\.\d+)?)(ms|s|m|h)"\s*$/m.exec(health);
  const unit = m ? UNIT_S[m[2] ?? ""] : undefined;
  if (!m || unit === undefined) throw new Error(`${file}: /api/health check has no parseable interval`);
  return Number(m[1]) * unit;
}
