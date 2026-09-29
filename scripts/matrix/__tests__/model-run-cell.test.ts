// The model runner's per-cell half (W1b Task 14): runCell runs fc.check over
// fc.commands for one cell, each property run on a fresh division, and reduces
// the runs into one CellReport. Driven DB-free through ModelFakeDriver (Task
// 13), whose outcomes are the engine's fold and whose schedule is the engine's
// round robin.
//
// State transitions under test (TEST-STRATEGY rule 1): a cell with no failure;
// a cell whose first failure is shrunk (fences off, #879); the same failure
// replayed from its seed, path and replayPath; a failure matched by an OPEN
// regression, then by a FIXED one; an unexpected refusal (the check that
// outranks every other); other checks met while shrinking; the time box
// before, during and after a failure; a KNOWN first failure meeting a NEW one
// while shrinking; a NEW target displaced by a KNOWN unexpected refusal
// (fix round 2, RR-1), and a check met twice while shrinking; a request that
// timed out, before and during a shrink (RR-2); fast-check giving up on skips;
// vacuity per stage kind (vacuityOf). Empty cases FIRST: one run of one command; a cell whose every
// step was refused; a time box already spent; every count covered.
//
// Single-sport by design (a file-level reason: the scanner's `// single-sport:`
// grammar heads a block, and a header heads none): the model fake is a round-robin (league) product, and #879 —
// the one fault these tests drive — is a league fault; the correct-product
// test sweeps the model's own sports (SLICE_SPORTS) instead.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RefusedCall, RequestTimedOut, productMessageOf, type FixtureStateOut, type PostedEvent } from "../lib/driver/types.ts";
import { COMMAND_KINDS, ModelViolation, newModelState, type ModelState } from "../lib/model/commands.ts";
import { FENCES } from "../lib/model/fences.ts";
import { MODEL_ERROR, regressionFor, runCell, shrinkTarget, vacuityOf, type FailureKey, type RunCellInput } from "../lib/model/run-cell.ts";
import { MATCH_REQUIRED_CHECKS } from "../lib/scenario-catalogue.ts";
import { ORIENTATION_CHECK, ORIENTATION_STAGE_KINDS, REFUSAL_NAMED, ROSTER_LOCK_FINDING, UNEXPECTED_REFUSAL, VACUITY_CHECK, informativeSteps, type CommandCounts, type UnknownLedger } from "../lib/model/state.ts";
import { STEP_INVARIANTS } from "../lib/invariants.ts";
import { SLICE_SPORTS } from "../lib/slice.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { ModelFakeDriver, type ModelFakeOpts } from "./model-fake-driver.ts";

const CELL = "league|generic";
const I7 = "I7-rr-no-pair-over-legs";
const I8 = "I8-generate-named";
const FENCE_879 = "late-entry-then-generate";

type Over = Partial<RunCellInput> & { fault879?: boolean; opts?: ModelFakeOpts; sport?: string; variant?: string; driver?: () => ModelFakeDriver };
const input = (over: Over = {}): RunCellInput => {
  const { fault879, opts, sport = "generic", variant = "score", driver, ...rest } = over;
  return {
    cell: `league|${sport}`, row: "league", sport, variant,
    newDriverState: async (n) => {
      const real = driver?.() ?? new ModelFakeDriver({ ...opts, fault879: fault879 === true });
      return { real, model: await newModelState({ driver: real, row: "league", sport, variant, entrants: 4, tag: `t${n}` }) };
    },
    runs: 40, maxCommands: 12, seed: 42, fences: true, timeLimitMs: 60_000, regressions: [],
    ...rest,
  };
};

/** #879's shape (pre-Start): an entrant added after a Generate, then a Generate that ran last. */
function expectLateEntryShape(commands: readonly string[]): void {
  const kinds = commands.map((c) => c.split("(")[0]);
  expect(kinds.length, "no command list").toBeGreaterThan(0);
  expect(kinds.at(-1), kinds.join(",")).toBe("Generate");
  const added = kinds.indexOf("AddEntrant");
  expect(added, kinds.join(",")).toBeGreaterThan(kinds.indexOf("Generate"));
  expect(kinds.indexOf("Generate"), kinds.join(",")).toBeGreaterThan(-1);
}

