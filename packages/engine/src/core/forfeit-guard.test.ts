// W2b (spec §5.1; plan D3–D6, PF-1). The kernel's forfeit guards: the phase guard (D3), the abandon guard (D4), the
// expunge flag (D5), the legacy settle (D6) and the withdrew-over-a-held-level admission (PF-1). Every expectation is
// the rule table's own (Appendix A X-RS-1, X-AB-4, X-WD-1), written out here — never read back from the guard.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, kernelOwnsEvent, outcomeOf, resolveVoids, type EventEnvelope, type FoldableModule } from "./events.ts";
import { FORFEIT_REASONS, OUTCOME_KINDS, type ForfeitPhase, type MatchOutcome } from "./types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const errOf = (f: () => unknown): EngineError => { try { f(); } catch (e) { if (EngineError.is(e)) return e; throw e; } throw new Error("expected an EngineError, got none"); };
const firstCfg = (m: (typeof builtinModules)[number]) => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
const mod = (key: string) => { const m = builtinModules.find((x) => x.key === key); if (!m) throw new Error(`no module ${key}`); return m; };
/** Appendix A X-RS-1: a walkover is "before play started", and chess also after the session starts (FIDE Laws 6.7.1). */
const walkoverAfterStartAllowed = (key: string) => key === "boardgame";

/** Task 3's table ("Each module's forfeitPhase"), written out per sport — never read back from the module. The period
 *  kernel's phase is a free label, so it is sampled (two play labels per sport plus the shoot-out). Ruling 102 Q5: a
 *  football or period shoot-out and a cricket super over are PLAY. */
const LIVE_UNION: Record<string, ForfeitPhase> = { pre: "pre", live: "play", done: "over", final: "over", abandoned: "over" };
const PHASE_TABLE: Record<string, Record<string, ForfeitPhase>> = {
  football: { pre: "pre", H1: "play", H2: "play", Q2: "play", Q3: "play", Q4: "play", ET_H1: "play", ET_H2: "play", SHOOTOUT: "play", done: "over", final: "over", abandoned: "over" },
  hockey: { pre: "pre", Q1: "play", Q4: "play", SHOOTOUT: "play", done: "over", final: "over", abandoned: "over" },
  icehockey: { pre: "pre", P1: "play", OT: "play", SHOOTOUT: "play", done: "over", final: "over", abandoned: "over" },
  volleyball: LIVE_UNION,
  badminton: LIVE_UNION,
  tabletennis: LIVE_UNION,
  tennis: LIVE_UNION,
  carrom: LIVE_UNION,
  cricket: { pre: "pre", live: "play", super_over: "play", done: "over", final: "over" },
  boardgame: { pre: "pre", live: "play", tiebreak: "tiebreak", done: "over", final: "over", abandoned: "over" },
  generic: { pre: "pre", live: "play", done: "over", final: "over" },
};

describe("D3: each module reads its own phase union (Task 3 table; ruling 102 Q5)", () => {
  it("D3: forfeitPhase classifies every phase of every sport as the table says — a shoot-out and a super over are play", () => {
    let rows = 0;
    const sports = forEachSport(({ module: m }) => {
      const table = PHASE_TABLE[m.key];
      expect(table, `${m.key} has no row in the table`).toBeDefined();
      const l = defaultLineupPair(m.positions);
      const init = m.init(firstCfg(m) as never, l) as Record<string, unknown>;
      for (const [phase, want] of Object.entries(table!)) {
        expect(m.forfeitPhase({ ...init, phase }), `${m.key} ${phase}`).toBe(want);
        rows++;
      }
      // Only boardgame widens the walkover phases (plan D3 R2); every other module leaves the default.
      expect(m.walkoverPhases, m.key).toEqual(m.key === "boardgame" ? ["pre", "play", "tiebreak"] : undefined);
    });
    expect(sports).toBe(11);
    expect(Object.keys(PHASE_TABLE).sort()).toEqual(builtinModules.map((m) => m.key).sort());
    expect(rows).toBe(Object.values(PHASE_TABLE).reduce((n, t) => n + Object.keys(t).length, 0));
  });
});

