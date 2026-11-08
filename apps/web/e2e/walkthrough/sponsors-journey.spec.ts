// R4 sponsors on stream — the sponsor JOURNEY, end to end (spec 2026-10-27; walkthrough README "The rule"): an organiser
// adds a sponsor, puts it on the stream, the stream airs it, a viewer follows its short link, and the sponsor reads a report
// the club shared and later revoked. Every step a PERSON does is tapped through the UI — the add form, the On stream ticks,
// Share report and its revoke, the link a viewer follows — and each is read back off the system's own record (the rows) and
// off what a person sees (the Overview, the public board, the report). Setup (the org, two started fixtures, two more
// sponsors, a viewer) uses SQL and the API.
//
// The ONLY stand-in is the compositor, at its HTTP boundary (helpers/sponsor-relay-standin.ts): a real composed session,
// its real job token, its real overlay page loaded at the facts' URL, the page's own `seazn:sponsor:*` console lines turned
// into heartbeat `airings`, a keep-alive beat at the facts' cadence for the session's life, and every body validated
// against docs/contracts/relay-job.v1.json before it is sent. No airing is ever built by hand: each one is a line the
// page printed.
//
//   J10  the top bar: Sponsors (labelled) reaches the hub; Settings and Sign out are icons with names and tooltips; 1280, 320
//   J1   a sponsor added through the form (name, link, tier) — on the public match page's board
//   J2   On stream: tick one, tick a second, untick it, tick it again — the plan the console preview reads follows each tap
//   J3   the plan the compositor's page reads (the relay door): the ticked sponsors only, each with its short code — and the
//        page draws the card with `seazn.club/s/<code>`
//   J4   the page's own showings beaten in as airings: Times shown moves from 0 to what was posted, viewers read Coming soon,
//        a frame is posted, and the same batch again counts nothing twice
//   J9   a second sport's fixture (hockey, after volleyball): the compositor page airs it there too, and its showings
//        fold into the same sponsors' totals
//   J5   the short link the stream showed, followed by a logged-out visitor: one click; the board's link: one more
//   J6   Share report through the Overview; the link opened logged out shows the airings, the frame, the stream visits and
//        Coming soon, noindex + no-referrer; revoked in the hub, the same URL is a 404, twice
//   J7   the same report in French: its title and description
//   J8   a viewer: no tick, no Share report on screen, and the routes answer 403
//
// NOT DRIVEN, named plainly (the walkthrough report carries the list): the sponsor LOGO upload (content-upload writes to
// Supabase storage, a stub in e2e.yml), the frame's storage on CI (same stub: the frame POST answers 502 there and the
// report shows its placeholder — the test branches on the answer and says which it saw), and the native `title` tooltip's
// paint (a browser tooltip is not in the DOM; its text is asserted).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, withDb } from "../helpers";
import { seedMemberIdentity, sponsorsUrl } from "../settings-support";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { FAKE_CONNECT_MS, POOL_SLOT_WAIT_MS, POLL_WAIT_MS, cycleMs, holdsStreamSlot, releaseStreamSlot, takeWholePool } from "../helpers/stream-slot-pool";
import {
  EMPTY_JAR,
  LOOPBACK_HOLD_MS,
  beatOk,
  composedSession,
  compositorPage,
  disposeStandInPhones,
  endStandInSessions,
  jpegOf,
  planSponsorIds,
  previewPlan,
  relayPlan,
  releaseStandInOrg,
  seedStandInFixture,
  seedStandInOrg,
  startsByCard,
  type CompositorPage,
  type StandInFixture,
  type StandInOrg,
  type StandInSessionRef,
} from "../helpers/sponsor-relay-standin";
import { routes } from "../../src/lib/routes";
import { SCENE_CAROUSEL_MS } from "../../src/lib/sponsor-plan";
import { SPONSOR_SHORT_CODE_PATTERN } from "../../src/lib/sponsor-short-code";

/** Spec §3.4: every carousel showing is a `banner` (§3.2's bigger card; a scene is a full-screen layer). Typed here from
 *  the spec, never read off the page's own constant (`CAROUSEL_STYLE`). */
const SPEC_CAROUSEL_STYLE = "banner";

