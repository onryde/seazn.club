// W2d Task 19 (spec §13 part 5) — tables and tie-breaks walked through by hand, one describe per sport family.
//
// Every test is the same journey an organiser makes: set the stage's order in the stage editor (Tie-breaks section, the
// division page's `?tab=fixtures`), generate (the pin, X-TB-2), score through the pad or the console, and read the PUBLIC
// table a visitor reads (`/shared/{org}/{comp}/{div}?tab=standings`): its order, its columns, its cells. Setup that is not
// the step under test goes through the API (results the pad already has its own walkthrough for, a field, a stage).
//
// WHERE THE EXPECTED VALUES COME FROM. Every table below is hand arithmetic from the rulebook rows of spec §5.10 (the
// points and the order each sport's governing body publishes), never from the code under test: football FIFA 3/1/0 with
// a group shoot-out a draw for both plus one for its winner (B2); FIH Pro League the same (D10 f); IIHF 3/2/1/0; cricket
// W2, tie 1, no result 1; FIVB best of three 3:0 and 2:1 (D10 a); BWF flat 2/0 with 16.2's game difference and
// head-to-head for two; table tennis W2, a played loss 1, an unplayed loss 0 (D6); ATP 4.01 C.3-2 matches played before
// head-to-head; FIDE 1/½/0 shown "1½" (D10 b) and Sonneborn-Berger; carrom 2/1/0; generic 3/1/0. The ORDERS the editor
// starts from are the engine's own declarations (`defaultTiebreakers`, `tablePresets`, `validateCascade`); every word is
// read from the dictionaries the product renders.
//
// A red here that is not this file's own arithmetic is a W2d defect in the owning task's files — never loosen it. The pad
// offering the kicks in a football GROUP stage (spec §5.2's "pad finding") is the one the spec names in advance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { LEVEL_RANK, isHeadToHeadKey, validateCascade, type CascadeContext } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, fixturePath } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { closeOpenContexts } from "../spectator-public-helpers";
import { API_CALL_MS, activeOrgSlug, dictString, division, entrants, eventStream, person, publicCompetition, spectator } from "../spectator-w2-kit";

// Each test seeds its own competition: nothing is shared, so nothing serialises.
test.describe.configure({ mode: "parallel" });
test.afterEach(async () => {
  await closeOpenContexts();
});

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const say = (key: string, vars: Record<string, string | number> = {}): string => {
  const raw = L[key];
  if (raw === undefined) throw new Error(`no "${key}" in en/ui.json`);
  return raw.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));
};
const stepWord = (key: string): string => say(`div.detail.tiebreak.rule.${key}`);

/** A public table column's word, as the header's `title` carries it (`columnHeader`, standings-view.ts). */
const COL = {
  played: dictString("en", "table.col.played"),
  won: dictString("en", "table.col.won"),
  otw: dictString("en", "table.col.otw"),
  otl: dictString("en", "table.col.otl"),
  drawn: dictString("en", "table.col.drawn"),
  lost: dictString("en", "table.col.lost"),
  points: dictString("en", "table.col.points"),
  gf: dictString("en", "table.col.gf"),
  ties: dictString("en", "table.col.ties"),
  noResults: dictString("en", "table.col.noResults"),
  fieldGoals: dictString("en", "table.col.fieldGoals"),
  for: dictString("en", "table.col.for"),
  // A notation column prints the engine's own label in every locale (`NOTATION_HEADERS`).
  sberger: "SB",
} as const;

// Budgets DERIVED from the pad's hold (AGENTS.md class 20): every tap soft-commits and lands only after HOLD_MS.
const STEP_MS = 20_000;
const TAP_MS = HOLD_MS + 20_000;
/** The public division page is ISR'd (`revalidate = 30`): a read after a result can be served the stale render once. */
const PUBLIC_MS = 100_000;
const budget = (o: { taps: number; api: number; publicReads: number }): number =>
  Math.max(180_000, 120_000 + o.taps * TAP_MS + o.api * API_CALL_MS + o.publicReads * PUBLIC_MS);

type Mod = (typeof builtinModules)[number];
const mod = (key: string): Mod => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport module "${key}"`);
  return m;
};
type StageKind = "league" | "group";
type Side = "home" | "away";

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Who {
  id: string;
  name: string;
  personId: string | null;
}
interface Rig {
  divisionId: string;
  stageIds: string[];
  /** The field in seed order. */
  field: Who[];
  /** The public division page's Standings tab. */
  path: string;
  /** The division's config as stored (the variant's, merged with the rig's own). */
  cfg: Record<string, unknown>;
}
interface Fx {
  id: string;
  stage_id: string;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}
interface FixtureState {
  status: string;
  last_seq: number;
  outcome: { kind?: string; winner?: string | null; method?: string } | null;
}
interface ServedRules {
  tiebreakers: { keys: TiebreakerKey[]; source: string; pinnedAt: string | null };
  crossGroup: { keys: TiebreakerKey[] };
  points: { rule: { win: { regulation: number }; draw?: number; loss: { regulation: number } }; source: string; pinnedAt: string | null };
}
type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

const LETTERS = "ABCDEFGH";

/** A public competition in the signed-in org, one division of `sport`/`variant` (its `config` merged over the variant by
 *  the division create), a field of `size` and the `stages` given — nothing generated. A rostered field gives each
 *  entrant one person, for the pad's lineups. */
async function rig(
  request: APIRequestContext,
  o: {
    label: string;
    sport: string;
    variant: string;
    config?: Record<string, unknown>;
    kind: "individual" | "team";
    size: number;
    rostered: boolean;
    stages: Record<string, unknown>[];
  },
): Promise<Rig> {
  expect(Object.keys(mod(o.sport).variants), `premise: ${o.sport} declares ${o.variant}`).toContain(o.variant);
  const org = await activeOrgSlug(request);
  const comp = await publicCompetition(request, { name: `W2d T19 ${o.label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`, orgId: org.id });
  const div = await division(request, comp.id, {
    name: o.label,
    sport_key: o.sport,
    variant_key: o.variant,
    ...(o.config === undefined ? {} : { config: o.config }),
  });
  const names = Array.from({ length: o.size }, (_, i) => `${o.label} ${LETTERS[i]} ${TAG}`);
  let field: Who[];
  if (o.rostered) {
    const people: string[] = [];
    for (const n of names) people.push(await person(request, `${n} player`, true));
    const ids = await entrants(request, div.id, names.map((name, i) => ({ kind: o.kind, name, members: [people[i]!] })));
    field = names.map((name, i) => ({ id: ids[i]!, name, personId: people[i]! }));
  } else {
    const added = await addEntrantsViaApi(request, div.id, names, o.kind);
    expect(added.status, `${o.label}: the field was created`).toBe(201);
    field = names.map((name, i) => ({ id: added.ids[i]!, name, personId: null }));
  }
  const st = await apiJson<{ id: string } | { id: string }[]>(
    request,
    `/api/v1/divisions/${div.id}/stages`,
    "POST",
    o.stages.length === 1 ? o.stages[0] : o.stages,
  );
  expect(st.status, `${o.label}: stages ${JSON.stringify(st.error)}`).toBeLessThan(300);
  const stageIds = (Array.isArray(st.data) ? st.data : [st.data!]).map((s) => s.id);
  expect(stageIds.length, `${o.label}: every stage was created`).toBe(o.stages.length);
  const read = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${div.id}`);
  expect(read.status).toBe(200);
  return { divisionId: div.id, stageIds, field, path: `/shared/${org.slug}/${comp.slug}/${div.slug}?tab=standings`, cfg: read.data!.config };
}

async function servedRules(request: APIRequestContext, stageId: string): Promise<ServedRules> {
  const res = await apiJson<{ tableRules: ServedRules | null }>(request, `/api/v1/stages/${stageId}`);
  expect(res.status, "GET /stages/{id}").toBe(200);
  expect(res.data!.tableRules, "the stage's table rules are served").not.toBeNull();
  return res.data!.tableRules!;
}

