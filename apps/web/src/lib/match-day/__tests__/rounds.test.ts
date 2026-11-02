// Match Day E2 item 7 — a match's round, named the way the SCHEDULE BOARD names it (lib/match-day/rounds.ts).
//
// The owner's words: "we don't know which matches are going on? R1, R2… or SF, like in schedule board". So the contract is
// PARITY with the board, and the board's own function is the oracle: every expected code is `boardRoundCodes` over the same rows
// (or the board chip's own fallback `R{round_no}` where it declines to code a round). Beside the parity, a handful of anchors
// written from the owner-approved design (round-codes.ts's header: QF, SF, F, 3rd for a knockout; a league/Swiss round stays R{n})
// so a change that moved BOTH the board and Match Day together would still be seen.
// Anti-vacuity: each sweep reports what it checked; zero fails.
import { describe, expect, it } from "vitest";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { matchDayRounds, type RoundSource } from "../rounds";

type Row = RoundCodeFixture;
const LOCALES = ["en", "es", "fr", "nl"] as const;
const msgIn = (locale: (typeof LOCALES)[number]) => (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
const en = msgIn("en");

function row(over: Partial<Row> & { stage_id: string; round_no: number; seq_in_round: number }): Row {
  return {
    id: `${over.stage_id}-r${over.round_no}-${over.seq_in_round}${over.third_place ? "-3p" : ""}${over.conditional ? "-reset" : ""}`,
    ...over,
  } as Row;
}

/** An 8-entrant single elimination as the generator persists it: QF r1 x4, SF r2 x2, the final r3 (`is_final`), the bronze match
 *  sharing the final's round as its seq 2. (The board's own round-codes.test.ts builds the same bracket.) */
const ko8 = (stage_id = "ko"): Row[] => [
  ...[1, 2, 3, 4].map((s) => row({ stage_id, round_no: 1, seq_in_round: s })),
  ...[1, 2].map((s) => row({ stage_id, round_no: 2, seq_in_round: s })),
  row({ stage_id, round_no: 3, seq_in_round: 1, is_final: true }),
  row({ stage_id, round_no: 3, seq_in_round: 2, third_place: true }),
];
/** A Swiss / league stage: plain rounds, 3 rounds of 2 matches. */
const plain = (stage_id: string): Row[] => [1, 2, 3].flatMap((r) => [1, 2].map((s) => row({ stage_id, round_no: r, seq_in_round: s })));
/** An 8-entrant double elimination with a bracket reset: WB 1-3, LB 7-10, GF 14 and its reset 15. */
const de8 = (stage_id = "de"): Row[] => [
  ...[1, 2, 3].map((r) => row({ stage_id, round_no: r, seq_in_round: 1, lane: "WB" })),
  ...[7, 8, 9, 10].map((r) => row({ stage_id, round_no: r, seq_in_round: 1, lane: "LB" })),
  row({ stage_id, round_no: 14, seq_in_round: 1, lane: "GF", is_final: true }),
  row({ stage_id, round_no: 15, seq_in_round: 1, lane: "GF", conditional: true, is_final: true }),
];

const sources = (rows: readonly Row[]): RoundSource[] => rows.map((f) => ({ id: f.id, stage_id: f.stage_id, round_no: f.round_no }));
const STAGES = [
  { id: "ko", kind: "knockout" },
  { id: "swiss", kind: "swiss" },
  { id: "league", kind: "league" },
  { id: "de", kind: "double_elim" },
];
const ALL = [...ko8("ko"), ...plain("swiss"), ...plain("league"), ...de8("de")];

describe("matchDayRounds — the empty case, then the board's anchors", () => {
  it("empty case first: nothing shown, nothing named (and the stage rows alone name nobody)", () => {
    expect(matchDayRounds([], ALL, STAGES, en).size).toBe(0);
  });

  it("a knockout: QF, SF, F and 3rd with their full names — the design's own words, not read back from the board", () => {
    const rounds = matchDayRounds(sources(ko8()), ko8(), STAGES, en);
    const at = (round_no: number, seq: number, third = false) => rounds.get(`ko-r${round_no}-${seq}${third ? "-3p" : ""}`);
    expect(at(1, 1)).toEqual({ code: "QF", label: "Quarter-finals", coded: true });
    expect(at(1, 4)).toEqual({ code: "QF", label: "Quarter-finals", coded: true });
    expect(at(2, 1)).toEqual({ code: "SF", label: "Semi-finals", coded: true });
    expect(at(2, 2)).toEqual({ code: "SF", label: "Semi-finals", coded: true });
    expect(at(3, 1)).toEqual({ code: "F", label: "Final", coded: true });
    expect(at(3, 2, true)).toEqual({ code: "3rd", label: "Third place", coded: true });
    expect(rounds.size).toBe(8);
  });

  it("a Swiss round and a league round are NOT coded: the board's own R{n} and 'Round n'", () => {
    for (const stage of ["swiss", "league"]) {
      const rows = plain(stage);
      const rounds = matchDayRounds(sources(rows), rows, STAGES, en);
      for (const f of rows) expect(rounds.get(f.id), `${stage} r${f.round_no}`).toEqual({ code: `R${f.round_no}`, label: `Round ${f.round_no}`, coded: false });
      expect(rounds.size).toBe(6);
    }
  });

  it("a double elimination is lane-numbered (WB / LB / GF), not named like a single-elimination bracket", () => {
    const rows = de8();
    const rounds = matchDayRounds(sources(rows), rows, STAGES, en);
    expect(rounds.get("de-r1-1")?.code).toBe("WB1");
    expect(rounds.get("de-r3-1")?.code).toBe("WB3");
    expect(rounds.get("de-r7-1")?.code).toBe("LB1");
    expect(rounds.get("de-r14-1")?.coded).toBe(true);
    for (const f of rows) expect(rounds.get(f.id)!.coded, f.id).toBe(true);
  });
});

describe("matchDayRounds — parity with the schedule board", () => {
  it("every match of every stage kind, in every locale: the same code and name the board's boardRoundCodes gives it (count reported)", () => {
    let checked = 0;
    let coded = 0;
    for (const locale of LOCALES) {
      const msg = msgIn(locale);
      const rounds = matchDayRounds(sources(ALL), ALL, STAGES, msg);
      const board = boardRoundCodes(ALL, STAGES, msg);
      for (const f of ALL) {
        const b = board.get(f.id);
        const got = rounds.get(f.id)!;
        if (b !== undefined) {
          expect(got, `${locale} ${f.id}`).toEqual({ code: b.code, label: b.label, coded: true });
          coded++;
        } else {
          // The board's chip fallback (fixture-block.tsx) and the plain round name.
          expect(got, `${locale} ${f.id}`).toEqual({ code: `R${f.round_no}`, label: msg("schedule.round", { n: f.round_no }), coded: false });
        }
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * ALL.length);
    expect(coded, "the sweep reaches coded rounds, not only the fallback").toBeGreaterThan(LOCALES.length * 8);
  });

  it("the words are the READER's: a coded round's name differs between English and at least one other locale", () => {
    const labels = new Set(LOCALES.map((l) => matchDayRounds(sources(ko8()), ko8(), STAGES, msgIn(l)).get("ko-r2-1")!.label));
    expect(labels.size, "Semi-finals is said differently somewhere").toBeGreaterThan(1);
  });

  it("only the SHOWN matches are named, but they are ranked against the WHOLE stage (a lone semi-final is not the final)", () => {
    const stage = ko8();
    const semi = stage.filter((f) => f.round_no === 2);
    const rounds = matchDayRounds(sources(semi), stage, STAGES, en);
    expect([...rounds.keys()].sort()).toEqual(semi.map((f) => f.id).sort());
    for (const f of semi) expect(rounds.get(f.id)!.code, f.id).toBe("SF");
    // Handed only the shown rows, the board declines to name them (no final among them): the fallback, never a guessed code.
    const alone = matchDayRounds(sources(semi), semi, STAGES, en);
    for (const f of semi) expect(alone.get(f.id), f.id).toEqual({ code: "R2", label: "Round 2", coded: false });
  });

  it("stages are ranked one at a time: a league's round 3 beside a knockout's round 3 final is still R3, and the F is still F", () => {
    const rows = [...plain("league"), ...ko8("ko")];
    const rounds = matchDayRounds(sources(rows), rows, STAGES, en);
    expect(rounds.get("league-r3-1")).toEqual({ code: "R3", label: "Round 3", coded: false });
    expect(rounds.get("ko-r3-1")?.code).toBe("F");
  });

  it("a stage kind the board does not code (or knows nothing of) falls back to R{n} rather than a guess", () => {
    const rows = ko8("odd");
    for (const stages of [[{ id: "odd", kind: "round_robin" }], []]) {
      const rounds = matchDayRounds(sources(rows), rows, stages, en);
      for (const f of rows) expect(rounds.get(f.id)!.coded, f.id).toBe(false);
      expect(rounds.get("odd-r3-1")!.code).toBe("R3");
    }
  });

  it("a legacy bracket (no is_final on any row, the pre-V368 shape) is left uncoded, as the board leaves it", () => {
    const legacy = ko8().map((f) => {
      const copy = { ...f };
      delete copy.is_final;
      delete copy.third_place;
      return copy;
    });
    const rounds = matchDayRounds(sources(legacy), legacy, STAGES, en);
    const board = boardRoundCodes(legacy, STAGES, en);
    expect(board.size, "premise: the board itself declines it").toBe(0);
    for (const f of legacy) expect(rounds.get(f.id)!.coded, f.id).toBe(false);
  });
});
