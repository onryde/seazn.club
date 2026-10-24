// v8 (spec 2026-07-13): division settings tab server contracts — logo
// columns round-trip through patch/get (V274), and the format becomes
// immutable once a stage that inherits it has STARTED (W2c X-SR-4: 409
// DIVISION_FORMAT_LOCKED / DIVISION_TABLE_RULES_LOCKED, by stage name; before
// W2c it was "once any stage owns fixtures", 409 FORMAT_LOCKED — which
// `replaceStages` still is), while non-format fields keep patching. Real
// Postgres; skipped without DATABASE_URL (same convention as
// registrations.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
const HAS_DB = !!process.env.DATABASE_URL;

/** `plan` defaults to the Pro this file has always seeded; pass "community" for
 *  the paid-layer gate cases at the bottom, which need an org that genuinely
 *  lacks the key rather than one carrying a staff deny. */
async function seedOwner(plan: "pro" | "community" = "pro"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`v8-${suffix}@test.local`}, 'V8 Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"V8 Org " + suffix}, ${"v8-org-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  for (const variant of ["score", "sets"]) {
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', ${variant}, ${variant},
              ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
              true)
      on conflict do nothing`;
  }
  return {
    orgId,
    via: "session",
    userId,
    role: "owner",
    keyId: null,
  } as AuthCtx;
}

/** A stage STARTS when its first fixture takes an event (W2c X-SR-4's lock; generation alone no longer locks). */
async function startFirstFixture(owner: AuthCtx, stageId: string): Promise<void> {
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} order by id limit 1`;
  expect(f, "the stage has a generated fixture to start").toBeDefined();
  await appendEvent(owner.orgId, f!.id, 0, { type: "core.start", payload: {} });
}

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    name: "V8 Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  return { competition, division };
}

