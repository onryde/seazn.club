import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  seedMemberIdentity,
  type SeededOrg,
} from "../settings-support";
import {
  apiJson,
  TAG,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
  setEntitlementOverrideSql,
} from "../helpers";
import { routes } from "../../src/lib/routes";

/**
 * W5 Task 2 — the GATING half of `/o/{org}/c/{comp}/settings`.
 *
 * Task 1 (`settings-competition-drive.spec.ts`) drives the surface as an
 * entitled owner. This file asks the opposite question of every control on it:
 * who is refused, by what, and does the organiser find out. Five gates, and
 * they are deliberately not the same shape as each other —
 *
 *   - `competitions.max_active` freezes an EXISTING competition (case #4);
 *   - `discovery.branding` disables two fields the client then stops sending;
 *   - `discovery.listed` has NO form gate at all — the server is the only one;
 *   - `dashboard.theme` removes a whole tab rather than disabling it;
 *   - a viewer's role removes the Save button rather than the fields;
 *
 * plus case #18, the date-order refusal, which is neither an entitlement nor a
 * role but belongs with them because it is the last refusal this surface owes.
 *
 * EVERY refusal here is asserted on the API as well as (or instead of) the UI,
 * and that is not belt-and-braces. `competition-settings.tsx` pre-clears the
 * gated fields before the request leaves the browser (`...(discoveryBranding ?
 * { tagline, hero_image_path } : {})`, :165), exactly the shape Task 1's case
 * #10 found on `discoverable`: delete the server's guard and the whole UI path
 * stays green. The scripted PATCH is the only witness the server guard has, and
 * the pinned request BODY below is the evidence that it is not redundant.
 *
 * `mode: "default"` for the reason `settings-org-tabs.spec.ts` sets out and
 * Task 1 repeats: `fullyParallel: true` with `--workers=3` would run
 * `beforeAll` — and therefore an org seed — once per worker, against a shared
 * Pro user capped at five owned orgs. Not `serial`, because serial SKIPS every
 * test after the first red and this file exists to find defects on a surface
 * that had none of this covered (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

/** Copy read from the dictionary the page renders from, never retyped — same
 *  idiom as `settings-competition-drive.spec.ts:44` and the two specs it cites. */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return raw;
}

const L = {
  name: ui("compset.name"),
  ends: ui("compset.ends"),
  tagline: ui("compset.tagline"),
  hero: ui("compset.heroUrl"),
  pro: ui("compset.pro"),
  save: ui("compset.save"),
  saved: ui("compset.saved"),
  readOnly: ui("compset.readOnly"),
  showcase: ui("showcase.label"),
  tabGeneral: ui("compset.tab.general"),
  tabBranding: ui("compset.tab.branding"),
  /**
   * The sentence BOTH date refusals must carry — the 400's `issues[0].message`
   * (one body carrying an inverted pair) and the 422's `error.message` (one
   * date inverted against the stored row, W8/F8).
   *
   * Read from the dictionary rather than retyped BECAUSE the schema says it
   * is a mirror: `ENDS_BEFORE_STARTS` (api-v1/schemas.ts, `export const` just
   * under the `#376` block comment) is documented as "Message mirrors the `en`
   * copy for `comp.validation.endsBeforeStarts` … an API client reads this
   * same sentence either out of a 400's `issues` … or out of a 422's
   * `error.message`". Two spellings of one sentence in two files is a standing
   * invitation to drift, and this is the only thing in the tree that would
   * notice. A value import of `schemas.ts` is not the alternative: it pulls
   * `@seazn/engine/scheduling` and `lib/registration-rules.ts` into a
   * Playwright worker, and no e2e file imports it today.
   */
  endsBeforeStarts: ui("comp.validation.endsBeforeStarts"),
} as const;

/**
 * Budgets expressed in what the test does, never a flat constant beside a
 * derived cost (`_RULES.md` §5.7) — the same four constants Task 1 uses, so
 * the two files' budgets move together.
 */
const NAV_MS = 20_000;
const COMMIT_MS = 12_000;
const SEED_MS = 10_000;
const READ_MS = 20_000;
const budget = (navs: number, commits: number, seeds = 1): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + commits * COMMIT_MS + seeds * SEED_MS);

/**
 * The envelope `api-v1/http.ts` actually sends, which is WIDER than the one
 * `apiJson` declares (`{ code?, message? }`, helpers.ts:132).
 *
 * `errorResponse` (http.ts:113) spreads `extra` into `error`, so a 402 carries
 * `feature_key` (the key the paywall is keyed on, http.ts:222-227) and a
 * ZodError carries `issues` (http.ts:152-155). Asserting a bare status number
 * is what lets a 402 from the WRONG gate — or a 400 from a typo'd field name —
 * read as a pass, so every refusal below is pinned to its key or its issue.
 */
