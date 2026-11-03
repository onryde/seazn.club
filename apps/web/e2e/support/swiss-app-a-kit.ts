// W3 Swiss e2e kit. The helpers the app-A spec (`../w3-swiss-app-a.spec.ts`) drives its Swiss desk with, moved out of that
// spec in app-B Task 1 (plan R20) so the app-B spec reuses them by import instead of copying them. Behaviour is unchanged:
// each helper is the app-A one, verbatim, now exported. `vitest.config.ts` excludes `e2e/**`, so nothing under this
// directory is collected by vitest; a unit test for pure support code belongs under `src/lib/__tests__/`.
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, divisionPath } from "../helpers";
import { fill, uiEn } from "../match-room-kit";

export type Fx = {
  id: string;
  stage_id: string;
  fixture_no: number;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  scheduled_at: string | null;
  court_id: string | null;
  ext_key?: string | null;
};

export async function stageFixtures(request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return (all.data ?? []).filter((f) => f.stage_id === stageId);
}

export type LateSport = {
  key: "badminton" | "boardgame";
  variant: string;
  config: Record<string, unknown>;
  /** A PLAYED win for `winner`, through the scorer's events: starts the board, then records the result. */
  win(request: APIRequestContext, f: Seated, winner: string): Promise<void>;
  /** The result events alone, for a board that is ALREADY started. A correction voids a result and re-scores the board it
   *  stands on; voiding does not un-start it, so re-sending `core.start` is refused 422 WRONG_PHASE "already started". */
  result(request: APIRequestContext, f: Seated, winner: string): Promise<void>;
};
export type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
export type LateEntryAnswer = {
  entrant_id: string;
  stage_id: string;
  case: "a" | "b" | "c";
  round: number;
  repaired?: { changed_entrant_ids: string[] };
  new_board?: { fixture_id: string; scheduled: boolean };
  bye_holder_id?: string;
};

export async function scoreAt(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown> = {}) {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(state.status, JSON.stringify(state.error)).toBe(200);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type,
    payload,
  });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

export const LATE_SPORTS: LateSport[] = [
  {
    key: "badminton",
    variant: "bwf",
    config: {},
    async win(request, f, winner) {
      await scoreAt(request, f.id, "core.start");
      await this.result(request, f, winner);
    },
    async result(request, f, winner) {
      const homeWins = winner === f.home_entrant_id;
      for (let g = 0; g < 2; g++) {
        await scoreAt(request, f.id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
      }
    },
  },
  {
    key: "boardgame",
    variant: "classical",
    config: { chess: true },
    async win(request, f, winner) {
      await scoreAt(request, f.id, "core.start");
      await this.result(request, f, winner);
    },
    async result(request, f, winner) {
      await scoreAt(request, f.id, "boardgame.result", { winner, method: "resign" });
    },
  },
];

export const isByeRow = (f: Fx) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");

/** A started Swiss with round 1 paired: `n` entrants seeded 1..n, `rounds` rounds. Start mints the shells; one Pair. */
export async function startedSwiss(
  request: APIRequestContext,
  sport: LateSport,
  n: number,
  rounds: number,
  label: string,
  /** W3 T10c: the field's entrant kind (a doubles field is pairs). */
  kind: "individual" | "pair" = "individual",
) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${sport.key} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: sport.key,
    variant_key: sport.variant,
    config: sport.config,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const names = Array.from({ length: n }, (_, i) => `${label} S${i + 1} ${TAG}`);
  const added = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((display_name, i) => ({ kind, display_name, seed: i + 1, members: [] })),
  );
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const stageId = stage.data!.id;
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
  const paired = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(paired.status, `pair round 1 → ${JSON.stringify(paired.error)}`).toBe(200);
  const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
  const idOf = (name: string) => [...nameOf].find(([, v]) => v === name)![0];
  const round = async (r: number) =>
    ((await stageFixtures(request, divisionId, stageId)) as Seated[])
      .filter((f) => f.round_no === r)
      .sort((a, b) => a.seq_in_round - b.seq_in_round);
  const boards = async (r: number) => (await round(r)).filter((f) => !isByeRow(f) && f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect((await boards(1)).length, "premise: round 1 is paired").toBe(Math.floor(n / 2));
  return { divisionId, stageId, names, nameOf, idOf, round, boards };
}

/** The organiser's path: the fixtures tab's rail → More → Add late player → the Entrants tab's add form, a name, Add.
 *  Answers the POST the form sent (status and body), read off the wire. */
