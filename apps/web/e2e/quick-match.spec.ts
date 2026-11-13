import { test as base, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectNoHorizontalScroll, loginUi, TAG, withDb } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import {
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
} from "../src/lib/quick-match-constants";

// Quick match plan 2 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5): the guest's surfaces in a real
// browser, at 1280 (the `parallel` project). Task 4 writes the setup screen's cases; Task 10 extends this file with the
// league flow (setup → home → Score → a rally → back) and the URL forms, and adds the seven-width case to mobile.spec.ts.
// Plan 5 (League + Knockout, docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md Task 8; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §3, §12): the setup screen's Format is a stacked list
// of three whole choices, League | League → Final | League → Semi-finals → Final, posted as ONE radio, `shape`. Two sides
// offer League only; three offer League → Final with Semi-finals shown disabled and its reason; four or more offer all three.
// A crafted plain knockout, a final of two sides and semi-finals of three are refused (the cases after "a refused create").
//
// What the island's unit tests cannot see, and these do: the real form post and its 303 followed by the browser's own
// fetch (the visitor cookie set on a redirect, `res.url`), hydration (the suggested name dated in the BROWSER's zone),
// the real chips/radios under a click, and the page's width.
//
// A guest: no session, in a context of its own (a fixture rather than `test.use({ storageState })`, own-account.ts says
// why). It has already answered the cookie banner, so the banner never sits over the docked Start bar
// (scorepad-a11y-kit.ts, `consentedAnonymousState`).
//
// Sport: badminton, clicked explicitly (A11): the spec's own example, with two kinds. The full offer is swept in
// play-page.test.tsx against the real catalog.

/** A guest's own browser: no session; consent already answered unless the case needs the banner. */
async function guestContext(browser: Browser, info: TestInfo, options: BrowserContextOptions = {}) {
  return browser.newContext({
    storageState: await consentedAnonymousState(),
    baseURL: info.project.use.baseURL,
    ...options,
  });
}

// Playwright's `use` callback is named `provide`: react-hooks lints any call named `use` (own-account.ts).
const test = base.extend<{ guest: Page }>({
  guest: async ({ browser }, provide, info) => {
    const ctx = await guestContext(browser, info);
    try {
      await provide(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  },
});

const form = (page: Page) => page.getByTestId("qm-setup-form");
const side = (page: Page, n: number) => form(page).getByLabel(`Side ${n}`, { exact: true });
const start = (page: Page) => page.getByTestId("qm-start");
/** A chip or a segment, by its words, inside the form (the footer may name a sport too). */
const choice = (page: Page, words: string) => form(page).getByText(words, { exact: true });

async function openSetup(page: Page) {
  await page.goto("/en/play");
  await expect(form(page)).toBeVisible();
  // The hydration signal: the server's Start is live (the no-script path); once the script runs, blank rows disable it.
  // Typing before then would race React taking over the inputs.
  await expect(start(page)).toBeDisabled();
  await choice(page, "Badminton").click();
}

// ── The Format list (plan 5 D1, spec §3, §12) ───────────────────────────────────────────────────────────────────────
//
// Every expected row, hint, reason and count comes from the spec's own rules and the en dictionary, never from the page's
// helpers (lib/quick-match-shape.ts is the code under test): League always; a knockout from QUICK_MATCH_KNOCKOUT_MIN_SIDES
// (two sides would replay the league as its final); Semi-finals from QUICK_MATCH_SEMIS_MIN_SIDES, shown disabled with its
// reason below that. League → Final sends the top 2, Semi-finals the top 4 (spec §12; QUICK_MATCH_QUALIFIERS holds both).

type Shape = "league" | "final" | "semis";
/** How many go through for each knockout row (spec §12: "League → Final (top 2) | League → Semi-finals → Final (top 4)"). */
const THROUGH = { final: 2, semis: 4 } as const;
/** The radio's name as assistive tech reads it (plan 5 T1 review C5): the title's words in order, each "→" read as a comma
 *  ("League, Semi-finals, Final"), never as "right arrow". */
const spokenShape = (shape: Shape) =>
  mk(`quickMatch.setup.shape.${shape}`)
    .split("→")
    .map((w) => w.trim())
    .filter((w) => w !== "")
    .join(", ");
/** The whole row a thumb taps: the radio's label. */
const shapeRow = (page: Page, shape: Shape) => form(page).locator(`label:has(input[name="shape"][value="${shape}"])`);
const shapeRadio = (page: Page, shape: Shape) => form(page).getByRole("radio", { name: spokenShape(shape), exact: true });
/** The rulebook's match count (spec §12, mockup qmd13a01 §6): the league's round robin, n(n-1)/2 a pass and `plays` passes,
 *  then for a knockout a single bracket of the sides going through, which plays one fewer than it seats (no 3rd-place match). */
const matchesOf = (sides: number, plays: number, shape: Shape) =>
  ((sides * (sides - 1)) / 2) * plays + (shape === "league" ? 0 : THROUGH[shape] - 1);

/** The Format list the spec offers at `sides`, with `checked` the choice that posts and counts: the rows in order (League,
 *  Final, Semi-finals), each radio by its spoken name, enabled or not, its hint, and a disabled row's reason under it. Returns
 *  how many rows it checked (anti-vacuity: never zero). */
async function expectFormatList(page: Page, sides: number, checked: Shape, why: string): Promise<number> {
  const rows: { shape: Shape; enabled: boolean }[] =
    sides < QUICK_MATCH_KNOCKOUT_MIN_SIDES
      ? [{ shape: "league", enabled: true }]
      : [
          { shape: "league", enabled: true },
          { shape: "final", enabled: true },
          { shape: "semis", enabled: sides >= QUICK_MATCH_SEMIS_MIN_SIDES },
        ];
  const radios = form(page).locator('input[type="radio"][name="shape"]');
  await expect(radios, `${why}: the Format rows`).toHaveCount(rows.length);
  expect(await radios.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), `${why}: in the list's order`).toEqual(
    rows.map((r) => r.shape),
  );
  const reason = mk("quickMatch.setup.shape.semisNeeds", { min: QUICK_MATCH_SEMIS_MIN_SIDES });
  let seen = 0;
  for (const { shape, enabled } of rows) {
    const radio = shapeRadio(page, shape);
    await expect(radio, `${why}: ${shape} is named by its words`).toHaveCount(1);
    if (enabled) await expect(radio, `${why}: ${shape} can be picked`).toBeEnabled();
    else await expect(radio, `${why}: ${shape} is shown but cannot be picked`).toBeDisabled();
    if (shape === checked) await expect(radio, `${why}: ${shape} is the choice`).toBeChecked();
    else await expect(radio, `${why}: ${shape} is not the choice`).not.toBeChecked();
    const hint = shape === "league" ? mk("quickMatch.setup.shape.leagueHint") : mk(`quickMatch.setup.shape.${shape}Hint`, { count: THROUGH[shape] });
    await expect(shapeRow(page, shape), `${why}: ${shape}'s hint`).toContainText(hint);
    if (enabled) await expect(shapeRow(page, shape).getByText(reason, { exact: true }), `${why}: ${shape} has no reason`).toHaveCount(0);
    else await expect(shapeRow(page, shape).getByText(reason, { exact: true }), `${why}: ${shape}'s reason`).toBeVisible();
    seen += 1;
  }
  expect(seen, `${why}: rows checked`).toBe(rows.length);
  return seen;
}

/** A Format row as a thumb meets it: 44px tall, and a tap at its centre lands on the row (`boundingBox()` measures paint, so
 *  the hit is read with `elementFromPoint`, scrolled to the screen's middle first, clear of the docked Start bar). */
async function expectRowTappable(row: ReturnType<Page["locator"]>, what: string) {
  const seen = await row.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { height: r.height, hit: top !== null && (top === el || el.contains(top)) };
  });
  expect(seen.height, `${what}: 44px or more`).toBeGreaterThanOrEqual(44);
  expect(seen.hit, `${what}: the tap lands on it`).toBe(true);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("setup (C16, C17; plan 5): two sides offer League alone, chosen; Start waits for both names and counts one match; no sideways scroll", async ({ guest: page }) => {
  await openSetup(page);
  await expect(side(page, 1)).toBeVisible();
  await expect(side(page, 2)).toBeVisible();
  await expect(side(page, 3)).toHaveCount(0);
  expect(await expectFormatList(page, 2, "league", "two sides")).toBe(1);
  await expect(page.getByTestId("qm-draw"), "no draw is previewed").toHaveCount(0);
  await expect(page.getByText("Each pair plays")).toBeVisible();
  await expect(start(page)).toBeDisabled();
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start playing · 1 match", exact: true })).toBeVisible();
  // The pair of the no-script test's line (review m3): with the script on, the <noscript> line never shows.
  await expect(page.getByText("Starting a quick match needs JavaScript.", { exact: true })).toBeHidden();
  await expectNoHorizontalScroll(page);
});

