// W2c Task 22 (MD-1): the KERNEL's half of X-WO-1 B (Task 9 P-3 "A") - which forfeit event a stage rule's award is handed
// to, and what the module's `ctx` carries otherwise. The sport-level tests (sport/forfeit-award.test.ts) drive the real
// modules; none of them can place a SPORT event after a forfeit (guarantee 4 refuses it), so the kernel's "judged on the
// ledger BEFORE this event" reading is witnessed here with a hand-built module whose one post-decision type is a sport
// event (cricket's `cricket.player.line` is the only real one, and cricket reads no award).
//
// The expected values are the rulebook's: P-3 "A" (competition/points.ts `isUnplayedForfeit`, events.ts
// `unplayedForfeitEvent`): a forfeit is an award with NOTHING PLAYED before it; `FoldContext.forfeitAward` is "Absent for
// every other event" (events.ts), so the module's ctx is exactly `{strict, squads}` unless the award lands.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, type EventEnvelope, type FoldableModule, type FoldContext } from "./events.ts";
import type { ForfeitAward, ForfeitReason, MatchOutcome } from "./types.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { builtinModules } from "../sports/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}): EventEnvelope => makeEnvelope(seq, { type, payload });
const forfeit = (seq: number, by: string, reason: ForfeitReason): EventEnvelope => ev(seq, "core.forfeit", { by, reason });

interface S {
  started: boolean;
  outcome: MatchOutcome | null;
}
interface Seen {
  type: string;
  ctx: FoldContext | undefined;
}

/** A hand-built module (the core tests' shape): `fake.point` is play, `fake.after` is the one sport type still admitted
 *  once the match is decided. It records the `ctx` the kernel handed each event. */
function recorder() {
  const seen: Seen[] = [];
  const fake: FoldableModule<unknown, S> = {
    init: () => ({ started: false, outcome: null }),
    apply: (s, e, ctx) => {
      seen.push({ type: e.type, ctx });
      if (e.type === "core.start") return { ...s, started: true };
      if (e.type === "core.forfeit") {
        const p = e.payload as { by: string; reason: ForfeitReason };
        return { ...s, outcome: p.by === "both" ? { kind: "double_walkover" } : { kind: "award", winner: p.by === "H" ? "A" : "H", loser: p.by, reason: p.reason } };
      }
      return s;
    },
    outcome: (s) => s.outcome,
    postDecisionTypes: ["fake.after"],
  };
  return { fake, seen };
}

const lineups = defaultLineupPair(builtinModules.find((m) => m.key === "generic")!.positions);
const AWARD: ForfeitAward = [3, 1];
const run = (events: EventEnvelope[], offer?: ForfeitAward) => {
  const { fake, seen } = recorder();
  foldMatchWithStoppage(fake, {}, lineups, events, offer === undefined ? undefined : { forfeitAward: offer });
  return seen;
};
const ctxOf = (seen: Seen[], type: string): FoldContext | undefined => {
  const hits = seen.filter((s) => s.type === type);
  expect(hits, `exactly one ${type} reached the module`).toHaveLength(1);
  return hits[0]!.ctx;
};
const keysOf = (ctx: FoldContext | undefined): string[] => Object.keys(ctx ?? {}).sort();

