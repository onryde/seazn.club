// S2-5 rulings 107 and 108 — ONE football clock across every screen scoring
// the match, in match time.
//
// Read `README.md` in this folder first.
//
// WHAT THIS DRIVES. Two screens on one football match: the organiser console
// (context A, signed in) and a handed device on the fixture's device link
// (context B, `/score/<dl_>`, no cookie). Before ruling 107 each web pad kept
// its own clock: started paused, seeded once from the fold, and then ignored
// every later stamp (`reseatClock`, clock.ts property 3), so a Start on the
// console never moved the device. Now a football clock follows the ledger's
// newest standing `football.clock` event from ANY screen (clock.ts property
// 7), read in server time through the transport's measured offset, and the
// readout shows match time (`skins/football-match-time.ts`).
//
// Every test seeds its own fixture and mints its own link, so they run in
// parallel. Run the WHOLE file, never a `-g` slice (web AGENTS.md class 21):
// the parallel workers are part of what is being exercised.
//
// THE NUMBERS. Every reading is parsed off `[data-role="v3-clock-value"]` as a
// person reads it ("12:41", "45+2:00"), into seconds from kick-off, and two
// readings are taken together. Each screen floors to the whole second, so two
// clocks less than a second apart read 0 or 1 s apart, and 2 s apart only when
// the true gap is a second or more. The mid-match test (review I1) holds the
// two screens to 1 s, the design's "within a second" (§7.2): the late device
// must re-read the console's anchor through the live server offset, and a
// re-read that missed by a second would show. The follow tests hold them to
// 2 s: their claim is that the other screen follows and runs the same clock,
// and a second's slack there keeps a slow CI worker from reading as a defect.
//
// THE WAITS. After each action on one screen, the test first waits for its
// `football.clock` row in the ledger (an API read, `clockRowLanded`), and only
// then starts the other screen's FOLLOW_MS. A write that is slow to land and a
// read that is slow to arrive are then two different failures, and the follow
// is measured from the write. On a failure the device's `/events` traffic
// (requests, answers, failures, with times) is attached to the report, so a
// recurrence names which of the two it was.
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, seedRosteredFixture, TAG, type RosteredFixture } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { ledger, openLiveConsole, pad, postEvent } from "../scorepad-v3-football-kit";
import { padPollMs } from "../realtime-propagation-kit";

test.describe.configure({ mode: "parallel" });

/** How long a clock event may take to reach the OTHER screen. NOT a realtime
 *  budget: CI's e2e job runs against a stub Supabase (e2e.yml, "this job runs
 *  on the poll"), and so does a local label, so the other pad learns of the
 *  event on its own poll tick. Two poll intervals plus slack, re-derived from
 *  `use-fixture-stream.ts` the way console-device-live-sync.spec.ts derives its
 *  CONVERGE_MS, so a write landing just after a tick still converges. How FAST
 *  a write propagates is that spec's claim; this file's is that the other
 *  screen FOLLOWS, and reads the same clock when it does. */
const FOLLOW_MS = 2 * padPollMs() + 5_000;
/** Seed (persons, competition, division, lineups, generate), Start match, mint,
 *  and boot two pads, before anything is measured. */
const RIG_MS = 90_000;
const BUDGET_MS = RIG_MS + 6 * FOLLOW_MS + 30_000;

/** How long the acting screen's clock write may take to reach the ledger. */
const LAND_MS = 20_000;

/** The device's `/events` traffic for the test now running: one line per
 *  request, answer and failure, with the time. Attached on a failure. */
let deviceReads: string[] = [];

test.beforeEach(() => {
  deviceReads = [];
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach("device-events-traffic", {
    body: deviceReads.length > 0 ? deviceReads.join("\n") : "(the device made no /events request)",
    contentType: "text/plain",
  });
});

/** Record the device's ledger reads, so a follow that never comes can be told
 *  apart: no read, a failed read, a read still hanging, or a read without the row. */
function recordEventsTraffic(device: Page): void {
  const isEvents = (url: string) => new URL(url).pathname.endsWith("/events");
  const stamp = () => new Date().toISOString();
  device.on("request", (r) => {
    if (isEvents(r.url())) deviceReads.push(`${stamp()} request  ${r.method()} ${r.url()}`);
  });
  device.on("response", (r) => {
    if (isEvents(r.url())) deviceReads.push(`${stamp()} response ${r.status()} ${r.url()} date=${r.headers()["date"] ?? "-"}`);
  });
  device.on("requestfailed", (r) => {
    if (isEvents(r.url())) deviceReads.push(`${stamp()} failed   ${r.url()} ${r.failure()?.errorText ?? ""}`);
  });
}

