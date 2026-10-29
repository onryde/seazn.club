import { builtinModules } from "@seazn/engine/sports";
import { DECISIVE_METHODS, DRAWN_METHODS } from "@seazn/engine/sports/boardgame";
import { BO1_MATCH_TIEBREAK, setTargetBelowFloor } from "@seazn/engine/sport";
import type { EngineErrorCode } from "@seazn/engine/core";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, type V1Res, newSession, call, check, setPlan, signIn, tag, timedFixture, v1, v1data } from "../harness.ts";

/**
 * Format matrix W2e (spec 2026-10-28) — PR B's smoke proof: the write path's new refusals, over real HTTP against a live
 * server, each next to the legal event the SAME ledger then takes (a refusal that refuses everything proves nothing).
 *
 *  - X-SE-1 / D13: a badminton black card ends the match; the next rally is 422 ENDING_SANCTION_PENDING, and the device
 *    link's forfeit is 403 unless it is the ending of the side's own sanction (the other side and the wrong reason), then 201.
 *  - TN-SS-1: a tennis set summary no set can reach (8-6) is 422 SET_SCORE_UNREACHABLE.
 *  - CK-CH-1: a cricket chase total past the winning run is 422 CHASE_OVERSHOOT.
 *  - BG-RS-1: a board-game result whose method contradicts its winner is 422 RESULT_METHOD_CONTRADICTS_WINNER, both ways.
 *  - CA-AD-1: a carrom adjustment past `gameTo` is 422 ADJUST_OUT_OF_RANGE.
 *  - VB-CF-1 / TN-CF-1: the division write door answers 422 CONFIG_INVALID carrying the ENGINE's sentence (a set target
 *    below ruling 31's floor; a best of 1 with a match tie-break), and the same create with a legal config is taken.
 *  - D11 (b): a level public table serves `rank: null` on the public route and the organiser's, and a counted result
 *    brings numbered ranks back.
 *
 * Where each expected value comes from: the codes are the engine's `EngineErrorCode` names; the sentences are the engine's
 * exports; the ending level, the method lists and `gameTo` are the modules' own declarations; the floor (5), the chase
 * bound (target 18, largest total 24 = 18 - 1 + 7, RBS:433) and the unreachable set (8-6, ITF App VI) are the rulebooks'.
 * Own fresh Pro owner (a device link is a Pro feature); needs DATABASE_URL (the plan flip). Every check is counted, and a
 * run that checked nothing fails. SMOKE_ONLY=w2eRefusals runs it alone (SELECTABLE_SUITES).
 */
