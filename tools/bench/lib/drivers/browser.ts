// The registration BROWSER driver (B03r tasks 9+10, design §3: "browser —
// Playwright Chromium, one context per person ... Used by registration-ui").
// Implements the SAME `Organiser`/`Captain`/`Player` interfaces `http.ts`
// does (`./types.ts`) — `register.ts`'s `runRegistrationDivision` cannot
// tell the two apart, by design.
//
// Plain `playwright`, NEVER `@playwright/test` — this script runs under
// `node --experimental-strip-types` (matching `lib/env.ts`'s own Chromium
// check and `scripts/smoke.ts`), and `@playwright/test` is a test-runner
// export that does not exist under plain `playwright`. There is no `test()`
// wrapper anywhere in this file and no `expect` — every check below is a
// hand-rolled `assert()`.
//
// design §9: "browser drivers have no meaningful unit test (no jsdom rule)
// — this is their floor." Consistent with that, this file keeps every PURE
// piece (selector construction, the paid-status predicate, the poll loop
// with an injected fetcher, the failure-artefact path builder, the submit-
// status mapping) as its own exported function so those ARE unit-tested —
// see `__tests__/browser.test.ts`. Everything that actually drives a real
// `Page`/`BrowserContext` is exercised only by a live `_tiny` run (design
// §9's own "this run IS their coverage").
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { call, newSession, type Session } from "../http.ts";
import type {
  Captain,
  ConsentInput,
  EntryOutcome,
  EntryOutcomeStatus,
  JoinEntry,
  Organiser,
  OrganiserAction,
  PayableEntry,
  Player,
  RegistrationBlockConfig,
  RegistrationDivisionTarget,
  RegistrationEntry,
  RegistrationPlayer,
} from "./types.ts";
import { registrationPatchBody, registrationSettingsBody } from "./settings-body.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`browser.ts assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Session lifecycle — one BrowserContext per person (task brief), NEVER a
// shared/reused context. A bare `browser.newContext()` starts with no
// cookies at all, which is what keeps two people's sessions genuinely
// isolated (repo trap: a context that inherits another's auth state reads
// as "signed in" when it should not be) — every session below is minted
// fresh, never derived from another.
// ---------------------------------------------------------------------------

export interface RegistrationBrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** `chromium.executablePath()`'s existence is `lib/env.ts`'s own pre-flight
 *  check (`checkChromiumInstalled`) — this file does not repeat it; a
 *  missing binary surfaces here as `launch()`'s own thrown error. */
export async function launchRegistrationBrowser(): Promise<Browser> {
  return chromium.launch();
}

/**
 * The FIRST half of `lib/http.ts`'s `signIn()` — a magic-link REQUEST,
 * stopping short of `/consume` — reused here (via `http.ts`'s own exported
 * `call()`, never a hand-rolled `fetch`) rather than duplicated by hand.
 * The browser itself performs the SECOND half by navigating to the returned
 * `login_url` (`page.goto`), exactly as the task brief specifies — a real
 * magic-link consume, through the real page, is what actually sets the auth
 * cookie in THIS BrowserContext (a `fetch`-based `/consume` call would set a
 * cookie in a `Session`'s cookie jar that this browser never sees).
 */
async function requestMagicLinkUrl(base: string, email: string): Promise<string> {
  const throwaway: Session = newSession();
  const data = (await call(base, throwaway, "/api/auth/magic-link", "POST", { email })) as { login_url?: string };
  if (!data.login_url) throw new Error(`requestMagicLinkUrl(): magic-link request for "${email}" returned no login_url`);
  return data.login_url;
}

/** A signed-in session — the organiser's own identity, established via a
 *  real magic-link consume driven through the page (see
 *  `requestMagicLinkUrl`'s doc comment). */
