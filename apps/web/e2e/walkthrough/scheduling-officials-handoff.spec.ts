import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  divisionPath,
  expectNoHorizontalScroll,
  loginUi,
  screenshotAtWidths,
  seedVenueWithCourts,
  setOrgPlanBySql,
} from "../helpers";

// The two-person seam: a link one person sends another, and an assignment
// that has to survive the recipient's own calendar. Setup reaches the state
// through the API; every step below that IS the thing under test is tapped,
// typed or submitted, and the system's own record — or the OTHER person's
// screen — is read back after it.
//
// task-5-brief.md carried two controller amendments that override the steps
// below them: AMENDMENT A rewrote Step 4's apply assertion (the brief's
// `toBeEnabled()` is wrong against a CAPPED official — see the comment at that
// call site) and added a `test.fail()` pin for the behaviour it believed
// correct; AMENDMENT B moves durable-row cleanup into `afterAll` (a Playwright
// TIMEOUT skips `finally` entirely, so a finally-based cleanup leaks on
// exactly the failure most likely to happen).
//
// AMENDMENT A's PIN IS GONE (2026-09-05, owner ruling on measured evidence).
// Finding S4 was filed as an inert seam; a mutation showed the disable is the
// block-conflict branch working, and the pin — which expected Apply to enable
// while its own setup guaranteed the block — could never have fired correctly.
// It is replaced by a real, passing end-to-end test on an UNCAPPED official at
// the bottom of this file. AMENDMENT B stands unchanged.
//
// Two more of the brief's own routes were wrong and are fixed here rather
// than reproduced — see the comments at their call sites: `GET
// /api/v1/fixtures/{id}/officials` does not exist (only PATCH is exported),
// and the availability DELETE reads its date from a query param, not a body.

/** Every label below comes from the dictionary, never from an English
 *  literal typed into this file — same reasoning and same `readFileSync`
 *  shape as scheduling-organiser-day.spec.ts (a JSON `import` needs an
 *  import attribute Playwright's loader does not supply). */
const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
/** A key-exists guard: `en[key]!` on a renamed/removed key is `undefined`,
 *  and Playwright locators built from `undefined` (`getByRole({name:
 *  undefined})`, `getByLabel(undefined)`) either match everything or throw
 *  somewhere unhelpful rather than naming the real cause. Called from inside
 *  a test body, never at module scope — a load-time throw here would report
 *  as ZERO collected tests rather than a red one (AGENTS.md's own warning
 *  about the budget assertion applies equally to this). */
function requireEn(key: string): string {
  const v = en[key];
  if (v === undefined) throw new Error(`ui.json is missing key "${key}" this spec depends on`);
  return v;
}

/**
 * THE BUDGET, derived from named constants rather than a flat literal
 * (AGENTS.md §20) — asserted against the 90s ceiling as the test's FIRST
 * ACT, not at module scope.
 *
 * Unlike scheduling-organiser-day.spec.ts this walkthrough never calls the
 * auto-solver (every fixture here is scheduled by a direct PATCH — there is
 * no "propose a board" step, only "propose officials", which is a pure
 * in-memory computation with no solver wall), so there is no SOLVE_MS
 * component. What this spec pays instead is a SECOND browser identity and a
 * lot more discrete round trips than a first pass estimated: two people,
 * two logins' worth of navigation, a directory create-then-invite (two
 * separate writes, not one), a claim, two SEPARATE full navigations back to
 * the officials tab, and a direct DB read for `fixture_officials.id`
 * (`fixtureOfficialRowId`) alongside every `expect.poll` re-read. Counted
 * plainly rather than bucketed into 6 macro steps (a first pass at that
 * granularity underran and this test actually timed out at 50_000ms on this
 * machine, mid-run, screenshot-confirmed past the claim/accept/manual-assign
 * steps and into the blackout-day assign): fill/click/select ×14, `expect.
 * poll` ×5, full navigations ×6. `loginUi` (helpers.ts) separately waits up
 * to its OWN internal 20_000ms for the post-login redirect to land
 * (helpers.ts:281-284) — cited here rather than guessed, so a change to that
 * constant moves this budget with it, and is on top of (not instead of) the
 * per-step count since it is real wall-clock the other steps do not cover.
 */
const STEPS = 14 + 5 + 6; // fill/click/select + expect.poll + full navigations
const PER_STEP_MS = 2_500;
const CLAIM_FLOW_MS = 20_000;
const TEST_BUDGET_MS = STEPS * PER_STEP_MS + CLAIM_FLOW_MS;
const HARD_BUDGET_MS = 90_000;
test.setTimeout(TEST_BUDGET_MS);

const FINAL_WIDTHS = [1280, 768, 320];

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A fresh org flipped to Pro Plus and activated — `officials.auto` (propose)
 *  is gated there since V290, same convention schedule-panels.spec.ts's
 *  PROMPT-22/#448 tests use: a brand-new org has no cached entitlements, so
 *  flipping it by id can never race the 5-minute entitlement cache a shared
 *  org's sibling tests might have already primed.
 *
 *  `label` deliberately stays SHORT and the name carries no extra random
 *  suffix (TAG alone is unique enough — every other org name in this file
 *  and in scheduling-organiser-day.spec.ts gets by on TAG alone). FINDING:
 *  `nav.tsx`'s org chip (`{activeOrg.name}`, line ~115) renders the org name
 *  with no `truncate`/`max-w`, and `logout-button.tsx`'s "Sign out" is
 *  `shrink-0` — a long enough org name pushes it off-screen at 768px. A
 *  first attempt at this file used `"Officials Handoff ${TAG}-${random}"`
 *  (~32 chars) and reproducibly failed the 768px scroll gate on exactly that
 *  button; this is a real, pre-existing nav responsiveness gap, unrelated to
 *  officials or this feature, and out of this task's scope to fix (worth a
 *  separate finding) — worked around here by simply not typing a long org
 *  name into the walkthrough this task is supposed to be testing. */
