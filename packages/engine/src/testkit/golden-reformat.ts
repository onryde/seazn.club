// GF-2 T1 — REFORMAT_GOLDEN: record the kernel overlay in a corpus that does not hold it yet (format 1 -> format 2).
// Design: docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md §3 (last bullet).
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
  type GoldenCorpus,
  type GoldenStream,
} from "./golden.ts";

/** A corpus's streams in format 2, or an Error naming everything that would have to change first.
 *
 *  - A format-1 corpus gains `format: 2` (written just before `streams`, which stays the last key) and, appended to every
 *    stream, `summaries` and `overlay`. Every other byte is the input's: the streams are spread, never rebuilt.
 *  - A format-2 corpus is returned as it is, after the same verification: a second run is a no-op, and a corpus whose recorded
 *    fields no longer replay is an error to repair with `REBASELINE_GOLDEN`, never a "reformat" that quietly rewrites them.
 *  - An empty corpus is refused: a reformat of nothing proves nothing. */
export function reformatCorpus(module: AnySportModule, existing: GoldenCorpus): GoldenCorpus {
  if (existing.streams.length === 0) {
    throw new Error(`REFORMAT_GOLDEN refuses ${module.key}: the corpus has no streams, so there is nothing to reformat or to verify`);
  }
  const format = corpusFormat(existing);
  const problems: string[] = [];
  const streams: GoldenStream[] = [];

  for (const stream of existing.streams) {
    const raw = existing.configs[stream.config];
    if (format === 2) {
      problems.push(...verifyStream(module, existing, stream));
      streams.push(stream);
      continue;
    }
    // Format 1: the CURRENT engine, recording under format 2, must still reproduce every field the corpus holds — states,
    // and the outcome, summary and deltas which format 2 records as the EFFECTIVE values. A hybrid (a format-1 corpus that
    // already holds a format-2 field) is a verifyStream finding of its own.
    const recomputed = recomputeStream(module, raw, stream.events, stream.lineups, 2);
    const legacyView = { states: recomputed.states, outcome: recomputed.outcome, summary: recomputed.summary, deltas: recomputed.deltas };
    const found = verifyStream(module, existing, stream, legacyView);
    problems.push(...found);
    const { summaries, overlay } = storedFields(recomputed);
    streams.push({ ...stream, summaries: summaries!, overlay: overlay! });
  }

  if (problems.length > 0) {
    throw new Error(
      `REFORMAT_GOLDEN refuses ${module.key}: ${problems.length} recorded field(s) would not survive — that is a re-baseline, not a ` +
        `reformat. Land it on its own first (REBASELINE_GOLDEN=1, its own commit, reviewed as a state diff), then reformat:\n  ` +
        problems.join("\n  "),
    );
  }
  if (format === 2) return existing;
  return withFormat2(existing, streams);
}

/** The corpus with `format: 2` just before `streams` and its streams replaced. Built key by key so the order is explicit:
 *  `streams` stays the LAST key (an EXTEND's byte-prefix check depends on it), and the rest keep the order they had. */
function withFormat2(corpus: GoldenCorpus, streams: GoldenStream[]): GoldenCorpus {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(corpus)) {
    if (key !== "streams" && key !== "format") out[key] = value;
  }
  out.format = 2;
  out.streams = streams;
  return out as unknown as GoldenCorpus;
}
