// W2b Task 2 (D10, spec §5.6): the model's Forfeit command, OPT-IN like W2a's Settle, so every committed fast-check
// regression replays unchanged. Its contract per state is the plan's D3 phase-guard table, D4's abandon guard and PF-2's
// writer rule — typed here from those rules, never read back from the command. After every step the model checks two
// W2b invariants from the product's rows: nobody advances from a double walkover (X-DW-1, X-DW-2), and one result per
// active forfeit. Folds through loop D's kernel (core.forfeit {by: "both"}, the strict reasons, the phase guard).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RowKey } from "../lib/catalogue.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { COMMAND_KINDS, ModelViolation, OPT_IN_KINDS, SWISS_BIAS, checkStep, commandOf, modelCommands, newModelState, type ModelState } from "../lib/model/commands.ts";
import { biasFor } from "../lib/model/run-cell.ts";
import { DW_ADVANCES_NOBODY_CHECK, FORFEIT_ONE_RESULT_CHECK, FORFEIT_REFUSAL_CHECK } from "../lib/model/state.ts";
import { loadRegressions, replayFences } from "../lib/scenario-catalogue.ts";
import { resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Captured at c7a7557ac, before this task touched the model; never regenerated (D10). */
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, "fixtures", "w2b-command-paths.json"), "utf8")) as {
  regressions: Record<string, string[]>;
  draws: { seed: number; numRuns: number; maxCommands: number; sets: Record<string, string[][]> };
};

/** D1, in the plan's order — the command's `w` contract (w = side + 3 × reason index), typed from the decision. */
const REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const;
const SIDES = ["home", "away", "both"] as const;
const wOf = (side: (typeof SIDES)[number], reason: (typeof REASONS)[number]) => SIDES.indexOf(side) + 3 * REASONS.indexOf(reason);

