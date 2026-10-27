// POST /api/funnel/remind queues the one +24h reminder for an unfinished /start draft on the email outbox (phase 3 wave 5, kind
// `funnel_reminder`; spec §9, F6). The claim (`reminded_at`, set only where it is still null) and the enqueue are one transaction on the
// pool (a visitor has no account and no organisation), the row's ref is the draft and its once-key `<draft id>:reminder`, and the worker
// makes the first attempt (W: nobody is waiting on a cron). The reminder is written in the language the visitor started the draft in
// (`funnel_drafts.locale`, set at /start: Q3), and in `en` for a draft that has none (every draft started before the column).
//
// Driven through the REAL route, the real draft writer, the real enqueue and the real worker. Stand-ins: the outbox's transport (the one
// network seam: captured, never sent), the start route's limiter, and `next/headers` (the cron secret, and the start's caller address).
// The enqueue and the builder are spies that call through. Expected values come from the dictionary on disk (`dictionarySubject`) and
// from the draft's own row, never from the route's answer.
//
// The cron route sweeps EVERY due draft in the database, and other files' drafts may be due in the shared test database, so every
// assertion here is filtered by this run's draft (its id, or its address).
//
// Changed while queued: nothing that the body says. There is no edit path for a draft's name, sport or language, and the link is the
// draft's own token. A claim in the window between enqueue and send leaves a spent link (rare, recorded); expiry is the row's
// `expires_at`, never later than the draft's.
//
// Another sport: the reminder's body names the sport the visitor chose, so two sports are driven (test 7).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const CRON = vi.hoisted(() => `cron-fr-${Math.random().toString(36).slice(2)}`);
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-cron-secret": CRON, "x-forwarded-for": "203.0.113.57" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// The start route (test 9 drives it to write the draft's language) is rate-limited per caller address.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
// The outbox's one network seam. The rows, the claim, the render and the worker are the real ones.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// The enqueue and the builder, observed: every call reaches the real one.
vi.mock("@/server/email-outbox", async (io) => {
  const m = await io<typeof import("@/server/email-outbox")>();
  return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) };
});
vi.mock("@/lib/email", async (io) => {
  const m = await io<typeof import("@/lib/email")>();
  return { ...m, funnelReminderEmail: vi.fn(m.funnelReminderEmail) };
});

import { sql } from "@/lib/db";
import { createFunnelDraft, type FunnelPayload } from "@/lib/funnel";
import { funnelReminderEmail } from "@/lib/email";
import { enqueueEmailOnce } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { bornAgo, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { POST as start } from "@/app/api/funnel/start/route";
import { POST as remind } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fr-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://remind.test";
const KIND = "funnel_reminder" as const;

type Row = {
  id: string; kind: string; ref_type: string; ref_id: string; dedupe_key: string | null; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string; attempts: number;
  last_error: string | null; expires_at: Date; cleared: boolean;
};
type Draft = { id: string; token: string; reminded_at: Date | null; expires_at: Date; locale: string | null };
type Delivered = { to: string; subject: string; html: string; text: string; idempotencyKey: string };

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
const payloadOf = (sport = "Badminton"): FunnelPayload => ({ name: `Autumn Open ${randomUUID().slice(0, 6)}`, sport, entrants: 8 });

/** A draft for `email`, made a day and an hour old: due for its reminder. */
async function dueDraft(email: string, payload: FunnelPayload = payloadOf()): Promise<{ id: string; token: string }> {
  const d = await createFunnelDraft(email, payload);
  await sql`update funnel_drafts set created_at = now() - interval '25 hours' where id = ${d.id}`;
  return d;
}

/** The cron's call, as the Worker makes it. */
async function sweep(): Promise<{ status: number; body: { ok: boolean; data?: { due: number; sent: number } } }> {
  const res = await remind(new Request(`${ORIGIN}/api/funnel/remind`, { method: "POST" }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { due: number; sent: number } } };
}

const draftOf = async (id: string): Promise<Draft> =>
  (await sql<Draft[]>`select id, token, reminded_at, expires_at, locale from funnel_drafts where id = ${id}`)[0]!;
/** The reminder rows for an address, in every status, oldest first. */
const rowsOf = (email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, dedupe_key, org_id, recipient, recipient_user_id, transactional, subject, status, attempts,
           last_error, expires_at, body_sealed is null as cleared
      from email_outbox where kind = ${KIND} and lower(recipient) = lower(${email})
     order by created_at, id`;
/** The enqueue calls the route made for a draft (the spy sees every due draft in the database, so it is filtered). */
const enqueueCalls = (draftId: string) => vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === KIND && m.refId === draftId);
/** What the transport was handed under this row's own key. */
const callsFor = (rowId: string): Delivered[] =>
  deliverMock.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === idempotencyKey(rowId));

const ok = async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` });
const unavailable = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  stubOutboxEnv();
  vi.stubEnv("CRON_SECRET", CRON);
  deliverMock.mockReset().mockImplementation(ok);
  vi.mocked(enqueueEmailOnce).mockClear();
  vi.mocked(funnelReminderEmail).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  const like = `${RUN}-%`;
  await sql`delete from email_outbox where kind in ('funnel_reminder', 'funnel_claim') and lower(recipient) like ${like}`;
  await sql`delete from funnel_drafts where email like ${like}`;
});

