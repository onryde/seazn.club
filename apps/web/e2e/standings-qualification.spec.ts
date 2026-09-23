// Standings qualification status, end to end (spec 2026-09-22; plan Task 10).
//
// Driven through the REAL producer (the organiser API seeds the divisions and
// scores the matches, the standings fold runs on each result) and the REAL
// consumers (the public division page, the hub's Table tab, the organiser
// console). The unit suites pin which markup each builder emits; they run with
// no DOM and cannot see whether a page passes `qualification` to its table at
// all — the inert seam (AGENTS.md #1) is only settled here.
//
// Nothing expected below is typed. Every status is the ENGINE's own
// `qualificationStatus` over the organiser API's standings rows, with per-match
// bounds from the generic module's declaration over the division's own config
// as the API reads it back. Every string is the `public` dictionary's.
//
// The scene is chosen so the right answer differs from the wrong one (AGENTS.md
// #19). A Swiss of four, three rounds, two played, home always winning, reads
// 6 · 3 · 3 · 0 — and two rivals can still DRAW level with the leader. Under
// R4 (a rival who can draw level counts as one who can pass you) the leader
// shows "Win and in"; a `>` build would print "Through". The first test proves
// that premise from the rows before it believes a single marker.
//
// Also here: a groups stage (one cut line per POOL, after place 1), a league
// with no next stage (no marker, line or legend — the table exactly as before),
// console parity (the organiser sees the public STATUSES and MARKERS per
// entrant; its copy is the viewer's locale, the public page's the org's, so
// words are never compared), eight widths, and a cropped open/closed picture of
// each surface at 1280, 768 and 320 written to this test's output directory.
//
// Seeded in `beforeAll`, not as a serial test 1: a serial file aborts every
// case after the first red, which makes the later cases unkillable
// (`withdrawn-entrant-public-board.spec.ts` has the full reasoning).
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { qualificationStatus, type QualificationInput, type QualRowResult, type QualStatus } from "@seazn/engine/competition";
import { generic } from "@seazn/engine/sports/generic";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, scoreFixture } from "./helpers";
import { closeOpenContexts, openContexts } from "./spectator-public-helpers";
import { API_CALL_MS, FLOOR_MS, activeOrgSlug, dictString, division, publicCompetition, spectator } from "./spectator-w2-kit";

const CFG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
/** The Swiss: rounds declared, rounds played, places that go through. */
const ROUNDS = 3;
const PLAYED = 2;
const CUT = 2;
/** The groups stage: two pools of four (no byes, so round 1 gives every
 *  member a result — a pool with a member the snapshot never folded shows no
 *  status by design), the top one of each through. */
const POOLS = 2;
const POOL_SIZE = 4;
const POOL_CUT = 1;
const NEXT = "Finals";
const WIDTHS = [320, 360, 375, 390, 430, 768, 834, 1280] as const;

/** One long name, so the pictures show a wrapped row at 320. */
const SWISS_NAMES = ["Alder Park", "Harbour Shuttles", "Riverside Smash Badminton Club Seniors", "Kestrel"].map(
  (n) => `${n} ${TAG}`,
);

