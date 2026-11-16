// Court stream, the desk's side (spec 2026-11-14 §5; plan Task 3): link a court to a connected YouTube channel for a day,
// list the live links, withdraw one. Real Postgres required; skipped without DATABASE_URL. The rules under test are the
// brief's, typed here, never read back from the module: the QR's `exp` is 24:00 of the day in the competition's zone
// (Europe/Amsterdam, UTC+1 in November), a pasted key is no destination, the court's day holds one destination, and the
// tok is sealed before any write and never logged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
// Pass-through spy on the sealed-column writer: "sealed BEFORE any write" is observable only as "no writer was called".
vi.mock("@/server/relay/secret-columns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/relay/secret-columns")>();
  return { ...actual, insertCourtStreamCode: vi.fn(actual.insertCourtStreamCode) };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { insertCourtStreamCode, openStreamCodeTok } from "@/server/relay/secret-columns";
import { rigApiTarget, rigTarget } from "@/server/relay/__tests__/_session-rig";
import type { AuthCtx } from "@/server/api-v1/auth";
import { linkCourtStream, listCourtStreams, withdrawCourtStream } from "../court-streams";
import { at, seedDay, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const savedKek = process.env.RELAY_KEK;
const savedMin = process.env.COURT_MIN_APP_VERSION;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
beforeEach(() => { process.env.COURT_MIN_APP_VERSION = "1.0.14-1200"; vi.mocked(insertCourtStreamCode).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  if (savedKek === undefined) delete process.env.RELAY_KEK; else process.env.RELAY_KEK = savedKek;
  if (savedMin === undefined) delete process.env.COURT_MIN_APP_VERSION; else process.env.COURT_MIN_APP_VERSION = savedMin;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** 2026-11-07 24:00 Europe/Amsterdam, the end of T0's day, in epoch seconds. */
const END_OF_DAY = Math.floor(Date.parse("2026-11-07T23:00:00Z") / 1000);

async function failure(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}
const counts = async (orgId: string) => {
  const [r] = await sql<{ links: number; codes: number }[]>`
    select (select count(*)::int from court_stream_links where org_id = ${orgId}) as links,
           (select count(*)::int from fixture_stream_codes where org_id = ${orgId}) as codes`;
  return r!;
};
const codeRowOf = async (code: string) => {
  const [r] = await sql<{ id: string; fixture_id: string | null; court_link_id: string | null; ended_at: Date | null; end_cause: string | null }[]>`
    select id, fixture_id, court_link_id, ended_at, end_cause from fixture_stream_codes where code = ${code}`;
  return r!;
};

describe.skipIf(!HAS_DB)("court streams (desk)", () => {
  let day: Day;
  let api: { targetId: string };
  beforeEach(async () => { day = await seedDay(); api = await rigApiTarget(day.orgId, "Club channel"); });

  it("links Court 2 for today on a YouTube connection and shows a QR whose exp is the end of the day", async () => {
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    expect(shown.courtName).toBe("Court 2");
    expect(shown.day).toBe("2026-11-07");
    expect(shown.target).toEqual({ id: api.targetId, label: "Club channel" });
    expect(shown.qr).toMatchObject({ v: 2, slot: 0, exp: END_OF_DAY });
    expect(shown.qr!.tok).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await codeRowOf(shown.qr!.code)).toMatchObject({ fixture_id: null, court_link_id: shown.id, ended_at: null });
  });

  it("refuses a pasted-key destination: 422 court_destination_not_youtube, nothing written", async () => {
    const pasted = await rigTarget(day.orgId, "Pasted");
    const f = await failure(linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: pasted }, at(0)));
    expect([f.status, f.code]).toEqual([422, "court_destination_not_youtube"]);
    expect(await counts(day.orgId)).toEqual({ links: 0, codes: 0 });
  });

  it("with COURT_MIN_APP_VERSION unset or malformed: 503 court_streaming_unconfigured, no link and no code written (O13)", async () => {
    for (const v of ["", "abc", "1.0.14"]) {
      process.env.COURT_MIN_APP_VERSION = v;
      const f = await failure(linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0)));
      expect([f.status, f.code]).toEqual([503, "court_streaming_unconfigured"]);
    }
    delete process.env.COURT_MIN_APP_VERSION;
    expect((await failure(linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0)))).status).toBe(503);
    expect(await counts(day.orgId)).toEqual({ links: 0, codes: 0 });
    expect(insertCourtStreamCode).not.toHaveBeenCalled();
  });

  it("a second link call for the same court, day and target re-shows the same QR (no second code)", async () => {
    const a = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    const b = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(5));
    expect(b.id).toBe(a.id);
    expect(b.qr).toEqual(a.qr);
    expect(await counts(day.orgId)).toEqual({ links: 1, codes: 1 });
  });

  it("two simultaneous link calls make one link and one code", async () => {
    const [a, b] = await Promise.all([
      linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c1, targetId: api.targetId }, at(0)),
      linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c1, targetId: api.targetId }, at(0)),
    ]);
    expect(a.qr).toEqual(b.qr);
    expect(await counts(day.orgId)).toEqual({ links: 1, codes: 1 });
  });

  it("a second link call naming another target is 409 court_already_streaming", async () => {
    await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    const other = await rigApiTarget(day.orgId, "Other channel");
    const f = await failure(linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: other.targetId }, at(0)));
    expect([f.status, f.code]).toEqual([409, "court_already_streaming"]);
    expect(await counts(day.orgId)).toEqual({ links: 1, codes: 1 });
  });

  it("an API key or a device link cannot link (403); an org without streaming.relay is 402", async () => {
    for (const via of ["api_key", "device_link"] as const) {
      const f = await failure(linkCourtStream({ ...day.auth, via } as AuthCtx, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0)));
      expect(f.status).toBe(403);
    }
    const unpaid = await seedDay();
    const t = await rigApiTarget(unpaid.orgId, "T");
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${unpaid.orgId}, 'streaming.relay', false, 'court streams')`;
    await invalidateOrgEntitlements(unpaid.orgId);
    expect((await failure(linkCourtStream(unpaid.auth, unpaid.comp.id, { courtId: unpaid.courts.c1, targetId: t.targetId }, at(0)))).status).toBe(402);
    expect(await counts(unpaid.orgId)).toEqual({ links: 0, codes: 0 });
    // Final review m-7: the list is the same 402 (the openapi's), not an empty answer; another org's competition is still 404 first.
    expect((await failure(listCourtStreams(unpaid.auth, unpaid.comp.id, at(0)))).status).toBe(402);
    expect((await failure(listCourtStreams(unpaid.auth, day.comp.id, at(0)))).status).toBe(404);
    expect(await listCourtStreams(day.auth, day.comp.id, at(0)), "the entitled org's list is unchanged").toEqual([]);
  });

  it("another org's court, target or competition is 404 and nothing is written", async () => {
    const other = await seedDay();
    const otherApi = await rigApiTarget(other.orgId, "Theirs");
    const mine = { courtId: day.courts.c2, targetId: api.targetId };
    expect((await failure(linkCourtStream(day.auth, day.comp.id, { ...mine, courtId: other.courts.c1 }, at(0)))).status).toBe(404);
    expect((await failure(linkCourtStream(day.auth, day.comp.id, { ...mine, targetId: otherApi.targetId }, at(0)))).status).toBe(404);
    expect((await failure(linkCourtStream(day.auth, other.comp.id, mine, at(0)))).status).toBe(404);
    expect(await counts(day.orgId)).toEqual({ links: 0, codes: 0 });
    expect(await counts(other.orgId)).toEqual({ links: 0, codes: 0 });
  });

  it("a day already over is 422; a later day links", async () => {
    const input = { courtId: day.courts.c2, targetId: api.targetId };
    expect((await failure(linkCourtStream(day.auth, day.comp.id, { ...input, day: "2026-11-06" }, at(0)))).status).toBe(422);
    const next = await linkCourtStream(day.auth, day.comp.id, { ...input, day: "2026-11-08" }, at(0));
    expect(next.qr!.exp).toBe(END_OF_DAY + 86_400);
  });

  it("withdraw ends the code 'withdrawn', wipes its tok, and frees the court for a new link", async () => {
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    await withdrawCourtStream(day.auth, shown.id);
    const row = await codeRowOf(shown.qr!.code);
    expect(row).toMatchObject({ end_cause: "withdrawn" });
    expect(row.ended_at).not.toBeNull();
    expect(await sql.begin((tx) => openStreamCodeTok(tx, row.id))).toBeNull();
    expect(await listCourtStreams(day.auth, day.comp.id, at(0))).toEqual([]);
    const other = await rigApiTarget(day.orgId, "Other channel");
    const again = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: other.targetId }, at(1));
    expect(again.id).not.toBe(shown.id);
    expect(again.qr!.code).not.toBe(shown.qr!.code);
  });

  it("withdraw is idempotent: a second one changes nothing", async () => {
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    await withdrawCourtStream(day.auth, shown.id);
    const [first] = await sql<{ withdrawn_at: Date }[]>`select withdrawn_at from court_stream_links where id = ${shown.id}`;
    await withdrawCourtStream(day.auth, shown.id);
    const [second] = await sql<{ withdrawn_at: Date }[]>`select withdrawn_at from court_stream_links where id = ${shown.id}`;
    expect(second!.withdrawn_at).toEqual(first!.withdrawn_at);
  });

  it("withdraw of another org's link is 404, and the link is untouched", async () => {
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    const other = await seedDay();
    expect((await failure(withdrawCourtStream(other.auth, shown.id))).status).toBe(404);
    expect((await failure(withdrawCourtStream({ ...day.auth, via: "api_key" } as AuthCtx, shown.id))).status).toBe(403);
    expect((await listCourtStreams(day.auth, day.comp.id, at(0))).map((l) => l.id)).toEqual([shown.id]);
  });

  it("lists live links in court order, with their QR; a past day and another competition's court are left out", async () => {
    const c3 = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c3, targetId: api.targetId }, at(0));
    const c1 = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c1, targetId: api.targetId }, at(0));
    const list = await listCourtStreams(day.auth, day.comp.id, at(0));
    expect(list.map((l) => l.courtName)).toEqual(["Court 1", "Court 3"]);
    expect(list.map((l) => l.qr)).toEqual([c1.qr, c3.qr]);
    expect(await listCourtStreams(day.auth, day.comp.id, new Date(END_OF_DAY * 1000))).toEqual([]);
  });

  it("the tok never appears in a log line or an error message", async () => {
    const spies = (["debug", "info", "warn", "error"] as const).map((m) => vi.spyOn(log, m).mockImplementation(() => undefined as never));
    const consoles = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
    const tok = shown.qr!.tok;
    const other = await rigApiTarget(day.orgId, "Other channel");
    const refused = await failure(linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: other.targetId }, at(0)));
    await listCourtStreams(day.auth, day.comp.id, at(0));
    await withdrawCourtStream(day.auth, shown.id);
    expect(refused.message).not.toContain(tok);
    for (const s of [...spies, ...consoles]) expect(JSON.stringify(s.mock.calls)).not.toContain(tok);
  });
});
