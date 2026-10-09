// #772, rewritten for W2b (spec §5.1). `core.forfeit` carries a REQUIRED `reason`, and before #772 every shipped module
// threw it away: the handlers cast the payload as `{ by: string }`, so a walkover, a disqualification and a retirement
// folded to byte-identical outcomes (found by the B06b darts bench). #772 put the free-text reason in `award.method`.
//
// W2b closes the vocabulary (`FORFEIT_REASONS`) and moves the reason to `award.reason`, beside a typed `loser`. Chess is
// no longer the exception: its `core.forfeit` used to decide `win{method:"forfeit"}` and drop the reason on purpose
// (`CARRIES_ITS_OWN_METHOD`); the spec's chess unification (§5.2) folds it to the same `award` as the other ten, so the
// exemption is gone and the sweep below has no hole.
//
// The sweep runs over `builtinModules` × `FORFEIT_REASONS`, each reason in the phase Appendix A X-RS-1 makes it legal
// in (walkover before play; retired and disqualified after `core.start`; withdrew either — here after), so a sport
// added later is covered the day it ships.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "./events.ts";
import { FORFEIT_REASONS, type ForfeitReason, type LineupPair } from "./types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import type { AnySportModule } from "../sport/module.ts";

/** Appendix A X-RS-1: the phase each reason is recordable in — before play for a walkover, after `core.start` for the
 *  rest (withdrew is legal either side; after is the case #772 never covered). */
const STARTED_FOR: Readonly<Record<ForfeitReason, boolean>> = { walkover: false, retired: true, disqualified: true, withdrew: true };

function lineupsFor(mod: AnySportModule, cfg: unknown): LineupPair {
  return defaultLineupPair(resolvePositions(mod as never, cfg as never));
}

function foldForfeit(mod: AnySportModule, reason: ForfeitReason) {
  // The first declared variant: generic's bare schema does not parse (resultMode/allowDraws have no default).
  const cfg = mod.configSchema.parse(Object.values(mod.variants)[0] ?? {});
  const l = lineupsFor(mod, cfg);
  const events: EventEnvelope[] = [
    ...(STARTED_FOR[reason] ? [makeEnvelope(1, { type: "core.start", payload: {} })] : []),
    makeEnvelope(STARTED_FOR[reason] ? 2 : 1, { type: "core.forfeit", payload: { by: l.away.entrantId, reason } }),
  ];
  return { l, outcome: outcomeOf(mod as never, foldMatchWithStoppage(mod as never, cfg as never, l, events) as never) };
}

describe("core.forfeit carries its reason into award.reason (#772, W2b)", () => {
  it("sweeps every shipped module × every forfeit reason — 44 cases, an empty list would pass vacuously", () => {
    let checked = 0;
    const sports = forEachSport(({ module: mod }) => {
      for (const reason of FORFEIT_REASONS) {
        const { l, outcome } = foldForfeit(mod, reason);
        // The regression #772 exists for, now on the typed field, with the loser named — never `method`.
        expect(outcome, `${mod.key} ${reason}`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason });
        expect(Object.hasOwn(outcome as object, "method"), `${mod.key} ${reason}`).toBe(false);
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(44);
  });
});
