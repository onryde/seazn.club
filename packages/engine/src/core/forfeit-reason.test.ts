// `core.forfeit` carries a REQUIRED `reason` (`events.ts:52` —
// `z.strictObject({ by: EntrantId, reason: z.string().min(1) })`), and until
// this suite existed every shipped module threw it away: all four handlers cast
// the payload as `{ by: string }` and never read the second field. The fixture
// came out `{ kind: "award", winner }`, which records THAT a side forfeited and
// loses WHY — so a walkover, a disqualification and a retirement were
// indistinguishable downstream, for every sport.
//
// Found by the B06b darts bench, which wanted to state a walkover and could
// only reach `method: "regulation"` through a result card — an encoding that
// credits a score nobody played, which then flows into player stats as real.
//
// The sweep runs over `builtinModules` rather than a hand-listed four, so a
// sport added later is covered the day it ships rather than the day someone
// remembers this file. "One sample is not a parity sweep" is a standing rule
// here, and a forfeit is exactly the kind of shared-kernel behaviour that looks
// identical in one sport and diverges in the next.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "./events.ts";
import type { LineupPair, MatchOutcome } from "./types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { builtinModules } from "../sports/index.ts";
import type { AnySportModule } from "../sport/module.ts";

const REASON = "walkover";

/** The ONE module that does not carry the reason, and why.
 *
 *  `boardgame` already puts a MEANINGFUL value in `outcome.method` — its typed
 *  `BoardgameMethod`, "forfeit" (`boardgame.ts:619`) — where the other ten
 *  leave the field empty. Filling it from `core.forfeit`'s free-text `reason`
 *  would overwrite a classification with prose, and `boardgame.test.ts:74`
 *  pins that classification on purpose. Boardgame states a walkover through
 *  its own `boardgame.result` method enum instead.
 *
 *  Declared here rather than left as a silent hole in the loop below: an
 *  exemption nobody can see is how a sweep quietly stops sweeping. */
const CARRIES_ITS_OWN_METHOD = new Set(["boardgame"]);

/** Almost every module parses an empty config. `generic` is the exception — it
 *  has two fields with no default (`resultMode`, `allowDraws`), because an
 *  unknown sport has to be TOLD whether it keeps score. */
const CFG_SEED: Readonly<Record<string, unknown>> = {
  generic: { resultMode: "win_loss", allowDraws: false },
};

function lineupsFor(mod: AnySportModule, cfg: unknown): LineupPair {
  return defaultLineupPair(resolvePositions(mod as never, cfg as never));
}

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

/** The forfeiting side is "A", so every module should award to "H". */
function foldForfeit(mod: AnySportModule): MatchOutcome | null {
  const cfg = mod.configSchema.parse(CFG_SEED[mod.key] ?? {});
  const state = foldMatch(
    mod as never,
    cfg as never,
    lineupsFor(mod, cfg),
    stream(["core.start"], ["core.forfeit", { by: "A", reason: REASON }]) as never,
  );
  return (mod as { outcome: (s: unknown) => MatchOutcome | null }).outcome(state);
}

describe("core.forfeit carries its reason into the outcome", () => {
  it("sweeps every shipped module — an empty list would pass vacuously", () => {
    expect(builtinModules.length).toBeGreaterThanOrEqual(10);
  });

  for (const mod of builtinModules) {
    it(`${mod.key}: the reason survives the fold`, () => {
      const outcome = foldForfeit(mod);
      expect(outcome).not.toBeNull();
      // TWO branches are legitimate here, and asserting one was this test's own
      // first bug. Ten modules decide a forfeit as `award`; `boardgame` decides
      // it as `win` — which is why `method` belongs on BOTH branches of
      // `MatchOutcome` rather than as a new field on one. What matters to every
      // caller is that the fixture is DECIDED and says why.
      expect(["award", "win"]).toContain(outcome?.kind);
      // The regression this file exists for.
      expect(outcome as { method?: string }).toMatchObject({
        method: CARRIES_ITS_OWN_METHOD.has(mod.key) ? "forfeit" : REASON,
      });
    });

    it(`${mod.key}: awards against the forfeiting side`, () => {
      expect(foldForfeit(mod)).toMatchObject({ winner: "H" });
    });
  }
});