test("setup (B4h): after hydration the name is the sport and the browser's own date, and it follows the sport until edited", async ({ guest: page }) => {
  await openSetup(page);
  const name = form(page).getByLabel("Name", { exact: true });
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short" }).format(new Date()),
  );
  await expect(name).toHaveValue(`Badminton · ${today}`);
  await choice(page, "Tennis").click();
  await expect(name).toHaveValue(`Tennis · ${today}`);
  await name.fill("Friday night");
  await choice(page, "Badminton").click();
  await expect(name).toHaveValue("Friday night");
});

test("setup (plan 5): League stays the choice at 3 to 6 sides, the Format list grows with the sides, and Start counts the round robin", async ({ guest: page }) => {
  await openSetup(page);
  const names = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max", "Kim & Raj", "Ana & Leo"];
  await side(page, 1).fill(names[0]!);
  await side(page, 2).fill(names[1]!);
  let checked = 0;
  for (let n = 3; n <= QUICK_MATCH_MAX_SIDES; n++) {
    await form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
    await side(page, n).fill(names[n - 1]!);
    // Nobody picked a knockout: League stays the choice whatever the list grows to.
    await expectFormatList(page, n, "league", `${n} sides`);
    await expect(form(page).getByText(mk("quickMatch.setup.plays"), { exact: true }), `${n} sides: how often each pair plays`).toBeVisible();
    // The rulebook's count, never the page's: a single round robin of n sides plays n(n-1)/2 matches ("Once" is the default).
    await expect(page.getByTestId("qm-start-count"), `${n} sides`).toHaveText(plural(mk, "quickMatch.setup.startCount", matchesOf(n, 1, "league")));
    await expectNoHorizontalScroll(page);
    checked += 1;
  }
  expect(checked, "anti-vacuity: side counts checked, 3 to the most a quick match takes").toBe(QUICK_MATCH_MAX_SIDES - 2);
  expect(checked).toBeGreaterThan(0);
  // Owner 2026-11-12: just above Start, said plainly, that an unsaved quick match is deleted, after the sweep's own days.
  const note = page.getByTestId("qm-keep-note");
  await expect(note).toHaveText(mk("quickMatch.setup.keepNote", { days: QUICK_MATCH_EXPIRY_DAYS }));
  const [noteBox, startBox] = [await note.boundingBox(), await start(page).boundingBox()];
  expect(noteBox && startBox && noteBox.y + noteBox.height <= startBox.y, "the line sits above Start").toBe(true);
  await expect(form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }), "at the most sides there is no row to add").toHaveCount(0);
});

test("setup (plan 5 T8): the Format list at 320, 768 and 1280: 2 sides League only; 3 sides League → Final (4 matches), Semi-finals disabled with its reason; 6 sides with Semi-finals 18, Twice 33; back to 3 sides it falls back to League → Final and the count follows, and a 4th side brings Semi-finals back; every row a 44px target; no sideways scroll", async ({ guest: page }) => {
  // The mockup's own numbers (qmd13a01 §6), pinned against the rulebook's count so neither drifts alone.
  expect([matchesOf(6, 1, "semis"), matchesOf(6, 2, "semis"), matchesOf(3, 1, "final")], "the mockup's 18, 33 and 4").toEqual([18, 33, 4]);
  expect(Object.values(THROUGH).sort(), "the two knockout rows send QUICK_MATCH_QUALIFIERS through").toEqual([...QUICK_MATCH_QUALIFIERS].sort());
  const names = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max", "Kim & Raj", "Ana & Leo"];
  const count = (sides: number, plays: number, shape: Shape, why: string) =>
    expect(page.getByTestId("qm-start-count"), why).toHaveText(plural(mk, "quickMatch.setup.startCount", matchesOf(sides, plays, shape)));
  const addSide = () => form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
  const removeSide = (n: number) => form(page).getByRole("button", { name: mk("quickMatch.setup.removeSide", { n }) }).click();
  let rows = 0;
  let widths = 0;
  for (const width of [320, 768, 1280] as const) {
    await page.setViewportSize({ width, height: 900 });
    await openSetup(page);
    await side(page, 1).fill(names[0]!);
    await side(page, 2).fill(names[1]!);
    rows += await expectFormatList(page, 2, "league", `${width}, 2 sides`);
    await count(2, 1, "league", `${width}, 2 sides`);

    // Three sides: both knockout rows appear; Semi-finals is shown, disabled, with its reason. League → Final counts 3 + 1.
    await addSide();
    await side(page, 3).fill(names[2]!);
    rows += await expectFormatList(page, 3, "league", `${width}, 3 sides`);
    await shapeRow(page, "final").click();
    rows += await expectFormatList(page, 3, "final", `${width}, 3 sides, League → Final`);
    await count(3, 1, "final", `${width}, 3 sides, League → Final`);
    await expectNoHorizontalScroll(page);

    // Six sides, Semi-finals: 15 + 3; Twice doubles the league part only: 30 + 3.
    for (let n = 4; n <= QUICK_MATCH_MAX_SIDES; n++) {
      await addSide();
      await side(page, n).fill(names[n - 1]!);
    }
    rows += await expectFormatList(page, 6, "final", `${width}, 6 sides`);
    await shapeRow(page, "semis").click();
    rows += await expectFormatList(page, 6, "semis", `${width}, 6 sides, Semi-finals`);
    await count(6, 1, "semis", `${width}, 6 sides, Semi-finals, Once`);
    await form(page).getByText(mk(`quickMatch.setup.plays.${QUICK_MATCH_MAX_PLAYS}`), { exact: true }).click();
    await count(6, QUICK_MATCH_MAX_PLAYS, "semis", `${width}, 6 sides, Semi-finals, Twice`);
    await form(page).getByText(mk("quickMatch.setup.plays.1"), { exact: true }).click();
    await count(6, 1, "semis", `${width}, back to Once`);
    // Every row is one tap target: the whole label, 44px, and a tap at its centre lands on it (the radio is visually hidden).
    for (const shape of ["league", "final", "semis"] as const) await expectRowTappable(shapeRow(page, shape), `${width}: the ${shape} row`);
    await expectNoHorizontalScroll(page);

    // Back to three sides: Semi-finals can no longer be played, so the choice that posts falls back to League → Final and
    // the count follows it; a fourth side brings the guest's own choice back.
    for (let n = QUICK_MATCH_MAX_SIDES; n > 3; n--) await removeSide(n);
    rows += await expectFormatList(page, 3, "final", `${width}, back to 3 sides`);
    await count(3, 1, "final", `${width}, back to 3 sides`);
    await addSide();
    await side(page, 4).fill(names[3]!);
    rows += await expectFormatList(page, 4, "semis", `${width}, a 4th side again`);
    await count(4, 1, "semis", `${width}, a 4th side again`);
    await expectNoHorizontalScroll(page);
    widths += 1;
  }
  expect(widths).toBe(3);
  // 1 + 3 + 3 + 3 + 3 + 3 + 3 rows a width (anti-vacuity: the list was read, not skipped).
  expect(rows, "Format rows checked").toBe(3 * 19);
});

