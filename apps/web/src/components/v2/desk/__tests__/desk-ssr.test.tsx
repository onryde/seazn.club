import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { PhasePill } from "@/components/v2/desk/phase-pill";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { DivisionLedger } from "@/components/v2/desk/division-ledger";
import type { CompetitionDesk, DeskDivision } from "@/server/usecases/competition-desk";

const div = (o: Partial<DeskDivision> = {}): DeskDivision => ({
  division_id: "d1", phase: "scheduled", attention: [], played: 10, total: 15, unscheduled: 0, in_play: 0,
  entrants: 6, awaiting_confirmation: 0, stage_kinds: ["league"], next: null, needs_draw_stage: null,
  fixture_names: {}, display_tz: "Europe/London", ...o,
});
const desk = (d: DeskDivision, inPlay = 0): CompetitionDesk => ({ org_tz: "Europe/London", in_play: inPlay, divisions: new Map([[d.division_id, d]]) });
const names = [{ id: "d1", name: "Premier Division", slug: "premier-division" }];

describe("PhasePill", () => {
  it("shows the phase when nothing is red", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" />);
    expect(html).toContain('data-phase="scheduled"');
    expect(html).toContain("Scheduled");
  });
  it("red attention beats the phase", () => {
    const html = renderToStaticMarkup(
      <PhasePill dict={en} phase="setting_up" attention={[{ kind: "needs_draw", stageId: "s", stageName: "Finals" }]} />,
    );
    expect(html).toContain('data-phase="setting_up"');
    expect(html).toContain('data-pill="needs_draw"');
    expect(html).toContain("Needs draw");
    expect(html).not.toContain("Setting up");
  });
  it("amber attention does not beat the phase", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" attention={[{ kind: "unscheduled", count: 3 }]} />);
    expect(html).toContain("Scheduled");
    expect(html).not.toContain('data-pill="unscheduled"');
  });
  it("in_play carries the count", () => {
    expect(renderToStaticMarkup(<PhasePill dict={en} phase="in_play" inPlay={2} />)).toContain("2 in play");
  });
});

describe("NeedsYou", () => {
  it("renders nothing at all when there is nothing to do", () => {
    expect(NeedsYou({ dict: en, items: [] })).toBeNull();
  });
  it("builds one item per attention with a division-scoped href, severity first", () => {
    const d = div({
      phase: "match_day", in_play: 1,
      attention: [
        { kind: "unscheduled", count: 3 },
        { kind: "no_scorer", fixtureId: "f9", minutesSinceKickoff: 12 },
      ],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d, 1), names, "org", "comp");
    expect(items.map((i) => i.kind)).toEqual(["no_scorer", "unscheduled"]);
    expect(items[0].title).toBe("Premier Division · Riverside FC v Summit CC has no scorer");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division/f/9");
    expect(items[1].action.href).toBe("/o/org/c/comp/d/premier-division/schedule");
    const html = renderToStaticMarkup(<NeedsYou dict={en} items={items} />);
    expect(html).toContain('data-attention="no_scorer"');
    expect(html).toContain('data-severity="red"');
    expect(html).toContain("Assign scorer");
  });
});

describe("DivisionLedger", () => {
  it("row carries the sport glyph, the status line, the phase and no monogram letter", () => {
    const d = div({ phase: "finished", played: 15, total: 15 });
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: d, statusLine: "15 of 15 played · complete" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="finished"');
    expect(html).toContain("⚽");
    expect(html).toContain("15 of 15 played · complete");
    expect(html).not.toMatch(/Nothing scheduled yet/);
    expect(html).toContain('href="/o/org/c/comp/d/premier-division"');
  });
  it("renders a row without pill or next line when the desk summary is unavailable", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: null, desk: null, statusLine: "10 of 15 played" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="unknown"');
    expect(html).not.toContain("data-pill=");
    expect(html).toContain("10 of 15 played");
  });
  it("uses the uploaded logo instead of the glyph when present", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: "https://cdn/x.png", desk: div(), statusLine: "s" }]} />,
    );
    expect(html).toContain('src="https://cdn/x.png"');
    expect(html).not.toContain("⚽");
  });
});