describe("X-RS-1 phase guard (spec §5.1; D3)", () => {
  it("empty case first: a stream with no forfeit folds exactly as before (no guard fires)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start")])), m.key).toBeNull();
      checked++;
    });
    expect(checked).toBe(11);
  });

  it("X-RS-1: 11 sports × 4 reasons × {before, after start}, plus both sides — each refusal and each acceptance", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const A = l.away.entrantId;
      for (const started of [false, true]) {
        const prefix = started ? [ev(1, "core.start")] : [];
        const n = prefix.length + 1;
        for (const reason of FORFEIT_REASONS) {
          const allowed = reason === "withdrew" || (reason === "walkover" ? !started || walkoverAfterStartAllowed(m.key) : started);
          const run = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: A, reason })]);
          expect(codeOf(run), `${m.key} ${reason} ${started ? "after" : "before"} start`).toBe(allowed ? null : "FORFEIT_REASON_WRONG_PHASE");
          if (allowed) expect(outcomeOf(m as never, run() as never), `${m.key} ${reason}`).toEqual({ kind: "award", winner: l.home.entrantId, loser: A, reason });
          checked++;
        }
        const both = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: "both", reason: "walkover" })]);
        const bothAllowed = !started || walkoverAfterStartAllowed(m.key);
        expect(codeOf(both), `${m.key} both ${started ? "after" : "before"} start`).toBe(bothAllowed ? null : "FORFEIT_REASON_WRONG_PHASE");
        if (bothAllowed) expect(outcomeOf(m as never, both() as never)).toEqual({ kind: "double_walkover" });
        checked++;
      }
    });
    expect(checked).toBe(11 * 2 * (FORFEIT_REASONS.length + 1));
  });

  it("X-RS-1: the refusal names the phase and the reasons that phase allows (the §7 copy reads EngineError.data)", () => {
    // Generic stands for every sport here: the data shape is the kernel's, and the sweep above proves each sport's
    // phase. The allowed list is Appendix A X-RS-1's, in FORFEIT_REASONS order.
    const m = mod("generic");
    const l = defaultLineupPair(m.positions);
    const before = errOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]));
    expect(before.code).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(before.data).toMatchObject({ eventId: "e-1", phase: "pre", reason: "retired", allowed: ["walkover", "withdrew"] });
    const after = errOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.forfeit", { by: "both", reason: "walkover" })]));
    expect(after.data).toMatchObject({ eventId: "e-2", phase: "play", reason: "walkover", allowed: ["retired", "disqualified", "withdrew"] });
  });

  it("X-RS-1: free text, an unknown reason, and both with a non-walkover reason are INVALID_EVENT (schema; W2b-FP-1)", () => {
    const m = builtinModules.find((x) => x.key === "generic")!;
    const l = defaultLineupPair(m.positions);
    for (const payload of [{ by: l.away.entrantId, reason: "no-show" }, { by: l.away.entrantId, reason: "bye" }, { by: "both", reason: "retired" }, { by: l.away.entrantId }]) {
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.forfeit", payload)])), JSON.stringify(payload)).toBe("INVALID_EVENT");
    }
  });

  it("BG-WO-3: chess tie-break pending — one side's walkover or withdrew is accepted, both is refused (R14)", () => {
    const m = builtinModules.find((x) => x.key === "boardgame")!;
    const cfg = m.configSchema.parse({ tiebreak: true });
    const l = defaultLineupPair(m.positions);
    const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
    for (const reason of ["walkover", "withdrew"] as const) {
      const f = foldMatchWithStoppage(m as never, cfg as never, l, [...drawn, ev(3, "core.forfeit", { by: l.away.entrantId, reason })]);
      expect(outcomeOf(m as never, f as never)).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason });
    }
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...drawn, ev(3, "core.forfeit", { by: "both", reason: "walkover" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
  });

  it("C17: a FoldableModule that declares no forfeitPhase is judged from the stream — pre until core.start, play after", () => {
    // A hand-built fake (the core tests' shape), not a sport: the fallback exists only for modules outside the
    // registry, since SportModule makes the hook required. Without it a fake would escape D3 silently.
    interface S { started: boolean; outcome: MatchOutcome | null }
    const fake: FoldableModule<unknown, S> = {
      init: () => ({ started: false, outcome: null }),
      apply: (s, e) => {
        if (e.type === "core.start") return { ...s, started: true };
        if (e.type === "core.forfeit") {
          const p = e.payload as { by: string; reason: "walkover" };
          return { ...s, outcome: p.by === "both" ? { kind: "double_walkover" } : { kind: "award", winner: p.by === "H" ? "A" : "H", loser: p.by, reason: p.reason } };
        }
        return s;
      },
      outcome: (s) => s.outcome,
    };
    const l = defaultLineupPair(mod("generic").positions);
    const run = (events: EventEnvelope[]) => codeOf(() => foldMatchWithStoppage(fake, {}, l, events));
    expect(run([ev(1, "core.forfeit", { by: "A", reason: "walkover" })])).toBeNull();
    expect(run([ev(1, "core.forfeit", { by: "A", reason: "retired" })])).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(run([ev(1, "core.start"), ev(2, "core.forfeit", { by: "A", reason: "walkover" })])).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(run([ev(1, "core.start"), ev(2, "core.forfeit", { by: "A", reason: "retired" })])).toBeNull();
    // A voided start is no start (voids resolve first).
    expect(run([ev(1, "core.start"), ev(2, "core.void", {}, "e-1"), ev(3, "core.forfeit", { by: "A", reason: "walkover" })])).toBeNull();
  });
});

