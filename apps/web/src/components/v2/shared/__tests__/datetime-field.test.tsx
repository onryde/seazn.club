// Prompt 01 of the date/time UX programme: the shared `DateTimeField` that
// Prompts 02/03/04/06 convert six ad-hoc native inputs onto. These pin the
// three `kind` variants, the shared `.input` styling copied from the division
// wizard, the mobile font rule, and the `onChange`/`min` wiring the call sites
// depend on.
//
// Rewritten for the quarter-hour picker
// (docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md):
// Chrome's picker POPUP ignores `step` even though its validity engine
// honours it, so `kind="time"` is now a native `<select>` built from
// `timeOptions()` (time-options.ts owns every rule) and `kind="datetime-local"`
// delegates to `DateTimeSplitField` instead of rendering a clock input
// directly. `kind="date"` is untouched — Chrome's calendar popup was already
// correct.
//
// apps/web is vitest `environment: "node"` with no jsdom and no
// @testing-library in node_modules. The repo's convention is
// `renderToStaticMarkup` for output plus the element tree for handlers;
// `DateTimeField` is deliberately hookless, so it can be called directly and
// walked. `kind="datetime-local"` is the one exception: DateTimeField hands
// off to `DateTimeSplitField` (which owns state, via `useState`) by RETURNING
// an element for it, never calling it — so a direct `DateTimeField(props)`
// call sees only that unexpanded element. Tests below assert what
// DateTimeField itself decided (which component, which props forwarded);
// DateTimeSplitField's own suite is what expands past that, via
// `renderToStaticMarkup`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, walk } from "../../../__tests__/_hook-harness";
import { DateTimeField, TIME_STEP_SECONDS, type DateTimeFieldProps } from "../datetime-field";
import { DateTimeSplitField } from "../datetime-split-field";
import { quarterHours, timeOptions } from "../time-options";

const inputOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "input");
  if (!el) throw new Error("DateTimeField rendered no <input>");
  return propsOf(el);
};

const selectOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "select");
  if (!el) throw new Error("DateTimeField rendered no <select>");
  return propsOf(el);
};

/** Every `<option>` VALUE the select renders, including the leading `""`
 *  ("--:--") clearing placeholder — callers that only care about the offered
 *  times filter that out themselves, so the placeholder's presence and
 *  position stay a visible, deliberate assertion rather than silently
 *  dropped by the helper. */
const optionValuesOf = (props: DateTimeFieldProps): string[] =>
  walk(DateTimeField(props))
    .filter((e) => e.type === "option")
    .map((e) => String(propsOf(e).value ?? ""));

const classesOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "input" || e.type === "select");
  if (!el) throw new Error("DateTimeField rendered no <input> or <select>");
  return String(propsOf(el).className ?? "").split(/\s+/);
};

/** The label `<span>`. Throwing when it is absent is deliberate — it is this
 *  component's entire accessible name, so "no span" is never a valid render. */
const labelSpanOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "span");
  if (!el) throw new Error("DateTimeField rendered no label <span>");
  return propsOf(el);
};

/** For `kind="datetime-local"` only: the unexpanded `<DateTimeSplitField>`
 *  element DateTimeField returns instead of a clock input. */
const splitFieldPropsOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === DateTimeSplitField);
  if (!el) throw new Error("DateTimeField rendered no <DateTimeSplitField>");
  return propsOf(el);
};

