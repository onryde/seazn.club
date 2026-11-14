// WALKTHROUGH: Quick match. A guest with no account goes from the marketing page to a FINISHED quick match, and every
// step is tapped (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §4 and §5; plan 2's journey, owed under
// the owner's "each batch owns its walkthrough").
//
// One guest's browser (one context, so one visitor cookie), on a phone, through three journeys in order:
//   (A) a badminton LEAGUE of three, one side named with 40+ characters. Marketing page → "Quick match" → the setup
//       form → Start → the home → for EACH match: Score → Start match → every rally tapped on the pad until the match
//       is decided → "Back to the quick match" → the home read back (the winner-first result, the table, the next match).
//       Before the first match, Share (plan 2 T7): Copy puts the home's link on the clipboard, Show QR draws its QR,
//       and the copied link opens the same home in a second browser with no cookie.
//       The match between the two short-named sides is then CORRECTED (branch-fix A review I1): Edit result in its row's ⋯ →
//       the pad's decided screen (the quick match's own line, review Q2) → "Void my last entry" → the match reopens one
//       rally short → every rally tapped for the OTHER side until it has the match → Back → the corrected result and table.
//       At the end: three results, a table derived by hand from the rallies tapped, and the record agreeing.
//       Then Add a match (plan 2 T8, C5): "+ Add a match" on the finished home → its two selects open at the table's top
//       two → "Add the match" → the winner card gives way to the new match as Up next (4 of 4) → it is played like the
//       others → the table, the winner and the record read back with four results, the fourth stored as an ad-hoc match.
//   (B) a second badminton LEAGUE, of two sides, each pair playing once: its one match, every rally tapped, goes to its
//       away side → the winner card, the table of two and the record read back. (A guest's quick match is a league since
//       the owner's 2026-11-12 "take out"; the knockout journey that stood here returns with League + Knockout.)
//   (C) the marketing page's "Your recent quick matches": both matches, newest first; tapping one opens its home.
//   (D) Save (plan 3 Task 5), in a browser of its own (plan 2 m6: not inside (A)): a guest who typed an address on a new
//       league taps Save on its home → the sign-in, carrying the save page → signs in as a DIFFERENT person → the save page
//       → Save → the home reads "Saved" and no longer counts down; the record holds the saver and forgets the typed
//       address. A second guest on the same link sees neither Save nor Saved; the save page says it is saved to an account
//       and offers Sign in back to itself (review m2: a signed-out visitor may be the saver on another device).
//       Then the account's Quick matches (plan 3 Task 6, spec §7.7): the saver taps the saved home's "In your account" →
//       /me#quick-matches → the match is its one row, its name a link to the home → Rename → the new name on the row, in the record (all four names, the slug kept) and on
//       the home its link opens → "In your account" again → Delete → the confirmation → "Delete for everyone" → the row and the section are gone,
//       the record is gone, and the link is the dead screen for the second guest and the saver alike.
//   (E) Not played (plan 4 Task 6), in a browser of its own: a night where matches can't be played. A league of three: its
//       first match played; its second left part-way (a few rallies), then from its row's ⋯ menu "Not played" → the sheet
//       (the score it had, the body that says it can be put back) → "Keep this match" changes nothing → again, "Mark not
//       played" → the row reads Not played, the line "1 not played", the table untouched; the setup page's Continue card
//       says the same; "Put back" → the row live at the score it had → Score resumes the pad there → the match finished; then
//       the last match skipped (the sheet says the league finishes now) → the winner, "1 match was not played", the Final
//       table, no Put back. A second league, of two, has its only match skipped → "No matches were played", no table, and
//       "Start a new quick match" back to the setup page, which offers neither league to continue.
//   (F) League + Knockout (plan 5 Task 9), each night in a browser of its own. (F1) Four friends pick League → Semi-finals
//       → Final (Start counts the league and the knockout), play the league by taps, and the bracket is drawn from the
//       start, waiting on places. Before the league's last result the record holds the knockout's fill (`holdKnockout`),
//       so the home reads "Setting up the knockout" with Refresh; released, Refresh fills it from the table, 1st v 4th and
//       2nd v 3rd, above the table. (F2) The semi-finals and the final, by taps: each winner moves into the final, and the
//       champion is the final's winner (a side the table put last). (F3) Three sides, each pair twice, steered so 2nd and
//       3rd are level on everything: the question ("Tie for 2nd"), the engine's lot already stored. (F4) Toss → the stored
//       lot's side in the final, the same after a reload, and on a friend's phone that taps Toss again (someone already
//       decided). Each reads the record too. Each night is two tests because each half's derived budget must fit one leg.
//   (G) The season door (start wizard plan 2026-11-13, Task 6), in a browser of its own: under the setup's Start, "Or
//       register to start a season" names the sport the chips chose (Tennis, not the default) → the organiser's /start
//       wizard opens on Tennis → a League of six, the first day not decided → the address → Sent, whose quick match link
//       is on Tennis too → the claim link → the division: one League stage and six seeded players, no first day.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (README rule) ────────────────────────────────────────────────────────────
// There is NO reach here: nothing is seeded and no API is called. Every quick match is made through the setup form,
// every match is opened by the home's own Score, and every rally is a tap on the pad. The runner touches the database
// only to READ the record (`withDb`, as the other walkthroughs read it): the guest has no organiser session, so the
// organiser API cannot read a system-org fixture, and reading the record is the point. The one write is (F1)'s hold: a
// trigger that refuses one knockout's fill for as long as the walkthrough needs to see "Setting up", dropped in a `finally`
// (nothing a guest can do makes that fill fail, and the screen it owes is the thing under test).
//
// ── WHERE THE EXPECTED VALUES COME FROM ───────────────────────────────────────────────────────────────────────────
// - The match rules: the engine's own badminton module (`builtinModules`), the "short" variant under each stage
//   kind's defaults (`stageDefaultsFor`). The rally plans below are checked against those rules before a tap is made
//   (`checkPlan`): every game ends exactly at its target, before deuce, and the planned winner takes the match.
// - The points: the same module's `pointsMap`. The table is tallied in THIS file from the results tapped, never read
//   from the page first. Rank is by matches won (BWF 16.2.1, the module's `primaryTableKey`), and the final table is
//   built to be strict (2, 1, 0 wins), so no tie-break rung is needed to place it.
// - The match counts: a single round robin of n plays n(n-1)/2.
// - Every sentence a person reads: the en dictionaries, never retyped. The level dash: the engine's `LEVEL_RANK`.
//
// ── EXTENSION POINTS ──────────────────────────────────────────────────────────────────────────────────────────────
// Share (plan 2 T7), Add a match (plan 2 T8) and Save (plan 3) EXTEND this file, each at a marked `EXTENSION POINT`
// below, at the place in the journey where it belongs, naming the state the page is in there. Share (step 3b) and Add a
// match (step 7) are filled in; Save is its own journey, (D), in its own browser (plan 2 m6).
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEVEL_RANK } from "@seazn/engine/competition";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { expectNoHorizontalScroll, loginUi, overflowingIn, TAG, withDb } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { waitForHydration } from "../directory-kit";
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

/** The rules a quick match plays: the variant's config under the league stage's defaults (a quick match is a league,
 *  owner 2026-11-12), parsed by the module's own schema (defaults filled). Called inside a test, never at module scope: a
 *  load-time throw reports as zero collected tests rather than a red one (README). */
