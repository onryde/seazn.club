// T14 — the match room's e2e seeding (e2e/match-room.spec.ts).
//
// The organiser's half goes through the product: a public competition, a
// boardgame division played online on a ship-1 clock, two individual entrants,
// a league stage, Generate, Start, and the round OPENED through the
// open-round route (D12) — the same calls an organiser's clicks make.
//
// Two facts no API writes are seeded by SQL, and each says why:
// - the players' Lichess links. Linking is an OAuth trip to lichess.org. The
//   stored token is DELIBERATELY UNOPENABLE (one byte, never an envelope), so
//   no path in these specs can reach Lichess: anything that tried to read a
//   token would fail closed with LICHESS_TOKEN_UNAVAILABLE before any request.
//   And no spec here lets both players check in, which is the only thing that
//   asks for a game.
// - a game's ledger (`fixture_external_play`), for the specs that need a
//   board in play. A real game is made at Lichess (T9); the round trip that
//   makes one, and a move that reaches Lichess, are the e2e walkthrough's with
//   its Lichess fixture server (Task 17). Here the ledger is written the way
//   T9/T10 write it, and the room is read back through the product.
//
// The personal link (`?t=`) is minted the way invite.ts mints it: the invite
// email itself cannot be captured (no mail provider in e2e), and the room's
// own verification is the judge — a link of the wrong shape is the neutral
// card, and the spec reds on it.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext } from "@playwright/test";
import { Chess } from "chess.js";
import { SignJWT } from "jose";
import { MATCH_ROOM_TOKEN_TTL_MS } from "../src/server/external-play/window";
import type { RoomSnapshot } from "../src/components/public-site/match-room/room-snapshot";
import { apiJson, createStageAndGenerate, linkPersonToUserBySql, TAG, withDb } from "./helpers";

/** The room's own copy, read from the dictionary rather than retyped. */
export const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** `{name}`-style placeholders filled the way the dictionary's `t()` fills them. */
export function fill(key: string, vars: Record<string, string | number> = {}): string {
  const raw = uiEn[key];
  if (raw === undefined) throw new Error(`match-room-kit: no en copy for ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** The play grant's scopes, read from lib/oauth.ts (server-only, so it cannot
 *  be imported here) — a grant missing one is a re-consent screen, not a seat. */
export function playScopes(): string[] {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/oauth.ts", import.meta.url)), "utf8");
  const m = /export const LICHESS_OAUTH_SCOPES = "([^"]+)"/.exec(src);
  if (!m) throw new Error("match-room-kit: LICHESS_OAUTH_SCOPES not found in lib/oauth.ts");
  return m[1]!.split(/\s+/);
}

/** 10+5: a ship-1 control (time-controls.ts), the one the canvas draws. */
export const CLOCK = { base: 600, increment: 5 } as const;

/** A 43-character display name (AGENTS.md: truncation needs a realistic one). */
export function longName(): string {
  const name = `Maximiliana Featherstonehaugh-Wolstenh ${randomBytes(2).toString("hex")}`;
  if (name.length !== 43) throw new Error(`longName is ${name.length} characters, not 43`);
  return name;
}

export type RoomPlayer = {
  name: string;
  email: string;
  userId: string;
  personId: string;
  entrantId: string;
  lichessId: string;
  /** The personal link's query value. */
  token: string;
};

export type SeededRoom = {
  fixtureId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** `/shared/…/fixtures/{id}` — the canonical fixture page. */
  fixturePath: string;
  /** `/shared/…/fixtures/{id}/play` — the room, no link. */
  roomPath: string;
  standingsPath: string;
  white: RoomPlayer;
  black: RoomPlayer;
  /** Which side of the fixture plays White, as the room reports it. null ⇒
   *  the round is not open, so no link reads the room: `white` is then the
   *  home player and `black` the away one, by position only. */
  whiteSide: "home" | "away" | null;
  roundOpen: { id: string; openedAt: Date } | null;
};

async function seedUser(name: string): Promise<{ userId: string; email: string }> {
  const email = `room-${TAG}-${randomUUID().slice(0, 8)}@e2e.local`;
  return withDb(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${email}, ${name}, true, 'en') returning id`;
    return { userId: row!.id, email };
  });
}

