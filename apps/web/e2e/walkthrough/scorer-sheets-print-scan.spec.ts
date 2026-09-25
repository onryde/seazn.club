// WALKTHROUGH — scorer sheets, the whole journey (Task 10): an organiser
// prints a day's scorer sheets from the competition's Schedule page, cuts the
// cards, and an umpire at each court scans one with a phone.
//
// The organiser's story: open Schedule, pick the day, press "Print scorer
// sheets", get a PDF. The umpire's story: scan the card, see WHICH match the
// phone is about to score (names and the board's code, the same ones printed
// on the card), press Start, score it. Every QR in this file is read from the
// downloaded PDF's PIXELS — the page rasterised by a real anti-aliasing
// renderer and each card's symbol decoded by a real QR decoder — never minted
// over the API and never read from a link annotation alone (AGENTS.md 1: the
// seam is proven through its real producer, the printed sheet, and its real
// consumer, a phone).
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the organiser's API: a competition of the test's own (one per
// test, so one red cannot hide another — AGENTS.md 21: no serial mode), its
// division STARTED the way the organiser starts it (a scan of an unstarted
// division is a different screen), the day's fixtures timed, and the other
// side's results where the story needs them. THE TEST, in the browser: the
// print control, the scan screens, the pad, the desk's Pair / Unpair, the
// console's hand-over panel.
//
// ── WHAT THE OTHER SCORER-SHEETS WALKTHROUGHS OWN (not repeated here) ──────
// print-control: the control's layout at every width, the day list, refusals
// and the Community pill. scan-screens: every scan screen in en + fr against
// an API-minted link, the scorebug's round at 320, one Waiting refresh's
// weight. handover-panel: the panel in every state. carried-forward: a REAL
// inner-pad tap refused RESULT_CARRIED_FORWARD. This file owns the JOURNEY:
// the printed sheet → the scan → the score, and the regressions that live
// between those surfaces. Its visual gate captures each scan screen where the
// journey reaches it, from a printed QR, at 320 / 768 / 1280.
//
// ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
// Every sentence is read from the dictionary the page renders. Every wait is
// derived from the constant that governs it (AGENTS.md 20): Waiting refreshes
// every POLL_MS (read by `padPollMs()`), a pad tap soft-commits for HOLD_MS
// (`scorepad/queue.ts`). Every match name is the schedule board's, derived by
// the board's own `boardRoundCodes` + `composeMatchRef` over the draw read
// back from the API (owner ruling 2026-09-24) — never a typed "SF·1".
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  activeOrgIdFromRequest,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  divisionPath,
  expectNoHorizontalScroll,
  fixturePath,
  loginUi,
  orgTimezoneSql,
  scoreFixture,
  seedScoredDivision,
  TAG,
} from "../helpers";
import { waitForHydration } from "../directory-kit";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { padPollMs } from "../realtime-propagation-kit";
import { pdfLines, pdfLinks, pdfTextRuns } from "../pdf-uris";
import { decodeEveryCard } from "../../src/server/__tests__/_sheet-raster";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { composeMatchRef } from "../../src/lib/match-ref";
import { boardRoundCodes } from "../../src/components/v2/board/round-codes";

const EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** `{name}` placeholders, filled the way `useMsg` fills them. */
const say = (key: string, vars: Record<string, string | number> = {}): string => {
  const template = EN[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};
const lookup = (key: string, vars?: Record<string, string | number>) => say(key, vars);

/** A realistic long entrant name (43 characters): the truncate / min-w-0
 *  chain on the scan screens, and the card's two-line name, are only
 *  exercised by a name this long. */
const LONG_NAME = "Maximiliana Featherstonehaugh-Wolfeschlegel";

// ---- The budget, derived from the steps (AGENTS.md 20) ----------------------
/** A page load, a seed, a print, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click, a local assertion, or one width of a capture. */
const REACH_MS = 5_000;
/** Waiting re-renders every POLL_MS; a side filled just after one refresh is
 *  seen on the next, plus the server render and the paint. */
const WAITING_BUDGET_MS = padPollMs() + STEP_MS;
/** A pad entry soft-commits: it is SENT only once HOLD_MS has run out, then
 *  the server folds it and a poll reads it back. */
const SEND_MS = HOLD_MS + STEP_MS;
const WIDTHS = [320, 768, 1280] as const;
const budgetFor = ({
  navs,
  acts,
  sends = 0,
  waits = 0,
  captures = 0,
}: {
  navs: number;
  acts: number;
  sends?: number;
  waits?: number;
  captures?: number;
}): number =>
  Math.max(
    120_000,
    navs * STEP_MS + acts * REACH_MS + sends * SEND_MS + waits * WAITING_BUDGET_MS + captures * WIDTHS.length * REACH_MS,
  );

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  status: string;
  outcome: { winner?: string } | null;
  /** The board's role columns, which `boardRoundCodes` reads. */
  ext_key?: string | null;
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
}

/** `YYYY-MM-DD` of an instant on `tz`'s wall clock — the sheet's day is the
 *  ORG's calendar day (lib/scorer-sheets.ts `localDateOf`), restated here so
 *  the spec does not import app code for it. */
const localDate = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

async function fixturesOf(request: APIRequestContext, divisionId: string): Promise<Fx[]> {
  const res = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
  return res.data!;
}

async function fixture(request: APIRequestContext, id: string): Promise<Fx> {
  const res = await apiJson<Fx>(request, `/api/v1/fixtures/${id}`);
  expect(res.status, `GET /fixtures/${id}`).toBe(200);
  return res.data!;
}

async function ledger(
  request: APIRequestContext,
  id: string,
): Promise<{ id: string; seq: number; type: string; device_link_id: string | null }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; device_link_id: string | null }[]>(
    request,
    `/api/v1/fixtures/${id}/events?since_seq=0`,
  );
  expect(res.status, `GET /fixtures/${id}/events`).toBe(200);
  return res.data!;
}

async function namesOf(request: APIRequestContext, divisionId: string): Promise<Map<string, string>> {
  const res = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
  expect(res.status, `GET /divisions/${divisionId}/entrants`).toBe(200);
  return new Map(res.data!.map((e) => [e.id, e.display_name]));
}

/** The org's zone — the clock the sheet's day is read on. */
async function orgZone(request: APIRequestContext): Promise<string> {
  return (await orgTimezoneSql(await activeOrgIdFromRequest(request))) ?? "UTC";
}

