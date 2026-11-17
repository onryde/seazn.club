// Check-in capacity plan 1, Task 3 (spec §6.2): the pure RealtimeKit webhook event parser.
//
// Expected values come from spec §6.2's body shapes and the fixture's own emitted bodies, never from the parser. The
// required key paths of the sweep are typed here from the spec, not read off the parser. Anti-vacuity: the sweep reports how
// many (shape, path) pairs it checked and zero (or anything but the spec's 13) is a failure.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type FixtureWebhook,
  type RealtimeKitFixtureServer,
} from "../../../../../e2e/realtimekit-fixture-server";
import { parseRealtimeKitEvent } from "../webhook-event";

type Body = Record<string, unknown>;
type Shape = "joined" | "left" | "ended";

const JOINED_AT = "2026-11-17T10:00:00.000Z";
const LEFT_AT = "2026-11-17T10:05:00.000Z";
const ENDED_AT = "2026-11-17T10:06:00.000Z";

/** The three body shapes of spec §6.2 (the shape Task 1's fixture emits), fresh per call. */
const BODIES: Record<Shape, () => Body> = {
  joined: () => ({
    event: "meeting.participantJoined",
    meeting: { id: "mtg-1", sessionId: "sess-1", status: "LIVE" },
    participant: { peerId: "peer-1", customParticipantId: "person-1", presetName: "e2e_chess_player", joinedAt: JOINED_AT },
  }),
  left: () => ({
    event: "meeting.participantLeft",
    meeting: { id: "mtg-1", sessionId: "sess-1", status: "LIVE" },
    participant: { peerId: "peer-1", customParticipantId: "person-1", presetName: "e2e_chess_player", joinedAt: JOINED_AT, leftAt: LEFT_AT },
  }),
  ended: () => ({
    event: "meeting.ended",
    meeting: { id: "mtg-1", sessionId: "sess-1", status: "ENDED", endedAt: ENDED_AT },
  }),
};

/** Required key paths per shape, typed from spec §6.2 (never read off the parser), with the kind of unreadable value each takes. */
const REQUIRED: { shape: Shape; path: string[]; unreadable: unknown }[] = [
  ...(["joined", "left", "ended"] as const).map((shape) => ({ shape, path: ["event"], unreadable: 7 })),
  ...(["joined", "left", "ended"] as const).map((shape) => ({ shape, path: ["meeting", "id"], unreadable: 7 })),
  ...(["joined", "left"] as const).map((shape) => ({ shape, path: ["participant", "peerId"], unreadable: 7 })),
  ...(["joined", "left"] as const).map((shape) => ({ shape, path: ["participant", "customParticipantId"], unreadable: 7 })),
  { shape: "joined", path: ["participant", "joinedAt"], unreadable: "yesterday" },
  { shape: "left", path: ["participant", "leftAt"], unreadable: "yesterday" },
  { shape: "ended", path: ["meeting", "endedAt"], unreadable: "yesterday" },
];

function at(body: Body, path: string[], mutate: (parent: Body, key: string) => void): Body {
  const copy = structuredClone(body);
  let parent = copy;
  for (const k of path.slice(0, -1)) parent = parent[k] as Body;
  mutate(parent, path[path.length - 1]);
  return copy;
}

