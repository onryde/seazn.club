// What the owner READS when the payments card refuses — every refusal, not
// just the Stripe one.
//
// The whole card used to render `err.message` for anything it could not map,
// and every one of those messages is server-authored ENGLISH: the ToS gate,
// the owner-only 403s, "organization not found", "Stripe is not ready to
// accept charges yet", "Insufficient permissions". All four locales read
// them. The copy is now chosen PER STATUS from the dictionary, and the
// server's sentence goes to the console.
//
// Per status, deliberately not one generic: a refusal that tells the owner
// what to DO keeps that actionability in its own translated key (the 422 and
// the 409), while one that only means "it did not work" lands on the generic
// (404, 500). Each case below pins WHICH — routing every failure to the
// generic would pass a test that only asserted "not the server's English".
//
// renderToStaticMarkup cannot see this: the error only exists after a click,
// and `environment: "node"` has no DOM. renderIsland supplies React's hook
// dispatcher so the handler can be invoked the way a browser would.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "./_hook-harness";
import uiEn from "@/dictionaries/en/ui.json";

// The params object must be the SAME instance on every render. The mount
// effect lists `searchParams` in its deps, so handing back a fresh
// URLSearchParams each call makes the deps differ every render: effect →
// setConnect → re-render → effect… a hang, not a failure. renderToStaticMarkup
// never runs effects, which is why the sibling i18n test can get away with it.
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => nav.search,
}));

// Only `apiV1` is replaced — `ApiV1Error` stays REAL, because the component
// branches on `err instanceof ApiV1Error` and a lookalike class would make
// that check silently false and the test vacuous.
const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));

// Same treatment for the legacy client the two SAVE handlers use, and for the
// same reason: `ApiError` must be the real class or `err instanceof ApiError`
// is silently false and every save case falls to the default.
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));

import { ApiError } from "@/lib/client";
import { ApiV1Error } from "@/lib/client-v1";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { ONBOARDING_FAILED } from "@/server/usecases/stripe-connect";

/** The sentence the server sends on a masked Stripe failure. Imported, not
 *  typed out: this test's whole point is that the screen shows something
 *  ELSE, and a hand-copy that drifts from the server's wording would keep
 *  passing while proving nothing. */
const SERVER_502 = ONBOARDING_FAILED;
/** The server's own English for each refusal this card can provoke. None of
 *  these may appear on screen; each case asserts its own absence, because a
 *  blanket "no English anywhere" check would pass on a blank error too.
 *
 *  Hand-copied rather than imported, unlike ONBOARDING_FAILED: these are
 *  inline literals in the route and the use-case, not exported constants.
 *  Worth knowing what that buys — if the server reworded one of them, the
 *  negative here would go vacuous rather than red (the new sentence is also
 *  absent from the screen). The POSITIVE in each case is what actually holds
 *  the routing down, and it reads the shipped dictionary. */
const SERVER_422 = "Agree to the Terms of Service (entry-fee chargebacks) before connecting Stripe";
const SERVER_403 = "Only the org owner can manage Stripe Connect";
const SERVER_404 = "organization not found";
const SERVER_409 = "Stripe is not ready to accept charges yet";
const SERVER_401 = "Insufficient permissions";

/** Read from the shipped catalog, never typed out here: if the copy is
 *  reworded, these follow it instead of asserting yesterday's sentence. */
const EN = uiEn as Record<string, string>;
const ONBOARD_ERR = EN["pay.onboardErr"];
const TOS_FIRST = EN["pay.connectTosFirst"];
const OWNER_ONLY = EN["pay.connectOwnerOnly"];
const NEEDS_CHARGES = EN["pay.methodNeedsCharges"];
const SAVE_NOT_ALLOWED = EN["pay.saveNotAllowed"];
const SAVE_FAILED = EN["pay.saveFailed"];

/** Mount the owner's card with the onboarding POST failing as given. The GET
 *  the mount effect fires is answered separately — an unconnected org, which
 *  is the state that renders the Connect CTA. */
function mountWithFailure(failure: unknown) {
  apiV1Mock.mockReset().mockImplementation(async (_url: string, opts?: { method?: string }) => {
    if (opts?.method !== "POST") {
      return {
        connected: false,
        charges_enabled: false,
        details_submitted: null,
        payouts_enabled: false,
        disabled_reason: null,
        requirements_due: 0,
      };
    }
    throw failure;
  });
  return renderIsland(OrgPaymentInstructions, {
    orgId: "org-1",
    initialValue: null,
    isOwner: true,
  });
}

/** The primary CTA — the only element carrying both an onClick and the
 *  primary button class. Found by role rather than by copy so the test does
 *  not break when the label is translated. */
function clickConnect(island: ReturnType<typeof mountWithFailure>): Promise<void> {
  const btn = island
    .tree()
    .find(
      (el) =>
        typeof propsOf(el).onClick === "function" &&
        String(propsOf(el).className ?? "").includes("btn-primary"),
    );
  if (!btn) throw new Error("Connect CTA not found — the card did not render its onboarding button");
  return (propsOf(btn).onClick as () => Promise<void>)();
}

/** Mount the card for a NON-owner with the PATCH failing as given.
 *
 *  `isOwner: false` hides the whole Connect panel, which is what makes
 *  clickSave below unambiguous: the Save button is then the only primary
 *  button on the card. (The mount effect returns early for a non-owner, so
 *  apiV1 is never called here.) */
function mountSaveFailure(failure: unknown) {
  apiMock.mockReset().mockRejectedValue(failure);
  apiV1Mock.mockReset();
  return renderIsland(OrgPaymentInstructions, {
    orgId: "org-1",
    initialValue: null,
    isOwner: false,
    chargesEnabled: true,
  });
}

