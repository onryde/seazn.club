// Task 17 — a local stand-in for the Cloudflare RealtimeKit REST API, pointed
// at by REALTIMEKIT_BASE_URL (src/server/external-play/video/realtimekit.ts,
// `cfEnvelope`). Its routes are the ones that adapter ACTUALLY calls, under
// `/accounts/{account}/realtime/kit/{app}` (the brief's list was stale, Task 7
// carry): POST /meetings, PATCH /meetings/{id}, POST /meetings/{id}/participants,
// POST .../participants/{pid}/token, DELETE .../participants/{pid},
// GET /meetings/{id}/active-session, POST .../active-session/kick and /kick-all,
// GET /sessions/{sid}/participants[?include_peer_events=true], GET /sessions
// ?associated_id=, GET /sessions/peer-report/{peer}. Every success is the
// `{success: true, data}` envelope the adapter requires.
//
// THE ONE DESIGN RULE HERE. §5.2 and §10: the POC gated check-in on a
// client-sent `cameraOk` boolean, which is forgeable, and this design seats a
// player only when the MEETING reports them present. So presence in this stub
// is settable by exactly ONE thing — `setLivePublisher()`, an in-process call
// from the spec — and by NOTHING that arrives over HTTP. No request body,
// header or query parameter on any route below can create a live row; the
// kick routes can only END one. A browser cannot reach it even by lying, so a
// green seat in the walkthrough is always a seat the SERVER earned by asking.
// realtimekit-fixture-contract.test.ts's forged-claim property sends every
// route every spelling of the claim and asserts nobody goes live.
//
// The corollary worth guarding: Playwright's fake camera
// (--use-fake-device-for-media-stream) satisfies getUserMedia in the PAGE, and
// the real RealtimeKit SDK in that page cannot join a meeting this stub
// minted. Neither half seats anyone; the spec says who is present.
//
// The same rule holds for the CAMERA (T17B fix 2, D2): every join gets a peer
// whose peer report (`/sessions/peer-report/{peer}`) is built from an
// in-process camera state — `on` by default, the measured honest camera:
// `media_permission{VIDEO, ACCEPTED}` and `video_on`, with NO producer samples
// (measured: samples arrive minutes late, so the seat never reads them) —
// changed only by `setLivePublisher`'s `camera` and `setPeerCamera`. Shapes
// are the measured live ones (T17B, 2026-10-14): a DENIED peer logs
// `video_on`, `media_permission{VIDEO, DENIED}` and `video_off` at one instant.
//
// What is NOT measured (owed live, task-17-report.md): the exact 404 body of
// an active-session with nobody in it (modelled as RealtimeKit's documented
// error envelope, which is what the adapter reads), the kick/DELETE bodies and
// GET /sessions' shape. A reload adds a new PEER under the same session row
// (MEASURED, T17B 2026-10-14) — modelled so; a rejoin after the session ended
// is a new session and so a new row. Participant rows carry the measured
// fields (`id` the session participant id, `user_id` our add-participant id,
// `peer_events[]` with `event_name` PEER_JOINING | PEER_LEAVING, `peer_id`,
// `created_at`).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** 4321 is the Lichess fixture's, 4319 the AI fixture's. CI and ci-local.sh
 *  point REALTIMEKIT_BASE_URL here; e2e-ci-wiring.test.ts imports this. */
export const REALTIMEKIT_FIXTURE_PORT = 4322;
export const REALTIMEKIT_FIXTURE_URL = `http://127.0.0.1:${REALTIMEKIT_FIXTURE_PORT}`;

/** The five variables the adapter refuses to run without (requireConfig), as
 *  the app server under test must carry them. Fixture values, never secrets.
 *  CI's job env and ci-local.sh set exactly these; the wiring test pins it. */
export const REALTIMEKIT_FIXTURE_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "e2e-rtk-account",
  REALTIMEKIT_API_TOKEN: "e2e-rtk-api-token",
  REALTIMEKIT_APP_ID: "e2e-rtk-app",
  REALTIMEKIT_PLAYER_PRESET: "e2e_chess_player",
  REALTIMEKIT_ARBITER_PRESET: "e2e_chess_arbiter",
} as const;

export interface RealtimeKitFixtureCall {
  method: string;
  /** Path below the kit prefix, query stripped. */
  path: string;
  /** The route template it matched, e.g. "GET /meetings/:id/active-session",
   *  or "unhandled". */
  route: string;
  query: Record<string, string>;
  body: unknown;
  at: number;
}

export interface FixtureParticipant {
  id: string;
  meetingId: string;
  /** `custom_participant_id` — a person id for a player, a user id for an arbiter. */
  subject: string;
  preset: string;
  deleted: boolean;
}