/** The kinds a command arbitrary set draws, read off one sample of each arbitrary (its toString is `Kind(k,w)`). */
const kindsOf = (arbs: ReturnType<typeof modelCommands>) => arbs.map((a) => String(fc.sample(a, { seed: 1, numRuns: 1 })[0]).replace(/\(.*$/, ""));

/** Two semis feeding a final, the stage reading as a knockout, started — model-settle.test.ts's bracket. */
async function bracket(sport: string, make: () => ModelFakeDriver = () => new ModelFakeDriver({})) {
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
  await commandOf("Start", 0, 0, false).run(m, d);
  return { m, d, sf1: sf1.id, sf2: sf2.id, fin: fin.id };
}
const row = (d: ModelFakeDriver, id: string) => d.fixtures.find((f) => f.id === id)!;
const run = async (m: ModelState, d: ModelFakeDriver, kind: Parameters<typeof commandOf>[0], k: number, w: number) => {
  const c = commandOf(kind, k, w, false);
  expect(c.check(m), `${kind}(${k},${w}) should be runnable`).toBe(true);
  await c.run(m, d);
};
const forfeit = (m: ModelState, d: ModelFakeDriver, k: number, side: (typeof SIDES)[number], reason: (typeof REASONS)[number]) => run(m, d, "Forfeit", k, wOf(side, reason));
const lastForfeit = (m: ModelState) => (m as ModelState & { forfeits: { status: number; code: string | null }[] }).forfeits.at(-1);
const liveForfeits = (d: ModelFakeDriver, id: string) => {
  const led = d.ledgers.get(id) ?? [];
  const voided = new Set(led.flatMap((e) => (e.voids === undefined ? [] : [e.voids])));
  return led.filter((e) => e.type === "core.forfeit" && !voided.has(e.id));
};

describe("Forfeit in the model — opt-in (D10)", () => {
  it("empty case first: without the flag the arbitrary set is today's kinds exactly (COMMAND_KINDS, plus Settle only when asked); Forfeit is never a default kind", () => {
    expect([...COMMAND_KINDS]).not.toContain("Forfeit");
    expect(kindsOf(modelCommands({ fences: true }))).toEqual([...COMMAND_KINDS]);
    expect(kindsOf(modelCommands({ fences: true, forfeit: false }))).toEqual([...COMMAND_KINDS]);
    expect(kindsOf(modelCommands({ fences: true, settle: true }))).toEqual([...COMMAND_KINDS, "Settle"]);
    expect(kindsOf(modelCommands({ fences: false, bias: SWISS_BIAS })).filter((k) => k === "Forfeit")).toEqual([]);
  });

  it("opt-in: forfeit: true adds exactly one Forfeit arbitrary; settle and forfeit are independent flags, and a bias never weights Forfeit", () => {
    expect([...OPT_IN_KINDS]).toEqual(["Settle", "Forfeit"]);
    expect(kindsOf(modelCommands({ fences: true, forfeit: true }))).toEqual([...COMMAND_KINDS, "Forfeit"]);
    expect(kindsOf(modelCommands({ fences: true, settle: true, forfeit: true }))).toEqual([...COMMAND_KINDS, "Settle", "Forfeit"]);
    expect(kindsOf(modelCommands({ fences: true, forfeit: true, bias: { Score: 3 } })).filter((k) => k === "Forfeit")).toEqual(["Forfeit"]);
    // Its w reaches every (side, reason) pair of the contract: 3 sides x 4 reasons.
    const ws = new Set(fc.sample(modelCommands({ fences: true, forfeit: true }).at(-1)!, { seed: 7, numRuns: 2000 }).map((c) => String(c).replace(/^Forfeit\(\d+,(\d+)\)$/, "$1")));
    expect([...ws].map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: SIDES.length * REASONS.length }, (_, i) => i));
  });

  it("replay: every committed regression draws the same command path it drew before W2b (run-cell's own arbitrary construction), and the default, swiss and settle sets draw the same sequences", () => {
    let checked = 0;
    for (const r of loadRegressions()) {
      const bias = biasFor(r.cell.split("|")[0] as RowKey);
      const arbs = modelCommands({ fences: replayFences(r), ...(bias === undefined ? {} : { bias }) });
      let first: string[] | null = null;
      fc.check(fc.property(fc.commands(arbs as never, { maxCommands: r.maxCommands, size: "max", ...(r.replayPath === null ? {} : { replayPath: r.replayPath }) }), (cmds) => {
        first ??= [...cmds].map(String);
        return true;
      }), { seed: r.seed, path: r.path, numRuns: 1 });
      expect(first, r.id).toEqual(GOLDEN.regressions[r.id]);
      checked++;
    }
    expect(checked).toBe(Object.keys(GOLDEN.regressions).length);
    expect(checked).toBeGreaterThan(0);
    const g = GOLDEN.draws;
    const sets: Record<string, Parameters<typeof modelCommands>[0]> = { fences: { fences: true }, "no-fences": { fences: false }, "swiss-bias": { fences: true, bias: SWISS_BIAS }, settle: { fences: true, settle: true } };
    expect(Object.keys(sets).sort()).toEqual(Object.keys(g.sets).sort());
    for (const [name, opts] of Object.entries(sets)) {
      const drawn = fc.sample(fc.commands(modelCommands(opts) as never, { maxCommands: g.maxCommands, size: "max" }), { seed: g.seed, numRuns: g.numRuns }).map((cmds) => [...cmds].map(String));
      expect(drawn, name).toEqual(g.sets[name]);
      checked++;
    }
  });
});

