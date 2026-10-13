// Task 17 — a local stand-in for the Lichess Board API, so the online-chess
// walkthrough drives OUR server's whole venue — seat, create, move, draw,
// resign, abort, reconcile — without touching lichess.org. The app server is
// pointed here by LICHESS_BASE_URL (read by `createBoardApi`,
// src/server/external-play/lichess/board-api.ts, and by the OAuth client in
// lichess/client.ts), the same trick ai-fixture-server.ts and
// stripe-fixture-server.ts use.
//
// It is HAND-WRITTEN, and every response shape it serves is a MEASURED fact or
// a rule read from lila's source — never a guess. The ones that break us:
//   M5   POST .../move/e7e6xx -> 200 {"ok":true}, and e7e6 is what is played.
//        Lichess truncates. This is why our server validates UCI itself.
//   M6   ONE 400 body — {"error":"Not your turn, or game already over"} — for
//        both "out of turn" and "already over". Deliberately not disambiguated.
//   M12  A bullet clock (estimated total < 180 s) is CREATED fine, then every
//        move 400s {"error":"This game cannot be played with the Board API."}.
//        tc-boundary.log: 120+1 refused, 180+0 plays.
//   M3   Creation is rate-limited: 5 creates, then 429
//        {"error":"Too many requests. Try again later."} (b3-spike.log (2)).
//        OFF by default here — `setCreateBudget` turns it on — because the
//        window Lichess counts over is unmeasured and a walkthrough must not
//        flake on a guess.
//   M9   Resign before ply 2 -> status "aborted", `winner` ABSENT. After -> "resign".
//   M11  The export's `clocks` is CENTISECONDS, one entry PER PLY, beside a
//        seconds `clock` envelope whose totalTime = limit + 40 x increment.
//   M16  An export of a game in play withholds its last 3 plies once past 5.
//   T11  A read SETTLES an expired clock, visible on the NEXT read: the first
//        board-stream read after expiry still says `started` with the flagged
//        side's time at 0 (gamefull-expired-1.ndjson, then -2).
//   L1   GET /api/challenge (T17 live probe, 2026-10-13): the LIVE entry shape
//        (challenge-list-{white,black}.json) — NO `createdAt` — and an
//        unaccepted challenge leaves both lists ~30 s after creation (listed
//        at +2 s, gone by +36 s, `offline` at +32 s), yet stays acceptable and
//        cancellable. Modelled at CHALLENGE_LISTED_MS, inside that bracket.
//
// What is NOT measured, and is modelled from lila's source or left plain:
// illegal moves, aborts
// after ply 2 and acts on a finished game answer named `fixture:` 400s rather
// than an invented Lichess sentence; a stranger's token on someone else's game
// is a named 404. Every unexpected route is a 404 that names itself.
//
// What it does NOT prove: that lichess.org still behaves this way. The
// recorded-payload half of lichess-fixture-contract.test.ts is the check on
// that, and the live re-measurements are owed (task-17-report.md).
//
// Every request is pushed onto `calls` BEFORE any branching, so a refusal is
// still on the record — the walkthrough's "no challenge before the open"
// assertion is only as good as that.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Chess, type Square } from "chess.js";

/** Fixed port so the app server (booted before the spec) and the spec agree on
 *  the URL without discovery. 4319 is the AI fixture's, 12111 Stripe's, 4322
 *  the RealtimeKit fixture's. CI and ci-local.sh point LICHESS_BASE_URL here;
 *  e2e-ci-wiring.test.ts imports this constant to pin that. */
export const LICHESS_FIXTURE_PORT = 4321;
export const LICHESS_FIXTURE_URL = `http://127.0.0.1:${LICHESS_FIXTURE_PORT}`;

export type Colour = "white" | "black";

export interface LichessFixtureCall {
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  /** The form body (or JSON body) as a flat record; {} when there was none. */
  body: Record<string, string>;
  /** The bearer token sent, or null. */
  token: string | null;
  at: number;
}

export interface LichessFixtureGame {
  id: string;
  white: string;
  black: string;
  limitSeconds: number;
  incrementSeconds: number;
  /** "created" while it is still a challenge nobody accepted. */
  status: string;
  winner: Colour | null;
  /** Canonical UCI, as the board stream speaks it. */
  movesUci: string[];
}

