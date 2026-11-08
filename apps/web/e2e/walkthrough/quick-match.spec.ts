// WALKTHROUGH: Quick match. A guest with no account goes from the marketing page to a FINISHED quick match, and every
// step is tapped (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §4 and §5; plan 2's journey, owed under
// the owner's "each batch owns its walkthrough").
//
// One guest's browser (one context, so one visitor cookie), on a phone, through three journeys in order:
//   (A) a badminton LEAGUE of three, one side named with 40+ characters. Marketing page → "Quick match" → the setup
//       form → Start → the home → for EACH match: Score → Start match → every rally tapped on the pad until the match
//       is decided → "Back to the quick match" → the home read back (the winner-first result, the table, the next match).
//       At the end: three results, a table derived by hand from the rallies tapped, and the record agreeing.
//   (B) a badminton KNOCKOUT of three: the lone "Semi-final" (unnumbered) and the bye, the semi tapped, "Winner of the
//       semi-final" resolving to its winner's name, the final tapped, the champion on the draw.
//   (C) the marketing page's "Your recent quick matches": both matches, newest first; tapping one opens its home.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (README rule) ────────────────────────────────────────────────────────────
// There is NO reach here: nothing is seeded and no API is called. Every quick match is made through the setup form,
// every match is opened by the home's own Score, and every rally is a tap on the pad. The runner touches the database
// only to READ the record (`withDb`, as the other walkthroughs read it): the guest has no organiser session, so the
// organiser API cannot read a system-org fixture, and reading the record is the point.
//
// ── WHERE THE EXPECTED VALUES COME FROM ───────────────────────────────────────────────────────────────────────────
// - The match rules: the engine's own badminton module (`builtinModules`), the "short" variant under each stage
//   kind's defaults (`stageDefaultsFor`). The rally plans below are checked against those rules before a tap is made
//   (`checkPlan`): every game ends exactly at its target, before deuce, and the planned winner takes the match.
// - The points: the same module's `pointsMap`. The table is tallied in THIS file from the results tapped, never read
//   from the page first. Rank is by matches won (BWF 16.2.1, the module's `primaryTableKey`), and the final table is
//   built to be strict (2, 1, 0 wins), so no tie-break rung is needed to place it.
// - The match counts: a single round robin of n plays n(n-1)/2; a single knockout of n plays n-1.
// - Every sentence a person reads: the en dictionaries, never retyped. The level dash: the engine's `LEVEL_RANK`.
//
// ── EXTENSION POINTS ──────────────────────────────────────────────────────────────────────────────────────────────
// Share (plan 2 T7), Add a match (plan 2 T8) and Save (plan 3) are being built now and EXTEND this file. Each has a
// marked `EXTENSION POINT` below, at the place in the journey where it belongs, naming the state the page is in there.
// This file deliberately covers none of them.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEVEL_RANK } from "@seazn/engine/competition";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { expectNoHorizontalScroll, TAG, withDb } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { HUMAN_FASTEST_REPEAT_MS } from "../../src/components/v2/scorepad/use-pad-pipeline";
import { QUICK_MATCH_EXPIRY_DAYS } from "../../src/lib/quick-match-constants";

// One guest, one browser, three journeys in order: (C) reads what (A) and (B) made in THIS context.
test.describe.configure({ mode: "serial" });

// ── the product's words ─────────────────────────────────────────────────────────────────────────────────────────

type Dict = Record<string, string>;
type Vars = Record<string, string | number>;
const readDict = (rel: string): Dict => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Dict;
const UI = readDict("../../src/dictionaries/en/ui.json");
const MARKETING = readDict("../../src/dictionaries/en/marketing.json");

