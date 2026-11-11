import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  type SeededOrg,
} from "../settings-support";
import { apiJson, TAG } from "../helpers";
import { routes } from "../../src/lib/routes";
import { BRAND_PALETTE } from "../../src/lib/brand-palette";
import {
  CTA,
  CTA_MD,
  LINK,
  LINK_MD,
  ctaByApply,
  escapeCloses,
  expectPageKept,
  expectPublicCta,
  linkByEnter,
  watchPage,
  type PageWitness,
} from "../prose-dialog-kit";

/**
 * W5 of the settings walkthrough programme — `/o/{org}/c/{comp}/settings`,
 * driven the way an organiser drives it and read back through an API that is
 * not the writer's own echo.
 *
 * This surface had NO behavioural e2e before this wave: the whole suite never
 * navigated to it. Task 1 owns the DRIVE half (general fields, the showcase
 * opt-in and its auto-clear, the youth interstitial, the branding tab);
 * Task 2 owns the gating matrix (frozen, entitlements, non-owner, date order).
 *
 * `mode: "default"`, for the reasons `settings-org-tabs.spec.ts` sets out at
 * length: `fullyParallel: true` plus `--workers=3` would otherwise spread this
 * file's tests across workers and run `beforeAll` — and therefore an org seed —
 * once per worker, against a shared Pro user capped at five owned orgs. Not
 * `serial`, because serial SKIPS every test after the first red and this file
 * exists to find defects on an uncovered surface (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

/**
 * Copy read from the dictionary the page renders from, never retyped here — a
 * test carrying its own copy of a string asserts yesterday's wording and goes
 * red on a rewrite that broke nothing (this folder's idiom:
 * settings-org-tabs.spec.ts:60, settings-admin.spec.ts:11).
 */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
/** The confirm dialog's Cancel label comes from `common`, not `ui` — it renders
 *  at the root `ConfirmProvider`, outside any DictProvider, through
 *  `clientCommon(readLocaleCookie(), "dialog.cancel")` (confirm-provider.tsx). */
const COMMON_EN: Record<string, string> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../src/dictionaries/en/common.json", import.meta.url)),
    "utf8",
  ),
);

/** Throws on a missing key: a renamed key must red loudly here rather than
 *  quietly resolve to a locator that matches nothing and times out elsewhere. */
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return raw;
}
function common(key: string): string {
  const raw = COMMON_EN[key];
  if (raw === undefined) throw new Error(`missing en common dictionary key: ${key}`);
  return raw;
}

const L = {
  name: ui("compset.name"),
  starts: ui("compset.starts"),
  ends: ui("compset.ends"),
  save: ui("compset.save"),
  saved: ui("compset.saved"),
  showcase: ui("showcase.label"),
  brandingTab: ui("compset.tab.branding"),
  youthTitle: ui("visibility.youth.title"),
  youthConfirm: ui("visibility.youth.confirm"),
  cancel: common("dialog.cancel"),
  visibility: {
    private: ui("visibility.private.label"),
    unlisted: ui("visibility.unlisted.label"),
    public: ui("visibility.public.label"),
  },
} as const;

/**
 * Any palette entry, derived from the palette rather than typed in, so a
 * recoloured swatch moves this test with it instead of leaving it asserting
 * yesterday's hex (AGENTS.md failure class 19). The LAST entry, so it is never
 * the leading "same as organisation" chip whose stored value is null.
 */
const SWATCH = BRAND_PALETTE[BRAND_PALETTE.length - 1]!;
const SWATCH_LABEL = ui(`swatch.${SWATCH.name}`);

/**
 * Test budgets expressed in what the test actually does, never a flat constant
 * beside a derived cost (`_RULES.md` §5.7). A nav is a cold server render of a
 * page that runs six parallel queries of its own; a commit is one UI mutation
 * — click, PATCH round trip, and the `router.refresh()` behind it; a seed is
 * the two-to-three API calls `seedCompetition` makes.
 */
