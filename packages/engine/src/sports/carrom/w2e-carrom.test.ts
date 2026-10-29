// W2e Task 11 (A1e-2, SC-O9) — CA-AD-1: carrom's umpire adjustment is bounded in the engine.
//
// The bound is the pad's own (`padSpec`: credit 1..gameTo, deduction -gameTo..-1), now enforced where the write lands: a
// strict `carrom.game.adjust` whose |delta| exceeds the match's `gameTo` is refused ADJUST_OUT_OF_RANGE. The lower bound
// (|delta| >= 1) is the event schema's: the delta is an integer and `.refine(d => d !== 0)`, so 0 is refused INVALID_EVENT
// before this rule is reached, on every path (asserted below, so "cannot happen" has a test that reaches it).
//
// Where the bound comes from. Expected values are never typed beside the guard: each variant's `gameTo` is read from the
// module's own declarations (`declaredCfgs`) and cross-checked against the rulebook (ICF Laws of Carrom, Law 56a: a game is
// first to 25 points; the documented club rules: first to 29) in the first test, so a variant whose target moves reds there
// first. The pad's extremes are read from `padSpec(cfg)` and pushed through the real engine, so the producer and the
// consumer are checked against each other rather than against a fixture.
//
// A deduction can never reach -gameTo: an OPEN game's side score is always below gameTo (the first side to gameTo with the
// lead closes the game, and a tie at or above it cannot be built), so -gameTo is refused as "below zero" (INVALID_EVENT, the
// existing rule) while -(gameTo+1) is refused ADJUST_OUT_OF_RANGE. The two codes are what witnesses the boundary on that
// side: the range check must fire FIRST, or both would read INVALID_EVENT.
//
// single-sport: the rule is carrom's `carrom.game.adjust` against carrom's `cfg.gameTo`; no other sport has an umpire
// adjustment bounded by a game target.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { buildStream, declaredCfgs, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { carrom, padSpec, type CarromCfg, type CarromState } from "./carrom.ts";

/** Every write below is PAD-SHAPED: the whole stream is new (`strictFromSeq: 0`), the write path. */
const STRICT_ALL = { strictFromSeq: 0 } as const;

const lineups = defaultLineupPair(carrom.positions); // entrants H / A
const cfg = carrom.configSchema.parse({});

type Spec = [type: string, payload?: unknown, voids?: string];
const ledger = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));

const START: Spec = ["core.start"];
const adjust = (entrantId: string, delta: number, extra: Record<string, unknown> = {}): Spec => [
  "carrom.game.adjust",
  { entrantId, delta, reason: "foul", ...extra },
];

const strictFold = (specs: readonly Spec[], config: CarromCfg = cfg): CarromState =>
  foldMatch(carrom, config, lineups, ledger(specs), STRICT_ALL);
/** The READ path: no options, so every event folds leniently. */
const readFold = (specs: readonly Spec[], config: CarromCfg = cfg): CarromState => foldMatch(carrom, config, lineups, ledger(specs));

function refusalOf(fn: () => unknown): EngineError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
}

/** The first game's score, which every case below reads. */
const firstGame = (state: CarromState) => state.games[0]!;

/** The rulebook's targets: ICF Law 56a (25) for the default and `icf`, the documented club rules (29) for `club-29`. */
const RULEBOOK_GAME_TO: Readonly<Record<string, number>> = { "(schema default)": 25, icf: 25, "club-29": 29 };

const declared = declaredCfgs<CarromCfg>(carrom);

/** The refusal's message as docs/api-v1-breaking-changes.md quotes it (the ADJUST_OUT_OF_RANGE "What a consumer sees" example). A
 *  literal here, not a read of the docs file: the engine's tests run in a sandbox that holds packages/engine alone. */
const REFUSAL_MESSAGE = "an adjustment moves a score by at most the points needed to win the game";

