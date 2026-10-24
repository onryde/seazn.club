// Final review I-1 - the inert seam, proved closed from the PRODUCER's side. `listOpenRounds` has computed
// `OpenRoundView.batches` since the capacity build and its own test pins the numbers; the control used to read
// `batches.length` and nothing else, so the organiser never saw a group. A fixture handed to the consumer proves the
// fixture (AGENTS.md class 1), so this drives the REAL chain: a round seeded through the product's producers, opened by
// `openRound`, read by `listOpenRounds` (the Arbiter Panel's page hands exactly that value to the column), carried across
// the server -> client boundary as plain JSON, and drawn by the round column's `CheckinHero`. Phase 2 (spec
// 2026-10-24-arbiter-round-column-design.md §8) moved the round control from the Fixtures tab into that column, so the
// consumer under test is the column's hero; the premise (the groups are drawn, from the view the producer made) is unchanged.
//
// Every expected value comes from the rows on file (`fixtures`, `stage_round_opens`) and the window constants - never
// from the view or the component under test. Single-sport by construction: online play exists only for `boardgame`.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { ArbiterRound } from "@/lib/arbiter-view";
import type { Dict } from "@/lib/i18n-constants";
import { sql } from "@/lib/db";
import { fmtTime } from "@/lib/format";
import { messages } from "@/lib/messages";
import type { OpenRoundView } from "@/lib/open-round";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS } from "@/server/external-play/window";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// The email seam, as open-round-view.test.ts: the invite goes through the email outbox and its replaced transport.
const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});
beforeEach(() => stubOutboxEnv());

import { openRound } from "@/server/usecases/external-play/open-round";
import { listOpenRounds } from "@/server/usecases/external-play/open-round-view";
import { seedOnlineChessRoundWithRankedBoard } from "@/server/usecases/__tests__/_external-play-seed";
import { CheckinHero } from "../../arbiter/round-column";
import { initialOpenRoundUi } from "../open-round-state";
import type { OpenRoundHandle } from "../use-open-round";

const HAS_DB = !!process.env.DATABASE_URL;
const en = messages as unknown as Record<string, string>;
const TZ = "Europe/London";
const S = CHECKIN_BATCH_SIZE;
const T0 = new Date("2026-10-16T19:04:00.000Z");
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const t = (key: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Seeded = Awaited<ReturnType<typeof seedOnlineChessRoundWithRankedBoard>>;

/** The handle the panel shares for the round on screen: nothing is pressed in this test, so every press is a no-op. */
const HANDLE: OpenRoundHandle = { state: initialOpenRoundUi(), ask: () => {}, cancel: () => {}, open: () => {}, resend: () => {} };

/** The page's own hand-off: the view for the division, as plain data across the server -> client boundary, then the column's
 *  check-in hero drawing it (the hero is what the Arbiter Panel mounts for a round that is open; no boards on screen needed). */
async function drawn(r: Seeded, now: Date): Promise<{ view: OpenRoundView; html: string }> {
  const views = await listOpenRounds(r.owner, r.divisionId, { now });
  const hit = views.filter((v) => v.roundNo === 1);
  expect(hit, "round 1 is listed once").toHaveLength(1);
  const view = JSON.parse(JSON.stringify(hit[0]!)) as OpenRoundView;
  const round: ArbiterRound = { stageId: r.stageId, stageName: view.stageName, roundNo: 1, timeControl: null, boards: [], ownBoards: 0, current: true, extendableBoards: 0 };
  const html = renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <CheckinHero round={round} view={view} tz={TZ} nowMs={now.getTime()} openRound={HANDLE} roundExtend={null} />
    </DictProvider>,
  );
  return { view, html };
}

const rowsOf = (h: string) =>
  [...h.matchAll(/<li([^>]*data-testid="arbiter-column-batch-(\d+)"[^>]*)>(.*?)<\/li>/gs)].map((m) => {
    const field = (name: string) => new RegExp(`data-field="${name}"[^>]*>([^<]*)<`).exec(m[3]!)?.[1];
    return { i: Number(m[2]), boards: field("boards"), opens: field("opens"), closes: field("closes") };
  });

