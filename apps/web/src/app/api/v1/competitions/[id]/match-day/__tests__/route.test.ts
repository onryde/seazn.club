// Match Day A2 — GET /api/v1/competitions/{id}/match-day and GET …/match-day/candidates?court_id= over HTTP: the real
// handlers, a real read-scope API key, the v1 envelope. What the usecase suite cannot see: that each answer parses with the
// schema the OpenAPI document publishes for it, that a missing or malformed `court_id` is a 400, and that a court that is not
// the org's is a 404 on the wire.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { VENUE_NOUNS } from "@/lib/venue";
import { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayView } from "@/server/api-v1/schemas";
import { SCORER_ATTENTIONS } from "@/lib/match-day/types";
import { createApiKey } from "@/server/usecases/api-keys";
import { T0, between, place, seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
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
