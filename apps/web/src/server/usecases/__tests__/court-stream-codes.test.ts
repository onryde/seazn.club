// Court stream (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5; plan Task 6): resolving a COURT
// code and reading its court's matches. Real Postgres required; skipped without DATABASE_URL. The rules under test are
// the brief's and the spec's, typed here:
//   - one resolve reads both kinds; a court code answers kind "court" with its link, a fixture code kind "fixture";
//   - an unknown code and a wrong tok are the same 401 code_ended, each through ONE constant-time compare;
//   - C1b for a court: a withdrawn code serves its open court session's phone a get and a beat, never a claim or a start;
//   - C2 for a court: the day's end is the finish, with no grace; an open court session defers the expiry;
//   - C1(c) for a court: a record is served within 24 h of the later of the code's end and its COURT sessions' ends;
//   - the facts: the org's matches on the court today, in play, called, or under an open court session; a match with its
//     own ACTIVE code is not streamed by the court, whatever its switch says; the SQL's order is Match Day's queue order.
//
// The link is for 2026-11-07, the seed's T0 day (Europe/Amsterdam): every clock below is passed in, never read.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, default: actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { queueOrder } from "@/server/relay/domain/court-stream";
import { insertStreamCode, wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { rigApiTarget, rigTarget, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { asFixtureCode, courtFactsOf, type ResolvedCourtCode } from "../court-stream-codes";
import { linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { ensureStreamCode, resolveAnyStreamCode, resolveStreamCode } from "../stream-codes";
import { at, place, seedDay, setStatus, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const savedKek = process.env.RELAY_KEK;
const savedMin = process.env.COURT_MIN_APP_VERSION;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
beforeEach(() => {
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
  vi.mocked(timingSafeEqual).mockClear();
});
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

const DAY = "2026-11-07";
const MIN = 60_000;
const HOUR = 60 * MIN;
const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
/** "served:<status>" or "<http status>:<code>" — a refusal of any other kind is rethrown. */
const verdict = (p: Promise<{ status: string }>): Promise<string> =>
  p.then((v) => `served:${v.status}`, (e: unknown) => {
    if (e instanceof CaptureRefusalError) return `${e.status}:${e.code}`;
    throw e;
  });
const ALL_CALLS = ["get", "beat", "claim", "start"] as const;

describe.skipIf(!HAS_DB)("court stream codes", () => {
  let day: Day;
  let fx: string[];
  let qr: { code: string; tok: string };
  let court: ResolvedCourtCode;

  /** A session of `fixtureId` under the court link, paired to `phone` on the court code when one is given. */
  const courtSession = async (fixtureId: string, opts: { phone?: string; state?: string; startCause?: string } = {}): Promise<string> => {
    const sid = await sessionOnTarget(day.orgId, fixtureId, await rigTarget(day.orgId), opts.state ?? "live");
    await sql`update fixture_stream_sessions set court_link_id = ${court.link.id}, code_id = ${court.codeId},
                     start_cause = ${opts.startCause ?? "automatic"} where id = ${sid}`;
    if (opts.phone !== undefined) {
      const [p] = await sql<{ id: string }[]>`
        insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
        values (${day.orgId}, ${court.codeId}, 0, ${opts.phone}, 'new', now(), now(), 60) returning id`;
      await sql`update fixture_stream_sessions set pairing_id = ${p!.id} where id = ${sid}`;
    }
    return sid;
  };
  const codeRow = async () =>
    (await sql<{ ended_at: Date | null; end_cause: string | null }[]>`
      select ended_at, end_cause from fixture_stream_codes where id = ${court.codeId}`)[0]!;
  const factIds = async () => (await courtFactsOf(sql, court.link)).map((f) => f.fixtureId);

  beforeEach(async () => {
    day = await seedDay();
    fx = day.comp.fixtures.map((f) => f.id);
    const api = await rigApiTarget(day.orgId, "Club channel");
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId, day: DAY }, at(0));
    qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    const r = await resolveAnyStreamCode(qr.code, qr.tok, "get", null, at(0));
    if (r.kind !== "court") throw new Error("the court's QR did not resolve as a court code");
    court = r;
  });

  it("a court code resolves as kind court with its link; a fixture code as kind fixture with today's fields", async () => {
    const [link] = await sql<{ id: string; competition_id: string; opens_at: Date; expires_at: Date; target_id: string }[]>`
      select id, competition_id, opens_at, expires_at, target_id from court_stream_links where court_id = ${day.courts.c2}`;
    const [code] = await sql<{ id: string }[]>`select id from fixture_stream_codes where court_link_id = ${link!.id}`;
    expect(court).toEqual({
      kind: "court", codeId: code!.id, orgId: day.orgId, status: "active", issuedBy: day.auth.userId,
      link: {
        id: link!.id, competitionId: day.comp.id, courtId: day.courts.c2, courtName: "Court 2",
        opensAt: link!.opens_at, expiresAt: link!.expires_at, targetId: link!.target_id, withdrawnAt: null,
      },
    });
    // The day in Amsterdam (UTC+1 in November): 2026-11-06T23:00Z to 2026-11-07T23:00Z.
    expect(court.link.opensAt.toISOString()).toBe("2026-11-06T23:00:00.000Z");
    expect(court.link.expiresAt.toISOString()).toBe("2026-11-07T23:00:00.000Z");
    expect(asFixtureCode(court, fx[0]!)).toEqual({
      kind: "fixture", codeId: code!.id, orgId: day.orgId, fixtureId: fx[0], status: "active", issuedBy: day.auth.userId,
    });

    const own = await ensureStreamCode(day.auth, fx[3]!);
    const [ownRow] = await sql<{ id: string }[]>`select id from fixture_stream_codes where fixture_id = ${fx[3]!} and ended_at is null`;
    expect(await resolveAnyStreamCode(own.qr.code, own.qr.tok, "get", null, new Date())).toEqual({
      kind: "fixture", codeId: ownRow!.id, orgId: day.orgId, fixtureId: fx[3], status: "active", issuedBy: day.auth.userId,
    });
    expect(await resolveStreamCode(own.qr.code, own.qr.tok, "get", null, new Date())).toEqual({
      kind: "fixture", codeId: ownRow!.id, orgId: day.orgId, fixtureId: fx[3], status: "active", issuedBy: day.auth.userId,
    });
  });

  it("a wrong tok on a court code is the same 401 code_ended as an unknown code", async () => {
    const calls = () => vi.mocked(timingSafeEqual).mock.calls as unknown as [Buffer, Buffer][];
    const [row] = await sql<{ tok_hash: string }[]>`select tok_hash from fixture_stream_codes where id = ${court.codeId}`;

    vi.mocked(timingSafeEqual).mockClear();
    const wrongTok = randomBytes(16).toString("base64url");
    expect(await verdict(resolveAnyStreamCode(qr.code, wrongTok, "get", null, at(0)))).toBe("401:code_ended");
    expect(calls()).toHaveLength(1);
    expect(Buffer.from(calls()[0]![0]).toString("hex")).toBe(sha256Hex(wrongTok));
    expect(Buffer.from(calls()[0]![1]).toString("hex")).toBe(row!.tok_hash);

    vi.mocked(timingSafeEqual).mockClear();
    let unknown = qr.code;
    while (unknown === qr.code) unknown = Array.from({ length: 12 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");
    expect(await verdict(resolveAnyStreamCode(unknown, qr.tok, "get", null, at(0)))).toBe("401:code_ended");
    expect(calls()).toHaveLength(1);
    const dummy = createHash("sha256").update("capture-dummy-tok", "utf8").digest();
    expect(Buffer.from(calls()[0]![1]).equals(dummy)).toBe(true);
  });

  it("withdrawn, no open session: 401 for get, beat, claim and start", async () => {
    await withdrawCourtStream(day.auth, court.link.id);
    const phone = `phone-${randomUUID()}`;
    const got: string[] = [];
    for (const call of ALL_CALLS) for (const who of [phone, null]) got.push(`${call}:${await verdict(resolveAnyStreamCode(qr.code, qr.tok, call, who, at(0)))}`);
    expect(got).toEqual([
      "get:401:code_ended", "get:401:code_ended", "beat:401:code_ended", "beat:401:code_ended",
      "claim:401:code_ended", "claim:401:code_ended", "start:401:code_ended", "start:401:code_ended",
    ]);
    expect(await codeRow()).toMatchObject({ end_cause: "withdrawn" });
  });

  it("withdrawn while a court session is open: its phone's get and beat are served; claim and start are 401", async () => {
    const phone = `phone-${randomUUID()}`;
    await courtSession(fx[0]!, { phone });
    await withdrawCourtStream(day.auth, court.link.id);
    const got: [string, string, string][] = [];
    for (const call of ALL_CALLS) {
      for (const who of [phone, `phone-${randomUUID()}`, null]) {
        got.push([call, who === phone ? "own" : who === null ? "none" : "other", await verdict(resolveAnyStreamCode(qr.code, qr.tok, call, who, at(0)))]);
      }
    }
    expect(got).toEqual([
      ["get", "own", "served:ended"], ["get", "other", "401:code_ended"], ["get", "none", "401:code_ended"],
      ["beat", "own", "served:ended"], ["beat", "other", "401:code_ended"], ["beat", "none", "401:code_ended"],
      ["claim", "own", "401:code_ended"], ["claim", "other", "401:code_ended"], ["claim", "none", "401:code_ended"],
      ["start", "own", "401:code_ended"], ["start", "other", "401:code_ended"], ["start", "none", "401:code_ended"],
    ]);
  });

  it("past the day's end with no open session: written expired, then 401", async () => {
    const end = court.link.expiresAt.getTime();
    // One ms before the end it is still active; at the end, with no session open, it is ended as expired (grace 0).
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "get", null, new Date(end - 1)))).toBe("served:active");
    expect((await codeRow()).ended_at).toBeNull();
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "get", null, new Date(end)))).toBe("401:code_ended");
    expect(await codeRow()).toMatchObject({ end_cause: "expired" });
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "get", null, new Date(end + MIN)))).toBe("401:code_ended");
  });

  it("past the day's end with an open session: finishing, served", async () => {
    await courtSession(fx[0]!);
    const after = new Date(court.link.expiresAt.getTime() + 30 * MIN);
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "beat", null, after))).toBe("served:finishing");
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "claim", null, after))).toBe("served:finishing");
    expect((await codeRow()).ended_at).toBeNull();
    // A session of the same match that is NOT the court's does not defer the court code's expiry.
    await sql`update fixture_stream_sessions set court_link_id = null where court_link_id = ${court.link.id}`;
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "get", null, after))).toBe("401:code_ended");
    expect(await codeRow()).toMatchObject({ end_cause: "expired" });
  });

  it("a record after withdrawal: served within 24 h of the code's end, anchored on court sessions", async () => {
    // A session of the same match outside the court (its own code's), begun before the withdrawal and ended much later,
    // must not stretch the tail. One active session per match (V430), so it is closed before the court's opens.
    const stranger = await sessionOnTarget(day.orgId, fx[0]!, await rigTarget(day.orgId), "live");
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${stranger}`;
    const own = await courtSession(fx[0]!);
    await withdrawCourtStream(day.auth, court.link.id);
    const codeEnd = (await codeRow()).ended_at!.getTime();
    const ownEnd = new Date(codeEnd + 2 * HOUR);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = ${ownEnd} where id = ${own}`;
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = ${new Date(codeEnd + 10 * HOUR)} where id = ${stranger}`;
    const tailEnd = ownEnd.getTime() + 24 * HOUR;
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "record", null, new Date(codeEnd + 25 * HOUR)))).toBe("served:ended");
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "record", null, new Date(tailEnd)))).toBe("served:ended");
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "record", null, new Date(tailEnd + MIN)))).toBe("401:code_ended");
    // A get is never served by the tail.
    expect(await verdict(resolveAnyStreamCode(qr.code, qr.tok, "get", null, new Date(codeEnd + HOUR)))).toBe("401:code_ended");
  });

  it("courtFactsOf admits a match in play whose planned time was yesterday, and a called match", async () => {
    await place(day, fx[0]!, -24 * 60, day.courts.c2);
    await setStatus(fx[0]!, "in_play");
    // A call that still holds: unstarted, on the called court at the called time — two days before the link's day.
    await place(day, fx[1]!, -48 * 60, day.courts.c2);
    await sql`insert into fixture_calls (fixture_id, org_id, court_id, called_at) values (${fx[1]!}, ${day.orgId}, ${day.courts.c2}, ${at(-48 * 60)})`;
    const facts = await courtFactsOf(sql, court.link);
    expect(facts.map((f) => f.fixtureId).sort()).toEqual([fx[0]!, fx[1]!].sort());
    expect(facts.find((f) => f.fixtureId === fx[1])!.calledAt).toEqual(at(-48 * 60));
    expect(facts.find((f) => f.fixtureId === fx[0])!.calledAt).toBeNull();
    // The call ends when the board moves the match to another time: then nothing admits it.
    await place(day, fx[1]!, -47 * 60, day.courts.c2);
    expect(await factIds()).toEqual([fx[0]!]);
  });

  it("courtFactsOf: a match moved onto the court appears, one moved off disappears, another org's never does", async () => {
    await place(day, fx[0]!, 60, day.courts.c1);
    expect(await factIds()).toEqual([]);
    await place(day, fx[0]!, 60, day.courts.c2);
    expect(await factIds()).toEqual([fx[0]!]);
    await place(day, fx[0]!, 60, day.courts.c3);
    expect(await factIds()).toEqual([]);
    // Another org's matches, on its own Court 2 at the same time, in play and called (a fixture's court belongs to its org,
    // V367's (court_id, org_id) key, so another org's match can sit only on another org's court).
    const other = await seedDay();
    const [o1, o2] = other.comp.fixtures.map((f) => f.id);
    await place(other, o1!, 60, other.courts.c2);
    await place(other, o2!, 90, other.courts.c2);
    await setStatus(o2!, "in_play");
    expect(await factIds()).toEqual([]);
  });

  it("courtFactsOf: a match planned on the court tomorrow is not in today's facts", async () => {
    const end = (court.link.expiresAt.getTime() - Date.parse("2026-11-07T10:00:00.000Z")) / MIN;
    await place(day, fx[0]!, 24 * 60, day.courts.c2);
    await place(day, fx[1]!, end, day.courts.c2);       // the day's end itself is tomorrow
    await place(day, fx[2]!, end - 1, day.courts.c2);   // a minute before it is today
    expect(await factIds()).toEqual([fx[2]!]);
  });

  it("courtFactsOf reads a match with its own active stream code as not streamed", async () => {
    await place(day, fx[0]!, 60, day.courts.c2);
    await setCourtStream(day.auth, fx[0]!, true, at(0));
    expect((await courtFactsOf(sql, court.link))[0]).toMatchObject({ fixtureId: fx[0], streamed: true });
    // A legacy own code the switch's guard never saw (written raw, as a race or an older build would leave it).
    await sql.begin((tx) => insertStreamCode(tx, {
      orgId: day.orgId, fixtureId: fx[0]!, code: Array.from({ length: 12 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join(""),
      tokHash: sha256Hex("t"), tokEnc: Buffer.from("not-a-real-envelope"), issuedBy: day.auth.userId!,
    }));
    expect((await courtFactsOf(sql, court.link))[0]).toMatchObject({ fixtureId: fx[0], streamed: false });
    // Once that code ends the switch speaks again.
    const [own] = await sql<{ id: string }[]>`select id from fixture_stream_codes where fixture_id = ${fx[0]!} and ended_at is null`;
    await sql.begin((tx) => wipeStreamCodeTok(tx, own!.id, "reissued", null));
    expect((await courtFactsOf(sql, court.link))[0]).toMatchObject({ fixtureId: fx[0], streamed: true });
  });

  it("courtFactsOf: the open court session, its organiser start, the latch and the kickoff", async () => {
    await place(day, fx[0]!, 60, day.courts.c2);
    await place(day, fx[1]!, 90, day.courts.c2);
    await setStatus(fx[0]!, "in_play");
    const sid = await courtSession(fx[0]!, { startCause: "organiser" });
    await sql`insert into fixture_stream_settings (fixture_id, org_id, auto_start_blocked_at) values (${fx[1]!}, ${day.orgId}, now())`;
    const facts = await courtFactsOf(sql, court.link);
    const a = facts.find((f) => f.fixtureId === fx[0])!;
    const b = facts.find((f) => f.fixtureId === fx[1])!;
    expect(a.openSession).toMatchObject({ sid, byOrganiser: true });
    expect(a).toMatchObject({ status: "in_play", latched: false, kickoffAt: null });
    expect(b).toMatchObject({ openSession: null, latched: true, ready: true });
    await sql`update fixture_stream_sessions set start_cause = 'automatic' where id = ${sid}`;
    expect((await courtFactsOf(sql, court.link)).find((f) => f.fixtureId === fx[0])!.openSession).toMatchObject({ sid, byOrganiser: false });
  });

  it("courtFactsOf (R8): a match moved off the court mid-video stays, with its open session, until that session ends", async () => {
    await place(day, fx[0]!, 60, day.courts.c2);
    await setStatus(fx[0]!, "in_play");
    const sid = await courtSession(fx[0]!);
    await place(day, fx[0]!, 60, day.courts.c1);
    const facts = await courtFactsOf(sql, court.link);
    expect(facts.map((f) => f.fixtureId)).toEqual([fx[0]!]);
    expect(facts[0]!.openSession).toMatchObject({ sid });
    // Only the open session holds it: another match moved off the court with no court session is gone.
    await place(day, fx[1]!, 60, day.courts.c1);
    await setStatus(fx[1]!, "in_play");
    expect(await factIds()).toEqual([fx[0]!]);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${sid}`;
    expect(await factIds()).toEqual([]);
  });

  it("SQL queue order equals queueOrder() on a seeded court of 6 matches (ties on time, round and seq)", async () => {
    expect(fx).toHaveLength(6);
    // Two at the same time AND the same round and seq (the id decides); two more at one time, the round deciding; one
    // TBD (not ready) at the earliest time; one called later in the day (a held call queues first).
    for (const id of fx) await place(day, id, 120, day.courts.c2);
    await sql`update fixtures set round_no = 1, seq_in_round = 1 where id in ${sql([fx[0]!, fx[1]!])}`;
    await sql`update fixtures set round_no = 3, seq_in_round = 1 where id = ${fx[2]!}`;
    await sql`update fixtures set round_no = 2, seq_in_round = 2 where id = ${fx[3]!}`;
    await place(day, fx[4]!, 30, day.courts.c2);
    await sql`update fixtures set away_entrant_id = null where id = ${fx[4]!}`;
    await place(day, fx[5]!, 300, day.courts.c2);
    await sql`insert into fixture_calls (fixture_id, org_id, court_id, called_at) values (${fx[5]!}, ${day.orgId}, ${day.courts.c2}, ${at(300)})`;
    const facts = await courtFactsOf(sql, court.link);
    expect(facts).toHaveLength(6);
    expect(facts.filter((f) => !f.ready).map((f) => f.fixtureId)).toEqual([fx[4]!]);
    expect(facts.filter((f) => f.calledAt !== null).map((f) => f.fixtureId)).toEqual([fx[5]!]);
    expect(facts.map((f) => f.fixtureId)).toEqual([...facts].sort(queueOrder).map((f) => f.fixtureId));
    // Pinned from the rows above, not from queueOrder: the call, then 120 by round/seq/id, the TBD match last.
    const [lo, hi] = [fx[0]!, fx[1]!].sort();
    expect(facts.map((f) => f.fixtureId)).toEqual([fx[5]!, lo!, hi!, fx[3]!, fx[2]!, fx[4]!]);
  });

  it("resolveStreamCode still refuses a court code (401)", async () => {
    expect(await verdict(resolveStreamCode(qr.code, qr.tok, "get", null, at(0)))).toBe("401:code_ended");
  });
});
