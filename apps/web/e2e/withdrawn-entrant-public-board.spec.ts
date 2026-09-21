// F10 (docs/superpowers/specs/2026-09-20-swiss-withdrawal-customer-walkthrough-findings.md):
// a withdrawn entrant on the PUBLIC board.
//
// The defect this file exists for was found by driving the product, not by a
// test: row 4 of a live public standings table read
//
//   4 · ?f8001cf4-f592-4b5e-a77c-c94520efed0f · 1 1 0 0 0 2
//
// A spectator was shown an internal UUID where a name belongs. The cause was
// `public_entrants_v` filtering `status in ('registered','confirmed')`: the
// standings snapshot is keyed by entrant id and built from RESULTS, so a
// withdrawal left her ROW standing while her NAME stopped being published, and
// `entrantNames[row.entrantId] ?? row.entrantId` fell through to the id.
//
// V412 widens that view and moves the "who is competing" question into the six
// consumers that actually ask it (`src/lib/entrant-field.ts`). That is two
// halves, and BOTH are proved here because each can regress without the other:
//
//   nameable everywhere a result mentions her  — standings, the chip, the
//                                                schedule, the embed
//   absent everywhere the question is the FIELD — the entrants tab
//
// TWO departures, not one. `inTheField` treats `withdrawn` and `disqualified`
// alike, but a spectator must not: one entrant LEFT, the other was REMOVED, and
// the board says which. `DEPARTED_STATUS_CHIPS` (standings-table.tsx) is the
// single place that decides, with a per-status testid precisely so a count here
// cannot be blind to the two being confused. So this file seeds both into ONE
// division and asserts they are told apart — different label, different paint —
// rather than that two chips exist.
//
// Why e2e and not a unit test. `apps/web` vitest is `environment: "node"`, so a
// green builder suite cannot see whether a page ever PASSES `entrantStatuses`
// to the table, nor whether the view actually publishes the row the page then
// reads. The chip was wired to this page once before,
// proved dead against the live view, and REMOVED rather than shipped inert
// (F10's own note). An inert seam is this repo's most-repeated failure, and it
// is only ever settled by driving the real producer and the real consumer — so
// everything below is seeded through the real API, withdrawn through the real
// `POST /api/v1/entrants/{id}/withdraw` route (never a `status = 'withdrawn'`
// UPDATE), and read out of a real browser as an anonymous spectator.
//
// Seeded in `beforeAll`, NOT as a serial test 1, and that is a deliberate
// reversal of this suite's usual shape. A `describe.serial` file aborts every
// test after the first red (AGENTS.md #21), which makes the LATER cases
// unkillable: during this file's own mutation sweep, a mutant that broke the
// standings aborted the schedule and embed cases, so neither could be shown to
// be anything but decoration. `beforeAll` runs once per WORKER and re-runs
// after the worker restart that follows a failure, so each case below stands or
// falls on its own — and the seed is ~2s, which is the whole cost of the
// change.
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  expectNoHorizontalScroll,
  overflowingIn,
  scoreFixture,
} from "./helpers";
import { centreHits, closeOpenContexts } from "./spectator-public-helpers";
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

/** The two departures and the field that stays. Order is load-bearing: the
 *  seed below takes ids back in this order. */
const QUITTER = `Ada Quitter ${TAG}`;
const EXPELLED = `Eve Expelled ${TAG}`;
const STAYERS = [`Bo Stayer ${TAG}`, `Cy Stayer ${TAG}`, `Di Stayer ${TAG}`];
const FIELD = [QUITTER, EXPELLED, ...STAYERS];
/** Which seeded name wears which chip. The STATUS strings are the product's
 *  (`EntrantStatus`), and `departedChips()` below reads the label and the paint
 *  for each straight out of the component. */
const DEPARTURES = [
  { name: QUITTER, status: "withdrawn" },
  { name: EXPELLED, status: "disqualified" },
] as const;

/** The word a spectator must READ for each status, and the dictionary key it
 *  comes from — both named HERE, on purpose.
 *
 *  `departedChips()` below reads the label key out of the component, which is
 *  right for "a new departure is covered automatically" and WRONG as the
 *  oracle for which word goes with which status: swap the two `label` keys in
 *  `DEPARTED_STATUS_CHIPS` and the expectation swaps with them, so this spec
 *  certified "Disqualified" printed on a withdrawal, in four locales, while
 *  staying green (independent mutation campaign C5, 2026-09-21). The
 *  expectation for a customer-visible word cannot come out of the table that
 *  decides it. */
