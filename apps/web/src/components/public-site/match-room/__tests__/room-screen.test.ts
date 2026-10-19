// T14 — which screen the room shows. Expected screens come from the owner's
// canvas (States board, 2026-10-11: cards 1–8, check-in, live, game over)
// and preflight's refusal list, never from room-screen.ts. The empty case
// first: an open window with nothing happened yet is the check-in.
import { describe, expect, it } from "vitest";
import { cameraEnds, roomScreen, seatRefusalScreen } from "../room-screen";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import type { RoomGame, RoomSnapshot, SeatRefusal } from "../room-snapshot";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const GAME: RoomGame = {
  gameId: "g1",
  moves: [],
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lastMove: null,
  turn: "white",
  whiteMs: 600_000,
  blackMs: 600_000,
  clockAsOf: null,
  clockRunning: false,
  drawOfferBy: null,
  over: false,
};
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: null,
    opensAt: null,
    deadline: null,
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Ada Okonkwo", checkedIn: false },
    opponent: { colour: "black", name: "Bo Lind", checkedIn: false },
    cameraPolicy: "off",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
    ...over,
  };
}
const st = (over: Partial<RoomSnapshot> = {}, patch: Partial<RoomState> = {}): RoomState => ({
  ...initialRoomState(snap(over), T0),
  ...patch,
});
const refused = (reason: SeatRefusal) => ({ seated: false as const, reason, participant: null });

