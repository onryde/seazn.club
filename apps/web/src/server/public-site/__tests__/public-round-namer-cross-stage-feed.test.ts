// `publicRoundNamer`'s feed map is scoped to ONE STAGE, and this is why.
//
// A feed label carries `{round, seq}` and nothing else, and the namer resolves
// those two numbers inside the SEAT's own stage. `wireCrossFeeds`
// (`usecases/stages.ts`) writes edges that cross stages — a league's match
// feeds a knockout's seat — so a division-wide feed map hands a knockout seat
// a coordinate that means something in the LEAGUE, and the knockout resolves
// it against itself.
//
// Both outcomes of that are worse than the "TBD" this branch exists to remove,
// which is why it is worth a test of its own:
//
//   • the seat's stage has no fixture at that `{round, seq}` → the namer falls
//     through to `resolveSlotLabel`, which renders ui.json's
//     `slot.winner_match` — the ORGANISER BOARD's "Winner of R1·1" — on a
//     public page, the one vocabulary the public surfaces must never print;
//   • the seat's stage DOES hold a fixture there → the seat is named after the
//     wrong match entirely. On the shape below that is the funniest possible
//     result: semi-final 1 would advertise itself as its own feeder.
//
// Pure: no database. The namer is a pure function and the two dictionaries are
// read off disk, so this test drives the real composition with no fixtures on
// both ends of it.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { publicRoundNamer, type NamedFixture } from "../feeder-slot-label";
import type { MessageKey } from "@/lib/messages";

const LEAGUE = "stage-league";
const KO = "stage-knockout";

/** The league's round 1 match 1 — the SOURCE of the cross-stage edge. */
const L1 = "league-r1-m1";
const SEMI_1 = "ko-r1-m1";
const SEMI_2 = "ko-r1-m2";
const FINAL = "ko-r2-m1";

/**
 * League + Finals, exactly as the `league_ko` template ships it, with the two
 * kinds of edge side by side:
 *
 *   • CROSS-STAGE — the league's R1·1 winner feeds semi-final 1's home seat.
 *     This is what `wireCrossFeeds` writes, and what must be ignored here.
 *   • WITHIN-STAGE — each semi-final feeds the final. This must still work,
 *     or the fix is a blanket disable rather than a targeted one.
 *
 * Every seat below is deliberately EMPTY of a stored label, because a stored
 * label wins under `seatLabel`'s precedence and would hide the whole question.
 */
const FIXTURES: NamedFixture[] = [
  {
    id: L1,
    stage_id: LEAGUE,
    round_no: 1,
    seq_in_round: 1,
    winner_to_fixture: SEMI_1,
    winner_to_slot: 1,
  },
  { id: "league-r1-m2", stage_id: LEAGUE, round_no: 1, seq_in_round: 2 },
  {
    id: SEMI_1,
    stage_id: KO,
    round_no: 1,
    seq_in_round: 1,
    winner_to_fixture: FINAL,
    winner_to_slot: 1,
  },
  {
    id: SEMI_2,
    stage_id: KO,
    round_no: 1,
    seq_in_round: 2,
    winner_to_fixture: FINAL,
    winner_to_slot: 2,
  },
  { id: FINAL, stage_id: KO, round_no: 2, seq_in_round: 1, is_final: true },
];

const KIND: Record<string, string> = { [LEAGUE]: "league", [KO]: "knockout" };

async function namer(locale: "en" | "fr" = "en") {
  const ui = (k: MessageKey, v?: Record<string, string | number>) => msgFor(locale, k, v);
  return {
    ui,
    n: publicRoundNamer({
      ui,
      dict: await getDictionary(locale, "public"),
      fixtures: FIXTURES,
      stageKind: (stageId) => KIND[stageId],
    }),
  };
}

describe("publicRoundNamer — a cross-stage feed edge never names a seat", () => {
  it("drops the league's edge into the knockout, leaving the seat's own 'to be decided'", async () => {
    const { n, ui } = await namer();

    // THE PREMISE, stated rather than assumed. Without the per-stage scoping
    // the league's edge would reach semi-final 1's home seat as
    // `{round: 1, seq: 1}` — the LEAGUE's coordinate — and the knockout's own
    // round 1 match 1 is semi-final 1 itself. Naming that is the failure this
    // test exists for, so the sentence is composed here from the namer's OWN
    // round name and asserted ABSENT below.
    const koRound1 = n.roundLabel(SEMI_1);
    expect(koRound1, "the knockout's round 1 has no name — nothing below can be wrong").not.toBeNull();
    const dict = await getDictionary("en", "public");
    const selfNamed = t(dict, "knockout.feederWinner", { round: koRound1!, seq: 1 });
    // And the other outcome: the board's own sentence for the same label, the
    // one `resolveSlotLabel` prints when the round lookup misses.
    const boardText = resolveSlotLabel(
      { key: "slot.winner_match", params: { round: 1, seq: 1 } },
      ui,
      "schedule.tbd",
    );
    expect(boardText, "the premise: the board sentence is not the public one").not.toBe(selfNamed);

    const seat = n.seat(SEMI_1, "home", null);
    expect(seat, "a cross-stage edge named a public seat").not.toBe(selfNamed);
    expect(seat, "the organiser board's vocabulary reached a public seat").not.toBe(boardText);
    expect(seat, "an unfed public seat should read this surface's own TBD").toBe(
      msgFor("en", "schedule.tbd"),
    );
    // The label itself, one step earlier — so a caller that owns its own TBD
    // word (`seatLabelOf`, the bracket) is covered by the same claim.
    expect(n.seatLabelOf(SEMI_1, "home", null), "the cross-stage label survived into the bracket").toBeNull();
  });

  it("still names a seat its own stage feeds, so the drop is targeted", async () => {
    const { n } = await namer();
    const dict = await getDictionary("en", "public");
    const koRound1 = n.roundLabel(SEMI_1)!;

    for (const [which, seq] of [
      ["home", 1],
      ["away", 2],
    ] as const) {
      expect(n.seat(FINAL, which, null), `the final's ${which} seat lost its own semi`).toBe(
        t(dict, "knockout.feederWinner", { round: koRound1, seq }),
      );
    }
  });

  it("fr: the same, in the org's locale, so neither assertion is an English accident", async () => {
    const { n } = await namer("fr");
    const dict = await getDictionary("fr", "public");
    const koRound1 = n.roundLabel(SEMI_1)!;
    const expected = t(dict, "knockout.feederWinner", { round: koRound1, seq: 1 });
    expect(expected, "the premise: the fr sentence is not the English one").not.toBe(
      t(await getDictionary("en", "public"), "knockout.feederWinner", {
        round: msgFor("en", "bracket.round.semi"),
        seq: 1,
      }),
    );
    expect(n.seat(FINAL, "home", null)).toBe(expected);
    expect(n.seat(SEMI_1, "home", null)).toBe(msgFor("fr", "schedule.tbd"));
  });
});
