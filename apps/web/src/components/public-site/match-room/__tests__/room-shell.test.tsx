// T14 — the room as first painted (server render of the shell with the REAL
// dictionaries): which screen each snapshot paints, in the canvas's order,
// with no untranslated key reaching the page. Effects do not run here; the
// camera flow is room-shell-flow.test.tsx's, and the board itself (client-
// only) is the e2e's.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { RoomShell, Screen } from "../room-shell";
import { initialRoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const LOCALES = { en, es, fr, nl } as const;
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const GAME: RoomGame = {
  gameId: "g1",
  moves: ["e2e4", "e7e5"],
  fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  lastMove: ["e7", "e5"],
  turn: "white",
  whiteMs: 582_000,
  blackMs: 497_000,
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
    links: { fixture: "/shared/org/comp/div/fixtures/f1", standings: "/shared/org/comp/div" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "off",
    opponentPresence: null,
    frozen: null,
    canAct: true,
    onlineChessOff: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    realtime: null,
    ...over,
  };
}
function paint(s: RoomSnapshot, locale: keyof typeof LOCALES = "en") {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <RoomShell initial={s} token="tok" selfPath="/shared/org/comp/div/fixtures/f1/play?t=tok" />
    </DictProvider>,
  );
}
/** The screen a snapshot routes to, painted with the opponent pill's value
 *  and the camera's status as the hooks would hand them over (a first paint
 *  never runs them: the pill comes from the player's own meeting join). */
function ScreenAs({ s, presence, cameraStatus }: { s: RoomSnapshot; presence: boolean | null; cameraStatus: "idle" | "live" }) {
  const t = useT();
  const plural = usePlural();
  const state = initialRoomState(s, T0);
  const noop = async () => null;
  return (
    <Screen
      screen={roomScreen(state)}
      state={state}
      room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
      camera={{ status: cameraStatus, stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} }}
      presence={presence}
      busy={false}
      tryAgain={() => {}}
      relinkHref="/x"
      locale="en"
      t={t as never}
      plural={plural as never}
    />
  );
}
function paintScreen(s: RoomSnapshot, presence: boolean | null, locale: keyof typeof LOCALES = "en") {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <ScreenAs s={s} presence={presence} cameraStatus="live" />
    </DictProvider>,
  );
}
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const screenOf = (html: string) => /data-testid="match-room" data-screen="([^"]+)"/.exec(html)?.[1];