function leagueRules(): SetRules {
  return stageRules("league");
}
/** The same, under a stage kind's own defaults: a League + Knockout's knockout lines play the knockout stage's (plan 5). */
function stageRules(kind: "league" | "knockout"): SetRules {
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

/** A correction made through Edit result (review I1), derived from the rules, never typed. "Void my last entry" undoes the
 *  deciding rally, which leaves the last game one short of its target for the match's winner (`held`); the OTHER side then
 *  takes every rally until it has the match. The reopened game closes at the first score that is past the target AND
 *  `winBy` clear of `held` (or at the cap); each game the other side still needs is taken to nothing. `corrected` is the
 *  match from the NEW winner's side, game by game, as the home must read it. */
interface Correction {
  held: number;
  from: number;
  closesAt: number;
  extra: readonly number[];
  corrected: readonly Game[];
  taps: number;
}
function correctionOf(rules: SetRules, games: readonly Game[]): Correction {
  const need = Math.ceil(rules.bestOf / 2);
  const targetOf = (i: number) => (i === rules.bestOf - 1 ? rules.finalSetTo : rules.setTo);
  const last = games.length - 1;
  const [w, from] = games[last]!;
  const held = w - 1;
  const closesAt = Math.min(rules.cap, Math.max(targetOf(last), held + rules.winBy));
  expect(closesAt, "the reopened game closes on the other side's rally, past the old winner").toBeGreaterThan(held);
  expect(closesAt - held >= rules.winBy || closesAt === rules.cap, "…clear by winBy, or at the cap").toBe(true);
  const corrected: Game[] = [...games.slice(0, last).map(([a, b]): Game => [b, a]), [closesAt, held]];
  const extra: number[] = [];
  while (corrected.filter(([a, b]) => a > b).length < need) {
    const target = targetOf(corrected.length);
    corrected.push([target, 0]);
    extra.push(target);
  }
  expect(corrected.length, "the corrected match fits the rules' best-of").toBeLessThanOrEqual(rules.bestOf);
  expect(corrected.filter(([a, b]) => b > a).length, "the old winner never has the match back").toBeLessThan(need);
  return { held, from, closesAt, extra, corrected, taps: closesAt - from + extra.reduce((n, t) => n + t, 0) };
}

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
/** A correction (review I1) costs what a match does: Edit result → the pad, Back → the home, a reload; Edit result, Void,
 *  Back and a check; the void and the ledger read back. So the budget counts it as one more plan of its own rallies. */
/** Share (step 3b): the QR drawn (its encoder and logo load on the tap) and the second browser's page load; Copy, the
 *  clipboard read, Show QR and its close. */
const SHARE = { navs: 2, acts: 4 } as const;
/** Add a match (step 7): the post's 303 back to the home; the disclosure opened, the two selects read, their targets
 *  measured, the submit, and the home read back; the ad-hoc row and the stored table read from the record. Its match is
 *  one more plan, counted with the others. */
const ADD = { navs: 1, acts: 6, reads: 2 } as const;

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
/** (F)'s night, in a browser of its own: (F1) plays the league and (F2) the knockout it filled, in the same browser. */
let koNight: { ctx: BrowserContext; p: Page; made: Made; table: Tally[]; league: Played[] } | null = null;
/** (F3)'s night: (F3) plays the league to its question and (F4) answers it, in the same browser. */
let tieNight: {
  ctx: BrowserContext;
  p: Page;
  made: Made;
  table: Tally[];
  results: Played[];
  title: string;
  lotFirst: string;
  level: string[];
} | null = null;

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
  await koNight?.ctx.close();
  await tieNight?.ctx.close();
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

/** The format choices (plan 5, spec §2): a stacked list, League first and chosen until another is. */
const SHAPES = ["league", "final", "semis"] as const;
type Shape = (typeof SHAPES)[number];
/** How many go through to the knockout (spec §2: "League → Final" is the top 2, "League → Semi-finals → Final" the top 4). */
const QUALIFIERS = { final: 2, semis: 4 } as const;
/** Spec §3 / plan 5 Global Constraints, as the owner amended them 2026-11-14: all three rows always listed; below 3 sides
 *  League → Final is disabled, "Needs 3 or more sides"; below 4 the semi-finals are, "Needs 4 or more sides"; 4 or more can
 *  pick all three. */
const KNOCKOUT_MIN_SIDES = 3;
const SEMIS_MIN_SIDES = 4;
/** A round robin of `n` where each pair meets `plays` times, and a single-elimination bracket of `q` seats: every match
 *  puts one side out until one is left, so `q − 1` matches. */
const leagueMatches = (n: number, plays: number) => (plays * n * (n - 1)) / 2;
const knockoutMatches = (q: number) => q - 1;
/** A format radio's accessible name: the title with its arrows read as commas ("League, Semi-finals, Final"). */
const shapeName = (shape: Shape) =>
  mk(`quickMatch.setup.shape.${shape}`)
    .split("→")
    .map((part) => part.trim())
    .join(", ");
const shapeRadio = (p: Page, shape: Shape) => form(p).getByRole("radio", { name: shapeName(shape), exact: true });

/** The setup form, filled and started the way a guest does it: badminton, Singles, the sides typed, the format (League
 *  unless `shape` names a knockout), each pair once (or `plays` times), the short rules, and (when given) an address in the
 *  "Email me the link" fold. Every format row the sides allow is read first: offered, enabled or disabled with its reason,
 *  and described by its hint. `matches` is what Start counts. Lands on the home and returns its token. */
async function startQuickMatch(
  p: Page,
  name: string,
  sides: string[],
  matches: number,
  opts: { email?: string; shape?: Shape; plays?: 1 | 2 } = {},
): Promise<Made> {
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
  // The format (plan 5 T6; owner 2026-11-14): every row is listed, each with its hint; a row the sides do not allow yet is
  // shown disabled with its reason (2 sides: both knockouts; 3 sides: the semi-finals), never hidden.
  let formats = 0;
  for (const s of SHAPES) {
    const radio = shapeRadio(p, s);
    formats += 1;
    await expect(radio, `${sides.length} sides: the ${s} row is listed`).toHaveCount(1);
    const hint = s === "league" ? mk("quickMatch.setup.shape.leagueHint") : mk(`quickMatch.setup.shape.${s}Hint`, { count: QUALIFIERS[s] });
    const needs = s === "final" ? KNOCKOUT_MIN_SIDES : s === "semis" ? SEMIS_MIN_SIDES : null;
    if (needs !== null && sides.length < needs) {
      await expect(radio, `${sides.length} sides: ${s} shown, disabled`).toBeDisabled();
      await expect(radio, "…with the reason").toHaveAccessibleDescription(
        `${hint} ${mk(`quickMatch.setup.shape.${s === "final" ? "finalNeeds" : "semisNeeds"}`, { min: needs })}`,
      );
    } else {
      await expect(radio, `${sides.length} sides: ${s} offered`).toBeEnabled();
      await expect(radio).toHaveAccessibleDescription(hint);
    }
  }
  expect(formats, "anti-vacuity: format rows checked").toBe(SHAPES.length);
  await expect(shapeRadio(p, "league"), "League is chosen until another is").toBeChecked();
  const shape = opts.shape ?? "league";
  if (shape !== "league") {
    // The row's visible face is what a guest taps (the radio itself is sr-only). `has` is relative to the label.
    await form(p)
      .locator("label")
      .filter({ has: p.getByRole("radio", { name: shapeName(shape), exact: true }) })
      .click({ timeout: REACH_MS });
    await expect(shapeRadio(p, shape)).toBeChecked();
  }
  // Each pair once, the default, or twice when asked: the count below follows it.
  const plays = opts.plays ?? 1;
  if (plays !== 1) await choice(p, mk(`quickMatch.setup.plays.${plays}`)).click();
  await expect(form(p).getByRole("radio", { name: mk(`quickMatch.setup.plays.${plays}`), exact: true })).toBeChecked();
  const rules = form(p).locator('select[name="variant_key"]');
  await rules.selectOption(VARIANT);
  await expect(rules).toHaveValue(VARIANT);
  // Start counts every match the format plays: the league's round robin, and the knockout's after it (plan 5 D8).
  await expect(p.getByTestId("qm-start")).toContainText(plural(mk, "quickMatch.setup.startCount", matches));
  if (opts.email !== undefined) {
    await form(p).getByText(mk("quickMatch.setup.email"), { exact: true }).click();
    const email = form(p).getByLabel(mk("quickMatch.setup.emailLabel"), { exact: true });
    await email.fill(opts.email);
    await expect(email).toHaveValue(opts.email);
  }
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

/** A League + Knockout's knockout card (plan 5 T7: its lines are cards in the bracket, never rows of the league's list). */
const drawCard = (p: Page, fixtureId: string) => p.locator(`[data-testid="qm-draw-card"][data-fixture-id="${fixtureId}"]`);

/** The home re-read until the knockout card `fixtureId` names its winner (`expectSettledOnHome`'s twin for a card). */
async function expectKnockoutSettledOnHome(p: Page, fixtureId: string): Promise<void> {
  const won = drawCard(p, fixtureId).locator('[data-testid="qm-draw-seat"][data-winner="true"]');
  await expect
    .poll(
      async () => {
        const n = await won.count();
        if (n !== 1) await p.reload();
        return n;
      },
      { timeout: STEP_MS, intervals: [250, 1_000, 2_000], message: `knockout match ${fixtureId} never named its winner on the home` },
    )
    .toBe(1);
}

/** A quick match's counts: matches played, marked Not played, and in all (spec 2026-11-12 §6: "N of M played · K not
 *  played", M the full total). */
interface Counts {
  played: number;
  notPlayed: number;
  total: number;
}
/** Spec 2026-11-12 §3 "Edge" and plan 4 D4: a league whose every match is played or Not played is finished (one with no
 *  match at all is not). */
const isFinished = (c: Counts) => c.total > 0 && c.played + c.notPlayed === c.total;

/** The played line's words. `countdown`: the unsaved home's "deleted N days after the last score" (C1), said only while a
 *  match is left; a finished home names no clock the guest no longer runs (owner, plan 4 T4 review m1), and the setup
 *  page's Continue card never carries one. A Not played match adds its own part, the total kept whole. */
function playedWords(c: Counts, countdown: boolean): string {
  const vars: Vars = countdown ? { played: c.played, days: QUICK_MATCH_EXPIRY_DAYS } : { played: c.played };
  if (c.notPlayed === 0) return plural(ui, countdown ? "quickMatch.home.played" : "quickMatch.home.playedSaved", c.total, vars);
  const skipped = plural(ui, "quickMatch.home.notPlayedPart", c.notPlayed);
  return plural(ui, countdown ? "quickMatch.home.playedSkipped" : "quickMatch.home.playedSkippedSaved", c.total, { ...vars, skipped });
}

/** "Not saved — deleted on {date}" under Save, with any day in it: the day is written in the guest's own zone
 *  (deletion-line.tsx), so only the words around it are pinned here. A function, never a module-scope constant: a load-time
 *  throw (a renamed key) would report as zero collected tests rather than a red one (README). */
function notSavedLine(): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [before, after] = ui("quickMatch.home.notSaved", { date: "@@date@@" }).split("@@date@@");
  return new RegExp(`^${escape(before!)}\\S.*${escape(after!)}$`);
}

/** An UNSAVED home's played line: counting down while a match is left; once finished, with no countdown, and the deletion
 *  said by the dated line under Save instead. */
async function expectPlayedLine(p: Page, c: Counts): Promise<void> {
  const finished = isFinished(c);
  await expect(p.getByTestId("qm-played"), finished ? "finished: no countdown" : "a match left: the countdown").toHaveText(
    playedWords(c, !finished),
  );
  if (finished) await expect(p.getByTestId("qm-not-saved"), "finished: its deletion is the dated line").toHaveText(notSavedLine());
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

/** The ledger's voids for one fixture, each with the type of the event it voided: the record of "Void my last entry". */
async function voidsRecorded(fixtureId: string): Promise<{ voided: string | null; byLink: boolean }[]> {
  return withDb(
    (sql) => sql<{ voided: string | null; byLink: boolean }[]>`
      select t.type as voided, (v.device_link_id is not null and v.device_link_id = t.device_link_id) as "byLink"
      from score_events v left join score_events t on t.id = v.voids_event_id
      where v.fixture_id = ${fixtureId} and v.type = 'core.void' order by v.seq`,
  );
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
 *
 * `where`: "list" is a league's match, marked next in the match list; "knockout" is a League + Knockout's knockout line,
 * marked next among the bracket's cards (the list is the league's, plan 5 T7), and read back off its card. `beforeBack` runs
 * on the pad once the match reads decided, before Back: what the deciding rally did before any home load (needs
 * "after-result").
 */
async function playHeroMatch(
  p: Page,
  made: Made,
  games: readonly Game[],
  decide: (home: string, away: string) => string,
  leave: "after-result" | "at-once",
  opts: { where?: "list" | "knockout"; beforeBack?: () => Promise<void> } = {},
): Promise<Played> {
  const where = opts.where ?? "list";
  const next = p.locator(`[data-testid="${where === "list" ? "qm-match" : "qm-draw-card"}"][data-next="true"]`);
  await expect(next, "the home offers exactly one match next").toHaveCount(1);
  const fixtureId = (await next.getAttribute("data-fixture-id"))!;
  expect(fixtureId).toMatch(/^[0-9a-f-]{36}$/);
  const home = (await p.getByTestId("qm-hero-home").textContent())!.trim();
  const away = (await p.getByTestId("qm-hero-away").textContent())!.trim();
  expect(made.sides, "the hero names two of this quick match's sides").toEqual(expect.arrayContaining([home, away]));
  expect(home, "the hero names two DIFFERENT sides").not.toBe(away);
  // The hero's match IS the row (or card) marked next (the record below is read by its fixture id).
  if (where === "list") {
    await expect(next.getByTestId("qm-match-sides"), "the row marked next is the hero's match").toContainText(home);
    await expect(next.getByTestId("qm-match-sides")).toContainText(away);
  } else {
    await expect(next.getByTestId("qm-draw-name"), "the card marked next seats the hero's two sides, as the hero does").toHaveText([home, away]);
  }
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
  // What the halves call the sides (sign-off 2026-11-12): a quick match's sides have no members, and a member-less side is
  // called by its NAME where the pad says the side word, never Home/Away. The half's accessible name opens on it.
  // Followed by the hint, or ", Serving" on the serving side (whoNames).
  const opensWith = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:,|\\s)`);
  await expect(tapTarget(p, "home"), "the home half names the home side").toHaveAttribute("aria-label", opensWith(home));
  await expect(tapTarget(p, "away"), "the away half names the away side").toHaveAttribute("aria-label", opensWith(away));

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
    await expect(p.getByText(ui("device.quickMatch.resultSaved")), "the device page says the match is decided").toBeVisible({
      timeout: DECIDE_MS,
    });
    await expect(pad(p), "a decided match unmounts the pad").toHaveCount(0);
  }
  if (opts.beforeBack) {
    expect(leave, "beforeBack reads a decided pad").toBe("after-result");
    await opts.beforeBack();
  }
  await p.getByTestId("quick-match-back-link").click();
  await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });

  // ---- What a person reads: the result, winner first ----
  if (where === "list") {
    await expectSettledOnHome(p, fixtureId);
    const row = matchRow(p, fixtureId);
    await expect(row.getByTestId("qm-match-sides")).toHaveText(ui("quickMatch.home.result", { winner, loser }));
    await expect(row.getByTestId("qm-match-score"), "the games read winner first").toHaveText(winnerFirst(games));
  } else {
    // A knockout card names its winner on a line of its own, with the finished score on it, winner first (draw.tsx).
    await expectKnockoutSettledOnHome(p, fixtureId);
    const won = drawCard(p, fixtureId).locator('[data-testid="qm-draw-seat"][data-winner="true"]');
    await expect(won.getByTestId("qm-draw-name"), "the card's winner line names the winner").toHaveText(winner);
    await expect(won.getByTestId("qm-draw-seat-score"), "the games read winner first").toHaveText(winnerFirst(games));
  }
  return { fixtureId, home, away, winner, loser, winnerSide, games, taps: rallies.tapped };
}

/**
 * Edit result, by hand (branch-fix A review I1): the decided row's "Edit result" → the pad's decided screen, which says how
 * to correct it in the quick match's own words and names no organiser (review Q2) → "Void my last entry" → the match
 * reopens one rally short for its old winner → every rally of the correction tapped for the OTHER side → Back → the home
 * reads the corrected result, winner first. Returns the match as it now stands; its `taps` count every rally row the
 * ledger holds (the voided one stays a row: a void is an event of its own).
 */
async function correctResult(p: Page, made: Made, played: Played, rules: SetRules): Promise<Played> {
  const fix = correctionOf(rules, played.games);
  const was = played.winnerSide;
  const now = otherSide(was);

  // ---- Edit result: in the settled row's ⋯ menu (owner 2026-11-13: one menu per row), a real 44px target ----
  const settledRow = matchRow(p, played.fixtureId);
  await waitForHydration(settledRow.getByTestId("qm-row-menu"), { timeout: STEP_MS });
  await settledRow.getByTestId("qm-row-menu-toggle").click();
  const edit = settledRow.getByTestId("qm-edit-result");
  await expect(edit).toHaveText(ui("quickMatch.home.editResult"));
  const box = await edit.boundingBox();
  expect(box?.height ?? 0, "Edit result is a 44px target").toBeGreaterThanOrEqual(44);
  await edit.click();
  await p.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: STEP_MS });

  // ---- The decided screen: the quick match's line, the undo it names on screen ----
  await expect(p.getByText(ui("device.quickMatch.resultSaved")), "the pad says how to correct it").toBeVisible({ timeout: STEP_MS });
  await expect(p.getByText(ui("device.resultRecorded")), "never the organiser's line").toHaveCount(0);
  await expect(pad(p), "a decided match has no pad").toHaveCount(0);
  await expectNoHorizontalScroll(p);
  const undo = p.getByTestId("device-void-mine");
  await expect(undo).toHaveAccessibleName(ui("device.undoMine"));
  await undo.click();

  // ---- Reopened: the void in the ledger, the pad back, the last game one short for the old winner ----
  await expect
    .poll(async () => (await voidsRecorded(played.fixtureId)).length, { timeout: STEP_MS, message: "the void never reached the ledger" })
    .toBe(1);
  expect(await voidsRecorded(played.fixtureId), "it voided a rally, through the guest's own link").toEqual([{ voided: RALLY, byLink: true }]);
  await expect(tapTarget(p, now), "the pad is back, tappable").toBeVisible({ timeout: STEP_MS });
  await expect(points(p, was), "the deciding rally is gone").toHaveText(String(fix.held));
  await expect(points(p, now)).toHaveText(String(fix.from));
  await expect(p.getByText(ui("device.quickMatch.resultSaved")), "undecided: no decided line").toHaveCount(0);

  // ---- The correction: the other side takes every rally until it has the match ----
  const rallies = new Rallies(p);
  const ledgerBefore = played.taps;
  const closeGame = async (from: number, closesAt: number, other: number, last: boolean) => {
    for (let k = from; k < closesAt - 1; k += 1) await rallies.tap(now);
    await expect(points(p, now), "one short of closing the game").toHaveText(String(closesAt - 1));
    await expect(points(p, was)).toHaveText(String(other));
    if (last) {
      await expect
        .poll(() => ralliesRecorded(played.fixtureId), {
          timeout: HOLD_MS + STEP_MS + rallies.tapped * SEND_MS,
          message: "the correction's rallies before the deciding one never all reached the ledger",
        })
        .toBe(ledgerBefore + rallies.tapped);
      await expect(pad(p).locator('[data-role="v3-rejection"]'), "no tap was refused").toHaveCount(0);
    }
    await rallies.tap(now);
  };
  await closeGame(fix.from, fix.closesAt, fix.held, fix.extra.length === 0);
  for (const [i, target] of fix.extra.entries()) {
    await expect(points(p, "home"), "the next game opens at nothing").toHaveText("0");
    await expect(points(p, "away")).toHaveText("0");
    await closeGame(0, target, 0, i === fix.extra.length - 1);
  }
  expect(rallies.tapped, "every rally of the correction was tapped").toBe(fix.taps);

  // ---- Decided again, then Back ----
  await expect(p.getByText(ui("device.quickMatch.resultSaved")), "decided for the other side").toBeVisible({ timeout: DECIDE_MS });
  await expect(pad(p)).toHaveCount(0);
  await p.getByTestId("quick-match-back-link").click();
  await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });
  await expectSettledOnHome(p, played.fixtureId);
  const row = matchRow(p, played.fixtureId);
  await expect(row.getByTestId("qm-match-sides"), "the corrected result").toHaveText(
    ui("quickMatch.home.result", { winner: played.loser, loser: played.winner }),
  );
  await expect(row.getByTestId("qm-match-score"), "the corrected games, the new winner first").toHaveText(winnerFirst(fix.corrected));
  return {
    ...played,
    winner: played.loser,
    loser: played.winner,
    winnerSide: now,
    games: fix.corrected,
    taps: played.taps + fix.taps,
  };
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
const LONG = `The Extraordinarily Long-Named Champion Club ${TAG}`;

let league: (Made & { results: Played[]; table: Tally[] }) | null = null;
let pair: Made | null = null;

test("(A) a guest plays a badminton league of three from the marketing page to its final table, every rally tapped", async ({ browser }) => {
  const rules = leagueRules();
  const sides = [LONG, `Priya Raman ${TAG}`, `Jo Okafor ${TAG}`];
  expect(LONG.replace(` ${TAG}`, "").length, "premise: the long side is 40+ characters").toBeGreaterThanOrEqual(40);
  const total = (sides.length * (sides.length - 1)) / 2;
  // One score plan per match, in play order (the hero's order; which sides meet first is the generator's). The winner is
  // decided by NAME: the long side wins both its matches, and the match without it goes to its AWAY side, so at least
  // one result is read with the winner seated away (where winner-first and home-first differ). One plan runs to three
  // games, one of them lost by the match's winner. That match without the long side is then corrected through Edit result
  // (step 5b) to its HOME side: the table stays strict (2, 1, 0), with its second and third places swapped.
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 3], [rules.setTo, 5]],
    [[rules.setTo, 0], [rules.setTo, 2]],
    [[rules.setTo, 4], [6, rules.setTo], [rules.finalSetTo, 8]],
  ];
  expect(plans, "one plan per match a round robin of three plays").toHaveLength(total);
  plans.forEach((g, i) => checkPlan(rules, g, `league match ${i + 1}`));
  // The decider Add a match puts on the finished table (step 7): the long side, already top, takes it, so the table stays
  // strict (3, 1, 0) and its winner stays the long side. Checked against the rules like the others.
  const decider: readonly Game[] = [[rules.setTo, 1], [rules.setTo, 3]];
  checkPlan(rules, decider, "the added match");
  // The correction (step 5b) costs one more plan of its own rallies: the largest any of these plans could need.
  const correctionTaps = Math.max(...plans.map((g) => correctionOf(rules, g).taps));
  setBudget(
    budgetFor({
      navs: 3 + SHARE.navs + ADD.navs,
      acts: 16 + SHARE.acts + ADD.acts,
      reads: 2 + ADD.reads,
      plans: [...plans, [[correctionTaps, 0]], decider],
    }),
  );

  // ---- 1. The marketing page's Quick match, to the setup page ----
  // The hero's one primary since owner 2026-11-13: a Sport select (its default, the setup screen's first) and the Start, a
  // GET to /en/play?sport=<that sport>; step 2 then picks Badminton on the setup page as before.
  await page.goto("/en");
  const cta = page.getByTestId("qm-cta").getByRole("button", { name: mk("quickMatch.cta"), exact: true });
  await expect(cta).toBeVisible({ timeout: STEP_MS });
  await expectNoHorizontalScroll(page);
  await cta.click();
  await page.waitForURL((url) => url.pathname === "/en/play", { timeout: STEP_MS });

  // ---- 2. Badminton, League, three sides (one long), Start ----
  const made = await startQuickMatch(page, `QM walk league ${TAG}`, sides, total);

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

  // ── EXTENSION POINT: Share (plan 2 T7), filled ──────────────────────────────────────────────────────────────────
  // The home as first created: nothing played, `made.path` is `/q/<token>`, the guest's visitor cookie is set.

  // ---- 3b. Share: Copy is on first paint (one tap), the QR behind Show QR; the copied link opens the home elsewhere ----
  const origin = new URL(page.url()).origin;
  await guest!.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const copy = page.getByTestId("qm-share-copy");
  await expect(copy, "Copy is on the home's first paint, behind no toggle").toHaveText(ui("quickMatch.home.copy"));
  await expect(page.getByTestId("qm-share-qr"), "the QR is closed on first paint").toHaveCount(0);
  await copy.click();
  await expect(copy).toHaveText(ui("quickMatch.home.copied"));
  // The link as the home offers it (the clipboard), never constructed: this page's own address on this origin.
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  expect(shared, "the clipboard holds the home's own link").toBe(page.url());
  expect(new URL(shared).pathname, "the home, never the pad's device link").toBe(made.path);
  const showQr = page.getByTestId("qm-share-toggle");
  await expect(showQr).toHaveText(ui("dlink.showQr"));
  await showQr.click();
  await expect(showQr).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("qm-share-qr"), "the Seazn QR of the link, drawn on the tap").toBeVisible({ timeout: STEP_MS });
  await expectNoHorizontalScroll(page);
  await showQr.click();
  await expect(page.getByTestId("qm-share-qr"), "Show QR again closes it").toHaveCount(0);
  // A friend opens the copied link: a second browser with no cookie lands on the same home. It plays nothing, so the
  // table tallied below from `results` stays true.
  const friend = await browser.newContext({ storageState: await consentedAnonymousState(), viewport: PHONE });
  try {
    const theirs = await friend.newPage();
    await theirs.goto(shared);
    await expect(theirs.getByTestId("qm-name"), "the shared link opens this home with no cookie").toHaveText(made.name, {
      timeout: STEP_MS,
    });
    await expect(theirs.getByTestId("qm-played")).toHaveText(
      plural(ui, "quickMatch.home.played", total, { played: 0, days: QUICK_MATCH_EXPIRY_DAYS }),
    );
  } finally {
    await friend.close();
  }

  // ---- 4 and 5. Each match: Score, every rally, Back, and the home read back ----
  const results: Played[] = [];
  /** Every result as the home read it, the ones a correction replaced included (the winner-first witness reads them all). */
  const read: Played[] = [];
  let corrections = 0;
  for (const [k, games] of plans.entries()) {
    // The last match leaves at once, holding its deciding rally: the only browser proof that Back sends it first.
    const leave = k === plans.length - 1 ? "at-once" : "after-result";
    const played = await playHeroMatch(page, made, games, (h, a) => (h === LONG || a === LONG ? LONG : a), leave);
    results.push(played);
    read.push(played);
    const after = results.length;
    // The countdown while a match is left; the last result finishes the league, and its line then names no clock.
    await expectPlayedLine(page, { played: after, notPlayed: 0, total });
    await expectTable(page, tableOf(sides, results, rules));
    if (after < total) {
      // The next match is offered: the hero names it, with its Score.
      await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: after + 1, total }));
      await expect(page.getByTestId("qm-hero").getByTestId("qm-score")).toBeVisible();
      await expect(page.locator('[data-testid="qm-match"][data-next="true"]')).toHaveAttribute("data-state", "ready");
    }
    expect(await expectRecorded(made, [played])).toBe(1);

    // ---- 5b. Edit result (branch-fix A review I1): the match without the long side, corrected to its other side ----
    if (played.home !== LONG && played.away !== LONG) {
      const corrected = await correctResult(page, made, played, rules);
      results[results.length - 1] = corrected;
      read.push(corrected);
      corrections += 1;
      // The count of matches played does not move; the table does, re-derived from the corrected rallies.
      await expectPlayedLine(page, { played: after, notPlayed: 0, total });
      await expectTable(page, tableOf(sides, results, rules));
      expect(await expectRecorded(made, [corrected]), "the record holds the corrected result").toBe(1);
    }
  }
  expect(results, "anti-vacuity: every league match was played").toHaveLength(total);
  expect(corrections, "anti-vacuity: exactly one match was corrected through Edit result").toBe(1);
  expect(
    read.filter((r) => r.winnerSide === "away").length,
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

  // ── EXTENSION POINT: Add a match (plan 2 T8), filled ────────────────────────────────────────────────────────────
  // The league is finished: three results in `results`, the table in `table`, the winner card up.

  // ---- 7. Add a match (C5): the decider, through the home's own control, opening at the table's top two ----
  const add = page.getByTestId("qm-add-match-open");
  await expect(add).toHaveText(ui("quickMatch.home.addMatch"));
  const addForm = page.getByTestId("qm-add-match-form");
  await expect(addForm, "closed until the guest opens it").toBeHidden();
  await add.click();
  await expect(addForm).toBeVisible();
  const [first, second] = [addForm.locator('select[name="home"]'), addForm.locator('select[name="away"]')];
  // Every side, as typed, in each select; each opens at the tally's top two (the stored table's order, read above).
  for (const select of [first, second]) await expect(select.locator("option")).toHaveText(sides);
  await expect(first.locator("option:checked"), "the first select opens at the table's top").toHaveText(table[0]!.name);
  await expect(second.locator("option:checked"), "the second at its runner-up").toHaveText(table[1]!.name);
  const submit = addForm.getByTestId("qm-add-match-submit");
  await expect(submit).toHaveText(ui("quickMatch.addMatch.submit"));
  for (const [what, target] of [["+ Add a match", add], ["the first select", first], ["the second select", second], ["Add the match", submit]] as const) {
    const box = await target.boundingBox();
    expect(box?.height ?? 0, `${what} is a 44px target`).toBeGreaterThanOrEqual(44);
  }
  await expectNoHorizontalScroll(page);
  await submit.click();
  // The post's 303 lands on the bare home: no refusal in the URL, none on screen.
  await page.waitForURL((url) => url.pathname === made.path && url.search === "", { timeout: STEP_MS });
  await expect(page.getByTestId("qm-flash")).toHaveCount(0);
  const withAdded = total + 1;
  await expect(page.getByTestId("qm-match")).toHaveCount(withAdded);
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", withAdded, { played: total, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  // Something to play again: the winner card gives way to the new match, Up next, the last of four, seated as picked.
  await expect(page.getByTestId("qm-winner"), "no winner while a match is left").toHaveCount(0);
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: withAdded, total: withAdded }));
  await expect(page.getByTestId("qm-hero-home")).toHaveText(table[0]!.name);
  await expect(page.getByTestId("qm-hero-away")).toHaveText(table[1]!.name);
  await expectNoHorizontalScroll(page);

  // ---- 7b. The added match, played like the others; the long side takes it ----
  const added = await playHeroMatch(page, made, decider, () => LONG, "after-result");
  results.push(added);
  const final = tableOf(sides, results, rules);
  expect(final.map((t) => t.won), "still strict: no tie-break is needed to place it").toEqual([3, 1, 0]);
  // Finished again: the line names no countdown.
  await expectPlayedLine(page, { played: withAdded, notPlayed: 0, total: withAdded });
  await expect(page.getByTestId("qm-hero"), "nothing left to play again").toHaveCount(0);
  await expect(page.getByTestId("qm-winner-name")).toHaveText([final[0]!.name]);
  await expect(page.getByTestId("qm-standings-row").getByRole("rowheader")).toHaveText(final.map((t) => t.name));
  await expectTable(page, final);
  await expectNoHorizontalScroll(page);
  expect(await expectRecorded(made, results)).toBe(withAdded);
  // The record: the added match is the stage's one ad-hoc row (C5: `adhoc-<n>`), and the stored table counts it.
  const adhoc = await withDb(
    (sql) => sql<{ id: string }[]>`
      select f.id from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join fixtures f on f.division_id = d.id
      where q.token_hash = ${tokenHash(made.token)} and f.ext_key like 'adhoc-%'`,
  );
  expect(adhoc.map((f) => f.id), "the added match is the one ad-hoc row").toEqual([added.fixtureId]);
  const restored = await withDb(
    (sql) => sql<{ rows: { entrantId: string; played: number; won: number; points: number; rank: number }[] }[]>`
      select s.rows from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join stages st on st.division_id = d.id
      join standings_snapshots s on s.stage_id = st.id and s.pool_id is null
      where q.token_hash = ${tokenHash(made.token)}`,
  );
  expect(
    restored[0]!.rows.map((r) => ({ name: nameOf.get(r.entrantId), played: r.played, won: r.won, points: r.points, rank: r.rank })),
    "the stored table counts the added match",
  ).toEqual(final.map((t, i) => ({ name: t.name, played: t.played, won: t.won, points: t.points, rank: i + 1 })));

  // ── Save (plan 3) is journey (D) below, in a browser of its own (plan 2 m6): this guest's (C) reads the recent strip
  // of THIS context, which a sign-in would change.

  league = { ...made, results, table: tableOf(sides, results, rules) };
});

test("(B) a guest plays a second badminton league, of two sides each playing once: its one match decided, every rally tapped", async () => {
  expect(league, "(A) made this guest's first quick match").not.toBeNull();
  const rules = leagueRules();
  const sides = [`Kestrel Vance ${TAG}`, `Osprey Lindqvist ${TAG}`];
  // The rulebook's count: a single round robin of two sides is one match.
  const total = (sides.length * (sides.length - 1)) / 2;
  // The match goes to its AWAY side, in two games: winner-first and home-first read differently on its row.
  const plans: readonly (readonly Game[])[] = [[[rules.setTo, 2], [rules.setTo, 6]]];
  expect(plans, "one plan per match a round robin of two plays").toHaveLength(total);
  plans.forEach((g, i) => checkPlan(rules, g, `league of two, match ${i + 1}`));
  setBudget(budgetFor({ navs: 2, acts: 16, reads: 1, plans }));

  // ---- 1. The setup page again, where the first match is already listed ----
  await page.goto("/en/play");
  await expect(page.getByTestId("qm-recent"), "the setup page lists the league made in (A)").toContainText(league!.name);
  const made = await startQuickMatch(page, `QM walk pair ${TAG}`, sides, total);

  // ---- 2. The home: one match up next, a level table of two ----
  await expect(page.getByTestId("qm-name")).toHaveText(made.name);
  await expect(page.getByTestId("qm-eyebrow")).toContainText(ui("quickMatch.format.league"));
  await expect(page.getByTestId("qm-played")).toHaveText(
    plural(ui, "quickMatch.home.played", total, { played: 0, days: QUICK_MATCH_EXPIRY_DAYS }),
  );
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total }));
  await expect(page.getByTestId("qm-match")).toHaveCount(total);
  await expect(page.locator('[data-testid="qm-match"][data-state="ready"]'), "the one match is ready to score").toHaveCount(total);
  await expect(page.getByTestId("qm-standings-row")).toHaveCount(sides.length);
  for (const name of sides) await expect(tableRow(page, name).getByTestId("qm-cell")).toHaveText(["0", "0", "0"]);
  await expect(page.locator('[data-testid="qm-standings-row"][data-leader="true"]'), "nothing counted: no leader").toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // ---- 3. The one match, tapped; its away side takes it ----
  const played = await playHeroMatch(page, made, plans[0]!, (_h, a) => a, "after-result");
  expect(played.winnerSide, "the plan: the match goes to its away side").toBe("away");

  // ---- 4. Finished: the winner card, the table the rallies made, the record agreeing ----
  const table = tableOf(sides, [played], rules);
  expect(table.map((t) => t.won), "the plan makes a strict table: no tie-break is needed to place it").toEqual([1, 0]);
  // Finished: the line names no countdown.
  await expectPlayedLine(page, { played: total, notPlayed: 0, total });
  await expect(page.locator('[data-testid="qm-match"][data-state="settled"]')).toHaveCount(total);
  await expect(page.getByTestId("qm-hero"), "nothing left to play").toHaveCount(0);
  await expect(page.getByTestId("qm-winner-kicker")).toHaveText(ui("quickMatch.home.winner"));
  await expect(page.getByTestId("qm-winner-name")).toHaveText([played.winner]);
  await expect(page.getByTestId("qm-standings-row").getByRole("rowheader")).toHaveText(table.map((t) => t.name));
  await expectTable(page, table);
  await expectNoHorizontalScroll(page);
  expect(await expectRecorded(made, [played])).toBe(total);

  pair = made;
});

test("(C) the marketing page lists both quick matches, newest first, and a tap opens the home", async () => {
  expect(league, "(A) made the first quick match in this browser").not.toBeNull();
  expect(pair, "(B) made the second").not.toBeNull();
  setBudget(budgetFor({ navs: 2, acts: 6, reads: 0, plans: [] }));

  await page.goto("/en");
  const strip = page.getByTestId("qm-recent");
  await expect(strip).toBeVisible({ timeout: STEP_MS });
  await expect(strip.getByRole("heading")).toHaveText(mk("quickMatch.recent.title"));
  // Newest first: the league of two (B) was made after the league of three (A). Only this browser's two: the context is a
  // new guest.
  const links = strip.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", pair!.path);
  await expect(links.nth(0)).toContainText(pair!.name);
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

// ── (D) Save (plan 3 Task 5) ────────────────────────────────────────────────────────────────────────────────────────

/** Save's steps: the setup, the sign-in's two hops (the login page, the magic link), the save page, the home after the
 *  save, the second guest's home and save page; the Save taps, the fold, the reads of each page; the record twice. */
const SAVE = { navs: 8, acts: 12, reads: 2 } as const;
/** The account's Quick matches (plan 3 Task 6): "In your account" to /me, the home its link opens, "In your account" again,
 *  the reload after the delete, and the dead link in each browser; the link's two taps and measure, the row's reads and 44px
 *  measures, Rename's form, fill and save, Delete's confirmation and its yes, the live region and the focus after it; the
 *  record before the rename, after it, and after the delete (the quick match's row and the competition: two reads). */
const ACCOUNT = { navs: 6, acts: 19, reads: 4 } as const;

interface SaveRecord {
  email: string | null;
  expires_at: Date | null;
  saved_by_user_id: string | null;
  saver: string | null;
}
interface NamesRecord {
  id: string;
  competition_id: string;
  slug: string;
  names: string[];
}
/** The quick match's id and the four places its name lives (the row, the competition, the division, the stage), with the
 *  competition's slug, found by the home token's hash; null once the match is deleted. */
async function namesRecordOf(made: Made): Promise<NamesRecord | null> {
  const [row] = await withDb((sql) => sql<NamesRecord[]>`
    select q.id, q.competition_id, c.slug, array[q.name, c.name, d.name, s.name] as names
      from quick_matches q
      join competitions c on c.id = q.competition_id
      join divisions d on d.competition_id = c.id
      join stages s on s.division_id = d.id
     where q.token_hash = ${tokenHash(made.token)}`);
  return row ?? null;
}

/** The quick match's save columns and its saver's address, found by the home token's hash (C19). */
async function saveRecordOf(made: Made): Promise<SaveRecord> {
  const [row] = await withDb((sql) => sql<SaveRecord[]>`
    select q.email, q.expires_at, q.saved_by_user_id, u.email as saver
      from quick_matches q left join users u on u.id = q.saved_by_user_id
     where q.token_hash = ${tokenHash(made.token)}`);
  if (!row) throw new Error("the quick match has no row");
  return row;
}

test("(D) Save: a guest who typed an address saves the league into another account by signing in; only the saver reads Saved; the saver's account lists it, renames it and deletes it for everyone", async ({ browser }, info) => {
  setBudget(
    budgetFor({
      navs: SAVE.navs + ACCOUNT.navs,
      acts: SAVE.acts + ACCOUNT.acts,
      reads: SAVE.reads + ACCOUNT.reads,
      plans: [],
    }),
  );
  const guestOf = async () =>
    browser.newContext({ storageState: await consentedAnonymousState(), baseURL: info.project.use.baseURL, viewport: PHONE });
  const mine = await guestOf();
  const theirs = await guestOf();
  try {
    const p = await mine.newPage();
    await p.goto("/en/play");
    // The address typed on the match is not the saver's: Save keeps it for whoever signs in (C3), and forgets the address.
    const typed = `delivered+qm-typed-${TAG}@resend.dev`;
    const saver = `delivered+qm-saver-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`;
    const sides = [`Avocet Moreau ${TAG}`, `Plover Okafor ${TAG}`, `Dunlin Sato ${TAG}`];
    const total = (sides.length * (sides.length - 1)) / 2;
    const made = await startQuickMatch(p, `Keep me ${TAG}`, sides, total, { email: typed });

    const fresh = await saveRecordOf(made);
    expect([fresh.email, fresh.saved_by_user_id], "made with the typed address, saved by nobody").toEqual([typed, null]);
    expect(fresh.expires_at, "an unsaved match expires").not.toBeNull();
    await expect(p.getByTestId("qm-played")).toHaveText(
      plural(ui, "quickMatch.home.played", total, { played: 0, days: QUICK_MATCH_EXPIRY_DAYS }),
    );

    // Save, signed out: the sign-in, carrying the save page.
    const save = p.getByTestId("qm-save");
    await expect(save).toHaveText(ui("quickMatch.home.save"));
    expect((await save.boundingBox())?.height ?? 0, "Save is a 44px target").toBeGreaterThanOrEqual(44);
    await save.click();
    await p.waitForURL((u) => u.pathname === "/login", { timeout: STEP_MS });
    const next = new URL(p.url()).searchParams.get("next");
    expect(next, "the sign-in returns to the save page").toBe(`${made.path}/save`);

    // Signed in as someone else entirely: back on the save page, its one button.
    await loginUi(p, saver, next!);
    await p.waitForURL((u) => u.pathname === next, { timeout: STEP_MS });
    await expect(p.getByTestId("qm-save-title")).toHaveText(ui("quickMatch.save.title", { name: made.name }));
    await expect(p.getByTestId("qm-save-hint")).toHaveText(ui("quickMatch.save.hint"));
    await expectNoHorizontalScroll(p);
    expect((await saveRecordOf(made)).saved_by_user_id, "opening the save page saves nothing").toBeNull();
    await p.getByTestId("qm-save").click();

    // The home, saved: "Saved" in place of the button, and a played line with no countdown.
    await p.waitForURL((u) => u.pathname === made.path && u.search === "", { timeout: STEP_MS });
    await expect(p.getByTestId("qm-saved")).toHaveText(ui("quickMatch.home.saved"));
    await expect(p.getByTestId("qm-save")).toHaveCount(0);
    await expect(p.getByTestId("qm-played")).toHaveText(plural(ui, "quickMatch.home.playedSaved", total, { played: 0 }));
    await expectNoHorizontalScroll(p);
    const saved = await saveRecordOf(made);
    expect([saved.saver, saved.email, saved.expires_at], "the saver's, the typed address forgotten, no expiry").toEqual([saver, null, null]);

    // A second guest with the same link: the match, but neither Save nor Saved. Signed out, the save page cannot know they
    // are not the saver, so it says the match is saved to an account and offers Sign in, back to itself.
    const q = await theirs.newPage();
    await q.goto(made.path);
    await expect(q.getByTestId("qm-name")).toHaveText(made.name, { timeout: STEP_MS });
    await expect(q.getByTestId("qm-save")).toHaveCount(0);
    await expect(q.getByTestId("qm-saved")).toHaveCount(0);
    await expect(q.getByTestId("qm-in-account"), "the account link is the saver's only").toHaveCount(0);
    await q.goto(`${made.path}/save`);
    await expect(q.getByTestId("qm-save-saved")).toHaveText(ui("quickMatch.save.savedToAccount"), { timeout: STEP_MS });
    const signIn = q.getByTestId("qm-save-signin");
    await expect(signIn).toHaveText(ui("quickMatch.save.signIn"));
    expect((await signIn.boundingBox())?.height ?? 0, "Sign in is a 44px target").toBeGreaterThanOrEqual(44);
    const signInUrl = new URL((await signIn.getAttribute("href"))!, "http://relative.invalid");
    expect([signInUrl.pathname, signInUrl.searchParams.get("next")]).toEqual(["/login", `${made.path}/save`]);
    await expect(q.getByTestId("qm-save")).toHaveCount(0);
    await expectNoHorizontalScroll(q);

    // ── The account's Quick matches (plan 3 Task 6, spec §7.7) ──
    // The saver, still on the saved home, taps "In your account": the account page, at its Quick matches.
    const before = await namesRecordOf(made);
    expect(before?.names, "the create's name in all four places").toEqual([made.name, made.name, made.name, made.name]);
    const inAccount = p.getByTestId("qm-in-account");
    await expect(inAccount).toHaveText(ui("quickMatch.home.inAccount"));
    expect((await inAccount.boundingBox())?.height ?? 0, "In your account is a 44px target").toBeGreaterThanOrEqual(44);
    await inAccount.click();
    await p.waitForURL((u) => u.pathname === "/me" && u.hash === "#quick-matches", { timeout: STEP_MS });
    const list = p.getByTestId("me-quick-matches");
    await expect(list.getByRole("heading", { level: 2 })).toHaveText(ui("quickMatch.me.title"), { timeout: STEP_MS });
    await expect(list.locator("li[data-qm-id]"), "one row: the one match this account saved").toHaveCount(1);
    const row = list.locator(`li[data-qm-id="${before!.id}"]`);
    const nameLink = row.getByTestId("me-qm-name");
    await expect(nameLink).toHaveText(made.name);
    await expect(nameLink).toHaveAttribute("href", made.path);
    await expect(row.getByTestId("me-qm-meta")).toHaveText(
      `${ui("quickMatch.format.league")} · ${plural(ui, "quickMatch.home.playedSaved", total, { played: 0 })}`,
    );
    for (const id of ["me-qm-name", "me-qm-rename", "me-qm-delete"]) {
      expect((await row.getByTestId(id).boundingBox())?.height ?? 0, `${id} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(p);

    // Rename: the row's form opens at the current name; the new one, typed with spaces around it, is stored trimmed, shows on
    // the row at once, and is the match's name in all four places, its slug untouched (D14).
    await row.getByTestId("me-qm-rename").click();
    const input = row.getByTestId("me-qm-rename-input");
    await expect(input).toHaveValue(made.name);
    const renamed = `Renamed ${TAG}`;
    await input.fill(`  ${renamed}  `);
    await row.getByTestId("me-qm-rename-save").click();
    await expect(row.getByTestId("me-qm-rename-form")).toHaveCount(0);
    await expect(nameLink).toHaveText(renamed);
    const after = await namesRecordOf(made);
    expect(after, "renamed in all four places, trimmed; the slug kept").toEqual({ ...before!, names: [renamed, renamed, renamed, renamed] });
    // The name is the link: tapped, the home, the same link, under its new name.
    await nameLink.click();
    await p.waitForURL((u) => u.pathname === made.path, { timeout: STEP_MS });
    await expect(p.getByTestId("qm-name")).toHaveText(renamed);
    await expect(p.getByTestId("qm-saved")).toHaveText(ui("quickMatch.home.saved"));

    // Delete, for everyone: back on the account page by the home's own link (its own read, after the rename); Delete asks first.
    await p.getByTestId("qm-in-account").click();
    await p.waitForURL((u) => u.pathname === "/me" && u.hash === "#quick-matches", { timeout: STEP_MS });
    await expect(nameLink).toHaveText(renamed, { timeout: STEP_MS });
    await row.getByTestId("me-qm-delete").click();
    await expect(row.getByTestId("me-qm-delete-question")).toHaveText(ui("quickMatch.me.deleteConfirm"));
    for (const id of ["me-qm-delete-yes", "me-qm-delete-cancel"]) {
      expect((await row.getByTestId(id).boundingBox())?.height ?? 0, `${id} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(p);
    await row.getByTestId("me-qm-delete-yes").click();
    // The row goes, and the section with it: the empty case has no heading over nothing. The list's polite live region says
    // which match was deleted, and focus stays on the list's own root, never the page's body (T6 review m2).
    await expect(list).toHaveCount(0);
    await expect(p.getByTestId("me-qm-status")).toHaveText(ui("quickMatch.me.deleted", { name: renamed }));
    await expect(p.getByTestId("me-qm-root")).toBeFocused();
    expect(await namesRecordOf(made), "the record is gone").toBeNull();
    const [left] = await withDb((sql) => sql<{ n: number }[]>`
      select count(*)::int as n from competitions where id = ${before!.competition_id}`);
    expect(left!.n, "the competition is gone with it").toBe(0);
    // The page's own read agrees: reloaded, the account page has no Quick matches.
    await p.reload();
    await expect(p.locator("h1.page-title")).toHaveText(ui("me.title"), { timeout: STEP_MS });
    await expect(p.getByTestId("me-quick-matches")).toHaveCount(0);
    await expect(p.getByRole("heading", { name: ui("quickMatch.me.title") })).toHaveCount(0);

    // The link, for everyone who holds it: the second guest's browser, then the saver's own, both the dead screen.
    for (const [who, tab] of [["the second guest", q], ["the saver", p]] as const) {
      await tab.goto(made.path);
      await expect(tab.getByTestId("qm-dead-link"), `${who}: the dead screen`).toBeVisible({ timeout: STEP_MS });
      await expect(tab.getByTestId("qm-name"), `${who}: no match behind it`).toHaveCount(0);
    }
  } finally {
    await mine.close();
    await theirs.close();
  }
});

// ── (E) Not played (plan 4 Task 6) ──────────────────────────────────────────────────────────────────────────────────────

/** One rally a scorer taps, and whether it closes its game. */
interface Rally {
  side: Side;
  closesGame: boolean;
}

/** Every rally of `games`, in the order `playHeroMatch` taps them: in each game the game's loser and winner alternate while
 *  the loser scores, the winner runs to one short of the target, then closes it. `winnerSide` is the MATCH winner's seat. */
function ralliesOf(games: readonly Game[], winnerSide: Side): Rally[] {
  const out: Rally[] = [];
  for (const [w, l] of games) {
    const gameWinner = w > l ? winnerSide : otherSide(winnerSide);
    const gameLoser = otherSide(gameWinner);
    const [hi, lo] = [Math.max(w, l), Math.min(w, l)];
    let won = 0;
    for (let k = 0; k < lo; k += 1) {
      out.push({ side: gameLoser, closesGame: false });
      if (won < hi - 1) {
        out.push({ side: gameWinner, closesGame: false });
        won += 1;
      }
    }
    for (; won < hi - 1; won += 1) out.push({ side: gameWinner, closesGame: false });
    out.push({ side: gameWinner, closesGame: true });
  }
  return out;
}

/** The game in play's points after the first `n` rallies of `seq`: a closing rally opens the next game at nothing. */
function boardAfter(seq: readonly Rally[], n: number): Record<Side, number> {
  const board: Record<Side, number> = { home: 0, away: 0 };
  for (const r of seq.slice(0, n)) {
    if (r.closesGame) {
      board.home = 0;
      board.away = 0;
    } else board[r.side] += 1;
  }
  return board;
}

/** Taps `seq` from `from` to its end at a scorer's cadence, checked as `playHeroMatch` checks its own: a closed game opens
 *  the next at nothing, and before the deciding rally the board and the ledger hold every earlier one (the part tapped on
 *  an earlier visit included). Returns how many it tapped. */
async function tapFrom(p: Page, fixtureId: string, seq: readonly Rally[], from: number): Promise<number> {
  const rallies = new Rallies(p);
  for (let i = from; i < seq.length; i += 1) {
    const last = i === seq.length - 1;
    if (last) {
      const board = boardAfter(seq, i);
      await expect(points(p, "home"), "one rally short of the match").toHaveText(String(board.home));
      await expect(points(p, "away")).toHaveText(String(board.away));
      await expect
        .poll(() => ralliesRecorded(fixtureId), {
          timeout: HOLD_MS + STEP_MS + rallies.tapped * SEND_MS,
          message: "the rallies before the deciding one never all reached the ledger",
        })
        .toBe(i);
      await expect(pad(p).locator('[data-role="v3-rejection"]'), "no tap was refused").toHaveCount(0);
    }
    await rallies.tap(seq[i]!.side);
    if (seq[i]!.closesGame && !last) {
      await expect(points(p, "home"), "the next game opens at nothing").toHaveText("0");
      await expect(points(p, "away")).toHaveText("0");
    }
  }
  return rallies.tapped;
}

interface FixtureNow {
  status: string;
  events: number;
  rallies: number;
}
/** One fixture as the record holds it: its status, every event in its ledger, and its rallies. A skip and a Put back
 *  write the status only: the part played stays in the ledger as history (spec 2026-11-12 §3). */
async function fixtureNow(fixtureId: string): Promise<FixtureNow> {
  const [row] = await withDb(
    (sql) => sql<FixtureNow[]>`
      select f.status,
             (select count(*)::int from score_events e where e.fixture_id = f.id) as events,
             (select count(*)::int from score_events e where e.fixture_id = f.id and e.type = ${RALLY}) as rallies
        from fixtures f where f.id = ${fixtureId}`,
  );
  if (!row) throw new Error(`the record has no fixture ${fixtureId}`);
  return { status: row.status, events: row.events, rallies: row.rallies };
}

/** A match's two seats, by name, as the record holds them: the ⋯'s name and the sheet's title say them home first. */
async function seatsOf(made: Made, fixtureId: string): Promise<{ home: string; away: string }> {
  const { fixtures, nameOf } = await recordOf(made);
  const f = fixtures.find((x) => x.id === fixtureId);
  expect(f?.home && f.away, `the record seats both sides of match ${fixtureId}`).toBeTruthy();
  return { home: nameOf.get(f!.home!)!, away: nameOf.get(f!.away!)! };
}

/** The stored table (V218: an ordered row list), by name. */
async function storedTableOf(made: Made, nameOf: Map<string, string>): Promise<{ name: string; played: number; won: number; points: number; rank: number }[]> {
  const stored = await withDb(
    (sql) => sql<{ rows: { entrantId: string; played: number; won: number; points: number; rank: number }[] }[]>`
      select s.rows from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join stages st on st.division_id = d.id
      join standings_snapshots s on s.stage_id = st.id and s.pool_id is null
      where q.token_hash = ${tokenHash(made.token)}`,
  );
  expect(stored, "one stored table for the league's one stage").toHaveLength(1);
  return stored[0]!.rows.map((r) => ({ name: nameOf.get(r.entrantId)!, played: r.played, won: r.won, points: r.points, rank: r.rank }));
}

/**
 * A row's "Not played", by hand, up to the sheet: the ⋯ (once the island has hydrated: before it, "Not played" posts with
 * no sheet at all, D7), named for its match; "Not played" with its hint; the sheet, open, its title naming the match and
 * its two answers, each a 44px target. Returns the open sheet.
 */
async function openSkipSheet(p: Page, row: Locator, seats: { home: string; away: string }): Promise<Locator> {
  await waitForHydration(row.getByTestId("qm-row-menu"), { timeout: STEP_MS });
  const toggle = row.getByTestId("qm-row-menu-toggle");
  await expect(toggle, "the ⋯ names its match").toHaveAccessibleName(ui("quickMatch.home.moreActions", seats));
  expect((await toggle.boundingBox())?.height ?? 0, "the ⋯ is a 44px target").toBeGreaterThanOrEqual(44);
  await toggle.click();
  const skip = row.getByTestId("qm-skip");
  await expect(skip).toBeVisible();
  await expect(skip).toContainText(ui("quickMatch.home.notPlayed"));
  await expect(skip).toContainText(ui("quickMatch.home.notPlayedHint"));
  await skip.click();
  const sheet = row.getByTestId("qm-skip-sheet");
  await expect(sheet, "Not played asks first").toBeVisible();
  await expect(sheet.getByTestId("qm-skip-title")).toHaveText(ui("quickMatch.skip.title", seats));
  const answers = [
    [sheet.getByTestId("qm-skip-confirm"), ui("quickMatch.skip.confirm")],
    [sheet.getByTestId("qm-skip-keep"), ui("quickMatch.skip.keep")],
  ] as const;
  for (const [button, words_] of answers) {
    await expect(button).toHaveText(words_);
    expect((await button.boundingBox())?.height ?? 0, `${words_} is a 44px target`).toBeGreaterThanOrEqual(44);
  }
  await expectNoHorizontalScroll(p);
  return sheet;
}

/** One skip: the ⋯ hydration, measure and tap, Not played read and tapped, the sheet's words read and its two answers
 *  measured, "Mark not played"; the post's 303 back to the home, the row read back; the record before and after. */
const SKIP = { navs: 1, acts: 10, reads: 2 } as const;
/** "Keep this match": the sheet opened as a skip opens it, Keep, the sheet closed and the row as it was; the record. */
const KEEP = { navs: 0, acts: 10, reads: 1 } as const;
/** Put back: the ⋯, Put back read, measured and tapped; the 303 and the row read back; the record. */
const PUT_BACK = { navs: 1, acts: 4, reads: 1 } as const;
/** The rest of (E): the setup page and Start, for each league; the half-played match's first visit to the pad and its
 *  Back (the second visit is the match's own, PER_MATCH); the setup page's Continue card and its link back; "Start a new
 *  quick match" and the setup page it opens. The home's reads between, the matches' rows, the ledger before leaving the
 *  pad, the record after the second match, the seats of three matches and the stored table. */
const NIGHT = { navs: 10, acts: 36, reads: 8 } as const;

test("(E) Not played: a guest's league of three skips its half-played match and puts it back, then skips its last match and finishes on the two played, naming its winner; a league of two skipped entirely says no matches were played", async ({ browser }, info) => {
  const rules = leagueRules();
  const sides = [`Curlew Abara ${TAG}`, `Merlin Castellanos ${TAG}`, `Tern Haugland ${TAG}`];
  const total = (sides.length * (sides.length - 1)) / 2;
  // Two matches are played, both won by the one side that plays in both of them (the side the LAST match leaves out), so
  // the league finishes with one leader on 2 wins. The second is left part-way first: `part` rallies of its first game.
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 1], [rules.setTo, 2]],
    [[rules.setTo, 3], [rules.setTo, 5]],
  ];
  plans.forEach((g, i) => checkPlan(rules, g, `(E) match ${i + 1}`));
  const skips = 3;
  setBudget(
    budgetFor({
      navs: NIGHT.navs + skips * SKIP.navs + KEEP.navs + PUT_BACK.navs,
      acts: NIGHT.acts + skips * SKIP.acts + KEEP.acts + PUT_BACK.acts,
      reads: NIGHT.reads + skips * SKIP.reads + KEEP.reads + PUT_BACK.reads,
      plans,
    }),
  );
  const night = await browser.newContext({
    storageState: await consentedAnonymousState(),
    baseURL: info.project.use.baseURL,
    viewport: PHONE,
  });
  try {
    const p = await night.newPage();
    const next = p.locator('[data-testid="qm-match"][data-next="true"]');
    const listOrder = () => p.getByTestId("qm-match").evaluateAll((els) => els.map((el) => el.getAttribute("data-fixture-id")));

    // ---- 1. A league of three, its three matches ----
    await p.goto("/en/play");
    const made = await startQuickMatch(p, `QM walk not played ${TAG}`, sides, total);
    await expectPlayedLine(p, { played: 0, notPlayed: 0, total });
    await expect(p.locator('[data-testid="qm-match"][data-state="ready"]'), "every match ready to score").toHaveCount(total);
    const listed = await p.getByTestId("qm-match").evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute("data-fixture-id") ?? "",
        n: Number(el.querySelector('[data-testid="qm-match-no"]')?.textContent),
        sides: el.querySelector('[data-testid="qm-match-sides"]')?.textContent ?? "",
      })),
    );
    const matchNo = (n: number) => {
      const m = listed.find((x) => x.n === n);
      expect(m, `the home lists match ${n}`).toBeDefined();
      return { ...m!, named: sides.filter((s) => m!.sides.includes(s)) };
    };
    const [m1, m2, m3] = [matchNo(1), matchNo(2), matchNo(3)];
    let paired = 0;
    for (const m of [m1, m2, m3]) {
      expect(m.named, `match ${m.n} names two of the league's sides`).toHaveLength(2);
      paired += 1;
    }
    expect(paired, "anti-vacuity: matches read").toBe(total);
    const champion = sides.find((s) => !m3.named.includes(s))!;
    expect([m1.named, m2.named].every((n) => n.includes(champion)), "the side the last match leaves out plays both others").toBe(true);

    // ---- 2. Match 1, played by hand ----
    await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total }));
    const first = await playHeroMatch(p, made, plans[0]!, () => champion, "after-result");
    expect(first.fixtureId, "the hero's first match is match 1").toBe(m1.id);
    await expectPlayedLine(p, { played: 1, notPlayed: 0, total });
    await expectTable(p, tableOf(sides, [first], rules));

    // ---- 3. Match 2, left part-way: Start, a few rallies of its first game, Back ----
    await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 2, total }));
    await expect(next).toHaveAttribute("data-fixture-id", m2.id);
    const seats2 = await seatsOf(made, m2.id);
    await expect(p.getByTestId("qm-hero-home"), "the hero seats match 2 as the record does").toHaveText(seats2.home);
    await expect(p.getByTestId("qm-hero-away")).toHaveText(seats2.away);
    const champSide: Side = seats2.home === champion ? "home" : "away";
    const seq = ralliesOf(plans[1]!, champSide);
    expect(seq, "one rally per point of the plan").toHaveLength(tapsOf(plans[1]!));
    const part = 5;
    expect(seq.slice(0, part).some((r) => r.closesGame), "the part played stays inside the first game").toBe(false);
    const partBoard = boardAfter(seq, part);
    expect(partBoard.home, "a part score that reads differently home first and away first").not.toBe(partBoard.away);
    await p.getByTestId("qm-hero").getByTestId("qm-score").click();
    await p.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: STEP_MS });
    await expect(p.getByTestId("scan-confirm")).toBeVisible({ timeout: STEP_MS });
    await p.getByTestId("score-start-match").click();
    await expect(tapTarget(p, "home"), "Start opens the pad").toBeVisible({ timeout: STEP_MS });
    const partTaps = new Rallies(p);
    for (const r of seq.slice(0, part)) await partTaps.tap(r.side);
    await expect(points(p, "home")).toHaveText(String(partBoard.home));
    await expect(points(p, "away")).toHaveText(String(partBoard.away));
    await expect
      .poll(() => ralliesRecorded(m2.id), {
        timeout: HOLD_MS + STEP_MS + part * SEND_MS,
        message: "the part played never reached the ledger",
      })
      .toBe(part);
    await p.getByTestId("quick-match-back-link").click();
    await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });
    const row2 = matchRow(p, m2.id);
    await expect(row2, "match 2 is live on the home").toHaveAttribute("data-state", "live", { timeout: STEP_MS });
    // The row's score as it stands, home first: the live points the taps made, last.
    const liveScore = new RegExp(`(?:^|\\D)${partBoard.home}\\D+${partBoard.away}\\s*$`);
    await expect(row2.getByTestId("qm-match-score")).toHaveText(liveScore);
    const shown = (await row2.getByTestId("qm-match-score").textContent())!.trim();
    await expect(p.getByTestId("qm-hero-kicker"), "the hero is the live match").toHaveText(ui("quickMatch.home.liveMatch", { n: 2, total }));
    const live = await fixtureNow(m2.id);
    expect([live.status, live.rallies], "the record: in play, the part played in the ledger").toEqual(["in_play", part]);

    // ---- 4. Not played, then "Keep this match": the sheet says the score it had and that it can be put back ----
    const kept = await openSkipSheet(p, row2, seats2);
    await expect(kept.getByTestId("qm-skip-partial"), "the score that will not count").toHaveText(ui("quickMatch.skip.partial", { score: shown }));
    await expect(kept.getByTestId("qm-skip-body"), "a match is left after it: it can be put back").toHaveText(ui("quickMatch.skip.body"));
    await kept.getByTestId("qm-skip-keep").click();
    await expect(kept, "Keep closes the sheet").toBeHidden();
    await expect(row2, "Keep changes nothing").toHaveAttribute("data-state", "live");
    expect(await fixtureNow(m2.id), "Keep writes nothing").toEqual(live);

    // ---- 5. Not played, "Mark not played": the row, the line, the table untouched, the hero on to match 3 ----
    const skipping = await openSkipSheet(p, row2, seats2);
    await skipping.getByTestId("qm-skip-confirm").click();
    await expect(row2, "the post lands the row Not played").toHaveAttribute("data-state", "notPlayed", { timeout: STEP_MS });
    expect(new URL(p.url()).search, "the bare home: no refusal").toBe("");
    await expect(p.getByTestId("qm-flash")).toHaveCount(0);
    await expect(row2.getByTestId("qm-not-played")).toHaveText(ui("quickMatch.home.notPlayed"));
    await expect(row2.getByTestId("qm-match-sides")).toHaveText(`${seats2.home} ${ui("quickMatch.home.versus")} ${seats2.away}`);
    await expectPlayedLine(p, { played: 1, notPlayed: 1, total });
    await expect(p.getByTestId("qm-standings-note")).toHaveText(ui("quickMatch.home.countsPlayedOnly"));
    await expectTable(p, tableOf(sides, [first], rules));
    await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 3, total }));
    await expect(next).toHaveAttribute("data-fixture-id", m3.id);
    // Plan 4 D8: still to play first, then Not played, then finished.
    expect(await listOrder(), "open, then Not played, then finished").toEqual([m3.id, m2.id, m1.id]);
    await expectNoHorizontalScroll(p);
    expect(await fixtureNow(m2.id), "Not played: the status, and nothing appended (the part played stays as history)").toEqual({
      ...live,
      status: "cancelled",
    });

    // ---- 6. The guest leaves and comes back: the setup page offers the league to continue, in the home's own words ----
    await p.goto("/en/play");
    const resume = p.getByTestId("qm-continue");
    await expect(resume, "a league with a match left is offered to continue").toBeVisible({ timeout: STEP_MS });
    await expect(p.getByTestId("qm-continue-played")).toHaveText(playedWords({ played: 1, notPlayed: 1, total }, false));
    await p.getByTestId("qm-continue-link").click();
    await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });

    // ---- 7. Put back: the row live again, at the score it had ----
    await waitForHydration(row2.getByTestId("qm-row-menu"), { timeout: STEP_MS });
    await row2.getByTestId("qm-row-menu-toggle").click();
    const putBack = row2.getByTestId("qm-put-back");
    await expect(putBack).toHaveText(ui("quickMatch.home.putBack"));
    expect((await putBack.boundingBox())?.height ?? 0, "Put back is a 44px target").toBeGreaterThanOrEqual(44);
    await putBack.click();
    await expect(row2, "Put back: live again").toHaveAttribute("data-state", "live", { timeout: STEP_MS });
    await expect(row2.getByTestId("qm-match-score"), "at the score it had").toHaveText(shown);
    expect(await fixtureNow(m2.id), "Put back: exactly as it was before the skip").toEqual(live);
    await expectPlayedLine(p, { played: 1, notPlayed: 0, total });
    await expect(p.getByTestId("qm-standings-note"), "nothing Not played: no note").toHaveCount(0);
    await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.liveMatch", { n: 2, total }));
    await expect(next).toHaveAttribute("data-fixture-id", m2.id);

    // ---- 8. Score: the pad resumes at the score it had; the rest of the match tapped ----
    await p.getByTestId("qm-hero").getByTestId("qm-score").click();
    await p.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: STEP_MS });
    await expect(tapTarget(p, "home"), "a live match opens on its pad").toBeVisible({ timeout: STEP_MS });
    await expect(p.getByTestId("scan-confirm"), "no Start: it is already in play").toHaveCount(0);
    await expect(points(p, "home"), "the pad resumes at the score it had").toHaveText(String(partBoard.home));
    await expect(points(p, "away")).toHaveText(String(partBoard.away));
    const rest = await tapFrom(p, m2.id, seq, part);
    expect(part + rest, "every rally of the plan was tapped, over the two visits").toBe(tapsOf(plans[1]!));
    await expect(p.getByText(ui("device.quickMatch.resultSaved")), "decided").toBeVisible({ timeout: DECIDE_MS });
    await p.getByTestId("quick-match-back-link").click();
    await p.waitForURL((url) => url.pathname === made.path, { timeout: STEP_MS });
    await expectSettledOnHome(p, m2.id);
    const second: Played = {
      fixtureId: m2.id,
      ...seats2,
      winner: champion,
      loser: champSide === "home" ? seats2.away : seats2.home,
      winnerSide: champSide,
      games: plans[1]!,
      taps: tapsOf(plans[1]!),
    };
    await expect(row2.getByTestId("qm-match-sides")).toHaveText(ui("quickMatch.home.result", { winner: second.winner, loser: second.loser }));
    await expect(row2.getByTestId("qm-match-score"), "the games read winner first").toHaveText(winnerFirst(second.games));
    const results = [first, second];
    await expectPlayedLine(p, { played: 2, notPlayed: 0, total });
    await expectTable(p, tableOf(sides, results, rules));
    // Both results in the record, every rally through the one link, the part tapped before the skip counted once.
    expect(await expectRecorded(made, results)).toBe(results.length);

    // ---- 9. The last match, Not played: the sheet says the league finishes now and the skip cannot be put back ----
    const row3 = matchRow(p, m3.id);
    await expect(row3).toHaveAttribute("data-state", "ready");
    const last = await openSkipSheet(p, row3, await seatsOf(made, m3.id));
    await expect(last.getByTestId("qm-skip-partial"), "nothing scored: no score line").toHaveCount(0);
    await expect(last.getByTestId("qm-skip-body"), "the last match left").toHaveText(ui("quickMatch.skip.bodyLast"));
    await last.getByTestId("qm-skip-confirm").click();
    await expect(row3, "the post lands the row Not played").toHaveAttribute("data-state", "notPlayed", { timeout: STEP_MS });

    // ---- 10. Finished on the two played: the winner, how many were not played, the Final table, no Put back ----
    const table = tableOf(sides, results, rules);
    expect(table.map((t) => t.won), "one leader on two wins").toEqual([2, 0, 0]);
    expect(table[0]!.name, "the side that won both its matches").toBe(champion);
    await expectPlayedLine(p, { played: 2, notPlayed: 1, total });
    await expect(p.getByTestId("qm-hero"), "nothing left to play").toHaveCount(0);
    await expect(p.getByTestId("qm-winner-kicker")).toHaveText(ui("quickMatch.home.winner"));
    await expect(p.getByTestId("qm-winner-name")).toHaveText([champion]);
    await expect(p.getByTestId("qm-winner-note"), "a short league is never mistaken for a full one").toHaveText(
      `${plural(ui, "quickMatch.home.winnerAfter", 2)} ${plural(ui, "quickMatch.home.winnerSkipped", 1)}`,
    );
    await expect(p.getByTestId("qm-standings-title")).toHaveText(ui("quickMatch.home.finalTable"));
    await expect(p.getByTestId("qm-standings-note")).toHaveText(ui("quickMatch.home.countsPlayedOnly"));
    await expectTable(p, table);
    await expect(row3.getByTestId("qm-not-played")).toHaveText(ui("quickMatch.home.notPlayed"));
    await expect(row3.getByTestId("qm-row-menu"), "finished: nothing to put back, so no ⋯").toHaveCount(0);
    await expect(p.getByTestId("qm-put-back"), "no Put back anywhere once finished").toHaveCount(0);
    expect(await listOrder(), "Not played, then finished in play order").toEqual([m3.id, m1.id, m2.id]);
    await expectNoHorizontalScroll(p);
    expect(await fixtureNow(m3.id), "skipped untouched: nothing in its ledger").toEqual({ status: "cancelled", events: 0, rallies: 0 });
    const { nameOf } = await recordOf(made);
    const stored = await storedTableOf(made, nameOf);
    const byName = <T extends { name: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
    expect(
      byName(stored.map(({ name, played, won, points: pts }) => ({ name, played, won, points: pts }))),
      "the stored table counts the two played matches only",
    ).toEqual(byName(table.map(({ name, played, won, points: pts }) => ({ name, played, won, points: pts }))));
    expect([stored[0]!.name, stored[0]!.rank], "the stored table's leader").toEqual([champion, 1]);

    // ---- 11. A league of two, its only match Not played: no winner and no table ----
    await p.goto("/en/play");
    await expect(form(p)).toBeVisible({ timeout: STEP_MS });
    await expect(p.getByTestId("qm-recent"), "the league finished by a skip is listed").toContainText(made.name);
    await expect(p.getByTestId("qm-continue"), "…and is not offered to continue").toHaveCount(0);
    const washout = await startQuickMatch(p, `QM walk washout ${TAG}`, [`Gannet Oyelaran ${TAG}`, `Shrike Vasquez ${TAG}`], 1);
    await expectPlayedLine(p, { played: 0, notPlayed: 0, total: 1 });
    await expect(p.getByTestId("qm-match")).toHaveCount(1);
    const onlyId = (await p.getByTestId("qm-match").getAttribute("data-fixture-id"))!;
    const only = matchRow(p, onlyId);
    const sheet = await openSkipSheet(p, only, await seatsOf(washout, onlyId));
    await expect(sheet.getByTestId("qm-skip-partial")).toHaveCount(0);
    await expect(sheet.getByTestId("qm-skip-body"), "its only match is its last").toHaveText(ui("quickMatch.skip.bodyLast"));
    await sheet.getByTestId("qm-skip-confirm").click();
    await expect(only, "the post lands the row Not played").toHaveAttribute("data-state", "notPlayed", { timeout: STEP_MS });
    await expect(p.getByTestId("qm-no-play-kicker")).toHaveText(ui("quickMatch.home.leagueFinished"));
    await expect(p.getByTestId("qm-no-play-title")).toHaveText(ui("quickMatch.home.noPlay"));
    await expect(p.getByTestId("qm-no-play-hint")).toHaveText(plural(ui, "quickMatch.home.noPlayHint", 1));
    await expectPlayedLine(p, { played: 0, notPlayed: 1, total: 1 });
    for (const id of ["qm-standings", "qm-winner", "qm-hero"]) await expect(p.getByTestId(id), `no play: no ${id}`).toHaveCount(0);
    await expect(only.getByTestId("qm-row-menu"), "finished: no Put back").toHaveCount(0);
    await expectNoHorizontalScroll(p);
    expect(await fixtureNow(onlyId), "skipped untouched").toEqual({ status: "cancelled", events: 0, rallies: 0 });

    // ---- 12. "Start a new quick match": the setup page, with neither league to continue ----
    const start = p.getByTestId("qm-no-play-start");
    await expect(start).toHaveText(ui("quickMatch.dead.startNew"));
    expect((await start.boundingBox())?.height ?? 0, "Start a new quick match is a 44px target").toBeGreaterThanOrEqual(44);
    await start.click();
    await p.waitForURL((url) => url.pathname === "/en/play", { timeout: STEP_MS });
    await expect(form(p)).toBeVisible({ timeout: STEP_MS });
    const recent = p.getByTestId("qm-recent").getByRole("link");
    await expect(recent, "this browser's two leagues, newest first").toHaveCount(2);
    await expect(recent.nth(0)).toHaveAttribute("href", washout.path);
    await expect(recent.nth(1)).toHaveAttribute("href", made.path);
    await expect(p.getByTestId("qm-continue"), "both finished: nothing to continue").toHaveCount(0);
  } finally {
    await night.close();
  }
});

