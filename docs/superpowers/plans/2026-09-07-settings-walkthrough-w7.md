# Settings W7 Implementation Plan — division registration settings: cutoff bounds, card-fee minimum, double-submit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close W7's real, narrowed share of the design register — cases #19
(the cutoff half only), #20 (`cardFeeMinimum`), and #24 (this panel's own
double-submit instance) — against the division registration settings modal
(`RegistrationHubConfigPanel`). Case #19's age-band half and case #23
(partial-save misreporting) are **already covered** by a pre-existing,
non-programme spec (`apps/web/e2e/registration-hub.spec.ts`) — see §0.

**Architecture:** Two new `e2e/walkthrough/*.spec.ts` files, following the
W1-W6 pattern (`seedSettingsOrg`/`seedCompetition` one per file,
`seedDivision`/`releaseDivision` per test). Task 1 is browser-driven (the two
client-only gates this wave owns). Task 2 is API-only (the cutoff bounds
matrix and the independent server-side proof of the card-fee minimum).

**Tech Stack:** Playwright (`walkthrough` project), `seedSettingsOrg`/
`releaseSettingsOrg`/`seedCompetition`/`releaseCompetition`/`seedDivision`/
`releaseDivision` (all already shipped, `apps/web/e2e/settings-support.ts`),
`apiJson`.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md`
(design of record, inventory table §2, wave table, Class 4/5 case register),
`docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`
(rulings — ruling 8's fast-path running total, ~129-135s through W6),
`_RULES.md` beside it.

## §0. Ground truth as of 2026-09-07 (re-verified against `origin/main` at `659568cb9`, not memory)

**Surface.** `apps/web/src/components/registration-hub-config-panel.tsx`
(1238 lines), opened from a division row's configure button
(`[data-registration-hub-row-configure]`) on
`/o/{orgSlug}/c/{compSlug}/registration` (`hubPath`, see the existing spec's
own helper). State/save logic lives in `use-registration-hub-config.ts`
(135 lines); client-side validation in `registration-hub-config-state.ts`
(264 lines, `validateConfigState`); error-message mapping in
`registration-hub-save-error.ts`.

**The two-endpoint save, verbatim (`use-registration-hub-config.ts`'s
`save()`):**

```ts
const [patchResult, putResult] = await Promise.allSettled([
  apiV1(`/api/v1/divisions/${division.division_id}`, { method: "PATCH", json: patchBody }),
  apiV1(`/api/v1/divisions/${division.division_id}/registration-settings`, {
    method: "PUT",
    json: putBody,
  }),
]);
```

Both requests fire **simultaneously**, not sequentially — `Promise.allSettled`,
not an `await` chain. `saveOutcome` is one of `"success" | "patch-failed" |
"put-failed" | "both-failed"`, named by what FAILED. It renders as
`<p data-save-outcome="...">` — a direct child of
`[data-registration-hub-config-panel]` — distinct from a field-level error
(`[data-field-error="..."]`, nested inside a section/label).

**Case #19's age-band half and case #23 are ALREADY COVERED — do not
duplicate.** `apps/web/e2e/registration-hub.spec.ts` (1539 lines, pre-dates
this programme, selected by the `parallel` project's default `testMatch`
minus its `testIgnore` list — confirmed live in CI, not orphaned) already has:

- `"422: an inverted age band renders on the age_max field, not a toast"`
  (line 169) — a **partial PATCH** (only `age_min` touched) against a
  previously-saved `age_max=18`, asserting `422`, the field error on
  `age_max`, and — this **is** case #23 — `data-save-outcome="patch-failed"`.
- `"422: allow_free_agents on a non-team division renders on the field, not
  a toast"` (line 208) — the mirror image, `data-save-outcome="put-failed"`,
  using a *different* server-only-enforced field (`allow_free_agents`
  requires `entrant_kind: "team"`) than this plan's own case #23 mechanism
  below.