test("Start (plan 5 T8): League → Final of three sides lands on a home whose eyebrow says League + Knockout, its knockout waiting on 1st and 2nd in the league, and its played line counting both parts", async ({ guest: page }) => {
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(`e2e lk start ${TAG}`);
  await form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
  for (const [i, s] of ["Ravi & Sam", "Priya & Tom", "Lee & Ana"].entries()) await side(page, i + 1).fill(s);
  await shapeRow(page, "final").click();
  // The post carries the one radio the route maps (plan 5 D1): `shape=final`, never a format of its own.
  const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/quick-match");
  await start(page).click();
  const body = new URLSearchParams((await posted).postData() ?? "");
  expect([body.getAll("shape"), body.has("format"), body.has("qualifiers")], "the post names the shape alone").toEqual([["final"], false, false]);
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: NAV_MS });
  await expect(page.getByTestId("qm-eyebrow"), "the eyebrow names the format").toHaveText(new RegExp(` · ${escapeRe(ui("quickMatch.format.league_knockout"))}$`));
  const ko = page.getByTestId("qm-knockout");
  await expect(ko).toBeVisible();
  await expect(ko.getByTestId("qm-draw-title")).toHaveText(ui("quickMatch.home.knockout"));
  await expect(ko.getByTestId("qm-knockout-caption")).toHaveText(ui("quickMatch.home.knockoutFills"));
  // League → Final: one card, the final, its seats waiting on the league's top two (D7), no side seated yet.
  await expect(ko.getByTestId("qm-draw-card")).toHaveCount(THROUGH.final - 1);
  await expect(ko.getByTestId("qm-draw-name")).toHaveText([ui("quickMatch.home.leagueRank.1"), ui("quickMatch.home.leagueRank.2")]);
  // A round robin of 3 plays 3, then a final: "0 of 4 matches played", and how the 4 split (D8).
  const league = matchesOf(3, 1, "league");
  const total = matchesOf(3, 1, "final");
  await expect(page.getByTestId("qm-played")).toHaveText(
    `${ui(`quickMatch.home.played.${EN_PLURAL.select(total)}`, { played: 0, count: total, days: QUICK_MATCH_EXPIRY_DAYS })} · ${ui("quickMatch.home.stagePart.split", { league, knockout: total - league })}`,
  );
  // The hero counts the league's matches only while the league is on (D8: "match 1 of 3").
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total: league }));
  await expect(page.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.goThrough", { count: THROUGH.final }));
  await expectNoHorizontalScroll(page);
});

test("setup (D5): the × on side 3 removes it and the count goes back with it; sides 1 and 2 have no ×", async ({ guest: page }) => {
  await openSetup(page);
  await page.getByRole("button", { name: "+ Add a side" }).click();
  await expect(side(page, 3)).toBeVisible();
  // A round robin of 3 plays 3, of 2 plays 1 (n(n-1)/2).
  await expect(page.getByTestId("qm-start-count")).toHaveText(plural(mk, "quickMatch.setup.startCount", 3));
  await expect(page.getByRole("button", { name: "Remove side 1" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove side 3" }).click();
  await expect(side(page, 3)).toHaveCount(0);
  await expect(page.getByTestId("qm-start-count")).toHaveText(plural(mk, "quickMatch.setup.startCount", 1));
});

test("a refusal read on the server (?e=, the no-script path) shows its line", async ({ guest: page }) => {
  await page.goto("/en/play?e=QUICK_MATCH_RATE_LIMITED");
  await expect(page.getByTestId("qm-setup-error")).toContainText("Too many new matches from this network.");
});

test("a refused create shows its line and KEEPS the typed sides (the fetch follows the 303 back to /play?e=)", async ({ guest: page }) => {
  // The route's own refusal is a 303 to /<locale>/play?e=<code> (create-route.test.ts); the cap it stands for needs five
  // live matches on one visitor, so the answer is stubbed here and everything after it is real: the browser follows the
  // 303, the page renders, and the island reads `res.url`.
  await page.route("**/api/quick-match", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 303, headers: { location: "/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE" } })
      : route.continue(),
  );
  await openSetup(page);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page.getByTestId("qm-setup-error")).toContainText("You have 5 quick matches on the go on this device.");
  await expect(page).toHaveURL(/\/en\/play$/);
  await expect(side(page, 1)).toHaveValue("Ravi & Sam");
  await expect(side(page, 2)).toHaveValue("Priya & Tom");
  await expect(start(page), "unlocked for another try").toBeEnabled();
});

// A stale page or a hand-made post (plan 5, spec §3): the setup form's own fields with one field changed, posted by the browser
// itself as a plain form post (quick-match-home.spec.ts posts its crafted forms the same way). Each reaches the create because
// this harness skips the bot check (the no-script case below says why); nothing is stubbed. Each answer is the create's own
// guard (quick-match-create.ts), read on the page as the setup screen's line for its code.
const CRAFTED = [
  {
    what: "a plain knockout (no shape, a format of its own)",
    sides: 2,
    craft: { drop: ["shape"], set: { format: "knockout" } },
    code: "QUICK_MATCH_FORMAT_NOT_OFFERED",
    line: () => mk("quickMatch.errors.formatNotOffered"),
  },
  {
    what: "League → Final of two sides (the league replayed as its final)",
    sides: QUICK_MATCH_KNOCKOUT_MIN_SIDES - 1,
    craft: { drop: [], set: { shape: "final" } },
    code: "QUICK_MATCH_FORMAT_NOT_OFFERED",
    line: () => mk("quickMatch.errors.formatNotOffered"),
  },
  {
    what: "Semi-finals of three sides (an old tab: the row is disabled here)",
    sides: QUICK_MATCH_SEMIS_MIN_SIDES - 1,
    craft: { drop: [], set: { shape: "semis" } },
    code: "QUICK_MATCH_SEMIS_TOO_FEW_SIDES",
    line: () => mk("quickMatch.errors.semisTooFewSides", { min: QUICK_MATCH_SEMIS_MIN_SIDES }),
  },
] as const;