/** Precondition the dispatch rules: the division is STARTED, the way the
 *  organiser starts it — a scan of an unstarted division is its own screen. */
async function expectStarted(request: APIRequestContext, divisionId: string) {
  const div = await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`);
  expect(div.status).toBe(200);
  expect(div.data!.status, "precondition: the division is started").toBe("active");
}

/** The scheduled matches on the org-clock day of the earliest timed match. */
function dayOf(fixtures: readonly Fx[], tz: string): { day: string; onDay: Fx[] } {
  const timed = fixtures
    .filter((f) => f.status === "scheduled" && f.scheduled_at !== null)
    .sort((a, b) => a.scheduled_at!.localeCompare(b.scheduled_at!));
  expect(timed.length, "precondition: the seed timed some matches").toBeGreaterThan(0);
  const day = localDate(new Date(timed[0]!.scheduled_at!), tz);
  return { day, onDay: timed.filter((f) => localDate(new Date(f.scheduled_at!), tz) === day) };
}

/** The organiser prints: the competition's Schedule page, the day picked in
 *  the control, "Print scorer sheets", and the browser's download. */
async function printDay(page: Page, schedulePath: string, day: string): Promise<Buffer> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(schedulePath);
  const control = page.getByTestId("print-sheets");
  await expect(control, "the organiser has the print control").toBeVisible({ timeout: STEP_MS });
  await waitForHydration(control);
  const select = page.getByTestId("print-sheets-day");
  await select.selectOption(day);
  await expect(select).toHaveValue(day);
  const submit = page.getByTestId("print-sheets-submit");
  await expect(submit).toHaveText(say("sheets.print"));
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: STEP_MS }), submit.click()]);
  expect(download.suggestedFilename()).toBe(`scorer-sheets-${day}.pdf`);
  const pdf = readFileSync((await download.path())!);
  expect(pdf.subarray(0, 5).toString("latin1"), "the saved file is a PDF").toBe("%PDF-");
  return pdf;
}

/** The downloaded sheet, kept beside the test's pictures (a `body` attachment
 *  reaches only the HTML reporter) so a person can rasterise and read it. */
async function keepPdf(testInfo: TestInfo, name: string, pdf: Buffer) {
  const path = testInfo.outputPath(name);
  writeFileSync(path, pdf);
  await testInfo.attach(name, { path, contentType: "application/pdf" });
}

/** Whitespace-free, so a name the card wraps over two lines still reads as
 *  the one name. */
const squash = (s: string) => s.replace(/\s+/g, "");

interface Card {
  page: number;
  /** The link annotation laid over the symbol. */
  uri: string;
  /** What a decoder reads from the symbol's PIXELS (null: unreadable). */
  decoded: string | null;
  /** Every text run printed on this card, trimmed, in drawing order — the
   *  time, the board's match code, the division, then each side's line(s).
   *  One run per `doc.text` call, so a field is ONE entry: compare a field
   *  with `lines.includes(x)`, never a substring of `text` ("F·1" is inside
   *  "Winner of SF·1"). */
  lines: string[];
  /** `lines` joined with spaces — for names, which may wrap over two runs. */
  text: string;
}

/**
 * Every card of a printed sheet: its QR decoded from the page's pixels (the
 * raster path the renderer's own tests gate on, `_sheet-raster.ts`), and the
 * text printed on it.
 *
 * This MIRRORS the renderer's layout (`src/server/scorer-sheet-pdf.ts`) and
 * must move with it:
 * - `renderScorerSheetPdf`'s cell loop — COLS = 3 equal-width cards per row,
 *   `cardW = (pageW - EDGE * 2) / COLS`, rows stacked from the header's bottom;
 * - `drawCutLines` — the first dashed horizontal line spans the full page
 *   width at the grid's top, and everything above it is the page header
 *   (`drawHeader`: eyebrow, title, court heading, check-names line);
 * - `drawCard` — every text line (time, `matchRef`, division, `drawSide` ×2)
 *   is drawn ABOVE the card's QR, which is centred horizontally in the card
 *   and carries the `doc.link` annotation.
 * So a text run belongs to the card whose QR is the nearest one BELOW it in
 * the same column, the column being the QR whose centre is nearest (each QR is
 * centred in an equal-width card, so the midpoint between two centres IS the
 * cut line). If the renderer ever puts text below the QR or spans a card over
 * two columns, this reader — not the product — is what must change.
 */
async function readCards(pdf: Buffer): Promise<Card[]> {
  const links = pdfLinks(pdf);
  const decoded = await decodeEveryCard(pdf, "dpi90");
  const gridTop = new Map<number, number>();
  for (const l of pdfLines(pdf)) {
    if (l.y1 !== l.y2 || Math.abs(l.x2 - l.x1) < 500) continue; // full-width cut lines only
    gridTop.set(l.page, Math.min(gridTop.get(l.page) ?? Infinity, l.y1));
  }
  const texts = links.map(() => [] as string[]);
  for (const run of pdfTextRuns(pdf)) {
    if (run.y <= (gridTop.get(run.page) ?? Infinity)) continue;
    const onPage = links.map((l, i) => ({ l, i })).filter(({ l }) => l.page === run.page);
    if (onPage.length === 0) continue;
    const dx = (l: (typeof links)[number]) => Math.abs(l.x + l.width / 2 - run.x);
    const nearest = Math.min(...onPage.map(({ l }) => dx(l)));
    const below = onPage
      .filter(({ l }) => Math.abs(dx(l) - nearest) < 1 && l.top >= run.y)
      .sort((a, b) => a.l.top - b.l.top)[0];
    if (below && run.text.trim() !== "") texts[below.i]!.push(run.text.trim());
  }
  return links.map((l, i) => ({
    page: l.page,
    uri: l.uri,
    decoded: decoded[i] ?? null,
    lines: texts[i]!,
    text: texts[i]!.join(" "),
  }));
}

/** Every card's QR decodes, from pixels, to the link its card carries; each is
 *  a scoring link of its own; and the link is never printed as text (the
 *  token is a bearer secret, and a photo of a sheet must not leak it). */
function expectEveryQrDecodes(cards: readonly Card[], pdf: Buffer) {
  expect(
    cards.map((c) => c.decoded),
    "every QR decodes from the page's pixels to its own card's link",
  ).toEqual(cards.map((c) => c.uri));
  expect(new Set(cards.map((c) => c.uri)).size, "one link per card").toBe(cards.length);
  const runs = pdfTextRuns(pdf);
  for (const c of cards) {
    const token = new URL(c.uri).pathname.match(/^\/score\/(dl_[^/]+)$/)?.[1];
    expect(token, `a scoring link: ${c.uri}`).toBeTruthy();
    expect(runs.filter((r) => r.text.includes(token!)), "the link is never printed as text").toEqual([]);
  }
}

/** The fonts the sheet is SET in. The prod build must embed the brand fonts
 *  (a subset tag, `ABCDEF+Inter…`) — a missing font directory falls back to
 *  Helvetica silently (brandFontDir, Task 8 review I1), and this prod-build
 *  journey is the only prod-layout witness of that fix. */
function expectBrandFontsEmbedded(pdf: Buffer) {
  const raw = pdf.toString("latin1");
  expect(raw, "the sheet embeds Inter").toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter/);
  expect(raw, "…and no standard font stands in for it").not.toMatch(/\/BaseFont\s*\/Helvetica/);
  const fonts = [...new Set(pdfTextRuns(pdf).map((r) => r.font))];
  expect(fonts.length, "the sheet has text").toBeGreaterThan(0);
  expect(
    fonts.filter((f) => !/^[A-Z]{6}\+(Inter|BarlowCondensed)/.test(f)),
    "every line is set in an embedded brand font",
  ).toEqual([]);
}

/** A competition of the test's own: one generic division, `names` entered,
 *  one stage of `stage.kind`, and the division STARTED the way the organiser
 *  starts it. A knockout is drawn before Start; a Swiss stage is not — Start
 *  mints its unseated round shells, and "Pair next round" seats them. */
async function seedStarted(
  request: APIRequestContext,
  label: string,
  names: string[],
  stage: { kind: "knockout" | "swiss"; name: string; config: Record<string, unknown> },
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${JSON.stringify(comp.error)}`).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division POST → ${JSON.stringify(div.error)}`).toBe(201);
  const divisionId = div.data!.id;
  const added = await addEntrantsViaApi(request, divisionId, names);
  expect(added.status, "entrants POST").toBe(201);
  const st = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, ...stage });
  expect(st.status, `stage POST → ${JSON.stringify(st.error)}`).toBe(201);
  if (stage.kind === "knockout") {
    const generated = await apiJson(request, `/api/v1/stages/${st.data!.id}/generate`, "POST");
    expect(generated.status, `generate → ${JSON.stringify(generated.error)}`).toBeLessThan(300);
  }
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
  await expectStarted(request, divisionId);
  return { competitionId: comp.data!.id, divisionId, stageId: st.data!.id };
}

/** Times `fixtures` on one day, half an hour apart, over the organiser's API. */
async function timeOnOneDay(request: APIRequestContext, fixtures: readonly Fx[]) {
  const base = Date.UTC(2026, 9, 3, 10, 0, 0); // 2026-10-03 10:00Z
  for (const [i, f] of fixtures.entries()) {
    const res = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
      scheduled_at: new Date(base + i * 30 * 60_000).toISOString(),
    });
    expect(res.status, `timing ${f.id}: ${JSON.stringify(res.error)}`).toBe(200);
  }
}

/** The one card that prints every one of `names` — a match's card. */
function cardNaming(cards: readonly Card[], names: readonly string[], what: string): Card {
  const hits = cards.filter((c) => names.every((n) => squash(c.text).includes(squash(n))));
  expect(hits.length, `exactly one card prints ${what}`).toBe(1);
  return hits[0]!;
}

/** An anonymous phone — the token is the only credential here — with the
 *  cookie banner already answered, and NO route anywhere on it. */
async function phoneIn(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  return ctx.newPage();
}

/** The phone's own credential at the API door: its bearer, and NO cookie
 *  (the phone's context is anonymous — a bare `request` fixture would carry
 *  the organiser's session and authorise everything by itself). */
async function asPhone(
  phone: Page,
  token: string,
  path: string,
  method: "GET" | "POST" = "GET",
  data?: unknown,
): Promise<{ status: number; code: string | null }> {
  const res = await phone.context().request.fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status(), code: body.error?.code ?? null };
}

const tokenOf = (uri: string) => new URL(uri).pathname.split("/score/")[1]!;

/** The device-link row id behind a printed card: `POST …/device-links` is the
 *  console's Show QR door — it re-shows the fixture's live sealed link (200,
 *  never a mint) with its secret, so the secret must be the card's token. */
async function linkIdOfCard(request: APIRequestContext, fixtureId: string, card: Card): Promise<string> {
  const shown = await apiJson<{ id: string; secret: string }>(request, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", {});
  expect(shown.status, "the print already made this match's link: a re-show, not a mint").toBe(200);
  expect(shown.data!.secret, "…and it is the very link this card carries").toBe(tokenOf(card.decoded!));
  return shown.data!.id;
}

/** The pad's own score-entry sheet (generic's v3 skin): two number steps,
 *  home then away, each with its own Confirm. */
async function enterResultOnPad(phone: Page, home: number, away: number) {
  const pad = phone.locator('[data-role="pad-v3"]');
  const entry = pad.locator('[data-tile-id="scoreEntry"]');
  await expect(entry).toBeVisible({ timeout: STEP_MS });
  await entry.click();
  const sheet = pad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "the score-entry tile opens the skin's own sheet").toBeVisible({ timeout: STEP_MS });
  for (const value of [String(home), String(away)]) {
    await sheet.getByRole("spinbutton").fill(value);
    await sheet.getByRole("button", { name: say("scorepad.action.confirm"), exact: true }).click();
  }
}

/** Paint is not reach (AGENTS.md 2): a tap at the control's centre must land
 *  on the control, and the control must be a 44px target. */
async function hitTest(control: Locator, label: string) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
}

/** The controls in `scope` that a person can see, by tag and first line of
 *  text, in DOM order — the membership-and-order diff (AGENTS phone
 *  composition), never box sizes. */
const controlSet = (scope: Locator) =>
  scope.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll("*"))]
      .filter((el) => el.matches("button, select, a[href]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      })
      .map((el) => `${el.tagName.toLowerCase()}:${((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").split("\n")[0]!.trim()}`),
  );

/**
 * The visual gate for one screen, at 320 / 768 / 1280: the screen up, no
 * horizontal page scroll, the screen inside the viewport, every button in
 * `scope` hit-tested, a full-page picture — and the SAME controls in the SAME
 * order at 320 as at 1280 (a phone view is a composition of the same set,
 * never a groomed subset). `expected`, when given, pins the set itself at
 * every width: two empty lists are equal, and so are two identical wrong ones.
 * The pictures must exist and the 320 one must differ from the 1280 one
 * (AGENTS.md 10: a gate that shot nothing, or shot one frame thrice, is not a
 * gate).
 */
async function captureScreen(
  page: Page,
  root: Locator,
  scope: Locator,
  testInfo: TestInfo,
  name: string,
  expected?: readonly string[],
): Promise<string[]> {
  const perWidth: string[][] = [];
  const paths: string[] = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(root, `${name} ${w}: the screen is up`).toBeVisible();
    await expectNoHorizontalScroll(page);
    const box = await root.boundingBox();
    expect(box, `${name} ${w}: the screen has a box`).not.toBeNull();
    expect(box!.x + box!.width, `${name} ${w}: the screen ends inside the viewport`).toBeLessThanOrEqual(w + 0.5);
    const buttons = scope.getByRole("button");
    for (let i = 0; i < (await buttons.count()); i++) {
      const b = buttons.nth(i);
      if (await b.isVisible()) await hitTest(b, `${name} ${w} button ${i}`);
    }
    const controls = await controlSet(scope);
    if (expected) expect(controls, `${name} ${w}: the controls this screen promises`).toEqual([...expected]);
    perWidth.push(controls);
    const path = testInfo.outputPath(`${name}-${w}.png`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(`${name}-${w}`, { path, contentType: "image/png" });
    paths.push(path);
  }
  for (const p of paths) expect(statSync(p).size, `${p} was written`).toBeGreaterThan(0);
  expect(readFileSync(paths[0]!).equals(readFileSync(paths[2]!)), `${name}: the 320 and 1280 pictures differ`).toBe(false);
  expect(perWidth[0], `${name}: same controls, same order at 320 and 1280`).toEqual(perWidth[2]);
  await page.setViewportSize({ width: 1280, height: 900 });
  return paths;
}

/** The match as the schedule board's card names it ("SF·1"). */
function boardRef(drawn: Fx[], stage: { id: string; kind: string }, id: string): string {
  const rc = boardRoundCodes(drawn, [stage], lookup).get(id);
  expect(rc, "the board codes every knockout round").toBeDefined();
  const f = drawn.find((d) => d.id === id)!;
  return composeMatchRef(f.round_no, rc!.refSeq, lookup, rc!.code);
}

test("golden: the day printed from the Schedule page — EVERY QR, decoded from the PDF's pixels, opens its own card's match on a phone; one is scored to a result through the pad", async ({
  page,
  browser,
}, testInfo) => {
  // Seed (~4 navs of API) and the first print, budgeted before the card count
  // is known; re-budgeted below once it is.
  test.setTimeout(budgetFor({ navs: 4 + 1, acts: 10 }));
  const names = [LONG_NAME, `Nia ${TAG}`, `Ben ${TAG}`, `Cai ${TAG}`];
  const seeded = await seedScoredDivision(page.request, names, { decide: false });
  await expectStarted(page.request, seeded.divisionId);
  const nameOf = await namesOf(page.request, seeded.divisionId);
  const { day, onDay } = dayOf(await fixturesOf(page.request, seeded.divisionId), await orgZone(page.request));
  expect(onDay.length, "precondition: a round robin of four puts several matches on the day").toBeGreaterThan(1);
  const pairOf = (f: Fx) => [nameOf.get(f.home_entrant_id!)!, nameOf.get(f.away_entrant_id!)!] as const;

  // ---- 1. Print the day ------------------------------------------------------
  const schedulePath = await competitionPath(page.request, seeded.competitionId, "/schedule");
  const pdf = await printDay(page, schedulePath, day);
  await keepPdf(testInfo, "scorer-sheets-golden.pdf", pdf);
  expectBrandFontsEmbedded(pdf);
  const cards = await readCards(pdf);
  expect(cards.length, "one card per scheduled match on the day").toBe(onDay.length);
  // The whole budget, now that the scans are countable: seed and two prints,
  // one scan per card (≈5 checks each), the scored card's scan and reload, a
  // finalize; one pad entry; three screens captured. `setTimeout` mid-test
  // replaces the budget for the whole test, time already spent included.
  test.setTimeout(
    budgetFor({ navs: 4 + 2 + cards.length + 3, acts: 15 + 5 * cards.length, sends: 1, captures: 3 }),
  );
  expectEveryQrDecodes(cards, pdf);
  // The print control, where the journey starts (its own spec owns the rest).
  const control = page.getByTestId("print-sheets");
  await captureScreen(page, control, control, testInfo, "print-control");
  expect(await controlSet(control), "the print control is the day select, then Print").toEqual([
    expect.stringMatching(/^select:/),
    `button:${say("sheets.print")}`,
  ]);

  // ---- 2. A reprint keeps every printed QR alive -----------------------------
  // Compared by what a phone READS off the reprint's pixels, not its link
  // annotations (a camera never sees an annotation).
  const reprintPdf = await printDay(page, schedulePath, day);
  const reprint = await readCards(reprintPdf);
  expectEveryQrDecodes(reprint, reprintPdf);
  expect(reprint.map((c) => c.decoded).sort(), "a reprint's QRs decode to the same links").toEqual(
    cards.map((c) => c.decoded).sort(),
  );

  // ---- 3. Every card, scanned: the phone names THAT card's match -------------
  const phone = await phoneIn(browser);
  try {
    const fixtureOfCard: Fx[] = [];
    for (const [i, card] of cards.entries()) {
      await phone.goto(new URL(card.decoded!).pathname);
      const confirm = phone.getByTestId("scan-confirm");
      await expect(confirm, `card ${i}: a started division's scheduled match opens on Confirm`).toBeVisible({
        timeout: STEP_MS,
      });
      const shown = squash(await confirm.innerText());
      const matches = onDay.filter((f) => pairOf(f).every((n) => shown.includes(squash(n))));
      expect(matches.length, `card ${i}: the phone names exactly one of the day's matches`).toBe(1);
      const f = matches[0]!;
      fixtureOfCard.push(f);
      const [home, away] = pairOf(f);
      const others = names.filter((n) => n !== home && n !== away);
      for (const n of [home, away]) {
        expect(squash(card.text), `card ${i}: the card prints "${n}", the name the phone shows`).toContain(squash(n));
      }
      for (const n of others) {
        expect(shown, `card ${i}: the phone does not name "${n}"`).not.toContain(squash(n));
        expect(squash(card.text), `card ${i}: the card does not print "${n}"`).not.toContain(squash(n));
      }
      const code = (await phone.getByTestId("scan-confirm-match-code").innerText()).replace(/^\s*·\s*/, "").trim();
      expect(code.length, `card ${i}: the phone shows the board's code`).toBeGreaterThan(0);
      expect(card.lines, `card ${i}: the card prints the code the phone shows, as its own line`).toContain(code);
    }
    expect(
      fixtureOfCard.map((f) => f.id).sort(),
      "every match on the day is on exactly one card",
    ).toEqual(onDay.map((f) => f.id).sort());

    // ---- 4. The long name's card: Confirm at every width, then Start and score
    const at = fixtureOfCard.findIndex((f) => pairOf(f).includes(LONG_NAME));
    expect(at, "the long name plays on the day").toBeGreaterThanOrEqual(0);
    const scored = fixtureOfCard[at]!;
    // Which link IS this card: the console's own re-show door (ensure, never
    // mint) hands back the fixture's live link with its secret. Asked before
    // the result, because a decided match no longer re-shows a link.
    const cardLinkId = await linkIdOfCard(page.request, scored.id, cards[at]!);
    await phone.goto(new URL(cards[at]!.decoded!).pathname);
    const confirm = phone.getByTestId("scan-confirm");
    await expect(confirm).toBeVisible({ timeout: STEP_MS });
    await expect(confirm).toContainText(LONG_NAME);
    await captureScreen(phone, confirm, phone.locator("body"), testInfo, "confirm");
    await phone.getByTestId("score-start-match").click();
    await expect(phone.locator('[data-role="pad-v3"]'), "Start opens the pad").toBeVisible({ timeout: STEP_MS });
    await enterResultOnPad(phone, 3, 1);
    await expect
      .poll(async () => (await fixture(page.request, scored.id)).status, {
        timeout: SEND_MS,
        message: "the phone's result reaches the server (it soft-commits for HOLD_MS first)",
      })
      .toBe("decided");
    const decided = await fixture(page.request, scored.id);
    expect(decided.outcome?.winner, "3–1 to the home side, as entered").toBe(scored.home_entrant_id);
    const events = await ledger(page.request, scored.id);
    const result = events.find((e) => e.type === "generic.result");
    expect(result?.device_link_id, "the result was written by THIS card's link, not the organiser").toBe(cardLinkId);

    // ---- 5. The organiser finalises: the card's scan says the match is over ---
    const finalized = await apiJson(page.request, `/api/v1/fixtures/${scored.id}/events`, "POST", {
      expected_seq: events.at(-1)!.seq,
      type: "core.finalize",
      payload: {},
    });
    expect(finalized.status, `finalize → ${JSON.stringify(finalized.error)}`).toBe(201);
    await phone.goto(new URL(cards[at]!.decoded!).pathname);
    const over = phone.getByTestId("scan-view-only");
    await expect(over).toHaveText(say("device.scan.viewOnly.finalized"), { timeout: STEP_MS });
    await captureScreen(phone, over, phone.locator("body"), testInfo, "view-only-finalized", []);
  } finally {
    await phone.context().close();
  }
});

test("knockout: the final's printed QR waits on 'Winner of …' and moves to Confirm WITHOUT a reload once both semis are decided", async ({
  page,
  browser,
}, testInfo) => {
  // Seed (~4 navs of API), one print, one scan; one Waiting refresh; one
  // screen captured.
  test.setTimeout(budgetFor({ navs: 4 + 1 + 1, acts: 30, waits: 1, captures: 1 }));
  const names = [LONG_NAME, `Ora ${TAG}`, `Pip ${TAG}`, `Quo ${TAG}`];
  const seeded = await seedStarted(page.request, "Sheets Cup", names, { kind: "knockout", name: "Cup", config: {} });
  const nameOf = await namesOf(page.request, seeded.divisionId);
  // The draw is READ BACK, never assumed.
  const drawn = (await fixturesOf(page.request, seeded.divisionId)).filter((f) => f.stage_id === seeded.stageId);
  const semis = drawn.filter((f) => f.round_no === 1).sort((a, b) => a.seq_in_round - b.seq_in_round);
  const final = drawn.find((f) => f.round_no === 2)!;
  expect(semis, "four entrants draw two semis").toHaveLength(2);
  expect(final, "…feeding one final").toBeDefined();
  await timeOnOneDay(page.request, [...semis, final]);
  const { day, onDay } = dayOf(await fixturesOf(page.request, seeded.divisionId), await orgZone(page.request));
  expect(onDay.map((f) => f.id).sort(), "precondition: the whole bracket is on one org day").toEqual(
    [...semis, final].map((f) => f.id).sort(),
  );
  // Every match name below is the board's (owner ruling 2026-09-24).
  const cup = { id: seeded.stageId, kind: "knockout" };
  const refOf = (id: string) => boardRef(drawn, cup, id);
  const winnerOf = (semi: Fx) => say("slot.winner_match", { ext: refOf(semi.id) });
  const roundForm = (f: Fx) => say("slot.match_ref", { round: f.round_no, seq: f.seq_in_round });
  expect(refOf(final.id), "the differential: the board codes the final").not.toBe(roundForm(final));

  // ---- 1. Print: the final's card prints its feeders as the board names them
  const pdf = await printDay(page, await competitionPath(page.request, seeded.competitionId, "/schedule"), day);
  await keepPdf(testInfo, "scorer-sheets-knockout.pdf", pdf);
  const cards = await readCards(pdf);
  expect(cards.length, "one card per match of the bracket").toBe(3);
  expectEveryQrDecodes(cards, pdf);
  const finalCard = cardNaming(cards, semis.map(winnerOf), "the final's two feeders");
  // The code is its OWN line on the card: a substring test is vacuous here,
  // because "F·1" is inside "Winner of SF·1" on this very card.
  expect(finalCard.lines, "…under the final's board code, printed as its own line").toContain(refOf(final.id));
  expect(squash(finalCard.text), "…never the round form the board does not print").not.toContain(
    squash(roundForm(final)),
  );
  for (const s of semis) {
    const card = cardNaming(cards, [nameOf.get(s.home_entrant_id!)!, nameOf.get(s.away_entrant_id!)!], `semi ${s.id}'s players`);
    expect(card.lines, "a semi's card carries its own board code as its own line").toContain(refOf(s.id));
    expect(squash(card.text), "…never the round form").not.toContain(squash(roundForm(s)));
  }

  // ---- 2. The final, scanned before either semi: Waiting, naming both feeders
  const phone = await phoneIn(browser);
  try {
    // Every DOCUMENT load of the phone: the move below must happen with the
    // phone untouched, so this stays at ONE.
    let loads = 0;
    phone.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === phone.mainFrame()) loads += 1;
    });
    await phone.goto(new URL(finalCard.decoded!).pathname);
    const waiting = phone.getByTestId("scan-waiting");
    await expect(waiting, "a final with no sides yet opens on Waiting").toBeVisible({ timeout: STEP_MS });
    await phone.evaluate(() => {
      (window as unknown as { __firstLoad?: true }).__firstLoad = true;
    });
    await expect(waiting).toContainText(say("device.scan.waitingFor"));
    for (const s of semis) await expect(waiting, "Waiting names the feeder the card prints").toContainText(winnerOf(s));
    for (const s of semis) {
      await expect(waiting, "never the round number the board does not print").not.toContainText(roundForm(s));
    }
    await expect(waiting.getByTestId("scan-waiting-ref"), "the ref the card prints").toHaveText(refOf(final.id));
    await expect(phone.getByTestId("scan-confirm"), "no Confirm while a side is unknown").toHaveCount(0);
    await captureScreen(phone, waiting, phone.locator("body"), testInfo, "waiting", []);

    // ---- 3. The organiser decides both semis: Confirm, with no reload --------
    for (const s of semis) await scoreFixture(page.request, s.id, 2, 1);
    await expect
      .poll(
        async () => {
          const f = await fixture(page.request, final.id);
          return f.home_entrant_id !== null && f.away_entrant_id !== null;
        },
        { timeout: STEP_MS, message: "the record: both winners are seated in the final" },
      )
      .toBe(true);
    const confirm = phone.getByTestId("scan-confirm");
    await expect(confirm, "Waiting moves to Confirm by itself once both sides are known").toBeVisible({
      timeout: WAITING_BUDGET_MS,
    });
    expect(loads, "…with the phone untouched: no reload, no navigation").toBe(1);
    expect(
      await phone.evaluate(() => (window as unknown as { __firstLoad?: true }).__firstLoad === true),
      "…the same window it first loaded",
    ).toBe(true);
    for (const s of semis) await expect(confirm, "Confirm names each semi's winner").toContainText(nameOf.get(s.home_entrant_id!)!);
    await expect(phone.getByTestId("scan-confirm-match-code"), "…under the code the card prints").toHaveText(
      ` · ${refOf(final.id)}`,
    );
    expect(await ledger(page.request, final.id), "the final has no event: nothing its ledger could have told the phone").toEqual(
      [],
    );
  } finally {
    await phone.context().close();
  }
});

