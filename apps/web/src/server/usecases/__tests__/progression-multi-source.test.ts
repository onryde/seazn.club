// F2 Task 6 — the DB-integration half of the multi-source acceptance
// criterion (packages/engine/src/competition/progression.test.ts, Task 2,
// covers pure resolution/dedupe at the engine level; this proves
// seedNextStage's DB orchestration wires it correctly end to end).
//
// Finding 1 (this session's F2 plan): multi-source progression NEVER
// actually worked server-side before this session — the old
// `qualification.from` field was declared, zod-validated, and grep-confirmed
// never read anywhere. This is the first real coverage of it.
//
// Two independent completed stages (A, B) in the SAME division, each
// referenced by an EXPLICIT `{stageId}` (not "previous" — Final is not
// seq-adjacent to A) in Final's progression.sources[], each contributing its
// own rank-1 finisher. Decision 4's trigger stays "check the
// immediately-next stage when ANY stage completes" — Final IS seq-adjacent
// to B (seq 2 -> seq 3), so completing B (after A already completed) is
// what fires the auto-seed attempt; completing A first is a no-op (the
// stage immediately after A, by seq, is B, which has no progression).
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  type FixtureRow,
} from "../stages";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ms " + suffix}, ${"ms-" + suffix})
    returning id`;
  // pro: 3 stages (A, B, Final) > community's stages.per_division.max.
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedDivisionWithTwoLeagues(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Ms Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  // Every "league" stage below draws from the WHOLE division entrant list
  // (generateStageFixtures' plain path) — 4 entrants play a full
  // round-robin in EACH of A and B independently (their `fixtures` rows are
  // per-stage, so the two round-robins are separate results even though
  // both involve all 4 people).
  const entrants = await createEntrants(
    auth,
    division.id,
    ["E1", "E2", "E3", "E4"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [a, b] = await createStages(auth, division.id, [
    { seq: 1, kind: "league", name: "A", config: {} },
    { seq: 2, kind: "league", name: "B", config: {} },
  ]);
  return { division, entrants, a: a!, b: b! };
}

/** Decide every fixture in `stageId` so `winnerId` wins every one of its
 *  matches (beats every opponent 2-0) and everyone else draws 1-1 among
 *  themselves — winnerId finishes rank 1 outright, unambiguously, no tie. */
async function decideLeagueWithWinner(auth: AuthCtx, stageId: string, winnerId: string): Promise<void> {
  const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId}`;
  for (const f of fixtures) {
    const winnerInvolved = f.home_entrant_id === winnerId || f.away_entrant_id === winnerId;
    const homeIsWinner = f.home_entrant_id === winnerId;
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, {
      type: "generic.result",
      payload: winnerInvolved
        ? homeIsWinner
          ? { p1Score: 2, p2Score: 0 }
          : { p1Score: 0, p2Score: 2 }
        : { p1Score: 1, p2Score: 1 },
    });
  }
}

/** Decide every fixture in `stageId` as a 1-1 draw — with exactly 2
 *  entrants, both finish level on every metric, an inescapable tie for rank
 *  1 (rankStandings' seed/id fallback flags BOTH rows tieUnbroken), same
 *  recipe as stage-progression.test.ts's "never silently ordered" case. */
