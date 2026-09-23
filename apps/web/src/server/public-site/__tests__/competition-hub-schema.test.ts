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
//
// Knockout tab, Task 1 (2026-09-13) — same protocol, three more, all killed:
//  10 fixture-id check never raises ........... "a round naming a fixture that is not in `matches`…" (+1)
//  11 champion-id check never raises .......... "a championFixtureId that is not in `matches`…"
//  12 refinement counts knockouts as 0 ........ "knockouts earn a Knockout tab" (+5 more)
import { describe, expect, it } from "vitest";
import { deriveHubTabs } from "@/lib/matches-hub";
import { BRACKET_KINDS } from "@/server/public-site/champion";
import {
  CompetitionHubDoc,
  KnockoutKind,
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
        knockouts: doc.knockouts.length,
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
    // Found by PATH, not by being the first custom issue: emptying `matches`
    // also strands the knockout rounds' fixture ids, which raise their own.
    expect(
      r.error!.issues.find((i) => i.code === "custom" && i.path.join(".") === "tabs")!.message,
    ).toContain("deriveHubTabs()");
  });

  it("SELF-CONSISTENCY: tabs must match in ORDER, not merely in membership", () => {
    // Same set, wrong order. A length-only or set-only comparison passes this;
    // the tab strip is rendered in list order, so order is the contract.
    const doc = validDoc() as CompetitionHubDocT;
    const broken = {
      ...doc,
      tabs: ["overview", "table", "matches", "knockout", "stats", "teams", "info"],
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
      knockouts: [],
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
      tabs: ["overview", "matches", "table", "knockout", "stats", "teams", "info"],
    };
    expect(issuesOf(emptyBoards)).toContainEqual({ path: "tabs", code: "custom" });

    const withoutStats = {
      ...emptyBoards,
      tabs: ["overview", "matches", "table", "knockout", "teams", "info"],
    };
    expect(issuesOf(withoutStats)).toEqual([]);
  });
});

