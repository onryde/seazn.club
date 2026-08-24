// stranded-courts.test.ts — P10 Task 3 (§3 of the design,
// docs/superpowers/specs/bench-product-value/designs/2026-08-24-p10-stranded-
// fixtures-and-capacity-design.md). `strandedCourtIdsForDivision`
// (court-candidates.ts) is the SERVER half of A6 (0a74dbae7, engine commit):
// the engine holds no database handle, so archived/deleted court STATUS has
// to arrive the way court CALENDARS already do, through
// `courtCalendarsForDivision`'s new sibling.
//
// Deliberately NOT the candidate-set complement (ruling 3, candidate-courts.ts
// / court-candidates.ts's `orgCourtMetas` doc comment): a court a tag change
// drops from candidates is still LIVE, and redding its existing assignment is
// exactly what that ruling forbids. Archived-or-absent only — the fourth test
// below pins that negative case directly.
//
// Modelled on `court-candidates.test.ts` (the DB-backed half of the SAME
// module) and `schedule-court-hours.test.ts` (the org/venue/court/division
// seeding chain), rather than invented fresh.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createVenue, createCourt } from "../venues";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { strandedCourtIdsForDivision } from "../court-candidates";

const HAS_DB = !!process.env.DATABASE_URL;

// Same recipe as schedule-court-hours.test.ts's seedOrg(): 'generic'/'score'
// are a GLOBAL catalog (sports/sport_variants are not org-scoped), hence
// `on conflict do nothing` rather than failing when another suite seeded them
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
 *  throughout (via the actual usecases, not raw inserts) because
 *  `strandedCourtIdsForDivision` needs a genuine `courts` row to archive, and
 *  the "fell out of the candidate set" test needs a genuine `divisions` row to
 *  patch `required_court_tags` on. */
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
    name: "Stranded " + randomUUID().slice(0, 6),
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

describe.skipIf(!HAS_DB)("strandedCourtIdsForDivision (DB-backed)", () => {
  it("flags a court archived after the fixture was placed", async () => {
    const { auth, divisionId, courtId } = await seedDivisionWithCourt();
    const result = await withTenant(auth.orgId, async (tx) => {
      await tx`update courts set archived_at = now() where id = ${courtId}`;
      return strandedCourtIdsForDivision(tx, divisionId, [courtId]);
    });
    expect(result).toEqual([courtId]);
  });

  it("flags a court id that no longer exists at all", async () => {
    const { auth, divisionId } = await seedDivisionWithCourt();
    const gone = "00000000-0000-4000-8000-000000000001";
    const result = await withTenant(auth.orgId, (tx) =>
      strandedCourtIdsForDivision(tx, divisionId, [gone]),
    );
    expect(result).toEqual([gone]);
  });

  it("does NOT flag a live court that simply has no calendar rows", async () => {
    // P10 ruling 1: a stranded fixture is one on an archived-or-absent court,
    // never merely "a court with no calendar rows" — that reads as
    // unrestricted everywhere else in this subsystem and must here too.
    const { auth, divisionId, courtId } = await seedDivisionWithCourt();
    const result = await withTenant(auth.orgId, (tx) =>
      strandedCourtIdsForDivision(tx, divisionId, [courtId]),
    );
    expect(result).toEqual([]);
  });

  it("does NOT flag a live court that fell out of the candidate set", async () => {
    // Ruling 3 (candidate-courts.ts): a tag change dropping a court from the
    // CANDIDATE set must not retroactively red its existing assignment, and
    // this resolver must not reproduce that mistake under a different name —
    // it never reads required_court_tags at all (see its own doc comment),
    // so a candidacy change is structurally invisible to it.
    const { auth, divisionId, courtId } = await seedDivisionWithCourt();
    const result = await withTenant(auth.orgId, async (tx) => {
      await tx`update divisions set required_court_tags = array['indoor'] where id = ${divisionId}`;
      return strandedCourtIdsForDivision(tx, divisionId, [courtId]);
    });
    expect(result).toEqual([]);
  });

  it("returns empty for an empty assigned-court set without querying", async () => {
    const { auth, divisionId } = await seedDivisionWithCourt();
    const result = await withTenant(auth.orgId, (tx) =>
      strandedCourtIdsForDivision(tx, divisionId, []),
    );
    expect(result).toEqual([]);
  });
});