// ── (F) League + Knockout (plan 5 Task 9) ───────────────────────────────────────────────────────────────────────────────
//
// WHERE (F)'s EXPECTED VALUES COME FROM: the seeding is the spec's (§2: semi-finals 1st v 4th and 2nd v 3rd, a final of
// the top 2; plan 5 Global Constraints); the league table is tallied in this file from the results tapped (`tableOf`); the
// champion is the side the final's taps were made for; and the side a Toss sends through is the lot the ENGINE stored in
// the league's table before Toss was tapped (spec §11: Toss reveals the stored lot, there is no second draw). Every sentence
// is the en dictionary's.

/** One stage of the quick match's division, in its order (`seq`). */
interface StageRecord {
  id: string;
  kind: string;
  status: string;
}
async function stagesOf(made: Made): Promise<StageRecord[]> {
  return withDb(
    (sql) => sql<StageRecord[]>`
      select st.id, st.kind, st.status from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join stages st on st.division_id = d.id
      where q.token_hash = ${tokenHash(made.token)}
      order by st.seq`,
  );
}

/** A knockout stage's seed proposals, oldest first: each one's status and who it sends where (by league place). */
interface ProposalRecord {
  status: string;
  qualifiers: { leagueRank: number; entrantId: string }[];
}
async function proposalsOf(stageId: string): Promise<ProposalRecord[]> {
  const rows = await withDb(
    (sql) => sql<{ status: string; computed: { qualifiers?: { source: { rank: number }; entrantId: string }[] } }[]>`
      select status, computed from stage_seed_proposals where stage_id = ${stageId} order by created_at, id`,
  );
  return rows.map((r) => ({
    status: r.status,
    qualifiers: (r.computed.qualifiers ?? []).map((x) => ({ leagueRank: x.source.rank, entrantId: x.entrantId })),
  }));
}

