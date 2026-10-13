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
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import type { RoomSnapshot } from "../src/components/public-site/match-room/room-snapshot";
import { apiJson, createStageAndGenerate, linkLichessBySql, linkPersonToUserBySql, TAG, withDb } from "./helpers";
import { mintMatchRoomLink } from "./match-room-link";

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

/** A signed-up player (also the arbiter spec's, e2e/arbiter-panel.spec.ts). */
export async function seedUser(name: string): Promise<{ userId: string; email: string }> {
  const email = `room-${TAG}-${randomUUID().slice(0, 8)}@e2e.local`;
  return withDb(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${email}, ${name}, true, 'en') returning id`;
    return { userId: row!.id, email };
  });
}

export async function seedLichessLink(userId: string, lichessId: string): Promise<void> {
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

/** The invite's personal link, minted as invite.ts → mintMatchRoomToken does
 *  (e2e/match-room-link.ts; e2e-seams.test.ts proves the product verifies it). */
const mintLink = mintMatchRoomLink;

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
export type BridgeRowView = {
  status: string;
  challenge_id: string | null;
  create_sent_at: Date | null;
  last_error: string | null;
  needs_reason: string | null;
  move_count: number;
  /** Each side's time AS AT `last_move_at` (V442, T10's append), in ms. */
  white_ms: number | null;
  black_ms: number | null;
};

export async function bridgeRow(fixtureId: string): Promise<BridgeRowView | null> {
  return withDb(async (sql) => {
    const [row] = await sql<BridgeRowView[]>`
      select status, challenge_id, create_sent_at, last_error, needs_reason, move_count,
             white_ms, black_ms
        from fixture_external_play where fixture_id = ${fixtureId}`;
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

export type RoundPlayer = {
  name: string;
  personId: string;
  lichessId: string;
  userId: string;
  email: string;
  entrantId: string;
  /** The Lichess bearer the server will send for this player — set only by
   *  `playable: true`, whose link the server can open (T17). */
  lichessToken: string | null;
};
export type RoundBoard = { fixtureId: string; home: RoundPlayer; away: RoundPlayer };
export type SeededRound = {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The division's run sheet, where the queue and the Open round control live. */
  fixturesTab: string;
  arbiterPath: string;
  /** `/shared/{org}/{comp}/{div}` — prefix of every public fixture page. */
  publicBase: string;
  /** The slug chain, for `routes.*` builders (T17 review M10: never retyped). */
  slugs: { org: string; comp: string; div: string };
  /** Round 1's boards, in fixture order (seq_in_round). */
  boards: RoundBoard[];
};

/**
 * One online chess round of `names.length` linked players, through the
 * product: a public competition, a boardgame division played online on a
 * ship-1 clock, the entrants, a stage, Start, and (unless `open: false`)
 * round 1 opened through the open-round route (D12). A league pairs every
 * round at Generate; a Swiss stage mints its shells at Start and pairs round 1
 * on the next Generate — the organiser's two presses. `camera: "required"` is
 * set before anything opens, as D9 allows.
 */
export async function seedOnlineRound(
  request: APIRequestContext,
  names: string[],
  opts: {
    open?: boolean;
    /** The division's camera policy, written before Start. Unset/"off" leaves
     *  the competition's floor (`off`, no tile); "optional" shows the tile
     *  with no duty; "required" gates every seat on the meeting. */
    camera?: "required" | "optional" | "off";
    stage?: "league" | "swiss";
    /** The division's clock (default CLOCK, 10+5) — a curated key of time-controls.ts. */
    clock?: { base: number; increment: number };
    /** T17: link each player with a token the server CAN open, so a game can
     *  really be created at the Lichess fixture server. Default: the
     *  unopenable one-byte token (nothing may reach Lichess). */
    playable?: boolean;
  } = {},
): Promise<SeededRound> {
  const people: Omit<RoundPlayer, "entrantId">[] = [];
  for (const name of names) {
    const { userId, email } = await seedUser(name);
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: name,
      consent: { public_name: true },
    });
    expect(person.status, `person ${name}: ${JSON.stringify(person.error)}`).toBeLessThan(300);
    await linkPersonToUserBySql(person.data!.id, userId);
    const lichessId = `e2e-rnd-${randomBytes(5).toString("hex")}`;
    let lichessToken: string | null = null;
    if (opts.playable) {
      lichessToken = `lio_e2e_${lichessId}`;
      await linkLichessBySql(userId, lichessId, lichessToken, playScopes());
    } else {
      await seedLichessLink(userId, lichessId);
    }
    people.push({ name, personId: person.data!.id, lichessId, userId, email, lichessToken });
  }
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Round ${TAG} ${randomUUID().slice(0, 4)}`,
    visibility: "public",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open Rapid",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: opts.clock ?? CLOCK },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  if (opts.camera === "required" || opts.camera === "optional") {
    // The division settings' own write (division-settings.tsx saveCameraPolicy),
    // before any round opens — after that it may only be relaxed (D9).
    const cam = await apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", { camera_policy: opts.camera });
    expect(cam.status, `camera policy: ${JSON.stringify(cam.error)}`).toBeLessThan(300);
  }
  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    people.map((p, i) => ({ kind: "individual", display_name: p.name, seed: i + 1, members: [{ person_id: p.personId }] })),
  );
  expect(ents.status, `entrants: ${JSON.stringify(ents.error)}`).toBeLessThan(300);
  const byEntrant = new Map(ents.data!.map((e, i) => [e.id, { ...people[i]!, entrantId: e.id }]));

  let stageId: string;
  if (opts.stage === "swiss") {
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 3 },
    });
    expect(stage.status, `swiss stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    stageId = stage.data!.id;
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    const paired = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST", {});
    expect(paired.status, `pair round 1: ${JSON.stringify(paired.error)}`).toBeLessThan(300);
  } else {
    ({ stageId } = await createStageAndGenerate(request, divisionId));
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  }
  if (opts.open !== false) {
    const opened = await apiJson(request, `/api/v1/stages/${stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
  }

  return withDb(async (sql) => {
    const rows = await sql<{ id: string; home: string; away: string }[]>`
      select id, home_entrant_id as home, away_entrant_id as away from fixtures
       where stage_id = ${stageId} and round_no = 1 and home_entrant_id is not null and away_entrant_id is not null
       order by seq_in_round`;
    expect(rows.length, `${names.length} entrants pair into ${names.length / 2} boards in round 1`).toBe(names.length / 2);
    const [slug] = await sql<{ org: string; comp: string; div: string; org_id: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div, o.id as org_id
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
       where d.id = ${divisionId}`;
    const base = `/o/${slug!.org}/c/${slug!.comp}/d/${slug!.div}`;
    return {
      orgId: slug!.org_id,
      competitionId: comp.data!.id,
      divisionId,
      stageId,
      fixturesTab: `${base}?tab=fixtures`,
      arbiterPath: `${base}/arbiter`,
      publicBase: `/shared/${slug!.org}/${slug!.comp}/${slug!.div}`,
      slugs: { org: slug!.org, comp: slug!.comp, div: slug!.div },
      boards: rows.map((r) => ({ fixtureId: r.id, home: byEntrant.get(r.home)!, away: byEntrant.get(r.away)! })),
    };
  });
}

/** A game on a board's ledger, as T9 (create) and T10 (moves) leave it, White
 *  the home side (recorded on the row, the way T9 records it). `hold` puts it
 *  on the organiser's desk (needs_organiser). The rules judge `moves`. */
export async function roundGameSql(board: RoundBoard, opts: { moves: string[]; hold?: "mismatch" }): Promise<{ fen: string }> {
  const rules = new Chess();
  for (const uci of opts.moves) rules.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play
         set status = ${opts.hold ? "needs_organiser" : "live"},
             needs_reason = ${opts.hold ?? null},
             challenge_id = ${`e2e${randomBytes(5).toString("hex")}`},
             white_side = 'home',
             white_lichess_id = ${board.home.lichessId},
             black_lichess_id = ${board.away.lichessId},
             moves_uci = ${sql.json(opts.moves)},
             move_count = ${opts.moves.length},
             started_at = now() - interval '30 minutes',
             last_move_at = now(),
             white_ms = ${CLOCK.base * 1000},
             black_ms = ${CLOCK.base * 1000},
             clock_increment_s = ${CLOCK.increment},
             updated_at = now()
       where fixture_id = ${board.fixtureId}`;
    expect(res.count, `bridge row for ${board.fixtureId} (was the round opened?)`).toBe(1);
  });
  return { fen: rules.fen() };
}

// ─── the board, as a player's finger meets it (T17) ─────────────────────────
// The same reading match-room.spec.ts uses (its helpers are local to that
// file): a square's centre from the board surface's box and the player's
// orientation, a click there, and a board that is PAINTED, not just mounted.

const FILES = "abcdefgh";

export async function squareCentre(page: Page, sq: string, orientation: "white" | "black"): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("room-board-surface").boundingBox();
  if (!box) throw new Error("the board has no box");
  const file = FILES.indexOf(sq[0]!);
  const rank = Number(sq[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const size = box.width / 8;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

/** Play `uci` by two taps (from, to), as a player does on a phone. Each tap
 *  is hit-tested first: a square under a banner or a notice would swallow
 *  the tap and read, much later, as "the move never reached Lichess". */
export async function tapMove(page: Page, uci: string, orientation: "white" | "black"): Promise<void> {
  for (const sq of [uci.slice(0, 2), uci.slice(2, 4)]) {
    const { x, y } = await squareCentre(page, sq, orientation);
    const over = await page.evaluate(
      (p) => {
        const el = document.elementFromPoint(p.x, p.y);
        return el?.closest("cg-board") ? null : (el?.outerHTML.slice(0, 120) ?? "nothing");
      },
      { x, y },
    );
    if (over !== null) throw new Error(`the tap on ${sq} lands on ${over}, not on the board`);
    await page.mouse.click(x, y);
  }
}

export async function boardPainted(page: Page): Promise<void> {
  await expect(page.locator("[data-testid=room-board-surface] cg-board piece").first()).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const b = await page.locator("[data-testid=room-board-surface] cg-board").boundingBox();
      return b ? Math.round(b.height) > 100 && Math.abs(b.height - b.width) <= 2 : false;
    })
    .toBe(true);
  const hit = await page.getByTestId("room-board-surface").evaluate((surface) => {
    const r = surface.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("cg-board");
  });
  expect(hit, "a tap on the board lands on the board").toBe(true);
}