export async function addLatePlayer(
  page: Page,
  request: APIRequestContext,
  divisionId: string,
  name: string,
  /** Owner ruling 2026-11-01: a late arrival not yet in Players is created through the form's own New player. */
  opts: {
    viaNewPlayer?: boolean;
    /** W3 T10c: a doubles PAIR — the Pair kind, one player picked from Players, the other created with New player. */
    pair?: { existing: string; created: string };
  } = {},
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const more = page.getByTestId("stage-more");
  await expect(more, "a started, paired Swiss offers More").toBeVisible({ timeout: 20_000 });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(page.getByTestId("stage-more-menu")).toBeVisible();
  await page.getByTestId("stage-add-late-player").click();
  await expect(page).toHaveURL(/[?&]tab=entrants/, { timeout: 20_000 });
  const form = page.locator("#add-entrant");
  await expect(form.getByTestId("entrants-swiss-late-note")).toHaveText(uiEn["entrants.swissLate.note"]!);
  // Landing on the anchor leaves the note readable: not under the sticky app header (hit-test, not box size).
  await expect
    .poll(() =>
      form.getByTestId("entrants-swiss-late-note").evaluate((note) => {
        const box = note.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + 4, box.top + 4);
        return hit !== null && note.contains(hit);
      }),
    )
    .toBe(true);
  if (opts.pair) {
    const { existing, created } = opts.pair;
    const pairChip = form.getByRole("group", { name: uiEn["entrants.add.kind"]! }).locator('[data-kind="pair"]');
    await pairChip.click();
    await expect(pairChip).toHaveAttribute("aria-pressed", "true");
    // Players is the org's whole list: search it, then pick the chip.
    await form.getByPlaceholder(uiEn["entrants.add.searchPlayers"]!).fill(existing);
    const picked = form.getByRole("button", { name: existing, exact: true });
    await picked.click();
    await expect(picked).toHaveAttribute("aria-pressed", "true");
    const createdPerson = page.waitForResponse((r) => r.url().endsWith("/api/v1/persons") && r.request().method() === "POST");
    await form.getByTestId("new-player-name").fill(created);
    await form.getByTestId("new-player-add").click();
    expect((await createdPerson).status(), "New player creates the partner").toBe(201);
    await expect(form.getByTestId("new-player-note")).toHaveText(fill("entrants.add.newPlayer.created", { name: created }));
    await expect(form.getByRole("button", { name: created, exact: true })).toHaveAttribute("aria-pressed", "true");
    // The pair's Name follows its two players.
    await expect
      .poll(async () => {
        const v = await form.getByLabel(uiEn["entrants.add.name"]!, { exact: true }).inputValue();
        return v.includes(existing) && v.includes(created);
      })
      .toBe(true);
  } else if (opts.viaNewPlayer) {
    const createdPerson = page.waitForResponse((r) => r.url().endsWith("/api/v1/persons") && r.request().method() === "POST");
    await form.getByTestId("new-player-name").fill(name);
    await form.getByTestId("new-player-add").click();
    expect((await createdPerson).status(), "New player creates the person").toBe(201);
    await expect(form.getByTestId("new-player-note")).toHaveText(fill("entrants.add.newPlayer.created", { name }));
    // Picked through the form's own pick path: the chip is pressed and the entrant's Name follows the person.
    await expect(form.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByLabel(uiEn["entrants.add.name"]!, { exact: true })).toHaveValue(name);
  } else {
    await form.getByLabel(uiEn["entrants.add.name"]!, { exact: true }).fill(name);
  }
  const answered = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/divisions/${divisionId}/entrants`) && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: uiEn["entrants.add.submit"]! }).click();
  const res = await answered;
  const body = (await res.json()) as {
    data?: { id: string; kind: string; display_name: string; late_entry?: LateEntryAnswer };
    error?: { code?: string };
  };
  return { status: res.status(), body };
}

/** The run sheet opens on "Today" on a match day — a board in play makes the division's phase `match_day`
 *  (division-phase.ts), which seeds the sheet's filter (stages-panel.tsx) — and "Today" hides an untimed row. Every
 *  fixture here is untimed, so a row lookup after a board has started reads the sheet under All (CI run 41328392447). */
export async function showAllFixtures(page: Page) {
  const all = page.locator('[data-testid="run-sheet-filter"] [data-filter="all"]');
  await all.click({ timeout: 20_000 });
  await expect(all).toHaveAttribute("aria-pressed", "true");
}

export async function noticeLines(page: Page) {
  const lines = page.getByTestId("entrants-late-entry-line");
  await expect(lines.first()).toBeVisible({ timeout: 20_000 });
  return lines.evaluateAll((els) => els.map((e) => ({ tone: e.getAttribute("data-tone"), text: (e.textContent ?? "").trim() })));
}