describe.skipIf(!HAS_DB)("POST /api/funnel/remind queues the +24h reminder on the outbox (DB)", () => {
  it("a day-old draft queues one reminder for the worker and is stamped", async () => {
    const email = address();
    const payload = payloadOf();
    const d = await dueDraft(email, payload);

    const res = await sweep();

    expect(res.status).toBe(200);
    expect(res.body.data!.sent, "this run's draft is among those queued").toBeGreaterThanOrEqual(1);
    const rows = await rowsOf(email);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "funnel_draft",
      ref_id: d.id,
      dedupe_key: `${d.id}:reminder`,
      org_id: null,
      recipient: email,
      recipient_user_id: null,
      transactional: true,
      status: "queued",
      attempts: 0,
    });
    const draft = await draftOf(d.id);
    expect(draft.locale, "premise: a draft written without a language has none").toBeNull();
    expect(row.subject, "a draft with no language is reminded in English").toBe(
      dictionarySubject("en", "funnelReminder.subject", { competitionName: payload.name }),
    );
    expect(row.expires_at.getTime(), "the row is worthless once the draft has expired").toBeLessThanOrEqual(draft.expires_at.getTime());
    expect(draft.reminded_at, "the draft is stamped").not.toBeNull();
    expect(callsFor(row.id), "the cron did not attempt the send: the first attempt is the worker's").toHaveLength(0);
  });

  it("§9: with the transport failing, the draft is stamped, the row waits, and the worker retries it to sent", async () => {
    const email = address();
    const d = await dueDraft(email);
    deliverMock.mockImplementation(unavailable);

    expect((await sweep()).status).toBe(200);
    const [row] = await rowsOf(email);
    await bornAgo([row!.id]);
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });

    const [failed] = await rowsOf(email);
    expect(failed).toMatchObject({ id: row!.id, status: "queued", attempts: 1 });
    expect(failed!.last_error).toMatch(/^http 503/);
    expect((await draftOf(d.id)).reminded_at, "the draft stays stamped: the outbox owns the retry now").not.toBeNull();

    deliverMock.mockImplementation(ok);
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${row!.id}`;
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });

    const [sent] = await rowsOf(email);
    expect(sent).toMatchObject({ id: row!.id, status: "sent", attempts: 2, cleared: true });
    const calls = callsFor(row!.id);
    expect(calls, "the failed attempt and the retry").toHaveLength(2);
    expect(calls[1]!.to).toBe(email);
    expect(calls[1]!.text, "the mail carries the draft's own token, on the claim page").toContain(`${ORIGIN}/start/claim?token=${d.token}`);
  });

  it("F6: two runs at the same time queue one reminder", async () => {
    const email = address();
    const d = await dueDraft(email);
    // The first run to reach this draft holds its transaction open a moment after its claim, so the other run has certainly read the
    // draft as due (its select does not wait for the claim's lock) before the claim commits: the race is forced, not hoped for.
    const real = vi.mocked(enqueueEmailOnce).getMockImplementation()!;
    let held = false;
    vi.mocked(enqueueEmailOnce).mockImplementation(async (db, m) => {
      if (m.refId === d.id && !held) {
        held = true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return real(db, m);
    });
    try {
      const [a, b] = await Promise.all([sweep(), sweep()]);
      expect([a.status, b.status]).toEqual([200, 200]);
    } finally {
      vi.mocked(enqueueEmailOnce).mockImplementation(real);
    }

    expect(held, "premise: the hold was reached").toBe(true);
    expect(enqueueCalls(d.id), "only the run that won the claim asked for the reminder").toHaveLength(1);
    expect((await rowsOf(email)).map((r) => r.ref_id)).toEqual([d.id]);
  });

  it("the once-key alone: a draft swept again after its stamp is cleared queues no second row", async () => {
    const email = address();
    const d = await dueDraft(email);

    expect((await sweep()).status).toBe(200);
    await sql`update funnel_drafts set reminded_at = null where id = ${d.id}`;
    expect((await sweep()).status).toBe(200);

    // Asked twice: nothing but the once-key stands between the second run and a second reminder.
    expect(enqueueCalls(d.id), "asked twice").toHaveLength(2);
    const rows = await rowsOf(email);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${d.id}:reminder`]);
    expect(rows[0]!.status).toBe("queued");
  });

  it("a malformed payload is stamped and queues nothing", async () => {
    // The positive pair is the well-formed draft beside it, in the same run.
    const bad = address();
    const good = address();
    const b = await dueDraft(bad);
    await sql`update funnel_drafts set payload = '{"bad":1}'::jsonb where id = ${b.id}`;
    const g = await dueDraft(good);

    expect((await sweep()).status).toBe(200);

    expect((await draftOf(b.id)).reminded_at, "stamped: never retried forever").not.toBeNull();
    expect(await rowsOf(bad)).toEqual([]);
    expect(enqueueCalls(b.id), "never asked").toHaveLength(0);
    expect((await draftOf(g.id)).reminded_at).not.toBeNull();
    expect(await rowsOf(good)).toHaveLength(1);
  });

  it("an enqueue that throws leaves the draft unstamped, and the next run reminds it", async () => {
    const email = address();
    const d = await dueDraft(email);
    const real = vi.mocked(enqueueEmailOnce).getMockImplementation()!;
    let thrown = 0;
    vi.mocked(enqueueEmailOnce).mockImplementation(async (db, m) => {
      if (m.refId === d.id && thrown === 0) {
        thrown++;
        throw new Error("enqueue refused (test)");
      }
      return real(db, m);
    });
    try {
      const failed = await sweep();
      expect(failed.status, "D1: a refused enqueue fails the run").toBe(500);
    } finally {
      vi.mocked(enqueueEmailOnce).mockImplementation(real);
    }

    expect(thrown, "premise: the refusal was reached").toBe(1);
    expect((await draftOf(d.id)).reminded_at, "the claim rolled back with the enqueue").toBeNull();
    expect(await rowsOf(email)).toEqual([]);

    expect((await sweep()).status).toBe(200);
    expect(await rowsOf(email)).toHaveLength(1);
    expect((await draftOf(d.id)).reminded_at).not.toBeNull();
  });

  it("another sport: a chess draft and a football draft each queue one reminder naming its own sport", async () => {
    const sports = ["chess", "football"] as const;
    const drafts = new Map<string, { token: string; email: string }>();
    for (const sport of sports) {
      const email = address();
      drafts.set(sport, { token: (await dueDraft(email, payloadOf(sport))).token, email });
    }

    expect((await sweep()).status).toBe(200);

    let checked = 0;
    for (const sport of sports) {
      const { email, token } = drafts.get(sport)!;
      const built = vi.mocked(funnelReminderEmail).mock.calls.filter(([a]) => a.link.endsWith(`?token=${token}`));
      expect(built.map(([a]) => a.sport), `${sport}: the builder was handed the draft's own sport`).toEqual([sport]);
      const rows = await rowsOf(email);
      expect(rows, `${sport}: one reminder`).toHaveLength(1);
      // The sport is in the body's sentence, which the worker's send carries: the row is sent and the HTML is read.
      await bornAgo([rows[0]!.id]);
      await runOutboxTick({ onlyIds: [rows[0]!.id], sleep: async () => undefined });
      const [call] = callsFor(rows[0]!.id);
      for (const other of sports) {
        const named = call!.html.includes(`(${other})`);
        expect(named, `${sport}'s reminder ${other === sport ? "names" : "does not name"} ${other}`).toBe(other === sport);
      }
      checked++;
    }
    expect(checked, "anti-vacuity: both sports were driven").toBe(sports.length);
  });

  it("empty: a used draft, an expired draft and a 23-hour-old draft queue nothing", async () => {
    const used = address();
    const expired = address();
    const young = address();
    const due = address();
    const u = await dueDraft(used);
    await sql`update funnel_drafts set used_at = now() where id = ${u.id}`;
    const e = await dueDraft(expired);
    await sql`update funnel_drafts set expires_at = now() - interval '1 minute' where id = ${e.id}`;
    const y = await createFunnelDraft(young, payloadOf());
    await sql`update funnel_drafts set created_at = now() - interval '23 hours' where id = ${y.id}`;
    // The positive pair, in the same run: a day-old draft is reminded.
    const p = await dueDraft(due);

    expect((await sweep()).status).toBe(200);

    let checked = 0;
    for (const [email, id] of [[used, u.id], [expired, e.id], [young, y.id]] as const) {
      expect(await rowsOf(email), email).toEqual([]);
      expect((await draftOf(id)).reminded_at, `${email} is not stamped`).toBeNull();
      expect(enqueueCalls(id), `${email} was never asked`).toHaveLength(0);
      checked++;
    }
    expect(checked, "anti-vacuity: every non-due draft was judged").toBe(3);
    expect(await rowsOf(due)).toHaveLength(1);
    expect((await draftOf(p.id)).reminded_at).not.toBeNull();
  });

  it("Q3: a draft started on /fr/start is reminded in French; one started with no language is reminded in English", async () => {
    // Driven through the real start route, which writes the language the /start page posts (its `[lang]` segment) on the draft, and
    // then through this route, which reads it back: the seam is proven end to end, not by a seeded column.
    const cases = [
      { locale: "fr", stored: "fr", expected: "fr" },
      { locale: undefined, stored: null, expected: "en" },
    ] as const;
    let checked = 0;
    for (const c of cases) {
      const label = c.locale ?? "no language";
      const email = address();
      const payload = payloadOf();
      const body = { email, ...payload, ...(c.locale === undefined ? {} : { locale: c.locale }) };
      const res = await start(new Request(`${ORIGIN}/api/funnel/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(res.status, `${label}: the start answered`).toBe(200);
      const [draft] = await sql<{ id: string; locale: string | null }[]>`select id, locale from funnel_drafts where email = ${email}`;
      expect(draft!.locale, `${label}: the draft remembers the visitor's language`).toBe(c.stored);
      await sql`update funnel_drafts set created_at = now() - interval '25 hours' where id = ${draft!.id}`;

      expect((await sweep()).status).toBe(200);

      const rows = await rowsOf(email);
      expect(rows, label).toHaveLength(1);
      expect(rows[0]!.subject, label).toBe(dictionarySubject(c.expected, "funnelReminder.subject", { competitionName: payload.name }));
      checked++;
    }
    expect(checked, "anti-vacuity: every case was driven").toBe(cases.length);
    // The French case can tell the draft's language from the fallback only while the dictionaries differ.
    expect(dictionarySubject("fr", "funnelReminder.subject", { competitionName: "x" })).not.toBe(
      dictionarySubject("en", "funnelReminder.subject", { competitionName: "x" }),
    );
  });
});
