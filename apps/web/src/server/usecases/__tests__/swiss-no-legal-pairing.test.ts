// W3 app-B Task 1 (X-SW-3; rulebook-W3 §3.1 "no legal pairing", P-A1/P-A6; engine 2.0.0 `pairRound`): a round that has no
// legal pairing is REFUSED, never "up to date". Engine 1.1.0 answered a history like this with an empty round, so Pair next
// returned `created: 0` and the organiser read "nothing new" for a round that could not be played. Engine 2.0.0 returns
// `{ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason, field }` and `swissGen` raises the table's
// SWISS_NO_LEGAL_PAIRING (`lib/swiss-refusals.ts`) BEFORE any write — no seat, no reshape, no `fixtures_generated` row.
//
// The history (rulebook §3.1; engine plan Task 4b's S6 shape): SIX players, five rounds declared, the first three rounds
// played as a round-robin quarter —
//   R1 {p0-p1, p2-p3, p4-p5}   R2 {p0-p5, p1-p2, p3-p4}   R3 {p0-p3, p1-p4, p2-p5}
// — each a home win. The nine pairs met leave two triangles unplayed ({p0,p2,p4} and {p1,p3,p5}); a triangle has an odd
// number of vertices, so round 4 has NO rematch-free perfect matching, whatever the scores or the colours. The premise is
// proved in this file by a brute-force matcher (`hasPerfectMatching`), not read from the code under test.
//
// Two sports, the same body: badminton and boardgame (chess colours on — the refusal's reason is "rematch" for both,
// because the engine's reason probe lifts the colour limits before it names "colour"). The rule id rides in a PLAIN-string
// `describe` (the rules checker reads literals only: a template title is invisible to it); the sport rides in the `it`.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Sport {
  key: "badminton" | "boardgame";
  variant: string;
  /** The stage config beside `rounds`. */
  config: Record<string, unknown>;
}

const SPORTS: Sport[] = [
  { key: "badminton", variant: "bwf", config: {} },
  { key: "boardgame", variant: "classical", config: { chess: true } },
];

/** Rounds 1-3 of the S6 shape, as pairs of player indexes (p0..p5 = seeds 1..6); the first is the home side. */
const HISTORY: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 1], [2, 3], [4, 5]],
  [[0, 5], [1, 2], [3, 4]],
  [[0, 3], [1, 4], [2, 5]],
];

/** Whether `ids` can be split into disjoint pairs none of which is in `met` (a set of "a|b" keys, a < b). Brute force, so
 *  the rig's premise ("round 4 cannot be paired") is a fact proved here, not a claim read from the engine. */
function hasPerfectMatching(ids: readonly number[], met: ReadonlySet<string>): boolean {
  if (ids.length === 0) return true;
  const [first, ...rest] = ids as [number, ...number[]];
  return rest.some((other) => {
    if (met.has(`${Math.min(first, other)}|${Math.max(first, other)}`)) return false;
    return hasPerfectMatching(
      rest.filter((r) => r !== other),
      met,
    );
  });
}
const metKeys = (rounds: readonly (readonly (readonly [number, number])[])[]) =>
  new Set(rounds.flat().map(([a, b]) => `${Math.min(a, b)}|${Math.max(a, b)}`));

interface Rig {
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  divisionId: string;
  stageId: string;
  ids: string[];
}

/** `count` individuals S1..S<count> (seeds 1..count) in a `rounds`-round Swiss, nothing paired. `start` (default) starts the
 *  division, which mints the shells; a Swiss of ONE cannot be started (Start itself refuses a roster under 2), so the empty
 *  case leaves it unstarted and presses Pair next directly. */
async function swissStage(sport: Sport, count: number, rounds: number, start = true): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss no pairing " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds, ...sport.config }, progression: null });
  if (start) await startDivision(auth, division.id);
  return { auth, divisionId: division.id, stageId: stage!.id, ids: entrants.map((e) => e.id) };
}

/** Every fixture row of the stage, in a stable order, as plain JSON: "wrote nothing" is an equality of two of these. */
const stageRows = (stageId: string) =>
  sql`select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome, scheduled_at, court_id
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`.then((rows) => JSON.parse(JSON.stringify(rows)) as unknown[]);

