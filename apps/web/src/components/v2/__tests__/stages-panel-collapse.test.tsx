// Match Day PB1 item 3 (owner 2026-11-02): a COMPLETED stage's card is one line - number and name, the Completed pill and "{done} of {total}
// done" - until someone opens it; a running or not-started stage is always open. Node env, no DOM (AGENTS.md class 2): the DEFAULT is read
// off the real StagesPanel (static markup), the TAP and the "next render" are driven through the hook harness (the toggle is inline JSX of
// the panel, so its `onClick` is in the tree). Whether the body is really gone and the thumb really hits the line is the e2e's
// (`e2e/stage-card-c3.spec.ts`, `e2e/mobile.spec.ts`).
//
// The controller's seam (2026-11-02): `attentionStageIds` - a completed card starts OPEN when its id is listed, so a warning that lives on a
// finished stage (W3's Swiss cut-drift notice) is never folded away.
//
// Expected values come from the engine's declarations (`StageKind`, the stage statuses the schema names) and the dictionaries - never from the
// code under test. Every sweep reports its count; zero is a failure (TEST-STRATEGY).
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { tableRulesOf } from "../stage-rules/__tests__/_table-rules-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];
const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const sport = (key: string) => builtinModules.find((m) => m.key === key)!;
const DECIDED = { kind: "win", winner: "e1" };

const stageRow = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: A,
  seq: 1,
  kind: "league",
  name: "League",
  config: {},
  progression: null,
  status: "complete",
  ...o,
});
const fixture = (stageId: string, no: number, o: Partial<{ status: string; scheduled_at: string | null; outcome: unknown; away_entrant_id: string | null }> = {}) => ({
  id: `f-${stageId.slice(0, 2)}-${no}`,
  stage_id: stageId,
  pool_id: null,
  round_no: 1,
  seq_in_round: no,
  fixture_no: no,
  home_entrant_id: "e1",
  away_entrant_id: "e2" as string | null,
  scheduled_at: "2026-09-05T09:00:00.000Z" as string | null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: "decided",
  outcome: DECIDED as unknown,
  ...o,
});
/** Three played matches: a stage that can be (and is) complete. */
const playedFixtures = (stageId: string) => [1, 2, 3].map((no) => fixture(stageId, no));

const panelProps = (over: Record<string, unknown> = {}) => ({
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "o",
  compSlug: "c",
  divSlug: "d",
  stages: [stageRow()],
  fixtures: playedFixtures(A),
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  sportKey: "badminton",
  divisionConfig: {},
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: { plan: "pro", isStaff: false } as never,
  stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league"), [B]: tableRulesOf(sport("badminton"), "league") },
  ...over,
});
type PanelProps = ComponentProps<typeof StagesPanel>;
function panel(over: Record<string, unknown> = {}, locale: Locale = "en", dict: Dict = enUi as Dict): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StagesPanel {...(panelProps(over) as unknown as PanelProps)} />
    </DictProvider>,
  );
}

const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;
const tagOf = (html: string, testId: string): string | null => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The toggle's `aria-expanded`, the way the page marks it (null: no toggle on the page). */
const expandedOf = (html: string): string | null => /aria-expanded="(true|false)"/.exec(tagOf(html, "stage-collapse-toggle") ?? "")?.[1] ?? null;
/** Is the stage's body wrapper drawn with `hidden`? (null: the wrapper is missing.) */
const bodyHidden = (html: string, stageId: string): boolean | null => {
  const tag = new RegExp(`<div[^>]*\\sid="stage-body-${stageId}"[^>]*>`).exec(html)?.[0];
  return tag === undefined ? null : /\shidden(=""|\s|>)/.test(tag);
};

// ---- the island: the toggle's tap and the next render ----------------------------------------------------------------------------
const island = (over: Record<string, unknown> = {}) => renderIsland(StagesPanel, panelProps(over) as unknown as PanelProps);
type Island = { tree: () => ReactElement[]; rerender: (p: PanelProps) => void };
const ofId = (i: Island, id: string) => i.tree().filter((el) => propsOf(el)["data-testid"] === id);
const toggleEls = (i: Island) => ofId(i, "stage-collapse-toggle");
const isOpen = (i: Island, n = 0) => propsOf(toggleEls(i)[n]!)["aria-expanded"] as boolean;
const tapToggle = (i: Island, n = 0) => (propsOf(toggleEls(i)[n]!).onClick as () => void)();
const controlsShown = (i: Island) => ofId(i, "stage-controls").length;
const bodyOf = (i: Island, stageId: string) => i.tree().find((el) => propsOf(el).id === `stage-body-${stageId}`)!;

