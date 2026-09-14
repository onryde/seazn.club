// M1 k2 — the subheading really is LIVE, and the channel that makes it live is
// really wired at both ends.
//
// `fixture-subheading.test.ts` proves the MODEL (a document with a new time
// yields a new line). That is not the same claim as "the paragraph on the page
// re-renders when a push arrives": the model would be just as green with the
// island still reading its `initial` prop for ever, which is exactly the
// inert-seam shape this repo keeps finding. These tests drive the island and
// the publisher as React drives them.
//
// TWO HARNESS FACTS, both deliberate:
//
//  - `apps/web` vitest is `environment: "node"`, so the island is driven with
//    `renderIsland` (`components/__tests__/_hook-harness.tsx`) rather than a
//    DOM.
//  - that harness's `useSyncExternalStore` always returns the SERVER snapshot
//    (it has no browser under it), which for this island is `null` for ever —
//    i.e. the very behaviour under test would be stubbed out. So `react`'s
//    `useSyncExternalStore` is replaced here with the smallest honest client
//    implementation (subscribe, re-render, read `getSnapshot`), built out of
//    the hooks the harness DOES provide. Everything else about React is the
//    real module.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { buildMatchCentre, type MatchCentreInput } from "@/server/public-site/match-centre";
import type { SideT } from "@/server/public-site/match-centre-schema";
import type { PublicFixture } from "@/server/public-site/data";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";
import {
  clearLiveFixture,
  publishLiveFixture,
} from "@/components/public-site/match-centre/live-fixture-channel";
import { MatchCentre } from "@/components/public-site/match-centre/match-centre";
import enPublic from "@/dictionaries/en/public.json";
import { MatchCentreSubheading } from "../subheading";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      const [, bump] = actual.useState(0);
      actual.useEffect(() => subscribe(() => bump((n) => n + 1)), [subscribe]);
      return getSnapshot();
    },
  };
});

const dict = enPublic as Record<string, unknown>;
const FIXTURE_ID = "fx-m1";

const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "Home Blazers", short: "HOM", colour: null, badgeUrl: null },
  { entrantId: "away", name: "Southend Queens", short: "SEQ", colour: null, badgeUrl: null },
];

function payload(over: Partial<PublicFixture> = {}): LiveFixtureData {
  const fixture: PublicFixture = {
    id: FIXTURE_ID,
    division_id: "d1",
    stage_id: "s1",
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "home",
    away_entrant_id: "away",
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: "2026-07-20T13:30:00.000Z",
    venue: null,
    court_label: null,
    venue_name: "Riverside Sports Hall",
    court_name: "Court 3",
    status: "scheduled",
    outcome: null,
    summary: null,
    last_seq: null,
    ...over,
  };
  const input: MatchCentreInput = {
    fixture,
    sportKey: "cricket",
    cfg: cricket.configSchema.parse({}),
    events: [],
    lineups: { home: [], away: [] },
    sides: SIDES,
    venueTz: "Europe/London",
    locale: "en",
    now: new Date("2026-07-20T10:00:00.000Z"),
    hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: null,
    moduleVersion: null,
    formatLabel: null,
  };
  return {
    status: fixture.status,
    summary: fixture.summary,
    outcome: fixture.outcome,
    match_centre: buildMatchCentre(input),
  };
}

const KICK_OFF = payload();
const RESCHEDULED = payload({ scheduled_at: "2026-07-20T16:45:00.000Z" });

beforeEach(() => {
  // The channel is module state shared by every test in this file.
  clearLiveFixture(FIXTURE_ID);
  clearLiveFixture("someone-else");
});

describe("MatchCentreSubheading — first paint", () => {
  it("renders its own `initial` document when nothing has been published yet", () => {
    // The SSR and hydration path. If this ever needed a published snapshot to
    // show anything, the page would flash an empty line on every load.
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    expect(textOf(island.tree())).toContain("20 Jul 2026, 14:30");
    expect(textOf(island.tree())).toContain("Riverside Sports Hall · Court 3");
  });

  it("renders nothing at all when a live fixture has neither a time nor a venue", () => {
    const bare = payload({
      status: "in_play",
      scheduled_at: null,
      venue_name: null,
      court_name: null,
    });
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: bare,
      dict,
    });
    expect(island.tree()).toEqual([]);
  });
});

