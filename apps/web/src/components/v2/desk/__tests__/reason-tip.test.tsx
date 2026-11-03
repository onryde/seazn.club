// Match Day PB1 item 4 (owner 2026-11-02): the Complete reason is a bubble on the greyed button itself - the ⓘ beside it is gone. Hover and
// keyboard focus are CSS (the e2e's), so what is driven here is the half CSS cannot do: a tap/press on the wrapper toggles the bubble,
// a press inside the bubble does not, Escape spends itself only when a bubble is showing (the phone sheet around it closes on the same
// key otherwise), and a press outside closes a tapped-open bubble. No DOM (node env): `renderIsland` supplies the hooks, a fake `ref`
// stands in for the wrapper (`contains` / `matches` are all the component asks of it) and `document` is a recorder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { WithReasonTip } from "../reason-tip";

type Handler = (e: unknown) => void;

function rig() {
  const added: [string, Handler, unknown][] = [];
  const removed: [string, Handler][] = [];
  vi.stubGlobal("document", {
    addEventListener: (type: string, fn: Handler, opts?: unknown) => added.push([type, fn, opts]),
    removeEventListener: (type: string, fn: Handler) => removed.push([type, fn]),
  });
  const island = renderIsland(WithReasonTip, {
    id: "why",
    reason: "Complete stage unlocks when all 4 matches are played.",
    reasonTestId: "reason",
    children: <button type="button" data-testid="ctl" aria-describedby="why" />,
  });
  const root = () => island.tree()[0]!;
  const bubble = () => island.tree().find((e) => propsOf(e)["data-testid"] === "reason")!;
  const isOpen = () => propsOf(bubble())["data-open"] === "true";
  const klass = () => String(propsOf(bubble()).className);
  /** The wrapper element the pointer / focus is on (or not): `matches(":hover, :focus-within")` is what the component reads. */
  const engage = (engaged: boolean, inside = true) => {
    (propsOf(root()).ref as { current: unknown }).current = { matches: () => engaged, contains: () => inside };
  };
  /** The newest handler of a type: the effect re-registers on every state change. */
  const latest = (type: string): Handler => [...added].reverse().find(([t]) => t === type)![1];
  const tap = (insideBubble = false) =>
    (propsOf(root()).onClick as Handler)({ target: { closest: () => (insideBubble ? {} : null) } });
  const escape = () => {
    let prevented = 0;
    latest("keydown")({ key: "Escape", preventDefault: () => prevented++ });
    return prevented;
  };
  return { island, added, removed, root, bubble, isOpen, klass, engage, latest, tap, escape };
}

afterEach(() => vi.unstubAllGlobals());

