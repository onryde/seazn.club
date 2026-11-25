// Realtime push-nudges Task 10 (T2.3, spec 2026-11-24 §3) — a write that changes what a Match Day screen shows (a score, a schedule
// change, a match called to a court) sends a private `nudge` on `match-day:{codeId}` to every OPEN code of the competition, so the
// screen re-reads its day now instead of waiting out its poll. The nudges ride in the SAME broadcast as the write's other messages:
// still exactly ONE POST per write, void-lines included (it was 1 + N).
//
// Driven through the REAL `afterScheduleWrite`, `scoreEvent`, `voidLineEvents` and `callFixtureToCourt` with the REAL `broadcast`
// (`@/lib/realtime` is not mocked: `fetch` is a spy, the Supabase env is stubbed) over real `match_day_codes` rows in Postgres. Only
// the pooled `sql` is wrapped, by a passthrough that COUNTS the statements reading `match_day_codes` (so "no read" and "one read"
// are numbers, never inferences) and can make one fail or never answer.
//
// The rules, typed from the brief and the spec, never from the code under test:
//   - a code is nudged when it is not withdrawn and `opens_at <= now < expires_at`: a code withdrawn, expired (at or past its expiry)
//     or not yet open gets nothing; another competition's code gets nothing; two open codes get one message each; none gets none;
//   - the reasons are the spec's three (`MATCH_DAY_NUDGE_REASONS`): a score sends `score`, a schedule write `schedule`, and
//     `match-day-call.ts` (a call and its undo) `call`;
//   - a competition's open codes are read at most once per 15 s per instance: a code minted inside the window is not seen until it
//     lapses (at exactly 15 s it is), a code WITHDRAWN inside it is nudged once more (STALENESS ACCEPTED: the message carries no
//     data and the door refuses the screen's next read — a withdrawn code's channel hears at most one nudge more), a code that
//     EXPIRES inside it is dropped at once, and two competitions never share an entry;
//   - best-effort: a read that throws sends the batch without the Match Day messages and warns by the error's class name (never a
//     code id, a token or an error message); a read slower than the bound is abandoned; a blank code id is dropped, not sent;
//   - publishing off (`REALTIME_PUBLISH=off`) or a non-uuid competition: nothing is sent AND nothing is read, no timer armed;
//   - `fixturePushes: false` (a quick match's create) reads nothing for Match Day either.
//
// Task 14 (D-a): every division message is TWO on the wire, the public one then its private twin, so each topic list below
// names `division:{id}` twice (the twin's shape is pinned by lib/__tests__/realtime-publish.test.ts).
//
// Applies to another sport: N/A (no sport rules) — the generic and badminton divisions here only give a fixture to score and void.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

