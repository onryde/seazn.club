// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, ledger, timedFixture, v1, v1data, setPlan } from "../harness.ts";

// ---------------------------------------------------------------------------
// #451 — DLS reads a FIXED 6-ball/10-wicket resource table, so a division whose
// format is not 6-ball/10-wicket must have its overs and wickets converted onto
// the table's own scales before the lookup. Two variants make that visible over
// real HTTP, and neither can be faked by a passing revise:
//
//   A. `hundred` — the OVERS axis. 5-ball overs, so 10 "overs" is 50 balls, not
//      60. Reading them as 6-ball overs inflates both resource percentages and
//      hands the chasing side a target that is simply wrong (86, not 84).
//   B. Six-a-side — the WICKETS axis, and the one that reverses a RESULT.
//      Six players a side means 5 wickets in hand, not 10; scaled wrongly the
//      chase gets a target of 43 and "wins by 1 wicket" a match it actually
//      LOST by 4 runs. The winner is the assertion that matters here — the
//      number is incidental to a published result being wrong.
//      Built on `t20` with `playersPerSide`/`ballsPerInnings`/
//      `maxOversPerBowler` overridden directly in `config`, rather than a
//      named variant: the engine's own `pairs-6-a-side` preset was dropped
//      (#431 ruling 3, 2026-08-11) — it never modelled real pairs scoring
//      either, it was exactly this same shrunk-side/shortened-innings
//      shape, which is why the override reproduces it byte-for-byte.
//
// Nothing paints `revisedTarget` or `targetSource` in the UI yet (#467), so
// both read the fold through `/api/v1/fixtures/{id}/state`. `cricket.revise`
// also takes an optional `target`, which stamps targetSource "manual" and skips
// the DLS maths entirely — every revise below sends `oversPerSide` ONLY, and
// asserts targetSource is "dls", or the suite would prove nothing.
//
// R8 sweep, task G — the `cricket.innings.summary` payloads below
// ({runs, wickets, legalBalls, partial: true}) are already the exact
// key set `cricket.tsx`'s `overSummarySheet.buildPayload` sends for the
// v3 pad's over-by-over lane; `cricketBothLanesSuite` (this file, below)
// pins that shape explicitly and adds the mutual-exclusion coverage this
// suite does not need.
// ---------------------------------------------------------------------------

interface CricketFold {
  entrants: { home: string; away: string };
  revisedTarget: number | null;
  targetSource: "dls" | "manual" | null;
  r1: number | null;
  r2: number | null;
  // Structured since 2026-09-16 (`CricketMargin`: kind + count, never English).
  margin: { kind: string; value?: number } | null;
  outcome: { kind: string; winner?: string; loser?: string; method?: string } | null;
}

/** Resource percentages are doubles; compare on the value, not the printout. */
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

