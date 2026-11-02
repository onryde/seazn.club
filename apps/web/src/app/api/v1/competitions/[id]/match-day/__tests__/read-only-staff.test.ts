// Match Day B4 (owner ruling Q1b, 2026-10-31): an org member who may VIEW the competition opens Match Day read-only. The page
// hides Call, Undo and the scorer QR from a viewer; this file proves the SERVER refuses them too, so hiding a button is never the
// only guard. Driven through the REAL handlers over a real session (`requireResourceAuth` unmocked; only the cookie door is faked
// one layer down — the stream-code routes test's pattern), against a real board:
//   - a VIEWER reads Match Day and a free court's candidates (200: the read-only page's own reads);
//   - a VIEWER is refused 403 by the DOOR on call, undo, the call's preview, and the scorer link's mint and read — and nothing
//     is written;
//   - an ADMIN of the same org is admitted on every one (the positive pair: the refusal is the role, not the request).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing on these doors reads the sport — they read the caller's role.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomInt } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { MatchDayView } from "@/server/api-v1/schemas";
import { callFixtureToCourt } from "@/server/usecases/match-day-call";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { between, callRows, place, seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { GET as matchDayRoute } from "../route";
import { GET as candidatesRoute } from "../candidates/route";
import { DELETE as undoRoute, POST as callRoute } from "@/app/api/v1/fixtures/[id]/call/route";
import { POST as previewRoute } from "@/app/api/v1/fixtures/[id]/call/preview/route";
import { GET as linkGetRoute, POST as linkMintRoute } from "@/app/api/v1/fixtures/[id]/device-links/route";

// Every device-link mint seals: a throwaway key of this file's own (CI's unit job has none). Never printed.
vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;
const BASE = "https://test.local/api/v1";
// A documentation-range address of this run's own, so the per-IP mint bucket is never another suite's.
const IP = `198.51.100.${randomInt(1, 254)}`;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Envelope });
const request = (method: string, path: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { "x-forwarded-for": IP, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}

describe.skipIf(!HAS_DB)("Match Day for read-only staff (B4, Q1b): the write doors refuse a viewer; an admin passes", () => {
  let day: Day;
  let viewer: string;
  let admin: string;
  /** Free on Court 1's list: called by the doors under test. */
  let toCall: string;
  /** Called onto Court 2 by the owner: undone by the doors under test. */
  let called: string;

  beforeAll(async () => {
    day = await seedDay();
    viewer = await member(day.orgId, "viewer");
    admin = await member(day.orgId, "admin");
    const [p1, p2, p3, p4] = day.comp.pairs;
    toCall = between(day.comp, p1!, p2!).id;
    called = between(day.comp, p3!, p4!).id;
    // The routes read the real clock: both planned at the real now, so they are today's whatever the hour.
    const nowMin = (Date.now() - Date.parse("2026-11-07T10:00:00.000Z")) / 60_000;
    await place(day, toCall, nowMin, null);
    await place(day, called, nowMin, null);
    await callFixtureToCourt(day.auth, called, day.courts.c2);
  });

  const writes = (): [string, () => Promise<Response>][] => [
    ["preview", () => previewRoute(request("POST", `/fixtures/${toCall}/call/preview`, { court_id: day.courts.c1 }), ctx(toCall))],
    ["call", () => callRoute(request("POST", `/fixtures/${toCall}/call`, { court_id: day.courts.c1 }), ctx(toCall))],
    ["undo", () => undoRoute(request("DELETE", `/fixtures/${called}/call`), ctx(called))],
    ["scorer link: mint", () => linkMintRoute(request("POST", `/fixtures/${called}/device-links`, {}), ctx(called))],
    ["scorer link: read", () => linkGetRoute(request("GET", `/fixtures/${called}/device-links`), ctx(called))],
  ];

  it("a VIEWER reads Match Day and a free court's candidates — the read-only page's own reads", async () => {
    authState.userId = viewer;
    const view = await read(await matchDayRoute(request("GET", `/competitions/${day.comp.id}/match-day`), ctx(day.comp.id)));
    expect(view.status).toBe(200);
    const parsed = MatchDayView.parse(view.body.data);
    expect(parsed.courts.find((c) => c.court_id === day.courts.c2)?.state, "the owner's call is on the viewer's board").toBe("called");
    const candidates = await read(
      await candidatesRoute(request("GET", `/competitions/${day.comp.id}/match-day/candidates?court_id=${day.courts.c1}`), ctx(day.comp.id)),
    );
    expect(candidates.status).toBe(200);
    expect((candidates.body.data as { fixture: { id: string } }[]).map((c) => c.fixture.id)).toContain(toCall);
  });

  it("a VIEWER is refused 403 by the DOOR on the call's preview, call, undo and the scorer link's mint and read, and nothing is written; an ADMIN of the same org is admitted on each", async () => {
    const links = async () => (await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${called}`)[0]!.n;
    const before = { toCall: await callRows(toCall), called: await callRows(called), links: await links() };
    expect(before.toCall, "premise: nothing called yet").toEqual([]);
    expect(before.called, "premise: the owner's call holds").toHaveLength(1);

    authState.userId = viewer;
    let refused = 0;
    for (const [label, call] of writes()) {
      const r = await read(await call());
      expect(r.status, label).toBe(403);
      // The door's own sentence (requireOrgAuth), never a usecase refusal that happens to share the status.
      expect(r.body.error?.message, label).toBe("Insufficient permissions");
      refused++;
    }
    expect(refused, "doors refused").toBe(5);
    expect({ toCall: await callRows(toCall), called: await callRows(called), links: await links() }, "a viewer wrote nothing").toEqual(before);

    authState.userId = admin;
    const admitted: [string, number][] = [];
    for (const [label, call] of writes()) admitted.push([label, (await call()).status]);
    expect(admitted).toEqual([
      ["preview", 200],
      ["call", 200],
      ["undo", 200],
      ["scorer link: mint", 201],
      ["scorer link: read", 200],
    ]);
    expect(await callRows(toCall), "the admin's call landed").toHaveLength(1);
    expect(await callRows(called), "the admin's undo landed").toEqual([]);
    expect(await links(), "the admin's link was minted").toBe(1);
  });
});
