// The engine's recorded corpora and its bye-deltas fixture, for the app suites that read them (engine-split 2b Task R1;
// reverse-inventory rows 5, 7, 8, 9). Until 2b those suites opened `packages/engine/src/sports/**/*.golden.json` by repo path; once
// the engine is an installed package there is no such path, so the data ships and this module is the one way to read it.
//
// The files are found by ONE URL from this module: `../sports` and `../sport/__fixtures__` are right from `src/testkit/` in the
// workspace and from `dist/testkit/` in the tarball, because `build:dist` copies the JSON to the same relative place under dist/
// (scripts/copy-dist-data.mjs). That is the same trick `rules-reference.ts` plays with `../../rules`, and it is proved the same
// way: pack-proof/node/corpora.mjs runs this reader from the INSTALLED tarball and holds its count against the workspace's.
//
// Like rules-reference.ts this reads the disk, and the testkit barrel's disk-reading closure is pinned to exactly the two of them
// (test/rules-reference.test.ts). The corpus WRITER and the recorder stay out of the barrel: they are not here, only the readers.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SPORTS_DIR = fileURLToPath(new URL("../sports", import.meta.url));
const BYE_DELTAS_FILE = fileURLToPath(new URL("../sport/__fixtures__/bye-deltas.json", import.meta.url));

export interface GoldenCorpusFile {
  /** The directory under `sports/` that holds the file: `setbased` for badminton, volleyball and tabletennis. */
  sport: string;
  /** The module key, read from the file name `<key>.golden.json` (and equal to the corpus's own `key`). */
  key: string;
  /** The parsed corpus. Shape is the recorder's `GoldenCorpus` (`key`, `configs`, `streams`, ...); typed by the consumer that reads it. */
  corpus: unknown;
}

const SUFFIX = ".golden.json";

/** Walk `sportsDir` for `*.golden.json`, ordered by path. Exported for its own tests; the barrel hands out `goldenCorpora` only. */
export function readGoldenCorpora(sportsDir: string): GoldenCorpusFile[] {
  const files = (readdirSync(sportsDir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(SUFFIX))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A reader that found nothing would hand every consumer sweep an empty list, which passes for the wrong reason.
  if (files.length === 0) throw new Error(`no *${SUFFIX} corpus under ${sportsDir}`);
  return files.map((file) => {
    const slash = file.lastIndexOf("/");
    if (slash === -1) throw new Error(`${file}: a corpus file directly under ${sportsDir} has no sport directory to name it by`);
    const sport = file.slice(0, slash).split("/")[0]!;
    const key = file.slice(slash + 1, -SUFFIX.length);
    const corpus: unknown = JSON.parse(readFileSync(join(sportsDir, file), "utf8"));
    const own = typeof corpus === "object" && corpus !== null ? (corpus as { key?: unknown }).key : undefined;
    if (own !== key) throw new Error(`${file}: the corpus is for ${JSON.stringify(own)}, but its file name says ${JSON.stringify(key)}`);
    return { sport, key, corpus };
  });
}

/** Every corpus the engine records, one per module, read fresh from disk on each call and ordered by path. */
export function goldenCorpora(): GoldenCorpusFile[] {
  return readGoldenCorpora(SPORTS_DIR);
}

/** `sport/__fixtures__/bye-deltas.json`: per module key, per declared variant, per seat, the delta a bye credits (spec C-5). */
export function byeDeltas(): unknown {
  return JSON.parse(readFileSync(BYE_DELTAS_FILE, "utf8"));
}
