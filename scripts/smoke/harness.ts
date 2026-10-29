// scripts/smoke/harness.ts — the state and helpers the smoke suites (scripts/smoke/suites/) share: the check counters (private here: read them
// with `counts()`, move them only through `check`), the per-suite manifest recorder (`suite`, `writeManifest`), sessions and the
// HTTP helpers (`raw`, `call`, `v1`), sign-in, the DB and billing helpers, and the run's `tag`. A helper used by exactly one suite
// lives with that suite, not here. Runs under `node --experimental-strip-types` like the rest of scripts/smoke/: relative imports carry `.ts`.
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { createManifestRecorder } from "../smoke-manifest.ts";

export const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

/**
 * A REAL Stripe test-mode connected account id (`acct_…`) with charges enabled.
 *
 * Holding a secret key is NOT the same as having a usable Connect destination:
 * `setConnect` fabricates an `acct_smoke_*` id, which satisfies every
 * "is this org onboarded?" gate in the app but exists in no Stripe account, so
 * any destination charge against it is rejected with `resource_missing`.
 * Creating one headlessly does not help either — a fresh Express account has
 * `charges_enabled: false` until a human finishes onboarding.
 *
 * Supply this to exercise the real Connect checkout; without it, smoke skips
 * (rather than fails) the destination-charge assertion — the check still
 * counts either way. `organizations.stripe_account_id` is UNIQUE, so it is
 * handed to exactly one org per run (sponsorSuite's pro org). See `setConnect`.
 */
export const CONNECT_TEST_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT;

export interface Session {
  cookies: Record<string, string>;
}
export const newSession = (): Session => ({ cookies: {} });
export const cookieHeader = (s: Session) =>
  Object.entries(s.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

export async function raw(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{
  status: number;
  // `issues` is the ZodError detail lib/http.ts attaches to a schema rejection.
  // Carried so a check can assert WHICH field was rejected: "Invalid input" is
  // zod's blanket message, so on its own it cannot tell a rejected `pass_key`
  // from a rejected anything-else.
  json: { ok: boolean; data?: unknown; error?: string; issues?: { path?: unknown[] }[] };
}> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    if (m[2] === "") delete s.cookies[m[1]];
    else s.cookies[m[1]] = m[2];
  }
  // Two disables, one cause: `res.json()` is `any`, and this is the single
  // boundary the whole file's `call()` chain hangs off. Typing it here means
  // giving `call()` a non-`any` return, which reds ~18k lines of untyped member
  // access at tsc — a real piece of work, deliberately not this change's. The
  // three seed/repro scripts with the same shape are relaxed per-file in
  // eslint.config.mjs; scripts/smoke/ is pinned to these two lines instead so every
  // other unsafe-any in it still errors.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const json = await res.json().catch(() => ({ ok: false, error: "no json" }));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  return { status: res.status, json };
}

export async function call(s: Session, path: string, method = "GET", body?: unknown) {
  const { json } = await raw(s, path, method, body);
  if (json.ok === false) throw new Error(`${path}: ${json.error}`);
  return json.data;
}

let pass = 0;
let fail = 0;
export const check = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (cond) pass++;
  else fail++;
};
/** The run's check totals so far. `pass` and `fail` are private to this module and only `check` moves them, so every
 *  module that imports the harness reads the same two numbers. */
export function counts(): { pass: number; fail: number } {
  return { pass, fail };
}
// Per-suite check counts (scripts/smoke-manifest.ts): main() runs each suite as `suite("name", () => nameSuite(...))`, and a
// run with SMOKE_MANIFEST=<path> writes the counts there when it ends, so a refactor of this file can be diffed against a
// baseline (scripts/smoke-manifest-diff.ts). A suite's name is its function's name without a trailing `Suite`.
const manifest = createManifestRecorder(() => pass + fail);
export const suite = manifest.run;
export const writeManifest = () => {
  const path = process.env.SMOKE_MANIFEST;
  if (path) writeFileSync(path, JSON.stringify(manifest.entries(), null, 2));
};
export async function expectFail(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false);
  } catch {
    check(label, true);
  }
}

/**
 * Passwordless sign-in: request a magic link, then consume the dev-exposed
 * token (dev returns `login_url` so the flow is testable without email). An
 * unknown email creates the account. Returns the consume payload and leaves the
 * session cookie on `s`.
 */
export async function signIn(s: Session, email: string) {
  const req = (await call(s, "/api/auth/magic-link", "POST", { email })) as {
    login_url?: string;
  };
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  return (await call(s, "/api/auth/magic-link/consume", "POST", { token })) as {
    has_org: boolean;
    org_id: string;
    redirect: string;
  };
}

export const tag = Date.now().toString(36);

/**
 * Per-fixture event sender that tracks the ledger tip.
 *
 * A REJECTED post leaves `seq` untouched, deliberately: the next legal event
 * then lands on the same expected_seq, which is itself the proof that the
 * refusal persisted nothing (spec 03 §2 guarantee 2 — a throwing module aborts
 * the tx before any insert).
 */
export function ledger(s: Session, fixtureId: string) {
  let seq = 0;
  return {
    async send(type: string, payload: unknown): Promise<V1Res> {
      const res = await v1(s, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
        expected_seq: seq,
        type,
        payload,
      });
      if (res.status === 201) seq = v1data<{ seq: number }>(res).seq;
      return res;
    },
    get seq(): number {
      return seq;
    },
    /** The RAW fold, not the summary — `match_states.state` is what carries
     *  `expiresAt`, `subWindows`, `interruptions` and `asOf`. */
    async fold<T>(): Promise<T> {
      const res = await v1(s, `/api/v1/fixtures/${fixtureId}/state`);
      return v1data<{ state: T }>(res).state;
    },
  };
}

/** Division → entrants → league stage → one generated fixture, started. */
export async function timedFixture(
  s: Session,
  compId: string,
  spec: {
    name: string;
    sport_key: string;
    variant_key: string;
    config?: Record<string, unknown>;
    entrants: unknown[];
  },
): Promise<{ divisionId: string; entrantIds: string[]; fixtureId: string }> {
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: spec.name,
      sport_key: spec.sport_key,
      variant_key: spec.variant_key,
      ...(spec.config === undefined ? {} : { config: spec.config }),
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", spec.entrants),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  await v1(s, `/api/v1/divisions/${div.id}/start`, "POST");
  return {
    divisionId: div.id,
    entrantIds: ents.map((e) => e.id),
    fixtureId: gen.fixtures[0].id,
  };
}

/** GDPR (spec 2026-07-14): assert the magic-link request stamped terms
 *  acceptance — same SQL convention as setStaff/setConnect. */
export async function checkTermsStamp(email: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // keyless run: nothing to assert against
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [row] = await sql<{ terms_accepted_at: Date | null; terms_version: string | null }[]>`
      select terms_accepted_at, terms_version from users where email = ${email}`;
    check("auth terms acceptance stamped", !!row?.terms_accepted_at && !!row?.terms_version);
  } finally {
    await sql.end();
  }
}

/** Email outbox, phase 1 (Task 6): the magic-link request wrote exactly one `magic_link` row for the address, in the same
 *  transaction as its token, and the attempt made in the request has left no credential-bearing body behind. The smoke server
 *  has no Resend key, so the row is `dead` (`no_api_key`); a run against a server that can send would see it `sent`. Either
 *  way it is neither waiting (`queued`/`sending`) nor holding its sealed body. */
export async function checkSignInOutbox(email: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // keyless run: nothing to assert against
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const rows = await sql<{ status: string; cleared: boolean }[]>`
      select status, body_sealed is null as cleared
        from email_outbox
       where kind = 'magic_link' and lower(recipient) = lower(${email})`;
    check("sign-in email: one outbox row for the address", rows.length === 1);
    check("sign-in email: its attempt was made in the request (not waiting)", !!rows[0] && !["queued", "sending"].includes(rows[0].status));
    check("sign-in email: no sealed body is left on the row", rows[0]?.cleared === true);
  } finally {
    await sql.end();
  }
}

