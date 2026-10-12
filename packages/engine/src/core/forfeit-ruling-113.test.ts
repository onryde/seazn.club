// W2b ruling 113 (2026-10-11, owner "Ok A"; amends Appendix A X-RS-1, X-RT-1, X-WD-6): nothing played means not
// started, for every forfeit reason. "Played" is ruling 112's test: an active sport (module-owned) event after
// `core.start`. After a Start with nothing played:
//   - a walkover and a double walkover are admitted (ruling 112);
//   - a withdrawal is admitted and credits the walkover score (sport/forfeit-credit.test.ts, X-WD-6);
//   - a disqualification stays admitted, because misconduct before play is real;
//   - a retirement is NOT admitted until something has been played: nobody retires from a match never played.
// Every expectation below is that text, or the module's own declarations (its generator's play, its cfgs). None is
// read back from the guard. Each sweep counts what it checked; zero checked is a failure.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, forfeitAdmission, outcomeOf, playRecorded, type EventEnvelope } from "./events.ts";
import { FORFEIT_REASONS, type LineupPair } from "./types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const START = (): EventEnvelope => ev(1, "core.start");
const fold = (m: AnySportModule, cfg: unknown, l: LineupPair, events: EventEnvelope[]) => foldMatchWithStoppage(m as never, cfg as never, l, events);
const refusalOf = (f: () => unknown): EngineError | null => {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e;
    throw e;
  }
};

/** Ruling 113's list for a Start with nothing played, in the engine's FORFEIT_REASONS order: walkover, disqualified,
 *  withdrew — everything but the retirement. */
const NOTHING_PLAYED: readonly string[] = FORFEIT_REASONS.filter((r) => r !== "retired");

/** Every declared cfg of a sport, each with a cfg the sport's own play can be undecided under: the cfg itself, else its
 *  bracket deciders (chess decides a plain game with its one event; under the deciders a draw is held for the
 *  tie-break) — and that play, drawn from the module's generator (`onePlayEvent`, a score-moving event). */
function scenes(m: AnySportModule): { name: string; cfg: unknown; playCfg: unknown; play: EventEnvelope; l: LineupPair }[] {
  const l = defaultLineupPair(m.positions);
  return declaredCfgs(m as never).map(({ name, cfg }) => {
    const candidates = [cfg, m.configSchema.parse({ ...(cfg as object), ...m.bracketDeciders(cfg) })];
    for (const playCfg of candidates) {
      const play = onePlayEvent(m, playCfg, l, [START()]);
      if (play !== null) return { name, cfg, playCfg, play, l };
    }
    throw new Error(`${m.key}/${name}: its generator draws no undecided play after the start under either cfg`);
  });
}