describe("Forfeit's contract per state (D3 rule table, D4, PF-2, X-DW-3)", () => {
  it("on an untouched semi (phase pre): a walkover either side or both is accepted; retired/disqualified are refused FORFEIT_REASON_WRONG_PHASE (R4); both with another reason, and any withdrew, are refused INVALID_EVENT (R1, PF-2) — all twelve draws, each on a fresh bracket", async () => {
    const TABLE: readonly [(typeof SIDES)[number], (typeof REASONS)[number], string | null][] = [
      ["home", "walkover", null], ["away", "walkover", null], ["both", "walkover", null],
      ["home", "retired", "FORFEIT_REASON_WRONG_PHASE"], ["away", "retired", "FORFEIT_REASON_WRONG_PHASE"], ["both", "retired", "INVALID_EVENT"],
      ["home", "disqualified", "FORFEIT_REASON_WRONG_PHASE"], ["away", "disqualified", "FORFEIT_REASON_WRONG_PHASE"], ["both", "disqualified", "INVALID_EVENT"],
      ["home", "withdrew", "INVALID_EVENT"], ["away", "withdrew", "INVALID_EVENT"], ["both", "withdrew", "INVALID_EVENT"],
    ];
    let checked = 0;
    for (const [side, reason, code] of TABLE) {
      const { m, d, sf1, fin } = await bracket("generic");
      await forfeit(m, d, 0, side, reason);
      const f = row(d, sf1);
      const label = `${side}/${reason}`;
      if (code === null) {
        expect(lastForfeit(m), label).toEqual({ status: 200, code: null });
        expect(f.status, label).toBe("forfeited");
        // The posted payload is the contract's: the product's own ledger, read back.
        const posted = d.ledgers.get(sf1)!.at(-1)!;
        expect(posted, label).toMatchObject({ type: "core.forfeit", payload: { by: side === "both" ? "both" : side === "home" ? f.home_entrant_id : f.away_entrant_id, reason } });
        expect(d.ledgers.get(sf1)!.map((e) => e.type), `${label}: a walkover posts no core.start`).toEqual(["core.forfeit"]);
        if (side === "both") {
          expect(f.outcome, label).toEqual({ kind: "double_walkover" });
          expect(row(d, fin).home_entrant_id, `${label}: nobody advances (X-DW-1)`).toBeNull();
        } else {
          const winner = side === "home" ? f.away_entrant_id : f.home_entrant_id;
          expect(f.outcome, label).toMatchObject({ kind: "award", winner, reason });
          expect(row(d, fin).home_entrant_id, `${label}: the walked-over-to side advances`).toBe(winner);
        }
      } else {
        expect(lastForfeit(m), label).toMatchObject({ code });
        expect(d.ledgers.get(sf1) ?? [], `${label}: a refused forfeit writes nothing`).toEqual([]);
        expect(f.status, label).toBe("scheduled");
      }
      checked++;
    }
    expect(checked).toBe(SIDES.length * REASONS.length);
  });

  it("in play (phase play): a retirement or disqualification is accepted with the played score kept; a walkover is refused FORFEIT_REASON_WRONG_PHASE (R2) — except where the sport declares walkovers in play (chess, FIDE 6.7.1)", async () => {
    // single-sport per case: generic declares walkovers in `pre` only, boardgame in `pre`, `play` and `tiebreak` (D3).
    for (const [sport, side, reason, code] of [
      ["generic", "home", "retired", null], ["generic", "away", "disqualified", null], ["generic", "home", "walkover", "FORFEIT_REASON_WRONG_PHASE"],
      ["boardgame", "home", "walkover", null], ["boardgame", "away", "retired", null],
    ] as const) {
      const { m, d, sf1 } = await bracket(sport);
      await run(m, d, "Score", 0, 0);   // sf1 decided by play …
      await run(m, d, "Void", 0, 0);    // … and its deciding event taken back: in play, START kept
      expect(row(d, sf1).status, `${sport}: in play`).toBe("in_play");
      const before = d.ledgers.get(sf1)!.length;
      await forfeit(m, d, 0, side, reason);
      const label = `${sport} ${side}/${reason}`;
      if (code === null) {
        expect(row(d, sf1).status, label).toBe("forfeited");
        expect(row(d, sf1).outcome, label).toMatchObject({ kind: "award", reason });
      } else {
        expect(lastForfeit(m), label).toMatchObject({ code });
        expect(d.ledgers.get(sf1)!.length, `${label}: nothing written`).toBe(before);
      }
    }
  });

  it("a second forfeit on a decided fixture is refused ALREADY_DECIDED, and a forfeit while an abandon is active is refused ABANDONED_SETTLE_OR_VOID (D4); void the abandon and the retirement is accepted (X-AB-4)", async () => {
    const a = await bracket("generic");
    await forfeit(a.m, a.d, 0, "home", "walkover");
    await forfeit(a.m, a.d, 0, "away", "walkover");
    expect(lastForfeit(a.m)).toMatchObject({ code: "ALREADY_DECIDED" });
    expect(liveForfeits(a.d, a.sf1).length, "one forfeit stands").toBe(1);

    const b = await bracket("generic");
    await run(b.m, b.d, "Settle", 0, 2);  // an open semi held by an abandon at score, then settled
    await run(b.m, b.d, "Void", 0, 0);    // the settle taken back: abandoned, held
    expect(row(b.d, b.sf1).status).toBe("abandoned");
    await forfeit(b.m, b.d, 0, "home", "retired");
    expect(lastForfeit(b.m)).toMatchObject({ code: "ABANDONED_SETTLE_OR_VOID" });
    await run(b.m, b.d, "Void", 0, 0);    // the abandon taken back: in play again
    await forfeit(b.m, b.d, 0, "home", "retired");
    expect(row(b.d, b.sf1)).toMatchObject({ status: "forfeited", outcome: { kind: "award", reason: "retired" } });
  });

  it("a double walkover on the FINAL (no next match) is refused DOUBLE_WALKOVER_NO_NEXT_MATCH and the final stays open (X-DW-3)", async () => {
    const { m, d, fin } = await bracket("generic");
    await forfeit(m, d, 0, "home", "walkover"); // sf1
    await forfeit(m, d, 1, "home", "walkover"); // sf2 (pool [sf1, sf2])
    expect(row(d, fin).home_entrant_id).not.toBeNull();
    expect(row(d, fin).away_entrant_id).not.toBeNull();
    await forfeit(m, d, 2, "both", "walkover"); // the pool is [sf1, sf2, fin]
    expect(lastForfeit(m)).toMatchObject({ code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
    expect(row(d, fin).status).toBe("scheduled");
  });

  it("a double walkover on a DECIDED final meets two rules — guarantee 4 (ALREADY_DECIDED) and the server's X-DW-3 — so either code is the product's; on a decided semi only ALREADY_DECIDED applies", async () => {
    // The rule-10 sweep's counterexample once the cascade's reason is the engine's: [Settle, Walkover, Score,
    // Withdraw(3,0), Forfeit(13,2)] — the server rule answered first and the model held only ALREADY_DECIDED.
    const { m, d, fin, sf1 } = await bracket("generic");
    await forfeit(m, d, 0, "home", "walkover"); // sf1
    await forfeit(m, d, 1, "home", "walkover"); // sf2
    await forfeit(m, d, 2, "home", "walkover"); // the final, decided
    expect(row(d, fin).status).toBe("forfeited");
    await forfeit(m, d, 2, "both", "walkover");
    expect(lastForfeit(m)).toMatchObject({ code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
    expect(row(d, fin)).toMatchObject({ status: "forfeited", outcome: { kind: "award", reason: "walkover" } });
    // `both` with any other reason is no double walkover (X-DW-1): the schema's R1 answers, not the server rule.
    await forfeit(m, d, 2, "both", "disqualified");
    expect(lastForfeit(m)).toMatchObject({ code: "INVALID_EVENT" });
    // The positive pair: a decided semi feeds the final, so the server rule does not apply and guarantee 4 answers.
    await forfeit(m, d, 0, "both", "walkover");
    expect(lastForfeit(m)).toMatchObject({ code: "ALREADY_DECIDED" });
    expect(liveForfeits(d, sf1).length, "one forfeit stands on the semi").toBe(1);
  });

  it("a LADDER fixture has no feed edge and is still never refused DOUBLE_WALKOVER_NO_NEXT_MATCH: the refusal is the feeding bracket kinds' alone (X-DW-3, D19)", async () => {
    const { m, d, sf1 } = await bracket("generic");
    d.stage!.kind = "ladder";
    const lm: ModelState = { ...m, stageKind: "ladder" };
    d.feeds.clear(); // a ladder wires no winner_to: every fixture reads as one with no next match
    const before = lm.forfeits.length;
    await forfeit(lm, d, 0, "both", "walkover");
    expect(lm.forfeits.length, "the forfeit was asked and answered").toBe(before + 1);
    expect(lastForfeit(lm)!.code).not.toBe("DOUBLE_WALKOVER_NO_NEXT_MATCH");
    expect(row(d, sf1).id).toBe(sf1);
  });

  it("a refusal with ANY OTHER code than the table's is a defect (model-forfeit-refused-by-name)", async () => {
    class WrongCode extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        if (events.some((e) => e.type === "core.forfeit" && (e.payload as { reason: string }).reason === "retired")) throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 422, "INVALID_EVENT", "no");
        return super.postStream(id, events, prefix);
      }
    }
    const { m, d } = await bracket("generic", () => new WrongCode({}));
    // A retirement before play is the table's FORFEIT_REASON_WRONG_PHASE (R4): INVALID_EVENT is another code.
    const e = await forfeit(m, d, 0, "home", "retired").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ModelViolation);
    expect((e as ModelViolation).check).toBe(FORFEIT_REFUSAL_CHECK);
  });
});

