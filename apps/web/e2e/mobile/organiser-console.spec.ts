// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): organiser console chrome: the overflow control, settings org card, competition desk (division row, tool row), division header Open menu, decider consoles, Directory tab strip, dual-role header, page smokes, publish gate sheet, lineup editor, z3 schedule actions.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  createStageAndGenerate,
  competitionPath,
  divisionPath,
  fixturePath,
  seedRosteredFixture,
  loginUi,
  claimProfileBySql,
  seedVenueWithCourts,
  setDivisionConfigSql,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
  setStageStatusSql,
} from "../helpers";
import { HIT_TARGET_FLOOR_PX, dismissCookieBanner } from "../scorepad-a11y-kit";
import { openConsolePanel } from "../helpers/console-panels";
import { projectViewport, projectTag, auditRoute } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// The check that guards every other 375px assertion in this file. It compared
// document.scrollWidth against clientWidth, which `overflow-x: clip`
// (globals.css:63) pins to the viewport — so a 525px overflow read as clean.
// This probe is the control: if it ever passes, the helper is blind again and
// every "no horizontal scroll" test in the suite is decorative.
test("CONTROL (#325): the overflow check itself can fail", async ({ page }) => {
  await page.goto("/pricing", { waitUntil: "load" });
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "overflow-probe";
    probe.style.cssText = "width:900px;height:8px;background:transparent";
    document.body.appendChild(probe);
  });
  await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/overflow/i);
  await page.evaluate(() => document.getElementById("overflow-probe")?.remove());
  await expectNoHorizontalScroll(page);
});

/** R3.5 Task A — dispatch a real ledger event, reading `last_seq` fresh each
 *  call. Same shape as gallery.capture.ts's and scorepad-v3-football.spec.ts's
 *  own `postEvent`, needed here to seed the two decider console routes below
 *  without hand-tracking `expected_seq` across a dozen calls. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** R3.5 Task A — MERGE a few cfg keys into the division's existing config,
 *  never replace it (same shape as gallery.capture.ts's own
 *  `mergeDivisionConfig`). Called BEFORE the first event so no fold has read
 *  the old shape. */
async function mergeDivisionConfig(
  request: APIRequestContext,
  divisionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const div = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  if (div.status !== 200 || !div.data) {
    throw new Error(`mergeDivisionConfig: GET division -> ${div.status} ${JSON.stringify(div.error)}`);
  }
  await setDivisionConfigSql(divisionId, { ...div.data.config, ...patch });
}

/**
 * Settings C8 (owner 2026-11-11, mock set11c01 O1) — the Organisation card at
 * `/settings?tab=organization`. It replaced the W2 identity row (avatar, name,
 * role badge, OrgSwitcher), whose phone defect was a name squeezed to a sliver
 * by the chrome beside it; this keeps that defect's gate on the new home of
 * the name.
 *
 * Nothing in `apps/web` vitest can see any of this — that suite is
 * `environment: "node"`, so it has no layout at all — and the page-level
 * no-horizontal-scroll audit passes either way, because a squeezed input
 * produces no page overflow. This is the gate.
 *
 * Two assertions, because either alone is satisfiable the wrong way:
 *
 *  - the name field's RENDERED box is wide enough to read. A reachability
 *    check ("the field is visible") passes at 38px, which was the old defect.
 *  - the card's COMPOSITION: every width project here is below `lg` (1024),
 *    where the card is one column — the long text (About) sits BELOW the
 *    decisions (name, brand colour, defaults), never beside them. A two-column
 *    card at 320 is exactly the squeeze this guards against.
 */
test("settings organisation card: the org name keeps a readable share, and the card is one column below lg", async ({
  page,
}) => {
  const width = projectViewport()?.width ?? 0;

  await page.goto("/settings?tab=organization", { waitUntil: "load" });
  const card = page.getByTestId("org-profile-card");
  const name = card.getByTestId("org-name-input");
  await expect(name).toBeVisible();
  // A field that renders an empty name would satisfy every box assertion below.
  await expect(name).not.toHaveValue("");

  // Soft, both halves, so neither can hide behind the other (failure class 3).
  const box = await name.boundingBox();
  expect(box, "org name field has no box").not.toBeNull();
  expect
    .soft(Math.round(box!.width), `org name field at viewport ${width}px, value ${JSON.stringify(await name.inputValue())}`)
    .toBeGreaterThan(200);

  const geom = await card.evaluate((form) => {
    const left = form.querySelector<HTMLElement>(':scope > [data-split="left"]');
    const right = form.querySelector<HTMLElement>(':scope > [data-split="right"]');
    if (!left || !right) return null;
    const l = left.getBoundingClientRect();
    const r = right.getBoundingClientRect();
    return { leftBottom: Math.round(l.bottom), rightTop: Math.round(r.top), leftWidth: Math.round(l.width), rightWidth: Math.round(r.width) };
  });
  expect(geom, "the card's two split columns were not found").not.toBeNull();
  const seen = `left bottom ${geom!.leftBottom}, right top ${geom!.rightTop}, widths ${geom!.leftWidth}/${geom!.rightWidth}`;
  expect.soft(geom!.rightTop, `${width}px: About must sit BELOW the decisions — ${seen}`).toBeGreaterThanOrEqual(geom!.leftBottom - 1);
  expect.soft(geom!.rightWidth, `${width}px: one column — both halves share the card's width — ${seen}`).toBe(geom!.leftWidth);
});

/**
 * Minor 2 (fix round H): the COMPETITION DESK had zero automated width
 * coverage. This file carried no `desk-ledger-row` / `desk-needs-you` /
 * `desk-masthead` selector at all, and the desk branch never touched it —
 * while all seven width projects (320/360/375/390/430/768/834) run
 * `testMatch: /mobile\.spec\.ts/`. In this repo a UI surface is unprotected
 * until it appears in this file BY NAME, so the owner-ruled mobile CARD
 * composition — the one the owner rejected a shrunken desktop table for —
 * had none.
 *
 * The ruling it enforces (_RULES.md, "Mobile is designed, not shrunk"):
 * below `md` the row is its OWN composition — the whole card body is one
 * link, the pill sits beside the name, the status line wraps, there is NO
 * "Open" button and NO "⋯" menu, and a red attention gets one full-width
 * >=44px action. At `md` and up it is the desktop grid instead.
 *
 * This asserts the ruling the only way a capture cannot: by comparing the
 * visible CONTROL SET on either side of the `md` boundary (768px), which
 * these seven projects straddle — 320/360/375/390/430 are below it,
 * tablet-768/834 at or above. Same set with smaller boxes would be a shrink;
 * different sets is a composition.
 */
