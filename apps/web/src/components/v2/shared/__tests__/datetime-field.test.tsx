// Prompt 01 of the date/time UX programme: the shared `DateTimeField` that
// Prompts 02/03/04/06 convert six ad-hoc native inputs onto. These pin the
// three `kind` variants, the shared `.input` styling copied from the division
// wizard, the mobile font rule, and the `onChange`/`min` wiring the call sites
// depend on.
//
// The plan's draft used `@testing-library/react` + `screen.getByLabelText`.
// apps/web is vitest `environment: "node"` with no jsdom and no
// @testing-library in node_modules, so that suite cannot collect, let alone
// pass. The repo's convention is `renderToStaticMarkup` for output plus the
// element tree for handlers; `DateTimeField` is deliberately hookless, so it
// can be called directly and walked. The label assertion below is what makes
// `getByLabelText` (and Playwright's `getByLabel`) resolve in a real browser:
// the input is a descendant of its `<label>`, which is implicit association.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, walk } from "../../../__tests__/_hook-harness";
import { DateTimeField, type DateTimeFieldProps } from "../datetime-field";

const inputOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "input");
  if (!el) throw new Error("DateTimeField rendered no <input>");
  return propsOf(el);
};

const classesOf = (props: DateTimeFieldProps) => String(inputOf(props).className ?? "").split(/\s+/);

/** The label `<span>`. Throwing when it is absent is deliberate — it is this
 *  component's entire accessible name, so "no span" is never a valid render. */
const labelSpanOf = (props: DateTimeFieldProps) => {
  const el = walk(DateTimeField(props)).find((e) => e.type === "span");
  if (!el) throw new Error("DateTimeField rendered no label <span>");
  return propsOf(el);
};

describe("DateTimeField", () => {
  it("renders a native input of the requested kind with the shared input class, labelled by its wrapping label", () => {
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
    // The other two kinds are the same control, not a different branch.
    expect(inputOf({ ...props, kind: "time" }).type).toBe("time");
    expect(inputOf({ ...props, kind: "datetime-local" }).type).toBe("datetime-local");
  });

  it("stays 16px at every width — text-base, and no sm: override that shrinks it", () => {
    // iOS zoom-on-focus is already blocked repo-wide by globals.css Pattern 5
    // (`@media (max-width:39.99rem){input,select,textarea{font-size:16px}}`),
    // so the plan's `sm:text-sm` changed nothing at 375px and only shrank the
    // control to 14px/38px on desktop, beside `.input` siblings at 16px/42px.
    // This field must be indistinguishable from a hand-rolled `.input`.
    const classes = classesOf({
      kind: "time",
      value: "09:00",
      onChange: () => {},
      label: "Start time",
    });
    expect(classes).toContain("text-base");
    expect(classes).not.toContain("sm:text-sm");
  });

  it("calls onChange with the raw input value", () => {
    const onChange = vi.fn();
    const handler = inputOf({
      kind: "datetime-local",
      value: "",
      onChange,
      label: "Kickoff",
    }).onChange as (e: { target: { value: string } }) => void;
    handler({ target: { value: "2026-08-07T09:00" } });
    // Raw, unparsed and unnormalised: every call site stores the wire string.
    expect(onChange).toHaveBeenCalledWith("2026-08-07T09:00");
  });

  it("applies min when provided, and omits it otherwise", () => {
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

  it("required marks the field for assistive tech and NEVER emits the native attribute", () => {
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
    expect(hidden).toMatch(/^<label[^>]*>.*Play from.*<input[^>]*type="time"[^>]*\/?>.*<\/label>$/s);

    // Optional and additive: visible by default, so the call sites that do not
    // pass it are unchanged.
    expect(String(labelSpanOf(base).className).split(/\s+/)).toEqual(["label"]);
    expect(renderToStaticMarkup(<DateTimeField {...base} />)).not.toContain("sr-only");
  });
});
