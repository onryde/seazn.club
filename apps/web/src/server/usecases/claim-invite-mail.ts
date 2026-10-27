import "server-only";
// The claim invite's email (phase 3 wave 3): a person (`claim_invite`) or an official (`official_invite`) is invited to claim their
// profile, and the mail carries the claim's EMAIL secret, which signs them in. One helper for every path that mints such a claim: the
// organiser's console (`createClaimInvite`, both kinds) and the registration sweep (`maybeInviteClaim`, a person). It queues on the
// transaction that mints the claim, so the claim and its mail commit together; the caller makes the first attempt after commit.
import type { Tx } from "@/lib/db";
import { claimInviteEmail, officialInviteEmail } from "@/lib/email";
import { enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";

const RENDER = { claim_invite: claimInviteEmail, official_invite: officialInviteEmail } as const;

/**
 * Queue the invite for a claim minted on `tx`, and return the row's id. The language is the organisation's default (D4): the person is
 * unclaimed, so there is no account to follow, and nothing is looked up by address. Transactional (as the direct senders were): the
 * invite is the only way the person learns of the claim. The row lives no longer than the claim (`expiresAt`, its own deadline) or the
 * outbox's bound, whichever is sooner. Reads through `tx` only (a pooled read inside a tenant transaction would hold a second
 * connection, #996).
 */
export async function queueClaimInviteEmail(
  tx: Tx,
  a: {
    kind: "claim_invite" | "official_invite";
    refType: "person" | "official";
    refId: string;
    orgId: string;
    to: string;
    claimUrl: string;
    personName: string;
    orgName: string;
    expiresAt: Date;
  },
): Promise<string> {
  const [org] = await tx<{ default_locale: string | null }[]>`select default_locale from organizations where id = ${a.orgId}`;
  const locale = await recipientLocale(tx, { pick: null, userId: null, orgDefault: org?.default_locale ?? null });
  const content = await RENDER[a.kind]({ orgName: a.orgName, personName: a.personName, claimUrl: a.claimUrl }, locale);
  return enqueueEmail(tx, {
    kind: a.kind,
    refType: a.refType,
    refId: a.refId,
    orgId: a.orgId,
    to: a.to,
    transactional: true,
    expiresAt: expiryWithin(a.expiresAt),
    ...content,
  });
}
