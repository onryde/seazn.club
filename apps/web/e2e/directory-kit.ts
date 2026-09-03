import { expect, type Page, type Locator } from "@playwright/test";
import {
  TAG,
  apiJson,
  invalidateOrgEntitlements,
  loginUi,
  setEntitlementOverrideSql,
} from "./helpers";

// Shared kit for the /directory walkthrough specs (e2e/walkthrough/directory-*).
//
// This file lives at `e2e/` and NOT at `e2e/walkthrough/`, deliberately: the
// walkthrough project's testMatch is `/[\\/]e2e[\\/]walkthrough[\\/]/`, which
// matches ANY file in that folder rather than only its specs, so a helper
// dropped there is selected as a spec and Playwright rejects the whole run
// with `test file "X" should not import test file "helpers.ts"`. It also
// carries no `.spec.ts`/`.test.ts` suffix, so Playwright's default testMatch
// (`**/*.@(spec|test).?(c|m)[jt]s?(x)`) leaves it alone in every project.
//
// Its unit test is at `src/__tests__/directory-kit.test.ts`, not beside it:
// vitest.config.ts excludes `e2e/**` outright, and a `*.test.ts` under
// `testDir: "./e2e"` is picked up by the Playwright `parallel` project's
// default testMatch — measured, both of them. See that test's header.
//
// The venue/court locators below are lifted verbatim from
// venues.spec.ts:26-98 (which keeps its own private copies). The ONE
// exception is `uniqueName`, which now delegates to `stamp()` — see its
// docblock for why the duplicated expression had to go.

/** A per-call token, used to make a name or an email unique.
 *
 *  (The sentence that used to be here — "these specs share an org with every
 *  other spec in the leg" — came in with the venues.spec.ts lift and is FALSE
 *  for this kit: `freshOrg` below exists precisely so they do not. It survived
 *  because it was true of the file the helper came from.)
 *
 *  What actually needs the entropy: `TAG` is per-PROCESS (helpers.ts), so it
 *  separates one Playwright WORKER from another but gives every call inside a
 *  worker the same value. And the identifiers this seeds are not all org
 *  scoped — `freshOrg` mints `dir-<label>-<stamp>@example.com`, and an email
 *  is unique across the whole database, not within an org. So the random tail
 *  is what keeps two calls in one process, and two specs in one run, apart.
 *
 *  Eight base36 characters, not four. Four is 36^4 = 1.68M values, which
 *  sounds ample and is not: 200 draws hit a birthday collision 1.235% of the
 *  time (measured, 20k trials), so this function's own "200 calls, 200
 *  distinct values" test reddened about one run in 81 — a spurious red on
 *  somebody's unrelated PR. Eight is 2.8e12; the same 20k trials now collide
 *  zero times, as does a flat 2M-draw sample. The four characters this costs
 *  in a name buy the collision guarantee the paragraph above actually claims;
 *  nothing asserts on a name's length, and `findContainer` matches exact
 *  `inputValue()`, so length is irrelevant to it. Do not trim this back to
 *  make a name prettier.
 *
 *  "Eight" is the ceiling, not a guarantee: `Math.random().toString(36)`
 *  returns a SHORT expansion for an exact binary fraction (0.5 -> "0.i", so
 *  the tail is one character), and 23 of 5,000,000 measured tails came back
 *  under eight, the shortest being six. That is a 4.6e-6 event leaving a
 *  still-ample 2.2e9 space, so it is a footnote rather than a flaw — but the
 *  slice length is an upper bound, and anything that ever needs a
 *  FIXED-WIDTH id must pad rather than assume this returns eight. */
