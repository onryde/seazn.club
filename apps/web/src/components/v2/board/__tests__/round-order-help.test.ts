// `warn.order` covers two different facts: a bracket's feeder edge, and a
// round-sequence (league, group, Swiss) played out of order. The code-level help
// and label speak only of feeding, which a Swiss organiser was shown for rounds
// that feed nothing.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { roundOrderText, type FormatMsg } from "../conflict-detail-format";
import type { BoardConflictDetail } from "../types";

const msg: FormatMsg = (key, vars) =>
  Object.entries(vars ?? {}).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    (en as Record<string, string>)[key] ?? key,
  );
const ctx = { msg, entrantNames: {}, fixtureTitles: { f9: "R2 M1" } };

describe("roundOrderText", () => {
  const kinds = ["round_order_day", "round_order_same_day", "round_order_end", "no_slot_round_barrier"] as const;

  it("words every round-order kind in rounds, never in feeding", () => {
    let checked = 0;
    for (const kind of kinds) {
      const text = roundOrderText(
        { kind, round_no: 1, other_round_no: 2, day: "2026-11-26", other_day: "2026-11-27", other_fixture_id: "f9" } as BoardConflictDetail,
        ctx,
      );
      expect(text?.help).toMatch(/round 1/i);
      expect(text?.help).not.toMatch(/feed/i);
      expect(text?.label).toBe("out of round order");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("leaves a feeder conflict and a detail-less one to the code-level wording", () => {
    expect(roundOrderText({ kind: "order_before_feeder", other_fixture_id: "f9" } as BoardConflictDetail, ctx)).toBeNull();
    expect(roundOrderText(undefined, ctx)).toBeNull();
  });

  it("has the label in all four locales", () => {
    for (const dict of [en, es, fr, nl]) {
      expect((dict as Record<string, string>)["board.conflict.warn.round_order"]).toBeTruthy();
    }
  });
});
