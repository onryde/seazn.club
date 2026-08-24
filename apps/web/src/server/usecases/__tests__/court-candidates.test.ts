// court-candidates.test.ts — P9 pass 2b: the web-layer resolver both
// `autoSchedule` (build) and `validateScheduleIn` (validate) call through to
// reach the ONE engine filter (`@seazn/engine/scheduling`'s `candidateCourts`)
// — see `court-candidates.ts`'s own header for why a second, inlined tag-filter
// loop at either call site is this subsystem's recurring bug, not a style nit.
//
// Modelled on `capacity-guard.test.ts`: pure behaviour (`unionRequiredCourtTags`,
// `guardNoMatchingCourt`) needs no DB and is tested directly here; the DB-backed
// half (`resolveCandidateCourts`, which reads real `courts`/`venues` rows) is
// gated the same way every other DB-backed suite in this directory is.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { sql, withTenant } from "@/lib/db";
import {
  guardNoUsableCourtWindows,
  guardNoMatchingCourt,
  NO_MATCHING_COURT_CODE,
  resolveCandidateCourts,
  unionRequiredCourtTags,
} from "../court-candidates";

const HAS_DB = !!process.env.DATABASE_URL;

describe("unionRequiredCourtTags — D5/P8 division tags ∪ P9 stage tags", () => {
  it("unions two disjoint tag sets", () => {
    expect(unionRequiredCourtTags(["clay"], ["indoor"])).toEqual(["clay", "indoor"]);
  });

  it("dedupes a tag required by BOTH the division and the stage", () => {
    expect(unionRequiredCourtTags(["clay", "indoor"], ["indoor"])).toEqual(["clay", "indoor"]);
  });

  it("either side empty still returns the other side's tags", () => {
    expect(unionRequiredCourtTags([], ["indoor"])).toEqual(["indoor"]);
    expect(unionRequiredCourtTags(["clay"], [])).toEqual(["clay"]);
  });

  it("both sides empty unions to empty (every court qualifies)", () => {
    expect(unionRequiredCourtTags([], [])).toEqual([]);
  });

  it("normalises the union (trim/lowercase/dedupe) — defensive: stages.required_court_tags " +
    "has no write path yet (P9 pass 2b) and must not assume future writers will normalise",
    () => {
      expect(unionRequiredCourtTags([" Clay "], ["CLAY", "Indoor"])).toEqual(["clay", "indoor"]);
    },
  );
});

describe("guardNoUsableCourtWindows — P9.5 edge matrix row 3", () => {
  // Row 3: when every candidate court's usable windows are empty for the run,
  // the organiser gets a TYPED refusal in the NO_MATCHING_COURT family — never
  // a silent zero-slot lattice that comes back "infeasible" with no reason.
  // P9 set this precedent for the tag filter; hours are the same shape of
  // "nothing can ever be placed here".
  const SATURDAY = 6;
  const range = { from: "2026-08-01", to: "2026-08-01" }; // a Saturday
  const ctx = { divisionId: "d1" };
  const openSat = (courtId: string, openMin: number, closeMin: number) => ({
    courtId,
    hours: [{ weekday: SATURDAY, openMin, closeMin }],
    exceptions: [],
  });

  it("refuses when every candidate court is closed for the whole run", () => {
    const calendars = [
      { courtId: "c1", hours: [{ weekday: 1, openMin: 540, closeMin: 1020 }], exceptions: [] },
      { courtId: "c2", hours: [{ weekday: 1, openMin: 540, closeMin: 1020 }], exceptions: [] },
    ];

    try {
      guardNoUsableCourtWindows(["c1", "c2"], calendars, range, { tz: "UTC" }, ctx);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(422);
      expect((e as HttpError).code).toBe("NO_MATCHING_COURT");
    }
  });

  it("refuses when court hours and the session window do not intersect (row 2 -> row 3)", () => {
    // The owner's own worked example: court 15:00-20:00, session 09:00-13:00.
    const sessionWindows = [
      { from: Date.parse("2026-08-01T09:00:00Z"), to: Date.parse("2026-08-01T13:00:00Z") },
    ];

    expect(() =>
      guardNoUsableCourtWindows(
        ["c1"],
        [openSat("c1", 15 * 60, 20 * 60)],
        range,
        { tz: "UTC", sessionWindows },
        ctx,
      ),
    ).toThrow(HttpError);
  });

  it("passes when even ONE candidate court has a usable window", () => {
    const calendars = [
      { courtId: "c1", hours: [{ weekday: 1, openMin: 540, closeMin: 1020 }], exceptions: [] },
      openSat("c2", 15 * 60, 20 * 60),
    ];

    expect(() =>
      guardNoUsableCourtWindows(["c1", "c2"], calendars, range, { tz: "UTC" }, ctx),
    ).not.toThrow();
  });

  it("passes when a candidate court declares NO calendar — absent means unrestricted", () => {
    // The regression this guard must never cause: calendars strictly SUBTRACT,
    // so a court nobody has given hours to is open, and its presence alone is
    // enough to make the run placeable.
    expect(() =>
      guardNoUsableCourtWindows(["c1", "c-no-calendar"], [openSat("c1", 0, 1)], range, { tz: "UTC" }, ctx),
    ).not.toThrow();
  });

  it("passes when NO court has a calendar at all — the status quo ante", () => {
    expect(() => guardNoUsableCourtWindows(["c1", "c2"], [], range, { tz: "UTC" }, ctx)).not.toThrow();
  });

  it("does nothing without a tz, matching the placer and the verifier", () => {
    // Court hours are day-shaped; with no zone there is no local midnight to
    // resolve a weekday against, so both sides SKIP them. A guard that fired
    // here would refuse a run neither the lattice nor the verifier constrains.
    const calendars = [{ courtId: "c1", hours: [{ weekday: 1, openMin: 540, closeMin: 1020 }], exceptions: [] }];

    expect(() => guardNoUsableCourtWindows(["c1"], calendars, range, {}, ctx)).not.toThrow();
  });

  it("passes when only SOME days of a multi-day run are closed", () => {
    // A single dark day is not a zero-slot lattice — the event still runs on
    // the others, and refusing the whole schedule over one closed Sunday would
    // be a lock-out with no fix.
    const monOnly = [{ courtId: "c1", hours: [{ weekday: 1, openMin: 540, closeMin: 1020 }], exceptions: [] }];

    expect(() =>
      guardNoUsableCourtWindows(["c1"], monOnly, { from: "2026-08-01", to: "2026-08-05" }, { tz: "UTC" }, ctx),
    ).not.toThrow();
  });
});

