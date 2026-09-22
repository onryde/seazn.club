// The standings popovers, driven in a browser on BOTH surfaces that print a
// standings table: the division page (`standings-table.tsx`, here as the
// public `/shared/…/<division>?tab=standings`) and the competition hub's Table
// tab (`standings-table-view.tsx`, `/shared/…/<competition>?tab=table`).
//
// Two owner-approved changes, both about a tap that explains a number:
//
//  1. The tie-break note must DISMISS. It was a native `<details>` that stayed
//     open until its own trigger was found again — a tap anywhere else did
//     nothing. On the hub it was a `title=` a phone cannot hover at all.
//  2. A "Pts ratio" cell opens onto the TOTALS it divides: "Points won {won} ·
//     Points lost {lost} · Ratio {ratio}".
//
// Why e2e: `apps/web` vitest is `environment: "node"`, so the unit suites see
// the closed markup and nothing else. Closing on an outside tap, on Esc and
// when another opens is behaviour; whether the open panel is painted ABOVE the
// rows below it (the sticky rank cells are `z-10`) and INSIDE its
// `overflow-x-auto` box (which clips) is geometry. Both are only settled by a
// browser — the paint by `elementFromPoint`, never `boundingBox()`, which
// measures where a box is, not whether it is the thing a finger lands on.
//
// THE SEED — a badminton round robin, scored through the real event route.
// Badminton because its default cascade ranks on `point_ratio` (and
// `set_ratio`, whose unit is "games" there — the reason that column has no
// popover). Four players and six 2-0 matches arranged so that wins split
// 2-2-1-1 and set ratio cannot separate either pair: A/B are tied on points,
// wins and games, and so are C/D, so BOTH ties are split on point ratio. That
// puts a tied row LAST — the row whose panel has to open upward — and gives
// every row a ledger. Every total asserted below is summed from `MATCHES`,
// never typed.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, overflowingIn } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import {
  API_CALL_MS,
  FLOOR_MS,
  activeOrgSlug,
  dictString,
  division,
  leagueFixtures,
  publicCompetition,
  spectator,
} from "./spectator-w2-kit";

const NAMES = {
  a: `Ada Ratio ${TAG}`,
  b: `Bo Ratio ${TAG}`,
  c: `Cy Ratio ${TAG}`,
  d: `Di Ratio ${TAG}`,
} as const;
type Who = keyof typeof NAMES;
const FIELD: Who[] = ["a", "b", "c", "d"];

/** Winner, loser, and the two games' scores (winner's points first). Every
 *  match 2-0, so games split 4-2 / 2-4 and set ratio ties within each pair. */
const MATCHES: { w: Who; l: Who; games: [number, number][] }[] = [
  { w: "a", l: "b", games: [[21, 15], [21, 15]] },
  { w: "a", l: "c", games: [[21, 10], [21, 10]] },
  { w: "b", l: "c", games: [[21, 12], [21, 12]] },
  { w: "b", l: "d", games: [[21, 17], [21, 17]] },
  { w: "c", l: "d", games: [[21, 19], [21, 19]] },
  { w: "d", l: "a", games: [[21, 18], [21, 18]] },
];

/** Each player's point totals, summed from the seed. */
function totals(who: Who): { won: number; lost: number } {
  let won = 0;
  let lost = 0;
  for (const m of MATCHES) {
    for (const [wp, lp] of m.games) {
      if (m.w === who) {
        won += wp;
        lost += lp;
      } else if (m.l === who) {
        won += lp;
        lost += wp;
      }
    }
  }
  return { won, lost };
}

/** The sentence a spectator must read in `who`'s ratio popover — the
 *  dictionary's own template, filled from the seed. */
function expectedNote(who: Who): string {
  const { won, lost } = totals(who);
  return dictString("en", "table.ratioNote.point_ratio", { won, lost, ratio: (won / lost).toFixed(2) });
}

interface Seed {
  hubPath: string;
  divisionPath: string;
  ids: Record<Who, string>;
}
let seed: Seed;
let seedContext: BrowserContext | undefined;