describe("X-AB-4 abandon guard (D4)", () => {
  it("X-AB-4: a forfeit while an abandon is active is ABANDONED_SETTLE_OR_VOID in every sport that records an abandon — even where the abandon decided the match", () => {
    let checked = 0;
    const refusesAbandon: string[] = []; // a module whose own apply refuses core.abandon cannot reach the guard; listed, never silently dropped
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
      if (codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, base)) !== null) { refusesAbandon.push(m.key); return; }
      const stream = [...base, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "retired" })];
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, stream)), m.key).toBe("ABANDONED_SETTLE_OR_VOID");
      checked++;
    });
    expect(refusesAbandon).toEqual([]); // re-pin: `git grep -n '"core.abandon"' -- packages/engine/src/sports`; a sport listed here is a finding for the report, and this line then names it
    const fb = builtinModules.find((x) => x.key === "football")!;
    const l = defaultLineupPair(fb.positions);
    const awardCfg = fb.configSchema.parse({ abandonPolicy: "award" });
    const decided = [ev(1, "core.start"), ev(2, "football.goal", { by: l.home.entrantId }), ev(3, "core.abandon", { reason: "rain" }), ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })];
    expect(codeOf(() => foldMatchWithStoppage(fb as never, awardCfg as never, l, decided))).toBe("ABANDONED_SETTLE_OR_VOID"); // not ALREADY_DECIDED: the guard sits above guarantee 4
    expect(checked + refusesAbandon.length).toBe(11);
    expect(checked).toBeGreaterThan(0);
  });
  it("M-6: abandon → settle → forfeit is ALREADY_DECIDED — the settle decided it, so 'settle it' is not the guidance — every sport", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const abandoned = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
      const settled = [...abandoned, ev(3, "core.settle", { winner: l.home.entrantId, method: "lot" })];
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, settled)), `${m.key} settle`).toBeNull();
      for (const reason of ["walkover", "retired", "disqualified", "withdrew"] as const) {
        const forfeit = ev(4, "core.forfeit", { by: l.away.entrantId, reason });
        expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...settled, forfeit])), `${m.key} ${reason}`).toBe("ALREADY_DECIDED");
        // positive pair: with no settle, the same forfeit is still the abandon guard's
        expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...abandoned, { ...forfeit, seq: 3, id: "e-3" }])), `${m.key} ${reason} unsettled`).toBe("ABANDONED_SETTLE_OR_VOID");
        checked++;
      }
    });
    expect(checked).toBe(44);
  });
  it("X-AB-4: void-then-forfeit is allowed and credited as a retirement; a walkover after the void is refused (play started)", () => {
    const m = builtinModules.find((x) => x.key === "generic")!;
    const l = defaultLineupPair(m.positions);
    const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), ev(3, "core.void", {}, "e-2")];
    const ok = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
    expect(outcomeOf(m as never, ok as never)).toMatchObject({ kind: "award", reason: "retired" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
  });
});

/** A level result per sport that can end level (set-based sports and tennis never draw — supportsDraws is false for
 *  them — so the held-level admission is unreachable there by construction). */
const LEVEL: Record<string, { cfg: unknown; events: (seq0: number) => EventEnvelope[] }> = {
  football: { cfg: {}, events: (s) => [ev(s, "football.period", { phase: "HT" }), ev(s + 1, "football.period", { phase: "FT" })] },
  boardgame: { cfg: {}, events: (s) => [ev(s, "boardgame.result", { winner: null, method: "agreement" })] },
  generic: { cfg: { resultMode: "score", allowDraws: true }, events: (s) => [ev(s, "generic.result", { p1Score: 1, p2Score: 1 })] },
};

