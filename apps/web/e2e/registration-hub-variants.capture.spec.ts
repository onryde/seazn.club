// RS004 — TEMP(RS004 variants) sign-off capture. NOT a regression test: it
// exists only to drive the real registration hub (org-side Settings tab +
// row-click config panel) at all three `?variant=` directions and save
// screenshots for the owner's review. Delete this file the moment a
// direction is picked, alongside every other file tagged
// `TEMP(RS004 variants)` — see registration-hub-variant.ts's header for the
// full list and the reasoning.
//
// Seeds ONE competition with six divisions, each tuned to a state an
// organiser actually hits: comfortably filled, near capacity (row C's amber
// escalation, capacityTone() >= 80% in registration-hub-division-row-c.tsx),
// over capacity (capacity lowered below an already-held count —
// putRegistrationSettings has no floor check against existing
// registrations, so this is a genuinely reachable state, not a synthetic
// one), unlimited, scheduled, and closed — plus a mixed+age-band division, a
// team+free-agents division, a manual-approval division, a paid division
// and a long (40-char) division name, folded across those same six rows
// rather than needing six more.
//
// Screenshots land in SHOTS_DIR (the session scratchpad, outside the repo),
// named `<variant>-<surface>-<width>.png`.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
const SHOTS_DIR =
  "/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/337b726a-3c03-4e8f-a13a-679f405db693/scratchpad/shots";

const hubPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}/registration`;
const overviewPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}`;

type Variant = "a" | "b" | "c";

// Literal substrings lifted verbatim from each row variant's own outer-div
// className (registration-hub-division-row{,-b,-c}.tsx) — the one part of
// the DOM every variant renders differently for the SAME data, so it is
// what tells "the URL's ?variant= actually took effect" apart from "the
// page silently rendered variant a regardless".
const ROW_FINGERPRINT: Record<Variant, string> = {
  a: "gap-3 p-4 sm:p-5",
  b: "gap-1.5 px-4 py-3",
  c: "gap-4 p-5 sm:flex-row sm:items-start",
};

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  await page.screenshot({ path: `${SHOTS_DIR}/${name}`, fullPage: opts.fullPage ?? false });
}

/** Open the FIRST division row's config panel (whichever division sorts
 *  first — `order by d.name, d.id`, identical across every variant) and
 *  wait past its own async GET, same convention as registration-hub.
 *  spec.ts's own openConfigPanel: querying a field before the fetch lands
 *  is an unawaited-promise bug in the TEST, not the UI, and reads like a
 *  broken panel if this isn't awaited explicitly.
 *
 *  `[data-field="category"]` is inside the "eligibility" section, which is
 *  open/active by DEFAULT in every variant (config-panel-b.tsx's
 *  DEFAULT_OPEN.eligibility, config-panel-c.tsx's useState("eligibility")),
 *  so waiting on it needs no extra accordion/tab click regardless of which
 *  of the three panels rendered.
 *
 *  Throws on anything unexpected, INCLUDING the app's own React
 *  error-boundary fallback ("Something went wrong") replacing the panel
 *  instead of rendering it — the caller (the capture loop below) is what
 *  makes that survivable across the OTHER captures this run still owes; see
 *  its try/catch/finally. */
async function openFirstConfigPanel(page: Page): Promise<Locator> {
  const configureBtn = page.locator("[data-registration-hub-row-configure]").first();
  await expect(configureBtn).toBeVisible({ timeout: 20_000 });
  const row = page.locator("[data-registration-hub-row]").first();
  const divisionId = await row.getAttribute("data-division-id");
  if (!divisionId) throw new Error("openFirstConfigPanel: first row has no data-division-id");
  await configureBtn.click();
  const content = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionId}"]`);
  await expect(content).toBeVisible({ timeout: 20_000 });
  await expect(content.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  // Returns the DIALOG (Modal's own role="dialog" root), not the inner
  // content div — Modal renders children/footer as sibling divs, so the
  // Cancel button (`data-action="cancel"`, in footer) is not a descendant
  // of `content` at all (same note as registration-hub.spec.ts's own
  // openConfigPanel).
  return page.getByRole("dialog").filter({ has: content });
}

