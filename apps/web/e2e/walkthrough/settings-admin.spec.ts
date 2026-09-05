import { test, expect, type APIRequestContext } from "@playwright/test";
import { activeOrg, apiJson, platformFeePercentSql, setOwnerStaffRoleSql } from "../helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Banner copy read from the dictionary the page renders from, not retyped
 *  here — a test carrying its own copy of a string asserts yesterday's wording
 *  and goes red on a rewrite that broke nothing (this folder's idiom:
 *  division-delete.spec.ts:19, board-v3.spec.ts:280). */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/**
 * W1 of the settings walkthrough programme. Complements nothing — this
 * surface had no e2e coverage of any kind.
 *
 * The platform fee default is a single GLOBAL row (`platform_settings`), not
 * an org-scoped value, so the programme's one-org-per-test isolation rule
 * cannot apply here: two tests in this file must never be in flight at once.
 *
 * `mode: "default"` is what buys that, and it is NOT the ambient behaviour —
 * playwright.config.ts sets `fullyParallel: true`, which this project inherits
 * and CI runs with `--workers=3`, so without this line Playwright would spread
 * this file's tests across workers and let them fight over that one row.
 * `default` rather than `serial` deliberately: serial also SKIPS every test
 * after the first red, and each test here restores its state in its own
 * `finally`, so the cascade protection buys nothing and would only hide the
 * second failure behind the first.
 *
 * WHAT THAT LINE DOES NOT BUY: it orders tests WITHIN THIS FILE ONLY. At
 * `--workers=3` two OTHER walkthrough specs run alongside this one, and both
 * the fee row and the shared Pro user are global to the leg — so a spec here
 * that leaves a borrowed `staff_role` behind breaks a stranger's spec, not its
 * own. That is why every grant below lives inside a `try` whose `finally`
 * clears it unconditionally, and why nothing that can throw sits between a
 * grant and that `try`.
 */
test.describe.configure({ mode: "default" });

interface FeeBody {
  platform_fee_percent: number;
}

/**
 * Raw read of the global default. Asserts NOTHING, so it is safe to call from
 * a `finally` — an assertion there would replace the test's real failure with
 * its own and hide what actually broke.
 */
async function peekFee(request: APIRequestContext): Promise<{ status: number; value?: number }> {
  const res = await apiJson<FeeBody>(request, "/api/admin/settings");
  return { status: res.status, value: res.data?.platform_fee_percent };
}

/** Read the current global default as superadmin. Asserts the 200 AND that a
 *  number actually came back, so call it from the test BODY only — never from a
 *  `finally`.
 *
 *  The definedness assertion is not belt-and-braces, it is the money guard.
 *  `apiJson` swallows a body-parse failure (`helpers.ts`:
 *  `.catch(() => ({ ok: false }))`) and hands back `data: undefined`, so a 200
 *  carrying a malformed or envelope-less body yields `undefined` rather than
 *  throwing. Without this line `original` goes undefined, the closing
 *  "the refused write must not have landed" degrades to
 *  `expect(undefined).toBe(undefined)`, and the one assertion this test exists
 *  for passes vacuously. `value!` is erased at runtime and saves nothing.
 *  Verified: with the read forced to a 200 that carries no
 *  `platform_fee_percent`, the suite was GREEN without this assertion and RED
 *  with it. */
async function readFee(request: APIRequestContext): Promise<number> {
  const { status, value } = await peekFee(request);
  expect(status, "GET /api/admin/settings as superadmin").toBe(200);
  expect(value, "GET /api/admin/settings must carry platform_fee_percent").toBeDefined();
  return value!;
}

