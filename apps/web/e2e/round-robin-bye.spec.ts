// #850 — round-robin byes, end to end through the REAL producer and consumer.
//
// OWNER RULINGS (2026-09-23, competition-desk _INDEX.md "Issue 850"):
//   - a league/group stage persists a REAL bye row per round, the same shape as
//     the Swiss bye, but it awards NO points;
//   - the run sheet reuses the Swiss ghost row, "Round N · X has a bye";
//   - a round-robin ghost row carries NO outcome suffix; Swiss keeps "(w/o)".
//
// Producer: the organiser API (entrants → stage → Generate → Start → scores).
// Consumers: the division page's fixtures tab (the run sheet) and its standings
// tab, read in a real browser. Nothing expected is typed: the rounds and bye
// holders come from the rows the generator wrote (read back over the API), the
// copy from the shipped English dictionaries, the points from the division's
// own config.
//
// Every "no suffix" assertion is anchored: the ghost row is first asserted to
// EXIST and be VISIBLE, and the Swiss twin below proves the same row does carry
// the suffix where the bye scores — so an absent row, or a suffix that never
// renders anywhere, cannot pass.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  divisionPath,
  expectNoHorizontalScroll,
  scoreFixture,
} from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

const dict = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/en/${name}.json`, import.meta.url)), "utf8")) as Record<
    string,
    string
  >;
const UI_EN = dict("ui");
const PUBLIC_EN = dict("public");
const fill = (key: string, vars: Record<string, string | number>, from = UI_EN) =>
  from[key]!.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k]));

const CFG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
const NAMES = ["Alder", "Birch", "Cedar", "Damson", "Elm"].map((n) => `${n} ${TAG}`);
const WIDTHS = [320, 768, 1280] as const;

interface Fx {
  id: string;
  fixture_no: number;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
}

async function seedDivision(
  request: APIRequestContext,
  label: string,
  visibility: "private" | "public" = "private",
  names: string[] = NAMES,
) {
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `RR bye ${label} ${TAG}`,
    visibility,
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  // A create over the public-dashboard cap degrades to private with a 201.
  expect(comp.data!.visibility).toBe(visibility);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: CFG,
  });
  const divisionId = div.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, names);
  expect(ids).toHaveLength(names.length);
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {},
    tz: "UTC",
  });
  expect(settings.status).toBeLessThan(300);
  const nameOf = new Map(ids.map((id, i) => [id, names[i]!]));
  return { divisionId, nameOf, competitionId: comp.data!.id, compSlug: comp.data!.slug, divisionSlug: div.data!.slug };
}

async function fixtures(request: APIRequestContext, ids: string[]): Promise<Fx[]> {
  return Promise.all(ids.map(async (id) => (await apiJson<Fx>(request, `/api/v1/fixtures/${id}`)).data!));
}

/** Every row of the run sheet in DOM order: which block it sits in, and
 *  whether it is a match (by its `fixture_no`) or a bye ghost row (by its text). */
async function sheetOrder(page: Page): Promise<{ block: string; kind: "match" | "bye"; no: number | null; text: string }[]> {
  return page.getByTestId("run-sheet").evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('li[data-fixture-no], li[data-testid="run-sheet-bye"]')].map((li) => {
      const section = li.closest("section");
      const block =
        section?.getAttribute("data-run-sheet-block") ??
        section?.querySelector("[data-run-sheet-day]")?.getAttribute("data-run-sheet-day") ??
        "?";
      const no = li.getAttribute("data-fixture-no");
      return {
        block,
        kind: no === null ? ("bye" as const) : ("match" as const),
        no: no === null ? null : Number(no),
        text: li.innerText.replace(/\s+/g, " ").trim(),
      };
    }),
  );
}

/** The ghost rows' visible text, in DOM order, once the first one is visible. */
async function ghostTexts(page: Page, expected: number): Promise<string[]> {
  const ghosts = page.getByTestId("run-sheet").getByTestId("run-sheet-bye");
  await expect(ghosts.first()).toBeVisible({ timeout: 20_000 });
  await expect(ghosts).toHaveCount(expected);
  return (await ghosts.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

test("#850 league of five: a ghost row per round with no (w/o) suffix, and the bye holder has 0 played / 0 points", async ({
  page,
  request,
}, testInfo) => {
  const { divisionId, nameOf } = await seedDivision(request, "League");
  const { fixtureIds, restByeIds } = await createStageAndGenerate(request, divisionId, { kind: "league", name: "League" });
  // The premise, read from the product: ten matches and one bye row per round.
  expect(fixtureIds, "a 5-entrant league plays C(5,2) = 10 matches").toHaveLength(10);
  expect(restByeIds, "and rests one entrant in each of its 5 rounds").toHaveLength(5);
  const byes = (await fixtures(request, restByeIds)).sort((a, b) => a.round_no - b.round_no);
  expect(byes.every((b) => b.status === "forfeited" && b.away_entrant_id === null)).toBe(true);
  const holderOf = (b: Fx) => nameOf.get((b.home_entrant_id ?? b.away_entrant_id)!)!;
  const expected = byes.map((b) => `${fill("schedule.round", { n: b.round_no })} · ${fill("schedule.bye", { name: holderOf(b) })}`);
  console.log("expected ghost rows:", expected);

  // Start, then decide round 1's two real matches (home wins 2–1).
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status).toBeLessThan(300);
  const matches = await fixtures(request, fixtureIds);
  const roundOne = matches.filter((m) => m.round_no === 1);
  expect(roundOne).toHaveLength(2);
  for (const m of roundOne) await scoreFixture(request, m.id, 2, 1);

  // ── the run sheet ──
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const texts = await ghostTexts(page, 5);
  console.log("ghost rows seen:", texts);
  // DOM order follows the rounds' blocks (round 1's played tail renders after
  // the still-untimed rounds), so the SET is compared here and the placement
  // row by row below.
  expect([...texts].sort()).toEqual([...expected].sort());
  for (const [i, b] of byes.entries()) {
    // The whole row is the round and the sit-out — no walkover claim.
    const t = texts.find((x) => x === expected[i])!;
    expect(t, `ghost row for round ${b.round_no}`).not.toContain(fill("schedule.outcome.wonWo", { name: holderOf(b) }));
    expect(t).not.toContain("(w/o)");
  }
  // Each ghost row sits INSIDE ITS ROUND (owner ruling; review O1 / finding 1
  // — the first build piled all five into "Played, not scheduled"). Asserted
  // positively, row by row: the row right before the bye is a match of the
  // SAME round in the SAME block, and no match of that round comes after it.
  const roundOfNo = new Map(matches.map((m) => [m.fixture_no, m.round_no]));
  const order = await sheetOrder(page);
  console.log("sheet order:", order.map((r) => `${r.block}:${r.kind === "bye" ? r.text : `#${r.no}(R${roundOfNo.get(r.no!)})`}`));
  for (const [i, b] of byes.entries()) {
    const at = order.findIndex((r) => r.kind === "bye" && r.text === expected[i]);
    expect(at, `ghost row for round ${b.round_no} is on the sheet`).toBeGreaterThan(0);
    const prev = order[at - 1]!;
    expect(prev.kind, `the row before round ${b.round_no}'s bye is a match`).toBe("match");
    expect(roundOfNo.get(prev.no!), `…of round ${b.round_no}`).toBe(b.round_no);
    expect(prev.block, `…in the same block`).toBe(order[at]!.block);
    const later = order.slice(at + 1).filter((r) => r.kind === "match" && roundOfNo.get(r.no!) === b.round_no);
    expect(later, `no round ${b.round_no} match after its bye`).toEqual([]);
  }
  // Round 1 was played without a time, so its bye closes it in the played
  // tail; rounds 2–5 are still to be timed, so theirs sit in "Not yet
  // scheduled" among their own matches — never a pile at the bottom.
  const blockOf = (i: number) => order.find((r) => r.kind === "bye" && r.text === expected[i])!.block;
  expect(blockOf(0)).toBe("settled");
  for (let i = 1; i < byes.length; i++) expect(blockOf(i), `round ${byes[i]!.round_no}'s bye`).toBe("unscheduled");

  // Review O2 / finding 5: the stage card promises the MATCHES it lands on —
  // "View 10 fixtures", never 15 (the five bye rows are not fixtures).
  await expect(page.getByTestId("stage-view-fixtures").first()).toContainText(
    fill("schedule.stage.viewFixtures.other", { count: 10 }),
  );

  // Three widths, no horizontal scroll, and a picture of each — taken AFTER
  // the ghost rows are asserted visible at that width.
  const sheet = page.getByTestId("run-sheet");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const atWidth = await ghostTexts(page, 5);
    expect([...atWidth].sort(), `ghost rows at ${width}`).toEqual([...expected].sort());
    await expectNoHorizontalScroll(page);
    await sheet.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`run-sheet-league-byes-${width}.png`), fullPage: true });
    await sheet.screenshot({ path: testInfo.outputPath(`run-sheet-league-byes-sheet-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── the standings ──
  const rested = holderOf(byes[0]!);
  const winners = roundOne.map((m) => nameOf.get(m.home_entrant_id!)!);
  await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
  const table = page.locator("table").filter({ has: page.getByRole("row", { name: new RegExp(rested) }) }).first();
  await expect(table).toBeVisible({ timeout: 20_000 });
  const heads = await table.locator("thead th").evaluateAll((els) => els.map((el) => el.getAttribute("title")));
  const col = (key: string) => {
    const at = heads.indexOf(PUBLIC_EN[key]!);
    expect(at, `standings column ${key} (${PUBLIC_EN[key]}) among ${JSON.stringify(heads)}`).toBeGreaterThan(-1);
    return at;
  };
  const played = col("table.col.played");
  const points = col("table.col.points");
  const cells = async (name: string) =>
    table
      .getByRole("row", { name: new RegExp(name) })
      .first()
      .locator("th, td")
      .allInnerTexts();
  const restedRow = await cells(rested);
  console.log("bye holder's standings row:", restedRow);
  expect(restedRow[played]!.trim(), "the bye is not a match played").toBe("0");
  expect(restedRow[points]!.trim(), "the bye awards no points").toBe("0");
  // Positive pair: a round-1 winner's row carries the real result.
  const winnerRow = await cells(winners[0]!);
  expect(winnerRow[played]!.trim()).toBe("1");
  expect(winnerRow[points]!.trim()).toBe(String(CFG.points.w));
});

test("#850 the Swiss twin: the SAME ghost row keeps its (w/o) suffix, because a Swiss bye is a win", async ({ page, request }) => {
  const { divisionId, nameOf } = await seedDivision(request, "Swiss");
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3 },
  });
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
  const gen = await apiJson<{ fixtures: Fx[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  const bye = (gen.data?.fixtures ?? []).find(
    (f) => f.round_no === 1 && f.outcome?.kind === "award" && (f.home_entrant_id === null) !== (f.away_entrant_id === null),
  );
  expect(bye, "round 1 of a Swiss of five seats a bye").toBeDefined();
  const holder = nameOf.get((bye!.home_entrant_id ?? bye!.away_entrant_id)!)!;

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const [text] = await ghostTexts(page, 1);
  expect(text).toBe(
    `${fill("schedule.round", { n: 1 })} · ${fill("schedule.bye", { name: holder })} · ${fill("schedule.outcome.wonWo", { name: holder })}`,
  );
});

// ── Public surfaces (owner ruling 2026-09-24, third round) ──────────────────
// "a league/group bye is a NOTE in its round ('X has a bye', no time, no TBD),
// never a result. Present / 'Latest results', hub counts and every other
// result feed exclude round-robin byes." Driven on a PUBLIC competition with
// round 1 played, read as a spectator: the division page's schedule, the
// competition hub's counts, and the Present board. Nothing expected is typed:
// the byes and their rounds come from the generator's rows over the API, the
// copy from the shipped dictionaries.
test("#850 public: the division schedule shows each bye as a note in its round; the hub and Present never count it as a result", async ({
  page,
  request,
}, testInfo) => {
  const { divisionId, nameOf, competitionId, compSlug, divisionSlug } = await seedDivision(request, "Public", "public");
  const { fixtureIds, restByeIds } = await createStageAndGenerate(request, divisionId, { kind: "league", name: "League" });
  expect(restByeIds).toHaveLength(5);
  const byes = (await fixtures(request, restByeIds)).sort((a, b) => a.round_no - b.round_no);
  const holderOf = (b: Fx) => nameOf.get((b.home_entrant_id ?? b.away_entrant_id)!)!;
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
  const matches = await fixtures(request, fixtureIds);
  const roundOne = matches.filter((m) => m.round_no === 1);
  for (const m of roundOne) await scoreFixture(request, m.id, 2, 1);
  const roundOf = new Map(matches.map((m) => [m.id, m.round_no]));
  const orgSlug = /^\/o\/([^/]+)\//.exec(await competitionPath(request, competitionId))![1]!;
  const publicDivision = `/shared/${orgSlug}/${compSlug}/${divisionSlug}`;

  // ── the division page's schedule ──
  await page.goto(publicDivision);
  await dismissCookieBanner(page);
  const notes = page.getByTestId("schedule-bye");
  await expect(notes.first()).toBeVisible({ timeout: 20_000 });
  await expect(notes).toHaveCount(5);
  // Every note, with the row before it and its group's heading, in DOM order.
  const seen = await page.locator("section:has([data-testid=schedule-bye])").evaluateAll((sections) =>
    sections.flatMap((sec) => {
      const heading = (sec.querySelector("h3")?.textContent ?? "").trim();
      const lis = [...sec.querySelectorAll("ul > li")];
      return lis.flatMap((li, i) =>
        li.getAttribute("data-testid") === "schedule-bye"
          ? [
              {
                heading,
                text: (li as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
                prevHref: lis[i - 1]?.querySelector("a")?.getAttribute("href") ?? null,
                html: li.innerHTML,
              },
            ]
          : [],
      );
    }),
  );
  console.log("public notes:", seen.map((n) => `${n.heading} | ${n.text}`));
  for (const b of byes) {
    const note = seen.find((n) => n.text.endsWith(fill("schedule.bye", { name: holderOf(b) })));
    expect(note, `round ${b.round_no}'s note`).toBeDefined();
    // Inside its round: the row right before it is a match of the same round.
    const prevId = note!.prevHref?.split("/fixtures/")[1];
    expect(prevId && roundOf.get(prevId), `the row before round ${b.round_no}'s note`).toBe(b.round_no);
    // A note: no link, no time, no TBD, no "vs Bye".
    expect(note!.html).not.toContain("href");
    expect(note!.text).not.toMatch(/\bTBD\b|\d{1,2}:\d{2}/);
  }
  for (const id of restByeIds) await expect(page.locator(`a[href$="/fixtures/${id}"]`)).toHaveCount(0);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(notes.first()).toBeVisible({ timeout: 20_000 });
    await expect(notes).toHaveCount(5);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`public-division-schedule-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── the competition hub: "Completed" counts round 1's two MATCHES ──
  await page.goto(`/shared/${orgSlug}/${compSlug}?tab=matches`);
  const completed = page.getByTestId("mh-filter-completed");
  await expect(completed).toBeVisible({ timeout: 20_000 });
  await expect(completed).toContainText(`${PUBLIC_EN["matchesHub.filter.completed"]} ${roundOne.length}`);
  for (const id of restByeIds) await expect(page.getByTestId(`mh-match-${id}`)).toHaveCount(0);

  // ── Present: "Latest results" lists round 1's matches and never a bye ──
  await page.goto(`${publicDivision}/present`);
  const title = page.locator("main h2");
  await expect(title).toBeVisible({ timeout: 20_000 });
  const slides: { title: string; text: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const t = ((await title.textContent()) ?? "").trim();
    if (slides.some((s) => s.title === t)) break;
    slides.push({ title: t, text: ((await page.locator("main").innerText()) ?? "").replace(/\s+/g, " ") });
    if (t.toLowerCase() === UI_EN["slideshow.slide.latestResults"]!.toLowerCase()) {
      await page.screenshot({ path: testInfo.outputPath("present-latest-results-1280.png") });
    }
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
  }
  console.log("present slides:", slides.map((s) => s.title));
  const latest = slides.find((s) => s.title.toLowerCase() === UI_EN["slideshow.slide.latestResults"]!.toLowerCase());
  expect(latest, `a Latest results slide among ${JSON.stringify(slides.map((s) => s.title))}`).toBeDefined();
  for (const m of roundOne) expect(latest!.text).toContain(nameOf.get(m.home_entrant_id!)!);
  expect(latest!.text, "the round-1 bye holder played nothing").not.toContain(holderOf(byes[0]!));
  expect(latest!.text).not.toMatch(/\bBye\b/);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${publicDivision}/present`);
    await expect(page.locator("header span.tabular-nums")).toBeAttached();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`present-${width}.png`), fullPage: true });
  }
});

