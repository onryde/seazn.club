// Calling a match to a court through a Match Day code (Task 8e; owner 2026-11-13): the "Call matches to courts" power, the
// code's scope on the court AND the match, the preview that writes nothing, the call the desk's board then shows, its Undo,
// the desk's hard stops in the call contract's words, the call logged against the code, and the routes
// (`GET /match-day-code/courts/{courtId}/candidates`, `POST|DELETE /match-day-code/fixtures/{id}/call`) against their twins.
// Real Postgres required; skipped without DATABASE_URL.
//
// The board (seed: four pairs, Ann & Bob / Cat & Dan / Eve & Fay / Gus & Hal; times are minutes after T0, 11:00 in Amsterdam):
//   A = Ann&Bob v Cat&Dan  on Court 1 (Hall A) at +60      D = Cat&Dan v Gus&Hal  on Court 1 at +120
//   B = Eve&Fay v Gus&Hal  on Court 3 (Hall B) at +90      E = Ann&Bob v Gus&Hal  on Court 2 (Hall A) at +30
//   C = Ann&Bob v Eve&Fay  no court, ready                F = Cat&Dan v Eve&Fay  on Court 3 at +150
// Every match plays 30 minutes (the seed's `matchMinutes`).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  CaptureMatchdayCallOk,
  CaptureMatchdayCallPreview,
  CaptureMatchdayCallRefusal,
  CaptureMatchdayCandidates,
  CaptureMatchdayUndoOk,
} from "@/server/api-v1/capture-schemas";
import { getMatchDay } from "../match-day";
import { mintMatchDayCode, revokeMatchDayCode, type MatchDayCodeRow, type MatchDayScope } from "../match-day-codes";
import {
  callForCode,
  candidatesForCode,
  mdCallRefusalOf,
  previewCallForCode,
  undoCallForCode,
} from "../match-day-code-call";
import { getMatchDayForCode } from "../match-day-code-view";
import { at, between, iso, ledgerOf, person, place, seedCompetition, seedDay, setStatus, slotOf, T0, type Day } from "./_match-day-seed";
import { GET as CANDIDATES } from "@/app/api/v1/match-day-code/courts/[courtId]/candidates/route";
import { DELETE as UNDO, POST as CALL } from "@/app/api/v1/match-day-code/fixtures/[id]/call/route";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;
const NOW = at(10);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A code minted on the seed's day (2026-11-07), with or without the power to call. */
async function codeFor(day: Day, scope: MatchDayScope, canCall: boolean): Promise<{ code: MatchDayCodeRow; token: string }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
  try {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope, day: "2026-11-07", canApprove: false, canCall });
    return { code: row, token: url.slice(url.lastIndexOf("/") + 1) };
  } finally {
    vi.useRealTimers();
  }
}

