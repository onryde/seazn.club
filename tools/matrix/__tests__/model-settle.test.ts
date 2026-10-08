// W2a Task 14 Step 5 (finding 24, spec §5.6.2): Settle in the model, OPT-IN. The model's bracket invariants (X-BR-1,
// X-BR-2, X-ST-1) are judged after every step from the product's rows; the expected refusal of a second settle is
// the rule row's (X-ST-1, SETTLE_NOT_APPLICABLE). Rule 10: a fast-check sequence over the commands that can move a
// bracket, Settle included, every step checked, and Settle actually exercised (zero is a failure). Folds through loop
// D's kernel (core.settle): red until D merges into the lane.
import { SETTLE_METHODS } from "@seazn/engine/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMAND_KINDS, ModelViolation, OPT_IN_KINDS, checkStep, commandOf, modelCommands, newModelState, type ModelState } from "../lib/model/commands.ts";
import { resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { BRACKET_LEVEL_CHECK, HELD_SEATS_CHECK, SETTLE_REFUSAL_CHECK, SETTLE_SEATS_CHECK, UNEXPECTED_REFUSAL } from "../lib/model/state.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

/** Two semis feeding a final, the stage reading as a knockout, started — the RR-1 tests' bracket on the model fake. */
async function bracket(sport: string, make: () => ModelFakeDriver = () => new ModelFakeDriver({})): Promise<{ m: ModelState; d: ModelFakeDriver; sf1: string; sf2: string; fin: string }> {
  const d = make();
  const base = await newModelState({ driver: d, row: "league", sport, variant: offlineBuilderDefault(sport), entrants: 4, tag: "t" });
  if (d.stage === null) throw new Error("test: no stage");
  d.stage.kind = "knockout";
  const m: ModelState = { ...base, stageKind: "knockout" };
  const [e1, e2, e3, e4] = m.entrants as [string, string, string, string];
  const sf1 = d.seat(1, e1, e4);
  const sf2 = d.seat(1, e2, e3);
  const fin = d.seat(2, null, null);
  d.feed(sf1.id, fin.id, 1);
  d.feed(sf2.id, fin.id, 2);
  const start = commandOf("Start", 0, 0, false);
  expect(start.check(m)).toBe(true);
  await start.run(m, d);
  return { m, d, sf1: sf1.id, sf2: sf2.id, fin: fin.id };
}
const row = (d: ModelFakeDriver, id: string) => d.fixtures.find((f) => f.id === id)!;
const settle = (m: ModelState, d: ModelFakeDriver, k: number, w = 0) => {
  const c = commandOf("Settle", k, w, false);
  expect(c.check(m), `Settle(${k},${w}) should be runnable`).toBe(true);
  return c.run(m, d);
};
const violation = async (p: Promise<unknown>): Promise<ModelViolation> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ModelViolation);
  return e as ModelViolation;
};

