// Slot-label resolver (P6/D4b, task A1). The ONE place `SlotLabel | null`
// ({key, params} jsonb from fixtures.home/away_slot_label, V360) becomes
// display text. Both entry points — useMsg() client-side, msgFor() server
// side — are plain `(key, vars?) => string` lookups, so the resolver takes
// one as a parameter and never imports either itself (stays client-safe).
import { describe, expect, it, vi } from "vitest";
import { matchRef, resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { msgFor } from "@/lib/messages-i18n";
import { LOCALES } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

describe("resolveSlotLabel — mechanics (mocked lookup, no real dictionary)", () => {
  it("never concatenates: the return value is exactly what lookup produced, untouched", () => {
    const lookup = vi.fn(() => "SENTINEL_VALUE_NOT_A_TEMPLATE");
    const label: SlotLabel = { key: "slot.winner_group", params: { g: "A" } };
    expect(resolveSlotLabel(label, lookup, "schedule.tbd")).toBe("SENTINEL_VALUE_NOT_A_TEMPLATE");
  });

  it("passes the label's own key straight through to lookup, unmodified", () => {
    const lookup = vi.fn(() => "");
    const label: SlotLabel = { key: "slot.best_nth", params: { rank: 2, nth: 3 } };
    resolveSlotLabel(label, lookup, "schedule.tbd");
    expect(lookup).toHaveBeenCalledWith("slot.best_nth", { rank: 2, nth: 3 });
  });

  it("coerces non-string/number param values via String() — never drops or JSON-stringifies them", () => {
    const lookup = vi.fn(() => "");
    // params is Record<string, unknown> at the type level (raw jsonb) — a
    // boolean/null slipping in must not throw or silently vanish.
    const label = { key: "slot.rank_range", params: { rank: true } } as unknown as SlotLabel;
    resolveSlotLabel(label, lookup, "schedule.tbd");
    expect(lookup).toHaveBeenCalledWith("slot.rank_range", { rank: "true" });
  });

  it("a null label calls the caller-supplied fallback key with no vars — never a literal \"TBD\"", () => {
    const lookup = vi.fn(() => "À déterminer");
    expect(resolveSlotLabel(null, lookup, "bracket.tbd")).toBe("À déterminer");
    expect(lookup).toHaveBeenCalledWith("bracket.tbd"); // called with 1 arg — no vars object at all
    expect(lookup.mock.calls[0]).toHaveLength(1);
    expect(lookup).not.toHaveBeenCalledWith(expect.stringMatching(/TBD/i), expect.anything());
  });

  it("different call sites can choose different existing fallback keys (schedule.tbd vs bracket.tbd) — resolver invents neither", () => {
    const lookup = vi.fn((k: MessageKey) => k);
    expect(resolveSlotLabel(null, lookup, "schedule.tbd")).toBe("schedule.tbd");
    expect(resolveSlotLabel(null, lookup, "bracket.tbd")).toBe("bracket.tbd");
    expect(resolveSlotLabel(null, lookup, "me.tbd")).toBe("me.tbd");
  });
});

describe("resolveSlotLabel — real dictionaries, all 4 locales, every slot.* key", () => {
  // One case per pattern in the design's "Label vocabulary" section. The two
  // match-reuse keys (winner_match/loser_match) are added by task A2 — this
  // list is deliberately the full vocabulary, not just the five that predate
  // this session, so a missing/half-added locale key fails HERE.
  //
  // P7/F1: winner_match/loser_match params are {round, seq} (numbers), not a
  // pre-rendered {ext} string — resolveSlotLabel composes {ext} internally
  // via matchRef()/slot.match_ref. See the dedicated composition describe
  // block below for the exact-text assertions that prove that substitution.
  const cases: SlotLabel[] = [
    { key: "slot.winner_group", params: { g: "A" } },
    { key: "slot.runner_up_group", params: { g: "B" } },
    { key: "slot.nth_group", params: { n: 3, g: "C" } },
    { key: "slot.best_nth", params: { rank: 2, nth: 3 } },
    { key: "slot.rank_range", params: { rank: 5 } },
    { key: "slot.winner_match", params: { round: 2, seq: 1 } },
    { key: "slot.loser_match", params: { round: 1, seq: 3 } },
  ];

  for (const locale of LOCALES) {
    for (const label of cases) {
      it(`${locale}: ${label.key} resolves via msgFor with every param substituted, no leftover placeholder`, () => {
        const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);
        const out = resolveSlotLabel(label, lookup, "schedule.tbd");
        expect(out).not.toMatch(/\{[a-zA-Z]+\}/); // no unfilled {placeholder}
        expect(out).not.toBe(label.key); // actually found in the dict, not a miss-fallback
        expect(out.length).toBeGreaterThan(0);
      });
    }
  }

  it("null resolves to real per-locale fallback text, not the key and not hardcoded English", () => {
    for (const locale of LOCALES) {
      const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);
      const out = resolveSlotLabel(null, lookup, "schedule.tbd");
      expect(out).not.toBe("schedule.tbd");
      expect(out.length).toBeGreaterThan(0);
    }
    // Locales actually differ from English (proves it's really localized).
    const en: SlotLabelLookup = (k, vars) => msgFor("en", k, vars);
    const nl: SlotLabelLookup = (k, vars) => msgFor("nl", k, vars);
    expect(resolveSlotLabel(null, nl, "schedule.tbd")).not.toBe(resolveSlotLabel(null, en, "schedule.tbd"));
  });
});

