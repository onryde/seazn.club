// T14 — the match room's e2e seeding (e2e/match-room.spec.ts).
//
// The organiser's half goes through the product: a public competition, a
// boardgame division played online on a ship-1 clock, two individual entrants,
// a stage (a league, the legacy shape, unless the seed names a supported one),
// Generate, Start, and the round OPENED through the open-round route (D12) —
// the same calls an organiser's clicks make, all in `setUpOnlineDivision`.
//
// Two facts no API writes are seeded by SQL, and each says why (a third, the legacy league's online-play flip, is in
// `createLegacyLeague`):
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
import { ENDED_BADLY_STATUSES, LIVE_STATUSES, type OutboxStatus } from "../src/server/email-outbox/constants";

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

/** The regex SOURCE for a `{time}` slot printed by a Match Day flag card: an HH:MM, then (Task 16 D1) - when the viewer's own UTC offset
 *  differs from the venue's at that instant - the venue's name once, "15:56 (Tokyo time)". The suffix is read off the dictionary's
 *  `arbiter.venueTime` so a reworded label moves with it, and optional because whether it shows depends on the browser's zone against
 *  the seeded venue's (the page prints every time in the VENUE's zone). */
export const PANEL_TIME_SLOT = (() => {
  const raw = uiEn["arbiter.venueTime"];
  if (raw === undefined) throw new Error("match-room-kit: no en copy for arbiter.venueTime");
  const [before, after] = raw.split("{time}");
  if (before !== "" || after === undefined) throw new Error(`match-room-kit: arbiter.venueTime is no longer "{time}<label>": ${raw}`);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `\\d{1,2}:\\d{2}(?:${esc(after).replace("\\{city\\}", "[^)]+")})?`;
})();

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
  /** `/live/…/fixtures/{id}` — the canonical fixture page. */
  fixturePath: string;
  /** `/live/…/fixtures/{id}/play` — the room, no link. */
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

/** A signed-up player (also Match Day online's, e2e/match-day-online.spec.ts). */
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

/** The format an e2e online division is staged in. An online division takes Swiss and knockout stages only (Online Chess credits,
 *  Task 8: any other kind is 422 ONLINE_FORMAT_NOT_SUPPORTED), so "league" is the LEGACY shape - the one a division made before
 *  that gate still holds on staging - and is built by `createLegacyLeague`, never by the plain door. */
export type OnlineStage = "league" | "swiss" | "knockout";

/** A league on a division that plays online, the way staging holds one: the stage is written through the REAL door while online
 *  play is off, then online play is switched back on by SQL (the division's package row, written when it was created online, is
 *  untouched). The e2e twin of `createStagesOnLegacyOnline` (usecases/__tests__/_legacy-online-stage.ts). Use it to seed the legacy
 *  shape, never to prove a gate. */
async function createLegacyLeague(request: APIRequestContext, divisionId: string): Promise<{ stageId: string; fixtureIds: string[] }> {
  const flip = (mode: "off" | "lichess") =>
    withDb(async (sql) => {
      const done = await sql`update divisions set config = config || ${sql.json({ onlinePlay: mode } as never)} where id = ${divisionId}`;
      expect(done.count, `the division's online play went ${mode}`).toBe(1);
    });
  // Only the stage WRITE is under the flip (the one door that asks the format); Generate runs on the division as it stands: online.
  let stageId: string;
  await flip("off");
  try {
    const created = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
    expect(created.status, `legacy league stage: ${JSON.stringify(created.error)}`).toBeLessThan(300);
    stageId = created.data!.id;
  } finally {
    await flip("lichess");
  }
  const generated = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(generated.status, `generate the legacy league: ${JSON.stringify(generated.error)}`).toBeLessThan(300);
  return { stageId, fixtureIds: (generated.data?.fixtures ?? []).map((f) => f.id) };
}

/** Online Chess credits (spec 2026-11-23-online-chess-credits-design.md §7.6): the e2e org is SHARED by every worker, so a payment is
 *  funded by its own grant - `credits` bought-bucket credits granted for exactly the payment about to be made, under the org's money
 *  lock (the key `lockOrg` takes: stream-credits.ts `orgMoneyLockKey`), with `balance_after` the org total after the row as every
 *  ledger writer keeps it. A worker never spends another's grant, so concurrent payers cannot leave each other short. The one
 *  staff-shaped write here (V426's grant row: no API grants credits but Stripe); the PAYMENT itself is the real route's. */
