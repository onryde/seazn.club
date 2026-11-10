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
 */
export async function w4KnockoutBSuite(): Promise<void> {
  const EXPECTED_CHECKS = 1;
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

  check(`w4b: the W4 knockout app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked > 0 && checked === EXPECTED_CHECKS);
}
