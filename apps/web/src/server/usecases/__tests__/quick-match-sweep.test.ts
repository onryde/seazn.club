// Quick match plan 3, Task 2: the reminder and the expiry sweep (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C1, C2,
// C21, §7.8; plan 3 Amend T2 [B8-B11, C1, C2, D5-D8, E8, A5], the plan-1 carries: the delete re-checks expiry under its lock, a touch
// re-arms the reminder, D14's org filters, REMINDER_HOURS). One pass, four steps:
//   - orphans: a system-org competition with no `quick_matches` row, older than an hour (a create that died between its commits);
//   - re-arm: a saved match whose saver's account is gone (soft-deleted, or hard-deleted so the FK nulled it) becomes unsaved again,
//     expiring 7 days after its last activity, its address dropped (Review Focus 3, D8);
//   - expire: an unsaved match past its expiry is hard-deleted with everything under it (§7.8);
//   - remind: an unsaved match with an address, within 24 hours of expiry and not yet reminded, gets ONE reminder (C2).
//
// Every quick match is made by the real producer (`createQuickMatch`); every score goes through the real guest link (the events route,
// or the link's own AuthCtx from that route's door). The SQL UPDATEs below are the clock (`last_activity_at`, `expires_at`, a
// competition's age), or states another plan writes (a save, an account deletion), each named where it is made. The reminder is read
// back off the outbox and sent by the real worker through the one mocked seam, the transport.
//
// Expected values come from the spec (7 days, C1; 24 hours, C2; one hour for an orphan, pre-flight D5; 200 rows a step, B10; the ref
// type 'quick_match', the system org), the outbox's own bound (MAX_EXPIRY_MS) and the dictionaries on disk, never from the code under
// test.
//
// The system org is shared by every case, run and parallel file (A16): every sweep here passes `onlyIds` with the case's own ids
// (B8), and every count is that scope's.
//
// Sports: the orphan check runs badminton and football (E8: football, the team sport offered, has the widest fixture-side tables).
// The League + Knockout case (plan 5 T3) runs chess, the one offered sport whose results the test steers (a resignation), so its
// league can end level and draw a lot. Every other case reads only the `quick_matches` row and the outbox, which no sport changes,
// so it uses badminton.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex")); // every create seals a home token, every Score tap a link
vi.stubEnv("EMAIL_OUTBOX_KEK", "ef".repeat(32)); // the reminder's body is sealed at enqueue, as in production
vi.stubEnv("RESEND_API_KEY", "re_test_quick_match_sweep"); // the worker's attempt reaches the transport (the mock), never Resend

// The outbox's one network seam (the house pattern: quick-match-email.test.ts, outbox-kind-sweep.test.ts).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// Every log line, recorded: a failing row is logged with its id and code, never a token or an address.
const logs = vi.hoisted(() => {
  const lines: unknown[][] = [];
  const rec = (...args: unknown[]) => void lines.push(args);
  const log: Record<string, unknown> = { error: rec, warn: rec, info: rec, debug: rec, fatal: rec, trace: rec };
  log.child = () => log;
  return { lines, log };
});
vi.mock("@/server/logger", () => ({ log: logs.log }));
// The race the plan-1 T8 review named: a score that lands BETWEEN the sweep's read and its delete. The real delete, behind a switch
// that runs an armed competition's callback (a real touch) first.
// Every delete is recorded (which competitions the sweep tried to delete at all).
const race = vi.hoisted(() => ({ before: new Map<string, () => Promise<void>>(), deletes: [] as string[] }));
vi.mock("../quick-match-delete", async (orig) => {
  const real = await orig<typeof import("../quick-match-delete")>();
  return {
    ...real,
    hardDeleteQuickMatchCompetition: async (...args: Parameters<typeof real.hardDeleteQuickMatchCompetition>) => {
      race.deletes.push(args[0]);
      const first = race.before.get(args[0]);
      if (first) {
        race.before.delete(args[0]);
        await first();
      }
      return real.hardDeleteQuickMatchCompetition(...args);
    },
  };
});
// The reminder's enqueue, wrapped: an armed quick match's enqueue throws AFTER the claim, inside the claim's transaction (a render
// or an insert failing), so a test can see the claim roll back with it.
const enqueueFault = vi.hoisted(() => ({ armed: new Set<string>() }));
vi.mock("@/server/email-outbox", async (orig) => {
  const real = await orig<typeof import("@/server/email-outbox")>();
  return {
    ...real,
    enqueueEmailOnce: async (...args: Parameters<typeof real.enqueueEmailOnce>) => {
      if (enqueueFault.armed.has(args[1].refId)) throw new Error("armed: this enqueue fails (test)");
      return real.enqueueEmailOnce(...args);
    },
  };
});
// The stale reminder's end (m6), behind a switch: an armed quick match's cancel throws, AFTER its touch has committed (review m-4).
const cancelFault = vi.hoisted(() => ({ armed: new Set<string>() }));
vi.mock("@/server/email-outbox/cancel", async (orig) => {
  const real = await orig<typeof import("@/server/email-outbox/cancel")>();
  return {
    ...real,
    cancelQueuedEmails: async (...args: Parameters<typeof real.cancelQueuedEmails>) => {
      if (args[1].refIds.some((id) => cancelFault.armed.has(id))) throw new Error("armed: this cancel fails (test)");
      return real.cancelQueuedEmails(...args);
    },
  };
});
// The scoring path's touch, behind a switch: off, a score commits and the touch that records it in last_activity_at has not run yet
// (it runs after the append commits, best-effort: scoring.ts).
const touchSwitch = vi.hoisted(() => ({ skipFixture: false }));
vi.mock("../quick-match-activity", async (orig) => {
  const real = await orig<typeof import("../quick-match-activity")>();
  return {
    ...real,
    touchQuickMatchActivityForFixture: async (...args: Parameters<typeof real.touchQuickMatchActivityForFixture>) => {
      if (touchSwitch.skipFixture) return;
      return real.touchQuickMatchActivityForFixture(...args);
    },
  };
});
// The reminder's read of the row (the one place the sweep opens a home token), the same way: every read recorded (the sweep opens
// only the tokens of matches it reminds), and an armed competition's callback run after the read, BEFORE the claim (a save, an
// overlapping run's claim or a release landing in between).
const claim = vi.hoisted(() => ({ before: new Map<string, () => Promise<void>>(), reads: [] as string[] }));
vi.mock("../quick-match-home", async (orig) => {
  const real = await orig<typeof import("../quick-match-home")>();
  return {
    ...real,
    findQuickMatchByCompetition: async (competitionId: string) => {
      claim.reads.push(competitionId);
      const row = await real.findQuickMatchByCompetition(competitionId);
      const first = claim.before.get(competitionId);
      if (first) {
        claim.before.delete(competitionId);
        await first();
      }
      return row;
    },
  };
});

