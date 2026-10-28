// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, ledger, timedFixture, v1, v1data } from "../harness.ts";

/**
 * R8 sweep, task G — cricket's two scoring lanes exactly as the v3 pad
 * drives them: ball-by-ball (`cricket.ball`, tier 3/"scoring.ball_by_ball" —
 * cricket.tsx's `basePayload`/`runPayload`, {over, ballInOver, striker,
 * nonStriker, bowler, runs:{bat}, boundary?}) and over-by-over
 * (`cricket.innings.summary` with `partial:true`, tier 0/always free —
 * cricket.tsx's `overSummarySheet.buildPayload`, {runs, wickets, legalBalls,
 * partial:true}, CUMULATIVE totals, never a per-over delta on the wire).
 * Existing coverage already sends these exact key sets
 * (`cricketSuperOverSuite`'s `cricket.ball`, smoke-sports.ts ~1073;
 * `cricketDlsSuite`'s `cricket.innings.summary`, smoke.ts ~5657) but neither
 * states the pin nor proves the reason two fixtures are needed: the two
 * lanes are MUTUALLY EXCLUSIVE per innings — `cricket.ts`'s `cricket.ball`
 * and `cricket.innings.summary` apply() arms both key off `innings.fine`,
 * set once by whichever event opens the innings — so this drives TWO
 * fixtures, one per lane, and then proves the exclusion itself: the lane
 * NOT chosen for an innings is refused on it, not merely untried.
 *
 * KNOWN LIMIT (fix round 1, review) — the payload literals below are
 * HAND-COPIED from `cricket.tsx`'s `basePayload`/`runPayload`/
 * `overSummarySheet.buildPayload`, confirmed to match by direct reading at
 * the time this was written, not by import: `scripts/smoke.ts` runs under
 * plain `node --experimental-strip-types` and cannot import a `"use
 * client"` React `.tsx` component. A future key rename in `cricket.tsx`
 * (e.g. `legalBalls` → something else) leaves this suite green — it is
 * indistinguishable from any other hand-typed API-shape smoke check. That
 * regression is owned elsewhere: `cricket.tsx`'s own builder unit tests
 * (whichever asserts `overSummarySheet`/`basePayload`'s return shape) and
 * the WS-H/I e2e (which drives the real rendered pad through the browser)
 * are what would actually catch it — this suite is not, and cannot be
 * made, a substitute for either.
 */
