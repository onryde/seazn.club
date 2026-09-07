import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  seedDivision,
  releaseDivision,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { apiJson, setOrgConnectSql } from "../helpers";
// A VALUE import, deliberately — the same choice `settings-schedule-bounds
// .spec.ts:28` (W6 Task 2) documents and empirically probed: identity against
// the server's own constant, never a hand-typed literal that could silently
// drift from the real message. `schemas.ts` pulls `@seazn/engine/scheduling`
// and `lib/registration-rules.ts`; both are pure TS/zod with no `server-only`
// and no JSON import, so Playwright's ESM loader takes them (the failure that
// import shape CAN produce — `Error: No tests found` from a transitive
// `import x from "*.json"` — is `src/lib/currency.ts`'s, not this one's).
import {
  AGE_CUTOFF_BOTH_OR_NEITHER,
  AGE_CUTOFF_DAY_INVALID_FOR_MONTH,
} from "../../src/server/api-v1/schemas";

/**
 * W7 Task 2 — the age-cutoff bounds matrix on `PATCH /api/v1/divisions/{id}`,
 * and the card-fee minimum proved on the SERVER, with the client gate
 * bypassed entirely.
 *
 * Entirely API-only (`APIRequestContext`, no `page`). Task 1
 * (`settings-registration-client-guards.spec.ts`) owns everything about this
 * surface a browser is needed for — the client-side fee gate refusing before
 * any network write, the double-tap guard, the two-endpoint half-save. This
 * file is the other half of that pair: what the server says to a request the
 * panel would never have sent. Case #20's client gate and this file's card-fee
 * case deliberately assert DIFFERENT sentences for the same rule, because the
 * client and the server genuinely say it differently (see `CARD_FEE_MINIMUM`
 * below) — that difference is what lets each test witness its own layer.
 *
 * `mode: "default"` — an explicit opt-OUT of the config's file-level
 * `fullyParallel: true` (`playwright.config.ts:126`; the `walkthrough` project
 * itself declares no override, and CI runs the leg `--workers=3`). Read out of
 * Playwright's own grouping (`runner/index.js:2281`): a suite whose
 * `_parallelMode` is `"default"` becomes the `outerMostSequentialSuite`, so
 * every test under it lands in ONE group, in ONE worker, in order — which is
 * what makes a single `beforeAll`-seeded org shared rather than re-seeded per
 * worker against a Pro user capped at five owned orgs. `serial` would do that
 * too and is still refused: it skips every test after the first red
 * (AGENTS.md failure class 21), and a file whose whole subject is refusals
 * would then report one finding and hide the rest.
 */
test.describe.configure({ mode: "default" });

// ---------------------------------------------------------------------------
// Server sentences with no exported constant to import.
//
// Both are bare `new HttpError(422, "...")` literals inside
// `putRegistrationSettings` (`src/server/usecases/registrations.ts`) — not
// dictionary keys, not exported strings — so unlike the two AGE_CUTOFF_*
// constants above there is nothing to bind to and the text is mirrored here,
// each beside a pointer to its single source.
// ---------------------------------------------------------------------------

/**
 * The SERVER's card-fee rule. Note this is NOT the client's sentence: the
 * panel renders `reg.hub.config.cardFeeMinimumError`
 * ("Card entry fees must be at least 1.00, or 0 to make entry free."), which
 * Task 1's case #20 asserts. The two share the prefix
 * "Card entry fees must be at least 1.00", so a `toContain` on that prefix
 * passes in BOTH states — including the state this file exists to rule out,
 * where the server check is gone and only the client refuses. Every assertion
 * below is therefore an exact `toBe`.
 */
const CARD_FEE_MINIMUM = "Card entry fees must be at least 1.00 (or 0 for free)";

/**
 * The Connect precondition that sits AHEAD of the fee-minimum check in
 * `putRegistrationSettings`. Unreachable from the panel by design — the card
 * radio is `disabled={cardUnavailable}` whenever `charges_enabled` is false
 * (`registration-hub-config-panel.tsx`), so a browser can never send the body
 * that reaches it. An API-only file is the only place it can be covered at
 * all, which is why it is asserted here rather than merely worked around.
 */
const CONNECT_REQUIRED = "Connect Stripe under Settings → Connect before choosing card payments";

