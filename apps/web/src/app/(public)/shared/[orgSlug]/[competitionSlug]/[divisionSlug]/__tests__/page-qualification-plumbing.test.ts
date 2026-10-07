// Standings qualification status (spec 2026-09-22 §4.2, plan Task 7) — the
// public division page's own half: the page builds each table's view from its
// data door (`getPublicDivision`) and hands it to `StandingsTable`.
//
// The inert seam (AGENTS.md #1) is the risk this file exists for: the table and
// the builder are each unit-green on their own, and a page that never passes
// `qualification` renders a perfectly good table with nothing on it. So the
// page is called with its data door mocked in the REAL data shape — a V414
// stage row (`qualify_count`, `next_stage_name`, `swiss_rounds`, …), the
// division's `config` and pinned module, `PublicFixture`s with their outcomes
// — and what reaches the table is read off the element the page returns, then
// rendered to markup.
//
// The scene is the builder suite's `swiss4`: a Swiss of four, three rounds,
// two played (A 2W, B 1W, C 1W, D 0), a cut of two into "Finals". Its statuses
// are the engine's (qualification-view.test.ts): A needs one more win, the
// other three need help. Its pair is the SAME scene with no cut (V414 gave
// `qualify_count` null): no view, and no qualification markup at all.
//
// The second scene is the competition hub's Task 6 two-pool stage (one
// through from each pool, `qualify_per_group`): the page draws one table per
// pool, and each must get the view of ITS OWN pool — the pools differ in every
// line a swap would move (rounds left on the cut line, statuses).
//
// Mutants killed: the page not passing `qualification` (→ both cut tests);
// the page passing the wrong stage meta (`qualify_count` read as null → the
// cut test); the table's pool dropped (`poolId: null` in
// `divisionQualification` → the two-pool test: a per-group cut on no pool is
// no view); and one pool's view handed to the other's table (→ the two-pool
// test).
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { StandingsTable } from "@/components/public-site/standings-table";
import type { PublicEntrant, PublicFixture, PublicStage } from "@/server/public-site/data";
import type { QualificationView } from "@/server/public-site/qualification-view";
import enPublic from "@/dictionaries/en/public.json";
import DivisionHomePage from "../page";

/** The en captions of pools A and B under `stage`: `table.poolLabel` over the
 *  pool KEY, read from the dictionary file — never the stored "Pool " + key. */
const enCaptions = (stage: string, keys: string[] = ["A", "B"]) =>
  keys.map((k) => `${stage} — ${enPublic["table.poolLabel"].replace("{key}", k)}`);

const NAMES: Record<string, string> = {
  A: "Ada Swiss", B: "Bo Swiss", C: "Cy Swiss", D: "Di Swiss",
  e1: "Red Rovers", e2: "Blue Jays", e3: "Green Giants", e4: "Gold Geese", e5: "Silver Swans", e6: "Bronze Bears",
};

const entrant = (id: string, seed: number): PublicEntrant =>
  ({
    id,
    division_id: "d1",
    kind: "individual",
    display_name: NAMES[id],
    seed,
    status: "confirmed",
    members: [],
    team_display: null,
    badge_url: null,
  }) as unknown as PublicEntrant;

const fx = (id: string, round: number, home: string | null, away: string | null, winner?: string): PublicFixture =>
  ({
    id,
    division_id: "d1",
    stage_id: "sw",
    pool_id: null,
    round_no: round,
    seq_in_round: 1,
    home_entrant_id: home,
    away_entrant_id: away,
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: null,
    venue: null,
    court_label: null,
    venue_name: null,
    court_name: null,
    status: winner ? "decided" : "scheduled",
    outcome: winner ? { kind: "win", winner, loser: winner === home ? away : home } : null,
    summary: null,
    last_seq: null,
  }) as PublicFixture;

/** A generic 3-1-0 row whose for/against/diff agree (the builder's `row`). */
const row = (entrantId: string, rank: number, won: number, goals: [number, number]) => ({
  entrantId,
  rank,
  played: 2,
  won,
  drawn: 0,
  lost: 2 - won,
  points: 3 * won,
  metrics: { for: goals[0], against: goals[1], diff: goals[0] - goals[1] },
});