describe("PF-1 / X-WD-1: withdrew over a held level result (kernel-owned admission)", () => {
  it("X-WD-1: a withdrawal over a level result is walked over to the other side, reason withdrew; walkover, retired and disqualified there stay ALREADY_DECIDED", () => {
    let checked = 0;
    for (const [key, row] of Object.entries(LEVEL)) {
      const m = mod(key);
      const cfg = m.configSchema.parse(row.cfg);
      const l = defaultLineupPair(m.positions);
      const level = [ev(1, "core.start"), ...row.events(2)];
      const n = level.length + 1;
      const held = foldMatchWithStoppage(m as never, cfg as never, l, level);
      expect(["draw", "tie", "no_result"], key).toContain(outcomeOf(m as never, held as never)?.kind); // the precondition, not assumed
      const f = foldMatchWithStoppage(m as never, cfg as never, l, [...level, ev(n, "core.forfeit", { by: l.away.entrantId, reason: "withdrew" })], { strictFromSeq: n });
      expect(outcomeOf(m as never, f as never), key).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "withdrew" });
      for (const reason of ["walkover", "retired", "disqualified"] as const) {
        expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...level, ev(n, "core.forfeit", { by: l.away.entrantId, reason })])), `${key} ${reason}`).toBe("ALREADY_DECIDED");
      }
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-WD-1: the admission is one-shot and only over a LEVEL, UNSETTLED result — a second withdrew, a withdrew after a settle and a withdrew over a win are ALREADY_DECIDED", () => {
    const m = mod("generic");
    const cfg = m.configSchema.parse(LEVEL.generic!.cfg);
    const l = defaultLineupPair(m.positions);
    const [H, A] = [l.home.entrantId, l.away.entrantId];
    const level = [ev(1, "core.start"), ...LEVEL.generic!.events(2)];
    const wd = (seq: number, by: string) => ev(seq, "core.forfeit", { by, reason: "withdrew" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...level, wd(3, A), wd(4, H)]))).toBe("ALREADY_DECIDED");
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...level, ev(3, "core.settle", { winner: H, method: "lot" }), wd(4, A)]))).toBe("ALREADY_DECIDED");
    const won = [ev(1, "core.start"), ev(2, "generic.result", { p1Score: 2, p2Score: 1 })];
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...won, wd(3, A)]))).toBe("ALREADY_DECIDED");
    // After the withdrawal the fixture is decided: a settle is refused, a finalize is accepted.
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...level, wd(3, A), ev(4, "core.settle", { winner: H, method: "lot" })]))).toBe("SETTLE_NOT_APPLICABLE");
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...level, wd(3, A), ev(4, "core.finalize")]))).toBeNull();
    // Voiding the withdrawal restores the held level result.
    const voided = foldMatchWithStoppage(m as never, cfg as never, l, [...level, wd(3, A), ev(4, "core.void", {}, "e-3")]);
    expect(outcomeOf(m as never, voided as never)).toEqual({ kind: "draw" });
  });

  it("X-WD-1: kernelOwnsEvent names the admitted withdrawal, so no replay loop outside the engine forwards it to a module that would refuse it", () => {
    const m = mod("generic");
    const cfg = m.configSchema.parse(LEVEL.generic!.cfg);
    const l = defaultLineupPair(m.positions);
    const held = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), ...LEVEL.generic!.events(2)]);
    const wd = ev(3, "core.forfeit", { by: l.away.entrantId, reason: "withdrew" });
    expect(kernelOwnsEvent(m as never, wd, { state: held.state, settled: false })).toBe(true);
    // The negative pairs: a walkover is the module's (and refused); a settled fixture owns nothing new; a live one neither.
    expect(kernelOwnsEvent(m as never, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "walkover" }), { state: held.state, settled: false })).toBe(false);
    expect(kernelOwnsEvent(m as never, wd, { state: held.state, settled: true })).toBe(false);
    const live = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start")]);
    expect(kernelOwnsEvent(m as never, wd, { state: live.state, settled: false })).toBe(false);
  });
});