export interface LichessFixtureServer {
  url: string;
  port: number;
  calls: LichessFixtureCall[];
  /** A bearer token Lichess knows, and whose account it is (a lower-case id).
   *  An unregistered token is refused like a revoked one. */
  registerToken(token: string, lichessId: string): void;
  /** Every later call bearing `token` answers 401 {"error":"No such token"}. */
  revokeToken(token: string): void;
  /** M3: allow `count` creates per `windowMs`, then 429. Off until called. */
  setCreateBudget(count: number, windowMs: number): void;
  /** The side to move's clock has run out, with nobody reading. The NEXT
   *  board-stream read reports `started` with that side's time at 0 and
   *  settles the flag; the read after it reports `outoftime` (T11, measured).
   *  Throws before ply 2 — Lichess's clock is not running yet. */
  expireClock(gameId: string): void;
  /** Serve a recorded export body verbatim for GET /game/export/{id}. */
  serveRawExport(gameId: string, body: unknown): void;
  /** Serve a recorded NDJSON body verbatim for GET /api/board/game/stream/{id}. */
  serveRawStream(gameId: string, ndjson: string): void;
  game(gameId: string): LichessFixtureGame | null;
  /** Every challenge or game, oldest first. */
  games(): LichessFixtureGame[];
  reset(): void;
  close(): Promise<void>;
}

const M6 = { error: "Not your turn, or game already over" };
const M12 = { error: "This game cannot be played with the Board API." };
const M3 = { error: "Too many requests. Try again later." };
const NO_SUCH_TOKEN = { error: "No such token" };
const BAD_LIMIT = { "clock.limit": ["Invalid value"], error: { "clock.limit": ["Invalid value"] } };

/** Every path the stub serves after the export (method checked per route). */
const ROUTES = [
  /^\/api\/challenge$/,
  /^\/api\/account\/playing$/,
  /^\/api\/challenge\/[A-Za-z0-9_-]+$/,
  /^\/api\/challenge\/[A-Za-z0-9]+\/(accept|cancel)$/,
  /^\/api\/board\/game\/stream\/[A-Za-z0-9]+$/,
  /^\/api\/board\/game\/[A-Za-z0-9]+\/(move\/[^/]+|resign|abort|draw\/(yes|no))$/,
];

/** M5: what Lichess keeps of a UCI string — its legal prefix. */
const UCI_PREFIX = /^([a-h][1-8][a-h][1-8][qrbn]?)/;

/** How long an unaccepted challenge stays in GET /api/challenge. Measured only
 *  as a bracket (T17 live probe: listed at +2 s, gone by +36 s, `offline` by
 *  +32 s); 30 s sits inside it. Past it the challenge is `offline`: unlisted,
 *  but still acceptable and cancellable (both measured). */
const CHALLENGE_LISTED_MS = 30_000;

/** The board-stream connection stays open the way Lichess's does, until the
 *  reader cancels; this caps a reader that never does. */
const STREAM_HOLD_MS = 30_000;

type Game = {
  id: string;
  white: string;
  black: string;
  limit: number;
  increment: number;
  /** The GAME's createdAt (the export's): reset when the challenge is accepted. */
  createdAt: number;
  /** When the challenge was made — what its listing ages from. */
  challengedAt: number;
  status: string; // created | canceled | started | <terminal>
  winner: Colour | null;
  chess: Chess;
  uci: string[];
  san: string[];
  /** Remaining ms per side as of `lastMoveAt`; per-ply mover's remaining in cs. */
  remaining: Record<Colour, number>;
  plyClocksCs: number[];
  lastMoveAt: number;
  drawOffer: Colour | null;
};

const other = (c: Colour): Colour => (c === "white" ? "black" : "white");

/** lila's limit choices, as far as measured: 0, 15, 30, 45, 60, 90 and whole
 *  minutes accepted; 140 and 170 refused (tc-boundary.log). */
function limitAllowed(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 0 && limit <= 10_800 && ([0, 15, 30, 45, 60, 90].includes(limit) || limit % 60 === 0);
}
const totalTime = (limit: number, increment: number) => limit + 40 * increment;
/** M12: the Board API refuses play on bullet and faster (est. total < 180 s). */
const unplayable = (g: Game) => totalTime(g.limit, g.increment) < 180;

