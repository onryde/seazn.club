// Court stream, the desk's read (spec 2026-11-14 §5.5; plan Task 11): Match Day's court carries the phone's status, the
// court's refusal of an automatic start and each match's switch. Real Postgres required; skipped without DATABASE_URL.
// The rules under test are the brief's, typed here: unpaired with no pairing; waiting after a beat; live with a live session;
// offline at 3 missed beats (10 s cadence: 30 s); a withdrawn or absent link reads null; the stored refusal shows until a
// success clears it; a view-only member reads it; the read costs one statement per kind however many courts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { rigApiTarget, rigUser, apiSessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import type { AuthCtx } from "@/server/api-v1/auth";
import { linkCourtStream, withdrawCourtStream } from "../court-streams";
import { courtStreamsForDay } from "../court-streams";
import { getMatchDay } from "../match-day";
import { at, place, seedDay, setStatus, type Day } from "./_match-day-seed";

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

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const newCode = (): string => Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join("");

describe.skipIf(!HAS_DB)("court streams (the desk's read)", () => {
  let day: Day;
  let targetId: string;
  let f0: string; // on Court 2, in play
  let f1: string; // on Court 2, queued
  beforeEach(async () => {
    day = await seedDay();
    targetId = (await rigApiTarget(day.orgId, "Club channel")).targetId;
    f0 = day.comp.fixtures[0]!.id;
    f1 = day.comp.fixtures[1]!.id;
    await place(day, f0, 0, day.courts.c2);
    await place(day, f1, 60, day.courts.c2);
    await setStatus(f0, "in_play");
  });

  const link = (courtId = day.courts.c2) => linkCourtStream(day.auth, day.comp.id, { courtId, targetId }, at(0));
  const courtOf = async (name = "Court 2", now = at(0), auth: AuthCtx = day.auth) =>
    (await getMatchDay(auth, day.comp.id, now)).courts.find((c) => c.court_name === name)!;
  /** A court pairing on the link's live code, last beat at `beatMin`, polling every 10 s. */
  const pair = async (linkId: string, beatMin: number): Promise<void> => {
    const [code] = await sql<{ id: string }[]>`select id from fixture_stream_codes where court_link_id = ${linkId} and ended_at is null`;
    await sql`
      insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
      values (${day.orgId}, ${code!.id}, 0, ${randomUUID()}, 'new', ${at(beatMin)}, ${at(beatMin)}, 10)`;
  };

  it("a linked court with no phone reads unpaired; after a beat waiting; with a live session live; 3 missed beats offline", async () => {
    const shown = await link();
    expect((await courtOf()).stream_link).toEqual({
      link_id: shown.id, target_label: "Club channel", expires_at: shown.expiresAt.toISOString(), phone: "unpaired", refusal: null,
    });
    await pair(shown.id, 0);
    expect((await courtOf("Court 2", new Date(at(0).getTime() + 25_000))).stream_link!.phone, "25 s: 2.5 cadences, still there").toBe("waiting");
    const sid = await apiSessionOnTarget(day.orgId, f0, targetId, "live");
    await sql`update fixture_stream_sessions set court_link_id = ${shown.id} where id = ${sid}`;
    expect((await courtOf("Court 2", new Date(at(0).getTime() + 5_000))).stream_link!.phone).toBe("live");
    expect((await courtOf("Court 2", new Date(at(0).getTime() + 30_000))).stream_link!.phone, "30 s: 3 cadences").toBe("offline");
  });

  it("an unlinked court has stream_link null; a withdrawn link reads null", async () => {
    expect((await courtOf("Court 2")).stream_link).toBeNull();
    const shown = await link();
    expect((await courtOf()).stream_link).not.toBeNull();
    await withdrawCourtStream(day.auth, shown.id);
    expect((await courtOf()).stream_link).toBeNull();
  });

  it("a refused automatic start shows its refusal on the court; a later success clears it", async () => {
    await link();
    await sql`insert into fixture_stream_settings (fixture_id, org_id, court_stream, auto_start_refusal, auto_start_attempted_at)
              values (${f0}, ${day.orgId}, true, 'no_credit', ${at(0)})`;
    expect((await courtOf()).stream_link!.refusal).toBe("no_credit");
    await sql`update fixture_stream_settings set auto_start_refusal = null where fixture_id = ${f0}`;
    expect((await courtOf()).stream_link!.refusal).toBeNull();
  });

  it("serves a stored not_entitled as competition_frozen while the competition is frozen, never stored", async () => {
    await link();
    await sql`insert into fixture_stream_settings (fixture_id, org_id, court_stream, auto_start_refusal, auto_start_attempted_at)
              values (${f0}, ${day.orgId}, true, 'not_entitled', ${at(0)})`;
    expect((await courtOf()).stream_link!.refusal).toBe("not_entitled");
    const { frozenCompetitionIds } = await import("../entitlement-freeze");
    const spy = vi.spyOn(await import("../entitlement-freeze"), "frozenCompetitionIds").mockResolvedValue(new Set([day.comp.id]));
    expect((await courtOf()).stream_link!.refusal).toBe("competition_frozen");
    spy.mockRestore();
    expect(typeof frozenCompetitionIds).toBe("function");
    const [row] = await sql<{ r: string }[]>`select auto_start_refusal as r from fixture_stream_settings where fixture_id = ${f0}`;
    expect(row!.r).toBe("not_entitled");
  });

  it("court_stream and own_stream_code per match", async () => {
    await link();
    await sql`insert into fixture_stream_settings (fixture_id, org_id, court_stream) values (${f0}, ${day.orgId}, true)`;
    await sql`insert into fixture_stream_codes (org_id, fixture_id, code, tok_hash, tok_enc, issued_by)
              values (${day.orgId}, ${f1}, ${newCode()}, ${'0'.repeat(64)}, ${Buffer.from("sealed")}, ${await rigUser()})`;
    const court = await courtOf();
    expect([court.current!.court_stream, court.current!.own_stream_code]).toEqual([true, false]);
    expect([court.queue[0]!.court_stream, court.queue[0]!.own_stream_code]).toEqual([false, true]);
    await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'reissued', tok_enc = null where fixture_id = ${f1}`;
    expect((await courtOf()).queue[0]!.own_stream_code, "an ended code is not active").toBe(false);
  });

  it("a view-only member reads it; the read costs one statement per kind (no per-court query)", async () => {
    const shown = await link();
    await link(day.courts.c1);
    await pair(shown.id, 0);
    const viewer: AuthCtx = { ...day.auth, role: "viewer" };
    expect((await courtOf("Court 2", at(0), viewer)).stream_link!.phone).toBe("waiting");

    const seen: string[] = [];
    const opts = (sql as unknown as { options: { debug?: unknown } }).options;
    const saved = opts.debug;
    opts.debug = (_c: number, q: string) => { seen.push(q); };
    try {
      await courtStreamsForDay(day.orgId, [day.courts.c1], [f0], at(0));
      const one = seen.length;
      seen.length = 0;
      await courtStreamsForDay(day.orgId, [day.courts.c1, day.courts.c2, day.courts.c3], [f0, f1], at(0));
      expect(one).toBeGreaterThan(0);
      expect(seen.length, "same statements for three courts as for one").toBe(one);
      expect(seen.length).toBeLessThanOrEqual(2);
    } finally { opts.debug = saved; }
  });
});
