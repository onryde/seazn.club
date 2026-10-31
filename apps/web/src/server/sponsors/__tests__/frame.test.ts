// R4 sponsors on stream, S9 — the frame endpoint (spec 2026-10-27 §3.6.3; plan P4; Review Focus 3; the SC2 addenda of
// 2026-10-31). The compositor (SC2) grabs one programme frame 1.5 s after a sponsor `start` line and POSTs it, raw
// `image/jpeg`, to `/api/internal/relay/sessions/[sid]/airings/[momentId]/frame` with the relay JOB token as Bearer. Web
// stores the bytes in the PRIVATE `sponsor-frames` bucket and keeps one `sponsor_airing_frames` row per (session, moment).
//
// THE SEAM, driven for real (AGENTS.md class 1): the moment id is S5's own (`sponsorMomentId` through the planner and the
// page's `sponsorQueueLines`) or S7's (`carouselLines`); the URL is the one SC2's uploader builds — its percent-encoding
// is copied below from the compositor's `path_segment`; Next's OWN route matcher (`getRouteMatcher(getRouteRegex(…))`,
// the function a deployed server runs) turns that URL into the route's params; the REAL route handler answers; the
// airing row lands through the REAL `heartbeat` usecase; and the report's join is read back. Storage is the one fake:
// `supabaseAdmin` is replaced by an in-memory bucket store, so the real helpers in lib/supabase-storage.ts run.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   frame before its airing row; the row lands; the join finds it .......... "the seam (cricket)", "the seam (generic)"
//   a second frame for the same moment (replace, one row) .................. "sequence"
//   a frame for another moment of the same session ......................... "sequence"
//   a frame after the session ended (410) ................................... "sequence"
//   the empty body (415), the empty purge (no storage call) ................. "SOI only", "orphans"
//   a bad / foreign / expired / page token (401) ............................ "the 401 gate"
//   the size bound, both edges (413) ........................................ "the bound is inclusive"
//   the id grammar (400), the colon id, the `%` id ......................... "the grammar", "decoded exactly once"
//   the storage key can never gain a segment ................................. "the storage key"
//   a storage failure (502) then the retry ................................... "storage failure"
//   a superseded attempt's Machine (410), the current one's frame kept ........ "a superseded attempt"
//   a client abort mid-body (400) ............................................ "a client abort"
//   the row write failing after the object was stored (tombstoned) ........... "tombstones"
//   orphans purged past session end + 24 h, in capped batches ................ "orphans"
//   a session deleted: its objects removed on the next pass .................. "tombstones"
// TWO SPORTS where a sport changes the id: cricket (a break card: `<seq>:sponsor.over_end`) and generic (no natural
// breaks, so its sponsors air on the scene carousel: `scene:<scene>:<bucket>`). Everything else is single-sport on
// purpose: the endpoint reads no sport, only the id the page minted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/** The in-memory storage `supabaseAdmin()` hands the real helpers: objects keyed `<bucket>\n<path>`, every call kept in
 *  order. An overwrite without `upsert: true` is refused, as Supabase refuses it. `fail` makes the next N calls fail. */
const store = vi.hoisted(() => {
  const objects = new Map<string, Uint8Array>();
  const calls: { op: "upload" | "remove" | "sign"; bucket: string; paths: string[]; upsert?: boolean; contentType?: string }[] = [];
  const fail = { upload: 0, remove: 0 };
  /** Runs after an upload has stored its object — a thing that happens WHILE a frame is in flight. */
  const hooks = { afterUpload: null as null | (() => Promise<void>) };
  return { objects, calls, fail, hooks };
});
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => ({
        async upload(path: string, bytes: Uint8Array, o: { contentType: string; upsert?: boolean }) {
          store.calls.push({ op: "upload", bucket, paths: [path], upsert: o.upsert, contentType: o.contentType });
          if (store.fail.upload > 0) { store.fail.upload--; return { data: null, error: { message: "storage is down" } }; }
          const key = `${bucket}\n${path}`;
          if (store.objects.has(key) && o.upsert !== true) return { data: null, error: { message: "The resource already exists" } };
          store.objects.set(key, new Uint8Array(bytes));
          if (store.hooks.afterUpload) await store.hooks.afterUpload();
          return { data: { path }, error: null };
        },
        async remove(paths: string[]) {
          store.calls.push({ op: "remove", bucket, paths: [...paths] });
          if (store.fail.remove > 0) { store.fail.remove--; return { data: null, error: { message: "storage is down" } }; }
          for (const p of paths) store.objects.delete(`${bucket}\n${p}`);
          return { data: paths.map((name) => ({ name })), error: null };
        },
        async createSignedUrl(path: string, ttl: number) {
          store.calls.push({ op: "sign", bucket, paths: [path] });
          return { data: { signedUrl: `https://storage.test/object/sign/${bucket}/${path}?ttl=${ttl}` }, error: null };
        },
      }),
    },
  }),
}));

vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn() };
});
// The route's `handler` reports every 5xx through Sentry itself: kept, so "reported ONCE" (review m3) can be counted.
vi.mock("@sentry/nextjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/nextjs")>();
  return { ...actual, captureException: vi.fn() };
});

