// W2b Task 16 round 2, owner ruling 116 (_INDEX 116; X-WD-3, X-WD-5): a knockout winner who withdraws while her next
// tie's opponent is still TBD leaves that seat dead, and the arriving opponent walks over it. That tie was stored as a
// BYE ({award, loser: null, reason: "bye"}), so every surface read "Bye" and none said that a side had withdrawn. It
// now reads "w/o" and names the withdrawn side, like any other walkover: the award names her as its loser, reason
// "withdrew" — while she is still never seated in it (the seat stays dead).
//
// Through the usecases the buttons call (Score, Withdraw, Complete) and the public's own reads: the division read
// (`getPublicDivision` → `bracketForfeitWords`, the schedule's and the bracket's words), the hub card
// (`loadCompetitionHub`) and the match page (`loadMatchCentre`). The copy is the en dictionary's, never the reader's.
// Two sports (badminton's games, football's goals); the positive pairs are a genuine bye of an odd draw and a dead seat
// that no departure made (a double walkover's), each still a bye that reads no forfeit.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { bracketForfeitWords } from "@/lib/bracket-forfeit-words";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, labelOf, post, rowsOf, seatOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { getPublicDivision, type PublicFixture } from "@/server/public-site/data";
import { loadMatchCentre, type MatchCentreLoadCtx } from "@/server/public-site/match-centre-load";
import { completeStage } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

// The public reads go through `unstable_cache`, which has no incrementalCache outside a real request: a passthrough,
// never a memoising double (competition-hub-db.test.ts's own reason).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const EN = enPublic as unknown as Dict;
const en = (key: string, vars?: Record<string, string>) => t(EN, key, vars);
const BYE_KEY = "bracket.slot.bye";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A line played to a home win, in the sport's own events. */
type Play = (auth: AuthCtx, id: string) => Promise<FixtureRow>;
const decided = async (id: string, what: string): Promise<FixtureRow> => {
  const r = await fixtureRow(id);
  if (r.status !== "decided") throw new Error(`rig: ${what} ${r.ext_key} did not decide (${r.status})`);
  return r;
};
const SPORTS: readonly { sport: string; variant: string; play: Play }[] = [
  {
    sport: "badminton",
    variant: declaredVariant("badminton", "bwf"),
    play: async (auth, id) => {
      await post(auth, id, "core.start");
      for (let g = 0; g < 2; g++) await post(auth, id, "badminton.game.summary", { home: 21, away: 10 });
      return decided(id, "badminton");
    },
  },
  {
    sport: "football",
    variant: declaredVariant("football", "11-a-side"),
    play: async (auth, id) => {
      const r = await fixtureRow(id);
      await post(auth, id, "core.start");
      await post(auth, id, "football.goal", { by: r.home_entrant_id });
      await post(auth, id, "football.period", { phase: "HT" });
      await post(auth, id, "football.period", { phase: "FT" });
      return decided(id, "football");
    },
  },
];

/** Two seated first-round lines that feed one later fixture, from the generated feed graph. */
function siblingsInto(rows: readonly FixtureRow[]): { a: FixtureRow; b: FixtureRow; parentId: string } {
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
  for (const a of r1) {
    const b = r1.find((x) => x.id !== a.id && x.winner_to_fixture !== null && x.winner_to_fixture === a.winner_to_fixture);
    if (b) return { a, b, parentId: a.winner_to_fixture! };
  }
  throw new Error("rig: no two seated first-round lines feed one fixture");
}

const nameOf = async (id: string) => (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${id}`)[0]!.display_name;
const activeEvents = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`)[0]!.n;

