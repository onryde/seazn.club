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

// T9 fix round 1 (I2): the two lookups a stale "create sent" claim runs before
// it may re-create, and the cancel that closes a stray game. MEASURED
// 2026-10-10 with the programme's spike tokens (scratchpad
// t9/lookup-spike.log), except where a comment says "spec": a token carrying
// exactly board:play + challenge:write (no challenge:read — the grant before
// spec §3.1's 2026-10-10 amendment). OUT_CHALLENGE's shape is from the API
// spec; measurement owed (T17).
const MISSING_CHALLENGE_READ = '{"error":"Missing scope: challenge:read"}'; // measured, HTTP 403
/** One measured nowPlaying entry: White's view of a game created by White's
 *  challenge and accepted by Black, no move yet. gameId IS the challenge id. */
const PLAYING_ENTRY = {
  fullId: "Q0DxE3WcLNH4", gameId: "Q0DxE3Wc",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  color: "white", lastMove: "", source: "friend", status: { id: 20, name: "started" },
  variant: { key: "standard", name: "Standard" }, speed: "blitz", perf: "blitz", rated: false,
  hasMoved: false, opponent: { id: "ashokhein", username: "ashokhein", rating: 1699 },
  isMyTurn: true, secondsLeft: 300, rating: 1500,
};
/** SPEC, not measured (the measured token cannot read this list): the
 *  lichess-org/api challengeList example's shape, as an outgoing challenge. */
const OUT_CHALLENGE = {
  id: "C8fNpisS", url: "https://lichess.org/C8fNpisS", status: "created",
  challenger: { id: "bobby", name: "Bobby", rating: 1657 },
  destUser: { id: "mary", name: "Mary", rating: 1079 },
  variant: { key: "standard", name: "Standard", short: "Std" }, rated: false, speed: "blitz",
  timeControl: { type: "clock", limit: 300, increment: 3, show: "5+3" },
  color: "white", finalColor: "white", perf: { icon: "", name: "Blitz" }, direction: "out",
};

