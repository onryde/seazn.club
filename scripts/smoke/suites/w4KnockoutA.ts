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
 * Own fresh owner; keyless; every read and write is a v1 route. Every check is counted, and a run that checked nothing fails.
 * SMOKE_ONLY=w4KnockoutA runs it alone (SELECTABLE_SUITES).
 */
export async function w4KnockoutASuite(): Promise<void> {
  // T2: 1 (a called final survives a void of its feeder). T3: 1 (an awarded bye holds no court). T4: 1 (the final keeps
  // its slot across an 8 → 9 Rebuild).
  const EXPECTED_CHECKS = 3;
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

  check(`w4a: the W4 knockout app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
