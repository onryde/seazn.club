// Seazn-hosted video Task 31 (Phase 3, SEAZN_HOSTED_COST): the daily measurement of delivered minutes, and the deleted-org purge.
//
// The rules (the brief, and the controller's rulings of 2026-11-23), typed here — never read back from the module:
//   * LIVE minutes ("Cloudflare minutes delivered") of a Seazn session that ended within SEAZN_LIVE_MEASURE_DAYS are the SUM of what
//     Cloudflare reports for each of its programme recordings' video uids, its programme input uid riding along (ruling 1). Since
//     2026-11-23 we know Cloudflare keys minutes by the recording and answers 0 for an input; the cases below still give the input a
//     number so a dropped uid reads in the sum (the brief's 12.5 + 3 = 15.5 is that world, not production's);
//   * REPLAY minutes are the replay host's watch time of every copy whose row is not deleted, summed per session;
//   * each half is read from the day after its `*_measured_through` (or the session's first day) through yesterday, UTC, and stores
//     yesterday as measured: a second run the same day reads nothing, the next day's run reads one new day (ruling 3);
//   * a copy the host no longer holds answers null — "gone, stop measuring" — and NEVER writes 0 over what is stored (ruling 2c);
//   * a deleted org's replays are removed SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS after `organizations.deleted_at`; one inside the grace,
//     and an active org's, are kept; each copy's minutes are read just BEFORE it is removed (ruling 2a), with the cost flag on.
// Every session, recording and replay row is made by the REAL producers (Go live, Stop, the lock pass, discovery and the move onto
// the replay fake: `_seazn-replay-rig.ts`); only the vendor reads are fakes. Clocks are injected (`now`), never slept on.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): measuring and purging read no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import type { FakeIngest } from "@/server/relay/fakes";
import {
  SEAZN_CLAIM_LEASE_SECONDS, SEAZN_LIVE_MEASURE_BREAKER_FAILURES, SEAZN_LIVE_MEASURE_DAYS, SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS,
} from "@/server/relay/config";
import type { LiveMinutesReader } from "@/server/video/cf-analytics";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { movedReplays } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, live, seaznRig, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { deleteSeaznReplay } from "@/server/video/organiser-replays";
import { measureSeaznDelivery, purgeDeletedOrgReplays, purgeFixturelessReplays, seaznVideoForOrg } from "../seazn-cost";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 86_400_000;

installSeaznEnv("t31-seazn-cost");

/** A UTC date as `YYYY-MM-DD`, and `n` days after it — the expected windows, worked out here from the rule. */
const ymd = (at: Date) => at.toISOString().slice(0, 10);
const midnight = (at: Date) => new Date(`${ymd(at)}T00:00:00.000Z`);
const daysAfter = (at: Date, n: number) => new Date(midnight(at).getTime() + n * DAY_MS);
/** The last millisecond of the UTC day `n` days after `at`'s. */
const endOfDayAfter = (at: Date, n: number) => new Date(daysAfter(at, n + 1).getTime() - 1);
const LEASE_MS = SEAZN_CLAIM_LEASE_SECONDS * 1000;
/** The sweep's daily slot on the day `n` days after `at`'s UTC date. */
const slot = (at: Date, n: number) => new Date(daysAfter(at, n).getTime() + (4 * 60 + 17) * 60_000);

/** Cloudflare's reader, faked: every uid asked gets a number (0 unless set), as the real one answers; every call is kept. */
function fakeLive(minutes: Record<string, number> = {}) {
  const calls: { uids: string[]; from: string; to: string }[] = [];
  let failFor: ((uids: readonly string[]) => boolean) | null = null;
  const read: LiveMinutesReader = async (uids, from, to) => {
    calls.push({ uids: [...uids].sort(), from: ymd(from), to: ymd(to) });
    if (failFor?.(uids)) throw new Error("cloudflare liveMinutesViewed: HTTP 503");
    return Object.fromEntries(uids.map((u) => [u, minutes[u] ?? 0]));
  };
  return { read, calls, minutes, failWhen: (f: ((uids: readonly string[]) => boolean) | null) => { failFor = f; } };
}

interface Delivery { org_id: string; live_minutes: string; replay_minutes: string; live_through: string | null; replay_through: string | null; updated_at: Date }
const deliveryOf = async (sid: string): Promise<Delivery | null> => (await sql<Delivery[]>`
  select org_id, live_minutes::text, replay_minutes::text, live_measured_through::text as live_through,
         replay_measured_through::text as replay_through, updated_at
    from fixture_video_delivery where session_id = ${sid}`)[0] ?? null;

/** A Seazn session with `parts` recordings moved onto the replay fake (every part playable), by the real producers. */
async function world(parts = 1) {
  const r = await seaznRig();
  const host = new FakeReplayHost();
  const f = r.fixtureIds[0];
  const m = await movedReplays(r, f, host, { parts });
  const [s] = await sql<{ created_at: Date; ingest_input_uid: string | null }[]>`select created_at, ingest_input_uid from fixture_stream_sessions where id = ${m.sid}`;
  const [prog] = await sql<{ uid: string }[]>`select ingest_input_id as uid from fixture_stream_inputs where session_id = ${m.sid} and role = 'programme'`;
  expect(s!.ingest_input_uid, "PREMISE: the session's own uid is its programme input's").toBe(prog!.uid);
  return { ...r, host, f, ...m, createdAt: new Date(s!.created_at), inputUid: prog!.uid, videoUids: m.rows.map((x) => x.cf_video_id), copies: m.rows.map((x) => x.bunny_video_id!) };
}
const scope = (...orgIds: string[]) => ({ orgIds });