type ClockRow = { seq: number; payload: Record<string, unknown> };

/** The ledger's newest seq, before an action, so `clockRowLanded` waits for a
 *  row the action wrote and not one already there. */
async function topSeq(request: APIRequestContext, fixtureId: string): Promise<number> {
  return Math.max(0, ...(await ledger(request, fixtureId)).map((e) => e.seq));
}

/** Wait until a `football.clock` row newer than `afterSeq` (and matching
 *  `matches`, when given) is in the ledger: the acting screen's write landed. */
async function clockRowLanded(
  request: APIRequestContext,
  fixtureId: string,
  afterSeq: number,
  what: string,
  matches: (row: ClockRow) => boolean = () => true,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await ledger(request, fixtureId)).filter((e) => e.type === "football.clock" && e.seq > afterSeq && matches(e))
          .length,
      { timeout: LAND_MS, message: `${what} must reach the ledger` },
    )
    .toBeGreaterThan(0);
}

/** The handed device's pad. `/score/[token]` renders no `score-pad` wrapper,
 *  so the chassis root is the scope (console-device-live-sync.spec.ts). */
const devicePad = (page: Page) => page.locator('[data-role="pad-v3"]');

type Screen = ReturnType<typeof pad> | ReturnType<typeof devicePad>;

const clockValue = (scope: Screen) => scope.locator('[data-role="v3-clock-value"]');
const clockToggle = (scope: Screen) => scope.locator('[data-role="v3-clock-toggle"]');

/**
 * A reading as seconds from kick-off: `M:SS`, or `<end minute>+M:SS` in added
 * time (ruling 109). Anything else is NaN, which no comparison below accepts.
 */
function secondsOf(text: string): number {
  const added = /^(\d+)\+(\d+):(\d{2})$/.exec(text);
  if (added) return Number(added[1]) * 60 + Number(added[2]) * 60 + Number(added[3]);
  const plain = /^(\d+):(\d{2})$/.exec(text);
  if (plain) return Number(plain[1]) * 60 + Number(plain[2]);
  return Number.NaN;
}

/** Never throws: a readout briefly absent across a re-render reads "". */
async function readingOf(scope: Screen): Promise<string> {
  return (await clockValue(scope).innerText().catch(() => "")).trim();
}

/** Both screens, read together, as seconds. */
async function gap(a: Screen, b: Screen): Promise<number> {
  const [left, right] = await Promise.all([readingOf(a), readingOf(b)]);
  return Math.abs(secondsOf(left) - secondsOf(right));
}

interface Rig {
  fx: RosteredFixture;
  console: ReturnType<typeof pad>;
  device: Page;
  deviceCtx: BrowserContext;
}

/**
 * A live football match open on the console (A) and on its device link (B).
 * `skewMs` sets B's own clock that far from true: `page.clock` moves `Date`
 * in B's page only, never the server's `Date` header, which is the point.
 * `beforeDevice` runs on the console after it mounts and before B opens, so a
 * test can have the match's clock already running when B first loads.
 */
