// X-PH-1 (pad wave P4.2): a match's terminal phases are `done`, `final` and `abandoned`, declared once as POST_PHASES.
//
// Every expectation below is the rulebook's, typed out here (cross-sport.md X-PH-1; cricket.md: "Cricket has no
// 'abandoned' phase: an abandon decides (done)"). None is read back from POST_PHASES or from a skin. The sweep walks the
// whole sport registry (11 sports) through the engine's own events - a play-out to a decision, `core.finalize`,
// `core.forfeit` and `core.abandon` - and judges the phase each one leaves.
import { describe, expect, it } from "vitest";
import * as padBarrel from "../pad/index.ts";
import type { AnySportModule } from "../sport/module.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { playWalk, SANCTION_SWEEP_SEEDS } from "../testkit/sanction-score.ts";
import { EngineError } from "./errors.ts";
import * as coreBarrel from "./index.ts";
import { POST_PHASES } from "./phase-tokens.ts";

/** The three terminal phases the rulebook names (X-PH-1), in a fixed order. */
const RULEBOOK_POST_PHASES = ["abandoned", "done", "final"] as const;

/** Which of those each sport's state union carries. Cricket's union is `pre|live|super_over|done|final`. */
const TERMINAL_PHASES_OF = (key: string): readonly string[] => (key === "cricket" ? ["done", "final"] : RULEBOOK_POST_PHASES);

/** The cfg keys under which a module takes an abandon policy; each value one module accepts is tried. */
const ABANDON_POLICIES = ["replay", "award", "share", "q4_stands"] as const;

const ev = (seq: number, type: string, payload: unknown = {}) => makeEnvelope(seq, { type, payload });
const codeOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return EngineError.is(e) ? e.code : String(e);
  }
};
// The fold's module methods are typed against each sport's own state; this sweep drives all eleven through one shape.
type Loose = { apply(s: never, e: never): unknown; init(c: never, l: never): unknown };
const loose = (m: AnySportModule) => m as unknown as Loose & AnySportModule;
const phaseOf = (state: unknown): string => (state as { phase: string }).phase;

interface Reach {
  /** phase -> what drove the module there, for the failure message and the coverage assertions. */
  readonly seen: Map<string, string[]>;
}
const note = (reach: Reach, phase: string, how: string) => {
  const list = reach.seen.get(phase) ?? [];
  list.push(how);
  reach.seen.set(phase, list);
};