async function fixturesOf(request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> {
  const list = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(list.status, "GET /divisions/{id}/fixtures").toBe(200);
  return (list.data ?? []).filter((f) => f.stage_id === stageId);
}

/** Generate `stageId` (the pin, X-TB-2) and start the division; the stage's fixtures come back with their seating. The
 *  pin must carry `order` from `source` (the editor's save: "stage"). */
async function generateAndStart(request: APIRequestContext, r: Rig, stageId: string, order: readonly TiebreakerKey[], source = "stage"): Promise<Fx[]> {
  const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const pinned = await servedRules(request, stageId);
  expect(pinned.tiebreakers.pinnedAt, "generating pins the stage (X-TB-2)").not.toBeNull();
  expect([pinned.tiebreakers.keys, pinned.tiebreakers.source], "the pin carries the order in force at generate").toEqual([[...order], source]);
  const started = await apiJson(request, `/api/v1/divisions/${r.divisionId}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtures = await fixturesOf(request, r.divisionId, stageId);
  expect(fixtures.length, "anti-vacuity: the stage has fixtures").toBeGreaterThan(0);
  return fixtures;
}

function between(fixtures: readonly Fx[], a: Who, b: Who): Fx {
  const f = fixtures.find((x) => [x.home_entrant_id, x.away_entrant_id].sort().join() === [a.id, b.id].sort().join());
  if (f === undefined) throw new Error(`no fixture pairs ${a.name} with ${b.name}`);
  return f;
}
const sideOf = (f: Fx, w: Who): Side => {
  if (f.home_entrant_id === w.id) return "home";
  if (f.away_entrant_id === w.id) return "away";
  throw new Error(`${w.name} is not seated in fixture ${f.id}`);
};
/** A result's pair of numbers oriented to the fixture's seating: `[winner's, loser's]` given for `w`. */
const oriented = (f: Fx, w: Who, [mine, theirs]: readonly [number, number]): { home: number; away: number } =>
  sideOf(f, w) === "home" ? { home: mine, away: theirs } : { home: theirs, away: mine };

type Ev = readonly [type: string, payload?: Record<string, unknown>];
async function play(request: APIRequestContext, f: Fx, events: readonly Ev[]): Promise<void> {
  const s = await eventStream(request, f.id);
  for (const [type, payload] of events) await s.post(type, payload ?? {});
  expect(s.posted, "anti-vacuity: every event was posted").toBe(events.length);
}

async function fixtureState(request: APIRequestContext, fixtureId: string): Promise<FixtureState> {
  const res = await apiJson<FixtureState>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}
async function expectDecided(request: APIRequestContext, f: Fx, want: { kind?: string; winner?: string | null; method?: string }, label: string): Promise<void> {
  await expect
    .poll(async () => {
      const s = await fixtureState(request, f.id);
      return s.outcome === null ? null : Object.fromEntries(Object.keys(want).map((k) => [k, (s.outcome as Record<string, unknown>)[k]]));
    }, { message: label, timeout: STEP_MS })
    .toEqual(want);
}

/** Alternate shoot-out attempts (home first) until the fixture decides: `winner` scores every one, the other side misses. */
async function shootoutTo(request: APIRequestContext, f: Fx, winner: Who, type: string): Promise<number> {
  const s = await eventStream(request, f.id);
  for (let i = 0; i < 20; i++) {
    const by = i % 2 === 0 ? f.home_entrant_id! : f.away_entrant_id!;
    await s.post(type, { by, scored: by === winner.id });
    if ((await fixtureState(request, f.id)).status === "decided") return s.posted;
  }
  throw new Error(`the shoot-out on ${f.id} never decided in 20 attempts`);
}

async function lineUp(request: APIRequestContext, f: Fx, slots: { who: Who; positionKey?: string }[]): Promise<void> {
  for (const { who, positionKey } of slots) {
    expect(who.personId, `${who.name} is rostered`).not.toBeNull();
    const res = await apiJson(request, `/api/v1/fixtures/${f.id}/lineups/${who.id}`, "PUT", {
      slots: [{ person_id: who.personId, slot: "starting", order_no: 1, roles: [], ...(positionKey ? { position_key: positionKey } : {}) }],
    });
    expect(res.status, `lineup for ${who.name}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }
}

// ── the stage editor (T15/T16) ─────────────────────────────────────────────────────────────────────────────────────────

const listed = async (section: Locator): Promise<string[]> =>
  section.locator('[data-testid^="stage-tiebreaks-row-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-key") ?? ""));
/** The list folds behind a phone disclosure below md (class 22): open it only where its toggle is the visible kind. */
async function openFold(section: Locator): Promise<void> {
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function openEditor(page: Page, request: APIRequestContext, divisionId: string, stageId: string, state = "editor"): Promise<Locator> {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = page.getByTestId(`stage-tiebreaks-${stageId}`);
  await expect(section).toBeAttached({ timeout: STEP_MS });
  await expect(section).toHaveAttribute("data-state", state, { timeout: STEP_MS });
  await openFold(section);
  return section;
}
/** Save the editor's order: the strict PUT body, then the API re-reads it as the stage's own. */
async function saveOrder(page: Page, request: APIRequestContext, section: Locator, stageId: string, own: readonly TiebreakerKey[]): Promise<void> {
  const put = page.waitForRequest((q) => q.method() === "PUT" && new URL(q.url()).pathname === `/api/v1/stages/${stageId}/rules`, { timeout: STEP_MS });
  await section.getByTestId("stage-tiebreaks-save").click();
  expect((await put).postDataJSON(), "the strict body: the order alone").toEqual({ tiebreakers: [...own] });
  await expect.poll(async () => (await servedRules(request, stageId)).tiebreakers.keys, { timeout: STEP_MS }).toEqual([...own]);
  expect((await servedRules(request, stageId)).tiebreakers.source).toBe("stage");
}
const ctxOf = (m: Mod, cfg: unknown, stageKind: StageKind): CascadeContext => ({ module: m, cfg, stageKind, crossGroup: false }) as CascadeContext;
const swapAt = (order: readonly TiebreakerKey[], i: number): TiebreakerKey[] => {
  const out = [...order];
  [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  return out;
};

/** The organiser's edit: open the stage's Tie-breaks section, check it lists the sport's order as the engine declares
 *  it, apply `edit` through the section's own controls, check the list, save. Returns the order saved. */
async function editOrder(
  page: Page,
  request: APIRequestContext,
  r: Rig,
  stageId: string,
  m: Mod,
  stageKind: StageKind,
  edit: (sportDefault: readonly TiebreakerKey[], ctx: CascadeContext, section: Locator) => Promise<TiebreakerKey[]>,
): Promise<TiebreakerKey[]> {
  const cfg = m.configSchema.parse(r.cfg);
  const ctx = ctxOf(m, cfg, stageKind);
  const sportDefault = m.defaultTiebreakers(stageKind, cfg as never);
  const section = await openEditor(page, request, r.divisionId, stageId);
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-badge", "inherited");
  expect(await listed(section), "inherited: the sport's order, as the engine declares it").toEqual([...sportDefault]);
  const own = await edit(sportDefault, ctx, section);
  expect(own, "premise: the edit changes the order").not.toEqual([...sportDefault]);
  expect(validateCascade(own, ctx), "premise: the engine accepts the edited order").toEqual([]);
  expect(await listed(section), "the section lists the edit").toEqual(own);
  await saveOrder(page, request, section, stageId, own);
  return own;
}
/** Move the step at `i` one down (the section's down arrow). */
const moveDown = (i: number) => async (order: readonly TiebreakerKey[], _ctx: CascadeContext, section: Locator) => {
  await section.getByTestId(`stage-tiebreaks-down-${i}`).click();
  return swapAt(order, i);
};
/** Remove a middle step this test's table does not turn on (`keep`), searching from the end; the engine must accept the
 *  order without it. The tables below are decided by the steps they keep, so the removal cannot move them. */
const removeHarmless = (keep: (key: TiebreakerKey, i: number) => boolean) => async (order: readonly TiebreakerKey[], ctx: CascadeContext, section: Locator) => {
  let at = -1;
  for (let i = order.length - 2; i >= 1 && at < 0; i--) {
    if (!keep(order[i]!, i) && validateCascade(order.filter((_, j) => j !== i), ctx).length === 0) at = i;
  }
  expect(at, `premise: a middle step of ${order.join(", ")} can go without the engine refusing it`).toBeGreaterThan(0);
  await section.getByTestId(`stage-tiebreaks-remove-${at}`).click();
  return order.filter((_, j) => j !== at);
};

// ── the pad (v3) ───────────────────────────────────────────────────────────────────────────────────────────────────────

const pad = (page: Page) => page.locator('[data-testid="score-pad"]');
const tile = (page: Page, id: string) => pad(page).locator(`[data-tile-id="${id}"]`);
const sheet = (page: Page) => pad(page).locator('[data-role="v3-sheet"]');
/** tapModel S: the scoreboard halves ARE the point buttons; scoped to `button` (a dead `<div>` sits in the same cell
 *  until the client re-renders from the fold — every sibling walkthrough's own locator). */
const half = (page: Page, side: Side) => pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
/** Do `act` on the pad and return the ONE event it put on the ledger. A held row is flushed with Send now when its dock
 *  shows one (the hold may flush it first: the click then finds nothing, and the poll still waits the hold out). */
async function landed(page: Page, f: Fx, act: () => Promise<void>): Promise<LedgerEvent> {
  const before = (await ledger(page.request, f.id)).length;
  await act();
  const send = pad(page).getByTestId("pad-send-now");
  if ((await send.count()) > 0) await send.click({ timeout: 5_000 }).catch(() => undefined);
  await expect.poll(async () => (await ledger(page.request, f.id)).length, { message: "a tap lands exactly one event", timeout: TAP_MS }).toBe(before + 1);
  const after = await ledger(page.request, f.id);
  return after[after.length - 1]!;
}
async function openPad(page: Page, f: Fx): Promise<void> {
  await page.goto(await fixturePath(page.request, f.id), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(pad(page)).toBeVisible({ timeout: STEP_MS });
}
/** Open a fixture nobody has started, and start it the way a scorer does. */
async function openLive(page: Page, f: Fx): Promise<void> {
  await openPad(page, f);
  await page.getByRole("button", { name: say("score.startMatch"), exact: true }).click();
  await expect.poll(async () => (await ledger(page.request, f.id)).map((e) => e.type), { timeout: STEP_MS }).toContain("core.start");
}

// ── the public table ───────────────────────────────────────────────────────────────────────────────────────────────────

interface PublicRow {
  rank: string;
  name: string;
  cells: string[];
}
interface PublicTable {
  caption: string;
  headers: string[];
  rows: PublicRow[];
}
/** Every table on the public Standings panel, as a visitor's DOM holds it: the column words (`th[title]`), and per row
 *  the rank cell, the entrant's full name and each column's cell. */
async function publicTables(page: Page): Promise<PublicTable[]> {
  return page.locator("#panel-standings table").evaluateAll((tables) =>
    tables.map((t) => ({
      caption: t.querySelector("caption")?.textContent?.trim() ?? "",
      headers: [...t.querySelectorAll("thead th[title]")].map((th) => th.getAttribute("title") ?? ""),
      rows: [...t.querySelectorAll("tbody tr")]
        .filter((tr) => tr.querySelector("th[scope=row]") !== null)
        .map((tr) => {
          const tds = [...tr.querySelectorAll(":scope > td")];
          return {
            rank: (tds[0]?.textContent ?? "").trim(),
            name: tr.querySelector("th[scope=row] span[title]")?.getAttribute("title") ?? "",
            cells: tds.slice(1).map((td) => (td.textContent ?? "").trim()),
          };
        }),
    })),
  );
}
const tableWith = (tables: readonly PublicTable[], name: string): PublicTable | null => tables.find((t) => t.rows.some((r) => r.name === name)) ?? null;

interface Want {
  name: string;
  /** column word → the cell's text. Must carry the points column: the poll waits on order AND points. */
  cells: Record<string, string>;
}
function expectRows(t: PublicTable, want: readonly Want[], label: string): void {
  expect(t.rows.map((r) => r.name), `${label}: the public order`).toEqual(want.map((w) => w.name));
  let checked = 0;
  for (const w of want) {
    const row = t.rows.find((r) => r.name === w.name)!;
    for (const [title, value] of Object.entries(w.cells)) {
      const i = t.headers.indexOf(title);
      expect(i, `${label}: a "${title}" column (the table has: ${t.headers.join(" | ")})`).toBeGreaterThanOrEqual(0);
      expect(row.cells[i], `${label}: ${w.name} under "${title}"`).toBe(value);
      checked++;
    }
  }
  expect(checked, `${label}: anti-vacuity — every expected cell was read`).toBe(want.reduce((n, w) => n + Object.keys(w.cells).length, 0));
  expect(checked).toBeGreaterThan(0);
}
/** Read the visitor's table until its order and points are `want`'s (the ISR render may be the stale one once), then
 *  every cell `want` names. Checks no horizontal page scroll at 1280, 768 and 320. */
async function expectPublicTable(page: Page, path: string, want: readonly Want[], label: string): Promise<PublicTable> {
  for (const w of want) expect(w.cells[COL.points], `rig: ${label} names ${w.name}'s points`).toBeDefined();
  const sig = (t: PublicTable | null) => (t === null ? [] : t.rows.map((r) => `${r.name} = ${r.cells[t.headers.indexOf(COL.points)] ?? "?"}`));
  const seen: { t: PublicTable | null } = { t: null };
  await expect
    .poll(
      async () => {
        await page.goto(path, { waitUntil: "load" });
        seen.t = tableWith(await publicTables(page), want[0]!.name);
        return sig(seen.t);
      },
      { message: `${label}: the public table's order and points`, timeout: PUBLIC_MS, intervals: [2_000, 5_000, 10_000] },
    )
    .toEqual(want.map((w) => `${w.name} = ${w.cells[COL.points]}`));
  expectRows(seen.t!, want, label);
  let widths = 0;
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#panel-standings")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.locator("#panel-standings").screenshot({ path: test.info().outputPath(`${label.replace(/\W+/g, "-")}-${width}.png`) });
    widths++;
  }
  expect(widths).toBe(3);
  await page.setViewportSize({ width: 1280, height: 900 });
  return seen.t!;
}
/** The first public read after generate: the level table (X-TB-6, T17 + concern 2) — every rank the level dash, no
 *  leader row, every entrant listed. */
async function expectLevelTable(page: Page, path: string, field: readonly Who[]): Promise<void> {
  await page.goto(path, { waitUntil: "load" });
  const t = tableWith(await publicTables(page), field[0]!.name);
  expect(t, "the visitor sees a table right after generate, not 'No standings yet'").not.toBeNull();
  expect([...t!.rows.map((r) => r.name)].sort(), "every entrant has a row").toEqual(field.map((w) => w.name).sort());
  let checked = 0;
  for (const r of t!.rows) {
    expect(r.rank.startsWith(LEVEL_RANK), `${r.name}'s rank reads the level dash: "${r.rank}"`).toBe(true);
    checked++;
  }
  expect(checked, "anti-vacuity: every rank cell was read").toBe(field.length);
  await expect(page.locator("#panel-standings .bg-amber-50, #panel-standings .bg-amber-50\\/60"), "no leader row on a level table").toHaveCount(0);
}

/** Five cells of a row: played, won, drawn, lost, points. */
const pwdlp = (p: number, w: number, d: number, l: number, pts: string): Record<string, string> => ({
  [COL.played]: String(p),
  [COL.won]: String(w),
  [COL.drawn]: String(d),
  [COL.lost]: String(l),
  [COL.points]: pts,
});
/** The same without a drawn column (a table no match of which was level shows none, `standingsColumns`). */
const pwlp = (p: number, w: number, l: number, pts: string): Record<string, string> => ({
  [COL.played]: String(p),
  [COL.won]: String(w),
  [COL.lost]: String(l),
  [COL.points]: pts,
});

// ── goals ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("goals: football, hockey, ice hockey, best third", () => {
  test("football group stage with the shoot-out on: the pad offers the kicks in the GROUP stage, the shoot-out is booked D for both and +1 for its winner, under a named order the editor reset to", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 12, api: 40, publicReads: 1 }));
    const FB = mod("football");
    const r = await rig(request, {
      label: "FB SO",
      sport: "football",
      variant: "11-a-side",
      kind: "team",
      size: 6,
      rostered: true,
      stages: [{ seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 }, rules: { shootout: true } } }],
    });
    const stageId = r.stageIds[0]!;
    // The editor: reset to a named order football declares other than its group default (the reset select's choice).
    const own = await editOrder(page, request, r, stageId, FB, "group", async (sportDefault, _ctx, section) => {
      const named = FB.tablePresets!("group").tiebreakers.find((p) => p.keys.join() !== sportDefault.join());
      expect(named, "premise: football names an order other than its group default").toBeDefined();
      await section.getByTestId("stage-tiebreaks-reset").selectOption(named!.id);
      return [...named!.keys];
    });
    const fixtures = await generateAndStart(request, r, stageId, own);
    // X, Y, Z: the pool the first seed was drawn into, in seed order (the draw is the product's, read off the fixtures).
    const poolId = fixtures.find((f) => f.home_entrant_id === r.field[0]!.id || f.away_entrant_id === r.field[0]!.id)!.pool_id;
    const inPool = new Set(fixtures.filter((f) => f.pool_id === poolId).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]));
    const [X, Y, Z] = r.field.filter((w) => inPool.has(w.id));
    expect([X, Y, Z].every(Boolean) && inPool.size === 3, "rig: a pool of three").toBe(true);

    // X v Y: 1-1 at full time through the API (setup), then every kick TAPPED.
    const xy = between(fixtures, X!, Y!);
    await lineUp(request, xy, [
      { who: xy.home_entrant_id === X!.id ? X! : Y!, positionKey: "FW" },
      { who: xy.home_entrant_id === X!.id ? Y! : X!, positionKey: "GK" },
    ]);
    await play(request, xy, [["core.start"], ["football.goal", { by: X!.id }], ["football.goal", { by: Y!.id }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]]);
    await openPad(page, xy);
    await expect(tile(page, "kick-home"), "SPEC §5.2: the pad offers the kicks in a GROUP stage with the shoot-out on").toBeVisible({ timeout: STEP_MS });
    let kicks = 0;
    for (let round = 0; round < 12; round++) {
      if ((await fixtureState(request, xy.id)).outcome !== null) break;
      const homeOff = await tile(page, "kick-home").getAttribute("data-tile-disabled");
      const awayOff = await tile(page, "kick-away").getAttribute("data-tile-disabled");
      expect([homeOff, awayOff], "both kick tiles disabled with the shoot-out still live").not.toEqual(["true", "true"]);
      const side: Side = homeOff === "true" ? "away" : "home";
      const by = side === "home" ? xy.home_entrant_id! : xy.away_entrant_id!;
      const option = by === X!.id ? "scored" : "missed";
      const ev = await landed(page, xy, async () => {
        await tile(page, `kick-${side}`).click();
        await expect(sheet(page), `kick-${side} opens its sheet`).toBeVisible({ timeout: STEP_MS });
        await sheet(page).locator(`[data-choice-option-id="${option}"]`).click();
      });
      expect([ev.type, ev.payload.by, ev.payload.scored], `kick ${round + 1}: the ledger agrees with the tap`).toEqual(["football.shootout.kick", by, option === "scored"]);
      kicks++;
    }
    expect(kicks, "anti-vacuity: the shoot-out was kicked by hand").toBeGreaterThan(0);
    await expectDecided(request, xy, { winner: X!.id, method: "shootout" }, "the tapped kicks decided X v Y on the shoot-out");
    // The other two results of the pool (setup): X beats Z 1-0, Y beats Z 2-0.
    const xz = between(fixtures, X!, Z!);
    await play(request, xz, [["core.start"], ["football.goal", { by: X!.id }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]]);
    const yz = between(fixtures, Y!, Z!);
    await play(request, yz, [["core.start"], ["football.goal", { by: Y!.id }], ["football.goal", { by: Y!.id }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]]);

    // FIFA 3/1/0, the group shoot-out a draw for both and +1 for its winner (B2): X D(1)+1 + W(3) = 5; Y D(1) + W(3) = 4.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: X!.name, cells: { ...pwdlp(2, 1, 1, 0, "5"), [COL.gf]: "2" } },
      { name: Y!.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.gf]: "3" } },
      { name: Z!.name, cells: { ...pwdlp(2, 0, 0, 2, "0"), [COL.gf]: "0" } },
    ], "football group shoot-out");
  });

  test("hockey Pro League: the goal type is asked on the pad, the shoot-out is D for both and +1 for its winner, and the field-goals column counts only the field goals", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 3, api: 40, publicReads: 1 }));
    const HK = mod("hockey");
    // FIH Pro League as the engine declares it: the `fih-shootout` variant (its points ARE the `pro_league` preset).
    const r = await rig(request, { label: "Hockey PL", sport: "hockey", variant: "fih-shootout", kind: "team", size: 3, rostered: true, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const kinds = (HK.configSchema.parse(r.cfg) as { goalKinds: string[] }).goalKinds;
    expect(kinds, "premise: FIH GTR App. 3 — the three goal types are recorded").toEqual(expect.arrayContaining(["fg", "pc", "stroke"]));
    // Keep points and field goals (the FG column shows while the order asks it).
    const own = await editOrder(page, request, r, stageId, HK, "league", removeHarmless((k, i) => i < 1 || k === "field_goals"));
    expect(own, "the order still asks field goals").toContain("field_goals");
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];

    // A v B: both goals TAPPED with their type; A field goal, B penalty corner. Then to full time 1-1 and A's shoot-out.
    const ab = between(fixtures, A, B);
    await lineUp(request, ab, [{ who: A }, { who: B }]);
    await openLive(page, ab);
    const typed = async (who: Who, kind: string) => {
      const ev = await landed(page, ab, async () => {
        await tile(page, `goal-${sideOf(ab, who)}`).click();
        const choice = pad(page).getByTestId("pad-dock-choice");
        await expect(choice, "a hockey goal tap asks its type (T18)").toBeVisible({ timeout: STEP_MS });
        await choice.getByTestId(`pad-dock-chip-kind:${kind}`).click();
        await expect(choice).toHaveCount(0, { timeout: STEP_MS });
      });
      expect([ev.type, ev.payload.by, ev.payload.kind], "the ledger carries the side and the type tapped").toEqual(["hockey.goal", who.id, kind]);
    };
    await typed(A, "fg");
    await typed(B, "pc");
    await play(request, ab, [["hockey.period.advance", { to: "Q2" }], ["hockey.period.advance", { to: "Q3" }], ["hockey.period.advance", { to: "Q4" }], ["hockey.period.advance", { to: "FT" }]]);
    expect(await shootoutTo(request, ab, A, "hockey.shootout.attempt"), "anti-vacuity: shoot-out attempts").toBeGreaterThan(0);
    await expectDecided(request, ab, { winner: A.id, method: "shootout" }, "A won the shoot-out");
    const toFt: Ev[] = [["hockey.period.advance", { to: "Q2" }], ["hockey.period.advance", { to: "Q3" }], ["hockey.period.advance", { to: "Q4" }], ["hockey.period.advance", { to: "FT" }]];
    // A beats C 2-0 (two field goals); B beats C 1-0 (a penalty stroke).
    await play(request, between(fixtures, A, C), [["core.start"], ["hockey.goal", { by: A.id, kind: "fg" }], ["hockey.goal", { by: A.id, kind: "fg" }], ...toFt]);
    await play(request, between(fixtures, B, C), [["core.start"], ["hockey.goal", { by: B.id, kind: "stroke" }], ...toFt]);

    // Pro League: the shoot-out D for both, +1 to A: A 1+1+3 = 5, B 1+3 = 4. Field goals: A 1 + 2 = 3, B 0 (a corner and
    // a stroke are not field goals), C 0.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: A.name, cells: { ...pwdlp(2, 1, 1, 0, "5"), [COL.fieldGoals]: "3" } },
      { name: B.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.fieldGoals]: "0" } },
      { name: C.name, cells: { ...pwdlp(2, 0, 0, 2, "0"), [COL.fieldGoals]: "0" } },
    ], "hockey Pro League");
  });

  test("ice hockey IIHF: an overtime goal tapped and a game-winning shot book OTW/OTL, 3-2-1-0", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 1, api: 50, publicReads: 1 }));
    const IH = mod("icehockey");
    const r = await rig(request, { label: "IIHF", sport: "icehockey", variant: "iihf", kind: "team", size: 3, rostered: true, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, IH, "league", removeHarmless((_k, i) => i < 1));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    const toFt: Ev[] = [["icehockey.period.advance", { to: "P2" }], ["icehockey.period.advance", { to: "P3" }], ["icehockey.period.advance", { to: "FT" }]];

    // A v B: 0-0 after regulation (setup), the sudden-death overtime goal TAPPED for A.
    const ab = between(fixtures, A, B);
    await lineUp(request, ab, [{ who: A }, { who: B }]);
    await play(request, ab, [["core.start"], ...toFt]);
    await openPad(page, ab);
    const ot = await landed(page, ab, () => tile(page, `goal-${sideOf(ab, A)}`).click());
    expect([ot.type, ot.payload.by], "the overtime goal the scorer tapped").toEqual(["icehockey.goal", A.id]);
    await expectDecided(request, ab, { winner: A.id, method: "extra_time" }, "A won in overtime");
    // B v C: level through overtime, B wins the game-winning shots.
    const bc = between(fixtures, B, C);
    await play(request, bc, [["core.start"], ...toFt, ["icehockey.period.advance", { to: "FT" }]]);
    expect(await shootoutTo(request, bc, B, "icehockey.shootout.attempt"), "anti-vacuity: shots taken").toBeGreaterThan(0);
    await expectDecided(request, bc, { winner: B.id, method: "shootout" }, "B won the shots");
    // C beats A 1-0 in regulation.
    await play(request, between(fixtures, C, A), [["core.start"], ["icehockey.goal", { by: C.id }], ...toFt]);

    // IIHF: regulation W 3, OT/GWS W 2, OT/GWS L 1, regulation L 0. C 1+3 = 4, B 1+2 = 3, A 2+0 = 2.
    const row = (p: number, w: number, otw: number, otl: number, l: number, pts: string) => ({
      [COL.played]: String(p), [COL.won]: String(w), [COL.otw]: String(otw), [COL.otl]: String(otl), [COL.lost]: String(l), [COL.points]: pts,
    });
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    const t = await expectPublicTable(visitor, r.path, [
      { name: C.name, cells: row(2, 1, 0, 1, 0, "4") },
      { name: B.name, cells: row(2, 0, 1, 1, 0, "3") },
      { name: A.name, cells: row(2, 0, 1, 0, 1, "2") },
    ], "ice hockey IIHF");
    expect(t.headers, "no match was level: no drawn column").not.toContain(COL.drawn);
  });

  test("best third across groups (Task 12): the editor's order reaches the cross-group comparison — goals for before goal difference seats the other third", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 0, api: 60, publicReads: 1 }));
    const FB = mod("football");
    const r = await rig(request, {
      label: "FB best3",
      sport: "football",
      variant: "11-a-side",
      kind: "team",
      size: 6,
      rostered: false,
      stages: [
        { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
        {
          seq: 2,
          kind: "knockout",
          name: "Finals",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }, { kind: "bestNth", nth: 3, count: 1 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
    });
    const [groupId, koId] = r.stageIds as [string, string];
    // Goals for above goal difference: the down arrow on the difference step (premise: the two are adjacent).
    const own = await editOrder(page, request, r, groupId, FB, "group", async (sportDefault, ctx, section) => {
      const at = sportDefault.indexOf("diff");
      expect([at > 0, sportDefault[at + 1]], "premise: football's group order asks goal difference, then goals for").toEqual([true, "for"]);
      return moveDown(at)(sportDefault, ctx, section);
    });
    const cross = own.filter((k) => !isHeadToHeadKey(k));
    const fixtures = await generateAndStart(request, r, groupId, own);
    // X-TB-7: between groups the pin's order without its head-to-head steps, shown read-only on the editor.
    expect((await servedRules(request, groupId)).crossGroup.keys.filter((k) => !isHeadToHeadKey(k)), "the cross-group order served").toEqual(cross);
    const section = await openEditor(page, request, r.divisionId, groupId);
    await expect(section.getByTestId("stage-tiebreaks-cross-group")).toHaveText(say("stageTiebreaks.crossGroup", { steps: cross.map(stepWord).join(", ") }));

    const pools = [...new Set(fixtures.map((f) => f.pool_id))];
    expect(pools.length, "rig: two groups").toBe(2);
    const members = (pool: string | null) => {
      const ids = new Set(fixtures.filter((f) => f.pool_id === pool).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]));
      return r.field.filter((w) => ids.has(w.id)) as [Who, Who, Who];
    };
    const [X1, Y1, Z1] = members(pools[0]!);
    const [X2, Y2, Z2] = members(pools[1]!);
    const result = async (w: Who, l: Who, [gw, gl]: readonly [number, number]) => {
      const f = between(fixtures, w, l);
      const goals: Ev[] = [...Array<Ev>(gw).fill(["football.goal", { by: w.id }]), ...Array<Ev>(gl).fill(["football.goal", { by: l.id }])];
      await play(request, f, [["core.start"], ...goals, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]]);
    };
    // Group 1: X1 2-0 Y1, X1 1-0 Z1, Y1 1-0 Z1 → Z1 0 points, goals for 0, difference −2.
    await result(X1, Y1, [2, 0]);
    await result(X1, Z1, [1, 0]);
    await result(Y1, Z1, [1, 0]);
    // Group 2: X2 2-0 Y2, X2 5-3 Z2, Y2 2-0 Z2 → Z2 0 points, goals for 3, difference −4.
    await result(X2, Y2, [2, 0]);
    await result(X2, Z2, [5, 3]);
    await result(Y2, Z2, [2, 0]);
    // The thirds: level on points; the edited order asks goals for first (Z2 3 > Z1 0), the sport's default would ask the
    // difference first (Z1 −2 > Z2 −4). The seconds: Y2 (difference 0, for 2) beats Y1 (−1, 1) on either order.
    const done = await apiJson<{ qualified?: { stage_id: string; entrants: string[] } }>(request, `/api/v1/stages/${groupId}/complete`, "POST");
    expect(done.status, `complete the groups: ${JSON.stringify(done.error)}`).toBeLessThan(300);
    expect(done.data!.qualified?.stage_id, "the groups seed the finals").toBe(koId);
    expect([...(done.data!.qualified?.entrants ?? [])].sort(), "two winners, the best second, the best third ON THE EDITED ORDER").toEqual([X1.id, X2.id, Y2.id, Z2.id].sort());
    const seated = new Set((await fixturesOf(request, r.divisionId, koId)).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]));
    expect([seated.has(Z2.id), seated.has(Z1.id)], "the finals seat Z2, not Z1").toEqual([true, false]);

    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: X1.name, cells: pwlp(2, 2, 0, "6") },
      { name: Y1.name, cells: pwlp(2, 1, 1, "3") },
      { name: Z1.name, cells: { ...pwlp(2, 0, 2, "0"), [COL.gf]: "0" } },
    ], "best third: group 1");
    const t2 = tableWith(await publicTables(visitor), X2.name);
    expect(t2, "group 2's table is on the same page").not.toBeNull();
    expectRows(t2!, [
      { name: X2.name, cells: pwlp(2, 2, 0, "6") },
      { name: Y2.name, cells: pwlp(2, 1, 1, "3") },
      { name: Z2.name, cells: { ...pwlp(2, 0, 2, "0"), [COL.gf]: "3" } },
    ], "best third: group 2");
  });
});

