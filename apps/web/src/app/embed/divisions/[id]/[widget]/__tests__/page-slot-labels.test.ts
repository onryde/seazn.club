// N1 fix round 1, M8 — the embeddable schedule widget is a public surface a
// club pastes into its own site: a final waiting on two semi-finals must read
// "Winner of Semi-finals, match 1", the round the public hub's rail names,
// never the organiser board's "Winner of R1·1". The page hands the finished
// strings to the client `Schedule` as `slotLabels`; they come from the same
// `publicRoundNamer` the hub, the match centre and the calendar use.
//
// The page is an async server component: it is called, and the `Schedule`
// element it returns is read by its props (a client component, never rendered
// here — node vitest has no DOM). The data door and analytics are mocked.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { Schedule } from "@/components/public-site/schedule";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";
import type { EmbedPayload } from "@/server/embed-data";
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

/** The `slotLabels` the page hands its `Schedule`. */
async function scheduleSlotLabels(): Promise<Record<string, string>> {
  const root = (await EmbedWidgetPage({
    params: Promise.resolve({ id: "d1", widget: "schedule" }),
  })) as ReactElement<{ children: ReactElement<{ slotLabels: Record<string, string> }> }>;
  const schedule = root.props.children;
  expect(schedule.type).toBe(Schedule);
  return schedule.props.slotLabels;
}

describe("embed schedule widget — a waiting side names its feeder's ROUND (N1 fix round 1, M8)", () => {
  it("a knockout final waiting on both semi-finals reads 'Winner of Semi-finals, match N'; filled semi-finals carry no slot text", async () => {
    embedDivisionData.mockResolvedValue({
      ok: true,
      data: payload("en", [
        F({ id: "semi-1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        F({ id: "semi-2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
        F({
          id: "final",
          round_no: 2,
          seq_in_round: 1,
          home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
          away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 2 } },
        }),
      ]),
    });

    const slotLabels = await scheduleSlotLabels();

    const dict = await getDictionary("en", "public");
    const semi = msgFor("en", "bracket.round.semi");
    const expected = {
      "final:home": t(dict, "knockout.feederWinner", { round: semi, seq: 1 }),
      "final:away": t(dict, "knockout.feederWinner", { round: semi, seq: 2 }),
    };
    expect(expected).toEqual({
      "final:home": "Winner of Semi-finals, match 1",
      "final:away": "Winner of Semi-finals, match 2",
    });
    expect(slotLabels).toEqual(expected);
    expect(Object.values(slotLabels).join(" | ")).not.toMatch(/R\d+·\d+/);
  });

  it("names the round in the ORG's locale (fr) — the embed has no viewer to read a locale from", async () => {
    embedDivisionData.mockResolvedValue({
      ok: true,
      data: payload("fr", [
        F({ id: "semi-1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        F({ id: "semi-2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
        F({
          id: "final",
          round_no: 2,
          seq_in_round: 1,
          home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
          away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 2 } },
        }),
      ]),
    });

    const slotLabels = await scheduleSlotLabels();

    const dict = await getDictionary("fr", "public");
    const semi = msgFor("fr", "bracket.round.semi");
    expect(slotLabels["final:home"]).toBe(t(dict, "knockout.feederWinner", { round: semi, seq: 1 }));
    expect(slotLabels["final:home"]).toMatch(/ : vainqueur$/);
  });
});