import { inspect } from "node:util";
import { POST as eventsPost } from "@/app/api/v1/fixtures/[id]/events/route";
import { EVENTS } from "@/lib/analytics-events";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import { captureServer } from "@/lib/posthog-server";
import { QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest, CreateQuickMatch } from "@/server/api-v1/schemas";
import { FIRST_ATTEMPT_WINDOW_MS, MAX_EXPIRY_MS, enqueueEmail } from "@/server/email-outbox";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { ensureGuestDeviceLink } from "../device-links";
import { touchQuickMatchActivity } from "../quick-match-activity";
import { createQuickMatch, systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition, type QuickMatchDeleteGuard } from "../quick-match-delete";
import { resolveQuickMatchToken } from "../quick-match-home";
import { saveQuickMatchForUser } from "../quick-match-save";
import { listQuickMatchSports } from "../quick-match-sports";
import { QUICK_MATCH_SWEEP_LIMIT, sweepQuickMatches, type QuickMatchSweepReport } from "../quick-match-sweep";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { completeStage } from "../stages";
import { firstRallyFor, playToDecided } from "./_quick-match-probe";
import { expectAllPresent, expectNoOrphans, idsOf, rowsRecorded, tablesRecorded } from "./_quick-match-orphans";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** C1: an unsaved quick match is kept 7 days after its last activity. */
const SPEC_EXPIRY_DAYS = 7;
/** C2: the one reminder goes out once 24 hours or less are left. */
const SPEC_REMINDER_HOURS = 24;
/** Pre-flight D5 (ledger D1): a system-org competition with no `quick_matches` row is an orphan once it is an hour old. */
const SPEC_ORPHAN_AGE_MS = HOUR_MS;
/** Amend T2 [B10]: each step takes at most 200 rows a run; the rest is `deferred`. */
const SPEC_SWEEP_LIMIT = 200;
/** Amend T1 [C3]: a quick match's mails carry this free-text reference. */
const REF_TYPE = "quick_match";
/** The base every link is built on: the route passes `baseUrl(req)`, a test passes its own. */
const BASE = "https://qm-sweep.test";
const SIDES = ["Ravi & Sam", "Priya & Tom"];

let BADMINTON_V: string;
const competitions: string[] = [];
const users: string[] = [];
const foreignOrgs: string[] = [];

const ZERO: QuickMatchSweepReport = { checked: 0, rearmed: 0, reminded: 0, expired: 0, orphans: 0, failed: 0, deferred: 0 };

/** A guest's quick match through the real create; `email` typed on it or not, in the setup form's `locale`. */
async function create(over: Partial<CreateQuickMatch> = {}): Promise<CreatedQuickMatch> {
  const input: CreateQuickMatch = {
    name: `QM sweep ${randomUUID().slice(0, 8)}`,
    sport_key: "badminton",
    variant_key: BADMINTON_V,
    kind: "pair",
    format: "league",
    sides: SIDES,
    plays: 1,
    email: null,
    locale: "en",
    ...over,
  };
  const out = await createQuickMatch(input, { visitorHash: hashVisitorKey(mintVisitorKey()), baseUrl: BASE, mailAllowed: async () => true });
  competitions.push(out.competitionId);
  return out;
}

const address = (tag: string): string => `delivered+qm_sweep-${tag}-${randomUUID().slice(0, 8)}@resend.dev`;

/** The clock: the last activity `daysAgo` days back, and the expiry C1 gives it (7 days on), as an unsaved row carries. Everything
 *  the match recorded happened by then, so its score events move back with it: a score in the last 7 days is one the touch has not
 *  recorded yet, and keeps the match (quick-match-delete.ts). */
async function idleFor(id: string, daysAgo: number): Promise<{ last: Date; expires: Date }> {
  const last = new Date(Date.now() - daysAgo * DAY_MS);
  const expires = new Date(last.getTime() + SPEC_EXPIRY_DAYS * DAY_MS);
  await sql`update quick_matches set last_activity_at = ${last}, expires_at = ${expires} where id = ${id}`;
  await sql`
    update score_events se set recorded_at = ${last}
      from fixtures f join divisions d on d.id = f.division_id join quick_matches q on q.competition_id = d.competition_id
     where se.fixture_id = f.id and q.id = ${id} and se.recorded_at > ${last}`;
  return { last, expires };
}
/** The clock: the expiry `hours` hours from now (negative: past), the last activity 7 days before it. */
async function expiresIn(id: string, hours: number): Promise<Date> {
  const expires = new Date(Date.now() + hours * HOUR_MS);
  await sql`update quick_matches set expires_at = ${expires},
              last_activity_at = ${new Date(expires.getTime() - SPEC_EXPIRY_DAYS * DAY_MS)} where id = ${id}`;
  return expires;
}

interface QmState {
  saved_by_user_id: string | null;
  email: string | null;
  expires_at: Date | null;
  reminder_sent_at: Date | null;
  last_activity_at: Date;
}
/** The row, read on the pool (past RLS), or undefined when it is gone. */
const stateOf = async (id: string): Promise<QmState | undefined> =>
  (await sql<QmState[]>`select saved_by_user_id, email, expires_at, reminder_sent_at, last_activity_at from quick_matches where id = ${id}`)[0];
const competitionExists = async (id: string): Promise<boolean> =>
  (await sql`select 1 from competitions where id = ${id}`).length === 1;

interface ReminderRow {
  id: string;
  kind: string;
  ref_type: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  transactional: boolean;
  status: string;
  attempts: number;
  subject: string;
  expires_at: Date;
  created_at: Date;
}
const remindersOf = (quickMatchId: string) => sql<ReminderRow[]>`
  select id, kind, ref_type, org_id, recipient, recipient_user_id, transactional, status, attempts, subject, expires_at, created_at
    from email_outbox where kind = 'quick_match_reminder' and ref_id = ${quickMatchId} order by created_at, id`;
/** Branch review B m6 (controller, PO rec 2026-11-08): the reason a touch ends a reminder queued for the expiry it moved. The fix
 *  round's word, typed here, so a rename in the code reds this file. */
const REARMED_REASON = "quick_match_rearmed";
/** The log line a failed stale-reminder end writes (review m-4): not the touch's failure, which committed before it. */
const STALE_REMINDER_END_FAILED = "quick match: ending the reminder queued for the old expiry failed (the touch stands)";
/** How an outbox row ended: its status, its reason, and whether its sealed body is gone. */
const outboxEnd = async (id: string): Promise<{ status: string; last_error: string | null; cleared: boolean }> => {
  const [r] = await sql<{ status: string; last_error: string | null; cleared: boolean }[]>`
    select status, last_error, body_sealed is null as cleared from email_outbox where id = ${id}`;
  if (!r) throw new Error(`precondition: outbox row ${id} exists`);
  return r;
};
/** The worker's tick over one row, past the first-attempt window it leaves to a request (as the reminder test above does). */
async function sendDue(outboxId: string): Promise<void> {
  await sql`update email_outbox set created_at = now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}) where id = ${outboxId}`;
  await runOutboxTick({ onlyIds: [outboxId], sleep: async () => undefined });
}
/** Every mail the transport was handed for this address. */
const sentTo = (to: string) => deliverMock.mock.calls.map((c) => c[0] as { to: string }).filter((m) => m.to === to);

/** A saver: a real account. */
async function saver(tag: string): Promise<string> {
  const u = await makeUser(`qm-sweep-${tag}`);
  users.push(u.id);
  return u.id;
}
/** The save's UPDATE (`quick-match-save.ts`) MINUS its `email = null` (m9): saver set, expiry cleared, reminder marked spent, the
 *  address deliberately KEPT. No product path leaves a saved row with an address; the rig does, so the re-arm's own address scrub
 *  and the once-key backstop below have something to act on. */
async function saveAs(quickMatchId: string, userId: string): Promise<void> {
  await sql`update quick_matches set saved_by_user_id = ${userId}, expires_at = null, reminder_sent_at = coalesce(reminder_sent_at, now())
            where id = ${quickMatchId}`;
}

/** The dictionary on disk: the copy's authority. */
function copy(locale: Locale, key: string, vars: Record<string, string>): string {
  const d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "emails.json"), "utf8")) as Record<string, string>;
  const template = d[key];
  if (typeof template !== "string") throw new Error(`no key ${key} in dictionaries/${locale}/emails.json`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);
}

