// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

export async function courtHoursSuite(): Promise<void> {
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-court-hours-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);

  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  // A pinned instant, arbitrary otherwise — every weekday below is read back
  // with getUTCDay() rather than assumed, and tz is UTC throughout so civil
  // dates and calendar dates always agree.
  const BASE = Date.UTC(2026, 10, 4, 0, 0);

  const minutesOfDay = (iso: string): number => {
    const d = new Date(iso);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  async function makeCourt(name: string): Promise<{ id: string }> {
    const venue = v1data<{ id: string }>(
      await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `${name} Venue ${tag}` }),
    );
    return v1data<{ id: string }>(
      await v1(s, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, "POST", { name }),
    );
  }
  async function putCalendar(
    courtId: string,
    hours: { weekday: number; open_min: number; close_min: number }[],
    exceptions: {
      date: string;
      closed: boolean;
      open_min: number | null;
      close_min: number | null;
    }[] = [],
  ): Promise<void> {
    const res = await v1(s, `/api/v1/orgs/${orgId}/courts/${courtId}/calendar`, "PUT", {
      hours,
      exceptions,
    });
    if (res.status !== 200) {
      throw new Error(`court hours: calendar PUT failed with ${res.status}`);
    }
  }
  async function makeDivision(
    name: string,
    entrantNames: string[],
  ): Promise<{ divisionId: string; entrantIds: string[] }> {
    const comp = v1data<{ id: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}` }),
    );
    const div = v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    const entrants = v1data<{ id: string }[]>(
      await v1(
        s,
        `/api/v1/divisions/${div.id}/entrants`,
        "POST",
        entrantNames.map((n, i) => ({ kind: "individual", display_name: `${n}${tag}`, seed: i + 1 })),
      ),
    );
    return { divisionId: div.id, entrantIds: entrants.map((e) => e.id) };
  }
  async function makeLeagueAndGenerate(
    divisionId: string,
  ): Promise<{ stageId: string; fixtureIds: string[] }> {
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    const generated = v1data<{ fixtures: { id: string }[] }>(
      await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures;
    return { stageId: stage.id, fixtureIds: generated.map((f) => f.id) };
  }
  async function makeLeagueStage(divisionId: string): Promise<{ stageId: string }> {
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    return { stageId: stage.id };
  }
  async function addAdHocFixture(
    stageId: string,
    homeId: string,
    awayId: string,
    roundNo: number,
  ): Promise<string> {
    const added = v1data<{ fixture_id: string }>(
      await v1(s, `/api/v1/stages/${stageId}/fixtures`, "POST", {
        home_entrant_id: homeId,
        away_entrant_id: awayId,
        round_no: roundNo,
      }),
    );
    return added.fixture_id;
  }
  async function putSettings(
    divisionId: string,
    courtIds: string[],
    startAtMs: number,
    sessionWindows: { from: string; to: string }[] = [],
    /** Optional upper bound. Without one `applyWindow` yields `window.to =
     *  Infinity`, and an unbounded universe is its own (pre-existing) edge —
     *  see S5, which needs a bounded run to test the thing it is named for. */
    endAtMs?: number,
  ): Promise<void> {
    await v1(s, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(startAtMs).toISOString(),
        ...(endAtMs !== undefined ? { endAt: new Date(endAtMs).toISOString() } : {}),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtIds,
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows,
      },
    });
  }

  interface AutoRun {
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    metrics?: { placed: number; total: number };
  }

  // ---- S1 + S2: a restrictive-hours court places the whole board inside its
  // window, and /validate agrees afterward (placer/verifier parity). --------
  {
    const court = await makeCourt(`S1 Hours ${tag}`);
    const weekday = new Date(BASE).getUTCDay();
    await putCalendar(court.id, [{ weekday, open_min: 15 * 60, close_min: 20 * 60 }]);
    const { divisionId } = await makeDivision("Court Hours S1", ["Ash", "Bay", "Cy", "Dot"]);
    const { stageId, fixtureIds } = await makeLeagueAndGenerate(divisionId);
    check("court hours S1/S2: 4-entrant round robin generated 6 fixtures", fixtureIds.length === 6);

    await putSettings(divisionId, [court.id], BASE + 9 * HOUR_MS);
    const build = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    const assignments = build?.assignments ?? [];
    const placedInHours = assignments.every((a) => {
      const start = minutesOfDay(a.scheduled_at);
      return start >= 15 * 60 && start + 30 <= 20 * 60;
    });
    check(
      // Assert a NON-ZERO placement count too — zero placements would mean
      // the court read as unusable all day, the opposite failure, and must
      // not pass as "nothing outside hours".
      `court hours S1: every one of 6 fixtures placed inside the court's 15:00-20:00 hours ` +
        `(placed=${build?.metrics?.placed}, total=${assignments.length})`,
      build?.metrics?.placed === 6 && assignments.length === 6 && placedInHours,
    );

    const applied = v1data<{ applied: number }>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
        assignments: assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      }),
    );
    check("court hours S1/S2: the in-hours board applied cleanly", applied?.applied === 6);

    const validated = v1data<{ conflicts: { details?: { kind?: string } }[] }>(
      await v1(s, `/api/v1/divisions/${divisionId}/schedule/validate`, "POST"),
    );
    check(
      "court hours S2: /validate reports ZERO outside_court_hours conflicts for a board that " +
        "never left its court's hours (placer/verifier parity — this is the one a re-fork breaks)",
      !(validated?.conflicts ?? []).some((c) => c.details?.kind === "outside_court_hours"),
    );
  }

  // ---- S3: a closed:true exception is scoped to its OWN date, never its ---
  // weekday. ------------------------------------------------------------
  {
    const court = await makeCourt(`S3 Exception ${tag}`);
    const excMs = BASE + 3 * DAY_MS;
    const weekday = new Date(excMs).getUTCDay();
    await putCalendar(
      court.id,
      [{ weekday, open_min: 9 * 60, close_min: 17 * 60 }],
      [{ date: ymd(excMs), closed: true, open_min: null, close_min: null }],
    );
    const { divisionId } = await makeDivision("Court Hours S3", ["Ash", "Bay"]);
    const { stageId, fixtureIds } = await makeLeagueAndGenerate(divisionId);
    check("court hours S3: 2-entrant round robin generated 1 fixture", fixtureIds.length === 1);

    // Run A: bounded (via sessionWindows) to the excepted date itself — the
    // sole candidate court is closed for the whole bounded run.
    await putSettings(divisionId, [court.id], excMs + 9 * HOUR_MS, [
      { from: new Date(excMs).toISOString(), to: new Date(excMs + DAY_MS).toISOString() },
    ]);
    const runA = await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {
      only_unlocked: false,
    });
    check(
      `court hours S3: a closed:true exception 422s NO_MATCHING_COURT for a run bounded to THAT ` +
        `date, by CODE (status=${runA.status}, code=${runA.json.error?.code})`,
      runA.status === 422 && runA.json.error?.code === "NO_MATCHING_COURT",
    );

    // Run B: the SAME weekday, one week later — no exception there, so the
    // court's normal hours apply and the run schedules normally.
    const nextMs = excMs + 7 * DAY_MS;
    await putSettings(divisionId, [court.id], nextMs + 9 * HOUR_MS, [
      { from: new Date(nextMs).toISOString(), to: new Date(nextMs + DAY_MS).toISOString() },
    ]);
    const runB = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    const runBAssignments = runB?.assignments ?? [];
    check(
      "court hours S3: the SAME weekday one week later (no exception there) schedules normally",
      runB?.metrics?.placed === 1 &&
        runBAssignments.length === 1 &&
        (() => {
          const start = minutesOfDay(runBAssignments[0].scheduled_at);
          return start >= 9 * 60 && start + 30 <= 17 * 60;
        })(),
    );
  }

  // ---- S4: declared hours and the schedule's own session window can have -
  // an EMPTY intersection; the guard 422s NO_MATCHING_COURT by CODE. -------
  {
    const court = await makeCourt(`S4 Session Window ${tag}`);
    const weekday = new Date(BASE).getUTCDay();
    await putCalendar(court.id, [{ weekday, open_min: 15 * 60, close_min: 20 * 60 }]);
    const { divisionId } = await makeDivision("Court Hours S4", ["Ash", "Bay"]);
    const { stageId, fixtureIds } = await makeLeagueAndGenerate(divisionId);
    check("court hours S4: 2-entrant round robin generated 1 fixture", fixtureIds.length === 1);

    await putSettings(divisionId, [court.id], BASE + 9 * HOUR_MS, [
      {
        from: new Date(BASE + 9 * HOUR_MS).toISOString(),
        to: new Date(BASE + 13 * HOUR_MS).toISOString(),
      },
    ]);
    const run = await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {
      only_unlocked: false,
    });
    check(
      `court hours S4: hours 15:00-20:00 vs a 09:00-13:00 session window (empty intersection, the ` +
        `sole court) 422s NO_MATCHING_COURT by CODE (status=${run.status}, code=${run.json.error?.code})`,
      run.status === 422 && run.json.error?.code === "NO_MATCHING_COURT",
    );
  }

  // ---- S5: a court with NO calendar rows is open the full civil day ------
  // (calendars SUBTRACT; omission must never make an org unschedulable). ---
  {
    const court = await makeCourt(`S5 No Calendar ${tag}`);
    // Deliberately no calendar PUT at all — a fresh court starts with zero
    // hours rows.
    const { divisionId } = await makeDivision("Court Hours S5", ["Ash", "Bay", "Cy"]);
    const { stageId, fixtureIds } = await makeLeagueAndGenerate(divisionId);
    check("court hours S5: 3-entrant round robin generated 3 fixtures", fixtureIds.length === 3);

    const startMs = BASE + 5 * HOUR_MS; // 05:00 — outside any conventional business-hours default
    // BOUNDED, and bounded to a WEEK rather than a day. Two reasons, both
    // learned by watching this check fail:
    //   * Without an `endAt` at all, `applyWindow` yields `window.to =
    //     Infinity`. Every other check here is bounded by its court's own
    //     hours; S5 has no calendar by construction, so it would otherwise
    //     measure the unbounded-window edge rather than the calendar rule.
    //   * A 3-entrant round robin is THREE ROUNDS, and round ordering spreads
    //     rounds across days — a two-day window fits only two of them and the
    //     check failed at `placed=2` for a reason that had nothing to do with
    //     court calendars.
    await putSettings(divisionId, [court.id], startMs, [], BASE + 7 * 24 * HOUR_MS);
    const build = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    const assignments = build?.assignments ?? [];
    const earliest = [...assignments].sort(
      (a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at),
    )[0];
    // What S5 asserts, and what it deliberately does NOT.
    //
    // NOT asserted: WHERE in the window the fixtures land. Two separate
    // pre-existing behaviours make any such claim wrong, and both were learned
    // by watching this check fail rather than by reading:
    //   * `applyWindow` sets `window.from` to local MIDNIGHT of the start day,
    //     so the lattice opens there while greedy's cursor opens at
    //     max(startAt, notBefore) — the solver may place EARLIER than the
    //     stated start. DELIBERATE, not a defect: `build-day-gate.test.ts`'s
    //     `dayOpenConfig` states it outright ("config.startAt IS NOT THE
    //     SOLVER'S FLOOR, and that is the whole fixture"), because the earlier
    //     board wins on `dayStartOffsetMinutes`, a rung isStrictlyBetter ranks
    //     and greedy cannot reach. An earlier revision of this comment called
    //     it a defect; flooring the lattice at startAt reds four engine tests
    //     and is now pinned against in build-grid.test.ts.
    //   * Given a week of free slots the solver has no objective preferring
    //     earliness, so it placed these on day 5. That is not a defect at all,
    //     and a test that pinned the instant would be asserting solver taste.
    //
    // What it DOES assert is the regression that actually matters: a court
    // nobody has given hours to must stay FULLY usable. If a phantom default
    // were applied to an uncalendared court, this run would either place fewer
    // than three or 422 NO_MATCHING_COURT through `guardNoUsableCourtWindows` —
    // both of which this check catches, and neither of which depends on which
    // slot the solver happens to like.
    check(
      `court hours S5: a court with NO calendar rows stays fully usable — all three placed, none ` +
        `narrowed away by a phantom default (placed=${build?.metrics?.placed}, ` +
        `first=${earliest?.scheduled_at})`,
      build?.metrics?.placed === 3 &&
        assignments.length === 3 &&
        earliest !== undefined &&
        assignments.every(
          (a) =>
            Date.parse(a.scheduled_at) >= BASE &&
            Date.parse(a.scheduled_at) < BASE + 8 * 24 * HOUR_MS,
        ),
    );
  }

  // ---- S6: a hand-placed (PATCH) fixture outside its court's hours is ----
  // reported by /validate, but the write itself is never refused. ---------
  {
    const court = await makeCourt(`S6 Hand Place ${tag}`);
    const weekday = new Date(BASE).getUTCDay();
    await putCalendar(court.id, [{ weekday, open_min: 15 * 60, close_min: 20 * 60 }]);
    const { divisionId } = await makeDivision("Court Hours S6", ["Ash", "Bay"]);
    const { stageId, fixtureIds } = await makeLeagueAndGenerate(divisionId);
    check("court hours S6: 2-entrant round robin generated 1 fixture", fixtureIds.length === 1);
    const fixtureId = fixtureIds[0];

    // Get it to `scheduled` status first — moveFixture's MOVABLE_STATUS gate
    // refuses to move a timetable for a fixture that was never placed at
    // all — via a normal auto+apply, inside the court's own hours.
    await putSettings(divisionId, [court.id], BASE + 15 * HOUR_MS);
    const build = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    await v1(s, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: (build?.assignments ?? []).map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    });

    // The normal PATCH/move path — not through the solver — straight onto
    // 09:00, outside the court's declared 15:00-20:00.
    const moved = await v1(s, `/api/v1/fixtures/${fixtureId}`, "PATCH", {
      court_id: court.id,
      scheduled_at: new Date(BASE + 9 * HOUR_MS).toISOString(),
    });
    check(
      `court hours S6: hand-placing a fixture outside its court's hours is NOT refused ` +
        `(status=${moved.status})`,
      moved.status === 200,
    );

    // P9.5 review finding 4: the MOVE GATE itself now sees court calendars, so
    // the conflict comes back on the drag's own response — not only from the
    // next /validate. Before this the two surfaces disagreed about the same
    // card: silent here, flagged there.
    // `patchFixture` returns the fixture row WITH a `conflicts` array — it is
    // `moveFixture` that returns the bare array, and this route wraps it.
    const movedConflicts =
      v1data<{ conflicts?: { details?: { kind?: string } }[] }>(moved)?.conflicts ?? [];
    check(
      "court hours S6: the MOVE's own response reports outside_court_hours — the drag gate and " +
        `/validate agree about the same card (conflicts=${movedConflicts.length})`,
      movedConflicts.some((c) => c.details?.kind === "outside_court_hours"),
    );
    const validated = v1data<{
      conflicts: {
        fixture_id: string;
        blocking: boolean;
        details?: { kind?: string; court?: string };
      }[];
    }>(await v1(s, `/api/v1/divisions/${divisionId}/schedule/validate`, "POST"));
    const found = (validated?.conflicts ?? []).find(
      (c) => c.fixture_id === fixtureId && c.details?.kind === "outside_court_hours",
    );
    check(
      "court hours S6: /validate reports outside_court_hours for the hand-placed fixture, and it " +
        "is non-blocking (both halves matter — the P9.5 carve-out)",
      !!found && found.blocking === false && found.details?.court === court.id,
    );
  }

  // ---- S7: two courts with DIFFERENT hours each bind only their own ------
  // fixtures — sized so neither court's capacity alone can hold the board. -
  {
    const courtA = await makeCourt(`S7 Court A ${tag}`);
    const courtB = await makeCourt(`S7 Court B ${tag}`);
    const weekday = new Date(BASE).getUTCDay();
    // 2 slots on A (08:00-09:00), 2 slots on B (14:00-15:00) — 4 total,
    // exactly the fixture count, so BOTH courts are mathematically required
    // regardless of the placer's own tie-breaking.
    await putCalendar(courtA.id, [{ weekday, open_min: 8 * 60, close_min: 9 * 60 }]);
    await putCalendar(courtB.id, [{ weekday, open_min: 14 * 60, close_min: 15 * 60 }]);

    const { divisionId, entrantIds } = await makeDivision("Court Hours S7", [
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
    ]);
    check("court hours S7: 8 entrants created", entrantIds.length === 8);
    const { stageId } = await makeLeagueStage(divisionId);
    const pairs: [number, number][] = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ];
    const fixtureIds: string[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      fixtureIds.push(await addAdHocFixture(stageId, entrantIds[a], entrantIds[b], i + 1));
    }
    check(
      "court hours S7: 4 entrant-disjoint ad-hoc fixtures created (no rest/overlap interference)",
      fixtureIds.length === 4,
    );

    await putSettings(divisionId, [courtA.id, courtB.id], BASE + 6 * HOUR_MS);
    const build = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    const assignments = build?.assignments ?? [];
    const ownHours = assignments.every((a) => {
      const start = minutesOfDay(a.scheduled_at);
      if (a.court_id === courtA.id) return start >= 8 * 60 && start + 30 <= 9 * 60;
      if (a.court_id === courtB.id) return start >= 14 * 60 && start + 30 <= 15 * 60;
      return false; // placed on neither configured court -- itself a failure
    });
    check(
      `court hours S7: two courts with DIFFERENT hours each bind only their own fixtures, and both ` +
        `were required and used (placed=${build?.metrics?.placed}, distinct courts used=` +
        `${new Set(assignments.map((a) => a.court_id)).size})`,
      build?.metrics?.placed === 4 &&
        assignments.length === 4 &&
        ownHours &&
        new Set(assignments.map((a) => a.court_id)).size === 2,
    );
  }

  // ---- S8: a multi-day run resolves each date against ITS OWN weekday's --
  // hours — sized so total capacity exactly equals the fixture count. ------
  {
    const court = await makeCourt(`S8 Multi Day ${tag}`);
    const day0Ms = BASE;
    const day1Ms = BASE + DAY_MS;
    const day2Ms = BASE + 2 * DAY_MS;
    // 2 + 2 + 3 = 7 slots total, exactly the fixture count below: no OTHER
    // feasible split exists, so all three dates are mathematically required,
    // not merely expected from a chronological fill order.
    await putCalendar(court.id, [
      { weekday: new Date(day0Ms).getUTCDay(), open_min: 8 * 60, close_min: 9 * 60 },
      { weekday: new Date(day1Ms).getUTCDay(), open_min: 13 * 60, close_min: 14 * 60 },
      { weekday: new Date(day2Ms).getUTCDay(), open_min: 16 * 60, close_min: 17 * 60 + 30 },
    ]);

    const { divisionId, entrantIds } = await makeDivision("Court Hours S8", [
      "Q0",
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6",
      "Q7",
      "Q8",
      "Q9",
      "Q10",
      "Q11",
      "Q12",
      "Q13",
    ]);
    check("court hours S8: 14 entrants created", entrantIds.length === 14);
    const { stageId } = await makeLeagueStage(divisionId);
    const fixtureIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      fixtureIds.push(
        await addAdHocFixture(stageId, entrantIds[2 * i], entrantIds[2 * i + 1], i + 1),
      );
    }
    check(
      "court hours S8: 7 entrant-disjoint ad-hoc fixtures created (no rest/overlap interference)",
      fixtureIds.length === 7,
    );

    await putSettings(divisionId, [court.id], BASE + 6 * HOUR_MS);
    const build = v1data<AutoRun>(
      await v1(s, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false }),
    );
    const assignments = build?.assignments ?? [];
    const windowsByDate: Record<string, { open: number; close: number }> = {
      [ymd(day0Ms)]: { open: 8 * 60, close: 9 * 60 },
      [ymd(day1Ms)]: { open: 13 * 60, close: 14 * 60 },
      [ymd(day2Ms)]: { open: 16 * 60, close: 17 * 60 + 30 },
    };
    const usedDates = new Set(assignments.map((a) => a.scheduled_at.slice(0, 10)));
    const ownWeekdayHours = assignments.every((a) => {
      const win = windowsByDate[a.scheduled_at.slice(0, 10)];
      if (!win) return false; // landed on a date with no declared hours at all
      const start = minutesOfDay(a.scheduled_at);
      return start >= win.open && start + 30 <= win.close;
    });
    check(
      `court hours S8: a multi-day run resolves each date against its OWN weekday's hours, never ` +
        `one weekday smeared across every date (placed=${build?.metrics?.placed}, dates used=` +
        `${usedDates.size})`,
      build?.metrics?.placed === 7 && assignments.length === 7 && ownWeekdayHours && usedDates.size === 3,
    );
  }
}
