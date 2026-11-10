// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of ../harness.ts.
import { appendScoreEvent, call, check, newSession, setPlan, signIn, tag, v1, v1data } from "../harness.ts";

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
 *
 * B2 (T5; X-TP-3): a completed Shared four-draw's PUBLIC standings JSON serves two rank-3 rows (and no rank 4).
 * B4 (T9; X-TP-2, X-TP-7): PATCH Play-off adds one third-place line; both beaten semi-finalists out ranks 1, 2, 4, 4.
 * B5a (X-CH-3): both finalists withdrawn - the title is vacant, both rank 2nd, nobody ranks 1st.
 * B5b (X-CH-4): Declare joint winners on a seated final - both finalists rank 1st, the stage completes; its Undo opens the final again.
 * T16 (X-PL-8): an odd field (n=7) - the plate is proposed after round 2, its confirm seats the three first losers, and both stages and the
 * division complete.
 *
 * The checks, in order (EXPECTED_CHECKS = 10): 1 T3 places [1,2,3,3]; 2 T8 plate n=5 proposal; 3 T8 plate completes by name; 4 T9 PATCH Play-off;
 * 5 T9 both semi-final losers out; 6 T5 public standings two 3rds; 7 B5a vacant title; 8 B5b joint declared; 9 B5b joint undone; 10 T16 odd plate n=7.
 */