export async function cricketDlsSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+dls_${tag}@resend.dev`);
  // A DLS-computed target is a Pro feature (scoring.ts gates `cricket.revise`
  // without a manual target on `cricket.dls`); smoke's orgs start on community.
  await setPlan(who.org_id, "pro", owner);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `DLS Scales ${tag}`,
      visibility: "private",
    }),
  );
  const dls = { dls: { enabled: true, edition: "standard" } };

  // === A — the overs axis (`hundred`: 100 balls, 5 per over) ================
  const a = await timedFixture(owner, comp.id, {
    name: `Hundred DLS ${tag}`,
    sport_key: "cricket",
    variant_key: "hundred",
    config: dls,
    entrants: [
      { kind: "team", display_name: `Century Kings ${tag}`, seed: 1 },
      { kind: "team", display_name: `Century Queens ${tag}`, seed: 2 },
    ],
  });
  const aLedger = ledger(owner, a.fixtureId);
  const aBatFirst = a.entrantIds[0];
  await aLedger.send("cricket.toss", { wonBy: aBatFirst, elected: "bat" });
  await aLedger.send("core.start", {});
  await aLedger.send("cricket.innings.summary", {
    runs: 150,
    wickets: 0,
    legalBalls: 100,
    partial: true,
  });
  const aRevise = await aLedger.send("cricket.revise", { oversPerSide: 10 });
  check("dls/hundred: a Pro org's DLS revise is accepted over HTTP", aRevise.status === 201);
  const aFold = await aLedger.fold<CricketFold>();
  // The full innings is 100 balls of a 100-ball quota, so R1 is the resource
  // left when 10 five-ball overs remain — 50 balls, NOT 60.
  check(
    "dls/hundred: 10 five-ball overs are read as 50 balls on the table's scale",
    near(aFold.r1, 49.13333333333333) && near(aFold.r2, 27.366666666666667),
  );
  check(
    "dls/hundred: the revised target is the DLS one (84), not the 6-ball misread (86)",
    aFold.revisedTarget === 84 && aFold.targetSource === "dls",
  );

  // === B — the wickets axis (six-a-side ⇒ 5 wickets) =========================
  // The reversal: under the misread the chase reaches a target of 43 and is
  // recorded as the winner; scaled correctly it falls 4 short of 53.
  const b = await timedFixture(owner, comp.id, {
    name: `Pairs DLS ${tag}`,
    sport_key: "cricket",
    variant_key: "t20",
    // Overrides `t20`'s own ballsPerInnings/maxOversPerBowler — `config`
    // always wins over the variant preset (divisions.ts's `{...variant.config,
    // ...input.config}` merge) — and adds playersPerSide, which no shipped
    // variant sets. Reproduces the dropped `pairs-6-a-side` preset's cfg
    // exactly: byte-for-byte the same {playersPerSide, ballsPerInnings,
    // maxOversPerBowler}, t20's leftover `lineupChanges.concussionReplacements`
    // is inert here (this scenario never sends a lineup/concussion event).
    config: { ...dls, playersPerSide: 6, ballsPerInnings: 60, maxOversPerBowler: 2 },
    entrants: [
      { kind: "team", display_name: `Pairs Lions ${tag}`, seed: 1 },
      { kind: "team", display_name: `Pairs Tigers ${tag}`, seed: 2 },
    ],
  });
  const bLedger = ledger(owner, b.fixtureId);
  const bBatFirst = b.entrantIds[0];
  await bLedger.send("cricket.toss", { wonBy: bBatFirst, elected: "bat" });
  await bLedger.send("core.start", {});
  // 60/2 off the full 60-ball quota, then the chase reaches 30/4 off 30 before
  // the interruption cuts the match to 7 overs (42 balls).
  await bLedger.send("cricket.innings.summary", {
    runs: 60,
    wickets: 2,
    legalBalls: 60,
    partial: true,
  });
  await bLedger.send("cricket.innings.summary", {
    runs: 30,
    wickets: 4,
    legalBalls: 30,
    partial: true,
  });
  const bRevise = await bLedger.send("cricket.revise", { oversPerSide: 7 });
  check("dls/pairs: the mid-chase DLS revise is accepted over HTTP", bRevise.status === 201);
  const bRevised = await bLedger.fold<CricketFold>();
  check(
    "dls/pairs: 6 a side is 5 wickets on the 10-wicket table — target 53, not 43",
    bRevised.revisedTarget === 53 && bRevised.targetSource === "dls",
  );
  // Play out the shortened chase: 48 off 42 is short of 53 but past 43.
  await bLedger.send("cricket.innings.summary", {
    runs: 48,
    wickets: 4,
    legalBalls: 42,
    partial: true,
  });
  const bDone = await bLedger.fold<CricketFold>();
  check(
    "dls/pairs: the side that batted first WINS — the misread hands it to the chase",
    bDone.outcome?.kind === "win" &&
      bDone.outcome.winner === bBatFirst &&
      bDone.outcome.loser !== bBatFirst,
  );
  check(
    "dls/pairs: and the published margin is runs, not wickets",
    bDone.margin?.kind === "runs" && bDone.margin.value === 4 && bDone.outcome?.method === "dls",
  );
  // The result the rest of the product reads is the `fixtures.outcome` column,
  // written beside the fold — not the fold cache the checks above read.
  const bRow = v1data<{ status: string; outcome: { winner?: string } | null }>(
    await v1(owner, `/api/v1/fixtures/${b.fixtureId}/state`),
  );
  check(
    "dls/pairs: the decided fixture row carries the same winner",
    bRow.status === "decided" && bRow.outcome?.winner === bBatFirst,
  );
}