test("crafted posts (plan 5): a plain knockout, League → Final of two sides and Semi-finals of three each land on /en/play?e=<code>, the page says why, and no home is made", async ({ guest: page }) => {
  const names = ["Ravi & Sam", "Priya & Tom", "Lee & Ana"];
  let refused = 0;
  for (const c of CRAFTED) {
    await openSetup(page);
    for (let n = 3; n <= c.sides; n++) await form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
    for (let n = 1; n <= c.sides; n++) await side(page, n).fill(names[n - 1]!);
    // The positive pair: the form the guest sees posts the one radio, League (chosen); Semi-finals cannot be picked at three.
    await expect(form(page).locator('input[name="shape"]:checked'), c.what).toHaveValue("league");
    await expect(form(page).locator('input[name="format"]'), `${c.what}: the form has no format field of its own`).toHaveCount(0);
    if (c.sides >= QUICK_MATCH_KNOCKOUT_MIN_SIDES) await expect(shapeRadio(page, "semis"), c.what).toBeDisabled();
    // The refusal is caught as the redirected GET: `?e=` stays in the URL only until the page's ClearFlashParam takes it out.
    const landed = page.waitForRequest((r) => {
      if (r.method() !== "GET") return false;
      const url = new URL(r.url());
      return url.pathname === "/en/play" && url.searchParams.get("e") === c.code;
    });
    const sent = await page.evaluate(({ drop, set }) => {
      const real = document.querySelector<HTMLFormElement>('[data-testid="qm-setup-form"]')!;
      const fields = new FormData(real);
      for (const name of drop) fields.delete(name);
      for (const [name, value] of Object.entries(set)) fields.set(name, value);
      const crafted = document.createElement("form");
      crafted.method = "post";
      crafted.action = real.action;
      fields.forEach((value, name) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = String(value);
        crafted.append(input);
      });
      document.body.append(crafted);
      crafted.submit();
      return {
        shape: fields.getAll("shape").map(String),
        format: fields.getAll("format").map(String),
        sides: fields.getAll("sides").length,
      };
    }, { drop: [...c.craft.drop] as string[], set: { ...c.craft.set } as Record<string, string> });
    const want = c.craft.set as Record<string, string>;
    expect(sent, `${c.what}: what the crafted post asks for`).toEqual({
      shape: want.shape !== undefined ? [want.shape] : [],
      format: want.format !== undefined ? [want.format] : [],
      sides: c.sides,
    });
    expect((await landed).redirectedFrom()?.method(), `${c.what}: the post's 303 landed on the refusal`).toBe("POST");
    await expect(page.getByTestId("qm-setup-error"), c.what).toHaveText(c.line());
    await expect(page, `${c.what}: no home was made, the guest is still on the setup page`).toHaveURL(/\/en\/play$/);
    refused += 1;
  }
  expect(refused, "crafted posts refused").toBe(CRAFTED.length);
});

test("Start creates the quick match: the browser lands on its home, /q/qm_…, with no query, and holds a visitor key", async ({ guest: page }) => {
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(`e2e setup ${TAG}`);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "seazn_qm_visitor" && c.httpOnly)).toBe(true);
});

test("Continue (owner 2026-11-12): back on /play after a Start, the unfinished match is met first, above the form, and Continue lands on its home; the form is still there", async ({ guest: page }) => {
  const name = `e2e continue ${TAG}`;
  const home = await createFromSetup(page, name, ["Ravi & Sam", "Priya & Tom"]);
  await page.goto("/en/play");
  const card = page.getByTestId("qm-continue");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(name);
  // A league of two sides, once: the rulebook's one match, none played yet.
  await expect(page.getByTestId("qm-continue-played")).toHaveText(ui("quickMatch.home.playedSaved.one", { played: 0, count: 1 }));
  await expect(page.getByTestId("qm-start-new")).toHaveText(mk("quickMatch.continue.startNew"));
  // Met first: the card sits above the heading, and the heading above the form, which never goes away.
  const [c, h, f] = await Promise.all([card, page.getByTestId("qm-start-new"), form(page)].map((l) => l.boundingBox()));
  expect(c && h && f && c.y + c.height <= h.y && h.y + h.height <= f.y, "card, then the heading, then the form").toBe(true);
  await expect(start(page)).toBeVisible();
  // Its one row is the card now: the strip below has nothing left to list.
  await expect(page.getByTestId("qm-recent")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.getByTestId("qm-continue-link").click();
  await page.waitForURL((url) => url.pathname === home, { timeout: NAV_MS });
  await expect(page.getByTestId("qm-name")).toHaveText(name);
});

test("the real cap: five live quick matches on one visitor, and the sixth Start reads the cap's line and keeps the names (m10)", async ({ guest: page }) => {
  // Five REAL creates through the form's own fields (the page's fetch, so the visitor cookie the first one sets is the
  // one the next four carry), then a sixth through the Start button. QUICK_MATCH_MAX_ALIVE_PER_VISITOR is 5 (spec §7.9);
  // the per-IP create limit (20 per 10 minutes) leaves room for this spec's eight creates.
  await openSetup(page);
  await side(page, 1).fill(`Cap A ${TAG}`);
  await side(page, 2).fill(`Cap B ${TAG}`);
  for (let k = 1; k <= 5; k++) {
    const landed = await page.evaluate(async () => {
      const form = document.querySelector<HTMLFormElement>('[data-testid="qm-setup-form"]')!;
      const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form) as never) });
      return res.url;
    });
    expect(landed, `create ${k} lands on its home`).toMatch(/\/q\/qm_[^/?#]+$/);
  }
  const refusedPage = page.waitForResponse((r) => r.url().includes("/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE"));
  await start(page).click();
  expect((await refusedPage).status()).toBe(200);
  await expect(page.getByTestId("qm-setup-error")).toContainText("You have 5 quick matches on the go on this device.");
  await expect(page).toHaveURL(/\/en\/play$/);
  await expect(side(page, 1)).toHaveValue(`Cap A ${TAG}`);
  await expect(side(page, 2)).toHaveValue(`Cap B ${TAG}`);
});