interface Fx {
  id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
interface StandingRow {
  entrantId: string;
  rank: number | null;
  points: number;
  played: number;
}
/** One standings table: its stage and pool, its cut, and how many matches
 *  each member plays in it all told. */
interface TableRef {
  stageId: string;
  poolId: string | null;
  cut: number;
  matches: number;
}
interface Scene {
  orgSlug: string;
  compSlug: string;
  swiss: { slug: string; table: TableRef };
  pools: { slug: string; tables: TableRef[] };
  plainSlug: string;
  perMatch: QualificationInput["perMatch"];
}
let scene: Scene;
let seedContext: BrowserContext | undefined;

const ok = (res: { status: number; error?: unknown }, what: string) =>
  expect(res.status, `${what}: ${JSON.stringify(res.error)}`).toBeLessThan(300);

async function fixturesOf(request: APIRequestContext, divisionId: string): Promise<Fx[]> {
  const res = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data ?? [];
}

async function standingRows(request: APIRequestContext, t: Pick<TableRef, "stageId" | "poolId">): Promise<StandingRow[]> {
  const q = t.poolId ? `?pool_id=${t.poolId}` : "";
  const res = await apiJson<{ rows: StandingRow[] }>(request, `/api/v1/stages/${t.stageId}/standings${q}`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data?.rows ?? [];
}

/** The standings fold runs after each result commits; the pages read the
 *  snapshot, and a snapshot that trails its fixtures shows no status. */
async function settle(request: APIRequestContext, t: Pick<TableRef, "stageId" | "poolId">, played: number): Promise<void> {
  await expect
    .poll(async () => (await standingRows(request, t)).reduce((n, r) => n + r.played, 0), { timeout: 30_000 })
    .toBe(played);
}

test.beforeAll(async ({ browser }) => {
  // competition 1; three divisions at two calls each, plus one config read;
  // five stages; three entrant posts; four generates; three starts; ~10
  // fixture lists; ten results at two calls each; ~8 standings polls.
  test.setTimeout(Math.max(FLOOR_MS, (1 + 7 + 5 + 3 + 4 + 3 + 10 + 20 + 8) * API_CALL_MS));
  seedContext = await browser.newContext();
  const request = seedContext.request;
  const org = await activeOrgSlug(request);
  const comp = await publicCompetition(request, { name: `Qualification ${TAG}`, orgId: org.id });
  const mkDiv = (name: string) => division(request, comp.id, { name, sport_key: "generic", variant_key: "score", config: CFG });
  const finals = (take: Record<string, unknown>) => ({
    seq: 2,
    kind: "knockout",
    name: NEXT,
    config: {},
    progression: { sources: [{ stage: "previous", take: [take] }], placement: "rank_order", timing: "on_complete" },
  });

  // 1. Swiss of four → Finals (places 1–2), two of three rounds played.
  const swissDiv = await mkDiv("Swiss open");
  const read = await apiJson<{ config: unknown }>(request, `/api/v1/divisions/${swissDiv.id}`);
  expect(read.data?.config, "the division's config reads back").toBeDefined();
  const perMatch = generic.matchPointsBounds(generic.configSchema.parse(read.data!.config));
  const swiss = await apiJson<{ id: string }>(request, `/api/v1/divisions/${swissDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: ROUNDS },
  });
  ok(swiss, "swiss stage");
  const swissId = swiss.data!.id;
  ok(await apiJson(request, `/api/v1/divisions/${swissDiv.id}/stages`, "POST", finals({ kind: "rankRange", from: 1, to: CUT })), "finals");
  const added = await addEntrantsViaApi(request, swissDiv.id, SWISS_NAMES);
  expect(added.status, "the Swiss field was created").toBe(201);
  ok(await apiJson(request, `/api/v1/divisions/${swissDiv.id}/start`, "POST"), "start swiss");
  for (let round = 1; round <= PLAYED; round++) {
    ok(await apiJson(request, `/api/v1/stages/${swissId}/generate`, "POST"), `pair round ${round}`);
    let seated: Fx[] = [];
    await expect
      .poll(
        async () => {
          seated = (await fixturesOf(request, swissDiv.id)).filter((f) => f.stage_id === swissId && f.round_no === round);
          return seated.filter((f) => f.home_entrant_id && f.away_entrant_id).length;
        },
        { timeout: 20_000, message: `round ${round} seats both boards` },
      )
      .toBe(SWISS_NAMES.length / 2);
    for (const f of seated) await scoreFixture(request, f.id, 2, 0);
  }
  const swissTable: TableRef = { stageId: swissId, poolId: null, cut: CUT, matches: ROUNDS };
  await settle(request, swissTable, SWISS_NAMES.length * PLAYED);

  // 2. Two pools of four → Finals (the top one of each), round 1 played.
  const poolDiv = await mkDiv("Pools open");
  const groups = await apiJson<{ id: string }>(request, `/api/v1/divisions/${poolDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "group",
    name: "Groups",
    config: { pools: { count: POOLS } },
  });
  ok(groups, "groups stage");
  const groupsId = groups.data!.id;
  ok(await apiJson(request, `/api/v1/divisions/${poolDiv.id}/stages`, "POST", finals({ kind: "topNPerGroup", n: POOL_CUT })), "pool finals");
  const poolField = Array.from({ length: POOLS * POOL_SIZE }, (_, i) => `Pool side ${i + 1} ${TAG}`);
  expect((await addEntrantsViaApi(request, poolDiv.id, poolField)).status, "the pools field was created").toBe(201);
  ok(await apiJson(request, `/api/v1/stages/${groupsId}/generate`, "POST"), "generate groups");
  ok(await apiJson(request, `/api/v1/divisions/${poolDiv.id}/start`, "POST"), "start pools");
  const poolFx = (await fixturesOf(request, poolDiv.id)).filter((f) => f.stage_id === groupsId);
  const poolIds = [...new Set(poolFx.map((f) => f.pool_id))];
  expect(poolIds, "two pools, each with an id").toHaveLength(POOLS);
  expect(poolIds.every((p) => typeof p === "string")).toBe(true);
  expect(poolFx, "a round robin of four per pool").toHaveLength(POOLS * ((POOL_SIZE * (POOL_SIZE - 1)) / 2));
  const firstRound = Math.min(...poolFx.map((f) => f.round_no));
  for (const f of poolFx.filter((x) => x.round_no === firstRound)) await scoreFixture(request, f.id, 2, 0);
  const poolTables: TableRef[] = poolIds.map((poolId) => ({ stageId: groupsId, poolId, cut: POOL_CUT, matches: POOL_SIZE - 1 }));
  for (const t of poolTables) await settle(request, t, POOL_SIZE);

  // 3. The regression: a league with NO next stage, round 1 played.
  const plainDiv = await mkDiv("Plain league");
  const league = await apiJson<{ id: string }>(request, `/api/v1/divisions/${plainDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  ok(league, "league stage");
  expect((await addEntrantsViaApi(request, plainDiv.id, ["L1", "L2", "L3", "L4"].map((n) => `${n} ${TAG}`))).status).toBe(201);
  ok(await apiJson(request, `/api/v1/stages/${league.data!.id}/generate`, "POST"), "generate league");
  ok(await apiJson(request, `/api/v1/divisions/${plainDiv.id}/start`, "POST"), "start league");
  const leagueFx = await fixturesOf(request, plainDiv.id);
  const leagueFirst = Math.min(...leagueFx.map((f) => f.round_no));
  for (const f of leagueFx.filter((x) => x.round_no === leagueFirst)) await scoreFixture(request, f.id, 2, 0);
  await settle(request, { stageId: league.data!.id, poolId: null }, 4);

  scene = {
    orgSlug: org.slug,
    compSlug: comp.slug,
    swiss: { slug: swissDiv.slug, table: swissTable },
    pools: { slug: poolDiv.slug, tables: poolTables },
    plainSlug: plainDiv.slug,
    perMatch,
  };
});

test.afterEach(async () => {
  // Never `finally`: a Playwright timeout skips it.
  await closeOpenContexts();
});

test.afterAll(async () => {
  await seedContext?.close().catch(() => {});
});

// ── What the engine says ─────────────────────────────────────────────────

interface Expected {
  input: QualificationInput;
  /** Standings row ids in rank order. */
  order: string[];
  res: ReadonlyMap<string, QualRowResult | null>;
  /** entrant id → status kind. */
  kinds: Record<string, string>;
}

async function engineFor(request: APIRequestContext, t: TableRef): Promise<Expected> {
  const rows = await standingRows(request, t);
  const input: QualificationInput = {
    rows: rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
    remaining: new Map(rows.map((r) => [r.entrantId, t.matches - r.played])),
    perMatch: scene.perMatch,
    cut: t.cut,
    anyPlayed: true,
    complete: false,
  };
  const res = qualificationStatus(input);
  expect(res, "premise: the engine gives this table a status").not.toBeNull();
  const kinds = Object.fromEntries([...res!].map(([id, r]) => [id, r?.status.kind ?? "none"]));
  const order = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((r) => r.entrantId);
  return { input, order, res: res!, kinds };
}

/** A status as the public dictionary words it (en). */
function statusText(s: QualStatus): string {
  switch (s.kind) {
    case "through":
      return dictString("en", "table.qual.status.through");
    case "win_k":
      return dictString("en", s.k === 1 ? "table.qual.status.winK.one" : "table.qual.status.winK.other", { count: s.k });
    case "needs_help":
      return dictString("en", "table.qual.status.needsHelp");
    case "out":
      return dictString("en", "table.qual.status.out");
  }
}

/** The cut line's words for a table the engine has read: the cut sentence
 *  agrees with N, the rounds left with the rounds (final review COPY — one
 *  key pluralised on the rounds printed "Top 1 go through"). */
function cutText(e: Expected, next: string): string {
  const n = e.input.cut;
  const left = Math.max(...e.order.map((id) => e.input.remaining.get(id) ?? 0));
  const cut = dictString("en", n === 1 ? "table.qual.cut.one" : "table.qual.cut.other", { n, next });
  if (left === 0) return cut;
  return `${cut} · ${dictString("en", left === 1 ? "table.qual.roundsLeft.one" : "table.qual.roundsLeft.other", { count: left })}`;
}

// ── What a page draws ────────────────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One table as drawn, in DOM order: each entrant row's id (off its row's or
 *  its rank trigger's test id), status (`data-qual`) and marker
 *  (`data-qual-marker`), and how many entrant rows sit ABOVE the cut line
 *  (-1: no line). Keyed by id, never by the name cell — the console draws a
 *  logo monogram into that cell, the public page may not. */
async function drawn(region: Locator) {
  return region.locator("table > tbody > tr").evaluateAll((trs, uuid) => {
    const re = new RegExp(uuid);
    const rows: { id: string; status: string; marker: string }[] = [];
    let cutAfter = -1;
    for (const tr of trs) {
      if (tr.getAttribute("data-testid") === "qual-cut") {
        cutAfter = rows.length;
        continue;
      }
      const tid = tr.getAttribute("data-testid") ?? tr.querySelector("button[aria-controls]")?.getAttribute("data-testid") ?? "";
      rows.push({
        id: re.exec(tid)?.[0] ?? `? ${tid}`,
        status: tr.getAttribute("data-qual") ?? "none",
        marker: tr.querySelector("[data-qual-marker]")?.getAttribute("data-qual-marker") ?? "none",
      });
    }
    return { rows, cutAfter };
  }, UUID.source);
}

/** `drawn` against the engine: the same rows in rank order, each row's status
 *  and marker the engine's kind, the line after place `cut`. */
function expectDrawnIsEngine(d: Awaited<ReturnType<typeof drawn>>, e: Expected, where: string) {
  expect(d.rows.map((r) => r.id), `${where}: rows in rank order`).toEqual(e.order);
  expect(Object.fromEntries(d.rows.map((r) => [r.id, r.status])), `${where}: statuses`).toEqual(e.kinds);
  expect(Object.fromEntries(d.rows.map((r) => [r.id, r.marker])), `${where}: markers`).toEqual(e.kinds);
  expect(d.cutAfter, `${where}: the line sits after place ${e.input.cut}`).toBe(e.input.cut);
}

const paths = {
  division: (slug: string) => `/shared/${scene.orgSlug}/${scene.compSlug}/${slug}?tab=standings`,
  hub: () => `/shared/${scene.orgSlug}/${scene.compSlug}?tab=table`,
  console: (slug: string) => `/o/${scene.orgSlug}/c/${scene.compSlug}/d/${slug}?tab=standings`,
};

/** Every standings box in the public division page's Standings panel. */
const regions = (page: Page) => page.locator('#panel-standings [role="region"]');
/** The standings box that carries a cut line — on the public page, inside its
 *  Standings panel; on the console (the same `StandingsTable`, no panel id),
 *  anywhere on the page. */
const withCut = (page: Page) => regions(page).filter({ has: page.getByTestId("qual-cut") });
const consoleWithCut = (page: Page) => page.locator('[role="region"]').filter({ has: page.getByTestId("qual-cut") });
/** The Swiss table on the hub's Table tab. */
const hubSwiss = (page: Page) =>
  page.locator(`section[data-testid="mh-table-${scene.swiss.slug}-${scene.swiss.table.stageId}-overall"]`);

/** Load `path` until `count(page)` reaches `want`. ISR can hand the first
 *  visitor a page rendered a moment before the last result folded. */
async function openUntil(page: Page, path: string, count: (page: Page) => Promise<number>, want: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(path, { waitUntil: "load" });
        return count(page);
      },
      { timeout: 45_000, intervals: [1_000, 5_000] },
    )
    .toBe(want);
}

/** A signed-in organiser's page at `width` (the project's storage state). */
async function organiser(browser: Browser, width: number, height = 900): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height } });
  openContexts.push(ctx);
  return ctx.newPage();
}

/** Open the popover behind `trigger` — re-tapping only while it is still
 *  closed, so a tap that lands before hydration is retried, never toggled. */
async function open(page: Page, trigger: Locator): Promise<Locator> {
  const panel = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
  await expect(async () => {
    if (!(await panel.isVisible())) await trigger.click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return panel;
}

/** `elementFromPoint` at the trigger's centre and `inset` px either side of
 *  it, both ways — each must land inside the button (a `boundingBox()` would
 *  measure paint, AGENTS.md #2). ±19.5 is what proves a 40px floor. */
async function hitTest(button: Locator, inset: number) {
  return button.evaluate((el, d) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const at = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && el.contains(hit);
    };
    return {
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      inside: [at(cx, cy), at(cx - d, cy), at(cx + d, cy), at(cx, cy - d), at(cx, cy + d)],
    };
  }, inset);
}

const pageWidths = (page: Page) =>
  page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth }));

// ── The division page ────────────────────────────────────────────────────

test("division page: every marker and status is the engine's, the line sits after place 2, and the leader is NOT Through (R4)", async ({
  browser,
  request,
}) => {
  const e = await engineFor(request, scene.swiss.table);

  // Premise, from the rows and not the function under test: the leader can be
  // passed by nobody but DRAWN level with by two — so `>` would print Through.
  const { input } = e;
  const leader = e.order[0]!;
  const me = input.rows.find((r) => r.entrantId === leader)!;
  const worst = me.points + input.remaining.get(leader)! * input.perMatch.min;
  const rivalsBest = input.rows
    .filter((r) => r.entrantId !== leader)
    .map((r) => r.points + input.remaining.get(r.entrantId)! * input.perMatch.max);
  expect(rivalsBest.filter((b) => b > worst).length, "premise: under `>` the leader is clear").toBeLessThan(CUT);
  expect(rivalsBest.filter((b) => b >= worst).length, "premise: under R4 two can still draw level").toBeGreaterThanOrEqual(CUT);
  expect(e.kinds[leader], "the engine reads the leader Win and in").toBe("win_k");
  expect(Object.values(e.kinds)).not.toContain("through");

  const page = await spectator(browser, { width: 1280, height: 900 });
  await openUntil(page, paths.division(scene.swiss.slug), (p) => withCut(p).count(), 1);
  const table = withCut(page);
  expectDrawnIsEngine(await drawn(table), e, "division page");
  // Scoped to THIS table's box and its wrapper: every table carries the same
  // test ids, so a page-wide count would pass on a neighbour.
  await expect(table.getByTestId("qual-cut")).toHaveCount(1);
  await expect(table.getByTestId("qual-cut")).toHaveText(cutText(e, NEXT));
  const legend = table.locator("xpath=..").getByTestId("qual-legend");
  await expect(legend).toHaveCount(1);
  await expect(legend).toContainText(dictString("en", "table.qual.legend.open"));
  await expect(legend).toContainText(dictString("en", "table.qual.legend.hint"));
  // The trigger names the status the marker only shows.
  const status = e.res.get(leader)!.status;
  await expect(table.getByRole("button", { name: /^Rank 1,/ })).toHaveAttribute(
    "aria-label",
    dictString("en", "table.qual.rankLabel", { rank: 1, status: statusText(status) }),
  );
});

test("division page: the leader's popover reads Win and in with the loss case, and closes on an outside tap and on Esc", async ({
  browser,
  request,
}) => {
  const e = await engineFor(request, scene.swiss.table);
  const leader = e.res.get(e.order[0]!)!;
  expect(leader.status.kind).toBe("win_k");
  expect(leader.ifYouLose, "premise: the engine has a loss case for the leader").not.toBeNull();

  const page = await spectator(browser, { width: 390, height: 844 });
  await openUntil(page, paths.division(scene.swiss.slug), (p) => withCut(p).count(), 1);
  const table = withCut(page);
  const trigger = table.getByRole("button", { name: /^Rank 1,/ });
  const panel = await open(page, trigger);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("qual-headline")).toHaveText(dictString("en", "table.qual.headline.winK.one", { next: NEXT }));
  await expect(panel.getByTestId("qual-if-lose")).toHaveText(
    dictString("en", "table.qual.ifYouLose", { status: statusText(leader.ifYouLose!) }),
  );

  // An outside tap: the legend, a plain paragraph under the box (a corner of
  // the page could be the header's home link).
  await table.locator("xpath=..").getByTestId("qual-legend").click({ position: { x: 4, y: 4 } });
  // The panel stays in the markup, `hidden` — never `toHaveCount(0)`.
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await open(page, trigger);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

// ── The hub ──────────────────────────────────────────────────────────────

test("hub Table tab: the Swiss table draws the engine's statuses and markers, its line after place 2 and its own legend", async ({
  browser,
  request,
}) => {
  const e = await engineFor(request, scene.swiss.table);
  const page = await spectator(browser, { width: 1280, height: 900 });
  await openUntil(page, paths.hub(), (p) => hubSwiss(p).getByTestId("qual-cut").count(), 1);
  await expect(page.getByTestId("mh-tab-panel-table"), "?tab=table opened a different tab").toBeVisible();
  const section = hubSwiss(page);
  expectDrawnIsEngine(await drawn(section.locator('[role="region"]')), e, "hub");
  await expect(section.getByTestId("qual-cut")).toHaveText(cutText(e, NEXT));
  await expect(section.getByTestId("qual-legend")).toHaveCount(1);
});

// ── Pools ────────────────────────────────────────────────────────────────

test("pools: each pool draws its own line after place 1 and its own legend, with the engine's statuses", async ({ browser, request }) => {
  const expected = await Promise.all(scene.pools.tables.map((t) => engineFor(request, t)));
  const page = await spectator(browser, { width: 1280, height: 900 });
  await openUntil(page, paths.division(scene.pools.slug), (p) => withCut(p).count(), POOLS);
  const boxes = await regions(page).all();
  expect(boxes, "one box per pool, nothing else").toHaveLength(POOLS);
  const seen = new Set<number>();
  for (const box of boxes) {
    const d = await drawn(box);
    // Which pool this box is: the one whose members it draws.
    const i = expected.findIndex((e) => [...e.order].sort().join() === d.rows.map((r) => r.id).sort().join());
    expect(i, "the box draws exactly one pool's members").toBeGreaterThanOrEqual(0);
    seen.add(i);
    expectDrawnIsEngine(d, expected[i]!, `pool ${i + 1}`);
    await expect(box.getByTestId("qual-cut")).toHaveCount(1);
    await expect(box.getByTestId("qual-cut")).toHaveText(cutText(expected[i]!, NEXT));
    await expect(box.locator("xpath=..").getByTestId("qual-legend")).toHaveCount(1);
  }
  expect(seen.size, "each pool drawn once").toBe(POOLS);
});

// ── No cut ───────────────────────────────────────────────────────────────

test("regression: a league with no next stage draws no marker, line, legend or status trigger", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  // Positive pair first: the table IS there, with every member folded.
  await openUntil(page, paths.division(scene.plainSlug), (p) => p.locator("#panel-standings [role=\"region\"] tbody tr").count(), 4);
  const panel = page.locator("#panel-standings");
  await expect(panel.getByTestId("qual-cut")).toHaveCount(0);
  await expect(panel.getByTestId("qual-legend")).toHaveCount(0);
  await expect(panel.locator("[data-qual-marker]")).toHaveCount(0);
  await expect(panel.locator("tr[data-qual]")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Rank \d+,/ })).toHaveCount(0);
});

// ── The console (R1a) ────────────────────────────────────────────────────

test("console parity (R1a): the organiser's table draws the public statuses and markers per entrant, and the engine's", async ({
  page,
  browser,
  request,
}) => {
  const e = await engineFor(request, scene.swiss.table);
  // `page` carries the project's signed-in organiser. Statuses and markers are
  // compared, never words: the console speaks the VIEWER's locale, the public
  // page the org's.
  await openUntil(page, paths.console(scene.swiss.slug), (p) => consoleWithCut(p).count(), 1);
  const organiserTable = await drawn(consoleWithCut(page));
  expectDrawnIsEngine(organiserTable, e, "console");
  await expect(consoleWithCut(page).getByTestId("qual-cut")).toHaveCount(1);
  await expect(consoleWithCut(page).locator("xpath=..").getByTestId("qual-legend")).toHaveCount(1);

  const pub = await spectator(browser, { width: 1280, height: 900 });
  await openUntil(pub, paths.division(scene.swiss.slug), (p) => withCut(p).count(), 1);
  expect(organiserTable, "the console and the public page draw the same table").toEqual(await drawn(withCut(pub)));
});

// ── Widths ───────────────────────────────────────────────────────────────

for (const width of WIDTHS) {
  test(`division page at ${width}: no sideways page scroll, closed or open; the rank trigger is a 40px target`, async ({ browser }) => {
    const page = await spectator(browser, { width, height: 900 });
    await openUntil(page, paths.division(scene.swiss.slug), (p) => withCut(p).count(), 1);
    await expectNoHorizontalScroll(page);
    const trigger = withCut(page).getByRole("button", { name: /^Rank 1,/ });
    const hit = await hitTest(trigger, width < 768 ? 19.5 : 0);
    expect(hit.inside, `a tap misses the trigger (${hit.width}×${hit.height})`).toEqual([true, true, true, true, true]);
    await open(page, trigger);
    await expectNoHorizontalScroll(page); // an open popover must not widen the page
  });
}

// ── Pictures: each surface at 1280, 768 and 320, closed and open ─────────

/** Scroll so `block` starts 120px down the viewport, clear of the sticky
 *  site header and tab rail. */
async function frame(block: Locator): Promise<void> {
  await block.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
}

/** The viewport clip around `boxes`, padded — never `fullPage`, which paints
 *  a fixed panel at its viewport offset inside a taller image. */
async function clipAround(page: Page, boxes: Locator[]) {
  const rects = (await Promise.all(boxes.map((b) => b.boundingBox()))).filter((r) => r !== null);
  expect(rects, "a box to crop around has no layout").toHaveLength(boxes.length);
  const { width: vw, height: vh } = page.viewportSize()!;
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  expect(top, "the picture would start above the viewport").toBeGreaterThanOrEqual(0);
  expect(bottom, "the picture would end below the viewport").toBeLessThanOrEqual(vh);
  const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - 8);
  const y = Math.max(0, top - 8);
  const right = Math.min(vw, Math.max(...rects.map((r) => r.x + r.width)) + 8);
  return { x, y, width: right - x, height: Math.min(vh, bottom + 8) - y };
}

/** Rank 1's popover open, then closed, pictured through the SAME clip — so
 *  the two images can only differ by what the popover paints. */
async function pictureOpenAndClosed(page: Page, block: Locator, trigger: Locator, name: string) {
  const info = test.info();
  await frame(block);
  const panel = await open(page, trigger);
  await expect(panel.getByTestId("qual-headline")).toBeVisible();
  const clip = await clipAround(page, [block, panel]);
  const openShot = await page.screenshot({ path: info.outputPath(`${name}-open.png`), clip });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  // Esc hands focus back to the button; the closed picture is the table at
  // rest, not a focus ring.
  await trigger.evaluate((el) => (el as HTMLElement).blur());
  const closedShot = await page.screenshot({ path: info.outputPath(`${name}-closed.png`), clip });
  expect(openShot.equals(closedShot), `${name}: the open picture is the closed one`).toBe(false);
}

for (const width of [1280, 768, 320] as const) {
  test(`pictures, division page at ${width}: the rank-1 popover open and closed`, async ({ browser }) => {
    const page = await spectator(browser, { width, height: 900 });
    await openUntil(page, paths.division(scene.swiss.slug), (p) => withCut(p).count(), 1);
    const table = withCut(page);
    await pictureOpenAndClosed(page, table.locator("xpath=.."), table.getByRole("button", { name: /^Rank 1,/ }), `division-${width}`);
    await expectNoHorizontalScroll(page);
  });

  test(`pictures, hub Table tab at ${width}: the rank-1 popover open and closed`, async ({ browser }) => {
    const page = await spectator(browser, { width, height: 900 });
    await openUntil(page, paths.hub(), (p) => hubSwiss(p).getByTestId("qual-cut").count(), 1);
    const section = hubSwiss(page);
    await pictureOpenAndClosed(page, section, section.getByRole("button", { name: /^Rank 1,/ }), `hub-${width}`);
    await expectNoHorizontalScroll(page);
  });

  test(`pictures, console at ${width}: the rank-1 popover open and closed, no sideways scroll, a 40px trigger`, async ({ browser }) => {
    const page = await organiser(browser, width);
    await openUntil(page, paths.console(scene.swiss.slug), (p) => consoleWithCut(p).count(), 1);
    const table = consoleWithCut(page);
    const trigger = table.getByRole("button", { name: /^Rank 1,/ });
    const widths = await pageWidths(page);
    expect(widths.scrollWidth, "the console scrolls sideways").toBeLessThanOrEqual(widths.innerWidth);
    await expectNoHorizontalScroll(page);
    const hit = await hitTest(trigger, width < 768 ? 19.5 : 0);
    expect(hit.inside, `a tap misses the trigger (${hit.width}×${hit.height})`).toEqual([true, true, true, true, true]);
    await pictureOpenAndClosed(page, table.locator("xpath=.."), trigger, `console-${width}`);
    await expectNoHorizontalScroll(page);
    console.log(`MEASURED console ${width} ${JSON.stringify({ ...widths, hit })}`);
  });
}

test("pictures, pools page at 320: both pools, each with its line and legend, and pool 1's rank-1 popover", async ({ browser }) => {
  const page = await spectator(browser, { width: 320, height: 1400 });
  await openUntil(page, paths.division(scene.pools.slug), (p) => withCut(p).count(), POOLS);
  await expectNoHorizontalScroll(page);
  const blocks = (await regions(page).all()).map((r) => r.locator("xpath=.."));
  await frame(blocks[0]!);
  const shot = test.info().outputPath("pools-320-closed.png");
  await page.screenshot({ path: shot, clip: await clipAround(page, blocks) });
  const trigger = regions(page).first().getByRole("button", { name: /^Rank 1,/ });
  const panel = await open(page, trigger);
  await page.screenshot({ path: test.info().outputPath("pools-320-open.png"), clip: await clipAround(page, [...blocks, panel]) });
  await expectNoHorizontalScroll(page);
});
