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
// R116-1 (coordinator ruling on ruling 116): "w/o" beside "Bye" told a viewer two contradictory things. No public
// surface prints the bye word for this tie: each names the withdrawn side in her dead seat, as any walkover names the
// side that did not play — the division page's schedule and bracket (rendered from the page's own tree), the hub card,
// the match page, both kiosk builders (results and bracket), the calendar feed and the poster's draw. A genuine bye,
// and a dead seat nobody withdrew from, still read the bye word on every one of them (the positive pairs).
//
// R116-2 (coordinator ruling): "like any other walkover" includes its score. The tie shows the sport's walkover credit
// — the engine's own (the module's summary over the award, which reads its `forfeitCredit` under the fixture's cfg) —
// equal to Appendix A's declaration from the cfg alone and to an ordinary withdrawal walkover's in the same division.
// It is still no match played in players' stats (X-PS-1), and a genuine bye still shows no score.
//
// Real Postgres required; skipped without DATABASE_URL.
import { builtinModules } from "@seazn/engine/sports";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import enPublic from "@/dictionaries/en/public.json";
import { sql, withTenant } from "@/lib/db";
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
import { Bracket } from "@/components/public-site/bracket";
import { Schedule } from "@/components/public-site/schedule";
import DivisionHomePage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page";
import { GET as calendarFeed } from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route";
import { getDictionary } from "@/lib/i18n";
import { buildDrawModel } from "@/lib/poster-draw";
import { poolLabel } from "@/lib/pool-label";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";
import { buildDivisionSlides, buildPublicDivisionSlides } from "@/server/slideshow-data";
import { fixturesPlayedInStats } from "@/server/usecases/player-stats";
import { buildDivisionDocModel } from "../exports";
import { createPerson } from "../persons";
import { readPlayerMatchLines } from "@/server/public-site/public-player-matches";
import { playedFixtureIds } from "../fixture-results-sql";
import { randomUUID } from "node:crypto";
import { cardTitle, type BoardFixture } from "@/components/v2/board/types";
import { listDivisionFixturesForBoard } from "../fixtures";
import { listEntrants } from "../entrants";
import { createOfficial, inviteOfficial, patchFixtureOfficials } from "../officials";
import { claimPerson } from "../person-claims";
import { getMyOfficiating } from "../me-officiating";

// The public reads go through `unstable_cache`, which has no incrementalCache outside a real request: a passthrough,
// never a memoising double (competition-hub-db.test.ts's own reason).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
// R116-4: the officials' assignment email is read off its send — the real template's input, never a mail transport.
const mail = vi.hoisted(() => ({ assigned: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendOfficialAssignedEmail: mail.assigned,
}));

const HAS_DB = !!process.env.DATABASE_URL;
const EN = enPublic as unknown as Dict;
const en = (key: string, vars?: Record<string, string>) => t(EN, key, vars);
const BYE_KEY = "bracket.slot.bye";
/** The bye word as the org's (en) dictionary prints it — the copy, never a literal typed here. */
const BYE = msgFor("en", BYE_KEY);
const BYE_WORD = new RegExp(`\\b${BYE}\\b`, "i");
const WO = en("forfeit.tag.walkover");

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

/** R116-2 — Appendix A's walkover credit to the side that turned up, from the cfg alone (the engine's own table,
 *  forfeit-credit.test.ts `EXPECTED_WALKOVER`): football's `awardScore.goals` (FB-WO-1), badminton's best-of majority
 *  of games (the set sports' rule). Never read back from `forfeitCredit` or a summary. */
const WALKOVER_CREDIT: Record<string, (cfg: Record<string, unknown>) => number> = {
  football: (c) => (c.awardScore as { goals: number }).goals,
  badminton: (c) => Math.ceil((c.bestOf as number) / 2),
};
/** The division's cfg as its module parses it, with the sport and module version the stats reader keys on. */
async function divisionOf(divisionId: string) {
  const [d] = await sql<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${divisionId}`;
  const m = builtinModules.find((x) => x.key === d!.sport_key)!;
  return { cfg: m.configSchema.parse(d!.config ?? {}) as Record<string, unknown>, sport_key: d!.sport_key, module_version: d!.module_version };
}
/** A fixture's stored score lines by entrant (the summary every surface reads), or null when it has none. */
async function storedLines(id: string): Promise<Record<string, string> | null> {
  const [r] = await sql<{ summary: { perSide: { entrantId: string; line: string }[] } | null }[]>`
    select summary from public_fixtures_v where id = ${id}`;
  return r?.summary == null ? null : Object.fromEntries(r.summary.perSide.map((p) => [p.entrantId, p.line]));
}

/** Publish the seeded competition and read the public's own documents of it. */
async function publicOf(s: { competitionId: string; divisionId: string }) {
  // An end date, so the calendar feed carries an untimed fixture (it anchors one to the competition's last day).
  await sql`update competitions set visibility = 'public', ends_on = coalesce(ends_on, '2026-12-31') where id = ${s.competitionId}`;
  const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div from divisions d
    join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${s.divisionId}`;
  const detail = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
  const names = Object.fromEntries(detail.entrants.map((e) => [e.id, e.display_name]));
  const words = bracketForfeitWords(detail.fixtures, names, forfeitCopyOf((k) => en(k)));
  const hub = (await loadCompetitionHub(slugs!.org, slugs!.comp))!;
  return { detail, words, hub, slugs: slugs!, names };
}

/** Every element of `type` anywhere in a server component's returned tree (page-bracket-slot-labels.test.ts). */
function findElements(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, out);
  } else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) findElements(value, type, out);
  }
  return out;
}
const decode = (html: string) =>
  html.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The visible text of the ONE link to a fixture in rendered markup (a schedule row, a bracket card), and its markup. */