describe("X-PH-1: a match's terminal phases are done, final and abandoned (POST_PHASES)", () => {
  it("X-PH-1: POST_PHASES is exactly the rulebook's three tokens, and nothing can change it", () => {
    expect([...POST_PHASES].sort()).toEqual([...RULEBOOK_POST_PHASES]);
    expect(POST_PHASES.size).toBe(3);
    // The tokens in play are NOT terminal: a set that swallowed one of them would call a live match over.
    for (const live of ["pre", "live", "tiebreak", "super_over", "SHOOTOUT", "H1", "ET_H1"]) {
      expect(POST_PHASES.has(live), live).toBe(false);
    }
    // Frozen for real: a frozen Set still takes `add`, so the mutators refuse, and a refusal leaves the set as it was.
    const mutable = POST_PHASES as unknown as Set<string>;
    expect(Object.isFrozen(POST_PHASES)).toBe(true);
    expect(() => mutable.add("live")).toThrow(TypeError);
    expect(() => mutable.delete("done")).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect([...POST_PHASES].sort()).toEqual([...RULEBOOK_POST_PHASES]);
  });

  it("X-PH-1: the engine's `core` barrel and its `pad` subpath hand out this one set", () => {
    expect(coreBarrel.POST_PHASES).toBe(POST_PHASES);
    expect(padBarrel.POST_PHASES).toBe(POST_PHASES);
  });

  it("X-PH-1: every sport's finish, finalize, forfeit and abandon lands in POST_PHASES, and every token is reached", () => {
    const reachedBy = new Map<string, Set<string>>(RULEBOOK_POST_PHASES.map((t) => [t, new Set<string>()]));
    let finishes = 0;
    let finalizes = 0;
    let forfeits = 0;
    let abandons = 0;

    const sports = forEachSport(({ module, key }) => {
      const m = loose(module);
      const lineups = defaultLineupPair(m.positions);
      const reach: Reach = { seen: new Map() };
      const cfgs = declaredCfgs(module);

      // FINISH: the module's own generator plays the first declared cfg to a decision. A sport that never decides within
      // the sweep budget is a failure to reach the thing under test, not a pass.
      let decided: unknown = null;
      for (const seed of SANCTION_SWEEP_SEEDS) {
        const walk = playWalk(module, cfgs[0]!.cfg, lineups, seed);
        const last = walk.states.at(-1);
        if (last !== undefined && module.outcome(last) !== null) {
          decided = last;
          break;
        }
      }
      expect(decided, `${key}: no seed of the generator plays it to a decision`).not.toBeNull();
      note(reach, phaseOf(decided), "play to a decision");
      finishes++;

      // FINALIZE: the decided match is locked.
      const finalised = m.apply(decided as never, ev(9000, "core.finalize") as never);
      note(reach, phaseOf(finalised), "core.finalize after a decision");
      finalizes++;

      for (const { name, cfg } of cfgs) {
        const started = m.apply(m.init(cfg as never, lineups as never) as never, ev(1, "core.start") as never);

        // FORFEIT: a walkover before anything is played, by the home side.
        const forfeited = m.apply(started as never, ev(2, "core.forfeit", { by: "H", reason: "walkover" }) as never);
        note(reach, phaseOf(forfeited), `core.forfeit walkover (${name})`);
        forfeits++;

        // ABANDON: under the cfg as declared, and under each abandon policy the module's schema takes.
        const policies: Array<[string, unknown]> = [["as declared", cfg]];
        if (typeof cfg === "object" && cfg !== null && "abandonPolicy" in cfg) {
          for (const p of ABANDON_POLICIES) {
            const parsed = module.configSchema.safeParse({ ...(cfg as object), abandonPolicy: p });
            if (parsed.success) policies.push([p, parsed.data]);
          }
        }
        for (const [label, policyCfg] of policies) {
          const live = m.apply(m.init(policyCfg as never, lineups as never) as never, ev(1, "core.start") as never);
          const abandoned = m.apply(live as never, ev(2, "core.abandon", { reason: "rain" }) as never);
          note(reach, phaseOf(abandoned), `core.abandon, ${name}, policy ${label}`);
          abandons++;
        }
      }

      // Every phase this sport reached is terminal in the rulebook's sense, and is exactly the set the sport declares.
      for (const [phase, how] of reach.seen) {
        expect(POST_PHASES.has(phase), `${key}: phase "${phase}" reached by ${how[0]} is not in POST_PHASES`).toBe(true);
        reachedBy.get(phase)?.add(key);
      }
      expect([...reach.seen.keys()].sort(), `${key}: the terminal phases it reached`).toEqual([...TERMINAL_PHASES_OF(key)].sort());
    });

    // eslint-disable-next-line no-console
    console.info(`[X-PH-1] sports ${sports}, finishes ${finishes}, finalizes ${finalizes}, forfeits ${forfeits}, abandons ${abandons}`);
    expect(sports).toBe(11);
    expect(finishes).toBe(11);
    expect(finalizes).toBe(11);
    expect(forfeits).toBeGreaterThanOrEqual(11);
    expect(abandons).toBeGreaterThanOrEqual(forfeits);
    // Every member of POST_PHASES is reached by at least one sport, and abandoned by ten (all but cricket).
    for (const token of POST_PHASES) {
      expect(reachedBy.get(token)?.size ?? 0, `POST_PHASES member "${token}" is reached by no sport`).toBeGreaterThan(0);
    }
    expect(reachedBy.get("abandoned")?.size).toBe(10);
    expect(reachedBy.get("abandoned")?.has("cricket")).toBe(false);
    expect(reachedBy.get("done")?.size).toBe(11);
    expect(reachedBy.get("final")?.size).toBe(11);
  });

  it("X-PH-1: in each terminal phase a second forfeit or abandon is refused WRONG_PHASE, and the module calls the phase over", () => {
    let probes = 0;
    let generatorProbes = 0;
    const sports = forEachSport(({ module, key }) => {
      const m = loose(module);
      const lineups = defaultLineupPair(m.positions);
      const { cfg } = declaredCfgs(module)[0]!;
      const init = m.init(cfg as never, lineups as never) as Record<string, unknown>;
      for (const phase of TERMINAL_PHASES_OF(key)) {
        const over = { ...init, phase };
        const forfeit = ev(5, "core.forfeit", { by: "H", reason: "walkover" });
        const abandon = ev(5, "core.abandon", { reason: "rain" });
        expect(codeOf(() => m.apply(over as never, forfeit as never)), `${key} ${phase} + core.forfeit`).toBe("WRONG_PHASE");
        expect(codeOf(() => m.apply(over as never, abandon as never)), `${key} ${phase} + core.abandon`).toBe("WRONG_PHASE");
        expect(m.forfeitPhase(over as never), `${key} forfeitPhase(${phase})`).toBe("over");
        probes += 3;
        // A generator draws nothing from a finished match (the conformance walks rely on it).
        if (m.arbitraryEvent !== undefined) {
          expect(m.arbitraryEvent(over as never, () => 0.5), `${key} ${phase}: arbitraryEvent`).toBeNull();
          generatorProbes++;
        }
      }
    });
    // eslint-disable-next-line no-console
    console.info(`[X-PH-1] sports ${sports}, refusal probes ${probes}, generator probes ${generatorProbes}`);
    expect(sports).toBe(11);
    // 10 sports x 3 terminal phases + cricket x 2, three probes each.
    expect(probes).toBe((10 * 3 + 2) * 3);
    expect(generatorProbes).toBeGreaterThan(0);
  });

  it("X-PH-1: a live phase is not refused as 'over' (the empty case: nothing in play is terminal)", () => {
    let probes = 0;
    forEachSport(({ module, key }) => {
      const m = loose(module);
      const lineups = defaultLineupPair(m.positions);
      const { cfg } = declaredCfgs(module)[0]!;
      const live = m.apply(m.init(cfg as never, lineups as never) as never, ev(1, "core.start") as never);
      expect(POST_PHASES.has(phaseOf(live)), `${key}: a started match is in "${phaseOf(live)}"`).toBe(false);
      expect(m.forfeitPhase(live as never), key).toBe("play");
      probes++;
    });
    expect(probes).toBe(11);
  });
});