async function fundOnlinePayment(divisionId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  await withDb((sql) =>
    sql.begin(async (tx) => {
      const [d] = await tx<{ org_id: string }[]>`select org_id from divisions where id = ${divisionId}`;
      await tx`select pg_advisory_xact_lock(hashtext(${`stream-credits-org:${d!.org_id.toLowerCase()}`}))`;
      await tx`
        insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
        select ${d!.org_id}, ${credits}, 'grant', 'pack', coalesce(sum(delta), 0)::int + ${credits}, 'e2e: an online division paid for'
          from org_stream_credits where org_id = ${d!.org_id}`;
    }),
  );
}

/** The division's Online Chess package paid at the size it holds, through the PAY DOOR (`POST /divisions/{id}/online-package`), with
 *  the camera price: the receipt's quote read first (`GET`), then confirmed. Used where an open cannot carry the payment: before a
 *  legacy league is staged (the pay door refuses to CHARGE a league - P16 - so it pays while the division has no stage), and on a
 *  division whose round is opened later by the spec itself (the UI's Open round, or its own POST). */
async function payThroughPayDoor(request: APIRequestContext, divisionId: string): Promise<void> {
  const size = await withDb(async (sql) => {
    const [p] = await sql<{ size: number }[]>`
      select size from division_online_packages where division_id = ${divisionId} and refunded_at is null`;
    if (!p) throw new Error(`payThroughPayDoor: division ${divisionId} has no live Online Chess package`);
    return p.size;
  });
  const quote = await apiJson<{ owed: number; refusal: string | null }>(
    request, `/api/v1/divisions/${divisionId}/online-package?size=${size}&addCameras=true`,
  );
  expect(quote.status, `online package quote: ${JSON.stringify(quote.error)}`).toBe(200);
  expect(quote.data!.refusal, `size ${size} can be bought`).toBeNull();
  await fundOnlinePayment(divisionId, quote.data!.owed);
  const paid = await apiJson(request, `/api/v1/divisions/${divisionId}/online-package`, "POST", {
    size, expectedOwed: quote.data!.owed, addCameras: true,
  });
  expect(paid.status, `pay for the online package: ${JSON.stringify(paid.error)}`).toBeLessThan(300);
}

/** Round 1 opened through the open-round route as the organiser meets it: the first press on an unpaid package answers 402
 *  ONLINE_CHESS_UNPAID with the quote (asserted - the gate is live on this server), and the same press carrying that quote's `pay`
 *  pays and opens in one transaction ("Pay and open"). A package already paid opens on the first press. */