// RENAMED from `freshProPlusOrg` when entitlements v18 landed: V393 deleted the
// `pro_plus` plan outright, so `setOrgPlanBySql` no longer accepts that key and
// this file stopped compiling the moment the two branches met. `pro` is the top
// SELF-SERVE plan now — `enterprise` exists but is `is_public = false`, the
// Contact-us tier, and is not what a walkthrough should be exercising. Pro grants
// `officials.auto`, which is what this spec is actually about.
async function freshProOrg(request: APIRequestContext, label: string): Promise<string> {
  const org = await apiJson<{ id: string }>(request, "/api/orgs", "POST", {
    name: `${label} ${TAG}`,
  });
  if (!org.data) throw new Error(`org create → ${org.status} ${JSON.stringify(org.error)}`);
  await setOrgPlanBySql({ orgId: org.data.id }, "pro");
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: org.data.id });
  if (activated.status >= 300) throw new Error(`org activate → ${activated.status}`);
  return org.data.id;
}

async function goTab(page: Page, path: string, tab: string): Promise<void> {
  await page.goto(`${path}?tab=${tab}`);
  await expect(page.getByRole("main")).toBeVisible();
}

/**
 * Point a CLEANUP hook's cookie jar at the org this spec created, before it
 * reads or writes anything.
 *
 * Every hook gets its OWN `request` context, built from the config's on-disk
 * `storageState` (Playwright 1.61, `index.js:176`) — so an `afterAll`'s jar
 * has never seen the org `beforeAll` created. Its `seazn_org` cookie is
 * whatever the shared auth-setup account was left holding, and `requireAuth`
 * resolves `auth.orgId` from that cookie alone (`resolveActiveOrg`,
 * lib/auth.ts:183-193).
 *
 * MEASURED against this build rather than reasoned, because the two officials
 * routes do NOT agree and the difference decides what is broken:
 *
 *  - `GET /api/v1/officials` is `requireAuth` (officials/route.ts:7) — the
 *    ACTIVE-ORG COOKIE. Replayed with the stored jar against a foreign org's
 *    official, it returns `[]`. So `resolveOfficialIdByName`, which is built
 *    on that list, could never resolve an id, and every `stillThere` check
 *    built on it was vacuous — "not in the list" for the wrong reason, read
 *    back as proof a delete had taken.
 *  - `DELETE /api/v1/officials/{id}` is `requireResourceAuth`
 *    (officials/[id]/route.ts:35 → `resourceOrg`), which re-pins auth to the
 *    RESOURCE's own org. Replayed the same way it returned `HTTP 200
 *    {"deleted": true}` and the row really went. That is why nothing has been
 *    observed leaking: the delete never needed the cookie. The leak is real
 *    only on the path the fallback exists for — the closure's `officialId`
 *    still empty because the test died between the write and the response —
 *    and on that path the fallback was dead code.
 *
 * Logged, never thrown: an `afterAll` that throws masks the test's own
 * failure, which is what the next person actually needs to read. But never
 * silent either — a cleanup that cannot activate cannot verify itself, and
 * that is precisely the "silently no-ops" shape this fixes.
 */
async function activateOrgForCleanup(
  request: APIRequestContext,
  orgId: string,
  label: string,
): Promise<boolean> {
  const prefix = `[scheduling-officials-handoff] ${label} cleanup`;
  const consequence =
    "every read below is against the WRONG TENANT: name resolution cannot resolve and the " +
    "read-back verifications are vacuous.";
  if (!orgId) {
    console.error(`${prefix} could not activate an org — orgId was never resolved; ${consequence}`);
    return false;
  }
  try {
    const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: orgId });
    if (activated.status >= 300) {
      console.error(
        `${prefix} could not activate org ${orgId} — POST /api/orgs/active → ${activated.status} ` +
          `${JSON.stringify(activated.error ?? {})}; ${consequence}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${prefix} org activation THREW: ${String(err)}; ${consequence}`);
    return false;
  }
}

/** Resolve an official's id by its (unique, TAG-suffixed) display name —
 *  the afterAll fallback for AMENDMENT B's refinement below: cleanup must be
 *  ARMED BEFORE the write, not after, because a crash between "the write
 *  landed" and "the flag got set" would otherwise leak the row with the flag
 *  still false. Arming early means the flag can go true before `officialId`
 *  itself is known (the id only exists once the create round-trip returns),
 *  so afterAll re-resolves it by name instead of trusting a possibly-still-
 *  empty closure variable. Swallows its own errors — this is cleanup, not a
 *  fact the caller should throw on.
 *
 *  ONLY MEANINGFUL AFTER `activateOrgForCleanup`: `GET /api/v1/officials` is
 *  `requireAuth`, so it answers from the ACTIVE-ORG COOKIE. Called from an
 *  un-activated hook it reads `[]` and this returns `null` every time — the
 *  fallback was dead code until the activation above it landed, proven by
 *  forcing this path with the activation removed (both officials leaked, and
 *  the run still reported 4 passed) and then restored (both deleted). */
async function resolveOfficialIdByName(request: APIRequestContext, name: string): Promise<string | null> {
  try {
    const { data } = await apiJson<{ id: string; display_name: string }[]>(request, "/api/v1/officials");
    return data?.find((o) => o.display_name === name)?.id ?? null;
  } catch {
    return null;
  }
}

/** A fixture's officials cache, read the way it actually exists on the wire.
 *  ROUTE FIX: the brief polls `GET /api/v1/fixtures/{id}/officials`, which
 *  405s — `fixtures/[id]/officials/route.ts` exports only PATCH. `GET
 *  /api/v1/fixtures/{id}` carries the same `officials` jsonb cache
 *  (`getFixture`, usecases/fixtures.ts:44-48), refreshed by both the auto
 *  apply and the manual PATCH (`refreshOfficialsCache`, officials.ts:698-724),
 *  so this is the real read-back for both. Status is checked explicitly —
 *  `apiJson` never throws on non-2xx, so a bare `.catch` here would make a
 *  wrong-route 404/405 indistinguishable from "no officials yet". */
async function fixtureOfficials(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ official_id: string; response?: string | null }[]> {
  const { status, data } = await apiJson<{ officials: { official_id: string; response?: string | null }[] }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  if (status !== 200) throw new Error(`GET /api/v1/fixtures/${fixtureId} → ${status}`);
  return data?.officials ?? [];
}