/** The league stage's stored table (V218: ordered rows), with the engine's tie marks. */
interface StoredRow {
  entrantId: string;
  played: number;
  won: number;
  points: number;
  rank: number;
  tieUnbroken?: boolean;
  tieBreak?: { key?: string; with?: string[] };
}
async function leagueTableOf(made: Made): Promise<StoredRow[]> {
  const stored = await withDb(
    (sql) => sql<{ rows: StoredRow[] }[]>`
      select s.rows from quick_matches q
      join divisions d on d.competition_id = q.competition_id
      join stages st on st.division_id = d.id and st.kind = 'league'
      join standings_snapshots s on s.stage_id = st.id and s.pool_id is null
      where q.token_hash = ${tokenHash(made.token)}`,
  );
  expect(stored, "one stored table for the league stage").toHaveLength(1);
  return stored[0]!.rows;
}

/** The quick match's answer to a tie at the cut (plan 5 D5), or null while nobody has answered. */
interface CutDecision {
  how: string;
  through: string[];
  tie: string[];
  at: string;
}
async function cutDecisionOf(made: Made): Promise<CutDecision | null> {
  const [row] = await withDb(
    (sql) => sql<{ d: CutDecision | null }[]>`select cut_decision as d from quick_matches where token_hash = ${tokenHash(made.token)}`,
  );
  if (!row) throw new Error("the quick match has no row");
  return row.d;
}

