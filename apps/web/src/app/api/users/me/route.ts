import { sql } from "@/lib/db";
import {
  requireUser,
  resolveActiveOrg,
  destroySession,
  invalidateUser,
  invalidateUserOrgs,
} from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { deleteAccountSchema, updateProfileSchema } from "@/lib/types";
import { sendAccountDeletionEmail } from "@/lib/email";
import { cancelBillingGroup } from "@/lib/billing";
import { groupIdsOwnedBy } from "@/lib/billing-group";
import { toLocale } from "@/lib/i18n";
import { unlinkLichess } from "@/server/usecases/external-accounts";
import { afterEndedBadly } from "@/server/email-outbox";
import { anonymiseChessInvites, deletedAccountPlaceholder } from "@/server/email-outbox/account-deletion";

/**
 * Whoami (task-8): resolves the same identity AnalyticsBootstrap used to read
 * via getCurrentUser()/cookies() directly in the ROOT layout — moved here so
 * that read no longer forces every route rendered through the root layout to
 * go dynamic whenever NEXT_PUBLIC_POSTHOG_KEY is set. The client-side
 * analytics bootstrap (lib/analytics-identity) fetches this per navigation
 * until identified (sessionStorage-memoized). 401 for anonymous callers; org
 * is null for a user with no org membership. Payload is minimized to what
 * the identify call consumes — no email (task-8 review F3).
 */
export async function GET() {
  const res = await handler(async () => {
    const user = await requireUser();
    const org = await resolveActiveOrg(user);
    if (!org) return { id: user.id, org: null };

    const [sub] = await sql<{ plan_key: string | null }[]>`
      select coalesce(s.plan_key, 'community') as plan_key
      from subscriptions s
      join organizations o on o.subscription_id = s.id
      where o.id = ${org.id}`;
    return {
      id: user.id,
      org: { id: org.id, name: org.name, plan: sub?.plan_key ?? "community" },
    };
  });
  // Identity endpoints must never be cacheable — set explicitly on EVERY
  // status (200 and 401 alike), not left to framework defaults + external
  // CDN rules (task-8 review F3).
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

/**
 * Update the authenticated user's profile: display name and/or timezone. Each
 * field is optional; an absent field is left untouched, a `timezone: null`
 * clears the preference ("follow my browser"). The zone is validated in the
 * schema (isValidIana) so the column only holds an Intl-parseable name.
 */
export async function PATCH(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const patch = updateProfileSchema.parse(await req.json());

    const [row] = await sql<{ display_name: string; timezone: string | null; locale: string | null }[]>`
      update users set
        display_name = ${patch.display_name ?? sql`display_name`},
        timezone     = ${patch.timezone !== undefined ? patch.timezone : sql`timezone`},
        locale       = ${patch.locale !== undefined ? patch.locale : sql`locale`}
      where id = ${user.id}
      returning display_name, timezone, locale`;

    // display_name/timezone/locale are cached in getCurrentUser — drop the stale entry.
    await invalidateUser(user.id);
    return { display_name: row.display_name, timezone: row.timezone, locale: row.locale };
  });
}

/**
 * Soft-delete the authenticated user's account.
 * Blocked if the user is the sole owner of any org that has other members.
 * Caller must pass { confirm: "DELETE" } to prevent accidental deletion.
 */
