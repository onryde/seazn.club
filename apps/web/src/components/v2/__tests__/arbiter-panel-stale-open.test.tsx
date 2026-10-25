// CI fix D - a press for an OLDER round answering after a newer round has come on screen, from the REAL readers and the REAL usecase.
//
// e2e/arbiter-panel.spec.ts "the open-round hook resets on a round change, and a press targets the round on screen" holds a press for
// round 2 in flight, opens round 3 elsewhere, and taps round 3's confirmation twice (a dead tap, then the real one). On CI the second
// tap's answer never showed (attempt 1) or the confirmation was gone before it (attempt 2). The cause is not the hook: the panel shows
// the division's most recently OPENED round (loadArbiterRound, D12), and a REOPEN is an open - it moves `stage_round_opens.opened_at`.
// The e2e servers have no mail provider, so every press is a reopen; the held round-2 press was released AFTER round 3 opened, its
// server work then made round 2 the most recently opened, and the refresh that followed took the screen back to round 2 and closed
// the confirmation for round 3 (use-open-round.ts resets on a round change).
//
// This file pins both orders with what the page really reads (loadArbiterRound, listOpenRounds) and what the press really does
// (openRound), through the panel's own hook (ArbiterPanel -> ArbiterScreen -> RoundColumn, as arbiter-panel-d17.test.tsx drives it):
//   - the order the spec had (the request is held BEFORE the server does its work): the screen goes to round 2 and the confirmation
//     for round 3 is gone - the red CI saw, and the reason the e2e could not have passed;
//   - the order the spec has now (the server does its work, only the ANSWER is held): round 3 stays on screen, the confirmation
//     stays open through the old answer's refresh, the tap sends exactly one request, for round 3, and round 3's own notice shows.
//
// DB-backed (skipped without DATABASE_URL, as the other usecase suites are).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, type Props } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { sql } from "@/lib/db";
import { viewOfRound } from "@/lib/round-column";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";

// The email seam, as arbiter-panel-d17.test.tsx. The e2e servers have no mail provider: every invite ends dead inside the open, so the
// press is always a REOPEN. `mail.fail` holds every address here, which is the same state.
const mail = vi.hoisted(() => ({ sent: [] as string[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverToAddresses(mail, msg) };
});
beforeEach(() => stubOutboxEnv());

// The browser seams, as arbiter-panel-d17.test.tsx: the router, the network (a request waits until the test answers it), the poll and
// the clock, and the dictionary hooks the screen's formatter needs.
const NOW_MS = vi.hoisted(() => Date.parse("2026-10-16T19:09:00.000Z"));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});
vi.mock("../desk/band-poll", () => ({ browserBandPollDeps: () => ({}), startBandPolling: () => () => undefined }));
vi.mock("../use-extend-clock", () => ({ useExtendClock: vi.fn(() => NOW_MS) }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(enUi as unknown as Dict, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(enUi as unknown as Dict, key, count, "en", vars),
    useLocale: () => "en",
  };
});

import { ArbiterPanel, ArbiterScreen, type ArbiterScreenProps } from "../arbiter-panel";
import { CheckinHero, RoundColumn } from "../arbiter/round-column";
import { ConfirmDialog } from "../confirm-dialog";
import { loadArbiterRound, listFlaggedExternalPlay } from "@/server/usecases/external-play/arbiter";
import { listNeedsOrganiserExternalPlay } from "@/server/usecases/external-play/queue";
import { openRound } from "@/server/usecases/external-play/open-round";
import { listOpenRounds } from "@/server/usecases/external-play/open-round-view";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const T0 = new Date("2026-10-16T19:04:00.000Z");
/** Minutes after T0: every open and every read is stamped on this clock, so which round is the latest is decided by the test. */
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const SLUGS = { org: "club", comp: "autumn", div: "open" };

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
  net.calls.length = 0;
  router.refresh.mockClear();
});

type PanelProps = Parameters<typeof ArbiterPanel>[0];

/** What the arbiter page reads (page.tsx), through the same readers, at one clock. */
async function readPage(r: SeedOnlineChessRoundResult, now: Date): Promise<PanelProps> {
  const [round, views, held, flagged, schedule] = await Promise.all([
    loadArbiterRound(r.owner, r.divisionId, { now }),
    listOpenRounds(r.owner, r.divisionId, { now }),
    listNeedsOrganiserExternalPlay(r.owner, r.divisionId),
    listFlaggedExternalPlay(r.owner, r.divisionId),
    getScheduleSettings(r.owner, r.divisionId),
  ]);
  return {
    round,
    requested: null,
    slugs: SLUGS,
    initialFixtureId: null,
    column: { views, held, flagged: flagged.boards, ownFlagged: flagged.ownBoards, tz: schedule.tz, awaitsStart: false },
  };
}