/** Email outbox, phase 3 (Task 13): the same three assertions as `checkSignInOutbox`, for any kind, keyed by the row's ref instead
 *  of the address. Exactly one row carries (kind, ref); its first attempt has been made (neither `queued` nor `sending`); and no
 *  sealed body is left on it. A producer that queues after the response makes its first attempt after it too, so the row is polled
 *  (up to 20 s) until it has left `queued`/`sending` - a row still waiting at the end is the failure, not a reason to wait longer.
 *  The smoke server has no Resend key, so a settled row is `dead` (`no_api_key`); one that can send would be `sent`. Either way
 *  it holds no body. */
export async function checkOutboxRow(kind: string, refType: string, refId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // keyless run: nothing to assert against
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const deadline = Date.now() + 20_000;
    let rows: { status: string; cleared: boolean }[] = [];
    for (;;) {
      rows = await sql<{ status: string; cleared: boolean }[]>`
        select status, body_sealed is null as cleared
          from email_outbox
         where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}`;
      const settled = rows.length > 0 && rows.every((r) => !["queued", "sending"].includes(r.status));
      if (settled || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check(`${kind}: one outbox row for the ref`, rows.length === 1);
    check(`${kind}: its first attempt was made (not waiting)`, !!rows[0] && !["queued", "sending"].includes(rows[0].status));
    check(`${kind}: no sealed body is left on the row`, rows[0]?.cleared === true);
  } finally {
    await sql.end();
  }
}

/** Email outbox, phase 3 wave 2 (Task 11): the counterpart of `checkOutboxRow` for a kind the WORKER sends. Such a kind
 *  makes no attempt in the request (no `dispatchNow`); the worker takes it after its 30 s window. So, read straight after
 *  the response, exactly one row carries (kind, ref), it is still `queued` with no attempt made, and it is addressed to an
 *  account (`recipient_user_id` set), not only to an address. No poll: the row commits with the response, and a row that
 *  has already moved is the failure this exists to catch.
 *
 *  Wave 5 (Task 8): `account: false` is for a kind addressed to a literal address (a funnel visitor has no account yet), and
 *  its third check asserts the opposite — no `recipient_user_id` on the row. The default is wave 2's check. */
export async function checkQueuedOutboxRow(
  kind: string,
  refType: string,
  refId: string,
  opts: { account?: boolean } = {},
): Promise<void> {
  const account = opts.account ?? true;
  const url = process.env.DATABASE_URL;
  if (!url) return; // keyless run: nothing to assert against
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const rows = await sql<{ status: string; attempts: number; recipient_user_id: string | null }[]>`
      select status, attempts, recipient_user_id
        from email_outbox
       where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}`;
    check(`${kind}: one outbox row for the ref`, rows.length === 1);
    check(`${kind}: left to the worker (queued, no attempt yet)`, rows[0]?.status === "queued" && rows[0]?.attempts === 0);
    if (account) check(`${kind}: addressed to the account (recipient_user_id set)`, !!rows[0]?.recipient_user_id);
    else check(`${kind}: addressed to a literal address (no recipient_user_id)`, !!rows[0] && rows[0].recipient_user_id === null);
  } finally {
    await sql.end();
  }
}

/** Flip the staff-console flag on a user — same SQL-flip convention as
 *  setPlan/setConnect (design/v7 PROMPT-51). */
export async function setStaff(email: string, role: "superadmin" | null): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to flip staff in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      update users set is_staff = ${role !== null}, staff_role = ${role}
      where email = ${email}`;
  } finally {
    await sql.end();
  }
}

/** Flip Stripe Connect readiness (spec 2026-07-12) — Express onboarding can't
 *  run headless; a fake acct id satisfies account-exists checks. Same SQL-flip
 *  convention as setPlan/grantPass.
 *
 *  Pass `accountId` (i.e. CONNECT_TEST_ACCOUNT) to overwrite the fabricated id
 *  with a REAL connected account, the only way a destination charge can
 *  settle. `organizations.stripe_account_id` carries a partial UNIQUE index, so
 *  hand a real id to at most ONE org per run — every other caller must leave it
 *  undefined and keep its throwaway acct_smoke_* id. */
export async function setConnect(
  orgId: string,
  chargesEnabled: boolean,
  accountId?: string,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to flip Connect in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    if (accountId) {
      await sql`
        update organizations
        set stripe_charges_enabled = ${chargesEnabled},
            stripe_account_id = ${accountId}
        where id = ${orgId}`;
    } else {
      await sql`
        update organizations
        set stripe_charges_enabled = ${chargesEnabled},
            stripe_account_id = coalesce(stripe_account_id, ${"acct_smoke_" + orgId.slice(0, 8)})
        where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * The Event Pass rungs (v17 #294). A hand-kept mirror of `PASS_KEYS`
 * (apps/web/src/lib/currency.ts): smoke runs under
 * `node --experimental-strip-types` and can resolve neither the app's `@/`
 * alias nor the JSON import `currency.ts` pulls in, so the list cannot be
 * imported. It is therefore ASSERTED against the `plans` table rather than
 * trusted — see the ladder check at the top of `passRungLSuite`, which reds the
 * day a third rung is seeded without this file learning about it.
 */
export const PASS_RUNGS = ["event_pass", "event_pass_l"] as const;
export type PassRung = (typeof PASS_RUNGS)[number];

/**
 * Insert an Event Pass row directly (v3/07 §3) — smoke targets a disposable DB
 * and the one-time Stripe checkout can't run without Stripe; the same SQL-flip
 * convention as setPlan. Used where the purchase itself is not what is under
 * test (a competition that just needs to BE passed), and for the states no
 * purchase can reach — a pass held by a PAID plan, for instance, which the buy
 * route refuses outright.
 *
 * v17 #294: `passKey` is REQUIRED, and deliberately has no default. This insert
 * used to omit the column entirely while V271 declares it `not null default
 * 'event_pass'`, so seeding an L pass here stored an M one — no FK error, no
 * exception, nothing red, and every downstream assertion then measured the
 * wrong rung's ceilings. That is the same landmine `recordPassPurchase` carried
 * (lib/billing.ts), and a default here would only relocate it: making callers
 * name the rung is what lets `tsc` enumerate every seed the day a third rung
 * appears.
 */
export async function grantPass(
  orgId: string,
  competitionId: string,
  passKey: PassRung,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to grant a pass in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${competitionId}, ${orgId}, ${passKey})
      on conflict (competition_id) do nothing`;
  } finally {
    await sql.end();
  }
}

/**
 * True when `name` is a REAL rendered HTML attribute — not merely a prop name
 * that survived into the RSC flight payload Next embeds in the same body.
 *
 * React does NOT drop an omitted prop when it serialises a server-rendered
 * element; it encodes the `undefined` so the client can tell "absent" from
 * "never sent". Rendering `<div data-pass-active={held || undefined}>` with
 * `held` false produces, verbatim:
 *
 *   0:["$","div",null,{"data-pass-active":"$undefined","data-pass-ended":true},…]
 *
 * So `body.includes("data-pass-active")` is TRUE for an attribute the browser
 * never sees, and the string is present in BOTH states. A bare-name check is
 * therefore vacuous in the positive direction and IMPOSSIBLE to satisfy in the
 * negative one — the p301 upgrade checks hit both halves of that at once.
 * Anchoring on `="` keys off the serialised attribute, which only real markup
 * carries.
 */
export function renderedAttr(body: string, name: string): boolean {
  return body.includes(`${name}="`);
}

let smokeWebhookSeq = 0;
/** The next Stripe webhook event sequence number for this run, 1, 2, 3, … (the `<n>` of `evt_smoke_<tag>_<n>`). The counter is
 *  private to this module; this is the only way to move it. */
export function nextWebhookSeq(): number {
  return ++smokeWebhookSeq;
}

/**
 * Deliver a synthetic, correctly-signed Stripe event to the app's OWN webhook
 * route (`/api/webhooks/stripe`).
 *
 * Stripe cannot reach localhost and an embedded checkout cannot be completed
 * headlessly, so this is the only way smoke can drive the real money path —
 * `runEvent` → `handleCheckoutCompleted` → `recordPassPurchase` — rather than
 * re-implementing its effects in SQL and then asserting its own seed. The
 * signature is a plain HMAC-SHA256 over `${t}.${payload}`, exactly what
 * `stripe.webhooks.constructEvent` verifies, so nothing here needs the Stripe
 * SDK or a network call; the SERVER still needs a `STRIPE_SECRET_KEY` (the
 * route builds a client to verify with) and the SAME `STRIPE_WEBHOOK_SECRET`.
 * Mirrors `postSignedStripeWebhook` in e2e/event-pass.spec.ts.
 *
 * Returns the HTTP status so the caller asserts it rather than this helper
 * throwing an unlabelled error.
 *
 * `id` is for a caller that delivers ONE event twice (a Stripe redelivery):
 * it names the id and posts it again. It must keep the `evt_smoke_<tag>_`
 * prefix, or cleanup()'s billing_events sweep never reaches its ledger row.
 */
export async function postSignedStripeWebhook(type: string, object: unknown, id?: string): Promise<number> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required to sign a smoke webhook");
  const event = {
    // `evt_smoke_<tag>_…` is also what teardown deletes by: billing_events has
    // no org FK, so these rows would otherwise outlive the run's orgs.
    id: id ?? `evt_smoke_${tag}_${nextWebhookSeq()}`,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${signature}`,
    },
    body: payload,
  });
  return res.status;
}

/** A PAID registration checkout session, in the shape createRegistrationCheckout
 *  stamps (registrations.ts's payment_intent_data / session metadata) and
 *  handleRegistrationCheckoutCompleted reads: `metadata.registration_ids`
 *  names which entries to confirm, `metadata.fee_percent` is the rate the
 *  paid transition stamps onto the competition, and `payment_status: "paid"`
 *  is what makes the handler run fulfilment at all. Mirrors postPaidPassWebhook
 *  above, one section up. */
export async function postPaidRegistrationWebhook(args: {
  groupId: string;
  registrationIds: string[];
  orgId: string;
  currency: string;
  feePercent: number;
  paymentIntent: string;
}): Promise<number> {
  return postSignedStripeWebhook("checkout.session.completed", {
    id: `cs_smoke_${tag}_reg_${args.groupId.slice(0, 8)}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: args.currency,
    customer: null,
    payment_intent: args.paymentIntent,
    metadata: {
      kind: "registration_group",
      registration_group_id: args.groupId,
      registration_ids: args.registrationIds.join(","),
      org_id: args.orgId,
      fee_percent: String(args.feePercent),
    },
  });
}

