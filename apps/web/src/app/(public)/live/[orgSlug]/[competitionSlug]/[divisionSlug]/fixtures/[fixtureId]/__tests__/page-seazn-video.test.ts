// Seazn-hosted video, Phase 1 Task 15 (spec §5.1): the public match page mounts the Seazn island, or the YouTube slot, from the fixture's
// OWN facts, through the REAL loader and the REAL plan. `page.test.ts` pins the mount against a stood-in plan with non-uuid ids; this
// file is the seam the stand-in cannot prove (recurring class 1, the inert seam): real sessions made by the organiser's Go live and Stop
// (`createSession`), the real `getPublicFixture`, `seaznVideoPlan` over those rows, and the page's own element tree. Only the Next
// runtime pieces a node test cannot run are replaced: unstable_cache is a passthrough, and `useSearchParams` answers an empty query.
//
// Each case is one of the plan's rulings, here at the page:
//   - LIVE OFF, a fixture that streamed to Seazn: the island, whatever LIVE is (controller ruling: LIVE gates new streams only);
//   - LIVE ON, a PAST YouTube fixture with no saved choice (the org's default now resolves Seazn): the YouTube slot with its parts and
//     no island (the blocker's regression);
//   - LIVE ON, an UNSTARTED fixture whose default is Seazn: the island (so a viewer who opens the page before kick-off gets the player
//     at live without a reload); LIVE OFF: nothing of either.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the slot reads no sport rule. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

