import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

/**
 * The division wizard's schedule seed refuses a backwards range in the panel.
 *
 * Why this needs a browser rather than a unit test: the predicate
 * (`endDateIsBackwards`) has its own suite, but nothing there proves the
 * WIZARD calls it — and the wizard cannot be mounted in this repo's suite
 * (`useLocale()` throws outside a `DictProvider`, and apps/web has no jsdom).
 * Deleting the guard from `submit()` leaves every unit test green.
 *
 * The failure it prevents is silent by construction: the schedule-settings
 * seed PUT is wrapped in a deliberate try/catch so a paywalled court list
 * cannot block the create, so the server's refusal (#498) was swallowed and
 * the organiser got a division with no dates and no message. The end-date
 * input's `min=` is advisory only — a typed or pasted value walks past it.
 *
 * SELECTORS ARE TESTIDS, NEVER COPY (#465).
 */
test("the division wizard refuses a backwards schedule range, and creates nothing", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Date order ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
    ends_on: "2030-12-31",
  });
  const compId = comp.data!.id;
  const countDivisions = async () => {
    const res = await apiJson<unknown[]>(request, `/api/v1/competitions/${compId}/divisions`);
    expect(res.status).toBe(200);
    return (res.data ?? []).length;
  };
  expect(await countDivisions()).toBe(0);

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/new`);
  const name = page.getByTestId("division-builder-name");
  await expect(name).toBeVisible({ timeout: 20_000 });
  await name.fill(`Backwards ${TAG}`);

  // Walk to the last tab. Bounded rather than a fixed count so adding a step
  // to the wizard does not silently make this test stop reaching the dates.
  const create = page.getByTestId("division-builder-create");
  const next = page.getByTestId("division-builder-next");
  for (let i = 0; i < 8 && !(await create.isVisible()); i += 1) {
    await next.click();
  }
  await expect(create).toBeVisible();
  await expect(create).toBeEnabled();

  // End the day BEFORE the start. Both controls live on this tab; `fill`
  // writes what the organiser would have typed, which is exactly the input the
  // advisory `min=` does not stop. Start is a native date input + time
  // <select> now, not `input[type="datetime-local"]` — Chrome's clock popup
  // ignored `step` (quarter-hour-time-select design doc). The tab now has
  // TWO date inputs (Start's date half plus End's own), so both are addressed
  // by their accessible label rather than `input[type="date"]` position.
  await page.getByLabel("Start date & time").fill("2026-10-12");
  await page.getByLabel("Time", { exact: true }).selectOption("09:00");
  await page.getByLabel("End date").fill("2026-10-11");

  await create.click();

  const error = page.getByTestId("division-builder-error");
  await expect(error).toBeVisible();

  // THE assertions. An error banner proves a message was shown, not that the
  // create was withheld — and "withheld" is the whole point, because a
  // division created here would carry silently-missing dates.
  await expect(page).toHaveURL(/\/d\/new$/);
  expect(await countDivisions()).toBe(0);

  // Control run through the same path: the same wizard, the same fields, the
  // dates the right way round. Without it a wizard that refused EVERY create
  // would satisfy every assertion above.
  await page.getByLabel("End date").fill("2026-10-13");
  await create.click();
  await expect(page).not.toHaveURL(/\/d\/new$/, { timeout: 20_000 });
  expect(await countDivisions()).toBe(1);
});