- `"full-replace hazard: editing one field leaves the others intact after
  reload"` (line 255) — adjacent to, but distinct from, case #23.

W7 therefore does **not** re-test age-band-inverted or build a third
partial-save-misreporting case; both are proven, live, and this plan's ground
truth records exactly where. **This plan's own case #23 instance (Task 1)
exists for a different, load-bearing reason: it exercises the
`entrants.per_division.max` plan-limit check specifically**, which is not
touched by either existing test above and is the one asymmetric,
plan-dependent server-only bound in this modal.

**Case #19 — what's actually left: the cutoff half.** `age_min`/`age_max`
are NOT in `validateConfigState`'s issue set at all (client never blocks an
inverted age band — server-only, already proven above). Cutoff fields are
also absent from `validateConfigState`; the panel's own client behavior is a
`disabled={!maxAge}` on the cutoff `<select>`s (UI-only affordance, not a
validation gate). Server side, `checkAgeCutoff` (`schemas.ts:284-296`,
attached via `.superRefine(checkAgeCutoff)` to both `CreateDivision` and
`PatchDivision`):

```ts
export const AGE_CUTOFF_BOTH_OR_NEITHER =
  "age_cutoff_month and age_cutoff_day must be set together, or both left null.";
export const AGE_CUTOFF_DAY_INVALID_FOR_MONTH = "age_cutoff_day is not a valid day for age_cutoff_month.";

function checkAgeCutoff(v, ctx) {
  if ((v.age_cutoff_month != null) !== (v.age_cutoff_day != null)) {
    ctx.addIssue({ code: "custom", path: ["age_cutoff_day"], message: AGE_CUTOFF_BOTH_OR_NEITHER });
    return;
  }
  if (v.age_cutoff_month != null && v.age_cutoff_day != null && !isValidCutoffDay(v.age_cutoff_month, v.age_cutoff_day)) {
    ctx.addIssue({ code: "custom", path: ["age_cutoff_day"], message: AGE_CUTOFF_DAY_INVALID_FOR_MONTH });
  }
}
```

The schema's OWN comment (`schemas.ts:271-279`) states explicitly: **no
merge-and-validate/DB-race backstop exists or is needed for the cutoff
day-validity check** — both-or-neither forces month/day to travel together in
ONE request, so it is always self-contained (unlike `age_min`/`age_max`,
which needs the DB-CHECK-violation backstop in `divisions.ts` for a
partial-patch race — that backstop, `isAgeCutoffCheckViolation`, still
exists for genuinely concurrent requests, which this wave does not attempt to
construct — out of scope, not a gap). Both cutoff refusals therefore go
through zod's `superRefine` on `PatchDivision` — per this programme's own
W6 finding (`ZodError → 400 VALIDATION` in `v1Inner`), **expect 400, not
422**, for both. Confirm this against `apps/web/src/server/api-v1/http.ts`
before writing the assertion rather than assuming from W6's finding alone —
the shape should be identical (same route family, same wrapper) but re-verify.

**Cutoff-with-no-age-band is UNENFORCED server-side — confirm and document,
don't assume a refusal that isn't there.** Neither `checkAgeCutoff` nor
`patchDivision`'s use-case body references `age_min`/`age_max` when
validating a cutoff. The client's `disabled={!maxAge}` is a UI affordance
only. Before writing this sub-case, confirm live (a scripted PATCH setting
`age_cutoff_month`/`age_cutoff_day` while `age_max` stays `null` — does the
server accept it?) and read `apps/web/src/lib/registration-rules.ts`'s
`ageBandEligibilityIssues` (cited in the panel's own header comment) to
confirm a cutoff with no `age_max` is genuinely inert (produces no
eligibility issue, silently ignored) rather than latently harmful. If
accepted-and-harmless: this is a **documentation-only finding** for
`FINDINGS.md`, matching this programme's F9/F11 pattern (recorded, not
fixed, not asserted as a refusal). If you find it is NOT harmless, that is a
real defect — record it as such and do not paper over it with a passing test.