function clickSave(island: ReturnType<typeof mountSaveFailure>): Promise<void> {
  const btn = island
    .tree()
    .find(
      (el) =>
        typeof propsOf(el).onClick === "function" &&
        String(propsOf(el).className ?? "").includes("btn-primary"),
    );
  if (!btn) throw new Error("Save button not found — the instructions panel did not render");
  return (propsOf(btn).onClick as () => Promise<void>)();
}

/** Pick the "card at sign-up" radio, which is the control that provokes the
 *  409. Found by its testid, so translating the label cannot break it. */
async function pickCardMethod(island: ReturnType<typeof mountSaveFailure>): Promise<void> {
  const radio = island
    .tree()
    .find((el) => propsOf(el)["data-testid"] === "method-stripe");
  if (!radio) throw new Error("method-stripe radio not found — the method fieldset did not render");
  // The handler is `void saveMethod(...)`, so there is no promise to await —
  // let the rejection and its setState settle on the macrotask queue instead.
  (propsOf(radio).onChange as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Stripe onboarding failure copy", () => {
  it("shows the DICTIONARY sentence on a 502, not the server's English", async () => {
    const island = mountWithFailure(new ApiV1Error(SERVER_502, 502, "INTERNAL"));
    await clickConnect(island);
    const text = island.text();
    // Negative: the server-authored English is gone from the screen.
    expect(text).not.toContain(SERVER_502);
    expect(text).not.toContain("Stripe couldn't");
    // Positive pair — without it, an empty error or a dropped <p> also passes
    // the negative above. This is the localizable string, read from the dict.
    expect(ONBOARD_ERR).toBeTruthy();
    expect(text).toContain(ONBOARD_ERR);
  });

  it("keeps the ToS refusal ACTIONABLE on a 422 — its own key, not the generic", async () => {
    // The guard against over-routing. Routing every failure to
    // pay.onboardErr would satisfy the test above while destroying the one
    // refusal an owner can clear unaided, so this pins the SPECIFIC key: the
    // sentence still has to say "agree to the terms", in the reader's
    // language rather than the server's English.
    const island = mountWithFailure(new ApiV1Error(SERVER_422, 422, "ERROR"));
    await clickConnect(island);
    const text = island.text();
    expect(text).not.toContain(SERVER_422);
    expect(TOS_FIRST).toBeTruthy();
    expect(text).toContain(TOS_FIRST);
    // Independent of the line above: pins that this did NOT collapse into the
    // generic, which is the failure mode the whole per-status rule exists for.
    expect(text).not.toContain(ONBOARD_ERR);
  });

  it("names who to ask on a 403 — the owner-only refusal keeps its actionability", async () => {
    const island = mountWithFailure(new ApiV1Error(SERVER_403, 403, "FORBIDDEN"));
    await clickConnect(island);
    const text = island.text();
    expect(text).not.toContain(SERVER_403);
    expect(OWNER_ONLY).toBeTruthy();
    expect(text).toContain(OWNER_ONLY);
  });

  it("falls to the generic on a 404 — 'organization not found' tells an owner nothing", async () => {
    // The other half of the rule, and the reason this is a per-status map
    // rather than a key per status: a refusal with no action in it gets the
    // generic on purpose. Without this case, minting a key for every status
    // would still pass.
    const island = mountWithFailure(new ApiV1Error(SERVER_404, 404, "NOT_FOUND"));
    await clickConnect(island);
    const text = island.text();
    expect(text).not.toContain(SERVER_404);
    expect(text).toContain(ONBOARD_ERR);
    expect(text).not.toContain(OWNER_ONLY);
  });

  it("still shows the upgrade prompt on a 402, which has its own key", async () => {
    const island = mountWithFailure(
      new ApiV1Error("Plan upgrade required: registration.paid", 402, "PAYMENT_REQUIRED"),
    );
    await clickConnect(island);
    expect(island.text()).toContain((uiEn as Record<string, string>)["pay.needPro"]);
  });
});

describe("Payments-card SAVE failure copy", () => {
  it("tells the organiser to finish verification on a 409, not 'Failed to save'", async () => {
    // Reached by picking "card at sign-up" on a page whose Stripe account
    // cannot take charges — the server's half of the rule the radio already
    // enforces, so it is the stale-page state. Actionable, so it keeps a key
    // of its own.
    const island = mountSaveFailure(new ApiError(SERVER_409, 409));
    await pickCardMethod(island);
    const text = island.text();
    expect(text).not.toContain(SERVER_409);
    expect(NEEDS_CHARGES).toBeTruthy();
    expect(text).toContain(NEEDS_CHARGES);
    // Independent: proves it did not land on the generic save copy.
    expect(text).not.toContain(SAVE_FAILED);
  });

  it("names who to ask on a 401 — the legacy handler maps a role refusal to 401, not 403", async () => {
    const island = mountSaveFailure(new ApiError(SERVER_401, 401));
    await clickSave(island);
    const text = island.text();
    expect(text).not.toContain(SERVER_401);
    expect(SAVE_NOT_ALLOWED).toBeTruthy();
    expect(text).toContain(SAVE_NOT_ALLOWED);
  });

  it("falls to the generic save copy on a 500, and logs the server's sentence", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const island = mountSaveFailure(new ApiError("Internal error", 500));
      await clickSave(island);
      const text = island.text();
      expect(text).toContain(SAVE_FAILED);
      // Independent of the copy: the detail an operator needs did not vanish
      // when it stopped being the thing the organiser reads.
      expect(logged).toHaveBeenCalled();
      expect(String(logged.mock.calls[0][1])).toContain("Internal error");
    } finally {
      logged.mockRestore();
    }
  });
});
