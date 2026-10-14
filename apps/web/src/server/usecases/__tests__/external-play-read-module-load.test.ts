// T17 fix round 5, I2 — loading the public read touches NOTHING of the database client. The walker in
// external-play/__tests__/no-import-cycle.test.ts pins the edge (no play.ts); this pins the behaviour it protects:
// a suite that mocks `@/lib/db` with no exports at all (as registration's fetch-registrant-details mocks it without
// `sql`) can still load `external-play-read.ts` and the replay leaf `server/external-play/fen.ts`. cacc41489's
// `import { fenAfter } from "./external-play/play"` ran org-posts.ts's module-load `sql` and failed exactly this.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({}));

describe("the public read loads with a database mock that exports nothing (I2)", () => {
  it("external-play-read.ts and fen.ts evaluate without touching @/lib/db — counted", async () => {
    const read = await import("../external-play-read");
    const fen = await import("@/server/external-play/fen");
    const loaded = [read.loadDivisionWatch, read.loadOnlineHeader, fen.fenAfter, fen.replay];
    for (const f of loaded) expect(typeof f).toBe("function");
    expect(loaded, "anti-vacuity: exports reached").toHaveLength(4);
    // The leaf works on its own: e2e4 from the start position.
    expect(fen.fenAfter(["e2e4"])).toEqual({
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      replayed: 1,
      san: ["e4"],
    });
  });
});
