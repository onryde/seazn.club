// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { check, newSession, signIn, tag, v1, v1data } from "../harness.ts";
import { buildTemplateStages } from "../../../apps/web/src/lib/format-templates.ts";

/**
 * Format matrix W5 round-robin app PR B — the smoke proofs, over real HTTP against a live server. Own fresh owner; keyless; every
 * read and write is a v1 route (the generic sport needs no key).
 *
 * Task 0 (G4; X-UP-1 <- RB5-U1, ruling 286; ST-G3): the groups_ko card's own drafts over ten entrants (four pools: 3, 3, 2 and 2),
 * Top 7 on the setup path, so the knockout takes every pool's winner and the best three of the four runners-up. Engine 10 compares
 * the runners-up of the larger pools without their result against their pool's bottom row, and refuses a larger pool that hands no
 * results (STAGE_NOT_READY pool_results_missing): the bump alone answered the group's Complete with STAGE_COMPLETED_SEEDING_FAILED
 * and proposed nothing; engine 9 compared full rows and seated the other 3-pool's runner-up. The scores are chosen so the two
 * answers differ (derived below from the rulebook, never from the product's own table): the proposal's 7th seat is the first
 * 3-pool's runner-up, and the second 3-pool's runner-up is out.
 */
export async function w5RoundRobinBSuite(): Promise<void> {
  // Task 0: 1 (an unequal groups_ko proposal's 7th seat is the runner-up compared on the smallest pool's matches).
  const EXPECTED_CHECKS = 1;
  let checked = 0;
  const w5Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  await signIn(owner, `delivered+w5b_${tag}@resend.dev`);
  const cRes = await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR B ${tag}`, visibility: "private" });
  const comp = v1data<{ id: string } | undefined>(cRes);

  type Fx = { id: string; stage_id: string; pool_id?: string | null; home_entrant_id: string | null; away_entrant_id: string | null };

  // Check 1 - Task 0 (X-UP-1): within a pool, place 0 is the best seed. 3-pools: 0 beats 1 and 2, 1 beats 2. The first 3-pool (the
  // one holding the better top seed) plays 0-1 2-0, 0-2 2-0, 1-2 5-0; the second 0-1 3-0, 0-2 2-0, 1-2 4-0. 2-pools: 0 beats 1, 3-2 in
  // the first, 2-1 in the second. Generic's cross-group order is points, diff, for, lots (its group cascade less head-to-head).
  // RB5-U1 (k = 3 - 2 = 1): a 3-pool runner-up is compared without its win over its bottom row:
  //   first 3-pool 0 pts, diff -2 | second 3-pool 0, -3 | first 2-pool 0, -1, for 2 | second 2-pool 0, -1, for 1
  //   -> seats 5-7: the first 2-pool's, the second 2-pool's, the first 3-pool's runner-up; the second 3-pool's is out.
  // Engine 9 (full rows): the 3-pool runners-up lead on 3 points, so the 7th seat went to the first 2-pool's runner-up.
  {
    const dRes = await v1(owner, `/api/v1/competitions/${comp?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Unequal",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 10 }, (_, i) => ({ kind: "individual", display_name: `Un${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const seedOf = new Map(field.map((e, i) => [e.id, i + 1]));
    const drafts = buildTemplateStages("groups_ko", { qualified: 7, poolCount: 4, swissRounds: 3, legs: 1 });
    const stages = v1data<{ id: string; kind: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST",
        drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }))),
    ) ?? [];
    const groupId = stages.find((x) => x.kind === "group")?.id;
    const koId = stages.find((x) => x.kind === "knockout")?.id;
    const koGen = await v1(owner, `/api/v1/stages/${koId}/generate`, "POST");
    const grGen = await v1(owner, `/api/v1/stages/${groupId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const lines = (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === groupId);
    // Each pool's members in seed order, from the lines' own pool ids; the pools ordered by size, then by their best seed.
    const byPool = new Map<string, Set<string>>();
    for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) byPool.set(f.pool_id ?? "", (byPool.get(f.pool_id ?? "") ?? new Set()).add(id));
    const pools = [...byPool.values()]
      .map((s) => [...s].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!))
      .sort((a, b) => b.length - a.length || seedOf.get(a[0]!)! - seedOf.get(b[0]!)!);
    const [three1, three2, two1, two2] = pools;
    // [pool, [winner's place, loser's place, [winner's score, loser's score]][]]
    const plan: [string[] | undefined, [number, number, [number, number]][]][] = [
      [three1, [[0, 1, [2, 0]], [0, 2, [2, 0]], [1, 2, [5, 0]]]],
      [three2, [[0, 1, [3, 0]], [0, 2, [2, 0]], [1, 2, [4, 0]]]],
      [two1, [[0, 1, [3, 2]]]],
      [two2, [[0, 1, [2, 1]]]],
    ];
    const scored: number[] = [];
    for (const [members, meetings] of plan) {
      for (const [w, l, [ws, ls]] of meetings) {
        const [winner, loser] = [members?.[w], members?.[l]];
        const f = lines.find((x) => (x.home_entrant_id === winner && x.away_entrant_id === loser) || (x.home_entrant_id === loser && x.away_entrant_id === winner));
        if (f === undefined) { scored.push(-1); continue; }
        scored.push((await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
          expected_seq: 0, type: "generic.result", payload: f.home_entrant_id === winner ? { p1Score: ws, p2Score: ls } : { p1Score: ls, p2Score: ws } })).status);
      }
    }
    const done = await v1(owner, `/api/v1/stages/${groupId}/complete`, "POST");
    const completed = v1data<{ completed?: boolean; seed_proposal?: { id: string; status: string } | null } | undefined>(done);
    // The completion proposed the knockout (setup path); asked again, the recompute answers the same draft's computed seats.
    const pRes = await v1(owner, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    type Qual = { rank: number; entrantId: string; source: { group?: string } };
    const proposal = v1data<{ status?: string; computed?: { qualifiers?: Qual[] } } | undefined>(pRes);
    const seats = [...(proposal?.computed?.qualifiers ?? [])].sort((a, b) => a.rank - b.rank);
    const seventh = seats[6];
    const winners = new Set(pools.map((p) => p[0]));
    const ok =
      cRes.status === 201 && dRes.status === 201 && field.length === 10 && stages.length === 2 && koGen.status === 200 && grGen.status === 200 &&
      started.status === 200 && lines.length === 3 + 3 + 1 + 1 && JSON.stringify(pools.map((p) => p.length)) === "[3,3,2,2]" &&
      scored.length === 8 && scored.every((c) => c === 201) && done.status === 200 && completed?.completed === true &&
      completed.seed_proposal?.status === "draft" && pRes.status === 201 && proposal?.status === "draft" && seats.length === 7 &&
      seats.slice(0, 4).every((q) => winners.has(q.entrantId)) &&
      JSON.stringify(seats.slice(4).map((q) => q.entrantId)) === JSON.stringify([two1?.[1], two2?.[1], three1?.[1]]) &&
      seventh?.entrantId === three1?.[1] && seventh.source.group === undefined && !seats.some((q) => q.entrantId === three2?.[1]);
    w5Check(
      "w5b X-UP-1: an unequal groups_ko (3/3/2/2, Top 7) proposes its 7th seat to the 3-pool runner-up compared without its win over the bottom row; the other 3-pool's runner-up is out" +
        (ok ? "" : ` - comp ${cRes.status}, div ${dRes.status}, field ${field.length}, stages ${stages.length}, gen ${koGen.status}/${grGen.status}, start ${started.status}, lines ${lines.length}, pools [${pools.map((p) => p.map((id) => seedOf.get(id)).join("/")).join(" ")}], scored ${scored.join(",")}, complete ${done.status} ${JSON.stringify(done.json).slice(0, 300)}, proposal ${pRes.status} [${seats.map((q) => `${q.rank}:${seedOf.get(q.entrantId)}${q.source.group ?? "*"}`).join(" ")}]`),
      ok,
    );
  }

  check(`w5b: the W5 round-robin app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
