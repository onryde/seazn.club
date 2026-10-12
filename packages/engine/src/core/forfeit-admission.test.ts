// W2b Task 11 (UI-1; spec §5.5) — `forfeitAdmission`, the D3 phase guard's own answer to "what may a forfeit record
// NOW", exported so the organiser console's forfeit dialog offers exactly what the guard admits. Two halves: the rule
// rows (Appendix A X-RS-1, plan D3 R2–R5, W2b-R14 — typed here from the rules, never read back from the function), and
// a parity sweep that RUNS the guard (foldMatch) for every sport, phase, side and reason and requires the admission to
// agree with it.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatch, forfeitAdmission, playRecorded, type EventEnvelope } from "./events.ts";
import { FORFEIT_REASONS, type ForfeitPhase, type ForfeitReason } from "./types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const mod = (key: string) => { const m = builtinModules.find((x) => x.key === key); if (!m) throw new Error(`no module ${key}`); return m; };
const firstCfg = (m: (typeof builtinModules)[number]) => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
/** BG-KO-1: a drawn chess knockout game opens its tie-break (the bracket deciders' cfg). */
const chessKoCfg = () => { const m = mod("boardgame"); return m.configSchema.parse({ ...m.bracketDeciders?.(m.configSchema.parse({})) }); };
const DRAWN = { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as const;

/** The ledgers a forfeit can be judged after, per sport: before play, after the start, after the start is VOIDED (back
 *  to before play — the sequence a take-back writes), decided, and chess's pending tie-break. */
function scenes(key: string) {
  const m = mod(key);
  const l = defaultLineupPair(m.positions);
  const out: { name: string; cfg: unknown; ledger: EventEnvelope[]; phase: ForfeitPhase }[] = [
    { name: "before play", cfg: firstCfg(m), ledger: [], phase: "pre" },
    { name: "after the start", cfg: firstCfg(m), ledger: [ev(1, "core.start")], phase: "play" },
    { name: "after the start is voided", cfg: firstCfg(m), ledger: [ev(1, "core.start"), ev(2, "core.void", {}, "e-1")], phase: "pre" },
    // Ruling 113: a disqualification decides a bare-started match (a retirement needs something played).
    { name: "decided", cfg: firstCfg(m), ledger: [ev(1, "core.start"), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "disqualified" })], phase: "over" },
  ];
  if (key === "boardgame") out.push({ name: "tie-break pending", cfg: chessKoCfg(), ledger: [ev(1, "core.start"), ev(2, DRAWN.type, DRAWN.payload)], phase: "tiebreak" });
  return { m, l, out };
}

