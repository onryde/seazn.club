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
  it("prints NO SCORE for an in-play fixture with an empty ledger, and the score otherwise", () => {
    const fixtureWithZeroEvents = fixture({ id: "f1", event_count: 0 });
    const fixtureWithEvents = fixture({ id: "f2", event_count: 3, home: "Harbour CC", away: "Dockside AC" });
    const html = renderToStaticMarkup(
      <InPlayBand
        competitionId="c1"
        initial={{ inPlay: [fixtureWithZeroEvents, fixtureWithEvents], upNext: null }}
        dict={en}
      />,
    );
    expect(html).toContain(en["desk.band.noScore"]);
    expect(html.split(en["desk.band.noScore"] as string).length - 1).toBe(1);
    // The scored fixture prints its event count instead of NO SCORE.
    expect(html).toContain(">3<");
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
