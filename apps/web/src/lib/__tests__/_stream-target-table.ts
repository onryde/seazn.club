// lib/__tests__/_stream-target-table.ts — NOT a test file. THE table of the fixture's stream destination (§6.7.3, n1,
// T36; B8 review I-1, controller ruling: ONE default-target resolver, no write on view), shared by its three readers so
// they answer ONE question:
//  - the pure resolver (`stream-destinations.test.ts`);
//  - the DB agreement (`stream-target-agreement.test.ts`): the read model, the phone's descriptor and the phone's own
//    start all name the row's answer — or all name none, and the start is 409 no_destination;
//  - the panel (`fixture-stream-panel.test.tsx`): the picker shows the row's answer, and Go live is held on none.
//
// The expected values are written out from the rule text, never computed:
//  - no live destination → none ("nothing to stream to");
//  - a saved choice that is still live → that choice;
//  - a saved choice that was cleared, archived in Directory, or is not one of the org's → NONE — n1: a choice that was
//    removed is cleared, never swapped for another destination (streaming to one nobody chose is the worse mistake);
//  - no saved row at all (nobody has chosen yet) → the org's OLDEST live destination.
//
// The live destinations are named by age: "A" is the oldest, "B" the newer. A "live" saved shape points at the NEWEST
// live one, so with two the saved answer (B) differs from the default's (A) — the table can tell them apart.

/** The fixture's saved row, as a shape: none, its target cleared (null), still live, archived, or another org's. */
export type SavedShape = "none" | "cleared" | "live" | "archived" | "unknown";
export type TargetName = "A" | "B";
export type TargetRow = {
  readonly saved: SavedShape;
  /** The org's live destinations, oldest first. */
  readonly live: readonly TargetName[];
  /** The answer: the destination and why it was chosen, or none. */
  readonly expect: { readonly pick: TargetName; readonly source: "saved" | "default" } | null;
};

const NONE = null;
export const STREAM_TARGET_TABLE: readonly TargetRow[] = [
  // The empty case first: no live destination — nothing, whatever was saved.
  { saved: "none", live: [], expect: NONE },
  { saved: "cleared", live: [], expect: NONE },
  { saved: "live", live: [], expect: NONE },          // impossible in the DB (live means listed): the resolver's guard
  { saved: "archived", live: [], expect: NONE },
  { saved: "unknown", live: [], expect: NONE },
  // One live destination.
  { saved: "none", live: ["A"], expect: { pick: "A", source: "default" } },
  { saved: "cleared", live: ["A"], expect: NONE },
  { saved: "live", live: ["A"], expect: { pick: "A", source: "saved" } },
  { saved: "archived", live: ["A"], expect: NONE },
  { saved: "unknown", live: ["A"], expect: NONE },
  // Two: the default (A, the oldest) and the saved choice (B) differ.
  { saved: "none", live: ["A", "B"], expect: { pick: "A", source: "default" } },
  { saved: "cleared", live: ["A", "B"], expect: NONE },
  { saved: "live", live: ["A", "B"], expect: { pick: "B", source: "saved" } },
  { saved: "archived", live: ["A", "B"], expect: NONE },
  { saved: "unknown", live: ["A", "B"], expect: NONE },
];

/** 5 saved shapes × {0, 1, 2} live destinations. */
export const STREAM_TARGET_TABLE_ROWS = 15;

export const rowName = (r: TargetRow): string => `saved ${r.saved}, live [${r.live.join(",")}]`;

/** The DB cannot hold a saved "live" choice with no live destination: live means listed. */
export const constructible = (r: TargetRow): boolean => !(r.saved === "live" && r.live.length === 0);
