import { describe, expect, it, vi } from "vitest";

// guard.ts is server-only and imports the DB client at module load; the pure
// name resolver under test touches neither.
vi.mock("server-only", () => ({}));

import { entrantDisplayName } from "@/lib/entrant-name";
import { sideDisplayName } from "../guard";

describe("sideDisplayName (F5 — the 'Entry 3' defect, entrant-name.ts:8-9)", () => {
  it("an individual entrant with one member renders the PERSON, not the snapshot", () => {
    const row = {
      snapshotName: "Entry 3",
      kind: "individual",
      members: [{ person_id: "p1", full_name: "Ada Okonkwo" }],
    };
    expect(sideDisplayName(row)).toBe("Ada Okonkwo");
    // Derived from the authority, never typed twice:
    expect(sideDisplayName(row)).toBe(
      entrantDisplayName({ name: row.snapshotName, kind: row.kind, members: row.members }),
    );
  });

  it("falls back to the snapshot when the roster cannot answer, and NEVER to an entrant id", () => {
    const cases = [
      { snapshotName: "Entry 3", kind: "individual", members: [] },
      { snapshotName: "Entry 3", kind: null, members: [{ person_id: "p1", full_name: "Ada Okonkwo" }] },
      { snapshotName: "Entry 3", kind: "pair", members: [{ person_id: "p1", full_name: "Ada Okonkwo" }] },
    ];
    let checked = 0;
    for (const c of cases) {
      expect(sideDisplayName(c), JSON.stringify(c)).toBe("Entry 3");
      expect(sideDisplayName(c)).not.toMatch(/^[0-9a-f-]{36}$/i);
      checked += 1;
    }
    expect(checked, "anti-vacuity: fallback cases checked").toBe(3);
  });

  it("an empty snapshot still never renders an empty string", () => {
    expect(sideDisplayName({ snapshotName: "", kind: "individual", members: [] })).toBe("—");
  });

  it("a whitespace-only resolution is floored too (the trim is the guard, not decoration)", () => {
    expect(sideDisplayName({ snapshotName: "   ", kind: null, members: [] })).toBe("—");
  });
});
