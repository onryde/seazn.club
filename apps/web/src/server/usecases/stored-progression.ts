import { EngineError } from "@seazn/engine/core";
import { HttpError } from "@/lib/errors";
import {
  resolveProgression,
  type ProgressionSource,
  type ProgressionSpec,
  type SlotDescriptor,
  type SourceShape,
  type SourceTables,
  type TakeRule,
} from "@seazn/engine/competition";

// W4 app PR B (C5/C9): the ONE boundary between a STORED progression and the engine's 0-BASED bracket rounds.
//
// `loadBracketFixtures` hands the engine its rows in ENGINE rounds (0 = the opening round of a lane, which `firstLossField`
// and a stepladder rung's due round need). A stored `roundLosers.round` was written against `fixtures.round_no` (1 = the
// opening round of the winners' side) and stays that way: it is in saved stages, templates and the OpenAPI shape, and a
// stage graph that was valid yesterday must resolve the same cut today. So the rule is translated on the way IN
// (`round - 1`) and a resolved `round_loser` descriptor on the way OUT (`round + 1`), which keeps every STORED thing that
// names a descriptor - a seed proposal's slot key, a `seeded_map` source (`loser:R:P`), a tie flag - in the numbering it was
// saved in. Nothing else about the spec changes.

const LOSER_KEY = /^loser:(\d+):(\d+)$/;

const takeToEngine = (t: TakeRule): TakeRule => (t.kind === "roundLosers" ? { ...t, round: t.round - 1 } : t);

function specToEngine(spec: ProgressionSpec): ProgressionSpec {
  return {
    ...spec,
    sources: spec.sources.map((s): ProgressionSource => ({ ...s, take: s.take.map(takeToEngine) })),
    ...(spec.map !== undefined
      ? {
          map: spec.map.map((m) => {
            const hit = LOSER_KEY.exec(m.source);
            return hit === null ? m : { ...m, source: `loser:${Number(hit[1]) - 1}:${hit[2]}` };
          }),
        }
      : {}),
  };
}

const descriptorToStored = (d: SlotDescriptor): SlotDescriptor => (d.kind === "round_loser" ? { ...d, round: d.round + 1 } : d);

/** Review M4: the engine's round-loser read filters `f.round === round` with no lane, and since PR B a double-elimination
 *  source's winners' side, losers' side and grand final all number from 0. A `roundLosers` take against one would mix the
 *  lanes' losers without a word, so it is REFUSED by name instead (prod holds no double-elimination stage). */
export function refuseRoundLosersFromDoubleElim(spec: ProgressionSpec, sourceKinds: readonly string[]): void {
  spec.sources.forEach((s, i) => {
    if (sourceKinds[i] === "double_elim" && s.take.some((t) => t.kind === "roundLosers")) {
      throw new HttpError(
        422,
        "a double-elimination source cannot feed a stage by round losers: its lanes number their rounds separately",
        "SEEDING_ROUNDLOSERS_DE_SOURCE",
        { sourceIndex: i },
      );
    }
  });
}

export function resolveStoredProgression(
  spec: ProgressionSpec,
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
  targetKind: string | undefined,
  sourceKinds: readonly string[],
): ReturnType<typeof resolveProgression> {
  refuseRoundLosersFromDoubleElim(spec, sourceKinds);
  let out: ReturnType<typeof resolveProgression>;
  try {
    out = resolveProgression(specToEngine(spec), shapes, tables, targetKind);
  } catch (e) {
    // The engine names the round it was asked about, in ITS numbering; the refusal an organiser (or an API client) reads
    // keeps the stored one.
    if (e instanceof EngineError && e.code === "QUALIFICATION_INVALID" && typeof (e.data as { round?: unknown } | undefined)?.round === "number") {
      const data = e.data as { round: number };
      const stored = data.round + 1;
      throw new EngineError(e.code, e.message.replace(/bracket round \d+ /, `bracket round ${stored} `), { ...data, round: stored });
    }
    throw e;
  }
  return {
    ...out,
    qualifiers: out.qualifiers.map((q) => ({ ...q, descriptor: descriptorToStored(q.descriptor) })),
    ties: out.ties.map((t) => ({ ...t, descriptors: t.descriptors.map((s) => ({ ...s, descriptor: descriptorToStored(s.descriptor) })) })),
  };
}