describe("roomScreen", () => {
  it("the empty case: an open window, no seat asked, no game ⇒ the check-in", () => {
    expect(roomScreen(st())).toEqual({ kind: "checkin" });
  });

  it("checked in and waiting for the opponent stays on the check-in (its done state)", () => {
    expect(roomScreen(st({ you: { colour: "white", name: "A", checkedIn: true } }, { seat: { seated: true, participant: null } }))).toEqual({
      kind: "checkin",
    });
  });

  it("the window: not opened ⇒ card 1; before (stamped, this board's batch not yet open) ⇒ the batch-wait card; closed with no game ⇒ card 6; held with no game ⇒ card 6", () => {
    expect(roomScreen(st({ phase: "not_opened" })).kind).toBe("notOpened");
    // Spec §6.1 (1): `before` is a stamped round whose board opens later. Card 1's words ("your organiser will open it")
    // would be false there, so it is its own screen - and the unstamped round keeps card 1 (the pair).
    expect(roomScreen(st({ phase: "before" })).kind).toBe("batchWait");
    expect(roomScreen(st({ phase: "closed" })).kind).toBe("closed");
    expect(roomScreen(st({ held: true })).kind).toBe("closed");
  });

  // T17B fix 2, D10 (owner-reported live): the organiser closed the board before any game (a No result, then voided)
  // — no game will ever come, so the room says the board is closed, never "setting up". Precedence from the ruling:
  // a result or a game seen over still outranks it, and a re-pair in progress shows its own card.
  it("D10: a board the organiser closed ⇒ its own closed card — over everything that would say 'wait' or 'check in' (counted); a result, a game seen over and a re-pair outrank it", () => {
    const keeps: [string, RoomState][] = [
      ["alone", st({ boardClosed: true })],
      ["a stale 'being created' beside it", st({ boardClosed: true, creation: { state: "creating" } })],
      ["both checked in", st({ boardClosed: true, you: { colour: "white", name: "A", checkedIn: true }, opponent: { colour: "black", name: "B", checkedIn: true } })],
      ["the window closed", st({ boardClosed: true, phase: "closed" })],
      ["a stale camera refusal", st({ boardClosed: true }, { seat: refused("camera_required") })],
      ["a stale seat", st({ boardClosed: true }, { seat: { seated: true, participant: null } })],
    ];
    let checked = 0;
    for (const [why, s] of keeps) {
      expect(roomScreen(s), why).toEqual({ kind: "boardClosed" });
      checked++;
    }
    expect(checked).toBe(keeps.length);
    expect(roomScreen(st({ boardClosed: true, result: { outcome: "no_result", method: null, score: "" } })).kind).toBe("over");
    expect(roomScreen(st({ boardClosed: true, game: { ...GAME, over: true } })).kind).toBe("over");
    expect(roomScreen(st({ boardClosed: true }, { repairing: true })).kind).toBe("repairing");
    // The pair: the same board not closed is "being created".
    expect(roomScreen(st({ creation: { state: "creating" } })).kind).toBe("creating");
  });

  it("both in, no game yet ⇒ card 5; busy carries Lichess's retry time", () => {
    expect(roomScreen(st({ creation: { state: "creating" } }))).toEqual({ kind: "creating", retryAt: null });
    expect(roomScreen(st({ creation: { state: "busy", retryAt: "2026-10-12T10:01:00.000Z" } }))).toEqual({
      kind: "creating",
      retryAt: "2026-10-12T10:01:00.000Z",
    });
  });

  it("every seat refusal has its screen (preflight's thirteen reasons; canvas cards 1, 2, 3, 4, 6, 7, 8, T17B's blocked card, and the check-in for a camera still starting)", () => {
    const want: Record<SeatRefusal, string> = {
      camera_required: "cameraRequired",
      camera_lost: "cameraLost",
      // T17B fix 2 (D2), the ruling: a camera still starting is NOT a terminal card — the room re-asks; a browser
      // that refused the camera is its own card.
      camera_starting: "checkin",
      camera_blocked: "cameraBlocked",
      video_unavailable: "videoDown",
      lichess_link_required: "relink",
      lichess_reconsent_required: "relink",
      window_closed: "closed",
      round_not_open: "notOpened",
      // Spec §3.2.1 / §6.1: the round is open but THIS board's batch is not - its own card, never the "not opened" one.
      checkin_not_open: "batchWait",
      // Spec §5.7 / §6.1: the budget holding the claim in the line is the check-in card, which shows the line itself.
      queued: "checkin",
      not_a_player: "unavailable",
      fixture_not_playable: "unavailable",
    };
    let checked = 0;
    for (const [reason, kind] of Object.entries(want) as [SeatRefusal, string][]) {
      expect(seatRefusalScreen(reason), reason).toBe(kind);
      expect(roomScreen(st({}, { seat: refused(reason) })).kind, reason).toBe(kind);
      checked += 1;
    }
    expect(checked, "anti-vacuity: refusal reasons").toBe(13);
  });

  it("a game on file is the live room — whatever stale seat refusal or window the state still holds", () => {
    expect(roomScreen(st({ game: GAME, phase: "closed" }, { seat: refused("window_closed") })).kind).toBe("live");
    expect(roomScreen(st({ game: GAME }, { seat: refused("camera_lost") })).kind).toBe("live");
  });

  it("over: the game says over, or a result is written (with or without a board)", () => {
    expect(roomScreen(st({ game: { ...GAME, over: true } })).kind).toBe("over");
    expect(roomScreen(st({ result: { outcome: "won", method: null, score: "1–0" } })).kind).toBe("over");
  });

  it("precedence: not found > online chess off > over > your seat frozen > relink > held > live", () => {
    // Review I1 (controller ruling): a written result outranks the frozen
    // seat — the frozen player sees how the game ended, never A again.
    const all = st(
      { onlineChessOff: true, frozen: "you", canAct: false, game: GAME, result: { outcome: "lost", method: "time", score: "0–1" } },
      { notFound: true, error: "relink" },
    );
    const off = { ...all.snap, onlineChessOff: false };
    expect(roomScreen(all).kind).toBe("unavailable");
    expect(roomScreen({ ...all, notFound: false }).kind).toBe("offForClub");
    expect(roomScreen({ ...all, notFound: false, snap: off }).kind).toBe("over");
    expect(roomScreen({ ...all, notFound: false, snap: { ...off, result: null } }).kind).toBe("revoked");
    expect(roomScreen({ ...all, notFound: false, snap: { ...off, result: null, frozen: null } }).kind).toBe("relink");
    expect(roomScreen({ ...all, notFound: false, error: null, snap: { ...off, result: null, frozen: null } }).kind).toBe("held");
    expect(roomScreen({ ...all, notFound: false, error: null, snap: { ...off, result: null, frozen: null, canAct: true } }).kind).toBe("live");
  });

  it("P10: Lichess said at page load that the grant no longer plays ⇒ relink — game over and a frozen seat outrank it; it outranks a held board, the live board and the check-in", () => {
    const grantRefusedOn = (over: Partial<RoomSnapshot>) => roomScreen(st(over, { grantRefused: true })).kind;
    // The empty case first: no refusal leaves each of these on its own screen.
    expect([st({ game: GAME, canAct: true }), st({ game: GAME, canAct: false }), st({})].map((x) => roomScreen(x).kind)).toEqual(["live", "held", "checkin"]);
    expect([grantRefusedOn({ game: GAME, canAct: true }), grantRefusedOn({ game: GAME, canAct: false }), grantRefusedOn({})]).toEqual(["relink", "relink", "relink"]);
    expect(grantRefusedOn({ game: { ...GAME, over: true } })).toBe("over");
    expect(grantRefusedOn({ game: GAME, frozen: "you" })).toBe("revoked");
  });

  it("I1: a frozen seat whose game is over — written or seen over — is the game-over screen, for both freezes", () => {
    let checked = 0;
    for (const frozen of ["you", "both"] as const) {
      expect(roomScreen(st({ game: GAME, frozen, canAct: false, result: { outcome: "won", method: "resign", score: "1–0" } })).kind, frozen).toBe("over");
      expect(roomScreen(st({ game: { ...GAME, over: true }, frozen, canAct: false })).kind, frozen).toBe("over");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a freeze: yours ⇒ A (revoked); the opponent's ⇒ your board plays on; R2-1 — one you did not cause ⇒ the neutral seat hold, never A: both seats, or the opponent's with no game to play on — counted", () => {
    expect(roomScreen(st({ game: GAME, frozen: "you", canAct: false })).kind).toBe("revoked");
    expect(roomScreen(st({ game: null, frozen: "you", canAct: false, held: true })).kind, "mid-create: still yours").toBe("revoked");
    expect(roomScreen(st({ game: GAME, frozen: "opponent", canAct: true })).kind).toBe("live");
    // Final re-review 2, R2-1. "both" cannot tell the player who changed from the one who did not (an unknown seat,
    // two seats, or ruling N2's widening of one seat), so it blames nobody; nor does the opponent's freeze on a board
    // with no game (a create in flight) — which, unhandled, fell to "Check-in has closed".
    const NEUTRAL: [string, Partial<RoomSnapshot>][] = [
      ["both, a game on file", { game: GAME, frozen: "both", canAct: false, held: false }],
      ["both, no game", { game: null, frozen: "both", canAct: false, held: true }],
      ["the opponent's, no game", { game: null, frozen: "opponent", canAct: false, held: true }],
      ["the opponent's, no game, past the deadline", { game: null, frozen: "opponent", canAct: false, held: true, phase: "closed" }],
    ];
    let checked = 0;
    for (const [label, over] of NEUTRAL) {
      expect(roomScreen(st(over)).kind, label).toBe("seatHeld");
      checked += 1;
    }
    expect(checked).toBe(NEUTRAL.length);
  });

  it("R2-1 precedence: over > your seat frozen > relink > a seat hold you did not cause > held / closed", () => {
    const both = { game: GAME, frozen: "both", canAct: false } as const;
    expect(roomScreen(st({ ...both, game: { ...GAME, over: true } })).kind, "a game seen over outranks it").toBe("over");
    expect(roomScreen(st({ ...both, result: { outcome: "won", method: "time", score: "1–0" } })).kind).toBe("over");
    // The viewer's OWN grant, refused (P10) or refused mid-act, is a fact about them: it outranks the neutral hold.
    expect(roomScreen(st(both, { grantRefused: true })).kind).toBe("relink");
    expect(roomScreen(st(both, { error: "relink" })).kind).toBe("relink");
    // It outranks the held seam and the closed card it would otherwise fall to.
    expect(roomScreen(st({ ...both, frozen: null })).kind, "the pair: no freeze ⇒ held").toBe("held");
    expect(roomScreen(st({ game: null, frozen: null, canAct: false, held: true })).kind, "the pair: no freeze ⇒ closed").toBe("closed");
  });

  it("re-review 5 I-2: the game is on ANOTHER Lichess account ⇒ A (revoked) — after over, before relink and held; the pairs: the same board as recorded is live, held stays held", () => {
    const other = { game: GAME, canAct: false, otherAccount: "ada_recorded" } as const;
    expect(roomScreen(st(other)).kind).toBe("revoked");
    // The remedy is a re-link either way: the server's reason outranks a re-link the act asked for.
    expect(roomScreen(st(other, { error: "relink" })).kind).toBe("revoked");
    // A written result, or a game seen over, outranks it (as it does a freeze).
    expect(roomScreen(st({ ...other, result: { outcome: "lost", method: "time", score: "0–1" } })).kind).toBe("over");
    expect(roomScreen(st({ ...other, game: { ...GAME, over: true } })).kind).toBe("over");
    // The pairs.
    expect(roomScreen(st({ game: GAME, canAct: true, otherAccount: null })).kind).toBe("live");
    expect(roomScreen(st({ game: GAME, canAct: false, otherAccount: null })).kind).toBe("held");
  });

  it("I2: a game on file the server will not take a move on is HELD — never the live, movable room", () => {
    // A provider_error mid-game, T13's deadline hold of a created game, a
    // withdrawn board: play.ts refuses each, so the room must too.
    expect(roomScreen(st({ game: GAME, canAct: false })).kind).toBe("held");
    expect(roomScreen(st({ game: GAME, canAct: false, held: true })).kind).toBe("held");
    expect(roomScreen(st({ game: GAME, canAct: false, phase: "closed" })).kind).toBe("held");
    // The pair: the same board the server takes moves on is live.
    expect(roomScreen(st({ game: GAME, canAct: true })).kind).toBe("live");
    // No game: a hold is still card 6.
    expect(roomScreen(st({ game: null, canAct: false, held: true })).kind).toBe("closed");
  });

  it("through the reducer (a sequence): check-in → seat refused for camera → seated → game arrives → over", () => {
    let s = st();
    expect(roomScreen(s).kind).toBe("checkin");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: { snapshot: snap({ serverNow: new Date(T0 + 1).toISOString() }), seat: refused("camera_required"), create: null },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("cameraRequired");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: {
        snapshot: snap({ serverNow: new Date(T0 + 2).toISOString(), creation: { state: "creating" } }),
        seat: { seated: true, participant: null },
        create: null,
      },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("creating");
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: new Date(T0 + 3).toISOString(), game: GAME }), receivedAt: T0 });
    expect(roomScreen(s).kind).toBe("live");
    s = roomReducer(s, {
      type: "broadcast",
      b: { fen: GAME.fen, lastMove: null, turn: "white", whiteMs: 1, blackMs: 1, status: "aborted", drawOfferBy: null },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("over");
  });
});

