// RS005 R2 task 1: the division page's link into the competition-level
// Registration hub, this division pre-filtered. Design §5 wanted this from
// RS004 ("the filter lands with the real Registrants table"), but RS004
// shipped only a comment explaining why it was deferred (page.tsx, formerly
// lines 316-317: "Division-level registration nav link removed … hub
// replaces it") — no link ever landed. This is the regression that proves
// the deferred link exists now, asserting the URL itself (acceptance
// criterion: "assert the href, not that a link exists").
//
// Same mock scaffold as seed-proposal-stage-pairing.test.tsx in this same
// dir: no jsdom in this workspace, so this calls the async server component
// directly and walks the returned element tree.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
const competitionsSpy = vi.hoisted(() => ({ getCompetition: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/competitions", () => competitionsSpy);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
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
    tiebreakers: undefined,
    eligibility: [],
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
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: [],
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

import DivisionPage from "../page";
import Link from "@/components/ui/console-link";

/** Depth-first search of a returned server-component tree, collecting EVERY
 *  element of the given type — copied from seed-proposal-stage-pairing.test.tsx
 *  in this same dir. */
function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const renderPage = () =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "fixtures" }),
  });

/** The one `Link` the page renders whose href points at the registration
 *  hub — as opposed to the tab-strip's own `Link`s (`/o/org/c/comp/d/div?tab=...`)
 *  or the Slideshow `Link` (`/slideshow/divisions/...`), which the same
 *  `findAll(tree, Link)` also turns up. */
function findRegistrationLink(tree: ReactNode): ReactElement | undefined {
  return findAll(tree, Link).find((el) =>
    (el.props as { href: string }).href.includes("/registration"),
  );
}

describe("division page links into the Registration hub, this division pre-filtered", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    competitionsSpy.getCompetition
      .mockReset()
      .mockResolvedValue({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" });
  });

  it("carries this division's id as division_id, straight into the hub's Registrants tab", async () => {
    const tree = await renderPage();
    const link = findRegistrationLink(tree);
    expect(link).toBeDefined();
    expect((link!.props as { href: string }).href).toBe(
      "/o/org/c/comp/registration?tab=registrants&division_id=div-1",
    );
  });

  // This is an ORGANISER surface (the hub, behind /o/), not the public
  // register link the deleted surface used to gate on visibility — a
  // private competition still has registrants to manage. Same reasoning the
  // competition page's own RegistrationHubNavEntry comment gives for
  // skipping a canEdit gate: requireDivisionPage already routes through
  // requireCompetitionPage, which 404s a scorer and admits everyone else
  // who can reach this page at all.
  it("still renders when the competition is private — unlike the public register/QR links beside it", async () => {
    competitionsSpy.getCompetition.mockResolvedValue({
      id: "comp-1",
      frozen: false,
      visibility: "private",
      slug: "comp-one",
    });
    const tree = await renderPage();
    const link = findRegistrationLink(tree);
    expect(link).toBeDefined();
    expect((link!.props as { href: string }).href).toBe(
      "/o/org/c/comp/registration?tab=registrants&division_id=div-1",
    );
  });
});
