// D9 (owner ruling 2026-09-18) — a saved value the select cannot OFFER must be
// shown, not swallowed.
//
// A picker never offers every value its sport's module will accept. Before
// this ruling the control rendered a `<select value="…">` whose option list
// has no such value, so the browser fell back to the first option and the
// organiser read "Default" — i.e. "this stage inherits the division" — over a
// stage that really was pinned.
//
// The case that found it was badminton `bestOf: 5` against a picker offering
// [1, 3] (the walkthrough division carries that override on its Finals
// stage). The owner widened badminton to [1, 3, 5] on 2026-09-20, so that
// value is now answered by the sport's OWN option and can no longer witness
// this branch. The live unofferable case here is 7 — declared by tabletennis
// and volleyball, by neither badminton nor tennis — and 9, which no sport
// declares at all.
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
import { SPORT_RULES, ruleOptionLabel } from "@/lib/match-rules";

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

describe("badminton's own best-of picker", () => {
  it("offers 5 as a REAL option (owner ruling 2026-09-20)", () => {
    // The widen. `{"bestOf": 5}` is real stored data — the walkthrough Finals
    // stage carries it — and the organiser read "Best of 5" on the summary
    // line above a dropdown that could only offer 1 and 3. The owner ruled the
    // PICKER wrong, not the data.
    //
    // Legal because the engine genuinely runs it: driving
    // `packages/engine`'s badminton module with `{bestOf: 5}` parses without
    // clamping, does NOT resolve the match at two games won (where bestOf 3
    // does), and awards at three games won over five games. Not inferred from
    // the schema — folded through `configSchema.parse` + `foldMatch`.
    expect(OFFERED).toContain("5");
    const html = render("badminton", { bestOf: "5" });
    expect(html).toContain('<option value="5" selected="">Best of 5</option>');
    // Its OWN option, not D9's synthetic twin: exactly one option carries it,
    // and it sits in declaration order rather than ahead of the list.
    expect((html.match(/value="5"/g) ?? []).length).toBe(1);
    expect(html.indexOf('value="3"')).toBeLessThan(html.indexOf('value="5"'));
  });
});

describe("a hydrated value the select cannot offer", () => {
  it("is genuinely unofferable — the premise, asserted rather than assumed", () => {
    // 7 is the successor case now that badminton offers 5: tabletennis and
    // volleyball declare it, badminton and tennis do not. If this ever goes
    // green by accident the whole describe below stops testing the borrow.
    expect(OFFERED).not.toContain("7");
  });

  it("renders as the SELECTED option instead of falling through to Default", () => {
    const html = render("badminton", { bestOf: "7" });
    // Selected, and labelled through `ruleOptionLabel` — the SAME lookup the
    // stage card's summary line uses. Found in the browser: the synthetic
    // option shipped as a bare number, so the open dropdown read
    // `Default · 5 · Best of 1 · Best of 3` directly under a summary line
    // saying "Best of 5". One value, two labels, one screen.
    const label = ruleOptionLabel("badminton", "bestOf", "7");
    expect(label).toBe("Best of 7");
    expect(html).toContain(`<option value="7" selected="">${label}</option>`);
    // …and NOT the bare value it used to render.
    expect(html).not.toContain('<option value="7" selected="">7</option>');
    // The whole point: "Default" is NOT what this field now shows.
    expect(html).not.toContain('<option value="" selected="">Default</option>');
  });

  it("still shows a value NO sport can label, rather than dropping the option", () => {
    // The fallback pair. 9 is in no picker anywhere, so there is no label to
    // borrow — the option must still exist and still be selected, labelled
    // with the raw value, or the control goes back to reading "Default" over
    // a live override.
    expect(ruleOptionLabel("badminton", "bestOf", "9")).toBeUndefined();
    const html = render("badminton", { bestOf: "9" });
    expect(html).toContain('<option value="9" selected="">9</option>');
    expect(html).not.toContain('<option value="" selected="">Default</option>');
  });

  it("re-emits that value unchanged through buildRuleOverride", () => {
    // The round trip, not just the markup: what was hydrated is what a save
    // would PUT, with no coercion and no drop.
    expect(buildRuleOverride("badminton", { bestOf: "7" })).toEqual({ bestOf: 7 });
  });

  it("survives a save that changes a DIFFERENT field", () => {
    // The stage-panel data-loss shape: the organiser opens the Finals stage to
    // change one thing, and the untouched override must still be in the
    // fragment that goes out. An omitted key here would mean INHERIT.
    const after = { bestOf: "7", setTo: "21" };
    expect(buildRuleOverride("badminton", after)).toEqual({ bestOf: 7, setTo: 21 });
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
