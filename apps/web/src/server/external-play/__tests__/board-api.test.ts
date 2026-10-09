// Board API client. Every expected code below is derived from a MEASURED
// response (spike-battery2.log, tc-boundary.log, 2026-10-09), never from the
// Lichess docs and never from this module's own source.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBoardApi } from "../lichess/board-api";
import { LICHESS_STATUSES } from "../types";
import { LICHESS_TIMEOUT_MS } from "../window";

const NOT_YOUR_TURN = '{"error":"Not your turn, or game already over"}';   // M6
const UNPLAYABLE = '{"error":"This game cannot be played with the Board API."}'; // M12
const RATE_LIMITED = '{"error":"Too many requests. Try again later."}';     // M3
const BAD_LIMIT = '{"clock.limit":["Invalid value"],"error":{"clock.limit":["Invalid value"]}}'; // M14

const api = (fetchFn: typeof fetch) => createBoardApi({ fetch: fetchFn, baseUrl: "https://li.test" });
const res = (body: string, status: number) => new Response(body, { status });

describe("submitMove — error mapping is measured, not guessed", () => {
  it("200 {ok:true} is an acceptance", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    expect(await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    })).toEqual({ ok: true });
  });

  // M6: ONE message covers two states, so the code must not claim to know
  // which. §3.5 turns this into a reconcile, never an assumption.
  it("400 'Not your turn, or game already over' is not_your_turn_or_over, carrying the raw body", async () => {
    const f = vi.fn(async () => res(NOT_YOUR_TURN, 400));
    expect(await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    })).toEqual({ ok: false, code: "not_your_turn_or_over", raw: NOT_YOUR_TURN });
  });

  // M12: the dangerous half is that CREATION succeeded — 0+1 and 1+0 were
  // accepted as challenges and then refused every move. The two 400s must map
  // to DIFFERENT codes, or a tournament configured on a bullet clock reads as
  // "your turn ended" to every player in the field.
  it("400 'cannot be played with the Board API' is unplayable_time_control, NOT the turn error", async () => {
    const f = vi.fn(async () => res(UNPLAYABLE, 400));
    const out = await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    });
    expect(out).toEqual({ ok: false, code: "unplayable_time_control", raw: UNPLAYABLE });
    expect(out).not.toMatchObject({ code: "not_your_turn_or_over" });
  });

  it.each([
    [401, "unauthorized"], [403, "unauthorized"],
    [429, "rate_limited"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"],
  ])("%i maps to %s", async (status, code) => {
    const f = vi.fn(async () => res(status === 429 ? RATE_LIMITED : "nope", status));
    expect(await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    })).toMatchObject({ ok: false, code });
  });

  it("a thrown fetch (network, or the AbortSignal firing) is unavailable, never an uncaught throw", async () => {
    const f = vi.fn(async () => { throw new Error("socket hang up"); });
    expect(await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    })).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("an UNRECOGNISED 400 body is unavailable, not silently an acceptance", async () => {
    const f = vi.fn(async () => res('{"error":"something new"}', 400));
    expect(await api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e2e4",
    })).toMatchObject({ ok: false, code: "unavailable" });
  });

  // The guard M5 bought, at the seam that matters: the client never reaches
  // Lichess with a malformed string, so `fetch` is never called at all.
  it("refuses a malformed UCI BEFORE any HTTP call", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    await expect(api(f as unknown as typeof fetch).submitMove({
      token: "t", gameId: "g", uci: "e7e6xx",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the player's token as a bearer, to the game's own move path", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    await api(f as unknown as typeof fetch).submitMove({
      token: "lio_abc", gameId: "gm1", uci: "e7e8q",
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/board/game/gm1/move/e7e8q");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_abc");
  });
});

