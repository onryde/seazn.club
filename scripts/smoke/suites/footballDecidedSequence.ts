// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";

/**
 * S13/W11 pass 2 (coordinator review) — a ONE-event smoke (generic.result,
 * below) passes even if the server's fold never advances past its own first
 * successful append: exactly the shape of the nine-defect S12/#421 chain,
 * where the pad's own fold stalled after event one and the first event
 * landing alone made every sport look scoreable. This proves the append path
 * genuinely ADVANCES: each event's ack must reflect the CUMULATIVE effect of
 * everything posted before it, not just its own 201.
 *
 * Sport: football — a decided result genuinely needs a sequence no single
 * event can replace (packages/engine/src/sports/football/football.ts, read
 * directly, not assumed): `football.goal` only tallies a score
 * (`creditGoal`); `outcome` is computed ONLY by `resolveFullTime`, reached
 * ONLY through `football.period{phase:"FT"}`, which is legal ONLY from phase
 * "H2" — reached ONLY through `football.period{phase:"HT"}` from phase "H1"
 * — reached ONLY through `core.start`. Four events, each gated on the
 * previous one's real effect:
 *   1. core.start          — phase "pre" -> "H1"                (WRONG_PHASE otherwise)
 *   2. football.goal        — tallies the goal that decides it    (needs a play phase)
 *   3. football.period{HT}  — phase "H1" -> "H2"                  (WRONG_PHASE otherwise)
 *   4. football.period{FT}  — resolves from the ACCUMULATED score (WRONG_PHASE otherwise)
 * `football.goal`/`football.period` sit at fidelity band 0 in football's
 * `padSpec(cfg).fidelity`. W1 (entitlements v18, 2026-09-02) made every band
 * free on every plan — `fidelity.ts`'s `requiredFeatureForEvent`, which used
 * to treat tier 0/1 as free and gate the rest, is deleted — so this sequence
 * needed no Pro entitlement even before, and needs none now. It still runs
 * on the Pro org only, matching the coordinator's own scope for this pass;
 * the free path keeps proving the one-shot minimal path in
 * `scorePadV2AppendSuite`, unchanged.
 *
 * `expected_seq` for event N+1 is read from event N's OWN ack `seq` field —
 * never from a fresh GET .../state, and never through `appendScoreEvent`'s
 * retry loop. A 409 here is asserted as a FAILURE (a real sequencing defect
 * on a single-writer run), never silently retried: a repair mechanism that
 * always succeeds would hide exactly the class of bug this suite exists to
 * catch — the coordinator's own point, kept intact rather than smoothed over.
 */
export async function footballDecidedSequenceSuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `ScorePad Sequence ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Sequence",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "team", display_name: `Seq Home ${tag}`, seed: 1, members: [] },
      { kind: "team", display_name: `Seq Away ${tag}`, seed: 2, members: [] },
    ]),
  );
  const homeId = ents[0].id;
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const fx = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0].id;
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  // A raw, NON-retrying post — deliberately not `appendScoreEvent` (see the
  // doc above: leaning on its 409 retry here would hide a sequencing defect
  // rather than catch one).
  const post = (expectedSeq: number, type: string, payload: unknown) =>
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: expectedSeq,
      type,
      payload,
      idempotency_key: `smoke-seq-${tag}-${fx}-${type}-${expectedSeq}`,
    });

  // 1. core.start — expected_seq is statically known (0): this fixture was
  // just generated and has never had an event posted, so no read is needed.
  const started = await post(0, "core.start", {});
  check("football sequence: core.start accepted (201, not a 409 on a fresh fixture)", started.status === 201);
  const startedData = v1data<{ seq: number; status: string; outcome: unknown }>(started);
  check(
    "football sequence: core.start's own ack reports in_play (state genuinely advanced)",
    startedData.status === "in_play" && startedData.outcome === null,
  );

  // 2. football.goal — expected_seq comes from event 1's OWN ack, never a
  // fresh read.
  const goal = await post(startedData.seq, "football.goal", { by: homeId });
  check(
    "football sequence: football.goal accepted using core.start's ack seq (201, not 409)",
    goal.status === 201,
  );
  const goalData = v1data<{
    seq: number;
    outcome: unknown;
    state_summary: { headline: string };
  }>(goal);
  check("football sequence: seq advanced by exactly one", goalData.seq === startedData.seq + 1);
  check(
    "football sequence: the ack's OWN scoreline reflects the goal just posted (1-0), not the pre-goal 0-0",
    goalData.state_summary.headline === "1 — 0" && goalData.outcome === null,
  );

  // 3. football.period{HT} — legal only from phase "H1", which ONLY event 1
  // set; expected_seq comes from event 2's ack.
  const half = await post(goalData.seq, "football.period", { phase: "HT" });
  check(
    "football sequence: HT marker accepted using the goal's ack seq (201, not 409) — proves phase H1 (set by core.start) carried forward through the goal",
    half.status === 201,
  );
  const halfData = v1data<{ seq: number; state_summary: { detail: { periods: unknown[] } } }>(half);
  check(
    "football sequence: a second period opened (H1 -> H2) — the phase transition genuinely applied",
    Array.isArray(halfData.state_summary.detail.periods) && halfData.state_summary.detail.periods.length === 2,
  );

  // 4. football.period{FT} — resolves from the ACCUMULATED score (1-0),
  // which lands correctly only if every prior append actually threaded
  // through; expected_seq comes from event 3's ack.
  const full = await post(halfData.seq, "football.period", { phase: "FT" });
  check("football sequence: FT marker accepted using the HT ack seq (201, not 409)", full.status === 201);
  const fullData = v1data<{ seq: number; status: string; outcome: unknown }>(full);
  const outcome = fullData.outcome as { kind?: string; winner?: string } | null;
  check(
    "football sequence: full time DECIDES from the score the goal event built (home wins, not a draw)",
    fullData.status === "decided" && outcome?.kind === "win" && outcome?.winner === homeId,
  );
}