test.beforeAll(async ({ browser }) => {
  // org, competition, division×2, entrants, stage, generate, start, list = 9,
  // then per match a state read + a post for core.start and each game.
  const perMatch = 2 * (1 + 2);
  test.setTimeout(Math.max(FLOOR_MS, (9 + MATCHES.length * perMatch) * API_CALL_MS));

  seedContext = await browser.newContext();
  const request: APIRequestContext = seedContext.request;
  const org = await activeOrgSlug(request);
  const competition = await publicCompetition(request, { name: `Ratio board ${TAG}`, orgId: org.id });
  const div = await division(request, competition.id, {
    name: "Singles",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  const created = await addEntrantsViaApi(request, div.id, FIELD.map((k) => NAMES[k]));
  expect(created.status, "the whole field was created").toBe(201);
  const ids = Object.fromEntries(FIELD.map((k, i) => [k, created.ids[i]!])) as Record<Who, string>;

  const fixtures = await leagueFixtures(request, div.id);
  expect(fixtures.length, "a round robin of four is six fixtures").toBe(MATCHES.length);
  for (const m of MATCHES) {
    const fx = fixtures.find(
      (f) =>
        (f.home_entrant_id === ids[m.w] && f.away_entrant_id === ids[m.l]) ||
        (f.home_entrant_id === ids[m.l] && f.away_entrant_id === ids[m.w]),
    );
    expect(fx, `no fixture pairs ${m.w} with ${m.l}`).toBeDefined();
    const winnerHome = fx!.home_entrant_id === ids[m.w];
    await post(request, fx!.id, "core.start", {});
    for (const [wp, lp] of m.games) {
      await post(request, fx!.id, "badminton.game.summary", winnerHome ? { home: wp, away: lp } : { home: lp, away: wp });
    }
  }

  seed = {
    hubPath: `/shared/${org.slug}/${competition.slug}`,
    divisionPath: `/shared/${org.slug}/${competition.slug}/${div.slug}`,
    ids,
  };
});

test.afterEach(async () => {
  // Never `finally`: a Playwright timeout skips it.
  await closeOpenContexts();
});

test.afterAll(async () => {
  await seedContext?.close().catch(() => {});
});

async function post(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown>) {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(state.status, `state of ${fixtureId}`).toBe(200);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type,
    payload,
  });
  expect(res.status, `${type} on ${fixtureId}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

// ── the two surfaces ─────────────────────────────────────────────────────────

/** Where each surface puts its triggers. The division page's testids are bare
 *  (`standings-tie-<id>`); the hub prefixes every testid with its table's own
 *  (`mh-table-<view id>-…`), which this spec does not know, so it anchors on
 *  the suffix. */
interface Surface {
  name: string;
  path: () => string;
  tie: (page: Page, who: Who) => Locator;
  ratio: (page: Page, who: Who) => Locator;
  setRatioCells: (page: Page) => Locator;
  /** Anything the surface needs before the ratio column is on screen. */
  ready: (page: Page) => Promise<void>;
}

const bySuffix = (page: Page, suffix: string) => page.locator(`[data-testid^="mh-table-"][data-testid$="${suffix}"]`);

const DIVISION: Surface = {
  name: "division page",
  path: () => `${seed.divisionPath}?tab=standings`,
  tie: (page, who) => page.getByTestId(`standings-tie-${seed.ids[who]}`),
  ratio: (page, who) => page.getByTestId(`standings-ratio-point_ratio-${seed.ids[who]}`),
  setRatioCells: (page) => page.locator('#panel-standings [data-testid^="standings-ratio-set_ratio-"]'),
  ready: async (page) => {
    await expect(page.locator("#panel-standings"), "?tab=standings opens the Standings panel").toBeVisible();
  },
};

const HUB: Surface = {
  name: "hub Table tab",
  path: () => `${seed.hubPath}?tab=table`,
  tie: (page, who) => bySuffix(page, `-tie-${seed.ids[who]}`),
  ratio: (page, who) => bySuffix(page, `-ratio-point_ratio-${seed.ids[who]}`),
  setRatioCells: (page) => page.locator('[data-testid^="mh-table-"][data-testid*="-ratio-set_ratio-"]'),
  ready: async (page) => {
    await expect(page.getByTestId("mh-tab-panel-table"), "?tab=table opened a different tab").toBeVisible();
    // Below `md` the ratio columns are the long tail, folded behind "Show all
    // columns". Open it where it is offered; from `md` up it is not rendered.
    const more = page.locator('[data-testid^="mh-table-"][data-testid$="-more"]');
    if (await more.isVisible()) await more.click();
  },
};

/** The panel a trigger opens: the element its `aria-controls` names. Read off
 *  the trigger rather than guessed from a testid, so a trigger wired to the
 *  wrong panel fails here. */
async function panelOf(trigger: Locator): Promise<Locator> {
  // Exactly one trigger, asserted on the expect clock: a missing one otherwise
  // hangs in `getAttribute` until the TEST budget and reports as a timeout.
  await expect(trigger, "no such popover trigger (or more than one)").toHaveCount(1);
  const id = await trigger.getAttribute("aria-controls");
  expect(id, "the trigger names no panel").toBeTruthy();
  return trigger.page().locator(`[id="${id}"]`);
}

async function expectOpen(trigger: Locator, panel: Locator): Promise<void> {
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
}

async function expectClosed(trigger: Locator, panel: Locator): Promise<void> {
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
}

/** Points inside `panel` that are NOT the panel when hit-tested — i.e. where
 *  something else is painted on top of it. Samples the corners (inset) and the
 *  centre, keeping only points inside the viewport; returns what was hit at
 *  each failure so a red names the culprit.
 *
 *  Deliberately does NOT scroll the panel into view: scrolling would scroll
 *  the table's own box too, and a panel hanging out of that box would be
 *  scrolled back INTO it — rescuing exactly the clip this exists to catch.
 *  The caller centres the TRIGGER before opening instead. */
async function coveredPoints(panel: Locator): Promise<{ sampled: number; covered: string[] }> {
  return panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inset = 3;
    const pts: [number, number][] = [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
      [r.left + r.width / 2, r.top + r.height / 2],
    ];
    const inView = pts.filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    const covered = inView
      .map(([x, y]) => ({ x, y, hit: document.elementFromPoint(x, y) }))
      .filter(({ hit }) => !(hit && el.contains(hit)))
      .map(({ x, y, hit }) => `${Math.round(x)},${Math.round(y)} → ${hit ? hit.outerHTML.slice(0, 90) : "nothing"}`);
    return { sampled: inView.length, covered };
  });
}

/** The panel sits wholly inside the table's scroll box. That box is
 *  `overflow-x-auto`, which computes `overflow-y: auto` too, so a panel
 *  hanging past its edge is CLIPPED — no z-index can paint what was cut. */
async function outsideScrollBox(panel: Locator): Promise<string | null> {
  return panel.evaluate((el) => {
    const box = el.closest('[role="region"]');
    if (!box) return "no enclosing scroll region";
    const p = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const slack = 0.5;
    if (p.top < b.top - slack || p.bottom > b.bottom + slack) {
      return `panel ${Math.round(p.top)}–${Math.round(p.bottom)} vs box ${Math.round(b.top)}–${Math.round(b.bottom)}`;
    }
    // The same clip seen from the box: a panel hanging past its bottom makes
    // it vertically scrollable (`overflow-y` computes to auto). Caught even if
    // something has scrolled the box to show the panel.
    if (box.scrollHeight - box.clientHeight > 1) {
      return `the open panel made its box scroll vertically (${box.scrollHeight} > ${box.clientHeight})`;
    }
    return null;
  });
}

async function open(browser: Browser, surface: Surface, width: number): Promise<Page> {
  const page = await spectator(browser, { width, height: 900 });
  await page.goto(surface.path(), { waitUntil: "load" });
  await surface.ready(page);
  return page;
}

for (const surface of [DIVISION, HUB]) {
  test.describe(surface.name, () => {
    test("the seed produced what this file reads: both ties on point ratio, the tied row last", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      // Every one of the four rows is tied — two pairs — so every rank is a
      // trigger, the last row's included. A seed that stopped tying would
      // leave the flip below untested and this is where it would say so.
      for (const who of FIELD) await expect(surface.tie(page, who), `${who} is not a tied row`).toHaveCount(1);
      const aPanel = await panelOf(surface.tie(page, "a"));
      await expect(aPanel).toHaveText(
        dictString("en", "table.tieBreak", {
          with: NAMES.b,
          rule: dictString("en", "table.tieBreak.point_ratio"),
        }),
        { useInnerText: false },
      );
    });

    test("an open tie-break note closes on a tap OUTSIDE it — the <details> it replaced never did", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      const trigger = surface.tie(page, "a");
      const panel = await panelOf(trigger);
      await expectClosed(trigger, panel);

      await trigger.click();
      await expectOpen(trigger, panel);
      // A tap on the panel itself is NOT outside: it stays open.
      await panel.click();
      await expectOpen(trigger, panel);
      // Outside, on the page's own heading — nothing interactive there.
      await page.locator("h1").first().click();
      await expectClosed(trigger, panel);

      // And outside INSIDE the table: another row's name cell.
      await trigger.click();
      await expectOpen(trigger, panel);
      await page.locator('th[scope="row"]').filter({ hasText: NAMES.d }).first().click();
      await expectClosed(trigger, panel);

      // Its own trigger still toggles it shut, as the <details> did.
      await trigger.click();
      await expectOpen(trigger, panel);
      await trigger.click();
      await expectClosed(trigger, panel);
    });

    test("Esc closes it and hands focus back to the trigger", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      const trigger = surface.tie(page, "b");
      const panel = await panelOf(trigger);
      // Opened from the KEYBOARD: focus, then Enter on the button.
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expectOpen(trigger, panel);
      // Move focus away first, so "focus returned" cannot be satisfied by
      // focus never having left.
      await page.locator("h1").first().click();
      await expectClosed(trigger, panel);
      await trigger.click();
      await expectOpen(trigger, panel);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expectClosed(trigger, panel);
      await expect(trigger, "Esc did not return focus to the trigger").toBeFocused();
    });

    test("opening the ratio popover closes the tie-break — by tap AND by keyboard", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      const tie = surface.tie(page, "a");
      const tiePanel = await panelOf(tie);
      const ratio = surface.ratio(page, "b");
      const ratioPanel = await panelOf(ratio);
      const openPanels = page.locator('[role="note"]:visible');

      // By tap: the tap on the ratio is an outside tap for the tie note.
      await tie.click();
      await expectOpen(tie, tiePanel);
      await ratio.click();
      await expectOpen(ratio, ratioPanel);
      await expectClosed(tie, tiePanel);
      await expect(openPanels, "more than one explanation on screen").toHaveCount(1);

      // By keyboard: no pointer event anywhere, so only the "another opened"
      // announcement can close the first one.
      await page.locator("h1").first().click();
      await expectClosed(ratio, ratioPanel);
      await tie.click();
      await expectOpen(tie, tiePanel);
      await ratio.focus();
      await page.keyboard.press("Enter");
      await expectOpen(ratio, ratioPanel);
      await expectClosed(tie, tiePanel);
      await expect(openPanels).toHaveCount(1);
    });

    test("every ratio popover states that row's own totals, and set ratio stays plain text", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      for (const who of FIELD) {
        const trigger = surface.ratio(page, who);
        const { won, lost } = totals(who);
        // The cell shows the ratio itself; the popover explains it.
        await expect(trigger).toHaveText((won / lost).toFixed(2));
        const panel = await panelOf(trigger);
        await trigger.click();
        await expectOpen(trigger, panel);
        await expect(panel).toHaveText(expectedNote(who));
        // Closed before the next: an open panel hangs over the row below and
        // takes the tap meant for that row's cell.
        await page.keyboard.press("Escape");
        await expectClosed(trigger, panel);
      }
      // Positive pairs above; the negative: set ratio has a ledger on every
      // row and still no trigger (its unit is "games" in badminton).
      await expect(surface.setRatioCells(page)).toHaveCount(0);
    });

    test("axe: no serious or critical violations in the table, closed and with each kind of popover open", async ({ browser }) => {
      const page = await open(browser, surface, 1280);
      // Scoped to the table's own region: the rest of the page is other specs'.
      const region = surface.tie(page, "a").locator('xpath=ancestor::*[@role="region"][1]');
      await expect(region).toHaveCount(1);
      const scan = async (state: string) => {
        const axe = await new AxeBuilder({ page }).include('[role="region"]').analyze();
        const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(
          bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
          `axe, ${state}`,
        ).toEqual([]);
        // Not vacuous: the scan really judged the triggers (button-name runs
        // on every button it found).
        const judged = [...axe.passes, ...axe.violations].find((r) => r.id === "button-name");
        expect(judged?.nodes.length ?? 0, `axe judged no buttons, ${state}`).toBeGreaterThan(0);
      };
      await scan("all closed");
      for (const trigger of [surface.tie(page, "a"), surface.ratio(page, "a")]) {
        const panel = await panelOf(trigger);
        await trigger.click();
        await expectOpen(trigger, panel);
        await scan(`with ${await trigger.getAttribute("data-testid")} open`);
        await page.keyboard.press("Escape");
        await expectClosed(trigger, panel);
      }
    });

    for (const width of [1280, 768, 320]) {
      test(`at ${width}: every row's open panel is painted on top and inside its box — first row down, last row up`, async ({ browser }) => {
        const page = await open(browser, surface, width);
        // EVERY row, in rank order a, b, d, c (see the seed): a is the first
        // row, c the last. The two between are not decoration — on the hub the
        // third row's panel, opened downward, ran 3px past the table's box
        // (found by a probe of every row after this test covered only the
        // first and last). Only the ends have a fixed direction; a row between
        // opens whichever way its panel fits.
        for (const [who, row] of [["a", "first"], ["b", "second"], ["d", "third"], ["c", "last"]] as const) {
          for (const kind of ["tie", "ratio"] as const) {
            const trigger = kind === "tie" ? surface.tie(page, who) : surface.ratio(page, who);
            const panel = await panelOf(trigger);
            // Centre the trigger while everything is closed (see coveredPoints).
            await trigger.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
            // The tap target is the cell's padding band, not the 20px of chip
            // or text: the button is stretched over the cell's vertical padding
            // (36px on the hub, 40px on the division page) without making the
            // row any taller. Hit-tested 17px above and below the centre of
            // what it shows — a band a 20px-tall button cannot answer for.
            const edgeMisses = await trigger.evaluate((btn) => {
              const b = btn.getBoundingClientRect();
              const x = b.left + b.width / 2;
              const mid = b.top + b.height / 2;
              return [mid - 17, mid + 17]
                .map((y) => ({ y, hit: document.elementFromPoint(x, y) }))
                .filter(({ hit }) => !(hit && btn.contains(hit)))
                .map(({ y, hit }) => `${Math.round(y)} → ${hit ? hit.outerHTML.slice(0, 80) : "nothing"}`);
            });
            expect(edgeMisses, `${kind} trigger on the ${row} row: a tap 17px off centre misses it`).toEqual([]);
            await trigger.click();
            await expectOpen(trigger, panel);

            const { sampled, covered } = await coveredPoints(panel);
            expect(sampled, `${kind} panel on the ${row} row: too few points on screen to judge`).toBeGreaterThanOrEqual(4);
            expect(covered, `${kind} panel on the ${row} row is painted over`).toEqual([]);
            expect(await outsideScrollBox(panel), `${kind} panel on the ${row} row is clipped by its box`).toBeNull();

            // Measured against the popover ROOT, not the button: the button's
            // hit area is stretched over the cell's padding by negative
            // margins, so the panel hangs from the chip/number it explains.
            const t = (await trigger.locator("xpath=..").boundingBox())!;
            const p = (await panel.boundingBox())!;
            if (row === "last") {
              expect(p.y + p.height, `the last row's ${kind} panel did not open upward`).toBeLessThanOrEqual(t.y + 0.5);
            } else if (row === "first") {
              expect(p.y, `the first row's ${kind} panel did not open downward`).toBeGreaterThanOrEqual(t.y + t.height - 0.5);
            }
            await expectNoHorizontalScroll(page);
            await page.keyboard.press("Escape");
            await expectClosed(trigger, panel);
          }
        }
        // Nothing in the table overhangs its own box (the house clip scan): the
        // stretched hit area must stay vertical, or the button reads as
        // clipped content at a phone width.
        const { clipped } = await overflowingIn(page, '[role="region"]', "*", "no table region on this page");
        expect(clipped, `content clipped inside the table at ${width}`).toEqual([]);
      });
    }
  });
}
