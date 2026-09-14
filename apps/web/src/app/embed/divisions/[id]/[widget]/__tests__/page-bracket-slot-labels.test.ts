// R10d n4 — the embeddable BRACKET widget is the last public surface that
// printed the organiser board's "Winner of R1·2" for a side still waiting on a
// match. It now names the feeder's round through the same `publicRoundNamer`
// the hub, the match centre, the calendar and the schedule widget use:
// "Winner of Semi-finals, match 1".
//
// The page is an async server component: it is called with a mocked data door
// and analytics, and the element it returns is rendered to static markup, so
// the assertions read the widget's own HTML (the side's `title` attribute and
// its text).
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";
import type { EmbedPayload } from "@/server/embed-data";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import EmbedWidgetPage from "../page";

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

const payload = (locale: string, fixtures: PublicFixture[]): EmbedPayload => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: locale },
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
  } as EmbedPayload["division"],
  stages: [{ id: "ko", division_id: "d1", seq: 1, kind: "knockout", name: "Knockout", status: "active" }],
  pools: [],
  fixtures,
  standings: [],
  entrants: [entrant("e1", "Side 1", 1), entrant("e2", "Side 2", 2), entrant("e3", "Side 3", 3), entrant("e4", "Side 4", 4)],
  sponsors: [],
  tz: "UTC",
});

/** A 4-draw knockout: both semi-finals filled, the final's home side waiting on
 *  semi-final 1, its away side as given. */
const semisThenFinal = (finalAway: SlotLabel | null): PublicFixture[] => [
  F({ id: "semi-1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
  F({ id: "semi-2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
  F({
    id: "final",
    round_no: 2,
    seq_in_round: 1,
    home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
    away_slot_label: finalAway,
  }),
];

/** React's attribute escaping, for a `title="…"` probe. */
const attr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The bracket widget's rendered markup. */
async function bracketMarkup(): Promise<string> {
  const root = (await EmbedWidgetPage({
    params: Promise.resolve({ id: "d1", widget: "bracket" }),
  })) as ReactElement;
  return renderToStaticMarkup(root);
}

describe("embed bracket widget — a waiting side names its feeder's ROUND (R10d n4)", () => {
  it("a knockout final waiting on both semi-finals reads 'Winner of Semi-finals, match N' in the markup, never an R·code", async () => {
    embedDivisionData.mockResolvedValue({
      ok: true,
      data: payload("en", semisThenFinal({ key: "slot.winner_match", params: { round: 1, seq: 2 } })),
    });

    const html = await bracketMarkup();

    const dict = await getDictionary("en", "public");
    const semi = msgFor("en", "bracket.round.semi");
    const home = t(dict, "knockout.feederWinner", { round: semi, seq: 1 });
    const away = t(dict, "knockout.feederWinner", { round: semi, seq: 2 });
    expect([home, away]).toEqual(["Winner of Semi-finals, match 1", "Winner of Semi-finals, match 2"]);
    expect(html).toContain(`title="${attr(home)}"`);
    expect(html).toContain(`>${attr(home)}</span>`);
    expect(html).toContain(`title="${attr(away)}"`);
    expect(html).not.toMatch(/R\d+·\d+/);
  });

  it("names the round in the ORG's locale (fr), and a side with no label keeps the bracket's own 'to be decided' (bracket.tbd, not schedule.tbd)", async () => {
    embedDivisionData.mockResolvedValue({ ok: true, data: payload("fr", semisThenFinal(null)) });

    const html = await bracketMarkup();

    const dict = await getDictionary("fr", "public");
    const home = t(dict, "knockout.feederWinner", { round: msgFor("fr", "bracket.round.semi"), seq: 1 });
    const english = t(await getDictionary("en", "public"), "knockout.feederWinner", {
      round: msgFor("en", "bracket.round.semi"),
      seq: 1,
    });
    expect(home, "the premise: the fr sentence is not the English one").not.toBe(english);
    expect(html).toContain(`title="${attr(home)}"`);

    const bracketTbd = msgFor("fr", "bracket.tbd");
    const scheduleTbd = msgFor("fr", "schedule.tbd");
    expect(bracketTbd, "the premise: the two 'to be decided' strings differ in fr").not.toBe(scheduleTbd);
    expect(html).toContain(`title="${attr(bracketTbd)}"`);
    expect(html).not.toContain(scheduleTbd);
    expect(html).not.toMatch(/R\d+·\d+/);
  });
});