/** A knockout stage's lines in bracket order, as the record holds them. */
interface KnockoutLine {
  id: string;
  isFinal: boolean;
  status: string;
  winner: string | null;
  home: string | null;
  away: string | null;
}
async function knockoutLinesOf(stageId: string): Promise<KnockoutLine[]> {
  return withDb(
    (sql) => sql<KnockoutLine[]>`
      select id, is_final as "isFinal", status, outcome->>'winner' as winner, home_entrant_id as home, away_entrant_id as away
        from fixtures where stage_id = ${stageId} order by round_no, fixture_no`,
  );
}

/**
 * "Setting up the knockout" (spec §11, plan 5 T7 (c)) is what a guest sees when the league is done and the knockout did not
 * fill. Nothing a guest does can make the fill fail, so the record does it: a trigger refuses the ONE write that fills THIS
 * knockout (its seed proposal turning `confirmed`, inside the confirm's own transaction, which then rolls back whole). It is
 * scoped to one stage id, so no other test's knockout is touched, and `releaseKnockout` drops it (always, in a `finally`).
 * Never a product switch: the database refusing a write is the failure §11 owes a calm screen for.
 */
const HOLD = `qm_walk_hold_${TAG}`;
async function holdKnockout(stageId: string): Promise<void> {
  expect(stageId, "the hold names a stage by its uuid").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(HOLD, "the hold's name is a plain identifier").toMatch(/^[a-z0-9_]+$/);
  await withDb(async (sql) => {
    await sql.unsafe(`create function ${HOLD}() returns trigger language plpgsql as $hold$
      begin
        if new.stage_id = '${stageId}'::uuid and new.status = 'confirmed' then
          raise exception 'walkthrough (F) holds knockout % in Setting up', new.stage_id;
        end if;
        return new;
      end $hold$`);
    await sql.unsafe(`create trigger ${HOLD} before insert or update on stage_seed_proposals for each row execute function ${HOLD}()`);
  });
}
async function releaseKnockout(): Promise<void> {
  await withDb(async (sql) => {
    await sql.unsafe(`drop trigger if exists ${HOLD} on stage_seed_proposals`);
    await sql.unsafe(`drop function if exists ${HOLD}()`);
  });
}

