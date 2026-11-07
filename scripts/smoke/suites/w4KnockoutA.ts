// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W4 knockout app-A (spec 2026-11-04-format-matrix-w4-knockout-design.md) — the app PR's smoke proof, over real
 * HTTP against a live server. One counted check per task that owes one, each beside the state it proves.
 *
 * T2 (X-LE-9, K4; owner ruling 257): a Match Day call is a start. A final called to a court keeps both its players when the
 * result of a semi-final that fed it is voided: the void is refused 409 NEXT_MATCH_STARTED and writes nothing.
 *
 * Own fresh owner; keyless; every read and write is a v1 route. Every check is counted, and a run that checked nothing fails.
 * SMOKE_ONLY=w4KnockoutA runs it alone (SELECTABLE_SUITES).
 */
export async function w4KnockoutASuite(): Promise<void> {
  // T2: 1 (a called final survives a void of its feeder).
  const EXPECTED_CHECKS = 1;
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

  /** A badminton knockout of `n` seeded entrants on its own division, generated and Started. */
  async function startedKnockout(s: Session, label: string, n: number) {
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
    const generated = await v1(s, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = await v1(s, `/api/v1/divisions/${divId}/start`, "POST");
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(s, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    return { divId, stageId, generated: generated.status, started: started.status, fixtures };
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

  check(`w4a: the W4 knockout app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