/** A dictionary line with its `{name}` slots filled; a missing key or slot throws rather than reading "undefined". */
function words(dict: Dict, key: string, vars: Vars = {}): string {
  const text = dict[key];
  if (typeof text !== "string") throw new Error(`the en dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`"${key}" needs {${name}}`);
    return String(vars[name]);
  });
}
const ui = (key: string, vars?: Vars) => words(UI, key, vars);
const mk = (key: string, vars?: Vars) => words(MARKETING, key, vars);
const EN_PLURAL = new Intl.PluralRules("en");
const plural = (say: (key: string, vars?: Vars) => string, key: string, count: number, vars: Vars = {}) =>
  say(`${key}.${EN_PLURAL.select(count)}`, { count, ...vars });

// ── the rules, from the engine ──────────────────────────────────────────────────────────────────────────────────

const SPORT = "badminton";
/** "Short (11 points)": the shortest badminton the setup form offers, so a whole match is ~25 taps, not ~45. */
const VARIANT = "short";
/** The rally event the badminton pad writes (setbased/badminton.ts; the badminton walkthrough reads the same type). */
const RALLY = "badminton.rally";

interface SetRules {
  bestOf: number;
  setTo: number;
  finalSetTo: number;
  winBy: number;
  cap: number;
  pointsMap: Record<string, [number, number]>;
}

/** The rules a quick match stage of `kind` plays: the variant's config under the stage kind's defaults, parsed by the
 *  module's own schema (defaults filled). Called inside a test, never at module scope: a load-time throw reports as
 *  zero collected tests rather than a red one (README). */
function rulesFor(kind: "league" | "knockout"): SetRules {
  const mod = builtinModules.find((m) => m.key === SPORT);
  expect(mod, `premise: the engine ships ${SPORT}`).toBeDefined();
  expect(Object.keys(mod!.variants), `premise: ${SPORT} declares the "${VARIANT}" variant`).toContain(VARIANT);
  const rules = mod!.configSchema.parse({ ...mod!.variants[VARIANT], ...stageDefaultsFor(mod!, kind, VARIANT) }) as SetRules;
  expect(rules.pointsMap["*"], "premise: badminton's table awards flat points for a win and a loss").toHaveLength(2);
  return rules;
}

/** One game, written from the MATCH winner's side: `[their points, the other side's points]`. `[6, 11]` is a game the
 *  match winner lost. */
type Game = readonly [number, number];

/** Guard the plan against the rules before a single tap: each game ends exactly at its target and before deuce (so the
 *  target alone closes it, never `winBy` or the cap), the planned winner takes exactly the games the match needs, takes
 *  the last one, and the other side never gets there first. A plan these rules cannot play fails here, by name. */
function checkPlan(rules: SetRules, games: readonly Game[], what: string): void {
  const need = Math.ceil(rules.bestOf / 2);
  let won = 0;
  let lost = 0;
  games.forEach(([w, l], i) => {
    const target = i === rules.bestOf - 1 ? rules.finalSetTo : rules.setTo;
    expect(Math.max(w, l), `${what}, game ${i + 1}: ends at its target`).toBe(target);
    expect(Math.min(w, l), `${what}, game ${i + 1}: ends before deuce`).toBeLessThanOrEqual(target - rules.winBy);
    expect(Math.max(w, l), `${what}, game ${i + 1}: under the cap`).toBeLessThanOrEqual(rules.cap);
    if (w > l) won += 1;
    else lost += 1;
    expect(lost, `${what}: the planned loser never takes the match`).toBeLessThan(need);
  });
  expect(won, `${what}: the planned winner takes exactly the games the match needs`).toBe(need);
  expect(games.at(-1)![0], `${what}: the last game is the winner's`).toBeGreaterThan(games.at(-1)![1]);
}

/** The finished score as the home reads it, winner first, game by game: matched on the NUMBERS in order, so a page
 *  that printed the home side first fails it whenever the winner played away (which the plans below guarantee). */
const winnerFirst = (games: readonly Game[]) => new RegExp(`^\\D*${games.map(([w, l]) => `${w}\\D+${l}`).join("\\D+")}\\D*$`);
const tapsOf = (games: readonly Game[]) => games.reduce((n, [w, l]) => n + w + l, 0);

// ── the budget (AGENTS.md #20): derived, never a flat literal ───────────────────────────────────────────────────

/** A page load, a redirect followed, or the record read back. */
const STEP_MS = 20_000;
/** A click, a fill, or a local assertion. */
const REACH_MS = 5_000;
/** One rally: the human floor between same-side taps, Playwright's click, the board's re-render. */
const TAP_MS = HUMAN_FASTEST_REPEAT_MS + 400;
/** One queued rally reaching the ledger while the pad drains behind the taps (one POST each). */
const SEND_MS = 500;
/** The deciding rally: soft-committed for HOLD_MS, sent, and the device chrome's re-read of the decided match. */
const DECIDE_MS = HOLD_MS + STEP_MS;
/** e2e.yml's job cap: one spec's ceiling must leave the leg room for the rest. */
const LEG_CAP_MS = 20 * 60_000;

/** Per match: Score → the pad, Back → the home, one reload of the home; Score, Start match, Back and a confirm; the
 *  ledger caught up before the deciding rally and the record read after it. */
const PER_MATCH = { navs: 3, acts: 4, reads: 2 } as const;

function budgetFor(c: { navs: number; acts: number; reads: number; plans: readonly (readonly Game[])[] }): number {
  const taps = c.plans.reduce((n, p) => n + tapsOf(p), 0);
  const matches = c.plans.length;
  return (
    (c.navs + matches * PER_MATCH.navs) * STEP_MS +
    (c.acts + matches * PER_MATCH.acts) * REACH_MS +
    (c.reads + matches * PER_MATCH.reads) * REACH_MS +
    taps * (TAP_MS + SEND_MS) +
    matches * DECIDE_MS
  );
}

function setBudget(budget: number): void {
  // The FIRST act of every test: a budget past the leg's cap would starve every other spec on the leg.
  expect(budget, "this journey's derived budget fits inside one e2e leg").toBeLessThan(LEG_CAP_MS);
  test.setTimeout(budget);
}

// ── the guest's phone ───────────────────────────────────────────────────────────────────────────────────────────

/** A guest's phone (the mobile-iphone14 reference width): the device a quick match is played on. */
const PHONE = { width: 390, height: 844 } as const;

let guest: BrowserContext | null = null;
let page: Page;

test.beforeAll(async ({ browser }, info) => {
  // No session (a guest), the cookie banner already answered (it would sit over the docked Start bar), and a phone.
  guest = await browser.newContext({
    storageState: await consentedAnonymousState(),
    baseURL: info.project.use.baseURL,
    viewport: PHONE,
  });
  page = await guest.newPage();
});

test.afterAll(async () => {
  await guest?.close();
});

// ── the setup form ──────────────────────────────────────────────────────────────────────────────────────────────

const form = (p: Page) => p.getByTestId("qm-setup-form");
/** A chip or a segment's visible face, by its words (the radios are sr-only; the existing setup spec's `choice`). */
const choice = (p: Page, text: string) => form(p).getByText(text, { exact: true });

interface Made {
  token: string;
  path: string;
  name: string;
  sides: string[];
}

/** The setup form, filled and started the way a guest does it: badminton, Singles, the sides typed, the format, the
 *  short rules. Lands on the home and returns its token. */
async function startQuickMatch(p: Page, name: string, sides: string[], format: "league" | "knockout", matches: number): Promise<Made> {
  await expect(form(p)).toBeVisible({ timeout: STEP_MS });
  // The island is live once blank rows hold Start disabled (the server's no-script Start is enabled): typing before
  // that would race React taking the inputs over.
  await expect(p.getByTestId("qm-start")).toBeDisabled();
  await choice(p, ui("sport.badminton")).click();
  await expect(form(p).getByRole("radio", { name: ui("sport.badminton"), exact: true })).toBeChecked();
  await choice(p, ui("quickMatch.kind.individual")).click();
  await expect(form(p).getByRole("radio", { name: ui("quickMatch.kind.individual"), exact: true })).toBeChecked();
  await form(p).getByLabel(mk("quickMatch.setup.nameLabel"), { exact: true }).fill(name);
  for (let n = 3; n <= sides.length; n += 1) await form(p).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
  for (const [i, side] of sides.entries()) {
    await form(p).getByLabel(mk("quickMatch.setup.sideLabel", { n: i + 1 }), { exact: true }).fill(side);
  }
  // Three sides put the format row on screen (D5); the guest picks the format by its words.
  await expect(p.getByTestId("qm-format-row")).toBeVisible();
  await choice(p, ui(`quickMatch.format.${format}`)).click();
  await expect(form(p).getByRole("radio", { name: ui(`quickMatch.format.${format}`), exact: true })).toBeChecked();
  const rules = form(p).locator('select[name="variant_key"]');
  await rules.selectOption(VARIANT);
  await expect(rules).toHaveValue(VARIANT);
  // Start counts what the format plays (a round robin's n(n-1)/2, a knockout's n-1).
  await expect(p.getByTestId("qm-start")).toContainText(plural(mk, "quickMatch.setup.startCount", matches));
  await expectNoHorizontalScroll(p);
  await p.getByTestId("qm-start").click();
  await p.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: STEP_MS });
  const path = new URL(p.url()).pathname;
  return { token: path.slice("/q/".length), path, name, sides };
}

// ── the home ────────────────────────────────────────────────────────────────────────────────────────────────────

const matchRow = (p: Page, fixtureId: string) => p.locator(`[data-testid="qm-match"][data-fixture-id="${fixtureId}"]`);
const tableRow = (p: Page, name: string) =>
  p.getByTestId("qm-standings-row").filter({ has: p.getByRole("rowheader", { name, exact: true }) });

/** The home re-read until `fixtureId` reads settled. The guest lands here from the pad; the read is the server's, and a
 *  reload is what a person does. It cannot mask a lost rally: nothing on the home sends what a pad still holds. */
async function expectSettledOnHome(p: Page, fixtureId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await matchRow(p, fixtureId)
          .getAttribute("data-state", { timeout: REACH_MS })
          .catch(() => null);
        if (state !== "settled") await p.reload();
        return state;
      },
      { timeout: STEP_MS, intervals: [250, 1_000, 2_000], message: `match ${fixtureId} never read as finished on the home` },
    )
    .toBe("settled");
}

