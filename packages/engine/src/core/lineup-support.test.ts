// The kernel admits `core.lineup.*` only for a module that DECLARES lineup support (owner ruling 2026-10-15, option 1).
//
// WHY. Until this ruling the kernel's default admitted every lineup event for a module that declared nothing, because
// `DEFAULT_LINEUP_POLICY` (no growth, no return, no cap) permits a retirement, a position change and a substitution of a
// bench row. Boardgame, carrom and generic declare no `lineupPolicy` (nor `onLineup`), and none of them reads a squad, so a
// substitution recorded there moved the kernel's squads and NOTHING the module shows: verified live, the pad kept the player
// who had been taken off, and in generic a tap went on crediting a point to them. The sport's own declaration is the answer:
// no `lineupPolicy`, no lineup events.
//
// The refusal is the WRITE path's (`strict`), like every other cfg-derived refusal in the fold: a ledger that already holds
// such an event (it was accepted when it was written) must keep folding, or the fixture is bricked with no event to void.
//
// Every expected value below comes from the module's own declaration (`module.lineupPolicy`) or from the reducer's own
// verdict (`planLineupEvents` asks `reduceLineupEvent`), never from the predicate under test.
import { describe, expect, it } from "vitest";
import { EngineError, EngineErrorCode } from "./errors.ts";
import { admitsLineupEvents, foldMatch, foldMatchWithStoppage, type EventEnvelope } from "./events.ts";
import { DEFAULT_LINEUP_POLICY, LINEUP_EVENT_SCHEMAS, type LineupEventType } from "./lineup.ts";
import type { LineupPair } from "./types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { benchPair, planLineupEvents } from "../testkit/golden-floor.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

const TYPES = Object.keys(LINEUP_EVENT_SCHEMAS) as LineupEventType[];
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const START = (): EventEnvelope => ev(0, "core.start");

/** The module's own cfg, as ruling 112's scene picks it: the first declared variant, and (chess) the bracket deciders over it,
 *  under which its one sport event does not decide the game. */
const cfgsOf = (m: AnySportModule): unknown[] => {
  const base = m.configSchema.parse(Object.values(m.variants)[0] ?? {}) as unknown;
  return [base, m.configSchema.parse({ ...(base as object), ...m.bracketDeciders(base) }) as unknown];
};

/** The module's DECLARATION, read here and not through the predicate under test. */
const declares = (m: AnySportModule): boolean => m.lineupPolicy !== undefined;

/** One schema-valid payload per lineup type, over the bench pair (`H-p1` starts, `H-b1` waits). The refusal comes before the
 *  reducer reads the squad, so these need only parse; the reducer's verdicts are tested separately, by `planLineupEvents`. */
function payloadOf(type: LineupEventType, lineups: LineupPair): unknown {
  const side = lineups.home.entrantId;
  const starter = lineups.home.slots.find((s) => s.slot === "starting")!;
  const bench = lineups.home.slots.find((s) => s.slot === "bench")!;
  const on = { personId: bench.personId, slot: "starting", orderNo: bench.orderNo };
  switch (type) {
    case "core.lineup.substitution":
      return { side, off: starter.personId, on };
    case "core.lineup.replacement":
      return { side, off: starter.personId, on, exemption: "concussion", reason: "injury" };
    case "core.lineup.position":
      return { side, personId: starter.personId, positionKey: "elsewhere" };
    case "core.lineup.retirement":
      return { side, personId: starter.personId, reason: "retired hurt" };
    case "core.lineup.entry":
      return { side, on };
  }
}

interface Scene {
  readonly cfgIndex: number;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
  /** `core.start` and one REAL sport event of the module's own (seq 0, 1); null when the cfg leaves nothing undecided. */
  readonly played: EventEnvelope | null;
}

function scenes(m: AnySportModule): Scene[] {
  return cfgsOf(m).map((cfg, cfgIndex) => {
    const lineups = benchPair(m, cfg);
    return { cfgIndex, cfg, lineups, played: onePlayEvent(m, cfg, lineups, [START()]) };
  });
}

/** Folds `prefix` as recorded history and `candidate` as the write path's next event. */
const write = (m: AnySportModule, s: Scene, prefix: readonly EventEnvelope[], candidate: EventEnvelope) =>
  foldMatchWithStoppage(m as never, s.cfg as never, s.lineups, [...prefix, candidate], { strictFromSeq: candidate.seq });

const codeOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return EngineError.is(e) ? e.code : `non-engine error: ${String(e)}`;
  }
};

/** The ledgers a lineup change can arrive on, each built from the module's own play: the very first event, mid-match, and
 *  after a void struck an earlier event. Each returns the prefix; the candidate is appended at `prefix.length`. */