interface V1Error {
  code?: string;
  message?: string;
  feature_key?: string;
  issues?: { code?: string; path?: (string | number)[]; message?: string }[];
}
const v1Error = (res: { error?: { code?: string; message?: string } }): V1Error =>
  (res.error ?? {}) as V1Error;

interface CompetitionRead {
  id: string;
  name: string;
  slug: string;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  status: string;
  discoverable: boolean;
  discovery: { tagline?: string | null; hero_image_path?: string | null } | null;
  frozen?: boolean;
}

/** The row as the SERVER sees it. Duplicated from Task 1's spec rather than
 *  shared: `settings-support.ts` is the right home for it once both files are
 *  settled, but moving Task 1's helpers is a refactor of a reviewed file and
 *  outside this task's brief. Recommended to the controller in the report. */
async function readComp(request: APIRequestContext, id: string): Promise<CompetitionRead> {
  const res = await apiJson<CompetitionRead>(request, `/api/v1/competitions/${id}`, "GET");
  expect(res.status, `GET /api/v1/competitions/${id}`).toBe(200);
  // `apiJson` swallows a body-parse failure and returns `data: undefined`, so
  // without this a broken envelope degrades every assertion below into
  // `expect(undefined)` and passes vacuously.
  expect(res.data, "the competition read must carry a row").toBeDefined();
  return res.data!;
}

const patchComp = (request: APIRequestContext, id: string, body: unknown) =>
  apiJson<CompetitionRead>(request, `/api/v1/competitions/${id}`, "PATCH", body);

/** The `^`-anchored form of a dictionary string, for `hasText`. Extracted from
 *  `field()` so the one assertion that needs the <label> ITSELF rather than its
 *  input can still go through `L.*` instead of retyping the copy. */
