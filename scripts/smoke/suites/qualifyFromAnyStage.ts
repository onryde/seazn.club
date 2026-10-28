// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";

/**
 * L3/#414 pass 3 / F3 review item 5 — a multi-stage format built end to end
 * over real HTTP: knockout main draw -> plate, seeded from round-1 losers
 * (roundLosers). Proves the whole chain the ko_plate TEMPLATE actually
 * exercises today: `timing: "setup"` (F3 flipped every picker template to
 * day-one fixtures) means the plate's TBD bracket exists before Main is even
 * generated, and completing Main computes a DRAFT seed proposal rather than
 * auto-filling (owner ruling 12 — propose-and-confirm, never auto-confirm).
 * This used to assert the OLD on_complete wire shape (`done.qualified`),
 * which no picker template has emitted since F3's flip — fixed alongside the
 * `sourcesToTables` gap it uncovered (stage-seeding.ts never fetched a
 * roundLosers source's bracket fixtures, so `computeSeedProposal` could
 * never resolve one; silently swallowed by completeStage's best-effort
 * catch).
 */
export async function qualifyFromAnyStageSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Qfa Cup ${tag}` }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Qfa",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
  await v1(
    admin,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1, members: [] })),
  );
  const entrants = v1data<{ id: string; display_name: string; seed: number | null }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`),
  );
  const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));

  const main = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Main",
    }),
  );
  const plate = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Plate",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    }),
  );

  type Fx = {
    id: string;
    status: string;
    round_no: number;
    seq_in_round: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  };

  // Day-one: the plate's TBD bracket exists before Main has even generated —
  // the whole point of F3's flip to timing:"setup".
  const plateDayOne = v1data<{ created: number; fixtures: Fx[] }>(
    await v1(admin, `/api/v1/stages/${plate.id}/generate`, "POST"),
  );
  check(
    "qfa plate generates a 4-entrant TBD bracket on day one (3 fixtures)",
    plateDayOne.created === 3 &&
      plateDayOne.fixtures.every((f) => f.home_entrant_id === null && f.away_entrant_id === null),
  );

  const gen = v1data<{ fixtures: Fx[] }>(await v1(admin, `/api/v1/stages/${main.id}/generate`, "POST"));
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const round1No = Math.min(...gen.fixtures.map((f) => f.round_no));
  const round1 = gen.fixtures
    .filter((f) => f.round_no === round1No)
    .sort((a, b) => a.seq_in_round - b.seq_in_round);
  check("qfa main round 1 has 4 fixtures", round1.length === 4);
  const expectedLosers = round1.map((f) =>
    (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99)
      ? f.away_entrant_id
      : f.home_entrant_id,
  );

  const decide = async (fid: string, a: number, b: number) => {
    const st = v1data<{ last_seq: number }>(await v1(admin, `/api/v1/fixtures/${fid}/state`));
    return v1(admin, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.last_seq ?? 0,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };

  // Decide the whole bracket, lower seed always wins — regenerate between
  // passes so a later round's winner feed is wired before deciding it.
  for (let guard = 0; guard < 10; guard++) {
    const rows = v1data<{ fixtures: Fx[] }>(
      await v1(admin, `/api/v1/stages/${main.id}/generate`, "POST"),
    ).fixtures;
    const decidable = rows.filter(
      (f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized"].includes(f.status),
    );
    if (decidable.length === 0) break;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }

  // "complete": guarded progression computes a DRAFT proposal, never
  // auto-fills (ruling 12 — same propose-and-confirm contract every
  // timing:"setup" stage gets, not just groups -> KO).
  const done = v1data<{ completed: boolean; seed_proposal?: { id: string; status: string } }>(
    await v1(admin, `/api/v1/stages/${main.id}/complete`, "POST"),
  );
  check("qfa main stage completes", done.completed === true);
  check(
    "qfa main completion computes a draft seed proposal for the plate, never auto-fills",
    done.seed_proposal?.status === "draft",
  );

  // "propose": explicit recompute (the real endpoint an organiser's UI hits;
  // completeStage's own auto-compute above is best-effort and gets marked
  // stale by this call, matching the panel's actual sequence).
  const proposal = v1data<{
    id: string;
    computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: unknown[] };
  }>(await v1(admin, `/api/v1/stages/${plate.id}/seed-proposal`, "POST"));
  check(
    "qfa plate proposal names the 4 round-1 losers, in bracket order",
    JSON.stringify(proposal.computed.qualifiers.map((q) => q.entrantId)) === JSON.stringify(expectedLosers),
  );
  check("qfa plate proposal has no ties", proposal.computed.ties.length === 0);

  // "confirm": fills the plate's TBD fixtures through the same fillSlot
  // pathway intra-bracket advancement uses.
  const confirmed = v1data<{ filled: number; fixtures: Fx[] }>(
    await v1(admin, `/api/v1/stages/${plate.id}/seed-proposal/confirm`, "POST", { proposalId: proposal.id }),
  );
  check("qfa plate confirm seats all 4 losers", confirmed.filled === 4);
  const seated = new Set(
    confirmed.fixtures
      .flatMap((f) => [f.home_entrant_id, f.away_entrant_id])
      .filter((id): id is string => id !== null),
  );
  check(
    "qfa plate fixtures hold exactly the expected losers",
    expectedLosers.every((id) => seated.has(id as string)),
  );
}
