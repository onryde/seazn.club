// R8 close-out — the three guards that keep this wave's fixes from silently
// coming back. Each was written against the BROKEN tree first and observed
// red; the failing value is quoted in each block.
//
// Pure: no DB, no browser, no network — so it runs in every job and cannot
// self-skip.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOLD_MS_DEFAULT } from "../../queue";
import {
  gallerySportBudgetMs,
  BUDGET_FLOOR_MS,
  HOLD_BOUND_TAPS,
} from "../../../../../../e2e/gallery-budget";

const WEB_ROOT = join(__dirname, "../../../../../..");

describe("the gallery's per-sport budget moves with HOLD_MS", () => {
  // THE REGRESSION THIS EXISTS FOR: a flat `test.setTimeout(180_000)`. That
  // literal cleared the bar only while the hold was short; at the product's
  // own default it left tennis short of six of its twelve states and reported
  // the shortfall as a capture failure rather than as a blown clock.
  //
  // Asserted as a RELATION, not a table of numbers — a table would freeze
  // today's constants and stop witnessing the thing it exists for.
  it("grows when the hold grows", () => {
    expect(gallerySportBudgetMs(12_000)).toBeGreaterThan(gallerySportBudgetMs(3_000));
  });

  it("clears the measured cost of the worst sport at the DEFAULT hold", () => {
    // Tennis exceeded 384_000ms at HOLD_MS=12_000 (measured 2026-09-02, twelve
    // states). Scale that clearance to the shipped default so a 5s product
    // hold does not fail a floor that was written against twelve seconds —
    // still derived from HOLD_MS_DEFAULT, not the env-shortened live value.
    const measuredAt12k = 384_000;
    expect(gallerySportBudgetMs(HOLD_MS_DEFAULT)).toBeGreaterThan(
      (measuredAt12k * HOLD_MS_DEFAULT) / 12_000,
    );
  });

  it("never drops below the budget the harness shipped with", () => {
    for (const hold of [0, 1, 500, 3_000]) {
      expect(gallerySportBudgetMs(hold)).toBeGreaterThanOrEqual(BUDGET_FLOOR_MS);
    }
  });

  it("keeps the tap count above the one already proved too low", () => {
    // 24 taps is the count the old 384_000 budget implied, and tennis outran
    // it. Anything at or below that is a known-bad value.
    expect(HOLD_BOUND_TAPS).toBeGreaterThan(24);
  });
});

describe("the v2 pad's Timeline stays deleted", () => {
  // WS-A demolished the v2 pad lane but left `scorepad/timeline.tsx` behind,
  // importable only by its own test. A test whose sole subject is dead code
  // does not fail — it stops meaning anything, which is how the file survived
  // a whole wave's review.
  it("has no module and no test", () => {
    for (const p of [
      "src/components/v2/scorepad/timeline.tsx",
      "src/components/v2/scorepad/__tests__/timeline.test.tsx",
    ]) {
      expect(existsSync(join(WEB_ROOT, p)), `${p} is back`).toBe(false);
    }
  });
});

describe("mobile.spec.ts entrant names carry no projectTag() decoration", () => {
  // WS-I root-caused this file's intermittent 320px tennis scorebug clip to
  // the FIXTURE NAME, not the scorebug: `-${projectTag()}` on an ENTRANT is
  // pure decoration (an entrant name is scoped to one fixture, which `label`
  // already isolates), and it pushed the who-block past its clamp only once
  // the webfont swapped — `.app-display` resolves `--font-barlow` (condensed)
  // over `--font-geist-sans` (not), so the same string measures wider until
  // Barlow lands. Hence intermittent rather than reproducible, and hence a
  // guard rather than a rerun.
  //
  // A source scan is the right instrument HERE and nowhere else: the fact
  // being asserted is a naming convention inside a Playwright spec, which no
  // module can declare and this node-environment suite cannot execute. It
  // matches the narrow shape only — a `label:` may and should keep the suffix.
  it("suffixes labels, never entrant names", () => {
    const src = readFileSync(join(WEB_ROOT, "e2e/mobile.spec.ts"), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(
        ({ line }) =>
          /(?:home|away)[A-Za-z0-9]*Name\s*=/i.test(line) && line.includes("${projectTag()}"),
      );
    expect(
      offenders,
      `entrant name(s) still decorated with projectTag(): ${offenders
        .map((o) => `mobile.spec.ts:${o.n}`)
        .join(", ")}`,
    ).toEqual([]);
  });
});