function divisionData(qualifyCount: number | null) {
  const stage: PublicStage = {
    id: "sw",
    division_id: "d1",
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    status: "active",
    // V414, as `public_stages_v` publishes it. With no cut the view gives no
    // destination either (`stage_qualification_meta`: all or nothing).
    qualify_count: qualifyCount,
    qualify_per_group: false,
    next_stage_name: qualifyCount === null ? null : "Finals",
    swiss_rounds: 3,
    points_rule: null,
    has_rank_overrides: false,
  };
  return {
    org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
    competition: {
      id: "c1",
      org_id: "o1",
      name: "Test Comp",
      slug: "test-comp",
      description: null,
      starts_on: null,
      ends_on: null,
      branding: {},
      status: "active",
      visibility: "public",
    },
    division: {
      id: "d1",
      competition_id: "c1",
      name: "Open",
      slug: "open",
      description: null,
      sport_key: "generic",
      variant_key: "score",
      status: "active",
      module_version: "1.0.0",
      tiebreakers: null,
      sport_name: null,
      entrant_count: 4,
      // The live cfg the forecast's per-match bounds come from.
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } },
    },
    stages: [stage],
    pools: [],
    fixtures: [
      fx("f1", 1, "A", "D", "A"),
      fx("f2", 1, "B", "C", "B"),
      fx("f3", 2, "A", "B", "A"),
      fx("f4", 2, "C", "D", "C"),
      // Round 3's boards are unseated shells until it is paired.
      fx("f5", 3, null, null),
      fx("f6", 3, null, null),
    ],
    standings: [
      {
        stage_id: "sw",
        pool_id: null,
        updated_at: "2026-09-23T00:00:00.000Z",
        rows: [row("A", 1, 2, [4, 0]), row("B", 2, 1, [2, 2]), row("C", 3, 1, [1, 2]), row("D", 4, 0, [0, 3])],
      },
    ],
    entrants: ["A", "B", "C", "D"].map((id, i) => entrant(id, i + 1)),
    tz: "UTC",
  };
}

/** Every element anywhere in a server component's returned tree. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

/** Two pools of three under one group stage with a per-group cut of one —
 *  the hub's Task 6 scene. Pool A: r1 e1>e2; e1–e3, e2–e3 to play (two
 *  rounds left). Pool B: e4 beat e5 and e6; e5–e6 to play (one left). */
function twoPoolData() {
  const base = divisionData(1);
  const stage: PublicStage = {
    ...base.stages[0]!,
    id: "gr",
    kind: "group",
    name: "Groups",
    qualify_count: 1,
    qualify_per_group: true,
    next_stage_name: "Finals",
    swiss_rounds: null,
  };
  const inPool = (f: PublicFixture, pool: string): PublicFixture => ({ ...f, stage_id: "gr", pool_id: pool });
  const prow = (entrantId: string, rank: number, won: number, played: number) => ({
    ...row(entrantId, rank, won, [won, played - won]),
    played,
    lost: played - won,
  });
  return {
    ...base,
    stages: [stage],
    pools: [
      { id: "pA", stage_id: "gr", key: "A", name: "Pool A" },
      { id: "pB", stage_id: "gr", key: "B", name: "Pool B" },
    ],
    fixtures: [
      inPool(fx("a1", 1, "e1", "e2", "e1"), "pA"),
      inPool(fx("a2", 2, "e1", "e3"), "pA"),
      inPool(fx("a3", 3, "e2", "e3"), "pA"),
      inPool(fx("b1", 1, "e4", "e5", "e4"), "pB"),
      inPool(fx("b2", 2, "e4", "e6", "e4"), "pB"),
      inPool(fx("b3", 3, "e5", "e6"), "pB"),
    ],
    // Pool B's snapshot first: the page's order must not be the input's.
    standings: [
      { stage_id: "gr", pool_id: "pB", updated_at: "2026-09-23T00:00:00.000Z", rows: [prow("e4", 1, 2, 2), prow("e5", 2, 0, 1), prow("e6", 3, 0, 1)] },
      { stage_id: "gr", pool_id: "pA", updated_at: "2026-09-23T00:00:00.000Z", rows: [prow("e1", 1, 1, 1), prow("e2", 2, 0, 1), prow("e3", 3, 0, 0)] },
    ],
    entrants: ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, i) => entrant(id, i + 1)),
  };
}

