// Modal — focus trap (RS004 review finding 4, app-wide, owner-approved).
//
// The overlay blocked the mouse, not the keyboard: while a modal was open,
// background controls stayed Tab-reachable, nothing moved focus INTO the
// dialog on open, and nothing restored it to the trigger on close.
//
// This workspace has no jsdom — see _hook-harness.tsx's own header comment
// ("the workspace has no jsdom", kept out deliberately to avoid a
// build-time dependency for a handful of lines) — so the DOM half of a
// focus trap (real `.focus()` calls, `document.activeElement`, dispatching
// a Tab keydown) is not unit-testable here. Split accordingly:
//
//   - `nextTrapFocus` is the trap's actual DECISION logic — which element,
//     if any, a Tab/Shift+Tab press at a boundary should move focus to —
//     with no DOM reads or writes at all, so it gets real, honest
//     behavioural unit tests below, no DOM required.
//   - the DOM-wiring half (attaching the keydown listener, calling
//     `.focus()`, reading `document.activeElement`) is pinned by reading
//     modal.tsx's own source text, same technique as
//     modal-viewport-units.test.ts. These are SOURCE-LEVEL assertions, not
//     proof of runtime keyboard behaviour — named and commented as such on
//     purpose. (RS004 review finding 3, elsewhere in this wave, is exactly
//     about a test overclaiming what it proves; this file tries hard not to
//     repeat that mistake.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { Modal, nextTrapFocus, FOCUSABLE_SELECTOR } from "@/components/modal";

const source = readFileSync(fileURLToPath(new URL("../modal.tsx", import.meta.url)), "utf8");

describe("nextTrapFocus — pure Tab/Shift+Tab boundary decision, no DOM", () => {
  it("wraps Shift+Tab from the first item to the last", () => {
    expect(nextTrapFocus(["a", "b", "c"], "a", true)).toBe("c");
  });

  it("wraps Tab from the last item to the first", () => {
    expect(nextTrapFocus(["a", "b", "c"], "c", false)).toBe("a");
  });

  it("does not intervene on Tab from a middle item — native order handles it", () => {
    expect(nextTrapFocus(["a", "b", "c"], "b", false)).toBeNull();
  });

  it("does not intervene on Shift+Tab from a middle item", () => {
    expect(nextTrapFocus(["a", "b", "c"], "b", true)).toBeNull();
  });

  it("does not intervene on Tab from the first item — that boundary only matters for Shift+Tab", () => {
    expect(nextTrapFocus(["a", "b", "c"], "a", false)).toBeNull();
  });

  it("does not intervene on Shift+Tab from the last item — that boundary only matters for Tab", () => {
    expect(nextTrapFocus(["a", "b", "c"], "c", true)).toBeNull();
  });

  it("a single-item dialog re-targets itself at both boundaries — nowhere else to trap to", () => {
    expect(nextTrapFocus(["only"], "only", false)).toBe("only");
    expect(nextTrapFocus(["only"], "only", true)).toBe("only");
  });

  it("an empty focusable list never throws and never traps — nothing focusable to trap INTO (must not throw or trap focus in a void)", () => {
    expect(() => nextTrapFocus([], null, false)).not.toThrow();
    expect(nextTrapFocus([], null, false)).toBeNull();
    expect(nextTrapFocus([], null, true)).toBeNull();
  });

  it("an active element outside the tracked list does not trigger a wrap", () => {
    expect(nextTrapFocus(["a", "b", "c"], "somewhere-else", false)).toBeNull();
  });
});