describe("the room's first paint", () => {
  it("live, cameras off: header, clocks, board, controls — in that order — and NO tile, pill or camera notice", () => {
    const html = paint(snap({ game: GAME, you: { colour: "white", name: "Bo Lind", checkedIn: true } }));
    expect(screenOf(html)).toBe("live");
    const order = ids(html).filter((i) => ["room-header", "room-clocks-strip", "room-board", "room-tile-strip", "room-controls", "room-camera-notice"].includes(i));
    expect(order).toEqual(["room-header", "room-clocks-strip", "room-board", "room-controls"]);
    expect(html).toContain("Open Rapid · Round 3");
    expect(html).toContain("Board 2 · 10+5");
    expect(html, "the clocks paint the snapshot's values before any tick").toContain("9:42");
    expect(html).toContain("8:17");
  });

  it("live, cameras on: the tile strip and the camera notice join, after the board and after the controls", () => {
    const html = paintScreen(snap({ game: GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } }), true);
    const order = ids(html).filter((i) => ["room-clocks-strip", "room-board", "room-tile-strip", "room-own-tile", "room-presence-pill", "room-controls", "room-camera-notice"].includes(i));
    expect(order).toEqual(["room-clocks-strip", "room-board", "room-tile-strip", "room-own-tile", "room-presence-pill", "room-controls", "room-camera-notice"]);
    expect(html).toContain("Ada · on camera");
    expect(html).toContain(en["onlineChess.camera.playerNotice" as keyof typeof en]);
  });

  it("the check-in: title, who you play spelled out, the opponent's state, Check in", () => {
    const html = paint(snap());
    expect(screenOf(html)).toBe("checkin");
    expect(html).toContain("You play White against Ada Okonkwo · 10 minutes + 5 seconds");
    expect(html).toContain("Ada Okonkwo has checked in");
    expect(html).toMatch(/data-testid="room-checkin-cta"[^>]*>Check in</);
    expect(html, "a time of day is never server-rendered (hydration)").not.toMatch(/at \d\d:\d\d/);
  });

  it("game over with a result: You won, Checkmate · 1–0, both links", () => {
    const html = paint(snap({ game: { ...GAME, over: true }, result: { outcome: "won", method: "checkmate", score: "1–0" } }));
    expect(screenOf(html)).toBe("over");
    expect(html).toContain("You won");
    expect(html).toContain("Checkmate · 1–0");
    expect(html).toContain('href="/shared/org/comp/div/fixtures/f1"');
    expect(html).toContain('href="/shared/org/comp/div"');
    expect(html, "no game actions once it is over").not.toContain('data-testid="room-resign"');
  });

  it("I2: a held board paints as it truly is — the clocks, the board, the held seam, no game actions, no \"your move\"; the board the server takes moves on says it is", () => {
    // The board itself is client-only (ssr:false); its movable flag is the
    // e2e's (match-room.spec.ts, the held board) and board-wrapper.test's.
    const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
    const held = paint(snap({ game: GAME, you, canAct: false }));
    expect(screenOf(held)).toBe("held");
    const order = ids(held).filter((i) => ["room-clock-opponent", "room-clock-you", "room-board", "room-seam-held", "room-controls", "room-resign"].includes(i));
    expect(order).toEqual(["room-clock-opponent", "room-clock-you", "room-board", "room-seam-held"]);
    expect(held, "no \"your move\" on a board nobody may move").not.toContain(en["externalPlay.room.yourMove" as keyof typeof en]);
    expect(held).toContain(en["externalPlay.room.state.held.title" as keyof typeof en]);
    // The pair: White to move, White's seat, the server takes it ⇒ movable.
    const live = paint(snap({ game: GAME, you, canAct: true }));
    expect(screenOf(live)).toBe("live");
    expect(live).toContain(en["externalPlay.room.yourMove" as keyof typeof en]);
  });

  it("I7: a double forfeit paints NO RESULT · Double forfeit · 0–0 — never \"Draw\" or ½–½", () => {
    const html = paint(snap({ game: { ...GAME, over: true }, result: { outcome: "no_result", method: "double_forfeit", score: "0–0" } }));
    expect(screenOf(html)).toBe("over");
    expect(html).toMatch(/data-outcome="no_result"/);
    expect(html).toContain(en["externalPlay.room.over.noResult" as keyof typeof en]);
    expect(html).toContain("Double forfeit · 0–0");
    expect(html).not.toContain(">Draw<");
    expect(html).not.toContain("½");
  });

  it("every state card paints for its snapshot (cards 1, 5, 6; states A and B, drawn 2026-10-12)", () => {
    const cases: [Partial<RoomSnapshot>, string, string][] = [
      [{ phase: "not_opened" }, "notOpened", "room-state-not-opened"],
      [{ creation: { state: "creating" } }, "creating", "room-state-creating"],
      [{ phase: "closed" }, "closed", "room-state-closed"],
      [{ frozen: "you", game: GAME }, "revoked", "room-revoked"],
      [{ onlineChessOff: true }, "offForClub", "room-off-for-club"],
    ];
    for (const [over, screen, id] of cases) {
      const html = paint(snap(over));
      expect(screenOf(html), screen).toBe(screen);
      expect(ids(html), screen).toContain(id);
    }
    expect(cases.length).toBe(5);
  });

  it("no untranslated key reaches the page, in any of the four locales, on any screen", () => {
    const states: Partial<RoomSnapshot>[] = [
      {},
      { game: GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } },
      { game: { ...GAME, over: true }, result: { outcome: "draw", method: "agreement", score: "½–½" } },
      { game: { ...GAME, over: true } },
      { game: { ...GAME, over: true }, result: { outcome: "no_result", method: "double_forfeit", score: "0–0" } },
      { phase: "not_opened" },
      { creation: { state: "busy", retryAt: new Date(T0 + 48_000).toISOString() } },
      { phase: "closed" },
      { frozen: "you", game: GAME },
      { onlineChessOff: true },
      { game: GAME, canAct: false },
    ];
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      for (const s of states) {
        const html = paint(snap(s), locale);
        expect(html, `${locale} ${JSON.stringify(s).slice(0, 60)}`).not.toMatch(/externalPlay\.room\.|onlineChess\.camera\.|settings\.account\.|method\./);
        checked += 1;
      }
    }
    // The pill's two answers, painted as the hook hands them over.
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      for (const presence of [true, false]) {
        const html = paintScreen(snap({ game: GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } }), presence, locale);
        expect(ids(html), `${locale} pill ${presence}`).toContain("room-presence-pill");
        expect(html, `${locale} pill ${presence}`).not.toMatch(/externalPlay\.room\.|onlineChess\.camera\.|settings\.account\.|method\./);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: locale × screen, + locale × pill").toBe(44 + 8);
    expect(paint(snap(), "nl"), "nl is not English").not.toContain("Your board is open");
  });
});

