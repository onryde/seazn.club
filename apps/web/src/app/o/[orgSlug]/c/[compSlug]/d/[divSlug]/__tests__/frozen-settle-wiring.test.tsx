// Match Day PB3 item 2 (m7 from the PB2 review) - a billing-frozen competition's run sheet still offers Settle on a held match.
//
// The seam, end to end: the division page folds the billing freeze into the run sheet's `canEdit` (a frozen competition is
// read-only for the timetable) and must hand the ORGANISER's right separately, as `canSettle` (scoring and settling are not
// freeze-gated; the fixture page already offers the settle). A row-level test proves the row; this drives the REAL page (the async
// server component called directly) and then renders the REAL StagesPanel with exactly the props the page produced, so the prop
// that reaches the row is the one the page computed (AGENTS.md class 1: a fixture on both ends proves the fixture).
// Same scaffold as held-final-phase.test.tsx beside it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const comp = vi.hoisted(() => ({ frozen: false }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn<(auth: unknown, divisionId: string) => Promise<unknown[]>>(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(async () => false),
  getStageRosterDrift: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
// W2c Task 17: the PUBLIC dictionary carries the rules-line clauses the stage format row's chips are worded from; the double
// holds one of them and one key that is not a clause, so the slice the page hands the panel can be told from the whole.
// W2c Task 18: and one `format.points.*` clause, which the stage points section's preview is worded from.
const PUBLIC_DICT = {
  "format.rules.decider.extraTime": "extra time (2 × {n} min)",
  "format.points.base": "{win} for a win",
  "landing.title": "not a rules-line key",
};
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async (_locale: unknown, ns: string) => (ns === "public" ? PUBLIC_DICT : {})),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "active",
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    config: {},
    tiebreakers: null, // the column's real default: `divisionTiebreakers` is iterated unless null (the rules strip)
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({
  divisionConsumesSlotOnArchive: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    frozen: comp.frozen,
    visibility: "private",
    slug: "comp-one",
  })),
}));
const fixtureSpies = vi.hoisted(() => ({
  listDivisionFixtures: vi.fn(),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/fixtures", () => fixtureSpies);
const deskSpies = vi.hoisted(() => ({ listFixturesAwaitingSettle: vi.fn() }));
vi.mock("@/server/usecases/competition-desk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/competition-desk")>()),
  listFixturesAwaitingSettle: deskSpies.listFixturesAwaitingSettle,
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
// W2d final review I1: the card's pins come from one loader; a spy here, the real meta reader kept (importOriginal).
const qualSpies = vi.hoisted(() => ({
  listPinnedStagePoints: vi.fn<(auth: unknown, stageIds: readonly string[]) => Promise<Record<string, unknown>>>(async () => ({})),
}));
vi.mock("@/server/usecases/stage-qualification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/stage-qualification")>()),
  listPinnedStagePoints: qualSpies.listPinnedStagePoints,
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
// Task 14 P1: the fixtures tab resolves the checkout's currency (`preferredCurrency` reads cookies/headers), which has
// no request scope in a direct page call. Not what this suite pins.
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
  })),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));
// Spec 2026-09-30 §2 (T6): the fixtures tab's one stream read is `openStreamStates` (the run sheet's chip) — this page
// test is not about streaming, so it is an empty double.
vi.mock("@/server/usecases/stream-sessions", () => ({
  openStreamStates: async () => ({}),
}));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";

/** First element of the given type in a server-component tree (mirrors
 *  officials-loads-deferred.test.tsx's `find` — this page renders exactly
 *  one StagesPanel, unlike ProgressionPanel's per-stage list). */
function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}


vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const KO_STAGE = { id: "stage-ko", name: "Cup", kind: "knockout", seq: 1, status: "active", config: {}, progression: null };
const fixture = (o: Record<string, unknown>) => ({
  stage_id: "stage-ko",
  scheduled_at: null,
  home_entrant_id: "e-ana",
  away_entrant_id: "e-ben",
  home_slot_label: null,
  away_slot_label: null,
  outcome: null,
  round: 1,
  position: 0,
  officials: [],
  ...o,
});
/** A semi that ended level: held, owed the organiser's settle. */
const HELD = fixture({ id: "fx-held", fixture_no: 1, status: "needs_decision", outcome: { kind: "draw" }, scheduled_at: "2030-01-01T10:00:00.000Z" });
/** A semi with no time yet: the freeze DOES gate giving it one (`moveFixture`). */
const UNTIMED = fixture({ id: "fx-untimed", fixture_no: 2, status: "scheduled", position: 1, scheduled_at: null });

const pageFor = (canEdit: boolean) => ({
  auth: { orgId: "org-1", userId: "user-1", role: canEdit ? "owner" : "viewer" },
  canEdit,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: canEdit ? "owner" : "viewer", timezone: "UTC" },
});

async function runSheet(opts: { frozen: boolean; canEdit: boolean }) {
  comp.frozen = opts.frozen;
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(pageFor(opts.canEdit));
  const tree = await DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "fixtures" }),
  });
  const panel = find(tree, StagesPanel);
  expect(panel, "the fixtures tab mounts StagesPanel").not.toBeNull();
  const props = panel!.props as ComponentProps<typeof StagesPanel>;
  const html = renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <StagesPanel {...props} />
    </DictProvider>,
  );
  const actions = [...html.matchAll(/data-row-action="([a-z_]+)"/g)].map((m) => m[1]!);
  return { props, html, actions };
}

beforeEach(() => {
  comp.frozen = false;
  stagesSpies.listStages.mockReset().mockResolvedValue([KO_STAGE]);
  stagesSpies.getSeedProposal.mockReset();
  stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
  fixtureSpies.listDivisionFixtures.mockReset().mockResolvedValue([HELD, UNTIMED]);
  deskSpies.listFixturesAwaitingSettle.mockReset().mockResolvedValue(new Set());
});

describe("PB3 m7: the run sheet of a frozen competition offers Settle on a held match", () => {
  it("premise: the rows rendered (anti-vacuity), one held and one untimed, on the unfrozen organiser's page", async () => {
    const { actions, html } = await runSheet({ frozen: false, canEdit: true });
    expect(actions.sort()).toEqual(["decide", "set_time"]);
    expect(html).toContain('data-testid="run-sheet-held-chip"');
  });

  it("a FROZEN competition, organiser: the page keeps the timetable read-only (canEdit false) but hands the settle on (canSettle true)", async () => {
    const { props, actions } = await runSheet({ frozen: true, canEdit: true });
    expect(props.canEdit, "the freeze still folds into the timetable's gate").toBe(false);
    expect(props.canSettle).toBe(true);
    // The held row offers Settle; the untimed row stays a view (no way to give it a time while frozen).
    expect(actions.sort()).toEqual(["decide", "view"]);
  });

  it("a viewer (not an organiser) on a frozen competition only views the held row - the settle is organiser-only", async () => {
    const { props, actions } = await runSheet({ frozen: true, canEdit: false });
    expect(props.canSettle).toBe(false);
    expect(actions.sort()).toEqual(["view", "view"]);
    expect(actions).not.toContain("decide");
  });

  it("a viewer on an unfrozen competition is the same: view, view", async () => {
    const { actions } = await runSheet({ frozen: false, canEdit: false });
    expect(actions.sort()).toEqual(["view", "view"]);
  });
});
