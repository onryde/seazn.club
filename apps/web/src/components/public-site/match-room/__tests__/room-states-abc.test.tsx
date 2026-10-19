// Seams A/B/C — the three room states the owner approved on the canvas
// (artifact E1d7mYXyWBuZHvG7eby73H, "Room states", 2026-10-12), painted from
// the room's own state with the REAL dictionaries:
//   A  Lichess link revoked — the frozen player's board dimmed and
//      read-only, their clock tile "Seat on hold", the amber notice with
//      "Link Lichess again", "Back to fixture";
//   B  online chess off — one calm card, no board, camera or clocks;
//   C  the live room's notices — C1 offline, C2 refused, C3 invalid —
//      reached through the reducer's own transitions, never a hand-set field.
// Expected English copy is the canvas's (owner tweak 1: "Back to fixture",
// the room's existing words), never read back from the components. The
// order a phone shows is the browser's to prove (match-room.spec.ts); this
// pins what paints, what does not, and where each link goes.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { Screen } from "../room-shell";
import type { PresenceState } from "../presence-pill";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";
import type { RoomActBody } from "../room-api";

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const FIXTURE = "/shared/org/comp/div/fixtures/f1";
const RELINK = "/api/auth/lichess?org=org&next=%2Fshared%2Forg%2Fcomp%2Fdiv%2Ffixtures%2Ff1%2Fplay%3Ft%3Dtok";
/** The Lichess account T9 recorded for the viewer's seat (re-review 6, N-2). */
const RECORDED = "ada_recorded";

// The canvas's words (RevokedPhone/Desktop, ChessOffPhone/Desktop,
// MoveOfflinePhone, MoveRefusedPhone, MoveInvalidPhone), and owner tweak 1.
const CANVAS = {
  revokedTitle: "Your Lichess link was revoked, so we can't play your moves.",
  revokedBody: "Your organiser has been told and will decide what happens next.",
  relink: "Link Lichess again",
  // T14 re-review 5, I-2 + re-review 6, N-2 (controller rulings): A's line
  // when the game is on another account, naming the account it IS on
  // (RECORDED, from the server's snapshot).
  otherAccount: "This game is on your Lichess account ada_recorded — sign in to Lichess as ada_recorded, then link it again to keep playing.",
  seatOnHold: "Seat on hold",
  whiteSeatOnHold: "White · seat on hold",
  holdCamera: "Keep your camera on while your seat is on hold. If your video drops, we note when for your organiser, who decides what happens.",
  offTitle: "Online play isn't available for this event right now.",
  offBody: "Your organiser will let you know how this match will be played.",
  back: "Back to fixture",
  offlineTitle: "You're offline — reconnecting…",
  offlineBody: "Your clock keeps running.",
  refusedTitle: "That move didn't go through.",
  refusedBody: "Your position has been restored — try again.",
  invalid: "That move isn't allowed here.",
  // Notice routing ruling (2026-10-12): the generic C2, for a non-move.
  failed: "That didn't go through. Try again.",
} as const;

