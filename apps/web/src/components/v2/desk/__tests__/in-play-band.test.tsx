import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { InPlayBand } from "@/components/v2/desk/in-play-band";
import type { DeskInPlayFixture, DeskNextFixture } from "@/server/usecases/competition-desk";

const fixture = (o: Partial<DeskInPlayFixture> = {}): DeskInPlayFixture => ({
  id: "f1",
  division_id: "d1",
  division_name: "Premier Division",
  home: "Riverside FC",
  away: "Summit CC",
  fixture_no: 1,
  event_count: 0,
  headline: null,
  started_at: "2026-09-06T09:00:00Z",
  ...o,
});

const nextFixture = (o: Partial<DeskNextFixture> = {}): DeskNextFixture => ({
  home: "Valley CC",
  away: "Lakeside FC",
  scheduled_at: "2026-09-06T11:00:00Z",
  in_play: false,
  ...o,
});

describe("InPlayBand", () => {
  it("renders nothing when no fixture is in play", () => {
    const html = renderToStaticMarkup(
      <InPlayBand competitionId="c1" initial={{ inPlay: [], upNext: null }} dict={en} />,
    );
    expect(html).toBe("");
  });

  // The point of this test is the COUNT, not mere presence: a band that
  // prints "NO SCORE" on every card (or never removes it) would also
  // satisfy a bare `toContain`.
  it("prints NO SCORE for an in-play fixture with an empty ledger, and the SCORELINE otherwise", () => {
    const fixtureWithZeroEvents = fixture({ id: "f1", event_count: 0 });
    // 21-18 is a scoreline; 3 is a ledger depth. The distinction is the whole
    // point of review finding M1 — this test was previously titled "and the
    // score otherwise" while asserting `toContain(">3<")` on the `event_count`
    // it had just handed the component, so it named the defect it was
    // protecting (AGENTS.md failure class 4). The expected value must be
    // something an event count could never produce, or the test cannot
    // witness the regression it exists for.
    const fixtureWithScore = fixture({
      id: "f2",
      event_count: 37,
      headline: "21-18",
      home: "Harbour CC",
      away: "Dockside AC",
    });
    const html = renderToStaticMarkup(
      <InPlayBand
        competitionId="c1"
        initial={{ inPlay: [fixtureWithZeroEvents, fixtureWithScore], upNext: null }}
        dict={en}
      />,
    );
    expect(html).toContain(en["desk.band.noScore"]);
    expect(html.split(en["desk.band.noScore"] as string).length - 1).toBe(1);
    expect(html, "the scoreline is not rendered").toContain(">21-18<");
    // And the ledger depth is NOWHERE on the card. Without this the component
    // could render both and still satisfy the assertion above.
    expect(html, "the ledger event count leaked into the card").not.toContain(">37<");
  });

  it("prints NO SCORE when the fixture is being recorded but its engine publishes no headline", () => {
    // `event_count > 0` alone used to be enough to light the scoreboard slot,
    // which is how a non-score got in there. A recording fixture with no
    // headline must print NO SCORE rather than substitute anything.
    const recordingNoHeadline = fixture({ id: "f1", event_count: 12, headline: null });
    const html = renderToStaticMarkup(
      <InPlayBand competitionId="c1" initial={{ inPlay: [recordingNoHeadline], upNext: null }} dict={en} />,
    );
    expect(html).toContain(en["desk.band.noScore"]);
    expect(html, "the ledger event count was printed as a score").not.toContain(">12<");
  });

  it("renders one card per in-play fixture, across divisions", () => {
    const a = fixture({ id: "f1", division_id: "d1", division_name: "Premier Division", home: "A", away: "B" });
    const b = fixture({ id: "f2", division_id: "d2", division_name: "Junior Cup", home: "C", away: "D" });
    const html = renderToStaticMarkup(
      <InPlayBand competitionId="c1" initial={{ inPlay: [a, b], upNext: null }} dict={en} />,
    );
    expect(html.match(/data-testid="desk-in-play-card"/g)?.length).toBe(2);
    expect(html).toContain("Premier Division");
    expect(html).toContain("Junior Cup");
  });

  it("renders the dashed up-next card when there is a fixture in play AND an up_next candidate", () => {
    const html = renderToStaticMarkup(
      <InPlayBand
        competitionId="c1"
        initial={{ inPlay: [fixture()], upNext: nextFixture() }}
        dict={en}
      />,
    );
    expect(html).toContain('data-testid="desk-up-next-card"');
    expect(html).toContain("Valley CC");
    expect(html).toContain("Lakeside FC");
    expect(html).toContain(en["desk.band.upNext"]);
  });

  it("omits the up-next card when up_next is null, even while the band renders", () => {
    const html = renderToStaticMarkup(
      <InPlayBand competitionId="c1" initial={{ inPlay: [fixture()], upNext: null }} dict={en} />,
    );
    expect(html).not.toContain('data-testid="desk-up-next-card"');
  });

  // The band's own scroll container owes a keyboard stop, a role and a name
  // unconditionally (AGENTS.md #22/#23) — a scrolling region axe would flag
  // `scrollable-region-focusable` on otherwise, and tabindex cannot be
  // varied by media query.
  it("the scroll region carries tabindex, role and an accessible name", () => {
    const html = renderToStaticMarkup(
      <InPlayBand competitionId="c1" initial={{ inPlay: [fixture()], upNext: null }} dict={en} />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-label="${en["desk.band.aria"]}"`);
  });
});