/**
 * `isValidCutoffDay`'s every-year-safe month table
 * (`lib/registration-rules.ts`'s `DAYS_IN_MONTH`), restated here as the
 * matrix's own INPUTS rather than imported: importing the table and deriving
 * the cases from it would make the test agree with the implementation by
 * construction and could not witness a change to it. February is 28 by
 * design — the check has to hold for every year, so 29 February is refused
 * too, which is the one row a reader is most likely to mistake for a bug.
 */
const IMPOSSIBLE_DAYS: readonly (readonly [month: number, day: number])[] = [
  [2, 29], // never valid under an every-year table
  [2, 30],
  [2, 31],
  [4, 31], // April
  [6, 31], // June
  [9, 31], // September
  [11, 31], // November
];

/** The last real day of each of those months, plus both 31-day ends of the
 *  year — a bounds matrix that only ever refuses proves nothing about what it
 *  lets through. */
const REAL_DAYS: readonly (readonly [month: number, day: number])[] = [
  [1, 31],
  [2, 28],
  [4, 30],
  [6, 30],
  [9, 30],
  [11, 30],
  [12, 31],
];

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

interface ValidationIssue {
  code: string;
  path: (string | number)[];
  message: string;
}
interface ValidationErrorBody {
  code?: string;
  message?: string;
  issues?: ValidationIssue[];
}
interface ApiResult<T = unknown> {
  status: number;
  data?: T;
  error?: { code?: string; message?: string };
}

/** The zod `issues` array the wire type does not declare but the JSON body
 *  genuinely carries (`errorResponse`'s `extra` spread, `http.ts:113`). */
function issuesOf(res: ApiResult): ValidationIssue[] {
  return (res.error as ValidationErrorBody | undefined)?.issues ?? [];
}

/**
 * Assert a refusal is the ZodError one — 400/VALIDATION carrying an issue at
 * `age_cutoff_day` whose message is EXACTLY the named constant.
 *
 * Pinning the path as well as the message matters: both cutoff rules report
 * on `age_cutoff_day` (`checkAgeCutoff`, schemas.ts), and a refusal that
 * arrived from somewhere else entirely — the 422 DB-CHECK backstop, a
 * different field's bound — would otherwise satisfy a message-only check.
 */
function expectCutoffIssue(res: ApiResult, message: string, note: string): void {
  expect(res.status, `${note}: ${JSON.stringify(res.error)}`).toBe(400);
  expect(res.error?.code, note).toBe("VALIDATION");
  const matching = issuesOf(res).filter(
    (i) => i.path.join(".") === "age_cutoff_day" && i.message === message,
  );
  expect(
    matching,
    `${note}: expected one issue at age_cutoff_day saying ${JSON.stringify(message)}, got ${JSON.stringify(issuesOf(res))}`,
  ).toHaveLength(1);
}

async function patchDivision(
  request: APIRequestContext,
  divisionId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", body);
}

interface DivisionEligibility {
  age_min: number | null;
  age_max: number | null;
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
}

