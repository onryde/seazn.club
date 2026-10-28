// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, check, signIn, tag, ledger, timedFixture, smokeDb, v1, v1data } from "../harness.ts";

// ---------------------------------------------------------------------------
// W4a (#425) — the core time model, end to end over real HTTP.
//
// The engine suites prove the fold; this proves the whole rail carries it: a
// GameTime survives the /api/v1 payload round-trip, `division.config` really
// does reach `apply()` (periodSeconds / sinBinMinutes / subWindows /
// interruptions are all NEW optional cfg keys), the derived `expiresAt` lands
// in the persisted `match_states.state`, and the two new engine codes map to
// 422 through ENGINE_HTTP rather than a 500.
//
// Assertions are written to fail against a broken engine, not merely to
// observe one: every expiry check is paired with the state IMMEDIATELY BEFORE
// it (still running / already gone), because "no suspension in the list" is
// equally true of a suspension that never started.
// ---------------------------------------------------------------------------

/** A GameTime as the pad sends it (core/time.ts §1.1 — elapsed is GAME clock,
 *  counted up from the start of the named period). */
interface Stamp {
  period: string;
  elapsed: number;
}
const stamp = (period: string, elapsed: number): Stamp => ({ period, elapsed });
const sameStamp = (a: Stamp | undefined, b: Stamp): boolean =>
  a !== undefined && a.period === b.period && a.elapsed === b.elapsed;

interface ActiveSuspensionOut {
  side: string;
  classKey: string;
  startedAt?: Stamp;
  expiresAt?: Stamp;
}
interface IceFold {
  phase: string;
  entrants: { home: string; away: string };
  suspensions: ActiveSuspensionOut[];
  asOf?: Stamp;
}
interface SinBinOut {
  person?: string;
  startedAt?: Stamp;
  expiresAt?: Stamp;
}
interface FootballFold {
  entrants: { home: string; away: string };
  squads: {
    home: { onPitch: string[]; bench: string[]; sinBin?: SinBinOut[]; subWindows?: Stamp[] };
    away: { onPitch: string[]; bench: string[]; sinBin?: SinBinOut[]; subWindows?: Stamp[] };
  };
  asOf?: Stamp;
}
interface TableTennisFold {
  entrants: { home: string; away: string };
  setsWon: { home: number; away: number };
  expedite?: boolean;
  expediteUnchecked?: number;
}
interface InterruptionOut {
  kind: string;
  set: number;
  by?: string;
  person?: string;
  duration?: number;
  at?: Stamp;
  overran?: true;
  overCount?: true;
}
interface TennisFold {
  entrants: { home: string; away: string };
  interruptions?: InterruptionOut[];
}

/**
 * W4a (#425) — game-time over HTTP on the four sports that grew a time model.
 *
 * PRO path: the full scenario per sport. FREE path: the same four events on a
 * community org. They used to be Tier-2 scoring and 402'd there; W1
 * (entitlements v18, owner ruling 2026-08-30) made every recording level free,
 * so the free leg now asserts 201 — with a band-0 stamped event accepted
 * alongside, which is what keeps the leg from passing on a door that accepts
 * everything, including events it should still refuse.
 */