// Anti-regression guard (plan Task 3, Step 7) — no DB needed, so this runs
// unconditionally rather than under HAS_DB.
//
// Deviates from the plan's literal text in two ways, both because the plan's
// version does not survive contact with the real file:
//
//  1. Path depth. The plan writes `new URL("./schedule.ts", import.meta.url)`,
//     which assumes this test file lives directly in usecases/. The real tree
//     puts tests in usecases/__tests__/, so the correct relative path is
//     `../schedule.ts` / `../person-merge.ts` — verified below by asserting
//     the read is non-empty and does contain `toVerifyConfig(`, so a wrong
//     path fails LOUDLY (ENOENT) rather than silently reading nothing and
//     passing every assertion vacuously.
//
//  2. Call shape. The plan's guard matches only `toVerifyConfig(` and checks
//     each call's tail for `courtCalendars|CourtCalendars`. Task 3 routes
//     THREE of the five sites (applySchedule, moveFixture, person-merge.ts)
//     through the new `verifyConfigForDivision` instead, so a regex keyed
//     only on `toVerifyConfig(` goes BLIND to those three sites entirely —
//     they stop matching, the loop silently never runs for them, and the
//     guard would report green even if one of those three were rewritten to
//     drop a signal. Fixed by checking BOTH call shapes: every direct
//     `toVerifyConfig(...)` call must name both `courtCalendars` and
//     `strandedCourtIds` in its own argument list, and at least one call site
//     must go through `verifyConfigForDivision` (which always resolves both
//     internally) or "route every site through ONE builder" — this task's own
//     point — silently regressed back to hand assembly everywhere.
// Strips `//` and `/* */` comments so the guard below only ever matches REAL
// call sites. Found necessary empirically, not preemptively: the first draft
// of this guard, run against this very file's own person-merge.ts edit,
// false-failed on a doc comment quoting the OLD four-argument call shape as
// illustrative text — `toVerifyConfig(settings, all, 0, ...)` inside a
// comment is textually indistinguishable from a real call to a naive regex.
// This codebase's own convention is heavy inline doc comments that often
// quote code (every file touched by this task does it), so a guard living
// here without this would go on producing the same false positive for the
// next person who documents a call shape in prose. Naive on string literals
// that themselves contain `//`/`/*` — an accepted approximation, since
// neither file's actual argument lists (identifiers and property accesses
// only) ever contain one.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("verify-config call sites carry both court signals", () => {
  const src = readFileSync(new URL("../schedule.ts", import.meta.url), "utf8");
  const merge = readFileSync(new URL("../person-merge.ts", import.meta.url), "utf8");
  const srcCode = stripComments(src);
  const mergeCode = stripComments(merge);

  // The 9 characters immediately before a matched "name(" are "function "
  // for BOTH `export function toVerifyConfig(` and `export async function
  // verifyConfigForDivision(` — anchoring on the token right before the name
  // survives reformatting of the parameter list that would break a guard
  // matching the definition's full first line verbatim.
  const isDefinitionSite = (file: string, matchIndex: number): boolean =>
    file.slice(matchIndex - 9, matchIndex) === "function ";

  it("sanity: the source files actually resolved (a wrong relative path must fail loudly, not vacuously)", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(merge.length).toBeGreaterThan(1000);
    expect(src).toContain("toVerifyConfig(");
    expect(merge).toContain("verifyConfigForDivision(");
  });

  it("every direct toVerifyConfig(...) call site (excluding its own definition) names both signals", () => {
    let directCalls = 0;
    for (const file of [srcCode, mergeCode]) {
      for (const call of file.matchAll(/\btoVerifyConfig\(/g)) {
        const idx = call.index ?? 0;
        if (file === srcCode && isDefinitionSite(file, idx)) continue; // the definition itself
        directCalls++;
        const tail = file.slice(idx, idx + 400);
        expect(tail).toMatch(/courtCalendars/);
        expect(tail).toMatch(/strandedCourtIds/);
      }
    }
    // autoSchedule, validateScheduleIn, and verifyConfigForDivision's own
    // internal call — if this is 0 the loop above never executed and every
    // expectation inside it was vacuously skipped.
    expect(directCalls).toBeGreaterThan(0);
  });

  it("at least one site is routed through the shared verifyConfigForDivision builder", () => {
    let helperCalls = 0;
    for (const file of [srcCode, mergeCode]) {
      for (const call of file.matchAll(/\bverifyConfigForDivision\(/g)) {
        const idx = call.index ?? 0;
        if (file === srcCode && isDefinitionSite(file, idx)) continue; // the definition itself
        helperCalls++;
      }
    }
    expect(helperCalls).toBeGreaterThan(0);
  });
});
