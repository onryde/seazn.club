// W2 final review B m2 — the division page's OWN link rule for a squad member.
//
// The Entrants tab links a member to the player card through `playerLinkId`:
// the id the view published, AND a division that shows full names. Upstream,
// `maskPublicEntrantNames` also withholds a masked member's `person_id`, so
// every DB-backed test reaches the page with the id already gone and cannot
// tell whether the page's own check is there (a mutant replacing it with the
// bare id survived them all). Here the data door is mocked to hand the page a
// member WITH an id in a masking division — what any future path that skips
// the upstream mask would hand it — so the page's rule alone decides.
//
// The page is an async server component: it is called with its data mocked,
// and its player-card links are found in the tree it returns.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import Link from "next/link";
import DivisionHomePage from "../page";

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

const MEMBER_ID = "5b0c7b4e-2f7a-4a55-9d0e-6c1f1c2d3e4f";

const divisionData = (policy: { youth: boolean; player_name_display: string | null }) => ({
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
    entrant_count: 1,
    ...policy,
  },
  stages: [],
  pools: [],
  fixtures: [],
  standings: [],
  entrants: [
    {
      id: "e1",
      division_id: "d1",
      kind: "team",
      display_name: "Riverside",
      seed: null,
      status: "active",
      team_display: null,
      badge_url: null,
      // A member carrying an id, whatever the policy: the page must decide.
      members: [{ name: "Sam C.", photo: null, person_id: MEMBER_ID, squad_number: 7, position: null }],
    },
  ],
  tz: "UTC",
});

async function playerLinks(policy: { youth: boolean; player_name_display: string | null }) {
  getPublicDivision.mockResolvedValue(divisionData(policy));
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  return elements(root)
    .filter((el) => el.type === Link && String((el.props as { href?: unknown }).href).includes("/players/"))
    .map((el) => renderToStaticMarkup(el));
}

describe("public division page — a squad member links to the card only on playerLinkId's terms (final review B m2)", () => {
  it.each([
    ["a youth division (default name policy)", { youth: true, player_name_display: null }],
    ["an adult division set to first name + initial", { youth: false, player_name_display: "first_initial" }],
  ])("%s: a member WITH a published id still gets no card link", async (_label, policy) => {
    expect(await playerLinks(policy)).toEqual([]);
  });

  it.each([
    ["an adult division (default name policy)", { youth: false, player_name_display: null }],
    ["a youth division set to full names", { youth: true, player_name_display: "full" }],
  ])("%s (positive pair): the same member links to their card", async (_label, policy) => {
    const links = await playerLinks(policy);
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(`href="/shared/test-org/test-comp/players/${MEMBER_ID}"`);
  });
});