test.describe("admin platform settings", () => {
  /**
   * Timeout-independent cleanup, and the reason it exists is not theoretical.
   *
   * VERIFIED on Playwright 1.61.1: when a test TIMES OUT, Playwright does not
   * unwind the test function, so NEITHER `finally` below runs — a probe that
   * timed out while the grant was held left the shared Pro user
   * `is_staff=t, staff_role=superadmin` in the database. `afterEach` DOES run,
   * and its awaits complete. So the try/finally is the ordinary-failure path
   * (it also has to restore superadmin mid-test to re-read the fee), and this
   * hook is the backstop for the one failure mode a `finally` cannot cover.
   *
   * It carries the GLOBAL FEE ROW as well as the borrowed role, and for the same
   * reason: `platform_settings` is one row shared by the whole leg, T4 writes
   * it, and a timeout mid-write would leave the platform's default cut changed
   * for every run that follows. The `finally` in a fee-writing test cannot be
   * the protection — on a timeout it never starts.
   *
   * Every test in this block inherits both — which is the point, because T3-T5
   * append here. Set `borrowedOrgId` BEFORE the first grant, never after.
   */
  let borrowedOrgId: string | null = null;
  let originalFeePercent: number | null = null;

  test.beforeEach(async () => {
    borrowedOrgId = null;
    /**
     * Captured BEFORE any test in this block can write it, and read by SQL
     * rather than through `GET /api/admin/settings` — the route is
     * superadmin-only, and at this point no privilege has been borrowed yet.
     * `null` means the row is absent, in which case there is nothing to restore
     * and writing one would be a new setting rather than a restore.
     */
    originalFeePercent = await platformFeePercentSql();
  });

  test.afterEach(async ({ page }) => {
    const orgId = borrowedOrgId;
    const fee = originalFeePercent;
    borrowedOrgId = null;
    originalFeePercent = null;
    // Gated on the BORROW, not on whether the test thinks it wrote: the fee can
    // only be written by a superadmin, superadmin can only come from a grant,
    // and a grant that did not arm `borrowedOrgId` first has already leaked the
    // louder of the two things. It is also the only org id this hook has, and
    // it needs one to borrow the privilege the restore itself requires.
    if (!orgId) return;
    try {
      if (fee !== null) {
        /**
         * Through the ROUTE, never raw SQL. `platformFeeDefault()` is
         * cache-aside on a 300s Redis entry and `setPlatformFeeDefault` is the
         * only writer that invalidates it, so an UPDATE here would put the row
         * back and leave the stale value serving every later reader for five
         * minutes — a restore that reads as clean in psql and is not one.
         *
         * Unconditional: no read-then-compare, because a failing compare would
         * fail OPEN and skip the restore, and the write is idempotent anyway.
         */
        await setOwnerStaffRoleSql(orgId, "superadmin");
        const res = await apiJson(page.request, "/api/admin/settings", "PUT", {
          platform_fee_percent: fee,
        });
        // Reported, never ASSERTED. An expect() in a hook replaces the test's
        // real failure with its own, which is the trap the peekFee/readFee split
        // above exists to avoid; a warning says what happened without hiding
        // what broke.
        if (res.status !== 200) {
          console.warn(
            `[settings-admin] fee restore to ${fee}% did not land (HTTP ${res.status})`,
          );
        }
      }
    } finally {
      await setOwnerStaffRoleSql(orgId, null);
    }
  });

  test("a support-role staff member gets no live Save, and the route refuses the write", async ({
    page,
  }) => {
    const org = await activeOrg(page);

    let original: number | undefined;
    let after: { status: number; value?: number } | undefined;

    // The FIRST grant is already inside this try. Nothing that can throw may
    // sit between a grant and the `finally` that clears it: the org owner is
    // the SHARED Pro user, and a leaked `superadmin` does not fail here — it
    // fails in some other spec in the leg, whose diff explains nothing.
    try {
      // Arm the afterEach backstop BEFORE the grant exists to leak.
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      original = await readFee(page.request);

      await setOwnerStaffRoleSql(org.id, "support");
      await page.goto("/admin/settings");

      // LOAD-BEARING, and not decoration for the 401 below. `setOwnerStaffRoleSql`
      // has no zero-rows guard: if its UPDATE matched nothing the user is simply
      // NOT STAFF, and a non-staff caller is refused the write too — so the
      // refusal on its own would pass vacuously. /admin/layout.tsx redirects a
      // non-staff caller away, so this heading is the proof that requireStaff()
      // actually passed FOR THIS USER before we assert what requireSuperadmin()
      // denies them.
      await expect(
        page.getByRole("heading", { name: "Platform settings" }),
        "requireStaff() must have passed — a zero-row role update would redirect instead",
      ).toBeVisible();

      const save = page.getByRole("button", { name: "Save" });
      await expect(save).toBeAttached();
      await expect(save, "support staff must not be offered a Save that cannot work").toBeDisabled();

      // The other half of the same proof: this note renders only when the page
      // resolved the caller as NOT superadmin. Heading + note together pin the
      // role at staff-but-not-superadmin, which is the only state this test is
      // about.
      await expect(
        page.getByText("Superadmin only."),
        "the form must say why the Save is dead",
      ).toBeVisible();

      // The guard is only real if the route refuses it too.
      const write = await apiJson(page.request, "/api/admin/settings", "PUT", {
        platform_fee_percent: 9,
      });
      expect(write.status, "PUT as support staff").toBe(401);
    } finally {
      // Borrow superadmin back just long enough to read the fee, then clear the
      // privilege NO MATTER WHAT. The inner finally holds only the restore, so
      // a failing read can never skip it.
      try {
        await setOwnerStaffRoleSql(org.id, "superadmin");
        after = await peekFee(page.request);
      } finally {
        await setOwnerStaffRoleSql(org.id, null);
      }
    }

    // Deliberately OUTSIDE every `finally`. A throw above never reaches here,
    // so these assertions can only ever report their own failure — they can
    // never overwrite the real one with a confusing "the fee moved" message.
    expect(after?.status, "GET /api/admin/settings after restoring superadmin").toBe(200);
    expect(after?.value, "the refused write must not have landed").toBe(original);
  });

  /**
   * F2. `Number("")` is `0`, so clearing the input left `valid` true, the Save
   * button live, and the PUT body carrying `platform_fee_percent: 0` — the
   * platform's entire cut on entry fees, zeroed by a clear and a click.
   *
   * THE GUARD HAS TO BE CLIENT-SIDE, and that is not a shortcut. `0` is a
   * legitimate fee (the route's `z.number().min(0)` accepts it, and T4's bounds
   * table pins that 200), so the server cannot tell "the admin meant zero" from
   * "the admin cleared the box". Only the form knows the field was EMPTY.
   */
  test("clearing the fee field cannot silently save 0%", async ({ page }) => {
    const org = await activeOrg(page);

    // The grant lives INSIDE the try (nothing that can throw may sit between a
    // grant and the finally that clears it), and `borrowedOrgId` is armed
    // BEFORE the grant exists to leak, or the afterEach backstop is a no-op.
    try {
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      const original = await readFee(page.request);

      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");
      const save = page.getByRole("button", { name: "Save" });

      // Pin what the control OPENS AT, derived from the route's own answer
      // rather than a constant typed into this test.
      await expect(input).toHaveValue(String(original));

      // The differential's first half, and it is load-bearing rather than
      // decoration: `disabled={!canWrite || busy || !valid}` has three inputs,
      // so a bare toBeDisabled() below would also pass for a caller who is not
      // superadmin at all. Enabled here pins `canWrite` true and `busy` false,
      // which leaves `valid` as the ONLY thing the clear can change.
      await expect(save, "a superadmin over a valid value must have a live Save").toBeEnabled();

      await input.fill("");
      await expect(input, "the clear must actually have emptied the field").toHaveValue("");
      await expect(
        save,
        "an empty field must not be a submittable 0%",
      ).toBeDisabled();
      // Each dead-Save case pins its OWN message. `0–100 only` here would be
      // the form giving the wrong reason — the box is not out of range, it is
      // EMPTY — and asserting it would freeze that wrong copy as expected
      // behaviour. Both halves are load-bearing: a component that renders both
      // notes at once, or one note carrying both sentences, passes the
      // visible-assertion alone and is caught only by the hidden one.
      await expect(
        page.getByText("Enter a percentage"),
        "an empty field must say the field is EMPTY, which is why the Save is dead",
      ).toBeVisible();
      await expect(
        page.getByText("0–100 only"),
        "emptiness is not a RANGE problem — the range note must not be the reason given",
      ).toBeHidden();

      // And if it were submitted anyway, the stored value must be untouched.
      expect(
        await readFee(page.request),
        "clearing the field must not have written anything",
      ).toBe(original);
    } finally {
      await setOwnerStaffRoleSql(org.id, null);
    }
  });

  /**
   * The drive: what the control OPENS AT, a real save made through the UI, and
   * the value read back — then the bounds, on BOTH sides of the seam. The
   * form's own `valid` predicate and the route's zod schema are separate
   * guards and neither implies the other, so each is enumerated against the
   * side that owns it.
   *
   * `step={0.5}` on the input is enforced by NOTHING: the client tests
   * `parsed >= 0 && parsed <= 100`, and the route's schema is
   * `z.number().min(0).max(100)` with no `multipleOf`. So 2.7 is accepted end
   * to end, and the table pins what the product DOES rather than what the
   * attribute implies.
   *
   * The refusals are 400, not 422. `setPlatformFeeDefault` does throw
   * `HttpError(422)` out of bounds, but `putSchema.parse` runs first and
   * `handler()` maps a ZodError to 400 (`lib/http.ts`), so 422 is unreachable
   * through this route and asserting it would be asserting a dead branch.
   */
  test("a superadmin can change the fee, and the bounds hold on both sides", async ({ page }) => {
    const org = await activeOrg(page);

    // Hoisted so the closing assertions can live OUTSIDE every `finally`.
    let original: number | undefined;
    let restored: { status: number; value?: number } | undefined;

    try {
      // Arm the afterEach backstop BEFORE the grant exists to leak — and this
      // is the test that hook was built for: it is the only one here that
      // WRITES the global fee row, and on a TIMEOUT the `finally` below never
      // starts, so without this line the platform's default cut would stay
      // wherever this test left it for every run that follows.
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      original = await readFee(page.request);
      // A target that differs from every wrong answer's constant: not the
      // current value, not 0 (F2's failure mode), not 5 (the env fallback).
      const target = original === 7.5 ? 8.5 : 7.5;

      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");
      const save = page.getByRole("button", { name: "Save" });

      // What the control opens at, derived from the route's own answer rather
      // than a constant typed here — a reachability check would pass on any
      // value, including a stale one.
      await expect(input, "the form must open at the stored default").toHaveValue(String(original));

      await input.fill(String(target));
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/admin/settings") && r.request().method() === "PUT",
        ),
        save.click(),
      ]);
      await expect(page.getByText("Saved."), "the form must confirm the write").toBeVisible();

      // Persisted, and served back on the next load — the page is
      // `force-dynamic` and `setPlatformFeeDefault` drops the 300s cache entry,
      // so a reload is a genuine re-read rather than a repaint of local state.
      expect(await readFee(page.request), "the save must have landed").toBe(target);
      await page.reload();
      await expect(input, "the reloaded page must open at the saved value").toHaveValue(
        String(target),
      );

      // The CLIENT half of the bounds, enumerated over the SAME four values as
      // the route table below, because `valid` and the zod schema are separate
      // guards and a green route says nothing about the form.
      //
      // The order is the substance, not the reading order. Each ENABLED
      // assertion is preceded by a DISABLED one on the same button, so neither
      // can pass on the state it was already in — that is what makes them kill
      // mutants rather than observe a constant:
      //
      //   101 dark → 100 live   kills `parsed <= 100` → `parsed < 100`
      //    -1 dark →   0 live   kills `parsed >=  0` → `parsed >  0`
      //
      // Both closed ends need driving here and nowhere else. T3 proved only
      // that an EMPTY box kills the Save, which a `parsed > 0` predicate
      // satisfies too while making a deliberate 0% unsubmittable; and the route
      // accepting 100 says nothing about a form that has already refused to
      // offer the button.
      await input.fill("101");
      await expect(save, "over the ceiling the form must kill the Save").toBeDisabled();
      await expect(page.getByText("0–100 only"), "and say why").toBeVisible();
      // The mirror of T3's pair. 101 is PRESENT and out of range, so the
      // emptiness note would be the wrong reason here — without this the two
      // messages could collapse back into one and both tests would still pass.
      await expect(
        page.getByText("Enter a percentage"),
        "101 is present, not missing — the emptiness note must not be the reason given",
      ).toBeHidden();
      await input.fill("100");
      await expect(save, "100% is the ceiling ITSELF — the form must offer a Save").toBeEnabled();
      await input.fill("-1");
      await expect(save, "below the floor the form must kill the Save").toBeDisabled();
      await input.fill("0");
      await expect(save, "0% is a legal fee — the form must still offer a Save").toBeEnabled();
      await expect(
        page.getByText("0–100 only"),
        "0 is in range, so the form must not claim otherwise",
      ).toBeHidden();
      await expect(
        page.getByText("Enter a percentage"),
        "a deliberate 0 is not an empty box — the form must not ask for a value",
      ).toBeHidden();

      // The ROUTE half, enumerated rather than sampled. Nothing is clicked
      // here: the form cannot express -1 or 101 as a submitted value (the
      // guard just proved that), so the only way to ask the route what it
      // does with them is to ask it directly.
      const cases: { value: number; status: number; why: string }[] = [
        { value: -1, status: 400, why: "below the floor" },
        { value: 0, status: 200, why: "the floor itself is legal" },
        { value: 2.7, status: 200, why: "step=0.5 is enforced by nothing" },
        { value: 100, status: 200, why: "the ceiling itself is legal" },
        { value: 101, status: 400, why: "above the ceiling" },
      ];
      for (const c of cases) {
        const res = await apiJson<FeeBody>(page.request, "/api/admin/settings", "PUT", {
          platform_fee_percent: c.value,
        });
        expect(res.status, `PUT ${c.value} — ${c.why}`).toBe(c.status);
        // A 200 is satisfied by ANY stored value, so an accepted row has to say
        // what it stored. This is a genuine read-back, not an echo of the
        // input: the route returns `await platformFeeDefault()` evaluated AFTER
        // `setPlatformFeeDefault` dropped the cache entry (route.ts:27,
        // platform-settings.ts:64), so a silent round to 3 shows up here.
        //
        // Its LIMIT, stated so nobody over-reads it: that reader is
        // `decodeFeePercent(row?.value) ?? envFallback()` (platform-settings.ts,
        // `platformFeeDefault`). It WAS `Number(value)` plus a 0–100 clamp at
        // :48-49 until the follow-up wave replaced those two lines, so the
        // read-back is now type-gated as well as bounded — a pin at the old
        // line numbers now lands on the comment explaining the change. So
        // this pins what every CONSUMER of the fee gets, which is the thing
        // that matters — not the literal jsonb bytes in the column.
        if (c.status === 200) {
          expect(
            res.data?.platform_fee_percent,
            `PUT ${c.value} — accepted, so it must have stored ${c.value}`,
          ).toBe(c.value);
        }
      }

      // The refused rows pin the STATUS only, and every refused write here is
      // masked from view: `-1` by the next row's write, and `101` by the
      // restore in the `finally`. So a route that answered 400 and WROTE
      // ANYWAY would be unobservable — the refusal rows cannot witness the
      // regression they exist for. One read closes it, and the two assertions
      // above it keep that read honest if the table is ever reordered: the
      // last row must still be a refusal, or a standing value proves nothing.
      const lastRow = cases[cases.length - 1]!;
      const lastAccepted = [...cases].reverse().find((c) => c.status === 200)!;
      expect(lastRow.status, "the table must END on a refusal for the read below to bite").toBe(400);
      expect(
        await readFee(page.request),
        `the refused ${lastRow.value} must not have landed over the accepted ${lastAccepted.value}`,
      ).toBe(lastAccepted.value);
    } finally {
      // Cleanup UNCONDITIONAL, and ordered so the fee restore can never skip
      // the role clear: the inner `finally` holds only the clear, so a restore
      // that throws still drops the borrowed `superadmin` off the shared Pro
      // user. Nothing here asserts, for the same reason `peekFee` exists — an
      // expect() in this block would replace the test's real failure with its
      // own.
      //
      // Through the ROUTE, never raw SQL: `platformFeeDefault()` is cache-aside
      // on a 300s entry that only `setPlatformFeeDefault` invalidates, so an
      // UPDATE would put the row back and leave the stale value serving every
      // later reader. The role is still `superadmin` here — this test never
      // demotes — so the PUT is authorised without re-granting.
      //
      // `original === undefined` means `readFee` never returned, which means
      // nothing above it ever wrote: there is nothing to restore, and PUTting
      // `undefined` would only add a 400 to the log.
      try {
        if (original !== undefined) {
          await apiJson(page.request, "/api/admin/settings", "PUT", {
            platform_fee_percent: original,
          });
        }
        restored = await peekFee(page.request);
      } finally {
        await setOwnerStaffRoleSql(org.id, null);
      }
    }

    // Deliberately OUTSIDE every `finally`. A throw above never reaches here,
    // so these can only ever report their own failure — never overwrite the
    // real one with a confusing "the fee moved".
    expect(restored?.status, "GET /api/admin/settings after the restore").toBe(200);
    expect(restored?.value, "the fee must be back where this test found it").toBe(original);
  });
});

