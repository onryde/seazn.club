// The gantry must keep every control REACHABLE when a club has an ordinary
// full-length name.
//
// Found 2026-09-20 while verifying an unrelated Connect banner. The chip
// carried `shrink-0` with no `min-w-0` and no `truncate`, so its width was
// simply the org NAME's width, and the right-hand group was squeezed from
// 553px to 336px at 768 — the help icon rendered sliced in half at the
// viewport edge and the account control and Sign out button were off-screen
// entirely.
//
// NOTE the symptom, because the obvious gate does NOT see it:
// `document.scrollWidth - clientWidth` is 0 at every width, before and after.
// The page never scrolled. The header ROW overflowed by 125px, and that
// overflow was clipped rather than scrollable, so the controls were simply
// gone with no way to reach them — strictly worse than a scrollbar. An
// `expectNoHorizontalScroll` assertion passes in both states, which is why
// this file measures the ROW and the controls instead
// ([[reference_no_horizontal_scroll_gate_cannot_see_layout]]).
//
// Row overflow measured against name length BEFORE the fix, at 768:
//     2 chars → 0px · 17 chars → 0px · 38 chars → 125px · 61 chars → 247px
// So the trigger is a name like "Northamptonshire Badminton Association", not
// an adversarial one — and a 2-char fixture name is exactly why the existing
// width matrix never caught it. Every org seeded below is therefore named
// REALISTICALLY; a short name here would make this file vacuous.
//
// 768 is the pinch point specifically because the nav LABELS switch on at
// `md`=768: 700px is better off than 768px. Above it the chip recovers
// linearly (800→86 · 850→136 · 900→186 · 1024→272=full).
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, loginUi, expectNoHorizontalScroll } from "./helpers";

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A signed-in org whose NAME is the variable under test. */
async function seedNamedOrg(name: string): Promise<{ slug: string; email: string }> {
  const tag = randomBytes(5).toString("hex");
  const email = `delivered+chip-${TAG}-${tag}@resend.dev`;
  const slug = `chip-${TAG}-${tag}`;
  await withDb(async (sql) => {
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${email}, ${OWNER_NAME}, true) returning id`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${name}, ${slug}, 'active', ${owner!.id}) returning id`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${org!.id}, ${owner!.id}, 'owner')`;
  });
  return { slug, email };
}

async function signIn(page: Page, email: string): Promise<void> {
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
}

// The chip is `sm:flex` — hidden below 640 — so 320 is the control and 768 is
// the width that actually carries it. Both are in the standing width bar.
const WIDTHS = [320, 768, 1280] as const;

// 38 chars. A real club name, not a stress string: the point is that ORDINARY
// input broke this, so a 200-character name would prove something weaker.
const LONG_NAME = "Northamptonshire Badminton Association";

// The signed-in viewer's own display name — folded away in the 768-1023 band.
const OWNER_NAME = "Chip Owner";

test.describe("gantry org chip does not push the page sideways", () => {
  test("a 38-character club name leaves the gantry row un-overflowed at every width", async ({
    page,
  }) => {
    const org = await seedNamedOrg(LONG_NAME);
    await signIn(page, org.email);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${org.slug}/settings/connect`);
      // Anchored on the gantry, not on networkidle: the chip renders with the
      // server payload, so once the header is attached the measurement is real.
      await expect(page.locator("header.app-gantry")).toBeVisible();
      // The page-level gate is kept as a cheap backstop, but it is NOT what
      // proves this fix — it reported 0px in the broken state too.
      await expectNoHorizontalScroll(page);

      const row = await page.evaluate(() => {
        const r = document.querySelector("header.app-gantry > div") as HTMLElement | null;
        if (!r) return null;
        return { overflow: r.scrollWidth - r.clientWidth };
      });
      expect(row, `the gantry row exists at ${width}`).not.toBeNull();
      expect(row!.overflow, `gantry row overflow at ${width}`).toBe(0);
    }
  });

  test("Sign out stays inside the viewport at 768 — the control the break cost", async ({
    page,
  }) => {
    // The defect's real consequence, asserted on the control a user loses
    // rather than on a pixel count. Pre-fix this button's right edge sat at
    // ~877 against a 768 viewport, clipped and unreachable.
    const org = await seedNamedOrg(LONG_NAME);
    await signIn(page, org.email);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/o/${org.slug}/settings/connect`);

    const signOut = page.locator("header.app-gantry").getByRole("button", { name: /sign out/i });
    await expect(signOut).toBeVisible();
    const box = await signOut.boundingBox();
    expect(box, "Sign out has a box at 768").not.toBeNull();
    expect(box!.x, "Sign out starts inside the viewport").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "Sign out ENDS inside the viewport").toBeLessThanOrEqual(768);
  });

  test("the chip still SHOWS the club name at 768 — truncated, not dropped", async ({ page }) => {
    // The positive pair. Without it, `display: none` on the chip would satisfy
    // every assertion above while deleting the feature, and shrinking it to
    // zero width would too. A club has to still see which org it is in.
    const org = await seedNamedOrg(LONG_NAME);
    await signIn(page, org.email);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/o/${org.slug}/settings/connect`);

    const chip = page.locator('[data-tour="org-chip"]');
    await expect(chip).toBeVisible();
    // It carries the real name in the DOM (so screen readers and the product
    // tour still get it) even where the pixels are clipped.
    await expect(chip).toContainText("Northamptonshire");

    // The floor is DERIVED from the chip's own rendered font, not typed in as
    // a pixel count. Two reasons. A literal would freeze today's measurement
    // and stop tracking the thing it exists to protect (how much NAME a
    // person can read); and CI renders wider than this machine, so a local
    // pixel constant is a latent red there
    // ([[reference_e2e_pixel_geometry_calibrated_to_local_font_metrics]]).
    // Eight characters is the bar: enough to tell two clubs apart, which is
    // the chip's entire job. `N\u2026` (the pre-option-B state, 55px) fails it.
    const m = await chip.evaluate((el) => {
      const text = el.querySelector("span.truncate") as HTMLElement | null;
      if (!text) return null;
      const cs = getComputedStyle(text);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return {
        visibleTextPx: text.clientWidth,
        eightCharsPx: ctx.measureText("Northampt").width,
        chipPx: el.getBoundingClientRect().width,
      };
    });
    expect(m, "the chip has a truncating text span").not.toBeNull();
    expect(
      m!.visibleTextPx,
      `the chip shows >=8 characters of the club name (${Math.round(m!.visibleTextPx)}px vs ${Math.round(m!.eightCharsPx)}px needed)`,
    ).toBeGreaterThanOrEqual(m!.eightCharsPx);
    // ...and it cannot be so wide that it owns the row it shares.
    expect(m!.chipPx, "the chip does not monopolise the gantry").toBeLessThan(768 * 0.6);
  });

  test("a short club name is unchanged — the fix costs nothing at the low end", async ({ page }) => {
    // Regression guard on the other direction: `truncate` + `min-w-0` must not
    // start clipping a name that always fitted. "FC" is 2 chars and measured
    // 0px overflow before the fix, so this test would have passed then too —
    // deliberately, because its job is to catch the fix OVER-correcting.
    const org = await seedNamedOrg("FC");
    await signIn(page, org.email);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/o/${org.slug}/settings/connect`);

    const chip = page.locator('[data-tour="org-chip"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/FC/);
    await expectNoHorizontalScroll(page);
    // No ellipsis on a name that fits: scrollWidth must not exceed clientWidth
    // on the truncating span itself.
    const clipped = await chip.evaluate((el) => {
      const span = el.querySelector("span:last-child") as HTMLElement | null;
      return span ? span.scrollWidth > span.clientWidth + 1 : false;
    });
    expect(clipped, "a short name is not truncated").toBe(false);
  });

  test("the viewer's OWN name yields the band to the club name, and returns at lg", async ({
    page,
  }) => {
    // Option B, owner-approved 2026-09-21. At 768-1023 the gantry cannot fit
    // both the org chip and the viewer's display name; the 76px goes to the
    // chip (55px -> 143px). This is the fold's BOTH-DIRECTIONS pair: a
    // one-sided assertion here would be satisfied by deleting the span
    // outright, which is a different and worse change.
    //
    // `toBeAttached` is deliberately NOT used on the hidden side: this span is
    // folded by `hidden lg:block`, so it stays in the markup at 768 and an
    // attachment check would pass in both states
    // ([[reference_tobeattached_rescues_fold_not_conditional_render]]).
    // Visibility is exactly what the fold denies, so visibility is the assertion.
    const org = await seedNamedOrg(LONG_NAME);
    await signIn(page, org.email);
    const ownName = page.locator("header.app-gantry").getByText(OWNER_NAME, { exact: true });

    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/o/${org.slug}/settings/connect`);
    await expect(page.locator("header.app-gantry")).toBeVisible();
    await expect(ownName, "the viewer's own name is folded away at 768").toBeHidden();

    // The positive pair, at the first width that carries both.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${org.slug}/settings/connect`);
    await expect(ownName, "the viewer's own name returns at 1280").toBeVisible();
    // ...and the club name is unclipped there, so nothing was traded at 1280.
    const full = await page.locator('[data-tour="org-chip"]').evaluate((el) => {
      const t = el.querySelector("span.truncate") as HTMLElement;
      return t.scrollWidth <= t.clientWidth + 1;
    });
    expect(full, "the club name is NOT truncated at 1280").toBe(true);
  });
});
