import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  seedDivision,
  releaseDivision,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { apiJson } from "../helpers";
// A VALUE import, deliberately — `settings-competition-gates.spec.ts:87-89`
// (W5) documents choosing NOT to do this ("no e2e file imports it today")
// out of an unverified concern that `schemas.ts` pulls `@seazn/engine/
// scheduling` and `lib/registration-rules.ts` into a Playwright worker. That
// concern is untested there, not confirmed — empirically probed here first
// (a throwaway spec doing exactly this import, run against a live server:
// `npx playwright test --project=walkthrough` collected and passed 3/3, one
// worker, no error). `registration-rules.ts` is independently documented
// "CLIENT-SAFE... no server-only and no db/server imports" at its own file
// header, and the engine package is pure TS/zod shared with both server and
// client. A value import is the strictly stronger proof the ground truth
// asks for (identity, not a hand-typed literal that could silently drift
// from the real message), so it is used here rather than repeating W5's
// caution without re-testing it.
import { ENDS_BEFORE_STARTS, WINDOW_ENDS_BEFORE_STARTS } from "../../src/server/api-v1/schemas";

/**
 * W6 Task 2 — the numeric/order bounds table for the division `settings`/
 * `constraints` schedule tabs, design register cases #15 (`matchMinutes`
 * 0/1441), #16 (`gapMinutes`/`perEntrantMinRest`/`constraints.restMin`
 * negative), #18's division half (`endAt < startAt`, a blackout `to < from`),
 * and #22 (courts above the 50 cap).
 *
 * Entirely API-only (`APIRequestContext`, no `page`) — every case here is
 * "what does the server say" to a scripted `PUT
 * /api/v1/divisions/{id}/schedule-settings`, which a browser round trip adds
 * nothing to. Task 1 (`settings-schedule-drive.spec.ts`) already owns the UI
 * drive+persist coverage and the one client-side gate (case #17) this surface
 * has; this file never renders a page.
 *
 * `mode: "default"`, never `serial` — same reasoning as every prior wave file
 * in this folder (AGENTS.md failure class 21): `serial` aborts every test
 * after the first red, and this file's whole point is finding refusals.
 *
 * ONE DEVIATION FROM THE PLAN'S SNIPPETS, load-bearing across every test
 * below: every refusal here is asserted as **400** (`error.code ===
 * "VALIDATION"`), not the 422 the plan's unverified code blocks guessed.
 * Read directly off `apps/web/src/server/api-v1/http.ts`'s `v1Inner`:
 *
 *   if (err instanceof ZodError) {
 *     return errorResponse(requestId, 400, "VALIDATION", "Invalid input", { issues: err.issues });
 *   }
 *
 * `parseBody` (`http.ts:252`) runs `schema.parse(raw)` and lets a ZodError
 * propagate untouched — there is no route-local catch that remaps it to 422.
 * This is the codebase's own established convention, not a one-off: two
 * existing unit tests already assert `error.code === "VALIDATION"` off a
 * failed body parse (`competitions/__tests__/create-auth-order.test.ts:86`,
 * `divisions/[id]/publish-schedule/__tests__/route-auth-order.test.ts:114`).
 * `checkInstantOrder`'s `ctx.addIssue` calls (case #18) are ALSO part of the
 * same `schema.parse` call — a superRefine issue is folded into the same
 * ZodError the wrapping `.parse()` throws — so the order-violation cases get
 * the identical 400/VALIDATION treatment as the plain numeric-bound cases,
 * not a distinct status.
 *
 * SCHEMA NOTE the plan asked to be confirmed before trusting any of this:
 * `PutScheduleSettings.config` is typed `ScheduleConfig` (not `.partial()`),
 * but every one of `ScheduleConfig`'s own fields carries either `.default()`
 * or `.nullish()` (`schemas.ts:1384-1461`) — none are bare-required. A
 * single-field body like `{ config: { matchMinutes: 0 } }` is therefore
 * schema-VALID on every OTHER field (they fill in from their defaults), so a
 * bound violation always fails on the bound under test, never on a missing
 * sibling. No GET-then-merge is needed to isolate the signal here (confirmed
 * against a real run too: Task 1's own `tz` pre-seed test PUTs a bare
 * `{ config: {} }` and gets back 200). The flip side, harmless in this file
 * because every division below is freshly seeded and single-purpose: a
 * successful write with an omitted field does not PRESERVE that field's
 * previously-stored value, it RESETS it to the schema default — this is not
 * PATCH semantics. `putScheduleSettings` (`usecases/schedule.ts:420-426`)
 * writes `input.config` as a whole JSON document on every accepted PUT.
 */