async function rig(
  page: Page,
  browser: Browser,
  label: string,
  skewMs = 0,
  beforeDevice?: (fx: RosteredFixture) => Promise<void>,
): Promise<Rig> {
  const fx = await seedRosteredFixture(page.request, {
    label: `Shared Clock ${label} ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `SC ${label} Home FW ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `SC ${label} Away GK ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);
  await expect(clockValue(pad(page)), "the console's football clock bar must mount").toBeVisible({ timeout: 20_000 });

  const minted = await apiJson<{ secret: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
    label: `Shared Clock ${label} ${TAG}`,
  });
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  if (beforeDevice) await beforeDevice(fx);

  // No cookie (a bare context inherits the organiser's), and a seeded consent
  // choice so the banner cannot sit over the clock bar.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  const device = await deviceCtx.newPage();
  recordEventsTraffic(device);
  if (skewMs !== 0) {
    await device.clock.install({ time: Date.now() + skewMs });
    await device.clock.resume();
  }
  await device.goto(`/score/${minted.data!.secret}`);
  await expect(devicePad(device), "the v3 pad must render on the device link").toBeVisible({ timeout: 25_000 });
  await expect(clockValue(devicePad(device)), "the device's football clock bar must mount").toBeVisible({
    timeout: 20_000,
  });
  return { fx, console: pad(page), device, deviceCtx };
}

/** Tap the clock toggle on one screen, from `was` to its other word, wait for
 *  the write to land in the ledger, then wait until the other screen follows. */
async function toggleOn(page: Page, fx: RosteredFixture, from: Screen, other: Screen, was: "Start" | "Pause"): Promise<void> {
  const now = was === "Start" ? "Pause" : "Start";
  await expect(clockToggle(from)).toHaveText(was);
  const afterSeq = await topSeq(page.request, fx.fixtureId);
  await clockToggle(from).click();
  await expect(clockToggle(from)).toHaveText(now);
  await clockRowLanded(page.request, fx.fixtureId, afterSeq, `the ${was}`, (r) => r.payload.running === (was === "Start"));
  await expect(clockToggle(other), `the other screen must follow the ${was}`).toHaveText(now, { timeout: FOLLOW_MS });
}

/** Start on one screen, and wait until the other one is running too. */
async function startOn(page: Page, fx: RosteredFixture, from: Screen, other: Screen): Promise<void> {
  await toggleOn(page, fx, from, other, "Start");
}

test("S2-5 107: Start on the console runs the device pad's clock", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Start");
  try {
    const b = devicePad(device);
    await startOn(page, fx, a, b);
    await expect
      .poll(() => gap(a, b), { timeout: FOLLOW_MS, message: "the two screens read one clock, within 2 s" })
      .toBeLessThanOrEqual(2);
    // And the device's clock TICKS from the console's Start — it is running,
    // not a still copy of the console's first reading.
    const before = secondsOf(await readingOf(b));
    await expect.poll(async () => secondsOf(await readingOf(b)), { timeout: 5_000 }).toBeGreaterThanOrEqual(before + 2);
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 107: Pause on the device pad stops the console", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Pause");
  try {
    const b = devicePad(device);
    await startOn(page, fx, a, b);
    await page.waitForTimeout(2_000); // let it run, so a stopped clock and a fresh one differ
    // The console must offer Start once the device pauses.
    await toggleOn(page, fx, b, a, "Pause");
    const first = await readingOf(a);
    await page.waitForTimeout(1_500);
    const second = await readingOf(a);
    expect(secondsOf(first), `the console's paused reading "${first}"`).toBeGreaterThanOrEqual(2);
    expect(second, "the console's clock stopped").toBe(first);
    // Both screens hold the device's Pause, to the second.
    await expect.poll(() => readingOf(b), { timeout: FOLLOW_MS }).toBe(first);
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 107: a Correct on one moves the other", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Correct");
  try {
    const b = devicePad(device);
    const before = secondsOf(await readingOf(b));
    expect(before, "the device starts from a reading").toBe(0);
    const afterSeq = await topSeq(page.request, fx.fixtureId);
    await clockValue(a).click();
    await a.locator('[data-role="v3-clock-plus"]').click();
    await clockRowLanded(page.request, fx.fixtureId, afterSeq, "the console's +1 min", (r) => {
      const at = r.payload.at as { elapsed?: unknown } | undefined;
      return typeof at?.elapsed === "number" && at.elapsed >= 60;
    });
    await expect
      .poll(async () => secondsOf(await readingOf(b)), {
        timeout: FOLLOW_MS,
        message: "the console's +1 min must move the device's clock",
      })
      .toBeGreaterThanOrEqual(before + 55);
    // The correction row stays open on the console across its own followed anchor.
    await expect(a.locator('[data-role="v3-clock-adjust"]')).toBeVisible();
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 108: the second half starts at 45:00 on both", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Second half");
  try {
    const b = devicePad(device);
    await startOn(page, fx, a, b);
    // Half-time, through the console's own period sheet.
    await a.locator('[data-tile-id="period"]').click();
    const sheet = a.locator('[data-role="v3-sheet"]');
    await expect(sheet, "the period tile opens Which break?").toBeVisible({ timeout: 10_000 });
    await sheet.locator('[data-choice-option-id="HT"]').click();
    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.period").length, {
        timeout: 20_000,
      })
      .toBe(1);
    // A new period seats paused at its own start, which in match time is 45:00.
    await expect(clockValue(a)).toHaveText("45:00", { timeout: FOLLOW_MS });
    await expect(clockValue(b)).toHaveText("45:00", { timeout: FOLLOW_MS });
    // The console reads 45:0x the moment its own Start lands. The device
    // learns of it on its poll (FOLLOW_MS), by which time the half may be
    // half a minute old, so it is held to the SAME clock, in match time
    // (45:SS, never the period's own 0:SS), rather than to a fixed second.
    const afterSeq = await topSeq(page.request, fx.fixtureId);
    await clockToggle(a).click();
    await expect(clockValue(a)).toHaveText(/^45:0\d$/);
    await clockRowLanded(page.request, fx.fixtureId, afterSeq, "the second half's Start", (r) => r.payload.running === true);
    await expect(clockToggle(b), "the device's second half must start too").toHaveText("Pause", { timeout: FOLLOW_MS });
    await expect(clockValue(b)).toHaveText(/^45:\d{2}$/);
    await expect
      .poll(() => gap(a, b), { timeout: FOLLOW_MS, message: "both screens read one second-half clock, within 2 s" })
      .toBeLessThanOrEqual(2);
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 108: added time reads 45+2:00", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS + 30_000);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Added time");
  try {
    const b = devicePad(device);
    // Two minutes past the nominal 45, paused (controller ruling W-9: 2820 s
    // reads 45+2:00 on the clock face, ruling 109).
    await postEvent(page.request, fx.fixtureId, "football.clock", {
      running: false,
      at: { period: "H1", elapsed: 2820 },
    });
    await expect(clockValue(a)).toHaveText("45+2:00", { timeout: FOLLOW_MS });
    await expect(clockValue(b)).toHaveText("45+2:00", { timeout: FOLLOW_MS });
    for (const [who, screen] of [
      ["console", page],
      ["device", device],
    ] as const) {
      for (const width of [320, 768, 1280]) {
        await screen.setViewportSize({ width, height: 1000 });
        await expect(clockValue(who === "console" ? a : b)).toHaveText("45+2:00");
        await expectNoHorizontalScroll(screen);
        await screen.screenshot({ path: `e2e-artifacts/football-shared-clock/added-time-${who}-${width}.png`, fullPage: true });
      }
    }
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 107: a device clock five minutes fast still shows the shared time", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const { fx, console: a, device, deviceCtx } = await rig(page, browser, "Skew", 300_000);
  try {
    const b = devicePad(device);
    // The device's own clock really is five minutes ahead of the console's.
    const skew = (await device.evaluate(() => Date.now())) - Date.now();
    expect(skew, "page.clock moved the device's Date").toBeGreaterThan(290_000);
    await startOn(page, fx, a, b);
    await page.waitForTimeout(2_000);
    await toggleOn(page, fx, b, a, "Pause");
    // The console's Start is a FOREIGN anchor on the device, recorded in
    // server time: read with no offset it would be five minutes ahead.
    await startOn(page, fx, a, b);
    await expect
      .poll(() => gap(a, b), { timeout: FOLLOW_MS, message: "the fast device reads the shared time, within 2 s" })
      .toBeLessThanOrEqual(2);
  } finally {
    await deviceCtx.close();
  }
});