describe("ruling 113: a retirement needs something played (X-RS-1, X-RT-1 as amended)", () => {
  it("X-RS-1 + X-RT-1 (ruling 113): [start, retired] is refused FORFEIT_REASON_WRONG_PHASE, and the refusal names walkover, disqualified and withdrew — every sport, every declared cfg, either side", () => {
    let refused = 0;
    let startIsPlay = 0;
    const sports = forEachSport(({ module: m }) => {
      // Ruling 118: where the Start is play (chess), [start, retired] is admitted — forfeit-ruling-118.test.ts.
      if (m.startIsPlay === true) return void startIsPlay++;
      for (const { name, cfg, l } of scenes(m)) {
        for (const by of [l.home.entrantId, l.away.entrantId]) {
          const e = refusalOf(() => fold(m, cfg, l, [START(), ev(2, "core.forfeit", { by, reason: "retired" })]));
          const label = `${m.key}/${name} retired by ${by === l.home.entrantId ? "home" : "away"} after a bare start`;
          expect(e?.code, label).toBe("FORFEIT_REASON_WRONG_PHASE");
          expect((e!.data as { allowed: string[] }).allowed, label).toEqual(NOTHING_PLAYED);
          expect((e!.data as { reason: string }).reason, label).toBe("retired");
          // The refusal says WHY in its own terms: the phase reads "play", and nothing is played yet (the copy's word).
          expect((e!.data as { phase: string; played: boolean }), label).toMatchObject({ phase: "play", played: false });
          refused++;
        }
      }
    });
    expect([sports, startIsPlay]).toEqual([11, 1]);
    expect(refused).toBeGreaterThan(2 * (sports - startIsPlay));
  });

  it("X-RT-1 (ruling 113): [start, play, retired] is admitted — the retiree loses, reason retired — every sport, every declared cfg", () => {
    let admitted = 0;
    forEachSport(({ module: m }) => {
      for (const { name, playCfg, play, l } of scenes(m)) {
        const f = fold(m, playCfg, l, [START(), play, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
        expect(outcomeOf(m as never, f as never), `${m.key}/${name} after ${play.type}`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "retired" });
        admitted++;
      }
    });
    expect(admitted).toBeGreaterThan(builtinModules.length);
  });

  it("X-RT-1 (ruling 113): [start, play, void play, retired] is refused again — a voided play is nothing played — every sport, every declared cfg", () => {
    let refused = 0;
    forEachSport(({ module: m }) => {
      if (m.startIsPlay === true) return; // ruling 118: chess's Start stands, so it is still play
      for (const { name, playCfg, play, l } of scenes(m)) {
        const ledger = [START(), play, ev(3, "core.void", {}, play.id)];
        expect(playRecorded(ledger, m), `${m.key}/${name}: rig, nothing active is play`).toBe(false);
        const e = refusalOf(() => fold(m, playCfg, l, [...ledger, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]));
        expect(e?.code, `${m.key}/${name} retired after ${play.type} voided`).toBe("FORFEIT_REASON_WRONG_PHASE");
        expect((e!.data as { allowed: string[] }).allowed, `${m.key}/${name}`).toEqual(NOTHING_PLAYED);
        expect((e!.data as { played: boolean }).played, `${m.key}/${name}: the voided play is no play`).toBe(false);
        refused++;
      }
    });
    expect(refused).toBeGreaterThan(builtinModules.length - 1);
  });

  it("X-RS-1 (ruling 113): the refusal names whether anything was played — a walkover refused after play says played: true, every sport whose walkover stops at the Start", () => {
    // The positive pair of `played: false` above: the copy reads "once play has started" only when something was.
    let refused = 0;
    forEachSport(({ module: m }) => {
      if (m.walkoverPhases !== undefined) return; // chess admits a walkover in play (FIDE 6.7.1) — nothing to refuse
      for (const { name, playCfg, play, l } of scenes(m)) {
        const e = refusalOf(() => fold(m, playCfg, l, [START(), play, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]));
        expect(e?.code, `${m.key}/${name} walkover after ${play.type}`).toBe("FORFEIT_REASON_WRONG_PHASE");
        expect(e!.data, `${m.key}/${name}`).toMatchObject({ reason: "walkover", played: true });
        refused++;
      }
    });
    expect(refused).toBeGreaterThan(builtinModules.length - 1);
  });

  it("X-RT-1 (ruling 113): [start, disqualified] is admitted — misconduct before play is real — every sport, every declared cfg, either side", () => {
    let admitted = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg, l } of scenes(m)) {
        for (const [by, winner] of [[l.away.entrantId, l.home.entrantId], [l.home.entrantId, l.away.entrantId]] as const) {
          const f = fold(m, cfg, l, [START(), ev(2, "core.forfeit", { by, reason: "disqualified" })]);
          expect(outcomeOf(m as never, f as never), `${m.key}/${name} disqualified ${by}`).toEqual({ kind: "award", winner, loser: by, reason: "disqualified" });
          admitted++;
        }
      }
    });
    expect(admitted).toBeGreaterThan(2 * builtinModules.length);
  });

  it("X-RS-1 + X-RT-1 (ruling 113): before the Start nothing changes — retired and disqualified are refused, a walkover and a withdrawal are admitted", () => {
    // The positive pair of the bare-start sweep: a disqualification is the one reason the Start opens (R4), so before
    // it the refusal names walkover and withdrew only.
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l } = scenes(m)[0]!;
      for (const reason of FORFEIT_REASONS) {
        const e = refusalOf(() => fold(m, cfg, l, [ev(1, "core.forfeit", { by: l.away.entrantId, reason })]));
        if (reason === "retired" || reason === "disqualified") {
          expect(e?.code, `${m.key} ${reason} before the start`).toBe("FORFEIT_REASON_WRONG_PHASE");
          expect((e!.data as { allowed: string[] }).allowed, `${m.key} ${reason}`).toEqual(["walkover", "withdrew"]);
        } else {
          expect(e, `${m.key} ${reason} before the start`).toBeNull();
        }
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * FORFEIT_REASONS.length);
  });
});