**Case #20 — `cardFeeMinimum` is a CLIENT-ONLY gate, independently
ALSO enforced server-side.** Client (`registration-hub-config-state.ts:225-230`):

```ts
} else if (state.payment_method === "stripe" && state.fee_cents > 0 && state.fee_cents < CARD_FEE_CENTS_MIN) {
  issues.fee_cents = "cardFeeMinimum";
}
```

`CARD_FEE_CENTS_MIN = 100` (registration-hub-config-state.ts:209). This issue
is surfaced through `saveAndReveal()`'s pre-network gate
(`registration-hub-config-panel.tsx:407-412`) — **exactly W6 case #17's
shape**: the client blocks `save()` outright before any network call, so a
browser test proving the guard is wired needs the same `page.on("request")`
listener pattern W6 used. Server-side, independently
(`apps/web/src/server/usecases/registrations.ts:1849,1860`, inside
`putRegistrationSettings`):

```ts
if (method === "stripe" && freeAgentFeeCents !== null && freeAgentFeeCents > 0 && freeAgentFeeCents < 100) {
  throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
}
// ...
if (feeCents > 0 && feeCents < 100) {
  throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
}
```

This is a manually-thrown `HttpError`, not a zod `superRefine` — per
`http.ts`'s own dispatch comment (`"HttpError → its status"`), this is a
**genuine 422**, not routed through the `ZodError → 400` path W6 found. The
two card-fee checks (main `fee_cents` and `free_agent_fee_cents`) are
independent call sites — Task 2 exercises the main one; confirm whether the
`free_agent_fee_cents` half is realistically reachable given
`allow_free_agents` also requires `entrant_kind: "team"` (a division-level
field, PATCH side) before deciding whether it's worth a second case or a
one-line documentation note that it shares the identical bound and message.

**Case #23's mechanism for THIS plan (distinct from the two existing cases in
`registration-hub.spec.ts`): `capacity` vs. the org's `entrants.per_division.max`
plan limit.** `registrations.ts:1865-1873`:

