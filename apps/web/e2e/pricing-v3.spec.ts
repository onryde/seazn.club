import { test, expect } from "@playwright/test";
import {
  apiJson,
  TAG,
  grantCompetitionPassSql,
  competitionPath,
  planCapSql,
  planFlagSql,
} from "./helpers";
// Prices from the seed, never from a literal — this file has carried a stale
// one through two reprices already. The two RUNG lists come from here for a
// harder reason: `SELLABLE_PASS_KEYS` in src/lib/currency.ts is the authority
// (owner decision 2026-09-05 took the L rung off sale), but a VALUE import of
// it drags the app's bare `stripe-plans.json` import into Playwright's ESM
// loader, which refuses the JSON and makes this whole spec collect ZERO TESTS —
// silently, in the usual runner output. See e2e/price-kit.ts's header.
import {
  HIDDEN_PASS_RUNGS,
  SELLABLE_PASS_RUNGS,
  passLabel,
  proAnnualPerMonthLabel,
} from "./price-kit";

// PROMPT-36 (v3/07): pricing page renders three offers from plan_entitlements
// with a working currency switcher and zero "Business"; the in-competition
// two-button gate lifts for THAT competition once a pass lands. Serial: the
// community org's competitions.max_active slot is shared state.

const GENERIC = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

test.describe("pricing page v3", () => {
  test("three columns from data, currency switch, no Business", async ({ browser }) => {
    // Marketing surface — assert it exactly as an anonymous visitor sees it.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/pricing");
      const matrix = page.locator("[data-pricing-matrix]");
      await expect(matrix).toBeVisible();

      // THE COLUMN SET, read out of the DOM rather than counted. `<th>` carries
      // `data-pricing-column` with the plan key, so this compares the rendered
      // set against the authority instead of a list typed here — and the
      // ordinals below stop being positions somebody has to keep in step.
      //
      // It used to assert "Event Pass M" and "Event Pass L" as headings. The L
      // rung came off sale on 2026-09-05, which removed a column and shifted
      // Pro left; every hardcoded index in this block was silently about the
      // wrong plan for as long as that went unnoticed. Nothing here is an index
      // any more.
      const columns = await matrix.locator("thead th[data-pricing-column]").evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-pricing-column")!),
      );
      expect(columns).toEqual(["community", ...SELLABLE_PASS_RUNGS, "pro"]);
      for (const hidden of HIDDEN_PASS_RUNGS) expect(columns).not.toContain(hidden);
      expect(HIDDEN_PASS_RUNGS.length).toBeGreaterThan(0);

      /** One value cell, addressed by PLAN rather than by ordinal. Cell 0 of a
       *  row is the feature label (a `<td>`), so the plan columns start at 1. */
      const cell = (label: string, plan: string) =>
        matrix
          .locator("tr", { hasText: label })
          .locator("td")
          .nth(columns.indexOf(plan) + 1);

      /** THE RESOLVER'S OWN FALL-THROUGH, mirrored: a key a PASS rung has no
       *  row for resolves to the community plan's, so the table renders
       *  community's value in that column (`cellAt` in lib/pricing-matrix.ts).
       *  Reading the rung's own row alone would expect a dash where the page
       *  correctly prints a tick. */
      const isPassColumn = (plan: string) =>
        ([...SELLABLE_PASS_RUNGS, ...HIDDEN_PASS_RUNGS] as readonly string[]).includes(plan);

      /** The cap as the page renders it: a number, ∞ for a null int_value
       *  (UNLIMITED), and an em dash for no row at all. Three outcomes, because
       *  collapsing the last two lets "∞" satisfy a plan with no such grant. */
      const capText = async (feature: string, plan: string): Promise<string> => {
        let value = await planCapSql(feature, plan);
        if (value === undefined && isPassColumn(plan)) value = await planCapSql(feature, "community");
        return value === undefined ? "—" : value === null ? "∞" : String(value);
      };

      /** …and the same fall-through for a boolean row. */
      const flagText = async (feature: string, plan: string): Promise<string> => {
        let value = await planFlagSql(feature, plan);
        if (value === undefined && isPassColumn(plan)) value = await planFlagSql(feature, "community");
        return value === true ? "✓" : "—";
      };

      await expect(matrix.locator("tbody")).toContainText("Entrants per division");

      // Every figure below is READ FROM plan_entitlements. They were literals,
      // and the literals had already gone stale twice on this branch alone —
      // V393 gave the pass rungs new caps and V398 re-cut the whole fee ladder,
      // both after these lines were written. A pricing table that quotes the
      // matrix has to be ASSERTED against the matrix, or the test is a second,
      // slower copy of the same guess.
      for (const plan of columns) {
        await expect(cell("Divisions per competition", plan), `divisions/${plan}`).toHaveText(
          await capText("divisions.per_competition.max", plan),
        );
        await expect(cell("Entrants per division", plan), `entrants/${plan}`).toHaveText(
          await capText("entrants.per_division.max", plan),
        );
        await expect(cell("Platform fee on entry fees", plan), `fee/${plan}`).toContainText(
          `${await capText("registration.fee_percent", plan)}%`,
        );
      }
      // …and the two rows that carry a TICK rather than a number, which is a
      // different renderer and its own failure mode.
      for (const [label, feature] of [
        ["Public player profiles", "dashboard.player_profiles"],
        ["Custom branding", "branding"],
      ] as const) {
        for (const plan of columns) {
          await expect(cell(label, plan), `${feature}/${plan}`).toHaveText(
            await flagText(feature, plan),
          );
        }
      }
      // Anti-vacuity: the entrants row must actually DIFFER across the columns,
      // or every assertion above is satisfied by one number repeated.
      const entrants = await Promise.all(
        columns.map((p) => capText("entrants.per_division.max", p)),
      );
      expect(new Set(entrants).size).toBeGreaterThan(1);

      // The dark Business plan never surfaces on marketing pages (v3/03 §6).
      expect(await page.locator("body").innerText()).not.toContain("Business");

      // Annual is the default framing; the currency switcher re-prices.
      await expect(page.locator("[data-annual-toggle]")).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("main")).toContainText("$");
      await page.locator("[data-currency-switcher]").selectOption("gbp");
      // Annual framing renders `round(annual / 12)`, formatted. DERIVED, not
      // typed: this figure has been wrong twice already — £33 (which was Pro
      // Plus monthly, not an annual twelfth) then £10.42 (correct until the
      // charm reprice moved the annual point). `proAnnualPerMonthLabel` is the
      // page's own derivation, the one marketing/pricing/page.tsx hands
      // ProPriceCard, so the expectation now moves with the seed.
      await expect(page.locator("main")).toContainText(proAnnualPerMonthLabel("gbp"), {
        timeout: 15_000,
      });
    } finally {
      await ctx.close();
    }
  });
});

