// Match Day E1 fix round 1 (m4): Escape dismisses a bubble that hover or focus is holding up (WCAG 1.4.13), and the dismissal lasts
// until the pointer and focus have both left and one of them returns. The transitions, every one, as pure functions.
import { describe, expect, it } from "vitest";
import { TIP_CLOSED, tipEscape, tipLeft, tipOutside, tipShown, tipToggle, type TipState } from "../reason-tip-state";

describe("tipShown", () => {
  it("the whole table: tap shows it, hover/focus show it unless dismissed, nothing shows nothing", () => {
    const rows: [TipState, boolean, boolean][] = [
      [{ open: false, dismissed: false }, false, false],
      [{ open: false, dismissed: false }, true, true], // hover / focus
      [{ open: false, dismissed: true }, true, false], // hover / focus, but Escape put it away
      [{ open: true, dismissed: false }, false, true], // tapped open, pointer gone
      [{ open: true, dismissed: false }, true, true],
      [{ open: false, dismissed: true }, false, false],
    ];
    for (const [state, engaged, want] of rows) expect(tipShown(state, engaged), JSON.stringify({ state, engaged })).toBe(want);
    expect(rows.length, "anti-vacuity: six cases").toBe(6);
  });
});

describe("tipEscape", () => {
  it("a bubble held up by hover or focus is dismissed, and Escape is spent", () => {
    const out = tipEscape(TIP_CLOSED, true);
    expect(out.consumed).toBe(true);
    expect(out.state).toEqual({ open: false, dismissed: true });
    expect(tipShown(out.state, true), "still hovered / focused, and the bubble is away").toBe(false);
  });

  it("a tapped-open bubble closes; with the pointer or focus still on it, it stays away too", () => {
    const out = tipEscape({ open: true, dismissed: false }, true);
    expect(out).toEqual({ state: { open: false, dismissed: true }, consumed: true });
    // ...and with neither left on it (a tap, then the pointer moved off) there is nothing to keep dismissed.
    expect(tipEscape({ open: true, dismissed: false }, false)).toEqual({ state: { open: false, dismissed: false }, consumed: true });
  });

  it("nothing showing: Escape is NOT spent (the bottom sheet around the tip still closes on it), and the state is untouched", () => {
    expect(tipEscape(TIP_CLOSED, false)).toEqual({ state: TIP_CLOSED, consumed: false });
    // The second Escape, after a dismissal while still hovered: also not spent.
    const dismissed = tipEscape(TIP_CLOSED, true).state;
    expect(tipEscape(dismissed, true)).toEqual({ state: dismissed, consumed: false });
  });
});

describe("the dismissal lasts until pointer and focus have both left, and one returns", () => {
  it("the sequence: hover -> Escape -> still hovering (away) -> leave (back) -> hover again (shown)", () => {
    let s = TIP_CLOSED;
    expect(tipShown(s, true), "hovering: shown").toBe(true);
    s = tipEscape(s, true).state;
    expect(tipShown(s, true), "Escape: away, pointer has not moved").toBe(false);
    // Focus leaves while the pointer stays: still engaged, so still dismissed.
    s = tipLeft(s, true);
    expect(s.dismissed, "one of the two left; the other is still there").toBe(true);
    expect(tipShown(s, true)).toBe(false);
    // The pointer leaves too.
    s = tipLeft(s, false);
    expect(s.dismissed, "both gone: the dismissal is over").toBe(false);
    expect(tipShown(s, false), "nothing engaged: nothing shown").toBe(false);
    expect(tipShown(s, true), "the pointer returns: the bubble shows again").toBe(true);
  });

  it("tipLeft on a state that was never dismissed changes nothing", () => {
    expect(tipLeft(TIP_CLOSED, false)).toBe(TIP_CLOSED);
    const tapped: TipState = { open: true, dismissed: false };
    expect(tipLeft(tapped, false)).toBe(tapped);
  });

  it("asking for the bubble (a tap) ends a dismissal and shows it", () => {
    const away = tipEscape(TIP_CLOSED, true).state;
    const tapped = tipToggle(away);
    expect(tapped).toEqual({ open: true, dismissed: false });
    expect(tipShown(tapped, true)).toBe(true);
  });
});

describe("tap and outside", () => {
  it("a tap toggles open; a press outside closes a tapped-open bubble and leaves a dismissal alone", () => {
    expect(tipToggle(TIP_CLOSED)).toEqual({ open: true, dismissed: false });
    expect(tipToggle({ open: true, dismissed: false })).toEqual({ open: false, dismissed: false });
    expect(tipOutside({ open: true, dismissed: false })).toEqual({ open: false, dismissed: false });
    const away: TipState = { open: false, dismissed: true };
    expect(tipOutside(away)).toBe(away);
    expect(tipOutside(TIP_CLOSED)).toBe(TIP_CLOSED);
  });
});