test("without the script: the page says it needs JavaScript, Start is live, only the chosen sport can be picked, and on this harness (bot check skipped; a deployed server refuses the post) the plain post lands on the home (I1)", async ({ browser }, info) => {
  // The plain post carries no bot-check token. It lands here because e2e's server is a harness (ENV_NAME ci), which skips
  // Cloudflare Turnstile (server/turnstile.ts `turnstileMode`); a deployed server refuses it with
  // QUICK_MATCH_TURNSTILE_FAILED, as #1136's forms are refused without the script (create-route.test.ts, the bot-check block).
  const ctx = await guestContext(browser, info, { javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    await page.goto("/en/play");
    await expect(form(page)).toBeVisible();
    // Review m3: the server's HTML says, in the Start bar, that a quick match needs the script, since a deployed server refuses
    // this plain post. Asserted on the element's DOM text, not on its visibility: Playwright's per-context JS-off still parses
    // <noscript> as raw text in Chromium and WebKit (and its text matchers skip a noscript's contents), while Blink's own
    // scripting switch, which does render the line, also stops Playwright's locators. The rendered line was checked by eye
    // with that switch (task-TS report, round 3).
    await expect(page.getByTestId("qm-start-bar").locator("noscript")).toHaveJSProperty(
      "textContent",
      "Starting a quick match needs JavaScript.",
    );
    await expect(start(page)).toBeEnabled();
    await expect(form(page).getByRole("radio", { name: "Badminton", exact: true })).toBeChecked();
    await expect(form(page).getByRole("radio", { name: "Tennis", exact: true })).toBeDisabled();
    // Plan 5 D1: the Format list is real radios in the server's HTML. Two sides (no script adds a third) offer League alone,
    // already chosen, so the plain post carries it as the one field the route maps, `shape`.
    await expect(form(page).locator('input[type="radio"][name="shape"]'), "no script: two sides, League alone").toHaveCount(1);
    await expect(shapeRadio(page, "league"), "League is chosen in the server's HTML").toBeChecked();
    await side(page, 1).fill("Ravi & Sam");
    await side(page, 2).fill("Priya & Tom");
    const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/quick-match");
    await start(page).click();
    const body = new URLSearchParams((await posted).postData() ?? "");
    expect([body.getAll("shape"), body.has("format")], "the plain post carries the chosen radio").toEqual([["league"], false]);
    await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
    await expect(page.getByTestId("qm-eyebrow"), "a league was made").toHaveText(new RegExp(` · ${escapeRe(ui("quickMatch.format.league"))}$`));
  } finally {
    await ctx.close();
  }
});

test("every control a thumb taps is at least 44px tall, the × at least 44px wide (m3)", async ({ guest: page }) => {
  await openSetup(page);
  await page.getByRole("button", { name: "+ Add a side" }).click();
  const boxes: { what: string; h: number; w: number }[] = [];
  const measure = async (what: string, locator: ReturnType<Page["locator"]>) => {
    for (const el of await locator.all()) {
      const box = await el.boundingBox();
      expect(box, `${what} has a box`).not.toBeNull();
      boxes.push({ what, h: box!.height, w: box!.width });
    }
  };
  // The radios are sr-only; a chip's or a segment's visible face is its label's span. A Format row (plan 5) is the whole
  // label (the dot and the words are inside it), so the row is what is measured.
  await measure("chip/segment", form(page).locator('label:has(input[type=radio]:not([name="shape"])) > span'));
  await measure("format row", form(page).locator('label:has(input[name="shape"])'));
  await expect(form(page).locator('label:has(input[name="shape"])'), "three sides: three Format rows").toHaveCount(3);
  await measure("side", form(page).locator('input[name="sides"]'));
  await measure("remove", form(page).getByRole("button", { name: "Remove side 3" }));
  await measure("add", form(page).getByRole("button", { name: "+ Add a side" }));
  await measure("rules", form(page).locator("select"));
  await measure("email", form(page).locator("summary"));
  for (const b of boxes) expect(b.h, `${b.what} height`).toBeGreaterThanOrEqual(44);
  for (const b of boxes.filter((x) => x.what === "remove")) expect(b.w).toBeGreaterThanOrEqual(44);
  expect(boxes.length, "controls measured").toBeGreaterThanOrEqual(15);
});

test("first visit on a phone: the cookie banner's buttons stay tappable and the Start bar un-docks under it, then docks again (m4, m5)", async ({ browser }, info) => {
  const ctx = await guestContext(browser, info, { storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 667 } });
  try {
    const page = await ctx.newPage();
    await page.goto("/en/play");
    const banner = page.getByTestId("cookie-consent");
    await expect(banner).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-consent-open", "");
    const bar = page.getByTestId("qm-start-bar");
    await expect(bar).toHaveCSS("position", "static");
    // Hit-test the banner's Accept at its centre: nothing of the page sits on top of it.
    const accept = page.getByTestId("cookie-accept");
    const box = (await accept.boundingBox())!;
    const onTop = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="cookie-accept"]') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(onTop, "Accept is the element under its own centre").toBe(true);
    await accept.click();
    await expect(banner).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-consent-open");
    await expect(bar).toHaveCSS("position", "sticky");
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

// ── Save (plan 3 Task 5) ────────────────────────────────────────────────────────────────────────────────────────────
//
// The save page (`/q/<token>/save`) and the Save post (`/q/<token>/save/confirm`): the route's every answer and the page's
// every state are proven in app/q/[token]/__tests__/save-route.test.ts and save-page.test.tsx; this is what only a browser
// shows: the page's width with a real name at 320, 768 and 1280, the 44px targets, the plain post without the script, and
// the sign-in's real round trip back to the save page. The full journey (a typed address, a second account, a second guest)
// is the walkthrough's (D).

const SAVE_WIDTHS = [320, 768, 1280] as const;

test("Save (plan 3 Task 5): the save page at 320, 768 and 1280; without the script and signed out it posts to the sign-in; signed in it saves", async ({ guest: page, browser }, info) => {
  const name = `e2e save ${TAG}`;
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const home = new URL(page.url()).pathname;
  const savePage = `${home}/save`;

  // The save page, signed out, at each width: the name, what saving does, one button and the way back, each a 44px target.
  await page.goto(savePage);
  let checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("qm-save-title"), `${width}`).toHaveText(`Keep ${name} in your account?`);
    await expect(page.getByTestId("qm-save-hint"), `${width}`).toHaveText("It stays until you delete it. Anyone with the link can still score.");
    for (const id of ["qm-save", "qm-save-back"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, `${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);

  // Without the script: the same page's plain post reaches the route, which sends a signed-out guest to sign in.
  const noScript = await guestContext(browser, info, { javaScriptEnabled: false });
  try {
    const plain = await noScript.newPage();
    await plain.goto(savePage);
    await plain.getByTestId("qm-save").click();
    await expect(plain).toHaveURL(/\/login\?next=/);
    expect(new URL(plain.url()).searchParams.get("next"), "no script: the sign-in carries the save page").toBe(savePage);
  } finally {
    await noScript.close();
  }

  // Signed out, from the home: Save goes to the sign-in, carrying the save page.
  await page.goto(home);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(savePage);

  // Signed in by the real magic link: back on the save page; Save lands on the home, which says Saved at every width.
  await loginUi(page, `delivered+e2e-qm-save-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, savePage);
  await expect(page.getByTestId("qm-save-title")).toHaveText(`Keep ${name} in your account?`);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "");
  checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("qm-saved"), `${width}`).toHaveText("Saved");
    await expect(page.getByTestId("qm-save"), `${width}: no button once saved`).toHaveCount(0);
    // Plan 3 Task 6: beside "Saved", the way to the account's Quick matches.
    const inAccount = page.getByTestId("qm-in-account");
    await expect(inAccount, `${width}`).toHaveText("In your account");
    await expect(inAccount, `${width}`).toHaveAttribute("href", "/me#quick-matches");
    expect((await inAccount.boundingBox())?.height ?? 0, `${width}: In your account is a 44px target`).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);
});

