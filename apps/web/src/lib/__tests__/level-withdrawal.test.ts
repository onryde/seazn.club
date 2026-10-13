// Loop R M-17 — `admittedLevelWithdrawal` (lib/level-withdrawal.ts), the hand-rolled replay loops' copy of PF-1's
// admission (public-site/timeline.ts `buildTimeline`, overlay/recent.ts `replayDerived`): the `levelWithdrawal` a
// kernel-owned event admits. The oracle is the kernel's own fold (`foldMatchWithStoppage`'s `levelWithdrawal`) over a
// real stream that holds a level result, never the helper's derivation restated.
//
// Two sports, not the registry: the helper reads no sport input (only the event and the line-up pair's entrant ids);
// the sports are there for the kernel oracle, each a level result the kernel holds — football 0-0 at full time and a
// chess game drawn by agreement (no decider owed under the default cfg), both seats withdrawing.
import { describe, expect, it } from "vitest";
import { CORE_EVENT_SCHEMAS, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "@seazn/engine/core";
import { resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { admittedLevelWithdrawal } from "../level-withdrawal";

const moduleOf = (key: string) => builtinModules.find((m) => m.key === key)! as unknown as AnySportModule;
const ev = (type: string, payload: unknown = {}) => ({ type, payload });
/** Each sport's stream to a level result at full time (no score recorded). */
const LEVEL: Record<string, { type: string; payload: unknown }[]> = {
  football: [ev("core.start"), ev("football.period", { phase: "HT" }), ev("football.period", { phase: "FT" })],
  boardgame: [ev("core.start"), ev("boardgame.result", { winner: null, method: "agreement" })],
};

function rig(sport: string) {
  const sportModule = moduleOf(sport);
  const cfg = sportModule.configSchema.parse({});
  const lineups = defaultLineupPair(resolvePositions(sportModule as never, cfg as never));
  return { sportModule, cfg, lineups };
}

describe("Loop R M-17: admittedLevelWithdrawal is the kernel's own admission", () => {
  it("a withdrawal over a held level result: the helper admits exactly what the kernel's fold admits, either side withdrawing", () => {
    let checked = 0;
    for (const sport of Object.keys(LEVEL)) {
      const { sportModule, cfg, lineups } = rig(sport);
      for (const side of ["home", "away"] as const) {
        const level = LEVEL[sport]!.map((e, i) => makeEnvelope(i, e as never));
        const forfeit: EventEnvelope = makeEnvelope(level.length, ev("core.forfeit", { by: lineups[side].entrantId, reason: "withdrew" }) as never);
        expect(outcomeOf(sportModule as never, foldMatchWithStoppage(sportModule as never, cfg as never, lineups, level)), `${sport}: premise, level`).toEqual({ kind: "draw" });
        const folded = foldMatchWithStoppage(sportModule as never, cfg as never, lineups, [...level, forfeit]);
        expect(folded.levelWithdrawal, `${sport} ${side}: premise, the kernel admits it`).not.toBeNull();
        expect(folded.levelWithdrawal!.loser, `${sport} ${side}: premise, the withdrawn side loses`).toBe(lineups[side].entrantId);
        expect(admittedLevelWithdrawal(forfeit, lineups), `${sport} ${side}`).toEqual(folded.levelWithdrawal);
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(LEVEL).length * 2);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("every other core event type admits nothing, and reads no payload", () => {
    const { lineups } = rig("football");
    let checked = 0;
    for (const type of Object.keys(CORE_EVENT_SCHEMAS)) {
      if (type === "core.forfeit") continue;
      expect(admittedLevelWithdrawal({ id: `e-${type}`, type, payload: {} }, lineups), type).toBeNull();
      checked++;
    }
    expect(checked, "the engine's core event types, the forfeit aside").toBe(Object.keys(CORE_EVENT_SCHEMAS).length - 1);
    expect(checked).toBeGreaterThan(0);
  });

  it("a forfeit by neither side is refused, as the kernel refuses it — never a stranger credited", () => {
    const { sportModule, cfg, lineups } = rig("football");
    const level = LEVEL.football!.map((e, i) => makeEnvelope(i, e as never));
    const stranger: EventEnvelope = makeEnvelope(level.length, ev("core.forfeit", { by: "stranger", reason: "withdrew" }) as never);
    expect(() => foldMatchWithStoppage(sportModule as never, cfg as never, lineups, [...level, stranger]), "premise: the kernel refuses it").toThrow();
    expect(() => admittedLevelWithdrawal(stranger, lineups)).toThrow(/neither side of this fixture/);
  });
});