/**
 * A configured smoke Stripe client for the two real-money legs below
 * (registrationDuplicatePaymentSuite, registrationRefundReversalSuite) —
 * unlike every other Connect check in this file, which only ever signs a
 * SYNTHETIC webhook, these two actually confirm real PaymentIntents and
 * refund them, so this refuses a live key outright rather than merely
 * preferring a test one (registration-currency.live.test.ts's own
 * `expect(key.startsWith("sk_test"))` guard, same idea). Accepts a
 * *restricted* test key too (`rk_test_…`) — this env's own STRIPE_SECRET_KEY
 * is one. Dynamic import matches paymentMethodSuite's own convention (suites/paymentMethod.ts) —
 * this plain `node --experimental-strip-types` runner has no `@/lib/stripe`
 * alias to import from. Caller must already have confirmed STRIPE_SECRET_KEY
 * is set (the usual skip-shape check).
 */
export async function smokeStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required to build a smoke Stripe client");
  if (!key.startsWith("sk_test") && !key.startsWith("rk_test")) {
    throw new Error("refusing to run a real-money smoke leg against a non-test-mode Stripe key");
  }
  const { default: Stripe } = await import("stripe");
  return new Stripe(key);
}

/**
 * Pays a registration entry for REAL against the fixture Connect account —
 * a destination charge in the same shape createRegistrationCheckout uses
 * (`transfer_data.destination` + `application_fee_amount`), confirmed
 * directly with the `pm_card_visa` test token — the same headless-card
 * mechanism paymentMethodSuite (suites/paymentMethod.ts) already relies on to attach a real
 * card with no client-side step.
 *
 * This deliberately does NOT try to complete a real Checkout Session:
 * probed by hand before writing this (RS006 money-hardening) —
 * `checkout.sessions.create()`'s own `payment_intent` field comes back
 * `null` and STAYS null until an actual browser visits the hosted page.
 * Stripe defers PaymentIntent creation for dynamic/automatic payment
 * methods, and createRegistrationCheckout never sets
 * `payment_method_types`, so there is never a PaymentIntent on our real
 * sessions for this script to confirm — Stripe cannot reach localhost for
 * the real webhook, and there is no browser here either. Both legs below
 * still mint real Checkout sessions (via seedRealRegistrationCart / the
 * resume-checkout endpoint) to prove THAT path against real Stripe, then
 * pay the cart through this INDEPENDENT PaymentIntent instead — the webhook
 * that fulfils it (postPaidRegistrationWebhook) already fully synthesizes
 * its own event body regardless of what a real session would have sent, so
 * a real, succeeded, correctly-shaped payment_intent id is all fulfilment
 * ever reads.
 *
 * Also probed by hand: the resulting Charge's `application_fee`/`transfer`
 * fields are still `null` for a moment after the PaymentIntent's `status`
 * is already "succeeded" — Stripe creates the Transfer/ApplicationFee
 * objects asynchronously (~2s against this fixture account when probed).
 * This polls until both exist — up to 15s — before returning, so neither
 * caller can race a refund (`reverse_transfer`/`refund_application_fee`
 * against a transfer that does not exist yet is exactly the kind of
 * Stripe-contract gap a stub can never surface) or an assertion against it.
 */
export async function payRealDestinationCharge(
  stripe: Awaited<ReturnType<typeof smokeStripe>>,
  amountCents: number,
  currency: string,
): Promise<{ paymentIntentId: string; chargeId: string; transferId: string; applicationFeeId: string }> {
  // Narrowed local, not a `!` assertion: CONNECT_TEST_ACCOUNT is a
  // module-level `const`, so TS cannot see across the caller's own
  // presence-check into this function — but callers are contractually
  // required to have already made it (the usual skip-shape check), so a
  // throw here is a "this should never happen" guard, not a real skip path.
  const account = CONNECT_TEST_ACCOUNT;
  if (!account) throw new Error("payRealDestinationCharge requires CONNECT_TEST_ACCOUNT to be set");
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    // Any positive fee proves the pairing below; nothing downstream asserts
    // this matches the app's own live fee_percent (a separate concern —
    // chargedFeePercent only locks competitions.fee_percent, read from
    // registration_groups.fee_percent, never from the Stripe side).
    application_fee_amount: Math.max(1, Math.round(amountCents * 0.02)),
    transfer_data: { destination: account },
    payment_method: "pm_card_visa",
    confirm: true,
    return_url: "https://smoke.example.com/return",
  });
  if (pi.status !== "succeeded") {
    throw new Error(`payment_intent ${pi.id} did not succeed (status ${pi.status})`);
  }
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
  if (!chargeId) throw new Error(`payment_intent ${pi.id} succeeded with no latest_charge`);

  for (let attempt = 0; attempt < 20; attempt++) {
    const charge = await stripe.charges.retrieve(chargeId);
    const transferId = typeof charge.transfer === "string" ? charge.transfer : (charge.transfer?.id ?? null);
    const applicationFeeId =
      typeof charge.application_fee === "string" ? charge.application_fee : (charge.application_fee?.id ?? null);
    if (transferId && applicationFeeId) {
      return { paymentIntentId: pi.id, chargeId, transferId, applicationFeeId };
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`charge ${chargeId} never grew a transfer + application_fee within 15s`);
}

/**
 * Restores CONNECT_TEST_ACCOUNT to whoever held it before a leg claimed it —
 * never leaves it null. Mirrors registrationPaidLoopSuite's own finally
 * block (see that function's doc comment for why "leave it null" is the
 * wrong move — it silently disconnects a real, unrelated org's Connect
 * account on a persistent/shared dev DB). Shared by the two legs below,
 * which both do this identical hand-back.
 */
