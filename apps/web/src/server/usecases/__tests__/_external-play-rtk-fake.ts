// A fake RealtimeKit backend: the vendor's REST surface in memory, in front of the REAL T7 adapter
// (`ensureMeeting`, `addParticipant`, `seatCameraEvidence`, `refreshParticipantToken`), so every seat that passes through it
// goes through the adapter's real response parsing - a double that answered `true`/`false` directly would prove only the
// double. Extracted from external-play-preflight.test.ts (the capacity build needs it in more than one file); nothing in it
// changed. Nothing here touches the network.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  addParticipant,
  ensureMeeting,
  refreshParticipantToken,
  seatCameraEvidence,
} from "@/server/external-play/video/realtimekit";
import type { CallBudget } from "../../external-play/video/budget";
import type { PreflightDeps, SeatResult } from "../external-play/preflight";

/** The instant a fake peer "joined a second before": the clock the preflight suite seats at. */
export const FAKE_NOW = new Date("2026-10-01T12:05:00.000Z");


export const RUN = randomUUID().slice(0, 8);
export const RTK_PREFIX = "/client/v4/accounts/acct-1/realtime/kit/app-1";

export const RTK_ENV: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: "acct-1",
  REALTIMEKIT_API_TOKEN: "rtk-test-token",
  REALTIMEKIT_APP_ID: "app-1",
  REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
  REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
};
export function configureRealtimeKit(): void {
  for (const [k, v] of Object.entries(RTK_ENV)) vi.stubEnv(k, v);
}

/** One connected (or departed) tab: a RealtimeKit PEER, with its own peer report (T17B fix 2, D2). `events` null ⇒
 *  RealtimeKit has no report for it. */
type FakePeer = { id: string; joinedAt: string; left: boolean; events: unknown[] | null };
type FakeParticipant = { meetingId: string; subject: string; peers: number; everJoined: boolean; peerList: FakePeer[] };

/** The measured camera-ON peer's events (T17B evidence t17b-peer-reports-live.json, peer "on"): what an honest
 *  browser that granted the camera reports — and no producer samples (they arrive late, so the seat never reads them). */
export const CAMERA_ON_EVENTS = (at: string) => [
  { name: "audio_off", timestamp: at },
  { name: "video_on", timestamp: at },
  { name: "media_permission", metadata: { device_type: "VIDEO", permission: "ACCEPTED" }, timestamp: at },
  { name: "precall_begin", timestamp: at },
];
export type FailRule = (method: string, path: string) => Response | "network" | null;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** RealtimeKit's documented shapes, in memory. A participant is LIVE while at
 *  least one peer (tab) is connected with one of its tokens — measured
 *  2026-10-09 (rtk-token-regen.log): two tabs on one participant are one
 *  session row carrying both peers, and a regenerated token does not
 *  invalidate the earlier one. Nothing here touches the network. */
