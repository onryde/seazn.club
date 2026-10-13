// T16 — the organiser's two decisions on an online board (chess design D10,
// §3.6, §7; controller ruling 2026-10-12):
//   - resolveExternalPlay: "Settle the result" (queue) / "Settle the result
//     now…" (arbiter panel). Written under the CALLER's authority, so the
//     ledger's recorded_by is the audit;
//   - closeExternalPlayFlags: "Let the game go on" — closes exactly the flags
//     the organiser was shown; the closed row (closed_at, resolved_by) is the
//     audit.
//
// Holds come from their real producers (holdForOrganiser, holdRefusedNoShow —
// the sweep's and reconcile's own writers), and the board's state is read
// back through the consumers the organiser sees (the queue reader, the
// arbiter panel's loader). Flag rows here are SQL stand-ins for the
// producers: reconcile's out_of_band_play and the sweep's camera producers
// are driven for real in their own suites (external-play-reconcile.test.ts,
// external-play-sweep.test.ts, "T16" cases). Single-sport by construction:
// online play exists only for `boardgame` (guard.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, foldMatch, playRecorded } from "@seazn/engine/core";
import type { StandingsRow } from "@seazn/engine/competition";
import { boardgame } from "@seazn/engine/sports/boardgame";
import EN from "@/dictionaries/en/ui.json";
import FR from "@/dictionaries/fr/ui.json";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recomputeStandings } from "@/server/engine-db/competition";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { loadDivisionWatch, loadPublicExternalPlay } from "../external-play-read";
import { loadArbiterRound } from "../external-play/arbiter";
import { closeExternalPlayFlags } from "../external-play/flags";
import { listNeedsOrganiserExternalPlay } from "../external-play/queue";
import { RESOLVE_KINDS, resolveExternalPlay, type ResolveKind } from "../external-play/resolve";
import { HOLD_REASONS, holdForOrganiser, holdOwedTiebreak, holdRefusedNoShow, tiebreakIsPending, type HoldReason } from "../external-play/result";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { makeUser } from "./_seed";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return [err.status, err.code ?? ""];
    throw err;
  }
  throw new Error("expected a refusal");
}

async function round(opts: { fixtures?: number; knockout?: boolean } = {}): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures: opts.fixtures ?? 1, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  // The stage kind before any event: the fixture's cfg freezes at its FIRST
  // event, carrying a bracket's decider exactly as a bracket fixture does
  // (external-play-result.test.ts's readyGame does the same).
  if (opts.knockout) await sql`update stages set kind = 'knockout' where id = ${r.stageId}`;
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
    values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
  return r;
}

/** A bridge row with no game yet, as the open's invite leaves it. */
async function pendingBridge(r: SeedOnlineChessRoundResult, b: SeedRoundBoard) {
  await sql`
    insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
    values (${b.fixtureId}, ${r.orgId}, 'pending', now() - interval '5 minutes')`;
}

/** A game on file, as T9's writer leaves it (home White unless said). */
async function gameBridge(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, status: "ready" | "live" = "live") {
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
    values (${b.fixtureId}, ${r.orgId}, ${status}, now() - interval '5 minutes', ${`gm-${randomUUID().slice(0, 12)}`},
            'home', ${b.home.lichessId}, ${b.away.lichessId})`;
}

async function bridgeOf(fixtureId: string) {
  const [row] = await sql<{ status: string; needs_reason: string | null; revoked_seat: string | null; finished_at: Date | null }[]>`
    select status, needs_reason, revoked_seat, finished_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return row;
}

async function fixtureOf(fixtureId: string) {
  const [row] = await sql<{ status: string; outcome: Record<string, unknown> | null }[]>`
    select status, outcome from fixtures where id = ${fixtureId}`;
  return row!;
}

async function ledgerOf(fixtureId: string) {
  return sql<{ id: string; type: string; payload: Record<string, unknown>; recorded_by: string | null; voids_event_id: string | null }[]>`
    select id, type, payload, recorded_by, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
}

/** The engine's own ruling-112/118 fact over a stored ledger: has anything been PLAYED (chess: an active Start). */
function played(ledger: Awaited<ReturnType<typeof ledgerOf>>): boolean {
  return playRecorded(ledger.map((e) => ({ id: e.id, type: e.type, voids: e.voids_event_id })), boardgame);
}

/** The engine's own fold of ONE event on a fresh board (home White): what a ledger holding just it decides, and the
 *  summary the public header reads. The expected values below come from here, never from resolve.ts. */
function engineFold(b: SeedRoundBoard, type: string, payload: unknown) {
  const state = foldMatch(
    boardgame,
    boardgame.configSchema.parse({}),
    { home: { entrantId: b.home.entrantId, slots: [] }, away: { entrantId: b.away.entrantId, slots: [] } },
    [{ id: "e0", fixtureId: b.fixtureId, seq: 0, type, payload, recordedAt: "2026-10-13T10:00:00.000Z", recordedBy: null }],
  );
  return { outcome: boardgame.outcome(state), summary: boardgame.summary(state) };
}

/** A feed edge: a next match for this line's winner (a knockout line that is not a final). */
async function feedsNextMatch(r: SeedOnlineChessRoundResult, b: SeedRoundBoard): Promise<void> {
  const [next] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${r.stageId}, ${r.divisionId}, ${r.orgId}, 2, 1, ${`nx-${randomUUID().slice(0, 6)}`}, 'scheduled')
    returning id`;
  await sql`update fixtures set winner_to_fixture = ${next!.id} where id = ${b.fixtureId}`;
}

