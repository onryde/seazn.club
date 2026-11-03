// W3 app-B T3 (owner Q2, 2026-11-03): the embeddable standings widget marks a Swiss bye and a late join. The widget is a
// public standings surface a club pastes into its own site; if its page never hands the table the stage's fixtures' facts,
// the table renders perfectly well with no mark on it and no unit elsewhere notices (AGENTS.md class 1, the inert seam).
// Same shape as `page-qualification-plumbing` beside this file: `embedDivisionData` is mocked in the real payload shape, the
// page is called, and the `StandingsTable` it returns is rendered to markup. Scene: Ada and Bo play rounds 1-2, Cyd joins at
// round 3 (rounds 1-2 are hers to miss) where Bo sits out on the pairing bye.
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
import { byeAward } from "@/lib/fixture-bye";
import { resolveModule } from "@/server/engine-db/registry";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import EmbedWidgetPage from "../page";

const DIVISION_CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } };
// the pinned module as the adapter resolves it (`resolveModule` boots the registry; a bare `registry.get` at import time
// finds it empty and the file never collects)
const GENERIC = resolveModule("generic", "1.0.0");
const NAMES: Record<string, string> = { A: "Ada Embed", B: "Bo Embed", C: "Cyd Embed" };

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

// A bye is the row `byeAward` writes (`loser: null`); the view's wire type widens that null away, hence the cast.
const wire = (outcome: unknown) => outcome as PublicFixture["outcome"];
const fx = (id: string, round: number, ext_key: string, home: string, away: string | null, outcome: PublicFixture["outcome"]): PublicFixture => ({
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
  status: "decided",
  outcome,
  summary: null,
  last_seq: null,
  ext_key,
});

const FIXTURES: PublicFixture[] = [
  fx("f1", 1, "sw-r1-b1", "A", "B", { kind: "win", winner: "A", loser: "B" }),
  fx("f2", 2, "sw-r2-b1", "A", "B", { kind: "win", winner: "A", loser: "B" }),
  fx("f3", 3, "sw-r3-b1", "A", "C", { kind: "win", winner: "A", loser: "C" }),
  fx("f4", 3, "sw-r3-bye", "B", null, wire(byeAward("B"))),
];

function payload(fixtures: PublicFixture[]): EmbedPayload {
  const stage: PublicStage = {
    id: "sw",
    division_id: "d1",
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    status: "active",
    qualify_count: null,
    qualify_per_group: false,
    next_stage_name: null,
    swiss_rounds: 5,
    points_rule: null,
    has_rank_overrides: false,
    table_rules: unpinnedRulesDoc({ module: GENERIC, kind: "swiss", divisionConfig: DIVISION_CFG }),
  };
  const row = (entrantId: string, rank: number, played: number, won: number) => ({
    entrantId,
    rank,
    played,
    won,
    drawn: 0,
    lost: played - won,
    points: 3 * won,
    metrics: { for: won, against: 0, diff: won },
  });
  return {
    org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
    competition: {
      id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public",
    } as EmbedPayload["competition"],
    division: {
      id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 3, config: DIVISION_CFG,
    } as EmbedPayload["division"],
    stages: [stage],
    pools: [],
    fixtures,
    standings: [
      { stage_id: "sw", pool_id: null, updated_at: "2026-11-03T00:00:00.000Z", rows: [row("A", 1, 3, 3), row("B", 2, 2, 0), row("C", 3, 1, 0)] },
    ] as EmbedPayload["standings"],
    entrants: ["A", "B", "C"].map((id, i) => entrant(id, i + 1)),
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

async function standingsTable(fixtures: PublicFixture[]) {
  embedDivisionData.mockResolvedValue({ ok: true, data: payload(fixtures) });
  const root = await EmbedWidgetPage({ params: Promise.resolve({ id: "d1", widget: "standings" }) });
  const tables = elements(root).filter((el) => el.type === StandingsTable);
  expect(tables, "the standings widget builds one StandingsTable for its one Swiss stage").toHaveLength(1);
  return tables[0]!;
}
async function standingsHtml(fixtures: PublicFixture[]) {
  return renderToStaticMarkup(await standingsTable(fixtures));
}

const nameCell = (html: string, name: string) => {
  const hit = [...html.matchAll(/<th scope="row"[\s\S]*?<\/th>/g)].map((m) => m[0]).find((c) => c.includes(name));
  expect(hit, `no standings row cell for ${name}`).toBeDefined();
  return hit!;
};

describe("embed standings widget - a Swiss bye and a late join reach the table marked", () => {
  it("the bye holder carries a bye mark, the late entrant a late mark, and the on-time byeless entrant neither", async () => {
    const html = await standingsHtml(FIXTURES);
    expect(nameCell(html, NAMES.B!)).toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.B!)).not.toContain('data-marker="late"');
    expect(nameCell(html, NAMES.C!)).toContain('data-marker="late"');
    expect(nameCell(html, NAMES.C!)).not.toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.A!), "Ada played every round and sat out none").not.toContain("data-marker=");
  });

  it("the page names the stage's kind to the table: the Swiss ladders' format is the Swiss table's (`stageKind`, owner Q2 scope)", async () => {
    const table = await standingsTable(FIXTURES);
    expect((table.props as { stageKind?: string }).stageKind, "the stage here is a Swiss").toBe("swiss");
  });

  it("empty case: a Swiss with no fixtures yet marks nobody", async () => {
    const html = await standingsHtml([]);
    expect([...html.matchAll(/<th scope="row"/g)].length, "rows checked").toBe(3);
    expect(html).not.toContain("data-marker=");
  });
});
