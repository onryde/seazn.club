// R4 sponsors on stream, S12 - what the On stream tab reads besides sponsor rows (`loadOnStreamScope`; ruling R11): the dial in
// force for the scope, the sports it plays with their declared break kinds, and the breaks of the org's most recent FINISHED
// fixture of each sport - a real ledger folded through the real engine, no sample table, no testkit in production.
//
// Expected values: the ORACLE in `_finished-rig.ts` - the sport's own `naturalBreaks.opensAt` asked of each event of the seeded
// ledger, sized by the sport's own `kinds`. Never the loader's, never `previewForSport`'s. The sweep over sports reports how many
// it checked (TEST-STRATEGY: zero is a failure).
//
// Sequence (rule 1): no finished fixture (static line) -> one (sample) -> a newer one (it replaces the older) ; an unfinished,
// abandoned, forfeited or foreign-org fixture is never the sample ; a fold that refuses costs that candidate only. Sports: cricket,
// football and badminton fold; generic (and chess) declare no breaks and have nothing to count. The seam to the planner is last.
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { SPONSOR_FREQUENCIES, type SponsorCard } from "@/lib/sponsor-plan";
import { previewForSport } from "@/lib/sponsor-preview";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { resolveStreamSettings } from "../stream-settings";
import { loadOnStreamScope, PREVIEW_CANDIDATES } from "../on-stream";
import { chooseWalk, finishWith, moduleOf, seedDivision, type RiggedDivision, type Walk } from "./_finished-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
const CARD: SponsorCard = { id: "c1", sponsorId: "s1", name: "Harbour", logoUrl: null, tier: "gold", onStream: true };

/** The sport's variant used for each rigged sport (a real system variant, so the division's config is the shipped one). */
const VARIANT: Record<string, string> = { cricket: "t20", football: "11-a-side", badminton: "bwf", generic: "score" };
const sampleOf = (walk: Walk) => walk.breaks.map(({ seq, kind, size, at }) => ({ seq, kind, size, at }));

async function org() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Spring Cup", visibility: "public", branding: {} });
  return { auth, orgId: auth.orgId, competitionId: comp.id };
}