/** I-3 (controller ruling, fix round 2): the two holds where BOTH players stayed away. Their No result stays W2b's
 *  double walkover; every other hold's, and a board's with no hold, is VOID. Typed from the ruling, not resolve.ts. */
const BOTH_ABSENT: readonly NeedsReason[] = ["no_show_both", "double_walkover_blocked"];
const VOID_HOLDS: readonly (NeedsReason | null)[] = [...NEEDS_REASONS.filter((x) => !BOTH_ABSENT.includes(x)), null];

/** The abandon's reason as the DICTIONARY words it (`null`: a board settled with no hold), in one locale. */
function abandonReasonText(dict: Record<string, string>, hold: NeedsReason | null): string {
  const key = `externalPlay.resolve.abandonReason.${hold ?? "none"}`;
  const text = dict[key];
  expect(text, `${key}: the copy exists`).toBeTypeOf("string");
  expect(text!.length, `${key}: and says something`).toBeGreaterThan(0);
  return text!;
}

/** Hold `board` for the organiser with `reason` through its REAL producer where one takes it — holdForOrganiser's
 *  reasons, the sweep's no-show writer — and a stand-in row for the snapshot-only ones (aborted, mismatch, fair_play,
 *  tiebreak_owed: reconcile's and T12's, driven for real in their own suites). `null`: a game still being played. */
async function holdAs(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, reason: NeedsReason | null, opts: { bridgeExists?: true } = {}) {
  if (reason === null) return gameBridge(r, b, "live");
  if (!opts.bridgeExists) await pendingBridge(r, b);
  if ((HOLD_REASONS as readonly string[]).includes(reason)) {
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: reason as HoldReason, detail: "TEST" });
  } else if (reason === "no_show_white" || reason === "no_show_black" || reason === "no_show_both") {
    const absent = reason === "no_show_white" ? "white" : reason === "no_show_black" ? "black" : "both";
    await holdRefusedNoShow({ fixtureId: b.fixtureId, absent, detail: "sweep: refused 3 passes running (TEST)" });
  } else {
    await sql`
      update fixture_external_play set status = 'needs_organiser', needs_reason = ${reason}, last_error = 'TEST stand-in'
       where fixture_id = ${b.fixtureId}`;
  }
  expect(await bridgeOf(b.fixtureId), `premise: held ${reason}`).toMatchObject({ status: "needs_organiser", needs_reason: reason });
}

/** An organiser of the club who is ALSO a player on `board` (C1). */
async function seatedAdmin(r: SeedOnlineChessRoundResult, userId: string): Promise<AuthCtx> {
  await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${userId}, 'admin')`;
  return { ...r.owner, userId, role: "admin" } as AuthCtx;
}

async function flag(r: SeedOnlineChessRoundResult, fixtureId: string, kind = "out_of_band_play", personId: string | null = null) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
    values (${fixtureId}, ${r.orgId}, ${kind}, ${personId}, ${kind === "out_of_band_play" ? "plies 3-4 (e7e5 g1f3); camera not required (policy off)" : null})
    returning id`;
  return row!.id;
}

async function flagRows(fixtureId: string) {
  return sql<{ id: string; closed_at: Date | null; resolved_by: string | null }[]>`
    select id, closed_at, resolved_by from fixture_play_flags where fixture_id = ${fixtureId} order by opened_at, id`;
}

// ---------------------------------------------------------------------------
// resolveExternalPlay
// ---------------------------------------------------------------------------

describe("resolveExternalPlay — structure", () => {
  it("settling FINISHES play: never gated by the online-chess flag (T20) — the module never asks it", () => {
    const src = readFileSync(new URL("../external-play/resolve.ts", import.meta.url), "utf8");
    expect(src).not.toContain("online-chess-flag");
    expect(src).not.toContain("onlineChessOffered");
  });

  it("the four ways to settle are the canvas's four buttons, the empty-of-winner ones last", () => {
    expect([...RESOLVE_KINDS]).toEqual(["home_wins", "away_wins", "draw", "no_result"]);
  });
});