describe("PB1 item 3: a completed stage card starts as one line", () => {
  it("the empty case first: a completed stage with NO matches has nothing to fold - no toggle, body shown, its own sentence", () => {
    const html = panel({ fixtures: [] });
    expect(count(html, "stage-collapse-toggle"), "no toggle").toBe(0);
    expect(bodyHidden(html, A), "positive pair: the body wrapper is there, and shown").toBe(false);
    expect(text(html)).toContain((enUi as Record<string, string>)["schedule.noFixtures.can"]);
    // A stage of nothing but byes has no real match either.
    const byes = [fixture(A, 1, { away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "e1", loser: null, reason: "bye" } })];
    const html2 = panel({ fixtures: byes });
    expect(count(html2, "stage-collapse-toggle"), "byes only: no toggle").toBe(0);
    expect(bodyHidden(html2, A)).toBe(false);
  });

  it("completed with matches: collapsed, one toggle that names the body it controls, the name, the Completed pill and 'N of M done'", () => {
    const html = panel();
    expect(count(html, "stage-collapse-toggle"), "one toggle per card").toBe(1);
    const toggle = tagOf(html, "stage-collapse-toggle")!;
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain(`aria-controls="stage-body-${A}"`);
    expect(toggle).toMatch(/\bmin-h-11\b/);
    expect(bodyHidden(html, A), "the body it controls is drawn hidden").toBe(true);
    const ui = enUi as Record<string, string>;
    // The one line: "1. League", the Completed pill, "3 of 3 done" - and nothing else of the header.
    expect(text(html)).toContain("1. League");
    expect(text(html)).toContain(ui["schedule.sstatus.complete"]);
    const summary = /<span[^>]*data-testid="stage-collapsed-summary"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1];
    expect(summary).toBe(ui["runsheet.round.done.other"]!.replace("{done}", "3").replace("{total}", "3"));
    // The header's buttons fold away with the body (their panels render in the body).
    expect(count(html, "stage-controls"), "no rail / settings row on a folded card").toBe(0);
    expect(count(html, "stage-tool-format")).toBe(0);
    expect(count(html, "stage-sheet-tool-format")).toBe(0);
  });

  it("the summary is the SHARED count: a walkover and a cancellation are done, and the total leaves byes out", () => {
    const rows = [
      fixture(A, 1),
      fixture(A, 2, { status: "forfeited", outcome: { kind: "award", winner: "e1", loser: "e2", reason: "walkover" } }),
      fixture(A, 3, { status: "cancelled", outcome: null }),
      fixture(A, 4, { away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "e1", loser: null, reason: "bye" } }),
    ];
    const html = panel({ fixtures: rows });
    expect(/data-testid="stage-collapsed-summary"[^>]*>([^<]*)</.exec(html)?.[1]).toBe("3 of 3 done");
  });

  it("running and not-started stages are unchanged: no toggle, the header's buttons are there, the body is shown", () => {
    let checked = 0;
    for (const status of ["active", "pending"]) {
      const html = panel({ stages: [stageRow({ status })], fixtures: [fixture(A, 1, { status: "in_play", outcome: null }), fixture(A, 2, { status: "scheduled", outcome: null })] });
      expect(count(html, "stage-collapse-toggle"), `${status}: no toggle`).toBe(0);
      expect(count(html, "stage-collapsed-summary"), `${status}: no folded summary`).toBe(0);
      expect(count(html, "stage-controls"), `${status}: the header's controls`).toBe(1);
      expect(bodyHidden(html, A), `${status}: body shown`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a viewer's completed card folds too (the toggle is for reading, not editing), and the page has one toggle per completed card", () => {
    const html = panel({ canEdit: false });
    expect(count(html, "stage-collapse-toggle")).toBe(1);
    expect(expandedOf(html)).toBe("false");
    const two = panel({
      stages: [stageRow(), stageRow({ id: B, seq: 2, name: "Playoffs", status: "complete" })],
      fixtures: [...playedFixtures(A), ...playedFixtures(B)],
    });
    expect(count(two, "stage-collapse-toggle"), "one per completed card").toBe(2);
    expect(bodyHidden(two, A)).toBe(true);
    expect(bodyHidden(two, B)).toBe(true);
    const mixed = panel({
      stages: [stageRow(), stageRow({ id: B, seq: 2, name: "Playoffs", status: "active" })],
      fixtures: [...playedFixtures(A), fixture(B, 1, { status: "in_play", outcome: null })],
    });
    expect(count(mixed, "stage-collapse-toggle"), "only the completed card has one").toBe(1);
    expect(bodyHidden(mixed, A)).toBe(true);
    expect(bodyHidden(mixed, B)).toBe(false);
  });

  it("sweep every stage kind: a completed stage with matches folds whatever its format", () => {
    // Stage kinds are the engine's (`StageKind`); the fold depends on status and matches only, so a sport sweep would re-prove the same line.
    let checked = 0;
    for (const kind of StageKind.options) {
      const html = panel({ stages: [stageRow({ kind, name: `Stage ${kind}` })] });
      expect(count(html, "stage-collapse-toggle"), kind).toBe(1);
      expect(expandedOf(html), kind).toBe("false");
      expect(bodyHidden(html, A), kind).toBe(true);
      checked++;
    }
    expect(checked, "every kind swept").toBe(StageKind.options.length);
    expect(StageKind.options.some((k) => BRACKET_KINDS.has(k)), "premise: brackets among them").toBe(true);
  });

  it("a completed Swiss card's shape legend folds with the rest and comes back on open (positive pair: the open card does draw it)", () => {
    const swiss = { stages: [{ ...stageRow({ kind: "swiss", name: "Swiss" }), config: { rounds: 3 } }], activeEntrantIds: ["e1", "e2", "e3", "e4"] };
    expect(count(panel({ ...swiss, attentionStageIds: [A] }), "stage-swiss-legend"), "open: the legend is there").toBe(1);
    expect(count(panel(swiss), "stage-swiss-legend"), "folded: gone with the header's second line").toBe(0);
  });

  it("every locale says the folded line in its own words", () => {
    let checked = 0;
    for (const [loc, dict] of DICTS) {
      const html = panel({}, loc, dict);
      const want = (dict as Record<string, string>)["runsheet.round.done.other"]!.replace("{done}", "3").replace("{total}", "3");
      expect(/data-testid="stage-collapsed-summary"[^>]*>([^<]*)</.exec(html)?.[1], loc).toBe(want);
      expect(text(html), `${loc}: the pill`).toContain((dict as Record<string, string>)["schedule.sstatus.complete"]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("PB1 item 3: the attention seam - a completed card with something to read starts open", () => {
  it("completed + listed in attentionStageIds: expanded, body shown, buttons there - completed without: collapsed", () => {
    const withIt = panel({ attentionStageIds: [A] });
    expect(count(withIt, "stage-collapse-toggle"), "still collapsible: the person can fold it").toBe(1);
    expect(expandedOf(withIt)).toBe("true");
    expect(bodyHidden(withIt, A)).toBe(false);
    expect(count(withIt, "stage-controls")).toBe(1);
    expect(count(withIt, "stage-collapsed-summary")).toBe(0);
    const without = panel({});
    expect(expandedOf(without)).toBe("false");
    expect(bodyHidden(without, A)).toBe(true);
  });

  it("the seam is per stage: another stage's id (or an empty list) leaves this card folded", () => {
    expect(expandedOf(panel({ attentionStageIds: [B] }))).toBe("false");
    expect(expandedOf(panel({ attentionStageIds: [] }))).toBe("false");
    const two = panel({
      stages: [stageRow(), stageRow({ id: B, seq: 2, name: "Playoffs", status: "complete" })],
      fixtures: [...playedFixtures(A), ...playedFixtures(B)],
      attentionStageIds: [B],
    });
    expect(bodyHidden(two, A), "A folded").toBe(true);
    expect(bodyHidden(two, B), "B (listed) open").toBe(false);
  });

  it("the attention is only an opening default: a tap folds the listed card and a second tap opens it again", () => {
    const i = island({ attentionStageIds: [A] });
    expect(isOpen(i)).toBe(true);
    tapToggle(i);
    expect(isOpen(i), "folded by hand").toBe(false);
    tapToggle(i);
    expect(isOpen(i)).toBe(true);
  });

  it("attention on a stage that is not complete changes nothing (it has no toggle)", () => {
    const html = panel({ stages: [stageRow({ status: "active" })], fixtures: [fixture(A, 1, { status: "in_play", outcome: null })], attentionStageIds: [A] });
    expect(count(html, "stage-collapse-toggle")).toBe(0);
    expect(bodyHidden(html, A)).toBe(false);
  });

  it("the other reasons to look: a match still open on a completed stage, or a settings panel already open, keep the card open", () => {
    const openMatch = panel({ fixtures: [...playedFixtures(A), fixture(A, 4, { status: "in_play", outcome: null })] });
    expect(expandedOf(openMatch), "an open match on a 'complete' stage is a state to look at").toBe("true");
    const withPanel = panel({ initialOpenPanels: ["format"] });
    expect(expandedOf(withPanel), "a panel opened (a deep link) is never folded away").toBe("true");
    expect(bodyHidden(withPanel, A)).toBe(false);
  });
});

describe("PB1 item 3: the tap, and the card that completes", () => {
  it("the toggle opens a folded card (body shown, buttons back, the folded line gone) and folds it again, any number of times", () => {
    const i = island();
    expect(isOpen(i), "default: folded").toBe(false);
    expect(controlsShown(i)).toBe(0);
    expect(propsOf(bodyOf(i, A)).hidden).toBe(true);
    const seen: boolean[] = [];
    for (let n = 0; n < 3; n++) {
      tapToggle(i);
      seen.push(isOpen(i));
      expect(propsOf(bodyOf(i, A)).hidden, "opened: body shown").toBe(false);
      expect(controlsShown(i), "opened: the header's controls are back").toBe(1);
      expect(ofId(i, "stage-collapsed-summary"), "opened: the folded line is gone").toHaveLength(0);
      tapToggle(i);
      seen.push(isOpen(i));
      expect(propsOf(bodyOf(i, A)).hidden, "folded: body hidden").toBe(true);
      expect(controlsShown(i)).toBe(0);
    }
    expect(seen).toEqual([true, false, true, false, true, false]);
  });

  it("one card's tap leaves the other card alone", () => {
    const i = island({
      stages: [stageRow(), stageRow({ id: B, seq: 2, name: "Playoffs", status: "complete" })],
      fixtures: [...playedFixtures(A), ...playedFixtures(B)],
    });
    expect(toggleEls(i)).toHaveLength(2);
    tapToggle(i, 1);
    expect([isOpen(i, 0), isOpen(i, 1)]).toEqual([false, true]);
    tapToggle(i, 0);
    expect([isOpen(i, 0), isOpen(i, 1)]).toEqual([true, true]);
  });

  it("the choice is kept across the re-render a router refresh brings (same page visit), and the card's default follows new props otherwise", () => {
    const i = island();
    tapToggle(i); // open it by hand
    i.rerender(panelProps() as unknown as PanelProps);
    expect(isOpen(i), "still open: the person's choice").toBe(true);
    tapToggle(i); // fold it
    i.rerender(panelProps({ attentionStageIds: [A] }) as unknown as PanelProps);
    expect(isOpen(i), "still folded: attention is the default, not a command").toBe(false);
  });

  it("a stage that COMPLETES is folded on the next render; the card it was before had no toggle", () => {
    const running = panelProps({ stages: [stageRow({ status: "active" })], fixtures: [...playedFixtures(A).slice(0, 2), fixture(A, 3, { status: "in_play", outcome: null })] });
    const i = renderIsland(StagesPanel, running as unknown as PanelProps);
    expect(toggleEls(i), "running: no toggle").toHaveLength(0);
    expect(propsOf(bodyOf(i, A)).hidden).toBe(false);
    i.rerender(panelProps() as unknown as PanelProps); // the server says: complete, every match settled
    expect(toggleEls(i), "completed: a toggle").toHaveLength(1);
    expect(isOpen(i), "and it starts folded").toBe(false);
    expect(propsOf(bodyOf(i, A)).hidden).toBe(true);
    expect(controlsShown(i)).toBe(0);
  });

  it("a card the person opened, whose stage then stops being complete, shows its body and loses the toggle (nothing stays folded behind a toggle it no longer has)", () => {
    const i = island();
    tapToggle(i);
    tapToggle(i); // folded by hand: an explicit 'closed' choice is on record
    expect(isOpen(i)).toBe(false);
    i.rerender(panelProps({ stages: [stageRow({ status: "active" })], fixtures: [fixture(A, 1, { status: "in_play", outcome: null })] }) as unknown as PanelProps);
    expect(toggleEls(i), "no toggle on a running stage").toHaveLength(0);
    expect(propsOf(bodyOf(i, A)).hidden, "and the body is shown").toBe(false);
    expect(controlsShown(i), "with its controls").toBe(1);
  });
});
