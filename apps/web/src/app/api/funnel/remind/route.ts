import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { sendFunnelReminderEmail } from "@/lib/email";
import { funnelPayloadSchema } from "@/lib/funnel";

/** POST /api/funnel/remind — sweep unclaimed drafts older than 24h and send
 *  the single reminder (v3/07 §6). A cron-shaped endpoint: x-cron-secret
 *  header (CRON_SECRET env).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  Idempotent — reminded_at marks
 *  each draft, and expired drafts are never revived. */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");

    const due = await sql<{ id: string; token: string; email: string; payload: unknown }[]>`
      select id, token, email, payload from funnel_drafts
      where used_at is null
        and reminded_at is null
        and created_at < now() - interval '24 hours'
        and expires_at > now()
      order by created_at
      limit 200`;

    let sent = 0;
    for (const draft of due) {
      const parsed = funnelPayloadSchema.safeParse(draft.payload);
      if (parsed.success) {
        const ok = await sendFunnelReminderEmail(draft.email, {
          competitionName: parsed.data.name,
          sport: parsed.data.sport,
          link: `${baseUrl(req)}/start/claim?token=${draft.token}`,
        });
        if (ok) sent++;
      }
      // Malformed payloads are marked too — never retried forever.
      await sql`update funnel_drafts set reminded_at = now() where id = ${draft.id}`;
    }

    return { due: due.length, sent };
  });
}
