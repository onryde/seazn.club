import { expect, type Page, type Locator } from "@playwright/test";
import { TAG, apiJson, loginUi, setEntitlementOverrideSql } from "./helpers";

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

/** A per-run token. `TAG` is per-PROCESS (helpers.ts), and these specs share
 *  an org with every other spec in the leg, so the random tail is what makes
 *  two concurrent workers unable to collide on the same (org, name). */
export function stamp(): string {
  return `${TAG}-${Math.random().toString(36).slice(2, 6)}`;
}

export function uniqueName(label: string): string {
  return `${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`;
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
 * and the Players tab renders only the OLDEST 200 persons (page.tsx:106 passes
 * limit 200; listPersons orders by created_at). So a person created late in a
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

/** Re-export so a spec sets a deterministic cap without importing two modules.
 *  Org-scoped: org_entitlement_overrides is PRIMARY KEY (org_id, feature_key)
 *  (db/migration/deltas/V101__billing.sql:66-73), so it cannot leak into
 *  another spec's org. */
export { setEntitlementOverrideSql };

/** RFC4180 quoting: a field containing a comma, quote or newline is quoted and
 *  its own quotes doubled. Without this a club name with a comma shifts every
 *  later column and the importer plans the wrong entities silently. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