function startsWith(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** The input inside the wrapping <label> whose copy STARTS WITH `label` —
 *  Task 1's `field()`, kept identical so the two files' selectors read as
 *  siblings. Anchored RegExp rather than `hasText: "…"`, which is a
 *  case-INSENSITIVE SUBSTRING match: `"Name"` also matches the showcase
 *  consent paragraph and blows strict mode. */
function field(page: Page, label: string) {
  return page.locator("label").filter({ hasText: startsWith(label) }).locator("input");
}

const showcaseBox = (page: Page) => page.getByRole("checkbox", { name: L.showcase });
const saveButton = (page: Page) => page.getByRole("button", { name: L.save, exact: true });

/**
 * Submit the form and hand back the PATCH it sent AND the status it got.
 *
 * Deliberately NOT Task 1's `saveSettings`, which asserts 200 internally: two
 * tests here press Save expecting a REFUSAL, and a helper that asserts success
 * cannot express them. The request body is what proves the client pre-clears
 * its gated fields, which is why the scripted PATCHes exist at all.
 */
async function pressSave(
  page: Page,
  compId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pending = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/competitions/${compId}`) && r.request().method() === "PATCH",
    { timeout: COMMIT_MS },
  );
  await saveButton(page).click();
  const res = await pending;
  return {
    status: res.status(),
    body: (res.request().postDataJSON() ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Entitlement overrides, and getting them BACK.
// ---------------------------------------------------------------------------

/**
 * A cap wide enough that nothing in this file freezes — NOT Pro's default.
 *
 * The overrides table has no delete helper, so "restore" here means "put it
 * somewhere harmless", and that is safe only because the org is seeded in
 * `beforeAll` and destroyed in `afterAll`: nothing outside this file ever
 * resolves an entitlement for it, and nothing inside it asserts the plan
 * default. Said out loud because a reader who assumes this restores Pro's real
 * cap would write a test that silently proves nothing.
 */
const WIDE_CAP = 9999;

/**
 * Every org this file has written an override for, so the hook below can put
 * them all back. Populated BEFORE the write, not after — public-dashboards.
 * spec.ts:42 makes the same point: a set filled afterwards is empty in exactly
 * the runs that abandon the write half-way, which is the case the hook is for.
 */
const overridden = new Set<string>();

/**
 * `invalidateOrgEntitlements`, but only where it can actually do something.
 *
 * The helper has no public invalidation endpoint to ride, so it flips the org
 * OWNER to superadmin for two fetches and back (`setOwnerStaffSql`,
 * helpers.ts:961-983). That write lands on a GLOBAL `users` row — the `org_id`
 * only picks WHICH user — and this file has no `test.use({ storageState })` of
 * its own, so its owner IS the shared Pro user.
 *
 * `settings-admin.spec.ts` is also unscoped and flips the same bit ~11 times
 * for its own 401/403 assertions. The walkthrough leg runs `--workers=3`
 * (e2e.yml) and `mode: "default"` only serialises WITHIN a file, so the two
 * files' superadmin windows overlap: one file's restore-to-false can land
 * mid-assertion in the other's window. The three existing walkthrough callers
 * (directory-clubs-import-limits, directory-officials-roles,
 * directory-import-paywall-preview) all mint their own user first, which is
 * why this collision is new here rather than pre-existing.
 *
 * Local and CI have no Redis on purpose (e2e.yml), so `lib/cache.ts` is inert
 * and the round-trip buys NOTHING there while the `is_staff` side effect is
 * paid on every call. Gating on `REDIS_URL` drops the call wherever it is a
 * no-op — which, per `e2e/global-setup.ts:63-70`, is EVERY environment this
 * suite can actually run in (a set `REDIS_URL` aborts the run before any spec
 * executes), so in practice this predicate always skips the call. It reads
 * the RUNNER's env, not the server process's — the one live-cache shape that
 * would matter (a Redis-backed server, a Redis-less runner) is exactly what
 * this gate cannot see, but no config in this repo produces that shape today.
 * No assertion in this file changes either way: with no Redis there is no
 * cached resolution to drop.
 *
 * Note the helper never checks either fetch's response status, so a lost race
 * fails silently rather than loudly. Tracked as `FINDINGS.md` F10 — not this
 * wave's to fix, three other specs call it.
 */
async function dropEntitlementCache(request: APIRequestContext, orgId: string): Promise<void> {
  if (!process.env.REDIS_URL) return;
  await invalidateOrgEntitlements(request, orgId);
}

async function setCap(
  request: APIRequestContext,
  orgId: string,
  key: string,
  value: number,
): Promise<void> {
  overridden.add(orgId);
  await setEntitlementOverrideSql(orgId, key, value);
  await dropEntitlementCache(request, orgId);
}

async function setFlag(
  request: APIRequestContext,
  orgId: string,
  key: string,
  value: boolean,
): Promise<void> {
  overridden.add(orgId);
  await setBoolEntitlementOverrideSql(orgId, key, value);
  await dropEntitlementCache(request, orgId);
}

/**
 * Put every key back, after every test, whether or not the test's own
 * `finally` ran.
 *
 * Both halves — the SQL write AND the cache drop, the latter via
 * `dropEntitlementCache` (a no-op without `REDIS_URL`; see its comment for why
 * that is safe, and for the shared-user race it exists to avoid). `lib/entitlements.ts`
 * caches each resolution for `ENT_TTL_SECONDS = 300`, and `lib/cache.ts` is
 * fail-open with `REDIS_URL` unset locally, so a spec that writes without
 * invalidating is green on this machine and red only on a Redis-backed target
 * (directory-kit.ts:308-338 spells this out; public-dashboards.spec.ts:52-67
 * is the hook this one copies, and its own comment records that it shipped
 * with only the write and reintroduced the stale-cache half).
 *
 * A test-level TIMEOUT does not unwind the test function, so its `finally`
 * never runs (Task 1's `afterAll` comment). Three different keys get flipped
 * across this file and all five tests share ONE org — a leaked override is a
 * sibling test silently asserting the wrong plan. Hence: unconditional, all
 * four keys, not just the one the failing test happened to touch.
 */
test.afterEach(async ({ request }) => {
  if (overridden.size === 0) return;
  for (const id of overridden) {
    await setEntitlementOverrideSql(id, "competitions.max_active", WIDE_CAP);
    await setBoolEntitlementOverrideSql(id, "discovery.branding", true);
    await setBoolEntitlementOverrideSql(id, "discovery.listed", true);
    await setBoolEntitlementOverrideSql(id, "dashboard.theme", true);
    await dropEntitlementCache(request, id);
  }
  overridden.clear();
});

// ---------------------------------------------------------------------------

let org: SeededOrg;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture: `seedSettingsOrg` moves the
  // `seazn_org` cookie of whatever jar it is handed, and a per-test fixture's
  // jar is not the one the next test gets anyway.
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W5-gates" });
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  if (!org) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

test("case #4: over quota freezes the OLDER competition — the form says read-only, Save 402s into the paywall, and only a bare retire patch still lands", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 1, 2));
  // Two competitions and a cap of one. `status` is left at `seedCompetition`'s
  // default `draft` DELIBERATELY: `ACTIVE_COMPETITION_STATUSES`
  // (entitlement-freeze.ts:15) is `["draft","published","live"]`, so a draft IS
  // an active slot. "It must be live to count" is the common paraphrase of
  // `liveUnpassedCompetition` and it is wrong — the clause that names `live` is
  // about PASSES, not drafts.
  const older = await seedCompetition(request, org.orgId, { visibility: "public" });
  const newer = await seedCompetition(request, org.orgId, { visibility: "public" });
  try {
    await setCap(request, org.orgId, "competitions.max_active", 1);

    // WHICH of the two freezes is derived, not assumed. `selectFrozen`
    // (entitlement-freeze.ts) sorts candidates by `lastActiveAt` DESCENDING
    // and keeps the first `limit` — "most recently active first" — so with no
    // score events anywhere, `last_active` is `created_at` and the SECOND
    // competition created is the one kept live. Both directions are asserted:
    // `older` alone would pass on a selector that froze everything, and
    // `newer` alone on one that froze nothing.
    expect(
      (await readComp(request, older.id)).frozen,
      "the LESS recently active competition is the one over the cap",
    ).toBe(true);
    expect(
      (await readComp(request, newer.id)).frozen,
      "the most recently active competition keeps the only slot",
    ).toBe(false);

    await page.goto(routes.competitionSettings(org.slug, older.slug));
    await expect(page.getByText(L.readOnly)).toBeVisible({ timeout: READ_MS });
    await expect(field(page, L.name)).toBeDisabled();
    await expect(field(page, L.ends)).toBeDisabled();
    // The discriminating one. This checkbox is `disabled={readOnly ||
    // form.visibility !== "public"}` (competition-settings.tsx:355) and the
    // competition IS public, so `readOnly` is the only thing that can be
    // disabling it — i.e. the freeze reached past the two plain text fields.
    await expect(showcaseBox(page)).toBeDisabled();

    // Save is NOT hidden on a frozen competition: the button is gated on
    // `canEdit` alone (:455) and the owner of a frozen competition still has
    // it. So "read-only" here is a badge plus disabled inputs, and the actual
    // enforcement is the server's — which the organiser meets as a paywall.
    // Driving it is what proves the refusal is SURFACED rather than swallowed.
    await expect(saveButton(page)).toBeEnabled();
    const pressed = await pressSave(page, older.id);
    expect(pressed.status, "the form's own PATCH must be refused too").toBe(402);
    await expect(
      page.locator('[data-feature="competitions.max_active"]'),
      "the 402 must render the contextual paywall, keyed on the quota that refused",
    ).toBeVisible({ timeout: READ_MS });
    await expect(
      page.getByText(L.saved),
      "a refused save must never report success",
    ).toHaveCount(0);

    const refused = await patchComp(request, older.id, { name: `refused ${TAG}` });
    expect(refused.status).toBe(402);
    expect(v1Error(refused).code).toBe("PAYMENT_REQUIRED");
    expect(
      v1Error(refused).feature_key,
      "the 402 must name the quota that refused, or a 402 from any other gate reads as a pass",
    ).toBe("competitions.max_active");
    expect(
      (await readComp(request, older.id)).name,
      "a refused patch must not partially apply",
    ).toBe(older.name);

    // THE ESCAPE HATCH, pinned to what `isRetirePatch` actually says
    // (usecases/competitions.ts:462) rather than to the idea of it. It is
    // `keys.length === 1 && keys[0] === "status" && status ∈ {completed,
    // archived}` — three conjuncts, and the two below kill the two that a
    // single happy-path retire test cannot: drop `keys.length === 1` and a
    // rename rides through the hatch; drop the status-set check and a frozen
    // competition can be put back live.
    const rider = await patchComp(request, older.id, {
      status: "archived",
      name: `rider ${TAG}`,
    });
    expect(
      rider.status,
      "the hatch is a BARE status patch — a field riding along must still be refused",
    ).toBe(402);
    expect(v1Error(rider).feature_key).toBe("competitions.max_active");
    const wrongStatus = await patchComp(request, older.id, { status: "live" });
    expect(wrongStatus.status, "only completed/archived pass the hatch").toBe(402);
    expect(v1Error(wrongStatus).feature_key).toBe("competitions.max_active");

    const retire = await patchComp(request, older.id, { status: "archived" });
    expect(
      retire.status,
      `retiring a frozen competition must stay possible: ${JSON.stringify(v1Error(retire))}`,
    ).toBe(200);
    // ...and it is the way back under quota, which is the whole reason the
    // hatch exists. `archived` is outside ACTIVE_COMPETITION_STATUSES, so the
    // org now holds one active competition against a cap of one.
    expect(
      (await readComp(request, older.id)).frozen,
      "the retired competition is no longer a frozen active slot",
    ).toBe(false);
    expect((await readComp(request, newer.id)).frozen).toBe(false);
  } finally {
    await releaseCompetition(request, newer.id);
    await releaseCompetition(request, older.id);
  }
});

