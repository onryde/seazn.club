// W5 app PR A, Task 2 (RB5-G7, RB5-L17) — `carrySlotsByPair`: a regenerated round robin keeps each PAIR's time and court wherever
// the regenerate put the pair. The positional `carrySlots` (Rebuild's, X-RB-1) is the differential: it hands the slot to whoever
// now sits at the old position. Expected values are derived by hand from the two layouts below, never from the function.
import { describe, expect, it } from "vitest";
import { carrySlots, carrySlotsByPair } from "../rebuild-slots";

const slot = (n: number) => ({ scheduled_at: `2030-06-1${n}T10:00:00.000Z`, court_id: `court-${n}`, venue_id: null, schedule_locked: false });
const empty = { scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false };

const row = (key: string, round_no: number, seq_in_round: number) => ({ key, pool_id: null, round_no, seq_in_round, ext_key: `rr-r${round_no}-c${seq_in_round}-L1` });

describe("carrySlotsByPair", () => {
  // Before: ab @ r1c1 (slot 1), cd @ r1c2 (slot 2), ac @ r2c1 (slot 3). The regenerate puts them elsewhere: ac first, ab last, cd
  // in the middle, and adds a new pair ad that never had a slot.
  const before = [
    { ...row("ab", 1, 1), ...slot(1) },
    { ...row("cd", 1, 2), ...slot(2) },
    { ...row("ac", 2, 1), ...slot(3) },
  ];
  const after = [
    { ...row("ac", 1, 1), id: "n-ac" },
    { ...row("ad", 1, 2), id: "n-ad" },
    { ...row("cd", 2, 1), id: "n-cd" },
    { ...row("ab", 3, 1), id: "n-ab" },
  ];

  it("each surviving pair keeps its own slot wherever it landed; the new pair is unscheduled; nothing is freed", () => {
    const out = carrySlotsByPair(before, after);
    expect(Object.fromEntries([...out.assign].map(([id, s]) => [id, s.court_id]))).toEqual({
      "n-ac": "court-3",
      "n-cd": "court-2",
      "n-ab": "court-1",
    });
    expect(out.unscheduled).toEqual(["n-ad"]);
    expect(out.freed).toEqual([]);
  });

  it("differential: the positional carry hands r1c1's slot to whoever sits at r1c1 now (ac gets ab's time)", () => {
    const positional = carrySlots(before, after);
    expect(positional.assign.get("n-ac")?.court_id, "positional: ac inherits ab's court").toBe("court-1");
    expect(carrySlotsByPair(before, after).assign.get("n-ac")?.court_id, "by pair: ac keeps ac's").toBe("court-3");
  });

  it("a pair that left frees its slot; a pair without a slot carries nothing", () => {
    const out = carrySlotsByPair(
      [{ ...row("ab", 1, 1), ...slot(1) }, { ...row("cd", 1, 2), ...slot(2) }, { ...row("ef", 2, 1), ...empty }],
      [{ ...row("ab", 1, 1), id: "n-ab" }, { ...row("ef", 2, 1), id: "n-ef" }, { ...row("gh", 3, 1), id: "n-gh" }],
    );
    expect([...out.assign.keys()]).toEqual(["n-ab"]);
    expect(out.freed.map((s) => s.court_id)).toEqual(["court-2"]);
    // ef had no slot and keeps none; gh is a new pair in a stage that had a layout, so it is unscheduled.
    expect(out.unscheduled).toEqual(["n-gh"]);
  });

  it("an empty stage carries nothing and reports nothing (the empty case)", () => {
    const out = carrySlotsByPair([], []);
    expect([out.assign.size, out.freed.length, out.unscheduled.length]).toEqual([0, 0, 0]);
  });

  it("a key twice on the old side: the first claims the slot, the second's is freed, never dropped", () => {
    const out = carrySlotsByPair(
      [{ ...row("ab", 1, 1), ...slot(1) }, { ...row("ab", 2, 1), ...slot(2) }],
      [{ ...row("ab", 1, 1), id: "n-ab" }],
    );
    expect(out.assign.get("n-ab")?.court_id).toBe("court-1");
    expect(out.freed.map((s) => s.court_id)).toEqual(["court-2"]);
  });
});