async function seedLichessLink(userId: string, lichessId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into user_external_accounts (
        user_id, provider, external_user_id, username, access_token_enc, scopes, consented_at
      ) values (
        ${userId}, 'lichess', ${lichessId}, ${lichessId},
        -- One byte: never an envelope, so it can never be opened (see the header).
        ${Buffer.from([0])}, ${playScopes()}, now()
      )`;
  });
}

/** The invite's personal link, minted as invite.ts → mintMatchRoomToken does. */
async function mintLink(c: { fixtureId: string; personId: string; roundOpenId: string; openedAt: Date }): Promise<string> {
  const secret = process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me";
  const exp = Math.floor((c.openedAt.getTime() + MATCH_ROOM_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ fid: c.fixtureId, pid: c.personId, rid: c.roundOpenId, oat: c.openedAt.toISOString() })
    .setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

/**
 * One online chess fixture, its round opened (unless `open: false`), both
 * players linked and seated on it. `names` are the two players' full names,
 * in fixture order (home, away).
 */
export async function seedMatchRoom(
  request: APIRequestContext,
  opts: { names: [string, string]; open?: boolean },
): Promise<SeededRoom> {
  const label = `Room ${TAG} ${randomUUID().slice(0, 4)}`;
  const people: { name: string; email: string; userId: string; personId: string; lichessId: string }[] = [];
  for (const name of opts.names) {
    const { userId, email } = await seedUser(name);
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: name,
      consent: { public_name: true },
    });
    expect(person.status, `person ${name}: ${JSON.stringify(person.error)}`).toBeLessThan(300);
    await linkPersonToUserBySql(person.data!.id, userId);
    // Lichess ids are lowercase (lila `UserId`).
    const lichessId = `e2e-room-${randomBytes(5).toString("hex")}`;
    await seedLichessLink(userId, lichessId);
    people.push({ name, email, userId, personId: person.data!.id, lichessId });
  }

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: label,
    visibility: "public",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open Rapid",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;

  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    people.map((p, i) => ({
      kind: "individual",
      display_name: p.name,
      seed: i + 1,
      members: [{ person_id: p.personId }],
    })),
  );
  expect(ents.status, `entrants: ${JSON.stringify(ents.error)}`).toBeLessThan(300);
  const entrantIds = ents.data!.map((e) => e.id);

  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length, "one pairing between two entrants").toBe(1);
  const fixtureId = fixtureIds[0]!;
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  let roundOpen: SeededRoom["roundOpen"] = null;
  if (opts.open !== false) {
    const opened = await apiJson(request, `/api/v1/stages/${stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
    roundOpen = await withDb(async (sql) => {
      const [row] = await sql<{ id: string; opened_at: Date }[]>`
        select o.id, o.opened_at from stage_round_opens o
          join fixtures f on f.stage_id = o.stage_id and f.round_no = o.round_no
         where f.id = ${fixtureId}`;
      if (!row) throw new Error("seedMatchRoom: the open-round route wrote no stage_round_opens row");
      return { id: row.id, openedAt: new Date(row.opened_at) };
    });
  }

  const sides = await withDb(async (sql) => {
    const [row] = await sql<{ home: string; away: string }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
    return row!;
  });
  const byEntrant = new Map(entrantIds.map((id, i) => [id, people[i]!]));
  const home = { ...byEntrant.get(sides.home)!, entrantId: sides.home };
  const away = { ...byEntrant.get(sides.away)!, entrantId: sides.away };

  const tokenFor = async (personId: string) =>
    roundOpen ? mintLink({ fixtureId, personId, roundOpenId: roundOpen.id, openedAt: roundOpen.openedAt }) : "";
  const homeP: RoomPlayer = { ...home, token: await tokenFor(home.personId) };
  const awayP: RoomPlayer = { ...away, token: await tokenFor(away.personId) };

  // Colours as the ROOM reports them (the pairing's, T10's whiteSideOf) —
  // read through the product, never assumed from home/away.
  let whiteSide: SeededRoom["whiteSide"] = null;
  let links = { fixture: "", standings: "" };
  if (roundOpen) {
    const snap = await readRoomAs(request, fixtureId, homeP.token);
    whiteSide = snap.you.colour === "white" ? "home" : "away";
    links = snap.links;
  } else {
    links = await withDb(async (sql) => {
      const [row] = await sql<{ org: string; comp: string; div: string }[]>`
        select o.slug as org, c.slug as comp, d.slug as div
          from fixtures f join divisions d on d.id = f.division_id
          join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
         where f.id = ${fixtureId}`;
      return {
        fixture: `/shared/${row!.org}/${row!.comp}/${row!.div}/fixtures/${fixtureId}`,
        standings: `/shared/${row!.org}/${row!.comp}/${row!.div}`,
      };
    });
  }
  return {
    fixtureId,
    competitionId: comp.data!.id,
    divisionId,
    stageId,
    fixturePath: links.fixture,
    roomPath: `${links.fixture}/play`,
    standingsPath: links.standings,
    white: whiteSide === "away" ? awayP : homeP,
    black: whiteSide === "away" ? homeP : awayP,
    whiteSide,
    roundOpen,
  };
}

