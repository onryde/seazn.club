// The phone stepper's dot strip is decoration that only fits short packs:
// at 14px a dot the 35-puzzle Mate in 1 arcade pack would need 490px of a
// 320px screen. Past STEPPER_DOTS_MAX the strip is omitted and the "n of N"
// text carries the position alone. Pinned here because vitest has no DOM to
// measure overflow with — the cap is the guard.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PuzzleDots, STEPPER_DOTS_MAX } from "../PuzzleDots";

function render(count: number) {
  return renderToStaticMarkup(
    <PuzzleDots count={count} current={0} isSolved={() => false} onPick={() => {}} />,
  );
}

describe("PuzzleDots phone stepper dot strip", () => {
  it("renders one dot per puzzle for a pack at the cap", () => {
    const html = render(STEPPER_DOTS_MAX);
    const strip = html.match(/data-cq="puzzle-stepper-dots"[\s\S]*?<\/span>\s*<button/);
    expect(strip).not.toBeNull();
    expect((strip![0].match(/rounded-full/g) ?? []).length).toBe(STEPPER_DOTS_MAX);
    expect(html).toMatch(/1 of \d+/);
  });
  it("omits the strip entirely one past the cap, keeping the n-of-N text", () => {
    const html = render(STEPPER_DOTS_MAX + 1);
    expect(html).not.toContain('data-cq="puzzle-stepper-dots"');
    expect(html).toContain(`1 of ${STEPPER_DOTS_MAX + 1}`);
  });
  it("omits the strip for the 35-puzzle arcade pack", () => {
    const html = render(35);
    expect(html).not.toContain('data-cq="puzzle-stepper-dots"');
    expect(html).toContain("1 of 35");
  });
});
