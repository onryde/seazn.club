// R7 — the console chrome walkthrough. Read `README.md` in this folder first.
//
// This wave rearranged the screen an organiser looks at on EVERY fixture of
// EVERY sport: three history surfaces became one, the match-lifecycle controls
// moved out of a bare unlabelled row into a captioned band, device handover
// moved up beside the pad, and the two "Undo" controls stopped sharing a word
// while behaving differently.
//
// What only a walkthrough sees, and why each of these is here:
//
//  - THE VOID-A-VOID. `latestEvent` was the newest event, unfiltered, so after
//    any undo the ribbon offered the `core.void` itself — which
//    `resolveVoids` (core/events.ts) hard-refuses: "voids are not themselves
//    voidable". Undo twice and the second one threw. No unit test saw it
//    because the ribbon's target is computed from live pad state, and no
//    API-driven spec saw it because the API never presses the ribbon.
//  - THE DEAD TAP. A per-row Void that renders enabled and does nothing during
//    the sync window after every pad event. A screenshot proves a button was
//    painted; only pressing it proves it works.
//  - THE DEVICE-LINK NON-LEAK. `/score/[token]` has no page chrome, so the
//    pad's panel is the ONLY history a courtside scorer sees. It must render —
//    and it must NOT bring void authority or the audit download with it.
//  - THE ABSENCE. A one-player sport must show no lineup editor at all. The
//    absence is the feature, so it is asserted anchored on `="` — React
//    serialises an omitted prop as "$undefined" and a bare probe passes in
//    both states.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "../helpers";
import { waitForHydration } from "../directory-kit";

const SHOTS = process.env.R7_SHOT_DIR ?? "/tmp/r7-shots";

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function activity(page: Page) {
  return page.locator('[data-role="v3-activity"]');
}

