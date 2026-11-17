// Check-in capacity plan 1, Task 3 (spec §6.2): the pure RealtimeKit webhook event parser.
//
// Pure and total: it never throws and never reads a clock. A known event missing a required field, or carrying a date it
// cannot read, is `null`, and a missing `leftAt` / `endedAt` is NOT replaced by the receipt time (spec §6.2): a presence row
// closed at the wrong instant is worse than a delivery refused. The signature is verified by the receiver before this runs.

export type RealtimeKitEvent =
  | { kind: "joined"; event: string; meetingId: string; sessionId: string | null; peerId: string; customParticipantId: string; joinedAt: Date }
  | { kind: "left"; event: string; meetingId: string; sessionId: string | null; peerId: string; customParticipantId: string; joinedAt: Date | null; leftAt: Date }
  | { kind: "ended"; event: string; meetingId: string; sessionId: string | null; endedAt: Date }
  | { kind: "other"; event: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-empty string, or null. */
const id = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** An ISO-8601 string that reads as an instant, or null (no other type is coerced: a number is not a date here). */
function isoDate(v: unknown): Date | null {
  if (typeof v !== "string" || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** null: not a RealtimeKit webhook body (no string `event`, or a known event missing a required field or with an unreadable date). */
export function parseRealtimeKitEvent(body: unknown): RealtimeKitEvent | null {
  if (!isRecord(body)) return null;
  const event = body.event;
  if (typeof event !== "string" || event === "") return null;

  if (event !== "meeting.participantJoined" && event !== "meeting.participantLeft" && event !== "meeting.ended") {
    return { kind: "other", event };
  }

  const meeting = body.meeting;
  if (!isRecord(meeting)) return null;
  const meetingId = id(meeting.id);
  if (meetingId === null) return null;
  const sessionId = id(meeting.sessionId); // tolerated: absent reads as null

  if (event === "meeting.ended") {
    const endedAt = isoDate(meeting.endedAt);
    if (endedAt === null) return null;
    return { kind: "ended", event, meetingId, sessionId, endedAt };
  }

  const participant = body.participant;
  if (!isRecord(participant)) return null;
  const peerId = id(participant.peerId);
  const customParticipantId = id(participant.customParticipantId);
  if (peerId === null || customParticipantId === null) return null;

  if (event === "meeting.participantJoined") {
    const joinedAt = isoDate(participant.joinedAt);
    if (joinedAt === null) return null;
    return { kind: "joined", event, meetingId, sessionId, peerId, customParticipantId, joinedAt };
  }

  const leftAt = isoDate(participant.leftAt);
  if (leftAt === null) return null;
  // tolerated: a `left` without a readable joinedAt still closes the seat, so it reads as null rather than dropping the leave
  return { kind: "left", event, meetingId, sessionId, peerId, customParticipantId, joinedAt: isoDate(participant.joinedAt), leftAt };
}
