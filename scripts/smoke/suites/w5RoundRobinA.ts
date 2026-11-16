// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W5 round-robin app PR A, Task 2 (X-CU-6 FX-G1 #879; FX-G21) — the smoke proof, over real HTTP against a live
 * server. Own fresh owner; keyless; every read and write is a v1 route (the generic sport needs no key).
 *
 * T2 (X-CU-6, FX-G1): a league of four, generated, then two entrants added before Start and Generate pressed again, owes
 * exactly the six pairs the newcomers add: 6 + 9 = 15 lines, every unordered pair of the six once. Main wrote nine new
 * positional lines that repeated pairs already drawn and left the newcomers' pairs short.
 * T2 (FX-G21): a league of five has a bye each round; the stage's `config.round_byes` names who sat out which round, each
 * entrant once (five rounds, five byes), so an odd field's byes are a stored fact and not a thing every reader re-derives.
 *
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=w5RoundRobinA runs it alone (SELECTABLE_SUITES).
 */
export async function w5RoundRobinASuite(): Promise<void> {
  // T2: 2 (4 -> 6 reconciles by pair; a 5-team league persists its byes).
  const EXPECTED_CHECKS = 2;
  let checked = 0;
  const w5Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w5a_${tag}@resend.dev`);
  const orgId = who.org_id;
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A ${tag}`, visibility: "private" }),
  );

  type Fx = { id: string; stage_id: string; home_entrant_id: string | null; away_entrant_id: string | null; ext_key?: string | null };
  type StageOut = { id: string; config: { round_byes?: { round_no: number; leg: number; entrant_id: string }[] } };

  /** A generic league of `n` entrants, generated once. */
  async function league(label: string, n: number) {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: label,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const addEntrants = async (from: number, to: number) =>
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "individual", display_name: `${label}${from + i} ${tag}`, seed: from + i }))),
      ) ?? [];
    const entrants = await addEntrants(1, n);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: label }),
    )?.id;
    const generate = () => v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    await generate();
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const stage = async () =>
      (v1data<StageOut[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? []).find((s) => s.id === stageId);
    return { divId, entrants, stageId, generate, fixtures, stage, addEntrants };
  }

  // Check 1 — 4 -> 6 before Start: Generate adds the missing pairs and nothing twice.
  {
    const l = await league("Grow", 4);
    const before = await l.fixtures();
    const added = await l.addEntrants(5, 6);
    const res = await l.generate();
    const after = await l.fixtures();
    const pairKeys = after.map((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|"));
    const everyone = [...l.entrants, ...added].map((e) => e.id);
    // The 15 unordered pairs of six, derived from the roster, not from the response.
    const owed = everyone.flatMap((a, i) => everyone.slice(i + 1).map((b) => [a, b].sort().join("|")));
    const ok =
      before.length === 6 && added.length === 2 && res.status === 200 &&
      after.length === 15 && owed.length === 15 &&
      new Set(pairKeys).size === 15 && owed.every((k) => pairKeys.includes(k)) &&
      after.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    w5Check(
      "w5a X-CU-6: a league of four grown to six before Start, then Generate, holds exactly the 15 pairs once each (no repeat, none missing)" +
        (ok ? "" : ` — before ${before.length}, added ${added.length}, status ${res.status}, after ${after.length}, distinct ${new Set(pairKeys).size}, missing ${owed.filter((k) => !pairKeys.includes(k)).length}, org ${orgId}`),
      ok,
    );
  }

  // Check 2 — FX-G21: a five-team league persists one bye per round, each entrant once.
  {
    const l = await league("Odd", 5);
    const stage = await l.stage();
    const byes = stage?.config.round_byes ?? [];
    const rounds = byes.map((b) => b.round_no).sort((a, b) => a - b);
    const sitting = byes.map((b) => b.entrant_id).sort();
    const ok =
      l.entrants.length === 5 && byes.length === 5 &&
      rounds.join(",") === "1,2,3,4,5" &&
      sitting.join(",") === l.entrants.map((e) => e.id).sort().join(",") &&
      byes.every((b) => b.leg === 1);
    w5Check(
      "w5a FX-G21: a five-team league stores its byes (config.round_byes: one per round 1-5, each entrant once, leg 1)" +
        (ok ? "" : ` — entrants ${l.entrants.length}, byes ${JSON.stringify(byes).slice(0, 300)}`),
      ok,
    );
  }

  check(`w5a: the W5 round-robin app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