```ts
if (input.capacity != null) {
  const limit = await getLimit(auth.orgId, "entrants.per_division.max", regDiv?.competition_id);
  if (limit !== null && input.capacity > limit) {
    throw new HttpError(422, `Capacity exceeds your plan's entrant limit (${limit}) — raise the plan or lower the capacity`);
  }
}
```

`validateConfigState`'s own `capacityRange` check is a fixed `1-10_000`
range — it has **no knowledge of the org's plan**, so a capacity value that
is schema-legal but plan-illegal sails past the client gate untouched. Per
`apps/web/src/lib/entitlements.ts:353-354`, `entrants.per_division.max` is
**256 on Pro** (this programme's own `seedSettingsOrg(..., { plan: "pro" })`
convention) and unlimited on the top pass tier. **`capacity: 257` on a
`plan: "pro"` org is therefore accepted by the client and refused by the
server** — combine it in the SAME save as a valid, unrelated `age_min`/
`age_max` PATCH edit to reproduce `saveOutcome === "patch-failed"`... wait,
check the assignment carefully: `age_min`/`age_max` go through **PATCH**;
`capacity` goes through **PUT**. A valid PATCH + an over-limit-capacity PUT
therefore produces **`saveOutcome === "put-failed"`** (PATCH succeeds, PUT
is the one that 422s) — confirm this pairing is right by re-reading which
endpoint each field belongs to (§0's two-endpoint table above) before writing
the assertion; do not assume without re-checking against `toDivisionPatchBody`/
`toRegistrationSettingsPutBody` (`registration-hub-config-state.ts`) which
field goes where.

**Case #24 (W7's own instance) — double-submit on this panel's Save
button.** The button (`registration-hub-config-panel.tsx`, footer, `<button
data-action="save" disabled={busy} ...>`) is disabled while `busy` is true.
`busy` is set synchronously (`setBusy(true)`) as the first line inside
`save()`, before either network call starts. Confirm whether this closes the
gap cleanly (React 18 batches the synchronous state update from the click
handler, so a second `click()` dispatched in the same Playwright step should
already see `disabled` reflected) or whether a genuine double-fire race is
observable — this is a real thing to VERIFY, not assume, per this
programme's own "guard nothing kills is not tested" standard: mutate `busy`'s
early return (or the `disabled` prop) and confirm the test actually reddens.
`?tab=bogus`, the zero-orgs/stale-cookie redirect, and back-nav-with-unsaved-
edits are **already covered by W1/W2's own instances** (`settings-org-
tabs.spec.ts`, `settings-ownership.spec.ts`) and are page-level/route-level
concerns that do not apply to this MODAL (it is not a routed tab) — W7 does
not owe a fresh instance of those three.

## Global Constraints

- `pnpm@10.34.5`, `node >=26`. Fresh worktree: `pnpm install`, then
  `db:apply` + `sync:sports`.
- One org per spec **file**, seeded via `seedSettingsOrg(request, { plan:
  "pro", label: "W7-..." })`, released in `afterAll`. One competition per
  file via `seedCompetition`, released in `afterAll`. **Both releases MUST be
  independently guarded per-resource** — `if (comp) await
  releaseCompetition(...); if (org) await releaseSettingsOrg(...);` — this is
  now an established, twice-enforced pattern (W6's own fix round found and
  fixed exactly this leak); copy it verbatim, do not reinvent it or revert to
  an unguarded `afterAll`.
- Divisions per-test via `seedDivision(request, competitionId, opts?)` /
  `releaseDivision(request, id)` (`apps/web/e2e/settings-support.ts:404-454`,
  verbatim current signatures — do not re-derive), released in that test's
  `finally`.
- Helper placement: page-driving helpers → `settings-support.ts` if reusable
  across files, else file-local (unexported) helpers at the top of the spec
  file, matching `settings-competition-drive.spec.ts`/`settings-schedule-
  drive.spec.ts`'s own precedent. Specs → `e2e/walkthrough/` only — never a
  helper file there (breaks Playwright's bare-directory `testMatch` regex).
- `test.describe.configure({ mode: "default" })`, never `serial`.
- No `waitForTimeout`. No screenshots, no axe. At most one `page.reload()`
  per tab under test.
- New spec(s) appended to `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`'s
  `WALKTHROUGH_SPECS` array in the same task that adds each file.
- No new user-facing strings — assert against existing dictionary keys
  (`reg.hub.config.*`, already in all 4 locales) or exported server-side
  constants (`AGE_CUTOFF_BOTH_OR_NEITHER`, `AGE_CUTOFF_DAY_INVALID_FOR_MONTH`),
  never a hand-typed literal for a string that already has a named export.
- Mutation-testing discipline for every negative assertion — this wave's
  double-submit guard (Task 1) and every 400/422 status+message pair
  (Task 2) each need a delete-the-guard or flip-the-assertion proof before
  being trusted, matching W5/W6's own standard.
- Budget reporting: entirely fast-path (no Stripe, no real-money leg) —
  report against ruling 8's fast-path running total (~129-135s through W6),
  not a single ceiling.

---

### Task 1: `settings-registration-client-guards.spec.ts` — the card-fee client gate, double-submit, case #23's plan-limit race

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-registration-client-guards.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/
  `releaseCompetition`/`seedDivision`/`releaseDivision` (all existing,
  `settings-support.ts`), `apiJson` (`../helpers`).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: File-local helpers — open the modal, save, and the field/save-outcome selectors**

Read `apps/web/e2e/registration-hub.spec.ts` lines 80-131 in full first (the
existing `openConfigPanel`/`save`/`openSection`/`contextFreeBanner` helpers)
— mirror their selector strategy exactly (`[data-registration-hub-row]
[data-division-id="..."]`, `[data-registration-hub-row-configure]`,
`[data-registration-hub-config-panel][data-division-id="..."]`,
`[data-field="..."]`, `[data-field-error="..."]`, `[data-action="save"]`,
`p[data-save-outcome="..."]`) but write your OWN file-local copies in this
new spec file — do not import from `registration-hub.spec.ts` (a different
programme's file, not a shared helper module) and do not seed via that
file's `activeOrg(page)`/local `seedDivision` — this file uses
`seedSettingsOrg`/`seedCompetition`/`settings-support.ts`'s `seedDivision`
per this plan's Global Constraints instead.

```ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition,
  seedDivision, releaseDivision,
} from "../settings-support";
import { apiJson } from "../helpers";
import type { SeededOrg, SeededCompetition } from "../settings-support";