function linkTo(html: string, fixtureId: string, where: string): { text: string; markup: string } {
  const all = [...html.matchAll(new RegExp(`<a[^>]*href="[^"]*/fixtures/${fixtureId}"[^>]*>([\\s\\S]*?)</a>`, "g"))];
  if (all.length !== 1) throw new Error(`${where}: ${all.length} links to ${fixtureId}, wanted exactly one`);
  const markup = all[0]![0];
  return { markup, text: decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() };
}

/** One fixture as every public surface prints it, each through its own builder over the real rows: the visible text
 *  per surface, plus the hub's bye flags. The division page is the page's own tree (its Schedule and Bracket elements,
 *  rendered); the kiosk is both builders; the calendar is the feed's own route; the poster's draw is `buildDrawModel`
 *  with the namer the poster route hands it. */
async function surfacesOf(
  s: { auth: AuthCtx; competitionId: string; divisionId: string },
  fixtureId: string,
): Promise<{
  text: Record<string, string>;
  hubByeSides: readonly boolean[] | undefined;
  sideIds: Record<string, string[]>;
  scores: Record<string, Record<string, string | null>>;
}> {
  const pub = await publicOf(s);
  const tie = pub.detail.fixtures.find((f) => f.id === fixtureId);
  if (!tie) throw new Error(`rig: ${fixtureId} is not in the public division read`);
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: pub.slugs.org, competitionSlug: pub.slugs.comp, divisionSlug: pub.slugs.div }),
  });
  const [schedule] = findElements(root, Schedule);
  const [bracket] = findElements(root, Bracket);
  if (!schedule || !bracket) throw new Error("rig: the division page built no Schedule or no Bracket");
  const hub = pub.hub.matches.find((m) => m.fixtureId === fixtureId);
  if (!hub) throw new Error(`rig: the hub carries no card for ${fixtureId}`);
  const doc = await loadMatchCentre(sql, await publicRow(fixtureId), await matchCentreCtx(s.divisionId));
  // The kiosk: a results row has no fixture id, so it is found by its round, its status and the side that is seated.
  const seated = tie.home_entrant_id ?? tie.away_entrant_id;
  const seatedName = seated === null ? null : pub.names[seated];
  const kioskRow = (slides: Awaited<ReturnType<typeof buildPublicDivisionSlides>>, where: string) => {
    const rows = slides.flatMap((sl) => (sl.kind === "fixtures" ? sl.items : []))
      .filter((i) => i.round === tie.round_no && i.status === tie.status && (i.home === seatedName || i.away === seatedName));
    if (rows.length !== 1) throw new Error(`${where}: ${rows.length} rows for ${fixtureId}, wanted one`);
    return `${rows[0]!.home} ${rows[0]!.away}`;
  };
  const kioskNode = (slides: Awaited<ReturnType<typeof buildPublicDivisionSlides>>, where: string) => {
    const node = slides.flatMap((sl) => (sl.kind === "bracket" ? sl.fixtures : [])).find((f) => f.id === fixtureId);
    if (!node) throw new Error(`${where}: no bracket node for ${fixtureId}`);
    return `${node.home ?? ""} ${node.away ?? ""}`;
  };
  const kiosk = await buildPublicDivisionSlides({ ...pub.detail, orgLocale: "en" });
  const orgKiosk = await buildDivisionSlides(s.auth, s.divisionId, pub.detail.division.name);
  // The calendar feed: the fixture's VEVENT, its folded lines unfolded (RFC 5545 §3.1).
  const ics = (await (await calendarFeed(new Request("http://localhost/calendar.ics"), {
    params: Promise.resolve({ orgSlug: pub.slugs.org, competitionSlug: pub.slugs.comp, divisionSlug: pub.slugs.div }),
  })).text()).replace(/\r?\n[ \t]/g, "");
  const event = ics.split("BEGIN:VEVENT").find((e) => e.includes(`UID:${fixtureId}`));
  const summary = event?.split(/\r?\n/).find((l) => l.startsWith("SUMMARY:"));
  if (summary === undefined) throw new Error(`calendar: no SUMMARY for ${fixtureId}`);
  // The poster's draw, with the seat namer the poster route hands `buildDrawModel`.
  const lookup = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);
  const kindById = new Map(pub.detail.stages.map((st) => [st.id, st.kind]));
  const dict = await getDictionary("en", "public");
  const namer = publicRoundNamer({ ui: lookup, dict, fixtures: pub.detail.fixtures, stageKind: (id) => kindById.get(id) });
  const draw = buildDrawModel(
    {
      stages: pub.detail.stages,
      pools: pub.detail.pools,
      fixtures: pub.detail.fixtures,
      entrantNames: pub.names,
      seatText: (id, seat, label) => namer.seat(id, seat, label),
      poolText: (key) => poolLabel(dict, key),
    },
    lookup,
  );
  const drawRow = JSON.stringify(draw).match(new RegExp(`\\{"id":"${fixtureId}","home":("[^"]*"),"away":("[^"]*")\\}`));
  if (!drawRow) throw new Error(`poster: no draw row for ${fixtureId}`);
  return {
    text: {
      schedule: linkTo(renderToStaticMarkup(schedule), fixtureId, "schedule").text,
      bracket: linkTo(renderToStaticMarkup(bracket), fixtureId, "bracket").text,
      hub: hub.header.sides.map((x) => x.name).join(" "),
      "match page": doc.header.sides.map((x) => x.name).join(" "),
      "kiosk results": kioskRow(kiosk, "kiosk"),
      "kiosk bracket": kioskNode(kiosk, "kiosk"),
      "organiser kiosk results": kioskRow(orgKiosk, "organiser kiosk"),
      "organiser kiosk bracket": kioskNode(orgKiosk, "organiser kiosk"),
      calendar: summary,
      "poster draw": `${JSON.parse(drawRow[1]!)} ${JSON.parse(drawRow[2]!)}`,
    },
    hubByeSides: hub.byeSides,
    // Who each side IS on the two surfaces that draw a crest: "" is the waiting-slot look (the "?" crest, muted italic).
    sideIds: { hub: hub.header.sides.map((x) => x.entrantId), "match page": doc.header.sides.map((x) => x.entrantId) },
    // R116-2 — the score each crest-drawing surface prints beside each side, keyed by who the side is.
    scores: {
      hub: Object.fromEntries(hub.header.sides.map((x, i) => [x.entrantId, hub.header.scoreLines[i] ?? null])),
      "match page": Object.fromEntries(doc.header.sides.map((x, i) => [x.entrantId, doc.header.scoreLines[i] ?? null])),
    },
  };
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
    let surfaces = 0;
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
      // Loop R M-10: the hub card also says nothing was played (no event at all), so a final's banner reads the walkover line.
      expect(pub.hub.matches.find((m) => m.fixtureId === parentId)?.forfeit, `${sport}: the hub card`).toEqual({ ...want, played: false });
      const doc = await loadMatchCentre(sql, await publicRow(parentId), await matchCentreCtx(s.divisionId));
      expect(doc.header.statusLine, `${sport}: the match page`).toEqual({ key: "forfeit.sentence.withdrew", params: { loser: await nameOf(w1) } });
      expect(t(EN, doc.header.statusLine!.key, doc.header.statusLine!.params), sport).toBe(want.sentence);

      // R116-1: no surface prints the bye word for this tie — each names her in her dead seat, as any walkover names the
      // side that did not play; the schedule row and the bracket card carry the w/o tag beside it.
      const her = await nameOf(w1);
      const seen = await surfacesOf(s, parentId);
      for (const [where, text] of Object.entries(seen.text)) {
        expect(text, `${sport}: ${where} names her`).toContain(her);
        expect(text, `${sport}: ${where} prints no "${BYE}"`).not.toMatch(BYE_WORD);
        surfaces++;
      }
      expect(seen.text.schedule, `${sport}: the schedule row's tag`).toContain(WO);
      expect(seen.text.bracket, `${sport}: the bracket card's tag`).toContain(WO);
      expect(seen.hubByeSides, `${sport}: the hub card flags no bye side`).toEqual([false, false]);
      // …and draws her as a side, the way any walkover draws the side that did not play: her id, never the waiting slot.
      for (const [where, ids] of Object.entries(seen.sideIds)) {
        expect([...ids].sort(), `${sport}: ${where} draws both sides as entrants`).toEqual([w1, arriving].sort());
        surfaces++;
      }

      // R116-2: the sport's walkover credit, like any walkover — Appendix A's declaration under the division's cfg, to
      // the side that turned up, nil to her. The credit must differ from an unplayed 0, or nothing here could tell.
      const division = await divisionOf(s.divisionId);
      const credit = WALKOVER_CREDIT[sport]!(division.cfg);
      expect(credit, `${sport}: premise, the walkover credits something`).toBeGreaterThan(0);
      const wantLines = { [arriving]: String(credit), [w1]: "0" };
      expect(await storedLines(parentId), `${sport}: the stored summary every surface reads`).toEqual(wantLines);
      for (const [where, byId] of Object.entries(seen.scores)) {
        expect(byId, `${sport}: ${where} shows the walkover credit`).toEqual(wantLines);
        surfaces++;
      }
      // …the SAME credit an ordinary withdrawal walkover shows in this division: another seated first-round line, one
      // of whose sides withdraws before it is played (the cascade's `core.forfeit{reason: "withdrew"}`).
      const ordinary = (await rowsOf(s.stageId)).find(
        (r) => r.round_no === a.round_no && r.id !== a.id && r.id !== b.id && r.home_entrant_id && r.away_entrant_id && r.status === "scheduled",
      );
      if (!ordinary) throw new Error(`rig: ${sport} has no unplayed seated first-round line left`);
      await withdrawEntrantCascade(s.auth, ordinary.away_entrant_id!);
      const walked = await fixtureRow(ordinary.id);
      expect([walked.status, walked.outcome], `${sport}: premise, an ordinary withdrawal walkover`).toEqual([
        "forfeited",
        { kind: "award", winner: ordinary.home_entrant_id, loser: ordinary.away_entrant_id, reason: "withdrew" },
      ]);
      const ordinaryLines = (await storedLines(ordinary.id))!;
      expect(
        [ordinaryLines[ordinary.home_entrant_id!], ordinaryLines[ordinary.away_entrant_id!]],
        `${sport}: ruling 116's tie shows what any withdrawal walkover shows`,
      ).toEqual([wantLines[arriving], wantLines[w1]]);
      // X-PS-1: still no match played, for anybody — the stats reader's own answer; a line played is its positive pair.
      const played = await fixturesPlayedInStats(sql, [parentId, a.id].map((id) => ({ id, ...division })));
      expect([played.has(parentId), played.has(a.id)], `${sport}: no match played (X-PS-1); the played line is`).toEqual([false, true]);
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(surfaces, "every surface, every sport").toBe(SPORTS.length * 14);
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
    // R116-1's positive pair: a genuine bye still prints the bye word on every surface, and no w/o.
    let byeSurfaces = 0;
    const stillBye = async (seed: typeof odd, id: string, what: string) => {
      const seen = await surfacesOf(seed, id);
      for (const [where, text] of Object.entries(seen.text)) {
        expect(text, `${what}: ${where} still reads "${BYE}"`).toMatch(BYE_WORD);
        expect(text, `${what}: ${where} carries no w/o`).not.toContain(WO);
        byeSurfaces++;
      }
      expect(seen.hubByeSides?.filter(Boolean).length, `${what}: the hub flags its bye side`).toBe(1);
      for (const [where, ids] of Object.entries(seen.sideIds)) {
        expect(ids.filter((x) => x === "").length, `${what}: ${where} keeps the empty seat a slot`).toBe(1);
        byeSurfaces++;
      }
      // R116-2's positive pair: a bye credits no score — nothing stored, nothing printed beside either side.
      expect(await storedLines(id), `${what}: no stored summary`).toBeNull();
      for (const [where, byId] of Object.entries(seen.scores)) {
        expect(Object.values(byId), `${what}: ${where} shows no score`).toEqual([null, null]);
        byeSurfaces++;
      }
    };
    await stillBye(odd, byes[0]!.id, "a genuine bye");

    // A dead seat no departure made: a double walkover's (X-DW-2). Its next tie walks the arriving side over by bye.
    const dw = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(dw.stageId));
    const recorded = await post(dw.auth, a.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect([recorded.status, recorded.outcome], "premise: a double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    const arriving = (await play(dw.auth, b.id)).home_entrant_id!;
    const tie = await fixtureRow(parentId);
    expect([tie.status, tie.outcome], "a bye: nobody withdrew").toEqual(["forfeited", { kind: "award", winner: arriving, loser: null, reason: "bye" }]);
    expect((await publicOf(dw)).words.has(parentId), "and reads no forfeit words").toBe(false);
    await stillBye(dw, parentId, "a double walkover's dead seat");
    expect(byeSurfaces, "every surface, both byes").toBe(2 * 14);
  }, 240_000);
  it("R116-3: the organiser's exports name her in her dead seat, and the board holds the tie as it holds any walkover; a bye and a DQ'd winner's dead seat keep the bye", async () => {
    // single-sport: badminton — the exports and the board's played set read the seats, the outcome and the evidence
    // rows, never the sport.
    const { sport, variant, play } = SPORTS[0]!;
    const PRINTED = "2026-10-12T09:00:00.000Z";
    /** Timetable rows as [home, away] (`fixtureRows`: time, court, home, result, away, stage). */
    const timetablePairs = async (divisionId: string, auth: AuthCtx) =>
      (await buildDivisionDocModel(auth, divisionId, "timetable", { printedAt: PRINTED })).sections
        .flatMap((x) => x.table?.rows ?? [])
        .map((r) => [String(r[2]), String(r[4])]);
    const posterNode = async (divisionId: string, auth: AuthCtx, id: string) => {
      const node = (await buildDivisionDocModel(auth, divisionId, "bracket", { printedAt: PRINTED })).bracket?.nodes.find((x) => x.fixtureId === id);
      if (!node) throw new Error(`rig: ${id} is not on the poster`);
      return [node.home, node.away];
    };
    const held = async (seed: { auth: AuthCtx; divisionId: string }) => withTenant(seed.auth.orgId, (tx) => playedFixtureIds(tx, seed.divisionId));
    /** R116-4 — each printed scoresheet as its JSON text (a sport template emits its own section shape; the names are
     *  the strings it was handed, `home` before `away`). */
    const scoresheets = async (divisionId: string, auth: AuthCtx) =>
      (await buildDivisionDocModel(auth, divisionId, "scoresheet", { printedAt: PRINTED })).sections.map((x) => JSON.stringify(x));

    // Ruling 116's tie, and an ordinary withdrawal walkover in the same division as its oracle — her dead seat on each
    // side of the tie, so either seat's read is reached.
    const seats = new Set<number>();
    for (const flip of [false, true]) {
      const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
      const sib = siblingsInto(await rowsOf(s.stageId));
      const [mine, other] = flip ? [sib.b, sib.a] : [sib.a, sib.b];
      const w1 = (await play(s.auth, mine.id)).home_entrant_id!;
      await withdrawEntrantCascade(s.auth, w1);
      const arriving = (await play(s.auth, other.id)).home_entrant_id!;
      expect((await fixtureRow(sib.parentId)).outcome, "premise: ruling 116's walkover").toEqual({ kind: "award", winner: arriving, loser: w1, reason: "withdrew" });
      const ordinary = (await rowsOf(s.stageId)).find(
        (r) => r.round_no === mine.round_no && r.id !== mine.id && r.id !== other.id && r.home_entrant_id && r.away_entrant_id && r.status === "scheduled",
      );
      if (!ordinary) throw new Error("rig: no unplayed seated first-round line left");
      await withdrawEntrantCascade(s.auth, ordinary.away_entrant_id!);
      expect((await fixtureRow(ordinary.id)).status, "premise: an ordinary walkover").toBe("forfeited");

      const [her, them] = [await nameOf(w1), await nameOf(arriving)];
      const seat = mine.winner_to_slot!;
      seats.add(seat);
      const want = seat === 1 ? [her, them] : [them, her];
      const pairs = await timetablePairs(s.divisionId, s.auth);
      expect(pairs.length, "the timetable lists the draw").toBeGreaterThan(0);
      expect(pairs.filter((p) => p.includes(her) && p.includes(them)), `seat ${seat}: the timetable names her in her seat`).toEqual([want]);
      expect(pairs.flat(), `seat ${seat}: nothing on this draw prints "${BYE}"`).not.toContain(BYE);
      expect(await posterNode(s.divisionId, s.auth, sib.parentId), `seat ${seat}: the bracket poster names her in her seat`).toEqual(want);
      // R116-4: the tie's scoresheet (an undecided line prints one) names her in her seat — each seat's own call site
      // is reached by one of the two flips.
      const sheets = (await scoresheets(s.divisionId, s.auth)).filter((x) => x.includes(her));
      expect(sheets.length, `seat ${seat}: the tie prints a scoresheet naming her`).toBeGreaterThan(0);
      for (const x of sheets) {
        expect(x.includes(them), `seat ${seat}: her sheet is the tie's, opposite the side that arrived`).toBe(true);
        expect(x.indexOf(her) < x.indexOf(them), `seat ${seat}: her name in her seat on the scoresheet`).toBe(seat === 1);
        expect(x, `seat ${seat}: and no "${BYE}" on it`).not.toContain(`"${BYE}"`);
      }
      // The board: held, as the ordinary walkover is (its recorded forfeit); ruling 116's by its awarded match state.
      const board = await held(s);
      expect([board.has(sib.parentId), board.has(ordinary.id)], `seat ${seat}: both walkovers are held on the board`).toEqual([true, true]);
    }
    expect([...seats].sort(), "both seats reached").toEqual([1, 2]);

    // The pairs. A genuine bye of an odd draw: two byes, each still printed "Bye", and nothing held.
    const odd = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 6 });
    const byes = (await rowsOf(odd.stageId)).filter((r) => (r.outcome as { reason?: unknown } | null)?.reason === "bye");
    expect(byes.length, "the odd draw has byes").toBe(2);
    expect((await timetablePairs(odd.divisionId, odd.auth)).filter((p) => p.includes(BYE)).length, "the timetable keeps each bye").toBe(2);
    for (const r of byes) expect(await posterNode(odd.divisionId, odd.auth, r.id), r.ext_key ?? r.id).toContain(BYE);
    const oddBoard = await held(odd);
    expect(byes.filter((r) => oddBoard.has(r.id)).length, "a bye is not held").toBe(0);
    const oddSheets = (await scoresheets(odd.divisionId, odd.auth)).filter((x) => x.includes(BYE));
    expect(oddSheets.length, "R116-4: each bye's scoresheet keeps the bye").toBeGreaterThanOrEqual(2);

    // A DQ'd winner's dead seat (a bare status write, as PATCH /entrants writes one): the arriving side walks over by
    // bye, naming nobody — so the exports keep the bye and never print her.
    const dq = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
    const sib = siblingsInto(await rowsOf(dq.stageId));
    await sql`update entrants set status = 'disqualified' where id = ${sib.a.home_entrant_id}`;
    const dqd = (await play(dq.auth, sib.a.id)).home_entrant_id!;
    const dqArriving = (await play(dq.auth, sib.b.id)).home_entrant_id!;
    const dqTie = await fixtureRow(sib.parentId);
    expect([dqTie.status, dqTie.outcome], "premise: a walkover by bye, naming nobody").toEqual([
      "forfeited",
      { kind: "award", winner: dqArriving, loser: null, reason: "bye" },
    ]);
    const [dqName, dqThem] = [await nameOf(dqd), await nameOf(dqArriving)];
    const dqPairs = (await timetablePairs(dq.divisionId, dq.auth)).filter((p) => p.includes(dqThem) && p.includes(BYE));
    expect(dqPairs.length, "the timetable keeps the bye opposite the arriving side").toBe(1);
    expect(dqPairs.flat(), "and never prints her there").not.toContain(dqName);
    const dqNode = await posterNode(dq.divisionId, dq.auth, sib.parentId);
    expect([dqNode.includes(BYE), dqNode.includes(dqName)], "the poster keeps the bye").toEqual([true, false]);
    const dqSheets = (await scoresheets(dq.divisionId, dq.auth)).filter((x) => x.includes(dqThem) && x.includes(BYE));
    expect(dqSheets.length, "R116-4: the scoresheet keeps the bye opposite the arriving side").toBeGreaterThan(0);
    expect(dqSheets.filter((x) => x.includes(dqName)), "and never prints her there").toEqual([]);
  }, 240_000);

  it("R116-3: the arriving side's player page lists the line it played, naming its opponent, and not the tie — as it lists no walkover", async () => {
    // single-sport: badminton — the page's list is the stats reader's played set (ruling 115) and a seat read, not the
    // sport. Her opponent's person is the arriving side's only member.
    const { sport, variant, play } = SPORTS[0]!;
    const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    const w1 = (await play(s.auth, a.id)).home_entrant_id!;
    await withdrawEntrantCascade(s.auth, w1);
    const played = await play(s.auth, b.id);
    const [arriving, beaten] = [played.home_entrant_id!, played.away_entrant_id!];
    expect((await fixtureRow(parentId)).outcome, "premise: ruling 116's walkover").toEqual({ kind: "award", winner: arriving, loser: w1, reason: "withdrew" });
    const person = await createPerson(s.auth, { full_name: "Arriving Player", consent: {}, dob: null, gender: null, external_ref: null });
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${arriving}, ${person.id}, ${s.auth.orgId})`;
    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${s.auth.orgId}`;
    const [comp] = await sql<{ slug: string }[]>`select slug from competitions where id = ${s.competitionId}`;
    const lines = await readPlayerMatchLines(sql, { personId: person.id, competitionId: s.competitionId, orgSlug: org!.slug, compSlug: comp!.slug, locale: "en" });
    expect(lines.map((l) => [l.fixtureId, l.opponentName]), "the line it played, naming its opponent; never the tie").toEqual([[b.id, await nameOf(beaten)]]);
  }, 120_000);

  it("R116-4: the board card, an official's finished duty and the assignment email name her in her dead seat; a bye and a DQ'd winner's dead seat keep the bye", async () => {
    // single-sport: badminton — the board card, the /me lane and the email read the seats and the outcome, never the sport.
    const { sport, variant, play } = SPORTS[0]!;
    const enUi = (key: string, vars?: Record<string, string | number>) => msgFor("en", key as MessageKey, vars);
    /** The organiser board's card title for one fixture, from the board's own read and the page's name map. */
    const boardCard = async (auth: AuthCtx, divisionId: string, id: string) => {
      const rows = await listDivisionFixturesForBoard(auth, divisionId);
      const names = Object.fromEntries((await listEntrants(auth, divisionId)).map((e) => [e.id, e.display_name]));
      const f = rows.find((r) => r.id === id);
      if (!f) throw new Error(`rig: ${id} is not on the board`);
      return cardTitle(f as unknown as BoardFixture, names, {}, enUi);
    };
    /** An official linked to a user, appointed to `id` — returns the email's line for it and the user's /me row. */
    const appoint = async (auth: AuthCtx, id: string) => {
      const email = `ref-${randomUUID().slice(0, 8)}@test.local`;
      const [user] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, 'Ref', true) returning id`;
      const official = await createOfficial(auth, { display_name: "Ref R116-4", role_keys: ["referee"] });
      // A claim invite is minted by a session editor only (person-claims.ts requireSessionEditor): an owner's session.
      const ownerEmail = `owner-${randomUUID().slice(0, 8)}@test.local`;
      const [owner] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${ownerEmail}, 'Owner', true) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${auth.orgId}, ${owner!.id}, 'owner')`;
      const invited = await inviteOfficial({ ...auth, via: "session", userId: owner!.id }, official.id, email, "https://officials.test");
      await claimPerson(invited.secret, user!.id, email);
      mail.assigned.mockClear();
      await patchFixtureOfficials(auth, id, { set: [{ official_id: official.id, role_key: "referee", locked: false }] });
      const sent = mail.assigned.mock.calls.map((c) => c[1] as { fixtures: { label: string }[] });
      expect(sent.length, "rig: the appointment sent one email").toBe(1);
      const row = (await getMyOfficiating(user!.id)).completed.find((a) => a.fixture_id === id);
      if (!row) throw new Error(`rig: ${id} is not in the official's finished duties`);
      return { label: sent[0]!.fixtures[0]!.label, me: [row.home_name, row.away_name], meWithdrew: [row.home_withdrew === true, row.away_withdrew === true] };
    };
    const vs = (pair: readonly string[]) => pair.join(` ${enUi("schedule.vs")} `);

    const seats = new Set<number>();
    for (const flip of [false, true]) {
      const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
      const sib = siblingsInto(await rowsOf(s.stageId));
      const [mine, other] = flip ? [sib.b, sib.a] : [sib.a, sib.b];
      const w1 = (await play(s.auth, mine.id)).home_entrant_id!;
      await withdrawEntrantCascade(s.auth, w1);
      const arriving = (await play(s.auth, other.id)).home_entrant_id!;
      expect((await fixtureRow(sib.parentId)).outcome, "premise: ruling 116's walkover").toEqual({ kind: "award", winner: arriving, loser: w1, reason: "withdrew" });
      const [her, them] = [await nameOf(w1), await nameOf(arriving)];
      const seat = mine.winner_to_slot!;
      seats.add(seat);
      const want = seat === 1 ? [her, them] : [them, her];
      // Design audit 4.1: the string surfaces mark her name as withdrawn (the dictionary's mark, never typed here); the
      // /me lane carries the flag for its chip, on her seat alone.
      const herMarked = enUi("schedule.withdrawnSide", { name: her });
      expect(herMarked, "premise: the mark adds to her name").not.toBe(her);
      const marked = want.map((x) => (x === her ? herMarked : x));
      expect(await boardCard(s.auth, s.divisionId, sib.parentId), `seat ${seat}: the board card names her in her seat, marked`).toBe(vs(marked));
      const { label, me, meWithdrew } = await appoint(s.auth, sib.parentId);
      expect(label, `seat ${seat}: the assignment email names her in her seat, marked`).toBe(vs(marked));
      expect(me, `seat ${seat}: the official's finished duty names her in her seat`).toEqual(want);
      expect(meWithdrew, `seat ${seat}: and flags her seat alone as withdrawn`).toEqual(want.map((x) => x === her));
      if (flip) {
        // Design audit 4.2: the email joins the sides in the org's language — French reads "contre", never a typed
        // English " vs " (an English org cannot tell the two apart). One seat suffices: the join is seat-blind.
        const frUi = (key: string, vars?: Record<string, string | number>) => msgFor("fr", key as MessageKey, vars);
        expect(frUi("schedule.vs"), "premise: French joins with its own word").not.toBe(enUi("schedule.vs"));
        await sql`update organizations set default_locale = 'fr' where id = ${s.auth.orgId}`;
        const fr = await appoint(s.auth, sib.parentId);
        const frMarked = want.map((x) => (x === her ? frUi("schedule.withdrawnSide", { name: her }) : x));
        expect(fr.label, `seat ${seat}: a French org's email, marked and joined in French`).toBe(frMarked.join(` ${frUi("schedule.vs")} `));
      }
    }
    expect([...seats].sort(), "both seats reached").toEqual([1, 2]);

    // The pairs: a genuine bye of an odd draw, and a DQ'd winner's dead seat (a walkover by bye, naming nobody), keep
    // the bye everywhere — the /me lane's empty seat stays null, for the lane to resolve its stored bye label.
    const odd = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 6 });
    const bye = (await rowsOf(odd.stageId)).find((r) => (r.outcome as { reason?: unknown } | null)?.reason === "bye");
    if (!bye) throw new Error("rig: the odd draw has no bye");
    const byeSeated = await nameOf((bye.home_entrant_id ?? bye.away_entrant_id)!);
    const byePair = bye.home_entrant_id === null ? [BYE, byeSeated] : [byeSeated, BYE];
    expect(await boardCard(odd.auth, odd.divisionId, bye.id), "a bye's board card keeps the bye").toBe(vs(byePair));
    const oddDuty = await appoint(odd.auth, bye.id);
    expect(oddDuty.label, "a bye's email keeps the bye").toBe(vs(byePair));
    expect(oddDuty.me, "and the /me lane's empty seat names nobody").toEqual(byePair.map((x) => (x === BYE ? null : x)));
    expect(oddDuty.meWithdrew, "and flags nobody as withdrawn (audit 4.1)").toEqual([false, false]);

    const dq = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
    const sib = siblingsInto(await rowsOf(dq.stageId));
    await sql`update entrants set status = 'disqualified' where id = ${sib.a.home_entrant_id}`;
    const dqd = (await play(dq.auth, sib.a.id)).home_entrant_id!;
    const dqArriving = (await play(dq.auth, sib.b.id)).home_entrant_id!;
    expect((await fixtureRow(sib.parentId)).outcome, "premise: a walkover by bye, naming nobody").toEqual({ kind: "award", winner: dqArriving, loser: null, reason: "bye" });
    const [dqName, dqThem] = [await nameOf(dqd), await nameOf(dqArriving)];
    const card = await boardCard(dq.auth, dq.divisionId, sib.parentId);
    expect([card.includes(BYE), card.includes(dqThem), card.includes(dqName)], "the DQ'd winner's board card keeps the bye").toEqual([true, true, false]);
    const dqDuty = await appoint(dq.auth, sib.parentId);
    expect([dqDuty.label.includes(BYE), dqDuty.label.includes(dqName)], "and so does the email").toEqual([true, false]);
    expect(dqDuty.me.filter((x) => x === null).length, "and the /me lane's empty seat names nobody").toBe(1);
    expect(dqDuty.me, "never her").not.toContain(dqName);
    expect(dqDuty.meWithdrew, "and flags nobody as withdrawn (audit 4.1)").toEqual([false, false]);
    expect(card.includes(enUi("schedule.withdrawnSide", { name: dqThem })), "the arriving side is never marked").toBe(false);
  }, 240_000);
});

