// Standings qualification status (spec 2026-09-22 §4.2, plan Task 7,
// controller ruling B7) — the embeddable standings widget's half. The embed
// is a public standings surface a club pastes into its own site; if its page
// never passes `qualification`, the table renders perfectly well with nothing
// on it, and no unit anywhere else notices (AGENTS.md #1, the inert seam).
//
// Same shape as the division page's plumbing test beside `page.tsx` in
// `/shared`: the data door (`embedDivisionData`) is mocked in the REAL payload
// shape — a V414 stage row, the division's `config` and pinned module,
// `PublicFixture`s with outcomes — the page is called, and the `StandingsTable`
// it returns is read for its prop and rendered to markup. The scene is the
// builder suite's `swiss4` (Swiss of four, two of three rounds played, a cut of
// two into "Finals"); its pair is the same scene with no cut.
//
// Mutants killed: the embed not passing `qualification` (→ both cut tests).
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { StandingsTable } from "@/components/public-site/standings-table";
import type { EmbedPayload } from "@/server/embed-data";
import type { PublicEntrant, PublicFixture, PublicStage } from "@/server/public-site/data";
import type { QualificationView } from "@/server/public-site/qualification-view";
import EmbedWidgetPage from "../page";

const NAMES: Record<string, string> = { A: "Ada Embed", B: "Bo Embed", C: "Cy Embed", D: "Di Embed" };

const entrant = (id: string, seed: number): PublicEntrant => ({
  id,
  division_id: "d1",
  kind: "individual",
  display_name: NAMES[id]!,
  seed,
  status: "confirmed",
  members: [],
  team_display: null,
  badge_url: null,
});

const fx = (id: string, round: number, home: string | null, away: string | null, winner?: string): PublicFixture => ({
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
  outcome: winner ? { kind: "win", winner, loser: (winner === home ? away : home)! } : null,
  summary: null,
  last_seq: null,
});

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

function payload(qualifyCount: number | null): EmbedPayload {
  const stage: PublicStage = {
    id: "sw",
    division_id: "d1",
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    status: "active",
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
    } as EmbedPayload["competition"],
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
      // embed-data.ts selects `dv.config` for exactly this (V414).
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } },
    } as EmbedPayload["division"],
    stages: [stage],
    pools: [],
    fixtures: [
      fx("f1", 1, "A", "D", "A"),
      fx("f2", 1, "B", "C", "B"),
      fx("f3", 2, "A", "B", "A"),
      fx("f4", 2, "C", "D", "C"),
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
    ] as EmbedPayload["standings"],
    entrants: ["A", "B", "C", "D"].map((id, i) => entrant(id, i + 1)),
    sponsors: [],
    tz: "UTC",
  };
}

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function renderWidget(qualifyCount: number | null) {
  embedDivisionData.mockResolvedValue({ ok: true, data: payload(qualifyCount) });
  const root = await EmbedWidgetPage({ params: Promise.resolve({ id: "d1", widget: "standings" }) });
  const tables = elements(root).filter((el) => el.type === StandingsTable);
  expect(tables, "the standings widget builds one StandingsTable for its one Swiss stage").toHaveLength(1);
  const table = tables[0]!;
  return {
    qualification: (table.props as { qualification?: QualificationView | null }).qualification,
    html: renderToStaticMarkup(table),
  };
}

describe("embed standings widget — the table gets its qualification view", () => {
  it("a stage with a cut: the widget hands the table the builder's view for it", async () => {
    const { qualification } = await renderWidget(2);
    expect(qualification, "the embed passed no qualification to a table with a cut").toBeTruthy();
    expect(qualification!.table.cutIndex).toBe(2);
    expect(qualification!.table.label).toBe("Top 2 go through to Finals · 1 round left");
    expect(Object.fromEntries(Object.entries(qualification!.rows).map(([id, r]) => [id, r.status]))).toEqual({
      A: "win_k",
      B: "needs_help",
      C: "needs_help",
      D: "needs_help",
    });
  });

  it("…and the table draws it: the cut line, and rank 1 named by the builder's label", async () => {
    const { qualification, html } = await renderWidget(2);
    expect(html).toContain('data-testid="qual-cut"');
    expect(html).toContain('data-testid="qual-legend"');
    const label = qualification!.rows.A!.ariaLabel;
    expect(label).toBe("Rank 1, Win and in, show details");
    const button = /<button[^>]*data-testid="standings-rank-A"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button, "rank 1 has no trigger").not.toBe("");
    expect(button).toContain(`aria-label="${label}"`);
  });

  it("negative pair: the same division with no cut passes no view and draws none of it", async () => {
    const { qualification, html } = await renderWidget(null);
    expect(qualification ?? null).toBeNull();
    for (const probe of ['data-testid="qual-cut"', 'data-testid="qual-legend"', 'data-qual-marker="', 'aria-label="Rank ']) {
      expect(html, probe).not.toContain(probe);
    }
    expect(html).toContain(">Ada Embed<");
  });
});