export async function newOrganiserBrowserSession(browser: Browser, base: string, email: string): Promise<RegistrationBrowserSession> {
  const loginUrl = await requestMagicLinkUrl(base, email);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(loginUrl);
  // `MagicLink` (components/magic-link.tsx) consumes the token CLIENT-SIDE,
  // in a useEffect that fires after hydration — `page.goto()` resolving
  // proves the page loaded, not that the session cookie has landed. Without
  // this wait, `configureRegistrationViaApi`'s immediate PATCH/PUT (fired
  // right after this function returns, with no intervening navigation) races
  // the consume and 401s — reproduced locally (`browserOrganiser.
  // configureRegistration(): division ... — PATCH 401, PUT 401`), the exact
  // convention e2e's own `loginUi` already applies (`e2e/helpers.ts:429`).
  // `tap-play.ts`'s organiser flow never hit this: it navigates the console
  // page and waits up to 15s on `device-handover` afterwards, which happens
  // to outlast the race — an accident, not a guarantee.
  await page.waitForURL((u) => !u.pathname.startsWith("/login") && !u.pathname.startsWith("/magic-link"), {
    timeout: 20_000,
  });
  return { context, page };
}

/** A cookie-less session — every public registration route (submit, join,
 *  checkout, the status/poll read) needs no auth at all; a captain or
 *  player never signs in. */
export async function newAnonymousBrowserSession(browser: Browser): Promise<RegistrationBrowserSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

export async function closeRegistrationBrowserSession(session: RegistrationBrowserSession): Promise<void> {
  await session.context.close();
}

// ---------------------------------------------------------------------------
// Pure parts — selector construction, the submit-status mapping, the
// paid-status predicate, the poll loop (fetcher injected), the failure-
// artefact path builder. Unit-tested directly; no Page/Browser involved.
// ---------------------------------------------------------------------------

/** `[data-registration-hub-registrant-row][data-registration-id="…"]` —
 *  `registration-hub-registrant-table.tsx:267-269`. */
export function hubRegistrantRowSelector(registrationId: string): string {
  return `[data-registration-hub-registrant-row][data-registration-id="${registrationId}"]`;
}

/** `[data-registration-hub-registrant-action="approve|reject|promote|…"]`,
 *  scoped to one row — `registration-hub-registrant-actions.tsx:407-483`. */
export function hubRegistrantActionSelector(registrationId: string, action: string): string {
  return `${hubRegistrantRowSelector(registrationId)} [data-registration-hub-registrant-action="${action}"]`;
}

/** `[data-registration-hub-assign-action="open|unassign"]`, scoped to one
 *  row — `registration-hub-assign-picker.tsx:299-313`. */
export function hubAssignActionSelector(registrationId: string, action: "open" | "unassign"): string {
  return `${hubRegistrantRowSelector(registrationId)} [data-registration-hub-assign-action="${action}"]`;
}

/** `[data-registration-hub-assign-target="…"]` — the candidate-team button
 *  inside the (already-open) assign-picker dialog —
 *  `registration-hub-assign-picker.tsx:381-395`. Not row-scoped: the picker
 *  renders as a fixed-position dialog outside the row's own DOM subtree. */
export function hubAssignTargetSelector(targetRegistrationId: string): string {
  return `[data-registration-hub-assign-target="${targetRegistrationId}"]`;
}

/**
 * `label[data-category="mens"|"womens"|"mixed"|"open"]` —
 * `division-builder.tsx:655-670`, `B03r-repins-2026-09-03.md`'s two traps:
 * `data-category` is on the LABEL, never the underlying (`sr-only`) radio —
 * clicking the radio directly is "not visible"/gets intercepted — and the
 * enclosing fieldset is closed on mount (`tab` state defaults to `"basics"`
 * — see this file's own `division-builder.tsx` caller for opening the
 * eligibility tab first). Exported as a pure selector builder for a FUTURE
 * caller that drives the wizard (`_tiny`'s own registration division never
 * does — see this file's header comment on why division creation is always
 * the plain `POST .../divisions` call, one of `B03r-repins-2026-09-03.md`'s
 * pinned API-surface rows, not a UI flow).
 */
export function divisionBuilderCategorySelector(category: string): string {
  return `label[data-category="${category}"]`;
}

