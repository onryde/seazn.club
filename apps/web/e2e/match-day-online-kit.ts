// Match Day's online round and board panels (the Arbiter page's column, retired in Match Day all-in-one Task 10; spec
// 2026-10-24-arbiter-round-column-design.md for the column's copy): what more than one spec needs to drive and read them. Playwright
// refuses a spec file that imports another spec file, so the helpers shared by match-day-online.spec.ts, the round and board panel specs,
// online-chess-desk.spec.ts, e2e/mobile/match-surfaces.spec.ts and the chess walkthrough live here. Nothing in this file is a test.
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { LIVE_POLL_MS } from "../src/components/v2/desk/band-poll";
import { INVITE_WORD_KEYS, type SeatInviteWord } from "../src/lib/invite-status";
import { withDb } from "./helpers";
import { fill, uiEn, type RoundBoard } from "./match-room-kit";

// ─── locators and readers (moved from online-chess-desk.spec.ts, Task 12) ──────────────────────────────────────────────────────

/** Match Day's focus column (`md-focus`): the open round's or board's panel, one at a time on every width. The round panel's blocks keep the
 *  column's test ids (`arbiter-column-open`, `arbiter-checkin-hero`, `arbiter-waiting`, ...). */
export const focus = (page: Page) => page.getByTestId("md-focus");

/** One seat of a board on the round panel's waiting list, found by the board's fixture and the seat's colour. */
export const waitingSeat = (page: Page, board: RoundBoard, colour: "white" | "black") =>
  page.locator(`[data-testid="arbiter-waiting-row"][data-fixture-id="${board.fixtureId}"] [data-testid="arbiter-seat"][data-colour="${colour}"]`);

/** The word a seat shows for its invite: exactly one chip, the right `data-word`, and the dictionary's own text for it. */
export async function expectSeatWord(page: Page, board: RoundBoard, colour: "white" | "black", word: SeatInviteWord): Promise<void> {
  const chip = waitingSeat(page, board, colour).getByTestId("arbiter-invite-word");
  await expect(chip, `${colour} of ${board.fixtureId}: one word`).toHaveCount(1);
  await expect(chip, `${colour} of ${board.fixtureId}`).toHaveAttribute("data-word", word);
  await expect(chip, `${colour} of ${board.fixtureId}`).toHaveText(uiEn[INVITE_WORD_KEYS[word]]!);
}

/** One seat of a board in a confirmation dialog's row (`OpenRoundConfirmBody`): the same word the waiting list shows for that seat
 *  (Task 16 D2 - the dialog used to say "Not invited" for a seat the list called Not delivered), in the dictionary's own text. The
 *  seat's WHOLE text is matched, anchored at both ends: "White: Not delivered, Bounced" (a seat that read two words) is not
 *  "White: Not delivered", so a mixed string fails where a substring check would pass. */
export async function expectConfirmSeatWord(dialog: Locator, board: RoundBoard, colour: "white" | "black", word: SeatInviteWord): Promise<void> {
  const seat = dialog.getByTestId(`open-round-invitee-${board.fixtureId}`).locator(`[data-seat="${colour}"]`);
  await expect(seat, `${colour} of ${board.fixtureId} is named in the confirmation`).toHaveCount(1);
  const wanted = fill("arbiter.column.confirmSeat", { colour: uiEn[colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"]!, words: uiEn[INVITE_WORD_KEYS[word]]! });
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(seat, `${colour} of ${board.fixtureId} in the confirmation reads exactly ${JSON.stringify(wanted)}`).toHaveText(new RegExp(`^${escaped}$`));
}

/** The open-round route's answer (`OpenRoundResult`, lib/open-round.ts), as it crosses the wire. */
export type OpenAnswer = { opened: boolean; invited: number; retrying: number; skipped: { fixtureId: string; reason: string }[] };

/** Started BEFORE the click that sends the request (a response that has already gone by is never seen). */
export const openRoundSent = (page: Page, stageId: string) =>
  page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/stages/${stageId}/open-round`));

export async function openAnswerOf(res: Response): Promise<OpenAnswer> {
  expect(res.status(), "the open-round route answered").toBeLessThan(300);
  const body = (await res.json()) as { data?: OpenAnswer };
  expect(body.data, "the route's answer carries its data").toBeDefined();
  return body.data!;
}

/** "{count} player(s) invited." - the dictionary's one/other pair, picked by the count the way `plural()` picks it. */
export const invitedLine = (count: number) => fill(count === 1 ? "externalPlay.openRound.invited.one" : "externalPlay.openRound.invited.other", { count });

/** The lines an open's notice draws for the answer the route gave: the count, then one line per board nobody was reached on (the
 *  keys `openNoticeText` reads, filled from the answer and the round's boards, not from the notice). The first line assumes nothing
 *  is left sending - the notice words a send still in flight as its own line, and drops the count when it is 0 - so that is a PREMISE
 *  and fails by name: the e2e servers have no mail provider, every attempt ends dead inside the open, and `retrying` is 0. */
export function openNoticeLines(answer: OpenAnswer, boards: readonly RoundBoard[]): string[] {
  expect(answer.retrying, "premise: no mail provider, so no invite is left sending when the open answers").toBe(0);
  return [
    invitedLine(answer.invited),
    ...answer.skipped.map((skipped) => {
      const n = boards.findIndex((b) => b.fixtureId === skipped.fixtureId) + 1;
      expect(n, `the skipped board ${skipped.fixtureId} is one of the round's`).toBeGreaterThan(0);
      expect(skipped.reason, "a send that failed is skipped as send_failed").toBe("send_failed");
      return fill("runsheet.round.skipLine", { board: fill("arbiter.boardNo", { n }), reason: uiEn["externalPlay.openRound.skipped.sendFailed"]! });
    }),
  ];
}