import { sql } from "@/lib/db";
import { ReplayEmbed } from "@/components/public-site/match-centre/replay-embed";
import { SeaznVideoIsland } from "@/components/public-site/match-centre/seazn-video-island";
import { fixtureStreamTarget } from "@/server/usecases/stream-codes";
import { MAX_DURATION_MINUTES } from "@/server/relay/config";
import { seaznVideoPlan } from "@/server/video/seazn-video-plan";
import { type SeaznRig, installSeaznEnv, live, seaznRig, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-page-test");
const liveOff = () => vi.stubEnv("SEAZN_HOSTED_LIVE", "false");

/** Every element of `type` in the tree, through children and every other prop that holds elements (the replay is a prop). */
function findAll(node: unknown, type: unknown, out: { props: Record<string, unknown> }[] = []) {
  if (Array.isArray(node)) {
    for (const c of node) findAll(c, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node as unknown as { props: Record<string, unknown> });
  for (const value of Object.values(node.props as Record<string, unknown>)) findAll(value, type, out);
  return out;
}

/** The rig's competition made public (the loader serves public ones), and the path segments the page is asked for. */
async function publish(fixtureId: string) {
  const [row] = await sql<{ org: string; comp: string; div: string; competition_id: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div, c.id as competition_id
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = f.org_id
     where f.id = ${fixtureId}`;
  expect(row, "PREMISE: the rig's fixture has a competition and an org").toBeDefined();
  await sql`update competitions set visibility = 'public', status = 'live' where id = ${row!.competition_id}`;
  return { orgSlug: row!.org, competitionSlug: row!.comp, divisionSlug: row!.div, fixtureId };
}
async function pageTree(fixtureId: string) {
  const params = await publish(fixtureId);
  const { default: FixturePage } = await import("../page");
  return FixturePage({ params: Promise.resolve(params) });
}
const setStatus = (fixtureId: string, status: string) => sql`update fixtures set status = ${status} where id = ${fixtureId}`;
const defaultPick = async (r: SeaznRig, fixtureId: string) => (await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId }))?.id ?? null;
const slots = (tree: unknown) => ({ island: findAll(tree, SeaznVideoIsland), youtube: findAll(tree, ReplayEmbed) });

const orgs: string[] = [];
afterAll(async () => {
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`.catch(() => undefined);
});

describe.skipIf(!HAS_DB)("the public match page's replay slot, through the real loader and the real plan (Task 15)", () => {
  it("a fixture that streamed to Seazn keeps the island with LIVE OFF (the ruling), and none of YouTube's slot", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    for (const flag of ["true", "false"] as const) {
      vi.stubEnv("SEAZN_HOSTED_LIVE", flag);
      const tree = await pageTree(f);
      const { island, youtube } = slots(tree);
      expect(island, `LIVE ${flag}: the island is mounted`).toHaveLength(1);
      expect(island[0]!.props.fixtureId).toBe(f);
      expect(youtube, `LIVE ${flag}: and the YouTube slot is not`).toHaveLength(0);
      const markup = renderToStaticMarkup(tree);
      expect(markup).not.toContain("replay-embed");
      // Phase 1 visual D1: the page's own server markup holds the player's box (16:9, 200 px floor), empty, before any read.
      expect(island[0]!.props.reserve, `LIVE ${flag}: the plan reserves the box`).toBe(true);
      const box = /<section data-testid="seazn-video-reserved"[^>]*>\s*<div data-testid="seazn-video-frame" class="([^"]*)"><\/div>\s*<\/section>/.exec(markup);
      expect(box, `LIVE ${flag}: the reserved box is in the page's server markup, empty`).not.toBeNull();
      for (const c of ["aspect-video", "min-h-[200px]", "w-full", "bg-black"]) expect(box![1]!.split(" "), c).toContain(c);
    }
  });

  it("review I2: the island is handed the plan's settle time through the REAL loader and plan: a decided Seazn fixture's (its finish stamped by the database), as an ISO instant; null while it is in play", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    await setStatus(f, "in_play");
    const playing = slots(await pageTree(f)).island;
    expect(playing, "premise: the island is mounted").toHaveLength(1);
    expect(playing[0]!.props.settledAt, "in play: not settled").toBeNull();
    await setStatus(f, "decided");
    const plan = await seaznVideoPlan(f);
    expect(plan.player === "seazn" ? plan.settledAt : undefined, "PREMISE: the plan settles it").toBeInstanceOf(Date);
    const decided = slots(await pageTree(f)).island;
    expect(decided[0]!.props.settledAt, "decided: the plan's own instant, as the client reads it").toBe((plan as { settledAt: Date }).settledAt.toISOString());
  });

  it("review N1: the island is handed the plan's poll hints through the REAL loader and plan — none for a decided fixture with no kick-off time; the kick-off and an active bound (MAX_DURATION_MINUTES from the render) once it is in play", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    await sql`update fixtures set scheduled_at = null where id = ${f}`;
    const cold = slots(await pageTree(f)).island;
    expect(cold, "premise: the island is mounted").toHaveLength(1);
    expect({ kickoffAt: cold[0]!.props.kickoffAt, activeUntil: cold[0]!.props.activeUntil }, "EMPTY CASE FIRST: nothing hot").toEqual({ kickoffAt: null, activeUntil: null });
    const kickoff = new Date(Date.now() + 10 * 60_000);
    kickoff.setMilliseconds(0);
    await sql`update fixtures set scheduled_at = ${kickoff} where id = ${f}`;
    await setStatus(f, "in_play");
    const before = Date.now();
    const hot = slots(await pageTree(f)).island;
    const after = Date.now();
    expect(hot[0]!.props.kickoffAt, "the fixture's kick-off, as an ISO instant").toBe(kickoff.toISOString());
    const until = Date.parse(String(hot[0]!.props.activeUntil));
    expect(until, "in play: active until the render + MAX_DURATION_MINUTES").toBeGreaterThanOrEqual(before + MAX_DURATION_MINUTES * 60_000);
    expect(until).toBeLessThanOrEqual(after + MAX_DURATION_MINUTES * 60_000);
  });

  it("a PAST YouTube fixture with no saved choice keeps its replay with its parts, though the org's default now resolves Seazn (the blocker's regression)", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.pasted);
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    // The organiser's Go live saved its pick; this fixture has NO saved choice (a Stop stamp or the auto switch leaves a row that chose nothing).
    await sql`update fixture_stream_settings set target_chosen = false where fixture_id = ${f}`;
    expect(await defaultPick(r, f), "PREMISE: its default is now Seazn, as the blocker had it").toBe(r.seazn);
    // The YouTube end step's own row: a completed broadcast of the fixture, which the loader reads through the parts view.
    const userId = r.auth.userId!;
    const conn = await connect({ auth: { orgId: r.auth.orgId, via: "session", userId, role: "owner", keyId: null }, orgId: r.auth.orgId, userId });
    await sql`
      insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, completed_at)
      values (false, ${r.auth.orgId}, ${conn.connectionId}, ${f}, ${`t15${randomUUID().replace(/-/g, "").slice(0, 8)}`}, 'Match', 'unlisted', 'complete', now())`;
    const tree = await pageTree(f);
    const { island, youtube } = slots(tree);
    expect(island, "no Seazn island on a fixture that streamed to YouTube").toHaveLength(0);
    expect(youtube, "the YouTube slot is mounted").toHaveLength(1);
    expect((youtube[0]!.props.parts as unknown[]).length, "with its part").toBe(1);
    expect(renderToStaticMarkup(tree)).toContain('data-testid="replay-embed"');
  });

  it("an UNSTARTED fixture whose default is Seazn gets the island before kick-off with LIVE on, and nothing of either slot with LIVE off", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    expect(await defaultPick(r, f), "PREMISE: the default is Seazn").toBe(r.seazn);
    const onTree = await pageTree(f);
    const on = slots(onTree);
    expect(on.island, "LIVE on: the island").toHaveLength(1);
    expect(on.youtube).toHaveLength(0);
    // Phase 1 visual D1: before kick-off "nothing yet" is the expected answer, so no box is held (it would collapse on every load).
    expect(on.island[0]!.props.reserve, "no Seazn session yet: no box").toBe(false);
    expect(renderToStaticMarkup(onTree)).not.toContain("seazn-video-reserved");
    liveOff();
    const off = slots(await pageTree(f));
    expect(off.island, "LIVE off: no island").toHaveLength(0);
    expect(off.youtube, "and no YouTube slot (it has no parts): the page as it was").toHaveLength(0);
  });
});
