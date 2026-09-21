// The public division page's own half of F10/C1, unit-side.
//
// Since V412 this page's `entrants` carries EVERYONE the view publishes —
// including the departed — and the page then answers two different questions
// from that one list:
//
//   `entrantStatuses` (:106)  every entrant's RAW status, handed to the
//                             standings table so a departed row can say which
//                             way she left;
//   `field` (:316)            `entrants.filter(inTheField)`, the Entrants tab,
//                             which is who a spectator can still expect to see
//                             play.
//
// Neither had any unit coverage at all. An independent mutation campaign
// (2026-09-21) deleted the filter outright (`const field = entrants;`),
// narrowed it to `status !== "withdrawn"`, and relabelled a disqualification
// as a withdrawal on its way into `entrantStatuses` — and all three survived
// 673 tests across 211 suites under `src/app/(public)/shared`. The only killer
// was `e2e/withdrawn-entrant-public-board.spec.ts`, and `e2e.yml` triggers on
// push to `main` only, so a PR carrying that page gets no e2e signal at all
// before it merges.
//
// The page is an async server component: it is called with its data door
// mocked, and the two things it builds are found in the tree it returns and
// rendered on their own — the same shape as `page-bracket-slot-labels` and
// `page-member-link-rule` beside this file. Node vitest has no DOM, so the
// client islands are never mounted.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { FIELD_ENTRANT_STATUSES } from "@/lib/entrant-field";
import { StandingsTable } from "@/components/public-site/standings-table";
import type { PublicEntrant } from "@/server/public-site/data";
import DivisionHomePage from "../page";

/** One entrant per status `entrants.status` allows, so both halves of the
 *  departed vocabulary are in the scene. A filter narrowed to `withdrawn`
 *  passes a scene that seeds only a withdrawal — which is exactly how this
 *  gap stayed open elsewhere. */
const SEATS = [
  { id: "e-reg", status: "registered", name: "Ada Registered" },
  { id: "e-con", status: "confirmed", name: "Bo Confirmed" },
  { id: "e-wit", status: "withdrawn", name: "Cyd Withdrawn" },
  { id: "e-dsq", status: "disqualified", name: "Dee Disqualified" },
] as const;

/** Who the Entrants tab must list, and who it must not — derived from the
 *  product's field vocabulary (`lib/entrant-field.ts`), never typed here, so
 *  a fifth status moves this with it. */
const IN_FIELD = SEATS.filter((s) => FIELD_ENTRANT_STATUSES.includes(s.status));
const DEPARTED = SEATS.filter((s) => !FIELD_ENTRANT_STATUSES.includes(s.status));

const entrant = (seat: (typeof SEATS)[number], seed: number): PublicEntrant =>
  ({
    id: seat.id,
    division_id: "d1",
    kind: "individual",
    display_name: seat.name,
    seed,
    status: seat.status,
    members: [],
    team_display: null,
    badge_url: null,
  }) as unknown as PublicEntrant;

const divisionData = () => ({
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
    entrant_count: IN_FIELD.length,
  },
  stages: [{ id: "lg", division_id: "d1", seq: 1, kind: "league", name: "League", status: "active" }],
  pools: [],
  fixtures: [],
  // A standings snapshot that still carries every seat, departed included —
  // the F10 situation itself: her played result stands, so her row is there to
  // be marked.
  standings: [
    {
      stage_id: "lg",
      pool_id: null,
      updated_at: "2026-09-21T00:00:00.000Z",
      rows: SEATS.map((seat, i) => ({
        entrantId: seat.id,
        played: 1,
        won: 1,
        drawn: 0,
        lost: 0,
        points: 2,
        metrics: { gf: 3, ga: 1, gd: 2 },
        rank: i + 1,
      })),
    },
  ],
  entrants: SEATS.map((seat, i) => entrant(seat, i + 1)),
  tz: "UTC",
});

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

