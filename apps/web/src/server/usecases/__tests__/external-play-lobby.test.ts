// T16 — the lobby: a signed-in player's door from the PUBLIC fixture page
// into their match room (controller ruling 2026-10-12). The public page is
// ISR, so it can render nothing about who is looking at it; a client island
// asks this read after hydration. It is a PROJECTION of the room's own read
// (readRoom, T14) — one authority for who plays on a board, its phase and the
// T20 start gate — and it never writes: check-in happens only in the room.
//
// Expected states derive from the seeded facts and the room's own window
// (windowFor, D12), never from lobby.ts. Single-sport by construction: online
// play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { windowFor } from "@/server/external-play/window";
import type { RoomDeps } from "../external-play/room";
import { readExternalPlayLobby, LOBBY_STATES } from "../external-play/lobby";
import { stampFixtureCheckIn } from "../me";
import { ExternalPlayLobbyOut } from "@/server/api-v1/schemas";
import { makeUser } from "./_seed";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
// The open is anchored to the real clock: two minutes ago, so the window
// (T−10..the deadline, windowFor) is open now.
const OPENED = new Date(Date.now() - 2 * 60_000);

function deps(over: Partial<RoomDeps> = {}): RoomDeps & { publish: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } {
  return {
    now: new Date(),
    publish: vi.fn(async () => {}),
    create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
    offered: vi.fn(async () => true),
    mintRealtime: vi.fn(async () => "rt-token"),
    ...over,
  } as never;
}

async function seed(over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) {
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: OPENED,
    roundOpenedAt: OPENED,
    linked: true,
    homeFullName: "Ada Okonkwo",
    awayFullName: "Bo Lind",
    ...over,
  });
}

async function slugsOf(s: SeedOnlineChessFixtureResult) {
  const [row] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div
      from fixtures f join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
     where f.id = ${s.fixtureId}`;
  if (!row) throw new Error("premise: the seeded fixture has slugs");
  return row;
}

async function gameOnFile(s: SeedOnlineChessFixtureResult, over: { status?: string; needsReason?: string; createOnly?: boolean } = {}) {
  const gameId = over.createOnly ? null : `gm-${randomUUID().slice(0, 12)}`;
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
       needs_reason, create_sent_at)
    values (${s.fixtureId}, ${s.orgId}, ${over.status ?? "ready"}, ${OPENED}, ${gameId},
            ${gameId ? "home" : null}, ${gameId ? s.home.lichessId : null}, ${gameId ? s.away.lichessId : null},
            ${over.needsReason ?? null}, ${over.createOnly ? new Date() : null})`;
}

async function rows(fixtureId: string) {
  const bridge = await sql`select * from fixture_external_play where fixture_id = ${fixtureId}`;
  const availability = await sql`select * from fixture_availability where fixture_id = ${fixtureId} order by person_id`;
  return { bridge, availability };
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("lobby vocabulary", () => {
  it("states the empty case first: an off club is a state of its own, never a fall-through to a board", () => {
    expect(LOBBY_STATES[0]).toBe("online_chess_off");
    expect(new Set(LOBBY_STATES).size, "anti-vacuity: distinct states").toBe(LOBBY_STATES.length);
    expect(LOBBY_STATES.length).toBeGreaterThan(1);
  });
});

describe.skipIf(!HAS_DB)("readExternalPlayLobby — who gets a door", () => {
  it("each of the two players gets THEIR room's path (the play page, no token — the session is the identity)", async () => {
    const s = await seed();
    const g = await slugsOf(s);
    const expected = routes.sharedFixturePlay(g.org, g.comp, g.div, s.fixtureId);
    let checked = 0;
    for (const p of [s.home, s.away]) {
      const lobby = await readExternalPlayLobby(p.userId, s.fixtureId, deps());
      expect(lobby.roomPath, p.userId).toBe(expected);
      expect(lobby.roomPath, "never a personal link token in a session answer").not.toContain("?t=");
      checked += 1;
    }
    expect(checked, "anti-vacuity: both players read").toBe(2);
  });

  it("a signed-in stranger, and another club's player, get NO door — the room's one 404, never a hint which", async () => {
    const s = await seed();
    const other = await seed();
    const stranger = await makeUser("lobby-stranger");
    const cases: [string, string][] = [
      ["stranger", stranger.id],
      ["another club's player", other.home.userId],
    ];
    let checked = 0;
    for (const [label, userId] of cases) {
      await expect(readExternalPlayLobby(userId, s.fixtureId, deps()), label).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      checked += 1;
    }
    expect(checked, "anti-vacuity: refusals checked").toBe(2);
    // …and the positive pair: the other club's player DOES get their own door.
    expect((await readExternalPlayLobby(other.home.userId, other.fixtureId, deps())).roomPath).not.toBeNull();
  });

  it("an over-the-board fixture is not a room: 404", async () => {
    const s = await seed({ onlinePlay: "off" });
    await expect(readExternalPlayLobby(s.home.userId, s.fixtureId, deps())).rejects.toMatchObject({ status: 404 });
  });
});

describe.skipIf(!HAS_DB)("readExternalPlayLobby — the state the door states", () => {
  it("unopened round ⇒ not_opened; opened ⇒ check_in with the open's window (windowFor)", async () => {
    const unopened = await seed({ roundOpenedAt: undefined });
    expect((await readExternalPlayLobby(unopened.home.userId, unopened.fixtureId, deps())).state).toBe("not_opened");
    const open = await seed();
    const w = windowFor((await sql<{ opened_at: Date }[]>`
      select opened_at from stage_round_opens where stage_id = ${open.stageId} and round_no = 1`)[0]!.opened_at);
    expect(await readExternalPlayLobby(open.home.userId, open.fixtureId, deps())).toMatchObject({
      state: "check_in",
      deadline: w.deadline.toISOString(),
    });
  });

  it("after the deadline with no game ⇒ closed; a game on file ⇒ playing; a held board ⇒ held", async () => {
    const s = await seed();
    const w = windowFor(OPENED);
    expect((await readExternalPlayLobby(s.home.userId, s.fixtureId, deps({ now: new Date(w.deadline.getTime() + 1_000) }))).state).toBe("closed");
    const live = await seed();
    await gameOnFile(live, { status: "live" });
    expect((await readExternalPlayLobby(live.home.userId, live.fixtureId, deps())).state).toBe("playing");
    const held = await seed();
    await gameOnFile(held, { status: "needs_organiser", needsReason: "fair_play" });
    expect((await readExternalPlayLobby(held.home.userId, held.fixtureId, deps())).state).toBe("held");
  });

  it("NEVER writes: inside an open window it stamps no check-in, resets nothing, publishes nothing, creates nothing", async () => {
    const s = await seed();
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const before = await rows(s.fixtureId);
    const d = deps();
    await readExternalPlayLobby(s.home.userId, s.fixtureId, d);
    await readExternalPlayLobby(s.away.userId, s.fixtureId, d);
    expect(await rows(s.fixtureId)).toEqual(before);
    expect(before.availability.length, "premise: one check-in on file").toBe(1);
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });
});

/** Every key anywhere in a value, at any depth — a leak nested in an object is still a leak. */
function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) deepKeys(x, out);
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepKeys(x, out);
    }
  return out;
}