describe("I3/I4: the camera duty is the REQUIRED policy's; an unknown presence accuses nobody", () => {
  const notice = en["onlineChess.camera.playerNotice" as keyof typeof en];
  // The live screen with the player's own camera in a given state — the
  // banner reads the camera hook, which never runs in a first paint.
  function paintLive(s: RoomSnapshot, cameraStatus: "idle" | "joining" | "live" | "off" | "failed") {
    const state = initialRoomState(s, T0);
    const noop = async () => null;
    return renderToStaticMarkup(
      <DictProvider dict={en as unknown as Dict} locale="en">
        <Screen
          screen={{ kind: "live" }}
          state={state}
          room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
          camera={{ status: cameraStatus, stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} }}
          busy={false}
          tryAgain={() => {}}
          relinkHref="/x"
          locale="en"
          t={((k: string) => k) as never}
          plural={((k: string) => k) as never}
        />
      </DictProvider>,
    );
  }

  it("every policy: the notice (live and check-in) and the camera-off banner show for `required` only; the tile for any camera policy", () => {
    // Controller ruling (review I3): the notice and banner state a DUTY to
    // keep the camera on — under `optional` there is none, so neither shows.
    const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
    let checked = 0;
    for (const policy of CAMERA_POLICIES) {
      const duty = policy === "required";
      const live = paint(snap({ game: GAME, you, cameraPolicy: policy, opponentPresence: policy === "off" ? null : { participantId: "rtk-opp" } }));
      expect(live.includes(notice), `${policy}: live notice`).toBe(duty);
      expect(ids(live).includes("room-tile-strip"), `${policy}: tile strip`).toBe(policy !== "off");
      const checkin = paint(snap({ cameraPolicy: policy }));
      expect(screenOf(checkin)).toBe("checkin");
      expect(checkin.includes(notice), `${policy}: check-in notice`).toBe(duty);
      for (const status of ["off", "failed"] as const) {
        const html = paintLive(snap({ game: GAME, you, cameraPolicy: policy }), status);
        expect(ids(html).includes("room-camera-off"), `${policy}/${status}: banner`).toBe(duty);
      }
      // The pair for the banner: a camera that is up never shows it.
      expect(ids(paintLive(snap({ game: GAME, you, cameraPolicy: policy }), "live")).includes("room-camera-off")).toBe(false);
      checked += 1;
    }
    expect(checked, "anti-vacuity: policies").toBe(3);
  });

  it("presence: live ⇒ on camera, false ⇒ camera off, null (not joined, not settled, connection down) ⇒ NO pill at all; and a first paint has no pill, whatever the snapshot", () => {
    const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
    const cases: [boolean | null, string | null][] = [
      [true, "live"],
      [false, "off"],
      [null, null],
    ];
    const s = snap({ game: GAME, you, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    expect(ids(paint(s)), "first paint: the camera has not joined, so nothing is known").not.toContain("room-presence-pill");
    let checked = 0;
    for (const [live, state] of cases) {
      const html = paintScreen(s, live);
      const pill = /data-testid="room-presence-pill" data-state="([^"]+)"/.exec(html)?.[1] ?? null;
      expect(pill, String(live)).toBe(state);
      if (live === null) expect(html, "no accusation on an unknown answer").not.toContain("camera off");
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// T14 re-review 3, I-1 (controller ruling 2026-10-12): when OUR guard takes
// the camera out of the meeting and re-joins, the player is told so — one
// amber line, in their language — and never "your camera is off; your
// organiser sees when it was off".
describe("I-1: our guard re-joining is ours — the reconnecting notice, never the camera-off banner", () => {
  const RULED_EN = "Camera connection problem on our side — reconnecting…";
  const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
  function paintLiveIn(s: RoomSnapshot, cameraStatus: "live" | "off" | "recovering", locale: keyof typeof LOCALES) {
    const state = initialRoomState(s, T0);
    const noop = async () => null;
    const dict = LOCALES[locale] as unknown as Record<string, string>;
    return renderToStaticMarkup(
      <DictProvider dict={dict as unknown as Dict} locale={locale}>
        <Screen
          screen={{ kind: "live" }}
          state={state}
          room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
          camera={{ status: cameraStatus, stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} }}
          busy={false}
          tryAgain={() => {}}
          relinkHref="/x"
          locale={locale}
          t={((k: string) => dict[k] ?? k) as never}
          plural={((k: string) => k) as never}
        />
      </DictProvider>,
    );
  }

  it("the owner's words, exactly, in en; every locale has its own copy (not the key, not English)", () => {
    expect(en["externalPlay.room.state.cameraReconnecting" as keyof typeof en]).toBe(RULED_EN);
    for (const l of ["es", "fr", "nl"] as const) {
      const v = (LOCALES[l] as unknown as Record<string, string>)["externalPlay.room.state.cameraReconnecting"];
      expect(v, l).toBeTruthy();
      expect(v, `${l} is not English`).not.toBe(RULED_EN);
    }
  });

  it("recovering, under every policy with a camera: the notice in each locale and NO camera-off banner; the pair: off shows the banner and no notice (required)", () => {
    let checked = 0;
    for (const policy of ["optional", "required"] as const) {
      for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
        const s = snap({ game: GAME, you, cameraPolicy: policy, opponentPresence: { participantId: "rtk-opp" } });
        const html = paintLiveIn(s, "recovering", locale);
        const copy = (LOCALES[locale] as unknown as Record<string, string>)["externalPlay.room.state.cameraReconnecting"]!;
        expect(ids(html), `${policy}/${locale}`).toContain("room-camera-reconnecting");
        expect(html, `${policy}/${locale}: the copy`).toContain(copy.replace(/&/g, "&amp;"));
        expect(ids(html), `${policy}/${locale}: never blamed`).not.toContain("room-camera-off");
        expect(html.match(/data-testid="room-camera-reconnecting"/g), "a single notice").toHaveLength(1);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: policy × locale").toBe(8);
    const off = paintLiveIn(snap({ game: GAME, you, cameraPolicy: "required" }), "off", "en");
    expect(ids(off)).toContain("room-camera-off");
    expect(ids(off)).not.toContain("room-camera-reconnecting");
    const live = paintLiveIn(snap({ game: GAME, you, cameraPolicy: "required" }), "live", "en");
    expect(ids(live).filter((x) => x === "room-camera-off" || x === "room-camera-reconnecting")).toEqual([]);
  });

});

// T14 fix round 5, ruling 2: re-joining that keeps failing GIVES UP — one
// amber notice telling the player to reload, a Reload button, never the
// camera-off banner. On the check-in too: never the camera-required card.
describe("fix round 5: the give-up — reload, never blamed", () => {
  const RULED_EN = "We couldn't reconnect your camera. Reload the page — if it keeps happening, tell your organiser.";
  const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
  function paintIn(s: RoomSnapshot, kind: "live" | "checkin", cameraStatus: "gave_up" | "recovering" | "off", locale: keyof typeof LOCALES) {
    const state = initialRoomState(s, T0);
    const noop = async () => null;
    const dict = LOCALES[locale] as unknown as Record<string, string>;
    return renderToStaticMarkup(
      <DictProvider dict={dict as unknown as Dict} locale={locale}>
        <Screen
          screen={{ kind } as never}
          state={state}
          room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
          camera={{ status: cameraStatus, stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} }}
          busy={false}
          tryAgain={() => {}}
          relinkHref="/x"
          locale={locale}
          t={((k: string) => dict[k] ?? k) as never}
          plural={((k: string) => k) as never}
        />
      </DictProvider>,
    );
  }
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

  it("the ruled words, exactly, in en; every locale its own copy and its own Reload label", () => {
    expect(en["externalPlay.room.state.cameraGaveUp.body" as keyof typeof en]).toBe(RULED_EN);
    expect(en["externalPlay.room.state.cameraGaveUp.reload" as keyof typeof en]).toBe("Reload");
    for (const l of ["es", "fr", "nl"] as const) {
      const d = LOCALES[l] as unknown as Record<string, string>;
      expect(d["externalPlay.room.state.cameraGaveUp.body"], l).toBeTruthy();
      expect(d["externalPlay.room.state.cameraGaveUp.body"], `${l} is not English`).not.toBe(RULED_EN);
      expect(d["externalPlay.room.state.cameraGaveUp.reload"], l).toBeTruthy();
    }
  });

  it("gave_up, live AND on the check-in, under every policy with a camera, in every locale: the notice with its Reload — never the camera-off banner, never 'reconnecting'", () => {
    let checked = 0;
    for (const kind of ["live", "checkin"] as const) {
      for (const policy of ["optional", "required"] as const) {
        for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
          const s = snap({ ...(kind === "live" ? { game: GAME, you } : {}), cameraPolicy: policy, opponentPresence: { participantId: "rtk-opp" } });
          const html = paintIn(s, kind, "gave_up", locale);
          const d = LOCALES[locale] as unknown as Record<string, string>;
          const tag = `${kind}/${policy}/${locale}`;
          expect(ids(html), tag).toContain("room-camera-gave-up");
          expect(ids(html), `${tag}: the button`).toContain("room-camera-reload");
          expect(html, `${tag}: the copy`).toContain(esc(d["externalPlay.room.state.cameraGaveUp.body"]!));
          expect(html, `${tag}: the label`).toContain(esc(d["externalPlay.room.state.cameraGaveUp.reload"]!));
          expect(ids(html), `${tag}: never blamed`).not.toContain("room-camera-off");
          expect(ids(html), `${tag}: not still reconnecting`).not.toContain("room-camera-reconnecting");
          expect(html.match(/data-testid="room-camera-gave-up"/g), "a single notice").toHaveLength(1);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: screen × policy × locale").toBe(16);
    // The pairs: recovering is still the reconnecting line; off still the banner; off policy shows nothing.
    const live = snap({ game: GAME, you, cameraPolicy: "required" });
    expect(ids(paintIn(live, "live", "recovering", "en"))).not.toContain("room-camera-gave-up");
    expect(ids(paintIn(live, "live", "off", "en"))).toEqual(expect.arrayContaining(["room-camera-off"]));
    expect(ids(paintIn(live, "live", "off", "en"))).not.toContain("room-camera-gave-up");
    expect(ids(paintIn(snap({ game: GAME, you, cameraPolicy: "off" }), "live", "gave_up", "en"))).not.toContain("room-camera-gave-up");
  });

});
