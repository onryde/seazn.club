import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { TAG, apiJson, addEntrantsViaApi, divisionPath } from "./helpers";

// The Swiss shape legend (owner-approved 2026-09-22, option B) — one line under
// a swiss stage's title on the competition desk:
//
//   3 rounds · 5 matches + 1 bye per round · 18 fixtures
//
// WHY THIS SPEC EXISTS AND THE UNIT TESTS DO NOT COVER IT. `apps/web` vitest is
// `environment: "node"`: it can read the markup a builder produced, and nothing
// else. It cannot see whether the page actually SUPPLIES the roster the legend
// needs, whether the line survives the real CSS cascade at a phone width, or
// whether it pushes the page into horizontal scroll. Every one of those is a
// way this feature could ship inert while a green unit suite says otherwise.
//
// THE DEFECT IT GUARDS. A Swiss stage's later rounds kept shells minted for an
// OLD field size after the roster moved, so those rounds offered fewer matches
// than the field needed and the newcomers had nowhere to be seated. Nothing on
// the screen said so. The `stale` case below reproduces exactly that shape — 18
// rows minted for a field of 12, then three withdrawals — and pins that the
// legend prints what the CURRENT FIELD needs (4 matches + 1 bye) rather than
// what the rows happen to hold. An implementation that counts fixture rows
// passes every other case here and fails that one.
//
// SHOTS. Set `SWISS_LEGEND_SHOTS=<dir>` to also write one cropped PNG per case
// per width (for a visual sign-off). Unset — which is how CI runs it — nothing
// is written and the assertions are the whole test.

const WIDTHS = [320, 768, 1280] as const;
const SHOT_DIR = process.env.SWISS_LEGEND_SHOTS;

type Case = {
  key: string;
  entrants: number;
  withdraw: number;
  rounds: number;
  /** What the SCREEN must say. Derived by hand from the same arithmetic
   *  `swissBoardsForField` applies (boards = floor(n/2), bye = n % 2), against
   *  the field AFTER the withdrawals — never against the row count. */
  expected: string;
};

const CASES: Case[] = [
  // ODD field: 11 → 5 matches + 1 bye. Rows agree (3 × 6 = 18).
  {
    key: "odd-11",
    entrants: 11,
    withdraw: 0,
    rounds: 3,
    expected: "3 rounds · 5 matches + 1 bye per round · 18 fixtures",
  },
  // EVEN field: 10 → 5 matches, NO bye clause at all.
  {
    key: "even-10",
    entrants: 10,
    withdraw: 0,
    rounds: 3,
    expected: "3 rounds · 5 matches per round · 15 fixtures",
  },
  // STALE: minted for 12 (6 a round, 18 rows), then 3 withdraw → field 9, which
  // needs 4 + a bye = 15. The rows still say 18. The legend prints the FIELD's
  // answer and the row count side by side; the disagreement is the signal.
  {
    key: "stale-12-minus-3",
    entrants: 12,
    withdraw: 3,
    rounds: 3,
    expected: "3 rounds · 4 matches + 1 bye per round · 18 fixtures",
  },
];

// Derived from the work, not a flat number (AGENTS.md #20): one division built
// through the API per case, then one page load per width. Moving either list
// moves the budget with it.
const BUDGET_MS = 60_000 + CASES.length * (25_000 + WIDTHS.length * 20_000);

test("swiss shape legend: odd, even and a stale field, at 320 / 768 / 1280", async ({ page, request }) => {
  test.setTimeout(BUDGET_MS);
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss legend ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const compId = comp.data!.id;

  // Read out of the live DOM, then asserted in one place at the end, so a
  // failure reports every width at once instead of stopping at the first.
  const seen: Record<string, string> = {};
  const overflow: Record<string, number> = {};

  for (const c of CASES) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      { name: `${c.key} ${TAG}`, sport_key: "badminton", variant_key: "bwf", config: {} },
    );
    expect(div.status, `${c.key} division: ${JSON.stringify(div.error)}`).toBe(201);
    const divisionId = div.data!.id;

    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: c.rounds } },
    );
    expect(stage.status, `${c.key} stage: ${JSON.stringify(stage.error)}`).toBe(201);

    const added = await addEntrantsViaApi(
      request,
      divisionId,
      Array.from({ length: c.entrants }, (_, i) => `Player ${i + 1}`),
    );
    expect(added.ids, `${c.key} entrants`).toHaveLength(c.entrants);

    // startDivision mints all-round shells on the first stage, for the field as
    // it stands RIGHT NOW — which is what makes the stale case below possible.
    const started = await apiJson<{ generated: number }>(
      request,
      `/api/v1/divisions/${divisionId}/start`,
      "POST",
    );
    expect(started.status, `${c.key} start: ${JSON.stringify(started.error)}`).toBe(200);

    // A withdrawal is a status flip, not a delete: the row survives and drops
    // out of `status in ('registered','confirmed')`. The shells do not move.
    for (let i = 0; i < c.withdraw; i++) {
      const res = await apiJson(request, `/api/v1/entrants/${added.ids[i]}`, "PATCH", {
        status: "withdrawn",
      });
      expect(res.status, `${c.key} withdraw ${i}: ${JSON.stringify(res.error)}`).toBe(200);
    }

    const path = await divisionPath(request, divisionId, "?tab=fixtures");

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(path);
      const legend = page.getByTestId("stage-swiss-legend").first();
      // toBeVisible, not toBeAttached: the point of this spec is that a PERSON
      // can read the line, and nothing folds it behind a phone disclosure.
      await expect(legend, `${c.key}@${w}: legend on screen`).toBeVisible({ timeout: 30_000 });

      seen[`${c.key}@${w}`] = (await legend.textContent())!.trim();
      overflow[`${c.key}@${w}`] = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      if (SHOT_DIR) {
        const card = page
          .locator("section.card", { has: page.getByTestId("stage-swiss-legend") })
          .first();
        await card.scrollIntoViewIfNeeded();
        const cb = (await card.boundingBox())!;
        const lb = (await legend.boundingBox())!;
        await page.screenshot({
          path: `${SHOT_DIR}/swiss-legend-${c.key}-${w}.png`,
          clip: {
            x: Math.max(0, cb.x - 4),
            y: Math.max(0, cb.y - 4),
            width: Math.min(cb.width + 8, w),
            height: Math.min(cb.height + 8, lb.y + lb.height - cb.y + 170),
          },
        });
      }
    }
  }

  // What the screen actually said, verbatim — the record a report quotes.
  console.log("SWISS LEGEND SEEN " + JSON.stringify(seen, null, 2));

  for (const c of CASES) {
    for (const w of WIDTHS) {
      expect(seen[`${c.key}@${w}`], `${c.key}@${w}`).toBe(c.expected);
      // The bye clause is wholly ABSENT on an even field, not merely a
      // different number — a negative with its positive pair above.
      if (c.key === "even-10") expect(seen[`${c.key}@${w}`]).not.toContain("bye");
      expect(overflow[`${c.key}@${w}`], `${c.key}@${w}: horizontal page scroll`).toBeLessThanOrEqual(0);
    }
  }
});
