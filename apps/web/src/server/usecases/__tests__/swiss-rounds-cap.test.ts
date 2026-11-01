// W3 Task 11 — round-count caps on Postgres (SW-H2, RB3-3; rule X-SW-16). Rulebook-W3-swiss.md §3.1 "Bounds (n = active
// field at the time of pairing)": a Swiss round count above the field's HARD maximum (n − 1 for an even field, n for an
// odd one) is refused, "again at Start and at every Generate (the field can shrink after creation)" (§3.2); between the
// safe maximum ⌊n/2⌋ and the hard one it is allowed with a warning (`GenerateOutcome.swiss_rounds`).
//
// Expected values are the rulebook's numbers typed here (a field of 4: hard max 3; 5: 5; 6: safe 3, hard 5, 3
// recommended — §3.2's table), never read off `judgeSwissRounds`. Every write the refusal must NOT make is checked against
// the rows and the ledger as they stood before it.
//
// Sports: the refusal at Generate is swept over every sport the registry offers a Swiss to. The sequences (Start, the
// shrink, the warning, the field paired now) run for badminton and chess (boardgame): the bounds are arithmetic on the
// field, chess is the one sport whose Pair differs (its colour rules), and badminton is the house racket sport.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { templatesForSport } from "@/lib/format-templates";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, rebuildStageFixtures, unpairSwissRound } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = { sport: string; variant: string };
type Kind = "individual" | "pair" | "team";

/** The refusal as the table declares it: 422 as sent (Generate, Start); 409 when Finish resolves it (controller rule
 *  "422 when it can never succeed as sent, 409 when it is resolvable another way"). */
const ABOVE_MAX = { status: SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.status, code: "SWISS_ROUNDS_ABOVE_MAX" };
const ABOVE_MAX_RESOLVABLE = { status: SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.resolvableStatus, code: "SWISS_ROUNDS_ABOVE_MAX" };

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  kind: Kind;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

/** A roster entry of the kind's own shape: one inline person per seat, at most two (`entrantKindCap`). */
function entrantInput(kind: Kind, name: string, seed?: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/** N seeded entrants of the sport's own default kind and a Swiss of `rounds` — NOT started, nothing generated. */
async function swissRig(sport: Sport, n: number, rounds: number, auth?: AuthCtx): Promise<Rig> {
  const owner = auth ?? (await seedOrg("pro")).auth;
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Rounds cap " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const sportModule = builtinModules.find((m) => m.key === sport.sport)!;
  const kind = (sportModule.entrantModel?.defaultKind ?? "individual") as Kind;
  const made = await createEntrants(
    owner,
    division.id,
    Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)),
  );
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  return { sport, auth: owner, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, kind, entrants: made.map((e) => e.id) };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  scheduled_at: Date | null;
  court_id: string | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const boardsOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r && !isBye(f));

async function ledgerState(divisionId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  const [d] = await sql<{ seq: string | number; status: string }[]>`select seq, status from divisions where id = ${divisionId}`;
  return { events: n, seq: Number(d!.seq), status: d!.status };
}

/** The scorer's quick result: the home side wins, through real scoring events. */
async function homeWins(rig: Rig, f: Row): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
  let seq = n;
  if (seq === 0) await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

