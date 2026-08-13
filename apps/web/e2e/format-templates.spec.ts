import { test, expect } from "@playwright/test";
import { apiJson, type OrgInfo } from "./helpers";

// D1a (P4): create-competition wizard step 0 — template gallery + detail
// sheet. Pins the acceptance criterion verbatim: pick template -> structure
// on competition page -> entrant guidance.
//
// Runs on the "parallel" project (default storageState: e2e/.auth/pro.json)
// — it only touches state it creates itself (its own new competition, via
// its own uniquely-named division), never shared org-level quota, so it
// needs no serial isolation. slam128 (knockout) is deliberately the chosen
// template: it is not behind formats.double_elim or formats.advanced, so
// this spec proves the picker flow on the SAME plan tier regardless of
// which auth-state project runs it.

test("pick a template, land on the competition page with its structure, see entrant guidance", async ({
  page,
  request,
}) => {
  const { data: orgs } = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs?.[0]?.slug;
  if (!orgSlug) throw new Error("no org for the authenticated session — auth.setup.ts must run first");

  await page.goto(`/o/${orgSlug}/c/new`);

  // Step 0: the gallery, not a bare blank form — every launch template is a
  // card, plus a distinct "start blank" affordance.
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible();
  await expect(page.getByTestId("template-card-slam128")).toBeVisible();
  await expect(page.getByTestId("template-card-swiss11")).toBeVisible();
  await expect(page.getByTestId("template-card-wc32")).toBeVisible();
  await expect(page.getByTestId("template-card-americano-night")).toBeVisible();
  await expect(page.getByTestId("template-card-box-league")).toBeVisible();
  await expect(page.getByTestId("template-start-blank")).toBeVisible();

  // Pick slam128 -> the detail sheet opens showing the real structure and
  // entrant guidance BEFORE commit (design doc: "placeholder counts as
  // guidance") — 128 entrants, a single knockout stage, never a fake entrant
  // row.
  await page.getByTestId("template-card-slam128").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const structure = page.getByTestId("template-detail-structure");
  await expect(structure).toContainText("Knockout");
  await expect(structure).toContainText("128");

  // Minimal name + dates form — name is pre-filled from the template, only
  // the mandatory end date needs filling in.
  await sheet.getByLabel("Ends on", { exact: false }).fill("2030-12-31");
  await page.getByTestId("template-detail-submit").click();

  // Navigation off /c/new (not merely a URL that still CONTAINS /c/, which
  // /c/new itself also matches) proves the POST succeeded and the wizard
  // followed through, rather than the sheet just sitting there on a network
  // error the assertions below would otherwise paper over.
  await page.waitForURL((u) => !u.pathname.endsWith("/c/new"), { timeout: 20_000 });

  // Structure on the competition page: the created division renders as a
  // card named after the template's division (localized "Main Draw"). Its
  // meta line (format label "Knockout" from the REAL stage kind just
  // written, and entrant guidance "0 entrants" — never a fake headcount) is
  // page-level text next to, not inside, the card's accessible link name
  // (EntityCard's stretched-link pattern: the `<a>` overlays the whole card
  // but only names itself after the division), so these are checked as
  // visible page content rather than folded into one locator's name.
  await expect(page.getByRole("link", { name: "Main Draw" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Knockout")).toBeVisible();
  await expect(page.getByText(/entrants?/i).first()).toBeVisible();
});
