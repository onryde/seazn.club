import "server-only";
// The web-layer AUTHORITY for D2's capacity pre-check: runs `assessCapacity`
// and is the one place that throws — a 422 CAPACITY_IMPOSSIBLE with the
// report attached, following the AI_PLAN_FAILED precedent exactly (a typed
// HttpError code, no widening of EngineErrorCode/ENGINE_HTTP: this throw
// lives in the web layer, the engine lib itself throws nothing).
//
// The DB-shape -> CapacityInput conversion itself (`capacityInputForFixtures`)
// lives in `@/lib/capacity-input`, NOT here, and is re-exported below rather
// than duplicated: that module is CLIENT-SAFE (no `server-only`, no
// `@seazn/engine/scheduling` barrel import — see its own header) because the
// setup card imports it directly for its live, no-network recompute. This
// file adds exactly one thing the client must never have: the DB-adjacent
// throw + structured log.
import { z } from "zod";
import { assessCapacity, type CapacityInput, type CapacityReport } from "@seazn/engine/scheduling/capacity";
import { HardConstraint } from "@seazn/engine/scheduling";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { withTenant } from "@/lib/db";
import { resolveVenueTz } from "@/lib/tz";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CAPACITY_REPORT_KEY } from "@/server/api-v1/schemas";
import { capacityInputForFixtures, type CapacityConfigInput, type CapacityFixtureInput } from "@/lib/capacity-input";
import { CAPACITY_PRECHECK_MAX_COURTS, CAPACITY_PRECHECK_MAX_FIXTURES } from "@/lib/capacity-bounds";
// P10 §4: the ONE resolver for a division's candidate courts' real
// calendars — already used by schedule.ts's verifyConfigForDivision. Reused
// here rather than a second DB query shape, same reasoning as resolveVenueTz
// above.
import { courtCalendarsForDivision } from "./court-candidates";

export { capacityInputForFixtures, type CapacityConfigInput, type CapacityFixtureInput };
export { CAPACITY_REPORT_KEY } from "@/server/api-v1/schemas";

/**
 * The ONE typed code both capacity-guard call sites throw — `schedule.ts`'s
 * stage guard (via `guardCapacity` below) and `competition-schedule-ai.ts`'s
 * per-division aggregation (which cannot use `guardCapacity` directly: it
 * must assess every kept division before throwing ONE combined 422 naming
 * all of them, not refuse on the first). A literal string at each throw
 * site is exactly the two-sites-drift shape this codebase keeps naming as
 * its recurring bug — import this, never retype it.
 */
export const CAPACITY_IMPOSSIBLE_CODE = "CAPACITY_IMPOSSIBLE";

/**
 * Structured logging (design doc's "pino event capacity_assessed"): fired
 * from the server-side consumer, never inside the pure lib. Shared so the
 * stage guard and the competition per-division loop cannot describe the
 * same event with two different field sets.
 */
export function logCapacityAssessed(
  report: CapacityReport,
  context: { scope: "stage" | "competition_division"; divisionId: string; [key: string]: unknown },
): void {
  log.info(
    {
      event: "capacity_assessed",
      verdict: report.verdict,
      slotSupply: report.slotSupply,
      slotDemand: report.slotDemand,
      ratio: report.slotDemand > 0 ? report.slotSupply / report.slotDemand : null,
      ...context,
    },
    "capacity_assessed",
  );
}

/**
 * The server's authority: re-run `assessCapacity` and refuse with a typed
 * 422 when the verdict is impossible. `input === null` means the caller's
 * config had nothing to assess (see `capacityInputForFixtures`) — passed
 * straight through, nothing logged, nothing thrown.
 */
