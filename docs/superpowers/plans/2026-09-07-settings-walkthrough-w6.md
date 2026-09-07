# Settings W6 Implementation Plan — division schedule + constraints: the full bounds table

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive `/o/{org}/c/{comp}/d/{div}/schedule`'s `settings` and `constraints` tabs — zero e2e coverage before this wave — closing design's Class-4 validation-bounds cases #15 (`matchMinutes` 0/1441), #16 (`gapMinutes`/`perEntrantMinRest` negative), #17 (play-from/until half-filled and inverted), #18's division half (`endAt < startAt`, a blackout/session-window `to < from`), and #22 (courts above the 50 cap).

**Architecture:** Two new `e2e/walkthrough/*.spec.ts` files, following the W1-W5 pattern (`seedSettingsOrg`/`releaseSettingsOrg`, one org per file, `test.describe.configure({ mode: "default" })`). Both are API-first per `_RULES.md` §5 — a browser round trip only where a client-side-only gate (the play-hours half-filled/inverted refusal, which never reaches the network at all) is the thing under test.

**Tech Stack:** Playwright (`walkthrough` project), `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/`releaseCompetition` (already shipped, W4/W5), `apiJson`, a new `seedDivision`/`releaseDivision` pair (this wave — no API-only division helper exists yet; the two existing ones are `createDivisionViaUi`, browser-driven, and `seedScoredDivision`, built for score fixtures neither task needs).

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md` (design of record, §4 wave table, §7 Class-4 register cases #15-18/#22), `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md` (rulings — ruling 8's fast-path budget running total, ~109-115s through W5), `_RULES.md` beside it.

## §0. Ground truth as of 2026-09-07 (re-verified against `origin/main` at `4061cb3d9`, not memory)

The surface is `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx` (436 lines) — tabs `["board", "health", "settings", "constraints", "officials", "history"]` (`TABS`, line 55). This wave's surface is the **`settings`** tab (`StandaloneScheduleSettings`, `components/v2/board/settings-panel.tsx:167`) and the **`constraints`** tab (`ConstraintsPanel`, `components/v2/constraints-panel.tsx`). Do NOT touch the `board`/`health`/`officials`/`history` tabs or `ScheduleBoard`/`fixture-console.tsx` — those belong to the competition-desk programme (`docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`), a separate live programme with its own rulings. This page happens to host both surfaces; this wave's scope is the two tabs named above, nothing else on the page.

**One PUT endpoint, one schema, shared by both tabs.** Both panels read-then-write `PUT /api/v1/divisions/{id}/schedule-settings` against `PutScheduleSettings` (`schemas.ts:1528`) — `{ config: ScheduleConfig, tz?: string | null }`. `ScheduleConfig` (`schemas.ts:1384-1461`) is the single source of truth for every bound this wave tests:

| Field | Bound | Default |
|---|---|---|
| `matchMinutes` | `z.number().int().min(1).max(24*60)` → **1-1440** | 30 |
| `gapMinutes` | `z.number().int().min(0).max(24*60)` → **0-1440** | 0 |
| `perEntrantMinRest` | `z.number().int().min(0).max(24*60)` → **0-1440** | 0 |
| `courts` | `z.array(CourtId).max(50)` — `CourtId = Uuid`, **no existence check at schema level**, so 51 syntactically-valid random UUIDs alone trip the bound | `[]` |
| `blackouts[].from/to`, `sessionWindows[].from/to` | each `IsoDateTime` (`z.iso.datetime({offset:true})`); array-level `.max(200)` | `[]` |
| `constraints.restMin` | `z.number().int().min(0).max(24*60).optional()` — same 0-1440 family as `perEntrantMinRest`, one layer down | none |
| `startAt`/`endAt` | `IsoDateTime.nullish()` each, no numeric bound — order is checked separately (below) | `null` |

**Order checking is a `superRefine` on the WRITE wrapper, deliberately not on `ScheduleConfig` itself** (`checkInstantOrder`, `schemas.ts:1487-1526`, attached via `PutScheduleSettings.superRefine(checkInstantOrder)`, line 1544) — the same schema is also the READ/parse path (`schedule.ts:296`'s `.parse`, `competition-schedule-ai.ts:2429`'s `.safeParse`), so a refine there would 500 every division that already holds a reversed range from before this check existed. This wave's tests target the WRITE wrapper only:

- `startAt`/`endAt` reversed → `code: "custom"`, `path: ["config", "endAt"]`, message = the exported constant `ENDS_BEFORE_STARTS` (same constant W5's competition-level case #18 asserted against — confirm it's genuinely the same exported symbol, not a same-text duplicate, before asserting string equality).
- A `blackouts[i]` or `sessionWindows[i]` with `to < from` → `code: "custom"`, `path: ["config", "blackouts", i, "to"]` (or `sessionWindows`), message = the exported constant `WINDOW_ENDS_BEFORE_STARTS`.
- **Comparison is by EPOCH, not string order** (`Date.parse`, `schemas.ts:1505`) — deliberately, because `IsoDateTime` accepts any offset and lexicographic order is only chronological within one offset. A same-instant pair (`startAt === endAt`) is **permitted**, not refused (a zero-length window is empty, not incoherent) — do not write a test asserting equality is refused, it isn't.

**Case #17 (play-from/until) never reaches the network at all.** `settings-panel.tsx:425-436`: half-filled or inverted play hours set `hoursError` and `return` **before** the `apiV1(...PUT...)` call — a pure client-side early exit. The expansion itself is `dailyHoursToWindows` (`lib/schedule-board.ts:184-203`), a **pure function**: returns `null` on `fromHHMM >= toHHMM` (line 190) or on empty/malformed HHMM (`HHMM.test`, line 189). Because this is pure and already exported, the cheap, direct-signal test is a vitest unit test calling it with the half-filled and inverted cases — not a browser round trip. The browser round trip only earns its place proving the GUARD ITSELF is wired (the panel's early-return actually fires and blocks the network call, not just that the pure function returns null in isolation) — one Playwright assertion that `page.on("request")`/`waitForResponse` never fires a PUT after entering inverted hours and clicking Save, and that `boardset.hoursError`'s rendered text appears.

**`scheduling.board` and `scheduling.constraints` are open on every plan tier as of V353 (#382)** — the page's own top comment says the entitlement checks "stay: an override or a future tier still moves through them," meaning they are currently **dead gates**, not upsells. Do not write a test asserting a Free-tier upsell renders for either key — there is none to see today. If this wave wants a positive proof the plumbing survives (rather than testing nothing), the only honest test is a `setBoolEntitlementOverrideSql` forcing one of these OFF and confirming the override still has no visible effect anywhere in the tree (documents the dead-gate state the same way W5's F9 documented an unexploited gap) — optional, Task 2 Step 6, not required by the design's case register.

**Division create needs a real `sport_key`/`variant_key` pair.** `CreateDivision` (`schemas.ts:301-326`) requires `name`, `sport_key`, `variant_key` (`config` defaults to `{}`). The established safe combo other walkthrough specs already use successfully: `sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }` (`registration-connect.spec.ts:147-150`) — reuse this exact shape, do not invent a different sport/variant pair untested elsewhere in this suite.

## Global Constraints

- `pnpm@10.34.5`, `node >=26`. Fresh worktree: `pnpm install`, then `db:apply` + `sync:sports`.
- One org per spec **file**, seeded via `seedSettingsOrg(request, { plan: "pro", label: "W6" })`, released in `afterAll`. One competition per file via `seedCompetition` (W5's shipped helper, `settings-support.ts`), released in `afterAll`. Divisions are per-test (Task 1's new `seedDivision`/`releaseDivision`), released per-test in `finally`.
- Helper placement: `withDb`-needing helpers → `helpers.ts`; page-driving helpers → `settings-support.ts`; specs → `e2e/walkthrough/` only.
- `test.describe.configure({ mode: "default" })`, never `serial`.
- No `waitForTimeout`. No screenshots, no axe. At most one `page.reload()` per tab under test.
- Every entitlement override written (if Task 2 Step 6 is attempted) restored in the same test's `finally` or an `afterEach` — see W5's own review-confirmed pattern (an `afterEach` that restores unconditionally, stronger than a per-test `finally`, if this file also shares one org+competition across many tests the way W5's gates file did).
- New spec(s) appended to `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`'s `WALKTHROUGH_SPECS` array in the same task that adds each file.
- No new user-facing strings — both tasks assert against existing `boardset.*`/dictionary keys and exported error-message constants, never a hand-typed literal for a string that already has a named export.
- Budget reporting: this wave is entirely fast-path (no Stripe, no real-money leg) — report its measured cost against ruling 8's fast-path running total (~109-115s through W5), not a single ceiling.

---

### Task 1: `settings-schedule-drive.spec.ts` — settings/constraints tab drive+persist, the play-hours client gate

**Files:**
- Modify: `apps/web/e2e/settings-support.ts` — add `seedDivision`/`releaseDivision`
- Create: `apps/web/e2e/walkthrough/settings-schedule-drive.spec.ts`
- Create/modify: a vitest unit test for `dailyHoursToWindows` if one does not already exist (check `apps/web/src/lib/__tests__/schedule-board*.test.ts` first — do not duplicate coverage if the half-filled/inverted cases are already asserted there; if they are, this task's job shrinks to the one browser assertion that the GUARD is wired, and the report should say so rather than padding a redundant unit test)
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/`releaseCompetition` (existing), `apiJson` (`../helpers`).
- Produces: `seedDivision(request, competitionId, opts?)` → `{ id, slug }` and `releaseDivision(request, id)` — Task 2 reuses both; state their exact shipped signature in this task's report verbatim, the way Task 1 of W5 did for `seedCompetition`, since Task 2's dispatch will quote it rather than re-derive it.

- [ ] **Step 1: Add division seed/release helpers to `settings-support.ts`**

Read the file in full first. Append below `releaseCompetition` (or wherever W5's helpers landed — confirm the current line numbers, they may have shifted):

```ts
export interface SeededDivision {
  id: string;
  slug: string;
}

/** A division inside a seeded competition, minimal generic/score shape —
 *  the same sport_key/variant_key combo registration-connect.spec.ts already
 *  proves works, so this wave is not the first to rely on it. */
export async function seedDivision(
  request: APIRequestContext,
  competitionId: string,
  opts: { name?: string } = {},
): Promise<SeededDivision> {
  const created = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name: opts.name ?? `W6 Division ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  if (!created.data) {
    throw new Error(
      `seedDivision: POST .../divisions failed (${created.status}) ${JSON.stringify(created.error)}`,
    );
  }
  return created.data;
}

export async function releaseDivision(request: APIRequestContext, id: string): Promise<void> {
  await apiJson(request, `/api/v1/divisions/${id}`, "DELETE");
}
```

Before finalizing, confirm `DELETE /api/v1/divisions/{id}` actually exists and returns a clean 2xx on a division with no fixtures/entrants (grep the route file, `apps/web/src/app/api/v1/divisions/[id]/route.ts`, for a `DELETE` export) — if it doesn't exist or refuses on some precondition this wave's divisions might trip (unlikely for a freshly-created, empty division, but confirm rather than assume), report the deviation and use whatever cleanup path actually works (a direct SQL delete via a new `helpers.ts` function, following the `withDb` pattern, is the fallback).

- [ ] **Step 2: Write the spec — settings tab drive+persist**

```ts
import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition,
  seedDivision, releaseDivision,
} from "../settings-support";
import { apiJson } from "../helpers";
import type { SeededOrg, SeededCompetition } from "../settings-support";

test.describe.configure({ mode: "default" });

test.describe("division schedule settings — drive and persist", () => {
  let org: SeededOrg;
  let comp: SeededCompetition;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W6-drive" });
    comp = await seedCompetition(request, org.orgId, {});
  });

  test.afterAll(async ({ request }) => {
    await releaseCompetition(request, comp.id);
    await releaseSettingsOrg(request, org);
  });

  test("matchMinutes/gapMinutes/perEntrantMinRest/courts persist across a reload", async ({ page, request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(`/o/${org.slug}/c/${comp.slug}/d/${div.slug}/schedule?tab=settings`);
      // Read the ACTUAL rendered labels/inputs from settings-panel.tsx before
      // finalizing selectors — do not guess `getByLabel` text against a
      // component you have not read the JSX of. Use this file's own dictionary
      // keys (`boardset.*`) the way the component itself does.
      await page.getByLabel(/match length/i).fill("45");
      await page.getByLabel(/gap/i).fill("10");
      await page.getByLabel(/rest/i).fill("15");
      await page.getByRole("button", { name: /^Save/i }).click();
      await expect(page.getByText(/saved/i)).toBeVisible();
      await page.reload();
      await expect(page.getByLabel(/match length/i)).toHaveValue("45");

      const read = await apiJson<{ config: { matchMinutes: number; gapMinutes: number; perEntrantMinRest: number } }>(
        request, `/api/v1/divisions/${div.id}/schedule-settings`, "GET",
      );
      expect(read.data?.config.matchMinutes).toBe(45);
      expect(read.data?.config.gapMinutes).toBe(10);
      expect(read.data?.config.perEntrantMinRest).toBe(15);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Confirm the ACTUAL GET route exists at `/api/v1/divisions/{id}/schedule-settings` with a `GET` handler returning `{ config, tz, ... }` shaped per the `ScheduleSettings` type (`schemas.ts:1547-1553`) — read the route file before writing the read-back assertion, do not assume the shape from the write schema alone.

- [ ] **Step 3: startAt/endAt persistence (a normal, non-inverted pair) and the `tz` tri-state**

One test: set `startAt`/`endAt` to a valid ordered pair, save, reload, confirm both render back and the API read agrees. A second, cheap assertion in the same test or a sibling: save WITHOUT touching `tz` (the panel's own documented behavior, `settings-panel.tsx:443-446` — omitting `tz` must leave a division's stored zone untouched) — if the division was seeded with no explicit zone, confirm it still resolves to the ORG's timezone after a settings save that never touched hours/zone, proving the omit-means-untouched contract rather than assuming the comment is accurate. Read `getScheduleSettings`'s resolution order (`org timezone → 'UTC'`, per `ScheduleSettings.tz`'s doc comment) before writing the assertion.

- [ ] **Step 4: Constraints tab — `noBackToBack`/`fieldFairness` drive+persist (one representative field, not the whole `constraints` object)**

`ConstraintsPanel` (`constraints-panel.tsx`) does its own GET-then-PUT against the same endpoint (confirmed at `constraints-panel.tsx:427-428`), merging into `config.constraints`. Drive ONE boolean toggle (`noBackToBack`, the simplest field in that sub-object) through the actual UI, save, reload, confirm it persisted via an API read of `config.constraints.noBackToBack`. Read the panel's actual rendered control for this field before writing the selector — do not guess a checkbox label.

- [ ] **Step 5: Case #17 — the play-hours client gate is real, not vacuous**

First check whether `dailyHoursToWindows`'s half-filled/inverted behavior is already unit-tested (grep `apps/web/src/lib/__tests__/` for `dailyHoursToWindows`). If it is not, add a vitest case asserting `dailyHoursToWindows("10:00", "09:00", <validIso>, null, "Europe/London")` returns `null` (inverted) and `dailyHoursToWindows("10:00", "", <validIso>, null, "Europe/London")` also returns `null` (a half-filled/malformed HHMM fails `HHMM.test`) — read the actual `HHMM` regex first to construct a genuinely-malformed-but-plausible-typo string rather than an obviously-empty one, so the test reflects a realistic half-filled state.

Then, ONE browser test proving the guard at the call site is wired (not just that the pure function is correct in isolation):

```ts
  test("case #17: half-filled or inverted play hours block the save before any network write", async ({ page, request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(`/o/${org.slug}/c/${comp.slug}/d/${div.slug}/schedule?tab=settings`);
      let putFired = false;
      page.on("request", (req) => {
        if (req.method() === "PUT" && req.url().includes("/schedule-settings")) putFired = true;
      });
      await page.getByLabel(/play from/i).fill("18:00");
      await page.getByLabel(/play until/i).fill("09:00"); // inverted
      await page.getByRole("button", { name: /^Save/i }).click();
      await expect(page.getByText(/hours/i)).toBeVisible(); // boardset.hoursError copy — confirm exact string via dictionary before finalizing
      expect(putFired).toBe(false);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
});
```

Read the actual `boardset.hoursError` dictionary value before hardcoding the `/hours/i` regex — make it specific enough to be a real assertion, not so loose it would match unrelated copy on the page.

- [ ] **Step 6: Wire into `e2e-ci-wiring.test.ts`, run alone, JSON reporter**

```bash
cd apps/web && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/w6-task1.json npx playwright test --project=walkthrough --workers=1 e2e/walkthrough/settings-schedule-drive.spec.ts
```

Read the JSON `stats` — all `expected`, zero `unexpected`/`flaky`. Also run the new/confirmed vitest case for `dailyHoursToWindows` with `DATABASE_URL=` set explicitly (the config-refusal trap: vitest refuses without it and can leave a stale JSON reporter file from another worktree, reading as a false clean pass — confirm `.testResults[].name` resolves inside this worktree).

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/settings-support.ts apps/web/e2e/walkthrough/settings-schedule-drive.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
# plus whichever lib test file Step 5 touched, if any
git commit -m "test(settings): W6 Task 1 — schedule/constraints drive+persist, case #17"
```

---

### Task 2: `settings-schedule-bounds.spec.ts` — the numeric/order bounds table (cases #15, #16, #18, #22)

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-schedule-bounds.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/`releaseCompetition`, `seedDivision`/`releaseDivision` (Task 1's exact shipped signatures — read Task 1's report, do not re-derive), `apiJson`.
- Produces: nothing later tasks depend on. This is the final task in the plan.

This entire file is API-only (`APIRequestContext`, no `page`) — every case here is "what does the server say," which is exactly what a scripted PUT answers without a browser.

- [ ] **Step 1: Case #15 — `matchMinutes` 0 and 1441**

```ts
import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition,
  seedDivision, releaseDivision,
} from "../settings-support";
import { apiJson } from "../helpers";
import type { SeededOrg, SeededCompetition } from "../settings-support";

test.describe.configure({ mode: "default" });

test.describe("division schedule settings — bounds table", () => {
  let org: SeededOrg;
  let comp: SeededCompetition;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W6-bounds" });
    comp = await seedCompetition(request, org.orgId, {});
  });

  test.afterAll(async ({ request }) => {
    await releaseCompetition(request, comp.id);
    await releaseSettingsOrg(request, org);
  });

  test("case #15: matchMinutes 0 and 1441 are both refused", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const zero = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { matchMinutes: 0 },
      });
      expect(zero.status).toBe(422);
      const over = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { matchMinutes: 1441 },
      });
      expect(over.status).toBe(422);
      // Boundary values must be ACCEPTED — a bounds test that never proves the
      // edge is reachable is only half the case.
      const min = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { matchMinutes: 1 },
      });
      expect(min.status).toBeLessThan(300);
      const max = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { matchMinutes: 1440 },
      });
      expect(max.status).toBeLessThan(300);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Before finalizing: confirm whether `PutScheduleSettings`'s `config` field requires the FULL `ScheduleConfig` object on every PUT (in which case a bare `{ matchMinutes: 0 }` would fail on missing required sibling fields rather than on the bound you're testing, corrupting the signal) or whether a partial merge happens somewhere in the route/use-case before validation. Read the actual route handler (`apps/web/src/app/api/v1/divisions/[id]/schedule-settings/route.ts` or wherever it resolves) to confirm — if a full object is required, GET the division's current config first and spread your one changed field over it, the same merge-then-PUT pattern `constraints-panel.tsx` already uses.

