/**
 * SPIKE capture rig (throwaway with the spike): drives the REAL pages with `?spike=a|b` and writes cropped screenshots
 * OUTSIDE the repo (SPIKE_SHOTS_DIR). Seeding is the product's own (match-room-kit `seedOnlineRound`, the same rig as
 * checkin-extend.spec.ts / arbiter-panel.spec.ts): a public competition, a boardgame division played online, six linked
 * players, a league stage, Start, then (for the open state) round 1 opened through the open-round route.
 *
 * The e2e servers send no mail, so the open reaches nobody; what a delivered invite leaves is written the way invite.ts leaves
 * it (a stamp per seat, the bridge row bound to THIS open) - online-chess-desk.spec.ts does the same.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { apiJson, withDb } from "./helpers";
import { roundGameSql, seedOnlineRound, type SeededRound } from "./match-room-kit";

test.describe.configure({ mode: "serial" });

const OUT = process.env.SPIKE_SHOTS_DIR;
const LOG = process.env.SPIKE_LOG;
const WIDTHS = [1280, 834, 768, 320] as const;
const HEIGHT: Record<number, number> = { 1280: 900, 834: 1112, 768: 1024, 320: 700 };
/** Ten boards of two (the owner's mock reads 12 boards / 24 players; ten keeps the seed short and still gives "5 waiting"). */
const NAMES = [
  "Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor", "Elif Demir", "Farid Haddad", "Gita Rao", "Hugo Marchand", "Ines Duarte", "Jonas Kreutz",
  "Keiko Mori", "Liam Byrne", "Mira Novak", "Nils Aaberg", "Oksana Bel", "Pavel Zima", "Quinn Ahern", "Rosa Ibarra", "Sami Tuuri", "Tove Hallberg",
];
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"];
/** Tall phone pages are cropped, not full-page giants. */
const CAP = 5200;

function log(line: string) {
  if (LOG) appendFileSync(LOG, `${line}\n`);
}

async function noHScroll(page: Page, label: string): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  log(`hscroll ${label}: scrollWidth=${scroll} clientWidth=${client}`);
  expect(scroll, `${label}: no horizontal page scroll`).toBeLessThanOrEqual(client);
}

async function setWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT[width]! });
  await page.waitForTimeout(450);
}

/** Absolute (document) top/bottom of an element. */
async function span(page: Page, sel: string, nth = 0): Promise<{ top: number; bottom: number }> {
  return page.locator(sel).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
  });
}

async function shoot(page: Page, name: string, top: number, bottom: number): Promise<void> {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const vw = page.viewportSize()!.width;
  const y = Math.max(0, Math.floor(top) - 8);
  const height = Math.min(CAP, Math.ceil(bottom - y) + 8);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, clip: { x: 0, y, width: vw, height }, caret: "initial", animations: "disabled" });
  log(`shot ${name} y=${y} h=${height}`);
}

/** Where the things the arbiter reaches for first sit, from the top of the panel: logged, so the phases can be compared by number. */
async function measure(page: Page, name: string, top: number): Promise<void> {
  const y = async (loc: ReturnType<Page["locator"]>): Promise<string> =>
    (await loc.count()) === 0 ? "-" : String(Math.round(await loc.first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY) - top));
  const cam = page.locator("main figure").first();
  const camW = (await cam.count()) === 0 ? "-" : String(Math.round((await cam.boundingBox())!.width));
  log(
    `layout ${name}: column.top=${await y(page.getByTestId("spike-round-column"))} picker.top=${await y(page.locator("main select"))} ` +
      `open-cta.top=${await y(page.getByTestId("open-round-cta"))} extend-cta.top=${await y(page.getByTestId("open-round-extend-cta"))} ` +
      `waiting1.top=${await y(page.locator('[data-testid^="spike-c-waiting-"]'))} waitingBox.top=${await y(page.getByTestId("spike-c-waiting"))} resend1.top=${await y(page.locator('[data-testid^="open-round-resend-"]'))} ` +
      `queue.top=${await y(page.getByTestId("external-play-needs-result-queue"))} status.top=${await y(page.getByTestId("spike-c-status"))} ` +
      `camera.top=${await y(cam)} camera.width=${camW} flags.top=${await y(page.getByRole("heading", { name: /^Flags on|^Flags/ }))} decision.top=${await y(page.getByRole("heading", { name: /^Your decision/ }))}`,
  );
}

/** The arbiter panel: header to the bottom of its main. */
async function shootPanel(page: Page, name: string): Promise<void> {
  const head = await span(page, "header >> nth=-1");
  const main = await span(page, "main >> nth=-1");
  await measure(page, name, head.top);
  await shoot(page, name, head.top, main.bottom);
}

/** The fixtures tab: from the Arbiter-panel entry card to the bottom of the stage card that holds the round line. */
async function shootFixtures(page: Page, name: string): Promise<void> {
  const stage = await span(page, "section.card[data-stage-id]");
  const entry = await page.locator('a[href$="/arbiter"]').first().evaluate((el) => {
    const card = el.closest("div") ?? el;
    const r = card.getBoundingClientRect();
    return r.top + window.scrollY;
  });
  await shoot(page, name, Math.min(entry, stage.top), stage.bottom);
}