const DEPARTED_COPY: Record<string, { key: string; en: string }> = {
  withdrawn: { key: "table.withdrawn", en: "Withdrawn" },
  disqualified: { key: "table.disqualified", en: "Disqualified" },
};

/** The house bar for UI work: desktop, the tablet fold, and the narrowest
 *  phone. 320 first so a failure names the width that actually hurts. */
const HOUSE_WIDTHS = [320, 768, 1280] as const;

/** Any canonical v4 UUID. This is the F10 defect itself, so it is asserted as
 *  an ABSENCE in every name cell rather than inferred from the name being
 *  present: a cell could carry both (a name plus a stray id) and a
 *  presence-only check would pass. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The StandingsTable's own rows.
 *
 *  `#panel-standings table tbody th[scope="row"]` is NOT this: the standings
 *  panel also holds the results CROSSTABLE (`results-matrix.tsx`, inside a
 *  collapsed `<details>` under each table), whose row headers carry the same
 *  scope — so the obvious selector resolved to 8 elements for a field of 4 and
 *  the count assertion below reads as a data defect. `standings-table.tsx`
 *  wraps its table in the named scroll `role="region"`; the crosstable's
 *  wrapper is a plain `div[data-results-matrix]`, so the region is what tells
 *  them apart. Child combinators throughout: a nested table must not creep in. */
const STANDINGS_ROWS = '[role="region"] > table > tbody > tr';
const STANDINGS_NAMES = `${STANDINGS_ROWS} > th[scope="row"]`;

/**
 * `DEPARTED_STATUS_CHIPS`, out of `standings-table.tsx`'s own source.
 *
 * READ rather than imported, the same choice `spectator-w2-kit.ts` records for
 * the product's clocks: importing the component pulls React, the dictionaries
 * and `@/lib/*` into a spec that must stay collectable. Read rather than
 * RETYPED because a table typed into a test asserts yesterday's answer — the
 * whole point of that export is that adding a departure is an edit in ONE
 * place, and this has to move with it.
 *
 * Throws on a miss, from inside a test: a module-scope throw collects zero
 * tests and reads as green.
 */
function departedChips(): Record<string, { label: string; classes: string[] }> {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/public-site/standings-table.tsx", import.meta.url)),
    "utf8",
  );
  const block = /export const DEPARTED_STATUS_CHIPS = \{([\s\S]*?)\n\} as const/.exec(src)?.[1];
  if (!block) throw new Error("DEPARTED_STATUS_CHIPS is no longer a literal in standings-table.tsx");
  const out: Record<string, { label: string; classes: string[] }> = {};
  for (const m of block.matchAll(/(\w+):\s*\{\s*label:\s*"([^"]+)",\s*className:\s*"([^"]+)"/g)) {
    out[m[1]!] = { label: m[2]!, classes: m[3]!.split(/\s+/).filter(Boolean) };
  }
  if (Object.keys(out).length === 0) throw new Error("DEPARTED_STATUS_CHIPS parsed to nothing");
  return out;
}

interface Seed {
  divisionPath: string;
  divisionId: string;
  quitterId: string;
  expelledId: string;
  /** How many fixtures name each departed entrant — DERIVED from the generated
   *  board, never a literal, so a change to the league generator moves this
   *  with it. */
  fixturesNaming: Record<string, number>;
}
let seed: Seed;
/** The seeding context. `browser.newContext()` inherits the project's signed-in
 *  storageState, so its `request` is the organiser; `spectator()` below is the
 *  one that deliberately does not. Closed in `afterAll`. */
let seedContext: BrowserContext | undefined;

/** ONE entrant's own name cell in the standings.
 *
 *  Not `filter` on the ROW: a tie-break `<details>` popover in another row's
 *  rank cell lists who that row is tied WITH, by name (`table.tieBreak`), so a
 *  rival's row carries her name too and a row filter resolves to two. The chip
 *  renders inside the `<th scope="row">`, which is the only place a name is its
 *  own. */
function nameCell(scope: Page | Locator, name: string): Locator {
  return scope.locator(STANDINGS_NAMES).filter({ hasText: name });
}

/** An anonymous spectator at desktop width, on `path`. The consent state is the
 *  kit's, so no cookie banner sits over the table. */
async function board(browser: Browser, path: string): Promise<Page> {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(path, { waitUntil: "load" });
  return page;
}

