// Every clock control in the app goes through the shared `DateTimeField`.
//
// This suite used to assert the opposite: that every hand-rolled
// `<input type="time"|"datetime-local">` carried `step="900"`. That premise
// is dead — docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md
// found `step` alone never bounded what a click could pick. Chrome's picker
// *popup* ignores it even though its validity engine honours it (measured,
// Chrome 151): the dropdown renders a full 0-59 minute column regardless, so
// quarter-hour granularity existed for the keyboard and not the mouse. The
// fix owns the option list instead — `DateTimeField` (`kind="time"`) renders
// a native `<select>`, and `kind="datetime-local"` composes a date `<input>`
// with that same select (`DateTimeSplitField`) — so a raw clock `<input>`
// should never exist anywhere in the tree again.
//
// Rewritten, not patched (per the design doc), to protect the invariant this
// always existed for: a later edit adding a ninth hand-rolled clock control
// without noticing. A per-component render test cannot see that; it only
// knows about the inputs someone remembered to write a test for. So this
// scans the source instead, over the whole tree.
//
// Deliberately a SOURCE scan, not a rendered-DOM one: most call sites live in
// components that call hooks, and apps/web has no jsdom (vitest
// `environment: "node"`), so there is no way to mount them.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../../..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // `.next` holds a build-time COPY of this tree; scanning it double-counts
    // every hit and reports stale sources as live ones.
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...tsxFiles(full));
      continue;
    }
    if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/**
 * Comments out. `settings-panel.tsx` and `constraints-panel.tsx` both discuss
 * `<input type="datetime-local">` in prose, and a scan that reads those as
 * markup reports two permanent offenders no edit can ever clear — a failing
 * invariant nobody can satisfy is worse than no invariant.
 *
 * Whole-line `//` only, never a trailing one: `//` also appears inside string
 * literals (`https://…`), and cutting there would truncate real code.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Each `<input …>` element in `src`, as its raw text. Self-closing only,
 *  which every input in this codebase is — a `<input>` opened and closed
 *  separately would not be valid JSX. */
function inputElements(src: string): string[] {
  const out: string[] = [];
  const code = stripComments(src);
  for (let i = code.indexOf("<input"); i !== -1; i = code.indexOf("<input", i + 1)) {
    const end = code.indexOf("/>", i);
    if (end === -1) continue;
    out.push(code.slice(i, end + 2));
  }
  return out;
}

/** A hand-rolled clock input: a literal `type="time"` or
 *  `type="datetime-local"`. Literal on purpose — `DateTimeField`'s own
 *  surviving `<input>` (the `kind="date"` branch) writes `type={kind}`, a JSX
 *  expression, never these literal strings, so this can never flag the
 *  component that owns the policy. */
const isHandRolledClock = (el: string): boolean =>
  el.includes('type="time"') || el.includes('type="datetime-local"');

describe("every clock control goes through DateTimeField", () => {
  const files = tsxFiles(SRC);

  // Vacuity guard: a scanner that silently matches nothing passes every
  // assertion below.
  it("the scan actually reaches the component tree", () => {
    expect(files.length).toBeGreaterThan(200);
    const inputs = files.flatMap((f) => inputElements(fs.readFileSync(f, "utf8")));
    expect(inputs.length).toBeGreaterThan(40);
  });

  // A second vacuity guard, independent of real source: proves the detector
  // itself still flags a hand-rolled clock input rather than the zero result
  // below being a broken matcher rather than a clean tree.
  it("the detector still recognises a hand-rolled clock input", () => {
    const fixture = `
      export function Bad() {
        return (
          <label>
            <input type="date" className="input" />
            <input type="time" step={900} />
            <input type="datetime-local" />
          </label>
        );
      }
    `;
    const offenders = inputElements(fixture).filter(isHandRolledClock);
    expect(offenders).toHaveLength(2);
  });

  it("no hand-rolled <input type=\"time\"> or <input type=\"datetime-local\"> anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const el of inputElements(src)) {
        if (isHandRolledClock(el)) {
          offenders.push(`${path.relative(SRC, file)}: ${el.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