const GAME: RoomGame = {
  gameId: "g1",
  moves: ["e2e4", "e7e5"],
  fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  lastMove: ["e7", "e5"],
  turn: "white",
  whiteMs: 497_000,
  blackMs: 582_000,
  clockAsOf: new Date(T0).toISOString(),
  clockRunning: true,
  drawOfferBy: null,
  over: false,
};
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: new Date(T0).toISOString(),
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: FIXTURE, standings: "/shared/org/comp/div" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: true },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
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
type CameraStatus = "idle" | "joining" | "live" | "off" | "failed" | "recovering" | "gave_up";
function Painted({ state, cameraStatus, presence }: { state: RoomState; cameraStatus: CameraStatus; presence: PresenceState | null }) {
  const t = useT();
  const plural = usePlural();
  const noop = async () => null;
  return (
    <Screen
      screen={roomScreen(state)}
      state={state}
      room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
      camera={{ status: cameraStatus, stream: null, enable: () => {} }}
      presence={presence}
      busy={false}
      tryAgain={() => {}}
      relinkHref={RELINK}
      locale="en"
      t={t as never}
      plural={plural as never}
      reload={() => {}}
    />
  );
}
function paint(state: RoomState, o: { locale?: Locale; camera?: CameraStatus; presence?: PresenceState | null } = {}) {
  const locale = o.locale ?? "en";
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <Painted state={state} cameraStatus={o.camera ?? "live"} presence={o.presence ?? null} />
    </DictProvider>,
  );
}
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const RAW_KEY = /externalPlay\.room\.|onlineChess\.camera\.|settings\.account\./;
/** The class list of the element carrying a test id. */
function classOf(html: string, testId: string): string {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no element ${testId}`);
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}
/** An element's attribute, anchored on `="` (AGENTS.md). */
function attrOf(html: string, testId: string, attr: string): string | null {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
  return new RegExp(`${attr}="([^"]*)"`).exec(tag)?.[1] ?? null;
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const revokedState = (over: Partial<RoomSnapshot> = {}) =>
  initialRoomState(snap({ game: GAME, frozen: "you", canAct: false, ...over }), T0);

describe("Seam A — the Lichess link revoked: the frozen player's own room", () => {
  it("the drawing's parts: clocks with Seat on hold, the amber notice and its Link Lichess again, the dimmed read-only board, Back to fixture — and NO game actions, no \"your move\"", () => {
    const html = paint(revokedState());
    expect(roomScreen(revokedState()).kind).toBe("revoked");
    const present = ids(html);
    for (const id of ["room-revoked", "room-clock-opponent", "room-clock-you", "room-revoked-notice", "room-revoked-relink", "room-board", "room-back-to-fixture"]) {
      expect(present, id).toContain(id);
    }
    for (const id of ["room-controls", "room-resign", "room-draw", "room-abort", "room-seam-revoked"]) expect(present, id).not.toContain(id);
    const text = textOf(html);
    expect(text).toContain(CANVAS.revokedTitle);
    expect(text).toContain(CANVAS.revokedBody);
    expect(text).toContain(CANVAS.relink);
    expect(text).toContain(CANVAS.seatOnHold);
    expect(text).toContain(CANVAS.whiteSeatOnHold);
    expect(text).toContain(CANVAS.back);
    expect(text, "never \"your move\" on a seat on hold").not.toContain(en["externalPlay.room.yourMove" as keyof typeof en]);
    expect(attrOf(html, "room-revoked-relink", "href"), "Link Lichess again starts the link flow for this club, back to this room").toBe(
      RELINK.replace(/&/g, "&amp;"),
    );
    expect(attrOf(html, "room-back-to-fixture", "href")).toBe(FIXTURE);
    // Dimmed and read-only (canvas: opacity .5, grayscale .35).
    const board = classOf(html, "room-board");
    expect(board).toMatch(/(^|\s)opacity-50(\s|$)/);
    expect(board).toContain("[filter:grayscale(0.35)]");
    expect(attrOf(html, "room-board", "data-on-hold")).toBe("true");
  });

  it("final re-review 2, R2-1: a seat hold the viewer did NOT cause — both seats, or the opponent's with no game — is the neutral hold, in every locale: no 'your link was revoked', no Link Lichess again; the way back stays — counted", () => {
    // Expected words from the dictionaries, never the component: the held seam's own two lines.
    const CASES: [string, Partial<RoomSnapshot>, boolean][] = [
      ["both frozen, White", { game: GAME, frozen: "both", you: { colour: "white", name: "Bo Lind", checkedIn: true }, opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true } }, true],
      ["both frozen, Black", { game: GAME, frozen: "both", you: { colour: "black", name: "Bo Lind", checkedIn: true }, opponent: { colour: "white", name: "Ada Okonkwo", checkedIn: true } }, true],
      ["the opponent's freeze, no game (a create in flight)", { game: null, frozen: "opponent", held: true }, false],
    ];
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = LOCALES[locale] as Record<string, string>;
      for (const [label, over, board] of CASES) {
        const s = revokedState(over);
        const at = `${locale} ${label}`;
        expect(roomScreen(s).kind, at).toBe("seatHeld");
        const html = paint(s, { locale });
        const present = ids(html);
        for (const id of ["room-seat-held", "room-seat-held-notice", "room-back-to-fixture"]) expect(present, `${at}: ${id}`).toContain(id);
        for (const id of ["room-revoked-notice", "room-revoked-relink", "room-controls"]) expect(present, `${at}: ${id}`).not.toContain(id);
        expect(present.includes("room-board"), `${at}: the board, dimmed, exactly when a game is on file`).toBe(board);
        const text = textOf(html);
        expect(text, at).toContain(d["externalPlay.room.state.held.title"]);
        expect(text, at).toContain(d["externalPlay.room.state.held.body"]);
        for (const k of ["externalPlay.room.state.revoked.title", "externalPlay.room.state.revoked.relink"]) expect(text, `${at}: ${k}`).not.toContain(d[k]);
        expect(text, `${at}: no raw key`).not.toMatch(RAW_KEY);
        expect(attrOf(html, "room-seat-held-notice", "role"), at).toBe("status");
        checked += 1;
      }
    }
    expect(checked).toBe(Object.keys(LOCALES).length * CASES.length);
  });

  it("the pairs: the OPPONENT's freeze leaves this board live, and a written result outranks A (I1)", () => {
    const opp = initialRoomState(snap({ game: GAME, frozen: "opponent", canAct: true }), T0);
    const live = paint(opp);
    expect(roomScreen(opp).kind).toBe("live");
    expect(ids(live)).not.toContain("room-revoked-notice");
    expect(ids(live)).toContain("room-controls");
    const ended = revokedState({ game: { ...GAME, over: true }, result: { outcome: "lost", method: "resignation", score: "0–1" } });
    expect(roomScreen(ended).kind).toBe("over");
    expect(ids(paint(ended))).not.toContain("room-revoked-notice");
  });

  it("every camera policy: the tile with any camera; the hold's own camera line and the camera-off banner for `required` only (I3) — owner tweak 2: the line on the phone too (one DOM)", () => {
    let checked = 0;
    for (const policy of CAMERA_POLICIES) {
      const duty = policy === "required";
      const s = revokedState({ cameraPolicy: policy, opponentCamera: policy === "off" ? null : "live" });
      const html = paint(s, { presence: policy === "off" ? null : "live" });
      expect(ids(html).includes("room-tile-strip"), `${policy}: tile`).toBe(policy !== "off");
      expect(ids(html).includes("room-presence-pill"), `${policy}: pill`).toBe(policy !== "off");
      expect(textOf(html).includes(CANVAS.holdCamera), `${policy}: the hold's camera line`).toBe(duty);
      expect(textOf(html), `${policy}: never the live game's line here`).not.toContain(en["onlineChess.camera.playerNotice" as keyof typeof en]);
      if (duty) {
        const notice = classOf(html, "room-camera-notice");
        expect(notice, "not hidden at any width").not.toMatch(/(^|\s)(max-md:hidden|hidden|md:hidden)(\s|$)/);
      }
      const off = paint(s, { camera: "off" });
      expect(ids(off).includes("room-camera-off"), `${policy}: camera-off banner`).toBe(duty);
      expect(ids(paint(s, { camera: "gave_up" })).includes("room-camera-gave-up"), `${policy}: give-up`).toBe(policy !== "off");
      expect(ids(paint(s, { camera: "recovering" })).includes("room-camera-reconnecting"), `${policy}: our reconnect`).toBe(policy !== "off");
      checked += 1;
    }
    expect(checked, "anti-vacuity: policies").toBe(3);
  });
});

