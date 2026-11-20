// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { BASE, call, check, cookieHeader, newSession, signIn, tag, v1, v1data } from "../harness.ts";
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
 *
 * Task 1 (X-PO-1 <- RB5-P1; X-PO-2 <- RB5-E4/P2; ST-G5, PO-1): pools ride the fold as SEATING (engine 10 `TableStage.pools`). A Started
 * group of six in two pools answers its standings with every seat of both pools, nothing played, no place (level) - before, a pool
 * had no row until a result. And Generate's floor refusal is the engine's (`validatePoolSizes`), read as C38's: three entrants into
 * two groups name no group count (the engine's "one pool" is a League, so `suggested` is null, "add entrants").
 *
 * Task 2 (X-WDT-4 <- RB5-W7; ST-G15 note; C13): the withdrawal footnote's counts are the engine event's, read inside the ONE
 * decision both readers take - the Disqualify/withdraw preview before the write and the stored note the hub prints after it. A league
 * of six, P1 plays 3 of her 5 (RB5-W4) and withdraws: half or more played, so a walkover (RB5-W3) - the preview says 3 of 5 and
 * walkover, the withdrawal walks her other 2 over, and the anonymous hub's footnote reads "left after 3 of 5 ... other 2 matches are
 * walkovers".
 *
 * Task 3 (FX-G1; X-CU-3, X-CU-5, X-RR-5): the catch-up set and the line key ARE the engine's (`lateEntryFixtures`,
 * `roundRobinLineKey`). A league of four, Started (a round-1 line begun): late player L1 owes the four, appended in rounds 4-7 in
 * seed order (every member's earliest round is 1, so listed order decides, RB5-L6); late player L2 then owes the four in rounds
 * 8-11 and L1 last, in round 12 (L1's earliest round is 4, RB5-L16), and no pair is stored twice.
 */
export async function w5RoundRobinBSuite(): Promise<void> {
  // Task 0: 1 (an unequal groups_ko proposal's 7th seat is the runner-up compared on the smallest pool's matches).
  // Task 1: 2 (a Started two-pool group lists every seat level before a result; 3 into 2 groups is refused with no group count).
  // Task 2: 1 (a 3-of-5 leaver: the preview, the walkovers and the hub footnote all say 3 of 5).
  // Task 3: 1 (two late players in a started league of four: rounds 4-7 in seed order, then 8-11 and the first late player at 12).
  // Task 4: 2 (Check 1's proposal stores the engine's basis on the best-Nth slots; the Standings tab prints it under the tables).
  // Task 5: 1 (three pools' top two into the quarter-finals: the stored draw seed, A1 and B1 on byes, C2 v A2 and C1 v B2).
  const EXPECTED_CHECKS = 8;
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
      .sort((a, b) => b.length - a.length || seedOf.get(a[0])! - seedOf.get(b[0])!);
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
    type Basis = { nth: number; matchesCounted: number; dropped: { pool: string; against: string[] }[]; levelWith: string[] };
    type Qual = { rank: number; entrantId: string; source: { group?: string }; pool?: string; basis?: Basis };
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

    // Check 6 - Task 4 (X-UP-3 <- RB5-U3; ST-G3): the best-Nth slots carry the engine's comparison basis and pool. Snake 10 into 4 deals
    // A B C D D C B A A B, so the 3-pools are A and B; k = 3 - 2 = 1 drops each one's 3rd, and every runner-up is compared on 1 match.
    // Every best-Nth seat stores the same basis (one comparison per nth); the group winners store none.
    const want: Basis = { nth: 2, matchesCounted: 1, dropped: [{ pool: "A", against: [three1?.[2] ?? "?"] }, { pool: "B", against: [three2?.[2] ?? "?"] }], levelWith: [] };
    const bestSeats = seats.slice(4);
    const sortDropped = (b?: Basis) => (b ? { ...b, dropped: [...b.dropped].sort((x, y) => x.pool.localeCompare(y.pool)) } : b);
    const basisOk =
      ok && bestSeats.length === 3 && bestSeats.every((q) => JSON.stringify(sortDropped(q.basis)) === JSON.stringify(want)) &&
      seats.slice(0, 4).every((q) => q.basis === undefined) && seventh?.pool === "A";
    w5Check(
      "w5b X-UP-3: each best runner-up slot stores the engine's basis (nth 2, compared on 1 match, each 3-pool's 3rd dropped) and its pool" +
        (basisOk ? "" : ` - seats [${seats.map((q) => `${q.rank}:${q.pool ?? "-"}:${JSON.stringify(q.basis ?? null)}`).join(" ")}]`),
      basisOk,
    );

    // Check 7 - Task 4 (X-UP-3; R24 pick 16 B, C3): the division's Standings tab prints the basis line under the group's tables, in the
    // public dictionary's words (en), and the left-out results behind "Results left out".
    const compSlug = v1data<{ slug?: string } | undefined>(cRes)?.slug;
    const divSlug = v1data<{ slug?: string } | undefined>(dRes)?.slug;
    const orgSlug = ((await call(owner, "/api/orgs")) as { slug: string }[])[0]?.slug ?? "";
    const page = await fetch(`${BASE}/o/${orgSlug}/c/${compSlug}/d/${divSlug}?tab=standings`, { headers: { cookie: cookieHeader(owner) } });
    const html = await page.text();
    const line = "Best runners-up compared on 1 match (results v 3rd in Group A and Group B not counted)";
    const pageOk = page.status === 200 && html.includes('data-testid="standings-bestnth-basis"') && html.includes(line) && html.includes(">Results left out</summary>");
    w5Check(
      `w5b X-UP-3: the Standings tab prints "${line}" under the group's tables, with the results left out behind a disclosure` +
        (pageOk ? "" : ` - page ${page.status} /o/${orgSlug}/c/${compSlug}/d/${divSlug}, basis block ${html.includes("standings-bestnth-basis")}, line ${html.includes(line)}`),
      pageOk,
    );
  }

  // Check 2 - Task 1 (X-PO-1): six seeded entrants into two pools, Started, nobody has played. The rulebook's snake (doc 05 §1) deals
  // A = seeds 1, 4, 5 and B = 2, 3, 6: the stage's standings answer lists all six, three per pool, each with nothing played and no
  // place (a level table, X-TB-6). Before the seating, a pool had no row until a result in it: the answer was empty.
  {
    const dRes = await v1(owner, `/api/v1/competitions/${comp?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Pools day one",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `Po${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const stages = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [{ seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 2 } } }]),
    ) ?? [];
    const stageId = stages[0]?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const sRes = await v1(owner, `/api/v1/stages/${stageId}/standings`);
    type Row = { entrantId: string; rank: number | null; played: number; pool?: string | null };
    const rows = v1data<{ rows: Row[] } | undefined>(sRes)?.rows ?? [];
    const seat = (seeds: number[]) => seeds.map((n) => field[n - 1]?.id).sort().join(",");
    const byPool = new Map<string, string[]>();
    for (const r of rows) byPool.set(r.pool ?? "", [...(byPool.get(r.pool ?? "") ?? []), r.entrantId]);
    const listed = [...byPool.values()].map((ids) => [...ids].sort().join(",")).sort();
    const ok =
      dRes.status === 201 && field.length === 6 && stages.length === 1 && started.status === 200 && sRes.status === 200 && rows.length === 6 &&
      JSON.stringify(listed) === JSON.stringify([seat([1, 4, 5]), seat([2, 3, 6])].sort()) && rows.every((r) => r.played === 0 && r.rank === null);
    w5Check(
      "w5b X-PO-1: a Started two-pool group nobody has played lists all six seats, three per pool as the snake deals them, level (no place, nothing played)" +
        (ok ? "" : ` - div ${dRes.status}, field ${field.length}, stages ${stages.length}, start ${started.status}, standings ${sRes.status} rows ${rows.length} ${JSON.stringify(rows.map((r) => [r.pool, r.rank, r.played]))}`),
      ok,
    );
  }

  // Check 3 - Task 1 (X-PO-2): three entrants into two groups leave a pool of one (the snake: A = 1, B = 2, 3). Generate refuses before
  // writing a line, 422 STAGE_NOT_READY group_too_few_entrants - the engine's floor, whose own answer (one pool) is a League, not a
  // group count, so `suggested` is null and the screens say "add entrants".
  {
    const dRes = await v1(owner, `/api/v1/competitions/${comp?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Pools floor",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 3 }, (_, i) => ({ kind: "individual", display_name: `Fl${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const stages = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [{ seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 2 } } }]),
    ) ?? [];
    const gen = await v1(owner, `/api/v1/stages/${stages[0]?.id}/generate`, "POST");
    const err = (gen.json as { error?: { code?: string; reason?: string; groups?: number; entrants?: number; suggested?: number | null } } | undefined)?.error;
    const written = v1data<unknown[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
    const ok =
      dRes.status === 201 && field.length === 3 && stages.length === 1 && gen.status === 422 && err?.code === "STAGE_NOT_READY" &&
      err.reason === "group_too_few_entrants" && err.groups === 2 && err.entrants === 3 && err.suggested === null && written.length === 0;
    w5Check(
      "w5b X-PO-2: three entrants into two groups are refused by name before a line is written, with no group count to offer (the engine's one pool is a League)" +
        (ok ? "" : ` - div ${dRes.status}, field ${field.length}, stages ${stages.length}, generate ${gen.status} ${JSON.stringify(gen.json).slice(0, 300)}, fixtures ${written.length}`),
      ok,
    );
  }

  // Check 4 - Task 2 (X-WDT-4): one count, the engine's, on both sides of the write. A PUBLIC competition (the hub is read anonymously).
  {
    const pubRes = await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR B note ${tag}`, visibility: "public" });
    const pub = v1data<{ id: string; slug: string } | undefined>(pubRes);
    const dRes = await v1(owner, `/api/v1/competitions/${pub?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Leaver",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `Lv${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const stages = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }]),
    ) ?? [];
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const p1 = field[0]?.id;
    const hers = (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter(
      (f) => f.home_entrant_id === p1 || f.away_entrant_id === p1,
    );
    // P1 wins three of her five lines.
    const scored: number[] = [];
    for (const f of hers.slice(0, 3)) {
      scored.push((await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: f.home_entrant_id === p1 ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } })).status);
    }
    const pv = await v1(owner, `/api/v1/entrants/${p1}/withdrawal-preview?as=withdrawn`);
    const pStage = v1data<{ stages?: { mode: string; played: number; scheduled: number }[] } | undefined>(pv)?.stages?.[0];
    const out = await v1(owner, `/api/v1/entrants/${p1}/withdraw`, "POST");
    const report = v1data<{ policy?: string; walkovers?: number } | undefined>(out);
    const orgSlug = ((await call(owner, "/api/orgs")) as { slug: string }[])[0]?.slug ?? "";
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/hub`);
    type HubTable = { divisionId: string; withdrawalNotes?: { entrantId: string; body: string }[] };
    const notes = (v1data<{ tables?: HubTable[] } | undefined>(hubRes)?.tables ?? []).find((t) => t.divisionId === divId)?.withdrawalNotes ?? [];
    const ok =
      pubRes.status === 201 && dRes.status === 201 && field.length === 6 && stages.length === 1 && started.status === 200 && hers.length === 5 &&
      scored.join(",") === "201,201,201" && pv.status === 200 && pStage?.mode === "award" && pStage.played === 3 && pStage.scheduled === 5 &&
      out.status === 200 && report?.policy === "walkover" && report.walkovers === 2 && hubRes.status === 200 && notes.length === 1 &&
      notes[0]?.entrantId === p1 && notes[0]?.body === "left after 3 of 5, so their results stand and their other 2 matches are walkovers.";
    w5Check(
      "w5b X-WDT-4: a 3-of-5 leaver - the preview says walkover 3 of 5, the withdrawal walks her other 2 over, the hub footnote says 3 of 5" +
        (ok ? "" : ` - comp ${pubRes.status}, div ${dRes.status}, field ${field.length}, stages ${stages.length}, start ${started.status}, hers ${hers.length}, scored ${scored.join(",")}, preview ${pv.status} ${JSON.stringify(pStage ?? null)}, withdraw ${out.status} ${JSON.stringify(report ?? null)}, hub ${hubRes.status} notes ${JSON.stringify(notes)}`),
      ok,
    );
  }

  // Check 5 - Task 3 (X-CU-3, X-CU-5, X-RR-5): two late players, the engine's catch-up order, no pair twice.
  {
    const dRes = await v1(owner, `/api/v1/competitions/${comp?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Late pair",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Lt${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const stages = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }]),
    ) ?? [];
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const fixtures = async () => v1data<(Fx & { round_no: number })[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
    const first = (await fixtures()).find((f) => f.round_no === 1);
    const begun = await v1(owner, `/api/v1/fixtures/${first?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    type Late = { id: string; late_entry?: { case?: string } };
    const add = async (name: string) => {
      const res = await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", [{ kind: "individual", display_name: `${name} ${tag}` }]);
      return { status: res.status, late: (v1data<Late[] | undefined>(res) ?? [])[0] };
    };
    const l1 = await add("L1");
    const l2 = await add("L2");
    const all = await fixtures();
    // Each late player's lines as "opponent:round", in round order, the opponent by seed (1..4) or by name.
    const nameOf = new Map<string, string>([...field.map((e, i) => [e.id, `s${i + 1}`] as const), [l1.late?.id ?? "", "L1"], [l2.late?.id ?? "", "L2"]]);
    const linesOf = (id: string | undefined) =>
      all.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id)
        .sort((a, b) => a.round_no - b.round_no)
        .map((f) => `${nameOf.get((f.home_entrant_id === id ? f.away_entrant_id : f.home_entrant_id) ?? "") ?? "?"}:${f.round_no}`);
    const pairs = all.map((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|"));
    const ok =
      dRes.status === 201 && field.length === 4 && stages.length === 1 && started.status === 200 && begun.status === 201 &&
      l1.status === 201 && l1.late?.late_entry?.case === "catch_up" && l2.status === 201 && l2.late?.late_entry?.case === "catch_up" &&
      linesOf(l1.late?.id).join(",") === "s1:4,s2:5,s3:6,s4:7,L2:12" &&
      linesOf(l2.late?.id).join(",") === "s1:8,s2:9,s3:10,s4:11,L1:12" &&
      all.length === 6 + 4 + 5 && new Set(pairs).size === pairs.length;
    w5Check(
      "w5b X-CU-3/5: two late players in a started league of four - L1 plays the seeds in rounds 4-7 in seed order, L2 plays them in 8-11 and L1 in 12, no pair twice" +
        (ok ? "" : ` - div ${dRes.status}, field ${field.length}, start ${started.status}, begun ${begun.status}, L1 ${l1.status} ${l1.late?.late_entry?.case} [${linesOf(l1.late?.id).join(",")}], L2 ${l2.status} ${l2.late?.late_entry?.case} [${linesOf(l2.late?.id).join(",")}], lines ${all.length}, distinct pairs ${new Set(pairs).size}`),
      ok,
    );
  }

  // Check 8 - Task 5 (FX-G5, ruling 281; X-PD-1 <- RB5-D1, X-PD-6 <- RB5-D6): the groups_ko card's drafts, 12 into 3 pools, Top 6, on the
  // setup path. Snake: A = seeds 1,6,7,12; B = 2,5,8,11; C = 3,4,9,10; the better seed wins every meeting, so A1 = 1, A2 = 6, B1 = 2,
  // B2 = 5, C1 = 3, C2 = 4. Each pool wins by its own margin (A 4-0, B 3-0, C 2-0): with one margin m a pool's winner is +3m and its
  // runner-up +m, so the cross-pool order is A1, B1, C1, A2, B2, C2 with NO tie - a uniform score ties the winners across pools, and
  // the stored seed then draws their order (X-PD-3), which is not this check's question. The engine plan's X-PD-1 row (W5 engine T6): A1, B1, C1, A2, B2, C2 into 8 is drawn A1, B1, C1, A2, C2, B2 -
  // A1 and B1 on byes, C2 v A2 and C1 v B2, i.e. entrant seeds {4, 6} and {3, 5}. differential: the fold's own 8-draw pairs draw seeds
  // 3 v 6 = C1 v C2 (entrant seeds {3, 4}), pool-mates in the quarter-finals.
  {
    // Its own competition: the owner's plan caps the divisions one competition holds, and Checks 1-5 have used the first's.
    const xRes = await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR B cross ${tag}`, visibility: "private" });
    const xComp = v1data<{ id: string } | undefined>(xRes);
    const dRes = await v1(owner, `/api/v1/competitions/${xComp?.id ?? "no-competition"}/divisions`, "POST", {
      name: "Cross pools",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 12 }, (_, i) => ({ kind: "individual", display_name: `Xp${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const seedOf = new Map(field.map((e, i) => [e.id, i + 1]));
    const drafts = buildTemplateStages("groups_ko", { qualified: 6, poolCount: 3, swissRounds: 3, legs: 1 });
    const stages = v1data<{ id: string; kind: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }))),
    ) ?? [];
    const groupId = stages.find((x) => x.kind === "group")?.id;
    const koId = stages.find((x) => x.kind === "knockout")?.id;
    const gens = [(await v1(owner, `/api/v1/stages/${koId}/generate`, "POST")).status, (await v1(owner, `/api/v1/stages/${groupId}/generate`, "POST")).status];
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const fixtures = async () => v1data<(Fx & { round_no: number })[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
    const groupLines = (await fixtures()).filter((x) => x.stage_id === groupId);
    const bestOf = new Map<string, number>();
    for (const f of groupLines) for (const id of [f.home_entrant_id, f.away_entrant_id]) {
      const k = f.pool_id ?? "";
      bestOf.set(k, Math.min(bestOf.get(k) ?? 99, seedOf.get(id ?? "") ?? 99));
    }
    const marginOf = new Map([...bestOf.entries()].sort((a, b) => a[1] - b[1]).map(([k], i) => [k, 4 - i] as const));
    const scored: number[] = [];
    for (const f of groupLines) {
      const homeWins = (seedOf.get(f.home_entrant_id ?? "") ?? 99) < (seedOf.get(f.away_entrant_id ?? "") ?? 99);
      const m = marginOf.get(f.pool_id ?? "") ?? 1;
      scored.push((await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: m, p2Score: 0 } : { p1Score: 0, p2Score: m } })).status);
    }
    const done = await v1(owner, `/api/v1/stages/${groupId}/complete`, "POST");
    const pRes = await v1(owner, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    const proposal = v1data<{ id: string; computed?: { crossPoolDraw?: { seed?: unknown; refused?: unknown } } } | undefined>(pRes);
    const conf = await v1(owner, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal?.id });
    const ko = (await fixtures()).filter((f) => f.stage_id === koId);
    const first = Math.min(...ko.map((f) => f.round_no));
    const r1 = ko.filter((f) => f.round_no === first);
    const pairs = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)
      .map((f) => [seedOf.get(f.home_entrant_id!), seedOf.get(f.away_entrant_id!)].sort((a, b) => (a ?? 0) - (b ?? 0)).join("v")).sort();
    const byes = r1.filter((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null))
      .map((f) => seedOf.get((f.home_entrant_id ?? f.away_entrant_id)!)).sort();
    const ok =
      xRes.status === 201 && dRes.status === 201 && field.length === 12 && stages.length === 2 && gens.join(",") === "200,200" && started.status === 200 &&
      [...marginOf.values()].join(",") === "4,3,2" && scored.length === 18 && scored.every((x) => x === 201) && done.status === 200 && pRes.status === 201 &&
      typeof proposal?.computed?.crossPoolDraw?.seed === "number" && proposal.computed.crossPoolDraw.refused === undefined && conf.status === 200 &&
      pairs.join(",") === "3v5,4v6" && byes.join(",") === "1,2";
    w5Check(
      "w5b X-PD-1: three pools' top two into the quarter-finals - drawn with a stored seed, A1 and B1 on byes, C2 v A2 and C1 v B2, no pool-mates" +
        (ok ? "" : ` - comp ${xRes.status}, div ${dRes.status}, field ${field.length}, stages ${stages.length}, generate ${gens.join(",")}, start ${started.status}, scored ${scored.length} ${[...new Set(scored)].join(",")}, complete ${done.status}, proposal ${pRes.status} ${JSON.stringify(proposal?.computed?.crossPoolDraw ?? null)}, confirm ${conf.status}, round one pairs [${pairs.join(",")}] byes [${byes.join(",")}]`),
      ok,
    );
  }

  check(`w5b: the W5 round-robin app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