test.afterAll(async () => {
  // Never `finally`: a Playwright timeout skips it. `afterAll` still runs.
  await closeOpenContexts();
  await seedContext?.close().catch(() => {});
});

// A public league, two of her three games played, then the REAL withdrawal
// route with its fixture surgery. Everything the cases below read is produced
// by the product, never written into a table.
test.beforeAll(async ({ browser }) => {
  // Budget expressed in the harness's own per-call cost, so a slower machine —
  // or a longer seed — moves it instead of leaving a flat literal to rot
  // (AGENTS.md #20). Count: org, competition, division×2, entrants, stage,
  // generate, start, fixture list, withdraw = 10, plus two calls per scored
  // fixture (state read + event post).
  // A round robin is n(n-1)/2 fixtures and this seed leaves HALF the quitter's
  // own games unplayed and scores the rest, so the cost follows the field size
  // rather than a literal.
  const scored = (FIELD.length * (FIELD.length - 1)) / 2 - Math.floor((FIELD.length - 1) / 2);
  test.setTimeout(Math.max(FLOOR_MS, (10 + 2 * scored) * API_CALL_MS));

  seedContext = await browser.newContext();
  const request: APIRequestContext = seedContext.request;
  const org = await activeOrgSlug(request);
  const competition = await publicCompetition(request, {
    name: `Withdrawn board ${TAG}`,
    orgId: org.id,
  });
  const div = await division(request, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });

  const created = await addEntrantsViaApi(request, div.id, FIELD);
  expect(created.status, "the whole field was created").toBe(201);
  const [quitterId, expelledId] = [created.ids[0]!, created.ids[1]!];

  const fixtures = await leagueFixtures(request, div.id);
  const involving = (id: string) =>
    fixtures.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id);
  const hers = involving(quitterId);
  expect(hers.length, "a round robin pairs her with everyone else once").toBe(FIELD.length - 1);

  // The 50% rule is the engine's, not this test's: `withdrawTableEntrant`
  // EXPUNGES a table entrant who has played fewer than half their fixtures —
  // every game they touched voids and the standings read as if they never
  // entered, which would leave no row to name and nothing for this file to
  // assert. Exactly half played is not BELOW half, so the policy is AWARD: her
  // results stand and the games she never played walk over. Leaving fixtures
  // pending is deliberate — it makes the cascade do real surgery rather than
  // flipping a status.
  const unplayed = new Set(hers.slice(Math.ceil(hers.length / 2)).map((f) => f.id));
  for (const f of fixtures) if (!unplayed.has(f.id)) await scoreFixture(request, f.id, 2, 1);

  // Departure 1 — she LEAVES, through the route with the fixture surgery.
  const out = await apiJson<{ policy: string; walkovers: number; voided: number }>(
    request,
    `/api/v1/entrants/${quitterId}/withdraw`,
    "POST",
  );
  expect(out.status, JSON.stringify(out.error)).toBe(200);
  expect(out.data!.policy, "mid-tournament, not below half her fixtures: award, not expunge").toBe(
    "walkover",
  );
  expect(out.data!.walkovers, "every unplayed game of hers walked over").toBe(unplayed.size);
  expect(out.data!.voided, "the games she DID play stand — nothing was voided").toBe(0);

  // Departure 2 — she is REMOVED. There is no `/disqualify` route: the roster
  // editor's own red "Disqualify" control patches the status
  // (`entrants-panel.tsx` → `onPatch({ status })`), and `EntrantStatus` is the
  // schema that accepts it. Driving the same PATCH is driving the product; a
  // straight `update entrants set status` would not be.
  const dq = await apiJson<{ status: string }>(
    request,
    `/api/v1/entrants/${expelledId}`,
    "PATCH",
    { status: "disqualified" },
  );
  expect(dq.status, JSON.stringify(dq.error)).toBe(200);
  expect(dq.data!.status, "the roster editor's own patch is what removed her").toBe("disqualified");

  seed = {
    divisionPath: `/shared/${org.slug}/${competition.slug}/${div.slug}`,
    divisionId: div.id,
    quitterId,
    expelledId,
    fixturesNaming: { [QUITTER]: hers.length, [EXPELLED]: involving(expelledId).length },
  };
});

