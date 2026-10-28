// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  newSession, check, signIn, tag, smokeDb, divisionSeqs, scheduledCountsByDivision, v1, v1data, setPlan,
} from "../harness.ts";

/**
 * C1 gap A — the JOINT multi-division apply's own round-order wiring, over
 * real HTTP. `scheduleRoundOrderDeltaGateSuite` above proves the same
 * property for the single-fixture PATCH path; `competition-schedule-apply
 * .test.ts` (apps/web unit, DB-gated) already proves the mechanism in
 * isolation. What only smoke can prove is that a real POST against a real
 * running server, through real auth/routing/JSON, actually 409s on the
 * JOINT endpoint specifically — `applyCompetitionSchedule`'s own
 * `verifyConfigFor` calls were structurally unable to see round order at
 * all before this fix (no `tz` ever reached them), a defect the
 * single-fixture path's suite above cannot exercise.
 *
 * WIRE SHAPE TRAP (confirmed against server/api-v1/http.ts and
 * `ApplyCompetitionScheduleResult`'s own doc comment, not assumed): this
 * route's conflicts are the RAW engine `Conflict` shape — camelCase
 * `fixtureId`/`reason`/`direct` — spread onto `error.conflicts` verbatim,
 * NOT the snake_case `ScheduleConflict`/`code`/`blocking` shape the
 * single-fixture PATCH route above uses. A `{code, blocking}` read here
 * would silently see `undefined` on every field and pass or fail for the
 * wrong reason.
 */
