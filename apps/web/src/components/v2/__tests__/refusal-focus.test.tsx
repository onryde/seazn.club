// The refusal block's focus (YouTube Connect T12 fix rounds 1-2, m4 and N1): when a YouTube refusal replaces the Go live button the
// organiser had just pressed, focus moves to the BLOCK — the role=alert box, tabIndex -1 — not to one of its buttons. The refusal commits
// while the start is still in flight, when Try again is disabled, so "the first enabled button" landed on Use another destination for
// the three retry-class codes (found by the re-review). The block is a deterministic target whichever action is enabled.
//
// `apps/web` vitest is `environment: "node"` — no DOM — so the callback ref is driven directly with a fake box that records what it was
// asked to do. What a real browser does with that focus (the ring, the Tab that follows) is the shots spec's.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  // B4 fix round 1, m1: the ring is drawn in the house accent itself (globals.css `--ps-accent`, #7c3aed = violet-600), not a lighter
  // sibling: violet-400 is about 2.7:1 against white, under the 3:1 a focus indicator needs (WCAG 1.4.11).
  it("is drawn in the house accent (violet-600) — whose colour clears 3:1 against white, which the lighter violet-400 does not", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8");
    const accent = /--ps-accent:\s*(#[0-9a-f]{6})/i.exec(css)![1]!.toLowerCase();
    expect(accent, "the declaration the token stands for").toBe("#7c3aed");
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const vsWhite = (hex: string) => 1.05 / (lum(hex) + 0.05);
    expect(vsWhite(accent)).toBeGreaterThanOrEqual(3);
    expect(vsWhite("#a78bfa"), "premise: violet-400 (the old ring) is under 3:1").toBeLessThan(3);
    const tokens = REFUSAL_FOCUS_RING.split(/\s+/);
    expect(tokens).toContain("focus-visible:outline-violet-600");
    expect(tokens.filter((t) => t.startsWith("focus-visible:outline-violet-")), "one colour, not two").toEqual(["focus-visible:outline-violet-600"]);
  });
});
