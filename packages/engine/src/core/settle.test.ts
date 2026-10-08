import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { CORE_EVENT_SCHEMAS, KERNEL_OWNED_CORE, SETTLE_METHODS, foldMatchWithStoppage, isKernelOwnedEventType, kernelOwnsEvent, outcomeOf, settleApplies, settledMethod, type EventEnvelope } from "./events.ts";
import { LINEUP_EVENT_SCHEMAS } from "./lineup.ts";
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
      // Ruling D-C5: decided by a settle or by the decider itself, whatever the module phase still says.
      ["settled win while the module phase still says tiebreak", { outcome: { kind: "win", winner: H, loser: A, method: "settled_lot" }, abandoned: false, state: { phase: "tiebreak" } }, hooked, false],
      ["tie-break win, abandoned and hooked at once", { outcome: { kind: "win", winner: H, loser: A, method: "tiebreak_rapid" }, abandoned: true, state: { phase: "tiebreak" } }, hooked, false],
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
    // …and it stays decided past an annotation: the note reaches the module, whose own outcome is still null on a
    // settled abandon — the decided flag must not be re-derived from it (guarantee 4 is monotonic).
    const settledAbandon = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "r" }), settle(3)];
    expect(codeOf(() => fold([...settledAbandon, ev(4, "core.note", { text: "ok" }), ev(5, "boardgame.result", { winner: H, method: "checkmate" })]))).toBe("ALREADY_DECIDED");
  });

  it("guarantee 5 through the I-1 dispatch: an annotation the module folds during a stoppage leaves play suspended; the resume ends it", () => {
    const suspended = [ev(1, "core.start"), ev(2, "core.suspend", { reason: "rain" })];
    const annotated = fold([...suspended, ev(3, "core.note", { text: "covers on" }), ev(4, "core.award", { person: "p1", key: "motm" })]);
    expect(annotated.stoppage).toMatchObject({ reason: "rain", eventId: "e-2" });
    expect(fold([...suspended, ev(3, "core.note", { text: "covers on" }), ev(4, "core.resume")]).stoppage).toBeNull(); // the positive pair
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

  it("review Minor 7: a SECOND finalize after a settled abandon is answered as a second finalize is everywhere else — accepted as a no-op where the kernel owns it, and by the module's own rule where the module does (generic alone refuses)", () => {
    // Elsewhere: every module's own finalize is `if (state.outcome === null) wrongPhase(…); return {…, phase: "final"}`,
    // so a second finalize on a decided fixture is accepted again — except generic (`phase !== "done"` ⇒ WRONG_PHASE).
    // In the product the server locks the ledger at the first finalize (append-event.ts LOCKED_FIXTURE_STATUSES), so
    // TODAY neither answer is reachable there — but that is not by design: append-event.ts's `fixtureStatusFromFold`
    // comment describes a staff REOPEN that leaves an active finalize in an appendable stream, and a second finalize
    // would then reach this fold. No reopen usecase exists in apps/web yet; the day one lands, this is the answer it
    // meets. The kernel's own finalize (a settled abandon the module has not decided) aligns with the ten: accepted
    // again, nothing moves.
    let kernelOwned = 0;
    let moduleOwned = 0;
    const moduleRefusesSecond: string[] = [];
    const sports = forEachSport(({ key, module }) => {
      const lineups = defaultLineupPair(module.positions);
      for (const { name, cfg } of declaredCfgs(module as never)) {
        const run = (events: EventEnvelope[]) => foldMatchWithStoppage(module, cfg as never, lineups, events);
        // The module's own answer to a second finalize, on a fixture decided by a forfeit and finalized once.
        const forfeited = [ev(1, "core.start"), ev(2, "core.forfeit", { by: lineups.away.entrantId, reason: "no-show" }), ev(3, "core.finalize")];
        expect(outcomeOf(module, run(forfeited)), `${key}/${name}`).not.toBeNull();
        const moduleSecond = codeOf(() => run([...forfeited, ev(4, "core.finalize")]));
        if (moduleSecond !== null && !moduleRefusesSecond.includes(key)) moduleRefusesSecond.push(key);
        // A settled abandon, finalized once, then again.
        const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
        const o = outcomeOf(module, run(base));
        if (!(o === null || isLevelOutcome(o))) continue; // this cfg's abandon awards a winner: nothing to settle (X-ST-1)
        const once = [...base, ev(3, "core.settle", { winner: lineups.home.entrantId, method: "organiser" }), ev(4, "core.finalize")];
        const second = codeOf(() => run([...once, ev(5, "core.finalize")]));
        if (kernelOwnsEvent(module, { type: "core.finalize" }, { state: run(once).state, settled: true })) {
          expect(second, `${key}/${name}`).toBeNull();
          expect(JSON.stringify(run([...once, ev(5, "core.finalize")])), `${key}/${name}`).toBe(JSON.stringify(run(once))); // a no-op
          kernelOwned++;
        } else {
          expect(second, `${key}/${name}`).toBe(moduleSecond); // the module's own rule, as on any decided fixture
          moduleOwned++;
        }
      }
    });
    expect(sports).toBe(11);
    expect(kernelOwned).toBeGreaterThan(0);
    expect(moduleOwned).toBeGreaterThan(0);
    expect(moduleRefusesSecond).toEqual(["generic"]);
  });

  it("review N1: a type kernelOwnsEvent claims but no kernel branch folds is an invariant failure naming it — a bug, never a silent no-op and never a scorer's refusal", () => {
    const stream = [ev(1, "core.start"), ev(2, "core.note", { text: "covers on" })];
    expect(codeOf(() => fold(stream))).toBeNull(); // the positive pair first: the note is the module's, and folds
    const owned = KERNEL_OWNED_CORE as string[];
    const before = owned.length;
    owned.push("core.note"); // injection: a kernel-owned type with no dispatch branch of its own
    let thrown: unknown = null;
    try {
      expect(isKernelOwnedEventType("core.note")).toBe(true); // the injection took
      try { fold(stream); } catch (e) { thrown = e; }
    } finally {
      owned.length = before;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'foldMatchWithStoppage: kernelOwnsEvent claims "core.note" but no kernel branch folds "core.note" — ' +
        "a type added to KERNEL_OWNED_CORE owes its branch in the fold's dispatch",
    ); // the whole message: it is the only pointer a 500's reader gets to the missing branch
    expect(EngineError.is(thrown)).toBe(false); // not a coded refusal the API would hand a scorer as a 4xx
    expect(isKernelOwnedEventType("core.note")).toBe(false); // restored
    expect(codeOf(() => fold(stream))).toBeNull();
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

  it("W2a I-1: kernelOwnsEvent is spec §5.1's kernel-owned set (suspend, resume, settle, the lineup family) plus finalize on a settled fixture the module has not decided — and the fold hands the module exactly the rest", () => {
    // Expected from the spec's list and the engine's own lineup registry, never from the predicate. `core.void` is
    // stripped by resolveVoids before any dispatch, so it is not asked.
    const expected = ["core.resume", "core.settle", "core.suspend", ...Object.keys(LINEUP_EVENT_SCHEMAS)].sort();
    const core = Object.keys(CORE_EVENT_SCHEMAS).filter((t) => t !== "core.void");
    expect(core.filter((t) => isKernelOwnedEventType(t)).sort()).toEqual(expected);
    const moduleOwned = core.filter((t) => !isKernelOwnedEventType(t)).sort();
    expect(moduleOwned).toEqual(["core.abandon", "core.award", "core.finalize", "core.forfeit", "core.note", "core.start"]);
    expect(isKernelOwnedEventType("boardgame.result")).toBe(false); // a sport's own type is always the module's
    // The conditional member, row by row: finalize is the kernel's only when settled AND the module has no outcome.
    const finalize = { type: "core.finalize" };
    const abandoned = fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]).state;
    const level = fold(drawn).state;
    expect(kernelOwnsEvent(boardgame, finalize, { state: abandoned, settled: true })).toBe(true);
    expect(kernelOwnsEvent(boardgame, finalize, { state: abandoned, settled: false })).toBe(false);
    expect(kernelOwnsEvent(boardgame, finalize, { state: level, settled: true })).toBe(false); // a settled draw: the module's
    expect(kernelOwnsEvent(boardgame, { type: "core.note" }, { state: abandoned, settled: true })).toBe(false);
    // Behaviour: across every module-owned core type the stream can carry, plus a suspend, a resume, a settle and a
    // kernel-owned finalize, the fold hands the module exactly the events the predicate does not own.
    const seen: string[] = [];
    const spy = { ...boardgame, apply: (st: never, e: EventEnvelope, c: never) => { seen.push(e.type); return boardgame.apply(st, e as never, c); } };
    const stream = [
      ev(1, "core.start"), ev(2, "core.note", { text: "n" }), ev(3, "core.suspend", { reason: "rain" }), ev(4, "core.resume"),
      ev(5, "core.award", { person: "p1", key: "motm" }), ev(6, "core.abandon", { reason: "rain" }), settle(7), ev(8, "core.finalize"),
    ];
    foldMatchWithStoppage(spy as never, bgCfg, bgLineups, stream);
    let settledSoFar = false;
    const forModule: string[] = [];
    stream.forEach((e, i) => {
      if (!kernelOwnsEvent(boardgame, e, { state: fold(stream.slice(0, i)).state, settled: settledSoFar })) forModule.push(e.type);
      if (e.type === "core.settle") settledSoFar = true;
    });
    expect(seen).toEqual(forModule);
    expect(seen).toEqual(["core.start", "core.note", "core.award", "core.abandon"]);
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
