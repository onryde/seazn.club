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
//
// W3 app-B Task 4 (X-SW-3 on the wire, X-SW-26 the recovery): the refusal now carries the recovery's facts —
// `{ round, reason, field, finishAfter, canFinish }`, and exactly those five (never the engine's refusal object, an
// entrant id or a history). Asserted through the REAL route handler (`POST /stages/{id}/generate`), against the envelope
// another app-A refusal gets, then the sequences around it: a second press, a field change before the press, a void of a
// round-3 result, a latecomer who joined for round 4 (case (c), through the registration confirm), and Finish after round
// 3 from the refused state, which seeds the knockout from the round-3 table.
import { afterAll, describe, expect, it, vi } from "vitest";

// The API door's session (the pattern of engine-db/__tests__/tables-producer-consumer.test.ts): the caller is the scene's
// owner; the route, its auth door and the usecases behind it are real.
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => {
      if (authState.userId === "") throw new actual.AuthError("Not authenticated");
      return { id: authState.userId };
    },
    getCurrentUser: async () => (authState.userId === "" ? null : { id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { POST as finishRoute } from "@/app/api/v1/stages/[id]/swiss/finish/route";
import { POST as generateRoute } from "@/app/api/v1/stages/[id]/generate/route";
import { sql, withTenant } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import { CreateStage } from "@/server/api-v1/schemas";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { confirmRegistration } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { addSwissRound } from "../swiss-rounds-admin";
import { seedRegistration } from "./_registration-fixtures";
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
  competitionId: string;
  divisionId: string;
  stageId: string;
  ids: string[];
  /** The knockout the Swiss seeds (`swissKnockoutStage`), else null. */
  koStageId: string | null;
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
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, ids: entrants.map((e) => e.id), koStageId: null };
}

/** The REAL swiss_knockout template drafts (`buildTemplateStages`, through `CreateStage` as the API takes them): the Swiss of
 *  `rounds` rounds and a knockout of the top `q`, its bracket seeded from the Swiss table. Started, shells minted. */
async function swissKnockoutStage(sport: Sport, count: number, rounds: number, q: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss KO " + randomUUID().slice(0, 6),
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
  const drafts = buildTemplateStages("swiss_knockout", { swissRounds: rounds, poolCount: 2, legs: 1, qualified: q });
  expect(drafts.map((d) => d.kind), "rig: the template is a swiss and a knockout").toEqual(["swiss", "knockout"]);
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const input = CreateStage.parse({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config: d.kind === "swiss" ? { ...d.config, rounds, ...sport.config } : d.config,
      progression: d.progression,
    });
    const [stage] = await createStages(auth, division.id, input);
    ids.push(stage!.id);
  }
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, ids[1]!); // the knockout's day-one TBD bracket
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: ids[0]!, ids: entrants.map((e) => e.id), koStageId: ids[1]! };
}

/** Every fixture row of the stage, in a stable order, as plain JSON: "wrote nothing" is an equality of two of these. */
const stageRows = (stageId: string) =>
  sql`select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome, scheduled_at, court_id
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`.then((rows) => JSON.parse(JSON.stringify(rows)) as unknown[]);

