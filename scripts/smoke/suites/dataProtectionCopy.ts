// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, check, html } from "../harness.ts";

/** #403 data protection review — the two disclosures that only count if they
 *  are actually served. A vitest render proves the component renders them; this
 *  proves the deployed page does, which is the form the claim takes in a DPA.
 *
 *  1. The scheduling name guard (#396) infers that two `persons` rows are one
 *     human from normalised-name equality. Non-persisted and scheduling-scoped,
 *     but a data subject has no other way to learn it happens.
 *  2. `ai_parse_previews` stores the organiser's raw instruction, which can
 *     carry personal data, so the privacy page states a retention period — and
 *     /api/cron/ai-previews is what enforces it. Asserting the endpoint EXISTS
 *     (401 on a bad secret, not 404) is the difference between a policy and a
 *     sentence: a stated retention period with no sweep behind it is worse than
 *     no statement at all.
 *
 *  Keyless-safe; no org, no Stripe, no AI spend. */
export async function dataProtectionCopySuite() {
  const privacy = await html(newSession(), "/legal/privacy");
  check(
    "#403: privacy page discloses the scheduling-only same-name grouping",
    privacy.status === 200 &&
      privacy.body.includes("treated as one player while a timetable is built") &&
      privacy.body.includes("No records are merged"),
  );
  check(
    "#403: privacy page states a retention period for stored instructions",
    privacy.status === 200 &&
      privacy.body.includes("deleted within the hour") &&
      privacy.body.includes("kept for 30 days"),
  );
  const subs = await html(newSession(), "/legal/sub-processors");
  check(
    "#403: every AI-scheduling sub-processor is disclosed",
    subs.status === 200 &&
      ["Anthropic", "OpenRouter", "Vertex AI", "xAI"].every((n) => subs.body.includes(n)),
  );
  // The sweep endpoint must exist and must be secret-gated. A 404 here means the
  // retention sentence above is unenforced.
  const sweep = await fetch(`${BASE}/api/cron/ai-previews`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-not-the-secret" },
  });
  check(
    "#403: the preview retention sweep exists and refuses a bad cron secret",
    sweep.status === 401 || sweep.status === 503,
  );
}