interface Fx { id: string }
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  const rows = await sql<Fx[]>`
    select f.id from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${competitionId} order by f.round_no, f.fixture_no`;
  if (rows.length === 0) throw new Error(`precondition: competition ${competitionId} has no fixture`);
  return rows;
}
/** The events route itself, one event per request, as the pad posts it. */
const post = (secret: string, fixtureId: string, body: AppendEventRequest) =>
  eventsPost(
    new Request(`http://test.local/api/v1/fixtures/${fixtureId}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: fixtureId }) },
  );
/** The link's AuthCtx from the events route's own door, for a whole match played through `scoreEvent`. */
const linkAuth = (secret: string, fixtureId: string): Promise<AuthCtx> =>
  requireFixtureActor(new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }), fixtureId, "score");

/** The guest's Score tap on the first fixture: the link, through the real door (the match must be alive). */
async function scoreLink(out: CreatedQuickMatch): Promise<{ secret: string; fixtureId: string }> {
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve (expired?)`);
  const [f0] = await fixturesOf(out.competitionId);
  const { secret } = await ensureGuestDeviceLink(row, f0!.id);
  return { secret, fixtureId: f0!.id };
}

/** Every log line, error included, as one searchable text. */
const logText = (): string => logs.lines.map((l) => inspect(l, { depth: 20, maxStringLength: Infinity })).join("\n");

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

