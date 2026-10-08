import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { deciderPending, foldMatch, foldMatchWithStoppage, outcomeOf, settleApplies, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import { evalPadGate } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { generic } from "../generic/index.ts";
import { boardgame, BoardgameMethod, CHESS_SCORE, TIEBREAK_RUNGS } from "./boardgame.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const lineups = defaultLineupPair(boardgame.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;
const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})) });
const league = boardgame.configSchema.parse({});
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const fold = (cfg: unknown, events: EventEnvelope[]) => foldMatch(boardgame, cfg as never, lineups, events);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const errOf = (f: () => unknown): EngineError => {
  try { f(); } catch (e) { if (EngineError.is(e)) return e; throw e; }
  throw new Error("expected an EngineError refusal, got none");
};

describe("BG-KO-1 / BG-KO-2: the chess knockout tie-break (ruling 73)", () => {
  it("empty case first: without tiebreak in cfg a drawn game is an ordinary draw (golden-safe)", () => {
    expect("tiebreak" in league).toBe(false); // absent, never defaulted (finding 12)
    expect(boardgame.outcome(fold(league, drawn))).toEqual({ kind: "draw" });
  });

  it("BG-KO-1: with tiebreak, a drawn game opens phase 'tiebreak' with no outcome, and the summary keeps the level score", () => {
    const s = fold(ko, drawn);
    expect(s.phase).toBe("tiebreak");
    expect(boardgame.outcome(s)).toBeNull();
    expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline); // ½ — ½, never "vs"
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({}); // pending: no rung yet
    // The positive pair: before the game is drawn the bracket board is undecided ("vs", the module's undecided
    // headline), and a league draw's detail carries no tie-break at all.
    const live = boardgame.summary(fold(ko, [ev(1, "core.start")]));
    expect(live.headline).toBe("vs");
    expect(live.perSide.map((p) => p.line)).toEqual(["", ""]);
    expect(Object.hasOwn(boardgame.summary(fold(league, drawn)).detail as object, "tiebreak")).toBe(false);
  });

  it("BG-KO-1: a double forfeit still folds to no_result (W2b owns it), never a tie-break", () => {
    expect(boardgame.outcome(fold(ko, [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]))).toEqual({ kind: "no_result" });
  });

  it("T15-R1 BG-KO-1: only a game the league calls DRAWN enters the tie-break — a bracket double forfeit is held no_result, awaitingDecider false, closed by settle", () => {
    // Every null-winner method (and the omitted one): in a bracket, a method whose league fold is a draw goes to
    // phase tiebreak; any other folds exactly as the league does. The ruling names the one other: double_forfeit.
    const methods: (string | undefined)[] = [...BoardgameMethod.options, undefined];
    let tiebreaks = 0;
    const held: string[] = [];
    for (const method of methods) {
      const events = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, ...(method === undefined ? {} : { method }) })];
      const asLeague = fold(league, events);
      const asKo = fold(ko, events);
      const name = String(method);
      if (boardgame.outcome(asLeague)?.kind === "draw") {
        expect(asKo.phase, name).toBe("tiebreak");
        expect(boardgame.awaitingDecider!(asKo), name).toBe(true);
        tiebreaks++;
      } else {
        expect(asKo.phase, name).not.toBe("tiebreak");
        expect(asKo.tiebreak, name).toBeUndefined();
        expect(boardgame.outcome(asKo), name).toEqual(boardgame.outcome(asLeague));
        expect(boardgame.awaitingDecider!(asKo), name).toBe(false);
        held.push(name);
      }
    }
    expect(held).toEqual(["double_forfeit"]);
    expect(tiebreaks).toBe(methods.length - 1);
    // Held, not stalled: no tie-break is accepted after it, and settle (X-ST-1) closes it.
    const df = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })];
    expect(codeOf(() => fold(ko, [...df, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("ALREADY_DECIDED");
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...df, ev(3, "core.settle", { winner: H, method: "organiser" })]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: H, loser: A, method: "settled_organiser" });
  });

  it("BG-KO-1: each rung decides a win with method tiebreak_<rung>, and the summary still shows the level game", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: A })]);
      expect(boardgame.outcome(s), rung).toEqual({ kind: "win", winner: A, loser: H, method: `tiebreak_${rung}` });
      expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline);
      expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({ rung }); // no score key at all
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-KO-1: a tiebreak outside phase 'tiebreak' is refused, per rung", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const refused = errOf(() => fold(ko, [ev(1, "core.start"), ev(2, "boardgame.tiebreak", { rung, winner: H })]));
      expect(refused.code, rung).toBe("TIEBREAK_NOT_APPLICABLE");
      expect(refused.message, rung).toContain('"live"'); // names the phase it was refused in
      expect(codeOf(() => fold(league, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: H })])), rung).toBe("ALREADY_DECIDED");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-KO-1: a second tiebreak is refused", () => {
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H }), ev(4, "boardgame.tiebreak", { rung: "blitz", winner: A })]))).toBe("ALREADY_DECIDED");
  });

  it("BG-KO-2 (ruling 82): the engine records the armageddon winner the scorer taps — either side, with or without colours", () => {
    // W2a enforces BG-KO-2 by the pad's hint (Task 12), not here; colours are W2c's (spec §2.3).
    const noColours = boardgame.configSchema.parse({ colors: false, tiebreak: true });
    let checked = 0;
    for (const cfg of [ko, noColours]) for (const winner of [H, A]) {
      const s = fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", winner })]);
      expect(boardgame.outcome(s)).toEqual({ kind: "win", winner, loser: winner === H ? A : H, method: "tiebreak_armageddon" });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the optional score is validated as a chess score", () => {
    for (const ok of ["1½–½", "2–0", "½–1½", "3–2"]) expect(CHESS_SCORE.test(ok), ok).toBe(true);
    for (const bad of ["1.5-0.5", "2-0", "", "–", "a–b", "1½–½ "]) expect(CHESS_SCORE.test(bad), bad).toBe(false);
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "2-0" })]))).toBe("INVALID_EVENT");
    const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "1½–½" })]);
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({ rung: "rapid", score: "1½–½" });
  });

  it("C12: in phase tiebreak lots is the organiser's settle — settleApplies is true, a settle decides, and a later tiebreak is refused", () => {
    const pending = fold(ko, drawn);
    expect(settleApplies(boardgame, { outcome: boardgame.outcome(pending), abandoned: false, state: pending })).toBe(true);
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: A, loser: H, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" }), ev(4, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("ALREADY_DECIDED");
    // The positive pair's negative: in phase "live" (nothing played) the same settle is refused.
    expect(settleApplies(boardgame, { outcome: null, abandoned: false, state: fold(ko, [ev(1, "core.start")]) })).toBe(false);
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [ev(1, "core.start"), ev(2, "core.settle", { winner: A, method: "lot" })]))).toBe("SETTLE_NOT_APPLICABLE");
  });

  it("ruling D-C5: once decided — by a settle in phase tiebreak, or by the tie-break itself — settle no longer applies and finalize is accepted; before it, settle applies and finalize is refused", () => {
    const run = (events: EventEnvelope[]) => foldMatchWithStoppage(boardgame, ko as never, lineups, events);
    const facts = (f: ReturnType<typeof run>) => ({ outcome: outcomeOf(boardgame, f), abandoned: false, state: f.state });
    // The positive pair: drawn, in phase tiebreak, nothing decided.
    const pending = run(drawn);
    expect(pending.state.phase).toBe("tiebreak");
    expect(settleApplies(boardgame, facts(pending))).toBe(true);
    expect(deciderPending(boardgame, pending)).toBe(true);
    expect(codeOf(() => run([...drawn, ev(3, "core.finalize")]))).toBe("WRONG_PHASE");
    // Settled by lot: the module phase is STILL "tiebreak" (the kernel owns the settle), yet nothing is pending.
    const lot = [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })];
    const settled = run(lot);
    expect(settled.state.phase).toBe("tiebreak");
    expect(boardgame.awaitingDecider!(settled.state)).toBe(true); // the module alone cannot tell…
    expect(settleApplies(boardgame, facts(settled))).toBe(false); // …the effective outcome can
    expect(deciderPending(boardgame, settled)).toBe(false);
    expect(outcomeOf(boardgame, run([...lot, ev(4, "core.finalize")]))).toMatchObject({ kind: "win", winner: A, method: "settled_lot" });
    // Decided by the tie-break itself.
    const tb = [...drawn, ev(3, "boardgame.tiebreak", { rung: "blitz", winner: H })];
    const decided = run(tb);
    expect(settleApplies(boardgame, facts(decided))).toBe(false);
    expect(deciderPending(boardgame, decided)).toBe(false);
    expect(run([...tb, ev(4, "core.finalize")]).state.phase).toBe("final");
    // And the held double forfeit (T15-R1): settle applies (a level no_result), no decider is pending.
    const df = run([ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]);
    expect(settleApplies(boardgame, facts(df))).toBe(true);
    expect(deciderPending(boardgame, df)).toBe(false);
    // Nothing owed where nothing is pending: a live bracket game, and a module that declares no decider hook at all.
    expect(deciderPending(boardgame, run([ev(1, "core.start")]))).toBe(false);
    const gl = defaultLineupPair(generic.positions);
    const gcfg = generic.configSchema.parse(generic.variants.score);
    expect(deciderPending(generic, foldMatchWithStoppage(generic, gcfg as never, gl, [ev(1, "core.start")]))).toBe(false);
  });

  it("abandon in phase tiebreak is accepted and leaves the outcome null (closed by settle, X-ST-1)", () => {
    const s = fold(ko, [...drawn, ev(3, "core.abandon", { reason: "venue closed" })]);
    expect(s.phase).toBe("abandoned");
    expect(boardgame.outcome(s)).toBeNull();
  });

  it("padSpec: unchanged for a cfg without tiebreak; with it, a tie-break panel gated on state.phase", () => {
    const plain = boardgame.padSpec!(league);
    expect(plain.panels.map((p) => p.gate)).toEqual(plain.panels.map(() => undefined));
    const withTb = boardgame.padSpec!(ko);
    const tb = withTb.panels.find((p) => p.actions.some((a) => a.type === "boardgame.tiebreak"));
    expect(tb?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "tiebreak" });
    expect(withTb.fidelity["boardgame.tiebreak"]).toBe(0);
    // The labels are the dictionary contract (apps/web ui.json, ruling D-C4); the field and the attribution are the
    // tiebreak payload's own: `rung` over the engine's rungs, `winner` as a side.
    const action = tb!.actions.find((a) => a.type === "boardgame.tiebreak")!;
    expect(tb!.labelKey).toEqual({ key: "pad.boardgame.panel.tiebreak", label: "Tie-break" });
    expect(action.labelKey).toEqual({ key: "pad.boardgame.action.tiebreak", label: "Tie-break" });
    expect(action.fields).toEqual([{ kind: "enum", path: "rung", values: TIEBREAK_RUNGS }]);
    expect(action.attribution.map((i) => [i.kind, i.path])).toEqual([["side", "winner"]]);
    // Behaviour, through the pad's own evaluator: a live bracket game offers the result panels, a drawn one only the
    // tie-break.
    const shown = (events: EventEnvelope[]) => {
      const s = fold(ko, events);
      return withTb.panels
        .filter((p) => p.phase === "live" && (p.gate === undefined || evalPadGate(p.gate, { state: s, summary: boardgame.summary(s) })))
        .map((p) => p.labelKey.key);
    };
    expect(shown([ev(1, "core.start")])).toEqual(["pad.boardgame.panel.result", "pad.boardgame.panel.draw"]);
    expect(shown(drawn)).toEqual(["pad.boardgame.panel.tiebreak"]);
  });

  it("BG-KO-1 generator: in phase tiebreak arbitraryEvent emits a tie-break the fold accepts — every rung, both winners, the score present and absent", () => {
    const pending = fold(ko, drawn);
    const seen = { rung: new Set<string>(), winner: new Set<string>(), score: new Set<string>() };
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const e = boardgame.arbitraryEvent!(pending, mulberry32(seed));
      expect(e?.type, `seed ${seed}`).toBe("boardgame.tiebreak");
      const p = e!.payload as Record<string, unknown>;
      if (Object.hasOwn(p, "score")) expect(typeof p.score, `seed ${seed}`).toBe("string"); // never an undefined key
      expect(boardgame.outcome(fold(ko, [...drawn, ev(3, e!.type, p)]))?.kind, `seed ${seed}`).toBe("win"); // accepted
      seen.rung.add(String(p.rung));
      seen.winner.add(String(p.winner));
      seen.score.add(typeof p.score === "string" ? p.score : "(none)");
      checked++;
    }
    expect(checked).toBe(200);
    expect([...seen.rung].sort()).toEqual([...TIEBREAK_RUNGS].sort());
    expect([...seen.winner].sort()).toEqual([A, H].sort());
    expect(seen.score.has("(none)")).toBe(true);
    expect(seen.score.size).toBeGreaterThanOrEqual(3); // absent, and at least two distinct chess scores
  });

  it("rule 10: any sequence of results, tie-breaks, settles, abandons and void-last in a bracket keeps the invariants after every step", () => {
    // Invariants after every step: (a) a bracket game never folds to a draw; (b) phase tiebreak ⇔ awaitingDecider, and
    // there the module decides nothing — the outcome is a settle's or none; (c) a tie-break win names the last active tie-break's rung and winner; (d) a refused
    // step leaves the fold byte-equal, with a code from the closed set below.
    const REFUSALS = new Set(["TIEBREAK_NOT_APPLICABLE", "ALREADY_DECIDED", "SETTLE_NOT_APPLICABLE", "WRONG_PHASE"]);
    const step = fc.oneof(
      fc.record({ k: fc.constant("draw" as const), method: fc.constantFrom("agreement", "stalemate", "double_forfeit") }),
      fc.record({ k: fc.constant("win" as const), side: fc.constantFrom(H, A) }),
      fc.record({ k: fc.constant("tiebreak" as const), rung: fc.constantFrom(...TIEBREAK_RUNGS), side: fc.constantFrom(H, A) }),
      fc.record({ k: fc.constant("settle" as const), side: fc.constantFrom(H, A) }),
      fc.constant({ k: "abandon" as const }),
      fc.constant({ k: "voidLast" as const }),
    );
    const live = (events: readonly EventEnvelope[]) => events.filter((e) => e.type !== "core.void" && !events.some((v) => v.voids === e.id));
    const counts = { steps: 0, refused: 0, tiebreakWins: 0, pending: 0 };
    fc.assert(fc.property(fc.array(step, { maxLength: 10 }), (steps) => {
      const events: EventEnvelope[] = [ev(1, "core.start")];
      const run = (es: EventEnvelope[]) => foldMatchWithStoppage(boardgame, ko as never, lineups, es);
      for (const s of steps) {
        const seq = events.length + 1;
        const candidate =
          s.k === "draw" ? ev(seq, "boardgame.result", { winner: null, method: s.method })
          : s.k === "win" ? ev(seq, "boardgame.result", { winner: s.side, method: "resign" })
          : s.k === "tiebreak" ? ev(seq, "boardgame.tiebreak", { rung: s.rung, winner: s.side })
          : s.k === "settle" ? ev(seq, "core.settle", { winner: s.side, method: "lot" })
          : s.k === "abandon" ? ev(seq, "core.abandon", { reason: "r" })
          : (() => { const t = live(events).at(-1); return t === undefined || t.seq <= 1 ? null : ev(seq, "core.void", {}, t.id); })();
        if (candidate === null) continue;
        const before = JSON.stringify(run(events));
        try { run([...events, candidate]); events.push(candidate); } catch (e) {
          if (!EngineError.is(e)) throw e;
          expect(REFUSALS.has(e.code), e.code).toBe(true); // (d)
          expect(JSON.stringify(run(events))).toBe(before); // (d)
          counts.refused++;
        }
        const f = run(events);
        const o = outcomeOf(boardgame, f);
        expect(o?.kind).not.toBe("draw"); // (a)
        expect(boardgame.awaitingDecider!(f.state)).toBe(f.state.phase === "tiebreak"); // (b)
        if (f.state.phase === "tiebreak") { // (b): the module decides nothing there; only a settle (lots) can
          expect(boardgame.outcome(f.state)).toBeNull();
          expect(o === null).toBe(f.settlement === null);
          counts.pending++;
        }
        if (o?.kind === "win" && o.method?.startsWith("tiebreak_")) { // (c)
          const last = live(events).filter((e) => e.type === "boardgame.tiebreak").at(-1)!;
          const p = last.payload as { rung: string; winner: string };
          expect(o).toEqual({ kind: "win", winner: p.winner, loser: p.winner === H ? A : H, method: `tiebreak_${p.rung}` });
          counts.tiebreakWins++;
        }
        counts.steps++;
      }
    }), { numRuns: 300 });
    expect(counts.steps).toBeGreaterThan(0);
    expect(counts.refused).toBeGreaterThan(0);
    expect(counts.tiebreakWins).toBeGreaterThan(0);
    expect(counts.pending).toBeGreaterThan(0);
  });
});
