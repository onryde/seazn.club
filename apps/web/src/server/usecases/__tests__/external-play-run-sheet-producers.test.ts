// T16 fix round 1, M10 — a fair-play ending reaches the run sheet's held chip from its REAL producer: Lichess's
// `cheat` snapshot through the result writer (`writeResultFrom` — the one reconcile and the sweep both call), then the
// run sheet's reader, then the row itself. No stand-in row: the bridge's reason is the writer's, and the row is
// handed exactly what the reader returned. (The connection-problems flag's producer is the sweep, whose lock is
// global: its producer → reader → row path lives in external-play-sweep.test.ts.)
//
// Single-sport by construction: only a boardgame division plays online.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { messages } from "@/lib/messages";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import type { GameSnapshot } from "@/server/external-play/types";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { queueRowAnchor } from "@/components/v2/external-play-held-copy";
import { listNeedsOrganiserExternalPlay } from "../external-play/queue";
import { writeResultFrom } from "../external-play/result";
import { listRunSheetOnlinePlay } from "../external-play/run-sheet";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "./_external-play-seed";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** A round-1 board whose round is open, with its Lichess game being played (white = home). */
async function liveBoard(): Promise<{ r: SeedOnlineChessRoundResult; fixtureId: string; gameId: string }> {
  const r = await seedOnlineChessRound({ fixtures: 1, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
    values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
  const b = r.boards[0]!;
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
    values (${b.fixtureId}, ${r.orgId}, 'live', now() - interval '5 minutes', ${gameId}, 'home', ${b.home.lichessId}, ${b.away.lichessId})`;
  return { r, fixtureId: b.fixtureId, gameId };
}

const snapshot = (gameId: string, over: Partial<GameSnapshot>): GameSnapshot =>
  ({ gameId, status: "mate", winner: "white", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0, ...over }) as GameSnapshot;

/** The row as the division page's run sheet mounts it, handed the reader's own entry for this board. */
async function rowFor(r: SeedOnlineChessRoundResult, fixtureId: string, panelOffered = true) {
  const entry = (await listRunSheetOnlinePlay(r.owner, r.divisionId))[fixtureId];
  const [fx] = await sql<{ status: RunSheetFixture["status"]; home_entrant_id: string; away_entrant_id: string; outcome: RunSheetFixture["outcome"] }[]>`
    select status, home_entrant_id, away_entrant_id, outcome from fixtures where id = ${fixtureId}`;
  const fixture: RunSheetFixture = {
    id: fixtureId, stage_id: r.stageId, fixture_no: 1, round_no: 1, seq_in_round: 1,
    scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(), status: fx!.status, court_name: null, court_id: null,
    venue_name: null, officials: [], outcome: fx!.outcome, home_entrant_id: fx!.home_entrant_id, away_entrant_id: fx!.away_entrant_id,
    home_slot_label: null, away_slot_label: null, lane: null, is_final: false, third_place: false, conditional: false, ext_key: null,
  };
  const tree = renderIsland(RunSheetRow, {
    fixture,
    href: `/o/org/c/comp/d/div/f/1`,
    tz: "UTC",
    orgTz: "UTC",
    nowMs: Date.now(),
    canEdit: true,
    entrantNames: { [fx!.home_entrant_id]: "Ada Okonkwo", [fx!.away_entrant_id]: "Tomasz Wieczorek" },
    onlinePlay: entry,
    // The page hands the per-fixture panel link only where it offers the panel (`arbiterHrefFor`); otherwise nothing.
    arbiterHref: panelOffered ? `/o/org/c/comp/d/div/arbiter?fixture=${fixtureId}` : undefined,
  }).tree();
  const heldChips = [...new Set(tree.filter((el) => propsOf(el)["data-testid"] === "run-sheet-online-held-chip"))];
  return { entry, heldChips };
}

describe.runIf(HAS_DB)("a fair-play ending reaches the run sheet from its real producer (M10)", () => {
  it("the other direction first: a game Lichess ended by mate is decided — no hold, no held chip", async () => {
    const { r, fixtureId, gameId } = await liveBoard();
    expect(await writeResultFrom(snapshot(gameId, { status: "mate", winner: "white" }), fixtureId)).toEqual({ wrote: "decided" });
    const { entry, heldChips } = await rowFor(r, fixtureId);
    expect(entry?.held, "the reader: not held").toBeNull();
    expect(heldChips, "the row: no held chip").toHaveLength(0);
  });

  it("Lichess's `cheat` ending: held under fair_play by the writer, listed by the queue, and the row's 'Needs a decision' chip leads to its card - in the panel when it is offered, in the tab's queue when not", async () => {
    const { r, fixtureId, gameId } = await liveBoard();
    expect(await writeResultFrom(snapshot(gameId, { status: "cheat", winner: "black" }), fixtureId)).toEqual({
      wrote: "needs_organiser",
      reason: "fair_play",
    });
    expect((await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).map((q) => [q.fixtureId, q.reason]), "the queue").toEqual([
      [fixtureId, "fair_play"],
    ]);
    const { entry, heldChips } = await rowFor(r, fixtureId);
    expect(entry?.held, "the reader").toBe("fair_play");
    expect(heldChips, "the row: one held chip").toHaveLength(1);
    expect(propsOf(heldChips[0]!)["data-reason"]).toBe("fair_play");
    expect(propsOf(heldChips[0]!).href, "offered: the panel opened on this board, not an anchor nothing on the tab carries").toBe(
      `/o/org/c/comp/d/div/arbiter?fixture=${fixtureId}`,
    );
    expect(textOf(heldChips[0]!)).toBe(messages["score.status.needs_decision"]);
    // The pair: no panel offered -> the queue is on the tab, and the chip scrolls to this board's card in it.
    const bare = await rowFor(r, fixtureId, false);
    expect(bare.heldChips, "not offered: the same row, one held chip").toHaveLength(1);
    expect(propsOf(bare.heldChips[0]!).href).toBe(`#${queueRowAnchor(fixtureId)}`);
  });
});