function ledgers(s: Scene): { name: string; prefix: EventEnvelope[] }[] {
  const out: { name: string; prefix: EventEnvelope[] }[] = [{ name: "as the first event", prefix: [] }];
  if (s.played === null) return out;
  const played = ev(1, s.played.type, s.played.payload);
  out.push({ name: "mid-match", prefix: [START(), played] });
  out.push({ name: "after a void", prefix: [START(), played, ev(2, "core.void", {}, played.id)] });
  return out;
}

describe("the premise: which modules declare lineup support", () => {
  it("declares lineupPolicy and onLineup together, and exactly boardgame, carrom and generic decline (owner ruling 2026-10-15)", () => {
    const declining: string[] = [];
    const declaring: string[] = [];
    const visited = forEachSport(({ module: m }) => {
      // The two halves of "reads a squad" agree in every shipped module: a module that adopts the squads declares a policy.
      expect(m.onLineup !== undefined, `${m.key}: onLineup and lineupPolicy are declared together`).toBe(declares(m));
      (declares(m) ? declaring : declining).push(m.key);
    });
    expect(visited).toBe(builtinModules.length);
    // The owner's ruling names these three. A new module that forgets its lineupPolicy lands here and is a DECISION, not an accident.
    expect(declining).toEqual(["boardgame", "carrom", "generic"]);
    expect(declaring.length, "the eight that read a squad").toBe(8);
    expect(declaring.length + declining.length).toBe(builtinModules.length);
  });

  it("each declining sport's own catalog admits no bench: a bench sheet is not part of what the sport's team sheet may hold", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (declares(m)) return;
      expect(m.positions.lineup.benchMax, `${m.key}`).toBe(0);
      checked++;
    });
    expect(checked, "declining sports checked").toBe(3);
  });

  it("admitsLineupEvents is the module's declaration, sport by sport", () => {
    let admit = 0;
    let refuse = 0;
    forEachSport(({ module: m }) => {
      expect(admitsLineupEvents(m), m.key).toBe(declares(m));
      if (declares(m)) admit++;
      else refuse++;
    });
    expect(admit, "admitting sports").toBeGreaterThan(0);
    expect(refuse, "refusing sports").toBeGreaterThan(0);
    // a module that declares nothing, and one that declares a policy, answer differently - by the hook, not by name
    expect(admitsLineupEvents({})).toBe(false);
    expect(admitsLineupEvents({ lineupPolicy: () => DEFAULT_LINEUP_POLICY })).toBe(true);
  });
});

