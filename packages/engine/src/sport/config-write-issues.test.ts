// W2e Task 13 (spec 2026-10-28 §5.5, E15; D8) — the config refusals a WRITE door asks (`writeConfigIssues`): ruling 31's
// set-target floor for volleyball and table tennis (rows VB-CF-1, TT-CF-1) and tennis's best of 1 with a match tie-break
// (RB2A-13, row TN-CF-1). Never a `configSchema` refine (E15): a stored config that breaks one still parses and plays.
//
// Expected values come from the rulings and the rows, never from the code under test:
//  - ruling 31 (format-matrix `_INDEX.md`:173, :3185; W2e spec §5.5 "Volleyball and table tennis refuse a set target below
//    5 when a config is written"): the floor is 5, for `setTo` and `finalSetTo` alike;
//  - RB2A-13 (spec §5.5 "Best of 1 with a match tie-break as the final set is refused when a config is written"; ITF Rules of
//    Tennis, App VI: the match tie-break REPLACES the deciding set): best of 1 is already its deciding set;
//  - the rows name the sports that refuse (VB-CF-1, TT-CF-1, TN-CF-1); badminton refuses nothing here (its editor's
//    minimum, 11, is its own: `apps/web/src/lib/match-rules/badminton.ts`).
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { badminton } from "../sports/setbased/badminton.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { tennis } from "../sports/tennis/tennis.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { BO1_MATCH_TIEBREAK, SET_TARGET_BELOW_FLOOR, writeConfigIssues, type AnySportModule } from "./module.ts";

/** Ruling 31: a volleyball or table tennis set is played to at least this many points. */
const RULING_31_FLOOR = 5;
/** The sports whose rows refuse a config at the write door, in registry (wave) order — never sorted. */
const REFUSING = new Set(["volleyball", "tabletennis", "tennis"]);

describe("the write-door config refusals: who declares one", () => {
  it("empty case first: a sport that declares no refusal answers [] for every cfg, and so does a cfg its schema refuses", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (REFUSING.has(key)) return;
      expect(module.configWriteIssues, `${key} declares no write-door refusal`).toBeUndefined();
      for (const { name, cfg } of declaredCfgs(module)) {
        expect(writeConfigIssues(module, cfg), `${key} ${name}`).toEqual([]);
        checked++;
      }
    });
    expect(checked, "non-refusing sports' declared cfgs checked").toBeGreaterThan(0);
    // A cfg the schema refuses is the door's own first answer (CONFIG_INVALID with the schema's issues), never this one's.
    expect(volleyball.configSchema.safeParse({ bestOf: 2, setTo: 3 }).success, "premise: the schema refuses an even bestOf").toBe(false);
    expect(writeConfigIssues(volleyball, { bestOf: 2, setTo: 3 })).toEqual([]);
  });

  it("VB-CF-1 TT-CF-1 TN-CF-1 exactly the rows' sports declare a refusal, and every declared variant of every sport is writeable (counted)", () => {
    const declaring: string[] = [];
    let variants = 0;
    const sports = forEachSport(({ key, module }) => {
      if (module.configWriteIssues !== undefined) declaring.push(key);
      for (const { name, cfg } of declaredCfgs(module)) {
        // A preset the product ships must never be refused by its own write door.
        expect(writeConfigIssues(module, cfg), `${key} ${name} is writeable`).toEqual([]);
        variants++;
      }
    });
    expect(sports).toBe(11);
    expect(declaring).toEqual(["volleyball", "tabletennis", "tennis"]);
    expect(variants, "every sport's declared cfgs, the schema default included").toBeGreaterThan(sports);
  });
});

describe("ruling 31's set-target floor (VB-CF-1, TT-CF-1)", () => {
  it("VB-CF-1/TT-CF-1 setTo or finalSetTo below 5 yields SET_TARGET_BELOW_FLOOR; 5 is clean; badminton declares no floor (its editor min is 11)", () => {
    let checked = 0;
    for (const m of [volleyball, tabletennis] as AnySportModule[]) {
      for (const key of ["setTo", "finalSetTo"] as const) {
        for (let v = 1; v <= RULING_31_FLOOR + 2; v++) {
          const cfg = m.configSchema.parse({ [key]: v });
          expect(writeConfigIssues(m, cfg), `${m.key} ${key} ${v}`).toEqual(v < RULING_31_FLOOR ? [SET_TARGET_BELOW_FLOOR] : []);
          checked++;
        }
      }
      // Both targets below the floor: ONE sentence, not one per target.
      expect(writeConfigIssues(m, m.configSchema.parse({ setTo: 3, finalSetTo: 3 })), `${m.key} both below`).toEqual([SET_TARGET_BELOW_FLOOR]);
      // A best of 1 plays only its deciding set, to `finalSetTo`; the floor still holds there.
      expect(writeConfigIssues(m, m.configSchema.parse({ bestOf: 1, setTo: 25, finalSetTo: 4 })), `${m.key} best of 1`).toEqual([SET_TARGET_BELOW_FLOOR]);
    }
    expect(checked).toBe(2 * 2 * (RULING_31_FLOOR + 2));
    // Another sport on the same kernel: badminton's rules have no such floor.
    expect(badminton.configWriteIssues).toBeUndefined();
    expect(writeConfigIssues(badminton, badminton.configSchema.parse({ setTo: 3, finalSetTo: 3, cap: 5 }))).toEqual([]);
  });

  it("VB-CF-1 TT-CF-1 the sentence states the floor each module enforces: the lowest clean target is 5, the number it names", () => {
    expect(SET_TARGET_BELOW_FLOOR).toContain(` ${RULING_31_FLOOR} `);
    for (const m of [volleyball, tabletennis] as AnySportModule[]) {
      const lowestClean = [...Array(20).keys()].map((i) => i + 1).find((v) => writeConfigIssues(m, m.configSchema.parse({ setTo: v, finalSetTo: v })).length === 0);
      expect(lowestClean, m.key).toBe(RULING_31_FLOOR);
    }
  });
});

