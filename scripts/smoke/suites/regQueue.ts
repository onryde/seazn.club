// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, tag, html, v1, v1data } from "../harness.ts";

/** design/v7 PROMPT-52: the waitlist is a visible queue — the token status
 *  view carries a 1-based position and the public register card shows the
 *  queue length behind a full division.
 *
 *  RS001 (registration demolition) deleted the public submit endpoint this
 *  suite originally drove to build the queue; RS006 restored it (cart-shaped,
 *  `POST .../register`), and `registrationWaitlistPromoteSuite` (this file)
 *  now covers the actual position/public-count premise through the real API.
 *  What's left here is narrower: registration-settings still PUTs
 *  successfully, and the public register PAGE — the RS006 client stepper,
 *  not this suite's original queue widget — renders its OPEN state (the
 *  WHO step) for an enabled division with no window bounds set. Found live-
 *  broken this session (RS010): this suite's own division here has
 *  `enabled: true` and no `opens_at`/`closes_at`, so `windowOpen()`
 *  (registrations.ts:610) reads it as open — the page can never have shown
 *  the closed string this suite asserted for, per
 *  `register-page-live.test.tsx`'s own "not the closed message" case. */
export async function regQueueSuite(admin: Session): Promise<void> {
  // v1 writes land on the session's ACTIVE org (earlier suites switch it) —
  // resolve that org's slug, not the sign-in default's.
  const me = (await call(admin, "/api/users/me")) as {
    org: { id: string } | null;
  };
  const orgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const orgSlug = orgs.find((o) => o.id === me.org?.id)!.slug;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Queue Probe ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Tiny Queue",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  // RS001b: currency is ORG-level. The request schema has no `currency`, so a
  // per-division one sent here is ignored, and the response echoes the org's.
  // Sending 'usd' on a gbp org is the probe: if a per-division currency ever
  // comes back, a multi-division cart stops being payable in one Stripe
  // session — the exact fault RS001b removed.
  const regSettings = v1data<{ currency: string; fee_cents: number }>(
    await v1(admin, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      currency: "usd",
      capacity: 1,
      form_fields: [],
    }),
  );
  check(
    "RS001b: registration settings quote the ORG currency, not a per-division one",
    // 'gbp' is the org default and this org never set one — the assertion that
    // matters is that the 'usd' sent above did NOT stick anywhere.
    regSettings.currency === "gbp",
  );

  const registerPage = await html(newSession(), `/shared/${orgSlug}/${comp.slug}/register`);
  // RS010 fix — the ORIGINAL assertion here also required the closed string
  // to be ABSENT, which is not a reliable signal on this page: the literal
  // "Registration is not open for this competition." string is present in
  // the HTML regardless of state (it ships inside the client hydration
  // payload alongside every other dictionary string this page could ever
  // render, not just the one actually shown) — confirmed by fetching the
  // live page for this open division and finding both strings present at
  // once. The WHO step's own DOM id is the only reliable positive signal
  // that the page rendered its OPEN state (register-page-live.test.tsx
  // asserts the same id for the same reason).
  check(
    "public register page renders the OPEN stepper's WHO step (RS010 fix)",
    registerPage.status === 200 && registerPage.body.includes('id="reg-who-name"'),
  );
}
