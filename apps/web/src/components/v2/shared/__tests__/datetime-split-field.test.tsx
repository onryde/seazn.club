// `kind="datetime-local"` now delegates here (see
// docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md). This
// is the ONE stateful piece of the date/time UX — it owns the half-filled
// pair via `useState`, because `joinValue` emits `""` for a half-filled pair
// and a controlled value re-derived from that on every render would wipe the
// half the user just picked (see the component's own file doc). Unlike
// `DateTimeField` it cannot be called as a plain function — `useState`
// outside React throws "Invalid hook call" (see `_hook-harness.tsx`) — so
// this suite mounts it for real with `renderToStaticMarkup`.
//
// That proves everything decided at MOUNT time: how the incoming value
// splits across the two halves, which props reach which half, the same-day
// `min` comparison, and the layout's stacking breakpoint. Driving a click
// through the internal `useState` and back out through `onChange` is proven
// by e2e instead — the design doc makes that trade explicitly ("Interaction
// is proven by e2e, which is where it is provable anyway"), the same reason
// `time-options.ts` (not this component) carries the heavy unit coverage.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DateTimeSplitField, type DateTimeSplitFieldProps } from "../datetime-split-field";
import { quarterHours } from "../time-options";

const baseProps: DateTimeSplitFieldProps = {
  value: "",
  onChange: () => {},
  label: "Kickoff",
};