async function openRoundOne(request: APIRequestContext, stageId: string, divisionId: string): Promise<void> {
  const first = await apiJson(request, `/api/v1/stages/${stageId}/open-round`, "POST", { roundNo: 1 });
  if (first.status < 300) return;
  const error = first.error as { code?: string; quote?: { size: number; owed: number } } | undefined;
  expect([first.status, error?.code], `open-round: ${JSON.stringify(first.error)}`).toEqual([402, "ONLINE_CHESS_UNPAID"]);
  const quote = error!.quote!;
  await fundOnlinePayment(divisionId, quote.owed);
  const opened = await apiJson(request, `/api/v1/stages/${stageId}/open-round`, "POST", {
    roundNo: 1, pay: { size: quote.size, expectedOwed: quote.owed },
  });
  expect(opened.status, `pay and open round 1: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
}

/**
 * The ONE place an e2e online division is staged, started and (unless `open: false`) has round 1 opened - every seed in this file
 * goes through it, so a rule that gates one of these steps (Task 9's pay gate on Open round 1) is extended HERE and nowhere else.
 *
 * Online Chess credits (Task 9): the package is PAID before this returns, through the real routes. A Swiss or a knockout opened here
 * pays ON the open (the 402, then "Pay and open": `openRoundOne`); a legacy league pays at the pay door BEFORE its stage is written
 * (the door refuses to charge a league), and a division left unopened (`open: false`) pays at the pay door too, so the round the spec
 * opens itself is a paid one.
 *
 * - "knockout": the stage and its fixtures, then Start. Two entrants make one match (n - 1).
 * - "swiss": the stage mints its shells at Start and round 1 is paired on the next Generate - the organiser's two presses.
 * - "league" (the default): the legacy shape, see `OnlineStage`. A league pairs every round at Generate, then Start.
 * Then round 1 is opened through the open-round route (D12). `fixtureIds` are the generated fixtures of a league or a knockout and
 * the paired round 1 of a Swiss.
 */
export async function setUpOnlineDivision(
  request: APIRequestContext,
  divisionId: string,
  opts: { stage?: OnlineStage | undefined; open?: boolean | undefined } = {},
): Promise<{ stageId: string; fixtureIds: string[] }> {
  const kind = opts.stage ?? "league";
  const payOnOpen = kind !== "league" && opts.open !== false;
  if (!payOnOpen) await payThroughPayDoor(request, divisionId);
  let stageId: string;
  let fixtureIds: string[];
  if (kind === "swiss") {
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
    const paired = await apiJson<{ fixtures?: { id: string }[] }>(request, `/api/v1/stages/${stageId}/generate`, "POST", {});
    expect(paired.status, `pair round 1: ${JSON.stringify(paired.error)}`).toBeLessThan(300);
    fixtureIds = (paired.data?.fixtures ?? []).map((f) => f.id);
  } else {
    ({ stageId, fixtureIds } =
      kind === "knockout"
        ? await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Knockout" })
        : await createLegacyLeague(request, divisionId));
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  }
  if (opts.open !== false) await openRoundOne(request, stageId, divisionId);
  return { stageId, fixtureIds };
}

/**
 * One online chess fixture, its round opened (unless `open: false`), both
 * players linked and seated on it. `names` are the two players' full names,
 * in fixture order (home, away). `stage` is the format it is drawn in (a league,
 * the legacy shape, unless named; a knockout's two entrants are one match too).
 */
export async function seedMatchRoom(
  request: APIRequestContext,
  opts: { names: [string, string]; open?: boolean; cameraPolicy?: "required" | "optional"; stage?: "league" | "knockout" },
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
  if (opts.cameraPolicy) {
    // The division settings' own write (division-settings.tsx saveCameraPolicy), before Start locks it.
    const cam = await apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", { camera_policy: opts.cameraPolicy });
    expect(cam.status, `camera policy: ${JSON.stringify(cam.error)}`).toBeLessThan(300);
  }

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

  const { stageId, fixtureIds } = await setUpOnlineDivision(request, divisionId, { stage: opts.stage, open: opts.open });
  expect(fixtureIds.length, "one pairing between two entrants").toBe(1);
  const fixtureId = fixtureIds[0]!;

  let roundOpen: SeededRoom["roundOpen"] = null;
  if (opts.open !== false) {
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
        fixture: `/live/${row!.org}/${row!.comp}/${row!.div}/fixtures/${fixtureId}`,
        standings: `/live/${row!.org}/${row!.comp}/${row!.div}`,
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
  /** Each side's time AS AT `last_move_at` (V454, T10's append), in ms. */
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
  /** The division's run sheet (`?tab=fixtures`). Open round lives on Match Day's round panel (`matchDayPath`); the tab keeps the run-sheet
   *  chips, the Held | Flagged queue (each row with its "Open in Match Day") and the `arbiter-entry` card ("Open Match Day") that lead there. */
  fixturesTab: string;
  /** The COMPETITION's Match Day (`/o/{org}/c/{comp}/match-day`): one page for every division of it. Append `?board=<fixture id>` or
   *  `?round=<stage id>:<round no>` to open a board's or a round's panel in place. */
  matchDayPath: string;
  /** `/live/{org}/{comp}/{div}` — prefix of every public fixture page. */
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
 * round 1 opened through the open-round route (D12) - all in `setUpOnlineDivision`.
 * A league pairs every round at Generate; a Swiss stage mints its shells at Start and
 * pairs round 1 on the next Generate — the organiser's two presses. `camera: "required"` is
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
    /** The stage the generator builds: a league unless named - the LEGACY shape (see `OnlineStage`: a division that plays online is
     *  refused a league now, so it is written with online play off around the stage and switched back on). "knockout" is a real
     *  bracket (its next match and that match's seat wired by the generator itself); round 1 is its first round, so a four-player one
     *  is two semi-finals. "swiss" is the supported multi-round format. Name a supported one wherever the spec does not read a league. */
    stage?: OnlineStage;
    /** The division's clock (default CLOCK, 10+5) — a curated key of time-controls.ts. */
    clock?: { base: number; increment: number };
    /** T17: link each player with a token the server CAN open, so a game can
     *  really be created at the Lichess fixture server. Default: the
     *  unopenable one-byte token (nothing may reach Lichess). */
    playable?: boolean;
    /** The load harness's real-lila backend (LOAD_LICHESS=lila): link player i to `lichessAccounts[i]` - an account and a
     *  personal token minted in that lila - instead of a made-up id. One per name, in order; implies `playable`. */
    lichessAccounts?: readonly { lichessId: string; token: string }[];
  } = {},
): Promise<SeededRound> {
  if (opts.lichessAccounts && opts.lichessAccounts.length !== names.length) {
    throw new Error(`seedOnlineRound: ${names.length} players but ${opts.lichessAccounts.length} Lichess accounts`);
  }
  const people: Omit<RoundPlayer, "entrantId">[] = [];
  for (const [i, name] of names.entries()) {
    const { userId, email } = await seedUser(name);
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: name,
      consent: { public_name: true },
    });
    expect(person.status, `person ${name}: ${JSON.stringify(person.error)}`).toBeLessThan(300);
    await linkPersonToUserBySql(person.data!.id, userId);
    const given = opts.lichessAccounts?.[i];
    const lichessId = given ? given.lichessId : `e2e-rnd-${randomBytes(5).toString("hex")}`;
    let lichessToken: string | null = null;
    if (given) {
      lichessToken = given.token;
      await linkLichessBySql(userId, lichessId, lichessToken, playScopes());
    } else if (opts.playable) {
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

  const { stageId } = await setUpOnlineDivision(request, divisionId, { stage: opts.stage, open: opts.open });

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
      matchDayPath: `/o/${slug!.org}/c/${slug!.comp}/match-day`,
      publicBase: `/live/${slug!.org}/${slug!.comp}/${slug!.div}`,
      slugs: { org: slug!.org, comp: slug!.comp, div: slug!.div },
      boards: rows.map((r) => ({ fixtureId: r.id, home: byEntrant.get(r.home)!, away: byEntrant.get(r.away)! })),
    };
  });
}

/** A game on a board's ledger, as T9 (create) and T10 (moves) leave it, White
 *  the home side (recorded on the row, the way T9 records it). `hold` puts it
 *  on the organiser's desk (needs_organiser). The rules judge `moves`. */
export async function roundGameSql(board: RoundBoard, opts: { moves: string[]; hold?: string }): Promise<{ fen: string }> {
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

/** The statuses in which the provider took the mail, so the row carries its message id and a send time (V470's unique
 *  `provider_id` index is only for rows that have one). */
const PROVIDER_TOOK: readonly OutboxStatus[] = ["sent", "delayed", "delivered", "bounced", "complained"];

/** Spec §6: put a seat's newest outbox row in `status` (honouring V470's CHECKs: no body outside queued or sending, a lease
 *  only while sending, a unique provider id once the provider took it), and stamp the seat bound to its round's open when
 *  the status holds the seat, or clear the stamp when it does not. The holding list is composed HERE from the pure
 *  constants.ts as [...LIVE_STATUSES, "complained"] (C3; Task 1 pins it equal to the hook's SEAT_HOLDING_STATUSES) - never
 *  imported from invite-outbox-hook.ts, which is server-only.
 *
 *  The product reaches these states through the outbox worker and the provider's webhook (`/api/cron/email-outbox`, a
 *  Resend event), neither of which runs in e2e (no mail provider), so a spec that must show "Bounced" or "Delivered" on a
 *  waiting-list seat writes the row the way the hook leaves it: the status, and the seat's stamp to match (`releaseSeat`'s
 *  rule when it does not hold: clear the colour, and unbind the row from the open when the other colour holds nothing).
 *  Throws, named, when the seat has no outbox row (the round was not opened, or its mail was never queued) or the round has
 *  no open to bind to: a seed that quietly changed nothing would let a spec assert on the state it started in. */
export async function seedSeatInvite(fixtureId: string, colour: "white" | "black", status: OutboxStatus): Promise<void> {
  const holdsSeat = ([...LIVE_STATUSES, "complained"] as readonly OutboxStatus[]).includes(status);
  const providerTook = PROVIDER_TOOK.includes(status);
  const endedBadly = ENDED_BADLY_STATUSES.includes(status);
  const ref = `${fixtureId}:${colour}`;
  const stampCol = colour === "white" ? "white_emailed_at" : "black_emailed_at";
  const otherCol = colour === "white" ? "black_emailed_at" : "white_emailed_at";
  const at = new Date();
  await withDb(async (sql) => {
    const [row] = await sql<{ id: string; meta: Record<string, unknown> }[]>`
      select id, meta from email_outbox
       where kind = 'chess_invite' and ref_type = 'fixture_seat' and ref_id = ${ref}
       order by created_at desc, id desc limit 1`;
    if (!row) throw new Error(`seedSeatInvite: no chess_invite outbox row for ${ref} (was the round opened?)`);
    const updated = await sql`
      update email_outbox
         set status = ${status},
             body_sealed = null,
             lease_until = ${status === "sending" ? new Date(at.getTime() + 120_000) : null},
             provider_id = ${providerTook ? `e2e-seed-${randomUUID()}` : null},
             sent_at = ${providerTook ? at : null},
             last_error = ${endedBadly ? `e2e_seed_${status}` : null},
             meta = ${sql.json({ ...row.meta, ...(holdsSeat ? { stampedAt: at.toISOString() } : {}) } as never)},
             status_at = ${at}
       where id = ${row.id}`;
    expect(updated.count, `the outbox row of ${ref} took the status`).toBe(1);
    if (holdsSeat) {
      const [open] = await sql<{ id: string }[]>`
        select o.id from fixtures f join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
         where f.id = ${fixtureId}`;
      if (!open) throw new Error(`seedSeatInvite: the round of ${fixtureId} has no open to bind ${colour}'s stamp to`);
      const stamped = await sql`
        update fixture_external_play
           set ${sql(stampCol)} = ${at}, round_open_id = ${open.id}, updated_at = now()
         where fixture_id = ${fixtureId}`;
      expect(stamped.count, `the bridge row of ${fixtureId} took ${colour}'s stamp`).toBe(1);
    } else {
      const released = await sql`
        update fixture_external_play
           set ${sql(stampCol)} = null,
               round_open_id = case when ${sql(otherCol)} is null then null else round_open_id end,
               updated_at = now()
         where fixture_id = ${fixtureId}`;
      expect(released.count, `the bridge row of ${fixtureId} released ${colour}'s stamp`).toBe(1);
    }
  });
}

