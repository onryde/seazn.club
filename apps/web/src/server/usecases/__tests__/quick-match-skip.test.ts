// Quick match plan 4, Task 3 (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md D1-D5, Review Focus 1-5;
// spec docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6): "Not played" and "Put back", the
// usecase behind the home's two posts (`skipQuickMatchFixture`, `putBackQuickMatchFixture`).
//
// Every quick match is made by the real producer (`createQuickMatch`, or the unguarded tree for a legacy knockout), every
// point and result by the real write path (`scoreEvent`, `playToDecided`, the events route a pad posts to), every added match
// by the real "Add a match", and every count by the real home read (`readQuickMatchHome`). The direct UPDATEs below are the
// rows no guest path writes (a bye line in a league, a Not played match whose ledger holds a result, a writer that skips
// the fixture lock), each named where it is made.
//
// Expected values come from the spec and the rulebook (round robin n(n-1)/2; a win is one played and one won; a match with
// nothing decided leaves a table level), from the rows the write path wrote BEFORE the skip (its status, its ledger, its
// stored state, the stored table), and from the offer (lib/quick-match-offer.generated.json); never from the usecase's own
// answer.
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { isLevelTable, type StandingsRow } from "@seazn/engine/competition";
import { forEachSportAsync } from "@seazn/engine/testkit";

import { POST as postEvent } from "@/app/api/v1/fixtures/[id]/events/route";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { MUTATION_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import type { AppendEventRequest, CreateQuickMatch } from "@/server/api-v1/schemas";
import { foldFixture } from "@/server/engine-db/fold";
import { ensureGuestDeviceLink } from "../device-links";
import { addQuickMatchDecider } from "../quick-match-add";
import { systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { readQuickMatchHome, resolveQuickMatchToken, type QuickMatchHome, type QuickMatchRow } from "../quick-match-home";
import { putBackQuickMatchFixture, skipQuickMatchFixture } from "../quick-match-skip";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { getStandings } from "../stages";
import { createQuickMatchAnyFormat } from "./_quick-match-knockout";
import { firstRallyFor, nextPlayFor, playToDecided } from "./_quick-match-probe";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // every create and mint seals a secret (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The real fold behind a spy: one case makes a writer that skips the fixture lock move the row while Put back folds.
vi.mock("@/server/engine-db/fold", async (orig) => {
  const real = await orig<typeof import("@/server/engine-db/fold")>();
  return { ...real, foldFixture: vi.fn(real.foldFixture) };
});
const foldSpy = vi.mocked(foldFixture);

const HAS_DB = !!process.env.DATABASE_URL;
/** The offer's sports (P14): one league each in the sweep. Its budget is in its own cost driver (AGENTS.md class 20). */
const OFFERED_SPORT_KEYS = [...new Set(offerJson.offered.map((o) => o.sport_key))];
const SWEEP_TIMEOUT_MS = Math.max(30_000, OFFERED_SPORT_KEYS.length * 30_000);
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
let BADMINTON_V: string;

const league = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: `QM skip ${randomUUID().slice(0, 8)}`,
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",
  format: "league",
  sides: SIDES.slice(0, 3),
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});
const created: string[] = [];
async function make(input: CreateQuickMatch = league()): Promise<{ out: CreatedQuickMatch; row: QuickMatchRow }> {
  const out = await createQuickMatchAnyFormat(input, { visitorHash: hashVisitorKey(mintVisitorKey()) });
  created.push(out.competitionId);
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  return { out, row };
}
async function homeOf(row: QuickMatchRow): Promise<QuickMatchHome> {
  const home = await readQuickMatchHome(row);
  if (!home) throw new Error(`precondition: quick match ${row.id} has no home`);
  return home;
}