// ── Review round 2 (R2-1, R2-3, R2-5) — the organiser's own tools beside the
// rest byes, over the real routes and read on the real run sheet. Nothing
// expected is typed: rounds and bye holders are read back off the rows.
//   R2-5: a partly played UNTIMED round keeps its ghost row in "Not yet
//         scheduled" with the match still to play — never under "Played".
//   R2-3: "Add match" for a bye holder in their bye round takes the ghost row
//         away at once (nobody rests and plays one round).
//   R2-1: after the next bye holder withdraws (their bye row is deleted),
//         "Add match" still answers 2xx — the ad-hoc key no longer collides.
test("#850 review round 2: a partly played round keeps its bye with the match still to play; Add match and a withdrawal keep the byes true", async ({
  page,
  request,
}, testInfo) => {
  const { divisionId, nameOf } = await seedDivision(request, "Round2");
  const { stageId, fixtureIds, restByeIds } = await createStageAndGenerate(request, divisionId, { kind: "league", name: "League" });
  expect(restByeIds).toHaveLength(5);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
  const byes = (await fixtures(request, restByeIds)).sort((a, b) => a.round_no - b.round_no);
  const matches = await fixtures(request, fixtureIds);
  const holderId = (b: Fx) => (b.home_entrant_id ?? b.away_entrant_id)!;
  const ghost = (b: Fx) => `${fill("schedule.round", { n: b.round_no })} · ${fill("schedule.bye", { name: nameOf.get(holderId(b))! })}`;

  // R2-5 — play ONE of round 2's two matches, untimed.
  const [played, waiting] = matches.filter((m) => m.round_no === 2);
  await scoreFixture(request, played!.id, 2, 1);
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await ghostTexts(page, 5);
  let order = await sheetOrder(page);
  const r2 = order.find((r) => r.kind === "bye" && r.text === ghost(byes[1]!))!;
  expect(r2.block, "round 2's bye waits with its unplayed match").toBe("unscheduled");
  expect(order.find((r) => r.no === waiting!.fixture_no)!.block).toBe("unscheduled");
  expect(order.find((r) => r.no === played!.fixture_no)!.block).toBe("settled");
  await page.getByTestId("run-sheet").screenshot({ path: testInfo.outputPath("run-sheet-r2-5-1280.png") });

  // R2-3 — Add match for round 3's bye holder, in round 3.
  const r3bye = byes[2]!;
  const r3opponent = matches.find((m) => m.round_no === 3)!.home_entrant_id!;
  const added = await apiJson(request, `/api/v1/stages/${stageId}/fixtures`, "POST", {
    home_entrant_id: holderId(r3bye),
    away_entrant_id: r3opponent,
    round_no: 3,
  });
  expect(added.status, JSON.stringify(added.error)).toBeLessThan(300);
  await page.reload();
  const afterAdd = await ghostTexts(page, 4);
  expect(afterAdd, "round 3's bye is gone the moment its holder plays round 3").not.toContain(ghost(r3bye));
  expect(afterAdd).toEqual(expect.arrayContaining([ghost(byes[0]!), ghost(byes[1]!), ghost(byes[3]!), ghost(byes[4]!)]));

  // R2-1 — round 4's bye holder withdraws (their bye row is deleted), then Add match again.
  const leaver = holderId(byes[3]!);
  expect((await apiJson(request, `/api/v1/entrants/${leaver}/withdraw`, "POST")).status).toBeLessThan(300);
  const others = [...nameOf.keys()].filter((id) => id !== leaver);
  const again = await apiJson(request, `/api/v1/stages/${stageId}/fixtures`, "POST", {
    home_entrant_id: others[0]!,
    away_entrant_id: others[1]!,
  });
  expect(again.status, `Add match after a withdrawal: ${JSON.stringify(again.error)}`).toBeLessThan(300);
  await page.reload();
  const afterWithdraw = await ghostTexts(page, 3);
  expect(afterWithdraw).not.toContain(ghost(byes[3]!));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await ghostTexts(page, 3);
    order = await sheetOrder(page);
    expect(order.find((r) => r.kind === "bye" && r.text === ghost(byes[1]!))!.block, `at ${width}`).toBe("unscheduled");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`run-sheet-round2-${width}.png`), fullPage: true });
  }
});

