// WALKTHROUGH — scorer sheets §4.5: what an umpire sees when they scan a
// printed sheet's QR, from a final nobody has reached yet to a match that is
// over, on the phone that holds the link.
//
// The umpire's story: the sheet for the FINAL is printed before either semi is
// played. Scanned early, the phone says who it is waiting for — and then,
// without anyone touching it, the page moves on by itself as each semi is
// decided: first one name, then the Confirm card with both names and Start.
// Start, and the pad mounts. The organiser then calls the match off, and the
// phone — the next time the umpire comes back to it — says so, rather than
// sitting on a pad whose every tap would be refused.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the organiser's API: a four-entrant knockout, a device link per
// match, each semi's result, the second semi's finalize, a revoke, and the
// final's time. The cancel is a SQL flip (`setFixtureStatusSql`): no write API
// cancels a fixture without appending an event, and "no event" is exactly the
// case under test. THE TEST, in the browser: every screen the scan page can
// show, and the two moves it makes on its own — Waiting → Confirm, and a live
// cancel → View-only.
//
// ── WHY THE JOURNEY PAGE CARRIES NO ROUTE ───────────────────────────────────
// Playwright disables the browser's HTTP cache on any page (or context) with a
// `route`, so no `304` can ever reach it. Step 7's cancel is only visible to
// the phone if `/state`'s ETag moves with a change that appends no event
// (`fixtureStateEtag`, a digest of the body): with the old seq-only ETag the
// browser's revalidation answers 304 and the phone keeps its cached "in play".
// A routed page would pass either way, so NOTHING here routes the phone.
//
// ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
// Every sentence is read from the dictionary the page renders (en + fr). The
// Waiting screen refreshes every `POLL_MS`, read from its source
// (`padPollMs()`), so each wait for it is derived from that constant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  expectNoHorizontalScroll,
  scoreFixture,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
} from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { padPollMs } from "../realtime-propagation-kit";

const dictionary = (locale: "en" | "fr") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dictionary("en");
const FR = dictionary("fr");
type Dict = typeof EN;

/** `{name}` placeholders, filled the way `useMsg` fills them. */
const say = (dict: Dict, key: string, vars: Record<string, string | number> = {}): string => {
  const template = dict[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};
/** "Winner of R1·2", the way `resolveSlotLabel` names an unfilled seat. */
const winnerOf = (dict: Dict, round: number, seq: number) =>
  say(dict, "slot.winner_match", { ext: say(dict, "slot.match_ref", { round, seq }) });

/** A realistic long entrant name (43 characters): the truncate / min-w-0
 *  chain on Confirm and Waiting is only exercised by a name this long. */
const LONG_NAME = "Maximiliana Featherstonehaugh-Wolfeschlegel";

// ---- The budget, derived from the steps (AGENTS.md 20) ----------------------
/** Waiting re-renders every POLL_MS; a side filled just after one refresh is
 *  seen on the next, plus the server render and the paint. */
const WAITING_BUDGET_MS = padPollMs() + 20_000;
/** A page load, a seed, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click, a local assertion, or one width of a capture. */
const REACH_MS = 5_000;
const WIDTHS = [320, 768, 1280] as const;
/** Screens captured, each at every width: six screens, en + fr. */
const CAPTURES = 12;
/** Page loads: the final (en, once), and every other screen per locale. */
const NAVIGATIONS = 12;
/** API reaches: competition, division, entrants, stage, generate, start, the
 *  draw, three mints, two results, a finalize, a revoke, the ledger reads. */
const REACHES = 18;
const BUDGET_MS = Math.max(
  180_000,
  2 * WAITING_BUDGET_MS + NAVIGATIONS * STEP_MS + REACHES * REACH_MS + CAPTURES * WIDTHS.length * REACH_MS,
);

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

async function ledger(request: APIRequestContext, id: string): Promise<{ type: string }[]> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${id}/events?since_seq=0`);
  expect(res.status, `GET /fixtures/${id}/events`).toBe(200);
  return res.data!;
}

async function fixture(request: APIRequestContext, id: string): Promise<Fx> {
  const res = await apiJson<Fx>(request, `/api/v1/fixtures/${id}`);
  expect(res.status, `GET /fixtures/${id}`).toBe(200);
  return res.data!;
}

/** Paint is not reach (AGENTS.md 2): a tap at the control's centre must land
 *  on the control, and the control must be a 44px target. */
async function hitTest(button: Locator, label: string) {
  const box = await button.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const hit = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
}

/** One screen at every width: the screen's root visible, no horizontal page
 *  scroll, every button hit-tested, a full-page picture, and the SAME controls
 *  in the SAME order at 320 as at 1280 (a phone view is a composition of the
 *  same control set, never a groomed subset). Returns the paths written. */
async function capture(page: Page, root: Locator, testInfo: TestInfo, name: string): Promise<string[]> {
  const perWidth: { w: number; buttons: string[] }[] = [];
  const paths: string[] = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(root, `${name} ${w}: the screen is up`).toBeVisible();
    await expectNoHorizontalScroll(page);
    const box = await root.boundingBox();
    expect(box!.width, `${name} ${w}: the screen fits the viewport`).toBeLessThanOrEqual(w);
    const buttons = page.getByRole("button");
    const labels = (await buttons.allInnerTexts()).map((b) => b.trim());
    for (let i = 0; i < labels.length; i++) await hitTest(buttons.nth(i), `${name} ${w} "${labels[i]}"`);
    perWidth.push({ w, buttons: labels });
    const path = testInfo.outputPath(`${name}-${w}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(`${name}-${w}`, { path, contentType: "image/png" });
    paths.push(path);
  }
  expect(perWidth[0]!.buttons, `${name}: same controls, same order at 320 and 1280`).toEqual(perWidth[2]!.buttons);
  await page.setViewportSize({ width: 1280, height: 900 });
  return paths;
}

