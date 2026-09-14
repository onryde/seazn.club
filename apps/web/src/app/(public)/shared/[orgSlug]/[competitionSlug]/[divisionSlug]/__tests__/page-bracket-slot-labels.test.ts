// R10d n4 — the public DIVISION page renders the same `Bracket` as the embed
// bracket widget, and it too printed the organiser board's "Winner of R1·2" for
// a side still waiting on a match. It now hands the Bracket the public round
// namer (`publicRoundNamer`), so the bracket reads "Winner of Semi-finals,
// match 1", as the hub and the match centre do.
//
// The page is an async server component: it is called with the data door
// mocked, the `Bracket` element it builds is found in the returned tree, and
// that element is rendered to static markup. The page's client islands (tabs,
// share button, schedule) are never rendered here; node vitest has no DOM.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { Bracket } from "@/components/public-site/bracket";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";
import DivisionHomePage from "../page";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "ko",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const entrant = (id: string, name: string, seed: number): PublicEntrant => ({
  id,
  division_id: "d1",
  kind: "individual",
  display_name: name,
  seed,
  status: "active",
  members: [],
  team_display: null,
  badge_url: null,
});

/** Every element of `type` anywhere in a server component's returned tree. */
function findElements(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, out);
  } else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) findElements(value, type, out);
  }
  return out;
}

describe("public division page — its Bracket names a waiting side's feeder ROUND (R10d n4)", () => {
  it("a knockout final waiting on both semi-finals reads 'Winner of Semi-finals, match N' in the Bracket's markup, never an R·code", async () => {
    getPublicDivision.mockResolvedValue({
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
      },
      stages: [{ id: "ko", division_id: "d1", seq: 1, kind: "knockout", name: "Knockout", status: "active" }],
      pools: [],
      fixtures: [
        F({ id: "semi-1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        F({ id: "semi-2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
        F({
          id: "final",
          round_no: 2,
          seq_in_round: 1,
          home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
          away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 2 } },
        }),
      ],
      standings: [],
      entrants: [entrant("e1", "Side 1", 1), entrant("e2", "Side 2", 2), entrant("e3", "Side 3", 3), entrant("e4", "Side 4", 4)],
      tz: "UTC",
    });

    const root = await DivisionHomePage({
      params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
    });
    const brackets = findElements(root, Bracket);
    expect(brackets, "the page builds one Bracket for its one knockout stage").toHaveLength(1);
    const html = renderToStaticMarkup(brackets[0]!);

    const dict = await getDictionary("en", "public");
    const semi = msgFor("en", "bracket.round.semi");
    const home = t(dict, "knockout.feederWinner", { round: semi, seq: 1 });
    const away = t(dict, "knockout.feederWinner", { round: semi, seq: 2 });
    expect([home, away]).toEqual(["Winner of Semi-finals, match 1", "Winner of Semi-finals, match 2"]);
    expect(html).toContain(`title="${home}"`);
    expect(html).toContain(`title="${away}"`);
    expect(html).not.toMatch(/R\d+·\d+/);
  });
});