test("swiss: a round-1 result scored from a printed card goes View-only once the desk pairs round 2, and comes back when it is unpaired", async ({
  page,
  browser,
}, testInfo) => {
  // Seed (~4 navs of API), one print, one scan, the desk, two phone reloads,
  // the desk's refresh; one pad entry; one screen captured.
  test.setTimeout(budgetFor({ navs: 4 + 1 + 1 + 1 + 2 + 1, acts: 45, sends: 1, captures: 1 }));
  // The 43-character name plays on the target board, so the carried View-only
  // screen is captured with the name that stresses its layout.
  const names = [LONG_NAME, `Jo ${TAG}`, `Kai ${TAG}`, `Lu ${TAG}`];
  const seeded = await seedStarted(page.request, "Sheets Swiss", names, {
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 2 },
  });
  const nameOf = await namesOf(page.request, seeded.divisionId);
  const seatedIn = async (round: number) =>
    (await fixturesOf(page.request, seeded.divisionId))
      .filter((f) => f.stage_id === seeded.stageId && f.round_no === round)
      .filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null)
      .sort((a, b) => a.seq_in_round - b.seq_in_round);
  // Round 1 is seated through "Pair next round"'s own route; round 2's pairing
  // is the desk press under test.
  const paired = await apiJson(page.request, `/api/v1/stages/${seeded.stageId}/generate`, "POST", {});
  expect(paired.status, `round 1 pairing → ${JSON.stringify(paired.error)}`).toBeLessThan(300);
  const r1 = await seatedIn(1);
  expect(r1, "four entrants pair two round-1 boards").toHaveLength(2);
  expect(await seatedIn(2), "precondition: round 2 is not paired yet").toHaveLength(0);
  await timeOnOneDay(page.request, r1);
  const { day, onDay } = dayOf(await fixturesOf(page.request, seeded.divisionId), await orgZone(page.request));
  expect(onDay.map((f) => f.id).sort(), "precondition: round 1 is the day").toEqual(r1.map((f) => f.id).sort());
  const pairOf = (f: Fx) => [nameOf.get(f.home_entrant_id!)!, nameOf.get(f.away_entrant_id!)!];
  const withLongName = r1.find((f) => pairOf(f).includes(LONG_NAME));
  expect(withLongName, "precondition: the long name is paired in round 1").toBeDefined();
  const target = withLongName!;
  const other = r1.find((f) => f.id !== target.id)!;

  const pdf = await printDay(page, await competitionPath(page.request, seeded.competitionId, "/schedule"), day);
  const cards = await readCards(pdf);
  expect(cards.length, "one card per round-1 board").toBe(2);
  expectEveryQrDecodes(cards, pdf);
  const card = cardNaming(cards, pairOf(target), "the target board's players");
  const token = tokenOf(card.decoded!);

  const phone = await phoneIn(browser);
  try {
    // ---- 1. The umpire scans the card and scores round 1 to a result ---------
    await phone.goto(new URL(card.decoded!).pathname);
    const confirm = phone.getByTestId("scan-confirm");
    await expect(confirm).toBeVisible({ timeout: STEP_MS });
    for (const n of pairOf(target)) await expect(confirm, "the phone names the card's players").toContainText(n);
    await phone.getByTestId("score-start-match").click();
    await expect(phone.locator('[data-role="pad-v3"]'), "Start opens the pad").toBeVisible({ timeout: STEP_MS });
    await enterResultOnPad(phone, 2, 1);
    await expect
      .poll(async () => (await fixture(page.request, target.id)).status, {
        timeout: SEND_MS,
        message: "the phone's result reaches the server",
      })
      .toBe("decided");
    const result = (await ledger(page.request, target.id)).find((e) => e.type === "generic.result");
    expect(result?.device_link_id, "the card's link wrote the result").toBeTruthy();
    await scoreFixture(page.request, other.id, 2, 1);

    // ---- 2. The organiser pairs round 2 on the desk — the REAL producer -------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(page.request, seeded.divisionId, "?tab=fixtures"));
    const desk = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { level: 3, name: "1. Swiss", exact: true }) });
    const pairNext = desk.getByTestId("stage-generate");
    await expect(pairNext).toHaveText(say("schedule.pairNext"), { timeout: STEP_MS });
    await waitForHydration(pairNext);
    await pairNext.click();
    await expect
      .poll(async () => (await seatedIn(2)).length, { timeout: STEP_MS, message: "the desk's press seats round 2" })
      .toBe(2);

    // ---- 3. The phone, next time the umpire looks: View-only -----------------
    await phone.reload();
    const viewOnly = phone.getByTestId("scan-view-only");
    await expect(viewOnly, "round 2 is paired off this result").toHaveText(say("device.scan.viewOnly.carried"), {
      timeout: STEP_MS,
    });
    await expect(phone.getByTestId("device-void-mine"), "View-only offers no undo").toHaveCount(0);
    await captureScreen(phone, viewOnly, phone.locator("body"), testInfo, "view-only-carried", []);
    // …and the server says the same to the card's own bearer, writing nothing.
    const before = await ledger(page.request, target.id);
    const refused = await asPhone(phone, token, `/api/v1/fixtures/${target.id}/events`, "POST", {
      expected_seq: before.at(-1)!.seq,
      type: "core.void",
      payload: { event_id: result!.id },
    });
    expect(refused, "a raw void with the card's bearer is refused as carried forward").toEqual({
      status: 403,
      code: "RESULT_CARRIED_FORWARD",
    });
    expect((await ledger(page.request, target.id)).length, "…and nothing was written").toBe(before.length);

    // ---- 4. The organiser unpairs round 2: the umpire's undo comes back -------
    const unpair = desk.getByTestId("stage-unpair");
    await expect(unpair).toHaveText(say("schedule.unpair"), { timeout: STEP_MS });
    await unpair.click();
    await expect
      .poll(async () => (await seatedIn(2)).length, { timeout: STEP_MS, message: "Unpair empties round 2" })
      .toBe(0);
    await phone.reload();
    const undo = phone.getByTestId("device-void-mine");
    // The ⟲ glyph is aria-hidden, so the name a screen reader announces is
    // exactly the dictionary copy.
    await expect(undo, "the umpire's own undo is back").toHaveAccessibleName(say("device.undoMine"), {
      timeout: STEP_MS,
    });
    await expect(undo, "…and it can be pressed").toBeEnabled();
    await expect(phone.getByTestId("scan-view-only"), "…and View-only is gone").toHaveCount(0);
    // The positive twin of step 3's refusal: the SAME bearer, the SAME void,
    // now accepted — so the 403 above was the carried-forward rule, not a
    // bearer or payload that could never void anything.
    const tip = await ledger(page.request, target.id);
    const accepted = await asPhone(phone, token, `/api/v1/fixtures/${target.id}/events`, "POST", {
      expected_seq: tip.at(-1)!.seq,
      type: "core.void",
      payload: { event_id: result!.id },
    });
    expect(accepted, "with round 2 unpaired, the card's bearer voids its own result").toEqual({ status: 201, code: null });
    expect((await ledger(page.request, target.id)).length, "…writing exactly the void").toBe(tip.length + 1);
    await expect
      .poll(async () => (await fixture(page.request, target.id)).status, {
        timeout: STEP_MS,
        message: "the voided result no longer decides the match",
      })
      .not.toBe("decided");
  } finally {
    await phone.context().close();
  }
});

