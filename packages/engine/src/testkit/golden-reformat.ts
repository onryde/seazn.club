// GF-2 T1/T4 — REFORMAT_GOLDEN: record the fields a corpus does not hold yet (format 1 -> 2 adds the kernel overlay, 2 -> 3 the final
// player stats). Design: docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md §3 (last bullet) and §7 (T4).
//
// A reformat is NOT a re-baseline, and the whole of this file is the difference. `rebaselineCorpus` recomputes the derived half
// of a corpus and the diff IS the behaviour change; `reformatCorpus` only ADDS fields, so the diff must contain no behaviour
// change at all. That is checked, not assumed: every stream is replayed under the CURRENT engine against the bytes the corpus
// already holds (`verifyStream`, the same gate the replay test runs), and one disagreement refuses the whole reformat. A corpus
// that is already red needs its own re-baseline first, in its own commit.
//
// Pure: no I/O. `golden.test.ts` reads the corpus, calls this, and writes the result under the same dirty-tree refusal as a
// re-baseline.
import type { AnySportModule } from "../sport/module.ts";
import {
  corpusFormat,
  recomputeStream,
  storedFields,
  verifyStream,
  type CorpusFormat,
  type GoldenCorpus,
  type GoldenStream,
  type ReplayedStream,
} from "./golden.ts";

/** A corpus brought up to format `target` (2 or 3), or an Error naming everything that would have to change first.
 *
 *  - A corpus in an earlier format gains `format: <target>` (written just before `streams`, which stays the last key) and, appended
 *    to every stream, the fields of the formats it skips: `summaries` and `overlay` going 1 -> 2, `playerStats` going 2 -> 3 (so
 *    1 -> 3 appends all three, in that order). Every other byte is the input's: the streams are spread, never rebuilt.
 *  - A corpus already in `target` is returned as it is, after the same verification: a second run is a no-op, and a corpus whose
 *    recorded fields no longer replay is an error to repair with `REBASELINE_GOLDEN`, never a "reformat" that quietly rewrites them.
 *  - A corpus in a LATER format than `target` is refused: a corpus never goes back to an earlier format.
 *  - An empty corpus is refused: a reformat of nothing proves nothing. */
export function reformatCorpus(module: AnySportModule, existing: GoldenCorpus, target: CorpusFormat): GoldenCorpus {
  if (existing.streams.length === 0) {
    throw new Error(`REFORMAT_GOLDEN refuses ${module.key}: the corpus has no streams, so there is nothing to reformat or to verify`);
  }
  const format = corpusFormat(existing);
  if (format > target) {
    throw new Error(
      `REFORMAT_GOLDEN refuses ${module.key}: the corpus is in format ${format} and cannot be reformatted to format ${target} — a corpus never goes back to an earlier format`,
    );
  }
  if (target === 1) {
    throw new Error(`REFORMAT_GOLDEN refuses ${module.key}: format 1 is the format before the first reformat, so there is nothing to reformat to`);
  }
  const problems: string[] = [];
  const streams: GoldenStream[] = [];

  for (const stream of existing.streams) {
    const raw = existing.configs[stream.config];
    if (format === target) {
      problems.push(...verifyStream(module, existing, stream));
      streams.push(stream);
      continue;
    }
    // An earlier format: the CURRENT engine, recording under `target`, must still reproduce every field the corpus holds — states,
    // and the outcome, summary and deltas which format 2 records as the EFFECTIVE values (and, from format 2, the summaries and
    // overlay). The view handed to verifyStream is the corpus's OWN format's: a hybrid (a corpus that already holds a later
    // format's field) is a verifyStream finding of its own.
    const recomputed = recomputeStream(module, raw, stream.events, stream.lineups, target);
    const ownView: ReplayedStream =
      format === 1
        ? { states: recomputed.states, outcome: recomputed.outcome, summary: recomputed.summary, deltas: recomputed.deltas }
        : { states: recomputed.states, outcome: recomputed.outcome, summary: recomputed.summary, deltas: recomputed.deltas, summaries: recomputed.summaries, overlay: recomputed.overlay };
    problems.push(...verifyStream(module, existing, stream, ownView));
    const fresh = storedFields(recomputed);
    const added: Partial<GoldenStream> = {};
    if (format < 2) {
      added.summaries = fresh.summaries!;
      added.overlay = fresh.overlay!;
    }
    if (format < 3 && target === 3) added.playerStats = fresh.playerStats!;
    streams.push({ ...stream, ...added });
  }

  if (problems.length > 0) {
    throw new Error(
      `REFORMAT_GOLDEN refuses ${module.key}: ${problems.length} recorded field(s) would not survive — that is a re-baseline, not a ` +
        `reformat. Land it on its own first (REBASELINE_GOLDEN=1, its own commit, reviewed as a state diff), then reformat:\n  ` +
        problems.join("\n  "),
    );
  }
  if (format === target) return existing;
  return withFormat(existing, target, streams);
}

