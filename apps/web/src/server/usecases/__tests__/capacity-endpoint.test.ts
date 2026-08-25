// capacity-endpoint.test.ts — P10 Task 5 (§4 of the design,
// docs/superpowers/specs/bench-product-value/designs/2026-08-24-p10-stranded-
// fixtures-and-capacity-design.md). The server half of the D2 capacity
// precheck: POST /divisions/{id}/schedule/capacity resolves each candidate
// court's REAL calendar and runs the pure `assessCapacity` here, because the
// board payload (board/types.ts) carries none — P9 cut them for the RSC
// budget and that has not changed. Modelled on stranded-courts.test.ts's
// org/venue/court/division seeding chain (same P10 task family, same need:
// a genuine courts row to put a real calendar on).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createVenue, createCourt, putCourtCalendar } from "../venues";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { assessCapacityForDivision, type CapacityPrecheckInput } from "../capacity-guard";

const HAS_DB = !!process.env.DATABASE_URL;

// Same recipe as stranded-courts.test.ts's seedOrg(): 'generic'/'score' are a
// GLOBAL catalog (sports/sport_variants are not org-scoped), hence `on
// conflict do nothing` rather than failing when another suite seeded them
// first.
async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"SC Org " + suffix}, ${"sc-org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json({
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    })}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** One org, one venue, one court, one division — nothing scheduled. Real rows
 *  throughout (via the actual usecases, not raw inserts), the same reasoning
 *  as stranded-courts.test.ts's twin: `putCourtCalendar` needs a genuine
 *  `courts` row to write hours against. */
async function seedDivisionWithCourt(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  courtId: string;
}> {
  const auth = await seedOrg();
  const venue = await createVenue(auth, {
    name: "V " + randomUUID().slice(0, 6),
    address: null,
    sort: 0,
  });
  const court = await createCourt(auth, venue.id, { name: "Court 1", tags: [], sort: 1 });
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Capacity " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return { auth, divisionId: division.id, courtId: court.id };
}

// A Monday (engine convention: weekday 0 = Sunday, matching JS's own
// getUTCDay()), an exact UTC midnight so the day-bucket math is trivial —
// the same style DAY1 already establishes in capacity-input.test.ts and
// capacity-guard.test.ts.
const DAY_MS = 24 * 60 * 60_000;
const MONDAY = Date.UTC(2026, 7, 24, 0, 0);

function bodyFor(courtIds: readonly string[]): CapacityPrecheckInput {
  return {
    fixtures: [],
    config: {
      courts: [...courtIds],
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      window: { from: MONDAY, to: MONDAY + DAY_MS },
    },
  };
}

describe.skipIf(!HAS_DB)("assessCapacityForDivision (DB-backed)", () => {
  it("returns a report whose supply respects court hours — a calendared court supplies strictly less than an open-all-day one", async () => {
    const calendared = await seedDivisionWithCourt();
    const open = await seedDivisionWithCourt();
    await putCourtCalendar(calendared.auth, calendared.courtId, {
      hours: [{ weekday: 1, open_min: 9 * 60, close_min: 11 * 60 }], // 2h on Monday, not the whole day
      exceptions: [],
    });
    const withCalendar = await assessCapacityForDivision(
      calendared.auth,
      calendared.divisionId,
      bodyFor([calendared.courtId]),
    );
    const openAllDay = await assessCapacityForDivision(open.auth, open.divisionId, bodyFor([open.courtId]));
    expect(withCalendar).not.toBeNull();
    expect(openAllDay).not.toBeNull();
    expect(withCalendar!.slotSupply).toBeLessThan(openAllDay!.slotSupply);
  });

  it("returns null when the window is unbounded, matching capacityInputForFixtures's own contract", async () => {
    const { auth, divisionId, courtId } = await seedDivisionWithCourt();
    const body = bodyFor([courtId]);
    await expect(
      assessCapacityForDivision(auth, divisionId, { ...body, config: { ...body.config, window: undefined } }),
    ).resolves.toBeNull();
  });

  it("refuses a division in another org with 404 — divisionId arrives from the client, so this IS the security boundary", async () => {
    const { auth } = await seedDivisionWithCourt();
    const other = await seedDivisionWithCourt();
    await expect(
      assessCapacityForDivision(auth, other.divisionId, bodyFor([other.courtId])),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("logs a capacity_precheck_assessed pino event naming the division and verdict", async () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    const { auth, divisionId, courtId } = await seedDivisionWithCourt();
    await assessCapacityForDivision(auth, divisionId, bodyFor([courtId]));
    // Not toHaveBeenCalledTimes(1): resolveCandidateCourts (court-candidates.ts,
    // reached via courtCalendarsForDivision) always logs its own
    // schedule_court_filtered event first — filter rather than count.
    const call = spy.mock.calls.find(
      ([payload]) => (payload as { event?: string } | undefined)?.event === "capacity_precheck_assessed",
    );
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({ event: "capacity_precheck_assessed", divisionId, verdict: "ok" });
    expect(call![1]).toBe("capacity_precheck_assessed");
    spy.mockRestore();
  });
});
