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
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

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
    expect(optionsForSlot("f1:home", qualifiers, ties, new Map(), allEntrantIds, [])).toEqual(["e1", "e3"]);
  });

  it("a departed entrant is not offered on a non-tied slot — the 422 is the backstop, not the menu", () => {
    // `confirmSeedProposal` refuses a withdrawn/disqualified entrant with a
    // 422 SEEDING_ENTRANT_WITHDRAWN, so offering e3 here is a menu entry whose
    // only outcome is a refusal. e4 (still in the field) must stay, or the
    // filter would be indistinguishable from one that empties the list.
    expect(optionsForSlot("f1:home", qualifiers, [], new Map(), allEntrantIds, ["e3"])).toEqual([
      "e1",
      "e4",
    ]);
  });

  it("a departed entrant is not offered on a TIED slot either", () => {
    const ties: TieOut[] = [{ slots: ["f1:home"], entrantIds: ["e1", "e3"], reason: "seed" }];
    expect(optionsForSlot("f1:home", qualifiers, ties, new Map(), allEntrantIds, ["e3"])).toEqual([
      "e1",
    ]);
  });

  it("the row's OWN current occupant stays offered even after departing", () => {
    // A draft computed BEFORE the withdrawal still names her. Dropping her
    // would leave the <select> holding a `value` it does not offer, which
    // renders as if the slot were empty — a slot that is not empty, and one
    // the organiser has to see in order to change it.
    expect(optionsForSlot("f1:home", qualifiers, [], new Map(), allEntrantIds, ["e1"])).toEqual([
      "e1",
      "e3",
      "e4",
    ]);
    // …and only for HER OWN row: e1 is f1:home's occupant, so f1:away must
    // still drop her. (f1:away's own occupant e2 is exempt there by the same
    // rule; e1 is excluded here by `usedElsewhere` AND by the departure, so
    // this also pins that the exemption is per-slot, not global.)
    expect(optionsForSlot("f1:away", qualifiers, [], new Map(), allEntrantIds, ["e1"])).toEqual([
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("a non-tied slot offers every division entrant NOT currently placed in a different slot", () => {
    // e2 currently occupies f1:away, so it's excluded from f1:home's options;
    // e1 (f1:home's OWN current occupant) and the untouched e3/e4 remain.
    expect(optionsForSlot("f1:home", qualifiers, [], new Map(), allEntrantIds, [])).toEqual(["e1", "e3", "e4"]);
  });

  it("an edit elsewhere changes who's 'used' — the edited-IN entrant is excluded from other rows, the edited-OUT one is freed", () => {
    // f1:away edited from e2 -> e4: now e4 is used-elsewhere (excluded from
    // f1:home's options) and e2 is free again.
    const edits = new Map([["f1:away", "e4"]]);
    expect(optionsForSlot("f1:home", qualifiers, [], edits, allEntrantIds, [])).toEqual(["e1", "e2", "e3"]);
  });

  it("REVIEW FINDING 1 (fix round 1): a TIED slot's options exclude an entrant already picked for a SIBLING tied slot drawing from the SAME pool", () => {
    // The multi-slot-tie shape the e2e drives: one TieOut spanning both
    // destination slots, all 4 candidates eligible for either. Before the
    // fix, the tied branch returned `tie.entrantIds` unfiltered — a
    // duplicate pick was reachable (allTiesResolved only checks slot
    // COVERAGE, not uniqueness, so Confirm would enable and the server
    // would 422 SEEDING_SLOT_DOUBLE_ASSIGNED).
    const ties: TieOut[] = [{ slots: ["f1:home", "f1:away"], entrantIds: ["e1", "e2", "e3", "e4"], reason: "seed" }];

    // Before any edit, NEITHER tied slot's computed default counts as "held"
    // by the other — fix round 3, Critical 2 (see optionsForSlot's own doc
    // comment): a tied slot's default is excluded from `effective` until
    // `editsBySlot` names it explicitly, so both rows offer the full pool.
    expect(optionsForSlot("f1:home", qualifiers, ties, new Map(), allEntrantIds, [])).toEqual(["e1", "e2", "e3", "e4"]);
    expect(optionsForSlot("f1:away", qualifiers, ties, new Map(), allEntrantIds, [])).toEqual(["e1", "e2", "e3", "e4"]);

    // An explicit edit on f1:home to e3 must remove e3 from f1:away's
    // options — the exact duplicate-pick path the review flagged.
    const edits = new Map([["f1:home", "e3"]]);
    const awayOptions = optionsForSlot("f1:away", qualifiers, ties, edits, allEntrantIds, []);
    expect(awayOptions).not.toContain("e3");
    expect(awayOptions).toEqual(["e1", "e2", "e4"]);

    // f1:home's OWN list still offers e3 — it's that row's own current
    // pick, never excluded from itself (same rule the non-tied branch has
    // always followed).
    expect(optionsForSlot("f1:home", qualifiers, ties, edits, allEntrantIds, [])).toContain("e3");
  });

  it("REVIEW FINDING (fix round 3, Critical 2): a 2-entrant tie across 2 slots — the commonest real shape (two teams level in a group; stage-seeding.ts's resolveQualifiers builds ties this shape at stage-seeding.ts:355) — offers BOTH candidates in EACH row before any edit, never silently collapsing to one", () => {
    // `effective` used to seed EVERY qualifier's computed default
    // unconditionally, including tied slots the UI itself still renders as
    // unpicked (value=""). With only 2 candidates, each row's own default
    // was implicitly "held" by the other row before the organiser touched
    // anything — leaving exactly ONE option per row, so Confirm could only
    // ever rubber-stamp the engine's arbitrary tie-break order. A tied slot
    // must stay OUT of `effective` until `editsBySlot` holds an explicit
    // pick for it.
    const tiedQualifiers: QualifierOut[] = [
      { rank: 1, source: { stageId: "s1", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
      { rank: 2, source: { stageId: "s1", rank: 2 }, entrantId: "e2", destinationSlot: "f1:away" },
    ];
    const ties: TieOut[] = [{ slots: ["f1:home", "f1:away"], entrantIds: ["e1", "e2"], reason: "seed" }];

    // Before any edit: BOTH rows offer BOTH candidates — a real choice, not
    // a single pre-narrowed option.
    expect(optionsForSlot("f1:home", tiedQualifiers, ties, new Map(), ["e1", "e2"], [])).toEqual(["e1", "e2"]);
    expect(optionsForSlot("f1:away", tiedQualifiers, ties, new Map(), ["e1", "e2"], [])).toEqual(["e1", "e2"]);

    // The first EXPLICIT pick immediately narrows the sibling — double-
    // assignment stays closed, verified rather than assumed.
    const edits = new Map([["f1:home", "e2"]]);
    expect(optionsForSlot("f1:away", tiedQualifiers, ties, edits, ["e1", "e2"], [])).toEqual(["e1"]);
    // f1:home's own list still offers both — its own current pick is never
    // excluded from itself.
    expect(optionsForSlot("f1:home", tiedQualifiers, ties, edits, ["e1", "e2"], [])).toEqual(["e1", "e2"]);
  });
});

describe("dictionary hygiene — progression.tiedBadge is dead (review finding 4, P6/D4b task B fix round 1)", () => {
  // Only `progression.tiedHint` is ever read (progression-panel.tsx:327,
  // `{tied && <p ...>{msg("progression.tiedHint")}</p>}`) — `tiedBadge` was
  // authored alongside it in all 4 dictionaries and the generated key union
  // but never wired to a render. Proven per-locale, not just on en, so a
  // partial cleanup (three locales fixed, one missed) still fails this.
  const DICTS: Record<string, Record<string, unknown>> = { en, es, fr, nl };

  for (const [locale, dict] of Object.entries(DICTS)) {
    it(`${locale}: ui.json has no progression.tiedBadge entry`, () => {
      expect(Object.prototype.hasOwnProperty.call(dict, "progression.tiedBadge")).toBe(false);
    });

    // Control: proves the assertion above isn't vacuous by construction (a
    // typo'd key name would pass trivially) — its sibling, which the
    // component DOES render, must still be present.
    it(`${locale}: ui.json still has progression.tiedHint (the one actually rendered)`, () => {
      expect(Object.prototype.hasOwnProperty.call(dict, "progression.tiedHint")).toBe(true);
    });
  }
});