function speed(limit: number, increment: number): string {
  const t = totalTime(limit, increment);
  if (t < 30) return "ultraBullet";
  if (t < 180) return "bullet";
  if (t < 480) return "blitz";
  if (t < 1500) return "rapid";
  return "classical";
}

let idSeq = 0;
function gameId(): string {
  // Lichess ids are 8 alphanumerics; a counter keeps them unique per process.
  idSeq += 1;
  const tail = (Date.now().toString(36) + idSeq.toString(36)).slice(-6);
  return ("Fx" + tail).padEnd(8, "0").slice(0, 8);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(contentType: string | undefined, raw: string): Record<string, string> {
  if (!raw) return {};
  if (contentType?.includes("application/json")) {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function startLichessFixtureServer(port: number = LICHESS_FIXTURE_PORT): Promise<LichessFixtureServer> {
  const calls: LichessFixtureCall[] = [];
  const tokens = new Map<string, string>();
  const revoked = new Set<string>();
  const games = new Map<string, Game>();
  const rawExports = new Map<string, string>();
  const rawStreams = new Map<string, string>();
  let budget: { count: number; windowMs: number; stamps: number[] } | null = null;

  const colourOf = (g: Game, user: string): Colour | null => (g.white === user ? "white" : g.black === user ? "black" : null);
  const turnOf = (g: Game): Colour => (g.chess.turn() === "w" ? "white" : "black");

  /** Remaining ms for `c` now: only the side to move's clock runs, and only
   *  once both sides have moved (scalachess Clock). */
  function remainingNow(g: Game, c: Colour, now: number): number {
    if (g.status !== "started" || g.uci.length < 2 || turnOf(g) !== c) return g.remaining[c];
    return Math.max(0, g.remaining[c] - (now - g.lastMoveAt));
  }

  function finish(g: Game, status: string, winner: Colour | null): void {
    g.status = status;
    g.winner = winner;
    g.drawOffer = null;
  }

  function exportBody(g: Game, query: Record<string, string>): Record<string, unknown> {
    // M16: an unauthenticated export of a game in play withholds the last 3
    // plies (moves AND clocks) once it is past 5 (lila applyDelay).
    const n = g.uci.length;
    const shown = g.status === "started" && n > 5 ? n - 3 : n;
    const body: Record<string, unknown> = {
      id: g.id,
      rated: false,
      variant: "standard",
      speed: speed(g.limit, g.increment),
      perf: speed(g.limit, g.increment),
      createdAt: g.createdAt,
      lastMoveAt: g.lastMoveAt,
      status: g.status,
      source: "friend",
      players: {
        white: { user: { name: g.white, id: g.white }, rating: 1500, provisional: true },
        black: { user: { name: g.black, id: g.black }, rating: 1500, provisional: true },
      },
    };
    if (g.winner) body.winner = g.winner; // ABSENT, never null (fixtures README)
    if (query.moves !== "false") body.moves = g.san.slice(0, shown).join(" ");
    if (query.clocks !== "false") body.clocks = g.plyClocksCs.slice(0, shown);
    body.clock = { initial: g.limit, increment: g.increment, totalTime: totalTime(g.limit, g.increment) };
    return body;
  }

  function gameFull(g: Game, now: number): Record<string, unknown> {
    const state: Record<string, unknown> = {
      type: "gameState",
      moves: g.uci.join(" "),
      wtime: remainingNow(g, "white", now),
      btime: remainingNow(g, "black", now),
      winc: g.increment * 1000,
      binc: g.increment * 1000,
      status: g.status,
    };
    if (g.winner) state.winner = g.winner;
    if (g.drawOffer === "white") state.wdraw = true;
    if (g.drawOffer === "black") state.bdraw = true;
    // Shape of gamefull-*.ndjson, field for field.
    return {
      id: g.id,
      variant: { key: "standard", name: "Standard", short: "Std" },
      speed: speed(g.limit, g.increment),
      perf: { name: speed(g.limit, g.increment) },
      rated: false,
      createdAt: g.createdAt,
      white: { id: g.white, name: g.white, title: null, rating: 1500, provisional: true },
      black: { id: g.black, name: g.black, title: null, rating: 1500, provisional: true },
      initialFen: "startpos",
      clock: { initial: g.limit * 1000, increment: g.increment * 1000 },
      type: "gameFull",
      state,
    };
  }

  /** The LIVE ChallengeJson (challenge-list-white.json, key for key): no
   *  createdAt; `direction` from the reader's side. `perf.icon` is the
   *  recorded glyph — it is measured for rapid only, and nothing reads it. */
  function challengeJson(g: Game, direction: "in" | "out"): Record<string, unknown> {
    const sp = speed(g.limit, g.increment);
    return {
      id: g.id,
      url: `https://lichess.org/${g.id}`,
      status: g.status,
      challenger: { name: g.white, id: g.white, rating: 1500, provisional: true, lag: 4 },
      destUser: { name: g.black, id: g.black, rating: 1500, provisional: true, online: true, lag: 4 },
      variant: { key: "standard", name: "Standard", short: "Std" },
      rated: false,
      speed: sp,
      timeControl: { type: "clock", limit: g.limit, increment: g.increment, show: `${g.limit / 60}+${g.increment}` },
      color: "white",
      finalColor: "white",
      perf: { icon: "\ue002", name: sp.charAt(0).toUpperCase() + sp.slice(1) },
      direction,
    };
  }

  /** Still listed: an unaccepted challenge younger than CHALLENGE_LISTED_MS. */
  const listed = (g: Game, now: number) => g.status === "created" && now - g.challengedAt < CHALLENGE_LISTED_MS;

  /** M5 + lila's move reading: truncate to the legal prefix, read a king
   *  onto its own rook as a castle, and queen a suffix-less promotion. */
  function applyMove(g: Game, sent: string): { ok: true } | { ok: false } {
    const m = UCI_PREFIX.exec(sent);
    if (!m) return { ok: false };
    const uci = m[1]!;
    const from = uci.slice(0, 2) as Square;
    let to = uci.slice(2, 4) as Square;
    let promotion = uci[4];
    const piece = g.chess.get(from);
    if (piece?.type === "k") {
      const target = g.chess.get(to);
      if (target && target.type === "r" && target.color === piece.color && from[1] === to[1]) {
        to = ((to[0]! > from[0]! ? "g" : "c") + from[1]) as Square;
      }
    }
    if (piece?.type === "p" && !promotion && (to[1] === "8" || to[1] === "1")) promotion = "q";
    try {
      const played = g.chess.move({ from, to, ...(promotion ? { promotion } : {}) });
      g.uci.push(played.from + played.to + (played.promotion ?? ""));
      g.san.push(played.san);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://fixture");
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
      const now = Date.now();
      calls.push({ method, path, query, body: parseBody(req.headers["content-type"], raw), token, at: now });
      const body = calls.at(-1)!.body;
      const send = (obj: unknown, code = 200) => send0(res, code, obj);

      // The export is public: no token, and an unauthenticated read.
      const exp = /^\/game\/export\/([A-Za-z0-9]+)$/.exec(path);
      if (exp && method === "GET") {
        const recorded = rawExports.get(exp[1]!);
        if (recorded !== undefined) return res.writeHead(200, { "content-type": "application/json" }).end(recorded);
        const g = games.get(exp[1]!);
        if (!g || g.status === "canceled") return send({ error: "Not found" }, 404);
        return send(exportBody(g, query));
      }

      // A route this stub does not serve names itself, token or not.
      if (!ROUTES.some((r) => r.test(path))) return send({ error: `fixture: unhandled ${method} ${path}` }, 404);
      // Everything else is a Board API / challenge call and carries a token.
      if (token === null || revoked.has(token) || !tokens.has(token)) return send(NO_SUCH_TOKEN, 401);
      const me = tokens.get(token)!;

      if (path === "/api/challenge" && method === "GET") {
        const all = [...games.values()].filter((g) => listed(g, now));
        return send({
          in: all.filter((g) => g.black === me).map((g) => challengeJson(g, "in")),
          out: all.filter((g) => g.white === me).map((g) => challengeJson(g, "out")),
        });
      }

      if (path === "/api/account/playing" && method === "GET") {
        const nb = Number(query.nb ?? 9);
        const mine = [...games.values()].filter((g) => g.status === "started" && colourOf(g, me) !== null);
        return send({
          nowPlaying: mine.slice(0, nb).map((g) => {
            const color = colourOf(g, me)!;
            const opp = color === "white" ? g.black : g.white;
            return { gameId: g.id, fullId: g.id + "abcd", color, isMyTurn: turnOf(g) === color, opponent: { id: opp, username: opp }, variant: { key: "standard" } };
          }),
        });
      }

      const create = /^\/api\/challenge\/([A-Za-z0-9_-]+)$/.exec(path);
      if (create && method === "POST") {
        if (budget) {
          budget.stamps = budget.stamps.filter((t) => now - t < budget!.windowMs);
          if (budget.stamps.length >= budget.count) return send(M3, 429);
          budget.stamps.push(now);
        }
        const limit = Number(body["clock.limit"]);
        const increment = Number(body["clock.increment"] ?? 0);
        if (!limitAllowed(limit)) return send(BAD_LIMIT, 400);
        const dest = create[1]!.toLowerCase();
        if (![...tokens.values()].includes(dest)) return send({ error: `fixture: no Lichess account ${dest}` }, 404);
        const g: Game = {
          id: gameId(), white: me, black: dest, limit, increment, createdAt: now, challengedAt: now, status: "created", winner: null,
          chess: new Chess(), uci: [], san: [], remaining: { white: limit * 1000, black: limit * 1000 },
          plyClocksCs: [], lastMoveAt: now, drawOffer: null,
        };
        games.set(g.id, g);
        // T9 measured: the ChallengeJson at the TOP level (`id`), not wrapped
        // (T17: the same live entry, `direction: "out"`).
        return send(challengeJson(g, "out"));
      }

      const ch = /^\/api\/challenge\/([A-Za-z0-9]+)\/(accept|cancel)$/.exec(path);
      if (ch && method === "POST") {
        const g = games.get(ch[1]!);
        if (ch[2] === "accept") {
          if (!g || g.status !== "created" || g.black !== me) return send({ error: "fixture: no such challenge for you" }, 404);
          g.status = "started";
          g.createdAt = now;
          g.lastMoveAt = now;
          return send({ ok: true });
        }
        if (!g || g.white !== me) return send({ error: "fixture: no such challenge of yours" }, 404);
        // lila apiCancel (T9 measured): a pending challenge is withdrawn; an
        // accepted game nobody has played is aborted.
        if (g.status === "created") g.status = "canceled";
        else if (g.status === "started" && g.uci.length < 2) finish(g, "aborted", null);
        else return send({ error: "fixture: this game cannot be cancelled" }, 400);
        return send({ ok: true });
      }

      const stream = /^\/api\/board\/game\/stream\/([A-Za-z0-9]+)$/.exec(path);
      if (stream && method === "GET") {
        const recorded = rawStreams.get(stream[1]!);
        if (recorded !== undefined) return res.writeHead(200, { "content-type": "application/x-ndjson" }).end(recorded);
        const g = games.get(stream[1]!);
        if (!g || g.status === "created" || g.status === "canceled" || colourOf(g, me) === null) {
          return send({ error: "fixture: no such game for you" }, 404);
        }
        // T11 (measured): the first read after expiry reports the zero and
        // `started`; it settles the flag, which the NEXT read shows.
        const line = JSON.stringify(gameFull(g, now)) + "\n";
        const mover = turnOf(g);
        if (g.status === "started" && g.uci.length >= 2 && remainingNow(g, mover, now) <= 0) finish(g, "outoftime", other(mover));
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(line);
        const hold = setTimeout(() => res.end(), STREAM_HOLD_MS);
        res.on("close", () => clearTimeout(hold));
        return;
      }

      const act = /^\/api\/board\/game\/([A-Za-z0-9]+)\/(move\/([^/]+)|resign|abort|draw\/(yes|no))$/.exec(path);
      if (act && method === "POST") {
        const g = games.get(act[1]!);
        const colour = g ? colourOf(g, me) : null;
        if (!g || g.status === "created" || g.status === "canceled" || colour === null) {
          return send({ error: "fixture: no such game for you" }, 404);
        }
        const over = g.status !== "started";
        if (act[3] !== undefined) {
          if (unplayable(g)) return send(M12, 400);
          if (over || turnOf(g) !== colour) return send(M6, 400);
          // A move by a side whose clock has run out loses on time instead
          // (not measured: modelled on lila's outoftime check at a move).
          if (remainingNow(g, colour, now) <= 0) {
            finish(g, "outoftime", other(colour));
            return send(M6, 400);
          }
          const plyBefore = g.uci.length;
          const spent = plyBefore >= 2 ? now - g.lastMoveAt : 0;
          if (!applyMove(g, decodeURIComponent(act[3]))) return send({ error: `fixture: illegal move ${act[3]}` }, 400);
          if (plyBefore >= 2) g.remaining[colour] = Math.max(0, g.remaining[colour] - spent) + g.increment * 1000;
          g.plyClocksCs.push(Math.round(g.remaining[colour] / 10));
          g.lastMoveAt = now;
          if (g.drawOffer === other(colour)) g.drawOffer = null; // a move declines the standing offer
          if (g.chess.isCheckmate()) finish(g, "mate", colour);
          else if (g.chess.isStalemate()) finish(g, "stalemate", null);
          else if (g.chess.isInsufficientMaterial()) finish(g, "draw", null);
          return send({ ok: true });
        }
        if (over) return send({ error: "fixture: the game is over" }, 400);
        if (act[2] === "resign") {
          // M9: before ply 2 a resign is an abort, with no winner.
          if (g.uci.length < 2) finish(g, "aborted", null);
          else finish(g, "resign", other(colour));
          return send({ ok: true });
        }
        if (act[2] === "abort") {
          if (g.uci.length >= 2) return send({ error: "fixture: this game can no longer be aborted" }, 400);
          finish(g, "aborted", null);
          return send({ ok: true });
        }
        // draw/yes | draw/no. lila registers no offer before ply 2
        // (Game.playerCanOfferDraw); a yes to the standing offer draws.
        if (act[4] === "no") {
          g.drawOffer = null;
        } else if (g.drawOffer === other(colour)) {
          finish(g, "draw", null);
        } else if (g.uci.length >= 2) {
          g.drawOffer = colour;
        }
        return send({ ok: true });
      }

      return send({ error: `fixture: unhandled ${method} ${path}` }, 404);
    })().catch((err: unknown) => {
      if (!res.headersSent) send0(res, 500, { error: `fixture: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  const view = (g: Game): LichessFixtureGame => ({
    id: g.id, white: g.white, black: g.black, limitSeconds: g.limit, incrementSeconds: g.increment,
    status: g.status, winner: g.winner, movesUci: [...g.uci],
  });

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    calls,
    registerToken(token, lichessId) {
      tokens.set(token, lichessId.toLowerCase());
      revoked.delete(token);
    },
    revokeToken(token) {
      revoked.add(token);
    },
    setCreateBudget(count, windowMs) {
      budget = { count, windowMs, stamps: [] };
    },
    expireClock(id) {
      const g = games.get(id);
      if (!g || g.status !== "started") throw new Error(`expireClock: ${id} is not a game in play`);
      if (g.uci.length < 2) throw new Error(`expireClock: ${id} — Lichess's clock is not running before both sides move`);
      // As if the time had passed: the running side's clock reads zero. A
      // stream read settles it (above) — nothing here finishes the game.
      g.remaining[turnOf(g)] = 0;
      g.lastMoveAt = Date.now();
    },
    serveRawExport(id, b) {
      rawExports.set(id, JSON.stringify(b));
    },
    serveRawStream(id, ndjson) {
      rawStreams.set(id, ndjson);
    },
    game(id) {
      const g = games.get(id);
      return g ? view(g) : null;
    },
    games() {
      return [...games.values()].map(view);
    },
    reset() {
      calls.length = 0;
      tokens.clear();
      revoked.clear();
      games.clear();
      rawExports.clear();
      rawStreams.clear();
      budget = null;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A board stream a reader never cancelled would hold close() open.
        server.closeAllConnections();
      });
    },
  };
}

function send0(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
}