export async function releaseConnectAccount(orgId: string, previousHolderId: string | null): Promise<void> {
  const db = smokeDb();
  try {
    await db`update organizations set stripe_account_id = null where id = ${orgId}`;
    if (previousHolderId) {
      // Narrowed local, not a `!` assertion — same reasoning as
      // payRealDestinationCharge's own: a caller reaching this point has
      // necessarily already passed the module-level presence check, which
      // TS cannot see across the function boundary.
      const account = CONNECT_TEST_ACCOUNT;
      if (!account) throw new Error("releaseConnectAccount requires CONNECT_TEST_ACCOUNT to be set");
      await db`update organizations set stripe_account_id = ${account} where id = ${previousHolderId}`;
    }
  } finally {
    await db.end();
  }
}

/**
 * Shared scaffold for the two RS006 money-hardening legs below: signs in a
 * fresh Pro org owner, claims CONNECT_TEST_ACCOUNT for it (the same
 * capture-and-restore contract as registrationPaidLoopSuite's own doc
 * comment — the claim sequence itself carries that function's same small,
 * accepted, not-finally-protected risk window: registrationPaidLoopSuite's
 * own claim isn't wrapped in a restoring finally either, only the work after
 * it is), prices one division through Stripe, and submits ONE payable
 * individual entry — left `pending`, with its first REAL Checkout session
 * already minted (mintGroupCheckout, called inline by the public submit
 * route, exactly like registrationPaidLoopSuite's own single-session case).
 *
 * Callers own paying the cart (payRealDestinationCharge — NOT this session;
 * see that function's own doc comment for why), own restoring
 * `previousHolderId` via releaseConnectAccount when done, and own adding
 * their owner's email (`delivered+${label}_${tag}@resend.dev`) to cleanup()'s list —
 * the registrant contact email needs no entry there (see
 * registrationPaidLoopSuite's own teardown comment: registering_self is
 * never set on a public submit, so nothing resolves that address to a users
 * row).
 */
export async function seedRealRegistrationCart(
  label: string,
  competitionName: string,
  feeCents: number,
): Promise<{
  owner: Session;
  orgId: string;
  regId: string;
  groupId: string;
  currency: string;
  feePercent: number;
  sessionId: string;
  accessToken: string;
  previousHolderId: string | null;
}> {
  // registrationPaidLoopSuite's own local shape, one section up — no shared
  // GENERIC_CONFIG constant exists in this file.
  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+${label}_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  // Narrowed local, not a `!` assertion — same reasoning as
  // payRealDestinationCharge's own: a caller reaching this point has
  // necessarily already passed the module-level presence check, which TS
  // cannot see across the function boundary.
  const account = CONNECT_TEST_ACCOUNT;
  if (!account) throw new Error("seedRealRegistrationCart requires CONNECT_TEST_ACCOUNT to be set");

  let previousHolderId: string | null = null;
  const claimDb = smokeDb();
  try {
    await claimDb`insert into sports (key, name, module_version, position_catalog)
             values ('generic', 'Generic', '1.0.0', ${claimDb.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
             on conflict (key) do nothing`;
    await claimDb`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('generic', 'score', 'Score', ${claimDb.json(genericConfig)}, true)
             on conflict do nothing`;
    const [holder] = await claimDb<{ id: string }[]>`
      select id from organizations where stripe_account_id = ${account}`;
    previousHolderId = holder?.id ?? null;
    await claimDb`update organizations set stripe_account_id = null where stripe_account_id = ${account}`;
    await claimDb`update organizations set currency = 'gbp' where id = ${orgId}`;
  } finally {
    await claimDb.end();
  }
  await setConnect(orgId, true, account);

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `${competitionName} ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: feeCents,
    payment_method: "stripe",
    approval: "auto",
  });

  const submitted = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      contact: { name: `Real Payer ${tag}`, email: `delivered+${label}player_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: div.id,
          entrant_kind: "individual",
          players: [{ full_name: `Real Payer ${tag}` }],
          answers: {},
        },
      ],
    },
  );
  type SubmitOut = {
    group_id: string;
    currency: string;
    checkout_url: string | null;
    access_token: string;
    entries: { registration_id: string }[];
  };
  const out = v1data<SubmitOut>(submitted);
  check(
    `${label}: real checkout session mints for the submitted cart`,
    submitted.status === 201 && !!out?.checkout_url?.startsWith("https://checkout.stripe.com/"),
  );

  const readDb = smokeDb();
  let sessionId: string;
  let feePercent: number;
  try {
    const [group] = await readDb<{ checkout_session_id: string | null; fee_percent: number | null }[]>`
      select checkout_session_id, fee_percent from registration_groups where id = ${out.group_id}`;
    if (!group?.checkout_session_id) {
      throw new Error(`seedRealRegistrationCart(${label}): no checkout_session_id recorded after submit`);
    }
    sessionId = group.checkout_session_id;
    feePercent = group.fee_percent ?? 0;
  } finally {
    await readDb.end();
  }

  return {
    owner,
    orgId,
    regId: out.entries[0].registration_id,
    groupId: out.group_id,
    currency: out.currency,
    feePercent,
    sessionId,
    accessToken: out.access_token,
    previousHolderId,
  };
}

/** v17 Phase-2 (V320+): the AI Schedule/Officials Architect is metered by a
 *  prepaid credit WALLET (`ai_credit_ledger`), not a per-division run count —
 *  the old graded per-division cap key was retired outright (V322). The
 *  wallet id an org spends from is `coalesce(subscription_id, org_id)`
 *  (`lib/credits.ts`'s `walletIdFor`, mirrored here as raw SQL since smoke
 *  can't import server-only app code). */
export async function walletIdForOrg(orgId: string): Promise<string> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ wallet_id: string }[]>`
      select coalesce(subscription_id, id)::text as wallet_id
        from organizations where id = ${orgId}`;
    if (!row) throw new Error(`walletIdForOrg: no organization ${orgId}`);
    return row.wallet_id;
  } finally {
    await sql.end();
  }
}

/** Credits currently in an org's AI wallet: `sum(delta)` over the ledger
 *  (mirrors `lib/credits.ts`'s `balance()`). */
export async function walletBalance(orgId: string): Promise<number> {
  const walletId = await walletIdForOrg(orgId);
  const sql = smokeDb();
  try {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    return Number(row?.bal ?? 0);
  } finally {
    await sql.end();
  }
}

/** Same as `walletBalance` but takes the wallet id directly — used to prove
 *  a wallet a billing-group move stepped AWAY from (its old subscription/
 *  group id, before the attach) is left holding nothing, rather than
 *  resolving through an org's CURRENT (post-move) wallet like
 *  `walletBalance` does. */
export async function walletBalanceByWalletId(walletId: string): Promise<number> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    return Number(row?.bal ?? 0);
  } finally {
    await sql.end();
  }
}

/** Drain an org's AI credit wallet down to exactly `remaining` credits via a
 *  single raw ledger debit row — the keyless-safe way smoke proves the
 *  `ai.credits` 402 fires without spending on a real model call. This
 *  replaces the old `seedAiRuns` (which seeded fake `schedule.ai_generated`
 *  competition_events for the now-retired per-division count cap). A no-op if
 *  the wallet already holds `remaining` or less. */
export async function drainWallet(orgId: string, remaining = 0): Promise<void> {
  const walletId = await walletIdForOrg(orgId);
  const current = await walletBalance(orgId);
  const drain = current - remaining;
  if (drain <= 0) return;
  const sql = smokeDb();
  try {
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${-drain}, 'admin_adjust', 'grant', ${remaining},
              ${`smoke-drain-${tag}-${orgId}-${Date.now()}`})`;
  } finally {
    await sql.end();
  }
}

/** Top up an org's AI credit wallet by `amount` via a single raw ledger
 *  credit row — the keyless-safe analog of the old `insertEntitlementOverride`
 *  "admin lifts the cap" step, updated for the wallet model: there is no
 *  per-division cap to override any more, only a balance to credit. Uses the
 *  grant bucket (SPEC-2 §5.4 D1); the bucket is immaterial to smoke, which only
 *  needs a spendable balance to drain. */
export async function topUpWallet(orgId: string, amount: number): Promise<void> {
  const walletId = await walletIdForOrg(orgId);
  const current = await walletBalance(orgId);
  const sql = smokeDb();
  try {
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${amount}, 'admin_adjust', 'grant', ${current + amount},
              ${`smoke-topup-${tag}-${orgId}-${Date.now()}`})`;
  } finally {
    await sql.end();
  }
}