beforeEach(() => {
  deliverMock.mockReset();
  deliverMock.mockImplementation(async () => ({ ok: true, providerId: `re_qm_sweep_${randomUUID()}` }));
  logs.lines.length = 0;
  race.before.clear();
  race.deletes.length = 0;
  claim.before.clear();
  claim.reads.length = 0;
  enqueueFault.armed.clear();
  touchSwitch.skipFixture = false;
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const id of competitions) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (foreignOrgs.length > 0) {
    await sql`delete from email_outbox where org_id = any(${foreignOrgs}::uuid[])`;
    await sql`delete from competitions where org_id = any(${foreignOrgs}::uuid[])`;
    await sql`delete from organizations where id = any(${foreignOrgs}::uuid[])`;
  }
  if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("premises", () => {
  it("the exported per-step limit is the plan's 200 (Amend T2 [B10])", () => {
    expect(QUICK_MATCH_SWEEP_LIMIT).toBe(SPEC_SWEEP_LIMIT);
  });
});

describe.skipIf(!HAS_DB)("the expiry sweep (DB)", () => {
  it("an empty run answers zero for every count: no ids in scope, and ids that name nothing", async () => {
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [] })).toEqual(ZERO);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [randomUUID(), randomUUID()] })).toEqual(ZERO);
  });

  it("deletes an unsaved match idle past 7 days and keeps the rest: one idle 6 days, one touched a minute ago, one saved (Review Focus 2)", async () => {
    const old = await create();
    await idleFor(old.id, 8);
    const recent = await create();
    await idleFor(recent.id, 6);
    const touched = await create();
    await idleFor(touched.id, 8);
    await touchQuickMatchActivity(touched.id, new Date(Date.now() - 60_000)); // scored a minute ago
    const saved = await create();
    await idleFor(saved.id, 8);
    await saveAs(saved.id, await saver("keeper"));

    const r = await sweepQuickMatches({ baseUrl: BASE, onlyIds: [old.id, recent.id, touched.id, saved.id] });
    expect(r).toEqual({ ...ZERO, checked: 4, expired: 1 });
    expect(await stateOf(old.id)).toBeUndefined();
    expect(await competitionExists(old.competitionId), "the competition went with it").toBe(false);
    for (const kept of [recent, touched, saved]) {
      expect(await stateOf(kept.id), kept.id).toBeDefined();
      expect(await competitionExists(kept.competitionId)).toBe(true);
    }
    expect((await stateOf(saved.id))!.expires_at, "a saved match is never re-armed while its saver lives").toBeNull();
  });

  it("the boundary is strict: a match at exactly its expiry instant is kept, and a millisecond later it is deleted", async () => {
    const m = await create();
    const at = new Date(Date.now() - 60_000);
    await sql`update quick_matches set expires_at = ${at}, last_activity_at = ${new Date(at.getTime() - SPEC_EXPIRY_DAYS * DAY_MS)} where id = ${m.id}`;
    // The delete's own re-check, called as the sweep calls it.
    expect(await hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: at })).toEqual({ deleted: false, kept: true });
    // The sweep's selection: not picked at all (picked and then kept would be `deferred`).
    expect(await sweepQuickMatches({ baseUrl: BASE, now: at, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1 });
    expect(await stateOf(m.id)).toBeDefined();
    // The positive pair: one millisecond later the same row goes.
    expect(await sweepQuickMatches({ baseUrl: BASE, now: new Date(at.getTime() + 1), onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1, expired: 1 });
    expect(await stateOf(m.id)).toBeUndefined();
  });

  it("the delete re-checks under the row's lock: a score between the sweep's read and its delete keeps the match (plan-1 T8 review)", async () => {
    const m = await create();
    await idleFor(m.id, 8);
    race.before.set(m.competitionId, () => touchQuickMatchActivity(m.id)); // the score lands after the read, before the delete
    const r = await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] });
    expect(race.before.size, "premise: the sweep reached the delete, so the score landed in between").toBe(0);
    expect(r).toEqual({ ...ZERO, checked: 1, deferred: 1 });
    const s = await stateOf(m.id);
    expect(s, "the revived match is kept").toBeDefined();
    expect(s!.expires_at!.getTime() - s!.last_activity_at.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
    // And the delete itself, called on a just-revived row: nothing goes.
    expect(await hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: new Date() })).toEqual({ deleted: false, kept: true });
    expect(await competitionExists(m.competitionId)).toBe(true);
  });

  it("a score that stands before its touch keeps the match past its expiry; the same score older than C1's 7 days does not", async () => {
    const m = await create();
    const { secret, fixtureId } = await scoreLink(m);
    const [start] = await firstRallyFor(fixtureId);
    touchSwitch.skipFixture = true; // the append commits; the touch that would record it has not run
    const res = await post(secret, fixtureId, start!);
    expect(res.status, await res.clone().text()).toBe(201);
    // The clock as the last RECORDED activity tells it: 8 days idle, a day past the expiry. The score itself is from just now.
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = ${m.id}`;
    const scored = await sql`select 1 from score_events where fixture_id = ${fixtureId}`;
    expect(scored.length, "premise: the guest's score committed").toBeGreaterThan(0);

    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1, deferred: 1 });
    expect(await competitionExists(m.competitionId), "a committed score is never deleted").toBe(true);
    expect(await sql`select 1 from score_events where fixture_id = ${fixtureId}`).toHaveLength(scored.length);

    // A lost touch keeps a match only for the 7 days C1 gives its last score: the same score 8 days old, and the match goes.
    // (The keep above moved the clock to the score, m1; the clock is put back as the idle match would hold it.)
    await sql`update score_events set recorded_at = now() - interval '8 days' where fixture_id = ${fixtureId}`;
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = ${m.id}`;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1, expired: 1 });
    expect(await competitionExists(m.competitionId)).toBe(false);
  });

  it("m1: a match kept for a score its touch never recorded gets that touch: its clock moves to the score, and the home, Save and the reminder read it alive", async () => {
    const m = await create({ email: address("m1-kept") });
    const { secret, fixtureId } = await scoreLink(m);
    const [start] = await firstRallyFor(fixtureId);
    touchSwitch.skipFixture = true; // the append commits; its touch is lost
    const res = await post(secret, fixtureId, start!);
    expect(res.status, await res.clone().text()).toBe(201);
    // The clock as the last RECORDED activity tells it: 8 days idle, a day past the expiry, reminded before that expiry. The score
    // itself is 2 days old, so an expiry built on "now" (the wrong base) cannot pass for one built on the score.
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day',
                reminder_sent_at = now() - interval '2 days' where id = ${m.id}`;
    await sql`update score_events set recorded_at = now() - interval '2 days' where fixture_id = ${fixtureId}`;
    const [{ latest }] = await sql<{ latest: Date }[]>`select max(recorded_at) as latest from score_events where fixture_id = ${fixtureId}`;
    expect(await resolveQuickMatchToken(m.token), "premise: before the sweep the home reads it as dead").toBeNull();

    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1, deferred: 1 });

    const s = await stateOf(m.id);
    expect(s!.last_activity_at.getTime(), "the lost touch, done: the last activity is the score").toBe(latest.getTime());
    expect(s!.expires_at!.getTime(), "C1: 7 days after that score").toBe(latest.getTime() + SPEC_EXPIRY_DAYS * DAY_MS);
    expect(s!.reminder_sent_at, "C2: the new expiry owes its own reminder").toBeNull();
    expect(await resolveQuickMatchToken(m.token), "the home reads it alive").not.toBeNull();
    // The sweep agrees too: the next run neither deletes it nor defers it again.
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1 });
    // The reminder: once the NEW expiry is within 24 hours, it is reminded.
    const nearExpiry = new Date(s!.expires_at!.getTime() - (SPEC_REMINDER_HOURS - 1) * HOUR_MS);
    expect(await sweepQuickMatches({ baseUrl: BASE, now: nearExpiry, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    // And the Save button keeps it (an expired row answers gone, D13).
    expect(await saveQuickMatchForUser(await saver("m1-kept"), m.id)).toBe("saved");
  });

  it("m1: a match kept for a held fixture moves its clock only FORWARD, to its latest committed score", async () => {
    const m = await create();
    const { secret, fixtureId } = await scoreLink(m);
    const [start] = await firstRallyFor(fixtureId);
    touchSwitch.skipFixture = true;
    const res = await post(secret, fixtureId, start!);
    expect(res.status, await res.clone().text()).toBe(201);
    // The score is 9 days old; a later home tap recorded activity 8 days ago, so the expiry (a day past) is LATER than the score's.
    await sql`update score_events set recorded_at = now() - interval '9 days' where fixture_id = ${fixtureId}`;
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day',
                reminder_sent_at = now() - interval '2 days' where id = ${m.id}`;
    // An append in flight holds the fixture (see "a score still in flight" above); the delete runs on another connection.
    const whileHeld = () =>
      sql.begin(async (tx) => {
        await tx`select 1 from fixtures where id = ${fixtureId} for key share`;
        return hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: new Date() });
      });
    const before = await stateOf(m.id);
    expect(await whileHeld()).toEqual({ deleted: false, kept: true });
    expect(await stateOf(m.id), "an older score never moves the expiry back (nor re-arms the reminder)").toEqual(before);

    // The positive pair: the committed score an hour old, the fixture held again. Kept, and the clock moves to that score.
    await sql`update score_events set recorded_at = now() - interval '1 hour' where fixture_id = ${fixtureId}`;
    const [{ latest }] = await sql<{ latest: Date }[]>`select max(recorded_at) as latest from score_events where fixture_id = ${fixtureId}`;
    expect(await whileHeld()).toEqual({ deleted: false, kept: true });
    const s = await stateOf(m.id);
    expect(s!.last_activity_at.getTime()).toBe(latest.getTime());
    expect(s!.expires_at!.getTime()).toBe(latest.getTime() + SPEC_EXPIRY_DAYS * DAY_MS);
    expect(s!.reminder_sent_at).toBeNull();
  });

  it("a score still in flight (its fixture held by an uncommitted append) keeps the match: never waited on; released, it goes", async () => {
    const m = await create();
    await idleFor(m.id, 8);
    const [f0] = await fixturesOf(m.competitionId);
    const clock = await stateOf(m.id);
    // An append that has written its event holds the event's fixture (its foreign key) until it commits. A delete that went ahead
    // would wait for that commit and then cascade the score away with the fixture.
    const whileHeld = await sql.begin(async (tx) => {
      await tx`select 1 from fixtures where id = ${f0!.id} for key share`;
      const pending = hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: new Date() });
      const answer = await Promise.race([pending, new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3000))]);
      if (answer === "blocked") void pending.catch(() => undefined); // it goes on once this transaction lets go
      return answer;
    });
    expect(whileHeld, "kept at once, not waiting on the append").toEqual({ deleted: false, kept: true });
    expect(await competitionExists(m.competitionId)).toBe(true);
    // m1's empty case: no committed score to move the clock to (the append's own touch follows its commit), so it is left as it was.
    expect(await stateOf(m.id)).toEqual(clock);
    expect(await hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: new Date() })).toEqual({ deleted: true, kept: false });
  });

  it("a saved match is never reminded or expired, whatever its expiry column holds", async () => {
    const keeper = await saver("never");
    // Two states only a bug elsewhere could leave: a saved row with a past expiry, and a saved row due a reminder.
    const past = await create();
    await saveAs(past.id, keeper);
    await sql`update quick_matches set expires_at = now() - interval '1 day' where id = ${past.id}`;
    const due = await create({ email: address("saved") });
    await saveAs(due.id, keeper);
    await sql`update quick_matches set expires_at = now() + interval '23 hours', reminder_sent_at = null where id = ${due.id}`;

    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [past.id, due.id] })).toEqual({ ...ZERO, checked: 2 });
    expect((await stateOf(past.id))!.saved_by_user_id).toBe(keeper);
    expect((await stateOf(due.id))!.saved_by_user_id).toBe(keeper);
    expect(await remindersOf(due.id)).toHaveLength(0);
    expect(claim.reads, "a saved match's token is never even opened for a reminder").not.toContain(due.competitionId);
    expect(race.deletes, "nor is a delete of a saved match tried").not.toContain(past.competitionId);
    // The delete's own guard holds it too.
    expect(await hardDeleteQuickMatchCompetition(past.competitionId, { expiredBefore: new Date() })).toEqual({ deleted: false, kept: true });
  });

  it("reminds once, within 24 hours of expiry, only with an address, in the match's language, with the home and Save links", async () => {
    const to = address("remind");
    const due = await create({ email: to, locale: "nl" });
    const dueAt = await expiresIn(due.id, 23);
    const silent = await create(); // no address typed
    await expiresIn(silent.id, 23);
    const early = await create({ email: address("early") });
    await expiresIn(early.id, SPEC_REMINDER_HOURS + 1); // 25 hours left: not yet

    const first = await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id, silent.id, early.id] });
    expect(first).toEqual({ ...ZERO, checked: 3, reminded: 1 });
    expect(claim.reads, "only the due match's token was opened").toEqual([due.competitionId]);
    const [row, ...more] = await remindersOf(due.id);
    expect(more, "exactly one reminder").toHaveLength(0);
    expect(row).toMatchObject({
      kind: "quick_match_reminder",
      ref_type: REF_TYPE,
      org_id: QUICK_MATCH_SYSTEM_ORG_ID,
      recipient: to,
      recipient_user_id: null,
      transactional: false, // controller ruling 2026-11-08: a suppressed address is not mailed
      status: "queued", // the worker makes the first attempt (the sweep sends nothing itself)
      attempts: 0,
      subject: copy("nl", "quickMatchReminder.subject", { name: await nameOf(due.id) }),
    });
    // Worthless once the match has expired, and never past the outbox's own bound.
    expect(row!.expires_at.getTime()).toBe(Math.min(dueAt.getTime(), row!.created_at.getTime() + MAX_EXPIRY_MS));
    expect((await stateOf(due.id))!.reminder_sent_at, "the claim is stamped").not.toBeNull();
    expect(await remindersOf(silent.id)).toHaveLength(0);
    expect(await remindersOf(early.id)).toHaveLength(0);

    // The second sweep over the same rows: nothing more, and no token opened.
    claim.reads.length = 0;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id, silent.id, early.id] })).toEqual({ ...ZERO, checked: 3 });
    expect(await remindersOf(due.id)).toHaveLength(1);
    expect(claim.reads).toEqual([]);

    // The worker sends it (past the first-attempt window it leaves to a request): to the address, in Dutch, with both links.
    await sql`update email_outbox set created_at = now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}) where id = ${row!.id}`;
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });
    const sent = deliverMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; text: string }).filter((m) => m.to === to);
    expect(sent, "one send, to the typed address").toHaveLength(1);
    const home = `${BASE}/q/${due.token}`;
    expect(sent[0]!.subject).toBe(row!.subject);
    for (const body of [sent[0]!.html, sent[0]!.text]) {
      expect(body).toContain(`${home}/save`);
      expect(body.split(home).length - 1, "the home link, and the Save link built on it").toBeGreaterThanOrEqual(2);
    }
    // C19: the token rides the mail, never a log line.
    expect(logText()).not.toContain(due.token);
  });

  it("two overlapping sweeps send one reminder and delete once", async () => {
    const due = await create({ email: address("race") });
    await expiresIn(due.id, 23);
    const old = await create();
    await idleFor(old.id, 9);
    const ids = [due.id, old.id];
    const [a, b] = await Promise.all([sweepQuickMatches({ baseUrl: BASE, onlyIds: ids }), sweepQuickMatches({ baseUrl: BASE, onlyIds: ids })]);
    expect(a.reminded + b.reminded, `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(1);
    expect(a.expired + b.expired).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(await remindersOf(due.id)).toHaveLength(1);
    expect(await stateOf(old.id)).toBeUndefined();
  });

  it.each([
    // Only the saver's column: the save's other writes (expiry nulled, the stamp set) would refuse the claim on their own and hide
    // whether the claim's own `saved_by_user_id is null` holds (a saved match is never reminded, whatever its other columns).
    ["a save (its saver alone)", "save"],
    ["an overlapping run's claim", "claimed"],
    ["a release that dropped the address (the account deletion, D8)", "released"],
    ["a score that moved the expiry 7 days out, past the reminder's window", "scored"],
  ] as const)("the claim re-checks under the row's lock: %s between the read and the claim queues nothing", async (_, what) => {
    const due = await create({ email: address(`claim-${what}`) });
    await expiresIn(due.id, 23);
    const keeper = what === "save" ? await saver("claim") : null;
    claim.before.set(due.competitionId, async () => {
      if (what === "save") await sql`update quick_matches set saved_by_user_id = ${keeper} where id = ${due.id}`;
      else if (what === "claimed") await sql`update quick_matches set reminder_sent_at = now() where id = ${due.id}`;
      else if (what === "released") await sql`update quick_matches set email = null where id = ${due.id}`;
      else await touchQuickMatchActivity(due.id);
    });
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1 });
    expect(claim.before.size, "premise: the sweep read the row, so the change landed between the read and the claim").toBe(0);
    expect(await remindersOf(due.id)).toHaveLength(0);
  });

  it("never twice before the same expiry: a reminded match whose stamp is cleared with its expiry unchanged gets no second reminder (the outbox's once-key backstops the stamp)", async () => {
    const due = await create({ email: address("once") });
    await expiresIn(due.id, 23);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    await saveAs(due.id, await saver("once"));
    // A hand-written state no product path writes: unsaved again, 7 days from the last activity (the same expiry as before), the
    // address kept and the reminder stamp cleared. The account deletion's release used to clear the stamp; since m9 a saved match
    // holds no address and the release leaves the stamp alone (final review B m1). The once-key, per expiry, is the backstop if
    // a path ever clears the stamp without moving the expiry.
    await sql`update quick_matches set saved_by_user_id = null, expires_at = last_activity_at + interval '7 days', reminder_sent_at = null
              where id = ${due.id}`;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1 });
    expect(await remindersOf(due.id), "the outbox's once-key, per expiry, holds").toHaveLength(1);
  });

  it.each([
    ["the home's own touch", "home"],
    ["a score through the guest link", "score"],
  ] as const)("activity after the reminder re-arms it: %s, the old reminder still queued never sends (m6), and the match is reminded again before its new expiry", async (_, door) => {
    const to = address(`rearm-${door}`);
    const due = await create({ email: to });
    await expiresIn(due.id, 23);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    expect((await stateOf(due.id))!.reminder_sent_at).not.toBeNull();
    const [old] = await remindersOf(due.id);
    expect(await outboxEnd(old!.id), "premise: the reminder is queued, with its body, and nothing has sent it").toEqual({
      status: "queued",
      last_error: null,
      cleared: false,
    });

    if (door === "home") {
      await touchQuickMatchActivity(due.id);
    } else {
      const { secret, fixtureId } = await scoreLink(due);
      const [start] = await firstRallyFor(fixtureId);
      const res = await post(secret, fixtureId, start!);
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const s = await stateOf(due.id);
    expect(s!.reminder_sent_at, "the activity re-armed the reminder").toBeNull();
    expect(s!.expires_at!.getTime() - s!.last_activity_at.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
    // m6: the "deleted tomorrow" mail still queued is about an expiry the activity just moved 7 days out. It ends, cancelled, on
    // the outbox's own cancel path (reason in CANCELLED_REASONS), and the worker passes it by.
    expect(await outboxEnd(old!.id), "the stale reminder ended unsent").toEqual({ status: "expired", last_error: REARMED_REASON, cleared: true });
    await sendDue(old!.id);
    expect(sentTo(to), "the cancelled reminder never sends").toHaveLength(0);
    // Seven days out: no reminder yet.
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1 });
    // The new expiry approaches: the second reminder.
    await expiresIn(due.id, 22);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    const rows = await remindersOf(due.id);
    expect(rows, "one reminder per arming").toHaveLength(2);
    // The positive pair: the live reminder does send, through the same worker tick.
    await sendDue(rows[1]!.id);
    expect(sentTo(to), "the new expiry's reminder is mailed").toHaveLength(1);
  });

  it.each([
    ["the home's touch", "home"],
    ["the scoring path's touch, after a rally", "score"],
  ] as const)("a stale reminder's end that fails is logged as itself, not as a failed touch (review m-4): %s; the touch stands", async (_, door) => {
    const due = await create({ email: address(`rearm-fault-${door}`) });
    await expiresIn(due.id, 23);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    const [old] = await remindersOf(due.id);
    const linked = door === "score" ? await scoreLink(due) : null;
    const start = linked ? (await firstRallyFor(linked.fixtureId))[0] : null;
    const logged = logs.lines.length;
    cancelFault.armed.add(due.id);
    try {
      if (linked) {
        const res = await post(linked.secret, linked.fixtureId, start!);
        expect(res.status, await res.clone().text()).toBe(201);
      } else {
        await expect(touchQuickMatchActivity(due.id), "the touch answers: its own write committed").resolves.toBeUndefined();
      }
    } finally {
      cancelFault.armed.delete(due.id);
    }
    const s = await stateOf(due.id);
    expect(s!.reminder_sent_at, "the touch stands: the reminder re-armed").toBeNull();
    expect(s!.expires_at!.getTime() - s!.last_activity_at.getTime(), "and the expiry moved").toBe(SPEC_EXPIRY_DAYS * DAY_MS);
    expect((await outboxEnd(old!.id)).status, "premise: the armed cancel ended nothing").toBe("queued");
    // The line's words, typed here: a failed end is its own event, and the touch it follows committed.
    const said = logs.lines.slice(logged).map((l) => String(l.at(-1)));
    expect(said.filter((m) => m === STALE_REMINDER_END_FAILED), "its own line, once").toHaveLength(1);
    expect(said.filter((m) => m.includes("touch failed")), "never reported as a failed touch").toEqual([]);
  });

  it.each([
    ["soft-deleted, as DELETE /api/users/me leaves it (users.deleted_at)", "soft"],
    ["hard-deleted, so the foreign key nulled the saver", "hard"],
  ] as const)("a saver's deleted account re-arms expiry (Review Focus 3): %s", async (_, how) => {
    const gone = await saver(`gone-${how}`);
    const fresh = await create({ email: address("rearm-fresh") });
    const freshClock = await idleFor(fresh.id, 2);
    await saveAs(fresh.id, gone);
    const freshStamp = (await stateOf(fresh.id))!.reminder_sent_at;
    expect(freshStamp, "premise: the save marked its reminder spent").not.toBeNull();
    const stale = await create({ email: address("rearm-stale") });
    await idleFor(stale.id, SPEC_EXPIRY_DAYS + 2);
    await saveAs(stale.id, gone);
    if (how === "soft") await sql`update users set deleted_at = now() where id = ${gone}`;
    else await sql`delete from users where id = ${gone}`;
    if (how === "hard") expect((await stateOf(fresh.id))!.saved_by_user_id, "premise: the FK set the saver null").toBeNull();

    const r = await sweepQuickMatches({ baseUrl: BASE, onlyIds: [fresh.id, stale.id] });
    expect(r).toEqual({ ...ZERO, checked: 2, rearmed: 2, expired: 1 });
    const f = await stateOf(fresh.id);
    expect(f).toMatchObject({ saved_by_user_id: null, email: null }); // D8: the address cannot be compared any more, so it goes
    expect(f!.expires_at!.getTime()).toBe(freshClock.last.getTime() + SPEC_EXPIRY_DAYS * DAY_MS);
    // With no address the reminder step never reaches it, so the stamp stays spent rather than promise a mail (final review B m1).
    expect(f!.reminder_sent_at, "the save's spent stamp stands").toEqual(freshStamp);
    expect(await stateOf(stale.id), "idle past 7 days once unsaved: deleted in the same pass").toBeUndefined();
    // A second sweep finds nothing more to re-arm.
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [fresh.id, stale.id] })).toEqual({ ...ZERO, checked: 1 });
  });

  it("an orphan competition (no quick_matches row) older than an hour is deleted; one 59 minutes old is kept, and so is an old live match (pre-flight D1, D5)", async () => {
    const aged = await create();
    const young = await create();
    const live = await create(); // an old competition WITH its row: a live match, never an orphan
    // A create that died between its two commits leaves its competition without the row (quick-match-create.ts's header).
    await sql`delete from quick_matches where id = any(${[aged.id, young.id]}::uuid[])`;
    await sql`update competitions set created_at = ${new Date(Date.now() - 2 * SPEC_ORPHAN_AGE_MS)}
              where id = any(${[aged.competitionId, live.competitionId]}::uuid[])`;
    await sql`update competitions set created_at = ${new Date(Date.now() - SPEC_ORPHAN_AGE_MS + 60_000)} where id = ${young.competitionId}`;

    const r = await sweepQuickMatches({ baseUrl: BASE, onlyIds: [aged.competitionId, young.competitionId, live.competitionId] });
    // checked: the one orphan found, and the live match's row.
    expect(r).toEqual({ ...ZERO, checked: 2, orphans: 1 });
    expect(race.deletes, "only the orphan's delete was tried").toEqual([aged.competitionId]);
    expect(await competitionExists(aged.competitionId)).toBe(false);
    expect(await sql`select 1 from divisions where competition_id = ${aged.competitionId}`, "the cascade took its tree").toHaveLength(0);
    expect(await competitionExists(young.competitionId), "a create may still be committing").toBe(true);
    expect(await stateOf(live.id)).toBeDefined();
    // The delete's own re-check, called as the sweep calls it: neither is an orphan.
    const before = new Date(Date.now() - SPEC_ORPHAN_AGE_MS);
    expect(await hardDeleteQuickMatchCompetition(young.competitionId, { orphanedBefore: before })).toEqual({ deleted: false, kept: true });
    expect(await hardDeleteQuickMatchCompetition(live.competitionId, { orphanedBefore: before })).toEqual({ deleted: false, kept: true });
    expect(await competitionExists(young.competitionId)).toBe(true);
    expect(await competitionExists(live.competitionId)).toBe(true);
  });

  it("an enqueue that fails after the claim takes the claim back with it: counted, nothing queued, and the next run reminds", async () => {
    const due = await create({ email: address("rollback") });
    await expiresIn(due.id, 23);
    enqueueFault.armed.add(due.id);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, failed: 1 });
    expect((await stateOf(due.id))!.reminder_sent_at, "the claim rolled back with the failed enqueue").toBeNull();
    expect(await remindersOf(due.id)).toHaveLength(0);
    enqueueFault.armed.delete(due.id);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    expect(await remindersOf(due.id)).toHaveLength(1);
  });

  it("a home token the key cannot open fails its row BEFORE the claim: counted, logged by code, and the next run tries again", async () => {
    const due = await create({ email: address("sealed") });
    await expiresIn(due.id, 23);
    // A token sealed under another key (or damaged): the reminder cannot build its link.
    await sql`update quick_matches set token_enc = ${randomBytes(48)} where id = ${due.id}`;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [due.id] })).toEqual({ ...ZERO, checked: 1, failed: 1 });
    expect(await remindersOf(due.id)).toHaveLength(0);
    expect((await stateOf(due.id))!.reminder_sent_at, "nothing claimed").toBeNull();
    const failures = logs.lines.filter((l) => JSON.stringify(l).includes('"step":"remind"'));
    expect(failures, "one failure line").toHaveLength(1);
    expect(JSON.stringify(failures[0])).toMatch(/"code":"QUICK_MATCH_HOME_TOKEN_[A-Z_]+"/);
  });

  it.each(["expiredBefore", "orphanedBefore"] as const)(
    "a row another transaction holds is KEPT by the guarded delete (%s): never waited on, never reported gone; released, it goes",
    async (guard) => {
      const m = await create();
      if (guard === "expiredBefore") await idleFor(m.id, 8);
      else {
        await sql`delete from quick_matches where id = ${m.id}`;
        await sql`update competitions set created_at = now() - interval '2 hours' where id = ${m.competitionId}`;
      }
      const at: QuickMatchDeleteGuard =
        guard === "expiredBefore" ? { expiredBefore: new Date() } : { orphanedBefore: new Date(Date.now() - SPEC_ORPHAN_AGE_MS) };
      // A touch (or an overlapping run) holding the row: the delete runs on another connection while this one holds it.
      const whileHeld = await sql.begin(async (tx) => {
        if (guard === "expiredBefore") await tx`select 1 from quick_matches where id = ${m.id} for update`;
        else await tx`select 1 from competitions where id = ${m.competitionId} for update`;
        return hardDeleteQuickMatchCompetition(m.competitionId, at);
      });
      expect(whileHeld).toEqual({ deleted: false, kept: true });
      expect(await competitionExists(m.competitionId)).toBe(true);
      expect(await hardDeleteQuickMatchCompetition(m.competitionId, at)).toEqual({ deleted: true, kept: false });
      expect(await competitionExists(m.competitionId)).toBe(false);
    },
  );

  it("a failing delete is counted and logged with its id and code (never a token or an address), announces no deletion, and the other rows still go", async () => {
    const to = address("fail");
    const bad = await create({ email: to });
    await idleFor(bad.id, 8);
    const good = await create();
    await idleFor(good.id, 8);
    const r = await sweepQuickMatches({
      baseUrl: BASE,
      onlyIds: [bad.id, good.id],
      _failDeleteForTests: (competitionId) => competitionId === bad.competitionId,
    });
    expect(r).toEqual({ ...ZERO, checked: 2, expired: 1, failed: 1 });
    expect(await stateOf(bad.id)).toBeDefined();
    expect(await stateOf(good.id)).toBeUndefined();
    const text = logText();
    expect(text).toContain(bad.competitionId);
    expect(text).toMatch(/code/);
    expect(text).not.toContain(bad.token);
    expect(text).not.toContain(to);
    // quick_match_deleted is the record of a delete that HAPPENED: none for the row whose delete failed (it is still on record),
    // and the positive pair, exactly one for the row that went.
    const deletedFor = (id: string) =>
      vi.mocked(captureServer).mock.calls.filter(([c]) => c.event === EVENTS.QUICK_MATCH_DELETED && c.properties?.quick_match_id === id);
    expect(deletedFor(bad.id), "the failed delete").toHaveLength(0);
    expect(deletedFor(good.id), "the delete that went").toHaveLength(1);
  });

  it.each([
    ["re-arm", "rearmed"],
    ["expire", "expired"],
    ["orphan", "orphans"],
    ["remind", "reminded"],
  ] as const)(`each step takes at most ${SPEC_SWEEP_LIMIT} rows a run and defers the rest, which the next run takes (Amend T2 [B10]): %s`, async (step, counted) => {
    // 201 candidates for the one step, made by SQL (201 real creates would be minutes): competitions created 2 hours ago (an
    // orphan's age; harmless to the others, which have their row), and for every step but the orphans' a quick_matches row each.
    const n = SPEC_SWEEP_LIMIT + 1;
    const gone = step === "re-arm" ? await saver("limit") : null;
    if (gone) await sql`update users set deleted_at = now() where id = ${gone}`;
    // The reminder opens the home token to build its link: a real create's sealed token, copied onto every row.
    const seed = step === "remind" ? await create() : null;
    const comps = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, created_at)
      select ${QUICK_MATCH_SYSTEM_ORG_ID}, 'QM sweep limit', 'qm-sweep-limit-' || gen_random_uuid(), now() - interval '2 hours'
        from generate_series(1, ${n})
      returning id`;
    competitions.push(...comps.map((c) => c.id));
    expect(comps).toHaveLength(n);
    let scope = comps.map((c) => c.id);
    if (step !== "orphan") {
      const tokenEnc = seed
        ? sql`(select token_enc from quick_matches where id = ${seed.id})`
        : sql`decode(md5(random()::text) || md5(random()::text), 'hex')`;
      // re-arm: saved by the deleted account, no expiry; expire: unsaved, a day past it; remind: unsaved with an address, 23 hours from it.
      const expires = step === "expire" ? sql`now() - interval '1 day'` : step === "remind" ? sql`now() + interval '23 hours'` : sql`null`;
      const email = step === "remind" ? sql`'delivered+qm_sweep-limit-' || md5(random()::text) || '@resend.dev'` : sql`null`;
      const made = await sql<{ id: string }[]>`
        insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, last_activity_at,
                                   saved_by_user_id, expires_at, email)
        select ${QUICK_MATCH_SYSTEM_ORG_ID}, c.id, 'QM sweep limit', 'league', md5(c.id::text || random()::text) || md5(random()::text),
               ${tokenEnc}, md5(random()::text), now() - interval '1 day', ${gone}::uuid, ${expires}, ${email}
          from unnest(${scope}::uuid[]) as c(id)
        returning id`;
      expect(made).toHaveLength(n);
      scope = made.map((m) => m.id);
    }
    // checked: the step's quick_matches rows in scope, or the orphans found.
    const second = step === "expire" || step === "orphan" ? 1 : n;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: scope })).toEqual({ ...ZERO, checked: n, [counted]: SPEC_SWEEP_LIMIT, deferred: 1 });
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: scope })).toEqual({ ...ZERO, checked: second, [counted]: 1 });
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: scope }), "and then nothing is left to do").toEqual({ ...ZERO, checked: second === 1 ? 0 : n });
  });

  it("never deletes on a date: a saved match whose competition ended yesterday is kept, and still scores (C21)", async () => {
    const m = await create();
    await saveAs(m.id, await saver("ended"));
    await sql`update competitions set ends_on = current_date - 1 where id = ${m.competitionId}`;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [m.id] })).toEqual({ ...ZERO, checked: 1 });
    expect(await competitionExists(m.competitionId)).toBe(true);
    const { secret, fixtureId } = await scoreLink(m);
    const [start] = await firstRallyFor(fixtureId);
    const res = await post(secret, fixtureId, start!);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

