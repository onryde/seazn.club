// CLI: pnpm --silent run matrix:staleness --max-days 8
// W1d Task 8 (D1b, ruling 60: "a missed week must still be visible"): is the weekly matrix truth run overdue? Reads the
// successful runs of matrix-truth.yml through gh and says, as a workflow annotation, whether the newest SUCCESSFUL
// scheduled or dispatched run is older than --max-days (or there is none). A pull_request run does not count (it is the
// smoke scope, not the weekly run), and a failed run newer than the last success does not reset the clock.
// Exit codes, each with one meaning (the one convention, D8):
//   0  said: `::warning title=Matrix truth run is stale::<message>` when overdue, else `matrix truth run: last success
//      <date>` — and the same exit when GitHub could not be asked: a `::warning::` naming what failed (D1 is non-blocking;
//      it must never fail a PR, and an API failure warns rather than fails);
//   2  refused, nothing printed to stdout: usage (--max-days is a positive whole number of days);
//   3  a crash while it loads, through `pnpm run matrix:staleness` (its preload, scripts/lib/crash-exit.ts).
//      Run it only through that script: without the preload a load crash exits 1, which reads as a verdict.
// Every line printed passes through redact().
import { parseArgs } from "node:util";
import { isMainModule } from "../../../scripts/lib/main-module.ts";
import { redact } from "../lib/redact.ts";
import { GhFailed, realGh, successfulRuns, weeklySuccesses, type GhRunner } from "./gh.ts";

const USAGE = "usage: staleness.ts --max-days <days>";
const DAY_MS = 86_400_000;

export interface Staleness { stale: boolean; message: string; newest: string | null }

/** Whether the newest successful scheduled/dispatched run is older than `maxDays` days (strictly: a run exactly `maxDays`
 *  old is not yet overdue). `newest` is that run's created_at, or null when no run counts. */
export function staleness(runs: readonly { conclusion: string; event: string; created_at: string }[], now: Date, maxDays: number): Staleness {
  const [newest] = weeklySuccesses(runs);
  if (newest === undefined) {
    return { stale: true, newest: null, message: "no successful scheduled or dispatched run of the matrix truth workflow is on record (never): the weekly run has not completed" };
  }
  const ageDays = (now.getTime() - Date.parse(newest.created_at)) / DAY_MS;
  const date = newest.created_at.slice(0, 10);
  if (ageDays > maxDays) {
    return { stale: true, newest: newest.created_at, message: `the last successful scheduled or dispatched run of the matrix truth workflow was ${date} (${Math.floor(ageDays)} days ago; the limit is ${maxDays}): the weekly run is overdue` };
  }
  return { stale: false, newest: newest.created_at, message: `last success ${date}` };
}

/** A workflow command's data: `%`, CR and LF are escaped as the runner reads them back. */
export const commandData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export interface StalenessDeps { gh: GhRunner; env: Readonly<Record<string, string | undefined>>; now: () => Date }
const realDeps = (): StalenessDeps => ({ gh: realGh, env: process.env, now: () => new Date() });

const say = (line: string): void => { process.stdout.write(`${redact(line)}\n`); };

export function main(argv: readonly string[], deps: StalenessDeps = realDeps()): number {
  let maxDays: number;
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:staleness -- <flags>`; a bare one is never a value.
    const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { "max-days": { type: "string" } }, strict: true, allowPositionals: false });
    const text = values["max-days"];
    if (text === undefined || !/^[1-9]\d*$/.test(text)) throw new Error("--max-days is required: a positive whole number of days");
    maxDays = Number(text);
  } catch (e) {
    process.stderr.write(`${redact(`staleness: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`)}\n`);
    return 2;
  }
  try {
    const s = staleness(successfulRuns(deps.gh, deps.env.GITHUB_REPOSITORY), deps.now(), maxDays);
    say(s.stale ? `::warning title=Matrix truth run is stale::${commandData(s.message)}` : `matrix truth run: ${s.message}`);
  } catch (e) {
    if (!(e instanceof GhFailed)) throw e;
    say(`::warning::${commandData(`matrix truth staleness could not be checked — ${e.message}`)}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