// Hub Knockout tab (plan 2026-09-13, R2/R3). A knockout view is a list of
// fixture IDS, not of fixtures: the cards it shows are `matches` rows, so an id
// that names no match is a round that renders a hole. The refinement refuses
// that at the seam, at the exact round, for the same reason the tab check does.
describe("CompetitionHubDoc — knockouts", () => {
  /** Replace one round's fixture ids, leaving the rest of the document valid. */
  const withRoundIds = (view: number, round: number, ids: string[]) => {
    const doc = validDoc() as CompetitionHubDocT;
    return {
      ...doc,
      knockouts: doc.knockouts.map((k, i) =>
        i !== view
          ? k
          : { ...k, rounds: k.rounds.map((r, j) => (j !== round ? r : { ...r, fixtureIds: ids })) },
      ),
    };
  };

  it("the fixture really exercises both views: a champion and a single lane on one, neither on the other", () => {
    // Guards the round-trip case above against a fixture that quietly stopped
    // populating a nullable — it would still round-trip, proving nothing.
    const doc = validDoc() as CompetitionHubDocT;
    expect(doc.knockouts.map((k) => k.championFixtureId)).toEqual(["f1", null]);
    expect(doc.knockouts.map((k) => k.rounds.map((r) => r.lane))).toEqual([[null, null], ["WB"]]);
  });

  it("SELF-CONSISTENCY: knockouts earn a Knockout tab — a tab list that omits it is refused", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, tabs: doc.tabs.filter((t) => t !== "knockout") };
    expect(issuesOf(broken)).toContainEqual({ path: "tabs", code: "custom" });
  });

  it("SELF-CONSISTENCY: a Knockout tab with no knockouts behind it is refused — drop the tab and it parses", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const noViews = { ...doc, knockouts: [] };
    expect(issuesOf(noViews)).toContainEqual({ path: "tabs", code: "custom" });
    expect(issuesOf({ ...noViews, tabs: doc.tabs.filter((t) => t !== "knockout") })).toEqual([]);
  });

  it("a round naming a fixture that is not in `matches` is refused AT that round, naming the id", () => {
    const broken = withRoundIds(0, 1, ["f1", "ghost"]);
    expect(issuesOf(broken)).toEqual([{ path: "knockouts.0.rounds.1.fixtureIds", code: "custom" }]);
    expect(CompetitionHubDoc.safeParse(broken).error!.issues[0]!.message).toContain("ghost");
  });

  it("the SECOND view's round reports at its own index — the path is not a constant", () => {
    expect(issuesOf(withRoundIds(1, 0, ["nope"]))).toEqual([
      { path: "knockouts.1.rounds.0.fixtureIds", code: "custom" },
    ]);
  });

  it("a championFixtureId that is not in `matches` is refused, at that view", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const broken = {
      ...doc,
      knockouts: [{ ...doc.knockouts[0]!, championFixtureId: "ghost" }, doc.knockouts[1]!],
    };
    expect(issuesOf(broken)).toEqual([{ path: "knockouts.0.championFixtureId", code: "custom" }]);
  });

  it("an empty view is not a view: `rounds` and each round's `fixtureIds` are non-empty", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const noRounds = { ...doc, knockouts: [{ ...doc.knockouts[0]!, rounds: [] }, doc.knockouts[1]!] };
    expect(issuesOf(noRounds)).toContainEqual({ path: "knockouts.0.rounds", code: "too_small" });
    expect(issuesOf(withRoundIds(0, 0, []))).toContainEqual({
      path: "knockouts.0.rounds.0.fixtureIds",
      code: "too_small",
    });
  });

  it("kind is the bracket vocabulary — a league is not a knockout", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, knockouts: [{ ...doc.knockouts[0]!, kind: "league" }, doc.knockouts[1]!] };
    expect(issuesOf(broken)).toContainEqual({ path: "knockouts.0.kind", code: "invalid_value" });
  });

  it("KnockoutKind declares exactly BRACKET_KINDS, in order — the builder's stage filter and the enum cannot drift", () => {
    // The builder picks stages by `BRACKET_KINDS` and stamps `kind` from the
    // stage; a member added to one and not the other would publish a document
    // this schema refuses (or an enum member nothing can ever produce).
    expect(KnockoutKind.options).toEqual([...BRACKET_KINDS]);
  });
});

describe("CompetitionHubDoc — squads, suspensions, division prose (division-page parity, 2026-09-16)", () => {
  it("the complete fixture really exercises both sides: a squad with a suspended, linked member and a masked one; a division with prose and one without", () => {
    // A round-trip over a fixture that never populated these fields proves
    // nothing about them — so the fixture's own coverage is asserted first.
    const doc = CompetitionHubDoc.parse(validDoc());
    expect(doc.teams[0]!.members!.map((m) => [m.playerHref !== null, m.suspendedRemaining])).toEqual([
      [true, 2],
      [false, null],
    ]);
    expect(doc.teams[1]!.members).toEqual([]);
    expect(doc.divisions.map((d) => d.description)).toEqual(["<p>Open to every club in the county.</p>", null]);
    expect(doc.divisions.map((d) => d.suspensions!.map((s) => s.personId))).toEqual([["p1"], [null]]);
  });

  it("a document built BEFORE these fields existed still parses — a CDN or Redis copy of the old shape is not a broken hub", () => {
    // The API answers with `s-maxage=30, stale-while-revalidate=300`
    // (`PUBLIC_CACHE_CONTROL`), so a spectator's new bundle can poll an old
    // document for minutes after a deploy. `byeSides` set the precedent.
    const old = structuredClone(validDoc() as CompetitionHubDocT);
    for (const d of old.divisions) {
      delete d.description;
      delete d.suspensions;
    }
    for (const team of old.teams) {
      delete team.members;
      delete team.calendarHref;
    }
    // Really the old shape — absent, not null — or this proves nothing.
    expect(old.divisions.some((d) => "description" in d || "suspensions" in d)).toBe(false);
    expect(old.teams.some((team) => "members" in team || "calendarHref" in team)).toBe(false);
    expect(old.teams.length).toBeGreaterThan(0);
    expect(issuesOf(old)).toEqual([]);
  });

  it("matches left to serve are whole numbers, on the ban AND on the member's tag — '1.5 to serve' is refused", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const d0 = doc.divisions[0]!;
    const brokenBan = {
      ...doc,
      divisions: [{ ...d0, suspensions: [{ ...d0.suspensions![0]!, remaining: 1.5 }] }, doc.divisions[1]!],
    };
    expect(issuesOf(brokenBan)).toContainEqual({ path: "divisions.0.suspensions.0.remaining", code: "invalid_type" });
    const t0 = doc.teams[0]!;
    const brokenMember = {
      ...doc,
      teams: [{ ...t0, members: [{ ...t0.members![0]!, suspendedRemaining: 0.5 }] }, doc.teams[1]!],
    };
    expect(issuesOf(brokenMember)).toContainEqual({ path: "teams.0.members.0.suspendedRemaining", code: "invalid_type" });
  });
});