/**
 * The four legacy `/settings/*` routes, register case 24. Every one is a
 * `redirect()` shim into the org-scoped tree, and three of them carry a query
 * string a payment round-trip depends on: `?checkout=success&session_id=…` is
 * what `/o/[orgSlug]/settings/billing` calls `reconcileCheckout` from (page.tsx
 * :91), and `?connect=return|refresh` is where Stripe drops an organiser coming
 * back out of Connect onboarding. A shim that forwards the path and eats the
 * query answers HTTP 200 on a page that has silently lost the thing it was
 * opened for — which is why the pathname alone is not the assertion.
 *
 * A SIBLING describe, and it therefore inherits NO cleanup hook: the
 * `beforeEach`/`afterEach` above are scoped to `admin platform settings`. That
 * is safe here only because these tests borrow no privilege and write no global
 * row — they navigate as the ordinary shared Pro user and nothing else.
 * Anything added to this block that grants a `staff_role` or writes
 * `platform_settings` must carry its own `afterEach`; the neighbour's will not
 * run for it.
 */
test.describe("legacy settings redirects", () => {
  /**
   * PATHNAME AND SEARCH, per hop, compared as one string.
   *
   * Each half covers the other's blind spot. The pathname alone is satisfied by
   * a shim that forwarded and dropped the query — the regression this test
   * exists for. The search alone is satisfied by a redirect that never happened,
   * since `/settings?tab=preferences` carries the same `?tab=preferences` it was
   * asked for. Only the pair pins "it moved, and it took the query with it".
   *
   * The no-query hop is not filler. `routes.orgSettings` omits the query
   * ENTIRELY when `tab` is undefined (`tab ? "?tab=" + tab : no query`,
   * lib/routes.ts:12-13); the mutant is a builder that always appends, landing a
   * bare `/settings` on `?tab=undefined` — the literal string "undefined",
   * which `SETTINGS_TABS.includes()` then silently falls back off.
   *
   * AND THE STATUS, because the address bar is not the page. `page.goto`
   * follows the redirect chain and returns the FINAL landing's response — not
   * the opening 307, which is a distinction this test's own probe row had to
   * demonstrate rather than assume, since a 307 is also `< 400` and would make
   * the whole assertion decorative. A landing that 500s keeps exactly the URL
   * asserted above, so the URL pair alone stays green on the precise case hop 3
   * exists for, "the Stripe params arrive and the page reconciles them". The
   * blast radius is nil today only because `reconcileCheckout` never throws;
   * this holds the contract rather than today's implementation of it.
   *
   * RESIDUE, stated rather than glossed: a status covers the SERVER-error half
   * only. An `error.tsx` boundary that trips after hydration still returns 200,
   * so a landed page that dies in the client would pass this check. Closing
   * that needs a landmark assertion per hop — three different pages, three more
   * selectors to keep true — and it is deliberately not claimed here.
   *
   * `toBeLessThan(400)` on a captured response is this folder's existing idiom
   * (`rs007-registration-journey.spec.ts`:169, `rs010-registration-cross-flow`
   * :287) — a branded 404 still 404s, so assert the status, never the prose.
   * The `?.` cannot make it vacuous: `page.goto` returns null only for a
   * same-document navigation, none of these are, and `expect(undefined)
   * .toBeLessThan(400)` THROWS rather than passing — verified directly against
   * @playwright/test rather than assumed.
   *
   * `session_id=cs_test_x` is a session Stripe has never heard of, on purpose:
   * `reconcileCheckout` is one big try/catch that logs and returns false
   * (billing.ts:1506), so the hop proves the params ARRIVE without depending on
   * a live Stripe session existing.
   */
  test("each legacy route lands org-scoped with its query intact", async ({ page }) => {
    // LIMIT, stated rather than engineered around. `activeOrg` resolves
    // `find(seazn_org) ?? orgs[0]` (helpers.ts), which is the SAME rule
    // `requirePageAuth` uses to pick the org every one of these shims redirects
    // INTO (page-auth.ts:40-41). So the expected slug below mirrors the
    // product's own selector: a shim that hardcoded some other org's slug is
    // caught, a wrong org produced by that shared rule is not. Re-implementing
    // the rule here would only assert the test's copy of it against the
    // product's, which is a mirror, not a check.
    const org = await activeOrg(page);

    const hops: { from: string; to: string; why: string }[] = [
      { from: "/settings?tab=preferences", to: `/o/${org.slug}/settings?tab=preferences`,
        why: "?tab= survives" },
      { from: "/settings", to: `/o/${org.slug}/settings`,
        why: "no query, no dangling ?" },
      { from: "/settings/billing?checkout=success&session_id=cs_test_x",
        to: `/o/${org.slug}/settings/billing?checkout=success&session_id=cs_test_x`,
        why: "an in-flight Stripe session reconciles on the new URL" },
      { from: "/settings/connect?connect=return",
        to: `/o/${org.slug}/settings/connect?connect=return`,
        why: "the Connect onboarding round-trip survives" },
      { from: "/settings/payments?connect=refresh",
        to: `/o/${org.slug}/settings/connect?connect=refresh`,
        why: "two hops: /payments → /connect → org-scoped" },
    ];

    for (const hop of hops) {
      const landing = await page.goto(hop.from, { waitUntil: "load" });
      const landed = new URL(page.url());
      expect(`${landed.pathname}${landed.search}`, `${hop.from} — ${hop.why}`).toBe(hop.to);
      expect(
        landing?.status(),
        `${hop.from} reached ${hop.to} but the page returned HTTP ${landing?.status()} — the query arrived at a dead page`,
      ).toBeLessThan(400);
    }
  });

  /**
   * The hop above proves a query SURVIVES. This one proves the surviving value
   * is USED — and it is a separate test because the two failed separately.
   *
   * `/settings` forwarded `tab` alone until this wave (it typed searchParams as
   * `{ tab?: string }` and rebuilt the URL from that one field, while its three
   * siblings forwarded everything). The only other param the destination reads
   * is `email_change`, and `/api/auth/change-email/confirm` redirects ALL FIVE
   * of its outcomes through exactly this shim — success, invalid, expired,
   * taken, error (confirm/route.ts:26-57) — so every email-change confirmation
   * landed on an identical bannerless page. The banner code
   * (o/[orgSlug]/settings/page.tsx:270,564) was live the whole time; nothing
   * reachable ever sent it a value.
   *
   * TWO OUTCOMES, NOT ONE, and asserted against each other. A single row is
   * satisfied by a shim that forwards a CONSTANT `email_change`, and equally by
   * a banner that renders one fixed string regardless of the value — both of
   * which are the same class of defect as the one being fixed. The pair pins
   * that the VALUE arrives: each outcome shows its own copy, and the other
   * outcome's copy is absent from the page.
   *
   * They are also chosen to differ in COLOUR class (`taken` is a red banner,
   * `success` an emerald one, page.tsx:564), so a mutant that hardcoded the
   * error branch cannot pass by luck.
   */
  test("an email-change confirmation keeps its outcome through the shim", async ({ page }) => {
    const org = await activeOrg(page);
    const outcomes = ["taken", "success"] as const;

    for (const outcome of outcomes) {
      const mine = UI_EN[`settings.emailChange.${outcome}`];
      const other = UI_EN[`settings.emailChange.${outcomes.find((o) => o !== outcome)!}`];
      // Guards the guard: a renamed dictionary key would otherwise make both
      // assertions below compare `undefined` against the page and pass.
      expect(mine, "settings.emailChange copy missing from en/ui.json").toBeTruthy();
      expect(other).toBeTruthy();
      expect(mine).not.toBe(other);

      const landing = await page.goto(`/settings?tab=account&email_change=${outcome}`, {
        waitUntil: "load",
      });
      const landed = new URL(page.url());
      expect(`${landed.pathname}${landed.search}`, `email_change=${outcome} must survive the hop`)
        .toBe(`/o/${org.slug}/settings?tab=account&email_change=${outcome}`);
      expect(landing?.status()).toBeLessThan(400);

      await expect(
        page.getByText(mine, { exact: true }),
        `the ${outcome} banner must render — the param arrived but the page ignored it`,
      ).toBeVisible();
      await expect(
        page.getByText(other, { exact: true }),
        `the ${outcome} page is showing the OTHER outcome's banner`,
      ).toHaveCount(0);
    }
  });

  /**
   * THE CASE THE TEST ABOVE CANNOT SEE, and the one that actually happens.
   *
   * `/api/auth/change-email/confirm` needs NO session — it acts on the token
   * alone (confirm/route.ts) — and its link is mailed to the user's NEW
   * address, so it is normally opened in whatever browser the mail client
   * hands it to, with no `seazn` cookie. The test above runs as the shared
   * signed-in Pro org member and is structurally blind to that.
   *
   * Before this wave the address change COMMITTED and then
   * `requirePageAuth()`'s bare `redirect("/login")` (page-auth.ts:37) threw the
   * outcome away — so success, expired and "already in use" were identical
   * blank pages for exactly the users most likely to see them.
   *
   * `storageState: { cookies: [], origins: [] }` is load-bearing and NOT
   * decoration: a bare `browser.newContext()` in this repo inherits the signed-
   * in state from the `setup` project, which would send this test straight down
   * the authenticated path and pass while proving nothing. Asserted below by
   * landing on /login at all — a signed-in context would have been forwarded to
   * the org-scoped page instead, failing the first expect.
   */
  test("an unauthenticated confirmation keeps its outcome across the login hop", async ({
    browser,
  }) => {
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await anon.newPage();
      const landing = await page.goto("/settings?tab=account&email_change=taken", {
        waitUntil: "load",
      });
      expect(landing?.status()).toBeLessThan(400);

      const landed = new URL(page.url());
      expect(landed.pathname, "a signed-out visitor must reach the login page").toBe("/login");

      // The whole point: the destination survived the bounce. `next` is
      // percent-encoded, so decode before comparing rather than asserting on
      // the encoding, which is not the contract.
      const next = landed.searchParams.get("next");
      expect(next, "login was reached but the destination was dropped").toBeTruthy();
      expect(
        next,
        "the email-change outcome did not survive the login hop — the address change committed and the user still cannot be told which outcome it was",
      ).toBe("/settings?tab=account&email_change=taken");
    } finally {
      await anon.close();
    }
  });
});