describe("DateTimeSplitField", () => {
  it("splits a full value into a date input and a time select, both carrying it", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} value="2026-08-07T09:30" />);
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-08-07"');
    expect(html).toContain("<select");
    // A controlled <select>'s value shows up as `selected` on the matching
    // <option>, not as a `value=` attribute on the <select> itself.
    expect(html).toMatch(/<option value="09:30"[^>]*selected[^>]*>09:30<\/option>/);
  });

  it("splits a blank value into two blank halves — no date value, \"--:--\" selected", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} value="" />);
    expect(html).not.toMatch(/type="date"[^>]*value="\d/);
    expect(html).toMatch(/<option value=""[^>]*selected[^>]*>--:--<\/option>/);
  });

  it("shows the caller's label on the date half, visibly by default, exactly once", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} label="Start date and time" />);
    expect(html).toContain("Start date and time");
    const visibleLabelSpans = html.match(/<span class="label">/g) ?? [];
    expect(visibleLabelSpans).toHaveLength(1);
  });

  it("gives the time select its OWN distinct accessible name, not a repeat of the composite label", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} label="Start date and time" />);
    // English fallback: useMsg() falls back to the shipped en/ui.json catalog
    // outside a <DictProvider> (dict-provider.tsx), so this is the real
    // shipped string ("datetime.timeLabel"), not a mock.
    expect(html).toContain('aria-label="Time"');
    expect(html).not.toContain('aria-label="Start date and time"');
  });

  it("labelHidden hides the (date-half) label visually without dropping it", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} labelHidden />);
    expect(html).toContain('class="label sr-only"');
    expect(html).toContain("Kickoff");
  });

  it("forwards options/extraOptions to the time half's generated list, overriding the default grid", () => {
    const html = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} options={["09:00", "10:20"]} extraOptions={["23:59"]} />,
    );
    expect(html).toContain('value="09:00"');
    expect(html).toContain('value="10:20"');
    expect(html).toContain('value="23:59"');
    // Not the default quarter-hour grid once explicit `options` are given.
    expect(html).not.toContain('value="00:15"');
  });

  it("defaults to the quarter-hour grid when no explicit options are given", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} />);
    for (const t of quarterHours()) {
      expect(html).toContain(`value="${t}"`);
    }
  });

  it("forwards disabled and required to BOTH halves, never as the native required attribute", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} disabled required />);
    const disabledCount = (html.match(/\sdisabled(?:=""|(?=[\s/>]))/g) ?? []).length;
    expect(disabledCount).toBe(2);
    const requiredAriaCount = (html.match(/aria-required="true"/g) ?? []).length;
    expect(requiredAriaCount).toBe(2);
    // Never the native `required` attribute — same #376 policy DateTimeField
    // itself enforces, forwarded through unchanged for both halves.
    expect(html).not.toMatch(/\srequired(?:=""|(?=[\s/>]))/);
  });

  it("passes min's date half to the date input on every day, but the time floor only on a MATCHING day", () => {
    // Same day as the current value: filtered from min's time-of-day onward —
    // the blackout `to >= from` use case.
    const sameDay = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} value="2026-08-07T09:30" min="2026-08-07T09:15" />,
    );
    expect(sameDay).toContain('min="2026-08-07"');
    expect(sameDay).not.toContain('value="09:00"'); // below the 09:15 floor, filtered out

    // A different (later) day: the date half still gets `min` (so an earlier
    // date can't be picked back), but the time list is NOT filtered — a later
    // day already satisfies "at or after min" on its own.
    const laterDay = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} value="2026-08-08T00:15" min="2026-08-07T09:15" />,
    );
    expect(laterDay).toContain('min="2026-08-07"');
    expect(laterDay).toContain('value="00:15"'); // would be filtered on the SAME day, not this one
  });

  it("passes max's date half to the date input, and never constrains the time list with it", () => {
    // The competition window's upper bound. Only the DATE half carries it: a
    // time ceiling on the last day would be a different rule from the one the
    // server enforces (the 422 compares whole days — `starts_on`/`ends_on` are
    // dates), and time-options.ts has no `maxTime` filter to lean on. A bare
    // "YYYY-MM-DD" max splits to `{date, time: ""}`, same as `min` does.
    const html = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} value="2026-08-07T09:30" max="2026-08-20" />,
    );
    expect(html).toContain('max="2026-08-20"');
    // The time <select> is untouched — no `max` reaches it, and its options
    // are the full list.
    expect(html).toContain('value="23:45"');
    expect((html.match(/max="2026-08-20"/g) ?? []).length).toBe(1);
  });

  it("the current time value is always offered even when min would otherwise filter it out", () => {
    const html = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} value="2026-08-07T09:00" min="2026-08-07T09:15" />,
    );
    // 09:00 is both the CURRENT value and below the 09:15 floor —
    // time-options.ts injects the value outranking the filter, so a <select>
    // whose value matches no <option> (blank, silent data loss on save) never
    // happens here.
    expect(html).toMatch(/<option value="09:00"[^>]*selected[^>]*>09:00<\/option>/);
  });

  // THE REGRESSION THIS PINS. The stacking rule used to be a VIEWPORT media
  // query, which asks the wrong question: whether a date input and a time
  // select fit side by side depends on this field's own width, not the
  // window's. The registrations sidebar is pinned to 340px at `lg`, so at a
  // 1280px viewport the old rule read "plenty of room" and squeezed the two
  // halves to 82px and 55px — clipped to "dd/r" and a bare chevron. A
  // container query asks the right one.
  it("stacks on its OWN width via a container query, never the viewport's", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} />);
    expect(html).toContain("@container");
    expect(html).toContain("flex-col");
    expect(html).toContain("@[18rem]:flex-row");
    // A viewport media query here is the bug, not an alternative spelling.
    expect(html).not.toContain("@media(min-width:");
  });

  // THE SECOND HALF OF THAT SAME REGRESSION, paid for on 2026-09-04.
  //
  // `@container` compiles to `container-type: inline-size`, which applies
  // inline-size CONTAINMENT — the box's own contents stop contributing to its
  // inline size. So anywhere this element is sized FROM its content (a flex
  // item, whose flex-basis `auto` resolves to max-content; a grid item that is
  // not stretched) its width resolves to ZERO and both halves collapse to the
  // browser's ~26px minimum. Measured live at 320/390/768/1280 on the run
  // sheet's inline "Set time" editor and on `stages-panel.tsx`'s "Add match"
  // form: container 0px, date 26px, select 26px, and the select's own centre
  // hit-testing to the Save BUTTON beside it. Two of the six call sites were
  // broken; a third (`move-panel.tsx`) had been carrying a `w-80 max-w-full`
  // wrapper for exactly this reason without ever naming it.
  //
  // This is a class-scan, and a class-scan cannot see a cascade — the real
  // proof is the measured box in `e2e/run-sheet.spec.ts` ("the inline
  // Set-time field is a usable, tappable control at 320 and at 1280"). It is
  // here so the one-token deletion that reintroduces a zero-width date field
  // fails in the fast suite too, next to the reason.
  it("gives the container-query box an EXTRINSIC width — it cannot size itself from content", () => {
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} />);
    expect(html).toMatch(/class="[^"]*@container[^"]*w-full/);
  });
  // A form that routes save errors and e2e locators by field name loses its
  // handle the moment a raw <input> becomes this pair — RS004's registration
  // hub was addressing `[data-field="opens_at"]` before the time-step sweep
  // sent it through here. `dataField` restores it, SUFFIXED: a bare
  // `opens_at` on either half would be a locator addressing half a value.
  it("suffixes `dataField` across the two halves, and puts it on neither bare", () => {
    const html = renderToStaticMarkup(
      <DateTimeSplitField {...baseProps} dataField="opens_at" />,
    );
    expect(html).toMatch(/<input[^>]*data-field="opens_at_date"/);
    expect(html).toMatch(/<select[^>]*data-field="opens_at_time"/);
    expect(html).not.toContain('data-field="opens_at"');
  });

  it("emits no data-field attribute at all when the caller passes none", () => {
    // The 14 call sites that predate `dataField` must not start carrying an
    // empty or "undefined" hook — a locator would then match all of them.
    const html = renderToStaticMarkup(<DateTimeSplitField {...baseProps} />);
    expect(html).not.toContain("data-field");
  });
});
