// D9 (owner ruling 2026-09-18) — a saved value the select cannot OFFER must be
// shown, not swallowed.
//
// Badminton's `bestOf` offers only [1, 3], but `{"bestOf": 5}` is a perfectly
// valid saved config (the module schema accepts it; the walkthrough division
// carries exactly that on its Finals stage). Before this ruling the control
// rendered a `<select value="5">` whose option list has no `5`, so the browser
// fell back to the first option and the organiser read "Default" — i.e. "this
// stage inherits the division" — over a stage that really was pinned to 5.
//
// That matters more for the stage panel than for the division editor, because
// the stage panel PUTs a FRAGMENT where an omitted key means INHERIT, so a
// control that misreports its own state is one tap away from clearing an
// override the organiser never chose to clear.
//
// Node env, no DOM: `renderToStaticMarkup` is the house pattern for asserting
// this panel family's markup (division-settings-entrants.test.tsx).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchRuleFields, buildRuleOverride } from "@/components/v2/match-rules";
import { SPORT_RULES } from "@/lib/match-rules";

function render(sportKey: string, values: Record<string, string>): string {
  return renderToStaticMarkup(
    <MatchRuleFields sportKey={sportKey} values={values} onChange={() => {}} />,
  );
}

/** The values badminton's own declaration offers for `bestOf` — derived, never
 *  typed in, so widening the option list moves this test with it. */
const OFFERED = (SPORT_RULES.badminton ?? [])
  .find((f) => f.key === "bestOf")!
  .options!.map((o) => o.value);

describe("a hydrated value the select cannot offer", () => {
  it("is genuinely unofferable — the premise, asserted rather than assumed", () => {
    expect(OFFERED).not.toContain("5");
  });

  it("renders as the SELECTED option instead of falling through to Default", () => {
    const html = render("badminton", { bestOf: "5" });
    // Selected, and labelled from the raw value — there is no declared label
    // for a value the table does not declare, and inventing one is a new lie.
    expect(html).toContain('<option value="5" selected="">5</option>');
    // The whole point: "Default" is NOT what this field now shows.
    expect(html).not.toContain('<option value="" selected="">Default</option>');
  });

  it("re-emits that value unchanged through buildRuleOverride", () => {
    // The round trip, not just the markup: what was hydrated is what a save
    // would PUT, with no coercion and no drop.
    expect(buildRuleOverride("badminton", { bestOf: "5" })).toEqual({ bestOf: 5 });
  });

  it("survives a save that changes a DIFFERENT field", () => {
    // The stage-panel data-loss shape: the organiser opens the Finals stage to
    // change one thing, and the untouched override must still be in the
    // fragment that goes out. An omitted key here would mean INHERIT.
    const after = { bestOf: "5", setTo: "21" };
    expect(buildRuleOverride("badminton", after)).toEqual({ bestOf: 5, setTo: 21 });
  });

  it("leaves an offerable value on its real option, adding no synthetic twin", () => {
    // The negative pair: the branch must not fire for a value the list offers,
    // or every field grows a duplicate option and the real label is shadowed.
    const html = render("badminton", { bestOf: "3" });
    expect(html).toContain('<option value="3" selected="">Best of 3</option>');
    // Exactly one option carries this value — no synthetic twin shadowing the
    // real label.
    expect((html.match(/value="3"/g) ?? []).length).toBe(1);
  });

  it("adds nothing at all when the field is blank", () => {
    // Blank means inherit; a synthetic option here would invent a value.
    const html = render("badminton", {});
    expect(html).toContain('<option value="" selected="">Default</option>');
    const bestOfBlock = html.slice(0, html.indexOf("</select>"));
    expect((bestOfBlock.match(/<option/g) ?? []).length).toBe(OFFERED.length + 1);
  });
});