- [ ] **Step 2: Case #16 — `gapMinutes`/`perEntrantMinRest` negative, and `constraints.restMin` negative as the natural extension**

Same shape as Step 1, `-1` for each of `gapMinutes`, `perEntrantMinRest`, and (reading `usecases/competitions.ts`'s own established pattern of extending a literal case to a same-family untested branch, as W5's Task 2 did for `hero_image_path`) `constraints.restMin` — confirm this third field is real and independently validated (it shares the identical `min(0).max(24*60)` bound one layer down in the same schema) before adding it; if it turns out to be dead code with no route ever reading `config.constraints.restMin` distinctly from `perEntrantMinRest`, drop it and say why in the report rather than asserting a false gate.

- [ ] **Step 3: Case #18 (division half) — `endAt < startAt`, and a blackout/session-window `to < from`**

```ts
  test("case #18: PUT refuses endAt before startAt, and a blackout/window with to before from", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const order = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { startAt: "2027-06-01T00:00:00Z", endAt: "2027-01-01T00:00:00Z" },
      });
      expect(order.status).toBe(422);
      // pin the exact exported constant, not a hand-typed literal — import it
      // from schemas.ts if it's exported, or match its exact text if it isn't
      expect(JSON.stringify(order.error)).toContain("cannot be before its start");

      const window = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: {
          blackouts: [{ from: "2027-02-01T10:00:00Z", to: "2027-02-01T09:00:00Z" }],
        },
      });
      expect(window.status).toBe(422);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

Confirm whether `ENDS_BEFORE_STARTS`/`WINDOW_ENDS_BEFORE_STARTS` are exported from `schemas.ts` (they read as `export const` in the ground-truth section above — verify at the actual line, import and assert equality rather than a `.toContain` on a substring, which is weaker and could pass on an unrelated coincidental match).

- [ ] **Step 4: Case #22 — courts above the 50 cap**

```ts
  test("case #22: 51 courts is refused, 50 is accepted", async ({ request }) => {
    const div = await seedDivision(request, comp.id);
    try {
      const fiftyOne = Array.from({ length: 51 }, () => crypto.randomUUID());
      const over = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { courts: fiftyOne },
      });
      expect(over.status).toBe(422);

      const fifty = Array.from({ length: 50 }, () => crypto.randomUUID());
      const at = await apiJson(request, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
        config: { courts: fifty },
      });
      expect(at.status).toBeLessThan(300);
    } finally {
      await releaseDivision(request, div.id);
    }
  });
