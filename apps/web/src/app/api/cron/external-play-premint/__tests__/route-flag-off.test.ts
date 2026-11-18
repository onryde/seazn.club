// POST /api/cron/external-play-premint over the REAL pass with EXTERNAL_PLAY_PREMINT off (ruling, plan 2 Task 4 review G1: the
// Worker schedule ships, the flag stays off until Task 8 lands). route.test.ts mocks the pass, so it cannot say what the route
// does with the flag off; this file can: the route is called with its real handler, the real pass behind it, the real database
// and the real RealtimeKit adapter pointed at the e2e fixture server, whose `calls` count what the vendor was actually asked.
//
// Every case is run on a database that HAS work waiting (an online, camera-on, unopened round with paired boards): a flag-off
// pass that did nothing because there was nothing to do would read the same, so each case first proves the candidates exist.
//
// Flag-off ONLY, on purpose: a flag-ON pass through the route serves every org in the database, and the rooms it made would
// belong to whichever other suite's boards happen to be waiting in the same database. The flag-on pass is
// usecases/__tests__/external-play-premint.test.ts, scoped to its own orgs.
//
// Chess-only (single-sport reason): online play is `onlinePlay = 'lichess'` on `boardgame`; no other sport has an online board
// (guard.ts `d.sport_key = 'boardgame'`), so there is no sport axis to sweep.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { premintCandidates, type PremintReport } from "@/server/usecases/external-play/premint";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";
import { REALTIMEKIT_FIXTURE_ENV, startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../../../../../../e2e/realtimekit-fixture-server";

// apps/cron-worker is outside the Fly image's build context; the specifiers are computed so tsc never resolves them (route.test.ts's
// reason). vitest still loads the REAL modules, so the Worker reads this route's real body through its own `failureCountsOver0`.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[] };
const ROW = JOBS.find((j) => j.id === "external-play-premint");

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

import { POST } from "../route";

const DB = !!process.env.DATABASE_URL;

/** What a flag-off pass answers, typed from the REAL `PremintReport`: it scanned nothing, made nothing and failed at nothing. */
const DISABLED: PremintReport = { skipped: 0, disabled: 1, scanned: 0, roomsMade: 0, deferred: 0, failed: 0, windowsOpen: 0, failures: [] };

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(async () => {
  await fx.reset();
  // The vendor is the FIXTURE even though nothing should reach it: a guard that broke would otherwise call the real RealtimeKit
  // with whatever credentials the developer's .env.local holds.
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
});

describe.skipIf(!DB)("POST /api/cron/external-play-premint with the flag off, over the real pass", () => {
  it("answers `disabled: 1` and makes ZERO vendor calls and no room, though a camera-on unopened round is waiting; the Worker reads it as healthy", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, cameraPolicy: "optional" });
    const boardIds = r.boards.map((b) => b.fixtureId);
    // The premise: with the flag ON this round's four (board, side) rows are exactly what the pass would make rooms for.
    expect((await premintCandidates([r.orgId])).length, "premise: the waiting work the flag keeps off").toBe(4);
    expect(ROW, "the external-play-premint row").toBeDefined();

    // The flag is exactly "1": unset (the default) and every other spelling is off.
    let checked = 0;
    for (const value of [undefined, "", "0", "true"]) {
      vi.stubEnv("EXTERNAL_PLAY_PREMINT", value);
      const res = await POST();
      const text = await res.text();
      expect(res.status, `flag ${JSON.stringify(value)}`).toBe(200);
      expect(JSON.parse(text), `flag ${JSON.stringify(value)}: the real pass's whole report, nothing scanned`).toEqual({ ok: true, data: DISABLED });
      expect(failureCountsOver0(ROW!, text), `flag ${JSON.stringify(value)}: a flag-off pass is healthy, never a page every minute`).toEqual({});
      checked++;
    }
    expect(checked, "anti-vacuity: four off values").toBe(4);

    expect(fx.calls, "zero vendor calls").toEqual([]);
    const rooms = await sql<{ n: number }[]>`select count(*)::int as n from fixture_video_meetings where fixture_id in ${sql(boardIds)}`;
    expect(rooms[0]!.n, "and no room on file for the round").toBe(0);
    expect(
      (await premintCandidates([r.orgId])).length,
      "the work is still waiting: the pass left it for the day the flag is on",
    ).toBe(4);
  });
});
