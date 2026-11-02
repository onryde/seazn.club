import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StageRail, type StageRailProps } from "../stage-rail";

// Match Day E1 item 1 lives in its own file (fix round 1, I3): appended to `stage-rail.test.tsx` it collided with the W3 branch's own tests
// appended at the same line. Same neutral props as that file: a started stage with four matches still open.
const NEUTRAL = {
  counts: { played: 0, inPlay: 0, unplayed: 4 },
  matchCount: 4,
  open: false,
  onToggleOpen: () => {},
  swissHasUnseated: false,
  canUnpairSwiss: false,
  swissPairingMenu: null,
};

// Match Day E1 item 1 (owner 2026-11-01): the actions live in the card's HEADER, the Complete reason is on the waiting button (an ⓘ
// beside it until PB1 retired that), and a divider separates the actions group from the settings buttons beside it. Static markup for
// the structure; `renderIsland` for the press.
describe("StageRail - E1 item 1: header actions, the Complete reason, the divider", () => {
  const active = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;
  const complete = { ...(active as object), status: "complete" } as never;
  const rail = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <StageRail stage={active} canEdit busy={null} fixtureCount={4} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} {...NEUTRAL} {...over} />,
    );
  const tag = (html: string, testid: string) => new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? null;

  it("from md the sheet is the header's actions group: a flex row, no sheet chrome (the phone sheet classes are max-md only)", () => {
    const sheet = tag(rail(), "stage-rail-sheet") ?? "";
    expect(sheet, "the sheet renders").not.toBe("");
    expect(sheet).toMatch(/\bmd:flex\b/);
    expect(sheet).toMatch(/\bmd:flex-row\b/);
    expect(sheet).toMatch(/\bmd:items-center\b/);
    expect(sheet, "no block layout left over from the old below-the-rows card").not.toMatch(/\bmd:block\b/);
    expect(sheet, "no md padding on the old card edge").not.toMatch(/\bmd:py-4\b/);
  });

  it("the reason (PB1: no ⓘ): present only while Complete waits; the Complete button itself names the reason's id; the bubble carries the text", () => {
    const waiting = rail();
    expect(waiting, "the ⓘ trigger is retired").not.toContain("stage-complete-info");
    const button = tag(waiting, "stage-complete") ?? "";
    expect(button, "the greyed button owns the reason").toContain('aria-describedby="stage-complete-hint-s1"');
    expect(button).toContain('aria-disabled="true"');
    expect(button, "still on the 44px floor").toMatch(/\bmin-h-11\b/);
    // Nothing but Complete itself is a button in the reason's wrapper (no second control to find the reason through).
    const wrapperAt = waiting.indexOf("group/tip");
    expect(wrapperAt, "premise: the waiting button is wrapped by the reason tip").toBeGreaterThan(-1);
    const wrapper = waiting.slice(wrapperAt, waiting.indexOf("</span></span>", wrapperAt));
    expect(wrapper.split("<button").length - 1, "exactly one button in the wrapper: Complete").toBe(1);
    expect(wrapper).toContain('data-testid="stage-complete"');
    // The reason is a tooltip in the DOM the whole time - shown by hover/focus CSS, hidden otherwise - not a paragraph of its own.
    const reason = tag(waiting, "stage-complete-hint") ?? "";
    expect(reason).toContain('role="tooltip"');
    expect(reason).toContain('id="stage-complete-hint-s1"');
    expect(reason).toContain('data-open="false"');
    expect(reason).toMatch(/\bhidden\b/);
    expect(reason).toMatch(/group-hover\/tip:block/);
    expect(reason).toMatch(/group-focus-within\/tip:block/);
    expect(waiting).toContain("Complete stage unlocks when all 4 matches are played.");
    expect(waiting, "the old inline <p> hint is gone").not.toMatch(/<p[^>]*data-testid="stage-complete-hint"/);
    // The other side of it: nothing to explain, no bubble and no wrapper - and Complete is still there (the positive pair).
    const ready = rail({ counts: { played: 4, inPlay: 0, unplayed: 0 } });
    expect(tag(ready, "stage-complete"), "premise: Complete renders when it is ready").not.toBeNull();
    expect(ready).not.toContain("stage-complete-hint");
    expect(ready).not.toContain("group/tip");
  });

  it("a press on a waiting Complete does nothing; on a ready one it sends 'complete'; a press in flight disables it outright", () => {
    const press = (counts: { played: number; inPlay: number; unplayed: number }, busy: string | null) => {
      const sent: string[] = [];
      const island = renderIsland(StageRail, {
        stage: active, canEdit: true, busy, fixtureCount: 4, deletable: false,
        onAct: async (_id: string, action: string) => { sent.push(action); return true; },
        onDelete: () => {}, addingTo: null, onToggleAddMatch: () => {}, adhoc: false,
        ...NEUTRAL, counts, matchCount: 4,
      } as StageRailProps);
      const el = island.tree().find((e) => propsOf(e)["data-testid"] === "stage-complete");
      if (!el) throw new Error("no Complete button");
      (propsOf(el).onClick as () => void)();
      return { sent, disabled: propsOf(el).disabled, ariaDisabled: propsOf(el)["aria-disabled"] };
    };
    const waiting = press({ played: 0, inPlay: 0, unplayed: 4 }, null);
    expect(waiting.sent, "the press is swallowed").toEqual([]);
    expect(waiting.ariaDisabled).toBe(true);
    expect(waiting.disabled, "focusable: not `disabled`").toBe(false);
    const ready = press({ played: 4, inPlay: 0, unplayed: 0 }, null);
    expect(ready.sent, "positive pair: a ready Complete does send").toEqual(["complete"]);
    expect(ready.ariaDisabled).toBeUndefined();
    const busy = press({ played: 4, inPlay: 0, unplayed: 0 }, "s1");
    expect(busy.disabled, "a press in flight disables outright").toBe(true);
  });

  it("the divider: between the actions and the settings buttons only - needs both, and says nothing to a screen reader", () => {
    const withBoth = rail({ dividerAfter: true });
    const divider = tag(withBoth, "stage-controls-divider") ?? "";
    expect(divider, "drawn when there are actions and settings").not.toBe("");
    expect(divider).toContain('aria-hidden="true"');
    expect(divider).toMatch(/\bhidden\b/);
    expect(divider).toMatch(/\bmd:block\b/);
    // No settings beside it (the default): a stray line would divide nothing.
    expect(rail()).not.toContain("stage-controls-divider");
    // Settings but no action to divide them from: a complete stage with nothing deletable has an empty group.
    const empty = rail({ stage: complete, dividerAfter: true, counts: { played: 4, inPlay: 0, unplayed: 0 }, deletable: false });
    expect(empty, "positive pair: the rail itself rendered").toContain('data-testid="stage-rail-sheet"');
    expect(empty).not.toContain("stage-controls-divider");
    // Delete alone is an action: the divider is back.
    expect(rail({ stage: complete, dividerAfter: true, deletable: true, counts: { played: 4, inPlay: 0, unplayed: 0 } })).toContain("stage-controls-divider");
  });

  it("the old slots are gone: the rail draws no court tags and no 'to schedule' footer", () => {
    const html = rail({ open: true });
    expect(html).not.toContain("stage-unscheduled-count");
    expect(html).not.toContain("border-dashed");
  });
});
