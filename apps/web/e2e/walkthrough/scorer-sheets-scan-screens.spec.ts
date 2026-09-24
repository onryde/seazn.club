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
// (`padPollMs()`), so each wait for it is derived from that constant. Every
// match name is the schedule board's (owner ruling 2026-09-24): derived here
// by the board's own `boardRoundCodes` + `composeMatchRef` over the draw read
// back from the API — never a typed "SF·1".
//
// ── WHAT ONE WAITING REFRESH WEIGHS (Task 6 review I2) ─────────────────────
// Waiting re-renders its server page every POLL_MS. For a French phone it used
// to sit inside a DictProvider carrying the whole merged `ui` dictionary, which
// every one of those refreshes re-sent. Step 1b measures one refresh's RSC
// response on an unrouted French phone and prints its transfer and decoded
// sizes; the bound is derived from the dictionary file itself.
import { randomBytes } from "node:crypto";
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
import { signInAs } from "../overlay-kit";
import { withDb } from "../rs007-money-kit";
import { composeMatchRef } from "../../src/lib/match-ref";
import { boardRoundCodes } from "../../src/components/v2/board/round-codes";

type Locale = "en" | "fr" | "es" | "nl";
const dictionary = (locale: Locale) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dictionary("en");
const FR = dictionary("fr");
const DICTS: Record<Locale, Record<string, string>> = { en: EN, fr: FR, es: dictionary("es"), nl: dictionary("nl") };
type Dict = typeof EN;

/** `{name}` placeholders, filled the way `useMsg` fills them. */
const say = (dict: Dict, key: string, vars: Record<string, string | number> = {}): string => {
  const template = dict[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};
const lookup = (dict: Dict) => (key: string, vars?: Record<string, string | number>) => say(dict, key, vars);

/** A realistic long entrant name (43 characters): the truncate / min-w-0
 *  chain on Confirm and Waiting is only exercised by a name this long. */
const LONG_NAME = "Maximiliana Featherstonehaugh-Wolfeschlegel";

/** A division name long enough that the scorebug's first line is under
 *  pressure at 320: the division TRUNCATES there, which `expectRoundWhole`
 *  asserts as a precondition (review round 2) — with a short name the round
 *  would have room anyway and the check would prove nothing. */
const DIVISION = `Scan Cup ${TAG} Open Championship`;

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
/** Page loads: the final (en, once), the French Waiting whose refresh is
 *  weighed, and every other screen per locale. */
const NAVIGATIONS = 13;
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
  /** The board's role columns, which `boardRoundCodes` reads. */
  ext_key?: string | null;
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
}

/** The match as the schedule board's card names it ("SF·1"), in `dict`. */
function boardRef(dict: Dict, drawn: Fx[], stage: { id: string; kind: string }, id: string): string {
  const rc = boardRoundCodes(drawn, [stage], lookup(dict)).get(id);
  expect(rc, "the board codes every knockout round").toBeDefined();
  const f = drawn.find((d) => d.id === id)!;
  return composeMatchRef(f.round_no, rc!.refSeq, lookup(dict), rc!.code);
}

/** Where a piece of text actually paints, against everything that could clip
 *  it. Measured on the text's own RANGE, never on the element's scroll box:
 *  an inline span's `scrollWidth` and `clientWidth` are both 0, so an overflow
 *  check on one passes whatever happens to it (review round 2), and a label
 *  clipped by an `overflow-hidden` ANCESTOR is still "visible" to Playwright.
 *  `cut` names every ancestor that clips (overflow not `visible`) and does not
 *  contain the whole range; `within(el)` is the same test against one box. */
async function textFit(el: Locator, within?: Locator) {
  const box = within ? await within.evaluate((w) => {
    const r = w.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }) : null;
  const fit = await el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    const cut: string[] = [];
    for (let a = node.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) {
        cut.push(`<${a.tagName.toLowerCase()} class="${a.className}">`.slice(0, 160));
      }
    }
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, vw: document.documentElement.clientWidth, cut };
  });
  return {
    ...fit,
    outside:
      box === null
        ? false
        : fit.left < box.left - 0.5 || fit.right > box.right + 0.5 || fit.top < box.top - 0.5 || fit.bottom > box.bottom + 0.5,
  };
}

