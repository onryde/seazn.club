// W4 T21 (AN-1, X-CH-8; owner pick R24 4A, ruling 273): completing a competition WARNS, never refuses. The settings page
// lists every stage still open, with what each one is waiting for, and offers Complete stage where the final is decided.
// `openStagesOf` is that list's read; `patchCompetition` is unchanged and must still complete the competition with
// open stages left. Real Postgres, real doors (the generator, `scoreEvent`, `completeStage`, `archiveDivision`).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, openStagesOf, patchCompetition } from "../competitions";
import { archiveDivision, createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// single-sport: generic/score — the list is about stage STATE (decided, left, empty), which no sport changes; the
// per-kind half (every bracket kind, a held final, a bronze) is swept in engine-db/__tests__/stage-finals.test.ts.
const GENERIC = builtinModules.find((m) => m.key === "generic")!;
const CONFIG = GENERIC.variants.score as Record<string, unknown>;

const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
async function decide(auth: AuthCtx, id: string) {
  await scoreEvent(auth, id, { expected_seq: await seq(id), type: "core.start", payload: {} } as never);
  const out = await scoreEvent(auth, id, { expected_seq: await seq(id), type: "generic.result", payload: { p1Score: 3, p2Score: 1 } } as never);
  expect(out.status, "rig: a played match is decided").toBe("decided");
}

async function org() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"OS " + suffix}, ${"os-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  return { auth, suffix };
}

/** One division of four in `competitionId`, its one stage of `kind`; `generate` false leaves the stage empty and unstarted. */
async function division(
  auth: AuthCtx, competitionId: string, name: string, kind: "knockout" | "league", generate = true, config: Record<string, unknown> = {},
) {
  const d = await createDivision(auth, competitionId, {
    name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic", variant_key: "score", config: CONFIG,
  });
  await createEntrants(auth, d.id, ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: `${name} ${n}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, d.id, { seq: 1, kind, name: kind === "knockout" ? "Knockout" : "League", config, progression: null });
  if (generate) {
    await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, d.id);
  }
  return { divisionId: d.id, stageId: stage!.id };
}

/** Decide `n` seated, unplayed fixtures of the stage (round by round, so a bracket's later rounds seat as it goes). */
async function play(auth: AuthCtx, stageId: string, n: number) {
  let done = 0;
  for (let pass = 0; pass < 10 && done < n; pass++) {
    const open = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} and status = 'scheduled'
         and home_entrant_id is not null and away_entrant_id is not null order by round_no, fixture_no`;
    if (open.length === 0) break;
    for (const f of open) {
      if (done >= n) break;
      await decide(auth, f.id);
      done++;
    }
  }
  expect(done, `rig: ${n} match(es) played`).toBe(n);
}

describe.skipIf(!HAS_DB)("openStagesOf — what the Complete-competition warning lists (W4 T21, X-CH-8)", () => {
  it("empty case first: a competition with no divisions, and one whose only stage is complete, lists nothing", async () => {
    const { auth, suffix } = await org();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "OS empty " + suffix, visibility: "private", branding: {} });
    expect(await openStagesOf(auth, comp.id)).toEqual([]);
    const league = await division(auth, comp.id, "Done", "league");
    await play(auth, league.stageId, 6);
    expect((await completeStage(auth, league.stageId, { publish: false })).completed).toBe(true);
    expect(await openStagesOf(auth, comp.id)).toEqual([]);
  });

  it("lists every open stage, in division order, each with what it waits for; Complete stage and Archive take theirs off", async () => {
    const { auth, suffix } = await org();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "OS " + suffix, visibility: "private", branding: {} });
    const decided = await division(auth, comp.id, "Mens Singles", "knockout");
    await play(auth, decided.stageId, 3); // semis and the final: nothing left but Complete stage
    const pending = await division(auth, comp.id, "Womens Doubles", "knockout"); // nothing played
    const left = await division(auth, comp.id, "Mixed", "league");
    await play(auth, left.stageId, 2); // 6 matches, 4 left
    const allPlayed = await division(auth, comp.id, "Veterans", "league");
    await play(auth, allPlayed.stageId, 6); // every match played, the stage never completed
    const empty = await division(auth, comp.id, "Juniors", "league", false);

    const before = await openStagesOf(auth, comp.id);
    expect(before.map((r) => [r.divisionName, r.seq, r.stageName, r.state, r.matchesLeft])).toEqual([
      ["Mens Singles", 1, "Knockout", "final_decided", 0],
      ["Womens Doubles", 1, "Knockout", "final_pending", 3],
      ["Mixed", 1, "League", "matches_left", 4],
      ["Veterans", 1, "League", "all_played", 0],
      ["Juniors", 1, "League", "no_matches", 0],
    ]);
    expect(before.map((r) => r.stageId)).toEqual([decided.stageId, pending.stageId, left.stageId, allPlayed.stageId, empty.stageId]);

    // patchCompetition is unchanged: it NEVER refuses — the competition completes with five stages open.
    const patched = await patchCompetition(auth, comp.id, { status: "completed" });
    expect(patched.status).toBe("completed");
    expect(await openStagesOf(auth, comp.id), "completing the competition closes no stage").toHaveLength(5);

    // The warning's own door on the decided row: the existing Complete stage.
    expect((await completeStage(auth, decided.stageId, { publish: false })).completed).toBe(true);
    await archiveDivision(auth, empty.divisionId);
    expect((await openStagesOf(auth, comp.id)).map((r) => r.stageId)).toEqual([pending.stageId, left.stageId, allPlayed.stageId]);
  });

  it("AN-2: a knockout whose final is decided while its bronze is still to play reads '1 match left', never 'final not played'", async () => {
    const { auth, suffix } = await org();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "OS AN-2 " + suffix, visibility: "private", branding: {} });
    const ko = await division(auth, comp.id, "Cup", "knockout", true, { thirdPlace: true });
    await play(auth, ko.stageId, 2); // the semis seat the final and the bronze
    const round2 = await sql<{ id: string; ext_key: string | null }[]>`
      select id, ext_key from fixtures where stage_id = ${ko.stageId} and winner_to_fixture is null order by fixture_no`;
    const final = round2.find((f) => !(f.ext_key ?? "").endsWith("-3p"));
    expect(round2.length, "premise: the final and the bronze feed nothing").toBe(2);
    expect(final, "premise: one of them is the final").toBeDefined();
    expect((await openStagesOf(auth, comp.id)).map((r) => [r.state, r.matchesLeft]), "both still to play").toEqual([["final_pending", 2]]);
    await decide(auth, final!.id);
    expect((await openStagesOf(auth, comp.id)).map((r) => [r.state, r.matchesLeft])).toEqual([["matches_left", 1]]);
    await play(auth, ko.stageId, 1); // the bronze
    expect((await openStagesOf(auth, comp.id)).map((r) => [r.state, r.matchesLeft])).toEqual([["final_decided", 0]]);
  });

  it("tenancy: another organisation reads nothing of this competition", async () => {
    const { auth, suffix } = await org();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "OS tenancy " + suffix, visibility: "private", branding: {} });
    await division(auth, comp.id, "Open", "knockout");
    expect(await openStagesOf(auth, comp.id), "premise: the owner sees its open stage").toHaveLength(1);
    const other = await org();
    expect(await openStagesOf(other.auth, comp.id)).toEqual([]);
  });
});
