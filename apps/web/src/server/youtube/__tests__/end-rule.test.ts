// YouTube Connect T13 (spec §6.4 with owner D4/D5; plan P5, R2; preflight F8): the end rule — WHEN a YouTube broadcast is
// due to be ended, from the facts of the sessions that used it and its fixture's result.
//
// Expected values are the spec's literals, typed here and never imported from end-rule.ts: 5 minutes of grace after Stop
// (D4), 2 minutes after Stop — or after the result, when it lands inside the grace — once the match is finished (D5); the
// finished set {decided, finalized} (owner, D5) plus {forfeited, abandoned, cancelled} (spec §6.4), and never
// needs_decision (F8). The whole fixture-status set is typed from V432's fixtures_status_check, and a DB test holds that
// typed list to the live constraint, so the "every other status" sweep cannot go stale under a new status.
//
// Two halves: the pure rule (no DB) and its one reader, readEndFacts, over real Postgres (skipped without DATABASE_URL like
// every DB suite here). The DB half drives the facts through their REAL producers where one exists — the connection and its
// API destination through the connect save, a pasted destination through insertStreamTarget, finished_at through the
// fixtures_track_finished trigger — and folds what the reader returns through the real rule.
//
// Sport: not applicable — ending a YouTube broadcast reads a fixture's status and a session's times, never a sport rule.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { insertStreamTarget } from "@/server/relay/secret-columns";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { EndRuleInvariantError, broadcastEndDueAt, readEndFacts, type EndFacts } from "@/server/youtube/end-rule";
import { connect, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec literals ------------------------------------------------------------------------------------------------
/** Spec §6.4: finished = decided | finalized (owner, D5) + forfeited | abandoned | cancelled (author's call). */
const SPEC_FINISHED = ["decided", "finalized", "forfeited", "abandoned", "cancelled"];
/** Every status V432's fixtures_status_check allows (pinned to the live constraint in the DB half). */
const ALL_FIXTURE_STATUSES = ["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled", "needs_decision"];
const NOT_FINISHED = ALL_FIXTURE_STATUSES.filter((s) => !SPEC_FINISHED.includes(s));

const T0 = new Date("2026-11-01T10:00:00Z");
const m = (n: number) => new Date(T0.getTime() + n * 60_000);

interface FactsIn {
  /** S: the latest ended_at among the broadcast's sessions; null/absent = no session has ended on it. */
  S?: Date | null; status?: string; F?: Date | null; active?: boolean; reservedUntil?: Date | null; terminalWithoutEndedAt?: boolean;
}
const facts = (o: FactsIn): EndFacts => ({
  activeSessionOnBroadcast: o.active ?? false,
  reservedUntil: o.reservedUntil ?? null,
  latestEndedAt: o.S ?? null,
  fixtureStatus: o.status ?? "in_play",
  finishedAt: o.F ?? null,
  terminalWithoutEndedAt: o.terminalWithoutEndedAt ?? false,
});
/** `now` defaults to a minute after Stop: inside the grace, so a "due" answer is a time in the future of `now`. */
const due = (o: FactsIn & { now?: Date }) => broadcastEndDueAt(facts(o), o.now ?? m(1));
/** A finished status needs a finished_at (the V430/V432 trigger stamps every one); anything else is given one too, as
 *  needs_decision really has, so the status — not the stamp — is what the rule is seen to read. */
const resultAt = (status: string, F: Date) => ({ status, F });

describe("broadcastEndDueAt — the pure rule (spec §6.4, D4, D5)", () => {
  it("EMPTY CASE FIRST: no session ever on the broadcast → null (not due; the orphan rule owns it)", () => {
    let checked = 0;
    for (const status of ALL_FIXTURE_STATUSES) {
      expect(due({ S: null, ...resultAt(status, m(-10)) }), status).toBeNull();
      checked++;
    }
    expect(checked).toBe(8);
    // Positive pair: the same facts once a session has ended on it are a time, not null.
    expect(due({ S: m(0), ...resultAt("in_play", m(-10)) })).toEqual(m(5));
  });

  it("active session on the broadcast → null, whatever the result", () => {
    // A restart inside the grace: an earlier session on this broadcast ended (S set), a new one is live on it now.
    let checked = 0;
    for (const status of ALL_FIXTURE_STATUSES) {
      expect(due({ active: true, S: m(-20), ...resultAt(status, m(-30)) }), status).toBeNull();
      // Positive pair: the same facts with no active session are due at a time.
      expect(due({ active: false, S: m(-20), ...resultAt(status, m(-30)) }), status).toBeInstanceOf(Date);
      checked++;
    }
    expect(checked).toBe(8);
    // "Finished, camera still live" (§6.4 table): not due; the clock starts at Stop.
    expect(due({ active: true, S: null, ...resultAt("decided", m(-5)) })).toBeNull();
  });

  it("unlapsed reservation → null; lapsed reservation → the normal rule", () => {
    const reservedUntil = m(3);
    // Not finished: unlapsed → null; lapsed → Stop + 5.
    expect(due({ S: m(0), status: "in_play", reservedUntil, now: m(2) })).toBeNull();
    expect(due({ S: m(0), status: "in_play", reservedUntil, now: m(4) })).toEqual(m(5));
    // Finished before Stop: unlapsed → null; lapsed → Stop + 2 (already past `now` — due at once).
    expect(due({ S: m(0), status: "decided", F: m(-10), reservedUntil, now: m(2) })).toBeNull();
    expect(due({ S: m(0), status: "decided", F: m(-10), reservedUntil, now: m(4) })).toEqual(m(2));
    // A lapsed reservation on a broadcast no session ever used is still the empty case.
    expect(due({ S: null, status: "in_play", reservedUntil, now: m(4) })).toBeNull();
  });

  it("Stop, not finished → due at Stop + 5", () => expect(due({ S: m(0), status: "in_play" })).toEqual(m(5)));
  it("finished, then Stop → Stop + 2", () => expect(due({ S: m(0), status: "decided", F: m(-10) })).toEqual(m(2)));
  it("Stop, then finished at +1 → +3", () => expect(due({ S: m(0), status: "finalized", F: m(1) })).toEqual(m(3)));
  it("Stop, then finished at +4 → min(+5, +6) = +5", () => expect(due({ S: m(0), status: "decided", F: m(4) })).toEqual(m(5)));
  it("needs_decision with finished_at set is NOT finished → +5 (F8)", () =>
    expect(due({ S: m(0), status: "needs_decision", F: m(1) })).toEqual(m(5)));

  it("result reverted (status back to in_play, finished_at null) → +5; decided again later → 2 min after the NEW result", () => {
    // The sequence of one fixture's facts across a void: each call reads the facts as they stand now.
    expect(due({ S: m(0), status: "decided", F: m(1) })).toEqual(m(3));
    expect(due({ S: m(0), status: "in_play", F: null })).toEqual(m(5));
    expect(due({ S: m(0), status: "decided", F: m(2) })).toEqual(m(4));
  });

  it("every FINISHED_STATUSES member ends at +2 (from the spec list, typed here), checked === 5; every other status +5", () => {
    let finished = 0;
    for (const status of SPEC_FINISHED) {
      expect(due({ S: m(0), status, F: m(-10) }), status).toEqual(m(2));
      finished++;
    }
    expect(finished).toBe(5);
    let others = 0;
    for (const status of NOT_FINISHED) {
      // Given a finished_at too: needs_decision really carries one (V432), so the status alone must keep it at +5.
      expect(due({ S: m(0), status, F: m(-10) }), status).toEqual(m(5));
      others++;
    }
    expect(others).toBe(3);
  });

  it("S is the LATEST ended_at across two sessions on the broadcast — the rule anchors on the S it is given", () => {
    // The pure half: a later S moves the answer by exactly the difference (the reader's half is the DB test below).
    expect(due({ S: m(-10), status: "in_play", now: m(-9) })).toEqual(m(-5));
    expect(due({ S: m(-3), status: "in_play", now: m(-2) })).toEqual(m(2));
  });

  it("a terminal session with ended_at null throws EndRuleInvariantError (assumption made a guard)", () => {
    // Every terminal entry writes ended_at (spec §6.3); without it S is unknown, so the rule refuses to guess.
    expect(() => due({ terminalWithoutEndedAt: true, S: m(0), status: "in_play" })).toThrow(EndRuleInvariantError);
    // Even while another session is active: the facts are broken, and the guard comes first.
    expect(() => due({ terminalWithoutEndedAt: true, active: true, S: m(0), status: "in_play" })).toThrow(EndRuleInvariantError);
    // Positive pair: the same facts with every terminal session stamped.
    expect(due({ terminalWithoutEndedAt: false, S: m(0), status: "in_play" })).toEqual(m(5));
  });

  it("a finished status with finished_at null throws EndRuleInvariantError (the V430/V432 trigger stamps every finished status)", () => {
    expect(() => due({ S: m(0), status: "decided", F: null })).toThrow(EndRuleInvariantError);
    // Positive pair: stamped → the normal rule.
    expect(due({ S: m(0), status: "decided", F: m(-1) })).toEqual(m(2));
    // A not-finished status without a stamp is the ordinary case, not a broken one.
    expect(due({ S: m(0), status: "in_play", F: null })).toEqual(m(5));
  });
});

// ---- the reader, over real Postgres -------------------------------------------------------------------------------
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});