/** The played line of a League + Knockout (D8): the whole match's N of M, then how M splits while the league is on, or that
 *  the knockout is on once it has filled (`part`); a finished one says neither, and no countdown. */
async function expectLkPlayedLine(p: Page, c: Counts, part: string | null): Promise<void> {
  const finished = isFinished(c);
  const line = playedWords(c, !finished);
  await expect(p.getByTestId("qm-played"), finished ? "finished: no countdown" : "a match left: the countdown").toHaveText(
    part === null ? line : `${line} · ${part}`,
  );
  if (finished) await expect(p.getByTestId("qm-not-saved"), "finished: its deletion is the dated line").toHaveText(notSavedLine());
}

/** The home's two blocks, the table and the knockout, in page order (§12: the bracket moves above the table once filled). */
const blockOrder = (p: Page) =>
  p
    .locator('[data-testid="qm-standings"], [data-testid="qm-knockout"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));

/** Every knockout card as drawn: its name, whether it is the hero's, and each seat's words (a name, or what it waits on),
 *  its note ("1st", "2nd · by lot") and whether it is the winner's line. */
interface CardRead {
  id: string;
  round: string | null;
  next: boolean;
  seats: { label: string; note: string | null; winner: boolean }[];
}
const knockoutCards = (p: Page): Promise<CardRead[]> =>
  p.getByTestId("qm-draw-card").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-fixture-id") ?? "",
      round: el.querySelector('[data-testid="qm-draw-round"]')?.textContent?.trim() ?? null,
      next: el.getAttribute("data-next") === "true",
      seats: Array.from(el.querySelectorAll('[data-testid="qm-draw-seat"]')).map((s) => ({
        label: s.querySelector('[data-testid="qm-draw-name"]')?.textContent?.trim() ?? "",
        note: s.querySelector('[data-testid="qm-draw-note"]')?.textContent?.trim() ?? null,
        winner: s.getAttribute("data-winner") === "true",
      })),
    })),
  );
/** Pairings, order-free: who meets whom, never who is seated home (plan 5 T7 review G2: home and away are the engine's). */
const pairing = (pairs: readonly (readonly string[])[]) => pairs.map((x) => [...x].sort().join(" | ")).sort();
const pairsOn = (cards: readonly CardRead[]) => pairing(cards.map((c) => c.seats.map((s) => s.label)));

/** A League + Knockout's table row, by the side's name (a row's header also holds its tag, "decided by lot"). */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lkRow = (p: Page, name: string) =>
  p.getByTestId("qm-standings-row").filter({ has: p.getByRole("rowheader").filter({ hasText: new RegExp(`^${escapeRe(name)}`) }) });

/** A League + Knockout's table (plan 5 T7): every side's P, W, Pts, and no leader (its winner is the final's); where given,
 *  each row's place as printed ("=" for a side level at the cut) and its tag (null: none). */
async function expectLkTable(
  p: Page,
  table: readonly Tally[],
  marks: { places?: ReadonlyMap<string, string>; tags?: ReadonlyMap<string, string | null> } = {},
): Promise<void> {
  let checked = 0;
  for (const t of table) {
    const row = lkRow(p, t.name);
    await expect(row.getByTestId("qm-cell"), `${t.name}: P, W, Pts`).toHaveText(cellsOf(t));
    const place = marks.places?.get(t.name);
    if (place !== undefined) await expect(row.locator("td:first-child"), `${t.name}: its place`).toHaveText(place);
    if (marks.tags?.has(t.name)) {
      const tag = marks.tags.get(t.name)!;
      const shown = row.getByTestId("qm-standings-tag");
      if (tag === null) await expect(shown, `${t.name}: no tag`).toHaveCount(0);
      else await expect(shown, `${t.name}: its tag`).toHaveText(tag);
    }
    checked += 1;
  }
  expect(checked, "anti-vacuity: table rows checked").toBe(table.length);
  await expect(p.getByTestId("qm-standings-row"), "one row per side").toHaveCount(table.length);
  await expect(p.locator('[data-testid="qm-standings-row"][data-leader="true"]'), "a League + Knockout's table names no leader").toHaveCount(0);
}

/** "Beat {loser} in the final, {score}." with the final's games, winner first: the words pinned, the score by its numbers. */
function championBeatLine(loser: string, games: readonly Game[]): RegExp {
  const [before, after] = ui("quickMatch.home.championBeat", { loser, score: "@@score@@" }).split("@@score@@");
  return new RegExp(`^${escapeRe(before!)}${games.map(([w, l]) => `${w}\\D+${l}`).join("\\D+")}${escapeRe(after!)}$`);
}

/** A guest of their own: no session, the cookie banner answered, a phone. */
const newGuest = async (browser: Browser, baseURL: string | undefined) =>
  browser.newContext({ storageState: await consentedAnonymousState(), baseURL, viewport: PHONE });

/** (F1)'s steps beyond its matches: the setup page, Start, and Refresh; the semi-finals chosen; the home's first paint (the
 *  eyebrow, the line, the hero, the list, the three cards and their seats, the table's caption, the blocks' order), Setting
 *  up (its card, Refresh measured, the bracket still waiting, the table), the fill (the hero, the order, the cards' names,
 *  seats and notes, the line, the table); the stages and proposals at the start, on the pad, at Setting up and after the
 *  fill, the hold and its release, the stored table and the record. */
const KO_LEAGUE = { navs: 3, acts: 36, reads: 10 } as const;
/** (F2)'s steps beyond its three matches: the bracket read after each, the hero's next round, the champion card and the
 *  finished line; the stages, the proposal, the final's line and the record. */
const KO_PLAY = { navs: 0, acts: 18, reads: 4 } as const;
/** (F3)'s steps beyond its six matches: the setup page and Start; the home's first paint (the line, the list, the final's
 *  seats, the caption), the question read and its two answers measured, the bracket, the table and the line at it; the
 *  stages, proposals and decision at the question, the stored lot, and the record. */
const KO_TIE = { navs: 2, acts: 24, reads: 6 } as const;
/** (F4)'s steps: the friend's home, Toss's 303, the reload, the friend's stale Toss and its fresh load; the result, the hero
 *  and the final's seats read four times, the order, caption, table and line once; the decision, proposals, stages and
 *  final line after the toss, the decision again after the friend's, and the record. */
const KO_TOSS = { navs: 5, acts: 26, reads: 6 } as const;

test("(F1) League → Semi-finals → Final: four friends play the league by taps; when it ends the knockout reads Setting up, then fills itself from the table, 1st v 4th and 2nd v 3rd", async ({ browser }, info) => {
  const rules = leagueRules();
  // Typed in this order, and the plan makes the table strict in that order: each side beats every side typed after it
  // (3, 2, 1, 0 wins), so no tie-break places anyone and nobody is asked (with all four going through, a tie would be the
  // lot's anyway, D4 case 2). The long name finishes last in the league; (F2) then makes it the champion.
  const longName = `The Remarkably Long-Named Knockout Night Club ${TAG}`;
  expect(longName.replace(` ${TAG}`, "").length, "premise: the long side is 40+ characters").toBeGreaterThanOrEqual(40);
  const sides = [`Wren Adeyemi ${TAG}`, `Ibis Kowalczyk ${TAG}`, `Heron Takahashi ${TAG}`, longName];
  const q = QUALIFIERS.semis;
  const league = leagueMatches(sides.length, 1);
  const total = league + knockoutMatches(q);
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 1], [rules.setTo, 2]],
    [[rules.setTo, 0], [rules.setTo, 3]],
    [[rules.setTo, 2], [rules.setTo, 1]],
    [[rules.setTo, 3], [rules.setTo, 0]],
    [[rules.setTo, 1], [rules.setTo, 1]],
    [[rules.setTo, 2], [rules.setTo, 2]],
  ];
  expect(plans, "one plan per match a round robin of four plays").toHaveLength(league);
  plans.forEach((g, i) => checkPlan(rules, g, `(F1) league match ${i + 1}`));
  setBudget(budgetFor({ navs: KO_LEAGUE.navs, acts: KO_LEAGUE.acts, reads: KO_LEAGUE.reads, plans }));
  const typedFirst = (h: string, a: string) => (sides.indexOf(h) < sides.indexOf(a) ? h : a);
  const rank = (r: number) => ui(`quickMatch.home.leagueRank.${r}`);
  const semi = (n: number) => ui("quickMatch.home.semiFinal", { n });
  const finalName = ui("bracket.round.final");
  const waitsOnSemis = [ui("quickMatch.home.winnerOfSemi", { n: 1 }), ui("quickMatch.home.winnerOfSemi", { n: 2 })].sort();
  const splitPart = ui("quickMatch.home.stagePart.split", { league, knockout: knockoutMatches(q) });

  const ctx = await newGuest(browser, info.project.use.baseURL);
  let handedOn = false;
  try {
    const p = await ctx.newPage();

    // ---- 1. The setup page: four sides, League → Semi-finals → Final; Start counts the league and the knockout ----
    await p.goto("/en/play");
    const made = await startQuickMatch(p, `QM walk knockout ${TAG}`, sides, total, { shape: "semis" });

    // ---- 2. The home: the league up next; the knockout drawn already, waiting on the table ----
    await expect(p.getByTestId("qm-eyebrow")).toContainText(ui("quickMatch.format.league_knockout"));
    await expectLkPlayedLine(p, { played: 0, notPlayed: 0, total }, splitPart);
    await expect(p.getByTestId("qm-hero-kicker"), "the hero counts league matches only (D8)").toHaveText(
      ui("quickMatch.home.upNext", { n: 1, total: league }),
    );
    await expect(p.getByTestId("qm-match"), "the match list is the league's").toHaveCount(league);
    await expect(p.getByTestId("qm-draw-title")).toHaveText(ui("quickMatch.home.knockout"));
    await expect(p.getByTestId("qm-knockout-caption")).toHaveText(ui("quickMatch.home.knockoutFills"));
    await expect(p.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.goThrough", { count: q }));
    expect(await blockOrder(p), "while the league is on, its table comes first").toEqual(["qm-standings", "qm-knockout"]);
    const drawn = await knockoutCards(p);
    expect(drawn.map((c) => c.round), "two semi-finals, then the final").toEqual([semi(1), semi(2), finalName]);
    expect(pairsOn(drawn.slice(0, 2)), "the semi-finals wait on 1st v 4th and 2nd v 3rd").toEqual(pairing([[rank(1), rank(4)], [rank(2), rank(3)]]));
    expect(drawn[2]!.seats.map((s) => s.label).sort(), "the final waits on the semi-finals' winners").toEqual(waitsOnSemis);
    expect(drawn.flatMap((c) => c.seats).filter((s) => s.note !== null), "no side is in the knockout yet").toEqual([]);
    for (const id of ["qm-cut", "qm-setting-up", "qm-champion"]) await expect(p.getByTestId(id), `the league is on: no ${id}`).toHaveCount(0);
    await expectNoHorizontalScroll(p);
    const stages0 = await stagesOf(made);
    expect(stages0.map((s) => s.kind), "two stages: the league, then its knockout").toEqual(["league", "knockout"]);
    const koStageId = stages0[1]!.id;
    expect(await proposalsOf(koStageId), "nothing proposed before the league ends").toEqual([]);

    // ---- 3. The league, every rally tapped; before its last result, the knockout's fill is held ----
    const results: Played[] = [];
    for (const [k, games] of plans.entries()) {
      const last = k === plans.length - 1;
      if (last) await holdKnockout(koStageId);
      const played = await playHeroMatch(
        p,
        made,
        games,
        typedFirst,
        "after-result",
        last
          ? {
              // On the pad, before any home load: the deciding rally's own request ran the advance (plan 5 D2, the scoring
              // hook): the league is complete and the knockout's seeding proposed; its confirm is what the hold refused.
              beforeBack: async () => {
                await expect
                  .poll(
                    async () => [(await stagesOf(made))[0]!.status, (await proposalsOf(koStageId)).map((x) => x.status)],
                    { timeout: STEP_MS, message: "the last league result never drove the knockout's advance" },
                  )
                  .toEqual(["complete", ["draft"]]);
              },
            }
          : {},
      );
      results.push(played);
      if (!last) {
        await expectLkPlayedLine(p, { played: results.length, notPlayed: 0, total }, splitPart);
        await expectLkTable(p, tableOf(sides, results, rules));
        await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: results.length + 1, total: league }));
      }
      expect(await expectRecorded(made, [played])).toBe(1);
    }
    expect(results, "anti-vacuity: every league match was played").toHaveLength(league);
    const table = tableOf(sides, results, rules);
    expect(table.map((t) => t.won), "the plan makes a strict table").toEqual([3, 2, 1, 0]);
    expect(table.map((t) => t.name), "…in the order the sides were typed").toEqual(sides);
    const places = new Map(table.map((t, i) => [t.name, String(i + 1)]));

    // ---- 4. Setting up: the league is done, the knockout did not fill; Refresh is offered ----
    await expect(p.getByTestId("qm-setting-up-kicker")).toHaveText(ui("quickMatch.home.leagueFinished"));
    await expect(p.getByTestId("qm-setting-up-title")).toHaveText(ui("quickMatch.home.settingUp"));
    await expect(p.getByTestId("qm-setting-up-hint")).toHaveText(ui("quickMatch.home.settingUpHint"));
    const refresh = p.getByTestId("qm-refresh");
    await expect(refresh).toHaveText(ui("quickMatch.home.refresh"));
    await expect(refresh, "Refresh loads this home again").toHaveAttribute("href", made.path);
    expect((await refresh.boundingBox())?.height ?? 0, "Refresh is a 44px target").toBeGreaterThanOrEqual(44);
    for (const id of ["qm-hero", "qm-cut", "qm-cut-result", "qm-champion", "qm-winner"]) {
      await expect(p.getByTestId(id), `Setting up: no ${id}`).toHaveCount(0);
    }
    await expectLkPlayedLine(p, { played: league, notPlayed: 0, total }, splitPart);
    await expect(p.getByTestId("qm-add-match-open"), "the league is complete: no match to add").toHaveCount(0);
    await expect(p.getByTestId("qm-knockout-caption"), "no caption while it sets up").toHaveCount(0);
    expect(pairsOn((await knockoutCards(p)).slice(0, 2)), "the bracket still waits on places").toEqual(
      pairing([[rank(1), rank(4)], [rank(2), rank(3)]]),
    );
    await expect(p.getByTestId("qm-standings-title")).toHaveText(ui("quickMatch.home.finalLeagueTable"));
    await expect(p.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.goThrough", { count: q }));
    await expectLkTable(p, table, { places });
    expect(await blockOrder(p), "not filled: the table still comes first").toEqual(["qm-standings", "qm-knockout"]);
    await expectNoHorizontalScroll(p);
    expect(
      (await proposalsOf(koStageId)).map((x) => x.status),
      "every home load retried the fill, and the hold refused each: nothing confirmed",
    ).toEqual(["draft"]);

    // ---- 5. The hold released; Refresh: the knockout fills itself from the table ----
    await releaseKnockout();
    await refresh.click();
    // A same-URL load: wait on what it shows, never on the URL (which already matches).
    await expect(p.getByTestId("qm-setting-up"), "Refresh retried the fill").toHaveCount(0, { timeout: STEP_MS });
    await expect(p.getByTestId("qm-hero-kicker"), "the knockout's first card is up next").toHaveText(
      ui("quickMatch.home.upNextRound", { round: semi(1) }),
    );
    expect(await blockOrder(p), "filled: the bracket moves above the table").toEqual(["qm-knockout", "qm-standings"]);
    await expect(p.getByTestId("qm-knockout-caption"), "filled: no caption").toHaveCount(0);
    await expect(p.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.wentThrough", { count: q }));
    await expect(p.getByTestId("qm-cut-result"), "nobody was asked: no answer line").toHaveCount(0);
    const filled = await knockoutCards(p);
    expect(filled.map((c) => c.round), "the next card says so").toEqual([
      ui("quickMatch.home.upNextRound", { round: semi(1) }),
      semi(2),
      finalName,
    ]);
    expect(filled.map((c) => c.next)).toEqual([true, false, false]);
    expect(pairsOn(filled.slice(0, 2)), "1st v 4th and 2nd v 3rd, by name, from the table the taps made").toEqual(
      pairing([[table[0]!.name, table[3]!.name], [table[1]!.name, table[2]!.name]]),
    );
    let noted = 0;
    for (const seat of filled.slice(0, 2).flatMap((c) => c.seats)) {
      expect(seat.note, `${seat.label}: its league place beside its name`).toBe(ui(`quickMatch.home.rankShort.${places.get(seat.label)}`));
      noted += 1;
    }
    expect(noted, "anti-vacuity: semi-final seats read").toBe(q);
    expect(filled[2]!.seats.map((s) => s.label).sort(), "the final still waits on the semi-finals").toEqual(waitsOnSemis);
    await expectLkPlayedLine(p, { played: league, notPlayed: 0, total }, ui("quickMatch.home.stagePart.knockoutOn"));
    await expectLkTable(p, table, { places });
    await expectNoHorizontalScroll(p);

    // ---- 6. The record: the league complete, ONE confirmed proposal sending the table's top four by place ----
    const stages = await stagesOf(made);
    expect(stages[0]!.status, "the league stage is complete").toBe("complete");
    const proposals = await proposalsOf(koStageId);
    expect(proposals.map((x) => x.status), "one proposal, confirmed").toEqual(["confirmed"]);
    const { nameOf } = await recordOf(made);
    expect(
      [...proposals[0]!.qualifiers].sort((a, b) => a.leagueRank - b.leagueRank).map((x) => [x.leagueRank, nameOf.get(x.entrantId)]),
      "the knockout took the league's top four, by place",
    ).toEqual(table.map((t, i) => [i + 1, t.name]));
    expect(
      (await leagueTableOf(made)).map((r) => [nameOf.get(r.entrantId), r.rank]),
      "the stored table is the one the rallies made",
    ).toEqual(table.map((t, i) => [t.name, i + 1]));
    expect(await expectRecorded(made, results)).toBe(league);

    koNight = { ctx, p, made, table, league: results };
    handedOn = true;
  } finally {
    await releaseKnockout();
    if (!handedOn) await ctx.close();
  }
});