type Ui = Pick<ReturnType<typeof renderIsland<unknown>>, "tree" | "text" | "batch" | "unmount"> & { rerender: (nextProps: PanelProps) => void };
const island = (el: ReactElement) => renderIsland(el.type as unknown as (p: Props) => ReactNode, propsOf(el));
const screenEl = (ui: Ui): ReactElement => ui.tree()[0]!;
const screenProps = (ui: Ui) => propsOf(screenEl(ui)) as unknown as ArbiterScreenProps;
const columnIsland = (ui: Ui) => {
  const hits = island(screenEl(ui)).tree().filter((e) => e.type === RoundColumn);
  expect(hits, "one RoundColumn").toHaveLength(1);
  return island(hits[0]!);
};
/** Where the round on screen's press lives: its check-in hero, one level below the column (the harness renders one level at a time). */
const heroIsland = (ui: Ui) => {
  const hits = columnIsland(ui).tree().filter((e) => e.type === CheckinHero);
  expect(hits, "one check-in hero: the round on screen is checking in").toHaveLength(1);
  return island(hits[0]!);
};
const byTestid = (tree: ReactElement[], id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);
const dialogOf = (ui: Ui) => {
  const dialogs = [...new Set(heroIsland(ui).tree().filter((e) => e.type === ConfirmDialog))];
  expect(dialogs, "one confirmation in the column").toHaveLength(1);
  return dialogs[0]!;
};
const markup = (ui: Ui) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <ArbiterScreen {...screenProps(ui)} />
    </DictProvider>,
  );
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const onScreen = (ui: Ui) => screenProps(ui).round?.roundNo ?? null;
const heading = (n: number) => enUi["runsheet.round.heading"].replace("{round}", String(n));

/** The state the e2e builds, with the same mail (none): a league whose rounds 1 and 2 are open, and a third round already paired. Each
 *  round plays the same two boards (the same four players), as a league of four does. */
