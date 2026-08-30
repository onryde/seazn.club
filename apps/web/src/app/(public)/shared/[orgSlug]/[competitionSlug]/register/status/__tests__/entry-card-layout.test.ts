// Source contract for the two rows on the status entry card that pair a NAME
// with a status BADGE. Both badges are `shrink-0` and both names `truncate`,
// so on a narrow viewport the badge wins the row and the name collapses —
// at 320px the entry heading rendered as "Width Team ri..." and a roster row
// as "Width…", i.e. the page said a spot was unclaimed but not WHOSE.
//
// Why a source-level assertion rather than a rendered one: this workspace has
// no jsdom (see _hook-harness.tsx's header), and even with one, jsdom does no
// layout — it computes no widths, so it cannot see a truncation that only
// happens at a real 320px paint. The actual behaviour was verified by
// screenshot at 320/768/1280 against a production build; this test pins the
// class contract that produces it so a later edit cannot silently drop the
// wrap and reintroduce the defect.
//
// Note what the e2e matrix could NOT catch here: the seven-width
// no-horizontal-scroll gate passed both before and after this fix. A crushed
// name overflows nothing — it truncates, which is exactly what the gate is
// blind to by construction.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "entry-card.tsx"), "utf8");

/** The line that opens the row, i.e. the flex container holding name + badge. */
function rowOpening(afterMarker: string): string {
  const at = SOURCE.indexOf(afterMarker);
  expect(at, `could not find ${afterMarker} in entry-card.tsx`).toBeGreaterThan(-1);
  const slice = SOURCE.slice(at);
  const match = slice.match(/className="flex[^"]*"/);
  expect(match, `no flex row found after ${afterMarker}`).not.toBeNull();
  return match![0];
}

describe("entry card — a status badge never crushes the name beside it", () => {
  it("the entry heading row wraps rather than truncating the entry's own name", () => {
    // The row that carries division_name + display_name against the status badge.
    const row = rowOpening("<div className=\"min-w-0 flex-1 space-y-3 p-4\">");
    expect(row, "the heading row must wrap so the badge can drop to its own line").toContain("flex-wrap");
  });

  it("the name block in the heading row keeps a usable minimum width", () => {
    // `min-w-0` is what makes truncate work inside a flex child at all;
    // `basis-*` is what forces the wrap instead of an ever-narrower name.
    const at = SOURCE.indexOf("{entry.division_name}");
    expect(at).toBeGreaterThan(-1);
    const block = SOURCE.slice(Math.max(0, at - 400), at);
    expect(block).toContain("min-w-0");
    expect(block).toMatch(/basis-\d+/);
  });

  // FIX 5 (RS007 review, hardening — not a live bug; the 320/768/1280
  // screenshots already pin the correct rendering). `flex-1` expands to
  // `flex: 1 1 0%`, which sets its OWN flex-basis — whether the `basis-*`
  // utility wins is Tailwind utility-ORDER dependent. `grow` (`flex-grow:
  // 1`) never touches flex-basis, so `basis-*` can never be silently
  // outranked by a future ordering change. Cascade-proofs the wrap without
  // changing anything else about the class list.
  it("uses `grow`, never `flex-1`, so a Tailwind ordering change can never let flex-1's own basis outrank basis-*", () => {
    const at = SOURCE.indexOf("{entry.division_name}");
    const headingBlock = SOURCE.slice(Math.max(0, at - 400), at);
    expect(headingBlock).toContain("grow");
    expect(headingBlock).not.toMatch(/\bflex-1\b/);

    const rosterAt = SOURCE.indexOf("{displayNameById.get(p.id)}");
    const rosterBlock = SOURCE.slice(Math.max(0, rosterAt - 200), rosterAt);
    expect(rosterBlock).toContain("grow");
    expect(rosterBlock).not.toMatch(/\bflex-1\b/);
  });

  it("each roster row wraps rather than truncating the player's name", () => {
    const row = rowOpening("entry.players.map");
    expect(row, "the roster row must wrap so its badge can drop to its own line").toContain("flex-wrap");
  });

  it("the roster player name keeps a usable minimum width", () => {
    const at = SOURCE.indexOf("{displayNameById.get(p.id)}");
    expect(at).toBeGreaterThan(-1);
    const block = SOURCE.slice(Math.max(0, at - 200), at);
    expect(block).toContain("min-w-0");
    expect(block).toMatch(/basis-\d+/);
  });

  it("the badges stay shrink-0 — the fix is that the ROW wraps, not that the badge shrinks", () => {
    // A shrinking badge would wrap its own text to two lines and look broken;
    // the intended behaviour is the badge moving wholesale to the next line.
    expect(SOURCE).toContain("shrink-0 rounded-full");
  });
});