/** GET the room as a player's personal link (no session), through the API. */
export async function readRoomAs(request: APIRequestContext, fixtureId: string, token: string): Promise<RoomSnapshot> {
  // The link wins over any session the context carries (match-room-identity.ts).
  const res = await request.fetch(`/api/v1/fixtures/${fixtureId}/external-play/room?t=${encodeURIComponent(token)}`);
  const body = (await res.json()) as { ok: boolean; data?: RoomSnapshot; error?: unknown };
  expect(res.status(), `room GET: ${JSON.stringify(body.error)}`).toBe(200);
  return body.data!;
}

/**
 * Write a game onto the fixture's ledger the way T9 (create) and T10 (moves)
 * leave it: the recorded colours and Lichess ids, the UCI ledger, both clocks
 * as of the last move (`now`). `moves` must be legal from the start position —
 * chess.js judges them here, so a typo fails the seed, not the spec.
 */
export async function seedGameSql(
  room: SeededRoom,
  opts: { moves: string[]; whiteMs?: number; blackMs?: number; drawOfferBy?: "white" | "black" | null; finished?: boolean },
): Promise<{ gameId: string; fen: string }> {
  const rules = new Chess();
  for (const uci of opts.moves) {
    rules.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
  }
  if (room.whiteSide === null) throw new Error("seedGameSql: open the round first — a game needs its colours");
  const gameId = `e2e${randomBytes(5).toString("hex")}`;
  const n = opts.moves.length;
  const status = opts.finished ? "finished" : n === 0 ? "ready" : "live";
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play
         set status = ${status},
             challenge_id = ${gameId},
             white_side = ${room.whiteSide},
             white_lichess_id = ${room.white.lichessId},
             black_lichess_id = ${room.black.lichessId},
             moves_uci = ${sql.json(opts.moves)},
             move_count = ${n},
             started_at = ${n > 0 ? sql`now()` : null},
             last_move_at = ${n > 0 ? sql`now()` : null},
             white_ms = ${n > 0 ? (opts.whiteMs ?? CLOCK.base * 1000) : null},
             black_ms = ${n > 0 ? (opts.blackMs ?? CLOCK.base * 1000) : null},
             clock_increment_s = ${n > 0 ? CLOCK.increment : null},
             draw_offer_by = ${opts.drawOfferBy ?? null},
             game_over_at = ${opts.finished ? sql`now()` : null},
             finished_at = ${opts.finished ? sql`now()` : null},
             updated_at = now()
       where fixture_id = ${room.fixtureId}`;
    if (res.count !== 1) throw new Error(`seedGameSql: no bridge row for ${room.fixtureId} (was the round opened?)`);
  });
  return { gameId, fen: rules.fen() };
}

/** What the bridge row says now — the specs' proof that nothing reached for a game. */
export async function bridgeRow(fixtureId: string): Promise<{
  status: string;
  challenge_id: string | null;
  create_sent_at: Date | null;
  last_error: string | null;
  move_count: number;
} | null> {
  return withDb(async (sql) => {
    const [row] = await sql<
      { status: string; challenge_id: string | null; create_sent_at: Date | null; last_error: string | null; move_count: number }[]
    >`select status, challenge_id, create_sent_at, last_error, move_count from fixture_external_play where fixture_id = ${fixtureId}`;
    return row ?? null;
  });
}

export async function checkedInAt(fixtureId: string, personId: string): Promise<Date | null> {
  return withDb(async (sql) => {
    const [row] = await sql<{ checked_in_at: Date | null }[]>`
      select checked_in_at from fixture_availability where fixture_id = ${fixtureId} and person_id = ${personId}`;
    return row?.checked_in_at ?? null;
  });
}