/** The match's name, as the row holds it (the reminder's subject names it). */
async function nameOf(id: string): Promise<string> {
  const [r] = await sql<{ name: string }[]>`select name from quick_matches where id = ${id}`;
  return r!.name;
}

describe.skipIf(!HAS_DB)("the hard delete (DB): its answer, and the org it is scoped to", () => {
  it("answers deleted the first time and not the second (Amend T2 [D7])", async () => {
    const m = await create();
    expect(await hardDeleteQuickMatchCompetition(m.competitionId)).toEqual({ deleted: true, kept: false });
    expect(await hardDeleteQuickMatchCompetition(m.competitionId)).toEqual({ deleted: false, kept: false });
    // A conditional delete of a row already gone answers the same: nothing kept, nothing deleted.
    expect(await hardDeleteQuickMatchCompetition(m.competitionId, { expiredBefore: new Date() })).toEqual({ deleted: false, kept: false });
  });

  it("leaves another org's competition, its quick_matches row and its outbox row by reference untouched (Amend T2 [C2])", async () => {
    const owner = await saver("foreign-owner");
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by) values ('QM sweep foreign', ${`qm-sweep-foreign-${randomUUID().slice(0, 8)}`}, ${owner})
      returning id`;
    foreignOrgs.push(org!.id);
    const [comp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug) values (${org!.id}, 'QM sweep foreign', ${`qm-foreign-${randomUUID().slice(0, 8)}`}) returning id`;
    const [qm] = await sql<{ id: string }[]>`
      insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, expires_at)
      values (${org!.id}, ${comp!.id}, 'QM sweep foreign', 'league', ${randomBytes(32).toString("hex")}, ${randomBytes(48)},
              ${randomBytes(32).toString("hex")}, now() - interval '1 day')
      returning id`;
    const outboxId = await enqueueEmail(sql, {
      kind: "quick_match_reminder",
      refType: REF_TYPE,
      refId: qm!.id,
      orgId: org!.id,
      to: address("foreign"),
      subject: "foreign",
      html: "<p>foreign</p>",
      text: "foreign",
      transactional: false,
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    expect(await hardDeleteQuickMatchCompetition(comp!.id)).toEqual({ deleted: false, kept: false });
    expect(await hardDeleteQuickMatchCompetition(comp!.id, { expiredBefore: new Date() })).toEqual({ deleted: false, kept: false });
    expect(await hardDeleteQuickMatchCompetition(comp!.id, { orphanedBefore: new Date() })).toEqual({ deleted: false, kept: false });
    expect(await competitionExists(comp!.id), "the competition").toBe(true);
    expect(await sql`select 1 from quick_matches where id = ${qm!.id}`, "the quick_matches row").toHaveLength(1);
    expect(await sql`select 1 from email_outbox where id = ${outboxId}`, "the outbox row by reference").toHaveLength(1);

    // And the sweep never selects another org's rows at all: an expired match (the one above), a match due its reminder, and an old
    // competition with no quick_matches row, each of which the system org's would be acted on.
    const [dueComp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug) values (${org!.id}, 'QM sweep foreign due', ${`qm-foreign-${randomUUID().slice(0, 8)}`}) returning id`;
    const [dueQm] = await sql<{ id: string }[]>`
      insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, email, expires_at)
      values (${org!.id}, ${dueComp!.id}, 'QM sweep foreign due', 'league', ${randomBytes(32).toString("hex")}, ${randomBytes(48)},
              ${randomBytes(32).toString("hex")}, ${address("foreign-due")}, now() + interval '23 hours')
      returning id`;
    const [bare] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, created_at)
      values (${org!.id}, 'QM sweep foreign bare', ${`qm-foreign-${randomUUID().slice(0, 8)}`}, now() - interval '2 hours') returning id`;
    // Unsaved with no expiry: the system org's would be re-armed.
    const [limboComp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug) values (${org!.id}, 'QM sweep foreign limbo', ${`qm-foreign-${randomUUID().slice(0, 8)}`}) returning id`;
    const [limbo] = await sql<{ id: string }[]>`
      insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, expires_at)
      values (${org!.id}, ${limboComp!.id}, 'QM sweep foreign limbo', 'league', ${randomBytes(32).toString("hex")}, ${randomBytes(48)},
              ${randomBytes(32).toString("hex")}, null)
      returning id`;
    const scope = [qm!.id, comp!.id, dueQm!.id, dueComp!.id, bare!.id, limbo!.id];
    race.deletes.length = 0;
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: scope })).toEqual(ZERO);
    expect(race.deletes, "no delete was tried").toEqual([]);
    expect(claim.reads, "no row was read for a reminder").toEqual([]);
    expect(await competitionExists(comp!.id)).toBe(true);
    expect(await competitionExists(bare!.id)).toBe(true);
    expect(await remindersOf(dueQm!.id)).toHaveLength(0);
    expect((await stateOf(dueQm!.id))!.reminder_sent_at).toBeNull();
    expect((await stateOf(limbo!.id))!.expires_at, "not re-armed").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the expiry leaves no orphan row in any table (§7.8, E8)", () => {
  it.each(["badminton", "football"])("%s: a scored, emailed match idle past 7 days goes with everything under it; its neighbour stays whole", async (sportKey) => {
    const sport = (await listQuickMatchSports()).find((s) => s.sport_key === sportKey);
    if (!sport) throw new Error(`premise: ${sportKey} is offered for quick matches`);
    const shape = { sport_key: sportKey, variant_key: sport.variants[0]!.variant_key, kind: sport.kinds.at(-1)!, sides: ["Side A", "Side B"] };
    const played = async (email: string | null) => {
      const out = await create({ ...shape, email });
      const { secret, fixtureId } = await scoreLink(out);
      expect(await playToDecided(await linkAuth(secret, fixtureId), fixtureId), "premise: the match was played to a result").toMatchObject({ kind: "decided" });
      return out;
    };
    const doomed = await played(address(`orphans-${sportKey}`));
    const neighbour = await played(null);

    const probes = await idsOf(doomed);
    const tables = tablesRecorded(probes);
    // A scored, emailed quick match holds rows in at least these (anti-vacuity on the shape, not only on the count).
    for (const t of ["competitions", "divisions", "stages", "entrants", "fixtures", "score_events", "match_states", "device_links", "quick_matches", "email_outbox"]) {
      expect(tables, `the match held rows in ${t} before its delete`).toContain(t);
    }
    const kept = await idsOf(neighbour);

    await idleFor(doomed.id, SPEC_EXPIRY_DAYS + 1);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [doomed.id, neighbour.id] })).toEqual({ ...ZERO, checked: 2, expired: 1 });
    await expectNoOrphans(probes, sportKey);
    await expectAllPresent(kept, `${sportKey} neighbour`);
    // The platform rows every match hangs off are untouched.
    expect(await sql`select 1 from organizations where id = ${QUICK_MATCH_SYSTEM_ORG_ID}`).toHaveLength(1);
    expect(await sql`select 1 from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`).toHaveLength(1);
    console.info(`orphan check (${sportKey}): ${rowsRecorded(probes)} rows in ${tables.size} tables before the sweep`);
  });
});

describe.skipIf(!HAS_DB)("a League + Knockout expires whole: both stages, their lines, the lot and the seed proposal (plan 5 T3, P12)", () => {
  it("a League → Final whose league ended level (a lot drawn, the knockout's proposal drafted) idle past 7 days leaves no stage, line, proposal or lot", async () => {
    // single-sport: chess, so each result is steered (a resignation decides the game for the other side, the rulebook) into the
    // circle that leaves all three level and makes the engine draw a lot; the delete itself reads no sport.
    const chess = (await listQuickMatchSports()).find((x) => x.sport_key === "boardgame");
    if (!chess) throw new Error("premise: chess is offered for quick matches");
    const out = await create({
      sport_key: "boardgame",
      variant_key: chess.variants[0]!.variant_key,
      kind: chess.kinds.at(-1)!,
      format: "league_knockout",
      qualifiers: 2,
      sides: ["Asha", "Ben", "Cleo"],
    });
    const stages = await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${out.divisionId} order by seq`;
    expect(stages.map((st) => st.kind), "premise: two stages").toEqual(["league", "knockout"]);
    const [league, knockout] = [...stages] as [{ id: string; kind: string }, { id: string; kind: string }];
    const lines = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${league.id} order by round_no, fixture_no`;
    expect(lines, "premise: 3·2/2 league matches").toHaveLength(3);
    const ids = [...new Set(lines.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort();
    const pair = (x: string, y: string) => [x, y].sort().join("|");
    // The circle: ids[0] beats ids[1], ids[1] beats ids[2], ids[2] beats ids[0], every game by resignation.
    const winnerOf = new Map([[pair(ids[0]!, ids[1]!), ids[0]!], [pair(ids[1]!, ids[2]!), ids[1]!], [pair(ids[0]!, ids[2]!), ids[2]!]]);
    for (const f of lines) {
      const winner = winnerOf.get(pair(f.home_entrant_id, f.away_entrant_id))!;
      await scoreEvent(systemAuth(), f.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(systemAuth(), f.id, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
    }
    await completeStage(systemAuth(), league.id, { publish: false });

    const countIn = async (division: string) => {
      const [c] = await sql<{ stages: number; fixtures: number; proposals: number; lots: number }[]>`
        select (select count(*)::int from stages where division_id = ${division}) as stages,
               (select count(*)::int from fixtures where division_id = ${division}) as fixtures,
               (select count(*)::int from stage_seed_proposals where stage_id in (${league.id}, ${knockout.id})) as proposals,
               (select count(*)::int from stage_lots_draws where stage_id in (${league.id}, ${knockout.id})) as lots`;
      return c!;
    };
    // Anti-vacuity: every table the case is about holds this match's rows before the sweep.
    const before = await countIn(out.divisionId);
    expect(before.stages).toBe(2);
    expect(before.fixtures, "3 league lines + 1 final").toBe(4);
    expect(before.proposals, "completing the league drafted the knockout's seeding").toBeGreaterThan(0);
    expect(before.lots, "the level league drew a lot").toBeGreaterThan(0);
    const probes = await idsOf(out);
    const tables = tablesRecorded(probes);
    for (const t of ["stages", "fixtures", "stage_seed_proposals", "stage_lots_draws"]) expect(tables, `held rows in ${t}`).toContain(t);

    await idleFor(out.id, SPEC_EXPIRY_DAYS + 1);
    expect(await sweepQuickMatches({ baseUrl: BASE, onlyIds: [out.id] })).toEqual({ ...ZERO, checked: 1, expired: 1 });
    expect(await countIn(out.divisionId)).toEqual({ stages: 0, fixtures: 0, proposals: 0, lots: 0 });
    await expectNoOrphans(probes, "league_knockout");
    console.info(`League + Knockout expiry: ${rowsRecorded(probes)} rows in ${tables.size} tables before the sweep`);
  });
});
