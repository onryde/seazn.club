// Seazn-hosted Task 25b, chess follow-up (owner 2026-11-23): the `chess-room` client report (chess-room.ts) — a camera room dropped a
// player's or the arbiter's connection. Three parts:
//   - the SCHEMA: every combination of the declared surfaces, sides (and none) and drop states is accepted; a planned leave state (read
//     from the SDK's own `LeaveRoomState`, not typed here), a fixture that is no uuid, an unknown surface or side, a missing field, any
//     extra key (a name, an email, a token, a participant id) and any string shaped like an address or a credential are refused — by the
//     kind and by the route's union;
//   - the FACTS: the Sentry dedupe key is fixture + surface + side + leave state — EACH of the four moves it, a repeat does not, and no
//     side is its own value; the rate subject is the fixture; the fields and tags are codes and ids only;
//   - the PIPELINE (receive.ts, over an in-memory counter on a test clock and a stub fixture lookup; the SQL itself is
//     route-seam-chess-room.test.ts, over a real database): a fixture with no camera room is dropped without a word (the EMPTY case,
//     first); the first report is one log line and one Sentry warning; a repeat is a server-log line only; each component of the key
//     opens its own event; the window reopens it; the kind's Sentry budget is the registry default and past it a report is a server-log
//     line, and the refused one's dedupe slot is given back; one IP's Sentry share holds for this kind; the per-IP-and-fixture limit is per
//     FIXTURE.
// Expected numbers come from the declarations (CLIENT_REPORT_SENTRY_BUDGET, CLIENT_REPORT_IP_SENTRY_SHARE, CLIENT_REPORT_LIMIT, the
// window, the code lists), never from the pipeline. Sport: not applicable. A camera room's drop is sport-agnostic (it is online chess).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clock = vi.hoisted(() => ({ now: 0 }));
const counter = vi.hoisted(() => ({ windows: new Map<string, { count: number; until: number }>() }));
vi.mock("@/lib/cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string, windowSeconds: number) => {
    const held = counter.windows.get(key);
    const live = held !== undefined && held.until > clock.now ? held : { count: 0, until: clock.now + windowSeconds * 1000 };
    live.count += 1;
    counter.windows.set(key, live);
    return { count: live.count, ttlMs: live.until - clock.now };
  },
  // Redis DEL on the same keyspace (receive.ts gives a refused first report's dedupe slot back).
  cacheDel: async (...keys: string[]) => {
    for (const key of keys) counter.windows.delete(key);
  },
}));
const sentry = vi.hoisted(() => ({ messages: [] as { message: string; context: { level: string; tags: Record<string, string>; extra: Record<string, unknown> } }[] }));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureMessage: (message: string, context: never) => void sentry.messages.push({ message, context }),
}));

import { randomUUID } from "node:crypto";
import pino from "pino";
import { z } from "zod";
import { incrWindow } from "@/lib/cache";
import { isRoomDropState, ROOM_DROP_STATES, ROOM_REPORT_SIDES, ROOM_REPORT_SURFACES } from "@/lib/chess-room-report-codes";
import { __setRateLimitCounterForTests, CLIENT_REPORT_LIMIT } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import {
  CLIENT_REPORT_IP_SENTRY_SHARE, CLIENT_REPORT_SENTRY_WINDOW_SECONDS, ClientReport, receiveClientReport, type ClientReportOutcome,
} from "..";
import { CLIENT_REPORT_SENTRY_BUDGET, type ReportDb } from "../define";
import { chessRoomClientReport, ChessRoomClientReport } from "../chess-room";
import { clientReportKind } from "../kinds";

const FIXTURE = "8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
type Room = z.input<typeof ChessRoomClientReport>;
const room = (over: Partial<Room> = {}): Room => ({ kind: "chess-room", fixtureId: FIXTURE, surface: "player", side: "white", leaveState: "disconnected", ...over });