// ── sets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("sets: volleyball, badminton, table tennis", () => {
  test("volleyball best of 3: a 2-1 pays 2:1 and a 2-0 pays 3:0 on the public table", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 0, api: 30, publicReads: 1 }));
    const VB = mod("volleyball");
    const r = await rig(request, { label: "VB bo3", sport: "volleyball", variant: "indoor", config: { bestOf: 3 }, kind: "team", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
    expect(VB.configSchema.parse(r.cfg), "rig: best of three").toMatchObject({ bestOf: 3 });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, VB, "league", removeHarmless((_k, i) => i < 2));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    const sets = async (w: Who, l: Who, scores: readonly (readonly [number, number])[]) => {
      const f = between(fixtures, w, l);
      await play(request, f, [["core.start"], ...scores.map((s): Ev => ["volleyball.set.summary", oriented(f, w, s)])]);
      await expectDecided(request, f, { winner: w.id }, `${w.name} won`);
    };
    await sets(A, B, [[25, 20], [20, 25], [15, 10]]);
    await sets(A, C, [[25, 20], [25, 20]]);
    await sets(B, C, [[25, 20], [25, 20]]);
    // FIVB best of three (D10 a): 2-0 pays 3:0, 2-1 pays 2:1. A 2 + 3 = 5, B 1 + 3 = 4, C 0.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: A.name, cells: pwlp(2, 2, 0, "5") },
      { name: B.name, cells: pwlp(2, 1, 1, "4") },
      { name: C.name, cells: pwlp(2, 0, 2, "0") },
    ], "volleyball best of 3");
  });

  test("badminton BWF: three level on wins split by game difference, then two by their own match; a rally tapped", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 2, api: 60, publicReads: 1 }));
    const BD = mod("badminton");
    // Games to 3 so a match is a dozen rallies (the order under test never reads the game length).
    const r = await rig(request, { label: "BWF", sport: "badminton", variant: "bwf", config: { setTo: 3, finalSetTo: 3, cap: 5 }, kind: "individual", size: 4, rostered: true, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    // Keep the first four steps (wins, head-to-head of two, game difference, head-to-head of two): they decide this table.
    const own = await editOrder(page, request, r, stageId, BD, "league", removeHarmless((_k, i) => i < 4));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C, D] = r.field as [Who, Who, Who, Who];

    // A v B 2-1 by rallies: the first TAPPED, the rest posted (3-1, 1-3, 3-1).
    const ab = between(fixtures, A, B);
    await lineUp(request, ab, [{ who: A }, { who: B }]);
    await openLive(page, ab);
    const rally = await landed(page, ab, () => half(page, sideOf(ab, A)).click());
    expect([rally.type, rally.payload.wonBy], "the tapped rally").toEqual(["badminton.rally", A.id]);
    const rallies = (winners: readonly Who[]): Ev[] => winners.map((w): Ev => ["badminton.rally", { wonBy: w.id }]);
    await play(request, ab, rallies([A, B, A, /* 3-1 */ B, B, A, B, /* 1-3 */ A, A, B, A /* 3-1 */]));
    await expectDecided(request, ab, { winner: A.id }, "A won 2-1");
    const games = async (w: Who, l: Who, scores: readonly (readonly [number, number])[]) => {
      const f = between(fixtures, w, l);
      await play(request, f, [["core.start"], ...scores.map((s): Ev => ["badminton.game.summary", oriented(f, w, s)])]);
      await expectDecided(request, f, { winner: w.id }, `${w.name} won`);
    };
    await games(B, C, [[3, 1], [0, 3], [3, 1]]);
    await games(C, A, [[3, 0], [0, 3], [3, 0]]);
    await games(A, D, [[3, 0], [3, 0]]);
    await games(B, D, [[3, 1], [1, 3], [3, 1]]);
    await games(C, D, [[3, 0], [0, 3], [3, 0]]);
    // BWF 16.2.1: A, B, C on two wins each. 16.2.3, three level: game difference A +1 −1 +2 = +2, B −1 +1 +1 = +1,
    // C −1 +1 +1 = +1 → A. 16.2.2, two left level: B beat C → B. Flat 2/0.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: A.name, cells: pwlp(3, 2, 1, "4") },
      { name: B.name, cells: pwlp(3, 2, 1, "4") },
      { name: C.name, cells: pwlp(3, 2, 1, "4") },
      { name: D.name, cells: pwlp(3, 0, 3, "0") },
    ], "badminton BWF");
  });

  test("table tennis: a walkover given through the console's forfeit dialog pays its loser 0, a played loss 1", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 1, api: 30, publicReads: 1 }));
    const TT = mod("tabletennis");
    const r = await rig(request, { label: "TT WO", sport: "tabletennis", variant: "bo5", kind: "individual", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, TT, "league", removeHarmless((_k, i) => i < 1));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    // A beats B 3-1 (setup).
    const ab = between(fixtures, A, B);
    await play(request, ab, [["core.start"], ...([[11, 5], [5, 11], [11, 5], [11, 5]] as const).map((s): Ev => ["tabletennis.game.summary", oriented(ab, A, s)])]);
    await expectDecided(request, ab, { winner: A.id }, "A won 3-1");
    // C does not turn up against A: the organiser walks it over in the console's dialog (C's side forfeits).
    const ac = between(fixtures, A, C);
    await page.goto(await fixturePath(request, ac.id), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await page.getByTestId("score-forfeit").click({ timeout: STEP_MS });
    const dialog = page.getByTestId("forfeit-dialog");
    await expect(dialog).toBeVisible({ timeout: STEP_MS });
    await dialog.getByTestId(`forfeit-who-${sideOf(ac, C)}`).click();
    await expect(dialog.getByTestId("forfeit-why-walkover"), "before play the one reason is a walkover").toBeChecked();
    await dialog.getByTestId("forfeit-confirm").click();
    await expect
      .poll(async () => (await ledger(request, ac.id)).filter((e) => e.type === "core.forfeit").map((e) => e.payload), { timeout: STEP_MS })
      .toEqual([{ by: C.id, reason: "walkover" }]);
    // D6: W 2, a played loss 1, an unplayed loss 0. A 2 + 2 = 4, B 1, C 0. B v C is never played.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      // Wins and points only: whether a walkover is "played" is the table's convention, not a rulebook number.
      { name: A.name, cells: { [COL.won]: "2", [COL.points]: "4" } },
      { name: B.name, cells: { [COL.won]: "0", [COL.points]: "1" } },
      { name: C.name, cells: { [COL.won]: "0", [COL.points]: "0" } },
    ], "table tennis walkover");
  });
});