export async function cricketBothLanesSuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Cricket Lanes ${tag}`,
    }),
  );

  interface RawFold {
    innings: { runs: number; wickets: number; legalBalls: number; fine: unknown }[];
  }

  // ---- Lane 1: ball-by-ball (`cricket.ball`) — a real 2-a-side roster, the
  // same shape `cricketSuperOverSuite` (smoke-sports.ts) already proves
  // works: no wicket falls anywhere below, so 2 players/side is enough. ----
  const names = [`Lanes A1 ${tag}`, `Lanes A2 ${tag}`, `Lanes B1 ${tag}`, `Lanes B2 ${tag}`];
  const personIds: Record<string, string> = {};
  for (const full_name of names) {
    personIds[full_name] = v1data<{ id: string }>(
      await v1(admin, "/api/v1/persons", "POST", { full_name }),
    ).id;
  }
  const [a1, a2, b1, b2] = names as [string, string, string, string];

  const ball = await timedFixture(admin, comp.id, {
    name: "Ball by ball",
    sport_key: "cricket",
    variant_key: "t20",
    entrants: [
      {
        kind: "team",
        display_name: `Lanes A ${tag}`,
        seed: 1,
        members: [a1, a2].map((n) => ({ person_id: personIds[n] })),
      },
      {
        kind: "team",
        display_name: `Lanes B ${tag}`,
        seed: 2,
        members: [b1, b2].map((n) => ({ person_id: personIds[n] })),
      },
    ],
  });
  await v1(admin, `/api/v1/fixtures/${ball.fixtureId}/lineups/${ball.entrantIds[0]}`, "PUT", {
    slots: [a1, a2].map((n, i) => ({ person_id: personIds[n], order_no: i + 1 })),
  });
  await v1(admin, `/api/v1/fixtures/${ball.fixtureId}/lineups/${ball.entrantIds[1]}`, "PUT", {
    slots: [b1, b2].map((n, i) => ({ person_id: personIds[n], order_no: i + 1 })),
  });
  const ballLedger = ledger(admin, ball.fixtureId);
  // No toss → battingFirst defaults to home (cricketSuperOverSuite's own
  // documented convention, cricket.ts).
  const ballStarted = await ballLedger.send("core.start", {});
  check(
    "cricket lanes: core.start on the ball-by-ball fixture accepted (201)",
    ballStarted.status === 201,
  );

  const delivery1 = await ballLedger.send("cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker: personIds[a1],
    nonStriker: personIds[a2],
    bowler: personIds[b1],
    runs: { bat: 4 },
    boundary: 4,
  });
  check(
    "cricket lanes: ball-by-ball delivery 1 (a boundary four) accepted (201)",
    delivery1.status === 201,
  );
  const delivery2 = await ballLedger.send("cricket.ball", {
    over: 0,
    ballInOver: 2,
    striker: personIds[a1],
    nonStriker: personIds[a2],
    bowler: personIds[b1],
    runs: { bat: 1 },
  });
  check("cricket lanes: ball-by-ball delivery 2 accepted (201)", delivery2.status === 201);

  const ballFold = await ballLedger.fold<RawFold>();
  check(
    "cricket lanes: the ball-by-ball fold reflects both deliveries — 5 runs off 2 legal balls, ledger opened FINE",
    ballFold.innings[0]?.runs === 5 &&
      ballFold.innings[0]?.legalBalls === 2 &&
      ballFold.innings[0]?.fine !== null,
  );

  // Mode lock: this innings opened FINE — an over-by-over summary on the
  // SAME innings must now be refused, not silently accepted as a second lane.
  //
  // Fix round 1 (review) — the values here used to be {runs:999, wickets:0,
  // legalBalls:999, partial:true}: legalBalls:999 exceeds t20's own
  // ballsLimit (120), so `applySummary`'s STRICT "legalBalls exceed the
  // innings quota" check (cricket.ts ~1519-1524) would refuse that payload
  // on its own even with the mode-lock guard (cricket.ts ~1485-1487)
  // deleted — the probe passed without ever exercising the guard it names.
  // {runs:6, wickets:0, legalBalls:6} is legal on every OTHER check this
  // innings could hit — clears the monotone floor (current 5/0/2), clears
  // all-out (wickets 0), clears the ball quota (6 << 120) — so the
  // mode-lock guard is the ONLY possible refuser. Mutation-verified
  // (2026-09-02): neutering cricket.ts's `open.innings.fine !== null` check
  // for `cricket.innings.summary` turns this exact assertion red (the
  // payload is then accepted, 201) and nothing else in this suite moves;
  // restored before committing.
  const crossToSummary = await ballLedger.send("cricket.innings.summary", {
    runs: 6,
    wickets: 0,
    legalBalls: 6,
    partial: true,
  });
  check(
    "cricket lanes: cricket.innings.summary on a FINE-opened innings is refused — the lanes are mutually exclusive per innings",
    crossToSummary.status === 422,
  );

  // ---- Lane 2: over-by-over (`cricket.innings.summary`, partial:true) — a
  // SEPARATE fixture, precisely because lane 1's innings is already
  // fine-locked above. ----
  const coarse = await timedFixture(admin, comp.id, {
    name: "Over by over",
    sport_key: "cricket",
    variant_key: "t20",
    entrants: [
      { kind: "team", display_name: `Lanes C ${tag}`, seed: 1 },
      { kind: "team", display_name: `Lanes D ${tag}`, seed: 2 },
    ],
  });
  const coarseLedger = ledger(admin, coarse.fixtureId);
  const coarseStarted = await coarseLedger.send("core.start", {});
  check(
    "cricket lanes: core.start on the over-by-over fixture accepted (201)",
    coarseStarted.status === 201,
  );

  // Two progressive summaries — cumulative totals, exactly the shape
  // `overSummarySheet.buildPayload` sends per over (runs/wickets/legalBalls
  // are the running total, never a per-over delta on the wire).
  const summary1 = await coarseLedger.send("cricket.innings.summary", {
    runs: 8,
    wickets: 0,
    legalBalls: 6,
    partial: true,
  });
  check("cricket lanes: over-by-over summary 1 (over 1, 8/0) accepted (201)", summary1.status === 201);
  const summary2 = await coarseLedger.send("cricket.innings.summary", {
    runs: 15,
    wickets: 1,
    legalBalls: 12,
    partial: true,
  });
  check(
    "cricket lanes: over-by-over summary 2 (over 2, cumulative 15/1) accepted (201)",
    summary2.status === 201,
  );

  const coarseFold = await coarseLedger.fold<RawFold>();
  check(
    "cricket lanes: the over-by-over fold reflects the cumulative totals — 15/1 off 12 balls, ledger opened COARSE",
    coarseFold.innings[0]?.runs === 15 &&
      coarseFold.innings[0]?.wickets === 1 &&
      coarseFold.innings[0]?.legalBalls === 12 &&
      coarseFold.innings[0]?.fine === null,
  );

  // Mode lock, the other direction: this innings opened COARSE — a
  // ball-by-ball delivery on the SAME innings must now be refused too. The
  // striker/nonStriker/bowler ids belong to the OTHER fixture's roster —
  // that's fine here: the fidelity-mode guard fires before any lineup
  // membership check (cricket.ts's `cricket.ball` apply() arm reads
  // `innings.fine` first, ahead of `applyDelivery`'s own on-pitch checks).
  //
  // Fix round 1 (review) — unlike `crossToSummary` above, this probe is
  // DOUBLE-GUARDED by construction, not by accident: `cricket.ts`'s
  // `cricket.ball` apply() switch-case checks `open.innings.fine === null`
  // BEFORE calling `applyDelivery`, which then re-checks the identical
  // `fine === null` condition itself as its own first statement (belt and
  // braces — `applyDelivery` has a second caller, the super-over path,
  // that does not go through the switch-case guard). Deleting either ONE
  // of those two checks alone leaves this exact assertion green (the other
  // still refuses it), so this probe cannot witness the removal of a
  // single guard the way `crossToSummary` now can — it only reds if BOTH
  // are gone at once. Left as-is (not mutation-proved) rather than
  // engineered into a false sense of single-guard sensitivity.
  const crossToBall = await coarseLedger.send("cricket.ball", {
    over: 2,
    ballInOver: 1,
    striker: personIds[a1],
    nonStriker: personIds[a2],
    bowler: personIds[b1],
    runs: { bat: 0 },
  });
  check(
    "cricket lanes: cricket.ball on a COARSE-opened innings is refused — mutual exclusion holds in both directions",
    crossToBall.status === 422,
  );
}