describe.skipIf(!HAS_DB)("division logo columns (V274)", () => {
  it("patch round-trips logo_storage_path and getDivision returns it", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    const patched = await patchDivision(owner, division.id, {
      logo_storage_path: "division-logos/" + division.id + ".png",
    });
    expect(patched.logo_storage_path).toBe("division-logos/" + division.id + ".png");

    const fetched = await getDivision(owner, division.id);
    expect(fetched.logo_storage_path).toBe("division-logos/" + division.id + ".png");
    expect(fetched.logo_url).toBeNull();

    const cleared = await patchDivision(owner, division.id, {
      logo_storage_path: null,
    });
    expect(cleared.logo_storage_path).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("required_court_tags (D5/P8 gap close)", () => {
  it("patch round-trips required_court_tags and getDivision returns it changed", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    // V367's column default — a freshly created division requires no court.
    expect(division.required_court_tags).toEqual([]);

    const patched = await patchDivision(owner, division.id, {
      required_court_tags: ["clay", "indoor"],
    });
    expect(patched.required_court_tags).toEqual(["clay", "indoor"]);

    const fetched = await getDivision(owner, division.id);
    expect(fetched.required_court_tags).toEqual(["clay", "indoor"]);

    // Clearing back to "any court" round-trips too.
    const cleared = await patchDivision(owner, division.id, {
      required_court_tags: [],
    });
    expect(cleared.required_court_tags).toEqual([]);
  });

  it("normalises on write with the SAME helper the courts path uses — trims, lowercases, dedupes", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    const patched = await patchDivision(owner, division.id, {
      required_court_tags: [" Clay ", "clay"],
    });
    expect(patched.required_court_tags).toEqual(["clay"]);

    const fetched = await getDivision(owner, division.id);
    expect(fetched.required_court_tags).toEqual(["clay"]);
  });
});

describe.skipIf(!HAS_DB)("eligibility columns: category/age_min/age_max (V364/RS004)", () => {
  it("a freshly created division has no category/age band set", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    expect(division.category).toBeNull();
    expect(division.age_min).toBeNull();
    expect(division.age_max).toBeNull();
  });

  it("patch round-trips category/age_min/age_max and getDivision returns them", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    const patched = await patchDivision(owner, division.id, {
      category: "womens",
      age_min: 8,
      age_max: 12,
    });
    expect(patched.category).toBe("womens");
    expect(patched.age_min).toBe(8);
    expect(patched.age_max).toBe(12);

    const fetched = await getDivision(owner, division.id);
    expect(fetched.category).toBe("womens");
    expect(fetched.age_min).toBe(8);
    expect(fetched.age_max).toBe(12);

    // Clearing back to "open to everyone" round-trips too.
    const cleared = await patchDivision(owner, division.id, {
      category: null,
      age_min: null,
      age_max: null,
    });
    expect(cleared.category).toBeNull();
    expect(cleared.age_min).toBeNull();
    expect(cleared.age_max).toBeNull();
  });

  it("an age_min-only patch leaves age_max untouched (independent columns)", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_max: 18 });

    const patched = await patchDivision(owner, division.id, { age_min: 6 });
    expect(patched.age_min).toBe(6);
    expect(patched.age_max).toBe(18);
  });

  // RS004 review finding 1 (MAJOR): checkAgeBand (schemas.ts) only compares
  // age_min/age_max when BOTH are in the SAME patch body, so a single-field
  // PATCH used to reach the DB untouched and violate divisions_age_band_check
  // (V364) — surfacing as an unhandled 500 with raw constraint text instead
  // of the documented 422. patchDivision now merges against the stored row
  // before deciding.
  it("an age_min-only patch that would violate the STORED age_max is rejected 422, not a raw DB error", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_max: 18 });

    await expect(patchDivision(owner, division.id, { age_min: 40 })).rejects.toMatchObject({
      status: 422,
    });

    // The rejected patch must not have half-applied.
    const fetched = await getDivision(owner, division.id);
    expect(fetched.age_min).toBeNull();
    expect(fetched.age_max).toBe(18);
  });

  it("an age_max-only patch that would violate the STORED age_min is rejected 422, not a raw DB error", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_min: 40 });

    await expect(patchDivision(owner, division.id, { age_max: 8 })).rejects.toMatchObject({
      status: 422,
    });

    const fetched = await getDivision(owner, division.id);
    expect(fetched.age_min).toBe(40);
    expect(fetched.age_max).toBeNull();
  });

  // Not a red/green case for THIS fix — a lone null already satisfied
  // divisions_age_band_check before this fix (either side null short-
  // circuits the constraint) — but the new merge-and-validate guard reads
  // `patch.age_min !== undefined` specifically (not `??`) so an explicit
  // `null` is never mistaken for "unset, fall back to stored"; pinned here
  // so a future edit to that guard can't silently regress it.
  it("clearing age_min to null is still allowed while age_max stays set", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_min: 10, age_max: 20 });

    const cleared = await patchDivision(owner, division.id, { age_min: null });
    expect(cleared.age_min).toBeNull();
    expect(cleared.age_max).toBe(20);
  });

  // W8/F12. The cutoff pair gets the same merge-and-validate as the age band
  // above, for the same reason: `checkAgeCutoff` (schemas.ts) is a
  // `superRefine` on the request BODY and its `!= null` cannot tell an
  // OMITTED field from an explicit `null`, so `{ age_cutoff_day: null }`
  // against a stored month used to answer 200 and store an orphan half.
  //
  // The HTTP half of this is `settings-registration-bounds.spec.ts`; these
  // cases exercise the OTHER caller shape — `patchDivision` called directly,
  // with no schema parse in front of it, which is what a server action or a
  // script does. That is also the only layer from which the merged
  // day-for-month clause is reachable at all (over /api/v1, any body with
  // both merged halves non-null carried both itself and zod already
  // day-validated it), so the last case here is the only thing in the tree
  // that can kill that clause.
  // One test per merge SIDE, not one test with two assertions: the two sides
  // are separately reachable and a guard that merged only the month against
  // the stored row still satisfies the day case. Mutating per operand needs a
  // distinct test per operand to land on (AGENTS.md failure class 3).
  it("an explicit null on the DAY is rejected 422 against the stored month", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_cutoff_month: 9, age_cutoff_day: 1 });

    await expect(
      patchDivision(owner, division.id, { age_cutoff_day: null }),
    ).rejects.toMatchObject({ status: 422 });

    // The refusal did not half-apply. The guard throws INSIDE the tenant
    // transaction, so this is asserting the rollback, not merely the status.
    const fetched = await getDivision(owner, division.id);
    expect(fetched.age_cutoff_month).toBe(9);
    expect(fetched.age_cutoff_day).toBe(1);
  });

  it("an explicit null on the MONTH is rejected 422 against the stored day", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_cutoff_month: 9, age_cutoff_day: 1 });

    await expect(
      patchDivision(owner, division.id, { age_cutoff_month: null }),
    ).rejects.toMatchObject({ status: 422 });

    const fetched = await getDivision(owner, division.id);
    expect(fetched.age_cutoff_month).toBe(9);
    expect(fetched.age_cutoff_day).toBe(1);
  });

  // The POSITIVE pair for the case above: a guard that refused every patch
  // naming a cutoff field would satisfy it. Clearing BOTH halves is a real
  // organiser edit (back to the 1 January default) and must still land.
  it("clearing BOTH cutoff halves to null is still allowed", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await patchDivision(owner, division.id, { age_cutoff_month: 9, age_cutoff_day: 1 });

    const cleared = await patchDivision(owner, division.id, {
      age_cutoff_month: null,
      age_cutoff_day: null,
    });
    expect(cleared.age_cutoff_month).toBeNull();
    expect(cleared.age_cutoff_day).toBeNull();
  });

  it("an impossible day-for-month is refused even when zod never ran", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // 31 February. `divisions_age_cutoff_check` (V380) caps the day at 31 and
    // says nothing about the month it belongs to, so without the use-case
    // clause this write LANDS — and `ageBandEligibilityIssues` then rolls it
    // into March at read time, shifting eligibility by days with no error.
    await expect(
      patchDivision(owner, division.id, { age_cutoff_month: 2, age_cutoff_day: 31 }),
    ).rejects.toMatchObject({ status: 422 });

    const fetched = await getDivision(owner, division.id);
    expect(fetched.age_cutoff_month).toBeNull();
    expect(fetched.age_cutoff_day).toBeNull();

    // And the boundary the predicate actually turns on: February's own last
    // day is 28 here by design (`DAYS_IN_MONTH`, registration-rules.ts —
    // a cutoff is re-evaluated every season, so 29 February is refused for
    // every year, not just non-leap ones). Without this row, a clause that
    // rejected the whole month would pass the case above.
    const accepted = await patchDivision(owner, division.id, {
      age_cutoff_month: 2,
      age_cutoff_day: 28,
    });
    expect(accepted.age_cutoff_month).toBe(2);
    expect(accepted.age_cutoff_day).toBe(28);
  });
});

