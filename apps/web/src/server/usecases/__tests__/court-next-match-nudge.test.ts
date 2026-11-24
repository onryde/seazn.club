// Realtime push-nudges Task 7 (T1.5, spec 2026-11-24 §2.3 last row) — when a schedule write moves fixtures onto a court, the
// court's camera phone (the court code's open slot-0 pairing) gets a private `nudge` `next-match` on `capture:{pairingId}` and
// re-beats at once. The nudge rides in the SAME broadcast as the division and fixture messages: still exactly ONE POST per write.
//
// Driven through the REAL `afterScheduleWrite` with the REAL `broadcast` (`@/lib/realtime` is not mocked: `fetch` is a spy, the
// Supabase env is stubbed) over a real court link, code and pairing in Postgres. Only the court-nudge READ is wrapped (a spy
// that calls through) so a test can see that it ran, or did not, and make it fail or hang.
//
// The rules, typed from the brief and the spec, never from the code under test:
//   - a court nudge goes to a court's OPEN slot-0 pairing when the link is not withdrawn, is open now (`opens_at <= now <
//     expires_at`), belongs to the fixture's competition, and its code is not ended; each distinct pairing gets ONE message,
//     whatever number of the write's fixtures sit on that court;
//   - no link, a withdrawn link, a link of another day (past or future), an ended code, a court with no open pairing (none, an
//     ended one, only a slot-1 one), a link of ANOTHER competition on the same court, a fixture with no court: no nudge;
//   - past SCHEDULE_FIXTURE_PUSH_CAP (50), `fixturePushes: false` or an empty fixture set: no nudge and NO read;
//   - best-effort: a read that rejects, or never answers, never costs the write its division and fixture messages;
//   - a fixture's OWN code (not a court's) never receives a `next-match`;
//   - REALTIME_PUBLISH=off sends nothing.
//
// Applies to another sport: N/A (no sport rules) — the court link is the other surface; the fixtures here are generic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
// The court-nudge read, wrapped: a call-through spy by default.
vi.mock("../stream-sessions/nudge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stream-sessions/nudge")>();
  return { ...actual, courtPairingNudges: vi.fn(actual.courtPairingNudges) };
});
// A passthrough that counts the statements that read a court link: "no read" is a count of zero, never an inference.
const probe = vi.hoisted(() => ({ courtReads: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const counted = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (Array.isArray(strings) && "raw" in strings && strings.join("").includes("court_stream_links")) probe.courtReads += 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { ...actual, sql: counted };
});
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { SCHEDULE_FIXTURE_PUSH_CAP, afterScheduleWrite } from "../schedule";
import { linkCourtStream } from "../court-streams";
import { ensureStreamCode } from "../stream-codes";
import { courtPairingNudges, nudgesSettled } from "../stream-sessions/nudge";
import { pairPresentPhone, rigApiTarget } from "@/server/relay/__tests__/_session-rig";
import { place, seedCompetition, seedDay, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE = "https://rtn-court.example.supabase.co";
const BROADCAST_URL = `${SUPABASE}/realtime/v1/api/broadcast`;
const COURT_BUILD = "1.0.14-1200";
const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "COURT_MIN_APP_VERSION"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

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
const nudgesOf = (post: WireMessage[]): WireMessage[] => post.filter((m) => m.topic.startsWith("capture:"));
const topicsOf = (post: WireMessage[]): string[] => nudgesOf(post).map((m) => m.topic).sort();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits for the write's one POST (the DEL settles at once), then for every fire-and-forget nudge task. */
async function sent(): Promise<WireMessage[][]> {
  await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0), { timeout: 5_000 });
  await nudgesSettled();
  await sleep(20);
  return posts();
}

beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "court-next-match-nudge-secret";
  process.env.COURT_MIN_APP_VERSION = COURT_BUILD;
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.mocked(courtPairingNudges).mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("REALTIME_PUBLISH", undefined);
});
afterEach(async () => {
  await nudgesSettled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a schedule write nudges the court's phone `next-match`, inside its one POST", () => {
  let day: Day;
  let fx: string[];
  let api: { targetId: string };

  /** A live court link for today on `courtId`, its court code, and (unless `pairing: false`) one open slot-0 pairing. */
  async function courtWithPhone(courtId: string, opts: { pairing?: boolean } = {}): Promise<{ linkId: string; codeId: string; pairingId: string | null }> {
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId, targetId: api.targetId }, new Date());
    const [row] = await sql<{ link_id: string; code_id: string }[]>`
      select l.id as link_id, c.id as code_id
        from court_stream_links l join fixture_stream_codes c on c.court_link_id = l.id and c.ended_at is null
       where l.court_id = ${courtId} and l.withdrawn_at is null`;
    if (!row || !shown.qr) throw new Error("the court link or its code was not minted");
    const pairingId = opts.pairing === false ? null : await pairing(row.code_id, 0);
    return { linkId: row.link_id, codeId: row.code_id, pairingId };
  }
  async function pairing(codeId: string, slot: number, ended = false): Promise<string> {
    const [p] = await sql<{ id: string }[]>`
      insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds,
                                           ended_at, end_cause)
      values (${day.orgId}, ${codeId}, ${slot}, ${`phone-${randomUUID()}`}, 'new', now(), now(), 60,
              ${ended ? sql`now()` : null}, ${ended ? "code_ended" : null}) returning id`;
    return p!.id;
  }
  /** Setup (seeding, linking a court) publishes on its own: let that land and forget it, so the test judges only its write. */
  const quiesce = async (): Promise<void> => {
    await sleep(150);
    await nudgesSettled();
    fetchSpy.mockClear();
    vi.mocked(courtPairingNudges).mockClear();
  };
  const write = async (ids: readonly string[], opts?: { fixturePushes?: boolean }): Promise<void> => {
    if (!vi.isFakeTimers()) await quiesce();
    afterScheduleWrite(day.comp.divisionId, day.comp.id, "schedule", ids, opts);
  };

  beforeEach(async () => {
    day = await seedDay();
    fx = day.comp.fixtures.map((f) => f.id);
    api = await rigApiTarget(day.orgId, "Club channel");
  });

  it("a move onto a court with a live link: the court's pairing is nudged `next-match` in the SAME single POST", async () => {
    await place(day, fx[0]!, 0, day.courts.c2);
    const c2 = await courtWithPhone(day.courts.c2);
    await write([fx[0]!]);
    const all = await sent();
    expect(all, "ONE POST for the division, the fixture and the court nudge").toHaveLength(1);
    const post = all[0]!;
    expect(post.map((m) => m.topic).filter((t) => !t.startsWith("capture:"))).toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    expect(nudgesOf(post), "anti-vacuity: exactly the one court nudge").toHaveLength(1);
    const nudge = nudgesOf(post)[0]!;
    expect(nudge.topic).toBe(`capture:${c2.pairingId}`);
    expect(nudge.event).toBe("nudge");
    expect(nudge.private, "a capture topic is private").toBe(true);
    expect(nudge.payload.reason).toBe("next-match");
    expect(Object.keys(nudge.payload).sort(), "a nudge carries a reason and a time, never state").toEqual(["at", "reason", "v"]);
  });

  it("two moved fixtures on ONE court: one nudge, not two", async () => {
    await place(day, fx[0]!, 0, day.courts.c2);
    await place(day, fx[1]!, 30, day.courts.c2);
    const c2 = await courtWithPhone(day.courts.c2);
    await write([fx[0]!, fx[1]!]);
    const all = await sent();
    expect(all).toHaveLength(1);
    expect(topicsOf(all[0]!)).toEqual([`capture:${c2.pairingId}`]);
    expect(all[0]!.filter((m) => m.topic.startsWith("fixture:")), "both fixtures still get their own push").toHaveLength(2);
  });

  it("two courts in one write: one nudge each, in the same single POST", async () => {
    await place(day, fx[0]!, 0, day.courts.c2);
    await place(day, fx[1]!, 0, day.courts.c3);
    const c2 = await courtWithPhone(day.courts.c2);
    const c3 = await courtWithPhone(day.courts.c3);
    await write([fx[0]!, fx[1]!]);
    const all = await sent();
    expect(all).toHaveLength(1);
    expect(c2.pairingId).not.toBe(c3.pairingId);
    expect(topicsOf(all[0]!)).toEqual([`capture:${c2.pairingId}`, `capture:${c3.pairingId}`].sort());
  });

  it("only the courts the write touched are nudged: a linked court whose fixtures did not move hears nothing", async () => {
    await place(day, fx[0]!, 0, day.courts.c2);
    await place(day, fx[1]!, 0, day.courts.c3);
    const c2 = await courtWithPhone(day.courts.c2);
    await courtWithPhone(day.courts.c3);
    await write([fx[0]!]);
    const all = await sent();
    expect(topicsOf(all[0]!)).toEqual([`capture:${c2.pairingId}`]);
  });

  it("a second write nudges again in a POST of its own; a write whose fixture sits on no court nudges nothing", async () => {
    await place(day, fx[0]!, 0, day.courts.c2);
    const c2 = await courtWithPhone(day.courts.c2);
    await write([fx[0]!]);
    expect(topicsOf((await sent())[0]!), "the first write's nudge").toEqual([`capture:${c2.pairingId}`]);
    await write([fx[0]!]);   // the same fixture, the same court: nothing changed, and the phone is nudged again in the write's own POST
    const second = await sent();
    expect(second, "a POST of its own, never merged into the first").toHaveLength(1);
    expect(topicsOf(second[0]!), "the second write's POST carries its own nudge").toEqual([`capture:${c2.pairingId}`]);

    await place(day, fx[2]!, 60, null);
    await write([fx[2]!]);
    const third = await sent();
    expect(third, "PREMISE: the third write's own POST").toHaveLength(1);
    expect(third[0]!.map((m) => m.topic), "a fixture with no court has no court to nudge").toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[2]}`]);
  });

  describe("no nudge, still the one POST with the division and fixture messages", () => {
    /** The write moves `fx[0]` on `c2`, whose state the case has arranged; the POST must hold the 2 non-capture messages only. */
    async function expectNone(): Promise<void> {
      await write([fx[0]!]);
      const all = await sent();
      expect(all, "the write's POST still goes").toHaveLength(1);
      expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    }
    beforeEach(async () => { await place(day, fx[0]!, 0, day.courts.c2); });

    it("the court has no link", async () => { await expectNone(); });

    it("the link is withdrawn (its code left open, so only the link's own flag can refuse)", async () => {
      const c2 = await courtWithPhone(day.courts.c2);
      await sql`update court_stream_links set withdrawn_at = now(), withdrawn_by = ${day.auth.userId} where id = ${c2.linkId}`;
      expect((await sql`select 1 from fixture_stream_codes where id = ${c2.codeId} and ended_at is null`).length, "PREMISE: code still open").toBe(1);
      await expectNone();
    });

    it("the link's day is over (it expired an hour ago)", async () => {
      const c2 = await courtWithPhone(day.courts.c2);
      await sql`update court_stream_links set opens_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = ${c2.linkId}`;
      await expectNone();
    });

    it("the link's day has not opened (it opens in an hour)", async () => {
      const c2 = await courtWithPhone(day.courts.c2);
      await sql`update court_stream_links set opens_at = now() + interval '1 hour', expires_at = now() + interval '25 hours' where id = ${c2.linkId}`;
      await expectNone();
    });

    it("the court's code has ended (the link left live, so only the code's own flag can refuse)", async () => {
      const c2 = await courtWithPhone(day.courts.c2);
      await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'expired', tok_enc = null where id = ${c2.codeId}`;
      await expectNone();
    });

    it("the court has a link and a code but no pairing", async () => {
      await courtWithPhone(day.courts.c2, { pairing: false });
      await expectNone();
    });

    it("the court's slot-0 pairing has ended", async () => {
      const c2 = await courtWithPhone(day.courts.c2, { pairing: false });
      await pairing(c2.codeId, 0, true);
      await expectNone();
    });

    it("the court has an open pairing in slot 1 only: slot 0 is the phone", async () => {
      const c2 = await courtWithPhone(day.courts.c2, { pairing: false });
      await pairing(c2.codeId, 1);
      await expectNone();
    });

    it("another competition's link on the same court: this fixture's competition has none", async () => {
      await courtWithPhone(day.courts.c2);
      const other = await seedCompetition(day.auth, "Other Open", [[day.people[0]!, day.people[1]!], [day.people[2]!, day.people[3]!]], { courts: [day.courts.c2] });
      const otherFx = other.fixtures[0]!.id;
      await place(day, otherFx, 0, day.courts.c2);
      await sleep(150);
      await nudgesSettled();
      fetchSpy.mockClear();
      afterScheduleWrite(other.divisionId, other.id, "schedule", [otherFx]);
      const all = await sent();
      expect(all).toHaveLength(1);
      expect(all[0]!.map((m) => m.topic)).toEqual([`division:${other.divisionId}`, `fixture:${otherFx}`]);
    });

    it("another surface: a fixture's OWN code and phone (not a court's) never gets a next-match", async () => {
      await ensureStreamCode(day.auth, fx[0]!);
      const own = await pairPresentPhone(fx[0]!);
      expect(own.pairingId, "PREMISE: the fixture's own pairing exists").toBeTruthy();
      await expectNone();
    });
  });

  describe("when the court read is not made", () => {
    beforeEach(async () => {
      await place(day, fx[0]!, 0, day.courts.c2);
      await courtWithPhone(day.courts.c2);
    });

    it("past the push cap: no nudge and NO read", async () => {
      const ids = [fx[0]!, ...Array.from({ length: SCHEDULE_FIXTURE_PUSH_CAP }, () => randomUUID())];
      expect(ids, "PREMISE: one past the owner's cap of 50").toHaveLength(51);
      await write(ids);
      const all = await sent();
      expect(all).toHaveLength(1);
      expect(all[0]!.map((m) => m.topic), "the division message only").toEqual([`division:${day.comp.divisionId}`]);
      expect(courtPairingNudges).not.toHaveBeenCalled();
    });

    it("exactly at the cap the court IS nudged (the boundary is in, not out)", async () => {
      const ids = [fx[0]!, ...Array.from({ length: SCHEDULE_FIXTURE_PUSH_CAP - 1 }, () => randomUUID())];
      expect(ids).toHaveLength(50);
      await write(ids);
      const all = await sent();
      expect(all).toHaveLength(1);
      expect(nudgesOf(all[0]!)).toHaveLength(1);
      expect(courtPairingNudges).toHaveBeenCalledTimes(1);
    });

    it("`fixturePushes: false` (a quick match's create): no nudge and no read", async () => {
      await write([fx[0]!], { fixturePushes: false });
      const all = await sent();
      expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`]);
      expect(courtPairingNudges).not.toHaveBeenCalled();
    });

    it("an empty fixture set: the division message only, and no read", async () => {
      await write([]);
      const all = await sent();
      expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`]);
      expect(courtPairingNudges).not.toHaveBeenCalled();
    });
  });

  describe("best-effort: the nudge never fails or slows the write's own messages", () => {
    beforeEach(async () => {
      await place(day, fx[0]!, 0, day.courts.c2);
      await courtWithPhone(day.courts.c2);
    });

    it("a read that rejects: the division and fixture messages are still sent, and nothing is unhandled", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        vi.mocked(courtPairingNudges).mockRejectedValueOnce(new Error("pool exhausted"));
        await write([fx[0]!]);
        const all = await sent();
        expect(all).toHaveLength(1);
        expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
        await sleep(30);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("a read that throws synchronously: the same", async () => {
      vi.mocked(courtPairingNudges).mockImplementationOnce(() => { throw new Error("boom"); });
      await write([fx[0]!]);
      const all = await sent();
      expect(all[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    });

    it("a read that never answers: the POST goes out at the bound, with no nudge", async () => {
      await quiesce();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(courtPairingNudges).mockImplementationOnce(() => new Promise<never>(() => {}));
      await write([fx[0]!]);
      await vi.advanceTimersByTimeAsync(10);
      expect(posts(), "nothing sent while the read is pending, inside the bound").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(3_100);
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.map((m) => m.topic)).toEqual([`division:${day.comp.divisionId}`, `fixture:${fx[0]}`]);
    });

    it("a push that cannot even be built (a blank division id: its topic builder throws) is warned and swallowed, never unhandled", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const warn = vi.spyOn(log, "warn");
      try {
        await quiesce();
        afterScheduleWrite("  ", day.comp.id, "schedule", [fx[0]!]);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
        await nudgesSettled();
        await sleep(50);
        expect(unhandled).not.toHaveBeenCalled();
        expect(posts(), "nothing is half-sent").toEqual([]);
        expect(JSON.stringify(warn.mock.calls), "the warn names the error class, never a message").toContain("Error");
      } finally {
        process.off("unhandledRejection", unhandled);
        warn.mockRestore();
      }
    });

    it("REALTIME_PUBLISH=off: nothing is sent at all", async () => {
      vi.stubEnv("REALTIME_PUBLISH", "Off");
      await write([fx[0]!]);
      await sleep(300);
      await nudgesSettled();
      expect(posts()).toEqual([]);
    });
  });
});

describe.skipIf(!HAS_DB)("courtPairingNudges itself", () => {
  it("a non-uuid id, or no ids, reads nothing and answers []: it never throws", async () => {
    const actual = await vi.importActual<typeof import("../stream-sessions/nudge")>("../stream-sessions/nudge");
    const warn = vi.spyOn(log, "warn");
    probe.courtReads = 0;
    expect(await actual.courtPairingNudges([])).toEqual([]);
    expect(await actual.courtPairingNudges(["fx-0", "not-a-uuid"])).toEqual([]);
    expect(probe.courtReads, "no uuid, no statement").toBe(0);
    expect(await actual.courtPairingNudges([randomUUID()])).toEqual([]);
    expect(probe.courtReads, "PREMISE: the probe sees a real read (a uuid makes exactly one)").toBe(1);
    expect(warn, "answered by the guard, not by a failed read that was caught").not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an unknown fixture id answers []", async () => {
    const actual = await vi.importActual<typeof import("../stream-sessions/nudge")>("../stream-sessions/nudge");
    expect(await actual.courtPairingNudges([randomUUID()])).toEqual([]);
  });
});