describe("Seam A — the game is on another Lichess account (T14 re-review 5, I-2)", () => {
  const otherState = (over: Partial<RoomSnapshot> = {}) =>
    initialRoomState(snap({ game: GAME, frozen: null, canAct: false, otherAccount: RECORDED, ...over }), T0);

  it("A's layout with the account's own line in place of the revoked words, and the same one action: Link Lichess again", () => {
    const s = otherState();
    expect(roomScreen(s).kind).toBe("revoked");
    const html = paint(s);
    const present = ids(html);
    for (const id of ["room-revoked", "room-clock-opponent", "room-clock-you", "room-revoked-notice", "room-revoked-relink", "room-board", "room-back-to-fixture"]) expect(present, id).toContain(id);
    for (const id of ["room-controls", "room-resign", "room-draw", "room-abort", "room-move-notice"]) expect(present, id).not.toContain(id);
    const text = textOf(html);
    expect(text).toContain(CANVAS.otherAccount);
    // Nothing was revoked and nobody was told (an organiser hold for this is
    // out of scope): those words would be false here.
    expect(text).not.toContain(CANVAS.revokedTitle);
    expect(text).not.toContain(CANVAS.revokedBody);
    expect(attrOf(html, "room-revoked-relink", "href")).toBe(RELINK.replace(/&/g, "&amp;"));
    expect(textOf(html)).toContain(CANVAS.relink);
    expect(attrOf(html, "room-revoked-notice", "data-reason")).toBe("account");
    expect(attrOf(html, "room-board", "data-on-hold")).toBe("true");
  });

  it("the pairs: a frozen seat keeps the revoked words and never the account line; the account as recorded is the live board", () => {
    const frozen = paint(revokedState());
    expect(textOf(frozen)).toContain(CANVAS.revokedTitle);
    expect(textOf(frozen)).not.toContain(CANVAS.otherAccount);
    expect(attrOf(frozen, "room-revoked-notice", "data-reason")).toBe("revoked");
    const live = initialRoomState(snap({ game: GAME, canAct: true, otherAccount: null }), T0);
    expect(roomScreen(live).kind).toBe("live");
    expect(textOf(paint(live))).not.toContain(CANVAS.otherAccount);
  });

  it("re-review 6 N-2: the line NAMES the account the game is on — the snapshot's, in every locale, twice (the account and who to sign in as)", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      for (const name of [RECORDED, "someone_else_42"]) {
        const text = textOf(paint(otherState({ otherAccount: name }), { locale }));
        expect(text.split(name).length - 1, `${locale} ${name}: named twice`).toBe(2);
        expect(text, `${locale}: no raw placeholder`).not.toMatch(/\{username\}/);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: locales × names").toBe(4 * 2);
  });

  it("re-review 6 N-2: a long account name WRAPS — never truncated (it is what the player signs in with); min-w-0 on the notice", () => {
    // Lichess usernames run to 20 characters; a longer unbroken string proves the wrap.
    const long = "maximilianafeatherstonehaugh_wolstenholme";
    const html = paint(otherState({ otherAccount: long }));
    expect(textOf(html)).toContain(long);
    const line = /<span[^>]*data-testid="room-revoked-account"[^>]*>/.exec(html)?.[0] ?? "";
    expect(line, "the account line is its own element").not.toBe("");
    const cls = /class="([^"]*)"/.exec(line)?.[1] ?? "";
    expect(cls).toContain("[overflow-wrap:anywhere]");
    expect(cls, "never truncated").not.toMatch(/(^|\s)(truncate|text-ellipsis|line-clamp-\d+)(\s|$)/);
    expect(classOf(html, "room-revoked-notice")).toMatch(/(^|\s)min-w-0(\s|$)/);
  });
});