test("competition desk: the division row is a CARD below md and a grid at md, not the same controls resized", async ({
  page,
  request,
}) => {
  const width = projectViewport()?.width ?? 0;
  const isCardWidth = width < 768;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk Width ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);
  const makeDivision = async (name: string) => {
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    expect(div.status).toBe(201);
    await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
    expect(fixtureIds.length).toBe(6);
    const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    expect(started.status).toBeLessThan(400);
    return { div: div.data!, stageId, fixtureIds };
  };

  // One CLEAN row (no attention: every fixture dated in the future) and one
  // RED row (its league played out and complete, a `setup`-timing Finals
  // stage still owing its draw). The action only exists on the red one, so a
  // fixture with a single clean row would leave the action untested and one
  // with a single red row could not tell "no action here" from "no action
  // ever".
  const clean = await makeDivision("Clean Cup");
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
  for (const id of clean.fixtureIds) await setFixtureScheduledAtSql(id, tomorrow);
  const red = await makeDivision("Red Cup");
  for (const id of red.fixtureIds) await setFixtureStatusSql(id, "decided");
  await setStageStatusSql(red.stageId, "complete");
  const finals = await apiJson(request, `/api/v1/divisions/${red.div.id}/stages`, "POST", {
    seq: 2, kind: "knockout", name: "Finals", config: {},
    progression: {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    },
  });
  expect(finals.status).toBe(201);

  // Self-contained: the org path comes from the competition's own org_id
  // (competitionPath), never this file's shared `orgSlug` — which is filled
  // by the setup test and is EMPTY under a `-g` filtered run, silently
  // navigating to `/o//c/...` and finding zero rows.
  await page.goto(await competitionPath(request, comp.data!.id), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const rows = page.getByTestId("desk-ledger-row");
  await expect(rows).toHaveCount(2);
  const redRow = rows.filter({ hasText: "Red Cup" });
  const cleanRow = rows.filter({ hasText: "Clean Cup" });
  // Print the asserted CONTENT beside every gate below: a width gate cannot
  // tell you it measured the wrong page STATE, and this whole test is
  // meaningless if the red row is not actually red.
  await expect(redRow).toHaveAttribute("data-phase", "setting_up");
  await expect(cleanRow).toHaveAttribute("data-phase", "scheduled");
  // M1 (fix round I, instance TWELVE): this shape — a setup-timing Finals
  // whose TBD bracket was never generated — used to read "Needs draw" and
  // offer "Compute proposal", a button the landing page cannot operate until
  // the bracket exists. It is `needs_fixtures` now; the ruling this test
  // exists for (the CONTROL SET, not the words) is untouched.
  await expect(redRow.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
  await expect(page.getByTestId("desk-needs-you")).toBeVisible();
  await expect(page.getByTestId("desk-masthead-pill")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The CONTROL SET, per row. Below md: the card body (one link) plus, on a
  // red row only, one action. At md and up: the name link, "Open", and the
  // "⋯" menu — three, on EVERY row.
  const openLink = (row: typeof redRow) => row.getByRole("link", { name: "Open", exact: true });
  const menuButton = (row: typeof redRow) => row.getByRole("button", { name: /^Actions/ });
  const action = redRow.getByRole("link", { name: "Open fixtures" });

  if (isCardWidth) {
    await expect(redRow.locator("a:visible, button:visible")).toHaveCount(2);
    await expect(cleanRow.locator("a:visible, button:visible")).toHaveCount(1);
    await expect(openLink(redRow)).toBeHidden();
    await expect(menuButton(redRow)).toBeHidden();

    // "The whole card is one link": the name, the pill, the progress bar and
    // the status line are all INSIDE the single visible body link, not
    // siblings of it. A screenshot cannot tell these apart.
    const body = cleanRow.locator("a:visible").first();
    await expect(body).toContainText("Clean Cup");
    await expect(body).toContainText("of 6");
    await expect(body.locator("[data-pill]")).toHaveCount(1);

    // The one action: full width and >=44px, and actually TAPPABLE there
    // (boundingBox reports paint, not hit area).
    await expect(action).toBeVisible();
    // Scroll it in FIRST: `boundingBox()` is viewport-relative, and at 320
    // this row sits below the fold, so `elementFromPoint` on the unscrolled
    // coordinates returns null and the hit-test would report a false defect.
    // (It did, on the first run of this test — which is also the proof the
    // hit-test is not vacuous.)
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box, "the red row's action must have a measurable box").not.toBeNull();
    expect(box!.height, "a mobile action must clear the 44px touch floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(box!.width, "the mobile action is full-width, not an inline button").toBeGreaterThan(width * 0.7);
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x!, y!);
        return el ? `${el.tagName}:${(el.textContent ?? "").trim().slice(0, 40)}` : "none";
      },
      [box!.x + box!.width / 2, box!.y + box!.height / 2],
    );
    expect(hit, "the action's own centre must hit the action, not an overlay").toContain("Open fixtures");
  } else {
    await expect(redRow.locator("a:visible, button:visible")).toHaveCount(3);
    await expect(cleanRow.locator("a:visible, button:visible")).toHaveCount(3);
    await expect(openLink(redRow)).toBeVisible();
    await expect(menuButton(redRow)).toBeVisible();
    await expect(openLink(cleanRow)).toBeVisible();
    await expect(menuButton(cleanRow)).toBeVisible();
    // The card-only action does not survive into the desktop composition —
    // if it did, "different sets" would be a lie and this would be a reflow.
    await expect(action).toBeHidden();
  }
});

