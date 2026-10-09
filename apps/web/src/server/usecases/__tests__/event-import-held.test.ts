// W2a fix round 1 (review M-2; spec §5.4.4): the importer runs scoreEvent's decided side effects after commit, and
// must skip them for a HELD fixture exactly as scoreEvent does (`scoring.ts`): a held bracket fixture
// (needs_decision) seats nobody, so `onDecided`, and with it `refreshDiscipline` and `refreshNews`, wait for the
// organiser's settle. The witness is a passthrough spy on each — the real function still runs when called.
import { describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ onDecided: [] as string[], refreshDiscipline: [] as string[], refreshNews: [] as string[] }));

vi.mock("@/server/usecases/scoring", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/scoring")>();
  return {
    ...real,
    onDecided: vi.fn(async (...a: Parameters<typeof real.onDecided>) => {
      spies.onDecided.push(a[1]);
      return real.onDecided(...a);
    }),
    refreshDiscipline: vi.fn(async (...a: Parameters<typeof real.refreshDiscipline>) => {
      spies.refreshDiscipline.push(a[1]);
      return real.refreshDiscipline(...a);
    }),
    refreshNews: vi.fn(async (...a: Parameters<typeof real.refreshNews>) => {
      spies.refreshNews.push(a[1]);
      return real.refreshNews(...a);
    }),
  };
});

const { sql } = await import("@/lib/db");
const { importEvents } = await import("@/server/usecases/event-import");
const { seedBracket } = await import("@/server/engine-db/__tests__/helpers/seed-bracket");

const HAS_DB = !!process.env.DATABASE_URL;

/** A started 2-draw chess knockout; the stream ends in `result`. */
async function importChess(result: Record<string, unknown>, tag: string) {
  const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
  const fixtureId = s.fixtureIds[0]!;
  const [f] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${fixtureId}`;
  const payload = { ...result, ...(result.winner === "HOME" ? { winner: f!.home } : {}) };
  const report = await importEvents(s.auth, s.divisionId, {
    import_id: `held-${tag}-${fixtureId.slice(0, 8)}`,
    streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload }] }],
  });
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return { fixtureId, report, status: row!.status };
}

const calledFor = (id: string) => ({
  onDecided: spies.onDecided.includes(id),
  refreshDiscipline: spies.refreshDiscipline.includes(id),
  refreshNews: spies.refreshNews.includes(id),
});

describe.skipIf(!HAS_DB)("M-2: the importer holds a level bracket result the way scoreEvent does", () => {
  it("X-BR-2: an imported stream ending HELD (a chess double forfeit in a knockout) lands, and runs no decided side effect", async () => {
    const { fixtureId, report, status } = await importChess({ winner: null, method: "double_forfeit" }, "held");
    expect(report.results[0]!.status).toBe("imported");
    expect(status).toBe("needs_decision");
    expect(calledFor(fixtureId)).toEqual({ onDecided: false, refreshDiscipline: false, refreshNews: false });
  });

  it("X-BR-2 positive pair: an imported stream that DECIDES runs all three", async () => {
    const { fixtureId, report, status } = await importChess({ winner: "HOME", method: "checkmate" }, "won");
    expect(report.results[0]!.status).toBe("imported");
    expect(status).toBe("decided");
    expect(calledFor(fixtureId)).toEqual({ onDecided: true, refreshDiscipline: true, refreshNews: true });
  });
});