// ── tennis ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("tennis", () => {
  test("tennis: on two wins each, more matches played ranks above head-to-head and set ratio (ATP 4.01 C.3-2); a point tapped", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 1, api: 90, publicReads: 1 }));
    const TN = mod("tennis");
    // One-game sets, so a set is four points (the order under test never reads the set length).
    const r = await rig(request, {
      label: "Tennis",
      sport: "tennis",
      variant: "tour",
      config: { set: { gamesTo: 1, winBy: 1, tiebreakAt: null, tiebreakTo: 7 } },
      kind: "individual",
      size: 4,
      rostered: true,
      stages: [{ seq: 1, kind: "league", name: "League" }],
    });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, TN, "league", removeHarmless((_k, i) => i < 2));
    expect(own.slice(0, 2), "the order still asks wins, then matches played").toEqual(["wins", "matches_played"]);
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [X, Y, Z, W] = r.field as [Who, Who, Who, Who];
    const game = (w: Who): Ev[] => Array.from({ length: 4 }, (): Ev => ["tennis.point", { by: w.id }]);
    // Y beats X 2-1: the first point TAPPED, the rest posted.
    const yx = between(fixtures, Y, X);
    await lineUp(request, yx, [{ who: Y }, { who: X }]);
    await openLive(page, yx);
    const point = await landed(page, yx, () => half(page, sideOf(yx, Y)).click());
    expect([point.type, point.payload.by], "the tapped point").toEqual(["tennis.point", Y.id]);
    await play(request, yx, [...game(Y).slice(1), ...game(X), ...game(Y)]);
    await expectDecided(request, yx, { winner: Y.id }, "Y won 2-1");
    const match = async (w: Who, l: Who) => {
      const f = between(fixtures, w, l);
      await play(request, f, [["core.start"], ...game(w), ...game(w)]);
      await expectDecided(request, f, { winner: w.id }, `${w.name} won`);
    };
    await match(Y, Z);
    await match(X, Z);
    await match(X, W);
    await match(Z, W);
    // Y v W is never played. X and Y two wins each: X played 3 (a 2-1 record), Y 2 (2-0) → X, though Y beat X and Y's set
    // ratio (4/1) is above X's (5/2). W2/L0.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: X.name, cells: pwlp(3, 2, 1, "4") },
      { name: Y.name, cells: pwlp(2, 2, 0, "4") },
      { name: Z.name, cells: pwlp(3, 1, 2, "2") },
      { name: W.name, cells: pwlp(2, 0, 2, "0") },
    ], "tennis matches played");
  });
});