describe("D5 expunge, D6 legacy settle", () => {
  it("D5: an expunge abandon folds to no outcome in every sport; a plain abandon keeps its sport's outcome", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const f = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.abandon", { reason: "withdrew", expunge: true })]);
      expect(f.expunged, m.key).toBe(true);
      expect(outcomeOf(m as never, f as never), m.key).toBeNull();
      const plain = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]);
      expect(plain.expunged, m.key).toBe(false);
      expect(outcomeOf(m as never, plain as never), m.key).toEqual(m.outcome(plain.state));
      checked++;
    });
    expect(checked).toBe(11);
  });
  it("D5: expunged is false with no abandon, and a void of the expunge abandon clears it", () => {
    const m = mod("generic");
    const l = defaultLineupPair(m.positions);
    expect(foldMatchWithStoppage(m as never, firstCfg(m) as never, l, []).expunged).toBe(false);
    const voided = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.abandon", { reason: "x", expunge: true }), ev(3, "core.void", {}, "e-2")]);
    expect(voided.expunged).toBe(false);
    expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.abandon", { reason: "x", expunge: false })]))).toBe("INVALID_EVENT"); // expunge is `true` or absent
  });
  it("D5: a settle over an expunged abandon is refused in every sport; over a plain abandon it is admitted (the positive pair)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const settle = ev(3, "core.settle", { winner: l.home.entrantId, method: "lot" });
      const expunged = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "withdrew", expunge: true }), settle];
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, expunged, { strictFromSeq: 3 })), m.key).toBe("SETTLE_NOT_APPLICABLE");
      const plain = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), settle];
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, plain, { strictFromSeq: 3 })), m.key).toBeNull();
      checked++;
    });
    expect(checked).toBe(11);
  });
  it("D6: a legacy settled chess double forfeit replays (the settlement wins); a strict write of the same settle is refused", () => {
    const m = builtinModules.find((x) => x.key === "boardgame")!;
    const cfg = m.configSchema.parse({ tiebreak: true });
    const l = defaultLineupPair(m.positions);
    const s = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" }), ev(3, "core.settle", { winner: l.home.entrantId, method: "lot" })];
    expect(outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, s) as never)).toEqual({ kind: "win", winner: l.home.entrantId, loser: l.away.entrantId, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, s, { strictFromSeq: 3 }))).toBe("SETTLE_NOT_APPLICABLE");
  });
});