export interface FixtureSession {
  id: string;
  meetingId: string;
  status: "LIVE" | "ENDED";
}

/** The camera a joining peer's report shows (T17B fix 2, D2), as measured:
 *  `on` — ACCEPTED + `video_on`; `denied` — the browser refused it; `off` —
 *  ACCEPTED, then turned off; `pending` — a report with no events yet;
 *  `none` — no report at all (RealtimeKit's not-found). */
export type FixtureCamera = "on" | "denied" | "off" | "pending" | "none";

export interface RealtimeKitFixtureServer {
  url: string;
  port: number;
  /** `/accounts/{account}/realtime/kit/{app}` — the prefix every route sits under. */
  kitPath: string;
  calls: RealtimeKitFixtureCall[];
  /** THE ONLY WAY anyone is present. `true` joins (a new session row and a
   *  new peer, opening a session if the meeting has none LIVE); `false`
   *  leaves (the session ENDS when the last one leaves). Throws for an
   *  unknown, removed or deactivated participant. */
  setLivePublisher(participantId: string, live: boolean, opts?: { camera?: FixtureCamera }): void;
  /** Append a `video_on` / `video_off` to this participant's CURRENT peer's
   *  report (a camera turned off or back on mid-session). Throws when the
   *  participant has no connected peer. */
  setPeerCamera(participantId: string, event: "video_on" | "video_off"): void;
  /** This participant's current peer: the latest PEER_JOINING with no
   *  PEER_LEAVING after it, or null. */
  currentPeer(participantId: string): string | null;
  /** D11's outage: every route answers 503 until cleared. */
  setUnavailable(down: boolean): void;
  /** An outage on the peer report ALONE (D2): GET /sessions/peer-report/{peer}
   *  answers 503 while every other route still works, until cleared. */
  setPeerReportsUnavailable(down: boolean): void;
  /** Serve a recorded peer report's `data` for GET /sessions/peer-report/{peerId}. */
  servePeerReport(peerId: string, data: unknown): void;
  participant(participantId: string): FixtureParticipant | null;
  /** The most recent participant minted for `subject` (a person id). */
  participantFor(subject: string): FixtureParticipant | null;
  liveParticipantIds(): string[];
  sessions(meetingId: string): FixtureSession[];
  meetingStatus(meetingId: string): string | null;
  reset(): void;
  close(): Promise<void>;
}

type Meeting = { id: string; title: string; status: "ACTIVE" | "INACTIVE"; createdAt: string };
type Row = {
  id: string;
  sessionId: string;
  userId: string;
  subject: string;
  preset: string;
  joinedAt: string;
  leftAt: string | null;
  peerEvents: { event_name: "PEER_JOINING" | "PEER_LEAVING"; peer_id: string; participant_id: string; created_at: string }[];
};
type PeerEvent = { name: string; timestamp: string; metadata?: Record<string, string> };

/** The measured report events of a joining peer (T17B q2-peer-*.json). */
function joinEvents(camera: FixtureCamera, at: string): PeerEvent[] | null {
  const permission = (p: string): PeerEvent => ({ name: "media_permission", metadata: { device_type: "VIDEO", permission: p }, timestamp: at });
  switch (camera) {
    case "on":
      return [{ name: "audio_off", timestamp: at }, { name: "video_on", timestamp: at }, permission("ACCEPTED"), { name: "precall_begin", timestamp: at }];
    case "denied":
      return [{ name: "audio_off", timestamp: at }, { name: "video_on", timestamp: at }, permission("DENIED"), { name: "video_off", timestamp: at }, { name: "precall_begin", timestamp: at }];
    case "off":
      return [{ name: "audio_off", timestamp: at }, { name: "video_on", timestamp: at }, permission("ACCEPTED"), { name: "precall_begin", timestamp: at }, { name: "video_off", timestamp: at }];
    case "pending":
      return [];
    case "none":
      return null;
  }
}
type Session = { id: string; meetingId: string; status: "LIVE" | "ENDED"; startedAt: string; endedAt: string | null };

const RTK_NOT_FOUND = (message: string) => ({ success: false, error: { code: 404, message } });
const OUTAGE = { success: false, error: { code: 503, message: "fixture: realtimekit unavailable" } };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
}

const ok = (res: ServerResponse, data: unknown, extra: Record<string, unknown> = {}) =>
  send(res, 200, { success: true, data, ...extra });

