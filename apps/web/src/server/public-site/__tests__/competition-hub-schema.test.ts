// Spectator surface W2, Task 1 — the hub document schema, PARSED.
//
// This file exists because a schema nothing ever calls is decoration: until
// something runs `CompetitionHubDoc.parse`, `tabs`' `.min(1)`, `winnerIndex`'s
// literal union and every `.nullable()` in 200-odd lines are unenforced text.
// The wave's own rule is that a seam proven by a fixture on both ends proves
// the fixture — so this drives the REAL schema with a complete document and
// then breaks it, one field at a time, for a reason each case names.
//
// Mutation sweep — each mutant applied to `competition-hub-schema.ts` alone and
// restored; all nine killed, killer named:
//   1 drop `.min(1)` from `tabs` ............... "an empty tab list is refused"
//   2 `winnerIndex` → `z.number().nullable()` .. "a winnerIndex of 2 is refused"
//   3 `tabs` element type → `z.string()` ....... "an unknown tab id is refused"
//   4 `superRefine` never raises its issue ..... all three self-consistency cases
//   5 `superRefine` compares LENGTH only ....... "tabs must match in ORDER"
//   6 refinement counts BOARDS, not leader ROWS  "leader BOARDS with no rows…"
//   7 `name` made `.nullable()` ................ "a required field cannot be null"
//   8 `resultLine` loses `.nullable()` ......... the round-trip case (+2 more)
//   9 `sportName` loses `.nullable()` .......... the round-trip case (+3 more)
import { describe, expect, it } from "vitest";
import { deriveHubTabs } from "@/lib/matches-hub";
import {
  CompetitionHubDoc,
  type CompetitionHubDocT,
} from "@/server/public-site/competition-hub-schema";

import { validHubDoc as validDoc } from "./_hub-doc";


/** Parse and hand back the issues, so a case can name the field AND the reason
 *  rather than asserting only that something somewhere went wrong. */
function issuesOf(doc: unknown): { path: string; code: string }[] {
  const r = CompetitionHubDoc.safeParse(doc);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code }));
}

describe("CompetitionHubDoc — the document really parses", () => {
  it("a complete document round-trips, and the parsed value equals the input", () => {
    const input = validDoc();
    const parsed: CompetitionHubDocT = CompetitionHubDoc.parse(input);
    // Equality is the point: zod strips unknown keys, so a field the schema
    // forgot to declare would show up here as a difference rather than as a
    // silently discarded value.
    expect(parsed).toEqual(input);
  });

  it("the fixture's own tabs agree with deriveHubTabs — the fixture is not lying to the refinement", () => {
    const doc = validDoc() as CompetitionHubDocT;
    expect(doc.tabs).toEqual(
      deriveHubTabs({
        matches: doc.matches.length,
        tables: doc.tables.length,
        leaderRows: doc.leaders.reduce((n, b) => n + b.rows.length, 0),
        teams: doc.teams.length,
      }),
    );
  });
});

describe("CompetitionHubDoc — what it REFUSES, and why", () => {
  it("an empty tab list is refused: a hub with no way into it", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), tabs: [] };
    expect(issuesOf(doc)).toContainEqual({ path: "tabs", code: "too_small" });
  });

  it("a winnerIndex of 2 is refused: a fixture has two sides, so the index is 0 or 1", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, matches: [{ ...doc.matches[0]!, winnerIndex: 2 }, doc.matches[1]!] };
    expect(issuesOf(broken)).toContainEqual({
      path: "matches.0.winnerIndex",
      code: "invalid_union",
    });
  });

  it("an unknown tab id is refused: the tab list is a closed vocabulary", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), tabs: ["overview", "roster", "info"] };
    expect(issuesOf(doc)).toContainEqual({ path: "tabs.1", code: "invalid_value" });
  });

  it("a required field cannot be null: `name` is not nullable", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), name: null };
    expect(issuesOf(doc)).toContainEqual({ path: "name", code: "invalid_type" });
  });

  it("SELF-CONSISTENCY: a Matches tab beside an empty matches array is refused", () => {
    // The invariant the schema's own comment claims. Without the refinement this
    // document parses cleanly and a spectator meets a tab that opens on nothing.
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, matches: [], tabs: doc.tabs };
    const issues = issuesOf(broken);
    expect(issues).toContainEqual({ path: "tabs", code: "custom" });
    const r = CompetitionHubDoc.safeParse(broken);
    expect(r.success).toBe(false);
    expect(r.error!.issues.find((i) => i.code === "custom")!.message).toContain(
      "deriveHubTabs()",
    );
  });

  it("SELF-CONSISTENCY: tabs must match in ORDER, not merely in membership", () => {
    // Same set, wrong order. A length-only or set-only comparison passes this;
    // the tab strip is rendered in list order, so order is the contract.
    const doc = validDoc() as CompetitionHubDocT;
    const broken = {
      ...doc,
      tabs: ["overview", "table", "matches", "stats", "teams", "info"],
    };
    expect(issuesOf(broken)).toContainEqual({ path: "tabs", code: "custom" });
  });

  it("SELF-CONSISTENCY: the empty document's own tab list is accepted", () => {
    // The positive pair for the two refusals above — the refinement must not be
    // a gate that refuses everything. A hub with no contents at all carries
    // exactly overview + info, and that parses.
    const doc = validDoc() as CompetitionHubDocT;
    const bare = {
      ...doc,
      matches: [],
      tables: [],
      leaders: [],
      teams: [],
      tabs: ["overview", "info"],
    };
    expect(issuesOf(bare)).toEqual([]);
  });

  it("SELF-CONSISTENCY: leader BOARDS with no rows do not earn a Stats tab", () => {
    // `leaderRows`, not `leaders.length` — a board list that exists but is empty
    // is exactly the case `deriveHubTabs` counts rows for.
    const doc = validDoc() as CompetitionHubDocT;
    const emptyBoards = {
      ...doc,
      leaders: [{ ...doc.leaders[0]!, rows: [] }],
      tabs: ["overview", "matches", "table", "stats", "teams", "info"],
    };
    expect(issuesOf(emptyBoards)).toContainEqual({ path: "tabs", code: "custom" });

    const withoutStats = { ...emptyBoards, tabs: ["overview", "matches", "table", "teams", "info"] };
    expect(issuesOf(withoutStats)).toEqual([]);
  });
});
