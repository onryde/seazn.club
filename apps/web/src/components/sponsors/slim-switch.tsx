// The Sponsors hub's slim switch (the On stream tab's, fix 79151e2029; the Packages tab's "Show retired" reuses it).
//
// The button is only the 44px tap target (h-11 w-14) and paints nothing; the slim switch - a 24 x 44 track and a 20px knob - is drawn inside
// it. The track used to BE the button (44px tall), which read as a fat pill.
//
// A plain FUNCTION the caller invokes (`{slimSwitch({ ... })}`), not a component: the island tests walk the element tree one level deep
// (`components/__tests__/_hook-harness.tsx`), and a child component here would hide the switch's `onClick` and `aria-checked` from them.
// The three test ids derive from `testId`: the button, `<testId>-track` and `<testId>-knob`.
import type { ReactElement } from "react";

export interface SlimSwitchProps {
  checked: boolean;
  onToggle: () => void;
  /** The id of the element that names the switch (a switch names what it controls; `aria-checked` says where it is). */
  labelledBy: string;
  testId: string;
  /** An id on the button, for a `<label htmlFor>` that should toggle it. Omitted: no id attribute. */
  id?: string;
  disabled?: boolean;
}

export function slimSwitch({ checked, onToggle, labelledBy, testId, id, disabled }: SlimSwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-labelledby={labelledBy}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className="inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        data-testid={`${testId}-track`}
        className={`relative block h-6 w-11 rounded-full transition-colors motion-reduce:transition-none ${checked ? "bg-purple-600" : "bg-slate-300"}`}
      >
        <span
          data-testid={`${testId}-knob`}
          className={`absolute left-0.5 top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${checked ? "translate-x-5" : "translate-x-0"}`}
        />
      </span>
    </button>
  );
}
