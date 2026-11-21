// T10 review I-2 - the D17 re-open in Match Day's round panel, from the REAL state.
//
// D17 (owner ruling 2026-10-14 "re-arm"): the arbiter's No result, then the organiser's void, leaves a playable board whose bridge row our side
// CLOSED. The reader (`listOpenRounds`) names `reopen` for the round, but the loader paints that board a result (its bridge row is `finished`),
// so once every other board is decided no board is checking in, the phase is `playing`, and the check-in hero - the press's usual home - is
// not drawn: the playing status draws the same press. The Arbiter Panel's own suite (arbiter-panel-d17.test.tsx) proved this from the producer
// to the button; it went with that page in Task 10, and the hand fixtures that remained (round-focus.test.tsx, lib/match-day/online.test.ts)
// build a row nobody can produce. This is the real-producer proof, through Match Day's consumer.
//
// Nothing here is a hand fixture of that state. The round is opened, a neighbour is decided on the pad, a board is given its No result and
// then voided, all through the real usecases (_external-play-d17.ts, shared with open-round-view.test.ts); the row is what the poll carries
// (the real `readOnlineRounds`, the producer of `MatchDayView.online_rounds`); the panel is mounted through the hook harness with its own
// `useOpenRoundWith`; and the press's POST is answered by the REAL `openRound` usecase, so the seam is proven from the producer (the DB) to
// the consumer (the button, the request, the answer under it), and the branch the usecase takes is read back from the rows.
//
// DB-backed (skipped without DATABASE_URL, as the other usecase suites are).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime } from "@/lib/i18n-runtime";
import { sql } from "@/lib/db";
import type { Reader } from "@/lib/match-day/online";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";
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

// The browser seam, as round-focus.test.tsx: the network (a request waits until the test answers it, so "in flight" is a real state).
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

import { RoundFocus, type RoundFocusProps } from "../round-focus";
import { ConfirmDialog } from "../../confirm-dialog";
import type { MatchDayCtx } from "../court-focus";
import { readOnlineRounds } from "@/server/usecases/match-day-online";
import { openRound } from "@/server/usecases/external-play/open-round";
import { decide, noResultThenVoid } from "@/server/usecases/__tests__/_external-play-d17";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const T0 = new Date("2026-10-16T19:04:00.000Z");
const INSIDE = new Date(T0.getTime() + 5 * MIN);
const CLOSED = new Date(T0.getTime() + DEADLINE_AFTER_MS + 10 * MIN);
const EN = enUi as Record<string, string>;
const dict = enUi as unknown as Dict;
const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
  net.calls.length = 0;
});

const props = (row: MatchDayOnlineRound, nowMs: number, onChanged: () => void): RoundFocusProps => ({
  ctx,
  round: row,
  next: null,
  reader: EDITOR,
  nowMs,
  backLabel: "All rounds",
  onBack: () => {},
  onChanged,
  onFrozen: () => {},
  onOpenBoard: () => {},
  onOpenRound: () => {},
});
const markup = (p: RoundFocusProps) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <RoundFocus {...p} />
    </DictProvider>,
  );