export async function w2eRefusalsSuite(): Promise<void> {
  // 3 (badminton: the pending ending, the scorer's 403, the scorer's 201) + 4 (one per remaining code: the unreachable set, the
  // chase overshoot, the contradicting method, the adjustment) + 2 (CONFIG_INVALID, the two sentences) + 2 (rank null on a
  // level table, numbered ranks once a result counts).
  const EXPECTED_CHECKS = 11;
  let checked = 0;
  const w2eCheck = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w2e_${tag}@resend.dev`);
  await setPlan(who.org_id, "pro", owner);
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2e Refusals ${tag}` }),
  );

  // --- the rig: an event sender for a session (the organiser's cookie) or a device link (its Bearer, no cookie) ---------
  type Hdrs = Record<string, string>;
  const tipOf = async (s: Session, fixtureId: string, headers: Hdrs = {}): Promise<number> =>
    v1data<{ last_seq: number } | undefined>(await v1(s, `/api/v1/fixtures/${fixtureId}/state`, "GET", undefined, headers))?.last_seq ?? -1;
  /** One event at the ledger's current tip. A refused write leaves the tip where it was; the caller asserts it. */
  const sendAs = async (s: Session, headers: Hdrs, fixtureId: string, type: string, payload: unknown): Promise<V1Res> =>
    v1(s, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: await tipOf(s, fixtureId, headers), type, payload }, headers);
  const send = (fixtureId: string, type: string, payload: unknown) => sendAs(owner, {}, fixtureId, type, payload);
  const tip = (fixtureId: string) => tipOf(owner, fixtureId);
  const codeOf = (r: V1Res): string | undefined => r.json.error?.code;
  /** The wire's 422 for an engine code. Typed on the engine's own code list, so a misspelt or retired code is a compile error. */
  const refusedWith = (r: V1Res, code: EngineErrorCode): boolean => r.status === 422 && codeOf(r) === code;
  const issuesOf = (r: V1Res): string[] =>
    ((r.json.error as { issues?: { message: string }[] } | undefined)?.issues ?? []).map((i) => i.message);

  type Fx = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  /** A started two-entrant division with one fixture, and which entrant sits where. */
  const scene = async (name: string, sport_key: string, variant_key: string, kind: "individual" | "team") => {
    const made = await timedFixture(owner, comp.id, {
      name: `${name} ${tag}`,
      sport_key,
      variant_key,
      entrants: ["P", "Q"].map((n, i) => ({ kind, display_name: `${n} ${name} ${tag}`, seed: i + 1 })),
    });
    const fixtures = v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${made.divisionId}/fixtures`)) ?? [];
    const fx = fixtures.find((f) => f.id === made.fixtureId);
    return { ...made, home: fx?.home_entrant_id ?? "", away: fx?.away_entrant_id ?? "" };
  };
  const moduleOf = (key: string) => builtinModules.find((m) => m.key === key);

  // === 1-3. X-SE-1 and D13: a black card ends a badminton match ===========================================================
  const decl = moduleOf("badminton")?.sanctionEnding;
  const endLevel = decl?.endLevels[0] ?? "";
  const bd = await scene("W2e Badminton", "badminton", "bwf", "individual");
  const bdSetup = [
    (await send(bd.fixtureId, "core.start", {})).status,
    (await send(bd.fixtureId, "badminton.rally", { wonBy: bd.home })).status,
    (await send(bd.fixtureId, decl?.eventType ?? "badminton.sanction", { by: bd.away, level: endLevel })).status,
  ];
  const tipAtCard = await tip(bd.fixtureId);
  const pending = await send(bd.fixtureId, "badminton.rally", { wonBy: bd.home });
  w2eCheck(
    "w2e X-SE-1: a rally after a black card is 422 ENDING_SANCTION_PENDING, and nothing is written" +
      (refusedWith(pending, "ENDING_SANCTION_PENDING") ? "" : ` — got ${pending.status} ${JSON.stringify(pending.json.error)}`),
    decl !== undefined && endLevel !== "" && bdSetup.every((s) => s === 201) && refusedWith(pending, "ENDING_SANCTION_PENDING") &&
      (await tip(bd.fixtureId)) === tipAtCard,
  );

  // D13: the court phone (a device link) may record the ending of the side's own black card, and nothing else.
  const minted = await v1(owner, `/api/v1/fixtures/${bd.fixtureId}/device-links`, "POST", { label: "W2e court" });
  const secret = v1data<{ secret?: string } | undefined>(minted)?.secret ?? "";
  const scorerSession = newSession(); // no cookie: the token is the credential
  const scorerHeaders = { Authorization: `Bearer ${secret}` };
  const scorer = (type: string, payload: unknown) => sendAs(scorerSession, scorerHeaders, bd.fixtureId, type, payload);
  const otherSide = await scorer("core.forfeit", { by: bd.home, reason: "disqualified" });
  const wrongReason = await scorer("core.forfeit", { by: bd.away, reason: "retired" });
  w2eCheck(
    "w2e D13: the device link's forfeit is 403 FORBIDDEN against the other side and with the wrong reason, and nothing is written" +
      (otherSide.status === 403 && wrongReason.status === 403 ? "" : ` — got ${otherSide.status} and ${wrongReason.status}`),
    minted.status === 201 && secret.startsWith("dl_") &&
      otherSide.status === 403 && codeOf(otherSide) === "FORBIDDEN" &&
      wrongReason.status === 403 && codeOf(wrongReason) === "FORBIDDEN" &&
      (await tip(bd.fixtureId)) === tipAtCard,
  );
  const ending = await scorer("core.forfeit", { by: bd.away, reason: "disqualified" });
  const ended = v1data<{ status?: string } | undefined>(ending);
  w2eCheck(
    "w2e D13: the same link's forfeit{disqualified} against the sanctioned side is 201, and the match is forfeited" +
      (ending.status === 201 ? "" : ` — got ${ending.status} ${JSON.stringify(ending.json.error)}`),
    ending.status === 201 && ended?.status === "forfeited" && (await tip(bd.fixtureId)) === tipAtCard + 1,
  );

  // === 4. SC-S1 / TN-SS-1: a tennis set summary no set can reach =========================================================
  // ITF App VI: with the tie-break at 6-all, 8-6 cannot be a final score; 6-4 can.
  const tn = await scene("W2e Tennis", "tennis", "tour", "individual");
  const tnStart = await send(tn.fixtureId, "core.start", {});
  const tipTn = await tip(tn.fixtureId);
  const unreachable = await send(tn.fixtureId, "tennis.set_summary", { home: 8, away: 6 });
  const tipAfterTn = await tip(tn.fixtureId);
  const reachable = await send(tn.fixtureId, "tennis.set_summary", { home: 6, away: 4 });
  w2eCheck(
    "w2e TN-SS-1: a tennis set summary of 8-6 is 422 SET_SCORE_UNREACHABLE and writes nothing; 6-4 lands on the same ledger" +
      (refusedWith(unreachable, "SET_SCORE_UNREACHABLE") ? "" : ` — got ${unreachable.status} ${JSON.stringify(unreachable.json.error)}`),
    tnStart.status === 201 && refusedWith(unreachable, "SET_SCORE_UNREACHABLE") && tipAfterTn === tipTn && reachable.status === 201,
  );

  // === 5. CK-CH-1: a cricket chase total past the winning run ============================================================
  // A first innings of 17 makes the target 18; a no-ball hit for six off the last needed run is the most a delivery adds
  // (ICC T20 WC 2026 Playing Conditions 16.5, RBS:433), so the chase may not total more than 18 - 1 + 7 = 24.
  const ck = await scene("W2e Cricket", "cricket", "t20", "team");
  const ckSetup = [
    (await send(ck.fixtureId, "core.start", {})).status,
    (await send(ck.fixtureId, "cricket.innings.summary", { runs: 17, wickets: 10, legalBalls: 60 })).status,
  ];
  const tipCk = await tip(ck.fixtureId);
  const overshoot = await send(ck.fixtureId, "cricket.innings.summary", { runs: 25, wickets: 2, legalBalls: 30 });
  const tipAfterCk = await tip(ck.fixtureId);
  const atBound = await send(ck.fixtureId, "cricket.innings.summary", { runs: 24, wickets: 2, legalBalls: 30 });
  w2eCheck(
    "w2e CK-CH-1: a chase total of 25 against a target of 18 is 422 CHASE_OVERSHOOT and writes nothing; 24 lands on the same ledger" +
      (refusedWith(overshoot, "CHASE_OVERSHOOT") ? "" : ` — setup ${ckSetup.join()}, got ${overshoot.status} ${JSON.stringify(overshoot.json.error)}`),
    ckSetup.every((s) => s === 201) && refusedWith(overshoot, "CHASE_OVERSHOOT") && tipAfterCk === tipCk && atBound.status === 201,
  );

  // === 6. BG-RS-1: a board-game result whose method contradicts its winner ================================================
  // FIDE Laws Arts. 5 and 9: checkmate needs a winner, stalemate needs none. The two lists are the module's own.
  const decisiveOnly = DECISIVE_METHODS.find((m) => !(DRAWN_METHODS as readonly string[]).includes(m)) ?? "";
  const drawnOnly = DRAWN_METHODS.find((m) => !(DECISIVE_METHODS as readonly string[]).includes(m)) ?? "";
  const bg = await scene("W2e Chess", "boardgame", "classical", "individual");
  const bgStart = await send(bg.fixtureId, "core.start", {});
  const tipBg = await tip(bg.fixtureId);
  const winByDrawMethod = await send(bg.fixtureId, "boardgame.result", { winner: bg.home, method: drawnOnly });
  const drawByWinMethod = await send(bg.fixtureId, "boardgame.result", { winner: null, method: decisiveOnly });
  const tipAfterBg = await tip(bg.fixtureId);
  const agreeing = await send(bg.fixtureId, "boardgame.result", { winner: bg.home, method: decisiveOnly });
  w2eCheck(
    `w2e BG-RS-1: a win by ${drawnOnly} and a draw by ${decisiveOnly} are each 422 RESULT_METHOD_CONTRADICTS_WINNER and write nothing; a win by ${decisiveOnly} lands`,
    decisiveOnly !== "" && drawnOnly !== "" && bgStart.status === 201 &&
      refusedWith(winByDrawMethod, "RESULT_METHOD_CONTRADICTS_WINNER") &&
      refusedWith(drawByWinMethod, "RESULT_METHOD_CONTRADICTS_WINNER") &&
      tipAfterBg === tipBg && agreeing.status === 201,
  );

  // === 7. CA-AD-1: a carrom adjustment past the points needed to win the game ============================================
  const carrom = moduleOf("carrom");
  const gameTo = (carrom?.configSchema.parse((carrom.variants as Record<string, unknown>).icf) as { gameTo?: number } | undefined)?.gameTo ?? 0;
  const cr = await scene("W2e Carrom", "carrom", "icf", "individual");
  const crStart = await send(cr.fixtureId, "core.start", {});
  const tipCr = await tip(cr.fixtureId);
  const tooBig = await send(cr.fixtureId, "carrom.game.adjust", { entrantId: cr.home, delta: gameTo + 1, reason: "foul" });
  const tipAfterCr = await tip(cr.fixtureId);
  const inRange = await send(cr.fixtureId, "carrom.game.adjust", { entrantId: cr.home, delta: 1, reason: "foul" });
  w2eCheck(
    `w2e CA-AD-1: an adjustment of +${gameTo + 1} (gameTo ${gameTo}) is 422 ADJUST_OUT_OF_RANGE and writes nothing; +1 lands on the same ledger` +
      (refusedWith(tooBig, "ADJUST_OUT_OF_RANGE") ? "" : ` — got ${tooBig.status} ${JSON.stringify(tooBig.json.error)}`),
    gameTo > 0 && crStart.status === 201 && refusedWith(tooBig, "ADJUST_OUT_OF_RANGE") && tipAfterCr === tipCr && inRange.status === 201,
  );

  // === 8-9. E15: the division write door answers CONFIG_INVALID with the engine's sentence ================================
  const createDivision = (body: Record<string, unknown>) => v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", body);
  // Ruling 31: a volleyball set is played to at least 5 points.
  const FLOOR = 5;
  const belowFloor = await createDivision({ name: `W2e Low Set ${tag}`, sport_key: "volleyball", variant_key: "indoor", config: { setTo: FLOOR - 1 } });
  const atFloor = await createDivision({ name: `W2e Five Set ${tag}`, sport_key: "volleyball", variant_key: "indoor", config: { setTo: FLOOR, finalSetTo: FLOOR } });
  w2eCheck(
    `w2e VB-CF-1: a volleyball division with setTo ${FLOOR - 1} is 422 CONFIG_INVALID carrying the engine's floor sentence; setTo ${FLOOR} is created` +
      (belowFloor.status === 422 ? "" : ` — got ${belowFloor.status} ${JSON.stringify(belowFloor.json.error)}`),
    belowFloor.status === 422 && codeOf(belowFloor) === "CONFIG_INVALID" && issuesOf(belowFloor).includes(setTargetBelowFloor(FLOOR)) &&
      atFloor.status === 201,
  );
  // ITF App VI: a match tie-break replaces the deciding set, so a best of 1 has none.
  const bestOf1 = await createDivision({ name: `W2e Bo1 Mtb ${tag}`, sport_key: "tennis", variant_key: "tour", config: { bestOf: 1, finalSet: { matchTiebreakTo: 10 } } });
  const bestOf3 = await createDivision({ name: `W2e Bo3 Mtb ${tag}`, sport_key: "tennis", variant_key: "tour", config: { bestOf: 3, finalSet: { matchTiebreakTo: 10 } } });
  w2eCheck(
    "w2e TN-CF-1: a tennis division of best of 1 with a match tie-break is 422 CONFIG_INVALID carrying the engine's sentence; best of 3 with one is created" +
      (bestOf1.status === 422 ? "" : ` — got ${bestOf1.status} ${JSON.stringify(bestOf1.json.error)}`),
    bestOf1.status === 422 && codeOf(bestOf1) === "CONFIG_INVALID" && issuesOf(bestOf1).includes(BO1_MATCH_TIEBREAK) && bestOf3.status === 201,
  );

  // === 10-11. D11 (b): rank null while a table is level ==================================================================
  // Three generic entrants, a league generated and not yet played: the generate wrote the stage's LEVEL table. The suite's
  // competition is public by default, so the anonymous public route serves it.
  const gdiv = v1data<{ id: string; slug: string }>(
    await createDivision({ name: `W2e Level ${tag}`, sport_key: "generic", variant_key: "score", config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } } }),
  );
  const gEntrants = v1data<{ id: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${gdiv.id}/entrants`, "POST", ["A", "B", "C"].map((n, i) => ({ kind: "individual", display_name: `${n} ${tag} level`, seed: i + 1 }))),
  ) ?? [];
  const gStage = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${gdiv.id}/stages`, "POST", { seq: 1, kind: "league", name: "Level" }));
  const generated = v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${gStage.id}/generate`, "POST"))?.fixtures ?? [];
  type Row = { entrantId: string; rank?: number | null; level?: boolean };
  const organiserRows = async () => v1data<{ rows?: Row[] } | undefined>(await v1(owner, `/api/v1/stages/${gStage.id}/standings`))?.rows ?? [];
  const orgSlug = ((await call(owner, "/api/orgs")) as { id: string; slug: string }[]).find((o) => o.id === who.org_id)?.slug ?? "";
  const publicRows = async () => {
    const r = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/divisions/${gdiv.slug}/standings`);
    const data = (r.json as { data?: { standings?: { stage_id: string; rows: Row[] }[] } } | null)?.data;
    return data?.standings?.find((st) => st.stage_id === gStage.id)?.rows ?? [];
  };
  /** The public read is cached (its data window): a bounded poll, its reads counted, never a fixed sleep. */
  const publicSettled = async (ready: (rows: readonly Row[]) => boolean) => {
    let rows = await publicRows();
    let reads = 1;
    for (; reads < 45 && !ready(rows); reads++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rows = await publicRows();
    }
    return { rows, reads };
  };
  const allLevelNull = (rows: readonly Row[]) => rows.length === 3 && rows.every((r) => r.level === true && r.rank === null);
  const levelPublic = await publicSettled(allLevelNull);
  const levelOrganiser = await organiserRows();
  w2eCheck(
    `w2e D11 (b): a level table serves rank null on every row — the public route (read ${levelPublic.reads}×) and the organiser's` +
      (allLevelNull(levelPublic.rows) && allLevelNull(levelOrganiser) ? "" : ` — public ${JSON.stringify(levelPublic.rows)}, organiser ${JSON.stringify(levelOrganiser)}`),
    gEntrants.length === 3 && generated.length === 3 && allLevelNull(levelPublic.rows) && allLevelNull(levelOrganiser),
  );

  // The positive pair: one counted result and the table is no longer level - every row is numbered again.
  const started = await v1(owner, `/api/v1/divisions/${gdiv.id}/start`, "POST");
  const gFixtures = v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${gdiv.id}/fixtures`)) ?? [];
  const first = gFixtures[0];
  const scored = first === undefined ? 0 : (await send(first.id, "generic.result", { p1Score: 2, p2Score: 1 })).status;
  const numbered = (rows: readonly Row[]) => rows.length === 3 && rows.every((r) => r.level !== true && typeof r.rank === "number");
  const countedPublic = await publicSettled(numbered);
  const countedOrganiser = await organiserRows();
  w2eCheck(
    `w2e D11 (b): once a result counts, the same table is numbered again on both routes (public read ${countedPublic.reads}×)` +
      (numbered(countedPublic.rows) && numbered(countedOrganiser) ? "" : ` — start ${started.status}, result ${scored}, public ${JSON.stringify(countedPublic.rows)}, organiser ${JSON.stringify(countedOrganiser)}`),
    started.status < 300 && scored === 201 && numbered(countedPublic.rows) && numbered(countedOrganiser),
  );

  check(`w2e: the refusals suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