/** Mirrors `drivers/http.ts`'s own (unexported) `mapSubmitStatus` — same
 *  vocabulary, same "unrecognised value throws rather than guesses" rule
 *  (registration-submit.ts:739,850-851: only "waitlisted"/"pending"/
 *  "confirmed" are ever assigned at submit time). Duplicated rather than
 *  imported because `drivers/http.ts` exports no such symbol; kept in sync
 *  by the SAME `http.test.ts`-style fixture assertions this file's own
 *  tests carry.
 *
 *  "paid" is the BROWSER driver's own addition, and it is not a submit-time
 *  status in the sense the name implies. The http driver reads the submit
 *  RESPONSE, where a row can only be waitlisted/pending/confirmed. The browser
 *  driver reads the STATUS PAGE, and a pay-up-front entry only reaches that
 *  page after hosted Checkout has settled — by which point the row says
 *  "paid". The vocabulary was enumerated from the free path, so the first
 *  successful live payment ended in this function throwing on its own success.
 *
 *  It maps to "pending", not "approved": paid means the money moved, not that
 *  the organiser admitted the entry. Under `approval: "manual"` a paid entry
 *  still waits for a human, and `classifyFunnelOutcome` already counts
 *  pending/paid/confirmed alike as entrants — so the funnel arithmetic is
 *  unchanged and the approval semantics stay honest. */
export function mapSubmitStatus(status: string): EntryOutcomeStatus {
  switch (status) {
    case "waitlisted":
      return "waitlisted";
    case "confirmed":
      return "approved";
    case "pending":
      return "pending";
    case "paid":
      return "pending";
    default:
      throw new Error(`mapSubmitStatus(): unrecognised submit-time registration status "${status}"`);
  }
}

/** The exact two eligibility codes design §5.2 / `drivers/http.ts` check —
 *  duplicated for the same "no exported symbol to import" reason as
 *  `mapSubmitStatus`. Exact-match only, never `.includes()` — see
 *  `drivers/http.ts`'s own doc comment on why a substring match would
 *  misclassify an unrelated "…ELIGIBILITY…" code as this family. */
const ELIGIBILITY_ERROR_CODES = new Set(["ELIGIBILITY", "ELIGIBILITY_VIOLATION"]);

/** design §5.2/§5.3: "paid" AND "confirmed" are both legitimate post-payment
 *  terminal states (`register.ts`'s `PAID_STATUSES` — auto-approval lands
 *  on "confirmed", manual-approval stays at "paid"). Mirrored here, not
 *  imported (`register.ts` exports no such constant), for the SAME
 *  duplication reason as `mapSubmitStatus`. */
export function isPaidStatus(status: string): boolean {
  return status === "paid" || status === "confirmed";
}

export interface PollResult {
  readonly status: string;
}

/**
 * The paid-status poll (design §5.3: "Paid-status poll timeout → red (an
 * unpaid entry is a wrong STATE, not a slow one)"). Pure over an injected
 * `fetchStatus` — no `Page`/network here, which is what makes this
 * unit-testable with a fake that returns a scripted sequence of statuses
 * (see `__tests__/browser.test.ts`). Never asserts a wall-clock BUDGET as a
 * pass/fail signal on its own timing (`_RULES.md` §1's load-sensitive-timing
 * rule) — the timeout below is a functional gate ("did the entry ever reach
 * paid/confirmed"), not a performance measurement; nothing here reports
 * elapsed time as a finding.
 */
