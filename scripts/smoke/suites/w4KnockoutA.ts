// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, counts, newSession, setPlan, signIn, tag, v1, v1data } from "../harness.ts";
import { buildTemplateStages } from "../../../apps/web/src/lib/format-templates.ts";
import { swissDrawSeed, swissRoundOneOrder } from "../../../apps/web/src/lib/swiss-draw.ts";
import { w4KnockoutAB5PagePlayoffWalkover, w4KnockoutAB5StandaloneRefusal } from "./w4KnockoutA-b5.ts";
import { w4KnockoutAB6aSuite } from "./w4KnockoutA-b6a.ts";
import { w4aDeskK12Check, w4aDeskXch8Check } from "./w4KnockoutA-desk-checks.ts";
import { w4KnockoutAPublicStandingsOrderSmoke } from "./w4KnockoutA-public-checks.ts";

/**
 * Format matrix W4 knockout app-A (spec 2026-11-04-format-matrix-w4-knockout-design.md) — the app PR's smoke proof, over real
 * HTTP against a live server. One counted check per task that owes one, each beside the state it proves.
 *
 * T2 (X-LE-9, K4; owner ruling 257): a Match Day call is a start. A final called to a court keeps both its players when the
 * result of a semi-final that fed it is voided: the void is refused 409 NEXT_MATCH_STARTED and writes nothing.
 *
 * T3 (X-SD-5, K2): a bye is not played, so it never takes a court or a time. A knockout of three Started with rolling times
 * leaves its awarded bye with no time and no court, and the board's move onto it is refused 422 BYE_LINE_NOT_PLACEABLE.
 *
 * T4 (X-RB-1, K3): Rebuild carries a knockout's slots by bracket role. A knockout of eight laid out line by line, then a
 * ninth entrant and a Rebuild: the final still holds the final's court and time (by position it went to a semi-final).
 *
 * T5 (K1): Undo cannot cross a seed confirm. A Main draw of eight played out and completed, its Plate's draft confirmed
 * (the four first-round losers seated): the division's Undo is refused 409 SEED_CONFIRM_NOT_UNDOABLE and the Plate keeps
 * every seat (before T5 it inverted the Plate's day-one generation and deleted the seeded draw).
 *
 * T6 (AN-2, X-CH-7): a bracket completes only with every match decided. A knockout of four with a third-place line, the
 * semis and the final decided, the third-place match unplayed: Complete is refused 409 STAGE_HAS_UNDECIDED_FIXTURES naming
 * that line, the stage stays active; with the third-place match decided the same Complete goes through.
 *
 * T7 (X-SD-7, K5): the unseeded are drawn with the stage's own seed. Six unseeded players registered one at a time: the
 * byes go to the draw's top two (RB4-D2 over `lib/swiss-draw.ts`), never the first two to register by rule, and an Undo then a
 * fresh Generate seats the same bracket.
 *
 * T8 (FX-G2; MB-004/005): Generate over a bracket that already has its lines reconciles it. A seventh player before Start
 * takes a bye in place (RB4-L4: the lowest-seeded holder's — here, all unseeded, the LATER draw position's), nothing is
 * inserted and a second Generate is the no-op; a ninth crosses a power of two, so the bracket is drawn again once — sixteen
 * slots, fifteen lines, one final, every player seated once (main seated the field twice beside a second final).
 *
 * T10 (X-LE-3…X-LE-6, X-LE-13; ruling 263): "Add late player" on a Started knockout. Six seeded in a bracket of eight: the
 * newcomer plays the bye of the LOWEST-seeded holder (seed 2, RB4-L4), and the division's Undo is then refused 409
 * KO_LATE_ENTRY_NOT_UNDOABLE. Eight seeded: no bye and nothing started, so the add is KEPT and answers 201 rebuild_offered
 * (RB4-L6: the player waits, no line moves); once a round-1 player withdraws, the next add takes that seat and the
 * withdrawal's walkover is reversed.
 *
 * T11 (X-LE-10, K13; ruling 271): an AUTOMATIC arrival waits for the organiser's tap. Eight seeded Started, one withdrawn
 * (the walkover) then reinstated through PATCH: the line is unchanged and nothing is placed; the one-tap route
 * (`POST /stages/{id}/late-entrants/{entrantId}/place`) gives them their own seat back, and a second tap is refused 409
 * KO_LATE_ENTRY_NOT_WAITING.
 *
 * T13 (X-LL-1, K9; RB4-V2): a departed qualifier takes a LUCKY LOSER. A qualifying knockout of eight feeding a main draw of
 * four (rankRange 1..4, setup timing), every qualifying line won by its home side, the main draw confirmed: a qualifier
 * withdraws before their first main-draw match, and the best-seeded quarter-final loser takes the seat — the reply names
 * them and the line, nobody is walked over (main walked the opponent over).
 *
 * T14 (X-QM-4, FX-G16, FX-G18): a correction inside a completed qualifying knockout. The same eight into four, confirmed; the
 * final, a semi-final and the quarter-final behind it are taken back: the main draw's seats go back to TBD at that last void
 * and Compute answers SEEDING_SOURCE_INCOMPLETE, no longer ALREADY_CONFIRMED. Re-recorded the other way and replayed, a
 * re-proposal offers the new qualifier and not the old.
 *
 * T15 (X-PL-1, X-QM-2; FX-G14's gate, QM-2): Knockout + Plate on a field of 3 is refused by name at Generate and at Start, and a
 * fourth entrant lets it through. A rank cut of 3 from a knockout is refused at the write and leaves no stage; the cut of 4 is taken.
 *
 * T25 (T8-f; RB4-Q1/Q3/Q6, RB4-S1/S2/S7): the three formats whose final stage is a bracket fed by a stage before it, driven
 * through the builder's own stage drafts (`buildTemplateStages`, the catalogue the builder sends) and played out with
 * UPSETS, so a right answer differs from "the better seed". qualifying_main: three entrants are refused by name at Generate
 * and at Start, eight qualify four (the quarter-final winners, ranked by the qualifying final's own result) who are seated
 * into the main draw rank 1 v 4 and 2 v 3, and the main draw completes the division. group_stepladder (generic, a league of
 * six into a top five): the rungs seat RB4-S1's lowest two seeds first and one climber per rung, and the stage ranks every
 * qualifier once (RB4-R1: a permutation of the five; the sixth finisher in none). group_playoffs
 * (badminton, a league of five into a top four): Q1 = 1 v 2, E = 3 v 4, Q2 = Q1's loser v E's winner, Final = Q1's winner
 * v Q2's winner, and the stage ranks the four qualifiers once. In all three a second Complete is a no-op that emits no second
 * `stage_completed`, and the entrant that did not qualify is ranked in no finals. Ranks are read from the Complete answer (the
 * one place `finalRanks` crosses the wire) and from the stage's standings, which must cover the same entrants. The rank ORDER of
 * a stepladder or a page playoff is NOT asserted (controller ruling: rank proofs beyond seating are app-B's, carry C19); the
 * qualifying stage's order of the top four IS, because the main draw is seated from it. No withdrawal here: the finals'
 * withdrawals are T17's (check lane B5) and the walkthrough's.
 *
 * The lanes folded at the lane merge (merge-lanes-1, 2026-11-09) keep their checks in their own files and are counted
 * here by the harness checks each one made (`laneChecks`): B-desk's T18 (K12: a disqualification walkover says so, 6)
 * and T21 (X-CH-8: a decided final asks to complete its stage, completing the competition warns, 6), B6b's T23 (ST-G26:
 * /present reads a group's pools in order, 4), B5's T16 (X-SP-6: a standalone stepladder or page playoff is refused
 * by name, 2) and T17 (X-SP-5: a page-playoff withdrawal walks over, never voids, 1), and — folded at merge 2 — B6a's
 * T19 (X-LE-10, K13: a Reinstate answers `waiting` and the tap names the player's own seat; a played-on Reinstate is
 * `refused` and marks nobody; 2, plus that lane's own count check, 3).
 *
 * Own fresh owner; keyless; every read and write is a v1 route (B5's T17 reads the feed edges from the table, which no
 * route publishes; B-desk's and B6b's sign in their own organisers and read pages). Every check is counted, and a run
 * that checked nothing fails. SMOKE_ONLY=w4KnockoutA runs it alone (SELECTABLE_SUITES).
 */