// The account's Quick matches on /me (quick match plan 3 Task 6): the list's every answer is proven in
// app/me/__tests__/quick-matches-section.test.tsx and the requests' in app/api/quick-match/__tests__/owner-routes.test.ts;
// this is what only a browser shows: the row with the longest name the create allows at 320, 768 and 1280, Rename's form
// and Delete's confirmation opened at each, every control a 44px target, nothing sideways; and a match deleted from another
// tab while this one's Rename form was open: Save name drops the row, the list's live region says it is no longer in the
// account, and focus lands on the list's own root rather than the page's body (T6 review m1, m2). The full journey (the rename read back
// on the home, the delete for everyone, the dead link) is the walkthrough's (D).
test("the account's Quick matches (plan 3 Task 6): /me at 320, 768 and 1280 with an 80-character name; Rename's form and Delete's confirmation; a match deleted in another tab drops the row on Save name and says why", async ({ guest: page }) => {
  // A setup, a magic-link sign-in and a save before three widths of two opened panels and a second tab: past the 60s default.
  test.slow();
  // The longest name the create allows, its tail one unbroken word: the hardest to fit at 320.
  const name = `e2e me ${TAG} ${"Longwordwithoutanybreak".repeat(4)}`.slice(0, 80);
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const home = new URL(page.url()).pathname;
  await loginUi(page, `delivered+e2e-qm-me-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, `${home}/save`);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "");

  await page.goto("/me");
  const row = page.getByTestId("me-quick-matches").locator("li[data-qm-id]");
  await expect(row).toHaveCount(1);
  const tall = async (id: string, width: number) => {
    const box = await row.getByTestId(id).boundingBox();
    expect(box?.height ?? 0, `${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
  };
  let checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row.getByTestId("me-qm-name"), `${width}`).toHaveText(name);
    await expect(row.getByTestId("me-qm-name"), `${width}`).toHaveAttribute("href", home);
    for (const id of ["me-qm-name", "me-qm-rename", "me-qm-delete"]) await tall(id, width);
    await expectNoHorizontalScroll(page);

    await row.getByTestId("me-qm-rename").click();
    await expect(row.getByTestId("me-qm-rename-input"), `${width}`).toHaveValue(name);
    for (const id of ["me-qm-rename-input", "me-qm-rename-save", "me-qm-rename-cancel"]) await tall(id, width);
    await expectNoHorizontalScroll(page);
    await row.getByTestId("me-qm-rename-cancel").click();
    await expect(row.getByTestId("me-qm-rename-form"), `${width}: Cancel closes the form`).toHaveCount(0);

    await row.getByTestId("me-qm-delete").click();
    await expect(row.getByTestId("me-qm-delete-question"), `${width}`).toHaveText("Delete this quick match for everyone? The link stops working.");
    for (const id of ["me-qm-delete-yes", "me-qm-delete-cancel"]) await tall(id, width);
    await expectNoHorizontalScroll(page);
    await row.getByTestId("me-qm-delete-cancel").click();
    await expect(row.getByTestId("me-qm-delete-confirm"), `${width}: Cancel keeps the match`).toHaveCount(0);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);

  // A second tab of the same account deletes the match while this tab's Rename form is open: Save name is refused as not in
  // the account, so the row goes, the live region says why, and focus stays on the list (the heading went with the row).
  await row.getByTestId("me-qm-rename").click();
  const other = await page.context().newPage();
  try {
    await other.goto("/me");
    const there = other.getByTestId("me-quick-matches").locator("li[data-qm-id]");
    await there.getByTestId("me-qm-delete").click();
    await there.getByTestId("me-qm-delete-yes").click();
    await expect(other.getByTestId("me-quick-matches"), "the other tab's list is empty, so gone").toHaveCount(0);
  } finally {
    await other.close();
  }
  await row.getByTestId("me-qm-rename-input").fill(`Too late ${TAG}`);
  await row.getByTestId("me-qm-rename-save").click();
  await expect(page.getByTestId("me-quick-matches"), "the gone row is dropped, and the section with it").toHaveCount(0);
  await expect(page.getByTestId("me-qm-status")).toHaveText("This quick match is no longer in your account.");
  await expect(page.getByTestId("me-qm-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("me-qm-root"), "focus on a stable target, not the page's body").toBeFocused();
  await expectNoHorizontalScroll(page);
  // The page's own read: no Quick matches left.
  await page.reload();
  await expect(page.locator("h1.page-title")).toBeVisible();
  await expect(page.getByTestId("me-quick-matches")).toHaveCount(0);
});

// T-ADM review m5: Delete with OTHER rows left. The list moves focus to its heading when rows remain and to its own root when
// the last one goes (my-list.tsx `settle`); the case above loses the LAST row, so only this one sees the heading branch.
test("the account's Quick matches (plan 3 Task 6, review m5): two saved, one deleted, the other stays and focus lands on the list's heading", async ({ guest: page }) => {
  // Two setups, a magic-link sign-in and two saves: past the 60s default.
  test.slow();
  const names = [`e2e me two A ${TAG}`, `e2e me two B ${TAG}`];
  const homes: string[] = [];
  for (const [i, name] of names.entries()) {
    await openSetup(page);
    await form(page).getByLabel("Name", { exact: true }).fill(name);
    await side(page, 1).fill("Ravi & Sam");
    await side(page, 2).fill("Priya & Tom");
    await start(page).click();
    await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
    const home = new URL(page.url()).pathname;
    homes.push(home);
    // The first save signs in by the real magic link, back on the save page; the second is already signed in.
    if (i === 0) await loginUi(page, `delivered+e2e-qm-me-two-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, `${home}/save`);
    else await page.goto(`${home}/save`);
    await expect(page.getByTestId("qm-save-title")).toHaveText(`Keep ${name} in your account?`);
    await page.getByTestId("qm-save").click();
    await page.waitForURL((u) => u.pathname === home && u.search === "");
  }
  expect(homes).toHaveLength(2);

  await page.goto("/me");
  const rows = page.getByTestId("me-quick-matches").locator("li[data-qm-id]");
  await expect(rows).toHaveCount(2);
  const doomed = rows.filter({ hasText: names[0]! });
  await doomed.getByTestId("me-qm-delete").click();
  await doomed.getByTestId("me-qm-delete-yes").click();

  await expect(rows, "the deleted row goes, the other stays").toHaveCount(1);
  await expect(rows.getByTestId("me-qm-name")).toHaveText(names[1]!);
  await expect(page.getByTestId("me-qm-status")).toHaveText(`${names[0]} was deleted.`);
  await expect(page.locator("#me-quick-matches-title"), "rows remain: focus on the list's heading").toBeFocused();
  await expect(page.getByTestId("me-qm-root"), "not the root (that is for the last row)").not.toBeFocused();
  await expectNoHorizontalScroll(page);
  // The page's own read agrees: one left, the one not deleted.
  await page.reload();
  await expect(page.getByTestId("me-quick-matches").locator("li[data-qm-id]")).toHaveCount(1);
  await expect(page.getByTestId("me-quick-matches").getByTestId("me-qm-name")).toHaveText(names[1]!);
});

// ── Task 10: the league flow, the URL forms ─────────────────────────────────────────────────────────────────────────
//
// The plan's own Task 10 cases, at 1280 (pre-flight amendment B10/D7). What they add over the cases above, the home spec
// (quick-match-home.spec.ts) and the walkthrough (walkthrough/quick-match.spec.ts, which plays whole matches at 390 and
// always leaves the pad by its own link): the BROWSER's Back from the pad after a rally reads the home fresh, and the home
// opens from the link forms a guest really pastes. The seven widths are mobile.spec.ts's quick match cases. (Task 10's
// knockout of four left with the owner's "take out" of 2026-11-12; League + Knockout's home, its fill, its tie and its
// champion are quick-match-home.spec.ts's plan 5 cases.)
//
// Every line the home is expected to read is the en dictionary's (never retyped); the score after one rally is the
// rulebook's (rally-point scoring: the side that wins a rally adds one point); the match counts are the format's (a round
// robin of n plays n(n-1)/2).

type Words = Record<string, string>;
const readWords = (rel: string): Words => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Words;
const UI = readWords("../src/dictionaries/en/ui.json");
const MK = readWords("../src/dictionaries/en/marketing.json");
/** An en line of `dict` with its `{name}` slots filled; a missing key or slot throws rather than reading "undefined". */
function words(dict: Words, which: string, key: string, vars: Record<string, string | number> = {}): string {
  const text = dict[key];
  if (typeof text !== "string") throw new Error(`the en ${which} dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}
/** An en ui line (ui.json). */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  return words(UI, "ui", key, vars);
}
/** An en marketing line (marketing.json: the setup screen's copy). */
function mk(key: string, vars: Record<string, string | number> = {}): string {
  return words(MK, "marketing", key, vars);
}
const EN_PLURAL = new Intl.PluralRules("en");
/** A plural line: `key.one` / `key.other` by the en rules, `{count}` filled. */
function plural(say: (key: string, vars?: Record<string, string | number>) => string, key: string, count: number): string {
  return say(`${key}.${EN_PLURAL.select(count)}`, { count });
}

/** A page load or a redirect followed (the flow's budget is built from it and the hold, AGENTS.md class 20). */
const NAV_MS = 20_000;

/** Make a quick match through the setup form (badminton, clicked) and land on its home; returns the home's path. The
 *  Format list is left at its default, League. */
async function createFromSetup(page: Page, name: string, sides: readonly string[]) {
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  for (let n = 3; n <= sides.length; n += 1) await form(page).getByRole("button", { name: "+ Add a side" }).click();
  for (const [i, s] of sides.entries()) await side(page, i + 1).fill(s);
  await start(page).click();
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: NAV_MS });
  return new URL(page.url()).pathname;
}

/** The ledger's rallies on one fixture: the record, never the pad's own fold. */
async function ralliesOn(fixtureId: string): Promise<number> {
  const [row] = await withDb(
    (sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = 'badminton.rally'`,
  );
  return row!.n;
}

/** Badminton's live score reads as its levels in seat order (`compactScore`, lib/match-day/view.ts): the games won, then the
 *  game's points ("0–0 · 1–0"). One rally to the home side is a point and no game, so the games stay 0–0 and the points read
 *  1–0. Before that rally the last level reads 0–0, which this does not match. */
const AFTER_ONE_HOME_RALLY = /^\s*0\D+0\D+1\D+0\s*$/;

/** The hero as a person reads it: live, match 1 of `total`, and the score after ONE rally to the home side (seat order). */
async function expectHeroAfterOneHomeRally(page: Page, total: number, why: string) {
  const hero = page.getByTestId("qm-hero");
  await expect(hero.getByTestId("qm-hero-kicker"), why).toHaveText(ui("quickMatch.home.liveMatch", { n: 1, total }));
  await expect(hero.getByTestId("qm-hero-score"), `${why}: no game yet; one point to the home side, none to the away side`).toHaveText(
    AFTER_ONE_HOME_RALLY,
  );
}

/** The hero's match is the list's next one (by its sides, the names a person reads), and the list names exactly one. */
async function nextMatchIsTheHeros(page: Page): Promise<string> {
  const hero = page.getByTestId("qm-hero");
  const next = page.locator('[data-testid="qm-match"][data-next="true"]');
  await expect(next).toHaveCount(1);
  const sides = next.getByTestId("qm-match-sides");
  for (const who of ["qm-hero-home", "qm-hero-away"]) {
    const name = (await hero.getByTestId(who).textContent())?.trim() ?? "";
    expect(name, `the hero names its ${who === "qm-hero-home" ? "home" : "away"} side`).not.toBe("");
    await expect(sides, "the list's next match is the hero's").toContainText(name);
  }
  return (await next.getAttribute("data-fixture-id"))!;
}

/** The record holds `n` rallies and keeps holding them for longer than the pad's hold: a rally queued on the way out and
 *  sent late would land inside the window. Returns how many reads it took (anti-vacuity: never zero). */
async function ralliesStayAt(fixtureId: string, n: number, why: string): Promise<number> {
  const until = Date.now() + HOLD_MS + 1_000;
  let reads = 0;
  do {
    expect(await ralliesOn(fixtureId), `${why} (read ${reads + 1})`).toBe(n);
    reads += 1;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < until);
  expect(reads, "the record was read across the whole window").toBeGreaterThan(1);
  return reads;
}

test("the league flow (Task 10, Review Focus 2): Score → Start → one rally; Back re-requests the home and is not served stale from the HTTP cache (live, the rally's score); Forward, then 'Back to the quick match', reads it too", async ({ guest: page }) => {
  // Seven page loads or redirects, the rally's hold before it is sent, the record read back, and the late-send window after:
  // derived, never a flat literal.
  test.setTimeout(7 * NAV_MS + HOLD_MS + NAV_MS + (HOLD_MS + 1_000 + NAV_MS));
  const home = await createFromSetup(page, `e2e flow ${TAG}`, ["Ravi & Sam", "Priya & Tom"]);
  // Fresh, before anything is scored: up next, no score. The negative pair of what Back must read below.
  const hero = page.getByTestId("qm-hero");
  await expect(hero.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total: 1 }));
  await expect(hero.getByTestId("qm-hero-score"), "nothing scored yet: no score on the hero").toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const fixtureId = await nextMatchIsTheHeros(page);

  // Score → the pad's Confirm card → Start match → one rally to the home side, in the record before anything leaves the pad.
  await hero.getByTestId("qm-score").click();
  await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: NAV_MS });
  const pad = new URL(page.url()).pathname;
  await page.getByTestId("score-start-match").click();
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf, "Start opens the pad, its halves tappable").toBeVisible({ timeout: NAV_MS });
  await homeHalf.click();
  // The pad soft-commits: the rally is sent only after the hold (queue.ts), so the record is polled past it.
  await expect.poll(() => ralliesOn(fixtureId), { timeout: HOLD_MS + NAV_MS, message: "the rally never reached the ledger" }).toBe(1);

  // The browser's own Back. Playwright's Chromium runs with its back-forward cache OFF (`--disable-back-forward-cache`), so
  // this Back is always a request: what it proves is that the HTTP cache does not hand the home back stale (no-store). A
  // restore from the back-forward cache, what a phone does, is the review I-1 case below.
  await page.goBack();
  await page.waitForURL((u) => u.pathname === home, { timeout: NAV_MS });
  await expectHeroAfterOneHomeRally(page, 1, "after the browser's Back");
  await expectNoHorizontalScroll(page);

  // Forward to the pad again, then its own way back.
  await page.goForward();
  await page.waitForURL((u) => u.pathname === pad, { timeout: NAV_MS });
  await page.getByTestId("quick-match-back-link").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: NAV_MS });
  await expectHeroAfterOneHomeRally(page, 1, "after 'Back to the quick match'");
  await ralliesStayAt(fixtureId, 1, "nothing more was sent on the way, nor late");
});

// Review I-1. A phone's browser (iOS Safari above all) keeps the home whole in its back-forward cache when the guest taps
// Score, and Back shows that copy without asking the server; no-store does not stop it. `QuickMatchRefreshOnRestore`
// reloads the page on the restore's `pageshow` (persisted). This case launches a Chromium of its own WITH the cache (the
// project's carries `--disable-back-forward-cache`) and records every pageshow of the tab in sessionStorage, which outlives
// both a restore and a reload: Back that RESTORES reads [persisted, then the island's reload], one that reloads reads
// [a plain load]. On the restore path the hero can read the rally only because the island reloaded (remove it and the
// restored page is the "Up next" home the guest left). When this Chromium declines to keep the page (a no-store page enters
// its cache only behind a feature switch), Back is the league case's plain load again and proves nothing about the island:
// the case SKIPS, with Chromium's reasons, so the skip count says the restore never ran (review I-3), and the handler's proof
// is its unit test (refresh-on-restore.test.tsx). Only the restore path passes. A goBack that hangs under a real cache times
// out at NAV_MS: read that as the harness (Playwright disables the cache partly for this), not the product (review m7).
test("Back from the pad on a browser WITH a back-forward cache (review I-1): the restored home reads the rally, not the page it left", async ({ playwright }, info) => {
  test.setTimeout(8 * NAV_MS + HOLD_MS + NAV_MS);
  const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  try {
    const ctx = await guestContext(browser, info);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.addEventListener("pageshow", (e) => {
        const seen = JSON.parse(sessionStorage.getItem("qm-e2e-shows") ?? "[]") as boolean[];
        sessionStorage.setItem("qm-e2e-shows", JSON.stringify([...seen, e.persisted]));
      });
    });
    const home = await createFromSetup(page, `e2e bfcache ${TAG}`, ["Ravi & Sam", "Priya & Tom"]);
    const hero = page.getByTestId("qm-hero");
    await expect(hero.getByTestId("qm-hero-kicker"), "the page Back would restore: up next").toHaveText(
      ui("quickMatch.home.upNext", { n: 1, total: 1 }),
    );
    await expect(hero.getByTestId("qm-hero-score"), "and no score").toHaveCount(0);
    const fixtureId = await nextMatchIsTheHeros(page);

    await hero.getByTestId("qm-score").click();
    await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: NAV_MS });
    await page.getByTestId("score-start-match").click();
    const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
    await expect(homeHalf, "Start opens the pad, its halves tappable").toBeVisible({ timeout: NAV_MS });
    await homeHalf.click();
    await expect.poll(() => ralliesOn(fixtureId), { timeout: HOLD_MS + NAV_MS, message: "the rally never reached the ledger" }).toBe(1);

    // From here, only Back's pageshows are recorded.
    await page.evaluate(() => sessionStorage.removeItem("qm-e2e-shows"));
    // A restore fires no load event: Back waits for the commit only.
    await page.goBack({ waitUntil: "commit", timeout: NAV_MS });
    await page.waitForURL((u) => u.pathname === home, { timeout: NAV_MS, waitUntil: "commit" });
    await expectHeroAfterOneHomeRally(page, 1, "after Back on a browser with a back-forward cache");

    // `pageshow` follows the load event, which can trail the hero's text: poll the record until it settles. (A read during
    // the island's reload meets a torn-down context and is simply read again.)
    const readShows = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("qm-e2e-shows") ?? "[]") as boolean[]);
    await expect.poll(async () => (await readShows()).length, { timeout: NAV_MS, message: "Back's pageshow was never recorded" }).toBeGreaterThan(0);
    if ((await readShows())[0] !== true) {
      await expect.poll(readShows, { timeout: NAV_MS, message: "not restored: one plain load" }).toEqual([false]);
      // Why Chromium did not keep the page, in its own words only: the entries also carry the page's URL, which is its token.
      const reasons = await page.evaluate(() => {
        const out: string[] = [];
        const walk = (node: unknown) => {
          const n = node as { reasons?: { reason?: unknown }[] | null; children?: unknown[] | null } | null;
          for (const r of n?.reasons ?? []) if (typeof r?.reason === "string") out.push(r.reason);
          for (const c of n?.children ?? []) walk(c);
        };
        const nav = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { notRestoredReasons?: unknown }) | undefined;
        walk(nav?.notRestoredReasons ?? null);
        return out;
      });
      test.skip(true, `Chromium did not restore the home from its back-forward cache: ${reasons.join(", ") || "no reason given"}`);
    }
    // Restored: then the island's reload, whose own pageshow is a plain load (and no loop after it).
    await expect.poll(readShows, { timeout: NAV_MS, message: "restored, then the island's reload: one plain load" }).toEqual([true, false]);
    info.annotations.push({
      type: "bfcache",
      description: "restored from the back-forward cache (pageshow.persisted); the island reloaded it and the hero read the rally",
    });
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test("the URL forms (Task 10, Review Focus 3): the home opens from its link with a trailing slash and with a ?utm suffix", async ({ guest: page }) => {
  const name = `e2e url forms ${TAG}`;
  const home = await createFromSetup(page, name, ["Ravi & Sam", "Priya & Tom"]);
  // The positive pair first: the bare link reads the home.
  await expect(page.getByTestId("qm-name")).toHaveText(name);
  // `skipTrailingSlashRedirect` (next.config.js) serves both forms as written, so each must read the token from the path alone.
  // Each form is named in a message by its label, never by its URL: the URL is the home's token (O3).
  const forms: [string, string][] = [
    ["trailing slash", `${home}/`],
    ["utm", `${home}?utm_source=whatsapp`],
    ["both", `${home}/?utm_source=whatsapp&utm_medium=social`],
  ];
  for (const [label, url] of forms) {
    await page.goto(url);
    await expect(page.getByTestId("qm-dead-link"), `${label}: not the dead screen`).toHaveCount(0);
    await expect(page.getByTestId("qm-name"), `${label}: the same home`).toHaveText(name);
    await expect(page.getByTestId("qm-hero").getByTestId("qm-hero-kicker"), label).toHaveText(ui("quickMatch.home.upNext", { n: 1, total: 1 }));
  }
});