describe("guardNoMatchingCourt", () => {
  it("throws HttpError 422 NO_MATCHING_COURT, carrying required tags + candidate count, when candidates are empty", () => {
    let caught: unknown;
    try {
      guardNoMatchingCourt([], { requiredTags: ["clay", "indoor"], divisionId: "div-1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(422);
    expect(err.code).toBe(NO_MATCHING_COURT_CODE);
    expect(err.extra?.requiredTags).toEqual(["clay", "indoor"]);
    expect(err.extra?.candidateCount).toBe(0);
  });

  it("does not throw when at least one candidate court exists", () => {
    expect(() => guardNoMatchingCourt(["court-1"], { requiredTags: [], divisionId: "div-1" })).not.toThrow();
  });
});

describe.skipIf(!HAS_DB)("resolveCandidateCourts (DB-backed)", () => {
  async function seedOrgWithCourts(): Promise<{
    orgId: string;
    taggedCourtId: string;
    plainCourtId: string;
    archivedCourtId: string;
  }> {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"CC Org " + suffix}, ${"cc-org-" + suffix})
      returning id`;
    const [{ id: venueId }] = await sql<{ id: string }[]>`
      insert into venues (org_id, name) values (${orgId}, ${"Main"}) returning id`;
    const [{ id: taggedCourtId }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags)
      values (${venueId}, ${orgId}, ${"Clay 1"}, ${sql.array(["clay"])})
      returning id`;
    const [{ id: plainCourtId }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags)
      values (${venueId}, ${orgId}, ${"Hard 1"}, ${sql.array([])})
      returning id`;
    const [{ id: archivedCourtId }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name, tags, archived_at)
      values (${venueId}, ${orgId}, ${"Clay 2 (archived)"}, ${sql.array(["clay"])}, now())
      returning id`;
    return { orgId, taggedCourtId, plainCourtId, archivedCourtId };
  }

  it("filters to the court carrying the required tag, through the SAME engine function build uses", async () => {
    const { orgId, taggedCourtId, plainCourtId } = await seedOrgWithCourts();
    // resolveCandidateCourts reads through the CALLER's own tx (never opens a
    // second withTenant — see the file header on connection-pool nesting), so
    // this test drives it the same way autoSchedule/validateScheduleIn do:
    // inside a withTenant transaction, tenant context already set by it.
    const result = await withTenant(orgId, (tx) =>
      resolveCandidateCourts(tx, "div-1", [taggedCourtId, plainCourtId], ["clay"]),
    );
    expect(result.ids).toEqual([taggedCourtId]);
  });

  it("excludes an archived court even when its tags match, and logs schedule_court_filtered", async () => {
    const { orgId, taggedCourtId, archivedCourtId } = await seedOrgWithCourts();
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    const result = await withTenant(orgId, (tx) =>
      resolveCandidateCourts(tx, "div-42", [taggedCourtId, archivedCourtId], ["clay"]),
    );
    expect(result.ids).toEqual([taggedCourtId]);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "schedule_court_filtered",
        candidates: 1,
        requiredTags: ["clay"],
        divisionId: "div-42",
      }),
      "schedule_court_filtered",
    );
    spy.mockRestore();
  });

  // P9 pass 3b-FIX (item 2, owner ruling): an empty CONFIGURED list means
  // UNCONSTRAINED, not "no courts" — mirrors the existing rule that empty
  // required_court_tags means "any court". A division with no settings row
  // at all (every board before its first PUT) must still be plannable on
  // the org's own courts rather than 422ing NO_MATCHING_COURT outright.
  it("an empty configured list falls back to every org court, then applies the tag filter as usual", async () => {
    const { orgId, taggedCourtId } = await seedOrgWithCourts();
    const result = await withTenant(orgId, (tx) => resolveCandidateCourts(tx, "div-99", [], ["clay"]));
    // taggedCourtId carries "clay" and qualifies; the org's plain (untagged)
    // court is filtered out same as any explicitly-configured court would be;
    // the archived "clay" court must stay excluded too — this is NOT a
    // second, unfiltered copy of the org's courts.
    expect(result.ids).toEqual([taggedCourtId]);
  });

  it("an empty configured list with NO required tags falls back to every non-archived org court", async () => {
    const { orgId, taggedCourtId, plainCourtId } = await seedOrgWithCourts();
    const result = await withTenant(orgId, (tx) => resolveCandidateCourts(tx, "div-98", [], []));
    expect([...result.ids].sort()).toEqual([plainCourtId, taggedCourtId].sort());
  });

  it("an empty configured list AND an org with no courts at all resolves to an empty candidate set", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"CC Org Empty " + suffix}, ${"cc-org-empty-" + suffix})
      returning id`;
    const result = await withTenant(orgId, (tx) => resolveCandidateCourts(tx, "div-100", [], []));
    expect(result.ids).toEqual([]);
  });
});