// Loop R M-17 (recurring class 13: a guard that refuses a legitimate new arrival). A tie whose Start was recorded and
// then taken back holds two ledger events, neither standing, and the cache row the take-back wrote (`appendEvent`'s
// fold of it, at seq 2). The award's writer refused ANY row there as a reset that kept its score, so the arriving
// side's decider threw and that line could not be decided at all. A ledger that every void took back holds no play,
// and its row is that ledger's fold, never an award's: the award takes it over, at the ledger's tip (the token every
// append is checked against: `getFixtureState`'s `last_seq`). A reset re-folds that ledger into the row — the
// take-back's own row when the same side arrives again, the award's sides otherwise (Loop R2 N-3, below). Through the
// buttons: Start, Undo, the arriving line's Undo and re-score, Withdraw.
const stateRow = async (id: string) =>
  (await sql<{ last_seq: number; state: unknown; summary: unknown }[]>`
    select last_seq, state, summary from match_states where fixture_id = ${id}`)[0] ?? null;
const lastEvent = async (id: string) =>
  (await sql<{ id: string; type: string; payload: unknown }[]>`
    select id, type, payload from score_events where fixture_id = ${id} order by seq desc limit 1`)[0]!;
/** Events no void took back, voids aside (voids are not voidable: events.test.ts PROMPT-02). */
const standingEvents = async (id: string) =>
  (await sql<{ n: number }[]>`
    select count(*)::int as n from score_events e
    where e.fixture_id = ${id} and e.type <> 'core.void'
      and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)`)[0]!.n;

