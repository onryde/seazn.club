// The public fixture loader against the REAL fixture_external_play schema.
//
// `loadPublicExternalPlay` selected play_url / white_play_url /
// black_play_url, which V451's table never had: Postgres refuses an unknown
// column when it PARSES the query, whether or not a row matches, and
// getPublicFixture runs that read for every fixture — so every public fixture
// page errored, chess or not. No test ran the real loader against the real
// table; this one does, with and without a bridge row.
//
// Single-sport on purpose: the read is one select by fixture_id, blind to
// the sport, and the no-row case is the one every non-chess page takes.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double public-fixture-venue-tz.test.ts uses. Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicFixture } from "../data";
import { seedOnlineChessFixture, seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";
import { loadDivisionWatch } from "@/server/usecases/external-play-read";
import { applyOnlinePlayToConfig } from "@/server/external-play/online-play";
import { scoreEvent } from "@/server/usecases/scoring";
import { publicFixture } from "@/server/usecases/public";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { appendEvent } from "@/server/engine-db";
import uiEn from "@/dictionaries/en/ui.json";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Copied from public-fixture-venue-tz.test.ts: matchCentre parses the
 *  division config through the module's configSchema, so '{}' is refused. */
const GENERIC_DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** A public org / competition / division / fixture by direct insert — the
 *  venue-tz suite's seed, minus its timezone column. */
async function seedPublicFixture() {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "pub-ep-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pub EP Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "pub-ep-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"Pub EP Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active',
            ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { orgId, orgSlug, compSlug, divSlug, fixtureId };
}

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("getPublicFixture reads the online-play bridge from the real schema", () => {
  it("a fixture with NO bridge row loads, with externalPlay null", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
    expect(data!.fixture.id).toBe(s.fixtureId);
    expect(data!.externalPlay).toBeNull();
    // Not an online division: no round-open read, never "opened" — even with a
    // stamp on its stage (labelled SQL; only an online division is ever stamped).
    const [{ stage_id: stageId }] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${s.fixtureId}`;
    const opener = await makeUser("pub-ep-opener");
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_by) values (${stageId}, ${s.orgId}, 1, ${opener.id})`;
    const again = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(again!.roundOpened).toBe(false);
  });

  it("a fixture WITH a bridge row loads, and carries its status and nothing else", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
      values (${s.fixtureId}, ${s.orgId}, now(), 'ready', ${`gm-${uniq()}${uniq()}`})`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data).not.toBeNull();
    // toEqual on the whole object: a re-added play URL or last_error key
    // fails here, not just a wrong status. A game on file with no move yet is
    // the start position (the rulebook's), no clocks read, nothing over.
    expect(data!.externalPlay).toEqual({
      status: "ready",
      watch: {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        lastMove: null,
        turn: "white",
        ply: 0,
        whiteMs: null,
        blackMs: null,
        asOf: null,
        clockRunning: false,
        over: false,
        whiteSide: null,
        moves: [],
      },
      // T16 fix round 1: the fixture's own public facts — still to be played, nothing held, no result.
      decided: false,
      hold: null,
      result: null,
    });
  });

  it("T16: a game in progress carries its view-only board — the ledger's position, clocks as of the last move, White's side", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    const lastMoveAt = new Date("2026-10-13T10:00:00.000Z");
    // Labelled SQL: T10's move append writes the ledger (V454); here it stands for two accepted moves, 1.Nf3 Nf6.
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side,
         moves_uci, move_count, white_ms, black_ms, last_move_at)
      values (${s.fixtureId}, ${s.orgId}, now(), 'live', ${`gm-${uniq()}${uniq()}`}, 'away',
              ${sql.json(["g1f3", "g8f6"])}, 2, 598000, 597000, ${lastMoveAt})`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    // The FEN after 1.Nf3 Nf6, from the rules (FEN: halfmove clock 2, fullmove 2), not from our replay.
    expect(data!.externalPlay).toEqual({
      status: "live",
      watch: {
        fen: "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2",
        lastMove: "g8f6",
        turn: "white",
        ply: 2,
        whiteMs: 598000,
        blackMs: 597000,
        asOf: lastMoveAt.toISOString(),
        // Lichess runs the clocks once both sides have moved (ply 2).
        clockRunning: true,
        over: false,
        whiteSide: "away",
        // The rules' notation for 1.Nf3 Nf6.
        moves: ["Nf3", "Nf6"],
      },
      decided: false,
      hold: null,
      result: null,
    });
  });

  it("T16: a finished game's board is over; a hold with no game has no board", async () => {
    const done = await seedPublicFixture();
    seeded.push(done.orgId);
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side, moves_uci, move_count)
      values (${done.fixtureId}, ${done.orgId}, now(), 'finished', ${`gm-${uniq()}${uniq()}`}, 'home',
              ${sql.json(["e2e4"])}, 1)`;
    const finished = await getPublicFixture(done.orgSlug, done.compSlug, done.divSlug, done.fixtureId);
    expect(finished!.externalPlay!.watch).toMatchObject({ over: true, clockRunning: false, turn: "black", lastMove: "e2e4", ply: 1 });
    const held = await seedPublicFixture();
    seeded.push(held.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, needs_reason)
      values (${held.fixtureId}, ${held.orgId}, now(), 'needs_organiser', 'not_started')`;
    const data = await getPublicFixture(held.orgSlug, held.compSlug, held.divSlug, held.fixtureId);
    // A game that never started waits on the organiser: "to be confirmed" is its public reading (PUBLIC_HOLD).
    expect(data!.externalPlay).toEqual({ status: "needs_organiser", watch: null, decided: false, hold: "confirm", result: null });
  });

  it("an organiser's hold never shows its operator text publicly", async () => {
    // last_error is written for operators ("create:outcome_unknown: …",
    // T9); the public page gets the status alone.
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, needs_reason, last_error)
      values (${s.fixtureId}, ${s.orgId}, now(), 'needs_organiser', 'provider_error',
              'create:outcome_unknown: operator-only detail')`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.externalPlay).toEqual({ status: "needs_organiser", watch: null, decided: false, hold: "confirm", result: null });
    expect(JSON.stringify(data)).not.toContain("operator-only detail");
    expect(JSON.stringify(data), "the hold's reason itself is never published").not.toContain("provider_error");
  });

  it("T16: an online board's page says whether its round is open (D12) — before and after the organiser opens it", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date() });
    seeded.push(s.orgId);
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
       where d.id = ${s.divisionId}`;
    const read = () => getPublicFixture(slugs!.org, slugs!.comp, slugs!.div, s.fixtureId);
    expect((await read())!.roundOpened, "not opened").toBe(false);
    // Labelled SQL: T19's openRound stamps this row.
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      select ${s.stageId}, ${s.orgId}, 1, now() - interval '1 minute', ${s.home.userId}`;
    expect((await read())!.roundOpened, "opened").toBe(true);
  });
  // Option B (owner ruling 2026-10-13): from the round's open the page draws the start position with each player on
  // their side, BEFORE any game exists — so White is read from the pairing, the same fold whiteSideOf reads to make
  // the game (create-game: "colour is READ from the pairing").
  it("option B: the page reads White's side from the pairing before a game exists — home by default, away after a card making home Black", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date() });
    seeded.push(s.orgId);
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
       where d.id = ${s.divisionId}`;
    const read = async () => (await getPublicFixture(slugs!.org, slugs!.comp, slugs!.div, s.fixtureId))!;
    const before = await read();
    expect(before.externalPlay, "premise: no game on file").toBeNull();
    expect(before.pairedWhiteSide, "Swiss's own default: home is White").toBe("home");
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "boardgame.pairing", payload: { white: s.away.entrantId } });
    expect((await read()).pairedWhiteSide, "the card makes the AWAY entrant White").toBe("away");
  });

  it("option B, the empty case: a division that does not play online makes no colour read", async () => {
    const f = await seedPublicFixture();
    seeded.push(f.orgId);
    expect((await getPublicFixture(f.orgSlug, f.compSlug, f.divSlug, f.fixtureId))!.pairedWhiteSide).toBeNull();
  });
});

