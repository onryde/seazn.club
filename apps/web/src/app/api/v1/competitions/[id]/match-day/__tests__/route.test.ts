// Match Day A2 — GET /api/v1/competitions/{id}/match-day and GET …/match-day/candidates?court_id= over HTTP: the real
// handlers, a real read-scope API key, the v1 envelope. What the usecase suite cannot see: that each answer parses with the
// schema the OpenAPI document publishes for it, that a missing or malformed `court_id` is a 400, and that a court that is not
// the org's is a 404 on the wire.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { VENUE_NOUNS } from "@/lib/venue";
import { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayOnlineRound, MatchDayView } from "@/server/api-v1/schemas";
import { SCORER_ATTENTIONS } from "@/lib/match-day/types";
import { createApiKey } from "@/server/usecases/api-keys";
import { T0, between, place, seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { addRound, bridgeRow, openStamp, seedOnlineDivisionIn } from "@/server/usecases/__tests__/_match-day-online-seed";
import { getMatchDay } from "@/server/usecases/match-day";
import { GET as matchDayRoute } from "@/app/api/v1/competitions/[id]/match-day/route";
import { GET as candidatesRoute } from "@/app/api/v1/competitions/[id]/match-day/candidates/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Envelope = { ok: boolean; data?: unknown; error?: Record<string, unknown> & { code?: string; message?: string } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

it("the published court-noun enum is lib/venue.ts's VENUE_NOUNS", () => {
  expect(MatchDayCourt.shape.sport_noun.options).toEqual([...VENUE_NOUNS]);
});

it("A4 — the published scorer-attention enum is lib/match-day/types.ts's SCORER_ATTENTIONS (the desk's own kinds)", () => {
  expect(MatchDayFixture.shape.scorer_attention.unwrap().options).toEqual([...SCORER_ATTENTIONS]);
});

describe.skipIf(!HAS_DB)("/api/v1/competitions/{id}/match-day", () => {
  let day: Day;
  let secret: string;
  const get = (path: string) =>
    new Request(`https://test.local/api/v1${path}`, { method: "GET", headers: { authorization: `Bearer ${secret}` } });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Envelope });

  beforeAll(async () => {
    day = await seedDay();
    secret = (await createApiKey(day.auth, { name: "match day read route", scopes: ["read"] })).secret;
    const [p1, p2] = day.comp.pairs;
    // The routes read the real clock. Planned at the real now, on Court 2: today's one match whatever the hour, and Court 3's
    // other-court candidate.
    await place(day, between(day.comp, p1!, p2!).id, (Date.now() - Date.parse(T0)) / 60_000, day.courts.c2);
  });

  it("GET match-day → 200 with the published view: the division's three courts, one match today", async () => {
    const res = await read(await matchDayRoute(get(`/competitions/${day.comp.id}/match-day`), ctx(day.comp.id)));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const view = MatchDayView.parse(res.body.data);
    expect(view.competition_id).toBe(day.comp.id);
    expect(view.courts.map((c) => c.court_id)).toEqual([day.courts.c1, day.courts.c2, day.courts.c3]);
    expect(view.fixtures_today).toBe(1);
    // Every key the answer carries for a match is one the published schema declares: zod strips an undeclared key on parse, so
    // a field the read model gains (Match Day C2's `format_line`) without a schema line is served but missing from the API docs.
    const declared = new Set([...Object.keys(MatchDayFixture.shape), "planned_at", "estimated_at"]);
    type Raw = Record<string, unknown>;
    const raw = res.body.data as { courts: { current: Raw | null; queue: Raw[] }[]; playing_no_court: Raw[] };
    const matches = [...raw.courts.flatMap((c) => [...(c.current === null ? [] : [c.current]), ...c.queue]), ...raw.playing_no_court];
    expect(matches.length, "matches checked").toBeGreaterThan(0);
    for (const m of matches) expect(Object.keys(m).filter((k) => !declared.has(k))).toEqual([]);
  });

  it("GET candidates → 200 with the published list; no court_id or a malformed one → 400; a court not the org's → 404", async () => {
    const ok = await read(
      await candidatesRoute(get(`/competitions/${day.comp.id}/match-day/candidates?court_id=${day.courts.c3}`), ctx(day.comp.id)),
    );
    expect(ok.status).toBe(200);
    const list = z.array(MatchDayCandidate).parse(ok.body.data);
    // Court 2's planned match, and the five ready matches with no court.
    expect(list.map((c) => c.source)).toEqual(["other_court", ...Array(5).fill("no_court")]);

    let checked = 0;
    for (const [query, status] of [
      ["", 400],
      ["?court_id=not-a-uuid", 400],
      ["?court_id=00000000-0000-4000-8000-000000000000", 404],
    ] as const) {
      const res = await read(
        await candidatesRoute(get(`/competitions/${day.comp.id}/match-day/candidates${query}`), ctx(day.comp.id)),
      );
      expect(res.status, query).toBe(status);
      expect(res.body.ok, query).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// Match Day online (Task 2): the poll answers `online_rounds`, and the published schema declares it. `MatchDayView` is a plain z.object, so a
// parse STRIPS a key it does not name: an `online_rounds` the schema forgot would be served by the usecase and gone from the wire.
describe.skipIf(!HAS_DB)("/api/v1/competitions/{id}/match-day - online_rounds", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a seeded online round: online_rounds survives the parse with the usecase's rows, every key of a row is declared, and a held board of an earlier round rides needs_decision", async () => {
    vi.stubEnv("MATCH_DAY_ONLINE", "1");
    const day = await seedDay();
    const online = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Rapid", fixtures: 1 });
    const minutes = (m: number): Date => new Date(Date.now() + m * 60_000);
    const owner = { stageId: online.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! };
    // Round 1 opened 90 minutes ago with a board held for the organiser; round 2 opened five minutes ago: round 1's held board rides needs_decision.
    await openStamp(owner, 1, minutes(-90));
    await bridgeRow(online.boards[0]!.fixtureId, day.orgId, { status: "needs_organiser", reason: "no_show_white" });
    const [r2] = await addRound({ stageId: online.stageId, divisionId: online.divisionId, orgId: day.orgId }, 2, [online.boards[0]!]);
    await openStamp(owner, 2, minutes(-5));
    const secret = (await createApiKey(day.auth, { name: "match day online route", scopes: ["read"] })).secret;

    const res = await matchDayRoute(
      new Request(`https://test.local/api/v1/competitions/${day.comp.id}/match-day`, { headers: { authorization: `Bearer ${secret}` } }),
      ctx(day.comp.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const parsed = MatchDayView.parse(body.data);
    const usecase = (await getMatchDay(day.auth, day.comp.id)).online_rounds;

    expect(usecase.length, "anti-vacuity: the usecase read the round").toBeGreaterThan(0);
    expect(parsed.online_rounds.length, "the parse kept every row").toBe(usecase.length);
    expect(parsed.online_rounds.map((r) => r.key)).toEqual(usecase.map((r) => r.key));
    expect(parsed.online_rounds[0]).toMatchObject({ key: expect.stringMatching(/:2$/), round_no: 2, phase: "checkin", offered: true });
    // Every key the answer carries for a round is one the published schema declares (zod would strip a stray one silently).
    const declared = new Set(Object.keys(MatchDayOnlineRound.shape));
    const raw = (body.data as { online_rounds: Record<string, unknown>[] }).online_rounds;
    expect(raw.length, "rows checked").toBeGreaterThan(0);
    for (const row of raw) expect(Object.keys(row).filter((k) => !declared.has(k))).toEqual([]);
    // The documented-object fields keep their contents (passthrough): the round's boards and the held board with its reason.
    const decision = parsed.online_rounds[0]!.needs_decision as { fixtureId: string; round_no: number; hold_reason?: string }[];
    expect(decision.map((b) => b.fixtureId)).toEqual([online.boards[0]!.fixtureId]);
    expect(decision[0]).toMatchObject({ round_no: 1, hold_reason: "no_show_white" });
    expect((parsed.online_rounds[0]!.round as { boards: { fixtureId: string }[] }).boards.map((b) => b.fixtureId)).toEqual([r2]);
  });

  it("the flag off: online_rounds is [] on the wire, and a view without a seeded online division is unchanged", async () => {
    const day = await seedDay();
    const secret = (await createApiKey(day.auth, { name: "match day online off", scopes: ["read"] })).secret;
    const res = await matchDayRoute(
      new Request(`https://test.local/api/v1/competitions/${day.comp.id}/match-day`, { headers: { authorization: `Bearer ${secret}` } }),
      ctx(day.comp.id),
    );
    const body = (await res.json()) as Envelope;
    expect(MatchDayView.parse(body.data).online_rounds).toEqual([]);
    expect((body.data as { online_rounds: unknown }).online_rounds, "present on the wire, not absent").toEqual([]);
  });
});