/** The row as the SERVER holds it, never a PATCH's own echo. */
async function readDivision(
  request: APIRequestContext,
  divisionId: string,
): Promise<DivisionEligibility> {
  const res = await apiJson<DivisionEligibility>(
    request,
    `/api/v1/divisions/${divisionId}`,
    "GET",
  );
  expect(res.status, `GET /divisions/{id}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data, "the division GET must carry a row").toBeDefined();
  return res.data!;
}

async function putRegistrationSettings(
  request: APIRequestContext,
  divisionId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", body);
}

/** A card-payment registration body that differs ONLY in its fee — so every
 *  row of the fee matrix below is the same request with one number moved. */
function cardSettingsBody(feeCents: number): Record<string, unknown> {
  return {
    enabled: true,
    entrant_kind: "team",
    payment_method: "stripe",
    fee_cents: feeCents,
    approval: "auto",
  };
}

/**
 * Fully DETACH the fabricated Connect account this file attaches.
 *
 * Copied in shape (not imported — a spec cannot import a spec) from
 * `settings-connect-gates.spec.ts`'s own `detachConnect`, and needed for the
 * same reason: helpers' `setOrgConnectSql(orgId, false)` does NOT detach. It
 * writes `stripe_account_id = coalesce(stripe_account_id, 'acct_e2e_…')`, so
 * it always leaves an account attached and only moves `charges_enabled`.
 * `organizations_stripe_account_idx` is a UNIQUE index with the predicate
 * `WHERE stripe_account_id IS NOT NULL` and no `deleted_at` clause, while
 * `releaseSettingsOrg` only SOFT-deletes — so an org released with an account
 * still attached keeps occupying that id forever.
 */
async function detachConnect(orgId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false });
  try {
    await sql`
      update organizations
      set stripe_account_id = null, stripe_charges_enabled = false
      where id = ${orgId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------

let org: SeededOrg;
let comp: SeededCompetition;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture — `seedSettingsOrg` moves the
  // `seazn_org` cookie of whatever jar it is handed, a per-test fixture's jar
  // is not the one any test gets anyway, and `request` is test-scoped so a
  // `beforeAll` cannot depend on it at all.
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W7-bounds" });
    comp = await seedCompetition(ctx.request, org.orgId, {});
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // Guarded independently per resource, never `comp.id` unconditionally: a
  // mid-`beforeAll` throw leaves `comp` undefined, and an unguarded read here
  // would throw before `releaseSettingsOrg` ever ran — leaking one of the
  // shared Pro user's five owner slots for the rest of the leg. The release
  // lives HERE and not in any test's `finally`, because a Playwright
  // `test.setTimeout` does not unwind the test function and that `finally`
  // would never run.
  const ctx = await browser.newContext();
  try {
    if (org) {
      // Swallowed on purpose: the detach is hygiene, the RELEASE is the
      // obligation, and one DB blip must not cost an owner slot.
      try {
        await detachConnect(org.orgId);
      } catch {
        // the release below is still owed
      }
    }
    if (comp) await releaseCompetition(ctx.request, comp.id);
    if (org) await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Age cutoff: the day-for-month matrix
// ---------------------------------------------------------------------------

test("an impossible cutoff day is refused for every short month, and each month's real last day is accepted", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id, { name: `W7 bounds cutoff-days ${TAG()}` });
  try {
    for (const [month, day] of IMPOSSIBLE_DAYS) {
      const res = await patchDivision(request, div.id, {
        age_cutoff_month: month,
        age_cutoff_day: day,
      });
      expectCutoffIssue(res, AGE_CUTOFF_DAY_INVALID_FOR_MONTH, `cutoff ${day}/${month}`);
    }

    // Nothing above was stored: an impossible pair must not have reached the
    // row. Read from the server, not from the last response.
    const untouched = await readDivision(request, div.id);
    expect(untouched.age_cutoff_month, "no refused cutoff may have been stored").toBeNull();
    expect(untouched.age_cutoff_day, "no refused cutoff may have been stored").toBeNull();

    for (const [month, day] of REAL_DAYS) {
      const res = await patchDivision(request, div.id, {
        age_cutoff_month: month,
        age_cutoff_day: day,
      });
      expect(res.status, `cutoff ${day}/${month}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }

    // And the last accepted pair genuinely landed.
    const [lastMonth, lastDay] = REAL_DAYS[REAL_DAYS.length - 1];
    const stored = await readDivision(request, div.id);
    expect(stored.age_cutoff_month).toBe(lastMonth);
    expect(stored.age_cutoff_day).toBe(lastDay);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("cutoff both-or-neither: either field alone is refused, and both-null is accepted", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id, { name: `W7 bounds cutoff-pairing ${TAG()}` });
  try {
    const monthOnly = await patchDivision(request, div.id, { age_cutoff_month: 6 });
    expectCutoffIssue(monthOnly, AGE_CUTOFF_BOTH_OR_NEITHER, "age_cutoff_month alone");

    const dayOnly = await patchDivision(request, div.id, { age_cutoff_day: 15 });
    expectCutoffIssue(dayOnly, AGE_CUTOFF_BOTH_OR_NEITHER, "age_cutoff_day alone");

    // NOT asserted here, deliberately — F12 (`FINDINGS.md`). A single-field
    // patch carrying an explicit NULL (`{ age_cutoff_day: null }` against a
    // stored month) is ACCEPTED 200 and stores an orphan half, because
    // `checkAgeCutoff`'s `(month != null) !== (day != null)` reads a
    // NOT-SUPPLIED field and an explicit null identically, and the DB CHECK
    // cannot catch it either (one NULL side makes the second disjunct NULL,
    // and `false OR NULL` satisfies a CHECK). Verified live, both directions.
    // Left unasserted for the same reason F8 is: pinning the 200 would freeze
    // a live bug as this suite's expected value, and asserting the 400 it
    // ought to give would red the branch for a defect this test-only wave did
    // not create. When it is fixed, its case belongs on this line.

    // The POSITIVE pair, without which a guard that refused EVERY cutoff body
    // would satisfy both assertions above. Explicit nulls on both halves is a
    // real edit an organiser makes (clearing a cutoff back to 1 January), and
    // `(month != null) !== (day != null)` is false for it, so it must pass.
    const bothNull = await patchDivision(request, div.id, {
      age_cutoff_month: null,
      age_cutoff_day: null,
    });
    expect(bothNull.status, `both null: ${JSON.stringify(bothNull.error)}`).toBeLessThan(300);

    const bothSet = await patchDivision(request, div.id, {
      age_cutoff_month: 6,
      age_cutoff_day: 15,
    });
    expect(bothSet.status, `both set: ${JSON.stringify(bothSet.error)}`).toBeLessThan(300);

    const stored = await readDivision(request, div.id);
    expect(stored.age_cutoff_month).toBe(6);
    expect(stored.age_cutoff_day).toBe(15);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("cutoff month and day are held to the schema's own 1-12 / 1-31 ranges", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id, { name: `W7 bounds cutoff-range ${TAG()}` });
  try {
    // These fail the FIELD bounds (`z.number().int().min(1).max(12)` /
    // `.min(1).max(31)`, PatchDivision), so zod never reaches the
    // `superRefine` that produces the two AGE_CUTOFF_* messages: a failing
    // field check aborts the object's refinements.
    //
    // Both the field and the ISSUE CODE are pinned, and the code is what
    // makes these rows say anything at all. `isValidCutoffDay` independently
    // rejects every value here — `DAYS_IN_MONTH[-1]` and `[12]` are
    // `undefined`, and `day >= 1 && day <= max` covers 0 and 32 — so a bounds
    // check asserting only "400 naming this field" is satisfied by the
    // BACKSTOP and cannot witness the bound under test being widened. Proven,
    // not assumed: widening `age_cutoff_day` to `.min(0).max(32)` leaves a
    // path-only assertion green (the refusal simply arrives as `custom` from
    // `checkAgeCutoff` instead), and reds only once the code is asserted.
    const cases: readonly (readonly [Record<string, unknown>, string, string, string])[] = [
      [{ age_cutoff_month: 0, age_cutoff_day: 1 }, "age_cutoff_month", "too_small", "month 0"],
      [{ age_cutoff_month: 13, age_cutoff_day: 1 }, "age_cutoff_month", "too_big", "month 13"],
      [{ age_cutoff_month: 1, age_cutoff_day: 0 }, "age_cutoff_day", "too_small", "day 0"],
      [{ age_cutoff_month: 1, age_cutoff_day: 32 }, "age_cutoff_day", "too_big", "day 32"],
    ];
    for (const [body, field, code, note] of cases) {
      const res = await patchDivision(request, div.id, body);
      expect(res.status, `${note}: ${JSON.stringify(res.error)}`).toBe(400);
      expect(res.error?.code, note).toBe("VALIDATION");
      expect(
        issuesOf(res).map((i) => `${i.path.join(".")}:${i.code}`),
        `${note}: the refusal must be the FIELD BOUND on ${field}, not the day-per-month backstop — got ${JSON.stringify(issuesOf(res))}`,
      ).toContain(`${field}:${code}`);
    }

    // The edges themselves are reachable — 1/1 and 12/31.
    const low = await patchDivision(request, div.id, { age_cutoff_month: 1, age_cutoff_day: 1 });
    expect(low.status, `1 January: ${JSON.stringify(low.error)}`).toBeLessThan(300);
    const high = await patchDivision(request, div.id, { age_cutoff_month: 12, age_cutoff_day: 31 });
    expect(high.status, `31 December: ${JSON.stringify(high.error)}`).toBeLessThan(300);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("a cutoff with no age band is accepted and stored on its own", async ({ request }) => {
  const div = await seedDivision(request, comp.id, { name: `W7 bounds cutoff-no-band ${TAG()}` });
  try {
    const res = await patchDivision(request, div.id, {
      age_cutoff_month: 9,
      age_cutoff_day: 1,
    });
    expect(res.status, `cutoff with no band: ${JSON.stringify(res.error)}`).toBeLessThan(300);

    const read = await readDivision(request, div.id);
    // The band really is absent — this is the state under test, not an
    // assumption about what `seedDivision` leaves behind.
    expect(read.age_min, "a seeded division must carry no age band").toBeNull();
    expect(read.age_max, "a seeded division must carry no age band").toBeNull();
    expect(read.age_cutoff_month).toBe(9);
    expect(read.age_cutoff_day).toBe(1);

    // What this test does NOT claim: that `ageBandEligibilityIssues`
    // (`@/lib/registration-rules`) reports nothing for such a division. That
    // predicate is not reachable from any read this API-only file performs —
    // it runs inside the organiser-side roster gates
    // (`usecases/registration-eligibility.ts`), which need a person with a
    // `dob` on a roster, and calling the pure function here against a
    // hand-built person would be a fixture on both ends proving only the
    // fixture. Its behaviour for this state is covered where it belongs, by
    // `lib/__tests__/registration-rules.test.ts`.
  } finally {
    await releaseDivision(request, div.id);
  }
});

// ---------------------------------------------------------------------------
// The card-fee minimum, proved on the server
// ---------------------------------------------------------------------------

test("card entry fees are gated on Connect first, then held to the 1.00 minimum server-side", async ({
  request,
}) => {
  const div = await seedDivision(request, comp.id, { name: `W7 bounds card-fee ${TAG()}` });
  try {
    // ORDER, witnessed rather than read: with no Connect account attached, a
    // perfectly VALID card fee is still refused — and refused with the
    // CONNECT sentence. That is what proves the fee-minimum check below sits
    // behind this gate, and that a fresh org could not have reached it. A
    // valid fee is load-bearing here: a below-minimum one would be refused in
    // either ordering and the assertion would witness nothing.
    const beforeConnect = await putRegistrationSettings(request, div.id, cardSettingsBody(5_000));
    expect(
      beforeConnect.status,
      `card payments with no Connect account: ${JSON.stringify(beforeConnect.error)}`,
    ).toBe(422);
    expect(beforeConnect.error?.message).toBe(CONNECT_REQUIRED);

    // SQL flip, not real Stripe: Express onboarding cannot run in e2e, this
    // file never mints a charge, and the programme reserves the real Stripe
    // sandbox for money-COMPLETION legs rather than a validation-order check.
    // The fabricated `acct_e2e_…` id is never dialled; `afterAll` detaches it.
    await setOrgConnectSql(org.orgId, true);

    // Now the fee minimum is reachable. This is a direct PUT — the panel's
    // own `validateConfigState` never ran, which is exactly what makes this
    // test able to say the SERVER refuses rather than that the client does.
    for (const feeCents of [1, 50, 99]) {
      const refused = await putRegistrationSettings(request, div.id, cardSettingsBody(feeCents));
      expect(
        refused.status,
        `fee_cents=${feeCents}: ${JSON.stringify(refused.error)}`,
      ).toBe(422);
      // Exact, never a prefix — see CARD_FEE_MINIMUM's own note.
      expect(refused.error?.message, `fee_cents=${feeCents}`).toBe(CARD_FEE_MINIMUM);
    }

    // Nothing refused above reached the row: a division that never had a
    // `registration_settings` row still has none, so the GET answers from
    // DEFAULT_SETTINGS.
    const unwritten = await apiJson<{ fee_cents: number; payment_method: string }>(
      request,
      `/api/v1/divisions/${div.id}/registration-settings`,
      "GET",
    );
    expect(unwritten.status).toBe(200);
    expect(unwritten.data?.payment_method, "no refused card setting may have been stored").toBe(
      "offline",
    );

    // Both accepted edges. 100 is the boundary the guard names; 0 is the
    // other half of its own sentence ("or 0 for free") and is the row that
    // fails if the guard is ever widened to `fee_cents < 100`, which would
    // refuse a legal free card division.
    const atMinimum = await putRegistrationSettings(request, div.id, cardSettingsBody(100));
    expect(
      atMinimum.status,
      `fee_cents=100: ${JSON.stringify(atMinimum.error)}`,
    ).toBeLessThan(300);

    const free = await putRegistrationSettings(request, div.id, cardSettingsBody(0));
    expect(free.status, `fee_cents=0: ${JSON.stringify(free.error)}`).toBeLessThan(300);

    const stored = await apiJson<{ fee_cents: number; payment_method: string }>(
      request,
      `/api/v1/divisions/${div.id}/registration-settings`,
      "GET",
    );
    expect(stored.data?.payment_method, "the accepted card setting must have landed").toBe(
      "stripe",
    );
    expect(stored.data?.fee_cents).toBe(0);
  } finally {
    await releaseDivision(request, div.id);
  }
});

/** A short per-division suffix so a leaked row is attributable to this file
 *  rather than to `seedDivision`'s generic default name. */
function TAG(): string {
  return Math.random().toString(36).slice(2, 6);
}