export async function DELETE(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    deleteAccountSchema.parse(await req.json());

    // Block if sole owner of any org with other members
    const blockedOrgs = await sql<{ name: string }[]>`
      select o.name from organizations o
      join org_members m on m.org_id = o.id and m.user_id = ${user.id} and m.role = 'owner'
      where (
        select count(*) from org_members m2
        where m2.org_id = o.id and m2.role = 'owner' and m2.user_id <> ${user.id}
      ) = 0
      and (
        select count(*) from org_members m3
        where m3.org_id = o.id and m3.user_id <> ${user.id}
      ) > 0`;

    if (blockedOrgs.length > 0) {
      const names = blockedOrgs.map((o) => `"${o.name}"`).join(", ");
      throw new HttpError(
        409,
        `You are the sole owner of ${names}. Transfer ownership or remove all other members before deleting your account.`,
      );
    }

    // Hand on (or shut down) every billing group this user PAYS for, before
    // org_members is emptied below — the heir is found through it.
    //
    // Since V314 billing gates on subscriptions.owner_user_id, so a group left
    // pointing at a deleted user is unmanageable by anyone: every billing route
    // 403s, nobody can cancel, and the card keeps being charged for ever. The
    // sole-owner 409 above does not cover this — an association can pay for
    // member clubs it is not a member of, so it owns groups it owns no orgs in.
    for (const subscriptionId of await groupIdsOwnedBy(user.id)) {
      // Oldest owner of any LIVE org in the group, other than the leaver.
      const [heir] = await sql<{ user_id: string }[]>`
        select m.user_id from org_members m
        join organizations o on o.id = m.org_id
        where o.subscription_id = ${subscriptionId}
          and o.deleted_at is null
          and m.role = 'owner'
          and m.user_id <> ${user.id}
        order by m.created_at, m.user_id
        limit 1`;
      if (heir) {
        await sql`
          update subscriptions set owner_user_id = ${heir.user_id}, updated_at = now()
          where id = ${subscriptionId}`;
      } else if (!(await cancelBillingGroup(subscriptionId))) {
        // Nobody left who could ever manage it — cancel rather than orphan.
        //
        // And STOP if that cancel did not happen. cancelBillingGroup returns
        // false without writing anything local when Stripe refuses, which
        // leaves the subscription live and still charging; carrying on would
        // anonymise and soft-delete this user a few lines below, after which
        // `owner_user_id` points at a deleted user, every billing route 403s
        // and nobody can ever cancel it. Nothing sweeps it up either —
        // reconcileGroupQuantities selects on `quantity_paid <> live org
        // count`, which this group satisfies perfectly well.
        //
        // Deletion is the irreversible half, so it is the half that yields:
        // fail loudly while the user still has an account (and a support path)
        // rather than destroy their data into a subscription that outlives
        // them. Retrying the same request once Stripe is reachable completes
        // the deletion — every step above it is idempotent.
        throw new HttpError(
          503,
          "We could not cancel your subscription just now, so your account has not been deleted — it would have kept being charged with nobody able to stop it. Please try again in a few minutes.",
        );
      }
    }

    // The Lichess link holds a SEALED board:play token (V451) — a credential
    // that can move pieces in any of this player's Lichess games. Deleting the
    // account is the strongest withdrawal of consent, so revoke the grant at
    // Lichess and drop the row, exactly as Unlink does. Placed AFTER every
    // refusal above (a refused deletion keeps its account, so it keeps its
    // link) and BEFORE the anonymisation, which is the irreversible half.
    // Idempotent: a retried deletion finds no row and sends nothing.
    await unlinkLichess(user.id);

    const purgeAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const anonEmail = deletedAccountPlaceholder(user.id);

    const endedInvites = await sql.begin(async (tx) => {
      // Remove from all orgs they were sole owner of (no other members — safe to dissolve)
      await tx`
        delete from org_members where user_id = ${user.id}`;

      // The email outbox keeps the sign-in emails it was asked to send to this account for its 90-day retention, with the real
      // address as the recipient, and it has no foreign key to users: left alone, the address would outlive the account's own
      // 30-day purge three times over. The rows go with the account, in THIS transaction, so the address is never left behind an
      // anonymised account: a failure here fails the deletion (which the person can simply retry) rather than complete it quietly.
      //
      // `tx` is the pooled PRIVILEGED client (this route has no tenant context; `app_user` holds INSERT only on email_outbox, V470),
      // so the delete is allowed, and it is the same role the retry worker writes the table as. Matched two ways: by the account's
      // ref (a magic_link row's ref is `user/<id>`, which also reaches mail sent to an address the account has since changed away
      // from) and by the address EXACTLY as the account stores it (which also reaches a row another ref wrote to it). Not case
      // folded: `users.email` is unique but case-sensitive, so `Ann@x.io` and `ann@x.io` are two live accounts, and a folded
      // match erased the other one's queued sign-in email (N-B). Only `magic_link`: a `chess_invite` row belongs to an
      // organiser's fixture, which outlives the player's account, so it is not deleted but anonymised, just below.
      await tx`
        delete from email_outbox
         where kind = 'magic_link'
           and (ref_id = ${user.id} or recipient = ${user.email})`;

      // The chess invites addressed to this account keep the address for the same 90 days, so it is taken out of them: replaced with the
      // placeholder the account itself is about to be given, and the ones still waiting to be sent are ended (nothing is mailed to a
      // deleted person). Same transaction, same connection. The rows it ended are returned for the seat hook, which runs after commit.
      const endedByDeletion = await anonymiseChessInvites(tx, { email: user.email, placeholder: anonEmail });

      // Soft-delete: anonymize PII, mark deleted, schedule purge
      await tx`
        update users set
          email         = ${anonEmail},
          password_hash = null,
          display_name  = 'Deleted User',
          google_sub    = null,
          avatar_url    = null,
          deleted_at    = now(),
          purge_after   = ${purgeAfter.toISOString()}
        where id = ${user.id}`;

      return endedByDeletion;
    });

    await invalidateUser(user.id);
    await invalidateUserOrgs(user.id);

    // Best-effort notification before destroying session
    await sendAccountDeletionEmail(user.email, toLocale(user.locale));
    await destroySession();

    // The invites the deletion ended are badly-ended rows like any other: the chess hook releases a seat whose every email has now ended,
    // so the board reads "still to invite" for the organiser. After the commit, as everywhere else the hooks run, and AFTER the sign-out:
    // the hook locks the board's bridge row, and a lock wait must not delay clearing the session cookie. It never throws (a hook that
    // fails is logged, and the worker's re-drive finishes the release), so it cannot fail a deletion that already committed.
    await afterEndedBadly(endedInvites);

    return { ok: true };
  });
}