describe("rule 10: forfeit, abandon, void and settle in any order (spec §9 sequences)", () => {
  it("every accepted prefix keeps the invariants; refused writes never enter the ledger", () => {
    // The alphabet reaches every sequence Global Constraints names for the fold: forfeit after abandon, void then
    // forfeit, double walkover then void, a second forfeit, withdrew over a held level result (`level` then a
    // `withdrew` forfeit), and settle/finalize after each. Three sports: one with a decider phase (boardgame), one
    // with an award-policy abandon and periods (football), and the fallback module (generic) — each can end level.
    const keys = ["generic", "boardgame", "football"] as const;
    const step = fc.oneof(
      fc.constant({ t: "start" as const }),
      fc.record({ t: fc.constant("forfeit" as const), by: fc.constantFrom("H", "A", "both"), reason: fc.constantFrom(...FORFEIT_REASONS) }),
      fc.record({ t: fc.constant("abandon" as const), expunge: fc.boolean() }),
      fc.constant({ t: "voidLast" as const }),
      fc.record({ t: fc.constant("settle" as const), who: fc.constantFrom("H", "A") }),
      fc.constant({ t: "level" as const }),
      fc.constant({ t: "finalize" as const }),
    );
    let accepted = 0;
    let forfeitsAccepted = 0;
    let levelWithdrawals = 0;
    let doubleWalkovers = 0;
    let awards = 0;
    let walkoversChecked = 0;
    fc.assert(fc.property(fc.constantFrom(...keys), fc.array(step, { maxLength: 8 }), (key, steps) => {
      const m = builtinModules.find((x) => x.key === key)!;
      const cfg = m.configSchema.parse(LEVEL[key]!.cfg);
      const l = defaultLineupPair(m.positions);
      const id = (s: string) => (s === "H" ? l.home.entrantId : s === "A" ? l.away.entrantId : s);
      const ledger: EventEnvelope[] = [];
      for (const s of steps) {
        const seq = ledger.length + 1;
        const candidates: EventEnvelope[] = s.t === "start" ? [ev(seq, "core.start")]
          : s.t === "forfeit" ? [ev(seq, "core.forfeit", { by: id(s.by), reason: s.reason })]
          : s.t === "abandon" ? [ev(seq, "core.abandon", s.expunge ? { reason: "x", expunge: true } : { reason: "x" })]
          : s.t === "settle" ? [ev(seq, "core.settle", { winner: id(s.who), method: "lot" })]
          : s.t === "level" ? LEVEL[key]!.events(seq)
          : s.t === "finalize" ? [ev(seq, "core.finalize")]
          : ledger.length > 0 ? [ev(seq, "core.void", {}, ledger[ledger.length - 1]!.id)] : [];
        for (const candidate of candidates) {
          const e = { ...candidate, seq: ledger.length + 1, id: `e-${ledger.length + 1}` };
          const before = ledger.length > 0 ? outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, ledger) as never) : null;
          const activeBefore = resolveVoids(ledger);
          let f;
          try { f = foldMatchWithStoppage(m as never, cfg as never, l, [...ledger, e], { strictFromSeq: e.seq }); } catch (err) { if (EngineError.is(err)) break; throw err; }
          ledger.push(e);
          accepted++;
          const o = outcomeOf(m as never, f as never);
          if (o !== null) expect(OUTCOME_KINDS).toContain(o.kind);
          // The ACTIVE forfeit (the last unvoided one) is the one that decides (M-3): a double walkover is its "both",
          // and an award's loser is its `by` — forfeit A, void, forfeit H ⇒ the loser is H (Review Focus 2).
          const activeForfeit = resolveVoids(ledger).filter((x) => x.type === "core.forfeit").at(-1)?.payload as { by: string } | undefined;
          if (o?.kind === "double_walkover") { expect(activeForfeit?.by).toBe("both"); doubleWalkovers++; }
          if (o?.kind === "award") { expect(o.loser).not.toBe(o.winner); expect(o.loser).toBe(activeForfeit?.by); awards++; }
          if (f.expunged) expect(o).toBeNull();
          // A replay of the accepted ledger reaches the same outcome as the write did (refused writes left no trace).
          expect(outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, ledger) as never)).toEqual(o);
          if (e.type === "core.forfeit") {
            forfeitsAccepted++;
            const p = e.payload as { reason: string };
            // M-3: an accepted forfeit never sits on an active abandon (D4; a settled one is ALREADY_DECIDED, M-6) …
            expect(activeBefore.some((x) => x.type === "core.abandon"), `forfeit over an active abandon: ${JSON.stringify(ledger.map((x) => x.type))}`).toBe(false);
            // … and an accepted walkover never follows an active start, unless the module declares a walkover phase
            // past "pre" (chess, FIDE Laws 6.7.1).
            if (p.reason === "walkover" && m.walkoverPhases === undefined) {
              expect(activeBefore.some((x) => x.type === "core.start"), `walkover after start: ${JSON.stringify(ledger.map((x) => x.type))}`).toBe(false);
              walkoversChecked++;
            }
            if (p.reason === "withdrew" && before !== null && ["draw", "tie", "no_result"].includes(before.kind)) {
              levelWithdrawals++;
              expect(o).toMatchObject({ kind: "award", reason: "withdrew" });
            }
          }
        }
      }
    }), { numRuns: 400, seed: 20261009 });
    expect(accepted).toBeGreaterThan(0);
    expect(forfeitsAccepted).toBeGreaterThan(0);
    expect(levelWithdrawals).toBeGreaterThan(0); // the PF-1 path is reached, not just declared
    expect([doubleWalkovers, awards, walkoversChecked].every((n) => n > 0), `dw ${doubleWalkovers} awards ${awards} walkovers ${walkoversChecked}`).toBe(true);
  });

  it("Review Focus 2 oracle: forfeit A, void it, forfeit H — the loser is H, every sport (the void restores the undecided match)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const f = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [
        ev(1, "core.forfeit", { by: l.away.entrantId, reason: "walkover" }),
        ev(2, "core.void", {}, "e-1"),
        ev(3, "core.forfeit", { by: l.home.entrantId, reason: "walkover" }),
      ]);
      expect(outcomeOf(m as never, f as never), m.key).toEqual({ kind: "award", winner: l.away.entrantId, loser: l.home.entrantId, reason: "walkover" });
      checked++;
    });
    expect(checked).toBe(11);
  });
});
