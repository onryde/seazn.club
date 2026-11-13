// Approvals through a Match Day code (capture S4 design §7, §9.5; MD-1 Task 6): review and approve the next Swiss round
// and a knockout's draw (the seed proposal), as the server computed them. The code is the gate — its "can approve draws"
// tick (MD_NO_APPROVE on the review AND the approve, the controller's dispatch: the code's actor carries its issuer's
// user id, so membership alone would let any code through) and its scope (MD_OUT_OF_SCOPE). The stage usecases' refusals
// come back as md_ words: MD_STALE, MD_ALREADY, MD_TIES. Plus the route (`GET|POST
// /api/v1/match-day-code/approvals/{kind}/{stageId}`) against its contract twins. Real Postgres; skipped without
// DATABASE_URL.
//
// Two sports on purpose: the draw on `generic` (the seed proposal reads standings, not a sport) and the Swiss on chess
// (`boardgame`), the sport task 5's preview tests pair with.
//
// Every expected value is read from the rows the rig wrote (the group winners, the seats, the proposals) or from the
// plan's words; none is computed by the code under test.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { appendEvent } from "@/server/engine-db";
import { CaptureMatchdayApprovalOk, CaptureMatchdayApprovalReview, CaptureMatchdayRefusal } from "@/server/api-v1/capture-schemas";
import { mintMatchDayCode, type MatchDayCodeRow, type MatchDayScope } from "../match-day-codes";
import { approveForCode, mdRefusalOf, reviewApprovalForCode } from "../match-day-code-approvals";
import { getMatchDayForCode } from "../match-day-code-view";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, computeSeedProposal, createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG } from "./_seed";
import { at, place, seedCompetition, seedDay, T0, type Day } from "./_match-day-seed";
import { GET, POST } from "@/app/api/v1/match-day-code/approvals/[kind]/[stageId]/route";
import { POST as eventsRoute } from "@/app/api/v1/fixtures/[id]/events/route";
import { openMatchForCode } from "../match-day-code-open";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;
/** 10:30 UTC on Saturday 7 November, inside the code's day. */
const NOW = at(30);
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function codeFor(day: Day, scope: MatchDayScope, canApprove: boolean): Promise<{ code: MatchDayCodeRow; token: string }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
  try {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope, day: "2026-11-07", canApprove });
    return { code: row, token: tokenOf(url) };
  } finally {
    vi.useRealTimers();
  }
}

