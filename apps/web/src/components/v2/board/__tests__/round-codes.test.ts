// Schedule-board knockout round codes (2026-09-23, owner-approved design).
//
// The board's card chip read `R{round_no}` for every stage, so a quarter-final
// and a semi-final looked the same to an organiser. `round-codes.ts` turns the
// board's own fixture list into a per-fixture code ("QF", "WB2", "3rd"), the
// "Winner of QF·3" placeholder text, and the legend row. These are the pure
// halves; `server/usecases/__tests__/board-round-codes-read.test.ts` drives the
// same functions over a REAL generated bracket read through the board's own
// projection, which is what proves the new columns actually arrive.
import { describe, expect, it } from "vitest";
import {
  generatePagePlayoff,
  generateSingleElim,
  generateStepladder,
  type GeneratedBracket,
} from "@seazn/engine/scheduling";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { laneRoundRank, roundRoleFor, roundRoleShort } from "@/lib/round-role-label";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { boardRoundCodes, roundLegendEntries, withRoundCodeRefs } from "../round-codes";
import { cardTitle, type BoardFixture } from "../types";

const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

function fx(over: Partial<BoardFixture> & { stage_id: string; round_no: number; seq_in_round: number }): BoardFixture {
  return {
    id: `${over.stage_id}-r${over.round_no}-${over.seq_in_round}${over.third_place ? "-3p" : ""}${over.conditional ? "-reset" : ""}`,
    division_id: "d1",
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: null,
    court_id: null,
    status: "scheduled",
    schedule_source: "none",
    schedule_locked: false,
    outcome: null,
    ...over,
  };
}

/** An 8-entrant single elimination as `bracketToGen` persists it: QF r1 ×4,
 *  SF r2 ×2, final r3 seq 1 (`is_final`), and the bronze match sharing the
 *  final's round as its seq 2 — lane null throughout. */
function ko8(stage_id = "ko", thirdPlace = true): BoardFixture[] {
  return [
    ...[1, 2, 3, 4].map((s) => fx({ stage_id, round_no: 1, seq_in_round: s })),
    ...[1, 2].map((s) => fx({ stage_id, round_no: 2, seq_in_round: s })),
    fx({ stage_id, round_no: 3, seq_in_round: 1, is_final: true }),
    ...(thirdPlace ? [fx({ stage_id, round_no: 3, seq_in_round: 2, third_place: true })] : []),
  ];
}

/** A 16-entrant single elimination, one match per round (enough to name). */
function ko16(stage_id = "ko"): BoardFixture[] {
  return [1, 2, 3, 4].map((r) => fx({ stage_id, round_no: r, seq_in_round: 1, ...(r === 4 ? { is_final: true } : {}) }));
}

/** An 8-entrant double elimination with a bracket reset — WB 1-3, LB 7-10,
 *  GF 14 and its conditional reset 15 (the lane-offset numbering); both grand
 *  final games carry `is_final`, as V368's column comment says. */
function de8(stage_id = "de"): BoardFixture[] {
  return [
    ...[1, 2, 3].map((r) => fx({ stage_id, round_no: r, seq_in_round: 1, lane: "WB" })),
    ...[7, 8, 9, 10].map((r) => fx({ stage_id, round_no: r, seq_in_round: 1, lane: "LB" })),
    fx({ stage_id, round_no: 14, seq_in_round: 1, lane: "GF", is_final: true }),
    fx({ stage_id, round_no: 15, seq_in_round: 1, lane: "GF", conditional: true, is_final: true }),
  ];
}

/** The SAME bracket as a stage generated before V368 (2026-08-17) reads today:
 *  V368 added lane / is_final / third_place / conditional with no backfill, so
 *  every older row sits at the column defaults — lane null, every flag false. */
const legacy = (rows: BoardFixture[]): BoardFixture[] =>
  rows.map((f) => {
    const copy = { ...f };
    delete copy.lane;
    delete copy.is_final;
    delete copy.third_place;
    delete copy.conditional;
    return copy;
  });

const codesOf = (fixtures: BoardFixture[], codes: ReturnType<typeof boardRoundCodes>) =>
  fixtures.map((f) => codes.get(f.id)?.code ?? null);

