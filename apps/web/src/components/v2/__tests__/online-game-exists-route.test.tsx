// T16 (T19 carry) — the game-exists refusal from its REAL producer: the
// unpair route on a seeded online Swiss round whose board holds a game,
// through the real `apiV1` client (fetch routed to the route handler), into
// the panels' classifier and the notice. The positive pair: the same round
// with no game unpairs, and nothing is classified.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: async () => ({ id: authState.userId }), getCurrentUser: async () => ({ id: authState.userId }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/components/i18n/dict-provider", () => ({ useMsg: () => (key: string) => key }));

import { sql } from "@/lib/db";
import { apiV1 } from "@/lib/client-v1";
import { ONLINE_GAME_EXISTS_KEY, isOnlineGameExists } from "@/lib/open-round";
import { POST as unpairRoute } from "@/app/api/v1/stages/[id]/unpair/route";
import { seedOnlineSwiss, type SeedOnlineSwissResult } from "@/server/usecases/__tests__/_external-play-seed";
import { OnlineGameExistsNotice } from "../online-game-exists-notice";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const id = /\/api\/v1\/stages\/([^/]+)\/unpair$/.exec(url)?.[1];
    if (!id) throw new Error(`unexpected request ${url}`);
    return unpairRoute(new Request(`https://test.local${url}`, init), { params: Promise.resolve({ id }) });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** What StagesPanel's Unpair does with the answer. */
async function pressUnpair(stageId: string): Promise<{ ok: true } | { ok: false; gameExists: boolean; html: string }> {
  try {
    await apiV1(`/api/v1/stages/${stageId}/unpair`, { method: "POST", json: {} });
    return { ok: true };
  } catch (err) {
    const gameExists = isOnlineGameExists(err);
    return { ok: false, gameExists, html: gameExists ? renderToStaticMarkup(<OnlineGameExistsNotice arbiterHref="/arbiter" />) : "" };
  }
}

/** Labelled SQL: the room's create records the game on the board's bridge row; here it stands for "a game exists". */
async function gameOn(s: SeedOnlineSwissResult) {
  const [f] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${s.stageId} and round_no = 1
       and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round limit 1`;
  await sql`
    insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id)
    values (${f!.id}, ${s.orgId}, 'live', now(), ${`gm-${randomUUID().slice(0, 12)}`})
    on conflict (fixture_id) do update set challenge_id = excluded.challenge_id, status = 'live'`;
}

describe.skipIf(!HAS_DB)("Unpair ← a board with an online game", () => {
  it("the refusal reaches the organiser as the notice, linking to the arbiter panel", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    authState.userId = s.ownerUserId;
    await gameOn(s);
    const out = await pressUnpair(s.stageId);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.gameExists).toBe(true);
    expect(out.html).toContain(ONLINE_GAME_EXISTS_KEY);
    expect(out.html).toContain('href="/arbiter"');
  });

  it("positive pair: the same round with no game unpairs", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    authState.userId = s.ownerUserId;
    expect(await pressUnpair(s.stageId)).toEqual({ ok: true });
  });
});
