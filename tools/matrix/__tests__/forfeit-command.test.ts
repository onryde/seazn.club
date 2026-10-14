// W2b Task 2 (D10, spec §5.6): the model's Forfeit command, OPT-IN like W2a's Settle, so every committed fast-check
// regression replays unchanged. Its contract per state is the plan's D3 phase-guard table, D4's abandon guard and PF-2's
// writer rule — typed here from those rules, never read back from the command. After every step the model checks two
// W2b invariants from the product's rows: nobody advances from a double walkover (X-DW-1, X-DW-2), and one result per
// active forfeit. Folds through loop D's kernel (core.forfeit {by: "both"}, the strict reasons, the phase guard).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { COMMAND_KINDS, MAX_ENTRANTS, MODEL_ENTRANTS, ModelViolation, OPT_IN_KINDS, SWISS_BIAS, checkStep, commandOf, modelCommands, newModelState, type ModelState } from "../lib/model/commands.ts";
import { biasFor } from "../lib/model/run-cell.ts";
import { DW_ADVANCES_NOBODY_CHECK, FORFEIT_ONE_RESULT_CHECK, FORFEIT_REFUSAL_CHECK, FORFEIT_TABLE_CHECK, NEXT_MATCH_LOCK, lastRoundReadDiverges, modelRowRefusal } from "../lib/model/state.ts";
import { BRACKET_OF } from "../lib/scenarios/terminal-finals.ts";
import { loadRegressions, replayFences } from "../lib/scenario-catalogue.ts";
import { decidersOffRulesFor, resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { generateStream, partialPlay } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { bracketWithdrawalActs } from "./fake-driver.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";
import { nextMatchStartedText } from "./product-text.ts";

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

/** Two semis feeding a final, the stage reading as a knockout, started — model-settle.test.ts's bracket, a HOLD-PATH stage
 *  (R-T12-3): every decider off, so a level result is held. */
async function bracket(sport: string, make: () => ModelFakeDriver = () => new ModelFakeDriver({})) {
  const d = make();
  const base = await newModelState({ driver: d, row: "league", sport, variant: offlineBuilderDefault(sport), entrants: 4, tag: "t" });
  if (d.stage === null) throw new Error("test: no stage");
  const stageRules = decidersOffRulesFor(sport, offlineBuilderDefault(sport), "knockout");
  d.stage.kind = "knockout";
  if (stageRules !== undefined) d.stage.config = { ...d.stage.config, rules: stageRules };
  const m: ModelState = { ...base, stageKind: "knockout", stageRules };
  const [e1, e2, e3, e4] = m.entrants as [string, string, string, string];
  const sf1 = d.seat(1, e1, e4);
  const sf2 = d.seat(1, e2, e3);
  const fin = d.seat(2, null, null);
  d.feed(sf1.id, fin.id, 1);
  d.feed(sf2.id, fin.id, 2);
  await commandOf("Start", 0, 0, false).run(m, d);
  return { m, d, sf1: sf1.id, sf2: sf2.id, fin: fin.id };
}
/** A league of four, started — the table shape (review I-4): the model's own league, nothing flipped. */
async function league(sport: string, make: () => ModelFakeDriver = () => new ModelFakeDriver({})) {
  const d = make();
  const m = await newModelState({ driver: d, row: "league", sport, variant: offlineBuilderDefault(sport), entrants: 4, tag: "t" });
  await commandOf("Start", 0, 0, false).run(m, d);
  return { m, d };
}
const row = (d: ModelFakeDriver, id: string) => d.fixtures.find((f) => f.id === id)!;
/** The three W2b forfeit invariants' judged items so far (each step adds what it judged). */
const forfeitJudged = (m: ModelState) => [DW_ADVANCES_NOBODY_CHECK, FORFEIT_ONE_RESULT_CHECK, FORFEIT_TABLE_CHECK].reduce((s, id) => s + (m.stepChecks.get(id) ?? 0), 0);
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
  it("on an untouched semi (phase pre): a walkover either side or both is accepted; retired/disqualified are refused FORFEIT_REASON_WRONG_PHASE (R4); both with another reason, and any withdrew, are refused INVALID_EVENT (R1, PF-2) — all twelve draws, each on a fresh bracket, every sport", async () => {
    const TABLE: readonly [(typeof SIDES)[number], (typeof REASONS)[number], string | null][] = [
      ["home", "walkover", null], ["away", "walkover", null], ["both", "walkover", null],
      ["home", "retired", "FORFEIT_REASON_WRONG_PHASE"], ["away", "retired", "FORFEIT_REASON_WRONG_PHASE"], ["both", "retired", "INVALID_EVENT"],
      ["home", "disqualified", "FORFEIT_REASON_WRONG_PHASE"], ["away", "disqualified", "FORFEIT_REASON_WRONG_PHASE"], ["both", "disqualified", "INVALID_EVENT"],
      ["home", "withdrew", "INVALID_EVENT"], ["away", "withdrew", "INVALID_EVENT"], ["both", "withdrew", "INVALID_EVENT"],
    ];
    let checked = 0;
    for (const sport of SPORT_KEYS) for (const [side, reason, code] of TABLE) {
      const { m, d, sf1, fin } = await bracket(sport);
      await forfeit(m, d, 0, side, reason);
      const f = row(d, sf1);
      const label = `${sport} ${side}/${reason}`;
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
    expect(checked).toBe(SPORT_KEYS.length * SIDES.length * REASONS.length);
  });

  it("in play (phase play): a disqualification is accepted from the Start and a retirement once something is played, with the played score kept; a retirement after a bare Start is refused FORFEIT_REASON_WRONG_PHASE (ruling 113) — except in chess, whose Start is play (ruling 118); a walkover is refused once something is played (R2, ruling 112) — accepted after a bare Start, and wherever the sport declares walkovers in play (chess, FIDE 6.7.1)", async () => {
    // single-sport per case: generic declares walkovers in `pre` only, boardgame in `pre`, `play` and `tiebreak` (D3);
    // football for the played case. Generic's and chess's win streams are START + one deciding event, so the take-back
    // leaves a bare START — nothing played in generic (rulings 112, 113), play in chess (ruling 118: its Start is play);
    // football's keeps its goal — something played.
    for (const [sport, side, reason, played, code] of [
      ["generic", "home", "retired", false, "FORFEIT_REASON_WRONG_PHASE"], ["generic", "away", "disqualified", false, null], ["generic", "home", "walkover", false, null],
      ["football", "home", "walkover", true, "FORFEIT_REASON_WRONG_PHASE"], ["football", "away", "retired", true, null],
      ["boardgame", "home", "walkover", false, null], ["boardgame", "away", "retired", false, null], ["boardgame", "away", "disqualified", false, null],
    ] as const) {
      const { m, d, sf1 } = await bracket(sport);
      await run(m, d, "Score", 0, 0);   // sf1 decided by play …
      await run(m, d, "Void", 0, 0);    // … and its deciding event taken back: in play, START kept
      expect(row(d, sf1).status, `${sport}: in play`).toBe("in_play");
      const led = d.ledgers.get(sf1)!;
      const voided = new Set(led.flatMap((e) => (e.voids === undefined ? [] : [e.voids])));
      const live = led.filter((e) => e.type !== "core.void" && !voided.has(e.id)).map((e) => e.type);
      expect(live[0], `rig: ${sport} started`).toBe("core.start");
      expect(live.some((t) => !t.startsWith("core.")), `rig: ${sport} ${played ? "has" : "has no"} sport event standing`).toBe(played);
      const before = led.length;
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

  it("a second forfeit on a decided fixture is refused ALREADY_DECIDED, and a forfeit while an abandon is active is refused ABANDONED_SETTLE_OR_VOID (D4); void the abandon and the disqualification is accepted (X-AB-4)", async () => {
    const a = await bracket("generic");
    await forfeit(a.m, a.d, 0, "home", "walkover");
    await forfeit(a.m, a.d, 0, "away", "walkover");
    expect(lastForfeit(a.m)).toMatchObject({ code: "ALREADY_DECIDED" });
    expect(liveForfeits(a.d, a.sf1).length, "one forfeit stands").toBe(1);

    const b = await bracket("generic");
    await run(b.m, b.d, "Settle", 0, 2);  // an open semi held by an abandon at score, then settled
    await run(b.m, b.d, "Void", 0, 0);    // the settle taken back: abandoned, held
    expect(row(b.d, b.sf1).status).toBe("abandoned");
    // Generic's abandon at score holds a bare START (its win is one deciding event): nothing played, so the in-match
    // reason is the disqualification (ruling 113 refuses a retirement there).
    await forfeit(b.m, b.d, 0, "home", "disqualified");
    expect(lastForfeit(b.m)).toMatchObject({ code: "ABANDONED_SETTLE_OR_VOID" });
    await run(b.m, b.d, "Void", 0, 0);    // the abandon taken back: in play again
    await forfeit(b.m, b.d, 0, "home", "disqualified");
    expect(row(b.d, b.sf1)).toMatchObject({ status: "forfeited", outcome: { kind: "award", reason: "disqualified" } });
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

  // The model holds no feed edges (the product's fixture list serves none: driver/types.ts FixtureRow), so its X-DW-3 is
  // the structural last round. It is the product's feedsNextMatch exactly where the two agree; loop F I-5 is where they
  // part — a match whose winner AND loser feed one fixture is not in the last round, and has no next match.
  it("loop F I-5 on the model: its last-round read IS the product's next-match rule on every bracket row it drives, at every field it can start (its first field up to its ceiling) — swept, every fixture counted", () => {
    // single-sport: the read is the bracket's shape, never the sport.
    const kinds = new Set<string>();
    let rows = 0;
    let laidOut = 0;
    let fixtures = 0;
    for (const r of ROW_KEYS) {
      if (modelRowRefusal(r) !== null) continue;
      const [body, ...rest] = stagesForRow(r);
      expect(rest, `${r}: the model drives single-stage rows only`).toEqual([]);
      if (!NEXT_MATCH_LOCK.kinds.includes(body!.kind)) continue;
      rows++;
      kinds.add(body!.kind);
      for (let n = MODEL_ENTRANTS; n <= MAX_ENTRANTS; n++) {
        // A size the engine cannot lay out is one the product's Start refuses: no fixture of it is ever judged.
        const engineLaysOut = (() => {
          try {
            BRACKET_OF[body!.kind]!(Array.from({ length: n }, (_, i) => `e${i + 1}`), body!.config);
            return true;
          } catch (e) {
            if (EngineError.is(e)) return false;
            throw e;
          }
        })();
        const read = lastRoundReadDiverges(body!.kind, body!.config, n);
        expect(read.diverges, `${r} (${body!.kind} ${JSON.stringify(body!.config)}) of ${n}`).toEqual([]);
        expect(read.checked > 0, `${r} of ${n}: fixtures read exactly when the engine lays the field out`).toBe(engineLaysOut);
        if (engineLaysOut) laidOut++;
        fixtures += read.checked;
      }
    }
    expect(rows, "bracket rows the model drives").toBeGreaterThan(0);
    expect(kinds, "the kind I-5 bites on is among them").toContain("double_elim");
    expect(laidOut, "shapes read").toBeGreaterThanOrEqual(rows);
    expect(fixtures).toBeGreaterThan(laidOut);
  });

  it("loop F I-5 on the model: where the two part — a bracket reset's grand final, a two-entrant double elim's winners' match — the read names each, and Start refuses the shape by name before the product is asked", async () => {
    const field = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
    // The engine's own declarations: the reset's first grand final is its non-conditional final; a two-entrant double
    // elim's winners' match is the one fixture fed nothing.
    const resetGf = BRACKET_OF.double_elim!(field(4), { bracketReset: true }).fixtures.find((g) => g.isFinal === true && g.conditional !== true)!.id;
    const opener = BRACKET_OF.double_elim!(field(2), {}).fixtures.find((g) => g.homeFrom === undefined && g.awayFrom === undefined)!.id;
    expect(lastRoundReadDiverges("double_elim", { bracketReset: true }, 4).diverges).toEqual([resetGf]);
    expect(lastRoundReadDiverges("double_elim", {}, 2).diverges).toEqual([opener]);
    expect(lastRoundReadDiverges("double_elim", { bracketReset: true }, 2).diverges).toEqual([opener, resetGf]);
    expect(lastRoundReadDiverges("double_elim", {}, 4), "the positive pair: no reset at four").toMatchObject({ diverges: [] });
    expect(MODEL_ENTRANTS, "the model's first field is above the two-entrant shape").toBeGreaterThan(2);
    // A feeding kind with no generator is refused, never passed as agreeing; today every feeding kind has one.
    expect(() => lastRoundReadDiverges("double_elim", {}, 4, {})).toThrow(/feeds next matches, but BRACKET_OF lays out no bracket/);
    expect(NEXT_MATCH_LOCK.kinds.filter((k) => BRACKET_OF[k] === undefined), "feeding kinds with no generator").toEqual([]);
    expect(lastRoundReadDiverges("ladder", {}, 4), "a kind with no feed edges reads nothing").toEqual({ checked: 0, diverges: [] });
    // Through the real producer: a started double elim with a reset is refused at Start, the division never started.
    const d = new ModelFakeDriver({});
    const base = await newModelState({ driver: d, row: "league", sport: "generic", variant: offlineBuilderDefault("generic"), entrants: MODEL_ENTRANTS, tag: "t" });
    const m: ModelState = { ...base, stageKind: "double_elim", stageConfig: { bracketReset: true } };
    await expect(commandOf("Start", 0, 0, false).run(m, d)).rejects.toThrow(new RegExp(`lays out ${resetGf}, .*X-DW-3.*loop F I-5`));
    expect(m.started).toBe(false);
    expect(d.fixtures, "the product was never asked to start").toEqual([]);
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
  /** Each named sequence the brief requires, run step by step through the model (each step's checkStep holds the W2b
   *  invariants), ending with what makes the shape the shape. A state no command reaches is seeded through the driver
   *  and the model is handed the product's own ledger (the cases say so). `play` answers the items it judged itself
   *  (an assertion on the product's row the step invariants cannot make), so every sequence reports its own count. */
  type Seq = { name: string; sport: string; play: (b: Awaited<ReturnType<typeof bracket>>) => Promise<number> };
  const SEQUENCES: readonly Seq[] = [
    { name: "forfeit after abandon", sport: "generic", play: async ({ m, d }) => {
      await run(m, d, "Settle", 0, 2);
      await run(m, d, "Void", 0, 0);
      await forfeit(m, d, 0, "home", "walkover");
      expect(lastForfeit(m)).toMatchObject({ code: "ABANDONED_SETTLE_OR_VOID" });
      return 1;
    } },
    // The sweep's find on the merged W2b tree (seed 20261009, path 25:4:1:1:1, [Settle(0,0), Forfeit(0,0)]): once a
    // settle has decided the abandoned match, D4 no longer applies (events.ts `abandonActive && settlement === null`,
    // loop D review M-6). Nothing is left to settle or replay, so the forfeit falls to guarantee 4.
    { name: "forfeit over a settled abandon", sport: "generic", play: async ({ m, d, sf1 }) => {
      await run(m, d, "Settle", 0, 2);
      expect(row(d, sf1).status).toBe("decided");
      await forfeit(m, d, 0, "home", "walkover");
      expect(lastForfeit(m)).toMatchObject({ code: "ALREADY_DECIDED" });
      return 1;
    } },
    { name: "void then forfeit", sport: "generic", play: async ({ m, d, sf1 }) => {
      await run(m, d, "Score", 0, 1);
      await run(m, d, "Void", 0, 0);
      // The take-back leaves a bare START (generic's win is one event): the in-match reason is the disqualification
      // (ruling 113).
      await forfeit(m, d, 0, "away", "disqualified");
      expect(row(d, sf1).status).toBe("forfeited");
      return 1;
    } },
    { name: "double walkover then void", sport: "generic", play: async ({ m, d, sf1 }) => {
      await forfeit(m, d, 0, "both", "walkover");
      await run(m, d, "Void", 0, 0);
      expect(row(d, sf1).status).toBe("scheduled");
      await forfeit(m, d, 0, "home", "walkover");
      expect(row(d, sf1).status).toBe("forfeited");
      return 2;
    } },
    { name: "a second forfeit", sport: "football", play: async ({ m, d, sf1 }) => {
      await forfeit(m, d, 0, "away", "walkover");
      await forfeit(m, d, 0, "both", "walkover");
      expect(lastForfeit(m)).toMatchObject({ code: "ALREADY_DECIDED" });
      expect(liveForfeits(d, sf1).length).toBe(1);
      return 2;
    } },
  ];

  it("each required forfeit sequence runs with the invariants checked after every step, and EACH reports the items it judged (zero judged is a failure, per sequence)", async () => {
    const counts: Record<string, number> = {};
    let dw = 0;
    let one = 0;
    for (const s of SEQUENCES) {
      const b = await bracket(s.sport);
      const own = await s.play(b);
      counts[s.name] = own + forfeitJudged(b.m);
      dw += b.m.stepChecks.get(DW_ADVANCES_NOBODY_CHECK) ?? 0;
      one += b.m.stepChecks.get(FORFEIT_ONE_RESULT_CHECK) ?? 0;
    }
    expect(Object.keys(counts)).toEqual(SEQUENCES.map((s) => s.name));
    for (const [name, n] of Object.entries(counts)) expect(n, `${name}: judged nothing`).toBeGreaterThan(0);
    expect(dw, "no double walkover was ever judged").toBeGreaterThan(0);
    expect(one, "no active forfeit was ever judged").toBeGreaterThan(0);
  });

  /** Review I-3: a withdrawal on a BRACKET walks every pending fixture of the withdrawn side over to its opponent
   *  (withdrawal.ts BRACKET_WALKOVER_KINDS → withdrawBracketEntrant, X-WD-1; BG-WO-3 in a pending tie-break) — never the
   *  league's expunge. The award's reason is D1's `withdrew` (typed from the decision). Red until loop F lands it:
   *  withdrawal.ts's REASON is still "entrant withdrew", which the engine's closed reason list refuses (INVALID_EVENT). */
  const WITHDRAWALS: readonly Seq[] = [
    { name: "withdraw before start", sport: "generic", play: async ({ m, d, sf1 }) => {
      expect(row(d, sf1).status).toBe("scheduled");
      await run(m, d, "Withdraw", 0, 0);   // e1, sf1's home side
      return 0;
    } },
    { name: "withdraw after start", sport: "football", play: async ({ m, d, sf1 }) => {
      await run(m, d, "Score", 0, 0);
      await run(m, d, "Void", 0, 0);
      expect(row(d, sf1).status).toBe("in_play");
      await run(m, d, "Withdraw", 0, 0);
      return 0;
    } },
    { name: "both sides withdrawing in turn", sport: "generic", play: async ({ m, d, sf1 }) => {
      const away = row(d, sf1).away_entrant_id!;
      await run(m, d, "Withdraw", 0, 0);   // the model withdraws one entrant per run (Withdraw.ready) …
      for (const f of m.fixtures.values()) if (f.home === away || f.away === away) f.ledger = null;
      await d.withdraw(away);              // … so the second, the other side of sf1, goes through the driver
      m.withdrawn.add(away);
      await checkStep(m, d);
      return 0;
    } },
    { name: "a tie-break withdrawal", sport: "boardgame", play: async ({ m, d, sf1 }) => {
      // No command draws a drawn chess bracket game (boardgame's levelRefusal): the classical draw is posted through
      // the driver, and the model is handed the product's ledger.
      const f = row(d, sf1);
      const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
      const pending = generateStream({ sportKey: "boardgame", cfg, stageKind: "knockout", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "home" } }).slice(0, -1);
      await d.postStream(sf1, pending);
      m.fixtures.get(sf1)!.ledger = [...d.ledgers.get(sf1)!];
      await checkStep(m, d);
      expect(row(d, sf1).outcome, "a tie-break is pending").toBeNull();
      await run(m, d, "Withdraw", 0, 0);
      return 0;
    } },
  ];

  it("X-WD-1 / BG-WO-3 on a bracket (review I-3): each withdrawal sequence leaves the withdrawn side's semi a FORFEITED award to its opponent, reason withdrew — never expunged — each sequence judged (red until loop F lands withdrawal.ts's reason)", async () => {
    const judged: Record<string, number> = {};
    for (const s of WITHDRAWALS) {
      const b = await bracket(s.sport);
      const sf = row(b.d, b.sf1);
      const [home, away] = [sf.home_entrant_id!, sf.away_entrant_id!];
      const own = await s.play(b);
      // The first withdrawal is always sf1's home side (Withdraw(0,0) → e1): the award goes to the away side.
      expect(row(b.d, b.sf1), s.name).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: away, loser: home, reason: REASONS[3] } });
      judged[s.name] = own + 1 + forfeitJudged(b.m);
    }
    expect(Object.keys(judged)).toEqual(WITHDRAWALS.map((s) => s.name));
    for (const [name, n] of Object.entries(judged)) expect(n, `${name}: judged nothing`).toBeGreaterThan(0);
  });

  /** Post-F re-checks 2–5 on the model fake: loop F's bracket cascade (withdrawal.ts), driven on the driver itself. */
  // The cfg `bracket`'s hold-path knockout folds under: the presets with every decider off (R-T12-3).
  const knockoutCfg = (sport: string) => stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "knockout", offlineBuilderDefault(sport), decidersOffRulesFor(sport, offlineBuilderDefault(sport), "knockout"));
  const stream = (sport: string, home: string, away: string, outcome: Parameters<typeof generateStream>[0]["outcome"]) =>
    generateStream({ sportKey: sport, cfg: knockoutCfg(sport), stageKind: "knockout", home, away, outcome });
  it("rulings 53 + 106 on the model (withdrawal.ts's bracket branch, read from the product): a semi-final loser with nothing pending answers policy none; a side of an open semi-final answers walkover", async () => {
    // single-sport: the policy reads statuses and seats, never the sport.
    const b = await bracket("generic");
    const sf1 = row(b.d, b.sf1);
    const [w, l] = [sf1.home_entrant_id!, sf1.away_entrant_id!];
    await b.d.postStream(b.sf1, stream("generic", w, l, { kind: "win", winner: "home" }));
    const mine = (id: string) => b.d.fixtures.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id);
    const acting = (id: string) => mine(id).filter((f) => bracketWithdrawalActs(f.status, b.d.abandonActive(f))).length;
    expect([mine(l).length, acting(l)], "premise: the loser holds her semi-final, nothing pending").toEqual([1, 0]);
    expect(await b.d.withdraw(l), "nothing pending").toMatchObject({ policy: "none", walkovers: 0, voided: 0 });
    const side = row(b.d, b.sf2).home_entrant_id!;
    expect(acting(side), "premise: one line pending").toBe(1);
    expect(await b.d.withdraw(side), "one pending").toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
  });
  it("X-WD-3 on the model (loop F departSeat): a withdrawal whose next opponent is TBD empties her seat and counts one walkover; the arrival walks over by bye (C-5)", async () => {
    // single-sport: the seat rule reads seats and statuses, never the sport.
    const b = await bracket("generic");
    const sf1 = row(b.d, b.sf1);
    const w = sf1.home_entrant_id!;
    await b.d.postStream(b.sf1, stream("generic", w, sf1.away_entrant_id!, { kind: "win", winner: "home" }));
    expect(row(b.d, b.fin).home_entrant_id, "premise: the winner went on").toBe(w);
    expect(await b.d.withdraw(w)).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: 0 });
    expect(row(b.d, b.fin).home_entrant_id, "her seat is emptied").toBeNull();
    const sf2 = row(b.d, b.sf2);
    await b.d.postStream(b.sf2, stream("generic", sf2.home_entrant_id!, sf2.away_entrant_id!, { kind: "win", winner: "away" }));
    expect(row(b.d, b.fin)).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: sf2.away_entrant_id, loser: null, reason: "bye" } });
  });

  it("X-WD-1 on the model: an abandoned line has its abandon voided first, then walks over, counted held; a held level result walks over, counted held; play under way walks over, not held (C-2, the plan's N1)", async () => {
    const cases: { sport: string; outcome: Parameters<typeof generateStream>[0]["outcome"]; status: string; held: number; writes: string[] }[] = [
      { sport: "generic", outcome: { kind: "abandon" }, status: "abandoned", held: 1, writes: ["core.void", "core.forfeit"] },
      { sport: "football", outcome: { kind: "level" }, status: "needs_decision", held: 1, writes: ["core.forfeit"] },
    ];
    let checked = 0;
    for (const c of cases) {
      const b = await bracket(c.sport);
      const sf1 = row(b.d, b.sf1);
      const [home, away] = [sf1.home_entrant_id!, sf1.away_entrant_id!];
      await b.d.postStream(b.sf1, stream(c.sport, home, away, c.outcome));
      expect(row(b.d, b.sf1).status, `${c.sport}: premise`).toBe(c.status);
      const before = b.d.ledgers.get(b.sf1)!.length;
      expect(await b.d.withdraw(home), c.sport).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: c.held });
      expect(row(b.d, b.sf1), c.sport).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: away, loser: home, reason: REASONS[3] } });
      expect(b.d.ledgers.get(b.sf1)!.slice(before).map((e) => e.type), `${c.sport}: the cascade's writes`).toEqual(c.writes);
      checked++;
    }
    // Play under way with nothing owed: walked over, not held.
    const b = await bracket("generic");
    const sf1 = row(b.d, b.sf1);
    await b.d.postStream(b.sf1, partialPlay({ sportKey: "generic", cfg: knockoutCfg("generic"), stageKind: "knockout", home: sf1.home_entrant_id!, away: sf1.away_entrant_id!, outcome: { kind: "abandon" } }));
    expect(row(b.d, b.sf1).status, "premise").toBe("in_play");
    expect(await b.d.withdraw(sf1.home_entrant_id!)).toMatchObject({ walkovers: 1, walked_over_held: 0 });
    checked++;
    expect(checked).toBe(3);
  });

  /** Re-review round 2, item 3: the model fake's double walkover kills the seat it feeds (fake-driver.ts feed/killSlot,
   *  stages.ts resolveBracketSeats). Expected values from the rules: C-5's bye award beside a dead seat, Review Focus 1's
   *  void when both seats are dead and not both departed, and its revive when the double walkover is voided. */
  const DW: StreamEvent[] = [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }];
  const bye = (winner: string | null) => ({ status: "forfeited", outcome: { kind: "award", winner, loser: null, reason: "bye" } });
  const voidOf = async (d: ModelFakeDriver, id: string, type: string) => {
    const e = [...d.ledgers.get(id)!].reverse().find((x) => x.type === type)!;
    await d.postStream(id, [{ type: "core.void", payload: { event_id: e.id } }]);
  };
  it("a double walkover kills the seat it feeds: the entrant beside it walks over by bye, whichever arrives first (X-DW-2, C-5)", async () => {
    // single-sport: the seat rule reads seats and statuses, never the sport.
    let checked = 0;
    for (const order of ["dw first", "arrival first"] as const) {
      const b = await bracket("generic");
      const sf2 = row(b.d, b.sf2);
      const win = () => b.d.postStream(b.sf2, stream("generic", sf2.home_entrant_id!, sf2.away_entrant_id!, { kind: "win", winner: "away" }));
      if (order === "arrival first") await win();
      await b.d.postStream(b.sf1, DW);
      expect(row(b.d, b.sf1), `${order}: premise`).toMatchObject({ status: "forfeited", outcome: { kind: "double_walkover" } });
      expect(row(b.d, b.fin).home_entrant_id, `${order}: the double walkover seats nobody`).toBeNull();
      if (order === "dw first") {
        expect(row(b.d, b.fin), "the other side is still on its way: nothing yet").toMatchObject({ status: "scheduled", outcome: null });
        await win();
      }
      expect(row(b.d, b.fin), order).toMatchObject({ away_entrant_id: sf2.away_entrant_id, ...bye(sf2.away_entrant_id) });
      expect(b.d.ledgers.get(b.fin) ?? [], `${order}: the bye writes no event`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("a line whose two seats are dead and not both departed is a void — two recorded double walkovers, or a departed seat beside one (Review Focus 1)", async () => {
    // single-sport: as above.
    const two = await bracket("generic");
    await two.d.postStream(two.sf1, DW);
    await two.d.postStream(two.sf2, DW);
    expect(row(two.d, two.fin), "two recorded double walkovers").toMatchObject({ status: "abandoned", outcome: null, home_entrant_id: null, away_entrant_id: null });
    // The departed seat first: sf2's winner waits in the final and withdraws while its other seat is TBD (X-WD-3).
    const one = await bracket("generic");
    const sf2 = row(one.d, one.sf2);
    await one.d.postStream(one.sf2, stream("generic", sf2.home_entrant_id!, sf2.away_entrant_id!, { kind: "win", winner: "away" }));
    expect(await one.d.withdraw(sf2.away_entrant_id!)).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
    expect(row(one.d, one.fin), "premise: her seat emptied, the other still on its way").toMatchObject({ status: "scheduled", away_entrant_id: null });
    await one.d.postStream(one.sf1, DW);
    expect(row(one.d, one.fin), "a departed seat beside a recorded double walkover").toMatchObject({ status: "abandoned", outcome: null, home_entrant_id: null, away_entrant_id: null });
  });
  it("voiding the double walkover revives the seat it killed: the bye walkover goes back to waiting, and so does a void, whose other dead seat stays dead; a seat still waiting is live again (Review Focus 1)", async () => {
    // single-sport: as above.
    const b = await bracket("generic");
    const [sf1, sf2] = [row(b.d, b.sf1), row(b.d, b.sf2)];
    await b.d.postStream(b.sf2, stream("generic", sf2.home_entrant_id!, sf2.away_entrant_id!, { kind: "win", winner: "away" }));
    await b.d.postStream(b.sf1, DW);
    expect(row(b.d, b.fin), "premise").toMatchObject(bye(sf2.away_entrant_id));
    await voidOf(b.d, b.sf1, "core.forfeit");
    expect(row(b.d, b.fin), "the walkover is taken back; the arrival keeps her seat").toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: null, away_entrant_id: sf2.away_entrant_id });
    await b.d.postStream(b.sf1, stream("generic", sf1.home_entrant_id!, sf1.away_entrant_id!, { kind: "win", winner: "home" }));
    expect(row(b.d, b.fin), "the revived seat fills: a match to play").toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: sf1.home_entrant_id, away_entrant_id: sf2.away_entrant_id });
    // A void revives too; the seat the OTHER double walkover killed stays dead, so sf1's next winner walks over by bye.
    const v = await bracket("generic");
    const vsf1 = row(v.d, v.sf1);
    await v.d.postStream(v.sf1, DW);
    await v.d.postStream(v.sf2, DW);
    expect(row(v.d, v.fin), "premise").toMatchObject({ status: "abandoned", outcome: null });
    await voidOf(v.d, v.sf1, "core.forfeit");
    expect(row(v.d, v.fin), "the void is taken back").toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: null, away_entrant_id: null });
    await v.d.postStream(v.sf1, stream("generic", vsf1.home_entrant_id!, vsf1.away_entrant_id!, { kind: "win", winner: "home" }));
    expect(row(v.d, v.fin), "beside sf2's still-dead seat").toMatchObject({ home_entrant_id: vsf1.home_entrant_id, ...bye(vsf1.home_entrant_id) });
    // A seat still waiting (its other side on its way) when its killer is taken back is simply live again.
    const w = await bracket("generic");
    const wsf1 = row(w.d, w.sf1);
    await w.d.postStream(w.sf1, DW);
    await voidOf(w.d, w.sf1, "core.forfeit");
    await w.d.postStream(w.sf1, stream("generic", wsf1.home_entrant_id!, wsf1.away_entrant_id!, { kind: "win", winner: "home" }));
    expect(row(w.d, w.fin), "the revived seat is filled, nothing walked over").toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: wsf1.home_entrant_id });
  });
  it("a double walkover's take-back is refused NEXT_MATCH_STARTED when the bye it caused already sent its winner into a started match, and writes nothing", async () => {
    // single-sport: as above. f1 feeds f2's home seat, f2 feeds f3's home seat; e3 waits in f2, e4 in f3.
    const d = new ModelFakeDriver({});
    const base = await newModelState({ driver: d, row: "league", sport: "generic", variant: offlineBuilderDefault("generic"), entrants: 4, tag: "t" });
    if (d.stage === null) throw new Error("test: no stage");
    d.stage.kind = "knockout";
    const m: ModelState = { ...base, stageKind: "knockout" };
    const [e1, e2, e3, e4] = m.entrants as [string, string, string, string];
    const [f1, f2, f3] = [d.seat(1, e1, e2), d.seat(2, null, e3), d.seat(3, null, e4)];
    d.feed(f1.id, f2.id, 1);
    d.feed(f2.id, f3.id, 1);
    await commandOf("Start", 0, 0, false).run(m, d);
    await d.postStream(f1.id, DW);
    expect(row(d, f2.id), "premise: e3 walks over by bye").toMatchObject(bye(e3));
    expect(row(d, f3.id).home_entrant_id, "premise: and goes on").toBe(e3);
    await d.postStream(f3.id, partialPlay({ sportKey: "generic", cfg: knockoutCfg("generic"), stageKind: "knockout", home: e3, away: e4, outcome: { kind: "abandon" } }));
    expect(row(d, f3.id).status, "premise: the next match started").toBe("in_play");
    const before = d.ledgers.get(f1.id)!.length;
    const e = await voidOf(d, f1.id, "core.forfeit").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).code).toBe(nextMatchStartedText().code);
    expect(d.ledgers.get(f1.id)!.length, "a refused take-back writes nothing").toBe(before);
    expect(row(d, f2.id), "the bye stands").toMatchObject(bye(e3));
    expect(row(d, f3.id).home_entrant_id).toBe(e3);
  });
  /** A started knockout on hand-built rows (`seats`), the stage reading as a knockout: model-core.test.ts's shape. */
  async function chain(n: number, seats: (d: ModelFakeDriver, es: string[]) => void) {
    const d = new ModelFakeDriver({});
    const base = await newModelState({ driver: d, row: "league", sport: "generic", variant: offlineBuilderDefault("generic"), entrants: n, tag: "t" });
    if (d.stage === null) throw new Error("test: no stage");
    d.stage.kind = "knockout";
    const m: ModelState = { ...base, stageKind: "knockout" };
    seats(d, [...m.entrants]);
    await commandOf("Start", 0, 0, false).run(m, d);
    return d;
  }
  it("a void kills the seat it feeds in turn, and taking back the double walkover behind it revives the chain (Review Focus 1)", async () => {
    // single-sport: as above. a and b feed v; v feeds f's home seat, where e5 waits opposite.
    let ids: Record<string, string> = {};
    const d = await chain(6, (dd, [e1, e2, e3, e4, e5]) => {
      const [a, b, v, f] = [dd.seat(1, e1!, e2!), dd.seat(1, e3!, e4!), dd.seat(2, null, null), dd.seat(3, null, e5!)];
      dd.feed(a.id, v.id, 1);
      dd.feed(b.id, v.id, 2);
      dd.feed(v.id, f.id, 1);
      ids = { a: a.id, b: b.id, v: v.id, f: f.id, e5: e5! };
    });
    await d.postStream(ids.a!, DW);
    await d.postStream(ids.b!, DW);
    expect(row(d, ids.v!), "two recorded double walkovers").toMatchObject({ status: "abandoned", outcome: null });
    expect(row(d, ids.f!), "the void kills the seat it feeds: e5 walks over by bye").toMatchObject(bye(ids.e5!));
    await voidOf(d, ids.a!, "core.forfeit");
    expect(row(d, ids.v!), "the void is taken back").toMatchObject({ status: "scheduled", outcome: null });
    expect(row(d, ids.f!), "and so is the bye it caused").toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: null, away_entrant_id: ids.e5 });
  });
  it("a withdrawal's emptied seat is never revived: its feeder seated her, and a double walkover recorded there later and taken back leaves it dead", async () => {
    // single-sport: as above. sf2's winner X waits in the final and withdraws while its other seat is TBD (X-WD-3);
    // the organiser then takes sf2's result back, records a double walkover there, and takes that back too.
    const b = await bracket("generic");
    const sf2 = row(b.d, b.sf2);
    const [h, x] = [sf2.home_entrant_id!, sf2.away_entrant_id!];
    await b.d.postStream(b.sf2, stream("generic", h, x, { kind: "win", winner: "away" }));
    await b.d.withdraw(x);
    expect(row(b.d, b.fin).away_entrant_id, "premise: her seat is emptied").toBeNull();
    for (const e of [...b.d.ledgers.get(b.sf2)!].reverse()) await b.d.postStream(b.sf2, [{ type: "core.void", payload: { event_id: e.id } }]);
    expect(row(b.d, b.sf2).outcome, "premise: sf2's result taken back").toBeNull();
    await b.d.postStream(b.sf2, DW);
    await voidOf(b.d, b.sf2, "core.forfeit");
    await b.d.postStream(b.sf2, stream("generic", h, x, { kind: "win", winner: "home" }));
    expect(row(b.d, b.fin).away_entrant_id, "the withdrawal's seat stays dead: nobody is seated there").toBeNull();
    const sf1 = row(b.d, b.sf1);
    await b.d.postStream(b.sf1, stream("generic", sf1.home_entrant_id!, sf1.away_entrant_id!, { kind: "win", winner: "home" }));
    expect(row(b.d, b.fin), "sf1's winner walks over beside it").toMatchObject({ home_entrant_id: sf1.home_entrant_id, ...bye(sf1.home_entrant_id) });
  });
  it("a line both of whose seats departed (X-WD-4's departure double walkover) is not modelled, and says so by name", async () => {
    // single-sport: as above. The model cannot reach it (no line seats two withdrawn sides), so the state is rigged:
    // sf2's seat in the final is marked departed, then sf1's winner withdraws while that seat is TBD.
    const b = await bracket("generic");
    const sf1 = row(b.d, b.sf1);
    await b.d.postStream(b.sf1, stream("generic", sf1.home_entrant_id!, sf1.away_entrant_id!, { kind: "win", winner: "home" }));
    b.d.deadSeats.add(`${b.fin}:2`);
    b.d.departedSeats.add(`${b.fin}:2`);
    await expect(b.d.withdraw(sf1.home_entrant_id!)).rejects.toThrow(/both seats of .* departed \(X-WD-4's departure double walkover\).*not modelled/);
  });
  it("X-WD-4 on a table (Loop R M-4): a line whose other side already left is a recorded double walkover, never a walkover to her; a line with live play is left as it is (M-1)", async () => {
    // single-sport: the check reads statuses, never the sport. Rigged, as the bracket case above is: the model never
    // leaves a withdrawn side seated on a pending line (every model withdrawal cascades), but the product meets one —
    // a self-withdrawal is a bare status write (ruling 111).
    const tableStream = (home: string, away: string) =>
      generateStream({ sportKey: "generic", cfg: resolveSportCfg("generic", offlineBuilderDefault("generic")), stageKind: "league", home, away, outcome: { kind: "win", winner: "home" } });
    let checked = 0;
    for (const played of [false, true]) {
      const { d } = await league("generic");
      const line = d.fixtures.find((x) => x.home_entrant_id !== null && x.away_entrant_id !== null)!;
      const [her, left] = [line.home_entrant_id!, line.away_entrant_id!];
      // The table policy walks her pending game over only once she has played half her games: play the other two.
      for (const f of d.fixtures.filter((x) => x.id !== line.id && (x.home_entrant_id === her || x.away_entrant_id === her))) {
        await d.postStream(f.id, tableStream(f.home_entrant_id!, f.away_entrant_id!));
      }
      if (played) await d.postStream(line.id, [{ type: "core.start", payload: {} }]);
      const before = [...(d.ledgers.get(line.id) ?? [])];
      d.entrants.find((e) => e.id === left)!.status = "withdrawn";
      const out = await d.withdraw(her);
      expect(out, played ? "M-1: nothing written" : "the double walkover counts as the line acted on").toMatchObject({ policy: "walkover", walkovers: played ? 0 : 1, voided: 0 });
      if (played) {
        expect(d.ledgers.get(line.id), "M-1: the played line's ledger is the organiser's").toEqual(before);
      } else {
        expect(row(d, line.id)).toMatchObject({ status: "forfeited", outcome: { kind: "double_walkover" } });
        expect(liveForfeits(d, line.id).map((e) => e.payload), "the cascade's bare double walkover").toEqual([{ by: "both", reason: "walkover" }]);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  /** Review I-4: the same rule on a TABLE — the league's standings read after every step (FORFEIT_TABLE_CHECK). */
  it("on a league: void-then-forfeit and a second forfeit each leave the table counting ONE result per active forfeit, read from the standings after every step; each sequence judged", async () => {
    const SEQS: readonly { name: string; sport: string; play: (b: Awaited<ReturnType<typeof league>>) => Promise<void> }[] = [
      { name: "void then forfeit", sport: "generic", play: async ({ m, d }) => {
        await run(m, d, "Score", 0, 1);
        await run(m, d, "Void", 0, 0);
        await forfeit(m, d, 0, "away", "disqualified"); // a bare START stands: no retirement (ruling 113)
      } },
      { name: "a forfeit voided, then forfeited again", sport: "football", play: async ({ m, d }) => {
        await forfeit(m, d, 0, "home", "walkover");
        await run(m, d, "Void", 0, 0);
        await forfeit(m, d, 0, "away", "walkover");
      } },
      { name: "a second forfeit", sport: "generic", play: async ({ m, d }) => {
        await forfeit(m, d, 0, "away", "walkover");
        await forfeit(m, d, 0, "both", "walkover");
        expect(lastForfeit(m)).toMatchObject({ code: "ALREADY_DECIDED" });
      } },
    ];
    const judged: Record<string, number> = {};
    for (const s of SEQS) {
      const b = await league(s.sport);
      await s.play(b);
      const f = [...b.d.fixtures].find((x) => liveForfeits(b.d, x.id).length > 0);
      expect(f, `${s.name}: a forfeit stands`).toBeDefined();
      expect(liveForfeits(b.d, f!.id).length, s.name).toBe(1);
      // The table itself, read here too: each side of the forfeited fixture has played exactly its one result.
      const rows = (await b.d.standings(b.m.stageId, null)).rows;
      for (const e of [f!.home_entrant_id!, f!.away_entrant_id!]) expect(rows.find((r) => r.entrantId === e)?.played, `${s.name}: ${e}`).toBe(1);
      judged[s.name] = b.m.stepChecks.get(FORFEIT_TABLE_CHECK) ?? 0;
    }
    expect(Object.keys(judged)).toEqual(SEQS.map((s) => s.name));
    for (const [name, n] of Object.entries(judged)) expect(n, `${name}: the table was never judged`).toBeGreaterThan(0);
  });

  it("a withdrawn entrant is not judged by the table check: a table that lists only its active entrants passes, and the forfeit's active side is still judged (the witness of the check's withdrawn exclusion)", async () => {
    class DropsWithdrawn extends ModelFakeDriver {
      override async standings(stageId: string, poolId: string | null) {
        const out = await super.standings(stageId, poolId);
        const gone = new Set(this.entrants.filter((e) => e.status === "withdrawn").map((e) => e.id));
        return { ...out, rows: out.rows.filter((r) => !gone.has(r.entrantId)) };
      }
    }
    const { m, d } = await league("generic", () => new DropsWithdrawn({}));
    await forfeit(m, d, 0, "away", "walkover");
    const f = [...d.fixtures].find((x) => liveForfeits(d, x.id).length > 0)!;
    // Seeded: the forfeit's home side withdrew and its cascade is done. Every command that withdraws runs a cascade,
    // and the state after it is the point here.
    const gone = f.home_entrant_id!;
    d.entrants.find((e) => e.id === gone)!.status = "withdrawn";
    m.withdrawn.add(gone);
    const before = m.stepChecks.get(FORFEIT_TABLE_CHECK) ?? 0;
    await checkStep(m, d);
    expect((m.stepChecks.get(FORFEIT_TABLE_CHECK) ?? 0) - before, "the away side alone").toBe(1);
  });

  it("a table that counts a voided forfeit again reds model-table-counts-one-result-per-forfeit by name (the league sequences above are its positive pair)", async () => {
    class CountsVoidedForfeits extends ModelFakeDriver {
      override async standings(stageId: string, poolId: string | null) {
        const out = await super.standings(stageId, poolId);
        // The stale aggregate: every forfeit the ledger EVER held is one more match played.
        const extra = new Map<string, number>();
        for (const f of this.fixtures) {
          const all = (this.ledgers.get(f.id) ?? []).filter((e) => e.type === "core.forfeit").length;
          const live = liveForfeits(this, f.id).length;
          for (const e of [f.home_entrant_id, f.away_entrant_id]) if (e !== null && all > live) extra.set(e, (extra.get(e) ?? 0) + all - live);
        }
        return { ...out, rows: out.rows.map((r) => ({ ...r, played: (r.played ?? 0) + (extra.get(r.entrantId) ?? 0) })) };
      }
    }
    const { m, d } = await league("generic", () => new CountsVoidedForfeits({}));
    await forfeit(m, d, 0, "home", "walkover");
    await run(m, d, "Void", 0, 0);
    const e = await forfeit(m, d, 0, "away", "walkover").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ModelViolation);
    expect((e as ModelViolation).check).toBe(FORFEIT_TABLE_CHECK);
  });
});

describe("rule 10 — fast-check: any sequence over Walkover, Forfeit, Void, Withdraw, Score and Settle keeps both invariants after every step", () => {
  const MOVES = ["Withdraw", "Score", "Walkover", "Void", "Settle", "Forfeit"] as const;
  const ALL = [...COMMAND_KINDS, ...OPT_IN_KINDS];
  /** MATRIX_FC_SEED replays a CI red locally (model-settle.test.ts reads the same variable). */
  const SEED = Number(process.env.MATRIX_FC_SEED ?? 20261009);
  const SPORTS = SPORT_KEYS;
  const RUNS = 200;
  const CODES = ["INVALID_EVENT", "FORFEIT_REASON_WRONG_PHASE", "ABANDONED_SETTLE_OR_VOID", "ALREADY_DECIDED", "DOUBLE_WALKOVER_NO_NEXT_MATCH"] as const;

  async function sweep(seed: number) {
    const arbs = modelCommands({ fences: true, settle: true, forfeit: true });
    expect(arbs.length).toBe(ALL.length);
    const moves = arbs.filter((_, i) => (MOVES as readonly string[]).includes(ALL[i]!));
    expect(moves.length).toBe(MOVES.length);
    const totals = { runs: 0, steps: 0, accepted: 0, doubles: 0, dw: 0, one: 0, byeBesideDw: 0, voidBesideDw: 0, dwTakenBack: 0, codes: Object.fromEntries(CODES.map((c) => [c, 0])) as Record<string, number> };
    for (const sport of SPORTS) {
      await fc.assert(fc.asyncProperty(fc.commands(moves, { maxCommands: 30 }), async (cmds) => {
        const b = await bracket(sport);
        const { m, d } = b;
        await fc.asyncModelRun(() => ({ model: m, real: d }), cmds);
        totals.runs++;
        totals.steps += m.steps.length;
        // Round 2, item 3: the run ended with the final beside a double walkover (its bye, or a void), or took one back.
        const fin = row(d, b.fin);
        if ([b.sf1, b.sf2].some((id) => (row(d, id).outcome as { kind?: string } | null)?.kind === "double_walkover")) {
          if (fin.status === "forfeited" && (fin.outcome as { reason?: string } | null)?.reason === "bye") totals.byeBesideDw++;
          if (fin.status === "abandoned" && fin.outcome === null) totals.voidBesideDw++;
        }
        for (const id of [b.sf1, b.sf2]) {
          const led = d.ledgers.get(id) ?? [];
          const voided = new Set(led.flatMap((e) => (e.voids === undefined ? [] : [e.voids])));
          if (led.some((e) => e.type === "core.forfeit" && (e.payload as { by: string }).by === "both" && voided.has(e.id))) totals.dwTakenBack++;
        }
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

  // The registry, 200 runs a sport (both sweeps ~2.4s). Since a settle lifts D4 (loop D review M-6) an unsettled
  // abandon is only Settle → Void → Forfeit on one fixture, and three sports at 100 runs never drew it.
  it("over one knockout shape and every sport: invariants hold, Forfeit is accepted (a double walkover among them) and refused by each of the table's codes, and the sweep replays from its seed", async () => {
    const totals = await sweep(SEED);
    expect(totals.runs).toBe(SPORTS.length * RUNS);
    expect(totals.steps).toBeGreaterThan(0);
    expect(totals.accepted, "no Forfeit was ever accepted").toBeGreaterThan(0);
    expect(totals.doubles, "no double walkover was ever posted").toBeGreaterThan(0);
    expect(totals.dw, "no double walkover was ever judged").toBeGreaterThan(0);
    expect(totals.one, "no active forfeit was ever judged").toBeGreaterThan(0);
    expect(totals.byeBesideDw, "no final was ever walked over beside a double walkover").toBeGreaterThan(0);
    // A void beside a double walkover needs two on one run (both semis, or one beside a withdrawal): this seed's draw
    // ends there in no run (measured 0 of 2,200), so voidBesideDw is carried in the replay's equality below, not owed;
    // the unit witnesses above drive both shapes.
    expect(totals.dwTakenBack, "no double walkover was ever taken back").toBeGreaterThan(0);
    for (const c of CODES) expect(totals.codes[c], `no Forfeit was ever refused ${c}`).toBeGreaterThan(0);
    expect(await sweep(SEED)).toEqual(totals);
  });
});