test("S2-5 107: a pad opened mid-match on a fast device reads the console's match time (review I1)", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);
  // The console's Start is in the ledger BEFORE the device loads, so the
  // device mounts with a running foreign anchor in its server-rendered events
  // and no server offset yet: the case a pad opened mid-match is. Read with
  // no offset it would sit five minutes ahead until the next clock event;
  // read through the LIVE offset it must match the console once the first
  // /events answer has been sampled.
  const { console: a, device, deviceCtx } = await rig(page, browser, "Late", 300_000, async (fx) => {
    const consolePad = pad(page);
    const afterSeq = await topSeq(page.request, fx.fixtureId);
    await clockToggle(consolePad).click();
    await expect(clockToggle(consolePad)).toHaveText("Pause");
    await clockRowLanded(page.request, fx.fixtureId, afterSeq, "the console's Start, before the device opens");
  });
  try {
    const b = devicePad(device);
    const skew = (await device.evaluate(() => Date.now())) - Date.now();
    expect(skew, "page.clock moved the device's Date").toBeGreaterThan(290_000);
    // Running on arrival: the anchor came with the page, not from a later event.
    await expect(clockToggle(b), "the device mounts with the console's clock running").toHaveText("Pause");
    await expect
      .poll(() => gap(a, b), { timeout: FOLLOW_MS, message: "the late fast device reads the console's time, within 1 s" })
      .toBeLessThanOrEqual(1);
    // ...and it is the shared time, not a coincidence of the first read.
    await page.waitForTimeout(3_000);
    await expect
      .poll(() => gap(a, b), { timeout: 5_000, message: "still within 1 s three seconds later" })
      .toBeLessThanOrEqual(1);
  } finally {
    await deviceCtx.close();
  }
});
