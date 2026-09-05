import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedMemberIdentity,
  settingsUrl,
} from "../settings-support";
import { apiJson, TAG, setBoolEntitlementOverrideSql, splitOrgIntoOwnGroupSql, setOrgPlanBySql } from "../helpers";

/**
 * W3 Task 3 — the wave's headline findings (register cases 7, 8, 9 and three
 * UI-only gates read end to end and recorded in `_INDEX.md`). Each is a
 * hypothesis until driven; see the per-test comments for what was actually
 * observed versus what the brief assumed.
 *
 * **A correction made against the brief, load-bearing for Case 8**: the task
 * brief said `setEntitlementOverrideSql(orgId, "api.access", 0)` (the INT
 * setter). That is a no-op for this key. `api.access` is a BOOLEAN feature —
 * `db/migration/deltas/V112__entitlements_v2.sql:86-88` seeds it with a
 * `bool_value`/`int_value` pair of `(false, null)` / `(true, null)`, and
 * `hasFeature` (`src/lib/entitlements.ts:454-460`) reads only `bool_value`.
 * `setEntitlementOverrideSql` writes `int_value` alone
 * (`org_entitlement_overrides` gets `int_value = 0`, `bool_value` left NULL),
 * and `resolve()`'s own override merge
 * (`src/lib/entitlements.ts:397-400,416`) treats a null override `bool_value`
 * as NO ANSWER and falls through to the PLAN's `bool_value` — so a Pro org
 * given that override would still read `hasFeature(...) === true`. Verified
 * by reading the resolver, not assumed: `ov.bool_value ?? base?.bool_value ??
 * null` only overrides when the override's own bool is non-null, and `??`
 * does not treat `false` as absent (so the CORRECT call,
 * `setBoolEntitlementOverrideSql(orgId, "api.access", false)`, does take
 * effect — `false ?? true` is `false`). Used throughout below.
 *
 * One org per TEST (`_RULES.md` §5.1) — the shared Pro user's cap is 50, not
 * 5 (`_INDEX.md` "W3 finding 3"), so this is no longer the budget risk W2
 * treated it as. Every seed is released in a `finally`.
 */

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** Copy read from the dictionary the page renders from, never retyped —
 *  this folder's idiom (settings-org-tabs.spec.ts, settings-admin.spec.ts). */
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw;
}

// Budgets derived from what each test actually does (Global Constraint 9 /
// AGENTS.md failure class 20) — a settings navigation is a cold server render;
// nothing here does more than two.
const NAV_MS = 20_000;
const READ_MS = 20_000;
const budget = (navs: number): number => Math.max(30_000, 10_000 + navs * NAV_MS);

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; feature_key?: string };
}

interface OrgListRow {
  id: string;
  branding: { colors?: { primary?: string | null } } | null;
}

/** `GET /api/orgs` is the only read API that returns `branding`
 *  (`/api/orgs/{id}` exports PATCH only — settings-org-tabs.spec.ts's own
 *  `orgRow` comment; re-confirmed here rather than assumed). */
async function orgBranding(
  request: Parameters<typeof apiJson>[0],
  orgId: string,
): Promise<string | null | undefined> {
  const res = await apiJson<OrgListRow[]>(request, "/api/orgs");
  expect(res.status, "GET /api/orgs").toBe(200);
  const row = res.data?.find((o) => o.id === orgId);
  expect(row, `GET /api/orgs must list org ${orgId}`).toBeDefined();
  return row!.branding?.colors?.primary;
}

/** The `--ps-accent` custom property off the ONE element on this page that
 *  carries it — `OrgAbout`'s Preview pane (`org-about.tsx:57`,
 *  `publicThemeStyleChain` -> `publicThemeStyle` -> `resolvePublicTheme`,
 *  `src/lib/public-theme.ts`). Read via the live DOM's computed style, never
 *  a raw-HTML string match (AGENTS.md: a Next HTML grep for an omitted prop
 *  cannot tell states apart) — this locator resolves to nothing at all (and
 *  the read below never happens) when the color was rejected or never set,
 *  which is the correct failure shape for a missing render.
 */
