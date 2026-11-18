// Check-in capacity plan 1, Task 5 (spec §6.2, §6.3): the presence store (video/presence.ts over V527's three tables).
//
// What these tests pin, in the order the file runs them:
//   - currentPeerOf, the pure pick of the current peer: its answer, and the tie rule plans 2 and 3 lean on (property).
//   - applyPresenceEvent, in every ORDER the vendor can deliver: the fixture delivers concurrently, so arrival order is not emit
//     order. The rows depend only on the SET of a stay's events (property, with the order and repeats shuffled), and each named
//     out-of-order sequence is also written out by hand.
//   - the readers (currentPresence, everJoined, peersOf, recordPresenceFromRead), including the read-row trust window (R4).
//   - the shadow report's two-sided comparison.
// Expected values are typed from the rulebook (Global Constraints, spec §6.2/§6.3) or computed from the EVENT SET by an oracle
// that shares no code with presence.ts, never read back from the function under test. Every sweep reports what it checked and
// zero checked fails (TEST-STRATEGY.md). Single-sport reason: presence is keyed by meeting and participant, never by sport; the
// seeded board is a chess board because that is the only product that holds RealtimeKit meetings.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import type { RealtimeKitEvent } from "../webhook-event";
import {
  PRESENCE_READ_TRUST_MS,
  PRESENCE_RETENTION_MS,
  SHADOW_ARRIVAL_TOLERANCE_MS,
  WEBHOOK_DELIVERY_RETENTION_MS,
  applyPresenceEvent,
  currentPeerOf,
  currentPresence,
  everJoined,
  heldMeeting,
  peersOf,
  presenceShadowReport,
  prunePresence,
  recordPresenceFromRead,
  resolveParticipant,
} from "../presence";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture } from "../../../usecases/__tests__/_external-play-seed";

const DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-11-17T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1_000;

// ─── Event builders ────────────────────────────────────────────────────────────────────────────────────────────────────

const joinedEv = (o: { meetingId: string; peerId: string; custom: string; joinedAt: Date; sessionId?: string | null }): RealtimeKitEvent => ({
  kind: "joined",
  event: "meeting.participantJoined",
  meetingId: o.meetingId,
  sessionId: o.sessionId === undefined ? "sess-1" : o.sessionId,
  peerId: o.peerId,
  customParticipantId: o.custom,
  joinedAt: o.joinedAt,
});
const leftEv = (o: { meetingId: string; peerId: string; custom: string; joinedAt: Date | null; leftAt: Date; sessionId?: string | null }): RealtimeKitEvent => ({
  kind: "left",
  event: "meeting.participantLeft",
  meetingId: o.meetingId,
  sessionId: o.sessionId === undefined ? "sess-1" : o.sessionId,
  peerId: o.peerId,
  customParticipantId: o.custom,
  joinedAt: o.joinedAt,
  leftAt: o.leftAt,
});
const endedEv = (o: { meetingId: string; sessionId: string | null; endedAt: Date }): RealtimeKitEvent => ({
  kind: "ended",
  event: "meeting.ended",
  meetingId: o.meetingId,
  sessionId: o.sessionId,
  endedAt: o.endedAt,
});

// ─── Rows, read back by SQL (never through presence.ts) ────────────────────────────────────────────────────────────────

type Row = {
  meeting_id: string;
  peer_id: string;
  fixture_id: string | null;
  side: string | null;
  participant_id: string | null;
  custom_participant_id: string;
  session_id: string | null;
  joined_at: Date | null;
  left_at: Date | null;
  left_by: string | null;
  source: string;
  received_at: Date;
};
const rowsOf = (meetingId: string) =>
  sql<Row[]>`select meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, left_at, left_by,
                    source, received_at
               from fixture_video_presence where meeting_id = ${meetingId} order by peer_id`;
const rowOf = async (meetingId: string, peerId: string) => {
  const r = (await rowsOf(meetingId)).find((x) => x.peer_id === peerId);
  if (!r) throw new Error(`premise: no presence row ${meetingId}/${peerId}`);
  return r;
};
const clear = async (meetingId: string) => {
  await sql`delete from fixture_video_presence where meeting_id = ${meetingId}`;
  await sql`delete from realtimekit_ended_sessions where meeting_id = ${meetingId}`;
};
const peer = () => `peer-${randomUUID().slice(0, 8)}`;

// ─── Seeds ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const meetingsMade: string[] = [];
const parkedMade: string[] = [];
const track = (m: string) => {
  meetingsMade.push(m);
  return m;
};

/** A board with BOTH players' meetings, each side's player on file as a participant (preset 'player', custom id = person id). */
async function board() {
  const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: false, scheduledAt: new Date(Date.now() + 3_600_000), linked: true });
  const homeMeeting = track(await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "home" }));
  const awayMeeting = track(await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "away" }));
  const homeParticipant = await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: s.home.personId });
  const awayParticipant = await putVideoParticipant({ fixtureId: s.fixtureId, side: "away", personId: s.away.personId });
  return { ...s, homeMeeting, awayMeeting, homeParticipant, awayParticipant };
}

afterAll(async () => {
  if (DB) {
    if (meetingsMade.length > 0) {
      await sql`delete from fixture_video_presence where meeting_id in ${sql(meetingsMade)}`;
      await sql`delete from realtimekit_ended_sessions where meeting_id in ${sql(meetingsMade)}`;
    }
    if (parkedMade.length > 0) await sql`delete from video_rooms_to_end where meeting_id in ${sql(parkedMade)}`;
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});

// ─── currentPeerOf (pure) ──────────────────────────────────────────────────────────────────────────────────────────────

type PeerRow = { peerId: string; joinedAt: Date | null; leftAt: Date | null };

describe("currentPeerOf (pure)", () => {
  it("empty case: no rows is null", () => expect(currentPeerOf([])).toBeNull());

  it("a row with no joinedAt is never current, and a row that has left is skipped for an older open one", () => {
    expect(currentPeerOf([{ peerId: "p0", joinedAt: null, leftAt: null }])).toBeNull();
    const rows: PeerRow[] = [
      { peerId: "old-open", joinedAt: at(0), leftAt: null },
      { peerId: "new-left", joinedAt: at(SEC), leftAt: at(2 * SEC) },
    ];
    expect(currentPeerOf(rows)).toEqual({ peerId: "old-open", joinedAt: at(0) });
  });

  it("among equal joinedAt the LATER row in the input wins (the order the readers feed it)", () => {
    const rows: PeerRow[] = [
      { peerId: "a", joinedAt: at(0), leftAt: null },
      { peerId: "b", joinedAt: at(0), leftAt: null },
    ];
    expect(currentPeerOf(rows)?.peerId).toBe("b");
    expect(currentPeerOf([...rows].reverse())?.peerId, "the input order is what decides, not the peer id").toBe("a");
  });

  it("property: the answer is the latest-joined row with left_at null (ties: the later row in the input), or null when every joined row has left", () => {
    // Few distinct instants, so duplicate joinedAt values are the NORM; the tie count that matters (two OPEN rows sharing the
    // winning joinedAt) is measured and must be non-zero, so a function that ignored the tie rule could not pass unwitnessed.
    const instant = fc.integer({ min: 0, max: 3 }).map((n) => at(n * SEC));
    const rowsArb = fc.array(
      fc.record({ joinedAt: fc.option(instant, { nil: null }), leftAt: fc.option(instant, { nil: null }) }),
      { maxLength: 8 },
    );
    let runs = 0;
    let withDuplicateJoinedAt = 0;
    let withWinningTie = 0;
    let nullAnswers = 0;
    fc.assert(
      fc.property(rowsArb, (raw) => {
        runs++;
        const rows: PeerRow[] = raw.map((r, i) => ({ peerId: `p${i}`, ...r }));
        const joined = rows.filter((r) => r.joinedAt !== null).map((r) => r.joinedAt!.getTime());
        if (new Set(joined).size < joined.length) withDuplicateJoinedAt++;
        // The oracle: filter, then a STABLE ascending sort by joinedAt, last element. Array.prototype.sort is stable, so equal
        // joinedAt keep input order and the last one is the later row.
        const open = rows.filter((r) => r.joinedAt !== null && r.leftAt === null);
        const sorted = [...open].sort((a, b) => a.joinedAt!.getTime() - b.joinedAt!.getTime());
        const expected = sorted.length === 0 ? null : { peerId: sorted.at(-1)!.peerId, joinedAt: sorted.at(-1)!.joinedAt! };
        if (open.length >= 2 && expected && open.filter((r) => r.joinedAt!.getTime() === expected.joinedAt.getTime()).length >= 2) withWinningTie++;
        if (expected === null) nullAnswers++;
        expect(currentPeerOf(rows)).toEqual(expected);
      }),
      { numRuns: 400 },
    );
    expect(runs, "cases run").toBeGreaterThanOrEqual(200);
    expect(withDuplicateJoinedAt / runs, `cases with a duplicate joinedAt: ${withDuplicateJoinedAt}/${runs}`).toBeGreaterThanOrEqual(0.25);
    expect(withWinningTie, `cases where the tie decided the answer: ${withWinningTie}/${runs}`).toBeGreaterThan(0);
    expect(nullAnswers, `cases that answered null: ${nullAnswers}/${runs}`).toBeGreaterThan(0);
  });
});

// ─── heldMeeting / resolveParticipant ──────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("heldMeeting (the receiver's ownership test)", () => {
  it("a meeting we hold answers its (fixture, side); a parked room answers its own; a presence row alone answers the stamps it carries; a stranger answers null", async () => {
    const b = await board();
    expect(await heldMeeting(sql, b.homeMeeting)).toEqual({ fixtureId: b.fixtureId, side: "home" });
    expect(await heldMeeting(sql, b.awayMeeting)).toEqual({ fixtureId: b.fixtureId, side: "away" });

    // parked: deleting an un-ended meeting row parks it in video_rooms_to_end (V460), and the meeting row is then gone.
    await sql`delete from fixture_video_meetings where meeting_id = ${b.awayMeeting}`;
    parkedMade.push(b.awayMeeting);
    expect(await sql`select 1 from fixture_video_meetings where meeting_id = ${b.awayMeeting}`, "premise: the meeting row is gone").toHaveLength(0);
    expect(await heldMeeting(sql, b.awayMeeting)).toEqual({ fixtureId: b.fixtureId, side: "away" });

    // a presence row alone (the sweep ended a parked room and deleted its parking row, our rows remain)
    const orphan = track(`orphan-${randomUUID().slice(0, 8)}`);
    expect(await heldMeeting(sql, orphan), "premise: unknown to every table").toBeNull();
    await sql`insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, custom_participant_id, source, joined_at)
              values (${orphan}, 'p1', ${b.fixtureId}, 'home', 'c1', 'webhook', ${T0})`;
    expect(await heldMeeting(sql, orphan)).toEqual({ fixtureId: b.fixtureId, side: "home" });

    expect(await heldMeeting(sql, `stranger-${randomUUID()}`)).toBeNull();
  });

  it("the meeting row wins over an older presence stamp (a re-paired board)", async () => {
    const b = await board();
    await sql`insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, custom_participant_id, source, joined_at)
              values (${b.homeMeeting}, 'p-stale', ${randomUUID()}, 'away', 'c1', 'webhook', ${T0})`;
    expect(await heldMeeting(sql, b.homeMeeting)).toEqual({ fixtureId: b.fixtureId, side: "home" });
  });
});

