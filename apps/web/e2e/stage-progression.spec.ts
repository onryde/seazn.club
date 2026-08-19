import { test, expect } from "@playwright/test";
import { apiJson, TAG, seedVenueWithCourts } from "./helpers";

// D4a (P5) — API-level e2e (browser flow is P6): groups -> complete ->
// proposal -> confirm -> KO entrants filled, schedule intact. Pure
// placement/take-kind coverage lives in packages/engine's
// competition/progression.test.ts (vitest, no DB); the DB-plumbing
// byte-identity regression lives in server/usecases/__tests__/
// stage-progression.test.ts (vitest, real Postgres). This spec is the one
// place that proves the SAME flow works over the real HTTP boundary end to
// end — request-only, no `page`, matching fixture-config-snapshot.spec.ts's
// pattern (the shared "pro" storage state is already authenticated; nothing
// here needs an explicit sign-in).
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

test("groups -> complete -> proposal -> confirm -> KO entrants filled, schedule intact", async ({ request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Seed E2E ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const competitionId = comp.data!.id;

  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1 })),
  );
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);

  // Two stages in one call: groups (4 pools of 2) feed a knockout via
  // F2's unified `progression` field (timing: "setup" — topNPerGroup(2),
  // rank_order), replacing the old `.seeding` field this spec used before.
  const stages = await apiJson<{ id: string; kind: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status, JSON.stringify(stages.error)).toBe(201);
  const groupStageId = stages.data!.find((s) => s.kind === "group")!.id;
  const koStageId = stages.data!.find((s) => s.kind === "knockout")!.id;

  // TBD fixtures exist up front — before the group stage has even been
  // generated, let alone completed (owner ruling: placeholders at setup).
  const koGen = await apiJson<{ created: number; fixtures: { id: string; home_entrant_id: string | null; round_no: number }[] }>(
    request,
    `/api/v1/stages/${koStageId}/generate`,
    "POST",
  );
  expect(koGen.status, JSON.stringify(koGen.error)).toBe(200); // generate is idempotent-diff, not create — 200
  expect(koGen.data!.created).toBe(7); // 8-team single elim
  expect(koGen.data!.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);

  // Pin one round-0 KO fixture's schedule BEFORE anyone qualifies — "the
  // final's court/time can be pinned on day one, like real cups" — this is
  // the fixture confirm must leave byte-identical below.
  const minRound = Math.min(...koGen.data!.fixtures.map((f) => f.round_no));
  const pinnedFixtureId = koGen.data!.fixtures.find((f) => f.round_no === minRound)!.id;
  const { courts } = await seedVenueWithCourts(request, ["Centre Court"]);
  const centreCourtId = courts[0]!.id;
  const patch = await apiJson(request, `/api/v1/fixtures/${pinnedFixtureId}`, "PATCH", {
    scheduled_at: "2026-09-25T09:00:00.000Z",
    court_id: centreCourtId,
    venue_id: null,
    officials: [],
    schedule_locked: true,
  });
  expect(patch.status, JSON.stringify(patch.error)).toBeLessThan(300);

  const groupGen = await apiJson<{ fixtures: { id: string; home_entrant_id: string; away_entrant_id: string }[] }>(
    request,
    `/api/v1/stages/${groupStageId}/generate`,
    "POST",
  );
  expect(groupGen.status, JSON.stringify(groupGen.error)).toBe(200);
  expect(groupGen.data!.fixtures).toHaveLength(4); // 4 pools of 2 -> 1 match each

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

  // Decide every group fixture (home always wins — deterministic enough for
  // "the flow works", exact seeding order is stage-progression.test.ts's job).
  for (const f of groupGen.data!.fixtures) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    expect(scored.status, JSON.stringify(scored.error)).toBe(201);
  }

  const completed = await apiJson<{ completed: boolean; seed_proposal?: { id: string; status: string } }>(
    request,
    `/api/v1/stages/${groupStageId}/complete`,
    "POST",
  );
  expect(completed.status, JSON.stringify(completed.error)).toBe(200);
  expect(completed.data!.completed).toBe(true);
  expect(completed.data!.seed_proposal?.status).toBe("draft");

  // Explicit propose step (the literal flow: complete -> PROPOSAL -> confirm)
  // — recomputes a fresh draft over the same (now-complete) standings.
  const proposal = await apiJson<{
    id: string;
    status: string;
    computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: unknown[] };
  }>(request, `/api/v1/stages/${koStageId}/seed-proposal`, "POST");
  expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
  expect(proposal.data!.computed.qualifiers).toHaveLength(8);
  expect(proposal.data!.computed.ties).toEqual([]);

  const confirmed = await apiJson<{
    proposalId: string;
    filled: number;
    fixtures: { id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null; scheduled_at: string | null; court_id: string | null; schedule_locked: boolean }[];
  }>(request, `/api/v1/stages/${koStageId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
  expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
  expect(confirmed.data!.filled).toBe(8);

  // KO entrants filled: every one of the 8 qualifiers landed somewhere, no
  // fixture is left half-TBD at round 0. `confirmed.data!.fixtures` is the
  // WHOLE stage (7 fixtures — 4/2/1); round 0's 4 hold the direct qualifiers,
  // later rounds correctly stay TBD (fed by round-0 winners, not confirm).
  const round0 = confirmed.data!.fixtures.filter((f) => f.round_no === minRound);
  expect(round0).toHaveLength(4);
  expect(round0.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)).toBe(true);
  const laterRounds = confirmed.data!.fixtures.filter((f) => f.round_no !== minRound);
  expect(laterRounds.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);

  // Schedule intact: the pinned fixture's scheduling fields are
  // BYTE-IDENTICAL to what was set before confirm — the non-destructive
  // guarantee, over the real HTTP boundary this time.
  const pinnedAfter = confirmed.data!.fixtures.find((f) => f.id === pinnedFixtureId)!;
  expect(pinnedAfter.scheduled_at).toBe("2026-09-25T09:00:00.000Z");
  expect(pinnedAfter.court_id).toBe(centreCourtId);
  expect(pinnedAfter.schedule_locked).toBe(true);

  // Confirming the SAME proposal again is refused — a slot doesn't fill
  // twice by accident (409, not a silent no-op).
  const again = await apiJson(request, `/api/v1/stages/${koStageId}/seed-proposal/confirm`, "POST", {
    proposalId: proposal.data!.id,
  });
  expect(again.status).toBe(409);
  expect(again.error?.code).toBe("SEEDING_ALREADY_CONFIRMED");
});
