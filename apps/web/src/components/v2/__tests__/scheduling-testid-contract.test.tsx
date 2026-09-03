import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The testid vocabulary the scheduling walkthrough specs select on.
 *
 * A SOURCE SCAN, deliberately — not a render test. `apps/web` vitest is
 * `environment: "node"` (vitest.config.ts) with no DOM, so nothing here can
 * mount a component. What this file exists to catch is the rename: a testid
 * silently dropped or reworded by a later edit, which would leave a
 * walkthrough spec selecting on nothing and timing out with no clue why. A
 * literal `data-testid="x"` present in the source of the file that owns it is
 * exactly enough for that, and is honest about being no more than that — it
 * cannot prove the attribute reaches a rendered element, only that the
 * component still declares it.
 *
 * `history-panel.tsx` is deliberately ABSENT from this map. Its own testids
 * (`schedule-clear`, `savepoint-create`, `checkpoint-row`, …) belong to a
 * different task that owns that file; asserting them from here would red this
 * suite on work this file has no say over.
 */
const OWNED: Record<string, readonly string[]> = {
  "src/components/v2/shared/court-multi-picker.tsx": ["court-picker", "court-option"],
  "src/components/v2/board/settings-panel.tsx": [
    "settings-match-minutes",
    "settings-gap-minutes",
    "settings-day-start",
    "settings-day-end",
  ],
  "src/components/v2/constraints-panel.tsx": [
    "constraint-min-rest",
    "constraint-max-per-day",
    "constraint-cross-person-clash",
    "constraint-no-back-to-back",
    "constraint-field-fairness",
    "blackout-editor",
    "blackout-add",
    "blackout-from",
    "blackout-to",
    "blackout-court",
    "blackout-row",
    "blackout-save",
    "wait-report-check",
    "wait-report-result",
  ],
  "src/components/v2/officials-panel.tsx": [
    "officials-propose",
    "officials-apply",
    "officials-assign-select",
    "officials-unavailable-note",
  ],
  "src/components/me/officiating-lane.tsx": [
    "official-blackout-date",
    "official-blackout-add",
    // The card root, and the ONLY thing in this lane that carries an identity.
    // Review round 1: the three response testids below repeat once per
    // assignment — `officiating-lane.tsx:78` maps `<AssignmentCard>` over
    // `assignments`, and an official holding two open offers is the ordinary
    // case — so `getByTestId("me-official-accept")` is a strict-mode violation
    // on its own. They are scoped through this card's `data-fixture-id`.
    "me-official-card",
    "me-official-accept",
    "me-official-decline",
    // Declining is two steps — the first button opens the reason field, the
    // second sends the response. Both need a handle or a spec can only drive
    // half the flow (and would have to select the other half on translated
    // button text, which is the whole thing this vocabulary exists to avoid).
    "me-official-decline-confirm",
  ],
};

/**
 * A testid rendered once per item is not selectable on its own: three court
 * checkboxes carrying `data-testid="court-option"` give a spec no way to say
 * WHICH court. Each repeated testid therefore ships an identity column beside
 * it, and this pins that the column is still there — dropping it is a silent
 * regression that the OWNED scan above cannot see.
 *
 * `blackout-from` / `blackout-to` / `blackout-court` also repeat, but they are
 * nested INSIDE `blackout-row`, so a spec scopes them through the row's own
 * `data-blackout-index` rather than needing a column of their own. The three
 * `me-official-*` response testids are the same shape, scoped through
 * `me-official-card`.
 *
 * Review round 2: that card's identity is `data-fixture-official-id`, NOT the
 * fixture id. `officiating-lane.tsx` keys cards on
 * `${fixture_id}:${official_id}:${role_key}`, so one official holding two
 * ROLES on the same fixture renders two cards sharing a fixture id — the same
 * strict-mode defect one layer in. `fixture_official_id` is the
 * `fixture_officials` row surrogate (`me-officiating.ts:31`, selected as
 * `fo.id` by both lane queries), which is unique per card by construction.
 */
const IDENTITY: Record<string, readonly (readonly [string, string])[]> = {
  "src/components/v2/shared/court-multi-picker.tsx": [["court-option", "data-court-id"]],
  "src/components/v2/officials-panel.tsx": [["officials-assign-select", "data-fixture-id"]],
  "src/components/v2/constraints-panel.tsx": [["blackout-row", "data-blackout-index"]],
  "src/components/me/officiating-lane.tsx": [["me-official-card", "data-fixture-official-id"]],
};

/**
 * `../../../../` from `apps/web/src/components/v2/__tests__/` is `apps/web/`,
 * so every key above resolves as `apps/web/<key>`. The existence assertion is
 * not ceremony: if that depth is ever wrong, every case below fails
 * identically with an ENOENT that reads like a missing testid, and the obvious
 * repair is to "add" attributes that are already there.
 */
function readOwned(file: string): string {
  const url = new URL(`../../../../${file}`, import.meta.url);
  expect(
    existsSync(url),
    `contract test cannot resolve ${file} (tried ${url.pathname}) — fix this test's relative depth, not the component`,
  ).toBe(true);
  return readFileSync(url, "utf8");
}

describe("scheduling testid contract", () => {
  for (const [file, ids] of Object.entries(OWNED)) {
    it(`${file} owns its testids`, () => {
      const src = readOwned(file);
      for (const id of ids) {
        expect(src, `${file} is missing data-testid="${id}"`).toContain(`data-testid="${id}"`);
      }
    });
  }

  for (const [file, pairs] of Object.entries(IDENTITY)) {
    it(`${file} keeps the identity column for its repeated testids`, () => {
      const src = readOwned(file);
      for (const [id, attr] of pairs) {
        expect(
          src,
          `${file} renders data-testid="${id}" once per item but no longer carries ${attr}={…}, so a spec cannot target one instance`,
        ).toContain(`${attr}={`);
      }
    });
  }

  it("assigns every testid to exactly one owning file", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [file, ids] of Object.entries(OWNED)) {
      for (const id of ids) {
        const previous = seen.get(id);
        if (previous !== undefined) collisions.push(`${id}: ${previous} and ${file}`);
        else seen.set(id, file);
      }
    }
    expect(collisions, `a testid claimed by two files has no single owner: ${collisions.join("; ")}`).toEqual([]);
  });
});
