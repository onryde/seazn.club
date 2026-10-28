// W2e Task 17 (A2) - the proving tests for generic.md's GN-DV-1 (the M12b retirement is refused in generic): a generic match refuses the
// lineup retirement (core.lineup.retirement) with LINEUP_NOT_SUPPORTED, because generic has no squad to play short. The title of every
// describe/it carries the row id as a whole token (packages/engine/test/rules-reference.ts reads them).
//
// Single-sport on purpose: GN-DV-1 is generic's row. The cross-sport premise (exactly boardgame, carrom and generic decline lineup
// events) is pinned for the whole registry by src/core/lineup-support.test.ts; this file pins the generic half under the row's id and adds
// what that file does not: the refusal under every declared config, at every moment of a match, and the lenient read path.
//
// The write path is `strictFromSeq: <the candidate's seq>`: recorded history replays leniently, the new event is judged strictly. The
// refusal is the write path's only (owner ruling 2026-10-15): a ledger that already holds such an event keeps folding.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { football } from "../football/football.ts";
import { generic, type GenericCfg } from "./generic.ts";

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
};

type Spec = [type: string, payload?: unknown, voids?: string];
const ev = (seq: number, [type, payload, voids]: Spec): EventEnvelope => makeEnvelope(seq, { type, payload: payload ?? {} }, voids);
const retirement: Spec = ["core.lineup.retirement", { side: "H", personId: "h1", reason: "retired hurt" }];

/** The code of the EngineError a fold throws, or null when it folds. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

/** The write path: `prefix` is recorded history, `candidate` the next event, judged strictly. */
const write = (cfg: GenericCfg, prefix: readonly Spec[], candidate: Spec) =>
  foldMatchWithStoppage(generic, cfg, lineups, [...prefix, candidate].map((spec, i) => ev(i, spec)), { strictFromSeq: prefix.length });

/** Ledgers the retirement can arrive on, each built from the module's own events (`cfg` decides which score event is valid). */
function ledgers(cfg: GenericCfg): Array<{ name: string; prefix: Spec[] }> {
  const press: Spec = cfg.resultMode === "score" ? ["generic.score", { by: "H", points: 2 }] : ["generic.result", { winnerId: "H" }];
  const decided = cfg.resultMode === "score" ? ["generic.result", { winnerId: "H", p1Score: 2, p2Score: 1 }] satisfies Spec : press;
  return [
    { name: "as the first event", prefix: [] },
    { name: "after the start", prefix: [["core.start"]] },
    { name: "mid-match", prefix: [["core.start"], ...(cfg.resultMode === "score" ? [press] : [])] },
    { name: "after the result", prefix: [["core.start"], decided] },
    { name: "after a void", prefix: [["core.start"], press, ["core.void", {}, "e-1"]] },
  ];
}

describe("GN-DV-1 a generic match refuses the lineup retirement with LINEUP_NOT_SUPPORTED, because generic has no squad to play short", () => {
  const cfgs = declaredCfgs<GenericCfg>(generic);

  it("GN-DV-1 generic declares no lineup policy and a team sheet with no bench: the premise of the refusal", () => {
    expect(generic.lineupPolicy).toBeUndefined();
    expect(generic.onLineup).toBeUndefined();
    expect(generic.positions.lineup.benchMax).toBe(0);
  });

  it("GN-DV-1 the retirement is refused under every declared config, at every moment of the match, before any other guard", () => {
    let checked = 0;
    for (const { name, cfg } of cfgs) {
      for (const { name: moment, prefix } of ledgers(cfg)) {
        // The prefix itself folds: the refusal below is the retirement's, not the ledger's.
        expect(codeOf(() => foldMatch(generic, cfg, lineups, prefix.map((spec, i) => ev(i, spec)), { strictFromSeq: prefix.length })), `${name} ${moment}: prefix`).toBeNull();
        expect(codeOf(() => write(cfg, prefix, retirement)), `${name} ${moment}`).toBe("LINEUP_NOT_SUPPORTED");
        checked++;
      }
    }
    expect(checked).toBe(cfgs.length * 5);
    expect(cfgs.length).toBeGreaterThan(1);
  });

  it("GN-DV-1 the other lineup events are refused the same way: the retirement is one of five", () => {
    const others: Spec[] = [
      ["core.lineup.substitution", { side: "H", off: "h1", on: { personId: "h2", slot: "starting", orderNo: 2 } }],
      ["core.lineup.replacement", { side: "H", off: "h1", on: { personId: "h2", slot: "starting", orderNo: 2 }, exemption: "concussion", reason: "injury" }],
      ["core.lineup.position", { side: "H", personId: "h1", positionKey: "elsewhere" }],
      ["core.lineup.entry", { side: "H", on: { personId: "h2", slot: "starting", orderNo: 2 } }],
    ];
    const cfg = cfgs[0]!.cfg;
    for (const spec of others) expect(codeOf(() => write(cfg, [["core.start"]], spec)), spec[0]).toBe("LINEUP_NOT_SUPPORTED");
    // With the retirement, all five lineup event types of the kernel.
    expect(new Set([...others.map((s) => s[0]), retirement[0]]).size).toBe(5);
  });

  it("GN-DV-1 the positive pair: the same retirement on a sport that declares lineup support is folded, and the player leaves the squad", () => {
    const pair = defaultLineupPair(football.positions);
    const starter = pair.home.slots.find((s) => s.slot === "starting")!;
    const cfg = football.configSchema.parse({});
    const events = [ev(0, ["core.start"]), ev(1, ["core.lineup.retirement", { side: pair.home.entrantId, personId: starter.personId, reason: "retired hurt" }])];
    const folded = foldMatchWithStoppage(football, cfg, pair, events, { strictFromSeq: 1 });
    expect(folded.squads.home.members.some((m) => m.personId === starter.personId && m.positionKey !== undefined)).toBe(false);
    // And the same football ledger without the retirement keeps him on.
    const kept = foldMatchWithStoppage(football, cfg, pair, events.slice(0, 1), { strictFromSeq: 1 });
    expect(kept.squads.home.members.some((m) => m.personId === starter.personId)).toBe(true);
  });

  it("GN-DV-1 a ledger that already holds a retirement keeps folding on the read path, and the event moves nothing generic shows", () => {
    // Lenient replay: no `strictFromSeq`, as the read side folds. Recorded before the refusal, it must not brick the fixture.
    let checked = 0;
    for (const { name, cfg } of cfgs) {
      const base: Spec[] = [["core.start"], ...(cfg.resultMode === "score" ? ([["generic.score", { by: "H", points: 2 }]] as Spec[]) : [])];
      const withRetirement = [...base, retirement, ["generic.result", cfg.resultMode === "score" ? { winnerId: "H", p1Score: 2, p2Score: 1 } : { winnerId: "H" }] as Spec];
      const without = withRetirement.filter((spec) => spec !== retirement);
      const read = (specs: Spec[]) => foldMatchWithStoppage(generic, cfg, lineups, specs.map((spec, i) => ev(i, spec)));
      const a = read(withRetirement);
      const b = read(without);
      expect(outcomeOf(generic, a), name).toEqual(outcomeOf(generic, b));
      expect(outcomeOf(generic, a), name).toMatchObject({ kind: "win", winner: "H" });
      expect(generic.summary(a.state), name).toEqual(generic.summary(b.state));
      checked++;
    }
    expect(checked).toBe(cfgs.length);
  });
});