/** The refusal's status and code, or null when the call went through. */
const refusalOf = (p: Promise<unknown>): Promise<{ status?: number; code?: string } | null> =>
  p.then(
    () => null,
    (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
  );

const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;
const usesOf = (codeId: string) =>
  sql<{ kind: string; stage_id: string | null; approval: string | null; fixture_id: string | null }[]>`
    select kind, stage_id, approval, fixture_id from match_day_code_uses where code_id = ${codeId} order by id`;
const nameOf = async (id: string | null): Promise<string | null> =>
  id === null ? null : (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${id}`)[0]!.display_name;

// ---------------------------------------------------------------------------------------------------------------
// The draw rig: in the day's competition, a division of four in two groups of two, then `KO`, a knockout drawn from the
// group winners at setup (`topNPerGroup 1`: two qualifiers, one final). The groups are played and completed, which
// computes the first draft proposal.
// ---------------------------------------------------------------------------------------------------------------
interface Draw {
  divisionId: string;
  koId: string;
  finalId: string;
  /** The group winners, read from the results the rig wrote (each group's home side won 2-0). */
  winners: string[];
}

async function drawDivision(day: Day, opts: { level?: boolean } = {}): Promise<Draw> {
  const division = await createDivision(day.auth, day.comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(day.auth, division.id, ["E1", "E2", "E3", "E4"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const stages = await createStages(day.auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
    {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }], placement: "rank_order", timing: "setup" },
    },
  ]);
  const groupId = stages.find((s) => s.kind === "group")!.id;
  const koId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(day.auth, koId);
  await generateStageFixtures(day.auth, groupId);
  const groupFixtures = await sql<{ id: string; home_entrant_id: string }[]>`select id, home_entrant_id from fixtures where stage_id = ${groupId}`;
  for (const f of groupFixtures) {
    await appendEvent(day.auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(day.auth.orgId, f.id, 1, { type: "generic.result", payload: opts.level ? { p1Score: 1, p2Score: 1 } : { p1Score: 2, p2Score: 0 } });
  }
  await completeStage(day.auth, groupId);
  const finals = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${koId}`;
  expect(finals, "rig: two qualifiers make one final").toHaveLength(1);
  return { divisionId: division.id, koId, finalId: finals[0]!.id, winners: groupFixtures.map((f) => f.home_entrant_id) };
}

const proposalsOf = (stageId: string) =>
  sql<{ id: string; status: string }[]>`select id, status from stage_seed_proposals where stage_id = ${stageId} order by created_at, id`;
const draftOf = async (stageId: string): Promise<string | null> => (await proposalsOf(stageId)).find((p) => p.status === "draft")?.id ?? null;
const seatsOf = async (fixtureId: string) =>
  (await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`)[0]!;

// ---------------------------------------------------------------------------------------------------------------
// The Swiss rig: in the day's competition, a chess Swiss of four over three rounds, started (which mints the shells) and
// round 1 paired. `decideRoundOne` plays round 1 out (each board's home side wins).
// ---------------------------------------------------------------------------------------------------------------
interface Swiss {
  stageId: string;
}

async function swissDivision(day: Day): Promise<Swiss> {
  const division = await createDivision(day.auth, day.comp.id, {
    name: "Chess",
    slug: "chess-" + randomUUID().slice(0, 6),
    sport_key: "boardgame",
    variant_key: "classical",
    config: {},
  });
  await createEntrants(day.auth, division.id, ["P1", "P2", "P3", "P4"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const [stage] = await createStages(day.auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3, chess: true }, progression: null });
  await startDivision(day.auth, division.id);
  await generateStageFixtures(day.auth, stage!.id);
  return { stageId: stage!.id };
}

type Board = { id: string; seq_in_round: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null };
const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, seq_in_round, status, home_entrant_id, away_entrant_id from fixtures
     where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

async function post(day: Day, fixtureId: string, type: string, payload: unknown = {}): Promise<void> {
  const [{ s }] = await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(day.auth, fixtureId, { expected_seq: s, type, payload } as never);
}

async function decideRoundOne(day: Day, s: Swiss): Promise<number> {
  const boards = (await boardsOf(s.stageId, 1)).filter((b) => b.home_entrant_id !== null && b.away_entrant_id !== null);
  for (const b of boards) {
    await post(day, b.id, "core.start");
    await post(day, b.id, "boardgame.result", { winner: b.home_entrant_id, method: "resign" });
  }
  return boards.length;
}

const seatedIn = async (stageId: string, round: number) => (await boardsOf(stageId, round)).filter((b) => b.home_entrant_id !== null).length;

describe.skipIf(!HAS_DB)("approvals through a Match Day code", () => {
  let day: Day;
  beforeEach(async () => {
    day = await seedDay();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("draw (the seed proposal)", () => {
    it("GET draw uses the live draft, computing one only when none is draft", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const first = await draftOf(d.koId);
      expect(first, "premise: completing the groups computed a draft").not.toBeNull();

      const review = await reviewApprovalForCode(code, "draw", d.koId);
      expect(review.hash, "the live draft, by id").toBe(first);
      expect(await proposalsOf(d.koId), "nothing computed while a draft is live").toHaveLength(1);
      expect(review).toMatchObject({ kind: "draw", stage_id: d.koId, division_name: "Open", round: null, ties: false });
      // One final, its two seats the group winners (the order is the proposal's; the names are the rig's).
      expect(review.rows).toHaveLength(1);
      expect(review.rows[0]!.label, "the board's code for a one-match final").toBe("F");
      const shown = [review.rows[0]!.home, review.rows[0]!.away];
      expect([...shown].sort()).toEqual((await Promise.all(d.winners.map(nameOf))).sort());
      expect(CaptureMatchdayApprovalReview.safeParse(review).success, "the answer matches its contract twin").toBe(true);

      // No draft left (the last one stale): the review computes one, once.
      await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${d.koId}`;
      const again = await reviewApprovalForCode(code, "draw", d.koId);
      const proposals = await proposalsOf(d.koId);
      expect(proposals, "one draft computed").toHaveLength(2);
      expect(again.hash).toBe(proposals.find((p) => p.status === "draft")!.id);
      expect(again.hash).not.toBe(first);
      expect((await reviewApprovalForCode(code, "draw", d.koId)).hash, "and reused by the next review").toBe(again.hash);
      expect(await proposalsOf(d.koId)).toHaveLength(2);
    });

    it("a match with one qualifier drawn into it, on its away seat, names her as home with away null", async () => {
      // A bye seed's wire slot can be an away seat with nothing drawn opposite (the other seat fed from elsewhere). The
      // draft is narrowed by hand to that shape: one qualifier, on the final's away seat.
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const draft = (await draftOf(d.koId))!;
      await sql`
        update stage_seed_proposals
           set computed = jsonb_set(computed, '{qualifiers}', jsonb_build_array(
                 jsonb_set(computed->'qualifiers'->0, '{destinationSlot}', to_jsonb(${`${d.finalId}:away`}::text))))
         where id = ${draft}`;
      const [{ entrant }] = await sql<{ entrant: string }[]>`select computed->'qualifiers'->0->>'entrantId' as entrant from stage_seed_proposals where id = ${draft}`;
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      expect(review.hash).toBe(draft);
      expect(review.rows).toEqual([{ label: "F", home: await nameOf(entrant!), away: null }]);
    });

    it("POST draw confirms and fills the knockout's TBD slots", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      expect(await seatsOf(d.finalId), "premise: the final's seats are TBD").toEqual({ home_entrant_id: null, away_entrant_id: null });
      const review = await reviewApprovalForCode(code, "draw", d.koId);

      expect(await approveForCode(code, "draw", d.koId, { hash: review.hash })).toEqual({ ok: true });

      const seats = await seatsOf(d.finalId);
      expect([seats.home_entrant_id, seats.away_entrant_id].sort(), "the group winners, seated").toEqual([...d.winners].sort());
      // Seated exactly as the review showed them, side for side.
      expect([await nameOf(seats.home_entrant_id), await nameOf(seats.away_entrant_id)]).toEqual([review.rows[0]!.home, review.rows[0]!.away]);
      expect((await proposalsOf(d.koId)).find((p) => p.id === review.hash)?.status).toBe("confirmed");
    });

    it("POST draw with ties is MD_TIES: the phone cannot pick ties", async () => {
      // Every group match level: each group's two are tied for first, which only the desk can order.
      const d = await drawDivision(day, { level: true });
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      expect(review.ties, "premise: the draft flags a tie").toBe(true);

      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: review.hash }))).toEqual({ status: 409, code: "MD_TIES" });
      expect(await seatsOf(d.finalId), "nothing seated").toEqual({ home_entrant_id: null, away_entrant_id: null });
      expect((await proposalsOf(d.koId)).find((p) => p.id === review.hash)?.status, "the draft is still the desk's to resolve").toBe("draft");
      expect(await usesOf(code.id), "a refusal logs nothing").toEqual([]);
    });

    it("POST draw with a stale proposal is MD_STALE, and a second POST is MD_ALREADY", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      // The desk recomputes after the phone's review: the reviewed draft is stale (SEEDING_PROPOSAL_STALE).
      const desk = await computeSeedProposal(day.auth, d.koId);
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: review.hash }))).toEqual({ status: 409, code: "MD_STALE" });
      expect(await seatsOf(d.finalId), "nothing seated").toEqual({ home_entrant_id: null, away_entrant_id: null });

      // "Draw changed — review again": the review now shows the desk's draft, and that one approves.
      const fresh = await reviewApprovalForCode(code, "draw", d.koId);
      expect(fresh.hash).toBe(desk.id);
      expect(await approveForCode(code, "draw", d.koId, { hash: fresh.hash })).toEqual({ ok: true });
      const seats = await seatsOf(d.finalId);

      // The second phone, holding the same proposal (SEEDING_ALREADY_CONFIRMED); and its review, after the fact.
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: fresh.hash }))).toEqual({ status: 409, code: "MD_ALREADY" });
      expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual({ status: 409, code: "MD_ALREADY" });
      expect(await seatsOf(d.finalId), "the first approve's seats stand").toEqual(seats);
    });

    it("a qualifier who leaves after the review: the approve is MD_STALE, and the next review leaves her out", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const reviewed = await reviewApprovalForCode(code, "draw", d.koId);
      const left = await nameOf(d.winners[0]!);
      expect(reviewed.rows.flatMap((r) => [r.home, r.away]), "premise: the review offered her").toContain(left);
      await withdrawEntrantCascade(day.auth, d.winners[0]!);

      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: reviewed.hash }))).toEqual({ status: 409, code: "MD_STALE" });
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      expect(review.hash, "a fresh draft, not the one naming her").not.toBe(reviewed.hash);
      expect(review.rows.flatMap((r) => [r.home, r.away]), "she is not offered").not.toContain(left);
      expect(review.rows.flatMap((r) => [r.home, r.away]), "the other winner still is").toContain(await nameOf(d.winners[1]!));
    });

    it("an approve that races a withdrawal (the draft still a draft, naming her) is MD_STALE, never a seat for her", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      // The status flip alone, before the field change's own stale mark lands (entrants.ts runs it after its commit).
      await sql`update entrants set status = 'withdrawn' where id = ${d.winners[0]!}`;
      expect(await draftOf(d.koId), "premise: the draft is still the live one").toBe(review.hash);
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: review.hash }))).toEqual({ status: 409, code: "MD_STALE" });
      expect(await seatsOf(d.finalId), "nothing seated").toEqual({ home_entrant_id: null, away_entrant_id: null });
    });

    it("a draw not ready yet (its groups still playing) is MD_STALE", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      // The groups reopened, every proposal gone: the compute finds its source incomplete (SEEDING_SOURCE_INCOMPLETE).
      await sql`update stages set status = 'active' where division_id = ${d.divisionId} and kind = 'group'`;
      await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${d.koId}`;
      expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual({ status: 409, code: "MD_STALE" });
      expect(await draftOf(d.koId), "nothing computed").toBeNull();
    });
  });

  describe("F-T8-2: a waiting draw is listed, and still refused", () => {
    it("every group match decided, the stage not complete: the day read lists the draw waiting; the review and the approve refuse MD_STALE; nothing is seated", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      // The desk reopens the groups: every match is still decided, the stage is no longer complete.
      await sql`update stages set status = 'active' where division_id = ${d.divisionId} and kind = 'group'`;
      const listed = (await getMatchDayForCode(code, NOW)).approvals.find((a) => a.stage_id === d.koId);
      expect(listed?.waiting, "premise: the phone is shown the waiting draw").toBe("stage_complete");
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: review.hash }))).toEqual({ status: 409, code: "MD_STALE" });
      await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${d.koId}`;
      expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual({ status: 409, code: "MD_STALE" });
      expect(await seatsOf(d.finalId), "nothing seated").toEqual({ home_entrant_id: null, away_entrant_id: null });
    });
  });

  describe("fix round 1: no word outside the md_ list, and the use row never fails an approval", () => {
    it("a seat filled after the draft (409 SEEDING_FIXTURES_ALREADY_FILLED) is MD_STALE, with no use row", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      // The desk seats someone in the final by hand after the phone's review.
      const [{ id: other }] = await sql<{ id: string }[]>`
        select id from entrants where division_id = ${d.divisionId} and id <> all(${d.winners}::uuid[]) limit 1`;
      await sql`update fixtures set home_entrant_id = ${other!} where id = ${d.finalId}`;
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: review.hash }))).toEqual({ status: 409, code: "MD_STALE" });
      expect((await seatsOf(d.finalId)).away_entrant_id, "nothing seated").toBeNull();
      expect(await usesOf(code.id)).toEqual([]);
    });

    it("a draw with nobody left to seed: the review and the approve are MD_STALE (review M4)", async () => {
      const d = await drawDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const draft = (await draftOf(d.koId))!;
      await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{qualifiers}', '[]'::jsonb) where id = ${draft}`;
      expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual({ status: 409, code: "MD_STALE" });
      // The approve's own refusal (422 SEEDING_NOTHING_TO_FILL) in md_ words too.
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: draft }))).toEqual({ status: 409, code: "MD_STALE" });
      expect((await proposalsOf(d.koId)).find((p) => p.id === draft)?.status, "the draft is left for a recompute").toBe("draft");
    });

    it("an approval whose use row cannot be written still answers ok, and the failure is a warning with ids only", async () => {
      const d = await drawDivision(day);
      const { code, token } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "draw", d.koId);
      // The code's row gone under the approve: the use insert breaks its foreign key.
      await sql`delete from match_day_codes where id = ${code.id}`;
      const warn = vi.spyOn(log, "warn");
      try {
        expect(await approveForCode(code, "draw", d.koId, { hash: review.hash })).toEqual({ ok: true });
        const line = warn.mock.calls.find((c) => String(c[1]).includes("use row was not written"));
        expect(line, "the failed write is warned").toBeDefined();
        expect(line![0]).toEqual({ codeId: code.id, stageId: d.koId, kind: "draw", pg: "23503" });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
      } finally {
        warn.mockRestore();
      }
      const seats = await seatsOf(d.finalId);
      expect([seats.home_entrant_id, seats.away_entrant_id].sort(), "the approval committed").toEqual([...d.winners].sort());
    });
  });

  describe("fix round 2: a locked schedule is the desk's, a coded 4xx keeps its status, a fault keeps its cause", () => {
    const lotsOf = (stageId: string) => count(sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId}`);
    const lock = (stageId: string) =>
      sql`update divisions set schedule_locked = true where id = (select division_id from stages where id = ${stageId})`;

    it("a schedule-locked division lists no approval in the day read, and GET and POST are MD_NO_APPROVE for both kinds", async () => {
      const d = await drawDivision(day);
      const s = await swissDivision(day);
      await decideRoundOne(day, s);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const listed = async () => (await getMatchDayForCode(code, NOW)).approvals.map((a) => a.stage_id).sort();
      expect(await listed(), "premise: both approvals listed while unlocked").toEqual([d.koId, s.stageId].sort());
      // The Swiss review before the lock: its hash and round for the POST, and its lots draw committed.
      const swiss = await reviewApprovalForCode(code, "swiss", s.stageId);
      const draft = (await draftOf(d.koId))!;
      const proposals = await proposalsOf(d.koId);
      const lots = await lotsOf(s.stageId);
      await lock(d.koId);
      await lock(s.stageId);

      expect(await listed(), "the day read lists neither").toEqual([]);
      const refused = { status: 403, code: "MD_NO_APPROVE" };
      expect(await refusalOf(reviewApprovalForCode(code, "swiss", s.stageId)), "GET swiss").toEqual(refused);
      expect(await refusalOf(approveForCode(code, "swiss", s.stageId, { hash: swiss.hash, round: swiss.round })), "POST swiss").toEqual(refused);
      // No live draft: a review let through would compute one.
      await sql`update stage_seed_proposals set status = 'stale' where id = ${draft}`;
      expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId)), "GET draw").toEqual(refused);
      expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: draft })), "POST draw").toEqual(refused);

      expect(await seatedIn(s.stageId, 2), "no round paired").toBe(0);
      expect(await lotsOf(s.stageId), "no lots drawn").toBe(lots);
      expect(await seatsOf(d.finalId), "no draw seated").toEqual({ home_entrant_id: null, away_entrant_id: null });
      expect((await proposalsOf(d.koId)).map((p) => p.id), "no draft computed").toEqual(proposals.map((p) => p.id));
      expect(await usesOf(code.id)).toEqual([]);
    });

    it("a draw asked of a Swiss stage is 422 with no word, like a Swiss round asked of a knockout (N4); warned with ids only", async () => {
      const s = await swissDivision(day);
      const d = await drawDivision(day);
      const { code, token } = await codeFor(day, { kind: "competition" }, true);
      const warn = vi.spyOn(log, "warn");
      try {
        // The compute's 422 SEEDING_RULES_MISSING: a coded 4xx with no md_ word keeps its status and loses its word.
        expect(await refusalOf(reviewApprovalForCode(code, "draw", s.stageId))).toEqual({ status: 422, code: undefined });
        // The reverse: the Swiss usecase's own codeless 422.
        expect(await refusalOf(reviewApprovalForCode(code, "swiss", d.koId))).toEqual({ status: 422, code: undefined });
        const line = warn.mock.calls.find((c) => String(c[1]).includes("no md_ word"));
        expect(line, "premise: the refusal was logged").toBeDefined();
        expect(line![0]).toEqual({ codeId: code.id, stageId: s.stageId, kind: "draw", upstream: "SEEDING_RULES_MISSING", status: 422 });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("final review: Swiss round 1 is the desk's (m1); an online board scores through its link (m3)", () => {
    const lotsOf = (stageId: string) => count(sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId}`);

    it("a Swiss round 1 to pair (after a desk Unpair) is not listed, and GET and POST are MD_STALE, seating nothing", async () => {
      const s = await swissDivision(day);
      // The desk's Unpair of round 1: its boards have no seats again.
      await sql`update fixtures set home_entrant_id = null, away_entrant_id = null where stage_id = ${s.stageId} and round_no = 1`;
      expect(await seatedIn(s.stageId, 1), "premise: round 1 is unpaired").toBe(0);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.stage_id), "not listed").not.toContain(s.stageId);
      const lots = await lotsOf(s.stageId);
      const stale = { status: 409, code: "MD_STALE" };
      expect(await refusalOf(reviewApprovalForCode(code, "swiss", s.stageId)), "GET").toEqual(stale);
      expect(await refusalOf(approveForCode(code, "swiss", s.stageId, { hash: "0".repeat(64), round: 1 })), "POST").toEqual(stale);
      expect(await seatedIn(s.stageId, 1), "nothing seated").toBe(0);
      expect(await lotsOf(s.stageId), "no lots drawn").toBe(lots);
      expect(await usesOf(code.id)).toEqual([]);
    });

    it("m3 evidence: a device-link result on an ONLINE (Lichess) board is accepted by the events route, so online boards stay", async () => {
      const s = await swissDivision(day);
      await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb
                 where id = (select division_id from stages where id = ${s.stageId})`;
      const [board] = (await boardsOf(s.stageId, 1)).filter((b) => b.home_entrant_id !== null && b.away_entrant_id !== null);
      const { code } = await codeFor(day, { kind: "competition" }, false);
      const opened = await openMatchForCode(code, board!.id, NOW);
      expect(opened.kind, "premise: the code opens the online board").toBe("link");
      if (opened.kind !== "link") return;
      const bearer = { authorization: `Bearer ${opened.url.slice(opened.url.lastIndexOf("/") + 1)}`, "content-type": "application/json" };
      const send = (body: Record<string, unknown>) =>
        eventsRoute(new Request(`http://test.local/api/v1/fixtures/${board!.id}/events`, { method: "POST", headers: bearer, body: JSON.stringify(body) }), {
          params: Promise.resolve({ id: board!.id }),
        });
      expect((await send({ expected_seq: 0, type: "core.start", payload: {} })).status).toBe(201);
      const result = await send({ expected_seq: 1, type: "boardgame.result", payload: { winner: board!.home_entrant_id, method: "resign" } });
      expect(result.status, "the link's result is recorded").toBe(201);
      const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${board!.id}`;
      expect(status).not.toBe("scheduled");
    });
  });

  describe("swiss (the next round)", () => {
    it("POST swiss pairs the round the review showed, the round the day read lists", async () => {
      const s = await swissDivision(day);
      expect(await decideRoundOne(day, s), "rig: round 1 decided").toBe(2);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const listed = (await getMatchDayForCode(code, NOW)).approvals.find((a) => a.stage_id === s.stageId);
      expect(listed, "premise: the day read lists the Swiss approval").toBeDefined();

      const review = await reviewApprovalForCode(code, "swiss", s.stageId);
      expect(review).toMatchObject({ kind: "swiss", stage_id: s.stageId, division_name: "Chess", ties: false });
      expect(review.round, "the day read's round").toBe(listed!.round);
      expect(review.round).toBe(2);
      expect(review.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(review.rows.map((r) => r.label)).toEqual(["R2 1", "R2 2"]);
      expect(CaptureMatchdayApprovalReview.safeParse(review).success).toBe(true);
      expect(await seatedIn(s.stageId, 2), "the review seats nothing").toBe(0);

      expect(await approveForCode(code, "swiss", s.stageId, { hash: review.hash, round: review.round })).toEqual({ ok: true });

      const seated = await boardsOf(s.stageId, 2);
      const shown = await Promise.all(seated.map(async (b) => ({ home: await nameOf(b.home_entrant_id), away: await nameOf(b.away_entrant_id) })));
      expect(shown, "round 2 seated board for board as reviewed").toEqual(review.rows.map((r) => ({ home: r.home, away: r.away })));
      // The second phone: the round is seated.
      expect(await refusalOf(approveForCode(code, "swiss", s.stageId, { hash: review.hash, round: review.round }))).toEqual({ status: 409, code: "MD_ALREADY" });
    });

    it("a Swiss approve with no round is refused, and seats nothing", async () => {
      const s = await swissDivision(day);
      await decideRoundOne(day, s);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const review = await reviewApprovalForCode(code, "swiss", s.stageId);
      expect(await refusalOf(approveForCode(code, "swiss", s.stageId, { hash: review.hash }))).toEqual({ status: 422, code: undefined });
      expect(await seatedIn(s.stageId, 2)).toBe(0);
    });

    it("a Swiss round still in play is MD_STALE (not ready: the plan has no other word)", async () => {
      const s = await swissDivision(day);
      const { code } = await codeFor(day, { kind: "competition" }, true);
      expect(await refusalOf(reviewApprovalForCode(code, "swiss", s.stageId))).toEqual({ status: 409, code: "MD_STALE" });
    });
  });

  it("GET and POST without can_approve are MD_NO_APPROVE, for both kinds, and write nothing", async () => {
    const d = await drawDivision(day);
    const s = await swissDivision(day);
    await decideRoundOne(day, s);
    // No live draft: a review allowed through would compute one.
    await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${d.koId}`;
    const before = await proposalsOf(d.koId);
    const lots = () => count(sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${s.stageId}`);
    const lotsBefore = await lots();
    // The issuer is an owner of the org; the code's actor carries their user id. The tick is the gate, not membership.
    const { code } = await codeFor(day, { kind: "competition" }, false);
    const refused = { status: 403, code: "MD_NO_APPROVE" };
    let checked = 0;
    for (const kind of ["draw", "swiss"] as const) {
      const stageId = kind === "draw" ? d.koId : s.stageId;
      expect(await refusalOf(reviewApprovalForCode(code, kind, stageId)), `GET ${kind}`).toEqual(refused);
      expect(await refusalOf(approveForCode(code, kind, stageId, { hash: before[0]!.id, round: 2 })), `POST ${kind}`).toEqual(refused);
      checked += 2;
    }
    expect(checked).toBe(4);
    expect(await proposalsOf(d.koId), "no draft computed").toEqual(before);
    expect(await seatsOf(d.finalId)).toEqual({ home_entrant_id: null, away_entrant_id: null });
    expect(await seatedIn(s.stageId, 2), "no round paired").toBe(0);
    expect(await lots(), "no lots drawn").toBe(lotsBefore);
    expect(await usesOf(code.id)).toEqual([]);
  });

  it("a stage outside a venue code's courts is MD_OUT_OF_SCOPE: a stage is in scope when any of its fixtures today is", async () => {
    const d = await drawDivision(day);
    const { code } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA }, true);
    const out = { status: 403, code: "MD_OUT_OF_SCOPE" };
    // No match of the stage on a court today.
    expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual(out);
    // The final today, but on Hall B's court.
    await place(day, d.finalId, 60, day.courts.c3);
    expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual(out);
    const draft = (await draftOf(d.koId))!;
    expect(await refusalOf(approveForCode(code, "draw", d.koId, { hash: draft }))).toEqual(out);
    // On Hall A's court, but tomorrow.
    await place(day, d.finalId, 24 * 60, day.courts.c1);
    expect(await refusalOf(reviewApprovalForCode(code, "draw", d.koId))).toEqual(out);
    expect(await seatsOf(d.finalId), "nothing seated").toEqual({ home_entrant_id: null, away_entrant_id: null });
    // On Hall A's court today: in scope.
    await place(day, d.finalId, 60, day.courts.c1);
    expect((await reviewApprovalForCode(code, "draw", d.koId)).hash).toBe(draft);
    // Another competition's stage, even for a whole-competition code; an unknown stage is 404.
    const other = await seedCompetition(day.auth, "Other Open", [[day.people[0]!], [day.people[1]!]], { courts: [day.courts.c1] });
    const whole = (await codeFor(day, { kind: "competition" }, true)).code;
    expect(await refusalOf(reviewApprovalForCode(whole, "draw", other.stageId))).toEqual(out);
    expect(await refusalOf(reviewApprovalForCode(whole, "draw", randomUUID()))).toEqual({ status: 404, code: undefined });
    expect(await refusalOf(reviewApprovalForCode(whole, "draw", "not-a-uuid"))).toEqual({ status: 404, code: undefined });
    // A draw hash that names no proposal of this stage — not a proposal id at all, or another stage's — is 404 too.
    expect(await refusalOf(approveForCode(whole, "draw", d.koId, { hash: "f".repeat(64) }))).toEqual({ status: 404, code: undefined });
    expect(await refusalOf(approveForCode(whole, "draw", d.koId, { hash: randomUUID() }))).toEqual({ status: 404, code: undefined });
    // An archived division's stage: the day read never lists it.
    await sql`update divisions set archived_at = now() where id = ${d.divisionId}`;
    expect(await refusalOf(reviewApprovalForCode(whole, "draw", d.koId))).toEqual(out);
  });

  it("each approve writes one use row; a review and a refusal write none", async () => {
    const d = await drawDivision(day);
    const s = await swissDivision(day);
    await decideRoundOne(day, s);
    const { code } = await codeFor(day, { kind: "competition" }, true);
    const draw = await reviewApprovalForCode(code, "draw", d.koId);
    const swiss = await reviewApprovalForCode(code, "swiss", s.stageId);
    expect(await usesOf(code.id), "a review logs nothing").toEqual([]);
    await approveForCode(code, "draw", d.koId, { hash: draw.hash });
    await approveForCode(code, "swiss", s.stageId, { hash: swiss.hash, round: swiss.round });
    await refusalOf(approveForCode(code, "draw", d.koId, { hash: draw.hash }));
    expect(await usesOf(code.id)).toEqual([
      { kind: "approve", stage_id: d.koId, approval: "draw", fixture_id: null },
      { kind: "approve", stage_id: s.stageId, approval: "swiss", fixture_id: null },
    ]);
  });

  describe("GET|POST /api/v1/match-day-code/approvals/{kind}/{stageId}", () => {
    const call = (method: "GET" | "POST", bearer: string, kind: string, stageId: string, body?: unknown): Promise<Response> => {
      const req = new Request(`https://test.local/api/v1/match-day-code/approvals/${kind}/${stageId}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const ctx = { params: Promise.resolve({ kind, stageId }) };
      return method === "GET" ? GET(req, ctx) : POST(req, ctx);
    };

    it("the answers validate against capture-matchday-approval.v1.json, and never carry the token", async () => {
      const d = await drawDivision(day);
      const { token } = await codeFor(day, { kind: "competition" }, true);
      const { token: viewOnly } = await codeFor(day, { kind: "competition" }, false);
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });

      const got = await call("GET", token, "draw", d.koId);
      expect(got.status).toBe(200);
      expect(got.headers.get("cache-control")).toBe("no-store");
      const gotText = await got.text();
      const review = JSON.parse(gotText).data;
      expect(CaptureMatchdayApprovalReview.safeParse(review).success).toBe(true);

      const ok = await call("POST", token, "draw", d.koId, { hash: review.hash });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()).data;
      expect(okBody).toEqual({ ok: true });
      expect(CaptureMatchdayApprovalOk.safeParse(okBody).success).toBe(true);

      const again = await call("POST", token, "draw", d.koId, { hash: review.hash });
      expect(again.status).toBe(409);
      const refusal = (await again.json()).error;
      expect(refusal.code).toBe("MD_ALREADY");
      expect(CaptureMatchdayRefusal.safeParse(refusal).success).toBe(true);

      const noApprove = await call("GET", viewOnly, "draw", d.koId);
      expect(noApprove.status).toBe(403);
      const noApproveError = (await noApprove.json()).error;
      expect(noApproveError.code).toBe("MD_NO_APPROVE");
      expect(CaptureMatchdayRefusal.safeParse(noApproveError).success).toBe(true);
      expect((await call("POST", viewOnly, "draw", d.koId, { hash: review.hash })).status).toBe(403);

      expect((await call("GET", token, "league", d.koId)).status, "an unknown kind is no route").toBe(404);
      expect(gotText.length).toBeGreaterThan(50);
      for (const text of [gotText, JSON.stringify([okBody, refusal, noApproveError])]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain("md_");
      }
    });
  });
});