describe("tennis best of 1 with a match tie-break (TN-CF-1, RB2A-13)", () => {
  it("TN-CF-1 bestOf 1 with finalSet {matchTiebreakTo} yields BO1_MATCH_TIEBREAK; bestOf 3 with it is clean", () => {
    const issues = (raw: Record<string, unknown>) => writeConfigIssues(tennis, tennis.configSchema.parse(raw));
    expect(issues({ bestOf: 1, finalSet: { matchTiebreakTo: 10 } })).toEqual([BO1_MATCH_TIEBREAK]);
    expect(issues({ bestOf: 1, finalSet: { matchTiebreakTo: 7 } })).toEqual([BO1_MATCH_TIEBREAK]);
    // The doubles preset IS best of 3 with a match tie-break: clean; the same preset cut to best of 1 is not.
    expect(issues({ ...tennis.variants["doubles-noad-mtb10"] })).toEqual([]);
    expect(issues({ ...tennis.variants["doubles-noad-mtb10"], bestOf: 1 })).toEqual([BO1_MATCH_TIEBREAK]);
    // Positive pairs: a decider that is still a SET (the slam form, or the same set) is no match tie-break.
    expect(issues({ bestOf: 3, finalSet: { matchTiebreakTo: 10 } })).toEqual([]);
    expect(issues({ bestOf: 5, finalSet: { matchTiebreakTo: 10 } })).toEqual([]);
    expect(issues({ bestOf: 1, finalSet: { tiebreakTo: 10 } })).toEqual([]);
    expect(issues({ bestOf: 1, finalSet: "same" })).toEqual([]);
  });
});

describe("E15: the refusals are the write door's, never the schema's or the fold's", () => {
  const lineups: LineupPair = defaultLineupPair(volleyball.positions);
  const H = lineups.home.entrantId;

  it("E15 configSchema still parses a volleyball setTo 3 config, and a stored one plays: three sets of 3-0 win the match", () => {
    const parsed = volleyball.configSchema.safeParse({ setTo: 3, finalSetTo: 3 });
    expect(parsed.success).toBe(true);
    const cfg = parsed.data!;
    expect(writeConfigIssues(volleyball, cfg), "premise: the write door refuses it").toEqual([SET_TARGET_BELOW_FLOOR]);
    // Best of 5 (the preset): 3 sets to 3, each closed 3-0 (a lead of the preset's 2), every event on the strict write path.
    const events = [{ type: "core.start", payload: {} }, ...Array.from({ length: 9 }, () => ({ type: "volleyball.rally", payload: { wonBy: H } }))].map((e, i) =>
      makeEnvelope(i, e),
    );
    const folded = foldMatchWithStoppage(volleyball, cfg, lineups, events, { strictFromSeq: 0 });
    expect(outcomeOf(volleyball, folded)).toMatchObject({ kind: "win", winner: H });
  });

  it("E15 the same holds for table tennis and for tennis's best of 1 with a match tie-break", () => {
    expect(tabletennis.configSchema.safeParse({ setTo: 3, finalSetTo: 3 }).success).toBe(true);
    const tn = tennis.configSchema.safeParse({ bestOf: 1, finalSet: { matchTiebreakTo: 10 } });
    expect(tn.success).toBe(true);
    const tl: LineupPair = defaultLineupPair(tennis.positions);
    // A stored best of 1 with a match tie-break still records its result: the only set is the deciding one, entered as
    // the match tie-break's score (10–8, a final score to 10 by the match's margin of 2, RBS:348).
    const events = [
      { type: "core.start", payload: {} },
      { type: "tennis.set_summary", payload: { home: 10, away: 8 } },
    ].map((e, i) => makeEnvelope(i, e));
    const folded = foldMatchWithStoppage(tennis, tn.data!, tl, events, { strictFromSeq: 0 });
    expect(outcomeOf(tennis, folded)).toMatchObject({ kind: "win", winner: tl.home.entrantId });
  });
});