describe("the chess-room report's schema", () => {
  it("every declared surface, side (and none) and drop state is accepted, as the kind and as the route's union", () => {
    let checked = 0;
    for (const surface of ROOM_REPORT_SURFACES) {
      for (const side of [...ROOM_REPORT_SIDES, null]) {
        for (const leaveState of ROOM_DROP_STATES) {
          const body = room({ surface, side, leaveState });
          expect(ChessRoomClientReport.parse(body), `${surface}/${side}/${leaveState}`).toEqual(body);
          expect(ClientReport.parse(body)).toEqual(body);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: the whole product was walked").toBe(ROOM_REPORT_SURFACES.length * (ROOM_REPORT_SIDES.length + 1) * ROOM_DROP_STATES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("only a LOST connection is a drop: every other LeaveRoomState the SDK declares is refused — swept over the SDK's own union", () => {
    const dts = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@cloudflare/realtimekit")), "index.d.ts"), "utf8");
    const union = /type LeaveRoomState = ([^;]+);/.exec(dts)?.[1] ?? "";
    const states = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(states.length, "anti-vacuity: the SDK's LeaveRoomState was read").toBe(8);
    expect(states.filter(isRoomDropState).sort(), "premise: every drop state we send is one the SDK declares").toEqual([...ROOM_DROP_STATES].sort());
    let refused = 0;
    for (const leaveState of states.filter((s) => !isRoomDropState(s))) {
      expect(ChessRoomClientReport.safeParse(room({ leaveState: leaveState as never })).success, leaveState).toBe(false);
      expect(ClientReport.safeParse(room({ leaveState: leaveState as never })).success, leaveState).toBe(false);
      refused++;
    }
    expect(refused, "the planned leaves: kicked, ended, rejected, connected-meeting, stageLeft").toBe(states.length - ROOM_DROP_STATES.length);
    expect(refused).toBeGreaterThan(0);
  });

  it("a fixture that is no uuid, an unknown surface or side, a missing field, and a field of the wrong type are refused", () => {
    const without = (key: keyof Room) => Object.fromEntries(Object.entries(room()).filter(([k]) => k !== key));
    const cases: [string, unknown][] = [
      ["fixture not a uuid", room({ fixtureId: "fx-1" })],
      ["fixture empty", room({ fixtureId: "" })],
      ["fixture null", room({ fixtureId: null as never })],
      ["unknown surface", room({ surface: "spectator" as never })],
      ["surface empty", room({ surface: "" as never })],
      ["a side the surfaces never name", room({ side: "green" as never })],
      ["a side in the wrong case", room({ side: "HOME" as never })],
      ["side empty", room({ side: "" as never })],
      ["no kind", without("kind")],
      ["no fixtureId", without("fixtureId")],
      ["no surface", without("surface")],
      ["no side (null is the way to say none)", without("side")],
      ["no leaveState", without("leaveState")],
      ["leaveState a number", room({ leaveState: 1 as never })],
      ["an array", [room()]],
    ];
    let refused = 0;
    for (const [name, body] of cases) {
      expect(ChessRoomClientReport.safeParse(body).success, name).toBe(false);
      expect(ClientReport.safeParse(body).success, name).toBe(false);
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it("the body is closed: a name, an email, a token, a participant or peer id, or any other key is refused (no PII rides a report)", () => {
    const extras = ["name", "displayName", "email", "token", "authToken", "participantId", "peerId", "userId", "personId", "at", "gapMs", "message", "url"];
    let refused = 0;
    for (const key of extras) {
      expect(ChessRoomClientReport.safeParse({ ...room(), [key]: "x" }).success, key).toBe(false);
      expect(ClientReport.safeParse({ ...room(), [key]: "x" }).success, key).toBe(false);
      refused++;
    }
    expect(refused).toBe(extras.length);
    expect(Object.keys(ChessRoomClientReport.shape).sort(), "the whole payload").toEqual(["fixtureId", "kind", "leaveState", "side", "surface"]);
  });

  it("ANY string shaped like an address, a query, a path or a credential's name, in every string field, is refused", () => {
    const shapes = ["https://x.example/a?token=1", "token", "accessToken", "EXPIRES", "a/b", "x=1&y=2", "a b", "%2F", "iframe.mediadelivery.net"];
    let refused = 0;
    for (const field of ["fixtureId", "surface", "side", "leaveState"] as const) {
      for (const shape of shapes) {
        expect(ClientReport.safeParse(room({ [field]: shape })).success, `${field}: ${shape}`).toBe(false);
        refused++;
      }
    }
    expect(refused).toBe(4 * shapes.length);
  });
});

describe("the chess-room report's facts: what the pipeline reads off one", () => {
  const facts = (over: Partial<Room> = {}) => chessRoomClientReport.facts(room(over));

  it("the rate subject is the fixture; the message and the fields are codes and ids only", () => {
    const f = facts({ surface: "arbiter", side: "home", leaveState: "failed" });
    expect(f.rateSubject).toBe(FIXTURE);
    expect(f.message).toBe("realtimekit: room dropped");
    expect(f.fields).toEqual({ fixtureId: FIXTURE, surface: "arbiter", side: "home", leaveState: "failed" });
    expect(f.tags).toEqual({ area: "realtimekit", event: "room_dropped", surface: "arbiter", leave_state: "failed", fixture_id: FIXTURE, side: "home" });
    expect(Object.keys(facts({ side: null }).tags), "no side: no side tag (a tag is a string, never null)").not.toContain("side");
    expect(facts({ side: null }).fields.side).toBeNull();
  });

  it("the dedupe key moves with EACH of fixture, surface, side (including none) and leave state — and not with a repeat", () => {
    const base = facts().dedupeSubject;
    expect(facts().dedupeSubject, "the same drop again").toBe(base);
    const other = randomUUID();
    const variants: [string, Partial<Room>][] = [
      ["another fixture", { fixtureId: other }],
      ["the other surface", { surface: "arbiter" }],
      ["another side", { side: "black" }],
      ["no side", { side: null }],
      ["another leave state", { leaveState: "failed" }],
    ];
    const keys = new Set<string>([base]);
    for (const [name, over] of variants) {
      const key = facts(over).dedupeSubject;
      expect(key, name).not.toBe(base);
      keys.add(key);
    }
    expect(keys.size, "every variant its own key").toBe(variants.length + 1);
    // The kind's key spans the whole product: nothing in the declared lists collides.
    const all = new Set<string>();
    let checked = 0;
    for (const surface of ROOM_REPORT_SURFACES) {
      for (const side of [...ROOM_REPORT_SIDES, null]) {
        for (const leaveState of ROOM_DROP_STATES) {
          all.add(facts({ surface, side, leaveState }).dedupeSubject);
          checked++;
        }
      }
    }
    expect(all.size, "no two reports of the product share a key").toBe(checked);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the chess-room report through the pipeline (receive.ts)", () => {
  const IP = "203.0.113.10";
  const OTHER_IP = "198.51.100.20";
  /** What the fixture lookup was asked: the SQL text and its values. */
  const asked: { text: string; values: readonly unknown[] }[] = [];
  /** A fixture lookup that answers `has` for every fixture in the set, and records what it was asked. */
  const db = (has: ReadonlySet<string> | "all"): ReportDb =>
    (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      asked.push({ text: strings.join("?"), values });
      return [{ room: has === "all" || has.has(String(values[0])) }];
    }) as unknown as ReportDb;
  const send = (over: Partial<Room> = {}, ip = IP, deps: { db?: ReportDb } = { db: db("all") }): Promise<ClientReportOutcome> =>
    receiveClientReport(ClientReport.parse(room(over)), ip, deps);

  /** The pipeline's own `log.warn` lines (the ones Sentry Logs gets), and its server-log-only lines. */
  let warn: ReturnType<typeof vi.spyOn>;
  const serverOnly: string[] = [];
  const lines = () => warn.mock.calls.filter((c: unknown[]) => c[1] === "realtimekit: room dropped");
  const serverOnlyLines = (why: string) => serverOnly.filter((l) => l.includes('"msg":"realtimekit: room dropped"') && l.includes(`"clientReportSentry":"${why}"`));

  // The logger's level, pinned per test and restored: CI's smoke jobs run with LOG_LEVEL=error (ci.yml), under which pino's warn and the
  // pipeline's server-log-only line are both silent, and these tests are about what a WARN line does. Set BEFORE any spy on `log` (pino's
  // level setter reassigns the level methods, which would replace a spy), restored AFTER the spies are.
  let ambientLevel = "";
  beforeEach(() => {
    ambientLevel = log.level;
    log.level = "info";
    clock.now = Date.parse("2026-11-23T12:00:00.000Z");
    counter.windows.clear();
    sentry.messages.length = 0;
    asked.length = 0;
    serverOnly.length = 0;
    __setRateLimitCounterForTests((key, windowSeconds) => incrWindow(key, windowSeconds));
    warn = vi.spyOn(log, "warn");
    const destination = (log as unknown as Record<symbol, { write: (s: string) => boolean }>)[pino.symbols.streamSym]!;
    vi.spyOn(destination, "write").mockImplementation((chunk: string) => (serverOnly.push(String(chunk)), true));
  });
  afterEach(() => {
    __setRateLimitCounterForTests(null);
    vi.restoreAllMocks();
    log.level = ambientLevel;
  });
  /** A distinct client address per call, and a distinct fixture: nothing but the thing under test is shared. */
  let n = 0;
  const fresh = () => ({ ip: `10.${Math.floor(++n / 60_000)}.${Math.floor(n / 250) % 250}.${n % 250}`, fixtureId: randomUUID() });

  it("EMPTY CASE FIRST: a fixture with no camera room is dropped without a word — nothing logged, nothing sent; the lookup names the fixture and the meetings table", async () => {
    const outcome = await send({}, IP, { db: db(new Set()) });
    expect(outcome).toBe("unknown");
    expect(asked, "the subject was looked up once").toHaveLength(1);
    expect(asked[0]!.values).toEqual([FIXTURE]);
    expect(asked[0]!.text).toContain("fixture_video_meetings");
    expect(lines()).toEqual([]);
    expect(serverOnly).toEqual([]);
    expect(sentry.messages).toEqual([]);
    // The positive pair: the same report for a fixture that HAS a room is sent (a pipeline that cannot send would pass the above).
    expect(await send({}, IP, { db: db(new Set([FIXTURE])) })).toBe("sent");
    expect(sentry.messages).toHaveLength(1);
  });

  it("a first report: one warn line with its codes, one Sentry warning with them as tags and extras", async () => {
    expect(await send({ surface: "arbiter", side: "away", leaveState: "failed" })).toBe("sent");
    const fields = { fixtureId: FIXTURE, surface: "arbiter", side: "away", leaveState: "failed" };
    expect(lines().map((c: unknown[]) => [c[0], c[1]])).toEqual([[{ clientReport: "chess-room", ...fields }, "realtimekit: room dropped"]]);
    expect(sentry.messages).toEqual([{
      message: "realtimekit: room dropped",
      context: {
        level: "warning",
        tags: { client_report: "chess-room", area: "realtimekit", event: "room_dropped", surface: "arbiter", leave_state: "failed", fixture_id: FIXTURE, side: "away" },
        extra: fields,
      },
    }]);
  });

  it("the dedupe: the same drop again, from anyone, is a server-log line only; each of fixture, surface, side, none and leave state opens its own event; the window reopens it", async () => {
    expect(await send({}, fresh().ip)).toBe("sent");
    expect(await send({}, fresh().ip), "another player's client, the same drop").toBe("logged");
    expect(await send({}, OTHER_IP), "the same drop once more").toBe("logged");
    expect(sentry.messages, "repeats reach Sentry never").toHaveLength(1);
    expect(serverOnlyLines("repeat"), "the two repeats are server-log lines").toHaveLength(2);
    expect(lines(), "only the first is the Sentry-forwarded line").toHaveLength(1);
    const variants: [string, Partial<Room>][] = [
      ["another fixture", { fixtureId: randomUUID() }],
      ["the arbiter's join of the board", { surface: "arbiter" }],
      ["the other side", { side: "black" }],
      ["no side", { side: null }],
      ["the SDK giving up", { leaveState: "failed" }],
    ];
    for (const [name, over] of variants) expect(await send(over, fresh().ip), name).toBe("sent");
    expect(sentry.messages, "the first, and one per variant").toHaveLength(1 + variants.length);
    // And each variant is itself deduped.
    for (const [name, over] of variants) {
      if (over.fixtureId !== undefined) continue; // a random id cannot be named again
      expect(await send(over, fresh().ip), `${name}, again`).toBe("logged");
    }
    expect(sentry.messages).toHaveLength(1 + variants.length);
    clock.now += CLIENT_REPORT_SENTRY_WINDOW_SECONDS * 1000 - 1;
    expect(await send({}, fresh().ip), "a millisecond before the window ends").toBe("logged");
    clock.now += 1;
    expect(await send({}, fresh().ip), "the window over: sent again").toBe("sent");
    expect(sentry.messages).toHaveLength(2 + variants.length);
  });

  it("the kind's Sentry budget is the registry default: past it a report is a server-log line only, its dedupe slot is given back, and the window reopens it", async () => {
    expect(clientReportKind("chess-room").sentryBudget, "premise: no budget of its own").toBe(CLIENT_REPORT_SENTRY_BUDGET);
    const { max, windowSeconds } = CLIENT_REPORT_SENTRY_BUDGET;
    for (let i = 0; i < max; i++) expect(await send({ fixtureId: fresh().fixtureId }, fresh().ip), `report ${i + 1} of ${max}`).toBe("sent");
    expect(sentry.messages, "the budget, spent").toHaveLength(max);
    const refused = fresh().fixtureId;
    expect(await send({ fixtureId: refused }, fresh().ip), "one past the budget").toBe("over-budget");
    expect(sentry.messages, "nothing more reached Sentry").toHaveLength(max);
    expect(serverOnlyLines("over-budget"), "it is a server-log line").toHaveLength(1);
    // The slot was given back: the same failure from another client is a FIRST report again (over budget again), not a repeat.
    expect(await send({ fixtureId: refused }, fresh().ip), "the refused failure, from another client").toBe("over-budget");
    clock.now += windowSeconds * 1000;
    expect(await send({ fixtureId: refused }, fresh().ip), "the budget's window over").toBe("sent");
    expect(sentry.messages).toHaveLength(max + 1);
  });

  it("one client IP's Sentry share holds for this kind: past it a report is a server-log line only, and another client's report of that failure is still first", async () => {
    const { max } = CLIENT_REPORT_IP_SENTRY_SHARE;
    for (let i = 0; i < max; i++) expect(await send({ fixtureId: fresh().fixtureId }, IP), `report ${i + 1} of the share`).toBe("sent");
    const refused = fresh().fixtureId;
    expect(await send({ fixtureId: refused }, IP), "one past the IP's share").toBe("over-share");
    expect(sentry.messages).toHaveLength(max);
    expect(await send({ fixtureId: refused }, OTHER_IP), "the same failure from another IP: a first report").toBe("sent");
    expect(sentry.messages).toHaveLength(max + 1);
  });

  it("the per-IP limit is per FIXTURE: one fixture's reports are capped at the limit, another fixture's are not", async () => {
    const statesPerWindow: ClientReportOutcome[] = [];
    for (let i = 0; i < CLIENT_REPORT_LIMIT.max + 1; i++) statesPerWindow.push(await send({}, IP));
    expect(statesPerWindow[0]).toBe("sent");
    expect(statesPerWindow.slice(1, CLIENT_REPORT_LIMIT.max), "the rest under the cap are repeats").toEqual(Array(CLIENT_REPORT_LIMIT.max - 1).fill("logged"));
    expect(statesPerWindow[CLIENT_REPORT_LIMIT.max], "one past the cap").toBe("capped");
    expect(await send({ fixtureId: fresh().fixtureId }, IP), "another fixture, the same IP").toBe("sent");
    expect(await send({}, OTHER_IP), "the capped fixture from another IP").toBe("logged");
  });
});