export async function competitionScheduleApplyRoundOrderSuite(): Promise<void> {
  const s = newSession();
  const orgId = (await signIn(s, `delivered+dtx_jointroundorder_${tag}@resend.dev`)).org_id;
  // scheduling.multi_division is Pro and above.
  await setPlan(orgId, "pro", s);

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `DTX Joint Round Order ${tag}`,
    }),
  );
  const jointVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `Joint Round Order Venue ${tag}` }),
  );
  const jointCourt1 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${jointVenue.id}/courts`, "POST", { name: "Court 1" }),
  );
  const jointCourt3 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${jointVenue.id}/courts`, "POST", { name: "Court 3" }),
  );

  const T0 = Date.UTC(2026, 10, 9, 9, 0);
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

  async function seedRrDivision(
    name: string,
    entrantNames: string[],
    courtId: string,
  ): Promise<{ id: string; fixtureIds: string[] }> {
    const div = v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    await v1(
      s,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      entrantNames.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
    );
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "L",
        config: {},
      }),
    );
    const gen = v1data<{ fixtures: { id: string }[] }>(
      await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
    );
    await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: at(0),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [courtId],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    });
    return { id: div.id, fixtureIds: gen.fixtures.map((f) => f.id) };
  }

  const alpha = await seedRrDivision("Alpha", ["A", "B", "C", "D"], jointCourt1.id);
  const bravo = await seedRrDivision("Bravo", ["X", "Y", "Z"], jointCourt3.id);
  check(
    "joint round order: Alpha generated a 4-entrant round robin (6 fixtures)",
    alpha.fixtureIds.length === 6,
  );
  check(
    "joint round order: Bravo generated a 3-entrant round robin (3 fixtures)",
    bravo.fixtureIds.length === 3,
  );

  // The violation: swap Alpha's round-1 (first id, generate's own
  // round_no/seq_in_round order) and round-3 (last id) slots — a straight
  // swap of two already-occupied times, so no court/rest conflict rides
  // along to confound the assertion (perEntrantMinRest is 0 above).
  const last = alpha.fixtureIds.length - 1;
  const alphaViolating = alpha.fixtureIds.map((fixture_id, i) => ({
    fixture_id,
    scheduled_at: i === 0 ? at(last * 30) : i === last ? at(0) : at(i * 30),
    court_id: jointCourt1.id,
  }));
  const bravoClean = bravo.fixtureIds.map((fixture_id, i) => ({
    fixture_id,
    scheduled_at: at(i * 30),
    court_id: jointCourt3.id,
  }));

  const seqs1 = await divisionSeqs([alpha.id, bravo.id]);
  const refused = await v1(s, `/api/v1/competitions/${comp.id}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.id, expected_seq: seqs1[alpha.id] ?? 0, assignments: alphaViolating },
      { division_id: bravo.id, expected_seq: seqs1[bravo.id] ?? 0, assignments: bravoClean },
    ],
    // "ai" only — the wire schema (ApplyCompetitionScheduleRequest) rejects
    // "manual" on this route; manual board edits stay on the per-stage
    // endpoint by construction (one division). Confirmed against
    // schemas.ts, not assumed.
    source: "ai",
  });
  // `error.conflicts` is the raw engine shape here — see the file header.
  const refusedConflicts =
    (refused.json.error as { conflicts?: { fixtureId?: string; reason?: string; direct?: boolean }[] } | undefined)
      ?.conflicts ?? [];
  check(
    "joint round order: a joint apply that INTRODUCES a round-order violation is refused (409, reason order, direct/blocking)",
    refused.status === 409 &&
      refusedConflicts.some((c) => c.reason === "order" && c.direct === true),
  );
  const afterRefusal = await scheduledCountsByDivision([alpha.id, bravo.id]);
  check(
    "joint round order: the refused write is ATOMIC — neither division got any slot, including the untouched Bravo",
    (afterRefusal[alpha.id] ?? 0) === 0 && (afterRefusal[bravo.id] ?? 0) === 0,
  );

  // The delta property: a correct joint apply first, then the pre-existing
  // violation planted straight into the rows (the only way to construct one
  // now the gate is live), then a re-apply that must still succeed.
  const alphaClean = alpha.fixtureIds.map((fixture_id, i) => ({
    fixture_id,
    scheduled_at: at(i * 30),
    court_id: jointCourt1.id,
  }));
  const seqs2 = await divisionSeqs([alpha.id, bravo.id]);
  const cleanApply = await v1(s, `/api/v1/competitions/${comp.id}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.id, expected_seq: seqs2[alpha.id] ?? 0, assignments: alphaClean },
      { division_id: bravo.id, expected_seq: seqs2[bravo.id] ?? 0, assignments: bravoClean },
    ],
    source: "ai",
  });
  check("joint round order: a correctly-ordered joint apply succeeds (200)", cleanApply.status === 200);

  const sql = smokeDb();
  try {
    for (const a of alphaViolating) {
      await sql`
        update fixtures set scheduled_at = ${a.scheduled_at}, court_id = ${a.court_id}
        where id = ${a.fixture_id}`;
    }
  } finally {
    await sql.end();
  }

  const seqs3 = await divisionSeqs([alpha.id, bravo.id]);
  const stillApplies = await v1(s, `/api/v1/competitions/${comp.id}/schedule/apply`, "POST", {
    divisions: [
      // Re-asserts the SAME (now-violating) positions for Alpha — a no-op.
      { division_id: alpha.id, expected_seq: seqs3[alpha.id] ?? 0, assignments: alphaViolating },
      { division_id: bravo.id, expected_seq: seqs3[bravo.id] ?? 0, assignments: bravoClean },
    ],
    source: "ai",
  });
  const stillConflicts = v1data<{ conflicts?: { reason?: string }[] }>(stillApplies)?.conflicts ?? [];
  check(
    "joint round order: still applies over a board that ALREADY holds a round-order violation — the delta property",
    stillApplies.status === 200 && stillConflicts.some((c) => c.reason === "order"),
  );

  // C1 final-review — the SAME endpoint, but with a PARTIAL per-division
  // listing: only the moved fixture is named, and the round-robin sibling
  // its new position collides with is left OUT of `assignments` entirely,
  // sitting wherever the clean apply below placed it. The delta gate used
  // to compare `assignments` against itself only (calendar.ts's round-order
  // pair scan, by design) — an unlisted sibling could never be paired
  // against anything, so this exact shape was invisible before the fix
  // this suite is now pinned to. `competition-schedule-apply.test.ts`
  // (apps/web unit, DB-gated) proves the mechanism in isolation; what only
  // smoke can prove is that a real POST against a real running server still
  // refuses it once a PARTIAL listing is in play, not just a full one.
  const seqs4 = await divisionSeqs([alpha.id, bravo.id]);
  const reClean = await v1(s, `/api/v1/competitions/${comp.id}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.id, expected_seq: seqs4[alpha.id] ?? 0, assignments: alphaClean },
      { division_id: bravo.id, expected_seq: seqs4[bravo.id] ?? 0, assignments: bravoClean },
    ],
    source: "ai",
  });
  check("joint round order (partial): re-established a clean baseline (200)", reClean.status === 200);

  const seqs5 = await divisionSeqs([alpha.id]);
  const partial = await v1(s, `/api/v1/competitions/${comp.id}/schedule/apply`, "POST", {
    divisions: [
      {
        division_id: alpha.id,
        expected_seq: seqs5[alpha.id] ?? 0,
        // Round 1's fixture ALONE, pushed a full day past everything —
        // every other Alpha fixture, including round 3's (still at
        // `at(last*30)` from `alphaClean` above), stays right where it is
        // and is never named here.
        assignments: [{ fixture_id: alpha.fixtureIds[0], scheduled_at: at(24 * 60), court_id: jointCourt1.id }],
      },
    ],
    source: "ai",
  });
  const partialConflicts =
    (partial.json.error as { conflicts?: { fixtureId?: string; reason?: string; direct?: boolean }[] } | undefined)
      ?.conflicts ?? [];
  check(
    "joint round order (partial): a PARTIAL apply introducing a violation against an UNLISTED sibling is refused (409, reason order)",
    partial.status === 409 && partialConflicts.some((c) => c.reason === "order"),
  );

  const sql2 = smokeDb();
  try {
    const [row] = await sql2<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${alpha.fixtureIds[0]}`;
    check(
      "joint round order (partial): the refused move wrote nothing — round 1 is still at its clean slot",
      row !== undefined && new Date(row.scheduled_at).toISOString() === at(0),
    );
  } finally {
    await sql2.end();
  }
}
