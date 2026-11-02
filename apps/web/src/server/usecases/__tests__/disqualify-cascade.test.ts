// W3 Task 15 (RB3-17; rule X-SW-23) on Postgres — a disqualification cascades like a withdrawal. Rulebook §12:
// "Disqualification = withdrawal from that moment; annulment separate". Before this task a `PATCH /entrants/{id}`
// `{status: "disqualified"}` was a bare status flip: the disqualified entrant's open board stayed `scheduled`, so the
// round never completed and Pair next refused the division. Now a disqualification of an entrant still in the field
// routes through the withdrawal cascade (`withdrawEntrantCascade(…, { as: "disqualified" })`), which settles their owed
// boards exactly as a withdrawal does and writes the final status `disqualified`.
//
// Rulings this file pins (progress.md C6 and the T15 dispatch):
//   - the cascade writes its status through an internal writer that does not re-route, and `patchEntrant` routes only
//     an entrant still in the field — a second PATCH to `disqualified` (status unchanged) is a plain, idempotent write;
//   - "started" is T9's one predicate (`divisionHasStarted`): before Start the cascade is a plain status flip;
//   - the walkover a withdrawal writes is unchanged (`core.forfeit { reason: "withdrew" }`, the closed forfeit reason,
//     finding 14) and ruling 115 still decides credit — the expected outcome below is the rulebook's (the opponent wins
//     the owed board, played results stand), typed here, never read off the cascade.
//
// Sports: every Swiss case runs for badminton (the house racket sport) and boardgame (chess); the first case also runs on
// a badminton LEAGUE, where the table policy (spec 05 §5: under half played expunges, otherwise walks over) decides.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "@/lib/db";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { Schedule } from "@/components/public-site/schedule";
import DivisionHomePage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { getPublicDivision, type PublicFixture } from "@/server/public-site/data";
import { loadMatchCentre, type MatchCentreLoadCtx } from "@/server/public-site/match-centre-load";
import { publicOverlayPageFacts, relayOverlayPageFacts } from "@/server/overlay/page-facts";
import { buildPublicDivisionSlides } from "@/server/slideshow-data";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, getEntrant, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

// The public reads (T15 review I4) go through `unstable_cache`, which has no incrementalCache outside a real request: a
// passthrough, never a memoising double (competition-hub-db.test.ts's own reason).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = { sport: string; variant: string };
type Kind = "individual" | "pair" | "team";

/** The walkover a withdrawal writes (finding 14: the closed forfeit reason `withdrew`, never the English sentence). */
const WITHDREW = "withdrew";

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, ext_key, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const seated = (f: Row) => f.home_entrant_id !== null && f.away_entrant_id !== null;
const boardsOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r && !isBye(f) && seated(f));
const seats = (f: Row, id: string) => f.home_entrant_id === id || f.away_entrant_id === id;

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  entrants: string[];
}

function entrantInput(kind: Kind, name: string, seed: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/** N seeded entrants of the sport's own default kind and one table stage (a Swiss of `rounds`, or a league). Started
 *  unless `started: false`; a pre-Start Swiss is minted and its round 1 paired while the division is in setup. */
async function rig(sport: Sport, n: number, stage: { kind: "swiss"; rounds: number } | { kind: "league" }, opts: { started?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "DQ " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const sportModule = builtinModules.find((m) => m.key === sport.sport)!;
  const kind = (sportModule.entrantModel?.defaultKind ?? "individual") as Kind;
  const made = await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)));
  const [created] = await createStages(auth, division.id, {
    seq: 1,
    kind: stage.kind,
    name: stage.kind === "swiss" ? "Swiss" : "League",
    config: stage.kind === "swiss" ? { rounds: stage.rounds } : {},
    progression: null,
  });
  const r: Rig = { sport, auth, divisionId: division.id, stageId: created!.id, entrants: made.map((e) => e.id) };
  if (opts.started === false) {
    await generateStageFixtures(auth, r.stageId); // the mint
    await generateStageFixtures(auth, r.stageId); // Pair round 1, before Start
    return r;
  }
  await startDivision(auth, division.id);
  if ((await rowsOf(r.stageId)).length === 0) await generateStageFixtures(auth, r.stageId);
  return r;
}

