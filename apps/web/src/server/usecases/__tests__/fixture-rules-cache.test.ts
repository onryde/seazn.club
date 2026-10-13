// W2c Task 14, fix round 1 (minor 2) — an UNSTARTED override write changes what the public match page prints (its
// format line), so the writer drops that fixture's public documents through the one score-write door
// (`invalidatePublicCache`, usecases/scoring.ts) exactly as a correction does. Nothing re-folds for an unstarted match,
// so this door is the write's only public effect: a writer that forgot it stays green everywhere else.
//
// Real Postgres for the rows (the keys are derived from the real fixture → division → competition → org); only the
// Redis door and the ISR tag call are replaced, to be observed (admin-fixture-config-cache.test.ts's pattern).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const cacheDel = vi.hoisted(() =>
  vi.fn(async (...keys: string[]) => {
    void keys;
  }),
);
const fireScoreRevalidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDel,
}));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/revalidate")>()),
  fireScoreRevalidate,
}));

import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { writeFixtureRulesOverride } from "../fixture-rules";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});
beforeEach(() => {
  cacheDel.mockClear();
  fireScoreRevalidate.mockClear();
});

/** The DEL is fired, not awaited, by the door: let it land. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!HAS_DB)("an unstarted override write drops the match's public documents", () => {
  it("one write: the fixture's own document and its division's schedule go in ONE delete, and the ISR tag fires", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await settle();
    cacheDel.mockClear(); // the seed's own schedule writes drop documents too
    fireScoreRevalidate.mockClear();
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect(out.fixtures[0]!.started, "the premise: an unstarted write (nothing re-folds)").toBe(false);
    await settle();
    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(cacheDel.mock.calls.flat()).toEqual(
      expect.arrayContaining([`pub:v1:fixture:v3:${id}`, `pub:v1:div:${b.divisionId}:schedule`]),
    );
    expect(fireScoreRevalidate).toHaveBeenCalledWith(b.divisionId, b.competitionId);
  });

  it("a batch of two in one division: both fixtures' documents ride the ONE delete", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 3 });
    const [x, y] = [b.fixtureIds[0]!, b.fixtureIds[1]!];
    expect(x).not.toBe(y);
    await settle();
    cacheDel.mockClear();
    await writeFixtureRulesOverride(b.auth, [x, y], { bestOf: 1 });
    await settle();
    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(cacheDel.mock.calls.flat()).toEqual(expect.arrayContaining([`pub:v1:fixture:v3:${x}`, `pub:v1:fixture:v3:${y}`]));
  });

  it("empty: no fixture ids writes nothing and drops nothing", async () => {
    await writeFixtureRulesOverride({ orgId: "00000000-0000-0000-0000-000000000000", via: "session", userId: null, role: "owner", keyId: null }, [], null);
    await settle();
    expect(cacheDel).not.toHaveBeenCalled();
    expect(fireScoreRevalidate).not.toHaveBeenCalled();
  });
});
