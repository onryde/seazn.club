// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, setPlan } from "../harness.ts";

/** design/v9 PROMPT-55: the chargeback-liability copy is live on the public
 *  surfaces (same pages on free and pro — both plans' organisers are bound
 *  by the same clause), and connecting Stripe refuses without accepting it.
 *  The reversal itself is webhook-driven and covered by the DB-backed vitest
 *  suite; smoke pins what organisers actually read and click. Runs on its
 *  own org — the shared pro org already carries a smoke-flipped Connect
 *  account, which skips the first-connect gate by design. */
export async function disputeSurfacesSuite() {
  const terms = await html(newSession(), "/legal/terms");
  check(
    "p55: ToS carries the entry-fee chargeback clause",
    terms.status === 200 &&
      terms.body.includes("Entry-fee chargebacks") &&
      terms.body.includes("recovered from your connected Stripe balance"),
  );
  const helpCards = await html(newSession(), "/help/registration/card-payments");
  check(
    "p55: card-payments help states the lost-dispute outcome",
    helpCards.status === 200 && helpCards.body.includes("recovered from your Stripe balance"),
  );
  // First connect without accepting the terms is refused before any Stripe
  // call — asserts the server-side gate, not just the disabled checkbox
  // (keyless-safe: the 422 answers before getStripe()).
  const owner = newSession();
  const who = await signIn(owner, `delivered+tos_${tag}@resend.dev`);
  await setPlan(who.org_id, "pro", owner);
  const refused = await v1(owner, `/api/v1/orgs/${who.org_id}/connect`, "POST", {
    return_path: "/settings/connect",
  });
  check("p55: connect refuses without ToS agreement (422)", refused.status === 422);

  // Accounts v2 migration: the create call now carries two values v1's never
  // did — the owner's `users.email` as `contact_email`, and the org's name as
  // `display_name`. Stripe REQUIRES a contact email and rejects a blank
  // display name, so a deployed app that cannot produce them 400s on every
  // first connect, for every club, with nothing in the unit suites able to
  // notice (they seed their own rows).
  //
  // The email half needs no probe: `users.email` is `text not null unique`, so
  // a live session always resolves one. The NAME half does — `organizations.
  // name` is `text not null` with no non-empty CHECK — so assert the deployed
  // app really serves a non-blank name for the org this owner is about to
  // connect. Stopping short of POSTing with `tos_agreed: true` is deliberate:
  // against a smoke target holding a real test key, that would mint a genuine
  // Stripe account on every run. The wire shape is proven in
  // apps/web/src/server/usecases/__tests__/connect-accounts-v2-wire.test.ts.
  const myOrgs = (await call(owner, "/api/orgs")) as { id: string; name: string }[];
  const connecting = Array.isArray(myOrgs) ? myOrgs.find((o) => o.id === who.org_id) : undefined;
  check(
    "connect v2: the org an owner connects serves a non-blank name (the account's display_name)",
    !!connecting && typeof connecting.name === "string" && connecting.name.trim().length > 0,
  );
}