// ── cricket ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("cricket", () => {
  test("cricket: a tie pays 1 each and a no-result (abandoned before a chase, from the console) 1 each", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 1, api: 20, publicReads: 1 }));
    const CR = mod("cricket");
    const r = await rig(request, { label: "T20", sport: "cricket", variant: "t20", kind: "team", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const balls = (CR.configSchema.parse(r.cfg) as { ballsPerInnings: number }).ballsPerInnings;
    const own = await editOrder(page, request, r, stageId, CR, "league", removeHarmless((_k, i) => i < 1));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    const innings = (runs: number, wickets: number, legalBalls = balls): Ev => ["cricket.innings.summary", { runs, wickets, legalBalls }];
    // A v B tie: 150 each.
    const ab = between(fixtures, A, B);
    await play(request, ab, [["core.start"], innings(150, 5), innings(150, 7)]);
    await expectDecided(request, ab, { kind: "tie" }, "A v B tied");
    // A beats C: A defends 150 batting first, or chases 101 batting second, as the fixture seats them.
    const ac = between(fixtures, A, C);
    await play(request, ac, [["core.start"], ...(sideOf(ac, A) === "home" ? [innings(150, 5), innings(100, 6)] : [innings(100, 6), innings(101, 2, 90)])]);
    await expectDecided(request, ac, { winner: A.id }, "A won");
    // B v C: started, then abandoned before a chase — the organiser's Abandon in the console.
    const bc = between(fixtures, B, C);
    await play(request, bc, [["core.start"]]);
    await page.goto(await fixturePath(request, bc.id), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await page.getByRole("button", { name: say("score.abandon"), exact: true }).click({ timeout: STEP_MS });
    await page.getByTestId("score-prompt-reason").fill("Rain");
    await page.getByTestId("score-prompt-submit").click();
    await expectDecided(request, bc, { kind: "no_result" }, "B v C is a no result");
    // W 2, tie 1, NR 1: A 1 + 2 = 3, B 1 + 1 = 2, C 1 + 0 = 1.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: A.name, cells: { [COL.played]: "2", [COL.won]: "1", [COL.ties]: "1", [COL.noResults]: "0", [COL.points]: "3" } },
      { name: B.name, cells: { [COL.played]: "2", [COL.won]: "0", [COL.ties]: "1", [COL.noResults]: "1", [COL.points]: "2" } },
      { name: C.name, cells: { [COL.played]: "2", [COL.won]: "0", [COL.ties]: "0", [COL.noResults]: "1", [COL.points]: "1" } },
    ], "cricket tie and no result");
  });
});