/** The refusal `run` throws: its status, its word and its extras. Fails the test if it does not throw an HttpError. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ status: number; code: string | undefined; extra: unknown }> {
  try {
    await run();
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code, extra: e.extra };
    throw e;
  }
  throw new Error("expected a refusal, and the call answered");
}

type Called = { called_by: string | null; called_by_code: string | null; court_id: string; called_at: Date };
const callsOf = (fixtureId: string): Promise<Called[]> =>
  sql<Called[]>`select called_by, called_by_code, court_id, called_at from fixture_calls where fixture_id = ${fixtureId}`;
const usesOf = (codeId: string): Promise<{ kind: string; fixture_id: string | null }[]> =>
  sql`select kind, fixture_id from match_day_code_uses where code_id = ${codeId} order by id`;

describe.skipIf(!HAS_DB)("calling a match to a court through a Match Day code (Task 8e)", () => {
  let day: Day;
  let A: string, B: string, C: string, D: string, E: string, F: string;
  beforeEach(async () => {
    day = await seedDay();
    const [p1, p2, p3, p4] = day.comp.pairs;
    A = between(day.comp, p1!, p2!).id;
    B = between(day.comp, p3!, p4!).id;
    C = between(day.comp, p1!, p3!).id;
    D = between(day.comp, p2!, p4!).id;
    E = between(day.comp, p1!, p4!).id;
    F = between(day.comp, p2!, p3!).id;
    const { c1, c2, c3 } = day.courts;
    await place(day, A, 60, c1);
    await place(day, B, 90, c3);
    await place(day, C, null, null);
    await place(day, D, 120, c1);
    await place(day, E, 30, c2);
    await place(day, F, 150, c3);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the power: \"Call matches to courts\"", () => {
    it("a code without it is MD_NO_CALL on the preview, the call and the Undo, writes nothing, and still reads the candidates", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, false);
      const before = await slotOf(A);
      for (const run of [
        () => previewCallForCode(code, A, day.courts.c2, NOW),
        () => callForCode(code, A, day.courts.c2, NOW),
        () => undoCallForCode(code, A),
      ]) {
        expect(await refusalOf(run)).toMatchObject({ status: 403, code: "MD_NO_CALL" });
      }
      expect(await slotOf(A)).toEqual(before);
      expect(await callsOf(A)).toEqual([]);
      expect(await usesOf(code.id)).toEqual([]);
      const offered = await candidatesForCode(code, day.courts.c2, NOW);
      expect(offered.candidates.map((c) => c.match.fixture_id).sort()).toEqual([A, B, C, E].sort());
    });

    it("the day read says whether the code may call", async () => {
      const off = (await codeFor(day, { kind: "competition" }, false)).code;
      const on = (await codeFor(day, { kind: "competition" }, true)).code;
      expect((await getMatchDayForCode(off, NOW)).can_call).toBe(false);
      expect((await getMatchDayForCode(on, NOW)).can_call).toBe(true);
    });
  });

  describe("scope: the court and the match, each", () => {
    it("a courts code: a court off its list is MD_OUT_OF_SCOPE, and so is a match on a court off its list; nothing is written", async () => {
      const { code } = await codeFor(day, { kind: "courts", courtIds: [day.courts.c1, day.courts.c2] }, true);
      const [a, b] = [await slotOf(A), await slotOf(B)];
      // A is in scope (Court 1); Court 3 is not.
      expect(await refusalOf(() => callForCode(code, A, day.courts.c3, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await refusalOf(() => previewCallForCode(code, A, day.courts.c3, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      // B is on Court 3, off the list; Court 2 is on it.
      expect(await refusalOf(() => callForCode(code, B, day.courts.c2, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await refusalOf(() => previewCallForCode(code, B, day.courts.c2, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect([await slotOf(A), await slotOf(B)]).toEqual([a, b]);
      expect([...(await callsOf(A)), ...(await callsOf(B))]).toEqual([]);
      // The candidates: Court 3 is not its to ask about, and Court 2's list never offers B (Court 3) or C (no court).
      expect(await refusalOf(() => candidatesForCode(code, day.courts.c3, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      const offered = await candidatesForCode(code, day.courts.c2, NOW);
      expect(offered.candidates.map((c) => [c.match.fixture_id, c.source]).sort()).toEqual(
        [[E, "this_court"], [A, "other_court"]].sort(),
      );
    });

    it("a venue code: a no-court match is MD_OUT_OF_SCOPE, another venue's court too; a whole-competition code reaches both", async () => {
      const venue = (await codeFor(day, { kind: "venue", venueId: day.venues.hallA }, true)).code;
      expect(await refusalOf(() => callForCode(venue, C, day.courts.c2, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await refusalOf(() => callForCode(venue, A, day.courts.c3, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await slotOf(C)).toMatchObject({ court_id: null, scheduled_at: null });
      const whole = (await codeFor(day, { kind: "competition" }, true)).code;
      const offered = await candidatesForCode(whole, day.courts.c3, NOW);
      expect(offered.candidates.find((c) => c.match.fixture_id === C)).toMatchObject({ source: "no_court", planned_at: null });
      expect(await callForCode(whole, C, day.courts.c3, NOW)).toEqual({ fixture_id: C, court_id: day.courts.c3, called_at: NOW.toISOString() });
    });

    it("another competition's match is MD_OUT_OF_SCOPE; an unknown court or match is not found", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      expect(await refusalOf(() => callForCode(code, A, randomUUID(), NOW))).toMatchObject({ status: 404 });
      expect(await refusalOf(() => callForCode(code, randomUUID(), day.courts.c2, NOW))).toMatchObject({ status: 404 });
      expect(await refusalOf(() => candidatesForCode(code, randomUUID(), NOW))).toMatchObject({ status: 404 });
      // A second competition of the same organisation, its match planned on Court 2 today: not this code's.
      const people = [await person(day.orgId, "Ivy Ives"), await person(day.orgId, "Jay Jones")];
      const other = await seedCompetition(day.auth, "Other Cup", people.map((p) => [p]), { courts: [day.courts.c1, day.courts.c2] });
      const theirs = other.fixtures[0]!.id;
      await place(day, theirs, 45, day.courts.c2);
      expect(await refusalOf(() => callForCode(code, theirs, day.courts.c1, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await refusalOf(() => previewCallForCode(code, theirs, day.courts.c1, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
      expect(await slotOf(theirs)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(45) });
      expect((await candidatesForCode(code, day.courts.c1, NOW)).candidates.map((c) => c.match.fixture_id)).not.toContain(theirs);
    });
  });

  describe("scope: the Undo, the candidates and another organisation (fix round 1)", () => {
    it("a courts code's Undo of a match called onto a court off its list is MD_OUT_OF_SCOPE, and the match stays called (I1)", async () => {
      const whole = (await codeFor(day, { kind: "competition" }, true)).code;
      const narrow = (await codeFor(day, { kind: "courts", courtIds: [day.courts.c1, day.courts.c2] }, true)).code;
      // A (planned on Court 1, in the narrow code's list) is called by a code onto Court 3, off its list.
      await callForCode(whole, A, day.courts.c3, NOW);
      expect(await refusalOf(() => undoCallForCode(narrow, A))).toEqual({ status: 403, code: "MD_OUT_OF_SCOPE", extra: undefined });
      expect(await slotOf(A)).toMatchObject({ court_id: day.courts.c3, scheduled_at: NOW.toISOString() });
      expect((await callsOf(A)).map((r) => r.called_by_code)).toEqual([whole.id]);
      expect(await usesOf(narrow.id)).toEqual([]);
    });

    it("a code never undoes the desk's call: MD_CALL_REFUSED not_code_call; another code's call it may undo", async () => {
      const { callFixtureToCourt, undoCall } = await import("../match-day-call");
      const { code } = await codeFor(day, { kind: "competition" }, true);
      await callFixtureToCourt(day.auth, A, day.courts.c2, NOW);
      expect(await refusalOf(() => undoCallForCode(code, A))).toEqual({
        status: 409,
        code: "MD_CALL_REFUSED",
        extra: { reason: "not_code_call" },
      });
      expect(await slotOf(A)).toMatchObject({ court_id: day.courts.c2, scheduled_at: NOW.toISOString() });
      expect((await callsOf(A)).map((r) => [r.called_by, r.called_by_code])).toEqual([[day.auth.userId, null]]);
      // The desk takes its own call back; a call another code made is a code's call, so this code may undo it.
      await undoCall(day.auth, A);
      const other = (await codeFor(day, { kind: "competition" }, true)).code;
      await callForCode(other, A, day.courts.c2, NOW);
      expect(await undoCallForCode(code, A)).toEqual({ fixture_id: A, court_id: day.courts.c1, scheduled_at: iso(60) });
    });

    it("Undo puts back the slot even on a court outside the code's scope (the controller's ruling)", async () => {
      const whole = (await codeFor(day, { kind: "competition" }, true)).code;
      const hallA = (await codeFor(day, { kind: "venue", venueId: day.venues.hallA }, true)).code;
      // B, planned on Court 3 (Hall B), is called onto Court 2 (Hall A): the Hall A code's Undo sends it back to Hall B.
      await callForCode(whole, B, day.courts.c2, NOW);
      expect(await undoCallForCode(hallA, B)).toEqual({ fixture_id: B, court_id: day.courts.c3, scheduled_at: iso(90) });
      expect(await slotOf(B)).toEqual({ court_id: day.courts.c3, venue_id: day.venues.hallB, scheduled_at: iso(90), status: "scheduled" });
    });

    it("a venue code's candidates never offer another venue's match, nor a no-court one; another venue's court is MD_OUT_OF_SCOPE", async () => {
      const { code } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA }, true);
      const offered = await candidatesForCode(code, day.courts.c2, NOW);
      expect(offered.candidates.map((c) => [c.match.fixture_id, c.source, c.from_court_name]).sort()).toEqual(
        [[E, "this_court", null], [A, "other_court", "Court 1"]].sort(),
      );
      expect(await refusalOf(() => candidatesForCode(code, day.courts.c3, NOW))).toMatchObject({ status: 403, code: "MD_OUT_OF_SCOPE" });
    });

    it("a code of another organisation cannot see or touch this organisation's matches or courts: 404, nothing written", async () => {
      const elsewhere = await seedDay();
      const { code } = await codeFor(elsewhere, { kind: "competition" }, true);
      const before = await slotOf(A);
      for (const run of [
        () => candidatesForCode(code, day.courts.c2, NOW),
        () => previewCallForCode(code, A, day.courts.c2, NOW),
        () => callForCode(code, A, day.courts.c2, NOW),
        // Its own match onto this organisation's court: the court is not found.
        () => callForCode(code, elsewhere.comp.fixtures[0]!.id, day.courts.c2, NOW),
        () => undoCallForCode(code, A),
      ]) {
        expect(await refusalOf(run)).toMatchObject({ status: 404 });
      }
      expect(await slotOf(A)).toEqual(before);
      expect(await callsOf(A)).toEqual([]);
    });
  });

  describe("the preview, the call and its Undo", () => {
    it("the preview answers the desk's knock-on and writes nothing", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const slot = await slotOf(A);
      const ledger = await ledgerOf(day.comp.divisionId, A);
      // A onto Court 2 at +10 runs to +40: E, planned there at +30, now starts at +40.
      const preview = await previewCallForCode(code, A, day.courts.c2, NOW);
      expect(preview.warnings).toEqual([{ kind: "pushes_later", count: 1 }]);
      expect(preview.shifts).toHaveLength(1);
      expect(preview.shifts[0]).toMatchObject({ fixture_id: E, planned_at: iso(30), estimated_at: iso(40) });
      expect(CaptureMatchdayCallPreview.safeParse(preview).success).toBe(true);
      expect(await slotOf(A)).toEqual(slot);
      expect(await callsOf(A)).toEqual([]);
      expect(await ledgerOf(day.comp.divisionId, A)).toEqual(ledger);
      expect(await usesOf(code.id)).toEqual([]);
    });

    it("the call moves the match, the desk's board shows it called, it is logged against the code; Undo puts it back", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const got = await callForCode(code, A, day.courts.c2, NOW);
      expect(got).toEqual({ fixture_id: A, court_id: day.courts.c2, called_at: NOW.toISOString() });
      expect(await slotOf(A)).toEqual({ court_id: day.courts.c2, venue_id: day.venues.hallA, scheduled_at: NOW.toISOString(), status: "scheduled" });
      // The desk's own board, as the organiser reads it.
      const board = await getMatchDay(day.auth, day.comp.id, NOW);
      const court2 = board.courts.find((c) => c.court_id === day.courts.c2)!;
      expect([court2.state, court2.current?.id]).toEqual(["called", A]);
      // Against the code, never the code's issuer.
      expect((await callsOf(A)).map((r) => [r.called_by, r.called_by_code, r.court_id])).toEqual([[null, code.id, day.courts.c2]]);
      expect(await usesOf(code.id)).toEqual([{ kind: "call", fixture_id: A }]);

      const undone = await undoCallForCode(code, A);
      expect(undone).toEqual({ fixture_id: A, court_id: day.courts.c1, scheduled_at: iso(60) });
      expect(await slotOf(A)).toEqual({ court_id: day.courts.c1, venue_id: day.venues.hallA, scheduled_at: iso(60), status: "scheduled" });
      expect(await callsOf(A)).toEqual([]);
      expect(await usesOf(code.id)).toEqual([
        { kind: "call", fixture_id: A },
        { kind: "undo_call", fixture_id: A },
      ]);
    });

    it("a candidate waiting on another court says `called` only once its match is called there and not started (F-T8-12)", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const calledOf = async () => (await candidatesForCode(code, day.courts.c2, NOW)).candidates.find((c) => c.match.fixture_id === A);
      // A is queued next on Court 1: another court's next match, not called.
      expect(await calledOf()).toMatchObject({ source: "other_court", from_court_name: expect.any(String), called: false });
      // Called onto Court 3 and not started: the same candidate, now called there.
      await callForCode(code, A, day.courts.c3, NOW);
      expect(await calledOf()).toMatchObject({ source: "other_court", called: true });
      // The court's own next match and every other candidate stay not called, and each answer still passes the contract's twin.
      const offered = await candidatesForCode(code, day.courts.c2, NOW);
      expect(offered.candidates.filter((c) => c.source !== "other_court").map((c) => c.called)).not.toContain(true);
      expect(CaptureMatchdayCandidates.safeParse(offered).success).toBe(true);
    });

    it("a desk call still records the organiser and no code", async () => {
      const { callFixtureToCourt } = await import("../match-day-call");
      await callFixtureToCourt(day.auth, A, day.courts.c2, NOW);
      expect((await callsOf(A)).map((r) => [r.called_by, r.called_by_code])).toEqual([[day.auth.userId, null]]);
    });

    it("a busy player refuses the call with the name and the court; the candidates show the same stop", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      // E (Ann & Bob v Gus & Hal) is playing on Court 2: A has Ann & Bob too.
      await setStatus(E, "in_play");
      const r = await refusalOf(() => callForCode(code, A, day.courts.c3, NOW));
      expect(r).toEqual({
        status: 409,
        code: "MD_CALL_REFUSED",
        extra: { reason: "player_busy", person_name: "Ann Archer", court_name: "Court 2" },
      });
      expect(await callsOf(A)).toEqual([]);
      const offered = await candidatesForCode(code, day.courts.c3, NOW);
      expect(offered.candidates.find((c) => c.match.fixture_id === A)?.blocked).toEqual({
        kind: "player_busy",
        person_name: "Ann Archer",
        court_name: "Court 2",
      });
    });

    it("Undo of a match that has started is MD_CALL_REFUSED started; of one not called, not_called", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      expect(await refusalOf(() => undoCallForCode(code, A))).toMatchObject({ status: 409, code: "MD_CALL_REFUSED", extra: { reason: "not_called" } });
      await callForCode(code, A, day.courts.c2, NOW);
      await setStatus(A, "in_play");
      expect(await refusalOf(() => undoCallForCode(code, A))).toMatchObject({ status: 409, code: "MD_CALL_REFUSED", extra: { reason: "started" } });
      expect(await slotOf(A)).toMatchObject({ court_id: day.courts.c2, status: "in_play" });
    });

    it("a court the division does not play on is not_candidate_court; a court in use is court_busy", async () => {
      const { code } = await codeFor(day, { kind: "competition" }, true);
      await sql`update schedule_settings set config = jsonb_set(config, '{courts}', ${sql.json([day.courts.c1, day.courts.c2])}) where division_id = ${day.comp.divisionId}`;
      expect(await refusalOf(() => callForCode(code, C, day.courts.c3, NOW))).toEqual({
        status: 409,
        code: "MD_CALL_REFUSED",
        extra: { reason: "not_candidate_court", court_name: "Court 3" },
      });
      await callForCode(code, A, day.courts.c2, NOW);
      expect(await refusalOf(() => callForCode(code, D, day.courts.c2, NOW))).toEqual({
        status: 409,
        code: "MD_CALL_REFUSED",
        extra: { reason: "court_busy", court_name: "Court 2" },
      });
    });
  });

  describe("the desk's refusals in the call contract's words", () => {
    it("maps each desk word, the billing freeze, and leaves md_ words and not-found alone", () => {
      const asWords = (e: unknown) => {
        const r = mdCallRefusalOf(e) as HttpError;
        return [r.status, r.code, r.extra];
      };
      expect(asWords(new PaymentRequiredError("competitions.max_active"))).toEqual([409, "MD_CALL_REFUSED", { reason: "frozen" }]);
      expect(asWords(new HttpError(409, "x", "NOT_CALLABLE", { status: "tbd_entrant" }))).toEqual([409, "MD_CALL_REFUSED", { reason: "not_ready" }]);
      expect(asWords(new HttpError(409, "x", "NOT_CALLABLE", { status: "decided" }))).toEqual([409, "MD_CALL_REFUSED", { reason: "started" }]);
      expect(asWords(new HttpError(409, "x", "COURT_BUSY", { court_name: "Court 2", competition_name: "Other Cup" }))).toEqual([
        409,
        "MD_CALL_REFUSED",
        { reason: "court_busy", court_name: "Court 2" },
      ]);
      const scope = new HttpError(403, "x", "MD_OUT_OF_SCOPE");
      expect(mdCallRefusalOf(scope)).toBe(scope);
      const missing = new HttpError(404, "fixture not found");
      expect(mdCallRefusalOf(missing)).toBe(missing);
      expect(asWords(new HttpError(422, "x", "SOME_DESK_WORD"))).toEqual([422, undefined, undefined]);
    });
  });

  describe("the routes", () => {
    const bearer = (token: string | null): Record<string, string> => (token === null ? {} : { authorization: `Bearer ${token}` });
    const candidates = (token: string | null, courtId: string) =>
      CANDIDATES(new Request(`https://test.local/api/v1/match-day-code/courts/${courtId}/candidates`, { headers: bearer(token) }), {
        params: Promise.resolve({ courtId }),
      });
    const call = (token: string | null, fixtureId: string, body: unknown) =>
      CALL(
        new Request(`https://test.local/api/v1/match-day-code/fixtures/${fixtureId}/call`, {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: fixtureId }) },
      );
    const undo = (token: string | null, fixtureId: string) =>
      UNDO(new Request(`https://test.local/api/v1/match-day-code/fixtures/${fixtureId}/call`, { method: "DELETE", headers: bearer(token) }), {
        params: Promise.resolve({ id: fixtureId }),
      });

    it("answer their twins: candidates, preview, call, Undo; never the token", async () => {
      const { token } = await codeFor(day, { kind: "competition" }, true);
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const list = await candidates(token, day.courts.c2);
      expect([list.status, list.headers.get("cache-control")]).toEqual([200, "no-store"]);
      const listed = (await list.json()).data;
      expect(CaptureMatchdayCandidates.safeParse(listed).success).toBe(true);
      expect(listed.court_name).toBe("Court 2");
      const preview = await call(token, A, { court_id: day.courts.c2, preview: true });
      expect(preview.status).toBe(200);
      const previewed = (await preview.json()).data;
      expect(CaptureMatchdayCallPreview.safeParse(previewed).success).toBe(true);
      expect(await callsOf(A)).toEqual([]);
      const made = await call(token, A, { court_id: day.courts.c2, preview: false });
      expect(made.status).toBe(200);
      const called = (await made.json()).data;
      expect(CaptureMatchdayCallOk.safeParse(called).success).toBe(true);
      expect(called).toEqual({ fixture_id: A, court_id: day.courts.c2, called_at: NOW.toISOString() });
      const back = await undo(token, A);
      expect(back.status).toBe(200);
      const undone = (await back.json()).data;
      expect(CaptureMatchdayUndoOk.safeParse(undone).success).toBe(true);
      expect(undone).toEqual({ fixture_id: A, court_id: day.courts.c1, scheduled_at: iso(60) });
      const refused = await undo(token, A);
      expect(refused.status).toBe(409);
      const error = (await refused.json()).error;
      expect(CaptureMatchdayCallRefusal.safeParse(error).success).toBe(true);
      expect(error).toMatchObject({ code: "MD_CALL_REFUSED", reason: "not_called" });
      // A body that does not say whether it is the preview is refused before anything is judged.
      expect((await call(token, A, { court_id: day.courts.c2 })).status).toBe(400);
      expect(JSON.stringify([listed, previewed, called, undone, error])).not.toContain(token);
    });

    it("a code without the power: the call and the Undo are 403 MD_NO_CALL, the candidates 200", async () => {
      const { token } = await codeFor(day, { kind: "competition" }, false);
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      expect((await candidates(token, day.courts.c2)).status).toBe(200);
      for (const res of [
        await call(token, A, { court_id: day.courts.c2, preview: true }),
        await call(token, A, { court_id: day.courts.c2, preview: false }),
        await undo(token, A),
      ]) {
        expect(res.status).toBe(403);
        const error = (await res.json()).error;
        expect(error.code).toBe("MD_NO_CALL");
        expect(CaptureMatchdayCallRefusal.safeParse(error).success).toBe(true);
      }
      expect(await callsOf(A)).toEqual([]);
    });

    it("a withdrawn code refuses all three, 410 MD_WITHDRAWN; no bearer is 401", async () => {
      const { code, token } = await codeFor(day, { kind: "competition" }, true);
      await revokeMatchDayCode(day.auth, code.id);
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      for (const res of [
        await candidates(token, day.courts.c2),
        await call(token, A, { court_id: day.courts.c2, preview: true }),
        await call(token, A, { court_id: day.courts.c2, preview: false }),
        await undo(token, A),
      ]) {
        expect(res.status).toBe(410);
        expect((await res.json()).error.code).toBe("MD_WITHDRAWN");
      }
      expect((await candidates(null, day.courts.c2)).status).toBe(401);
      expect((await call(null, A, { court_id: day.courts.c2, preview: false })).status).toBe(401);
      expect((await undo(null, A)).status).toBe(401);
      expect(await callsOf(A)).toEqual([]);
    });

    it("a code before its day (403 MD_NOT_OPEN, with opens_at) and after it (410 MD_ENDED) refuses all three", async () => {
      const { token } = await codeFor(day, { kind: "competition" }, true);
      const cases: [string, number, string][] = [
        // The code's day is 2026-11-07 in Amsterdam: 2026-11-06T23:00Z to 2026-11-07T23:00Z.
        ["2026-11-06T12:00:00.000Z", 403, "MD_NOT_OPEN"],
        ["2026-11-08T12:00:00.000Z", 410, "MD_ENDED"],
      ];
      let checked = 0;
      for (const [when, status, word] of cases) {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date(when) });
        for (const res of [
          await candidates(token, day.courts.c2),
          await call(token, A, { court_id: day.courts.c2, preview: true }),
          await call(token, A, { court_id: day.courts.c2, preview: false }),
          await undo(token, A),
        ]) {
          expect([res.status, when]).toEqual([status, when]);
          const error = (await res.json()).error;
          expect(error.code).toBe(word);
          if (word === "MD_NOT_OPEN") expect(error.opens_at).toBe("2026-11-06T23:00:00.000Z");
          expect(CaptureMatchdayCallRefusal.safeParse(error).success).toBe(true);
          checked++;
        }
        vi.useRealTimers();
      }
      expect(checked).toBe(8);
      expect(await callsOf(A)).toEqual([]);
    });
  });
});