describe("parseRealtimeKitEvent", () => {
  it("parses the three events the receiver applies", () => {
    expect(parseRealtimeKitEvent(BODIES.joined())).toEqual({
      kind: "joined",
      event: "meeting.participantJoined",
      meetingId: "mtg-1",
      sessionId: "sess-1",
      peerId: "peer-1",
      customParticipantId: "person-1",
      joinedAt: new Date(JOINED_AT),
    });
    expect(parseRealtimeKitEvent(BODIES.left())).toEqual({
      kind: "left",
      event: "meeting.participantLeft",
      meetingId: "mtg-1",
      sessionId: "sess-1",
      peerId: "peer-1",
      customParticipantId: "person-1",
      joinedAt: new Date(JOINED_AT),
      leftAt: new Date(LEFT_AT),
    });
    expect(parseRealtimeKitEvent(BODIES.ended())).toEqual({
      kind: "ended",
      event: "meeting.ended",
      meetingId: "mtg-1",
      sessionId: "sess-1",
      endedAt: new Date(ENDED_AT),
    });
  });

  it("an unknown event name is `other`, never null", () => {
    expect(parseRealtimeKitEvent({ event: "meeting.started", meeting: { id: "m" } })).toEqual({ kind: "other", event: "meeting.started" });
    // even with no meeting at all: the name is the whole of what `other` carries
    expect(parseRealtimeKitEvent({ event: "recording.statusUpdate" })).toEqual({ kind: "other", event: "recording.statusUpdate" });
  });

  it("a known event missing a required field is null (sweep: every required field of every applied shape removed, one at a time)", () => {
    let checked = 0;
    for (const { shape, path, unreadable } of REQUIRED) {
      const label = `${shape}:${path.join(".")}`;
      expect(parseRealtimeKitEvent(at(BODIES[shape](), path, (p, k) => delete p[k])), `${label} removed`).toBeNull();
      expect(parseRealtimeKitEvent(at(BODIES[shape](), path, (p, k) => (p[k] = unreadable))), `${label} unreadable`).toBeNull();
      checked++;
    }
    // spec §6.2: joined 5 + left 5 + ended 3. Zero, or any other count, is a failure (a vacuous or drifted sweep).
    expect(checked).toBe(13);
    // the unmutated bodies still parse, so every null above is the mutation's doing
    for (const shape of ["joined", "left", "ended"] as const) expect(parseRealtimeKitEvent(BODIES[shape]())).not.toBeNull();
  });

  it("a known event whose required parent object is missing is null, not a throw", () => {
    expect(parseRealtimeKitEvent({ event: "meeting.participantJoined" })).toBeNull();
    expect(parseRealtimeKitEvent({ event: "meeting.participantLeft", meeting: { id: "m" }, participant: null })).toBeNull();
    expect(parseRealtimeKitEvent({ event: "meeting.ended", meeting: "m" })).toBeNull();
    expect(parseRealtimeKitEvent({ event: "meeting.participantJoined", meeting: [], participant: [] })).toBeNull();
  });

  it("an empty id is as unusable as a missing one", () => {
    expect(parseRealtimeKitEvent(at(BODIES.joined(), ["meeting", "id"], (p, k) => (p[k] = "")))).toBeNull();
    expect(parseRealtimeKitEvent(at(BODIES.joined(), ["participant", "peerId"], (p, k) => (p[k] = "")))).toBeNull();
    expect(parseRealtimeKitEvent(at(BODIES.left(), ["participant", "customParticipantId"], (p, k) => (p[k] = "")))).toBeNull();
  });

  it("tolerated as null, and only these: a missing meeting.sessionId (all three shapes), a missing participant.joinedAt on `left`", () => {
    let checked = 0;
    for (const shape of ["joined", "left", "ended"] as const) {
      const ev = parseRealtimeKitEvent(at(BODIES[shape](), ["meeting", "sessionId"], (p, k) => delete p[k]));
      expect(ev, shape).not.toBeNull();
      expect(ev).toMatchObject({ sessionId: null });
      checked++;
    }
    expect(checked).toBe(3);
    const left = parseRealtimeKitEvent(at(BODIES.left(), ["participant", "joinedAt"], (p, k) => delete p[k]));
    expect(left).toEqual({
      kind: "left",
      event: "meeting.participantLeft",
      meetingId: "mtg-1",
      sessionId: "sess-1",
      peerId: "peer-1",
      customParticipantId: "person-1",
      joinedAt: null,
      leftAt: new Date(LEFT_AT), // from the payload, never the receipt time
    });
    // an unreadable optional joinedAt must not drop the leave that closes a seat: it reads as absent
    const odd = parseRealtimeKitEvent(at(BODIES.left(), ["participant", "joinedAt"], (p, k) => (p[k] = "yesterday")));
    expect(odd).toMatchObject({ kind: "left", joinedAt: null, leftAt: new Date(LEFT_AT) });
  });

  it("a body that is not an object is null", () => {
    let checked = 0;
    for (const b of [null, 1, "x", [], undefined, true, { event: 3 }, {}]) {
      expect(parseRealtimeKitEvent(b)).toBeNull();
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("never throws, whatever it is given", () => {
    const hostile: unknown[] = [
      { event: "meeting.participantJoined", meeting: { id: "m" }, participant: { peerId: {}, customParticipantId: [], joinedAt: {} } },
      { event: "meeting.ended", meeting: { id: "m", endedAt: {} } },
      { event: "meeting.ended", meeting: { id: "m", endedAt: "" } },
      Object.create(null),
    ];
    for (const b of hostile) expect(() => parseRealtimeKitEvent(b)).not.toThrow();
    expect(parseRealtimeKitEvent(hostile[0])).toBeNull();
    expect(parseRealtimeKitEvent(hostile[1])).toBeNull();
    expect(parseRealtimeKitEvent(hostile[2])).toBeNull();
  });
});

// AGENTS.md failure class 1: the parser is proven against the fixture's REAL emitted bodies, not a hand-typed copy.
describe("parseRealtimeKitEvent against the fixture's real emitted bodies", () => {
  let fx: RealtimeKitFixtureServer;
  const got: FixtureWebhook[] = [];
  beforeAll(async () => {
    fx = await startRealtimeKitFixtureServer(0, { webhooks: async (w) => void got.push(w) });
  });
  beforeEach(async () => {
    await fx.reset();
    got.length = 0;
  });
  afterAll(() => fx.close());

  const kit = (path: string, init: RequestInit = {}) =>
    fetch(`${fx.url}${fx.kitPath}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" },
    });

  it("a join, a leave and the session's end each parse to the fields the fixture itself recorded", async () => {
    const m = (await (await kit("/meetings", { method: "POST", body: JSON.stringify({ title: "seazn-parser-seam" }) })).json()) as { data: { id: string } };
    const p = (await (
      await kit(`/meetings/${m.data.id}/participants`, {
        method: "POST",
        body: JSON.stringify({ custom_participant_id: "person-seam", preset_name: REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_PLAYER_PRESET }),
      })
    ).json()) as { data: { id: string } };

    fx.setLivePublisher(p.data.id, true);
    const peerId = fx.currentPeer(p.data.id);
    expect(peerId).not.toBeNull();
    fx.setLivePublisher(p.data.id, false); // the last one leaving ends the session
    await fx.webhooksSettled();

    const parsed = got.map((w) => ({ w, ev: parseRealtimeKitEvent(JSON.parse(w.body)) }));
    // anti-vacuity: join, leave, end - exactly three bodies, none of them null or `other`
    expect(parsed.map((x) => x.ev?.kind)).toEqual(["joined", "left", "ended"]);
    expect(parsed.map((x) => x.ev?.event)).toEqual(got.map((w) => w.event));

    const session = fx.sessions(m.data.id)[0];
    const [joined, left, ended] = parsed.map((x) => x.ev);
    expect(joined).toMatchObject({ meetingId: m.data.id, sessionId: session.id, peerId, customParticipantId: "person-seam" });
    expect(left).toMatchObject({ meetingId: m.data.id, sessionId: session.id, peerId, customParticipantId: "person-seam" });
    expect(ended).toMatchObject({ meetingId: m.data.id, sessionId: session.id });

    // the instants are the fixture's own record of them, as it serves them over HTTP
    const rows = (await (await kit(`/sessions/${session.id}/participants?include_peer_events=true`)).json()) as {
      data: { participants: { joined_at: string; left_at: string | null; peer_events: { event_name: string; peer_id: string; created_at: string }[] }[] };
    };
    const row = rows.data.participants[0];
    const peerJoin = row.peer_events.find((e) => e.event_name === "PEER_JOINING" && e.peer_id === peerId)!;
    const peerLeave = row.peer_events.find((e) => e.event_name === "PEER_LEAVING" && e.peer_id === peerId)!;
    expect(joined).toMatchObject({ joinedAt: new Date(peerJoin.created_at) });
    expect(left).toMatchObject({ joinedAt: new Date(peerJoin.created_at), leftAt: new Date(peerLeave.created_at) });
    const listed = (await (await kit(`/sessions?associated_id=${m.data.id}`)).json()) as { data: { sessions: { id: string; ended_at: string | null }[] } };
    const recorded = listed.data.sessions.find((x) => x.id === session.id)!;
    expect(recorded.ended_at).not.toBeNull();
    expect(ended).toMatchObject({ endedAt: new Date(recorded.ended_at!) });
  });
});