// --- copy, read from the dictionaries the pages render from ------------------------------------------------------------
const dictionary = (locale: string, book: "ui" | "console"): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/${book}.json`, import.meta.url)), "utf8"));
const EN_UI = dictionary("en", "ui");
const EN_CONSOLE = dictionary("en", "console");
const FR_UI = dictionary("fr", "ui");
const say = (dict: Record<string, string>, key: string, vars: Record<string, string | number> = {}): string => {
  const v = dict[key];
  if (v === undefined) throw new Error(`no dictionary entry ${key}`);
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- the clocks (AGENTS.md #20; walkthrough README "What they cost") ---------------------------------------------------
/** A navigation, and a tap or read, as the walkthrough README budgets them. */
const NAV_MS = 20_000;
const ACT_MS = 5_000;
/** The compositor page's Starting soon window: its first showing (the page's ready plus a loopback round, at most two
 *  holds), three showings (`SCENE_CAROUSEL_MS` each), then Live and the last showing's end (two holds and a poll). */
const PAGE_MS = 2 * LOOPBACK_HOLD_MS + 3 * SCENE_CAROUSEL_MS + 2 * LOOPBACK_HOLD_MS + POLL_WAIT_MS;
/** J9's page on the hockey stream: its ready and a loopback round, up to two showings until A's turn comes, then Live
 *  and the last showing's end (two holds and a poll). */
const J9_PAGE_MS = 2 * LOOPBACK_HOLD_MS + 2 * SCENE_CAROUSEL_MS + 2 * LOOPBACK_HOLD_MS + POLL_WAIT_MS;
/** The longest this file holds the stream pool: one session's create and facts (a cycle), the longer page, two reads,
 *  its end. */
const POOL_HOLD = {
  file: "sponsors-journey.spec.ts",
  holdMs: cycleMs(FAKE_CONNECT_MS) + Math.max(PAGE_MS, J9_PAGE_MS) + 2 * NAV_MS + POLL_WAIT_MS,
} as const;
/** The whole pool, taken before the phone pairs (a composed session reserves two matches of recording, R2004). */
const reserve = async () => {
  if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
};

test.describe.configure({ mode: "serial" });

// --- the journey's people and things ------------------------------------------------------------------------------------
/** The sponsor the organiser adds through the form: a realistic 43-character name (AGENTS.md: what found the last overflow). */
const A = { name: "Harbourside Building Supplies and Timber Co", url: "https://harbourside-timber.example/journey", tier: "gold", id: "" };
/** Added by setup: ticked in J2 like A. */
const B = { name: "Ridge Cycles", url: "https://ridge-cycles.example/", tier: "silver", id: "" };
/** Added by setup and never ticked: the plan must never name it. */
const C = { name: "Quay Fisheries", url: "https://quay-fisheries.example/", tier: "partner", id: "" };

let org: StandInOrg | undefined;
let volley: StandInFixture;
let hockey: StandInFixture;
/** Every composed session, registered by `composedSession` the moment its create answers. */
const sessions: StandInSessionRef[] = [];
/** What was posted, so every expected count below is the test's own: A's and B's showings, and whether the frame stored. */
let shownA = 0;
let shownB = 0;
let codeA = "";
let frameStored = false;
let reportUrl = "";

function owner(): StandInOrg {
  if (org === undefined) throw new Error("sponsors-journey: the beforeAll seed did not complete");
  return org;
}
const overviewRow = (page: Page, id: string) => page.getByTestId(`sponsor-overview-row-${id}`);

/** The Overview's figure for a sponsor, read as a person reads it — after a reload, until it says `want`. */
async function expectOverview(page: Page, id: string, field: "times" | "clicks", want: string, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(sponsorsUrl(owner().orgSlug, "overview"));
        return (await overviewRow(page, id).getByTestId(`sponsor-overview-${field}`).textContent())?.trim();
      },
      { message, timeout: 3 * NAV_MS, intervals: [1_000, 2_000, 4_000] },
    )
    .toBe(want);
}

async function endSessions(): Promise<void> {
  try {
    await disposeStandInPhones();
  } finally {
    try {
      await endStandInSessions(sessions);
    } finally {
      await releaseStreamSlot();
    }
  }
}

/** The page has gone Live and every showing it started has its end line. */
function everyShowingEnded(cef: CompositorPage): boolean {
  const lines = cef.sponsorLines();
  const ends = new Set(lines.filter((l) => l.kind === "end").map((l) => l.json.momentId));
  const starts = lines.filter((l) => l.kind === "start");
  return starts.length > 0 && starts.every((l) => ends.has(l.json.momentId));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 10 * ACT_MS);
  expect(A.name.length, "premise: a 43-character name").toBe(43);
  org = await seedStandInOrg(browser, "spj");
  const o = owner();
  volley = await seedStandInFixture(o, { label: `Harbour Volley ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Harbour Town VC", away: "Kingsway Spikers" });
  hockey = await seedStandInFixture(o, { label: `Harbour Hockey ${o.orgSlug}`, sportKey: "hockey", variantKey: "fih-outdoor", home: "Harbour Town HC", away: "Kingsway Sticks" });
  for (const s of [B, C]) {
    const res = await o.page.request.post(`/api/v1/orgs/${o.orgId}/sponsors`, { data: { name: s.name, url: s.url, tier: s.tier } });
    expect(res.status(), `setup: ${s.name}: ${await res.text()}`).toBe(201);
    s.id = ((await res.json()) as { data: { id: string } }).data.id;
  }
});

