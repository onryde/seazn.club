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
});