async function closePanel(dialog: Locator): Promise<void> {
  await dialog.locator('[data-action="cancel"]').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/** True when the app's own React error boundary is showing instead of real
 *  content -- src/app/error.tsx's "Something went wrong" fallback. Never
 *  throws (a probe, not an assertion): used only to make a caught failure's
 *  recorded message say "crashed" instead of a bare timeout string. */
async function hasErrorBoundary(page: Page): Promise<boolean> {
  return page
    .getByRole("heading", { name: "Something went wrong" })
    .isVisible()
    .catch(() => false);
}

test.describe("RS004 registration hub — variant sign-off capture", () => {
  test("settings tab + config panel across variants a/b/c, plus the variant-a overview", async ({
    page,
    request,
  }) => {
    // Seeding (56 real public submissions) + 3 variants x 5 shots + 2
    // overview shots comfortably clears the config default (60s) — this is
    // a one-off capture run, not a CI-timed suite.
    test.setTimeout(300_000);

    const org = await activeOrg(page);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;

    // --- Seed: one competition, six divisions. ----------------------------
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Reg Hub Variants ${suffix}`,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    if (comp.status >= 300) {
      throw new Error(`seed: competition create ${comp.status} ${JSON.stringify(comp.error)}`);
    }
    const competitionId = comp.data!.id;
    const competitionSlug = comp.data!.slug;

    async function createDivision(name: string): Promise<string> {
      const div = await apiJson<{ id: string }>(
        request,
        `/api/v1/competitions/${competitionId}/divisions`,
        "POST",
        { name, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
      );
      if (div.status >= 300) {
        throw new Error(`seed: division "${name}" create ${div.status} ${JSON.stringify(div.error)}`);
      }
      return div.data!.id;
    }

    async function patchDivision(divisionId: string, patch: Record<string, unknown>): Promise<void> {
      const res = await apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", patch);
      if (res.status >= 300) {
        throw new Error(`seed: division PATCH ${divisionId} ${res.status} ${JSON.stringify(res.error)}`);
      }
    }

    async function putSettings(divisionId: string, settings: Record<string, unknown>): Promise<void> {
      const res = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", settings);
      if (res.status >= 300) {
        throw new Error(`seed: registration-settings PUT ${divisionId} ${res.status} ${JSON.stringify(res.error)}`);
      }
    }

    // Real public submissions, the same endpoint/shape registration-hub.
    // spec.ts's own nav-pill test uses. Batched (not one giant Promise.all)
    // so a division needing 26 doesn't fire 26 requests that all race the
    // SAME registration_settings row lock at once.
    async function submitFree(divisionId: string, count: number, divTag: string): Promise<void> {
      const BATCH = 8;
      for (let start = 0; start < count; start += BATCH) {
        const n = Math.min(BATCH, count - start);
        await Promise.all(
          Array.from({ length: n }, (_, k) => start + k).map(async (i) => {
            const who = `${divTag}-${i}`;
            const res = await apiJson<{ entries: { status: string }[] }>(
              request,
              `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
              "POST",
              {
                contact: { name: `Capture ${who}`, email: `e2e-reghub-variants-${suffix}-${who}@example.com` },
                privacy_consent: true,
                entries: [
                  {
                    division_id: divisionId,
                    entrant_kind: "individual",
                    players: [{ full_name: `Capture ${who}` }],
                    answers: {},
                  },
                ],
              },
            );
            if (res.status !== 201) {
              throw new Error(
                `seed: submit ${who} -> division ${divisionId} failed: ${res.status} ${JSON.stringify(res.error)}`,
              );
            }
          }),
        );
      }
    }

    // Division 1 — open now, comfortably filled (8/24).
    const div1 = await createDivision("Open Singles");
    await putSettings(div1, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 24,
      fee_cents: 0,
      approval: "auto",
    });
    await submitFree(div1, 8, "d1");

    // Division 2 — open now, near capacity (22/24, ~92%) — row C's amber
    // escalation threshold is 80%. Also the one PAID division (fee_cents >
    // 0, offline payment) — a fee keeps every entry "pending"
    // (registration-submit.ts only auto-confirms a FREE auto-approval entry
    // inline), which is also what feeds the variant-a overview's amber
    // "awaiting" badge below. Deliberately plain category/no age band: the
    // eligibility engine 422s a "mixed" category on a single-player
    // individual entry ("requires at least one male and one female
    // player") and requires a dob once an age band is set — real
    // constraints, correctly enforced, just incompatible with this row's
    // bulk single-player seeding. The mixed+age-band division is div5
    // below instead, which never actually submits anyone.
    const div2 = await createDivision("Paid Singles (Near Capacity)");
    await putSettings(div2, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 24,
      fee_cents: 500,
      approval: "auto",
    });
    await submitFree(div2, 22, "d2");

    // Division 3 — over capacity (26/24). Capacity starts roomy so all 26
    // land as real held spots (no waitlisting), then the organiser LOWERS
    // capacity below the count already held.
    const div3 = await createDivision("Overflow Open");
    await putSettings(div3, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 40,
      fee_cents: 0,
      approval: "auto",
    });
    await submitFree(div3, 26, "d3");
    await putSettings(div3, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 24,
      fee_cents: 0,
      approval: "auto",
    });

    // Division 4 — no capacity set at all (unlimited). Also: team entrant
    // kind with free agents allowed, and manual approval.
    const div4 = await createDivision("Club Teams (Unlimited)");
    await putSettings(div4, {
      enabled: true,
      entrant_kind: "team",
      allow_free_agents: true,
      approval: "manual",
      fee_cents: 0,
    });

    // Division 5 — scheduled: window entirely in the future. Also: mixed
    // category + an 18-35 age band (see div2's comment above for why it
    // lives here rather than on a division that actually submits entries —
    // this one never does, its window hasn't opened).
    const div5 = await createDivision("Scheduled Mixed 18-35");
    await patchDivision(div5, { category: "mixed", age_min: 18, age_max: 35 });
    await putSettings(div5, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 24,
      fee_cents: 0,
      approval: "auto",
      opens_at: "2027-01-15T10:00:00.000Z",
      closes_at: "2027-02-01T10:00:00.000Z",
    });

    // Division 6 — closed: window fully in the past. Also: a long (40-char)
    // name, to show the row's `truncate` behaviour.
    const LONG_NAME = "Under 19 Mixed Doubles Championship Pool"; // 40 chars
    const div6 = await createDivision(LONG_NAME);
    await putSettings(div6, {
      enabled: true,
      entrant_kind: "individual",
      capacity: 24,
      fee_cents: 0,
      approval: "auto",
      opens_at: "2025-01-01T09:00:00.000Z",
      closes_at: "2025-02-01T09:00:00.000Z",
    });

    // --- Capture: Settings tab + config panel, three variants. ------------
    // `issues` accumulates real, loud findings (a fingerprint mismatch, a
    // crashed panel) without letting ONE variant's problem cost the other
    // two their captures -- every shot this dispatch asked for is attempted
    // regardless, and the run still fails at the end (see the throw below)
    // so nothing here is mistaken for a clean pass.
    const issues: string[] = [];
    const variantUrl = (v: Variant) => `${hubPath(org.slug, competitionSlug)}?variant=${v}`;

    for (const variant of ["a", "b", "c"] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(variantUrl(variant), { waitUntil: "load" });

      const firstRow = page.locator("[data-registration-hub-row]").first();
      await expect(firstRow).toBeVisible({ timeout: 20_000 });
      const rowClass = (await firstRow.getAttribute("class")) ?? "";

      // The variant actually took effect: its OWN fingerprint is present...
      if (!rowClass.includes(ROW_FINGERPRINT[variant])) {
        issues.push(
          `?variant=${variant} did not take effect -- first row class ` +
            `"${rowClass}" is missing variant ${variant}'s own fingerprint ` +
            `"${ROW_FINGERPRINT[variant]}"`,
        );
      }
      // ...and for b/c, variant a's fingerprint is ABSENT -- catches a
      // silent fallback to "a" instead of trusting only one direction.
      if (variant !== "a" && rowClass.includes(ROW_FINGERPRINT.a)) {
        issues.push(
          `?variant=${variant} silently rendered variant a instead -- first ` +
            `row class "${rowClass}" still carries variant a's fingerprint ` +
            `"${ROW_FINGERPRINT.a}"`,
        );
      }

      await shot(page, `${variant}-settings-1280.png`, { fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, `${variant}-settings-390.png`, { fullPage: true });

      // Config panel open -- three widths, each opened and asserted fresh
      // (a screenshot of a page where the click missed is worse than no
      // screenshot at all).
      for (const { width, height, label } of [
        { width: 1280, height: 900, label: "1280" },
        { width: 390, height: 844, label: "390" },
        { width: 320, height: 720, label: "320" },
      ]) {
        await page.setViewportSize({ width, height });
        try {
          const dialog = await openFirstConfigPanel(page);
          await shot(page, `${variant}-panel-${label}.png`);
          await closePanel(dialog);
        } catch (err) {
          // Whatever broke, still grab a screenshot of the current state
          // (best-effort of its own -- a fully torn-down page can fail
          // this too) so the failure has visual evidence, not just a
          // stack trace.
          await shot(page, `${variant}-panel-${label}.png`).catch(() => undefined);
          const crashed = await hasErrorBoundary(page);
          issues.push(
            `${variant}-panel-${label}.png: ${
              crashed
                ? `config panel hit the app's own error boundary ("Something ` +
                  `went wrong") instead of rendering the form`
                : `openFirstConfigPanel failed -- ${(err as Error).message.split("\n")[0]}`
            } -- screenshot saved anyway, it shows the actual state`,
          );
        } finally {
          // Always return to a known-good page before the next width/
          // variant tries its own fresh open, regardless of how this one
          // ended.
          await page.goto(variantUrl(variant), { waitUntil: "load" }).catch(() => undefined);
        }
      }
    }

    // --- Once, variant a only: the overview's Registration nav entry. -----
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(overviewPath(org.slug, competitionSlug), { waitUntil: "load" });
    const navEntry = page.locator("[data-registration-hub-entry]");
    await expect(navEntry).toBeVisible({ timeout: 20_000 });
    // Div 2's 22 paid (offline, unconfirmed) entries are what keep this
    // non-zero -- see the awaitingBadge comment on registration-hub-nav-
    // entry.tsx (pending/paid/waitlisted, never rendered at a literal "0").
    await expect(navEntry.locator("[data-registration-hub-awaiting]")).toBeVisible({ timeout: 20_000 });
    await shot(page, "a-overview-1280.png", { fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "a-overview-390.png", { fullPage: true });

    // Every capture this dispatch asked for has now been attempted. Fail
    // loudly, and ONLY now, if anything above was not what it should have
    // been -- see the honesty requirements this file exists to satisfy.
    expect(issues, `${issues.length} capture(s) found a real problem:\n${issues.join("\n")}`).toEqual([]);
  });
});
