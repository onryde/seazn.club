// CLI: pnpm run matrix:render -- <results.json> [--out MATRIX.md]
// Exit codes, each with one meaning:
//   0  rendered;
//   1  zero cases (the file is still written, with the banner) or canary
//      results (nothing written);
//   2  usage or input error, with a message on stderr and nothing written: no
//      file, a second file, an unknown flag, a missing or unreadable file, bad
//      JSON, results the schema refuses, or a case off the run's own grid;
//   3  a crash while it loads, through `pnpm run matrix:render` (its preload,
//      lib/crash-exit.ts, final batch F-6). Run it only through that script:
//      without the preload a load crash exits 1 (W1b carry e).
// An uncaught throw would exit 1 without the preload (3 through the package
// script), so every input failure is caught here rather than left to read as
// "zero cases".
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/main-module.ts";
import { redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { parseResults } from "./lib/results.ts";

const USAGE = "usage: render.ts <results.json> [--out MATRIX.md]";

/** The parsed command line, or the reason it is a usage error. */
function parseCli(argv: string[]): { file: string; out: string | undefined } | { usage: string } {
  try {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" } } });
    const [file, ...extra] = positionals;
    if (file === undefined || extra.length > 0) return { usage: USAGE };
    return { file, out: values.out };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

export function main(argv: string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`${cli.usage}\n`);
    return 2;
  }
  try {
    const results = parseResults(JSON.parse(readFileSync(cli.file, "utf8")));
    if (results.cases.some((c) => c.canary)) {
      process.stderr.write("render: refusing to render canary results — a canary run proves the harness can go red, it is not a matrix\n");
      return 1;
    }
    const out = cli.out ?? join(dirname(cli.file), "MATRIX.md");
    writeFileSync(out, renderMatrix(results));
    process.stdout.write(`render: ${results.cases.length} cases → ${out}\n`);
    return results.cases.length === 0 ? 1 : 0;
  } catch (e) {
    process.stderr.write(`render: ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