// ── the pad ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Side = "home" | "away";
const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
const pad = (p: Page) => p.locator('[data-role="pad-v3"]');
/** A half, tappable or not (`data-side` is the skin's own, never its index). */
const half = (p: Page, s: Side) => pad(p).locator(`[data-role="v3-scorebug-half"][data-side="${s}"]`);
/** Scoped to `button`: a half that cannot be tapped renders a `<div>` in the same place, and a wildcard would click it. */
const tapTarget = (p: Page, s: Side) => pad(p).locator(`button[data-role="v3-scorebug-half"][data-side="${s}"]`);
/** A half's points: the figure under its name (the badminton walkthrough's `halfScore`). */
const points = (p: Page, s: Side) => half(p, s).locator(".app-display.font-bold");

/** Taps rallies at a scorer's real cadence. A same-side repeat waits out `HUMAN_FASTEST_REPEAT_MS` (the human floor
 *  R7-46 pinned, which clears the double-submit window by construction), never a clearance derived from that window. */
class Rallies {
  private last: Record<Side, number> = { home: Number.NEGATIVE_INFINITY, away: Number.NEGATIVE_INFINITY };
  tapped = 0;
  constructor(private readonly p: Page) {}
  async tap(side: Side): Promise<void> {
    const wait = HUMAN_FASTEST_REPEAT_MS - (Date.now() - this.last[side]);
    if (wait > 0) await this.p.waitForTimeout(wait);
    await tapTarget(this.p, side).click();
    this.last[side] = Date.now();
    this.tapped += 1;
  }
}