describe("FOCUSABLE_SELECTOR — what this trap treats as a tab stop", () => {
  it("includes select and textarea — the registration hub config panel (the surface that motivated this fix) has both; a selector that omits them mis-detects the dialog's true first/last tab stop", () => {
    expect(FOCUSABLE_SELECTOR).toContain("select");
    expect(FOCUSABLE_SELECTOR).toContain("textarea");
  });

  it("excludes disabled controls — a disabled control matches a naive selector but can never actually hold keyboard focus, so treating it as a boundary computes a wrap target native Tab never lands on", () => {
    expect(FOCUSABLE_SELECTOR).toContain(":not(:disabled)");
  });

  it("includes iframe — billing-actions.tsx, buy-credits.tsx and pass-upgrade.tsx render ONLY a Stripe EmbeddedCheckout iframe with no footer; without this the only detected tab stop is the header close button and forward-Tab would re-trap on itself, permanently blocking keyboard entry into the payment form", () => {
    expect(FOCUSABLE_SELECTOR).toContain("iframe");
  });
});

// --- Source-level pins (DOM wiring) -------------------------------------
// See file header: these read modal.tsx's own text. They pin structure and
// wiring, not runtime keyboard behaviour.
describe("Modal — focus-trap wiring (source-level pins; see file header)", () => {
  it("the dialog element itself (not the overlay) carries the ref the trap queries", () => {
    const overlayTagEnd = source.indexOf("onClick={onClose}>") + "onClick={onClose}>".length;
    const dialogTagStart = source.indexOf('role="dialog"');
    expect(overlayTagEnd).toBeGreaterThan("onClick={onClose}>".length - 1);
    // Everything strictly AFTER the overlay div's own opening tag closes, up
    // to the dialog's role attribute — so a match here can only be on a
    // later element (the dialog), never the overlay's own tag.
    const afterOverlayTag = source.slice(overlayTagEnd, dialogTagStart + 20);
    expect(afterOverlayTag).toMatch(/ref=\{dialogRef\}/);
  });

  it("captures the pre-open focus target during RENDER, not inside an effect", () => {
    // ConfirmModal's typeToConfirm input carries `autoFocus`, which React
    // applies during commit — before any passive effect runs. Capturing
    // "what was focused before this opened" inside an effect would
    // sometimes read the autoFocus target back instead of the real trigger.
    expect(source).toMatch(/useState<Element \| null>\(\(\) =>/);
  });

  it("does not steal focus from something the dialog already focused itself (e.g. autoFocus)", () => {
    expect(source).toMatch(/dialog\?\.contains\(document\.activeElement\)/);
  });

  it("registers a keydown listener on open and removes it on cleanup", () => {
    expect(source).toContain('document.addEventListener("keydown", onKey)');
    expect(source).toContain('document.removeEventListener("keydown", onKey)');
  });

  it("wires Tab handling through the pure nextTrapFocus decision, not separate inline logic", () => {
    // Matches the ARGUMENT ROLES, not one spelling of them: the active element
    // is read from document.activeElement and handed to nextTrapFocus together
    // with the focusable list and the shift flag. The original regex pinned
    // `document.activeElement` inline as the second argument and broke the
    // moment that read was narrowed to a local — a test failing over a rename
    // while the wiring is intact is a test that will get deleted rather than
    // fixed.
    expect(source).toMatch(/document\.activeElement as HTMLElement \| null/);
    expect(source).toMatch(/nextTrapFocus\(focusables\(\),\s*\w+,\s*e\.shiftKey\)/);
  });

  it("restores focus to the captured pre-open target when the dialog closes", () => {
    const addIdx = source.indexOf("addEventListener");
    const cleanupIdx = source.indexOf("return () => {", addIdx);
    const cleanup = source.slice(cleanupIdx, cleanupIdx + 300);
    expect(cleanup).toMatch(/restoreTarget[\s\S]*?\.focus\?\.\(\)/);
  });

  it("Escape still closes the dialog", () => {
    expect(source).toMatch(/e\.key === "Escape"/);
  });

  it("still marks the dialog role and aria-modal — unchanged by this fix", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });
});