describe("boardRoundCodes", () => {
  it("single elimination: QF ×4, SF ×2, F, and the bronze match reads 3rd — not F", () => {
    const rows = ko8();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(codesOf(rows, codes)).toEqual(["QF", "QF", "QF", "QF", "SF", "SF", "F", "3rd"]);
  });

  it("the third_place COLUMN is load-bearing: the same bronze row without it reads F", () => {
    // What a board payload that dropped `third_place` would render. Pins that
    // the flag, not the position, is what tells the two round-3 matches apart.
    const rows = ko8().map((f) => {
      const copy = { ...f };
      delete copy.third_place;
      return copy;
    });
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(codesOf(rows, codes).slice(-2)).toEqual(["F", "F"]);
  });

  it("carries the long round name alongside the code (aria + legend read it)", () => {
    const rows = ko8();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(codes.get(rows[0]!.id)).toMatchObject({ code: "QF", label: "Quarter-finals" });
    expect(codes.get(rows.at(-1)!.id)).toMatchObject({ code: "3rd", label: "Third place" });
  });

  it("16 entrants: the first round is R16", () => {
    const rows = ko16();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(codesOf(rows, codes)).toEqual(["R16", "QF", "SF", "F"]);
  });

  it("double elimination: WB1-3, LB1-4, GF, GF2", () => {
    const rows = de8();
    const codes = boardRoundCodes(rows, [{ id: "de", kind: "double_elim" }], en);
    expect(codesOf(rows, codes)).toEqual(["WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2"]);
  });

  it("double elimination: the WB rounds carry the WINNERS' names, not the tournament's quarter/semi (review M1)", () => {
    const rows = de8();
    const codes = boardRoundCodes(rows, [{ id: "de", kind: "double_elim" }], en);
    expect(rows.map((f) => codes.get(f.id)?.label)).toEqual([
      en("bracket.round.winnersRound", { n: 1 }),
      en("bracket.round.winnersRound", { n: 2 }),
      en("bracket.round.winnersFinal"),
      en("bracket.round.losersRound", { n: 1 }),
      en("bracket.round.losersRound", { n: 2 }),
      en("bracket.round.losersRound", { n: 3 }),
      en("bracket.round.losersFinal"),
      en("bracket.round.grandFinal"),
      en("bracket.round.grandFinalReset"),
    ]);
  });

  // Review M2 (2026-09-23). AGENTS.md class 19: a wrongly-seeded value is WORSE
  // than an absent one. A pre-V368 row cannot say which match is the bronze or
  // which lane a round is in, so any code computed from it is a guess dressed as
  // a fact — the plain R{n} it had before is the honest answer.
  it("a pre-V368 knockout (no is_final anywhere) keeps R{n} for the WHOLE stage — its bronze never reads as a second F", () => {
    const old = legacy(ko8("old"));
    const fresh = ko8("new");
    const codes = boardRoundCodes([...old, ...fresh], [
      { id: "old", kind: "knockout" },
      { id: "new", kind: "knockout" },
    ], en);
    expect(codesOf(old, codes)).toEqual([null, null, null, null, null, null, null, null]);
    // Positive pair: the same bracket WITH its role columns is coded as ever.
    expect(codesOf(fresh, codes)).toEqual(["QF", "QF", "QF", "QF", "SF", "SF", "F", "3rd"]);
  });

  it("a pre-V368 double elimination (no lanes, no is_final) keeps R{n} — never one pooled lane read as R512…F", () => {
    const old = legacy(de8("old"));
    const codes = boardRoundCodes(old, [{ id: "old", kind: "double_elim" }], en);
    expect(codesOf(old, codes)).toEqual(old.map(() => null));
    expect(codes.size).toBe(0);
  });

  it("a legacy stage's placeholders keep their plain refs: 'Winner of R1·3', not a guessed code", () => {
    const old = legacy(ko8("ko"));
    const sf2 = { ...old.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null };
    const board = old.map((f) => (f.id === sf2.id ? sf2 : f));
    const input = { [sf2.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 3 } } as SlotLabel } };
    const feeds = withRoundCodeRefs(board, input, boardRoundCodes(board, [{ id: "ko", kind: "knockout" }], en));
    expect(cardTitle(sf2, { e2: "Bea" }, feeds, en)).toBe("Winner of R1·3 vs Bea");
  });

  it("a league keeps no code (the chip stays R{n}); an unknown stage and a key-less page playoff too", () => {
    const league = [1, 2, 3].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1 }));
    // page_playoff WITHOUT ext_key: nothing tells Qualifier 1 from the
    // Eliminator, and the engine would call them quarter-finals — so it keeps
    // R{n} (the page-playoff cases below cover the keyed shape).
    const pp = [1, 1, 2, 3].map((r, i) => fx({ stage_id: "pp", round_no: r, seq_in_round: i === 1 ? 2 : 1 }));
    const orphan = [fx({ stage_id: "gone", round_no: 3, seq_in_round: 1 })];
    const codes = boardRoundCodes(
      [...league, ...pp, ...orphan],
      [
        { id: "lg", kind: "league" },
        { id: "pp", kind: "page_playoff" },
      ],
      en,
    );
    expect(codes.size).toBe(0);
  });

  it("ranks each stage on its OWN rounds: a knockout after a longer league still has its final", () => {
    // The shape that printed "Semi-finals" over a final on the public site
    // (feeder-slot-label.ts): a lane-null rank pooled across stages.
    const league = [1, 2, 3, 4, 5].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1 }));
    const ko = ko8("ko", false);
    const codes = boardRoundCodes([...league, ...ko], [
      { id: "lg", kind: "league" },
      { id: "ko", kind: "knockout" },
    ], en);
    expect(codesOf(ko, codes)).toEqual(["QF", "QF", "QF", "QF", "SF", "SF", "F"]);
    expect(codesOf(league, codes)).toEqual([null, null, null, null, null]);
  });

  it("localizes: es reads its own abbreviations from the dictionary", () => {
    const es = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("es", key, vars);
    const rows = ko8();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], es);
    expect(codes.get(rows[0]!.id)).toMatchObject({
      code: msgFor("es", "bracket.roundShort.quarter"),
      label: msgFor("es", "bracket.round.quarter"),
    });
  });
});

