import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// PROMPT-52 acceptance: the pulse strip and tab counts match a seeded
// division, the waitlist renders as a numbered queue in joined order, the
// token-gated status page shows "#N in line", and the public register card
// carries the waitlist count.

async function seedRig(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Reg console ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Tiny Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    capacity: 1,
    form_fields: [],
  });
  return { compSlug: comp.data!.slug, divisionId: div.data!.id, divSlug: div.data!.slug };
}

test("pulse, queue order, #N in line, and public waitlist count all match one seeded division", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);

  const submit = (name: string, email: string) =>
    apiJson<{ registration_id: string; access_token: string }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/register`,
      "POST",
      { division_id: rig.divisionId, display_name: name, contact_email: email, privacy_consent: true },
    );

  await submit("Holder One", `holder-${TAG}@e.com`); // takes the only spot (pending)
  await submit("Wait One", `w1-${TAG}@e.com`); // → waitlist #1
  const w2 = await submit("Wait Two", `w2-${TAG}@e.com`); // → waitlist #2

  // Organiser console: pulse numbers + tab counts from the same seed.
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}/registrations`);
  await expect(page.getByTestId("pulse-holding")).toContainText("1", { timeout: 20_000 });
  await expect(page.getByTestId("pulse-waitlisted")).toContainText("2");
  await expect(page.getByTestId("reg-tab-pending")).toContainText("1");
  await expect(page.getByTestId("reg-tab-waitlist")).toContainText("2");

  // Waitlist tab renders the numbered queue in joined order.
  await page.getByTestId("reg-tab-waitlist").click();
  const positions = page.getByTestId("queue-position");
  await expect(positions).toHaveCount(2);
  await expect(positions.nth(0)).toHaveText("#1");
  await expect(positions.nth(1)).toHaveText("#2");
  const queueText = (await page.getByTestId("waitlist-queue").textContent()) ?? "";
  expect(queueText.indexOf("Wait One")).toBeLessThan(queueText.indexOf("Wait Two"));

  // The second waitlisted registrant's token page says #2 in line.
  await page.goto(
    `/shared/${org.slug}/${rig.compSlug}/register/status?rid=${w2.data!.registration_id}&token=${encodeURIComponent(w2.data!.access_token)}`,
  );
  await expect(page.getByTestId("queue-position-public")).toContainText("#2 in line");

  // Public register card shows the queue length behind the full division.
  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await expect(page.getByText("full — waitlist: 2")).toBeVisible();

  // Noticeboard QR (PROMPT-52 follow-up): the link card reveals a data-URL
  // QR of the register link plus a competition-named PNG download.
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}/registrations`);
  await page.getByRole("button", { name: "QR" }).click();
  const qr = page.getByTestId("reg-link-qr");
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/png/);
  await expect(page.getByRole("link", { name: "Download PNG" })).toHaveAttribute(
    "download",
    `register-${rig.compSlug}.png`,
  );
});

// ---------------------------------------------------------------------------
// A backwards registration window is refused in the panel, in the organiser's
// own language, and never reaches the wire.
//
// `registrations.ts` has always refused this with a 422, but the panel renders
// `err.message` raw — so the organiser got an untranslated English server
// string, and only after a round trip. The client guard is what makes the
// refusal localized and immediate; the server one stays as the backstop for
// every other caller of the endpoint.
//
// The load-bearing half is the LAST assertion: an error on screen proves a
// message was shown, not that the save was withheld. Re-reading the stored
// settings is what proves nothing was sent.
// ---------------------------------------------------------------------------
test("a closing time before the opening time is refused in-panel, and never saved", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);

  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}/registrations?tab=settings`);
  const save = page.getByTestId("reg-settings-save");
  await expect(save).toBeVisible({ timeout: 20_000 });

  // Opens AFTER it closes. `input[type="datetime-local"]` is gone — each
  // clock is a native date input beside a native time <select> now (Chrome's
  // clock popup ignored `step`; quarter-hour-time-select design doc). Both
  // time selects share the accessible name "Time" (`selectAriaLabel` beats
  // their own hidden label), so they are told apart by DOM order — Opens
  // above Closes, matching the field order in registration-settings.tsx.
  const opensDate = page.getByLabel("Opens");
  const closesDate = page.getByLabel("Closes");
  const times = page.getByLabel("Time", { exact: true });
  expect(await times.count()).toBeGreaterThanOrEqual(2);
  await opensDate.fill("2026-10-12");
  await times.nth(0).selectOption("18:00");
  await closesDate.fill("2026-10-12");
  await times.nth(1).selectOption("09:00");
  await save.click();

  const err = page.getByTestId("reg-settings-error");
  await expect(err).toBeVisible();
  // Localized, not the server's English. Asserting the absence of the server
  // string is what would catch a "fix" that simply forwarded the 422.
  await expect(err).not.toContainText("closes_at must be after opens_at");

  // THE assertion. The stored settings still hold the seed's nulls, so no PUT
  // was made — an error banner over a saved backwards window would satisfy
  // every check above.
  const stored = await apiJson<{ opens_at: string | null; closes_at: string | null }>(
    request,
    `/api/v1/divisions/${rig.divisionId}/registration-settings`,
  );
  expect(stored.status).toBe(200);
  expect(stored.data!.opens_at).toBeNull();
  expect(stored.data!.closes_at).toBeNull();
});
