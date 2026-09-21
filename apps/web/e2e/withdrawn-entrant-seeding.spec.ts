import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  TAG,
  divisionPath,
  expectNoHorizontalScroll,
  screenshotAtWidths,
} from "./helpers";

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

test("the seeding proposal screen does not offer a withdrawn qualifier", async ({
  page,
  request,
}, testInfo) => {
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

  // …and she is not OFFERED either. The row that named her is gone, but every
  // remaining row's <select> lists candidates for its own slot, and that list
  // was built from every entrant name the page holds — which still includes
  // her, because a withdrawal is a status flip and not a delete. Picking her
  // there is a 422 SEEDING_ENTRANT_WITHDRAWN and nothing else, so the option
  // must not be there to pick. Read off the OPTIONS, not the selected value:
  // the assertion above only sees what each row is showing.
  const offered = await panel.locator("tbody tr select option").allTextContents();
  expect(offered.length, "no options to inspect — the panel rendered no pickers").toBeGreaterThan(0);
  expect(offered.map((t) => t.trim())).not.toContain(departingName);
  // The positive pair: the seven who remain ARE still offered, so this is a
  // filter rather than an empty menu.
  for (const name of namesAfter) {
    expect(offered.map((t) => t.trim()), `${name} vanished from the pickers too`).toContain(name);
  }

  await screenshotAtWidths(page, testInfo, "proposal-after-withdrawal", [1280, 768, 320]);
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
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


test("F1: when EVERY qualifier has gone, the card says so and offers Recompute", async ({
  page,
  request,
}, testInfo) => {
  // The dead end this fix exists for, driven the way the organiser met it.
  // Before: the ordinary draft branch rendered its four column headers, ZERO
  // rows and one control, Confirm. Pressing it succeeded with `filled: 0` and
  // burned the stage into the terminal `confirmed` status — Recompute 409s
  // SEEDING_ALREADY_CONFIRMED forever after that, including once everybody is
  // un-withdrawn. No unit test can see this: `apps/web` vitest is
  // `environment: "node"`, so which BRANCH of the panel a person is shown,
  // and whether the card carries any control but Confirm, is only observable
  // here.
  const rig = await seedToProposal(request, `${TAG}-empty`);
  const all = await proposalQualifierIds(request, rig.koStageId);
  expect(all).toHaveLength(8);
  for (const id of all) {
    const out = await apiJson(request, `/api/v1/entrants/${id}/withdraw`, "POST");
    expect(out.status, JSON.stringify(out.error)).toBeLessThan(300);
  }

  const url = await divisionPath(request, rig.divisionId, "?tab=fixtures");
  await page.goto(url);
  const empty = page.locator('[data-progression-state="draft-empty"]');
  await expect(empty).toBeVisible();
  // The ordinary draft card is NOT what is being shown — structurally, not
  // just "Confirm is disabled".
  await expect(page.locator('[data-progression-state="draft"]')).toHaveCount(0);
  await expect(empty.locator("table")).toHaveCount(0);
  await expect(empty.getByRole("button", { name: /confirm/i })).toHaveCount(0);
  // …and the one control it DOES carry is the way back.
  await expect(empty.getByRole("button", { name: /recompute/i })).toBeVisible();

  // The copy is the dictionary's, not a hardcoded English string: assert a
  // phrase that only exists in `progression.noQualifiersLeft`.
  await expect(empty).toContainText("Nobody has qualified for this stage");

  // Pressing Recompute is not a dead end either — the stage is still
  // recomputable, which is the whole point of refusing rather than
  // confirming an empty draw.
  await empty.getByRole("button", { name: /recompute/i }).click();
  await expect(empty).toBeVisible();

  await screenshotAtWidths(page, testInfo, "proposal-empty-slate", [1280, 768, 320]);
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
});

test("F2: confirming a short draw leaves a settled walkover, not a match awaiting a draw", async ({
  page,
  request,
}, testInfo) => {
  // The other Critical: a vacated seat used to keep its `slot.winner_group`
  // label and a null outcome, so the final rendered "Winner of Group A vs
  // <name> — Awaiting draw" forever and sat in "1 to schedule". Driven over
  // HTTP here because what matters is the PERSISTED row the run sheet and
  // bracket panel both read.
  const rig = await seedToProposal(request, `${TAG}-walkover`);
  const before = await proposalQualifierIds(request, rig.koStageId);
  expect(before).toHaveLength(8);
  const departing = before[0]!;

  const withdrawn = await apiJson(request, `/api/v1/entrants/${departing}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBeLessThan(300);

  const fresh = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string }[] } }>(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal`,
    "POST",
  );
  expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
  expect(fresh.data!.computed.qualifiers).toHaveLength(7);

  const confirmed = await apiJson(
    request,
    `/api/v1/stages/${rig.koStageId}/seed-proposal/confirm`,
    "POST",
    { proposalId: fresh.data!.id },
  );
  expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

  const fixtures = await apiJson<
    {
      stage_id: string;
      round_no: number;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      home_slot_label: { key?: string } | null;
      away_slot_label: { key?: string } | null;
      status: string;
      outcome: { kind?: string; winner?: string } | null;
    }[]
  >(request, `/api/v1/divisions/${rig.divisionId}/fixtures`);
  expect(fixtures.status, JSON.stringify(fixtures.error)).toBe(200);
  const firstRound = fixtures
    .data!.filter((f) => f.stage_id === rig.koStageId)
    .filter((f) => f.round_no === 1);
  expect(firstRound.length).toBe(4);

  const vacated = firstRound.filter((f) => f.home_entrant_id === null || f.away_entrant_id === null);
  expect(vacated, "exactly one seat should have been vacated").toHaveLength(1);
  const line = vacated[0]!;
  const emptyLabel = line.home_entrant_id === null ? line.home_slot_label : line.away_slot_label;
  const survivor = line.home_entrant_id ?? line.away_entrant_id;
  expect(emptyLabel?.key, "the vacated seat still advertises a qualifier").toBe("bracket.slot.bye");
  expect(line.status).toBe("forfeited");
  expect(line.outcome?.kind).toBe("award");
  expect(line.outcome?.winner).toBe(survivor);

  // The control: the other three lines are ordinary two-sided matches, so
  // this is a walkover for ONE seat, not a stage-wide settle.
  for (const f of firstRound.filter((f) => f !== line)) {
    expect(f.home_entrant_id).not.toBeNull();
    expect(f.away_entrant_id).not.toBeNull();
    expect(f.status).toBe("scheduled");
    expect(f.outcome).toBeNull();
  }

  // And the half no API read can settle: what the organiser is SHOWN. The
  // stage has 7 fixtures (4 + 2 + 1) and the run sheet counted every one of
  // them as owed while the vacated line looked like an ordinary match
  // awaiting a draw. `isBye` takes a settled bye out of that count
  // (stages-panel.tsx), so the number itself is the witness — and 6 is not
  // the constant the broken build showed.
  const url = await divisionPath(request, rig.divisionId, "?tab=fixtures");
  await page.goto(url);
  await expect(page.getByText("6 to schedule").first()).toBeVisible();
  await expect(page.getByText("7 to schedule")).toHaveCount(0);

  await screenshotAtWidths(page, testInfo, "walkover-after-confirm", [1280, 768, 320]);
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
});
