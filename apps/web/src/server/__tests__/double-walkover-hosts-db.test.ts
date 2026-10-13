// Design review I-1 / M-1 (audit 3.1 beyond the web hosts) — a double walkover credits nobody, but its summary carries
// a 0 / 0, and every host that reads `match_states.summary` straight from the database painted it: the organiser's
// slideshow, the printed bracket poster, the auto-drafted result post — and (re-review N-1) the player's /me results. Each host now asks the one predicate (`creditsNobody`, lib/forfeit-tag.ts).
//
// ONE real scene through the real write path (`scoreEvent`): a 4-entrant knockout whose first semi is a double
// walkover and whose second is a one-sided walkover (the pair, which keeps its credited score). The premise — the
// double walkover's stored summary really carries a headline — is asserted first.
//
// Single-sport (badminton): the hosts read stored rows and never look at the sport; the registry sweeps live in the
// pure tests (public-slides, double-walkover-score-lines).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import { buildDivisionSlides, type FixtureSlideItem } from "@/server/slideshow-data";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { finalizeFixture } from "@/server/usecases/scoring";
import { listMyFixtures } from "@/server/usecases/me";
import { createPerson } from "@/server/usecases/persons";
import { creditsNobody, forfeitLedgerOfReason } from "@/lib/forfeit-tag";
import { outcomeTagWords } from "@/lib/outcome-text";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("a double walkover's 0 / 0 on the hosts that read the stored summary (review I-1, M-1)", () => {
  let auth: AuthCtx;
  let divisionId: string;
  let dwId: string;
  let woId: string;
  let woHeadline: string;
  const names: Record<string, string> = {};
  const TAG = msgFor("en", "forfeit.tag.doubleWalkover");

  beforeAll(async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    auth = s.auth;
    divisionId = s.divisionId;
    if (s.fixtureIds.length !== 2) throw new Error(`rig: ${s.fixtureIds.length} semi-finals, wanted 2`);
    const dw = await fixtureRow(s.fixtureIds[0]!);
    const wo = await fixtureRow(s.fixtureIds[1]!);
    // The poster is an export (`requireFeature(…, "exports")`) and the result post a `news.auto` draft: both on Pro, and
    // the division opted in to auto posts BEFORE the forfeits, so the real write path (scoreEvent → refreshNews) drafts.
    await setOrgPlan(auth.orgId, "pro");
    await sql`update divisions set auto_posts = true where id = ${divisionId}`;
    dwId = dw.id;
    woId = wo.id;
    const dwOut = await post(auth, dwId, "core.forfeit", { by: "both", reason: "walkover" });
    expect([dwOut.status, dwOut.outcome], "rig: the double walkover is recorded").toEqual(["forfeited", { kind: "double_walkover" }]);
    const woOut = await post(auth, woId, "core.forfeit", { by: wo.away_entrant_id, reason: "walkover" });
    expect(woOut.status, "rig: the one-sided walkover is recorded").toBe("forfeited");
    for (const r of await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${divisionId}`) {
      names[r.id] = r.display_name;
    }
    const heads = await sql<{ fixture_id: string; headline: string | null }[]>`
      select fixture_id, summary->>'headline' as headline from match_states where fixture_id in (${dwId}, ${woId})`;
    const headOf = (id: string) => heads.find((h) => h.fixture_id === id)?.headline ?? null;
    expect(headOf(dwId), "premise: the double walkover's stored summary carries a headline to hide").toMatch(/\d/);
    expect(headOf(woId), "premise: the walkover's stored summary carries its credited score").toMatch(/\d/);
    woHeadline = headOf(woId)!;
  }, 120_000);

  it("the result post: a double walkover drafts none (its title read 'A 0 — 0 B'); the walkover drafts one", async () => {
    const drafts = await sql<{ fixture_id: string; title: string }[]>`
      select auto_source->>'fixture_id' as fixture_id, title from org_posts
      where org_id = ${auth.orgId} and auto_source->>'trigger' = 'fixture_decided'`; // org-posts.ts TRIGGER_RESULT
    expect(drafts.filter((d) => d.fixture_id === woId).length, "premise: the core.forfeit path drafts a result post").toBe(1);
    expect(drafts.filter((d) => d.fixture_id === dwId), "the double walkover drafts no result post").toEqual([]);
    // Loop R M-11: the walkover's title says so after its credited score (it read "A 2–0 B", a match nobody played).
    const title = drafts.find((d) => d.fixture_id === woId)!.title;
    expect(title.endsWith(` (${msgFor("en", "forfeit.tag.walkover")})`), `the result post's title carries the walkover's tag: "${title}"`).toBe(true);
  });

  /** Every object in a model that carries a `headline` beside a `home` — a poster node, whatever the layout. */
  const posterNodes = (x: unknown, out: { home: unknown; headline: unknown }[] = []) => {
    if (Array.isArray(x)) for (const v of x) posterNodes(v, out);
    else if (x !== null && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if ("headline" in o && "home" in o) out.push({ home: o.home, headline: o.headline });
      for (const v of Object.values(o)) posterNodes(v, out);
    }
    return out;
  };

  it("the bracket poster: the double walkover's node prints the tag; the walkover keeps its score", async () => {
    const model = await buildDivisionDocModel(auth, divisionId, "bracket", { printedAt: "2030-01-01T00:00:00.000Z" });
    const [dw] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${dwId}`;
    const [wo] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${woId}`;
    const nodes = posterNodes(model.bracket);
    expect(nodes.length, "the poster has nodes").toBeGreaterThanOrEqual(3);
    const at = (home: string) => nodes.filter((n) => n.home === home).map((n) => n.headline);
    expect(at(names[dw!.home_entrant_id]!), "poster: the double walkover").toEqual([TAG]);
    expect(at(names[wo!.home_entrant_id]!), "poster: the walkover keeps its score").toEqual([woHeadline]);
  });

  it("the organiser's slideshow: the results and bracket slides carry the tag, not the 0 / 0; the walkover keeps its score", async () => {
    const slides = await buildDivisionSlides(auth, divisionId, "Open");
    const [dw] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${dwId}`;
    const [wo] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${woId}`;
    const items = slides.flatMap((sl) => (sl.kind === "fixtures" ? sl.items : [])) as FixtureSlideItem[];
    const dwItems = items.filter((i) => i.home === names[dw!.home_entrant_id]);
    const woItems = items.filter((i) => i.home === names[wo!.home_entrant_id]);
    expect(dwItems.length, "the double walkover is on a results slide").toBeGreaterThan(0);
    expect(woItems.length, "the walkover is on a results slide").toBeGreaterThan(0);
    for (const i of dwItems) expect([i.line, i.tag], "results slide: the double walkover").toEqual([null, TAG]);
    for (const i of woItems) expect([i.line, i.tag ?? null], "results slide: the walkover keeps its score").toEqual([woHeadline, null]);
    // Loop R M-11: the status cell names the walkover's reason (it read "Forfeit" for every reason) — through the real
    // division read (`listDivisionFixtures`), the dictionary's words. The double walkover's tag is its score's; never twice.
    const woWords = { word: msgFor("en", "forfeit.tag.walkover"), full: msgFor("en", "forfeit.tagFull.walkover") };
    for (const i of woItems) expect(i.statusTag, "results slide: the walkover's status cell").toEqual(woWords);
    for (const i of dwItems) expect(i.statusTag, "results slide: the double walkover's status cell keeps its word").toBeUndefined();
    const nodes = slides.flatMap((sl) => (sl.kind === "bracket" ? sl.fixtures : []));
    const node = (id: string) => nodes.find((n) => n.id === id);
    expect(node(dwId), "the bracket slide has the double walkover's node").toBeDefined();
    expect([node(dwId)!.line, node(dwId)!.tag], "bracket slide: the double walkover").toEqual([null, TAG]);
    expect([node(woId)!.line, node(woId)!.tag ?? null], "bracket slide: the walkover keeps its score").toEqual([woHeadline, null]);
  });

  // Re-review N-1, the producer leg: the console finalizes a decided double walkover (`finalizeFixture`, core.finalize),
  // and /me lists finalized results only. The real `listMyFixtures` row must carry the outcome the page's
  // `creditsNobody` reads — beside the stored 0 / 0 it must not print. The page's render of that row is
  // `app/me/__tests__/me-page-results-forfeit.test.tsx`. LAST in the file: it finalizes both semis.
  it("the player's /me: a finalized double walkover's row carries the outcome that credits nobody; the walkover's credits its winner", async () => {
    // One player per side: a user holds one person per org (persons_org_user_lane_uq), and both semis are this org's.
    const players: Record<string, string> = {};
    const sides = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where id in (${dwId}, ${woId})`;
    // Fix round 3: a third player on the walkover's AWAY side, so the row's `player_home` is read both ways.
    const woAway = sides.find((f) => f.id === woId)!.away_entrant_id;
    {
      const [{ id: player }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified)
        values (${`wo-away-${woId.slice(0, 8)}@test.local`}, 'Ari', true) returning id`;
      const person = await createPerson(auth, { full_name: `Ari ${woId.slice(0, 4)}`, consent: {}, dob: null, gender: null, external_ref: null });
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${woAway}, ${person.id}, ${auth.orgId})`;
      await sql`update persons set user_id = ${player} where id = ${person.id}`;
      players[`${woId}:away`] = player;
    }
    for (const f of sides) {
      const [{ id: player }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified)
        values (${`dw-me-${f.id.slice(0, 8)}@test.local`}, 'Pat', true) returning id`;
      const person = await createPerson(auth, { full_name: `Pat ${f.id.slice(0, 4)}`, consent: {}, dob: null, gender: null, external_ref: null });
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${f.home_entrant_id}, ${person.id}, ${auth.orgId})`;
      await sql`update persons set user_id = ${player} where id = ${person.id}`;
      players[f.id] = player;
    }
    expect(Object.keys(players).length, "a player on each semi, and one on the walkover's away side").toBe(3);
    const listed = async (id: string) => (await listMyFixtures(players[id]!)).results.find((r) => r.id === id);
    expect([await listed(dwId), await listed(woId)], "premise: an unfinalized result is not listed").toEqual([undefined, undefined]);
    for (const id of [dwId, woId]) await finalizeFixture(auth, id, await tip(id));
    const rows = { [dwId]: await listed(dwId), [woId]: await listed(woId) };
    const row = (id: string) => rows[id];
    expect([row(dwId), row(woId)].map((r) => r !== undefined), "both finalized results are listed").toEqual([true, true]);
    expect(row(dwId)!.outcome, "the double walkover's row carries its outcome").toEqual({ kind: "double_walkover" });
    expect(creditsNobody(row(dwId)!.outcome), "so the page prints its tag").toBe(true);
    expect((row(dwId)!.summary as { headline?: string } | null)?.headline, "premise: beside the stored headline it must not print").toMatch(/\d/);
    expect(creditsNobody(row(woId)!.outcome), "the pair: the walkover credits its winner").toBe(false);
    expect((row(woId)!.summary as { headline?: string } | null)?.headline, "and keeps its credited score").toBe(woHeadline);
    // Loop R M-11: the row carries what the page's tag reads — the seats and the active abandon's reason (none here) —
    // so the walkover's line says "w/o" after its score; the double walkover's tag is its score, read as above.
    const wo = sides.find((f) => f.id === woId)!;
    expect([row(woId)!.home_entrant_id, row(woId)!.away_entrant_id, row(woId)!.abandon_reason], "the walkover's seats, no abandon").toEqual([wo.home_entrant_id, wo.away_entrant_id, null]);
    const msg = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor("en", k, v);
    expect(
      outcomeTagWords(msg, row(woId)!.outcome, forfeitLedgerOfReason(row(woId)!.abandon_reason), row(woId)!),
      "the page's reader over the real row: the walkover's words",
    ).toEqual({ word: msgFor("en", "forfeit.tag.walkover"), full: msgFor("en", "forfeit.tagFull.walkover") });
    // Fix round 3: the row says which side the player holds — the stored headline reads home first.
    expect([row(dwId)!.player_home, row(woId)!.player_home], "the home players' rows").toEqual([true, true]);
    const awayRow = (await listMyFixtures(players[`${woId}:away`]!)).results.find((r) => r.id === woId);
    expect(awayRow?.player_home, "the away player's row").toBe(false);
    expect([awayRow?.entrant_name, awayRow?.opponent_name], "her side named first").toEqual([names[woAway], names[sides.find((f) => f.id === woId)!.home_entrant_id]]);
  });
});
