// Handover (court-stream-sessions.ts): the previous session stopped by a handover schedules its court end once, so the finished
// match's YouTube broadcast does not wait for the cron. A session that was already over (no stop) schedules nothing.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ends: [] as string[], active: new Map<string, boolean>() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const tag = (strings: unknown) => {
    const text = Array.isArray(strings) ? strings.join(" ") : "";
    if (text.includes("from fixture_stream_sessions")) {
      return Promise.resolve([...h.active.keys()].map((id) => ({ id, org_id: "o", fixture_id: `f-${id}` })));
    }
    return Promise.resolve([{ status: "completed" }]);
  };
  const sql = Object.assign((s: unknown, ...v: unknown[]) => tag(s, ...v), { begin: async (cb: (tx: typeof tag) => unknown) => cb(tag) });
  return { sql };
});
vi.mock("@/server/relay/telemetry", () => ({ recordEvent: async () => undefined }));
vi.mock("../stream-codes", () => ({ markAutoStartBlocked: async () => undefined }));
vi.mock("../stream-sessions/court-end", () => ({ endCourtBroadcastSoon: (sid: string) => { h.ends.push(sid); } }));
vi.mock("../stream-sessions/apply", () => ({
  apply: async (sid: string, decide: (row: { state: string }) => unknown) => { decide({ state: h.active.get(sid) ? "live" : "completed" }); },
}));

import { endOtherCourtSessions } from "../court-stream-sessions";

const deps = { now: () => new Date("2026-11-17T10:00:00Z") } as never;
const args = { linkId: "l", keepSid: "new", actorUserId: "u" };

describe("endOtherCourtSessions schedules the court end", () => {
  it("once for a session the handover actually stopped", async () => {
    h.ends = []; h.active = new Map([["old", true]]);
    expect(await endOtherCourtSessions(args, deps)).toEqual(["old"]);
    expect(h.ends).toEqual(["old"]);
  });
  it("never for a session that ended on its own in between", async () => {
    h.ends = []; h.active = new Map([["gone", false]]);
    expect(await endOtherCourtSessions(args, deps)).toEqual([]);
    expect(h.ends).toEqual([]);
  });
});