/** The ledger's rally count for one fixture: the record, never the pad's own fold. */
async function ralliesRecorded(fixtureId: string): Promise<number> {
  const [row] = await withDb(
    (sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = ${RALLY}`,
  );
  return row!.n;
}

interface Played {
  fixtureId: string;
  home: string;
  away: string;
  winner: string;
  loser: string;
  winnerSide: Side;
  games: readonly Game[];
  taps: number;
}

/**
 * The hero's match, played by hand: Score on the home, Start match on the Confirm card, every rally of `games` tapped,
 * then "Back to the quick match". `decide` names the winner from the two sides the hero shows.
 *
 * `leave`: "after-result" waits for the device page's own "Result recorded" before going back, as a guest who watches
 * the screen does; "at-once" taps Back straight after the deciding rally, while the pad still HOLDS it (soft-commit),
 * so the result reaches the home only if the back link sends what the pad holds before it navigates (pad-flush.ts).
 */
async function playHeroMatch(
  p: Page,
  made: Made,
  games: readonly Game[],
  decide: (home: string, away: string) => string,
  leave: "after-result" | "at-once",
): Promise<Played> {
  const next = p.locator('[data-testid="qm-match"][data-next="true"]');
  await expect(next, "the home offers exactly one match next").toHaveCount(1);
  const fixtureId = (await next.getAttribute("data-fixture-id"))!;
  expect(fixtureId).toMatch(/^[0-9a-f-]{36}$/);
  const home = (await p.getByTestId("qm-hero-home").textContent())!.trim();
  const away = (await p.getByTestId("qm-hero-away").textContent())!.trim();
  expect(made.sides, "the hero names two of this quick match's sides").toEqual(expect.arrayContaining([home, away]));
  expect(home, "the hero names two DIFFERENT sides").not.toBe(away);
  // The hero's match IS the row marked next (the record below is read by that row's fixture id).
  await expect(next.getByTestId("qm-match-sides"), "the row marked next is the hero's match").toContainText(home);
  await expect(next.getByTestId("qm-match-sides")).toContainText(away);
  const winner = decide(home, away);
  expect([home, away], "the plan's winner plays in this match").toContain(winner);
  const loser = winner === home ? away : home;
  const winnerSide: Side = winner === home ? "home" : "away";

  // ---- Score: the home's own form post, followed into the pad ----
  await p.getByTestId("qm-hero").getByTestId("qm-score").click();
  await p.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: STEP_MS });

  // ---- Confirm: WHICH match, home first, before anything can be scored ----
  const confirm = p.getByTestId("scan-confirm");
  await expect(confirm).toBeVisible({ timeout: STEP_MS });
  // The card reads "home vs away": the pad's home half is the hero's home side (the fixture's own seat).
  await expect(confirm).toContainText(`${home} ${ui("schedule.vs")} ${away}`, { useInnerText: true, ignoreCase: true });
  await expect(pad(p), "no pad before Start").toHaveCount(0);
  await expectNoHorizontalScroll(p);
  await p.getByTestId("score-start-match").click();
  await expect(pad(p), "Start opens the pad").toBeVisible({ timeout: STEP_MS });
  await expect(tapTarget(p, "home"), "a live match renders tappable halves").toBeVisible({ timeout: STEP_MS });
  await expect(tapTarget(p, "away")).toBeVisible();
  // What the halves call the sides, recorded for the run's reader (a read of the skin suggests a side with no members
  // falls back to "Home"/"Away"; this run says what a guest actually sees).
  test.info().annotations.push({
    type: "pad halves",
    description: `${await tapTarget(p, "home").getAttribute("aria-label")} | ${await tapTarget(p, "away").getAttribute("aria-label")}`,
  });

  // ---- Every rally, tapped ----
  const rallies = new Rallies(p);
  for (const [i, [w, l]] of games.entries()) {
    const gameWinner = w > l ? winnerSide : otherSide(winnerSide);
    const gameLoser = otherSide(gameWinner);
    const [hi, lo] = [Math.max(w, l), Math.min(w, l)];
    // Interleaved while the game's loser scores, then the winner's run to one short of the target.
    let won = 0;
    for (let k = 0; k < lo; k += 1) {
      await rallies.tap(gameLoser);
      if (won < hi - 1) {
        await rallies.tap(gameWinner);
        won += 1;
      }
    }
    while (won < hi - 1) {
      await rallies.tap(gameWinner);
      won += 1;
    }
    // The board before the closing rally: every tap of this game is on screen (none lost to the double-submit guard).
    await expect(points(p, gameWinner), `game ${i + 1}: one short of the target`).toHaveText(String(hi - 1));
    await expect(points(p, gameLoser)).toHaveText(String(lo));
    const last = i === games.length - 1;
    if (last) {
      // The deciding rally is the only one the guest may leave holding: everything before it is in the ledger first.
      await expect
        .poll(() => ralliesRecorded(fixtureId), {
          timeout: HOLD_MS + STEP_MS + rallies.tapped * SEND_MS,
          message: "the rallies tapped before the deciding one never all reached the ledger",
        })
        .toBe(rallies.tapped);
      await expect(pad(p).locator('[data-role="v3-rejection"]'), "no tap was refused").toHaveCount(0);
    }
    await rallies.tap(gameWinner);
    if (!last) {
      // The game closed and the next one opened at nothing: the closing rally landed.
      await expect(points(p, "home"), `game ${i + 2} opens at nothing`).toHaveText("0");
      await expect(points(p, "away")).toHaveText("0");
    }
  }
  expect(rallies.tapped, "every planned rally was tapped").toBe(tapsOf(games));

  // ---- Back to the quick match ----
  if (leave === "after-result") {
    await expect(p.getByText(ui("device.resultRecorded")), "the device page says the match is decided").toBeVisible({
      timeout: DECIDE_MS,
    });
    await expect(pad(p), "a decided match unmounts the pad").toHaveCount(0);
  }
  await p.getByTestId("quick-match-back-link").click();
  await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });
  await expectSettledOnHome(p, fixtureId);

  // ---- What a person reads: the result, winner first ----
  const row = matchRow(p, fixtureId);
  await expect(row.getByTestId("qm-match-sides")).toHaveText(ui("quickMatch.home.result", { winner, loser }));
  await expect(row.getByTestId("qm-match-score"), "the games read winner first").toHaveText(winnerFirst(games));
  return { fixtureId, home, away, winner, loser, winnerSide, games, taps: rallies.tapped };
}

// ── the record ──────────────────────────────────────────────────────────────────────────────────────────────────

const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

interface FixtureRecord {
  id: string;
  status: string;
  winner: string | null;
  home: string | null;
  away: string | null;
  rallies: number;
  rallies_by_link: number;
  links: number;
}

/** The quick match's fixtures and side names as the database holds them, found by the home token's hash (C19). */
async function recordOf(made: Made): Promise<{ fixtures: FixtureRecord[]; nameOf: Map<string, string> }> {
  return withDb(async (sql) => {
    const hash = tokenHash(made.token);
    const fixtures = await sql<FixtureRecord[]>`
      select f.id, f.status, f.outcome->>'winner' as winner, f.home_entrant_id as home, f.away_entrant_id as away,
             count(e.id) filter (where e.type = ${RALLY})::int as rallies,
             count(e.id) filter (where e.type = ${RALLY} and e.device_link_id is not null)::int as rallies_by_link,
             count(distinct e.device_link_id) filter (where e.type = ${RALLY})::int as links
      from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join fixtures f on f.division_id = d.id
      left join score_events e on e.fixture_id = f.id
      where q.token_hash = ${hash}
      group by f.id`;
    const entrants = await sql<{ id: string; display_name: string }[]>`
      select e.id, e.display_name from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join entrants e on e.division_id = d.id
      where q.token_hash = ${hash}`;
    return { fixtures: [...fixtures], nameOf: new Map(entrants.map((e) => [e.id, e.display_name])) };
  });
}

/** The record agrees with what was tapped: decided (a guest never finalizes), the planned winner, every rally in the
 *  ledger, and every one of them written through ONE device link (the guest has no session). */
async function expectRecorded(made: Made, played: readonly Played[]): Promise<number> {
  const { fixtures, nameOf } = await recordOf(made);
  let checked = 0;
  for (const m of played) {
    const f = fixtures.find((x) => x.id === m.fixtureId);
    expect(f, `the record holds match ${m.home} v ${m.away}`).toBeDefined();
    expect(f!.status, `${m.winner} beat ${m.loser}: the record says decided`).toBe("decided");
    expect(nameOf.get(f!.home!), "the record's home seat is the side the pad's home half scored for").toBe(m.home);
    expect(nameOf.get(f!.away!)).toBe(m.away);
    expect(f!.winner ? nameOf.get(f!.winner) : null, "the record's winner is the side the rallies were tapped for").toBe(m.winner);
    expect(f!.rallies, "every tapped rally is in the ledger, and nothing else").toBe(m.taps);
    expect(f!.rallies_by_link, "every rally was written through the guest's link").toBe(m.taps);
    expect(f!.links, "one link per match, reopened by Score, never a second").toBe(1);
    checked += 1;
  }
  expect(checked, "anti-vacuity: matches checked against the record").toBe(played.length);
  return checked;
}

// ── the league table, by hand ───────────────────────────────────────────────────────────────────────────────────

interface Tally {
  name: string;
  played: number;
  won: number;
  points: number;
}

/** The table the tapped results make: played, won, and points from the module's own `pointsMap`. Sorted by matches won
 *  (BWF 16.2.1); ties are left in side order and never placed by this function. */
function tableOf(sides: readonly string[], results: readonly Played[], rules: SetRules): Tally[] {
  const [win, loss] = rules.pointsMap["*"]!;
  const rows = sides.map((name) => ({ name, played: 0, won: 0, points: 0 }));
  for (const r of results) {
    const w = rows.find((x) => x.name === r.winner)!;
    const l = rows.find((x) => x.name === r.loser)!;
    w.played += 1;
    w.won += 1;
    w.points += win;
    l.played += 1;
    l.points += loss;
  }
  return [...rows].sort((a, b) => b.won - a.won);
}

const cellsOf = (t: Tally) => [String(t.played), String(t.won), String(t.points)];

/** Every side's row reads its tally (P, W, Pts: no D column, nothing was drawn), and a SOLE leader is placed first and
 *  marked. Places below a tie are the tie-break cascade's, which this walkthrough does not restate. */
async function expectTable(p: Page, table: readonly Tally[]): Promise<void> {
  let checked = 0;
  for (const t of table) {
    await expect(tableRow(p, t.name).getByTestId("qm-cell"), `${t.name}: P, W, Pts`).toHaveText(cellsOf(t));
    checked += 1;
  }
  expect(checked, "anti-vacuity: table rows checked").toBe(table.length);
  const top = table[0]!;
  if (top.won > 0 && table.filter((t) => t.won === top.won).length === 1) {
    await expect(tableRow(p, top.name).locator("td:first-child"), `${top.name} leads alone`).toHaveText("1");
    await expect(p.locator('[data-testid="qm-standings-row"][data-leader="true"]')).toHaveCount(1);
    await expect(tableRow(p, top.name)).toHaveAttribute("data-leader", "true");
  }
}

// ── the journeys ────────────────────────────────────────────────────────────────────────────────────────────────

/** A realistic long side name (AGENTS.md: the defect a short name hides): 40 characters before the run's tag. */
const LONG = `The Extraordinarily Long-Named Champion ${TAG}`;

let league: (Made & { results: Played[]; table: Tally[] }) | null = null;
let cup: (Made & { champion: string }) | null = null;

test("(A) a guest plays a badminton league of three from the marketing page to its final table, every rally tapped", async () => {
  const rules = rulesFor("league");
  const sides = [LONG, `Priya Raman ${TAG}`, `Jo Okafor ${TAG}`];
  expect(LONG.replace(` ${TAG}`, "").length, "premise: the long side is 40+ characters").toBeGreaterThanOrEqual(40);
  const total = (sides.length * (sides.length - 1)) / 2;
  // One score plan per match, in play order (the hero's order; which sides meet first is the generator's). The winner is
  // decided by NAME: the long side wins both its matches, and the match without it goes to its AWAY side, so at least
  // one result is read with the winner seated away (where winner-first and home-first differ). One plan runs to three
  // games, one of them lost by the match's winner.
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 3], [rules.setTo, 5]],
    [[rules.setTo, 0], [rules.setTo, 2]],
    [[rules.setTo, 4], [6, rules.setTo], [rules.finalSetTo, 8]],
  ];
  expect(plans, "one plan per match a round robin of three plays").toHaveLength(total);
  plans.forEach((g, i) => checkPlan(rules, g, `league match ${i + 1}`));
  setBudget(budgetFor({ navs: 3, acts: 16, reads: 2, plans }));

  // ---- 1. The marketing page's Quick match, to the setup page ----
  await page.goto("/en");
  const cta = page.getByTestId("qm-cta").getByRole("link", { name: mk("quickMatch.cta"), exact: true });
  await expect(cta).toBeVisible({ timeout: STEP_MS });
  await expectNoHorizontalScroll(page);
  await cta.click();
  await page.waitForURL((url) => url.pathname === "/en/play", { timeout: STEP_MS });

  // ---- 2. Badminton, League, three sides (one long), Start ----
  const made = await startQuickMatch(page, `QM walk league ${TAG}`, sides, "league", total);

  // ---- 3. The home: the hero, the three matches, a level table ----
  await expect(page.getByTestId("qm-name")).toHaveText(made.name);
  for (const part of [ui("sport.badminton"), ui("quickMatch.kind.individual"), ui("quickMatch.format.league")]) {
    await expect(page.getByTestId("qm-eyebrow")).toContainText(part);
  }
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", total, { played: 0, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total }));
  await expect(page.getByTestId("qm-match")).toHaveCount(total);
  await expect(page.locator('[data-testid="qm-match"][data-state="ready"]'), "every league match is ready to score").toHaveCount(total);
  await expect(page.getByTestId("qm-standings-row")).toHaveCount(sides.length);
  // Nothing counted yet: no leader and no place, the level dash on every row (its words are for a screen reader).
  await expect(page.locator('[data-testid="qm-standings-row"] td:first-child > [aria-hidden="true"]')).toHaveText(
    sides.map(() => LEVEL_RANK),
  );
  await expect(page.locator('[data-testid="qm-standings-row"][data-leader="true"]')).toHaveCount(0);
  for (const name of sides) await expect(tableRow(page, name).getByTestId("qm-cell")).toHaveText(["0", "0", "0"]);
  await expectNoHorizontalScroll(page);

  // ── EXTENSION POINT: Share (plan 2 T7) ──────────────────────────────────────────────────────────────────────────
  // The home as first created: nothing played, `made.path` is `/q/<token>`, the guest's visitor cookie is set. Share
  // goes HERE: open the home's share control, read the link it offers (never construct it), and follow it in a SECOND
  // context with no cookie (`browser.newContext({ storageState: await consentedAnonymousState() })`). That context must
  // NOT play a match unless it also appends to `results` below, or the table tallied by hand stops being true.

  // ---- 4 and 5. Each match: Score, every rally, Back, and the home read back ----
  const results: Played[] = [];
  for (const [k, games] of plans.entries()) {
    // The last match leaves at once, holding its deciding rally: the only browser proof that Back sends it first.
    const leave = k === plans.length - 1 ? "at-once" : "after-result";
    const played = await playHeroMatch(page, made, games, (h, a) => (h === LONG || a === LONG ? LONG : a), leave);
    results.push(played);
    const after = results.length;
    await expect(page.getByTestId("qm-played")).toHaveText(
      plural(ui, "quickMatch.home.played", total, { played: after, days: QUICK_MATCH_EXPIRY_DAYS }),
    );
    await expectTable(page, tableOf(sides, results, rules));
    if (after < total) {
      // The next match is offered: the hero names it, with its Score.
      await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: after + 1, total }));
      await expect(page.getByTestId("qm-hero").getByTestId("qm-score")).toBeVisible();
      await expect(page.locator('[data-testid="qm-match"][data-next="true"]')).toHaveAttribute("data-state", "ready");
    }
    expect(await expectRecorded(made, [played])).toBe(1);
  }
  expect(results, "anti-vacuity: every league match was played").toHaveLength(total);
  expect(
    results.filter((r) => r.winnerSide === "away").length,
    "anti-vacuity: at least one result was read with its winner seated away (winner-first is witnessed)",
  ).toBeGreaterThan(0);

  // ---- 6. The end: every match decided, the table the rallies made, the record agreeing ----
  const table = tableOf(sides, results, rules);
  expect(table.map((t) => t.won), "the plan makes a strict table: no tie-break is needed to place it").toEqual([2, 1, 0]);
  expect(table[0]!.name, "the long side won both its matches").toBe(LONG);
  await expect(page.locator('[data-testid="qm-match"][data-state="settled"]')).toHaveCount(total);
  await expect(page.getByTestId("qm-hero"), "nothing left to play: no Up next").toHaveCount(0);
  await expect(page.getByTestId("qm-winner-kicker")).toHaveText(ui("quickMatch.home.winner"));
  await expect(page.getByTestId("qm-winner-name")).toHaveText([LONG]);
  await expect(page.getByTestId("qm-standings-row").getByRole("rowheader")).toHaveText(table.map((t) => t.name));
  await expect(page.locator('[data-testid="qm-standings-row"] td:first-child')).toHaveText(table.map((_, i) => String(i + 1)));
  await expectTable(page, table);
  await expectNoHorizontalScroll(page);

  expect(await expectRecorded(made, results)).toBe(total);
  const { nameOf } = await recordOf(made);
  const stored = await withDb(
    (sql) => sql<{ rows: { entrantId: string; played: number; won: number; points: number; rank: number }[] }[]>`
      select s.rows from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join stages st on st.division_id = d.id
      join standings_snapshots s on s.stage_id = st.id and s.pool_id is null
      where q.token_hash = ${tokenHash(made.token)}`,
  );
  expect(stored, "one stored table for the league's one stage").toHaveLength(1);
  // The snapshot is stored IN ORDER (V218: "ordered StandingsRow[]"), and each row carries its rank: both are read.
  expect(
    stored[0]!.rows.map((r) => ({ name: nameOf.get(r.entrantId), played: r.played, won: r.won, points: r.points, rank: r.rank })),
    "the stored table is the one the rallies made",
  ).toEqual(table.map((t, i) => ({ name: t.name, played: t.played, won: t.won, points: t.points, rank: i + 1 })));

  // ── EXTENSION POINT: Add a match (plan 2 T8) ────────────────────────────────────────────────────────────────────
  // The league is finished: three results in `results`, the table in `table`, the winner card up. Add a match goes
  // HERE (league only, C5): add it through the home's control, play it with `playHeroMatch` (it becomes the hero), push
  // it onto `results`, and re-run `expectTable(page, tableOf(sides, results, rules))` and `expectRecorded`. The winner
  // card and the "n of 3" line move with it; re-derive them, never copy them off the page.

  // ── EXTENSION POINT: Save (plan 3) ──────────────────────────────────────────────────────────────────────────────
  // A finished league the guest may want to keep. Save goes HERE: Save on the home, its email, the played line's
  // "kept n days" wording once saved, and the stored row's expiry (quick_matches.expires_at by `tokenHash`). (C) below
  // reads this match in the recent strip: a saved match must still be listed, newest first.

  league = { ...made, results, table };
});

test("(B) a guest plays a badminton knockout of three: the bye, the semi-final, and the final, every rally tapped", async () => {
  expect(league, "(A) made this guest's first quick match").not.toBeNull();
  const rules = rulesFor("knockout");
  const sides = [`Kestrel Vance ${TAG}`, `Osprey Lindqvist ${TAG}`, `Merlin Achebe ${TAG}`];
  const total = sides.length - 1;
  // The semi goes to its AWAY side; the final to whoever came through the semi, so the champion is the name the
  // final's waiting seat had to resolve to.
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 2], [rules.setTo, 1]],
    [[rules.setTo, 6], [rules.setTo, 4]],
  ];
  expect(plans, "one plan per match a knockout of three plays").toHaveLength(total);
  plans.forEach((g, i) => checkPlan(rules, g, `knockout match ${i + 1}`));
  setBudget(budgetFor({ navs: 2, acts: 16, reads: 1, plans }));

  // ---- 1. The setup page again, where the first match is already listed ----
  await page.goto("/en/play");
  await expect(page.getByTestId("qm-recent"), "the setup page lists the league made in (A)").toContainText(league!.name);
  const made = await startQuickMatch(page, `QM walk cup ${TAG}`, sides, "knockout", total);

  // ---- 2. The draw: a lone, unnumbered Semi-final, a bye, and the final waiting on the semi ----
  await expect(page.getByTestId("qm-name")).toHaveText(made.name);
  await expect(page.getByTestId("qm-eyebrow")).toContainText(ui("quickMatch.format.knockout"));
  await expect(page.getByTestId("qm-standings"), "a knockout has no table").toHaveCount(0);
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", total, { played: 0, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  const draw = page.getByTestId("qm-draw");
  await expect(draw.getByTestId("qm-draw-card"), "the semi, the bye and the final").toHaveCount(3);
  await expect(draw.getByTestId("qm-draw-round")).toHaveText([ui("quickMatch.home.semiFinalOnly"), ui("bracket.round.final")]);
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNextRound", { round: ui("quickMatch.home.semiFinalOnly") }));
  const semiHome = (await page.getByTestId("qm-hero-home").textContent())!.trim();
  const semiAway = (await page.getByTestId("qm-hero-away").textContent())!.trim();
  const byeHolder = sides.find((s) => s !== semiHome && s !== semiAway);
  expect(byeHolder, "the side not in the semi-final has the bye").toBeDefined();
  const bye = draw.locator('[data-testid="qm-draw-card"][data-bye="true"]');
  await expect(bye).toContainText(ui("bracket.slot.bye"));
  await expect(bye.getByTestId("qm-draw-name")).toHaveText([byeHolder!]);
  const waiting = page.locator('[data-testid="qm-match"][data-state="waiting"]');
  await expect(waiting, "the final waits").toHaveCount(1);
  const finalId = (await waiting.getAttribute("data-fixture-id"))!;
  await expect(waiting).toContainText(ui("quickMatch.home.winnerOfTheSemi"));
  await expect(waiting.getByTestId("qm-score"), "no Score on a match whose sides are not known (C18)").toHaveCount(0);
  const finalCard = draw.locator(`[data-testid="qm-draw-card"][data-fixture-id="${finalId}"]`);
  await expect(finalCard).toContainText(ui("quickMatch.home.winnerOfTheSemi"));
  await expect(finalCard).toContainText(byeHolder!);
  await expectNoHorizontalScroll(page);

  // ---- 3a. The semi-final, tapped ----
  const semi = await playHeroMatch(page, made, plans[0]!, (_h, a) => a, "after-result");
  expect(semi.winnerSide, "the plan: the semi goes to its away side").toBe("away");
  expect(await expectRecorded(made, [semi])).toBe(1);

  // ---- 4a. "Winner of the semi-final" is now a name ----
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", total, { played: 1, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  const finalRow = matchRow(page, finalId);
  await expect(finalRow, "the final is ready once the semi is decided").toHaveAttribute("data-state", "ready");
  await expect(finalRow).toHaveAttribute("data-next", "true");
  await expect(finalRow).toContainText(semi.winner);
  await expect(finalRow).not.toContainText(ui("quickMatch.home.winnerOfTheSemi"));
  await expect(finalCard).not.toContainText(ui("quickMatch.home.winnerOfTheSemi"));
  await expect(finalCard.getByTestId("qm-draw-name"), "the final card names two sides").toHaveCount(2);
  const finalSeats = (await finalCard.getByTestId("qm-draw-name").allTextContents()).map((s) => s.trim());
  expect(finalSeats.sort(), "the final seats the bye holder and the semi's winner").toEqual([semi.winner, byeHolder!].sort());
  const semiCard = draw.locator(`[data-testid="qm-draw-card"][data-fixture-id="${semi.fixtureId}"]`);
  await expect(semiCard.locator('[data-testid="qm-draw-seat"][data-winner="true"]').getByTestId("qm-draw-name")).toHaveText(semi.winner);
  await expect(semiCard.getByTestId("qm-draw-seat-score")).toHaveText(winnerFirst(semi.games));
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNextRound", { round: ui("bracket.round.final") }));

  // ---- 3b. The final, tapped ----
  const final = await playHeroMatch(page, made, plans[1]!, (h, a) => {
    expect([h, a], "the final seats the bye holder and the semi's winner").toEqual(expect.arrayContaining([byeHolder!, semi.winner]));
    return semi.winner;
  }, "after-result");
  expect(final.fixtureId, "the final is the match that waited on the semi").toBe(finalId);

  // ---- 4b. The champion on the draw ----
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", total, { played: total, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  await expect(page.locator('[data-testid="qm-match"][data-state="settled"]')).toHaveCount(total);
  await expect(page.getByTestId("qm-hero"), "nothing left to play").toHaveCount(0);
  await expect(page.getByTestId("qm-winner-kicker")).toHaveText(ui("quickMatch.home.winner"));
  await expect(page.getByTestId("qm-winner-name")).toHaveText([semi.winner]);
  await expect(finalCard.locator('[data-testid="qm-draw-seat"][data-winner="true"]').getByTestId("qm-draw-name")).toHaveText(semi.winner);
  await expect(finalCard.getByTestId("qm-draw-seat-score")).toHaveText(winnerFirst(final.games));
  await expectNoHorizontalScroll(page);

  const { fixtures, nameOf } = await recordOf(made);
  const matches = fixtures.filter((f) => f.home !== null && f.away !== null);
  expect(matches, "the record holds the semi and the final, both seated (the bye has one side)").toHaveLength(total);
  expect(await expectRecorded(made, [semi, final])).toBe(total);
  expect(nameOf.get(fixtures.find((f) => f.id === finalId)!.winner!), "the record's champion").toBe(semi.winner);

  cup = { ...made, champion: semi.winner };
});

test("(C) the marketing page lists both quick matches, newest first, and a tap opens the home", async () => {
  expect(league, "(A) made the first quick match in this browser").not.toBeNull();
  expect(cup, "(B) made the second").not.toBeNull();
  setBudget(budgetFor({ navs: 2, acts: 6, reads: 0, plans: [] }));

  await page.goto("/en");
  const strip = page.getByTestId("qm-recent");
  await expect(strip).toBeVisible({ timeout: STEP_MS });
  await expect(strip.getByRole("heading")).toHaveText(mk("quickMatch.recent.title"));
  // Newest first: the knockout (B) was made after the league (A). Only this browser's two: the context is a new guest.
  const links = strip.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", cup!.path);
  await expect(links.nth(0)).toContainText(cup!.name);
  await expect(links.nth(1)).toHaveAttribute("href", league!.path);
  await expect(links.nth(1)).toContainText(league!.name);
  await expectNoHorizontalScroll(page);

  // The older one, tapped: its home, finished as (A) left it.
  await links.nth(1).click();
  await page.waitForURL((url) => url.pathname === league!.path, { timeout: STEP_MS });
  await expect(page.getByTestId("qm-name")).toHaveText(league!.name);
  await expect(page.getByTestId("qm-winner-name")).toHaveText([LONG]);
  await expect(page.locator('[data-testid="qm-match"][data-state="settled"]')).toHaveCount(league!.results.length);
});