async function decideLeagueAsDraw(auth: AuthCtx, stageId: string): Promise<void> {
  const fixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId}`;
  for (const f of fixtures) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 1, p2Score: 1 } });
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("multi-source progression (F2 Decision 4 / Finding 1)", () => {
  it("seeds a stage from TWO different completed source stages, in declaration order, deduped", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [e1, e2] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    });

    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // A's winner is e1; B's winner is e2 — two DIFFERENT entrants, so
    // resolution must succeed (no dedupe collision) and preserve
    // declaration order (A's qualifier first, B's second).
    await decideLeagueWithWinner(auth, a.id, e1!.id);
    await decideLeagueWithWinner(auth, b.id, e2!.id);

    // Completing A is a no-op for Final: A's own seq-adjacent successor is
    // B (seq 2), which has no progression.
    const completedA = await completeStage(auth, a.id);
    expect(completedA.completed).toBe(true);
    expect(completedA.qualified).toBeUndefined();

    // Completing B IS seq-adjacent to Final (seq 3) — this is what fires
    // the multi-source auto-seed, and by now A is already complete too.
    const completedB = await completeStage(auth, b.id);
    expect(completedB.completed).toBe(true);
    expect(completedB.qualified?.stage_id).toBe(final!.id);
    expect(completedB.qualified?.entrants).toEqual([e1!.id, e2!.id]);

    const [row] = await sql<{ config: { qualified?: string[] } }[]>`
      select config from stages where id = ${final!.id}`;
    expect(row!.config.qualified).toEqual([e1!.id, e2!.id]);
  });

  it("rejects an entrant qualifying through two sources — completeStage itself rejects (not swallowed), QUALIFICATION_INVALID", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [e1] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    });
    void final;

    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // SAME entrant (e1) wins BOTH A and B — resolveProgression must refuse
    // the duplicate rather than silently seeding the Final with one real
    // qualifier and a stray repeat.
    await decideLeagueWithWinner(auth, a.id, e1!.id);
    await decideLeagueWithWinner(auth, b.id, e1!.id);

    await completeStage(auth, a.id); // no-op for Final, same as above
    await expect(completeStage(auth, b.id)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "QUALIFICATION_INVALID"),
    );
    // completeStage's OWN completion (marking B complete, writing its
    // standings) is unaffected by the downstream seeding failure — only the
    // seed attempt itself rejects. Confirm B really did complete.
    const [[bRow]] = await Promise.all([
      sql<{ status: string }[]>`select status from stages where id = ${b.id}`,
    ]);
    expect(bRow!.status).toBe("complete");
  });

  // F2 Task 6 review, finding 1: seedNextStage's call inside completeStage
  // had NO try/catch, but a comment a few lines below it claimed
  // STAGE_NOT_READY was "caught by completeStage's existing best-effort
  // try/catch" — false. Multi-source makes that reachable for real: B is
  // seq-adjacent to Final and fires the seed attempt on its own completion,
  // but A (the OTHER named source) is deliberately left undecided here, so
  // seedNextStage's per-source completeness check throws STAGE_NOT_READY.
  // Before the fix this propagated out of completeStage uncaught, so the
  // API returned a 422 that read as "completing B failed" even though B's
  // own completion (predicate + standings + status write) had already
  // committed durably.
  it("completing a source stage while another named source isn't ready does not fail the completion (STAGE_NOT_READY is best-effort)", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [, e2] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    });
    void final;

    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // Only B is decided. A is left with no results at all — its own
    // completion predicate isn't satisfied, so it stays incomplete.
    await decideLeagueWithWinner(auth, b.id, e2!.id);

    const completedB = await completeStage(auth, b.id);
    expect(completedB.completed).toBe(true);
    expect(completedB.qualified).toBeUndefined();

    const [bRow] = await sql<{ status: string }[]>`select status from stages where id = ${b.id}`;
    expect(bRow!.status).toBe("complete");
    const [finalRow] = await sql<{ config: { qualified?: string[] } }[]>`
      select config from stages where id = ${final!.id}`;
    expect(finalRow!.config.qualified).toBeUndefined();
  });

  // A4 (round-4 review, MAJOR) — the SAME two cases as the two on_complete
  // tests above (F2 Task 6 review, finding 1, and this file's earlier
  // QUALIFICATION_INVALID test), but for the `timing: "setup"` branch in
  // completeStage (stages.ts): computeSeedProposal, not seedNextStage. That
  // branch used to be a bare `catch { return result }` — no narrowing, no
  // logging — despite its OWN comment already claiming "best-effort, same
  // spirit as the on_complete path" below it. So a genuine
  // QUALIFICATION_INVALID (or A1's SEEDING_BESTNTH_UNEQUAL_POOLS, or
  // anything else) reached an organiser as "nothing happened": the stage
  // completed, no seed_proposal, no error anywhere. Narrowed the same way
  // seedNextStage's call is narrowed a few lines below it in stages.ts.
  it("timing:setup — an entrant qualifying through two sources REJECTS the completion, not swallowed (A4 fix — was silently absorbed pre-fix)", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [e1] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "setup",
      },
    });

    await generateStageFixtures(auth, final!.id); // TBD fixtures up front, .setup convention
    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // SAME entrant (e1) wins BOTH A and B — same duplicate-qualifier shape
    // as the on_complete test above, now against a setup-timing target.
    await decideLeagueWithWinner(auth, a.id, e1!.id);
    await decideLeagueWithWinner(auth, b.id, e1!.id);

    await completeStage(auth, a.id); // no-op for Final: A's own seq-adjacent successor is B
    // F3 ultrareview finding 4 — still REJECTS (A4's point: a genuine
    // progression misconfiguration must not be silent), but no longer as a
    // bare EngineError. B's completion committed in its own transaction
    // before this ran, so a plain failure told the organiser "nothing
    // happened" about an action that half-succeeded, and the client had
    // nothing to distinguish and so never refreshed the board. The wrapper
    // says which half failed while carrying the original reason verbatim.
    await expect(completeStage(auth, b.id)).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof HttpError)) return false;
      if (err.code !== "STAGE_COMPLETED_SEEDING_FAILED") return false;
      // The real cause survives — an organiser must be able to act on it.
      return /qualifies through more than one/.test(err.message);
    });
    // Same non-destructive guarantee as the on_complete sibling: B's OWN
    // completion is unaffected by the downstream seed-proposal failure.
    const [bRow] = await sql<{ status: string }[]>`select status from stages where id = ${b.id}`;
    expect(bRow!.status).toBe("complete");
    // And no draft proposal was left behind from the failed attempt.
    const proposals = await sql<{ id: string }[]>`select id from stage_seed_proposals where stage_id = ${final!.id}`;
    expect(proposals).toHaveLength(0);
  });

  it("timing:setup — completing a source stage while another named source isn't ready does not fail the completion (STAGE_NOT_READY is still best-effort, unchanged by the A4 fix)", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [, e2] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "setup",
      },
    });

    await generateStageFixtures(auth, final!.id);
    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // Only B is decided. A is left with no results at all — its own
    // completion predicate isn't satisfied, so it stays incomplete, and
    // computeSeedProposal's sourcesToTables hits that incompleteness and
    // throws STAGE_NOT_READY — the legitimate case the try/catch exists for.
    await decideLeagueWithWinner(auth, b.id, e2!.id);

    const completedB = await completeStage(auth, b.id);
    expect(completedB.completed).toBe(true);
    expect(completedB.seed_proposal).toBeUndefined();

    const [bRow] = await sql<{ status: string }[]>`select status from stages where id = ${b.id}`;
    expect(bRow!.status).toBe("complete");
  });

  // F2 Task 6 review, finding 2: seedNextStage's carry-over step IS already
  // multi-source-aware in production (it unions qualified rows across every
  // resolved source, then guards each source's kind via CONFIG_INVALID) but
  // nothing exercised `carry` together with 2+ sources before this test — a
  // regression in the union (e.g. carrying only the last-resolved source's
  // rows, or only the just-completed stage's own table) would have shipped
  // silently. `carry` backs the marketed standings.carry_over Pro
  // entitlement; custom-points.test.ts already covers the single-source
  // shape plus the Community 402 gate.
  //
  // A and B are given DISJOINT 2-entrant rosters via an explicit
  // config.qualified on each (the same "a seeded stage draws from
  // config.qualified, not the whole division" mechanism generateStageFixtures
  // already uses for any downstream stage — stages.ts's plain-generation
  // path) — sharing ONE 4-entrant roster across both stages (as
  // seedDivisionWithTwoLeagues does above) would leave every qualifier with
  // a SECOND, non-qualifying row in the other source's own table (everyone
  // plays in both round robins), making a single entrantId->points map
  // order-dependent on which duplicate the union visits last. Disjoint
  // rosters keep this test's answer unambiguous while still genuinely
  // exercising two distinct source tables.
  it("carries points from BOTH named sources, not just one, when carry != none (multi-source + carry combination)", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Ms Carry Cup " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    const entrants = await createEntrants(
      auth,
      division.id,
      ["A1", "A2", "B1", "B2"].map((name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: [],
      })),
    );
    const [a1, a2, b1, b2] = entrants;

    const [a, b] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "A", config: { qualified: [a1!.id, a2!.id] } },
      { seq: 2, kind: "league", name: "B", config: { qualified: [b1!.id, b2!.id] } },
    ]);
    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "league",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
        carry: "points",
      },
    });

    await generateStageFixtures(auth, a!.id);
    await generateStageFixtures(auth, b!.id);
    // Single fixture per stage (2 entrants each) — a1 beats a2 2-0 (1 win x
    // 3pts); b1 beats b2 2-0, same shape, same points, from a DIFFERENT
    // table.
    await decideLeagueWithWinner(auth, a!.id, a1!.id);
    await decideLeagueWithWinner(auth, b!.id, b1!.id);

    await completeStage(auth, a!.id); // no-op for Final, same as the tests above
    const completedB = await completeStage(auth, b!.id);
    expect(completedB.qualified?.entrants).toEqual([a1!.id, b1!.id]);

    const [row] = await sql<{ config: { carry_deltas?: { entrantId: string; points: number }[] } }[]>`
      select config from stages where id = ${final!.id}`;
    expect(row!.config.carry_deltas).toBeDefined();
    const carried = row!.config.carry_deltas!;
    // A test that would still pass if the union dropped one source's rows
    // is not good enough (the review finding's own wording) — assert BOTH
    // entrants' carried points AND that the set is exactly these two, so
    // dropping either source's contribution fails this, whether by a
    // missing entry or a wrong length.
    const byEntrant = new Map(carried.map((d) => [d.entrantId, d.points]));
    expect(byEntrant.get(a1!.id)).toBe(3); // from A's table
    expect(byEntrant.get(b1!.id)).toBe(3); // from B's table
    expect(carried).toHaveLength(2);

    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events
      where division_id = ${division.id} and type = 'standings_carried'`;
    expect(ev!.n).toBe(1);
  });

  // P6 (F3 Task 3) — createStages validates a seeded_map at SAVE time
  // (stage-seeding.ts's validateStageProgression -> the engine's
  // validateProgressionAgainstShapes -> placeDescriptors), the "422 at rule
  // save, not at proposal time" contract placeDescriptors' own doc comment
  // names. Two independent league sources both using rankRange{from:1,to:1}
  // produce the SAME descriptorKey ("rank:1") regardless of shape — this
  // needs no completed results or standings, proving the ambiguity check
  // fires purely from the two sources' SHAPES, before either stage has even
  // generated fixtures. validateStageProgression converts the engine's
  // EngineError into an HttpError (its own catch block), so — unlike the
  // pure engine test in progression.test.ts — the code arrives as
  // HttpError.code here, not via EngineError.is.
  it("createStages rejects a seeded_map whose source is ambiguous across two real DB-backed sources", async () => {
    const { auth } = await seedOrg();
    const { division, a, b } = await seedDivisionWithTwoLeagues(auth);

    let caught: unknown;
    try {
      await createStages(auth, division.id, {
        seq: 3,
        kind: "knockout",
        name: "Final",
        config: {},
        progression: {
          sources: [
            { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
            { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          ],
          placement: "seeded_map",
          map: [{ slot: "1", source: "rank:1" }],
          timing: "on_complete",
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(422);
    expect(err.code).toBe("SEEDING_MAP_SOURCE_AMBIGUOUS");
    expect(err.message).toContain("rank:1");

    // Nothing was left half-created — the whole stage graph is one
    // transaction, so the ambiguous Final never landed and A/B are
    // unaffected (still exactly the two league stages from the fixture).
    const rows = await sql<{ id: string }[]>`select id from stages where division_id = ${division.id}`;
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  // Same shape, but the seeded_map references a key ONLY ONE source
  // produces (rank:1 from A alone; B contributes rank:2 via a distinct
  // rankRange) — createStages must accept it: an ambiguous key existing
  // elsewhere in the progression must not poison an unrelated reference.
  it("createStages still accepts a seeded_map whose source is unambiguous, even alongside a same-shaped sibling source", async () => {
    const { auth } = await seedOrg();
    const { division, a, b } = await seedDivisionWithTwoLeagues(auth);

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 2, to: 2 }] },
        ],
        placement: "seeded_map",
        map: [{ slot: "1", source: "rank:1" }],
        timing: "on_complete",
      },
    });
    expect(final!.id).toBeDefined();
  });

  // F3 review item 1 (BLOCKER, owner-authorised widening) — computeSeedProposal's
  // seedOfKey used to key ties by BARE descriptorKey, colliding across two
  // sources that emit the same descriptor (trivially: two rankRange sources
  // both producing "rank:1"). The Map construction's last-write-wins meant a
  // tie flagged on source A's slot silently pointed the organiser at source
  // B's (already-unambiguous) slot instead — resolving it there overwrote
  // B's rightful qualifier and left A's real tie on the engine's unconfirmed
  // default pick. Reproduced end to end: two 2-entrant leagues, A drawn (an
  // inescapable 2-way tie at rank 1) and B decisive, feeding a
  // `timing: "setup"` knockout Final via two rankRange{1,1} sources — exactly
  // the "any format with customised stage graphs" reachability path F3
  // exists to cover. `createStages`/`replaceStages` have no progression-aware
  // gate (format-gates.ts checks kind/byes/cross_feeds/placements only).
  it("resolves a tie on ONE of two same-keyed sources into that source's own slot, not the other source's", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Ms Collide Cup " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    const entrants = await createEntrants(
      auth,
      division.id,
      ["X1", "X2", "Y1", "Y2"].map((name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: [],
      })),
    );
    const [x1, x2, y1, y2] = entrants;

    const [a, b] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "A", config: { qualified: [x1!.id, x2!.id] } },
      { seq: 2, kind: "league", name: "B", config: { qualified: [y1!.id, y2!.id] } },
    ]);
    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        // BOTH sources take rankRange{from:1,to:1} — identical descriptorKey
        // "rank:1" from two DIFFERENT sources, the collision seedOfKey never
        // guarded against.
        sources: [
          { stage: { stageId: a!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "setup",
      },
    });

    // Final's TBD bracket exists independent of A/B's completion — the
    // day-one fixtures this whole programme is for.
    await generateStageFixtures(auth, final!.id);

    await generateStageFixtures(auth, a!.id);
    await generateStageFixtures(auth, b!.id);
    // A: a 1-1 draw is an inescapable 2-way tie for rank 1. B: a clean
    // decisive winner, no tie at all.
    await decideLeagueAsDraw(auth, a!.id);
    await decideLeagueWithWinner(auth, b!.id, y1!.id);

    await completeStage(auth, a!.id);
    await completeStage(auth, b!.id);

    const proposal = await computeSeedProposal(auth, final!.id);
    expect(proposal.computed.ties).toHaveLength(1);
    const tie = proposal.computed.ties[0]!;

    const aQualifier = proposal.computed.qualifiers.find((q) => q.source.stageId === a!.id);
    const bQualifier = proposal.computed.qualifiers.find((q) => q.source.stageId === b!.id);
    expect(aQualifier).toBeDefined();
    expect(bQualifier).toBeDefined();
    // B produced no tie and resolves unambiguously — the flagged tie belongs
    // to A alone, and MUST name A's own destination slot. On the pre-fix
    // code this was B's slot instead (seedOfKey's last-write-wins collapsed
    // "rank:1" onto B's seed).
    expect(tie.slots).toEqual([aQualifier!.destinationSlot]);
    expect([...tie.entrantIds].sort()).toEqual([x1!.id, x2!.id].sort());

    // The organiser deliberately picks whichever of the tied pair the engine
    // did NOT default to, so a pass here cannot be a coincidence of the
    // default order.
    const organiserPick = tie.entrantIds.find((id) => id !== aQualifier!.entrantId)!;
    expect(organiserPick).toBeDefined();

    const confirmed = await confirmSeedProposal(auth, final!.id, {
      proposalId: proposal.id,
      tiePicks: [{ slots: tie.slots, order: [organiserPick] }],
    });

    const [aSlotFixtureId, aSlotSide] = aQualifier!.destinationSlot.split(":");
    const [bSlotFixtureId, bSlotSide] = bQualifier!.destinationSlot.split(":");
    const aFixture = confirmed.fixtures.find((f) => f.id === aSlotFixtureId)!;
    const bFixture = confirmed.fixtures.find((f) => f.id === bSlotFixtureId)!;
    const entrantAt = (f: FixtureRow, side: string) => (side === "home" ? f.home_entrant_id : f.away_entrant_id);

    // The organiser's actual pick lands in A's contested slot...
    expect(entrantAt(aFixture, aSlotSide!)).toBe(organiserPick);
    // ...and B's rightful, never-tied qualifier is untouched — not silently
    // dropped in favour of the tie resolution (the mis-seat this test
    // guards against).
    expect(entrantAt(bFixture, bSlotSide!)).toBe(y1!.id);
  });
});