```

`CourtId = Uuid` has no existence check at the schema level (confirmed in §0) — random UUIDs are sufficient to trip the ARRAY bound. If the route's use-case layer (not the zod schema) separately validates that each court id actually belongs to the org's venues, the "accepted" half of this test (50 valid-looking-but-fake ids) could 422 for the WRONG reason (an ownership check, not the count bound) and this test would still pass while asserting nothing about the cap specifically. Check the use-case for such a check before trusting the "50 is accepted" assertion; if one exists, seed 50 REAL court ids via `listVenues`/whatever the org's venue-creation path is (or drop the positive-boundary half if seeding 50 real courts is disproportionate to this one case, and say so in the report — matching this programme's own standard of a stated bias over a silently absorbed gap).

- [ ] **Step 5: Wire into `e2e-ci-wiring.test.ts`, run alone, JSON reporter**

Same pattern as Task 1 Step 6.

- [ ] **Step 6 (optional, not required by the design register): the dead-gate documentation test**

If time/budget allows: one test forcing `scheduling.constraints` off via `setBoolEntitlementOverrideSql` and confirming the constraints tab/PUT path shows no behavioral difference (documents §0's "dead gate" finding the way W5's F9 documented its own unexploited gap) — skip this step entirely if it would push the file's measured cost meaningfully past what Task 1 already spent; report the decision either way.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-schedule-bounds.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): W6 Task 2 — schedule bounds table (cases #15, #16, #18, #22)"
```

---

## Final whole-branch review focus

Beyond the standard rubric: (a) confirm the case #15/#16/#22 tests actually isolate the bound under test — re-derive from the route/use-case whether a partial `config` PUT is legal, since a wrong assumption there corrupts every bounds test in the file the same way; (b) confirm the positive-boundary assertions (matchMinutes=1440, courts=50) are genuinely accepted and not silently 422ing for an unrelated reason (the classic "mutant that breaks collection reads as survived" shape, applied to a boundary test instead of a mutation); (c) confirm case #18's constants are asserted by identity/exact-string, not a loose substring match; (d) confirm the play-hours browser test in Task 1 genuinely proves the network call never fires (a `page.on("request")` listener registered AFTER navigation could miss an early request — confirm registration order); (e) confirm Task 2's restMin extension (if kept) is a real, independently-triggerable gate and not decorative.

## Budget report (fill in from Task 1/2 Step 6's real numbers, owner ruling 8's fast-path bucket)

Cumulative fast-path total through W5 was ~109-115s (see `_INDEX.md`). Report this wave's two files' summed durations against that running total.
