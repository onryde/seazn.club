// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, counts, newSession, signIn, tag, v1, v1data } from "../harness.ts";
import { swissDrawSeed, swissRoundOneOrder } from "../../../apps/web/src/lib/swiss-draw.ts";
import { w4KnockoutAB5PagePlayoffWalkover, w4KnockoutAB5StandaloneRefusal } from "./w4KnockoutA-b5.ts";
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
 * KO_LATE_ENTRY_NOT_UNDOABLE. Eight seeded: no bye, so the add is refused 409 KO_LATE_ENTRY_NO_SLOT (can_rebuild, nothing
 * written); once a round-1 player withdraws, the next add takes that seat and the withdrawal's walkover is reversed.
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
 * The lanes folded at the lane merge (merge-lanes-1, 2026-11-09) keep their checks in their own files and are counted
 * here by the harness checks each one made (`laneChecks`): B-desk's T18 (K12: a disqualification walkover says so, 6)
 * and T21 (X-CH-8: a decided final asks to complete its stage, completing the competition warns, 6), B6b's T23 (ST-G26:
 * /present reads a group's pools in order, 4), and B5's T16 (X-SP-6: a standalone stepladder or page playoff is refused
 * by name, 2) and T17 (X-SP-5: a page-playoff withdrawal walks over, never voids, 1).
 *
 * Own fresh owner; keyless; every read and write is a v1 route (B5's T17 reads the feed edges from the table, which no
 * route publishes; B-desk's and B6b's sign in their own organisers and read pages). Every check is counted, and a run
 * that checked nothing fails. SMOKE_ONLY=w4KnockoutA runs it alone (SELECTABLE_SUITES).
 */
export async function w4KnockoutASuite(): Promise<void> {
  // T2: 1 (a called final survives a void of its feeder). T3: 1 (an awarded bye holds no court). T4: 1 (the final keeps
  // its slot across an 8 → 9 Rebuild). T5: 1 (Undo refuses across a confirmed draw). T6: 1 (Complete refuses a bracket
  // with its third-place match unplayed). T7: 1 (an unseeded draw replays). T8: 2 (6 → 7 places in a bye; 8 → 9 redraws
  // once). T10: 2 (a late player takes the lowest-seeded holder's bye and Undo refuses; no slot is refused, then a
  // withdrawn seat is taken). T11: 1 (a reinstated player waits, and one tap gives their seat back). T13: 1 (a departed
  // qualifier's seat takes the best loser below the cut). T14: 1 (a correction empties a confirmed draw's seats and re-proposes).
  // T15: 2 (a plate on 3 is refused, then starts on 4; a cut of 3 from a knockout leaves no stage). The lanes folded at
  // merge-lanes-1, counted by `laneChecks`: T18 6, T21 6, T23 4, T16 2, T17 1 — 19.
  const EXPECTED_CHECKS = 15 + 19;
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

  // Check 10 (T10, X-LE-6 then X-LE-5): eight seeded players Started — round 1 full. Expected: the add is refused 409
  // KO_LATE_ENTRY_NO_SLOT with Rebuild offered (nothing has started) and nothing written (eight entrants still). Then
  // round 1's second line loses its away player (the cascade walks it over): the next add takes that seat against the
  // line's home player, and the line is an unplayed match again.
  {
    const ko = await startedKnockout(owner, "Late slot", 8);
    const refused = await addLate(ko.divId, "Late slot P9");
    const refusedErr: LateError = refused.json?.error;
    const count = (await entrantsOf(ko.divId)).length;
    const line0 = (await ko.fixtures()).find((f) => f.round_no === 1 && f.seq_in_round === 2);
    const withdrawn = line0?.away_entrant_id ? await v1(owner, `/api/v1/entrants/${line0.away_entrant_id}/withdraw`, "POST") : undefined;
    const walked = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const added = await addLate(ko.divId, "Late slot P10");
    const late = v1data<{ id?: string; late_entry?: LateEntry } | undefined>(added);
    const line = (await ko.fixtures()).find((f) => f.id === line0?.id);
    const ok =
      ko.started === 200 && refused.status === 409 && refusedErr?.code === "KO_LATE_ENTRY_NO_SLOT" && refusedErr.can_rebuild === true &&
      count === 8 && line0 !== undefined && withdrawn?.status === 200 && walked?.status === "forfeited" &&
      added.status === 201 && late?.late_entry?.case === "withdrawn_slot" && late.late_entry.fixture_id === line0.id &&
      late.late_entry.opponent_id === line0.home_entrant_id &&
      line?.home_entrant_id === line0.home_entrant_id && line?.away_entrant_id === late.id && line?.status === "scheduled";
    w4Check(
      "w4a X-LE-5: a full round 1 refuses a late player (KO_LATE_ENTRY_NO_SLOT, Rebuild offered, nothing written); after a withdrawal the next takes the seat" +
        (ok ? "" : ` — start ${ko.started}, refused ${refused.status} ${JSON.stringify(refusedErr)}, entrants ${count}, withdraw ${withdrawn?.status ?? "-"}, walked ${walked?.status ?? "-"}, add ${added.status} ${JSON.stringify(added.json).slice(0, 200)}, line ${JSON.stringify(line).slice(0, 160)}`),
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

  // The lanes folded at merge-lanes-1 (see the header): each export builds its own competition.
  await laneChecks(() => w4aDeskK12Check()); // T18 (K12): 6
  await laneChecks(() => w4aDeskXch8Check()); // T21 (AN-1, X-CH-8): 6
  await laneChecks(() => w4KnockoutAPublicStandingsOrderSmoke()); // T23 (ST-G26): 4
  await laneChecks(() => w4KnockoutAB5StandaloneRefusal(owner)); // T16 (X-SP-6): 2
  await laneChecks(() => w4KnockoutAB5PagePlayoffWalkover(owner)); // T17 (X-SP-5): 1

  check(`w4a: the W4 knockout app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
