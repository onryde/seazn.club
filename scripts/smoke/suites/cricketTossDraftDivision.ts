// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, ledger, v1, v1data } from "../harness.ts";

/**
 * S2-4 Task 2 (cricket web pad fixes): the toss is a cricket scorer's first write, and it comes BEFORE `core.start`. In a
 * division the organiser has not started (Draft), the scoring door refuses it 422 WRONG_PHASE (Doc 12 §1,
 * `divisionScoringClosed`). The refusal now names why, `error.reason = "division_not_started"`, so the pad can say "The
 * competition hasn't started yet…" instead of the engine's generic phase sentence. Over real HTTP:
 *
 *   1. a toss in a Draft division: 422, WRONG_PHASE, reason division_not_started, and the ledger stays empty;
 *   2. the organiser starts the division, and the SAME toss is accepted (201): the gate was the whole refusal;
 *   3. the engine's own phase guard (a second toss after `core.start`) is WRONG_PHASE with NO reason: the reason is the
 *      division gate's alone, never forwarded for another refusal.
 */
export async function cricketTossDraftDivisionSuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Cricket Draft Toss ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Draft toss",
      sport_key: "cricket",
      variant_key: "t20",
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "team", display_name: `Draft Home ${tag}`, seed: 1, members: [] },
      { kind: "team", display_name: `Draft Away ${tag}`, seed: 2, members: [] },
    ]),
  );
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const gen = v1data<{ fixtures: { id: string }[] }>(await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"));
  const fixtureId = gen.fixtures[0]!.id;
  const toss = { wonBy: ents[0]!.id, elected: "bat" };

  // 1. Draft: refused, and it says why.
  const draft = ledger(admin, fixtureId);
  const refused = await draft.send("cricket.toss", toss);
  const refusal = refused.json.error as { code?: string; reason?: unknown } | undefined;
  check(
    `cricket draft toss: refused 422 WRONG_PHASE with reason division_not_started (got ${refused.status} ${JSON.stringify(refusal)})`,
    refused.status === 422 && refusal?.code === "WRONG_PHASE" && refusal.reason === "division_not_started",
  );
  const events = v1data<unknown[]>(await v1(admin, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`));
  check("cricket draft toss: the refused toss wrote nothing", Array.isArray(events) && events.length === 0);

  // 2. Started: the same toss is recorded.
  const started = await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");
  check(`cricket draft toss: the organiser starts the division (${started.status})`, started.status === 200);
  const accepted = await draft.send("cricket.toss", toss);
  check(`cricket draft toss: the same toss is accepted once started (${accepted.status})`, accepted.status === 201);

  // 3. The engine's own phase refusal carries no reason.
  const kickoff = await draft.send("core.start", {});
  check(`cricket draft toss: core.start accepted (${kickoff.status})`, kickoff.status === 201);
  const late = await draft.send("cricket.toss", toss);
  const lateError = late.json.error as { code?: string; reason?: unknown } | undefined;
  check(
    `cricket draft toss: a toss after the start is the engine's WRONG_PHASE, with no reason (got ${late.status} ${JSON.stringify(lateError)})`,
    late.status === 422 && lateError?.code === "WRONG_PHASE" && lateError.reason === undefined,
  );
}
