// Court stream, the per-match Stream switch (spec 2026-11-14 §5.2; plan Task 4). Real Postgres required; skipped without
// DATABASE_URL. Rules under test are the brief's, typed here: the switch is OFF by default and turning it on spends no
// credit; it is refused by name when the match has its own ACTIVE code (has_own_stream_code) or its court has no live link
// now (court_not_streaming); turning off is never refused; ensure/reissue refuse a court-streamed match (court_streamed);
// and a mint racing a switch-on has exactly one winner, the loser refused by name.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

// Pass-through wrapper on the fixture code's sealed insert, so a test can hold a mint open between its reads and its write.
const hold = vi.hoisted(() => ({ gate: null as null | (() => Promise<void>) }));
vi.mock("@/server/relay/secret-columns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/relay/secret-columns")>();
  return {
    ...actual,
    insertStreamCode: ((...a: Parameters<typeof actual.insertStreamCode>) =>
      (hold.gate ? hold.gate() : Promise.resolve()).then(() => actual.insertStreamCode(...a))) as typeof actual.insertStreamCode,
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { rigApiTarget } from "@/server/relay/__tests__/_session-rig";
import type { AuthCtx } from "@/server/api-v1/auth";
import { linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { ensureStreamCode, reissueStreamCode } from "../stream-codes";
import { streamPhone } from "../stream-phone";
import { place, seedDay, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const savedKek = process.env.RELAY_KEK;
const savedMin = process.env.COURT_MIN_APP_VERSION;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
beforeEach(() => { process.env.COURT_MIN_APP_VERSION = "1.0.14-1200"; });
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

async function failure(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected a refusal");
}
const settingsOf = async (fixtureId: string) => {
  const [r] = await sql<{ court_stream: boolean; revision: number; target_id: string | null; target_chosen: boolean }[]>`
    select court_stream, revision::int as revision, target_id, target_chosen from fixture_stream_settings where fixture_id = ${fixtureId}`;
  return r ?? null;
};
const activeCodes = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${fixtureId} and ended_at is null`)[0]!.n;

describe.skipIf(!HAS_DB)("court stream switch", () => {
  let day: Day;
  let fx: string;
  let other: string;
  // The links are for REAL today (the guards read the clock themselves, like the rest of the stream code), the fixture on Court 2.
  const linkCourt2 = async () => {
    const api = await rigApiTarget(day.orgId, "Club channel");
    return linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId });
  };
  beforeEach(async () => {
    day = await seedDay();
    fx = day.comp.fixtures[0]!.id;
    other = day.comp.fixtures[1]!.id;
    await place(day, fx, 0, day.courts.c2);
    await place(day, other, 30, day.courts.c1);
  });

  it("is off by default and spends nothing when turned on", async () => {
    expect(await settingsOf(fx)).toBeNull();
    await linkCourt2();
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: true, revision: 1, target_id: null, target_chosen: false });
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${day.orgId}`;
    expect(c!.n).toBe(0);
    expect(await settingsOf(other)).toBeNull();
    expect(await setCourtStream(day.auth, fx, false)).toEqual({ on: false });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: false, revision: 2 });
  });

  it("final review I-1: the panel's read model names the court AND the link's channel label once the switch is on, and nothing before", async () => {
    await linkCourt2();
    expect((await streamPhone(day.auth, fx, { now: () => new Date() })).court, "switch off").toBeNull();
    await setCourtStream(day.auth, fx, true);
    const read = await streamPhone(day.auth, fx, { now: () => new Date() });
    expect(read.court).toEqual({ name: "Court 2", targetLabel: "Club channel" });
    expect(JSON.stringify(read), "a label only: no link or target id on the panel read").not.toMatch(/court_link|target_id|tok/);
  });

  it("turning on a match that has its own stream code is 409 has_own_stream_code, nothing written", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    const f = await failure(setCourtStream(day.auth, fx, true));
    expect([f.status, f.code]).toEqual([409, "has_own_stream_code"]);
    expect(await settingsOf(fx)).toBeNull();
  });

  it("turning on a match whose court is not streaming is 409 court_not_streaming", async () => {
    const f = await failure(setCourtStream(day.auth, fx, true)); // never linked
    expect([f.status, f.code]).toEqual([409, "court_not_streaming"]);
    await linkCourt2();
    const g = await failure(setCourtStream(day.auth, other, true)); // Court 1 is not linked
    expect([g.status, g.code]).toEqual([409, "court_not_streaming"]);
    await place(day, other, 30, null); // no court at all
    expect((await failure(setCourtStream(day.auth, other, true))).code).toBe("court_not_streaming");
    expect(await settingsOf(fx)).toBeNull();
    expect(await settingsOf(other)).toBeNull();
  });

  it("a withdrawn link, or one whose day is over or not yet open, is not streaming", async () => {
    const shown = await linkCourt2();
    await withdrawCourtStream(day.auth, shown.id);
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("court_not_streaming");
    await linkCourt2();
    const tomorrow = new Date(Date.now() + 36 * 3600_000);
    expect((await failure(setCourtStream(day.auth, fx, true, tomorrow))).code).toBe("court_not_streaming");
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    expect((await failure(setCourtStream(day.auth, fx, true, yesterday))).code).toBe("court_not_streaming");
  });

  it("turning off always succeeds, also on an unlinked court", async () => {
    expect(await setCourtStream(day.auth, other, false)).toEqual({ on: false });
    expect(await settingsOf(other)).toMatchObject({ court_stream: false, revision: 1 });
    await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    const links = await sql<{ id: string }[]>`select id from court_stream_links where org_id = ${day.orgId}`;
    await withdrawCourtStream(day.auth, links[0]!.id);
    expect(await setCourtStream(day.auth, fx, false)).toEqual({ on: false });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: false });
  });

  it("ensureStreamCode and reissueStreamCode on a court-streamed match are 409 court_streamed; turning the switch off lets it mint", async () => {
    await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    for (const call of [ensureStreamCode, reissueStreamCode]) {
      const f = await failure(call(day.auth, fx));
      expect([f.status, f.code]).toEqual([409, "court_streamed"]);
    }
    expect(await activeCodes(fx)).toBe(0);
    await setCourtStream(day.auth, fx, false);
    expect((await ensureStreamCode(day.auth, fx)).qr.code).toMatch(/\S/);
    expect(await activeCodes(fx)).toBe(1);
  });

  it("a switch left on after its link ended does not stop the match minting its own code", async () => {
    const shown = await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    await withdrawCourtStream(day.auth, shown.id);
    expect((await ensureStreamCode(day.auth, fx)).qr.code).toMatch(/\S/);
  });

  it("racing a mint and a switch-on: exactly one wins, the other is refused by name", async () => {
    await linkCourt2();
    const [a, b] = await Promise.allSettled([ensureStreamCode(day.auth, fx), setCourtStream(day.auth, fx, true)]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const lost = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(HttpError);
    expect((lost.reason as HttpError).code).toBe(a.status === "rejected" ? "court_streamed" : "has_own_stream_code");
    const s = await settingsOf(fx);
    expect((await activeCodes(fx) === 1) !== (s?.court_stream === true)).toBe(true);
  });

  it("a mint held open between its reads and its write still blocks a switch-on: the switch waits on the lock and is refused", async () => {
    await linkCourt2();
    let reached!: () => void;
    const atInsert = new Promise<void>((r) => { reached = r; });
    hold.gate = async () => { reached(); await new Promise((r) => setTimeout(r, 400)); };
    try {
      const mint = ensureStreamCode(day.auth, fx);
      await atInsert; // the mint has read "no code, switch off" and holds the fixture's lock
      const sw = failure(setCourtStream(day.auth, fx, true));
      expect(await mint).toHaveProperty("qr");
      expect((await sw).code).toBe("has_own_stream_code");
    } finally { hold.gate = null; }
    expect(await settingsOf(fx)).toBeNull();
    expect(await activeCodes(fx)).toBe(1);
  });

  it("an API key or a device link cannot set it (403)", async () => {
    await linkCourt2();
    for (const via of ["api_key", "device_link"] as const) {
      expect((await failure(setCourtStream({ ...day.auth, via } as AuthCtx, fx, true))).status).toBe(403);
    }
    expect(await settingsOf(fx)).toBeNull();
  });

  it("another organisation's match is a 404", async () => {
    const stranger = await seedDay();
    expect((await failure(setCourtStream(stranger.auth, fx, true))).status).toBe(404);
  });
});
