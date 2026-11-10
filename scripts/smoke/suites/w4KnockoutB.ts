// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of ../harness.ts.
import { appendScoreEvent, check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W4 knockout app PR B - smoke checks over real HTTP against a live server. One counted check per task that
 * owes one; the suite's own count below fails a run that executed fewer.
 *
 * B1 (T3; X-FR-4, rulings 266/267): Complete's `stage_completed` event carries `finalRanks` as entrant ids in rank order
 * (what every client, the bench and the matrix read) AND `places` with the ranks - a knockout of four without a third-place
 * match ranks its two semi-final losers level, 3rd: [1, 2, 3, 3] - and `title`, the champion. Expected values are the
 * rulebook's and the fixture rows this check reads before the Complete; none comes from the Complete answer.
 *
 * B3b (T8; X-PL-5, X-PL-2): the plate (Knockout + Plate's consolation bracket, taking every FIRST loss) is proposed after round
 * two - n=5: refused while the field is open (after round 1), proposed for the first losers E3 and E5 while the main final is
 * unplayed - and a plate whose field is under two completes BY NAME (n=4, one withdrawal: the walkover winner wins the final, so
 * E4 is the only first loser) with no lines, and the division then completes.
 */
export async function w4KnockoutBSuite(): Promise<void> {
  const EXPECTED_CHECKS = 3;
  let checked = 0;
  const w4Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  await signIn(owner, `delivered+w4b_${tag}@resend.dev`);
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout B ${tag}`, visibility: "private" }),
  );

  // Check 1 (T3, X-FR-4): a four-player badminton knockout, every line won by the home side.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Places", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `W4B P${i + 1} ${tag}`, seed: i + 1 })));
    const stageId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Places", config: {} }))?.id;
    const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    type Fx = { id: string; stage_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null; outcome?: { winner?: string } | null };
    const lines = async () => (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const homeWins = async (id: string) => {
      await appendScoreEvent(owner, id, "core.start", {});
      await appendScoreEvent(owner, id, "badminton.game.summary", { home: 21, away: 10 });
      await appendScoreEvent(owner, id, "badminton.game.summary", { home: 21, away: 12 });
    };
    for (const f of (await lines()).filter((l) => l.round_no === 1)) await homeWins(f.id);
    const semis = (await lines()).filter((l) => l.round_no === 1);
    const final = (await lines()).find((l) => l.round_no === 2);
    if (final) await homeWins(final.id);
    // Expected, from the rows alone: the final's home side won it; the semi-final losers are the away sides of round 1.
    const finalAfter = (await lines()).find((l) => l.round_no === 2);
    const champion = finalAfter?.home_entrant_id;
    const runnerUp = finalAfter?.away_entrant_id;
    const semiLosers = semis.map((s) => s.away_entrant_id).sort();
    const done = await v1(owner, `/api/v1/stages/${stageId}/complete`, "POST");
    type Done = { completed?: boolean; events?: { type: string; finalRanks?: string[]; places?: { entrantId: string; rank: number }[]; title?: { kind?: string; champion?: string } }[] };
    const ev = v1data<Done | undefined>(done)?.events?.find((e) => e.type === "stage_completed");
    const ranks = ev?.finalRanks ?? [];
    const places = ev?.places ?? [];
    const ok =
      generated.status < 300 &&
      started.status < 300 &&
      champion != null &&
      ranks.length === 4 &&
      ranks.every((id) => typeof id === "string") &&
      ranks[0] === champion &&
      ranks[1] === runnerUp &&
      JSON.stringify(ranks.slice(2).sort()) === JSON.stringify(semiLosers) &&
      JSON.stringify(places.map((p) => p.rank)) === JSON.stringify([1, 2, 3, 3]) &&
      JSON.stringify(places.map((p) => p.entrantId)) === JSON.stringify(ranks) &&
      ev?.title?.kind === "champion" &&
      ev.title.champion === champion;
    w4Check(
      "w4b T3 (X-FR-4): Complete on a four-player knockout answers finalRanks as ids, places [1,2,3,3] with the semi-final losers level 3rd, and the champion title" +
        (ok ? "" : ` - generate ${generated.status}, start ${started.status}, complete ${done.status}, ranks ${ranks.length}, places ${places.map((p) => p.rank).join(",")}, title ${JSON.stringify(ev?.title)}`),
      ok,
    );
  }

  // Shared by checks 2 and 3: a badminton Knockout + Plate division of `n` seeded players, started; the better seed wins every line.
  type PFx = { id: string; stage_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null; status: string };
  const plateDivision = async (label: string, n: number) => {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    const ents = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `W4B ${label} E${i + 1} ${tag}`, seed: i + 1 }))),
    );
    const mainId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main", config: {} }))?.id;
    const plateId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "firstLosses" }] }], placement: "rank_order", timing: "setup" },
      }),
    )?.id;
    await v1(owner, `/api/v1/stages/${mainId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const seedOf = new Map((ents ?? []).map((e, i) => [e.id, i + 1] as const));
    const lines = async (stageId: string | undefined) => (v1data<PFx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const playRound = async (round: number, pick?: (f: PFx) => string) => {
      for (const f of (await lines(mainId)).filter((l) => l.round_no === round && l.home_entrant_id && l.away_entrant_id && !["decided", "finalized", "forfeited"].includes(l.status))) {
        const winner = pick ? pick(f) : (seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
        const home = winner === f.home_entrant_id;
        await appendScoreEvent(owner, f.id, "core.start", {});
        await appendScoreEvent(owner, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
        await appendScoreEvent(owner, f.id, "badminton.game.summary", home ? { home: 21, away: 12 } : { home: 12, away: 21 });
      }
    };
    const stageStatus = async (stageId: string | undefined) => (v1data<{ id: string; status: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`, "GET")) ?? []).find((s) => s.id === stageId)?.status;
    return { divId, mainId, plateId, ents: ents ?? [], started, lines, playRound, stageStatus };
  };

  // Check 2 (T8, X-PL-5): n=5 - nothing proposable after round 1; after round 2 the first losers E3 and E5, the main final unplayed.
  {
    const d = await plateDivision("Plate5", 5);
    await d.playRound(1);
    const early = await v1(owner, `/api/v1/stages/${d.plateId}/seed-proposal`, "POST");
    await d.playRound(2);
    const final = (await d.lines(d.mainId)).find((l) => l.round_no === 3);
    const late = await v1(owner, `/api/v1/stages/${d.plateId}/seed-proposal`, "POST");
    const qualifiers = v1data<{ computed?: { qualifiers?: { entrantId: string }[] } } | undefined>(late)?.computed?.qualifiers ?? [];
    const nameOf = new Map(d.ents.map((e, i) => [e.id, `E${i + 1}`] as const));
    const got = qualifiers.map((q) => nameOf.get(q.entrantId)).sort();
    const ok =
      d.started.status < 300 &&
      early.status === 409 &&
      (early.json as { error?: { code?: string } } | undefined)?.error?.code === "SEEDING_SOURCE_INCOMPLETE" &&
      final !== undefined && !["decided", "finalized"].includes(final.status) &&
      late.status < 300 &&
      JSON.stringify(got) === JSON.stringify(["E3", "E5"]) &&
      (await d.lines(d.plateId)).length === 1;
    w4Check(
      "w4b T8 (X-PL-5): n=5 - the plate is refused while the field is open, and proposed for E3 and E5 after round 2 with the main final still to play" +
        (ok ? "" : ` - early ${early.status}, late ${late.status}, qualifiers ${got.join(",")}, final ${final?.status}`),
      ok,
    );
  }

  // Check 3 (T8, X-PL-2): n=4, E3 withdraws; E2 (the walkover winner) wins the final, so E4 is the only first loser - the plate
  // completes by name with no lines, and completing the main draw completes the division.
  {
    const d = await plateDivision("Plate4", 4);
    const w = await v1(owner, `/api/v1/entrants/${d.ents[2]?.id}/withdraw`, "POST");
    await d.playRound(1);
    const waiting = await d.stageStatus(d.plateId);
    await d.playRound(2, (f) => (f.home_entrant_id === d.ents[1]?.id || f.away_entrant_id === d.ents[1]?.id ? d.ents[1]!.id : f.home_entrant_id!));
    const plateStatus = await d.stageStatus(d.plateId);
    const noLines = (await d.lines(d.plateId)).length === 0;
    await v1(owner, `/api/v1/stages/${d.mainId}/complete`, "POST");
    const division = v1data<{ status?: string } | undefined>(await v1(owner, `/api/v1/divisions/${d.divId}`, "GET"));
    const ok = w.status < 300 && waiting !== "complete" && plateStatus === "complete" && noLines && division?.status === "completed";
    w4Check(
      "w4b T8 (X-PL-2): a plate with one first loser completes by name with no lines, and the division completes with the main draw" +
        (ok ? "" : ` - withdraw ${w.status}, plate while open ${waiting}, after the final ${plateStatus}, lines ${noLines ? 0 : ">0"}, division ${division?.status}`),
      ok,
    );
  }

  check(`w4b: the W4 knockout app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