// RS007/V380: create-time eligibility columns. The division-creation
// wizard's Eligibility tab used to POST a jsonb `eligibility` array
// CreateDivision never declared, which a non-strict schema silently
// dropped — every wizard-created division shipped with NO restriction at
// all, however the organiser configured the tab. schemas.test.ts pins the
// schema half (the payload is no longer silently stripped); this pins the
// PERSISTENCE half — that createDivision actually WRITES what the schema
// now accepts, into the DB, not just onto the in-memory return value.
describe.skipIf(!HAS_DB)("createDivision persists eligibility columns (RS007 wizard rewire)", () => {
  it("a create naming no eligibility fields still has no restriction (unchanged default)", async () => {
    const owner = await seedOwner();
    const { competition } = await rig(owner);
    const division = await createDivision(owner, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(division.category).toBeNull();
    expect(division.age_min).toBeNull();
    expect(division.age_max).toBeNull();
    expect(division.age_cutoff_month).toBeNull();
    expect(division.age_cutoff_day).toBeNull();
    expect(division.eligibility_note).toBeNull();
    expect(division.youth).toBe(false);
  });

  it("a wizard-shaped create payload PERSISTS its restriction — the RS007 regression", async () => {
    const owner = await seedOwner();
    const { competition } = await rig(owner);
    const division = await createDivision(owner, competition.id, {
      name: "U16 Girls",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      category: "womens",
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
    expect(division.category).toBe("womens");
    expect(division.age_max).toBe(15);
    expect(division.age_cutoff_month).toBe(9);
    expect(division.age_cutoff_day).toBe(1);
    expect(division.eligibility_note).toBe("School-registered students only");

    // Not just the INSERT's own returning row — getDivision re-reads from
    // the table, so this also proves the columns actually landed rather
    // than the in-memory result merely echoing the input back.
    const fetched = await getDivision(owner, division.id);
    expect(fetched.category).toBe("womens");
    expect(fetched.age_max).toBe(15);
    expect(fetched.age_cutoff_month).toBe(9);
    expect(fetched.age_cutoff_day).toBe(1);
    expect(fetched.eligibility_note).toBe("School-registered students only");
  });

  it("derives youth from the create-time age_max — the SAME deriveYouth the PATCH path uses, not a second copy", async () => {
    const owner = await seedOwner();
    const { competition } = await rig(owner);
    const youthDivision = await createDivision(owner, competition.id, {
      name: "U16",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      age_max: 15,
    });
    expect(youthDivision.youth).toBe(true);

    const adultDivision = await createDivision(owner, competition.id, {
      name: "Open 18+",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      age_max: 99,
    });
    expect(adultDivision.youth).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("format lock (v8)", () => {
  it("variant/config edits work until a stage starts, then 409 DIVISION_FORMAT_LOCKED (X-SR-4; generation alone no longer locks)", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // Pre-fixtures: variant + config change lands (re-validated like create).
    const changed = await patchDivision(owner, division.id, {
      variant_key: "sets",
      config: { points: { w: 2, d: 1, l: 0 } },
    });
    expect(changed.variant_key).toBe("sets");
    expect((changed.config as { points: { w: number } }).points.w).toBe(2);

    // Generate a league schedule → the format is history.
    await createEntrants(owner, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(owner, division.id, {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    });
    await generateStageFixtures(owner, stage!.id);

    // Generated is not started: the variant still changes (the old division-wide lock, narrowed — P-2 "A").
    const back = await patchDivision(owner, division.id, { variant_key: "score" });
    expect(back.variant_key).toBe("score");
    expect(back.refused).toEqual([]);

    // Started: the format is history.
    await startFirstFixture(owner, stage!.id);
    await expect(patchDivision(owner, division.id, { variant_key: "sets" })).rejects.toMatchObject(
      { status: 409, code: "DIVISION_FORMAT_LOCKED", extra: { refused: [{ field: "variant_key", stageName: "L" }] } },
    );
    expect((await getDivision(owner, division.id)).variant_key, "the refused variant was not written").toBe("score");

    // Non-format fields still patch while locked.
    const renamed = await patchDivision(owner, division.id, {
      name: "Open Renamed",
    });
    expect(renamed.name).toBe("Open Renamed");
  });

  it("rejects an unknown variant with 422 (create-time validation reused)", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await expect(patchDivision(owner, division.id, { variant_key: "nope" })).rejects.toMatchObject({
      status: 422,
    });
  });
});

// #431 ruling 3 (2026-08-11): cricket's `pairs-6-a-side` preset was dropped
// from the engine (it only ever shrank the side, never modelled real pairs
// scoring). Nothing NEW guards this — patchDivision's existing variant
// revalidation (above, "rejects an unknown variant") already 422s on any
// unresolvable (sport_key, variant_key) pair. This proves that guarantee
// covers the REAL scenario end to end: a division that was pinned to
// `pairs-6-a-side` before removal must fail loudly on its next save, not
// silently fall back to some default cricket format.
async function seedCricketCatalog(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('cricket', 'Cricket', ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('cricket', 't20', 'T20', ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
}

describe.skipIf(!HAS_DB)("cricket pairs-6-a-side removal (#431 ruling 3)", () => {
  it("a division pinned to the removed variant fails LOUDLY on revalidation — 422, not a silent fallback", async () => {
    const owner = await seedOwner();
    await seedCricketCatalog();
    // Deliberately does NOT seed a `pairs-6-a-side` row: the whole point is
    // that this key resolves to nothing in `sport_variants` any more.
    expect(cricket.variants).not.toHaveProperty("pairs-6-a-side");

    const competition = await createCompetition(owner, {
      name: "Pairs Legacy Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
      starts_on: "2026-10-01",
      ends_on: "2026-10-02",
    });

    // A division row inserted DIRECTLY, bypassing createDivision — simulating
    // one that existed before removal. createDivision itself would now 422 on
    // this variant_key (the same guard this test exercises on patch), so the
    // only way to construct the "pinned before removal" division is a direct
    // insert. Mirrors createDivision's own column list exactly.
    const slug = "pairs-legacy-" + randomUUID().slice(0, 6);
    const staleConfig = {
      playersPerSide: 6,
      ballsPerInnings: 60,
      maxOversPerBowler: 2,
      dls: { enabled: false, edition: "standard" },
    };
    const [division] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                             module_version, tiebreakers, youth)
      values (${competition.id}, 'Pairs Legacy', ${slug}, 'cricket', 'pairs-6-a-side',
              ${sql.json(staleConfig)}, ${cricket.version}, null, false)
      returning id`;

    // A CONFIG-ONLY patch — variant_key is not even in the payload. The guard
    // still fires: patchDivision derives `variantKey = patch.variant_key ??
    // current.variant_key`, so any config-shaped save on a division pinned to
    // a since-removed variant re-triggers the lookup, not just an explicit
    // variant_key change. Asserts the status AND the exact message — a bare
    // `rejects.toThrow()` would pass for any refusal at all, including the
    // wrong one (e.g. FORMAT_LOCKED or ENTRANT_KIND_IN_USE).
    await expect(
      patchDivision(owner, division!.id, {
        config: { ...staleConfig, dls: { enabled: true, edition: "standard" } },
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "unknown variant 'pairs-6-a-side' for cricket",
    });
  });
});

describe.skipIf(!HAS_DB)("replaceStages — format structure swap (v8)", () => {
  it("swaps league → groups+knockout until fixtures exist, then 409 FORMAT_LOCKED", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await createStages(owner, division.id, {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    });

    // Pre-fixtures: the whole structure swaps in one call.
    const swapped = await replaceStages(owner, division.id, [
      {
        seq: 1,
        kind: "group",
        name: "Group stage",
        config: { legs: 1, pools: { count: 2 } },
        progression: null,
      },
      {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        // F2: was `.qualification` (auto-seed-on-complete) — "on_complete"
        // reproduces that behaviour exactly.
        progression: {
          sources: [
            {
              stage: "previous",
              take: [
                {
                  kind: "picks",
                  picks: [
                    { pool: "A", rank: 1 },
                    { pool: "B", rank: 1 },
                  ],
                },
              ],
            },
          ],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    expect(swapped.map((s) => s.kind)).toEqual(["group", "knockout"]);

    // Generate fixtures on the new structure → structure is history too.
    await createEntrants(owner, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    await generateStageFixtures(owner, swapped[0]!.id);

    await expect(
      replaceStages(owner, division.id, [
        { seq: 1, kind: "league", name: "L", config: {}, progression: null },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
  });
});

// F2b (P7 follow-up, 2026-08-14), narrowed by W2c X-SR-4 (owner P-2 "A", 2026-10-13).
// `replaceStages`' FORMAT_LOCKED is still division-WIDE
//   select 1 from fixtures f join stages s on s.id = f.stage_id
//   where s.division_id = $1 limit 1
// — generating stage 1's fixtures freezes the stage graph, untouched later
// stages included (spec §4.3: W2c leaves that door alone, and the first half
// of the test below keeps pinning it). `patchDivision` used to run the
// identical check; it no longer does. It refuses a field only while a STARTED
// stage that inherits it exists, and names that stage (division-locks.test.ts
// holds the full table; this block is the F2b regression home for the pair).
describe.skipIf(!HAS_DB)(
  "F2b — replaceStages stays division-wide; patchDivision narrowed to started inheriting stages (W2c X-SR-4)",
  () => {
    it("generating stage 1's fixtures 409s a later, untouched stage's replaceStages, but locks patchDivision only once a stage STARTS — and then names it, never the untouched stage", async () => {
      const owner = await seedOwner();
      const { division } = await rig(owner);

      const stages = await createStages(owner, division.id, [
        { seq: 1, kind: "league", name: "L1", config: {}, progression: null },
        { seq: 2, kind: "league", name: "L2 (never played)", config: {}, progression: null },
      ]);
      const stage1 = stages.find((s) => s.seq === 1)!;
      const stage2 = stages.find((s) => s.seq === 2)!;

      await createEntrants(owner, division.id, [
        { kind: "individual", display_name: "A", seed: 1, members: [] },
        { kind: "individual", display_name: "B", seed: 2, members: [] },
      ]);
      // Only stage 1 ever gets fixtures — stage 2 stays completely untouched.
      await generateStageFixtures(owner, stage1.id);
      const [{ count: stage2Fixtures }] = await sql<{ count: string }[]>`
        select count(*)::text from fixtures where stage_id = ${stage2.id}`;
      expect(Number(stage2Fixtures)).toBe(0);

      // replaceStages on the whole graph — including the untouched stage 2 — 409s.
      await expect(
        replaceStages(owner, division.id, [
          { seq: 1, kind: "league", name: "L1", config: {}, progression: null },
          { seq: 2, kind: "knockout", name: "L2 changed", config: {}, progression: null },
        ]),
      ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });

      // patchDivision: generation alone no longer locks the division's format.
      const generated = await patchDivision(owner, division.id, { variant_key: "sets" });
      expect(generated.variant_key).toBe("sets");
      expect(generated.refused).toEqual([]);

      // Stage 1 starts: the format is locked on stage 1's account, by its name.
      // Stage 2 has no fixtures at all and is never the one named.
      await startFirstFixture(owner, stage1.id);
      await expect(patchDivision(owner, division.id, { variant_key: "score" })).rejects.toMatchObject({
        status: 409,
        code: "DIVISION_FORMAT_LOCKED",
        extra: { refused: [{ field: "variant_key", stageId: stage1.id, stageName: "L1" }] },
      });
    });
  },
);

describe.skipIf(!HAS_DB)("entrant-kind guard (spec 2026-07-18)", () => {
  it("blocks narrowing kinds that would orphan an active entrant, allows it once withdrawn", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // Generic sport declares no entrant model → every kind is accepted, so a
    // team entrant lands. Narrowing to individual-only would strand it.
    const [team] = await createEntrants(owner, division.id, [
      { kind: "team", display_name: "Team A", seed: 1, members: [] },
    ]);

    // The settings UI sends the FULL stored config plus the override (the
    // sport schema alone may not parse a bare preset) — mirror that here.
    const storedConfig = (await getDivision(owner, division.id)).config as Record<string, unknown>;
    const narrowed = {
      ...storedConfig,
      entrants: { kinds: ["individual"], defaultKind: "individual" },
    };

    await expect(patchDivision(owner, division.id, { config: narrowed })).rejects.toMatchObject({
      status: 422,
      code: "ENTRANT_KIND_IN_USE",
    });

    // Withdraw the team → the same narrowing now lands, and the override sticks.
    await sql`update entrants set status = 'withdrawn' where id = ${team!.id}`;
    const patched = await patchDivision(owner, division.id, {
      config: narrowed,
    });
    expect((patched.config as { entrants?: { kinds: string[] } }).entrants?.kinds).toEqual([
      "individual",
    ]);
  });
});

describe.skipIf(!HAS_DB)(
  "entrants-only config PATCH bypasses the format lock (spec 2026-07-18)",
  () => {
    it("allows an entrants-only change while locked; a real config field in the same save is refused by name, and 409s when nothing else is left (X-SR-4)", async () => {
      const owner = await seedOwner();
      const { division } = await rig(owner);

      // Lock the format: entrants + a league stage + generated fixtures, and
      // (X-SR-4: generation alone no longer locks) its first fixture STARTED.
      await createEntrants(owner, division.id, [
        { kind: "individual", display_name: "A", seed: 1, members: [] },
        { kind: "individual", display_name: "B", seed: 2, members: [] },
      ]);
      const [stage] = await createStages(owner, division.id, {
        seq: 1,
        kind: "league",
        name: "L",
        config: {},
      });
      await generateStageFixtures(owner, stage!.id);
      await startFirstFixture(owner, stage!.id);

      // The settings UI sends the FULL stored config plus the override, so mirror
      // that: base off the stored snapshot and set only `entrants`.
      const storedConfig = (await getDivision(owner, division.id)).config as Record<
        string,
        unknown
      >;

      // (a) Entrants-only change lands even though the format is locked.
      const patched = await patchDivision(owner, division.id, {
        config: {
          ...storedConfig,
          entrants: {
            kinds: ["individual", "team"],
            defaultKind: "individual",
            squadNumbers: true,
            captain: true,
          },
        },
      });
      const savedEntrants = (
        patched.config as {
          entrants?: { kinds: string[]; captain?: boolean };
        }
      ).entrants;
      expect(savedEntrants?.kinds).toEqual(["individual", "team"]);
      expect(savedEntrants?.captain).toBe(true);

      // (b) Entrants change PLUS a real config field (points, a TABLE rule): the
      // entrants part still lands; points is refused BY NAME and stays as stored.
      const mixed = await patchDivision(owner, division.id, {
        config: {
          ...storedConfig,
          points: { w: 5, d: 5, l: 5 },
          entrants: {
            kinds: ["individual", "team"],
            defaultKind: "individual",
          },
        },
      });
      expect(mixed.refused).toEqual([
        { field: "points", code: "DIVISION_TABLE_RULES_LOCKED", stageId: stage!.id, stageName: "L" },
      ]);
      expect((mixed.config as { points: unknown }).points).toEqual(
        (storedConfig as { points: unknown }).points,
      );
      expect(
        (mixed.config as { entrants?: { captain?: boolean } }).entrants?.captain,
        "the entrants change in the same save was applied",
      ).toBeUndefined();

      // (c) The real field alone (entrants re-sent exactly as stored): nothing is
      // left to apply, so the save is refused outright — 409 with the named code.
      const stored = (await getDivision(owner, division.id)).config as Record<string, unknown>;
      await expect(
        patchDivision(owner, division.id, {
          config: { ...stored, points: { w: 7, d: 7, l: 7 } },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "DIVISION_TABLE_RULES_LOCKED",
        extra: { refused: [{ field: "points", stageName: "L" }] },
      });
    });
  },
);

// ---------------------------------------------------------------------------
// The two paid-layer gates on `patchDivision` (W8 Task 9, finding F21)
// ---------------------------------------------------------------------------

/**
 * W8's second mutation sweep found these two `requireFeature` calls
 * (`divisions.ts`, inside `patchDivision`) had NO test anywhere in the repo
 * that reddened when they stopped throwing: the sweep mutated each to
 * `.catch(() => undefined)` and 117 and 141 tests respectively stayed green
 * across every suite that calls `patchDivision`. `auto_posts` reaches
 * `patchDivision` only from `e2e/news.spec.ts`, which expects 200 on the shared
 * Pro org.
 *
 * `news.auto` is FALSE on `community` in the live matrix, so this is the state
 * a real free org is in — no staff deny needed, and a regression would hand
 * every free org auto-drafted news with no witness.
 *
 * The OTHER gate, `formats.advanced` on `auto_progress`, was RETIRED by the
 * owner's "all stages are free" ruling (2026-10-20, V471): auto-advance is free
 * on every plan. Its case is inverted rather than deleted, so a regression
 * that re-gates auto-advance reds here.
 *
 * Each case carries its POSITIVE pair in the same block: turning the toggle
 * OFF must stay allowed on the very same org (`divisions.ts`' own comment:
 * "turning it off is always allowed — a downgraded org can quiet its toggle"),
 * so a guard that simply refused every write could not satisfy these tests.
 */
describe.skipIf(!HAS_DB)("paid-layer gates on patchDivision (W8 F21)", () => {
  it("lets a Community org turn auto_progress ON (and OFF) without formats.advanced — free since V471", async () => {
    const owner = await seedOwner("community");
    const { division } = await rig(owner);
    // The org really lacks the advanced-formats layer, so the success below is
    // the ruling and not an org that happens to hold the old gate's key.
    expect(await hasFeature(owner.orgId, "formats.advanced")).toBe(false);

    const on = await patchDivision(owner, division.id, { auto_progress: true });
    expect(on.auto_progress).toBe(true);
    expect((await getDivision(owner, division.id)).auto_progress).toBe(true);

    const off = await patchDivision(owner, division.id, { auto_progress: false });
    expect(off.auto_progress).toBe(false);
  });

  it("refuses auto_posts on a Community org with 402 news.auto, while still allowing it OFF", async () => {
    const owner = await seedOwner("community");
    const { division } = await rig(owner);

    await expect(patchDivision(owner, division.id, { auto_posts: true })).rejects.toMatchObject({
      status: 402,
      featureKey: "news.auto",
    });
    expect((await getDivision(owner, division.id)).auto_posts).toBe(false);

    const off = await patchDivision(owner, division.id, { auto_posts: false });
    expect(off.auto_posts).toBe(false);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