/**
 * `fixture_officials.id` — the surrogate row id `/me`'s card is keyed on
 * (`data-fixture-official-id`, officiating-lane.tsx:272), added by a later
 * migration (V294__official_marks_reports.sql:23) on top of the table's
 * original composite PK (`fixture_id, role_key, official_id`,
 * V243__officials.sql:28). No read route exposes it: `GET /api/v1/fixtures/
 * {id}`'s `officials` jsonb cache carries official_id/name/role/response but
 * not this row's own id (`refreshOfficialsCache`, officials.ts:698-724 never
 * selects `fo.id`). Without resolving it, scoping the accept click to "the
 * card for THIS assignment" is impossible and a bare `.first()` on a
 * repeated `me-official-card` picks whichever one happens to render first —
 * it would keep passing even if the assignment this walkthrough just made
 * never showed up at all. Same lightweight one-shot `postgres` client shape
 * helpers.ts's own (module-private) `withDb` uses, kept local to this file
 * since only this spec needs it.
 */
async function fixtureOfficialRowId(fixtureId: string, officialId: string, roleKey = "referee"): Promise<string> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required to resolve fixture_officials.id in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    const rows = await sql<{ id: string }[]>`
      select id from fixture_officials
      where fixture_id = ${fixtureId} and official_id = ${officialId} and role_key = ${roleKey}`;
    if (!rows[0]) {
      throw new Error(
        `no fixture_officials row for fixture ${fixtureId}, official ${officialId}, role "${roleKey}"`,
      );
    }
    return rows[0].id;
  } finally {
    await sql.end();
  }
}

// ============================================================================
// The main walkthrough: invite, claim, blackout, propose (disabled — S4),
// manual assign, accept, and the blackout collision.
// ============================================================================