/** The corpus with `format: <format>` just before `streams` and its streams replaced. Built key by key so the order is explicit:
 *  `streams` stays the LAST key (an EXTEND's byte-prefix check depends on it), and the rest keep the order they had. */
function withFormat(corpus: GoldenCorpus, format: CorpusFormat, streams: GoldenStream[]): GoldenCorpus {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(corpus)) {
    if (key !== "streams" && key !== "format") out[key] = value;
  }
  if (format !== 1) out.format = format;
  out.streams = streams;
  return out as unknown as GoldenCorpus;
}

/** One sport of a reformat: the corpus as it was and as it would be written. */
export interface ReformatPlanned {
  readonly module: AnySportModule;
  readonly before: GoldenCorpus;
  readonly after: GoldenCorpus;
}

/** `reformatCorpus` for every module, ALL-OR-NOTHING: every sport is computed before the caller is handed a single corpus to write,
 *  and if any sport refuses, this throws one error naming every refusing sport and the caller has written nothing. (Writing sport
 *  by sport left a tree half in format 2 when the fifth sport refused: no state anyone can review or revert by `git diff`.) */
export function reformatAll(
  modules: readonly AnySportModule[],
  read: (key: string) => GoldenCorpus,
  target: CorpusFormat,
): ReformatPlanned[] {
  if (modules.length === 0) throw new Error("REFORMAT_GOLDEN refuses: no sport to reformat, and a reformat of nothing proves nothing");
  const planned: ReformatPlanned[] = [];
  const refusals: string[] = [];
  for (const module of modules) {
    const before = read(module.key);
    try {
      planned.push({ module, before, after: reformatCorpus(module, before, target) });
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (refusals.length > 0) {
    throw new Error(`REFORMAT_GOLDEN wrote nothing: ${refusals.length} of ${modules.length} sport(s) refused, and a reformat is all sports or none.\n${refusals.join("\n")}`);
  }
  return planned;
}

/** The corpus as FORMAT 1 (no `format` marker; no `summaries`, no `overlay`, no `playerStats`), every other key and byte in place. A
 *  corpus already in format 1 comes back equal. It exists so a test can state what a reformat does to "a format-1 corpus" without
 *  caring which format the committed files are in today, and it is not a downgrade path: nothing writes its result. */
export function asFormatOne(corpus: GoldenCorpus): GoldenCorpus {
  const { format: _format, ...rest } = corpus;
  return {
    ...rest,
    streams: corpus.streams.map(({ summaries: _summaries, overlay: _overlay, playerStats: _playerStats, ...old }) => old),
  };
}

/** The corpus as FORMAT 2 (the kernel fields, no `playerStats`), `format: 2` just before `streams`. The committed files are in
 *  format 2 or 3 depending on where the history stands; a test that states what a 2 -> 3 reformat does reads them through this.
 *  A corpus that is not yet in format 2 has no summaries or overlay to keep, and is refused. Not a downgrade path either. */
export function asFormatTwo(corpus: GoldenCorpus): GoldenCorpus {
  if (corpusFormat(corpus) < 2) throw new Error(`asFormatTwo: the ${corpus.key} corpus is in format 1 and has no kernel fields to keep`);
  return withFormat(corpus, 2, corpus.streams.map(({ playerStats: _playerStats, ...kept }) => kept));
}