// Every public literal-key DEL settles at once, so the push chained on it goes out on the next tick. No real Redis.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheDel: (...keys: string[]) =>
      keys.length > 0 && keys.every((key) => key.startsWith("pub:v1:")) ? Promise.resolve() : actual.cacheDel(...keys),
  };
});
// A passthrough that counts the statements that READ `match_day_codes`, and can make the next one fail or never answer.
const probe = vi.hoisted(() => ({ reads: 0, fail: false, hang: false }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const counted = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (Array.isArray(strings) && "raw" in strings) {
        const text = strings.join("?");
        if (/^\s*select[\s\S]*from match_day_codes/i.test(text)) {
          probe.reads += 1;
          if (probe.fail) return Promise.reject(new Error("db exploded: secret-detail-7731"));
          if (probe.hang) return new Promise(() => {});
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { ...actual, sql: counted };
});
// A deciding score schedules a player-stats refresh, which pushes its own division `score` (its own test's business).
vi.mock("../player-stats-refresh", () => ({ schedulePlayerStatsRefresh: () => {} }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { MATCH_DAY_NUDGE_REASONS, nudgeMessage, matchDayTopic, type MatchDayNudgeReason } from "@/lib/realtime";
import { log } from "@/server/logger";
import { afterScheduleWrite, moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { voidLineEvents } from "../void-lines";
import { callFixtureToCourt, undoCall } from "../match-day-call";
import { mintMatchDayCode, revokeMatchDayCode } from "../match-day-codes";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { nudgesSettled } from "../stream-sessions/nudge";
import {
  MATCH_DAY_MEMO_MS,
  MATCH_DAY_NUDGE_READ_BOUND_MS,
  codeMessages,
  matchDayNudgeMessages,
  matchDayNudgesFor,
  readOpenCodes,
  resetMatchDayMemo,
} from "../match-day-nudges";
import { seedOrg } from "./_seed";
import { seedDay, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE = "https://rtn-md.example.supabase.co";
const BROADCAST_URL = `${SUPABASE}/realtime/v1/api/broadcast`;
const HOUR = 3_600_000;

type WireMessage = { topic: string; event: string; payload: { reason: string; v: number; at: string }; private?: boolean };
const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  void input;
  void init;
  return new Response(null, { status: 202 });
});
/** Every POST sent to the broadcast endpoint, as the wire messages each one carried, in send order. */
function posts(): WireMessage[][] {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input) === BROADCAST_URL)
    .map(([, init]) => (JSON.parse(String(init?.body)) as { messages: WireMessage[] }).messages);
}
const mdOf = (post: WireMessage[]): WireMessage[] => post.filter((m) => m.topic.startsWith("match-day:"));
const restOf = (post: WireMessage[]): string[] => post.filter((m) => !m.topic.startsWith("match-day:")).map((m) => m.topic);
const topicsOf = (post: WireMessage[]): string[] => mdOf(post).map((m) => m.topic).sort();
const topicsFor = (ids: string[]): string[] => ids.map((id) => `match-day:${id}`).sort();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The DEL settles at once; then every push in flight (its Match Day and court reads included) is awaited. */
const settled = async (): Promise<void> => {
  await sleep(30);
  // Raced: a push whose bound regressed never settles, and must fail its own test in 2 s, not cascade 30 s timeouts into the rest.
  await Promise.race([nudgesSettled(), sleep(2_000)]);
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy.mockClear();
  probe.reads = 0;
  probe.fail = false;
  probe.hang = false;
  resetMatchDayMemo();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("REALTIME_PUBLISH", undefined);
  warn = vi.spyOn(log, "warn");
});
afterEach(async () => {
  // A test on fake timers may end with a push or a read still waiting on one: let them run out before the real clock returns.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
  vi.useRealTimers();
  // Bounded: a read abandoned by a broken bound never settles, and must fail its own test, not hang every hook after it.
  await Promise.race([settled(), sleep(1_500)]);
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A Match Day code of `competitionId`, with its window and withdrawal given outright. Raw SQL: the door's own mint needs a KEK. */
async function code(
  day: Day,
  o: { opens: Date; expires: Date; revoked?: boolean; competitionId?: string },
): Promise<string> {
  if (day.auth.userId === null) throw new Error("premise: the seeded org has a user to issue a code");
  const [row] = await sql<{ id: string }[]>`
    insert into match_day_codes (org_id, competition_id, scope_kind, can_approve, day, tz, opens_at, expires_at, tok_hash, token_enc,
                                 issued_by, revoked_at)
    values (${day.orgId}, ${o.competitionId ?? day.comp.id}, 'competition', false, current_date, 'UTC', ${o.opens}, ${o.expires},
            ${randomBytes(32).toString("hex")}, ${randomBytes(48)}, ${day.auth.userId}, ${o.revoked ? new Date() : null})
    returning id`;
  return row!.id;
}
const openCode = (day: Day, base: Date, competitionId?: string): Promise<string> =>
  code(day, { opens: new Date(base.getTime() - HOUR), expires: new Date(base.getTime() + HOUR), competitionId });
/** A seeded day with its own seeding publishes landed and forgotten — the memo and the read count included: seeding is a run of
 *  schedule writes, and each remembers the competition's (empty) codes for 15 s. */
async function quietDay(): Promise<Day> {
  const day = await seedDay();
  await settled();
  fetchSpy.mockClear();
  resetMatchDayMemo();
  probe.reads = 0;
  return day;
}
const reasonsAll: readonly MatchDayNudgeReason[] = MATCH_DAY_NUDGE_REASONS;

describe.skipIf(!HAS_DB)("matchDayNudgeMessages: which codes are nudged, and the 15 s memo", () => {
  it("no code at all: [] — and the read was made (a nudge of nothing, not a skipped read)", async () => {
    const day = await quietDay();
    expect(await matchDayNudgeMessages(day.comp.id, "score", new Date())).toEqual([]);
    expect(probe.reads, "anti-vacuity: the competition's codes were read").toBe(1);
  });

  it.each(reasonsAll)("one open code, reason %s: one private `nudge` on its topic, a reason and a time and nothing else", async (reason) => {
    expect(reasonsAll.length, "anti-vacuity: the spec's three reasons").toBe(3);
    const day = await quietDay();
    const now = new Date();
    const id = await openCode(day, now);
    const out = await matchDayNudgeMessages(day.comp.id, reason, now);
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.topic).toBe(`match-day:${id}`);
    expect(m.event).toBe("nudge");
    expect(m.private, "a Match Day topic is private").toBe(true);
    expect(Object.keys(m.payload as object).sort(), "a nudge carries a reason and a time, never state").toEqual(["at", "reason", "v"]);
    expect((m.payload as { reason: string }).reason).toBe(reason);
  });

  it("the read's own rows: only the open window — a withdrawn, a lapsed (at its expiry too) and a not-yet-open code never leave the database", async () => {
    const day = await quietDay();
    const now = new Date();
    const open = await openCode(day, now);
    const justOpened = await code(day, { opens: now, expires: new Date(now.getTime() + HOUR) });
    await code(day, { opens: new Date(now.getTime() - HOUR), expires: new Date(now.getTime() + HOUR), revoked: true });
    await code(day, { opens: new Date(now.getTime() - 3 * HOUR), expires: new Date(now.getTime() - HOUR) });
    await code(day, { opens: new Date(now.getTime() - HOUR), expires: now });
    await code(day, { opens: new Date(now.getTime() + 1), expires: new Date(now.getTime() + HOUR) });
    const rows = await readOpenCodes(day.comp.id, now);
    expect(rows.map((r) => r.id).sort(), "anti-vacuity: the two open codes of six").toEqual([open, justOpened].sort());
    for (const r of rows) expect(r.expiresAt, "each row carries its expiry, the memo's serve-time guard").toBeGreaterThan(now.getTime());
  });

  it("two open codes: two messages, one per code", async () => {
    const day = await quietDay();
    const now = new Date();
    const a = await openCode(day, now);
    const b = await openCode(day, now);
    const out = await matchDayNudgeMessages(day.comp.id, "schedule", now);
    expect(out.map((m) => m.topic).sort()).toEqual(topicsFor([a, b]));
  });

  it("a withdrawn, an expired and a not-yet-open code are excluded; the open one beside them is not", async () => {
    const day = await quietDay();
    const now = new Date();
    const open = await openCode(day, now);
    await code(day, { opens: new Date(now.getTime() - HOUR), expires: new Date(now.getTime() + HOUR), revoked: true });
    await code(day, { opens: new Date(now.getTime() - 3 * HOUR), expires: new Date(now.getTime() - HOUR) });
    await code(day, { opens: new Date(now.getTime() + HOUR), expires: new Date(now.getTime() + 3 * HOUR) });
    const out = await matchDayNudgeMessages(day.comp.id, "score", now);
    expect(out.map((m) => m.topic), "anti-vacuity: the open code is there, the three others are not").toEqual([`match-day:${open}`]);
  });

  it("the window's edges: opens exactly now is open; expires exactly now is not", async () => {
    const day = await quietDay();
    const now = new Date();
    const justOpened = await code(day, { opens: now, expires: new Date(now.getTime() + HOUR) });
    await code(day, { opens: new Date(now.getTime() - HOUR), expires: now });
    expect((await matchDayNudgeMessages(day.comp.id, "score", now)).map((m) => m.topic)).toEqual([`match-day:${justOpened}`]);
  });

  it("another competition's code is excluded, and two competitions never share a memo entry", async () => {
    const a = await quietDay();
    const b = await quietDay();
    const now = new Date();
    const codeA = await openCode(a, now);
    const codeB = await openCode(b, now);
    // Both inside one memo window, A first: a memo keyed on anything but the competition would hand B the codes of A.
    expect((await matchDayNudgeMessages(a.comp.id, "score", now)).map((m) => m.topic)).toEqual([`match-day:${codeA}`]);
    expect((await matchDayNudgeMessages(b.comp.id, "score", new Date(now.getTime() + 1_000))).map((m) => m.topic)).toEqual([`match-day:${codeB}`]);
    expect(probe.reads, "one read per competition").toBe(2);
    expect((await matchDayNudgeMessages(a.comp.id, "score", new Date(now.getTime() + 2_000))).map((m) => m.topic), "A is still A's").toEqual([`match-day:${codeA}`]);
    expect(probe.reads, "A's second call was the memo's").toBe(2);
  });

  it("the memo: a code minted inside 15 s is not seen at 14.999 s, and is at 15 s (a second read)", async () => {
    expect(MATCH_DAY_MEMO_MS, "the brief's 15 s, written here").toBe(15_000);
    const day = await quietDay();
    const t0 = new Date();
    expect(await matchDayNudgeMessages(day.comp.id, "score", t0)).toEqual([]);
    const late = await openCode(day, t0);
    expect(await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 14_999)), "inside the window").toEqual([]);
    expect(probe.reads, "still the one read").toBe(1);
    const out = await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 15_000));
    expect(out.map((m) => m.topic), "at 15 s the memo has lapsed").toEqual([`match-day:${late}`]);
    expect(probe.reads).toBe(2);
  });

  it("a code WITHDRAWN inside the window is nudged once more (accepted staleness); after the window it is not", async () => {
    const day = await quietDay();
    const t0 = new Date();
    const id = await openCode(day, t0);
    expect((await matchDayNudgeMessages(day.comp.id, "score", t0)).map((m) => m.topic)).toEqual([`match-day:${id}`]);
    await sql`update match_day_codes set revoked_at = now() where id = ${id}`;
    expect(
      (await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 5_000))).map((m) => m.topic),
      "inside the window the memo still names it: at most one more nudge, which carries no data",
    ).toEqual([`match-day:${id}`]);
    expect(await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 15_000)), "after the window it is gone").toEqual([]);
  });

  it("a code that EXPIRES inside the window is dropped at once, without a second read", async () => {
    const day = await quietDay();
    const t0 = new Date();
    const id = await code(day, { opens: new Date(t0.getTime() - HOUR), expires: new Date(t0.getTime() + 5_000) });
    expect((await matchDayNudgeMessages(day.comp.id, "score", t0)).map((m) => m.topic)).toEqual([`match-day:${id}`]);
    expect(await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 5_000)), "expires exactly then: not open").toEqual([]);
    expect(probe.reads, "the memo answered").toBe(1);
  });

  it("a clock that went backwards is a miss, not a hit", async () => {
    const day = await quietDay();
    const t0 = new Date();
    await matchDayNudgeMessages(day.comp.id, "score", new Date(t0.getTime() + 60_000));
    await matchDayNudgeMessages(day.comp.id, "score", t0);
    expect(probe.reads).toBe(2);
  });

  it("a failed read: [] and ONE warn naming the error class only — then the next call reads again (a failure is not remembered)", async () => {
    const day = await quietDay();
    const now = new Date();
    const id = await openCode(day, now);
    probe.fail = true;
    expect(await matchDayNudgeMessages(day.comp.id, "score", now)).toEqual([]);
    const lines = warn.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    expect(lines.filter((l: string) => l.includes("the open codes could not be read")), "anti-vacuity: one warn for the failure").toHaveLength(1);
    for (const l of lines) {
      expect(l, "no code id, no competition id and no error message in a log line").not.toContain(id);
      expect(l).not.toContain(day.comp.id);
      expect(l).not.toContain("secret-detail-7731");
    }
    probe.fail = false;
    expect((await matchDayNudgeMessages(day.comp.id, "score", new Date(now.getTime() + 1))).map((m) => m.topic)).toEqual([`match-day:${id}`]);
  });

  it("a blank code id is dropped by the topic guard (never `match-day:`), the others still go", () => {
    const good = randomUUID();
    const out = codeMessages(["", "   ", good], "score");
    expect(out.map((m) => m.topic), "anti-vacuity: the good one went, the blanks did not").toEqual([`match-day:${good}`]);
    expect(warn.mock.calls.filter((c: unknown[]) => JSON.stringify(c).includes("blank code id")), "one warn per dropped id").toHaveLength(2);
    expect(() => matchDayTopic(" "), "the guard under it").toThrow();
    expect(nudgeMessage(matchDayTopic(good), "call").topic).toBe(`match-day:${good}`);
  });
});