// ── boards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("boards: chess, carrom", () => {
  test("chess round robin: points in half-points ('1½'), and Sonneborn-Berger moved above wins in the editor splits the pair on 1½", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 1, api: 30, publicReads: 2 }));
    const CH = mod("boardgame");
    const r = await rig(request, { label: "Chess RR", sport: "boardgame", variant: "classical", kind: "individual", size: 4, rostered: true, stages: [{ seq: 1, kind: "league", name: "Round robin" }] });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, CH, "league", async (sportDefault, ctx, section) => {
      const at = sportDefault.indexOf("wins");
      expect([at > 0, sportDefault[at + 1]], "premise: the chess order asks wins, then Sonneborn-Berger").toEqual([true, "sberger"]);
      return moveDown(at)(sportDefault, ctx, section);
    });
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C, D] = r.field as [Who, Who, Who, Who];
    // The first public read: generated, nothing played — the level table.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectLevelTable(visitor, r.path, r.field);

    // A v B: a draw TAPPED on the pad's draw tile.
    const ab = between(fixtures, A, B);
    await lineUp(request, ab, [{ who: A }, { who: B }]);
    await play(request, ab, [["core.start"]]);
    await openPad(page, ab);
    const draw = await landed(page, ab, () => tile(page, "draw").click());
    expect([draw.type, draw.payload.winner], "the tapped draw").toEqual(["boardgame.result", null]);
    await expectDecided(request, ab, { kind: "draw" }, "A v B drawn");
    const result = async (x: Who, y: Who, winner: Who | null) =>
      play(request, between(fixtures, x, y), [["core.start"], ["boardgame.result", winner === null ? { winner: null, method: "agreement" } : { winner: winner.id, method: "checkmate" }]]);
    await result(B, C, null);
    await result(B, D, null);
    await result(A, D, A);
    await result(C, A, C);
    await result(C, D, C);
    // FIDE 1/½/0: C ½+1+1 = 2½, A ½+1+0 = 1½, B ½+½+½ = 1½, D 0+½+0 = ½. A and B drew each other. Sonneborn-Berger: A
    // (beat D ½, drew B 1½/2) 1¼, B (drew A, C, D: (1½ + 2½ + ½)/2) 2¼ → B above A; on wins (A 1, B 0) A would be.
    await expectPublicTable(visitor, r.path, [
      { name: C.name, cells: pwdlp(3, 2, 1, 0, "2½") },
      { name: B.name, cells: pwdlp(3, 0, 3, 0, "1½") },
      { name: A.name, cells: pwdlp(3, 1, 1, 1, "1½") },
      { name: D.name, cells: pwdlp(3, 0, 1, 2, "½") },
    ], "chess round robin");
    const t = tableWith(await publicTables(visitor), C.name);
    expect(t!.headers, "the order asks Sonneborn-Berger: its column shows").toContain(COL.sberger);
  });

  test("carrom: three level on points and wins, split by the games ratio", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 0, api: 70, publicReads: 1 }));
    const CM = mod("carrom");
    const r = await rig(request, { label: "Carrom", sport: "carrom", variant: "icf", kind: "individual", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, CM, "league", removeHarmless((_k, i) => i < 3));
    expect(own.slice(0, 3), "the order still asks points, wins, the games ratio").toEqual(["points", "wins", "set_ratio"]);
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    // A game: three boards to one side, nine coins left each (27 ≥ 25, Law 56a).
    const gameTo = (w: Who): Ev[] => Array.from({ length: 3 }, (): Ev => ["carrom.board.summary", { winner: w.id, opponentCoinsLeft: 9 }]);
    const match = async (w: Who, l: Who, games: readonly Who[]) => {
      const f = between(fixtures, w, l);
      await play(request, f, [["core.start"], ...games.flatMap(gameTo)]);
      await expectDecided(request, f, { winner: w.id }, `${w.name} won`);
    };
    await match(A, B, [A, A]);
    await match(B, C, [B, B]);
    await match(C, A, [C, A, C]);
    // 2/1/0: two points each, one win each. Games won/lost: A 3/2 = 1.5, B 2/2 = 1, C 2/3 → A, B, C.
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectPublicTable(visitor, r.path, [
      { name: A.name, cells: pwlp(2, 1, 1, "2") },
      { name: B.name, cells: pwlp(2, 1, 1, "2") },
      { name: C.name, cells: pwlp(2, 1, 1, "2") },
    ], "carrom games ratio");
  });
});

