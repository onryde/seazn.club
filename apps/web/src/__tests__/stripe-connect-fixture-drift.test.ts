// scripts/stripe-connect-fixture.ts cannot IMPORT the app's Connect constants:
// it runs under plain `node --experimental-strip-types`, which resolves
// neither `server-only` nor the `@/` alias, so the account country is
// hand-copied there (its own comment explains why, and points here).
//
// A hand-copied literal is only safe if something fails when it drifts. This
// test is that something, and it lives in apps/web rather than beside the
// script because only here do both sides resolve — scripts/__tests__ runs from
// the repo root with no `@/` alias at all (ci.yml runs it with packages/engine's
// vitest binary). Same shape as the REQUIRED_CURRENCIES guard in
// stripe-sync.test.ts, which exists for exactly the same reason.
import { describe, expect, it } from "vitest";
import { CONNECT_ACCOUNT_DEFAULT_COUNTRY } from "@/server/usecases/stripe-connect";
import { FIXTURE_ACCOUNT_COUNTRY } from "../../../../scripts/stripe-connect-fixture.ts";

describe("Connect fixture script mirrors production's account country", () => {
  it("FIXTURE_ACCOUNT_COUNTRY tracks CONNECT_ACCOUNT_DEFAULT_COUNTRY", () => {
    // Accounts v2 requires identity.country before configuration.merchant may
    // be set. If production's default moves and the fixture's does not, the
    // local/CI destination-charge fixture is an account from a different
    // country than the one users get — a difference that shows up as a Stripe
    // capability or currency surprise, far from its cause.
    expect(FIXTURE_ACCOUNT_COUNTRY).toBe(CONNECT_ACCOUNT_DEFAULT_COUNTRY);
  });

  it("is a plausible ISO 3166-1 alpha-2 code, so neither side can drift to junk", () => {
    // The equality above is satisfied by two matching empty strings; the v2
    // API would reject that at create time, which is the worst place to learn.
    expect(FIXTURE_ACCOUNT_COUNTRY).toMatch(/^[A-Z]{2}$/);
  });
});