export function fakeRealtimeKit(opts: { budget?: CallBudget } = {}) {
  /** HTTP requests, `METHOD /path` relative to the app. */
  const http: string[] = [];
  /** Adapter functions seatPlayer called, in order. */
  const adapter: string[] = [];
  const participants = new Map<string, FakeParticipant>();
  const tokens = new Map<string, string>(); // token → participant id
  // meeting_id is UNIQUE across the (reused) test DB: every fake instance
  // gets its own prefix on top of the file's RUN suffix.
  const FAKE = `${RUN}-${randomUUID().slice(0, 6)}`;
  let seq = 0;
  let fail: FailRule = () => null;
  // Two-tab race: hold every add-participant answer until N have arrived.
  let holdMintsFor = 0;
  let mintsArrived = 0;
  let releaseMints: () => void = () => undefined;
  const mintsReleased = new Promise<void>((r) => {
    releaseMints = r;
  });

  const doFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname.replace(RTK_PREFIX, "");
    http.push(`${method} ${path}`);
    const failed = fail(method, path);
    if (failed === "network") throw new TypeError("fetch failed");
    if (failed) return failed;
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/meetings") {
      seq += 1;
      return json(201, { success: true, data: { id: `mtg-${FAKE}-${seq}` } });
    }
    if (method === "PATCH" && (m = path.match(/^\/meetings\/([^/]+)$/))) {
      return json(200, { success: true, data: { id: m[1], status: "INACTIVE" } });
    }
    if (method === "POST" && (m = path.match(/^\/meetings\/([^/]+)\/participants$/))) {
      mintsArrived += 1;
      if (holdMintsFor > 0) {
        if (mintsArrived >= holdMintsFor) releaseMints();
        await mintsReleased;
      }
      const body = JSON.parse(String(init?.body)) as { custom_participant_id: string };
      seq += 1;
      const id = `p-${FAKE}-${seq}`;
      const token = `jwt-add-${id}`;
      participants.set(id, { meetingId: m[1]!, subject: body.custom_participant_id, peers: 0, everJoined: false, peerList: [] });
      tokens.set(token, id);
      return json(201, { success: true, data: { id, token } });
    }
    if (method === "POST" && (m = path.match(/^\/meetings\/([^/]+)\/participants\/([^/]+)\/token$/))) {
      const id = decodeURIComponent(m[2]!);
      if (!participants.has(id)) return json(404, { success: false, error: { code: 404, message: "not found" } });
      seq += 1;
      const token = `jwt-regen-${id}-${seq}`;
      tokens.set(token, id);
      return json(200, { success: true, data: { token } });
    }
    if (method === "GET" && (m = path.match(/^\/meetings\/([^/]+)\/active-session$/))) {
      const mid = m[1]!;
      const anyone = [...participants.values()].some((p) => p.meetingId === mid && p.peers > 0);
      if (!anyone) return json(404, { success: false, error: { code: 404, message: "no active session" } });
      return json(200, { success: true, data: { id: `sess-${mid}`, status: "LIVE" } });
    }
    if (method === "GET" && (m = path.match(/^\/sessions\/sess-([^/]+)\/participants$/))) {
      const mid = m[1]!;
      const rows = [...participants.entries()]
        .filter(([, p]) => p.meetingId === mid && p.everJoined)
        .map(([id, p]) => ({
          id: `conn-${id}`,
          user_id: id,
          custom_participant_id: p.subject,
          joined_at: "2026-10-01T12:01:00Z",
          left_at: p.peers > 0 ? null : "2026-10-01T12:04:00Z",
          peer_events: p.peerList.flatMap((peer) => [
            { event_name: "PEER_JOINING", peer_id: peer.id, created_at: peer.joinedAt },
            ...(peer.left ? [{ event_name: "PEER_LEAVING", peer_id: peer.id, created_at: "2026-10-01T12:04:00Z" }] : []),
          ]),
        }));
      return json(200, { success: true, data: { participants: rows } });
    }
    if (method === "GET" && (m = path.match(/^\/sessions\/peer-report\/([^/]+)$/))) {
      const peer = [...participants.values()].flatMap((p) => p.peerList).find((x) => x.id === decodeURIComponent(m![1]!));
      if (!peer || peer.events === null) return json(404, { success: false, error: { code: 404, message: "No peer event exists" } });
      return json(200, { success: true, data: { participant: { peer_report: { metadata: { events: peer.events } } } } });
    }
    throw new Error(`fake RealtimeKit: unrouted ${method} ${path}`);
  };
  const fetch = doFetch as unknown as typeof globalThis.fetch;

  const video: NonNullable<PreflightDeps["video"]> = {
    ensureMeeting: (fixtureId, side) => {
      adapter.push("ensureMeeting");
      return ensureMeeting(fixtureId, side, { fetch, ...(opts.budget ? { budget: opts.budget } : {}) });
    },
    addParticipant: (a) => {
      adapter.push(`addParticipant:${a.preset}`);
      return addParticipant(a, { fetch, ...(opts.budget ? { budget: opts.budget } : {}) });
    },
    seatCameraEvidence: (a) => {
      adapter.push("seatCameraEvidence");
      return seatCameraEvidence(a, { fetch, ...(opts.budget ? { budget: opts.budget } : {}) });
    },
    refreshParticipantToken: (a) => {
      adapter.push("refreshParticipantToken");
      return refreshParticipantToken(a, { fetch, ...(opts.budget ? { budget: opts.budget } : {}) });
    },
  };

  return {
    video,
    http,
    adapter,
    participants,
    /** A browser tab joining the meeting WITH a token the server handed out — a new PEER, whose report shows the
     *  measured honest camera (granted and on) unless `events` says otherwise. It joined a second before NOW. */
    joinWith(token: string, events: (at: string) => unknown[] | null = CAMERA_ON_EVENTS): void {
      const id = tokens.get(token);
      const p = id === undefined ? undefined : participants.get(id);
      if (!p) throw new Error(`fake RealtimeKit: no participant holds token ${token}`);
      p.peers += 1;
      p.everJoined = true;
      seq += 1;
      const at = new Date(FAKE_NOW.getTime() - 1_000).toISOString();
      p.peerList.push({ id: `peer-${FAKE}-${seq}`, joinedAt: at, left: false, events: events(at) });
    },
    /** One tab of this participant closes: its latest connected peer leaves. */
    leave(participantId: string): void {
      const p = participants.get(participantId);
      if (!p || p.peers === 0) throw new Error(`fake RealtimeKit: ${participantId} is not connected`);
      p.peers -= 1;
      const peer = p.peerList.filter((x) => !x.left).at(-1);
      if (peer) peer.left = true;
    },
    failWhen(rule: FailRule): void {
      fail = rule;
    },
    /** Every add-participant request waits until `n` have arrived, so
     *  concurrent first claims all mint before any of them stores. */
    holdMintsUntilArrived(n: number): void {
      holdMintsFor = n;
    },
    /** The token a result carries, joined in a NEW tab. */
    join(result: SeatResult): string {
      const token = "participant" in result && result.participant ? result.participant.authToken : null;
      if (!token) throw new Error(`fake RealtimeKit: nothing to join with in ${JSON.stringify(result)}`);
      this.joinWith(token);
      return token;
    },
  };
}