describe("DateTimeField", () => {
  it('kind="date" renders a native input, labelled by its wrapping label — unchanged by this rewrite', () => {
    const props: DateTimeFieldProps = {
      kind: "date",
      value: "2026-08-07",
      onChange: () => {},
      label: "Start date",
    };
    expect(inputOf(props).type).toBe("date");
    expect(classesOf(props)).toContain("input");
    // Implicit label association: <label> wraps both the text and the control,
    // matching the division wizard. Without this the field has no accessible
    // name at all, since the component takes no id.
    const html = renderToStaticMarkup(<DateTimeField {...props} />);
    expect(html).toMatch(/^<label[^>]*>.*Start date.*<input[^>]*type="date"[^>]*\/?>.*<\/label>$/s);
  });

  it('kind="time" renders a native <select>, not an <input> — the whole point of this rewrite', () => {
    const props: DateTimeFieldProps = {
      kind: "time",
      value: "09:00",
      onChange: () => {},
      label: "Start time",
    };
    const select = selectOf(props);
    expect(select.value).toBe("09:00");
    expect(String(select.className).split(/\s+/)).toContain("input");
    expect(walk(DateTimeField(props)).some((e) => e.type === "input")).toBe(false);
    const html = renderToStaticMarkup(<DateTimeField {...props} />);
    expect(html).toMatch(/^<label[^>]*>.*Start time.*<select[^>]*>.*<\/select>.*<\/label>$/s);
  });

  it('kind="datetime-local" delegates to DateTimeSplitField, forwarding every prop verbatim', () => {
    const onChange = vi.fn();
    const props: DateTimeFieldProps = {
      kind: "datetime-local",
      value: "2026-08-07T09:00",
      onChange,
      label: "Kickoff",
      min: "2026-08-01T00:00",
      max: "2026-08-20",
      disabled: false,
      required: true,
      labelHidden: true,
      step: 300,
      options: ["09:00", "09:30"],
      extraOptions: ["23:59"],
    };
    const forwarded = splitFieldPropsOf(props);
    expect(forwarded.value).toBe(props.value);
    expect(forwarded.onChange).toBe(onChange);
    expect(forwarded.label).toBe("Kickoff");
    expect(forwarded.min).toBe(props.min);
    expect(forwarded.max).toBe(props.max);
    expect(forwarded.required).toBe(true);
    expect(forwarded.labelHidden).toBe(true);
    expect(forwarded.step).toBe(300);
    expect(forwarded.options).toEqual(["09:00", "09:30"]);
    expect(forwarded.extraOptions).toEqual(["23:59"]);
    // Hands off entirely — nothing else renders alongside it at this level.
    expect(walk(DateTimeField(props))).toHaveLength(1);
  });

  it("stays 16px at every width — text-base, and no sm: override that shrinks it", () => {
    // iOS zoom-on-focus is already blocked repo-wide by globals.css Pattern 5
    // (`@media (max-width:39.99rem){input,select,textarea{font-size:16px}}`),
    // so the plan's `sm:text-sm` changed nothing at 375px and only shrank the
    // control to 14px/38px on desktop, beside `.input` siblings at 16px/42px.
    // This field must be indistinguishable from a hand-rolled `.input` —
    // true of the <select> now, same as the <input> before it.
    const classes = classesOf({
      kind: "time",
      value: "09:00",
      onChange: () => {},
      label: "Start time",
    });
    expect(classes).toContain("text-base");
    expect(classes).not.toContain("sm:text-sm");
  });

  it("calls onChange with the raw select value", () => {
    const onChange = vi.fn();
    const handler = selectOf({
      kind: "time",
      value: "",
      onChange,
      label: "Kickoff",
    }).onChange as (e: { target: { value: string } }) => void;
    handler({ target: { value: "09:15" } });
    // Raw, unparsed and unnormalised: every call site stores the wire string.
    expect(onChange).toHaveBeenCalledWith("09:15");
  });

  it("applies min when provided, and omits it otherwise (kind=\"date\")", () => {
    const base: DateTimeFieldProps = {
      kind: "date",
      value: "",
      onChange: () => {},
      label: "End date",
    };
    expect(inputOf({ ...base, min: "2026-08-07" }).min).toBe("2026-08-07");
    // An always-present `min=""` would make every date unselectable in some
    // browsers, so absence has to stay absence.
    expect(inputOf(base).min).toBeUndefined();
    expect(renderToStaticMarkup(<DateTimeField {...base} />)).not.toContain("min=");
    // Same for `disabled`, which the wizard toggles per step.
    expect(inputOf({ ...base, disabled: true }).disabled).toBe(true);
  });

  it("applies max when provided, and omits it otherwise (kind=\"date\")", () => {
    // The upper bound the competition window needs: a division's schedule may
    // not run past the competition's last day (the server already 422s that —
    // `boundsError` in schedule-settings), so the picker has to say so before
    // the save, not after. Absence stays absence for the same reason `min`'s
    // does: `max=""` would make every date unselectable in some browsers.
    const base: DateTimeFieldProps = {
      kind: "date",
      value: "",
      onChange: () => {},
      label: "End date",
    };
    expect(inputOf({ ...base, max: "2026-08-20" }).max).toBe("2026-08-20");
    expect(inputOf(base).max).toBeUndefined();
    expect(renderToStaticMarkup(<DateTimeField {...base} />)).not.toContain("max=");
    // Both bounds together — the whole point is a closed window.
    const bounded = inputOf({ ...base, min: "2026-08-07", max: "2026-08-20" });
    expect([bounded.min, bounded.max]).toEqual(["2026-08-07", "2026-08-20"]);
  });

  it('min filters the offered list on kind="time", via timeOptions\' minTime', () => {
    // Same rule as time-options.ts `filterByMin`, exercised through the
    // component's own wiring rather than the pure function directly: `min`
    // on a plain (non-split) time field is already a same-day HH:MM floor —
    // there is no date half to compare against.
    const props: DateTimeFieldProps = {
      kind: "time",
      value: "",
      onChange: () => {},
      label: "Ends",
      options: ["09:00", "09:15", "09:30"],
      min: "09:15",
    };
    expect(optionValuesOf(props).filter((v) => v !== "")).toEqual(["09:15", "09:30"]);
  });

  it("required marks the field for assistive tech and NEVER emits the native attribute (kind=\"date\")", () => {
    const base: DateTimeFieldProps = {
      kind: "date",
      value: "",
      onChange: () => {},
      label: "End date",
    };
    const props = inputOf({ ...base, required: true });
    expect(props["aria-required"]).toBe("true");
    // #376 is the whole point of this prop, and this is the half that guards
    // it: the NATIVE `required` attribute fires the browser's own English
    // validation tooltip, which preempts the localized message the form shows
    // instead. A caller asking for `required` must get the a11y signal without
    // the tooltip, by construction — never by remembering to avoid it.
    expect(props.required).toBeUndefined();
    const html = renderToStaticMarkup(<DateTimeField {...base} required />);
    expect(html).toContain('aria-required="true"');
    expect(html).not.toMatch(/\srequired[=\s/>]/);

    // Optional and additive: absent by default, so the converted call sites
    // that do not pass it are unchanged.
    expect(inputOf(base)["aria-required"]).toBeUndefined();
    expect(renderToStaticMarkup(<DateTimeField {...base} />)).not.toContain("required");
  });

  it('required/disabled reach the SELECT the same way, for kind="time"', () => {
    const base: DateTimeFieldProps = {
      kind: "time",
      value: "",
      onChange: () => {},
      label: "Play from",
    };
    expect(selectOf({ ...base, required: true })["aria-required"]).toBe("true");
    expect(selectOf({ ...base, required: true }).required).toBeUndefined();
    expect(selectOf({ ...base, disabled: true }).disabled).toBe(true);
    const html = renderToStaticMarkup(<DateTimeField {...base} required />);
    expect(html).toContain('aria-required="true"');
    expect(html).not.toMatch(/\srequired[=\s/>]/);
  });

  it("labelHidden hides the label VISUALLY and never drops it", () => {
    const base: DateTimeFieldProps = {
      kind: "time",
      value: "",
      onChange: () => {},
      label: "Play from",
    };

    // The load-bearing half. `sr-only` is a visual utility, not a removal: the
    // element still renders and still carries the text, because it is the only
    // thing naming this control (no `id`, so association is implicit via the
    // wrapping <label>). An implementation that omitted the span entirely would
    // satisfy a naive "no visible label" check while leaving the input unnamed
    // — `labelSpanOf` throws instead.
    const hiddenSpan = labelSpanOf({ ...base, labelHidden: true });
    expect(String(hiddenSpan.className).split(/\s+/)).toEqual(["label", "sr-only"]);
    expect(hiddenSpan.children).toBe("Play from");
    const hidden = renderToStaticMarkup(<DateTimeField {...base} labelHidden />);
    expect(hidden).toContain("Play from");
    // Still WRAPS the control, so implicit association (and Playwright's
    // getByLabel) keeps working — the reason this beats a bare `aria-label`.
    expect(hidden).toMatch(/^<label[^>]*>.*Play from.*<select[^>]*>.*<\/select>.*<\/label>$/s);

    // Optional and additive: visible by default, so the call sites that do not
    // pass it are unchanged.
    expect(String(labelSpanOf(base).className).split(/\s+/)).toEqual(["label"]);
    expect(renderToStaticMarkup(<DateTimeField {...base} />)).not.toContain("sr-only");
  });

  it('selectAriaLabel overrides the select\'s accessible name — DateTimeSplitField\'s own escape hatch', () => {
    const props: DateTimeFieldProps = {
      kind: "time",
      value: "",
      onChange: () => {},
      label: "Kickoff",
      labelHidden: true,
      selectAriaLabel: "Time",
    };
    expect(selectOf(props)["aria-label"]).toBe("Time");
    expect(renderToStaticMarkup(<DateTimeField {...props} />)).toContain('aria-label="Time"');
    // Absent by default — a bare kind="time" field already has a real,
    // distinct label via `label` and does not need this.
    expect(selectOf({ ...props, selectAriaLabel: undefined })["aria-label"]).toBeUndefined();
  });

  it('prepends a "--:--" clearing placeholder, and always includes an off-grid current value', () => {
    // Two rules from time-options.ts `timeOptions`, proven through the
    // rendered <option> list rather than the pure function directly: the
    // value is ALWAYS present (a <select> whose value matches no <option>
    // renders blank and saves empty — the silent-data-loss path the design
    // doc calls out), and the leading blank option is how the split field's
    // half-filled pair clears its time half back to "".
    const props: DateTimeFieldProps = {
      kind: "time",
      value: "09:40",
      onChange: () => {},
      label: "Kickoff",
      options: ["09:00", "10:20"],
    };
    const values = optionValuesOf(props);
    expect(values[0]).toBe("");
    expect(values).toContain("09:40");
    const placeholder = walk(DateTimeField(props)).find(
      (e) => e.type === "option" && propsOf(e).value === "",
    )!;
    expect(propsOf(placeholder).children).toBe("--:--");
  });

  it("offers the 96-entry quarter-hour list by default, and NEVER emits a DOM step attribute", () => {
    expect(TIME_STEP_SECONDS).toBe(900);
    const onChange = () => {};

    // Default: exactly what `quarterHours()` produces — DateTimeField forwards
    // `step` straight through as `timeOptions`' `stepSeconds` and lets
    // time-options.ts own the default, rather than re-deriving it here.
    const time: DateTimeFieldProps = { kind: "time", value: "", onChange, label: "When" };
    expect(optionValuesOf(time).filter((v) => v !== "")).toEqual(quarterHours());
    // `step` used to become a DOM attribute Chrome's picker POPUP ignored
    // anyway (the whole reason this component now owns the option list) — it
    // must never appear in rendered markup at all.
    expect(renderToStaticMarkup(<DateTimeField {...time} />)).not.toContain("step=");

    // datetime-local forwards `step` on to the split field's internal time
    // select — proven through full markup, since DateTimeField itself only
    // hands the prop off unexpanded (see the delegation test above).
    const dtLocal: DateTimeFieldProps = { kind: "datetime-local", value: "", onChange, label: "When" };
    const dtHtml = renderToStaticMarkup(<DateTimeField {...dtLocal} />);
    expect(dtHtml).not.toContain("step=");
    expect(dtHtml).toContain('value="00:00"');
    expect(dtHtml).toContain('value="23:45"');

    // THE regression this suite exists to keep pinned. `step` on
    // `<input type="date">` counts DAYS, so the obvious one-line
    // implementation — stepping every kind the same way — makes the end-date
    // fields in settings-panel and division-builder offer one selectable date
    // every 900 days and reject everything between.
    const date: DateTimeFieldProps = { kind: "date", value: "", onChange, label: "End date" };
    expect(inputOf(date).step).toBeUndefined();
    expect(renderToStaticMarkup(<DateTimeField {...date} />)).not.toContain("step=");

    // A caller-supplied step changes the OPTION LIST, not a DOM attribute — a
    // 5-minute step produces far more than 96 entries, still with no step=
    // attribute anywhere, and matches timeOptions' own output exactly.
    const fineStep: DateTimeFieldProps = { kind: "time", value: "", onChange, label: "When", step: 300 };
    const fineOpts = optionValuesOf(fineStep).filter((v) => v !== "");
    expect(fineOpts).toEqual(timeOptions({ value: "", stepSeconds: 300 }));
    expect(fineOpts.length).toBeGreaterThan(quarterHours().length);
    expect(renderToStaticMarkup(<DateTimeField {...fineStep} />)).not.toContain("step=");
  });
});