test("regression: the console's hand-over after printing re-shows the SAME QR as the sheet; only Revoke & reissue kills it — and only that card", async ({
  page,
  browser,
}, testInfo) => {
  // Seed (~4 navs of API), two prints, the console twice, two scans; one screen.
  test.setTimeout(budgetFor({ navs: 4 + 2 + 2 + 2, acts: 35, captures: 1 }));
  const names = [`Oli ${TAG}`, `Pat ${TAG}`, `Quin ${TAG}`, `Rae ${TAG}`];
  const seeded = await seedScoredDivision(page.request, names, { decide: false });
  await expectStarted(page.request, seeded.divisionId);
  const nameOf = await namesOf(page.request, seeded.divisionId);
  const { day, onDay } = dayOf(await fixturesOf(page.request, seeded.divisionId), await orgZone(page.request));
  const pairOf = (f: Fx) => [nameOf.get(f.home_entrant_id!)!, nameOf.get(f.away_entrant_id!)!];
  const schedulePath = await competitionPath(page.request, seeded.competitionId, "/schedule");
  const pdf = await printDay(page, schedulePath, day);
  const cards = await readCards(pdf);
  expect(cards.length, "one card per match on the day").toBe(onDay.length);
  expectEveryQrDecodes(cards, pdf);
  const target = onDay[0]!;
  const others = onDay.slice(1);
  const printed = cardNaming(cards, pairOf(target), "the target's players");

  // ---- 1. The console's hand-over, after printing: the SAME link -----------
  const consolePath = await fixturePath(page.request, target.id);
  const openPanel = async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(consolePath);
    const anchor = page.locator('[data-testid="score-pad"]');
    await expect(anchor).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(anchor);
    await page.locator('[data-role="device-handover"]').click();
    const opened = page.locator('[data-role="device-link-panel"]');
    await expect(opened).toBeVisible({ timeout: STEP_MS });
    return opened;
  };
  let panel = await openPanel();
  await panel.getByTestId("device-link-show").click();
  const url = panel.getByTestId("device-link-url");
  await expect(url).toBeVisible({ timeout: STEP_MS });
  expect((await url.innerText()).trim(), "Show QR re-shows the printed card's link").toBe(printed.decoded);

  const phone = await phoneIn(browser);
  try {
    const stateWith = (card: Card, f: Fx) => asPhone(phone, tokenOf(card.decoded!), `/api/v1/fixtures/${f.id}/state`);
    expect((await stateWith(printed, target)).status, "the printed card's bearer opens its match").toBe(200);

    // ---- 2. Revoke & reissue: the printed card's link dies… -------------------
    // A shown QR offers only Copy and Revoke now; Revoke & reissue sits on the
    // panel as the organiser next opens it.
    panel = await openPanel();
    await panel.getByTestId("device-link-reissue").click();
    await panel.getByTestId("device-link-reissue-confirm").click();
    const newUrl = panel.getByTestId("device-link-url");
    await expect(newUrl, "the reissued QR is shown").toBeVisible({ timeout: STEP_MS });
    const reissued = (await newUrl.innerText()).trim();
    expect(reissued, "…and it is a new link").not.toBe(printed.decoded);
    expect(reissued, "…on this site's scoring door").toMatch(/\/score\/dl_[^/]+$/);
    expect(await stateWith(printed, target), "the printed card's bearer is refused as revoked").toEqual({
      status: 401,
      code: "LINK_REVOKED",
    });
    await phone.goto(new URL(printed.decoded!).pathname);
    const dead = phone.getByTestId("scan-dead-link");
    await expect(dead, "the printed card lands on the dead-link screen").toContainText(say("device.dead.revoked"), {
      timeout: STEP_MS,
    });
    await expect(dead).toContainText(say("device.askFreshLink"));
    await captureScreen(phone, dead, phone.locator("body"), testInfo, "dead-link", []);

    // ---- 3. …and ONLY that card: every other card still opens its match ------
    for (const f of others) {
      expect((await stateWith(cardNaming(cards, pairOf(f), `${f.id}'s players`), f)).status, `${f.id}'s card is alive`).toBe(
        200,
      );
    }
    const neighbour = cardNaming(cards, pairOf(others[0]!), "a neighbour's players");
    await phone.goto(new URL(neighbour.decoded!).pathname);
    await expect(phone.getByTestId("scan-confirm"), "a neighbouring card still scans to Confirm").toBeVisible({
      timeout: STEP_MS,
    });

    // ---- 4. A reprint carries the reissued link there, the same QR elsewhere --
    const again = await readCards(await printDay(page, schedulePath, day));
    expect(cardNaming(again, pairOf(target), "the target's players").decoded, "the reprint carries the new link").toBe(
      reissued,
    );
    for (const f of others) {
      expect(cardNaming(again, pairOf(f), `${f.id}'s players`).decoded, `${f.id} keeps its printed QR`).toBe(
        cardNaming(cards, pairOf(f), `${f.id}'s players`).decoded,
      );
    }
  } finally {
    await phone.context().close();
  }
});