describe("Seam B — online chess off: one calm card", () => {
  it("the card's words and its one way back; NO board, clocks, camera or game actions", () => {
    const s = initialRoomState(snap({ onlineChessOff: true, game: null }), T0);
    expect(roomScreen(s).kind).toBe("offForClub");
    const html = paint(s, { camera: "live" });
    const present = ids(html);
    expect(present).toContain("room-off-for-club");
    for (const id of ["room-board", "room-clocks-strip", "room-clock-opponent", "room-clock-you", "room-own-tile", "room-tile-strip", "room-presence-pill", "room-controls", "room-camera-notice", "room-seam-off-for-club"]) {
      expect(present, id).not.toContain(id);
    }
    const text = textOf(html);
    expect(text).toContain(CANVAS.offTitle);
    expect(text).toContain(CANVAS.offBody);
    expect(text).toContain(CANVAS.back);
    expect(attrOf(html, "room-back-to-fixture", "href")).toBe(FIXTURE);
    expect(classOf(html, "room-off-for-club"), "a white card (canvas), not the state cards' cream").toContain("bg-white");
  });
});

// T17B fix 2, D10: the organiser closed the board before any game (a No result, then voided). Copy from the real
// dictionaries, every locale; the canvas has no card for it (a coordinator-ruled state, styled as card 6).
describe("D10 — a board the organiser closed: its own card, every locale", () => {
  it("the card's words and its one way back; NO board, clocks, camera, check-in or 'setting up' — counted over the locales", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const dict = LOCALES[locale] as Record<string, string>;
      const s = initialRoomState(snap({ boardClosed: true, you: { colour: "white", name: "Ada", checkedIn: true } }), T0);
      expect(roomScreen(s).kind).toBe("boardClosed");
      const html = paint(s, { locale, camera: "live" });
      const present = ids(html);
      expect(present, locale).toContain("room-state-board-closed");
      for (const id of ["room-board", "room-clocks-strip", "room-clock-opponent", "room-clock-you", "room-own-tile", "room-tile-strip", "room-checkin-cta", "room-controls", "room-state-creating"]) {
        expect(present, `${locale} ${id}`).not.toContain(id);
      }
      expect(html, locale).not.toMatch(RAW_KEY);
      const text = textOf(html);
      expect(text, locale).toContain(dict["externalPlay.room.state.boardClosed.title"]!);
      expect(text, locale).toContain(dict["externalPlay.room.state.boardClosed.body"]!);
      expect(attrOf(html, "room-back-to-fixture", "href"), locale).toBe(FIXTURE);
      if (locale !== "en") expect(text, `${locale}: never English`).not.toContain((en as Record<string, string>)["externalPlay.room.state.boardClosed.title"]!);
      checked++;
    }
    expect(checked, "anti-vacuity: locales").toBe(4);
  });
});