/** What the poll carries for the round: the real producer, at one clock. */
async function readRow(r: SeedOnlineChessRoundResult, now: Date): Promise<MatchDayOnlineRound> {
  const rows = (await readOnlineRounds(r.owner, r.competitionId, now)).filter((x) => x.stage_id === r.stageId && x.round_no === r.roundNo);
  expect(rows, "premise: the poll lists the round once").toHaveLength(1);
  return rows[0]!;
}
const byTestid = (tree: ReactElement[], id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const auditTypes = async (competitionId: string) =>
  (
    await sql<{ type: string }[]>`
      select type from competition_events where competition_id = ${competitionId} and type like 'external_play.round_%' order by created_at, id`
  ).map((x) => x.type);
const openedAt = async (stageId: string) =>
  (await sql<{ openedAt: Date }[]>`select opened_at as "openedAt" from stage_round_opens where stage_id = ${stageId} and round_no = 1`)[0]!.openedAt.getTime();
const said = (h: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(h)?.[1] ?? null;
const words = (key: string, n: number, vars?: Record<string, string | number>) => pluralRuntime(dict, key, n, "en", vars);

// ---- the real D17 states ----------------------------------------------------------------------------------------------------

type State = {
  name: string;
  seed: Parameters<typeof seedOnlineChessRound>[0];
  /** Build the state on a round opened at T0, and say at what clock the poll is read and the press made. */
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

describe.skipIf(!HAS_DB)("Match Day's round panel draws the D17 re-open (T10 review I-2), from the real state", () => {
  it.each(REOPEN_STATES.map((s) => [s.name, s] as const))(
    "%s: the press exists, opens the confirmation, POSTs once, and the real usecase restarts the round and the panel reads it checking in again",
    async (_name, state) => {
      const r = await seedOnlineChessRound(state.seed);
      expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 }), "premise: the round opened").toMatchObject({ opened: true });
      const now = await state.build(r);
      const row = await readRow(r, now);

      // The premises are the REAL producer's words, not ours: no board checks in, so the row is in its playing phase, and the reader still
      // names the restart for the round on screen.
      expect(row.phase, "the phase is playing").toBe("playing");
      expect(row.round, "the loader found the round").not.toBeNull();
      expect(row.round!.boards.map((b) => b.state.kind), "every board paints a result (the re-armed one too)").toEqual(row.round!.boards.map(() => "result"));
      expect(row.view?.press, "the reader names the re-open").toBe("reopen");

      const onChanged = vi.fn();
      const ui = renderIsland(RoundFocus, props(row, now.getTime(), onChanged));
      const before = markup(props(row, now.getTime(), onChanged));
      expect(before).toContain('data-state="playing"');
      expect(before, "no hero: nothing is checking in").not.toContain('data-testid="arbiter-checkin-hero"');

      // The status card says where EVERY board is: the re-armed board has no result, so it is WAITING TO RESTART CHECK-IN and not finished, and
      // the printed counts add up to the boards the seed built (each one but the re-armed one decided on the pad). The expected numbers are the
      // seed's, never read back from `playingTally`.
      const built = state.seed.fixtures;
      const decided = built - 1;
      expect(row.round!.boards, "anti-vacuity: every seeded board is on screen").toHaveLength(built);
      expect(said(before, "arbiter-column-playing")).toBe(words("arbiter.column.playing", built, { count: 0, total: built }));
      expect(said(before, "arbiter-column-finished"), "only the decided boards are finished").toBe(decided === 0 ? null : words("arbiter.column.finished", decided));
      expect(said(before, "arbiter-column-reopen-waiting"), "the re-armed board waits").toBe(words("arbiter.column.waitingToRestart", 1));
      expect(said(before, "arbiter-column-onhold")).toBeNull();
      const num = (id: string) => (said(before, id) === null ? 0 : Number(/^\d+/.exec(said(before, id)!)![0]));
      expect(
        num("arbiter-column-playing") + num("arbiter-column-finished") + num("arbiter-column-onhold") + num("arbiter-column-reopen-waiting"),
        "playing + finished + held + waiting = the boards built",
      ).toBe(built);

      // The press exists, once, in the status card, with the reopen words.
      const buttons = byTestid(ui.tree(), "arbiter-column-reinvite");
      expect(buttons, "one press in the panel").toHaveLength(1);
      expect(/<button\b[^>]*data-testid="arbiter-column-reinvite"[^>]*>([^<]*)</.exec(before)?.[1]).toBe(EN["arbiter.column.reopenCta"]);

      // It ASKS: the confirmation opens through the panel's own handle, and nothing is sent.
      const dialogs = () => [...new Set(ui.tree().filter((e) => e.type === ConfirmDialog))];
      expect(dialogs().map((d) => propsOf(d).open), "closed until asked").toEqual([false]);
      (propsOf(buttons[0]!).onClick as () => void)();
      expect(net.calls, "asking sends nothing").toHaveLength(0);
      expect(propsOf(dialogs()[0]!).open, "the confirmation is open").toBe(true);

      // The confirm POSTs once; a second tap while it is out sends nothing more.
      const stampBefore = await openedAt(r.stageId);
      const auditBefore = await auditTypes(r.competitionId);
      (propsOf(dialogs()[0]!).onConfirm as () => void)();
      (propsOf(dialogs()[0]!).onConfirm as () => void)();
      expect(net.calls.map((c) => [c.url, c.json]), "ONE request, for this stage and this round").toEqual([[`/api/v1/stages/${r.stageId}/open-round`, { roundNo: 1 }]]);

      // The server's answer to THAT request: the real usecase, pressed with what the button sent.
      const sent = net.calls[0]!;
      const body = sent.json as { roundNo: number };
      const answer = await openRound({ stageId: r.stageId, roundNo: body.roundNo, actorUserId: r.ownerUserId }, { now });
      expect(answer, "the restart invites the re-armed board's two players").toMatchObject({ opened: true, invited: 2 });
      sent.resolve(answer);
      await flush();
      expect(onChanged, "the shell is asked to read the day again, once").toHaveBeenCalledTimes(1);

      // The branch the reader predicted is the branch the rows show: the window restarted and the audit event says so.
      expect(await openedAt(r.stageId), "the window moved").not.toBe(stampBefore);
      expect((await auditTypes(r.competitionId)).slice(auditBefore.length), "one event, a re-open").toEqual(["external_play.round_reopened"]);

      // The poll, read again after the refresh: the re-armed board checks in, so the row is CHECK-IN again; the panel (the same mounted one, so the
      // press's answer survived the phase change) draws the hero, no waiting line, and nobody is owed, so the press itself is gone.
      const afterRow = await readRow(r, new Date(now.getTime() + MIN));
      expect(afterRow.phase, "the round is checking in again").toBe("checkin");
      ui.rerender(props(afterRow, now.getTime() + MIN, onChanged));
      const h = markup(props(afterRow, now.getTime() + MIN, onChanged));
      expect(h).toContain('data-state="checkin"');
      expect(h).not.toContain('data-testid="arbiter-column-reinvite"');
      expect(h, "checking in again: the board is not waiting to restart any more").not.toContain('data-testid="arbiter-column-reopen-waiting"');
      ui.unmount();
    },
  );

  it("the empty pair: a game MAY be on file (a create marker), so the reader names nothing and the playing status draws no press", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 });
    await decide(r, r.boards[1]!);
    await noResultThenVoid(r, r.boards[0]!.fixtureId);
    // A labelled SQL move: no product path writes a create marker onto a closed row.
    await sql`update fixture_external_play set create_sent_at = now() - interval '30 minutes' where fixture_id = ${r.boards[0]!.fixtureId}`;
    const row = await readRow(r, CLOSED);
    expect(row.phase, "premise: still the playing phase").toBe("playing");
    expect(row.view?.press ?? "none", "the reader names no press").toBe("none");
    const h = markup(props(row, CLOSED.getTime(), () => {}));
    expect(h).toContain('data-state="playing"');
    expect(h).not.toContain('data-testid="arbiter-column-reinvite"');
    expect(h).not.toContain('data-testid="arbiter-column-reinvite-dialog"');
    // The reader names no press, so there is nothing the card could say a board waits for.
    expect(h).not.toContain('data-testid="arbiter-column-reopen-waiting"');
  });
});
