// Owner bug, 2026-10-15 (live proof of concept): the stream overlay put up its end card when the match was decided,
// the scorer then UNDID the deciding point, and the end card stayed on air.
//
// Root cause: the server reopened the fixture (the void folds the outcome away and `fixtures.status` goes back to
// `in_play` — `undo-status.test.ts` pins that half), but `useLiveFixture` treated "decided" as terminal. Its `live`
// predicate admitted only scheduled / in_play / needs_decision, so the poll that delivered the decided snapshot tore
// down both the poll and the realtime channel, and nothing ever fetched again. The undo was invisible to the page.
//
// Driven end to end with ONE substitution, the network hop: the REAL scoring usecase writes the ledger (`scoreEvent`,
// undo = `core.void`), the REAL overlay route answers the poll (`GET /api/v1/public/fixtures/{id}/overlay` →
// `loadOverlayLiveData` → Postgres), the REAL `fetchOverlayFixture` → `api()` reads it, and the REAL `OverlayStage` →
// `useLiveFixture` → `overlayModel` → `slateStateOf` decides whether the end card is mounted. `fetch` is pointed at the
// route handler instead of a socket; nothing else is doubled except `unstable_cache` (no Next incremental cache under
// vitest — the same passthrough `overlay/__tests__/route.test.ts` uses).
//
// The SEQUENCE is the test (TEST-STRATEGY): decide → undo → card gone → re-decide → card back → undo again → gone, for
// two sports that decide in different shapes (badminton on a single rally, cricket on an innings summary), plus the
// void path (abandon → undo). Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import type { ReactElement } from "react";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import type { AuthCtx } from "@/server/api-v1/auth";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { GET as overlayRoute } from "@/app/api/v1/public/fixtures/[id]/overlay/route";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { POLL_MS } from "@/components/public-site/match-centre/use-live-fixture";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayModel } from "@/lib/overlay-model";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OverlayMatchCard } from "../overlay-slate";
import { OVERLAY_THEMES, resolveTheme } from "../theme-registry";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------------
// The network hop: `api()` calls `fetch(url)`; here that URL reaches the overlay route handler in-process. Every request
// is tracked so a poll can be awaited to completion — real Postgres I/O does not run on the fake clock.
// ---------------------------------------------------------------------------------------------------------------------
const OVERLAY_PATH = /^\/api\/v1\/public\/fixtures\/([0-9a-f-]{36})\/overlay$/;
const inflight = new Set<Promise<unknown>>();
let fetches = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // ONLY the interval is faked: it is the poll's clock. Postgres, the route and `api()` keep real timers, so the I/O a
  // poll starts completes on its own and `settle()` can wait for it.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fetches = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const m = OVERLAY_PATH.exec(url);
    if (!m) throw new Error(`unexpected fetch in the overlay undo test: ${url}`);
    fetches++;
    const p = overlayRoute(
      new Request(`https://test.local${url}`, { headers: { "x-forwarded-for": "10.0.0.1" } }),
      { params: Promise.resolve({ id: m[1]! }) },
    );
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** Let every request in flight land, and the hook's `setData` after it, before reading the tree. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (inflight.size > 0) await Promise.allSettled([...inflight]);
    // A real macrotask turn: `api()` awaits `res.json()` and the hook sets state after that, all on microtasks.
    await new Promise((r) => setTimeout(r, 5));
    if (inflight.size === 0) return;
  }
  throw new Error("overlay polls never settled");
}

/** One poll period on the stage's own clock; answers how many requests it made. */
async function onePollPeriod(): Promise<number> {
  const before = fetches;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await settle();
  return fetches - before;
}

// ---------------------------------------------------------------------------------------------------------------------
// Seed: a PUBLIC competition (the overlay route reads `public_fixtures_v`) on a pro org (streaming.overlay), one fixture.
// ---------------------------------------------------------------------------------------------------------------------
interface Rig {
  auth: AuthCtx;
  sportKey: string;
  fixtureId: string;
  home: string;
  away: string;
}