describe("Seam C — the live room's move notices, reached through the reducer", () => {
  const live = () => initialRoomState(snap({ game: GAME }), T0);
  const sentMove = (s: RoomState) => roomReducer(s, { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } });
  const sentAct = (s: RoomState, action: RoomActBody) => roomReducer(s, { type: "act_sent", at: T0, action });
  const cases: [string, () => RoomState, "offline" | "refused" | "invalid" | "failed", string[]][] = [
    ["C1 a read with no answer", () => roomReducer(live(), { type: "fetch_failed", status: 0 }), "offline", [CANVAS.offlineTitle, CANVAS.offlineBody]],
    ["C1 a move with no answer", () => roomReducer(sentMove(live()), { type: "act_failed", status: 0 }), "offline", [CANVAS.offlineTitle, CANVAS.offlineBody]],
    [
      "C2 refused by Lichess",
      () => roomReducer(sentMove(live()), { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } }),
      "refused",
      [CANVAS.refusedTitle, CANVAS.refusedBody],
    ],
    ["C3 a rule refused it (400)", () => roomReducer(sentMove(live()), { type: "act_failed", status: 400 }), "invalid", [CANVAS.invalid]],
    // T14 re-review 5, I-1: play's 404 is the board, the seat or the account
    // — never a rule — so a move it refused is C2, never C3.
    ["C2 a move play refused (404)", () => roomReducer(sentMove(live()), { type: "act_failed", status: 404 }), "refused", [CANVAS.refusedTitle, CANVAS.refusedBody]],
    // Notice routing: a server failure on a move is C2, never C3.
    ["C2 a move our server failed (503)", () => roomReducer(sentMove(live()), { type: "act_failed", status: 503 }), "refused", [CANVAS.refusedTitle, CANVAS.refusedBody]],
    // …and a non-move never fails silently: the generic C2.
    [
      "C2 generic: a resign Lichess refused",
      () => roomReducer(sentAct(live(), { kind: "resign" }), { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } }),
      "failed",
      [CANVAS.failed],
    ],
    ["C2 generic: a draw offer our server failed (500)", () => roomReducer(sentAct(live(), { kind: "draw", accept: true }), { type: "act_failed", status: 500 }), "failed", [CANVAS.failed]],
    ["C2 generic: a decline the board refused (404)", () => roomReducer(sentAct(live(), { kind: "draw", accept: false }), { type: "act_failed", status: 404 }), "failed", [CANVAS.failed]],
  ];

  it("each notice, its words, its colour — amber for C1/C2, the purple inline for C3 — and the board plays on under it", () => {
    let checked = 0;
    for (const [name, make, kind, words] of cases) {
      const s = make();
      expect(roomScreen(s).kind, name).toBe("live");
      const html = paint(s);
      expect(attrOf(html, "room-move-notice", "data-kind"), name).toBe(kind);
      expect(attrOf(html, "room-move-notice", "role"), name).toBe("status");
      for (const w of words) expect(textOf(html), `${name}: ${w}`).toContain(w);
      const cls = classOf(html, "room-move-notice");
      if (kind === "invalid") expect(cls, name).toContain("bg-[#f3effc]");
      else expect(cls, name).toContain("bg-[#fef3c7]");
      if (kind !== "invalid") expect(textOf(html), `${name}: never "isn't allowed"`).not.toContain(CANVAS.invalid);
      expect(ids(html), `${name}: the controls stay`).toContain("room-controls");
      checked += 1;
    }
    expect(checked, "anti-vacuity: notices").toBe(cases.length);
    expect(new Set(cases.map((c) => c[2])), "every kind reached").toEqual(new Set(["offline", "refused", "invalid", "failed"]));
  });

  it("the empty case and the pairs: no notice on a clean board, or after an act went through (a move or a resign); none on a held or revoked board", () => {
    expect(ids(paint(live()))).not.toContain("room-move-notice");
    const ok = roomReducer(sentMove(live()), { type: "act_answered", answer: { ok: true, applied: true } });
    expect(ids(paint(ok))).not.toContain("room-move-notice");
    const resigned = roomReducer(sentAct(live(), { kind: "resign" }), { type: "act_answered", answer: { ok: true, applied: true } });
    expect(ids(paint(resigned)), "a resign that went through").not.toContain("room-move-notice");
    const heldOffline = roomReducer(initialRoomState(snap({ game: GAME, canAct: false }), T0), { type: "fetch_failed", status: 0 });
    expect(roomScreen(heldOffline).kind).toBe("held");
    expect(ids(paint(heldOffline))).not.toContain("room-move-notice");
    const revokedOffline = roomReducer(revokedState(), { type: "fetch_failed", status: 0 });
    expect(ids(paint(revokedOffline))).not.toContain("room-move-notice");
  });

  it("a phone shows C1/C2 between the opponent's clock and the board and C3 under the board AND the player's own clock; a desktop puts them at the top of the aside — one DOM, ordered", () => {
    // The aside dissolves into the phone's column (max-md:contents) so its
    // notices can take their drawn places; the browser proves the geometry.
    // D24: the opponent's clock is above the board, the player's below it.
    const order = (html: string, id: string) => Number(/(?:^|\s)order-(\d+)(?:\s|$)/.exec(classOf(html, id))?.[1] ?? NaN);
    let checked = 0;
    for (const [name, make, kind] of cases) {
      const html = paint(make(), { camera: "live" });
      const theirs = order(html, "room-clock-opponent");
      const board = order(html, "room-board");
      const mine = order(html, "room-clock-you");
      const notice = order(html, "room-move-notice");
      expect(theirs < board, `${name}: the opponent's clock above the board`).toBe(true);
      expect(board < mine, `${name}: the player's clock under the board`).toBe(true);
      if (kind === "invalid") expect(notice > mine, `${name}: under the board and its clock`).toBe(true);
      else expect(theirs < notice && notice < board, `${name}: between the opponent's clock and the board`).toBe(true);
      expect(notice < order(html, "room-controls"), `${name}: above the controls`).toBe(true);
      expect(mine < order(html, "room-controls"), `${name}: the controls follow the player's clock`).toBe(true);
      expect(classOf(html, "room-aside")).toMatch(/(^|\s)max-md:contents(\s|$)/);
      // On a desktop the aside is ONE grid item: auto-placement follows
      // `order`, so it must come after the board or it takes column 1.
      const asideMd = Number(/(?:^|\s)md:order-(\d+)(?:\s|$)/.exec(classOf(html, "room-aside"))?.[1] ?? NaN);
      expect(asideMd > board, `${name}: the aside places after the board`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });
});