async function aboutPreviewAccent(page: import("@playwright/test").Page): Promise<string> {
  const previewTab = page.getByRole("tab", { name: ui("editor.preview"), exact: true });
  await expect(previewTab, "the About editor's Write/Preview tabs must mount").toBeAttached({
    timeout: READ_MS,
  });
  await previewTab.click();
  const preview = page.locator('div[style*="ps-accent"]');
  await expect(preview, "the About preview pane must carry a --ps-accent style").toBeVisible({
    timeout: READ_MS,
  });
  return preview.evaluate((el) => getComputedStyle(el).getPropertyValue("--ps-accent").trim());
}

// #003366: contrast(this, white) ≈ 12.6, well past resolvePublicTheme's >= 3
// guard (public-theme.ts:77), so the color is never silently rejected by the
// contrast check — the point of these tests is the WRITE-side/mask gap, not
// the contrast guard.
const HEX = "#003366";

// ---------------------------------------------------------------------------
// Finding A — brand colour has no write-side check
// ---------------------------------------------------------------------------

test("Finding A: PATCH brand colour has no feature check, and OrgAbout's preview is the reachable read-mask exception", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  const org = await seedSettingsOrg(request, { plan: "community", label: "w3-finding-a" });
  try {
    // requireOrgRole(EDITOR_ROLES) -> schema -> mergeBrandColor -> update; no
    // hasFeature/requireFeature anywhere in the route (src/app/api/orgs/[id]/
    // route.ts) — a Community EDITOR's write is accepted outright.
    const patch = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
      branding: { colors: { primary: HEX } },
    });
    expect(patch.status, "PATCH brand colour on a Community org").toBe(200);

    // Persisted, proven by a read that is not the PATCH's own echo.
    await expect
      .poll(() => orgBranding(request, org.orgId), {
        timeout: READ_MS,
        message: "brand colour must read back off GET /api/orgs on a Community org",
      })
      .toBe(HEX);

    // The read mask (public-site/data.ts, V230, V306) hides this from the
    // PUBLIC org page — but page.tsx:386 hands `active.branding` to
    // `OrgAbout` UNCONDITIONALLY (gated only on `canEdit`, never on plan),
    // and its preview is unmasked. Drive it and look, per _RULES.md §9 — a
    // claim about what a person SEES is settled by the browser, not the code.
    await page.goto(settingsUrl(org.slug, "organization"));
    const accent = await aboutPreviewAccent(page);
    expect(
      accent,
      "OBSERVED: a Community org's own About preview must still show its brand colour",
    ).toBe(HEX);
  } finally {
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Finding B — GET api-keys has no api.access guard
// ---------------------------------------------------------------------------

test("Finding B: GET api-keys has no api.access guard on a Community org, while the tab renders the upsell", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  const org = await seedSettingsOrg(request, { plan: "community", label: "w3-finding-b" });
  try {
    // listApiKeys (usecases/api-keys.ts) calls requireSession only.
    // requireFeature("api.access") lives in createApiKey alone. The ROUTE
    // still gates on `requireOrgAuth(id, "write")` (role, not entitlement) —
    // the org's owner satisfies that, so this 200 is the entitlement gap,
    // not a broken auth check.
    const res = await apiJson<unknown[]>(request, `/api/v1/orgs/${org.orgId}/api-keys`);
    expect(res.status, "GET api-keys as a Community org's owner").toBe(200);
    expect(Array.isArray(res.data), "api-keys list body must be an array").toBe(true);

    // The other half of the finding: the UI shows the upsell for the SAME
    // org whose API just answered 200.
    await page.goto(settingsUrl(org.slug, "api"));
    await expect(
      page.getByText(ui("settings.upgrade.api")),
      "OBSERVED: the api tab must show the upsell for the same Community org",
    ).toBeVisible({ timeout: READ_MS });
  } finally {
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Finding C — DELETE /api/tour has no org check
// ---------------------------------------------------------------------------

test("Finding C: DELETE /api/tour has no org check — a viewer with the UI control hidden still succeeds", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-finding-c" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    // api/tour/route.ts: DELETE is `getCurrentUser()` -> `resetTour(user.id)`.
    // No `orgId` parameter exists anywhere in the file or the route path —
    // any authenticated user succeeds, regardless of org or role. The UI
    // hides the button for this identity (TourReplayButton sits behind
    // `canEdit`, page.tsx:391), which is exactly the gap: the route does not
    // re-check what the UI hid.
    const res = await member.request.fetch("/api/tour", { method: "DELETE" });
    expect(res.status(), "DELETE /api/tour as a viewer, no org check in the route").toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 8 — ?tab=api on a Free org
// ---------------------------------------------------------------------------

test("Case 8: ?tab=api on a Free org shows the upsell, and POST api-keys 402s naming api.access (not api.write)", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  // A Pro org with the entitlement forced off — the cleaner "Free"
  // simulation the brief asks for (distinct from Finding B's naturally-
  // Community org: this proves the OVERRIDE mechanism itself gates a plan
  // that would otherwise pass).
  const org = await seedSettingsOrg(request, { plan: "pro", label: "w3-case8" });
  try {
    // See the file-level doc comment: setBoolEntitlementOverrideSql, not the
    // int setter the brief named — api.access is boolean-checked.
    await setBoolEntitlementOverrideSql(org.orgId, "api.access", false);

    await page.goto(settingsUrl(org.slug, "api"));
    await expect(
      page.getByText(ui("settings.upgrade.api")),
      "OBSERVED: the api tab must show the upsell once api.access is forced off on a Pro org",
    ).toBeVisible({ timeout: READ_MS });

    // "Mind the order" (_INDEX.md): requireFeature("api.access") runs BEFORE
    // the api.write check in createApiKey, so a non-read scope still comes
    // back naming api.access — picking `score` (not `read`) is the case
    // whose right answer differs from the wrong guard-order's constant
    // (AGENTS.md #19): if the checks ran in the other order this would 402
    // with feature_key "api.write" instead.
    const res = await request.fetch(`/api/v1/orgs/${org.orgId}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { name: `${TAG}-case8`, scopes: ["score"] },
    });
    expect(res.status(), "POST api-keys once api.access is forced off").toBe(402);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.feature_key, "the 402 must name api.access, not api.write").toBe(
      "api.access",
    );
  } finally {
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 7 — a genuine Pro→Free transition
// ---------------------------------------------------------------------------

test("Case 7: a Pro org downgraded to Free keeps its saved brand colour visible (About preview) and writable (API)", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  const org = await seedSettingsOrg(request, { plan: "pro", label: "w3-case7" });
  try {
    const patch = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
      branding: { colors: { primary: HEX } },
    });
    expect(patch.status, "set the brand colour while Pro").toBe(200);

    // The one row needing a REAL plan flip (_RULES.md §2). A fresh org
    // already has its own billing group (auth.ts:292-330), so the split is
    // belt-and-braces here, not load-bearing — called anyway per the rule.
    await splitOrgIntoOwnGroupSql(org.orgId);
    await setOrgPlanBySql({ orgId: org.orgId }, "community");

    await page.goto(settingsUrl(org.slug, "organization"));

    // "Still rendered?" — page.tsx:369's EDIT widget (OrgBrandColor) is
    // gated on `dashboard.branding` and is now replaced by the upsell...
    await expect(
      page.getByText(ui("settings.upgrade.brandColor")),
      "OBSERVED: the colour PICKER must fall back to the upsell once downgraded",
    ).toBeVisible({ timeout: READ_MS });

    // ...but the VALUE is still rendered elsewhere on the same tab, via the
    // same reachable exception Finding A exercises (OrgAbout is gated only
    // on canEdit, never on plan).
    const accent = await aboutPreviewAccent(page);
    expect(
      accent,
      "OBSERVED: the downgraded org's saved brand colour is still visible in the About preview",
    ).toBe(HEX);

    // "Still saveable?" — Finding A's write-side gap does not close when an
    // org's REAL plan changes, only differs from a freshly-community org: no
    // feature check exists in the route at all.
    const rePatch = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
      branding: { colors: { primary: "#112233" } },
    });
    expect(rePatch.status, "OBSERVED: brand colour PATCH still 200s after the downgrade").toBe(
      200,
    );
  } finally {
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 9 — org-switch into an org without the entitlement
// ---------------------------------------------------------------------------

test("Case 9: switching the active org into one lacking sponsors.tiers enforces the gap on THAT org, not the one left behind", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  // Two orgs under the same identity — org1 (Pro, has the entitlement) is
  // what the active-org cookie points at once org2 is seeded; org2
  // (Community) is the one genuinely lacking it.
  const org1 = await seedSettingsOrg(request, { plan: "pro", label: "w3-case9-pro" });
  const org2 = await seedSettingsOrg(request, { plan: "community", label: "w3-case9-free" });
  try {
    // Explicit override per _RULES.md's preferred tool for the matrix, even
    // though a fresh Community org already lacks this by plan default
    // (belt-and-braces, same posture as the split call in Case 7).
    // sponsors.tiers is boolean-checked (usecases/sponsors.ts:102's
    // requireFeature -> hasFeature -> bool_value), so the brief's own
    // bool setter is correct here (unlike Case 8's api.access).
    await setBoolEntitlementOverrideSql(org2.orgId, "sponsors.tiers", false);

    // The literal instruction: POST /api/orgs/active, snake_case body,
    // behind `.strict()` — an `{orgId}` body 400s. org2 is already the
    // active org from seeding it (seedSettingsOrg's own POST /api/orgs sets
    // it), so this exercises the endpoint's own contract directly rather
    // than changing anything.
    const switchRes = await apiJson(request, "/api/orgs/active", "POST", { org_id: org2.orgId });
    expect(switchRes.status, "POST /api/orgs/active with a snake_case body").toBe(200);

    // Upsell half: org2's OWN sponsors tab reflects ITS OWN gap, not any
    // state left over from org1 (Pro) having been active a moment ago.
    await page.goto(settingsUrl(org2.slug, "sponsors"));
    await expect(
      page.getByText(ui("sponsors.tiersUpsell")),
      "OBSERVED: org2's sponsors tab must show the tiers upsell after the switch",
    ).toBeVisible({ timeout: READ_MS });

    // Write half: a tiered sponsor on org2 still 402s with the right key —
    // tiers above "partner" trip assertTierAllowed (usecases/sponsors.ts:96).
    const res = await request.fetch(`/api/v1/orgs/${org2.orgId}/sponsors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { name: `${TAG}-case9`, tier: "gold" },
    });
    expect(res.status(), "POST a gold-tier sponsor on org2 after the switch").toBe(402);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.feature_key, "the 402 must name sponsors.tiers").toBe("sponsors.tiers");
  } finally {
    // Release in the REVERSE of creation order. Each release restores the
    // active-org cookie to whatever it was at THAT org's own seed time
    // (settings-support.ts's `previousActiveOrgId`), so releasing org2 first
    // hands the cookie back to org1 (still alive), and releasing org1
    // second hands it back to whatever was active before either of these
    // two orgs existed — restoring the leg's original active org with no
    // separate capture/restore of our own needed.
    await releaseSettingsOrg(request, org2);
    await releaseSettingsOrg(request, org1);
  }
});