const generatedEvents = async (divisionId: string) => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId} and type = 'fixtures_generated'`;
  return n;
};

/** Write `history` (default: rounds 1-3 of the S6 shape) onto the minted shells by SQL, each board a home win. */
async function playHistory(r: Rig, history: typeof HISTORY = HISTORY): Promise<void> {
  let written = 0;
  for (const [i, round] of history.entries()) {
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
  expect(written, "rig: every board of the history written").toBe(history.flat().length);
  expect(written, "rig: a history is not empty").toBeGreaterThan(0);
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
      // W3 app-B T4: and the recovery's facts — rounds 1-3 are complete, so Finish after round 3 is the way out.
      expect(err.extra, "the round it could not pair, why, how many were in the field, and what Finish can end after").toEqual({
        round: 4,
        reason: "rematch",
        field: 6,
        finishAfter: 3,
        canFinish: true,
      });

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
      expect(over!.extra, "the same five fields; canFinish false — the Swiss is over, Finish is not the way out").toEqual({
        round: 4,
        reason: "rematch",
        field: 6,
        finishAfter: 3,
        canFinish: false,
      });
      expect(await stageRows(r.stageId), "nothing in the Swiss moved").toEqual(rowsBefore);

      // The pair: the later fixture not started is no start (T9's definition), the Swiss is not over, Finish after round 3 is
      // the way out, and the SAME refusal is the resolvable 409.
      await sql`update fixtures set status = 'scheduled' where id = ${laid!.id}`;
      const open = await asked();
      expect(open!.code).toBe("SWISS_NO_LEGAL_PAIRING");
      expect(open!.status, "409: Finish is now the way out").toBe(SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.resolvableStatus);
      expect((open!.extra as { canFinish?: unknown }).canFinish, "and the body says so").toBe(true);
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

// ─── W3 app-B Task 4: the recovery's facts on the wire, and the sequences around the refusal ─────────────────────────

type Envelope = { status: number; text: string; json: { ok: boolean; error?: Record<string, unknown>; data?: unknown; requestId?: string } };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** One request through a real route handler as the scene's owner; the raw text is kept so "nothing internal" can be a
 *  substring check over the whole body, not only over the keys. */
async function callRoute(r: Rig, handler: Handler, path: string): Promise<Envelope> {
  // The route authenticates as the seeded owner; a scene without one cannot make the request at all (a guard, not a cast).
  if (r.auth.userId === null) throw new Error("callRoute: the seeded org has no owner user");
  authState.userId = r.auth.userId;
  const res = await handler(new Request(`https://test.local/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {
    params: Promise.resolve({ id: r.stageId }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Envelope["json"] };
}
const pairRoute = (r: Rig) => callRoute(r, generateRoute, `/stages/${r.stageId}/generate`);

/** The five fields the refusal carries (never the engine's `SwissRefusal`, an entrant id, a history or a stack). */
const EXTRA_KEYS = ["canFinish", "field", "finishAfter", "reason", "round"];

/** The Swiss made OVER by a later stage's fixture that has started (ruling 250): Finish is then refused SWISS_OVER, so the
 *  S6 refusal is the 422 arm (`canFinish: false`). Returns the later fixture, to be un-started for the pair. */
async function makeSwissOver(r: Rig): Promise<string> {
  const [ko] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config) values (${r.divisionId}, 2, 'knockout', 'KO', '{}') returning id`;
  const [laid] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${ko!.id}, ${r.divisionId}, 1, 1, ${r.ids[0]!}, ${r.ids[1]!}, 'in_play') returning id`;
  return laid!.id;
}