test.describe("the officials handoff, both people driven", () => {
  let orgId = "";
  let divisionId = "";
  let base = "";
  let courtId = "";
  let fixtureA = ""; // DAY_A 09:00 — opens unassigned, manually assigned Step 4
  let fixtureB = ""; // DAY_A 13:00 — exists only to force the max_per_day conflict
  let fixtureC = ""; // BLACKOUT_DATE 09:00 — the collision target, Step 5

  let officialCtx: BrowserContext;
  let officialPage: Page;

  const officialName = `Official ${TAG}`;
  const officialEmail = `e2e-official-handoff-${TAG}@example.com`;
  let officialId = "";

  const DAY_A = ymd(Date.now() + 20 * 86_400_000);
  const BLACKOUT_DATE = ymd(Date.now() + 25 * 86_400_000);

  // Durable-row cleanup flags (AMENDMENT B) — set only when the write
  // actually succeeded, never inferred from a constant being non-empty.
  let officialWritten = false;
  let blackoutWritten = false;

  test.beforeAll(async ({ browser, request }) => {
    // Step 1: a second identity that must NOT inherit the organiser's
    // session. A bare `browser.newContext()` inherits the signed-in state in
    // this repo (AGENTS.md/task brief) — `storageState: undefined` is load-
    // bearing, not decorative.
    officialCtx = await browser.newContext({ storageState: undefined });
    officialPage = await officialCtx.newPage();

    orgId = await freshProOrg(request, "OH");

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `Officials Handoff ${TAG}`,
      visibility: "public",
      ends_on: "2030-12-31",
    });
    if (!comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);

    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data.id}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    if (!div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
    divisionId = div.data.id;

    const entrants = await addEntrantsViaApi(request, divisionId, [`E1 ${TAG}`, `E2 ${TAG}`, `E3 ${TAG}`]);
    if (entrants.status >= 300) throw new Error(`entrants → ${entrants.status}`);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId);
    // Three entrants, round robin: one fixture per unordered pair.
    expect(fixtureIds).toHaveLength(3);
    [fixtureA, fixtureB, fixtureC] = fixtureIds;

    const { courts } = await seedVenueWithCourts(request, ["Court 1"], { orgId });
    courtId = courts[0]!.id;

    for (const [fixtureId, at] of [
      [fixtureA, `${DAY_A}T09:00:00.000Z`],
      [fixtureB, `${DAY_A}T13:00:00.000Z`],
      [fixtureC, `${BLACKOUT_DATE}T09:00:00.000Z`],
    ] as const) {
      const patched = await apiJson(request, `/api/v1/fixtures/${fixtureId}`, "PATCH", {
        scheduled_at: at,
        court_id: courtId,
      });
      if (patched.status >= 300) {
        throw new Error(`schedule fixture ${fixtureId} → ${patched.status} ${JSON.stringify(patched.error)}`);
      }
    }
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    if (started.status >= 300) throw new Error(`division start → ${started.status}`);

    base = `${await divisionPath(request, divisionId)}/schedule`;
  });

  test.afterAll(async ({ request }) => {
    // AMENDMENT B: durable rows this spec writes on a leg that shares one
    // prod server across `--workers=3` must be undone here, not in
    // try/finally — a Playwright TIMEOUT skips `finally` entirely, so a
    // finally-based cleanup leaks on exactly the failure most likely to
    // happen. Idempotent, and each block swallows its own errors rather than
    // throwing (an afterAll that throws would mask the test's own failure,
    // which is what the next person actually needs to read) while still
    // verifying itself by re-reading state and logging loudly if the write
    // did not take — a bare `.catch(() => {})` would make a 403/422/500
    // indistinguishable from success (apiJson never throws on non-2xx).
    //
    // CONTROLLER REFINEMENT to AMENDMENT B: the flags below are armed BEFORE
    // their write is attempted (see the test body), not after it succeeds —
    // a write that reaches the server but whose response is lost, times out,
    // or the test dies between the call and the flag would otherwise leak
    // silently with the flag still false. Arming early means `officialId`
    // itself may still be empty here (it is only known once the create
    // round-trip returns), so it is re-resolved by its known, unique,
    // TAG-suffixed name rather than trusted from the closure.
    //
    // ACTIVATE FIRST. This hook's jar has never seen the org `beforeAll`
    // created, and the name resolution below reads a route that answers from
    // the ACTIVE-ORG COOKIE — so without this it reads an empty list, can
    // never resolve, and both read-back verifications below are vacuous.
    // Full, measured mechanism in `activateOrgForCleanup`.
    const activated = await activateOrgForCleanup(request, orgId, "main");
    const resolvedOfficialId = officialId || (officialWritten ? await resolveOfficialIdByName(request, officialName) : null);
    if (blackoutWritten && resolvedOfficialId) {
      // ROUTE FIX: the DELETE handler reads the date from a QUERY PARAM
      // (`officials/[id]/availability/route.ts:38-44`), not a JSON body — the
      // brief's `apiJson(..., "DELETE", { date: BLACKOUT_DATE })` third
      // argument is a request body and would never reach the handler.
      try {
        const del = await apiJson(
          request,
          `/api/v1/officials/${resolvedOfficialId}/availability?date=${BLACKOUT_DATE}`,
          "DELETE",
        );
        const after = await apiJson<{ date: string }[]>(
          request,
          `/api/v1/officials/${resolvedOfficialId}/availability`,
        );
        const stillThere = (after.data ?? []).some((r) => r.date === BLACKOUT_DATE);
        if (del.status >= 300 || stillThere) {
          console.error(
            `[scheduling-officials-handoff] blackout cleanup FAILED for official ${resolvedOfficialId} — ` +
              `DELETE → ${del.status} ${JSON.stringify(del.error ?? {})}, read-back still has it: ${stillThere}.`,
          );
        }
      } catch (err) {
        console.error(`[scheduling-officials-handoff] blackout cleanup THREW: ${String(err)}`);
      }
    }
    if (officialWritten && resolvedOfficialId) {
      // `fixture_officials.official_id` and `official_availability.official_id`
      // are both `references officials(id) on delete cascade`
      // (db/migration/jul3/V243__officials.sql, db/migration/deltas/
      // V284__official_onboarding.sql) — one delete here also removes the
      // Step 4/5 assignment rows the brief names as a separate table to clean.
      try {
        const del = await apiJson(request, `/api/v1/officials/${resolvedOfficialId}`, "DELETE");
        const list = await apiJson<{ id: string }[]>(request, "/api/v1/officials");
        const stillThere = (list.data ?? []).some((o) => o.id === resolvedOfficialId);
        if (del.status >= 300 || stillThere) {
          console.error(
            `[scheduling-officials-handoff] official cleanup FAILED for ${resolvedOfficialId} — ` +
              `DELETE → ${del.status} ${JSON.stringify(del.error ?? {})}, still listed: ${stillThere}.`,
          );
        }
      } catch (err) {
        console.error(`[scheduling-officials-handoff] official cleanup THREW: ${String(err)}`);
      }
    } else if (officialWritten && !resolvedOfficialId) {
      // "could not look" and "nothing was there" are DIFFERENT FACTS and the
      // log must not merge them. Unresolved after a FAILED activation means
      // the lookup was against the wrong tenant and says nothing about whether
      // a row exists — assume it leaked. Unresolved after a good activation is
      // the real "the create failed, nothing to clean up".
      console.error(
        activated
          ? `[scheduling-officials-handoff] official cleanup SKIPPED — write was armed but no official ` +
              `named "${officialName}" could be resolved against the CORRECT org ${orgId} (the create ` +
              `genuinely failed; nothing to clean up).`
          : `[scheduling-officials-handoff] official cleanup COULD NOT LOOK — org ${orgId} was never ` +
              `activated, so the lookup for "${officialName}" ran against the wrong tenant and proves ` +
              `nothing. ASSUME THE ROW LEAKED.`,
      );
    }
    await officialPage?.close();
    await officialCtx?.close();
  });

  test("the officials handoff, both people driven", async ({ page, request }, testInfo) => {
    // ---------------------------------------------------------------- 0
    expect(
      TEST_BUDGET_MS,
      `derived budget ${TEST_BUDGET_MS}ms = ${STEPS} steps x ${PER_STEP_MS}ms + ${CLAIM_FLOW_MS}ms claim flow, ` +
        `over the ${HARD_BUDGET_MS}ms this leg is allowed.`,
    ).toBeLessThanOrEqual(HARD_BUDGET_MS);

    // ---------------------------------------------------------------- 1b
    // FINDING (not in the brief): TWO separate cookie jars are in play, not
    // one. `test.beforeAll`'s `request` is a fixture instance scoped to that
    // hook, torn down once it returns, so activating there never reaches the
    // test body at all. And even inside the test body, the bare `request`
    // fixture is its OWN `APIRequestContext` — a different cookie jar than
    // `page.context()` — the two merely started from the same on-disk
    // storageState. Confirmed empirically: activating via `request` alone
    // left `request`'s own `GET /api/v1/officials` blind to the official
    // `page`'s UI click had just created, because that click's POST rode
    // `page`'s cookies, still pointed at whatever org the shared walkthrough
    // account's session held — `requireAuth`'s `auth.orgId` resolves from
    // the ACTIVE-ORG COOKIE (`resolveActiveOrg`, lib/auth.ts:183-193), never
    // from a division id in the URL, so a mismatch here 404s "Propose"
    // silently and the official lands in the wrong org entirely. Both jars
    // are activated explicitly rather than assuming either one.
    const reactivated = await apiJson(request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(reactivated.status, `org re-activate (request) → ${reactivated.status}`).toBeLessThan(300);
    const reactivatedPage = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(reactivatedPage.status, `org re-activate (page) → ${reactivatedPage.status}`).toBeLessThan(300);

    // ---------------------------------------------------------------- 2
    // Invite, through the directory UI, and follow the claim link OFF THE
    // PAGE. Constructing it is how a dead link stays green — the whole point
    // of this step is that the link resolves.
    //
    // UI SHAPE FIX: the brief's pseudocode is one combined "fill name+email,
    // one Save" form. The real directory (officials-directory-panel.tsx +
    // OfficialInviteForm in officials-shared.tsx) is two separate actions —
    // "Add official" (name only) creates the row, then a per-row "Invite"
    // reveals the email field — and on send failure (this env's blank
    // RESEND_API_KEY, same as officials-directory.spec.ts) the claim link
    // renders as `<code>{claim_url}</code>` plain text, never an anchor, so
    // `getByRole("link", ...)` as the brief has it would never resolve.
    await page.goto("/directory?tab=officials");
    await page.getByLabel(requireEn("officials.name"), { exact: true }).fill(officialName);
    // CONTROLLER REFINEMENT to AMENDMENT B: armed BEFORE the click, not after
    // it succeeds — the write is the click itself, and a crash anywhere
    // between here and resolving `officialId` below (a lost response, the
    // test dying mid-poll) must still leave afterAll knowing there may be a
    // row to undo. `officialId` is not known yet at this point; afterAll
    // re-resolves it by the well-known `officialName` when its own closure
    // copy is still empty.
    officialWritten = true;
    await page.getByRole("button", { name: requireEn("officials.add"), exact: true }).click();
    const row = page.locator("li").filter({ hasText: officialName });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Resolve the id the UI just created — needed below for the max_per_day
    // fixture (a test-setup mechanic, not something the walkthrough is
    // testing), the availability poll, and afterAll cleanup.
    const created = await apiJson<{ id: string; display_name: string }[]>(request, "/api/v1/officials");
    const createdRow = created.data?.find((o) => o.display_name === officialName);
    expect(createdRow, `no official named "${officialName}" in GET /api/v1/officials`).toBeTruthy();
    officialId = createdRow!.id;

    // Deterministic S4 reproduction (see report/brief comments): one
    // official capped at 1/day, two fixtures on the SAME day — the day cap
    // (packages/engine/src/officials/assign.ts:228-231) guarantees the
    // second one gets `role_unfilled` (severity "block"), which is what
    // disables Apply below. Not a UI action — a fixture for the scenario.
    const capped = await apiJson(request, `/api/v1/officials/${officialId}`, "PATCH", { max_per_day: 1 });
    expect(capped.status, `PATCH officials max_per_day → ${capped.status}`).toBeLessThan(300);

    await row.getByRole("button", { name: requireEn("officials.invite"), exact: true }).click();
    await row.getByLabel(requireEn("officials.inviteEmail"), { exact: true }).fill(officialEmail);
    await row.getByRole("button", { name: requireEn("officials.inviteSend"), exact: true }).click();
    // This env's RESEND_API_KEY is blank — send always fails, so the
    // one-time claim link is the only path to the official.
    await expect(row.getByText(requireEn("officials.inviteEmailFailed"))).toBeVisible({ timeout: 20_000 });

    const claimCode = row.locator("code");
    await expect(claimCode).toBeVisible();
    const claimUrl = (await claimCode.textContent())?.trim();
    expect(claimUrl, "the directory emitted no claim link").toBeTruthy();
    // `claim_url` is ABSOLUTE, and its origin comes from `baseUrl()`
    // (lib/oauth.ts:19-23), which prefers `OAUTH_BASE_URL` /
    // `NEXT_PUBLIC_BASE_URL` over the request's own origin. So a misconfigured
    // base emits a link pointing at a DIFFERENT deployment — and a bare
    // `goto(claimUrl)` would follow it, silently driving that one instead of
    // the app under test. Every later claim to be reading "the official's
    // screen" would then be about somebody else's server, and this whole step
    // exists to prove the link RESOLVES.
    //
    // Two guards, because they catch different failures: the origin is pinned
    // (a misconfigured base reds here, naming the two env vars), and the
    // navigation is rebuilt on a PATH so it cannot wander off this origin even
    // if that assertion is later relaxed. Relative `goto` resolves against the
    // project's `baseURL` — the same way `officialPage.goto("/me")` below and
    // `loginUi`'s own path navigation already do.
    const claimTarget = new URL(claimUrl!);
    const appOrigin = new URL(page.url()).origin;
    expect(
      claimTarget.origin,
      `the claim link points at ${claimTarget.origin} but this run drives ${appOrigin} — ` +
        `an official would be sent to the wrong deployment. Check OAUTH_BASE_URL / NEXT_PUBLIC_BASE_URL.`,
    ).toBe(appOrigin);
    const claimPath = `${claimTarget.pathname}${claimTarget.search}`;

    // Same claim-rail sequence officials-directory.spec.ts's own
    // officiating describe block already exercises: visit anonymously, log
    // in (auto-creates the account), then claim by clicking "This is me".
    // "This is me" has no dictionary key at all — it's a hardcoded literal in
    // claim-accept.tsx, not `msg(...)` — so it cannot be sourced from `en`;
    // this reuses the same regex the existing spec already established.
    await officialPage.goto(claimPath);
    await expect(officialPage.locator("main .card").first()).toBeVisible();
    // `loginUi` auto-creates the account (unknown email) and waits up to its
    // own 20_000ms for the post-login redirect to land — the constant this
    // spec's CLAIM_FLOW_MS budget cites.
    //
    // `next` IS PASSED, and it is not cosmetic. `loginUi`'s own docblock
    // (helpers.ts:260-264): a bare login runs the org-resolution branch, which
    // auto-provisions "My organization" for a user who belongs to none — so
    // omitting it leaked one user AND one org per run, and quietly turned this
    // official into an organiser, which is the opposite of the identity this
    // step is about. Every real entry point that logs someone in on their way
    // somewhere (claim, join, invite) carries one; the claim link is exactly
    // such an entry point, so passing it reproduces the REAL flow rather than
    // a leakier approximation of it.
    //
    // The explicit re-navigation below is kept: it costs one navigation, and
    // it makes the claim page's arrival independent of the redirect working.
    await loginUi(officialPage, officialEmail, claimPath);
    await officialPage.goto(claimPath);
    await officialPage.getByRole("button", { name: /This is me/ }).click();
    await officialPage.waitForURL(/\/me\?claimed=1/);

    // ---------------------------------------------------------------- 3
    // The official blacks out a day, from their own screen. First assertion
    // anywhere on the G9 read-back route from a browser.
    await officialPage.goto("/me");
    const blackoutDate = officialPage.getByTestId("official-blackout-date");
    const addBlackout = officialPage.getByTestId("official-blackout-add");

    // THE HYDRATION RACE, and the measured cause of an 82_500ms stall this
    // spec really hit — not bad luck and not a tight budget.
    //
    // The date input is CONTROLLED (`value={date}`,
    // components/me/officiating-lane.tsx:475) and Add is
    // `disabled={busy || !date}` (:486). `page.goto` resolves on `load`, which
    // is BEFORE React attaches `onChange`. A `fill()` that lands in that
    // window writes the DOM value with nothing listening; hydration then
    // re-renders `value={date}` with `date` still `""` and wipes it. The click
    // that follows is never REFUSED — `click()` waits for actionability, so it
    // burns the whole test timeout (82_500ms = STEPS 25 x PER_STEP_MS 2_500 +
    // CLAIM_FLOW_MS 20_000, the spec's OWN derived budget, not the 90s
    // ceiling) and then reports whichever `expect.poll` was in flight, which
    // reads as a DATA defect. AGENTS.md §20, and the same class
    // mobile.spec.ts:1738 records for a pre-hydration click.
    //
    // The fill is therefore RETRIED until React's own state proves it took.
    // A bare assertion could only relabel this, not fix it: once hydration has
    // discarded a fill, no amount of waiting brings the value back — it has to
    // be typed again on the hydrated input. Errors are swallowed per attempt
    // (an element can detach mid-hydration) exactly as mobile.spec.ts does.
    await expect
      .poll(
        async () => {
          await blackoutDate.fill(BLACKOUT_DATE, { timeout: 5_000 }).catch(() => undefined);
          return await addBlackout.isEnabled().catch(() => false);
        },
        {
          timeout: 20_000,
          message:
            "the blackout date must reach React's state — Add is `disabled={busy || !date}`, so it " +
            "stays dead while `date` is empty, however many times the DOM value is set",
        },
      )
      .toBe(true);
    // The two facts the click depends on, pinned separately from the retry
    // above so a regression says WHICH half went: the value survived the
    // render, and the control it gates is live.
    await expect(blackoutDate).toHaveValue(BLACKOUT_DATE);
    await expect(addBlackout).toBeEnabled();

    // CONTROLLER REFINEMENT to AMENDMENT B: armed BEFORE the click that fires
    // the write, not after — verified for real by the poll immediately below.
    blackoutWritten = true;
    await addBlackout.click();
    await expect
      .poll(async () => {
        const { data } = await apiJson<{ date: string }[]>(
          request,
          `/api/v1/officials/${officialId}/availability`,
        );
        return data?.map((r) => r.date) ?? [];
      })
      .toContain(BLACKOUT_DATE);

    // ---------------------------------------------------------------- 4
    // Propose, then the AMENDMENT A encoding of Step 4's apply assertion.
    await goTab(page, base, "officials");
    await page.getByTestId("officials-propose").click();
    const apply = page.getByTestId("officials-apply");
    await expect(apply).toBeVisible({ timeout: 20_000 });
    // THIS ASSERTS THE BLOCK-CONFLICT BRANCH WORKING — it is not a defect
    // frozen as expected behaviour, and it used to read as one.
    //
    // The `max_per_day: 1` cap above and two fixtures on the SAME day
    // guarantee that the engine cannot fill the second slot, so it emits
    // `role_unfilled` at severity "block"
    // (packages/engine/src/officials/assign.ts:228-231, :270-271), and
    // `disabled={busy || conflicts.some(block)}` (officials-panel.tsx:316)
    // correctly refuses the apply. A draft that cannot be honoured SHOULD NOT
    // be applyable; asserting that is asserting the product working.
    //
    // Finding S4 originally read this as an inert seam ("a control that
    // renders, names a real number, and never fires") and was filed High. A
    // mutation settled it: delete the cap and Apply comes back ENABLED, and
    // the whole seam then drives end to end — which the uncapped test at the
    // bottom of this file now does for real, propose → apply → read the
    // `fixture_officials` rows back. S4 is DOWNGRADED to Medium and restated
    // as "a blocked auto-draft gives the organiser no reason": the disabled
    // button carries no title, no aria-disabled and no message, and the only
    // thing on screen is the raw engine `kind`. That residual is a copy/a11y
    // gap, not a dead seam, and nothing here pins it as correct.
    //
    // The brief's own Step 4 asserted `toBeEnabled()`, which is wrong under a
    // cap and would fail.
    //
    // `toBeDisabled()` ALONE CANNOT SAY WHY. The predicate is
    // `busy || proposal.conflicts.some((c) => c.severity === "block")`
    // (officials-panel.tsx:316), so an in-flight request satisfies it just as
    // well as the conflict this step claims — and a comment asserting the
    // second while the test only witnesses the disjunction is how a test comes
    // to lie about what it pins. Two companions make it discriminate:
    //
    //  - PROPOSE shares `busy` (officials-panel.tsx:296) and NOTHING else. A
    //    live Propose beside a dead Apply is only possible when the second
    //    disjunct is what is holding Apply down.
    //  - the block conflict names itself on screen. `role_unfilled` is the
    //    engine's own `kind` for the day-cap refusal
    //    (packages/engine/src/officials/assign.ts:270-271, `severity: "block"`),
    //    rendered verbatim into the conflict list at officials-panel.tsx:351.
    //
    // MUTATION-CHECKED: delete the `max_per_day: 1` PATCH above and this pair
    // reds — no cap, no `role_unfilled`, and Apply comes back ENABLED.
    await expect(page.getByTestId("officials-propose")).toBeEnabled();
    await expect(apply).toBeDisabled();
    await expect(page.getByText(/role_unfilled/).first()).toBeVisible();

    // The manual assign. Pin what the control OPENS AT and what was chosen —
    // reachability is satisfied by any value, and a bare "the select is
    // visible" proves nothing about it.
    const select = page.getByTestId("officials-assign-select").first();
    const fixtureId = await select.getAttribute("data-fixture-id");
    expect(fixtureId).toBe(fixtureA); // the earliest-scheduled fixture, deterministically
    await expect(select).toHaveValue(""); // opens unassigned — propose never persists
    await select.selectOption({ label: officialName });

    await expect
      .poll(async () => (await fixtureOfficials(request, fixtureId!)).map((o) => o.official_id))
      .toContain(officialId);

    // ---------------------------------------------------------------- 5
    // The official accepts, and the blackout collision is surfaced. Scoped
    // to the SPECIFIC card for this assignment, not a bare `.first()` — the
    // card's real identity is `data-fixture-official-id`
    // (scheduling-testid-contract.test.tsx:97's IDENTITY map, "review round
    // 2"). That same file's OWN "review round 1" comment (line 60) still
    // names `data-fixture-id` for this card — stale: that attribute does not
    // exist on `me-official-card` at all; it is a DIFFERENT attribute
    // officials-panel.tsx legitimately owns for a real fixture id. An
    // unscoped `.first()` would pass on whichever card happens to render
    // first, including a wrong one, or none of them.
    const foId = await fixtureOfficialRowId(fixtureA, officialId);
    await officialPage.goto("/me");
    const acceptCard = officialPage
      .getByTestId("me-official-card")
      .and(officialPage.locator(`[data-fixture-official-id="${foId}"]`));
    await acceptCard.getByTestId("me-official-accept").click();
    await expect
      .poll(async () => (await fixtureOfficials(request, fixtureA)).find((o) => o.official_id === officialId)?.response)
      .toBe("accepted");

    // Now assign the same person on the day they blacked out. The product
    // must say so rather than accept silently. `selectOption({label})` is
    // NOT used here on purpose — the option for an unavailable official
    // renders with an " — unavailable" suffix appended to the same name
    // (officials-panel.tsx:559-563), so an exact-label match would never
    // resolve on this row; selecting by the option's VALUE (the official id)
    // is what the control actually keys on.
    await page.goto(`${base}?tab=officials`);
    const blackoutSelect = page
      .getByTestId("officials-assign-select")
      .and(page.locator(`[data-fixture-id="${fixtureC}"]`));
    await expect(blackoutSelect).toHaveValue(""); // opens unassigned, same as fixtureA did
    await blackoutSelect.selectOption(officialId);
    await expect
      .poll(async () => (await fixtureOfficials(request, fixtureC)).map((o) => o.official_id))
      .toContain(officialId);

    const blackoutRow = page.locator("tr").filter({ has: page.locator(`[data-fixture-id="${fixtureC}"]`) });
    await expect(blackoutRow.getByTestId("officials-unavailable-note")).toBeVisible();

    // ---------------------------------------------------------------- 6
    // Screenshots and the scroll gate, at all three standing widths.
    // `screenshotAtWidths` only captures — it restores the ORIGINAL viewport
    // afterward and asserts nothing — so the scroll gate is run per width
    // here (like scheduling-organiser-day.spec.ts), not once at whatever
    // viewport the capture happened to leave behind (the brief's own
    // single-trailing-call order would only ever check ONE width).
    for (const width of FINAL_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
    }
    await screenshotAtWidths(page, testInfo, "officials-handoff-final", FINAL_WIDTHS);
  });
});