const NAV_MS = 20_000;
const COMMIT_MS = 12_000;
const SEED_MS = 10_000;
const READ_MS = 20_000;
const budget = (navs: number, commits: number, seeds = 1): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + commits * COMMIT_MS + seeds * SEED_MS);

interface CompetitionRead {
  id: string;
  name: string;
  slug: string;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  status: string;
  discoverable: boolean;
  branding: unknown;
  frozen?: boolean;
}

/** The row as the SERVER sees it — never the form's own echo. */
async function readComp(request: APIRequestContext, id: string): Promise<CompetitionRead> {
  const res = await apiJson<CompetitionRead>(request, `/api/v1/competitions/${id}`, "GET");
  expect(res.status, `GET /api/v1/competitions/${id}`).toBe(200);
  // `apiJson` swallows a body-parse failure and hands back `data: undefined`,
  // so without this a 200 carrying a broken envelope would degrade every
  // downstream assertion to `expect(undefined)` and pass vacuously.
  expect(res.data, "the competition read must carry a row").toBeDefined();
  return res.data!;
}

/**
 * The input inside the wrapping <label> whose own copy STARTS WITH `label`.
 *
 * Not `getByLabel`, and not `hasText` with a bare string, for two separate
 * reasons found by running this rather than reading it:
 *
 *  - every field here sits inside a wrapping <label> that also holds the
 *    control, which Playwright resolves by the label's text CONTENT (the
 *    reason settings-org-tabs.spec.ts avoids `getByLabel` too);
 *  - `hasText` with a STRING is a case-INSENSITIVE substring match, and
 *    `hasText: "Name"` therefore also matched the showcase consent paragraph
 *    ("…this competition's name, your organisation's name…") — a strict-mode
 *    violation resolving to two elements, the text field and the showcase
 *    checkbox. An anchored RegExp is case-sensitive and pins the start.
 *
 * Anchored rather than exact because `compset.ends` renders as "Ends *"
 * (competition-settings.tsx:290 appends the required marker outside the key).
 */
function field(page: Page, label: string) {
  const anchored = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return page.locator("label").filter({ hasText: anchored }).locator("input");
}

/** The visibility segments (`visibility-segmented.tsx`, settings C8 2026-11-11): each segment's radio is visually
 *  hidden inside its <label>, and its accessible name is the label alone. Read state off the radio… */
function visibilityRadio(page: Page, key: "private" | "unlisted" | "public") {
  return page.getByRole("radio", { name: L.visibility[key], exact: true });
}

/** …and pick by tapping the segment, as a person does: the radio itself is `sr-only`, so a click aimed at it lands on
 *  the label that covers it (Playwright would report the label intercepting the pointer). */
async function pickVisibility(page: Page, key: "private" | "unlisted" | "public") {
  await page.locator("label").filter({ has: visibilityRadio(page, key) }).click();
}

/** The Showcase opt-in (`showcase-optin.tsx`): a checkbox with `role="switch"` since settings C8. */
const showcase = (page: Page) => page.getByRole("switch", { name: L.showcase });

/**
 * Submit the one form this page has, and hand back the request body it sent.
 *
 * The body is returned rather than discarded because one test needs to assert
 * what the CLIENT chose to send — see the case #10 test for why that is the
 * evidence that its API half is not redundant.
 */