/** Publish the seeded competition and read the public's own documents of it. */
async function publicOf(s: { competitionId: string; divisionId: string }) {
  await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
  const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div from divisions d
    join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${s.divisionId}`;
  const detail = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
  const names = Object.fromEntries(detail.entrants.map((e) => [e.id, e.display_name]));
  const words = bracketForfeitWords(detail.fixtures, names, forfeitCopyOf((k) => en(k)));
  const hub = (await loadCompetitionHub(slugs!.org, slugs!.comp))!;
  return { detail, words, hub };
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
    stage: { name: "Cup", roundLabel: null },
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
  };
}

describe.skipIf(!HAS_DB)("ruling 116: a withdrawn knockout winner's next tie is a walkover naming who withdrew", () => {
  it("every sport: the tie is stored {award, loser: her, reason withdrew}, she is never seated, and schedule, bracket, hub and match page read w/o naming her", async () => {
    let checked = 0;
    for (const { sport, variant, play } of SPORTS) {
      const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
      const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
      const w1 = (await play(s.auth, a.id)).home_entrant_id!;
      const seat = a.winner_to_slot!;
      expect(seatOf(await fixtureRow(parentId), seat), `${sport}: premise, the winner is seated in her next tie`).toBe(w1);
      // She withdraws while that tie's other seat is TBD (X-WD-3): her seat is emptied and stamped dead.
      const out = await withdrawEntrantCascade(s.auth, w1);
      expect(out, sport).toMatchObject({ entrant_id: w1, status: "withdrawn", policy: "walkover", walkovers: 1, voided: 0 });
      const waiting = await fixtureRow(parentId);
      expect([seatOf(waiting, seat), labelOf(waiting, seat), waiting.status, waiting.outcome], `${sport}: dead, waiting`).toEqual([null, BYE_KEY, "scheduled", null]);
      // The other line is played: its winner arrives and walks over the dead seat in the same write.
      const arriving = (await play(s.auth, b.id)).home_entrant_id!;
      const tie = await fixtureRow(parentId);
      expect([tie.status, tie.outcome], `${sport}: a walkover naming who withdrew`).toEqual([
        "forfeited",
        { kind: "award", winner: arriving, loser: w1, reason: "withdrew" },
      ]);
      expect(seatOf(tie, seat), `${sport}: she is never seated in it (X-WD-3)`).toBeNull();
      expect(labelOf(tie, seat), `${sport}: the seat stays dead`).toBe(BYE_KEY);
      expect(await activeEvents(parentId), `${sport}: no event — nobody played it`).toBe(0);
      expect(seatOf(await fixtureRow(tie.winner_to_fixture!), tie.winner_to_slot), `${sport}: the arriving side goes on`).toBe(arriving);

      // The public surfaces, through their own reads.
      const want = { kind: "withdrew", tag: en("forfeit.tag.walkover"), sentence: en("forfeit.sentence.withdrew", { loser: await nameOf(w1) }) };
      expect(want.sentence, `${sport}: premise, the sentence names her`).toContain(await nameOf(w1));
      const pub = await publicOf(s);
      expect(pub.words.get(parentId), `${sport}: schedule and bracket`).toEqual(want);
      expect(pub.hub.matches.find((m) => m.fixtureId === parentId)?.forfeit, `${sport}: the hub card`).toEqual(want);
      const doc = await loadMatchCentre(sql, await publicRow(parentId), await matchCentreCtx(s.divisionId));
      expect(doc.header.statusLine, `${sport}: the match page`).toEqual({ key: "forfeit.sentence.withdrew", params: { loser: await nameOf(w1) } });
      expect(t(EN, doc.header.statusLine!.key, doc.header.statusLine!.params), sport).toBe(want.sentence);
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it("the ranks do not move: she is no loser of a tie she never sat in, so she ranks where a departed entrant always has — below every field entrant", async () => {
    // single-sport: badminton — the ranks read the stored outcomes, not the sport.
    const { sport, variant, play } = SPORTS[0]!;
    const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 4 });
    const { a, b } = siblingsInto(await rowsOf(s.stageId));
    const w1 = (await play(s.auth, a.id)).home_entrant_id!;
    await withdrawEntrantCascade(s.auth, w1);
    const finalist = (await play(s.auth, b.id)).home_entrant_id!;
    const final = await fixtureRow(a.winner_to_fixture!);
    expect([final.status, final.outcome], "premise: the final walks over, naming her").toEqual([
      "forfeited",
      { kind: "award", winner: finalist, loser: w1, reason: "withdrew" },
    ]);
    const done = await completeStage(s.auth, s.stageId);
    const ev = done.events.find((e) => e.type === "stage_completed");
    const ranks = ev?.type === "stage_completed" ? ev.finalRanks : [];
    expect(done.completed).toBe(true);
    expect(ranks[0], "the arriving side is champion").toBe(finalist);
    // The rule the stepladder pin states (withdrawal-w2b.test.ts): where a departed entrant ranks is not ruled, and it
    // is never above a field entrant. Ruling 116 is copy: it names her, it does not make her a finalist.
    const field = ranks.filter((id) => id !== w1);
    expect(field.length, "the field is ranked").toBe(3);
    expect([-1, ranks.length - 1], `she ranks last or not at all (${ranks.indexOf(w1)} of ${ranks.length})`).toContain(ranks.indexOf(w1));
  }, 120_000);

  it("the positive pairs: a genuine bye of an odd draw, and a dead seat a double walkover made, stay byes that read no forfeit", async () => {
    // single-sport: badminton — the byes and the double walkover are written with no sport event.
    const { sport, variant, play } = SPORTS[0]!;
    // An odd field: six entrants in an eight-line draw, so two first-round lines are byes.
    const odd = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 6 });
    const byes = (await rowsOf(odd.stageId)).filter((r) => (r.outcome as { reason?: unknown } | null)?.reason === "bye");
    expect(byes.length, "the odd draw has byes").toBe(2);
    for (const r of byes) expect(r.outcome, r.ext_key ?? r.id).toEqual({ kind: "award", winner: r.home_entrant_id ?? r.away_entrant_id, loser: null, reason: "bye" });
    const oddPublic = await publicOf(odd);
    expect(byes.filter((r) => oddPublic.words.has(r.id)).map((r) => r.ext_key), "a bye reads no forfeit words").toEqual([]);

    // A dead seat no departure made: a double walkover's (X-DW-2). Its next tie walks the arriving side over by bye.
    const dw = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(dw.stageId));
    const recorded = await post(dw.auth, a.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect([recorded.status, recorded.outcome], "premise: a double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    const arriving = (await play(dw.auth, b.id)).home_entrant_id!;
    const tie = await fixtureRow(parentId);
    expect([tie.status, tie.outcome], "a bye: nobody withdrew").toEqual(["forfeited", { kind: "award", winner: arriving, loser: null, reason: "bye" }]);
    expect((await publicOf(dw)).words.has(parentId), "and reads no forfeit words").toBe(false);
  }, 240_000);
});
