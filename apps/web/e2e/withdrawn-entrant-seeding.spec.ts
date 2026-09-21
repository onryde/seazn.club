import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiJson, TAG, divisionPath } from "./helpers";

// A withdrawn entrant must not reach a knockout bracket through the
// `timing: "setup"` propose -> confirm -> fill path, and — the half no
// vitest here can see — the ORGANISER'S SCREEN must not offer her either.
//
// `apps/web` vitest is `environment: "node"`, so the proposal panel
// (components/v2/progression-panel.tsx) renders nowhere in the unit suites:
// a green server-side filter says nothing about what a person is actually
// shown. This spec drives the real division page, reads the real <select>
// options out of the real DOM, and is the only place that can tell the
// difference between "the API refuses her" and "the organiser is never
// offered her".
//
// The withdrawal is a STATUS FLIP: her entrant row, and her row in the
// frozen standings snapshot, both survive on purpose. So the panel's
// qualifier list — which resolves progression over those standings — is
// exactly where she reappears.
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Rig {
  divisionId: string;
  koStageId: string;
  entrants: { id: string; display_name: string }[];
}

/** 8 entrants, 4 pools of 2, topNPerGroup(2) -> 8 qualifiers into a
 *  `timing: "setup"` knockout, every group match decided. Mirrors
 *  stage-progression.spec.ts's rig; that spec proves the happy path over
 *  HTTP, this one proves what the screen shows when someone leaves. */
async function seedToProposal(request: APIRequestContext, tag: string): Promise<Rig> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Withdraw Seed ${tag}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 8 }, (_, i) => ({
      kind: "individual",
      display_name: `Withdrawee ${i + 1}`,
      seed: i + 1,
    })),
  );
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);

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

  const koGen = await apiJson(request, `/api/v1/stages/${koStageId}/generate`, "POST");
  expect(koGen.status, JSON.stringify(koGen.error)).toBe(200);

  const groupGen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${groupStageId}/generate`,
    "POST",
  );
  expect(groupGen.status, JSON.stringify(groupGen.error)).toBe(200);

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

  for (const f of groupGen.data!.fixtures) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    expect(scored.status, JSON.stringify(scored.error)).toBe(201);
  }

  const completed = await apiJson(request, `/api/v1/stages/${groupStageId}/complete`, "POST");
  expect(completed.status, JSON.stringify(completed.error)).toBe(200);

  return { divisionId, koStageId, entrants: entrants.data! };
}

async function proposalQualifierIds(request: APIRequestContext, koStageId: string): Promise<string[]> {
  const proposal = await apiJson<{ computed: { qualifiers: { entrantId: string }[] } }>(
    request,
    `/api/v1/stages/${koStageId}/seed-proposal`,
    "POST",
  );
  expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
  return proposal.data!.computed.qualifiers.map((q) => q.entrantId);
}

test("the seeding proposal screen does not offer a withdrawn qualifier", async ({ page, request }) => {
  const rig = await seedToProposal(request, `${TAG}-ui`);
  const byId = new Map(rig.entrants.map((e) => [e.id, e.display_name]));

  const before = await proposalQualifierIds(request, rig.koStageId);
  expect(before).toHaveLength(8);
  const departing = before[0]!;
  const departingName = byId.get(departing)!;

  // BEFORE: the panel shows her, as it should — she has qualified.
  const url = await divisionPath(request, rig.divisionId, "?tab=fixtures");
  await page.goto(url);
  const panel = page.locator('[data-progression-state="draft"]');
  await expect(panel).toBeVisible();
  const namesBefore = await panel.locator("tbody tr select").evaluateAll((els) =>
    els.map((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? ""),
  );
  expect(namesBefore).toHaveLength(8);
  expect(namesBefore).toContain(departingName);

  // She withdraws.
  const withdrawn = await apiJson(request, `/api/v1/entrants/${departing}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBeLessThan(300);

  // AFTER: the organiser just reloads. No recompute button is pressed —
  // there ISN'T one on a draft panel (progression-panel.tsx renders
  // Recompute on its null and stale branches only), which is precisely why
  // the status flip has to refresh the draft server-side. Her seat is left
  // EMPTY rather than closed up (nobody is promoted into the vacancy), so
  // the table is one row shorter.
  await page.goto(url);
  await expect(panel).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(7);
  const namesAfter = await panel.locator("tbody tr select").evaluateAll((els) =>
    els.map((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? ""),
  );
  expect(namesAfter).not.toContain(departingName);
  // The other seven are untouched — this is a removal, not a reshuffle.
  expect(namesAfter).toEqual(namesBefore.filter((n) => n !== departingName));
});

test("a withdrawn entrant cannot be filled into the bracket over HTTP, by any route", async ({
  request,
}) => {
  const rig = await seedToProposal(request, `${TAG}-api`);

  // A draft computed while everyone is still in.
  const proposal = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[] } }>(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal`,
    "POST",
  );
  expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
  // Every entrant qualifies in this rig (4 pools of 2, top 2 each), so the
  // departed entrant IS the one to hand-pick back in below — and because the
  // refreshed slate no longer gives her a slot of her own, naming her in an
  // edit cannot trip SEEDING_SLOT_DOUBLE_ASSIGNED instead.
  expect(proposal.data!.computed.qualifiers).toHaveLength(8);
  const departing = proposal.data!.computed.qualifiers[0]!.entrantId;

  const withdrawn = await apiJson(request, `/api/v1/entrants/${departing}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBeLessThan(300);

  // Route 1 — the slate the client is holding. The status flip refreshed the
  // proposal underneath it, so the id it has is stale and refused as such.
  const stale = await apiJson(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal/confirm`,
    "POST",
    { proposalId: proposal.data!.id },
  );
  expect(stale.status).toBe(409);
  expect(stale.error?.code).toBe("SEEDING_PROPOSAL_STALE");

  // Route 2 — an `edits[]` override on the CURRENT, correctly-filtered draft.
  // Nothing upstream can stop a client naming a departed entrant here, so
  // this is where the binding refusal has to live.
  const fresh = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[] } }>(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal`,
    "POST",
  );
  expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
  expect(fresh.data!.computed.qualifiers).toHaveLength(7);
  expect(fresh.data!.computed.qualifiers.map((q) => q.entrantId)).not.toContain(departing);

  const refused = await apiJson(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal/confirm`,
    "POST",
    {
      proposalId: fresh.data!.id,
      edits: [
        {
          destinationSlot: fresh.data!.computed.qualifiers[0]!.destinationSlot,
          entrantId: departing,
        },
      ],
    },
  );
  expect(refused.status).toBe(422);
  expect(refused.error?.code).toBe("SEEDING_ENTRANT_WITHDRAWN");

  // And the bracket is untouched throughout: every KO slot is still TBD.
  const fixtures = await apiJson<
    { stage_id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]
  >(request, `/api/v1/divisions/${rig.divisionId}/fixtures`);
  expect(fixtures.status, JSON.stringify(fixtures.error)).toBe(200);
  const ko = fixtures.data!.filter((f) => f.stage_id === rig.koStageId);
  expect(ko.length).toBeGreaterThan(0);
  expect(ko.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
});