async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ type: string; id: string }[]> {
  const { data } = await apiJson<{ type: string; id: string }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events`,
  );
  return data ?? [];
}

async function openConsole(page: Page, fx: RosteredFixture): Promise<string> {
  const path = await fixturePath(page.request, fx.fixtureId);
  await page.goto(path);
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  // `goto` returns at `load`, before React hydrates, and the pad is
  // server-rendered — so "visible" is true while every button is still inert.
  // CI run 35867611673 (PR #848): "Start match" clicked in that window sent
  // nothing, and the ledger poll then waited out 20s on `[]`.
  await waitForHydration(pad(page));
  return path;
}

// ---------------------------------------------------------------------------

test("R7 console: one ledger with provenance, a labelled band, handover beside the pad", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const scorer = `R7W Scorer ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `R7 Walk Console ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: scorer, positionKey: "FW" },
      { fullName: `R7W Assist ${TAG}`, positionKey: "MF" },
    ],
    away: [{ fullName: `R7W Away ${TAG}`, positionKey: "GK" }],
  });

  await openConsole(page, fx);
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), {
      timeout: 20_000,
    })
    .toContain("core.start");

  // Score two goals THROUGH THE PAD, not the API — the payload the client
  // builds is the thing under test everywhere else in this wave.
  await v3Tile(page, "goal-home").click();
  await pad(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length, {
      timeout: 20_000,
    })
    .toBe(1);

  // ONE ledger. The console rendered two before this wave; the pad's ribbon is
  // a third surface and stays, because it is the last-event strip, not history.
  await expect(activity(page), "exactly one Activity panel on the console").toHaveCount(1);

  // Provenance moved IN from the deleted page-level panel.
  await expect(activity(page).locator('[data-role="v3-activity-seq"]').first()).toBeVisible();
  await expect(activity(page).locator('[data-role="v3-activity-provenance"]').first()).toBeVisible();

  // The authority band exists, is labelled, and says what it costs.
  const band = page.locator('[data-role="match-actions"]');
  await expect(band).toHaveCount(1);
  await expect(band).toContainText(/cannot be undone/i);

  // Handover moved up beside the pad header — it used to be the last card on
  // the page, below the audit.
  const handover = page.locator('[data-role="device-handover"]');
  await expect(handover).toHaveCount(1);
  const handoverBox = await handover.boundingBox();
  const bandBox = await band.boundingBox();
  expect(handoverBox, "handover renders").not.toBeNull();
  expect(bandBox, "band renders").not.toBeNull();
  expect(
    handoverBox!.y,
    "handover sits ABOVE the match-actions band — D-19 was that it sat below everything",
  ).toBeLessThan(bandBox!.y);

  await page.screenshot({ path: `${SHOTS}/walk-console-1280.png`, fullPage: true, animations: "disabled" });
});

// ---------------------------------------------------------------------------

test("R7 pad: Take back twice in a row — the second one used to throw", async ({ page }) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `R7 Walk Undo ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `R7W U Scorer ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `R7W U Away ${TAG}`, positionKey: "GK" }],
  });
  await openConsole(page, fx);
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");

  for (const side of ["goal-home", "goal-away"]) {
    await v3Tile(page, side).click();
    await pad(page).getByRole("button", { name: "Send now", exact: true }).click();
    await page.waitForTimeout(700);
  }
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length, {
      timeout: 20_000,
    })
    .toBe(2);

  const ribbon = pad(page).locator('[data-role="v3-ribbon"]');
  const takeBack = ribbon.getByRole("button");

  // FIRST take-back: voids the newest goal.
  await expect(takeBack).toBeVisible();
  await takeBack.click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length, {
      timeout: 20_000,
    })
    .toBe(1);

  // THE FIX, observed rather than assumed. Before this wave the ribbon's target
  // was the newest event UNFILTERED — which after a void IS the `core.void` —
  // so the button stayed and the engine refused it with INVALID_EVENT, "voids
  // are not themselves voidable". The organiser got an error for pressing the
  // same button twice.
  //
  // The fix does not make a second take-back work; it makes the pad stop
  // OFFERING one, which is the honest answer: you cannot take back a take-back.
  // The ribbon now reads "Entry undone" with no control beside it.
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await expect(ribbon, "the ribbon now reports the undo itself").toContainText(/undone/i);
  await expect(
    takeBack,
    "no take-back is offered on a void — the pad must not promise what the engine refuses",
  ).toHaveCount(0);

  // And the earlier goal is STILL retractable — from the ledger, whose per-row
  // Void is the surface that owns "strike a specific recorded row". The two
  // controls agreeing is the whole point of `ribbonUndoTarget` delegating to
  // `activityRowState`.
  const liveRows = activity(page)
    .locator('[data-role="v3-activity-row"]')
    .filter({ hasNot: page.locator("s, del, [data-voided]") });
  const rowVoid = activity(page).locator('[data-role="v3-activity-void"]');
  await expect(rowVoid.first(), "the ledger still offers Void on a live row").toBeVisible();
  await rowVoid.first().click();

  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length, {
      timeout: 20_000,
    })
    .toBe(2);

  const rows = await ledger(page.request, fx.fixtureId);
  expect(rows.filter((e) => e.type === "core.void")).toHaveLength(2);
  expect(
    errors.filter((e) => /INVALID_EVENT|not themselves voidable/i.test(e)),
    "nothing the pad offered was refused by the engine",
  ).toHaveLength(0);
  void liveRows;

  await page.screenshot({ path: `${SHOTS}/walk-undo-twice.png`, fullPage: true, animations: "disabled" });
});

// ---------------------------------------------------------------------------

test("R7 device link: history renders, and neither void authority nor the audit follows it", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `R7 Walk Device ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `R7W D Scorer ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `R7W D Away ${TAG}`, positionKey: "GK" }],
  });
  await openConsole(page, fx);
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");

  // Mint the link THROUGH THE UI — D-19's control, in its new home beside the
  // pad header rather than at the foot of the page.
  // `data-role="device-handover"` IS the disclosure button, not a wrapper.
  const handover = page.locator('[data-role="device-handover"]');
  await expect(handover).toHaveAttribute("aria-expanded", "false");
  await handover.click();
  await expect(handover).toHaveAttribute("aria-expanded", "true");

  // The minted URL is rendered as TEXT in the panel (device-link-panel.tsx
  // prints `padUrl` in a <p>, alongside the QR) — not in an input.
  const panel = page.locator('[data-role="device-link-panel"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // Opening the panel does not mint anything — the link is created on demand,
  // shown once, and is day- and fixture-scoped. Press the control a real
  // organiser presses.
  await panel.getByRole("button").first().click();

  await expect
    .poll(async () => (await panel.innerText().catch(() => "")).includes("/score/"), { timeout: 20_000 })
    .toBe(true);
  const token = (await panel.innerText()).split("/score/")[1]!.split(/\s/)[0]!.trim();
  expect(token, "a device-link token was minted through the UI").toMatch(/^[A-Za-z0-9._-]{8,}$/);

  // A courtside device: its OWN browser context, no session cookie.
  const device = await context.browser()!.newContext();
  const dp = await device.newPage();
  await dp.goto(`${new URL(page.url()).origin}/score/${token}`);
  await expect(dp.locator('[data-role="pad-v3"]')).toBeVisible({ timeout: 20_000 });

  // Score from the DEVICE, which is the whole point of handover.
  await dp.locator('[data-tile-id="goal-home"]').click();
  await dp.getByRole("button", { name: "Send now", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length, {
      timeout: 20_000,
    })
    .toBe(1);

  // The regression C1 could have caused: the device link has no page chrome, so
  // if the surviving panel had been the page-level one this screen would have
  // no history at all.
  await expect(dp.locator('[data-role="v3-activity"]'), "the device link still has a history").toHaveCount(1);
  await expect(dp.locator('[data-role="v3-activity-row"]').first()).toBeVisible();

  // The console-only affordances must NOT have come with it.
  //
  // The rule is finer than "a device link cannot void" — a first draft of this
  // spec asserted that and was wrong. A courtside scorer MAY retract their own
  // mistake; what they may not do is reach into rows somebody else recorded.
  // `server/usecases/scoring.ts` refuses the latter with a 403, so a pad that
  // offered it would be promising what the server rejects.
  const deviceRows = dp.locator('[data-role="v3-activity-row"]');
  const ownRow = deviceRows.filter({ hasText: "Goal recorded" });
  const consoleRow = deviceRows.filter({ hasText: "Match started" });

  await expect(ownRow, "the device's own goal is listed").toHaveCount(1);
  await expect(
    ownRow.locator('[data-role="v3-activity-void"]'),
    "a courtside scorer CAN retract the goal they just recorded",
  ).toHaveCount(1);
  await expect(
    consoleRow.locator('[data-role="v3-activity-void"]'),
    "…and CANNOT touch a row the console recorded — the server 403s it",
  ).toHaveCount(0);

  const body = await dp.content();
  expect(body, "no audit strip on a device link").not.toContain('data-testid="audit-strip"');
  expect(
    body,
    "no recorded-by attribution on a device link — that half is console-only",
  ).not.toContain('data-role="v3-activity-provenance-actor"');
  await expect(
    dp.getByText(/recorded by/i),
    "a device link names no actor",
  ).toHaveCount(0);

  await dp.screenshot({ path: `${SHOTS}/walk-devicelink.png`, fullPage: true, animations: "disabled" });
  await device.close();
});

// ---------------------------------------------------------------------------

test("R7 lineup: a one-player sport shows no editor, and football names what its side still needs", async ({
  page,
}) => {
  test.setTimeout(180_000);

  // Football: a side with no goalkeeper must be TOLD, in words, what is missing.
  const fb = await seedRosteredFixture(page.request, {
    label: `R7 Walk Lineup FB ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `R7W L Fwd ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `R7W L Gk ${TAG}`, positionKey: "GK" }],
  });
  await openConsole(page, fb);
  await expect(
    page.getByText(/still needs/i).first(),
    "the side without a keeper is told so, before anyone tries to score",
  ).toBeVisible({ timeout: 20_000 });

  // ANTI-VACUITY. The chess half below asserts an ABSENCE, and an absence probe
  // is worthless unless the same anchor is proven to APPEAR somewhere. So the
  // anchor is pinned positive here, on the same run, before it is pinned
  // negative there. (A first draft of this spec probed `data-role=
  // "lineup-editor"` — wrong ATTRIBUTE, not a wrong claim: the component's own
  // root carries `data-testid="lineup-editor"`, lineup-editor.tsx:378 — and
  // concluded no anchor existed, falling back to `availability-chip`. That
  // reuse broke the same wave it was written in: `<AvailabilityRoster>`
  // — the sibling component `lineupEditorApplies` renders INSTEAD of
  // `<LineupEditor>` for a one-player sport — renders its own
  // `availability-chip` per roster member, so a 1-member chess side makes the
  // "absent" anchor appear too. `lineup-editor` is exclusive to the real
  // editor; `<AvailabilityRoster>` carries `data-testid="availability-roster"`.)
  const editorAnchor = '[data-testid="lineup-editor"]';
  const footballEditors = await page.locator(editorAnchor).count();
  expect(footballEditors, "the anchor must actually appear where the editor DOES render").toBeGreaterThan(0);
  expect(await page.content()).toContain('data-testid="lineup-editor"');

  await page.screenshot({ path: `${SHOTS}/walk-lineup-needs.png`, fullPage: true, animations: "disabled" });

  // Chess: one player a side, no bench. The editor must not render AT ALL —
  // before this wave it drew an eleven-slot team table for a game of chess.
  const chess = await seedRosteredFixture(page.request, {
    label: `R7 Walk Lineup Chess ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `R7W C White ${TAG}` }],
    away: [{ fullName: `R7W C Black ${TAG}` }],
  });
  const chessPath = await fixturePath(page.request, chess.fixtureId);
  await page.goto(chessPath);
  await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });

  // The ABSENCE is the assertion — and it uses the SAME anchor proven present
  // on football above, anchored on `="` because React serialises an omitted
  // prop as "$undefined" and a bare `data-*` probe passes in both states.
  const html = await page.content();
  expect(html, "no lineup editor for a one-player sport").not.toContain(
    'data-testid="lineup-editor"',
  );
  await expect(page.locator(editorAnchor)).toHaveCount(0);

  // And the fixture really did load — otherwise "the editor is absent" is just
  // "the page is absent", which is the shape that makes an absence test lie.
  await expect(page.getByText(`R7W C White ${TAG}`).first()).toBeVisible({ timeout: 20_000 });

  await page.screenshot({ path: `${SHOTS}/walk-lineup-absent.png`, fullPage: true, animations: "disabled" });
});
