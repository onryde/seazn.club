// Shared machinery for the RS007 money walkthroughs — the specs that drive
// real Stripe Connect checkouts and real refunds through the real UI.
//
// WHY THIS IS NOT IN e2e/walkthrough/. The walkthrough Playwright project
// selects by DIRECTORY (`testMatch: /[\\/]e2e[\\/]walkthrough[\\/]/`, see
// playwright.config.ts), not by a `*.spec.ts` suffix — so ANY .ts file placed
// in that folder is treated as a spec, and Playwright then rejects the specs
// that import it with "test file X should not import test file Y". The kit
// therefore lives beside `helpers.ts` at the e2e root, which the default
// `*.spec.ts` testMatch of every other project also skips.
import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiJson } from "./helpers";

export const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
export const WATCH = process.env.WALKTHROUGH_WATCH === "1";
export const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";

/** Loud skip at collection time. Playwright's own summary prints "N skipped"
 *  with no reason, and a leg that silently skips its only real-money witness
 *  looks exactly like one that ran it. */
export function warnIfDisabled(specName: string, whatIsLost: string): void {
  if (ENABLED && CONNECT_ACCOUNT) return;
  const missing = [
    ENABLED ? null : "CONNECT_WALKTHROUGH=1",
    CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT",
  ].filter(Boolean);
  console.warn(
    `\n  ⚠ ${specName} SKIPPED — ${whatIsLost}` +
      `\n    missing: ${missing.join(", ")}\n`,
  );
}

// ---------------------------------------------------------------------------
// The Connect fixture account
// ---------------------------------------------------------------------------

/** `organizations.stripe_account_id` is UNIQUE, so exactly one org in the
 *  database can hold the fixture account at a time. Every money spec takes it
 *  for the duration and gives it back.
 *
 *  Deliberately NOT helpers' `setOrgConnectSql`, which writes a fabricated
 *  `acct_e2e_<id>` that Stripe rejects as a transfer destination. */
export async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Arbitrary but fixed: the advisory-lock key that means "I hold the Connect
 *  fixture". Any bigint would do; this one is memorable. */
const CONNECT_LOCK_KEY = 70070071;

export interface ConnectClaim {
  /** The org that held the fixture before us, to be handed back. */
  priorId: string | null;
  /** The org we lent it to. */
  orgId: string;
}

/** The lock connection, held open for as long as this process owns the
 *  fixture. `pg_advisory_lock` is SESSION-scoped, so the connection must stay
 *  open and must be the only one in the pool (`max: 1`) or postgres.js may
 *  issue the unlock on a different backend, which is a silent no-op. */
let lockSql: import("postgres").Sql | null = null;

/** Take the fixture account for `orgId`, blocking until whoever else holds it
 *  gives it back.
 *
 *  WHY A LOCK RATHER THAN A COMMENT SAYING "run with --workers=1". The
 *  walkthrough project inherits `fullyParallel: true`, so two money specs in
 *  two files land on two workers and the second one's `claimConnectAccount`
 *  silently STEALS the account out from under the first mid-checkout. The
 *  symptom is a Stripe error about a missing destination on whichever run
 *  happens to lose, hundreds of lines away from the cause. The lock makes the
 *  second worker wait instead. */
export async function claimConnectAccount(orgId: string): Promise<ConnectClaim> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false, max: 1 });
  await sql`select pg_advisory_lock(${CONNECT_LOCK_KEY})`;
  lockSql = sql;
  const prior = await sql`select id from organizations where stripe_account_id = ${CONNECT_ACCOUNT}`;
  const priorId = (prior[0]?.id as string | undefined) ?? null;
  if (priorId) {
    await sql`
      update organizations
      set stripe_account_id = null, stripe_charges_enabled = false
      where id = ${priorId}`;
  }
  await sql`
    update organizations
    set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true
    where id = ${orgId}`;
  return { priorId, orgId };
}

/** Give the fixture back and release the lock. Safe to call with a null claim
 *  so a `finally` block never has to guard it. */