test("F10: the public standings print her NAME, never her entrant id", async ({ browser }) => {
  const page = await board(browser, `${seed.divisionPath}?tab=standings`);
  const panel = page.locator("#panel-standings");
  await expect(panel, "?tab=standings opens the Standings panel").toBeVisible();

  const nameCells = panel.locator(STANDINGS_NAMES);
  // A floor AND a ceiling, derived from the seeded field: an empty table would
  // satisfy every "no UUID anywhere" assertion below vacuously.
  await expect(nameCells, "one row per entrant, the departed one included").toHaveCount(
    FIELD.length,
  );

  const cells = await nameCells.allInnerTexts();
  for (const { name } of DEPARTURES) {
    expect(cells.some((c) => c.includes(name)), `no standings row names "${name}"`).toBe(true);
  }
  for (const cell of cells) {
    expect(cell, "a standings name cell printed a raw entrant id (this IS F10)").not.toMatch(
      UUID_RE,
    );
  }
  // Belt and braces on the ids that regressed: a future id format the regex
  // above stops matching must not quietly retire this assertion.
  const joined = cells.join(" | ");
  expect(joined, "the withdrawn entrant's own id reached the name column").not.toContain(
    seed.quitterId,
  );
  expect(joined, "the disqualified entrant's own id reached the name column").not.toContain(
    seed.expelledId,
  );
});

test("each departure is chipped, on its own row and no other", async ({ browser }) => {
  const page = await board(browser, `${seed.divisionPath}?tab=standings`);
  const panel = page.locator("#panel-standings");
  await expect(panel).toBeVisible();

  const chips = departedChips();
  for (const { name, status } of DEPARTURES) {
    const chip = chips[status];
    expect(chip, `DEPARTED_STATUS_CHIPS no longer declares "${status}"`).toBeDefined();

    // COUNT, not presence: "a chip exists somewhere" is equally satisfied by a
    // chip on every row, which is the opposite of what it means.
    const marked = page.getByTestId(`standings-${status}`);
    await expect(marked, `exactly one entrant is ${status} in this division`).toHaveCount(1);
    // The word is the product's own — the LABEL KEY comes from the component's
    // table and the string from the dictionary, so neither a copy change nor a
    // re-keying leaves this asserting yesterday's wording.
    await expect(marked).toHaveText(dictString("en", chip!.label));
    // …and the word that belongs to THIS status, named independently of that
    // table (see `DEPARTED_COPY`). Three links, each pinned: the component
    // points the status at its own key, the dictionary resolves that key to
    // the English word, and the chip on the board reads it.
    const copy = DEPARTED_COPY[status];
    expect(copy, `no expected wording is declared for "${status}"`).toBeDefined();
    expect(chip!.label, `"${status}" no longer points at ${copy!.key}`).toBe(copy!.key);
    expect(dictString("en", copy!.key), `${copy!.key} is no longer "${copy!.en}"`).toBe(copy!.en);
    await expect(marked, `a ${status} entrant must read "${copy!.en}"`).toHaveText(copy!.en);
    await expect(
      nameCell(panel, name).getByTestId(`standings-${status}`),
      `the ${status} chip is in ${name}'s own name cell`,
    ).toHaveCount(1);
  }

  // Nobody still competing wears one. Without this the loop above is satisfied
  // by a table that chips every row, as long as the counts happen to line up.
  for (const stayer of STAYERS) {
    await expect(
      nameCell(panel, stayer).locator('[data-testid^="standings-"]'),
      `"${stayer}" is still competing and must carry no departure chip`,
    ).toHaveCount(0);
  }
});