describe.skipIf(!DB)("resolveParticipant", () => {
  it("a player's person id resolves to that player's participant in THAT meeting's side; the other side's player and a stranger do not", async () => {
    const b = await board();
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: b.home.personId })).toBe(b.homeParticipant);
    expect(await resolveParticipant(sql, { meetingId: b.awayMeeting, customParticipantId: b.away.personId })).toBe(b.awayParticipant);
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: b.away.personId }), "the opponent's person id in my meeting").toBeNull();
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: randomUUID() })).toBeNull();
    expect(await resolveParticipant(sql, { meetingId: `nope-${randomUUID()}`, customParticipantId: b.home.personId })).toBeNull();
    // a string that is no uuid must not throw (the column is a uuid; the comparison is on text)
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: "not-a-uuid" })).toBeNull();
  });

  it("an arbiter's `<userId>:<nonce>` matches by the user prefix; the newest live row wins; a removed row never matches", async () => {
    const b = await board();
    const user = b.ownerUserId;
    const oldRow = await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: null, preset: "arbiter" });
    const newRow = await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: null, preset: "arbiter" });
    const removed = await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: null, preset: "arbiter" }, { removedAt: T0 });
    await sql`update fixture_video_participants set user_id = ${user}, created_at = ${at(-3 * SEC)} where fixture_id = ${b.fixtureId} and participant_id = ${oldRow}`;
    await sql`update fixture_video_participants set user_id = ${user}, created_at = ${at(-2 * SEC)} where fixture_id = ${b.fixtureId} and participant_id = ${newRow}`;
    // the removed row is the NEWEST of the three, so only the removed_at test can keep it out
    await sql`update fixture_video_participants set user_id = ${user}, created_at = ${at(-1 * SEC)} where fixture_id = ${b.fixtureId} and participant_id = ${removed}`;
    const custom = `${user}:nonce-${randomUUID().slice(0, 6)}`;
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: custom })).toBe(newRow);
    expect(await resolveParticipant(sql, { meetingId: b.awayMeeting, customParticipantId: custom }), "the arbiter sits in the HOME meeting only").toBeNull();
    // only the removed row left: no match
    await sql`delete from fixture_video_participants where fixture_id = ${b.fixtureId} and participant_id in ${sql([oldRow, newRow])}`;
    expect(await resolveParticipant(sql, { meetingId: b.homeMeeting, customParticipantId: custom }), "only a removed arbiter row is left").toBeNull();
  });
});