// ============================================================================
// The officials auto-draft, driven END TO END on its own isolated org,
// division, fixtures and official — no dependence on the main walkthrough's
// leftover state.
//
// THIS REPLACES A `test.fail()` PIN, and the reason is worth keeping.
// AMENDMENT A added that pin for finding S4, filed High as an inert seam: "a
// control that renders, names a real number, and never fires". Its author
// eliminated the freeze, division status, permissions and entitlements, and
// wrote as their own strongest-argument-against that the button might be
// "correctly disabled for a reason I did not eliminate — a per-role
// requirement, a minimum roster size, a stage-status precondition. If so, the
// finding shrinks."
//
// A mutation supplied exactly that missing cause: DELETE the `max_per_day: 1`
// PATCH and Apply comes back ENABLED (measured 2026-09-05 — the main
// walkthrough's `toBeDisabled()` reds with "Received: enabled"). So the
// disable is the block-conflict branch working as designed
// (officials-panel.tsx:316), not a dead seam. Owner ruling on that evidence:
// S4 is DOWNGRADED to Medium, and the residual is that a blocked draft gives
// the organiser no reason — no title, no aria-disabled, no message.
//
// The pin had to go, and not by deletion alone: it expected Apply to ENABLE
// while its own `beforeAll` capped the official at 1/day and so guaranteed the
// block. It could never have fired correctly — permanently red even against a
// perfect product, which proves less than no test at all. What stands here
// instead is S4's OWN recommendation: propose -> apply -> read the resulting
// `fixture_officials` rows back, so the seam is proven by its real producer
// and consumer rather than by a fixture at both ends.
//
// The ONE difference from the pin is the missing cap. Everything else — org,
// plan, division, two same-day fixtures, one referee — is unchanged, which is
// what makes this test and the main walkthrough's `toBeDisabled()` a matched
// pair: same shape, capped and uncapped, blocked and applied.
// ============================================================================