describe.runIf(HAS_DB)("resolveExternalPlay — a held board, settled", () => {
  // The shape each decision is written with, from the rulebook (FIDE Laws
  // Art. 6.7: a player absent at the start loses by default — a forfeit; any
  // other decision of the arbiter is an adjudication). Home is White here.
  // RB4 (W2b spec §5.2, D15): a default is `core.forfeit {by: the absent
  // loser, reason: "walkover"}` — the sweep's own no-show shape — with no
  // Start; an adjudication is a Start and `boardgame.result`.
  const cases: { hold: "no_show_white" | "no_show_black" | "no_show_both" | "not_started" | "token_revoked"; kind: "home_wins" | "away_wins"; written: "walkover" | "adjudication" }[] = [
    { hold: "no_show_black", kind: "home_wins", written: "walkover" }, // Black (away) stayed away and loses
    { hold: "no_show_black", kind: "away_wins", written: "adjudication" }, // the present player loses: a ruling
    { hold: "no_show_white", kind: "away_wins", written: "walkover" },
    { hold: "no_show_white", kind: "home_wins", written: "adjudication" },
    { hold: "no_show_both", kind: "home_wins", written: "walkover" },
    { hold: "not_started", kind: "away_wins", written: "adjudication" }, // both came: nobody defaulted
    { hold: "token_revoked", kind: "home_wins", written: "adjudication" },
  ];

  it("each hold × winner: the result, its method, the bridge closed, the queue emptied — and the ledger names who settled", async () => {
    let checked = 0;
    const shapes = new Set<string>();
    for (const c of cases) {
      const r = await round();
      const b = r.boards[0]!;
      await pendingBridge(r, b);
      if (c.hold === "no_show_white" || c.hold === "no_show_black" || c.hold === "no_show_both") {
        const absent = c.hold === "no_show_white" ? "white" : c.hold === "no_show_black" ? "black" : "both";
        await holdRefusedNoShow({ fixtureId: b.fixtureId, absent, detail: "sweep: refused 3 passes running (TEST)" });
      } else {
        await holdForOrganiser({ fixtureId: b.fixtureId, reason: c.hold });
      }
      const queued = await listNeedsOrganiserExternalPlay(r.owner, r.divisionId);
      expect(queued.map((q) => [q.fixtureId, q.reason]), `${c.hold}: premise, held`).toEqual([[b.fixtureId, c.hold]]);

      expect(await resolveExternalPlay(r.owner, b.fixtureId, c.kind), JSON.stringify(c)).toEqual({ status: "finished" });

      const winner = c.kind === "home_wins" ? b.home.entrantId : b.away.entrantId;
      const loser = c.kind === "home_wins" ? b.away.entrantId : b.home.entrantId;
      const ledger = await ledgerOf(b.fixtureId);
      const want: [string, unknown][] =
        c.written === "walkover"
          ? [["core.forfeit", { by: loser, reason: "walkover" }]]
          : [
              ["core.start", {}],
              ["boardgame.result", { winner, method: "adjudication" }],
            ];
      expect(ledger.map((e) => [e.type, e.payload]), JSON.stringify(c)).toEqual(want);
      shapes.add(ledger.map((e) => e.type).join("+"));
      expect(ledger.every((e) => e.recorded_by === r.ownerUserId), "the ledger names who settled").toBe(true);
      // The fixture's outcome is the engine's own fold of that ledger (a default is W2b's award; an adjudication a win).
      const state = foldMatch(
        boardgame,
        boardgame.configSchema.parse({}),
        { home: { entrantId: b.home.entrantId, slots: [] }, away: { entrantId: b.away.entrantId, slots: [] } },
        ledger.map((e, k) => ({ id: e.id, fixtureId: b.fixtureId, seq: k + 1, type: e.type, payload: e.payload, recordedAt: "2026-10-13T10:00:00.000Z", recordedBy: null })),
      );
      const f = await fixtureOf(b.fixtureId);
      expect(f.outcome, JSON.stringify(c)).toEqual(boardgame.outcome(state));
      expect(f.outcome, `${JSON.stringify(c)}: the winner`).toMatchObject({ winner });
      expect(f.status, JSON.stringify(c)).toBe(c.written === "walkover" ? "forfeited" : "decided");
      expect(await bridgeOf(b.fixtureId), JSON.stringify(c)).toMatchObject({ status: "finished", needs_reason: null, revoked_seat: null });
      expect(await listNeedsOrganiserExternalPlay(r.owner, r.divisionId), `${c.hold}: the queue no longer lists it`).toEqual([]);
      // What the organiser and the spectators read back: the engine's lines and method, home (White) first.
      const summary = boardgame.summary(state);
      const line = (entrant: string) => summary.perSide.find((p) => p.entrantId === entrant)!.line;
      const score = `${line(b.home.entrantId)}–${line(b.away.entrantId)}`;
      expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.state, JSON.stringify(c)).toEqual({ kind: "result", score, noResult: false });
      expect((await loadPublicExternalPlay(b.fixtureId))?.result, JSON.stringify(c)).toMatchObject({
        kind: "win",
        winner: c.kind === "home_wins" ? "home" : "away",
        method: (summary.detail as { method?: string }).method,
        score,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: hold × winner cases").toBe(cases.length);
    expect([...shapes].sort(), "both shapes were written").toEqual(["core.forfeit", "core.start+boardgame.result"]);
  });

  it("Draw ⇒ a draw by adjudication — in a league", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "provider_error", detail: "lichess 502 (TEST)" });
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "draw")).toEqual({ status: "finished" });
    expect((await fixtureOf(b.fixtureId)).outcome).toMatchObject({ kind: "draw" });
    expect((await ledgerOf(b.fixtureId)).at(-1)?.payload).toEqual({ winner: null, method: "adjudication" });
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "finished", needs_reason: null });
  });

  it("I-3: No result on every hold but the two both-absent ones — and on a board still being played — is VOID: `core.abandon` with the hold's reason in plain words, no Start; the fixture abandoned with no outcome; the chess readers say No result", async () => {
    // Controller ruling I-3 (fix round 2): "No result" is VOID — no points, no absence. BOTH_ABSENT and the reason copy
    // come from the ruling and the dictionary, never from resolve.ts.
    let checked = 0;
    for (const hold of VOID_HOLDS) {
      const r = await round();
      const b = r.boards[0]!;
      await holdAs(r, b, hold);
      const text = abandonReasonText(EN, hold);
      expect(played(await ledgerOf(b.fixtureId)), `${hold}: premise, nothing played`).toBe(false);

      expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result"), String(hold)).toEqual({ status: "finished" });

      const ledger = await ledgerOf(b.fixtureId);
      expect(ledger.map((e) => [e.type, e.payload]), `${hold}: one abandon, no Start`).toEqual([["core.abandon", { reason: text }]]);
      expect(ledger[0]!.recorded_by, "the ledger names who settled").toBe(r.ownerUserId);
      expect(played(ledger), `${hold}: still nothing played`).toBe(false);
      expect(engineFold(b, "core.abandon", { reason: text }).outcome, "premise: the engine's fold of an abandon decides nobody").toBeNull();
      expect(await fixtureOf(b.fixtureId), String(hold)).toEqual({ status: "abandoned", outcome: null });
      expect(await bridgeOf(b.fixtureId), String(hold)).toMatchObject({ status: "finished", needs_reason: null });
      expect(await listNeedsOrganiserExternalPlay(r.owner, r.divisionId), `${hold}: not the queue's any more`).toEqual([]);
      // The chess-owned readers: the spectators' header and the arbiter panel say No result, with no score.
      expect((await loadPublicExternalPlay(b.fixtureId))?.result, `${hold}: the public header`).toMatchObject({ kind: "no_result", winner: null, method: null, score: "" });
      expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.state, `${hold}: the panel`).toEqual({ kind: "result", score: null, noResult: true });
      checked += 1;
    }
    // Anti-vacuity: every hold reason but the two both-absent ones, plus the no-hold board.
    expect(checked).toBe(NEEDS_REASONS.length - BOTH_ABSENT.length + 1);
  });

  it("I-3: the division Fixtures list's link for a VOID board with moves on file is its final position saying No result — through the real list reader; a decided board beside it keeps its score", async () => {
    const r = await round({ fixtures: 2 });
    const [voided, won] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    for (const b of [voided, won]) {
      await gameBridge(r, b, "live");
      await sql`update fixture_external_play set moves_uci = ${["e2e4", "e7e5"]}, move_count = 2 where fixture_id = ${b.fixtureId}`;
    }
    await resolveExternalPlay(r.owner, voided.fixtureId, "no_result");
    await resolveExternalPlay(r.owner, won.fixtureId, "home_wins");
    const { links } = await loadDivisionWatch(r.divisionId);
    expect(links[voided.fixtureId]).toEqual({ kind: "final", score: "", noResult: true });
    expect(links[won.fixtureId]).toMatchObject({ kind: "final", noResult: false });
    expect((links[won.fixtureId] as { score: string }).score, "the pair: a decided board keeps its score").not.toBe("");
  });

  it("I-3: the abandon's reason is stored in the club's own language (its default locale), as the public 'Abandoned (…)' prints it", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await sql`update organizations set default_locale = 'fr' where id = ${r.orgId}`;
    await holdAs(r, b, "not_started");
    const fr = abandonReasonText(FR, "not_started");
    expect(fr, "premise: the differential — French copy, not the English").not.toBe(abandonReasonText(EN, "not_started"));
    await resolveExternalPlay(r.owner, b.fixtureId, "no_result");
    expect((await ledgerOf(b.fixtureId)).map((e) => e.payload)).toEqual([{ reason: fr }]);
  });

  it("I-3 both absent (no_show_both, double_walkover_blocked): No result stays W2b's double walkover — `core.forfeit {by: both, reason: walkover}`, no Start — read by the panel as the engine's own lines", async () => {
    let checked = 0;
    for (const hold of BOTH_ABSENT) {
      const r = await round();
      const b = r.boards[0]!;
      await holdAs(r, b, hold);
      expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result"), hold).toEqual({ status: "finished" });
      const ledger = await ledgerOf(b.fixtureId);
      expect(ledger.map((e) => [e.type, e.payload]), `${hold}: one forfeit, no Start`).toEqual([["core.forfeit", { by: "both", reason: "walkover" }]]);
      const fold = engineFold(b, "core.forfeit", { by: "both", reason: "walkover" });
      expect(fold.outcome, "premise: the engine folds a double walkover").toEqual({ kind: "double_walkover" });
      expect(await fixtureOf(b.fixtureId), hold).toEqual({ status: "forfeited", outcome: fold.outcome });
      expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "finished", needs_reason: null });
      const lines = fold.summary.perSide;
      const line = (entrant: string) => lines.find((l) => l.entrantId === entrant)!.line;
      expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.state, `${hold}: the panel`).toEqual({
        kind: "result",
        score: `${line(b.home.entrantId)}–${line(b.away.entrantId)}`,
        noResult: false,
      });
      expect((await loadPublicExternalPlay(b.fixtureId))?.result, `${hold}: the public header`).toMatchObject({
        kind: "no_result",
        method: (fold.summary.detail as { method?: string }).method,
      });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I-3 after the Start (play recorded): the abandon keeps the Start — the board still reads as played, which is true — and decides nobody; a league and a Swiss board alike", async () => {
    let checked = 0;
    for (const kind of ["league", "swiss"] as const) {
      const r = await round();
      if (kind === "swiss") await sql`update stages set kind = 'swiss' where id = ${r.stageId}`;
      const b = r.boards[0]!;
      await gameBridge(r, b, "live");
      await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      expect(played(await ledgerOf(b.fixtureId)), `${kind}: premise, play is recorded`).toBe(true);
      // A fair-play hold arrives after the Start (reconcile's snapshot-only reason; a stand-in row, see holdAs).
      await holdAs(r, b, "fair_play", { bridgeExists: true });

      expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result"), kind).toEqual({ status: "finished" });

      const ledger = await ledgerOf(b.fixtureId);
      expect(ledger.map((e) => [e.type, e.payload]), kind).toEqual([
        ["core.start", {}],
        ["core.abandon", { reason: abandonReasonText(EN, "fair_play") }],
      ]);
      expect(played(ledger), `${kind}: the Start stands`).toBe(true);
      expect(await fixtureOf(b.fixtureId), kind).toEqual({ status: "abandoned", outcome: null });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I-3 standings: a VOID board leaves both players' rows untouched — 0 played, 0 points; a double walkover charges each a game played and lost; a win scores — each from the engine's own declarations", async () => {
    const r = await round({ fixtures: 3 });
    const [voided, walkedOver, won] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await holdAs(r, voided, "not_started");
    await holdAs(r, walkedOver, "no_show_both");
    await holdAs(r, won, "not_started");
    const rowsOf = async () => new Map((await recomputeStandings(r.orgId, r.stageId)).map((row) => [row.entrantId, row]));
    const before = await rowsOf();
    expect(before.size, "premise: every entrant has a row").toBe(6);

    await resolveExternalPlay(r.owner, voided.fixtureId, "no_result");
    await resolveExternalPlay(r.owner, walkedOver.fixtureId, "no_result");
    await resolveExternalPlay(r.owner, won.fixtureId, "home_wins");
    const after = await rowsOf();

    const pick = (row: StandingsRow | undefined) => row && { played: row.played, won: row.won, drawn: row.drawn, lost: row.lost, points: row.points };
    const [divRow] = await sql<{ config: unknown }[]>`select config from divisions where id = ${r.divisionId}`;
    const cfg = boardgame.configSchema.parse(divRow!.config);
    let checked = 0;
    // VOID: the engine folds an abandon to no outcome, and the table scores only outcomes — the rows do not move.
    for (const e of [voided.home.entrantId, voided.away.entrantId]) {
      expect(pick(after.get(e)), "the void board's player").toEqual(pick(before.get(e)));
      expect(pick(after.get(e))).toEqual({ played: 0, won: 0, drawn: 0, lost: 0, points: 0 });
      checked += 1;
    }
    // The double walkover and the win: the engine's own standingsDelta for the engine's own fold.
    const deltaOf = (b: SeedRoundBoard, type: string, payload: unknown) => {
      const state = foldMatch(
        boardgame,
        cfg,
        { home: { entrantId: b.home.entrantId, slots: [] }, away: { entrantId: b.away.entrantId, slots: [] } },
        [{ id: "e0", fixtureId: b.fixtureId, seq: 0, type, payload, recordedAt: "2026-10-13T10:00:00.000Z", recordedBy: null }],
      );
      return boardgame.standingsDelta(boardgame.outcome(state)!, cfg, { kind: "league" }, state);
    };
    const dw = deltaOf(walkedOver, "core.forfeit", { by: "both", reason: "walkover" });
    const win = deltaOf(won, "core.forfeit", { by: won.away.entrantId, reason: "walkover" });
    for (const d of [...dw, ...win]) {
      expect(pick(after.get(d.entrantId)), d.entrantId).toEqual({ played: d.played, won: d.won, drawn: d.drawn, lost: d.lost, points: d.points });
      checked += 1;
    }
    expect(dw.map((d) => [d.played, d.lost, d.points]), "premise: a double walkover is a game played and lost, at 0 points").toEqual([[1, 1, 0], [1, 1, 0]]);
    expect(win[0]!.points, "premise: the positive pair — a win scores").toBeGreaterThan(0);
    expect(checked).toBe(6);
  });

  it("a second settle is refused ALREADY_RESOLVED, and writes nothing — whatever it asks for", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    await resolveExternalPlay(r.owner, b.fixtureId, "home_wins");
    const before = await ledgerOf(b.fixtureId);
    let checked = 0;
    for (const kind of RESOLVE_KINDS) {
      expect(await codeOf(resolveExternalPlay(r.owner, b.fixtureId, kind)), kind).toEqual([409, "ALREADY_RESOLVED"]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every kind re-tried").toBe(RESOLVE_KINDS.length);
    expect(await ledgerOf(b.fixtureId)).toEqual(before);
  });

  it("a board settled ELSEWHERE (a result by hand) while still held: refused, and its stale bridge closed so the queue agrees", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.away.entrantId, method: "resign" } });
    expect((await bridgeOf(b.fixtureId))?.status, "premise: still held").toBe("needs_organiser");
    expect(await codeOf(resolveExternalPlay(r.owner, b.fixtureId, "home_wins"))).toEqual([409, "ALREADY_RESOLVED"]);
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "finished", needs_reason: null });
    expect((await fixtureOf(b.fixtureId)).outcome, "the hand result stands").toMatchObject({ winner: b.away.entrantId, method: "resign" });
  });
});

