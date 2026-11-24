// Seazn-hosted video, Phase 4 Task 38: what the Streaming page's "Score on stream" previews are drawn from (server/stream-club-score.ts).
// The club's OWN sports (its divisions' sports the overlay can render), each as the overlay draws a match of that sport in play; a club with
// none gets one generic preview; a preview that cannot be built must never take the page down (a scheduled card in its place, reported).
// Real DB (the divisions), real gallery snapshots (the engine folds), only the failure is injected.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { seedOrg } from "./_rig";

const hook = vi.hoisted(() => ({ failFor: null as string | null, reported: [] as unknown[][] }));
vi.mock("@/server/overlay/gallery-snapshots", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/overlay/gallery-snapshots")>();
  return {
    ...real,
    gallerySnapshots: (now?: number, keys?: readonly string[]) => {
      if (hook.failFor !== null && keys?.includes(hook.failFor)) throw new Error(`injected: ${hook.failFor}`);
      return real.gallerySnapshots(now, keys);
    },
  };
});
vi.mock("@/lib/sentry", () => ({ captureError: (...a: unknown[]) => { hook.reported.push(a); } }));

import { clubScorePreview, CLUB_PREVIEW_FALLBACK_SPORT } from "../../stream-club-score";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
beforeEach(() => { hook.failFor = null; hook.reported.length = 0; });

async function withDivision(auth: Awaited<ReturnType<typeof seedOrg>>["auth"], sport: "generic" | "football") {
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Club Cup " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  return createDivision(auth, competition.id, sport === "football"
    ? { name: "Teams", sport_key: "football", variant_key: "11-a-side", config: {} }
    : { name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } });
}

describe.skipIf(!HAS_DB)("clubScorePreview", () => {
  it("a club with no division: ONE generic preview, flagged as the fallback, with a real in-play snapshot for it", async () => {
    const { auth } = await seedOrg();
    const p = await clubScorePreview(auth.orgId);
    expect(p.sports.map((s) => s.key)).toEqual([CLUB_PREVIEW_FALLBACK_SPORT]);
    expect(p.fallback).toBe(true);
    expect(Object.keys(p.snapshots)).toEqual([CLUB_PREVIEW_FALLBACK_SPORT]);
    expect(p.snapshots[CLUB_PREVIEW_FALLBACK_SPORT]!.status, "the overlay's own in-play sample, not a stand-in").toBe("in_play");
    expect(p.snapshots[CLUB_PREVIEW_FALLBACK_SPORT]!.summary, "folded through the real engine: a summary exists").not.toBeNull();
  });

  it("the club's own sports, by name, each with its own snapshot; a second division of a sport already present adds nothing; another org's sports never appear", async () => {
    const { auth } = await seedOrg();
    await withDivision(auth, "football");
    await withDivision(auth, "football");
    await withDivision(auth, "generic");
    const other = await seedOrg();
    await withDivision(other.auth, "generic");
    const p = await clubScorePreview(auth.orgId);
    expect(p.fallback).toBe(false);
    expect(p.sports.map((s) => s.key).sort(), "football and generic once each").toEqual(["football", "generic"]);
    const names = p.sports.map((s) => s.name);
    expect(names, "in name order").toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(Object.keys(p.snapshots).sort()).toEqual(["football", "generic"]);
    for (const s of p.sports) expect(p.snapshots[s.key]!.status, s.key).toBe("in_play");
    const others = await clubScorePreview(other.auth.orgId);
    expect(others.sports.map((s) => s.key), "the other org holds generic alone").toEqual(["generic"]);
    expect(others.fallback, "its own sport, not the fallback").toBe(false);
    expect(OVERLAY_SPORT_KEYS.includes("football") && OVERLAY_SPORT_KEYS.includes("generic"), "premise: both are overlay sports").toBe(true);
  });

  // The sports catalogue and the overlay's sports are the same eleven today, so the guard that drops a sport the overlay cannot render (a
  // gallery walk of it would throw) has no real sport to meet. A catalogue row of its own makes one: removed again, whatever the outcome.
  it("a division of a sport the overlay does not render is left out of the previews (never walked, never a switch entry)", async () => {
    const { auth } = await seedOrg();
    const generic = await withDivision(auth, "generic");
    const KEY = "zz_t38_nonoverlay";
    await sql`insert into sports (key, name, module_version, position_catalog) values (${KEY}, 'ZZ Not an overlay sport', '0', '{}'::jsonb)`;
    try {
      await sql`update divisions set sport_key = ${KEY} where id = ${generic.id}`;
      const alone = await clubScorePreview(auth.orgId);
      expect(alone.sports.map((x) => x.key), "the only division is not renderable: the generic fallback").toEqual([CLUB_PREVIEW_FALLBACK_SPORT]);
      expect(alone.fallback).toBe(true);
      await withDivision(auth, "football");
      const mixed = await clubScorePreview(auth.orgId);
      expect(mixed.sports.map((x) => x.key), "the renderable sport alone").toEqual(["football"]);
      expect(Object.keys(mixed.snapshots)).toEqual(["football"]);
      expect(OVERLAY_SPORT_KEYS.includes(KEY), "premise: the overlay does not render it").toBe(false);
    } finally {
      await sql`update divisions set sport_key = 'generic' where id = ${generic.id}`;
      await sql`delete from sports where key = ${KEY}`;
    }
  });

  it("a preview that cannot be built does not take the page down: that sport shows the scheduled card, the failure is reported with the org, and the other sport still draws", async () => {
    const { auth } = await seedOrg();
    await withDivision(auth, "football");
    await withDivision(auth, "generic");
    hook.failFor = "football";
    const p = await clubScorePreview(auth.orgId);
    expect(p.snapshots.football!.status).toBe("scheduled");
    expect(p.snapshots.football!.summary).toBeNull();
    expect(p.snapshots.generic!.status, "the sibling is untouched").toBe("in_play");
    expect(hook.reported).toHaveLength(1);
    expect(hook.reported[0]![1]).toMatchObject({ orgId: auth.orgId, route: "streaming.club_score_preview", extra: { sport: "football" } });
    hook.failFor = null;
    hook.reported.length = 0;
    expect((await clubScorePreview(auth.orgId)).snapshots.football!.status, "the positive pair: healthy again").toBe("in_play");
    expect(hook.reported).toHaveLength(0);
  });
});