describe("createChallengeToUser — White's token challenges Black's username", () => {
  it("POSTs the challenge unrated, with the seconds clock, and returns the id", async () => {
    const f = vi.fn(async () => res('{"id":"ch123"}', 200));
    const out = await api(f as unknown as typeof fetch).createChallengeToUser({
      whiteToken: "lio_white", blackUsername: "Ada",
      limitSeconds: 300, incrementSeconds: 3,
    });
    expect(out).toEqual({ ok: true, challengeId: "ch123" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/challenge/Ada");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_white");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("clock.limit")).toBe("300");
    expect(body.get("clock.increment")).toBe("3");
    expect(body.get("rated")).toBe("false");   // global constraint: unrated only
    expect(body.get("color")).toBe("white");   // colour comes from the pairing
    expect(body.get("variant")).toBe("standard");
    expect(body.get("keepAliveStream")).toBeNull(); // no long-lived connection, anywhere
  });

  // M14: 170+0 and 140+1 were refused AT CREATION with this exact body. T5's
  // catalogue is what stops it reaching here; this is the backstop.
  it("a refused clock.limit is unavailable with the raw body kept for the organiser", async () => {
    const f = vi.fn(async () => res(BAD_LIMIT, 400));
    expect(await api(f as unknown as typeof fetch).createChallengeToUser({
      whiteToken: "t", blackUsername: "Ada", limitSeconds: 170, incrementSeconds: 0,
    })).toEqual({ ok: false, code: "unavailable", raw: BAD_LIMIT });
  });

  // M3 (corrected 2026-10-09): five creates in ~4s, then the next ones returned
  // this. lila: 5 creates per minute per challenger, 500 per 10 min per IP.
  it("429 is rate_limited — the create job turns it into T4's CreationRateLimited hold", async () => {
    const f = vi.fn(async () => res(RATE_LIMITED, 429));
    expect(await api(f as unknown as typeof fetch).createChallengeToUser({
      whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
    })).toEqual({ ok: false, code: "rate_limited", raw: RATE_LIMITED });
  });

  // Fix round 1 (T3-I2): Lichess ANSWERED 2xx, so it may well have created
  // the challenge — the body just did not tell us its id. That is not a
  // definite failure, and releasing the claim on it is how a second challenge
  // gets created.
  it("a 200 with no id is outcome_unknown, not a created game with an undefined id", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    expect(await api(f as unknown as typeof fetch).createChallengeToUser({
      whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
    })).toEqual({ ok: false, code: "outcome_unknown", raw: '{"ok":true}' });
  });

  // Added beyond the brief: the `id === ""` guard in createChallengeToUser had
  // no test, and mutating it away stayed green.
  it("a 200 with an EMPTY id is outcome_unknown — an empty challenge id is no id", async () => {
    const f = vi.fn(async () => res('{"id":""}', 200));
    expect(await api(f as unknown as typeof fetch).createChallengeToUser({
      whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
    })).toEqual({ ok: false, code: "outcome_unknown", raw: '{"id":""}' });
  });

  // Added beyond the brief: the module's own invariant is "never an uncaught
  // throw into a usecase holding a claim", and a 200 whose body is not a JSON
  // object (a proxy's HTML page, or a literal `null`) would otherwise throw
  // out of JSON.parse or out of `null.id` — after a challenge may already
  // exist at Lichess.
  it("a 200 whose body is not a JSON object is outcome_unknown, never an uncaught throw", async () => {
    let checked = 0;
    for (const body of ["<html>bad gateway</html>", "null", ""]) {
      const f = vi.fn(async () => res(body, 200));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      }), JSON.stringify(body)).toEqual({ ok: false, code: "outcome_unknown", raw: body });
      checked++;
    }
    expect(checked).toBe(3);
  });

  // Fix round 1 (T3-I2). A 5xx can come from a proxy AFTER lila committed the
  // challenge, so it is not a definite refusal. Synthetic bodies: no 5xx was
  // measured.
  it("a 5xx on create is outcome_unknown, carrying the raw body", async () => {
    let checked = 0;
    for (const status of [500, 502, 503, 504]) {
      const body = `upstream ${status}`;
      const f = vi.fn(async () => res(body, status));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      }), String(status)).toEqual({ ok: false, code: "outcome_unknown", raw: body });
      checked++;
    }
    expect(checked).toBe(4);
  });

  // The 10s timeout fires while lila may still be creating; a network error
  // can land after the request was sent. Neither says nothing was created.
  it("a thrown fetch on create (network, or the timeout firing) is outcome_unknown", async () => {
    let checked = 0;
    for (const thrown of [
      new Error("socket hang up"),
      // What AbortSignal.timeout's abort surfaces as from fetch.
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]) {
      const f = vi.fn(async () => { throw thrown; });
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      }), thrown.name).toEqual({ ok: false, code: "outcome_unknown", raw: "" });
      checked++;
    }
    expect(checked).toBe(2);
  });

  // The other side of the split: a 4xx is lila REFUSING the request, so
  // nothing was created and the claim may be released. lila answers a failed
  // create with `BadRequest(jsonError(err))` (Challenge.scala apiCreate, e.g.
  // "No such user: <name>") — the body below is that shape, synthetic.
  it("a 4xx on create stays a DEFINITE code, never outcome_unknown", async () => {
    const cases: Array<[number, string, string]> = [
      [400, '{"error":"No such user: Ada"}', "unavailable"],
      [400, BAD_LIMIT, "unavailable"],
      [404, "", "unavailable"],
      [401, "", "unauthorized"],
      [403, "", "unauthorized"],
      [429, RATE_LIMITED, "rate_limited"],
    ];
    let checked = 0;
    for (const [status, body, code] of cases) {
      const f = vi.fn(async () => res(body, status));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      }), `${status} ${body}`).toEqual({ ok: false, code, raw: body });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("accept, resign, draw, abort — Black's token accepts; each call is one POST", () => {
  it.each([
    ["acceptChallenge", { blackToken: "lio_black", challengeId: "ch1" },
      "https://li.test/api/challenge/ch1/accept", "lio_black"],
    ["resignGame", { token: "lio_t", gameId: "g1" },
      "https://li.test/api/board/game/g1/resign", "lio_t"],
    ["abortGame", { token: "lio_t", gameId: "g1" },
      "https://li.test/api/board/game/g1/abort", "lio_t"],
  ] as const)("%s POSTs %s with its own token", async (name, arg, expectedUrl, expectedToken) => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    const client = api(f as unknown as typeof fetch) as unknown as
      Record<string, (a: unknown) => Promise<unknown>>;
    expect(await client[name]!(arg)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(expectedUrl);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${expectedToken}`);
  });

  it.each([[true, "yes"], [false, "no"]])(
    "offerOrAcceptDraw(accept: %s) posts /draw/%s",
    async (accept, segment) => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      expect(await api(f as unknown as typeof fetch).offerOrAcceptDraw({
        token: "lio_t", gameId: "g1", accept,
      })).toEqual({ ok: true });
      const [url] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://li.test/api/board/game/g1/draw/${segment}`);
    },
  );

  // M9: resigning after ONE move gave status=aborted winner=None; after two,
  // status=resign winner=black. The client does not know which it caused, so
  // it must not report one — the reconcile does (T11/T12).
  it("a successful resign reports ok only — never a winner", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    const out = await api(f as unknown as typeof fetch).resignGame({ token: "t", gameId: "g1" });
    expect(out).toEqual({ ok: true });
    expect(Object.keys(out)).toEqual(["ok"]);
  });

  it("a 400 on a control call carries the measured turn message through unchanged", async () => {
    const f = vi.fn(async () => res(NOT_YOUR_TURN, 400));
    expect(await api(f as unknown as typeof fetch).abortGame({ token: "t", gameId: "g1" }))
      .toEqual({ ok: false, code: "not_your_turn_or_over", raw: NOT_YOUR_TURN });
  });
});