// F2 + F5 (round J). The desk's TOOL ROW below `sm`, and the Now line on the
// phone card — retired by Match Day B1 (spec 2026-10-31 §9): the ledger names no
// live match at any width now, and a match day gives the row a new lead, Open
// Match Day (the second half of this test).
//
// Before this the five tools were `hidden sm:inline` labels over 46x34 icon
// tiles: unlabelled, under the 44px floor, on the width most likely to be in
// a hand at a venue — a groomed shrink of the desktop row rather than a phone
// composition. The gate is a CONTROL-SET diff (membership and reachability),
// never a comparison of box sizes: a phone view showing the same controls
// smaller is exactly the defect this asserts against.
test("competition desk: the tool row is a phone composition below md, not the desktop row shrunk", async ({
  page,
  request,
}) => {
  const width = projectViewport()?.width ?? 0;
  // Ruling T8-C: Task 8 unified this row's own breakpoint (and the masthead
  // tool row's) from `sm:` (640) onto `md:` (768) — this literal was left
  // behind, stale against the split it is meant to classify. Harmless while
  // no matrix width falls in [640, 768), but the constant and the breakpoint
  // must move together or the next width added here silently misclassifies.
  const isPhone = width < 768;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk Tools ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Tools Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status).toBe(201);
  await addEntrantsViaApi(request, div.data!.id, ["Alpha", "Bravo", "Charlie", "Delta"]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(400);
  // Quiet first (no match has a time, none is in play): not a match day, so the schedule board is the phone primary. The
  // match-day composition is checked at the end, once a fixture is live.

  await page.goto(await competitionPath(request, comp.data!.id), { waitUntil: "load" });
  await dismissCookieBanner(page);

  const toolRow = page.getByTestId("desk-tool-row");
  const schedule = page.getByTestId("desk-tool-schedule");
  const more = page.getByTestId("desk-tools-more-toggle");
  // Scoped to the tool row: the org nav carries its own "Settings" link, and
  // an unscoped role query matches that too — a strict-mode violation that
  // reads like a product defect. The fold's copy of the label is deliberately
  // included in the row's own set, which is why the set is captured BEFORE
  // the fold is opened.
  //
  // Ordered by GEOMETRY, never by DOM order. The phone stack is composed with
  // CSS `order`, which moves what the reader sees and leaves the DOM where it
  // was — so `allInnerTexts()` answers a question nobody asked. The first
  // version of the index assertion below read the DOM and reported the upsell
  // as leading the row when it renders last on screen; sorting by `y` is what
  // makes "leads with" mean what it says.
  const rowControlSet = async (): Promise<string[]> => {
    const items = await toolRow.locator("a:visible, button:visible").all();
    const withPos = await Promise.all(
      items.map(async (el) => ({
        text: ((await el.innerText()) || "").replace(/\s+/g, " ").trim(),
        box: await el.boundingBox(),
      })),
    );
    return withPos
      .filter((i) => i.text && i.box)
      .sort((a, b) => a.box!.y - b.box!.y || a.box!.x - b.box!.x)
      .map((i) => i.text);
  };

  // Not a match day: no filled Open Match Day BUTTON. (C5: the door is still offered, as the first item of the Open menu on a
  // desktop and of the More fold on a phone - asserted below - so the day's button and the off-day item are never both.)
  await expect(page.getByTestId("desk-ledger-row").filter({ hasText: "Tools Cup" }).first()).toBeVisible();
  await expect(page.getByTestId("desk-tool-match-day")).toHaveCount(0);

  if (isPhone) {
    // 1. The primary action is labelled, full width, and clears the floor.
    await expect(schedule).toBeVisible();
    await expect(schedule, "the phone primary must carry its WORD, not just a glyph").toContainText("Schedule");
    const box = await schedule.boundingBox();
    expect(box, "the phone primary must have a measurable box").not.toBeNull();
    expect(box!.height, "a phone action must clear the 44px touch floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(box!.width, "the phone primary is full-width, not an inline tile").toBeGreaterThan(width * 0.7);

    // 1b. And it stays primary while it is being PRESSED. `btn-ghost` carries
    //     `hover:bg-purple-50 hover:text-purple-700`, and a `hover:` utility
    //     outranks a plain one — so the filled phone primary turned pale
    //     lavender with purple text the moment a finger or cursor was on it.
    //     The owner found that by looking at it; nothing in this suite read a
    //     hover state, so nothing could have caught it. Compare the two
    //     computed colours rather than pinning a hex: the ONE thing that must
    //     hold is that pressing it does not turn it into the ghost buttons
    //     underneath it.
    const bgOf = (l: typeof schedule) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    const restBg = await bgOf(schedule);
    await schedule.hover();
    const hoverBg = await bgOf(schedule);
    const ghostBg = await bgOf(page.getByTestId("desk-tools-more-toggle"));
    expect(hoverBg, `pressed primary must not fall back to the ghost fill (rest ${restBg})`).not.toBe(ghostBg);
    expect(
      await schedule.evaluate((el) => getComputedStyle(el).color),
      "a pressed primary must keep its own text colour, not the ghost's purple",
    ).toBe(await schedule.evaluate((el) => getComputedStyle(el).color));
    await expect(schedule).toHaveCSS("color", "rgb(255, 255, 255)");

    // 2. Registration keeps its label AND its count on screen: it is the one
    //    tool that reports status, and status behind a fold is status nobody
    //    sees.
    const registration = page.getByRole("link", { name: /Registration/ });
    await expect(registration).toBeVisible();
    await expect(registration).toContainText("Registration");

    // 3. The CONTROL-SET diff, captured before anything is opened: the
    //    desktop row's inline Settings, Slideshow, Public page and QR tiles
    //    are not on this width at all. Membership, never box sizes — a phone
    //    view showing the same controls smaller is the defect, not the fix.
    const phoneSet = await rowControlSet();
    // Review 7, Important 3: this used to be `phoneSet.join(" | ")` matched
    // against /Schedule/, which passes for ANY position — and it was the one
    // assertion that could have caught the upsell taking `order: 0` above the
    // primary. The message claimed a positional property the assertion could
    // not express (class 4, "tests lie in their names"). Index, not
    // containment.
    expect(phoneSet[0], `the phone row leads with the schedule board; got ${phoneSet.join(" | ")}`).toMatch(/Schedule/);
    expect(phoneSet.join(" | "), "registration keeps its label on a phone").toMatch(/Registration/);
    expect(phoneSet.join(" | "), "a phone needs a labelled More control").toMatch(/More/);
    expect(phoneSet.join(" | "), "the inline Settings tile must not survive into the phone row").not.toMatch(/Settings/);
    expect(phoneSet.join(" | "), "the inline Slideshow tile must not survive into the phone row").not.toMatch(/Slideshow/);
    // C5: the "Open" menu (Slideshow / View Public Page / QR behind one button) is the DESKTOP row's. A phone already folds the
    // same destinations into More, and a second drop-down listing the same links beside it would be the duplication that fold
    // exists to avoid.
    expect(phoneSet, "the Open menu is not on a phone").not.toContain("Open");
    await expect(page.getByTestId("desk-open-menu-toggle"), "present in the DOM, hidden below md").toBeHidden();

    // 4. The rest are FOLDED — attached, so a test can tell "behind the fold"
    //    from "never rendered", but not visible until the disclosure opens.
    await expect(more, "a phone needs a labelled More control, not a bare glyph").toBeVisible();
    await expect(more).toContainText("More");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // `.locator("a")`, not `getByRole("link")`: the closed panel carries the
    // `hidden` ATTRIBUTE, which correctly removes its links from the
    // accessibility tree — so a role query finds nothing and cannot tell
    // "folded away" from "never rendered", the exact pair this assertion
    // exists to separate. (It reported `element(s) not found` on the first
    // run, which is also the proof the distinction is real.)
    const folded = page.getByTestId("desk-tools-more").locator("a");
    await expect(folded.first(), "the folded tools must be in the DOM, just not on screen").toBeAttached();
    await expect(folded.first()).not.toBeVisible();
    await expect(
      page.getByTestId("desk-tools-more").getByRole("link"),
      "a closed fold must be out of the accessibility tree too, not merely invisible",
    ).toHaveCount(0);

    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const count = await folded.count();
    expect(count, "the fold must carry the tools the row no longer shows inline").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const item = folded.nth(i);
      await expect(item).toBeVisible();
      const itemBox = await item.boundingBox();
      expect(itemBox, `folded tool ${i} must have a box once open`).not.toBeNull();
      expect(itemBox!.height, `folded tool ${i} must clear the 44px floor`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      expect((await item.textContent())?.trim(), `folded tool ${i} must be labelled`).toBeTruthy();
    }

    // 5. And once open, the labels are BACK — in a different control, in a
    //    different place. That is what makes this a composition rather than a
    //    deletion: nothing was taken away from the organiser, it moved.
    const openedSet = await rowControlSet();
    expect(openedSet.join(" | "), "the fold restores the tools the row dropped").toMatch(/Settings/);
    expect(openedSet.join(" | ")).toMatch(/Slideshow/);
    // C5 (owner addition): off a match day the fold LEADS with the Match Day door — same tab, no ↗ — since the filled Open Match
    // Day button only exists on the day and the Open menu (which carries this item on a desktop) is not on a phone.
    const doorRow = folded.first();
    await expect(doorRow, "the first folded row is Match Day").toHaveText(/^\s*Match Day\s*$/);
    await expect(doorRow).toHaveAttribute("href", /\/match-day$/);
    expect(await doorRow.getAttribute("target"), "same tab").toBeNull();
  } else {
    // 768 and up: the labelled row, and no More disclosure at all. C5 (owner request 2026-11-01): Slideshow, View Public Page and
    // QR are no longer three buttons in it — they are behind ONE "Open" button, where Slideshow sat.
    await expect(more, "the phone disclosure must not appear at tablet width").toBeHidden();
    await expect(schedule).toBeVisible();
    const openToggle = page.getByTestId("desk-open-menu-toggle");
    const closedSet = (await rowControlSet()).join(" | ");
    expect(closedSet, "the labelled row keeps Settings").toMatch(/Settings/);
    expect(closedSet, "a single Open button").toMatch(/(^| \| )Open( \||$)/);
    expect(closedSet, "closed: the three tools are behind Open, not buttons in the row").not.toMatch(/Slideshow|View Public Page|QR/);
    expect(closedSet, "no disclosure at this width").not.toMatch(/More/);
    await expect(openToggle).toBeVisible();
    await expect(openToggle).toHaveAttribute("aria-haspopup", "menu");
    await expect(openToggle).toHaveAttribute("aria-expanded", "false");
    // Match Day E1 item 5 (owner, 2026-11-01): Open sits immediately before Settings - after the schedule board and Registration, on
    // the same line, and left of Settings. (It used to lead the row, where Slideshow sat.) The unit test pins the DOM order; this
    // reads the paint, so a CSS `order` that split the two would be seen here.
    const openBox = await openToggle.boundingBox();
    const scheduleBox = await schedule.boundingBox();
    const registrationBox = await page.getByTestId("desk-tool-row").getByRole("link", { name: /Registration/ }).first().boundingBox();
    const settingsBox = await page.getByTestId("desk-tool-row").getByRole("link", { name: "Settings", exact: true }).first().boundingBox();
    expect(openBox && scheduleBox && registrationBox && settingsBox, "all four controls have a box").toBeTruthy();
    expect(Math.abs(openBox!.y - scheduleBox!.y), "Open and the schedule board share a line").toBeLessThan(20);
    expect(Math.abs(openBox!.y - settingsBox!.y), "Open and Settings share a line").toBeLessThan(20);
    expect(openBox!.x, "Open follows the schedule board").toBeGreaterThan(scheduleBox!.x);
    expect(openBox!.x, "Open follows Registration").toBeGreaterThan(registrationBox!.x);
    expect(openBox!.x, "Open sits immediately before Settings").toBeLessThan(settingsBox!.x);
    expect(registrationBox!.x, "Registration is between the schedule board and Open").toBeGreaterThan(scheduleBox!.x);

    // Open it. Quiet day, public competition: Match Day first (same tab, no ↗), then the three tools (new tabs).
    const openMenu = page.getByTestId("desk-open-menu");
    const items = openMenu.getByRole("menuitem");
    await expect(items, "folded away until it is opened").toHaveCount(0);
    await openToggle.click();
    await expect(openToggle).toHaveAttribute("aria-expanded", "true");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveText(/^\s*Match Day\s*$/);
    await expect(items.nth(0)).toHaveAttribute("href", /\/match-day$/);
    expect(await items.nth(0).getAttribute("target"), "Match Day opens in the same tab").toBeNull();
    await expect(items.nth(1)).toHaveText("Slideshow ↗");
    await expect(items.nth(2)).toHaveText("View Public Page ↗");
    await expect(items.nth(3)).toHaveText("QR ↗");
    for (let i = 1; i < 4; i++) await expect(items.nth(i)).toHaveAttribute("target", "_blank");
    for (let i = 0; i < 4; i++) {
      const item = items.nth(i);
      await expect(item).toBeVisible();
      const box = await item.boundingBox();
      expect(box, `menu item ${i} has a box`).not.toBeNull();
      expect(box!.height, `menu item ${i} clears the 44px floor`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      expect(box!.x + box!.width, `menu item ${i} stays on screen`).toBeLessThanOrEqual(width);
      // Not clipped, not covered: the point at the middle of the row belongs to the row.
      const reachable = await item.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && el.contains(hit);
      });
      expect(reachable, `menu item ${i} is on top of everything behind it`).toBe(true);
    }
    expect((await rowControlSet()).join(" | "), "opened, the tools are back in the row's control set").toMatch(/Slideshow/);
    await expectNoHorizontalScroll(page);
    // Escape closes it and hands focus back to the button.
    await page.keyboard.press("Escape");
    await expect(openToggle).toHaveAttribute("aria-expanded", "false");
    await expect(items).toHaveCount(0);
    await expect(openToggle, "focus returns to the Open button").toBeFocused();
    // So does a press outside it.
    await openToggle.click();
    await expect(items).toHaveCount(4);
    await page.getByRole("heading", { level: 1 }).first().click();
    await expect(openToggle).toHaveAttribute("aria-expanded", "false");
    await expect(items).toHaveCount(0);
  }
  await expectNoHorizontalScroll(page);

  // Review finding m4 — the 640-767 band, which NO width project covers.
  // The design doc flagged it explicitly when Task 8 unified this row's
  // breakpoint from `sm:` (640) onto `md:` (768): the run-sheet row got its
  // own `{ width: 700 }` leg, the masthead tool row did not. The failure that
  // leaves open is a real one and completely silent — put `DeskToolsMore`
  // back on `sm:hidden` while the labelled tools stay `max-md:hidden` and a
  // small tablet gets NEITHER set, a competition masthead with no tools at
  // all, with every gate in this matrix green.
  //
  // Reloaded rather than merely resized: on a phone project the fold above is
  // left OPEN, and an open fold puts its own copies of Settings/Slideshow
  // back into the row's control set — which would make the "not inline"
  // assertion below read the wrong state.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload({ waitUntil: "load" });
  await dismissCookieBanner(page);
  const bandSet = (await rowControlSet()).join(" | ");
  console.log("desk tool row at 700px:", bandSet);
  await expect(more, "at 700 (below md) the phone disclosure must be present").toBeVisible();
  await expect(schedule, "at 700 the primary must still be there").toBeVisible();
  expect(bandSet, "at 700 the row keeps a labelled More control").toMatch(/More/);
  expect(bandSet, "at 700 the inline Settings tile must not be back — that is the desktop row").not.toMatch(/Settings/);
  expect(bandSet, "at 700 the inline Slideshow tile must not be back").not.toMatch(/Slideshow/);
  expect(bandSet, "at 700 the desktop Open button must not be back either").not.toMatch(/(^| \| )Open( \||$)/);
  await expect(page.getByTestId("desk-open-menu-toggle")).toBeHidden();
  await expectNoHorizontalScroll(page);

  // Match Day B1 (spec §9). A match in play makes it a match day: Open Match Day joins the row and LEADS it — on a phone the
  // one filled control, full width, at the floor, and still filled while pressed (the schedule board's own hover lesson,
  // 1b above) — while the schedule board steps back to a plain row: one primary, never two. And the ledger names no live
  // match at any width (F5's "Now:" line is gone; live state is Match Day's).
  await setFixtureStatusSql(fixtureIds[0]!, "in_play");
  const vp = projectViewport();
  if (vp) await page.setViewportSize(vp);
  await page.reload({ waitUntil: "load" });
  await dismissCookieBanner(page);
  const openMatchDay = page.getByTestId("desk-tool-match-day");
  await expect(openMatchDay, "a match day offers Open Match Day at every width").toBeVisible();
  await expect(openMatchDay).toContainText("Open Match Day");
  const liveRow = page.getByTestId("desk-ledger-row").filter({ hasText: "Tools Cup" }).first();
  await expect(liveRow).toBeVisible();
  await expect(liveRow, "the ledger no longer names the live match").not.toContainText("Now:");
  if (isPhone) {
    const daySet = await rowControlSet();
    expect(daySet[0], `on a match day the phone row leads with Open Match Day; got ${daySet.join(" | ")}`).toMatch(/Open Match Day/);
    expect(daySet.join(" | "), "the schedule board is still in the row").toMatch(/Schedule/);
    const dayBox = await openMatchDay.boundingBox();
    expect(dayBox, "Open Match Day must have a measurable box").not.toBeNull();
    expect(dayBox!.height, "a phone action must clear the 44px touch floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(dayBox!.width, "the phone primary is full-width, not an inline tile").toBeGreaterThan(width * 0.7);
    const bg = (l: typeof schedule) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    // One primary: the schedule board now wears the ghost fill the More toggle does, and not the primary's white text.
    await expect(schedule).not.toHaveCSS("color", "rgb(255, 255, 255)");
    expect(await bg(schedule), "the schedule board is a plain row on a match day").toBe(await bg(more));
    await expect(openMatchDay).toHaveCSS("color", "rgb(255, 255, 255)");
    await openMatchDay.hover();
    expect(await bg(openMatchDay), "a pressed Open Match Day must not fall back to the ghost fill").not.toBe(await bg(more));
    await expect(openMatchDay).toHaveCSS("color", "rgb(255, 255, 255)");
  } else {
    const daySet = (await rowControlSet()).join(" | ");
    expect(daySet, "Open Match Day joins the labelled row at 768 and up").toMatch(/Open Match Day/);
    expect(daySet, "and the row is otherwise unchanged").toMatch(/Settings/);
    // C5: on the day the door is the filled button, so the Open menu loses its Match Day item (one door, never both).
    const dayToggle = page.getByTestId("desk-open-menu-toggle");
    await dayToggle.click();
    await expect(dayToggle).toHaveAttribute("aria-expanded", "true");
    const dayItems = page.getByTestId("desk-open-menu").getByRole("menuitem");
    await expect(dayItems).toHaveCount(3);
    await expect(dayItems.filter({ hasText: /^\s*Match Day\s*$/ })).toHaveCount(0);
    await expect(dayItems.first()).toHaveText("Slideshow ↗");
    await page.keyboard.press("Escape");
    await expect(dayToggle).toHaveAttribute("aria-expanded", "false");
  }
  await expectNoHorizontalScroll(page);
});

// Match Day C5b (owner approved 2026-11-01): the DIVISION page's header carried the same three tools as the competition page -
// Slideshow, View Public Page, the QR poster - as icon-only tiles under `sm`. They are ONE "Open" menu now (the competition
// page's component). Unlike the competition page the division header has no phone fold, so the menu is on screen at EVERY width
// and each destination is in the DOM exactly once; below `md` the panel opens as a full-width sheet under the header row, because
// the trigger's x depends on how the title and chips wrap. A 43-character division name is what makes it wrap at 320.
test("division header: Slideshow, View Public Page and QR are one Open menu at every width, once each, on screen, 44px (C5b)", async ({
  page,
  request,
}) => {
  const width = projectViewport()?.width ?? 0;
  const isPhone = width < 768;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Division Open ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Under-12 Girls Regional Championship Pool A", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status).toBe(201);
  await page.goto(await divisionPath(request, div.data!.id), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)/.exec(new URL(page.url()).pathname);
  expect(m, `on the division page, got ${page.url()}`).not.toBeNull();
  const [, orgSlug, , divSlug] = m!;

  const toggle = page.getByTestId("desk-open-menu-toggle");
  const items = page.getByTestId("desk-open-menu").getByRole("menuitem");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Under-12 Girls");
  await expect(toggle, "Open is on screen at every width - this header has no phone fold").toBeVisible();
  await expect(toggle).toHaveText("Open");
  await expect(toggle).toHaveAttribute("aria-haspopup", "menu");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  if (isPhone) {
    const tb = await toggle.boundingBox();
    expect(tb, "the trigger has a box").not.toBeNull();
    expect(tb!.height, "a phone trigger clears the 44px floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
  }
  await expect(items, "folded away until it is opened").toHaveCount(0);

  // Each destination is in the DOM exactly ONCE at this width (a hidden copy beside a visible one is still a copy).
  const slideshowHref = `/slideshow/divisions/${div.data!.id}`;
  const publicHref = `/live/${orgSlug}/${comp.data!.slug}?tab=matches&division=${divSlug}`;
  const qrHref = `/live/${orgSlug}/${comp.data!.slug}/poster.pdf?division=${divSlug}`;
  for (const href of [slideshowHref, publicHref, qrHref]) {
    await expect(page.locator(`a[href="${href}"]`), `${href} appears once`).toHaveCount(1);
  }

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("Slideshow ↗");
  await expect(items.nth(1)).toHaveText("View Public Page ↗");
  await expect(items.nth(2)).toHaveText("QR ↗");
  await expect(items.nth(0)).toHaveAttribute("href", slideshowHref);
  await expect(items.nth(1)).toHaveAttribute("href", publicHref);
  await expect(items.nth(2)).toHaveAttribute("href", qrHref);
  for (let i = 0; i < 3; i++) await expect(items.nth(i)).toHaveAttribute("target", "_blank");
  for (let i = 0; i < 3; i++) {
    const item = items.nth(i);
    await expect(item).toBeVisible();
    const box = await item.boundingBox();
    expect(box, `item ${i} has a box`).not.toBeNull();
    expect(box!.height, `item ${i} clears the 44px floor`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(box!.x, `item ${i} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `item ${i} ends on screen`).toBeLessThanOrEqual(width || 1280);
    const reachable = await item.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(reachable, `item ${i} is on top of everything behind it`).toBe(true);
  }
  if (isPhone) {
    // The sheet: full width under the header row, wherever the trigger wrapped to.
    const panel = page.getByTestId("desk-open-menu").getByRole("menu");
    const pb = await panel.boundingBox();
    const tb = await toggle.boundingBox();
    expect(pb, "the panel has a box").not.toBeNull();
    expect(pb!.width, "a phone panel is a full-width sheet").toBeGreaterThan(width * 0.8);
    expect(pb!.y, "it opens below the trigger, not over it").toBeGreaterThanOrEqual(tb!.y + tb!.height - 1);
  }
  await expectNoHorizontalScroll(page);
  // Escape closes it and returns focus; so does a press outside.
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(items).toHaveCount(0);
  await expect(toggle, "focus returns to Open").toBeFocused();
  await toggle.click();
  await expect(items).toHaveCount(3);
  await page.getByRole("heading", { level: 1 }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectNoHorizontalScroll(page);
});

// R3.5 review round 1 (2026-08-26, finding 4) — split out of "console
// routes: no horizontal scroll" above. Two fixture seeds plus ~18
// postEvents (~36 round trips) used to run at the HEAD of that test's own
// ~22-route audit, under this file's file-level `mode: "serial"` (top of
// file). Any 4xx here, or a timeout, killed the pre-existing audit AND
// skipped every later test in the file, across all seven projects — this
// test's own failure now stays contained to just these two routes.
test("decider consoles: no horizontal scroll, score pad renders (not just a 2xx)", async ({
  page,
  request,
}) => {
  // core.start poll + ~18 postEvents across two fixtures; same headroom
  // convention as this file's other self-contained-fixture tests (e.g. the
  // cricket v3 pad test below) that budget generously over their own sum.
  test.setTimeout(90_000);

  // R3.5 Task A (2026-08-26) — the two live decider consoles. Neither
  // defect is fixed yet (capture the broken state first): this is what
  // proves the seven-width matrix had ZERO coverage of either screen before
  // this wave, the same gap gallery.capture.ts's own 11-superover/
  // 11-shootout states exist to close for the three-width gallery.
  // Sequences are the wave plan's own (Task A steps 2 and 4), verbatim.
  //
  // Tag folds in projectTag() (review finding 5) — bare `${TAG}so`/
  // `${TAG}sh` collided across width projects that resolve the same
  // millisecond TAG (`projectTag`'s own doc-comment above records a
  // MEASURED collision), and persons are get-or-create BY NAME, so two
  // width projects would otherwise silently share these six person rows.
  const soTag = `${TAG}-${projectTag()}so`;
  const cricketDecider = await seedRosteredFixture(request, {
    label: `Mobile Cricket SuperOver ${TAG}-${projectTag()}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `Mobile Cricket SO Home1 ${soTag}` },
      { fullName: `Mobile Cricket SO Home2 ${soTag}` },
    ],
    away: [
      { fullName: `Mobile Cricket SO Away1 ${soTag}` },
      { fullName: `Mobile Cricket SO Away2 ${soTag}` },
    ],
  });
  const mh1 = cricketDecider.personIds[`Mobile Cricket SO Home1 ${soTag}`]!;
  const mh2 = cricketDecider.personIds[`Mobile Cricket SO Home2 ${soTag}`]!;
  const ma1 = cricketDecider.personIds[`Mobile Cricket SO Away1 ${soTag}`]!;
  const ma2 = cricketDecider.personIds[`Mobile Cricket SO Away2 ${soTag}`]!;
  await mergeDivisionConfig(request, cricketDecider.divisionId, { superOver: true });
  await postEvent(request, cricketDecider.fixtureId, "core.start", {});
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 1, striker: mh1, nonStriker: mh2, bowler: ma1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 2, striker: mh2, nonStriker: mh1, bowler: ma1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.innings.close", { reason: "other" });
  // target = 3; away scores exactly 2 => TIE => phase super_over.
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 1, striker: ma1, nonStriker: ma2, bowler: mh1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 2, striker: ma2, nonStriker: ma1, bowler: mh1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.innings.close", { reason: "other" });
  // Away bats first in the super over; home bowls with h2 — an arbitrary
  // pick, not a forced one (see gallery.capture.ts's identical sequence:
  // applySuperOverBall opens the innings on a fresh `fine`, so h1 would be
  // accepted exactly as legally).
  await postEvent(request, cricketDecider.fixtureId, "cricket.superover.ball", {
    over: 0, ballInOver: 1, striker: ma1, nonStriker: ma2, bowler: mh2, runs: { bat: 4 }, boundary: 4,
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.superover.ball", {
    over: 0, ballInOver: 2, striker: ma1, nonStriker: ma2, bowler: mh2, runs: { bat: 2 },
  });

  const shTag = `${TAG}-${projectTag()}sh`;
  const footballDecider = await seedRosteredFixture(request, {
    label: `Mobile Football Shootout ${TAG}-${projectTag()}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `Mobile Football SO Home ${shTag}`, positionKey: "FW" }],
    away: [{ fullName: `Mobile Football SO Away ${shTag}`, positionKey: "GK" }],
  });
  // `extraTime` is a plain z.object whose two fields are BOTH required,
  // defaulted only as a whole object — `{ enabled: false }` alone fails the
  // cfg parse, and because the division config is written by SQL nothing
  // validates it on the way in.
  await mergeDivisionConfig(request, footballDecider.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });
  await postEvent(request, footballDecider.fixtureId, "core.start", {});
  await postEvent(request, footballDecider.fixtureId, "football.goal", { by: footballDecider.homeEntrantId });
  await postEvent(request, footballDecider.fixtureId, "football.goal", { by: footballDecider.awayEntrantId });
  await postEvent(request, footballDecider.fixtureId, "football.period", { phase: "HT" });
  await postEvent(request, footballDecider.fixtureId, "football.period", { phase: "FT" });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.homeEntrantId, scored: true,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.awayEntrantId, scored: false,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.homeEntrantId, scored: true,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.awayEntrantId, scored: true,
  });

  // R3.5 review round 1 (finding 3) — `requireScorePad: true` on both: a 2xx
  // status and no overflow both pass on a console that rendered its shell
  // with NO pad at all, the same class as the #349 404 vacuity this file
  // already records in "console routes: no horizontal scroll" above.
  await auditRoute(page, await fixturePath(request, cricketDecider.fixtureId), { requireScorePad: true });
  await auditRoute(page, await fixturePath(request, footballDecider.fixtureId), { requireScorePad: true });
});

// P8/D5a added a FOURTH Directory tab, which pushed "Venues" past the right
// edge of the tab strip at 320: you land on the venues tab and cannot see
// which tab is selected. The no-horizontal-scroll gate above is structurally
// unable to catch this — `.scroll-x` means the strip is SUPPOSED to scroll, so
// the page body never overflows and the audit passes while the active tab sits
// off-screen. A full-page screenshot cannot be trusted here either: Chromium's
// fullPage capture resets nested scroll containers, so the tab reads as hidden
// in `gallery.capture.ts` output whether the fix works or not.
//
// Hence a geometry assertion against the scroller's own visible box. This is
// the only instrument in the repo that can fail for the real reason.
//
// 2026-09-30 (fixture-page stream T7) a FIFTH tab, Streaming, ended the strip
// and the test drove IT (with Venues it went vacuous at 430, where Venues fit
// unscrolled while the strip still overflowed — its own control below caught
// that). 2026-10-27 (owner): Streaming left the Directory for a top-nav page of
// its own, so the strip is FOUR tabs again and Venues is its last — the one
// furthest past the edge. `/directory?tab=streaming` is now an unknown tab and
// would open Players, so the test names the tab it drives.
test("Directory: the active tab is scrolled into view at this width", async ({ page }) => {
  await page.goto("/directory?tab=venues", { waitUntil: "load" });

  const active = page.locator('nav [aria-current="page"]');
  await expect(active).toHaveText(/venues/i);
  expect(
    await active.evaluate((el) => el === el.closest("nav")!.querySelector("a:last-of-type")),
    "the driven tab is the strip's LAST one",
  ).toBe(true);

  // Proves the assertion below can actually fail: force the strip back to the
  // unscrolled state this test exists to catch, and confirm the geometry check
  // rejects it. Without this the test would pass on any width where the tabs
  // happen to fit, and silently stop guarding anything.
  const visibleWhenUnscrolled = await active.evaluate((el) => {
    const nav = el.closest("nav")!;
    const restore = nav.scrollLeft;
    nav.scrollLeft = 0;
    const tab = el.getBoundingClientRect();
    const strip = nav.getBoundingClientRect();
    const inView = tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
    nav.scrollLeft = restore;
    return inView;
  });
  const overflows = await active.evaluate((el) => {
    const nav = el.closest("nav")!;
    return nav.scrollWidth > nav.clientWidth;
  });
  if (overflows) {
    expect(
      visibleWhenUnscrolled,
      "control failed: the tab is reachable without scrolling, so this test proves nothing at this width",
    ).toBe(false);
  }

  await expect
    .poll(
      async () =>
        active.evaluate((el) => {
          const nav = el.closest("nav");
          if (!nav) return false;
          const tab = el.getBoundingClientRect();
          const strip = nav.getBoundingClientRect();
          // Fully inside the scroller's visible box, 1px tolerance for
          // sub-pixel layout. Deliberately NOT requiring the tab to clear the
          // 24px `.scroll-x-fade` gradient: the LAST tab scrolled to the end
          // sits flush against that edge by construction, so demanding fade
          // clearance asserts something no correct implementation can satisfy.
          return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
        }),
      { message: "the active Directory tab never scrolled inside the visible strip" },
    )
    .toBe(true);
});

// #516: an organiser who is ALSO a claimed player (nav.tsx's `isPlayer`,
// dual-role seam PROMPT-53) used to get a 4th "Player home" nav link, which
// pushed the header's fixed-width budget past what the #349 min-w-0/shrink-0
// mechanism could reclaim — the row overflowed and "Sign out" rendered
// clipped past the right edge. Since 2026-11-11 (the account menu, owner
// Option A) Player home and Sign out both live in the menu, so the bar's last
// control is the menu's trigger: that is what must stay on-screen, and the
// menu must still offer this user Player home. Own throwaway account + org: must
// NOT touch the shared pro.json identity other specs (and other projects
// sharing its storageState) depend on staying a 3-link organiser.
test("dual-role header (#516): organiser + claimed player profile holds no horizontal scroll", async ({
  browser,
}) => {
  const email = `delivered+e2e-dualrole-${TAG}@resend.dev`;
  const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const dual = await ctx.newPage();
    await loginUi(dual, email);
    // requirePageAuth (src/app/dashboard/page.tsx) is what auto-provisions
    // "My organization" for a member of none — a raw API call doesn't run
    // it, so visit a page before asking activeOrg for a slug.
    await dual.goto("/dashboard", { waitUntil: "load" });
    await claimProfileBySql(email);
    const org = await activeOrg(dual);

    for (const path of ["/dashboard", `/o/${org.slug}/settings`]) {
      await auditRoute(dual, path);
    }

    // Geometry alone (expectNoHorizontalScroll, inside auditRoute) proves the
    // PAGE doesn't overflow — it does not prove the account trigger is the
    // thing that stayed on-screen rather than something else giving way. Pin
    // that, then open it: Player home and Sign out are one tap away.
    await dual.goto("/dashboard", { waitUntil: "load" });
    await dual.waitForTimeout(300);
    const trigger = dual.getByTestId("account-menu-trigger");
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box, "the account trigger has no layout box").not.toBeNull();
    const vw = dual.viewportSize()?.width ?? 0;
    expect(box!.x + box!.width, "the account trigger's right edge must stay within the viewport").toBeLessThanOrEqual(vw);
    await expect(dual.locator('header.app-gantry a[href="/me"]'), "Player home is no longer a bar link").toHaveCount(0);
    await trigger.click();
    await expect(dual.getByTestId("account-menu-player-home"), "a claimed player gets Player home in the menu").toHaveAttribute("href", "/me");
    const signOut = dual.getByTestId("account-menu-signout");
    await expect(signOut).toBeVisible();
    const sb = (await signOut.boundingBox())!;
    expect(sb.x + sb.width, "Sign out's right edge must stay within the viewport").toBeLessThanOrEqual(vw);
  } finally {
    await ctx.close();
  }
});

test("page smokes: settings save + invoice/plan card render", async ({ page }) => {
  // Org rename round-trip proves forms submit on a phone viewport.
  await page.goto("/settings?tab=organization");
  const nameInput = page.getByLabel(/organi[sz]ation name/i);
  await expect(nameInput).toBeVisible();
  // Settings C8 (owner 2026-11-11): the name is a field of the Organisation
  // card, saved by its one "Save changes"; the org defaults beside it keep Save
  // buttons of their own, so scope to the card.
  const card = page.getByTestId("org-profile-card");
  const saveBarNote = card.getByTestId("settings-save-bar-message");
  const orgName = await nameInput.inputValue();
  await nameInput.fill(`${orgName} ✓`);
  await card.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(saveBarNote).toHaveText("Saved.");
  // Restore — other specs assert on the org name. Editing again replaces the
  // note with the unsaved list, so the second "Saved." is the second save's.
  await nameInput.fill(orgName);
  await expect(saveBarNote).not.toHaveText("Saved.");
  await card.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(saveBarNote).toHaveText("Saved.");

  // Billing: the plan card is the invoice-adjacent surface every org has.
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: /plan & billing/i })).toBeVisible();
  await expect(page.getByText(/current plan/i).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

/**
 * #230 item 2 follow-up — the publish gate's confirm step at phone width.
 *
 * It is a bottom sheet under `sm` and it lists an arbitrary number of conflicts,
 * so it is exactly the shape that overflows a 375px page. This file is the ONLY
 * place a 375px assertion actually runs: the mobile projects are
 * `testMatch: /mobile\.spec\.ts/`, so the same assertion written into
 * schedule-board.spec.ts would silently run at desktop and pass.
 */
test("the publish gate's confirm sheet holds at phone width", async ({ page, request }) => {
  const DAY = Date.UTC(2026, 9, 19);
  const at = (hour: number) => new Date(DAY + hour * 3_600_000).toISOString();

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Gate Sheet ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Gate Sheet",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const gateDivisionId = div.data!.id;
  await addEntrantsViaApi(request, gateDivisionId, ["Eve M", "Fay M", "Gus M", "Hal M"]);
  const { fixtureIds } = await createStageAndGenerate(request, gateDivisionId);
  const { courts: gateCourts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${gateDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: at(9),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: gateCourts.map((c) => c.id),
        // A two-hour floor, so the hour-apart pair below is a `warn.rest` — a
        // warning, which is the case that HAS a confirm affordance to size.
        perEntrantMinRest: 120,
      },
    },
  );
  // Every ScheduleConfig field carries a `.default()`, so a rejected PUT still
  // leaves a usable config behind and the only symptom is "the dialog never
  // appeared" — a failure reported against the sheet, three screens from its
  // cause.
  expect(settings.status).toBe(200);

  type Row = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  const rows = await Promise.all(
    fixtureIds.map(async (id) => (await apiJson<Row>(request, `/api/v1/fixtures/${id}`)).data!),
  );
  const first = rows[0]!;
  const sharer = rows.find(
    (f) =>
      f.id !== first.id &&
      [f.home_entrant_id, f.away_entrant_id].some((e) =>
        [first.home_entrant_id, first.away_entrant_id].includes(e),
      ),
  )!;
  await apiJson(request, `/api/v1/fixtures/${first.id}`, "PATCH", {
    scheduled_at: at(9),
    court_id: gateCourts[0]!.id,
  });
  await apiJson(request, `/api/v1/fixtures/${sharer.id}`, "PATCH", {
    scheduled_at: at(10),
    court_id: gateCourts[1]!.id,
  });

  await page.goto(await divisionPath(page.request, gateDivisionId, "/schedule?tab=board"), { waitUntil: "load" });
  const publish = page.getByTestId("board-publish-schedule");
  await expect(publish).toBeVisible({ timeout: 30_000 });
  await publish.click();

  const dialog = page.getByTestId("board-gate");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-testid="board-gate-conflict"]').first()).toBeVisible();

  // The sheet is what is being audited: the page must not scroll sideways
  // behind it, and the sheet's own body must not either — the conflict list is
  // the part that grows without a ceiling.
  await expectNoHorizontalScroll(page);
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="board-gate"]');
    if (!root) return ["the gate sheet was not in the DOM"];
    const suspects: HTMLElement[] = [
      root,
      ...Array.from(root.querySelectorAll<HTMLElement>("p,ul,li")),
    ];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "the gate sheet's content is clipped at this width").toEqual([]);

  for (const id of ["board-gate-confirm", "board-gate-cancel"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} has no box`).not.toBeNull();
    expect(box!.height, `${id} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: `test-results/publish-gate-sheet-${test.info().project.name}.png`,
  });

  // And it works from here — a sheet that renders but cannot be confirmed on a
  // phone is the same dead end in a nicer wrapper.
  await page.getByTestId("board-gate-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const after = await apiJson<{ status: string }>(request, `/api/v1/divisions/${gateDivisionId}`);
  expect(after.data!.status).toBe("scheduled");
  await expectNoHorizontalScroll(page);
});

/**
 * T14b — the lineup editor's role/pair-order selects at phone width.
 *
 * S12/#421 pass E review, Finding 3: both `<select>`s reused the existing
 * `w-24`/`w-32 px-2 py-1 text-xs` recipe, which Tailwind's utilities layer
 * shrinks well under this repo's 44px touch-target floor — and this file had
 * zero references to the lineup editor at all despite already owning the
 * exact assertion pattern this test reuses (`toBeGreaterThanOrEqual(44)`,
 * see T15 below). `min-h-11` is now on both selects, at EVERY width — not
 * `sm:min-h-0`, which was the first shape of this fix and is wrong here for a
 * reason worth writing down: this file runs under all SEVEN width projects,
 * including `tablet-768` and `tablet-834`, and those are touch devices too. A
 * `sm:` escape hatch would have restored 26px controls at exactly two of the
 * widths this very test runs at — the assertion below is unconditional, so the
 * fix would have shipped its own red. Same recipe as every other control this
 * file already holds to the floor, and the same bare `min-h-11` the scorepad
 * chassis uses for its chips and phase tabs.
 *
 * A pair-kind entrant (`entrantKind: "pair"`, not a sport-specific position
 * catalog — S12/#421 pass E Finding 1 made the pair-order control read the
 * entrant's own declared kind instead) is what puts the pair-order select on
 * the page at all; the role select renders for every lineup row regardless
 * of shape, so one seeded fixture proves both controls.
 *
 * Self-contained, like T15 below: its own competition/division/fixture.
 */
test("lineup editor role/pair-order selects hold at phone width", async ({ page, request }) => {
  // `generic` declares `lineup: { size: 1, benchMax: 0 }` (lineup-editor.tsx's
  // own `lineupEditorApplies` doc comment groups it with chess/carrom as "no
  // lineup to pick") — the editor never mounted here, at ANY width, which is
  // why this fixture never actually proved the touch floor. The racquet
  // family (`size: 1, benchMax: 1`) is the one `lineupEditorApplies` singles
  // out by name as needing the pair-order editor kept.
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Lineup ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "pair",
    // 43+ characters: the realistic long name that put the lineup card at 406px
    // in a 288px column (nowrap name -> min-content). Both sides.
    home: [{ fullName: "Bartholomew Maximilian Featherstonehaugh-Smythe" }, { fullName: "Home Two" }],
    away: [{ fullName: "Bartholomew Maximilian Featherstonehaugh-Jones" }, { fullName: "Away Two" }],
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });

  // Lineup editor groups (2026-11-11): the per-row Role select moved into the ⋯
  // menu, so the touch floor now has to hold for the ⋯ trigger, for every item
  // of the OPEN menu (a bottom sheet below `md`, a dropdown above it), and for
  // the one inline control a row keeps (tennis pairs: the pair-order select).
  //
  // Below `md` only ONE team card shows, behind a Home/Away switch
  // (`md:hidden`), and the editor lives in the header bar's Lineup panel — so
  // the panel is opened once, then each side is driven in turn: switch to it
  // (only when the switch is visible), then measure.
  await openConsolePanel(page, "lineup");
  const menuButtons = page.getByTestId("lineup-row-menu-button");
  // Wait ATTACHED first (the editor is client-rendered) — visibility is exactly
  // what the fold denies, so it cannot be the wait condition here.
  await expect(menuButtons.first(), "no ⋯ menu button rendered").toBeAttached({ timeout: 30_000 });
  let measured = 0;
  for (const side of ["home", "away"] as const) {
    const teamSwitch = page.getByTestId(`lineup-team-switch-${side}`);
    if (await teamSwitch.isVisible()) {
      await teamSwitch.click();
      await expect(teamSwitch).toHaveAttribute("aria-pressed", "true");
    }
    const card = page.getByTestId(`lineup-team-${side}`);
    await expect(card, `${side} lineup card is not showing`).toBeVisible();

    const buttons = card.getByTestId("lineup-row-menu-button");
    await expect(buttons.first(), `${side}: ⋯ button still folded after its disclosure was opened`).toBeVisible({
      timeout: 30_000,
    });
    // Hit-test, not scrollWidth: an overflow that is CLIPPED leaves scrollWidth
    // equal to clientWidth while the button is off-screen. Every ⋯ centre must
    // be inside the viewport and be what a finger would actually land on.
    const viewportWidth = page.viewportSize()!.width;
    const cardBox = await card.boundingBox();
    expect(cardBox!.width, `${side} lineup card is ${cardBox!.width}px in a ${viewportWidth}px viewport`).toBeLessThanOrEqual(
      viewportWidth,
    );
    for (const button of await buttons.all()) {
      const hit = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        el.scrollIntoView({ block: "center" });
        const r2 = el.getBoundingClientRect();
        const top = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2);
        return { inView: x >= 0 && x <= window.innerWidth, hit: top !== null && (top === el || el.contains(top)) };
      });
      expect(hit.inView, "⋯ button centre is off-screen horizontally").toBe(true);
      expect(hit.hit, "⋯ button is not what elementFromPoint returns at its centre").toBe(true);
      const box = await button.boundingBox();
      expect(box, "⋯ button has no box").not.toBeNull();
      expect(box!.height, `⋯ button touch target is ${box!.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `⋯ button touch target is ${box!.width}px wide`).toBeGreaterThanOrEqual(44);
      measured++;
    }

    // Option A two-line row (owner 2026-11-11): below md the select drops to its own line under the name, so a long name
    // keeps most of the row and the select shows its full option text; from md the row is ONE line. Measured on the row
    // whose name is the 43-char one, never on a short stand-in.
    const longRow = card.getByTestId("lineup-row").filter({ hasText: "Featherstonehaugh" }).first();
    await expect(longRow, `${side}: the 43-char row is rendered`).toBeVisible();
    const geo = await longRow.evaluate((row) => {
      const q = (sel: string) => row.querySelector<HTMLElement>(sel);
      const name = Array.from(row.querySelectorAll<HTMLElement>("span.truncate")).find((e) => e.textContent?.includes("Featherstonehaugh"))!;
      const select = q('[data-testid="lineup-position-select"], [data-testid="lineup-pairorder-select"]');
      const rr = row.getBoundingClientRect();
      const nr = name.getBoundingClientRect();
      return {
        rowW: rr.width,
        nameW: nr.width,
        nameTop: nr.top,
        nameMid: nr.top + nr.height / 2,
        selTop: select ? select.getBoundingClientRect().top : null,
        selMid: select ? select.getBoundingClientRect().top + select.getBoundingClientRect().height / 2 : null,
        selOverflow: select ? select.scrollWidth - select.clientWidth : null,
      };
    });
    expect(geo.selTop, `${side}: the row offers its select (anti-vacuity)`).not.toBeNull();
    expect(geo.selOverflow!, `${side}: the select's own text is clipped`).toBeLessThanOrEqual(0);
    if (viewportWidth < 768) {
      expect(geo.nameW / geo.rowW, `${side}: the name is ${geo.nameW}px of a ${geo.rowW}px row`).toBeGreaterThanOrEqual(0.6);
      expect(geo.selTop!, `${side}: below md the select sits on its own line under the name`).toBeGreaterThan(geo.nameTop + 8);
    } else {
      // Rows are items-center, so the one-line proof is the vertical CENTRES within 4px (tops differ by the select's 44px height).
      expect(Math.abs(geo.selMid! - geo.nameMid), `${side}: from md the row is one line (name/select centres within 4px)`).toBeLessThanOrEqual(4);
    }
    await expectNoHorizontalScroll(page);

    // Open the first row's menu: every control in it is a 44px target, the Role
    // segmented control is in it, and it fits the page (the state that matters).
    await buttons.first().click();
    const menu = card.getByTestId("lineup-row-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("lineup-menu-role-coach"), "Role control missing from the ⋯ menu").toBeVisible();
    const items = menu.locator('[role="menuitem"]:visible, [role="menuitemradio"]:visible');
    expect(await items.count(), "⋯ menu has no visible items").toBeGreaterThan(3);
    for (const item of await items.all()) {
      const box = await item.boundingBox();
      expect(box, "menu item has no box").not.toBeNull();
      expect(box!.height, `menu item touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
    await page.keyboard.press("Escape");
    await expect(menu, "Escape did not dismiss the ⋯ menu").toBeHidden();
  }
  expect(measured, "no ⋯ button was measured").toBeGreaterThan(0);

  const pairOrderSelects = page.getByTestId("lineup-pairorder-select");
  await expect(pairOrderSelects.first(), "no pair-order select rendered — entrant.kind did not reach isPairShaped").toBeAttached({
    timeout: 30_000,
  });
  // The side showing now (away) is the one with a box on a phone; measure what is visible.
  let pairMeasured = 0;
  for (const select of await pairOrderSelects.all()) {
    if (!(await select.isVisible())) continue;
    const box = await select.boundingBox();
    expect(box, "pair-order select has no box").not.toBeNull();
    expect(box!.height, `pair-order select touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
    pairMeasured++;
  }
  expect(pairMeasured, "no visible pair-order select was measured").toBeGreaterThan(0);

  await expectNoHorizontalScroll(page);
});

/**
 * T15 — the z3 solver action bar and its result strip at phone width.
 *
 * THIS TEST CANNOT LIVE IN `auto-schedule.spec.ts`. The `mobile-se`
 * (375×667) and `mobile-14` (390×844) projects are declared with
 * `testMatch: /mobile\.spec\.ts/`, so they run this one file and nothing else —
 * a new spec file gets desktop coverage only, however it is named. The 375px
 * gate for the feature is therefore a section here, by construction.
 *
 * Self-contained: it seeds its own competition rather than borrowing the file's
 * shared division, which has no stage and so renders no action bar at all.
 *
 * Three things are asserted, in the order they can be:
 *   - the three actions are hit-testable. `min-h-11 sm:min-h-0` on all three is
 *     the only reason they clear 44px — the shared `py-1.5 text-xs` button
 *     renders 28px, and the override is mobile-only, so nothing at desktop
 *     width would notice it being dropped.
 *   - the strip renders and its own content is not clipped. The metrics grid
 *     carries `overflow-hidden`, which means a grid that outgrew its container
 *     would silently truncate rather than push the page wide — invisible to the
 *     page-level scroll check below, and the reason this is measured separately.
 *   - no horizontal page scroll, checked AFTER the strip has rendered. The strip
 *     is the widest thing this surface ever shows; running the check on the
 *     board before a run would prove nothing about the element under test.
 */
// LAST IN THE FILE, DELIBERATELY. This whole spec is
// `test.describe.configure({ mode: "serial" })`, so a failure SKIPS every case
// after it — and this is the only case here that depends on a z3 solve, i.e. the
// one most likely to fail for a reason that is nothing to do with layout (a
// solver hiccup, a busy queue, a WASM that will not boot). Sitting mid-file it
// took the public-surface, news, axe, page-smoke and LCP cases down with it.
// Anything added below this line inherits that risk; add it above.
test("z3 schedule actions + result strip hold at phone width", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Solver ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Solver",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const solverDivisionId = div.data!.id;
  await addEntrantsViaApi(request, solverDivisionId, ["Ash M", "Brook M", "Clay M", "Dune M"]);
  const { fixtureIds } = await createStageAndGenerate(request, solverDivisionId);
  expect(fixtureIds.length).toBe(6);
  const { courts: solverCourts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${solverDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: solverCourts.map((c) => c.id),
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  await page.goto(await divisionPath(page.request, solverDivisionId, "/schedule?tab=board"), { waitUntil: "load" });

  // Ids, not labels (#465): "Auto-schedule {name}" interpolates the division
  // name and "Improve times" is not the word "Polish".
  const auto = page.getByTestId("schedule-auto");
  const reflow = page.getByTestId("schedule-reflow");
  const polish = page.getByTestId("schedule-polish");
  // The toolbar's other four controls (#349 review): freeze/publish/start/AI
  // never got the min-h-11 floor their three auto/reflow/polish siblings did.
  const freeze = page.getByTestId("board-freeze");
  const publish = page.getByTestId("board-publish-schedule");
  const start = page.getByTestId("board-start-division");
  const aiSchedule = page.getByTestId("board-ai-schedule");
  for (const [name, button] of [
    ["schedule-auto", auto],
    ["schedule-reflow", reflow],
    ["schedule-polish", polish],
    ["board-freeze", freeze],
    ["board-publish-schedule", publish],
    ["board-start-division", start],
    ["board-ai-schedule", aiSchedule],
  ] as const) {
    await expect(button, `${name} is not visible at this width`).toBeVisible({ timeout: 30_000 });
    const box = await button.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.height, `${name} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }

  await auto.click();
  await page.getByTestId("schedule-rebuild-confirm").click();
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: 45_000 });
  // The whole round trip, not just the proposal: `autoRun` clears `busy` in its
  // `finally`, after the apply POST and the refresh.
  await expect(auto).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByTestId("schedule-result-headline")).toBeVisible();

  // Nothing inside the strip is clipped or scrolled sideways — including the
  // metrics grid, whose `overflow-hidden` would otherwise hide the failure.
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="schedule-result-strip"]');
    if (!root) return ["the strip was not in the DOM"];
    const suspects: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("dl,p"))];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "result strip content is clipped at this width").toEqual([]);

  await expectNoHorizontalScroll(page);
});
