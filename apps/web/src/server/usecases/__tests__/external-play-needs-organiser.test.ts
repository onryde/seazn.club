// The organiser queue's reader, rebuilt against V451 (the pre-redesign one was
// deleted in 340dce7ed with its schema). It is what the division page's
// fixtures tab calls, so it is imported here through the SAME path the page
// uses: the `@/server/usecases/external-play` index.
// Single-sport by construction: only a boardgame division can carry online
// play, so only a chess fixture can ever own a fixture_external_play row.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { listNeedsOrganiserExternalPlay, mintOrgOwnerAuth, readNeedsReason } from "@/server/usecases/external-play";
import { createDivision } from "../divisions";
import { scoreEvent } from "../scoring";
import { createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const T = new Date("2026-10-01T12:10:00.000Z");

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function seeded() {
  const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });
  const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
  const [f] = await sql<{ fixture_no: number | null }[]>`select fixture_no from fixtures where id = ${s.fixtureId}`;
  return { ...s, auth, fixtureNo: f?.fixture_no ?? null };
}

async function bridge(fixtureId: string, orgId: string, status: string, reason: string | null, lastError: string | null) {
  await sql`
    insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, needs_reason, last_error)
    values (${fixtureId}, ${orgId}, ${status}, ${T}, ${reason}, ${lastError})`;
}