describe("X-WO-1 B (kernel): the award lands on a forfeit judged on the ledger BEFORE it", () => {
  it("a withdrawal with nothing played before it takes the award, even when a sport event is recorded AFTER it", () => {
    // [Start, withdrawal, a post-decision sport event]: before the withdrawal nothing was played (ruling 112: a bare Start
    // is not play), and the later event is not "before" it. Read on the whole ledger it would be play, and a withdrawal
    // after play keeps the module's own credit - so this is the case where the two readings differ.
    const seen = run([ev(1, "core.start"), forfeit(2, "H", "withdrew"), ev(3, "fake.after")], AWARD);
    const ctx = ctxOf(seen, "core.forfeit");
    expect(Object.hasOwn(ctx!, "forfeitAward"), "the award is handed over").toBe(true);
    expect(ctx!.forfeitAward).toEqual(AWARD);
    expect(seen.map((s) => s.type), "the post-decision sport event reached the module too").toEqual(["core.start", "core.forfeit", "fake.after"]);
  });

  it("the other arm: a withdrawal AFTER a sport event is a result - the same offer is withheld", () => {
    const seen = run([ev(1, "core.start"), ev(2, "fake.point"), forfeit(3, "H", "withdrew")], AWARD);
    expect(Object.hasOwn(ctxOf(seen, "core.forfeit")!, "forfeitAward")).toBe(false);
  });

  it("a double walkover is never handed an award (nobody forfeited to anyone), before the Start and after a bare one", () => {
    // After play this fake refuses a walkover (phase guard, ruling 112), so the played arm is the guard's, not the award's.
    let checked = 0;
    for (const lead of [[], [ev(1, "core.start")]]) {
      const seen = run([...lead, forfeit(lead.length + 1, "both", "walkover")], AWARD);
      expect(Object.hasOwn(ctxOf(seen, "core.forfeit")!, "forfeitAward"), `after ${lead.length} lead event(s)`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
    // The positive pair: the same two ledgers with ONE side's walkover do take the award.
    for (const lead of [[], [ev(1, "core.start")]]) {
      const seen = run([...lead, forfeit(lead.length + 1, "H", "walkover")], AWARD);
      expect(ctxOf(seen, "core.forfeit")!.forfeitAward, `one side's walkover after ${lead.length} lead event(s)`).toEqual(AWARD);
    }
  });
});

describe("X-WO-1 B (kernel): the module's ctx is exactly {strict, squads} unless the award lands (the key is ABSENT, not undefined)", () => {
  it("no offer: no event's ctx carries the key, a forfeit's included", () => {
    const seen = run([ev(1, "core.start"), forfeit(2, "H", "withdrew")]);
    expect(seen.length, "events inspected").toBe(2);
    for (const s of seen) {
      expect(Object.hasOwn(s.ctx!, "forfeitAward"), s.type).toBe(false);
      expect(keysOf(s.ctx), s.type).toEqual(["squads", "strict"]);
    }
  });

  it("an offer: only the forfeit it lands on carries the key; the Start and a play event keep {strict, squads}", () => {
    const seen = run([ev(1, "core.start"), forfeit(2, "H", "withdrew")], AWARD);
    expect(keysOf(ctxOf(seen, "core.start"))).toEqual(["squads", "strict"]);
    expect(keysOf(ctxOf(seen, "core.forfeit"))).toEqual(["forfeitAward", "squads", "strict"]);
    const played = run([ev(1, "core.start"), ev(2, "fake.point"), forfeit(3, "H", "withdrew")], AWARD);
    expect(played.map((s) => keysOf(s.ctx)), "start, play and a withdrawal after play").toEqual([["squads", "strict"], ["squads", "strict"], ["squads", "strict"]]);
  });
});

describe("X-WO-1 B (kernel): the offer never changes whether the kernel takes the event", () => {
  it("a malformed forfeit payload is refused by the same code with and without an offer, before the award is decided", () => {
    // The award is decided from `forfeitOf(payload)`, which throws on a bad payload; `validateCoreEvent` refuses it first, for
    // every fold, so the offer can never move which error a bad forfeit raises. The premise behind events.ts:1185:9
    // `forfeitAward !== undefined` → true being equivalent (MD-1; its key also names two killed mutants, so it stays in the
    // denominator rather than in stryker-equivalent.json).
    const bad = [ev(1, "core.start"), ev(2, "core.forfeit", { by: "H", reason: "no-show" })];
    const codeOf = (offer?: ForfeitAward): string => {
      try {
        run(bad, offer);
      } catch (e) {
        return EngineError.is(e) ? e.code : String(e);
      }
      return "no error";
    };
    expect(codeOf()).toBe("INVALID_EVENT");
    expect(codeOf(AWARD)).toBe("INVALID_EVENT");
  });
});
