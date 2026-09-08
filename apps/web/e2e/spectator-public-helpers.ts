// Shared seeding, pad-driving and screenshot helpers for the Task 15
// spectator walkthrough (R7 + R10,
// docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md). Split out
// of the original combined `spectator-public.spec.ts` so BOTH walkthrough
// files below stay comfortably under Playwright's own per-run budget
// (AGENTS.md rule #20 — a blown budget misreports as a data defect):
//   - spectator-public.spec.ts   — the two cricket matches (A live, tapped
//     through the real v3 pad; B finished, band 2 player lines)
//   - spectator-public-2.spec.ts — football, tennis, consent, the
//     320-vs-1280 control-set diff, axe, screens, locale
// Neither spec file duplicates this code; both import from here. Adapted
// from the deleted `e2e/walkthrough/w0-spectator-capture.spec.ts` — see
// spectator-public.spec.ts's own header for the one real bug W0 carried
// (toss posted after core.start, swallowed by a non-throwing postEvent).
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { apiJson, screenshotAtWidths, setDivisionConfigSql } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { POLL_MS } from "../src/components/public-site/match-centre/use-live-fixture";

/** How long an R10 "the open page updates itself" assertion may wait.
 *
 *  `useLiveFixture` refreshes on a `setInterval(refresh, POLL_MS)` with no
 *  overlap guard, so the page's own worst case is not one interval: a tick
 *  whose fetch is still in flight when the next is due leaves the document
 *  untouched until the one AFTER it lands. `POLL_MS + 5_000` (1.3 intervals)
 *  therefore reds on a single missed tick — which is exactly how it failed:
 *  the 320 page sat at `36/0 (4.5)` reading "Updated 24s ago" while the
 *  ledger and the 1280 page both had the wicket. TWO intervals plus slack is
 *  the real budget, and deriving it from `POLL_MS` moves it if that constant
 *  ever moves (AGENTS.md rule #20 — a flat timeout beside a derived cost is a
 *  latent red).
 *
 *  This does not weaken any assertion: a page that never updates still fails,
 *  it just takes 35 s to say so instead of 20 s. */
export const LIVE_UPDATE_BUDGET_MS = 2 * POLL_MS + 5_000;

// `.` not `..`: this module lives at `e2e/` root, NOT in `e2e/walkthrough/`.
// It was moved out of that directory because Playwright's WALKTHROUGH pattern
// matches every file in it, so a helper there is classified as a test file and
// breaks collection for the whole project. The move silently relocated THIS
// path too — screenshots landed in `apps/web/__screens__/` beside `e2e/`,
// leaving the committed goldens in `e2e/__screens__/` untouched and a green
// run writing 48 files nobody would have diffed.
export const OUT = join(import.meta.dirname, "__screens__", "spectator-w1", "walkthrough");

// ---------------------------------------------------------------------------
// generic event helpers (adapted from w0-spectator-capture.spec.ts)
// ---------------------------------------------------------------------------

export async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; error?: unknown }> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  return { status: res.status, error: res.error };
}

export async function mustPost(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const r = await postEvent(request, fixtureId, type, payload);
  if (r.status >= 300) {
    throw new Error(`${type} -> ${r.status} ${JSON.stringify(r.error)} payload=${JSON.stringify(payload)}`);
  }
}

export async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

export async function createPerson(request: APIRequestContext, fullName: string, masked = false): Promise<string> {
  const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: fullName,
    consent: { public_name: !masked },
  });
  if (!p.data) throw new Error(`person "${fullName}" -> ${p.status} ${JSON.stringify(p.error)}`);
  return p.data.id;
}

export async function createPersons(request: APIRequestContext, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) ids.push(await createPerson(request, name, false));
  return ids;
}

export type Team = { name: string; entrantId: string; order: string[] };

