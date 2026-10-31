// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md) — the app PR's smoke proof, over real
 * HTTP against a live server. One check per task that owes one, each beside the state it proves.
 *
 * T1 (X-RB-1, #840, FX-G13): Rebuild keeps every time and court at its (pool, round, seq) position, in one transaction,
 * and reports what it could not keep. Own fresh owner; keyless (no DATABASE_URL: every read is a v1 route). Every check
 * is counted, and a run that checked nothing fails. SMOKE_ONLY=w3SwissA runs it alone (SELECTABLE_SUITES).
 */
export async function w3SwissASuite(): Promise<void> {
  // T1: 2 (a rebuild keeps 3 slots; a shrinking rebuild counts the slots it freed).
  const EXPECTED_CHECKS = 2;
  let checked = 0;
  const w3Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w3a_${tag}@resend.dev`);
  const orgId = who.org_id;
  const venueId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `W3a Venue ${tag}` }),
  )?.id;
  const courts: string[] = [];
  for (const name of ["Court 1", "Court 2"]) {
    const court = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/orgs/${orgId}/venues/${venueId}/courts`, "POST", { name }),
    );
    if (court) courts.push(court.id);
  }
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss A ${tag}`, visibility: "private" }),
  );

  type Fx = { id: string; stage_id: string; pool_id: string | null; round_no: number; seq_in_round: number; scheduled_at: string | null; court_id: string | null };
  type Rebuilt = { removed: number; slots?: { kept: number; freed: number; unscheduled: number } };
  const position = (f: Fx) => `${f.pool_id ?? "-"}|${f.round_no}|${f.seq_in_round}`;

  /** A generic league of `names`, generated, with every fixture laid out on its own hour and alternating courts. Returns
   *  the slot this suite wrote per position — the expected values, never read back from the code under test. */
  async function laidOutLeague(s: Session, label: string, names: string[]) {
    const divId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: label,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const entrants =
      v1data<{ id: string }[] | undefined>(
        await v1(s, `/api/v1/divisions/${divId}/entrants`, "POST",
          names.map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: label }),
    )?.id;
    await v1(s, `/api/v1/stages/${stageId}/generate`, "POST");
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(s, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const laid = new Map<string, { scheduled_at: string; court_id: string }>();
    let placed = 0;
    for (const [i, f] of (await fixtures()).entries()) {
      const slot = { scheduled_at: `2030-06-15T${String(8 + i).padStart(2, "0")}:00:00.000Z`, court_id: courts[i % 2] ?? "" };
      const res = await v1(s, `/api/v1/fixtures/${f.id}`, "PATCH", { ...slot, venue_id: venueId });
      if (res.status === 200) placed++;
      laid.set(position(f), slot);
    }
    return { divId, entrants, stageId, fixtures, laid, placed };
  }

  // Check 1 — a pre-Start withdrawal and a late registration: three entrants before and after, so every position
  // survives and every slot with it.
  {
    const league = await laidOutLeague(owner, "Keep", ["A", "B", "C"]);
    await v1(owner, `/api/v1/entrants/${league.entrants[0]?.id}/withdraw`, "POST");
    await v1(owner, `/api/v1/divisions/${league.divId}/entrants`, "POST", [{ kind: "individual", display_name: `D ${tag}`, seed: 4 }]);
    const res = await v1(owner, `/api/v1/stages/${league.stageId}/rebuild`, "POST");
    const out = v1data<Rebuilt | undefined>(res);
    const after = await league.fixtures();
    const kept = after.filter((f) => {
      const want = league.laid.get(position(f));
      return want !== undefined && f.scheduled_at === want.scheduled_at && f.court_id === want.court_id;
    }).length;
    const ok = league.placed === 3 && res.status === 200 && after.length === 3 && kept === 3 && out?.slots?.kept === 3 && out.slots.freed === 0;
    w3Check(
      "w3a X-RB-1: a Rebuild keeps all 3 laid-out slots at their positions, and says so (slots.kept 3, freed 0)" +
        (ok ? "" : ` — placed ${league.placed}, status ${res.status}, after ${after.length}, kept ${kept}, out ${JSON.stringify(out ?? res.json)}`),
      ok,
    );
  }

  // Check 2 — a withdrawal with no replacement: four entrants (6 fixtures) become three (3), so the positions that are
  // gone free their slots. The expected count is the set difference of the positions read before and after.
  {
    const league = await laidOutLeague(owner, "Shrink", ["A", "B", "C", "D"]);
    const before = new Set(league.laid.keys());
    await v1(owner, `/api/v1/entrants/${league.entrants[3]?.id}/withdraw`, "POST");
    const res = await v1(owner, `/api/v1/stages/${league.stageId}/rebuild`, "POST");
    const out = v1data<Rebuilt | undefined>(res);
    const afterPositions = new Set((await league.fixtures()).map(position));
    const gone = [...before].filter((p) => !afterPositions.has(p)).length;
    const fresh = [...afterPositions].filter((p) => !before.has(p)).length;
    const ok =
      league.placed === 6 && res.status === 200 && gone > 0 &&
      out?.slots?.freed === gone && out.slots.unscheduled === fresh && out.slots.kept === afterPositions.size - fresh;
    w3Check(
      `w3a X-RB-1: a shrinking Rebuild counts every slot whose position is gone in slots.freed (${gone} expected)` +
        (ok ? "" : ` — placed ${league.placed}, status ${res.status}, fresh ${fresh}, out ${JSON.stringify(out ?? res.json)}`),
      ok,
    );
  }

  check(`w3a: the W3 Swiss app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