async function saveSettings(page: Page, compId: string): Promise<Record<string, unknown>> {
  const pending = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/competitions/${compId}`) && r.request().method() === "PATCH",
    { timeout: COMMIT_MS },
  );
  await page.getByRole("button", { name: L.save, exact: true }).click();
  const res = await pending;
  const body = (res.request().postDataJSON() ?? {}) as Record<string, unknown>;
  expect(res.status(), `PATCH /api/v1/competitions/${compId}: ${await res.text()}`).toBe(200);
  await expect(page.getByText(L.saved)).toBeVisible({ timeout: READ_MS });
  return body;
}

// ---------------------------------------------------------------------------

let org: SeededOrg;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture: `seedSettingsOrg` moves the
  // `seazn_org` cookie of whatever jar it is handed (settings-support.ts), and
  // a per-test fixture's jar is not the one the next test gets anyway.
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W5-drive" });
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // The release lives here and NOT in a `finally` inside a test: a Playwright
  // `test.setTimeout` does not unwind the test function, so a `finally` there
  // never runs — and a leaked seed spends one of the shared Pro user's five
  // owner slots for the rest of the leg.
  if (!org) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

test("general fields persist across the reload, and the rename that regenerates the slug leaves the old URL redirecting", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 1));
  const comp = await seedCompetition(request, org.orgId, {
    visibility: "private",
    status: "draft",
  });
  try {
    const renamed = `Renamed via W5 ${TAG}`;
    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    await expect(field(page, L.name)).toHaveValue(comp.name, { timeout: READ_MS });

    await field(page, L.name).fill(renamed);
    await field(page, L.starts).fill("2027-03-01");
    await field(page, L.ends).fill("2027-03-14");
    await saveSettings(page, comp.id);

    const read = await readComp(request, comp.id);
    expect(read.name, "the rename must reach the row").toBe(renamed);
    expect(read.starts_on).toBe("2027-03-01");
    expect(read.ends_on).toBe("2027-03-14");
    // Not decoration: `patchCompetition` regenerates the slug on any rename
    // that does not carry one of its own (`regenerating`, usecases/
    // competitions.ts), and this form never sends a slug. A test that reloaded
    // the old URL without knowing that would report the redirect below as a
    // navigation flake.
    expect(read.slug, "a rename regenerates the slug").not.toBe(comp.slug);

    // The ONE reload this tab gets (`_RULES.md` §5.2/§5.3) — "does it render
    // back?". Deliberately on the OLD url: `page-auth.ts`'s `settle` 301s a
    // renamed slug, so the same reload proves the redirect as well.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/c/${read.slug}/settings$`));
    await expect(field(page, L.name)).toHaveValue(renamed);
    await expect(field(page, L.starts)).toHaveValue("2027-03-01");
    await expect(field(page, L.ends)).toHaveValue("2027-03-14");

    // THE NEGATIVE CONTROL FOR THE YOUTH INTERSTITIAL, and it lives here rather
    // than in the youth test because only this test has the fixture for it:
    // a competition that is `private` with NO divisions at all.
    //
    // `pickVisibility()` in competition-settings.tsx gates on `hasYouthDivisions
    // && form.visibility === "private" && next !== "private"`. The youth test kills the whole block,
    // but nothing kills the FIRST conjunct on its own: drop it and every
    // organiser leaving Private is asked to confirm guardian consent they were
    // never asked for. That mutant is invisible to the youth test (it seeds a
    // youth division), invisible to case #10 (it starts public, so the second
    // conjunct is already false), and there is no other coverage of this
    // component anywhere in the tree. (The New competition form has no youth
    // guard at all — a competition being created has no divisions — so this
    // settings page is the guard's only home.)
    //
    // Order matters. `toBeChecked()` FIRST: an interstitial holds the radio at
    // its old value (the guard returns before the form moves), so a public radio
    // that ends up checked is positive proof the transition was not gated.
    // `toHaveCount(0)` alone would be a silence test, satisfied by a click the
    // page never processed — and satisfied instantly, before a dialog that was
    // going to open had opened.
    await pickVisibility(page, "public");
    // Proof that REACT processed the click, before either assertion below is
    // read. Both of those are satisfiable pre-hydration: the browser checks a
    // native radio itself, and `toHaveCount(0)` is trivially true while no
    // handler has run — so a click that beat hydration would pass both while
    // witnessing nothing, and the `hasYouthDivisions &&` mutant this negative
    // control exists to kill would survive.
    //
    // The showcase opt-in is disabled unless the FORM's visibility is public
    // (`ShowcaseOptIn`'s `live`) — CLIENT form state. The
    // competition is private on the server, so SSR renders it disabled; only a
    // hydrated React state change can enable it. Same assertion, same purpose,
    // as the confirm-path case below.
    await expect(
      showcase(page),
      "the click must have reached React, not just the native radio",
    ).toBeEnabled();
    await expect(
      visibilityRadio(page, "public"),
      "no youth divisions: leaving Private must apply immediately, ungated",
    ).toBeChecked();
    await expect(
      page.getByRole("alertdialog"),
      "the guardian-consent interstitial must not fire without a youth division",
    ).toHaveCount(0);
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("the description editor's Link (Enter) and Button (Apply) prompts work inside the settings form and save nothing on their own (task PEF)", async ({
  page,
  request,
}) => {
  // Two navs (settings, the public page), and four commits: the two prompts and Escape (each a UI change read back),
  // then the Save.
  test.setTimeout(budget(2, 4));
  // Unlisted, so its public page opens by link — where the sponsor button is read at the end.
  const comp = await seedCompetition(request, org.orgId, { visibility: "unlisted", status: "draft" });
  let witness: PageWitness | null = null;
  try {
    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    await expect(field(page, L.name)).toHaveValue(comp.name, { timeout: READ_MS });
    const before = await apiJson<{ name: string; description: string | null }>(request, `/api/v1/competitions/${comp.id}`, "GET");
    expect(before.status).toBe(200);

    // A rename typed and NOT saved: the prompts must neither lose it nor save it.
    const typedName = `Prompts typed ${TAG}`;
    await field(page, L.name).fill(typedName);
    const editor = page.getByRole("textbox", { name: ui("compset.description"), exact: true });
    await editor.click();
    const opening = "Doors open at nine. ";
    await page.keyboard.type(`${opening}${LINK.text}`);
    await expect(editor).toContainText(`${opening}${LINK.text}`);
    witness = await watchPage(page);
    const start = page.url();

    // Link with Enter, the Button with Apply, then Escape — in sequence, each on the page the last one left.
    const form = page.locator("form").filter({ has: editor });
    await linkByEnter(page, form, editor);
    await expectPageKept(page, witness, start, "Link + Enter");
    await ctaByApply(page, form, editor);
    await expectPageKept(page, witness, start, "Button + Apply");
    await escapeCloses(page, form, editor);
    await expectPageKept(page, witness, start, "Link + Escape");

    // The page still holds what was typed...
    await expect(field(page, L.name), "the typed name is still there").toHaveValue(typedName);
    await expect(editor).toContainText(opening.trim());
    await expect(page.getByText(L.saved, { exact: true }), "no 'Saved' — nothing was saved").toHaveCount(0);
    // ...and the settings were not saved by a prompt: no PATCH left the page, and the row is as seeded.
    expect(witness.writes, "no prompt submitted the settings form").toEqual([]);
    const after = await apiJson<{ name: string; description: string | null }>(request, `/api/v1/competitions/${comp.id}`, "GET");
    expect(after.data?.name, "the row's name is the seeded one, not the typed one").toBe(comp.name);
    expect(after.data?.description ?? null, "the row's description is untouched").toBe(before.data?.description ?? null);

    // The positive twin: Save, and the same watcher sees the PATCH, which carries both prompts' work with the button in
    // its canonical shape, stored that way (the editor's half); then the public page draws it as the branded button
    // (the renderer's half). A regression on either side is named by its own assertion.
    const sent = await saveSettings(page, comp.id);
    expect(witness.writes, "the watcher does see a PATCH when the form sends one").toEqual([`PATCH /api/v1/competitions/${comp.id}`]);
    witness.stop();
    const saved = await apiJson<{ name: string; slug: string; description: string | null }>(
      request,
      `/api/v1/competitions/${comp.id}`,
      "GET",
    );
    expect(saved.data?.name).toBe(typedName);
    expect(String(sent.description), "the link is in the editor's value").toContain(LINK_MD);
    expect(String(sent.description), "the sponsor button is in the editor's value, in its canonical shape").toContain(CTA_MD);
    expect(String(saved.data?.description), "and is stored that way").toContain(CTA_MD);
    // The rename regenerated the slug (see the general-fields test), so the public URL is the saved row's.
    await expectPublicCta(page, org.slug, saved.data!.slug);
  } finally {
    witness?.stop();
    await releaseCompetition(request, comp.id);
  }
});

