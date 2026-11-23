// The runner of the blog's one `server` example, "ladder-challenge" (post #24, "How does a ladder competition work?").
//
// The ladder's rules are the app's and run inside database transactions with no pure function to call, so the example is
// produced HERE, by driving the real usecases on a fresh six-player ladder made from the ladder template: the challenge
// (`issueChallenge`: reach, direction, the order's first write from seed order) and the result (`scoreEvent`, whose
// decided hook makes the swap, a walkover included). What it saw goes through the example's pure formatter
// (`ladderResult`) and must deep-equal the committed golden; `UPDATE_BLOG_EXAMPLES=1` rewrites the golden instead.
// The claims over that golden run in the unit harness (blog-examples.test.ts), which also pins that this file exists.
//
// CI: this file sits under src/server, which ci.yml's DB job ("Engine-db + service-layer + lib integration tests",
// `src/server src/lib`) runs whole, so it needs no ci.yml line of its own.
//
// Single sport (generic): the order lives in the stage's config and no sport module reads it. The format's offer is swept
// over the whole registry below (`templatesForSport`).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures, issueChallenge } from "@/server/usecases/stages";
import { DEFAULT_LADDER_CHALLENGE_RANGE } from "@/server/usecases/stages/ad-hoc";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { LADDER_CHALLENGE_ID, LADDER_PLAYERS, ladderResult, type LadderObserved, type LadderStep } from "@/blog/examples/ladder-challenge";
import type { ExampleResult } from "@/blog/examples/types";

const HAS_DB = !!process.env.DATABASE_URL;
const UPDATE = process.env.UPDATE_BLOG_EXAMPLES === "1";
const GOLDEN = join(process.cwd(), "src", "blog", "examples", "__golden__", `${LADDER_CHALLENGE_ID}.json`);
const stable = (r: ExampleResult) => `${JSON.stringify(r, null, 2)}\n`;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Rig {
  auth: AuthCtx;
  stageId: string;
  idOf: Map<string, string>;
  nameOf: Map<string, string>;
  reach: number;
}

/** A running six-player ladder, seeded in LADDER_PLAYERS order, its stage exactly what the ladder template builds. */
async function ladder(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Blog ladder " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const rows = await createEntrants(
    auth,
    division.id,
    LADDER_PLAYERS.map((display_name, i) => ({ kind: "individual" as const, display_name, seed: i + 1, members: [] })),
  );
  const [template] = buildTemplateStages("ladder", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: template!.kind as never, name: template!.name, config: template!.config });
  await generateStageFixtures(auth, stage!.id); // no-op: ladder fixtures are made by challenges
  await startDivision(auth, division.id);
  const idOf = new Map(rows.map((r) => [r.display_name, r.id]));
  const nameOf = new Map(rows.map((r) => [r.id, r.display_name]));
  const [cfg] = await sql<{ config: { challengeRange?: number } }[]>`select config from stages where id = ${stage!.id}`;
  return { auth, stageId: stage!.id, idOf, nameOf, reach: cfg!.config.challengeRange ?? DEFAULT_LADDER_CHALLENGE_RANGE };
}

async function storedOrder(r: Rig): Promise<string[]> {
  const [row] = await sql<{ config: { ladder_order?: string[] } }[]>`select config from stages where id = ${r.stageId}`;
  return (row!.config.ladder_order ?? []).map((id) => r.nameOf.get(id)!);
}

type How = { won: boolean; walkover?: boolean };

/** One challenge, through the real usecases: refused (its wire code), or played to `how` and scored. */
async function challenge(r: Rig, challenger: string, target: string, how: How | null): Promise<LadderStep> {
  let fixtureId: string;
  try {
    fixtureId = (await issueChallenge(r.auth, r.stageId, { challenger_id: r.idOf.get(challenger)!, opponent_id: r.idOf.get(target)! })).fixture_id;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    if (e.code !== "LADDER_CHALLENGE_OUT_OF_RANGE" && e.code !== "LADDER_CHALLENGE_NOT_UPWARD") throw e;
    expect(how, `${challenger} -> ${target} was refused (${e.code}) but the script expected a match`).toBeNull();
    return { challenger, target, refused: e.code, order: await storedOrder(r) };
  }
  expect(how, `${challenger} -> ${target} was allowed but the script expected a refusal`).not.toBeNull();
  if (how!.walkover) {
    // The holder does not turn up: the organiser records the walkover against them.
    await scoreEvent(r.auth, fixtureId, { expected_seq: 0, type: "core.forfeit", payload: { by: r.idOf.get(target)!, reason: "walkover" } });
  } else {
    // The challenger is the home side (issueChallenge seats them home).
    await scoreEvent(r.auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: how!.won ? { p1Score: 21, p2Score: 17 } : { p1Score: 15, p2Score: 21 } });
  }
  const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  expect(["decided", "forfeited"], `${challenger} -> ${target}: the match is settled`).toContain(f!.status);
  return { challenger, target, won: how!.won, ...(how!.walkover ? { walkover: true } : {}), order: await storedOrder(r) };
}

describe.skipIf(!HAS_DB)("blog example 'ladder-challenge': the ladder, run through the real usecases", () => {
  it("regenerates the committed golden", async () => {
    const r = await ladder();
    // Premise: the stage the template builds carries the template's reach, and the server's fallback agrees with it.
    expect(r.reach).toBe(DEFAULT_LADDER_CHALLENGE_RANGE);

    // The script. Every distance below is counted from the ladder as it stands before that step.
    const steps: LadderStep[] = [];
    steps.push(await challenge(r, "Eli", "Ben", { won: true })); // 3 places up, wins: they swap
    const start = [...LADDER_PLAYERS]; // the first challenge wrote the order from seed order (asserted below)
    steps.push(await challenge(r, "Fay", "Eli", null)); // Eli now 2nd, Fay 6th: 4 places up, refused
    steps.push(await challenge(r, "Fay", "Dev", { won: false })); // loses: nobody moves
    steps.push(await challenge(r, "Dev", "Cy", { won: true, walkover: true })); // Cy does not turn up: walkover, swap
    steps.push(await challenge(r, "Ben", "Fay", null)); // downward: refused

    let offeredIn = 0;
    const visited = forEachSport(({ module }) => {
      if (templatesForSport(module.key, effectiveEntrantModel(module.entrantModel, null).kinds).some((t) => t.key === "ladder")) offeredIn++;
    });
    expect(visited).toBeGreaterThan(0);

    const seen: LadderObserved = { reach: r.reach, start, steps, offeredIn };
    // The first challenge initialised the order from seed order: before it, the stored order was the seeds.
    expect(steps[0]!.order).toEqual(["Ana", "Eli", "Cy", "Dev", "Ben", "Fay"]);
    const result = ladderResult(seen);
    if (UPDATE) writeFileSync(GOLDEN, stable(result));
    expect(JSON.parse(JSON.stringify(result)), "the ladder no longer matches its golden (UPDATE_BLOG_EXAMPLES=1 moves it)").toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  }, 60_000);
});