test.describe.configure({ mode: "default" });

const hubPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}/registration`;

async function openConfigPanel(page: Page, divisionId: string): Promise<Locator> {
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();
  const content = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionId}"]`);
  await expect(content).toBeVisible({ timeout: 20_000 });
  await expect(content.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  return page.getByRole("dialog").filter({ has: content });
}

async function openSection(panel: Locator, id: string): Promise<void> {
  const section = panel.locator(`[data-accordion-section="${id}"]`);
  await expect(section).toHaveCount(1, { timeout: 20_000 });
  if (await section.evaluate((el) => (el as HTMLDetailsElement).open)) return;
  await section.locator("summary").click();
  await expect
    .poll(async () => section.evaluate((el) => (el as HTMLDetailsElement).open), { timeout: 20_000 })
    .toBe(true);
}
```

- [ ] **Step 2: Case #20 — the card-fee-minimum client gate is real, not vacuous**

```ts
test.describe("registration settings — client guards and the plan-limit race", () => {
  let org: SeededOrg;
  let comp: SeededCompetition;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W7-guards" });
    comp = await seedCompetition(request, org.orgId, {});
  });

  test.afterAll(async ({ request }) => {
    if (comp) await releaseCompetition(request, comp.id);
    if (org) await releaseSettingsOrg(request, org);
  });

  test("case #20: a below-minimum card fee blocks the save before any network write", async ({ page, request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(org.slug, comp.slug), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);
      await openSection(panel, "money");
      let putFired = false;
      page.on("request", (req) => {
        if (req.method() === "PUT" && req.url().includes("/registration-settings")) putFired = true;
      });
      await panel.locator('[data-field="fee_cents"]').fill("0.50");
      await panel.locator('[data-field="payment_method_stripe"]').check();
      await panel.locator('[data-action="save"]').click();
      const fieldError = panel.locator('[data-field-error="fee_cents"]');
      await expect(fieldError).toBeVisible({ timeout: 20_000 });
      // apps/web/src/dictionaries/en/ui.json — reg.hub.config.cardFeeMinimumError.
      // Re-confirm this string is still current before trusting it verbatim.
      await expect(fieldError).toContainText("Card entry fees must be at least 1.00, or 0 to make entry free.");
      expect(putFired).toBe(false);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
});
```

Read `apps/web/src/dictionaries/en/*.json` for the real
`reg.hub.config.cardFeeMinimumError` value before filling in the
`toContainText` call — do not guess it. **Mutation-test this**: comment out
or invert the client-side `cardFeeMinimum` check in
`registration-hub-config-state.ts` (temporarily — restore via `cp -p` backup,
never `git checkout`, per this programme's standing mutation discipline),
confirm the test reddens (`putFired` becomes `true`, or the field error never
appears), then restore and re-confirm green.

- [ ] **Step 3: Case #24 — double-submit on this panel's Save button**

```ts
  test("case #24: a rapid second click on Save does not fire two save cycles", async ({ page, request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(org.slug, comp.slug), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);
      let putCount = 0;
      page.on("request", (req) => {
        if (req.method() === "PUT" && req.url().includes("/registration-settings")) putCount++;
      });
      await panel.locator('[data-field="category"]').selectOption("mens");
      const saveBtn = panel.locator('[data-action="save"]');
      // Two clicks back to back, deliberately not awaited between them —
      // the scenario is a real double-tap, not two sequential, separately-
      // awaited saves.
      await Promise.all([saveBtn.click(), saveBtn.click({ force: true })]);
      await expect(panel).toBeHidden({ timeout: 20_000 });
      expect(putCount).toBe(1);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

`{ force: true }` on the second click is deliberate — Playwright's default
actionability check would otherwise itself refuse to click a `disabled`
button, which would prove nothing about the APPLICATION's own guard (it
would just prove Playwright's own click-guard works). Confirm this reasoning
holds by reading Playwright's actionability docs for `force` before relying
on it, and **mutation-test this guard**: temporarily remove
`disabled={busy}` from the Save button (`registration-hub-config-panel.tsx`),
confirm `putCount` becomes `2` (proving the test can see a real double-fire),
restore, and re-confirm `putCount === 1`.

- [ ] **Step 4: Case #23 (this plan's own mechanism) — capacity above the plan limit, alongside a valid age-band PATCH**

```ts
  test("case #23: an over-limit capacity fails the PUT while a concurrent PATCH succeeds", async ({ page, request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(org.slug, comp.slug), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);
      // PATCH side: a valid, unrelated age-band edit.
      await panel.locator('[data-field="age_min"]').fill("8");
      await panel.locator('[data-field="age_max"]').fill("99");
      // PUT side: capacity above the Pro plan's entrants.per_division.max
      // (256, apps/web/src/lib/entitlements.ts) — confirm this literal is
      // still current before hardcoding it; read the entitlements file's
      // own value rather than trusting this comment three months from now.
      await panel.locator('[data-field="capacity"]').fill("257");
      await panel.locator('[data-action="save"]').click();
      await expect(
        panel.locator('[data-registration-hub-config-panel] > p[data-save-outcome="put-failed"]'),
      ).toHaveCount(1, { timeout: 20_000 });
      const fieldError = panel.locator('[data-field-error="capacity"]');
      await expect(fieldError).toBeVisible();
      await expect(fieldError).toContainText("plan's entrant limit");
      await expect(panel).toBeVisible(); // rejected save — panel stays open

      // Confirm the PATCH half genuinely landed (the point of case #23):
      // reload and re-open, age band persisted despite the PUT failing.
      await page.reload({ waitUntil: "load" });
      const reopened = await openConfigPanel(page, div.id);
      await expect(reopened.locator('[data-field="age_min"]')).toHaveValue("8");
      await expect(reopened.locator('[data-field="age_max"]')).toHaveValue("99");
      // And confirm capacity did NOT silently take the invalid value —
      // read it back via the API rather than trusting the closed modal's
      // stale local state.
      const read = await apiJson<{ capacity: number | null }>(
        request, `/api/v1/divisions/${div.id}/registration-settings`, "GET",
      );
      expect(read.data?.capacity).not.toBe(257);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
});
```

Confirm the GET route at `/api/v1/divisions/{id}/registration-settings`
returns a `capacity` field with this exact shape before finalizing the
read-back — read the route file, do not assume from the PUT schema alone.
Confirm the field-name string `[data-field="capacity"]` genuinely maps to
the `PUT`'s `capacity` (not `entrants.per_division.max`'s own separate limit
control, if one exists elsewhere in the panel — there should not be one, but
confirm by reading the panel's capacity section, lines ~900-920).

- [ ] **Step 5: Wire into `e2e-ci-wiring.test.ts`, run alone, JSON reporter**

```bash
cd apps/web && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/w7-task1.json npx playwright test --project=walkthrough --workers=1 e2e/walkthrough/settings-registration-client-guards.spec.ts
```

Read the JSON `stats` — all `expected`, zero `unexpected`/`flaky`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-registration-client-guards.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): W7 Task 1 — registration client guards, case #23's plan-limit race"
```

---

### Task 2: `settings-registration-bounds.spec.ts` — the cutoff bounds matrix, and card-fee-minimum's independent server-side proof

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/
  `releaseCompetition`/`seedDivision`/`releaseDivision` (all existing).
- Produces: nothing later tasks depend on. This is the final task in the plan.

This entire file is API-only (`APIRequestContext`, no `page`).

- [ ] **Step 1: Cutoff day invalid for month, and both-or-neither**

```ts
import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition,
  seedDivision, releaseDivision,
} from "../settings-support";
import { apiJson } from "../helpers";
import {
  AGE_CUTOFF_BOTH_OR_NEITHER,
  AGE_CUTOFF_DAY_INVALID_FOR_MONTH,
} from "../../src/server/api-v1/schemas";
import type { SeededOrg, SeededCompetition } from "../settings-support";

test.describe.configure({ mode: "default" });

test.describe("registration settings — cutoff bounds and the card-fee server-side proof", () => {
  let org: SeededOrg;
  let comp: SeededCompetition;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W7-bounds" });
    comp = await seedCompetition(request, org.orgId, {});
  });

  test.afterAll(async ({ request }) => {
    if (comp) await releaseCompetition(request, comp.id);
    if (org) await releaseSettingsOrg(request, org);
  });

  test("cutoff day 31 for February (month=2) is refused; a valid day is accepted", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const invalid = await apiJson(request, `/api/v1/divisions/${div.id}`, "PATCH", {
        age_cutoff_month: 2, age_cutoff_day: 31,
      });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(invalid.error)).toContain(AGE_CUTOFF_DAY_INVALID_FOR_MONTH);

      const valid = await apiJson(request, `/api/v1/divisions/${div.id}`, "PATCH", {
        age_cutoff_month: 2, age_cutoff_day: 28,
      });
      expect(valid.status).toBeLessThan(300);
    } finally {
      await releaseDivision(request, div.id);
    }
  });

  test("cutoff both-or-neither: one field alone is refused", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const monthOnly = await apiJson(request, `/api/v1/divisions/${div.id}`, "PATCH", {
        age_cutoff_month: 6,
      });
      expect(monthOnly.status).toBe(400);
      expect(JSON.stringify(monthOnly.error)).toContain(AGE_CUTOFF_BOTH_OR_NEITHER);

      const dayOnly = await apiJson(request, `/api/v1/divisions/${div.id}`, "PATCH", {
        age_cutoff_day: 15,
      });
      expect(dayOnly.status).toBe(400);
      expect(JSON.stringify(dayOnly.error)).toContain(AGE_CUTOFF_BOTH_OR_NEITHER);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Confirm `AGE_CUTOFF_BOTH_OR_NEITHER`/`AGE_CUTOFF_DAY_INVALID_FOR_MONTH` are
genuinely exported from `schemas.ts` at the path this import uses (§0 quotes
them; re-verify the exact export before trusting the quoted snippet) and
confirm the actual HTTP status is 400 by reading `http.ts`'s dispatch — do
not assume from W6's finding without re-checking this route family
specifically.

- [ ] **Step 2: Cutoff with no age band — confirm and document, don't assume**

```ts
  test("a cutoff with no age_max is accepted and produces no eligibility issue (documented, not a defect)", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const res = await apiJson(request, `/api/v1/divisions/${div.id}`, "PATCH", {
        age_cutoff_month: 9, age_cutoff_day: 1,
      });
      expect(res.status).toBeLessThan(300);
      const read = await apiJson<{ age_max: number | null; age_cutoff_month: number | null }>(
        request, `/api/v1/divisions/${div.id}`, "GET",
      );
      expect(read.data?.age_max).toBeNull();
      expect(read.data?.age_cutoff_month).toBe(9);
      // If ageBandEligibilityIssues (lib/registration-rules.ts) is reachable
      // from a division GET/read path exercised elsewhere in this suite,
      // confirm it reports no issue for this division here too. If no such
      // read path exists in this file's reach, note that in the report
      // rather than fabricating one — this test's job is to confirm the
      // WRITE is accepted, not to prove every downstream consumer's
      // behavior.
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Before finalizing this test, confirm live whether this write is genuinely
accepted (§0 says it should be, based on reading `checkAgeCutoff` and
`patchDivision`, but confirm by running it, not by re-reading the code a
second time). If it is REFUSED instead, delete this test and replace it with
one asserting the actual refusal — do not force a false "accepted" assertion
to match this plan's prediction. Either way, add a matching entry to
`docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md`
(read F9/F11 first for the exact format) recording which behavior was found.

- [ ] **Step 3: Card-fee minimum — the independent SERVER-side proof (bypassing the client entirely)**

```ts
  test("card entry fee below 1.00 is refused server-side even when the client gate is bypassed", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      // A direct PUT, never touching the panel's own client-side
      // validateConfigState — this is what distinguishes this test from
      // Task 1's browser test: it proves the server does NOT rely on the
      // client to enforce this bound.
      const res = await apiJson(request, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
        enabled: true, entrant_kind: "team", payment_method: "stripe", fee_cents: 50, approval: "auto",
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.error)).toContain("Card entry fees must be at least 1.00");

      const accepted = await apiJson(request, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
        enabled: true, entrant_kind: "team", payment_method: "stripe", fee_cents: 100, approval: "auto",
      });
      expect(accepted.status).toBeLessThan(300);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Before finalizing: confirm whether the PUT requires the org to have
`charges_enabled`/Stripe Connect attached before `payment_method: "stripe"`
is even reachable (`registrations.ts` checks `org.charges_enabled` ahead of
the fee-minimum check for the main `fee_cents` path — re-read the exact
order in `putRegistrationSettings` to confirm a Pro org with no Connect
account attached would fail EARLIER, on the Connect check, rather than on
the fee-minimum check, which would corrupt this test's signal). If
`charges_enabled` gates this earlier, either seed a Connect-attached org
(this program has NOT needed real Stripe money legs before — check whether
`seedSettingsOrg` has a `chargesEnabled`-style option before reaching for the
real Stripe sandbox, which ruling 3 reserves for actual money-completion
legs, not a pure validation-order check) or find a different, ungated way to
reach this specific check. Report whatever you find; do not silently work
around a blocked path without recording why.

- [ ] **Step 4: Wire into `e2e-ci-wiring.test.ts`, run alone, JSON reporter**

Same pattern as Task 1 Step 5.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): W7 Task 2 — cutoff bounds matrix, card-fee server-side proof"
```

---

## Final whole-branch review focus

Beyond the standard rubric: (a) confirm Task 1's case #23 mechanism is
correctly paired — re-verify `capacity` genuinely rides the PUT (not the
PATCH) and that 257 genuinely exceeds a `plan: "pro"` org's live
`entrants.per_division.max` (re-read `entitlements.ts`, don't trust this
plan's quoted `256` three months from now); (b) confirm Task 1's double-
submit test actually observed a real race, not an artifact of `{force:
true}` bypassing Playwright's own guard in a way that proves nothing about
the application (the mutation-test in Step 3 is the check for this — confirm
it was actually run and its result recorded, not just described); (c)
confirm Task 2's Step 2 (cutoff-no-band) genuinely ran live before being
committed as "accepted" — this plan predicts the outcome from reading code,
which this programme's own standing rule treats as a hypothesis, not a fact,
until driven; (d) confirm neither task duplicates
`registration-hub.spec.ts`'s existing age-band-inverted or partial-save
coverage (re-grep that file's test titles against this wave's before
approving); (e) confirm Task 2 Step 3's Connect/charges_enabled precondition
was genuinely resolved, not silently worked around.

## Budget report (fill in from Task 1/2's real numbers, owner ruling 8's fast-path bucket)

Cumulative fast-path total through W6 was ~129-135s (see `_INDEX.md`).
Report this wave's two files' summed durations against that running total.