export function stamp(): string {
  return `${TAG}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `stamp()` behind a human-readable label. Delegates rather than repeating
 *  the expression: while the two computed it independently, no test of
 *  `uniqueName` could witness a change to `stamp` — replacing `stamp`'s body
 *  with `return TAG` left the whole suite green, because the only caller that
 *  the unit tests reach was not a caller at all. This is the one line of the
 *  block below that is NOT verbatim from venues.spec.ts. */
export function uniqueName(label: string): string {
  return `${label} ${stamp()}`;
}

/**
 * The first `containerSelector` element (within `root`) that owns a
 * `label`-labelled control whose LIVE value equals `value`, or null.
 *
 * Deliberately built via plain Locator chaining (`.locator(css).nth(i)`)
 * rather than "find the input, then jump to its ancestor via
 * `xpath=ancestor::…`": measured live against this exact page — a Locator
 * reached through an xpath ancestor step resolves fine for an `aria-label`
 * lookup or a role's own text (`getByRole("button", {name:…})`), but a
 * SUBSEQUENT `getByLabel` for a WRAPPING `<label><span>…</span><select>`
 * association (no `aria-label`, no `for`/`id` — e.g. the calendar editor's
 * "Open"/"Close" selects) silently resolves to zero matches even though the
 * element is plainly present in `innerHTML()` — proven with a throwaway
 * `.count()`/`.isVisible()` probe before this fix landed. Scanning
 * CONTAINERS directly and reading each candidate's OWN value avoids the
 * xpath hop entirely, so every later `getByLabel`/`getByRole` on the
 * returned Locator composes normally. Reads `.inputValue()` (never a
 * `[value="…"]` CSS attribute selector) because React never reflects a
 * controlled input's live value onto the DOM attribute, only the property.
 */
export async function findContainer(
  root: Page | Locator,
  containerSelector: string,
  label: string,
  value: string,
): Promise<Locator | null> {
  const containers = root.locator(containerSelector);
  const n = await containers.count();
  for (let i = 0; i < n; i++) {
    const candidate = containers.nth(i);
    const input = candidate.getByLabel(label);
    if ((await input.count()) > 0 && (await input.inputValue()) === value) return candidate;
  }
  return null;
}

export async function findVenueCard(page: Page, venueName: string): Promise<Locator | null> {
  return findContainer(page, "section.card", "Venue name", venueName);
}

export async function findCourtRow(
  page: Page,
  venueName: string,
  courtName: string,
): Promise<Locator | null> {
  const venueCard = await findVenueCard(page, venueName);
  if (!venueCard) return null;
  return findContainer(venueCard, "li", "Court name", courtName);
}

/** Waits (auto-retrying, so a real red is possible) for the venue card to
 *  exist, then returns it. */
export async function waitForVenueCard(page: Page, venueName: string): Promise<Locator> {
  await expect
    .poll(async () => ((await findVenueCard(page, venueName)) ? 1 : 0), { timeout: 15_000 })
    .toBe(1);
  const card = await findVenueCard(page, venueName);
  if (!card) throw new Error(`venue card vanished for "${venueName}"`);
  return card;
}

export async function waitForCourtRow(page: Page, venueName: string, courtName: string): Promise<Locator> {
  await expect
    .poll(async () => ((await findCourtRow(page, venueName, courtName)) ? 1 : 0), { timeout: 15_000 })
    .toBe(1);
  const row = await findCourtRow(page, venueName, courtName);
  if (!row) throw new Error(`court row vanished for "${courtName}" in venue "${venueName}"`);
  return row;
}

/**
 * A signed-in user with an org of its own.
 *
 * Every directory spec needs one. The walkthrough project's storageState is
 * e2e/.auth/pro.json — one PRO org shared with every other spec in the leg —
 * and the Players tab renders only the OLDEST 200 persons (`PlayersTab` in
 * src/app/directory/page.tsx calls `listPersons` with `limit: 200`, and
 * `listPersons` — src/server/usecases/persons.ts — orders by `created_at, id`
 * ASCENDING). Symbols rather than line numbers on purpose: a line pin goes
 * stale across branches, and this one already had. So a person created late in a
 * shared org is not merely hard to count, it is not on the page, and a
 * "no duplicate was suggested" assertion passes for the wrong reason.
 *
 * A fresh org also arrives on the COMMUNITY plan for free: createOrgForUser
 * (lib/auth.ts:303) inserts plan_key 'community' and stamps the new
 * subscription onto the org, so the org is alone in its own billing group and
 * needs no splitOrgIntoOwnGroupSql call.
 *
 * The caller must set `test.use({ storageState: { cookies: [], origins: [] } })`
 * at FILE scope. A bare browser.newContext() inherits the owner session.
 *
 * DO NOT DROP THE `"/"` PASSED TO `loginUi`. It reads as a cosmetic default and
 * is load-bearing: `postAuthLanding` (src/lib/auth.ts) short-circuits on a safe
 * `next` — it resolves the user's orgs, returns that path, and never reaches
 * the auto-provisioning branch below it. Without a `next`, a brand-new user is
 * handed an org called "My organization" on the spot. That org is on the
 * community plan, where `orgs.max_owned` is 1
 * (db/migration/deltas/V112__entitlements_v2.sql:23), so the POST /api/orgs on
 * the next line 402s — on every run, for a reason nothing in this function
 * names. `loginUi`'s own docblock makes the same point ("a spec that skips it
 * quietly turns its player into an organiser").
 */
export async function freshOrg(page: Page, label: string): Promise<{ orgId: string; email: string }> {
  const s = stamp();
  const email = `dir-${label}-${s}@example.com`;
  await loginUi(page, email, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `${label} ${s}`,
  });
  const orgId = created.data?.id;
  if (!orgId) throw new Error(`freshOrg: POST /api/orgs returned no id (status ${created.status})`);
  return { orgId, email };
}

/**
 * The org's CURRENT effective limit for `key`.
 *
 * Never hardcode a limit in a spec: the plan catalog is re-valued independently
 * of this suite. Returns null for unlimited, a number otherwise, and THROWS
 * when the key is absent from the org's plan — getLimit resolves a missing
 * matrix row to 0 and refuses everything, so an absent row must fail loudly
 * here rather than surface as a confusing 402 several steps later.
 *
 * Read through the API, NOT raw SQL. GET /api/orgs/{id}/entitlements resolves
 * every value through lib/entitlements' own getLimit, so it agrees with
 * enforcement by construction. That route used to union overrides in raw SQL
 * itself, and its own header records what that cost: "no expires_at filter, no
 * comped_until degradation and no past_due grace -- and it coalesced int_value,
 * which silently demoted every staff 'unlimited' grant to the plan's number."
 * A hand-rolled query in this kit would reintroduce exactly that drift, and it
 * would drift silently, in the direction of a SMALLER cap.
 */
export async function liveLimit(page: Page, orgId: string, key: string): Promise<number | null> {
  const res = await apiJson<{
    plan_key: string;
    entitlements: Record<string, { limit?: number | null; enabled?: boolean }>;
  }>(page.request, `/api/orgs/${orgId}/entitlements`, "GET");
  const body = res.data;
  if (!body) throw new Error(`liveLimit: GET entitlements failed (status ${res.status})`);
  const row = body.entitlements[key];
  if (row === undefined) {
    throw new Error(
      `liveLimit: plan "${body.plan_key}" has no matrix row for "${key}" -- ` +
        `getLimit would resolve it to 0 and refuse everything`,
    );
  }
  if (!("limit" in row)) throw new Error(`liveLimit: "${key}" is a boolean feature, not a quota`);
  return row.limit ?? null;
}

/**
 * Set a deterministic cap, and DROP THE CACHED RESOLUTION AFTERWARDS.
 *
 * These two are re-exported together because using the first without the
 * second is a silent, passing-for-the-wrong-reason bug.
 * `setEntitlementOverrideSql` writes `org_entitlement_overrides` by raw SQL and
 * invalidates nothing, while `lib/entitlements.ts` caches every resolution for
 * `ENT_TTL_SECONDS = 300` (:23). So an override is observed only if it is
 * written BEFORE the key is first resolved for that org, or followed by
 * `invalidateOrgEntitlements(page.request, orgId)`.
 *
 * The trap is that `liveLimit` below IS a first resolution — the entitlements
 * route runs every value through `getLimit`, which warms the cache. The
 * sequence a spec reaches for naturally,
 *
 *     const cap = await liveLimit(page, orgId, key);   // <- warms the cache
 *     await setEntitlementOverrideSql(orgId, key, 2);  // <- invalidates nothing
 *     // ...drive the UI, assert the cap...            // <- still reads `cap`
 *
 * asserts the PLAN DEFAULT while appearing to test the override, for up to
 * five minutes. Either invalidate between lines 2 and 3, or set the override
 * before ever calling `liveLimit` for that key.
 *
 * And it will not fail here. `lib/cache.ts` is fail-open and `REDIS_URL` is
 * unset locally, so a spec that gets this wrong is green on this machine and
 * red only on a Redis-backed target. `helpers.ts:486-493` spells the same
 * obligation out on the sibling `setBoolEntitlementOverrideSql`.
 *
 * The write itself is org-scoped and cannot leak: `org_entitlement_overrides`
 * is PRIMARY KEY (org_id, feature_key)
 * (db/migration/deltas/V101__billing.sql:66-73).
 */
export { setEntitlementOverrideSql, invalidateOrgEntitlements };

/** RFC4180 quoting: a field containing a comma, quote, CR or LF is quoted and
 *  its own quotes doubled. Without this a club name with a comma shifts every
 *  later column and the importer plans the wrong entities silently.
 *
 *  `\r` belongs in the class as much as `\n` does: RFC4180's line break is
 *  CRLF, so a field carrying one is split by any reader that honours a bare CR
 *  — and a lone CR would sail through a `\n`-only test unquoted. Both branches
 *  are covered by the "quotes a field containing an embedded newline" case in
 *  src/__tests__/directory-kit.test.ts; deleting either character from the
 *  class reds it. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A participant sheet. `Club`/`Team`/`Player` are recognised header aliases
 *  (import-parse.ts HEADER_ALIASES: clubname/club, team/teamname, player/...). */
export function participantCsv(
  rows: ReadonlyArray<{ club: string; team: string; player: string }>,
): string {
  return [
    "Club,Team,Player",
    ...rows.map((r) => [r.club, r.team, r.player].map(csvCell).join(",")),
  ].join("\n");
}