test.afterEach(async () => {
  await endSessions();
});

test.afterAll(async () => {
  await releaseStandInOrg(org);
});

test("J10 the top bar: Sponsors is a labelled link to the hub; Settings and Sign out are icons named for a screen reader, with a tooltip — at 1280 and 320", async () => {
  test.setTimeout(4 * NAV_MS + 16 * ACT_MS);
  const { page, orgSlug } = owner();
  const settingsWord = say(EN_CONSOLE, "nav.settings");
  const signOutWord = say(EN_CONSOLE, "nav.signOut");
  const sponsorsWord = say(EN_CONSOLE, "nav.sponsors");
  const bar = page.locator("header.app-gantry");
  const checkIcons = async (width: number) => {
    const settings = bar.getByTestId("nav-settings");
    await expect(settings, `@${width}: Settings is on the bar`).toBeVisible();
    await expect(settings, "named for a screen reader").toHaveAttribute("aria-label", settingsWord);
    await expect(settings, "and the same word as its tooltip").toHaveAttribute("title", settingsWord);
    expect((await settings.innerText()).trim(), "an icon alone: no painted word").toBe("");
    const signOut = bar.getByRole("button", { name: signOutWord, exact: true });
    await expect(signOut, `@${width}: Sign out is on the bar`).toBeVisible();
    await expect(signOut).toHaveAttribute("title", signOutWord);
    expect((await signOut.innerText()).trim(), "an icon alone: no painted word").toBe("");
    // The tooltip is the browser's own (`title`): hovering is what a mouse user does; its paint is not in the DOM.
    await settings.hover();
    await expect(settings).toHaveAttribute("title", settingsWord);
    await expectNoHorizontalScroll(page);
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(routes.orgHome(orgSlug));
  const sponsors = bar.getByTestId("nav-sponsors");
  await expect(sponsors, "1280: Sponsors is a labelled link").toBeVisible();
  expect((await sponsors.innerText()).trim(), "its word is painted").toBe(sponsorsWord);
  await checkIcons(1280);
  await sponsors.click();
  await expect(page.getByTestId("sponsors-tab-overview"), "the link reaches the hub, on Overview").toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${escapeRe(routes.orgSponsors(orgSlug))}(\\?|$)`));

  // 320: the labelled link folds (nav.tsx: `hidden min-[350px]:flex` for an org without a logo); the Competitions home's
  // Sponsors entry is the way in at every width, and the two icons stay.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(routes.orgHome(orgSlug));
  await expect(bar.getByTestId("nav-sponsors"), "320: the labelled link is folded away").toBeHidden();
  await checkIcons(320);
  await page.getByTestId("org-home-sponsors").click();
  await expect(page.getByTestId("sponsors-tab-overview"), "320: the home's entry reaches the hub").toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("J1 a sponsor added through the form — name, link, tier — is stored as typed and shows on the public match page's board", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 12 * ACT_MS);
  const o = owner();
  const { page } = o;
  await page.goto(sponsorsUrl(o.orgSlug, "sponsors"));
  const tab = page.getByTestId("sponsors-tab-sponsors");
  const name = tab.getByLabel(say(EN_UI, "settings.org.sponsors.name"), { exact: true });
  const add = tab.getByRole("button", { name: say(EN_UI, "settings.org.sponsors.add"), exact: true });
  // A controlled input typed into before hydration loses its value (walkthrough README, the officials flake): type until
  // the form has taken it — Add is enabled only once the name is in the component's state.
  await expect(async () => {
    await name.fill(A.name);
    await expect(add).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: NAV_MS });
  await tab.getByLabel(say(EN_UI, "settings.org.sponsors.link"), { exact: true }).fill(A.url);
  await tab.getByLabel(say(EN_UI, "sponsors.tierLabel"), { exact: true }).selectOption(A.tier);
  await expect(name).toHaveValue(A.name);
  await add.click();
  await expect(tab.getByRole("button", { name: say(EN_UI, "settings.org.sponsors.remove", { name: A.name }), exact: true }), "the new row").toBeVisible();

  // The system's record agrees with what was typed: off the stream until ticked (R12), every competition.
  const [row] = await withDb((sql) => sql<{ id: string; tier: string; url: string | null; on_stream: boolean; competition_id: string | null }[]>`
    select id, tier, url, on_stream, competition_id from sponsors where org_id = ${o.orgId} and name = ${A.name}`);
  expect(row, "one sponsor row by that name").toBeDefined();
  expect({ tier: row!.tier, url: row!.url, on_stream: row!.on_stream, competition_id: row!.competition_id }).toEqual({ tier: A.tier, url: A.url, on_stream: false, competition_id: null });
  A.id = row!.id;

  // The public board, as a visitor sees it (first visit after the add: no cached page can predate it).
  const visitor = await browser.newContext({ storageState: EMPTY_JAR });
  try {
    const vp = await visitor.newPage();
    expect((await vp.goto(routes.publicFixture(o.orgSlug, volley.compSlug, volley.divSlug, volley.fixtureId)))?.status()).toBe(200);
    const board = vp.getByTestId("mh-sponsors");
    await expect(board, "the match page draws the board").toBeVisible();
    await expect(board, "with the sponsor just added").toContainText(A.name);
    await expect(board.locator(`a[href^="/s/${A.id}?"]`), "its tracked link (S10)").toHaveCount(1);
  } finally {
    await visitor.close();
  }
});

test("J2 On stream: each tick and untick is what the stream's plan follows — one, two, back to one, two again", async () => {
  test.setTimeout(2 * NAV_MS + 8 * (ACT_MS + POLL_WAIT_MS));
  const o = owner();
  const { page } = o;
  // The console preview's door: the plan the fixture page's stream preview reads (fixture-stream-panel.tsx `preview: true`).
  const planNow = (want: string[], message: string) =>
    expect.poll(async () => planSponsorIds(await previewPlan(page.request, volley.fixtureId)), { message, timeout: POLL_WAIT_MS }).toEqual([...want].sort());

  await page.goto(sponsorsUrl(o.orgSlug, "on_stream"));
  const tick = (id: string) => page.getByTestId(`on-stream-tick-${id}`);
  await expect(page.getByTestId("on-stream-switch"), "a fresh org: the rotation is off").toHaveAttribute("aria-checked", "false");
  await planNow([], "nothing ticked: no plan");

  await tick(A.id).check();
  await expect(tick(A.id)).toBeChecked();
  await expect(page.getByTestId("on-stream-switch"), "the first tick turned the rotation on (R12)").toHaveAttribute("aria-checked", "true");
  await planNow([A.id], "one tick: its card alone");
  await tick(B.id).check();
  await expect(tick(B.id)).toBeChecked();
  await planNow([A.id, B.id], "a second tick: both cards");
  await tick(B.id).uncheck();
  await expect(tick(B.id)).not.toBeChecked();
  await planNow([A.id], "untick: its card is gone");
  await tick(B.id).check();
  await expect(tick(B.id)).toBeChecked();
  await planNow([A.id, B.id], "ticked again: back");

  // The system's record: exactly the two ticks stand, after a reload too.
  const flags = await withDb((sql) => sql<{ id: string; on_stream: boolean }[]>`select id, on_stream from sponsors where org_id = ${o.orgId} order by id`);
  expect(Object.fromEntries(flags.map((f) => [f.id, f.on_stream]))).toEqual({ [A.id]: true, [B.id]: true, [C.id]: false });
  await page.reload();
  await expect(tick(A.id)).toBeChecked();
  await expect(tick(B.id)).toBeChecked();
  await expect(tick(C.id)).not.toBeChecked();
});

test("J3 + J4 the compositor's page reads the ticked sponsors with their short codes, airs them, and its showings — beaten in — are what the Overview counts, once", async ({ browser }) => {
  test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 6 * NAV_MS);
  const o = owner();
  // Before anything aired: Times shown is a real 0 (read before the pool is taken, so the hold stays the stream's).
  await expectOverview(o.page, A.id, "times", "0", "A's Times shown before the stream");
  await expect(overviewRow(o.page, B.id).getByTestId("sponsor-overview-times")).toHaveText("0");
  const s = await composedSession(o, volley, reserve, sessions);

  // J3 — the plan the page reads, off the relay door: the two ticked sponsors, never C, each with its short code (minted
  // on this read for a sponsor with a link), and the system's record of those codes.
  const plan = await relayPlan(s);
  expect(planSponsorIds(plan), "the ticked sponsors, and only them").toEqual([A.id, B.id].sort());
  expect(plan!.cards.every((c) => c.onStream), "every card is a ticked one (no break has assigned an unticked card)").toBe(true);
  const codes = new Map(plan!.cards.map((c) => [c.sponsorId, c.shortCode ?? null]));
  for (const [id, code] of codes) expect(code, `card ${id} carries a short code`).toMatch(SPONSOR_SHORT_CODE_PATTERN);
  const stored = await withDb((sql) => sql<{ sponsor_id: string; code: string }[]>`
    select sponsor_id, code from sponsor_short_codes where org_id = ${o.orgId} and fixture_id = ${volley.fixtureId}`);
  expect(Object.fromEntries(stored.map((r) => [r.sponsor_id, r.code])), "the codes the plan names are the stored ones").toEqual(Object.fromEntries(codes));

  const cef = await compositorPage(browser, s, "waiting");
  try {
    // The page draws A's card on Starting soon, with the short link a viewer types: read off the page that emits it.
    const cardA = cef.page.getByTestId("ovl-sponsor-card").filter({ hasText: A.name });
    await expect(cardA, "Starting soon airs the gold sponsor's card").toBeVisible({ timeout: 2 * LOOPBACK_HOLD_MS + 2 * SCENE_CAROUSEL_MS });
    const linkText = (await cardA.getByTestId("ovl-sponsor-link").innerText()).trim();
    codeA = /\/s\/([^/\s]+)$/.exec(linkText)?.[1] ?? "";
    expect(codeA, `the card's link "${linkText}" is the plan's code`).toBe(codes.get(A.id));

    // Three showings, then Live: the scene leaves and every showing has its end.
    await expect
      .poll(() => cef.sponsorLines().filter((l) => l.kind === "start").length, { message: "three carousel showings", timeout: 3 * SCENE_CAROUSEL_MS + 2 * LOOPBACK_HOLD_MS })
      .toBeGreaterThanOrEqual(3);
    cef.serve("live");
    await expect
      .poll(() => everyShowingEnded(cef), { message: "Live: every showing has ended", timeout: 2 * LOOPBACK_HOLD_MS + POLL_WAIT_MS })
      .toBe(true);
  } finally {
    await cef.context.close();
  }
  const lines = cef.sponsorLines();
  const starts = lines.filter((l) => l.kind === "start");
  for (const l of starts) {
    expect(l.json.source, "a carousel showing").toBe("scene");
    expect(l.json.style, "in the carousel's style (spec §3.4: the banner)").toBe(SPEC_CAROUSEL_STYLE);
    expect([A.id, B.id], "a ticked sponsor's card — never C").toContain(l.json.cardId);
  }
  const byCard = startsByCard(lines);
  shownA = byCard.get(A.id) ?? 0;
  shownB = byCard.get(B.id) ?? 0;
  expect(shownA, "anti-vacuity: A aired").toBeGreaterThan(0);
  expect(shownB, "anti-vacuity: B aired too (the carousel rotates the ticked cards)").toBeGreaterThan(0);
  expect(lines.length, "within one beat's 64 items").toBeLessThanOrEqual(64);

  // J4 — the compositor's beat: the page's lines, as airings (the Overview read 0 at the top of this test).
  const beat = { state: "playing", programmePhase: "live", airings: lines.map((l) => l.airing) };
  await beatOk(s, beat, "the beat carrying the page's showings");
  const rowsOf = () => withDb((sql) => sql<{ sponsor_id: string; moment_id: string; closed: boolean }[]>`
    select sponsor_id, moment_id, ended_at is not null as closed from sponsor_airings where session_id = ${s.sid} order by moment_id`);
  const first = await rowsOf();
  expect(first.length, "one airing per showing posted").toBe(starts.length);
  expect(first.every((r) => r.closed), "each closed by its end line").toBe(true);

  // The frame for A's first showing (S9): the JPEG the compositor grabs, posted with the job token.
  const momentA = String(starts.find((l) => l.json.cardId === A.id)!.json.momentId);
  const frame = await s.request.post(`/api/internal/relay/sessions/${s.sid}/airings/${encodeURIComponent(momentA)}/frame`, {
    headers: { Authorization: `Bearer ${s.jobToken}`, "content-type": "image/jpeg" },
    data: jpegOf(4_096),
  });
  if (frame.status() === 204) {
    frameStored = true;
    const framed = await withDb((sql) => sql`select 1 from sponsor_airing_frames where session_id = ${s.sid} and moment_id = ${momentA}`);
    expect(framed.length, "the frame's row").toBe(1);
  } else {
    // NOT DRIVEN on CI: frame storage is a stub there (e2e.yml NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co).
    expect(frame.status(), `a frame refused for any reason but storage is a defect: ${await frame.text()}`).toBe(502);
    expect(((await frame.json()) as { code?: string }).code).toBe("FRAME_STORAGE_FAILED");
    const note = "frame storage is unavailable here (502 FRAME_STORAGE_FAILED): the frame is not stored, and the report must show its placeholder";
    console.log(`sponsors-journey J4: ${note}`);
    test.info().annotations.push({ type: "not driven", description: note });
  }

  // Idempotency (spec §3.6.4 rule 4): the same batch again — a compositor re-sending after a lost 2xx — writes nothing.
  await beatOk(s, beat, "the same beat again");
  expect(await rowsOf(), "the second batch counted nothing twice").toEqual(first);
  await endSessions();

  // What a person sees: Times shown is what was posted, the never-ticked sponsor aired nothing, viewers are not measured yet.
  await expectOverview(o.page, A.id, "times", String(shownA), "A's Times shown");
  await expect(overviewRow(o.page, B.id).getByTestId("sponsor-overview-times")).toHaveText(String(shownB));
  await expect(overviewRow(o.page, C.id).getByTestId("sponsor-overview-times")).toHaveText("0");
  const viewers = o.page.getByTestId("sponsor-overview").getByTestId("sponsor-overview-viewers");
  await expect(viewers, "one viewers cell per sponsor").toHaveCount(3);
  for (const cell of await viewers.all()) await expect(cell).toHaveText(say(EN_UI, "sponsors.viewers.comingSoon"));
});

test("J9 a second sport's fixture: the compositor page airs the sponsors on the hockey stream too, and its showings fold into the same totals", async ({ browser }) => {
  test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 4 * NAV_MS);
  const o = owner();
  const s = await composedSession(o, hockey, reserve, sessions);
  expect(planSponsorIds(await relayPlan(s)), "the hockey fixture's stream carries the same ticked sponsors").toEqual([A.id, B.id].sort());

  // The hockey stream's own page, until A has aired on it at least once, then Live: every showing it started has ended.
  const cef = await compositorPage(browser, s, "waiting");
  try {
    await expect
      .poll(() => startsByCard(cef.sponsorLines()).get(A.id) ?? 0, {
        message: "the hockey stream's carousel airs A's card",
        timeout: 2 * LOOPBACK_HOLD_MS + 2 * SCENE_CAROUSEL_MS,
      })
      .toBeGreaterThanOrEqual(1);
    cef.serve("live");
    await expect
      .poll(() => everyShowingEnded(cef), { message: "Live: every hockey showing has ended", timeout: 2 * LOOPBACK_HOLD_MS + POLL_WAIT_MS })
      .toBe(true);
  } finally {
    await cef.context.close();
  }
  const lines = cef.sponsorLines();
  const starts = lines.filter((l) => l.kind === "start");
  for (const l of starts) {
    expect(l.json.source, "a carousel showing").toBe("scene");
    expect(l.json.style, "in the carousel's style (spec §3.4: the banner)").toBe(SPEC_CAROUSEL_STYLE);
    expect([A.id, B.id], "a ticked sponsor's card — never C").toContain(l.json.cardId);
  }
  const byCard = startsByCard(lines);
  const hockeyA = byCard.get(A.id) ?? 0;
  const hockeyB = byCard.get(B.id) ?? 0;
  expect(hockeyA, "anti-vacuity: A aired on the hockey stream").toBeGreaterThan(0);
  expect(lines.length, "within one beat's 64 items").toBeLessThanOrEqual(64);

  // The compositor's beat: the hockey page's own lines, as airings.
  await beatOk(s, { state: "playing", programmePhase: "live", airings: lines.map((l) => l.airing) }, "the hockey stream's beat carrying its page's showings");
  const onHockey = await withDb((sql) => sql<{ closed: boolean }[]>`
    select ended_at is not null as closed from sponsor_airings where session_id = ${s.sid}`);
  expect(onHockey.length, "one airing per hockey showing posted").toBe(starts.length);
  expect(onHockey.every((r) => r.closed), "each closed by its end line").toBe(true);
  const rows = await withDb((sql) => sql<{ fixture_id: string }[]>`
    select fixture_id from sponsor_airings where org_id = ${o.orgId} and sponsor_id = ${A.id} order by started_at`);
  expect(new Set(rows.map((r) => r.fixture_id)), "A aired on both sports' fixtures").toEqual(new Set([volley.fixtureId, hockey.fixtureId]));
  await endSessions();

  shownA += hockeyA;
  shownB += hockeyB;
  await expectOverview(o.page, A.id, "times", String(shownA), "A's Times shown, both sports together");
  await expect(overviewRow(o.page, B.id).getByTestId("sponsor-overview-times"), "B's too").toHaveText(String(shownB));
});

test("J5 the short link the stream showed, followed logged out, redirects and counts one click; the board's link counts one more", async ({ browser }) => {
  test.setTimeout(6 * NAV_MS + 10 * ACT_MS);
  const o = owner();
  expect(codeA, "J3 read the code off the stream").toMatch(SPONSOR_SHORT_CODE_PATTERN);
  await expectOverview(o.page, A.id, "clicks", "0", "no click yet");
  // A viewer of their own: no session, their own address (the click dedupe is per IP), the sponsor's site answered here.
  const visitor = await browser.newContext({ storageState: EMPTY_JAR, extraHTTPHeaders: { "fly-client-ip": "198.51.100.41" } });
  try {
    await visitor.route(`${new URL(A.url).origin}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Harbourside</title>" }));
    const vp = await visitor.newPage();
    // What a viewer does with `seazn.club/s/<code>` on screen: types it (here, on this deployment's origin).
    const res = await vp.goto(`/s/${codeA}`);
    expect(vp.url(), "the short link lands on the sponsor's site").toBe(A.url);
    const hop = res!.request().redirectedFrom();
    expect(hop?.url(), "through the /s/ route").toMatch(new RegExp(`/s/${codeA}$`));
    expect((await hop!.response())?.status(), "a redirect").toBe(302);
    await expectOverview(o.page, A.id, "clicks", "1", "one click counted");
    await expect(overviewRow(o.page, B.id).getByTestId("sponsor-overview-clicks")).toHaveText("0");

    // The same visitor on the public match page taps the board's link (a new tab): one more, from another source.
    expect((await vp.goto(routes.publicFixture(o.orgSlug, volley.compSlug, volley.divSlug, volley.fixtureId)))?.status()).toBe(200);
    await dismissCookieBanner(vp);
    const boardLink = vp.getByTestId("mh-sponsors").locator(`a[href^="/s/${A.id}?"]`);
    await expect(boardLink).toBeVisible();
    const [tab] = await Promise.all([visitor.waitForEvent("page"), boardLink.click()]);
    await tab.waitForURL(A.url);
    await expectOverview(o.page, A.id, "clicks", "2", "the board's click counted too");
  } finally {
    await visitor.close();
  }
  const sources = await withDb((sql) => sql<{ source: string; fixture_id: string | null }[]>`
    select source, fixture_id from sponsor_clicks where org_id = ${o.orgId} and sponsor_id = ${A.id} order by source`);
  expect(sources, "the record: one stream click, one match-board click, both on the volleyball fixture").toEqual([
    { source: "match", fixture_id: volley.fixtureId },
    { source: "stream", fixture_id: volley.fixtureId },
  ]);
});