describe("forfeitAdmission — the phase guard's own answer, for the console's dialog (Task 11; X-RS-1, D3)", () => {
  it("empty case first: a decided match admits no reason and no double walkover", () => {
    const { m, l, out } = scenes("generic");
    const decided = out.find((s) => s.name === "decided")!;
    const state = foldMatch(m, decided.cfg as never, l, decided.ledger);
    expect(forfeitAdmission(m, state, { playRecorded: playRecorded(decided.ledger, m) })).toEqual({ phase: "over", reasons: [], both: false });
    // Ruling 112's fact cannot reopen a decided match: "over" admits nothing whatever was played.
    expect(forfeitAdmission(m, state, { playRecorded: true })).toEqual({ phase: "over", reasons: [], both: false });
  });

  it("X-RS-1 (rulings 112, 113) / D3 R2, R4, R5: a module with the default walkover phases admits walkover and withdrew before play; after a bare start the walkover too, beside disqualified and withdrew (never retired); once its own event is played, retired, disqualified and withdrew; a double walkover until something is played", () => {
    // Rule rows, typed: R2 walkover only in the walkover phases (default ["pre"]) — ruling 112: the phase reads "pre"
    // for a walkover while nothing is played after the start; R4 disqualified once play started (the Start); ruling
    // 113: retired only once something is played; R5 withdrew in any phase; R1/R3 "both" is a walkover, never in a
    // tie-break.
    const PRE: ForfeitReason[] = ["walkover", "withdrew"];
    const STARTED: ForfeitReason[] = ["walkover", "disqualified", "withdrew"];
    const PLAYED: ForfeitReason[] = ["retired", "disqualified", "withdrew"];
    let checked = 0;
    const sports = forEachSport(({ module: m }) => {
      if (m.key === "boardgame") return; // chess widens the walkover phases (FIDE 6.7.1, R14) — its own rows below
      const l = defaultLineupPair(m.positions);
      const cfg = firstCfg(m);
      const started = [ev(1, "core.start")];
      const played = onePlayEvent(m, cfg, l, started);
      if (played === null) throw new Error(`${m.key}: its generator draws no sport event after the start`);
      const ledgers = { pre: [], started, played: [...started, played] };
      const admitted = (ledger: EventEnvelope[]) => forfeitAdmission(m, foldMatch(m, cfg as never, l, ledger), { playRecorded: playRecorded(ledger, m) });
      expect(admitted(ledgers.pre), `${m.key} before play`).toEqual({ phase: "pre", reasons: PRE, both: true });
      expect(admitted(ledgers.started), `${m.key} after a bare start`).toEqual({ phase: "play", reasons: STARTED, both: true });
      expect(admitted(ledgers.played), `${m.key} after ${played.type}`).toEqual({ phase: "play", reasons: PLAYED, both: false });
      checked += 3;
    });
    expect(sports).toBe(builtinModules.length);
    expect(checked, `default-phase rows checked: ${checked}`).toBe(3 * (builtinModules.length - 1));
  });

  it("BG-WO-3 / W2b-R14 + ruling 118: chess admits a one-side walkover before play, in play and in a pending tie-break; a double walkover never in the tie-break; a retirement from the Start (its Start is play)", () => {
    // Single-sport: boardgame is the only module that widens walkoverPhases (FIDE Laws 6.7.1; R14) and declares its
    // Start play (ruling 118: Seazn records no moves, so a game in progress is a game played and a retirement in it is
    // recordable; ruling 113 had made it wait for the tie-break).
    const { m, l, out } = scenes("boardgame");
    const want: Record<string, { phase: ForfeitPhase; reasons: ForfeitReason[]; both: boolean }> = {
      "before play": { phase: "pre", reasons: ["walkover", "withdrew"], both: true },
      "after the start": { phase: "play", reasons: ["walkover", "retired", "disqualified", "withdrew"], both: true },
      "tie-break pending": { phase: "tiebreak", reasons: ["walkover", "retired", "disqualified", "withdrew"], both: false },
    };
    let checked = 0;
    for (const s of out) {
      if (want[s.name] === undefined) continue;
      expect(forfeitAdmission(m, foldMatch(m, s.cfg as never, l, s.ledger), { playRecorded: playRecorded(s.ledger, m) }), s.name).toEqual(want[s.name]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("parity: for every sport, phase, side and reason the admission says yes exactly when the guard records the forfeit — and a refusal in a live phase is the phase guard's", () => {
    let checked = 0;
    let admitted = 0;
    const sports = forEachSport(({ module: m }) => {
      const { l, out } = scenes(m.key);
      for (const s of out) {
        const state = foldMatch(m, s.cfg as never, l, s.ledger);
        const a = forfeitAdmission(m, state, { playRecorded: playRecorded(s.ledger, m) });
        expect(a.phase, `${m.key} ${s.name}`).toBe(s.phase);
        const next = s.ledger.length + 1;
        for (const by of [l.away.entrantId, "both"] as const) {
          for (const reason of FORFEIT_REASONS) {
            if (by === "both" && reason !== "walkover") continue; // the schema's own rule: "both" is only a walkover
            const says = by === "both" ? a.both : a.reasons.includes(reason);
            const code = codeOf(() => foldMatch(m, s.cfg as never, l, [...s.ledger, ev(next, "core.forfeit", { by, reason })]));
            const label = `${m.key} ${s.name} by ${by === "both" ? "both" : "one side"} ${reason}`;
            expect(code === null, `${label}: admission ${says}, guard ${code ?? "records it"}`).toBe(says);
            if (!says && s.phase !== "over") expect(code, label).toBe("FORFEIT_REASON_WRONG_PHASE");
            checked++;
            if (says) admitted++;
          }
        }
      }
    });
    expect(sports).toBe(builtinModules.length);
    // 11 sports × 4 scenes × 5 forfeits, plus chess's tie-break scene (5).
    expect(checked, `forfeits judged: ${checked} (${admitted} admitted)`).toBe(builtinModules.length * 4 * 5 + 5);
    expect(admitted, "the sweep sees admissions, not only refusals").toBeGreaterThan(0);
    expect(admitted, "and refusals, not only admissions").toBeLessThan(checked);
  });
});