/** A configured smoke postgres client (search_path seazn_club, local/remote SSL,
 *  pooler-aware prepare). Caller owns the connection and must `.end()` it. */
export function smokeDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for this smoke step");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
}

/** Grant an org-wide entitlement override — the same row /admin/entitlements
 *  writes. A boolean `value` lands in bool_value (a flag grant, e.g.
 *  api.access), a number in int_value (a graded cap, e.g.
 *  entrants.per_division.max). Not used for AI runs any more — those are
 *  metered by the credit wallet (`drainWallet`/`topUpWallet`), not an
 *  entitlement override (the old graded per-division run cap was retired,
 *  V322).
 *
 *  This is a raw-SQL write behind the resolver's back, exactly like setPlan's,
 *  so it busts the org's entitlement cache afterwards for the same reason: both
 *  call sites resolve (and therefore CACHE) the very key they are about to lift
 *  in the 402 check immediately above, so on any Redis-backed target the
 *  follow-up assertion would read the cached deny for up to 300s. `owner` is
 *  required, not optional — the bust needs a live owner session, and an
 *  optional parameter is an invitation for a future call site to skip it. */
export async function insertEntitlementOverride(
  owner: Session,
  orgId: string,
  featureKey: string,
  value: number | boolean,
): Promise<void> {
  const boolValue = typeof value === "boolean" ? value : null;
  const intValue = typeof value === "number" ? value : null;
  const sql = smokeDb();
  try {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value)
      values (${orgId}, ${featureKey}, ${boolValue}, ${intValue})
      on conflict (org_id, feature_key) do update
        set bool_value = ${boolValue}, int_value = ${intValue}, expires_at = null`;
  } finally {
    await sql.end();
  }
  await bustOrgEntitlements(owner, orgId);
}

/** The most recent competition_events payload of a given type, or null. */
export async function latestCompetitionEvent(
  competitionId: string,
  type: string,
): Promise<{
  model?: string;
  cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    repair_rounds: number;
  };
  /** #398: the stage-1 instruction compile, metered on its own line because it
   *  runs outside `spendCredit` and outside `budget`. */
  parse_tokens?: number;
  parse_failed?: boolean;
  spent_tokens?: number;
  budget?: number;
  /** #387: the `schedule.ai_quote_mismatch` payload — what the confirm card
   *  quoted against what the run actually charged. */
  quoted?: number;
  charged?: number;
} | null> {
  const sql = smokeDb();
  try {
    const [row] = await sql<
      {
        payload: {
          model?: string;
          cost_usd?: number;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            repair_rounds: number;
          };
        };
      }[]
    >`
      select payload from competition_events
      where competition_id = ${competitionId} and type = ${type}
      order by created_at desc limit 1`;
    return row?.payload ?? null;
  } finally {
    await sql.end();
  }
}

/** A plannable division for the AI architect: 4 individual entrants, one league
 *  stage, two-court schedule settings, fixtures generated. Returns its ids.
 *
 *  `startAt` defaults to a fixed date; pass `null` for a division with NO
 *  configured start date — the board #397 exists for, which used to be drafted
 *  from the epoch (see the anchor checks in v4AiSuite). */
export async function seedPlannableAiDivision(
  s: Session,
  label: string,
  startAt: string | null = "2026-10-01T09:00:00.000Z",
): Promise<{ compId: string; divId: string; stageId: string }> {
  const plannableOrgId = s.cookies["seazn_org"];
  const plannableVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${plannableOrgId}/venues`, "POST", { name: `${label} Venue ${tag}` }),
  );
  const plannableCourtA = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${plannableOrgId}/venues/${plannableVenue.id}/courts`, "POST", {
      name: "A",
    }),
  );
  const plannableCourtB = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${plannableOrgId}/venues/${plannableVenue.id}/courts`, "POST", {
      name: "B",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    s,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: `${n}${tag}`,
      seed: i + 1,
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      ...(startAt !== null ? { startAt } : {}),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [plannableCourtA.id, plannableCourtB.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST");
  return { compId: comp.id, divId: div.id, stageId: stage.id };
}

export interface AiPlanResponseLite {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string }[];
  /** Engine `Conflict[]` — non-blocking verdicts the organiser is shown rather
   *  than having repaired (rest, blackout, start window, an instruction rule). */
  warnings: { fixtureId: string; reason: string; detail?: string; rule?: string }[];
  /** Residual blockers after the repair rounds. Since #399 `person_overlap` and
   *  `window` are in here, not in `warnings`. */
  blocking: { fixtureId: string; reason: string; detail?: string; rule?: string }[];
  diff: unknown;
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
  /** W6 (#401): what the constraint solver did before any LLM repair round.
   *  Present on every plan — `solver_ran: false` on the clean path and when the
   *  kill switch is set — so its ABSENCE is a regression, not a valid state. */
  repair?: {
    engine: string;
    solver_ran: boolean;
    status?: string;
    moved?: number;
    unresolved?: number;
    minimality?: string;
  };
  officials_coverage: unknown;
}

/** W5 (#400): `AiParsePreviewResponse`, as much of it as smoke asserts on. */
export interface AiPreviewLite {
  preview_id?: string;
  failed: boolean;
  compiled: {
    hard: { type: string }[];
    soft: { note: string; weight: number }[];
    unparsed: string[];
    assumptions: string[];
  };
  window: { start: string; end: string; tz: string } | null;
}

/** Each division's current optimistic-concurrency token. The joint apply
 *  REQUIRES one per division: a joint write that skipped the check on one would
 *  let a stale board silently overwrite a concurrent edit there while every
 *  other division was guarded. */
export async function divisionSeqs(divisionIds: string[]): Promise<Record<string, number>> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ division_id: string; seq: number }[]>`
      select division_id, coalesce(max(seq), 0)::int as seq
        from division_events
       where division_id = any(${divisionIds}::uuid[])
       group by division_id`;
    const out: Record<string, number> = {};
    for (const id of divisionIds) out[id] = 0;
    for (const r of rows) out[r.division_id] = r.seq;
    return out;
  } finally {
    await sql.end();
  }
}

/** Fixtures carrying a slot, per division — the apply's actual effect on the
 *  board, rather than the count it reported about itself. */
export async function scheduledCountsByDivision(divisionIds: string[]): Promise<Record<string, number>> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ division_id: string; n: number }[]>`
      select division_id, count(*)::int as n
        from fixtures
       where division_id = any(${divisionIds}::uuid[])
         and scheduled_at is not null
       group by division_id`;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.division_id] = r.n;
    return out;
  } finally {
    await sql.end();
  }
}

/** Fetch a page WITHOUT following redirects — for 301 assertions (PROMPT-30). */
export async function pageRedirect(
  s: Session,
  path: string,
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    headers: Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
  });
  return { status: res.status, location: res.headers.get("location") };
}

/** Fetch a page as HTML with the session's cookies (raw() assumes JSON). */
export async function html(s: Session, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE + path, {
    headers: Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
  });
  return { status: res.status, body: await res.text() };
}

// v1 responses: { ok, data | error: {code, message, …}, requestId }.
export interface V1Res {
  status: number;
  headers: Headers;
  json: {
    ok: boolean;
    data?: unknown;
    error?: {
      code?: string;
      message?: string;
      current_seq?: number;
      /** Blocking schedule conflicts ride the 409 body (doc 12 §2, #399). */
      conflicts?: { rule?: string; blocking?: boolean; code?: string }[];
    };
    requestId?: string;
  };
}
export async function v1(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<V1Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
  return { status: res.status, headers: res.headers, json };
}
export const v1data = <T>(r: V1Res): T => r.json.data as T;

// Multipart POST for the file-upload endpoints (imports, logos).
export async function v1Multipart(s: Session, path: string, form: FormData): Promise<V1Res> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: form,
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
  return { status: res.status, headers: res.headers, json };
}