export async function w4KnockoutBSuite(): Promise<void> {
  const EXPECTED_CHECKS = 10;
  let checked = 0;
  const w4Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w4b_${tag}@resend.dev`);
  // Pro: ten checks each build their own competition, past the community plan's active-competition cap (402 competitions.max_active).
  await setPlan(who.org_id, "pro", owner);
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
  const plateDivision = async (label: string, n: number, compId: string | undefined = comp?.id) => {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${compId}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
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
    await d.playRound(2, (f) => (f.home_entrant_id === d.ents[1]?.id || f.away_entrant_id === d.ents[1]?.id ? d.ents[1].id : f.home_entrant_id));
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

  // B4 helper: a started four-player badminton knockout (Play-off or Shared as asked); lines and the home-wins play helper.
  type TFx = { id: string; stage_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null; status: string; third_place?: boolean; outcome?: { kind?: string } | null };
  const fourPlayers = async (label: string, thirdPlace: boolean, startIt: boolean) => {
    // Its own competition: the community plan caps the divisions one competition holds, and checks 1-3 already use several.
    const own = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout B ${label} ${tag}`, visibility: "private" }),
    );
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${own?.id}/divisions`, "POST", { name: label, sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    const ents = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `W4B ${label} E${i + 1} ${tag}`, seed: i + 1 }))),
    );
    const stageId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "knockout", name: label, config: thirdPlace ? { thirdPlace: true } : {} }))?.id;
    await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = startIt ? await v1(owner, `/api/v1/divisions/${divId}/start`, "POST") : null;
    const lines = async () => (v1data<TFx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const homeWins = async (id: string) => {
      await appendScoreEvent(owner, id, "core.start", {});
      await appendScoreEvent(owner, id, "badminton.game.summary", { home: 21, away: 10 });
      await appendScoreEvent(owner, id, "badminton.game.summary", { home: 21, away: 12 });
    };
    return { divId, stageId, ents: ents ?? [], started, lines, homeWins };
  };

  // Check 4 (B4 T9, X-TP-2): PATCH Play-off on a drawn Shared bracket - exactly one third-place line, fed by both semi-finals.
  {
    const d = await fourPlayers("TP Patch", false, false);
    const before = (await d.lines()).filter((l) => l.third_place === true).length;
    const patched = await v1(owner, `/api/v1/stages/${d.stageId}`, "PATCH", { thirdPlace: "playoff" });
    const after = await d.lines();
    const thirds = after.filter((l) => l.third_place === true);
    const ok = before === 0 && patched.status < 300 && thirds.length === 1 && after.length === 4;
    w4Check(
      "w4b B4 T9 (X-TP-2): PATCH thirdPlace playoff on a drawn four-player knockout leaves exactly one third-place line (4 lines in all)" +
        (ok ? "" : ` - patch ${patched.status}, third-place lines ${before} -> ${thirds.length}, lines ${after.length}`),
      ok,
    );
  }

  // Check 5 (B4 T9, X-TP-7): both beaten semi-finalists out (one semi-finalist of each semi withdraws): the -3p is a departure
  // double walkover and the stage ranks 1, 2, 4, 4 (the rulebook's: 3rd is vacant, both rank 4th).
  {
    const d = await fourPlayers("TP Both Out", true, true);
    const semis = (await d.lines()).filter((l) => l.round_no === 1 && !l.third_place);
    const w = [];
    for (const sf of semis) w.push(await v1(owner, `/api/v1/entrants/${sf.away_entrant_id}/withdraw`, "POST"));
    const afterW = await d.lines();
    const bronze = afterW.find((l) => l.third_place === true);
    const final = afterW.find((l) => l.round_no === 2 && l.third_place !== true);
    if (final) await d.homeWins(final.id);
    const done = await v1(owner, `/api/v1/stages/${d.stageId}/complete`, "POST");
    type Done = { completed?: boolean; events?: { type: string; places?: { entrantId: string; rank: number }[] }[] };
    const places = v1data<Done | undefined>(done)?.events?.find((e) => e.type === "stage_completed")?.places ?? [];
    const ok =
      semis.length === 2 && w.every((r) => r.status < 300) && bronze?.outcome?.kind === "double_walkover" &&
      JSON.stringify(places.map((p) => p.rank).sort()) === JSON.stringify([1, 2, 4, 4]);
    w4Check(
      "w4b B4 T9 (X-TP-7): with both beaten semi-finalists out the third-place line is a double walkover and the places are 1, 2, 4, 4" +
        (ok ? "" : ` - semis ${semis.length}, withdraw ${w.map((r) => r.status).join(",")}, bronze ${bronze?.status}/${bronze?.outcome?.kind}, places ${places.map((p) => p.rank).join(",")}`),
      ok,
    );
  }

  // ── Checks 6-10 (T16): the rows the earlier batches owed to the smoke ──
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  const playBadminton = async (id: string, homeWon: boolean) => {
    await appendScoreEvent(owner, id, "core.start", {});
    await appendScoreEvent(owner, id, "badminton.game.summary", homeWon ? { home: 21, away: 10 } : { home: 10, away: 21 });
    await appendScoreEvent(owner, id, "badminton.game.summary", homeWon ? { home: 21, away: 12 } : { home: 12, away: 21 });
  };

  // Check 6 (B2 T5, X-TP-3): a Shared four-draw, played home-wins and completed: the PUBLIC standings JSON serves two rank-3 rows and no rank 4.
  {
    const pubComp = v1data<{ id: string; slug: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout B Public ${tag}`, visibility: "public" }),
    );
    const div = v1data<{ id: string; slug: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${pubComp?.id}/divisions`, "POST", { name: "Public places", sport_key: "badminton", variant_key: "bwf", config: {} }),
    );
    await v1(owner, `/api/v1/divisions/${div?.id}/entrants`, "POST", Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `W4B Pub E${i + 1} ${tag}`, seed: i + 1 })));
    const stageId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} }))?.id;
    await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    await v1(owner, `/api/v1/divisions/${div?.id}/start`, "POST");
    type PFx2 = { id: string; stage_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null };
    const rows = async () => (v1data<PFx2[] | undefined>(await v1(owner, `/api/v1/divisions/${div?.id}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    for (const f of (await rows()).filter((l) => l.round_no === 1)) await playBadminton(f.id, true);
    const final = (await rows()).find((l) => l.round_no === 2);
    if (final) await playBadminton(final.id, true);
    const done = await v1(owner, `/api/v1/stages/${stageId}/complete`, "POST");
    const pub = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pubComp?.slug}/divisions/${div?.slug}/standings`);
    type Pub = { standings?: { stage_id: string; rows: { entrantId: string; rank?: number | null }[] }[] };
    const table = v1data<Pub | undefined>(pub)?.standings?.find((t) => t.stage_id === stageId)?.rows ?? [];
    const ranks = table.map((r) => r.rank).sort();
    const ok = done.status < 300 && pub.status === 200 && JSON.stringify(ranks) === JSON.stringify([1, 2, 3, 3]);
    w4Check(
      "w4b B2 T5 (X-TP-3): the public standings JSON of a completed Shared four-draw serves ranks 1, 2, 3, 3 - two 3rds and no 4th" +
        (ok ? "" : ` - complete ${done.status}, public ${pub.status}, ranks ${JSON.stringify(ranks)}`),
      ok,
    );
  }

  // Check 7 (B5a, X-CH-3 / RB4-C3): the semi-finals played for the home side, then BOTH finalists withdraw: the final is a double walkover,
  // Complete answers a vacant title, and the places are 2, 2, 3, 3 (both finalists 2nd, the semi-final losers level 3rd).
  {
    const d = await fourPlayers("Vacant", false, true);
    for (const f of (await d.lines()).filter((l) => l.round_no === 1)) await d.homeWins(f.id);
    const final = (await d.lines()).find((l) => l.round_no === 2);
    const finalists = [final?.home_entrant_id, final?.away_entrant_id];
    const w = [];
    // Two desk Withdraws in a row (RB4-C3, PO ruling 2026-11-10): the first walks the final over, the second turns it into the double walkover.
    for (const id of finalists) w.push(await v1(owner, `/api/v1/entrants/${id}/withdraw`, "POST"));
    const done = await v1(owner, `/api/v1/stages/${d.stageId}/complete`, "POST");
    type Done2 = { completed?: boolean; events?: { type: string; places?: { entrantId: string; rank: number }[]; title?: { kind?: string; champion?: string; finalists?: string[] } }[] };
    const ev = v1data<Done2 | undefined>(done)?.events?.find((e) => e.type === "stage_completed");
    const finalAfter = (await d.lines()).find((l) => l.round_no === 2);
    const ok =
      finalists.every((x) => x != null) && w.every((r) => r.status < 300) &&
      finalAfter?.outcome?.kind === "double_walkover" &&
      ev?.title?.kind === "vacant" && ev.title.champion === undefined &&
      JSON.stringify([...(ev.title.finalists ?? [])].sort()) === JSON.stringify([finalists[0], finalists[1]].sort()) &&
      JSON.stringify((ev.places ?? []).map((p) => p.rank).sort()) === JSON.stringify([2, 2, 3, 3]);
    w4Check(
      "w4b B5a (X-CH-3): both finalists withdrawn - the final is a double walkover, the title is vacant, the places are 2, 2, 3, 3" +
        (ok ? "" : ` - withdraw ${w.map((r) => r.status).join(",")}, final ${finalAfter?.status}/${finalAfter?.outcome?.kind}, title ${JSON.stringify(ev?.title)}, places ${(ev?.places ?? []).map((p) => p.rank).join(",")}`),
      ok,
    );
  }

  // Checks 8 and 9 (B5b, X-CH-4 / RB4-C4): the final seated and unplayed (the semi-finals decided): Declare joint winners rules both finalists
  // 1st (places 1, 1, 3, 3) and completes the stage; its Undo gives the final back as it was (scheduled, no declaration) and re-opens the stage.
  {
    const d = await fourPlayers("Joint", false, true);
    for (const f of (await d.lines()).filter((l) => l.round_no === 1)) await d.homeWins(f.id);
    const final = (await d.lines()).find((l) => l.round_no === 2);
    type Fixture = { status?: string; outcome?: unknown; joint_winners_at?: string | null };
    const declared = await v1(owner, `/api/v1/fixtures/${final?.id}/joint-winners`, "POST");
    const after = v1data<Fixture | undefined>(await v1(owner, `/api/v1/fixtures/${final?.id}`));
    const table = v1data<{ rows?: { rank?: number | null }[] } | undefined>(await v1(owner, `/api/v1/stages/${d.stageId}/standings`))?.rows ?? [];
    const stageDone = async () => (v1data<{ id: string; status: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${d.divId}/stages`)) ?? []).find((s) => s.id === d.stageId)?.status;
    const completedWith = await stageDone();
    const ok8 =
      declared.status < 300 && after?.status === "decided" && after.outcome == null && typeof after.joint_winners_at === "string" &&
      JSON.stringify(table.map((r) => r.rank).sort()) === JSON.stringify([1, 1, 3, 3]) && completedWith === "complete";
    w4Check(
      "w4b B5b (X-CH-4): Declare joint winners on a seated final decides it with no outcome, ranks both finalists 1st (1, 1, 3, 3) and completes the stage" +
        (ok8 ? "" : ` - declare ${declared.status}, final ${after?.status}/${JSON.stringify(after?.outcome)}/${after?.joint_winners_at}, ranks ${table.map((r) => r.rank).join(",")}, stage ${completedWith}`),
      ok8,
    );
    const undone = await v1(owner, `/api/v1/fixtures/${final?.id}/joint-winners`, "DELETE");
    const back = v1data<Fixture | undefined>(await v1(owner, `/api/v1/fixtures/${final?.id}`));
    const reopened = await stageDone();
    const ok9 = undone.status < 300 && back?.status === "scheduled" && back.joint_winners_at == null && reopened !== "complete";
    w4Check(
      "w4b B5b (X-CH-4): Undo of the joint winners gives the final back scheduled with no declaration, and the stage is open again" +
        (ok9 ? "" : ` - undo ${undone.status}, final ${back?.status}/${back?.joint_winners_at}, stage ${reopened}`),
      ok9,
    );
  }

  // Check 10 (T16, X-PL-8): n=7, the better seed wins every line. By hand (RB4-P1: the plate takes whoever loses their FIRST real match, a bye
  // is none): bye 1; R1 4v5, 3v6, 2v7 lose 5, 6, 7; round 2 is 1v4 and 2v3, whose losers (4, 3) had already won a match - so after round 2 the
  // plate's field is E5, E6, E7 (three), proposed and confirmed (three seated); the plate and the main final are played out; both stages and
  // the division complete.
  {
    const own7 = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 Knockout B Plate7 ${tag}`, visibility: "private" }),
    );
    const d = await plateDivision("Plate7", 7, own7?.id);
    await d.playRound(1);
    await d.playRound(2);
    const proposal = await v1(owner, `/api/v1/stages/${d.plateId}/seed-proposal`, "POST");
    const prop = v1data<{ id: string; computed?: { qualifiers?: { entrantId: string }[] } } | undefined>(proposal);
    const nameOf = new Map(d.ents.map((e, i) => [e.id, `E${i + 1}`] as const));
    const field = (prop?.computed?.qualifiers ?? []).map((q) => nameOf.get(q.entrantId)).sort();
    const confirmed = await v1(owner, `/api/v1/stages/${d.plateId}/seed-proposal/confirm`, "POST", { proposalId: prop?.id });
    // `filled` counts slot WRITES (the bye holder is written twice), so the seated entrants are read from the plate lines themselves.
    const plateLines = await d.lines(d.plateId);
    const seated = [...new Set(plateLines.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter((x): x is string => !!x).map((x) => nameOf.get(x)))].sort();
    const playOut = async (stageId: string | undefined) => {
      for (let r = 1; r <= 4; r++) {
        for (const f of (await d.lines(stageId)).filter((l) => l.round_no === r && l.home_entrant_id && l.away_entrant_id && !["decided", "finalized", "forfeited"].includes(l.status))) {
          const home = (d.ents.findIndex((e) => e.id === f.home_entrant_id)) < (d.ents.findIndex((e) => e.id === f.away_entrant_id));
          await playBadminton(f.id, home);
        }
      }
    };
    await playOut(d.mainId);
    await playOut(d.plateId);
    const mainDone = await v1(owner, `/api/v1/stages/${d.mainId}/complete`, "POST");
    const plateDone = await v1(owner, `/api/v1/stages/${d.plateId}/complete`, "POST");
    const division = v1data<{ status?: string } | undefined>(await v1(owner, `/api/v1/divisions/${d.divId}`, "GET"));
    const ok =
      proposal.status < 300 && JSON.stringify(field) === JSON.stringify(["E5", "E6", "E7"]) && confirmed.status < 300 && JSON.stringify(seated) === JSON.stringify(["E5", "E6", "E7"]) &&
      mainDone.status < 300 && plateDone.status < 300 && division?.status === "completed";
    w4Check(
      "w4b T16 (X-PL-8): n=7 - the plate is proposed for E5, E6, E7 after round 2, its confirm seats three, both stages and the division complete" +
        (ok ? "" : ` - proposal ${proposal.status} ${field.join(",")}, confirm ${confirmed.status} seated ${seated.join(",")}, main ${mainDone.status}, plate ${plateDone.status}, division ${division?.status}`),
      ok,
    );
  }

  check(`w4b: the W4 knockout app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