interface Fx {
  id: string;
  status: string;
  finished_at: Date | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { winner?: string } | null;
}
/** The competition's fixtures, in play order (round, then number). */
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  const rows = await sql<Fx[]>`
    select f.id, f.status, f.finished_at, f.home_entrant_id, f.away_entrant_id, f.outcome
    from fixtures f join divisions d on d.id = f.division_id
    where d.competition_id = ${competitionId}
    order by f.round_no, f.fixture_no`;
  if (rows.length === 0) throw new Error(`precondition: competition ${competitionId} has no fixture`);
  return rows;
}
async function fixture(id: string): Promise<Fx> {
  const [f] = await sql<Fx[]>`select id, status, finished_at, home_entrant_id, away_entrant_id, outcome from fixtures where id = ${id}`;
  if (!f) throw new Error(`precondition: fixture ${id} is gone`);
  return f;
}
/** Everything the ledger and the stored state hold for one match, as Postgres serialises it (jsonb's text is canonical). */
async function ledgerOf(fixtureId: string) {
  const events = await sql<{ id: string; seq: number; type: string; payload: string; voids_event_id: string | null; recorded_at: Date }[]>`
    select id, seq, type, payload::text as payload, voids_event_id, recorded_at from score_events where fixture_id = ${fixtureId} order by seq`;
  const states = await sql<{ last_seq: number; state: string; summary: string; updated_at: Date }[]>`
    select last_seq, state::text as state, summary::text as summary, updated_at from match_states where fixture_id = ${fixtureId}`;
  return { events, states };
}
const tableOf = async (home: QuickMatchHome) => getStandings(systemAuth(), home.stageId);
const rowsOf = (t: { rows: unknown[] }) => t.rows as StandingsRow[];