async function playRound(rig: Rig, r: number): Promise<void> {
  const boards = boardsOf(await rowsOf(rig.stageId), r).filter((f) => f.status !== "decided");
  expect(boards.length, `rig: round ${r} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(rig, f);
  const after = boardsOf(await rowsOf(rig.stageId), r);
  expect(after.map((f) => f.status), `rig: round ${r} is decided`).toEqual(after.map(() => "decided"));
}

/** An automatic arrival: a free registration confirmed through the real `confirmRegistration`. */
async function registerAndConfirm(rig: Rig, name: string): Promise<string> {
  await putRegistrationSettings(rig.auth, rig.divisionId, {
    enabled: true,
    entrant_kind: rig.kind,
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  const seats = Math.min(2, entrantKindCap(rig.kind));
  const { registration } = await seedRegistration(
    rig.competitionId,
    rig.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name, players: Array.from({ length: seats }, (_, i) => ({ name: `${name} p${i + 1}` })) },
  );
  const confirmed = await confirmRegistration(rig.auth, registration.id);
  expect(confirmed.status, "premise: an automatic arrival is never refused (ruling 250)").toBe("confirmed");
  return confirmed.entrant_id!;
}

describe.runIf(HAS_DB)("X-SW-16 Generate refuses rounds > hard max; writes nothing", () => {
  // Rulebook SW-H1's example, kept by §3.1's correction ("SW-H1's example (4 × 5) is even and does hold"): a field of 4
  // has a hard maximum of 3, so 5 rounds cannot exist. Swept over every sport the registry offers a Swiss.
  it("X-SW-16 Generate refuses rounds > hard max; writes nothing (4 entrants × 5 rounds, every sport offering a Swiss)", async () => {
    const { auth } = await seedOrg("pro");
    const offered = builtinModules.filter((m) => templatesForSport(m.key).some((t) => t.key === "swiss"));
    expect(offered.length, "premise: the registry offers a Swiss").toBeGreaterThan(1);
    let checked = 0;
    for (const m of offered) {
      const variant = Object.keys(m.variants)[0]!;
      const rig = await swissRig({ sport: m.key, variant }, 4, 5, auth);
      const before = await ledgerState(rig.divisionId);
      await expect(generateStageFixtures(rig.auth, rig.stageId), m.key).rejects.toMatchObject({
        ...ABOVE_MAX,
        extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
      });
      expect(await rowsOf(rig.stageId), `${m.key}: no shell minted`).toEqual([]);
      expect(await ledgerState(rig.divisionId), `${m.key}: no ledger row`).toEqual(before);
      checked++;
    }
    expect(checked, "anti-vacuity: every Swiss-offering sport refused").toBe(offered.length);
  });

  for (const sport of SPORTS) {
    it(`one past the hard max refuses, the hard max itself does not: 6 × 6 refused, 6 × 5 minted (${sport.sport})`, async () => {
      // §3.2's table: a field of 6 has a hard maximum of 5.
      const over = await swissRig(sport, 6, 6);
      await expect(generateStageFixtures(over.auth, over.stageId)).rejects.toMatchObject({
        ...ABOVE_MAX,
        extra: { rounds: 6, field: 6, hardMax: 5, canFinish: false },
      });
      expect(await rowsOf(over.stageId)).toEqual([]);
      const at = await swissRig(sport, 6, 5);
      const out = await generateStageFixtures(at.auth, at.stageId);
      expect(out.created, "5 rounds × 3 boards").toBe(15);
    });

    it(`an odd field may play n rounds; n + 1 is refused: 5 × 5 minted, 5 × 6 refused (${sport.sport})`, async () => {
      // §3.1: "For an odd field, n rounds is feasible, with every entrant taking the bye once. The impossibility starts at
      // n+1."
      const at = await swissRig(sport, 5, 5);
      expect((await generateStageFixtures(at.auth, at.stageId)).created, "5 rounds × (2 boards + 1 bye)").toBe(15);
      const over = await swissRig(sport, 5, 6);
      await expect(generateStageFixtures(over.auth, over.stageId)).rejects.toMatchObject({
        ...ABOVE_MAX,
        extra: { rounds: 6, field: 5, hardMax: 5, canFinish: false },
      });
    });
  }
});

describe.runIf(HAS_DB)("X-SW-16 6 × 5 warns, does not refuse", () => {
  for (const sport of SPORTS) {
    it(`X-SW-16 6 × 5 warns, does not refuse — at the shell mint and at every Pair (${sport.sport})`, async () => {
      // §3.1's audit probe: "6 × 5 (builder default) … 5 exceeds the safe maximum of 3 and is within the hard maximum of
      // 5". §3.2's table for a field of 6: 3 recommended, safe max 3, hard max 5.
      const WARN = { verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 };
      const rig = await swissRig(sport, 6, 5);
      const minted = await generateStageFixtures(rig.auth, rig.stageId);
      expect(minted.created).toBe(15);
      expect(minted.swiss_rounds, "the mint warns").toEqual(WARN);
      await startDivision(rig.auth, rig.divisionId);
      const pair1 = await generateStageFixtures(rig.auth, rig.stageId);
      expect(boardsOf(await rowsOf(rig.stageId), 1).every((f) => f.home_entrant_id && f.away_entrant_id), "round 1 paired").toBe(true);
      expect(pair1.swiss_rounds, "the Pair of round 1 warns").toEqual(WARN);
      await playRound(rig, 1);
      const pair2 = await generateStageFixtures(rig.auth, rig.stageId);
      expect(boardsOf(await rowsOf(rig.stageId), 2).every((f) => f.home_entrant_id && f.away_entrant_id), "round 2 paired").toBe(true);
      expect(pair2.swiss_rounds, "the Pair of round 2 warns again").toEqual(WARN);
    });

    it(`the negative pair: 6 × 3 is within the safe max, so no swiss_rounds rides on the answer (${sport.sport})`, async () => {
      // §3.1: "6×3 and 8×3 are within the safe maximum".
      const rig = await swissRig(sport, 6, 3);
      const minted = await generateStageFixtures(rig.auth, rig.stageId);
      expect(minted.created).toBe(9);
      expect(minted).not.toHaveProperty("swiss_rounds");
      await startDivision(rig.auth, rig.divisionId);
      expect(await generateStageFixtures(rig.auth, rig.stageId)).not.toHaveProperty("swiss_rounds");
    });
  }

  it("a Pair with nothing left to pair judges nothing (every round seated: no warning, no refusal)", async () => {
    // A field of 4 × 1 round: one Pair seats everything; the next Generate is "nothing new" and carries no judgement.
    const rig = await swissRig(SPORTS[0], 4, 1);
    await startDivision(rig.auth, rig.divisionId);
    await generateStageFixtures(rig.auth, rig.stageId);
    const again = await generateStageFixtures(rig.auth, rig.stageId);
    expect(again.created).toBe(0);
    expect(again).not.toHaveProperty("swiss_rounds");
  });
});

describe.runIf(HAS_DB)("X-SW-16 Pair next refuses after withdrawals shrink the field below rounds", () => {
  for (const sport of SPORTS) {
    it(`X-SW-16 Pair next refuses after withdrawals shrink the field below rounds — only a round the field cannot reach; recovery details { canFinish: true } (${sport.sport})`, async () => {
      // 6 × 5 is allowed (hard max 5). Round 1 is played, then two withdraw: the field is 4, whose hard max is 3 (§3.2's
      // table: n = 4 → recommended 2, safe 2, hard 3), so 5 rounds can no longer all be played. Controller ruling on
      // review m2 ("never block a pairable round"): rounds 2 and 3 are still within the shrunk field's hard max, so they
      // are paired, each with the shrunk warning; round 4 is beyond it, so its Pair is refused — and by then rounds are
      // complete, so the Swiss can be finished after round 3 (Task 13): the controller's status rule makes that a 409.
      const rig = await swissRig(sport, 6, 5);
      await startDivision(rig.auth, rig.divisionId);
      await generateStageFixtures(rig.auth, rig.stageId);
      await playRound(rig, 1);
      await withdrawEntrantCascade(rig.auth, rig.entrants[4]!);
      await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
      const four = [rig.entrants[0], rig.entrants[1], rig.entrants[2], rig.entrants[3]].sort();
      const SHRUNK = { verdict: "shrunk", rounds: 5, field: 4, recommended: 2, safeMax: 2, hardMax: 3, canFinish: true };

      // Within the shrunk field's hard max: paired, with the warning.
      for (const r of [2, 3]) {
        const paired = await generateStageFixtures(rig.auth, rig.stageId);
        expect(paired.swiss_rounds, `round ${r} is within the hard max of 4 (3): paired, with the shrunk warning`).toEqual(SHRUNK);
        const seated = boardsOf(await rowsOf(rig.stageId), r).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]);
        expect(seated.filter(Boolean).sort(), `round ${r} seats the four left`).toEqual(four);
        await playRound(rig, r);
      }

      // Beyond it: round 4 is refused, and nothing is written.
      const rowsBefore = await rowsOf(rig.stageId);
      const ledgerBefore = await ledgerState(rig.divisionId);
      const refusal = { ...ABOVE_MAX_RESOLVABLE, extra: { rounds: 5, field: 4, hardMax: 3, canFinish: true } };
      await expect(generateStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject(refusal);
      expect(await rowsOf(rig.stageId), "nothing written: every row as it was").toEqual(rowsBefore);
      expect(await ledgerState(rig.divisionId), "nothing written: no ledger row").toEqual(ledgerBefore);
      // The SEQUENCE: pressing it again changes nothing — same refusal, still nothing written.
      await expect(generateStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject(refusal);
      expect(await rowsOf(rig.stageId)).toEqual(rowsBefore);
      expect(await ledgerState(rig.divisionId)).toEqual(ledgerBefore);
    });
  }

  it("before any round is complete there is nothing to finish: a pre-Start shrink refuses Pair round 1 with canFinish false (422)", async () => {
    // Shells minted for 6 (5 rounds allowed), two withdraw before anything is paired: round 1's field is 4.
    const rig = await swissRig(SPORTS[0], 6, 5);
    await generateStageFixtures(rig.auth, rig.stageId);
    await withdrawEntrantCascade(rig.auth, rig.entrants[4]!);
    await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
    const before = await rowsOf(rig.stageId);
    await expect(generateStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({
      ...ABOVE_MAX,
      extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
    });
    expect(await rowsOf(rig.stageId)).toEqual(before);
  });
});

describe.runIf(HAS_DB)("X-SW-16 a Rebuild refused by the cap leaves the stage exactly as it was", () => {
  // Review m4: Rebuild deletes the stage's fixtures and mints again in ONE transaction (`rebuildStageFixtures`); the mint
  // judges the rounds against today's field. Refused there, the delete must roll back with it — never a stage emptied
  // of its shells by a press that was refused.
  for (const sport of SPORTS) {
    it(`shells minted for 6 × 5, two withdrawn: Rebuild is refused 422 and every row, and the ledger, is as it was (${sport.sport})`, async () => {
      const rig = await swissRig(sport, 6, 5);
      await generateStageFixtures(rig.auth, rig.stageId);
      await withdrawEntrantCascade(rig.auth, rig.entrants[4]!);
      await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
      const rowsBefore = await rowsOf(rig.stageId);
      expect(rowsBefore.length, "premise: the stage holds its minted shells").toBeGreaterThan(0);
      const ledgerBefore = await ledgerState(rig.divisionId);
      const refusal = { ...ABOVE_MAX, extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false } };
      await expect(rebuildStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject(refusal);
      expect(await rowsOf(rig.stageId), "the delete rolled back: same rows, same ids").toEqual(rowsBefore);
      expect(await ledgerState(rig.divisionId), "no ledger row").toEqual(ledgerBefore);
    });
  }
});

describe.runIf(HAS_DB)("X-SW-16 Start refuses a Swiss above its hard max", () => {
  for (const sport of SPORTS) {
    it(`X-SW-16 Start refuses a Swiss above its hard max — no fixtures yet: Start's own Generate refuses 4 × 5 (${sport.sport})`, async () => {
      const rig = await swissRig(sport, 4, 5);
      const before = await ledgerState(rig.divisionId);
      await expect(startDivision(rig.auth, rig.divisionId)).rejects.toMatchObject({
        ...ABOVE_MAX,
        extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
      });
      expect(await rowsOf(rig.stageId)).toEqual([]);
      expect(await ledgerState(rig.divisionId), "the division did not start; no ledger row").toEqual(before);
    });

    it(`X-SW-16 Start refuses a Swiss above its hard max — shells minted for 6, two withdrawn before Start (${sport.sport})`, async () => {
      // The field shrank after the shells were minted (§3.2: "again at Start … the field can shrink after creation"). The
      // shells exist, so Start generates nothing — its own check is the one that refuses.
      const rig = await swissRig(sport, 6, 5);
      await generateStageFixtures(rig.auth, rig.stageId);
      await withdrawEntrantCascade(rig.auth, rig.entrants[4]!);
      await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
      const rowsBefore = await rowsOf(rig.stageId);
      const before = await ledgerState(rig.divisionId);
      expect(before.status, "premise: not started").not.toBe("active");
      await expect(startDivision(rig.auth, rig.divisionId)).rejects.toMatchObject({
        ...ABOVE_MAX,
        extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
      });
      expect(await rowsOf(rig.stageId), "no rolling time, no seat").toEqual(rowsBefore);
      expect(await ledgerState(rig.divisionId), "not started; no publish, no division_started").toEqual(before);
    });

    it(`the positive pair: 6 × 5 starts (within the hard max) (${sport.sport})`, async () => {
      const rig = await swissRig(sport, 6, 5);
      const out = await startDivision(rig.auth, rig.divisionId);
      expect(out).toMatchObject({ started: true, generated: 15 });
    });
  }
});