describe("A, B and C in every locale: no raw key, never English outside en", () => {
  it("each state paints in its own language", () => {
    const states: [string, () => RoomState][] = [
      ["A", () => revokedState({ cameraPolicy: "required", opponentCamera: "live" })],
      ["A, another account", () => revokedState({ frozen: null, otherAccount: RECORDED })],
      ["B", () => initialRoomState(snap({ onlineChessOff: true }), T0)],
      ["C1", () => roomReducer(initialRoomState(snap({ game: GAME }), T0), { type: "fetch_failed", status: 0 })],
      [
        "C2",
        () =>
          roomReducer(roomReducer(initialRoomState(snap({ game: GAME }), T0), { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } }), {
            type: "act_answered",
            answer: { ok: false, reconcile: true, reason: "rejected" },
          }),
      ],
      [
        "C3",
        () => roomReducer(roomReducer(initialRoomState(snap({ game: GAME }), T0), { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } }), { type: "act_failed", status: 400 }),
      ],
      [
        "C2 generic",
        () => roomReducer(roomReducer(initialRoomState(snap({ game: GAME }), T0), { type: "act_sent", at: T0, action: { kind: "resign" } }), { type: "act_failed", status: 503 }),
      ],
    ];
    const english = Object.values(CANVAS).filter((w) => w !== CANVAS.back);
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      for (const [name, make] of states) {
        const html = paint(make(), { locale });
        expect(html, `${locale} ${name}`).not.toMatch(RAW_KEY);
        if (locale !== "en") for (const w of english) expect(textOf(html), `${locale} ${name}: "${w}"`).not.toContain(w);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: locale × state").toBe(4 * 7);
  });
});