test("J6 + J7 Share report: the link opened logged out shows the airings, the frame, the stream visits and Coming soon, in French too; revoked in the hub, it is a 404, twice", async ({ browser }) => {
  test.setTimeout(10 * NAV_MS + 16 * ACT_MS);
  const o = owner();
  const { page } = o;
  expect(shownA, "J4 and J9 posted A's showings").toBeGreaterThan(1);
  await page.goto(sponsorsUrl(o.orgSlug, "overview"));
  const row = overviewRow(page, A.id);
  await row.getByTestId("sponsor-overview-share").click();
  const panel = row.getByTestId("sponsor-share");
  await expect(panel).toBeVisible();
  await panel.getByTestId("sponsor-share-create").click();
  const shown = panel.getByTestId("sponsor-share-url");
  await expect(shown, "the link, shown once").toHaveValue(/\/r\/sponsor\/[A-Za-z0-9_-]{43}$/);
  reportUrl = await shown.inputValue();
  const token = new URL(reportUrl).pathname.split("/").pop()!;
  expect(token, "premise: the url shown carries its token (43 characters)").toHaveLength(43);
  await panel.getByTestId("sponsor-share-done").click();
  await expect(panel.getByTestId("sponsor-share-url"), "shown once: Done takes the url away").toHaveCount(0);
  const [link] = await withDb((sql) => sql<{ id: string }[]>`select id from sponsor_report_links where org_id = ${o.orgId} and sponsor_id = ${A.id} and revoked_at is null`);
  expect(link, "the link's row").toBeDefined();
  const listedRow = panel.getByTestId(`sponsor-share-link-${link!.id}`);
  await expect(listedRow, "listed").toBeVisible();
  expect(await listedRow.innerHTML(), "listed WITHOUT its token").not.toContain(token);
  expect(await page.content(), "and nowhere on the page once Done is tapped (only its hash is stored)").not.toContain(token);

  const reader = await browser.newContext({ storageState: EMPTY_JAR });
  const french = await browser.newContext({ storageState: EMPTY_JAR });
  try {
    // J6 — the sponsor opens what the club sent: the panel's own url, no session.
    const rp = await reader.newPage();
    expect((await rp.goto(reportUrl))?.status(), "the shared url opens").toBe(200);
    await expect(rp.getByTestId("sponsor-report")).toBeVisible();
    await expect(rp.getByRole("heading", { level: 1 })).toContainText(A.name);
    await expect(rp.getByTestId("report-showing"), "every showing posted, both sports").toHaveCount(shownA);
    const rule = new Intl.PluralRules("en").select(shownA);
    await expect(rp.getByText(say(EN_UI, `sponsorReport.stat.onScreen.${rule}`, { count: shownA }), { exact: true }), "the count beside the time on screen").toBeVisible();
    await expect(rp.getByTestId("report-stream-visits"), "visits from the STREAM: the short link, not the board's").toHaveText("1");
    await expect(rp.getByTestId("report-viewers").getByTestId("viewers-coming-soon")).toHaveText(say(EN_UI, "sponsors.viewers.comingSoon"));
    const pictures = rp.getByTestId("report-showing").locator("img");
    const placeholders = rp.getByTestId("report-frame-missing");
    if (frameStored) {
      await expect(pictures, "the posted frame, on its showing").toHaveCount(1);
      await expect(placeholders).toHaveCount(shownA - 1);
    } else {
      await expect(placeholders, "no stored frame (see J4's note): every showing's placeholder").toHaveCount(shownA);
      await expect(placeholders.first()).toHaveText(say(EN_UI, "sponsorReport.frame.missing"));
    }
    await expect(rp.locator('meta[name="robots"]').first(), "never indexed").toHaveAttribute("content", /noindex/);
    await expect(rp.locator('meta[name="referrer"]').first(), "the token never leaves in a Referer").toHaveAttribute("content", "no-referrer");

    // J7 — the same link in French (the locale cookie a switcher writes).
    await french.addCookies([{ name: "seazn_locale", value: "fr", url: new URL(reportUrl).origin }]);
    const fp = await french.newPage();
    expect((await fp.goto(reportUrl))?.status()).toBe(200);
    await expect(fp, "the French title").toHaveTitle(new RegExp(escapeRe(say(FR_UI, "sponsorReport.meta.title"))));
    await expect(fp, "not the English one").not.toHaveTitle(new RegExp(escapeRe(say(EN_UI, "sponsorReport.meta.title"))));
    await expect(fp.locator('meta[name="description"]').first(), "the French description").toHaveAttribute("content", say(FR_UI, "sponsorReport.meta.description"));

    // Revoke, through the panel: asked first, then gone — and the same url is a 404, twice (nothing cached it).
    await page.goto(sponsorsUrl(o.orgSlug, "overview"));
    await overviewRow(page, A.id).getByTestId("sponsor-overview-share").click();
    const listed = page.getByTestId(`sponsor-share-link-${link!.id}`);
    await listed.getByTestId(`sponsor-share-revoke-${link!.id}`).click();
    await listed.getByTestId(`sponsor-share-revoke-yes-${link!.id}`).click();
    await expect(page.getByTestId(`sponsor-share-link-${link!.id}`), "the revoked link leaves the list").toHaveCount(0);
    await expect.poll(async () => (await withDb((sql) => sql<{ revoked: boolean }[]>`select revoked_at is not null as revoked from sponsor_report_links where id = ${link!.id}`))[0]?.revoked).toBe(true);
    for (const attempt of [1, 2]) {
      expect((await rp.goto(reportUrl))?.status(), `revoked, load ${attempt}`).toBe(404);
      await expect(rp.getByTestId("sponsor-report-not-found")).toBeVisible();
    }
  } finally {
    await reader.close();
    await french.close();
  }
});