// Standings qualification status (spec 2026-09-22 §4.1, plan Task 5). Every
// string is resolved by `buildQualificationView` before it reaches the
// document; the schema's job is to keep the vocabulary closed and the cut
// index a real place count. Mutants, each killed by the case named:
//  13 `QualStatusKind` → `z.string()` .......... "a status outside the four is refused"
//  14 `cutIndex` loses `.positive()` ........... "the cut index is a whole positive place count"
//  15 `cutIndex` loses `.int()` ................ "the cut index is a whole positive place count"
//  16 `qual` made `.optional()` ................ "qual and qualification are required keys"
//  17 `qualification` made `.optional()` ....... "qual and qualification are required keys"
//  18 `ifYouLose` loses `.nullable()` .......... the round-trip case (+ the premise below)
describe("CompetitionHubDoc — standings qualification (spec 2026-09-22 §4.1)", () => {
  it("the complete fixture really exercises it: a row WITH a status beside one without, and a cut line", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const rows = doc.tables[0]!.rows;
    expect(rows.map((r) => r.qual?.status ?? null)).toEqual(["win_k", null]);
    expect(rows[0]!.qual!.ifYouLose).toBeNull();
    expect(doc.tables[0]!.qualification!.cutIndex).toBe(1);
    expect(issuesOf(doc)).toEqual([]);
  });

  it("a status outside the four is refused: the marker and the legend know exactly four", () => {
    const doc = structuredClone(validDoc() as CompetitionHubDocT);
    (doc.tables[0]!.rows[0]!.qual as { status: string }).status = "maybe";
    expect(issuesOf(doc)).toContainEqual({ path: "tables.0.rows.0.qual.status", code: "invalid_value" });
  });

  it("the cut index is a whole positive place count — 0 would draw the line above the first row", () => {
    for (const bad of [0, -1, 1.5]) {
      const doc = structuredClone(validDoc() as CompetitionHubDocT);
      doc.tables[0]!.qualification!.cutIndex = bad;
      expect(issuesOf(doc).map((i) => i.path), String(bad)).toEqual(["tables.0.qualification.cutIndex"]);
    }
  });

  it("qual and qualification are required keys (null = no status): a builder that forgets them fails the parse", () => {
    const noQual = structuredClone(validDoc() as CompetitionHubDocT);
    delete (noQual.tables[0]!.rows[1] as Partial<(typeof noQual.tables)[0]["rows"][0]>).qual;
    expect(issuesOf(noQual)).toContainEqual({ path: "tables.0.rows.1.qual", code: "invalid_type" });
    const noTable = structuredClone(validDoc() as CompetitionHubDocT);
    delete (noTable.tables[0] as Partial<(typeof noTable.tables)[0]>).qualification;
    expect(issuesOf(noTable)).toContainEqual({ path: "tables.0.qualification", code: "invalid_type" });
  });
});