describe("matchDayNudgesFor: the gate and the bound (no database needed)", () => {
  it("a non-uuid competition: [] with no read and no timer", async () => {
    vi.useFakeTimers();
    expect(await matchDayNudgesFor("comp-batch", "score")).toEqual([]);
    expect(vi.getTimerCount(), "no bound timer armed").toBe(0);
    expect(probe.reads).toBe(0);
  });

  it("publishing off (REALTIME_PUBLISH=off, any case): [] with no read and no timer", async () => {
    vi.useFakeTimers();
    vi.stubEnv("REALTIME_PUBLISH", " Off ");
    expect(await matchDayNudgesFor(randomUUID(), "score")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(probe.reads).toBe(0);
  });

  it("no Supabase project: [] with no read", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(await matchDayNudgesFor(randomUUID(), "score")).toEqual([]);
    expect(probe.reads).toBe(0);
  });

  it("a read that never answers is abandoned at the bound: [] at 750 ms, not before, and no timer is left", async () => {
    expect(MATCH_DAY_NUDGE_READ_BOUND_MS, "half of the DEL's 1500 ms bound").toBe(750);
    vi.useFakeTimers();
    probe.hang = true;
    let out: unknown[] | null = null;
    void matchDayNudgesFor(randomUUID(), "score").then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(749);
    expect(out, "not before the bound").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual([]);
    expect(probe.reads, "anti-vacuity: the read was started").toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("a schedule write nudges the open codes inside its ONE POST", () => {
  let day: Day;
  let fx: string[];

  /** Setup publishes on its own: let that land and forget it (memo included), so the test judges only its write. */
  const quiesce = async (): Promise<void> => {
    await settled();
    fetchSpy.mockClear();
    resetMatchDayMemo();
    probe.reads = 0;
  };
  const write = async (opts?: { fixturePushes?: boolean; reason?: "call" }, ids: readonly string[] = [fx[0]!]): Promise<WireMessage[][]> => {
    afterScheduleWrite(day.comp.divisionId, day.comp.id, "schedule", ids, opts);
    await settled();
    return posts();
  };

  beforeEach(async () => {
    day = await quietDay();
    fx = day.comp.fixtures.map((f) => f.id);
  });

  it("two open codes: ONE POST carrying the division, the fixture and a `schedule` nudge for each code", async () => {
    const now = new Date();
    const a = await openCode(day, now);
    const b = await openCode(day, now);
    await quiesce();
    const all = await write();
    expect(all, "ONE POST for the write and both nudges").toHaveLength(1);
    expect(restOf(all[0]!)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    expect(topicsOf(all[0]!), "anti-vacuity: both codes").toEqual(topicsFor([a, b]));
    expect(mdOf(all[0]!).map((m) => m.payload.reason)).toEqual(["schedule", "schedule"]);
    expect(mdOf(all[0]!).every((m) => m.event === "nudge" && m.private === true)).toBe(true);
  });

  it("zero open codes: the batch is exactly what it was before (no Match Day topic), still ONE POST", async () => {
    await quiesce();
    const all = await write();
    expect(all).toHaveLength(1);
    expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    expect(probe.reads, "anti-vacuity: the codes were read and there were none").toBe(1);
  });

  it("a withdrawn, an expired and a not-yet-open code are not in the batch; the open one is", async () => {
    const now = new Date();
    const open = await openCode(day, now);
    await code(day, { opens: new Date(now.getTime() - HOUR), expires: new Date(now.getTime() + HOUR), revoked: true });
    await code(day, { opens: new Date(now.getTime() - 3 * HOUR), expires: new Date(now.getTime() - HOUR) });
    await code(day, { opens: new Date(now.getTime() + HOUR), expires: new Date(now.getTime() + 3 * HOUR) });
    await quiesce();
    const all = await write();
    expect(all).toHaveLength(1);
    expect(topicsOf(all[0]!)).toEqual(topicsFor([open]));
  });

  it("a second write inside 15 s: a second POST of its own, again with the nudge, from the memo (one read in all)", async () => {
    const id = await openCode(day, new Date());
    await quiesce();
    const first = await write();
    expect(first).toHaveLength(1);
    fetchSpy.mockClear();
    const second = await write({}, [fx[1]!]);
    expect(second, "ONE POST for the second write").toHaveLength(1);
    expect(restOf(second[0]!)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `fixture:${fx[1]}`]);
    expect(topicsOf(second[0]!)).toEqual(topicsFor([id]));
    expect(probe.reads, "the second write's codes came from the memo").toBe(1);
  });

  it("two competitions in turn: each write carries only its own competition's codes", async () => {
    const other = await quietDay();
    const now = new Date();
    const mine = await openCode(day, now);
    const theirs = await openCode(other, now);
    await quiesce();
    const a = await write();
    expect(topicsOf(a[0]!)).toEqual(topicsFor([mine]));
    fetchSpy.mockClear();
    afterScheduleWrite(other.comp.divisionId, other.comp.id, "schedule", [other.comp.fixtures[0]!.id]);
    await settled();
    const b = posts();
    expect(b, "ONE POST").toHaveLength(1);
    expect(topicsOf(b[0]!), "the other competition's own code, never the first's from the memo").toEqual(topicsFor([theirs]));
  });

  it("the reason `call` rides on the nudges only: the division and fixture messages keep their own", async () => {
    await openCode(day, new Date());
    await quiesce();
    const all = await write({ reason: "call" });
    expect(all).toHaveLength(1);
    expect(mdOf(all[0]!).map((m) => m.payload.reason)).toEqual(["call"]);
    const rest = all[0]!.filter((m) => !m.topic.startsWith("match-day:"));
    expect(rest.map((m) => m.payload.reason), "division schedule (public and twin) + fixture schedule").toEqual(["schedule", "schedule", "schedule"]);
  });

  it("past the 50-fixture cap the write still nudges the day (one message per code, never per fixture)", async () => {
    const id = await openCode(day, new Date());
    await quiesce();
    const ids = Array.from({ length: 51 }, () => randomUUID());
    const all = await write({}, ids);
    expect(all).toHaveLength(1);
    expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `match-day:${id}`]);
  });

  it("`fixturePushes: false` (a quick match's create): no Match Day message and NO read", async () => {
    await openCode(day, new Date());
    await quiesce();
    const all = await write({ fixturePushes: false });
    expect(all).toHaveLength(1);
    expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`]);
    expect(probe.reads).toBe(0);
  });

  it("the empty case, a write that moved no fixture, still nudges the day", async () => {
    const id = await openCode(day, new Date());
    await quiesce();
    const all = await write({}, []);
    expect(all).toHaveLength(1);
    expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `match-day:${id}`]);
  });

  it("publishing off: nothing is sent and the codes are not even read", async () => {
    await openCode(day, new Date());
    await quiesce();
    vi.stubEnv("REALTIME_PUBLISH", "off");
    const all = await write();
    expect(all).toEqual([]);
    expect(probe.reads).toBe(0);
  });

  it("a read that throws: the division and fixture messages are still sent, in the one POST, and one warn names the class only", async () => {
    const id = await openCode(day, new Date());
    await quiesce();
    probe.fail = true;
    const all = await write();
    expect(all, "the batch is not lost").toHaveLength(1);
    expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    expect(probe.reads, "anti-vacuity: the read was attempted").toBe(1);
    for (const c of warn.mock.calls) {
      const line = JSON.stringify(c);
      expect(line).not.toContain(id);
      expect(line).not.toContain("secret-detail-7731");
    }
  });

  it("a read that never answers: the push goes at the bound without the nudges, still one POST", async () => {
    await openCode(day, new Date());
    await quiesce();
    probe.hang = true;
    const started = Date.now();
    afterScheduleWrite(day.comp.divisionId, day.comp.id, "schedule", [fx[0]!]);
    await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0), { timeout: 2_000 });
    await Promise.race([nudgesSettled(), sleep(2_000)]);
    expect(Date.now() - started, "not before the bound").toBeGreaterThanOrEqual(MATCH_DAY_NUDGE_READ_BOUND_MS - 50);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
  });

  it("after a withdrawal: inside the memo window one more nudge (no data), after it none — the sequence through real writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await openCode(day, new Date());
    await quiesce();
    expect(topicsOf((await write())[0]!), "before the withdrawal").toEqual(topicsFor([id]));
    await sql`update match_day_codes set revoked_at = now() where id = ${id}`;
    vi.setSystemTime(Date.now() + 5_000);
    fetchSpy.mockClear();
    const inside = await write();
    expect(inside).toHaveLength(1);
    expect(topicsOf(inside[0]!), "inside the window: the memo's one more nudge").toEqual(topicsFor([id]));
    vi.setSystemTime(Date.now() + MATCH_DAY_MEMO_MS);
    fetchSpy.mockClear();
    const after = await write();
    expect(after).toHaveLength(1);
    expect(mdOf(after[0]!), "after the window: nothing").toEqual([]);
  });

  it("this instance's mint and revoke end the memo window: the next write nudges a code minted inside it, and not one just revoked", async () => {
    vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
    vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");
    await quiesce();
    const empty = await write();
    expect(mdOf(empty[0]!), "premise: no code yet, and that emptiness is now memoised").toEqual([]);
    expect(probe.reads).toBe(1);
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    fetchSpy.mockClear();
    const minted = await write({}, [fx[1]!]);
    expect(topicsOf(minted[0]!), "minted inside the 15 s window, nudged by the very next write").toEqual(topicsFor([row.id]));
    expect(probe.reads, "the mint ended the window: a second read").toBe(2);
    await revokeMatchDayCode(day.auth, row.id);
    fetchSpy.mockClear();
    const revoked = await write({}, [fx[2]!]);
    expect(revoked, "ONE POST").toHaveLength(1);
    expect(mdOf(revoked[0]!), "the revoke ended the window: the withdrawn code is not nudged").toEqual([]);
    expect(probe.reads).toBe(3);
  });

  it("real writers: a move sends `schedule`, a match called to a court and its undo send `call` — one POST each", async () => {
    const id = await openCode(day, new Date());
    await quiesce();
    await moveFixture(day.auth, fx[0]!, { scheduled_at: "2026-11-07T12:00:00.000Z", court_id: day.courts.c1 });
    await settled();
    const moved = posts();
    expect(moved, "the move: ONE POST").toHaveLength(1);
    expect(mdOf(moved[0]!).map((m) => [m.topic, m.payload.reason])).toEqual([[`match-day:${id}`, "schedule"]]);

    fetchSpy.mockClear();
    await callFixtureToCourt(day.auth, fx[0]!, day.courts.c3, new Date());
    await settled();
    const called = posts();
    expect(called, "the call: ONE POST").toHaveLength(1);
    expect(mdOf(called[0]!).map((m) => [m.topic, m.payload.reason])).toEqual([[`match-day:${id}`, "call"]]);

    fetchSpy.mockClear();
    await undoCall(day.auth, fx[0]!);
    await settled();
    const undone = posts();
    expect(undone, "the undo: ONE POST").toHaveLength(1);
    expect(mdOf(undone[0]!).map((m) => [m.topic, m.payload.reason])).toEqual([[`match-day:${id}`, "call"]]);
  });
});

describe.skipIf(!HAS_DB)("a score and a void nudge the open codes inside their ONE POST", () => {
  it("score: the fixture, its division and a `score` nudge per open code in ONE POST; zero codes leaves the pair; a second score is its own POST", async () => {
    const day = await quietDay();
    await startDivision(day.auth, day.comp.divisionId);
    const f = day.comp.fixtures[0]!.id;
    await settled();
    resetMatchDayMemo();
    // Zero open codes first: the batch is the old pair.
    fetchSpy.mockClear();
    await scoreEvent(day.auth, f, { expected_seq: 0, type: "core.start", payload: {} });
    await settled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.map((m) => m.topic)).toEqual([`fixture:${f}`, `division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`]);
    // Two codes, past the memo window (the first read said "none").
    const now = new Date();
    const a = await openCode(day, now);
    const b = await openCode(day, now);
    resetMatchDayMemo();
    fetchSpy.mockClear();
    await scoreEvent(day.auth, f, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    await settled();
    const sent = posts();
    expect(sent, "ONE POST for the score").toHaveLength(1);
    expect(restOf(sent[0]!).slice(0, 3)).toEqual([`fixture:${f}`, `division:${day.comp.divisionId}`, `division:${day.comp.divisionId}`]);
    expect(topicsOf(sent[0]!), "anti-vacuity: both codes").toEqual(topicsFor([a, b]));
    expect(mdOf(sent[0]!).map((m) => m.payload.reason)).toEqual(["score", "score"]);
    // A second score on another fixture: its own POST, from the memo.
    fetchSpy.mockClear();
    const reads = probe.reads;
    const g = day.comp.fixtures[1]!.id;
    await scoreEvent(day.auth, g, { expected_seq: 0, type: "core.start", payload: {} });
    await settled();
    expect(posts()).toHaveLength(1);
    expect(topicsOf(posts()[0]!)).toEqual(topicsFor([a, b]));
    expect(probe.reads, "the second score read nothing").toBe(reads);
  }, 120_000);

  it("a score on a competition with no code, and with publishing off: nothing read", async () => {
    const day = await quietDay();
    await startDivision(day.auth, day.comp.divisionId);
    await settled();
    fetchSpy.mockClear();
    resetMatchDayMemo();
    probe.reads = 0;
    vi.stubEnv("REALTIME_PUBLISH", "off");
    await scoreEvent(day.auth, day.comp.fixtures[0]!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await settled();
    expect(posts()).toEqual([]);
    expect(probe.reads).toBe(0);
  }, 120_000);

  const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;

  it("void-lines: N voided lines, their division and the open codes in ONE POST (was 1 + N); zero codes leaves the 3-message batch", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31", name: "T10 " + randomUUID().slice(0, 6), visibility: "private", branding: {},
    });
    const d = await createDivision(auth, comp.id, {
      name: "Open", slug: "t10-" + randomUUID().slice(0, 6), sport_key: "badminton",
      variant_key: Object.keys(moduleOf("badminton").variants)[0]!, config: {},
    });
    const es = await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [],
    })) as never);
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await startDivision(auth, d.id);
    await withdrawEntrantCascade(auth, es[0]!.id);
    const abandons = await sql<{ fixture_id: string; id: string }[]>`
      select e.fixture_id, e.id from score_events e join fixtures f on f.id = e.fixture_id
      where f.stage_id = ${stage!.id} and e.type = 'core.abandon' order by e.fixture_id`;
    expect(abandons.length, "premise: the expunge abandoned every line of hers (n - 1 = 3)").toBe(3);
    const lines = (from: number, to: number) => abandons.slice(from, to).map((a) => ({ fixtureId: a.fixture_id, eventId: a.id }));
    const day = { auth, orgId: auth.orgId, comp: { id: comp.id } } as unknown as Day;
    await settled();
    resetMatchDayMemo();

    // Zero open codes: 2 lines + the division's two (public and twin) = ONE POST of 4 messages.
    fetchSpy.mockClear();
    const written = await voidLineEvents(auth, d.id, lines(0, 2), { writer: "withdrawal_cascade" });
    expect(written.sort(), "anti-vacuity: both voids were written").toEqual(abandons.slice(0, 2).map((a) => a.fixture_id).sort());
    await settled();
    expect(posts(), "ONE POST (was 3)").toHaveLength(1);
    expect(posts()[0]!.map((m) => m.topic).sort()).toEqual(
      [`division:${d.id}`, `division:${d.id}`, ...abandons.slice(0, 2).map((a) => `fixture:${a.fixture_id}`)].sort(),
    );

    // Two open codes (past the memo window): the same ONE POST plus a `score` nudge each.
    const now = new Date();
    const a = await openCode(day, now, comp.id);
    const b = await openCode(day, now, comp.id);
    resetMatchDayMemo();
    fetchSpy.mockClear();
    const third = await voidLineEvents(auth, d.id, lines(2, 3), { writer: "withdrawal_cascade" });
    expect(third, "anti-vacuity: the third void was written").toEqual([abandons[2]!.fixture_id]);
    await settled();
    const sent = posts();
    expect(sent, "ONE POST with the nudges").toHaveLength(1);
    expect(restOf(sent[0]!).sort()).toEqual([`division:${d.id}`, `division:${d.id}`, `fixture:${abandons[2]!.fixture_id}`].sort());
    expect(topicsOf(sent[0]!)).toEqual(topicsFor([a, b]));
    expect(mdOf(sent[0]!).map((m) => m.payload.reason)).toEqual(["score", "score"]);
  }, 120_000);
});