describe.skipIf(!HAS_DB)("readExternalPlayLobby — the answer is an ALLOWLIST (fix round 1, M1)", () => {
  // The room's snapshot carries what play needs: a realtime token, the participant, the game, the opponent's
  // presence. The door carries none of it. The expected keys are the DOCUMENTED answer's (the v1 schema's two arms),
  // never lobby.ts's; a spread of the room snapshot into the answer adds keys and dies here.
  const FORBIDDEN = /token|realtime|participant|presence|game|opponent|draw|clock|lichess|camera|video/i;
  it("each state's answer has exactly the documented keys, and nothing the room carries for play — at any depth", async () => {
    const offKeys = Object.keys(ExternalPlayLobbyOut.options[0].shape).sort();
    const doorKeys = Object.keys(ExternalPlayLobbyOut.options[1].shape).sort();
    const opened = await seed();
    const live = await seed();
    await gameOnFile(live, { status: "live" });
    const held = await seed();
    await gameOnFile(held, { status: "needs_organiser", needsReason: "fair_play" });
    const off = await seed();
    const cells: [string, () => Promise<unknown>, string[]][] = [
      ["check-in (the room mints a realtime token for this seat)", () => readExternalPlayLobby(opened.home.userId, opened.fixtureId, deps()), doorKeys],
      ["playing (a game on file)", () => readExternalPlayLobby(live.away.userId, live.fixtureId, deps()), doorKeys],
      ["held", () => readExternalPlayLobby(held.home.userId, held.fixtureId, deps()), doorKeys],
      ["off", () => readExternalPlayLobby(off.home.userId, off.fixtureId, deps({ offered: vi.fn(async () => false) })), offKeys],
    ];
    let checked = 0;
    for (const [label, ask, keys] of cells) {
      const answer = await ask();
      expect(Object.keys(answer as object).sort(), label).toEqual(keys);
      const leaked = deepKeys(answer).filter((k) => FORBIDDEN.test(k));
      expect(leaked, `${label}: no play field at any depth`).toEqual([]);
      expect(JSON.stringify(answer), `${label}: the minted realtime token never rides along`).not.toContain("rt-token");
      checked += 1;
    }
    expect(checked, "anti-vacuity: states checked").toBe(cells.length);
    expect(doorKeys.length, "premise: the documented door has keys to compare").toBeGreaterThan(1);
  });
});

describe.skipIf(!HAS_DB)("readExternalPlayLobby — T20: the flag gates STARTING play, never finishing it", () => {
  it("flag off and no game started ⇒ online_chess_off, and NO room path (the door says why instead)", async () => {
    const s = await seed();
    const lobby = await readExternalPlayLobby(s.home.userId, s.fixtureId, deps({ offered: vi.fn(async () => false) }));
    expect(lobby).toEqual({ state: "online_chess_off", roomPath: null });
  });

  it("flag off with a game on file ⇒ the door to the board, never the off state (finishing play is not gated)", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live" });
    const offered = vi.fn(async () => false);
    const lobby = await readExternalPlayLobby(s.home.userId, s.fixtureId, deps({ offered }));
    expect(lobby.state).toBe("playing");
    expect(lobby.roomPath).not.toBeNull();
  });

  it("flag off with a create already SENT to Lichess (no game id yet) ⇒ the door, not the off state", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "pending", createOnly: true });
    const lobby = await readExternalPlayLobby(s.home.userId, s.fixtureId, deps({ offered: vi.fn(async () => false) }));
    expect(lobby.state).not.toBe("online_chess_off");
    expect(lobby.roomPath).not.toBeNull();
  });
});