export async function w4aTimeModelSuite(admin: Session): Promise<void> {
  // Local-run fallback for the one sport no earlier suite reaches (CI runs
  // sync:sports). tennis/icehockey are seeded by v6SportsSuite, football by
  // disciplineSuite; table tennis has an EMPTY position catalog, which is what
  // its module actually declares, so seeding it here is not a lossy stub.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = smokeDb();
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('tabletennis', 'Table Tennis', '1.0.0',
                     ${db.json({ groups: [], lineup: { size: 1, benchMax: 1 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('tabletennis', 'bo5', 'Best of 5', ${db.json({})}, true)
             on conflict do nothing`;
    await db.end();
  }

  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `W4a Time ${tag}`,
      visibility: "public",
    }),
  );

  // === Ice hockey — IIHF penalty time (§3.1 lazy expiry, §3.2 carry, §3.4 ===
  // === release-on-goal). `periodSeconds` is the new optional cfg key.      ===
  const ice = await timedFixture(admin, comp.id, {
    name: "Ice Time",
    sport_key: "icehockey",
    variant_key: "iihf",
    config: { periodSeconds: { P1: 1200, P2: 1200, P3: 1200, OT: 300 } },
    entrants: [
      { kind: "team", display_name: `Timber Wolves ${tag}`, seed: 1 },
      { kind: "team", display_name: `Frost Giants ${tag}`, seed: 2 },
    ],
  });
  const iceLedger = ledger(admin, ice.fixtureId);
  check("w4a icehockey division accepts the periodSeconds cfg", !!ice.divisionId);
  await iceLedger.send("core.start", {});
  // Entrant sides come from the FOLD, never from entrant creation order — the
  // whole point of the release-on-goal check is which side conceded.
  const iceSides = (await iceLedger.fold<IceFold>()).entrants;
  const home = iceSides.home;
  const away = iceSides.away;

  // (1) A minor at 01:40 runs 2:00 and is swept by the next stamped event.
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 100),
  });
  const iceOpen = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey minor derives expiresAt = start + 2:00",
    iceOpen.suspensions.length === 1 &&
      iceOpen.suspensions[0].side === "away" &&
      sameStamp(iceOpen.suspensions[0].startedAt, stamp("P1", 100)) &&
      sameStamp(iceOpen.suspensions[0].expiresAt, stamp("P1", 220)),
  );
  // A penalty shot AWARDED is the neutral stamped event here: it touches no
  // score and no suspension, so the sweep is the only thing that can move the
  // list. (A goal would confound expiry with release-on-goal.)
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P1", 300) });
  const iceSwept = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey lazy sweep releases the expired minor at the next stamp",
    iceSwept.suspensions.length === 0 && sameStamp(iceSwept.asOf, stamp("P1", 300)),
  );

  // (2) A second minor, ended EARLY by the opposition goal (IIHF Rule 20.4).
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 400),
  });
  const iceSecond = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey second minor is running with 70s still to serve",
    iceSecond.suspensions.length === 1 &&
      sameStamp(iceSecond.suspensions[0].expiresAt, stamp("P1", 520)),
  );
  await iceLedger.send("icehockey.goal", { by: home, kind: "pp", at: stamp("P1", 450) });
  const iceReleased = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey power-play goal at 07:30 ends a minor that ran to 08:40",
    iceReleased.suspensions.length === 0 && sameStamp(iceReleased.asOf, stamp("P1", 450)),
  );

  // (3) THE CROSS-PERIOD CARRY — the defect this wave exists to close. A minor
  // at 19:10 of a 20:00 period owes 70s in P2, not 0 at the buzzer.
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 1150),
  });
  const iceCarry = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey minor at 19:10 carries its remainder into P2 (expiresAt P2 70)",
    iceCarry.suspensions.length === 1 &&
      sameStamp(iceCarry.suspensions[0].expiresAt, stamp("P2", 70)),
  );
  await iceLedger.send("icehockey.period.advance", { to: "P2", at: stamp("P1", 1200) });
  const iceWhistle = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey the P1 whistle does NOT sweep a penalty owed in P2",
    iceWhistle.phase === "P2" &&
      iceWhistle.suspensions.length === 1 &&
      sameStamp(iceWhistle.suspensions[0].expiresAt, stamp("P2", 70)),
  );
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P2", 50) });
  const iceStillShort = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey still 5v4 at P2 00:50, 20 seconds short of the carry",
    iceStillShort.suspensions.length === 1,
  );
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P2", 100) });
  const iceServed = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey the carried remainder is served by P2 01:40",
    iceServed.suspensions.length === 0 && sameStamp(iceServed.asOf, stamp("P2", 100)),
  );

  // === Football — sin bin expiry (§5.2) and Law 3 substitution WINDOWS ===
  const squad: string[] = [];
  for (let i = 1; i <= 7; i++) {
    squad.push(
      v1data<{ id: string }>(
        await v1(admin, "/api/v1/persons", "POST", {
          full_name: `Timed Player ${i} ${tag}`,
          consent: { public_name: true },
        }),
      ).id,
    );
  }
  const foot = await timedFixture(admin, comp.id, {
    name: "Sin Bin League",
    sport_key: "football",
    variant_key: "11-a-side",
    config: { sinBinMinutes: 10, subWindows: 2 },
    entrants: [
      {
        kind: "team",
        display_name: `Bin Rovers ${tag}`,
        seed: 1,
        members: squad.map((id) => ({ person_id: id })),
      },
      { kind: "team", display_name: `Window City ${tag}`, seed: 2 },
    ],
  });
  const roversId = foot.entrantIds[0];
  await v1(admin, `/api/v1/fixtures/${foot.fixtureId}/lineups/${roversId}`, "PUT", {
    slots: squad.map((personId, i) => ({
      person_id: personId,
      slot: i < 3 ? "starting" : "bench",
      position_key: "FW",
      order_no: i + 1,
      roles: [],
    })),
  });
  const footLedger = ledger(admin, foot.fixtureId);
  await footLedger.send("core.start", {});
  const footSides = (await footLedger.fold<FootballFold>()).entrants;
  // The lineup was written for the entrant, so read WHICH side it landed on
  // rather than assuming the generator put seed 1 at home.
  const binSide = footSides.home === roversId ? "home" : "away";
  const otherSide = binSide === "home" ? "away" : "home";
  const opponentId = binSide === "home" ? footSides.away : footSides.home;
  const [p1, p2, p3, p4, p5, p6, p7] = squad as [
    string, string, string, string, string, string, string,
  ];

  await footLedger.send("football.sinbin.start", {
    by: roversId,
    person: p1,
    at: stamp("H1", 600),
  });
  const footBinned = await footLedger.fold<FootballFold>();
  check(
    "w4a football sin bin at 10:00 derives a 10-minute expiry and clears the pitch",
    (footBinned.squads[binSide].sinBin ?? []).length === 1 &&
      sameStamp(footBinned.squads[binSide].sinBin![0].expiresAt, stamp("H1", 1200)) &&
      !footBinned.squads[binSide].onPitch.includes(p1),
  );

  // Two substitutions sharing ONE stamp are ONE window (Law 3).
  await footLedger.send("football.sub", { by: roversId, off: p2, on: p4, at: stamp("H1", 600) });
  await footLedger.send("football.sub", { by: roversId, off: p3, on: p5, at: stamp("H1", 600) });
  const footWindow1 = await footLedger.fold<FootballFold>();
  check(
    "w4a football two subs at one stoppage spend ONE window",
    (footWindow1.squads[binSide].subWindows ?? []).length === 1 &&
      sameStamp(footWindow1.squads[binSide].subWindows![0], stamp("H1", 600)),
  );

  // The boundary: 19:59 is still short, 20:00 is served.
  await footLedger.send("football.goal", { by: opponentId, at: stamp("H1", 1199) });
  const footShort = await footLedger.fold<FootballFold>();
  check(
    "w4a football the binned player is still off the pitch one second early",
    (footShort.squads[binSide].sinBin ?? []).length === 1 &&
      !footShort.squads[binSide].onPitch.includes(p1),
  );
  await footLedger.send("football.goal", { by: opponentId, at: stamp("H1", 1200) });
  const footBack = await footLedger.fold<FootballFold>();
  check(
    "w4a football the bin runs out exactly at 20:00 and returns the player",
    (footBack.squads[binSide].sinBin ?? []).length === 0 &&
      footBack.squads[binSide].onPitch.includes(p1) &&
      footBack.squads[otherSide].onPitch.length === 0,
  );

  await footLedger.send("football.sub", { by: roversId, off: p4, on: p6, at: stamp("H1", 1200) });
  const footWindow2 = await footLedger.fold<FootballFold>();
  check(
    "w4a football a sub at a new stamp opens the second window",
    (footWindow2.squads[binSide].subWindows ?? []).length === 2,
  );
  const seqBeforeRefusal = footLedger.seq;
  const footBlocked = await footLedger.send("football.sub", {
    by: roversId,
    off: p5,
    on: p7,
    at: stamp("H1", 1300),
  });
  check(
    "w4a football a third window is refused with SUB_WINDOW_EXCEEDED (422)",
    footBlocked.status === 422 && footBlocked.json.error?.code === "SUB_WINDOW_EXCEEDED",
  );
  const footAfterRefusal = await footLedger.fold<FootballFold>();
  check(
    "w4a football the refused substitution persisted nothing",
    footLedger.seq === seqBeforeRefusal &&
      (footAfterRefusal.squads[binSide].subWindows ?? []).length === 2 &&
      !footAfterRefusal.squads[binSide].onPitch.includes(p7),
  );

  // === Table tennis — the ITTF expedite system (§5.3, Law 2.15) ===
  const tt = await timedFixture(admin, comp.id, {
    name: "Expedite Open",
    sport_key: "tabletennis",
    variant_key: "bo5",
    entrants: [
      { kind: "individual", display_name: `Ma ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Ovtcharov ${tag}`, seed: 2 },
    ],
  });
  const ttLedger = ledger(admin, tt.fixtureId);
  await ttLedger.send("core.start", {});
  const ttSides = (await ttLedger.fold<TableTennisFold>()).entrants;
  await ttLedger.send("tabletennis.expedite.start", {});
  const ttOn = await ttLedger.fold<TableTennisFold>();
  check("w4a tabletennis the umpire introduces expedite", ttOn.expedite === true);
  // Eleven straight rallies close game 1 — ITTF 2.15.4 runs expedite to the END
  // OF THE MATCH, so banking a game must not clear it.
  for (let i = 0; i < 11; i++) {
    await ttLedger.send("tabletennis.rally", { wonBy: ttSides.home });
  }
  const ttGame1 = await ttLedger.fold<TableTennisFold>();
  check(
    "w4a tabletennis expedite SURVIVES the game it was called in (ITTF 2.15.4)",
    ttGame1.setsWon.home === 1 && ttGame1.expedite === true,
  );
  // Law 2.15.2: the RECEIVER takes the point on their 13th good return.
  const ttLegal = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.away,
    serving: ttSides.home,
    returns: 13,
  });
  check("w4a tabletennis a 13-return rally to the RECEIVER stands", ttLegal.status === 201);
  const ttWrong = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.home,
    serving: ttSides.home,
    returns: 13,
  });
  check(
    "w4a tabletennis the same rally credited to the SERVER is EXPEDITE_WRONG_WINNER (422)",
    ttWrong.status === 422 && ttWrong.json.error?.code === "EXPEDITE_WRONG_WINNER",
  );
  const ttUnchecked = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.home,
    returns: 13,
  });
  const ttAfter = await ttLedger.fold<TableTennisFold>();
  check(
    "w4a tabletennis a 13-return rally with no `serving` stands and is COUNTED as unchecked",
    ttUnchecked.status === 201 && ttAfter.expediteUnchecked === 1 && ttAfter.setsWon.home === 1,
  );

  // === Tennis — Rule 30 interruptions (§5.4). Neither allowance REFUSES: a ===
  // === cfg-derived refusal fires on replay and bricks the fixture.        ===
  const treated = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Treated Player ${tag}`,
      consent: { public_name: true },
    }),
  ).id;
  const ten = await timedFixture(admin, comp.id, {
    name: "MTO Classic",
    sport_key: "tennis",
    variant_key: "tour",
    config: {
      interruptions: { medical: { count: 1, seconds: 180 }, other: { seconds: 60 } },
    },
    entrants: [
      { kind: "individual", display_name: `Alcaraz ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Zverev ${tag}`, seed: 2 },
    ],
  });
  const tenLedger = ledger(admin, ten.fixtureId);
  await tenLedger.send("core.start", {});
  const tenSides = (await tenLedger.fold<TennisFold>()).entrants;
  await tenLedger.send("tennis.interruption", {
    kind: "medical",
    by: tenSides.home,
    person: treated,
    duration: 180,
    at: stamp("S1", 120),
  });
  const tenFirst = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis an MTO is stamped in S1, charged to a side and credited to a player",
    tenFirst.length === 1 &&
      tenFirst[0].kind === "medical" &&
      tenFirst[0].set === 1 &&
      tenFirst[0].by === "home" &&
      tenFirst[0].person === treated &&
      sameStamp(tenFirst[0].at, stamp("S1", 120)) &&
      tenFirst[0].overCount === undefined &&
      tenFirst[0].overran === undefined,
  );
  // The SECOND MTO in the same set is beyond `count: 1`. Shipped rule (§5.4):
  // RECORDED and flagged, never refused — so the 201 is half the assertion.
  const tenSecond = await tenLedger.send("tennis.interruption", {
    kind: "medical",
    by: tenSides.home,
    person: treated,
    duration: 180,
    at: stamp("S1", 600),
  });
  const tenOverCount = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis a second MTO past the allowance is RECORDED with overCount, not refused",
    tenSecond.status === 201 &&
      tenOverCount.length === 2 &&
      tenOverCount[1].overCount === true &&
      tenOverCount[1].overran === undefined,
  );
  // `overran` is the other, independent flag: no count declared for `other`,
  // so a long break trips the duration allowance and nothing else.
  await tenLedger.send("tennis.interruption", {
    kind: "other",
    by: tenSides.away,
    duration: 90,
    at: stamp("S1", 700),
  });
  const tenOverran = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis an over-long break records overran, independently of overCount",
    tenOverran.length === 3 &&
      tenOverran[2].overran === true &&
      tenOverran[2].overCount === undefined,
  );
  // A stamped interruption survives a SET boundary: the fold derives `set` from
  // its own index, so S2 is only legal once set 1 has actually been banked.
  await tenLedger.send("tennis.set_summary", { home: 6, away: 0 });
  await tenLedger.send("tennis.interruption", {
    kind: "toilet",
    by: tenSides.away,
    at: stamp("S2", 60),
  });
  const tenSet2 = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis a toilet break after the set summary is filed in S2, set 2",
    tenSet2.length === 4 &&
      tenSet2[3].kind === "toilet" &&
      tenSet2[3].set === 2 &&
      sameStamp(tenSet2[3].at, stamp("S2", 60)),
  );

  // === FREE path — the W4a time model on a COMMUNITY org. ===
  // Every W4a event sat in fidelityTiers 2/3 behind scoring.match_timeline
  // (period/football) or scoring.rally_by_rally (nested/set-based), and a
  // community org was paywalled out of all of it.
  //
  // W1 (entitlements v18, owner ruling 2026-08-30) ended that: V390 deleted
  // the three fidelity keys from plan_entitlements and the same wave deleted
  // `requiredFeatureForEvent` from `scoreEvent` and the batch importer. Every
  // recording level is free on every plan, so these three tuples — which
  // asserted 402 + a feature_key here through the R6 wave — now assert 201.
  //
  // They are still worth driving, and through the REAL HTTP door rather than
  // the usecase: a gate removed from one of the two write paths and left in
  // the other is exactly the shape this file exists to catch, and a community
  // org posting a sin bin and two interruptions is the only check in the repo
  // that runs the free plan through the live route. The Tier-0 stamped advance
  // further down stays as the CONTROL for the opposite failure: a door that
  // has stopped stamping `at` at all would pass everything above and fail it.
  const free = newSession();
  await signIn(free, `delivered+w4a_free_${tag}@resend.dev`);
  const freeComp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `W4a Free Time ${tag}`,
      visibility: "public",
    }),
  );
  // W1: was `gated`, and the fourth member was the feature_key each tuple
  // expected in the 402 body. It is kept as the key the tuple USED to be
  // paywalled behind, so the check line names what changed rather than
  // asserting a bare 201 nobody can trace back to a ruling.
  const alwaysFree: [string, string, string, string, unknown][] = [];
  const freeIce = await timedFixture(free, freeComp.id, {
    name: "Free Ice",
    sport_key: "icehockey",
    variant_key: "iihf",
    entrants: [
      { kind: "team", display_name: `Free Bears ${tag}`, seed: 1 },
      { kind: "team", display_name: `Free Kings ${tag}`, seed: 2 },
    ],
  });
  const freeFoot = await timedFixture(free, freeComp.id, {
    name: "Free Football",
    sport_key: "football",
    variant_key: "11-a-side",
    entrants: [
      { kind: "team", display_name: `Free Rovers ${tag}`, seed: 1 },
      { kind: "team", display_name: `Free City ${tag}`, seed: 2 },
    ],
  });
  const freeTt = await timedFixture(free, freeComp.id, {
    name: "Free Table Tennis",
    sport_key: "tabletennis",
    variant_key: "bo5",
    entrants: [
      { kind: "individual", display_name: `Free Ma ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Free Ovt ${tag}`, seed: 2 },
    ],
  });
  const freeTen = await timedFixture(free, freeComp.id, {
    name: "Free Tennis",
    sport_key: "tennis",
    variant_key: "tour",
    entrants: [
      { kind: "individual", display_name: `Free Carlos ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Free Sascha ${tag}`, seed: 2 },
    ],
  });
  alwaysFree.push(
    [
      "football sin bin",
      freeFoot.fixtureId,
      "football.sinbin.start",
      "scoring.match_timeline",
      { by: freeFoot.entrantIds[0], at: stamp("H1", 600) },
    ],
    [
      "tabletennis expedite",
      freeTt.fixtureId,
      "tabletennis.expedite.start",
      "scoring.rally_by_rally",
      {},
    ],
    [
      "tennis interruption",
      freeTen.fixtureId,
      "tennis.interruption",
      "scoring.rally_by_rally",
      { kind: "medical", by: freeTen.entrantIds[0], at: stamp("S1", 60) },
    ],
  );
  const freeLedgers = new Map<string, ReturnType<typeof ledger>>();
  // W1: these formerly 402'd with a feature_key; scoring detail is free on
  // every plan. The assertion is 201 AND no error body — a 4xx that stopped
  // carrying `feature_key` would otherwise read as a pass on the status alone.
  for (const [label, fixtureId, type, formerKey, payload] of alwaysFree) {
    const l = ledger(free, fixtureId);
    freeLedgers.set(fixtureId, l);
    await l.send("core.start", {});
    const res = await l.send(type, payload);
    check(
      `w4a free: ${label} records on community (201; formerly 402 ${formerKey})`,
      res.status === 201 && res.json.error === undefined,
    );
  }
  // R6 fix pass 4, finding E (owner ruling, 2026-08-30). This case used to sit
  // in the loop above and assert a 402 + `scoring.match_timeline` feature_key
  // for icehockey.suspension.start; R6 moved suspStart/suspEnd to tier 1 for
  // the period family and it became free ahead of the others. W1 caught the
  // rest up, so it is no longer the exception — kept as its own check because
  // it also reads the FOLD back (the tuples above only read a status), which
  // is what proves the event was recorded rather than merely accepted.
  const freeIceLedger = ledger(free, freeIce.fixtureId);
  freeLedgers.set(freeIce.fixtureId, freeIceLedger);
  await freeIceLedger.send("core.start", {});
  const freeSuspension = await freeIceLedger.send("icehockey.suspension.start", {
    by: freeIce.entrantIds[1],
    class: "minor",
    at: stamp("P1", 100),
  });
  check(
    "w4a free: icehockey suspension.start records on community (201)",
    freeSuspension.status === 201,
  );
  // The control — a Tier-0 event carrying the SAME `at` shape is ALSO free.
  // Reuses the ice ledger above, which now carries `core.start` plus the
  // free suspension.start check just above it.
  const freeAdvance = await freeIceLedger.send("icehockey.period.advance", {
    to: "P2",
    at: stamp("P1", 1200),
  });
  const freeFold = v1data<{ state: IceFold }>(
    await v1(free, `/api/v1/fixtures/${freeIce.fixtureId}/state`),
  ).state;
  check(
    "w4a free: a Tier-0 stamped advance is NOT paywalled and records asOf",
    freeAdvance.status === 201 &&
      freeFold.phase === "P2" &&
      sameStamp(freeFold.asOf, stamp("P1", 1200)),
  );
}