export function guardCapacity(
  input: CapacityInput | null,
  context: { scope: "stage" | "competition_division"; divisionId: string; [key: string]: unknown },
): CapacityReport | null {
  if (input === null) return null;
  const report = assessCapacity(input);
  logCapacityAssessed(report, context);
  if (report.verdict === "impossible") {
    throw new HttpError(
      422,
      "This schedule cannot fit the configured courts, dates and rest rules",
      CAPACITY_IMPOSSIBLE_CODE,
      { [CAPACITY_REPORT_KEY]: report },
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// P10 §4 — the live capacity precheck (POST /divisions/{id}/schedule/
// capacity). Distinct from guardCapacity above: that is the GATE an actual
// solve/apply throws through. This is a report-ONLY read the board's
// capacity card polls while an organiser is still editing — it never throws
// on a bad verdict, because "impossible" is exactly the answer the card
// needs to render, not a refusal.
//
// It exists at all because the precheck used to run entirely client-side,
// off the board payload — and P9 stopped shipping per-court calendars there
// after they blew the RSC budget (capacity-input.ts's own header, and its
// `usableWindowsFor` doc comment). So the client's live recompute could only
// ever treat every court as open all day and OVERSTATE supply. Moving the
// computation here gets it real calendars without putting them back on the
// wire — `board/types.ts` and P9's payload shrink are untouched; only
// numbers travel back over THIS endpoint, never a calendar.
// ---------------------------------------------------------------------------

/** The wire body: the board's LIVE, UNSAVED config and fixtures. Deriving
 *  from stored rows instead would make the card blind to the edit being
 *  previewed, which is the only reason this endpoint exists (design doc §4).
 *
 *  `fixtures` mirrors `CapacityFixtureInput` field-for-field rather than raw
 *  DB column names: both existing client call sites
 *  (`settings-panel.tsx`/`stages-panel.tsx`) already map their fixture rows
 *  into exactly this shape before calling `capacityInputForFixtures`
 *  themselves, so sending it as-is here needs no second mapping step on
 *  either side of the wire.
 *
 *  `config` mirrors `CapacityConfigInput` minus `tz` and `courtCalendars`:
 *  `tz` is never client-supplied — `settings.orgTz` is the governing clock
 *  (#397) and `assessCapacityForDivision` below resolves it itself, the same
 *  "client hint, server authority" split `dayCapFor`'s own comment
 *  (capacity-input.ts) already documents for `hard`; `courtCalendars` is
 *  what this whole endpoint exists to add, and can only come from the DB.
 *
 *  This is a USECASE-side schema, deliberately separate from the wire-side
 *  `CapacityPrecheck` registered in `@/server/api-v1/schemas` for the
 *  generated spec (the `ReorderSponsorsInput`/`ReorderSponsors` pair is this
 *  repo's own precedent for the two staying independent objects) — this one
 *  is what the route actually parses the request with. */
export const CapacityPrecheckInput = z.object({
  fixtures: z
    .array(
      z.object({
        id: z.uuid().optional(),
        extKey: z.string().nullable().optional(),
        winnerTo: z.string().nullable().optional(),
        home: z.uuid().optional(),
        away: z.uuid().optional(),
        poolId: z.uuid().optional(),
      }),
    )
    .max(CAPACITY_PRECHECK_MAX_FIXTURES),
  config: z.object({
    // Shared constants, not literals: the CLIENT now refuses to send a body
    // over these bounds (use-capacity-report.ts's `isSendableRequest`), and
    // a bound that drifts from the one its caller is trying to respect is
    // worse than no client-side bound at all — see the constants' own doc
    // comment in capacity-input.ts.
    courts: z.array(z.uuid()).max(CAPACITY_PRECHECK_MAX_COURTS),
    sessionWindows: z.array(z.object({ from: z.number(), to: z.number() })).max(200).optional(),
    blackouts: z
      .array(z.object({ court: z.uuid().optional(), from: z.number(), to: z.number() }))
      .max(200)
      .optional(),
    matchMinutes: z.number().int().positive(),
    gapMinutes: z.number().int().min(0),
    perEntrantMinRest: z.number().int().min(0),
    // Review fix (finding 3, resource exhaustion): `window` carried no span
    // bound — combined with `courts.max(50)` above and `calendarDays`' own
    // 4000-day internal ceiling (capacity-input.ts), a single
    // session-authenticated POST could force ~200k usableWindows calls, each
    // intersecting/subtracting up to 200 session windows and 200 blackouts.
    // Capped at 365 days — this repo's own precedent for a schedule's
    // default span (calendar.ts's `horizonMinutes ?? 365 * 24 * 60`) — so an
    // over-large window is a clear 400 here, never a silently-truncated,
    // still-expensive 200. Mirrored on the wire-side CapacityPrecheck twin
    // (schemas.ts) for the same reason every other bound in this object is
    // duplicated there.
    window: z
      .object({ from: z.number(), to: z.number() })
      .refine((w) => w.to - w.from <= 365 * 24 * 60 * 60 * 1000, {
        message: "window must not span more than 365 days",
      })
      .optional(),
    constraints: z
      .object({
        restMin: z.number().int().min(0).optional(),
        // Bounded like every sibling here: an unbounded record was the one
        // uncapped field on a client-supplied body (P10 Task 5 review).
        restByGroup: z
          .record(z.string(), z.number().int().min(0).max(24 * 60))
          .refine((r) => Object.keys(r).length <= 200, { message: "at most 200 groups" })
          .optional(),
        noBackToBack: z.boolean().optional(),
        hard: z.array(HardConstraint).max(200).optional(),
      })
      .optional(),
    hard: z.array(HardConstraint).max(200).optional(),
  }),
});
export type CapacityPrecheckInput = z.infer<typeof CapacityPrecheckInput>;

/**
 * The server half of the D2 live precheck (design doc §4): resolves the
 * division's real court calendars and org timezone, then runs the SAME pure
 * `assessCapacity` the client used to run alone.
 *
 * Tenant scoping IS the security boundary here — `divisionId` arrives from
 * the client on every call, not just this one's first hop through the route.
 * The lookup below follows `getScheduleSettings`'s own convention
 * (schedule.ts) rather than inventing a second one: `withTenant` activates
 * `app_user` + `app.current_org` (RLS) for the whole callback, so a plain
 * `where d.id = ${divisionId}` already cannot see a division belonging to
 * another org — proven directly by a usecase-level test that calls this
 * function with an `auth` fixed to org A and a `divisionId` from org B,
 * bypassing the route's own `requireResourceAuth` entirely.
 */
export async function assessCapacityForDivision(
  auth: AuthCtx,
  divisionId: string,
  body: CapacityPrecheckInput,
): Promise<CapacityReport | null> {
  return withTenant(auth.orgId, async (tx) => {
    // ONE query for both "does this division exist IN MY ORG" (RLS-scoped —
    // see header) and the org timezone: an inner join produces no row for
    // either a missing division or one RLS has already filtered out.
    const [row] = await tx<{ timezone: string | null }[]>`
      select o.timezone
      from divisions d
      join organizations o on o.id = d.org_id
      where d.id = ${divisionId}`;
    if (!row) throw new HttpError(404, "division not found");
    // Same leaf resolveVenueTz precedence loadSettings (schedule.ts) uses for
    // its own `orgTz` — reused, not re-derived, so this path cannot drift
    // from the governing-clock rule (#397) the rest of scheduling follows.
    // Deliberately `resolveVenueTz(null, …)`, never the division's own `tz`
    // override: that field is DISPLAY only (loadSettings's own comment).
    const tz = resolveVenueTz(null, row.timezone);
    const courtCalendars = await courtCalendarsForDivision(tx, divisionId, body.config.courts);
    const input = capacityInputForFixtures(
      body.fixtures,
      { ...body.config, tz, courtCalendars },
      divisionId,
    );
    if (input === null) return null;
    const report = assessCapacity(input);
    log.info(
      {
        event: "capacity_precheck_assessed",
        orgId: auth.orgId,
        divisionId,
        courts: body.config.courts.length,
        fixtures: body.fixtures.length,
        verdict: report.verdict,
      },
      "capacity_precheck_assessed",
    );
    return report;
  });
}