/** The scorer's quick result: the home side wins, through real scoring events. */
async function homeWins(r: Rig, f: Row): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
  let seq = n;
  if (seq === 0) await scoreEvent(r.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (r.sport.sport === "boardgame") {
    await scoreEvent(r.auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(r.auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(r.auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

/** Pair the Swiss's next round (the Pair next button). */
const pair = (r: Rig) => generateStageFixtures(r.auth, r.stageId);

async function playRound(r: Rig, round: number): Promise<void> {
  const boards = boardsOf(await rowsOf(r.stageId), round).filter((f) => f.status === "scheduled");
  expect(boards.length, `rig: round ${round} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(r, f);
  expect(boardsOf(await rowsOf(r.stageId), round).map((f) => f.status), `rig: round ${round} decided`).toEqual(
    boardsOf(await rowsOf(r.stageId), round).map(() => "decided"),
  );
}

/** What a DQ must leave alone and what it moves: the division's score events and ledger rows. */
async function writes(divisionId: string) {
  const [{ events }] = await sql<{ events: number }[]>`
    select count(*)::int as events from score_events se join fixtures f on f.id = se.fixture_id where f.division_id = ${divisionId}`;
  const [{ ledger }] = await sql<{ ledger: number }[]>`select count(*)::int as ledger from division_events where division_id = ${divisionId}`;
  return { events, ledger };
}

/** A Swiss of `n` × 3 (4 unless a case says why) with round 1 played (home wins) and round 2 paired: the disqualified
 *  entrant is round 1's first winner — a played result that must stand — and sits on an open round-2 board. */
async function midSwiss(sport: Sport, n = 4) {
  const r = await rig(sport, n, { kind: "swiss", rounds: 3 });
  await pair(r);
  await playRound(r, 1);
  const round1 = boardsOf(await rowsOf(r.stageId), 1);
  const dq = round1[0]!.home_entrant_id!;
  await pair(r);
  const owed = boardsOf(await rowsOf(r.stageId), 2).find((f) => seats(f, dq));
  expect(owed, "premise: the DQ'd entrant sits on an open round-2 board").toBeDefined();
  expect(owed!.status, "premise: that board is unplayed").toBe("scheduled");
  const opponent = owed!.home_entrant_id === dq ? owed!.away_entrant_id! : owed!.home_entrant_id!;
  return { r, dq, owed: owed!, opponent, round1 };
}

describe.runIf(HAS_DB)("X-SW-23 a disqualification cascades like a withdrawal (RB3-17)", () => {
  for (const s of SPORTS) {
    it(`X-SW-23 PATCH status disqualified mid-Swiss walks the open board over to the opponent and leaves played results standing (${s.sport})`, async () => {
      const { r, dq, owed, opponent, round1 } = await midSwiss(s);
      const other = boardsOf(await rowsOf(r.stageId), 2).find((f) => f.id !== owed.id)!;

      const out = await patchEntrant(r.auth, dq, { status: "disqualified" });
      expect(out.status, "the PATCH answers the entrant, disqualified").toBe("disqualified");
      expect((await getEntrant(r.auth, dq)).status).toBe("disqualified");

      const after = await rowsOf(r.stageId);
      // The owed board: a walkover WIN for the opponent, the withdrawal's own award (rulebook §12: DQ = withdrawal).
      expect(after.find((f) => f.id === owed.id)).toMatchObject({
        status: "forfeited",
        outcome: { kind: "award", winner: opponent, loser: dq, reason: WITHDREW },
      });
      // Played results stand: round 1 reads exactly as it did, the DQ'd entrant's win included.
      expect(boardsOf(after, 1).map((f) => [f.id, f.status, f.outcome])).toEqual(round1.map((f) => [f.id, f.status, f.outcome]));
      expect(round1.find((f) => seats(f, dq))!.outcome, "premise: the DQ'd entrant's round-1 win").toMatchObject({ winner: dq });
      // Nobody else's board is touched.
      expect(after.find((f) => f.id === other.id)).toMatchObject({ status: "scheduled", outcome: null });
    }, 120_000);

    // Six entrants, not four (review I2): with three left, a chess round 3 can be left unpaired — engine 1.x fixes the
    // bye before it checks the rest can pair, and three players two rounds in can leave only a rematch once the bye is
    // gone (the colour lot, seeded by the stage id, decides which). That gap predates T15 and is carried to app-B; five
    // left always pair. Both sports take the same field so the case reads one way.
    it(`X-SW-23 a disqualified entrant is not paired again (${s.sport})`, async () => {
      const { r, dq, owed } = await midSwiss(s, 6);
      await patchEntrant(r.auth, dq, { status: "disqualified" });
      // The rest of round 2 is played; the DQ'd entrant's board is already settled, so the round is complete.
      const rest = boardsOf(await rowsOf(r.stageId), 2).filter((x) => x.id !== owed.id);
      expect(rest, "premise: round 2's two other boards").toHaveLength(2);
      for (const f of rest) await homeWins(r, f);
      await pair(r);
      const round3 = (await rowsOf(r.stageId)).filter((f) => f.round_no === 3);
      const seatedIds = round3.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
      // Five left in the field: two boards and a bye (⌊5/2⌋ boards, rulebook §3.1), every one of the five seated once.
      expect(seatedIds.sort(), "round 3 seats the five still in the field, once each").toEqual(r.entrants.filter((id) => id !== dq).sort());
      expect(seatedIds, "the disqualified entrant is on no round-3 row").not.toContain(dq);
      expect(boardsOf(await rowsOf(r.stageId), 3)).toHaveLength(2);
    }, 120_000);

    it(`X-SW-23 before Start it stays a plain status flip (${s.sport})`, async () => {
      const r = await rig(s, 4, { kind: "swiss", rounds: 3 }, { started: false });
      const [{ status: divisionStatus }] = await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`;
      expect(divisionStatus, "premise: the division has not started").toBe("setup");
      const before = await rowsOf(r.stageId);
      const dq = boardsOf(before, 1)[0]!.home_entrant_id!;
      expect(boardsOf(before, 1).length, "premise: round 1 is paired before Start").toBe(2);
      const w0 = await writes(r.divisionId);

      expect((await patchEntrant(r.auth, dq, { status: "disqualified" })).status).toBe("disqualified");
      // Nothing settled: no score event, no ledger row, every fixture row exactly as it was (the board stays seated and
      // scheduled — nothing is walked over before Start).
      expect(await writes(r.divisionId), "no score event and no ledger row").toEqual(w0);
      expect(await rowsOf(r.stageId), "no fixture moved").toEqual(before);
    }, 120_000);

    it(`X-SW-23 a second PATCH to disqualified is idempotent (${s.sport})`, async () => {
      const { r, dq, owed } = await midSwiss(s);
      await patchEntrant(r.auth, dq, { status: "disqualified" });
      const rows1 = await rowsOf(r.stageId);
      const w1 = await writes(r.divisionId);
      expect(rows1.find((f) => f.id === owed.id)!.status, "premise: the first PATCH walked the board over").toBe("forfeited");

      const again = await patchEntrant(r.auth, dq, { status: "disqualified" });
      expect(again.status).toBe("disqualified");
      expect(await rowsOf(r.stageId), "the second PATCH moves no fixture").toEqual(rows1);
      expect(await writes(r.divisionId), "and writes no event or ledger row").toEqual(w1);

      // The cascade itself, asked to disqualify an entrant who already is, refuses by name (409: nothing left to do).
      await expect(withdrawEntrantCascade(r.auth, dq, { as: "disqualified" })).rejects.toMatchObject({ status: 409 });
      expect(await rowsOf(r.stageId)).toEqual(rows1);
    }, 120_000);
  }

  it("X-SW-23 the cascade reports what it wrote as `disqualified`; a withdrawn entrant then disqualified is a plain flip (badminton — the report is sport-blind)", async () => {
    const { r, dq, owed, opponent } = await midSwiss(SPORTS[0]);
    const out = await withdrawEntrantCascade(r.auth, dq, { as: "disqualified" });
    expect(out).toEqual({
      entrant_id: dq,
      status: "disqualified",
      policy: "walkover",
      walkovers: 1,
      voided: 0,
      skipped_finalized: 0,
      walked_over_held: 0,
      left_to_organiser: [],
    });
    expect((await getEntrant(r.auth, dq)).status).toBe("disqualified");
    expect((await rowsOf(r.stageId)).find((f) => f.id === owed.id)).toMatchObject({ outcome: { winner: opponent, loser: dq } });

    // The other direction of the sequence: an entrant WITHDRAWN (the cascade ran then) and later disqualified moves
    // between two departed statuses — nothing is owed any more, so it is the plain write.
    const { r: r2, dq: left } = await midSwiss(SPORTS[0]);
    await withdrawEntrantCascade(r2.auth, left);
    const rows = await rowsOf(r2.stageId);
    const w = await writes(r2.divisionId);
    expect((await patchEntrant(r2.auth, left, { status: "disqualified" })).status).toBe("disqualified");
    expect(await rowsOf(r2.stageId)).toEqual(rows);
    expect(await writes(r2.divisionId)).toEqual(w);
  }, 180_000);

  it("X-SW-23 a BARE-withdrawn entrant (ruling 111's PATCH `withdrawn`) still holding an open board, then disqualified: the plain write — the route reads the departed STATUS, so her board is left as it was (review m1/MB; badminton — the route reads the status, never the sport)", async () => {
    // Pins TODAY's answer, so narrowing the route's departed set to `disqualified` alone (review mutant MB) reds here:
    // under it this DQ would run the cascade and walk her board over. Whether a DQ of a bare-withdrawn entrant who still
    // owes a board SHOULD settle it is an open question for the controller (AGENTS #13: both directions) — the
    // already-departed guard is keyed on the status, not on "owes nothing".
    const { r, dq, owed } = await midSwiss(SPORTS[0]);
    expect((await patchEntrant(r.auth, dq, { status: "withdrawn" })).status, "ruling 111's bare flip").toBe("withdrawn");
    const rows = await rowsOf(r.stageId);
    expect(rows.find((f) => f.id === owed.id)!.status, "premise: the bare withdrawal left her board open").toBe("scheduled");
    const w = await writes(r.divisionId);
    expect((await patchEntrant(r.auth, dq, { status: "disqualified" })).status).toBe("disqualified");
    expect(await rowsOf(r.stageId), "no fixture moved: her board is still open").toEqual(rows);
    expect(await writes(r.divisionId), "no score event and no ledger row").toEqual(w);
  }, 120_000);

  it("X-SW-23 PATCH status disqualified mid-league walks the open match over to the opponent and leaves played results standing (badminton league — the table policy: two of three played, so a walkover, never an expunge)", async () => {
    // Single sport: the league path is the table policy's, which reads the stage kind and the counts, never the sport.
    const r = await rig(SPORTS[0], 4, { kind: "league" });
    const rows = await rowsOf(r.stageId);
    expect([...new Set(rows.map((f) => f.round_no))], "premise: a round robin of four is three rounds").toEqual([1, 2, 3]);
    for (const round of [1, 2]) for (const f of rows.filter((x) => x.round_no === round)) await homeWins(r, f);
    const dq = r.entrants[0]!;
    const owed = (await rowsOf(r.stageId)).filter((f) => f.round_no === 3 && seats(f, dq));
    expect(owed, "premise: one match of the DQ'd entrant left").toHaveLength(1);
    const played = (await rowsOf(r.stageId)).filter((f) => f.round_no < 3);

    expect((await patchEntrant(r.auth, dq, { status: "disqualified" })).status).toBe("disqualified");
    const after = await rowsOf(r.stageId);
    const opponent = owed[0]!.home_entrant_id === dq ? owed[0]!.away_entrant_id : owed[0]!.home_entrant_id;
    expect(after.find((f) => f.id === owed[0]!.id)).toMatchObject({
      status: "forfeited",
      outcome: { kind: "award", winner: opponent, loser: dq, reason: WITHDREW },
    });
    expect(after.filter((f) => f.round_no < 3).map((f) => [f.id, f.status, f.outcome]), "played results stand").toEqual(
      played.map((f) => [f.id, f.status, f.outcome]),
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// W3 T15 review I4 (controller ruling 2026-11-02, under ruling 116's scope note at stages.ts `awardSeededByes`): the DQ
// cascade's award carries reason `withdrew` (the engine has no unplayed `disqualified` forfeit: PF-2). A DISQUALIFIED
// entrant is never shown publicly as having withdrawn; ruling 116 prescribes no DQ copy, so every public surface words
// her walkover as the plain walkover, read from her published status (`public_entrants_v`, V412). Driven through the
// real producers: the PATCH and the withdrawal cascade write the boards; each surface reads them through its own loader.
// ---------------------------------------------------------------------------------------------------------------------

const EN = enPublic as unknown as Dict;
const en = (key: string, vars?: Record<string, string>) => t(EN, key, vars);
/** Escape for a search inside rendered markup: React writes `'` as `&#x27;`. */
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

/** Every element of `type` anywhere in a server component's returned tree (withdrawn-winner-walkover.test.ts). */
function findElements(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, out);
  } else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) findElements(value, type, out);
  }
  return out;
}
/** The markup of the ONE link to a fixture (a schedule row). */
function linkTo(html: string, fixtureId: string): string {
  const all = [...html.matchAll(new RegExp(`<a[^>]*href="[^"]*/fixtures/${fixtureId}"[^>]*>([\\s\\S]*?)</a>`, "g"))];
  if (all.length !== 1) throw new Error(`schedule: ${all.length} links to ${fixtureId}, wanted exactly one`);
  return all[0]![0];
}
/** Every object in a JSON-shaped tree that carries `key` (the kiosk's slides hold their rows at varying depths). */
function objectsWith(node: unknown, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const x of node) objectsWith(x, key, out);
  else if (node !== null && typeof node === "object") {
    if (key in node) out.push(node as Record<string, unknown>);
    for (const v of Object.values(node)) objectsWith(v, key, out);
  }
  return out;
}
/** The page's own read of one fixture (`public_fixtures_v`, the columns `getPublicFixture` selects). */
async function publicRow(id: string): Promise<PublicFixture> {
  const [row] = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label, status, outcome, summary, last_seq,
           lane, is_final, third_place, conditional, stream_url
      from public_fixtures_v where id = ${id}`;
  if (!row) throw new Error(`rig: ${id} is not public`);
  return row;
}
async function matchCentreCtx(divisionId: string): Promise<MatchCentreLoadCtx> {
  const [div] = await sql<{ sport_key: string; module_version: string }[]>`
    select sport_key, module_version from divisions where id = ${divisionId}`;
  return {
    orgTz: null,
    division: { sportKey: div!.sport_key, moduleVersion: div!.module_version, formatLabel: "x", tz: null, youth: false, playerNameDisplay: null },
    locale: "en",
    hrefs: { division: "/d", competition: "/c", calendar: null },
    stage: { name: "Swiss", roundLabel: null },
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
  };
}

describe.runIf(HAS_DB)("W3 T15 I4: a disqualified entrant's walkover reads as a plain walkover on every public surface; a withdrawn one's says she withdrew", () => {
  for (const s of SPORTS) {
    it(`the division page's schedule, the hub card, the match page (status line, timeline, side), the kiosk and both overlay doors (${s.sport})`, async () => {
      const { r, dq, owed, opponent } = await midSwiss(s);
      const other = boardsOf(await rowsOf(r.stageId), 2).find((f) => f.id !== owed.id && f.status === "scheduled");
      expect(other, "premise: a second open round-2 board, for the withdrawn twin").toBeDefined();
      const wd = other!.away_entrant_id!;
      const wdOpponent = other!.home_entrant_id!;

      // The real producers: the DQ through the PATCH (it routes to the cascade), the twin through the withdrawal.
      await patchEntrant(r.auth, dq, { status: "disqualified" });
      await withdrawEntrantCascade(r.auth, wd);
      const after = await rowsOf(r.stageId);
      expect(after.find((f) => f.id === owed.id)?.outcome, "premise: the DQ's walkover").toEqual({ kind: "award", winner: opponent, loser: dq, reason: WITHDREW });
      expect(after.find((f) => f.id === other!.id)?.outcome, "premise: the withdrawal's").toEqual({ kind: "award", winner: wdOpponent, loser: wd, reason: WITHDREW });

      const [comp] = await sql<{ id: string }[]>`select competition_id as id from divisions where id = ${r.divisionId}`;
      await sql`update competitions set visibility = 'public' where id = ${comp!.id}`;
      const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
        select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${r.divisionId}`;
      const detail = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
      const names = Object.fromEntries(detail.entrants.map((e) => [e.id, e.display_name]));
      expect([detail.entrants.find((e) => e.id === dq)?.status, detail.entrants.find((e) => e.id === wd)?.status], "premise: both published, with their status").toEqual([
        "disqualified",
        "withdrawn",
      ]);

      // What each board must read: the DQ's the plain walkover; the withdrawal's the withdrawal walkover, as before.
      const BOARDS = [
        { id: owed.id, loser: dq, status: "disqualified", sentenceKey: "forfeit.sentence.walkoverPlain", timelineKey: "timeline.core.forfeit.walkoverPlain", fullKey: "forfeit.tagFull.walkover", opponent },
        { id: other!.id, loser: wd, status: "withdrawn", sentenceKey: "forfeit.sentence.withdrew", timelineKey: "timeline.core.forfeit.withdrew", fullKey: "forfeit.tagFull.withdrew", opponent: wdOpponent },
      ] as const;
      expect(en(BOARDS[0].sentenceKey, { loser: names[dq]! }), "premise: the plain sentence says no withdrawal").not.toMatch(/withdr/i);
      expect(en(BOARDS[1].sentenceKey, { loser: names[wd]! }), "premise: the withdrawal sentence says so").toMatch(/withdr/i);

      const root = await DivisionHomePage({
        params: Promise.resolve({ orgSlug: slugs!.org, competitionSlug: slugs!.comp, divisionSlug: slugs!.div }),
      });
      const schedules = findElements(root, Schedule);
      expect(schedules.length, "rig: the division page builds a Schedule").toBeGreaterThan(0);
      const scheduleHtml = schedules.map((el) => renderToStaticMarkup(el)).join("");
      const hub = (await loadCompetitionHub(slugs!.org, slugs!.comp))!;
      const kiosk = await buildPublicDivisionSlides({ ...detail, orgLocale: "en" });
      const kioskRows = objectsWith(kiosk, "statusTag");

      let surfaces = 0;
      for (const b of BOARDS) {
        const sentence = en(b.sentenceKey, { loser: names[b.loser]! });
        const tag = `${b.status}`;
        // The division page's schedule row: the tag's accessible name is the sentence.
        expect(linkTo(scheduleHtml, b.id), `schedule/${tag}`).toContain(`aria-label="${escaped(sentence)}"`);
        surfaces++;
        // The hub card.
        expect(hub.matches.find((m) => m.fixtureId === b.id)?.forfeit?.sentence, `hub/${tag}`).toBe(sentence);
        surfaces++;
        // The match page: the court card's line, the timeline's forfeit line, and the loser's side carries her departure.
        const doc = await loadMatchCentre(sql, await publicRow(b.id), await matchCentreCtx(r.divisionId));
        expect(doc.header.statusLine, `match page/${tag}`).toEqual({ key: b.sentenceKey, params: { loser: names[b.loser] } });
        expect((doc.timeline ?? []).filter((l) => l.text.key.startsWith("timeline.core.forfeit.")).map((l) => l.text.key), `timeline/${tag}`).toEqual([b.timelineKey]);
        expect(doc.header.sides.find((x) => x.entrantId === b.loser)?.departed, `match page side/${tag}`).toBe(b.status);
        expect(doc.header.sides.find((x) => x.entrantId === b.opponent)?.departed, `the opponent is in the field/${tag}`).toBeUndefined();
        surfaces += 3;
        // The kiosk: the results row naming both sides, its tag's expansion.
        const row = kioskRows.filter((x) => [x.home, x.away].includes(names[b.loser]) && [x.home, x.away].includes(names[b.opponent]));
        expect(row.length, `kiosk/${tag}: one results row`).toBeGreaterThan(0);
        for (const x of row) expect((x.statusTag as { full: string }).full, `kiosk/${tag}`).toBe(msgFor("en", b.fullKey as MessageKey));
        surfaces++;
        // Both overlay doors: the loser's side carries her departure (the overlay model words it, overlay-model.test.ts).
        for (const [door, facts] of [["public", await publicOverlayPageFacts(b.id)], ["relay", await relayOverlayPageFacts(b.id)]] as const) {
          expect(facts?.sides.find((x) => x.id === b.loser)?.departed, `${door} overlay/${tag}`).toBe(b.status);
          expect(facts?.sides.find((x) => x.id === b.opponent)?.departed, `${door} overlay opponent/${tag}`).toBeUndefined();
          surfaces++;
        }
      }
      expect(surfaces, "every surface, both reasons").toBe(BOARDS.length * 8);
    }, 120_000);
  }
});
