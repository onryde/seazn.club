// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

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
 * Own fresh owner; keyless; every read and write is a v1 route. Every check is counted, and a run that checked nothing fails.
 * SMOKE_ONLY=w4KnockoutA runs it alone (SELECTABLE_SUITES).
 */
export async function w4KnockoutASuite(): Promise<void> {
  // T2: 1 (a called final survives a void of its feeder). T3: 1 (an awarded bye holds no court). T4: 1 (the final keeps
  // its slot across an 8 → 9 Rebuild). T5: 1 (Undo refuses across a confirmed draw). T6: 1 (Complete refuses a bracket
  // with its third-place match unplayed).
  const EXPECTED_CHECKS = 5;
  let checked = 0;
  const w4Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
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

  check(`w4a: the W4 knockout app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