describe.runIf(HAS_DB)("X-SW-3 the refusal on the wire carries the recovery's facts and nothing else", () => {
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: X-SW-3 the refusal carries round, reason, field and finishAfter on the wire`, async () => {
      const r = await swissStage(sport, 6, 5);
      await playHistory(r);
      const out = await pairRoute(r);
      expect(out.status, "409: Finish is the way out").toBe(409);
      expect(out.json.ok).toBe(false);
      expect(out.json.error, "the five fields, flat in the error body beside code and message").toMatchObject({
        code: "SWISS_NO_LEGAL_PAIRING",
        round: 4,
        reason: "rematch",
        field: 6,
        finishAfter: 3,
        canFinish: true,
      });
      // The pair: `finishAfter` is the round before the refused one, not a constant: a refusal of round 5 would say 4.
      expect((out.json.error as { finishAfter: number }).finishAfter, "finishAfter = round - 1").toBe((out.json.error as { round: number }).round - 1);
      ran++;
    }, 300_000);

    it(`${sport.key}: X-SW-3 the refusal body carries nothing internal`, async () => {
      // The envelope's own keys, read from ANOTHER refusal through its real route in the same test: Finish on a Swiss
      // with nothing played (SWISS_FINISH_NOTHING_PLAYED).
      const unplayed = await swissStage(sport, 6, 5);
      const other = await callRoute(unplayed, finishRoute, `/stages/${unplayed.stageId}/swiss/finish`);
      expect(other.json.error?.code, "premise: the other refusal is the Finish one").toBe("SWISS_FINISH_NOTHING_PLAYED");
      const envelopeKeys = Object.keys(other.json).sort();
      expect(envelopeKeys, "premise: the envelope is ok, error, requestId").toEqual(["error", "ok", "requestId"]);

      const r = await swissStage(sport, 6, 5);
      await playHistory(r);
      const arms: { label: string; envelope: Envelope; canFinish: boolean }[] = [];
      arms.push({ label: "409 (Finish is the way out)", envelope: await pairRoute(r), canFinish: true });
      // The 422 arm is the other state of the same body: the Swiss is over, so canFinish is false — same keys.
      const laid = await makeSwissOver(r);
      arms.push({ label: "422 (the Swiss is over)", envelope: await pairRoute(r), canFinish: false });
      await sql`update fixtures set status = 'scheduled' where id = ${laid}`;
      for (const { label, envelope, canFinish } of arms) {
        expect(Object.keys(envelope.json).sort(), `${label}: the envelope keys are another refusal's`).toEqual(envelopeKeys);
        expect(Object.keys(envelope.json.error!).sort(), `${label}: code, message and exactly the five fields`).toEqual(["code", "message", ...EXTRA_KEYS].sort());
        expect((envelope.json.error as { canFinish: boolean }).canFinish, label).toBe(canFinish);
        expect(envelope.json.error, label).not.toHaveProperty("ok");
        for (const id of r.ids) expect(envelope.text, `${label}: no entrant id in the body`).not.toContain(id);
        expect(envelope.text, `${label}: no stack, no history`).not.toMatch(/stack|history|played|pairings|at \w+ \(/i);
      }
      expect(arms.map((a) => a.envelope.status), "the two arms are the table's two statuses").toEqual([409, 422]);
      ran++;
    }, 300_000);
  }

  it("anti-vacuity: both sports drove the wire and the nothing-internal arms", () => {
    expect(ran, "two cases per sport").toBe(SPORTS.length * 2);
    expect(ran).toBeGreaterThan(0);
  });
});

/** Three rounds of the 4-player round robin (every pair met once): R1 {p0-p1, p2-p3}, R2 {p0-p2, p1-p3}, R3 {p0-p3, p1-p2}. */
const RR4: typeof HISTORY = [
  [[0, 1], [2, 3]],
  [[0, 2], [1, 3]],
  [[0, 3], [1, 2]],
];

