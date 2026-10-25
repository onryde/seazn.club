// Final review I2 - the D17 re-open in the Arbiter Panel's PLAYING phase, from the REAL state.
//
// D17 (owner ruling 2026-10-14 "re-arm"): the arbiter's No result, then the organiser's void, leaves a playable board whose bridge row
// our side CLOSED. The reader (`listOpenRounds`) names `reopen` for the round, but the loader paints that board a result (its bridge row
// is `finished`), so once every other board is decided no board is `checking_in`, the phase is `playing`, and the hero - the press's
// one home - is not drawn. The playing status now draws the same press (round-column.tsx `roundPress`).
//
// Nothing here is a hand fixture of that state. The round is opened, a neighbour is decided on the pad, a board is given its No result
// and then voided, all through the real usecases (_external-play-d17.ts); the props are what the arbiter page reads (the real
// `loadArbiterRound`, `listOpenRounds` and the queue readers); the panel is mounted through the hook harness (ArbiterPanel ->
// ArbiterScreen -> RoundColumn, as arbiter-panel-mount.test.tsx drives it) with its own `useOpenRound`; and the press's POST is answered
// by the REAL `openRound` usecase, so the seam is proven from the producer (the DB) to the consumer (the button, the request, the
// answer under it), and the branch the usecase takes is read back from the rows.
//
// DB-backed (skipped without DATABASE_URL, as the other usecase suites are).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, type Props } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { sql } from "@/lib/db";
import { roundColumnPhase, viewOfRound } from "@/lib/round-column";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";

// The email seam, as open-round-view.test.ts: the invite is queued on the email outbox and the provider's answer is ours.
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

// The browser seams, as arbiter-panel-mount.test.tsx: the router, the network (a request waits until the test answers it, so "in flight"
// is a real state), the poll and the clock (neither is under test), and the dictionary hooks the screen's formatter needs.
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
import { RoundColumn } from "../arbiter/round-column";
import { ConfirmDialog } from "../confirm-dialog";
import { loadArbiterRound, listFlaggedExternalPlay } from "@/server/usecases/external-play/arbiter";
import { listNeedsOrganiserExternalPlay } from "@/server/usecases/external-play/queue";
import { openRound } from "@/server/usecases/external-play/open-round";
import { listOpenRounds } from "@/server/usecases/external-play/open-round-view";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { decide, noResultThenVoid } from "@/server/usecases/__tests__/_external-play-d17";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const T0 = new Date("2026-10-16T19:04:00.000Z");
const INSIDE = new Date(T0.getTime() + 5 * MIN);
const CLOSED = new Date(T0.getTime() + DEADLINE_AFTER_MS + 10 * MIN);
const EN = enUi as Record<string, string>;
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

// ---- driving the chain: panel -> screen -> column -> the button / the confirmation ------------------------------------------------

type Ui = Pick<ReturnType<typeof renderIsland<unknown>>, "tree" | "text" | "batch" | "unmount"> & { rerender: (nextProps: PanelProps) => void };
const island = (el: ReactElement) => renderIsland(el.type as unknown as (p: Props) => ReactNode, propsOf(el));
const screenEl = (ui: Ui): ReactElement => ui.tree()[0]!;
const screenProps = (ui: Ui) => propsOf(screenEl(ui)) as unknown as ArbiterScreenProps;
const columnIsland = (ui: Ui) => {
  const hits = island(screenEl(ui)).tree().filter((e) => e.type === RoundColumn);
  expect(hits, "one RoundColumn").toHaveLength(1);
  return island(hits[0]!);
};
const byTestid = (tree: ReactElement[], id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);
const dialogsOf = (ui: Ui) => [...new Set(columnIsland(ui).tree().filter((e) => e.type === ConfirmDialog))];
const markup = (ui: Ui) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <ArbiterScreen {...screenProps(ui)} />
    </DictProvider>,
  );
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const auditTypes = async (competitionId: string) =>
  (
    await sql<{ type: string }[]>`
      select type from competition_events where competition_id = ${competitionId} and type like 'external_play.round_%' order by created_at, id`
  ).map((x) => x.type);
const openedAt = async (stageId: string) =>
  (await sql<{ openedAt: Date }[]>`select opened_at as "openedAt" from stage_round_opens where stage_id = ${stageId} and round_no = 1`)[0]!.openedAt.getTime();

// ---- the real D17 states ----------------------------------------------------------------------------------------------------

type State = {
  name: string;
  seed: Parameters<typeof seedOnlineChessRound>[0];
  /** Build the state on a round opened at T0, and say at what clock the page is read and the press made. */
  build: (r: SeedOnlineChessRoundResult) => Promise<Date>;
};
const REOPEN_STATES: State[] = [
  {
    name: "a decided neighbour and a re-armed board, inside the window",
    seed: { roundNo: 1, fixtures: 2 },
    build: async (r) => {
      await decide(r, r.boards[1]!);
      await noResultThenVoid(r, r.boards[0]!.fixtureId);
      return INSIDE;
    },
  },
  {
    name: "the same, once the old window has closed: the restart is still offered",
    seed: { roundNo: 1, fixtures: 2 },
    build: async (r) => {
      await decide(r, r.boards[1]!);
      await noResultThenVoid(r, r.boards[0]!.fixtureId);
      return CLOSED;
    },
  },
  {
    name: "a one-board round, re-armed: the only board in it paints a result",
    seed: { roundNo: 1, fixtures: 1 },
    build: async (r) => {
      await noResultThenVoid(r, r.boards[0]!.fixtureId);
      return CLOSED;
    },
  },
];