test.describe.serial("event pass gate (community org)", () => {
  test.use({ storageState: "e2e/.auth/community.json" });

  test("division cap shows the two-button gate; a pass lifts this comp only", async ({
    page,
    request,
  }) => {
    // This test owns the community org's whole quota story, and earlier
    // serial specs legitimately leave active competitions behind (journey-
    // community's `Limits …` comp keeps serving its later gating tests).
    // Sweep EVERY active competition — not just our own leftovers — so the
    // free max_active slot is provably empty before we count against it.
    const leftovers = await apiJson<{ items: { id: string; name: string }[] }>(
      request,
      "/api/v1/competitions",
    );
    for (const c of leftovers.data?.items ?? []) {
      await apiJson(request, `/api/v1/competitions/${c.id}`, "PATCH", {
        status: "archived",
        visibility: "private",
      });
    }

    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `Pass Gate ${TAG}`, visibility: "private" },
    );
    const compId = comp.data!.id;
    const orgId = (
      await apiJson<{ id: string }[]>(request, "/api/orgs")
    ).data![0]!.id;

    // Fill the free quota (4 divisions), then hit the wall.
    for (const name of ["One", "Two", "Three", "Four"]) {
      const d = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
      expect(d.status).toBe(201);
    }
    const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Five",
      ...GENERIC,
    });
    expect(gated.status).toBe(402);

    // The gate renders where the limit bites: submitting a 3rd division in
    // the builder 402s and the paywall offers BOTH paths (v3/07 §3) — the
    // one-time pass CTA links to this competition's upgrade page.
    // One navigation, straight to the builder. The `waitForURL` that used to sit
    // between two `goto`s was waiting out a redirect that no longer happens —
    // `competitionPath` resolves the slug itself, so the pattern matched the URL
    // the first `goto` had already landed on and the wait was vacuous.
    await page.goto(await competitionPath(page.request, compId, "/d/new"));
    await page.getByPlaceholder("U16 Boys T20").fill("Gate Trigger");
    // The builder is a stepped wizard — submit lives on the last tab.
    await page.getByRole("button", { name: "Scheduling" }).click();
    await page.getByRole("button", { name: "Create division" }).click();
    const gate = page.locator("[data-pass-gate]").first();
    await expect(gate).toBeVisible({ timeout: 20_000 });
    // The CTA quotes the floor of what this org can actually buy — M, on a
    // community plan. Its negative pair is the `data-pass-owned` assertion at
    // the foot of this test, which needs this same string to mean anything.
    await expect(gate.locator("[data-pass-cta]")).toContainText(passLabel("event_pass"));
    const passHref = await gate.locator("[data-pass-cta]").getAttribute("href");
    // The gate appends `?feature=<key>` so the upgrade page can render its
    // ceiling state; anchor on the path, not the whole string.
    expect(passHref).toMatch(new RegExp(`/c/${comp.data!.slug}/upgrade(\\?|$)`));
    expect(passHref).toContain("feature=divisions.per_competition.max");

    // Purchase (SQL analogue — test-infra convention), then the gate lifts…
    // The 402 above cached this org's resolved limit server-side, so the
    // grant must also bust the entitlement cache (staging has Redis).
    await grantCompetitionPassSql(orgId, compId, "event_pass", request);
    const fifth = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Five",
      ...GENERIC,
    });
    expect(fifth.status).toBe(201);

    // …the upgrade page confirms, and the pass frees the active-comp slot
    // for a sibling that stays community-capped.
    await page.goto(passHref!);
    await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });

    // …and from here on, no gate under this competition offers the pass a
    // second time (spec D1). Assert that where the pass's OWN ceiling bites —
    // the division cap, M's 10 — because that is the surface still gated for a
    // holder. This block used to read the competition-wide schedule board on
    // the premise that it was Pro-only and the pass never lifted it; V353
    // (#382/#478) granted `scheduling.multi_division` to event_pass, so that
    // page renders the real board and emits no gate at all. #478 migrated the
    // sibling assertions in event-pass.spec.ts and pro-plus-tier.spec.ts onto
    // the still-unlifted key and left this one behind — the "element(s) not
    // found" was the stale premise, not a regression.
    for (const name of ["Six", "Seven", "Eight", "Nine", "Ten"]) {
      const d = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
      expect(d.status).toBe(201);
    }
    const eleventh = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Eleven",
      ...GENERIC,
    });
    expect(eleventh.status).toBe(402);

    await page.goto(passHref!.replace(/\/upgrade(\?.*)?$/, "/d/new"));
    await page.getByPlaceholder("U16 Boys T20").fill("Owned Card");
    await page.getByRole("button", { name: "Scheduling" }).click();
    await page.getByRole("button", { name: "Create division" }).click();
    // Scoped to the feature that actually bit, never `.first()` — the same
    // reason event-pass.spec.ts scopes it: `.first()` reads whichever gate
    // happens to come first on the page and asserts nothing about divisions.
    const owned = page.locator('[data-pass-owned][data-feature="divisions.per_competition.max"]');
    await expect(owned).toBeVisible({ timeout: 20_000 });
    // `grantCompetitionPassSql` grants M, and since v17 #294 this card names
    // the rung rather than the product family.
    await expect(owned).toContainText("Event Pass M active");
    // The negative half of the CTA assertion above, and only meaningful
    // because it names the string this very test watched the page render
    // before the pass landed. A retired price passes here unconditionally.
    await expect(owned).not.toContainText(passLabel("event_pass"));
    await expect(page.locator("[data-pass-cta]")).toHaveCount(0);

    const sibling = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Pass Gate Sibling ${TAG}`,
      visibility: "private",
    });
    expect(sibling.status).toBe(201);
    for (const name of ["S1", "S2", "S3", "S4"]) {
      await apiJson(request, `/api/v1/competitions/${sibling.data!.id}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
    }
    const siblingGated = await apiJson(
      request,
      `/api/v1/competitions/${sibling.data!.id}/divisions`,
      "POST",
      { name: "S5", ...GENERIC },
    );
    expect(siblingGated.status).toBe(402);

    // Cleanup: free the community org's shared slots for later suites.
    await apiJson(request, `/api/v1/competitions/${sibling.data!.id}`, "PATCH", {
      status: "archived",
      visibility: "private",
    });
    await apiJson(request, `/api/v1/competitions/${compId}`, "PATCH", {
      status: "archived",
      visibility: "private",
    });
  });
});
