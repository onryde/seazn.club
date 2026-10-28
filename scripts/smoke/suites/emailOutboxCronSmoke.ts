// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, check } from "../harness.ts";

/**
 * Email outbox, phase 1 (Task 4) smoke: POST /api/cron/email-outbox.
 * - a wrong secret is refused (401, or 503 when the server has no CRON_SECRET);
 * - with the server's CRON_SECRET in the smoke env, the right secret answers 200 with a tick report: a number for every
 *   key, and `failed === 0` (a tick that could not run, or a row whose attempt threw, would read 1 or more).
 * Every key is checked by name, so a renamed or dropped counter is a red here and not an "unreadable" the cron Worker
 * quietly turns into a Sentry event.
 */
export async function emailOutboxCronSmoke(): Promise<void> {
  const wrong = await fetch(`${BASE}/api/cron/email-outbox`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-wrong-email-outbox" },
  });
  check("email-outbox: cron wrong secret -> 401 (or 503 if CRON_SECRET unset)", wrong.status === 401 || wrong.status === 503);

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    check("email-outbox: cron right-secret shape skipped (no CRON_SECRET in smoke env)", true);
    return;
  }
  const right = await fetch(`${BASE}/api/cron/email-outbox`, { method: "POST", headers: { "x-cron-secret": secret } });
  if (right.status !== 200) {
    // The server's CRON_SECRET differs from the smoke env's: still a proven guard, nothing more to read.
    check("email-outbox: cron right-secret path skipped (server secret differs)", right.status === 401 || right.status === 503);
    return;
  }
  const body = (await right.json().catch(() => ({}))) as { ok?: boolean; data?: Record<string, unknown> };
  const KEYS = ["claimed", "sent", "retried", "dead", "suppressed", "expired", "failed", "deferred", "purged", "scrubbed"] as const;
  check(
    "email-outbox: cron runs a tick and answers a number for every report key",
    body.ok === true && KEYS.every((k) => typeof body.data?.[k] === "number"),
  );
  check("email-outbox: the tick reports failed 0 (the role can write the outbox and no attempt threw)", body.data?.failed === 0);
}