describe("MatchCentreSubheading — it moves when the fixture does", () => {
  // THE k2 DEFECT, at the layer that had it. The live rain-delay test found
  // the court card on the new kick-off and this line still on the old one,
  // because the page had rendered it once on the server. No `rerender` call
  // below: the ONLY thing that happens between the two assertions is a push.
  it("re-renders on a published snapshot, with no new props and no reload", () => {
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    expect(textOf(island.tree())).toContain("14:30");

    publishLiveFixture(FIXTURE_ID, RESCHEDULED);

    expect(textOf(island.tree())).toContain("17:45");
    expect(textOf(island.tree())).not.toContain("14:30");
  });

  it("follows a court reassignment too, not only the time", () => {
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    publishLiveFixture(FIXTURE_ID, payload({ court_name: "Court 9" }));
    expect(textOf(island.tree())).toContain("Court 9");
    expect(textOf(island.tree())).not.toContain("Court 3");
  });

  it("ignores a snapshot published for a DIFFERENT fixture", () => {
    // The channel is keyed by fixture id; without that key, a second match
    // centre anywhere on a page would overwrite this line.
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    publishLiveFixture("someone-else", RESCHEDULED);
    expect(textOf(island.tree())).toContain("14:30");
  });

  it("falls back to its own document once the publisher has gone", () => {
    // `MatchCentre` clears its entry on unmount, so a client-side navigation
    // does not leave one document per visited fixture behind.
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    publishLiveFixture(FIXTURE_ID, RESCHEDULED);
    expect(textOf(island.tree())).toContain("17:45");
    clearLiveFixture(FIXTURE_ID);
    island.rerender({ fixtureId: FIXTURE_ID, initial: KICK_OFF, dict });
    expect(textOf(island.tree())).toContain("14:30");
  });
});

describe("the channel is wired at the PUBLISHING end too", () => {
  // Both halves in one test. A channel nothing writes to is the inert seam
  // this repo keeps shipping: every test above would stay green with
  // `MatchCentre` never publishing at all, because they publish by hand.
  //
  // The fixture is DECIDED on purpose: `useLiveFixture` arms neither its poll
  // interval nor a realtime subscription for a match that is not live
  // (`data.status === "in_play" || "scheduled"`), so this drives the real
  // component with no network and no timers.
  it("mounting <MatchCentre> publishes its snapshot, and the subheading picks it up", () => {
    const decidedElsewhere = payload({
      status: "decided",
      scheduled_at: "2026-07-20T16:45:00.000Z",
      court_name: "Court 9",
    });
    const publisher = renderIsland(MatchCentre, {
      fixtureId: FIXTURE_ID,
      initial: decidedElsewhere,
      realtime: false,
      dict,
      tabParam: null,
    });
    expect(publisher.tree().length, "the match centre really rendered").toBeGreaterThan(0);

    // The island's OWN document still says 14:30 on Court 3. Anything it shows
    // beyond that came through the channel from the component above.
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    expect(textOf(island.tree())).toContain("17:45");
    expect(textOf(island.tree())).toContain("Court 9");

    publisher.unmount();
  });

  it("<MatchCentre> clears its entry on unmount", () => {
    const publisher = renderIsland(MatchCentre, {
      fixtureId: FIXTURE_ID,
      // Decided again, for the same reason: a `scheduled` payload would arm
      // the poll and fire a real `fetch` in a node test.
      initial: payload({ status: "decided", scheduled_at: "2026-07-20T16:45:00.000Z" }),
      realtime: false,
      dict,
      tabParam: null,
    });
    publisher.unmount();
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    expect(textOf(island.tree())).toContain("14:30");
  });
});