describe.runIf(HAS_DB)("X-SW-16 n is the field paired now", () => {
  for (const sport of SPORTS) {
    it(`a latecomer queued for round 2 is not in round 1's n; round 2's n counts them (${sport.sport})`, async () => {
      // 4 × 3: a field of 4 has hard max 3 (warn: 3 > safe max 2); a field of 5 would have hard max 5. The judgement's
      // hard max therefore says which field a Pair counted (§3.2's table: n = 4 → 2/2/3; n = 5 → 2/2/5).
      const rig = await swissRig(sport, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      const pair1 = await generateStageFixtures(rig.auth, rig.stageId);
      expect(pair1.swiss_rounds).toEqual({ verdict: "warn", recommended: 2, safeMax: 2, hardMax: 3 });
      // An automatic arrival while round 1 is paired: always case (c) — first round 2 (ruling 250).
      const arrival = await registerAndConfirm(rig, "Arrival");
      const [stamp] = await sql<{ swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
        select swiss_first_round, swiss_first_round_stage_id from entrants where id = ${arrival}`;
      expect(stamp, "premise: the arrival is queued for round 2 of this stage").toEqual({
        swiss_first_round: 2,
        swiss_first_round_stage_id: rig.stageId,
      });
      // Round 1 is unpaired and paired again: its field is still the four — the arrival is not in round 1's n.
      await unpairSwissRound(rig.auth, rig.stageId);
      const again = await generateStageFixtures(rig.auth, rig.stageId);
      expect(again.swiss_rounds, "round 1's n is 4 (hard max 3), not 5 (hard max 5)").toEqual({
        verdict: "warn",
        recommended: 2,
        safeMax: 2,
        hardMax: 3,
      });
      expect(
        (await rowsOf(rig.stageId)).filter((f) => f.round_no === 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]),
        "round 1 does not seat the arrival",
      ).not.toContain(arrival);
      await playRound(rig, 1);
      const pair2 = await generateStageFixtures(rig.auth, rig.stageId);
      expect(pair2.swiss_rounds, "round 2's n is 5 (hard max 5)").toEqual({ verdict: "warn", recommended: 2, safeMax: 2, hardMax: 5 });
    });
  }
});