export async function releaseConnectAccount(claim: ConnectClaim | null): Promise<void> {
  const sql = lockSql;
  if (!sql) return;
  try {
    if (claim) {
      await sql`
        update organizations
        set stripe_account_id = null, stripe_charges_enabled = false
        where id = ${claim.orgId}`;
      if (claim.priorId) {
        await sql`
          update organizations
          set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true
          where id = ${claim.priorId}`;
      }
      const back = await sql`select id from organizations where stripe_account_id = ${CONNECT_ACCOUNT}`;
      console.log(
        `RESTORE>>> fixture now held by ${(back[0]?.id as string) ?? "NOBODY"} (expected ${claim.priorId})`,
      );
    }
    await sql`select pg_advisory_unlock(${CONNECT_LOCK_KEY})`;
  } finally {
    lockSql = null;
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Reading money off the page
// ---------------------------------------------------------------------------

/** A rendered "£25.00" / "£25" / "€1.234,50" -> cents.
 *
 *  The first version of this helper stripped every non-digit and returned
 *  that, on the stated premise that "GBP/USD/EUR all render exactly two
 *  minor-unit digits". That premise is FALSE for this app: a whole amount
 *  renders as "£25", which stripped to `25` — so the helper reported 25 cents
 *  where the page said twenty-five pounds, and the assertion failed with a
 *  message blaming a product defect that had already been fixed. A parser
 *  that is wrong in the safe direction still accuses the wrong party.
 *
 *  So: read the trailing separator group. Exactly two digits after the last
 *  `.`/`,` is a minor-unit fraction; anything else (three digits, or no
 *  separator at all) is grouping. Handles "£25", "£25.00", "£1,234.50" and
 *  "€1.234,50" alike, without needing to know the org's currency or locale. */
export function centsFromRenderedAmount(text: string): number {
  const match = text.match(/\d[\d.,\s  ]*\d|\d/);
  if (!match) throw new Error(`no monetary amount found in "${text}"`);
  const raw = match[0].replace(/[\s  ]/g, "");
  const trailing = raw.match(/[.,](\d+)$/);
  const normalised =
    trailing && trailing[1]!.length === 2
      ? `${raw.slice(0, -trailing[0]!.length).replace(/[.,]/g, "")}.${trailing[1]}`
      : raw.replace(/[.,]/g, "");
  const value = Number(normalised);
  if (!Number.isFinite(value)) throw new Error(`unparseable monetary amount "${text}"`);
  return Math.round(value * 100);
}

export interface PublicRegSnapshot {
  id: string;
  status: string;
  amount_cents: number;
  refunded_cents: number;
}

/** GET /api/v1/public/registrations/{id}?token= — publicRegistrationStatus's
 *  wire shape. The read-back that stands in for "the system's own record",
 *  as distinct from the rendered pixels. */
export async function publicRegSnapshot(
  request: APIRequestContext,
  regId: string,
  token: string,
): Promise<PublicRegSnapshot> {
  const res = await apiJson<PublicRegSnapshot>(
    request,
    `/api/v1/public/registrations/${regId}?token=${encodeURIComponent(token)}`,
    "GET",
  );
  if (res.status !== 200 || !res.data) {
    throw new Error(`publicRegSnapshot(${regId}): GET -> ${res.status}`);
  }
  return res.data;
}

/** Pull `rid` and `token` off a /register/status URL, failing loudly rather
 *  than returning undefined into an assertion twenty lines later.
 *
 *  `rid` is the **GROUP** id, not a registration id — the status page's URL
 *  convention is `?rid=<group_id>&token=<access_token>` (status/page.tsx's own
 *  header says so). Feeding it to `publicRegSnapshot`, which takes a
 *  REGISTRATION id, gets a flat 404 with nothing in the message to say why.
 *  Use `entryIdsInGroup` to turn it into the entry ids. */
export function statusUrlParts(statusUrl: string): { groupId: string; token: string } {
  const u = new URL(statusUrl);
  const groupId = u.searchParams.get("rid");
  const token = u.searchParams.get("token");
  if (!groupId || !token) throw new Error(`status page URL carries no rid/token: ${statusUrl}`);
  return { groupId, token };
}

/** This cart's entry ids, oldest first — the same `created_at, id` order the
 *  status page renders and auto-promotion consumes.
 *
 *  Read straight from the database because nothing public exposes it: the
 *  status page emits no entry id in its markup (no `data-*` on the entry
 *  card), and the only public endpoint that speaks entry ids requires one as
 *  input. A read-back, never a mutation — the same standing the existing
 *  walkthrough gives `publicRegSnapshot`. */
export async function entryIdsInGroup(groupId: string): Promise<string[]> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select id from registrations
      where group_id = ${groupId}
      order by created_at, id`;
    if (rows.length === 0) throw new Error(`cart ${groupId} has no entries`);
    return rows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------------------
// Setup: a competition with paid divisions
// ---------------------------------------------------------------------------

export const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

export interface DivisionSpec {
  name: string;
  entrant_kind: "team" | "pair" | "individual";
  fee_cents: number;
  capacity?: number | null;
  /** ISO instant. Past = the auto-refund window has already closed. */
  refund_lock_at?: string | null;
}

/** Create a division and open registration on it. Setup, through the API —
 *  the walkthrough charter's own "setup may use the API to REACH a state"
 *  allowance. There is no click-through division CREATION flow to drive; it
 *  is a server-authored resource. */
export async function openPaidDivision(
  request: APIRequestContext,
  competitionId: string,
  spec: DivisionSpec,
): Promise<string> {
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    { name: spec.name, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, `could not create division "${spec.name}"`).toBeLessThan(300);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: spec.entrant_kind,
      capacity: spec.capacity ?? null,
      fee_cents: spec.fee_cents,
      payment_method: "stripe",
      form_fields: [],
      ...(spec.refund_lock_at !== undefined ? { refund_lock_at: spec.refund_lock_at } : {}),
    },
  );
  expect(settings.status, `registration-settings PUT for "${spec.name}"`).toBeLessThan(300);
  return div.data!.id;
}

// ---------------------------------------------------------------------------
// The real Stripe Connect hosted checkout
// ---------------------------------------------------------------------------

/** Fill and submit Stripe's own hosted checkout, then wait for the return to
 *  /register/status. Card interaction copied verbatim from
 *  registration-connect.spec.ts, which established these selectors against the
 *  live page. */
export async function payOnStripeCheckout(
  page: Page,
  cardholder: string,
  shots?: (name: string) => Promise<void>,
): Promise<string> {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  // Stripe's hosted page renders a skeleton first and hydrates the card form
  // afterwards, and how long that takes is Stripe's business, not ours. A
  // fixed pause here fails intermittently against a grey placeholder with
  // "locator.fill: element not found" — which reads like a selector that has
  // rotted rather than a page that had not finished loading. Wait for the
  // field itself.
  await page.locator("#cardNumber").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(500);
  await shots?.("stripe-checkout");

  await page.locator("#cardNumber").fill("4242424242424242");
  await page.locator("#cardExpiry").fill("12/34");
  await page.locator("#cardCvc").fill("123");
  const holder = page.locator("#billingName");
  if (await holder.count()) await holder.fill(cardholder);
  const postal = page.locator("#billingPostalCode");
  if (await postal.count()) await postal.fill("SW1A 1AA");
  await page.waitForTimeout(1000);
  await shots?.("card-filled");
  await page.locator(".SubmitButton, button[type=submit]").first().click();

  // `waitUntil: "commit"` — the webhook that flips the entry to paid races
  // this navigation, so the settle is done by the caller's own polling, not
  // by waiting for load here.
  await page.waitForURL(/\/register\/status\?/, { timeout: 120_000, waitUntil: "commit" });
  await page.waitForTimeout(2500);
  return page.url();
}

/** Poll the public status API until the entry reaches one of `wanted`.
 *
 *  Stripe's webhook is what flips `pending` -> `paid`, and it arrives over the
 *  `stripe listen` tunnel some hundreds of milliseconds AFTER the browser is
 *  already back on the status page. A fixed `waitForTimeout` here is the
 *  classic flake: it passes on a warm machine and fails under load, and when
 *  it fails it reports "expected paid, got pending", which reads exactly like
 *  a product defect in the webhook handler. */
export async function waitForStatus(
  request: APIRequestContext,
  regId: string,
  token: string,
  wanted: readonly string[],
  timeoutMs = 45_000,
): Promise<PublicRegSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicRegSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await publicRegSnapshot(request, regId, token);
    if (wanted.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `registration ${regId} never reached ${wanted.join("/")} within ${timeoutMs}ms — ` +
      `last seen "${last?.status}" (amount ${last?.amount_cents}, refunded ${last?.refunded_cents}). ` +
      `If this is a local run, check that \`stripe listen --forward-to <BASE>/api/webhooks/stripe\` is still running.`,
  );
}

/** Same poll, for a refund landing on the entry's own ledger row. */
export async function waitForRefund(
  request: APIRequestContext,
  regId: string,
  token: string,
  atLeastCents: number,
  timeoutMs = 45_000,
): Promise<PublicRegSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicRegSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await publicRegSnapshot(request, regId, token);
    if (last.refunded_cents >= atLeastCents) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `registration ${regId} never recorded a refund of at least ${atLeastCents} within ${timeoutMs}ms — ` +
      `last seen refunded_cents=${last?.refunded_cents} on a ${last?.amount_cents} charge, status "${last?.status}".`,
  );
}