test.describe("the officials auto-draft applies, and the assignments persist", () => {
  const s4OfficialName = `S4 Ref ${TAG}`;
  let orgId = "";
  let base = "";
  let officialId = "";
  let fixtureA = "";
  let fixtureB = "";
  let officialWritten = false;

  test.beforeAll(async ({ request }) => {
    orgId = await freshProOrg(request, "S4P");
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `S4 Pin ${TAG}`,
      visibility: "public",
      ends_on: "2030-12-31",
    });
    if (!comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data.id}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    if (!div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
    const divisionId = div.data.id;

    const entrants = await addEntrantsViaApi(request, divisionId, [`S1 ${TAG}`, `S2 ${TAG}`, `S3 ${TAG}`]);
    if (entrants.status >= 300) throw new Error(`entrants → ${entrants.status}`);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId);
    expect(fixtureIds).toHaveLength(3);
    fixtureA = fixtureIds[0]!;
    fixtureB = fixtureIds[1]!;

    const { courts } = await seedVenueWithCourts(request, ["Court 1"], { orgId });
    const courtId = courts[0]!.id;
    const day = ymd(Date.now() + 20 * 86_400_000);
    for (const [fixtureId, at] of [
      [fixtureA, `${day}T09:00:00.000Z`],
      [fixtureB, `${day}T13:00:00.000Z`],
    ] as const) {
      const patched = await apiJson(request, `/api/v1/fixtures/${fixtureId}`, "PATCH", {
        scheduled_at: at,
        court_id: courtId,
      });
      if (patched.status >= 300) {
        throw new Error(`schedule fixture ${fixtureId} → ${patched.status} ${JSON.stringify(patched.error)}`);
      }
    }
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    if (started.status >= 300) throw new Error(`division start → ${started.status}`);

    // CONTROLLER REFINEMENT to AMENDMENT B: armed BEFORE issuing the POST,
    // not after it resolves — see the main describe's afterAll comment for
    // the full reasoning. `officialId` is not known until the call returns.
    officialWritten = true;
    // NO `max_per_day`. That is the whole difference from the main
    // walkthrough's capped official, and it is what this test exists to
    // isolate: uncapped, one referee can take both same-day fixtures, the
    // draft carries no `role_unfilled` block, and Apply is live.
    const off = await apiJson<{ id: string }>(request, "/api/v1/officials", "POST", {
      display_name: s4OfficialName,
      role_keys: ["referee"],
    });
    if (!off.data) throw new Error(`official → ${off.status} ${JSON.stringify(off.error)}`);
    officialId = off.data.id;

    base = `${await divisionPath(request, divisionId)}/schedule`;
  });

  test.afterAll(async ({ request }) => {
    // Same idempotent-and-verifying convention as the main describe's
    // afterAll above; see its comments for why (AMENDMENT B), for the
    // controller refinement (armed before the write, resolved by name if
    // the closure's own `officialId` is still empty), and for why this hook
    // must activate the org before it reads anything.
    const activated = await activateOrgForCleanup(request, orgId, "S4-pin");
    const resolvedOfficialId = officialId || (officialWritten ? await resolveOfficialIdByName(request, s4OfficialName) : null);
    if (officialWritten && resolvedOfficialId) {
      try {
        const del = await apiJson(request, `/api/v1/officials/${resolvedOfficialId}`, "DELETE");
        const list = await apiJson<{ id: string }[]>(request, "/api/v1/officials");
        const stillThere = (list.data ?? []).some((o) => o.id === resolvedOfficialId);
        if (del.status >= 300 || stillThere) {
          console.error(
            `[scheduling-officials-handoff] S4-pin official cleanup FAILED for ${resolvedOfficialId} — ` +
              `DELETE → ${del.status} ${JSON.stringify(del.error ?? {})}, still listed: ${stillThere}.`,
          );
        }
      } catch (err) {
        console.error(`[scheduling-officials-handoff] S4-pin official cleanup THREW: ${String(err)}`);
      }
    } else if (officialWritten && !resolvedOfficialId) {
      // Same split as the main describe's afterAll: "could not look" is not
      // "nothing was there".
      console.error(
        activated
          ? `[scheduling-officials-handoff] S4-pin official cleanup SKIPPED — write was armed but no ` +
              `official named "${s4OfficialName}" could be resolved against the CORRECT org ${orgId} ` +
              `(the create genuinely failed; nothing to clean up).`
          : `[scheduling-officials-handoff] S4-pin official cleanup COULD NOT LOOK — org ${orgId} was ` +
              `never activated, so the lookup for "${s4OfficialName}" ran against the wrong tenant and ` +
              `proves nothing. ASSUME THE ROW LEAKED.`,
      );
    }
  });

  test("an uncapped official is proposed, applied and seated on both fixtures", async ({
    page,
    request,
  }) => {
    // A REAL, PASSING test — no `test.fail()`. See the block comment above the
    // describe for why the pin that stood here could never have fired
    // correctly and what replaced it.
    //
    // THE BUDGET, first. `test.setTimeout(TEST_BUDGET_MS)` is module-scoped,
    // so this test runs under the SAME derived clock as the main walkthrough
    // and is equally exposed to it drifting over the 90s ceiling, but it
    // carried no assertion of its own — raising STEPS or PER_STEP_MS would
    // have gone unremarked here.
    expect(
      TEST_BUDGET_MS,
      `derived budget ${TEST_BUDGET_MS}ms = ${STEPS} steps x ${PER_STEP_MS}ms + ${CLAIM_FLOW_MS}ms claim flow, ` +
        `over the ${HARD_BUDGET_MS}ms this leg is allowed.`,
    ).toBeLessThanOrEqual(HARD_BUDGET_MS);

    const apply = page.getByTestId("officials-apply");

    await test.step("setup: propose a draft and reach the Apply control", async () => {
      // See the main describe's test body for why BOTH jars need this: a
      // hook-scoped `beforeAll` `request` never reaches the test body at all,
      // and even here `request` and `page.context()` are separate cookie jars.
      const reactivated = await apiJson(request, "/api/orgs/active", "POST", { org_id: orgId });
      expect(reactivated.status, `org re-activate (request) → ${reactivated.status}`).toBeLessThan(300);
      const reactivatedPage = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
      expect(reactivatedPage.status, `org re-activate (page) → ${reactivatedPage.status}`).toBeLessThan(300);

      await goTab(page, base, "officials");
      await page.getByTestId("officials-propose").click();
      // VISIBLE only. That a draft came back and rendered a control is setup;
      // whether it can be PRESSED, and what pressing it WRITES, is the claim
      // this test makes, and both are asserted outside this step.
      await expect(apply).toBeVisible({ timeout: 20_000 });
    });

    // THE SEAM, driven. Apply is live because nothing blocks it — asserted
    // BEFORE the click, so a future regression that re-disables the button
    // reds here with "not enabled" rather than at a silent read-back.
    await expect(apply).toBeEnabled();
    // The complement of the main walkthrough's assertion, and the reason this
    // pair is a matched set: with no cap there is no block conflict, so the
    // engine's `role_unfilled` row is ABSENT. Without this, "Apply was
    // enabled" could be true for some other reason entirely.
    await expect(page.getByText(/role_unfilled/)).toHaveCount(0);
    await apply.click();

    // THE READ-BACK, from the system's own record rather than the screen that
    // just claimed it. `fixtureOfficials` reads `GET /api/v1/fixtures/{id}`'s
    // `officials` cache, which `refreshOfficialsCache` rebuilds from the
    // `fixture_officials` rows the apply wrote.
    //
    // Pinned by IDENTITY, not by count. `length > 0` is satisfied by any row
    // from any source (AGENTS.md §19 — reachability is satisfied by any
    // value), so it would stay green against an apply that seated the wrong
    // official, or against a leftover assignment this test never made.
    await expect
      .poll(async () => (await fixtureOfficials(request, fixtureA)).map((o) => o.official_id))
      .toContain(officialId);
    // BOTH same-day fixtures, which is the whole point: this is the exact pair
    // the `max_per_day: 1` cap could not cover, so seating both is the direct
    // evidence that the cap — not the seam — was what stopped the capped run.
    await expect
      .poll(async () => (await fixtureOfficials(request, fixtureB)).map((o) => o.official_id))
      .toContain(officialId);

    // And the draft is spent: `setProposal(null)` runs on a successful apply
    // (officials-panel.tsx:331), so the control that fired goes away. This is
    // the on-screen half of "it fired", and it fails against an apply whose
    // POST rejected while the button stayed put.
    await expect(apply).toHaveCount(0);
  });
});