async function seedPublicFixture(sportKey: string, variantKey: string): Promise<Rig> {
  const mod = builtinModules.find((m) => m.key === sportKey);
  if (!mod) throw new Error(`no builtin module ${sportKey}`);
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Undo Cup ${suffix}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: sportKey,
    variant_key: variantKey,
    config: (mod.variants as Record<string, unknown>)[variantKey] as Record<string, unknown>,
  } as never);
  const kind = effectiveEntrantModel(mod.entrantModel).defaultKind;
  await createEntrants(
    auth,
    division.id,
    ["Home", "Away"].map((name, i) => ({ kind, display_name: `${name} ${suffix}`, seed: i + 1, members: [] })) as never,
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} } as never);
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const fx = fixtures[0]! as { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  if (!fx.home_entrant_id || !fx.away_entrant_id) throw new Error("rig: the fixture must seat both entrants");
  return { auth, sportKey, fixtureId: fx.id, home: fx.home_entrant_id, away: fx.away_entrant_id };
}

const tip = async (fixtureId: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${fixtureId}`)[0]!.s;

/** Through the REAL scoring usecase — the pad's own write path. */
async function score(r: Rig, type: string, payload: unknown = {}) {
  return scoreEvent(r.auth, r.fixtureId, { expected_seq: await tip(r.fixtureId), type, payload } as never);
}

/** The pad's Undo: a `core.void` naming the entry it takes back. */
async function undo(r: Rig, eventId: string) {
  return scoreEvent(r.auth, r.fixtureId, {
    expected_seq: await tip(r.fixtureId),
    type: "core.void",
    payload: { event_id: eventId },
  } as never);
}

const serverStatus = async (fixtureId: string) =>
  (await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`)[0]!.status;

// ---------------------------------------------------------------------------------------------------------------------
// The stage, mounted exactly as the OBS page mounts it: `initial` from `loadOverlayLiveData`, the sport's own default
// theme, no realtime (the poll is the transport every overlay falls back to).
// ---------------------------------------------------------------------------------------------------------------------
const THEME_COMPONENTS = new Set<unknown>(Object.values(OVERLAY_THEMES).map((t) => t.component));

async function mountOverlay(r: Rig) {
  const props: OverlayStageProps = {
    fixtureId: r.fixtureId,
    initial: JSON.parse(JSON.stringify(await loadOverlayLiveData(r.fixtureId))),
    realtime: false,
    sportKey: r.sportKey,
    style: resolveTheme(undefined, r.sportKey).id,
    sides: [
      { id: r.home, name: "Home" },
      { id: r.away, name: "Away" },
    ],
    startLabel: null,
    dict: {},
    decidedTemplates: decidedOutcomeTemplates((k) => k),
  };
  const island = renderIsland<OverlayStageProps>(OverlayStage, props);
  await settle(); // the mount-time refresh
  const tree = (): ReactElement[] => island.tree();
  return {
    island,
    /** Is the match/end card layer mounted over the scorebug? */
    cardUp: () => tree().some((el) => el.type === OverlayMatchCard),
    /** What the stage handed its theme — for the failure message, never for the verdict. */
    model: () => {
      const theme = tree().find((el) => THEME_COMPONENTS.has(el.type));
      const m = theme ? (propsOf(theme).model as OverlayModel) : null;
      return m ? { decided: m.decided, voided: m.voided, live: m.live } : null;
    },
  };
}

type Overlay = Awaited<ReturnType<typeof mountOverlay>>;

/** One step of the sequence: the poll after a write must carry the server's state onto the card. */
async function expectCard(o: Overlay, r: Rig, up: boolean, step: string) {
  const polled = await onePollPeriod();
  const status = await serverStatus(r.fixtureId);
  expect(
    o.cardUp(),
    `${r.sportKey} — ${step}: the server says "${status}", ${polled} poll(s) ran, the stage's model is ` +
      `${JSON.stringify(o.model())}; the end card must be ${up ? "UP" : "DOWN"}`,
  ).toBe(up);
}

// ---------------------------------------------------------------------------------------------------------------------
// The two sports, each with its own deciding write. Both return the deciding event's id, so the undo names it exactly
// as the pad's Undo does.
// ---------------------------------------------------------------------------------------------------------------------
interface SportCase {
  sportKey: string;
  variantKey: string;
  /** Everything up to (not including) the deciding write. */
  approach: (r: Rig) => Promise<void>;
  /** The deciding write; returns its event id. */
  decide: (r: Rig) => Promise<string>;
}