// Owner ruling (2026-09-24, fifth round): only rounds GENERATED by the
// round-robin schedule create rest-bye rows. "Add match" never does — even a
// decider in a new round that exactly one entrant sits out. A 3-entrant league
// is the case where the old rule ("one sit-out ⇒ a bye") wrote one, so it is
// the case that can tell the two apart. Read over the real API and on the
// real run sheet; the generated rounds' ghost rows are the positive pair.
test("#850 fifth-round ruling: a 3-entrant league's Add match decider in a new round gets no ghost row; the generated rounds keep theirs", async ({
  page,
  request,
}, testInfo) => {
  const { divisionId, nameOf } = await seedDivision(request, "Decider", "private", NAMES.slice(0, 3));
  const { stageId, fixtureIds, restByeIds } = await createStageAndGenerate(request, divisionId, { kind: "league", name: "League" });
  expect(fixtureIds, "a 3-entrant league plays C(3,2) = 3 matches").toHaveLength(3);
  expect(restByeIds, "and rests one entrant in each of its 3 rounds").toHaveLength(3);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
  const byes = (await fixtures(request, restByeIds)).sort((a, b) => a.round_no - b.round_no);
  const holderId = (b: Fx) => (b.home_entrant_id ?? b.away_entrant_id)!;
  const ghost = (round: number, id: string) =>
    `${fill("schedule.round", { n: round })} · ${fill("schedule.bye", { name: nameOf.get(id)! })}`;

  const [a, b, c] = [...nameOf.keys()];
  const added = await apiJson<{ fixture_id: string }>(request, `/api/v1/stages/${stageId}/fixtures`, "POST", {
    home_entrant_id: a,
    away_entrant_id: b,
  });
  expect(added.status, JSON.stringify(added.error)).toBeLessThan(300);
  const [decider] = await fixtures(request, [added.data!.fixture_id]);
  const lastGenerated = Math.max(...byes.map((x) => x.round_no));
  expect(decider!.round_no, "premise: the decider opens a NEW round").toBe(lastGenerated + 1);

  // The rows: the decider's round is the decider alone; every generated round
  // keeps its bye row.
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status).toBeLessThan(300);
  expect(all.data!.filter((f) => f.round_no === decider!.round_no).map((f) => f.id), "no bye row beside the decider").toEqual([
    decider!.id,
  ]);
  for (const bye of byes) expect(all.data!.some((f) => f.id === bye.id), `round ${bye.round_no}'s bye stands`).toBe(true);

  // The run sheet: three ghost rows (the generated rounds'), none naming the
  // one entrant who sits the decider out.
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const shown = await ghostTexts(page, 3);
    expect(shown).toEqual(expect.arrayContaining(byes.map((x) => ghost(x.round_no, holderId(x)))));
    expect(shown, "the decider's lone sit-out has no ghost row").not.toContain(ghost(decider!.round_no, c!));
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`run-sheet-decider-${width}.png`), fullPage: true });
  }
});
