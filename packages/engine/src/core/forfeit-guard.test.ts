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
import { onePlayEvent } from "../testkit/play-event.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const errOf = (f: () => unknown): EngineError => { try { f(); } catch (e) { if (EngineError.is(e)) return e; throw e; } throw new Error("expected an EngineError, got none"); };
const firstCfg = (m: (typeof builtinModules)[number]) => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
const mod = (key: string) => { const m = builtinModules.find((x) => x.key === key); if (!m) throw new Error(`no module ${key}`); return m; };
/** Appendix A X-RS-1 as amended by ruling 112: a walkover is "before anything is played" — a Start with no sport event
 *  after it is still before play — and chess also once its game is under way (FIDE Laws 6.7.1). */
const walkoverAfterPlayAllowed = (key: string) => key === "boardgame";
/** The sport's own play after the start: its generator's first undecided sport event, under the first cfg or the bracket
 *  deciders over it (chess: a plain game's one event decides it; under the deciders a draw is held for its tie-break). */
const playedScene = (m: (typeof builtinModules)[number]) => {
  const l = defaultLineupPair(m.positions);
  const base = firstCfg(m);
  for (const cfg of [base, m.configSchema.parse({ ...(base as object), ...m.bracketDeciders(base as never) })]) {
    const played = onePlayEvent(m, cfg, l, [ev(1, "core.start")]);
    if (played !== null) return { cfg, l, played };
  }
  throw new Error(`${m.key}: its generator draws no undecided sport event after the start`);
};

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
  // GN-AB-1 (plan D16) gave generic the "abandoned" phase; it reads "over" as boardgame's always has (plan premise 20) —
  // a forfeit over an active abandon is the kernel's X-AB-4 refusal, and the console's dialog reads this hook directly.
  generic: { pre: "pre", live: "play", done: "over", final: "over", abandoned: "over" },
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

  it("X-RS-1 (rulings 112, 113): 11 sports × 4 reasons × {before the start, after a bare start, after the sport's own play}, plus both sides — each refusal and each acceptance", () => {
    // Ruling 112: a walkover (and a double walkover) reads "pre" while nothing is played after the start; once the
    // sport's own event is played it is refused, except where the module declares a walkover in that phase (chess,
    // whose tie-break phase never takes both sides, R3). Disqualified: once the Start is pressed (R4). Retired: only
    // once something is played (ruling 113: nothing played means not started) — where the module declares its Start
    // play (ruling 118, chess), from the Start.
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const A = l.away.entrantId;
      const phaseAfterPlay = m.forfeitPhase(foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), played]).state);
      for (const at of ["before", "bare start", "after play"] as const) {
        const prefix = at === "before" ? [] : at === "bare start" ? [ev(1, "core.start")] : [ev(1, "core.start"), played];
        const n = prefix.length + 1;
        const walkoverAllowed = at !== "after play" || walkoverAfterPlayAllowed(m.key);
        for (const reason of FORFEIT_REASONS) {
          const allowed =
            reason === "withdrew" ||
            (reason === "walkover" ? walkoverAllowed : reason === "retired" ? at === "after play" || (at === "bare start" && m.startIsPlay === true) : at !== "before");
          const run = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: A, reason })]);
          expect(codeOf(run), `${m.key} ${reason} ${at}`).toBe(allowed ? null : "FORFEIT_REASON_WRONG_PHASE");
          if (allowed) expect(outcomeOf(m as never, run() as never), `${m.key} ${reason} ${at}`).toEqual({ kind: "award", winner: l.home.entrantId, loser: A, reason });
          checked++;
        }
        const both = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: "both", reason: "walkover" })]);
        const bothAllowed = walkoverAllowed && !(at === "after play" && phaseAfterPlay === "tiebreak");
        expect(codeOf(both), `${m.key} both ${at}`).toBe(bothAllowed ? null : "FORFEIT_REASON_WRONG_PHASE");
        if (bothAllowed) expect(outcomeOf(m as never, both() as never), `${m.key} both ${at}`).toEqual({ kind: "double_walkover" });
        checked++;
      }
    });
    expect(checked).toBe(11 * 3 * (FORFEIT_REASONS.length + 1));
  });

  it("X-RS-1 (ruling 112): the refusal names the phase and the reasons that phase allows — a double walkover once something is played (the §7 copy reads EngineError.data)", () => {
    // Generic stands for every sport here: the data shape is the kernel's, and the sweep above proves each sport's
    // phase. The allowed list is Appendix A X-RS-1's as amended by ruling 112, in FORFEIT_REASONS order.
    const m = mod("generic");
    const { cfg, l, played } = playedScene(m);
    const before = errOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]));
    expect(before.code).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(before.data).toMatchObject({ eventId: "e-1", phase: "pre", reason: "retired", allowed: ["walkover", "withdrew"] });
    const after = errOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), played, ev(3, "core.forfeit", { by: "both", reason: "walkover" })]));
    expect(after.data).toMatchObject({ eventId: "e-3", phase: "play", reason: "walkover", allowed: ["retired", "disqualified", "withdrew"] });
    // The positive pair (ruling 112): the same double walkover after a bare start is recorded, not refused.
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), ev(2, "core.forfeit", { by: "both", reason: "walkover" })]))).toBeNull();
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

  it("C17 + ruling 112: a FoldableModule that declares no forfeitPhase is judged from the stream — pre until core.start, play after, and a walkover until something is played", () => {
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
    // Ruling 112: a bare start is still before play for a walkover; the fake's own (non-core) event is play.
    expect(run([ev(1, "core.start"), ev(2, "core.forfeit", { by: "A", reason: "walkover" })])).toBeNull();
    expect(run([ev(1, "core.start"), ev(2, "fake.point"), ev(3, "core.forfeit", { by: "A", reason: "walkover" })])).toBe("FORFEIT_REASON_WRONG_PHASE");
    // Ruling 113: a retirement needs the fake's own event played; a disqualification only the Start.
    expect(run([ev(1, "core.start"), ev(2, "core.forfeit", { by: "A", reason: "retired" })])).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(run([ev(1, "core.start"), ev(2, "fake.point"), ev(3, "core.forfeit", { by: "A", reason: "retired" })])).toBeNull();
    expect(run([ev(1, "core.start"), ev(2, "core.forfeit", { by: "A", reason: "disqualified" })])).toBeNull();
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
  it("X-AB-4 (rulings 112, 113): void-then-forfeit is allowed — after play a retirement is credited and a walkover refused; with nothing played a walkover is admitted and a retirement refused", () => {
    const m = builtinModules.find((x) => x.key === "generic")!;
    const { cfg, l, played } = playedScene(m);
    const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), ev(3, "core.void", {}, "e-2")];
    // Ruling 112: the abandon is the kernel's, not play — with it voided, nothing was played.
    const walkover = foldMatchWithStoppage(m as never, cfg as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]);
    expect(outcomeOf(m as never, walkover as never)).toMatchObject({ kind: "award", reason: "walkover" });
    // Ruling 113: and nobody retires from a match never played.
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
    // The pair: the sport's own event before the abandon is play, so the retirement is credited and the walkover refused.
    const playedBase = [ev(1, "core.start"), { ...played, seq: 2, id: "e-2" }, ev(3, "core.abandon", { reason: "rain" }), ev(4, "core.void", {}, "e-3")];
    const ok = foldMatchWithStoppage(m as never, cfg as never, l, [...playedBase, ev(5, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
    expect(outcomeOf(m as never, ok as never)).toMatchObject({ kind: "award", reason: "retired" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...playedBase, ev(5, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
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
    // `withdrew` forfeit), settle/finalize after each, and (ruling 112) a walkover after a bare start and after the
    // sport's own play. Three sports: one with a decider phase (boardgame), one
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
      // Ruling 112: the sport's own play, undecided — its generator's, after whatever the ledger holds.
      fc.constant({ t: "play" as const }),
    );
    let accepted = 0;
    let forfeitsAccepted = 0;
    let levelWithdrawals = 0;
    let doubleWalkovers = 0;
    let awards = 0;
    let walkoversChecked = 0;
    let walkoversAfterBareStart = 0;
    let walkoversRefusedAfterPlay = 0;
    let playsAccepted = 0;
    /** Ruling 112, read here from the ACTIVE ledger: a module-owned (non-`core.`) event after an active start. */
    const playedIn = (active: readonly EventEnvelope[]) => {
      const at = active.findIndex((x) => x.type === "core.start");
      return at >= 0 && active.slice(at + 1).some((x) => !x.type.startsWith("core."));
    };
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
          : s.t === "play" ? (() => { try { const p = onePlayEvent(m, cfg, l, ledger); return p === null ? [] : [p]; } catch { return []; } })()
          : ledger.length > 0 ? [ev(seq, "core.void", {}, ledger[ledger.length - 1]!.id)] : [];
        for (const candidate of candidates) {
          const e = { ...candidate, seq: ledger.length + 1, id: `e-${ledger.length + 1}` };
          const before = ledger.length > 0 ? outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, ledger) as never) : null;
          const activeBefore = resolveVoids(ledger);
          let f;
          try { f = foldMatchWithStoppage(m as never, cfg as never, l, [...ledger, e], { strictFromSeq: e.seq }); } catch (err) {
            if (!EngineError.is(err)) throw err;
            if (err.code === "FORFEIT_REASON_WRONG_PHASE" && (e.payload as { reason?: string }).reason === "walkover" && playedIn(activeBefore)) walkoversRefusedAfterPlay++;
            break;
          }
          ledger.push(e);
          accepted++;
          if (!e.type.startsWith("core.")) playsAccepted++;
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
            // … and an accepted walkover never follows the sport's own play after an active start (ruling 112: a bare
            // start, or one followed only by kernel events, is still before play), unless the module declares a walkover
            // phase past "pre" (chess, FIDE Laws 6.7.1).
            if (p.reason === "walkover" && m.walkoverPhases === undefined) {
              expect(playedIn(activeBefore), `walkover after play: ${JSON.stringify(ledger.map((x) => x.type))}`).toBe(false);
              walkoversChecked++;
              if (activeBefore.some((x) => x.type === "core.start")) walkoversAfterBareStart++;
            }
            if (p.reason === "withdrew" && before !== null && ["draw", "tie", "no_result"].includes(before.kind)) {
              levelWithdrawals++;
              expect(o).toMatchObject({ kind: "award", reason: "withdrew" });
            }
          }
        }
      }
    }), {
      numRuns: 400,
      seed: 20261009,
      // Ruling 112's two sequences, in every sport, whatever the random draw reaches: a walkover after a bare start, and
      // one after the sport's own play (refused, but chess) — then the random runs.
      examples: keys.flatMap((k) => [
        [k, [{ t: "start" }, { t: "forfeit", by: "A", reason: "walkover" }]],
        [k, [{ t: "start" }, { t: "play" }, { t: "forfeit", by: "A", reason: "walkover" }]],
      ] as const).map(([k, s]) => [k, [...s]] as never),
    });
    expect(accepted).toBeGreaterThan(0);
    expect(forfeitsAccepted).toBeGreaterThan(0);
    expect(levelWithdrawals).toBeGreaterThan(0); // the PF-1 path is reached, not just declared
    expect([doubleWalkovers, awards, walkoversChecked].every((n) => n > 0), `dw ${doubleWalkovers} awards ${awards} walkovers ${walkoversChecked}`).toBe(true);
    // Ruling 112's two sides are both reached: a walkover recorded after a bare start, and one refused after play.
    expect([walkoversAfterBareStart, walkoversRefusedAfterPlay].every((n) => n > 0), `after a bare start ${walkoversAfterBareStart}, refused after play ${walkoversRefusedAfterPlay}, sport events accepted ${playsAccepted}`).toBe(true);
  });

  it("Loop R M-15: a forfeit carrying an undeclared key never folds — INVALID_EVENT in every sport, where the same forfeit without it is the walkover (ruling 112: after a bare start)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const forfeit = { by: l.away.entrantId, reason: "walkover" };
      const fold = (payload: unknown) => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.forfeit", payload)]);
      expect(outcomeOf(m as never, fold(forfeit) as never), `${m.key}: the positive pair`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "walkover" });
      expect(codeOf(() => fold({ ...forfeit, note: "late" })), m.key).toBe("INVALID_EVENT");
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
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