async function renderTables(data: unknown) {
  getPublicDivision.mockResolvedValue(data);
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  return elements(root)
    .filter((el) => el.type === StandingsTable)
    .map((table) => {
      const props = table.props as { qualification?: QualificationView | null; rows: { entrantId: string }[]; caption?: string };
      return { qualification: props.qualification, rowIds: props.rows.map((r) => r.entrantId), caption: props.caption, html: renderToStaticMarkup(table) };
    });
}

async function renderPage(qualifyCount: number | null) {
  const tables = await renderTables(divisionData(qualifyCount));
  expect(tables, "the page builds one StandingsTable for its one Swiss stage").toHaveLength(1);
  return tables[0]!;
}

describe("public division page — the standings table gets its qualification view", () => {
  it("a stage with a cut: the page hands the table the builder's view for it", async () => {
    const { qualification } = await renderPage(2);
    expect(qualification, "the page passed no qualification to a table with a cut").toBeTruthy();
    expect(qualification!.table.cutIndex).toBe(2);
    expect(qualification!.table.label).toBe("Top 2 go through to Finals · 1 round left");
    // The engine's statuses for this scene — every row, each its own.
    expect(Object.fromEntries(Object.entries(qualification!.rows).map(([id, r]) => [id, r.status]))).toEqual({
      A: "win_k",
      B: "needs_help",
      C: "needs_help",
      D: "needs_help",
    });
  });

  it("…and the table draws it: the cut line, and rank 1 named by the builder's label", async () => {
    const { qualification, html } = await renderPage(2);
    expect(html).toContain('data-testid="qual-cut"');
    expect(html).toContain('data-testid="qual-legend"');
    const label = qualification!.rows.A!.ariaLabel;
    expect(label).toBe("Rank 1, Win and in, show details");
    // Anchored on `="` (AGENTS.md): the label as an attribute value, on the
    // button that is Ada's rank.
    const button = /<button[^>]*data-testid="standings-rank-A"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button, "rank 1 has no trigger").not.toBe("");
    expect(button).toContain(`aria-label="${label}"`);
  });

  it("negative pair: the same division with no cut passes no view and draws none of it", async () => {
    const { qualification, html } = await renderPage(null);
    expect(qualification ?? null).toBeNull();
    for (const probe of ['data-testid="qual-cut"', 'data-testid="qual-legend"', 'data-qual-marker="', 'aria-label="Rank ']) {
      expect(html, probe).not.toContain(probe);
    }
    // The table is still there, ranks and all.
    expect(html).toContain(">Ada Swiss<");
  });

  it("two pools with a per-group cut: each pool's table gets ITS OWN pool's view, line and statuses", async () => {
    const tables = await renderTables(twoPoolData());
    expect(tables.map((x) => x.caption)).toEqual(enCaptions("Groups"));
    for (const { qualification, rowIds, caption } of tables) {
      expect(qualification, `${caption}: no view for a pool with a per-group cut`).toBeTruthy();
      // The view covers exactly the entrants this table draws — not the other pool's.
      expect(Object.keys(qualification!.rows).sort(), caption).toEqual([...rowIds].sort());
    }
    const [a, b] = tables as [(typeof tables)[0], (typeof tables)[0]];
    expect(a.qualification!.table.label).toBe("First place goes through to Finals · 2 rounds left");
    expect(b.qualification!.table.label).toBe("First place goes through to Finals · 1 round left");
    expect(Object.fromEntries(Object.entries(b.qualification!.rows).map(([id, r]) => [id, r.status]))).toEqual({
      e4: "through",
      e5: "out",
      e6: "out",
    });
    // …and each table DRAWS its own: the line, and rank 1's trigger name.
    expect(a.html).toContain("First place goes through to Finals · 2 rounds left");
    expect(a.html).not.toContain("1 round left");
    expect(b.html).toContain("First place goes through to Finals · 1 round left");
    expect(/<button[^>]*data-testid="standings-rank-e4"[^>]*>/.exec(b.html)?.[0] ?? "").toContain(
      'aria-label="Rank 1, Through, show details"',
    );
  });
});
