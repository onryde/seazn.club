// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, call, check, tag, checkQueuedOutboxRow, smokeDb } from "../harness.ts";

/**
 * Email outbox, phase 3 wave 5 (Task 8): the +24 h funnel reminder, through the real cron route.
 *
 * A visitor starts a draft and never claims it. Aged 25 h in SQL (the route's due filter is `created_at < now() - 24 h`), the
 * draft is due, and `POST /api/funnel/remind` with the cron secret claims it and queues ONE `funnel_reminder` row (ref
 * `funnel_draft/<draft id>`, no organisation, addressed to the visitor's address: there is no account yet) for the worker to
 * send — no attempt in the request. A second run finds the draft stamped and queues nothing more.
 *
 * Needs the cron secret the server was started with: CI's smoke job sets `CRON_SECRET` at job level, so the server and this
 * script read one value. Skips with a passing line without it, as p72's cron legs do. The rows have no organisation, so no org
 * teardown reaches them: `finally` deletes this draft and the outbox rows about it (the start's claim email and the reminder).
 * SMOKE_ONLY=funnelReminder runs it alone (SELECTABLE_SUITES).
 */
export async function funnelReminderSuite(): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    check(
      "funnel reminder: skipped (no CRON_SECRET in the smoke env — the cron route cannot be called); the DB-backed vitest suites cover the route",
      true,
    );
    return;
  }

  const email = `delivered+funnel_remind_${tag}@resend.dev`;
  const db = smokeDb();
  let draftId: string | undefined;
  try {
    await call(newSession(), "/api/funnel/start", "POST", {
      email,
      name: `Funnel Reminder ${tag}`,
      sport: "Badminton",
      entrants: 8,
    });
    const [draft] = await db<{ id: string }[]>`
      select id from funnel_drafts where email = ${email} order by created_at desc limit 1`;
    draftId = draft?.id;
    check("funnel reminder: the start stored a draft for the visitor's address", !!draftId);
    if (!draftId) return;
    await db`update funnel_drafts set created_at = now() - interval '25 hours' where id = ${draftId}`;

    const remind = async (): Promise<{ status: number; sent: number | undefined }> => {
      const res = await fetch(`${BASE}/api/funnel/remind`, { method: "POST", headers: { "x-cron-secret": cronSecret } });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { sent?: number } };
      return { status: res.status, sent: body.data?.sent };
    };

    const first = await remind();
    check(
      "funnel reminder: the cron route answers 200 and queued at least one reminder (sent >= 1)",
      first.status === 200 && (first.sent ?? 0) >= 1,
    );
    await checkQueuedOutboxRow("funnel_reminder", "funnel_draft", draftId, { account: false });
    const [row] = await db<{ recipient: string; transactional: boolean }[]>`
      select recipient, transactional from email_outbox
       where kind = 'funnel_reminder' and ref_type = 'funnel_draft' and ref_id = ${draftId}`;
    check(
      "funnel reminder: the row is addressed to the visitor's address and is transactional",
      row?.recipient === email && row?.transactional === true,
    );

    const second = await remind();
    check("funnel reminder: a second cron run answers 200", second.status === 200);
    const [after] = await db<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where kind = 'funnel_reminder' and ref_type = 'funnel_draft' and ref_id = ${draftId}`;
    check("funnel reminder: the second run queues no second reminder (still one row)", after?.n === 1);
  } finally {
    if (draftId) {
      await db`delete from email_outbox where ref_type = 'funnel_draft' and ref_id = ${draftId}`;
      await db`delete from funnel_drafts where id = ${draftId}`;
    }
    await db.end();
  }
}