// P7/F1: one composition point for the match ref, so the board card's short
// code and the "Winner of …"/"Loser of …" feed text cannot drift onto two
// formats. `matchRef()` is what schedule-board.tsx's consoleFixtures() calls
// for the card's own `code` field; resolveSlotLabel() calls it internally for
// slot.winner_match/slot.loser_match's {ext}. Same {round, seq} in, same ref
// text out, on both sides — that equality is what these tests pin.
describe("resolveSlotLabel — slot.match_ref composition (P7/F1)", () => {
  it("en: composes the exact pinned text — 'R{round}·{seq}', middle dot, no space", () => {
    const lookup: SlotLabelLookup = (k, vars) => msgFor("en", k, vars);
    expect(matchRef(2, 1, lookup)).toBe("R2·1");
    expect(resolveSlotLabel({ key: "slot.winner_match", params: { round: 2, seq: 1 } }, lookup, "schedule.tbd")).toBe(
      "Winner of R2·1",
    );
    expect(resolveSlotLabel({ key: "slot.loser_match", params: { round: 1, seq: 3 } }, lookup, "schedule.tbd")).toBe(
      "Loser of R1·3",
    );
  });

  for (const locale of LOCALES) {
    it(`${locale}: slot.winner_match's {ext} is EXACTLY matchRef()'s own output — the anti-drift invariant`, () => {
      const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);
      // The "expected" side is composed independently, straight off msgFor —
      // not by calling resolveSlotLabel/matchRef again — so a regression in
      // EITHER function's composition (not just a mismatch between them)
      // still fails this.
      const ref = msgFor(locale, "slot.match_ref", { round: 4, seq: 2 });
      const expected = msgFor(locale, "slot.winner_match", { ext: ref });
      expect(matchRef(4, 2, lookup)).toBe(ref);
      const out = resolveSlotLabel({ key: "slot.winner_match", params: { round: 4, seq: 2 } }, lookup, "schedule.tbd");
      expect(out).toBe(expected);
      expect(out).toContain(ref); // the card's own ref text is a literal substring of the feed label
    });

    it(`${locale}: slot.loser_match's {ext} is EXACTLY matchRef()'s own output`, () => {
      const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);
      const ref = msgFor(locale, "slot.match_ref", { round: 1, seq: 5 });
      const expected = msgFor(locale, "slot.loser_match", { ext: ref });
      const out = resolveSlotLabel({ key: "slot.loser_match", params: { round: 1, seq: 5 } }, lookup, "schedule.tbd");
      expect(out).toBe(expected);
      expect(out).toContain(ref);
    });
  }
});