describe("the two W2b model invariants red on a faulty product, each on its own", () => {
  it("a double walkover that SEATS one of its entrants reds model-double-walkover-advances-nobody; a forfeit the product shows as decided reds model-one-result-per-active-forfeit; the correct product passes and counts both", async () => {
    class SeatsDoubleWalkover extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        const f = this.fixtures.find((x) => x.id === id)!;
        if ((f.outcome as { kind?: string } | null)?.kind === "double_walkover") this.fixtures.find((x) => x.round_no === 2)!.home_entrant_id = f.home_entrant_id; // X-DW-1 broken
        return out;
      }
    }
    class ForfeitDecides extends ModelFakeDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        const f = this.fixtures.find((x) => x.id === id)!;
        if (f.status === "forfeited") f.status = "decided"; // one result per active forfeit broken
        return out.map((p, i) => (i === out.length - 1 ? { ...p, status: f.status } : p));
      }
    }
    let reds = 0;
    for (const [label, make, side, check] of [
      ["a double walkover that seats", () => new SeatsDoubleWalkover({}), "both", DW_ADVANCES_NOBODY_CHECK],
      ["a forfeit shown decided", () => new ForfeitDecides({}), "home", FORFEIT_ONE_RESULT_CHECK],
    ] as const) {
      const { m, d } = await bracket("generic", make);
      const e = await forfeit(m, d, 0, side, "walkover").then(() => null, (x: unknown) => x);
      expect(e, label).toBeInstanceOf(ModelViolation);
      expect((e as ModelViolation).check, label).toBe(check);
      reds++;
    }
    expect(reds).toBe(2);
    // The positive pair: the same commands on the correct fake raise nothing, and both checks judged items.
    const ok = await bracket("generic");
    await forfeit(ok.m, ok.d, 0, "both", "walkover");
    await forfeit(ok.m, ok.d, 0, "home", "walkover"); // pool[0] is still sf1, now forfeited: a second forfeit, refused by name
    expect(ok.m.stepChecks.get(DW_ADVANCES_NOBODY_CHECK) ?? 0).toBeGreaterThan(0);
    expect(ok.m.stepChecks.get(FORFEIT_ONE_RESULT_CHECK) ?? 0).toBeGreaterThan(0);
  });
});