// ─── applyPresenceEvent ────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("applyPresenceEvent", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(log, "warn");
  });
  afterEach(() => warn.mockRestore());

  it("joined: a row with participant_id resolved from the player's person id, stamped with the meeting's fixture_id and side", async () => {
    const b = await board();
    const p = peer();
    const out = await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: T0 }), at(SEC));
    expect(out).toBe("applied");
    const r = await rowOf(b.homeMeeting, p);
    expect(r.participant_id).toBe(b.homeParticipant);
    expect(r.fixture_id).toBe(b.fixtureId);
    expect(r.side).toBe("home");
    expect(r.source).toBe("webhook");
    expect(r.custom_participant_id).toBe(b.home.personId);
    expect(r.session_id).toBe("sess-1");
    expect(r.joined_at).toEqual(T0);
    expect(r.left_at).toBeNull();
    expect(r.left_by).toBeNull();
    expect(r.received_at).toEqual(at(SEC));
    // the same event for the AWAY meeting stamps the away side
    const q = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.awayMeeting, peerId: q, custom: b.away.personId, joinedAt: T0 }), at(SEC));
    expect((await rowOf(b.awayMeeting, q)).side).toBe("away");
  });

  it("joined for a custom id nobody has on file: stored with a null participant and logged, never dropped", async () => {
    const b = await board();
    const p = peer();
    const custom = `stranger-${randomUUID()}`;
    expect(await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom, joinedAt: T0 }), at(SEC))).toBe("applied");
    const r = await rowOf(b.homeMeeting, p);
    expect(r.participant_id).toBeNull();
    expect(r.custom_participant_id).toBe(custom);
    expect(r.fixture_id).toBe(b.fixtureId);
    expect(warn, "the unresolved participant is logged").toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged, "the log names the meeting").toContain(b.homeMeeting);
  });

  it("joined for an arbiter's subject `<userId>:<nonce>` resolves to that organizer's live arbiter row in the meeting (prefix match); a removed row does not match", async () => {
    const b = await board();
    const live = await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: null, preset: "arbiter" });
    await sql`update fixture_video_participants set user_id = ${b.ownerUserId} where fixture_id = ${b.fixtureId} and participant_id = ${live}`;
    const p1 = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: `${b.ownerUserId}:abc123`, joinedAt: T0 }), at(SEC));
    expect((await rowOf(b.homeMeeting, p1)).participant_id).toBe(live);

    await sql`update fixture_video_participants set removed_at = ${T0} where fixture_id = ${b.fixtureId} and participant_id = ${live}`;
    const p2 = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: `${b.ownerUserId}:def456`, joinedAt: at(SEC) }), at(2 * SEC));
    expect((await rowOf(b.homeMeeting, p2)).participant_id, "the arbiter was removed").toBeNull();
  });

  it("left before joined: one row with both stamps; the later joined keeps left_at", async () => {
    const b = await board();
    const p = peer();
    const c = b.home.personId;
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p, custom: c, joinedAt: T0, leftAt: at(60 * SEC) }), at(61 * SEC));
    const afterLeft = await rowOf(b.homeMeeting, p);
    expect(afterLeft.joined_at, "a left carries its own joinedAt").toEqual(T0);
    expect(afterLeft.left_at).toEqual(at(60 * SEC));
    expect(afterLeft.left_by).toBe("left");
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: c, joinedAt: T0 }), at(62 * SEC));
    const rows = await rowsOf(b.homeMeeting);
    expect(rows, "still ONE row for the peer").toHaveLength(1);
    expect(rows[0]!.left_at).toEqual(at(60 * SEC));
    expect(rows[0]!.left_by).toBe("left");
    expect(rows[0]!.joined_at).toEqual(T0);
    expect(rows[0]!.source).toBe("webhook");
    expect(rows[0]!.participant_id, "the joined's lookup filled the participant the left's did too").toBe(b.homeParticipant);
  });

  it("a left that carries no joinedAt, then the joined: the joined stamp lands and the leave stays", async () => {
    const b = await board();
    const p = peer();
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: null, leftAt: at(60 * SEC) }), at(61 * SEC));
    expect((await rowOf(b.homeMeeting, p)).joined_at).toBeNull();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: T0 }), at(62 * SEC));
    const r = await rowOf(b.homeMeeting, p);
    expect(r.joined_at).toEqual(T0);
    expect(r.left_at).toEqual(at(60 * SEC));
  });

  it("a peer's own leave beats its session's end, in either arrival order; the FIRST own leave is kept", async () => {
    const b = await board();
    const c = b.home.personId;
    // end first, then the leave
    const p1 = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: T0 }), at(SEC));
    await applyPresenceEvent(sql, endedEv({ meetingId: b.homeMeeting, sessionId: "sess-1", endedAt: at(100 * SEC) }), at(101 * SEC));
    expect(await rowOf(b.homeMeeting, p1), "premise: the end closed it").toMatchObject({ left_by: "ended", left_at: at(100 * SEC) });
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: T0, leftAt: at(50 * SEC) }), at(102 * SEC));
    expect(await rowOf(b.homeMeeting, p1)).toMatchObject({ left_by: "left", left_at: at(50 * SEC) });
    // a second, different leave stamp for the same peer does not move the first
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: T0, leftAt: at(70 * SEC) }), at(103 * SEC));
    expect(await rowOf(b.homeMeeting, p1)).toMatchObject({ left_by: "left", left_at: at(50 * SEC) });
  });

  it("joined AFTER meeting.ended (a 5xx retried late): stored closed at the session's end, left_by 'ended'", async () => {
    const b = await board();
    const p = peer();
    const E = at(100 * SEC);
    await applyPresenceEvent(sql, endedEv({ meetingId: b.homeMeeting, sessionId: "sess-1", endedAt: E }), at(101 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: T0 }), at(102 * SEC));
    const r = await rowOf(b.homeMeeting, p);
    expect(r.left_at).toEqual(E);
    expect(r.left_by).toBe("ended");
    expect(await currentPresence(sql, { meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: b.home.personId })).toBeNull();
    // the same joined for ANOTHER session of the meeting is not closed by this end
    const q = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: q, custom: b.home.personId, joinedAt: at(SEC), sessionId: "sess-2" }), at(103 * SEC));
    expect((await rowOf(b.homeMeeting, q)).left_at).toBeNull();
  });

  it("a null-session joined AFTER meeting.ended: stored closed at the earliest recorded end at or after its join, open when it joined after every end", async () => {
    // Expected, from the rule (batch-1 T5 M1): a row without a session is closed by any session's end that came at or after its
    // join, and the EARLIEST such end is the one the ended path itself would have stamped first had the join arrived first.
    const b = await board();
    const M = b.homeMeeting;
    const c = b.home.personId;
    const E1 = at(100 * SEC);
    const E2 = at(200 * SEC);
    await applyPresenceEvent(sql, endedEv({ meetingId: M, sessionId: "A", endedAt: E1 }), at(201 * SEC));
    await applyPresenceEvent(sql, endedEv({ meetingId: M, sessionId: "B", endedAt: E2 }), at(202 * SEC));
    const [beforeBoth, between, atE1, afterBoth] = [peer(), peer(), peer(), peer()];
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: beforeBoth, custom: c, joinedAt: at(50 * SEC), sessionId: null }), at(203 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: between, custom: c, joinedAt: at(150 * SEC), sessionId: null }), at(204 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: atE1, custom: c, joinedAt: E1, sessionId: null }), at(205 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: afterBoth, custom: c, joinedAt: at(250 * SEC), sessionId: null }), at(206 * SEC));
    const want: [string, Date | null][] = [[beforeBoth, E1], [between, E2], [atE1, E1], [afterBoth, null]];
    let checked = 0;
    for (const [p, left] of want) {
      expect(await rowOf(M, p), p).toMatchObject({ left_at: left, left_by: left === null ? null : "ended" });
      checked++;
    }
    expect(checked, "rows checked").toBe(4);
  });

  it("ended: closes every open row of THAT meeting's session and no other; a null-session row of that meeting closes only if it joined before the end", async () => {
    const b = await board();
    const M = b.homeMeeting;
    const M2 = b.awayMeeting;
    const E = at(100 * SEC);
    const [a1, b1, a2, nBefore, nAfter] = [peer(), peer(), peer(), peer(), peer()];
    const c = b.home.personId;
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: a1, custom: c, joinedAt: at(10 * SEC), sessionId: "A" }), at(11 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: b1, custom: c, joinedAt: at(12 * SEC), sessionId: "B" }), at(13 * SEC));
    // ids are vendor strings: another meeting reusing the session id "A" must not be closed by M's end
    await applyPresenceEvent(sql, joinedEv({ meetingId: M2, peerId: a2, custom: b.away.personId, joinedAt: at(14 * SEC), sessionId: "A" }), at(15 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: nBefore, custom: c, joinedAt: at(90 * SEC), sessionId: null }), at(91 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: nAfter, custom: c, joinedAt: at(110 * SEC), sessionId: null }), at(111 * SEC));
    expect(await applyPresenceEvent(sql, endedEv({ meetingId: M, sessionId: "A", endedAt: E }), at(120 * SEC))).toBe("applied");

    const ra1 = await rowOf(M, a1);
    const rb1 = await rowOf(M, b1);
    const ra2 = await rowOf(M2, a2);
    const rnb = await rowOf(M, nBefore);
    const rna = await rowOf(M, nAfter);
    let checked = 0;
    expect(ra1, "M/A closed at the end").toMatchObject({ left_at: E, left_by: "ended" });
    checked++;
    expect(rb1, "M/B is another session").toMatchObject({ left_at: null, left_by: null });
    checked++;
    expect(ra2, "M2/A is another meeting").toMatchObject({ left_at: null, left_by: null });
    checked++;
    expect(rnb, "a null-session row that joined before the end").toMatchObject({ left_at: E, left_by: "ended" });
    checked++;
    expect(rna, "a null-session row that joined after the end").toMatchObject({ left_at: null, left_by: null });
    checked++;
    expect(checked, "rows checked").toBe(5);
    const ended = await sql<{ meeting_id: string; session_id: string; ended_at: Date }[]>`
      select meeting_id, session_id, ended_at from realtimekit_ended_sessions where meeting_id in ${sql([M, M2])}`;
    expect(ended, "the session's end is recorded once, for the meeting that ended").toEqual([{ meeting_id: M, session_id: "A", ended_at: E }]);
  });

  it("ended with no session closes nothing and records nothing, and is logged", async () => {
    const b = await board();
    const p = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: T0 }), at(SEC));
    warn.mockClear();
    const out = await applyPresenceEvent(sql, endedEv({ meetingId: b.homeMeeting, sessionId: null, endedAt: at(100 * SEC) }), at(101 * SEC));
    expect(out).toBe("ignored");
    expect(await rowOf(b.homeMeeting, p)).toMatchObject({ left_at: null, left_by: null });
    expect(await sql`select 1 from realtimekit_ended_sessions where meeting_id = ${b.homeMeeting}`).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("other: ignored and nothing written", async () => {
    const b = await board();
    const before = (await rowsOf(b.homeMeeting)).length;
    const ev: RealtimeKitEvent = { kind: "other", event: "meeting.started" };
    expect(await applyPresenceEvent(sql, ev, at(SEC))).toBe("ignored");
    expect((await rowsOf(b.homeMeeting)).length).toBe(before);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_ended_sessions where meeting_id in ${sql([b.homeMeeting, b.awayMeeting])}`)[0]!.n).toBe(0);
  });

  it("ownership: an event for a meeting we do not hold is ignored and writes NOTHING (joined, left and ended alike)", async () => {
    const stranger = `stranger-${randomUUID()}`;
    const evs: RealtimeKitEvent[] = [
      joinedEv({ meetingId: stranger, peerId: "p1", custom: "c1", joinedAt: T0 }),
      leftEv({ meetingId: stranger, peerId: "p1", custom: "c1", joinedAt: T0, leftAt: at(SEC) }),
      endedEv({ meetingId: stranger, sessionId: "sess-1", endedAt: at(2 * SEC) }),
    ];
    let checked = 0;
    for (const ev of evs) {
      expect(await applyPresenceEvent(sql, ev, at(3 * SEC)), ev.kind).toBe("ignored");
      checked++;
    }
    expect(checked, "events tried").toBe(3);
    expect(await sql`select 1 from fixture_video_presence where meeting_id = ${stranger}`).toHaveLength(0);
    expect(await sql`select 1 from realtimekit_ended_sessions where meeting_id = ${stranger}`).toHaveLength(0);
    // the same stranger with an explicit `null` from a receiver that already gated on heldMeeting
    expect(await applyPresenceEvent(sql, evs[0]!, at(3 * SEC), null)).toBe("ignored");
    expect(await sql`select 1 from fixture_video_presence where meeting_id = ${stranger}`).toHaveLength(0);
  });

  it("a repeated meeting.ended with a different endedAt: the session's FIRST recorded end wins, and every row it closes carries that value (both arrival orders)", async () => {
    // batch-1 T5 M5. Rows a repeat can still reach: a read hint of the session written after the first end (reads take no lock and
    // stay open), and a null-session peer that joined between the two stamps. Expected, typed from the rule: the recorded end is
    // the first applied; every closed row's left_at equals it; the null-session peer is closed only if it joined at or before it.
    const held = { fixtureId: randomUUID(), side: "home" as const };
    const E1 = at(100 * SEC);
    const E2 = at(200 * SEC);
    let closedChecked = 0;
    for (const [first, second] of [[E1, E2], [E2, E1]] as const) {
      const M = track(`rep-${randomUUID().slice(0, 8)}`);
      const [early, hint, between, late] = [peer(), peer(), peer(), peer()];
      await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: early, custom: "c1", joinedAt: at(10 * SEC) }), at(11 * SEC), held);
      await applyPresenceEvent(sql, endedEv({ meetingId: M, sessionId: "sess-1", endedAt: first }), at(300 * SEC), held);
      await recordPresenceFromRead(sql, { meetingId: M, participantId: "prt-hint", customParticipantId: "c2", peerId: hint, sessionId: "sess-1", joinedAt: at(20 * SEC) }, at(301 * SEC));
      expect((await rowOf(M, hint)).left_at, "premise: a read hint written after the end is open").toBeNull();
      await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: between, custom: "c3", joinedAt: at(150 * SEC), sessionId: null }), at(302 * SEC), held);
      await applyPresenceEvent(sql, endedEv({ meetingId: M, sessionId: "sess-1", endedAt: second }), at(303 * SEC), held);
      await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: late, custom: "c4", joinedAt: at(30 * SEC) }), at(304 * SEC), held);

      const recorded = await sql<{ ended_at: Date }[]>`select ended_at from realtimekit_ended_sessions where meeting_id = ${M}`;
      expect(recorded, "one end recorded for the session: the first applied").toEqual([{ ended_at: first }]);
      const rows = await rowsOf(M);
      expect(rows, "four peers").toHaveLength(4);
      const closed = rows.filter((r) => r.left_at !== null);
      for (const r of closed) {
        expect(r.left_at, `${r.peer_id} carries the recorded end`).toEqual(first);
        expect(r.left_by).toBe("ended");
        closedChecked++;
      }
      expect(closed.map((r) => r.peer_id).sort(), "the closed peers").toEqual((first === E1 ? [early, hint, late] : [early, hint, between, late]).sort());
    }
    expect(closedChecked, "closed rows checked across both orders").toBe(7);
  });

  it("a meeting we hold only through a presence row still takes a meeting.ended (the sweep ended the parked room and deleted its parking row)", async () => {
    const b = await board();
    const orphan = track(`orphan-${randomUUID().slice(0, 8)}`);
    await sql`insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, custom_participant_id, session_id, source, joined_at)
              values (${orphan}, 'p1', ${b.fixtureId}, 'home', 'c1', 'sess-1', 'webhook', ${T0})`;
    expect(await applyPresenceEvent(sql, endedEv({ meetingId: orphan, sessionId: "sess-1", endedAt: at(100 * SEC) }), at(101 * SEC))).toBe("applied");
    expect(await rowOf(orphan, "p1")).toMatchObject({ left_by: "ended", left_at: at(100 * SEC) });
  });

  it("property: the rows depend only on the SET of a stay's events, never their order or repeats (fast-check, numRuns reported)", async () => {
    // A stay: 1-2 peers, each with a joined and optionally a left, and optionally the session's ended. A peer is in session
    // `sess-1` (joining before its end) or carries NO session (joining at any time: before, between or after the ends); a second
    // session `sess-2`, which no session-carrying peer is in, may also end, so a null-session peer can have two ends to choose
    // from. The events are applied shuffled with repeats. `held` is passed explicitly, so a case needs no seeded board;
    // participant resolution is not the subject here (the rows' stamps are).
    const held = { fixtureId: randomUUID(), side: "home" as const };
    type Peer = { sessionless: boolean; joinedOff: number; leftOff: number | null };
    const scenarioArb = fc.record({
      peers: fc.array(
        fc
          .record({ sessionless: fc.boolean(), off: fc.integer({ min: 1, max: 140 }), leftDelta: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) })
          .map(({ sessionless, off, leftDelta }): Peer => {
            // a session-carrying peer joins inside its session (1..20); a null-session one anywhere in 1..140
            const joinedOff = sessionless ? off : 1 + (off % 20);
            return { sessionless, joinedOff, leftOff: leftDelta === null ? null : joinedOff + leftDelta };
          }),
        { minLength: 1, maxLength: 2 },
      ),
      endedOff: fc.option(fc.integer({ min: 81, max: 120 }), { nil: null }),
      ended2Off: fc.option(fc.integer({ min: 60, max: 130 }), { nil: null }),
    });
    const stamp = (off: number) => at(off * SEC);
    const eventsOf = (meetingId: string, peers: Peer[], endedOff: number | null, ended2Off: number | null) => {
      const evs: { key: string; ev: RealtimeKitEvent }[] = [];
      peers.forEach((p, i) => {
        const id = `peer-${i}`;
        const sessionId = p.sessionless ? null : "sess-1";
        evs.push({ key: `j${i}`, ev: joinedEv({ meetingId, peerId: id, custom: `c-${i}`, joinedAt: stamp(p.joinedOff), sessionId }) });
        if (p.leftOff !== null) {
          evs.push({ key: `l${i}`, ev: leftEv({ meetingId, peerId: id, custom: `c-${i}`, joinedAt: stamp(p.joinedOff), leftAt: stamp(p.leftOff), sessionId }) });
        }
      });
      if (endedOff !== null) evs.push({ key: "e", ev: endedEv({ meetingId, sessionId: "sess-1", endedAt: stamp(endedOff) }) });
      if (ended2Off !== null) evs.push({ key: "f", ev: endedEv({ meetingId, sessionId: "sess-2", endedAt: stamp(ended2Off) }) });
      return evs;
    };
    // canonical order: every joined, then every left, then the end (the order a well-behaved vendor delivers)
    const rank = (key: string) => (key.startsWith("j") ? 0 : key.startsWith("l") ? 1 : 2);

    let cases = 0;
    let reordered = 0;
    let repeated = 0;
    let lostLeaveAfterEnd = 0;
    let peersChecked = 0;
    let sessionlessChecked = 0;
    let sessionlessClosedByEnd = 0;
    let sessionlessOpenPastEveryEnd = 0;
    let sessionlessEarliestOfTwo = 0;
    await fc.assert(
      fc
        .asyncProperty(
          scenarioArb.chain((sc) => {
            const base = eventsOf("m-shape", sc.peers, sc.endedOff, sc.ended2Off);
            return fc
              .array(fc.nat({ max: base.length - 1 }), { maxLength: 4 })
              .chain((dups) => {
                const all = [...base, ...dups.map((i) => base[i]!)];
                return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }).map((seq) => ({ sc, seq, dups: dups.length }));
              });
          }),
          async ({ sc, seq, dups }) => {
            const meetingId = `prop-${randomUUID()}`;
            cases++;
            if (dups > 0) repeated++;
            // re-key the events onto this case's meeting id
            const applied = seq.map(({ key, ev }) => ({ key, ev: { ...ev, meetingId } as RealtimeKitEvent }));
            const firstSeen: string[] = [];
            for (const { key } of applied) if (!firstSeen.includes(key)) firstSeen.push(key);
            const canonical = [...firstSeen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
            if (firstSeen.some((k, i) => rank(k) !== rank(canonical[i]!))) reordered++;
            if (sc.endedOff !== null && sc.peers.some((p) => p.leftOff !== null)) {
              const e = firstSeen.indexOf("e");
              if (firstSeen.some((k, i) => k.startsWith("l") && i > e)) lostLeaveAfterEnd++;
            }
            let t = 0;
            for (const { ev } of applied) await applyPresenceEvent(sql, ev, stamp(200 + t++), held);
            meetingsMade.push(meetingId);

            // Expected, derived from the event SET (never from applyPresenceEvent): joined_at = the joined payload; left_at = the
            // peer's own leave if one is in the set; else, for a peer in sess-1, sess-1's end if one is in the set; for a peer with
            // no session, the EARLIEST end of any session at or after its join; else open.
            const rows = await rowsOf(meetingId);
            expect(rows.map((r) => r.peer_id).sort(), "one row per peer").toEqual(sc.peers.map((_, i) => `peer-${i}`).sort());
            sc.peers.forEach((p, i) => {
              const r = rows.find((x) => x.peer_id === `peer-${i}`)!;
              const ends = [sc.endedOff, sc.ended2Off].filter((e): e is number => e !== null);
              const reachable = ends.filter((e) => e >= p.joinedOff);
              const endOff = p.sessionless ? (reachable.length === 0 ? null : Math.min(...reachable)) : sc.endedOff;
              const expectLeft = p.leftOff !== null ? stamp(p.leftOff) : endOff !== null ? stamp(endOff) : null;
              const expectBy = p.leftOff !== null ? "left" : endOff !== null ? "ended" : null;
              if (p.sessionless) {
                sessionlessChecked++;
                if (p.leftOff === null && endOff !== null) sessionlessClosedByEnd++;
                if (p.leftOff === null && ends.length > 0 && endOff === null) sessionlessOpenPastEveryEnd++;
                if (p.leftOff === null && reachable.length === 2 && reachable[0] !== reachable[1]) sessionlessEarliestOfTwo++;
              }
              expect(r.joined_at, `peer ${i} joined_at`).toEqual(stamp(p.joinedOff));
              expect(r.left_at, `peer ${i} left_at`).toEqual(expectLeft);
              expect(r.left_by, `peer ${i} left_by`).toBe(expectBy);
              expect(r.source).toBe("webhook");
              expect(r.fixture_id).toBe(held.fixtureId);
              peersChecked++;
            });
          },
        )
        ,
      { numRuns: 120 },
    );
    expect(cases, "cases run").toBeGreaterThanOrEqual(100);
    expect(sessionlessChecked, `null-session peer rows checked: ${sessionlessChecked}`).toBeGreaterThan(0);
    expect(sessionlessClosedByEnd, `null-session peers closed by an end: ${sessionlessClosedByEnd}`).toBeGreaterThan(0);
    expect(sessionlessOpenPastEveryEnd, `null-session peers that joined after every end (open): ${sessionlessOpenPastEveryEnd}`).toBeGreaterThan(0);
    expect(sessionlessEarliestOfTwo, `null-session peers with two distinct ends to choose from: ${sessionlessEarliestOfTwo}`).toBeGreaterThan(0);
    expect(reordered, `cases whose applied order differed from the canonical one: ${reordered}/${cases}`).toBeGreaterThan(0);
    expect(repeated, `cases with a repeated event: ${repeated}/${cases}`).toBeGreaterThan(0);
    expect(lostLeaveAfterEnd, `cases where a leave arrived after its session's end: ${lostLeaveAfterEnd}/${cases}`).toBeGreaterThan(0);
    expect(peersChecked, "peer rows checked").toBeGreaterThanOrEqual(cases);
  }, 120_000);
});

