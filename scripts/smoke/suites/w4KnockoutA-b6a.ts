// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W4 knockout app-A, lane B6a (Tasks 19 + 20) — the lane's smoke proof, over real HTTP against a live server.
 * Wired at the lane merge (merge 2, 2026-11-09): `w4KnockoutASuite` runs `w4KnockoutAB6aSuite` and counts the harness
 * checks it made (`laneChecks`, 3: the two below plus this file's own count check), so SMOKE_ONLY=w4KnockoutA runs it. Every read and write is a v1 route; every check is counted, and a run that checked
 * nothing fails.
 *
 * T19 (X-LE-10, K13; ruling 271; R24 pick 2B): what the desk's late-entry controls read off the server.
 *  - A Reinstate's reply says what happened to the player: PATCH {status: "registered"} answers `late_entry` — `waiting` for a
 *    player whose seat the tap can give back, never a placement. The tap's answer names whose seat it took
 *    (`withdrawn_id`): their OWN seat is "back in their place", someone else's is "takes {withdrawn}'s place".
 *  - A Reinstate whose place has been PLAYED ON is answered `refused` with KO_LATE_ENTRY_PLAYED_ON and marks nobody: the
 *    desk's "Waiting to join the bracket" strip never lists a player the tap can only refuse, and a tap is 409
 *    KO_LATE_ENTRY_NOT_WAITING.
 *
 * T20 (X-SD-7) is a page line ("Draw #…" under the stage header) read from the ledger on the division page; no v1 route
 * serves it, so it has no HTTP check here (unit: `knockout-late-entry-wiring.test.tsx`; e2e: `w4-knockout-app-a-b6a.spec.ts`).
 */
export async function w4KnockoutAB6aSuite(): Promise<void> {
  // T19: 2 (a reinstate answers `waiting` and the tap names the player's own seat; a played-on reinstate is refused and unmarked).
  const EXPECTED_CHECKS = 2;
  let checked = 0;
  const b6aCheck = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  await signIn(owner, `delivered+w4a_b6a_${tag}@resend.dev`);
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout A b6a ${tag}`, visibility: "private" }),
  );

  type Fx = {
    id: string;
    stage_id: string;
    round_no: number;
    seq_in_round: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    status?: string;
  };
  type LateEntry = { format?: string; case?: string; reason?: string; fixture_id?: string; opponent_id?: string; withdrawn_id?: string; entrant_id?: string } | undefined;

  /** A badminton knockout of eight seeded entrants on its own division, generated and Started. */
  async function startedKnockout(s: Session, label: string) {
    const divId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    await v1(
      s,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `${label} P${i + 1} ${tag}`, seed: i + 1 })),
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

  /** The scorer wins `fixtureId` for the home side, two games to love. */
  async function homeWins(s: Session, fixtureId: string): Promise<void> {
    await appendScoreEvent(s, fixtureId, "core.start", {});
    await appendScoreEvent(s, fixtureId, "badminton.game.summary", { home: 21, away: 10 });
    await appendScoreEvent(s, fixtureId, "badminton.game.summary", { home: 21, away: 12 });
  }

  // Check 1 (T19): eight seeded Started; round 1's first line loses its home player (walked over), who is reinstated. Expected
  // (ruling 271, R24 pick 2B): the PATCH reply says `waiting` (nothing placed); the tap gives back THEIR OWN seat — the reply's
  // `withdrawn_id` is the player themself, which the desk says as "back in their place" — against the same opponent.
  {
    const ko = await startedKnockout(owner, "Reinstate reply");
    const line0 = (await ko.fixtures()).find((f) => f.round_no === 1 && f.seq_in_round === 1);
    const gone = line0?.home_entrant_id ?? undefined;
    const withdrawn = gone ? await v1(owner, `/api/v1/entrants/${gone}/withdraw`, "POST") : undefined;
    const back = gone ? await v1(owner, `/api/v1/entrants/${gone}`, "PATCH", { status: "registered" }) : undefined;
    const reply = back ? v1data<{ late_entry?: LateEntry } | undefined>(back)?.late_entry : undefined;
    const tap = gone ? await v1(owner, `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`, "POST") : undefined;
    const placed = tap ? v1data<LateEntry>(tap) : undefined;
    const ok =
      ko.generated === 200 && ko.started === 200 && line0 !== undefined && gone !== undefined && withdrawn?.status === 200 &&
      back?.status === 200 && reply?.format === "knockout" && reply.case === "waiting" &&
      tap?.status === 200 && placed?.case === "withdrawn_slot" && placed.withdrawn_id === gone && placed.opponent_id === line0.away_entrant_id;
    b6aCheck(
      "w4a-b6a X-LE-10: a Reinstate answers `waiting`, and the tap names the player's OWN seat (withdrawn_id) against the same opponent" +
        (ok ? "" : ` — withdraw ${withdrawn?.status ?? "-"}, reinstate ${back?.status ?? "-"} ${JSON.stringify(reply)}, tap ${tap?.status ?? "-"} ${JSON.stringify(placed)}`),
      ok,
    );
  }

  // Check 2 (T19): eight seeded Started; round 1's first line loses its home player, whose walkover puts the opponent into the
  // final-bound line behind it; the OTHER round-1 line and that next line are then played to a result. Reinstating the departed
  // player now: the place they left has been played on, so the answer is `refused` / KO_LATE_ENTRY_PLAYED_ON, nobody is
  // marked, and a tap is 409 KO_LATE_ENTRY_NOT_WAITING (the desk never lists a player the tap can only refuse).
  {
    const ko = await startedKnockout(owner, "Played on");
    const rows = await ko.fixtures();
    const line0 = rows.find((f) => f.round_no === 1 && f.seq_in_round === 1);
    const line1 = rows.find((f) => f.round_no === 1 && f.seq_in_round === 2);
    const gone = line0?.home_entrant_id ?? undefined;
    const withdrawn = gone ? await v1(owner, `/api/v1/entrants/${gone}/withdraw`, "POST") : undefined;
    if (line1) await homeWins(owner, line1.id);
    const next = (await ko.fixtures()).find((f) => f.round_no === 2 && f.seq_in_round === 1);
    const nextSeated = next?.home_entrant_id !== null && next?.away_entrant_id !== null;
    if (next && nextSeated) await homeWins(owner, next.id);
    const back = gone ? await v1(owner, `/api/v1/entrants/${gone}`, "PATCH", { status: "registered" }) : undefined;
    const reply = back ? v1data<{ late_entry?: LateEntry } | undefined>(back)?.late_entry : undefined;
    const tap = gone ? await v1(owner, `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`, "POST") : undefined;
    const tapCode = (tap?.json as { error?: { code?: string } } | undefined)?.error?.code;
    const ok =
      ko.generated === 200 && ko.started === 200 && line0 !== undefined && line1 !== undefined && gone !== undefined && withdrawn?.status === 200 &&
      next !== undefined && nextSeated &&
      back?.status === 200 && reply?.format === "knockout" && reply.case === "refused" && reply.reason === "KO_LATE_ENTRY_PLAYED_ON" &&
      tap?.status === 409 && tapCode === "KO_LATE_ENTRY_NOT_WAITING";
    b6aCheck(
      "w4a-b6a X-LE-10: a Reinstate whose place was played on is `refused` (PLAYED_ON), marks nobody, and the tap is KO_LATE_ENTRY_NOT_WAITING" +
        (ok ? "" : ` — withdraw ${withdrawn?.status ?? "-"}, next seated ${nextSeated}, reinstate ${back?.status ?? "-"} ${JSON.stringify(reply)}, tap ${tap?.status ?? "-"} ${tapCode ?? "-"}`),
      ok,
    );
  }

  check(`w4a-b6a: the lane B6a smoke suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