/** An anonymous phone in `locale` — the token is the only credential here —
 *  with the cookie banner already answered, and NO route anywhere on it. */
async function phoneIn(browser: Browser, locale: "en" | "fr"): Promise<Page> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  await ctx.addCookies([{ name: "seazn_locale", value: locale, url: new URL(test.info().project.use.baseURL!).origin }]);
  return ctx.newPage();
}

test("a printed sheet's QR, scanned early: Waiting moves to Confirm by itself, Start opens the pad, a live cancel lands on View-only — and every scan screen, en + fr", async ({
  browser,
  request,
}, testInfo) => {
  // The ceiling is the test's FIRST act (README: never at module scope).
  test.setTimeout(BUDGET_MS);

  // ---- Reach: a started four-entrant knockout ------------------------------
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Scan Cup ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${JSON.stringify(comp.error)}`).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Scan Cup ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division POST → ${JSON.stringify(div.error)}`).toBe(201);
  const divisionId = div.data!.id;
  const names = [LONG_NAME, `Bea ${TAG}`, `Cai ${TAG}`, `Dev ${TAG}`];
  const added = await addEntrantsViaApi(request, divisionId, names);
  expect(added.status).toBe(201);
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  const longId = added.ids[0]!;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
    config: {},
  });
  expect(stage.status, `stage POST → ${JSON.stringify(stage.error)}`).toBe(201);
  const generated = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(generated.status, `generate → ${JSON.stringify(generated.error)}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);

  // The draw is READ BACK, never assumed.
  const drawn = (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter(
    (f) => f.stage_id === stage.data!.id,
  );
  const semis = drawn.filter((f) => f.round_no === 1).sort((a, b) => a.seq_in_round - b.seq_in_round);
  const final = drawn.find((f) => f.round_no === 2)!;
  expect(semis, "four entrants draw two semis").toHaveLength(2);
  expect(final, "…feeding one final").toBeDefined();
  // The long name's semi goes first, so it is the name Waiting shows alone.
  const longSemi = semis.find((s) => s.home_entrant_id === longId || s.away_entrant_id === longId)!;
  const otherSemi = semis.find((s) => s !== longSemi)!;
  expect(longSemi, "the long-named entrant is drawn into a semi").toBeDefined();
  // A time on the final, so Confirm shows its time row.
  await setFixtureScheduledAtSql(final.id, "2030-06-14T18:30:00.000Z");

  const mint = async (fixtureId: string) => {
    const res = await apiJson<{ id: string; secret: string }>(
      request,
      `/api/v1/fixtures/${fixtureId}/device-links`,
      "POST",
      {},
    );
    expect([200, 201], `mint for ${fixtureId}: ${JSON.stringify(res.error)}`).toContain(res.status);
    return res.data!;
  };
  const finalLink = await mint(final.id);
  const longSemiLink = await mint(longSemi.id);
  const otherSemiLink = await mint(otherSemi.id);

  const phone = await phoneIn(browser, "en");
  const frPhone = await phoneIn(browser, "fr");
  const other = await phone.context().newPage();
  const shots: string[] = [];
  try {
    // Every DOCUMENT load of the journey phone: the moves below must happen with
    // the phone untouched, so this stays at ONE. Not `framenavigated` — that
    // also fires on the same-document history write each `router.refresh()`
    // makes, which is exactly the move under test.
    let phoneDocumentLoads = 0;
    phone.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === phone.mainFrame()) phoneDocumentLoads += 1;
    });
    /** A reload wipes the window, so a mark set after the first load that is
     *  still there proves the page was never reloaded. */
    const stillFirstLoad = () =>
      phone.evaluate(() => (window as unknown as { __scanFirstLoad?: true }).__scanFirstLoad === true);

    // ---- 1. The final, scanned before either semi: Waiting, for two feeders ---
    await phone.goto(`/score/${finalLink.secret}`);
    const waiting = phone.getByTestId("scan-waiting");
    await expect(waiting, "a final with no sides yet opens on Waiting").toBeVisible({ timeout: STEP_MS });
    await phone.evaluate(() => {
      (window as unknown as { __scanFirstLoad?: true }).__scanFirstLoad = true;
    });
    await expect(waiting).toContainText(say(EN, "device.scan.waitingFor"));
    await expect(waiting).toContainText(winnerOf(EN, longSemi.round_no, longSemi.seq_in_round));
    await expect(waiting).toContainText(winnerOf(EN, otherSemi.round_no, otherSemi.seq_in_round));
    await expect(waiting).toContainText(say(EN, "device.scan.waitingHint"));
    await expect(phone.getByTestId("scan-confirm"), "no Confirm while a side is unknown").toHaveCount(0);
    await expect(phone.getByTestId("score-start-match"), "…and nothing to start").toHaveCount(0);

    // ---- 2. The long name's semi is decided: Waiting names it, by itself ------
    const longIsHome = longSemi.home_entrant_id === longId;
    await scoreFixture(request, longSemi.id, longIsHome ? 2 : 1, longIsHome ? 1 : 2);
    await expect
      .poll(async () => {
        const f = await fixture(request, final.id);
        return [f.home_entrant_id, f.away_entrant_id].includes(longId);
      }, { timeout: STEP_MS, message: "the record: the winner is seated in the final" })
      .toBe(true);
    await expect(waiting, "Waiting refreshes itself to the seated name").toContainText(LONG_NAME, {
      timeout: WAITING_BUDGET_MS,
    });
    await expect(waiting, "one side is still unknown, so still Waiting").toContainText(
      winnerOf(EN, otherSemi.round_no, otherSemi.seq_in_round),
    );
    shots.push(...(await capture(phone, waiting, testInfo, "en-waiting")));
    await frPhone.goto(`/score/${finalLink.secret}`);
    const frWaiting = frPhone.getByTestId("scan-waiting");
    await expect(frWaiting).toContainText(say(FR, "device.scan.waitingFor"), { timeout: STEP_MS });
    await expect(frWaiting).toContainText(LONG_NAME);
    await expect(frWaiting).toContainText(winnerOf(FR, otherSemi.round_no, otherSemi.seq_in_round));
    shots.push(...(await capture(frPhone, frWaiting, testInfo, "fr-waiting")));

    // ---- 3. The decided semi's own sheet: View-only, carried forward ---------
    await other.goto(`/score/${longSemiLink.secret}`);
    const carried = other.getByTestId("scan-view-only");
    await expect(carried).toHaveText(say(EN, "device.scan.viewOnly.carried"), { timeout: STEP_MS });
    await expect(other.locator('[data-role="pad-v3"]'), "View-only has no pad").toHaveCount(0);
    shots.push(...(await capture(other, carried, testInfo, "en-view-only-carried")));
    await frPhone.goto(`/score/${longSemiLink.secret}`);
    const frCarried = frPhone.getByTestId("scan-view-only");
    await expect(frCarried).toHaveText(say(FR, "device.scan.viewOnly.carried"), { timeout: STEP_MS });
    shots.push(...(await capture(frPhone, frCarried, testInfo, "fr-view-only-carried")));

    // ---- 4. The other semi is decided: the final's phone moves to Confirm -----
    // A REAL side fill (the bracket's own advance), and zero events on the
    // final: nothing the final's ledger or stream could have told the phone.
    await scoreFixture(request, otherSemi.id, 2, 1);
    const confirm = phone.getByTestId("scan-confirm");
    await expect(confirm, "Waiting moves to Confirm by itself once both sides are known").toBeVisible({
      timeout: WAITING_BUDGET_MS,
    });
    expect(phoneDocumentLoads, "…with the phone untouched: no reload, no navigation").toBe(1);
    expect(await stillFirstLoad(), "…the same window it first loaded").toBe(true);
    expect(await ledger(request, final.id), "the final has no event at all").toEqual([]);
    const otherWinner = nameOf.get(otherSemi.home_entrant_id!)!;
    await expect(confirm).toContainText(say(EN, "device.scan.confirmTitle"));
    await expect(confirm).toContainText(LONG_NAME);
    await expect(confirm).toContainText(otherWinner);
    await expect(confirm).toContainText(say(EN, "device.scan.time"));
    await expect(confirm).toContainText(say(EN, "slot.match_ref", { round: final.round_no, seq: final.seq_in_round }));
    await expect(confirm.getByTestId("score-start-match")).toHaveText(say(EN, "score.startMatch"));
    await expect(phone.locator('[data-role="pad-v3"]'), "no pad before Start").toHaveCount(0);
    shots.push(...(await capture(phone, confirm, testInfo, "en-confirm")));
    await frPhone.goto(`/score/${finalLink.secret}`);
    const frConfirm = frPhone.getByTestId("scan-confirm");
    await expect(frConfirm).toContainText(say(FR, "device.scan.confirmTitle"), { timeout: STEP_MS });
    await expect(frConfirm.getByTestId("score-start-match")).toHaveText(say(FR, "score.startMatch"));
    shots.push(...(await capture(frPhone, frConfirm, testInfo, "fr-confirm")));

    // ---- 5. The other semi is finalised: its sheet says so -------------------
    const tip = (await ledger(request, otherSemi.id)).length;
    const finalized = await apiJson(request, `/api/v1/fixtures/${otherSemi.id}/events`, "POST", {
      expected_seq: tip,
      type: "core.finalize",
      payload: {},
    });
    expect(finalized.status, `finalize → ${JSON.stringify(finalized.error)}`).toBe(201);
    await other.goto(`/score/${otherSemiLink.secret}`);
    const fin = other.getByTestId("scan-view-only");
    await expect(fin).toHaveText(say(EN, "device.scan.viewOnly.finalized"), { timeout: STEP_MS });
    shots.push(...(await capture(other, fin, testInfo, "en-view-only-finalized")));
    await frPhone.goto(`/score/${otherSemiLink.secret}`);
    const frFin = frPhone.getByTestId("scan-view-only");
    await expect(frFin).toHaveText(say(FR, "device.scan.viewOnly.finalized"), { timeout: STEP_MS });
    shots.push(...(await capture(frPhone, frFin, testInfo, "fr-view-only-finalized")));

    // ---- 6. A revoked sheet: the dead-link screen, in the scorer's words ------
    const revoked = await apiJson(
      request,
      `/api/v1/fixtures/${longSemi.id}/device-links/${longSemiLink.id}`,
      "DELETE",
    );
    expect(revoked.status, `revoke → ${JSON.stringify(revoked.error)}`).toBeLessThan(300);
    await other.goto(`/score/${longSemiLink.secret}`);
    const dead = other.getByTestId("scan-dead-link");
    await expect(dead).toContainText(say(EN, "device.dead.revoked"), { timeout: STEP_MS });
    await expect(dead).toContainText(say(EN, "device.askFreshLink"));
    shots.push(...(await capture(other, dead, testInfo, "en-dead-link")));
    await frPhone.goto(`/score/${longSemiLink.secret}`);
    const frDead = frPhone.getByTestId("scan-dead-link");
    await expect(frDead).toContainText(say(FR, "device.dead.revoked"), { timeout: STEP_MS });
    await expect(frDead).not.toContainText("revoked");
    shots.push(...(await capture(frPhone, frDead, testInfo, "fr-dead-link")));
    // A token that never existed is "not valid", not "revoked".
    await other.goto("/score/dl_this_was_never_a_real_token");
    await expect(other.getByTestId("scan-dead-link")).toContainText(say(EN, "device.dead.invalid"), {
      timeout: STEP_MS,
    });

    // ---- 7. Start on the final; then the organiser cancels it -----------------
    await phone.getByTestId("score-start-match").click();
    await expect(phone.locator('[data-role="pad-v3"]'), "Start opens the pad").toBeVisible({ timeout: STEP_MS });
    await expect.poll(async () => (await ledger(request, final.id)).map((e) => e.type)).toEqual(["core.start"]);
    await expect(phone.getByTestId("scan-view-only"), "empty case first: a live pad is not View-only").toHaveCount(0);
    // The phone's own re-read after Start has put the in-play `/state` in its
    // HTTP cache; the flip below appends no event, so the ledger seq does not
    // move — only the body does.
    await setFixtureStatusSql(final.id, "cancelled");
    expect((await ledger(request, final.id)).length, "the cancel appended nothing").toBe(1);
    // The umpire comes back to the phone (G1's tab return re-reads the server).
    await phone.evaluate(() => window.dispatchEvent(new Event("focus")));
    const cancelled = phone.getByTestId("scan-view-only");
    await expect(
      cancelled,
      "a cancel with no event must reach the phone through its HTTP cache (the ETag covers the body)",
    ).toHaveText(say(EN, "device.scan.viewOnly.cancelled"), { timeout: STEP_MS });
    await expect(phone.locator('[data-role="pad-v3"]'), "View-only leaves no pad").toHaveCount(0);
    expect(phoneDocumentLoads, "the journey phone never reloaded").toBe(1);
    expect(await stillFirstLoad(), "…still the window it first loaded").toBe(true);
    shots.push(...(await capture(phone, cancelled, testInfo, "en-view-only-cancelled")));
    await frPhone.goto(`/score/${finalLink.secret}`);
    const frCancelled = frPhone.getByTestId("scan-view-only");
    await expect(frCancelled).toHaveText(say(FR, "device.scan.viewOnly.cancelled"), { timeout: STEP_MS });
    shots.push(...(await capture(frPhone, frCancelled, testInfo, "fr-view-only-cancelled")));

    // The pictures exist and DIFFER (AGENTS.md 10): twelve screens, three widths.
    expect(shots).toHaveLength(CAPTURES * WIDTHS.length);
    const bytes = new Set(shots.map((p) => readFileSync(p).toString("base64")));
    expect(bytes.size, "no two captures are pixel-identical").toBe(shots.length);
  } finally {
    await phone.context().close();
    await frPhone.context().close();
  }
});