describe.skipIf(!HAS_DB)("measureSeaznDelivery — live minutes (Cloudflare)", () => {
  it("EMPTY CASE FIRST: an org with no ended Seazn session — only a YouTube one, and a Seazn one still live — asks Cloudflare nothing and writes nothing", async () => {
    const r = await seaznRig();
    const yt = await live(r, r.fixtureIds[0], r.pasted);
    await stopAndSettle(r, r.fixtureIds[0], yt);
    const open = await live(r, r.fixtureIds[1], r.seazn);
    const cf = fakeLive();
    const host = new FakeReplayHost();
    const res = await measureSeaznDelivery({ liveMinutes: cf.read, replay: host }, slot(new Date(), 2), scope(r.auth.orgId));
    expect(res).toEqual({ measured: 0, failed: 0, gone: 0, skipped: 0 });
    expect(cf.calls).toEqual([]);
    expect(await deliveryOf(yt)).toBeNull();
    expect(await deliveryOf(open)).toBeNull();
  });

  it("the brief's case (every uid asked is summed — the input's 12.5 is the fake's, a real input answers 0): {input: 12.5, video: 3} stores live_minutes 15.5 through yesterday; a second run the same day asks nothing and does not double it; the next day's run reads only the new day and ADDS it", async () => {
    sentry.captureError.mockClear();
    const w = await world(1);
    const cf = fakeLive({ [w.inputUid]: 12.5, [w.videoUids[0]!]: 3 });
    const deps = { liveMinutes: cf.read, replay: w.host };
    const day1 = slot(w.createdAt, 2);
    expect(await measureSeaznDelivery(deps, day1, scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 0, skipped: 0 });
    // One query, for the programme input AND its recording, from the session's first UTC date through yesterday.
    expect(cf.calls).toEqual([{ uids: [w.inputUid, w.videoUids[0]!].sort(), from: ymd(w.createdAt), to: ymd(daysAfter(w.createdAt, 1)) }]);
    const first = await deliveryOf(w.sid);
    expect(first).toMatchObject({ org_id: w.auth.orgId, live_minutes: "15.5", live_through: ymd(daysAfter(w.createdAt, 1)) });

    // The same day again (a re-run, a second cron firing): nothing asked, nothing added.
    expect(await measureSeaznDelivery(deps, new Date(day1.getTime() + 6 * 3_600_000), scope(w.auth.orgId))).toEqual({ measured: 0, failed: 0, gone: 0, skipped: 0 });
    expect(cf.calls).toHaveLength(1);
    expect((await deliveryOf(w.sid))!.live_minutes, "not doubled").toBe("15.5");

    // The next day: exactly the one new day, its minutes ADDED; updated_at moves with the write (T29 carry m2).
    cf.minutes[w.inputUid] = 2;
    cf.minutes[w.videoUids[0]!] = 0;
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 0, skipped: 0 });
    expect(cf.calls[1]).toEqual({ uids: [w.inputUid, w.videoUids[0]!].sort(), from: ymd(daysAfter(w.createdAt, 2)), to: ymd(daysAfter(w.createdAt, 2)) });
    const next = await deliveryOf(w.sid);
    expect(next).toMatchObject({ live_minutes: "17.5", live_through: ymd(daysAfter(w.createdAt, 2)) });
    expect(new Date(next!.updated_at).getTime(), "the update stamps updated_at").toBeGreaterThan(new Date(first!.updated_at).getTime());
    expect(sentry.captureError).not.toHaveBeenCalled();
  });

  it("two passes RACING on one session (both read it unmeasured before either writes) add its days ONCE: the second write finds the day already stored and adds nothing", async () => {
    const w = await world(1);
    const answers = { [w.inputUid]: 12.5, [w.videoUids[0]!]: 3 };
    // A barrier in the reader: neither pass gets Cloudflare's answer until both have asked, so both selected the row unmeasured.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const read: LiveMinutesReader = async (uids) => {
      if (++arrived === 2) release();
      await both;
      return Object.fromEntries(uids.map((u) => [u, answers[u] ?? 0]));
    };
    const deps = { liveMinutes: read, replay: w.host };
    const now = slot(w.createdAt, 2);
    const results = await Promise.all([measureSeaznDelivery(deps, now, scope(w.auth.orgId)), measureSeaznDelivery(deps, now, scope(w.auth.orgId))]);
    expect(arrived, "PREMISE: both passes asked Cloudflare").toBe(2);
    expect((await deliveryOf(w.sid))!.live_minutes, "once, not 31.0").toBe("15.5");
    expect(results.map((r) => r.failed)).toEqual([0, 0]);
  });

  it("a session is read while it ended within SEAZN_LIVE_MEASURE_DAYS — a minute inside the edge — and never a minute past it, while its replay is still read", async () => {
    const w = await world(1);
    const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${w.sid}`;
    const edge = new Date(ended_at).getTime() + SEAZN_LIVE_MEASURE_DAYS * DAY_MS;
    const cf = fakeLive({ [w.inputUid]: 1 });
    const deps = { liveMinutes: cf.read, replay: w.host };
    await measureSeaznDelivery(deps, new Date(edge - 60_000), scope(w.auth.orgId));
    expect(cf.calls, "a minute inside the edge: read").toHaveLength(1);
    // Review m6: each probe starts UNMEASURED, so only the end-date rule decides — the same-day rule would hide the second probe,
    // and a probe a day past the edge lets a rule a day too wide pass.
    await sql`delete from fixture_video_delivery where session_id = ${w.sid}`;
    const windowsBefore = w.host.watchWindows(w.copies[0]!).length;
    await measureSeaznDelivery(deps, new Date(edge + 60_000), scope(w.auth.orgId));
    expect(cf.calls, "a minute past it: never asked again").toHaveLength(1);
    expect(w.host.watchWindows(w.copies[0]!).length, "the replay has no such limit").toBe(windowsBefore + 1);
  });

  it("a read that THROWS is counted and reported ONCE for the pass, writes nothing for that session, and never stops the next session's; the next run reads the failed one's whole window (nothing lost)", async () => {
    const r = await seaznRig();
    const sids: string[] = [];
    for (const f of r.fixtureIds) {
      const sid = await live(r, f, r.seazn);
      await stopAndSettle(r, f, sid);
      sids.push(sid);
    }
    const [a, b] = sids as [string, string];
    // Task 31b: both sessions start on one instant, so they share a window — and the batched query.
    await sql`update fixture_stream_sessions set created_at = (select created_at from fixture_stream_sessions where id = ${a}) where id = ${b}`;
    const [{ uid: aInput }] = await sql<{ uid: string }[]>`select ingest_input_uid as uid from fixture_stream_sessions where id = ${a}`;
    const [{ uid: bInput }] = await sql<{ uid: string }[]>`select ingest_input_uid as uid from fixture_stream_sessions where id = ${b}`;
    const [{ created_at }] = await sql<{ created_at: Date }[]>`select min(created_at) as created_at from fixture_stream_sessions where id in (${a}, ${b})`;
    const cf = fakeLive();
    cf.failWhen((uids) => uids.includes(aInput));
    sentry.captureError.mockClear();
    const now = slot(new Date(created_at), 2);
    const deps = { liveMinutes: cf.read, replay: new FakeReplayHost() };
    expect(await measureSeaznDelivery(deps, now, scope(r.auth.orgId))).toEqual({ measured: 1, failed: 1, gone: 0, skipped: 0 });
    // Task 31b: the shared query is refused, so each session is asked ALONE — a's refusal holds back only a.
    expect(cf.calls[0]!.uids, "the batch: both sessions' uids").toEqual([aInput, bInput].sort());
    expect(cf.calls.slice(1).map((c) => c.uids).sort(), "then each session alone").toEqual([[aInput], [bInput]].sort());
    expect(await deliveryOf(a), "the failed session: no row").toBeNull();
    expect(await deliveryOf(b), "the other session: measured").toMatchObject({ live_minutes: "0.0", live_through: ymd(daysAfter(new Date(created_at), 1)) });
    const reports = sentry.captureError.mock.calls;
    expect(reports, "ONE report for the pass").toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({ route: "relay.sweep.seazn_measure", extra: { failed: 1, sessionIds: [a] } });
    // Cloudflare answers again the next day: the failed session's window starts at its first day, not at yesterday.
    cf.failWhen(null);
    cf.minutes[aInput] = 4;
    await measureSeaznDelivery(deps, slot(new Date(created_at), 3), scope(r.auth.orgId));
    const retried = cf.calls.filter((c) => c.uids.includes(aInput));
    expect(retried.at(-1)).toMatchObject({ from: ymd(new Date(created_at)), to: ymd(daysAfter(new Date(created_at), 2)) });
    expect(await deliveryOf(a)).toMatchObject({ live_minutes: "4.0", live_through: ymd(daysAfter(new Date(created_at), 2)) });
  });

  // ─── Task 31b (T31 review m11): the scale guard ────────────────────────────────────────────────────────────────────────────────
  /** `n` Seazn sessions of one org, live then ended by the real producers (the rig's two fixtures in turn: a stopped match started
   *  again is a new session), all started on ONE instant, so their daily windows are the same; their input uids, in session order. */
  async function endedSessions(n: number) {
    const r = await seaznRig();
    const sids: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = r.fixtureIds[i % r.fixtureIds.length]!;
      const sid = await live(r, f, r.seazn);
      await stopAndSettle(r, f, sid);
      sids.push(sid);
    }
    await sql`update fixture_stream_sessions set created_at = (select min(created_at) from fixture_stream_sessions where id in ${sql(sids)}) where id in ${sql(sids)}`;
    const rows = await sql<{ id: string; uid: string; created_at: Date }[]>`select id, ingest_input_uid as uid, created_at from fixture_stream_sessions where id in ${sql(sids)}`;
    const uidOf = new Map(rows.map((x) => [x.id, x.uid]));
    expect(rows.length, "PREMISE: every session made").toBe(n);
    expect(new Set(uidOf.values()).size, "PREMISE: each session its own input uid").toBe(n);
    return { orgId: r.auth.orgId, sids, uids: sids.map((x) => uidOf.get(x)!), createdAt: new Date(rows[0]!.created_at) };
  }

  it("Task 31b: sessions sharing a window are read in ONE query naming every session's uids, and each stores only its own uids' minutes; a session on another window is its own query", async () => {
    const t = await endedSessions(2);
    const [a, b] = t.sids as [string, string];
    const [aUid, bUid] = t.uids as [string, string];
    const cf = fakeLive({ [aUid]: 5, [bUid]: 7 });
    const deps = { liveMinutes: cf.read, replay: new FakeReplayHost() };
    expect(await measureSeaznDelivery(deps, slot(t.createdAt, 2), scope(t.orgId))).toEqual({ measured: 2, failed: 0, gone: 0, skipped: 0 });
    expect(cf.calls, "one query for both").toEqual([{ uids: [aUid, bUid].sort(), from: ymd(t.createdAt), to: ymd(daysAfter(t.createdAt, 1)) }]);
    expect([(await deliveryOf(a))!.live_minutes, (await deliveryOf(b))!.live_minutes], "each its own").toEqual(["5.0", "7.0"]);
    // b started a day earlier: two windows, two queries.
    await sql`delete from fixture_video_delivery where session_id in (${a}, ${b})`;
    await sql`update fixture_stream_sessions set created_at = created_at - interval '1 day' where id = ${b}`;
    expect(await measureSeaznDelivery(deps, slot(t.createdAt, 2), scope(t.orgId))).toMatchObject({ measured: 2, failed: 0 });
    expect(cf.calls.slice(1).map((c) => [c.uids, c.from]).sort(), "a query per window").toEqual([
      [[aUid], ymd(t.createdAt)], [[bUid], ymd(daysAfter(t.createdAt, -1))],
    ].sort());
  });

  it("Task 31b: Cloudflare failing every query — the live pass stops after SEAZN_LIVE_MEASURE_BREAKER_FAILURES in a row: the rest are counted skipped, nothing is written, ONE report names the skipped count, and the next day reads them all", async () => {
    const K = SEAZN_LIVE_MEASURE_BREAKER_FAILURES;
    const n = K + 2;
    const t = await endedSessions(n);
    const cf = fakeLive();
    cf.failWhen(() => true);
    sentry.captureError.mockClear();
    const warn = vi.spyOn(log, "warn");
    const deps = { liveMinutes: cf.read, replay: new FakeReplayHost() };
    // The shared query, then each session alone — until K queries in a row have failed.
    const res = await measureSeaznDelivery(deps, slot(t.createdAt, 2), scope(t.orgId));
    expect(cf.calls, "exactly K queries").toHaveLength(K);
    expect(res, "the batch and K - 1 sessions asked; the rest never").toEqual({ measured: 0, failed: K - 1, gone: 0, skipped: n - (K - 1) });
    for (const sid of t.sids) expect(await deliveryOf(sid), sid).toBeNull();
    expect(sentry.captureError, "ONE report for the pass").toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "relay.sweep.seazn_measure", extra: { failed: K - 1, skipped: n - (K - 1) } });
    expect(warn.mock.calls.filter(([, m]) => typeof m === "string" && m.includes("in a row")), "the stop warned once").toHaveLength(1);
    warn.mockRestore();
    cf.failWhen(null);
    expect(await measureSeaznDelivery(deps, slot(t.createdAt, 3), scope(t.orgId)), "the next day: all read, in one query").toEqual({ measured: n, failed: 0, gone: 0, skipped: 0 });
    expect(cf.calls.slice(K), "one query").toHaveLength(1);
    expect(cf.calls[K]!.from, "from each session's first day").toBe(ymd(t.createdAt));
  });

  it("Task 31b: a shared answer that names no minutes for one session's uid fails THAT session — never read as 0 with its day stored — while the other session in the query stores its own", async () => {
    const t = await endedSessions(2);
    const [a, b] = t.sids as [string, string];
    const [aUid, bUid] = t.uids as [string, string];
    const asked: string[][] = [];
    const read: LiveMinutesReader = async (uids) => {
      asked.push([...uids]);
      return { [bUid]: 3 };   // a's uid absent
    };
    expect(await measureSeaznDelivery({ liveMinutes: read, replay: new FakeReplayHost() }, slot(t.createdAt, 2), scope(t.orgId)))
      .toEqual({ measured: 1, failed: 1, gone: 0, skipped: 0 });
    expect(asked.map((u) => [...u].sort()), "PREMISE: one shared query").toEqual([[aUid, bUid].sort()]);
    expect(await deliveryOf(a), "a: nothing stored").toBeNull();
    expect((await deliveryOf(b))!.live_minutes).toBe("3.0");
  });

  it("Task 31b: a query that ANSWERS between failures resets the count — the pass never stops on failures that are not in a row", async () => {
    const t = await endedSessions(5);
    // The pass asks in session order — `created_at`, then id; one instant here, so by id.
    const second = [...t.sids].sort()[1]!;
    const okUid = t.uids[t.sids.indexOf(second)]!;
    const cf = fakeLive({ [okUid]: 2 });
    // Every query fails except the one asking for the second session alone: F (the batch), F, ok, F, F, F — never K in a row before
    // the last, so nothing is skipped (without the reset, the third session's failure would be the third in a row).
    cf.failWhen((uids) => !(uids.length === 1 && uids[0] === okUid));
    const res = await measureSeaznDelivery({ liveMinutes: cf.read, replay: new FakeReplayHost() }, slot(t.createdAt, 2), scope(t.orgId));
    expect(cf.calls, "the batch, then all five alone").toHaveLength(6);
    expect(res).toEqual({ measured: 1, failed: 4, gone: 0, skipped: 0 });
    expect((await deliveryOf(second))!.live_minutes).toBe("2.0");
  });

  // T31b review m2: every breaker test above keeps its sessions in ONE window, so two branches only a SECOND window reaches were never
  // witnessed: the stop before a later window's query (that window is never asked once the breaker tripped), and the short-circuit of
  // a window of one session (its failed query IS that session's failure — never asked again alone, so counted once toward K).
  /** Moves `sids` a day earlier: an earlier window, and first in the pass's order (`created_at`, then id). */
  const dayEarlier = (sids: string[]) => sql`update fixture_stream_sessions set created_at = created_at - interval '1 day' where id in ${sql(sids)}`;

  it("T31b m2: the breaker trips inside the FIRST window, and the second window is never asked — its sessions are skipped, K queries in all", async () => {
    const K = SEAZN_LIVE_MEASURE_BREAKER_FAILURES;
    // The first window's shared query, then each of its K - 1 sessions alone: K failures in a row exactly at its last session.
    const first = K - 1;
    expect(first, "PREMISE: the first window holds more than one session, so its query is a shared one").toBeGreaterThan(1);
    const t = await endedSessions(first + 2);
    const early = t.sids.slice(0, first);
    const late = t.sids.slice(first);
    const lateUids = late.map((s) => t.uids[t.sids.indexOf(s)]!);
    await dayEarlier(early);
    const cf = fakeLive();
    cf.failWhen(() => true);
    sentry.captureError.mockClear();
    const res = await measureSeaznDelivery({ liveMinutes: cf.read, replay: new FakeReplayHost() }, slot(t.createdAt, 2), scope(t.orgId));
    expect(cf.calls, "exactly K queries").toHaveLength(K);
    expect(cf.calls.map((c) => c.from), "every one of them the FIRST window's").toEqual(Array(K).fill(ymd(daysAfter(t.createdAt, -1))));
    expect(cf.calls.flatMap((c) => c.uids).filter((u) => lateUids.includes(u)), "the second window's uids: never asked").toEqual([]);
    expect(res, "the first window's sessions failed, the second's skipped").toEqual({ measured: 0, failed: first, gone: 0, skipped: late.length });
    for (const sid of t.sids) expect(await deliveryOf(sid), sid).toBeNull();
    expect(sentry.captureError, "ONE report for the pass").toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "relay.sweep.seazn_measure", extra: { failed: first, skipped: late.length } });
  });

  it("T31b m2: a window of ONE session whose query fails is that session's failure — asked once, never again alone — and the next window is still asked and stored", async () => {
    const t = await endedSessions(2);
    const [a, b] = t.sids as [string, string];
    const [aUid, bUid] = t.uids as [string, string];
    await dayEarlier([a]);
    const cf = fakeLive({ [bUid]: 6 });
    cf.failWhen((uids) => uids.includes(aUid));
    const res = await measureSeaznDelivery({ liveMinutes: cf.read, replay: new FakeReplayHost() }, slot(t.createdAt, 2), scope(t.orgId));
    expect(cf.calls.map((c) => [c.uids, c.from]), "one query per window; a's asked ONCE").toEqual([
      [[aUid], ymd(daysAfter(t.createdAt, -1))], [[bUid], ymd(t.createdAt)],
    ]);
    expect(res).toEqual({ measured: 1, failed: 1, gone: 0, skipped: 0 });
    expect(await deliveryOf(a), "a: nothing stored").toBeNull();
    expect((await deliveryOf(b))!.live_minutes).toBe("6.0");
  });
});

// Phase 3 review I1 (controller ruling 2026-11-24): Cloudflare counts a match's live minutes against its RECORDING uid, and whether
// its analytics still answer for a deleted video is unmeasured. So with SEAZN_HOSTED_COST on the mover keeps the recording's
// Cloudflare copy until THIS pass has measured the session through its end day; and once the copy is gone, Cloudflare answering
// nothing for its uid adds 0 — the stored minutes are never written over with 0. The whole sequence on the real producers: the
// real mover (`w.move`) and the real measure, only the vendor reads faked.
describe.skipIf(!HAS_DB)("I1: the real mover keeps the Cloudflare copy until the real measure has read its session through the end day", () => {
  const MIN = 60_000;
  it("COST on: at verified + 60 min the copy is kept; the pass the day after the match measures the end day; the next mover run deletes the copy; the day after, the gone uid reads 0 and the stored minutes stay — 0 is added, never written over them", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(1);
    const ingest = w.deps.drivers.ingest as FakeIngest;
    const video = w.videoUids[0]!;
    expect(ymd(w.createdAt), "PREMISE: the session started and ended on one UTC day").toBe(ymd(new Date(w.endedAt)));
    // movedReplays verified the copy at t0 + 15 min, so G-D's 60 min are over at t0 + 75 min.
    await w.move(w.t0 + 75 * MIN);
    expect(ingest.deletedVideos, "verified + 60 min, nothing measured yet: the Cloudflare copy is kept").toEqual([]);

    const cf = fakeLive({ [video]: 13 });
    const deps = { liveMinutes: cf.read, replay: w.host };
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 1), scope(w.auth.orgId))).toMatchObject({ measured: 1, failed: 0 });
    expect(await deliveryOf(w.sid), "the end day measured, while the copy is still there").toMatchObject({ live_minutes: "13.0", live_through: ymd(w.createdAt) });

    await w.move(slot(w.createdAt, 1).getTime() + MIN);
    expect(ingest.deletedVideos, "measured through the end day: the mover deletes the recording, by its own id").toEqual([video]);

    // The next day Cloudflare answers nothing for the deleted video (its reader reads that as 0): the day is added, the minutes kept.
    cf.minutes[video] = 0;
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId))).toMatchObject({ measured: 1, failed: 0 });
    expect(cf.calls.at(-1)!.uids, "PREMISE: the gone uid was asked, and answered 0").toContain(video);
    expect(await deliveryOf(w.sid), "13.0 + 0: never written over with 0").toMatchObject({ live_minutes: "13.0", live_through: ymd(daysAfter(w.createdAt, 1)) });
  });
});

describe.skipIf(!HAS_DB)("measureSeaznDelivery — replay minutes (the replay host)", () => {
  it("two copies' watch time is summed per session, each read over whole UTC days (midnight to the last millisecond of yesterday); the same day reads nothing; the next day reads one new day and adds it", async () => {
    const w = await world(2);
    w.host.setWatchMinutes(w.copies[0]!, 4);
    w.host.setWatchMinutes(w.copies[1]!, 1.5);
    const deps = { liveMinutes: fakeLive().read, replay: w.host };
    await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId));
    const firstWindow = { from: new Date(`${ymd(w.createdAt)}T00:00:00.000Z`), to: new Date(`${ymd(daysAfter(w.createdAt, 1))}T23:59:59.999Z`) };
    for (const copy of w.copies) expect(w.host.watchWindows(copy), copy).toEqual([firstWindow]);
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "5.5", replay_through: ymd(daysAfter(w.createdAt, 1)) });

    await measureSeaznDelivery(deps, new Date(slot(w.createdAt, 2).getTime() + 3_600_000), scope(w.auth.orgId));
    for (const copy of w.copies) expect(w.host.watchWindows(copy), `${copy}: no second read the same day`).toHaveLength(1);
    expect((await deliveryOf(w.sid))!.replay_minutes).toBe("5.5");

    await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId));
    const newDay = { from: new Date(`${ymd(daysAfter(w.createdAt, 2))}T00:00:00.000Z`), to: new Date(`${ymd(daysAfter(w.createdAt, 2))}T23:59:59.999Z`) };
    for (const copy of w.copies) expect(w.host.watchWindows(copy)[1], copy).toEqual(newDay);
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "11.0", replay_through: ymd(daysAfter(w.createdAt, 2)) });
  });

  it("a copy the host no longer holds answers null — gone: counted, adds nothing, never fails the session, warned and named in the pass's ONE report (a row not deleted whose copy is gone is a broken public replay) — and stored minutes are NEVER overwritten with 0 when every copy is gone", async () => {
    const w = await world(2);
    w.host.setWatchMinutes(w.copies[0]!, 4);
    w.host.setWatchMinutes(w.copies[1]!, 2);
    await w.host.remove(w.copies[1]!);   // gone from the host while its row still reads playable
    const deps = { liveMinutes: fakeLive().read, replay: w.host };
    sentry.captureError.mockClear();
    const warn = vi.spyOn(log, "warn");
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 1, skipped: 0 });
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "4.0", replay_through: ymd(daysAfter(w.createdAt, 1)) });
    // Review m3: warned, and reported once for the pass — the count and the session, beside the (empty) failures.
    expect(warn.mock.calls.filter(([o]) => (o as { sid?: string }).sid === w.sid && JSON.stringify(o).includes('"gone":1')), "warned").toHaveLength(1);
    expect(sentry.captureError, "ONE report for the pass").toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "relay.sweep.seazn_measure", extra: { failed: 0, gone: 1, goneSessionIds: [w.sid] } });
    await w.host.remove(w.copies[0]!);
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 2, skipped: 0 });
    expect(await deliveryOf(w.sid), "kept, not zeroed; the day still counts as measured").toMatchObject({ replay_minutes: "4.0", replay_through: ymd(daysAfter(w.createdAt, 2)) });
  });

  it("one copy's read THROWING holds the session's whole replay half back — nothing added, the day not stored — so the retry reads every copy once, never one twice", async () => {
    const w = await world(2);
    w.host.setWatchMinutes(w.copies[0]!, 4);
    w.host.setWatchMinutes(w.copies[1]!, 2);
    const read = vi.spyOn(w.host, "watchMinutes");
    read.mockImplementation(async (id, from, to) => {
      if (id === w.copies[1]) throw new Error("bunny watchMinutes: request failed before a response");
      return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);
    });
    sentry.captureError.mockClear();
    const deps = { liveMinutes: fakeLive().read, replay: w.host };
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId))).toMatchObject({ failed: 1 });
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "0.0", replay_through: null });
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    read.mockRestore();
    await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId));
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "6.0", replay_through: ymd(daysAfter(w.createdAt, 1)) });
  });
});

describe.skipIf(!HAS_DB)("measureSeaznDelivery x a part deleted mid-pass (review m1)", () => {
  // The daily pass reads every copy of a session, THEN writes their sum. A part the organiser deletes between the two has its
  // copy's last read ADDED by the delete (from the day after the session's replay_measured_through, up to the delete) — so the
  // pass's sum, which holds the same copy's days, must not be added on top. The pass adds nothing for the session; the next day
  // reads the surviving copies over the whole window again, and the deleted copy never again.
  it("a part DELETED while the pass reads its session: the pass adds nothing (the delete's last read stands alone); the next day reads the surviving copy from its first day, the deleted one never — no day counted twice, none lost", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(2);
    const [a, b] = w.copies as [string, string];
    const d = [0, 1, 2].map((n) => ymd(daysAfter(w.createdAt, n)));
    w.host.setWatchMinutesByDay(a, { [d[0]!]: 1, [d[1]!]: 2, [d[2]!]: 0.5 });
    w.host.setWatchMinutesByDay(b, { [d[0]!]: 0.5, [d[1]!]: 1.5, [d[2]!]: 1 });
    const daily = slot(w.createdAt, 2);
    const deleteAt = new Date(daily.getTime() + 60_000);
    const read = vi.spyOn(w.host, "watchMinutes");
    let interleaved = 0;
    read.mockImplementationOnce(async (id, from, to) => {
      const m = await FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);   // the pass has copy A's answer...
      await deleteSeaznReplay(w.auth, w.f, w.rows[0]!.id, { now: deleteAt, replay: w.host });   // ...then the organiser deletes A
      interleaved++;
      return m;
    });
    const deps = { liveMinutes: fakeLive().read, replay: w.host };
    await measureSeaznDelivery(deps, daily, scope(w.auth.orgId));
    expect(interleaved, "PREMISE: the delete ran inside the pass").toBe(1);
    expect(w.host.watchWindows(a), "PREMISE: A read by the pass, then by its delete up to the delete").toEqual([
      { from: daysAfter(w.createdAt, 0), to: endOfDayAfter(w.createdAt, 1) },
      { from: daysAfter(w.createdAt, 0), to: deleteAt },
    ]);
    expect(await deliveryOf(w.sid), "only A's last read (1 + 2 + 0.5): the pass's A + B is not added, its day not stored").toMatchObject({ replay_minutes: "3.5", replay_through: null });

    await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId));
    expect(w.host.watchWindows(a), "A is never read again").toHaveLength(2);
    expect(w.host.watchWindows(b).at(-1), "B over the whole window again").toEqual({ from: daysAfter(w.createdAt, 0), to: endOfDayAfter(w.createdAt, 2) });
    expect(await deliveryOf(w.sid), "3.5 + B's 0.5 + 1.5 + 1").toMatchObject({ replay_minutes: "6.5", replay_through: d[2] });
  });
});

describe.skipIf(!HAS_DB)("measureSeaznDelivery x a part deleted before the pass's read reaches it (review R2)", () => {
  // The organiser's delete removes the copy between the pass's selection and its read: the host answers null, but the row IS
  // deleted. That is the delete's business (its last read took the copy's days), not a broken public replay — never "gone".
  it("its null is not counted gone, warned or reported; the pass still adds nothing for the session (the delete's last read stands alone)", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(2);
    const [a, b] = w.copies as [string, string];
    const d = [0, 1, 2].map((n) => ymd(daysAfter(w.createdAt, n)));
    w.host.setWatchMinutesByDay(a, { [d[0]!]: 1, [d[1]!]: 2, [d[2]!]: 0.5 });
    w.host.setWatchMinutesByDay(b, { [d[0]!]: 0.5, [d[1]!]: 1.5 });
    const daily = slot(w.createdAt, 2);
    let interleaved = 0;
    vi.spyOn(w.host, "watchMinutes").mockImplementationOnce(async (id, from, to) => {
      await deleteSeaznReplay(w.auth, w.f, w.rows[0]!.id, { now: new Date(daily.getTime() + 60_000), replay: w.host });
      interleaved++;
      return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);   // A's copy: removed by its delete
    });
    sentry.captureError.mockClear();
    const warn = vi.spyOn(log, "warn");
    const res = await measureSeaznDelivery({ liveMinutes: fakeLive().read, replay: w.host }, daily, scope(w.auth.orgId));
    expect(interleaved, "PREMISE: the delete ran before the pass's read of A").toBe(1);
    expect(w.host.videoIds(), "PREMISE: A's copy is gone from the host").not.toContain(a);
    expect(res.gone, "not gone: its row is deleted").toBe(0);
    expect(warn.mock.calls.filter(([o]) => (o as { sid?: string }).sid === w.sid && JSON.stringify(o).includes('"gone"')), "no gone warning").toEqual([]);
    expect(sentry.captureError, "nothing to report").not.toHaveBeenCalled();
    expect(await deliveryOf(w.sid), "A's last read only (1 + 2 + 0.5)").toMatchObject({ replay_minutes: "3.5", replay_through: null });
  });
});

describe.skipIf(!HAS_DB)("purgeDeletedOrgReplays — a deleted org's replays, after the grace", () => {
  it("EMPTY CASE FIRST: no deleted org in scope — nothing purged, the host never asked", async () => {
    const w = await world(1);
    const remove = vi.spyOn(w.host, "remove");
    expect(await purgeDeletedOrgReplays({ replay: w.host }, new Date(), scope(w.auth.orgId))).toEqual({ purged: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("deleted 31 days ago: every replay is deleted (org_deleted) and its copy removed, its minutes read just BEFORE the removal; deleted 29 days ago and an active org keep theirs; a second run purges nothing", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const gone = await world(1);
    const inside = await world(1);
    const active = await world(1);
    const now = new Date();
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${gone.auth.orgId}`;
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS - 1) * DAY_MS)} where id = ${inside.auth.orgId}`;
    gone.host.setWatchMinutes(gone.copies[0]!, 6);
    // One host for all three, so a removal anywhere is seen: the rows name each world's own copy on its own fake.
    const removed: string[] = [];
    const hostFor = new Map([gone, inside, active].flatMap((x) => x.copies.map((c) => [c, x.host] as const)));
    const host = Object.assign(Object.create(FakeReplayHost.prototype) as FakeReplayHost, {
      remove: async (id: string) => { removed.push(id); return hostFor.get(id)!.remove(id); },
      watchMinutes: (id: string, from: Date, to: Date) => hostFor.get(id)!.watchMinutes(id, from, to),
    });
    const s = scope(gone.auth.orgId, inside.auth.orgId, active.auth.orgId);
    expect(await purgeDeletedOrgReplays({ replay: host }, now, s)).toEqual({ purged: 1, failed: 0 });
    const after = Date.now();

    const [row] = await sql<{ state: string; deleted_reason: string | null; deleted_by: string | null; deleted_at: Date; next_attempt_at: Date; attempts: number; bunny_video_id: string | null }[]>`
      select state, deleted_reason, deleted_by, deleted_at, next_attempt_at, attempts, bunny_video_id from fixture_video_replays where id = ${gone.rows[0]!.id}`;
    expect(row).toMatchObject({ state: "deleted", deleted_reason: "org_deleted", deleted_by: null, attempts: 0, bunny_video_id: null });
    // Review m2 / R1: the purge holds the row as a claim does — the move's cleanup is due one lease after the COMMIT (the later of
    // `now` and the wall clock there), never ahead of the last read.
    expect(new Date(row!.deleted_at).getTime(), "deleted now").toBe(now.getTime());
    const due = new Date(row!.next_attempt_at).getTime();
    expect(due, "the cleanup due one lease after the commit").toBeGreaterThanOrEqual(now.getTime() + LEASE_MS);
    expect(due).toBeLessThanOrEqual(after + LEASE_MS);
    expect(removed, "only the deleted org's copy").toEqual([gone.copies[0]]);
    expect(gone.host.videoIds()).not.toContain(gone.copies[0]);
    // The final read came BEFORE the removal: the host still held the copy and answered its minutes.
    expect(gone.host.watchWindows(gone.copies[0]!).map((x) => x.to.getTime())).toEqual([now.getTime()]);
    expect(await deliveryOf(gone.sid)).toMatchObject({ replay_minutes: "6.0", replay_through: null });
    for (const kept of [inside, active]) {
      expect((await sql<{ state: string }[]>`select state from fixture_video_replays where id = ${kept.rows[0]!.id}`)[0]!.state).toBe("playable");
      expect(kept.host.videoIds()).toContain(kept.copies[0]);
      expect(kept.host.watchWindows(kept.copies[0]!), "never read").toEqual([]);
    }

    expect(await purgeDeletedOrgReplays({ replay: host }, new Date(now.getTime() + DAY_MS), s), "the second run").toEqual({ purged: 0, failed: 0 });
    expect(removed).toHaveLength(1);
  });

  it("a removal that THROWS still deletes the row — it keeps the copy's id for the move's cleanup — and is counted and reported once", async () => {
    const w = await world(1);
    const now = new Date();
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${w.auth.orgId}`;
    vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error(`bunny remove: HTTP 503 (video ${w.copies[0]})`));
    sentry.captureError.mockClear();
    expect(await purgeDeletedOrgReplays({ replay: w.host }, now, scope(w.auth.orgId))).toEqual({ purged: 1, failed: 1 });
    const [row] = await sql<{ state: string; deleted_reason: string; bunny_video_id: string | null }[]>`
      select state, deleted_reason, bunny_video_id from fixture_video_replays where id = ${w.rows[0]!.id}`;
    expect(row).toEqual({ state: "deleted", deleted_reason: "org_deleted", bunny_video_id: w.copies[0] });
    expect(w.host.videoIds(), "PREMISE: still on the host").toContain(w.copies[0]);
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "relay.sweep.seazn_purge", extra: { failed: 1 } });

    // Review m5: the row is deleted but still names its copy (the cleanup will remove it). The next day's pass reaches the session
    // (its live half is measured) and never reads that copy — its days were the delete's to read, not the pass's.
    expect(w.host.watchWindows(w.copies[0]!), "PREMISE: flag off, the purge read nothing").toEqual([]);
    await measureSeaznDelivery({ liveMinutes: fakeLive().read, replay: w.host }, new Date(now.getTime() + DAY_MS), scope(w.auth.orgId));
    expect((await deliveryOf(w.sid))?.live_through, "PREMISE: the pass reached the session").not.toBeNull();
    expect(w.host.watchWindows(w.copies[0]!), "a deleted row's copy is not read").toEqual([]);
  });

  it("I1: a copy measured through yesterday has its LAST read start the day after — today only, up to the purge — never the session's first day, so no day is counted twice", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(1);
    const copy = w.copies[0]!;
    const d = [0, 1, 2].map((n) => ymd(daysAfter(w.createdAt, n)));
    w.host.setWatchMinutesByDay(copy, { [d[0]!]: 1.5, [d[1]!]: 2, [d[2]!]: 0.5 });
    const daily = slot(w.createdAt, 2);
    await measureSeaznDelivery({ liveMinutes: fakeLive().read, replay: w.host }, daily, scope(w.auth.orgId));
    expect(await deliveryOf(w.sid), "PREMISE: measured through yesterday (1.5 + 2)").toMatchObject({ replay_minutes: "3.5", replay_through: d[1] });
    const now = new Date(daily.getTime() + 3 * 3_600_000);
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${w.auth.orgId}`;
    expect(await purgeDeletedOrgReplays({ replay: w.host }, now, scope(w.auth.orgId))).toEqual({ purged: 1, failed: 0 });
    expect(w.host.watchWindows(copy), "the pass's whole days, then the purge's from today's midnight up to the purge").toEqual([
      { from: daysAfter(w.createdAt, 0), to: endOfDayAfter(w.createdAt, 1) },
      { from: daysAfter(w.createdAt, 2), to: now },
    ]);
    expect(await deliveryOf(w.sid), "3.5 + today's 0.5 — the first two days never again; the day not moved").toMatchObject({ replay_minutes: "4.0", replay_through: d[1] });
  });

  it("m2: the move's cleanup running while the purge takes a copy's last read does not remove the copy first — the purge holds the row for SEAZN_CLAIM_LEASE_SECONDS — so the minutes since the last pass are kept, and the cleanup takes the row once the lease is out", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(1);
    const copy = w.copies[0]!;
    const now = new Date();
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${w.auth.orgId}`;
    w.host.setWatchMinutes(copy, 6);
    const remove = vi.spyOn(w.host, "remove");
    let moved = 0;
    vi.spyOn(w.host, "watchMinutes").mockImplementationOnce(async (id, from, to) => {
      await w.move(now.getTime());   // a mover run between the purge's commit and its read reaching the host
      moved++;
      return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);
    });
    expect(await purgeDeletedOrgReplays({ replay: w.host }, now, scope(w.auth.orgId))).toEqual({ purged: 1, failed: 0 });
    expect(moved, "PREMISE: the move ran inside the last read").toBe(1);
    expect(remove.mock.calls, "removed once, by the purge, after its read").toEqual([[copy]]);
    expect(await deliveryOf(w.sid), "the copy's minutes kept").toMatchObject({ replay_minutes: "6.0" });
    await w.move(Date.now() + LEASE_MS);
    const [row] = await sql<{ bunny_video_id: string | null; attempts: number }[]>`select bunny_video_id, attempts from fixture_video_replays where id = ${w.rows[0]!.id}`;
    expect(row, "after the lease the cleanup takes the row: nothing left to remove, nothing failed").toEqual({ bunny_video_id: null, attempts: 0 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("R1: a purge handed the sweep's START as `now` — the sweep ran minutes before the purge commits — still holds the row one lease past its COMMIT, so a mover at the wall clock cannot remove the copy ahead of its last read", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(1);
    const copy = w.copies[0]!;
    // The sweep's clock started 5 min (> the 2 min lease) before this purge commits: steps 1-7e ran in between.
    const sweepStart = new Date(Date.now() - 5 * 60_000);
    // The session a day older, so its first UTC day lies before the sweep's start whatever the hour (the last read's window
    // runs from it to `now`).
    await sql`update fixture_stream_sessions set created_at = created_at - interval '1 day' where id = ${w.sid}`;
    await sql`update organizations set deleted_at = ${new Date(sweepStart.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${w.auth.orgId}`;
    w.host.setWatchMinutes(copy, 6);
    const remove = vi.spyOn(w.host, "remove");
    let moved = 0;
    vi.spyOn(w.host, "watchMinutes").mockImplementationOnce(async (id, from, to) => {
      await w.move(Date.now());   // the mover's own run, on the WALL clock, between the purge's commit and its read
      moved++;
      return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);
    });
    const before = Date.now();
    expect(await purgeDeletedOrgReplays({ replay: w.host }, sweepStart, scope(w.auth.orgId))).toEqual({ purged: 1, failed: 0 });
    const after = Date.now();
    expect(moved, "PREMISE: the move ran inside the last read").toBe(1);
    expect(remove.mock.calls, "removed once, by the purge, after its read").toEqual([[copy]]);
    expect(await deliveryOf(w.sid), "the copy's minutes kept").toMatchObject({ replay_minutes: "6.0" });
    const [{ next_attempt_at }] = await sql<{ next_attempt_at: Date }[]>`select next_attempt_at from fixture_video_replays where id = ${w.rows[0]!.id}`;
    const due = new Date(next_attempt_at).getTime();
    expect(due, "one lease after the commit's wall clock, not after the sweep's start").toBeGreaterThanOrEqual(before + LEASE_MS);
    expect(due).toBeLessThanOrEqual(after + LEASE_MS);
  });

  it("m4: a part the organiser deletes AFTER the purge selected it stays the organiser's delete — not re-deleted as org_deleted, its author kept, not counted, its copy not read or removed by the purge", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(2);
    const [a, b] = w.copies as [string, string];
    const now = new Date();
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${w.auth.orgId}`;
    const remove = vi.spyOn(w.host, "remove");
    let interleaved = 0;
    vi.spyOn(w.host, "watchMinutes").mockImplementationOnce(async (id, from, to) => {
      const m = await FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);   // the purge's last read of part 1...
      await deleteSeaznReplay(w.auth, w.f, w.rows[1]!.id, { now, replay: w.host });          // ...while the organiser deletes part 2
      interleaved++;
      return m;
    });
    expect(await purgeDeletedOrgReplays({ replay: w.host }, now, scope(w.auth.orgId)), "part 1 only").toEqual({ purged: 1, failed: 0 });
    expect(interleaved, "PREMISE: part 2 was deleted after the selection").toBe(1);
    const rows = await sql<{ id: string; deleted_reason: string; deleted_by: string | null }[]>`
      select id, deleted_reason, deleted_by from fixture_video_replays where id in (${w.rows[0]!.id}, ${w.rows[1]!.id}) order by part_no`;
    expect(rows.map((r) => [r.deleted_reason, r.deleted_by])).toEqual([["org_deleted", null], ["organiser", w.auth.userId]]);
    expect(remove.mock.calls.flat().sort(), "each copy removed once: part 1 by the purge, part 2 by its delete").toEqual([a, b].sort());
    expect(w.host.watchWindows(b), "part 2's copy read once, by its own delete").toHaveLength(1);
  });
});

// Task 31b (T23 review G1): `fixture_video_replays.fixture_id` is ON DELETE SET NULL (V542), so a fixture deleted by a format change, a
// stage rebuild or a division delete leaves its replay rows with no fixture — on no page (the view inner-joins fixtures), while the
// copy stays stored and billed. The fixture here is deleted for real: the FK's own action is what nulls the rows (no row is written
// by hand). The pass deletes each such row as the org purge does — `fixture_deleted`, no author, the cleanup one lease after the
// commit — its copy's last read first, then the removal.
describe.skipIf(!HAS_DB)("purgeFixturelessReplays — a deleted fixture's replays (Task 31b)", () => {
  const orphan = async (w: Awaited<ReturnType<typeof world>>) => {
    await sql`delete from fixtures where id = ${w.f}`;
    const rows = await sql<{ fixture_id: string | null }[]>`select fixture_id from fixture_video_replays where session_id = ${w.sid}`;
    expect(rows.length, "PREMISE: the rows survive the fixture").toBe(w.rows.length);
    expect(rows.every((x) => x.fixture_id === null), "PREMISE: the FK nulled every row").toBe(true);
  };

  it("EMPTY CASE FIRST: every replay still has its fixture — nothing purged, the host never asked", async () => {
    const w = await world(1);
    const remove = vi.spyOn(w.host, "remove");
    const read = vi.spyOn(w.host, "watchMinutes");
    expect(await purgeFixturelessReplays({ replay: w.host }, new Date(), scope(w.auth.orgId))).toEqual({ purged: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("the fixture deleted: every part is deleted (fixture_deleted, no author, attempts 0, the cleanup one lease after the commit), its minutes read just BEFORE its copy is removed; a fixture still there keeps its replay; a second run purges nothing", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const gone = await world(2);
    const kept = await world(1);
    gone.host.setWatchMinutes(gone.copies[0]!, 4);
    gone.host.setWatchMinutes(gone.copies[1]!, 1.5);
    await orphan(gone);
    const removed: string[] = [];
    const hostFor = new Map([gone, kept].flatMap((x) => x.copies.map((c) => [c, x.host] as const)));
    const host = Object.assign(Object.create(FakeReplayHost.prototype) as FakeReplayHost, {
      remove: async (id: string) => { removed.push(id); return hostFor.get(id)!.remove(id); },
      watchMinutes: (id: string, from: Date, to: Date) => hostFor.get(id)!.watchMinutes(id, from, to),
    });
    const s = scope(gone.auth.orgId, kept.auth.orgId);
    const now = new Date();
    expect(await purgeFixturelessReplays({ replay: host }, now, s)).toEqual({ purged: 2, failed: 0 });
    const after = Date.now();
    const rows = await sql<{ state: string; deleted_reason: string | null; deleted_by: string | null; deleted_at: Date; next_attempt_at: Date; attempts: number; bunny_video_id: string | null }[]>`
      select state, deleted_reason, deleted_by, deleted_at, next_attempt_at, attempts, bunny_video_id from fixture_video_replays where session_id = ${gone.sid} order by part_no`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "deleted", deleted_reason: "fixture_deleted", deleted_by: null, attempts: 0, bunny_video_id: null });
      expect(new Date(row.deleted_at).getTime()).toBe(now.getTime());
      const due = new Date(row.next_attempt_at).getTime();
      expect(due, "the cleanup due one lease after the commit").toBeGreaterThanOrEqual(now.getTime() + LEASE_MS);
      expect(due).toBeLessThanOrEqual(after + LEASE_MS);
    }
    expect(removed.sort(), "both of the deleted fixture's copies, nothing else").toEqual([...gone.copies].sort());
    for (const c of gone.copies) {
      expect(gone.host.videoIds()).not.toContain(c);
      expect(gone.host.watchWindows(c).map((x) => x.to.getTime()), `${c}: read once, up to now, before its removal`).toEqual([now.getTime()]);
    }
    expect(await deliveryOf(gone.sid)).toMatchObject({ replay_minutes: "5.5", replay_through: null });
    expect((await sql<{ state: string }[]>`select state from fixture_video_replays where id = ${kept.rows[0]!.id}`)[0]!.state).toBe("playable");
    expect(kept.host.videoIds()).toContain(kept.copies[0]);
    expect(kept.host.watchWindows(kept.copies[0]!), "never read").toEqual([]);

    expect(await purgeFixturelessReplays({ replay: host }, new Date(now.getTime() + DAY_MS), s), "the second run").toEqual({ purged: 0, failed: 0 });
    expect(removed).toHaveLength(2);
  });

  it("a part already deleted (the organiser's) keeps its reason and author and is not counted; a part holding no copy is deleted without asking the host", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world(2);
    await deleteSeaznReplay(w.auth, w.f, w.rows[0]!.id, { now: new Date(), replay: w.host });
    // Part 2 lost its copy (a failed row's removal went through: item 2's give_up), still not deleted.
    await w.host.remove(w.copies[1]!);
    await sql`update fixture_video_replays set state = 'failed', bunny_video_id = null where id = ${w.rows[1]!.id}`;
    await orphan(w);
    const remove = vi.spyOn(w.host, "remove");
    const read = vi.spyOn(w.host, "watchMinutes");
    expect(await purgeFixturelessReplays({ replay: w.host }, new Date(), scope(w.auth.orgId))).toEqual({ purged: 1, failed: 0 });
    const rows = await sql<{ deleted_reason: string; deleted_by: string | null; state: string }[]>`
      select deleted_reason, deleted_by, state from fixture_video_replays where session_id = ${w.sid} order by part_no`;
    expect(rows.map((r) => [r.state, r.deleted_reason, r.deleted_by])).toEqual([["deleted", "organiser", w.auth.userId], ["deleted", "fixture_deleted", null]]);
    expect(remove, "nothing left to remove").not.toHaveBeenCalled();
    expect(read, "nothing left to read").not.toHaveBeenCalled();
  });

  it("a removal that THROWS still deletes the row — it keeps the copy's id for the move's cleanup — and is counted and reported ONCE, on its own route", async () => {
    const w = await world(1);
    await orphan(w);
    vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error(`bunny remove: HTTP 503 (video ${w.copies[0]})`));
    sentry.captureError.mockClear();
    expect(await purgeFixturelessReplays({ replay: w.host }, new Date(), scope(w.auth.orgId))).toEqual({ purged: 1, failed: 1 });
    const [row] = await sql<{ state: string; deleted_reason: string; bunny_video_id: string | null }[]>`
      select state, deleted_reason, bunny_video_id from fixture_video_replays where id = ${w.rows[0]!.id}`;
    expect(row).toEqual({ state: "deleted", deleted_reason: "fixture_deleted", bunny_video_id: w.copies[0] });
    expect(w.host.videoIds(), "PREMISE: still on the host").toContain(w.copies[0]);
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "relay.sweep.seazn_fixtureless", extra: { failed: 1, sessionIds: [w.sid] } });
  });

  it("the org purge and this pass never take each other's rows: a deleted org's fixture-held replay is org_deleted, a live org's fixtureless one is fixture_deleted", async () => {
    const orgGone = await world(1);
    const fixtureGone = await world(1);
    const now = new Date();
    await sql`update organizations set deleted_at = ${new Date(now.getTime() - (SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS + 1) * DAY_MS)} where id = ${orgGone.auth.orgId}`;
    await orphan(fixtureGone);
    const s = scope(orgGone.auth.orgId, fixtureGone.auth.orgId);
    expect(await purgeFixturelessReplays({ replay: fixtureGone.host }, now, s), "only the fixtureless row").toEqual({ purged: 1, failed: 0 });
    expect(await purgeDeletedOrgReplays({ replay: orgGone.host }, now, s), "only the deleted org's row").toEqual({ purged: 1, failed: 0 });
    const reasons = await sql<{ id: string; deleted_reason: string }[]>`
      select id, deleted_reason from fixture_video_replays where id in (${orgGone.rows[0]!.id}, ${fixtureGone.rows[0]!.id})`;
    expect(Object.fromEntries(reasons.map((r) => [r.id, r.deleted_reason]))).toEqual({
      [orgGone.rows[0]!.id]: "org_deleted", [fixtureGone.rows[0]!.id]: "fixture_deleted",
    });
  });
});

describe.skipIf(!HAS_DB)("seaznVideoForOrg — the staff view's rows", () => {
  it("EMPTY CASE FIRST, then the row: an org with only a YouTube session reads []; a measured Seazn session reads its fixture, end, minutes as stored, the day each runs through, and every part — another org's read never sees it", async () => {
    const r = await seaznRig();
    const yt = await live(r, r.fixtureIds[0], r.pasted);
    await stopAndSettle(r, r.fixtureIds[0], yt);
    expect(await seaznVideoForOrg(r.auth.orgId), "only a YouTube session: nothing").toEqual([]);

    const w = await world(2);
    const cf = fakeLive({ [w.inputUid]: 12.5, [w.videoUids[0]!]: 3 });
    w.host.setWatchMinutes(w.copies[0]!, 4);
    await measureSeaznDelivery({ liveMinutes: cf.read, replay: w.host }, slot(w.createdAt, 2), scope(w.auth.orgId));
    await w.host.remove(w.copies[1]!);
    await sql`update fixture_video_replays set state = 'deleted', deleted_at = now(), deleted_reason = 'organiser' where id = ${w.rows[1]!.id}`;
    const [names] = await sql<{ home: string; away: string; ended_at: Date }[]>`
      select he.display_name as home, ae.display_name as away, s.ended_at
        from fixture_stream_sessions s join fixtures f on f.id = s.fixture_id
        join entrants he on he.id = f.home_entrant_id join entrants ae on ae.id = f.away_entrant_id where s.id = ${w.sid}`;
    expect(await seaznVideoForOrg(w.auth.orgId)).toEqual([{
      sessionId: w.sid, fixture: `${names!.home} v ${names!.away}`, endedAt: new Date(names!.ended_at),
      liveMinutes: "15.5", replayMinutes: "4.0", liveThrough: ymd(daysAfter(w.createdAt, 1)), replayThrough: ymd(daysAfter(w.createdAt, 1)),
      parts: [{ partNo: 1, state: "playable", deletedReason: null }, { partNo: 2, state: "deleted", deletedReason: "organiser" }],
    }]);
    expect(await seaznVideoForOrg(r.auth.orgId), "another org's read").toEqual([]);
  });
});

// A scope nobody owns never reads as "everything" (relay-sweep's SweepScopeEmpty rule).
describe("an EMPTY scope is refused by name", () => {
  it("measure and both purges refuse orgIds: []", async () => {
    const deps = { liveMinutes: fakeLive().read, replay: new FakeReplayHost() };
    await expect(measureSeaznDelivery(deps, new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    await expect(purgeDeletedOrgReplays(deps, new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    await expect(purgeFixturelessReplays(deps, new Date(), { orgIds: [] }), "Task 31b").rejects.toThrow(/orgIds is empty/);
    expect(randomUUID()).toBeTruthy();
  });
});