describe.skipIf(!HAS_DB)("Loop R M-17: a tie whose ledger every void took back still takes ruling 116's walkover", () => {
  it("every sport: the award takes over the take-back's row at the ledger's tip, a reset puts that row back, and a second award takes it again", async () => {
    let checked = 0;
    for (const { sport, variant, play } of SPORTS) {
      const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
      // Published, so the public's own view (`storedLines`) reads the tie.
      await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
      const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
      const w1 = (await play(s.auth, a.id)).home_entrant_id!;
      const arriving = (await play(s.auth, b.id)).home_entrant_id!;
      // Start pressed by mistake, then Undo: two ledger events, neither standing, and the take-back's own row.
      await post(s.auth, parentId, "core.start");
      await post(s.auth, parentId, "core.void", { event_id: (await lastEvent(parentId)).id });
      const takenBack = await stateRow(parentId);
      expect([takenBack?.last_seq, await standingEvents(parentId), (await fixtureRow(parentId)).status], `${sport}: premise`).toEqual([2, 0, "scheduled"]);
      // The arriving line's decider is taken back (its winner leaves the tie), and she withdraws while that seat is TBD.
      const decider = await lastEvent(b.id);
      await post(s.auth, b.id, "core.void", { event_id: decider.id });
      await withdrawEntrantCascade(s.auth, w1);
      const waiting = await fixtureRow(parentId);
      expect([seatOf(waiting, a.winner_to_slot), seatOf(waiting, b.winner_to_slot), waiting.outcome], `${sport}: premise, both seats empty`).toEqual([null, null, null]);

      // The decider again: its winner walks over her dead seat — the walkover any ruling 116 tie shows.
      const credit = WALKOVER_CREDIT[sport]!((await divisionOf(s.divisionId)).cfg);
      expect(credit, `${sport}: premise, the walkover credits something`).toBeGreaterThan(0);
      const wantLines = { [arriving]: String(credit), [w1]: "0" };
      const awardIt = async (round: string) => {
        await post(s.auth, b.id, decider.type, decider.payload);
        const tie = await fixtureRow(parentId);
        expect([tie.status, tie.outcome], `${sport} ${round}: the walkover`).toEqual(["forfeited", { kind: "award", winner: arriving, loser: w1, reason: "withdrew" }]);
        expect(await storedLines(parentId), `${sport} ${round}: its credit`).toEqual(wantLines);
        expect((await stateRow(parentId))?.last_seq, `${sport} ${round}: at the ledger's tip`).toBe(2);
        expect([await activeEvents(parentId), await standingEvents(parentId)], `${sport} ${round}: no event appended`).toEqual([2, 0]);
      };
      await awardIt("first award");

      // Reset: the decider taken back once more. The tie re-opens with the take-back's own row — not the old credit.
      await post(s.auth, b.id, "core.void", { event_id: (await lastEvent(b.id)).id });
      const reopened = await fixtureRow(parentId);
      expect([reopened.status, reopened.outcome], `${sport}: re-opened`).toEqual(["scheduled", null]);
      expect(await stateRow(parentId), `${sport}: the take-back's own row, as Undo left it`).toEqual(takenBack);

      // A second award over the same ledger (the sequence, not just the feature).
      await awardIt("second award");
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  }, 240_000);

  // Loop R2 N-3: the row a reset refolds is a CACHE over the sides it names when the reset runs. After the award took
  // it over, those are the award's — her and the side that walked over — not necessarily the sides the take-back was
  // recorded with: here the arriving line is re-decided the OTHER way, so a different side (Y) walks over her. What
  // keeps the row honest is the ledger, never its names: it sits at the ledger's tip (the token every append is
  // checked against), it credits no play, and the next award over the same ledger credits exactly its own walkover.
  /** The arriving line, its decider just taken back, decided for its OTHER side — per sport, from the rig's own play. */
  const OTHER_WINS: Record<string, (auth: AuthCtx, id: string) => Promise<void>> = {
    // One game each way after the take-back: home took game one, so two games to the away side decide it.
    badminton: async (auth, id) => {
      for (let g = 0; g < 2; g++) await post(auth, id, "badminton.game.summary", { home: 10, away: 21 });
    },
    // Home's goal stands at half time: half time taken back too, two away goals, then half and full time.
    football: async (auth, id) => {
      const r = await fixtureRow(id);
      const [ht] = await sql<{ id: string; type: string; payload: { phase?: string } }[]>`
        select id, type, payload from score_events e where e.fixture_id = ${id} and e.type <> 'core.void'
          and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
        order by seq desc limit 1`;
      expect([ht?.type, ht?.payload.phase], "rig: half time is the newest standing event").toEqual(["football.period", "HT"]);
      await post(auth, id, "core.void", { event_id: ht!.id });
      for (let g = 0; g < 2; g++) await post(auth, id, "football.goal", { by: r.away_entrant_id });
      await post(auth, id, "football.period", { phase: "HT" });
      await post(auth, id, "football.period", { phase: "FT" });
    },
  };
  it("every sport: the arriving line re-decided with a DIFFERENT winner — the reset leaves the ledger's fold at its tip, crediting nothing, over the award's sides; a second award credits its own walkover", async () => {
    let checked = 0;
    for (const { sport, variant, play } of SPORTS) {
      const otherWins = OTHER_WINS[sport];
      if (otherWins === undefined) throw new Error(`rig: no other-side decider for ${sport}`);
      const s = await seedBracket({ sport, variant, stageKind: "knockout", entrants: 8 });
      await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
      const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
      const w1 = (await play(s.auth, a.id)).home_entrant_id!;
      const arriving = (await play(s.auth, b.id)).home_entrant_id!;
      const y = b.away_entrant_id!;
      expect(y, `${sport}: premise, Y is not the side the take-back was recorded with`).not.toBe(arriving);
      await post(s.auth, parentId, "core.start");
      await post(s.auth, parentId, "core.void", { event_id: (await lastEvent(parentId)).id });
      const takenBack = (await stateRow(parentId)) as { last_seq: number; state: unknown; summary: { perSide: { entrantId: string }[] } };
      expect(JSON.stringify(takenBack).includes(y), `${sport}: premise, the take-back's row never names Y`).toBe(false);
      expect(
        [takenBack.last_seq, takenBack.summary.perSide.map((p) => p.entrantId).sort()],
        `${sport}: premise, the take-back's row is the ledger's tip, over the sides it was recorded with`,
      ).toEqual([2, [w1, arriving].sort()]);
      await post(s.auth, b.id, "core.void", { event_id: (await lastEvent(b.id)).id });
      await withdrawEntrantCascade(s.auth, w1);

      // The arriving line decided the other way: Y walks over her dead seat.
      await otherWins(s.auth, b.id);
      expect((await fixtureRow(b.id)).outcome?.winner, `${sport}: premise, Y won the arriving line`).toBe(y);
      const yDecider = await lastEvent(b.id);
      const credit = WALKOVER_CREDIT[sport]!((await divisionOf(s.divisionId)).cfg);
      const awardY = async (round: string) => {
        const tie = await fixtureRow(parentId);
        expect([tie.status, tie.outcome], `${sport} ${round}: Y's walkover`).toEqual(["forfeited", { kind: "award", winner: y, loser: w1, reason: "withdrew" }]);
        expect(await storedLines(parentId), `${sport} ${round}: its credit, Y's alone`).toEqual({ [y]: String(credit), [w1]: "0" });
        expect([(await stateRow(parentId))?.last_seq, await activeEvents(parentId), await standingEvents(parentId)], `${sport} ${round}: at the tip, nothing appended`).toEqual([2, 2, 0]);
      };
      await awardY("first award");

      // Reset: Y's decider taken back. The tie re-opens, and the row is the same ledger's fold at its tip, crediting
      // nothing — over the sides the award held: wherever the take-back's row named the arriving side, this one names Y
      // (the engine state carries its sides). A cache, re-folded over whoever is seated by the next append.
      await post(s.auth, b.id, "core.void", { event_id: yDecider.id });
      const reopened = await fixtureRow(parentId);
      expect([reopened.status, reopened.outcome], `${sport}: re-opened`).toEqual(["scheduled", null]);
      const reset = await stateRow(parentId);
      const named = JSON.stringify(reset);
      expect([named.includes(y), named.includes(arriving)], `${sport}: the reset row names Y, not the side the take-back named`).toEqual([true, false]);
      expect(JSON.parse(named.replaceAll(y, arriving)), `${sport}: and is the take-back's row in every other detail`).toEqual(takenBack);

      // A second award over the same ledger (the sequence, not just the feature).
      await post(s.auth, b.id, yDecider.type, yDecider.payload);
      await awardY("second award");
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