/** Score the engine's first rally (`[core.start, a play event]`) through the real write path. */
async function rally(fixtureId: string): Promise<void> {
  for (const e of await firstRallyFor(fixtureId)) await scoreEvent(systemAuth(), fixtureId, e);
}
/** The error a promise rejects with, or a failure when it resolves. */
async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, and the call succeeded");
}
async function expectRefused(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await refusalOf(p);
  expect(err, String(err)).toBeInstanceOf(HttpError);
  expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status, code });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("skip and put back: the sequences (plan 4 T3)", () => {
  it("1. skip → put back → score: Not played on the home, ready again after, then played to a result counted once for each side", async () => {
    const { out, row } = await make();
    const fixtures = await fixturesOf(out.competitionId);
    expect(fixtures, "premise: a round robin of 3 is 3·2/2 matches").toHaveLength(3);
    const m1 = fixtures[0]!;
    expect(m1.status, "premise: nothing played yet").toBe("scheduled");

    expect(await skipQuickMatchFixture(row, m1.id)).toEqual({ changed: true });
    const skipped = await fixture(m1.id);
    expect(skipped.status).toBe("cancelled");
    expect(skipped.finished_at, "fixtures_track_finished stamps a Not played match").not.toBeNull();
    let h = await homeOf(row);
    expect(h.fixtures.find((f) => f.id === m1.id)!.phase).toBe("notPlayed");
    expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished })
      .toEqual({ played: 0, notPlayed: 1, total: 3, finished: false });

    expect(await putBackQuickMatchFixture(row, m1.id)).toEqual({ changed: true, status: "scheduled" });
    const back = await fixture(m1.id);
    expect(back.status, "nothing was scored, so it is ready again").toBe("scheduled");
    expect(back.finished_at, "and no longer finished").toBeNull();
    h = await homeOf(row);
    expect(h.fixtures.find((f) => f.id === m1.id)!.phase).toBe("ready");
    expect(h.notPlayed).toBe(0);

    expect(await playToDecided(systemAuth(), m1.id)).toMatchObject({ kind: "decided" });
    expect((await fixture(m1.id)).status).toBe("decided");
    const table = rowsOf(await tableOf(await homeOf(row)));
    const playedBy = new Map(table.map((r) => [r.entrantId, r.played]));
    expect(playedBy.get(m1.home_entrant_id!), "the rulebook: one match played for each side").toBe(1);
    expect(playedBy.get(m1.away_entrant_id!)).toBe(1);
    expect([...playedBy.values()].reduce((a, b) => a + b, 0), "and nobody else played").toBe(2);
  });

  it("2. a partly scored match: its ledger, its stored state and the table are untouched by the skip and by put back, and it is live again at its score", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    await rally(m1!.id);
    const before = await fixture(m1!.id);
    expect(before.status, "premise: the write path left a started, undecided match in play").toBe("in_play");
    const ledger = await ledgerOf(m1!.id);
    expect(ledger.events, "premise: a start and one rally stand").toHaveLength(2);
    expect(ledger.states, "premise: the write path stored the fold").toHaveLength(1);
    const table = await tableOf(await homeOf(row));

    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: true });
    expect(await ledgerOf(m1!.id), "the skip writes no event and leaves the stored state alone").toEqual(ledger);
    expect(await tableOf(await homeOf(row)), "the table counts decided matches only: nothing to recompute").toEqual(table);

    const put = await putBackQuickMatchFixture(row, m1!.id);
    expect(put, "exactly as it was before the skip (D2): the status the write path left").toEqual({ changed: true, status: before.status });
    expect((await fixture(m1!.id)).status).toBe(before.status);
    expect(await ledgerOf(m1!.id), "byte-identical after put back too").toEqual(ledger);
    expect(await tableOf(await homeOf(row))).toEqual(table);
    expect((await homeOf(row)).fixtures.find((f) => f.id === m1!.id)!.phase).toBe("live");
  });

  it("3. a stale pad after someone else skipped (Review Focus 1): its next tap is refused ALREADY_DECIDED and writes nothing; Score mints nothing (NOT_PLAYED)", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    const link = await ensureGuestDeviceLink(row, m1!.id);
    await rally(m1!.id);
    const ledger = await ledgerOf(m1!.id);
    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: true });

    // The pad's own write: the next point, posted to the events route with the link's bearer as the pad posts it.
    const next: AppendEventRequest = await nextPlayFor(m1!.id, ledger.events.map((e) => ({ type: e.type, payload: JSON.parse(e.payload) })));
    const res = await postEvent(
      new Request(`http://test.local/api/v1/fixtures/${m1!.id}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${link.secret}`, "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
      { params: Promise.resolve({ id: m1!.id }) },
    );
    expect(res.status, await res.clone().text()).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ALREADY_DECIDED");
    // The write path itself, as any other caller reaches it.
    const err = await refusalOf(scoreEvent(systemAuth(), m1!.id, next));
    expect(err instanceof EngineError && err.code, String(err)).toBe("ALREADY_DECIDED");
    expect(await ledgerOf(m1!.id), "nothing landed: the same ledger and stored state").toEqual(ledger);

    // The home's Score tap from a page loaded before the skip: its own refusal, and no link minted or re-issued.
    const [links] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${m1!.id}`;
    await expectRefused(ensureGuestDeviceLink(row, m1!.id), 422, QUICK_MATCH_ERRORS.NOT_PLAYED);
    const [after] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${m1!.id}`;
    expect(after!.n).toBe(links!.n);
    expect((await fixture(m1!.id)).status).toBe("cancelled");
  });

  it("4 + 7. skipping the last open match finishes the league and the table's leader wins; put back is then refused (LEAGUE_FINISHED) until Add a match reopens it", async () => {
    // Chess, so the test picks the winner: a resignation decides a game for the other side (the rulebook), where a
    // rally sport's walk picks one the test cannot steer.
    const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
    expect(chess, "premise: chess is offered").toBeDefined();
    const { out, row } = await make(league({
      sport_key: "boardgame",
      variant_key: chess!.variants[0]!.variant_key,
      kind: chess!.kinds.at(-1)!,
      sides: ["Asha", "Ben", "Cleo"],
    }));
    const fixtures = await fixturesOf(out.competitionId);
    expect(fixtures, "premise: a round robin of 3 is 3·2/2 matches").toHaveLength(3);
    const [m1] = fixtures;
    const w = m1!.home_entrant_id!;
    const m2 = fixtures.slice(1).find((f) => f.home_entrant_id === w || f.away_entrant_id === w)!;
    expect(m2, "premise: in a round robin of 3 every side plays twice").toBeDefined();
    const m3 = fixtures.find((f) => f.id !== m1!.id && f.id !== m2.id)!;
    for (const f of [m1!, m2]) {
      const loser = f.home_entrant_id === w ? f.away_entrant_id! : f.home_entrant_id!;
      await scoreEvent(systemAuth(), f.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(systemAuth(), f.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: w, method: "resign" } });
      expect((await fixture(f.id)).outcome?.winner, `premise: ${loser} resigned to ${w}`).toBe(w);
    }

    let h = await homeOf(row);
    expect(h.finished, "one match still open").toBe(false);
    expect(await skipQuickMatchFixture(row, m3.id)).toEqual({ changed: true });
    h = await homeOf(row);
    expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished, next: h.next })
      .toEqual({ played: 2, notPlayed: 1, total: 3, finished: true, next: null });
    const table = rowsOf(await tableOf(h));
    expect(isLevelTable(table), "two results stand: not level").toBe(false);
    // The leader is the stored table's, never computed here: two wins of two, the most any side has.
    const top = [...table].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0]!;
    expect(top.entrantId).toBe(w);
    expect(top.won).toBe(2);

    // 7. A stale Put back once the league is finished.
    await expectRefused(putBackQuickMatchFixture(row, m3.id), 422, QUICK_MATCH_ERRORS.LEAGUE_FINISHED);
    expect((await fixture(m3.id)).status, "still Not played").toBe("cancelled");

    // Review Focus 5: Add a match un-finishes it (finished is derived), and Put back works again.
    await addQuickMatchDecider(row, { home: m1!.home_entrant_id, away: m1!.away_entrant_id });
    expect((await homeOf(row)).finished).toBe(false);
    expect(await putBackQuickMatchFixture(row, m3.id)).toEqual({ changed: true, status: "scheduled" });
  });

  it("5. skip every match: the league finishes with nothing played, and the stored table is level (no winner)", async () => {
    const { out, row } = await make(league({ sides: SIDES.slice(0, 2) }));
    const fixtures = await fixturesOf(out.competitionId);
    expect(fixtures, "premise: a league of 2 is one match").toHaveLength(1);
    expect(await skipQuickMatchFixture(row, fixtures[0]!.id)).toEqual({ changed: true });
    const h = await homeOf(row);
    expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished })
      .toEqual({ played: 0, notPlayed: 1, total: 1, finished: true });
    const table = rowsOf(await tableOf(h));
    expect(table, "both sides are on the table").toHaveLength(2);
    expect(isLevelTable(table), "nothing decided: level").toBe(true);
    // And put back is refused: skipping the last open match finished it (owner PO ruling 2026-11-13).
    await expectRefused(putBackQuickMatchFixture(row, fixtures[0]!.id), 422, QUICK_MATCH_ERRORS.LEAGUE_FINISHED);
  });

  it("6. a match with a result is not skippable (NOT_SKIPPABLE), and nothing moves", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    expect(await playToDecided(systemAuth(), m1!.id)).toMatchObject({ kind: "decided" });
    const before = await fixture(m1!.id);
    await expectRefused(skipQuickMatchFixture(row, m1!.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
    expect(await fixture(m1!.id)).toEqual(before);
    // Put back of a match that is not Not played changes nothing (D3), and says what it is.
    expect(await putBackQuickMatchFixture(row, m1!.id)).toEqual({ changed: false, status: "decided" });
    expect(await fixture(m1!.id)).toEqual(before);
  });

  it("8. second taps: a second skip and a second put back each change nothing (D3)", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: true });
    const once = await fixture(m1!.id);
    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: false });
    expect(await fixture(m1!.id), "one status write: finished_at kept the first skip's stamp").toEqual(once);
    expect(await putBackQuickMatchFixture(row, m1!.id)).toEqual({ changed: true, status: "scheduled" });
    const back = await fixture(m1!.id);
    expect(await putBackQuickMatchFixture(row, m1!.id)).toEqual({ changed: false, status: "scheduled" });
    expect(await fixture(m1!.id)).toEqual(back);
  });

  it("9. Edit result reopens (Review Focus 3): decided, its deciding event voided, in play again, and then it can be skipped", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    const r = await playToDecided(systemAuth(), m1!.id);
    if (r.kind !== "decided") throw new Error(`premise: decided, got ${r.kind}`);
    await expectRefused(skipQuickMatchFixture(row, m1!.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
    await scoreEvent(systemAuth(), m1!.id, { expected_seq: r.lastSeq, type: "core.void", payload: { event_id: r.lastEventId } });
    expect((await fixture(m1!.id)).status, "premise: the void reopened it").toBe("in_play");
    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: true });
    expect(await putBackQuickMatchFixture(row, m1!.id)).toEqual({ changed: true, status: "in_play" });
  });

  it("10. the per-match check: another quick match's fixture, an unknown id and a non-uuid are NOT_FOUND, and nothing moves", async () => {
    const a = await make();
    const b = await make();
    const [theirs] = await fixturesOf(b.out.competitionId);
    await expectRefused(skipQuickMatchFixture(a.row, theirs!.id), 404, QUICK_MATCH_ERRORS.NOT_FOUND);
    expect((await fixture(theirs!.id)).status).toBe("scheduled");
    expect(await skipQuickMatchFixture(b.row, theirs!.id), "the negative pair: its own link skips it").toEqual({ changed: true });
    await expectRefused(putBackQuickMatchFixture(a.row, theirs!.id), 404, QUICK_MATCH_ERRORS.NOT_FOUND);
    expect((await fixture(theirs!.id)).status).toBe("cancelled");
    for (const id of [randomUUID(), "not-a-uuid", ""]) {
      await expectRefused(skipQuickMatchFixture(a.row, id), 404, QUICK_MATCH_ERRORS.NOT_FOUND);
      await expectRefused(putBackQuickMatchFixture(a.row, id), 404, QUICK_MATCH_ERRORS.NOT_FOUND);
    }
  });

  it("12. a knockout match (legacy) is never skippable: NOT_SKIPPABLE, whichever way, and nothing moves", async () => {
    const { out, row } = await make(league({ format: "knockout", sides: SIDES.slice(0, 4) }));
    const seated = (await fixturesOf(out.competitionId)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(seated.length, "premise: a knockout of 4 seats its two semi-finals").toBeGreaterThan(0);
    for (const f of seated) {
      await expectRefused(skipQuickMatchFixture(row, f.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
      await expectRefused(putBackQuickMatchFixture(row, f.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
      expect((await fixture(f.id)).status).toBe("scheduled");
    }
  });
});

describe.skipIf(!HAS_DB)("skip and put back: the guards no guest path reaches", () => {
  it("the post limit answers first (qm-skip, MUTATION_LIMIT): a 429 with no code, before the id is even read", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return key === `rl:qm-skip:${row.id}` ? { count: MUTATION_LIMIT.max + 1, ttlMs: 30_000 } : null;
    });
    for (const call of [skipQuickMatchFixture, putBackQuickMatchFixture]) {
      for (const id of [m1!.id, "not-a-uuid"]) {
        const err = await refusalOf(call(row, id));
        expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status: 429, code: undefined });
      }
    }
    expect(keys.filter((k) => k === `rl:qm-skip:${row.id}`), "one bucket for both, per quick match").toHaveLength(4);
    expect((await fixture(m1!.id)).status).toBe("scheduled");
  });

  it("a bye line is no match: NOT_FOUND (a league never draws one; the row is made by hand)", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    // By hand: a pre-award bye line's shape (lib/bye-line.ts), an empty seat carrying the bye slot label.
    await sql`update fixtures set away_entrant_id = null, away_slot_label = ${sql.json({ key: "bracket.slot.bye", params: {} })}
              where id = ${m1!.id}`;
    await expectRefused(skipQuickMatchFixture(row, m1!.id), 404, QUICK_MATCH_ERRORS.NOT_FOUND);
    expect((await fixture(m1!.id)).status).toBe("scheduled");
  });

  it("put back refuses loudly when a Not played match's ledger folds to a result (D2's assertion; the row is made by hand)", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    expect(await playToDecided(systemAuth(), m1!.id)).toMatchObject({ kind: "decided" });
    // By hand: no guest path writes `cancelled` over a result (the skip refuses one, case 6).
    await sql`update fixtures set status = 'cancelled' where id = ${m1!.id}`;
    const err = await refusalOf(putBackQuickMatchFixture(row, m1!.id));
    expect(err).not.toBeInstanceOf(HttpError);
    expect(String(err)).toMatch(/is Not played, yet its ledger folds to a result/);
    expect((await fixture(m1!.id)).status, "nothing was put back").toBe("cancelled");
  });

  it("put back refuses loudly when a writer that skips the fixture lock moves the row mid-put-back; it never overwrites it", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    expect(await skipQuickMatchFixture(row, m1!.id)).toEqual({ changed: true });
    const real = (await vi.importActual<typeof import("@/server/engine-db/fold")>("@/server/engine-db/fold")).foldFixture;
    foldSpy.mockImplementationOnce(async (tx, id) => {
      // Another connection, no advisory lock: it commits while Put back holds the fixture lock.
      await sql`update fixtures set status = 'in_play' where id = ${id}`;
      return real(tx, id);
    });
    const err = await refusalOf(putBackQuickMatchFixture(row, m1!.id));
    expect(String(err)).toMatch(/left Not played while the lock was held/);
    expect((await fixture(m1!.id)).status, "the other writer's status stands").toBe("in_play");
  });

  it("D1: the skip waits on the fixture lock the write path takes, so a tap racing it lands first or is refused", async () => {
    const { out, row } = await make();
    const [m1] = await fixturesOf(out.competitionId);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => (locked = r));
    // The holder: the key `appendEvent` takes (append-event.ts), held as a scoring transaction holds it.
    const holder = sql.begin(async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + m1!.id}))`;
      locked(pid);
      await held;
    });
    try {
      const pid = await holderPid;
      const skipping = skipQuickMatchFixture(row, m1!.id);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i++) {
        const [r] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
        waiting = r!.n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, "the skip is blocked on the holder's fixture lock").toBe(1);
      expect((await fixture(m1!.id)).status, "and has written nothing yet").toBe("scheduled");
      release();
      await holder;
      expect(await skipping).toEqual({ changed: true });
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  });
});

describe.skipIf(!HAS_DB)("skip and put back in every offered sport (P14, Review Focus 2)", () => {
  // A league of 2 played twice (QUICK_MATCH_MAX_PLAYS): two matches, so skipping one does not finish the league, which
  // would refuse the put back (case 5).
  it("11. a league of 2 played twice, its first match started and scored once, skipped and put back: the stored state is byte-identical, the status returns, the table is unchanged", async () => {
    const offered = new Map((await listQuickMatchSports()).map((s) => [s.sport_key, s]));
    expect(OFFERED_SPORT_KEYS.length, "the offer names 9 sports (P14)").toBe(9);
    let checked = 0;
    let startOnly = 0;
    const visited = await forEachSportAsync(async ({ key }) => {
      if (!OFFERED_SPORT_KEYS.includes(key)) return;   // generic and the lineup sport: no guest makes one
      const sport = offered.get(key);
      expect(sport, `${key}: the offer and the catalog agree`).toBeDefined();
      const { out, row } = await make(league({
        sport_key: key,
        variant_key: sport!.variants[0]!.variant_key,
        kind: sport!.kinds.at(-1)!,
        sides: ["Side A", "Side B"],
        plays: 2,
      }));
      const fixtures = await fixturesOf(out.competitionId);
      expect(fixtures, `${key}: premise, two sides playing twice is two matches`).toHaveLength(2);
      const [m] = fixtures;
      const firstRally = await firstRallyFor(m!.id).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      if (firstRally instanceof Error) {
        // Chess has no rally: every move decides a game (the probe's own "no play event" refusal, naming this sport). Its
        // only partly played state is a started match.
        expect(firstRally.message, key).toMatch(new RegExp(`^firstRallyFor: ${key} draws no play event after core\\.start`));
        await scoreEvent(systemAuth(), m!.id, { expected_seq: 0, type: "core.start", payload: {} });
        startOnly++;
      } else {
        for (const e of firstRally) await scoreEvent(systemAuth(), m!.id, e);
      }
      const before = await fixture(m!.id);
      expect(before.status, `${key}: premise, started and undecided`).toBe("in_play");
      const ledger = await ledgerOf(m!.id);
      expect(ledger.states, `${key}: premise, the fold is stored`).toHaveLength(1);
      const table = await tableOf(await homeOf(row));

      expect(await skipQuickMatchFixture(row, m!.id), key).toEqual({ changed: true });
      expect(await putBackQuickMatchFixture(row, m!.id), key).toEqual({ changed: true, status: before.status });
      expect(await ledgerOf(m!.id), `${key}: byte-identical`).toEqual(ledger);
      expect(await tableOf(await homeOf(row)), key).toEqual(table);
      checked++;
      await hardDeleteQuickMatchCompetition(out.competitionId);
    });
    console.info(`quick match skip sweep: ${checked} offered sports skipped and put back (${startOnly} at a Start only), of ${visited} sport modules`);
    expect(visited).toBeGreaterThan(0);
    expect(checked, "zero checked is a failure").toBeGreaterThan(0);
    expect(checked, "every offered sport, once").toBe(OFFERED_SPORT_KEYS.length);
  }, SWEEP_TIMEOUT_MS);
});
