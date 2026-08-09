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
});