test.describe.configure({ mode: "default" });

interface ValidationIssue {
  code: string;
  path: (string | number)[];
  message: string;
}
interface ValidationErrorBody {
  code?: string;
  message?: string;
  issues?: ValidationIssue[];
}

/** The zod `issues` array the wire type does not declare but the JSON body
 *  genuinely carries (`errorResponse`'s `extra` spread, `http.ts:113`). */
function issuesOf(res: { error?: { code?: string; message?: string } }): ValidationIssue[] {
  return (res.error as ValidationErrorBody | undefined)?.issues ?? [];
}

async function putConfig(
  request: APIRequestContext,
  divisionId: string,
  config: Record<string, unknown>,
): Promise<{ status: number; error?: { code?: string; message?: string } }> {
  return apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", { config });
}

// ---------------------------------------------------------------------------

let org: SeededOrg;
let comp: SeededCompetition;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture — same reasoning as
  // `settings-schedule-drive.spec.ts`'s own `beforeAll`: `seedSettingsOrg`
  // moves the `seazn_org` cookie of whatever jar it is handed, and a
  // per-test fixture's jar is not the one any test gets anyway.
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W6-bounds" });
    comp = await seedCompetition(ctx.request, org.orgId, {});
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // Guarded independently — a mid-`beforeAll` throw must not leak either
  // resource (Task 1's own fix-round finding, `fd3adffb8`).
  const ctx = await browser.newContext();
  try {
    if (comp) await releaseCompetition(ctx.request, comp.id);
    if (org) await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

test("case #15: matchMinutes 0 and 1441 are both refused, 1 and 1440 accepted", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    const zero = await putConfig(request, div.id, { matchMinutes: 0 });
    expect(zero.status, `matchMinutes=0: ${JSON.stringify(zero.error)}`).toBe(400);
    expect(zero.error?.code).toBe("VALIDATION");

    const over = await putConfig(request, div.id, { matchMinutes: 1441 });
    expect(over.status, `matchMinutes=1441: ${JSON.stringify(over.error)}`).toBe(400);

    // Boundary values must be ACCEPTED — a bounds test that never proves the
    // edge is reachable is only half the case.
    const min = await putConfig(request, div.id, { matchMinutes: 1 });
    expect(min.status, `matchMinutes=1: ${JSON.stringify(min.error)}`).toBeLessThan(300);

    const max = await putConfig(request, div.id, { matchMinutes: 1440 });
    expect(max.status, `matchMinutes=1440: ${JSON.stringify(max.error)}`).toBeLessThan(300);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("case #16: gapMinutes/perEntrantMinRest/constraints.restMin negative are refused, 0 accepted", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    const gapNeg = await putConfig(request, div.id, { gapMinutes: -1 });
    expect(gapNeg.status, `gapMinutes=-1: ${JSON.stringify(gapNeg.error)}`).toBe(400);

    const restNeg = await putConfig(request, div.id, { perEntrantMinRest: -1 });
    expect(restNeg.status, `perEntrantMinRest=-1: ${JSON.stringify(restNeg.error)}`).toBe(400);

    // `constraints.restMin` extends the same family one layer down
    // (`min(0).max(24*60)`, identical bound to `perEntrantMinRest`). Kept
    // as its own case rather than dropped: it is genuinely real, not a
    // decorative reachability check with nothing behind it —
    // `build-rest-lattice.ts` sends `MAX(perEntrantMinRest, restMin)` to the
    // engine (distinct from `perEntrantMinRest` alone), `constraints-
    // panel.tsx` renders it as its own draft-then-commit field with its own
    // dictionary copy (`constraints.restMin.label/hint/unit`), and
    // `capacity-input.ts`/`engine-constraints.ts`/`schedule-ai.ts` all read
    // `config.constraints.restMin` independently of `perEntrantMinRest`.
    const constraintsRestNeg = await putConfig(request, div.id, {
      constraints: { restMin: -1 },
    });
    expect(
      constraintsRestNeg.status,
      `constraints.restMin=-1: ${JSON.stringify(constraintsRestNeg.error)}`,
    ).toBe(400);

    // The floor is reachable too — 0 for all three in one call. Not
    // re-proving the shared 1440 ceiling here: that upper bound is the
    // identical `.max(24*60)` mechanism case #15 already proved reachable
    // for `matchMinutes`; the only thing distinct about this trio is the
    // 0 floor (`matchMinutes` floors at 1, these three floor at 0).
    const floor = await putConfig(request, div.id, {
      gapMinutes: 0,
      perEntrantMinRest: 0,
      constraints: { restMin: 0 },
    });
    expect(floor.status, `floor=0 (all three): ${JSON.stringify(floor.error)}`).toBeLessThan(300);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("case #18: PUT refuses endAt before startAt, and a blackout window with to before from", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    const order = await putConfig(request, div.id, {
      startAt: "2027-06-01T00:00:00Z",
      endAt: "2027-01-01T00:00:00Z",
    });
    expect(order.status, `startAt/endAt reversed: ${JSON.stringify(order.error)}`).toBe(400);
    // Identity against the exported constant, not a substring — the same
    // symbol `checkDateOrder` (competition-level, `schemas.ts:71-78`) and
    // `checkInstantOrder` (division-level, this endpoint, `schemas.ts:1487-
    // 1526`) both reference, confirmed at the source rather than assumed
    // from the ground-truth doc's own paraphrase.
    const orderIssue = issuesOf(order).find((i) => i.path.join(".") === "config.endAt");
    expect(orderIssue?.message, JSON.stringify(issuesOf(order))).toBe(ENDS_BEFORE_STARTS);

    const window = await putConfig(request, div.id, {
      blackouts: [{ from: "2027-02-01T10:00:00Z", to: "2027-02-01T09:00:00Z" }],
    });
    expect(window.status, `blackout to<from: ${JSON.stringify(window.error)}`).toBe(400);
    const windowIssue = issuesOf(window).find(
      (i) => i.path.join(".") === "config.blackouts.0.to",
    );
    expect(windowIssue?.message, JSON.stringify(issuesOf(window))).toBe(
      WINDOW_ENDS_BEFORE_STARTS,
    );
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("case #22: 51 courts is refused, 50 is accepted", async ({ request }) => {
  const div = await seedDivision(request, comp.id);
  try {
    // `CourtId = Uuid` has no existence check at the schema level, and
    // `putScheduleSettings` (`usecases/schedule.ts:342-345`) only ever reads
    // `stored.config.courts` to find courts being REMOVED (a guard against
    // orphaning a pinned/in-play fixture) — a freshly seeded division has no
    // stored courts, so nothing is removed here, and there is no ownership/
    // existence check anywhere in this use-case for courts being ADDED.
    // Confirmed by reading the use-case directly, not assumed: 50 random
    // UUIDs genuinely exercises the ARRAY-LENGTH cap and nothing else, so
    // the "accepted" half below is not silently 422/400ing for the wrong
    // reason (an ownership check that does not exist).
    const fiftyOne = Array.from({ length: 51 }, () => randomUUID());
    const over = await putConfig(request, div.id, { courts: fiftyOne });
    expect(over.status, `courts.length=51: ${JSON.stringify(over.error)}`).toBe(400);

    const fifty = Array.from({ length: 50 }, () => randomUUID());
    const at = await putConfig(request, div.id, { courts: fifty });
    expect(at.status, `courts.length=50: ${JSON.stringify(at.error)}`).toBeLessThan(300);
  } finally {
    await releaseDivision(request, div.id);
  }
});