test("a withdrawal and a disqualification are TOLD APART — different word, different paint", async ({
  browser,
}) => {
  // The defect this case exists for is not a missing chip, it is two chips a
  // spectator cannot distinguish. `DEPARTED_STATUS_CHIPS` carries a distinct
  // label and a distinct className per status precisely so "she left" and "she
  // was removed" never read the same; labelling a disqualification "Withdrawn"
  // would be worse than the silence it replaced, because it would be wrong.
  const page = await board(browser, `${seed.divisionPath}?tab=standings`);
  const panel = page.locator("#panel-standings");
  await expect(panel).toBeVisible();

  const chips = departedChips();
  const declared = DEPARTURES.map(({ status }) => chips[status]!);

  // 1. The product's own declarations differ. A source-level guard: two
  //    statuses that resolved to one label or one class list could not be told
  //    apart however well the DOM renders them.
  const labels = declared.map((c) => dictString("en", c.label));
  expect(new Set(labels).size, `both departures print "${labels[0]}"`).toBe(labels.length);
  expect(
    new Set(declared.map((c) => c.classes.join(" "))).size,
    "both departures are painted with the same class list",
  ).toBe(declared.length);

  // 2. Those declarations reach the DOM — every token, on the right chip.
  //    A class present is not a class in effect, so (3) measures the paint.
  for (const [i, { status }] of DEPARTURES.entries()) {
    const chip = page.getByTestId(`standings-${status}`);
    for (const token of declared[i]!.classes) {
      await expect(chip, `the ${status} chip lost "${token}"`).toHaveClass(
        new RegExp(`(^|\\s)${token.replace(/[-/[\]]/g, "\\$&")}(\\s|$)`),
      );
    }
  }

  // 3. And a spectator SEES two different things. Computed, not classes:
  //    a token in the attribute proves nothing about what Tailwind emitted.
  const painted = async (status: string) =>
    page.getByTestId(`standings-${status}`).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
  const [left, right] = [await painted(DEPARTURES[0].status), await painted(DEPARTURES[1].status)];
  expect(left.bg, "the two departure chips paint the same background").not.toBe(right.bg);
  expect(left.fg, "the two departure chips paint the same text colour").not.toBe(right.fg);
});

test("the entrants tab drops BOTH departures, and still lists everyone competing", async ({
  browser,
}) => {
  const page = await board(browser, `${seed.divisionPath}?tab=entrants`);
  await expect(page.locator("#panel-entrants"), "?tab=entrants opens the Entrants panel").toBeVisible();

  const cards = page.locator("#panel-entrants > ul > li");
  await expect(cards, "the field is the three who stayed").toHaveCount(STAYERS.length);

  const texts = await cards.allInnerTexts();
  // The positive half is not decoration: without it an empty panel — a page
  // that fell over, a filter that refuses everyone — satisfies the negative.
  for (const name of STAYERS) {
    expect(texts.some((t) => t.includes(name)), `"${name}" is still competing and must be listed`).toBe(
      true,
    );
  }
  // `inTheField` accepts registered/confirmed only, so BOTH departures fail it —
  // and they fail it for the same reason, which is exactly why each is named
  // here: a filter narrowed to `status !== "withdrawn"` would pass the first of
  // these and quietly re-admit the second.
  for (const { name, status } of DEPARTURES) {
    expect(
      texts.some((t) => t.includes(name)),
      `the entrants tab is the FIELD — a ${status} entrant must not be listed as a current entrant`,
    ).toBe(false);
  }
});

test("the schedule still NAMES both departures in the matches they played", async ({ browser }) => {
  // The over-refusal guard. V412 put a status filter into six consumers at
  // once; an over-refusing one here drops a departed entrant from
  // `entrantNames` and `schedule.tsx` falls back to "?" for both sides of every
  // game she played — a symptom that LOOKS clean (no UUID, no crash) and
  // silently erases part of the division's history.
  const page = await board(browser, seed.divisionPath);
  const panel = page.locator("#panel-schedule");
  await expect(panel, "schedule is the default tab").toBeVisible();

  for (const { name } of DEPARTURES) {
    await expect(
      panel.locator("a").filter({ hasText: name }),
      `every fixture "${name}" appears in still carries her name`,
    ).toHaveCount(seed.fixturesNaming[name]!);
  }

  // `title` is the entrant-name span's own attribute (schedule.tsx), so this
  // hits the fallback exactly and cannot be satisfied by a stray "?" in prose.
  await expect(
    panel.locator('span[title="?"]'),
    'an unresolved side renders as "?" — no side on this board may',
  ).toHaveCount(0);
});

test("the embed standings widget names and marks both departures too", async ({ browser }) => {
  // A separate route with its own derivation (`embed/divisions/[id]/[widget]`),
  // reachable from inside any host site's iframe — the same defect here would
  // reproduce F10 on every page that embeds this division.
  const page = await board(browser, `/embed/divisions/${seed.divisionId}/standings`);

  const nameCells = page.locator(STANDINGS_NAMES);
  await expect(nameCells).toHaveCount(FIELD.length);
  const cells = await nameCells.allInnerTexts();
  for (const cell of cells) {
    expect(cell, "the embedded table printed a raw entrant id").not.toMatch(UUID_RE);
  }
  for (const { name, status } of DEPARTURES) {
    expect(cells.some((c) => c.includes(name)), `the embed names no "${name}"`).toBe(true);
    await expect(
      nameCell(page, name).getByTestId(`standings-${status}`),
      `the embed left "${name}" unmarked`,
    ).toHaveCount(1);
  }
});