// ─── applyPresenceEvent across two connections (the meeting lock) ──────────────────────────────────────────────────────

/** Is some backend waiting for the presence lock of `meetingId`? The key is `hashtext(meeting_id)`, a bigint advisory key, which
 *  pg_locks splits into classid (high 32 bits) and objid (low 32 bits). */
const waitingOnMeetingLock = async (meetingId: string) => {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and not granted and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtext(${meetingId})::bigint`;
  return r!.n > 0;
};

/** Applies `first` inside a transaction on one connection and holds it OPEN; then starts `second` on another connection
 *  (the pool) and waits until it is either blocked on the meeting's lock or finished (no lock); then commits the first and
 *  awaits the second. Returns which of the two the second did while the first was open: the witness that the two events really
 *  interleaved (under READ COMMITTED, without the lock, each statement misses the other's uncommitted write). */
async function interleave(meetingId: string, first: (tx: postgres.TransactionSql) => Promise<unknown>, second: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let opened!: () => void;
  const isOpen = new Promise<void>((r) => (opened = r));
  const firstTx = sql.begin(async (tx) => {
    await first(tx);
    opened();
    await gate;
  });
  // a failure of `first` must not leave this waiting on `isOpen` for ever
  await Promise.race([isOpen, firstTx]);
  let settled = false;
  const other = second().finally(() => {
    settled = true;
  });
  other.catch(() => undefined);
  let blocked = false;
  for (let i = 0; i < 400 && !settled && !blocked; i++) {
    blocked = await waitingOnMeetingLock(meetingId);
    if (!blocked && !settled) await new Promise((r) => setTimeout(r, 10));
  }
  const settledWhileOpen = settled;
  release();
  await firstTx;
  await other;
  return { blocked, settledWhileOpen };
}

describe.skipIf(!DB)("applyPresenceEvent across two connections (READ COMMITTED; the meeting's advisory lock)", () => {
  // Every case: one event's transaction is held open on one connection while the other event runs on a second connection.
  // Expected, from the rule (batch-1 T5 M1): a peer whose session ended is CLOSED at that end, whichever of the joined and the
  // ended commits first. `held` is passed explicitly (the receiver's contract), so no board is seeded.
  const held = { fixtureId: randomUUID(), side: "home" as const };
  const E = at(100 * SEC);

  const cases: { name: string; sessionId: string | null; firstIs: "joined" | "ended" }[] = [
    { name: "joined held open, then the session's ended", sessionId: "sess-1", firstIs: "joined" },
    { name: "the session's ended held open, then the joined", sessionId: "sess-1", firstIs: "ended" },
    { name: "a null-session joined held open, then an ended", sessionId: null, firstIs: "joined" },
    { name: "an ended held open, then a null-session joined", sessionId: null, firstIs: "ended" },
  ];
  let checked = 0;
  for (const c of cases) {
    it(`${c.name}: the row is stored closed at the end, left_by 'ended'`, async () => {
      const M = track(`race-${randomUUID().slice(0, 8)}`);
      const p = peer();
      const joined = joinedEv({ meetingId: M, peerId: p, custom: "c-race", joinedAt: at(10 * SEC), sessionId: c.sessionId });
      const ended = endedEv({ meetingId: M, sessionId: "sess-1", endedAt: E });
      const [a, b] = c.firstIs === "joined" ? [joined, ended] : [ended, joined];
      const outcome = await interleave(
        M,
        (tx) => applyPresenceEvent(tx, a, at(101 * SEC), held),
        () => applyPresenceEvent(sql, b, at(102 * SEC), held),
      );
      expect(outcome.blocked || outcome.settledWhileOpen, "premise: the second event ran while the first transaction was open").toBe(true);
      expect(await rowOf(M, p)).toMatchObject({ left_at: E, left_by: "ended", joined_at: at(10 * SEC) });
      expect(outcome.blocked, "the second event waited for the first's meeting lock").toBe(true);
      checked++;
    });
  }
  it("cases checked", () => expect(checked, "interleavings checked").toBe(cases.length));
});

// ─── readers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("currentPresence / everJoined / peersOf / recordPresenceFromRead", () => {
  const ids = (b: Awaited<ReturnType<typeof board>>) => ({ meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: b.home.personId });

  it("currentPresence: the latest live peer; matched by participant_id, and by custom id when the row has none", async () => {
    const b = await board();
    const [first, second] = [peer(), peer()];
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: first, custom: b.home.personId, joinedAt: at(1 * SEC) }), at(2 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: second, custom: b.home.personId, joinedAt: at(10 * SEC) }), at(11 * SEC));
    const cur = await currentPresence(sql, ids(b));
    expect(cur).toMatchObject({ peerId: second, sessionId: "sess-1", joinedAt: at(10 * SEC), source: "webhook", receivedAt: at(11 * SEC) });

    // a row whose custom id nobody had on file (participant_id null) is still found by the custom id the caller passes
    await clear(b.homeMeeting);
    const nobody = peer();
    const custom = `unfiled-${randomUUID()}`;
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: nobody, custom, joinedAt: at(SEC) }), at(2 * SEC));
    expect((await rowOf(b.homeMeeting, nobody)).participant_id, "premise: no participant on file").toBeNull();
    expect((await currentPresence(sql, { meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: custom }))?.peerId).toBe(nobody);
    expect(await currentPresence(sql, { meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: "someone-else" }), "a different custom id").toBeNull();
    // and another participant's rows are not this participant's
    expect(await currentPresence(sql, { meetingId: b.awayMeeting, participantId: b.awayParticipant, customParticipantId: custom }), "another meeting").toBeNull();
  });

  it("currentPresence after a reload: two open rows of one participant with EQUAL joined_at (the old fixture bug) - the later received_at wins, and with equal received_at the higher seq wins", async () => {
    const b = await board();
    const [p1, p2] = [peer(), peer()];
    const J = at(5 * SEC);
    const c = b.home.personId;
    // equal received_at: the higher seq (applied second) wins, in both application orders
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: J }), at(6 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: c, joinedAt: J }), at(6 * SEC));
    expect((await currentPresence(sql, ids(b)))?.peerId, "equal received_at: the second applied (higher seq)").toBe(p2);
    await clear(b.homeMeeting);
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: c, joinedAt: J }), at(6 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: J }), at(6 * SEC));
    expect((await currentPresence(sql, ids(b)))?.peerId, "equal received_at, reversed: still the second applied").toBe(p1);
    // later received_at wins over a HIGHER seq: p1 is applied last (higher seq) but was received earlier
    await clear(b.homeMeeting);
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: c, joinedAt: J }), at(9 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: J }), at(6 * SEC));
    expect((await currentPresence(sql, ids(b)))?.peerId, "the later received_at beats the higher seq").toBe(p2);
    // the EARLIER peer's row is rewritten (a changed indexed column makes it a new tuple version, at the end of the heap): only the
    // seq column, not the physical order of the rows, keeps the later-applied peer current
    await clear(b.homeMeeting);
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: J }), at(6 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: c, joinedAt: J }), at(6 * SEC));
    await sql`update fixture_video_presence set custom_participant_id = ${c + ":rewritten"} where meeting_id = ${b.homeMeeting} and peer_id = ${p1}`;
    expect((await currentPresence(sql, ids(b)))?.peerId, "a rewrite of the first peer's row does not make it the later row").toBe(p2);
  });

  it("currentPresence: null with no rows, and once every peer has left", async () => {
    const b = await board();
    expect(await currentPresence(sql, ids(b)), "empty case: no rows").toBeNull();
    const p = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: at(SEC) }), at(2 * SEC));
    expect((await currentPresence(sql, ids(b)))?.peerId, "premise: current while open").toBe(p);
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: at(SEC), leftAt: at(30 * SEC) }), at(31 * SEC));
    expect(await currentPresence(sql, ids(b))).toBeNull();
  });

  it("a read row is current for PRESENCE_READ_TRUST_MS and then is not (owner ruling R4); a webhook for the same peer makes it a fact", async () => {
    const b = await board();
    const p = peer();
    const R = at(100 * SEC);
    await recordPresenceFromRead(sql, { ...ids(b), peerId: p, sessionId: "sess-1", joinedAt: at(90 * SEC) }, R);
    const inside = await currentPresence(sql, { ...ids(b), now: at(100 * SEC + PRESENCE_READ_TRUST_MS - 1) });
    expect(inside).toMatchObject({ peerId: p, source: "read", receivedAt: R, joinedAt: at(90 * SEC) });
    expect(await currentPresence(sql, { ...ids(b), now: at(100 * SEC + PRESENCE_READ_TRUST_MS) }), "at exactly the trust window the hint is spent").toBeNull();
    expect(await currentPresence(sql, { ...ids(b), now: at(100 * SEC + 10 * PRESENCE_READ_TRUST_MS) })).toBeNull();
    // the default `now` is the wall clock: this row was received in 2026-11, so by then it is long spent
    expect(R.getTime() + PRESENCE_READ_TRUST_MS, "premise: R + trust is not in the future").toBeLessThan(Date.now() + 10 * 365 * 86_400_000);

    // a webhook joined for the SAME peer upgrades the row: current at any later now
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: at(90 * SEC) }), at(105 * SEC));
    const upgraded = await currentPresence(sql, { ...ids(b), now: at(100 * SEC + 1000 * PRESENCE_READ_TRUST_MS) });
    expect(upgraded).toMatchObject({ peerId: p, source: "webhook" });
    // and the webhook left closes it
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: at(90 * SEC), leftAt: at(200 * SEC) }), at(201 * SEC));
    expect(await currentPresence(sql, { ...ids(b), now: at(202 * SEC) })).toBeNull();
  });

  it("the trust window only covers READ rows: a webhook row received long ago is still current", async () => {
    const b = await board();
    const p = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p, custom: b.home.personId, joinedAt: at(SEC) }), at(2 * SEC));
    expect((await currentPresence(sql, { ...ids(b), now: at(2 * SEC + 1000 * PRESENCE_READ_TRUST_MS) }))?.peerId).toBe(p);
  });

  it("a read for a meeting held NOWHERE writes the row with no board; a later webhook joined or left fills the board from what the receiver gated on (batch-1 T5 M3)", async () => {
    const M = track(`unheld-${randomUUID().slice(0, 8)}`);
    expect(await heldMeeting(sql, M), "premise: no table holds the meeting").toBeNull();
    const held = { fixtureId: randomUUID(), side: "away" as const };
    const [viaJoined, viaLeft] = [peer(), peer()];
    const who = { meetingId: M, participantId: "prt-unheld", customParticipantId: "c-unheld" };
    await recordPresenceFromRead(sql, { ...who, peerId: viaJoined, sessionId: null, joinedAt: at(SEC) }, at(2 * SEC));
    await recordPresenceFromRead(sql, { ...who, peerId: viaLeft, sessionId: null, joinedAt: at(SEC) }, at(2 * SEC));
    let checked = 0;
    for (const p of [viaJoined, viaLeft]) {
      expect(await rowOf(M, p), `${p}: the read row has no board`).toMatchObject({ fixture_id: null, side: null, source: "read", participant_id: "prt-unheld" });
      checked++;
    }
    await applyPresenceEvent(sql, joinedEv({ meetingId: M, peerId: viaJoined, custom: "c-unheld", joinedAt: at(SEC) }), at(3 * SEC), held);
    await applyPresenceEvent(sql, leftEv({ meetingId: M, peerId: viaLeft, custom: "c-unheld", joinedAt: at(SEC), leftAt: at(4 * SEC) }), at(5 * SEC), held);
    expect(await rowOf(M, viaJoined), "the joined filled the board").toMatchObject({ fixture_id: held.fixtureId, side: "away", source: "webhook", left_at: null });
    checked++;
    expect(await rowOf(M, viaLeft), "the left filled the board").toMatchObject({ fixture_id: held.fixtureId, side: "away", source: "webhook", left_by: "left", left_at: at(4 * SEC) });
    checked++;
    expect(checked, "rows checked").toBe(4);
  });

  it("recordPresenceFromRead writes source 'read' stamped with the board, and never overwrites an existing row of either source", async () => {
    const b = await board();
    const [fresh, hooked, readFirst] = [peer(), peer(), peer()];
    await recordPresenceFromRead(sql, { ...ids(b), peerId: fresh, sessionId: "s-read", joinedAt: at(SEC) }, at(2 * SEC));
    const r = await rowOf(b.homeMeeting, fresh);
    expect(r).toMatchObject({
      source: "read",
      participant_id: b.homeParticipant,
      custom_participant_id: b.home.personId,
      session_id: "s-read",
      joined_at: at(SEC),
      left_at: null,
      left_by: null,
      fixture_id: b.fixtureId,
      side: "home",
      received_at: at(2 * SEC),
    });

    // an existing WEBHOOK row (closed, with its stamps) is untouched by a later read of the same peer
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: hooked, custom: b.home.personId, joinedAt: at(SEC), leftAt: at(20 * SEC) }), at(21 * SEC));
    const before = await rowOf(b.homeMeeting, hooked);
    await recordPresenceFromRead(sql, { ...ids(b), peerId: hooked, sessionId: "other", joinedAt: at(50 * SEC) }, at(60 * SEC));
    expect(await rowOf(b.homeMeeting, hooked)).toEqual(before);

    // an existing READ row is not overwritten by a second read
    await recordPresenceFromRead(sql, { ...ids(b), peerId: readFirst, sessionId: "s1", joinedAt: at(SEC) }, at(2 * SEC));
    const first = await rowOf(b.homeMeeting, readFirst);
    await recordPresenceFromRead(sql, { ...ids(b), peerId: readFirst, sessionId: "s2", joinedAt: at(9 * SEC) }, at(30 * SEC));
    expect(await rowOf(b.homeMeeting, readFirst)).toEqual(first);
  });

  it("everJoined: false with no row; true for an open row, a closed row, a read row, and a null-participant row matched by custom id (4 trues counted)", async () => {
    const b = await board();
    expect(await everJoined(sql, ids(b)), "empty case").toBe(false);
    let trues = 0;
    // open
    const open = peer();
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: open, custom: b.home.personId, joinedAt: at(SEC) }), at(2 * SEC));
    expect(await everJoined(sql, ids(b))).toBe(true);
    trues++;
    // closed
    await clear(b.homeMeeting);
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: open, custom: b.home.personId, joinedAt: at(SEC), leftAt: at(5 * SEC) }), at(6 * SEC));
    expect(await everJoined(sql, ids(b))).toBe(true);
    trues++;
    // read
    await clear(b.homeMeeting);
    await recordPresenceFromRead(sql, { ...ids(b), peerId: peer(), sessionId: null, joinedAt: at(SEC) }, at(2 * SEC));
    expect(await everJoined(sql, ids(b))).toBe(true);
    trues++;
    // null participant, custom id
    await clear(b.homeMeeting);
    const custom = `unfiled-${randomUUID()}`;
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: peer(), custom, joinedAt: at(SEC) }), at(2 * SEC));
    expect(await everJoined(sql, { meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: custom })).toBe(true);
    trues++;
    expect(trues, "true cases").toBe(4);
    // another participant / another meeting is false
    expect(await everJoined(sql, { meetingId: b.homeMeeting, participantId: b.homeParticipant, customParticipantId: "x" })).toBe(false);
    expect(await everJoined(sql, { meetingId: b.awayMeeting, participantId: b.awayParticipant, customParticipantId: custom })).toBe(false);
  });

  it("peersOf lists every peer in the presence order (oldest join first; equal joins by received_at, then seq)", async () => {
    const b = await board();
    const [p1, p2, p3] = [peer(), peer(), peer()];
    const c = b.home.personId;
    // arrival order p3, p1, p2; join order p1 < p2 = p3 (p2, p3 share a joinedAt; p2 was received first)
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p3, custom: c, joinedAt: at(20 * SEC) }), at(30 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: at(10 * SEC) }), at(31 * SEC));
    await applyPresenceEvent(sql, joinedEv({ meetingId: b.homeMeeting, peerId: p2, custom: c, joinedAt: at(20 * SEC) }), at(29 * SEC));
    await applyPresenceEvent(sql, leftEv({ meetingId: b.homeMeeting, peerId: p1, custom: c, joinedAt: at(10 * SEC), leftAt: at(15 * SEC) }), at(32 * SEC));
    const got = await peersOf(sql, ids(b));
    expect(got).toHaveLength(3);
    expect(got.map((r) => r.peerId)).toEqual([p1, p2, p3]);
    expect(got[0]).toMatchObject({ leftAt: at(15 * SEC), leftBy: "left", source: "webhook", sessionId: "sess-1", joinedAt: at(10 * SEC) });
    expect(got[1]).toMatchObject({ leftAt: null, leftBy: null });
    expect(await peersOf(sql, { meetingId: b.awayMeeting, participantId: b.awayParticipant, customParticipantId: b.away.personId }), "empty case").toEqual([]);
  });
});

// ─── presenceShadowReport ──────────────────────────────────────────────────────────────────────────────────────────────

/** A player participant on the board's home meeting, its camera verified at `seenAt`. Returns its participant id. */
async function seat(b: Awaited<ReturnType<typeof board>>, seenAt: Date | null, side: "home" | "away" = "home") {
  const participantId = await putVideoParticipant({ fixtureId: b.fixtureId, side, personId: null, preset: "player" });
  if (seenAt) {
    await sql`update fixture_video_participants set last_publisher_seen_at = ${seenAt}
               where fixture_id = ${b.fixtureId} and side = ${side} and participant_id = ${participantId}`;
  }
  return participantId;
}
/** A presence row written directly, so the test controls every stamp. */
async function presenceRow(
  b: Awaited<ReturnType<typeof board>>,
  o: { participantId: string | null; receivedAt: Date; joinedAt?: Date | null; leftAt?: Date | null; leftBy?: "left" | "ended" | null; source?: "webhook" | "read"; side?: "home" | "away"; peerId?: string; custom?: string },
) {
  const side = o.side ?? "home";
  const meetingId = side === "home" ? b.homeMeeting : b.awayMeeting;
  const peerId = o.peerId ?? peer();
  await sql`insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, joined_at, left_at, left_by, source, received_at)
            values (${meetingId}, ${peerId}, ${b.fixtureId}, ${side}, ${o.participantId}, ${o.custom ?? "c"}, ${o.joinedAt === undefined ? at(-60 * SEC) : o.joinedAt},
                    ${o.leftAt ?? null}, ${o.leftBy ?? (o.leftAt ? "left" : null)}, ${o.source ?? "webhook"}, ${o.receivedAt})`;
  return peerId;
}

describe.skipIf(!DB)("presenceShadowReport", () => {
  // Scoped to this file's seeded fixture ids, so other suites' seats on the shared DB never enter the counts.
  const S = T0;
  const SINCE = at(-3_600_000);

  it("covered needs a webhook row OPEN at the stamp; an old peer that already left does not cover a later seat", async () => {
    const b = await board();
    const p1 = await seat(b, S);
    const p2 = await seat(b, S);
    const p3 = await seat(b, S);
    const p4 = await seat(b, S);
    const p5 = await seat(b, S);
    const p6 = await seat(b, S);
    await presenceRow(b, { participantId: p1, receivedAt: at(-1 * SEC) }); // open, received before the stamp -> covered
    await presenceRow(b, { participantId: p2, receivedAt: at(-20 * SEC), joinedAt: at(-30 * SEC), leftAt: at(-5 * SEC) }); // an OLD peer, gone by the stamp -> missing
    await presenceRow(b, { participantId: p3, receivedAt: at(SHADOW_ARRIVAL_TOLERANCE_MS + SEC) }); // arrived after the tolerance -> missing
    await presenceRow(b, { participantId: p4, receivedAt: at(1 * SEC) }); // arrived inside the tolerance, open -> covered
    await presenceRow(b, { participantId: p5, receivedAt: at(-2 * SEC), source: "read" }); // only a read row -> missing
    await presenceRow(b, { participantId: p6, receivedAt: at(-1 * SEC), leftAt: at(5 * SEC) }); // left AFTER the stamp: open at it -> covered
    const rep = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [b.fixtureId] });
    // expected, typed from the table above: 6 seats verified; P1, P4, P6 covered; P2, P3, P5 missing
    expect(rep.verified).toBe(6);
    expect(rep.covered).toBe(3);
    expect(rep.missing.map((m) => m.participantId).sort()).toEqual([p2, p3, p5].sort());
    expect(rep.missing.every((m) => m.fixtureId === b.fixtureId && m.side === "home" && m.seenAt.getTime() === S.getTime())).toBe(true);
    expect(rep.covered + rep.missing.length, "covered + missing = verified").toBe(rep.verified);
  });

  it("a seat is covered by a row with NO participant whose custom id is the seat's person, in the seat's own meeting - the readers' rule (batch-1 m2)", async () => {
    // Expected, typed from currentPresence's rule: participant_id = the seat's, OR (participant_id null AND custom id = the seat's
    // person id) within the seat's meeting (fixture AND side). Three seats on two boards, one per arm of that rule.
    const one = await board();
    const two = await board();
    const verify = (b: Awaited<ReturnType<typeof board>>, participantId: string) =>
      sql`update fixture_video_participants set last_publisher_seen_at = ${S} where fixture_id = ${b.fixtureId} and participant_id = ${participantId}`;
    await verify(one, one.homeParticipant);
    await verify(one, one.awayParticipant);
    await verify(two, two.homeParticipant);
    // one/home: no participant on the row, the home player's person id, the home meeting -> covered
    await presenceRow(one, { participantId: null, custom: one.home.personId, receivedAt: at(-1 * SEC) });
    // one/away: the away player's person id, but the row names ANOTHER participant -> the custom arm does not apply -> missing
    await presenceRow(one, { participantId: "prt-someone-else", custom: one.away.personId, side: "away", receivedAt: at(-1 * SEC) });
    // two/home: no participant, the home player's person id, but on the AWAY meeting -> another meeting -> missing
    await presenceRow(two, { participantId: null, custom: two.home.personId, side: "away", receivedAt: at(-1 * SEC) });
    const rep = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [one.fixtureId, two.fixtureId] });
    expect(rep.verified, "seats checked").toBe(3);
    expect(rep.covered).toBe(1);
    expect(rep.missing.map((m) => m.participantId).sort()).toEqual([one.awayParticipant, two.homeParticipant].sort());
  });

  it("a seat whose camera was never verified (no last_publisher_seen_at) is not counted, and an ARBITER is never a verified player", async () => {
    const b = await board();
    await seat(b, null);
    const arbiter = await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: null, preset: "arbiter" });
    await sql`update fixture_video_participants set last_publisher_seen_at = ${S} where fixture_id = ${b.fixtureId} and side = 'home' and participant_id = ${arbiter}`;
    const rep = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [b.fixtureId] });
    expect(rep.verified).toBe(0);
    expect(rep.missing).toEqual([]);
  });

  it("open lists every row in scope with left_at null, and closedByEnded counts rows closed by meeting.ended only", async () => {
    const b = await board();
    const pid = await seat(b, S);
    const openWebhook = await presenceRow(b, { participantId: pid, receivedAt: at(-1 * SEC) });
    const openRead = await presenceRow(b, { participantId: null, receivedAt: at(-1 * SEC), source: "read", side: "away" });
    await presenceRow(b, { participantId: pid, receivedAt: at(-1 * SEC), leftAt: at(5 * SEC), leftBy: "left" });
    await presenceRow(b, { participantId: pid, receivedAt: at(-1 * SEC), leftAt: at(6 * SEC), leftBy: "ended" });
    await presenceRow(b, { participantId: pid, receivedAt: at(-1 * SEC), leftAt: at(7 * SEC), leftBy: "ended", side: "away" });
    const rep = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [b.fixtureId] });
    expect(rep.open.map((o) => o.peerId).sort(), "the two open rows").toEqual([openWebhook, openRead].sort());
    const web = rep.open.find((o) => o.peerId === openWebhook)!;
    expect(web).toMatchObject({ meetingId: b.homeMeeting, participantId: pid, source: "webhook", receivedAt: at(-1 * SEC) });
    expect(rep.open.find((o) => o.peerId === openRead)).toMatchObject({ meetingId: b.awayMeeting, participantId: null, source: "read" });
    expect(rep.closedByEnded, "only the two rows closed by the end").toBe(2);
  });

  it("scope: a seat and a presence row of a fixture outside fixtureIds are not counted; `since` excludes an older stamp and an older row", async () => {
    const mine = await board();
    const other = await board();
    const pMine = await seat(mine, S);
    const pOther = await seat(other, S);
    const pOld = await seat(mine, at(-2 * 3_600_000)); // verified before `since`
    await presenceRow(mine, { participantId: pMine, receivedAt: at(-1 * SEC) });
    await presenceRow(other, { participantId: pOther, receivedAt: at(-1 * SEC) });
    await presenceRow(mine, { participantId: pOld, receivedAt: at(-2 * 3_600_000) }); // a row older than `since`
    await presenceRow(other, { participantId: pOther, receivedAt: at(-1 * SEC), leftAt: at(5 * SEC), leftBy: "ended" });
    const rep = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [mine.fixtureId] });
    expect(rep.verified, "only my fixture's current seat").toBe(1);
    expect(rep.covered).toBe(1);
    expect(rep.open.map((o) => o.participantId), "only my fixture's in-window row").toEqual([pMine]);
    expect(rep.closedByEnded, "the other fixture's end is not mine").toBe(0);
    // both fixtures in scope: both current seats count, the old one still does not
    const both = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [mine.fixtureId, other.fixtureId] });
    expect(both.verified).toBe(2);
    expect(both.closedByEnded).toBe(1);
    // a `since` at the stamp itself includes it (>=), one after excludes it
    expect((await presenceShadowReport(sql, { since: S, fixtureIds: [mine.fixtureId] })).verified).toBe(1);
    expect((await presenceShadowReport(sql, { since: at(SEC), fixtureIds: [mine.fixtureId] })).verified).toBe(0);
  });

  it("empty scope (no seats, no rows): verified 0 - the script's --strict treats verified 0 as a FAILURE (Task 9), never a pass", async () => {
    const none = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [randomUUID()] });
    expect(none).toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0 });
    const noIds = await presenceShadowReport(sql, { since: SINCE, fixtureIds: [] });
    expect(noIds, "an explicit empty fixture list is an empty scope, not 'everything'").toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0 });
  });
});

// ─── prunePresence (Task 10b: retention) ───────────────────────────────────────────────────────────────────────────────

// The prune deletes by `received_at` over the WHOLE table, and CI runs the DB files in parallel on one database (every sweep pass in
// another file prunes too). So each case runs inside a transaction it rolls back: the rows it seeds are invisible to every other
// connection (no pass can delete them mid-case) and the prune, run on the clock of the year 2000 so its cutoffs fall in 1999, finds
// no committed row of any other suite to delete or count. The counts returned are therefore this case's own rows alone.
describe.skipIf(!DB)("prunePresence (retention)", () => {
  const NOW = new Date("2000-01-01T00:00:00.000Z");
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  // The retention figures typed from the spec (Task 10b: a week for the vendor's retry horizon, 30 days for a stay).
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const ROLLBACK = new Error("t10b: roll the case back");

  /** Runs `fn` in a transaction and always rolls it back; the case's own assertions run inside, so a failure still rolls back. */
  const inRolledBackTx = async (fn: (tx: postgres.TransactionSql) => Promise<void>) => {
    try {
      await sql.begin(async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
  };

  let n = 0;
  const delivery = async (tx: postgres.TransactionSql, age: number) => {
    const id = `t10b-d-${randomUUID()}-${n++}`;
    await tx`insert into realtimekit_webhook_deliveries (rtk_uuid, event, received_at) values (${id}, 'meeting.participantJoined', ${ago(age)})`;
    return id;
  };
  const presence = async (tx: postgres.TransactionSql, age: number) => {
    const m = `t10b-p-${randomUUID()}-${n++}`;
    await tx`insert into fixture_video_presence (meeting_id, peer_id, custom_participant_id, source, received_at)
             values (${m}, 'peer', 'custom', 'webhook', ${ago(age)})`;
    return m;
  };
  const ended = async (tx: postgres.TransactionSql, age: number) => {
    const m = `t10b-e-${randomUUID()}-${n++}`;
    await tx`insert into realtimekit_ended_sessions (meeting_id, session_id, ended_at, received_at) values (${m}, 's', ${ago(age)}, ${ago(age)})`;
    return m;
  };
  const deliveryExists = async (tx: postgres.TransactionSql, id: string) => (await tx`select 1 from realtimekit_webhook_deliveries where rtk_uuid = ${id}`).length === 1;
  const presenceExists = async (tx: postgres.TransactionSql, m: string) => (await tx`select 1 from fixture_video_presence where meeting_id = ${m}`).length === 1;
  const endedExists = async (tx: postgres.TransactionSql, m: string) => (await tx`select 1 from realtimekit_ended_sessions where meeting_id = ${m}`).length === 1;

  it("pins the two retention figures: a week for deliveries, 30 days for presence and ended sessions", () => {
    expect(WEBHOOK_DELIVERY_RETENTION_MS).toBe(WEEK);
    expect(PRESENCE_RETENTION_MS).toBe(MONTH);
  });

  it("a row a second older than its table's cutoff goes, one a second younger stays; deliveries cut at a week, the others at 30 days", async () => {
    await inRolledBackTx(async (tx) => {
      const dOld = await delivery(tx, WEEK + SEC);
      const dYoung = await delivery(tx, WEEK - SEC);
      const pOld = await presence(tx, MONTH + SEC);
      const pTen = await presence(tx, 10 * DAY); // older than a week, younger than 30 days: the deliveries' cutoff must not reach it
      const pYoung = await presence(tx, MONTH - SEC);
      const eOld = await ended(tx, MONTH + SEC);
      const eTen = await ended(tx, 10 * DAY);
      const eYoung = await ended(tx, MONTH - SEC);
      const dTen = await delivery(tx, 10 * DAY); // older than a week: the presence cutoff must not spare it

      const r = await prunePresence(tx, NOW);

      expect(r, "one old row per table, plus the ten-day delivery").toEqual({ deliveries: 2, presence: 1, endedSessions: 1 });
      expect([await deliveryExists(tx, dOld), await deliveryExists(tx, dTen)], "both deliveries past a week are gone").toEqual([false, false]);
      expect([await presenceExists(tx, pOld), await endedExists(tx, eOld)], "the 30-day-old presence and ended rows are gone").toEqual([false, false]);
      const kept = [
        await deliveryExists(tx, dYoung),
        await presenceExists(tx, pTen),
        await presenceExists(tx, pYoung),
        await endedExists(tx, eTen),
        await endedExists(tx, eYoung),
      ];
      expect(kept, "every younger row is still there").toEqual([true, true, true, true, true]);
      expect(kept.length, "anti-vacuity: five kept rows checked").toBe(5);
    });
  });

  it("a second call finds nothing to delete (zeros), and the kept rows survive it", async () => {
    await inRolledBackTx(async (tx) => {
      await delivery(tx, WEEK + SEC);
      await presence(tx, MONTH + SEC);
      await ended(tx, MONTH + SEC);
      const young = await presence(tx, MONTH - SEC);
      expect(await prunePresence(tx, NOW), "premise: the first call deleted one of each").toEqual({ deliveries: 1, presence: 1, endedSessions: 1 });
      expect(await prunePresence(tx, NOW)).toEqual({ deliveries: 0, presence: 0, endedSessions: 0 });
      expect(await presenceExists(tx, young)).toBe(true);
    });
  });

  it("an empty case: nothing seeded, nothing deleted", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await prunePresence(tx, NOW)).toEqual({ deliveries: 0, presence: 0, endedSessions: 0 });
    });
  });
});