/** Records every distinct set of lines the open's notice shows, from now on, into `window.__openNotices`. The first open's notice
 *  lives only until the refresh that follows it flips the column's phase and takes its block away, which is shorter than any poll,
 *  so a MutationObserver (not an assertion in flight) is what can read it. */
export async function recordOpenNotices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __openNotices?: string[][] };
    const seen: string[][] = (w.__openNotices = []);
    const read = () => {
      for (const el of document.querySelectorAll('[data-testid="arbiter-column-open-notice"]')) {
        const lines = [...el.querySelectorAll("p")].map((p) => p.textContent ?? "");
        const last = seen[seen.length - 1];
        if (lines.length > 0 && JSON.stringify(last) !== JSON.stringify(lines)) seen.push(lines);
      }
    };
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true });
    read();
  });
}
export const recordedOpenNotices = (page: Page) =>
  page.evaluate(() => (window as unknown as { __openNotices?: string[][] }).__openNotices ?? null);

// ─── what Task 13 adds ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long to wait for the panel's own poll to bring a change in. The panel polls at `LIVE_POLL_MS` while any board of the round is
 *  not over (match-day-shell.tsx: `startBandPolling(live, refresh, ...)`), so a change made now is on screen within one period
 *  plus the round trip. Derived from the constant (AGENTS class 20), so moving the period moves every wait that depends on it. */
export const POLL_BUDGET_MS = LIVE_POLL_MS + 20_000;

/** A test budget for a test that waits out `polls` of the panel's polls on top of `baseMs` of everything else (class 20: a flat
 *  timeout beside a derived cost is a latent red). */
export const budgetFor = (polls: number, baseMs: number): number => baseMs + polls * POLL_BUDGET_MS;

/** The panel's refresh, now: the tab coming back (a hidden -> visible event is what `startBandPolling` answers with an immediate
 *  `router.refresh()`), the same path the Match Day specs use to bring a change in without waiting out a period. */
export const refreshNow = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

/** The invite rows the outbox holds for these boards' seats: one per player's address, queued by an open. */
export async function inviteRowCount(fixtureIds: readonly string[]): Promise<number> {
  return withDb(
    async (sql) =>
      (
        await sql`
          select 1 from email_outbox
           where kind = 'chess_invite' and ref_type = 'fixture_seat' and meta->>'fixtureId' in ${sql(fixtureIds as string[])}`
      ).length,
  );
}

/** The row the sweep leaves on a board whose check-in window ended with nobody there AND a Start on its ledger: held for the
 *  organiser (`no_show_both`), with no game on file (sweep.ts `noShow`, RB3). A both-absent board with NO Start is not held: the
 *  sweep walks it over (a double walkover). The sweep is a cron job that does not run in these specs, so this writes the row it
 *  leaves; the board leaves the `checking_in` state, which is what flips the column from its check-in phase to its playing phase.
 *  walkthrough/chess-external-play.spec.ts drives the real thing (a Start through the events route, then the sweep). */
