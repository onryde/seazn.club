// Spectator W2 (4/4), Task 17 — the org home, as a spectator sees it.
//
// Owner-approved inventory 2026-09-16 (OH1–OH3), with the rulings made after it:
//   - ORDER is three tiers (`sortOrgHomeCompetitions`, lib/public-site.ts): a
//     match in play ("{count} live now"), then marked live with nothing in
//     play ("On now"), then the rest — each tier in date order. So an OLDER
//     competition sits above a NEWER idle one whenever it is livelier, and
//     this file seeds exactly that.
//   - es/fr/nl public pages carry no English. One browser case: a Spanish
//     org's hub and player page speak Spanish, with `<html lang="es">`.
//
// Two DEDICATED orgs, created here and read by nothing else, so no other file
// can put a match in play under OH1's idle cadence or flip a locale under OH3:
//   - EN, Community: three competitions, starts_on oldest→newest
//       C_play (a generic league, its one match not started),
//       C_on   (marked `live`, no fixtures),
//       C_new  (a draft, no fixtures).
//   - ES, Pro (player pages need `dashboard.player_profiles`): one competition
//     with a 43-character name and two matches in play.
// Everything is seeded before the first public read — entitlements and ISR
// may serve a later change stale.
//
// Serial with the seed as test 1: a red seed aborts the rest, and a red count
// here is a floor, not a total (AGENTS.md #21).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, scoreFixture, TAG } from "../helpers";
import { centreHits, closeOpenContexts } from "../spectator-public-helpers";
import {
  API_CALL_MS,
  dictString,
  division,
  entrants,
  expectDistinctShots,
  FLOOR_MS,
  LAND_SLACK_MS,
  leagueFixtures,
  lineUpOnPoll,
  mintSpectatorOrg,
  noReloadGuard,
  person,
  publicCompetition,
  SCREEN_WIDTHS,
  SHOT_STATE_MS,
  shootInPlace,
  shootStates,
  spectator,
  STEP_MS,
  switchActiveOrg,
  w2Clock,
  type MintedOrg,
  type ShotState,
} from "../spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

const START = { play: "2030-01-10", on: "2030-02-10", new: "2030-03-10" } as const;
const ENDS_ON = "2030-12-31";

let en: MintedOrg;
let es: MintedOrg;
let cPlay = { id: "", slug: "" };
let cOn = { id: "", slug: "" };
let cNew = { id: "", slug: "" };
let playFixture = "";
let esComp = { id: "", slug: "", name: "" };
let esLiveFixtures: string[] = [];
/** A consenting person rostered in one of the ES matches in play. */
let esPlayer = { id: "", name: "", opponent: "" };

const SEED_CALLS = 3 * 4 /* two orgs: create, plan, caps, activate */ + 3 + 2 + 3 + 3 + 4 + 1 + 4 + 5 + 2 + 2;