// ── generic ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** generic's order with goals for moved above the difference (the down arrow on `diff`). */
function forFirst(order: readonly TiebreakerKey[]): { at: number; keys: TiebreakerKey[] } {
  const at = order.indexOf("diff");
  expect([at > 0, order[at + 1]], "premise: generic's order asks the difference, then goals for").toEqual([true, "for"]);
  return { at, keys: swapAt(order, at) };
}

test.describe("generic", () => {
  test("generic: a draw settled from the pad's tally, and goals for moved above the difference in the editor ranks the higher-scoring of two level", async ({ page, request, browser }) => {
    test.setTimeout(budget({ taps: 3, api: 10, publicReads: 2 }));
    const G = mod("generic");
    const r = await rig(request, { label: "Generic", sport: "generic", variant: "score", kind: "individual", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
    const stageId = r.stageIds[0]!;
    const own = await editOrder(page, request, r, stageId, G, "league", async (sportDefault, ctx, section) => moveDown(forFirst(sportDefault).at)(sportDefault, ctx, section));
    const fixtures = await generateAndStart(request, r, stageId, own);
    const [A, B, C] = r.field as [Who, Who, Who];
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    await expectLevelTable(visitor, r.path, r.field);

    // A v B 1-1 on the pad: a point each TAPPED, then the tally settled (a draw: the score variant allows one).
    const ab = between(fixtures, A, B);
    await play(request, ab, [["core.start"]]);
    await openPad(page, ab);
    for (const who of [A, B]) {
      const pt = await landed(page, ab, () => half(page, sideOf(ab, who)).click());
      expect([pt.type, pt.payload.by, pt.payload.points], `${who.name}'s tapped point`).toEqual(["generic.score", who.id, 1]);
    }
    const settled = await landed(page, ab, () => tile(page, "settle").click());
    expect(settled.type, "the tally settled").toBe("generic.result");
    await expectDecided(request, ab, { kind: "draw" }, "A v B drawn 1-1");
    const result = async (w: Who, l: Who, s: readonly [number, number]) => {
      const f = between(fixtures, w, l);
      const o = oriented(f, w, s);
      await play(request, f, [["generic.result", { p1Score: o.home, p2Score: o.away }]]);
    };
    await result(A, C, [2, 0]);
    await result(B, C, [5, 4]);
    // 3/1/0: A and B 4 each. The edited order asks goals for first: B 6 > A 3 (the sport's default, the difference,
    // would put A +2 above B +1).
    await expectPublicTable(visitor, r.path, [
      { name: B.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.for]: "6" } },
      { name: A.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.for]: "3" } },
      { name: C.name, cells: { ...pwdlp(2, 0, 0, 2, "0"), [COL.for]: "4" } },
    ], "generic goals for first");
  });
});