export async function w4KnockoutASuite(): Promise<void> {
  // T2: 1 (a called final survives a void of its feeder). T3: 1 (an awarded bye holds no court). T4: 1 (the final keeps
  // its slot across an 8 → 9 Rebuild). T5: 1 (Undo refuses across a confirmed draw). T6: 1 (Complete refuses a bracket
  // with its third-place match unplayed). T7: 1 (an unseeded draw replays). T8: 2 (6 → 7 places in a bye; 8 → 9 redraws
  // once). T10: 2 (a late player takes the lowest-seeded holder's bye and Undo refuses; no slot keeps the player and offers Rebuild, then a
  // withdrawn seat is taken). T11: 1 (a reinstated player waits, and one tap gives their seat back). T13: 1 (a departed
  // qualifier's seat takes the best loser below the cut). T14: 1 (a correction empties a confirmed draw's seats and re-proposes).
  // T15: 2 (a plate on 3 is refused, then starts on 4; a cut of 3 from a knockout leaves no stage). T25: 3 (qualifying_main
  // eight → four; a league into a stepladder ranks every qualifier; a league into a page playoff seats Q1, E, Q2, Final).
  // The lanes folded at merge-lanes-1, counted by `laneChecks`: T18 6, T21 6, T23 4, T16 2, T17 1, and B6a's T19 3 (2 + its
  // own count) — 22.
  const EXPECTED_CHECKS = 15 + 3 + 22;
  let checked = 0;
  const w4Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };
  /** A lane's exported checks, counted by what they did: every harness `check` the export made (pass or fail) is one of
   *  this suite's. An export that stops early (a premise it could not build) counts fewer, and the total below fails. */
  const laneChecks = async (run: () => Promise<unknown>) => {
    const before = counts();
    await run();
    const after = counts();
    checked += after.pass + after.fail - (before.pass + before.fail);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w4a_${tag}@resend.dev`);
  const orgId = who.org_id;
  // Pro, as the registration loop's owner is: this suite seats eight divisions on its first competition and runs five
  // competitions (its two, B5's three), past Community's 4 divisions per competition and 3 active competitions — the
  // fifth division answered 402 and every check after it read `undefined` (first local run, merge 2, 2026-11-09).
  // Nothing checked here is plan-gated.
  await setPlan(orgId, "pro", owner);
  const venueId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `W4a Venue ${tag}` }),
  )?.id;
  const courts: string[] = [];
  for (const name of ["Court 1", "Court 2"]) {
    const court = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/orgs/${orgId}/venues/${venueId}/courts`, "POST", { name }),
    );
    if (court) courts.push(court.id);
  }
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout A ${tag}`, visibility: "private" }),
  );

  type Fx = {
    id: string;
    stage_id: string;
    round_no: number;
    seq_in_round: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    scheduled_at: string | null;
    court_id: string | null;
    status?: string;
  };

  /** A badminton knockout of `n` seeded entrants on its own division, generated and Started — with `settings` (the
   *  division's schedule settings) saved first when given, so Start writes its rolling times. `start: false` stops after
   *  Generate (a pre-Start board). */
  async function startedKnockout(s: Session, label: string, n: number, settings?: Record<string, unknown>, start = true) {
    const divId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: label,
        sport_key: "badminton",
        variant_key: "bwf",
        config: {},
      }),
    )?.id;
    await v1(
      s,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `${label} P${i + 1} ${tag}`, seed: i + 1 })),
    );
    const stageId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: label, config: {} }),
    )?.id;
    if (settings) await v1(s, `/api/v1/divisions/${divId}/schedule-settings`, "PUT", { tz: "UTC", config: settings });
    const generated = await v1(s, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = start ? (await v1(s, `/api/v1/divisions/${divId}/start`, "POST")).status : null;
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(s, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    return { divId, stageId, generated: generated.status, started, fixtures };
  }

  /** The scorer wins `fixtureId` for the home side, two games to love; returns the deciding event's id. */
  async function homeWins(s: Session, fixtureId: string): Promise<string | undefined> {
    await appendScoreEvent(s, fixtureId, "core.start", {});
    await appendScoreEvent(s, fixtureId, "badminton.game.summary", { home: 21, away: 10 });
    const last = await appendScoreEvent(s, fixtureId, "badminton.game.summary", { home: 21, away: 12 });
    return v1data<{ event_id?: string } | undefined>(last)?.event_id;
  }

  // Check 1 (T2, X-LE-9; ruling 257): both semi-finals decided, the final called to Court 1 through Match Day's own route
  // (no score event, no status), then the first semi-final's deciding event voided. The take-back reads a called final as
  // started, so the void is refused 409 NEXT_MATCH_STARTED, the final keeps both its players, and it is still on Court 1.
  // Expected seats are the ones read BEFORE the void; the code under test supplies none of them.
  {
    const ko = await startedKnockout(owner, "Called final", 4);
    const rows = await ko.fixtures();
    const r1 = rows.filter((f) => f.round_no === 1);
    const deciderA = r1[0] ? await homeWins(owner, r1[0].id) : undefined;
    if (r1[1]) await homeWins(owner, r1[1].id);
    const final = (await ko.fixtures()).find((f) => f.round_no === 2);
    const called = final ? await v1(owner, `/api/v1/fixtures/${final.id}/call`, "POST", { court_id: courts[0] }) : undefined;
    const seatsBefore = final ? `${final.home_entrant_id ?? "-"}|${final.away_entrant_id ?? "-"}` : "";
    const tip = r1[0] ? v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${r1[0].id}/state`)).last_seq : -1;
    const voided =
      r1[0] && deciderA
        ? await v1(owner, `/api/v1/fixtures/${r1[0].id}/events`, "POST", {
            expected_seq: tip,
            type: "core.void",
            payload: { event_id: deciderA },
          })
        : undefined;
    const tipAfter = r1[0] ? v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${r1[0].id}/state`)).last_seq : -2;
    const finalAfter = (await ko.fixtures()).find((f) => f.id === final?.id);
    const seatsAfter = finalAfter ? `${finalAfter.home_entrant_id ?? "-"}|${finalAfter.away_entrant_id ?? "-"}` : "";
    const ok =
      ko.generated === 200 && ko.started === 200 && r1.length === 2 && deciderA !== undefined &&
      // the premise: both finalists seated before the call
      final !== undefined && final.home_entrant_id !== null && final.away_entrant_id !== null &&
      called?.status === 200 &&
      voided?.status === 409 && voided.json.error?.code === "NEXT_MATCH_STARTED" &&
      // nothing written: no void on the semi-final's ledger, the final's seats and court unchanged
      tipAfter === tip && seatsAfter === seatsBefore && finalAfter?.court_id === courts[0];
    w4Check(
      "w4a X-LE-9: a final called to a court keeps both players when its semi-final's result is voided — 409 NEXT_MATCH_STARTED, nothing written" +
        (ok ? "" : ` — generate ${ko.generated}, start ${ko.started}, r1 ${r1.length}, decider ${deciderA ?? "none"}, final ${final?.id ?? "none"} ${seatsBefore}, call ${called?.status ?? "-"} ${JSON.stringify(called?.json).slice(0, 160)}, void ${voided?.status ?? "-"} ${JSON.stringify(voided?.json).slice(0, 160)}, tip ${tip}→${tipAfter}, seats after ${seatsAfter}, court ${finalAfter?.court_id ?? "none"}`),
      ok,
    );
  }

  // Check 2 (T3, X-SD-5; K2): a knockout of three bakes its bye `forfeited` at generation; Start's rolling times (45 minutes
  // a round) skip it, and the board's move onto it is refused by name and writes nothing. The real first-round line beside
  // it takes round 1's time (the positive pair). Which line is the bye is read off the seats, never off the slot columns
  // under test.
  {
    const ko = await startedKnockout(owner, "Bye court", 3, {
      startAt: "2030-08-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      roundMinutes: 45,
      courts,
    });
    const r1 = (await ko.fixtures()).filter((f) => f.round_no === 1);
    const bye = r1.find((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    const real = r1.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    const moved = bye
      ? await v1(owner, `/api/v1/fixtures/${bye.id}`, "PATCH", { scheduled_at: "2030-08-01T10:00:00.000Z", court_id: courts[0] })
      : undefined;
    const byeAfter = (await ko.fixtures()).find((f) => f.id === bye?.id);
    const ok =
      ko.generated === 200 && ko.started === 200 && r1.length === 2 && bye !== undefined && real !== undefined &&
      bye.scheduled_at === null && bye.court_id === null && real.scheduled_at !== null &&
      moved?.status === 422 && moved.json.error?.code === "BYE_LINE_NOT_PLACEABLE" &&
      byeAfter !== undefined && byeAfter.scheduled_at === null && byeAfter.court_id === null;
    w4Check(
      "w4a X-SD-5: an awarded knockout bye takes no rolling time and no court — the board's move is refused 422 BYE_LINE_NOT_PLACEABLE" +
        (ok ? "" : ` — generate ${ko.generated}, start ${ko.started}, r1 ${r1.length}, bye ${bye?.id ?? "none"} ${bye?.scheduled_at ?? "-"}/${bye?.court_id ?? "-"}, real ${real?.scheduled_at ?? "none"}, move ${moved?.status ?? "-"} ${JSON.stringify(moved?.json).slice(0, 160)}, after ${byeAfter?.scheduled_at ?? "-"}/${byeAfter?.court_id ?? "-"}`),
      ok,
    );
  }

  // Check 3 (T4, X-RB-1; K3): a knockout of eight, generated and laid out (each line its own hour; the final alone on
  // Court 2), then a ninth entrant and a Rebuild. The bracket doubles to 16 and its final moves a round later; by role it
  // still holds the final's court and time, and the answer reports seven kept, none freed, and one unscheduled (the one
  // real new first-round line; its neighbours are byes). Expected slots are the ones this check writes.
  {
    const ko = await startedKnockout(owner, "Role carry", 8, undefined, false);
    const before = await ko.fixtures();
    const finalRound = Math.max(...before.map((f) => f.round_no));
    let placedOk = 0;
    let oldFinal = "";
    for (const [i, f] of before.entries()) {
      const at = `2030-06-15T${String(8 + i).padStart(2, "0")}:00:00.000Z`;
      const court = f.round_no === finalRound ? courts[1] : courts[0];
      const placed = await v1(owner, `/api/v1/fixtures/${f.id}`, "PATCH", { scheduled_at: at, venue_id: venueId, court_id: court });
      if (placed.status === 200) placedOk++;
      if (f.round_no === finalRound) oldFinal = `${at}|${court}`;
    }
    await v1(owner, `/api/v1/divisions/${ko.divId}/entrants`, "POST", [
      { kind: "individual", display_name: `Role carry P9 ${tag}`, seed: 9 },
    ]);
    const rebuilt = await v1(owner, `/api/v1/stages/${ko.stageId}/rebuild`, "POST");
    const slots = v1data<{ slots?: { kept: number; freed: number; unscheduled: number } } | undefined>(rebuilt)?.slots;
    const after = await ko.fixtures();
    const newFinalRound = after.length > 0 ? Math.max(...after.map((f) => f.round_no)) : -1;
    const finals = after.filter((f) => f.round_no === newFinalRound);
    const newFinal = finals[0] ? `${finals[0].scheduled_at === null ? "-" : new Date(finals[0].scheduled_at).toISOString()}|${finals[0].court_id ?? "-"}` : "";
    const ok =
      ko.generated === 200 && before.length === 7 && placedOk === 7 && rebuilt.status === 200 &&
      // the premise: the bracket doubled, so the final moved a round later
      newFinalRound === finalRound + 1 && finals.length === 1 &&
      newFinal === oldFinal &&
      slots?.kept === 7 && slots.freed === 0 && slots.unscheduled === 1;
    w4Check(
      "w4a X-RB-1: an 8 → 9 knockout Rebuild keeps the final's court and time on the final — 7 kept, 0 freed, 1 unscheduled" +
        (ok ? "" : ` — generate ${ko.generated}, lines ${before.length}, placed ${placedOk}, rebuild ${rebuilt.status} ${JSON.stringify(rebuilt.json).slice(0, 160)}, final round ${finalRound}→${newFinalRound} (${finals.length}), final ${oldFinal}→${newFinal}, slots ${JSON.stringify(slots)}`),
      ok,
    );
  }

  // Check 4 (T5, K1): Undo cannot cross a seed confirm. A Main draw of eight (home always wins) played out and completed;
  // its Plate — drawn on day one, every seat TBD, `timing: "setup"` — seeded by confirming the draft. The confirm's fills
  // are no ledger step, so before T5 the next Undo inverted the Plate's own generation and deleted the seeded draw. Now
  // it is refused by name and the Plate keeps every seat. The expected seats are the ones read after the confirm.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Seed confirm", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    await v1(
      owner,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Seed confirm P${i + 1} ${tag}`, seed: i + 1 })),
    );
    const mainId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main draw", config: {} }),
    )?.id;
    const plateId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }], placement: "rank_order", timing: "setup" },
      }),
    )?.id;
    const plateDayOne = await v1(owner, `/api/v1/stages/${plateId}/generate`, "POST");
    const mainGen = await v1(owner, `/api/v1/stages/${mainId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const stageRows = async (stageId: string | undefined) =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    let played = 0;
    for (let guard = 0; guard < 6; guard++) {
      const open = (await stageRows(mainId)).filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status ?? ""),
      );
      if (open.length === 0) break;
      for (const f of open) if (await homeWins(owner, f.id)) played++;
    }
    const done = await v1(owner, `/api/v1/stages/${mainId}/complete`, "POST");
    const proposal = v1data<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } } | undefined>(
      await v1(owner, `/api/v1/stages/${plateId}/seed-proposal`, "POST"),
    );
    const confirmed = proposal
      ? await v1(owner, `/api/v1/stages/${plateId}/seed-proposal/confirm`, "POST", {
          proposalId: proposal.id,
          ...(proposal.computed.ties.length > 0 ? { tiePicks: proposal.computed.ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
        })
      : undefined;
    const seats = (rows: Fx[]) => rows.map((f) => `${f.id}:${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}`).sort().join(",");
    const plateBefore = await stageRows(plateId);
    const seated = plateBefore.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null).length;
    const undo = await v1(owner, `/api/v1/divisions/${divId}/undo`, "POST", {});
    const plateAfter = await stageRows(plateId);
    const ok =
      plateDayOne.status === 200 && mainGen.status === 200 && started.status === 200 && played === 7 && done.status === 200 &&
      confirmed?.status === 200 &&
      // the premise: the Plate's two first-round lines are seated by the confirm
      seated === 2 &&
      undo.status === 409 && undo.json.error?.code === "SEED_CONFIRM_NOT_UNDOABLE" &&
      plateAfter.length === plateBefore.length && seats(plateAfter) === seats(plateBefore);
    w4Check(
      "w4a K1: Undo after a Plate's draft is confirmed is refused 409 SEED_CONFIRM_NOT_UNDOABLE, and the Plate keeps every seat" +
        (ok ? "" : ` — plate gen ${plateDayOne.status}, main gen ${mainGen.status}, start ${started.status}, played ${played}, complete ${done.status} ${JSON.stringify(done.json).slice(0, 120)}, confirm ${confirmed?.status ?? "-"} ${JSON.stringify(confirmed?.json).slice(0, 160)}, seated ${seated}, undo ${undo.status} ${JSON.stringify(undo.json).slice(0, 160)}, rows ${plateBefore.length}→${plateAfter.length}, seats kept ${seats(plateAfter) === seats(plateBefore)}`),
      ok,
    );
  }

  // Check 5 (T6, AN-2 / X-CH-7): a knockout of four with a third-place line; both semis and the final decided (home
  // wins), the third-place match unplayed. The engine completes once every FINAL is settled, and a third-place line is
  // none, so Complete used to go through and the division read Finished beside a missing result. Now it is refused by
  // name, the line named, the stage active; the positive pair decides that line and the same Complete goes through.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Bronze", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    await v1(
      owner,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Bronze P${i + 1} ${tag}`, seed: i + 1 })),
    );
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Bronze", config: { thirdPlace: true } }),
    )?.id;
    const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const rows = async () =>
      (v1data<(Fx & { ext_key?: string | null })[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter(
        (f) => f.stage_id === stageId,
      );
    const semis = (await rows()).filter((f) => f.round_no === 1);
    for (const f of semis) await homeWins(owner, f.id);
    const last = (await rows()).filter((f) => f.round_no === 2);
    const bronze = last.find((f) => f.ext_key?.endsWith("3p") === true);
    const final = last.find((f) => f !== bronze);
    const finalWon = final ? await homeWins(owner, final.id) : undefined;
    const refused = await v1(owner, `/api/v1/stages/${stageId}/complete`, "POST", {});
    const ids = (refused.json.error as { fixture_ids?: unknown } | undefined)?.fixture_ids;
    const stageAfter = (v1data<{ id: string; status: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? []).find(
      (st) => st.id === stageId,
    )?.status;
    const bronzeWon = bronze ? await homeWins(owner, bronze.id) : undefined;
    const done = await v1(owner, `/api/v1/stages/${stageId}/complete`, "POST", {});
    const ok =
      generated.status === 200 && started.status === 200 && semis.length === 2 &&
      // the premise: the final decided, the third-place line seated and unplayed
      bronze !== undefined && final !== undefined && finalWon !== undefined &&
      refused.status === 409 && refused.json.error?.code === "STAGE_HAS_UNDECIDED_FIXTURES" &&
      Array.isArray(ids) && ids.length === 1 && ids[0] === bronze.id &&
      stageAfter === "active" &&
      bronzeWon !== undefined && done.status === 200 && v1data<{ completed?: boolean } | undefined>(done)?.completed === true;
    w4Check(
      "w4a X-CH-7: Complete on a knockout whose third-place match is unplayed is refused 409 STAGE_HAS_UNDECIDED_FIXTURES naming it; decided, it completes" +
        (ok ? "" : ` — generate ${generated.status}, start ${started.status}, semis ${semis.length}, final ${final?.id ?? "none"} ${finalWon ?? "-"}, bronze ${bronze?.id ?? "none"}, complete ${refused.status} ${JSON.stringify(refused.json).slice(0, 200)}, stage ${stageAfter ?? "-"}, then ${done.status} ${JSON.stringify(done.json).slice(0, 160)}`),
      ok,
    );
  }

  // The draw and reconcile checks (T7, T8) share their own competition, so the first one's division count is never a cap.
  const drawComp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout A draw ${tag}`, visibility: "private" }),
  );
  /** A badminton division on the draw competition, `n` players registered ONE POST each (registration order is then the
   *  server's own tie-break, `seed nulls last, created_at, id`), unseeded unless `seeded`, and a knockout stage. */
  async function drawKnockout(label: string, n: number, seeded = false) {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${drawComp?.id}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    const registered: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", [
          { kind: "individual", display_name: `${label} P${i + 1} ${tag}`, ...(seeded ? { seed: i + 1 } : {}) },
        ]),
      )?.[0];
      if (e) registered.push(e.id);
    }
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: label, config: {} }),
    )?.id;
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    return { divId, stageId, registered, fixtures };
  }
  const seatsOf = (rows: Fx[]) => rows.map((f) => `${f.round_no}:${f.seq_in_round}:${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}`).sort().join(",");
  const byeHoldersOf = (rows: Fx[]) =>
    rows
      .filter((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null))
      .map((f) => (f.home_entrant_id ?? f.away_entrant_id)!)
      .sort();

  // Check 6 (T7, X-SD-7; K5): six unseeded players. Expected: the byes go to the top two of the stage's draw
  // (`swissRoundOneOrder(swissDrawSeed(stage), registration order)`, RB4-D2), the first-round pairs are the fold's (draw
  // positions 5 v 4 and 3 v 6, the standard 8-bracket), and an Undo then a fresh Generate seats exactly the same bracket.
  {
    const ko = await drawKnockout("Draw", 6);
    const gen1 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const first = await ko.fixtures();
    const drawn = ko.stageId ? swissRoundOneOrder(swissDrawSeed(ko.stageId), ko.registered.map((id) => ({ id, seed: null }))) : [];
    const wantByes = [drawn[0], drawn[1]].sort().join(",");
    const pair = (a?: string, b?: string) => [a, b].sort().join("|");
    const realPairs = first
      .filter((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
      .map((f) => pair(f.home_entrant_id!, f.away_entrant_id!))
      .sort()
      .join(",");
    const wantPairs = [pair(drawn[4], drawn[3]), pair(drawn[2], drawn[5])].sort().join(",");
    const undo = await v1(owner, `/api/v1/divisions/${ko.divId}/undo`, "POST", {});
    const emptied = (await ko.fixtures()).length;
    const gen2 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const second = await ko.fixtures();
    const ok =
      ko.registered.length === 6 && gen1.status === 200 && first.length === 7 && drawn.length === 6 &&
      byeHoldersOf(first).join(",") === wantByes && realPairs === wantPairs &&
      undo.status === 200 && emptied === 0 &&
      gen2.status === 200 && seatsOf(second) === seatsOf(first);
    w4Check(
      "w4a X-SD-7: six unseeded players are drawn with the stage's seed — the byes to the draw's top two — and Undo + Generate seats the same bracket" +
        (ok ? "" : ` — players ${ko.registered.length}, generate ${gen1.status}, lines ${first.length}, byes ${byeHoldersOf(first).join(",")} vs ${wantByes}, pairs ${realPairs} vs ${wantPairs}, undo ${undo.status} ${JSON.stringify(undo.json).slice(0, 160)}, left ${emptied}, generate ${gen2.status}, same ${seatsOf(second) === seatsOf(first)}`),
      ok,
    );
  }

  type Reconcile = { kind?: string; placed?: string[]; vacated?: string[] } | undefined;
  type GenerateAnswer = { created?: number; reconcile?: Reconcile } | undefined;
  /** One more player, registered after the draw and before Start. */
  const addPlayer = async (divId: string | undefined, name: string) =>
    v1data<{ id: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", [{ kind: "individual", display_name: `${name} ${tag}` }]))?.[0]?.id;

  // Check 7 (T8, FX-G2; MB-005's sequence): six unseeded players drawn, a seventh before Start, Generate again. Expected
  // (RB4-L4, rulebook-W4-knockout.md): the byes are the draw's top two, at draw positions 1 and 2; both unseeded, so the
  // tie goes to the LATER position — the seventh plays drawn[1]. Nothing inserted, seven lines still, and a second
  // Generate is the no-op.
  {
    const ko = await drawKnockout("Reconcile 7", 6);
    const gen1 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const before = await ko.fixtures();
    const drawn = ko.stageId ? swissRoundOneOrder(swissDrawSeed(ko.stageId), ko.registered.map((id) => ({ id, seed: null }))) : [];
    const late = await addPlayer(ko.divId, "Reconcile 7 P7");
    const gen2 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const answer = v1data<GenerateAnswer>(gen2);
    const after = await ko.fixtures();
    const lateLine = after.find((f) => f.round_no === 1 && (f.home_entrant_id === late || f.away_entrant_id === late));
    const opponent = lateLine ? (lateLine.home_entrant_id === late ? lateLine.away_entrant_id : lateLine.home_entrant_id) : null;
    const gen3 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const again = v1data<GenerateAnswer>(gen3);
    const ok =
      gen1.status === 200 && before.length === 7 && drawn.length === 6 && late !== undefined &&
      gen2.status === 200 && answer?.created === 0 && answer?.reconcile?.kind === "in_place" &&
      JSON.stringify(answer.reconcile.placed) === JSON.stringify([late]) &&
      after.length === 7 && after.every((f) => before.some((b) => b.id === f.id)) &&
      opponent === drawn[1] &&
      gen3.status === 200 && again?.reconcile?.kind === "noop" && again.created === 0;
    w4Check(
      "w4a FX-G2: a seventh player before Start takes the later-drawn bye in place — nothing inserted, then a second Generate is the no-op" +
        (ok ? "" : ` — generate ${gen1.status}, lines ${before.length}, late ${late ?? "none"}, generate ${gen2.status} ${JSON.stringify(gen2.json).slice(0, 200)}, lines ${after.length}, opponent ${opponent ?? "none"} vs ${drawn[1] ?? "-"}, again ${gen3.status} ${JSON.stringify(again?.reconcile)}`),
      ok,
    );
  }

  // Check 8 (T8, FX-G2): eight players drawn, a ninth before Start, Generate again. Expected: the bracket crosses a power of
  // two, so it is drawn again ONCE at sixteen slots — fifteen lines (8 + 4 + 2 + 1), one final, round one holding every
  // one of the nine exactly once (one match, seven byes). Main kept the old final beside a new one.
  {
    const ko = await drawKnockout("Reconcile 9", 8);
    const gen1 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const before = await ko.fixtures();
    const late = await addPlayer(ko.divId, "Reconcile 9 P9");
    const gen2 = await v1(owner, `/api/v1/stages/${ko.stageId}/generate`, "POST");
    const answer = v1data<GenerateAnswer>(gen2);
    const after = await ko.fixtures();
    const lastRound = Math.max(...after.map((f) => f.round_no));
    const roundOne = after.filter((f) => f.round_no === 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null);
    const everyone = [...ko.registered, late].sort().join(",");
    const ok =
      gen1.status === 200 && before.length === 7 && late !== undefined &&
      gen2.status === 200 && answer?.reconcile?.kind === "regenerated" &&
      JSON.stringify(answer.reconcile.placed) === JSON.stringify([late]) &&
      after.length === 15 && after.filter((f) => f.round_no === lastRound).length === 1 &&
      [...roundOne].sort().join(",") === everyone && new Set(roundOne).size === 9;
    w4Check(
      "w4a FX-G2: a ninth player before Start redraws the bracket once — fifteen lines, one final, every player seated once" +
        (ok ? "" : ` — generate ${gen1.status}, lines ${before.length}, late ${late ?? "none"}, generate ${gen2.status} ${JSON.stringify(gen2.json).slice(0, 200)}, lines ${after.length}, finals ${after.filter((f) => f.round_no === lastRound).length}, round one ${roundOne.length} (${new Set(roundOne).size} distinct)`),
      ok,
    );
  }

  type Entrant = { id: string; seed: number | null; status?: string };
  type LateEntry = { format?: string; case?: string; fixture_id?: string; opponent_id?: string; stage_id?: string } | undefined;
  type LateError = { code?: string; can_rebuild?: boolean } | undefined;
  const entrantsOf = async (divId: string | undefined) =>
    v1data<Entrant[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/entrants`)) ?? [];
  const addLate = async (divId: string | undefined, name: string) =>
    v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", { kind: "individual", display_name: `${name} ${tag}` });

  // Check 9 (T10, X-LE-3/X-LE-4 then X-LE-13): six seeded players Started in a bracket of eight, so seeds 1 and 2 hold the
  // byes. Expected (RB4-L4, rulebook-W4-knockout.md): the newcomer plays the LOWEST-seeded holder — seed 2, read off the
  // entrant list — on that bye's line, which is a match again; the division's Undo is then refused by name.
  {
    const ko = await startedKnockout(owner, "Late bye", 6);
    const seed2 = (await entrantsOf(ko.divId)).find((e) => e.seed === 2)?.id;
    const byeLine = (await ko.fixtures()).find(
      (f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null) && (f.home_entrant_id ?? f.away_entrant_id) === seed2,
    );
    const added = await addLate(ko.divId, "Late bye P7");
    const late = v1data<{ id?: string; late_entry?: LateEntry } | undefined>(added);
    const line = (await ko.fixtures()).find((f) => f.id === byeLine?.id);
    const undo = await v1(owner, `/api/v1/divisions/${ko.divId}/undo`, "POST", {});
    const undoErr: LateError = undo.json?.error;
    const ok =
      ko.started === 200 && seed2 !== undefined && byeLine !== undefined &&
      added.status === 201 && late?.late_entry?.format === "knockout" && late.late_entry.case === "bye" &&
      late.late_entry.fixture_id === byeLine.id && late.late_entry.opponent_id === seed2 &&
      line !== undefined && new Set([line.home_entrant_id, line.away_entrant_id]).size === 2 &&
      [line.home_entrant_id, line.away_entrant_id].includes(late.id ?? "-") && line.status === "scheduled" &&
      undo.status === 409 && undoErr?.code === "KO_LATE_ENTRY_NOT_UNDOABLE";
    w4Check(
      "w4a X-LE-3: a late player in a Started knockout plays the lowest-seeded holder's bye, and Undo refuses KO_LATE_ENTRY_NOT_UNDOABLE" +
        (ok ? "" : ` — start ${ko.started}, seed2 ${seed2 ?? "none"}, bye line ${byeLine?.id ?? "none"}, add ${added.status} ${JSON.stringify(added.json).slice(0, 200)}, line ${JSON.stringify(line).slice(0, 160)}, undo ${undo.status} ${undoErr?.code ?? "-"}`),
      ok,
    );
  }

  // Check 10 (T10, X-LE-6 then X-LE-5): eight seeded players Started — round 1 full. Expected (RB4-L6, B6a fix round 1): with
  // nothing started the add is KEPT and answers 201 late_entry rebuild_offered (KO_LATE_ENTRY_NO_SLOT) - the player waits, so
  // nine entrants and no line moved. Then round 1's second line loses its away player (the cascade walks it over): the next
  // add takes that seat against the line's home player, and the line is an unplayed match again.
  {
    const ko = await startedKnockout(owner, "Late slot", 8);
    const linesBefore = JSON.stringify(await ko.fixtures());
    const offered = await addLate(ko.divId, "Late slot P9");
    const offer = v1data<{ id?: string; late_entry?: LateEntry & { reason?: string } } | undefined>(offered);
    const count = (await entrantsOf(ko.divId)).length;
    const unmoved = JSON.stringify(await ko.fixtures()) === linesBefore;
    const line0 = (await ko.fixtures()).find((f) => f.round_no === 1 && f.seq_in_round === 2);
    const withdrawn = line0?.away_entrant_id ? await v1(owner, `/api/v1/entrants/${line0.away_entrant_id}/withdraw`, "POST") : undefined;
    const walked = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const added = await addLate(ko.divId, "Late slot P10");
    const late = v1data<{ id?: string; late_entry?: LateEntry } | undefined>(added);
    const line = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const ok =
      ko.started === 200 && offered.status === 201 && offer?.late_entry?.format === "knockout" && offer.late_entry.case === "rebuild_offered" &&
      offer.late_entry.reason === "KO_LATE_ENTRY_NO_SLOT" && count === 9 && unmoved && line0 !== undefined && withdrawn?.status === 200 && walked?.status === "forfeited" &&
      added.status === 201 && late?.late_entry?.case === "withdrawn_slot" && late.late_entry.fixture_id === line0.id &&
      late.late_entry.opponent_id === line0.home_entrant_id &&
      line?.home_entrant_id === line0.home_entrant_id && line?.away_entrant_id === late.id && line?.status === "scheduled";
    w4Check(
      "w4a X-LE-5: a full round 1 keeps a late player and offers Rebuild (201 rebuild_offered, no line moved); after a withdrawal the next takes the seat" +
        (ok ? "" : ` — start ${ko.started}, offered ${offered.status} ${JSON.stringify(offer?.late_entry)}, entrants ${count}, unmoved ${unmoved}, withdraw ${withdrawn?.status ?? "-"}, walked ${walked?.status ?? "-"}, add ${added.status} ${JSON.stringify(added.json).slice(0, 200)}, line ${JSON.stringify(line).slice(0, 160)}`),
      ok,
    );
  }

  // Check 11 (T11, X-LE-10/K13): eight seeded Started; round 1's first line loses its home player (the cascade walks it
  // over), who is then reinstated through PATCH — an automatic arrival. Expected (ruling 271): the walked-over line is
  // unchanged (nobody placed by the app); one tap on the place route reverses their own walkover — the line is theirs
  // against the same opponent, unplayed again — and a second tap is refused 409 KO_LATE_ENTRY_NOT_WAITING.
  {
    const ko = await startedKnockout(owner, "Late wait", 8);
    const line0 = (await ko.fixtures()).find((f) => f.round_no === 1 && f.seq_in_round === 1);
    const gone = line0?.home_entrant_id ?? undefined;
    const withdrawn = gone ? await v1(owner, `/api/v1/entrants/${gone}/withdraw`, "POST") : undefined;
    const walked = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const back = gone ? await v1(owner, `/api/v1/entrants/${gone}`, "PATCH", { status: "registered" }) : undefined;
    const still = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const tap = await v1(owner, `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`, "POST");
    const placed = v1data<LateEntry>(tap);
    const line = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const again = await v1(owner, `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`, "POST");
    const againErr: LateError = again.json?.error;
    const ok =
      ko.started === 200 && line0 !== undefined && gone !== undefined && withdrawn?.status === 200 && walked?.status === "forfeited" &&
      back?.status === 200 && JSON.stringify(still) === JSON.stringify(walked) &&
      tap.status === 200 && placed?.case === "withdrawn_slot" && placed.fixture_id === line0.id && placed.opponent_id === line0.away_entrant_id &&
      line?.home_entrant_id === gone && line?.away_entrant_id === line0.away_entrant_id && line?.status === "scheduled" &&
      again.status === 409 && againErr?.code === "KO_LATE_ENTRY_NOT_WAITING";
    w4Check(
      "w4a X-LE-10: a reinstated player waits (nothing placed), one tap gives their own seat back, a second tap is KO_LATE_ENTRY_NOT_WAITING" +
        (ok ? "" : ` — start ${ko.started}, withdraw ${withdrawn?.status ?? "-"}, walked ${walked?.status ?? "-"}, reinstate ${back?.status ?? "-"}, still ${JSON.stringify(still).slice(0, 120)}, tap ${tap.status} ${JSON.stringify(tap.json).slice(0, 200)}, line ${JSON.stringify(line).slice(0, 160)}, again ${again.status} ${againErr?.code ?? "-"}`),
      ok,
    );
  }

  // Check 12 (T13, X-LL-1/K9; RB4-V2): a qualifying knockout of eight feeding a main draw of four, every qualifying line
  // won by its home side, the main draw confirmed. Expected: a qualifier who withdraws before their first main-draw match
  // is replaced by the best-seeded quarter-final loser (read off the qualifying rows: one round, so seed decides — C2),
  // the reply names them and the line, and nobody is walked over. The expected entrant comes from the rows and the seeds.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Lucky loser", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    const added =
      v1data<{ id: string }[] | undefined>(
        await v1(
          owner,
          `/api/v1/divisions/${divId}/entrants`,
          "POST",
          Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Lucky P${i + 1} ${tag}`, seed: i + 1 })),
        ),
      ) ?? [];
    const seedOf = new Map(added.map((e, i) => [e.id, i + 1]));
    const qualId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} }),
    )?.id;
    const mainId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Main draw",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
      }),
    )?.id;
    const qualGen = await v1(owner, `/api/v1/stages/${qualId}/generate`, "POST");
    const mainGen = await v1(owner, `/api/v1/stages/${mainId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const stageRows = async (stageId: string | undefined) =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    let played = 0;
    for (let guard = 0; guard < 6; guard++) {
      const open = (await stageRows(qualId)).filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status ?? ""),
      );
      if (open.length === 0) break;
      for (const f of open) if (await homeWins(owner, f.id)) played++;
    }
    const quarterLosers = (await stageRows(qualId)).filter((f) => f.round_no === 1).map((f) => f.away_entrant_id ?? "");
    const expected = [...quarterLosers].sort((a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99))[0];
    const done = await v1(owner, `/api/v1/stages/${qualId}/complete`, "POST");
    const proposal = v1data<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } } | undefined>(
      await v1(owner, `/api/v1/stages/${mainId}/seed-proposal`, "POST"),
    );
    const confirmed = proposal
      ? await v1(owner, `/api/v1/stages/${mainId}/seed-proposal/confirm`, "POST", {
          proposalId: proposal.id,
          ...(proposal.computed.ties.length > 0 ? { tiePicks: proposal.computed.ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
        })
      : undefined;
    const line = (await stageRows(mainId)).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null);
    const leaving = line?.away_entrant_id ?? undefined;
    const withdrawn = leaving ? await v1(owner, `/api/v1/entrants/${leaving}/withdraw`, "POST") : undefined;
    const report = withdrawn ? v1data<{ walkovers: number; lucky_loser: { entrant_id: string; fixture_id: string } | null } | undefined>(withdrawn) : undefined;
    const after = (await stageRows(mainId)).find((f) => f.id === line?.id);
    const ok =
      qualGen.status === 200 && mainGen.status === 200 && started.status === 200 && played === 7 && done.status === 200 &&
      confirmed?.status === 200 && line !== undefined && quarterLosers.length === 4 && expected !== undefined &&
      withdrawn?.status === 200 && report?.walkovers === 0 &&
      report?.lucky_loser?.entrant_id === expected && report?.lucky_loser?.fixture_id === line.id &&
      after?.home_entrant_id === line.home_entrant_id && after?.away_entrant_id === expected && after?.status === "scheduled";
    w4Check(
      "w4a X-LL-1: a qualifier who withdraws before their first main-draw match is replaced by the best quarter-final loser, nobody walked over" +
        (ok ? "" : ` — gen ${qualGen.status}/${mainGen.status}, start ${started.status}, played ${played}, complete ${done.status}, confirm ${confirmed?.status ?? "-"} ${JSON.stringify(confirmed?.json).slice(0, 160)}, losers ${quarterLosers.length}, withdraw ${withdrawn?.status ?? "-"} ${JSON.stringify(withdrawn?.json).slice(0, 200)}, line ${JSON.stringify(after).slice(0, 160)}`),
      ok,
    );
  }

  // Check 13 (T14, X-QM-4, FX-G16, FX-G18; RB4-Q5): eight into a main draw of four, every line won by its home side, the main
  // draw confirmed. The semi-final's away seat qualified and lost it; the quarter-final that put them through is corrected.
  // The final, the semi-final and the quarter-final are taken back (latest first: a played next match refuses a void), and
  // at the last void the main draw's seats are empty and Compute refuses for the source, no longer for a confirmed draw. Re-recorded the other way and replayed, a
  // re-proposal offers the quarter-final's new winner and not the old. Expected from the rows, never the code under test.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Corrected qualifier", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    await v1(
      owner,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Corrected P${i + 1} ${tag}`, seed: i + 1 })),
    );
    const qualId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} }),
    )?.id;
    const mainId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Main draw",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
      }),
    )?.id;
    await v1(owner, `/api/v1/stages/${qualId}/generate`, "POST");
    await v1(owner, `/api/v1/stages/${mainId}/generate`, "POST");
    await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const stageRows = async (stageId: string | undefined) =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    for (let guard = 0; guard < 6; guard++) {
      const open = (await stageRows(qualId)).filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status ?? ""),
      );
      if (open.length === 0) break;
      for (const f of open) await homeWins(owner, f.id);
    }
    await v1(owner, `/api/v1/stages/${qualId}/complete`, "POST");
    const proposal = v1data<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } } | undefined>(
      await v1(owner, `/api/v1/stages/${mainId}/seed-proposal`, "POST"),
    );
    const confirmed = proposal
      ? await v1(owner, `/api/v1/stages/${mainId}/seed-proposal/confirm`, "POST", {
          proposalId: proposal.id,
          ...(proposal.computed.ties.length > 0 ? { tiePicks: proposal.computed.ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
        })
      : undefined;

    const rows = await stageRows(qualId);
    const semi = rows.find((f) => f.round_no === 2 && f.seq_in_round === 1);
    const out = semi?.away_entrant_id ?? undefined;
    const quarter = rows.find((f) => f.round_no === 1 && f.home_entrant_id === out);
    const incoming = quarter?.away_entrant_id ?? undefined;
    const final = rows.reduce<Fx | undefined>((a, f) => (a === undefined || f.round_no > a.round_no ? f : a), undefined);
    /** Every live event of the line, newest first, as a scorer's Undo does. */
    const takeBack = async (fixtureId: string | undefined): Promise<void> => {
      const ledger = v1data<{ id: string; seq: number; type: string; voids_event_id: string | null }[] | undefined>(await v1(owner, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`)) ?? [];
      const voided = new Set(ledger.map((e) => e.voids_event_id));
      for (const e of ledger.filter((x) => x.type !== "core.void" && !voided.has(x.id)).sort((a, b) => b.seq - a.seq)) {
        await appendScoreEvent(owner, fixtureId!, "core.void", { event_id: e.id });
      }
    };
    await takeBack(final?.id);
    await takeBack(semi?.id);
    await takeBack(quarter?.id);
    const emptied = (await stageRows(mainId)).filter((f) => f.round_no === 1);
    // A proposal has no GET: Compute's own answer tells a stale one (nothing to propose from yet) from a confirmed one.
    const undecided = await v1(owner, `/api/v1/stages/${mainId}/seed-proposal`, "POST");
    const undecidedCode = (undecided.json as { error?: { code?: string } } | undefined)?.error?.code;

    await appendScoreEvent(owner, quarter!.id, "core.start", {});
    await appendScoreEvent(owner, quarter!.id, "badminton.game.summary", { home: 10, away: 21 });
    await appendScoreEvent(owner, quarter!.id, "badminton.game.summary", { home: 12, away: 21 });
    await homeWins(owner, semi!.id);
    await homeWins(owner, final!.id);
    const recomputed = await v1(owner, `/api/v1/stages/${mainId}/seed-proposal`, "POST");
    const offered = v1data<{ computed: { qualifiers: { entrantId: string }[] } } | undefined>(recomputed)?.computed.qualifiers.map((q) => q.entrantId) ?? [];
    const ok =
      confirmed?.status === 200 && out !== undefined && incoming !== undefined &&
      emptied.length === 2 && emptied.every((f) => f.home_entrant_id === null && f.away_entrant_id === null) &&
      undecided.status === 409 && undecidedCode === "SEEDING_SOURCE_INCOMPLETE" &&
      recomputed.status === 201 && offered.includes(incoming) && !offered.includes(out);
    w4Check(
      "w4a X-QM-4: a corrected quarter-final empties the confirmed main draw's seats, and a re-proposal offers the new qualifier" +
        (ok ? "" : ` — confirm ${confirmed?.status ?? "-"}, emptied ${JSON.stringify(emptied.map((f) => [f.home_entrant_id, f.away_entrant_id]))}, undecided ${undecided.status} ${undecidedCode ?? "-"}, recomputed ${recomputed.status}, offered ${JSON.stringify(offered)}, out ${out}, in ${incoming}`),
      ok,
    );
  }

  // Checks 14 and 15 (T15, X-PL-1 and X-QM-2): the format gates, off the stage graph, on divisions built through the API.
  {
    const errorCode = (r: { json?: unknown }) => (r.json as { error?: { code?: string } } | undefined)?.error?.code;
    const division = async (label: string) =>
      v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
      )?.id;
    const entrants = (divId: string | undefined, label: string, from: number, to: number) =>
      v1(
        owner,
        `/api/v1/divisions/${divId}/entrants`,
        "POST",
        Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "individual", display_name: `${label} ${from + i} ${tag}`, seed: from + i })),
      );

    const plateDiv = await division(`T15 plate ${tag}`);
    await entrants(plateDiv, "T15 Plate", 1, 3);
    const plateMain = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${plateDiv}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main", config: {} }),
    )?.id;
    await v1(owner, `/api/v1/divisions/${plateDiv}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Plate",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 2 }] }], placement: "rank_order", timing: "setup" },
    });
    const generateAt3 = await v1(owner, `/api/v1/stages/${plateMain}/generate`, "POST");
    const startAt3 = await v1(owner, `/api/v1/divisions/${plateDiv}/start`, "POST");
    await entrants(plateDiv, "T15 Plate", 4, 4);
    const startAt4 = await v1(owner, `/api/v1/divisions/${plateDiv}/start`, "POST");
    const plateOk =
      generateAt3.status === 422 && errorCode(generateAt3) === "KO_PLATE_TOO_FEW" &&
      startAt3.status === 422 && errorCode(startAt3) === "KO_PLATE_TOO_FEW" &&
      startAt4.status === 200;
    w4Check(
      "w4a X-PL-1: Knockout + Plate on 3 is refused by name at Generate and at Start, and starts on 4" +
        (plateOk ? "" : ` — generate ${generateAt3.status} ${errorCode(generateAt3)}, start ${startAt3.status} ${errorCode(startAt3)}, then ${startAt4.status} ${errorCode(startAt4)}`),
      plateOk,
    );

    const cutDiv = await division(`T15 cut ${tag}`);
    await entrants(cutDiv, "T15 Cut", 1, 8);
    await v1(owner, `/api/v1/divisions/${cutDiv}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} });
    const mainOf = (to: number) => ({
      seq: 2,
      kind: "knockout",
      name: "Main draw",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to }] }], placement: "rank_order", timing: "setup" },
    });
    const cutOf3 = await v1(owner, `/api/v1/divisions/${cutDiv}/stages`, "POST", mainOf(3));
    const stagesAfter3 = v1data<unknown[] | undefined>(await v1(owner, `/api/v1/divisions/${cutDiv}/stages`, "GET"))?.length;
    const cutOf4 = await v1(owner, `/api/v1/divisions/${cutDiv}/stages`, "POST", mainOf(4));
    const cutOk = cutOf3.status === 422 && errorCode(cutOf3) === "KO_CUT_NOT_WHOLE_ROUND" && stagesAfter3 === 1 && cutOf4.status === 201;
    w4Check(
      "w4a X-QM-2: a rank cut of 3 from a knockout is refused by name and leaves no stage; the whole round of 4 is taken" +
        (cutOk ? "" : ` — 3: ${cutOf3.status} ${errorCode(cutOf3)}, stages ${stagesAfter3}; 4: ${cutOf4.status} ${errorCode(cutOf4)}`),
      cutOk,
    );
  }

  // Checks 16, 17 and 18 (T25, T8-f; see the header): the three formats whose last stage is a bracket fed from a stage before it.
  // Each division is built from the builder's own stage drafts, played with upsets and completed; the expected seats and ranks
  // are read off the played lines' outcomes and the rulebook's shapes (RB4-S1, RB4-S2), never off the answer under test.
  {
    type Line = {
      id: string;
      stage_id: string;
      round_no: number;
      seq_in_round: number;
      status: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      outcome: { kind?: string; winner?: string; loser?: string } | null;
    };
    type Sport = "badminton" | "generic";
    type Done = { completed?: boolean; events?: { type: string; finalRanks?: string[] }[]; division_completed?: boolean };
    const errorCode = (r: { json?: unknown }) => (r.json as { error?: { code?: string } } | undefined)?.error?.code;
    const pairKey = (a: string | null | undefined, b: string | null | undefined) => [a ?? "-", b ?? "-"].sort().join("|");
    const holds = (f: Line, id: string | undefined) => id !== undefined && (f.home_entrant_id === id || f.away_entrant_id === id);
    const isOpen = (f: Line) =>
      f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void", "abandoned"].includes(f.status);

    /** Every line of a stage in play order. */
    const linesOf = async (divId: string | undefined, stageId: string | undefined): Promise<Line[]> =>
      (v1data<Line[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [])
        .filter((f) => f.stage_id === stageId)
        .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
    /** A division of `n` individuals seeded 1..n; entrant ids come back in seed order. */
    const division = async (label: string, sport: Sport, n: number) => {
      const body =
        sport === "generic"
          ? { name: label, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } }
          : { name: label, sport_key: "badminton", variant_key: "bwf", config: {} };
      const divId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", body))?.id;
      const added =
        v1data<{ id: string }[] | undefined>(
          await v1(
            owner,
            `/api/v1/divisions/${divId}/entrants`,
            "POST",
            Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `${label} P${i + 1} ${tag}`, seed: i + 1 })),
          ),
        ) ?? [];
      return { divId, ids: added.map((e) => e.id) };
    };
    /** The format's stage drafts exactly as the builder sends them (`buildTemplateStages`), created in one call. */
    const build = async (divId: string | undefined, template: string, qualified: number) => {
      const res = await v1(
        owner,
        `/api/v1/divisions/${divId}/stages`,
        "POST",
        buildTemplateStages(template, { qualified, swissRounds: 5, poolCount: 2, legs: 1 }).map((s, i) => ({ ...s, seq: i + 1 })),
      );
      return { status: res.status, ids: (v1data<{ id: string }[] | undefined>(res) ?? []).map((s) => s.id) };
    };
    /** The scorer's result: `winner` takes the line (badminton two games to none, generic 2-0). */
    const win = async (sport: Sport, f: Line, winner: string) => {
      const home = f.home_entrant_id === winner;
      if (sport === "generic") {
        await appendScoreEvent(owner, f.id, "generic.result", home ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
        return;
      }
      await appendScoreEvent(owner, f.id, "core.start", {});
      for (const [won, lost] of [[21, 10], [21, 12]] as const) {
        await appendScoreEvent(owner, f.id, "badminton.game.summary", home ? { home: won, away: lost } : { home: lost, away: won });
      }
    };
    /** Plays the stage's seated, open lines (those `only` admits) — each won by the side `pick` names — until none is left. A pick
     *  that is not on its line plays nothing and is counted, so the check fails on a rig error rather than scoring the wrong side. */
    const playOut = async (sport: Sport, divId: string | undefined, stageId: string | undefined, pick: (f: Line) => string, only: (f: Line) => boolean = () => true) => {
      let played = 0;
      let missed = 0;
      for (let guard = 0; guard < 8; guard++) {
        const todo = (await linesOf(divId, stageId)).filter((f) => isOpen(f) && only(f));
        if (todo.length === 0) break;
        missed = 0;
        for (const f of todo) {
          const winner = pick(f);
          if (!holds(f, winner)) {
            missed++;
            continue;
          }
          await win(sport, f, winner);
          played++;
        }
        if (missed > 0) break;
      }
      return { played, missed };
    };
    /** Compute the stage's proposal and confirm it as it stands (a tie would need a pick: the leagues here have none). */
    const seatFrom = async (stageId: string | undefined) => {
      const proposal = v1data<{ id: string; computed: { ties: unknown[] } } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/seed-proposal`, "POST"));
      const confirmed = proposal ? await v1(owner, `/api/v1/stages/${stageId}/seed-proposal/confirm`, "POST", { proposalId: proposal.id }) : undefined;
      return { ties: proposal?.computed.ties.length ?? -1, status: confirmed?.status };
    };
    /** Complete a stage: the status, the stage_completed event's finalRanks (the one place they cross the wire), the events emitted. */
    const complete = async (stageId: string | undefined) => {
      const res = await v1(owner, `/api/v1/stages/${stageId}/complete`, "POST");
      const data = v1data<Done | undefined>(res);
      return {
        status: res.status,
        completed: data?.completed === true,
        ranks: data?.events?.find((e) => e.type === "stage_completed")?.finalRanks ?? [],
        events: data?.events?.length ?? -1,
        divisionCompleted: data?.division_completed === true,
      };
    };
    /** The entrants of a stage's standings, best rank first (what a customer reads; it must agree with the Complete answer). */
    const standingsOrder = async (stageId: string | undefined): Promise<string[]> =>
      (v1data<{ rows: { entrantId: string; rank?: number }[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/standings`))?.rows ?? [])
        .filter((r) => r.rank !== undefined)
        .sort((a, b) => a.rank! - b.rank!)
        .map((r) => r.entrantId);
    const stageStatus = async (divId: string | undefined, stageId: string | undefined) =>
      v1data<{ id: string; status: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`))?.find((s) => s.id === stageId)?.status;
    const betterSeed = (seedOf: ReadonlyMap<string, number>) => (f: Line) =>
      (seedOf.get(f.home_entrant_id ?? "") ?? 99) < (seedOf.get(f.away_entrant_id ?? "") ?? 99) ? f.home_entrant_id! : f.away_entrant_id!;

    // Check 16 (T25; RB4-Q1, RB4-Q3, RB4-Q6): qualifying_main. A field of 3 is refused by name at the root Generate and at Start and
    // writes no line; a field of 8 qualifies 4. Seed 7 is the upset (it takes its first two lines, then loses the final to seed 1),
    // so the four who go through are not the four best seeds. Expected: the qualifiers are the four quarter-final winners, ranked
    // by the qualifying final (winner, loser) and the semi-final losers (the tie between those two is the engine's own); the main
    // draw is seated by that rank, 1 v 4 and 2 v 3, and none of the four who lost in round 1 is seated; the main draw's rank-4
    // qualifier is scripted to win it, and completing it completes the division with the four ranked once; a second Complete changes
    // nothing.
    {
      const small = await division("QM three", "badminton", 3);
      const smallStages = await build(small.divId, "qualifying_main", 4);
      const refusedGenerate = await v1(owner, `/api/v1/stages/${smallStages.ids[0]}/generate`, "POST");
      const refusedStart = await v1(owner, `/api/v1/divisions/${small.divId}/start`, "POST");
      const smallLines = (await linesOf(small.divId, smallStages.ids[0])).length;

      const { divId, ids } = await division("QM eight", "badminton", 8);
      const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
      const stages = await build(divId, "qualifying_main", 4);
      const [qualId, mainId] = stages.ids;
      const generated = [await v1(owner, `/api/v1/stages/${qualId}/generate`, "POST"), await v1(owner, `/api/v1/stages/${mainId}/generate`, "POST")];
      const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
      const mainDayOne = await linesOf(divId, mainId);
      const upset = ids[6];
      const better = betterSeed(seedOf);
      const qualPlayed = await playOut("badminton", divId, qualId, (f) => (f.round_no <= 2 && holds(f, upset) ? upset! : better(f)));
      const qLines = await linesOf(divId, qualId);
      const quarters = qLines.filter((f) => f.round_no === 1);
      const semis = qLines.filter((f) => f.round_no === 2);
      const qFinal = qLines.find((f) => f.round_no === 3);
      const doneQual = await complete(qualId);
      const ranks = doneQual.ranks;
      const confirmed = await seatFrom(mainId);
      const mainLines = await linesOf(divId, mainId);
      const mainOne = mainLines.filter((f) => f.round_no === 1);
      const seatedInMain = new Set(mainLines.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null));
      const champion = ranks[3];
      const mainPlayed = await playOut("badminton", divId, mainId, (f) =>
        holds(f, champion) ? champion! : ranks.indexOf(f.home_entrant_id ?? "") < ranks.indexOf(f.away_entrant_id ?? "") ? f.home_entrant_id! : f.away_entrant_id!,
      );
      const doneMain = await complete(mainId);
      const again = await complete(mainId);
      const ok =
        // the bound: refused by name, nothing written; the premise that the stages were made
        smallStages.status === 201 && refusedGenerate.status === 422 && errorCode(refusedGenerate) === "QUALIFYING_MAIN_TOO_FEW" &&
        refusedStart.status === 422 && errorCode(refusedStart) === "QUALIFYING_MAIN_TOO_FEW" && smallLines === 0 &&
        // the premise: eight made it to a played bracket of seven lines, the main draw a day-one shell of three, nobody seated yet
        stages.status === 201 && generated.every((g) => g.status === 200) && started.status === 200 && mainDayOne.length === 3 &&
        mainDayOne.every((f) => f.home_entrant_id === null && f.away_entrant_id === null) &&
        qualPlayed.played === 7 && qualPlayed.missed === 0 && quarters.length === 4 && semis.length === 2 && qFinal !== undefined &&
        qFinal.outcome?.winner === ids[0] && qFinal.outcome?.loser === upset && doneQual.status === 200 && doneQual.completed &&
        // the qualifiers: the four quarter-final winners, final winner and loser first, the semi-final losers after
        ranks.length === 8 && new Set(ranks).size === 8 &&
        [...ranks.slice(0, 4)].sort().join() === quarters.map((f) => f.outcome?.winner ?? "-").sort().join() &&
        ranks[0] === qFinal.outcome?.winner && ranks[1] === qFinal.outcome?.loser &&
        [...ranks.slice(2, 4)].sort().join() === semis.map((f) => f.outcome?.loser ?? "-").sort().join() &&
        [...(await standingsOrder(qualId))].sort().join() === [...ranks].sort().join() &&
        // seated by rank: 1 v 4 and 2 v 3, four seated, the round-1 losers nowhere
        confirmed.ties === 0 && confirmed.status === 200 && mainOne.length === 2 &&
        mainOne.map((f) => pairKey(f.home_entrant_id, f.away_entrant_id)).sort().join() === [pairKey(ranks[0], ranks[3]), pairKey(ranks[1], ranks[2])].sort().join() &&
        seatedInMain.size === 4 && ranks.slice(0, 4).every((id) => seatedInMain.has(id)) &&
        quarters.every((f) => !seatedInMain.has(f.outcome?.loser ?? "-")) &&
        // played out and completed: the rank-4 qualifier wins the main draw over the rank-2, and the division completes
        mainPlayed.played === 3 && mainPlayed.missed === 0 && doneMain.status === 200 && doneMain.completed && doneMain.divisionCompleted &&
        doneMain.ranks.length === 4 && new Set(doneMain.ranks).size === 4 && doneMain.ranks.every((id) => seatedInMain.has(id)) &&
        [...(await standingsOrder(mainId))].sort().join() === [...doneMain.ranks].sort().join() &&
        (await stageStatus(divId, qualId)) === "complete" && (await stageStatus(divId, mainId)) === "complete" &&
        // the second call: nothing more is emitted
        again.status === 200 && again.completed && again.events === 0;
      w4Check(
        "w4a T25 qualifying_main: three are refused by name; eight qualify four by their qualifying rank, seated 1 v 4 and 2 v 3, and the main draw completes the division" +
          (ok ? "" : ` — small ${smallStages.status}/${refusedGenerate.status} ${errorCode(refusedGenerate)}/${refusedStart.status} ${errorCode(refusedStart)}/${smallLines} lines; stages ${stages.status}, gen ${generated.map((g) => g.status)}, start ${started.status}, day-one ${mainDayOne.length}; qualifying played ${qualPlayed.played}/${qualPlayed.missed}, quarters ${quarters.length}, semis ${semis.length}, final ${qFinal?.outcome?.winner === ids[0]}/${qFinal?.outcome?.loser === upset}; complete ${doneQual.status} ranks ${ranks.map((id) => seedOf.get(id))}; confirm ${confirmed.status}/${confirmed.ties}; main round 1 ${mainOne.map((f) => `${seedOf.get(f.home_entrant_id ?? "")}v${seedOf.get(f.away_entrant_id ?? "")}`)}, seated ${seatedInMain.size}; main played ${mainPlayed.played}/${mainPlayed.missed}, complete ${doneMain.status} ${doneMain.ranks.map((id) => seedOf.get(id))} division ${doneMain.divisionCompleted}; again ${again.status}/${again.events}`),
        ok,
      );
    }

    // Check 17 (T25; RB4-S1, RB4-S7): a league of six into a stepladder of the top five, on generic scoring. Seeds are the league
    // table's order (the better seed wins every league line: asserted from the league's own ranks, not assumed). RB4-S1: the lowest
    // two seeds (4, 5) play the first rung, and each later rung holds one fixed seed, 3, 2, 1, waiting for the climber. Seed 5
    // climbs two rungs (an upset), seed 2 stops it, seed 1 wins the ladder. The stage's ranks are asserted as COVERAGE only (RB4-R1:
    // every one of the five once, the sixth finisher in none); their ORDER is app-B's (carry C19).
    {
      const k = 5;
      const { divId, ids } = await division("Stepladder finals", "generic", 6);
      const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
      const stages = await build(divId, "group_stepladder", k);
      const [leagueId, ladderId] = stages.ids;
      const generated = [await v1(owner, `/api/v1/stages/${leagueId}/generate`, "POST"), await v1(owner, `/api/v1/stages/${ladderId}/generate`, "POST")];
      const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
      const leaguePlayed = await playOut("generic", divId, leagueId, betterSeed(seedOf));
      const doneLeague = await complete(leagueId);
      const confirmed = await seatFrom(ladderId);
      const rungs = await linesOf(divId, ladderId);
      const climber = ids[k - 1];
      const ladderPlayed = await playOut("generic", divId, ladderId, (f) => (f.round_no <= 2 ? climber! : betterSeed(seedOf)(f)));
      const played = await linesOf(divId, ladderId);
      const last = played[played.length - 1];
      const doneLadder = await complete(ladderId);
      const again = await complete(ladderId);
      const ok =
        stages.status === 201 && generated.every((g) => g.status === 200) && started.status === 200 &&
        // the premise: the league's table is the seed order (no tie to pick), all fifteen lines played
        leaguePlayed.played === 15 && leaguePlayed.missed === 0 && doneLeague.status === 200 && doneLeague.completed && doneLeague.ranks.join() === ids.join() &&
        confirmed.ties === 0 && confirmed.status === 200 &&
        // RB4-S1 seated: k - 1 rungs, one a round; rung 1 = the two lowest seeds, every later rung one fixed seed (k-1, ... 1) waiting
        rungs.length === k - 1 && rungs.every((f, i) => f.round_no === i + 1) &&
        pairKey(rungs[0]?.home_entrant_id, rungs[0]?.away_entrant_id) === pairKey(ids[k - 2], ids[k - 1]) &&
        rungs.slice(1).every((f, i) => pairKey(f.home_entrant_id, f.away_entrant_id) === pairKey(ids[k - 2 - i - 1], null)) &&
        // played with the upset and completed: each rung's seats are the climber's and the fixed seed's
        ladderPlayed.played === k - 1 && ladderPlayed.missed === 0 && played.every((f) => f.status === "decided") &&
        pairKey(played[1]?.home_entrant_id, played[1]?.away_entrant_id) === pairKey(ids[2], climber) &&
        pairKey(played[2]?.home_entrant_id, played[2]?.away_entrant_id) === pairKey(ids[1], climber) &&
        pairKey(played[3]?.home_entrant_id, played[3]?.away_entrant_id) === pairKey(ids[0], ids[1]) &&
        // the premise that the rig played what it meant to: seed 1 won the last rung against seed 2, the climber lost to seed 2
        last?.outcome?.winner === ids[0] && last.outcome.loser === ids[1] && played[2]?.outcome?.winner === ids[1] && played[2].outcome.loser === climber &&
        // every qualifier ranked once (RB4-R1), the sixth finisher in none, and the standings cover the same five
        doneLadder.status === 200 && doneLadder.completed && doneLadder.divisionCompleted &&
        doneLadder.ranks.length === k && new Set(doneLadder.ranks).size === k && doneLadder.ranks.every((id) => ids.slice(0, k).includes(id)) &&
        !doneLadder.ranks.includes(ids[5]!) &&
        [...(await standingsOrder(ladderId))].sort().join() === [...doneLadder.ranks].sort().join() &&
        (await stageStatus(divId, ladderId)) === "complete" &&
        again.status === 200 && again.completed && again.events === 0;
      w4Check(
        "w4a T25 stepladder: a league of six into a top five seats the lowest two seeds first and one climber a rung, and the stage ranks every qualifier once" +
          (ok ? "" : ` — stages ${stages.status}, gen ${generated.map((g) => g.status)}, start ${started.status}; league ${leaguePlayed.played}/${leaguePlayed.missed} complete ${doneLeague.status} ranks ${doneLeague.ranks.map((id) => seedOf.get(id))}; confirm ${confirmed.status}/${confirmed.ties}; rungs ${rungs.map((f) => `${seedOf.get(f.home_entrant_id ?? "")}v${seedOf.get(f.away_entrant_id ?? "")}`)}; ladder ${ladderPlayed.played}/${ladderPlayed.missed}, played ${played.map((f) => `${f.status} ${seedOf.get(f.home_entrant_id ?? "")}v${seedOf.get(f.away_entrant_id ?? "")}`)}; complete ${doneLadder.status} ${doneLadder.ranks.map((id) => seedOf.get(id))} division ${doneLadder.divisionCompleted}; again ${again.status}/${again.events}`),
        ok,
      );
    }

    // Check 18 (T25; RB4-S2, RB4-S7): a league of five into a page playoff of the top four, on badminton. RB4-S2: Q1 = 1 v 2, E = 3 v 4,
    // Q2 = Q1's loser v E's winner, Final = Q1's winner v Q2's winner. Seed 2 takes Q1 and seed 4 takes E, Q2 and the final (every
    // result an upset), so a Q2 built from Q1's winner, or a final from E's, would seat the wrong pair. Expected seats are read off the
    // played lines' outcomes; ranks are asserted as COVERAGE only (the four once each, the fifth finisher in none): their ORDER is
    // app-B's (carry C19).
    {
      const { divId, ids } = await division("Page playoff finals", "badminton", 5);
      const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
      const stages = await build(divId, "group_playoffs", 4);
      const [leagueId, pageId] = stages.ids;
      const generated = [await v1(owner, `/api/v1/stages/${leagueId}/generate`, "POST"), await v1(owner, `/api/v1/stages/${pageId}/generate`, "POST")];
      const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
      const leaguePlayed = await playOut("badminton", divId, leagueId, betterSeed(seedOf));
      const doneLeague = await complete(leagueId);
      const confirmed = await seatFrom(pageId);
      const seated = await linesOf(divId, pageId);
      const q1Seated = seated.find((f) => holds(f, ids[0]));
      const eSeated = seated.find((f) => holds(f, ids[2]));
      const roundOne = await playOut("badminton", divId, pageId, (f) => (holds(f, ids[0]) ? ids[1]! : ids[3]!), (f) => f.round_no === 1);
      const afterOne = await linesOf(divId, pageId);
      const q1 = afterOne.find((f) => f.id === q1Seated?.id);
      const e = afterOne.find((f) => f.id === eSeated?.id);
      const q2Seated = afterOne.find((f) => f.round_no === 2);
      const finalWaiting = afterOne.find((f) => f.round_no === 3);
      const rest = await playOut("badminton", divId, pageId, () => ids[3]!);
      const played = await linesOf(divId, pageId);
      const q2 = played.find((f) => f.round_no === 2);
      const final = played.find((f) => f.round_no === 3);
      const doneFinals = await complete(pageId);
      const again = await complete(pageId);
      const ok =
        stages.status === 201 && generated.every((g) => g.status === 200) && started.status === 200 &&
        leaguePlayed.played === 10 && leaguePlayed.missed === 0 && doneLeague.status === 200 && doneLeague.completed && doneLeague.ranks.join() === ids.join() &&
        confirmed.ties === 0 && confirmed.status === 200 &&
        // RB4-S2 seated: four lines — Q1 = 1 v 2 and E = 3 v 4 in round 1, Q2 and the Final empty until their feeders are played
        seated.length === 4 && seated.filter((f) => f.round_no === 1).length === 2 && q1Seated !== undefined && eSeated !== undefined && q1Seated.id !== eSeated.id &&
        pairKey(q1Seated.home_entrant_id, q1Seated.away_entrant_id) === pairKey(ids[0], ids[1]) &&
        pairKey(eSeated.home_entrant_id, eSeated.away_entrant_id) === pairKey(ids[2], ids[3]) &&
        seated.filter((f) => f.round_no > 1).every((f) => f.home_entrant_id === null && f.away_entrant_id === null) &&
        // after Q1 (seed 2 wins) and E (seed 4 wins): Q2 = Q1's loser v E's winner, the Final holds Q1's winner and waits
        roundOne.played === 2 && roundOne.missed === 0 && q1?.outcome?.winner === ids[1] && q1.outcome.loser === ids[0] && e?.outcome?.winner === ids[3] && e.outcome.loser === ids[2] &&
        pairKey(q2Seated?.home_entrant_id, q2Seated?.away_entrant_id) === pairKey(q1.outcome.loser, e.outcome.winner) &&
        pairKey(q2Seated?.home_entrant_id, q2Seated?.away_entrant_id) === pairKey(ids[0], ids[3]) &&
        pairKey(finalWaiting?.home_entrant_id, finalWaiting?.away_entrant_id) === pairKey(q1.outcome.winner, null) &&
        // Q2 and the Final played: the Final = Q1's winner v Q2's winner
        rest.played === 2 && rest.missed === 0 && q2?.outcome?.winner === ids[3] && final?.outcome?.winner === ids[3] &&
        pairKey(final?.home_entrant_id, final?.away_entrant_id) === pairKey(q1.outcome.winner, q2.outcome.winner) &&
        pairKey(final?.home_entrant_id, final?.away_entrant_id) === pairKey(ids[1], ids[3]) &&
        played.every((f) => f.status === "decided") &&
        // ranks: the four qualifiers once each and the fifth finisher in none; the standings cover the same four
        doneFinals.status === 200 && doneFinals.completed && doneFinals.divisionCompleted &&
        doneFinals.ranks.length === 4 && new Set(doneFinals.ranks).size === 4 && doneFinals.ranks.every((id) => ids.slice(0, 4).includes(id)) &&
        !doneFinals.ranks.includes(ids[4]!) &&
        [...(await standingsOrder(pageId))].sort().join() === [...doneFinals.ranks].sort().join() &&
        (await stageStatus(divId, pageId)) === "complete" &&
        again.status === 200 && again.completed && again.events === 0;
      w4Check(
        "w4a T25 page playoff: a league of five into a top four seats Q1 = 1 v 2 and E = 3 v 4, then Q2 = Q1's loser v E's winner and the Final = Q1's winner v Q2's winner, and ranks the four once" +
          (ok ? "" : ` — stages ${stages.status}, gen ${generated.map((g) => g.status)}, start ${started.status}; league ${leaguePlayed.played}/${leaguePlayed.missed} complete ${doneLeague.status} ranks ${doneLeague.ranks.map((id) => seedOf.get(id))}; confirm ${confirmed.status}/${confirmed.ties}; seated ${seated.map((f) => `r${f.round_no} ${seedOf.get(f.home_entrant_id ?? "")}v${seedOf.get(f.away_entrant_id ?? "")}`)}; round one ${roundOne.played}/${roundOne.missed}, Q2 ${seedOf.get(q2Seated?.home_entrant_id ?? "")}v${seedOf.get(q2Seated?.away_entrant_id ?? "")}, final waits ${seedOf.get(finalWaiting?.home_entrant_id ?? "")}v${seedOf.get(finalWaiting?.away_entrant_id ?? "")}; rest ${rest.played}/${rest.missed}, final ${seedOf.get(final?.home_entrant_id ?? "")}v${seedOf.get(final?.away_entrant_id ?? "")}; complete ${doneFinals.status} ${doneFinals.ranks.map((id) => seedOf.get(id))} division ${doneFinals.divisionCompleted}; again ${again.status}/${again.events}`),
        ok,
      );
    }
  }

  // The lanes folded at merge-lanes-1 (see the header): each export builds its own competition.
  await laneChecks(() => w4aDeskK12Check()); // T18 (K12): 6
  await laneChecks(() => w4aDeskXch8Check()); // T21 (AN-1, X-CH-8): 6
  await laneChecks(() => w4KnockoutAPublicStandingsOrderSmoke()); // T23 (ST-G26): 4
  await laneChecks(() => w4KnockoutAB5StandaloneRefusal(owner)); // T16 (X-SP-6): 2
  await laneChecks(() => w4KnockoutAB5PagePlayoffWalkover(owner)); // T17 (X-SP-5): 1
  await laneChecks(() => w4KnockoutAB6aSuite()); // T19 (X-LE-10, K13): 2 + the lane's own count check

  check(`w4a: the W4 knockout app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