describe.skipIf(!HAS_DB)("listNeedsOrganiserExternalPlay", () => {
  it("empty case: a division whose fixture has no bridge row lists nothing", async () => {
    const s = await seeded();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(n, "premise: no bridge row").toBe(0);
    expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).toEqual([]);
  });

  it("one needs_organiser row is listed, with its reason and its last error — and where it sits (T16)", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "not_started", "lichess answered 503");
    // The board's place, read from the database itself.
    const [at] = await sql<{ round_no: number; seq_in_round: number; name: string }[]>`
      select f.round_no, f.seq_in_round, s.name from fixtures f join stages s on s.id = f.stage_id where f.id = ${s.fixtureId}`;
    expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).toEqual([
      {
        fixtureId: s.fixtureId,
        fixtureNo: s.fixtureNo,
        homeName: "White",
        awayName: "Black",
        scheduledAt: T.toISOString(),
        reason: "not_started",
        lastError: "lichess answered 503",
        // No pairing card and no game: home plays White (FIDE pairing default, guard.ts).
        whiteSide: "home",
        revokedSeat: null,
        roundNo: at!.round_no,
        boardNo: at!.seq_in_round,
        stageName: at!.name,
        canResync: false,
        seated: false,
        // A league board: W2b D19 never refuses No result here (the shape-by-shape differential against the server's
        // own refusal lives in external-play-resolve.test.ts).
        noResultOffer: { kind: "void" },
      },
    ]);
  });

  it("T16: White is the colour ON FILE (the bridge's white_side), a game on file can be resynced, and the revoked seat is named", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "token_revoked", null);
    await sql`update fixture_external_play set white_side = 'away', challenge_id = ${`gm-${s.fixtureId.slice(0, 12)}`}, revoked_seat = 'black' where fixture_id = ${s.fixtureId}`;
    const [row] = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
    expect([row!.whiteSide, row!.canResync, row!.revokedSeat]).toEqual(["away", true, "black"]);
    // Every seat V454 admits reads as itself — counted.
    let checked = 0;
    for (const seat of ["white", "black", "both"] as const) {
      await sql`update fixture_external_play set revoked_seat = ${seat} where fixture_id = ${s.fixtureId}`;
      expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId))[0]!.revokedSeat, seat).toBe(seat);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("T16 (guard C): the organiser who PLAYS on a held board sees it marked seated; another organiser does not", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "aborted", null);
    // The home player is made an admin of the club: they play on this board.
    await sql`insert into org_members (org_id, user_id, role) values (${s.orgId}, ${s.home.userId}, 'admin')`;
    const player = { orgId: s.orgId, via: "session", userId: s.home.userId, role: "admin", keyId: null } as AuthCtx;
    expect((await listNeedsOrganiserExternalPlay(player, s.divisionId)).map((r) => r.seated)).toEqual([true]);
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.seated), "the positive pair").toEqual([false]);
  });

  it("the SEQUENCE through every other status: listed only while needs_organiser", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "aborted", null);
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.reason)).toEqual(["aborted"]);
    // V451's status CHECK, minus needs_organiser — typed from the migration.
    const others = ["pending", "ready", "live", "finished"];
    let checked = 0;
    for (const status of others) {
      await sql`update fixture_external_play set status = ${status}, needs_reason = null where fixture_id = ${s.fixtureId}`;
      expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId), status).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every other status").toBe(4);
    await sql`
      update fixture_external_play set status = 'needs_organiser', needs_reason = 'mismatch'
       where fixture_id = ${s.fixtureId}`;
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.reason), "back again").toEqual([
      "mismatch",
    ]);
  });

  it("every reason V451 admits is listed as itself, and the TS vocabulary IS the CHECK", async () => {
    // The authority is the database: read the needs_reason CHECK's literals.
    const [def] = await sql<{ d: string }[]>`
      select pg_get_constraintdef(c.oid) as d from pg_constraint c
       where c.conrelid = 'fixture_external_play'::regclass
         and pg_get_constraintdef(c.oid) like '%needs_reason = ANY%'`;
    const dbReasons = [...(def?.d ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(dbReasons.length, "premise: the CHECK was found and parsed").toBeGreaterThan(0);
    expect([...NEEDS_REASONS].sort()).toEqual(dbReasons);

    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", NEEDS_REASONS[0]!, null);
    let checked = 0;
    for (const reason of dbReasons) {
      await sql`update fixture_external_play set needs_reason = ${reason} where fixture_id = ${s.fixtureId}`;
      const rows = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
      expect(rows.map((r) => r.reason), reason).toEqual([reason]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every reason in the CHECK").toBe(dbReasons.length);
  });

  it("another division of the SAME organisation keeps its own queue; a nameless pairing reads as empty names", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "no_show_both", null);
    const other = await createDivision(s.auth, s.competitionId, {
      name: "Second",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
    });
    const [stage] = await createStages(s.auth, other.id, { seq: 1, kind: "league", name: "RR", config: {} });
    const [fx] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, scheduled_at)
      values (${stage!.id}, ${other.id}, ${s.orgId}, 1, 1, ${`q2-${s.fixtureId.slice(0, 6)}`}, 'scheduled', ${T})
      returning id`;
    await bridge(fx!.id, s.orgId, "needs_organiser", "token_revoked", null);
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.fixtureId)).toEqual([s.fixtureId]);
    const second = await listNeedsOrganiserExternalPlay(s.auth, other.id);
    expect(second.map((r) => [r.fixtureId, r.homeName, r.awayName, r.reason])).toEqual([
      [fx!.id, "", "", "token_revoked"],
    ]);
  });

  it("TENANCY: another organisation's row is never listed, even asked for by its division id", async () => {
    const a = await seeded();
    const b = await seeded();
    await bridge(b.fixtureId, b.orgId, "needs_organiser", "provider_error", null);
    // The positive pair first: the row is real and eligible for its own org.
    expect((await listNeedsOrganiserExternalPlay(b.auth, b.divisionId)).map((r) => r.fixtureId)).toEqual([
      b.fixtureId,
    ]);
    expect(await listNeedsOrganiserExternalPlay(a.auth, b.divisionId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("listNeedsOrganiserExternalPlay — a fixture settled through ANOTHER path leaves the queue", () => {
  // T6 follow-up review Minor 8 / T12 addendum 3: the queue lists fixtures
  // WAITING for an organiser decision. One already decided, voided or
  // withdrawn has had its decision, whatever its bridge row still says.
  const listed = async (s: Awaited<ReturnType<typeof seeded>>) =>
    (await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.fixtureId);

  it("the positive pair: a held fixture still to be played is listed", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "tiebreak_owed", null);
    expect(await listed(s)).toEqual([s.fixtureId]);
  });

  it("WITHDRAWN: a player withdrew (league expunge abandons the board) ⇒ not listed", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "token_revoked", null);
    expect(await listed(s), "premise: listed before").toEqual([s.fixtureId]);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
    expect(fx!.status, "premise: the withdrawal settled the board").toBe("abandoned");
    expect(await listed(s)).toEqual([]);
  });

  it("VOIDED: the organiser voided the match in the console (core.abandon) ⇒ not listed", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "aborted", null);
    await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.abandon", payload: { reason: "void" } });
    expect(await listed(s)).toEqual([]);
  });

  it("DECIDED by hand, and a WALKOVER: the organiser entered the outcome ⇒ not listed — counted", async () => {
    let checked = 0;
    for (const decide of [
      { type: "boardgame.result", payload: (away: string) => ({ winner: away, method: "adjudication" }) },
      { type: "core.forfeit", payload: (away: string) => ({ by: away, reason: "walkover" }) },
    ]) {
      const s = await seeded();
      await bridge(s.fixtureId, s.orgId, "needs_organiser", "double_walkover_blocked", null);
      await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(s.auth, s.fixtureId, { expected_seq: 1, type: decide.type, payload: decide.payload(s.away.entrantId) });
      expect(await listed(s), decide.type).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("every fixture status the CHECK admits: listed exactly while nobody has decided the fixture — counted", async () => {
    // The authority on the set is the database. Each status is SQL-set
    // (standing for the writer that produces it) on one held fixture.
    const [def] = await sql<{ d: string }[]>`
      select pg_get_constraintdef(c.oid) as d from pg_constraint c
       where c.conrelid = 'fixtures'::regclass and c.conname = 'fixtures_status_check'`;
    const statuses = [...(def?.d ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(statuses.length, "premise: the CHECK was found and parsed").toBeGreaterThan(0);
    // The rulebook: still to be played (no result yet) ⇒ waiting; any
    // outcome, a void, a withdrawal or a cancellation ⇒ decided. A status
    // the CHECK gains later fails here until someone places it.
    // `needs_decision` (W2a, main's V432 — gained at the 2026-10-11 rebase):
    // a bracket match played to a LEVEL outcome, held for the organiser's
    // settle on W2a's own surface. It carries an outcome, so by the rule
    // above it is decided for this queue — one zone per fixture. Placed
    // pending the controller's ruling (rebase report); listing it instead is
    // a product change to queue.ts, not a table edit.
    const OPEN = new Set(["scheduled", "in_play"]);
    const SETTLED = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled", "needs_decision"]);
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "provider_error", null);
    let listedCount = 0;
    let hiddenCount = 0;
    for (const status of statuses) {
      expect(OPEN.has(status) || SETTLED.has(status), `rulebook places ${status}`).toBe(true);
      await sql`update fixtures set status = ${status} where id = ${s.fixtureId}`;
      expect(await listed(s), status).toEqual(OPEN.has(status) ? [s.fixtureId] : []);
      if (OPEN.has(status)) listedCount++;
      else hiddenCount++;
    }
    expect(listedCount, "anti-vacuity: open statuses checked").toBe(OPEN.size);
    expect(hiddenCount, "anti-vacuity: settled statuses checked").toBe(SETTLED.size);
  });
});

describe.skipIf(!HAS_DB)("T16 fix round 1, I2 (F5): a held card names the PERSON, never the entrant snapshot", () => {
  // A 43-character name — the width the canvas is drawn for — on a person whose singles entrant row still reads
  // "Entry 3" (the registration snapshot). The rulebook (lib/entrant-name.ts): a singles entrant reads as its
  // person. The Flagged list and the Open-round confirmation already resolve it so (loadSides); the queue did not,
  // so one board carried two names on one screen.
  const LONG = "Maximiliana Wolfeschlegel-Featherstonehaugh";
  it("the held card reads the person's 43-character name; the other side keeps its own; a pair stays its snapshot", async () => {
    expect(LONG.length, "premise: the canvas width").toBe(43);
    const s = await seeded();
    await sql`update entrants set display_name = 'Entry 3' where id = ${s.home.entrantId}`;
    await sql`update persons set full_name = ${LONG} where id = ${s.home.personId}`;
    const [{ name: awayName }] = await sql<{ name: string }[]>`select full_name as name from persons where id = ${s.away.personId}`;
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "fair_play", null);
    const [row, ...rest] = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
    expect(rest).toEqual([]);
    expect([row!.homeName, row!.awayName]).toEqual([LONG, awayName]);
    expect(row!.homeName, "never the snapshot").not.toBe("Entry 3");
  });

  it("the empty case: an entrant with NO member left (a merge tombstone) falls back to its snapshot, never its id", async () => {
    const s = await seeded();
    await sql`update entrants set display_name = 'Entry 3' where id = ${s.home.entrantId}`;
    await sql`delete from entrant_members where entrant_id = ${s.home.entrantId}`;
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "fair_play", null);
    const [row] = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
    expect(row!.homeName).toBe("Entry 3");
    expect(row!.homeName).not.toBe(s.home.entrantId);
  });
});

describe.skipIf(!HAS_DB)("a fair-play verdict reaches the organiser under its OWN reason (T12 fix round 1, I2)", () => {
  it("a fair_play hold is listed as fair_play — never folded into provider_error", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "fair_play", "lichess game X: status cheat");
    const rows = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
    expect(rows.map((r) => [r.fixtureId, r.reason])).toEqual([[s.fixtureId, "fair_play"]]);
  });
});

describe("the fair-play reason has organiser copy in all four locales", () => {
  // T16 maps reasons to labels; the copy itself ships with the reason, so the
  // queue can never meet a fair_play row with nothing of its own to show.
  it("each locale carries its own sentence, distinct from the provider-error sentence — counted", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../dictionaries");
    const LOCALES = ["en", "es", "fr", "nl"] as const;
    const read = (l: string) => JSON.parse(readFileSync(join(dir, l, "ui.json"), "utf8")) as Record<string, string>;
    const en = read("en");
    let checked = 0;
    for (const l of LOCALES) {
      const d = read(l);
      const text = d["externalPlay.reason.fairPlay"];
      expect(text, `${l}: present`).toBeTruthy();
      // T12 fix I2: a fair-play verdict is never folded into provider_error — nor may its copy read as one. (The
      // generic label is retired: external-play-reason-map.test.ts.)
      expect(d["externalPlay.reason.providerError"], `${l}: premise — present`).toBeTruthy();
      expect(text, `${l}: not the provider-error sentence`).not.toBe(d["externalPlay.reason.providerError"]);
      if (l !== "en") expect(text, `${l}: translated, not English`).not.toBe(en["externalPlay.reason.fairPlay"]);
      checked++;
    }
    expect(checked, "locales checked").toBe(LOCALES.length);
  });
});

describe("readNeedsReason — the CHECK makes junk impossible; the reader still refuses it", () => {
  it("passes each declared reason through and refuses anything else with a 500", () => {
    let checked = 0;
    for (const r of NEEDS_REASONS) {
      expect(readNeedsReason(r)).toBe(r);
      checked += 1;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    for (const junk of [null, "no_show_grace_elapsed", "", 1]) {
      let caught: unknown;
      try {
        readNeedsReason(junk);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(junk)).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(500);
      expect((caught as HttpError).code).toBe("NEEDS_REASON_UNKNOWN");
    }
  });
});
