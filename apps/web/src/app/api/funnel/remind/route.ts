import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { funnelReminderEmail } from "@/lib/email";
import { funnelPayloadSchema } from "@/lib/funnel";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";

/** POST /api/funnel/remind — sweep unclaimed drafts older than 24h and queue
 *  the single reminder (v3/07 §6) on the email outbox (kind `funnel_reminder`).
 *  A cron-shaped endpoint: x-cron-secret header (CRON_SECRET env).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  The claim: per draft, one transaction stamps `reminded_at` only where it is
 *  still null and queues the reminder, so of two runs at once only the one
 *  whose stamp wrote a row asks for it (F6), the once-key `<draft id>:reminder`
 *  keeps a re-swept draft to one row, and a refused enqueue rolls the stamp
 *  back for the next run (D1: the run fails). The worker sends it, and retries
 *  a failed send (§9). Expired drafts are never revived. */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");

    const due = await sql<
      { id: string; token: string; email: string; payload: unknown; expires_at: Date; locale: string | null }[]
    >`
      select id, token, email, payload, expires_at, locale from funnel_drafts
      where used_at is null
        and reminded_at is null
        and created_at < now() - interval '24 hours'
        and expires_at > now()
      order by created_at
      limit 200`;

    let sent = 0;
    for (const draft of due) {
      const parsed = funnelPayloadSchema.safeParse(draft.payload);
      const id = await sql.begin(async (tx) => {
        const [won] = await tx`
          update funnel_drafts set reminded_at = now() where id = ${draft.id} and reminded_at is null returning id`;
        // Another run claimed it first. A malformed payload is stamped too — never retried forever.
        if (!won || !parsed.success) return null;
        return enqueueEmailOnce(tx, {
          kind: "funnel_reminder",
          refType: "funnel_draft",
          refId: draft.id,
          dedupeKey: onceKey("funnel_reminder", "funnel_draft", draft.id, "reminder"),
          orgId: null,
          to: draft.email,
          transactional: true,
          expiresAt: expiryWithin(new Date(draft.expires_at)),
          // D4: the language the visitor started the draft in (Q3), then `en` (a draft from before the column has none): there is no
          // account and no organisation to follow.
          ...(await funnelReminderEmail(
            {
              competitionName: parsed.data.name,
              sport: parsed.data.sport,
              link: `${baseUrl(req)}/start/claim?token=${draft.token}`,
            },
            await recipientLocale(tx, { pick: draft.locale, userId: null, orgDefault: null }),
          )),
        });
      });
      if (id) sent++;
    }

    return { due: due.length, sent };
  });
}
