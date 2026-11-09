// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, check, smokeDb, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W4 knockout app-A, lane B5 (Tasks 16 and 17) — smoke checks over real HTTP against a live server, as
 * UNWIRED exports: the controller folds them into `w4KnockoutASuite` (and its EXPECTED_CHECKS) at the lane merge. Each
 * returns the number of checks it counted, so the caller can pin its total.
 *
 * T16 (X-SP-6, owner ruling 269; RB4-S6/S7): a stepladder or page playoff with nothing to seed from is refused 422 by name
 * (STEPLADDER_NEEDS_TABLE_SOURCE / PAGE_PLAYOFF_NEEDS_TABLE_SOURCE) and writes nothing; after a league, it is taken.
 *
 * T17 (X-SP-5; RB4-S2, RB4-S3): inside a FINAL-stage page playoff (league of four → page playoff, the better seed winning
 * every league line so the table's order is the seed order), seed 1 withdraws before Q1: Q1 walks over to seed 2, and once
 * E is decided Q2 walks over to E's winner — never voided. Seating only (pre-flight C6): the "stepladder ranks all seeds"
 * check is the engine bump's (PR B, app-B carry-notes C19).
 */

/** A line as the division's fixture list publishes it (the feed edges are projected OUT of that contract). */
type Fx = {
  id: string;
  stage_id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
};
/** A line's feed edges, read from the table: no API publishes them. */
type Edge = { id: string; winner_to_fixture: string | null; loser_to_fixture: string | null };

async function feedEdges(stageId: string | undefined): Promise<Edge[]> {
  if (stageId === undefined) return [];
  const sql = smokeDb();
  try {
    return [...(await sql<Edge[]>`select id, winner_to_fixture, loser_to_fixture from fixtures where stage_id = ${stageId}`)];
  } finally {
    await sql.end();
  }
}

const TOP_FOUR = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

/** A fresh generic division of four seeded players on its own competition. */
async function fourPlayerDivision(s: Session, label: string): Promise<{ divId: string | undefined; ids: string[] }> {
  const comp = v1data<{ id: string } | undefined>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4a B5 ${label} ${tag}`, visibility: "private" }),
  );
  const divId = v1data<{ id: string } | undefined>(
    await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
      name: label,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  )?.id;
  const added = v1data<{ id: string }[] | undefined>(
    await v1(
      s,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      [1, 2, 3, 4].map((n) => ({ kind: "individual", display_name: `${label} P${n} ${tag}`, seed: n })),
    ),
  );
  return { divId, ids: (added ?? []).map((e) => e.id) };
}

/** T16 (X-SP-6): one check per table-only kind — refused 422 by its own code, nothing written, then taken after a league. */
export async function w4KnockoutAB5StandaloneRefusal(owner: Session): Promise<number> {
  let checked = 0;
  for (const [kind, code] of [["stepladder", "STEPLADDER_NEEDS_TABLE_SOURCE"], ["page_playoff", "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE"]] as const) {
    const { divId } = await fourPlayerDivision(owner, `Standalone ${kind}`);
    const refused = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind, name: "Finals", config: {} });
    const written = (v1data<unknown[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? [null]).length;
    const fed = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      { seq: 2, kind, name: "Finals", config: {}, progression: TOP_FOUR },
    ]);
    checked++;
    check(
      `w4a T16 X-SP-6: a standalone ${kind} is refused 422 ${code} and writes nothing; after a league it is taken (got ${refused.status} ${refused.json.error?.code ?? "-"}, ${written} stage(s), then ${fed.status})`,
      refused.status === 422 && refused.json.error?.code === code && written === 0 && fed.status === 201,
    );
  }
  return checked;
}

/** T17 (X-SP-5): a Q1 withdrawal inside a final-stage page playoff walks Q1 over, then Q2 over to E's winner. One check. */
export async function w4KnockoutAB5PagePlayoffWalkover(owner: Session): Promise<number> {
  const { divId, ids } = await fourPlayerDivision(owner, "Page playoff withdrawal");
  const [p1, p2, p3, p4] = ids;
  const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
  const stages = v1data<{ id: string; kind: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      { seq: 2, kind: "page_playoff", name: "Playoffs", config: {}, progression: TOP_FOUR },
    ]),
  );
  const leagueId = stages?.find((st) => st.kind === "league")?.id;
  const ppId = stages?.find((st) => st.kind === "page_playoff")?.id;
  await v1(owner, `/api/v1/stages/${leagueId}/generate`, "POST");
  await v1(owner, `/api/v1/stages/${ppId}/generate`, "POST");
  await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
  const fixturesOf = async (stageId: string | undefined) =>
    (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
  /** The console's result write: `winner` takes the line 2-0. */
  const win = async (f: Fx | undefined, winner: string | undefined) => {
    if (!f) return;
    await appendScoreEvent(owner, f.id, "generic.result", f.home_entrant_id === winner ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
  };
  for (const f of await fixturesOf(leagueId)) {
    await win(f, (seedOf.get(f.home_entrant_id ?? "") ?? 9) < (seedOf.get(f.away_entrant_id ?? "") ?? 9) ? f.home_entrant_id ?? undefined : f.away_entrant_id ?? undefined);
  }
  await v1(owner, `/api/v1/stages/${leagueId}/complete`, "POST");
  const proposal = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/stages/${ppId}/seed-proposal`, "POST"));
  await v1(owner, `/api/v1/stages/${ppId}/seed-proposal/confirm`, "POST", { proposalId: proposal?.id });

  // RB4-S2 by the feed edges: Q1 feeds the final AND Q2 (its loser); E feeds Q2; the final feeds nothing.
  const edges = await feedEdges(ppId);
  const q1Edge = edges.length === 4 && edges.filter((f) => f.loser_to_fixture !== null).length === 1 ? edges.find((f) => f.loser_to_fixture !== null) : undefined;
  const q2Id = q1Edge?.loser_to_fixture ?? undefined;
  const eId = edges.find((f) => q2Id !== undefined && f.winner_to_fixture === q2Id && f.id !== q1Edge?.id)?.id;
  const finalId = edges.find((f) => f.winner_to_fixture === null)?.id;
  const rows = await fixturesOf(ppId);
  const q1 = rows.find((f) => f.id === q1Edge?.id);
  const q2 = rows.find((f) => f.id === q2Id);
  const e = rows.find((f) => f.id === eId);
  const final = rows.find((f) => f.id === finalId);
  const pair = (f: Fx | undefined) => [f?.home_entrant_id ?? "-", f?.away_entrant_id ?? "-"].sort().join("|");
  const seededRight = pair(q1) === [p1, p2].sort().join("|") && pair(e) === [p3, p4].sort().join("|");

  const withdrawn = await v1(owner, `/api/v1/entrants/${p1}/withdraw`, "POST");
  await win((await fixturesOf(ppId)).find((f) => f.id === e?.id), p4); // the lower seed takes E, so "seed 3" would be wrong
  const after = await fixturesOf(ppId);
  const q1After = after.find((f) => f.id === q1?.id);
  const q2After = after.find((f) => f.id === q2?.id);
  const finalAfter = after.find((f) => f.id === final?.id);
  const voided = after.filter((f) => f.status === "abandoned" || f.status === "void").length;
  check(
    `w4a T17 X-SP-5: a Q1 withdrawal in a final-stage page playoff walks Q1 over to seed 2, then Q2 over to E's winner; the final is seed 2 v E's winner, nothing voided (got seeded=${seededRight}, withdraw ${withdrawn.status}, Q1 ${q1After?.status}/${q1After?.outcome?.winner === p2}, Q2 ${q2After?.status}/${q2After?.outcome?.winner === p4}, final ${pair(finalAfter) === [p2, p4].sort().join("|")}, voided ${voided})`,
    seededRight &&
      withdrawn.status === 200 &&
      q1After?.status === "forfeited" &&
      q1After.outcome?.winner === p2 &&
      q2After?.status === "forfeited" &&
      q2After.outcome?.winner === p4 &&
      finalAfter?.status === "scheduled" &&
      pair(finalAfter) === [p2, p4].sort().join("|") &&
      voided === 0,
  );
  return 1;
}