export async function holdNoShowSql(fixtureId: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play
         set status = 'needs_organiser', needs_reason = 'no_show_both', updated_at = now()
       where fixture_id = ${fixtureId}`;
    expect(res.count, `bridge row for ${fixtureId} (was the round opened?)`).toBe(1);
  });
}

/** A board cancelled with an open flag on it: the one board the queue offers an inline "Mark as reviewed" for (a cancelled board can
 *  never be selected, so its card closes its own review). `kind` is the flag producer reconcile's out-of-band adoption writes. */
export async function cancelFlaggedSql(orgId: string, fixtureId: string): Promise<void> {
  await withDb(async (sql) => {
    const cancelled = await sql`update fixtures set status = 'cancelled' where id = ${fixtureId}`;
    expect(cancelled.count, `fixture ${fixtureId} exists`).toBe(1);
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
      values (${fixtureId}, ${orgId}, 'out_of_band_play', null,
              ${"plies 2-3 (e7e5 g1f3) played at Lichess, not through Seazn; camera required"})`;
  });
}

/** Moves a round's open `agoMs` into the past (`stage_round_opens.opened_at`): its check-in window hangs off that instant
 *  (`windowFor(anchor)`: opens `WINDOW_OPEN_LEAD_MS` before it, closes `DEADLINE_AFTER_MS` after it), so a round opened "now" can be
 *  made one whose window ended, without waiting. */
export async function backdateOpenSql(stageId: string, roundNo: number, agoMs: number): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      update stage_round_opens set opened_at = now() - (${agoMs}::bigint * interval '1 millisecond')
       where stage_id = ${stageId} and round_no = ${roundNo}`;
    expect(res.count, `round ${roundNo} of ${stageId} was opened`).toBe(1);
  });
}

/** Every POST this page makes to the open-round route of `stageId`, with the round each asked for, from now on. */
export function watchOpenRoundPosts(page: Page, stageId: string): { roundNos: () => (number | null)[] } {
  const seen: (number | null)[] = [];
  page.on("request", (q) => {
    if (q.method() !== "POST" || !q.url().includes(`/stages/${stageId}/open-round`)) return;
    const body = q.postDataJSON() as { roundNo?: number } | null;
    seen.push(typeof body?.roundNo === "number" ? body.roundNo : null);
  });
  return { roundNos: () => seen.slice() };
}

// ─── where Match Day opens a round's panel and a board's panel ─────────────────────────────────────────────────────────────────────

/** A round's panel: `?round=<stage id>:<round no>`. `r` is a seeded round (`SeededRound`): its Match Day path and its stage. */
export const roundPanelUrl = (r: { matchDayPath: string; stageId: string }, roundNo = 1): string => `${r.matchDayPath}?round=${r.stageId}:${roundNo}`;
/** A board's panel: `?board=<fixture id>`. */
export const boardPanelUrl = (r: { matchDayPath: string }, fixtureId: string): string => `${r.matchDayPath}?board=${fixtureId}`;

/** Open a round's panel and wait for it; `phase` is the panel's own `data-state` (not_started | before | checkin | playing). */
export async function openRoundPanel(page: Page, r: { matchDayPath: string; stageId: string }, phase?: string, roundNo = 1): Promise<void> {
  await page.goto(roundPanelUrl(r, roundNo));
  await expect(focus(page), "the round panel is on screen").toHaveAttribute("data-online", "round", { timeout: 30_000 });
  // THIS round's panel, not the default focus: an address naming a round that is not a row is ignored (the shell falls back to the first
  // round), and a panel in the asked-for phase on the WRONG round would pass every check below.
  await expect(focus(page), `it is round ${roundNo}'s panel`).toHaveAttribute("data-key", `${r.stageId}:${roundNo}`, { timeout: 30_000 });
  if (phase) await expect(focus(page), `the round is ${phase}`).toHaveAttribute("data-state", phase, { timeout: 30_000 });
}

/** Open a board's panel and wait for it. */
export async function openBoardPanel(page: Page, r: { matchDayPath: string }, fixtureId: string): Promise<void> {
  await page.goto(boardPanelUrl(r, fixtureId));
  await expect(focus(page), "the board panel is on screen").toHaveAttribute("data-fixture-id", fixtureId, { timeout: 30_000 });
}