/** POST the scorer-sheets export as a browser would: the session cookie and an
 *  `Origin` header — proxy.ts refuses a foreign one on /api before the route
 *  runs. A raw fetch, not `v1()`: a 200 is PDF bytes, not a JSON envelope. */
export function printScorerSheets(s: Session, competitionId: string, date: string, origin: string): Promise<Response> {
  return fetch(`${BASE}/api/v1/competitions/${competitionId}/exports/scorer-sheets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader(s), Origin: origin },
    body: JSON.stringify({ date }),
  });
}

/** The sheet's day of an instant: the competition's ORG clock (scorer-sheets
 *  `competitionClock` → `resolveVenueTz(null, org tz)`, UTC when unset). */
export async function orgDayOf(s: Session, competitionId: string, iso: string): Promise<string> {
  const orgId = v1data<{ org_id: string }>(await v1(s, `/api/v1/competitions/${competitionId}`)).org_id;
  const orgs = (await call(s, "/api/orgs")) as { id: string; timezone: string | null }[];
  const tz = orgs.find((o) => o.id === orgId)?.timezone || "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

/**
 * S13/W11 — post one score event through the SAME wire contract the v2
 * ScorePad's own transport.ts sends (POST /api/v1/fixtures/{id}/events with
 * expected_seq/type/payload/idempotency_key), retrying on a genuine 409
 * SEQ_CONFLICT rather than assuming the first attempt lands clean (doc 08
 * §4). `current_seq` rides the 409 body only when the engine error carried a
 * numeric actualSeq (http.ts) — falls back to a fresh GET .../state read
 * exactly like transport.ts's own documented fallback when it does not. A
 * FRESH idempotency_key on every attempt: engine-db/append-event.ts always
 * mints its own randomUUID() for the persisted row id regardless of the key
 * sent (scoring.ts never forwards the client's key as the row id), and the
 * dedup cache in front of it is fail-open Redis with no ledger column — so
 * reusing one key across a retry buys no provable no-op here, and this
 * helper never leans on it for correctness.
 */
export async function appendScoreEvent(
  s: Session,
  fixtureId: string,
  type: string,
  payload: unknown,
): Promise<V1Res> {
  let expectedSeq = v1data<{ last_seq: number }>(
    await v1(s, `/api/v1/fixtures/${fixtureId}/state`),
  ).last_seq;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await v1(s, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: expectedSeq,
      type,
      payload,
      idempotency_key: `smoke-${tag}-${fixtureId}-${type}-${attempt}`,
    });
    if (res.status !== 409) return res;
    expectedSeq =
      typeof res.json.error?.current_seq === "number"
        ? res.json.error.current_seq
        : v1data<{ last_seq: number }>(await v1(s, `/api/v1/fixtures/${fixtureId}/state`)).last_seq;
  }
  throw new Error(`${type} on fixture ${fixtureId} never landed after 3 attempts (persistent SEQ_CONFLICT)`);
}

/**
 * Drop an org's server-side entitlement cache (`ent:{org}:*`) after a raw-SQL
 * write that the resolver cannot see — a plan flip (setPlan) or an override
 * grant (insertEntitlementOverride). lib/entitlements resolves cache-aside with
 * a 300s TTL, so on any Redis-backed target (staging, a prod smoke run) an
 * entitlement resolved BEFORE the write stays cached and the write never lands
 * inside the run. Locally and in CI REDIS_URL is normally unset — the cache
 * layer is inert there and this is a cheap no-op round-trip.
 *
 * There is no public invalidation endpoint, so this rides the superadmin
 * entitlement-override route (its POST and DELETE both call
 * invalidateOrgEntitlements): the org's OWNER is flipped to superadmin in SQL
 * for the two calls, then restored. Same mechanism as
 * apps/web/e2e/helpers.ts:283-307.
 *
 * `owner` must be a live session for that org's owner. It is deliberately an
 * EXISTING session rather than a fresh signIn: /api/auth/magic-link is rate
 * limited to 5 per 300s per IP and fails CLOSED wherever Redis is configured —
 * i.e. in exactly the environments this bust exists for.
 */
async function bustOrgEntitlements(owner: Session, orgId: string): Promise<void> {
  const setOwnerStaff = async (on: boolean) => {
    const sql = smokeDb();
    try {
      await sql`
        update users set is_staff = ${on}, staff_role = ${on ? "superadmin" : null}
        where id in (
          select user_id from org_members where org_id = ${orgId} and role = 'owner'
        )`;
    } finally {
      await sql.end();
    }
  };
  const KEY = "smoke.cache.bust";
  const path = `/api/admin/orgs/${orgId}/entitlement-override`;
  // The elevate is INSIDE the try: its update commits before the call returns,
  // so anything that throws between the commit and the try entering would leave
  // the org owner a live superadmin with nothing to restore it. `finally` runs
  // whether or not the elevate itself succeeded, and demoting an already-plain
  // user is a harmless no-op.
  try {
    await setOwnerStaff(true);
    // Both calls THROW on non-2xx rather than check(). raw() returns a status
    // and never throws, so an unasserted 401/404 here is a silent no-op: no
    // invalidation, no override row, run still green — the exact bug this
    // function exists to fix, with no signal. A throw is stronger than a check
    // because it stops the run at the cause instead of letting every later
    // assertion read a stale cache; it also surfaces a failed DELETE, which is
    // the only thing standing between this and a stranded override row.
    const posted = await raw(owner, path, "POST", {
      feature_key: KEY,
      reason: "smoke: drop cached entitlements after a raw entitlement write",
    });
    if (posted.status < 200 || posted.status >= 300) {
      throw new Error(
        `entitlement-cache bust POST failed (${posted.status}): ${JSON.stringify(posted.json)}`,
      );
    }
    const deleted = await raw(owner, path, "DELETE", { feature_key: KEY });
    if (deleted.status < 200 || deleted.status >= 300) {
      throw new Error(
        `entitlement-cache bust DELETE failed (${deleted.status}) — the ${KEY} override is stranded: ` +
          JSON.stringify(deleted.json),
      );
    }
  } finally {
    await setOwnerStaff(false);
  }
}

/** Flip an org's plan directly in the DB — smoke targets a disposable DB and
 *  the billing checkout path can't run without Stripe. `owner` (the org
 *  owner's session) is required, not optional: the raw-SQL write goes behind
 *  the resolver's back, so every flip must bust the entitlement cache or a
 *  Redis-backed target keeps serving the pre-flip answers for up to 300s. */
export async function setPlan(orgId: string, plan: string, owner: Session): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to change a plan in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    // Billing lives on the GROUP (V310): reprice the group the org already bills
    // through, and only mint one — with the org's owner as payer — if it has none.
    const [org] = await sql<{ subscription_id: string | null }[]>`
      select subscription_id from organizations where id = ${orgId}`;
    if (org?.subscription_id) {
      await sql`
        update subscriptions
           set plan_key = ${plan}, status = 'active', updated_at = now()
         where id = ${org.subscription_id}`;
    } else {
      const [group] = await sql<{ id: string }[]>`
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(
                 (select m.user_id from org_members m
                   where m.org_id = o.id and m.role = 'owner'
                   order by m.created_at limit 1),
                 o.created_by),
               ${plan}, 'active'
          from organizations o where o.id = ${orgId}
        returning id`;
      await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
  await bustOrgEntitlements(owner, orgId);
}

export async function cleanup(tag: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("cleanup skipped (DATABASE_URL not set)");
    return;
  }
  const emails = [
    `delivered+admin_${tag}@resend.dev`,
    `delivered+viewer_${tag}@resend.dev`,
    `delivered+member_${tag}@resend.dev`,
    `delivered+gap_official_${tag}@resend.dev`,
    `delivered+free_${tag}@resend.dev`,
    `delivered+walkin_${tag}@resend.dev`,
    // #402 — gapSuite's signed-in self-registrant. Its persons rows live in the
    // admin's Pro org and go with that org in the same delete statement above,
    // so nothing still references this user by the time the users delete runs.
    `delivered+selflink_${tag}@resend.dev`,
    `delivered+ui_free_${tag}@resend.dev`,
    `delivered+disc_free_${tag}@resend.dev`,
    `delivered+pass_${tag}@resend.dev`,
    `delivered+aboveprorung_${tag}@resend.dev`,
    `delivered+funnel_${tag}@resend.dev`,
    `delivered+tos_${tag}@resend.dev`,
    `delivered+player_${tag}@resend.dev`,
    `delivered+ref_${tag}@resend.dev`,
    `delivered+p72_${tag}@resend.dev`,
    // #451 cricketDlsSuite — its own Pro org (two cricket divisions cascade).
    `delivered+dls_${tag}@resend.dev`,
    // S13/W11 scorePadV2AppendSuite's own free (community) org — pre-existing
    // gap, found and fixed in R8 sweep task G's review (fix round 1): missing
    // here since that suite was added, every smoke run leaked its org.
    `delivered+scorepadfree_${tag}@resend.dev`,
    // R8 sweep, task G — footballFidelityGateSuite's own free (community)
    // org (its one division/fixture cascades with it).
    `delivered+fidelitygatefree_${tag}@resend.dev`,
    // #404 personMergeSuite — its own Pro org (its two persons, their
    // suspension and the person_merges ledger row all cascade with it).
    `delivered+dupmerge_${tag}@resend.dev`,
    // T15 arbiterSuite — its owner's org (one over-the-board chess division)
    // and its stranger's.
    `delivered+smoke-arb-${tag}@resend.dev`,
    `delivered+smoke-arb-stranger-${tag}@resend.dev`,
    // T16 onlineChessDeskSuite — its owner's org (two over-the-board chess
    // divisions, one public, one private, and the competition of three more
    // built by onlineChessDivisionPages: online with a stage, over the board,
    // online with a league, whose member-less entrants carry no person) and
    // its stranger's.
    `delivered+smoke-ocd-${tag}@resend.dev`,
    `delivered+smoke-ocd-stranger-${tag}@resend.dev`,
    // T14 autoScheduleSuite — its own Pro org (one competition, one division
    // and its six fixtures all cascade with it).
    `delivered+smoke-autosched-${tag}@resend.dev`,
    // P9 review: twoVenueSuite's own Pro org (its two venues and their
    // courts) — was missing from this list entirely, so every smoke run
    // leaked the org along with its venues/courts (the courts/venues purge
    // below is keyed off this SAME `emails` array via `doomedOrgs`).
    `delivered+smoke-two-venue-${tag}@resend.dev`,
    `delivered+p72comm_${tag}@resend.dev`,
    `delivered+smoke-community-${tag}@resend.dev`,
    `delivered+smoke-pro-${tag}@resend.dev`,
    `delivered+smoke-enterprise-${tag}@resend.dev`,
    `delivered+smoke-pass-${tag}@resend.dev`,
    // T20 publicQuotaDegradeSuite — its own community org (the cap-many public
    // competitions, the degraded one and the templated one all cascade with
    // it, as does its competitions.max_active override).
    `delivered+pubquota_${tag}@resend.dev`,
    // Task 23 — passGrantsSuite's own org (its two competitions, pass row,
    // sponsors, packages, person and AI ledger rows all cascade with it).
    `delivered+passgrant_${tag}@resend.dev`,
    // v17 #294 passRungLSuite — the community buyer (three competitions, two
    // bought passes, the +25 grants) and the Pro org holding an inert L pass.
    `delivered+passl_${tag}@resend.dev`,
    `delivered+passlpro_${tag}@resend.dev`,
    // Task 20 — the three extra users seeded per plan org (owner is above).
    ...["community", "pro", "enterprise", "pass"].flatMap((k) => [
      `delivered+official_${k}_${tag}@resend.dev`,
      `delivered+official2_${k}_${tag}@resend.dev`,
      `delivered+player_${k}_${tag}@resend.dev`,
    ]),
    `delivered+clubpro_${tag}@resend.dev`,
    `delivered+clubfree_${tag}@resend.dev`,
    `delivered+trial_staff_${tag}@resend.dev`,
    `delivered+trial_pro_${tag}@resend.dev`,
    `delivered+trial_free_${tag}@resend.dev`,
    `delivered+trial_dep_${tag}@resend.dev`,
    `delivered+pm_staff_${tag}@resend.dev`,
    `delivered+pm_owner_${tag}@resend.dev`,
    // The one-click email-invite claimee (auto-login + join). Its org_members
    // row is dropped inline after the claim assertions to free the seat; this
    // clears the leftover user row at teardown.
    `delivered+emailinvitee_${tag}@resend.dev`,
    // #267 referralSuite — referrer + referred, own orgs. Both rows go in the
    // same `delete from organizations` statement, so the self-referencing
    // `referred_by_org_id` FK (NO ACTION, checked at end-of-statement) never
    // trips: by the time it's checked, both rows are already gone together.
    `delivered+referrer_${tag}@resend.dev`,
    `delivered+referred_${tag}@resend.dev`,
    // #293 extraOrgAddonSuite — the Pro payer (whose four seeded fill
    // organisations carry created_by = this user and so go with the purge
    // below), the non-payer co-owner, and the community owner.
    `delivered+orgaddon_${tag}@resend.dev`,
    `delivered+orgaddon_nonpayer_${tag}@resend.dev`,
    `delivered+orgaddon_free_${tag}@resend.dev`,
    // registrationPaidLoopSuite — the org owner. `delivered+regpayer_${tag}@resend.dev`
    // (the registrant's own contact email on the submit) is NOT a users row —
    // registering_self is never set on that entry, so nothing resolves it to
    // a person/user — it needs no entry here; the org purge above already
    // cascades its registration_groups row away with the org.
    `delivered+regpay_${tag}@resend.dev`,
    // RS006 money-hardening — registrationDuplicatePaymentSuite and
    // registrationRefundReversalSuite, each its own Pro org owner. Same
    // "registrant contact email needs no entry" reasoning as regpay_ above
    // applies to `delivered+regdupplayer_${tag}@resend.dev`/`delivered+regrefundplayer_${tag}@resend.dev`.
    `delivered+regdup_${tag}@resend.dev`,
    `delivered+regrefund_${tag}@resend.dev`,
    // RS010 registration-core-flow smoke — each of the four new suites' own
    // org owner. Same "anonymous registrant contact email needs no entry"
    // reasoning as regpay_ above applies to every non-self contact email
    // these suites submit (openflow_free_/openflow_manual_/wait*_/*cap_/
    // soloplayer_) — none of them sign in, so none mint a users row.
    // `delivered+selflink_${tag}@resend.dev` (registrationSelfLinkAndConsentSuite's
    // own SIGNED-IN self-registrant) is already above, from gapSuite's now-
    // orphaned #402 entry — reused, not duplicated.
    `delivered+regopen_${tag}@resend.dev`,
    `delivered+regwait_${tag}@resend.dev`,
    `delivered+regteam_${tag}@resend.dev`,
    `delivered+regself_${tag}@resend.dev`,
    // Task 15 (spectator W1) — matchCentreSmoke's own org (one competition,
    // one cricket division and its fixture cascade with it).
    `delivered+matchcentre_${tag}@resend.dev`,
    // publicWithdrawnStandingsSuite's own free org. Without this line the
    // suite leaves an organisation and a user behind on EVERY smoke run —
    // silently, because nothing in the suite asserts on them.
    `delivered+wd_board_${tag}@resend.dev`,
    // entrantRenameSuite's own free org (same reason as the line above).
    `delivered+rename_${tag}@resend.dev`,
    // sitemapSuite's own org — and with it a PUBLIC, PUBLISHED competition,
    // which without this line would stay listed in the sitemap of whatever
    // database the run was pointed at.
    `delivered+sitemap_${tag}@resend.dev`,
    // captureV2Suite's own Pro org — its fixture, stream code, pairing and stopped session cascade with it.
    `delivered+capturev2_${tag}@resend.dev`,
    // captureRecordSuite's own Pro org — its fixture, stream code and capture records cascade with it.
    `delivered+caprecord_${tag}@resend.dev`,
    // bracketFinishSuite's own Pro org (W2a T17) — its PUBLIC competition and its settled bracket cascade with it.
    `delivered+bracketfinish_${tag}@resend.dev`,
    // walkoverCreditSuite's own org (W2b T18) — its two competitions, one PUBLIC with walked-over and archived divisions.
    `delivered+walkovercredit_${tag}@resend.dev`,
    // outboxTrialWarningSuite's own org (email outbox phase 3 wave 2 T11) — its group goes with the orphaned-group purge
    // below. Its trial_ending row has no org, so the suite deletes that itself.
    `delivered+trialwarn_${tag}@resend.dev`,
    // w2cStageRulesSuite's own Pro org (W2c T10) — found in review (W2d A14 m4): it was never purged, one org a run.
    `delivered+w2c_${tag}@resend.dev`,
    // w2dTablesSuite's own org (W2d A-smoke) — its competition, the pinned stage and its stored lots draws cascade with it.
    `delivered+w2d_${tag}@resend.dev`,
    // youtubeConnectSuite's two orgs (YouTube Connect T21) - the connections, destinations, broadcasts, fixtures and pending grants
    // all cascade with the org (V479: on delete cascade on org_id).
    `delivered+ytconnect_${tag}@resend.dev`,
    `delivered+ytconnect_b_${tag}@resend.dev`,
  ];
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  let teardownError: string | null = null;
  try {
    // billing_events carries NO org FK (it is the raw Stripe ledger, keyed by
    // event id), so passRungLSuite's synthetic webhook rows survive the org
    // purge below. Dropped by the run's own `evt_smoke_<tag>_` prefix, which
    // cannot touch another run's rows or a real Stripe event.
    await sql`delete from billing_events where id like ${`evt_smoke_${tag}_%`}`;
    // org_addons.wallet_id is TEXT with NO foreign key (V323 — a wallet is
    // coalesce(group_subscription_id, org_id) and so cannot reference one
    // table), so #293's rider row outlives both its organisation and its
    // group. Dropped by this run's own stripe_item_id, which cannot match
    // another run's row nor a real Stripe item.
    await sql`delete from org_addons where stripe_item_id = ${`si_smoke_orgaddon_${tag}`}`;
    // sponsor_orders are RESTRICT (V299): money rows must go before their org.
    await sql`
      delete from sponsor_orders
      where org_id in (select id from organizations
                       where created_by in (select id from users where email = any(${emails})))`;
    // P9: courts must go BEFORE venues, and both before the org. P8 made
    // `courts.venue_id` ON DELETE RESTRICT on purpose (amendment A3 — a venue
    // with courts must not vanish through the API), and a RESTRICT sitting
    // inside the organizations cascade path blocks the whole delete:
    //   update or delete on table "venues" violates foreign key constraint
    //   "courts_venue_id_org_id_fkey" on table "courts"
    // No product code deletes an organisation — this is a harness-only
    // ordering problem, so it is fixed here rather than by weakening a
    // constraint that exists to protect real data.
    const doomedOrgs = sql`select id from organizations
                           where created_by in (select id from users where email = any(${emails}))`;
    // `fixtures.court_id` is ON DELETE RESTRICT as well (same A3 reasoning), so
    // the cards have to let go of their courts before the courts can go.
    await sql`update fixtures set court_id = null, venue_id = null
              where org_id in (${doomedOrgs})`;
    await sql`delete from court_exceptions where org_id in (${doomedOrgs})`;
    await sql`delete from court_hours where org_id in (${doomedOrgs})`;
    await sql`delete from courts where org_id in (${doomedOrgs})`;
    await sql`delete from venues where org_id in (${doomedOrgs})`;
    const orgs = await sql`
      delete from organizations
      where created_by in (select id from users where email = any(${emails}))`;
    // Any test user the run turned into a staff ACTOR is deliberately left
    // behind. staff_audit_log.actor_id → users.id has no ON DELETE, so those
    // users cannot be dropped without first touching the audit log — and the
    // audit log must not be touched. V111 makes it tamper-EVIDENT: every row's
    // hash is chained to the previous one, and /admin/audit renders a permanent
    // "hash chain broken" banner as soon as verify_staff_audit_log_chain()
    // finds a mismatch. Deleting rows is exactly the tampering that design
    // exists to detect, and repointing actor_id is no better — the verifier
    // recomputes row_hash from the LIVE column values (actor_id among them),
    // while the trigger only fires `before insert`, so an UPDATE breaks the
    // chain just as permanently. Nothing repairs it afterwards. A handful of
    // leftover user rows per run is the cheaper cost by a wide margin.
    // That set is no longer two accounts. It is oneTrialSuite's staff account,
    // platformRevenueSuite's admin (the revenue page logs
    // revenue_report_viewed), AND the OWNER of every org that went through
    // setPlan or insertEntitlementOverride — both bust the entitlement cache
    // through the superadmin override route, which logs an
    // entitlement_override + entitlement_override_removed pair under that
    // owner's id. Measured on a full local run: 16 distinct owners become bust
    // actors (26 override/override_removed pairs), 19 distinct staff actors in
    // total — so ~19 retained user rows per run, up from ~2. It is the
    // accepted price of a bust that actually works: the alternative is a
    // dedicated staff account, which needs its own signIn, and
    // /api/auth/magic-link is rate limited to 5 per 300s per IP and fails
    // CLOSED wherever Redis is set. Do not engineer around the residue — the
    // subquery keeps this correct for any suite that becomes a staff writer
    // later, and their ORGS are still removed (the org purge above keys on the
    // same `emails` list).
    // Billing groups outlive their organisations (V310): organizations points
    // AT subscriptions, so dropping the orgs above leaves the group rows behind,
    // and subscriptions.owner_user_id → users(id) has no ON DELETE. Without this
    // the user delete below aborts on subscriptions_owner_fk and takes the whole
    // teardown with it. Only groups nobody is in — a group still holding an org
    // belongs to another run and must not be touched.
    await sql`
      delete from subscriptions s
      where s.owner_user_id in (select id from users where email = any(${emails}))
        and not exists (select 1 from organizations o where o.subscription_id = s.id)`;
    const users = await sql`
      delete from users
      where email = any(${emails})
        and id not in (select actor_id from staff_audit_log)`;
    console.log(`cleanup: removed ${orgs.count} org(s), ${users.count} user(s)`);
  } catch (e) {
    // Recorded, not swallowed. The check below is the guard against a teardown
    // that damages the audit trail, and the symptom that motivated it WAS a
    // teardown abort (the staff_audit_log FK violation) — so an abort has to
    // make that check red, never a warning line next to a green run.
    teardownError = e instanceof Error ? e.message : String(e);
    console.warn("cleanup failed:", teardownError);
  }
  // Deliberately OUTSIDE the try above, so a throw in the deletes still reaches
  // this assertion. Its own failures are caught the same way, for the same
  // reason: an unreadable audit table is a red check, not a silent skip.
  let audit: { mine: number; broken: string | null } | undefined;
  try {
    [audit] = await sql<{ mine: number; broken: string | null }[]>`
      select (select count(*)::int from staff_audit_log
              where actor_id in (select id from users where email = any(${emails}))) as mine,
             verify_staff_audit_log_chain()::text as broken`;
  } catch (e) {
    console.warn("audit-trail probe failed:", e instanceof Error ? e.message : e);
  } finally {
    await sql.end();
  }
  // Teardown must complete AND leave the audit trail alone. Every conjunct can
  // fail on a different real regression:
  //  - teardownError — the deletes threw (the original symptom: the
  //    staff_audit_log FK aborting the whole purge);
  //  - audit.mine > 0 — the run's own audit rows were deleted, which is what a
  //    teardown that purges them (the fix this replaced) does;
  //  - audit.broken === null — the V111 hash chain no longer verifies, which is
  //    what a MID-chain deletion does. On its own this conjunct is NOT enough:
  //    the run's rows sit at the TIP of the chain on a quiet DB, and lopping off
  //    the tail still verifies — the corruption only becomes permanent once
  //    anything else (a parallel e2e run, a real staff action) has written after
  //    them. All three together are the honest assertion.
  check(
    "cleanup completes and keeps the staff audit trail (rows survive, V111 chain verifies)",
    teardownError === null && !!audit && audit.mine > 0 && audit.broken === null,
  );
}
