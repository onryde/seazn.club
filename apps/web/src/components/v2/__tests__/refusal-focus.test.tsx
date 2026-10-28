// The refusal block's focus (YouTube Connect T12 fix rounds 1-2, m4 and N1): when a YouTube refusal replaces the Go live button the
// organiser had just pressed, focus moves to the BLOCK — the role=alert box, tabIndex -1 — not to one of its buttons. The refusal commits
// while the start is still in flight, when Try again is disabled, so "the first enabled button" landed on Use another destination for
// the three retry-class codes (found by the re-review). The block is a deterministic target whichever action is enabled.
//
// `apps/web` vitest is `environment: "node"` — no DOM — so the callback ref is driven directly with a fake box that records what it was
// asked to do. What a real browser does with that focus (the ring, the Tab that follows) is the shots spec's.
import { describe, expect, it } from "vitest";
import { REFUSAL_FOCUS_RING, focusRefusalBlock } from "../refusal-focus";

function fakeBlock() {
  const focused: string[] = [];
  const looked: string[] = [];
  const block = {
    focus: () => focused.push("block"),
    // A block that goes looking for a button to focus (the round-1 behaviour) would call this: it must never be asked.
    querySelector: (selector: string) => {
      looked.push(selector);
      return { focus: () => focused.push("button") };
    },
  } as unknown as HTMLElement;
  return { block, focused, looked };
}

describe("focusRefusalBlock", () => {
  it("focuses the block ITSELF — and never goes looking for a button inside it (a disabled Try again would be skipped)", () => {
    const f = fakeBlock();
    focusRefusalBlock(f.block);
    expect(f.focused).toEqual(["block"]);
    expect(f.looked, "no search for an action: which one is enabled is not its business").toEqual([]);
  });

  it("the ref's detach (null) focuses nothing and throws nothing", () => {
    const f = fakeBlock();
    expect(() => focusRefusalBlock(null)).not.toThrow();
    expect(f.focused).toEqual([]);
  });

  it("each attach focuses once: the same call twice is two focuses, so the identity (not a flag) is what stops a re-render stealing focus", () => {
    const f = fakeBlock();
    focusRefusalBlock(f.block);
    focusRefusalBlock(f.block);
    expect(f.focused).toEqual(["block", "block"]);
  });
});

describe("REFUSAL_FOCUS_RING", () => {
  it("is the house keyboard ring on :focus-visible only — a 2px accent outline offset 2px (globals.css) — and never on plain :focus", () => {
    const tokens = REFUSAL_FOCUS_RING.split(/\s+/);
    expect(tokens.length, "anti-vacuity: the ring has tokens").toBeGreaterThan(2);
    for (const t of tokens) expect(t, "every token is behind focus-visible").toMatch(/^focus-visible:/);
    expect(tokens).toContain("focus-visible:outline");
    expect(tokens).toContain("focus-visible:outline-2");
    expect(tokens).toContain("focus-visible:outline-offset-2");
    expect(tokens.some((t) => /^focus-visible:outline-(violet|purple)-\d+$/.test(t)), "a house colour").toBe(true);
  });
});