/** The ref must be whole on screen at 320: its text inside the Waiting card,
 *  inside the viewport, and cut by no clipping ancestor (review minor c — it
 *  used to be truncated away; review round 2 — measured by range, not by the
 *  inline span's scroll box, which is always 0 × 0). */
async function expectRefWhole(page: Page, ref: Locator, card: Locator, text: string, label: string) {
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(ref, `${label}: the match ref is on screen at 320`).toBeVisible();
  await expect(ref).toHaveText(text);
  const fit = await textFit(ref, card);
  expect(fit.width, `${label}: the ref paints some text (the positive pair)`).toBeGreaterThan(0);
  expect(fit.outside, `${label}: the ref's text sits inside the Waiting card`).toBe(false);
  expect(fit.cut, `${label}: nothing clips the ref`).toEqual([]);
  expect(fit.left, `${label}: the ref starts inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(fit.right, `${label}: the ref ends inside the viewport`).toBeLessThanOrEqual(fit.vw);
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The scorebug's round, whole at 320 (owner ruling: the scorebug names the
 *  round as the board does, so the part a scorer checks against the sheet must
 *  never be the part that is cut). PRECONDITION first (review round 2): the
 *  division beside it truncates there — the line is under pressure — or a
 *  short name would pass this without testing anything. */
async function expectRoundWhole(page: Page, label: string, what: string) {
  await page.setViewportSize({ width: 320, height: 900 });
  const round = page.getByTestId("scan-scorebug-round");
  await expect(round, `${what}: the round is the board's`).toContainText(label);
  const division = page.getByTestId("scan-scorebug-division");
  await expect(division).toHaveText(DIVISION);
  expect(
    await division.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    `${what} 320: precondition — the division truncates, so the line is under pressure`,
  ).toBe(true);
  const fit = await textFit(round);
  expect(fit.width, `${what} 320: the round paints some text`).toBeGreaterThan(0);
  expect(fit.cut, `${what} 320: nothing clips the round "${label}"`).toEqual([]);
  expect(fit.left, `${what} 320: the round starts inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(fit.right, `${what} 320: the round ends inside the viewport`).toBeLessThanOrEqual(fit.vw);
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
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
async function phoneIn(browser: Browser, locale: Locale): Promise<Page> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  await ctx.addCookies([{ name: "seazn_locale", value: locale, url: new URL(test.info().project.use.baseURL!).origin }]);
  return ctx.newPage();
}

/** A phone that has never been to the site: no locale cookie, only its
 *  browser's language (Accept-Language), the way a volunteer scans a sheet.
 *  The root layout's `<html lang>` fallback reads the cookie, so on this phone
 *  only the page itself can say the page is French. */
async function freshPhoneIn(browser: Browser, acceptLanguage: string): Promise<Page> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState(), locale: acceptLanguage });
  expect(
    (await ctx.cookies()).some((c) => c.name === "seazn_locale"),
    "precondition: no locale cookie on a fresh phone",
  ).toBe(false);
  return ctx.newPage();
}

/** Step 1b: one Waiting refresh on a fresh French phone, weighed and printed.
 *  The bound is derived from the dictionary file: a refresh that carried it
 *  would decode to at least that much (the build that still wrapped Waiting in
 *  the provider decoded to 390,387 B against a 363,631 B dictionary). */
async function weighFrenchWaitingRefresh(browser: Browser, secret: string, testInfo: TestInfo) {
  const scanPhone = await freshPhoneIn(browser, "fr-FR");
  try {
    await scanPhone.goto(`/score/${secret}`);
    const waiting = scanPhone.getByTestId("scan-waiting");
    await expect(waiting).toContainText(say(FR, "device.scan.waitingFor"), { timeout: STEP_MS });
    await expect(scanPhone.locator("html"), "the page itself tells a screen reader it is French").toHaveAttribute(
      "lang",
      "fr",
    );
    const refreshed = scanPhone.waitForResponse(
      (r) => r.request().headers()["rsc"] === "1" && new URL(r.url()).pathname === `/score/${secret}`,
      { timeout: STEP_MS },
    );
    await scanPhone.evaluate(() => window.dispatchEvent(new Event("focus")));
    const rscUrl = (await refreshed).url();
    // Weighed by the browser's own account of that request (Resource Timing),
    // not by reading the body back over CDP: the router aborts its fetch once
    // it has consumed the stream (net::ERR_ABORTED right after the response),
    // so CDP keeps no body to read — while Resource Timing records the
    // completed transfer.
    let weight: { transferBytes: number; encodedBytes: number; decodedBytes: number } | null = null;
    await expect
      .poll(
        async () => {
          weight = await scanPhone.evaluate((url) => {
            const e = performance.getEntriesByType("resource").filter((r) => r.name === url).at(-1) as
              | PerformanceResourceTiming
              | undefined;
            return e && e.responseEnd > 0
              ? { transferBytes: e.transferSize, encodedBytes: e.encodedBodySize, decodedBytes: e.decodedBodySize }
              : null;
          }, rscUrl);
          return weight !== null;
        },
        { timeout: STEP_MS, message: "the browser timed the refresh" },
      )
      .toBe(true);
    const dictBytes = Buffer.byteLength(JSON.stringify(FR));
    const measured = { ...weight!, frDictionaryBytes: dictBytes };
    console.log(`[scan-screens] one French Waiting refresh: ${JSON.stringify(measured)}`);
    await testInfo.attach("fr-waiting-refresh-weight", { body: JSON.stringify(measured), contentType: "application/json" });
    expect(measured.decodedBytes, "the refresh carried a body").toBeGreaterThan(0);
    expect(measured.decodedBytes, "one refresh weighs less than the dictionary it used to carry").toBeLessThan(dictBytes);
    await expect(waiting, "still French after the refresh").toContainText(say(FR, "device.scan.waitingFor"));
    await expect(scanPhone.locator("html")).toHaveAttribute("lang", "fr");
  } finally {
    await scanPhone.context().close();
  }
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
    name: DIVISION,
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
  // Every match name below is the board's (owner ruling 2026-09-24).
  const cup = { id: stage.data!.id, kind: "knockout" };
  const refOf = (dict: Dict, id: string) => boardRef(dict, drawn, cup, id);
  /** "Winner of SF·2", the way the board names a seat its feeder fills. */
  const winnerOf = (dict: Dict, feeder: Fx) => say(dict, "slot.winner_match", { ext: refOf(dict, feeder.id) });
  /** The round-number form the board does NOT print for a knockout. */
  const roundForm = (dict: Dict, f: Fx) => say(dict, "slot.match_ref", { round: f.round_no, seq: f.seq_in_round });
  expect(refOf(EN, final.id), "the differential: the board codes the final").not.toBe(roundForm(EN, final));
  /** The scorebug's round, as the board's legend names it ("Final"). */
  const roundLabelOf = (dict: Dict, f: Fx) => {
    const label = boardRoundCodes(drawn, [cup], lookup(dict)).get(f.id)?.label;
    expect(label, "the board labels every knockout round").toBeDefined();
    expect(label, "…by name, not by number").not.toBe(say(dict, "schedule.round", { n: f.round_no }));
    return label!;
  };
  /** The scorebug's first line: the division, then the board's round — and at
   *  320 the round is whole (a clipped label is still "visible" to Playwright,
   *  so `expectRoundWhole` measures its text against whatever could clip it). */
  const scorebugRound = async (page: Page, dict: Dict, f: Fx) => {
    const label = roundLabelOf(dict, f);
    await expect(
      page.getByText(`${DIVISION} · ${label}`),
      "the scorebug names the round as the board does",
    ).toBeVisible();
    await expectRoundWhole(page, label, `scorebug ${f.id}`);
  };

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

    // ---- 1b. What one French Waiting refresh weighs (review I2) --------------
    // A fresh, unrouted French phone on the same Waiting; a tab return fires
    // the same `router.refresh()` the POLL_MS interval does. Weighed before
    // any label is asserted, so a build that still wraps Waiting in the
    // dictionary reports its size here rather than failing first on a name.
    await weighFrenchWaitingRefresh(browser, finalLink.secret, testInfo);

    await expect(waiting).toContainText(say(EN, "device.scan.waitingFor"));
    await expect(waiting).toContainText(winnerOf(EN, longSemi));
    await expect(waiting).toContainText(winnerOf(EN, otherSemi));
    await expect(waiting, "never the round number the board does not print").not.toContainText(roundForm(EN, otherSemi));
    await expect(waiting).toContainText(say(EN, "device.scan.waitingHint"));
    await expectRefWhole(phone, waiting.getByTestId("scan-waiting-ref"), waiting, refOf(EN, final.id), "en Waiting");
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
    await expect(waiting, "one side is still unknown, so still Waiting").toContainText(winnerOf(EN, otherSemi));
    shots.push(...(await capture(phone, waiting, testInfo, "en-waiting")));
    await frPhone.goto(`/score/${finalLink.secret}`);
    const frWaiting = frPhone.getByTestId("scan-waiting");
    await expect(frWaiting).toContainText(say(FR, "device.scan.waitingFor"), { timeout: STEP_MS });
    await expect(frWaiting).toContainText(LONG_NAME);
    await expect(frWaiting).toContainText(winnerOf(FR, otherSemi));
    await expectRefWhole(frPhone, frWaiting.getByTestId("scan-waiting-ref"), frWaiting, refOf(FR, final.id), "fr Waiting");
    shots.push(...(await capture(frPhone, frWaiting, testInfo, "fr-waiting")));

    // ---- 3. The decided semi's own sheet: View-only, carried forward ---------
    await other.goto(`/score/${longSemiLink.secret}`);
    const carried = other.getByTestId("scan-view-only");
    await expect(carried).toHaveText(say(EN, "device.scan.viewOnly.carried"), { timeout: STEP_MS });
    await expect(other.locator('[data-role="pad-v3"]'), "View-only has no pad").toHaveCount(0);
    await scorebugRound(other, EN, longSemi);
    shots.push(...(await capture(other, carried, testInfo, "en-view-only-carried")));
    await frPhone.goto(`/score/${longSemiLink.secret}`);
    const frCarried = frPhone.getByTestId("scan-view-only");
    await expect(frCarried).toHaveText(say(FR, "device.scan.viewOnly.carried"), { timeout: STEP_MS });
    await scorebugRound(frPhone, FR, longSemi);
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
    await expect(confirm, "the Match line is the board's name for it").toContainText(refOf(EN, final.id));
    await expect(confirm).not.toContainText(roundForm(EN, final));
    await scorebugRound(phone, EN, final);
    await expect(confirm.getByTestId("score-start-match")).toHaveText(say(EN, "score.startMatch"));
    await expect(phone.locator('[data-role="pad-v3"]'), "no pad before Start").toHaveCount(0);
    shots.push(...(await capture(phone, confirm, testInfo, "en-confirm")));
    await frPhone.goto(`/score/${finalLink.secret}`);
    const frConfirm = frPhone.getByTestId("scan-confirm");
    await expect(frConfirm).toContainText(say(FR, "device.scan.confirmTitle"), { timeout: STEP_MS });
    await expect(frConfirm.getByTestId("score-start-match")).toHaveText(say(FR, "score.startMatch"));
    await expect(frConfirm, "the Match line, in French board codes").toContainText(refOf(FR, final.id));
    await scorebugRound(frPhone, FR, final);
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

// ── THE LONGEST ROUND LABEL, BESIDE A LOGO (review round 2) ─────────────────
// The scorebug's round never shrinks (the division gives way to it), and that
// alone CLIPPED the board's longest labels at 320 with no ellipsis: fr "Grande
// finale (revanche)" by 21px, and with an org logo on the line even en "Grand
// final (reset)". A double-elimination bracket reset carries the longest label
// the board prints; this plays one to its reset and reads it in all four
// languages at 320, beside a logo, with a division long enough to truncate.
//
// REACH: an org of this test's own (Pro, with a logo — the shared org has none,
// and giving it one would change every other spec's pages mid-run), seeded by
// SQL as overlay-kit.ts seeds its org; then the organiser's API plays the
// bracket until the Lower-bracket champion wins the grand final, which is what
// seats the reset. THE TEST, in the browser: the reset's Confirm scorebug.
/** Org seed + sign-in, then competition, division, entrants, stage, generate,
 *  start, the draw, five results and their reads, the reset's poll, a mint. */
const DE_REACHES = 24;
const DE_LOCALES: readonly Locale[] = ["en", "fr", "es", "nl"];
const DE_BUDGET_MS = Math.max(120_000, STEP_MS + DE_REACHES * REACH_MS + DE_LOCALES.length * (STEP_MS + 3 * REACH_MS));

test("the scorebug's LONGEST round label — a double-elimination reset — is whole at 320 beside the org logo, in en, fr, es and nl", async ({
  browser,
}, testInfo) => {
  test.setTimeout(DE_BUDGET_MS);

  // ---- Reach: a Pro org with a logo, and its owner signed in -----------------
  const tag = `${TAG}-${randomBytes(3).toString("hex")}`;
  const email = `delivered+scan-de-${tag}@resend.dev`;
  await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${email}, ${"Scan DE Owner " + tag}, true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by, logo_url)
      values (${"Scan DE Org " + tag}, ${"scan-de-" + tag}, 'active', ${userId}, '/logo-square.png') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${orgId}`;
  });
  const owner = await (await browser.newContext()).newPage();
  try {
    await signInAs(owner, email);
    const api = owner.request;

    // ---- Reach: a started four-entrant double elimination --------------------
    const comp = await apiJson<{ id: string }>(api, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Scan DE ${tag}`,
      visibility: "private",
    });
    expect(comp.status, `competition POST → ${JSON.stringify(comp.error)}`).toBe(201);
    const div = await apiJson<{ id: string }>(api, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: DIVISION,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(div.status, `division POST → ${JSON.stringify(div.error)}`).toBe(201);
    const divisionId = div.data!.id;
    const added = await addEntrantsViaApi(api, divisionId, [`Ada ${tag}`, `Bo ${tag}`, `Cy ${tag}`, `Di ${tag}`]);
    expect(added.status).toBe(201);
    const stage = await apiJson<{ id: string }>(api, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "double_elim",
      name: "Double",
      // The reset is generated only on request (`generateDoubleElim`'s
      // `bracketReset`, read from the stage config in usecases/stages.ts).
      config: { bracketReset: true },
    });
    expect(stage.status, `stage POST → ${JSON.stringify(stage.error)}`).toBe(201);
    const generated = await apiJson(api, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    expect(generated.status, `generate → ${JSON.stringify(generated.error)}`).toBeLessThan(300);
    const started = await apiJson(api, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
    const draw = async () =>
      (await apiJson<Fx[]>(api, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter(
        (f) => f.stage_id === stage.data!.id,
      );
    const de = { id: stage.data!.id, kind: "double_elim" };

    // The label under test is the LONGEST the board prints for this bracket,
    // in French — found by the board's own function, not typed here.
    const drawn = await draw();
    const frLabels = boardRoundCodes(drawn, [de], lookup(FR));
    const longest = [...frLabels.entries()].sort(([, a], [, b]) => b.label.length - a.label.length)[0]!;
    const reset = drawn.find((f) => f.id === longest[0])!;
    expect(
      reset.conditional,
      `the longest label is the bracket reset's: ${JSON.stringify(drawn.map((f) => [f.lane, f.round_no, f.conditional, frLabels.get(f.id)?.label]))}`,
    ).toBe(true);
    const grandFinal = drawn.find((f) => f.lane === "GF" && f.conditional !== true)!;
    expect(grandFinal, "the bracket has a grand final before its reset").toBeDefined();

    // ---- Reach: play every match before the grand final (home wins) ----------
    for (let guard = 0; guard < drawn.length; guard++) {
      const ready = (await draw()).find(
        (f) =>
          f.id !== grandFinal.id &&
          f.id !== reset.id &&
          f.status === "scheduled" &&
          f.home_entrant_id !== null &&
          f.away_entrant_id !== null,
      );
      if (ready === undefined) break;
      await scoreFixture(api, ready.id, 2, 1);
    }
    // The Lower-bracket champion wins the grand final: that is what seats the
    // reset. The Winners-bracket champion is its final's home side (home won).
    const settled = await draw();
    const wbFinal = settled
      .filter((f) => f.lane === "WB")
      .sort((a, b) => b.round_no - a.round_no)[0]!;
    const gf = settled.find((f) => f.id === grandFinal.id)!;
    expect([gf.home_entrant_id, gf.away_entrant_id], "both champions reach the grand final").not.toContain(null);
    const lbIsHome = gf.home_entrant_id !== wbFinal.home_entrant_id;
    await scoreFixture(api, gf.id, lbIsHome ? 2 : 1, lbIsHome ? 1 : 2);
    await expect
      .poll(
        async () => {
          const r = (await draw()).find((f) => f.id === reset.id)!;
          return r.home_entrant_id !== null && r.away_entrant_id !== null;
        },
        { timeout: STEP_MS, message: "the record: the grand final's result seats the reset" },
      )
      .toBe(true);
    const link = await apiJson<{ secret: string }>(api, `/api/v1/fixtures/${reset.id}/device-links`, "POST", {});
    expect([200, 201], `mint → ${JSON.stringify(link.error)}`).toContain(link.status);

    // ---- The test: the reset's Confirm scorebug, at 320, in four languages ---
    const shots: string[] = [];
    for (const loc of DE_LOCALES) {
      const label = boardRoundCodes(drawn, [de], lookup(DICTS[loc])).get(reset.id)!.label;
      const phone = await phoneIn(browser, loc);
      try {
        await phone.goto(`/score/${link.data!.secret}`);
        await expect(phone.getByTestId("scan-confirm"), `${loc}: the seated reset opens on Confirm`).toBeVisible({
          timeout: STEP_MS,
        });
        const logo = phone.locator("header p img");
        await expect(logo, `${loc}: the org logo is on the scorebug's line`).toBeVisible();
        await expect(phone.getByTestId("scan-scorebug-round")).toContainText(label);
        await expectRoundWhole(phone, label, `${loc} reset "${label}"`);
        await phone.setViewportSize({ width: 320, height: 900 });
        const path = testInfo.outputPath(`${loc}-de-reset-confirm-320.png`);
        await phone.screenshot({ path, fullPage: true, animations: "disabled" });
        await testInfo.attach(`${loc}-de-reset-confirm-320`, { path, contentType: "image/png" });
        shots.push(path);
      } finally {
        await phone.context().close();
      }
    }
    // Four pictures, and four DIFFERENT ones (AGENTS.md 10).
    expect(shots).toHaveLength(DE_LOCALES.length);
    expect(new Set(shots.map((p) => readFileSync(p).toString("base64"))).size, "no two captures are identical").toBe(
      DE_LOCALES.length,
    );
  } finally {
    await owner.context().close();
  }
});