describe("mdRefusalOf: what leaves an md_ route (fix round 2)", () => {
  const asked = { codeId: randomUUID(), stageId: randomUUID(), kind: "swiss" as const };
  it("SCHEDULE_LOCKED is MD_NO_APPROVE, 403", () => {
    const out = mdRefusalOf(asked, new HttpError(422, "locked", "SCHEDULE_LOCKED")) as HttpError;
    expect({ status: out.status, code: out.code }).toEqual({ status: 403, code: "MD_NO_APPROVE" });
  });
  it("a coded 5xx is a fault: 500 INTERNAL with the upstream error as its cause (N2)", () => {
    const upstream = new HttpError(503, "upstream down", "SOMETHING_UPSTREAM");
    const out = mdRefusalOf(asked, upstream) as HttpError;
    expect({ status: out.status, code: out.code }).toEqual({ status: 500, code: "INTERNAL" });
    expect(out.cause).toBe(upstream);
  });
  it("a coded 4xx with no md_ word keeps its status and loses its word", () => {
    const out = mdRefusalOf(asked, new HttpError(400, "bad", "SOMETHING_ELSE")) as HttpError;
    expect({ status: out.status, code: out.code }).toEqual({ status: 400, code: undefined });
  });
  it("the 4xx/5xx boundary: a coded 499 keeps its status with no word, a coded 500 is a fault with its cause (review M-b)", () => {
    const at499 = mdRefusalOf(asked, new HttpError(499, "edge", "EDGE_4XX")) as HttpError;
    expect({ status: at499.status, code: at499.code, cause: at499.cause }).toEqual({ status: 499, code: undefined, cause: undefined });
    const upstream = new HttpError(500, "broke", "EDGE_5XX");
    const at500 = mdRefusalOf(asked, upstream) as HttpError;
    expect({ status: at500.status, code: at500.code }).toEqual({ status: 500, code: "INTERNAL" });
    expect(at500.cause).toBe(upstream);
  });
  it("an engine error is put in md_ words by its ENGINE_HTTP status: STAGE_NOT_READY is MD_STALE (review M-b)", () => {
    const out = mdRefusalOf(asked, new EngineError("STAGE_NOT_READY", "round in play")) as HttpError;
    expect(out).toBeInstanceOf(HttpError);
    expect({ status: out.status, code: out.code }).toEqual({ status: 409, code: "MD_STALE" });
  });
  it("SCHEDULE_LOCKED raised at 409 (the plan gates') is still MD_NO_APPROVE, 403, not MD_STALE (review M-b)", () => {
    const out = mdRefusalOf(asked, new HttpError(409, "locked", "SCHEDULE_LOCKED")) as HttpError;
    expect({ status: out.status, code: out.code }).toEqual({ status: 403, code: "MD_NO_APPROVE" });
  });
  it("a fault's warning carries ids only", () => {
    const warn = vi.spyOn(log, "warn");
    try {
      mdRefusalOf(asked, new HttpError(503, "upstream down", "SOMETHING_UPSTREAM"));
      expect(warn.mock.calls.at(-1)![0]).toEqual({ ...asked, upstream: "SOMETHING_UPSTREAM", status: 503 });
    } finally {
      warn.mockRestore();
    }
  });
});
