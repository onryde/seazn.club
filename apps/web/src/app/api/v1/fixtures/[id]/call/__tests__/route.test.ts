// Match Day A1 — POST/DELETE /api/v1/fixtures/{id}/call and POST …/call/preview over HTTP: the real handlers, a real API key,
// the v1 envelope. What the usecase suite cannot see: that each refusal reaches the WIRE as a 409 with its details as fields
// of `error` (the envelope drops an error's data unless something forwards it), that a bad body is a 400, and that each answer
// parses with the schema the OpenAPI document publishes for it.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { FixtureCallPreview, FixtureCallUndone, FixtureCalled } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { between, callRows, person, place, seedCompetition, slotOf, type Day, seedDay } from "@/server/usecases/__tests__/_match-day-seed";
import { DELETE as undoRoute, POST as callRoute } from "@/app/api/v1/fixtures/[id]/call/route";
import { POST as previewRoute } from "@/app/api/v1/fixtures/[id]/call/preview/route";

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

describe.skipIf(!HAS_DB)("/api/v1/fixtures/{id}/call", () => {
  let day: Day;
  let secret: string;

  const req = (method: string, path: string, body?: unknown) =>
    new Request(`https://test.local/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Envelope });

  beforeAll(async () => {
    day = await seedDay();
    // `pro` carries api.access but not api.write; a manage key needs it.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${day.orgId}, 'api.write', true, 'test')
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(day.orgId);
    secret = (await createApiKey(day.auth, { name: "match day call route", scopes: ["manage"] })).secret;
  });

  it("call → 200; a second match onto the same court → 409 COURT_BUSY with its details on the wire; preview elsewhere → 200; undo → 200; undo again → 409 NOT_CALLED", async () => {
    const [p1, p2, p3, p4] = day.comp.pairs;
    const a = between(day.comp, p1!, p2!);
    const b = between(day.comp, p3!, p4!);
    await place(day, b.id, 120, day.courts.c2);

    const called = await read(await callRoute(req("POST", `/fixtures/${a.id}/call`, { court_id: day.courts.c1 }), ctx(a.id)));
    expect(called.status).toBe(200);
    expect(called.body.ok).toBe(true);
    const calledData = FixtureCalled.parse(called.body.data);
    expect(calledData).toMatchObject({ fixture_id: a.id, court_id: day.courts.c1 });
    expect(await slotOf(a.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: calledData.called_at });

    const busy = await read(await callRoute(req("POST", `/fixtures/${b.id}/call`, { court_id: day.courts.c1 }), ctx(b.id)));
    expect(busy.status).toBe(409);
    expect(busy.body.ok).toBe(false);
    expect(busy.body.error).toEqual({
      code: "COURT_BUSY",
      message: expect.any(String),
      court_name: "Court 1",
      competition_name: day.comp.name,
    });
    expect(await callRows(b.id)).toEqual([]);

    const preview = await read(
      await previewRoute(req("POST", `/fixtures/${b.id}/call/preview`, { court_id: day.courts.c3 }), ctx(b.id)),
    );
    expect(preview.status).toBe(200);
    expect(FixtureCallPreview.parse(preview.body.data)).toEqual({ shifts: [], warnings: [] });
    expect(await callRows(b.id)).toEqual([]);

    const undone = await read(await undoRoute(req("DELETE", `/fixtures/${a.id}/call`), ctx(a.id)));
    expect(undone.status).toBe(200);
    expect(FixtureCallUndone.parse(undone.body.data)).toEqual({ fixture_id: a.id, court_id: null, scheduled_at: null });

    const again = await read(await undoRoute(req("DELETE", `/fixtures/${a.id}/call`), ctx(a.id)));
    expect(again.status).toBe(409);
    expect(again.body.error).toEqual({ code: "NOT_CALLED", message: expect.any(String) });
  });

  it("PLAYER_BUSY and NOT_CALLABLE reach the wire with their details", async () => {
    const [p1, , p3, p4] = day.comp.pairs;
    const onCourt = between(day.comp, p1!, p4!);
    await place(day, onCourt.id, 0, day.courts.c2);
    await sql`update fixtures set status = 'in_play' where id = ${onCourt.id}`;
    const f = between(day.comp, p1!, p3!); // Ann & Bob again, while they play on Court 2

    const player = await read(await callRoute(req("POST", `/fixtures/${f.id}/call`, { court_id: day.courts.c3 }), ctx(f.id)));
    expect(player.status).toBe(409);
    expect(player.body.error).toEqual({
      code: "PLAYER_BUSY",
      message: expect.any(String),
      person_name: "Ann Archer",
      court_name: "Court 2",
    });

    const started = await read(
      await callRoute(req("POST", `/fixtures/${onCourt.id}/call`, { court_id: day.courts.c3 }), ctx(onCourt.id)),
    );
    expect(started.status).toBe(409);
    expect(started.body.error).toEqual({ code: "NOT_CALLABLE", message: expect.any(String), status: "in_play" });
  });

  it("NOT_CANDIDATE_COURT (B4 fix round 1, R1) reaches the wire with the court's name, from call and preview alike, and writes nothing", async () => {
    // A division that plays on Court 1 only, in the same organisation.
    const own = await seedCompetition(
      day.auth,
      "Court One Cup",
      [
        [await person(day.orgId, "Gus Grey"), await person(day.orgId, "Hal Hart")],
        [await person(day.orgId, "Ivy Iles"), await person(day.orgId, "Jon Jay")],
      ],
      { courts: [day.courts.c1] },
    );
    const f = own.fixtures[0]!;
    let checked = 0;
    for (const [label, route] of [
      ["call", callRoute],
      ["preview", previewRoute],
    ] as const) {
      const path = label === "call" ? `/fixtures/${f.id}/call` : `/fixtures/${f.id}/call/preview`;
      const res = await read(await route(req("POST", path, { court_id: day.courts.c3 }), ctx(f.id)));
      expect(res.status, label).toBe(409);
      expect(res.body.error, label).toEqual({ code: "NOT_CANDIDATE_COURT", message: expect.any(String), court_name: "Court 3" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(await callRows(f.id)).toEqual([]);
    // Its own court takes it.
    const ok = await read(await callRoute(req("POST", `/fixtures/${f.id}/call`, { court_id: day.courts.c1 }), ctx(f.id)));
    expect(ok.status, JSON.stringify(ok.body.error)).toBe(200);
  });

  it("a body without a court id, or with a key the schema does not know, is a 400 and writes nothing", async () => {
    const [, p2, p3] = day.comp.pairs;
    const f = between(day.comp, p2!, p3!);
    const before = await slotOf(f.id);
    for (const body of [{}, { court_id: "not-a-uuid" }, { court_id: day.courts.c3, scheduled_at: "2026-11-07T10:00:00Z" }]) {
      const res = await read(await callRoute(req("POST", `/fixtures/${f.id}/call`, body), ctx(f.id)));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error?.code, JSON.stringify(body)).toBe("VALIDATION");
    }
    expect(await slotOf(f.id)).toEqual(before);
    expect(await callRows(f.id)).toEqual([]);
  });
});