// ── the pin (X-TB-2) ───────────────────────────────────────────────────────────────────────────────────────────────────

test("pin: a started stage's public table does not move after the division default changes", async ({ page, request, browser }) => {
  test.setTimeout(budget({ taps: 0, api: 20, publicReads: 3 }));
  const G = mod("generic");
  const r = await rig(request, { label: "Pin", sport: "generic", variant: "score", kind: "individual", size: 3, rostered: false, stages: [{ seq: 1, kind: "league", name: "League" }] });
  const stageId = r.stageIds[0]!;
  const cfg = G.configSchema.parse(r.cfg);
  const sportDefault = G.defaultTiebreakers("league", cfg as never);
  const EDITED = forFirst(sportDefault).keys;
  expect(validateCascade(EDITED, ctxOf(G, cfg, "league")), "premise: the division's later order is valid").toEqual([]);

  // Generate: the stage has no order of its own, so it pins the sport's — and the division's points, generic's 3/1/0.
  const fixtures = await generateAndStart(request, r, stageId, sportDefault, "sport");
  const pin = await servedRules(request, stageId);
  expect([pin.points.rule.win.regulation, pin.points.rule.draw, pin.points.rule.loss.regulation], "the pin pays 3/1/0").toEqual([3, 1, 0]);
  const [A, B, C] = r.field as [Who, Who, Who];
  const result = async (w: Who, l: Who, s: readonly [number, number]) => {
    const f = between(fixtures, w, l);
    const o = oriented(f, w, s);
    await play(request, f, [["generic.result", { p1Score: o.home, p2Score: o.away }]]);
  };
  // Scored before the change: A 1-1 B, A 2-0 C.
  await result(A, B, [1, 1]);
  await result(A, C, [2, 0]);
  const before: Want[] = [
    { name: A.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.for]: "3" } },
    { name: B.name, cells: { ...pwdlp(1, 0, 1, 0, "1"), [COL.for]: "1" } },
    { name: C.name, cells: { ...pwdlp(1, 0, 0, 1, "0"), [COL.for]: "0" } },
  ];
  const visitor = await spectator(browser, { width: 1280, height: 900 });
  await expectPublicTable(visitor, r.path, before, "pin: before the change");

  // The division default changes. Points through Settings → Format (a win now pays 4): the save lands and says the started
  // stage keeps what it started with.
  await page.goto(await divisionPath(request, r.divisionId, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
  await page.getByRole("button", { name: /^Format/ }).click();
  const win = page.getByRole("spinbutton", { name: say("divset.win") });
  await expect(win, "the division's win points, as stored (generic 3/1/0)").toHaveValue("3");
  await win.fill("4");
  await page.getByRole("button", { name: say("divset.saveRules") }).click();
  await expect(page.getByText(say("divset.notice.rulesSaved"))).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId(`division-kept-pinned-${stageId}`)).toHaveText(say("divset.keptPinned", { stage: "League" }));
  // The order: Settings carries no division order editor (spec §9), so its one door, PATCH /divisions/{id}.
  const patched = await apiJson<Record<string, unknown>>(request, `/api/v1/divisions/${r.divisionId}`, "PATCH", { tiebreakers: EDITED });
  expect(patched.status, `the division order saves: ${JSON.stringify(patched.error)}`).toBe(200);
  expect(patched.data?.tiebreakers, "the division's order landed").toEqual(EDITED);
  expect(JSON.stringify(patched.data?.stagesKeptPinned ?? null), "the save names the pinned stage it did not reach").toContain(stageId);
  const held = await servedRules(request, stageId);
  expect([held.tiebreakers.keys, held.tiebreakers.pinnedAt, held.points.rule.win.regulation], "the pin holds").toEqual([[...sportDefault], pin.tiebreakers.pinnedAt, 3]);

  // Unchanged on the visitor's page — and, so the read is not just a cached one, after a result landed past the change:
  // B beats C 5-4. The PIN pays: A 4, B 4, and the pinned order's difference puts A (+2) above B (+1). The division's
  // later rules would pay A 5, B 5 and put B (goals for 6) above A (3).
  await expectPublicTable(visitor, r.path, before, "pin: right after the change");
  await result(B, C, [5, 4]);
  await expectPublicTable(visitor, r.path, [
    { name: A.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.for]: "3" } },
    { name: B.name, cells: { ...pwdlp(2, 1, 1, 0, "4"), [COL.for]: "6" } },
    { name: C.name, cells: { ...pwdlp(2, 0, 0, 2, "0"), [COL.for]: "4" } },
  ], "pin: a result after the change");

  // A NEW pending stage takes the edit: the division's order, and its 4-point win (the division's cfg, read through the
  // sport's points rule).
  const next = await apiJson<{ id: string }>(request, `/api/v1/divisions/${r.divisionId}/stages`, "POST", { seq: 2, kind: "league", name: "League 2" });
  expect(next.status, `a second stage: ${JSON.stringify(next.error)}`).toBeLessThan(300);
  const fresh = await servedRules(request, next.data!.id);
  expect(
    [fresh.tiebreakers.keys, fresh.tiebreakers.source, fresh.tiebreakers.pinnedAt, fresh.points.rule.win.regulation, fresh.points.pinnedAt],
    "the pending stage reads the division's new default",
  ).toEqual([EDITED, "division", null, 4, null]);
  const section = await openEditor(page, request, r.divisionId, next.data!.id);
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-badge", "inherited");
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-source", "division");
  expect(await listed(section), "the new stage's editor lists the division's order").toEqual(EDITED);
  // The started stage's editor still lists what it started with, locked by its first score.
  const pinned = await openEditor(page, request, r.divisionId, stageId, "locked");
  expect(await listed(pinned), "the started stage lists its pinned order").toEqual([...sportDefault]);
});