describe("CA-AD-1 where the bound comes from", () => {
  it("CA-AD-1 the declared variants' game targets are the rulebook's (25, 25, 29), and every sweep below walks all of them", () => {
    expect(declared.map((d) => d.name).sort()).toEqual(Object.keys(RULEBOOK_GAME_TO).sort());
    for (const { name, cfg: c } of declared) expect(c.gameTo, name).toBe(RULEBOOK_GAME_TO[name]);
    // The anchors that make the sweeps meaningful: two different targets, and a target large enough to leave room below it.
    expect(new Set(declared.map((d) => d.cfg.gameTo))).toEqual(new Set([25, 29]));
    for (const { name, cfg: c } of declared) expect(c.gameTo, `${name}: a deduction below the target needs a target above 1`).toBeGreaterThan(1);
  });
});

describe("CA-AD-1 carrom.game.adjust is bounded by gameTo on the write path (SC-O9)", () => {
  it("CA-AD-1 delta +gameTo is accepted and +(gameTo+1) is refused ADJUST_OUT_OF_RANGE, for every declared variant and both sides", () => {
    let checked = 0;
    for (const { name, cfg: c } of declared) {
      const g = c.gameTo;
      for (const side of ["H", "A"] as const) {
        const label = `${name} / ${side}`;
        const seat = side === "H" ? "home" : "away";
        // The boundary itself: the whole target in one credit closes the game for the side that gained it.
        const atBound = strictFold([START, adjust(side, g)], c);
        expect(firstGame(atBound).score[seat], `${label} +${g}`).toBe(g);
        expect(firstGame(atBound).winner, `${label} +${g} closes the game (Law 56a)`).toBe(seat);
        // One past it: refused, and the refusal names what was sent and the bound it was judged against.
        const err = refusalOf(() => strictFold([START, adjust(side, g + 1)], c));
        expect(err, `${label} +${g + 1}`).not.toBeNull();
        expect(err!.code, `${label} +${g + 1}`).toBe("ADJUST_OUT_OF_RANGE");
        expect(err!.data, `${label} +${g + 1}`).toEqual({ delta: g + 1, gameTo: g });
        // The sentence a consumer reads: exactly the one docs/api-v1-breaking-changes.md quotes in its example response.
        expect(err!.message, `${label} +${g + 1}`).toBe(REFUSAL_MESSAGE);
        // The smallest credit is accepted.
        expect(firstGame(strictFold([START, adjust(side, 1)], c)).score[seat], `${label} +1`).toBe(1);
        checked += 3;
      }
    }
    expect(checked, "credit cases checked").toBe(declared.length * 2 * 3);
    expect(checked).toBeGreaterThan(0);
  });

  it("CA-AD-1 a deduction: -(gameTo+1) is refused ADJUST_OUT_OF_RANGE (before 'below zero'), -gameTo passes the range rule, -(gameTo-1) is accepted", () => {
    let checked = 0;
    for (const { name, cfg: c } of declared) {
      const g = c.gameTo;
      for (const side of ["H", "A"] as const) {
        const label = `${name} / ${side}`;
        const seat = side === "H" ? "home" : "away";
        // The largest score an OPEN game can hold is gameTo-1 (reaching gameTo with the lead closes it).
        const high: Spec[] = [START, adjust(side, g - 1)];
        expect(firstGame(strictFold(high, c)).score[seat], `${label} setup`).toBe(g - 1);
        expect(firstGame(strictFold(high, c)).winner, `${label} setup leaves the game open`).toBeNull();
        // -(g+1): out of range. The score could not absorb it either, so only the ORDER of the two checks gives this code.
        const out = refusalOf(() => strictFold([...high, adjust(side, -(g + 1))], c));
        expect(out?.code, `${label} -${g + 1}`).toBe("ADJUST_OUT_OF_RANGE");
        expect(out?.data, `${label} -${g + 1}`).toEqual({ delta: -(g + 1), gameTo: g });
        expect(out?.message, `${label} -${g + 1}`).toBe(REFUSAL_MESSAGE);
        // -g: inside the range, so it is NOT the new refusal. The existing rule stops it (the score is g-1).
        const below = refusalOf(() => strictFold([...high, adjust(side, -g)], c));
        expect(below?.code, `${label} -${g}`).toBe("INVALID_EVENT");
        expect(below?.message, `${label} -${g}`).toBe("adjustment would take the game score below zero");
        // -(g-1): accepted, and takes the score to zero.
        expect(firstGame(strictFold([...high, adjust(side, -(g - 1))], c)).score[seat], `${label} -${g - 1}`).toBe(0);
        checked += 3;
      }
    }
    expect(checked, "deduction cases checked").toBe(declared.length * 2 * 3);
    expect(checked).toBeGreaterThan(0);
  });

  it("CA-AD-1 the bound is the match's gameTo, not a constant: a lower target refuses what the default accepts", () => {
    const eleven = carrom.configSchema.parse({ gameTo: 11, queenCapAt: 10 });
    const one = carrom.configSchema.parse({ gameTo: 1, queenCapAt: 1 });
    // Differential: +12 is inside the default's 25 and outside an 11-point game.
    expect(refusalOf(() => strictFold([START, adjust("H", 12)], cfg))).toBeNull();
    expect(refusalOf(() => strictFold([START, adjust("H", 12)], eleven))?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(firstGame(strictFold([START, adjust("H", 11)], eleven)).score.home).toBe(11);
    // And a higher target accepts what a lower one refuses: +26 against club-29.
    const club = declared.find((d) => d.name === "club-29")!.cfg;
    expect(refusalOf(() => strictFold([START, adjust("H", 26)], cfg))?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(refusalOf(() => strictFold([START, adjust("H", 26)], club))).toBeNull();
    // The smallest target a config can hold: one point is the whole range.
    expect(one.gameTo).toBe(1);
    expect(firstGame(strictFold([START, adjust("A", 1)], one)).score.away).toBe(1);
    expect(refusalOf(() => strictFold([START, adjust("A", 2)], one))?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(refusalOf(() => strictFold([START, adjust("A", -2)], one))?.code).toBe("ADJUST_OUT_OF_RANGE");
  });

  it("CA-AD-1 delta 0 and a fraction are the schema's refusal (INVALID_EVENT), strict and lenient alike: the lower bound has a test that reaches it", () => {
    for (const delta of [0, 0.5, -0.5]) {
      for (const [path, fold] of [
        ["strict", strictFold],
        ["read", readFold],
      ] as const) {
        const err = refusalOf(() => fold([START, adjust("H", delta)]));
        expect(err?.code, `${path} delta ${delta}`).toBe("INVALID_EVENT");
        expect(err?.message, `${path} delta ${delta}`).toBe("invalid carrom.game.adjust payload");
      }
    }
  });

  it("CA-AD-1 the refusal does not depend on who is adjusted, why, or who is named", () => {
    // The offender fields ride along; the bound judges the delta alone.
    const err = refusalOf(() => strictFold([START, adjust("A", 26, { person: "A-p1", offendingEntrantId: "H" })]));
    expect(err?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(firstGame(strictFold([START, adjust("A", 25, { person: "A-p1", offendingEntrantId: "H" })])).score.away).toBe(25);
  });
});

describe("CA-AD-1 the sequence: a second call, a closed game, a void", () => {
  it("CA-AD-1 two folds of the same out-of-range ledger refuse alike (pure, a deterministic re-call); an in-range ledger folds on its own; the next game is judged by the same bound", () => {
    const bad = adjust("H", 26);
    for (let call = 0; call < 2; call++) {
      expect(refusalOf(() => strictFold([START, bad]))?.code, `call ${call + 1}`).toBe("ADJUST_OUT_OF_RANGE");
    }
    // A fold is pure, so there is no stored write to leave anything behind: the in-range ledger folds to its own result.
    const alone = strictFold([START, adjust("H", 5)]);
    expect(firstGame(alone).score).toEqual({ home: 5, away: 0 });
    // A closed game does not relax the bound for the next one: game 1 closes at +25, game 2 still refuses +26 and takes +25.
    const closed: Spec[] = [START, adjust("H", 25)];
    expect(strictFold(closed).games).toHaveLength(2);
    expect(refusalOf(() => strictFold([...closed, adjust("A", 26)]))?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(strictFold([...closed, adjust("A", 25)]).gamesWon).toEqual({ home: 1, away: 1 });
    // After the match is over, the kernel's own refusal (guarantee 4) is unchanged and still comes first: nothing more can be
    // adjusted, in range or out of it.
    const decided: Spec[] = [START, adjust("H", 25), adjust("H", 25)];
    expect(strictFold(decided).phase).toBe("done");
    expect(refusalOf(() => strictFold([...decided, adjust("H", 3)]))?.code).toBe("ALREADY_DECIDED");
    expect(refusalOf(() => strictFold([...decided, adjust("H", 26)]))?.code).toBe("ALREADY_DECIDED");
  });

  it("CA-AD-1 after a void: a voided in-range adjust leaves the bound where it was, and the retry is judged as a new write", () => {
    const voided: Spec[] = [START, adjust("H", 5), ["core.void", {}, "e-1"]];
    expect(firstGame(strictFold(voided)).score).toEqual({ home: 0, away: 0 });
    expect(refusalOf(() => strictFold([...voided, adjust("H", 26)]))?.code).toBe("ADJUST_OUT_OF_RANGE");
    expect(refusalOf(() => strictFold([...voided, adjust("H", 25)]))).toBeNull();
    // The voided +5 is not still on the score: taking it back is a deduction from zero, the existing "below zero" refusal.
    expect(refusalOf(() => strictFold([...voided, adjust("H", -3)]))?.code).toBe("INVALID_EVENT");
  });
});

describe("CA-AD-1 replay stays lenient: a pre-W2e ledger keeps its recorded result", () => {
  it("CA-AD-1 replay folds a stored out-of-range credit and deduction as before, on every declared variant", () => {
    let checked = 0;
    for (const { name, cfg: c } of declared) {
      const g = c.gameTo;
      // Recorded at BASE, when neither was refused: +(g+1) simply closed the game with g+1 points; -(g+1) on a score of 0 clamped.
      const credit: Spec[] = [START, adjust("H", g + 1)];
      const read = readFold(credit, c);
      expect(firstGame(read).score.home, `${name} stored +${g + 1}`).toBe(g + 1);
      expect(firstGame(read).winner, `${name} stored +${g + 1}`).toBe("home");
      const deduct: Spec[] = [START, adjust("A", -(g + 1))];
      expect(firstGame(readFold(deduct, c)).score, `${name} stored -${g + 1}`).toEqual({ home: 0, away: 0 });
      // The refusal begins AT the new write: strict from that event refuses, strict from the next folds to the read result.
      for (const specs of [credit, deduct]) {
        expect(refusalOf(() => foldMatch(carrom, c, lineups, ledger(specs), { strictFromSeq: 1 }))?.code, `${name} strict at the event`).toBe(
          "ADJUST_OUT_OF_RANGE",
        );
        const past = foldMatch(carrom, c, lineups, ledger(specs), { strictFromSeq: 2 });
        expect(past, `${name} strict one past the event`).toEqual(readFold(specs, c));
      }
      // A stored out-of-range credit followed by a new, in-range write: the old event stays lenient, the new one is judged.
      // (A closed game's follow-up lands in game 2, so the bound is checked against the NEXT game's adjust.)
      const followed: Spec[] = [...credit, adjust("A", 1)];
      const next = foldMatch(carrom, c, lineups, ledger(followed), { strictFromSeq: 2 });
      expect(next.games[1]?.score, `${name} follow-up`).toEqual({ home: 0, away: 1 });
      expect(
        refusalOf(() => foldMatch(carrom, c, lineups, ledger([...credit, adjust("A", g + 1)]), { strictFromSeq: 2 }))?.code,
        `${name} follow-up past the bound`,
      ).toBe("ADJUST_OUT_OF_RANGE");
      checked++;
    }
    expect(checked, "declared variants replayed").toBe(declared.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("CA-AD-1 a stored out-of-range adjust that was later voided folds as if it had not been written", () => {
    // Read path: the void is honoured, the game reopens. Strict from the NEW write onward: the next adjust is judged afresh.
    const stored: Spec[] = [START, adjust("H", 26), ["core.void", {}, "e-1"]];
    const read = readFold(stored);
    expect(firstGame(read).score).toEqual({ home: 0, away: 0 });
    expect(firstGame(read).winner).toBeNull();
    expect(read.phase).toBe("live");
    expect(foldMatch(carrom, cfg, lineups, ledger([...stored, adjust("H", 4)]), { strictFromSeq: 3 }).games[0]?.score).toEqual({ home: 4, away: 0 });
    expect(refusalOf(() => foldMatch(carrom, cfg, lineups, ledger([...stored, adjust("H", 26)]), { strictFromSeq: 3 }))?.code).toBe(
      "ADJUST_OUT_OF_RANGE",
    );
  });
});

describe("CA-AD-1 every producer of carrom.game.adjust stays inside the bound", () => {
  it("CA-AD-1 the pad's declared extremes ARE the engine's bound: the credit maximum is accepted, one past it and one below the deduction minimum are refused", () => {
    let checked = 0;
    for (const { name, cfg: c } of declared) {
      const actions = padSpec(c)
        .panels.flatMap((p) => p.actions)
        .filter((a) => a.type === "carrom.game.adjust");
      expect(actions.length, `${name}: the pad offers a credit and a deduction`).toBe(2);
      const deltas = actions.flatMap((a) => a.fields.filter((f) => f.path === "delta"));
      expect(deltas.length, `${name}: one delta field per action`).toBe(2);
      const bounds = deltas.map((f) => {
        if (f.kind !== "number") throw new Error(`${name}: delta is a number field`);
        return { min: f.min, max: f.max };
      });
      const padMax = Math.max(...bounds.map((b) => b.max ?? -Infinity));
      const padMin = Math.min(...bounds.map((b) => b.min ?? Infinity));
      // The pad's range is the engine's: derived from the pad, compared with the cfg both read.
      expect([padMin, padMax], name).toEqual([-c.gameTo, c.gameTo]);
      // Through the real engine: the pad's largest credit folds, one past it is the refusal.
      expect(refusalOf(() => strictFold([START, adjust("H", padMax)], c)), `${name} +${padMax}`).toBeNull();
      expect(refusalOf(() => strictFold([START, adjust("H", padMax + 1)], c))?.code, `${name} +${padMax + 1}`).toBe("ADJUST_OUT_OF_RANGE");
      // The pad's largest deduction is inside the range, so it is never THIS refusal; one beyond it is.
      expect(refusalOf(() => strictFold([START, adjust("H", padMin)], c))?.code, `${name} ${padMin}`).not.toBe("ADJUST_OUT_OF_RANGE");
      expect(refusalOf(() => strictFold([START, adjust("H", padMin - 1)], c))?.code, `${name} ${padMin - 1}`).toBe("ADJUST_OUT_OF_RANGE");
      checked++;
    }
    expect(checked, "declared variants whose pad was checked").toBe(declared.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("CA-AD-1 the module's own generator (its adjusts reach the fold strictly, via buildStream) never writes outside the bound", () => {
    let walks = 0;
    let adjusts = 0;
    let widest = 0;
    for (const { name, cfg: c } of declared) {
      for (let seed = 1; seed <= 40; seed++) {
        // `buildStream` applies every event it generates through `module.apply`, which reads an absent context as STRICT:
        // a generated adjust outside the bound would throw here.
        const events = buildStream(carrom, c, lineups, seed, 80);
        for (const ev of events) {
          if (ev.type !== "carrom.game.adjust") continue;
          const delta = (ev.payload as { delta: number }).delta;
          expect(Math.abs(delta), `${name} seed ${seed}`).toBeLessThanOrEqual(c.gameTo);
          adjusts++;
          widest = Math.max(widest, Math.abs(delta));
        }
        walks++;
      }
    }
    expect(walks, "walks").toBe(declared.length * 40);
    expect(adjusts, "generated adjusts checked").toBeGreaterThan(0);
    expect(widest, "the generator writes real deltas").toBeGreaterThan(0);
  });
});