test("both chips hold at 320, 768 and 1280 — reachable, readable, and no page scroll", async ({
  browser,
}) => {
  // The chips are new UI and nothing below 768 had ever rendered one: the
  // seven-width matrix (`mobile.spec.ts`) never seeds a division with a
  // departed entrant, so no width project has ever drawn this. See this file's
  // report for why the coverage landed here rather than there.
  const page = await spectator(browser, { width: HOUSE_WIDTHS[0], height: 900 });

  for (const width of HOUSE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${seed.divisionPath}?tab=standings`, { waitUntil: "load" });
    const panel = page.locator("#panel-standings");
    await expect(panel, `the standings panel at ${width}`).toBeVisible();

    for (const { name, status } of DEPARTURES) {
      const chip = nameCell(panel, name).getByTestId(`standings-${status}`);
      await expect(chip, `the ${status} chip is gone at ${width}`).toHaveCount(1);

      // The table is a deliberate horizontal RAIL below its content width, so
      // a chip can legitimately start outside the visible box — "reachable"
      // is the bar, not "already on screen". Scroll it in the way a spectator
      // would, then HIT-TEST it: `boundingBox()` measures paint, and a chip
      // painted under the sticky rank column is not one anybody can read.
      await chip.scrollIntoViewIfNeeded();
      await expect(chip, `the ${status} chip does not paint at ${width}`).toBeVisible();
      expect(
        await centreHits(page, `standings-${status}`),
        `the ${status} chip's own centre belongs to something else at ${width}`,
      ).toBe(true);
    }

    // The PAGE never scrolls sideways, at any of the three.
    await expectNoHorizontalScroll(page);

    // And the panel's own overflow is the reachable kind. A
    // `scrollWidth > clientWidth` scan cannot tell a swipeable rail from
    // content trapped in an `overflow-hidden` box; `overflowingIn` splits them
    // on computed `overflow-x`, which is the only thing that can.
    const { clipped, scrollable } = await overflowingIn(
      page,
      "#panel-standings",
      "*",
      "#panel-standings is not on this page",
    );
    expect(clipped, `content clipped inside the standings panel at ${width}`).toEqual([]);

    // Never let the exemption go unchecked: anything excused above as a rail
    // has to be one a KEYBOARD can reach, or the next overflow hides behind it.
    // Two assertions, because "reachable" has two legitimate shapes and only
    // one of them is this change's to own.
    //
    // (a) The box the chip actually lives in. `standings-table.tsx` gives its
    //     scroll region role + accessible name + tabindex, and it holds no
    //     focusable children at all, so tabindex is the ONLY thing making it
    //     reachable — pin all three, by name, on the box that carries the chip.
    const region = panel.locator('[role="region"]').filter({ has: page.locator("table") }).first();
    expect(
      await region.evaluate((el) => ({
        tabindex: el.getAttribute("tabindex"),
        named: (el.getAttribute("aria-label") ?? "").length > 0,
        overflowX: getComputedStyle(el).overflowX,
      })),
      `the standings scroll region at ${width}`,
    ).toEqual({ tabindex: "0", named: true, overflowX: "auto" });

    // (b) Every OTHER rail in the panel, judged by the gate that actually
    //     governs this — axe's `scrollable-region-focusable` — rather than by a
    //     second-hand tabindex rule of my own. The two differ, and the
    //     difference is the point: the results crosstable beside the table is
    //     `overflow-x-auto` with NO tabindex and still passes, because its
    //     fixture links are focusable and carry a keyboard through it. A
    //     hand-rolled `tabindex=` scan reds on that pre-existing surface and
    //     teaches the next reader to weaken the guard.
    if (scrollable.length > 0) {
      const axe = await new AxeBuilder({ page })
        .include("#panel-standings")
        .withRules(["scrollable-region-focusable"])
        .analyze();
      expect(
        axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))),
        `unreachable scrolling regions in the standings panel at ${width}`,
      ).toEqual([]);
      // And the scan was not vacuous: something overflowed, so the rule had at
      // least one node to judge. An axe run that evaluated nothing must not
      // collect a green here.
      expect(
        axe.passes.flatMap((v) => v.nodes).length,
        `axe judged no scrolling region at ${width} though ${scrollable.length} overflowed`,
      ).toBeGreaterThan(0);
    }
  }
});