describe("rule 10 — the required sequences, every step checked", () => {
  /** Each named sequence the brief requires, run step by step through the model (each step's checkStep holds both W2b
   *  invariants), ending with what makes the shape the shape. A state no command reaches is seeded through the driver
   *  and the model is handed the product's own ledger (the two cases say so). */
  const SEQUENCES: readonly { name: string; sport: string; play: (b: Awaited<ReturnType<typeof bracket>>) => Promise<void> }[] = [
    { name: "forfeit after abandon", sport: "generic", play: async ({ m, d }) => {
      await run(m, d, "Settle", 0, 2);
      await run(m, d, "Void", 0, 0);
      await forfeit(m, d, 0, "home", "walkover");
      expect(lastForfeit(m)).toMatchObject({ code: "ABANDONED_SETTLE_OR_VOID" });
    } },
    { name: "void then forfeit", sport: "generic", play: async ({ m, d, sf1 }) => {
      await run(m, d, "Score", 0, 1);
      await run(m, d, "Void", 0, 0);
      await forfeit(m, d, 0, "away", "retired");
      expect(row(d, sf1).status).toBe("forfeited");
    } },
    { name: "double walkover then void", sport: "generic", play: async ({ m, d, sf1 }) => {
      await forfeit(m, d, 0, "both", "walkover");
      await run(m, d, "Void", 0, 0);
      expect(row(d, sf1).status).toBe("scheduled");
      await forfeit(m, d, 0, "home", "walkover");
      expect(row(d, sf1).status).toBe("forfeited");
    } },
    { name: "a second forfeit", sport: "football", play: async ({ m, d, sf1 }) => {
      await forfeit(m, d, 0, "away", "walkover");
      await forfeit(m, d, 0, "both", "walkover");
      expect(lastForfeit(m)).toMatchObject({ code: "ALREADY_DECIDED" });
      expect(liveForfeits(d, sf1).length).toBe(1);
    } },
    { name: "withdraw before start", sport: "generic", play: async ({ m, d, sf1 }) => {
      expect(row(d, sf1).status).toBe("scheduled");
      await run(m, d, "Withdraw", 0, 0);   // e1, sf1's home side
    } },
    { name: "withdraw after start", sport: "football", play: async ({ m, d, sf1 }) => {
      await run(m, d, "Score", 0, 0);
      await run(m, d, "Void", 0, 0);
      expect(row(d, sf1).status).toBe("in_play");
      await run(m, d, "Withdraw", 0, 0);
    } },
    { name: "both sides withdrawing in turn", sport: "generic", play: async ({ m, d, sf1 }) => {
      const away = row(d, sf1).away_entrant_id!;
      await run(m, d, "Withdraw", 0, 0);   // the model withdraws one entrant per run (Withdraw.ready) …
      for (const f of m.fixtures.values()) if (f.home === away || f.away === away) f.ledger = null;
      await d.withdraw(away);              // … so the second, the other side of sf1, goes through the driver
      m.withdrawn.add(away);
      await checkStep(m, d);
    } },
    { name: "a tie-break withdrawal", sport: "boardgame", play: async ({ m, d, sf1 }) => {
      // No command draws a drawn chess bracket game (boardgame's levelRefusal): the classical draw is posted through
      // the driver, and the model is handed the product's ledger.
      const f = row(d, sf1);
      const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout");
      const pending = generateStream({ sportKey: "boardgame", cfg, stageKind: "knockout", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "home" } }).slice(0, -1);
      await d.postStream(sf1, pending);
      m.fixtures.get(sf1)!.ledger = [...d.ledgers.get(sf1)!];
      await checkStep(m, d);
      expect(row(d, sf1).outcome, "a tie-break is pending").toBeNull();
      await run(m, d, "Withdraw", 0, 0);
    } },
  ];

  it("each required sequence runs with both invariants checked after every step (zero judged is a failure)", async () => {
    let ran = 0;
    let dw = 0;
    let one = 0;
    for (const s of SEQUENCES) {
      const b = await bracket(s.sport);
      await s.play(b);
      dw += b.m.stepChecks.get(DW_ADVANCES_NOBODY_CHECK) ?? 0;
      one += b.m.stepChecks.get(FORFEIT_ONE_RESULT_CHECK) ?? 0;
      ran++;
    }
    expect(ran).toBe(8);
    expect(dw, "no double walkover was ever judged").toBeGreaterThan(0);
    expect(one, "no active forfeit was ever judged").toBeGreaterThan(0);
  });
});

