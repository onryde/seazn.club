import { swissRoundsForFieldSize } from "../../../apps/web/src/lib/swiss-rounds.ts";
// Round-1 Swiss pairs by seed, from the engine's own `pairRound` — the same
// derivation the desk's pairing hint prints. Its one value import is the engine's
// dependency-free `scheduling/swiss` leaf (the rest are `import type`), so it
// loads under this runner's `--experimental-strip-types` like the line above.
import { roundOnePairs } from "../../../apps/web/src/lib/swiss-pairing.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Swiss Knockout (own fresh FREE session — and that IS the point).
 *
 * Both halves are free stage kinds, so a community org must be able to build
 * the whole composite through the real route with no 402 anywhere.
 * format-gates.test.ts asserts the gate FUNCTION; only this asserts the
 * answer against the LIVE plan matrix, over real HTTP, on a real community
 * bill — the one place a catalogue entry shipped without `pro` and a plan row
 * that disagrees would actually show up.
 *
 * Then the shape the format exists for, which no other suite drives over the
 * wire: a Top 3 out of a 4-entrant field is a bracket of FOUR with one bye —
 * the swiss winner waits while 2nd plays 3rd, and the Final is seated with
 * the bye entrant before that semi is played.
 *
 * The stages are POSTed as the catalogue builds them at Top 3, with the
 * organiser-set `rounds` the picker now stamps on every swiss draft. First
 * Generate (here via `startDivision` on the empty first stage) mints every
 * round's shells with null sides; Pair next (a later Generate) seats one round
 * at a time while unseated future shells do not block readiness.
 */
