// CLI: node --experimental-strip-types scripts/matrix/render.ts <results.json> [--out MATRIX.md]
// Exit 0 rendered; 1 zero cases (file still written, with the banner) or
// canary results (nothing written); 2 usage (no file, a second file, or an
// unknown flag — never conflated with exit 1).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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

export async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`${cli.usage}\n`);
    return 2;
  }
  const results = parseResults(JSON.parse(readFileSync(cli.file, "utf8")));
  if (results.cases.some((c) => c.canary)) {
    process.stderr.write("render: refusing to render canary results — a canary run proves the harness can go red, it is not a matrix\n");
    return 1;
  }
  const out = cli.out ?? join(dirname(cli.file), "MATRIX.md");
  writeFileSync(out, renderMatrix(results));
  process.stdout.write(`render: ${results.cases.length} cases → ${out}\n`);
  return results.cases.length === 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
