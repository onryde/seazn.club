// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, walletIdForOrg, smokeDb, v1, v1data } from "../harness.ts";

/** #267 (SPEC-5 §2) + v17 gap #296: referral attribution + the new org's
 *  welcome grant — the part live traffic actually exercises through
 *  `/refer/<code>` (cookie set → a fresh signup's org creation stamps
 *  `referred_by_org_id`). Since #296 the welcome (+10) and onboarding (+10)
 *  earn grants no longer fire at signup — a scripted signup could farm 20
 *  credits per email — they pay out only once the org PUBLISHES a competition
 *  with a division, so this suite proves both halves: nothing at signup, both
 *  grants after publish. The referrer's own
 *  +20-on-the-referred-org's-first-paid-competition side needs a full Stripe
 *  checkout fixture and is already covered by `registrations.ts`'s unit tests
 *  — not re-proven here. Own fresh orgs; keyless-safe, no AI tokens spent. */
export async function referralSuite(): Promise<void> {
  const referrerEmail = `delivered+referrer_${tag}@resend.dev`;
  const referredEmail = `delivered+referred_${tag}@resend.dev`;

  const referrer = newSession();
  const referrerAuth = await signIn(referrer, referrerEmail);

  // Mint the referrer's shareable code with the same once-only,
  // never-overwrite UPDATE `getOrCreateReferralCode` uses — the mint race
  // itself is unit-tested; smoke only needs a live code to attribute against.
  const code = `SMK${tag}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const mint = smokeDb();
  try {
    await mint`
      update organizations set referral_code = ${code}
       where id = ${referrerAuth.org_id} and referral_code is null`;
  } finally {
    await mint.end();
  }

  // A fresh signup landing with the referrer's code in the `ref` cookie (as
  // the `/refer/<code>` route would set it) — attribution happens inside
  // `createOrgForUser` at account-creation time, not on this cookie-set step.
  const referred = newSession();
  referred.cookies.ref = code;
  const referredAuth = await signIn(referred, referredEmail);

  const walletId = await walletIdForOrg(referredAuth.org_id);
  const earnRows = async (): Promise<{ delta: number; idempotency_key: string }[]> => {
    const db = smokeDb();
    try {
      return await db<{ delta: number; idempotency_key: string }[]>`
        select delta, idempotency_key from ai_credit_ledger
         where wallet_id = ${walletId} and source = 'earn_grant'`;
    } finally {
      await db.end();
    }
  };

  const db = smokeDb();
  try {
    const [org] = await db<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${referredAuth.org_id}`;
    check(
      "referral: a signup via /refer/<code> stamps referred_by_org_id",
      org?.referred_by_org_id === referrerAuth.org_id,
    );
  } finally {
    await db.end();
  }

  // v17 gap #296: signup alone earns NOTHING — no onboarding, no welcome.
  check("referral/#296: signup alone earns no credits", (await earnRows()).length === 0);

  // The referred org publishes a competition WITH a division — the real-usage
  // signal both growth-loop grants are gated on since #296.
  referred.cookies["seazn_org"] = referredAuth.org_id;
  const comp = await v1(referred, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Referred Cup ${tag}` });
  check("referral/#296: the referred org creates a competition (201)", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;
  const div = await v1(referred, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  check("referral/#296: ...adds a division (201)", div.status === 201);
  const publish = await v1(referred, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "published",
  });
  check("referral/#296: ...and publishes it (200)", publish.status === 200);

  const rows = await earnRows();
  const byKey = new Map(rows.map((r) => [r.idempotency_key, r.delta]));
  check(
    "referral/#296: publish-with-division pays the +10 onboarding earn",
    byKey.get(`earn:onboarding:${referredAuth.org_id}`) === 10,
  );
  check(
    "referral/#296: publish-with-division pays the referred org's +10 welcome grant",
    byKey.get(`earn:referral_welcome:${referredAuth.org_id}`) === 10,
  );
}