test("a description saved in the Button tool's old shape, `[**label**](url)`, draws the branded button with no migration (task PEF round 2)", async ({
  page,
  request,
}) => {
  // One nav (the public page), one commit (the PATCH, read back).
  test.setTimeout(budget(1, 1));
  const comp = await seedCompetition(request, org.orgId, { visibility: "unlisted", status: "draft" });
  try {
    // Written the way the Button tool wrote it before round 2 — and the way rows saved before then still hold it.
    const legacy = `Doors open at nine. ${LINK_MD}\n\n[**${CTA.label}**](${CTA.url})`;
    const patched = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", { description: legacy });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    const stored = await apiJson<{ slug: string; description: string | null }>(request, `/api/v1/competitions/${comp.id}`, "GET");
    // Nothing rewrote the row: the old shape is what the public page is given.
    expect(stored.data?.description, "the row holds the old shape, unmigrated").toBe(legacy);
    expect(stored.data?.description, "premise: not the canonical shape").not.toContain(CTA_MD);
    await expectPublicCta(page, org.slug, stored.data!.slug);
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("case #10: the showcase opt-in clears when visibility leaves public — in the UI, and on a scripted PATCH that never mentions it", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 2));
  const comp = await seedCompetition(request, org.orgId, { visibility: "public" });
  try {
    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    await expect(showcase(page)).toBeEnabled({ timeout: READ_MS });
    await showcase(page).check();
    await saveSettings(page, comp.id);
    expect((await readComp(request, comp.id)).discoverable, "opt-in must reach the row").toBe(true);

    // Drop to "link only" through the segmented control — a real tap on the
    // segment, not an API-only flip: design §7 frames this case as a UI question
    // ("does the UI show a stale true?").
    await pickVisibility(page, "unlisted");
    const dropBody = await saveSettings(page, comp.id);

    await page.reload();
    await expect(showcase(page)).not.toBeChecked();
    await expect(showcase(page)).toBeDisabled();
    const afterDrop = await readComp(request, comp.id);
    expect(afterDrop.visibility).toBe("unlisted");
    expect(afterDrop.discoverable).toBe(false);

    // WHY THE API HALF BELOW EXISTS, asserted rather than asserted-about.
    //
    // `competition-settings.tsx:159` sends
    // `discoverable: form.visibility === "public" ? form.discoverable : false`,
    // so the browser has ALREADY cleared the flag by the time the request
    // leaves. The UI half above therefore cannot witness the server's own
    // auto-clear (`patchCompetition`: `if (nextVisibility !== "public" &&
    // before.discoverable && effective.discoverable !== false)`) — delete that
    // clause and every assertion above still passes. Pinning the client's body
    // is what stops this file quietly turning into that vacuous test.
    expect(
      dropBody.discoverable,
      "the client pre-clears the flag, which is why the server guard needs its own case",
    ).toBe(false);

    // Put it back through the API, then change visibility with a patch that
    // says NOTHING about `discoverable` — the shape only a script can send.
    const on = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", {
      visibility: "public",
      discoverable: true,
    });
    expect(on.status, "re-opt-in via the API").toBe(200);
    expect((await readComp(request, comp.id)).discoverable).toBe(true);

    const off = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", {
      visibility: "unlisted",
    });
    expect(off.status, "a visibility-only patch must be accepted").toBe(200);
    const afterScripted = await readComp(request, comp.id);
    expect(afterScripted.visibility).toBe("unlisted");
    expect(
      afterScripted.discoverable,
      "the server must clear the showcase opt-in itself when visibility leaves public",
    ).toBe(false);
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("the youth interstitial gates leaving Private: declining changes nothing, confirming moves the picker and nothing else", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 0));
  const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
  try {
    // `deriveYouth` (usecases/divisions.ts) is `age_max != null && age_max < 18`
    // — the ONE derivation, run at insert time into the `youth` column that
    // settings/page.tsx reads. 12 is inside it; the read-back is what makes
    // this a seed rather than a hope.
    const division = await apiJson<{ youth: boolean }>(
      request,
      `/api/v1/competitions/${comp.id}/divisions`,
      "POST",
      { name: `U12 Mixed ${TAG}`, sport_key: "badminton", variant_key: "bwf", age_max: 12 },
    );
    expect(division.status, `seed a youth division: ${JSON.stringify(division.error)}`).toBe(201);
    expect(division.data?.youth, "age_max 12 must derive youth = true").toBe(true);

    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    await expect(visibilityRadio(page, "private")).toBeChecked({ timeout: READ_MS });
    // The showcase opt-in is unreachable while the competition is not public
    // (competition-settings.tsx:355) — the state the confirm below leaves.
    await expect(showcase(page)).toBeDisabled();

    await pickVisibility(page, "public");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog, "leaving Private with a youth division must interstitial").toBeVisible();
    // `role="alertdialog"`, not `dialog` (confirm-provider.tsx:153) — a
    // `getByRole("dialog")` here matches nothing and times out.
    await expect(dialog).toHaveAttribute("aria-label", L.youthTitle);

    await dialog.getByRole("button", { name: L.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    // A decline is a true no-op: the guard returns before the form moves, so
    // not even the local form state changed.
    await expect(visibilityRadio(page, "private")).toBeChecked();
    await expect(visibilityRadio(page, "public")).not.toBeChecked();
    await expect(showcase(page)).toBeDisabled();
    expect((await readComp(request, comp.id)).visibility, "a decline writes nothing").toBe(
      "private",
    );

    await pickVisibility(page, "public");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: L.youthConfirm, exact: true })
      .click();
    await expect(visibilityRadio(page, "public")).toBeChecked();
    await expect(showcase(page), "public unlocks the showcase opt-in").toBeEnabled();
    // ...and confirming is still only a form edit. Nothing is saved until Save.
    expect(
      (await readComp(request, comp.id)).visibility,
      "confirming the interstitial must not itself write",
    ).toBe("private");
  } finally {
    await releaseCompetition(request, comp.id);
  }
});

