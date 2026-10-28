// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * D4a/P5 stage progression (own fresh free session — not an entitlement
 * gate): seed a division whose knockout stage declares progression with
 * timing: "setup" (F2 unified the old `.seeding`/`.qualification` split
 * onto this one field), generate its TBD placeholder fixtures BEFORE the
 * group stage is even generated, decide the group stage, complete
 * it, propose, confirm, and score the now-real next-stage fixture — proving
 * the whole chain is actually playable end to end, not just that entrants
 * landed in the right cells.
 */
export async function stageProgressionSuite(): Promise<void> {
  const free = newSession();
  const { org_id: freeOrgId } = await signIn(free, `delivered+dtx_seed_${tag}@resend.dev`);
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `DTX Seed ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    free,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Seed ${i + 1}`, seed: i + 1 })),
  );
  const stages = v1data<{ id: string; kind: string }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]),
  );
  const groupId = stages.find((s) => s.kind === "group")!.id;
  const koId = stages.find((s) => s.kind === "knockout")!.id;

  // "seed": TBD fixtures exist up front, before the group stage has even
  // been generated — the owner's "placeholders at setup time" ruling.
  type SlotLabelWire = { key: string; params: Record<string, unknown> } | null;
  const koGen = v1data<{
    created: number;
    fixtures: {
      id: string;
      home_entrant_id: string | null;
      home_slot_label: SlotLabelWire;
      away_slot_label: SlotLabelWire;
    }[];
  }>(await v1(free, `/api/v1/stages/${koId}/generate`, "POST"));
  check(
    "stage progression: setup-timing KO generates 1 fully-TBD fixture before the group stage runs at all",
    koGen.created === 1 && koGen.fixtures[0].home_entrant_id === null,
  );
  // P6 (D4b task A) fix round 1 — smoke coverage for the data contract every
  // localized renderer this task wired depends on: a real server, real DB,
  // real V360/V362 columns, real /generate response — not a mock. Both
  // slots of the fully-TBD KO fixture must carry a real {key,params}
  // descriptor (this seeding — 2 pools, top 1 each — always produces
  // slot.winner_group), never null and never a hand-built string.
  {
    const home = koGen.fixtures[0].home_slot_label;
    const away = koGen.fixtures[0].away_slot_label;
    check(
      "stage progression: the TBD KO fixture's home/away slot labels are real {key,params} descriptors (V360/V362, not a raw string)",
      home?.key === "slot.winner_group" &&
        away?.key === "slot.winner_group" &&
        typeof home.params.g === "string" &&
        typeof away.params.g === "string" &&
        home.params.g !== away.params.g,
    );
  }

  // F3 Task 4 — day-one fixtures must SURVIVE a schedule BUILD, not just
  // exist. Runs BEFORE the group stage is even generated (same "before the
  // group stage runs at all" moment the check above proves) — the fully-TBD
  // KO fixture from `koGen` above is the day-one placeholder under test. No
  // placement service is assumed reachable here (a bare smoke run), so BUILD
  // legitimately falls back to its greedy path; that fallback surviving
  // cleanly is exactly the claim, not a solved-optimal board.
  {
    const koFixtureIdPreBuild = koGen.fixtures[0].id;
    const homeLabelBefore = koGen.fixtures[0].home_slot_label;
    const awayLabelBefore = koGen.fixtures[0].away_slot_label;
    const buildVenue = v1data<{ id: string }>(
      await v1(free, `/api/v1/orgs/${freeOrgId}/venues`, "POST", { name: `DTX Build ${tag}` }),
    );
    const buildCourt = v1data<{ id: string }>(
      await v1(free, `/api/v1/orgs/${freeOrgId}/venues/${buildVenue.id}/courts`, "POST", { name: "Court 1" }),
    );
    await v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: "2026-08-01T09:00:00.000Z",
        matchMinutes: 60,
        gapMinutes: 0,
        courts: [buildCourt.id],
        perEntrantMinRest: 0,
        sessionWindows: [],
      },
    });
    const koBuild = v1data<{
      assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    }>(await v1(free, `/api/v1/stages/${koId}/schedule/auto`, "POST", { only_unlocked: false, mode: "build" }));
    check(
      "day-one BUILD: the fully-TBD KO fixture is schedulable — BUILD proposes it a slot, same as any real fixture",
      koBuild.assignments.length === 1 && koBuild.assignments[0].fixture_id === koFixtureIdPreBuild,
    );
    await v1(free, `/api/v1/stages/${koId}/schedule/apply`, "POST", {
      assignments: koBuild.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    });
    const koAfterBuild = v1data<{
      id: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      home_slot_label: SlotLabelWire;
      away_slot_label: SlotLabelWire;
      scheduled_at: string | null;
      court_id: string | null;
    }>(await v1(free, `/api/v1/fixtures/${koFixtureIdPreBuild}`));
    check(
      "day-one BUILD: the SAME fixture id survives — BUILD did not delete/regenerate the placeholder",
      koAfterBuild.id === koFixtureIdPreBuild,
    );
    check(
      "day-one BUILD: still fully TBD after BUILD+apply — no entrant silently attached",
      koAfterBuild.home_entrant_id === null && koAfterBuild.away_entrant_id === null,
    );
    check(
      "day-one BUILD: both slot labels survive BUILD+apply unchanged (still real descriptors, not TBD/null)",
      koAfterBuild.home_slot_label?.key === "slot.winner_group" &&
        koAfterBuild.away_slot_label?.key === "slot.winner_group" &&
        koAfterBuild.home_slot_label?.params.g === homeLabelBefore?.params.g &&
        koAfterBuild.away_slot_label?.params.g === awayLabelBefore?.params.g,
    );
    check(
      "day-one BUILD: the placeholder actually landed on the timetable (real scheduled_at + its court)",
      koAfterBuild.scheduled_at !== null && koAfterBuild.court_id === buildCourt.id,
    );
  }

  const groupGen = v1data<{ fixtures: { id: string }[] }>(
    await v1(free, `/api/v1/stages/${groupId}/generate`, "POST"),
  );
  // Scoring is closed until the division starts (WRONG_PHASE otherwise) —
  // missing this call was the actual root cause of a prior CI failure here:
  // the event POSTs below 422'd silently (unchecked), fixtures stayed
  // undecided, completeStageIfReady correctly returned false, and BOTH
  // downstream checks failed for a reason neither of them named.
  const started = await v1(free, `/api/v1/divisions/${div.id}/start`, "POST");
  check("stage progression: division starts", started.status < 300);
  for (const f of groupGen.fixtures) {
    const state = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${f.id}/state`));
    const scored = await v1(free, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    check(`stage progression: group fixture ${f.id} scores 201`, scored.status === 201);
  }

  // "complete": guarded progression computes a DRAFT proposal, never
  // auto-fills.
  const completed = v1data<{ completed: boolean; seed_proposal?: { id: string; status: string } }>(
    await v1(free, `/api/v1/stages/${groupId}/complete`, "POST"),
  );
  check(
    "stage progression: complete computes a draft seed proposal, never auto-fills",
    completed.completed === true && completed.seed_proposal?.status === "draft",
  );

  // "propose": explicit recompute (the real endpoint an organiser's UI hits).
  const proposal = v1data<{
    id: string;
    computed: { qualifiers: { entrantId: string; destinationSlot: string }[] };
  }>(await v1(free, `/api/v1/stages/${koId}/seed-proposal`, "POST"));
  check("stage progression: proposal names both qualifiers", proposal.computed.qualifiers.length === 2);

  // P6 (D4b task B) — the proposal panel's edit-in-place sends `edits[]`
  // overriding the computed slate (buildEditsPayload). Prove the SAME
  // confirm route the panel calls honours an organiser's override through
  // real HTTP: swap the two qualifiers' destination slots rather than
  // confirming the computed (unedited) assignment P5's own smoke coverage
  // already exercised.
  const [q0, q1] = proposal.computed.qualifiers;
  const swapEdits = [
    { destinationSlot: q0.destinationSlot, entrantId: q1.entrantId },
    { destinationSlot: q1.destinationSlot, entrantId: q0.entrantId },
  ];

  // "confirm": fills the TBD fixture through the same fillSlot pathway
  // intra-bracket advancement uses — with the organiser's edit applied.
  const confirmed = v1data<{
    filled: number;
    fixtures: {
      id: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      home_slot_label: SlotLabelWire;
      away_slot_label: SlotLabelWire;
    }[];
  }>(
    await v1(free, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", {
      proposalId: proposal.id,
      edits: swapEdits,
    }),
  );
  check(
    "stage progression: confirm fills both KO slots",
    confirmed.filled === 2 &&
      confirmed.fixtures[0].home_entrant_id !== null &&
      confirmed.fixtures[0].away_entrant_id !== null,
  );
  // The panel's edit-in-place actually took effect — the SWAPPED entrant
  // landed in each slot, not the engine's computed default.
  {
    const fixture = confirmed.fixtures[0];
    const [side0, side1] = [q0.destinationSlot.split(":")[1], q1.destinationSlot.split(":")[1]];
    const landedForQ0Slot = side0 === "home" ? fixture.home_entrant_id : fixture.away_entrant_id;
    const landedForQ1Slot = side1 === "home" ? fixture.home_entrant_id : fixture.away_entrant_id;
    check(
      "stage progression: confirm honours the panel's edit-in-place override — the SWAPPED entrant lands, not the computed one",
      landedForQ0Slot === q1.entrantId && landedForQ1Slot === q0.entrantId,
    );
  }
  // P6 (D4b task A) fix round 1 — the schema comment's "Cleared on fill"
  // contract (schemas.ts's Fixture.home_slot_label), proved end to end: a
  // filled slot must not keep carrying stale descriptor text a renderer
  // could show ALONGSIDE the real entrant name.
  check(
    "stage progression: filling a slot clears its label — never lingers next to the real entrant name",
    confirmed.fixtures[0].home_slot_label === null && confirmed.fixtures[0].away_slot_label === null,
  );

  // "next stage playable": the now-real fixture accepts a score exactly like
  // any other — the scoring guard's WRONG_PHASE only ever fired while it was
  // still TBD, and that window has closed.
  const koFixtureId = confirmed.fixtures[0].id;
  const koState = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${koFixtureId}/state`));
  const koScore = await v1(free, `/api/v1/fixtures/${koFixtureId}/events`, "POST", {
    expected_seq: koState.last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  check("stage progression: next stage is playable — the now-filled KO fixture scores 201", koScore.status === 201);
}