describe.runIf(HAS_DB)("resolveExternalPlay — a board still being played (the arbiter's 'Settle the result now…')", () => {
  it("a live game, nothing held: settled by adjudication — fold in `pre` and fold `live` alike", async () => {
    let checked = 0;
    for (const started of [false, true]) {
      const r = await round();
      const b = r.boards[0]!;
      await gameBridge(r, b, "live");
      if (started) await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      expect(await resolveExternalPlay(r.owner, b.fixtureId, "away_wins")).toEqual({ status: "finished" });
      expect((await fixtureOf(b.fixtureId)).outcome, `started=${started}`).toMatchObject({ kind: "win", winner: b.away.entrantId, method: "adjudication" });
      expect((await ledgerOf(b.fixtureId)).map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
      expect((await bridgeOf(b.fixtureId))?.status).toBe("finished");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the panel's loader reads the settled board as a result, no longer playable", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b, "live");
    const before = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect(before.playable, "premise").toBe(true);
    expect(before.canSettle, "the panel offers the settle").toBe(true);
    await resolveExternalPlay(r.owner, b.fixtureId, "home_wins");
    const after = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect(after.playable).toBe(false);
    expect(after.canSettle, "…and no longer once it is settled").toBe(false);
    expect(after.state).toEqual({ kind: "result", score: "1–0", noResult: false });
  });
});

describe.runIf(HAS_DB)("resolveExternalPlay — a knockout draw is never decided (spec §3.6, §7)", () => {
  it("Draw opens the tie-break and HOLDS it (tiebreak_owed, replacing the old reason); only a winner settles it", async () => {
    const r = await round({ knockout: true });
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    const held = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect([held.tiebreakOwed, held.canSettle], "premise: a plain hold is not a tie-break").toEqual([false, true]);
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "draw")).toEqual({ status: "tiebreak_owed" });
    expect((await fixtureOf(b.fixtureId)).outcome, "not decided").toBeNull();
    expect((await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).map((q) => q.reason)).toEqual(["tiebreak_owed"]);
    const owed = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!;
    expect([owed.tiebreakOwed, owed.canSettle, owed.state.kind], "the panel offers a winner only").toEqual([true, true, "on_hold"]);

    let refused = 0;
    for (const kind of ["draw", "no_result"] as const) {
      expect(await codeOf(resolveExternalPlay(r.owner, b.fixtureId, kind)), kind).toEqual([409, "TIEBREAK_NEEDS_WINNER"]);
      refused += 1;
    }
    expect(refused).toBe(2);

    expect(await resolveExternalPlay(r.owner, b.fixtureId, "away_wins")).toEqual({ status: "finished" });
    const ledger = await ledgerOf(b.fixtureId);
    expect(ledger.at(-1)).toMatchObject({ type: "core.settle", payload: { winner: b.away.entrantId, method: "organiser" }, recorded_by: r.ownerUserId });
    expect((await fixtureOf(b.fixtureId)).outcome).toMatchObject({ kind: "win", winner: b.away.entrantId, method: "settled_organiser" });
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "finished", needs_reason: null });
    expect(await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).toEqual([]);
  });

  it("a tie-break settled BY HAND meanwhile is never held again: the engine still says a decider is pending after a settle (D-C5), so the hold re-reads the fixture", async () => {
    const r = await round({ knockout: true });
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    await resolveExternalPlay(r.owner, b.fixtureId, "draw");
    const fs = await getFixtureState(r.owner, b.fixtureId);
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: fs.last_seq, type: "core.settle", payload: { winner: b.home.entrantId, method: "lot" } });
    await sql`update fixture_external_play set status = 'pending', needs_reason = null, last_error = null where fixture_id = ${b.fixtureId}`;
    expect(tiebreakIsPending(await getFixtureState(r.owner, b.fixtureId)), "premise: the module still reads tiebreak").toBe(true);
    expect(await holdOwedTiebreak(b.fixtureId, r.owner, "TEST")).toBe(false);
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "pending", needs_reason: null });
  });

  it("I-3 knockout: in EVERY kind the engine declares a level result forbidden in, No result is refused KNOCKOUT_NEEDS_WINNER before anything is written — a line that feeds a next match as much as a final, both players absent included — and a winner still settles it; the panel and the queue hide No result by the same predicate, and every draw kind offers it", async () => {
    // The kinds come from the ENGINE's declarations (core/types.ts BRACKET_KINDS, DRAW_KINDS), never a list typed here.
    const readings = { refused: 0, offered: 0 };
    for (const kind of [...BRACKET_KINDS, ...DRAW_KINDS]) {
      const bracket = BRACKET_KINDS.has(kind);
      for (const line of bracket ? (["feeds a next match", "a final"] as const) : (["a board"] as const)) {
        const label = `${kind}, ${line}`;
        const r = await round();
        await sql`update stages set kind = ${kind} where id = ${r.stageId}`;
        const b = r.boards[0]!;
        if (line === "feeds a next match") await feedsNextMatch(r, b);
        // Both absent on a feeding line: the hold whose No result was a double walkover before this ruling.
        await holdAs(r, b, line === "feeds a next match" ? "no_show_both" : "not_started");
        const reason = (await bridgeOf(b.fixtureId))!.needs_reason;
        const queue = (await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).filter((q) => q.fixtureId === b.fixtureId);
        const panel = (await loadArbiterRound(r.owner, r.divisionId))!.boards.filter((x) => x.fixtureId === b.fixtureId);
        expect([queue.length, panel.length], `${label}: premise, both readers list the board`).toEqual([1, 1]);
        expect(queue[0]!.knockout, `${label}: the queue's reading`).toBe(bracket);
        expect(panel[0]!.knockout, `${label}: the panel's reading`).toBe(bracket);
        if (bracket) {
          expect(await codeOf(resolveExternalPlay(r.owner, b.fixtureId, "no_result")), label).toEqual([409, "KNOCKOUT_NEEDS_WINNER"]);
          expect(await ledgerOf(b.fixtureId), `${label}: nothing written`).toEqual([]);
          expect(await fixtureOf(b.fixtureId), label).toEqual({ status: "scheduled", outcome: null });
          expect(await bridgeOf(b.fixtureId), `${label}: still the organiser's`).toMatchObject({ status: "needs_organiser", needs_reason: reason });
          // The pair: a winner still settles it.
          expect(await resolveExternalPlay(r.owner, b.fixtureId, "home_wins"), label).toEqual({ status: "finished" });
          readings.refused += 1;
        } else {
          expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result"), label).toEqual({ status: "finished" });
          expect(await fixtureOf(b.fixtureId), label).toEqual({ status: "abandoned", outcome: null });
          readings.offered += 1;
        }
      }
    }
    // Anti-vacuity: both answers reached, every declared kind swept.
    expect(readings).toEqual({ refused: BRACKET_KINDS.size * 2, offered: DRAW_KINDS.size });
  });
});