/** What the rows on file say the groups are: board ranges by RANK among every row of the round (the rule in spec
 *  §3.2.1), opening i gaps after the stamp the open wrote, closing a window later. */
async function groupsOnFile(r: Seeded) {
  const fixtures = await sql<{ seq: number }[]>`
    select seq_in_round as seq from fixtures where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round, id`;
  const [open] = await sql<{ openedAt: Date }[]>`
    select opened_at as "openedAt" from stage_round_opens where stage_id = ${r.stageId} and round_no = 1`;
  const out: { from: number; to: number; opens: Date; closes: Date }[] = [];
  for (let i = 0; i * S < fixtures.length; i++) {
    const slice = fixtures.slice(i * S, (i + 1) * S);
    const opens = new Date(open!.openedAt.getTime() + i * CHECKIN_BATCH_GAP_MS);
    out.push({ from: slice[0]!.seq, to: slice[slice.length - 1]!.seq, opens, closes: new Date(opens.getTime() + DEADLINE_AFTER_MS) });
  }
  return out;
}

describe.skipIf(!HAS_DB)("the organiser's check-in groups, through the real producer (final review I-1)", () => {
  it("a staggered round the server opened: the column draws one row per group on file, each with its own boards, opening and closing", async () => {
    // Rows 1..2S+1: board 1, 2S-1 withdrawn rows, then one real board - groups of S, S and 1 by rank.
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
    await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 });
    const want = await groupsOnFile(r);
    expect(want.length, "premise: three groups on file").toBe(3);
    const { view, html } = await drawn(r, new Date(T0.getTime() + 60_000));
    expect(view.batches.length, "the view really carries the groups the column must draw").toBe(want.length);

    const rows = rowsOf(html);
    expect(rows, "one drawn row per group on file").toHaveLength(want.length);
    let checked = 0;
    want.forEach((g, i) => {
      expect(rows[i]!.i).toBe(i);
      expect(rows[i]!.boards, `group ${i} boards`).toBe(
        esc(g.from === g.to ? t("arbiter.boardNo", { n: g.from }) : t("arbiter.column.batchBoards", { from: g.from, to: g.to })),
      );
      expect(rows[i]!.opens, `group ${i} opens`).toBe(esc(t("runsheet.round.batchOpens", { time: fmtTime(TZ, g.opens) })));
      expect(rows[i]!.closes, `group ${i} closes`).toBe(esc(t("runsheet.round.batchCloses", { time: fmtTime(TZ, g.closes) })));
      checked += 1;
    });
    expect(checked, "anti-vacuity: groups checked").toBe(3);
    // The point of the finding: group 0 closes BEFORE the last group does, and the column says so (two different closing times
    // are on the page, not the one deadline of the last group).
    expect(want[0]!.closes.getTime(), "premise: group 0's no-shows reach the organiser before the last group closes").toBeLessThan(want[2]!.closes.getTime());
    expect(new Set(rows.map((x) => x.closes)).size, "the three groups do not all close together").toBe(3);
    expect(html, "the hero around the groups is mounted").toContain('data-testid="arbiter-checkin-hero"');
  });

  it("the pair: a round that does not stagger (camera off) draws no groups - the same producer, the same hero, one window for the whole round", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "off" }, 2 * S);
    await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T0 });
    const { view, html } = await drawn(r, new Date(T0.getTime() + 60_000));
    expect(view.staggered, "premise: the open stored 'one batch'").toBe(false);
    expect(rowsOf(html)).toEqual([]);
    expect(html).not.toContain('data-testid="arbiter-column-batches"');
    // Positive pair: the hero IS drawn (so the absence above is the groups', not a render that drew nothing), and the view's one
    // deadline is the round's open + the window on file.
    expect(html).toContain('data-testid="arbiter-checkin-hero"');
    expect(view.deadlineAt, "the one deadline the whole round shares").toBe(new Date(T0.getTime() + DEADLINE_AFTER_MS).toISOString());
  });

  it("before the press nothing is scheduled, so a staggered round draws no groups yet (its span is in the confirmation)", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
    const { view, html } = await drawn(r, T0);
    expect([view.state, view.staggered, view.batches.length]).toEqual(["paired", true, 3]);
    expect(rowsOf(html)).toEqual([]);
  });
});