async function seedLeague(): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
  for (const b of r.boards) mail.fail.add(b.home.email).add(b.away.email);
  for (const roundNo of [2, 3]) {
    let seq = 0;
    for (const b of r.boards) {
      seq += 1;
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
        values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${roundNo}, ${seq}, ${`stale-${randomUUID().slice(0, 8)}`}, 'scheduled',
                ${b.home.entrantId}, ${b.away.entrantId}, ${at(0)})`;
    }
  }
  return r;
}
const press = (r: SeedOnlineChessRoundResult, roundNo: number, now: Date) => openRound({ stageId: r.stageId, roundNo, actorUserId: r.ownerUserId }, { now });
const openedAt = async (r: SeedOnlineChessRoundResult, roundNo: number) =>
  (await sql<{ openedAt: Date }[]>`select opened_at as "openedAt" from stage_round_opens where stage_id = ${r.stageId} and round_no = ${roundNo}`)[0]!.openedAt.getTime();

/** Round 2 on screen with its confirmation open and its press sent and NOT answered; the panel's own handle is the one that holds it. */
async function roundTwoPressInFlight(r: SeedOnlineChessRoundResult) {
  expect(await press(r, 1, at(0)), "premise: round 1 opened").toMatchObject({ opened: true });
  expect(await press(r, 2, at(1)), "premise: round 2 opened").toMatchObject({ opened: true });
  const ui = renderIsland(ArbiterPanel, await readPage(r, at(2)));
  expect(onScreen(ui), "premise: round 2 is the most recently opened, so it is on screen").toBe(2);
  expect(viewOfRound(screenProps(ui).column.views, screenProps(ui).round!)?.press, "premise: no mail reached anyone, so the press is a REOPEN").toBe("reopen");
  const ask = byTestid(heroIsland(ui).tree(), "arbiter-column-reinvite");
  expect(ask, "one press in the column").toHaveLength(1);
  (propsOf(ask[0]!).onClick as () => void)();
  (propsOf(dialogOf(ui)).onConfirm as () => void)();
  expect(net.calls.map((c) => c.json), "round 2's press is out").toEqual([{ roundNo: 2 }]);
  expect(screenProps(ui).openRound.state.busy, "and held").toEqual({ kind: "open" });
  return ui;
}

/** Round 3 comes on screen (opened elsewhere, the panel brought it in), and its confirmation is asked and tapped while round 2's request is
 *  still out: the tap is dead (the runner's flag outlives the round change, rule R1), so nothing is sent for round 3. */
async function roundThreeOnScreenWithADeadTap(r: SeedOnlineChessRoundResult, ui: Ui, opensAt: Date, readAt: Date) {
  expect(await press(r, 3, opensAt), "premise: round 3 opened").toMatchObject({ opened: true });
  ui.rerender(await readPage(r, readAt));
  expect(onScreen(ui), "round 3 is the round on screen, with round 2's request still out").toBe(3);
  expect(screenProps(ui).openRound.state, "round 2's confirmation (busy) went with the round change").toMatchObject({ confirming: false, busy: null });
  const ask = byTestid(heroIsland(ui).tree(), "arbiter-column-reinvite");
  expect(ask).toHaveLength(1);
  (propsOf(ask[0]!).onClick as () => void)();
  expect(propsOf(dialogOf(ui)).open, "round 3's confirmation is open").toBe(true);
  (propsOf(dialogOf(ui)).onConfirm as () => void)();
  expect(net.calls, "the dead tap sent nothing: round 2's request is still out").toHaveLength(1);
  expect(propsOf(dialogOf(ui)).open, "and the confirmation waits for another tap").toBe(true);
}

describe.skipIf(!HAS_DB)("a press for round 2 answering after round 3 has come on screen (e2e: the open-round hook resets on a round change)", () => {
  it("the order the e2e had - the server does round 2's work AFTER round 3 opened: round 2 takes the screen back and round 3's confirmation is gone", async () => {
    const r = await seedLeague();
    const ui = await roundTwoPressInFlight(r);
    await roundThreeOnScreenWithADeadTap(r, ui, at(3), at(4));

    // The held request is released: the server only now does round 2's work, a REOPEN, so round 2 is the most recently opened again.
    const answer = await press(r, 2, at(5));
    expect(answer, "premise: round 2's press reopened it").toMatchObject({ opened: true });
    expect(await openedAt(r, 2), "round 2 now opened after round 3").toBeGreaterThan(await openedAt(r, 3));
    net.calls[0]!.resolve(answer);
    await flush();
    expect(router.refresh, "the page is refreshed after the answer").toHaveBeenCalledTimes(1);
    ui.rerender(await readPage(r, at(6)));
    expect(onScreen(ui), "the screen followed the most recently opened round back to round 2").toBe(2);
    expect(markup(ui)).toContain(heading(2));
    expect(screenProps(ui).openRound.state.confirming, "round 3's confirmation did not survive the round changing again").toBe(false);
    expect(markup(ui)).not.toContain('data-testid="arbiter-column-reinvite-notice"');
  });

  it("the order the e2e has now - the server does round 2's work BEFORE round 3 opens, only its answer is held: round 3 stays, its tap sends once for round 3, its notice shows", async () => {
    const r = await seedLeague();
    const ui = await roundTwoPressInFlight(r);

    // The server has done round 2's work (a reopen); the answer is what is still on the wire.
    const answer = await press(r, 2, at(3));
    expect(answer, "premise: round 2's press reopened it").toMatchObject({ opened: true });
    await roundThreeOnScreenWithADeadTap(r, ui, at(4), at(5));
    expect(await openedAt(r, 3), "premise: round 3 is the most recently opened, so no answer for round 2 can move the screen").toBeGreaterThan(await openedAt(r, 2));

    // Released: the old answer lands in a reset reducer (dropped), the page is refreshed, and nothing moved.
    net.calls[0]!.resolve(answer);
    await flush();
    expect(router.refresh, "the old answer refreshes the page").toHaveBeenCalledTimes(1);
    expect(markup(ui), "round 2's answer shows nothing under round 3").not.toContain('data-testid="arbiter-column-reinvite-notice"');
    ui.rerender(await readPage(r, at(6)));
    expect(onScreen(ui), "round 3 is still the round on screen after the refresh").toBe(3);
    expect(markup(ui)).toContain(heading(3));
    expect(propsOf(dialogOf(ui)).open, "and its confirmation is still open").toBe(true);

    // The next tap goes, once, for round 3.
    (propsOf(dialogOf(ui)).onConfirm as () => void)();
    expect(net.calls.map((c) => c.json), "round 2's press, then exactly one for round 3").toEqual([{ roundNo: 2 }, { roundNo: 3 }]);
    expect(screenProps(ui).openRound.state.busy).toEqual({ kind: "open" });
    const answer3 = await press(r, 3, at(7));
    expect(answer3, "premise: round 3's press reopened it").toMatchObject({ opened: true });
    net.calls[1]!.resolve(answer3);
    await flush();
    expect(router.refresh, "round 3's answer refreshes the page too").toHaveBeenCalledTimes(2);
    ui.rerender(await readPage(r, at(8)));
    expect(onScreen(ui), "round 3 is still on screen").toBe(3);
    const h = markup(ui);
    expect(h, "round 3's own answer is on screen").toContain('data-testid="arbiter-column-reinvite-notice"');
    expect(h, "and it is the open's count for round 3's two boards").toContain(pluralRuntime(enUi as unknown as Dict, "externalPlay.openRound.invited", 0, "en"));
  });

  it("anti-vacuity: both orders ran against three paired rounds", async () => {
    const r = await seedLeague();
    const rounds = await sql<{ roundNo: number; n: number }[]>`
      select round_no as "roundNo", count(*)::int as n from fixtures where stage_id = ${r.stageId} group by round_no order by round_no`;
    expect(rounds).toEqual([
      { roundNo: 1, n: 2 },
      { roundNo: 2, n: 2 },
      { roundNo: 3, n: 2 },
    ]);
  });
});