const CASES: SportCase[] = [
  {
    // Badminton `short`: to 11, best of three — so 21 unanswered rallies leave home one rally from the match, and the
    // 22nd decides it. The owner's report, literally: the scorer undoes the last POINT.
    sportKey: "badminton",
    variantKey: "short",
    approach: async (r) => {
      await score(r, "core.start");
      for (let i = 0; i < 21; i++) await score(r, "badminton.rally", { wonBy: r.home });
    },
    decide: async (r) => (await score(r, "badminton.rally", { wonBy: r.home })).event_id,
  },
  {
    // Cricket, the bar style's sport: a T20 whose chase falls short in its full quota. The deciding write is the second
    // innings' summary — a different shape of decision from a rally, through the same transport.
    sportKey: "cricket",
    variantKey: "t20",
    approach: async (r) => {
      await score(r, "core.start");
      await score(r, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120 });
    },
    decide: async (r) =>
      (await score(r, "cricket.innings.summary", { runs: 100, wickets: 6, legalBalls: 120 })).event_id,
  },
];

describe.skipIf(!HAS_DB)("the overlay's end card follows an undo of the deciding write (owner bug 2026-10-15)", () => {
  // Two sports, named rather than swept: each needs its own deciding ledger, and the defect is in the sport-agnostic
  // transport; the hook-level sweep in `use-live-fixture.test.ts` covers every fixture status.
  it("the rig's two sports really are different decision shapes (anti-vacuity)", () => {
    expect(CASES.map((c) => c.sportKey)).toEqual(["badminton", "cricket"]);
    // Different default themes, so both of the overlay's scorebug registrations sit under the card at least once.
    expect(new Set(CASES.map((c) => resolveTheme(undefined, c.sportKey).id)).size).toBe(2);
  });

  for (const c of CASES) {
    it(`${c.sportKey}: decide → undo → card gone → re-decide → card back → undo again → gone`, async () => {
      const r = await seedPublicFixture(c.sportKey, c.variantKey);
      await c.approach(r);
      expect(await serverStatus(r.fixtureId), "rig: the match is in play before the deciding write").toBe("in_play");

      const o = await mountOverlay(r);
      expect(o.cardUp(), "empty case first: an in-play match carries no end card").toBe(false);

      const first = await c.decide(r);
      expect(await serverStatus(r.fixtureId)).toBe("decided");
      await expectCard(o, r, true, "after the deciding write");

      await undo(r, first);
      // The backend half, stated where the reader needs it: the server HAS reopened the match.
      expect(await serverStatus(r.fixtureId), "the undo reopens the fixture server-side").toBe("in_play");
      await expectCard(o, r, false, "after the undo");

      const second = await c.decide(r);
      expect(await serverStatus(r.fixtureId)).toBe("decided");
      await expectCard(o, r, true, "after re-deciding");

      await undo(r, second);
      expect(await serverStatus(r.fixtureId)).toBe("in_play");
      await expectCard(o, r, false, "after the second undo");

      o.island.unmount();
    }, 120_000);
  }

  it("the void path: abandon puts the card up, undoing the abandon takes it down (badminton)", async () => {
    // single-sport: the abandon is `core.*`, sport-agnostic; badminton is the rig whose abandon decides nobody.
    const r = await seedPublicFixture("badminton", "short");
    await score(r, "core.start");
    await score(r, "badminton.rally", { wonBy: r.home });
    const o = await mountOverlay(r);
    expect(o.cardUp(), "empty case first: an in-play match carries no end card").toBe(false);

    const abandon = await score(r, "core.abandon", { reason: "power cut" });
    expect(await serverStatus(r.fixtureId)).toBe("abandoned");
    await expectCard(o, r, true, "after the abandon");

    await undo(r, abandon.event_id);
    expect(await serverStatus(r.fixtureId), "undoing the abandon reopens the fixture").toBe("in_play");
    await expectCard(o, r, false, "after undoing the abandon");

    o.island.unmount();
  }, 120_000);
});