describe("Settle in the model (spec §5.6.2; finding 24)", () => {
  it("empty case first: the default command set is unchanged, so committed seeds replay byte-identical; Settle is the one opt-in", () => {
    expect([...COMMAND_KINDS]).not.toContain("Settle");
    expect([...OPT_IN_KINDS]).toEqual(["Settle"]);
    expect(modelCommands({ fences: true }).length).toBe(COMMAND_KINDS.length);
    expect(modelCommands({ fences: true, settle: false }).length).toBe(COMMAND_KINDS.length);
    expect(modelCommands({ fences: true, settle: true }).length).toBe(COMMAND_KINDS.length + 1);
    // A weighted default (the swiss bias) is untouched, and Settle is never weighted.
    expect(modelCommands({ fences: true, settle: true, bias: { Score: 3 } }).length).toBe(COMMAND_KINDS.length + 1 + 2);
  });

  it("not runnable where it cannot apply: before Start, and on a table stage (a league keeps its draws)", async () => {
    const d = new ModelFakeDriver({});
    const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
    expect(commandOf("Settle", 0, 0, false).check(m)).toBe(false); // not started
    await commandOf("Start", 0, 0, false).run(m, d);
    expect(m.fixtures.size).toBeGreaterThan(0);
    expect(commandOf("Settle", 0, 0, false).check(m), "a league stage has nothing to settle").toBe(false);
  });

  it("the bracket invariants are the bracket's alone: a league draw is DECIDED level and every step passes it, judging nothing (positive pair of the level check)", async () => {
    const d = new ModelFakeDriver({});
    const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
    await commandOf("Start", 0, 0, false).run(m, d);
    const f = [...m.fixtures.values()][0]!;
    const events = generateStream({ sportKey: "generic", cfg: stageCfg("generic", resolveSportCfg("generic", "score"), "league"), stageKind: "league", home: f.home!, away: f.away!, outcome: { kind: "draw" } });
    await d.postStream(f.id, events);
    expect(d.fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
    await checkStep(m, d); // would throw if the bracket rules reached a table stage
    expect(m.stepChecks.get(BRACKET_LEVEL_CHECK)).toBeUndefined();
    expect(m.stepChecks.get(HELD_SEATS_CHECK)).toBeUndefined();
  });

  it("an OPEN match: held first (checked on its own — nobody seated), then settled: decided, a settled_<method> win, the winner seated; a SECOND settle is an EXPECTED, named refusal that writes nothing", async () => {
    // single-sport per case: football holds a level result, generic can only abandon-then-settle (GN-KO-1); the sweep below covers the registry.
    for (const [sport, w] of [["football", 0], ["generic", 0], ["generic", 1]] as const) {
      const { m, d, sf1, fin } = await bracket(sport);
      await settle(m, d, 0, w);
      const f = row(d, sf1);
      expect(f.status, `${sport}/${w}`).toBe("decided");
      expect(f.outcome, `${sport}/${w}`).toMatchObject({ kind: "win", method: expect.stringMatching(/^settled_/) });
      const [home, away] = [f.home_entrant_id!, f.away_entrant_id!];
      expect((f.outcome as { winner: string }).winner, `${sport}/${w}: the side named`).toBe(w === 0 ? home : away);
      expect(row(d, fin).home_entrant_id, `${sport}/${w}: the winner advances`).toBe((f.outcome as { winner: string }).winner);
      expect(m.settles).toEqual([{ status: 200, code: null }]);
      expect(m.counts.Settle).toMatchObject({ ran: 1, accepted: 1 });
      // The held state was judged in the middle of the command, and the settle's seat after it.
      expect(m.stepChecks.get(HELD_SEATS_CHECK) ?? 0, sport).toBeGreaterThan(0);
      expect(m.stepChecks.get(SETTLE_SEATS_CHECK) ?? 0, sport).toBeGreaterThan(0);
      // Pool is now [sf1 (settled), sf2 (open)]: candidate 0 is the settled one — a second settle.
      const tip = d.ledgers.get(sf1)!.length;
      await settle(m, d, 0, w);
      expect(m.settles.at(-1)).toEqual({ status: 409, code: "SETTLE_NOT_APPLICABLE" });
      expect(m.counts.Settle).toMatchObject({ ran: 2, accepted: 1, expected: 1 });
      expect(d.ledgers.get(sf1)!.length, "a refused settle writes nothing").toBe(tip);
      expect(row(d, sf1).status).toBe("decided");
    }
  });

  it("a settled FINAL has no later round to seat: it is settled and decided, and X-ST-1 judges the two semis only (the last round is not counted)", async () => {
    const { m, d, fin } = await bracket("generic");
    await settle(m, d, 0, 0); // sf1
    await settle(m, d, 1, 1); // sf2 (the pool is sf1 (settled), sf2, then nothing: the final is not seated yet)
    expect(row(d, fin).home_entrant_id).not.toBeNull();
    expect(row(d, fin).away_entrant_id).not.toBeNull();
    const before = m.stepChecks.get(SETTLE_SEATS_CHECK) ?? 0;
    await settle(m, d, 2, 0); // the pool is [sf1, sf2, fin]: the final, open, held by an abandon, then settled
    expect(row(d, fin).status).toBe("decided");
    // The command checks twice (once held, once settled); each check judges the two semis and not the final.
    expect((m.stepChecks.get(SETTLE_SEATS_CHECK) ?? 0) - before).toBe(2 * 2);
  });

  it("every method the engine declares for a settle is posted by some Settle (SETTLE_METHODS, not a typed list), and each is the method the match settles by", async () => {
    const seen = new Set<string>();
    for (let k = 0; k < SETTLE_METHODS.length; k++) {
      const { m, d, sf1, sf2 } = await bracket("generic");
      await settle(m, d, k, 0);
      const settledId = k % 2 === 0 ? sf1 : sf2; // pool [sf1, sf2], index k % 2
      const posted = d.ledgers.get(settledId)!.find((e) => e.type === "core.settle")!.payload as { method: string };
      expect(row(d, settledId).outcome, `k=${k}`).toMatchObject({ method: `settled_${posted.method}` });
      seen.add(posted.method);
    }
    expect([...seen].sort()).toEqual([...SETTLE_METHODS].sort());
    expect(SETTLE_METHODS.length).toBeGreaterThan(1);
  });

  it("a second settle refused with ANY OTHER code is a defect: X-ST-1 names SETTLE_NOT_APPLICABLE", async () => {
    class WrongCode extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        if (events.some((e) => e.type === "core.settle") && (this.ledgers.get(id) ?? []).some((e) => e.type === "core.settle")) {
          throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 422, "INVALID_EVENT", "no");
        }
        return super.postStream(id, events, prefix);
      }
    }
    const { m, d } = await bracket("generic", () => new WrongCode({}));
    await settle(m, d, 0, 0);
    const v = await violation(settle(m, d, 0, 0));
    expect(v.check).toBe(SETTLE_REFUSAL_CHECK);
    expect(m.settles.at(-1)).toEqual({ status: 422, code: "INVALID_EVENT" });
  });

  it("a legal settle the product REFUSES is a defect (the model holds it legal: ruling I-1), whichever state the match is in", async () => {
    class RefusesFirst extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        if (events.some((e) => e.type === "core.settle")) throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "SETTLE_NOT_APPLICABLE", "not level");
        return super.postStream(id, events, prefix);
      }
    }
    for (const sport of ["generic", "football"]) {
      const { m, d } = await bracket(sport, () => new RefusesFirst({}));
      const v = await violation(settle(m, d, 0, 0));
      expect(v.check, sport).toBe(UNEXPECTED_REFUSAL);
    }
  });

  it("a held match with a WITHDRAWN side is not offered to Settle (C17 is the product's: a settle naming the withdrawn entrant is refused, the remaining one seated — W2b owns the rest): the next candidate is settled and the held one is left alone", async () => {
    // single-sport: the offer rule is the stage's; football holds a level result, and a taken-back settle re-holds it with the model's ledger intact.
    const held = async () => {
      const b = await bracket("football");
      await settle(b.m, b.d, 0, 0); // sf1 settled
      const takeBack = commandOf("Void", 0, 0, false); // sf1 is the only fixture with a live event
      expect(takeBack.check(b.m)).toBe(true);
      await takeBack.run(b.m, b.d);
      expect(row(b.d, b.sf1).status).toBe("needs_decision");
      expect(b.m.fixtures.get(b.sf1)!.ledger).not.toBeNull();
      return b;
    };
    // Positive pair: nobody withdrawn, the held sf1 is the first candidate and Settle closes it.
    const open = await held();
    await settle(open.m, open.d, 0, 0);
    expect(row(open.d, open.sf1).status).toBe("decided");
    // The withdrawal of sf1's home side: sf1 stays held (the cascade skips it), is not offered, and sf2 (open) is settled.
    const b = await held();
    const w = commandOf("Withdraw", 0, 0, false);
    expect(w.check(b.m)).toBe(true);
    await w.run(b.m, b.d);
    expect(b.m.withdrawn.has(row(b.d, b.sf1).home_entrant_id!)).toBe(true);
    expect(row(b.d, b.sf1).status, "the withdrawal left the held match held").toBe("needs_decision");
    const tip = b.d.ledgers.get(b.sf1)!.length;
    await settle(b.m, b.d, 0, 0);
    expect(b.d.ledgers.get(b.sf1)!.length, "the held match with a withdrawn side was left alone").toBe(tip);
    expect(row(b.d, b.sf1).status).toBe("needs_decision");
    expect(row(b.d, b.sf2).status).toBe("decided");
  });

  it("a settle taken back (Void) leaves the match HELD again, and the next Settle closes it without a second hold: the ledger is the first stream, the void, the second settle", async () => {
    const { m, d, sf1, fin } = await bracket("football");
    await settle(m, d, 0, 0);
    expect(row(d, sf1).status).toBe("decided");
    const grown = d.ledgers.get(sf1)!.length;
    const takeBack = commandOf("Void", 0, 0, false); // withLive's first fixture is sf1, the only one with a live event
    expect(takeBack.check(m)).toBe(true);
    await takeBack.run(m, d);
    expect(row(d, sf1).status, "a voided settle re-opens the hold").toBe("needs_decision");
    expect(row(d, fin).home_entrant_id, "and the winner it seated is unseated").toBeNull();
    expect(d.ledgers.get(sf1)!.length).toBe(grown + 1);
    await settle(m, d, 0, 1);
    expect(row(d, sf1).status).toBe("decided");
    expect(d.ledgers.get(sf1)!.length, "one settle went in; the held match was not held twice").toBe(grown + 2);
    expect(m.settles.map((x) => x.status)).toEqual([200, 200]);
  });

  it("the model's bracket invariants red on a faulty product, each on its own (and the correct product above passes): a level result DECIDED, a held match that SEATS, a settle that seats NOBODY", async () => {
    class DecidesLevel extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        const f = this.fixtures.find((x) => x.id === id)!;
        if (f.status === "needs_decision") f.status = "decided"; // X-BR-1 broken
        return out.map((p, i) => (i === out.length - 1 ? { ...p, status: f.status } : p));
      }
    }
    class HeldSeats extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        const f = this.fixtures.find((x) => x.id === id)!;
        if (f.status === "needs_decision" || f.status === "abandoned") this.fixtures.find((x) => x.round_no === 2)!.home_entrant_id = f.home_entrant_id; // X-BR-2 broken
        return out;
      }
    }
    class SettleSeatsNobody extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        if (events.at(-1)?.type === "core.settle") for (const f of this.fixtures.filter((x) => x.round_no === 2)) { f.home_entrant_id = null; f.away_entrant_id = null; } // X-ST-1 broken
        return out;
      }
    }
    const cases: readonly [string, () => ModelFakeDriver, string][] = [
      ["a level result decided", () => new DecidesLevel({}), BRACKET_LEVEL_CHECK],
      ["a held match that seats", () => new HeldSeats({}), HELD_SEATS_CHECK],
      ["a settle that seats nobody", () => new SettleSeatsNobody({}), SETTLE_SEATS_CHECK],
    ];
    let reds = 0;
    for (const [label, make, check] of cases) {
      const { m, d } = await bracket("football", make);
      const v = await violation(settle(m, d, 0, 0));
      expect(v.check, label).toBe(check);
      reds++;
    }
    expect(reds).toBe(cases.length);
    expect(reds).toBeGreaterThan(0);
    // The positive pair: the same command on the correct fake raises nothing.
    const ok = await bracket("football");
    await settle(ok.m, ok.d, 0, 0);
  });
});

