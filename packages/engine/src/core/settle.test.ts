import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { CORE_EVENT_SCHEMAS, SETTLE_METHODS, foldMatchWithStoppage, outcomeOf, settleApplies, settledMethod, type EventEnvelope } from "./events.ts";
import { isLevelOutcome } from "./types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";
import { generic } from "../sports/generic/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const bgCfg = boardgame.configSchema.parse({});
const bgLineups = defaultLineupPair(boardgame.positions);
const H = bgLineups.home.entrantId;
const A = bgLineups.away.entrantId;
const fold = (events: EventEnvelope[]) => foldMatchWithStoppage(boardgame, bgCfg, bgLineups, events);
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const settle = (seq: number, winner = H, method: string = "lot") => ev(seq, "core.settle", { winner, method });
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const errOf = (f: () => unknown): EngineError => {
  try { f(); } catch (e) { if (EngineError.is(e)) return e; throw e; }
  throw new Error("expected an EngineError refusal, got none");
};

describe("X-ST-1: core.settle (spec §5.1)", () => {
  it("empty case first: a stream with no settle folds with settlement null and outcomeOf = module.outcome", () => {
    const f = fold([ev(1, "core.start")]);
    expect(f.settlement).toBeNull();
    expect(outcomeOf(boardgame, f)).toBeNull();
  });

  it("X-ST-1: is registered as a core event and validates its payload", () => {
    expect(Object.hasOwn(CORE_EVENT_SCHEMAS, "core.settle")).toBe(true);
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H, method: "coin" })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H })]))).toBe("INVALID_EVENT");
    // `note` (the Interfaces block: trimmed, 1–500 characters): a short note is kept, trimmed; blank and 501 are refused.
    const schema = CORE_EVENT_SCHEMAS["core.settle"];
    expect(schema.parse({ winner: H, method: "lot", note: " ab " })).toMatchObject({ note: "ab" });
    expect(fold([...drawn, ev(3, "core.settle", { winner: H, method: "lot", note: " ab " })]).settlement?.winner).toBe(H);
    expect(schema.safeParse({ winner: H, method: "lot", note: "x".repeat(500) }).success).toBe(true);
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H, method: "lot", note: "   " })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H, method: "lot", note: "x".repeat(501) })]))).toBe("INVALID_EVENT");
  });

  it("X-ST-1: on a draw it gives win{winner, loser, settled_<method>} for each declared method, and leaves the score untouched", () => {
    let checked = 0;
    for (const method of SETTLE_METHODS) {
      const f = fold([...drawn, settle(3, A, method)]);
      expect(outcomeOf(boardgame, f)).toEqual({ kind: "win", winner: A, loser: H, method: settledMethod(method) });
      expect(boardgame.outcome(f.state)).toEqual({ kind: "draw" }); // module state is not rewritten
      expect(boardgame.summary(f.state).headline).toBe(boardgame.summary(fold(drawn).state).headline); // no invented score
      checked++;
    }
    expect(checked).toBe(SETTLE_METHODS.length);
  });

  it("X-ST-1: is refused on a live fixture with no outcome and no abandon, and on a decided win", () => {
    // The refusal names the settle (event-import reports it as `eventIndex`) and the facts it was judged on; it is not
    // the "already settled" refusal (spec §7: the two are different reasons the console shows).
    const live = errOf(() => fold([ev(1, "core.start"), settle(2)]));
    expect(live.code).toBe("SETTLE_NOT_APPLICABLE");
    expect(live.data).toEqual({ eventId: "e-2", outcome: null, abandoned: false });
    expect(live.message).not.toMatch(/already settled/);
    expect(live.message.length).toBeGreaterThan(0);
    const won = errOf(() => fold([ev(1, "core.start"), ev(2, "boardgame.result", { winner: H, method: "checkmate" }), settle(3)]));
    expect(won.code).toBe("SETTLE_NOT_APPLICABLE");
    expect(won.data).toMatchObject({ eventId: "e-3", outcome: { kind: "win", winner: H }, abandoned: false });
    expect(won.message).not.toMatch(/already settled/);
  });

  it("X-ST-1: a second settle is refused (Review Focus 2)", () => {
    const second = errOf(() => fold([...drawn, settle(3, H), settle(4, A)]));
    expect(second.code).toBe("SETTLE_NOT_APPLICABLE");
    expect(second.message).toMatch(/already settled/); // spec §7: "on an already settled fixture"
    expect(second.data).toMatchObject({ eventId: "e-4", outcome: { kind: "win", winner: H, method: "settled_lot" } });
  });

  it("X-ST-1: a winner who is neither side is refused", () => {
    const e = errOf(() => fold([...drawn, settle(3, "nobody")]));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toContain("nobody");
    expect(e.data).toEqual({ eventId: "e-3" });
  });

  it("C12: settleApplies is THE precondition — level, or nothing decided with an abandon or a pending decider; never a win or an award", () => {
    const hooked = { awaitingDecider: (st: never) => (st as { phase?: string }).phase === "tiebreak" };
    const plain = {};
    const rows: [string, { outcome: unknown; abandoned: boolean; state: unknown }, object, boolean][] = [
      ["empty: nothing played, no abandon, no decider", { outcome: null, abandoned: false, state: { phase: "live" } }, hooked, false],
      ["draw", { outcome: { kind: "draw" }, abandoned: false, state: {} }, plain, true],
      ["tie", { outcome: { kind: "tie" }, abandoned: false, state: {} }, plain, true],
      ["no_result (a level abandon)", { outcome: { kind: "no_result" }, abandoned: true, state: {} }, plain, true],
      ["win (also: an active settle, via outcomeOf)", { outcome: { kind: "win", winner: H, loser: A }, abandoned: false, state: {} }, plain, false],
      ["award", { outcome: { kind: "award", winner: H }, abandoned: false, state: {} }, plain, false],
      ["abandoned with no outcome", { outcome: null, abandoned: true, state: {} }, plain, true],
      ["decider pending (hook true)", { outcome: null, abandoned: false, state: { phase: "tiebreak" } }, hooked, true],
      ["no hook declared: the same state is not settleable", { outcome: null, abandoned: false, state: { phase: "tiebreak" } }, plain, false],
      // An abandon or a pending decider settles only "nothing decided": a result already on the fold outranks both.
      ["win after an abandon that awarded a result", { outcome: { kind: "win", winner: H, loser: A }, abandoned: true, state: {} }, plain, false],
      ["award after an abandon", { outcome: { kind: "award", winner: H }, abandoned: true, state: {} }, plain, false],
      ["win while the hook says a decider is pending", { outcome: { kind: "win", winner: H, loser: A }, abandoned: false, state: { phase: "tiebreak" } }, hooked, false],
    ];
    let checked = 0;
    for (const [name, facts, module, expected] of rows) {
      expect(settleApplies(module, facts as never), name).toBe(expected);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("C11: the kernel's precondition per outcome kind — draw, tie and no_result settle; win and award are refused (stub outcomes over the REAL kernel)", () => {
    const l = defaultLineupPair(generic.positions);
    const cfg = generic.configSchema.parse(generic.variants.score);
    const kinds = [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }, { kind: "win", winner: l.home.entrantId, loser: l.away.entrantId }, { kind: "award", winner: l.home.entrantId }];
    let checked = 0;
    for (const o of kinds) {
      const stub = { ...generic, outcome: () => o }; // `decided` starts false and the settle is the only event, so only the precondition judges it
      const got = codeOf(() => foldMatchWithStoppage(stub as never, cfg as never, l, [ev(1, "core.settle", { winner: l.home.entrantId, method: "lot" })]));
      expect(got, o.kind).toBe(isLevelOutcome(o as never) ? null : "SETTLE_NOT_APPLICABLE");
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("C12: a module with a pending decider accepts settle with no outcome and no abandon; without the hook the same stream is refused", () => {
    const l = defaultLineupPair(generic.positions);
    const cfg = generic.configSchema.parse(generic.variants.score);
    const stream = [ev(1, "core.start"), ev(2, "core.settle", { winner: l.away.entrantId, method: "lot" })];
    const pending = { ...generic, awaitingDecider: () => true };
    expect(outcomeOf(pending as never, foldMatchWithStoppage(pending as never, cfg as never, l, stream))).toEqual({ kind: "win", winner: l.away.entrantId, loser: l.home.entrantId, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(generic as never, cfg as never, l, stream))).toBe("SETTLE_NOT_APPLICABLE"); // the positive pair's negative
  });

  it("X-ST-1: closes an abandon whose module outcome is null", () => {
    const f = fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), settle(3, H, "higher_seed")]);
    expect(boardgame.outcome(f.state)).toBeNull();
    expect(outcomeOf(boardgame, f)).toEqual({ kind: "win", winner: H, loser: A, method: "settled_higher_seed" });
  });

  it("X-ST-1: a void of the settle restores the prior state, and a new settle is then accepted", () => {
    const voided = fold([...drawn, settle(3, H), ev(4, "core.void", {}, "e-3")]);
    expect(voided.settlement).toBeNull();
    expect(outcomeOf(boardgame, voided)).toEqual({ kind: "draw" });
    const again = fold([...drawn, settle(3, H), ev(4, "core.void", {}, "e-3"), settle(5, A)]);
    expect(outcomeOf(boardgame, again)).toMatchObject({ kind: "win", winner: A });
  });

  it("X-ST-1: after a settle no play event is accepted (guarantee 4), but note and finalize are", () => {
    expect(codeOf(() => fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "r" }), settle(3), ev(4, "boardgame.result", { winner: H, method: "checkmate" })]))).toBe("ALREADY_DECIDED");
    expect(codeOf(() => fold([...drawn, settle(3), ev(4, "core.note", { text: "ok" })]))).toBeNull();
  });

  it("Review Focus 3: finalize after settling an abandon succeeds for EVERY sport (the kernel owns it there)", () => {
    let accepted = 0;
    const sports = forEachSport(({ key, module }) => {
      const lineups = defaultLineupPair(module.positions);
      for (const { name, cfg } of declaredCfgs(module as never)) { // never parse({}) blind: generic has no default (preflight C7)
        const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
        const before = foldMatchWithStoppage(module, cfg as never, lineups, base);
        const o = outcomeOf(module, before);
        if (!(o === null || isLevelOutcome(o))) continue; // this cfg's 0–0 abandon awards a winner: settle is not applicable, by X-ST-1
        const f = foldMatchWithStoppage(module, cfg as never, lineups, [...base, ev(3, "core.settle", { winner: lineups.home.entrantId, method: "organiser" }), ev(4, "core.finalize")]);
        expect(outcomeOf(module, f), `${key}/${name}`).toMatchObject({ kind: "win", winner: lineups.home.entrantId, method: "settled_organiser" });
        accepted++;
      }
    });
    expect(sports).toBe(11);
    expect(accepted).toBeGreaterThan(0);
  });

  it("finding 4: settle is accepted while play is suspended after an abandon that left the stoppage open", () => {
    const f = fold([ev(1, "core.start"), ev(2, "core.suspend", { reason: "rain" }), ev(3, "core.abandon", { reason: "rain" }), settle(4)]);
    expect(f.stoppage).toBeNull();
    expect(outcomeOf(boardgame, f)).toMatchObject({ kind: "win", winner: H });
  });

  it("plan finding 21: the kernel owns finalize ONLY after a settled abandon; note, award and every other finalize reach module.apply", () => {
    // Boardgame: its abandon leaves the module outcome null (the case finding 21 is about); its draw is a module outcome.
    const award = { person: "p1", key: "motm" };
    const seenBy = (events: EventEnvelope[]): string[] => {
      const seen: string[] = [];
      const spy = { ...boardgame, apply: (st: never, e: EventEnvelope, c: never) => { seen.push(e.type); return boardgame.apply(st, e as never, c); } };
      foldMatchWithStoppage(spy as never, bgCfg, bgLineups, events);
      return seen;
    };
    expect(boardgame.outcome(fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]).state)).toBeNull();
    // A settled DRAW: the module has an outcome, so it owns finalize as on any decided fixture (guarantee 4 lets all three in).
    expect(seenBy([...drawn, settle(3), ev(4, "core.note", { text: "n" }), ev(5, "core.award", award), ev(6, "core.finalize")]))
      .toEqual(["core.start", "boardgame.result", "core.note", "core.award", "core.finalize"]);
    // A settled ABANDON: the module has no outcome and would refuse finalize, so the kernel takes finalize — and only finalize.
    expect(seenBy([ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), settle(3), ev(4, "core.note", { text: "n" }), ev(5, "core.award", award), ev(6, "core.finalize")]))
      .toEqual(["core.start", "core.abandon", "core.note", "core.award"]);
  });

  it("finding 2: core.settle never reaches module.apply", () => {
    const seen: string[] = [];
    const spy = { ...generic, apply: (s: never, e: EventEnvelope, c: never) => { seen.push(e.type); return generic.apply(s, e as never, c); } };
    const cfg = generic.configSchema.parse({ allowDraws: true, resultMode: "score" });
    const l = defaultLineupPair(generic.positions);
    foldMatchWithStoppage(spy as never, cfg as never, l, [ev(1, "generic.result", { p1Score: 1, p2Score: 1 }), ev(2, "core.settle", { winner: l.home.entrantId, method: "lot" })]);
    expect(seen).toEqual(["generic.result"]);
  });

  it("rule 10: any sequence of settle / void-last / note on a drawn game keeps the invariants after every step", () => {
    // Invariants: (a) outcomeOf is a settled win iff an active settle exists; (b) a refused step leaves nothing behind;
    // (c) the only refusal this alphabet can meet is a SECOND settle — SETTLE_NOT_APPLICABLE, with a settle active.
    const step = fc.constantFrom("settleH", "settleA", "voidLast", "note");
    let total = 0; // steps checked across ALL runs (anti-vacuity: zero is a failure)
    let refusedSeen = 0;
    const activeSettleIn = (events: readonly EventEnvelope[]) => events.some((e) => e.type === "core.settle" && !events.some((v) => v.voids === e.id));
    fc.assert(fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      const events: EventEnvelope[] = [...drawn];
      for (const s of steps) {
        const seq = events.length + 1;
        const candidate =
          s === "settleH" ? settle(seq, H) : s === "settleA" ? settle(seq, A)
          : s === "note" ? ev(seq, "core.note", { text: "n" })
          : (() => { const live = events.filter((e) => e.type !== "core.void" && !events.some((v) => v.voids === e.id)); const t = live.at(-1); return t === undefined || t.seq <= 2 ? null : ev(seq, "core.void", {}, t.id); })();
        if (candidate === null) continue;
        const before = JSON.stringify(fold(events));
        const settledBefore = activeSettleIn(events);
        try { fold([...events, candidate]); events.push(candidate); } catch (e) {
          if (!EngineError.is(e)) throw e;
          expect(e.code).toBe("SETTLE_NOT_APPLICABLE"); // (c)
          expect(candidate.type === "core.settle" && settledBefore).toBe(true); // (c)
          expect(JSON.stringify(fold(events))).toBe(before); // (b): the refused step left the fold byte-equal
          refusedSeen++;
        }
        const f = fold(events);
        expect(outcomeOf(boardgame, f)?.kind).toBe(activeSettleIn(events) ? "win" : "draw"); // (a)
        total++;
      }
    }), { numRuns: 200 });
    expect(total).toBeGreaterThan(0);
    expect(refusedSeen).toBeGreaterThan(0); // a second settle is generated often enough to witness (b)
  });
});