export async function pollUntilPaid(
  fetchStatus: () => Promise<PollResult>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let last: PollResult;
  for (;;) {
    last = await fetchStatus();
    if (isPaidStatus(last.status)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntilPaid(): status never reached paid/confirmed within ${timeoutMs}ms — last observed status "${last.status}" ` +
          `(a wrong STATE, not a slow one — design §5.3)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Screenshot + trace paths (`report.ts`'s `FailureArtefact`) for one
 *  failed step, namespaced by run so two runs' failures never collide.
 *  Pure — the caller decides whether/when to actually write to either
 *  path. */
export function failureArtefactPaths(runTag: string, label: string): { screenshotPath: string; tracePath: string } {
  const safe = label.replace(/[^A-Za-z0-9_.-]/g, "-");
  const dir = `bench-report/registration-failures/${runTag}`;
  return { screenshotPath: `${dir}/${safe}.png`, tracePath: `${dir}/${safe}.trace.zip` };
}

// ---------------------------------------------------------------------------
// Organiser — configureRegistration via the SAME session's own authenticated
// API request context (playwright's `context.request` shares cookies with
// its pages — a real Playwright capability, not a bypass: the organiser's
// page already carries the auth cookie from `newOrganiserBrowserSession`'s
// real magic-link consume). `act()` drives the REAL hub UI — the registrant
// row is a `<details>` disclosure (`registration-hub-registrant-table.tsx`)
// closed by default, so every action opens its row first.
//
// `configureRegistration` deliberately does NOT drive the hub's config
// modal (`registration-hub-config-panel.tsx`) through the DOM: no testid is
// owed to it (`B03r-repins-2026-09-03.md`'s FP2 table lists only the
// registrant-action and assign-action attributes for organiser ACTIONS, not
// division configuration), and its accordion-sectioned fields have not been
// pinned by this task. `PATCH .../divisions/{id}` + `PUT .../registration-
// settings` — the exact two calls `use-registration-hub-config.ts:87-100`
// itself fires — are driven directly instead, over the SAME authenticated
// context.
// ---------------------------------------------------------------------------

async function configureRegistrationViaApi(
  session: RegistrationBrowserSession,
  base: string,
  divisionId: string,
  block: RegistrationBlockConfig,
): Promise<void> {
  const api = session.context.request;
  const patchBody = registrationPatchBody(block);
  const putBody = registrationSettingsBody(block);
  const [patchRes, putRes] = await Promise.all([
    api.fetch(`${base}/api/v1/divisions/${divisionId}`, { method: "PATCH", data: patchBody }),
    api.fetch(`${base}/api/v1/divisions/${divisionId}/registration-settings`, { method: "PUT", data: putBody }),
  ]);
  if (!patchRes.ok() || !putRes.ok()) {
    throw new Error(
      `browserOrganiser.configureRegistration(): division ${divisionId} — PATCH ${patchRes.status()}, PUT ${putRes.status()}`,
    );
  }
}

/** Opens a registrant row's `<details>` disclosure if it is not already
 *  open — its action buttons (`registration-hub-registrant-actions.tsx`)
 *  render only inside the disclosure body, so a closed row's buttons are
 *  attached but not visible/clickable. */
async function openRegistrantRow(page: Page, registrationId: string): Promise<void> {
  const row = page.locator(hubRegistrantRowSelector(registrationId));
  await row.waitFor({ state: "attached" });
  const isOpen = await row.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await row.locator("summary").click();
}

async function actViaHub(
  session: RegistrationBrowserSession,
  base: string,
  orgSlug: string,
  competitionSlug: string,
  action: OrganiserAction,
): Promise<void> {
  const { page } = session;
  // Fresh navigation per action — `applyOrganiserActions` runs strictly
  // sequentially for exactly this reason (a stale row list could show a
  // captain's promote button after an earlier action already moved them).
  await page.goto(`${base}/o/${orgSlug}/c/${competitionSlug}/registration?tab=registrants`);
  await openRegistrantRow(page, action.registrationId);

  if (action.action === "assign_free_agent") {
    assert(action.targetRegistrationId, `act(): "assign_free_agent" on ${action.registrationId} needs targetRegistrationId`);
    await page.locator(hubAssignActionSelector(action.registrationId, "open")).click();
    await page.locator(hubAssignTargetSelector(action.targetRegistrationId)).click();
    return;
  }

  await page.locator(hubRegistrantActionSelector(action.registrationId, action.action)).click();
}

export function browserOrganiser(session: RegistrationBrowserSession, base: string, orgSlug: string, competitionSlug: string): Organiser {
  return {
    configureRegistration: (divisionId, block) => configureRegistrationViaApi(session, base, divisionId, block),
    act: (action) => actViaHub(session, base, orgSlug, competitionSlug, action),
  };
}

// ---------------------------------------------------------------------------
// Captain — drives the public register stepper for `enter()`, hosted Stripe
// Checkout for `pay()`.
//
// The stepper's Back/Next row and step-who's "I'm playing" checkbox carried no
// stable selector when this driver was first written, so it located them
// structurally — `div.relative.z-50.flex button` nth(1), and "the first
// checkbox on the page". Both were disclosed as a KNOWN GAP rather than
// papered over, which was right, and the first live run then failed on exactly
// them: `locator.check: Timeout waiting for '[data-testid="reg-consent-grant"]'`,
// because the wizard had never advanced off the "who" step.
//
// They are real hooks now (`reg-next`, `reg-back`, `reg-who-playing`). The
// owner's rule is to add a testid only where NO stable selector exists, which
// is exactly this case — as against the registration hub, where `data-field` /
// `data-action` already existed and adding testids was ruled against.
//
// The structural locators were not merely ugly, they were wrong in a way no
// unit test could see: `step-who.tsx:108` renders that checkbox only when
// `showSelfToggle` is true, so "the first checkbox on the page" silently
// resolved to a DIFFERENT control whenever the toggle was absent — checking
// someone else's box and reporting success.
// ---------------------------------------------------------------------------

/** The stepper's "Next" action. `reg-submit` REPLACES it on the review step
 *  (`register-stepper.tsx`'s own ternary), so a driver that has reached review
 *  must click that instead — this locator resolves to nothing there. */
function stepperNextButton(page: Page) {
  return page.locator('[data-testid="reg-next"]');
}

async function clickStepperNext(page: Page): Promise<void> {
  await stepperNextButton(page).click();
}

/**
 * `_tiny`'s own registration division is `entrantKind: "individual"` on a
 * competition with exactly one open registration division — `steps.ts`'s
 * `shouldCollapseEntries` therefore collapses the "entries" step entirely
 * (the single division auto-seeds into the cart), so this driver assumes
 * the step order is `["who", "details", "consent", "review"]` and never
 * touches a division-picker. A team/pair pack, or a competition with more
 * than one open registration division, needs `shouldCollapseEntries`'s
 * OTHER branch — out of `_tiny`'s own floor, and NOT implemented here (a
 * later suite's own task should widen this).
 *
 * `onAccessToken` captures the group's `access_token` from the URL the
 * registrant LANDS on, not from the submit response — the response body is
 * unreadable by then (see the long note at the submit step below for why the
 * browser has already discarded it). `resolvePostSubmitNavigation` puts the
 * token in the status page's query string, which is the only place a
 * registrant ever sees it; `entry-card.tsx` renders no attribute carrying it.
 * `pay()`, called later on the SAME `Captain` object, uses it to mint its own
 * checkout session, so `PayableEntry` needs no `token` field
 * `drivers/types.ts` does not declare.
 */
async function enterViaStepper(
  session: RegistrationBrowserSession,
  base: string,
  division: RegistrationDivisionTarget,
  entry: RegistrationEntry,
  onAccessToken: (token: string) => void,
  /** Called when this entry paid during submit (a pay-up-front division), so
   *  the captain's own `pay()` verifies rather than minting a SECOND session
   *  against a registration that is already settled — which the product
   *  refuses with a 422 on `reg.status === "pending"`. */
  onPaidDuringEnter: () => void,
): Promise<EntryOutcome> {
  const { page } = session;
  await page.goto(`${base}/shared/${division.orgSlug}/${division.competitionSlug}/register`);

  // Step "who".
  await page.locator("#reg-who-name").fill(entry.contact.name);
  await page.locator("#reg-who-email").fill(entry.contact.email);
  if (entry.registeringSelf) {
    // "I'm playing" (step-who.tsx). Rendered only when `showSelfToggle` is
    // true, which is why the old "first checkbox on the page" locator was
    // unsafe: with the toggle absent it resolved to an unrelated control.
    await page.locator('[data-testid="reg-who-playing"]').check();
  }
  if (entry.contact.dob) {
    const dob = page.locator("#reg-who-dob");
    await dob.waitFor({ state: "visible" }); // shown only once dob is required (imPlaying / age band)
    await dob.fill(entry.contact.dob);
  }
  if (entry.contact.gender) {
    await page.locator("#reg-who-gender").selectOption(entry.contact.gender);
  }
  await clickStepperNext(page);

  // Step "details" — the roster. NOT a no-op, which is what the first three
  // live runs assumed: `validateDetails` requires every player row's name, so
  // an unfilled row leaves `goNext` refusing to advance. The wizard then sits
  // on "details" while the driver waits out 30s for a consent control that
  // only renders once the step actually changes — the failure reads as a
  // missing selector and is really a blocked transition.
  //
  // Row 0 is the captain themself for a self-registering individual entry;
  // `entry.roster` carries any further players.
  const rosterNames = (entry.players ?? []).map((p) => p.fullName);
  // A self-registering individual entry may declare no `players` at all — the
  // contact IS the sole player, and the stepper still renders one row for
  // them. Fall back to the contact's own name rather than skipping the step,
  // which is precisely the assumption that stalled the first three runs.
  const names = rosterNames.length > 0 ? rosterNames : [entry.contact.name];
  for (const [i, fullName] of names.entries()) {
    const field = page.locator(`[data-testid="reg-roster-name"][data-player-row="${i}"]`);
    await field.waitFor({ state: "visible" });
    await field.fill(fullName);
  }
  await clickStepperNext(page);

  // Step "consent".
  if (entry.privacyConsent) {
    await page.locator('[data-testid="reg-consent-grant"]').check();
  }
  if (entry.contact.guardianConsent) {
    await page.locator("#reg-guardian-name").fill(entry.contact.guardianName ?? "");
    await page.locator("#reg-guardian-consent").check();
  }
  await clickStepperNext(page);

  // Step "review" — submit, and capture the REAL submit response (the only
  // place registration_id/group_id/access_token are ever exposed).
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/register$/.test(new URL(r.url()).pathname)),
    page.locator('[data-testid="reg-submit"]').click(),
  ]);

  if (response.status() >= 400) {
    const body: unknown = await response.json().catch(() => undefined);
    const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (response.status() === 422 && typeof code === "string" && ELIGIBILITY_ERROR_CODES.has(code)) {
      return { status: "rejected_eligibility", ref: "" };
    }
    if (response.status() < 500) {
      return { status: "unexpected_error", ref: "", errorDetail: { httpStatus: response.status(), body } };
    }
    throw new Error(`browserCaptain.enter(): unexpected HTTP ${response.status()} from public submit`);
  }

  // The success body is NOT read here, deliberately. On success the stepper
  // immediately navigates to the status page, and Playwright's
  // `response.json()` then fails with
  //   Protocol error (Network.getResponseBody): No resource with given
  //   identifier found
  // because the browser has already discarded the body of a request whose page
  // is gone. That is a race, not a flake: widening a timeout cannot fix it, and
  // it only appears in a real browser, which is why three green unit suites and
  // the http driver never saw it.
  //
  // Everything needed is on the page the registrant actually lands on. The URL
  // carries the GROUP's rid + token (`submit.ts`'s `resolvePostSubmitNavigation`),
  // and each entry's own id and status are on its status badge. Reading them
  // there is also the stronger assertion: it proves the UI agrees, rather than
  // trusting a payload the customer never sees.
  //
  // A paid-up-front entry redirects to Stripe FIRST and only reaches the status
  // page after paying, which is the whole reason the branch below exists.
  await page.waitForURL(
    (url) => url.pathname.includes("/register/status") || url.hostname.includes("checkout.stripe.com"),
  );

  if (page.url().includes("checkout.stripe.com")) {
    // Paid up front: the registrant is standing on hosted Checkout right now,
    // so pay from here and follow the return redirect to the status page. The
    // id and token are then read exactly as they are on the free path.
    //
    // This branch used to `return { status: "pending", ref: "" }` and leave the
    // payment to `pay()`. That was unreachable-by-construction: `register.ts`
    // only calls `pay()` when `entry.pay && outcome.ref`, and the ref it just
    // returned is empty — so a pay-up-front entry was never paid, and the
    // organiser step then waited 30s on `[data-registration-id=""]`. Found by
    // running it; no unit test could see it, because the redirect only happens
    // against a division a real Stripe account can charge for.
    await completeHostedCheckout(page);
    onPaidDuringEnter();
    await page.waitForURL((url) => url.pathname.includes("/register/status"), { timeout: 60_000 });
  }

  const landed = new URL(page.url());
  const token = landed.searchParams.get("token");
  if (token !== null && token !== "") onAccessToken(token);

  const outcome = page.locator('[data-testid="reg-status-outcome"]').first();
  await outcome.waitFor({ state: "visible" });
  const domStatus = await outcome.getAttribute("data-status");
  const registrationId = await outcome.getAttribute("data-registration-id");
  if (domStatus === null || registrationId === null) {
    throw new Error(
      "browserCaptain.enter(): the status badge carried no data-status/data-registration-id — " +
        "read those attributes, never the visible label (it is an i18n string in four locales)",
    );
  }

  return { status: mapSubmitStatus(domStatus), ref: registrationId };
}

/**
 * Pays the hosted Checkout page the browser is currently on, with the test
 * card the brief names verbatim. Reached from BOTH directions:
 *
 *  - `pay()` after minting a session (a promotion off the waitlist, or any
 *    entry whose submit did not itself redirect), and
 *  - `enter()` when the submit redirected straight here, which is what a
 *    pay-up-front division actually does to a registrant.
 *
 * Extracted because the second caller did not exist until a live run found
 * that it had to: on a paid division the stepper never lands on the status
 * page at all, so an `enter()` that returned early there produced an empty
 * registration id, and `register.ts`'s `if (entry.pay && outcome.ref)` then
 * SKIPPED the payment for exactly the entries that needed it — silently, with
 * the failure surfacing one step later as an organiser action waiting on
 * `[data-registration-id=""]`.
 */
async function completeHostedCheckout(page: Page): Promise<void> {
  await page.waitForURL((url) => url.hostname.includes("checkout.stripe.com"));

  // The card fields are always there. Stripe's own hosted Checkout ids
  // (`stripe:test-cards`); the card number is the brief's verbatim test card.
  await page.locator("#cardNumber").fill("4242 4242 4242 4242");
  await page.locator("#cardExpiry").fill("12/34");
  await page.locator("#cardCvc").fill("123");

  // The BILLING fields are not. Which of them Checkout renders depends on the
  // connected account's country and the session's own address-collection
  // settings — this run's fixture account shows a cardholder name and no
  // postal code, and an unconditional `#billingPostalCode` fill spent the full
  // 30s locator budget waiting for a field Stripe was never going to draw.
  // Filling what is present, rather than asserting a field set we do not
  // control, is the only version of this that survives a fixture change.
  for (const [selector, value] of [
    ["#billingName", "Bench Tester"],
    ["#billingPostalCode", "94107"],
  ] as const) {
    const field = page.locator(selector);
    if ((await field.count()) > 0 && (await field.first().isVisible())) {
      await field.first().fill(value);
    }
  }

  await page.locator(".SubmitButton, button[type=submit]").click();
}

async function payViaCheckout(session: RegistrationBrowserSession, base: string, entryId: string, token: string): Promise<void> {
  const api = session.context.request;
  const mint = await api.fetch(`${base}/api/v1/public/registrations/${entryId}/checkout`, { method: "POST", data: { token } });
  if (!mint.ok()) {
    // The BODY, not just the status. `resumeRegistrationCheckout` refuses for
    // six distinct reasons (wrong status, non-stripe payment method, zero
    // amount, passed deadline, charges not enabled, no connected account —
    // usecases/registrations.ts:4350-4387) and every one of them is a 422.
    // A bare "HTTP 422" names none of them and sends the next reader to read
    // the usecase and guess; the error code is right there in the response.
    const detail = await mint.text().catch(() => "<unreadable>");
    throw new Error(`browserCaptain.pay(): checkout mint failed for ${entryId} — HTTP ${mint.status()}: ${detail.slice(0, 500)}`);
  }
  const { checkout_url } = (await mint.json()) as { checkout_url: string };

  const { page } = session;
  await page.goto(checkout_url);
  await completeHostedCheckout(page);

  await pollPaid(session, base, entryId, token);
}

/** Polls the public status endpoint until the entry reads paid/confirmed.
 *  `reconcile=1` makes the read fetch the Checkout session from Stripe and
 *  settle the row synchronously, so this does not depend on the webhook
 *  having been delivered first (`reconcileRegistration`, registrations.ts:3242
 *  — documented as never throwing, precisely so a slow webhook cannot wedge
 *  a read). */
async function pollPaid(session: RegistrationBrowserSession, base: string, entryId: string, token: string): Promise<void> {
  const api = session.context.request;
  await pollUntilPaid(async () => {
    const res = await api.fetch(
      `${base}/api/v1/public/registrations/${entryId}?token=${encodeURIComponent(token)}&reconcile=1`,
      { method: "GET" },
    );
    if (!res.ok()) throw new Error(`browserCaptain.pay(): status poll failed for ${entryId} — HTTP ${res.status()}`);
    // The v1 ENVELOPE, not the view. Every `/api/v1` route wraps its payload
    // as `{ ok, data, requestId }` (`server/api-v1/http.ts`'s `v1()`), so
    // reading `.status` off the top level yields `undefined` — which
    // `pollUntilPaid` then reports as a state that never settles, blaming the
    // registration for the reader's own mistake. `PublicStatusView.status`
    // lives one level down (usecases/registrations.ts:3375).
    const body = (await res.json()) as { data?: { status?: string } };
    const status = body.data?.status;
    if (status === undefined) {
      throw new Error(
        `browserCaptain.pay(): status poll for ${entryId} returned no data.status — the response envelope is not what this driver expects`,
      );
    }
    return { status };
  });
}

export function browserCaptain(session: RegistrationBrowserSession, base: string, _orgSlug: string, _competitionSlug: string): Captain {
  let accessToken: string | undefined;
  // Whether this captain's own submit already went through hosted Checkout.
  // A pay-up-front division redirects on submit, so by the time `register.ts`
  // calls `pay()` the money has moved and the row is settled — minting a
  // second session there is not merely wasteful, it is a 422
  // (`resumeRegistrationCheckout` requires `reg.status === "pending"`,
  // registrations.ts:4350). `pay()` still has real work in that case: proving
  // the entry actually reached paid/confirmed rather than assuming it.
  let paidDuringEnter = false;
  return {
    enter: (entry, division) =>
      enterViaStepper(
        session,
        base,
        division,
        entry,
        (token) => {
          accessToken = token;
        },
        () => {
          paidDuringEnter = true;
        },
      ),
    pay: (entry: PayableEntry) => {
      if (accessToken === undefined) {
        throw new Error(
          `browserCaptain.pay(): no access_token captured — this captain's own enter() must run (and succeed) first (registration ${entry.registrationId})`,
        );
      }
      return paidDuringEnter
        ? pollPaid(session, base, entry.registrationId, accessToken)
        : payViaCheckout(session, base, entry.registrationId, accessToken);
    },
  };
}

// ---------------------------------------------------------------------------
// Player — the join form. NOT exercised by `_tiny`'s own registration
// division (it declares no `joins[]` — build-packs/_tiny.ts's own comment);
// implemented for interface completeness and for a later suite (design §5's
// Mixed Doubles pairs, teammates joining by code) that does need it. Lower
// confidence than Captain/Organiser above — the join form's own slot-
// selection state (`join-form.tsx`'s `slots`/`selected`) is not pinned by
// this task; this driver assumes a single unclaimed slot, which is what a
// pair/individual join with no roster contention looks like.
// ---------------------------------------------------------------------------

async function joinViaForm(
  session: RegistrationBrowserSession,
  base: string,
  entry: JoinEntry,
  joinCode: string,
  consent: ConsentInput,
): Promise<void> {
  const { page } = session;
  await page.goto(`${base}/shared/${entry.orgSlug}/${entry.competitionSlug}/register/join?join_code=${encodeURIComponent(joinCode)}`);

  const player: RegistrationPlayer = entry.player;
  await page.locator("#reg-who-name").fill(player.fullName);
  if (player.dob) {
    const dob = page.locator("#reg-who-dob");
    await dob.waitFor({ state: "visible" });
    await dob.fill(player.dob);
  }
  if (player.gender) {
    await page.locator("#reg-who-gender").selectOption(player.gender);
  }
  if (consent.privacyConsent) {
    await page.locator('[data-testid="reg-consent-grant"]').check();
  }
  if (consent.guardianConsent) {
    await page.locator("#reg-guardian-name").fill(consent.guardianName ?? "");
    await page.locator("#reg-guardian-consent").check();
  }
  await page.locator('[data-testid="reg-join-submit"]').click();
}

export function browserPlayer(session: RegistrationBrowserSession, base: string, _orgSlug: string, _competitionSlug: string): Player {
  return {
    join: (entry, joinCode, consent) => joinViaForm(session, base, entry, joinCode, consent),
  };
}