export async function swissKnockoutSuite(): Promise<void> {
  const free = newSession();
  await signIn(free, `delivered+swissko_${tag}@resend.dev`);
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `SwissKO ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const names = ["Ann", "Bo", "Cy", "Di"];
  const entrants = v1data<{ id: string; display_name: string; seed: number | null }[]>(
    await v1(
      free,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
    ),
  );
  const nameOf = new Map(entrants.map((e) => [e.id, e.display_name]));
  const rank = (id: string | null) => names.indexOf(nameOf.get(id ?? "") ?? "zz");
  const SWISS_ROUNDS = swissRoundsForFieldSize(names.length);

  // Exactly what format-templates.ts's swiss_knockout build() emits at
  // qualified: 3, with the rounds knob stamped onto the swiss stage.
  const shipped = [
    {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: SWISS_ROUNDS },
      progression: null,
    },
    {
      seq: 2,
      kind: "knockout",
      name: "Knockout",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ];
  const created = await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", shipped);
  check(
    "swiss knockout: a COMMUNITY org builds the whole composite — no 402 on either half, against the live plan matrix",
    created.status === 201,
  );

  const stages = v1data<{ id: string; kind: string; seq: number; config: { rounds?: number } }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`),
  );
  check(
    "swiss knockout: the shipped draft carries organiser-set rounds",
    stages.find((s) => s.seq === 1)!.config.rounds === SWISS_ROUNDS,
  );
  const swissId = stages.find((s) => s.seq === 1)!.id;
  const koId = stages.find((s) => s.seq === 2)!.id;

  type Fx = {
    id: string;
    stage_id: string;
    status: string;
    round_no: number;
    is_final?: boolean;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    // The two columns a bye is READ from — the outcome `isBye` gates on
    // (lib/run-sheet-groups) and the label the phantom side carries. Pulled
    // over the wire rather than out of Postgres on purpose: the serving API
    // is what the run sheet and the bracket panel actually consume, and a
    // fix that lands in the table but not in this payload is still a defect
    // on screen.
    outcome: { kind?: string; winner?: string } | null;
    away_slot_label: { key?: string } | null;
  };
  const fixturesOf = async (stageId: string): Promise<Fx[]> =>
    v1data<Fx[]>(await v1(free, `/api/v1/divisions/${div.id}/fixtures`)).filter(
      (f) => f.stage_id === stageId,
    );

  // Day one: the whole bracket exists as placeholders before a ball is
  // struck. THREE rows for a Top 3 — a bye line, a semi, and the Final.
  const koDayOne = v1data<{ created: number; fixtures: Fx[] }>(
    await v1(free, `/api/v1/stages/${koId}/generate`, "POST"),
  );
  check(
    "swiss knockout: a Top 3 mints a 3-row day-one bracket, all slots TBD",
    koDayOne.created === 3 &&
      koDayOne.fixtures.every((f) => f.home_entrant_id === null && f.away_entrant_id === null),
  );

  const isSeated = (f: Fx) =>
    f.outcome?.kind === "award" || (f.home_entrant_id !== null && f.away_entrant_id !== null);

  const started = v1data<{ generated: number }>(await v1(free, `/api/v1/divisions/${div.id}/start`, "POST"));
  check(
    "swiss knockout: startDivision mints N×boards empty shells — none seated",
    started.generated === SWISS_ROUNDS * 2,
  );
  const minted = await fixturesOf(swissId);
  check(
    "swiss knockout: every minted shell has null sides",
    minted.length === SWISS_ROUNDS * 2 &&
      minted.every((f) => f.home_entrant_id === null && f.away_entrant_id === null),
  );

  const pairR1 = v1data<{ created: number }>(await v1(free, `/api/v1/stages/${swissId}/generate`, "POST"));
  const afterPairR1 = await fixturesOf(swissId);
  check(
    "swiss knockout: Pair next seats round 1 while later shells stay unseated — no STAGE_NOT_READY from future rounds",
    pairR1.created === 2 &&
      afterPairR1.filter((f) => f.round_no === 1).every(isSeated) &&
      afterPairR1.filter((f) => f.round_no > 1).every((f) => !isSeated(f)),
  );

  // …and seated TOP-VS-BOTTOM, although this stage is stored as Neighbours
  // (2026-09-22, Swiss round-1 pairing): before any result the only rank is the
  // seed, so neighbours would send the top two seeds at each other in round
  // one. Seated is not enough — the boards themselves are checked, by seed,
  // against `roundOnePairs`, the derivation the desk's hint prints (the
  // engine's own pairRound), never a typed table. The seeds are read back from
  // the server and must be exactly 1..N first, or positions and seeds could
  // differ and the comparison would be meaningless; and fold must differ from
  // Neighbours for this field, or the check could not tell the two apart.
  const seedOf = new Map(entrants.map((e) => [e.id, e.seed]));
  const seedsOneToN =
    JSON.stringify([...seedOf.values()].sort((a, b) => (a ?? 0) - (b ?? 0))) ===
    JSON.stringify(names.map((_, i) => i + 1));
  const bySeed = (pairs: Array<[number, number]>) =>
    pairs
      .map(([a, b]) => (a < b ? [a, b] : [b, a]))
      .sort((x, y) => x[0] - y[0])
      .map(([a, b]) => `${a}v${b}`);
  const seatedR1BySeed = bySeed(
    afterPairR1
      .filter((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
      .map((f): [number, number] => [seedOf.get(f.home_entrant_id!) ?? 0, seedOf.get(f.away_entrant_id!) ?? 0]),
  );
  const foldR1 = bySeed(roundOnePairs(names.length, "fold"));
  check(
    "swiss knockout: round 1 is paired top-vs-bottom by seed (1v3, 2v4…) on a Neighbours stage — not seed 1 v seed 2",
    seedsOneToN &&
      JSON.stringify(foldR1) !== JSON.stringify(bySeed(roundOnePairs(names.length, "rank_adjacent"))) &&
      JSON.stringify(seatedR1BySeed) === JSON.stringify(foldR1),
  );

  // Play every declared round out, Pair next between rounds, lower seed winning
  // every time so the table is strict on wins: Ann > Bo > Cy > Di.
  for (let round = 1; round <= SWISS_ROUNDS; round++) {
    if (round > 1) await v1(free, `/api/v1/stages/${swissId}/generate`, "POST");
    for (const f of await fixturesOf(swissId)) {
      if (f.round_no !== round) continue;
      if (!f.home_entrant_id || !f.away_entrant_id) continue;
      if (f.status === "decided" || f.status === "finalized") continue;
      const homeWins = rank(f.home_entrant_id) < rank(f.away_entrant_id);
      const state = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${f.id}/state`));
      await v1(free, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: state.last_seq,
        type: "generic.result",
        payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
      });
    }
  }
  check(
    "swiss knockout: the swiss stopped at the organiser-set round budget",
    (await fixturesOf(swissId)).length === SWISS_ROUNDS * 2,
  );

  const done = v1data<{ completed: boolean }>(await v1(free, `/api/v1/stages/${swissId}/complete`, "POST"));
  check("swiss knockout: the swiss completes once every declared round is played", done.completed === true);
  const proposal = v1data<{ id: string; computed: { qualifiers: { entrantId: string }[] } }>(
    await v1(free, `/api/v1/stages/${koId}/seed-proposal`, "POST"),
  );
  check(
    "swiss knockout: the proposal names the swiss's top THREE in table order, not the top four",
    proposal.computed.qualifiers.map((q) => nameOf.get(q.entrantId)).join(",") === "Ann,Bo,Cy",
  );
  await v1(free, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal.id });

  const bracket = await fixturesOf(koId);
  const rounds = [...new Set(bracket.map((f) => f.round_no))].sort((a, b) => a - b);
  const first = bracket.filter((f) => f.round_no === rounds[0]);
  const bye = first.find((f) => f.away_entrant_id === null);
  const semi = first.find((f) => f.away_entrant_id !== null);
  const final = bracket.find((f) => f.round_no === rounds[1]);
  check(
    "swiss knockout: the bye belongs to the SWISS WINNER, and 2nd plays 3rd — not the other way round",
    rounds.length === 2 &&
      nameOf.get(bye?.home_entrant_id ?? "") === "Ann" &&
      [nameOf.get(semi?.home_entrant_id ?? ""), nameOf.get(semi?.away_entrant_id ?? "")].sort().join(",") === "Bo,Cy",
  );
  // …and the bye is SETTLED, over the wire. A progression-seeded bracket is
  // drawn before anyone qualifies, so the walkover cannot be baked at
  // generation time; it is recorded when the seat is filled
  // (`awardSeededByes`, confirmSeedProposal). Left undone, this row reaches
  // the API as `scheduled` with a null outcome — which `isBye` reads as
  // false, so the run sheet and the bracket panel render "Ann vs TBD —
  // awaiting draw" on a match nobody can ever play, and the stage can never
  // complete. Asserted on the serving payload, not just in Postgres.
  check(
    "swiss knockout: the bye reaches the API as a WALKOVER — forfeited, award to the bye entrant, 'Bye' on the empty seat",
    bye?.status === "forfeited" &&
      bye.outcome?.kind === "award" &&
      bye.outcome.winner === bye.home_entrant_id &&
      bye.away_slot_label?.key === "bracket.slot.bye",
  );
  // The positive above needs its negative pair, or "the bye is decided" also
  // passes on a build that decides EVERY one-sided line: the Final is seated
  // with Ann and still waiting on the semi winner, and it must stay open.
  check(
    "swiss knockout: the half-filled Final is NOT swept up as a bye — it is still a match to play",
    final?.status === "scheduled" && (final.outcome ?? null) === null,
  );
  check(
    "swiss knockout: the Final is already seated with the bye entrant, its other side still open",
    final?.is_final === true &&
      [final.home_entrant_id, final.away_entrant_id].filter((x) => x !== null).map((x) => nameOf.get(x)).join(",") === "Ann" &&
      [final.home_entrant_id, final.away_entrant_id].filter((x) => x === null).length === 1,
  );
  check(
    "swiss knockout: the 4th-placed entrant is nowhere in the bracket — Top 3 means three",
    bracket.every(
      (f) =>
        nameOf.get(f.home_entrant_id ?? "") !== "Di" && nameOf.get(f.away_entrant_id ?? "") !== "Di",
    ),
  );
}