test("J8 a viewer: no tick and no Share report on screen, and the routes refuse both with 403 — the plan unchanged", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 10 * ACT_MS);
  const o = owner();
  const member = await seedMemberIdentity(browser, o.page.request, o.orgId, "viewer");
  try {
    const vp = await member.ctx.newPage();
    await vp.goto(sponsorsUrl(o.orgSlug, "overview"));
    await expect(overviewRow(vp, A.id), "a viewer reads the Overview").toBeVisible();
    await expect(vp.getByTestId("sponsor-overview-share"), "no Share report").toHaveCount(0);
    await expect(vp.getByTestId("sponsors-tab-link-on_stream"), "no On stream tab").toHaveCount(0);
    await vp.goto(sponsorsUrl(o.orgSlug, "on_stream"));
    await expect(vp.getByTestId("on-stream-tab"), "the On stream url falls back: nothing to tick").toHaveCount(0);
    await expect(vp.getByTestId("sponsors-tab-overview")).toBeVisible();

    const tickC = await member.request.patch(`/api/v1/orgs/${o.orgId}/sponsors/${C.id}`, { data: { on_stream: true } });
    expect(tickC.status(), "a viewer cannot tick").toBe(403);
    const share = await member.request.post(`/api/v1/orgs/${o.orgId}/sponsors/${A.id}/report-links`, { data: { competitionId: null, from: "2026-01-01", to: "2026-12-31" } });
    expect(share.status(), "a viewer cannot share a report").toBe(403);
    const [{ on_stream }] = await withDb((sql) => sql<{ on_stream: boolean }[]>`select on_stream from sponsors where id = ${C.id}`);
    expect(on_stream, "C is still off the stream").toBe(false);
    const live = await withDb((sql) => sql`select 1 from sponsor_report_links where org_id = ${o.orgId} and revoked_at is null`);
    expect(live.length, "no link was made").toBe(0);
    expect(planSponsorIds(await previewPlan(o.page.request, volley.fixtureId)), "the plan is the organiser's").toEqual([A.id, B.id].sort());
  } finally {
    await member.release();
  }
});

