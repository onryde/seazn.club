// What a CONFIRM does with a seat no qualifier is going to take.
//
// Both cases below were found by a reviewer driving the real product, and
// both were introduced by the departed-qualifier filter in
// `computeSeedProposal` — neither was reachable before it, because a
// resolvable progression's slate was never short.
//
// F1 — every qualifier withdraws. The panel showed a `draft` card with the
// four column headers, ZERO rows, and one button: Confirm. Pressing it
// succeeded with `filled: 0` and flipped the proposal to the TERMINAL
// `confirmed` status, after which Recompute 409s SEEDING_ALREADY_CONFIRMED
// forever — including after un-withdrawing everybody — leaving the knockout
// final at `{home: null, away: null, scheduled}` with no route back through
// the product. Strictly worse than the defect the filter fixed.
//
// F2 — ONE qualifier withdraws, the organiser confirms the short draw. The
// vacated side kept its `slot.winner_group` label and a null outcome, which
// is indistinguishable from an ordinary match awaiting a draw: it rendered
// "Winner of Group A vs Driver 2 — Awaiting draw", sat in "1 to schedule"
// forever, and `isBye` (the ONE predicate the run sheet and bracket panel
// both gate on) read false. The owner's ruling is WALKOVER — the opponent
// advances, nobody is promoted — so the vacated side is stamped as a bye and
// `awardSeededByes` settles it.
//
// Every expectation here is read through the predicates the SCREENS use
// (`isBye`) or off the persisted row, never off the code that wrote it.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { isRestBye, isSitOutBye } from "@/lib/fixture-bye";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
} from "../stages";
import { withdrawRegistrationPublic } from "../registrations";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: unknown;
}

async function koFixtures(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** 4 entrants, 2 pools of 2, topNPerGroup(1) -> 2 qualifiers into a
 *  `timing:"setup"` knockout whose single fixture is the final. Every group
 *  match is decided 2-0 to the home side, so the two pool winners are
 *  deterministic and no tie is in play. */
async function setup() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Vacated " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const stages = await createStages(auth, division.id, [
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
  ]);
  const groupStageId = stages.find((s) => s.kind === "group")!.id;
  const koStageId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(auth, koStageId);
  await generateStageFixtures(auth, groupStageId);
  // #850: an odd pool's settled REST-bye rows are not matches to play.
  const groupRows = await sql<
    { id: string; outcome: unknown; home_entrant_id: string | null; away_entrant_id: string | null; ext_key: string | null }[]
  >`select id, outcome, home_entrant_id, away_entrant_id, ext_key from fixtures where stage_id = ${groupStageId}`;
  for (const f of groupRows.filter((x) => !isRestBye(x, "group"))) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  await completeStage(auth, groupStageId);
  return { auth, compId: comp.id, divisionId: division.id, koStageId };
}

