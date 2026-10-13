// T16 — the lobby route over HTTP (controller ruling 2026-10-12): GET only,
// session only, and `Cache-Control: private, no-store` on EVERY answer — the
// public fixture page is ISR, so the one thing that may never happen is a
// shared cache keeping a player's door (or a refusal) for the next viewer.
// The usecase's behaviour is external-play-lobby.test.ts's; this proves the
// wiring.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => {
      if (!authState.userId) throw new AuthError("Not authenticated");
      return { id: authState.userId };
    },
    getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null),
  };
});

import { sql } from "@/lib/db";
import * as lobbyRoute from "@/app/api/v1/fixtures/[id]/external-play/lobby/route";
import { ExternalPlayLobbyOut } from "@/server/api-v1/schemas";
import { LOBBY_STATES } from "@/server/usecases/external-play/lobby";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (fixtureId: string) => new Request(`https://test.local/api/v1/fixtures/${fixtureId}/external-play/lobby`);
const OPENED = new Date(Date.now() - 2 * 60_000);

beforeEach(() => {
  authState.userId = "";
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("lobby route — shape", () => {
  it("exports GET and nothing that writes: there is no POST (check-in is the room's — one venue, D3)", () => {
    const exported = Object.keys(lobbyRoute).sort();
    expect(exported).toEqual(["GET"]);
  });

  it("the documented answer lists exactly the usecase's states", () => {
    const documented = new Set<string>(["online_chess_off", ...ExternalPlayLobbyOut.options[1].shape.state.options]);
    expect([...documented].sort()).toEqual([...LOBBY_STATES].sort());
    expect(documented.size, "anti-vacuity: states compared").toBe(LOBBY_STATES.length);
  });
});

describe.skipIf(!HAS_DB)("lobby route — who, and never cached", () => {
  it("player ⇒ 200 with their room path; anonymous ⇒ 401; stranger ⇒ 404 — every one `private, no-store`", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: OPENED,
      roundOpenedAt: OPENED,
      linked: true,
    });
    const stranger = await makeUser("lobby-route-stranger");
    const cases: [string, string, number][] = [
      ["player", s.home.userId, 200],
      ["anonymous", "", 401],
      ["stranger", stranger.id, 404],
    ];
    let checked = 0;
    for (const [label, userId, status] of cases) {
      authState.userId = userId;
      const res = await lobbyRoute.GET(get(s.fixtureId), ctx(s.fixtureId));
      expect(res.status, label).toBe(status);
      expect(res.headers.get("cache-control"), label).toBe("private, no-store");
      const body = (await res.json()) as { ok: boolean; data?: unknown };
      if (status === 200) {
        // Strict: the documented arm's keys and no others (fix round 1, M1) — a non-strict parse let a spread of
        // the room snapshot (its realtime token included) through.
        const data = ExternalPlayLobbyOut.options[1].strict().parse(body.data);
        expect(JSON.stringify(body), `${label}: no realtime field rides along`).not.toMatch(/"(token|realtime|participant|game)"/);
        expect(data.roomPath, label).toMatch(new RegExp(`/fixtures/${s.fixtureId}/play$`));
      } else {
        expect(JSON.stringify(body), `${label}: no room path in a refusal`).not.toContain("/play");
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: callers checked").toBe(3);
  });
});