describe("WithReasonTip - the bubble on a greyed control (PB1)", () => {
  it("starts closed, always in the DOM as a tooltip the control is described by, shown by hover/focus CSS alone", () => {
    const r = rig();
    expect(propsOf(r.bubble()).role).toBe("tooltip");
    expect(propsOf(r.bubble()).id).toBe("why");
    expect(r.isOpen()).toBe(false);
    expect(r.klass()).toMatch(/\bhidden\b/);
    // Hover reveals it from `md` only (below it the in-flow bubble would slide the control from under a press); focus at every width.
    expect(r.klass()).toMatch(/(^|\s)md:group-hover\/tip:block(\s|$)/);
    expect(r.klass()).not.toMatch(/(^|\s)group-hover\/tip:block(\s|$)/);
    expect(r.klass()).toMatch(/(^|\s)group-focus-within\/tip:block(\s|$)/);
    // The only control inside is the one handed in - no second button to find the reason through.
    const buttons = r.island.tree().filter((e) => e.type === "button");
    expect(buttons).toHaveLength(1);
    expect(propsOf(buttons[0]!)["aria-describedby"]).toBe("why");
  });

  it("a press on the control toggles it open and shut, any number of times", () => {
    const r = rig();
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      r.tap();
      seen.push(r.isOpen());
      r.tap();
      seen.push(r.isOpen());
    }
    expect(seen).toEqual([true, false, true, false, true, false]);
    r.tap();
    expect(r.klass(), "open: displayed, not just hover-shown").toMatch(/^block\b/);
  });

  it("a press INSIDE the bubble (selecting its words) is not a press on the control", () => {
    const r = rig();
    r.tap();
    expect(r.isOpen()).toBe(true);
    r.tap(true);
    expect(r.isOpen(), "still open: the press inside did not toggle it").toBe(true);
    const closed = rig();
    closed.tap(true);
    expect(closed.isOpen(), "and a press inside a closed bubble does not open it").toBe(false);
  });

  it("Escape closes a tapped-open bubble and is spent; with nothing showing it is left alone (the phone sheet closes on it)", () => {
    const r = rig();
    r.engage(false);
    expect(r.escape(), "nothing showing: Escape is NOT consumed").toBe(0);
    r.tap();
    expect(r.isOpen()).toBe(true);
    expect(r.escape(), "showing: Escape is consumed").toBe(1);
    expect(r.isOpen()).toBe(false);
    expect(r.escape(), "and spent once: the next Escape is not ours").toBe(0);
  });

  it("Escape puts away a bubble the pointer or focus is holding up, and it stays away until both have left and one returns", () => {
    const r = rig();
    r.engage(true); // hovered / focused: CSS shows it
    expect(r.escape(), "WCAG 1.4.13: dismissable without moving the pointer").toBe(1);
    expect(r.klass(), "away: hidden and no hover/focus reveal").not.toContain("group-hover/tip:block");
    expect(r.klass()).toMatch(/\bhidden\b/);
    // The pointer leaves while focus stays: still dismissed. Both gone: the dismissal is over and hover/focus show it again.
    (propsOf(r.root()).onPointerLeave as () => void)();
    expect(r.klass(), "one still engaged").not.toContain("group-hover/tip:block");
    r.engage(false);
    (propsOf(r.root()).onPointerLeave as () => void)();
    expect(r.klass(), "neither engaged any more: the dismissal ended").toContain("group-hover/tip:block");
  });

  it("a press outside closes a tapped-open bubble; a press inside the wrapper does not", () => {
    const r = rig();
    r.tap();
    r.engage(true, true);
    r.latest("pointerdown")({ target: {} });
    expect(r.isOpen(), "inside: stays open").toBe(true);
    r.engage(true, false);
    r.latest("pointerdown")({ target: {} });
    expect(r.isOpen(), "outside: closes").toBe(false);
  });

  it("Escape is heard in the CAPTURE phase (so it beats the sheet's own bubble-phase listener), and every listener is removed on change", () => {
    const r = rig();
    const key = r.added.find(([t]) => t === "keydown")!;
    expect(key[2], "capture").toBe(true);
    r.tap(); // a state change re-registers the effect: the old pair is removed first
    expect(r.removed.map(([t]) => t).sort()).toEqual(["keydown", "pointerdown"]);
    expect(r.removed.find(([t]) => t === "keydown")![1]).toBe(key[1]);
  });
});

describe("WithReasonTip - which edge the floating bubble hangs from (SCF fix round 1)", () => {
  const classOf = (align?: "start" | "end") => {
    vi.stubGlobal("document", { addEventListener: () => undefined, removeEventListener: () => undefined });
    const island = renderIsland(WithReasonTip, {
      id: "why",
      reason: "Why not",
      reasonTestId: "reason",
      ...(align === undefined ? {} : { align }),
      children: <button type="button" />,
    });
    return String(propsOf(island.tree().find((e) => propsOf(e)["data-testid"] === "reason")!).className);
  };

  it("hangs from the control's left edge by default, and from its right edge when asked (a control last in a right-aligned group)", () => {
    const tokens = (c: string) => c.split(/\s+/);
    expect(tokens(classOf()), "default").toContain("md:left-0");
    expect(tokens(classOf()), "default is not the right edge").not.toContain("md:right-0");
    expect(tokens(classOf("start"))).toContain("md:left-0");
    expect(tokens(classOf("end")), "end").toContain("md:right-0");
    expect(tokens(classOf("end")), "end is not the left edge").not.toContain("md:left-0");
  });
});