const raw = (f: string) =>
  readFileSync(join(__dirname, "../__fixtures__/lichess", f), "utf8");

describe("exportGame — the reconcile read (M10, M11)", () => {
  it("reads status, moves, increment and BOTH clocks in ms from the real recorded body", async () => {
    const body = raw("export-live-clocks.json");
    const f = vi.fn(async () => res(body, 200));
    const snap = await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
    // Derived from the fixture itself, never retyped: clocks are centiseconds,
    // `clock.initial` is seconds, and 600 × 1000 === 60000 × 10 is the proof.
    // `movesSan: []` is because the spike requested `moves=false` (two plies
    // WERE played — `opening.ply: 2`); see the fixtures README. The SAN split
    // is covered by the TVSCksV1 case below.
    const recorded = JSON.parse(body) as {
      clocks: number[]; clock: { initial: number; increment: number };
    };
    expect(snap).toEqual({
      gameId: "QbFCQzuF",
      status: "started",
      winner: null,
      movesSan: [],
      whiteMs: recorded.clocks[0]! * 10,
      blackMs: recorded.clocks[1]! * 10,
      increment: recorded.clock.increment,
    });
    expect(snap!.whiteMs).toBe(recorded.clock.initial * 1000);
  });

  it("M10: a pending draw offer is INVISIBLE — the fixture has no such field to read", () => {
    const body = raw("export-live-clocks.json");
    // The claim is about an ABSENT field, so it is asserted against the raw
    // text: a trimmed fixture could not witness it.
    expect(body).not.toMatch(/draw/i);
    expect(JSON.parse(body).status).toBe("started");
  });

  it("splits the SAN move string, which is how the measured export reports moves", async () => {
    // spike-battery2.log §F, game TVSCksV1: `moves=e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Bc5`.
    const f = vi.fn(async () => res(JSON.stringify({
      id: "TVSCksV1", status: "resign", winner: "black",
      moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Bc5",
      clock: { initial: 600, increment: 0 },
    }), 200));
    const snap = await api(f as unknown as typeof fetch).exportGame("TVSCksV1");
    expect(snap!.movesSan).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O", "Bc5"]);
    expect(snap!.winner).toBe("black");
    // No `clocks` key at all: the export omits it on some games, and a null
    // is the only honest answer — T11 must not read 0ms as "flagged".
    expect(snap!.whiteMs).toBeNull();
    expect(snap!.blackMs).toBeNull();
  });

  // Added beyond the brief. `clocks` is one entry PER PLY, interleaved, first
  // entry for the colour that moved first — lila's `bothClockStates` is
  // `interleave(history(firstMover), history(other))`
  // (modules/core/src/main/game/data.scala, lichess-org/lila 7b53d2671, read
  // 2026-10-09). The recorded fixture has exactly two plies, so it cannot tell
  // "index 0 is White's CURRENT clock" from "index 0 is White's clock after
  // its FIRST move" — both read 60000. These bodies are SYNTHETIC, shaped by
  // that source rule (standard chess: White moves first, so even indices are
  // White's), and chosen so the right answer differs from clocks[0]/clocks[1].
  it("clocks is per ply: each side's clock is its LAST entry, not the first two", async () => {
    const cases: Array<[number[], number | null, number | null]> = [
      // 5 plies (W B W B W): White's latest is index 4, Black's index 3.
      [[18000, 18000, 17650, 17420, 17300], 173000, 174200],
      // 4 plies (W B W B): White's latest is index 2, Black's index 3.
      [[18000, 18000, 17650, 17420], 176500, 174200],
      // 1 ply: Black has no recorded state yet — null, never 0.
      [[18000], 180000, null],
      // The empty case: an array with nothing in it is no clock at all.
      [[], null, null],
    ];
    let checked = 0;
    for (const [clocks, whiteMs, blackMs] of cases) {
      const f = vi.fn(async () => res(JSON.stringify({
        id: "g", status: "started", moves: "", clocks, clock: { initial: 180, increment: 0 },
      }), 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("g");
      expect({ whiteMs: snap!.whiteMs, blackMs: snap!.blackMs }, JSON.stringify(clocks))
        .toEqual({ whiteMs, blackMs });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("requests clocks=true — a reconcile that cannot see the clocks cannot correct them", async () => {
    const f = vi.fn(async () => res(raw("export-live-clocks.json"), 200));
    await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
    const [url] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("clocks=true");
    expect(url).toBe("https://li.test/game/export/QbFCQzuF?clocks=true&pgnInJson=false");
  });

  it("404 is null — no such game yet, which is not an error", async () => {
    const f = vi.fn(async () => res("", 404));
    expect(await api(f as unknown as typeof fetch).exportGame("nope")).toBeNull();
  });

  it("sends NO authorization header — the export is public and needs no player's token", async () => {
    const f = vi.fn(async () => res(raw("export-live-clocks.json"), 200));
    await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  // Winner pass-through on representative rows. COMPLETENESS of the status
  // list is the sweep below, derived from the recorded OpenAPI enum; T12 owns
  // the mapping to our events, this only proves none is lost here.
  it.each([
    ["mate", "white"], ["resign", "black"], ["outoftime", "black"],
    ["draw", null], ["stalemate", null], ["aborted", null],
    ["timeout", "white"], ["noStart", "black"], ["unknownFinish", null],
    ["created", null], ["started", null],
  ] as const)("carries status %s through unchanged", async (status, winner) => {
    const f = vi.fn(async () => res(JSON.stringify({
      id: "g", status, ...(winner ? { winner } : {}), moves: "",
      clock: { initial: 180, increment: 0 },
    }), 200));
    const snap = await api(f as unknown as typeof fetch).exportGame("g");
    expect(snap!.status).toBe(status);
    expect(snap!.winner).toBe(winner);
  });

  it("a body with no id or no status is null, not a snapshot with undefined fields", async () => {
    let checked = 0;
    for (const body of [
      '{"status":"mate"}', '{"id":"g"}', "{}",
      // A status that is not a string at all is a malformed body, not a new
      // status: there is no name to show an organiser.
      '{"id":"g","status":30}', '{"id":"g","status":null}',
    ]) {
      const f = vi.fn(async () => res(body, 200));
      expect(await api(f as unknown as typeof fetch).exportGame("g"), body).toBeNull();
      checked++;
    }
    expect(checked).toBe(5);
  });

  // Fix round 1 (T3-I1). The expected list is READ from the recorded OpenAPI
  // schema (lichess-org/api doc/specs/schemas/GameStatusName.yaml at 59ebacb,
  // byte-identical copy in __fixtures__/lichess), never from our own type.
  // scalachess core/src/main/scala/Status.scala at 2ab0a40 declares the same
  // 14 cases. A parse that drops a line reds the length pin.
  const OPENAPI_STATUSES = (() => {
    const text = raw("openapi-GameStatusName.yaml");
    const list = text.slice(text.indexOf("enum:"));
    return [...list.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]!);
  })();

  it("the recorded OpenAPI enum parses to its 14 statuses", () => {
    expect(OPENAPI_STATUSES.length).toBeGreaterThan(0);
    expect(OPENAPI_STATUSES.length).toBe(14);
    expect(new Set(OPENAPI_STATUSES).size).toBe(OPENAPI_STATUSES.length);
  });

  it("our status list is EXACTLY the OpenAPI enum — nothing missing, nothing invented", () => {
    expect([...LICHESS_STATUSES].sort()).toEqual([...OPENAPI_STATUSES].sort());
  });

  it("every status Lichess declares is carried through as itself, never as unrecognised", async () => {
    let checked = 0;
    for (const status of OPENAPI_STATUSES) {
      const f = vi.fn(async () => res(JSON.stringify({
        id: "g", status, moves: "", clock: { initial: 180, increment: 0 },
      }), 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("g");
      expect(snap, status).not.toBeNull();
      expect(snap!.status, status).toBe(status);
      expect(snap, status).not.toHaveProperty("rawStatus");
      checked++;
    }
    expect(checked, "the status sweep checked nothing").toBe(OPENAPI_STATUSES.length);
    expect(checked).toBeGreaterThan(0);
  });

  // The ruling: an unrecognised status is an explicit outcome, not a silent
  // pass and not null (null means "no game yet / retry", which would loop a
  // reconcile forever on a game Lichess considers real). T12 routes it.
  it("a status Lichess has not declared is explicitly unrecognised, keeping the raw name", async () => {
    let checked = 0;
    for (const rawStatus of ["someFutureStatus", "Mate", ""]) {
      const f = vi.fn(async () => res(JSON.stringify({
        id: "g", status: rawStatus, winner: "white", moves: "e4 e5",
        clocks: [18000, 18000], clock: { initial: 180, increment: 2 },
      }), 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("g");
      expect(snap, JSON.stringify(rawStatus)).toEqual({
        gameId: "g", status: "unrecognised", rawStatus, winner: "white",
        movesSan: ["e4", "e5"], whiteMs: 180000, blackMs: 180000, increment: 2,
      });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("our 'unrecognised' marker cannot collide with a name Lichess declares", () => {
    expect(OPENAPI_STATUSES.length).toBeGreaterThan(0);
    expect(OPENAPI_STATUSES).not.toContain("unrecognised");
  });

  // Added beyond the brief, for the same invariant as the create case above:
  // a literal `null` body parses fine and then throws on `.id`.
  it("a 200 whose body is not a JSON object is null, never an uncaught throw", async () => {
    let checked = 0;
    for (const body of ["null", "<html>bad gateway</html>", "[]"]) {
      const f = vi.fn(async () => res(body, 200));
      expect(await api(f as unknown as typeof fetch).exportGame("g"), JSON.stringify(body)).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a 5xx is null, so a reconcile retries rather than writing a result from nothing", async () => {
    const f = vi.fn(async () => res("boom", 503));
    expect(await api(f as unknown as typeof fetch).exportGame("g")).toBeNull();
  });
});

describe("LICHESS_TIMEOUT_MS covers every call, and nothing streams (§4)", () => {
  it("each of the seven functions arms AbortSignal.timeout with the shared constant", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const f = vi.fn(async () => res('{"ok":true,"id":"ch1"}', 200));
    const client = api(f as unknown as typeof fetch);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["createChallengeToUser", () => client.createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0 })],
      ["acceptChallenge", () => client.acceptChallenge({ blackToken: "t", challengeId: "c" })],
      ["submitMove", () => client.submitMove({ token: "t", gameId: "g", uci: "e2e4" })],
      ["resignGame", () => client.resignGame({ token: "t", gameId: "g" })],
      ["offerOrAcceptDraw", () => client.offerOrAcceptDraw({ token: "t", gameId: "g", accept: true })],
      ["abortGame", () => client.abortGame({ token: "t", gameId: "g" })],
      ["exportGame", () => client.exportGame("g")],
    ];
    let checked = 0;
    for (const [name, run] of calls) {
      spy.mockClear();
      await run();
      expect(spy, `${name} did not arm a timeout`).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
      checked++;
    }
    // Anti-vacuity: the sweep must cover the whole surface, and zero is a
    // failure. If a function is added to the module, this count reds.
    expect(checked).toBe(7);
    expect(Object.keys(client).length).toBe(7);
    spy.mockRestore();
  });

  it("the constant is 10s AT ITS DEFAULT — a long read has no home here (§4)", () => {
    expect(LICHESS_TIMEOUT_MS).toBe(10_000);
  });

  it("no request asks Lichess to keep a connection open", async () => {
    const f = vi.fn(async () => res('{"ok":true,"id":"ch1"}', 200));
    const client = api(f as unknown as typeof fetch);
    await client.createChallengeToUser({
      whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0 });
    await client.exportGame("g");
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(url, url).not.toMatch(/stream|keepAlive/i);
      expect(String(init.body ?? ""), url).not.toMatch(/keepAliveStream/);
      expect(new Headers(init.headers).get("accept")).toBe("application/json");
      expect(new Headers(init.headers).get("accept")).not.toBe("application/x-ndjson");
    }
    expect(f.mock.calls.length).toBe(2);
  });
});
