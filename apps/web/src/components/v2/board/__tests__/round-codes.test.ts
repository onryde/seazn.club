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
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
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
 *  SF r2 ×2, final r3 seq 1, and the bronze match sharing the final's round
 *  as its seq 2 — lane null throughout. */
function ko8(stage_id = "ko", thirdPlace = true): BoardFixture[] {
  return [
    ...[1, 2, 3, 4].map((s) => fx({ stage_id, round_no: 1, seq_in_round: s })),
    ...[1, 2].map((s) => fx({ stage_id, round_no: 2, seq_in_round: s })),
    fx({ stage_id, round_no: 3, seq_in_round: 1 }),
    ...(thirdPlace ? [fx({ stage_id, round_no: 3, seq_in_round: 2, third_place: true })] : []),
  ];
}

/** An 8-entrant double elimination with a bracket reset — WB 1-3, LB 7-10,
 *  GF 14 and its conditional reset 15 (the lane-offset numbering). */
function de8(stage_id = "de"): BoardFixture[] {
  return [
    ...[1, 2, 3].map((r) => fx({ stage_id, round_no: r, seq_in_round: 1, lane: "WB" })),
    ...[7, 8, 9, 10].map((r) => fx({ stage_id, round_no: r, seq_in_round: 1, lane: "LB" })),
    fx({ stage_id, round_no: 14, seq_in_round: 1, lane: "GF" }),
    fx({ stage_id, round_no: 15, seq_in_round: 1, lane: "GF", conditional: true }),
  ];
}

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
    const rows = [1, 2, 3, 4].map((r) => fx({ stage_id: "ko", round_no: r, seq_in_round: 1 }));
    const codes = boardRoundCodes(rows, [{ id: "ko", kind: "knockout" }], en);
    expect(codesOf(rows, codes)).toEqual(["R16", "QF", "SF", "F"]);
  });

  it("double elimination: WB1-3, LB1-4, GF, GF2", () => {
    const rows = de8();
    const codes = boardRoundCodes(rows, [{ id: "de", kind: "double_elim" }], en);
    expect(codesOf(rows, codes)).toEqual(["WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2"]);
  });

  it("a league keeps no code (the chip stays R{n}); an unknown stage and a page playoff too", () => {
    const league = [1, 2, 3].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1 }));
    // page_playoff: the board payload carries no ext_key, and without it the
    // engine cannot tell Qualifier 1 from the Eliminator — it would call them
    // quarter-finals. Out of scope until a follow-up ships its own codes.
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

  it("orders a bigger bracket's opening round first, then a double elimination's lanes WB, LB, GF", () => {
    const ko16 = [1, 2, 3, 4].map((r) => fx({ stage_id: "ko", round_no: r, seq_in_round: 1 }));
    const de = de8();
    const board = [...de, ...ko16].reverse();
    const codes = boardRoundCodes(board, [
      { id: "ko", kind: "knockout" },
      { id: "de", kind: "double_elim" },
    ], en);
    expect(roundLegendEntries(board, codes).map((e) => e.code)).toEqual([
      "R16", "QF", "SF", "F", "WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2",
    ]);
  });

  it("is EMPTY for a board with no coded fixtures — the legend row then renders nothing", () => {
    const league = [1, 2].map((r) => fx({ stage_id: "lg", round_no: r, seq_in_round: 1 }));
    const codes = boardRoundCodes(league, [{ id: "lg", kind: "league" }], en);
    expect(roundLegendEntries(league, codes)).toEqual([]);
    expect(roundLegendEntries([], codes)).toEqual([]);
  });
});