describe.runIf(HAS_DB)("X-SW-3 a refusal leaves the stage exactly as it was", () => {
  // The board shells of a round are sized for the field when the stage is Paired; a field that moved since leaves them the
  // wrong size, and the Pair reshapes them before it seats anyone (`reconcileSwissRoundShells`). The refusal is raised
  // BEFORE that, so a press that refuses must leave every round-4 row byte-identical. A real withdrawal cannot pose this
  // here (proved below: S6 minus any one player pairs), so the stage is left in the state a withdrawal leaves: round 4
  // holds two board shells where the field of six needs three.
  const drift = (r: Rig) => sql`delete from fixtures where stage_id = ${r.stageId} and ext_key = 'sw-r4-b3'`;
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: X-SW-3 a refusal after a reshape rolls the reshape back, and a second press refuses again and writes nothing`, async () => {
      const r = await swissStage(sport, 6, 5);
      await playHistory(r);
      // Premise 1: removing any one player leaves a field that PAIRS, so no withdrawal can pose "reshape, then refuse".
      for (const gone of [0, 1, 2, 3, 4, 5]) {
        const rest = [0, 1, 2, 3, 4, 5].filter((i) => i !== gone);
        const pairs = (ids: number[]): boolean => ids.length === 0 || ids.some((bye) => hasPerfectMatching(ids.filter((i) => i !== bye), metKeys(HISTORY)));
        expect(pairs(rest), `rig: the field of five without p${gone} has a legal round 4 (one bye, two boards)`).toBe(true);
      }
      await drift(r);
      const before = await stageRows(r.stageId);
      const round4Before = (before as { round_no: number }[]).filter((f) => f.round_no === 4);
      expect(round4Before.length, "premise: round 4 holds two shells where a field of six needs three — the Pair would mint one").toBe(2);
      const events = await generatedEvents(r.divisionId);

      for (const press of ["first", "second"]) {
        const out = await pairRoute(r);
        expect(out.json.error?.code, `${press} press: refused by name`).toBe("SWISS_NO_LEGAL_PAIRING");
        expect(await stageRows(r.stageId), `${press} press: every row of the stage, round 4 included, is byte-identical`).toEqual(before);
        expect(await generatedEvents(r.divisionId), `${press} press: no fixtures_generated row`).toBe(events);
      }
      ran++;
    }, 300_000);

    it(`${sport.key}: X-SW-3 the refusal is raised before the reshape — a round the reshape would refuse still answers the refusal by name`, async () => {
      // The reshape has guards of its own (`reconcileSwissRoundShells`: a round that carries recorded data is refused
      // STAGE_NOT_READY). Put such a record on a round-4 shell: if the Pair reshaped before it asked the engine, THAT
      // refusal would answer. It must not.
      const r = await swissStage(sport, 6, 5);
      await playHistory(r);
      await sql`delete from fixtures where stage_id = ${r.stageId} and ext_key = 'sw-r4-b3'`;
      const marked = await sql`update fixtures set config_snapshot = '{}'::jsonb, config_snapshot_at = now() where stage_id = ${r.stageId} and ext_key = 'sw-r4-b1' returning id`;
      expect(marked.length, "rig: a round-4 shell carries recorded data").toBe(1);
      const before = await stageRows(r.stageId);
      const out = await pairRoute(r);
      expect(out.json.error?.code, "the refusal by name, not the reshape's").toBe("SWISS_NO_LEGAL_PAIRING");
      expect(await stageRows(r.stageId)).toEqual(before);

      // The differential: the SAME drift and record on a round that DOES pair (round 3 of the same history) is the
      // reshape's refusal — so the guard above is live, and only the order of the two keeps it from answering.
      const s = await swissStage(sport, 6, 5);
      await playHistory(s, HISTORY.slice(0, 2));
      await sql`delete from fixtures where stage_id = ${s.stageId} and ext_key = 'sw-r3-b3'`;
      await sql`update fixtures set config_snapshot = '{}'::jsonb, config_snapshot_at = now() where stage_id = ${s.stageId} and ext_key = 'sw-r3-b1'`;
      const reshape = await pairRoute(s);
      expect(reshape.json.error?.code, "premise: a pairable round with the same record is refused by the reshape").toBe("STAGE_NOT_READY");
      expect(reshape.json.error?.message, "premise: and it is the recorded-data guard").toMatch(/recorded match data/);
      ran++;
    }, 300_000);
  }

  it("anti-vacuity: both sports ran both arms", () => {
    expect(ran, "two cases per sport").toBe(SPORTS.length * 2);
    expect(ran).toBeGreaterThan(0);
  });
});

/** The scorer's quick result by real events: the home side wins (badminton two games; chess a resignation). */
async function homeWinsByEvents(r: Rig, sport: Sport, fixtureId: string, homeId: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  let seq = n;
  if (seq === 0) await scoreEvent(r.auth, fixtureId, { expected_seq: seq++, type: "core.start", payload: {} });
  if (sport.key === "boardgame") {
    await scoreEvent(r.auth, fixtureId, { expected_seq: seq, type: "boardgame.result", payload: { winner: homeId, method: "resign" } });
  } else {
    await scoreEvent(r.auth, fixtureId, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(r.auth, fixtureId, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

describe.runIf(HAS_DB)("X-SW-3 the sequence: refusal, then a void of a round-3 result, then Pair", () => {
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: X-SW-3 after a void on round 3 the round re-opens and Pair next refuses STAGE_NOT_READY (undecided), not SWISS_NO_LEGAL_PAIRING`, async () => {
      const r = await swissStage(sport, 6, 5);
      // Rounds 1-2 and two boards of round 3 by SQL; the third board of round 3 (p2-p5) is decided by REAL events, so a
      // scorer's take-back (`core.void`) has an event to void.
      await playHistory(r, HISTORY.slice(0, 2));
      const board = (i: number) => `sw-r3-b${i + 1}`;
      for (const [i, [home, away]] of HISTORY[2]!.entries()) {
        if (i < 2) {
          const outcome = { kind: "win", winner: r.ids[home]!, loser: r.ids[away]! };
          await sql`update fixtures set home_entrant_id = ${r.ids[home]!}, away_entrant_id = ${r.ids[away]!}, status = 'decided', outcome = ${sql.json(outcome as never)}
                    where stage_id = ${r.stageId} and ext_key = ${board(i)}`;
        } else {
          await sql`update fixtures set home_entrant_id = ${r.ids[home]!}, away_entrant_id = ${r.ids[away]!} where stage_id = ${r.stageId} and ext_key = ${board(i)}`;
        }
      }
      const [live] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and ext_key = ${board(2)}`;
      await homeWinsByEvents(r, sport, live!.id, r.ids[HISTORY[2]![2]![0]]!);
      expect(hasPerfectMatching([0, 1, 2, 3, 4, 5], metKeys(HISTORY)), "rig: round 4 truly has no legal pairing").toBe(false);

      // 1. Refused.
      const first = await pairRoute(r);
      expect(first.json.error?.code, "round 3 decided: Pair next is refused by name").toBe("SWISS_NO_LEGAL_PAIRING");

      // 2. A scorer takes the deciding event of that round-3 board back: the round is open again.
      const [last] = await sql<{ id: string; seq: number }[]>`select id, seq from score_events where fixture_id = ${live!.id} order by seq desc limit 1`;
      await scoreEvent(r.auth, live!.id, { expected_seq: last!.seq, type: "core.void", payload: { event_id: last!.id } });
      const [reopened] = await sql<{ status: string }[]>`select status from fixtures where id = ${live!.id}`;
      expect(["decided", "finalized", "forfeited"], "premise: the take-back reopened the board").not.toContain(reopened!.status);
      const rowsReopened = await stageRows(r.stageId);

      // 3. Pair next now says the round is not finished — the precondition, not the pairing refusal.
      const second = await generateStageFixtures(r.auth, r.stageId).then(
        () => null,
        (e: unknown) => e,
      );
      expect(EngineError.is(second, "STAGE_NOT_READY"), `refused STAGE_NOT_READY (got ${String(second)})`).toBe(true);
      expect((second as EngineError).message, "the undecided-round precondition").toMatch(/undecided/);
      expect(await stageRows(r.stageId), "and writes nothing").toEqual(rowsReopened);

      // 4. The pair: the board decided again, and the same press is the refusal again.
      const [{ tip }] = await sql<{ tip: number }[]>`select max(seq)::int as tip from score_events where fixture_id = ${live!.id}`;
      if (sport.key === "boardgame") {
        await scoreEvent(r.auth, live!.id, { expected_seq: tip, type: "boardgame.result", payload: { winner: r.ids[HISTORY[2]![2]![0]]!, method: "resign" } });
      } else {
        await scoreEvent(r.auth, live!.id, { expected_seq: tip, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
      }
      const third = await pairRoute(r);
      expect(third.json.error?.code, "decided again: the refusal by name again").toBe("SWISS_NO_LEGAL_PAIRING");
      ran++;
    }, 300_000);
  }

  it("anti-vacuity: both sports ran the sequence", () => {
    expect(ran).toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("X-SW-3 a refusal on a round a case-(c) latecomer joined names the round and finishAfter", () => {
  // Four players play the round robin (three rounds, the most a field of four can hold). A fifth arrives AFTER the last
  // round through the registration confirm — an automatic arrival, case (c): recorded as joining round 4. Add a round
  // seats round 4 for a field of FIVE. Those five cannot pair: the four who played everyone are one rematch short even
  // with the newcomer (the newcomer takes one board, the bye one more, the last two have met).
  let ran = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: X-SW-3 the late-entry refusal still names round 4, the field of five and finishAfter 3`, async () => {
      const r = await swissStage(sport, 4, 3);
      await playHistory(r, RR4);
      expect(hasPerfectMatching([0, 1, 2, 3], metKeys(RR4)), "rig: the four have met everyone").toBe(false);

      const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Late" });
      const confirmed = await confirmRegistration(r.auth, registration.id);
      const lateId = confirmed.entrant_id!;
      expect(lateId, "rig: the confirm created the newcomer").toBeTruthy();
      const [stamp] = await sql<{ swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
        select swiss_first_round, swiss_first_round_stage_id from entrants where id = ${lateId}`;
      expect(stamp, "premise: case (c) — the newcomer joined round 4, the round after the last").toEqual({ swiss_first_round: 4, swiss_first_round_stage_id: r.stageId });
      expect(await addSwissRound(r.auth, r.stageId), "premise: round 4 is added, for the field of five (two boards and a bye)").toEqual({ rounds: 4, shells_added: 3 });

      const before = await stageRows(r.stageId);
      const out = await pairRoute(r);
      expect(out.status, "409: rounds 1-3 are complete, Finish is the way out").toBe(409);
      expect(out.json.error, "the late player's round: round 4, a field of five, Finish after round 3").toMatchObject({
        code: "SWISS_NO_LEGAL_PAIRING",
        round: 4,
        field: 5,
        finishAfter: 3,
        canFinish: true,
      });
      expect(["rematch", "no_bye_candidate"], "a reason the engine declares for a dead end").toContain((out.json.error as { reason: string }).reason);
      expect(await stageRows(r.stageId), "nothing written").toEqual(before);
      ran++;
    }, 300_000);
  }

  it("anti-vacuity: both sports ran the late-entry refusal", () => {
    expect(ran).toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("X-SW-26 the recovery the refusal offers: Finish after round 3 from the refused state", () => {
  let ran = 0;
  // One plain-string title (carry d): the rules checker reads only plain `it` titles, and a template literal hid this
  // rule's test from it. The sports run in the body, each labelled in its assertions.
  it("X-SW-26 the recovery: finish after round 3 completes the stage and seeds the knockout from round-3 standings", async () => {
    for (const sport of SPORTS) {
      const r = await swissKnockoutStage(sport, 6, 5, 3);
      await playHistory(r);
      const refused = await pairRoute(r);
      expect(refused.json.error, `${sport.key}: premise: refused, Finish after round 3 offered`).toMatchObject({ code: "SWISS_NO_LEGAL_PAIRING", finishAfter: 3, canFinish: true });

      // The expected seeding is the table as round 3 left it, read with the stage's own ranking BEFORE Finish is called.
      const table = (await withTenant(r.auth.orgId, (tx) => rankedStageStandings(tx, r.stageId))).slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      expect(table.length, `${sport.key}: premise: all six are on the table`).toBe(6);

      // The Finish the notice offers: its button posts exactly this, through the real route.
      const done = await callRoute(r, finishRoute, `/stages/${r.stageId}/swiss/finish`);
      expect(done.status, `${sport.key}: Finish goes through: ${done.text}`).toBe(200);
      const data = done.json.data as { finished_after: number; completed: boolean; shells_removed: number };
      expect(data.finished_after, `${sport.key}: it finished after the round the refusal named`).toBe((refused.json.error as { finishAfter: number }).finishAfter);
      expect(data.completed, `${sport.key}: the stage is complete`).toBe(true);
      expect(data.shells_removed, `${sport.key}: rounds 4 and 5 are shells only (3 each) and go`).toBe(6);
      const [stage] = await sql<{ status: string; config: { rounds: number } }[]>`select status, config from stages where id = ${r.stageId}`;
      expect({ status: stage!.status, rounds: stage!.config.rounds }).toEqual({ status: "complete", rounds: 3 });

      const [proposal] = await sql<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }[]>`
        select computed from stage_seed_proposals where stage_id = ${r.koStageId!} and status = 'draft'`;
      expect(proposal, `${sport.key}: a draft seeding for the knockout`).toBeTruthy();
      expect(proposal!.computed.qualifiers.map((q) => q.entrantId).sort(), `${sport.key}: the top three of the round-3 table`).toEqual(
        table.slice(0, 3).map((t) => t.entrantId).sort(),
      );
      ran++;
    }
  }, 600_000);

  it("anti-vacuity: both sports ran the recovery", () => {
    expect(ran).toBe(SPORTS.length);
    expect(ran).toBeGreaterThan(0);
  });
});
