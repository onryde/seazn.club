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
  useLiveFixtureSnapshot,
} from "@/components/public-site/match-centre/live-fixture-channel";
import { MatchCentre } from "@/components/public-site/match-centre/match-centre";
import { clearRoundOpenedAt, publishRoundOpenedAt } from "@/components/public-site/match-centre/round-open-channel";
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

/** The smallest possible channel subscriber, whose RENDER COUNT is the thing
 *  under observation. The subheading's own output cannot witness a spurious
 *  wake-up — it re-reads the same snapshot and draws the same sentence — so a
 *  test that asserts on its text is green whether the channel's notifications
 *  are keyed or broadcast to everything mounted. This one is not. */
function countingSubscriber(fixtureId: string) {
  const renders = { count: 0 };
  const Probe = ({ id }: { id: string }) => {
    renders.count += 1;
    return useLiveFixtureSnapshot(id) === null ? "no snapshot" : "live snapshot";
  };
  const island = renderIsland(Probe, { id: fixtureId });
  return { renders, island };
}

beforeEach(() => {
  // The channel is module state shared by every test in this file.
  clearLiveFixture(FIXTURE_ID);
  clearLiveFixture("someone-else");
  clearRoundOpenedAt(FIXTURE_ID);
  clearRoundOpenedAt("someone-else");
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

  it("falls back to its own document once the publisher has gone, with no re-render of its own", () => {
    // `MatchCentre` clears its entry on unmount, so a client-side navigation
    // does not leave one document per visited fixture behind.
    //
    // M2 n3 — NO `rerender()` here, and that is the entire point of the case.
    // This test used to call one between the clear and the assertion, which
    // proved the ENTRY was gone and nothing about the subscriber being told:
    // `clearLiveFixture` deleted the snapshot and never ran the listener set,
    // so a still-mounted subscriber went on showing a removed document until
    // some unrelated render happened to call `getSnapshot`. Nothing was wrong
    // on the page today (`<MatchCentre>` and this island are siblings and
    // unmount together) — the test simply could not see the asymmetry with
    // `publishLiveFixture`, which does notify. Now the ONLY thing between the
    // two assertions is the clear.
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID,
      initial: KICK_OFF,
      dict,
    });
    publishLiveFixture(FIXTURE_ID, RESCHEDULED);
    expect(textOf(island.tree())).toContain("17:45");

    clearLiveFixture(FIXTURE_ID);

    expect(textOf(island.tree())).toContain("14:30");
    expect(textOf(island.tree()), "the removed snapshot is still on screen").not.toContain("17:45");
  });

  it("the clear's notification is KEYED, and a clear with nothing to remove is not one", () => {
    // Asserted on a RENDER COUNT, not on rendered text, and that is forced:
    // the subheading's own output is invariant under a spurious wake-up (it
    // re-reads the same snapshot and draws the same line), so a text
    // assertion here passes whether the notification is keyed or broadcast to
    // every subscriber on the page. Written that way first, it did not kill
    // either mutant.
    const { renders } = countingSubscriber(FIXTURE_ID);
    publishLiveFixture(FIXTURE_ID, RESCHEDULED);
    publishLiveFixture("someone-else", KICK_OFF);
    const woken = renders.count;
    expect(woken, "the publish for this fixture did not reach its subscriber").toBeGreaterThan(1);

    // A REAL removal for another fixture — `someone-else` has a snapshot, so
    // this clear does notify; it must notify only that fixture's listeners.
    clearLiveFixture("someone-else");
    expect(renders.count, "another fixture's clear woke this subscriber").toBe(woken);

    // A clear with nothing to remove is not a change either.
    clearLiveFixture("nothing-was-ever-published-here");
    expect(renders.count, "a clear that removed nothing woke this subscriber").toBe(woken);

    // …and its OWN clear still does wake it, or the guard above would be
    // satisfied by a `clearLiveFixture` that notifies nobody at all.
    clearLiveFixture(FIXTURE_ID);
    expect(renders.count, "this fixture's own clear did not wake its subscriber").toBeGreaterThan(woken);
    const gone = renders.count;

    // Clearing it a second time removes nothing, so it is not a change.
    clearLiveFixture(FIXTURE_ID);
    expect(renders.count, "a second clear of an already-empty entry woke this subscriber").toBe(gone);
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

// T17 fix round 2, V1 — an online board's line says when its round opened, the fact Match details shows, from the
// round's open onward: so the first move (which folds the header live, R3) changes nothing above the board. The time
// is the venue's: 10:42 UTC on 13 Oct 2026 is 11:42 in London (BST, UTC+1) and 06:42 in New York (EDT, UTC−4).
describe("MatchCentreSubheading — an online board's round-open line (V1)", () => {
  const AT = "2026-10-13T10:42:00.000Z";
  const LONDON = { at: AT, timeZone: "Europe/London", locale: "en" };
  const NO_TIME = payload({ scheduled_at: null, venue_name: null, court_name: null });
  const label = (time: string) => (enPublic as Record<string, string>)["matchCentre.status.roundOpened"]!.replace("{time}", time);

  it("premise: the label is a dictionary sentence carrying the time", () => {
    expect((enPublic as Record<string, string>)["matchCentre.status.roundOpened"]).toContain("{time}");
  });

  it("empty case first: not an online board (no roundOpen) ⇒ the old line, whatever is published", () => {
    const island = renderIsland(MatchCentreSubheading, { fixtureId: FIXTURE_ID, initial: NO_TIME, dict });
    expect(textOf(island.tree())).toBe("Time TBD");
    publishRoundOpenedAt(FIXTURE_ID, AT);
    expect(textOf(island.tree())).toBe("Time TBD");
  });

  it("first paint: the page's own round-open, in the venue's time zone", () => {
    const london = renderIsland(MatchCentreSubheading, { fixtureId: FIXTURE_ID, initial: NO_TIME, dict, roundOpen: LONDON });
    expect(textOf(london.tree())).toBe(label("11:42"));
    const ny = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID, initial: NO_TIME, dict, roundOpen: { ...LONDON, timeZone: "America/New_York" },
    });
    expect(textOf(ny.tree())).toBe(label("06:42"));
  });

  it("the first move moves nothing: the same line before it and after the header folds live", () => {
    const island = renderIsland(MatchCentreSubheading, { fixtureId: FIXTURE_ID, initial: NO_TIME, dict, roundOpen: LONDON });
    const before = textOf(island.tree());
    publishLiveFixture(FIXTURE_ID, { ...NO_TIME, match_centre: { ...NO_TIME.match_centre!, header: { ...NO_TIME.match_centre!.header, status: "in_play" } } });
    expect(textOf(island.tree())).toBe(before);
    expect(before).toBe(label("11:42"));
  });

  it("a viewer who loaded BEFORE the round opened: the panel's published open reaches the line with no reload", () => {
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID, initial: NO_TIME, dict, roundOpen: { ...LONDON, at: null },
    });
    expect(textOf(island.tree()), "before the open").toBe("Time TBD");
    publishRoundOpenedAt("someone-else", AT);
    expect(textOf(island.tree()), "another board's open").toBe("Time TBD");
    publishRoundOpenedAt(FIXTURE_ID, AT);
    expect(textOf(island.tree()), "after the open").toBe(label("11:42"));
  });

  it("an instant it cannot read is left out — the old line, never a crash", () => {
    const island = renderIsland(MatchCentreSubheading, {
      fixtureId: FIXTURE_ID, initial: NO_TIME, dict, roundOpen: { ...LONDON, at: "not a time" },
    });
    expect(textOf(island.tree())).toBe("Time TBD");
  });
});
