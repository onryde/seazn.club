import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, userRowSql, type UserRowSnapshot } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";

/**
 * Specs that WRITE a user row — profile, language, timezone, address, staff
 * bit — run on an account of their own, never on the shared `AUTH_STATE` user.
 *
 * Every spec in a leg is signed in as that one user, and the legs run
 * `fullyParallel` at several workers. `resolveLocale` (src/lib/resolve-locale.ts)
 * reads `users.locale` on every server render, so a spec that saved the shared
 * user's language rendered every OTHER worker's next page in French until its
 * restore ran. A restore protects the next spec, never a concurrent one. CI runs
 * 35975872571 and 36001930259: settings-schedule-drive reloaded into "Heure"
 * where it looked for "Time", and settings-sponsor-monetize read "Aucune
 * commande" where it looked for "No orders yet".
 *
 * Outside `e2e/walkthrough/` on purpose: that project loads every `.ts` there
 * as a spec (settings-support.ts explains).
 */

/**
 * `ownPage`: a page in a context of its own with EMPTY storage. The storage has
 * to be empty explicitly, because a bare `browser.newContext()` inherits the
 * project's storageState and would be the shared user again.
 *
 * A fixture rather than `test.use({ storageState })` on a describe: that option
 * also reaches a file's root `beforeAll`/`afterAll` whenever the first or last
 * test a worker runs sits in the describe (a `-g`, or the fresh worker after a
 * red), and a bare `newContext()` there then asks `/api/users/me` as nobody.
 * Test-scoped, so a test's `beforeEach`/`afterEach` get the same page.
 *
 * Playwright's `use` callback is named `provide` here: react-hooks lints any
 * call named `use` as React's hook.
 */
export const ownTest = test.extend<{ ownPage: Page }>({
  ownPage: async ({ browser }, provide) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      await provide(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  },
});

/**
 * The user a request context is signed in as. Pass the `AUTH_STATE`-carrying
 * `request` fixture to name the shared user. Ask the app rather than rebuilding
 * an address from TAG: TAG is per PROCESS, so a worker's own `proEmail()` names
 * an account `auth.setup.ts` never created.
 */
export async function signedInUserId(request: APIRequestContext): Promise<string> {
  const me = await apiJson<{ id: string }>(request, "/api/users/me");
  expect(me.data?.id, `GET /api/users/me carried no id (HTTP ${me.status})`).toBeTruthy();
  return me.data!.id;
}

export interface OwnAccount {
  userId: string;
  /** The org `freshOrg` created for it, active in `page`'s context. */
  orgId: string;
}

/**
 * Sign `page` in as a brand-new account that owns a fresh org, which is what
 * the settings pages need, and prove the account is not `sharedUserId`.
 */
export async function signInOwnAccount(
  page: Page,
  label: string,
  sharedUserId: string,
): Promise<OwnAccount> {
  const { orgId } = await freshOrg(page, label);
  // freshOrg leaves the page on the app origin, where the consent keys are
  // writable, and an empty storageState carries neither (directory-kit.ts).
  await dismissConsent(page);
  const userId = await signedInUserId(page.request);
  expect(userId, "the fresh account must not be the shared AUTH_STATE user").not.toBe(
    sharedUserId,
  );
  return { userId, orgId };
}

/** The named columns of a user's row, for an "untouched" comparison. */
export async function userColumns<K extends keyof UserRowSnapshot>(
  userId: string,
  columns: readonly K[],
): Promise<Pick<UserRowSnapshot, K>> {
  const row = await userRowSql(userId);
  const picked = {} as Pick<UserRowSnapshot, K>;
  for (const c of columns) picked[c] = row[c];
  return picked;
}