test("(F2) the semi-finals and the final, by taps: each winner moves into the final, and the champion is the final's winner, not the table's top", async () => {
  expect(koNight, "(F1) filled the knockout").not.toBeNull();
  const { p, made, table, league } = koNight!;
  const rules = stageRules("knockout");
  // The upset night: 4th beats 1st, 2nd beats 3rd, and 4th takes the final. The champion is the final's winner (D8), so it
  // is a side the table put LAST, and "Top of the league too" is never said of it.
  const goesOn = [table[3]!.name, table[1]!.name, table[0]!.name, table[2]!.name];
  const prefer = (h: string, a: string) => goesOn.find((x) => x === h || x === a)!;
  const plans: readonly (readonly Game[])[] = [
    [[rules.setTo, 4], [rules.setTo, 1]],
    [[rules.setTo, 2], [rules.setTo, 5]],
    [[rules.setTo, 3], [rules.setTo, 3]],
  ];
  plans.forEach((g, i) => checkPlan(rules, g, `(F2) knockout match ${i + 1}`));
  setBudget(budgetFor({ navs: KO_PLAY.navs, acts: KO_PLAY.acts, reads: KO_PLAY.reads, plans }));
  const total = league.length + plans.length;
  const semi = (n: number) => ui("quickMatch.home.semiFinal", { n });
  const finalName = ui("bracket.round.final");
  const knockoutOn = ui("quickMatch.home.stagePart.knockoutOn");
  const koStageId = (await stagesOf(made))[1]!.id;

  // ---- 1. Semi-final 1, then semi-final 2: each winner's name moves into the final ----
  const semis: Played[] = [];
  for (const n of [1, 2]) {
    await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNextRound", { round: semi(n) }));
    const played = await playHeroMatch(p, made, plans[n - 1]!, prefer, "after-result", { where: "knockout" });
    semis.push(played);
    const cards = await knockoutCards(p);
    const final = cards[2]!;
    expect(final.seats.map((s) => s.label), `the final seats semi-final ${n}'s winner`).toContain(played.winner);
    if (n === 1) {
      expect(final.seats.map((s) => s.label), "…and still waits on the other").toContain(ui("quickMatch.home.winnerOfSemi", { n: 2 }));
      await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNextRound", { round: semi(2) }));
    } else {
      expect(final.seats.map((s) => s.label).sort(), "both semi-finals' winners").toEqual(semis.map((s) => s.winner).sort());
      expect(final.round, "the final is up next").toBe(ui("quickMatch.home.upNextRound", { round: finalName }));
      expect(final.seats.map((s) => s.note), "a seat a semi-final filled carries no league place").toEqual([null, null]);
    }
    await expectLkPlayedLine(p, { played: league.length + n, notPlayed: 0, total }, knockoutOn);
    await expectNoHorizontalScroll(p);
  }
  expect(pairing(semis.map((s) => [s.home, s.away])), "the semi-finals played were 1st v 4th and 2nd v 3rd").toEqual(
    pairing([[table[0]!.name, table[3]!.name], [table[1]!.name, table[2]!.name]]),
  );
  expect(semis.map((s) => s.winner).sort(), "the planned winners went on").toEqual([table[3]!.name, table[1]!.name].sort());

  // ---- 2. The final ----
  await expect(p.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNextRound", { round: finalName }));
  const final = await playHeroMatch(p, made, plans[2]!, prefer, "after-result", { where: "knockout" });
  const champion = final.winner;
  expect(champion, "the plan's champion").toBe(table[3]!.name);
  expect(table.findIndex((t) => t.name === champion), "premise: the champion did not top the league").not.toBe(0);

  // ---- 3. Finished: the champion card names the final's winner, who they beat and by what; nothing left to play ----
  await expect(p.getByTestId("qm-champion-kicker")).toHaveText(ui("quickMatch.home.champion"));
  await expect(p.getByTestId("qm-champion-name")).toHaveText(champion);
  await expect(p.getByTestId("qm-champion-beat"), "the final's loser and score; never 'Top of the league too'").toHaveText(
    championBeatLine(final.loser, final.games),
  );
  for (const id of ["qm-hero", "qm-winner", "qm-cut-result", "qm-setting-up"]) {
    await expect(p.getByTestId(id), `finished: no ${id}`).toHaveCount(0);
  }
  await expectLkPlayedLine(p, { played: total, notPlayed: 0, total }, null);
  expect(await blockOrder(p)).toEqual(["qm-knockout", "qm-standings"]);
  await expect(p.getByTestId("qm-standings-title")).toHaveText(ui("quickMatch.home.finalLeagueTable"));
  await expectLkTable(p, table, { places: new Map(table.map((t, i) => [t.name, String(i + 1)])) });
  await expectNoHorizontalScroll(p);

  // ---- 4. The record: the final decided for the champion, against the semi-finals' winners; one confirmed proposal ----
  const { nameOf } = await recordOf(made);
  const lines = await knockoutLinesOf(koStageId);
  expect(lines, "the knockout's three lines").toHaveLength(plans.length);
  const finals = lines.filter((l) => l.isFinal);
  expect(finals, "one final").toHaveLength(1);
  const theFinal = finals[0]!;
  expect(theFinal.id, "the final played is the record's final").toBe(final.fixtureId);
  expect(theFinal.status, "decided (a guest never finalizes)").toBe("decided");
  expect(nameOf.get(theFinal.winner!), "the record's champion").toBe(champion);
  expect([nameOf.get(theFinal.home!), nameOf.get(theFinal.away!)].sort(), "the final was the semi-finals' winners").toEqual(
    semis.map((s) => s.winner).sort(),
  );
  expect((await proposalsOf(koStageId)).map((x) => x.status), "still one proposal, confirmed").toEqual(["confirmed"]);
  const stages = await stagesOf(made);
  // The league stays complete; the knockout, filled and played, is left active: nothing comes after it to complete it for,
  // and a guest never finalizes (the final reads decided above). `finished` is the final's, division-wide (plan 5 D8).
  expect(stages.map((s) => [s.kind, s.status]), "the stages as the night leaves them").toEqual([
    ["league", "complete"],
    ["knockout", "active"],
  ]);
  expect(await cutDecisionOf(made), "a strict table: nobody was asked").toBeNull();
  expect(await expectRecorded(made, [...league, ...semis, final])).toBe(total);
});

test("(F3) a tie at the cut: three sides play each other twice, steered so 2nd and 3rd end level on everything; the guests are asked, Tie for 2nd, Pick or Toss, and the engine's lot is already stored", async ({ browser }, info) => {
  const rules = leagueRules();
  const sides = [`Puffin Achebe ${TAG}`, `Gull Moreno ${TAG}`, `Skua Nakamura ${TAG}`];
  const [top, second, third] = sides as [string, string, string];
  const q = QUALIFIERS.final;
  const plays = 2;
  const league = leagueMatches(sides.length, plays);
  const total = league + knockoutMatches(q);
  // Every match is the same two games from its winner's side, so the level pair is level on every key, not on wins alone:
  // `top` beats both twice; the other two take one of their two meetings each.
  const plan: readonly Game[] = [[rules.setTo, 1], [rules.setTo, 2]];
  checkPlan(rules, plan, "(F3) every match");
  const plans: readonly (readonly Game[])[] = Array.from({ length: league }, () => plan);
  setBudget(budgetFor({ navs: KO_TIE.navs, acts: KO_TIE.acts, reads: KO_TIE.reads, plans }));
  let meetings = 0;
  const steer = (h: string, a: string) => {
    if (h === top || a === top) return top;
    meetings += 1;
    return meetings === 1 ? second : third;
  };
  const rank = (r: number) => ui(`quickMatch.home.leagueRank.${r}`);
  const level = [second, third];

  const ctx = await newGuest(browser, info.project.use.baseURL);
  let handedOn = false;
  try {
    const p = await ctx.newPage();

    // ---- 1. Three sides, League → Final, each pair twice: the semi-finals are shown but cannot be picked ----
    await p.goto("/en/play");
    const made = await startQuickMatch(p, `QM walk toss ${TAG}`, sides, total, { shape: "final", plays });
    await expect(p.getByTestId("qm-eyebrow")).toContainText(ui("quickMatch.format.league_knockout"));
    const splitPart = ui("quickMatch.home.stagePart.split", { league, knockout: knockoutMatches(q) });
    await expectLkPlayedLine(p, { played: 0, notPlayed: 0, total }, splitPart);
    await expect(p.getByTestId("qm-match")).toHaveCount(league);
    const drawn = await knockoutCards(p);
    expect(drawn.map((c) => c.round), "one card: the final").toEqual([ui("bracket.round.final")]);
    expect(drawn[0]!.seats.map((s) => s.label).sort(), "it waits on 1st and 2nd").toEqual([rank(1), rank(2)].sort());
    await expect(p.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.goThrough", { count: q }));
    const koStageId = (await stagesOf(made))[1]!.id;

    // ---- 2. The six league matches, steered: 2nd and 3rd end level on everything ----
    const results: Played[] = [];
    for (const games of plans) {
      const played = await playHeroMatch(p, made, games, steer, "after-result");
      results.push(played);
      expect(await expectRecorded(made, [played])).toBe(1);
    }
    expect(meetings, "anti-vacuity: the level pair met twice").toBe(plays);
    const table = tableOf(sides, results, rules);
    expect(table.map((t) => t.won), "one clear top, two level below it").toEqual([2 * plays, 1, 1]);
    expect(table[0]!.name).toBe(top);

    // ---- 3. The question: the league finished, one place left, "Tie for 2nd", Pick or Toss ----
    await expect(p.getByTestId("qm-cut-kicker")).toHaveText(plural(ui, "quickMatch.cut.kicker", 1));
    const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
    const title = ui("quickMatch.cut.title", { place: ui("quickMatch.home.rankShort.2"), names: list.format(level) });
    await expect(p.getByTestId("qm-cut-title"), "the level pair, in the order they were typed").toHaveText(title);
    await expect(p.getByTestId("qm-cut-body")).toHaveText(ui("quickMatch.cut.body"));
    await expect(p.getByTestId("qm-cut-toss")).toHaveText(ui("quickMatch.cut.toss"));
    await expect(p.getByTestId("qm-cut-pick")).toHaveText(ui("quickMatch.cut.pick"));
    for (const id of ["qm-cut-toss", "qm-cut-pick"]) {
      expect((await p.getByTestId(id).boundingBox())?.height ?? 0, `${id} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    for (const id of ["qm-hero", "qm-setting-up", "qm-cut-result", "qm-add-match-open"]) {
      await expect(p.getByTestId(id), `the question open: no ${id}`).toHaveCount(0);
    }
    await expect(p.getByTestId("qm-knockout-caption")).toHaveText(ui("quickMatch.home.knockoutWaiting"));
    expect((await knockoutCards(p))[0]!.seats.map((s) => s.label).sort(), "the final's 2nd seat is the one to decide").toEqual(
      [rank(1), ui("quickMatch.home.toDecide", { seat: rank(2) })].sort(),
    );
    const levelTag = ui("quickMatch.home.levelToDecide");
    await expectLkTable(p, table, {
      places: new Map([[top, "1"], [second, "="], [third, "="]]),
      tags: new Map([[top, null], [second, levelTag], [third, levelTag]]),
    });
    await expectLkPlayedLine(p, { played: league, notPlayed: 0, total }, splitPart);
    await expectNoHorizontalScroll(p);

    // ---- 4. The record: the league still on (D3), nothing proposed, nobody has answered; the engine's lot stored ----
    expect((await stagesOf(made))[0]!.status, "the league stays active while it asks").toBe("active");
    expect(await proposalsOf(koStageId), "nothing proposed while it asks").toEqual([]);
    expect(await cutDecisionOf(made), "nobody has answered").toBeNull();
    const { nameOf } = await recordOf(made);
    const stored = await leagueTableOf(made);
    const levelRows = stored.filter((r) => level.includes(nameOf.get(r.entrantId)!));
    expect(levelRows.map((r) => [r.tieUnbroken, r.tieBreak?.key]), "the engine left the pair level, ordered by the lot").toEqual([
      [true, "lots"],
      [true, "lots"],
    ]);
    const lotFirst = nameOf.get(stored.find((r) => r.rank === 2)!.entrantId)!;
    expect(level, "the lot's 2nd is one of the level pair").toContain(lotFirst);
    expect(await expectRecorded(made, results)).toBe(league);

    tieNight = { ctx, p, made, table, results, title, lotFirst, level };
    handedOn = true;
  } finally {
    if (!handedOn) await ctx.close();
  }
});

test("(F4) Toss: the stored lot's side goes to the final, the league table marks the pair by lot, and a reload and a friend's phone that taps Toss again read the same", async ({ browser }, info) => {
  expect(tieNight, "(F3) left the question open").not.toBeNull();
  const { p, made, table, results, title, lotFirst, level } = tieNight!;
  setBudget(budgetFor({ navs: KO_TOSS.navs, acts: KO_TOSS.acts, reads: KO_TOSS.reads, plans: [] }));
  const top = table[0]!.name;
  const lotSecond = level.find((n) => n !== lotFirst)!;
  const q = QUALIFIERS.final;
  const total = results.length + knockoutMatches(q);
  const finalName = ui("bracket.round.final");
  const koStageId = (await stagesOf(made))[1]!.id;
  const { nameOf } = await recordOf(made);
  const idOf = new Map([...nameOf].map(([id, name]) => [name, id]));

  const friendCtx = await newGuest(browser, info.project.use.baseURL);
  try {
    // ---- 1. A friend opens the link while it asks: the same question on a second phone ----
    const fp = await friendCtx.newPage();
    await fp.goto(made.path);
    await expect(fp.getByTestId("qm-cut-title"), "the friend's phone asks the same").toHaveText(title, { timeout: STEP_MS });

    // ---- 2. Toss: the 303 back to the bare home; the stored lot's side goes through, said above the final ----
    await p.getByTestId("qm-cut-toss").click();
    // A same-URL 303: wait on what it shows, never on the URL (which already matches).
    await expect(p.getByTestId("qm-cut"), "answered: the question goes").toHaveCount(0, { timeout: STEP_MS });
    expect(new URL(p.url()).search, "the bare home: no refusal").toBe("");
    await expect(p.getByTestId("qm-flash")).toHaveCount(0);
    const resultLines = [ui("quickMatch.cut.tossResult", { names: lotFirst }), ui("quickMatch.cut.tossBody")];
    const expectAnswered = async (pg: Page, how: string) => {
      await expect(pg.getByTestId("qm-cut-result").locator("p"), `${how}: the toss's result`).toHaveText(resultLines);
      await expect(pg.getByTestId("qm-hero-kicker"), `${how}: the final is up next`).toHaveText(
        ui("quickMatch.home.upNextRound", { round: finalName }),
      );
      const [card] = await knockoutCards(pg);
      expect(card!.seats.map((s) => [s.label, s.note]).sort(), `${how}: the final seats 1st and the toss's side, by lot`).toEqual(
        [
          [top, ui("quickMatch.home.rankShort.1")],
          [lotFirst, `${ui("quickMatch.home.rankShort.2")} · ${ui("quickMatch.home.byLotShort")}`],
        ].sort(),
      );
    };
    await expectAnswered(p, "after the toss");
    expect(await blockOrder(p), "filled: the bracket above the table").toEqual(["qm-knockout", "qm-standings"]);
    await expect(p.getByTestId("qm-standings-caption")).toHaveText(ui("quickMatch.home.wentThrough", { count: q }));
    const byLot = ui("quickMatch.home.byLot");
    await expectLkTable(p, table, {
      places: new Map([[top, "1"], [lotFirst, "2"], [lotSecond, "3"]]),
      tags: new Map([[top, null], [lotFirst, byLot], [lotSecond, byLot]]),
    });
    await expectLkPlayedLine(p, { played: results.length, notPlayed: 0, total }, ui("quickMatch.home.stagePart.knockoutOn"));
    await expectNoHorizontalScroll(p);
    const decided = await cutDecisionOf(made);
    expect(
      decided && { how: decided.how, through: decided.through, tie: decided.tie },
      "the record: a toss, the lot's side through, the tie it answered",
    ).toEqual({ how: "toss", through: [idOf.get(lotFirst)], tie: level.map((n) => idOf.get(n)!).sort() });
    expect((await proposalsOf(koStageId)).map((x) => x.status), "one proposal, confirmed").toEqual(["confirmed"]);
    expect((await stagesOf(made))[0]!.status, "the league is complete once the knockout fills").toBe("complete");
    const [line] = await knockoutLinesOf(koStageId);
    expect([nameOf.get(line!.home!), nameOf.get(line!.away!)].sort(), "the record's final: 1st and the toss's side").toEqual(
      [top, lotFirst].sort(),
    );

    // ---- 3. A reload reads the same ----
    await p.reload();
    await expectAnswered(p, "after a reload");

    // ---- 4. The friend, still on the question, taps Toss too: someone already decided, and here is who goes through ----
    await fp.getByTestId("qm-cut-toss").click();
    await expect(fp.getByTestId("qm-flash"), "the second answer is refused, in plain words").toHaveText(
      ui("quickMatch.flash.alreadyDecided"),
      { timeout: STEP_MS },
    );
    await expect(fp.getByTestId("qm-flash")).toHaveAttribute("data-tone", "refusal");
    await expect(fp.getByTestId("qm-cut")).toHaveCount(0);
    await expectAnswered(fp, "the friend's phone");
    expect(await cutDecisionOf(made), "the first answer stands, untouched").toEqual(decided);
    await expectNoHorizontalScroll(fp);
    // …and a fresh load of the link on that phone reads the same, with no refusal.
    await fp.goto(made.path);
    await expect(fp.getByTestId("qm-flash")).toHaveCount(0);
    await expectAnswered(fp, "the friend's fresh load");
    expect(await expectRecorded(made, results)).toBe(results.length);
  } finally {
    await friendCtx.close();
  }
});

// ── (G) the season door ─────────────────────────────────────────────────────────────────────────────────────────────

/** /play and the door's two reads; /start and its four answers (each a click or a fill and the step it lands on), Sent and
 *  its link; the claim and its landing; the record read back, and the entrants tab read. */
const SEASON = { navs: 4, acts: 26, reads: 4 } as const;

test("(G) the season door: /play's Tennis opens the /start wizard on Tennis, and the emailed link builds a Tennis league of the size asked", async ({ browser }, info) => {
  setBudget(budgetFor({ ...SEASON, plans: [] }));
  const PLAYERS = 6;
  const name = `QM walk season ${TAG}`;
  const email = `delivered+e2e-qm-season-${TAG}@resend.dev`;
  const season = await browser.newContext({
    storageState: await consentedAnonymousState(),
    baseURL: info.project.use.baseURL,
    viewport: PHONE,
  });
  try {
    const p = await season.newPage();

    // ---- 1. /play: the door under Start follows the chips. Tennis, not the offer's first, so a door stuck on the
    //         default cannot pass ----
    await p.goto("/en/play");
    await expect(form(p)).toBeVisible({ timeout: STEP_MS });
    await expect(p.getByTestId("qm-start")).toBeDisabled();
    const door = p.getByTestId("qm-register-season");
    await expect(door).toHaveText(mk("quickMatch.setup.registerSeason"));
    await choice(p, ui("sport.tennis")).click();
    await expect(form(p).getByRole("radio", { name: ui("sport.tennis"), exact: true })).toBeChecked();
    await expect(door, "the door names the chosen sport").toHaveAttribute("href", "/en/start?sport=tennis");
    await expectNoHorizontalScroll(p);

    // ---- 2. Through the door: B1 opens on Tennis, and only Tennis ----
    await door.click();
    await p.waitForURL((u) => u.pathname === "/en/start" && u.searchParams.get("sport") === "tennis", { timeout: STEP_MS });
    const wizard = p.locator("[data-start-wizard]");
    const next = wizard.getByRole("button", { name: `${mk("start.wizard.next")} →`, exact: true });
    await expect(wizard).toHaveAttribute("data-step", "sport");
    await waitForHydration(next);
    await expect(wizard.getByRole("radio", { name: ui("sport.tennis"), exact: true })).toBeChecked();
    await expect(wizard.locator('input[name="sport"]:checked')).toHaveCount(1);
    await wizard.getByRole("textbox", { name: mk("start.wizard.compName") }).fill(name);
    await next.click();

    // ---- 3. B2: six players, a League ----
    await expect(wizard).toHaveAttribute("data-step", "size");
    await wizard.getByRole("textbox", { name: mk("start.wizard.entrants"), exact: true }).fill(String(PLAYERS));
    await wizard.locator('[data-format-card="league"]').click();
    await expect(wizard.locator('input[name="format"][value="league"]')).toBeChecked();
    await next.click();

    // ---- 4. B3: not sure yet ----
    await expect(wizard).toHaveAttribute("data-step", "date");
    // `has` is queried INSIDE each label, so it is a bare selector (one chained from the wizard never matches).
    const notSure = p.locator('input[name="date"][value="none"]');
    await wizard.locator("label").filter({ has: notSure }).click();
    await expect(notSure).toBeChecked();
    await next.click();

    // ---- 5. B4 → Sent: its quick match link is on Tennis too (a sport /play offers) ----
    await expect(wizard).toHaveAttribute("data-step", "email");
    await wizard.getByLabel(mk("start.wizard.email"), { exact: true }).fill(email);
    await wizard.getByRole("button", { name: `${mk("start.wizard.emailMe")} →`, exact: true }).click();
    await expect(wizard).toHaveAttribute("data-step", "sent", { timeout: STEP_MS });
    await expect(wizard.getByTestId("start-play-link")).toHaveAttribute("href", "/en/play?sport=tennis");
    await expectNoHorizontalScroll(p);

    // ---- 6. The emailed link: its token is the draft's own column (a production target emails it, never shows it) ----
    const token = await withDb(async (sql) => {
      const [d] = await sql<{ token: string }[]>`select token from funnel_drafts where email = ${email} order by created_at desc limit 1`;
      return d?.token;
    });
    expect(token, "the start stored a draft for the address").toBeTruthy();
    await p.goto(`/start/claim?token=${token}`);
    await p.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=entrants/, { timeout: STEP_MS });

    // ---- 7. The record: a Tennis division, one League stage, no entrant (the six chosen are the draft's target, and the
    //         organiser adds the real names — /start "Sent stepper", owner 2026-11-14), and no first day (Not sure yet) ----
    const built = await withDb(async (sql) => {
      const [d] = await sql<{ id: string; sport_key: string; variant_key: string; starts_on: string | null }[]>`
        select d.id, d.sport_key, d.variant_key, c.starts_on::text
          from competitions c join divisions d on d.competition_id = c.id where c.name = ${name}`;
      expect(d, "the claim built the competition and its division").toBeTruthy();
      const stages = await sql<{ kind: string }[]>`select kind from stages where division_id = ${d!.id} order by seq`;
      const entrants = await sql<{ seed: number | null; kind: string; display_name: string }[]>`
        select seed, kind, display_name from entrants where division_id = ${d!.id} order by seed nulls last, id`;
      const [draft] = await sql<{ entrants: number | null }[]>`
        select (f.payload->>'entrants')::int as entrants from funnel_drafts f
          join competitions c on c.id = f.competition_id where c.name = ${name}`;
      return { ...d!, stages: stages.map((s) => s.kind), entrants: [...entrants], target: draft?.entrants ?? null };
    });
    expect(built.sport_key, "the division is the door's sport").toBe("tennis");
    expect(built.stages, "a League is one league stage").toEqual(["league"]);
    expect(built.entrants, "no placeholder entrant").toEqual([]);
    expect(built.target, "the size chosen is the draft's, stamped with the competition it built").toBe(PLAYERS);
    expect(built.starts_on, "Not sure yet: no first day").toBeNull();

    // ---- 8. …and the new organiser sees no placeholder row on the entrants tab the link landed on ----
    await expect(p.locator("body"), "the landing page is the claimed competition's").toContainText(name);
    await expect(p.getByTestId("entrant-row-disclosure")).toHaveCount(0);
  } finally {
    await season.close();
  }
});

// ── (H) cricket, League only ────────────────────────────────────────────────────────────────────────────────────
// Quick match cricket (owner 2026-11-13 "yes", 2026-11-14 "why still not cricket in the quick match?"; decision log
// 2026-11-13; spec C11 as amended 2026-11-14), in a browser of its own: two sides, the T20 rules the setup opens on, scored
// the way a guest's pad lets it (bands 0–1, no named player): Start asks the toss (the away side wins it and bats, so the
// AWAY side bats first: without a toss the engine seats the home side first, so the winner below tells the two apart); one
// over of 9; Close innings; the home side's chase passes 9 in one over and the match is decided. The home reads the side
// batting second as the winner, first in the table, and the Full table carries the engine's net run rate. The record
// holds exactly what was tapped. Expected values: the engine's own variant (its balls per over) and the rulebook (the side
// batting second wins once it passes the total), never the page.

/** An over through the over sheet: this over's runs, no wicket, a full over (the sheet's own prefill). */
async function cricketOver(p: Page, runs: number): Promise<void> {
  await pad(p).locator('[data-tile-id="overSummary"]').click();
  const sheet = p.locator('[data-role="v3-sheet"]');
  await expect(sheet).toBeVisible({ timeout: STEP_MS });
  const confirm = () => sheet.getByRole("button", { name: ui("scorepad.action.confirm"), exact: true }).click();
  await sheet.getByRole("spinbutton", { name: ui("pad.cricket.sheet.overSummary.runs.title") }).fill(String(runs));
  await confirm();
  await expect(sheet.getByRole("spinbutton", { name: ui("pad.cricket.sheet.overSummary.wickets.title") })).toBeVisible({ timeout: REACH_MS });
  await confirm();
  await expect(sheet.getByRole("spinbutton", { name: ui("pad.cricket.sheet.overSummary.balls.title") })).toBeVisible({ timeout: REACH_MS });
  await confirm();
  await expect(sheet, "the over sheet's last step sends it").toHaveCount(0, { timeout: STEP_MS });
}

test("(H) cricket, League only: a guest plays a league of two by overs — the toss at Start, an over, Close innings, the chase — and the home reads the winner and the engine's table", async ({ browser }, info) => {
  // Six page loads or redirects; ~45 local acts; four writes held and read back (toss and Start, two overs, the close)
  // and the deciding over (DECIDE_MS).
  setBudget(6 * STEP_MS + 45 * REACH_MS + 4 * (HOLD_MS + STEP_MS) + DECIDE_MS);
  const night = await browser.newContext({ storageState: await consentedAnonymousState(), baseURL: info.project.use.baseURL, viewport: PHONE });
  try {
    const p = await night.newPage();
    const sides = [`Falcons ${TAG}`, `Kites ${TAG}`];
    const cricket = builtinModules.find((m) => m.key === "cricket")!;

    // ---- 1. The setup form: Cricket, the two sides; the knockout rows listed, not for this sport; T20 ----
    await p.goto("/en/play");
    await expect(form(p)).toBeVisible({ timeout: STEP_MS });
    await expect(p.getByTestId("qm-start")).toBeDisabled();
    await choice(p, ui("sport.cricket")).click();
    await expect(form(p).getByRole("radio", { name: ui("sport.cricket"), exact: true })).toBeChecked();
    const name = `QM walk cricket ${TAG}`;
    await form(p).getByLabel(mk("quickMatch.setup.nameLabel"), { exact: true }).fill(name);
    for (const [i, side] of sides.entries()) await form(p).getByLabel(mk("quickMatch.setup.sideLabel", { n: i + 1 }), { exact: true }).fill(side);
    for (const s of ["final", "semis"] as const) {
      await expect(shapeRadio(p, s), `${s}: listed, disabled`).toBeDisabled();
      await expect(shapeRadio(p, s), "…because cricket has no knockout here").toHaveAccessibleDescription(
        `${mk(`quickMatch.setup.shape.${s}Hint`, { count: QUALIFIERS[s] })} ${mk("quickMatch.setup.shape.notForSport")}`,
      );
    }
    await expect(shapeRadio(p, "league")).toBeChecked();
    const rules = form(p).locator('select[name="variant_key"]');
    const variant = await rules.inputValue();
    expect(variant, "the setup opens on a cricket the engine declares").toMatch(/^\w/);
    const cfg = cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[variant]) as { ballsPerOver: number };
    await expect(p.getByTestId("qm-start")).toContainText(plural(mk, "quickMatch.setup.startCount", 1));
    await expectNoHorizontalScroll(p);
    await p.getByTestId("qm-start").click();
    await p.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: STEP_MS });
    const path = new URL(p.url()).pathname;

    // ---- 2. Score → the remote pad; Start asks the toss: the away side wins it and bats ----
    const fixtureId = (await p.locator('[data-testid="qm-match"][data-next="true"]').getAttribute("data-fixture-id"))!;
    const home = (await p.getByTestId("qm-hero-home").textContent())!.trim();
    const away = (await p.getByTestId("qm-hero-away").textContent())!.trim();
    expect(sides).toEqual(expect.arrayContaining([home, away]));
    await p.getByTestId("qm-hero").getByTestId("qm-score").click();
    await p.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: STEP_MS });
    await expect(p.getByTestId("scan-confirm")).toBeVisible({ timeout: STEP_MS });
    await p.getByTestId("score-start-match").click();
    const question = p.getByTestId("score-start-toss");
    await expect(question).toContainText(ui("pad.cricket.sheet.toss.wonBy.title"), { timeout: STEP_MS });
    await expect(question.getByTestId("pad-dock-chip-away")).toContainText(away);
    await question.getByTestId("pad-dock-chip-away").click();
    await expect(question).toContainText(ui("pad.cricket.sheet.toss.elected.title"));
    await question.getByTestId("pad-dock-chip-bat").click();
    await expect(pad(p).locator('[data-role="v3-scorebug"]'), "the toss answered, the pad opens").toBeVisible({ timeout: STEP_MS });
    await expect(pad(p).locator('[data-tile-id="run0"]'), "no ball tile on the guest's pad").toHaveCount(0);
    await expect(pad(p).locator('[data-role="context-chip"]'), "no batter or bowler to pick").toHaveCount(0);

    // ---- 3. The away side bats first (its toss): one over of 9, then Close innings ----
    await cricketOver(p, 9);
    await expect(pad(p).locator('[data-role="v3-scorebug"]')).toContainText("9/0");
    await pad(p).locator('[data-tile-id="inningsClose"]').click();
    const close = p.locator('[data-role="v3-sheet"]');
    await expect(close).toContainText(ui("pad.cricket.sheet.inningsClose.reason.title"), { timeout: STEP_MS });
    await close.getByRole("button", { name: ui("pad.cricket.sheet.inningsClose.reason.other"), exact: true }).click();
    await expect(close).toHaveCount(0, { timeout: STEP_MS });
    await expect
      .poll(async () => (await withDb((sql) => sql<{ type: string }[]>`select type from score_events where fixture_id = ${fixtureId} order by seq`)).map((e) => e.type), {
        timeout: 3 * (HOLD_MS + STEP_MS),
        message: "the toss, the Start, the over and the close never all reached the ledger",
      })
      .toEqual(["cricket.toss", "core.start", "cricket.innings.summary", "cricket.innings.close"]);

    // ---- 4. The home side's chase: 10 in one over passes 9, and the match is decided ----
    await cricketOver(p, 10);
    await expect(p.getByText(ui("device.quickMatch.resultSaved")), "the device page says the match is decided").toBeVisible({ timeout: DECIDE_MS });
    // The device page's header holds the decided score whole (sign-off qmc14a: "10/0 (1) — 9/0 (1)" at the LED size is wider
    // than a phone's header card, which clipped it mid-number). Each side's score is one unbreakable run and the line may
    // break between the two sides, so nothing overflows the card.
    const header = await overflowingIn(p, 'header:has([data-testid="scan-scorebug-line"])', "p,span", "the device page's header was not in the DOM");
    expect(header.clipped, "the decided score fits the device header").toEqual([]);
    await p.getByTestId("quick-match-back-link").click();
    await p.waitForURL((url) => url.pathname === path, { timeout: STEP_MS });

    // ---- 5. The home: the side batting second won, first in the table; the Full table's NRR ----
    await expectSettledOnHome(p, fixtureId);
    await expect(p.getByTestId("qm-winner-name"), "the chase won it: the home side, batting second by the toss").toHaveText([home]);
    await expect(p.getByTestId("qm-standings-row").getByRole("rowheader")).toHaveText([home, away]);
    await p.getByTestId("qm-full-table-toggle").click();
    const head = p.getByTestId("qm-full-table-head");
    await expect(head, "the engine's net run rate is a column").toContainText("NRR");
    const cols = await head.locator("th").allTextContents();
    const nrrAt = cols.findIndex((c) => c.includes("NRR"));
    const rowOf = (who: string) => p.getByTestId("qm-full-table-row").filter({ has: p.getByRole("rowheader", { name: who, exact: true }) });
    // ICC net run rate: runs per over faced less runs per over conceded; one full over (the variant's balls) each way.
    const overs = (balls: number) => balls / cfg.ballsPerOver;
    const expectNrr = (forRuns: number, againstRuns: number) => forRuns / overs(cfg.ballsPerOver) - againstRuns / overs(cfg.ballsPerOver);
    const cellAt = async (who: string) => Number((await rowOf(who).locator("th, td").nth(nrrAt).textContent())!.trim());
    expect(await cellAt(home), "the winner's NRR").toBeCloseTo(expectNrr(10, 9), 2);
    expect(await cellAt(away), "the loser's NRR").toBeCloseTo(expectNrr(9, 10), 2);
    await expectNoHorizontalScroll(p);

    // ---- 6. The record: exactly what was tapped, and the result ----
    const record = await withDb((sql) => sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from score_events where fixture_id = ${fixtureId} order by seq`);
    const [fx] = await withDb((sql) => sql<{ home_entrant_id: string; away_entrant_id: string; status: string; outcome: { winner?: string } }[]>`
      select home_entrant_id, away_entrant_id, status, outcome from fixtures where id = ${fixtureId}`);
    expect(record).toEqual([
      { type: "cricket.toss", payload: { wonBy: fx!.away_entrant_id, elected: "bat" } },
      { type: "core.start", payload: {} },
      { type: "cricket.innings.summary", payload: { runs: 9, wickets: 0, legalBalls: cfg.ballsPerOver, partial: true } },
      { type: "cricket.innings.close", payload: { reason: "other" } },
      { type: "cricket.innings.summary", payload: { runs: 10, wickets: 0, legalBalls: cfg.ballsPerOver, partial: true } },
    ]);
    expect(fx!.status).toBe("decided");
    expect(fx!.outcome.winner, "the side batting second: the home side, as the toss seated it").toBe(fx!.home_entrant_id);
  } finally {
    await night.close();
  }
});
