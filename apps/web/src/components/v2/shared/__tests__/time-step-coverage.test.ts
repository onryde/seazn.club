// Every clock control in the app steps by a quarter hour.
//
// `DateTimeField` owns that policy for the fields converted onto it, but eight
// native inputs across five files cannot use it (they sit inside their own
// label markup, or predate it), and those are exactly the ones a later edit
// will add a ninth sibling to without noticing. A per-component render test
// cannot see that: it only knows about the inputs someone remembered to write
// a test for.
//
// So this scans the source instead and asserts the invariant over the whole
// tree — a new `<input type="time">` anywhere under apps/web/src fails here
// until it carries a step.
//
// Deliberately a SOURCE scan, not a rendered-DOM one: most of these live in
// components that call hooks, and apps/web has no jsdom (vitest
// `environment: "node"`), so there is no way to mount them.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../../..");

/** Kinds whose `step` is measured in seconds. `date` is excluded on purpose —
 *  there `step` counts DAYS and a quarter-hour value is meaningless. */
const CLOCK_TYPES = ["time", "datetime-local"] as const;

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
 * Comments out. Both `settings-panel.tsx` and `constraints-panel.tsx` discuss
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

describe("every clock input steps by a quarter hour", () => {
  const files = tsxFiles(SRC);

  // Vacuity guard: a scanner that silently matches nothing passes every
  // assertion below. These numbers are floors, not exact counts, so adding a
  // component does not red the suite — but a broken walk or a changed JSX
  // convention does.
  it("the scan actually reaches the component tree", () => {
    expect(files.length).toBeGreaterThan(200);
    const inputs = files.flatMap((f) => inputElements(fs.readFileSync(f, "utf8")));
    expect(inputs.length).toBeGreaterThan(40);
  });

  it("no <input type=time|datetime-local> anywhere under src/ omits step", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const el of inputElements(src)) {
        const isClock = CLOCK_TYPES.some(
          (t) => el.includes(`type="${t}"`) || el.includes(`type={kind}`),
        );
        if (!isClock) continue;
        checked += 1;
        // `step=` covers both the literal and the conditional expression
        // `DateTimeField` itself renders.
        if (!/\bstep=/.test(el)) offenders.push(`${path.relative(SRC, file)}: ${el.slice(0, 80)}`);
      }
    }

    // The eight raw inputs plus DateTimeField's own. If this drops, the matcher
    // stopped matching rather than the tree getting cleaner.
    expect(checked).toBeGreaterThanOrEqual(9);
    expect(offenders).toEqual([]);
  });
});