describe.skipIf(!HAS_DB)("loadOnStreamScope - the preview's facts (R11)", () => {
  it("cricket, football, badminton: the sample IS the seeded ledger's breaks (the sport's own opensAt, at the events' own times), and the kinds are the engine's declaration (counted)", async () => {
    const o = await org();
    let sports = 0;
    let breaksChecked = 0;
    for (const sportKey of ["cricket", "football", "badminton"] as const) {
      const rig = await seedDivision(o.auth, o.competitionId, sportKey, VARIANT[sportKey]!, `${sportKey} div`);
      const walk = chooseWalk(sportKey, rig.cfg);
      await finishWith(o.orgId, rig, walk, daysAgo(1));
      const scope = await loadOnStreamScope(o.orgId, null);
      const got = scope.sports.find((s) => s.sportKey === sportKey);
      expect(got, `${sportKey}: the org plays it`).toBeDefined();
      expect(got!.kinds, `${sportKey}: the engine's declaration`).toEqual(moduleOf(sportKey).naturalBreaks!.kinds.map((k) => ({ kind: k.kind, size: k.size })));
      expect(got!.sample, `${sportKey}: the ledger's breaks`).toEqual(sampleOf(walk));
      expect(walk.breaks.some((b) => b.size === "major") && walk.breaks.some((b) => b.size === "minor"), `${sportKey}: premise - both sizes`).toBe(true);
      sports++;
      breaksChecked += got!.sample!.length;
    }
    expect(sports).toBe(3);
    expect(breaksChecked, `${breaksChecked} breaks compared`).toBeGreaterThan(3);
  });

  it("the seam to the planner: cricket on Light / Normal / Busy - the strip's break count is the module's majors (+ every 3rd minor), derived from the seeded ledger, not from previewForSport", async () => {
    const o = await org();
    const rig = await seedDivision(o.auth, o.competitionId, "cricket", VARIANT.cricket!, "cricket div");
    const walk = chooseWalk("cricket", rig.cfg);
    await finishWith(o.orgId, rig, walk, daysAgo(1));
    const sample = (await loadOnStreamScope(o.orgId, null)).sports.find((s) => s.sportKey === "cricket")!.sample!;

    const majors = walk.breaks.filter((b) => b.size === "major").length;
    const minors = walk.breaks.length - majors;
    expect(majors, "premise: cricket's innings break is a major").toBeGreaterThan(0);
    expect(minors, "premise: cricket's over end is a minor").toBeGreaterThan(0);
    const want = { light: majors, normal: majors + Math.floor(minors / 3), busy: majors + minors };
    let cells = 0;
    for (const f of SPONSOR_FREQUENCIES) {
      const got = previewForSport(f, sample, [CARD]);
      expect(got.breaks, `${f}: breaks`).toBe(want[f]);
      expect(got.cards, `${f}: cards (two minutes apart: no cooldown thinning)`).toBe(want[f]);
      cells++;
    }
    expect(cells).toBe(3);
    // Nothing ticked: the same breaks, no card.
    expect(previewForSport("light", sample, [])).toEqual({ breaks: majors, cards: 0 });
  });

  it("generic (and chess) declare no breaks: kinds null and no sample, even with a finished match; the sports are listed by key", async () => {
    const o = await org();
    const g = await seedDivision(o.auth, o.competitionId, "generic", VARIANT.generic!, "generic div");
    await sql`update fixtures set status = 'decided' where id = ${g.fixtureId}`;
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload) values (${g.fixtureId}, ${o.orgId}, 1, 'core.start', '{}')`;
    const scope = await loadOnStreamScope(o.orgId, null);
    expect(scope.sports).toEqual([{ sportKey: "generic", kinds: null, sample: null }]);
    expect(moduleOf("generic").naturalBreaks, "premise: generic declares none (spec §3.1)").toBeUndefined();
  });

  it("no finished fixture: the sport and its declared kinds are there, the sample is not - then a finished one appears, then a NEWER one replaces it (sequence)", async () => {
    const o = await org();
    const a = await seedDivision(o.auth, o.competitionId, "football", VARIANT.football!, "football a");
    const none = (await loadOnStreamScope(o.orgId, null)).sports;
    expect(none).toHaveLength(1);
    expect(none[0]!.sample, "no match played").toBeNull();
    expect(none[0]!.kinds!.length, "the static line has kinds to name").toBeGreaterThan(0);

    const older = chooseWalk("football", a.cfg);
    await finishWith(o.orgId, a, older, daysAgo(3));
    expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample).toEqual(sampleOf(older));

    const b = await seedDivision(o.auth, o.competitionId, "football", VARIANT.football!, "football b");
    const newer = chooseWalk("football", b.cfg, 1);
    expect(sampleOf(newer), "premise: the two matches differ").not.toEqual(sampleOf(older));
    await finishWith(o.orgId, b, newer, daysAgo(1));
    expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample, "the most recent finished fixture wins").toEqual(sampleOf(newer));
  });

  it("only a match played to a result is the sample: in play, abandoned, forfeited and another org's fixtures are not (the denied cases), while a finalized one is", async () => {
    const o = await org();
    const foreign = await org();
    const rigs = [] as (RiggedDivision & { name: string; walk: Walk })[];
    for (const [i, name] of ["in_play", "abandoned", "forfeited", "finalized"].entries()) {
      const r = await seedDivision(o.auth, o.competitionId, "football", VARIANT.football!, `football ${name}`);
      rigs.push({ ...r, name, walk: chooseWalk("football", r.cfg, i) });
    }
    // The other org's finished match, MORE recent than any of ours.
    const f = await seedDivision(foreign.auth, foreign.competitionId, "football", VARIANT.football!, "foreign football");
    await finishWith(foreign.orgId, f, chooseWalk("football", f.cfg, 4), daysAgo(0));

    const [inPlay, abandoned, forfeited, finalized] = rigs as [typeof rigs[0], typeof rigs[0], typeof rigs[0], typeof rigs[0]];
    await finishWith(o.orgId, inPlay, inPlay.walk, daysAgo(0), "in_play");
    await finishWith(o.orgId, abandoned, abandoned.walk, daysAgo(0), "abandoned");
    await finishWith(o.orgId, forfeited, forfeited.walk, daysAgo(0), "forfeited");
    expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample, "none of the three is a played match").toBeNull();

    await finishWith(o.orgId, finalized, finalized.walk, daysAgo(2), "finalized");
    expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample, "a finalized one is").toEqual(sampleOf(finalized.walk));
    // ...and the foreign org's own preview is ITS match, not ours.
    expect((await loadOnStreamScope(foreign.orgId, null)).sports[0]!.sample).not.toEqual(sampleOf(finalized.walk));
  });

  it("a fold that refuses costs that candidate only: the next most recent finished fixture is the sample; with none left, none (and it never throws)", async () => {
    const o = await org();
    const good = await seedDivision(o.auth, o.competitionId, "football", VARIANT.football!, "football good");
    const bad = await seedDivision(o.auth, o.competitionId, "football", VARIANT.football!, "football bad");
    const goodWalk = chooseWalk("football", good.cfg);
    await finishWith(o.orgId, good, goodWalk, daysAgo(3));
    await finishWith(o.orgId, bad, chooseWalk("football", bad.cfg, 1), daysAgo(1));
    // An entrant deleted after scoring leaves the fixture unattributable: loadFoldInputs refuses it (WRONG_PHASE).
    await sql`update fixtures set away_entrant_id = null where id = ${bad.fixtureId}`;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample).toEqual(sampleOf(goodWalk));
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ fixtureId: bad.fixtureId, code: "WRONG_PHASE" }), expect.stringContaining("preview fixture skipped"));
      await sql`update fixtures set away_entrant_id = null where id = ${good.fixtureId}`;
      expect((await loadOnStreamScope(o.orgId, null)).sports[0]!.sample).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(PREVIEW_CANDIDATES, "the bound on how far back the loader looks").toBeGreaterThan(1);
  });

  it("a competition scope previews its OWN sports and fixtures: another competition's sport is not listed, its match is not the sample", async () => {
    const o = await org();
    const other = await createCompetition(o.auth, { ends_on: "2030-12-31", name: "Autumn Cup", visibility: "public", branding: {} });
    const c = await seedDivision(o.auth, o.competitionId, "cricket", VARIANT.cricket!, "cricket div");
    const b = await seedDivision(o.auth, other.id, "badminton", VARIANT.badminton!, "badminton div");
    const cw = chooseWalk("cricket", c.cfg);
    const bw = chooseWalk("badminton", b.cfg);
    await finishWith(o.orgId, c, cw, daysAgo(1));
    await finishWith(o.orgId, b, bw, daysAgo(1));

    const whole = await loadOnStreamScope(o.orgId, null);
    expect(whole.sports.map((s) => s.sportKey)).toEqual(["badminton", "cricket"]);
    const inSpring = await loadOnStreamScope(o.orgId, o.competitionId);
    expect(inSpring.sports.map((s) => [s.sportKey, s.sample])).toEqual([["cricket", sampleOf(cw)]]);
    const inAutumn = await loadOnStreamScope(o.orgId, other.id);
    expect(inAutumn.sports.map((s) => [s.sportKey, s.sample])).toEqual([["badminton", sampleOf(bw)]]);
    expect(builtinModules.some((m) => m.key === "cricket")).toBe(true);
  });

  it("the settings come from S5's resolver: no row -> null; the org row; a competition with no row reads the org's (not its own); a competition row is its own", async () => {
    const o = await org();
    const other = await createCompetition(o.auth, { ends_on: "2030-12-31", name: "Autumn Cup", visibility: "public", branding: {} });
    expect(await loadOnStreamScope(o.orgId, null)).toMatchObject({ settings: null, ownRow: false, sports: [] });

    await sql`insert into sponsor_stream_settings (org_id, enabled, frequency) values (${o.orgId}, true, 'busy')`;
    expect(await loadOnStreamScope(o.orgId, null)).toMatchObject({ settings: { enabled: true, frequency: "busy" }, ownRow: true });
    const fallsThrough = await loadOnStreamScope(o.orgId, o.competitionId);
    expect(fallsThrough, "no row of its own: the org's, and not its own").toMatchObject({ settings: { enabled: true, frequency: "busy" }, ownRow: false });

    await sql`insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency) values (${o.orgId}, ${o.competitionId}, false, 'light')`;
    expect(await loadOnStreamScope(o.orgId, o.competitionId)).toMatchObject({ settings: { enabled: false, frequency: "light" }, ownRow: true });
    expect((await loadOnStreamScope(o.orgId, other.id)).settings, "the other competition still reads the org's").toEqual({ enabled: true, frequency: "busy" });

    // The loader asks the one resolver: whatever it answers, for every scope, is what the loader reports (parity, counted).
    let scopes = 0;
    for (const scope of [null, o.competitionId, other.id]) {
      expect((await loadOnStreamScope(o.orgId, scope)).settings, String(scope)).toEqual(await resolveStreamSettings(sql, o.orgId, scope));
      scopes++;
    }
    expect(scopes).toBe(3);
  });
});