/** Every post refused by NAME — a product that will not take a result. */
class RefusingPosts extends ModelFakeDriver {
  override postStream(id: string, _events: readonly StreamEvent[], _prefix = ""): Promise<PostedEvent[]> {
    return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses every result"));
  }
}
/** Once built, every organiser command is refused by NAME: nothing is ever accepted. */
class RefusingEverything extends ModelFakeDriver {
  built = false;
  #no(path: string): Promise<never> { return Promise.reject(new RefusedCall("POST", path, 409, "TEST_REFUSED", "test: refuses everything")); }
  override start() { return this.built ? this.#no("/start") : super.start(); }
  override generate() { return this.built ? this.#no("/generate") : super.generate(); }
  override addEntrants(d: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]) { return this.built ? this.#no("/entrants") : super.addEntrants(d, es); }
}

/** Fix round 2, RR-1 (the reviewer's product): per division, every result is
 *  refused by NAME until an entrant is added after the build; from then on
 *  results are taken and their outcome lied about (fold parity). */
class GatedLiar extends ModelFakeDriver {
  #adds = 0;
  constructor() { super({ lieOutcome: true }); }
  override createDivision(...a: Parameters<ModelFakeDriver["createDivision"]>) { this.#adds = 0; return super.createDivision(...a); }
  override addEntrants(...a: Parameters<ModelFakeDriver["addEntrants"]>) { return super.addEntrants(...a).then((r) => { this.#adds++; return r; }); }
  override postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    if (this.#adds < 2) return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses results until a late entrant"));
    return super.postStream(id, events, prefix);
  }
}

/** A product whose failures are scripted by their order: the nth run to reach
 *  a post fails on `checkFor(n)`, and snapshots the commands it had run by then. */
function scripted(checkFor: (nth: number) => string): { newDriverState: RunCellInput["newDriverState"]; seenBy: string[][] } {
  const seenBy: string[][] = [];
  return {
    seenBy,
    newDriverState: async (n) => {
      let model: ModelState | null = null;
      const real = new (class extends ModelFakeDriver {
        override postStream(): Promise<PostedEvent[]> {
          seenBy.push([...(model?.history ?? [])]);
          return Promise.reject(new ModelViolation(checkFor(seenBy.length), [`scripted failure ${seenBy.length}`]));
        }
      })();
      model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
      return { real, model };
    },
  };
}

const FOLD = "model-fold-parity";
/** A NEW failure on `check`, and one an open case `id` names (T15 fix round 2: the lock's identity). */
const N = (check: string): FailureKey => ({ check, known: null });
const K = (check: string, id = "MB-009"): FailureKey => ({ check, known: id });
/** An open committed regression on CELL for `check` (R29); `match` as the schema requires it. */
const openReg = (id: string, check: string, match: string | null = null) => ({ id, title: "t", issue: null, cell: CELL, variant: "score", check, seed: 1, path: "0", replayPath: null, fence: null, match, status: "open" as const, found: "2026-09-29", runId: "t" });
/** The words both fake post refusals give (RefusingPosts, GatedLiar) — the
 *  product's message, after RefusedCall's `METHOD path → HTTP status CODE: `
 *  request line, which a match never reads (final batch FB-3) — what those
 *  tests' open cases match. The backstop's own sentence is the harness's, never
 *  matched (T15 fix round 3). */
const POST_REFUSED = "test: refuses";
const BACKSTOP = "unexpected refusal(s) counted over the cell";

describe("shrinkTarget — which failure a cell's shrink is locked to", () => {
  it("empty case first: before any failure, the first failure thrown is the target, known or not", () => {
    expect(shrinkTarget(null, N(I7))).toEqual(N(I7));
    expect(shrinkTarget(null, N(UNEXPECTED_REFUSAL))).toEqual(N(UNEXPECTED_REFUSAL));
    expect(shrinkTarget(null, K(FOLD))).toEqual(K(FOLD));
  });
  it("the target itself stays the failure; a failure of the same rank is masked (null)", () => {
    expect(shrinkTarget(N(I7), N(I7))).toEqual(N(I7));
    // Both NEW: the first found is kept.
    expect(shrinkTarget(N(I7), N(FOLD))).toBeNull();
    // Both KNOWN: likewise.
    expect(shrinkTarget(K(I7), K(FOLD))).toBeNull();
    expect(shrinkTarget(N(UNEXPECTED_REFUSAL), N(I7))).toBeNull();
  });
  it("an unexpected refusal outranks every other target and is never masked (T14 amendment: a NEW failure, not merely counted)", () => {
    expect(shrinkTarget(N(I7), N(UNEXPECTED_REFUSAL))).toEqual(N(UNEXPECTED_REFUSAL));
    expect(shrinkTarget(N(MODEL_ERROR), N(UNEXPECTED_REFUSAL))).toEqual(N(UNEXPECTED_REFUSAL));
    expect(shrinkTarget(N(UNEXPECTED_REFUSAL), N(UNEXPECTED_REFUSAL))).toEqual(N(UNEXPECTED_REFUSAL));
    // Even a KNOWN unexpected refusal outranks a NEW check (ruling: unexpected > new > known)…
    expect(shrinkTarget(N(I7), K(UNEXPECTED_REFUSAL))).toEqual(K(UNEXPECTED_REFUSAL));
    expect(shrinkTarget(K(UNEXPECTED_REFUSAL), N(I7))).toBeNull();
  });
  it("fix round 1, I-1: a NEW check outranks a KNOWN target — a known failure never hides a new one; a known check never displaces a new target", () => {
    expect(shrinkTarget(K(FOLD), N(I7))).toEqual(N(I7));
    expect(shrinkTarget(N(I7), K(FOLD))).toBeNull();
  });
  it("T15 fix round 2: on ONE check, a NEW failure outranks a KNOWN one — the identity is the check AND the case its match names", () => {
    // A known unexpected refusal never hides a NEW one on the same check…
    expect(shrinkTarget(K(UNEXPECTED_REFUSAL, "MB-002"), N(UNEXPECTED_REFUSAL))).toEqual(N(UNEXPECTED_REFUSAL));
    expect(shrinkTarget(N(UNEXPECTED_REFUSAL), K(UNEXPECTED_REFUSAL, "MB-002"))).toBeNull();
    // …nor on any other check…
    expect(shrinkTarget(K(I7, "MB-001"), N(I7))).toEqual(N(I7));
    expect(shrinkTarget(N(I7), K(I7, "MB-001"))).toBeNull();
    // …and two cases on one check are two failures of one rank: the first kept.
    expect(shrinkTarget(K(UNEXPECTED_REFUSAL, "MB-002"), K(UNEXPECTED_REFUSAL, "MB-004"))).toBeNull();
    expect(shrinkTarget(K(UNEXPECTED_REFUSAL, "MB-002"), K(UNEXPECTED_REFUSAL, "MB-002"))).toEqual(K(UNEXPECTED_REFUSAL, "MB-002"));
  });
});

describe("regressionFor — cell, check AND match, the match read from the product's answer only (T15 fix rounds 2 and 3)", () => {
  const TBD = "fixture has an unassigned entrant";
  /** The model's own line (the harness's text) and the product's answer (`said`). */
  const line = "Withdraw(0,0): POST /api/v1/entrants/e1/withdraw → 422 WRONG_PHASE — the model holds Withdraw legal here";
  const said = `POST /api/v1/entrants/e1/withdraw → HTTP 422 WRONG_PHASE: ${TBD} (bye/TBD)`;
  it("empty case first: no committed case knows nothing, with or without a product answer", () => {
    expect(regressionFor([], CELL, UNEXPECTED_REFUSAL, said)).toBeNull();
    expect(regressionFor([], CELL, I7, null)).toBeNull();
  });
  it("the premise: the checks whose cases must carry a match are the model's generic ones, the named-refusal check among them (fix round 3, I-2)", () => {
    expect([...MATCH_REQUIRED_CHECKS].sort()).toEqual([MODEL_ERROR, REFUSAL_NAMED, UNEXPECTED_REFUSAL].sort());
  });
  it("known only when cell, check and match all agree; a null match names any failure on a check that owes none", () => {
    const reg = openReg("MB-002", UNEXPECTED_REFUSAL, TBD);
    expect(regressionFor([reg], CELL, UNEXPECTED_REFUSAL, said)).toBe("MB-002");
    // A different refusal on the same cell and check: NEW.
    expect(regressionFor([reg], CELL, UNEXPECTED_REFUSAL, "POST … → HTTP 422 WRONG_PHASE: forfeit not allowed in phase pre")).toBeNull();
    // No product answer, no match.
    expect(regressionFor([reg], CELL, UNEXPECTED_REFUSAL, null)).toBeNull();
    expect(regressionFor([reg], "league|badminton", UNEXPECTED_REFUSAL, said)).toBeNull();
    expect(regressionFor([reg], CELL, I7, said)).toBeNull();
    expect(regressionFor([{ ...reg, status: "fixed" as const }], CELL, UNEXPECTED_REFUSAL, said)).toBeNull();
    // Two cases on one check: the one whose match is in the product's answer, either order.
    const other = openReg("MB-004", UNEXPECTED_REFUSAL, "would strand home_slot_label");
    expect(regressionFor([other, reg], CELL, UNEXPECTED_REFUSAL, said)).toBe("MB-002");
    expect(regressionFor([reg, other], CELL, UNEXPECTED_REFUSAL, said)).toBe("MB-002");
    expect(regressionFor([openReg("MB-001", I7)], CELL, I7, "anything at all")).toBe("MB-001");
    expect(regressionFor([openReg("MB-001", I7)], CELL, I7, null)).toBe("MB-001");
  });
  it("fix round 3, M-3: text only the model's own line carries never makes a failure known — the match is read from the product's answer alone", () => {
    let checked = 0;
    for (const harness of ["the model holds Withdraw legal here", "Withdraw(0,0)", "→ 422 WRONG_PHASE"]) {
      expect(line, "the premise: the harness's line carries it").toContain(harness);
      expect(said, "the premise: the product's answer does not").not.toContain(harness);
      expect(regressionFor([openReg("MB-H", UNEXPECTED_REFUSAL, harness)], CELL, UNEXPECTED_REFUSAL, said), harness).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("final batch FB-3 (supersedes fix round 3's M-2 shadow): a check that never carries the product's answer is named by a null-match case alone — a string match there (the loader refuses it) names nothing, whatever answer is passed", () => {
    // I7 is judged by the harness alone: production never gives it a `said`.
    expect((MATCH_REQUIRED_CHECKS as readonly string[]).includes(I7)).toBe(false);
    const any = openReg("MB-N", I7);
    const specific = openReg("MB-S", I7, "home_slot_label");
    const answer = new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, "INTERNAL", "would strand home_slot_label").message;
    let checked = 0;
    for (const order of [[any, specific], [specific, any]]) {
      expect(regressionFor(order, CELL, I7, answer), "an answer I7 never carries: still the null case").toBe("MB-N");
      expect(regressionFor(order, CELL, I7, null), "no answer: the null case").toBe("MB-N");
      checked++;
    }
    expect(regressionFor([specific], CELL, I7, answer), "a string match alone names nothing on I7").toBeNull();
    expect(checked).toBe(2);
  });
  it("final batch FB-3: the match is read from the PRODUCT's words only — the request line RefusedCall writes around them names nothing", () => {
    const preamble = ["POST /api/v1/entrants/e1/withdraw", "→ HTTP 422 WRONG_PHASE", "HTTP 422", "WRONG_PHASE: fixture"];
    let checked = 0;
    for (const text of preamble) {
      expect(said, `the premise: said carries ${text}`).toContain(text);
      expect(regressionFor([openReg("MB-P", UNEXPECTED_REFUSAL, text)], CELL, UNEXPECTED_REFUSAL, said), text).toBeNull();
      checked++;
    }
    expect(checked).toBe(preamble.length);
    // The positive pair: the product's own words, whole or in part.
    expect(regressionFor([openReg("MB-P", UNEXPECTED_REFUSAL, `${TBD} (bye/TBD)`)], CELL, UNEXPECTED_REFUSAL, said)).toBe("MB-P");
    expect(regressionFor([openReg("MB-P", UNEXPECTED_REFUSAL, "unassigned entrant")], CELL, UNEXPECTED_REFUSAL, said)).toBe("MB-P");
    // A refusal the product gave no words for names nothing — not even by RefusedCall's placeholder.
    const silent = new RefusedCall("POST", "/api/v1/x", 500, null, null).message;
    expect(silent).toContain("(no message)");
    expect(regressionFor([openReg("MB-P", REFUSAL_NAMED, "(no message)")], CELL, REFUSAL_NAMED, silent)).toBeNull();
    // An answer not in RefusedCall's shape carries no product words at all.
    expect(regressionFor([openReg("MB-P", REFUSAL_NAMED, "unassigned entrant")], CELL, REFUSAL_NAMED, `harness says: ${TBD}`)).toBeNull();
  });
  it("final batch FB-3: productMessageOf reads back exactly the words RefusedCall was given — every code shape, a placeholder, words that look like a request line", () => {
    const cases: [string, string, number, string | null, string | null][] = [
      ["GET", "/api/v1/divisions/d1/fixtures", 503, "UNAVAILABLE", "the list is resting"],
      ["POST", "/api/v1/stages/s1/generate", 500, null, "generateStageFixtures: x: y → HTTP 500 z"],
      ["PATCH", "/api/v1/x", 422, "WRONG_PHASE", "a: b"],
      ["POST", "/api/v1/x", 409, "TEST_POST_REFUSED", null],
    ];
    let checked = 0;
    for (const [m, path, st, code, msg] of cases) {
      expect(productMessageOf(new RefusedCall(m, path, st, code, msg).message), `${m} ${path} ${st} ${String(code)}`).toBe(msg);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(productMessageOf("not a refusal line")).toBeNull();
  });
  it("fix round 3, MR: a null-match case on a check that owes a match (the schema bypassed) names nothing — a missing key and an explicit null, on every such check", () => {
    let checked = 0;
    for (const check of MATCH_REQUIRED_CHECKS) {
      const nulled = { ...openReg("MB-X", check, TBD), match: null };
      const { match: _m, ...bare } = openReg("MB-Y", check, TBD);
      for (const answer of [said, "undefined", "null", null]) {
        expect(regressionFor([nulled], CELL, check, answer), `${check} null, ${String(answer)}`).toBeNull();
        expect(regressionFor([bare as never], CELL, check, answer), `${check} missing, ${String(answer)}`).toBeNull();
      }
      // …and it never shadows the case that does match.
      expect(regressionFor([nulled, openReg("MB-Z", check, TBD)], CELL, check, said), check).toBe("MB-Z");
      checked++;
    }
    expect(checked).toBe(MATCH_REQUIRED_CHECKS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("runCell", () => {
  it("empty case first: one run of one command is VACUOUS — reported, never a pass", async () => {
    const r = await runCell(input({ runs: 1, maxCommands: 1 }));
    expect(r.failure).toBeNull();
    expect(r.vacuous.length).toBeGreaterThan(0);
    expect(r.executions).toBe(1);
  });

  it("empty case: a cell whose every step was refused told the model nothing — vacuous on model-informative-steps", async () => {
    const drivers: RefusingEverything[] = [];
    const r = await runCell(input({
      runs: 10,
      newDriverState: async (n) => {
        const real = new RefusingEverything();
        drivers.push(real);
        const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        real.built = true;
        return { real, model };
      },
    }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    // The steps did run, and every one was refused: vacuity is about what they told the model.
    expect(r.counts.Start.ran + r.counts.Generate.ran + r.counts.AddEntrant.ran).toBeGreaterThan(0);
    expect(r.counts.Start.refused + r.counts.Generate.refused + r.counts.AddEntrant.refused).toBe(r.counts.Start.ran + r.counts.Generate.ran + r.counts.AddEntrant.ran);
    expect(r.informativeSteps).toBe(0);
    expect(r.vacuous).toContain(`no informative step (${VACUITY_CHECK})`);
    // Runs happened, yet nothing was accepted and nothing was compared: each rule says so itself.
    expect(r.counts.Score.accepted).toBe(0);
    expect(r.vacuous).toContain("no Score was accepted");
    expect(r.foldParity).toBe(0);
    expect(r.vacuous).toContain("fold parity compared zero fixtures");
    expect(drivers.length).toBe(r.executions);
  });

  it.each(SLICE_SPORTS)("a correct product (%s): no failure; every kind ran; Score accepted; each applicable step invariant and fold parity counted > 0; the roster lock met as the known finding", async (sport) => {
    const variant = sport === "generic" ? "score" : "bwf";
    const r = await runCell(input({ sport, variant }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    expect(r.vacuous).toEqual([]);
    for (const k of COMMAND_KINDS) expect(r.counts[k].ran, k).toBeGreaterThan(0);
    expect(r.counts.Score.accepted).toBeGreaterThan(0);
    // Applicability from the invariant registry, never a typed list: I6 is swiss-only.
    const applicable = STEP_INVARIANTS.filter((s) => s.stageKinds === "any" || s.stageKinds.includes("league"));
    expect(applicable.map((s) => s.id)).toEqual(expect.arrayContaining([I7, I8]));
    for (const s of applicable) expect(r.stepChecks[s.id], s.id).toBeGreaterThan(0);
    expect(r.foldParity).toBeGreaterThan(0);
    expect(r.informativeSteps).toBeGreaterThan(0);
    // After Start the roster is locked: offered, refused as EXPECTED, recorded under CD-T13b.
    expect(r.counts.AddEntrant.expected).toBeGreaterThan(0);
    expect(r.findings[ROSTER_LOCK_FINDING]?.count).toBe(r.counts.AddEntrant.expected);
    expect(r.findings[ROSTER_LOCK_FINDING]?.evidence.length).toBe(3);
    // A correct fake answers every post first time: no ledger ever went unknown.
    expect(r.unknowns).toEqual({ retried: 0, "tip-moved": 0, "next-match-unverified": 0 });
    expect(r.numRuns).toBe(40);
    expect(r.seed).toBe(42);
    expect(r.interrupted).toBe(false);
    expect(r.masked).toEqual({});
  });

  it("aggregates per cell, across every property run: all five counts, step checks, fences, parity, unknowns by cause, findings (3 evidence lines kept), informative steps", async () => {
    const captured: ModelState[] = [];
    const seeded: readonly UnknownLedger["cause"][] = ["retried", "tip-moved", "next-match-unverified"];
    const r = await runCell(input({
      runs: 12,
      newDriverState: async (n) => {
        const real = new ModelFakeDriver();
        const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        // Every field seeded non-zero in every run, so a field the reducer drops shows.
        for (const k of COMMAND_KINDS) model.counts[k] = { ran: 1, accepted: 2, refused: 3, expected: 4, unexpected: 5 };
        for (const cause of seeded) model.unknowns.push({ cause, fixture: `x${n}`, detail: "seeded" });
        model.findings.set("SEEDED-1", { count: 2, evidence: [`a${n}`, `b${n}`] });
        model.stepChecks.set("SEEDED-CHECK", 7);
        model.fenced.set("SEEDED-FENCE", 1);
        model.foldParity = 3;
        model.steps.push({ cmd: "Seeded(0,0)", verdict: "accepted" }, { cmd: "Seeded(1,0)", verdict: "refused" });
        captured.push(model);
        return { real, model };
      },
    }));
    expect(captured.length).toBeGreaterThan(1);
    expect(r.executions).toBe(captured.length);
    const sum = (f: (m: ModelState) => number) => captured.reduce((s, m) => s + f(m), 0);
    const fields: readonly (keyof CommandCounts)[] = ["ran", "accepted", "refused", "expected", "unexpected"];
    for (const k of COMMAND_KINDS) for (const f of fields) expect(r.counts[k][f], `${k}.${f}`).toBe(sum((m) => m.counts[k][f]));
    for (const id of new Set(captured.flatMap((m) => [...m.stepChecks.keys()]))) expect(r.stepChecks[id], id).toBe(sum((m) => m.stepChecks.get(id) ?? 0));
    for (const id of new Set(captured.flatMap((m) => [...m.fenced.keys()]))) expect(r.fenced[id], id).toBe(sum((m) => m.fenced.get(id) ?? 0));
    expect(r.foldParity).toBe(sum((m) => m.foldParity));
    for (const cause of seeded) expect(r.unknowns[cause], cause).toBe(sum((m) => m.unknowns.filter((u) => u.cause === cause).length));
    expect(r.findings["SEEDED-1"]).toEqual({ count: sum((m) => m.findings.get("SEEDED-1")?.count ?? 0), evidence: ["a1", "b1", "a2"] });
    expect(r.informativeSteps).toBe(sum((m) => informativeSteps(m).checked));
    expect(r.stepChecks["SEEDED-CHECK"]).toBe(7 * captured.length);
  });

  it("Review Focus 3 — fenced: #879 present, fences ON → no failure, and the fence fired (the walk kept exploring past it)", async () => {
    const r = await runCell(input({ fault879: true }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    expect(FENCES.map((f) => f.id)).toContain(FENCE_879);
    expect(r.fenced[FENCE_879]).toBeGreaterThan(0);
    // Exploring past the fence: every other command still ran, and nothing is vacuous.
    for (const k of COMMAND_KINDS) expect(r.counts[k].ran, k).toBeGreaterThan(0);
    expect(r.vacuous).toEqual([]);
    expect(r.fences).toBe(true);
  });

  it("fences OFF → #879 found on I7; the shrunk path is Generate, AddEntrant, Generate before any Start; seed and path logged", async () => {
    const r = await runCell(input({ fault879: true, fences: false }));
    expect(r.failure?.check).toBe(I7);
    const f = r.failure;
    if (f === null) throw new Error("unreachable: asserted above");
    const cmds = f.commands.map((c) => c.split("(")[0]);
    // #879 is pre-Start (T13 fix round 1): after Start the roster lock refuses AddEntrant.
    expect(cmds.indexOf("Start")).toBe(-1);
    expect(cmds.indexOf("Generate")).toBeGreaterThan(-1);
    expect(cmds.indexOf("AddEntrant")).toBeGreaterThan(cmds.indexOf("Generate"));
    expect(cmds.lastIndexOf("Generate")).toBeGreaterThan(cmds.indexOf("AddEntrant"));
    // Only commands that RAN are listed (R-PF9): the step that threw is the last one.
    expect(cmds.at(-1)).toBe("Generate");
    expect(f.path.length).toBeGreaterThan(0);
    expect(f.replayPath).toMatch(/\S/);
    expect(f.known).toBeNull();
    expect(f.seed).toBe(42);
    expect(f.evidence.join(" ")).toMatch(/meets 2×/);
    expect(r.fences).toBe(false);
    // A failing cell is judged by its failure, not by coverage.
    expect(r.vacuous).toEqual([]);
  });

  it("replay: the reported seed + path + replayPath reproduce the same failure and the same shrunk commands (R29, R-PF9)", async () => {
    const first = (await runCell(input({ fault879: true, fences: false }))).failure;
    if (first === null) throw new Error("the fences-off cell found nothing to replay");
    const again = await runCell(input({ fault879: true, fences: false, seed: first.seed, path: first.path, replayPath: first.replayPath ?? undefined, runs: 1 }));
    expect(again.failure?.check).toBe(first.check);
    expect(again.failure?.commands).toEqual(first.commands);
    expect(again.failure?.replayPath).toBe(first.replayPath);
  });

  it("a failure matching an OPEN committed regression on the same cell and check is known, by id; a FIXED one, or another cell or check, is not", async () => {
    const reg = { id: "MB-001", title: "#879", issue: "#879", cell: CELL, variant: "score", check: I7, seed: 1, path: "0", replayPath: null, fence: FENCE_879, match: null, status: "open" as const, found: "2026-09-28", runId: "t" };
    const r = await runCell(input({ fault879: true, fences: false, regressions: [reg] }));
    expect(r.failure?.known).toBe("MB-001");
    const fixed = await runCell(input({ fault879: true, fences: false, regressions: [{ ...reg, status: "fixed" }] }));
    expect(fixed.failure?.known).toBeNull();
    const elsewhere = await runCell(input({ fault879: true, fences: false, regressions: [{ ...reg, cell: "league|badminton" }, { ...reg, id: "MB-002", check: I8 }] }));
    expect(elsewhere.failure?.known).toBeNull();
  });

  it("an unexpected refusal (a result the model holds legal, refused by name) is a NEW failure on model-unexpected-refusal — known only through an open regression on that check", async () => {
    const r = await runCell(input({ driver: () => new RefusingPosts() }));
    expect(r.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(r.failure?.known).toBeNull();
    const unexpected = COMMAND_KINDS.reduce((s, k) => s + r.counts[k].unexpected, 0);
    expect(unexpected).toBeGreaterThan(0);
    const cmds = (r.failure?.commands ?? []).map((c) => c.split("(")[0]);
    expect(["Score", "Walkover"]).toContain(cmds.at(-1));
    expect(cmds).toContain("Start");
    // T15 fix round 2: known only when the case's match is in the evidence. The
    // product's own text ("refuses every result") is only in its message, so
    // this also proves the model carries that message into the evidence.
    const matching = openReg("MB-003", UNEXPECTED_REFUSAL, "refuses every result");
    const known = (await runCell(input({ driver: () => new RefusingPosts(), regressions: [matching] }))).failure;
    expect(known?.evidence.join("\n")).toContain("HTTP 409 TEST_POST_REFUSED: test: refuses every result");
    // Fix round 3: the product's answer is the failure's `said`, and its evidence's last line.
    expect(known?.said).toContain("HTTP 409 TEST_POST_REFUSED: test: refuses every result");
    expect(known?.evidence.at(-1)).toBe(known?.said);
    expect(known?.known).toBe("MB-003");
  });

  it("T15 fix round 2: a DIFFERENT refusal on the same cell and check stays NEW; with both cases committed, the matching one is known", async () => {
    // MB-002's text: the knockout TBD withdraw. RefusingPosts refuses a result instead.
    const tbd = openReg("MB-002", UNEXPECTED_REFUSAL, "fixture has an unassigned entrant");
    const other = await runCell(input({ driver: () => new RefusingPosts(), regressions: [tbd] }));
    expect(other.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(other.failure?.known).toBeNull();
    const both = await runCell(input({ driver: () => new RefusingPosts(), regressions: [tbd, openReg("MB-003", UNEXPECTED_REFUSAL, "refuses every result")] }));
    expect(both.failure?.known).toBe("MB-003");
  });

  it("fix round 3, M-3: a case whose match is only in the model's OWN line (never in the product's answer) leaves the failure NEW; the product's text makes it known", async () => {
    let checked = 0;
    for (const harness of ["the model holds", "→ 409 TEST_POST_REFUSED"]) {
      const r = await runCell(input({ driver: () => new RefusingPosts(), regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, harness)] }));
      expect(r.failure?.check, harness).toBe(UNEXPECTED_REFUSAL);
      // The premise, on this very failure: the harness's text carries the string, the product's answer does not.
      expect(r.failure?.evidence.slice(0, -1).join("\n"), harness).toContain(harness);
      expect(r.failure?.said, harness).not.toBeNull();
      expect(r.failure?.said ?? "", harness).not.toContain(harness);
      expect(r.failure?.known, harness).toBeNull();
      checked++;
    }
    // Final batch FB-3: nor does the request line RefusedCall writes INTO the
    // answer — in `said`, but not the product's words.
    for (const preamble of ["HTTP 409 TEST_POST_REFUSED", "POST /api/v1/fixtures/"]) {
      const r = await runCell(input({ driver: () => new RefusingPosts(), regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, preamble)] }));
      expect(r.failure?.said ?? "", `the premise: said carries ${preamble}`).toContain(preamble);
      expect(r.failure?.known, preamble).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    // The positive control: the same run, matched on the product's own words.
    const own = await runCell(input({ driver: () => new RefusingPosts(), regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, "refuses every result")] }));
    expect(own.failure?.known).toBe("MB-003");
  });

  it("final batch FB-4 (MH): a failure the harness judged alone carries no product answer — its said is null, and a case matching its own evidence never names it", async () => {
    const r = await runCell(input({ fences: false, fault879: true }));
    expect(r.failure?.check).toBe(I7);
    expect(r.failure?.said, "an invariant is the harness's verdict: no product words").toBeNull();
    const words = (r.failure?.evidence[0] ?? "").slice(0, 24);
    expect(words.length, "the premise: the invariant wrote evidence").toBeGreaterThan(12);
    const named = await runCell(input({ fences: false, fault879: true, regressions: [openReg("MB-H", I7, words)] }));
    expect(named.failure?.evidence.join("\n"), "the premise: the same evidence carries the case's text").toContain(words);
    expect(named.failure?.said).toBeNull();
    expect(named.failure?.known, "a string match never names a said-less failure").toBeNull();
    // The positive pair: I7's own null-match case names it.
    expect((await runCell(input({ fences: false, fault879: true, regressions: [openReg("MB-H", I7)] }))).failure?.known).toBe("MB-H");
  });
  it("final batch FB-4 (MRC): a refusal no command caught (a model-error) carries the product's answer, and a model-error case names it by the product's words", async () => {
    const RESTING = "the fixture's state is resting";
    /** A product that lies about an outcome, then refuses the tip read the
     *  fold-parity check makes before calling it a lie: checkStep runs outside
     *  every command's catch, so the refusal escapes. */
    class ListingRefused extends ModelFakeDriver {
      constructor() { super({ lieOutcome: true }); }
      override fixtureState(id: string): Promise<FixtureStateOut> { return Promise.reject(new RefusedCall("GET", `/api/v1/fixtures/${id}/state`, 503, "UNAVAILABLE", RESTING)); }
    }
    const bare = await runCell(input({ driver: () => new ListingRefused() }));
    expect(bare.failure?.check).toBe(MODEL_ERROR);
    expect(bare.failure?.said, "the escaped refusal's own words").toContain(`: ${RESTING}`);
    expect(bare.failure?.known).toBeNull();
    const named = await runCell(input({ driver: () => new ListingRefused(), regressions: [openReg("MB-E", MODEL_ERROR, RESTING)] }));
    expect(named.failure?.known).toBe("MB-E");
    // …by the product's words only: the request line around them names nothing.
    expect((await runCell(input({ driver: () => new ListingRefused(), regressions: [openReg("MB-E", MODEL_ERROR, "HTTP 503 UNAVAILABLE")] }))).failure?.known).toBeNull();
  });
  it("backstop: unexpected refusals counted while the reported failure is another check (or none) still report model-unexpected-refusal, NEW, carrying what it displaced", async () => {
    const seeded = (fault879: boolean): RunCellInput["newDriverState"] => async (n) => {
      const real = new ModelFakeDriver({ fault879 });
      const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
      model.counts.Void.unexpected = 1;
      return { real, model };
    };
    const none = await runCell(input({ newDriverState: seeded(false) }));
    expect(none.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(none.failure?.known).toBeNull();
    expect(none.failure?.evidence[0]).toMatch(/unexpected refusal/);
    const displaced = await runCell(input({ fences: false, newDriverState: seeded(true) }));
    expect(displaced.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(displaced.failure?.evidence.join("\n")).toContain(I7);
    // The displaced NEW failure is kept with its commands even when the refusal is NEW too (RR-1).
    expect(Object.keys(displaced.maskedNew)).toEqual([I7]);
    // A regression on the displaced check does not make the unexpected refusal known.
    const reg = { id: "MB-001", title: "#879", issue: "#879", cell: CELL, variant: "score", check: I7, seed: 1, path: "0", replayPath: null, fence: FENCE_879, match: null, status: "open" as const, found: "2026-09-28", runId: "t" };
    expect((await runCell(input({ fences: false, newDriverState: seeded(true), regressions: [reg] }))).failure?.known).toBeNull();
    // Fix round 3 (M-3/M-5): the backstop carries no product answer — its
    // evidence is the harness's own sentence and what it displaced — so no case
    // names it, not even one matching that sentence or the displaced text; the
    // NEW failure it displaced is still kept with its commands (#879's shape).
    expect(displaced.failure?.said).toBeNull();
    let checked = 0;
    for (const text of [BACKSTOP, I7, "displaced"]) {
      expect(displaced.failure?.evidence.join("\n"), `the premise: the backstop's evidence carries ${text}`).toContain(text);
      const matched = await runCell(input({ fences: false, newDriverState: seeded(true), regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, text)] }));
      expect(matched.failure?.check, text).toBe(UNEXPECTED_REFUSAL);
      expect(matched.failure?.known, text).toBeNull();
      expect(Object.keys(matched.maskedNew), text).toEqual([I7]);
      expectLateEntryShape(matched.maskedNew[I7] ?? []);
      checked++;
    }
    expect(checked).toBe(3);
    // A KNOWN displaced failure is not kept; the backstop itself stays NEW.
    const knownDisplaced = await runCell(input({ fences: false, newDriverState: seeded(true), regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, BACKSTOP), reg] }));
    expect(knownDisplaced.maskedNew).toEqual({});
    expect(knownDisplaced.failure?.known).toBeNull();
  });

  it("the shrink stays on its first failure's check: a candidate failing another check is passed over, counted in masked, never reported", async () => {
    // Two faults at once: #879 (I7) and an outcome nobody posted (fold parity).
    // Seed 62 was found by probing seeds 1-150: its first failure is fold
    // parity, and one shrink candidate on the way fails I7 instead — the only
    // seed of the 150 where that happens. Without the lock that candidate
    // would be taken and the cell would report I7 (killed by mutation).
    const r = await runCell(input({ opts: { lieOutcome: true }, fault879: true, fences: false, runs: 40, maxCommands: 12, seed: 62 }));
    expect(r.failure?.check).toBe(FOLD);
    expect(r.masked).toEqual({ [I7]: 1 });
    expect(r.failure?.commands.map((c) => c.split("(")[0])).toEqual(["Start", "Score"]);
    // Nothing committed: the check passed over is NEW too, and says what it ran (#879's shape).
    expect(Object.keys(r.maskedNew)).toEqual([I7]);
    expectLateEntryShape(r.maskedNew[I7] ?? []);
  });

  it("fix round 1, I-1: a KNOWN first failure never hides a NEW one met while shrinking — the shrink moves to the new check and the cell reports it NEW", async () => {
    // The reviewer's probe: seed 62, whose first failure is fold parity, now
    // with an OPEN regression on fold parity. #879's I7, met while shrinking,
    // has none: before the fix it was only counted in `masked` and the cell read known.
    const r = await runCell(input({ opts: { lieOutcome: true }, fault879: true, fences: false, runs: 40, maxCommands: 12, seed: 62, regressions: [openReg("MB-002", FOLD)] }));
    expect(r.failure?.check).toBe(I7);
    expect(r.failure?.known).toBeNull();
    expectLateEntryShape(r.failure?.commands ?? []);
    // Whatever was passed over after the move is known, so nothing NEW is left behind.
    expect(Object.keys(r.maskedNew)).toEqual([]);
    for (const c of Object.keys(r.masked)) expect(c, "masked while shrinking toward a NEW target").toBe(FOLD);
  });

  it("fix round 1, I-1: a NEW check passed over under a target that outranks it (a KNOWN unexpected refusal) is still reported, with the commands it ran", async () => {
    // Seed 62 at 12 commands, probed over seeds 1-200 (the only hit): the shrink
    // follows an unexpected refusal and passes over #879's I7 on the way.
    const r = await runCell(input({ driver: () => new RefusingPosts({ fault879: true }), fences: false, runs: 40, maxCommands: 12, seed: 62, regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED)] }));
    expect(r.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(r.failure?.known).toBe("MB-003");
    expect(r.masked[I7]).toBeGreaterThan(0);
    expect(Object.keys(r.maskedNew)).toEqual([I7]);
    expectLateEntryShape(r.maskedNew[I7] ?? []);
    // With I7 committed too, nothing passed over is new.
    const both = await runCell(input({ driver: () => new RefusingPosts({ fault879: true }), fences: false, runs: 40, maxCommands: 12, seed: 62, regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED), openReg("MB-001", I7)] }));
    expect(both.masked[I7]).toBeGreaterThan(0);
    expect(both.maskedNew).toEqual({});
  });

  it("fix round 2, RR-1: a NEW target displaced by a KNOWN unexpected refusal is still reported, with the commands it ran", async () => {
    // The reviewer's seeds 2, 11, 15, 16, 24 (GatedLiar, 12 commands, 40 runs):
    // the first failing run added an entrant, then scored — accepted and lied
    // about, so fold parity (NEW). Its shrink candidates that drop the late
    // entrant have their Score refused by name: an unexpected refusal, which
    // outranks it and is KNOWN here (MB-003). Before the fix the fold-parity
    // target was overwritten and appeared nowhere; the cell read known.
    for (const seed of [2, 11, 15, 16, 24]) {
      const r = await runCell(input({ driver: () => new GatedLiar(), runs: 40, maxCommands: 12, seed, regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED)] }));
      expect(r.failure?.check, `seed ${seed}`).toBe(UNEXPECTED_REFUSAL);
      expect(r.failure?.known, `seed ${seed}`).toBe("MB-003");
      expect(Object.keys(r.maskedNew), `seed ${seed}`).toContain(FOLD);
      // What it ran is GatedLiar's own precondition for a lie: an entrant added,
      // then a result posted (a Score, or a Walkover, which posts one too).
      const kinds = (r.maskedNew[FOLD] ?? []).map((c) => c.split("(")[0] ?? "");
      const posted = Math.max(kinds.lastIndexOf("Score"), kinds.lastIndexOf("Walkover"));
      expect(kinds.indexOf("AddEntrant"), `seed ${seed}: ${kinds.join(",")}`).toBeGreaterThan(-1);
      expect(posted, `seed ${seed}: ${kinds.join(",")}`).toBeGreaterThan(kinds.indexOf("AddEntrant"));
    }
    // The refusal NEW as well (nothing committed): fold parity is still kept, not dropped.
    const bare = await runCell(input({ driver: () => new GatedLiar(), runs: 40, maxCommands: 12, seed: 15 }));
    expect(bare.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(bare.failure?.known).toBeNull();
    expect(Object.keys(bare.maskedNew)).toContain(FOLD);
    // With fold parity committed too, the displaced target is known: nothing new is kept.
    const both = await runCell(input({ driver: () => new GatedLiar(), runs: 40, maxCommands: 12, seed: 15, regressions: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED), openReg("MB-002", FOLD)] }));
    expect(both.failure?.known).toBe("MB-003");
    expect(both.maskedNew).toEqual({});
  });

  it("fix round 2: a NEW check passed over more than once keeps the commands of the FIRST run that failed on it", async () => {
    // The 1st failing run fails on an unexpected refusal (the target), the 2nd
    // and 3rd on a NEW check X (passed over), every later one on the refusal.
    const X = "test-new-check";
    const s = scripted((nth) => (nth === 2 || nth === 3 ? X : UNEXPECTED_REFUSAL));
    const r = await runCell(input({ newDriverState: s.newDriverState }));
    expect(r.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(r.masked[X]).toBe(2);
    const [, second, third] = s.seenBy;
    // The witness needs the two meetings to differ, or keep-first and keep-last read the same.
    expect(second, "the 2nd and 3rd failures ran the same commands: no witness").not.toEqual(third);
    expect(r.maskedNew[X]).toEqual(second);
  });

  it("fix round 2, RR-1: a displaced NEW target keeps the commands of the LAST run that failed on it — the shrink's most shrunk", async () => {
    // The 1st and 2nd failing runs fail on a NEW check X (the target, shrunk
    // once), every later one on an unexpected refusal, which takes over.
    const X = "test-new-check";
    const s = scripted((nth) => (nth <= 2 ? X : UNEXPECTED_REFUSAL));
    const r = await runCell(input({ newDriverState: s.newDriverState }));
    expect(r.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(r.masked[X]).toBeUndefined();
    const [first, second] = s.seenBy;
    expect(first, "the 1st and 2nd failures ran the same commands: no witness").not.toEqual(second);
    expect(r.maskedNew[X]).toEqual(second);
  });

  it("time box: once the clock passes the limit no further run starts — reported interrupted, numRuns short, never a failure", async () => {
    let t = 0;
    // Each read advances the clock 1 s; the deadline is read once, then once per run.
    const r = await runCell(input({ now: () => (t += 1000), timeLimitMs: 3500 }));
    expect(r.failure).toBeNull();
    expect(r.interrupted).toBe(true);
    expect(r.numRuns).toBe(3);
    expect(r.executions).toBe(3);
  });

  it("time box, empty case: a limit already spent runs nothing — vacuous, never a failure", async () => {
    let t = 0;
    const r = await runCell(input({ now: () => (t += 1000), timeLimitMs: 0 }));
    expect(r.failure).toBeNull();
    expect(r.interrupted).toBe(true);
    expect(r.numRuns).toBe(0);
    expect(r.executions).toBe(0);
    // R25, every line and each on its own: nothing ran, so every vacuity rule fires. With no
    // run, no stage kind is known, so only the invariants that apply to ANY stage are owed
    // (from the registry, never a typed list).
    expect(r.vacuous).toEqual([
      ...COMMAND_KINDS.map((k) => `command ${k} never ran`),
      "no Score was accepted",
      ...STEP_INVARIANTS.filter((s) => s.stageKinds === "any").map((s) => `step invariant ${s.id} checked zero items`),
      "fold parity compared zero fixtures",
      `no informative step (${VACUITY_CHECK})`,
    ]);
  });

  it("time box after a failure: the limit cuts the shrink short and the failure is still reported, unshrunk", async () => {
    const full = await runCell(input({ fault879: true, fences: false }));
    let started = 0;
    let last: ModelState | null = null;
    const cut = await runCell(input({
      fault879: true, fences: false,
      // The clock runs out the moment the first failing run has been started.
      now: () => (started >= full.numRuns ? Number.POSITIVE_INFINITY : 0),
      newDriverState: async (n) => {
        started = n;
        const real = new ModelFakeDriver({ fault879: true });
        last = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        return { real, model: last };
      },
    }));
    expect(cut.failure?.check).toBe(I7);
    expect(cut.interrupted).toBe(true);
    expect(cut.executions).toBe(full.numRuns);
    expect(cut.failure?.path).toBe(String(full.numRuns - 1));
    expect(cut.failure?.commands.length).toBeGreaterThanOrEqual(full.failure?.commands.length ?? Number.POSITIVE_INFINITY);
    // Unshrunk, the generated run still holds commands its preconditions skipped and commands
    // after the one that threw. Only the ones that RAN are listed (R-PF9): exactly the failing
    // run's own record of what it ran, in order, ending on the Generate that threw.
    const ran = (last as ModelState | null)?.history ?? [];
    expect(ran.length).toBeGreaterThan(0);
    expect(cut.failure?.commands).toEqual(ran);
    expect(ran.at(-1)?.split("(")[0]).toBe("Generate");
  });

  it("fix round 1, M-7: fast-check giving up on skips the time box did not cause is a model-error failure, never a clean cell", async () => {
    // A future fc.pre inside a command (or here, the division set-up) skips
    // every run; fast-check then fails with no counterexample.
    const r = await runCell(input({ runs: 5, newDriverState: async () => { fc.pre(false); throw new Error("fc.pre(false) returned"); } }));
    expect(r.interrupted).toBe(false);
    expect(r.failure?.check).toBe("model-error");
    expect(r.failure?.evidence.join(" ")).toMatch(/gave up after \d+ skipped run/);
    expect(r.failure?.known).toBeNull();
    expect(r.failure?.path).toBe("");
    // The time box is the one skip that is not a failure (tested above: interrupted, failure null).
  });

  it("fix round 1, M-7: a skipped run never becomes the shrink target — a real failure after it is still found and reported", async () => {
    let n = 0;
    const r = await runCell(input({
      fault879: true, fences: false,
      newDriverState: async (k) => {
        if (++n === 1) fc.pre(false);
        const real = new ModelFakeDriver({ fault879: true });
        return { real, model: await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${k}` }) };
      },
    }));
    expect(n).toBeGreaterThan(1);
    expect(r.failure?.check).toBe(I7);
    expect(r.masked).toEqual({});
  });

  it("fix round 2, RR-2: a request that did not answer is environmental — the cell stops, reports the timeout, never a model-error failure, and counts nothing refused", async () => {
    // Every post hangs past the driver's bound (HttpDriver throws RequestTimedOut).
    const built: number[] = [];
    let timedOutIn: number | null = null;
    const r = await runCell(input({
      newDriverState: async (n) => {
        built.push(n);
        const real = new (class extends ModelFakeDriver {
          override postStream(id: string, _e: readonly StreamEvent[], _p = ""): Promise<PostedEvent[]> {
            timedOutIn ??= n;
            return Promise.reject(new RequestTimedOut("POST", `/api/v1/fixtures/${id}/events`, 60_000));
          }
        })();
        return { real, model: await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` }) };
      },
    }));
    expect(timedOutIn, "no post was ever sent: the test drove nothing").not.toBeNull();
    expect(r.timeout).toMatch(/^driver: POST \/api\/v1\/fixtures\/[^ ]+\/events did not answer within 60000 ms/);
    expect(r.failure).toBeNull();
    expect(r.vacuous).toEqual([]);
    // Not a refusal, named or otherwise: a result that never answered is neither.
    for (const k of COMMAND_KINDS) expect([k, r.counts[k].refused, r.counts[k].expected, r.counts[k].unexpected]).toEqual([k, 0, 0, 0]);
    expect(r.counts.Score.ran + r.counts.Walkover.ran).toBeGreaterThan(0);
    // After the timeout no run starts: the division it hung in was the last one built.
    expect(built.at(-1)).toBe(timedOutIn);
    expect(r.executions).toBe(timedOutIn);
  });

  it("fix round 2, RR-2: a timeout while shrinking a KNOWN failure keeps that failure and aborts the cell — never a NEW model-error", async () => {
    const reg = openReg("MB-001", I7);
    const full = await runCell(input({ fault879: true, fences: false, regressions: [reg] }));
    expect(full.failure?.check).toBe(I7);
    expect(full.executions, "the failure was never shrunk: no candidate to time out in").toBeGreaterThan(full.numRuns);
    // Every division after the first failing run hangs while it is built.
    const r = await runCell(input({
      fault879: true, fences: false, regressions: [reg],
      newDriverState: async (n) => {
        if (n > full.numRuns) throw new RequestTimedOut("POST", "/api/v1/competitions/c/divisions", 60_000);
        const real = new ModelFakeDriver({ fault879: true });
        return { real, model: await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` }) };
      },
    }));
    expect(r.timeout).toMatch(/did not answer/);
    expect(r.failure?.check).toBe(I7);
    expect(r.failure?.known).toBe("MB-001");
    expect(r.maskedNew).toEqual({});
    expect(r.masked).toEqual({});
    // The first candidate hung, and no run started after it.
    expect(r.executions).toBe(full.numRuns + 1);
  });

  it("deterministic: the same seed gives the same report", async () => {
    expect(await runCell(input({ runs: 15 }))).toEqual(await runCell(input({ runs: 15 })));
  });
});

describe("vacuityOf — which zero counts make a cell vacuous, by stage kind (fix round 1, I-2 and M-1)", () => {
  const byId = (id: string) => STEP_INVARIANTS.find((s) => s.id === id);
  const I6 = "I6-swiss-no-rematch";
  const one = (): CommandCounts => ({ ran: 1, accepted: 1, refused: 0, expected: 0, unexpected: 0 });
  /** Every count non-zero: nothing is vacuous on any kind. */
  const covered = (stageKind: string | null, zero: readonly string[] = []) => ({
    counts: Object.fromEntries(COMMAND_KINDS.map((k) => [k, one()])) as Record<(typeof COMMAND_KINDS)[number], CommandCounts>,
    stepChecks: Object.fromEntries([...STEP_INVARIANTS.map((s) => s.id), ORIENTATION_CHECK].map((id) => [id, zero.includes(id) ? 0 : 3])),
    foldParity: 2, informative: 4, stageKind,
  });
  const line = (id: string) => `step invariant ${id} checked zero items`;
  const orientationLine = `step check ${ORIENTATION_CHECK} checked zero items`;

  it("the premises the table rests on, read from the declarations: I6 swiss only, I7 league and group, I8 any stage, the orientation check league and group", () => {
    expect(byId(I6)?.stageKinds).toEqual(["swiss"]);
    expect(byId(I7)?.stageKinds).toEqual(["league", "group"]);
    expect(byId(I8)?.stageKinds).toBe("any");
    expect(ORIENTATION_STAGE_KINDS).toEqual(["league", "group"]);
  });

  it("empty case first: every count covered is vacuous on no stage kind", () => {
    const kinds = [null, "league", "group", "swiss", "knockout"];
    for (const k of kinds) expect(vacuityOf(covered(k)), String(k)).toEqual([]);
    expect(kinds.length).toBe(5);
  });

  const TABLE: readonly (readonly [string, string | null, readonly string[], readonly string[]])[] = [
    ["a league with zero I7 items", "league", [I7], [line(I7)]],
    ["a group with zero I7 items", "group", [I7], [line(I7)]],
    ["a swiss with zero I6 items", "swiss", [I6], [line(I6)]],
    ["a league owes no I6", "league", [I6], []],
    ["a swiss owes no I7", "swiss", [I7], []],
    ["a knockout owes neither I6 nor I7", "knockout", [I6, I7], []],
    ["a knockout still owes I8 (any stage)", "knockout", [I8], [line(I8)]],
    ["no stage kind known: only the any-stage invariants are owed", null, [I6, I7, I8, ORIENTATION_CHECK], [line(I8)]],
    ["M-1: a league whose orientation check judged zero pairs", "league", [ORIENTATION_CHECK], [orientationLine]],
    ["M-1: a group whose orientation check judged zero pairs", "group", [ORIENTATION_CHECK], [orientationLine]],
    ["M-1: a swiss owes no orientation count", "swiss", [ORIENTATION_CHECK], []],
    ["M-1: a knockout owes no orientation count", "knockout", [ORIENTATION_CHECK], []],
  ];
  it.each(TABLE)("%s", (_why, kind, zero, want) => {
    expect(vacuityOf(covered(kind, zero))).toEqual(want);
  });
});