/** Seeded LCG so a ledger is reproducible run to run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export type InningsOpts = {
  ballsPerInnings: number;
  playersPerSide: number;
  target?: number;
  /** Stop after this many legal balls (leave the innings open) — the LIVE case. */
  stopAtLegalBalls?: number;
  seed: number;
};

/**
 * Drive one innings through `cricket.ball` events. over/ballInOver are
 * DERIVED from legal balls exactly as the strict fold expects
 * (cricket.ts:1226): a wide re-bowls the same ball number.
 */
export async function playInnings(
  request: APIRequestContext,
  fixtureId: string,
  batting: Team,
  bowling: Team,
  opts: InningsOpts,
): Promise<{ runs: number; wickets: number; legalBalls: number }> {
  const rand = rng(opts.seed);
  const bowlers = bowling.order.slice(-4);
  let legalBalls = 0;
  let runs = 0;
  let wickets = 0;
  let striker = batting.order[0]!;
  let nonStriker = batting.order[1]!;
  let nextIn = 2;
  const allOutAt = opts.playersPerSide - 1;

  const swap = () => {
    const t = striker;
    striker = nonStriker;
    nonStriker = t;
  };

  while (
    legalBalls < opts.ballsPerInnings &&
    wickets < allOutAt &&
    (opts.target === undefined || runs < opts.target) &&
    (opts.stopAtLegalBalls === undefined || legalBalls < opts.stopAtLegalBalls)
  ) {
    const over = Math.floor(legalBalls / 6);
    const ballInOver = (legalBalls % 6) + 1;
    const bowler = bowlers[over % bowlers.length]!;
    const base = { over, ballInOver, striker, nonStriker, bowler };
    const r = rand();
    let payload: Record<string, unknown>;
    let legal = true;
    let batRuns = 0;
    let odd = false;
    if (r < 0.05) {
      payload = { ...base, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } };
      runs += 1;
      legal = false;
    } else if (r < 0.08) {
      payload = { ...base, runs: { bat: 0, extras: { kind: "bye", runs: 1 } } };
      runs += 1;
      odd = true;
    } else if (r < 0.14 && nextIn <= batting.order.length) {
      const kinds = ["bowled", "caught", "lbw", "runout", "stumped"] as const;
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      const fielders = bowling.order.filter((p) => p !== bowler);
      const fielder = fielders[Math.floor(rand() * fielders.length)]!;
      const wicket: Record<string, unknown> = { kind, out: striker, bowlerCredited: kind !== "runout" };
      if (kind === "caught" || kind === "stumped" || kind === "runout") wicket.fielder = fielder;
      const incoming = batting.order[nextIn];
      if (incoming) wicket.incoming = incoming;
      payload = { ...base, runs: { bat: 0 }, wicket };
      wickets += 1;
      if (incoming) {
        striker = incoming;
        nextIn += 1;
      }
    } else if (r < 0.44) {
      payload = { ...base, runs: { bat: 0 } };
    } else if (r < 0.74) {
      batRuns = 1;
      payload = { ...base, runs: { bat: 1 } };
      odd = true;
    } else if (r < 0.82) {
      batRuns = 2;
      payload = { ...base, runs: { bat: 2 } };
    } else if (r < 0.84) {
      batRuns = 3;
      payload = { ...base, runs: { bat: 3 } };
      odd = true;
    } else if (r < 0.95) {
      batRuns = 4;
      payload = { ...base, runs: { bat: 4 }, boundary: 4 };
    } else {
      batRuns = 6;
      payload = { ...base, runs: { bat: 6 }, boundary: 6 };
    }
    runs += batRuns;
    await mustPost(request, fixtureId, "cricket.ball", payload);
    if (legal) {
      legalBalls += 1;
      if (odd) swap();
      if (legalBalls % 6 === 0) swap();
    }
    if (opts.target !== undefined && runs >= opts.target) break;
  }
  return { runs, wickets, legalBalls };
}