import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { builtinModules } from "@seazn/engine/sports";
import { sql, statementCount } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import * as Sentry from "@sentry/nextjs";
import { SPONSOR_FRAMES_BUCKET } from "@/lib/supabase-storage";
import { RelayAiring, RelayHeartbeat } from "@/server/api-v1/schemas";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START, sponsorQueueLines } from "@/lib/overlay-compositor";
import { sponsorMoments } from "@/lib/overlay-moments";
import { planSponsors, sponsorMomentId, type BreakOpened, type SponsorCard } from "@/lib/sponsor-plan";
import { CAROUSEL_INITIAL, carouselLines, carouselMomentId, carouselStep } from "@/components/overlay/sponsor-card";
import { OVERLAY_SCENES, SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { pairPresentPhone, streamRig } from "@/server/relay/__tests__/_session-rig";
import { mintRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { POST as frameRoute } from "@/app/api/internal/relay/sessions/[sid]/airings/[momentId]/frame/route";
import { POST as beatRoute } from "@/app/api/internal/relay/sessions/[sid]/heartbeat/route";
import { captureRig } from "@/server/usecases/__tests__/_capture-rig";
import { createSession, heartbeat } from "@/server/usecases/stream-sessions";
import {
  AIRING_FRAME_MAX_BYTES, FRAME_MOMENT_LOG_CHARS, ORPHAN_FRAME_GRACE_MS, ORPHAN_PURGE_BATCH, ORPHAN_PURGE_MAX_BATCHES, airingFramePath, isFrameMomentId,
  purgeOrphanFrames, storeAiringFrame,
} from "../airings";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "sponsor-frames-test-secret";
  // A composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset; the fake runner needs no real image.
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:sponsor-frames-test";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => setRelayDriversForTest(null));
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const SEC = 1000;
const NEVER = 3_600_000;
/** S1/S2 (engine 1.1.0): cricket's over end, as the engine declares it. */
const OVER_END = { kind: "over_end", size: "minor" } as const;
/** Review Focus 5's realistic sponsor name: 43 characters. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
/** The spec's bound (§3.6.3, "≤ 256 KiB"; SC2 `FRAME_UPLOAD_MAX_BYTES = 256 * 1024`). */
const SPEC_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// The wire, as SC2 and Next make it.
// ---------------------------------------------------------------------------------------------------------------
/** SC2's encoding of a moment id into ONE path segment, copied from the compositor's `control_http::path_segment`
 *  (seazn.club.compositor, crates/adapters/src/control_http.rs:607, commit ab5e5ee): every BYTE of the UTF-8 text but
 *  RFC 3986's unreserved `A-Z a-z 0-9 - . _ ~` becomes `%XX`, upper-case hex. */
function pathSegment(text: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(text)) {
    const unreserved = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
    out += unreserved ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
/** SC2's `HttpFrameUpload::frame_url`: `{APP_URL}/api/internal/relay/sessions/{sid}/airings/{path_segment(id)}/frame`. */
const sc2FrameUrl = (sid: string, momentId: string) => `http://app.test/api/internal/relay/sessions/${sid}/airings/${pathSegment(momentId)}/frame`;

/** The route's pattern, as its file sits under app/ — the file's existence is asserted below, so the two cannot drift. */
const FRAME_ROUTE = "/api/internal/relay/sessions/[sid]/airings/[momentId]/frame";
const FRAME_ROUTE_FILE = resolve(__dirname, `../../../app${FRAME_ROUTE}/route.ts`);
/** Next's own matcher for that pattern: what a deployed server hands the handler as `params` (it decodes each segment
 *  ONCE, with decodeURIComponent — next/dist/shared/lib/router/utils/route-matcher.js). */
const matchFrameRoute = getRouteMatcher(getRouteRegex(FRAME_ROUTE));

type PostOpts = { token?: string; authorization?: string; body?: Uint8Array | ReadableStream<Uint8Array> | null; contentLength?: number };
/** One POST as SC2 sends it (ureq `send_bytes`: a Content-Length, `Content-Type: image/jpeg`), through Next's matcher. */
async function postFrame(url: string, o: PostOpts): Promise<Response> {
  const params = matchFrameRoute(new URL(url).pathname);
  if (!params) throw new Error(`premise: Next does not route ${new URL(url).pathname} to the frame route`);
  const headers: Record<string, string> = { "content-type": "image/jpeg" };
  if (o.authorization !== undefined) headers.authorization = o.authorization;
  else if (o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
  const length = o.contentLength ?? (o.body instanceof Uint8Array ? o.body.byteLength : undefined);
  if (length !== undefined) headers["content-length"] = String(length);
  const init = { method: "POST", headers, body: o.body ?? null, duplex: "half" } as RequestInit;
  return frameRoute(new Request(url, init), { params: Promise.resolve(params as { sid: string; momentId: string }) });
}
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** A JPEG as jpegenc writes one: SOI, a JFIF APP0, filler, EOI — `n` bytes in all (n ≥ 22). */
function jpegOf(n: number, fill = 0x5a): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  if (n < head.length + 2) throw new Error(`jpegOf: ${n} bytes is too short for a JFIF`);
  const out = new Uint8Array(n).fill(fill);
  out.set(head, 0);
  out.set([0xff, 0xd9], n - 2);
  return out;
}

/** A body that counts what is pulled from it: `chunks` chunks of `chunk` bytes, the first one opening with a JPEG SOI.
 *  highWaterMark 0, so nothing is pulled until a reader asks. */
function countingStream(chunks: number, chunk = 64 * 1024) {
  const seen = { pulled: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i === chunks) { c.close(); return; }
      const part = i === 0 ? jpegOf(chunk) : new Uint8Array(chunk);
      i++;
      seen.pulled += part.byteLength;
      c.enqueue(part);
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

// ---------------------------------------------------------------------------------------------------------------
// Rigs and reads.
// ---------------------------------------------------------------------------------------------------------------
function itemOf(line: string): RelayAiring {
  const space = line.indexOf(" ");
  const signal = line.slice(0, space);
  if (signal !== SIGNAL_SPONSOR_START && signal !== SIGNAL_SPONSOR_END) throw new Error(`not a sponsor line: ${line}`);
  return RelayAiring.parse({ kind: signal === SIGNAL_SPONSOR_START ? "start" : "end", ...(JSON.parse(line.slice(space + 1)) as object) });
}
async function sponsorRow(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, on_stream) values (${orgId}, ${name}, true) returning id`;
  return row!.id;
}
const cardOf = (sponsorId: string, name: string): SponsorCard => ({ id: sponsorId, sponsorId, name, logoUrl: null, tier: "partner", onStream: true });

/** A COMPOSED session (the only mode that composes a page, D10) started through the real organiser path; its job token
 *  is the one the fake runner handed the Machine. */
async function composedRig(sport: "cricket" | "generic") {
  const r = await captureRig({ credits: 1, connectAfterMs: NEVER, sport });
  await pairPresentPhone(r.fixtureId, { phone: `phone-a-${randomUUID()}`, at: r.now() });
  const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
  const jobToken = r.runner.created[0]!.jobToken;
  return {
    r, S: sessionId, jobToken,
    beat: (body: Record<string, unknown>) => heartbeat(sessionId, jobToken, RelayHeartbeat.parse(body), r.deps),
    sponsor: (name: string) => sponsorRow(r.auth.orgId, name),
  };
}

/** The planner's assignment for one break (Busy), persisted the way S5 does, and the start line the page logs for it. */
async function assignedStart(c: Awaited<ReturnType<typeof composedRig>>, sponsorId: string, brk: BreakOpened): Promise<RelayAiring> {
  const { plan, newAssignments } = planSponsors({
    breaks: [brk], windowSeqs: [brk.seq], settings: { enabled: true, frequency: "busy" }, cards: [cardOf(sponsorId, LONG_NAME)],
    assignedCards: [], assigned: [], operatorLog: [], nextPosition: 0, now: c.r.now().getTime(), complete: true,
  });
  expect(newAssignments, "premise: the planner assigned the break").toHaveLength(1);
  const a = newAssignments[0]!;
  await sql`
    insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms, operator_choice_at)
    values (${c.r.fixtureId}, ${a.momentId}, ${c.r.auth.orgId}, ${a.seq}, ${a.sponsorId}, ${a.sponsorName}, ${a.position}, ${a.source}, ${a.breakKind},
            ${a.style}, ${a.holdMs}, ${a.operatorChoiceAt})`;
  const [moment] = sponsorMoments(plan);
  const on = sponsorQueueLines(null, { current: moment!, phase: "hold", cutShort: [] }, c.r.now().toISOString());
  expect(on.lines, "premise: the page logs one start").toHaveLength(1);
  return itemOf(on.lines[0]!);
}

/** A live session row with no Machine (streamRig's), and a relay JOB token minted for it by the real minter. */
async function plainSession(state = "live") {
  const rig = await streamRig();
  const fixtureId = rig.fixtureIds[0]!;
  const sessionId = await rig.session(fixtureId, state);
  const token = await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 3_600_000), attempt: 1 });
  return { orgId: rig.orgId, fixtureId, sessionId, token, rig };
}

type FrameRow = { session_id: string; moment_id: string; org_id: string; path: string; created_at: Date };
const framesOf = (sessionId: string) => sql<FrameRow[]>`
  select session_id, moment_id, org_id, path, created_at from sponsor_airing_frames where session_id = ${sessionId} order by moment_id`;
const airingsOf = (sessionId: string) => sql<{ moment_id: string }[]>`select moment_id from sponsor_airings where session_id = ${sessionId}`;
/** The join S14's report owes (P4: "the report left-joins it"): driven from the AIRINGS, so a frame with no airing row
 *  never appears, and an airing with no frame reads a null path. */
const reportJoin = (sessionId: string) => sql<{ moment_id: string; frame_path: string | null }[]>`
  select a.moment_id, f.path as frame_path
    from sponsor_airings a
    left join sponsor_airing_frames f on f.session_id = a.session_id and f.moment_id = a.moment_id
   where a.session_id = ${sessionId}
   order by a.started_at, a.moment_id`;
const storedAt = (path: string) => store.objects.get(`${SPONSOR_FRAMES_BUCKET}\n${path}`);
/** The tombstones (V483) among `paths`. */
const tombstonesOf = async (paths: string[]) =>
  (await sql<{ path: string }[]>`select path from sponsor_frame_tombstones where path in ${sql(paths)} order by path`).map((r) => r.path);

// ---------------------------------------------------------------------------------------------------------------
// Pure: the grammar and the storage key.
// ---------------------------------------------------------------------------------------------------------------
/** Every kind the engine declares (`naturalBreaks.kinds`), never a typed list. */
const DECLARED_KINDS = [...new Set(builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => k.kind)))];
/** The heartbeat's own bound on a moment id, read off the contract twin (RelayAiring's start item). */
const WIRE_MOMENT_ID = RelayAiring.options.find((o) => o.shape.kind.value === "start")!.shape.momentId;

describe("S9: the frame's moment id and storage key (pure)", () => {
  it("the route file sits where the pattern says (so Next's matcher below matches the real route), and AIRING_FRAME_MAX_BYTES is the spec's 256 KiB", () => {
    expect(existsSync(FRAME_ROUTE_FILE), FRAME_ROUTE_FILE).toBe(true);
    expect(AIRING_FRAME_MAX_BYTES).toBe(SPEC_MAX_BYTES);
  });

  it("the grammar accepts every id the producers mint: S5's break id for every engine-declared kind, and S7's carousel id for every carousel scene — and the wire's own bound holds for each", () => {
    let checked = 0;
    for (const kind of DECLARED_KINDS) {
      for (const seq of [0, 1, 12, 2 ** 31 - 1]) {
        const id = sponsorMomentId(seq, kind);
        expect(isFrameMomentId(id), id).toBe(true);
        expect(WIRE_MOMENT_ID.safeParse(id).success, `premise: the beat can carry ${id}`).toBe(true);
        checked++;
      }
    }
    for (const scene of SPONSOR_CAROUSEL_SCENES) {
      for (const at of [0, 9_999, Date.parse("2026-10-31T14:00:00Z"), 2 ** 45]) {
        const id = carouselMomentId(scene, at);
        expect(isFrameMomentId(id), id).toBe(true);
        checked++;
      }
    }
    expect(DECLARED_KINDS.length, "premise: the engine declares break kinds").toBeGreaterThan(0);
    expect(SPONSOR_CAROUSEL_SCENES.length, "premise: the carousel airs in some scene").toBeGreaterThan(0);
    expect(checked).toBe(DECLARED_KINDS.length * 4 + SPONSOR_CAROUSEL_SCENES.length * 4);
  });

  it("the grammar refuses everything else — a path, a dot-segment, an undeclared kind, a padded seq, a scene the carousel never airs in, a malformed bucket, and one unit past the wire's bound (the bound itself is accepted)", () => {
    const kind = DECLARED_KINDS[0]!;
    const sceneless = OVERLAY_SCENES.map((s) => s.id).filter((id) => !SPONSOR_CAROUSEL_SCENES.includes(id));
    expect(sceneless.length, "premise: some declared scene carries no carousel").toBeGreaterThan(0);
    const scene = SPONSOR_CAROUSEL_SCENES[0]!;
    // The widest id the wire carries, of a valid shape: a seq of as many digits as fit.
    const prefix = `:sponsor.${kind}`;
    const widest = `${"9".repeat(80 - prefix.length)}${prefix}`;
    expect(widest).toHaveLength(80);
    expect(WIRE_MOMENT_ID.safeParse(widest).success, "premise: 80 units is the wire's bound").toBe(true);
    expect(WIRE_MOMENT_ID.safeParse(`9${widest}`).success, "premise: 81 is past it").toBe(false);
    expect(isFrameMomentId(widest), "the bound itself").toBe(true);
    const refused = [
      "", "a/b", "../../x", "/", ".", "..", "%2F", "12", "12:", "12:sponsor.", `12:sponsor.${kind}/../x`, `12:sponsor.${kind}/`,
      "12:sponsor.no_such_kind", `12:sponsor.${kind.replace("_", "%5F")}`, `012:sponsor.${kind}`, `-1:sponsor.${kind}`, `1.5:sponsor.${kind}`,
      ` 12:sponsor.${kind}`, `12:sponsor.${kind} `, `12:sponsor.${kind}\n`, `12:Sponsor.${kind}`, `12:sponsor.${kind.toUpperCase()}`,
      ...sceneless.map((s) => `scene:${s}:1`), `scene:${scene}:01`, `scene:${scene}:-1`, `scene:${scene}:`, `scene:${scene}:1:2`, `scene:${scene}:1/x`,
      `scene::1`, `scene:${scene}`, `Scene:${scene}:1`, `scene:${scene}:1.0`, `9${widest}`,
    ];
    let checked = 0;
    for (const id of refused) {
      expect(isFrameMomentId(id), JSON.stringify(id)).toBe(false);
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(checked).toBeGreaterThan(30);
  });

  it("the storage key: `<orgId>/<sessionId>/<base64url(id)>.jpg` — three segments whatever the id holds (a slash, a dot-segment, a NUL, an escape, a non-ASCII run), each id read back from its key, no two ids one key", () => {
    const orgId = randomUUID();
    const sessionId = randomUUID();
    const hostile = ["a/b", "../../x", "..", ".", "/", "%2F", "a\u0000b", "\\..\\x", "12:sponsor.over_end", "scene:starting:1", "ü/ß", "🎾/..", "x".repeat(80)];
    const keys = new Set<string>();
    let checked = 0;
    for (const id of hostile) {
      const key = airingFramePath(orgId, sessionId, id);
      const segments = key.split("/");
      expect(segments, `${JSON.stringify(id)} → ${key}`).toHaveLength(3);
      expect(segments.slice(0, 2)).toEqual([orgId, sessionId]);
      expect(segments[2], key).toMatch(/^[A-Za-z0-9_-]+\.jpg$/);
      expect(Buffer.from(segments[2]!.slice(0, -".jpg".length), "base64url").toString("utf8"), "the id reads back").toBe(id);
      keys.add(key);
      checked++;
    }
    expect(checked).toBe(hostile.length);
    expect(keys.size, "no two ids share a key").toBe(hostile.length);
    // An id the encoding cannot carry back (a lone surrogate encodes as U+FFFD, the same bytes as U+FFFD itself) and the
    // empty id are refused by name, never stored under a key another id also maps to.
    expect(() => airingFramePath(orgId, sessionId, "\uD800")).toThrow(RangeError);
    expect(() => airingFramePath(orgId, sessionId, "")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DB: the endpoint.
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("S9: POST …/airings/[momentId]/frame", () => {
  it("the seam (cricket, Review Focus 3): SC2's URL for S5's minted over-end id → Next's own decode → the REAL route → 204; the frame is stored BEFORE its airing row exists; the start on the next beat lands the row, and the report's join finds the frame", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor(LONG_NAME);
    const start = await assignedStart(c, sponsorId, { seq: 12, ...OVER_END, at: c.r.now().toISOString() });
    expect(start.momentId, "premise: S5's id, with the colon SC2 must encode").toBe(sponsorMomentId(12, OVER_END.kind));
    const url = sc2FrameUrl(c.S, start.momentId);
    expect(url, "SC2 percent-encodes the colon").toContain("/airings/12%3Asponsor.over_end/frame");
    // 1.5 s after the start line, SC2 posts the grab.
    c.r.tick(1.5 * SEC);
    const jpeg = jpegOf(48_213);
    const res = await postFrame(url, { token: c.jobToken, body: jpeg });
    expect(res.status).toBe(204);
    expect(await res.text(), "a 204 carries no body").toBe("");
    const frames = await framesOf(c.S);
    expect(frames).toHaveLength(1);
    expect(frames[0], "the id is stored verbatim — the airing's own").toMatchObject({ session_id: c.S, moment_id: start.momentId, org_id: c.r.auth.orgId });
    expect(storedAt(frames[0]!.path), "the posted bytes, in the private bucket").toEqual(jpeg);
    expect(frames[0]!.path.startsWith(`${c.r.auth.orgId}/${c.S}/`), frames[0]!.path).toBe(true);
    expect(await airingsOf(c.S), "Review Focus 3: no airing row yet").toEqual([]);
    expect(await reportJoin(c.S), "the join is driven from the airings: nothing to show yet").toEqual([]);
    // The start rides the next 5 s beat, after the frame.
    c.r.tick(3.5 * SEC);
    expect(await c.beat({ state: "playing", airings: [start] })).toMatchObject({ desiredState: "live" });
    expect(await reportJoin(c.S)).toEqual([{ moment_id: start.momentId, frame_path: frames[0]!.path }]);
  });

  it("the seam (generic — a scene showing): S7's carousel id `scene:<scene>:<bucket>` (two colons) through SC2's URL and the REAL route → 204, stored verbatim; its start lands and the join finds it", async () => {
    const c = await composedRig("generic");
    const sponsorId = await c.sponsor("Riverside Physio");
    const t0 = c.r.now().getTime();
    const showing = carouselStep(CAROUSEL_INITIAL, { now: t0, order: [sponsorId], yielding: false, scene: SPONSOR_CAROUSEL_SCENES[0]! });
    const on = carouselLines(null, showing, new Date(t0).toISOString());
    expect(on.lines, "premise: the carousel logs one start").toHaveLength(1);
    const start = itemOf(on.lines[0]!);
    expect(start.momentId.split(":"), "premise: a scene id has two colons").toHaveLength(3);
    c.r.tick(1.5 * SEC);
    const jpeg = jpegOf(30_000, 0x11);
    expect((await postFrame(sc2FrameUrl(c.S, start.momentId), { token: c.jobToken, body: jpeg })).status).toBe(204);
    const frames = await framesOf(c.S);
    expect(frames.map((f) => f.moment_id)).toEqual([start.momentId]);
    expect(storedAt(frames[0]!.path)).toEqual(jpeg);
    c.r.tick(3.5 * SEC);
    await c.beat({ state: "playing", airings: [start] });
    expect(await reportJoin(c.S)).toEqual([{ moment_id: start.momentId, frame_path: frames[0]!.path }]);
  });

  it("sequence: a second frame for the same moment replaces the object and keeps ONE row; another moment is its own row; once the final beat ends the session a frame is 410 SESSION_ENDED, asks storage nothing, and leaves both rows", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor(LONG_NAME);
    const start = await assignedStart(c, sponsorId, { seq: 7, ...OVER_END, at: c.r.now().toISOString() });
    const first = jpegOf(10_000, 0x01);
    const second = jpegOf(12_000, 0x02);
    expect((await postFrame(sc2FrameUrl(c.S, start.momentId), { token: c.jobToken, body: first })).status).toBe(204);
    expect((await postFrame(sc2FrameUrl(c.S, start.momentId), { token: c.jobToken, body: second })).status).toBe(204);
    const once = await framesOf(c.S);
    expect(once, "one row per (session, moment)").toHaveLength(1);
    expect(storedAt(once[0]!.path), "the second frame replaced the first").toEqual(second);
    const uploads = store.calls.filter((x) => x.op === "upload" && x.paths[0] === once[0]!.path);
    expect(uploads.map((u) => [u.bucket, u.upsert, u.contentType])).toEqual([
      [SPONSOR_FRAMES_BUCKET, true, "image/jpeg"], [SPONSOR_FRAMES_BUCKET, true, "image/jpeg"],
    ]);
    expect(await tombstonesOf([once[0]!.path]), "a replace under the SAME key tombstones nothing: the row still names it").toEqual([]);
    // Another moment of the same session.
    const other = sponsorMomentId(9, OVER_END.kind);
    expect((await postFrame(sc2FrameUrl(c.S, other), { token: c.jobToken, body: first })).status).toBe(204);
    expect((await framesOf(c.S)).map((f) => f.moment_id).sort()).toEqual([start.momentId, other].sort());
    // The session ends on its final beat.
    await c.beat({ state: "stopped", exitReason: "ended" });
    const [s] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${c.S}`;
    expect(s!.state, "premise: the final beat ended the session").toBe("completed");
    const calls = store.calls.length;
    const late = await postFrame(sc2FrameUrl(c.S, sponsorMomentId(11, OVER_END.kind)), { token: c.jobToken, body: first });
    expect(late.status).toBe(410);
    expect(await json(late)).toMatchObject({ ok: false, code: "SESSION_ENDED" });
    expect(store.calls.length, "a 410 asks storage nothing").toBe(calls);
    expect((await framesOf(c.S)).map((f) => f.moment_id).sort(), "the rows stand").toEqual([start.momentId, other].sort());
  });

  it("replace overwrites the row's PATH: a row left under an older key moves to this frame's key, with this frame's bytes there — and the key it left is tombstoned (V483, review m8), so the next pass removes that object and never this one", async () => {
    const p = await plainSession();
    const id = sponsorMomentId(3, OVER_END.kind);
    const legacy = `${p.orgId}/legacy-older-key.jpg`;
    await sql`insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${p.sessionId}, ${id}, ${p.orgId}, ${legacy})`;
    store.objects.set(`${SPONSOR_FRAMES_BUCKET}\n${legacy}`, jpegOf(100));
    const jpeg = jpegOf(5_000);
    expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpeg })).status).toBe(204);
    const rows = await framesOf(p.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path, "the path moved").not.toBe(legacy);
    expect(storedAt(rows[0]!.path), "and names this frame").toEqual(jpeg);
    expect(await tombstonesOf([legacy, rows[0]!.path]), "the left key, and only it").toEqual([legacy]);
    expect(await purgeOrphanFrames(new Date(), { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 1, failed: 0 });
    expect(storedAt(legacy), "the left key's object is removed").toBeUndefined();
    expect(storedAt(rows[0]!.path), "the row's own object stays").toEqual(jpeg);
    expect(await tombstonesOf([legacy]), "and its tombstone with it").toEqual([]);
  });

  it("the 401 gate: every refused credential is the heartbeat's own 401 (one body, byte for byte), stores nothing and asks storage nothing — an oversized body included; the job token beside them is 204", async () => {
    const s = await plainSession();
    const other = await plainSession();   // a REAL other session's job token: the foreign-session case is a genuine credential
    const [h, payload, sig] = s.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sid: other.sessionId })).toString("base64url");
    const mid = Math.floor(sig!.length / 2);
    const cases: [string, { token?: string; authorization?: string }][] = [
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { authorization: `Basic ${s.token}` }],
      ["an empty Bearer", { authorization: "Bearer " }],
      ["a signature altered mid-string", { token: `${h}.${payload}.${sig!.slice(0, mid)}${sig![mid] === "A" ? "B" : "A"}${sig!.slice(mid + 1)}` }],
      ["claims swapped under the original signature", { token: `${h}.${forged}.${sig}` }],
      ["an expired job token", { token: await mintRelayToken({ sid: s.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() - 1000), attempt: 1 }) }],
      ["another session's job token", { token: other.token }],
      ["this session's PAGE token", { token: await mintRelayToken({ sid: s.sessionId, scope: "relay-page", expiresAt: new Date(Date.now() + 60_000) }) }],
    ];
    const id = sponsorMomentId(5, OVER_END.kind);
    const bodies = new Set<string>();
    const calls = store.calls.length;
    let checked = 0;
    for (const [label, auth] of cases) {
      for (const [shape, body] of [["a good JPEG", { body: jpegOf(2_000) }], ["one declared past the bound", { body: countingStream(5).stream, contentLength: AIRING_FRAME_MAX_BYTES + 1 }]] as const) {
        const res = await postFrame(sc2FrameUrl(s.sessionId, id), { ...auth, ...body });
        expect(res.status, `${label}, ${shape}`).toBe(401);
        const b = await json(res);
        expect(b, label).toMatchObject({ ok: false, code: "RELAY_TOKEN_INVALID" });
        bodies.add(JSON.stringify(b));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every case, both bodies").toBe(cases.length * 2);
    // The heartbeat's own refusal, for the byte comparison.
    const beat401 = await beatRoute(new Request(`http://app.test/api/internal/relay/sessions/${s.sessionId}/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "playing" }),
    }), { params: Promise.resolve({ sid: s.sessionId }) });
    expect(beat401.status).toBe(401);
    bodies.add(JSON.stringify(await json(beat401)));
    expect([...bodies], "ONE refusal across both routes").toHaveLength(1);
    expect(store.calls.length, "nothing reached storage").toBe(calls);
    expect(await framesOf(s.sessionId)).toEqual([]);
    // The positive pair: this session's job token (any case of the scheme) is admitted.
    expect((await postFrame(sc2FrameUrl(s.sessionId, id), { authorization: `bearer ${s.token}`, body: jpegOf(2_000) })).status).toBe(204);
    expect((await framesOf(s.sessionId)).map((f) => f.moment_id)).toEqual([id]);
  });

  it("the bound is inclusive: exactly AIRING_FRAME_MAX_BYTES is 204; one byte more is 413 FRAME_TOO_LARGE — declared (never read at all) or streamed with no length (read no further than one chunk past the bound); the usecase holds the bound on its own", async () => {
    const p = await plainSession();
    const id = (seq: number) => sponsorMomentId(seq, OVER_END.kind);
    const exact = jpegOf(AIRING_FRAME_MAX_BYTES);
    expect((await postFrame(sc2FrameUrl(p.sessionId, id(1)), { token: p.token, body: exact })).status).toBe(204);
    const [row] = await framesOf(p.sessionId);
    expect(storedAt(row!.path)?.byteLength, "the whole frame, at the bound").toBe(AIRING_FRAME_MAX_BYTES);
    const calls = store.calls.length;
    // Declared one past the bound: refused from the header, the body untouched.
    const declared = countingStream(5);
    const a = await postFrame(sc2FrameUrl(p.sessionId, id(2)), { token: p.token, body: declared.stream, contentLength: AIRING_FRAME_MAX_BYTES + 1 });
    expect(a.status).toBe(413);
    expect(await json(a)).toMatchObject({ ok: false, code: "FRAME_TOO_LARGE" });
    expect(declared.seen.pulled, "a declared overrun is never read").toBe(0);
    // One byte past, with no length: a chunked body exactly one byte over.
    const CHUNK = 64 * 1024;
    const over = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(jpegOf(AIRING_FRAME_MAX_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); },
    });
    const b = await postFrame(sc2FrameUrl(p.sessionId, id(3)), { token: p.token, body: over });
    expect(b.status).toBe(413);
    // A 4 MiB stream with no length: the read stops one chunk past the bound.
    const big = countingStream(64, CHUNK);
    const c2 = await postFrame(sc2FrameUrl(p.sessionId, id(4)), { token: p.token, body: big.stream });
    expect(c2.status).toBe(413);
    expect(big.seen.pulled, "read with a limit").toBeLessThanOrEqual(AIRING_FRAME_MAX_BYTES + CHUNK);
    expect(big.seen.pulled, "premise: the stream had far more to give").toBeLessThan(64 * CHUNK);
    expect(store.calls.length, "no refused frame reached storage").toBe(calls);
    // The usecase alone: a caller that hands it one byte too many, or the route's past-the-bound null.
    await expect(storeAiringFrame(p.sessionId, p.token, id(5), jpegOf(AIRING_FRAME_MAX_BYTES + 1))).rejects.toMatchObject({ status: 413, code: "FRAME_TOO_LARGE" });
    await expect(storeAiringFrame(p.sessionId, p.token, id(6), null)).rejects.toMatchObject({ status: 413, code: "FRAME_TOO_LARGE" });
    await expect(storeAiringFrame(p.sessionId, p.token, id(7), jpegOf(AIRING_FRAME_MAX_BYTES))).resolves.toBeUndefined();
    expect((await framesOf(p.sessionId)).map((f) => f.moment_id).sort()).toEqual([id(1), id(7)].sort());
  });

  it("SOI only: FF D8 FF is a JPEG here, and nothing more is asked — three bytes alone are 204 (no minimum, no APP or EXIF rule); an empty body, FF D8, FF D8 00, a PNG and a leading 00 are 415 FRAME_NOT_JPEG and store nothing", async () => {
    const p = await plainSession();
    const id = (seq: number) => sponsorMomentId(seq, OVER_END.kind);
    const refused: [string, Uint8Array | null][] = [
      ["no body", null],
      ["an empty body", new Uint8Array(0)],
      ["FF D8", Uint8Array.of(0xff, 0xd8)],
      ["FF D8 00", Uint8Array.of(0xff, 0xd8, 0x00)],
      ["a PNG", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
      ["a leading 00", Uint8Array.of(0x00, 0xff, 0xd8, 0xff, 0xe0)],
      ["FE D8 FF", Uint8Array.of(0xfe, 0xd8, 0xff)],
      ["FF D9 FF", Uint8Array.of(0xff, 0xd9, 0xff)],
    ];
    const calls = store.calls.length;
    let checked = 0;
    for (const [label, body] of refused) {
      const res = await postFrame(sc2FrameUrl(p.sessionId, id(checked + 1)), { token: p.token, body });
      expect(res.status, label).toBe(415);
      expect(await json(res), label).toMatchObject({ ok: false, code: "FRAME_NOT_JPEG" });
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(store.calls.length).toBe(calls);
    expect(await framesOf(p.sessionId)).toEqual([]);
    // The positive pair: SOI alone, then SOI with a non-JFIF marker after it.
    expect((await postFrame(sc2FrameUrl(p.sessionId, id(20)), { token: p.token, body: Uint8Array.of(0xff, 0xd8, 0xff) })).status).toBe(204);
    expect((await postFrame(sc2FrameUrl(p.sessionId, id(21)), { token: p.token, body: Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00) })).status).toBe(204);
    expect(await framesOf(p.sessionId)).toHaveLength(2);
  });

  it("the grammar through the route: a path, a dot-run, an encoded slash, an undeclared kind and a carousel-less scene are 400 FRAME_MOMENT_INVALID and store nothing, whatever the token's standing", async () => {
    const p = await plainSession();
    const sceneless = OVERLAY_SCENES.map((s) => s.id).find((x) => !SPONSOR_CAROUSEL_SCENES.includes(x))!;
    const ids = ["a/b", "../../x", "/", "..x", `12:sponsor.${OVER_END.kind}/../x`, "12:sponsor.no_such_kind", `scene:${sceneless}:1`, "x".repeat(81)];
    const calls = store.calls.length;
    let checked = 0;
    for (const id of ids) {
      const params = matchFrameRoute(new URL(sc2FrameUrl(p.sessionId, id)).pathname);
      expect(params && (params as { momentId: string }).momentId, "premise: Next hands the route the id itself").toBe(id);
      const res = await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(1_000) });
      expect(res.status, id).toBe(400);
      expect(await json(res), id).toMatchObject({ ok: false, code: "FRAME_MOMENT_INVALID" });
      checked++;
    }
    // A segment that is literally `%2F` (an encoded slash), sent as is.
    const raw = await postFrame(`http://app.test/api/internal/relay/sessions/${p.sessionId}/airings/%2F/frame`, { token: p.token, body: jpegOf(1_000) });
    expect(raw.status).toBe(400);
    checked++;
    expect(checked).toBe(ids.length + 1);
    expect(store.calls.length).toBe(calls);
    expect(await framesOf(p.sessionId)).toEqual([]);
  });

  it("a refused id is logged (review m4): one warning naming the session and the id — bounded, so a long segment cannot flood the line — and nothing for an id the grammar accepts", async () => {
    const p = await plainSession();
    const warn = vi.spyOn(log, "warn");
    try {
      const long = "y".repeat(500);
      let checked = 0;
      for (const id of ["a/b", long]) {
        warn.mockClear();
        expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(1_000) })).status).toBe(400);
        const refusals = warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("names no sponsor airing"));
        expect(refusals, id.slice(0, 10)).toHaveLength(1);
        const fields = refusals[0]![0] as unknown as { sid: string; momentId: string; length: number };
        expect(fields).toEqual({ sid: p.sessionId, momentId: id.slice(0, FRAME_MOMENT_LOG_CHARS), length: id.length });
        checked++;
      }
      expect(checked).toBe(2);
      expect(FRAME_MOMENT_LOG_CHARS, "premise: the long id is past the bound").toBeLessThan(500);
      warn.mockClear();
      expect((await postFrame(sc2FrameUrl(p.sessionId, sponsorMomentId(1, OVER_END.kind)), { token: p.token, body: jpegOf(1_000) })).status).toBe(204);
      expect(warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("names no sponsor airing"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("decoded EXACTLY once: a literal `%` id arrives double-encoded (`%255F`), Next decodes it once to the literal, which is no declared kind → 400, nothing stored — a second decode would have read ANOTHER moment's id and stored under it; `50%` is a 400, never a 500", async () => {
    const p = await plainSession();
    const literal = `12:sponsor.${OVER_END.kind.replace("_", "%5F")}`;
    const url = sc2FrameUrl(p.sessionId, literal);
    expect(url, "SC2 encodes the % itself").toContain("12%3Asponsor.over%255Fend");
    const params = matchFrameRoute(new URL(url).pathname) as { momentId: string };
    expect(params.momentId, "Next decodes once: the literal id").toBe(literal);
    expect(isFrameMomentId(decodeURIComponent(literal)), "premise: a SECOND decode would pass the grammar").toBe(true);
    const res = await postFrame(url, { token: p.token, body: jpegOf(1_000) });
    expect(res.status).toBe(400);
    const lone = await postFrame(sc2FrameUrl(p.sessionId, "50%"), { token: p.token, body: jpegOf(1_000) });
    expect(lone.status, "a second decode of `50%` would throw").toBe(400);
    expect(await framesOf(p.sessionId)).toEqual([]);
    // The positive pair: the colon id SC2 encodes as %3A reaches the row as the colon id.
    const colon = sponsorMomentId(12, OVER_END.kind);
    expect((await postFrame(sc2FrameUrl(p.sessionId, colon), { token: p.token, body: jpegOf(1_000) })).status).toBe(204);
    expect((await framesOf(p.sessionId)).map((f) => f.moment_id)).toEqual([colon]);
  });

  it("storage failure: a failed put is a 502 (SC2 retries once), writes no row, and is reported ONCE — by the route's handler, with the provider's error as its cause (review m3) — without the token or the bytes; the retry lands", async () => {
    const p = await plainSession();
    const id = sponsorMomentId(2, OVER_END.kind);
    const error = vi.spyOn(log, "error");
    const warn = vi.spyOn(log, "warn");
    vi.mocked(captureError).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    store.fail.upload = 1;
    try {
      const res = await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(3_000) });
      expect(res.status).toBe(502);
      expect(await json(res)).toMatchObject({ ok: false, code: "FRAME_STORAGE_FAILED" });
      expect(await framesOf(p.sessionId)).toEqual([]);
      // One report: Sentry once (the handler's), no second capture by the usecase, and one error line.
      const reports = vi.mocked(Sentry.captureException).mock.calls;
      expect(reports, "reported once").toHaveLength(1);
      const reported = reports[0]![0] as Error & { code?: string; cause?: unknown };
      expect(reported.code).toBe("FRAME_STORAGE_FAILED");
      expect(reported.cause, "the provider's error rides as the cause").toBeInstanceOf(Error);
      expect((reported.cause as Error).message).toContain("storage is down");
      expect(vi.mocked(captureError), "the usecase reports nothing itself").not.toHaveBeenCalled();
      expect(error, "one error line").toHaveBeenCalledTimes(1);
      const said = JSON.stringify([error.mock.calls, warn.mock.calls, reports], (_k, v: unknown) =>
        (v instanceof Error ? { message: v.message, cause: (v as { cause?: unknown }).cause } : v));
      expect(said).toContain("storage is down");
      expect(said.includes(p.token), "the token is never logged").toBe(false);
      expect(said.includes(p.token.split(".")[2]!), "nor its signature").toBe(false);
      // jpegOf's SOI + APP0 in each form a byte array can take in a log line: a Uint8Array, a Buffer's `data`, text.
      for (const bytes of ['"0":255', "255,216,255", "ZZZZ"]) expect(said.includes(bytes), `nor the bytes (${bytes})`).toBe(false);
    } finally {
      store.fail.upload = 0;
      error.mockRestore();
      warn.mockRestore();
    }
    expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(3_000) })).status).toBe(204);
    expect(await framesOf(p.sessionId)).toHaveLength(1);
  });

  it("a superseded attempt (review m1): a frame on a token naming an attempt a retry replaced is 410 ATTEMPT_SUPERSEDED and stores nothing — the current attempt's frame is 204 and stays as it was; a token minted before the attempt claim is never superseded", async () => {
    const p = await plainSession();
    await sql`update fixture_stream_sessions set runner_attempts = 2 where id = ${p.sessionId}`;
    const mint = (attempt?: number) =>
      mintRelayToken({ sid: p.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 3_600_000), ...(attempt === undefined ? {} : { attempt }) });
    const id = sponsorMomentId(4, OVER_END.kind);
    const current = jpegOf(4_000, 0x02);
    expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: await mint(2), body: current })).status, "the current attempt (the edge: att = runner_attempts)").toBe(204);
    const [row] = await framesOf(p.sessionId);
    const calls = store.calls.length;
    const stray = await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(4_000, 0x01) });   // p.token: attempt 1
    expect(stray.status).toBe(410);
    expect(await json(stray)).toMatchObject({ ok: false, code: "ATTEMPT_SUPERSEDED" });
    expect(store.calls.length, "a stray asks storage nothing").toBe(calls);
    expect(storedAt(row!.path), "the current attempt's object is untouched").toEqual(current);
    expect(await framesOf(p.sessionId), "and its row").toEqual([row]);
    // Another moment from the stray: refused the same way, nothing written.
    expect((await postFrame(sc2FrameUrl(p.sessionId, sponsorMomentId(5, OVER_END.kind)), { token: p.token, body: jpegOf(4_000) })).status).toBe(410);
    expect(await framesOf(p.sessionId)).toHaveLength(1);
    // A token with no attempt claim (minted before the claim existed) keeps the behaviour it had.
    expect((await postFrame(sc2FrameUrl(p.sessionId, sponsorMomentId(6, OVER_END.kind)), { token: await mint(), body: jpegOf(4_000) })).status).toBe(204);
  });

  it("a client abort (review m10): a body whose stream fails mid-read is 400 FRAME_BODY_UNREADABLE — the client's failure, never a 500 or a report — and stores nothing", async () => {
    const p = await plainSession();
    vi.mocked(Sentry.captureException).mockClear();
    let sent = 0;
    const aborted = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent === 0) { sent++; c.enqueue(jpegOf(8_192)); return; }
        c.error(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
      },
    }, { highWaterMark: 0 });
    const calls = store.calls.length;
    const res = await postFrame(sc2FrameUrl(p.sessionId, sponsorMomentId(7, OVER_END.kind)), { token: p.token, body: aborted });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ ok: false, code: "FRAME_BODY_UNREADABLE" });
    expect(sent, "premise: the first chunk was read").toBe(1);
    expect(vi.mocked(Sentry.captureException), "nothing reported").not.toHaveBeenCalled();
    expect(store.calls.length).toBe(calls);
    expect(await framesOf(p.sessionId)).toEqual([]);
  });

  it("a session that does not exist is 404 behind a VALID token for that id (a deleted session)", async () => {
    const sid = randomUUID();
    const token = await mintRelayToken({ sid, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000), attempt: 1 });
    const res = await postFrame(sc2FrameUrl(sid, sponsorMomentId(1, OVER_END.kind)), { token, body: jpegOf(1_000) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DB: orphans.
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("S9: orphan frames (no airing row) are purged past session end + ORPHAN_FRAME_GRACE_MS, and every tombstoned object is removed", () => {
  /** A frame stored through the REAL writer while the session is live. */
  async function framed(p: Awaited<ReturnType<typeof plainSession>>, seq: number) {
    const id = sponsorMomentId(seq, OVER_END.kind);
    await storeAiringFrame(p.sessionId, p.token, id, jpegOf(1_000));
    const [row] = await sql<{ path: string }[]>`select path from sponsor_airing_frames where session_id = ${p.sessionId} and moment_id = ${id}`;
    expect(storedAt(row!.path), "premise: the object exists").toBeDefined();
    return { id, path: row!.path };
  }
  const endAt = (sessionId: string, endedAt: Date, state = "completed") =>
    sql`update fixture_stream_sessions set state = ${state}, ended_at = ${endedAt} where id = ${sessionId}`;
  const aired = (p: Awaited<ReturnType<typeof plainSession>>, momentId: string, at: Date) => sql`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style, started_at, ended_at)
    values (${p.orgId}, null, ${"Acme"}, ${p.fixtureId}, ${p.sessionId}, ${momentId}, 'rotation', ${OVER_END.kind}, 'lower_third', ${at}, ${at})`;
  const rowsFor = async (sessionIds: string[]) =>
    (await sql<{ session_id: string; moment_id: string }[]>`select session_id, moment_id from sponsor_airing_frames where session_id in ${sql(sessionIds)}`)
      .map((r) => `${r.session_id}/${r.moment_id}`).sort();
  const pastGrace = (now: Date) => new Date(now.getTime() - ORPHAN_FRAME_GRACE_MS - 60_000);

  it("the empty case first: a scope with no frames and no tombstones purges none, asks storage nothing, and spends TWO statements (the orphan delete, the tombstone read — nothing follows them)", async () => {
    const p = await plainSession();
    const calls = store.calls.length;
    const before = statementCount();
    expect(await purgeOrphanFrames(new Date(), { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 0, failed: 0 });
    expect(statementCount() - before, "two reads").toBe(2);
    expect(store.calls.length).toBe(calls);
  });

  it("past the grace an orphan goes (row, then object); at exactly the grace it stays; an aired frame, a live session's frame and another org's orphan stay; a second pass purges nothing more", async () => {
    const now = new Date();
    const old = await plainSession();       // ended a millisecond past the grace: its orphan goes, its aired frame stays
    const edge = await plainSession();      // ended exactly the grace ago: stays
    const live = await plainSession();      // never ended: stays
    const foreign = await plainSession();   // past the grace, but outside the scope: stays
    const orphan = await framed(old, 1);
    const kept = await framed(old, 2);
    const atEdge = await framed(edge, 1);
    const liveOne = await framed(live, 1);
    const foreignOne = await framed(foreign, 1);
    await aired(old, kept.id, new Date(now.getTime() - 2 * ORPHAN_FRAME_GRACE_MS));
    await endAt(old.sessionId, new Date(now.getTime() - ORPHAN_FRAME_GRACE_MS - 1));
    await endAt(edge.sessionId, new Date(now.getTime() - ORPHAN_FRAME_GRACE_MS));
    await endAt(foreign.sessionId, new Date(now.getTime() - 10 * ORPHAN_FRAME_GRACE_MS));
    const scope = [old.orgId, edge.orgId, live.orgId];
    const all = [old.sessionId, edge.sessionId, live.sessionId, foreign.sessionId];
    const before = await rowsFor(all);
    expect(before, "premise: five frames").toHaveLength(5);
    expect(await purgeOrphanFrames(now, { orgIds: scope })).toEqual({ orphans: 1, purged: 1, failed: 0 });
    expect(storedAt(orphan.path), "the orphan's object is gone").toBeUndefined();
    expect(await rowsFor(all)).toEqual(before.filter((k) => k !== `${old.sessionId}/${orphan.id}`));
    for (const f of [kept, atEdge, liveOne, foreignOne]) expect(storedAt(f.path), f.path).toBeDefined();
    const removes = store.calls.filter((x) => x.op === "remove" && x.paths.includes(orphan.path));
    expect(removes.map((r) => [r.bucket, r.paths])).toEqual([[SPONSOR_FRAMES_BUCKET, [orphan.path]]]);
    expect(await tombstonesOf([orphan.path]), "its tombstone went with it").toEqual([]);
    // A second pass, same clock: nothing more is an orphan past its grace.
    expect(await purgeOrphanFrames(now, { orgIds: scope })).toEqual({ orphans: 0, purged: 0, failed: 0 });
    // A millisecond later the edge session's orphan is past it too.
    expect(await purgeOrphanFrames(new Date(now.getTime() + 1), { orgIds: scope })).toEqual({ orphans: 1, purged: 1, failed: 0 });
    expect(storedAt(atEdge.path)).toBeUndefined();
  });

  it("review m6: the STATE is the authority — a session that is not terminal keeps its orphan however long ago its ended_at reads (25 h); the same session terminal loses it", async () => {
    const now = new Date();
    const p = await plainSession();
    const f = await framed(p, 1);
    const longAgo = new Date(now.getTime() - 25 * 3_600_000);
    expect(longAgo.getTime(), "premise: 25 h is past the grace").toBeLessThan(now.getTime() - ORPHAN_FRAME_GRACE_MS);
    let checked = 0;
    for (const state of ["live", "ending", "warming"]) {
      await endAt(p.sessionId, longAgo, state);
      expect({ state, purge: await purgeOrphanFrames(now, { orgIds: [p.orgId] }) }).toEqual({ state, purge: { orphans: 0, purged: 0, failed: 0 } });
      checked++;
    }
    expect(checked).toBe(3);
    expect(storedAt(f.path), "kept").toBeDefined();
    await endAt(p.sessionId, longAgo, "failed");
    expect(await purgeOrphanFrames(now, { orgIds: [p.orgId] })).toEqual({ orphans: 1, purged: 1, failed: 0 });
    expect(storedAt(f.path)).toBeUndefined();
  });

  it("review m5: each loop runs batches until one comes back short, and no more than maxBatches a pass — five orphans at batchSize 2: one batch takes 2, the next pass takes the other 3 (2 + a short 1); the tombstone drain is capped the same way; the defaults are the declared constants", async () => {
    const now = new Date();
    const p = await plainSession();
    const frames = [];
    for (let seq = 1; seq <= 5; seq++) frames.push(await framed(p, seq));
    await endAt(p.sessionId, pastGrace(now));
    expect(await purgeOrphanFrames(now, { orgIds: [p.orgId], batchSize: 2, maxBatches: 1 }), "capped: one batch per loop").toEqual({ orphans: 2, purged: 2, failed: 0 });
    expect(await rowsFor([p.sessionId])).toHaveLength(3);
    expect(frames.filter((f) => storedAt(f.path) === undefined)).toHaveLength(2);
    const removesBefore = store.calls.filter((x) => x.op === "remove").length;
    expect(await purgeOrphanFrames(now, { orgIds: [p.orgId], batchSize: 2, maxBatches: 10 }), "looped: 2 + 1").toEqual({ orphans: 3, purged: 3, failed: 0 });
    const removes = store.calls.filter((x) => x.op === "remove").slice(removesBefore);
    expect(removes.map((r) => r.paths.length), "one storage call per batch, each at most batchSize").toEqual([2, 1]);
    expect(frames.every((f) => storedAt(f.path) === undefined)).toBe(true);
    expect(await tombstonesOf(frames.map((f) => f.path))).toEqual([]);
    // The drain's own cap: three tombstones and no orphan (a deleted session's frames) at batchSize 2, one batch a pass.
    const q = await plainSession();
    const graves = [];
    for (let seq = 1; seq <= 3; seq++) graves.push(await framed(q, seq));
    await sql`delete from fixture_stream_sessions where id = ${q.sessionId}`;
    expect(await purgeOrphanFrames(now, { orgIds: [q.orgId], batchSize: 2, maxBatches: 1 }), "the drain capped too").toEqual({ orphans: 0, purged: 2, failed: 0 });
    expect(await tombstonesOf(graves.map((f) => f.path)), "one waits for the next pass").toHaveLength(1);
    expect(await purgeOrphanFrames(now, { orgIds: [q.orgId], batchSize: 2, maxBatches: 1 })).toEqual({ orphans: 0, purged: 1, failed: 0 });
    expect(graves.every((f) => storedAt(f.path) === undefined)).toBe(true);
    expect([ORPHAN_PURGE_BATCH, ORPHAN_PURGE_MAX_BATCHES], "the defaults").toEqual([500, 20]);
    let refused = 0;
    for (const bad of [{ batchSize: 0 }, { batchSize: 1.5 }, { maxBatches: 0 }, { maxBatches: Number.NaN }]) {
      await expect(purgeOrphanFrames(now, { orgIds: [p.orgId], ...bad }), JSON.stringify(bad)).rejects.toThrow(RangeError);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("a storage remove that fails keeps every tombstone (tomorrow's pass retries it) and is counted; the objects stay until the next pass removes them", async () => {
    const now = new Date();
    const p = await plainSession();
    const a = await framed(p, 1);
    const b = await framed(p, 2);
    await endAt(p.sessionId, pastGrace(now));
    store.fail.remove = 1;
    try {
      expect(await purgeOrphanFrames(now, { orgIds: [p.orgId] })).toEqual({ orphans: 2, purged: 0, failed: 2 });
    } finally {
      store.fail.remove = 0;
    }
    expect(await rowsFor([p.sessionId]), "the orphan rows are gone").toEqual([]);
    expect(await tombstonesOf([a.path, b.path]), "their tombstones stand").toEqual([a.path, b.path].sort());
    expect([storedAt(a.path), storedAt(b.path)].every((x) => x !== undefined), "and so do the objects").toBe(true);
    expect(await purgeOrphanFrames(now, { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 2, failed: 0 });
    expect([storedAt(a.path), storedAt(b.path)]).toEqual([undefined, undefined]);
    expect(await tombstonesOf([a.path, b.path])).toEqual([]);
  });

  it("an empty org scope is refused by name (an empty list must never read as 'every org')", async () => {
    await expect(purgeOrphanFrames(new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DB: tombstones (V483, review m8) — the object outlives its row in no way at all.
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("S9: every object whose row goes is tombstoned and removed on the next pass", () => {
  it("a session deleted (its frames cascade): each path is tombstoned in the same statement, live session or not, and the next pass removes the objects and the tombstones", async () => {
    const p = await plainSession();
    const paths: string[] = [];
    for (const seq of [1, 2]) {
      const id = sponsorMomentId(seq, OVER_END.kind);
      expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(2_000) })).status).toBe(204);
      paths.push(airingFramePath(p.orgId, p.sessionId, id));
    }
    expect(await tombstonesOf(paths), "premise: no tombstone while the rows stand").toEqual([]);
    await sql`delete from fixture_stream_sessions where id = ${p.sessionId}`;
    expect(await framesOf(p.sessionId), "the rows cascaded").toEqual([]);
    expect(await tombstonesOf(paths), "and left their paths").toEqual([...paths].sort());
    expect(paths.every((x) => storedAt(x) !== undefined), "the objects are still stored").toBe(true);
    expect(await purgeOrphanFrames(new Date(), { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 2, failed: 0 });
    expect(paths.map(storedAt)).toEqual([undefined, undefined]);
    expect(await tombstonesOf(paths)).toEqual([]);
  });

  it("the row write failing AFTER the object was stored (the session deleted mid-upload): the client gets the 500 (reported once), no row is written, the path is tombstoned, and the next pass removes the object", async () => {
    const p = await plainSession();
    const id = sponsorMomentId(3, OVER_END.kind);
    const path = airingFramePath(p.orgId, p.sessionId, id);
    vi.mocked(Sentry.captureException).mockClear();
    store.hooks.afterUpload = async () => { await sql`delete from fixture_stream_sessions where id = ${p.sessionId}`; };
    let res: Response;
    try {
      res = await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpegOf(2_000) });
    } finally {
      store.hooks.afterUpload = null;
    }
    expect(res.status).toBe(500);
    expect(vi.mocked(Sentry.captureException), "reported once").toHaveBeenCalledTimes(1);
    expect((vi.mocked(Sentry.captureException).mock.calls[0]![0] as { code?: string }).code, "the database's refusal (a foreign key)").toBe("23503");
    expect(await framesOf(p.sessionId)).toEqual([]);
    expect(storedAt(path), "premise: the object was stored").toBeDefined();
    expect(await tombstonesOf([path]), "and its tombstone written").toEqual([path]);
    expect(await purgeOrphanFrames(new Date(), { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 1, failed: 0 });
    expect(storedAt(path)).toBeUndefined();
  });

  it("a tombstoned path a frame row still names keeps its object (a replace whose row write failed after its put): the tombstone goes, the object and the row stay", async () => {
    const p = await plainSession();
    const id = sponsorMomentId(4, OVER_END.kind);
    const jpeg = jpegOf(2_000);
    expect((await postFrame(sc2FrameUrl(p.sessionId, id), { token: p.token, body: jpeg })).status).toBe(204);
    const path = airingFramePath(p.orgId, p.sessionId, id);
    await sql`insert into sponsor_frame_tombstones (path) values (${path})`;
    const removesBefore = store.calls.filter((x) => x.op === "remove").length;
    expect(await purgeOrphanFrames(new Date(), { orgIds: [p.orgId] })).toEqual({ orphans: 0, purged: 0, failed: 0 });
    expect(store.calls.filter((x) => x.op === "remove").slice(removesBefore), "storage is not asked").toEqual([]);
    expect(storedAt(path)).toEqual(jpeg);
    expect(await framesOf(p.sessionId)).toHaveLength(1);
    expect(await tombstonesOf([path]), "the tombstone is cleared").toEqual([]);
  });
});
