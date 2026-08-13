// Pure logic behind ProgressionPanel (P6/D4b task B scope item 1). No DOM —
// mirrors stages-panel.tsx's generatePreconditionMessage convention: the
// gating/payload-building logic is exported and tested directly, independent
// of rendering. Acceptance criteria this file proves: "tie-pick gating
// (confirm disabled until every tie resolved)" and "edit-in-place producing a
// well-formed edits[]".
import { describe, expect, it, vi } from "vitest";
import {
  allTiesResolved,
  buildEditsPayload,
  destinationSlotLabelText,
  formatQualifierSource,
  optionsForSlot,
  type QualifierOut,
  type TieOut,
} from "@/components/v2/progression-panel";
import type { MessageKey } from "@/lib/messages";

describe("allTiesResolved — confirm gating", () => {
  it("no ties at all -> resolved (nothing to gate on)", () => {
    expect(allTiesResolved([], new Map())).toBe(true);
  });

  it("a single-slot tie with NO edit yet -> unresolved", () => {
    const ties: TieOut[] = [{ slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" }];
    expect(allTiesResolved(ties, new Map())).toBe(false);
  });

  it("a single-slot tie with its slot edited -> resolved", () => {
    const ties: TieOut[] = [{ slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" }];
    expect(allTiesResolved(ties, new Map([["f1:home", "e2"]]))).toBe(true);
  });

  it("a two-slot tie needs BOTH slots edited — one alone is still unresolved", () => {
    const ties: TieOut[] = [{ slots: ["f1:home", "f2:away"], entrantIds: ["e1", "e2", "e3", "e4"], reason: "seed" }];
    expect(allTiesResolved(ties, new Map([["f1:home", "e1"]]))).toBe(false);
    expect(
      allTiesResolved(ties, new Map([["f1:home", "e1"], ["f2:away", "e3"]])),
    ).toBe(true);
  });

  it("multiple ties: ALL must be resolved, not just one", () => {
    const ties: TieOut[] = [
      { slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" },
      { slots: ["f3:away"], entrantIds: ["e5", "e6"], reason: "seed" },
    ];
    expect(allTiesResolved(ties, new Map([["f1:home", "e2"]]))).toBe(false);
    expect(
      allTiesResolved(ties, new Map([["f1:home", "e2"], ["f3:away", "e6"]])),
    ).toBe(true);
  });

  it("an edit on an UNRELATED slot does not resolve a tie", () => {
    const ties: TieOut[] = [{ slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" }];
    expect(allTiesResolved(ties, new Map([["f9:home", "e9"]]))).toBe(false);
  });
});

describe("buildEditsPayload — well-formed edits[]", () => {
  it("an empty map produces an empty array", () => {
    expect(buildEditsPayload(new Map())).toEqual([]);
  });

  it("each entry becomes exactly one {destinationSlot, entrantId} object, key/value in the right slots", () => {
    const edits = new Map([
      ["f1:home", "e2"],
      ["f2:away", "e5"],
    ]);
    expect(buildEditsPayload(edits)).toEqual([
      { destinationSlot: "f1:home", entrantId: "e2" },
      { destinationSlot: "f2:away", entrantId: "e5" },
    ]);
  });

  it("never emits an entry for an unset (undefined-value) key — Map iteration only ever yields real entries, proved here so a future refactor to a plain object cannot silently reintroduce one", () => {
    const edits = new Map<string, string>();
    edits.set("f1:home", "e2");
    edits.delete("f1:home");
    expect(buildEditsPayload(edits)).toEqual([]);
  });
});

describe("destinationSlotLabelText — reuses task A's resolveSlotLabel, never re-implements", () => {
  const fixtures = [
    { id: "f1", home_slot_label: { key: "slot.winner_group", params: { g: "A" } }, away_slot_label: null },
    { id: "f2", home_slot_label: null, away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } } },
  ];

  it("resolves the HOME label of the named fixture", () => {
    const lookup = vi.fn((k: MessageKey) => `[${k}]`);
    expect(destinationSlotLabelText("f1:home", fixtures, lookup, "schedule.tbd")).toBe("[slot.winner_group]");
  });

  it("resolves the AWAY label of the named fixture", () => {
    const lookup = vi.fn((k: MessageKey) => `[${k}]`);
    expect(destinationSlotLabelText("f2:away", fixtures, lookup, "schedule.tbd")).toBe("[slot.runner_up_group]");
  });

  it("an unknown fixture id falls back exactly like a null label — the caller's fallback key, not a thrown error", () => {
    const lookup = vi.fn((k: MessageKey) => `[${k}]`);
    expect(destinationSlotLabelText("ghost:home", fixtures, lookup, "schedule.tbd")).toBe("[schedule.tbd]");
  });
});

describe("formatQualifierSource", () => {
  const msg = (key: MessageKey, vars?: Record<string, string | number>) =>
    `${key}(${JSON.stringify(vars ?? {})})`;

  it("a group_rank source names the stage, the pool letter, and the rank", () => {
    const out = formatQualifierSource({ stageId: "s1", group: "A", rank: 1 }, { s1: "Groups" }, msg);
    expect(out).toBe('progression.sourceGroupRank({"stage":"Groups","group":"A","rank":1})');
  });

  it("a rank_range/bestNth source (no group) names the stage and the rank only", () => {
    const out = formatQualifierSource({ stageId: "s1", rank: 3 }, { s1: "League" }, msg);
    expect(out).toBe('progression.sourceRank({"stage":"League","rank":3})');
  });

  it("an unknown stage id falls back to '?' rather than a blank/undefined string", () => {
    const out = formatQualifierSource({ stageId: "ghost", rank: 1 }, {}, msg);
    expect(out).toContain('"stage":"?"');
  });
});

describe("optionsForSlot — candidate entrants offered per row", () => {
  const qualifiers: QualifierOut[] = [
    { rank: 1, source: { stageId: "s1", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
    { rank: 2, source: { stageId: "s1", rank: 2 }, entrantId: "e2", destinationSlot: "f1:away" },
  ];
  const allEntrantIds = ["e1", "e2", "e3", "e4"];

  it("a TIED slot offers exactly the tie's own candidates — not the whole division", () => {
    const ties: TieOut[] = [{ slots: ["f1:home"], entrantIds: ["e1", "e3"], reason: "seed" }];
    expect(optionsForSlot("f1:home", qualifiers, ties, new Map(), allEntrantIds)).toEqual(["e1", "e3"]);
  });

  it("a non-tied slot offers every division entrant NOT currently placed in a different slot", () => {
    // e2 currently occupies f1:away, so it's excluded from f1:home's options;
    // e1 (f1:home's OWN current occupant) and the untouched e3/e4 remain.
    expect(optionsForSlot("f1:home", qualifiers, [], new Map(), allEntrantIds)).toEqual(["e1", "e3", "e4"]);
  });

  it("an edit elsewhere changes who's 'used' — the edited-IN entrant is excluded from other rows, the edited-OUT one is freed", () => {
    // f1:away edited from e2 -> e4: now e4 is used-elsewhere (excluded from
    // f1:home's options) and e2 is free again.
    const edits = new Map([["f1:away", "e4"]]);
    expect(optionsForSlot("f1:home", qualifiers, [], edits, allEntrantIds)).toEqual(["e1", "e2", "e3"]);
  });
});