export async function fixtureSides(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ home: string; away: string }> {
  const fx = await apiJson<{ home_entrant_id: string; away_entrant_id: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  if (!fx.data) throw new Error(`fixture ${fixtureId} -> ${fx.status}`);
  return { home: fx.data.home_entrant_id, away: fx.data.away_entrant_id };
}

export async function putLineups(request: APIRequestContext, fixtureId: string, teams: Team[]): Promise<void> {
  for (const t of teams) {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/lineups/${t.entrantId}`, "PUT", {
      slots: t.order.map((person_id, i) => ({ person_id, slot: "starting", order_no: i + 1, roles: [] })),
    });
    if (res.status >= 300) throw new Error(`lineup ${t.name} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

export async function divisionSlug(request: APIRequestContext, divisionId: string): Promise<string> {
  const res = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  if (!res.data) throw new Error(`division ${divisionId} -> ${res.status}`);
  return res.data.slug;
}

export function publicFixturePath(orgSlug: string, compSlug: string, divSlug: string, fixtureId: string): string {
  return `/shared/${orgSlug}/${compSlug}/${divSlug}/fixtures/${fixtureId}`;
}

export async function makeCricketDivision(
  request: APIRequestContext,
  compId: string,
  opts: { name: string; ballsPerInnings: number; playersPerSide: number },
): Promise<string> {
  const div = await apiJson<{ id: string; config: Record<string, unknown> }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    { name: opts.name, sport_key: "cricket", variant_key: "t20" },
  );
  if (!div.data) throw new Error(`division ${opts.name} -> ${div.status} ${JSON.stringify(div.error)}`);
  const divId = div.data.id;
  const cfg = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divId}`);
  // The t20 preset's own defaults (maxOversPerBowler: 4, minOversForResult: 5
  // -- cricket.ts:3256/:73) assume a 20-over innings. A shrunk division (the
  // "Consent" division below plays 12 balls -- 2 overs -- to keep its
  // deterministic script short) leaves those defaults BOTH exceeding the
  // innings length, which cricket.ts's own refinements reject outright
  // (`"maxOversPerBowler exceeds the innings length"` /
  // `"minOversForResult exceeds the innings length"`, cricket.ts:117-135) --
  // discovered live via a ZodError 500 ("Something went wrong") on the
  // Consent division's public page once match A's own seed bug (above) no
  // longer masked it by failing the suite first. Deriving both from the
  // ACTUAL innings length here keeps every division (48-ball and 12-ball
  // alike) internally consistent without every caller having to know this.
  const oversInInnings = Math.max(1, Math.floor(opts.ballsPerInnings / 6));
  await setDivisionConfigSql(divId, {
    ...(cfg.data?.config ?? {}),
    ballsPerInnings: opts.ballsPerInnings,
    playersPerSide: opts.playersPerSide,
    maxOversPerBowler: oversInInnings,
    minOversForResult: 0,
  });
  return divId;
}

export async function makeTeams(
  request: APIRequestContext,
  divisionId: string,
  teams: { name: string; names: string[] }[],
): Promise<Team[]> {
  const orders: string[][] = [];
  const bodies: Record<string, unknown>[] = [];
  for (const t of teams) {
    const ids = await createPersons(request, t.names);
    orders.push(ids);
    bodies.push({ kind: "team", display_name: t.name, seed: bodies.length + 1, members: ids.map((person_id) => ({ person_id })) });
  }
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", bodies);
  if (!ents.data || ents.data.length !== teams.length) {
    throw new Error(`entrants for division ${divisionId} -> ${ents.status} ${JSON.stringify(ents.error)}`);
  }
  return teams.map((t, i) => ({ name: t.name, entrantId: ents.data![i]!.id, order: orders[i]! }));
}

export async function startCricketMatch(
  request: APIRequestContext,
  fixtureId: string,
  teams: Team[],
  battingFirst: Team,
): Promise<void> {
  await putLineups(request, fixtureId, teams);
  await mustPost(request, fixtureId, "cricket.toss", { wonBy: battingFirst.entrantId, elected: "bat" });
  await mustPost(request, fixtureId, "core.start", {});
}

// ---------------------------------------------------------------------------
// v3 cricket pad helpers (tile ids pinned from scorepad-v3-cricket.spec.ts —
// never invented)
// ---------------------------------------------------------------------------

export function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

async function sendHeldNow(page: Page): Promise<void> {
  await pad(page).locator('[data-role="v3-dock"]').getByRole("button", { name: "Send now", exact: true }).click();
}

/** Every held ball dispatch (a run tile, an extra, a completed wicket sheet)
 *  opens the SAME `[data-role="v3-dock"]` — flushed here with "Send now"
 *  rather than waiting out `HOLD_MS`, the identical fast-path
 *  `scorepad-v3-cricket.spec.ts`'s own "dock chips"/"free hit" tests use.
 *  Still driven entirely through the real pad UI (R7) — only the WAIT is
 *  shortened, not the tap. */
async function flushHeld(page: Page): Promise<void> {
  const dock = pad(page).locator('[data-role="v3-dock"]');
  await expect(dock).toBeVisible({ timeout: 5_000 });
  await sendHeldNow(page);
  // Wait for the dock to actually clear before the next tile is tapped —
  // clicking "Send now" and immediately tapping the next tile (no wait at
  // all) raced the flush's own network round trip in an earlier run and
  // silently dropped a dispatch with no error either side of it.
  await expect(dock, "the dock must clear before the next tap").not.toBeVisible({ timeout: 10_000 });
}

export async function tapBallTile(page: Page, tileId: string): Promise<void> {
  await pad(page).locator(`[data-tile-id="${tileId}"]`).click();
  await flushHeld(page);
}

/** "Bowled" needs no further step (not in VARIABLE_OUT_KINDS or
 *  FIELDER_ELIGIBLE_KINDS, `skins/cricket.tsx:132,136`) — the simplest
 *  one-tap wicket the guided sheet offers. */
export async function tapWicketBowled(page: Page): Promise<void> {
  await pad(page).locator('[data-tile-id="wicket"]').click();
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await sheet.getByRole("button", { name: "Bowled", exact: true }).click();
  await flushHeld(page);
}

export async function pollBallCount(request: APIRequestContext, fixtureId: string, n: number, timeout: number): Promise<void> {
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === "cricket.ball").length, { timeout })
    .toBe(n);
}

// ---------------------------------------------------------------------------
// anonymous-context bookkeeping — closed in afterEach, never `finally`
// (a Playwright timeout skips `finally`, never `afterEach`)
// ---------------------------------------------------------------------------

export const openContexts: BrowserContext[] = [];

export async function anonPage(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState(), viewport });
  openContexts.push(ctx);
  return ctx.newPage();
}

export async function closeOpenContexts(): Promise<void> {
  while (openContexts.length > 0) {
    const ctx = openContexts.pop()!;
    await ctx.close().catch(() => {});
  }
}

/** Fix round 1 (task-15-review.md I4) — reuses the REAL pinned
 *  `screenshotAtWidths` (`../helpers.ts`), never a parallel reimplementation
 *  (one authority per behaviour), then copies its output out of Playwright's
 *  per-test `testInfo.outputPath()` (ephemeral, wiped between runs) into this
 *  walkthrough's own committed `__screens__/spectator-w1/walkthrough/`
 *  directory — the same convention Task 19's `more-sheet-{320,768}.png`
 *  already committed under `__screens__/spectator-w1/`. */
/** The rail scrolls its ACTIVE tab into view from both a selection effect and
 *  a `resize` listener, with `behavior: "smooth"` (`tab-rail.tsx:62`). A
 *  screenshot taken the instant after `setViewportSize` therefore catches the
 *  scroll mid-flight and freezes a CLIPPED active tab into the golden — which
 *  is what `match-a-tab-info-320.png` showed: an "Info" pill cut off by the
 *  viewport edge that a real visitor never sees. Wait for the tab to come to
 *  REST before every shot.
 *
 *  Failing here is the right outcome, not an inconvenience: if the rail truly
 *  cannot seat the active tab at this width, the visual gate must go red
 *  rather than hand the owner a golden that misrepresents the product. */
async function settleTabRail(page: Page): Promise<void> {
  const active = page.locator('[role="tab"][aria-selected="true"]');
  if ((await active.count()) === 0) return; // a page with no tab rail (or none selected yet)
  const viewportWidth = page.viewportSize()?.width ?? 0;
  await expect
    .poll(
      async () => {
        const box = await active.first().boundingBox();
        // +1px for sub-pixel float rounding, matching the width assertion in
        // spectator-public-2.spec.ts.
        return box !== null && box.x >= 0 && box.x + box.width <= viewportWidth + 1;
      },
      { timeout: 5_000, message: `the active tab must come to REST inside the ${viewportWidth}px viewport before the shot` },
    )
    .toBe(true);
}

export async function shotAtWidths(page: Page, testInfo: TestInfo, name: string, widths: number[]): Promise<void> {
  await screenshotAtWidths(page, testInfo, name, widths, settleTabRail);
  for (const width of widths) {
    copyFileSync(`${testInfo.outputPath()}/${name}-${width}.png`, join(OUT, `${name}-${width}.png`));
  }
}

/** Every tab a fixture's own document actually renders (discovered live from
 *  the DOM, never a hardcoded per-sport list — a band-2 or tennis fixture
 *  does not carry the same tab set as a band-3 cricket one), shot at every
 *  width via `shotAtWidths` above. */
export async function shotAllTabs(page: Page, testInfo: TestInfo, namePrefix: string, widths: number[]): Promise<void> {
  const tabIds = (
    await page.locator('[role="tab"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))
  ).filter((id): id is string => !!id);
  // A FLOOR, because this helper is the whole R11 sign-off's capture path and
  // it had a vacuous mode: if the page renders no tab rail — a failed load, a
  // selector rename, a document with `tabs: []` — this loop runs zero times,
  // writes zero screenshots, and BOTH "screens" tests still pass. AGENTS.md
  // #10 names exactly this: a visual gate that collected a sign-off on no
  // pictures. The COUNT is deliberately not pinned (a band-2 fixture
  // legitimately has fewer tabs than a band-3 one); only that there was
  // something to photograph at all.
  expect(
    tabIds.length,
    `${namePrefix}: no tabs found — this run would have written ZERO screenshots and still passed`,
  ).toBeGreaterThan(0);
  for (const testId of tabIds) {
    const id = testId.replace("mc-tab-", "");
    await page.getByTestId(testId).click();
    await expect(page.getByTestId(`mc-tab-panel-${id}`)).toBeVisible();
    await page.waitForTimeout(250); // settle CSS transitions (Task 14's own "two active tab pills" fix)
    await shotAtWidths(page, testInfo, `${namePrefix}-tab-${id}`, widths);
  }
}

/** Visible interactive controls, in DOM order — the same shape
 *  w0-spectator-capture.spec.ts's own `controlSet` used for its manifest,
 *  trimmed to what a 320-vs-1280 diff needs (R1: membership, order, repeats
 *  — never box size). */
export async function controlSet(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const label = (el: Element) =>
      (el.getAttribute("data-testid") || el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 64);
    return [...document.querySelectorAll('a[href],button,[role="tab"],input,select,summary')]
      .filter(visible)
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""}:${label(el)}`);
  });
}

/** Hit-test the CENTRE of a locator's box against `document.elementFromPoint`
 *  — a bounding box is paint, not proof a tap lands (AGENTS.md rule 11/#19). */
export async function centreHits(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return page.evaluate(
    ([id, x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return !!el && !!el.closest(`[data-testid="${id}"]`);
    },
    [testId, cx, cy] as const,
  );
}
