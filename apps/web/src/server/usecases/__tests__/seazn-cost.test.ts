// Seazn-hosted video Task 31 (Phase 3, SEAZN_HOSTED_COST): the daily measurement of delivered minutes, and the deleted-org purge.
//
// The rules (the brief, and the controller's rulings of 2026-11-23), typed here — never read back from the module:
//   * LIVE minutes of a Seazn session that ended within SEAZN_LIVE_MEASURE_DAYS are the SUM of what Cloudflare reports for its
//     programme input uid AND each of its recordings' video uids (ruling 1: the brief's 12.5 + 3 = 15.5);
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
import { SEAZN_LIVE_MEASURE_DAYS, SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS } from "@/server/relay/config";
import type { LiveMinutesReader } from "@/server/video/cf-analytics";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { movedReplays } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, live, seaznRig, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { measureSeaznDelivery, purgeDeletedOrgReplays, seaznVideoForOrg } from "../seazn-cost";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 86_400_000;

installSeaznEnv("t31-seazn-cost");

/** A UTC date as `YYYY-MM-DD`, and `n` days after it — the expected windows, worked out here from the rule. */
const ymd = (at: Date) => at.toISOString().slice(0, 10);
const midnight = (at: Date) => new Date(`${ymd(at)}T00:00:00.000Z`);
const daysAfter = (at: Date, n: number) => new Date(midnight(at).getTime() + n * DAY_MS);
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
    expect(res).toEqual({ measured: 0, failed: 0, gone: 0 });
    expect(cf.calls).toEqual([]);
    expect(await deliveryOf(yt)).toBeNull();
    expect(await deliveryOf(open)).toBeNull();
  });

  it("the brief's case: {input: 12.5, video: 3} stores live_minutes 15.5 through yesterday; a second run the same day asks nothing and does not double it; the next day's run reads only the new day and ADDS it", async () => {
    sentry.captureError.mockClear();
    const w = await world(1);
    const cf = fakeLive({ [w.inputUid]: 12.5, [w.videoUids[0]!]: 3 });
    const deps = { liveMinutes: cf.read, replay: w.host };
    const day1 = slot(w.createdAt, 2);
    expect(await measureSeaznDelivery(deps, day1, scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 0 });
    // One query, for the programme input AND its recording, from the session's first UTC date through yesterday.
    expect(cf.calls).toEqual([{ uids: [w.inputUid, w.videoUids[0]!].sort(), from: ymd(w.createdAt), to: ymd(daysAfter(w.createdAt, 1)) }]);
    const first = await deliveryOf(w.sid);
    expect(first).toMatchObject({ org_id: w.auth.orgId, live_minutes: "15.5", live_through: ymd(daysAfter(w.createdAt, 1)) });

    // The same day again (a re-run, a second cron firing): nothing asked, nothing added.
    expect(await measureSeaznDelivery(deps, new Date(day1.getTime() + 6 * 3_600_000), scope(w.auth.orgId))).toEqual({ measured: 0, failed: 0, gone: 0 });
    expect(cf.calls).toHaveLength(1);
    expect((await deliveryOf(w.sid))!.live_minutes, "not doubled").toBe("15.5");

    // The next day: exactly the one new day, its minutes ADDED; updated_at moves with the write (T29 carry m2).
    cf.minutes[w.inputUid] = 2;
    cf.minutes[w.videoUids[0]!] = 0;
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 0 });
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

  it("a session is read while it ended within SEAZN_LIVE_MEASURE_DAYS — and never after: the day past it asks Cloudflare nothing, while its replay is still read", async () => {
    const w = await world(1);
    const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${w.sid}`;
    const ended = new Date(ended_at).getTime();
    const cf = fakeLive({ [w.inputUid]: 1 });
    const deps = { liveMinutes: cf.read, replay: w.host };
    await measureSeaznDelivery(deps, new Date(ended + (SEAZN_LIVE_MEASURE_DAYS - 1) * DAY_MS), scope(w.auth.orgId));
    expect(cf.calls, "inside the window: read").toHaveLength(1);
    const windowsBefore = w.host.watchWindows(w.copies[0]!).length;
    await measureSeaznDelivery(deps, new Date(ended + (SEAZN_LIVE_MEASURE_DAYS + 1) * DAY_MS + 60_000), scope(w.auth.orgId));
    expect(cf.calls, "past it: never asked again").toHaveLength(1);
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
    const [{ uid: aInput }] = await sql<{ uid: string }[]>`select ingest_input_uid as uid from fixture_stream_sessions where id = ${a}`;
    const [{ created_at }] = await sql<{ created_at: Date }[]>`select min(created_at) as created_at from fixture_stream_sessions where id in (${a}, ${b})`;
    const cf = fakeLive();
    cf.failWhen((uids) => uids.includes(aInput));
    sentry.captureError.mockClear();
    const now = slot(new Date(created_at), 2);
    const deps = { liveMinutes: cf.read, replay: new FakeReplayHost() };
    expect(await measureSeaznDelivery(deps, now, scope(r.auth.orgId))).toEqual({ measured: 1, failed: 1, gone: 0 });
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

  it("a copy the host no longer holds answers null — gone: counted, adds nothing, never fails the session — and stored minutes are NEVER overwritten with 0 when every copy is gone", async () => {
    const w = await world(2);
    w.host.setWatchMinutes(w.copies[0]!, 4);
    w.host.setWatchMinutes(w.copies[1]!, 2);
    await w.host.remove(w.copies[1]!);   // gone from the host while its row still reads playable
    const deps = { liveMinutes: fakeLive().read, replay: w.host };
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 2), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 1 });
    expect(await deliveryOf(w.sid)).toMatchObject({ replay_minutes: "4.0", replay_through: ymd(daysAfter(w.createdAt, 1)) });
    await w.host.remove(w.copies[0]!);
    expect(await measureSeaznDelivery(deps, slot(w.createdAt, 3), scope(w.auth.orgId))).toEqual({ measured: 1, failed: 0, gone: 2 });
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

    const [row] = await sql<{ state: string; deleted_reason: string | null; deleted_by: string | null; deleted_at: Date; next_attempt_at: Date; attempts: number; bunny_video_id: string | null }[]>`
      select state, deleted_reason, deleted_by, deleted_at, next_attempt_at, attempts, bunny_video_id from fixture_video_replays where id = ${gone.rows[0]!.id}`;
    expect(row).toMatchObject({ state: "deleted", deleted_reason: "org_deleted", deleted_by: null, attempts: 0, bunny_video_id: null });
    expect([row!.deleted_at, row!.next_attempt_at].map((d) => new Date(d).getTime()), "deleted now; the move's cleanup due now").toEqual([now.getTime(), now.getTime()]);
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
  it("measure and purge both refuse orgIds: []", async () => {
    const deps = { liveMinutes: fakeLive().read, replay: new FakeReplayHost() };
    await expect(measureSeaznDelivery(deps, new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    await expect(purgeDeletedOrgReplays(deps, new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    expect(randomUUID()).toBeTruthy();
  });
});
