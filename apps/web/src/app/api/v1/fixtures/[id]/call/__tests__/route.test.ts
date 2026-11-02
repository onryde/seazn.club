// Match Day A1 — POST/DELETE /api/v1/fixtures/{id}/call and POST …/call/preview over HTTP: the real handlers, a real API key,
// the v1 envelope. What the usecase suite cannot see: that each refusal reaches the WIRE as a 409 with its details as fields
// of `error` (the envelope drops an error's data unless something forwards it), that a bad body is a 400, and that each answer
// parses with the schema the OpenAPI document publishes for it.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { FixtureCallPreview, FixtureCallUndone, FixtureCalled } from "@/server/api-v1/schemas";
import { ROUTES } from "@/server/api-v1/openapi";
import { createApiKey } from "@/server/usecases/api-keys";
import { at, between, callRows, person, place, seedCompetition, slotOf, type Day, seedDay } from "@/server/usecases/__tests__/_match-day-seed";
import { msgFor } from "@/lib/messages-i18n";
import { DELETE as undoRoute, POST as callRoute } from "@/app/api/v1/fixtures/[id]/call/route";
import { POST as previewRoute } from "@/app/api/v1/fixtures/[id]/call/preview/route";

const HAS_DB = !!process.env.DATABASE_URL;

// The preview names each pushed match's round in the reader's language, read from the `seazn_locale` cookie (E2 item 7): the one
// test that needs a language sets it here; everything else reads no cookie, as an API-key caller does.
const reader = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "seazn_locale" && reader.locale ? { name, value: reader.locale } : undefined) }),
  headers: async () => new Headers(),
}));

afterEach(() => {
  reader.locale = undefined;
  vi.useRealTimers();
});

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

  it("G4: an unknown fixture id is a 404 on all three doors - and the OpenAPI table lists the status each door really answers", async () => {
    const id = "00000000-0000-4000-8000-000000000404";
    const doors: Array<[string, string, () => Promise<Response>]> = [
      ["post", "/fixtures/{id}/call", () => callRoute(req("POST", `/fixtures/${id}/call`, { court_id: day.courts.c1 }), ctx(id))],
      ["delete", "/fixtures/{id}/call", () => undoRoute(req("DELETE", `/fixtures/${id}/call`), ctx(id))],
      ["post", "/fixtures/{id}/call/preview", () => previewRoute(req("POST", `/fixtures/${id}/call/preview`, { court_id: day.courts.c1 }), ctx(id))],
    ];
    let checked = 0;
    for (const [method, path, run] of doors) {
      const res = await read(await run());
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.ok, `${method} ${path}`).toBe(false);
      const route = ROUTES.find((r) => r.method === method && r.path === path);
      expect(route, `${method} ${path} is in the OpenAPI table`).toBeDefined();
      // The wire's own answer is what the table has to list (not a number typed here).
      expect(route!.errors, `${method} ${path}`).toContain(res.status);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the preview's pushed matches carry the round in the reader's language: the seazn_locale cookie reaches the answer (E2 item 7)", async () => {
    const [p1, p2, p3, p4] = day.comp.pairs;
    const called = between(day.comp, p1!, p2!);
    const pushed = between(day.comp, p3!, p4!);
    // The pushed league match is planned at +45 on Court 2; calling another match there at +31 runs it to +61, past its plan.
    await place(day, pushed.id, 45, day.courts.c2);
    const [{ round_no }] = await sql<{ round_no: number }[]>`select round_no from fixtures where id = ${pushed.id}`;
    // `new Date()` is what the route calls with; only Date is faked (no timers), so the database client is untouched.
    vi.setSystemTime(at(31));
    const askedIn = async (locale: string | undefined) => {
      reader.locale = locale;
      const res = await read(await previewRoute(req("POST", `/fixtures/${called.id}/call/preview`, { court_id: day.courts.c2 }), ctx(called.id)));
      expect(res.status, String(locale)).toBe(200);
      const shifts = FixtureCallPreview.parse(res.body.data).shifts;
      expect(shifts.map((x) => x.fixture_id), `${locale}: the pushed match`).toEqual([pushed.id]);
      return shifts[0]!.round;
    };
    const en = await askedIn(undefined);
    const fr = await askedIn("fr");
    const nl = await askedIn("nl");
    expect(en).toEqual({ code: `R${round_no}`, label: msgFor("en", "schedule.round", { n: round_no }), coded: false });
    expect(fr.label).toBe(msgFor("fr", "schedule.round", { n: round_no }));
    expect(nl.label).toBe(msgFor("nl", "schedule.round", { n: round_no }));
    // The three languages differ, so the cookie is what moved the label (not a constant).
    expect(new Set([en.label, fr.label, nl.label]).size).toBe(3);
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

// G4: the same table check with no database, so it runs on every machine. The three doors share one set of refusals, and a
// door that forgets one documents less than it raises. 402 = the competition is read-only (F1), 404 = no such fixture (the auth
// wrapper), 409 = the hard stops and NOT_CALLED. Typed from the three doors' behaviour above, not read from the table.
describe("OpenAPI: the three call doors list the same refusals", () => {
  it("POST call, DELETE call and POST preview each list 402, 404 and 409 (count reported)", () => {
    const doors = [
      ["post", "/fixtures/{id}/call"],
      ["delete", "/fixtures/{id}/call"],
      ["post", "/fixtures/{id}/call/preview"],
    ] as const;
    let checked = 0;
    for (const [method, path] of doors) {
      const route = ROUTES.find((r) => r.method === method && r.path === path);
      expect(route, `${method} ${path} is in the OpenAPI table`).toBeDefined();
      expect([...(route!.errors ?? [])].sort(), `${method} ${path}`).toEqual([402, 404, 409]);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