describe("rule 10 — any sequence with Settle keeps the three bracket invariants after every step, and Settle is exercised", () => {
  // The commands that can move a started bracket. Start is spent, Generate and Rebuild would re-seat the fake's
  // round robin under a knockout label, and AddEntrant is refused by the roster lock.
  const MOVES = ["Withdraw", "Score", "Walkover", "Void", "Correct", "Complete", "Settle"] as const;
  const ALL = [...COMMAND_KINDS, ...OPT_IN_KINDS];

  it("fast-check over the registry's three bracket shapes (generic abandons, football holds a level result, chess abandons): per-step invariants hold, Settle is accepted and refused by name in the sequences", async () => {
    const arbs = modelCommands({ fences: true, settle: true });
    expect(arbs.length).toBe(ALL.length);
    // A withdrawal's cascade posts a BARE core.forfeit (withdrawal.ts applyUpdate): a chess game refuses it before
    // core.start (model-fake-driver.ts, F1) — a known, separate finding, so the chess shape runs without Withdraw.
    const movesFor = (sport: string) => arbs.filter((_, i) => (MOVES as readonly string[]).includes(ALL[i]!) && !(sport === "boardgame" && ALL[i] === "Withdraw"));
    expect(movesFor("generic").length).toBe(MOVES.length);
    expect(movesFor("boardgame").length).toBe(MOVES.length - 1);
    const totals = { runs: 0, steps: 0, accepted: 0, expected: 0, held: 0, level: 0, seated: 0 };
    for (const sport of ["generic", "football", "boardgame"]) {
      await fc.assert(fc.asyncProperty(fc.commands(movesFor(sport), { maxCommands: 30 }), async (cmds) => {
        const { m, d } = await bracket(sport);
        await fc.asyncModelRun(() => ({ model: m, real: d }), cmds);
        totals.runs++;
        totals.steps += m.steps.length;
        totals.accepted += m.settles.filter((x) => x.status < 300).length;
        totals.expected += m.counts.Settle?.expected ?? 0;
        totals.held += m.stepChecks.get(HELD_SEATS_CHECK) ?? 0;
        totals.level += m.stepChecks.get(BRACKET_LEVEL_CHECK) ?? 0;
        totals.seated += m.stepChecks.get(SETTLE_SEATS_CHECK) ?? 0;
      }), { numRuns: 40 });
    }
    // Anti-vacuity (TEST-STRATEGY): zero of any of these is a failure, never `>= 0`.
    expect(totals.runs).toBe(120);
    expect(totals.steps).toBeGreaterThan(0);
    expect(totals.accepted, "no Settle was ever accepted").toBeGreaterThan(0);
    expect(totals.expected, "no second settle was ever refused").toBeGreaterThan(0);
    expect(totals.held, "no held match was ever judged").toBeGreaterThan(0);
    expect(totals.level, "no bracket outcome was ever judged").toBeGreaterThan(0);
    expect(totals.seated, "no settled seat was ever judged").toBeGreaterThan(0);
    expect(SETTLE_METHODS.length).toBeGreaterThan(0);
  });
});