// R3 — the match centre's header over an online game being played: the page (ISR) and the poll (the live transport
// that re-renders it) both read live, through the one loader both use; the fixture's own wire status is NOT changed.
describe.skipIf(!HAS_DB)("the match centre over an online game being played (R3), from the real schema", () => {
  const slugsOf = async (divisionId: string) => {
    const [x] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
       where d.id = ${divisionId}`;
    return x!;
  };

  it("a game being played reads live on the page and the poll; a board with no game, and a decided one, do not", async () => {
    const r = await seedOnlineChessRound({ fixtures: 3 });
    seeded.push(r.orgId);
    const [live, idle, done] = r.boards;
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
              values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
    // Labelled SQL: T10's move append (two accepted moves) and T12's close — the columns the reading uses.
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, moves_uci, move_count)
      values (${live!.fixtureId}, ${r.orgId}, 'live', now(), ${`gm-${uniq()}`}, 'home', ${sql.json(["e2e4", "e7e5"])}, 2),
             (${done!.fixtureId}, ${r.orgId}, 'finished', now(), ${`gm-${uniq()}`}, 'home', ${sql.json(["e2e4"])}, 1)`;
    await scoreEvent(r.owner, done!.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.owner, done!.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: done!.home.entrantId, method: "resign" } });
    const sl = await slugsOf(r.divisionId);
    const page = async (id: string) => (await getPublicFixture(sl.org, sl.comp, sl.div, id))!;

    const p = await page(live!.fixtureId);
    expect(p.fixture.status, "premise: nothing marks the fixture in play").toBe("scheduled");
    expect([p.matchCentre.header.status, p.matchCentre.header.live], "page").toEqual(["in_play", true]);
    const poll = (await publicFixture(live!.fixtureId)) as { status: string; match_centre: { header: { status: string } } };
    expect([poll.status, poll.match_centre.header.status], "poll: the wire status is the fixture's; the header is live").toEqual(["scheduled", "in_play"]);

    expect((await page(idle!.fixtureId)).matchCentre.header.status, "no game yet").toBe("scheduled");
    expect((await page(done!.fixtureId)).matchCentre.header.status, "decided stays decided").toBe("decided");
    // T17 owner change (2026-10-13): the board with no move yet, its round open, reads STARTING — its header still
    // scheduled, plus the flag the chip reads — on the page and on the poll. The live and decided boards carry no flag.
    const idlePage = (await page(idle!.fixtureId)).matchCentre.header;
    const idlePoll = ((await publicFixture(idle!.fixtureId)) as { match_centre: { header: { status: string; onlineStarting?: boolean } } }).match_centre.header;
    expect([idlePage.status, idlePage.onlineStarting], "page: starting").toEqual(["scheduled", true]);
    expect([idlePoll.status, idlePoll.onlineStarting], "poll: starting").toEqual(["scheduled", true]);
    for (const id of [live!.fixtureId, done!.fixtureId]) {
      expect(Object.hasOwn((await page(id)).matchCentre.header, "onlineStarting"), id).toBe(false);
    }

    // A board of a round not yet opened (the list says "Round not opened yet") is not being played.
    const later = await seedOnlineChessRound({ fixtures: 1, roundNo: 2 });
    seeded.push(later.orgId);
    const sl2 = await slugsOf(later.divisionId);
    const notOpened = await getPublicFixture(sl2.org, sl2.comp, sl2.div, later.boards[0]!.fixtureId);
    expect(notOpened!.matchCentre.header.status, "round not opened").toBe("scheduled");
    expect(Object.hasOwn(notOpened!.matchCentre.header, "onlineStarting"), "round not opened: Scheduled, never Starting").toBe(false);
  });

  // T17 fix round 4, I1: Starting follows the division's online-play MODE, as the Fixtures list and the fixture page's
  // board do (`readOnlinePlay(config) === "lichess"`). An organiser who opened a round and then switched online play
  // off (turning it off is never gated) finishes over the board: no unplayed board of that round may read Starting.
  it("I1: the same opened round reads Starting with online play on and Scheduled with it off — on the page and the poll", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    seeded.push(r.orgId);
    const board = r.boards[0]!;
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
              values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
    const sl = await slugsOf(r.divisionId);
    type H = { status: string; onlineStarting?: boolean };
    const read = async (): Promise<[H, H]> => [
      (await getPublicFixture(sl.org, sl.comp, sl.div, board.fixtureId))!.matchCentre.header,
      ((await publicFixture(board.fixtureId)) as { match_centre: { header: H } }).match_centre.header,
    ];
    const [cfg] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${r.divisionId}`;
    expect(cfg!.config.onlinePlay, "premise: the division plays online").toBe("lichess");
    let checked = 0;
    const on = await read();
    for (const [i, where] of (["page", "poll"] as const).entries()) {
      expect([on[i]!.status, on[i]!.onlineStarting], `on, ${where}: Starting`).toEqual(["scheduled", true]);
      checked += 1;
    }
    // The organiser switches online play off — the REAL config transform the division update applies.
    const off = { ...cfg!.config };
    applyOnlinePlayToConfig(off, "off");
    await sql`update divisions set config = ${sql.json(off as never)} where id = ${r.divisionId}`;
    const after = await read();
    for (const [i, where] of (["page", "poll"] as const).entries()) {
      expect([after[i]!.status, Object.hasOwn(after[i]!, "onlineStarting")], `off, ${where}: Scheduled, no flag`).toEqual(["scheduled", false]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both modes on both surfaces").toBe(4);
  });

  // T17 round B, C: the header's format word over an online game is the time control's speed. The seed declares the
  // "classical" clock family at 10+5 — a pair nothing in the product refuses — and Lichess plays 10+5 as rapid.
  it("C: an online board's format is its time control's speed — Rapid at 10+5, on the page and on the poll", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, clock: { base: 600, increment: 5 } });
    seeded.push(r.orgId);
    const [div] = await sql<{ variant_key: string }[]>`select variant_key from divisions where id = ${r.divisionId}`;
    expect(div!.variant_key, "premise: the division declares Classical").toBe("classical");
    const sl = await slugsOf(r.divisionId);
    const page = (await getPublicFixture(sl.org, sl.comp, sl.div, r.boards[0]!.fixtureId))!;
    const poll = (await publicFixture(r.boards[0]!.fixtureId)) as { match_centre: { header: { metaLine: string | null } } };
    const RAPID = (uiEn as Record<string, string>)["variant.boardgame.rapid"]!;
    const CLASSICAL = (uiEn as Record<string, string>)["variant.boardgame.classical"]!;
    let checked = 0;
    for (const [where, line] of [["page", page.matchCentre.header.metaLine], ["poll", poll.match_centre.header.metaLine]] as const) {
      expect(line?.split(" · ")[0], where).toBe(RAPID);
      expect(line, where).not.toContain(CLASSICAL);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("another sport: a bridge row under a non-online sport is never read — the header keeps the fixture's state", async () => {
    // A forged row (no product path writes one for a generic fixture): the gate is the sport, not the row's absence.
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, moves_uci, move_count)
      values (${s.fixtureId}, ${s.orgId}, 'live', now(), ${`gm-${uniq()}`}, 'home', ${sql.json(["e2e4", "e7e5"])}, 2)`;
    // Its round opened too, so the only thing between this row and "live" is the sport gate.
    const opener = await makeUser("pub-ep-r3-opener");
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
              select f.stage_id, f.org_id, 1, now(), ${opener.id} from fixtures f where f.id = ${s.fixtureId}`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect([data!.fixture.status, data!.matchCentre.header.status]).toEqual(["scheduled", "scheduled"]);
    // And a game not begun on that forged row (the round open, no move): never Starting under another sport either.
    await sql`update fixture_external_play set status = 'ready', moves_uci = '[]'::jsonb, move_count = 0 where fixture_id = ${s.fixtureId}`;
    const idle = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect([idle!.matchCentre.header.status, Object.hasOwn(idle!.matchCentre.header, "onlineStarting")]).toEqual(["scheduled", false]);
  });
});

describe.skipIf(!HAS_DB)("loadDivisionWatch — the division Fixtures list's watch links, from the real schema (I4)", () => {
  it("one read for the division: live, final with its score, starting, not opened — and nothing private", async () => {
    // Round 1 opened with three boards: one being played, one finished and decided on the pad, one with no game yet.
    const r = await seedOnlineChessRound({ fixtures: 3 });
    seeded.push(r.orgId);
    const [live, done, idle] = r.boards;
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
              values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
    // Labelled SQL: T10's move append (live) and T12's result + close (done) — the columns the list reads.
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, moves_uci, move_count)
      values (${live!.fixtureId}, ${r.orgId}, 'live', now(), ${`gm-${uniq()}`}, 'home', ${sql.json(["e2e4", "e7e5"])}, 2),
             (${done!.fixtureId}, ${r.orgId}, 'finished', now(), ${`gm-${uniq()}`}, 'away', ${sql.json(["e2e4"])}, 1)`;
    // The result through the REAL scoring write (the pad's producer): home wins by resignation.
    await scoreEvent(r.owner, done!.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.owner, done!.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: done!.home.entrantId, method: "resign" } });
    expect((await sql<{ status: string }[]>`select status from fixtures where id = ${done!.fixtureId}`)[0]!.status, "premise: decided").toBe("decided");
    const { links, roundOpenedAt } = await loadDivisionWatch(r.divisionId);
    // The away entrant plays White on the finished board: White first reads 0–1.
    // T17 owner change (2026-10-13): the idle board, its round open and no move yet, reads Starting.
    expect(links).toEqual({
      [live!.fixtureId]: { kind: "live" },
      [done!.fixtureId]: { kind: "final", score: "0–1", noResult: false },
      [idle!.fixtureId]: { kind: "starting" },
    });
    expect(JSON.stringify(links), "no challenge id, no Lichess id, no hold reason").not.toMatch(/gm-|lichess|needs_|token/i);
    // V4 (T17 fix round 4): the same read carries the round's open moment for each board still to be played — the
    // stamp itself (T19's openRound writes it) — and none for the decided board.
    const [{ opened_at }] = await sql<{ opened_at: Date }[]>`
      select opened_at from stage_round_opens where stage_id = ${r.stageId} and round_no = 1`;
    expect(roundOpenedAt).toEqual({ [live!.fixtureId]: opened_at.toISOString(), [idle!.fixtureId]: opened_at.toISOString() });

    // A later round, not opened: every board of it reads "Round not opened yet".
    const r2 = await seedOnlineChessRound({ fixtures: 1, roundNo: 2 });
    seeded.push(r2.orgId);
    expect(await loadDivisionWatch(r2.divisionId)).toEqual({ links: { [r2.boards[0]!.fixtureId]: { kind: "not_opened" } }, roundOpenedAt: {} });
  });

  it("the empty case: a division with no fixtures has no links", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    const [{ division_id }] = await sql<{ division_id: string }[]>`select division_id from fixtures where id = ${s.fixtureId}`;
    await sql`delete from fixtures where id = ${s.fixtureId}`;
    expect(await loadDivisionWatch(division_id)).toEqual({ links: {}, roundOpenedAt: {} });
  });
});