describe.skipIf(!HAS_DB)("confirming a draw with a seat nobody will take", () => {
  it("F1: a proposal with NOBODY left refuses the confirm, and stays recomputable", async () => {
    const { auth, koStageId } = await setup();
    const full = await computeSeedProposal(auth, koStageId);
    expect(full.computed.qualifiers, "the control: a full slate has two qualifiers").toHaveLength(2);

    for (const q of full.computed.qualifiers) await withdrawEntrantCascade(auth, q.entrantId);

    // The status flips recomputed the draft; it is now empty. That is the
    // state the organiser's screen was showing a lone Confirm button over.
    const empty = await getSeedProposal(auth, koStageId);
    expect(empty, "no proposal to confirm at all").not.toBeNull();
    expect(empty!.computed.qualifiers).toHaveLength(0);

    await expect(confirmSeedProposal(auth, koStageId, { proposalId: empty!.id })).rejects.toMatchObject({
      status: 422,
      code: "SEEDING_NOTHING_TO_FILL",
    });

    // The refusal must not be the same trap one step later: the row is still
    // draft/stale, so a recompute works and the fixtures are untouched.
    const [row] = await sql<{ status: string }[]>`
      select status from stage_seed_proposals where id = ${empty!.id}`;
    expect(row!.status, "the refusal confirmed the proposal anyway").not.toBe("confirmed");
    for (const f of await koFixtures(koStageId)) {
      expect(f.status, "an empty confirm settled a fixture").toBe("scheduled");
    }

    // …and once the field is settled again the organiser is back in business.
    // THE point of refusing rather than confirming an empty draw.
    const [first] = full.computed.qualifiers;
    await sql`update entrants set status = 'confirmed' where id = ${first!.entrantId}`;
    const again = await computeSeedProposal(auth, koStageId);
    expect(again.computed.qualifiers.map((q) => q.entrantId)).toContain(first!.entrantId);
  });

  it("F2: a vacated seat becomes a walkover for the entrant who is still there", async () => {
    const { auth, koStageId } = await setup();
    const full = await computeSeedProposal(auth, koStageId);
    const departing = full.computed.qualifiers[0]!.entrantId;
    const survivor = full.computed.qualifiers[1]!.entrantId;

    // The control: with nobody withdrawn this final is an ordinary two-sided
    // match. Without it, "the fixture is settled" below could be satisfied by
    // a confirm that settles every line it touches.
    const beforeRig = await setup();
    const beforeProposal = await computeSeedProposal(beforeRig.auth, beforeRig.koStageId);
    await confirmSeedProposal(beforeRig.auth, beforeRig.koStageId, { proposalId: beforeProposal.id });
    const control = (await koFixtures(beforeRig.koStageId))[0]!;
    expect(control.status).toBe("scheduled");
    expect(control.outcome).toBeNull();
    expect(isBye(control as unknown as RunSheetFixture)).toBe(false);

    await withdrawEntrantCascade(auth, departing);
    const short = await getSeedProposal(auth, koStageId);
    expect(short!.computed.qualifiers).toHaveLength(1);
    await confirmSeedProposal(auth, koStageId, { proposalId: short!.id });

    const [final] = await koFixtures(koStageId);
    const seated = final!.home_entrant_id ?? final!.away_entrant_id;
    expect(seated, "the surviving qualifier was not seated").toBe(survivor);
    expect(final!.home_entrant_id === null || final!.away_entrant_id === null).toBe(true);

    // The vacated side no longer claims a draw is coming…
    const vacatedLabel = final!.home_entrant_id === null ? final!.home_slot_label : final!.away_slot_label;
    expect(vacatedLabel?.key, "the vacated seat still advertises a qualifier").toBe("bracket.slot.bye");

    // …and the line is SETTLED, awarded to the survivor. Asserted through
    // `isBye` — the predicate the run sheet row and the bracket panel both
    // gate their bye branch on — so this pins what an organiser is shown,
    // not just what a column holds.
    expect(final!.status).toBe("forfeited");
    expect(final!.outcome).toMatchObject({ kind: "award", winner: survivor });
    expect(isBye(final as unknown as RunSheetFixture), "the screen still reads this as an open match").toBe(
      true,
    );
    // …but it is a WALKOVER, not the draw's sit-out: the vacated seat carries
    // the PLAIN bye label, never the draw's marker, so the calendar feed keeps
    // emitting it as it did before #850 (orchestrator ruling 2026-09-24).
    expect(vacatedLabel, "a vacated seat is not dressed as the draw's bye").toEqual({ key: "bracket.slot.bye", params: {} });
    expect(isSitOutBye({ ...final!, ext_key: null }, "knockout")).toBe(false);

    // Nobody was promoted: the departed qualifier is not in the fixture, and
    // no third party took her seat.
    expect([final!.home_entrant_id, final!.away_entrant_id]).not.toContain(departing);
  });

  it("F2: confirming a FULL slate still leaves an ordinary two-sided match", async () => {
    // The guard must not relabel seats on a draw that lost nobody — an
    // over-eager version of this fix would bye out every unfilled slot in the
    // stage, including the ones a later round is waiting on.
    const { auth, koStageId } = await setup();
    const full = await computeSeedProposal(auth, koStageId);
    await confirmSeedProposal(auth, koStageId, { proposalId: full.id });

    const [final] = await koFixtures(koStageId);
    expect(final!.home_entrant_id).not.toBeNull();
    expect(final!.away_entrant_id).not.toBeNull();
    expect(final!.status).toBe("scheduled");
    expect(final!.outcome).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the hook that keeps a draft fresh", () => {
  it("a DISQUALIFICATION through patchEntrant refreshes the draft, exactly as a withdrawal does", async () => {
    // Mutant M21 (reviewer): narrowing DEPARTED_STATUSES to ["withdrawn"]
    // left the whole suite green, because both existing disqualification
    // tests set the status with raw SQL and so never drive the hook at all.
    // This one goes through `patchEntrant`, which is what the hook hangs off.
    const { auth, koStageId } = await setup();
    const { patchEntrant } = await import("../entrants");
    const before = await computeSeedProposal(auth, koStageId);
    expect(before.computed.qualifiers).toHaveLength(2);
    const departing = before.computed.qualifiers[0]!.entrantId;

    await patchEntrant(auth, departing, { status: "disqualified" });

    const after = await getSeedProposal(auth, koStageId);
    expect(after!.id, "the draft was not refreshed").not.toBe(before.id);
    expect(after!.status).toBe("draft");
    expect(after!.computed.qualifiers.map((q) => q.entrantId)).not.toContain(departing);
  });

  it("F3: the PUBLIC self-cancel refreshes the draft too - patchEntrant is not the only writer", async () => {
    // Review finding F3 (2026-09-21): the hook was hung off `patchEntrant`
    // and described there as "the single status funnel". It is not.
    // `withdrawCore` (registrations.ts) flips `entrants.status` in raw SQL,
    // and it is reached by three shipped routes including the registrant's
    // OWN cancel link - the highest-volume withdrawal there is. Without a
    // second call site, that cancel left the organiser looking at a draft
    // that still named the departed entrant, whose Confirm 422s and whose
    // card carries no Recompute.
    //
    // The registration is seeded and bound to an existing entrant the way
    // `_registration-fixtures` seeds every other post-submit case (public
    // submit is deleted, RS001); what is REAL here is withdrawCore and the
    // route that calls it.
    const { auth, compId, divisionId, koStageId } = await setup();
    const before = await computeSeedProposal(auth, koStageId);
    const departing = before.computed.qualifiers[0]!.entrantId;

    const { registration, access_token } = await seedRegistration(
      compId,
      divisionId,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" as const },
      { displayName: "Self Cancel", status: "confirmed" },
    );
    await sql`update registrations set entrant_id = ${departing} where id = ${registration.id}`;

    await withdrawRegistrationPublic(registration.id, access_token);

    // The raw-SQL writer really ran - otherwise the assertion below would be
    // about a field change that never happened.
    const [ent] = await sql<{ status: string }[]>`select status from entrants where id = ${departing}`;
    expect(ent!.status, "withdrawCore did not flip the entrant").toBe("withdrawn");

    const after = await getSeedProposal(auth, koStageId);
    expect(after!.id, "the self-cancel left the draft untouched").not.toBe(before.id);
    expect(after!.computed.qualifiers.map((q) => q.entrantId)).not.toContain(departing);
  });

  it("M15: leaves an `on_complete` stage's draft alone — the timing filter is load-bearing", async () => {
    // Mutant M15 (reviewer): deleting `and s.progression ->> 'timing' =
    // 'setup'` from the stale query left the suite green.
    //
    // Recorded finding, because it changes what this test can be: no route in
    // today's product puts a proposal row against an `on_complete` stage.
    // `computeSeedProposal` refuses a stage with no TBD fixtures
    // ("generate its fixtures first"), and an `on_complete` stage cannot HAVE
    // TBD fixtures — `generateStageFixtures` refuses it before its source
    // completes, and after completion `seedNextStage` generates it straight
    // from the frozen `config.qualified` with real entrants in the seats. So
    // the narrowing is a DEFENSIVE guard, and the row below is inserted the
    // way competition-desk.test.ts inserts its own synthetic proposals. What
    // is real here is the query, and what it must not do to a row it finds.
    const { auth, divisionId, koStageId } = await setup();
    const setupDraft = await computeSeedProposal(auth, koStageId);
    expect(setupDraft.computed.qualifiers).toHaveLength(2);

    const [onComplete] = await createStages(auth, divisionId, [
      {
        seq: 3,
        kind: "knockout",
        name: "Later KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status)
              select org_id, ${onComplete!.id}, '{}'::jsonb, 'draft' from stages where id = ${onComplete!.id}`;
    const [before] = await sql<{ id: string; status: string }[]>`
      select id, status from stage_seed_proposals where stage_id = ${onComplete!.id}`;

    await withdrawEntrantCascade(auth, setupDraft.computed.qualifiers[0]!.entrantId);

    // The control, and the reason this cannot pass vacuously: the hook DID
    // run over this division and DID reach the setup-timing draft beside it.
    const refreshed = await getSeedProposal(auth, koStageId);
    expect(refreshed!.id, "the hook never ran — the on_complete assertion below proves nothing").not.toBe(
      setupDraft.id,
    );

    const [after] = await sql<{ id: string; status: string }[]>`
      select id, status from stage_seed_proposals where stage_id = ${onComplete!.id}`;
    expect(after!.id, "the on_complete stage's proposal was replaced by the field-change hook").toBe(
      before!.id,
    );
    expect(after!.status, "the on_complete stage's proposal was staled by the field-change hook").toBe(
      "draft",
    );
  });
});

describe.skipIf(!HAS_DB)("a tie whose seat nobody is left to take", () => {
  /** Two pools of THREE, each pool a perfect cycle (X beats Y, Y beats Z,
   *  Z beats X, every result 2-0), so each pool is a three-way tie on points,
   *  goal difference and goals for. `topNPerGroup(1)` therefore offers two
   *  qualifiers and asks two ambiguities — one per pool. */
  async function tiedSetup() {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Tied " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 6 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `T${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const stages = await createStages(auth, division.id, [
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
    ]);
    const groupStageId = stages.find((s) => s.kind === "group")!.id;
    const koStageId = stages.find((s) => s.kind === "knockout")!.id;
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);

    // #850: pools of three rest one member per round on a settled REST-bye
    // row; the cycle below is built from, and played over, the MATCHES.
    const fixtures = (
      await sql<
        { id: string; pool: string | null; home_entrant_id: string; away_entrant_id: string; outcome: unknown; ext_key: string | null }[]
      >`select id, pool_id as pool, home_entrant_id, away_entrant_id, outcome, ext_key
        from fixtures where stage_id = ${groupStageId} order by pool_id, seq_in_round`
    ).filter((f) => !isRestBye(f, "group"));
    const cycleIndex = new Map<string, number>();
    const seen = new Map<string, string[]>();
    for (const f of fixtures) {
      const pool = f.pool ?? "";
      const members = seen.get(pool) ?? [];
      for (const id of [f.home_entrant_id, f.away_entrant_id]) {
        if (!members.includes(id)) members.push(id);
      }
      seen.set(pool, members);
    }
    for (const members of seen.values()) members.forEach((id, i) => cycleIndex.set(id, i));
    for (const f of fixtures) {
      const h = cycleIndex.get(f.home_entrant_id)!;
      const a = cycleIndex.get(f.away_entrant_id)!;
      const homeWins = (h + 1) % 3 === a;
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, {
        type: "generic.result",
        payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 },
      });
    }
    await completeStage(auth, groupStageId);
    return { auth, koStageId };
  }

  it("M8: drops the tie whose slots all vacated, and KEEPS the one that did not", async () => {
    // Mutant M8 (reviewer): dropping `t.slots.length > 0` from the tie filter
    // left the suite green, because no existing test had a tie whose SEAT
    // went away while two of its candidates stayed. That is the state here:
    // the provisional qualifier of one pool withdraws, so her destination
    // slot is no longer offered, but the two entrants she was tied with are
    // still in the field. Offering that tie asks the organiser to choose
    // between two people for a seat that is not on the table, and whichever
    // she picks is then double-assigned against her own surviving slot.
    const { auth, koStageId } = await tiedSetup();
    const before = await computeSeedProposal(auth, koStageId);
    expect(before.computed.ties, "the rig did not produce two three-way ties").toHaveLength(2);
    for (const t of before.computed.ties) {
      expect(t.slots).toHaveLength(1);
      expect(t.entrantIds).toHaveLength(3);
    }

    // Withdraw the provisional holder of the FIRST tie's seat: the qualifier
    // whose destinationSlot is that tie's only slot.
    const doomedSlot = before.computed.ties[0]!.slots[0]!;
    const holder = before.computed.qualifiers.find((q) => q.destinationSlot === doomedSlot)!;
    await withdrawEntrantCascade(auth, holder.entrantId);

    const after = await getSeedProposal(auth, koStageId);
    // Exactly ONE tie left — not zero. The surviving pool's ambiguity is
    // still owed, so "drop every tie" would pass a bare `toHaveLength(0)`.
    expect(after!.computed.ties, "the surviving pool's tie was dropped too").toHaveLength(1);
    expect(after!.computed.ties[0]!.slots, "a tie was offered for a seat nobody can take").not.toHaveLength(
      0,
    );
    expect(after!.computed.ties[0]!.slots).not.toContain(doomedSlot);
    expect(after!.computed.ties[0]!.entrantIds).not.toContain(holder.entrantId);
  });
});