describe("roomScreen — a seat tied to no account, met after load (review m2)", () => {
  it("its own card in place of the room, whatever the room was showing - check-in, live, a camera refusal, a re-pair - and the 404 still outranks it", () => {
    let checked = 0;
    for (const [why, s] of [
      ["the check-in", st({}, { noAccount: true })],
      ["a live board", st({ game: GAME }, { noAccount: true })],
      ["a camera refusal", st({}, { noAccount: true, seat: refused("camera_required") })],
      ["a Lichess re-link", st({}, { noAccount: true, seat: refused("lichess_link_required") })],
      ["a board being re-paired", st({}, { noAccount: true, repairing: true })],
    ] as const) {
      expect(roomScreen(s).kind, why).toBe("noAccount");
      expect(roomScreen({ ...s, noAccount: false }).kind, `${why}: the positive`).not.toBe("noAccount");
      checked += 1;
    }
    expect(checked).toBe(5);
    expect(roomScreen(st({}, { noAccount: true, notFound: true })).kind, "the room's 404 outranks it").toBe("unavailable");
    expect(roomScreen(st({})).kind, "the empty case: nothing met ⇒ the check-in").toBe("checkin");
  });
});

describe("roomScreen — the camera settling (room-shell's context)", () => {
  it("fix round 4b: a board being re-paired shows its own card in place of the (stale) board — check-in, live or held alike — but a stop outranks it", () => {
    let checked = 0;
    for (const [why, s] of [
      ["the check-in", st({}, { repairing: true })],
      ["checked in, the opponent named", st({ you: { colour: "white", name: "Ada Okonkwo", checkedIn: true } }, { repairing: true })],
      ["a camera refusal", st({}, { repairing: true, seat: refused("camera_required") })],
      ["a creating board", st({ creation: { state: "creating" } as RoomSnapshot["creation"] }, { repairing: true })],
    ] as const) {
      expect(roomScreen(s).kind, why).toBe("repairing");
      expect(roomScreen({ ...s, repairing: false }).kind, `${why}: the positive`).not.toBe("repairing");
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(roomScreen(st({}, { repairing: true, notFound: true })).kind, "the room's 404 outranks it").toBe("unavailable");
  });

  it("a camera refusal stays on the check-in while the camera comes up; card 2/3 once it will not", () => {
    let checked = 0;
    for (const reason of ["camera_required", "camera_lost"] as const) {
      const s = st({}, { seat: refused(reason) });
      expect(roomScreen(s, { cameraSettling: true }).kind, reason).toBe("checkin");
      expect(roomScreen(s, { cameraSettling: false }).kind, reason).toBe(reason === "camera_required" ? "cameraRequired" : "cameraLost");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("settling never hides any OTHER refusal", () => {
    let checked = 0;
    for (const reason of ["video_unavailable", "window_closed", "lichess_link_required", "not_a_player"] as const) {
      expect(roomScreen(st({}, { seat: refused(reason) }), { cameraSettling: true }).kind, reason).not.toBe("checkin");
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

// T17B fix 2 (D8a), controller ruling: when the room reaches a closed or result phase the client LEAVES the meeting
// and stops every local track. Typed from the ruling, never read from room-screen.ts: the game-over screen and the
// closed card end the camera; every screen where a game may still be played, or the camera is still owed, keeps it.
describe("cameraEnds (T17B fix 2, D8a)", () => {
  const cases: { why: string; state: RoomState; ends: boolean }[] = [
    { why: "the empty case: the check-in", state: st(), ends: false },
    { why: "a live game", state: st({ game: GAME }), ends: false },
    { why: "a held game (the arbiter may still need its camera)", state: st({ game: GAME, canAct: false }), ends: false },
    { why: "the game is over at Lichess", state: st({ game: { ...GAME, over: true } }), ends: true },
    { why: "a result is written, board or not", state: st({ result: { outcome: "won", method: null, score: "1–0" } }), ends: true },
    { why: "the window closed with no game", state: st({ phase: "closed" }), ends: true },
    { why: "a hold with no game", state: st({ held: true, canAct: false }), ends: true },
    { why: "not opened yet", state: st({ phase: "before" }), ends: false },
    { why: "your seat frozen mid-game", state: st({ game: GAME, frozen: "you", canAct: false }), ends: false },
    { why: "a board being re-paired", state: st({ game: GAME }, { repairing: true }), ends: false },
    { why: "T17B fix 2 (D10): a board the organiser closed before any game", state: st({ boardClosed: true }), ends: true },
  ];
  it("the result, the closed card and a board the organiser closed end the camera; every other screen keeps it — counted", () => {
    let checked = 0;
    for (const c of cases) {
      expect(cameraEnds(c.state), c.why).toBe(c.ends);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(cases.filter((c) => c.ends).length, "anti-vacuity: both answers reached").toBeGreaterThan(0);
    expect(cases.filter((c) => !c.ends).length).toBeGreaterThan(0);
  });

  it("over outranks everything that would keep it: a frozen seat, a held board, a stale seat refusal", () => {
    const result = { outcome: "lost" as const, method: "resign" as const, score: "0–1" };
    expect(cameraEnds(st({ game: GAME, frozen: "you", canAct: false, result }))).toBe(true);
    expect(cameraEnds(st({ game: GAME, canAct: false, result }))).toBe(true);
    expect(cameraEnds(st({ result }, { seat: refused("camera_lost") }))).toBe(true);
  });
});

// Owner staging test 2026-10-19: a personal link opened while signed in as ANOTHER account. The two screens that offer
// "Link Lichess" (card 8, and seam A's notice) would link the WRONG account, so they give way to the wrong-account card -
// and ONLY they do: every other screen is the seat's, whoever is looking.
describe("the wrong-account card stands where the Lichess link prompt would", () => {
  const WRONG: Partial<RoomSnapshot> = { account: { state: "wrong_account", viewerEmail: "bob@example.test" } };
  /** Every way the room reaches a Lichess link prompt, each as a state the reducer can really hold. */
  const PROMPTS: { why: string; want: "relink" | "revoked"; state: (over: Partial<RoomSnapshot>) => RoomState }[] = [
    { why: "the seat call refused with lichess_link_required", want: "relink", state: (o) => st(o, { seat: refused("lichess_link_required") }) },
    { why: "the seat call refused with lichess_reconsent_required", want: "relink", state: (o) => st(o, { seat: refused("lichess_reconsent_required") }) },
    { why: "an act's token was refused (error relink)", want: "relink", state: (o) => st(o, { error: "relink" }) },
    { why: "Lichess narrowed the grant (grantRefused, P10)", want: "relink", state: (o) => st(o, { grantRefused: true }) },
    { why: "the viewer's own seat is frozen", want: "revoked", state: (o) => st({ game: GAME, frozen: "you", canAct: false, ...o }) },
    { why: "the game is on another Lichess account", want: "revoked", state: (o) => st({ game: GAME, canAct: false, otherAccount: "ada_recorded", ...o }) },
  ];

  it("each prompt, as the seat's own account sees it (the pair), is the prompt; as another account sees it, the wrong-account card carrying that viewer's email", () => {
    let checked = 0;
    for (const p of PROMPTS) {
      expect(roomScreen(p.state({})).kind, `${p.why}: the pair - not mismatched`).toBe(p.want);
      expect(roomScreen(p.state({ account: { state: "ok" } })).kind, `${p.why}: ok`).toBe(p.want);
      expect(roomScreen(p.state(WRONG)), p.why).toEqual({ kind: "wrongAccount", viewerEmail: "bob@example.test" });
      checked += 1;
    }
    expect(checked).toBe(PROMPTS.length);
    expect(new Set(PROMPTS.map((p) => p.want)), "anti-vacuity: both prompt screens reached").toEqual(new Set(["relink", "revoked"]));
  });

  it("no other screen changes: a mismatched viewer still sees the check-in, a live board, a result, the window cards - the card replaces the prompt, not the room", () => {
    const rest: { why: string; state: RoomState; kind: string }[] = [
      { why: "the check-in", state: st(WRONG), kind: "checkin" },
      { why: "a live board", state: st({ ...WRONG, game: GAME }), kind: "live" },
      { why: "a held board", state: st({ ...WRONG, game: GAME, canAct: false }), kind: "held" },
      { why: "a result", state: st({ ...WRONG, result: { outcome: "won", method: "time", score: "1-0" } }), kind: "over" },
      { why: "not opened", state: st({ ...WRONG, phase: "not_opened" }), kind: "notOpened" },
      { why: "the window closed", state: st({ ...WRONG, phase: "closed" }), kind: "closed" },
      { why: "creating", state: st({ ...WRONG, creation: { state: "creating" } }), kind: "creating" },
      { why: "a camera refusal", state: st(WRONG, { seat: refused("camera_required") }), kind: "cameraRequired" },
      { why: "a re-pair", state: st(WRONG, { repairing: true }), kind: "repairing" },
      { why: "not found", state: st(WRONG, { notFound: true }), kind: "unavailable" },
      { why: "no account (review m2)", state: st(WRONG, { noAccount: true }), kind: "noAccount" },
    ];
    let checked = 0;
    for (const r of rest) {
      expect(roomScreen(r.state).kind, r.why).toBe(r.kind);
      checked += 1;
    }
    expect(checked).toBe(rest.length);
  });

  it("a result outranks the prompt for a mismatched viewer too: the frozen seat that finished reads how it ended, not the card", () => {
    const over = st({ ...WRONG, game: GAME, frozen: "you", canAct: false, result: { outcome: "lost", method: "time", score: "0-1" } });
    expect(roomScreen(over).kind).toBe("over");
  });
});