describe("a module that declares no lineupPolicy refuses core.lineup.* on the write path", () => {
  it("refuses every lineup type, as the first event, mid-match and after a void, with a named code", () => {
    let refused = 0;
    const sports: string[] = [];
    forEachSport(({ module: m }) => {
      if (declares(m)) return;
      sports.push(m.key);
      let ledgersSeen = 0;
      for (const s of scenes(m)) {
        for (const { name, prefix } of ledgers(s)) {
          ledgersSeen++;
          for (const type of TYPES) {
            const candidate = ev(prefix.length, type, payloadOf(type, s.lineups));
            let thrown: unknown;
            try {
              write(m, s, prefix, candidate);
            } catch (e) {
              thrown = e;
            }
            const where = `${m.key} cfg#${s.cfgIndex} ${name} ${type}`;
            expect(EngineError.is(thrown, "LINEUP_NOT_SUPPORTED"), `${where}: ${String(thrown)}`).toBe(true);
            const data = (thrown as EngineError).data as { eventId: string; seq: number; type: string };
            expect(data, where).toMatchObject({ eventId: candidate.id, seq: candidate.seq, type });
            refused++;
          }
        }
      }
      // the mid-match and after-a-void ledgers exist for a sport (chess's plain cfg has no undecided play; its deciders cfg does)
      expect(ledgersSeen, `${m.key}: ledgers exercised`).toBeGreaterThanOrEqual(3);
    });
    expect(sports).toEqual(["boardgame", "carrom", "generic"]);
    expect(refused, "refusals asserted").toBeGreaterThanOrEqual(3 * TYPES.length * 3);
  });

  it("a refusal leaves the ledger as it was: a second refusal answers the same, and the next legal event is still taken", () => {
    let sequences = 0;
    forEachSport(({ module: m }) => {
      if (declares(m)) return;
      for (const s of scenes(m)) {
        if (s.played === null) continue;
        const prefix = [START(), ev(1, s.played.type, s.played.payload)];
        const before = JSON.stringify(foldMatchWithStoppage(m as never, s.cfg as never, s.lineups, prefix));
        const first = TYPES[0]!;
        const second = TYPES[1]!;
        expect(codeOf(() => write(m, s, prefix, ev(2, first, payloadOf(first, s.lineups)))), `${m.key} first`).toBe("LINEUP_NOT_SUPPORTED");
        expect(codeOf(() => write(m, s, prefix, ev(2, second, payloadOf(second, s.lineups)))), `${m.key} second`).toBe("LINEUP_NOT_SUPPORTED");
        // the same event again is refused the same way (nothing was recorded by the first attempt)
        expect(codeOf(() => write(m, s, prefix, ev(2, first, payloadOf(first, s.lineups)))), `${m.key} first again`).toBe("LINEUP_NOT_SUPPORTED");
        expect(JSON.stringify(foldMatchWithStoppage(m as never, s.cfg as never, s.lineups, prefix)), `${m.key}: the ledger folds as before`).toBe(before);
        // and a legal annotation after the refusals is accepted
        expect(codeOf(() => write(m, s, prefix, ev(2, "core.note", { text: "after the refusals" }))), `${m.key} note`).toBeNull();
        sequences++;
      }
    });
    expect(sequences, "sequences exercised").toBeGreaterThanOrEqual(3);
  });

  it("refuses a lineup change whose payload is otherwise valid, but a malformed one is the payload's INVALID_EVENT, first", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (declares(m)) return;
      const s = scenes(m)[0]!;
      const bad = ev(0, "core.lineup.retirement", { side: s.lineups.home.entrantId });
      expect(codeOf(() => write(m, s, [], bad)), m.key).toBe("INVALID_EVENT");
      checked++;
    });
    expect(checked).toBe(3);
  });

  it("still FOLDS a ledger that already holds a lineup event (replay): the refusal is the write path's", () => {
    let replayed = 0;
    forEachSport(({ module: m }) => {
      if (declares(m)) return;
      const s = scenes(m)[0]!;
      const starter = s.lineups.home.slots.find((slot) => slot.slot === "starting")!.personId;
      for (const type of TYPES) {
        const recorded = ev(0, type, payloadOf(type, s.lineups));
        // no options at all (every read path), and as history beneath a later strict candidate (the write path's prior events):
        // neither throws (a replay refuses only a structural impossibility, and does not throw even then)
        expect(codeOf(() => foldMatch(m as never, s.cfg as never, s.lineups, [recorded])), `${m.key} ${type} read`).toBeNull();
        const candidate = ev(1, "core.note", { text: "later" });
        expect(codeOf(() => write(m, s, [recorded], candidate)), `${m.key} ${type} history`).toBeNull();
        replayed++;
      }
      // and the recorded event is FOLDED, not skipped: a retirement takes the starter off the kernel's squad, as it always did
      const retired = foldMatchWithStoppage(m as never, s.cfg as never, s.lineups, [ev(0, "core.lineup.retirement", payloadOf("core.lineup.retirement", s.lineups))]);
      expect(retired.squads.home.members.find((member) => member.personId === starter)?.onField, `${m.key}: the recorded retirement still folds`).toBe(false);
    });
    expect(replayed).toBe(3 * TYPES.length);
  });
});

describe("a module that declares a lineupPolicy still admits what its policy allows", () => {
  it("admits every lineup type the reducer accepts under the module's own policy - first, mid-match and after a void - and never answers LINEUP_NOT_SUPPORTED", () => {
    let admitted = 0;
    let sports = 0;
    forEachSport(({ module: m }) => {
      if (!declares(m)) return;
      sports++;
      let accepted = 0;
      for (const s of scenes(m)) {
        const policy = m.lineupPolicy!(s.cfg as never);
        // the reducer's own verdicts, chained over the bench pair: expected values from the policy, not from the kernel gate
        const plan = planLineupEvents(s.lineups, policy);
        for (const { name, prefix } of ledgers(s)) {
          const events = plan.events.map((e, i) => ev(prefix.length + i, e.type, e.payload));
          if (events.length > 0) {
            expect(codeOf(() => foldMatchWithStoppage(m as never, s.cfg as never, s.lineups, [...prefix, ...events], { strictFromSeq: prefix.length })), `${m.key} cfg#${s.cfgIndex} ${name}: ${plan.accepted.join(", ")}`).toBeNull();
            admitted += events.length;
            accepted += events.length;
          }
          // a type the reducer refused is the reducer's refusal (LINEUP_INVALID) or an acceptance, never the gate's
          for (const type of TYPES) {
            const code = codeOf(() => write(m, s, prefix, ev(prefix.length, type, payloadOf(type, s.lineups))));
            expect(code, `${m.key} cfg#${s.cfgIndex} ${name} ${type}`).not.toBe("LINEUP_NOT_SUPPORTED");
            if (code !== null) expect(code, `${m.key} ${type} is a reducer refusal`).toBe("LINEUP_INVALID");
          }
        }
      }
      expect(accepted, `${m.key}: the reducer accepted nothing, so nothing was proven`).toBeGreaterThan(0);
    });
    expect(sports).toBe(8);
    expect(admitted, "lineup events folded").toBeGreaterThanOrEqual(8 * 3);
  });
});

describe("the error code", () => {
  it("LINEUP_NOT_SUPPORTED is in the taxonomy", () => {
    expect(EngineErrorCode.options).toContain("LINEUP_NOT_SUPPORTED");
  });
});