const generatedEvents = async (divisionId: string) => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId} and type = 'fixtures_generated'`;
  return n;
};

/** Write rounds 1-3 onto the minted shells by SQL, each board a home win. */
async function playHistory(r: Rig): Promise<void> {
  let written = 0;
  for (const [i, round] of HISTORY.entries()) {
    for (const [b, [home, away]] of round.entries()) {
      const outcome = { kind: "win", winner: r.ids[home]!, loser: r.ids[away]! };
      const done = await sql`
        update fixtures set home_entrant_id = ${r.ids[home]!}, away_entrant_id = ${r.ids[away]!}, status = 'decided',
          outcome = ${sql.json(outcome as never)}
        where stage_id = ${r.stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}
        returning id`;
      expect(done.length, `rig: shell sw-r${i + 1}-b${b + 1} exists and took the result`).toBe(1);
      written++;
    }
  }
  expect(written, "rig: three rounds of three boards written").toBe(9);
}

describe("X-SW-3 the premise: the S6 history leaves round 4 with no rematch-free perfect matching (no database)", () => {
  it("X-SW-3 rounds 1-3 of the S6 shape leave two triangles, so round 4 cannot be matched; two rounds fewer can", () => {
    const six = [0, 1, 2, 3, 4, 5];
    expect(metKeys(HISTORY).size, "nine distinct pairs met").toBe(9);
    expect(hasPerfectMatching(six, metKeys(HISTORY)), "after three rounds: no legal round 4").toBe(false);
    // The pair: the same field after two rounds still pairs, so the matcher is not simply answering no.
    expect(hasPerfectMatching(six, metKeys(HISTORY.slice(0, 2))), "after two rounds: round 3 pairs").toBe(true);
    expect(hasPerfectMatching(six, new Set()), "after none: round 1 pairs").toBe(true);
  });
});

describe.runIf(HAS_DB)("X-SW-3 Pair next on a history with no legal round answers SWISS_NO_LEGAL_PAIRING and seats nobody", () => {
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: refused by name with the round, the reason and the field; every round-4 seat stays empty; no event is written`, async () => {
      const r = await swissStage(sport, 6, 5);
      expect((await stageRows(r.stageId)).length, "rig: 5 rounds x 3 boards of shells minted at Start").toBe(15);
      await playHistory(r);
      expect(hasPerfectMatching([0, 1, 2, 3, 4, 5], metKeys(HISTORY)), "rig: round 4 truly has no legal pairing").toBe(false);

      const rowsBefore = await stageRows(r.stageId);
      const eventsBefore = await generatedEvents(r.divisionId);

      // differential: today (engine 1.1.0) created 0, "up to date"
      const refused = await generateStageFixtures(r.auth, r.stageId).then(
        (out) => ({ out }),
        (err: unknown) => ({ err }),
      );
      expect("err" in refused, `Pair next refuses (it answered ${JSON.stringify("out" in refused ? refused.out : null)})`).toBe(true);
      const err = (refused as { err: unknown }).err as { status?: number; code?: string; message?: string; extra?: unknown };
      expect(err.code, "the named refusal").toBe("SWISS_NO_LEGAL_PAIRING");
      // R5: a refusal Finish can resolve (rounds 1-3 are complete) is the table's resolvable status, read off the table.
      expect(err.status, "409, the table's resolvable status: Finish is the way out").toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.resolvableStatus);
      expect(err.message).toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.message);
      // "rematch": no rematch-free perfect matching exists (P-A1/P-A6), proved above, so not "colour" and not "search_limit".
      expect(err.extra, "the round it could not pair, why, and how many were in the field").toEqual({ round: 4, reason: "rematch", field: 6 });

      const round4 = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
        select home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} and round_no = 4`;
      expect(round4.length, "round 4's shells are still there").toBe(3);
      expect(round4.every((f) => f.home_entrant_id === null && f.away_entrant_id === null), "seats nobody").toBe(true);
      expect(await stageRows(r.stageId), "nothing in the stage moved").toEqual(rowsBefore);
      expect(await generatedEvents(r.divisionId), "no fixtures_generated row").toBe(eventsBefore);
      ran++;
    });
  }

  it("anti-vacuity: both sports ran the refusal", () => {
    expect(ran, "sports that reached the refusal").toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("X-SW-3 the unresolvable arm: a refusal Finish cannot answer is 422, and the same refusal is 409 the moment Finish can", () => {
  // `swissGen` raises the refusal with `{ resolvable: finishNow.canFinish }`: 409 when Finish after round k is the way out, 422
  // when it is not. The 409 arm is the test above; this is the other arm, reached with the S6 history once the Swiss is OVER
  // (ruling 250: a later stage of the division has a fixture under way, so Finish is refused SWISS_OVER and `canFinish` is
  // false). The pair is the same stage with that later fixture not started — Finish is then the way out and the status flips
  // to 409 — so the status is the Finish predicate's answer, not a constant. Both sports: the arm does not depend on the sport.
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: the S6 refusal is 422 while the Swiss is over, 409 once the later stage's fixture is not started`, async () => {
      const r = await swissStage(sport, 6, 5);
      await playHistory(r);
      expect(hasPerfectMatching([0, 1, 2, 3, 4, 5], metKeys(HISTORY)), "rig: round 4 truly has no legal pairing").toBe(false);
      const [ko] = await sql<{ id: string }[]>`
        insert into stages (division_id, seq, kind, name, config) values (${r.divisionId}, 2, 'knockout', 'KO', '{}') returning id`;
      const [laid] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
        values (${ko!.id}, ${r.divisionId}, 1, 1, ${r.ids[0]!}, ${r.ids[1]!}, 'in_play') returning id`;

      const rowsBefore = await stageRows(r.stageId);
      const asked = () =>
        generateStageFixtures(r.auth, r.stageId).then(
          () => null,
          (e: unknown) => e as { status?: number; code?: string; extra?: unknown },
        );
      const over = await asked();
      expect(over, "Pair next refuses").not.toBeNull();
      expect(over!.code, "the same named refusal").toBe("SWISS_NO_LEGAL_PAIRING");
      expect(over!.status, "422: the Swiss is over, so Finish is not the way out").toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.status);
      expect(over!.status).not.toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.resolvableStatus);
      expect(over!.extra, "the round, why, the field — the 409 arm's body").toEqual({ round: 4, reason: "rematch", field: 6 });
      expect(await stageRows(r.stageId), "nothing in the Swiss moved").toEqual(rowsBefore);

      // The pair: the later fixture not started is no start (T9's definition), the Swiss is not over, Finish after round 3 is
      // the way out, and the SAME refusal is the resolvable 409.
      await sql`update fixtures set status = 'scheduled' where id = ${laid!.id}`;
      const open = await asked();
      expect(open!.code).toBe("SWISS_NO_LEGAL_PAIRING");
      expect(open!.status, "409: Finish is now the way out").toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.resolvableStatus);
      ran++;
    });
  }

  it("anti-vacuity: both sports reached the unresolvable arm and its pair", () => {
    expect(ran, "sports that reached both arms").toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("X-SW-3 empty case first: a 1-entrant stage is refused by name before the engine is asked, and seats nobody", () => {
  // The brief wrote "refuses field_too_small". `pairRound` does answer that for a field of one, but Pair next never asks:
  // `generateStageFixturesTx` refuses a roster under 2 first (STAGE_NOT_READY, the refusal every format gives, and Start
  // itself raises it), and `swissGen` repeats it for a round's own field (`refuseSwissFieldUnderTwo`). So the engine's
  // `field_too_small` is unreachable from Pair next — a guard the app keeps in front of it. This pins the reachable half:
  // a field of one is a named refusal, not a crash, and nothing is written.
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: Pair next on one entrant refuses STAGE_NOT_READY naming the field, and writes nothing`, async () => {
      const r = await swissStage(sport, 1, 3, false);
      const rowsBefore = await stageRows(r.stageId);
      const eventsBefore = await generatedEvents(r.divisionId);
      const err = await generateStageFixtures(r.auth, r.stageId).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "Pair next refuses").not.toBeNull();
      expect(EngineError.is(err, "STAGE_NOT_READY"), `refused STAGE_NOT_READY (got ${String(err)})`).toBe(true);
      expect((err as EngineError).data, "naming the field of one").toMatchObject({ entrants: 1 });
      const seated = await sql`select 1 from fixtures where stage_id = ${r.stageId} and (home_entrant_id is not null or away_entrant_id is not null)`;
      expect(seated.length, "seats nobody").toBe(0);
      expect(await stageRows(r.stageId), "nothing in the stage moved").toEqual(rowsBefore);
      expect(await generatedEvents(r.divisionId), "no fixtures_generated row").toBe(eventsBefore);
      ran++;
    });
  }

  it("anti-vacuity: both sports ran the refusal", () => {
    expect(ran, "sports that reached the refusal").toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});