test("branding tab: the competition accent colour persists and comes back selected", async ({
  page,
  request,
}) => {
  test.setTimeout(budget(1, 1));
  const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
  try {
    await page.goto(routes.competitionSettings(org.slug, comp.slug));
    // The palette is drawn only when the org holds `dashboard.theme`
    // (page.tsx — `dashboard.theme` since V397, NOT `dashboard.branding`),
    // which Pro has by default (V397__dashboard_theme_key.sql:44). The TAB is
    // always there since settings C8; the palette's presence is that
    // entitlement's positive case, and Task 2 owns the negative one.
    await page.getByRole("tab", { name: L.brandingTab, exact: true }).click();

    const chip = page.getByRole("button", { name: SWATCH_LABEL, exact: true });
    await expect(chip, "the Branding tab must offer the palette").toBeVisible({ timeout: READ_MS });
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    const body = await saveSettings(page, comp.id);
    expect(body.branding, "the form must carry the chosen colour").toEqual({
      colors: { primary: SWATCH.hex },
    });

    const read = await readComp(request, comp.id);
    expect((read.branding as { colors?: { primary?: string } } | null)?.colors?.primary).toBe(
      SWATCH.hex,
    );

    await page.reload();
    await page.getByRole("tab", { name: L.brandingTab, exact: true }).click();
    await expect(
      page.getByRole("button", { name: SWATCH_LABEL, exact: true }),
      "the saved colour must come back as the selected chip",
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    await releaseCompetition(request, comp.id);
  }
});