describe("ruling 113: the console's admission is the guard's (forfeitAdmission)", () => {
  it("X-RS-1 + X-RT-1 (ruling 113): after a bare Start forfeitAdmission offers walkover, disqualified, withdrew and Neither; once played it adds the retirement; voided, it takes it back — every sport, every declared cfg", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (m.startIsPlay === true) return; // ruling 118: chess offers the retirement from the Start (forfeit-ruling-118)
      for (const { name, cfg, playCfg, play, l } of scenes(m)) {
        expect(playRecorded([START()], m), `${m.key}/${name}: a bare start is nothing played`).toBe(false);
        const bare = forfeitAdmission(m as never, fold(m, cfg, l, [START()]).state, { playRecorded: playRecorded([START()], m) });
        expect(bare.reasons, `${m.key}/${name} bare start`).toEqual(NOTHING_PLAYED);
        expect(bare.both, `${m.key}/${name} bare start: Neither`).toBe(true);
        const played = forfeitAdmission(m as never, fold(m, playCfg, l, [START(), play]).state, { playRecorded: true });
        expect(played.reasons, `${m.key}/${name} after ${play.type}`).toContain("retired");
        expect(played.reasons, `${m.key}/${name} after ${play.type}`).toContain("disqualified");
        const ledger = [START(), play, ev(3, "core.void", {}, play.id)];
        const voided = forfeitAdmission(m as never, fold(m, playCfg, l, ledger).state, { playRecorded: playRecorded(ledger, m) });
        expect(voided.reasons, `${m.key}/${name} after ${play.type} voided`).not.toContain("retired");
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(builtinModules.length - 1);
  });

  it("D3 R4 + ruling 113 (R112 fix round 2, m1): a retirement needs BOTH — something played AND a phase past \"pre\"; a phase that reads pre is offered the walkover and the withdrawal only, whatever the console's fact says", () => {
    // forfeitAdmission takes `playRecorded` from its caller (the console reads it off its ledger rows), so the fact and
    // the module's phase can disagree — a stale state, or a module that reads pre. The phase is the module's word: R4
    // records a retirement after the Start, ruling 113 once something is played, and neither alone admits it. The
    // expected lists are the rule's: in pre a walkover and a withdrawal (R2, R5) and the double walkover (R1); in play,
    // played, everything but the walkover (ruling 112); in play, nothing played, everything but the retirement.
    const phased = (phase: "pre" | "play") => ({ forfeitPhase: (): "pre" | "play" => phase });
    const cases = [
      { phase: "pre" as const, played: true, reasons: ["walkover", "withdrew"], both: true },
      { phase: "pre" as const, played: false, reasons: ["walkover", "withdrew"], both: true },
      { phase: "play" as const, played: true, reasons: FORFEIT_REASONS.filter((r) => r !== "walkover"), both: false },
      { phase: "play" as const, played: false, reasons: NOTHING_PLAYED, both: true },
    ];
    let checked = 0;
    for (const c of cases) {
      const got = forfeitAdmission(phased(c.phase), {}, { playRecorded: c.played });
      expect(got, `phase ${c.phase}, played ${c.played}`).toEqual({ phase: c.phase, reasons: c.reasons, both: c.both });
      checked++;
    }
    expect(checked).toBe(4);
  });
});