/** Spec §6: a seat nobody ever mailed. Takes away every chess_invite outbox row of the seat and releases its stamp the way
 *  `releaseSeat` does (clear the colour; unbind the row from the open when the other colour holds nothing), which is V451's
 *  rule: a stamp needs a round_open_id, so the open id may only go when both stamps are gone. A seat with no mail on file
 *  and no stamp reads "Not invited"; a seat that is stamped with no mail reads "Not delivered" (the arbiter read logs it as
 *  an anomaly), so the release is half of what makes the word. The product reads "Not invited" for a seat whose current
 *  player has no mail on file (a player put on the board after the open); no e2e server reaches it by itself, since the open
 *  queues a row for every address it has, so the rows are taken away to the same read.
 *  Throws when there was no row to take away: a seed that quietly changed nothing would let a spec assert on the state it
 *  started in. Returns how many rows went. */
export async function seedSeatUninvited(fixtureId: string, colour: "white" | "black"): Promise<number> {
  const ref = `${fixtureId}:${colour}`;
  const stampCol = colour === "white" ? "white_emailed_at" : "black_emailed_at";
  const otherCol = colour === "white" ? "black_emailed_at" : "white_emailed_at";
  return withDb(async (sql) => {
    const gone = await sql`
      delete from email_outbox where kind = 'chess_invite' and ref_type = 'fixture_seat' and ref_id = ${ref}`;
    if (gone.count === 0) throw new Error(`seedSeatUninvited: no chess_invite outbox row for ${ref} to take away (was the round opened?)`);
    const released = await sql`
      update fixture_external_play
         set ${sql(stampCol)} = null,
             round_open_id = case when ${sql(otherCol)} is null then null else round_open_id end,
             updated_at = now()
       where fixture_id = ${fixtureId}`;
    expect(released.count, `the bridge row of ${fixtureId} released ${colour}'s stamp`).toBe(1);
    return gone.count;
  });
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