describe("recovery lookups — White's outgoing challenges and ongoing games (T9 I2)", () => {
  it("listOutgoingChallenges GETs /api/challenge with the token as a bearer", async () => {
    const f = vi.fn(async () => res(JSON.stringify({ in: [], out: [OUT_CHALLENGE] }), 200));
    expect(await api(f as unknown as typeof fetch).listOutgoingChallenges("lio_w")).toEqual({
      // N1 (fix round 2): the fields recovery matches on are kept, as the
      // spec declares them; the shape is the spec's — measurement owed (T17).
      ok: true, challenges: [{ id: "C8fNpisS", challengerId: "bobby", destUserId: "mary", status: "created", rated: false, variantKey: "standard", timeControl: { type: "clock", limit: 300, increment: 3 }, color: "white" }],
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/challenge");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_w");
  });

  it("MEASURED: a token without challenge:read is refused the list — 403 'Missing scope: challenge:read' is unauthorized, never an empty list", async () => {
    const f = vi.fn(async () => res(MISSING_CHALLENGE_READ, 403));
    expect(await api(f as unknown as typeof fetch).listOutgoingChallenges("lio_w")).toEqual({
      ok: false, code: "unauthorized", raw: MISSING_CHALLENGE_READ,
    });
  });

  it("listOutgoingChallenges: any body it cannot fully read is a failure, never 'nothing found' — swept and counted", async () => {
    const bad = [
      "not json", "null", "[]", "{}", '{"in":[]}', '{"out":{}}',
      JSON.stringify({ out: [{ ...OUT_CHALLENGE, id: 7 }] }),
      JSON.stringify({ out: [{ ...OUT_CHALLENGE, id: "" }] }),
      JSON.stringify({ out: [{ ...OUT_CHALLENGE, status: undefined }] }),
      JSON.stringify({ out: [{ ...OUT_CHALLENGE, destUser: { name: "Mary" } }] }),
      JSON.stringify({ out: [null] }),
    ];
    let checked = 0;
    for (const body of bad) {
      const f = vi.fn(async () => res(body, 200));
      expect(await api(f as unknown as typeof fetch).listOutgoingChallenges("t"), body)
        .toMatchObject({ ok: false, code: "unavailable" });
      checked += 1;
    }
    expect(checked).toBe(11);
  });

  it("listOutgoingChallenges: an open challenge (destUser null, spec) is read, with no destination", async () => {
    const f = vi.fn(async () => res(JSON.stringify({ out: [{ ...OUT_CHALLENGE, destUser: null }] }), 200));
    expect(await api(f as unknown as typeof fetch).listOutgoingChallenges("t")).toEqual({
      ok: true, challenges: [{ id: "C8fNpisS", challengerId: "bobby", destUserId: null, status: "created", rated: false, variantKey: "standard", timeControl: { type: "clock", limit: 300, increment: 3 }, color: "white" }],
    });
  });

  it("listOutgoingChallenges: a match field it cannot read is NULL — never guessed, never a list failure — swept and counted", async () => {
    // Identity fields (id, status, destUser) still fail the whole list (above);
    // the fields a recovery MATCHES on are the matcher's to judge, so an
    // unreadable one is null and the matcher holds the fixture (N1).
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["rated absent", { rated: undefined }, { rated: null }],
      ["rated a string", { rated: "false" }, { rated: null }],
      ["variant absent", { variant: undefined }, { variantKey: null }],
      ["variant with no key", { variant: { name: "Standard" } }, { variantKey: null }],
      ["timeControl absent", { timeControl: undefined }, { timeControl: null }],
      ["correspondence (declared, lila JsonView)", { timeControl: { type: "correspondence", daysPerTurn: 3 } },
        { timeControl: { type: "correspondence", limit: null, increment: null } }],
      ["clock with no limit", { timeControl: { type: "clock", increment: 3 } },
        { timeControl: { type: "clock", limit: null, increment: 3 } }],
      ["color absent", { color: undefined }, { color: null }],
      // L1 (T17): the challenger is a match field too — White's id, as the
      // controller's ruling names it.
      ["challenger absent", { challenger: undefined }, { challengerId: null }],
      ["challenger with no id", { challenger: { name: "Bobby" } }, { challengerId: null }],
      ["challenger null", { challenger: null }, { challengerId: null }],
    ];
    let checked = 0;
    for (const [name, over, want] of cases) {
      const f = vi.fn(async () => res(JSON.stringify({ out: [{ ...OUT_CHALLENGE, ...over }] }), 200));
      const got = await api(f as unknown as typeof fetch).listOutgoingChallenges("t");
      expect(got, name).toMatchObject({ ok: true });
      expect(got.ok && got.challenges[0], name).toMatchObject({ id: "C8fNpisS", ...want });
      checked += 1;
    }
    expect(checked).toBe(11);
  });

  it("MEASURED (T17 live probe, 2026-10-13): the recorded GET /api/challenge bodies parse through the real reader — out[] read, in[] ignored, no createdAt", async () => {
    // Expected values are read from the RECORDED body (challenge-list-white.json,
    // sanitised ids), never from the reader: the entry's own fields.
    const white = raw("challenge-list-white.json");
    type LiveEntry = {
      id: string; status: string; rated: boolean; color: string;
      challenger: { id: string }; destUser: { id: string }; variant: { key: string };
      timeControl: { type: string; limit: number; increment: number };
    };
    const entry = (JSON.parse(white) as { out: LiveEntry[] }).out[0]!;
    expect(entry, "premise: the live entry carries no createdAt").not.toHaveProperty("createdAt");
    const f = vi.fn(async () => res(white, 200));
    expect(await api(f as unknown as typeof fetch).listOutgoingChallenges("lio_w")).toEqual({
      ok: true,
      challenges: [{
        id: entry.id, challengerId: entry.challenger.id, destUserId: entry.destUser.id, status: entry.status,
        rated: entry.rated, variantKey: entry.variant.key,
        timeControl: { type: entry.timeControl.type, limit: entry.timeControl.limit, increment: entry.timeControl.increment },
        color: entry.color,
      }],
    });
    // Black's list carries the same challenge in in[] only: it is not an
    // outgoing challenge of Black's, so the reader returns nothing.
    const g = vi.fn(async () => res(raw("challenge-list-black.json"), 200));
    expect(await api(g as unknown as typeof fetch).listOutgoingChallenges("lio_b")).toEqual({ ok: true, challenges: [] });
  });

  it("listOngoingGames GETs /api/account/playing?nb=50 and reads the MEASURED entry", async () => {
    const f = vi.fn(async () => res(JSON.stringify({ nowPlaying: [PLAYING_ENTRY], nbMyTurn: 1 }), 200));
    expect(await api(f as unknown as typeof fetch).listOngoingGames("lio_w")).toEqual({
      ok: true, complete: true, games: [{ gameId: "Q0DxE3Wc", color: "white", opponentId: "ashokhein" }],
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/account/playing?nb=50");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_w");
  });

  it("listOngoingGames: a FULL page (50, the API's maximum) cannot prove absence — complete is false", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ ...PLAYING_ENTRY, gameId: `g${String(i).padStart(7, "0")}` }));
    const f = vi.fn(async () => res(JSON.stringify({ nowPlaying: page, nbMyTurn: 0 }), 200));
    const out = await api(f as unknown as typeof fetch).listOngoingGames("t");
    expect(out).toMatchObject({ ok: true, complete: false });
    const short = vi.fn(async () => res(JSON.stringify({ nowPlaying: page.slice(1), nbMyTurn: 0 }), 200));
    expect(await api(short as unknown as typeof fetch).listOngoingGames("t")).toMatchObject({ ok: true, complete: true });
  });

  it("listOngoingGames: an anonymous or AI opponent (id null, spec) is read with no opponent id", async () => {
    const anon = { ...PLAYING_ENTRY, opponent: { id: null, username: "Anonymous" } };
    const f = vi.fn(async () => res(JSON.stringify({ nowPlaying: [anon], nbMyTurn: 0 }), 200));
    expect(await api(f as unknown as typeof fetch).listOngoingGames("t")).toMatchObject({
      ok: true, games: [{ gameId: "Q0DxE3Wc", color: "white", opponentId: null }],
    });
  });

  it("listOngoingGames: any body it cannot fully read, or a refusal, is a failure — swept and counted", async () => {
    const cases: [string, number, string][] = [
      ["not json", 200, "unavailable"], ["null", 200, "unavailable"], ["{}", 200, "unavailable"],
      ['{"nowPlaying":{}}', 200, "unavailable"],
      [JSON.stringify({ nowPlaying: [{ ...PLAYING_ENTRY, gameId: 1 }] }), 200, "unavailable"],
      [JSON.stringify({ nowPlaying: [{ ...PLAYING_ENTRY, color: "red" }] }), 200, "unavailable"],
      [JSON.stringify({ nowPlaying: [{ ...PLAYING_ENTRY, opponent: undefined }] }), 200, "unavailable"],
      [JSON.stringify({ nowPlaying: [{ ...PLAYING_ENTRY, opponent: { username: "x" } }] }), 200, "unavailable"],
      ["nope", 401, "unauthorized"], ["boom", 503, "unavailable"],
    ];
    let checked = 0;
    for (const [body, status, code] of cases) {
      const f = vi.fn(async () => res(body, status));
      expect(await api(f as unknown as typeof fetch).listOngoingGames("t"), `${status} ${body}`)
        .toMatchObject({ ok: false, code });
      checked += 1;
    }
    const thrown = vi.fn(async () => { throw new Error("socket hang up"); });
    expect(await api(thrown as unknown as typeof fetch).listOngoingGames("t")).toMatchObject({ ok: false, code: "unavailable" });
    checked += 1;
    expect(checked).toBe(11);
  });

  it("cancelChallenge POSTs /api/challenge/{id}/cancel with White's token (MEASURED: aborts an accepted, unplayed game, 200 {ok:true})", async () => {
    const f = vi.fn(async () => res('{"ok":true}', 200));
    expect(await api(f as unknown as typeof fetch).cancelChallenge({ token: "lio_w", challengeId: "Q0DxE3Wc" }))
      .toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/challenge/Q0DxE3Wc/cancel");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_w");
    const gone = vi.fn(async () => res('{"error":"Not found"}', 404));
    expect(await api(gone as unknown as typeof fetch).cancelChallenge({ token: "t", challengeId: "x" }))
      .toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("exportGameMeta — the static facts a recovery verifies a candidate on (T9 N1)", () => {
  // MEASURED: export-live-clocks.json is the byte-for-byte body of
  // GET /game/export/QbFCQzuF?moves=false (Accept: application/json, no
  // Authorization) from spike-battery2.log — `clock.initial` is SECONDS
  // (600 beside centisecond `clocks`), `variant` a plain string, `createdAt`
  // epoch ms.
  const MEASURED = raw("export-live-clocks.json");

  it("GETs the export with moves=false and NO token, and reads the measured body", async () => {
    const f = vi.fn(async () => res(MEASURED, 200));
    expect(await api(f as unknown as typeof fetch).exportGameMeta("QbFCQzuF")).toEqual({
      ok: true,
      meta: {
        gameId: "QbFCQzuF", rated: false, variant: "standard",
        clockInitialSeconds: 600, clockIncrementSeconds: 5, createdAtMs: 1791541734490,
      },
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/game/export/QbFCQzuF?moves=false");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).has("authorization"), "the export is public").toBe(false);
  });

  it("a refusal keeps its class: 429 is rate_limited, 404 unavailable — never a meta", async () => {
    let checked = 0;
    for (const [status, code] of [[429, "rate_limited"], [404, "unavailable"], [503, "unavailable"]] as const) {
      const f = vi.fn(async () => res("{}", status));
      expect(await api(f as unknown as typeof fetch).exportGameMeta("g"), String(status)).toMatchObject({ ok: false, code });
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a body it cannot read as THIS game is unavailable — swept and counted", async () => {
    const m = JSON.parse(MEASURED) as Record<string, unknown>;
    const bad = ["not json", "null", "[]", "{}", JSON.stringify({ ...m, id: 7 }), JSON.stringify({ ...m, id: "OtherGm1" })];
    let checked = 0;
    for (const body of bad) {
      const f = vi.fn(async () => res(body, 200));
      expect(await api(f as unknown as typeof fetch).exportGameMeta("QbFCQzuF"), body)
        .toMatchObject({ ok: false, code: "unavailable" });
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("a fact it cannot read is NULL, never a default — swept and counted", async () => {
    const m = JSON.parse(MEASURED) as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["rated absent", { rated: undefined }, { rated: null }],
      ["rated a string", { rated: "false" }, { rated: null }],
      ["variant absent", { variant: undefined }, { variant: null }],
      ["variant an object", { variant: { key: "standard" } }, { variant: null }],
      ["no clock (a correspondence game)", { clock: undefined },
        { clockInitialSeconds: null, clockIncrementSeconds: null }],
      ["clock with no increment", { clock: { initial: 600 } }, { clockInitialSeconds: 600, clockIncrementSeconds: null }],
      ["createdAt absent", { createdAt: undefined }, { createdAtMs: null }],
      ["createdAt a string", { createdAt: "1791541734490" }, { createdAtMs: null }],
    ];
    let checked = 0;
    for (const [name, over, want] of cases) {
      const f = vi.fn(async () => res(JSON.stringify({ ...m, ...over }), 200));
      const got = await api(f as unknown as typeof fetch).exportGameMeta("QbFCQzuF");
      expect(got, name).toMatchObject({ ok: true });
      expect(got.ok && got.meta, name).toMatchObject({ gameId: "QbFCQzuF", ...want });
      checked += 1;
    }
    expect(checked).toBe(8);
  });
});

describe("LICHESS_TIMEOUT_MS covers every call, and nothing stays open (§4)", () => {
  it("each of the twelve functions arms AbortSignal.timeout with the shared constant", async () => {
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
      ["listOutgoingChallenges", () => client.listOutgoingChallenges("t")],
      ["listOngoingGames", () => client.listOngoingGames("t")],
      ["cancelChallenge", () => client.cancelChallenge({ token: "t", challengeId: "c" })],
      ["exportGameMeta", () => client.exportGameMeta("g")],
      // T11: the one stream read — its first line or the timeout, whichever
      // comes first, and then it closes (spec §3.5 amended 5903962d4).
      ["readGameStream", () => client.readGameStream({ token: "t", gameId: "g" })],
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
    expect(checked).toBe(12);
    expect(Object.keys(client).length).toBe(12);
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

// ---------------------------------------------------------------------------
// readGameStream — the reconcile read (spec §3.5, amended 5903962d4). One GET
// of the Board API stream with a PLAYER's token: take the first line
// (`gameFull`), close. Every expected value is read out of the RECORDED lines
// (game Rc11Game, recorded 2026-10-11 with both test accounts and sanitised —
// see the fixtures README), never typed in.

type RecordedGameFull = {
  id: string;
  white: { id: string }; black: { id: string };
  state: { moves: string; wtime: number; btime: number; winc: number; status: string; winner?: string };
};
const recordedLine = (f: string) => raw(f);
const parsedLine = (f: string) => JSON.parse(raw(f)) as RecordedGameFull;

/** A body that yields `chunks` and then stays OPEN, as a live Lichess stream
 *  does after its first line. `cancelled()` reports whether we closed it. */
function openBody(chunks: string[]) {
  let cancelled = false;
  let i = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(enc.encode(chunks[i++]!));
        return;
      }
      return new Promise<void>(() => {}); // never ends on its own
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}
const streamRes = (b: ReadableStream<Uint8Array>) => new Response(b, { status: 200 });

describe("readGameStream — the reconcile read: the board stream's first line (§3.5)", () => {
  it("reads the recorded mid-game line exactly: every ply as UCI, both clocks, the increment, no winner", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson");
    const rec = parsedLine("gamefull-mid-white.ndjson");
    const f = vi.fn(async () => res(line, 200));
    const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: rec.id });
    expect(out).toEqual({
      ok: true,
      game: {
        gameId: rec.id,
        whiteId: rec.white.id,
        blackId: rec.black.id,
        movesUci: rec.state.moves.split(" "),
        whiteMs: rec.state.wtime,
        blackMs: rec.state.btime,
        incrementMs: rec.state.winc,
        status: rec.state.status,
        winner: null,
        drawOffer: { white: false, black: false },
      },
    });
    // M16, re-measured 2026-10-11: the stream is exact where the export stalls.
    expect(rec.state.moves.split(" ").length, "premise: the recording is 8 plies in").toBe(8);
  });

  it("Black's token at the same instant reads the same line (both were recorded)", async () => {
    const reads = [];
    for (const name of ["gamefull-mid-white.ndjson", "gamefull-mid-black.ndjson"]) {
      const f = vi.fn(async () => res(recordedLine(name), 200));
      reads.push(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game" }));
    }
    expect(reads.length).toBe(2);
    const [w, b] = reads as [{ ok: true; game: { movesUci: string[]; blackMs: number } }, typeof reads[0]];
    expect(b).toMatchObject({ ok: true, game: { movesUci: w.game.movesUci, blackMs: w.game.blackMs } });
  });

  it("GETs the game's board stream with the PLAYER's token as a bearer, asking for ndjson", async () => {
    const f = vi.fn(async () => res(recordedLine("gamefull-mid-white.ndjson"), 200));
    await api(f as unknown as typeof fetch).readGameStream({ token: "lio_player", gameId: "Rc11Game" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/board/game/stream/Rc11Game");
    expect(init.method).toBe("GET");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer lio_player");
    expect(h.get("accept")).toBe("application/x-ndjson");
    expect(init.signal, "bounded by a signal").toBeInstanceOf(AbortSignal);
  });

  it("takes the FIRST line and CLOSES the stream — it never waits for the next event (§4: nothing long-lived)", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson");
    const next = '{"type":"gameState","moves":"e2e4","wtime":1,"btime":1,"winc":0,"binc":0,"status":"started"}\n';
    const b = openBody([line, next]);
    const f = vi.fn(async () => streamRes(b.body));
    const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game" });
    expect(out).toMatchObject({ ok: true, game: { movesUci: parsedLine("gamefull-mid-white.ndjson").state.moves.split(" ") } });
    expect(b.cancelled(), "the stream was closed after its first line").toBe(true);
  });

  it("skips keep-alive blank lines and reassembles a line split across chunks", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson");
    const third = Math.floor(line.length / 3);
    const b = openBody(["\n", "\n", line.slice(0, third), line.slice(third, 2 * third), line.slice(2 * third)]);
    const f = vi.fn(async () => streamRes(b.body));
    const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game" });
    expect(out).toMatchObject({ ok: true, game: { gameId: parsedLine("gamefull-mid-white.ndjson").id } });
    expect(b.cancelled()).toBe(true);
  });

  it("the recorded flag pair: a clock at zero still `started`, then `outoftime` with the winner on the next read", async () => {
    const one = parsedLine("gamefull-expired-1.ndjson");
    const two = parsedLine("gamefull-expired-2.ndjson");
    const read = async (name: string) =>
      api(vi.fn(async () => res(recordedLine(name), 200)) as unknown as typeof fetch)
        .readGameStream({ token: "t", gameId: "Rc11Game" });
    expect(await read("gamefull-expired-1.ndjson")).toMatchObject({
      ok: true, game: { status: one.state.status, whiteMs: one.state.wtime, winner: null },
    });
    expect(one.state.status, "premise: expired-1 is still started").toBe("started");
    expect(one.state.wtime, "premise: …with White's clock at zero").toBe(0);
    expect(await read("gamefull-expired-2.ndjson")).toMatchObject({
      ok: true, game: { status: two.state.status, winner: two.state.winner },
    });
    expect(two.state.status, "premise: expired-2 settled it").toBe("outoftime");
  });

  // T17B fix 2, D11 (lila ad760137c, read 2026-10-14 — source, NOT measured): an OPEN board stream's CheckOnline
  // tick, 7 s after it opens, publishes QuietFlagCheck, which flags a side to move that is out of time; the stream
  // then pushes the final `gameState` (FinishGame → onGameOver → pushState) and closes (GameStateStream.scala:118-139,
  // RoundAsyncActor.scala:252-254). A read that closes at the first line never reaches that tick — measured live:
  // game x0JKlePc sat at `started`, White at 0, through every such read for 7 minutes. So the settling read holds
  // the stream open and takes the state lines that follow, until one is final or the hold runs out.
  describe("with holdMs — the settling read (T17B fix 2, D11)", () => {
    const fullLine = recordedLine("gamefull-expired-1.ndjson"); // started, White at 0
    const settled = parsedLine("gamefull-expired-2.ndjson").state; // outoftime, winner black
    const stateLine = (st: Record<string, unknown>) => JSON.stringify({ type: "gameState", ...st }) + "\n";

    it("holds the stream past the first line and takes the FINAL state Lichess pushes on it — then closes", async () => {
      const b = openBody([fullLine + "\n", stateLine(settled)]);
      const f = vi.fn(async () => streamRes(b.body));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", holdMs: 5_000 });
      const first = parsedLine("gamefull-expired-1.ndjson");
      expect(out).toEqual({
        ok: true,
        game: {
          gameId: first.id,
          whiteId: first.white.id,
          blackId: first.black.id,
          movesUci: settled.moves.split(" "),
          whiteMs: settled.wtime,
          blackMs: settled.btime,
          incrementMs: settled.winc,
          status: settled.status,
          winner: settled.winner,
          drawOffer: { white: false, black: false },
        },
      });
      expect(settled.status, "premise: the pushed state is final").toBe("outoftime");
      expect(b.cancelled(), "closed once the final state is in").toBe(true);
    });

    it("no final state within the hold: the latest state read, the stream closed when the hold runs out — bounded", async () => {
      const b = openBody([fullLine + "\n"]);
      const f = vi.fn(async () => streamRes(b.body));
      const t0 = Date.now();
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", holdMs: 120 });
      const took = Date.now() - t0;
      expect(out).toMatchObject({ ok: true, game: { status: "started", whiteMs: 0 } });
      expect(took, "it held the stream").toBeGreaterThanOrEqual(100);
      expect(took, "…and no longer than the hold").toBeLessThan(2_000);
      expect(b.cancelled()).toBe(true);
    });

    it("takes every state line in order — a later non-final state (a draw offer) is merged; lines of another kind are skipped", async () => {
      const first = parsedLine("gamefull-expired-1.ndjson").state;
      const b = openBody([
        fullLine + "\n",
        JSON.stringify({ type: "chatLine", username: "x", text: "hi", room: "player" }) + "\n",
        JSON.stringify({ type: "opponentGone", gone: true, claimWinInSeconds: 30 }) + "\n",
        stateLine({ ...first, bdraw: true }),
      ]);
      const f = vi.fn(async () => streamRes(b.body));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", holdMs: 120 });
      expect(out).toMatchObject({ ok: true, game: { status: "started", drawOffer: { white: false, black: true } } });
    });

    it("a state line it cannot read ends the hold on the last good state — never a guessed game", async () => {
      const b = openBody([fullLine + "\n", stateLine({ moves: "e2e4 zz", wtime: 0, btime: 1, winc: 0, binc: 0, status: "outoftime" })]);
      const f = vi.fn(async () => streamRes(b.body));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", holdMs: 5_000 });
      expect(out).toMatchObject({ ok: true, game: { status: "started", winner: null } });
      expect(b.cancelled()).toBe(true);
    });

    it("the stream ending on its own ends the hold at once (Lichess closes a finished game's stream)", async () => {
      const f = vi.fn(async () => res(fullLine + "\n" + stateLine(settled), 200));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", holdMs: 5_000 });
      expect(out).toMatchObject({ ok: true, game: { status: "outoftime", winner: "black" } });
    });

    it("the empty case: no holdMs (or 0) is the first-line read, closed at once — a second line is never waited for", async () => {
      let checked = 0;
      for (const holdMs of [undefined, 0]) {
        const b = openBody([fullLine + "\n", stateLine(settled)]);
        const f = vi.fn(async () => streamRes(b.body));
        const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game", ...(holdMs === undefined ? {} : { holdMs }) });
        expect(out, String(holdMs)).toMatchObject({ ok: true, game: { status: "started" } });
        expect(b.cancelled()).toBe(true);
        checked++;
      }
      expect(checked).toBe(2);
    });
  });

  it("a standing draw offer is read from wdraw/bdraw; an absent key is no offer", async () => {
    // lila BotJsonView.scala (46d24871f) `.add("wdraw" -> isOfferingDraw)`, and
    // scalalib's JsObject `add(key, Boolean)` writes the key ONLY when true —
    // source, not measured: the recording made no offer, so its line has no
    // such key (asserted on the raw text). The offer case is synthetic.
    const line = recordedLine("gamefull-mid-white.ndjson");
    expect(line).not.toMatch(/draw/);
    const withOffer = (key: "wdraw" | "bdraw") =>
      line.replace('"status":"started"', `"status":"started","${key}":true`);
    let checked = 0;
    for (const [body, expected] of [
      [line, { white: false, black: false }],
      [withOffer("wdraw"), { white: true, black: false }],
      [withOffer("bdraw"), { white: false, black: true }],
    ] as const) {
      const f = vi.fn(async () => res(body, 200));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "Rc11Game" });
      expect(out).toMatchObject({ ok: true, game: { drawOffer: expected } });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it.each([
    [401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"],
    [404, "unavailable"], [500, "unavailable"], [503, "unavailable"],
  ])("HTTP %i is %s — a refusal is never a game", async (status, code) => {
    const f = vi.fn(async () => res('{"error":"x"}', status));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toEqual({ ok: false, code, raw: '{"error":"x"}' });
  });

  it("a thrown fetch (network, or the signal firing) is unavailable, never an uncaught throw", async () => {
    const f = vi.fn(async () => { throw new Error("socket hang up"); });
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: false, code: "unavailable" });
  });

  it("a stream whose first line never comes is abandoned when the timeout fires, and closed", async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const b = openBody(["\n"]);
      const f = vi.fn(async () => streamRes(b.body));
      const pending = api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" });
      await new Promise((r) => setTimeout(r, 20));
      timeout.abort();
      expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
      expect(b.cancelled(), "closed on the timeout").toBe(true);
      expect(spy).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it("every line that is not a readable gameFull is unavailable — never a guessed game", async () => {
    const good = parsedLine("gamefull-mid-white.ndjson") as unknown as Record<string, unknown> & {
      state: Record<string, unknown>;
    };
    const edit = (f: (g: typeof good) => void) => {
      const g = structuredClone(good);
      f(g);
      return `${JSON.stringify(g)}\n`;
    };
    const bad: Array<[string, string]> = [
      ["not JSON", "<html>oops</html>\n"],
      ["a literal null", "null\n"],
      ["first line is a gameState, not gameFull", edit((g) => { g.type = "gameState"; })],
      ["no id", edit((g) => { delete g.id; })],
      ["no state", edit((g) => { delete (g as Record<string, unknown>).state; })],
      ["moves not a string", edit((g) => { g.state.moves = ["e2e4"]; })],
      ["no status", edit((g) => { delete g.state.status; })],
      ["no wtime", edit((g) => { delete g.state.wtime; })],
      ["a negative btime", edit((g) => { g.state.btime = -1; })],
      ["no winc", edit((g) => { delete g.state.winc; })],
      // M5's class: a string that is not UCI must never reach our ledger.
      ["a move that is not UCI", edit((g) => { g.state.moves = "e2e4 O-O"; })],
      ["an empty body", ""],
    ];
    let checked = 0;
    for (const [label, body] of bad) {
      const f = vi.fn(async () => res(body, 200));
      const out = await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" });
      expect(out, label).toMatchObject({ ok: false, code: "unavailable" });
      checked++;
    }
    expect(checked).toBe(bad.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a status Lichess has not declared comes back `unrecognised` with Lichess's own word", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson").replace('"status":"started"', '"status":"brandNew"');
    const f = vi.fn(async () => res(line, 200));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: true, game: { status: "unrecognised", rawStatus: "brandNew" } });
  });

  it("a player with no id (an anonymous or AI seat) reads as null, never as the empty string", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson").replace(/"white":\{"id":"[^"]*",/, '"white":{');
    const f = vi.fn(async () => res(line, 200));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: true, game: { whiteId: null, blackId: parsedLine("gamefull-mid-white.ndjson").black.id } });
  });

  it("a last line with no trailing newline is still read (a finished game's stream closes after it)", async () => {
    const line = recordedLine("gamefull-expired-2.ndjson").trimEnd();
    expect(line.endsWith("\n"), "premise: no newline left").toBe(false);
    const f = vi.fn(async () => res(line, 200));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: true, game: { status: parsedLine("gamefull-expired-2.ndjson").state.status } });
  });

  it("a first line that never ends is refused at the cap and the stream closed — not buffered until the timeout", async () => {
    const chunk = "x".repeat(16 * 1024);
    // Newline-free, 1 MiB before it ends — a recorded gameFull line is under
    // 1 KB, so a read that is still buffering at 128 KiB has no cap. (The
    // body ends at all only so a capless read fails here instead of spinning
    // in microtasks where no timer — not even the test's — can fire.)
    const LIMIT = 64;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++pulls > LIMIT) return c.close();
        c.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() { cancelled = true; },
    });
    const f = vi.fn(async () => streamRes(body));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: false, code: "unavailable" });
    expect(cancelled).toBe(true);
    expect(pulls, "chunks pulled before the read gave up").toBeLessThanOrEqual(8);
  });

  it("an empty move string (no ply yet) is an empty list", async () => {
    const line = recordedLine("gamefull-mid-white.ndjson").replace(/"moves":"[^"]*"/, '"moves":""');
    const f = vi.fn(async () => res(line, 200));
    expect(await api(f as unknown as typeof fetch).readGameStream({ token: "t", gameId: "g" }))
      .toMatchObject({ ok: true, game: { movesUci: [] } });
  });
});