test("discovery.branding: the tagline and hero go disabled, the client then stops sending them, and a scripted PATCH that does send one is 402ed", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 1));
  const comp = await seedCompetition(request, org.orgId, { visibility: "public" });
  try {
    await setFlag(request, org.orgId, "discovery.branding", false);

    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    // The two branding fields only mount once the showcase opt-in is on and
    // the competition is public (competition-settings.tsx:375) — so the opt-in
    // is a precondition of this test, not part of what it asserts.
    await expect(showcaseBox(page)).toBeEnabled({ timeout: READ_MS });
    await showcaseBox(page).check();
    await expect(field(page, L.tagline)).toBeDisabled();
    await expect(field(page, L.hero)).toBeDisabled();
    // The organiser is told WHY, in the label rather than only by the greyed
    // control. Scoped to the tagline's own <label> because "(Pro)" appears
    // more than once on this page.
    await expect(
      page.locator("label").filter({ hasText: startsWith(L.tagline) }),
    ).toContainText(L.pro);

    // WHY THE SCRIPTED PATCH BELOW IS NOT REDUNDANT, pinned rather than
    // asserted about. `save()` builds its `discovery` object as
    // `...(discoveryBranding ? { tagline, hero_image_path } : {})` (:165), so
    // with the key off the browser never mentions either field — delete
    // `requireFeature("discovery.branding")` from `patchCompetition` and every
    // UI assertion above still passes. This is Task 1's case #10 shape on a
    // second field pair, and it is the reason this file asserts on the API.
    const saved = await pressSave(page, comp.id);
    expect(saved.status).toBe(200);
    const sentDiscovery = (saved.body.discovery ?? {}) as Record<string, unknown>;
    expect(
      Object.keys(sentDiscovery).sort(),
      "the client omits the gated keys entirely, so the UI can never exercise the server's gate",
    ).toEqual(["city", "country"]);

    const refused = await patchComp(request, comp.id, {
      discovery: { tagline: `should 402 ${TAG}` },
    });
    expect(refused.status).toBe(402);
    expect(v1Error(refused).feature_key).toBe("discovery.branding");
    expect(
      (await readComp(request, comp.id)).discovery?.tagline ?? null,
      "a refused patch must not write the tagline anyway",
    ).toBeNull();

    // THE OTHER OPERAND OF THE SAME `||`, and it needs its own PATCH.
    // `patchCompetition:519` reads `patch.discovery?.tagline ||
    // patch.discovery?.hero_image_path`. A mutant that deletes the whole
    // `requireFeature` call kills the tagline case above and says NOTHING
    // about this disjunct — a union has to be mutated per MEMBER, or the
    // uncovered branch hides behind the covered one. Nothing else in the tree
    // sends `hero_image_path` to this route, so dropping the second operand
    // would hand a paid presentation field to every non-entitled org through
    // the public API and stay green everywhere.
    const refusedHero = await patchComp(request, comp.id, {
      discovery: { hero_image_path: `https://example.invalid/hero-${TAG}.jpg` },
    });
    expect(refusedHero.status).toBe(402);
    expect(v1Error(refusedHero).feature_key).toBe("discovery.branding");
    expect(
      (await readComp(request, comp.id)).discovery?.hero_image_path ?? null,
      "a refused patch must not write the hero image either",
    ).toBeNull();

    // The positive half of the pair. Without it a 402 could be coming from
    // anywhere in the request — the shape, the route, a stale session — and
    // the test would pass with the entitlement check deleted and something
    // else refusing instead.
    const tagline = `W5 tagline ${TAG}`;
    await setFlag(request, org.orgId, "discovery.branding", true);
    const allowed = await patchComp(request, comp.id, { discovery: { tagline } });
    expect(
      allowed.status,
      `the same patch must land once the key is held: ${JSON.stringify(v1Error(allowed))}`,
    ).toBe(200);
    expect((await readComp(request, comp.id)).discovery?.tagline).toBe(tagline);
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("discovery.listed: the form gates nothing at all — the showcase checkbox stays live and the server is the only refusal", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 0));
  const comp = await seedCompetition(request, org.orgId, { visibility: "public" });
  try {
    await setFlag(request, org.orgId, "discovery.listed", false);

    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    // NOT an oversight, and the reason this test is API-first. Doc 15 §5:
    // listing is free on every tier and the gate exists so a staff override
    // can switch it off — so no plan a customer can buy renders this
    // differently, and `competition-settings.tsx` has no `discovery.listed`
    // branch to render. The checkbox staying enabled with the key revoked is
    // the fact that makes the refusal below the only coverage this key has.
    await expect(showcaseBox(page)).toBeEnabled({ timeout: READ_MS });

    const refused = await patchComp(request, comp.id, { discoverable: true });
    expect(refused.status).toBe(402);
    expect(v1Error(refused).feature_key).toBe("discovery.listed");
    expect(
      (await readComp(request, comp.id)).discoverable,
      "a refused opt-in must not reach the row",
    ).toBe(false);

    await setFlag(request, org.orgId, "discovery.listed", true);
    const allowed = await patchComp(request, comp.id, { discoverable: true });
    expect(
      allowed.status,
      `the same opt-in must land once the key is held: ${JSON.stringify(v1Error(allowed))}`,
    ).toBe(200);
    expect((await readComp(request, comp.id)).discoverable).toBe(true);
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("dashboard.theme: the Branding tab is absent rather than disabled, and it comes back when the key does", async ({
  page,
  request,
}) => {
  // Two navs: the goto, and the reload that proves the tab comes back.
  test.setTimeout(budget(2, 0));
  const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
  try {
    await setFlag(request, org.orgId, "dashboard.theme", false);

    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    // THE POSITIVE ANCHOR, and it comes first on purpose: `toHaveCount(0)` is
    // satisfied by a 404, by a redirect, and by a page that threw before it
    // rendered a tablist at all. Without something asserting the page IS the
    // settings page, this test passes for every reason except the one it is
    // named for.
    await expect(
      page.getByRole("tab", { name: L.tabGeneral, exact: true }),
      "the settings page must have rendered before its missing tab means anything",
    ).toBeVisible({ timeout: READ_MS });
    await expect(
      page.getByRole("tab", { name: L.tabBranding, exact: true }),
      "without dashboard.theme the tab is not rendered at all — `tabs` omits it (competition-settings.tsx:201), it is not a disabled control",
    ).toHaveCount(0);

    // And back — which is what makes the `toHaveCount(0)` above mean anything.
    // A locator that can never match (a renamed dictionary key, a tab that
    // stopped being a `role="tab"`) satisfies a count of zero forever; this
    // half is the proof that the same locator DOES match when the entitlement
    // is held, so the zero was the entitlement's doing.
    await setFlag(request, org.orgId, "dashboard.theme", true);
    await page.reload();
    await expect(
      page.getByRole("tab", { name: L.tabBranding, exact: true }),
      "the tab is the entitlement's only expression on this surface, so it must return with it",
    ).toBeVisible({ timeout: READ_MS });
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

// No `page` fixture: this test drives the MEMBER's context and requesting the
// owner's `page` would launch a second browser page nobody looks at.
test("a viewer sees the same form with no Save button, and their PATCH is 403 while their read is 200", async ({
  request,
  browser,
}) => {
  // Three "seeds": the competition, plus `seedMemberIdentity`'s invite mint,
  // accept and `/api/users/me` on a SECOND browser context — which is a
  // context launch, not just an API call.
  test.setTimeout(budget(1, 0, 3));
  const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
  // `seedMemberIdentity` mints the invite as the OWNER (this file's `request`
  // fixture, the one `seedSettingsOrg` used) and accepts it on a second
  // context carrying the COMMUNITY storageState — never a bare
  // `browser.newContext()`, which inherits the signed-in Pro session and turns
  // this into the owner testing themselves (settings-support.ts:139-157).
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    const memberPage = await member.ctx.newPage();
    try {
      await memberPage.goto(routes.competitionSettings(org.slug, comp.slug));
      // A viewer is a read role, so the PAGE renders — `requireCompetitionPage`
      // only 404s scorers (page-auth.ts:271). What they lose is `canEdit`.
      await expect(field(memberPage, L.name)).toBeDisabled({ timeout: READ_MS });
      await expect(field(memberPage, L.name)).toHaveValue(comp.name);
      await expect(
        memberPage.getByRole("button", { name: L.save, exact: true }),
        "`canEdit` removes the Save button outright (competition-settings.tsx:455) — unlike a freeze, which leaves it",
      ).toHaveCount(0);
      // The two read-only states are NOT the same state, and the badge is how
      // they differ: `compset.readOnly` reads "read-only (over quota)" and is
      // rendered on `competition.frozen` alone (:241). A viewer is not over
      // quota, so claiming they were would be a wrong explanation, not a
      // missing one.
      await expect(memberPage.getByText(L.readOnly)).toHaveCount(0);
    } finally {
      await memberPage.close();
    }

    const refused = await patchComp(member.request, comp.id, { name: `should 403 ${TAG}` });
    expect(refused.status).toBe(403);
    // The positive control, and it is not optional here. `requireOrgAuth`
    // (api-v1/auth.ts:214-218) answers a NON-member 401 and an under-privileged
    // member 403, so the 403 above already rules out "the invite never landed"
    // — but it does NOT rule out the identity being someone else entirely who
    // happens to be a viewer somewhere. A 200 on the read from the SAME context
    // proves this identity holds a read role on THIS competition's org, which
    // is what makes the 403 a statement about the write scope specifically.
    const read = await apiJson(member.request, `/api/v1/competitions/${comp.id}`, "GET");
    expect(read.status, "a viewer can read the competition they cannot write").toBe(200);
    expect((await readComp(request, comp.id)).name, "the refused rename must not apply").toBe(
      comp.name,
    );
  } finally {
    await member.release();
    await releaseCompetition(request, comp.id);
  }
});

test("case #18: an end before the start is refused both in one body (400, issue on ends_on) and against the stored row (422)", async ({
  request,
}) => {
  test.setTimeout(budget(0, 0));
  const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
  try {
    const refused = await patchComp(request, comp.id, {
      starts_on: "2027-06-01",
      ends_on: "2027-01-01",
    });
    // 400, NOT 422, for THIS shape. The order check is a `superRefine` on
    // `PatchCompetition` (api-v1/schemas.ts, `checkDateOrder` and the
    // `.superRefine(checkDateOrder)` on `PatchCompetition`), so it throws a
    // ZodError, and `v1Inner` maps ZodError to 400 with `issues`
    // (api-v1/http.ts) before any use-case runs. 422 on this route is the
    // semantic refusals `patchCompetition` raises itself — a reserved slug,
    // showcasing a non-public competition, and since W8/F8 the stored-row
    // date order asserted at the end of this test.
    expect(
      refused.status,
      `an inverted date pair must be refused: ${JSON.stringify(v1Error(refused))}`,
    ).toBe(400);
    expect(v1Error(refused).code).toBe("VALIDATION");
    const issues = v1Error(refused).issues ?? [];
    // `path`, not just "an issue exists": the message is attached to `ends_on`
    // deliberately (`ctx.addIssue({ path: ["ends_on"] })`) because that is the
    // field the form highlights, and an issue landing on the object root would
    // still make the request fail while telling the client nothing.
    const dateIssue = issues.find((i) => i.path?.includes("ends_on"));
    expect(dateIssue, `no issue on ends_on: ${JSON.stringify(issues)}`).toBeDefined();
    expect(dateIssue?.message).toBe(L.endsBeforeStarts);
    expect(dateIssue?.code).toBe("custom");

    const before = await readComp(request, comp.id);
    expect(before.starts_on, "a refused patch writes neither date").toBeNull();

    // The pair. The same two fields in the right order must land, or the test
    // above is satisfied by a route that refuses every dated patch.
    const allowed = await patchComp(request, comp.id, {
      starts_on: "2027-01-01",
      ends_on: "2027-06-01",
    });
    expect(
      allowed.status,
      `the same pair in order must land: ${JSON.stringify(v1Error(allowed))}`,
    ).toBe(200);
    const after = await readComp(request, comp.id);
    expect(after.starts_on).toBe("2027-01-01");
    expect(after.ends_on).toBe("2027-06-01");

    // F8, FIXED (W8 Task 4). The same inversion assembled across TWO requests
    // is now refused exactly like the inversion in ONE request above — but by
    // a different layer, so the status differs and that is the point.
    //
    // `checkDateOrder` is a `superRefine` on the request BODY, so it can only
    // compare the dates a request CARRIES; a patch naming one date alone walks
    // past it by construction. `schemas.ts` has always claimed the gap was
    // closed elsewhere ("the same order is re-checked in the use-case against
    // the stored row"), and until W8 that re-check did not exist: with
    // `starts_on = 2027-06-01` stored, a `PATCH { ends_on: "2027-01-01" }`
    // answered 200 and left the row ending five months before it started
    // (witnessed against a running server, W5 T2 probe 2026-09-06; recorded as
    // F8 in the programme's FINDINGS.md). `patchCompetition` now merges the
    // patch against the stored row inside its own tenant transaction and
    // raises its own `HttpError(422, ENDS_BEFORE_STARTS)` — hence **422** here
    // against **400** above. Same sentence, two layers, and the status is what
    // says which one caught it.
    //
    // Stored at this point, from the `allowed` pair just above:
    //   starts_on = 2027-01-01, ends_on = 2027-06-01.

    // (a) `ends_on` alone, dragged BEFORE the stored start.
    const endsFirst = await patchComp(request, comp.id, { ends_on: "2026-12-31" });
    expect(
      endsFirst.status,
      `a cross-request inversion via ends_on must be refused: ${JSON.stringify(v1Error(endsFirst))}`,
    ).toBe(422);
    expect(v1Error(endsFirst).message).toBe(L.endsBeforeStarts);
    const afterEndsFirst = await readComp(request, comp.id);
    expect(afterEndsFirst.ends_on, "a refused patch must not have written the new end date").toBe(
      "2027-06-01",
    );
    expect(afterEndsFirst.starts_on, "and must not have moved the start either").toBe("2027-01-01");

    // (b) the MIRROR — `starts_on` alone, dragged AFTER the stored end. The
    // merge has two sides and each is separately reachable: a guard that only
    // merged the end against the stored start still passes (a). One request
    // per side, per AGENTS.md failure class 3.
    const startsLater = await patchComp(request, comp.id, { starts_on: "2027-12-01" });
    expect(
      startsLater.status,
      `a cross-request inversion via starts_on must be refused: ${JSON.stringify(v1Error(startsLater))}`,
    ).toBe(422);
    expect(v1Error(startsLater).message).toBe(L.endsBeforeStarts);
    const afterStartsLater = await readComp(request, comp.id);
    expect(afterStartsLater.starts_on, "a refused patch must not have written the new start").toBe(
      "2027-01-01",
    );

    // (c) the POSITIVE pair for (a) and (b), without which a use-case that
    // refused EVERY single-date patch — or every patch at all — satisfies both
    // of them. A single date that stays in order against the stored row lands.
    const singleAllowed = await patchComp(request, comp.id, { ends_on: "2027-09-01" });
    expect(
      singleAllowed.status,
      `a single-date patch that stays in order must land: ${JSON.stringify(v1Error(singleAllowed))}`,
    ).toBe(200);
    const afterSingle = await readComp(request, comp.id);
    expect(afterSingle.ends_on, "the in-order single-date patch must apply").toBe("2027-09-01");
    expect(afterSingle.starts_on, "and must leave the start where it was").toBe("2027-01-01");

    // (d) THE BOUNDARY. A ONE-DAY competition — merged start EQUAL to merged
    // end — is a supported product state, and every case above misses it: the
    // four inversions are all strictly ordered and the two positives are all
    // months apart, so `mergedEnds < mergedStarts` had never been evaluated on
    // an equal pair. Widening it to `<=` therefore survived the entire suite,
    // including the four-mutant shape sweep, while silently refusing every
    // single-day event (review finding, W8 T4).
    //
    // `competition-settings.tsx` makes the state reachable on purpose: the end
    // input carries `min={form.starts_on}` and HTML `min` is INCLUSIVE, and the
    // client's own pre-check at `save()` is a strict `<`. So the form offers
    // the same-day pick and the server must take it.
    //
    // Stored right now: starts_on = 2027-01-01, ends_on = 2027-09-01.
    const sameDay = await patchComp(request, comp.id, { ends_on: "2027-01-01" });
    expect(
      sameDay.status,
      `a one-day competition must be allowed, not refused: ${JSON.stringify(v1Error(sameDay))}`,
    ).toBe(200);
    const afterSameDay = await readComp(request, comp.id);
    expect(afterSameDay.starts_on, "the one-day competition keeps its start").toBe("2027-01-01");
    expect(afterSameDay.ends_on, "and ends the SAME day, not the day before").toBe("2027-01-01");

    // (e) the same boundary one layer up. `checkDateOrder` (zod) carries its
    // OWN `<`, and (d) cannot reach it — (d) sends one date, so the superRefine
    // has nothing to compare. This is the shape the FORM actually sends for a
    // one-day event (`competition-settings.tsx` always sends both dates), so a
    // `<`->`<=` slip in the schema would 400 the real user path while the
    // use-case guard stayed innocent. Two comparators, two requests.
    const sameDayPair = await patchComp(request, comp.id, {
      starts_on: "2028-03-05",
      ends_on: "2028-03-05",
    });
    expect(
      sameDayPair.status,
      `an equal pair in ONE body must be allowed: ${JSON.stringify(v1Error(sameDayPair))}`,
    ).toBe(200);
    const afterSameDayPair = await readComp(request, comp.id);
    expect(afterSameDayPair.starts_on).toBe("2028-03-05");
    expect(afterSameDayPair.ends_on).toBe("2028-03-05");
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