async function renderPage() {
  getPublicDivision.mockResolvedValue(divisionData());
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  const all = elements(root);

  const tables = all.filter((el) => el.type === StandingsTable);
  expect(tables, "the page builds one StandingsTable for its one league stage").toHaveLength(1);

  // The Entrants tab's list. Anchored on the `ul` the page builds for it —
  // the members list inside each card is a different one.
  const lists = all.filter(
    (el) => el.type === "ul" && (el.props as { className?: string }).className === "grid gap-3 sm:grid-cols-2",
  );
  expect(lists, "the Entrants tab is no longer one <ul class='grid gap-3 sm:grid-cols-2'>").toHaveLength(1);

  return { standings: renderToStaticMarkup(tables[0]!), entrants: renderToStaticMarkup(lists[0]!) };
}

/** The one `<th>` holding an entrant's name in the standings, and everything
 *  inside it — the chip lives in that cell, not on the row. */
const nameCell = (html: string, name: string) => {
  const hit = [...html.matchAll(/<th scope="row"[\s\S]*?<\/th>/g)]
    .map((m) => m[0])
    .find((c) => c.includes(name));
  expect(hit, `no standings row cell for ${name}`).toBeDefined();
  return hit!;
};

describe("public division page — the departed reach the standings marked, and the Entrants tab drops them", () => {
  it("premise: the scene really does hold both a field and a departed half", () => {
    // Every row below is a difference between two sets. If the vocabulary ever
    // made them the same set, the differences would be vacuous rather than
    // wrong, and this says so first.
    expect(IN_FIELD.map((s) => s.status)).toEqual(["registered", "confirmed"]);
    expect(DEPARTED.map((s) => s.status)).toEqual(["withdrawn", "disqualified"]);
  });

  it("entrantStatuses: each departed entrant is chipped with HER OWN status, nobody else is chipped", async () => {
    const { standings } = await renderPage();

    // Named per status, not looped over one generic "departed" chip: the
    // mutant that matters relabels a disqualification as a withdrawal on its
    // way into the map, which a status-agnostic assertion cannot see.
    expect(
      nameCell(standings, "Cyd Withdrawn"),
      "the withdrawn entrant is not marked withdrawn on the public standings",
    ).toContain('data-testid="standings-withdrawn"');
    expect(
      nameCell(standings, "Dee Disqualified"),
      "the disqualified entrant is not marked disqualified — announcing her as a withdrawal is worse than silence",
    ).toContain('data-testid="standings-disqualified"');
    expect(nameCell(standings, "Dee Disqualified")).not.toContain('data-testid="standings-withdrawn"');
    expect(nameCell(standings, "Cyd Withdrawn")).not.toContain('data-testid="standings-disqualified"');

    // The discriminating half: the map carries the WHOLE field, so a table
    // that chipped on mere presence would brand everybody.
    for (const seat of IN_FIELD) {
      expect(
        nameCell(standings, seat.name),
        `"${seat.name}" is still competing and must carry no departure chip`,
      ).not.toContain('data-testid="standings-');
    }
    const chips = [...standings.matchAll(/data-testid="(standings-[a-z]+)"/g)].map((m) => m[1]);
    expect(chips.toSorted()).toEqual(["standings-disqualified", "standings-withdrawn"]);

    // Her row survives her: the standings still rank all four (F2's ruling —
    // the result is marked, not voided).
    for (const seat of SEATS) expect(standings).toContain(seat.name);
  });

  it("the Entrants tab lists the field and NEITHER departure", async () => {
    const { entrants } = await renderPage();
    const cards = [...entrants.matchAll(/<li class="min-w-0[\s\S]*?<\/li>/g)].map((m) => m[0]);
    expect(cards, "the Entrants tab does not list the field").toHaveLength(IN_FIELD.length);

    // The positive half is not decoration: an empty panel — a filter that
    // refuses everybody — satisfies the negative on its own.
    for (const seat of IN_FIELD) {
      expect(cards.some((c) => c.includes(seat.name)), `"${seat.name}" is competing and must be listed`).toBe(true);
    }
    // Each departure named separately. A filter narrowed to
    // `status !== "withdrawn"` passes the first of these and fails the second,
    // which is precisely the half that shipped unmarked before C1.
    for (const seat of DEPARTED) {
      expect(
        entrants,
        `"${seat.name}" is ${seat.status} and must not be listed as a current entrant`,
      ).not.toContain(seat.name);
    }
  });
});