test("setup: an EN community org with three competitions in three tiers, and an ES Pro org with two matches in play", async ({
  request,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, SEED_CALLS * API_CALL_MS + STEP_MS));

  // --- EN ---------------------------------------------------------------------
  en = await mintSpectatorOrg(request, { name: `Spectator Org Home EN ${TAG}`, plan: "community" });
  cPlay = await publicCompetition(request, {
    name: `Older Cup ${TAG}`,
    orgId: en.id,
    startsOn: START.play,
    endsOn: ENDS_ON,
  });
  cOn = await publicCompetition(request, { name: `Middle Cup ${TAG}`, orgId: en.id, startsOn: START.on, endsOn: ENDS_ON });
  cNew = await publicCompetition(request, { name: `Newer Cup ${TAG}`, orgId: en.id, startsOn: START.new, endsOn: ENDS_ON });

  const playDiv = await division(request, cPlay.id, {
    name: `League ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await entrants(request, playDiv.id, [
    { kind: "individual", name: `Home Side ${TAG}`, members: [] },
    { kind: "individual", name: `Away Side ${TAG}`, members: [] },
  ]);
  const [only] = await leagueFixtures(request, playDiv.id);
  playFixture = only!.id;

  const onNow = await request.fetch(`/api/v1/competitions/${cOn.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    data: { status: "live" },
  });
  expect(onNow.status(), `mark "${cOn.slug}" live`).toBeLessThan(300);

  // The premise OH1 rests on: C_play's STORED status is not `live`, so its
  // chip can only turn on from the match, never from the status.
  const stored = await request.get(`/api/v1/competitions/${cPlay.id}`);
  const storedStatus = ((await stored.json()) as { data?: { status?: string } }).data?.status;
  expect(storedStatus, "C_play's stored status").not.toBe("live");

  // --- ES ---------------------------------------------------------------------
  es = await mintSpectatorOrg(request, { name: `Spectator Org Home ES ${TAG}`, plan: "pro", locale: "es" });
  const name43 = `Campeonato Regional de Primavera ${TAG}`.padEnd(43, "x").slice(0, 43);
  expect(name43).toHaveLength(43);
  const created = await publicCompetition(request, { name: name43, orgId: es.id, startsOn: "2030-04-01", endsOn: ENDS_ON });
  esComp = { ...created, name: name43 };
  const esDiv = await division(request, esComp.id, {
    name: `Liga ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const names = ["Lucía Fernández", "Martina García", "Sofía Romero", "Valeria Torres"].map((n) => `${n} ${TAG}`);
  const ids: string[] = [];
  for (const n of names) ids.push(await person(request, n, true));
  const entrantIds = await entrants(
    request,
    esDiv.id,
    names.map((n, i) => ({ kind: "individual" as const, name: n, members: [ids[i]!] })),
  );
  const fixtures = await leagueFixtures(request, esDiv.id);
  // Two matches with four different players, so both can be in play at once.
  const first = fixtures[0]!;
  const second = fixtures.find(
    (f) =>
      f.home_entrant_id !== first.home_entrant_id &&
      f.home_entrant_id !== first.away_entrant_id &&
      f.away_entrant_id !== first.home_entrant_id &&
      f.away_entrant_id !== first.away_entrant_id,
  );
  expect(second, "a second fixture with four different players").toBeTruthy();
  esLiveFixtures = [first.id, second!.id];
  for (const id of esLiveFixtures) {
    const res = await request.post(`/api/v1/fixtures/${id}/events`, {
      data: { expected_seq: 0, type: "core.start", payload: {} },
    });
    expect(res.status(), `core.start ${id}`).toBe(201);
  }
  const homeIndex = entrantIds.indexOf(first.home_entrant_id!);
  const awayIndex = entrantIds.indexOf(first.away_entrant_id!);
  esPlayer = { id: ids[homeIndex]!, name: names[homeIndex]!, opponent: names[awayIndex]! };
  console.log(
    `seeded: en=${en.slug} [play=${cPlay.slug} on=${cOn.slug} new=${cNew.slug}] es=${es.slug}/${esComp.slug} player=${esPlayer.id}`,
  );
});

/** Chip testids in DOM order, as competition ids. */
async function chipOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="mh-org-chip-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("mh-org-chip-".length)));
}

// OH1 — R10 and the three tiers. A spectator on a phone watches the club page;
// the older competition's first match starts and its card rises above the two
// newer ones with "1 live now", with no reload; when the match ends it drops
// back to date order in its tier.
test("OH1: a match starting lifts an older competition to the top with '1 live now', in place, and its end drops it back", async ({
  browser,
  request,
}, testInfo) => {
  const clock = w2Clock();
  const mountMs = STEP_MS;
  const flipOnMs = clock.hubIdlePollMs + LAND_SLACK_MS;
  const flipOffMs = clock.hubPollMs + LAND_SLACK_MS;
  test.setTimeout(
    Math.max(
      FLOOR_MS,
      mountMs + 2 * STEP_MS + 4 * API_CALL_MS + flipOnMs + flipOffMs + 2 * SCREEN_WIDTHS.length * SHOT_STATE_MS,
    ),
  );
  await switchActiveOrg(request, en.id);

  const upcoming = dictString("en", "chip.upcoming");
  const onNow = dictString("en", "chip.onNow");
  const oneLive = dictString("en", "org.live.one", { count: 1 });
  const liveApi = `/api/v1/public/orgs/${en.slug}/live`;

  const page = await spectator(browser, { width: 390 });
  // The island's mount fetch fires right after hydration: wait for it from
  // BEFORE the navigation, so the write below lands after a known poll.
  const mounted = lineUpOnPoll(page, liveApi, mountMs);
  await page.goto(`/shared/${en.slug}`);
  expect(await mounted, "the org home's mount fetch of /live never came back").toBe(true);
  const samePage = await noReloadGuard(page);

  const chip = (id: string) => page.getByTestId(`mh-org-chip-${id}`);
  // Before: tier 1 (On now) above tier 2, and inside tier 2 the newer first.
  await expect(chip(cOn.id)).toHaveAttribute("data-chip", "on-now");
  await expect(chip(cOn.id)).toHaveText(onNow);
  await expect(chip(cPlay.id)).toHaveAttribute("data-chip", "upcoming");
  await expect(chip(cPlay.id)).toHaveText(upcoming);
  await expect(chip(cNew.id)).toHaveText(upcoming);
  expect(await chipOrder(page), "before: On now, then the newer idle one, then the older idle one").toEqual([
    cOn.id,
    cNew.id,
    cPlay.id,
  ]);

  // English dates are day-month (owner ruling): "10 Jan 2030", never "Jan 10, 2030".
  const gb = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const us = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const dateLine = chip(cPlay.id).locator("xpath=following-sibling::span[1]");
  await expect(dateLine).toHaveText(`${gb(START.play)} – ${gb(ENDS_ON)}`);
  expect(gb(START.play), "the en-GB and en-US shapes must differ, or the date check proves nothing").not.toBe(
    us(START.play),
  );

  await request
    .post(`/api/v1/fixtures/${playFixture}/events`, { data: { expected_seq: 0, type: "core.start", payload: {} } })
    .then((res) => expect(res.status(), "core.start").toBe(201));

  await expect(chip(cPlay.id), "the chip never turned on without a reload").toHaveAttribute("data-chip", "on-now", {
    timeout: flipOnMs,
  });
  await expect(chip(cPlay.id)).toHaveText(oneLive);
  expect(await chipOrder(page), "in play: the OLDER competition above the live-marked and the newer one").toEqual([
    cPlay.id,
    cOn.id,
    cNew.id,
  ]);
  await expect(chip(cOn.id)).toHaveText(onNow);
  await expect(chip(cNew.id)).toHaveText(upcoming);
  await samePage("after the match started");

  // The owner's capture matrix: the en live chip, shot on THIS page before the
  // match ends (a fresh load renders before the island's first poll).
  const shots = testInfo.outputPath("org-home-en-screens");
  await shootInPlace(page, shots, {
    name: "org-home-en-live",
    open: async () => {
      await expect(chip(cPlay.id)).toHaveAttribute("data-chip", "on-now");
      await expect(chip(cPlay.id)).toHaveText(oneLive);
      await chip(cPlay.id).scrollIntoViewIfNeeded();
    },
  });

  // Something is in play now, so the island polls at HUB_POLL_MS: the end has
  // to land inside ONE live interval, which an interval stuck idle cannot.
  await scoreFixture(request, playFixture, 2, 1);
  await expect(chip(cPlay.id), "the chip never turned back off").toHaveAttribute("data-chip", "upcoming", {
    timeout: flipOffMs,
  });
  await expect(chip(cPlay.id)).toHaveText(upcoming);
  expect(await chipOrder(page), "after: back to tier then date order").toEqual([cOn.id, cNew.id, cPlay.id]);
  await samePage("after the match ended");

  await shootInPlace(page, shots, {
    name: "org-home-en-after",
    open: async () => {
      await expect(chip(cPlay.id)).toHaveAttribute("data-chip", "upcoming");
      await chip(cPlay.id).scrollIntoViewIfNeeded();
    },
  });
  expectDistinctShots(shots, ["org-home-en-live", "org-home-en-after"]);
  await samePage("after the screens");
});

// OH2 — R11 on a small phone: a Spanish club with two matches on at once reads
// "2 EN VIVO AHORA", whole, on one line, inside its card.
test("OH2: the ES chip reads '2 en vivo ahora' on one line inside its card at 320 and 1280, and the page passes axe at 320", async ({ browser }, testInfo) => {
  const shotStates: ShotState[] = [];
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS + 2 * SCREEN_WIDTHS.length * SHOT_STATE_MS));
  const twoLive = dictString("es", "org.live.other", { count: 2 });
  const testid = `mh-org-chip-${esComp.id}`;

  for (const width of [320, 1280]) {
    const page = await spectator(browser, { width });
    await page.goto(`/shared/${es.slug}`);
    const chip = page.getByTestId(testid);
    await expect(chip).toHaveAttribute("data-chip", "on-now");
    await expect(chip).toHaveText(twoLive);

    const g = await chip.evaluate((el) => {
      const card = el.closest("a")!;
      const cs = getComputedStyle(card);
      const cardBox = card.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== "");
      const range = document.createRange();
      if (text) range.selectNodeContents(text);
      const lineTops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      return {
        chipRight: box.right,
        contentRight: cardBox.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
        chipHeight: box.height,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        textLines: text ? lineTops.size : 0,
      };
    });
    console.log(`OH2@${width}: ${JSON.stringify(g)}`);
    expect(g.textLines, `@${width}: the chip's words must sit on ONE line`).toBe(1);
    expect(g.chipRight, `@${width}: the chip overflows its card`).toBeLessThanOrEqual(g.contentRight + 0.5);
    // One line of 11px text plus py-0.5 is well under two lines' height.
    expect(g.chipHeight, `@${width}: the chip is taller than one line`).toBeLessThan(2 * g.fontSize * 1.5);
    expect(await centreHits(page, testid), `@${width}: a tap on the chip's centre misses it`).toBe(true);
    await expectNoHorizontalScroll(page);
    if (width === 320) {
      // HB12's org-home surface: the Spanish page at 320, with its live chips.
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const bad = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
      console.log(`OH2 axe@320: ${JSON.stringify(bad)}`);
      expect(bad, "@320: serious/critical axe violations on the ES org home").toEqual([]);
    }
  }
  // The owner's capture matrix: the es org home with two live, and the same
  // competition's hub on Live — both live states only this org has.
  shotStates.push(
    {
      name: "org-home-es-2-live",
      open: async (p) => {
        await p.goto(`/shared/${es.slug}`);
        const chip = p.getByTestId(testid);
        await expect(chip).toHaveAttribute("data-chip", "on-now");
        await expect(chip).toHaveText(twoLive);
        await chip.scrollIntoViewIfNeeded();
      },
    },
    {
      name: "hub-es-matches-live",
      open: async (p) => {
        await p.goto(`/shared/${es.slug}/${esComp.slug}?tab=matches`);
        await expect(p.getByTestId("mh-filter-live")).toHaveAttribute("aria-pressed", "true");
        for (const id of esLiveFixtures) await expect(p.getByTestId(`mh-match-${id}`)).toBeVisible();
      },
    },
  );
  const shots = testInfo.outputPath("org-home-es-screens");
  await shootStates(browser, shots, shotStates);
  expectDistinctShots(shots, shotStates.map((st) => st.name));
});

async function expectLang(page: Page, lang: string, where: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang), { message: `${where}: <html lang>` })
    .toBe(lang);
}