describe("rule 10 — fast-check: any sequence over Walkover, Forfeit, Void, Withdraw, Score and Settle keeps both invariants after every step", () => {
  const MOVES = ["Withdraw", "Score", "Walkover", "Void", "Settle", "Forfeit"] as const;
  const ALL = [...COMMAND_KINDS, ...OPT_IN_KINDS];
  /** MATRIX_FC_SEED replays a CI red locally (model-settle.test.ts reads the same variable). */
  const SEED = Number(process.env.MATRIX_FC_SEED ?? 20261009);
  const SPORTS = ["generic", "football", "boardgame"] as const;
  const RUNS = 100;
  const CODES = ["INVALID_EVENT", "FORFEIT_REASON_WRONG_PHASE", "ABANDONED_SETTLE_OR_VOID", "ALREADY_DECIDED", "DOUBLE_WALKOVER_NO_NEXT_MATCH"] as const;

  async function sweep(seed: number) {
    const arbs = modelCommands({ fences: true, settle: true, forfeit: true });
    expect(arbs.length).toBe(ALL.length);
    const moves = arbs.filter((_, i) => (MOVES as readonly string[]).includes(ALL[i]!));
    expect(moves.length).toBe(MOVES.length);
    const totals = { runs: 0, steps: 0, accepted: 0, doubles: 0, dw: 0, one: 0, codes: Object.fromEntries(CODES.map((c) => [c, 0])) as Record<string, number> };
    for (const sport of SPORTS) {
      await fc.assert(fc.asyncProperty(fc.commands(moves, { maxCommands: 30 }), async (cmds) => {
        const { m, d } = await bracket(sport);
        await fc.asyncModelRun(() => ({ model: m, real: d }), cmds);
        totals.runs++;
        totals.steps += m.steps.length;
        const fs = (m as ModelState & { forfeits: { status: number; code: string | null }[] }).forfeits;
        totals.accepted += fs.filter((x) => x.status < 300).length;
        for (const x of fs) if (x.code !== null && x.code in totals.codes) totals.codes[x.code]!++;
        for (const led of d.ledgers.values()) totals.doubles += led.filter((e) => e.type === "core.forfeit" && (e.payload as { by: string }).by === "both").length;
        totals.dw += m.stepChecks.get(DW_ADVANCES_NOBODY_CHECK) ?? 0;
        totals.one += m.stepChecks.get(FORFEIT_ONE_RESULT_CHECK) ?? 0;
      }), { numRuns: RUNS, seed });
    }
    return totals;
  }

  it("over the three bracket shapes: invariants hold, Forfeit is accepted (a double walkover among them) and refused by each of the table's codes, and the sweep replays from its seed", async () => {
    const totals = await sweep(SEED);
    expect(totals.runs).toBe(SPORTS.length * RUNS);
    expect(totals.steps).toBeGreaterThan(0);
    expect(totals.accepted, "no Forfeit was ever accepted").toBeGreaterThan(0);
    expect(totals.doubles, "no double walkover was ever posted").toBeGreaterThan(0);
    expect(totals.dw, "no double walkover was ever judged").toBeGreaterThan(0);
    expect(totals.one, "no active forfeit was ever judged").toBeGreaterThan(0);
    for (const c of CODES) expect(totals.codes[c], `no Forfeit was ever refused ${c}`).toBeGreaterThan(0);
    expect(await sweep(SEED)).toEqual(totals);
  });
});