describe.runIf(HAS_DB)("resolveExternalPlay — who may settle", () => {
  it("C: an organiser who PLAYS on the board is refused before anything is written — and settles another board", async () => {
    const r = await round({ fixtures: 2 });
    const [mine, other] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    for (const b of r.boards) {
      await pendingBridge(r, b);
      await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    }
    const admin = await seatedAdmin(r, mine.home.userId);
    expect(await codeOf(resolveExternalPlay(admin, mine.fixtureId, "home_wins"))).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
    expect(await ledgerOf(mine.fixtureId), "nothing written").toEqual([]);
    expect((await bridgeOf(mine.fixtureId))?.status).toBe("needs_organiser");
    expect(await resolveExternalPlay(admin, other.fixtureId, "home_wins")).toEqual({ status: "finished" });
    expect((await ledgerOf(other.fixtureId)).every((e) => e.recorded_by === mine.home.userId)).toBe(true);
  });

  it("another club's organiser ⇒ 404; a key (no person) ⇒ 403; a board with no online bridge ⇒ 404 — each writing nothing", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await pendingBridge(r, b);
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    const other = await round();
    const bare = await round();
    // Thunks: each refusal is started only when it is awaited (a promise
    // built up front rejects before its catch is attached).
    const cases: [string, () => Promise<unknown>, [number, string]][] = [
      ["another club", () => resolveExternalPlay(other.owner, b.fixtureId, "home_wins"), [404, "NOT_FOUND"]],
      ["api key", () => resolveExternalPlay({ ...r.owner, via: "api_key", userId: null } as AuthCtx, b.fixtureId, "home_wins"), [403, "ORGANISER_SESSION_REQUIRED"]],
      ["no bridge", () => resolveExternalPlay(bare.owner, bare.boards[0]!.fixtureId, "home_wins"), [404, "NOT_FOUND"]],
      ["unknown kind", () => resolveExternalPlay(r.owner, b.fixtureId, "home_forfeit" as ResolveKind), [422, "RESOLVE_KIND_UNKNOWN"]],
    ];
    let checked = 0;
    for (const [label, run, expected] of cases) {
      expect(await codeOf(run()), label).toEqual(expected);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    expect(await ledgerOf(b.fixtureId)).toEqual([]);
    expect(await ledgerOf(bare.boards[0]!.fixtureId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// closeExternalPlayFlags
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("closeExternalPlayFlags — 'Let the game go on'", () => {
  it("the empty case: no ids ⇒ refused, nothing closed", async () => {
    const r = await round();
    const b = r.boards[0]!;
    const id = await flag(r, b.fixtureId);
    expect(await codeOf(closeExternalPlayFlags(r.owner, b.fixtureId, []))).toEqual([422, "FLAG_IDS_INVALID"]);
    expect((await flagRows(b.fixtureId)).find((f) => f.id === id)?.closed_at).toBeNull();
  });

  it("closes the shown flags with WHO and WHEN (the audit record); the result, the seat and the bridge do not move; the panel stops showing them", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b, "live");
    const ids = [await flag(r, b.fixtureId), await flag(r, b.fixtureId, "camera_lost", b.home.personId)];
    const shown = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags.map((f) => f.id);
    expect(shown.sort(), "premise: the panel shows both").toEqual([...ids].sort());
    const bridgeBefore = await bridgeOf(b.fixtureId);
    const t0 = new Date(Date.now() - 1_000);

    expect(await closeExternalPlayFlags(r.owner, b.fixtureId, shown)).toEqual({ closed: 2, stillOpen: 0 });

    const rows = await flagRows(b.fixtureId);
    expect(rows.length, "the evidence stays on file").toBe(2);
    for (const row of rows) {
      expect(row.resolved_by).toBe(r.ownerUserId);
      expect(row.closed_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    }
    expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags, "the panel lists open flags only").toEqual([]);
    expect(await bridgeOf(b.fixtureId), "nothing about the game moves").toEqual(bridgeBefore);
    expect(await ledgerOf(b.fixtureId)).toEqual([]);
  });

  it("A: closes EXACTLY what was shown — a flag raised after the screen loaded stays open and visible", async () => {
    const r = await round();
    const b = r.boards[0]!;
    await gameBridge(r, b, "live");
    await flag(r, b.fixtureId);
    const shown = (await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags.map((f) => f.id);
    const late = await flag(r, b.fixtureId); // the producer, while the organiser reads
    expect(await closeExternalPlayFlags(r.owner, b.fixtureId, shown)).toEqual({ closed: 1, stillOpen: 1 });
    expect((await flagRows(b.fixtureId)).find((f) => f.id === late)).toMatchObject({ closed_at: null, resolved_by: null });
    expect((await loadArbiterRound(r.owner, r.divisionId))!.boards[0]!.flags.map((f) => f.id)).toEqual([late]);
  });

  it("A: closing an id already closed is a no-op — no error, and the first resolver and time stand", async () => {
    const r = await round();
    const b = r.boards[0]!;
    const id = await flag(r, b.fixtureId);
    await closeExternalPlayFlags(r.owner, b.fixtureId, [id]);
    const [first] = await flagRows(b.fixtureId);
    const u = await makeUser("second-organiser");
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${u.id}, 'admin')`;
    const second = { ...r.owner, userId: u.id, role: "admin" } as AuthCtx;
    expect(await closeExternalPlayFlags(second, b.fixtureId, [id])).toEqual({ closed: 0, stillOpen: 0 });
    expect((await flagRows(b.fixtureId))[0]).toEqual(first);
  });

  it("an id that is not this board's is refused whole — nothing on either board closes", async () => {
    const r = await round({ fixtures: 2 });
    const [one, two] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    const mine = await flag(r, one.fixtureId);
    const theirs = await flag(r, two.fixtureId);
    expect(await codeOf(closeExternalPlayFlags(r.owner, one.fixtureId, [mine, theirs]))).toEqual([404, "FLAG_NOT_FOUND"]);
    expect(await codeOf(closeExternalPlayFlags(r.owner, one.fixtureId, [randomUUID()]))).toEqual([404, "FLAG_NOT_FOUND"]);
    for (const f of [...(await flagRows(one.fixtureId)), ...(await flagRows(two.fixtureId))]) expect(f.closed_at).toBeNull();
  });

  it("C: an organiser who PLAYS on the board cannot close its flags — refused before anything is written; another board's they can", async () => {
    const r = await round({ fixtures: 2 });
    const [mine, other] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    const a = await flag(r, mine.fixtureId);
    const o = await flag(r, other.fixtureId);
    const admin = await seatedAdmin(r, mine.away.userId);
    expect(await codeOf(closeExternalPlayFlags(admin, mine.fixtureId, [a]))).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
    expect((await flagRows(mine.fixtureId))[0]?.closed_at).toBeNull();
    expect(await closeExternalPlayFlags(admin, other.fixtureId, [o])).toEqual({ closed: 1, stillOpen: 0 });
    expect((await flagRows(other.fixtureId))[0]?.resolved_by).toBe(mine.away.userId);
  });

  it("another club ⇒ 404; a key ⇒ 403 — nothing closed", async () => {
    const r = await round();
    const b = r.boards[0]!;
    const id = await flag(r, b.fixtureId);
    const other = await round();
    expect(await codeOf(closeExternalPlayFlags(other.owner, b.fixtureId, [id]))).toEqual([404, "NOT_FOUND"]);
    expect(await codeOf(closeExternalPlayFlags({ ...r.owner, via: "api_key", userId: null } as AuthCtx, b.fixtureId, [id]))).toEqual([403, "ORGANISER_SESSION_REQUIRED"]);
    expect((await flagRows(b.fixtureId))[0]?.closed_at).toBeNull();
  });
});