async function expectFooter(page: Page, locale: "en" | "es", where: string): Promise<void> {
  const powered = dictString(locale, "layout.poweredBy", { brand: "Seazn Club" });
  const attribution = dictString(locale, "layout.attribution");
  await expect(page.locator("footer p").first(), `${where}: footer`).toHaveText(`${powered} · ${attribution} →`);
}

// OH3 + the language ruling: the Spanish club's org home, its hub and a
// player's page are Spanish to a screen reader (`<html lang="es">`), in the
// footer, in the tab rail and on the player's own match card — and the English
// club's home is English, so a page stuck on one language cannot pass both.
test("OH3: an ES org's home, hub and player page speak Spanish with <html lang='es'>; the EN org's home speaks English", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 6 * STEP_MS));
  const page = await spectator(browser, { width: 320 });

  // Org home.
  await page.goto(`/shared/${es.slug}`);
  await expectLang(page, "es", "es org home");
  await expectFooter(page, "es", "es org home");
  await expect(page.getByRole("heading", { name: dictString("es", "section.competitions") })).toBeVisible();

  // Hub: every tab label is the Spanish one, and no English label that differs
  // from its Spanish one is on screen ("Info" is the same word in both).
  await page.goto(`/shared/${es.slug}/${esComp.slug}`);
  await expectLang(page, "es", "es hub");
  await expectFooter(page, "es", "es hub");
  const tabIds = await page
    .getByRole("tab")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace(/^mh-tab-/, "")));
  expect(tabIds.length, "the ES hub rail has tabs").toBeGreaterThan(1);
  expect(tabIds, "a seeded league with matches shows a Matches tab").toContain("matches");
  await expect(page.getByRole("tab")).toHaveText(tabIds.map((id) => dictString("es", `landing.tab.${id}`)));
  for (const id of tabIds) {
    const english = dictString("en", `landing.tab.${id}`);
    if (english === dictString("es", `landing.tab.${id}`)) continue;
    await expect(page.getByRole("tab", { name: english, exact: true }), `English tab "${english}"`).toHaveCount(0);
  }

  // Player page: the section heading, the live pill and the opponent line.
  await page.goto(`/shared/${es.slug}/${esComp.slug}/players/${esPlayer.id}`);
  await expectLang(page, "es", "es player page");
  await expectFooter(page, "es", "es player page");
  await expect(page.getByRole("heading", { name: dictString("es", "player.matches"), exact: true })).toBeVisible();
  const slab = page.locator('[data-slab="true"]');
  await expect(slab.getByTestId("mh-player-slab-live")).toHaveText(dictString("es", "player.result.live"));
  await expect(slab.locator("p.truncate")).toHaveText(dictString("es", "player.opponent", { opponent: esPlayer.opponent }));
  await expect(page.getByRole("heading", { name: dictString("en", "player.matches"), exact: true })).toHaveCount(0);

  // The pair: the English club.
  await page.goto(`/shared/${en.slug}`);
  await expectLang(page, "en", "en org home");
  await expectFooter(page, "en", "en org home");
});