// --- placement="side" (sponsor deals PR 2, Task 15) ----------------------------------------------------------------------------
// The sponsor page opens over its list as a full-height panel on the right from md, and is the bottom sheet every Modal is below md.
// Class-string tests (no DOM here): what is pinned is the markup a browser is handed. The anchors are whole tokens - `/\bmd:hidden\b/`
// style matches would also hit `max-md:hidden` - so every comparison is on split class tokens.
describe("Modal placement=\"side\" - a right-hand panel from md, unchanged below it", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const tokens = (el: ReactElement | undefined): string[] =>
    String((el?.props as { className?: string } | undefined)?.className ?? "").split(/\s+/).filter(Boolean);

  function parts(placement: "center" | "side" | undefined) {
    const island = renderIsland(Modal, { title: "Sponsor", onClose: () => {}, children: "x", placement });
    const tree = island.tree();
    const overlay = tree.find((el) => tokens(el).includes("modal-overlay"));
    const dialog = tree.find((el) => (el.props as { role?: string }).role === "dialog");
    island.unmount();
    return { overlay, dialog };
  }

  it("without it (every other Modal in the app) the classes are exactly what they were - the default placement is center", () => {
    for (const placement of [undefined, "center" as const]) {
      const { overlay, dialog } = parts(placement);
      expect(tokens(overlay).join(" ")).toBe("modal-overlay");
      expect(tokens(dialog).join(" ")).toBe(
        "flex max-h-[85dvh] w-full sm:max-w-md flex-col rounded-t-2xl border border-purple-100 bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-6",
      );
    }
  });

  it("side ADDS classes and removes none: everything the center modal wears, the side one still wears", () => {
    const center = parts("center");
    const side = parts("side");
    let checked = 0;
    for (const key of ["overlay", "dialog"] as const) {
      const wearsNow = new Set(tokens(side[key]));
      for (const t of tokens(center[key])) {
        expect(wearsNow.has(t), `${key} keeps ${t}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("every class side adds is an md: variant, so below 768 the sheet is the bottom sheet it always was (max-md: and base classes unchanged)", () => {
    const center = parts("center");
    const side = parts("side");
    let added = 0;
    for (const key of ["overlay", "dialog"] as const) {
      const before = new Set(tokens(center[key]));
      const extra = tokens(side[key]).filter((t) => !before.has(t));
      expect(extra.length, `${key}: side changes something`).toBeGreaterThan(0);
      for (const t of extra) {
        expect(t, `${key}: ${t} only applies from md`).toMatch(/^md:/);
        expect(t, `${key}: ${t} is not a max-md: class`).not.toMatch(/^max-md:/);
        added++;
      }
      // the below-md classes the center modal has, side has too (none gained, none lost)
      expect(tokens(side[key]).filter((t) => t.startsWith("max-md:")), key).toEqual(tokens(center[key]).filter((t) => t.startsWith("max-md:")));
    }
    expect(added, "anti-vacuity: side added something to both the overlay and the dialog").toBeGreaterThanOrEqual(2);
  });

  it("from md the dialog is a full-height panel against the right edge: stretched overlay packed right, no height cap, rounded on the left only", () => {
    const { overlay, dialog } = parts("side");
    expect(tokens(overlay)).toEqual(expect.arrayContaining(["md:items-stretch", "md:justify-end", "md:p-0"]));
    expect(tokens(dialog)).toEqual(
      expect.arrayContaining(["md:h-full", "md:max-h-none", "md:rounded-none", "md:rounded-l-2xl", "md:border-y-0", "md:border-r-0"]),
    );
  });

  it("side composes with bleed (both keep their own classes)", () => {
    const island = renderIsland(Modal, { title: "x", onClose: () => {}, children: "x", placement: "side" as const, bleed: true });
    const dialog = island.tree().find((el) => (el.props as { role?: string }).role === "dialog");
    island.unmount();
    expect(tokens(dialog)).toEqual(expect.arrayContaining(["max-md:px-0", "md:h-full"]));
  });
});