describe.skipIf(!HAS_DB)("the Arbiter Panel's playing phase draws the D17 re-open (final review I2), from the real state", () => {
  it.each(REOPEN_STATES.map((s) => [s.name, s] as const))("%s: the button exists, opens the confirmation, POSTs once, and the real usecase restarts the round", async (_name, state) => {
    const r = await seedOnlineChessRound(state.seed);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 }), "premise: the round opened").toMatchObject({ opened: true });
    const now = await state.build(r);
    const props = await readPage(r, now);

    // The premises are the REAL reader's and the REAL loader's words, not ours: no board checks in, so the column is in its playing
    // phase, and the reader still names the restart for the round on screen.
    expect(props.round, "the loader found the round").not.toBeNull();
    expect(props.round!.boards.map((b) => b.state.kind), "every board paints a result (the re-armed one too)").toEqual(props.round!.boards.map(() => "result"));
    expect(roundColumnPhase(props.round, null), "the phase is playing").toBe("playing");
    const view = viewOfRound(props.column.views, props.round!);
    expect(view?.press, "the reader names the re-open").toBe("reopen");

    const ui = renderIsland(ArbiterPanel, props);
    const before = markup(ui);
    expect(before).toContain('data-phase="playing"');
    expect(before).not.toContain('data-testid="arbiter-checkin-hero"');

    // The button exists, once, in the status card, with the reopen words.
    const buttons = byTestid(columnIsland(ui).tree(), "arbiter-column-reinvite");
    expect(buttons, "one press in the column").toHaveLength(1);
    expect(/<button\b[^>]*data-testid="arbiter-column-reinvite"[^>]*>([^<]*)</.exec(before)?.[1]).toBe(EN["arbiter.column.reopenCta"]);

    // It ASKS: the confirmation opens through the panel's own handle, and nothing is sent.
    expect(dialogsOf(ui).map((d) => propsOf(d).open), "closed until asked").toEqual([false]);
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(screenProps(ui).openRound.state.confirming).toBe(true);
    expect(net.calls, "asking sends nothing").toHaveLength(0);
    const dialog = dialogsOf(ui)[0]!;
    expect(propsOf(dialog).open, "the hero's confirmation is open").toBe(true);

    // The confirm POSTs once; a second tap while it is out sends nothing more.
    const stampBefore = await openedAt(r.stageId);
    const auditBefore = await auditTypes(r.competitionId);
    (propsOf(dialog).onConfirm as () => void)();
    (propsOf(dialogsOf(ui)[0]!).onConfirm as () => void)();
    expect(net.calls.map((c) => [c.url, c.json]), "ONE request, for this stage and this round").toEqual([[`/api/v1/stages/${r.stageId}/open-round`, { roundNo: 1 }]]);
    expect(screenProps(ui).openRound.state.busy).toEqual({ kind: "open" });
    expect(/<button\b[^>]*data-testid="arbiter-column-reinvite"[^>]*>/.exec(markup(ui))![0], "the press is held while it is out").toContain('disabled=""');

    // The server's answer to THAT request: the real usecase, pressed with what the button sent.
    const sent = net.calls[0]!;
    const body = sent.json as { roundNo: number };
    const answer = await openRound({ stageId: r.stageId, roundNo: body.roundNo, actorUserId: r.ownerUserId }, { now });
    expect(answer, "the restart invites the re-armed board's two players").toMatchObject({ opened: true, invited: 2 });
    sent.resolve(answer);
    await flush();
    expect(router.refresh, "the page is refreshed after the answer").toHaveBeenCalledTimes(1);

    // The branch the reader predicted is the branch the rows show: the window restarted and the audit event says so.
    expect(await openedAt(r.stageId), "the window moved").not.toBe(stampBefore);
    expect((await auditTypes(r.competitionId)).slice(auditBefore.length), "one event, a re-open").toEqual(["external_play.round_reopened"]);

    // The page, read again after the refresh: the re-armed board checks in, so the HERO is drawn, and the answer the press got is still
    // under it (the handle is the panel's, so it survived the phase change); nobody is owed, so the press itself is gone.
    const after = await readPage(r, new Date(now.getTime() + MIN));
    expect(roundColumnPhase(after.round, null), "the round is checking in again").toBe("checkin");
    ui.rerender(after);
    const h = markup(ui);
    expect(h).toContain('data-phase="checkin"');
    expect(h).not.toContain('data-testid="arbiter-column-reinvite"');
    expect(h).toContain('data-testid="arbiter-column-reinvite-notice"');
    expect(h).toContain(pluralRuntime(enUi as unknown as Dict, "externalPlay.openRound.invited", 2, "en"));
  });

  it("the empty pair: a game MAY be on file (a create marker), so the reader names nothing and the playing status draws no press", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 });
    await decide(r, r.boards[1]!);
    await noResultThenVoid(r, r.boards[0]!.fixtureId);
    // A labelled SQL move: no product path writes a create marker onto a closed row.
    await sql`update fixture_external_play set create_sent_at = now() - interval '30 minutes' where fixture_id = ${r.boards[0]!.fixtureId}`;
    const props = await readPage(r, CLOSED);
    expect(roundColumnPhase(props.round, null), "premise: still the playing phase").toBe("playing");
    expect(viewOfRound(props.column.views, props.round!)?.press ?? "none", "the reader names no press").toBe("none");
    const h = markup(renderIsland(ArbiterPanel, props));
    expect(h).toContain('data-phase="playing"');
    expect(h).not.toContain('data-testid="arbiter-column-reinvite"');
    expect(h).not.toContain('data-testid="arbiter-column-reinvite-dialog"');
  });

  it("anti-vacuity: the real states cover three reopen shapes", () => {
    expect(REOPEN_STATES.length).toBe(3);
  });
});