test("regression: a member without edit rights sees the Schedule page but no print control, and the route refuses them; the organiser sees it", async ({
  page,
  browser,
}) => {
  // Seed (~4 navs of API), two schedule loads, a sign-in; ~15 acts.
  test.setTimeout(budgetFor({ navs: 4 + 2 + 2, acts: 15 }));
  const seeded = await seedScoredDivision(page.request, [`Sam ${TAG}`, `Tia ${TAG}`], { decide: false });
  const comp = await apiJson<{ org_id: string; name: string }>(page.request, `/api/v1/competitions/${seeded.competitionId}`);
  expect(comp.status).toBe(200);
  const { org_id: orgId, name } = comp.data!;
  const schedulePath = await competitionPath(page.request, seeded.competitionId, "/schedule");
  const { day } = dayOf(await fixturesOf(page.request, seeded.divisionId), await orgZone(page.request));
  // The marker that THIS page — the Schedule page — rendered, which the
  // competition overview cannot satisfy: its h1 also carries the name, so a
  // "contains the name" marker passed on a redirect to the overview. The
  // schedule's own title, whole, AND the schedule's own path.
  const pathRe = new RegExp(`^[^?#]*${schedulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#].*)?$`);
  const expectOnSchedule = async (p: Page, who: string) => {
    await expect(p, `${who}: still on the Schedule page (no redirect)`).toHaveURL(pathRe, { timeout: STEP_MS });
    await expect(p.locator("main h1.page-title"), `${who}: the Schedule page's own title`).toHaveText(
      say("comp.schedule.title", { name }),
      { timeout: STEP_MS },
    );
  };

  // The positive pair first: the organiser's own page carries the control.
  await page.goto(schedulePath);
  await expectOnSchedule(page, "the organiser");
  await expect(page.getByTestId("print-sheets"), "the organiser has the print control").toHaveCount(1);

  // A viewer of this org, signed in on a context of their own (a bare
  // newContext would inherit the organiser's session).
  const invite = await page.request.post(`/api/orgs/${orgId}/invites`, { data: { role: "viewer", max_uses: 1 } });
  expect(invite.ok(), `invite: ${invite.status()}`).toBe(true);
  const inviteToken = ((await invite.json()) as { data: { token: string } }).data.token;
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  let userId = "";
  try {
    const viewer = await ctx.newPage();
    await loginUi(viewer, `delivered+sheets-viewer-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, "/");
    const accept = await ctx.request.post(`/api/invites/${inviteToken}/accept`);
    expect(accept.ok(), `accept: ${accept.status()}`).toBe(true);
    userId = ((await (await ctx.request.get("/api/users/me")).json()) as { data: { id: string } }).data.id;
    const orgs = await apiJson<{ id: string; role: string }[]>(ctx.request, "/api/orgs");
    expect(orgs.data?.find((o) => o.id === orgId)?.role, "precondition: a viewer of this org").toBe("viewer");

    await viewer.goto(schedulePath);
    // FIRST the marker that the Schedule page rendered FOR THIS VIEWER — a
    // redirect, the overview or an error page fails it — THEN the absence.
    await expectOnSchedule(viewer, "the viewer");
    await expect(viewer.getByTestId("print-sheets"), "…with no print control").toHaveCount(0);
    await expect(viewer.getByTestId("print-sheets-submit")).toHaveCount(0);
    // Hiding is not the guard: the route refuses a viewer by itself.
    const refused = await apiJson(ctx.request, `/api/v1/competitions/${seeded.competitionId}/exports/scorer-sheets`, "POST", {
      date: day,
    });
    expect(refused.status, "the route refuses a viewer").toBe(403);
  } finally {
    if (userId) await page.request.delete(`/api/orgs/${orgId}/members/${userId}`).catch(() => undefined);
    await ctx.close();
  }
});