export async function startRealtimeKitFixtureServer(port: number = REALTIMEKIT_FIXTURE_PORT): Promise<RealtimeKitFixtureServer> {
  const env = REALTIMEKIT_FIXTURE_ENV;
  const kitPath = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
  const calls: RealtimeKitFixtureCall[] = [];
  const meetings = new Map<string, Meeting>();
  const participants = new Map<string, FixtureParticipant>();
  const sessions = new Map<string, Session>();
  const rows: Row[] = [];
  const peerReports = new Map<string, string>();
  /** peer id → its row and its report's events (null: no report served). */
  const peerCameras = new Map<string, { rowId: string; events: PeerEvent[] | null }>();
  let down = false;
  let peerReportsDown = false;
  let seq = 0;
  const next = (p: string) => `${p}-${(++seq).toString(36).padStart(4, "0")}-${Date.now().toString(36)}`;
  const iso = () => new Date().toISOString();

  const liveSession = (meetingId: string) =>
    [...sessions.values()].find((s) => s.meetingId === meetingId && s.status === "LIVE") ?? null;
  const endIfEmpty = (s: Session) => {
    if (rows.some((r) => r.sessionId === s.id && r.leftAt === null)) return;
    s.status = "ENDED";
    s.endedAt = iso();
  };
  const livePeers = (r: Row) =>
    r.peerEvents
      .filter((e) => e.event_name === "PEER_JOINING")
      .filter((j) => !r.peerEvents.some((e) => e.event_name === "PEER_LEAVING" && e.peer_id === j.peer_id));
  const leave = (r: Row) => {
    if (r.leftAt !== null) return;
    r.leftAt = iso();
    for (const j of livePeers(r)) r.peerEvents.push({ ...j, event_name: "PEER_LEAVING", created_at: r.leftAt });
  };
  const currentPeerOf = (participantId: string): string | null => {
    const mine = rows.filter((r) => r.userId === participantId && r.leftAt === null && sessions.get(r.sessionId)?.status === "LIVE");
    const live = mine.flatMap(livePeers);
    return live.at(-1)?.peer_id ?? null;
  };
  const rowJson = (r: Row, withEvents: boolean) => ({
    id: r.id,
    session_id: r.sessionId,
    user_id: r.userId,
    custom_participant_id: r.subject,
    preset_name: r.preset,
    joined_at: r.joinedAt,
    left_at: r.leftAt,
    ...(withEvents ? { peer_events: r.peerEvents } : {}),
  });
  const sessionJson = (s: Session) => ({
    id: s.id,
    associated_id: s.meetingId,
    meeting_display_name: meetings.get(s.meetingId)?.title ?? null,
    type: "meeting",
    status: s.status,
    started_at: s.startedAt,
    ended_at: s.endedAt,
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://fixture");
      const query = Object.fromEntries(url.searchParams);
      const full = url.pathname;
      const inKit = full.startsWith(kitPath + "/") || full === kitPath;
      const path = inKit ? full.slice(kitPath.length) || "/" : full;
      const call: RealtimeKitFixtureCall = { method, path, route: "unhandled", query, body, at: Date.now() };
      calls.push(call);
      const route = (r: string) => {
        call.route = r;
      };

      if (down) return send(res, 503, OUTAGE);
      if (req.headers.authorization !== `Bearer ${env.REALTIMEKIT_API_TOKEN}`) {
        return send(res, 401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
      }
      // Cloudflare's gateway answers an account/app it cannot route with its
      // own v4 envelope — never RealtimeKit's not-found (isActiveSessionAbsent).
      if (!inKit) {
        return send(res, 404, {
          success: false,
          errors: [{ code: 7003, message: `Could not route to ${full}, perhaps your object identifier is invalid?` }],
          messages: [],
          result: null,
        });
      }
      const b = (body ?? {}) as Record<string, unknown>;
      let m: RegExpExecArray | null;

      if (path === "/meetings" && method === "POST") {
        route("POST /meetings");
        const mt: Meeting = { id: next("mtg"), title: String(b.title ?? ""), status: "ACTIVE", createdAt: iso() };
        meetings.set(mt.id, mt);
        return ok(res, { id: mt.id, title: mt.title, status: mt.status, created_at: mt.createdAt });
      }
      if ((m = /^\/meetings\/([^/]+)$/.exec(path)) && method === "PATCH") {
        route("PATCH /meetings/:id");
        const mt = meetings.get(m[1]!);
        if (!mt) return send(res, 404, RTK_NOT_FOUND("Meeting not found"));
        if (b.status !== "ACTIVE" && b.status !== "INACTIVE") {
          return send(res, 400, { success: false, error: { code: 400, message: "fixture: status must be ACTIVE or INACTIVE" } });
        }
        mt.status = b.status;
        return ok(res, { id: mt.id, title: mt.title, status: mt.status });
      }
      if ((m = /^\/meetings\/([^/]+)\/participants$/.exec(path)) && method === "POST") {
        route("POST /meetings/:id/participants");
        if (!meetings.has(m[1]!)) return send(res, 404, RTK_NOT_FOUND("Meeting not found"));
        if (typeof b.custom_participant_id !== "string" || typeof b.preset_name !== "string") {
          return send(res, 400, { success: false, error: { code: 400, message: "fixture: custom_participant_id and preset_name are required" } });
        }
        // ONLY these two fields are read. Anything else a caller sends — a
        // `live`, a `cameraOk`, a media block — is dropped here.
        const p: FixtureParticipant = { id: next("prt"), meetingId: m[1]!, subject: b.custom_participant_id, preset: b.preset_name, deleted: false };
        participants.set(p.id, p);
        return ok(res, { id: p.id, token: next("rtk-token"), custom_participant_id: p.subject, preset_name: p.preset, created_at: iso() });
      }
      if ((m = /^\/meetings\/([^/]+)\/participants\/([^/]+)\/token$/.exec(path)) && method === "POST") {
        route("POST /meetings/:id/participants/:pid/token");
        const p = participants.get(m[2]!);
        if (!p || p.deleted || p.meetingId !== m[1]) return send(res, 404, RTK_NOT_FOUND("Participant not found"));
        return ok(res, { token: next("rtk-token") });
      }
      if ((m = /^\/meetings\/([^/]+)\/participants\/([^/]+)$/.exec(path)) && method === "DELETE") {
        route("DELETE /meetings/:id/participants/:pid");
        const p = participants.get(m[2]!);
        if (!p || p.deleted || p.meetingId !== m[1]) return send(res, 404, RTK_NOT_FOUND("Participant not found"));
        p.deleted = true;
        for (const r of rows) if (r.userId === p.id) leave(r);
        for (const s of sessions.values()) if (s.meetingId === p.meetingId && s.status === "LIVE") endIfEmpty(s);
        return ok(res, { id: p.id, custom_participant_id: p.subject });
      }
      if ((m = /^\/meetings\/([^/]+)\/active-session$/.exec(path)) && method === "GET") {
        route("GET /meetings/:id/active-session");
        const s = liveSession(m[1]!);
        // Unmeasured body (owed live): RealtimeKit's documented error envelope.
        if (!s) return send(res, 404, RTK_NOT_FOUND("No active session found for this meeting"));
        return ok(res, sessionJson(s));
      }
      if ((m = /^\/meetings\/([^/]+)\/active-session\/(kick|kick-all)$/.exec(path)) && method === "POST") {
        route(`POST /meetings/:id/active-session/${m[2]}`);
        const s = liveSession(m[1]!);
        if (!s) return send(res, 404, RTK_NOT_FOUND("No active session found for this meeting"));
        const ids = m[2] === "kick" && Array.isArray(b.participant_ids) ? (b.participant_ids as unknown[]).map(String) : null;
        const kicked = rows.filter((r) => r.sessionId === s.id && r.leftAt === null && (ids === null || ids.includes(r.userId)));
        kicked.forEach(leave);
        endIfEmpty(s);
        return ok(res, { action: m[2], participants: kicked.map((r) => rowJson(r, false)) });
      }
      if ((m = /^\/sessions\/peer-report\/([^/]+)$/.exec(path)) && method === "GET") {
        route("GET /sessions/peer-report/:peer");
        if (peerReportsDown) return send(res, 503, OUTAGE);
        const recorded = peerReports.get(m[1]!);
        if (recorded !== undefined) {
          return res.writeHead(200, { "content-type": "application/json" }).end(`{"success":true,"data":${recorded}}`);
        }
        const cam = peerCameras.get(m[1]!);
        const row = cam ? rows.find((r) => r.id === cam.rowId) : undefined;
        // RealtimeKit's measured body for a peer it has no report for.
        if (!cam || cam.events === null || !row) return send(res, 404, RTK_NOT_FOUND(`No peer event exists for id ${m[1]!}`));
        return ok(res, {
          participant: {
            ...rowJson(row, false),
            peer_report: {
              metadata: { events: cam.events, sdk_name: "web-core", sdk_version: "2.0.2", room_view_type: "groupCall" },
              quality: { video_producer: [], video_producer_cumulative: {} },
            },
          },
        });
      }
      if ((m = /^\/sessions\/([^/]+)\/participants$/.exec(path)) && method === "GET") {
        route("GET /sessions/:id/participants");
        const s = sessions.get(m[1]!);
        if (!s) return send(res, 404, RTK_NOT_FOUND("Session not found"));
        const withEvents = query.include_peer_events === "true";
        const mine = rows.filter((r) => r.sessionId === s.id);
        const perPage = Math.min(Number(query.per_page ?? 25), 200);
        return ok(res, { participants: mine.slice(0, perPage).map((r) => rowJson(r, withEvents)) }, {
          paging: { total_count: mine.length, start_offset: 0, end_offset: Math.min(mine.length, perPage) },
        });
      }
      if (path === "/sessions" && method === "GET") {
        route("GET /sessions");
        const all = [...sessions.values()].filter((s) => !query.associated_id || s.meetingId === query.associated_id);
        const perPage = Math.min(Number(query.per_page ?? 25), 100);
        const page = all.slice(0, perPage);
        return ok(res, { sessions: page.map(sessionJson) }, {
          paging: { total_count: all.length, start_offset: 0, end_offset: page.length },
        });
      }

      // Not RealtimeKit's not-found (error.code 404): an unexpected call must
      // read as an answer we cannot use, never as "nothing there".
      return send(res, 404, { success: false, error: { code: "fixture_unhandled", message: `fixture: unhandled ${method} ${path}` } });
    })().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { success: false, error: { code: 500, message: `fixture: ${String(err)}` } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    kitPath,
    calls,
    setLivePublisher(participantId, live, opts = {}) {
      const p = participants.get(participantId);
      if (!p) throw new Error(`setLivePublisher: no participant ${participantId} — nobody minted it`);
      if (p.deleted) throw new Error(`setLivePublisher: participant ${participantId} was removed; its token can never re-join`);
      const mt = meetings.get(p.meetingId)!;
      if (live) {
        if (mt.status !== "ACTIVE") throw new Error(`setLivePublisher: meeting ${mt.id} is ${mt.status}; nobody can join it`);
        let s = liveSession(mt.id);
        if (!s) {
          s = { id: next("ses"), meetingId: mt.id, status: "LIVE", startedAt: iso(), endedAt: null };
          sessions.set(s.id, s);
        }
        const at = iso();
        // MEASURED (T17B): a reload is a new peer under the SAME row of the live session.
        let row = rows.find((r) => r.sessionId === s.id && r.userId === p.id);
        if (!row) {
          row = { id: next("sp"), sessionId: s.id, userId: p.id, subject: p.subject, preset: p.preset, joinedAt: at, leftAt: null, peerEvents: [] };
          rows.push(row);
        }
        row.leftAt = null;
        const peer = next("peer");
        row.peerEvents.push({ event_name: "PEER_JOINING", peer_id: peer, participant_id: row.id, created_at: at });
        peerCameras.set(peer, { rowId: row.id, events: joinEvents(opts.camera ?? "on", at) });
        return;
      }
      const s = liveSession(mt.id);
      if (!s) return;
      for (const r of rows) if (r.sessionId === s.id && r.userId === p.id) leave(r);
      endIfEmpty(s);
    },
    setPeerCamera(participantId, event) {
      const peer = currentPeerOf(participantId);
      const cam = peer === null ? undefined : peerCameras.get(peer);
      if (!cam) throw new Error(`setPeerCamera: participant ${participantId} has no connected peer`);
      cam.events = [...(cam.events ?? []), { name: event, timestamp: iso() }];
    },
    currentPeer(participantId) {
      return currentPeerOf(participantId);
    },
    setUnavailable(d) {
      down = d;
    },
    setPeerReportsUnavailable(d) {
      peerReportsDown = d;
    },
    servePeerReport(peerId, data) {
      peerReports.set(peerId, JSON.stringify(data));
    },
    participant(id) {
      const p = participants.get(id);
      return p ? { ...p } : null;
    },
    participantFor(subject) {
      const all = [...participants.values()].filter((p) => p.subject === subject);
      const last = all.at(-1);
      return last ? { ...last } : null;
    },
    liveParticipantIds() {
      const live = new Set<string>();
      for (const r of rows) {
        const s = sessions.get(r.sessionId);
        if (s?.status === "LIVE" && r.leftAt === null) live.add(r.userId);
      }
      return [...live];
    },
    sessions(meetingId) {
      return [...sessions.values()].filter((s) => s.meetingId === meetingId).map((s) => ({ id: s.id, meetingId: s.meetingId, status: s.status }));
    },
    meetingStatus(meetingId) {
      return meetings.get(meetingId)?.status ?? null;
    },
    reset() {
      calls.length = 0;
      meetings.clear();
      participants.clear();
      sessions.clear();
      rows.length = 0;
      peerReports.clear();
      peerCameras.clear();
      down = false;
      peerReportsDown = false;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