interface World { orgId: string; userId: string; connectionId: string; apiTargetId: string; fixtures: string[] }
/** An org with a connected channel (the real connect save: the connection and its API destination) and `n` fixtures. */
async function world(n: 1 | 2 = 1): Promise<World> {
  const o = await org();
  const c = await connect(o);
  const d = await startedDivisionWithFixture(o.auth, n === 2 ? { fixtures: 2 } : {});
  const fixtures = n === 2 ? d.fixtureIds : [d.fixtureId];
  for (const f of fixtures) await setStatus(f, "in_play");
  return { orgId: o.orgId, userId: o.userId, connectionId: c.connectionId, apiTargetId: c.targetId, fixtures };
}
/** The fixture's status, written the way a result writes it — naming `status`, so fixtures_track_finished fires. */
async function setStatus(fixtureId: string, status: string): Promise<void> {
  await sql`update fixtures set status = ${status} where id = ${fixtureId}`;
}
const finishedAtOf = async (fixtureId: string): Promise<Date | null> =>
  (await sql<{ f: Date | null }[]>`select finished_at as f from fixtures where id = ${fixtureId}`)[0]!.f;

async function broadcast(
  w: World, fixtureId: string, o: { state?: string; reservedUntil?: Date | null; completedAt?: Date | null } = {},
): Promise<string> {
  const state = o.state ?? "live";
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, reserved_until, completed_at)
    values (false, ${w.orgId}, ${w.connectionId}, ${fixtureId}, ${`yt-${randomUUID().slice(0, 8)}`}, 'Match', 'unlisted', ${state},
            ${o.reservedUntil ?? null}, ${o.completedAt ?? null})
    returning id`;
  return row!.id;
}
/** A pasted destination, written by its one real producer (the url + key sealed under RELAY_KEK). */
async function pastedTarget(w: World): Promise<string> {
  const stored = await sql.begin((tx) => insertStreamTarget(tx, {
    orgId: w.orgId, kind: "youtube", label: "Pasted key", watchUrl: null,
    rtmp: { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: `key-${randomUUID()}` },
  }));
  return stored.id;
}
/** A raw session row (the session usecases are T11's to wire); its NOT NULL snapshot facts come from the fixture's division.
 *  `broadcast` null = a pasted session (api_backed false, the V421 one-per-target rule applies). */
async function session(
  w: World, o: { fixture: string; target: string; broadcast: string | null; state: string; endedAt: Date | null },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at, ended_at,
                                         sport_key, competition_id, division_id, entitlement_via_override, youtube_broadcast_id, api_backed)
    select ${o.fixture}, ${w.orgId}, 'passthrough', ${o.state}, ${o.target}, ${w.userId}, ${m(-60)}, ${o.endedAt},
           d.sport_key, d.competition_id, f.division_id, true, ${o.broadcast}, ${o.broadcast !== null}
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${o.fixture}
    returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("readEndFacts — the facts, read with plain selects (spec §6.4, P5)", () => {
  it("EMPTY CASE FIRST: a broadcast no session has used reads no active session, no S, no stale terminal → the rule answers null", async () => {
    const w = await world(2);
    const b = await broadcast(w, w.fixtures[0]!, { state: "bound" });
    const f = await readEndFacts(sql, b);
    expect(f).toEqual({
      activeSessionOnBroadcast: false, reservedUntil: null, latestEndedAt: null,
      fixtureStatus: "in_play", finishedAt: null, terminalWithoutEndedAt: false,
    });
    expect(broadcastEndDueAt(f, m(1))).toBeNull();
    // The reservation is the broadcast's own reserved_until, read as written (T10 reserves a broadcast it reuses).
    const r = await broadcast(w, w.fixtures[1]!, { state: "reserved", reservedUntil: m(3) });
    expect((await readEndFacts(sql, r)).reservedUntil).toEqual(m(3));
  });

  it("S is the LATEST ended_at across two sessions on the broadcast; a pasted session's later Stop does not move it (P5)", async () => {
    const w = await world();
    const fixture = w.fixtures[0]!;
    const b = await broadcast(w, fixture);
    // Inserted latest-first, so neither insert order nor id order can stand in for "latest".
    await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "completed", endedAt: m(-3) });
    await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "failed", endedAt: m(-10) });
    // A pasted session on the SAME fixture, stopped later still: not this broadcast's, so not its S.
    await session(w, { fixture, target: await pastedTarget(w), broadcast: null, state: "completed", endedAt: m(-1) });
    const f = await readEndFacts(sql, b);
    expect(f.latestEndedAt).toEqual(m(-3));
    // Stop + 5 from the latest (m(-3)): not from the earliest (m(-5)) and not from the pasted Stop (m(4)).
    expect(broadcastEndDueAt(f, m(0))).toEqual(m(2));
  });

  it("RF3: a pasted session ACTIVE on the fixture does not keep the API broadcast open — facts read 'no active session on broadcast'", async () => {
    const w = await world();
    const fixture = w.fixtures[0]!;
    const b = await broadcast(w, fixture);
    await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "completed", endedAt: m(0) });
    // Inside the grace, the organiser switches the fixture to a pasted key and goes live on it.
    const pasted = await session(w, { fixture, target: await pastedTarget(w), broadcast: null, state: "live", endedAt: null });
    const f = await readEndFacts(sql, b);
    expect(f.activeSessionOnBroadcast).toBe(false);
    expect(broadcastEndDueAt(f, m(1))).toEqual(m(5));
    // Positive pair, the sequence onward: the pasted stream stops, and the match goes live again ON the API broadcast.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = ${m(2)} where id = ${pasted}`;
    await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "live", endedAt: null });
    const again = await readEndFacts(sql, b);
    expect(again.activeSessionOnBroadcast).toBe(true);
    expect(again.latestEndedAt).toEqual(m(0));   // the pasted Stop at m(2) still does not count
    expect(broadcastEndDueAt(again, m(3))).toBeNull();
  });

  it("every ACTIVE state on the broadcast reads active (checked === 5); every TERMINAL state without ended_at reads the invariant (checked === 2)", async () => {
    const w = await world();
    const fixture = w.fixtures[0]!;
    const b = await broadcast(w, fixture);
    const s = await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "requested", endedAt: null });
    let active = 0;
    for (const state of ACTIVE_STATES) {
      await sql`update fixture_stream_sessions set state = ${state}, ended_at = null where id = ${s}`;
      const f = await readEndFacts(sql, b);
      expect(f.activeSessionOnBroadcast, state).toBe(true);
      expect(f.terminalWithoutEndedAt, state).toBe(false);
      active++;
    }
    expect(active).toBe(5);
    let terminal = 0;
    for (const state of TERMINAL_STATES) {
      await sql`update fixture_stream_sessions set state = ${state}, ended_at = null where id = ${s}`;
      const broken = await readEndFacts(sql, b);
      expect(broken.activeSessionOnBroadcast, state).toBe(false);
      expect(broken.terminalWithoutEndedAt, state).toBe(true);
      expect(() => broadcastEndDueAt(broken, m(1)), state).toThrow(EndRuleInvariantError);
      // Positive pair: the same terminal session, stamped.
      await sql`update fixture_stream_sessions set ended_at = ${m(0)} where id = ${s}`;
      const ok = await readEndFacts(sql, b);
      expect(ok.terminalWithoutEndedAt, state).toBe(false);
      expect(broadcastEndDueAt(ok, m(1)), state).toEqual(m(5));
      terminal++;
    }
    expect(terminal).toBe(2);
  });

  it("through the real finished_at trigger: result after Stop → result + 2; void → Stop + 5; needs_decision (stamped) → Stop + 5 (F8)", async () => {
    const w = await world();
    const fixture = w.fixtures[0]!;
    const b = await broadcast(w, fixture);
    // Stopped a minute ago (wall clock: the trigger stamps finished_at with the database's now()).
    const S = new Date(Date.now() - 60_000);
    await session(w, { fixture, target: w.apiTargetId, broadcast: b, state: "completed", endedAt: S });
    const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

    await setStatus(fixture, "decided");
    const F = await finishedAtOf(fixture);
    expect(F).toBeInstanceOf(Date);
    const decided = await readEndFacts(sql, b);
    expect(decided).toMatchObject({ fixtureStatus: "decided", finishedAt: F, latestEndedAt: S });
    expect(broadcastEndDueAt(decided, new Date())).toEqual(plus(F!, 2));   // F ≈ S + 1 → F + 2 ≈ S + 3, before S + 5

    await setStatus(fixture, "in_play");   // the result voided: the trigger clears finished_at
    const voided = await readEndFacts(sql, b);
    expect(voided.finishedAt).toBeNull();
    expect(broadcastEndDueAt(voided, new Date())).toEqual(plus(S, 5));

    await setStatus(fixture, "needs_decision");   // held: the trigger stamps it, and the rule must still not count it
    const held = await readEndFacts(sql, b);
    expect(held.finishedAt).toBeInstanceOf(Date);
    expect(broadcastEndDueAt(held, new Date())).toEqual(plus(S, 5));

    await setStatus(fixture, "decided");   // settled: the trigger KEEPS the held stamp, which becomes the result time
    const settled = await readEndFacts(sql, b);
    expect(settled.finishedAt).toEqual(held.finishedAt);
    expect(broadcastEndDueAt(settled, new Date())).toEqual(plus(held.finishedAt!, 2));
  });

  it("the typed status list is the schema's whole fixtures_status_check set (so the 'every other status' sweep is complete)", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixtures'::regclass and conname = 'fixtures_status_check'`;
    const live = [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]!);
    expect(live.length).toBeGreaterThan(0);
    expect([...live].sort()).toEqual([...ALL_FIXTURE_STATUSES].sort());
  });

  it("two API broadcasts on ONE fixture: Part 2 reads only its own sessions, never Part 1's Stop", async () => {
    const w = await world();
    const fixture = w.fixtures[0]!;
    // Part 1: completed at YouTube; its API session stopped at m(-1).
    const part1 = await broadcast(w, fixture, { state: "complete", completedAt: m(0) });
    await session(w, { fixture, target: w.apiTargetId, broadcast: part1, state: "completed", endedAt: m(-1) });
    // Part 2: a restart after the grace, bound on the same fixture, no session on it yet.
    const part2 = await broadcast(w, fixture, { state: "bound" });
    const fresh = await readEndFacts(sql, part2);
    expect(fresh.latestEndedAt).toBeNull();
    expect(fresh.activeSessionOnBroadcast).toBe(false);
    // Not due: with Part 1's Stop as S it would be due at m(4), before Part 2 ever went live.
    expect(broadcastEndDueAt(fresh, m(1))).toBeNull();
    // Positive pair: Part 2's own session stops at m(0) → Stop + 5.
    await session(w, { fixture, target: w.apiTargetId, broadcast: part2, state: "completed", endedAt: m(0) });
    const stopped = await readEndFacts(sql, part2);
    expect(stopped.latestEndedAt).toEqual(m(0));
    expect(broadcastEndDueAt(stopped, m(1))).toEqual(m(5));
  });

  it("an unknown broadcast id throws EndRuleInvariantError, never an all-empty set of facts", async () => {
    await expect(readEndFacts(sql, randomUUID())).rejects.toThrow(EndRuleInvariantError);
  });
});
