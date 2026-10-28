// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, check } from "../harness.ts";

/**
 * Email outbox, phase 1 (Task 5) smoke: POST /api/webhooks/resend refuses an event it cannot verify.
 * The smoke server runs in production mode, so both configurations answer 401: no RESEND_WEBHOOK_SECRET (the route fails
 * closed in production) and a secret with no valid Svix signature (unsigned, or signed with the wrong key). A 200 here would
 * mean anyone who knows the URL can suppress an address or mark an email delivered.
 */
export async function resendWebhookSmoke(): Promise<void> {
  const body = JSON.stringify({
    type: "email.bounced",
    data: { email_id: "re_smoke_unsigned", to: ["smoke-webhook@example.invalid"] },
  });
  const unsigned = await fetch(`${BASE}/api/webhooks/resend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  check("resend-webhook: an unsigned event is refused (401)", unsigned.status === 401);

  const forged = await fetch(`${BASE}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_smoke_forged",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    body,
  });
  check("resend-webhook: an event with a forged signature is refused (401)", forged.status === 401);
}