describe("withRoundCodeRefs", () => {
  const stages = [{ id: "ko", kind: "knockout" }];

  it("a feed label naming a coded feeder gains that code: 'Winner of QF·3'", () => {
    const rows = ko8();
    const sf2 = { ...rows.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null, away_entrant_id: null };
    const board = rows.map((f) => (f.id === sf2.id ? sf2 : f));
    const codes = boardRoundCodes(board, stages, en);
    const feeds = withRoundCodeRefs(
      board,
      { [sf2.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 3 } } } },
      codes,
    );
    expect(feeds[sf2.id]!.home).toEqual({ key: "slot.winner_match", params: { round: 1, seq: 3, code: "QF" } });
    // Through the real card-title path; the other seat falls to TBD untouched.
    expect(cardTitle(sf2, {}, feeds, en)).toBe(`Winner of QF·3 vs ${en("schedule.tbd")}`);
  });

  it("the number after the code is the feeder's own place, whatever order the list arrives in: still 'QF·3'", () => {
    const rows = ko8();
    const sf2 = { ...rows.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null };
    // Reversed: the fourth quarter-final comes first. Counted in arrival order,
    // the third quarter-final would be "QF·2".
    const board = rows.map((f) => (f.id === sf2.id ? sf2 : f)).reverse();
    const codes = boardRoundCodes(board, stages, en);
    expect(board.filter((f) => f.round_no === 1).map((f) => codes.get(f.id)?.refSeq)).toEqual([4, 3, 2, 1]);
    const feeds = withRoundCodeRefs(
      board,
      { [sf2.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 3 } } } },
      codes,
    );
    expect(cardTitle(sf2, { e2: "Bea" }, feeds, en)).toBe("Winner of QF·3 vs Bea");
  });

  it("a STORED slot label (no feed edge) is coded the same way", () => {
    const rows = ko8();
    const final: BoardFixture = {
      ...rows.find((f) => f.id === "ko-r3-1")!,
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_match", params: { round: 2, seq: 1 } },
      away_slot_label: { key: "slot.winner_match", params: { round: 2, seq: 2 } },
    };
    const board = rows.map((f) => (f.id === final.id ? final : f));
    const feeds = withRoundCodeRefs(board, {}, boardRoundCodes(board, stages, en));
    expect(cardTitle(final, {}, feeds, en)).toBe("Winner of SF·1 vs Winner of SF·2");
  });

  it("a loser feed into the bronze match reads 'Loser of SF·1'", () => {
    const rows = ko8();
    const bronze = { ...rows.find((f) => f.third_place)!, home_entrant_id: null };
    const board = rows.map((f) => (f.id === bronze.id ? bronze : f));
    const feeds = withRoundCodeRefs(
      board,
      { [bronze.id]: { home: { key: "slot.loser_match", params: { round: 2, seq: 1 } } } },
      boardRoundCodes(board, stages, en),
    );
    expect(cardTitle(bronze, { e2: "Bea" }, feeds, en)).toBe("Loser of SF·1 vs Bea");
  });

  it("a seat that already has its entrant is left alone", () => {
    const rows = ko8();
    const sf1 = rows.find((f) => f.id === "ko-r2-1")!; // both entrants filled
    const input = { [sf1.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 1 } } as SlotLabel } };
    const feeds = withRoundCodeRefs(rows, input, boardRoundCodes(rows, stages, en));
    expect(feeds[sf1.id]!.home).toEqual({ key: "slot.winner_match", params: { round: 1, seq: 1 } });
  });

  it("a cross-stage ref resolves in its SOURCE stage — never the fixture that happens to sit at {round, seq} in the seat's own stage", () => {
    // The seat is a knockout semi; its feed came from a LEAGUE's round 1
    // match 3 (a `cross_feeds` edge). The knockout has its own QF at (1, 3) —
    // resolving in the seat's stage would print "Winner of QF·3", naming a
    // match that feeds nothing here.
    const ko = ko8();
    const league = [1, 2].flatMap((r) => [1, 2, 3].map((s) => fx({ stage_id: "lg", round_no: r, seq_in_round: s })));
    const sf2 = { ...ko.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null };
    const board = [...league, ...ko.map((f) => (f.id === sf2.id ? sf2 : f))];
    const codes = boardRoundCodes(board, [{ id: "lg", kind: "league" }, ...stages], en);
    const feeds = withRoundCodeRefs(
      board,
      { [sf2.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 3, stage: "lg" } } } },
      codes,
    );
    expect(cardTitle(sf2, { e2: "Bea" }, feeds, en)).toBe("Winner of R1·3 vs Bea");
  });

  it("a cross-stage ref INTO another knockout takes that knockout's code", () => {
    const main = ko8("main", false);
    const plate = ko8("plate", false);
    const plateQf = { ...plate[0]!, home_entrant_id: null };
    const board = [...main, plateQf, ...plate.slice(1)];
    const codes = boardRoundCodes(board, [{ id: "main", kind: "knockout" }, { id: "plate", kind: "knockout" }], en);
    const feeds = withRoundCodeRefs(
      board,
      { [plateQf.id]: { home: { key: "slot.loser_match", params: { round: 1, seq: 3, stage: "main" } } } },
      codes,
    );
    expect(cardTitle(plateQf, { e2: "Bea" }, feeds, en)).toBe("Loser of QF·3 vs Bea");
  });

  it("a ref that names no fixture keeps its plain text; a non-match label is never touched", () => {
    const rows = ko8();
    const sf2 = { ...rows.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null, away_entrant_id: null };
    const board = rows.map((f) => (f.id === sf2.id ? sf2 : f));
    const feeds = withRoundCodeRefs(
      board,
      {
        [sf2.id]: {
          home: { key: "slot.winner_match", params: { round: 9, seq: 9 } },
          away: { key: "slot.winner_group", params: { g: "A" } },
        },
      },
      boardRoundCodes(board, stages, en),
    );
    expect(cardTitle(sf2, {}, feeds, en)).toBe("Winner of R9·9 vs Winner of Group A");
  });

  it("returns the SAME object when nothing is coded (a league-only board costs nothing)", () => {
    const league = [1, 2].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1, home_entrant_id: null }));
    const input = { [league[1]!.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 1 } } as SlotLabel } };
    const codes = boardRoundCodes(league, [{ id: "lg", kind: "league" }], en);
    expect(withRoundCodeRefs(league, input, codes)).toBe(input);
  });

  it("never mutates the feed map it was handed", () => {
    const rows = ko8();
    const sf2 = { ...rows.find((f) => f.id === "ko-r2-2")!, home_entrant_id: null };
    const board = rows.map((f) => (f.id === sf2.id ? sf2 : f));
    const input = { [sf2.id]: { home: { key: "slot.winner_match", params: { round: 1, seq: 3 } } as SlotLabel } };
    const snapshot = JSON.stringify(input);
    withRoundCodeRefs(board, input, boardRoundCodes(board, stages, en));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("roundLegendEntries", () => {
  it("lists each code present ONCE, in bracket order — whatever order the fixtures arrive in", () => {
    const rows = ko8();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    // Ordering differential: final and bronze first, quarter-finals last.
    const shuffled = [...rows].reverse();
    expect(roundLegendEntries(shuffled, codes)).toEqual([
      { code: "QF", label: "Quarter-finals" },
      { code: "SF", label: "Semi-finals" },
      { code: "F", label: "Final" },
      { code: "3rd", label: "Third place" },
    ]);
  });

  it("only the codes on the fixtures it is shown — a day with the final alone lists F alone", () => {
    const rows = ko8();
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(roundLegendEntries(rows.filter((f) => f.id === "ko-r3-1"), codes)).toEqual([{ code: "F", label: "Final" }]);
  });

  it("lists a single bracket's rounds first, then a double elimination's lanes in order WB, LB, GF", () => {
    const de = de8();
    const board = [...de, ...ko16()].reverse();
    const codes = boardRoundCodes(board, [
      { id: "ko", kind: "knockout" },
      { id: "de", kind: "double_elim" },
    ], en);
    expect(roundLegendEntries(board, codes).map((e) => e.code)).toEqual([
      "R16", "QF", "SF", "F", "WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2",
    ]);
  });

  // Review M5 (2026-09-23): the order and the de-duplication, each pinned by a
  // case where the fixture INPUT order differs from the expected legend order,
  // and where the tempting shortcut gives a different answer.
  it("orders by distance from the FINAL across brackets: an 8-knockout's QF follows a 16-knockout's R16", () => {
    // Both are round 1 of their bracket. Ranked by round-in-lane instead of
    // distance from the final they tie, and "Quarter-finals" sorts before
    // "Round of 16" — so the input leads with the QFs to make that visible.
    const small = ko8("small", false);
    const big = ko16("big");
    const stages = [
      { id: "small", kind: "knockout" },
      { id: "big", kind: "knockout" },
    ];
    const codes = boardRoundCodes([...small, ...big], stages, en);
    const shown = [...small.filter((f) => f.round_no === 1), big[0]!];
    expect(roundLegendEntries(shown, codes)).toEqual([
      { code: "R16", label: "Round of 16" },
      { code: "QF", label: "Quarter-finals" },
    ]);
    // The whole of both brackets, in EITHER input order: R16, QF, SF, F.
    for (const board of [
      [...small, ...big],
      [...big, ...small],
    ]) {
      expect(roundLegendEntries(board, codes).map((e) => e.code)).toEqual(["R16", "QF", "SF", "F"]);
    }
  });

  it("nl: the bronze match follows the final even where its NAME sorts first ('Derde plaats' < 'Finale')", () => {
    const nl = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("nl", key, vars);
    expect(nl("bracket.round.thirdPlace").localeCompare(nl("bracket.round.final"))).toBeLessThan(0);
    const rows = [...ko8()].reverse(); // bronze and final first in the input
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], nl);
    expect(roundLegendEntries(rows, codes).map((e) => e.code)).toEqual([
      nl("bracket.roundShort.quarter"),
      nl("bracket.roundShort.semi"),
      nl("bracket.roundShort.final"),
      nl("bracket.roundShort.thirdPlace"),
    ]);
  });

  it("the bracket reset follows its grand final, and GF/GF2 follow every LB round", () => {
    const rows = [...de8()].reverse();
    const codes = boardRoundCodes(rows, [{ id: "de", kind: "double_elim" }], en);
    expect(roundLegendEntries(rows, codes).map((e) => e.code).slice(-3)).toEqual(["LB4", "GF", "GF2"]);
  });

  it("de-duplicates on code AND name: two knockouts' QF list once, but two rounds sharing one code in some locale both list", () => {
    const twoKnockouts = [...ko8("a"), ...ko8("b")];
    const codes = boardRoundCodes(twoKnockouts, [
      { id: "a", kind: "knockout" },
      { id: "b", kind: "knockout" },
    ], en);
    expect(roundLegendEntries(twoKnockouts, codes).map((e) => e.code)).toEqual(["QF", "SF", "F", "3rd"]);
    // A dictionary that abbreviates the quarter- and semi-final alike ("KO"):
    // one entry per CODE would silently explain only one of the two rounds.
    const sharing = (key: MessageKey, vars?: Record<string, string | number>) =>
      key === "bracket.roundShort.quarter" || key === "bracket.roundShort.semi" ? "KO" : en(key, vars);
    const rows = ko8();
    const shared = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], sharing);
    expect(roundLegendEntries(rows, shared)).toEqual([
      { code: "KO", label: "Quarter-finals" },
      { code: "KO", label: "Semi-finals" },
      { code: "F", label: "Final" },
      { code: "3rd", label: "Third place" },
    ]);
  });

  it("is EMPTY for a board with no coded fixtures — the legend row then renders nothing", () => {
    const league = [1, 2].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1 }));
    const codes = boardRoundCodes(league, [{ id: "lg", kind: "league" }], en);
    expect(roundLegendEntries(league, codes)).toEqual([]);
    expect(roundLegendEntries([], codes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Board playoff codes (2026-09-23, owner-approved follow-up to the knockout
// codes): a page playoff reads Q1 / E / Q2 / F and a stepladder E1 … E{n} / F.
// Every bracket below is the REAL engine generator's output, laid out the way
// the board read delivers it — never a hand-typed fixture list — so a change
// to either generator moves these tests with it.
// ---------------------------------------------------------------------------

const entrants = (k: number) => Array.from({ length: k }, (_, i) => `e${i + 1}`);

/** A real engine bracket as `listDivisionFixturesForBoard` delivers it after
 *  `bracketToGen` (stages.ts) persisted it: one lane, so round_no = round + 1,
 *  and seq_in_round counts the round's fixtures in emission order; `is_final`
 *  and `third_place` only where the generator set them; `ext_key` only on a
 *  page-playoff id. A seat fed by another match starts empty. */
function asBoard(stage_id: string, bracket: GeneratedBracket): BoardFixture[] {
  const seqs = new Map<number, number>();
  return bracket.fixtures.map((g) => {
    const round_no = g.round + 1;
    const seq_in_round = (seqs.get(round_no) ?? 0) + 1;
    seqs.set(round_no, seq_in_round);
    return {
      ...fx({ stage_id, round_no, seq_in_round }),
      id: `${stage_id}:${g.id}`,
      home_entrant_id: g.home ?? null,
      away_entrant_id: g.away ?? null,
      ...(g.isFinal ? { is_final: true } : {}),
      ...(g.thirdPlace ? { third_place: true } : {}),
      ...(g.id.startsWith("pp-") ? { ext_key: g.id } : {}),
    };
  });
}

/** The generator's own feed edges, as the board page's feed read carries them. */
function feedRowsOf(bracket: GeneratedBracket, board: BoardFixture[]): FeedRow[] {
  const rowOf = new Map(bracket.fixtures.map((g, i) => [g.id, board[i]!]));
  const rows = new Map<string, FeedRow>(
    board.map((f) => [
      f.id,
      {
        id: f.id,
        stage_id: f.stage_id,
        round_no: f.round_no,
        seq_in_round: f.seq_in_round,
        winner_to_fixture: null,
        winner_to_slot: null,
        loser_to_fixture: null,
        loser_to_slot: null,
      },
    ]),
  );
  for (const g of bracket.fixtures) {
    for (const [from, slot] of [
      [g.homeFrom, 1],
      [g.awayFrom, 2],
    ] as const) {
      if (!from) continue;
      const source = rows.get(rowOf.get(from.fixtureId)!.id)!;
      if (from.side === "winner") {
        source.winner_to_fixture = rowOf.get(g.id)!.id;
        source.winner_to_slot = slot;
      } else {
        source.loser_to_fixture = rowOf.get(g.id)!.id;
        source.loser_to_slot = slot;
      }
    }
  }
  return [...rows.values()];
}

/** What the engine alone makes of these rows — the code a board with NO
 *  legacy fallback would print. `withKey: false` reads them as the board
 *  would without `ext_key`. */
const engineCodes = (rows: BoardFixture[], kind: string, withKey = true) => {
  const laneRows = rows.map((f) => ({ round_no: f.round_no, lane: null }));
  return rows.map((f) =>
    roundRoleShort(
      en,
      roundRoleFor(
        laneRows,
        { round_no: f.round_no, lane: null, is_final: f.is_final === true, third_place: false, conditional: false },
        kind,
        withKey ? (f.ext_key ?? null) : null,
      ),
      { lane: null, roundInLane: laneRoundRank(laneRows, null, f.round_no).roundInLane },
    ),
  );
};

const without = <K extends keyof BoardFixture>(rows: BoardFixture[], key: K, where: (f: BoardFixture) => boolean = () => true) =>
  rows.map((f) => {
    if (!where(f)) return f;
    const copy = { ...f };
    delete copy[key];
    return copy;
  });

const PP_STAGE = [{ id: "pp", kind: "page_playoff" }];
const SL_STAGE = [{ id: "sl", kind: "stepladder" }];
const Q1 = en("bracket.roundShort.qualifier1");
const E = en("bracket.roundShort.eliminator");
const Q2 = en("bracket.roundShort.qualifier2");
const F = en("bracket.roundShort.final");
const ref = (code: string, seq: number) => en("slot.match_ref_code", { code, seq });

describe("boardRoundCodes — page playoff", () => {
  const pp = () => asBoard("pp", generatePagePlayoff({ entrants: entrants(4) }));
  const byKey = (rows: BoardFixture[], codes: ReturnType<typeof boardRoundCodes>, field: "code" | "label" = "code") =>
    Object.fromEntries(rows.map((f) => [f.ext_key ?? f.id, codes.get(f.id)?.[field] ?? null]));

  it("the real 4-entrant generator reads Q1, E, Q2, F — named by its ext_key, never by position", () => {
    const board = pp();
    const codes = boardRoundCodes(board, PP_STAGE, en);
    expect(byKey(board, codes)).toEqual({ "pp-q1": Q1, "pp-elim": E, "pp-q2": Q2, "pp-final": F });
    expect(byKey(board, codes, "label")).toEqual({
      "pp-q1": en("bracket.round.qualifier1"),
      "pp-elim": en("bracket.round.eliminator"),
      "pp-q2": en("bracket.round.qualifier2"),
      "pp-final": en("bracket.round.final"),
    });
    // Qualifier 1 and the Eliminator share round 1 and every flag — the key is
    // the ONLY thing between them, so a code cached per round prints Q1 twice.
    const q1 = board.find((f) => f.ext_key === "pp-q1")!;
    const elim = board.find((f) => f.ext_key === "pp-elim")!;
    expect([q1.round_no, q1.is_final, q1.third_place]).toEqual([elim.round_no, elim.is_final, elim.third_place]);
    // The wrong answer: the same rows read by position.
    expect(engineCodes(board, "page_playoff", false)).toEqual([
      en("bracket.roundShort.quarter"),
      en("bracket.roundShort.quarter"),
      en("bracket.roundShort.semi"),
      F,
    ]);
  });

  it("the same codes whatever order the rows arrive in", () => {
    const board = pp();
    const codes = boardRoundCodes([...board].reverse(), PP_STAGE, en);
    expect(byKey(board, codes)).toEqual({ "pp-q1": Q1, "pp-elim": E, "pp-q2": Q2, "pp-final": F });
  });

  // AGENTS.md class 19: a wrong code is worse than R{n}. Without its keys a
  // page playoff can only be named by position, which is wrong for it.
  it("rows WITHOUT ext_key keep R{n} for the whole stage — even with the final flagged (the pre-change board read)", () => {
    const board = without(pp(), "ext_key");
    // The knockout presence test alone would pass it: the final IS flagged.
    expect(board.some((f) => f.is_final === true)).toBe(true);
    expect(codesOf(board, boardRoundCodes(board, PP_STAGE, en))).toEqual([null, null, null, null]);
  });

  it("a history-restored page playoff (no ext_key, no is_final) keeps R{n}", () => {
    // history.ts re-inserts a stage's fixtures with neither column.
    const board = without(without(pp(), "ext_key"), "is_final");
    expect(boardRoundCodes(board, PP_STAGE, en).size).toBe(0);
  });

  it("ONE row without its key is enough: the whole stage keeps R{n}, never three codes beside a guess", () => {
    const board = without(pp(), "ext_key", (f) => f.ext_key === "pp-q2");
    expect(board.filter((f) => f.ext_key !== undefined)).toHaveLength(3);
    expect(codesOf(board, boardRoundCodes(board, PP_STAGE, en))).toEqual([null, null, null, null]);
  });

  it("a pp-* key the engine does not know counts as no key", () => {
    const board = pp().map((f) => (f.ext_key === "pp-q2" ? { ...f, ext_key: "pp-zz" } : f));
    // What it would print: the unknown key falls through to position — SF.
    expect(engineCodes(board, "page_playoff")[2]).toBe(en("bracket.roundShort.semi"));
    expect(codesOf(board, boardRoundCodes(board, PP_STAGE, en))).toEqual([null, null, null, null]);
  });

  it("a PRE-V368 page playoff (keys, no is_final) IS coded — its names come from keys that predate V368", () => {
    const board = without(pp(), "is_final");
    expect(board.some((f) => f.is_final === true)).toBe(false);
    expect(byKey(board, boardRoundCodes(board, PP_STAGE, en))).toEqual({
      "pp-q1": Q1,
      "pp-elim": E,
      "pp-q2": Q2,
      "pp-final": F,
    });
  });

  it("placeholders over the generator's own feeds: 'Loser of Q1·1 vs Winner of E·1', then 'Winner of Q1·1 vs Winner of Q2·1'", () => {
    const bracket = generatePagePlayoff({ entrants: entrants(4) });
    const board = asBoard("pp", bracket);
    const feeds = withRoundCodeRefs(board, feedLabels(feedRowsOf(bracket, board)), boardRoundCodes(board, PP_STAGE, en));
    const title = (key: string) => cardTitle(board.find((f) => f.ext_key === key)!, {}, feeds, en);
    expect(title("pp-q2")).toBe(
      `${en("slot.loser_match", { ext: ref(Q1, 1) })} vs ${en("slot.winner_match", { ext: ref(E, 1) })}`,
    );
    expect(title("pp-final")).toBe(
      `${en("slot.winner_match", { ext: ref(Q1, 1) })} vs ${en("slot.winner_match", { ext: ref(Q2, 1) })}`,
    );
    // The Eliminator is its round's SECOND match: numbered by round it would
    // read "E·2" — a second Eliminator that does not exist.
    expect(board.find((f) => f.ext_key === "pp-elim")!.seq_in_round).toBe(2);
    expect(title("pp-q2")).not.toContain(ref(E, 2));
  });

  it("withRoundCodeRefs is idempotent: a stamped label is left alone, so the Eliminator never re-resolves as Q1·1", () => {
    const bracket = generatePagePlayoff({ entrants: entrants(4) });
    const board = asBoard("pp", bracket);
    const codes = boardRoundCodes(board, PP_STAGE, en);
    const once = withRoundCodeRefs(board, feedLabels(feedRowsOf(bracket, board)), codes);
    const twice = withRoundCodeRefs(board, once, codes);
    // Re-resolved, the Eliminator's restamped {round 1, seq 1} is Qualifier 1's
    // place: "Loser of Q1·1 vs Winner of Q1·1".
    const q2 = board.find((f) => f.ext_key === "pp-q2")!;
    expect(cardTitle(q2, {}, twice, en)).toBe(
      `${en("slot.loser_match", { ext: ref(Q1, 1) })} vs ${en("slot.winner_match", { ext: ref(E, 1) })}`,
    );
    expect(twice).toBe(once);
  });
});

describe("boardRoundCodes — stepladder", () => {
  for (const k of [3, 4, 5, 6]) {
    it(`the real ${k}-entrant generator reads E1…E${k - 2}, then F on the game it flags final`, () => {
      const bracket = generateStepladder({ entrants: entrants(k) });
      const board = asBoard("sl", bracket);
      const codes = boardRoundCodes(board, SL_STAGE, en);
      expect(board).toHaveLength(k - 1);
      // Expected from the generator: its flagged final reads F, and its j-th
      // game before that is the ladder's rung j — E{j}, "Eliminator {j}".
      expect(board.map((f) => codes.get(f.id)?.code ?? null)).toEqual(
        bracket.fixtures.map((g, j) => (g.isFinal ? F : en("bracket.roundShort.rung", { n: j + 1 }))),
      );
      expect(board.map((f) => codes.get(f.id)?.label ?? null)).toEqual(
        bracket.fixtures.map((g, j) =>
          g.isFinal ? en("bracket.round.final") : en("bracket.round.eliminatorN", { n: j + 1 }),
        ),
      );
      expect(bracket.fixtures.filter((g) => g.isFinal)).toHaveLength(1);
      expect(bracket.fixtures.at(-1)!.isFinal).toBe(true);
    });
  }

  it("a PRE-V368 stepladder (no is_final) keeps R{n} — nothing on its rows shows its final is among them", () => {
    const board = without(asBoard("sl", generateStepladder({ entrants: entrants(4) })), "is_final");
    // What coding it by position would print.
    expect(engineCodes(board, "stepladder")).toEqual([en("bracket.roundShort.rung", { n: 1 }), en("bracket.roundShort.rung", { n: 2 }), F]);
    expect(codesOf(board, boardRoundCodes(board, SL_STAGE, en))).toEqual([null, null, null]);
  });

  it("placeholders: each rung's climber is 'Winner of E{n}·1'", () => {
    const bracket = generateStepladder({ entrants: entrants(4) });
    const board = asBoard("sl", bracket);
    const names = Object.fromEntries(entrants(4).map((e) => [e, e.toUpperCase()]));
    const feeds = withRoundCodeRefs(board, feedLabels(feedRowsOf(bracket, board)), boardRoundCodes(board, SL_STAGE, en));
    const [, rung2, final] = board;
    const e1 = en("bracket.roundShort.rung", { n: 1 });
    const e2 = en("bracket.roundShort.rung", { n: 2 });
    expect(cardTitle(rung2!, names, feeds, en)).toBe(
      `${names[rung2!.home_entrant_id!]} vs ${en("slot.winner_match", { ext: ref(e1, 1) })}`,
    );
    expect(cardTitle(final!, names, feeds, en)).toBe(
      `${names[final!.home_entrant_id!]} vs ${en("slot.winner_match", { ext: ref(e2, 1) })}`,
    );
  });
});

describe("roundLegendEntries — page playoff and stepladder", () => {
  const entry = (code: string, labelKey: MessageKey, vars?: Record<string, number>) => ({
    code,
    label: en(labelKey, vars),
  });

  it("a page playoff lists Q1, E, Q2, F — in either input order, though 'Eliminator' sorts before 'Qualifier 1'", () => {
    const board = asBoard("pp", generatePagePlayoff({ entrants: entrants(4) }));
    // Ordering differential: Q1 and E share a round, and by NAME E comes first.
    expect(en("bracket.round.eliminator").localeCompare(en("bracket.round.qualifier1"))).toBeLessThan(0);
    for (const input of [board, [...board].reverse()]) {
      const codes = boardRoundCodes(input, PP_STAGE, en);
      expect(roundLegendEntries(input, codes)).toEqual([
        entry(Q1, "bracket.round.qualifier1"),
        entry(E, "bracket.round.eliminator"),
        entry(Q2, "bracket.round.qualifier2"),
        entry(F, "bracket.round.final"),
      ]);
    }
  });

  it("a 6-stepladder lists E1, E2, E3, E4, F — reversed input", () => {
    const board = [...asBoard("sl", generateStepladder({ entrants: entrants(6) }))].reverse();
    const codes = boardRoundCodes(board, SL_STAGE, en);
    expect(roundLegendEntries(board, codes)).toEqual([
      ...[1, 2, 3, 4].map((n) => entry(en("bracket.roundShort.rung", { n }), "bracket.round.eliminatorN", { n })),
      entry(F, "bracket.round.final"),
    ]);
  });

  it("a 4-ladder and a 6-ladder on one board list E1, E2, E3, E4, F — in either division order", () => {
    // A rung's code counts from the ladder's START, so E1 is two games before
    // a 4-ladder's final but four before a 6-ladder's. Ordered by distance
    // from the final, whichever ladder's E1 the dedupe kept decided where E1
    // sat: 6-ladder first read E1, E3, E2, E4, F.
    const sl4 = asBoard("sl4", generateStepladder({ entrants: entrants(4) }));
    const sl6 = asBoard("sl6", generateStepladder({ entrants: entrants(6) }));
    const stages = [
      { id: "sl4", kind: "stepladder" },
      { id: "sl6", kind: "stepladder" },
    ];
    const expected = [
      ...[1, 2, 3, 4].map((n) => entry(en("bracket.roundShort.rung", { n }), "bracket.round.eliminatorN", { n })),
      entry(F, "bracket.round.final"),
    ];
    for (const board of [[...sl4, ...sl6], [...sl6, ...sl4]]) {
      expect(roundLegendEntries(board, boardRoundCodes(board, stages, en))).toEqual(expected);
    }
  });

  it("knockout + page playoff + stepladder on one board: each format's rounds as ONE run, the shared F once, last", () => {
    // By distance from the final alone the three would interleave —
    // Q1 E E1 SF Q2 E2 F — splitting both playoffs apart.
    const ko = asBoard("ko", generateSingleElim({ entrants: entrants(4) }));
    const pp = asBoard("pp", generatePagePlayoff({ entrants: entrants(4) }));
    const sl = asBoard("sl", generateStepladder({ entrants: entrants(4) }));
    const stages = [{ id: "ko", kind: "knockout" }, ...PP_STAGE, ...SL_STAGE];
    const expected = [
      entry(en("bracket.roundShort.semi"), "bracket.round.semi"),
      entry(Q1, "bracket.round.qualifier1"),
      entry(E, "bracket.round.eliminator"),
      entry(Q2, "bracket.round.qualifier2"),
      entry(en("bracket.roundShort.rung", { n: 1 }), "bracket.round.eliminatorN", { n: 1 }),
      entry(en("bracket.roundShort.rung", { n: 2 }), "bracket.round.eliminatorN", { n: 2 }),
      entry(F, "bracket.round.final"),
    ];
    for (const board of [[...ko, ...pp, ...sl], [...sl, ...pp, ...ko].reverse(), [...sl, ...ko, ...pp]]) {
      expect(roundLegendEntries(board, boardRoundCodes(board, stages, en))).toEqual(expected);
    }
  });

  it("the page playoff's E and the stepladder's E1 are different rounds: both listed", () => {
    const pp = asBoard("pp", generatePagePlayoff({ entrants: entrants(4) }));
    const sl = asBoard("sl", generateStepladder({ entrants: entrants(3) }));
    const board = [...pp, ...sl];
    const codes = boardRoundCodes(board, [...PP_STAGE, ...SL_STAGE], en);
    const shown = board.filter((f) => ["pp-elim"].includes(f.ext_key ?? "") || f.id === "sl:sl-g0");
    expect(roundLegendEntries(shown, codes)).toEqual([
      entry(E, "bracket.round.eliminator"),
      entry(en("bracket.roundShort.rung", { n: 1 }), "bracket.round.eliminatorN", { n: 1 }),
    ]);
  });

  it("a knockout's bronze still follows the final when a page playoff shares the board", () => {
    const ko = asBoard("ko", generateSingleElim({ entrants: entrants(8), thirdPlace: true }));
    const pp = asBoard("pp", generatePagePlayoff({ entrants: entrants(4) }));
    const board = [...pp, ...ko].reverse();
    const codes = boardRoundCodes(board, [{ id: "ko", kind: "knockout" }, ...PP_STAGE], en);
    expect(roundLegendEntries(board, codes).map((e) => e.code)).toEqual([
      en("bracket.roundShort.quarter"),
      en("bracket.roundShort.semi"),
      Q1,
      E,
      Q2,
      F,
      en("bracket.roundShort.thirdPlace"),
    ]);
  });
});
