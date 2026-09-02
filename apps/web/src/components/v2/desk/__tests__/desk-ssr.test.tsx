import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { plural } from "@/lib/i18n";
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
    const items = needsYouItems(en, desk(d, 1), names, "org", "comp", "en");
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

describe("desk.* copy (review round 3 — pluralization and subject-verb agreement)", () => {
  it("C2: exactly 1 unscheduled fixture reads singular, not '1 fixtures unscheduled'", () => {
    const d = div({ attention: [{ kind: "unscheduled", count: 1 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "unscheduled");
    expect(item?.title).toBe("Premier Division · 1 fixture unscheduled");
  });
  it("C2: more than 1 reads plural", () => {
    const d = div({ attention: [{ kind: "unscheduled", count: 3 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "unscheduled");
    expect(item?.title).toBe("Premier Division · 3 fixtures unscheduled");
  });
  it("C3: exactly 1 registration waiting reads singular, not '1 registrations waiting'", () => {
    const d = div({ attention: [{ kind: "registrations_waiting", count: 1 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "registrations_waiting");
    expect(item?.title).toBe("1 registration waiting for approval");
  });
  it("C4: masthead division count reads singular at n=1, plural otherwise", () => {
    expect(plural(en, "desk.masthead.divisions", 1, "en")).toBe("1 division");
    expect(plural(en, "desk.masthead.divisions", 2, "en")).toBe("2 divisions");
  });
  it("C1: a plural-looking stage name does not trigger subject-verb agreement on the title", () => {
    const d = div({ attention: [{ kind: "needs_draw", stageId: "fin", stageName: "Finals" }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "needs_draw");
    expect(item?.title).not.toContain("Finals has");
    expect(item?.title).toBe("Premier Division · no draw yet for Finals");
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
    // V2 fix (review round 1): the pill is the one thing that must survive
    // every width, so it's rendered TWICE — inline under the name (visible
    // below `md`) and in the dedicated column (visible at `md`+) — CSS
    // alone decides which copy shows; neither width is ever pill-less.
    expect(html.match(/data-pill="finished"/g)?.length).toBe(2);
    // V4 fix: no next fixture on a settled row prints nothing at all, not
    // "Nothing scheduled next".
    expect(html).not.toContain("Nothing scheduled next");
    // V5 fix: the ledger no longer renders its own "Divisions · N" heading
    // — the page's existing "Divisions" heading owns the count now.
    expect(html).not.toContain("Divisions · 1");
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
  it("mobile composition (review round 1, owner ruling): the pill and the full status line render in the SAME block as the name, and the two compositions stay each other's mutually-exclusive siblings", () => {
    const d = div({
      phase: "setting_up", played: 28, total: 28,
      attention: [{ kind: "needs_draw", stageId: "fin", stageName: "Finals" }],
    });
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{
          id: "d1", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: d,
          statusLine: "28 of 28 played · Finals not drawn",
        }]} />,
    );
    // The mobile block and the desktop block are markup-distinguishable
    // siblings — a future change that deletes one branch (rather than
    // editing it) makes one of these substrings disappear and fails here.
    expect(html).toContain("p-4 md:hidden");
    expect(html).toMatch(/hidden items-center gap-3[^"]*md:grid/);
    const mobileBlock = html.slice(html.indexOf("p-4 md:hidden"), html.indexOf("hidden items-center gap-3"));
    expect(mobileBlock).toContain("U16 Cup");
    // The pill renders in the mobile block itself — not behind a `hidden`
    // wrapper of its own.
    expect(mobileBlock).toContain('data-pill="needs_draw"');
    // The full status line, unclamped/untruncated.
    expect(mobileBlock).toContain("28 of 28 played · Finals not drawn");
  });
  it("mobile action button: absent without a red attention, 'Compute proposal' with needs_draw", () => {
    const noAttention = div({ phase: "scheduled", attention: [] });
    const htmlNone = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: noAttention, statusLine: "s" }]} />,
    );
    expect(htmlNone).not.toContain("Compute proposal");
    expect(htmlNone).not.toContain("btn-primary");

    const needsDraw = div({ phase: "setting_up", attention: [{ kind: "needs_draw", stageId: "fin", stageName: "Finals" }] });
    const htmlAction = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: needsDraw, statusLine: "s" }]} />,
    );
    expect(htmlAction).toContain("Compute proposal");
    expect(htmlAction).toContain('href="/o/org/c/comp/d/u16-cup?tab=fixtures"');
  });
  it("fix round 2: the desktop next column is dropped ledger-wide when no row has a next fixture — no reserved track, no empty cell", () => {
    const rowA = div({ phase: "finished", played: 15, total: 15, next: null });
    const rowB = div({ division_id: "d2", phase: "finished", played: 28, total: 28, next: null });
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[
          { id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: rowA, statusLine: "s1" },
          { id: "d2", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: rowB, statusLine: "s2" },
        ]} />,
    );
    expect(html).not.toContain("minmax(0,1.4fr)");
    // Not just blank — the cell itself must not be emitted, or the Open
    // column shifts into a dead track.
    expect(html).not.toContain('class="text-xs text-slate-900"');
  });
  it("fix round 2: the desktop next column is present ledger-wide when ANY row has a next fixture, and every row emits its cell (even an empty one) so Open stays on the same axis", () => {
    const withNext = div({
      phase: "scheduled",
      next: { home: "Riverside FC", away: "Summit CC", court_label: null, scheduled_at: "2026-09-12T09:00:00Z", in_play: false },
    });
    const withoutNext = div({ division_id: "d2", phase: "finished", next: null });
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[
          { id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: withNext, statusLine: "s1" },
          { id: "d2", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: withoutNext, statusLine: "s2" },
        ]} />,
    );
    expect(html).toContain("minmax(0,1.4fr)");
    const [, row1, row2] = html.split('data-testid="desk-ledger-row"');
    expect(row1).toContain("Riverside FC");
    expect(row1).toMatch(/<p class="text-xs text-slate-900">[^<]*Riverside FC/);
    // The row WITHOUT a next fixture still emits the (empty) cell.
    expect(row2).not.toContain("Riverside FC");
    expect(row2).toMatch(/<p class="text-xs text-slate-900"><\/p>/);
  });
});