async function stampInvites(r: SeededRound): Promise<void> {
  const stamped = await withDb(
    (sql) => sql`
      update fixture_external_play ep
         set round_open_id = o.id, white_emailed_at = now(), black_emailed_at = now()
        from fixtures f join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
       where ep.fixture_id = f.id and f.stage_id = ${r.stageId} and f.round_no = 1`,
  );
  expect(stamped.count, "every board's bridge row stamped as invited").toBe(r.boards.length);
}

/** Both players of a board, checked in as the product writes it (match-room.spec.ts's own insert). */
async function checkIn(b: SeededRound["boards"][number], who: ("home" | "away")[]): Promise<void> {
  for (const side of who) {
    const person = side === "home" ? b.home.personId : b.away.personId;
    const res = await withDb(
      (sql) => sql`
        insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
        select f.id, ${person}, f.org_id, 'in', now() from fixtures f where f.id = ${b.fixtureId}`,
    );
    expect(res.count, "a check-in row").toBe(1);
  }
}

test.describe("spike C: the phase-adaptive round column", () => {
  test("before open, check-in with 5 boards waiting, playing with 1 Held", async ({ page, request }) => {
    test.setTimeout(600_000);
    const r = await seedOnlineRound(request, NAMES, { open: false });
    expect(r.boards.length, "ten boards").toBe(10);

    // ── state 1: before the round is opened ──────────────────────────────────
    for (const w of WIDTHS) {
      await setWidth(page, w);
      await page.goto(`${r.arbiterPath}?spike=c`);
      await expect(page.getByTestId("spike-c-before")).toBeVisible();
      await expect(page.getByTestId("spike-c-ready")).toHaveText(/10 boards paired · invites go to 20 players/);
      await expect(page.getByTestId("open-round-cta"), "Open round is the one action").toBeVisible();
      await expect(page.locator('[data-testid="spike-c-pairings"] li'), "the empty room shows the 10 paired boards").toHaveCount(10);
      await expect(page.getByTestId("arbiter-extend-round")).toHaveCount(0);
      if (w === 320) {
        const col = await span(page, '[data-testid="spike-round-column"]');
        const pre = await span(page, '[data-testid="spike-c-pairings"]');
        expect(col.top, "320: the Open round card comes before the paired-boards preview").toBeLessThan(pre.top);
      }
      await noHScroll(page, `c-before-${w}`);
      await shootPanel(page, `c-before-${w}`);
      if (w === 1280 || w === 320) {
        await page.getByTestId("open-round-cta").click();
        const dlg = page.getByTestId("open-round-confirm");
        await expect(dlg).toBeVisible();
        await page.waitForTimeout(300);
        if (OUT) await page.screenshot({ path: join(OUT, `c-before-confirm-${w}.png`), caret: "initial", animations: "disabled" });
        await noHScroll(page, `c-before-confirm-${w}`);
        await page.keyboard.press("Escape");
        if (await dlg.isVisible()) await page.getByRole("button", { name: /cancel/i }).click();
        await expect(dlg).toBeHidden();
      }
    }
    for (const w of WIDTHS) {
      await setWidth(page, w);
      await page.goto(`${r.fixturesTab}&spike=c`);
      await expect(page.getByTestId("spike-round-line").first()).toHaveAttribute("data-state", "paired");
      await expect(page.getByTestId("open-round"), "the control is gone from the tab").toHaveCount(0);
      await noHScroll(page, `fixtures-before-${w}`);
      await shootFixtures(page, `fixtures-before-${w}`);
    }

    // ── state 2: check-in running, 5 boards still waiting ───────────────────
    const opened = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
    // The window is 10 minutes: opened 3m20s ago leaves 6:40 on the clock, the owner's mock.
    const shifted = await withDb(
      (sql) => sql`update stage_round_opens set opened_at = opened_at - interval '200 seconds' where stage_id = ${r.stageId} and round_no = 1`,
    );
    expect(shifted.count, "the round's open row moved").toBe(1);
    await stampInvites(r);
    const past = r.boards.slice(0, 5);
    const waiting = r.boards.slice(5);
    for (const [i, b] of past.entries()) {
      await checkIn(b, ["home", "away"]);
      await roundGameSql(b, { moves: i < 2 ? [] : LINE.slice(0, 2 + i) });
    }
    await checkIn(waiting[0]!, ["home"]); // one player here, one not
    await checkIn(waiting[2]!, ["away"]);
    for (const w of WIDTHS) {
      await setWidth(page, w);
      await page.goto(`${r.arbiterPath}?spike=c`);
      await expect(page.getByTestId("spike-c-checkin")).toBeVisible();
      await expect(page.getByTestId("spike-c-countdown")).toHaveText(/^\d+:\d\d$/);
      await expect(page.locator('[data-testid^="spike-c-waiting-"]'), "only the boards still waiting").toHaveCount(5);
      await expect(page.getByTestId("spike-c-arrived")).toHaveText("12 of 20 checked in");
      await expect(page.getByTestId("spike-c-past")).toContainText("5 other boards are past check-in");
      await expect(page.getByTestId("open-round-extend-cta"), "+5 for the round sits with the countdown").toBeVisible();
      await expect(page.getByTestId("open-round-cta"), "no Open round press while the round is open").toHaveCount(0);
      await noHScroll(page, `c-checkin-${w}`);
      if (w === 320) {
        // the owner's phone rule: in the check-in phase the column is FIRST, above the board picker
        const col = await span(page, '[data-testid="spike-round-column"]');
        const pick = await span(page, "main select");
        expect(col.top, "320: the column comes above the board picker while boards check in").toBeLessThan(pick.top);
      }
      if (w === 768 || w === 834 || w === 1280) {
        const col = await page.getByTestId("spike-round-column").boundingBox();
        const cam = await page.locator("main figure").first().boundingBox();
        expect(col!.x, `${w}: the round column is a SIDE column, right of the camera`).toBeGreaterThan(cam!.x + cam!.width - 1);
        // the room under the camera is used: the waiting boards sit there, in the centre column, not in the side column
        const wait = await page.getByTestId("spike-c-waiting").boundingBox();
        expect(wait!.x + wait!.width, `${w}: the waiting boards are left of the side column`).toBeLessThanOrEqual(col!.x);
        expect(wait!.y, `${w}: and under the camera`).toBeGreaterThan(cam!.y + cam!.height);
      }
      if (w === 320) {
        const hero = await span(page, '[data-testid="spike-c-checkin"]');
        const wait = await span(page, '[data-testid="spike-c-waiting"]');
        const pick = await span(page, "main select");
        expect(wait.top, "320: the waiting boards follow the countdown").toBeGreaterThanOrEqual(hero.bottom - 1);
        expect(wait.bottom, "320: and still come before the picker").toBeLessThanOrEqual(pick.top + 1);
      }
      await shootPanel(page, `c-checkin-${w}`);
    }
    // the same controls the Fixtures tab had, driven from the column: Resend on a row, a board's +5, the round's +5
    await setWidth(page, 1280);
    await page.goto(`${r.arbiterPath}?spike=c`);
    const row = page.getByTestId(`spike-c-waiting-${waiting[1]!.fixtureId}`);
    await row.getByTestId(`open-round-resend-${waiting[1]!.fixtureId}`).click();
    await expect(row.getByTestId("open-round-row-notice")).toBeVisible();
    await row.getByTestId(`spike-c-extend-${waiting[1]!.fixtureId}`).click();
    await expect(row.getByTestId("spike-c-row-notice")).toBeVisible();
    await page.getByTestId("open-round-extend-cta").click();
    await expect(page.getByTestId("open-round-extend-notice")).toContainText(/\d/);
    await page.waitForTimeout(1500);
    await noHScroll(page, "c-checkin-used-1280");
    await shootPanel(page, "c-checkin-used-1280");

    // ── state 3: everyone is playing, one board Held ─────────────────────────
    for (const [i, b] of waiting.entries()) {
      await checkIn(b, [...(i === 0 ? (["away"] as const) : i === 2 ? (["home"] as const) : (["home", "away"] as const))]);
      await roundGameSql(b, { moves: LINE.slice(0, 4), ...(i === 2 ? { hold: "mismatch" as const } : {}) });
    }
    for (const w of WIDTHS) {
      await setWidth(page, w);
      await page.goto(`${r.arbiterPath}?spike=c`);
      await expect(page.getByTestId("spike-c-playing")).toBeVisible();
      await expect(page.getByTestId("spike-c-status")).toHaveText("Round 1 · 9 of 10 boards playing");
      await expect(page.getByTestId("external-play-needs-result-queue"), "the Held board is the actionable thing").toBeVisible();
      await expect(page.getByTestId("spike-c-checkin")).toHaveCount(0);
      const q = await span(page, '[data-testid="external-play-needs-result-queue"]');
      const st = await span(page, '[data-testid="spike-c-status"]');
      expect(q.top, `${w}: the queue rises above the status`).toBeLessThan(st.top);
      if (w === 320) {
        const col = await span(page, '[data-testid="spike-round-column"]');
        const pick = await span(page, "main select");
        const cam = await span(page, "main figure");
        expect(col.top, "320: out of check-in the column sits AFTER the board picker").toBeGreaterThan(pick.top);
        expect(col.top, "320: and before the camera").toBeLessThan(cam.top);
      }
      await noHScroll(page, `c-playing-${w}`);
      await shootPanel(page, `c-playing-${w}`);
    }
    for (const w of WIDTHS) {
      await setWidth(page, w);
      await page.goto(`${r.fixturesTab}&spike=c`);
      await expect(page.getByTestId("spike-round-line").first()).toHaveAttribute("data-state", "attention");
      await expect(page.getByTestId("external-play-needs-result-queue"), "the queue is gone from the tab").toHaveCount(0);
      await noHScroll(page, `fixtures-attention-${w}`);
      await shootFixtures(page, `fixtures-attention-${w}`);
    }
  });
});
